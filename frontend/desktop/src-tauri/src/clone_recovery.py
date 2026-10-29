"""Standalone clone-journal recovery — runs OUTSIDE the editable tree.

Stage 3 of the self-edit loop. The Rust shell embeds this file via
``include_str!`` and runs it (``python -I -S clone_recovery.py <dataDir>``)
BEFORE spawning the Python backend. An edit that broke the backend's import
path therefore cannot take the recovery path down with it: this script
imports nothing but the stdlib, never touches the app package, and is
compiled into the shell binary — the model's hot edits cannot change its
behavior until the shell itself is rebuilt, which is a human act.

It mirrors the marker contract of ``backend-py/app/services/clone_journal.py``
— keep the two in sync (same manifest layout, same states, same restore
semantics). The journal directory is ``<dataDir>/clone_journal/<id>/`` with
``manifest.json`` (``entries[].{path,existed,sha256_before,stored}``) and
``files/NNN.bin`` holding the pre-edit bytes. Uncommitted markers
(``armed`` / ``applied`` / ``restore-failed``) are undone from recorded
bytes — never from the working tree; added files are deleted; committed
markers are history; a failed restore keeps the marker for the next boot.

Exit code is always 0 (recovery is best-effort; boot must proceed) — the
JSON summary on stdout carries what happened, and the shell logs it.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path

UNDONE_STATES = frozenset({'armed', 'applied'})


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


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


def _restore_marker(marker_dir: Path) -> bool:
    try:
        manifest = json.loads((marker_dir / 'manifest.json').read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return False
    state = str(manifest.get('state') or 'armed')
    if state == 'committed':
        return False
    if state not in UNDONE_STATES and state != 'restore-failed':
        return False
    files_dir = marker_dir / 'files'
    ok = True
    for entry in manifest.get('entries', []):
        path = Path(str(entry.get('path') or ''))
        try:
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
    manifest['state'] = 'restored' if ok else 'restore-failed'
    manifest['restored_at'] = time.time()
    manifest['restored_by'] = 'shell'
    try:
        _write_atomic(marker_dir / 'manifest.json', json.dumps(manifest, indent=2).encode('utf-8'))
    except OSError:
        ok = False
    return ok


def main() -> None:
    data_dir = Path(sys.argv[1] if len(sys.argv) > 1 else '')
    journal = data_dir / 'clone_journal'
    counts = {'restored': 0, 'failed': 0, 'committed': 0}
    if journal.is_dir():
        for marker_dir in sorted(journal.iterdir()):
            if not marker_dir.is_dir():
                continue
            try:
                manifest = json.loads((marker_dir / 'manifest.json').read_text(encoding='utf-8'))
            except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                continue
            state = str(manifest.get('state') or 'armed')
            if state == 'committed':
                counts['committed'] += 1
                continue
            if state not in UNDONE_STATES and state != 'restore-failed':
                continue
            if _restore_marker(marker_dir):
                counts['restored'] += 1
            else:
                counts['failed'] += 1
    print(json.dumps({'recovery': counts, 'at': time.time()}))


if __name__ == '__main__':
    main()
