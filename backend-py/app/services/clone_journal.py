"""Obligation journal: byte-exact undo for every write into the self-edit clone.

Stage 2 of the self-edit loop. Designed from first principles; the contract
it implements is the one the Stage-2 spec states:

1. **Arm before touching.** Before any write lands under the clone root, a
   marker is armed that records the PRE-EDIT bytes of every path in the
   change. Arming happens to the journal directory (under the data dir,
   outside the clone), never to the tree being edited.
2. **Temp + fsync + rename, never in place.** The edit itself is written to
   a temporary file in the target's own directory, flushed and fsynced, then
   ``os.replace``d over the target — a crash mid-write can never leave a
   half-written source file behind.
3. **Added files are tracked.** A path that did not exist before the edit is
   recorded as *added*; recovery deletes it instead of restoring bytes.
4. **Restore from recorded bytes, never from the working tree.** A marker
   that was never committed is restored at boot from the journal's own
   copies; if a restore fails (locked file, hash mismatch) the marker stays
   and the retry happens on the next boot. Committed markers are history.

Marker lifecycle::

    armed → applied → committed      (the edit verified healthy; prunable)
    armed ─┐
    applied ─┴→ restored / restore-failed   (boot sweep of uncommitted)

*Committed* is the moment someone downstream says "this edit is wanted" —
Stage 5's restart flow commits after a healthy boot with the edit applied.
Until something commits, the journal assumes the edit must undo.

Why shadow_git is NOT reused (the spec asks the question): shadow_git
(`workbench/shadow_git.py`) snapshots a per-session WORKSPACE through a
separate git dir and restores with `git checkout` — commit-granularity
snapshots taken at mutating-tool ROUNDS, not pre-edit bytes captured at
WRITE time, and its revert/unrevert paths have no live callers. The journal
needs byte-exact pre-edit copies keyed to the clone root regardless of
session, restorable when git itself may be broken. Different substrate,
different granularity, different lifetime — the journal owns byte restore;
shadow_git stays available as the coarse human-facing diff substrate for
Stage 5.

Boot sweep: :func:`restore_pending` runs in the backend lifespan today and
moves to the out-of-tree launcher in Stage 3 (an edit that breaks the Python
import path cannot run in-tree recovery — that is Stage 3's whole point).
The sweep is deliberately dependency-free (stdlib only) so the move is a
cut-and-paste, not a rewrite.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
import uuid
from pathlib import Path

from app.services.clone_guard import clone_root, is_clone_path

logger = logging.getLogger(__name__)

_MANIFEST_NAME = 'manifest.json'
_FILES_SUBDIR = 'files'

# States a marker can be in; only the first two are undone by the sweep.
_UNDONE_STATES = frozenset({'armed', 'applied'})


def journal_root() -> Path:
    """<dataDir>/clone_journal — outside the clone, inside August's own state.

    hardline lists ``clone_journal`` among August's own state dirs, so a
    model cannot forge or edit markers through the file tools; the sanctioned
    writer is this module, which is the point.
    """
    from app.config import settings

    return Path(settings.dataDir) / 'clone_journal'


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_atomic(path: Path, data: bytes) -> None:
    """Temp file in the target's directory, fsync, rename. Never in place."""
    tmp = path.with_name(f'{path.name}.journal-{os.getpid()}-{uuid.uuid4().hex[:8]}.tmp')
    # O_BINARY is load-bearing on Windows: the CRT's os.open defaults to text
    # mode, which translates every \n to \r\n on write — a source file edited
    # through the journal would silently change its line endings and the
    # post-write hash check would (correctly) refuse it. Python's open()
    # adds O_BINARY itself; raw os.open does not.
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_BINARY', 0)
    fd = os.open(str(tmp), flags, 0o644)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(str(tmp), str(path))
    # Best-effort directory fsync so the rename itself is durable. Windows
    # has no POSIX directory fsync; failure here costs durability, never
    # correctness (the rename already happened atomically).
    try:
        dir_fd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError:
        pass


def arm(paths: list[str | Path], purpose: str) -> str | None:
    """Record pre-edit bytes for every path in one change. Marker id, or None.

    ``None`` means the journal could not durably record the pre-state — the
    caller MUST refuse the edit (fail closed): an obligation journal that
    sometimes skips arming is not a journal.
    """
    root = clone_root()
    if root is None:
        return None
    # time_ns makes ids sort chronologically (a boot sweep and any listing
    # must not depend on same-second uuid luck); the uuid suffix keeps
    # uniqueness under a clock that repeats.
    marker_id = f'{time.time_ns():020d}-{uuid.uuid4().hex[:8]}'
    marker_dir = journal_root() / marker_id
    files_dir = marker_dir / _FILES_SUBDIR
    entries: list[dict[str, object]] = []
    try:
        files_dir.mkdir(parents=True, exist_ok=True)
        for i, raw in enumerate(paths):
            path = Path(raw)
            existed = path.exists()
            before_sha = ''
            stored: str | None = None
            if existed:
                data = path.read_bytes()
                before_sha = _sha256(data)
                stored = f'{i:03d}.bin'
                (files_dir / stored).write_bytes(data)
            entries.append(
                {
                    'path': str(path),
                    'existed': existed,
                    'sha256_before': before_sha,
                    'stored': stored,
                }
            )
        manifest = {
            'id': marker_id,
            'created_at': time.time(),
            'purpose': purpose,
            'state': 'armed',
            'entries': entries,
        }
        _write_atomic(marker_dir / _MANIFEST_NAME, json.dumps(manifest, indent=2).encode('utf-8'))
    except OSError as exc:
        logger.error('clone_journal: arming failed for %s: %s', paths, exc)
        return None
    return marker_id


def journal_write_bytes(path: str | Path, data: bytes, purpose: str = 'clone edit') -> str | None:
    """Write ``data`` to a clone path under the journal. None on success.

    Only clone paths belong here (callers check :func:`clone_guard.is_clone_path`
    and use their normal writer otherwise). Any failure returns an error
    string and leaves the tree as it was found: the marker is restored from
    immediately, in-line, so a failed journal write never half-edits source.
    """
    if not is_clone_path(path):
        return None
    target = Path(path)
    marker_id = arm([target], purpose)
    if marker_id is None:
        return 'Error: the clone journal could not arm a marker — the edit was refused (fail-closed).'
    marker_dir = journal_root() / marker_id
    try:
        _write_atomic(target, data)
    except OSError as exc:
        _restore_marker(marker_dir, reason=f'write failed: {exc}')
        return f'Error: clone write failed and was rolled back from the journal: {exc}'
    applied = _sha256(target.read_bytes()) if target.exists() else ''
    if applied != _sha256(data):
        _restore_marker(marker_dir, reason='post-write hash mismatch')
        return 'Error: the clone write did not land byte-identical and was rolled back.'
    _set_state(marker_dir, 'applied', applied_sha256=applied)
    return None


def _read_manifest(marker_dir: Path) -> dict | None:
    try:
        return json.loads((marker_dir / _MANIFEST_NAME).read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None


def _set_state(marker_dir: Path, state: str, **extra: object) -> None:
    manifest = _read_manifest(marker_dir)
    if manifest is None:
        return
    manifest['state'] = state
    manifest.update(extra)
    _write_atomic(marker_dir / _MANIFEST_NAME, json.dumps(manifest, indent=2).encode('utf-8'))


def commit(marker_id: str) -> None:
    """Mark an applied marker as wanted — the boot sweep stops undoing it.

    A committed edit that sits ON TOP of an uncommitted edit of the same file
    would be silently destroyed by the sweep restoring the earlier marker, so
    commit promotes every earlier uncommitted marker that shares a path. IDs
    are time-ordered, so ``name < marker_id`` is exactly "earlier".
    """
    marker_dir = journal_root() / marker_id
    manifest = _read_manifest(marker_dir)
    if manifest is None:
        return
    paths = {str(e.get('path') or '') for e in manifest.get('entries', [])}
    _set_state(marker_dir, 'committed')
    root = journal_root()
    for other_dir in sorted(root.iterdir()):
        if not other_dir.is_dir() or other_dir.name >= marker_id:
            continue
        other = _read_manifest(other_dir)
        if not other or str(other.get('state') or 'armed') not in _UNDONE_STATES:
            continue
        other_paths = {str(e.get('path') or '') for e in other.get('entries', [])}
        if other_paths & paths:
            _set_state(other_dir, 'committed')


def _restore_marker(marker_dir: Path, reason: str = '') -> bool:
    """Undo one marker's entries from recorded bytes. True when fully undone."""
    manifest = _read_manifest(marker_dir)
    if manifest is None:
        return False
    files_dir = marker_dir / _FILES_SUBDIR
    ok = True
    for entry in manifest.get('entries', []):
        path = Path(str(entry.get('path') or ''))
        try:
            if not entry.get('existed'):
                # The edit ADDED this file: recovery deletes it.
                if path.exists():
                    path.unlink()
                continue
            stored = files_dir / str(entry.get('stored') or '')
            if not stored.exists():
                ok = False
                continue
            data = stored.read_bytes()
            if entry.get('sha256_before') and _sha256(data) != entry['sha256_before']:
                ok = False
                continue
            _write_atomic(path, data)
        except OSError:
            ok = False
    if ok:
        _set_state(marker_dir, 'restored', restored_at=time.time(), restore_reason=reason)
        logger.info('clone_journal: marker %s restored (%s)', manifest.get('id'), reason)
    else:
        _set_state(marker_dir, 'restore-failed', restore_reason=reason)
        logger.warning(
            'clone_journal: marker %s could not be fully restored (%s) — kept for the next boot',
            manifest.get('id'),
            reason,
        )
    return ok


def restore_pending() -> dict[str, int]:
    """Boot sweep: undo every uncommitted marker, from recorded bytes only.

    Returns counts; a marker that cannot be restored now stays on disk in
    ``restore-failed`` and is retried on the next boot — the obligation does
    not expire because one attempt hit a locked file.
    """
    counts = {'restored': 0, 'failed': 0, 'committed': 0}
    root = journal_root()
    if not root.is_dir():
        return counts
    for marker_dir in sorted(root.iterdir()):
        if not marker_dir.is_dir():
            continue
        manifest = _read_manifest(marker_dir)
        if manifest is None:
            continue
        state = str(manifest.get('state') or 'armed')
        if state == 'committed':
            counts['committed'] += 1
            continue
        if state not in _UNDONE_STATES and state != 'restore-failed':
            continue
        if _restore_marker(marker_dir, reason='boot sweep of an uncommitted edit'):
            counts['restored'] += 1
        else:
            counts['failed'] += 1
    return counts
