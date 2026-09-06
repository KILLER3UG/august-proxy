"""Git operation API routes.

Resolves a session's workspacePath (or an explicit repoPath) and returns
structured JSON matching the desktop gitApi client:
  status / branch / branches / diff / checkout / commit.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException

from app.models.camel_base import CamelModel

router = APIRouter(prefix='/api/git')


class GitCommand(CamelModel):
    """Git CLI body. Internals are snake_case; JSON stays camelCase."""

    session_id: str = ''
    repo_path: str = ''
    args: list[str] = []


class CheckoutBody(CamelModel):
    session_id: str = ''
    repo_path: str = ''
    branch: str = ''
    create: bool = False
    # 'default' = plain checkout (returns dirty:true if blocked);
    # 'leave' = stash uncommitted changes on the current branch, then switch;
    # 'transfer' = stash, switch, pop — bring the changes to the target branch.
    strategy: str = 'default'


class CommitBody(CamelModel):
    session_id: str = ''
    repo_path: str = ''
    message: str = ''
    all: bool = False


class PushBody(CamelModel):
    session_id: str = ''
    repo_path: str = ''


def _resolve_workspace(session_id: str = '', repo_path: str = '') -> tuple[str | None, str | None]:
    """Return (workspace_path, error).

    Chat UI often has a filesystem path before (or without) a workbench
    session. Prefer any session-bound workspace, then fall back to repoPath
    so the branch chip still resolves for folder-bound chats.
    """
    sid = (session_id or '').strip()
    fallback = (repo_path or '').strip()
    path = ''

    if sid:
        from app.services.workbench.sessions import get_workbench_session

        wb = get_workbench_session(sid)
        if wb:
            path = str(getattr(wb, 'workspacePath', '') or '').strip()
        if not path:
            try:
                from app.services.memory_store import get_session

                rec = get_session(sid)
                if rec:
                    path = str(rec.get('workspacePath') or '').strip()
            except Exception:
                path = path or ''

    if not path:
        path = fallback
    if not path:
        return None, 'No repository path' if not sid else 'No workspace folder for this session'

    cwd = Path(path).expanduser()
    if not cwd.is_dir():
        return None, f'Not a directory: {path}'
    return str(cwd.resolve()), None


async def _run_git(repo_path: str, *args: str, check: bool = True) -> tuple[int, str, str]:
    """Run git; return (code, stdout, stderr). Raises only on missing git / timeout."""
    from app.lib.async_subprocess import SubprocessAborted, communicate_or_kill

    cwd = Path(repo_path).resolve()
    try:
        proc = await asyncio.create_subprocess_exec(
            'git',
            *args,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
        )
        stdout_b, stderr_b = await communicate_or_kill(proc, timeout=30)
    except SubprocessAborted:
        raise HTTPException(status_code=504, detail='Git command timed out') from None
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail='Git not found on system PATH') from None

    code = proc.returncode or 0
    stdout = stdout_b.decode('utf-8', errors='replace')
    stderr = stderr_b.decode('utf-8', errors='replace')
    if check and code != 0:
        raise HTTPException(status_code=400, detail=stderr.strip() or f'git {" ".join(args)} failed')
    return code, stdout, stderr


async def _ensure_repo(repo_path: str) -> str | None:
    """Return error string if path is not a git work tree."""
    code, _, stderr = await _run_git(repo_path, 'rev-parse', '--is-inside-work-tree', check=False)
    if code != 0:
        return stderr.strip() or 'Not a git repository'
    return None


def _parse_porcelain(output: str) -> list[dict[str, object]]:
    files: list[dict[str, object]] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        # porcelain v1: XY PATH or XY ORIG -> PATH
        status = line[:2].strip() if len(line) >= 2 else '?'
        rest = line[3:] if len(line) > 3 else line
        if ' -> ' in rest:
            rest = rest.split(' -> ', 1)[1]
        files.append({'path': rest.strip(), 'status': status or '?', 'added': 0, 'removed': 0})
    return files


# Untracked files larger than this are treated as binary/omitted.
UNTRACKED_MAX_BYTES = 1024 * 1024


def _attach_patches(files: list[dict[str, object]], combined: str) -> None:
    """Split a unified diff into per-file patch bodies and attach to files."""
    chunks = combined.split('diff --git ')
    for chunk in chunks[1:]:
        header_end = chunk.find('\n')
        header = chunk[:header_end] if header_end >= 0 else chunk
        # b/path
        path_token = ''
        if ' b/' in header:
            path_token = header.split(' b/', 1)[1].strip()
        elif header.startswith('b/'):
            path_token = header[2:].strip()
        body = 'diff --git ' + chunk
        for f in files:
            if f['path'] == path_token or str(f['path']).endswith(path_token):
                f['diff'] = body
                break


async def _attach_untracked_diff(repo_path: str, file: dict[str, object]) -> None:
    """Synthesize a diff for an untracked file (never present in `git diff`).

    Skips files >1MB or with NUL bytes in the first 8KB (treated as binary).
    For text files, runs `git diff --no-index -- /dev/null <path>`; Git for
    Windows translates `/dev/null` internally. Exit code 1 means differences
    were found (expected); codes >=2 are real errors.
    """
    rel = str(file['path'])
    full = Path(repo_path) / rel
    try:
        size = full.stat().st_size
    except OSError:
        file['diff'] = ''
        return
    if size > UNTRACKED_MAX_BYTES:
        file['diff'] = 'Binary file \u2014 diff omitted'
        file['added'] = 0
        return
    try:
        with open(full, 'rb') as fh:
            head = fh.read(8192)
    except OSError:
        file['diff'] = ''
        return
    if b'\0' in head:
        file['diff'] = 'Binary file \u2014 diff omitted'
        file['added'] = 0
        return
    code, out, _ = await _run_git(repo_path, 'diff', '--no-index', '--', '/dev/null', rel, check=False)
    if code >= 2:
        file['diff'] = ''
        return
    file['diff'] = out
    file['added'] = sum(1 for ln in out.splitlines() if ln.startswith('+') and not ln.startswith('+++'))


def _apply_numstat(files: list[dict[str, object]], numstat: str) -> tuple[int, int]:
    by_path = {str(f['path']): f for f in files}
    total_added = 0
    total_removed = 0
    for line in numstat.splitlines():
        parts = line.split('\t')
        if len(parts) < 3:
            continue
        a_raw, d_raw, path = parts[0], parts[1], parts[2]
        try:
            added = 0 if a_raw == '-' else int(a_raw)
            removed = 0 if d_raw == '-' else int(d_raw)
        except ValueError:
            continue
        total_added += added
        total_removed += removed
        if path in by_path:
            by_path[path]['added'] = added
            by_path[path]['removed'] = removed
        else:
            files.append({'path': path, 'status': 'M', 'added': added, 'removed': removed})
    return total_added, total_removed


@router.get('/status')
async def git_status(sessionId: str = '', repoPath: str = ''):
    path, err = _resolve_workspace(sessionId, repoPath)
    if err or not path:
        return {'workspace': None, 'added': 0, 'removed': 0, 'files': [], 'error': err or 'No path'}
    repo_err = await _ensure_repo(path)
    if repo_err:
        return {'workspace': path, 'added': 0, 'removed': 0, 'files': [], 'error': repo_err}

    _, porcelain, _ = await _run_git(path, 'status', '--porcelain', check=False)
    files = _parse_porcelain(porcelain)
    _, unstaged, _ = await _run_git(path, 'diff', '--numstat', check=False)
    _, staged, _ = await _run_git(path, 'diff', '--cached', '--numstat', check=False)
    added, removed = _apply_numstat(files, unstaged + staged)
    return {
        'workspace': path,
        'added': added,
        'removed': removed,
        'files': files,
    }


@router.get('/log')
async def git_log(sessionId: str = '', repoPath: str = '', count: int = 10):
    path, err = _resolve_workspace(sessionId, repoPath)
    if err or not path:
        raise HTTPException(status_code=400, detail=err or 'No path')
    output = (await _run_git(path, 'log', f'--max-count={count}', '--oneline'))[1]
    return {'log': output, 'workspace': path}


@router.get('/branch')
async def git_branch(sessionId: str = '', repoPath: str = ''):
    """Current branch for the session workspace.

    Detached HEAD (checked-out commit/tag) has no branch name — surface the
    short SHA with a `detached` flag so the chip shows *something* truthful
    instead of a blank '—'."""
    path, err = _resolve_workspace(sessionId, repoPath)
    if err or not path:
        return {'workspace': None, 'current': None, 'error': err or 'No path'}
    repo_err = await _ensure_repo(path)
    if repo_err:
        return {'workspace': path, 'current': None, 'error': repo_err}
    _, current, _ = await _run_git(path, 'branch', '--show-current', check=False)
    name = current.strip()
    if name:
        return {'workspace': path, 'current': name, 'detached': False}
    # Detached — fall back to the short commit SHA.
    _, sha, _ = await _run_git(path, 'rev-parse', '--short', 'HEAD', check=False)
    sha = sha.strip()
    if sha:
        return {'workspace': path, 'current': sha, 'detached': True}
    return {'workspace': path, 'current': None, 'detached': False}


_TRACK_RE = re.compile(r'\b(ahead|behind)\s+(\d+)')


def _parse_upstream_track(track: str) -> tuple[int, int]:
    """`%(upstream:track)` → (ahead, behind). '[ahead 1, behind 2]' → (1, 2);
    '[gone]' or empty → (0, 0)."""
    ahead = behind = 0
    for m in _TRACK_RE.finditer(track or ''):
        if m.group(1) == 'ahead':
            ahead = int(m.group(2))
        else:
            behind = int(m.group(2))
    return ahead, behind


@router.get('/branches')
async def git_branches(sessionId: str = '', repoPath: str = ''):
    """Local branch list with current flag + upstream sync state — used by
    the branch switcher. The current branch sorts to the top; a detached
    HEAD is reported via `detached` + `head` (short SHA) so the menu still
    tells the user where they are."""
    path, err = _resolve_workspace(sessionId, repoPath)
    if err or not path:
        return {'workspace': None, 'branches': [], 'error': err or 'No path'}
    repo_err = await _ensure_repo(path)
    if repo_err:
        return {'workspace': path, 'branches': [], 'error': repo_err}

    _, current_raw, _ = await _run_git(path, 'branch', '--show-current', check=False)
    current = current_raw.strip()
    detached = False
    head_sha = ''
    if not current:
        detached = True
        _, sha, _ = await _run_git(path, 'rev-parse', '--short', 'HEAD', check=False)
        head_sha = sha.strip()

    _, listed, _ = await _run_git(
        path,
        'for-each-ref',
        '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)',
        'refs/heads',
        check=False,
    )
    branches: list[dict[str, object]] = []
    for line in listed.splitlines():
        line = line.rstrip()
        if not line.strip():
            continue
        parts = line.split('\t')
        name = parts[0].strip()
        if not name:
            continue
        upstream = parts[1].strip() if len(parts) > 1 else ''
        track = parts[2] if len(parts) > 2 else ''
        ahead, behind = _parse_upstream_track(track)
        branches.append(
            {
                'name': name,
                'current': name == current,
                'upstream': upstream or None,
                'ahead': ahead,
                'behind': behind,
            }
        )
    # Current branch first, then alphabetical (case-insensitive).
    branches.sort(key=lambda b: (not b['current'], str(b['name']).lower()))
    result: dict[str, object] = {'workspace': path, 'branches': branches}
    if detached:
        result['detached'] = True
        result['head'] = head_sha
    return result


@router.get('/diff')
async def git_diff(sessionId: str = '', repoPath: str = '', target: str = 'HEAD'):
    path, err = _resolve_workspace(sessionId, repoPath)
    if err or not path:
        return {'workspace': None, 'added': 0, 'removed': 0, 'files': [], 'error': err or 'No path'}
    repo_err = await _ensure_repo(path)
    if repo_err:
        return {'workspace': path, 'added': 0, 'removed': 0, 'files': [], 'error': repo_err}

    _, porcelain, _ = await _run_git(path, 'status', '--porcelain', check=False)
    files = _parse_porcelain(porcelain)
    # numstat: unstaged and staged are disjoint sets, so summing is correct.
    _, unstaged_ns, _ = await _run_git(path, 'diff', '--numstat', check=False)
    _, staged_ns, _ = await _run_git(path, 'diff', '--cached', '--numstat', check=False)
    added, removed = _apply_numstat(files, unstaged_ns + staged_ns)

    # `git diff HEAD` already merges staged + unstaged tracked changes; the old
    # concatenation with `git diff --cached` overwrote combined-state entries.
    _, full_diff, _ = await _run_git(path, 'diff', target, check=False)
    for f in files:
        f['diff'] = ''
    if full_diff.strip():
        _attach_patches(files, full_diff)

    # Untracked files (`??`) never appear in `git diff`; synthesize per-file.
    for f in files:
        if str(f.get('status')) == '??' and not str(f.get('diff') or '').strip():
            await _attach_untracked_diff(path, f)

    return {
        'workspace': path,
        'added': added,
        'removed': removed,
        'files': files,
    }


# git's "you have uncommitted changes that block the switch" stderr shapes.
_DIRTY_CHECKOUT_RE = re.compile(
    r'would be overwritten by checkout|local changes to the following files'
    r'|would lose|Please commit your changes or stash them',
    re.IGNORECASE,
)


@router.post('/checkout')
async def git_checkout(body: CheckoutBody):
    """Switch branches. When uncommitted changes would block the switch, the
    default call returns ``dirty: true`` (HTTP 200) so the UI can offer the
    GitHub-style choice: leave the changes behind (stash) or bring them along
    (stash → checkout → pop). ``create`` / unknown-branch stay hard errors."""
    if not body.branch.strip():
        raise HTTPException(status_code=400, detail='branch is required')
    path, err = _resolve_workspace(body.session_id, body.repo_path)
    if err or not path:
        raise HTTPException(status_code=400, detail=err or 'No path')
    repo_err = await _ensure_repo(path)
    if repo_err:
        raise HTTPException(status_code=400, detail=repo_err)
    branch = body.branch.strip()

    if body.create:
        code, output, stderr = await _run_git(path, 'checkout', '-b', branch, check=False)
        if code != 0:
            raise HTTPException(
                status_code=400,
                detail=stderr.strip() or output.strip() or f'git checkout -b {branch} failed',
            )
        return {'workspace': path, 'sha': '', 'output': output.strip(), 'branch': branch, 'ok': True}

    strategy = (body.strategy or 'default').strip().lower()

    if strategy in ('leave', 'transfer'):
        _, cur_out, _ = await _run_git(path, 'rev-parse', '--abbrev-ref', 'HEAD', check=False)
        current = cur_out.strip() or 'HEAD'
        note = f'August: {"left on " + current if strategy == "leave" else "carried to " + branch}'
        sc, sout, serr = await _run_git(path, 'stash', 'push', '-u', '-m', note, check=False)
        stash_out = sout + serr
        if sc != 0 and 'No local changes' not in stash_out:
            raise HTTPException(status_code=400, detail=serr.strip() or 'git stash failed')
        stashed = 'No local changes' not in stash_out
        cc, cout, cerr = await _run_git(path, 'checkout', branch, check=False)
        if cc != 0:
            # Don't strand the user's work in a stash if the switch itself failed.
            if stashed:
                await _run_git(path, 'stash', 'pop', check=False)
            raise HTTPException(
                status_code=400,
                detail=cerr.strip() or cout.strip() or f'git checkout {branch} failed',
            )
        carried = False
        if strategy == 'transfer' and stashed:
            pc, _pout, perr = await _run_git(path, 'stash', 'pop', check=False)
            carried = pc == 0
            if pc != 0:
                return {
                    'workspace': path, 'sha': '', 'branch': branch, 'ok': True,
                    'stashed': True, 'carried': False,
                    'warning': (perr.strip() or 'stash pop conflicted')
                    + ' — your changes are still in the stash (git stash list).',
                }
        return {
            'workspace': path, 'sha': '', 'output': cout.strip(), 'branch': branch,
            'ok': True, 'stashed': stashed, 'carried': carried,
        }

    code, output, stderr = await _run_git(path, 'checkout', branch, check=False)
    if code == 0:
        return {'workspace': path, 'sha': '', 'output': output.strip(), 'branch': branch, 'ok': True}
    if _DIRTY_CHECKOUT_RE.search(stderr):
        _, porcelain, _ = await _run_git(path, 'status', '--porcelain', check=False)
        files = [str(f.get('path', '')) for f in _parse_porcelain(porcelain) if f.get('path')]
        return {
            'workspace': path, 'branch': branch, 'ok': False, 'dirty': True,
            'files': files, 'error': stderr.strip(),
        }
    raise HTTPException(status_code=400, detail=stderr.strip() or f'git checkout {branch} failed')


@router.post('/push')
async def git_push(body: PushBody):
    """Push the current branch to its upstream. Fails honestly (400 + stderr)
    when no upstream is configured — the UI surfaces that as a toast."""
    path, err = _resolve_workspace(body.session_id, body.repo_path)
    if err or not path:
        raise HTTPException(status_code=400, detail=err or 'No path')
    repo_err = await _ensure_repo(path)
    if repo_err:
        raise HTTPException(status_code=400, detail=repo_err)
    code, output, stderr = await _run_git(path, 'push', check=False)
    if code != 0:
        raise HTTPException(status_code=400, detail=stderr.strip() or output.strip() or 'git push failed')
    return {'workspace': path, 'output': output.strip() or stderr.strip()}


@router.post('/commit')
async def git_commit(body: CommitBody):
    if not body.message.strip():
        raise HTTPException(status_code=400, detail='message is required')
    path, err = _resolve_workspace(body.session_id, body.repo_path)
    if err or not path:
        raise HTTPException(status_code=400, detail=err or 'No path')
    repo_err = await _ensure_repo(path)
    if repo_err:
        raise HTTPException(status_code=400, detail=repo_err)
    if body.all:
        await _run_git(path, 'add', '-A')
    _, output, _ = await _run_git(path, 'commit', '-m', body.message.strip())
    _, sha, _ = await _run_git(path, 'rev-parse', 'HEAD', check=False)
    return {'workspace': path, 'sha': sha.strip(), 'output': output}


@router.post('/command')
async def git_command(body: GitCommand):
    """Execute an arbitrary git command."""
    if not body.args:
        raise HTTPException(status_code=400, detail='No git args provided')
    path, err = _resolve_workspace(body.session_id, body.repo_path)
    if err or not path:
        raise HTTPException(status_code=400, detail=err or 'No path')
    _, output, _ = await _run_git(path, *body.args)
    return {'output': output, 'workspace': path}
