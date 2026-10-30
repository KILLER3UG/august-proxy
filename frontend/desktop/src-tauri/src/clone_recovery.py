"""Standalone clone-journal recovery — runs OUTSIDE the editable tree.

Stage 3 of the self-edit loop. The Rust shell embeds this file via
``include_str!`` and pipes it to ``python -I -S -`` on **stdin** BEFORE
spawning the Python backend. An edit that broke the backend's import path
therefore cannot take the recovery path down with it: this script imports
nothing but the stdlib, never touches the app package, and is compiled into
the shell binary — the model's hot edits cannot change its behavior until the
shell itself is rebuilt, which is a human act.

It is piped on stdin rather than written to a file because the file would have
to land somewhere the process can reach, and a workspace-less session is
allowed to write into the system temp dir (``sandbox/paths.py``): a staged
script is a file the model can pre-create, hold open or mark read-only, and a
failed staging used to mean "no recovery, silently". stdin leaves no artifact
to race with.

Contract: ``python -I -S - <dataDir> <cloneRoot> [commit]``
  * ``argv[1]`` — the data directory holding ``clone_journal/``.
  * ``argv[2]`` — the CLONE ROOT. The shell owns this value; it is the only
    thing that decides where a restore may write or delete. Empty, unreadable
    or not a directory ⇒ nothing is restored and every pending marker is
    reported ``refused``. Fail closed: recovery that cannot bound its own
    blast radius is an arbitrary write/delete primitive.
  * ``argv[3]`` — ``commit`` marks APPLIED markers permanent, called by the
    shell only after the gated restart came back healthy. ``armed`` markers (an
    edit that never finished writing) are deliberately NOT committed even then.

It mirrors the marker contract of ``backend-py/app/services/clone_journal.py``
— keep the two in sync (same manifest layout, same states, same restore
semantics, same containment rule). The journal directory is
``<dataDir>/clone_journal/<id>/`` with ``manifest.json``
(``entries[].{path,existed,sha256_before,stored}``) and ``files/NNN.bin``
holding the pre-edit bytes. Uncommitted markers (``armed`` / ``applied`` /
``restore-failed``) are undone from recorded bytes — never from the working
tree; added files are deleted; committed markers are history; a failed restore
keeps the marker for the next boot.

Markers are undone **newest first**: each holds the bytes that preceded *its*
own edit, so replaying them oldest-first would leave the file at "before the
last edit" and every earlier edit still live.

Exit code is always 0 (recovery is best-effort; boot must proceed) — the JSON
summary on stdout carries what happened, including ``unresolved`` and
``refused``, and the shell logs it.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
import time
from pathlib import Path

UNDONE_STATES = frozenset({'armed', 'applied'})


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _fsync_dir(path: Path) -> None:
    # POSIX only: the durability of a rename lives in the parent directory, and
    # an open dir handle is the only way to flush it. Windows cannot open a
    # directory for this and does not need the dance (MoveFileEx is the atomic
    # primitive), which is why the in-tree journal fsyncs and this one may not.
    if os.name != 'posix':
        return
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _write_atomic(path: Path, data: bytes) -> None:
    # O_BINARY is load-bearing on Windows: raw os.open defaults to CRT text
    # mode and would translate line endings (see clone_journal._write_atomic).
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_BINARY', 0)
    tmp = path.with_name(f'{path.name}.recovery-{os.getpid()}.tmp')
    fd = os.open(str(tmp), flags, 0o644)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(str(tmp), str(path))
    _fsync_dir(path.parent)


def _is_reparse(path: Path) -> bool:
    """True for a symlink (POSIX) or a junction/reparse point (Windows)."""
    try:
        info = os.lstat(str(path))
    except OSError:
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    flag = getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0)
    return bool(flag and getattr(info, 'st_file_attributes', 0) & flag)


def _contained_join(root: Path, raw: str) -> Path | None:
    """``root`` + entry path, or None when the entry is not safely inside it.

    Lexical walk first (``..`` and a second drive never reach the disk), then
    one ``lstat`` per step so a link or junction anywhere on the way out is
    refused — ``O_TRUNC`` writes through a junction and ``unlink`` follows one
    too, so checking only the final component is not containment.
    """
    raw = str(raw or '').strip()
    if not raw:
        return None
    try:
        candidate = Path(raw)
        if not candidate.is_absolute():
            candidate = root / candidate
        rel = os.path.relpath(str(candidate), str(root))
    except (OSError, ValueError, RuntimeError):
        return None
    if os.path.isabs(rel) or rel == os.pardir or rel.startswith(os.pardir + os.sep):
        return None
    cursor = root
    for part in rel.split(os.sep):
        if part in ('', '.'):
            continue
        cursor = cursor / part
        if _is_reparse(cursor):
            return None
    return cursor


def _open_root(raw: str) -> Path | None:
    """The clone root the shell told us about, or None when it is unusable."""
    text = str(raw or '').strip()
    if not text:
        return None
    root = Path(text)
    try:
        if not root.is_dir():
            return None
    except OSError:
        return None
    return root


def _entry_targets(manifest: dict, root: Path) -> list[tuple[dict, Path | None]]:
    """(entry, safe target) pairs — target None means the entry must not be touched."""
    pairs = []
    for entry in manifest.get('entries', []):
        pairs.append((entry, _contained_join(root, str(entry.get('path') or ''))))
    return pairs


def _restore_marker(marker_dir: Path, root: Path) -> str:
    """Undo one marker from recorded bytes: 'restored', 'failed' or 'refused'."""
    try:
        manifest = json.loads((marker_dir / 'manifest.json').read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        # The journal itself is damaged, which is a different fact from "the
        # bytes would not land" — report it as unresolved so the operator is
        # not told a restore was attempted.
        return 'unresolved'
    state = str(manifest.get('state') or 'armed')
    if state == 'committed':
        return 'committed'
    if state == 'restored':
        # A finished obligation, not an unknown one: counting it as unresolved
        # would report a problem on every boot for work already done.
        return 'done'
    if state not in UNDONE_STATES and state != 'restore-failed':
        return 'unresolved'
    files_dir = marker_dir / 'files'
    ok = True
    refused = False
    for entry, path in _entry_targets(manifest, root):
        try:
            if path is None:
                # An entry outside the clone — or reachable only through a
                # link. Restoring it would be an arbitrary write (existed) or
                # an arbitrary delete (added), performed by the one component
                # the model cannot edit. Refuse, keep the marker, say so.
                refused = True
                ok = False
                continue
            if not entry.get('existed'):
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
    manifest['state'] = ('restore-failed' if not ok else 'restored')
    manifest['restored_at'] = time.time()
    manifest['restored_by'] = 'shell'
    if refused:
        manifest['restore_reason'] = 'unsafe-entry: outside the clone root, or reached through a link'
    try:
        _write_atomic(marker_dir / 'manifest.json', json.dumps(manifest, indent=2).encode('utf-8'))
    except OSError:
        ok = False
    if refused:
        return 'refused'
    return 'restored' if ok else 'failed'


def _markers(journal: Path) -> list[Path]:
    """Marker directories, newest id first — ids are zero-padded ``time_ns``."""
    try:
        entries = sorted(journal.iterdir(), reverse=True)
    except OSError:
        return []
    return [p for p in entries if p.is_dir()]


def _commit_applied(journal: Path, root: Path | None) -> dict[str, int]:
    """Promote every safely-applied marker to history. ``armed`` markers never are."""
    counts = {'committed': 0, 'refused': 0, 'unresolved': 0, 'failed': 0}
    for marker_dir in _markers(journal):
        manifest_path = marker_dir / 'manifest.json'
        try:
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            counts['unresolved'] += 1
            continue
        if str(manifest.get('state') or 'armed') != 'applied':
            continue
        # A marker with an unsafe entry is never promoted: committing it would
        # make the un-restorable state permanent and stop the boot sweep from
        # ever trying again.
        if root is None or any(path is None for _, path in _entry_targets(manifest, root)):
            counts['refused'] += 1
            continue
        manifest['state'] = 'committed'
        manifest['committed_at'] = time.time()
        manifest['committed_by'] = 'shell'
        try:
            _write_atomic(manifest_path, json.dumps(manifest, indent=2).encode('utf-8'))
            counts['committed'] += 1
        except OSError:
            counts['failed'] = counts.get('failed', 0) + 1
    return counts


def _blank() -> dict[str, int]:
    """Every verdict the sweep can report, so a summary never omits a bucket."""
    return {'restored': 0, 'failed': 0, 'committed': 0, 'unresolved': 0, 'refused': 0, 'done': 0}


def main() -> None:
    data_dir = Path(sys.argv[1] if len(sys.argv) > 1 else '')
    root = _open_root(sys.argv[2] if len(sys.argv) > 2 else '')
    mode = str(sys.argv[3] if len(sys.argv) > 3 else '')
    journal = data_dir / 'clone_journal'
    usable = 'usable' if root is not None else 'missing'
    if not journal.is_dir():
        print(json.dumps({'recovery': _blank(), 'clone_root': usable, 'at': time.time()}))
        return
    if mode == 'commit':
        summary = _commit_applied(journal, root)
        print(json.dumps({'commit': summary, 'clone_root': usable, 'at': time.time()}))
        return
    actionable = UNDONE_STATES | {'restore-failed'}
    if root is None:
        # No root to confine restores to: report every pending marker rather
        # than writing anywhere. Silent no-op is the failure mode this guards.
        counts = _blank()
        for marker_dir in _markers(journal):
            manifest = _load(marker_dir)
            if manifest is None:
                counts['unresolved'] += 1
                continue
            if str(manifest.get('state') or 'armed') in actionable:
                counts['refused'] += 1
        print(json.dumps({'recovery': counts, 'clone_root': usable, 'at': time.time()}))
        return
    counts = _blank()
    for marker_dir in _markers(journal):
        counts[_restore_marker(marker_dir, root)] += 1
    print(json.dumps({'recovery': counts, 'clone_root': usable, 'at': time.time()}))


def _load(marker_dir: Path) -> dict | None:
    try:
        return json.loads((marker_dir / 'manifest.json').read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


if __name__ == '__main__':
    main()
