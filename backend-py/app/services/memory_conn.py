"""Brain SQLite connection helpers (shared by memory_store domains).

Owns thread-local connections, PRAGMA defaults, and path resolution so
CRUD modules stay free of connection boilerplate.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from pathlib import Path

from app.lib.paths import dataPath

_BRAIN_FILE_ENV = 'AUGUST_BRAIN_SQLITE_FILE'
_DEFAULT_BRAIN_FILE = 'august_brain.sqlite'
_TIMEOUT_MS = 10000
_local = threading.local()


def db_path() -> Path:
    """Resolve the brain SQLite database path."""
    env_path = os.environ.get(_BRAIN_FILE_ENV)
    if env_path:
        return Path(env_path)
    return dataPath(_DEFAULT_BRAIN_FILE)


def apply_conn_pragmas(conn: sqlite3.Connection) -> None:
    """WAL + busy_timeout always; cache/mmap/sync only when env opts in.

    **Default durability (no env):**
      * ``journal_mode=WAL`` — concurrent readers + single writer
      * ``busy_timeout=10000`` — wait instead of immediate SQLITE_BUSY
      * ``foreign_keys=ON``
      * ``synchronous`` left at SQLite default (**FULL**) — last committed
        transaction survives power loss; do **not** set NORMAL without an
        explicit measure + accept-loss decision

    **Opt-in only (not measured as default wins):**
      * ``AUGUST_SQLITE_SYNC=NORMAL|FULL|OFF`` — NORMAL under WAL can lose the
        last uncheckpointed transaction on hard power loss; OFF is unsafe
      * ``AUGUST_SQLITE_CACHE_KB`` — page cache KiB (negative PRAGMA cache_size)
      * ``AUGUST_SQLITE_MMAP_MB`` — mmap size MiB (0 / unset = do not set)
    """
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=10000')
    conn.execute('PRAGMA foreign_keys=ON')
    # Durability: only change synchronous when explicitly requested.
    sync_env = (os.environ.get('AUGUST_SQLITE_SYNC') or '').strip().upper()
    if sync_env in ('NORMAL', 'FULL', 'OFF'):
        conn.execute(f'PRAGMA synchronous={sync_env}')
    cache_raw = (os.environ.get('AUGUST_SQLITE_CACHE_KB') or '').strip()
    if cache_raw:
        try:
            cache_kb = int(cache_raw)
        except ValueError:
            cache_kb = 0
        if cache_kb != 0:
            conn.execute(f'PRAGMA cache_size={-abs(cache_kb)}')
    mmap_raw = (os.environ.get('AUGUST_SQLITE_MMAP_MB') or '').strip()
    if mmap_raw:
        try:
            mmap_mb = int(mmap_raw)
        except ValueError:
            mmap_mb = 0
        if mmap_mb > 0:
            conn.execute(f'PRAGMA mmap_size={mmap_mb * 1024 * 1024}')


def conn() -> sqlite3.Connection:
    """Get a thread-local connection to the brain database."""
    if not hasattr(_local, 'conn') or _local.conn is None:
        path = db_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(str(path), timeout=_TIMEOUT_MS / 1000)
        c.row_factory = sqlite3.Row
        apply_conn_pragmas(c)
        _local.conn = c
    return _local.conn


def close() -> None:
    """Close the thread-local connection."""
    if hasattr(_local, 'conn') and _local.conn is not None:
        try:
            _local.conn.close()
        except Exception:
            pass
        _local.conn = None
