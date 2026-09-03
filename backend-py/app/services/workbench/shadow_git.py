"""§9.3 #7: shadow-git snapshots (plan Part 9, Set A).

A separate git directory per session commits the workspace at each step —
the rollback substrate for long runs and the diff source for the
ChangesCard. Key properties:

- **Separate git dir** (``<data>/shadow-git/<session>``): the workspace's
  own ``.git`` is never touched; when the workspace IS a git repo the
  shadow's ``objects/info/alternates`` points at the repo's object store so
  big repos are not re-hashed into a second object database.
- **Per-step commits**: the workbench loop commits after any round that ran
  a mutating tool (best-effort — a snapshot failure never breaks the turn).
- **Per-message diffs**: ``diff_between`` / ``diff_last`` render the change
  between snapshots.
- **Revert / unrevert**: reverting first snapshots the current state under a
  ``pre-revert`` marker, so ``unrevert`` can restore exactly what was there.

Git is invoked with explicit ``--git-dir``/``--work-tree`` and inline
identity config so no user gitconfig (signing, hooks, aliases) interferes.
"""

from __future__ import annotations

import logging
import re
import subprocess
import threading
from pathlib import Path

from app.json_narrowing import as_str

logger = logging.getLogger(__name__)

_GIT_TIMEOUT_S = 60.0
PRE_REVERT_MARKER = '[pre-revert] '

# Latency fix (2026-09-02): the turn-start baseline snapshot now runs on a
# WORKER THREAD while the turn's step snapshots run on the loop — two git
# processes on the same shadow dir race on index.lock and one silently
# fails. A process-wide per-repo mutex serializes every snapshot regardless
# of the thread it starts on. (Cross-process safety is unchanged: only this
# backend owns the shadow dir.)
_REPO_LOCKS: dict[str, threading.Lock] = {}
_REPO_LOCKS_GUARD = threading.Lock()


def _repo_lock(git_dir: Path) -> threading.Lock:
    key = str(git_dir).lower()
    with _REPO_LOCKS_GUARD:
        lock = _REPO_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _REPO_LOCKS[key] = lock
        return lock

# Heavy/derived dirs never worth snapshotting (written to info/exclude).
_EXCLUDES = (
    'node_modules/',
    '.venv/',
    'venv/',
    '__pycache__/',
    '*.pyc',
    'dist/',
    'build/',
    'target/',
    'web-dist/',
    # Part 17: the whole .aug workspace state dir — spill (transient) AND
    # memory (the user's own .gitignore decides whether project memory is
    # committed to THEIR repo; August's shadow repo never carries it).
    '.aug/',
    '.pytest_cache/',
    '.mypy_cache/',
    '.ruff_cache/',
    # EDA derived binaries (plan §5.7): tool-regeneratable outputs, not
    # user-authored work. Random bitstream/model bytes don't zlib-compress,
    # so each compile iteration costs its full size in the object store.
    '*.sof',
    '*.pof',
    '*.glb',
    '*.hex',
    # Brain SQLite files (P3.2 warm-kernel testing exposed this): when the
    # data dir lives inside the workspace (AUGUST_DATA_DIR override, or a
    # user pointing the workspace at the data root), `git add -A` would
    # try to index the live WAL database — the -shm file is locked by the
    # open connection, so the add fails with "Permission denied" and the
    # whole turn snapshot silently dies. Databases are never snapshot meat.
    'test_brain.sqlite',
    'test_brain.sqlite-*',
    'august_brain.sqlite',
    'august_brain.sqlite-*',
)


def _data_root() -> Path:
    from app.lib.paths import dataPath

    return dataPath('shadow-git')


def shadow_dir(session_id: str) -> Path:
    safe = re.sub(r'[^A-Za-z0-9_.-]', '_', session_id) or 'session'
    return _data_root() / safe


def _git(git_dir: Path, workspace: Path, *args: str, timeout: float = _GIT_TIMEOUT_S) -> subprocess.CompletedProcess[str]:
    cmd = [
        'git',
        f'--git-dir={git_dir}',
        f'--work-tree={workspace}',
        '-c', 'user.name=august-shadow',
        '-c', 'user.email=august@localhost',
        '-c', 'commit.gpgsign=false',
        '-c', 'core.hooksPath=',
        *args,
    ]
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=str(workspace),
        errors='replace',
    )


def init_shadow(session_id: str, workspace: str) -> Path | None:
    """Create (idempotently) the shadow git dir for a session workspace."""
    ws = Path(workspace)
    if not workspace or not ws.is_dir():
        return None
    git_dir = shadow_dir(session_id)
    try:
        if not (git_dir / 'HEAD').exists():
            git_dir.mkdir(parents=True, exist_ok=True)
            r = _git(git_dir, ws, 'init', '--quiet')
            if r.returncode != 0:
                logger.debug('shadow-git init failed: %s', r.stderr.strip())
                return None
            exclude = git_dir / 'info' / 'exclude'
            exclude.parent.mkdir(parents=True, exist_ok=True)
            exclude.write_text('\n'.join(_EXCLUDES) + '\n', encoding='utf-8')
            # Alternates: borrow the workspace repo's object store so big
            # repos are not re-hashed (cheap snapshots on huge histories).
            repoObjects = ws / '.git' / 'objects'
            if repoObjects.is_dir():
                altDir = git_dir / 'objects' / 'info'
                altDir.mkdir(parents=True, exist_ok=True)
                try:
                    altDir.joinpath('alternates').write_text(
                        str(repoObjects.resolve()) + '\n', encoding='utf-8'
                    )
                except OSError:
                    logger.debug('shadow-git alternates write failed', exc_info=True)
        return git_dir
    except (OSError, subprocess.SubprocessError):
        logger.debug('shadow-git init failed', exc_info=True)
        return None


def commit_snapshot(session_id: str, workspace: str, message: str) -> str | None:
    """Commit the current workspace state; returns the sha ('' → None when
    there is nothing new to snapshot).

    Takes the per-repo mutex for the WHOLE snapshot: with the baseline now
    running on a worker thread, a concurrent step snapshot on the loop must
    wait, not race on git's index.lock.
    """
    git_dir = init_shadow(session_id, workspace)
    if git_dir is None:
        return None
    ws = Path(workspace)
    lock = _repo_lock(git_dir)
    if not lock.acquire(timeout=_GIT_TIMEOUT_S):
        logger.debug('shadow-git lock busy; skipping snapshot')
        return None
    try:
        add = _git(git_dir, ws, 'add', '-A', '--', '.')
        if add.returncode != 0:
            logger.debug('shadow-git add failed: %s', add.stderr.strip())
            return None
        status = _git(git_dir, ws, 'status', '--porcelain')
        if status.returncode == 0 and not status.stdout.strip():
            return None  # nothing changed since the last snapshot
        commit = _git(git_dir, ws, 'commit', '--quiet', '--allow-empty-message', '-m', message)
        if commit.returncode != 0:
            logger.debug('shadow-git commit failed: %s', commit.stderr.strip())
            return None
        rev = _git(git_dir, ws, 'rev-parse', 'HEAD')
        return rev.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        logger.debug('shadow-git snapshot failed', exc_info=True)
        return None
    finally:
        lock.release()


def list_snapshots(session_id: str, workspace: str, limit: int = 50) -> list[dict[str, str]]:
    """Newest-first list of snapshots: [{sha, message, date}]."""
    git_dir = shadow_dir(session_id)
    if not (git_dir / 'HEAD').exists():
        return []
    ws = Path(workspace) if workspace else Path.cwd()
    try:
        log = _git(
            git_dir,
            ws,
            'log',
            f'--max-count={max(1, limit)}',
            '--pretty=format:%H%x00%s%x00%aI',
        )
        if log.returncode != 0:
            return []
        out: list[dict[str, str]] = []
        for line in log.stdout.splitlines():
            parts = line.split('\x00')
            if len(parts) == 3:
                out.append({'sha': parts[0], 'message': parts[1], 'date': parts[2]})
        return out
    except (OSError, subprocess.SubprocessError):
        return []


def diff_between(session_id: str, workspace: str, sha_a: str, sha_b: str) -> str:
    """Unified diff between two snapshots ('' on failure/empty)."""
    git_dir = shadow_dir(session_id)
    if not (git_dir / 'HEAD').exists():
        return ''
    ws = Path(workspace) if workspace else Path.cwd()
    try:
        r = _git(git_dir, ws, 'diff', '--no-color', sha_a, sha_b, timeout=_GIT_TIMEOUT_S)
        return r.stdout if r.returncode == 0 else ''
    except (OSError, subprocess.SubprocessError):
        return ''


def diff_last(session_id: str, workspace: str) -> str:
    """Diff introduced by the newest snapshot (vs its parent)."""
    snaps = list_snapshots(session_id, workspace, limit=2)
    if len(snaps) < 2:
        return ''
    return diff_between(session_id, workspace, snaps[1]['sha'], snaps[0]['sha'])


def head_sha(session_id: str, workspace: str) -> str | None:
    git_dir = shadow_dir(session_id)
    if not (git_dir / 'HEAD').exists():
        return None
    ws = Path(workspace) if workspace else Path.cwd()
    try:
        r = _git(git_dir, ws, 'rev-parse', '--verify', '--quiet', 'HEAD')
        return r.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def _commit_marker(session_id: str, workspace: str, message: str) -> str | None:
    """Allow-empty marker commit (tree unchanged) — used for pre-revert
    points, where the state is usually already snapshotted and a normal
    commit would be a no-op."""
    git_dir = init_shadow(session_id, workspace)
    if git_dir is None:
        return None
    ws = Path(workspace)
    try:
        r = _git(git_dir, ws, 'commit', '--quiet', '--allow-empty', '-m', message)
        if r.returncode != 0:
            return None
        rev = _git(git_dir, ws, 'rev-parse', 'HEAD')
        return rev.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def revert_to(session_id: str, workspace: str, sha: str) -> dict[str, object]:
    """Restore the workspace to a snapshot.

    First commits the current state under a ``[pre-revert]`` marker so
    ``unrevert`` can bring it back. Returns {ok, sha, preRevertSha, error}.
    """
    git_dir = init_shadow(session_id, workspace)
    if git_dir is None:
        return {'ok': False, 'error': 'shadow git unavailable'}
    ws = Path(workspace)
    try:
        target = _git(git_dir, ws, 'rev-parse', '--verify', '--quiet', f'{sha}^{{commit}}')
        if target.returncode != 0:
            return {'ok': False, 'error': f'unknown snapshot {sha[:12]}'}
        targetSha = target.stdout.strip()
        # Marker (allow-empty) commit: the pre-revert tree is usually already
        # the latest snapshot, so a normal commit would no-op and leave no
        # recoverable pre-revert sha.
        preRevertSha = _commit_marker(
            session_id, workspace, f'{PRE_REVERT_MARKER}state before revert'
        )
        # read-tree --reset -u resets index AND working tree to the target,
        # deleting files the target does not have (checkout <sha> -- . would
        # leave them tracked); clean then removes never-snapshotted strays.
        restore = _git(git_dir, ws, 'read-tree', '--reset', '-u', targetSha)
        if restore.returncode != 0:
            return {'ok': False, 'error': restore.stderr.strip() or 'read-tree failed'}
        _git(git_dir, ws, 'clean', '--quiet', '-fd')
        newSha = commit_snapshot(session_id, workspace, f'revert to {targetSha[:12]}')
        return {
            'ok': True,
            'sha': newSha or targetSha,
            'preRevertSha': preRevertSha or '',
            'targetSha': targetSha,
        }
    except (OSError, subprocess.SubprocessError) as exc:
        return {'ok': False, 'error': str(exc)}


def unrevert(session_id: str, workspace: str) -> dict[str, object]:
    """Undo the latest revert by restoring the newest ``[pre-revert]`` snapshot."""
    snaps = list_snapshots(session_id, workspace, limit=50)
    target = next((s for s in snaps if as_str(s.get('message')).startswith(PRE_REVERT_MARKER)), None)
    if target is None:
        return {'ok': False, 'error': 'nothing to unrevert (no pre-revert snapshot found)'}
    git_dir = shadow_dir(session_id)
    ws = Path(workspace)
    try:
        restore = _git(git_dir, ws, 'read-tree', '--reset', '-u', target['sha'])
        if restore.returncode != 0:
            return {'ok': False, 'error': restore.stderr.strip() or 'read-tree failed'}
        _git(git_dir, ws, 'clean', '--quiet', '-fd')
        newSha = commit_snapshot(session_id, workspace, f"unrevert to {target['sha'][:12]}")
        return {'ok': True, 'sha': newSha or target['sha'], 'restoredSha': target['sha']}
    except (OSError, subprocess.SubprocessError) as exc:
        return {'ok': False, 'error': str(exc)}
