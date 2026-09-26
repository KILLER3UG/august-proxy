"""Brain SQLite connection helpers (shared by memory_store domains).

Owns thread-local connections, PRAGMA defaults, and path resolution so
CRUD modules stay free of connection boilerplate.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from pathlib import Path

from app.lib.paths import dataPath

logger = logging.getLogger('august.memory_conn')

_BRAIN_FILE_ENV = 'AUGUST_BRAIN_SQLITE_FILE'
_DEFAULT_BRAIN_FILE = 'august_brain.sqlite'
_TIMEOUT_MS = 10000
# Bounded wait for a concurrent first open of the same database file:
# _WAL_RETRY_ATTEMPTS * _WAL_RETRY_S ≈ 1s.
_WAL_RETRY_ATTEMPTS = 20
_WAL_RETRY_S = 0.05
_local = threading.local()
_dual_root_warned = False


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
    # Retry the WAL conversion, and only the WAL conversion. SQLite does NOT
    # invoke the busy handler when a connection has to take the write lock to
    # change journal mode — waiting there could deadlock the two connections
    # against each other — so this statement fails with SQLITE_BUSY on a
    # brand-new database opened by two threads at once even though `timeout=`
    # was passed to connect(). Everything below it does get the busy handler,
    # which is why the pragma after it never flakes.
    #
    # Measured on this machine: 5 failures / 72 concurrent inits of a fresh
    # file, 0 / 72 once WAL is already set. The condition is another thread
    # finishing its own open, so it is transient by construction and retrying
    # is the documented remedy rather than a mask.
    for attempt in range(_WAL_RETRY_ATTEMPTS):
        try:
            conn.execute('PRAGMA journal_mode=WAL')
            break
        except sqlite3.OperationalError as exc:
            if 'locked' not in str(exc).lower() or attempt == _WAL_RETRY_ATTEMPTS - 1:
                raise
            time.sleep(_WAL_RETRY_S)
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


def _warn_dual_data_roots(path: Path) -> None:
    """Phase D hygiene: warn ONCE when a second brain DB exists.

    The dev checkout's ``backend-py/data/august_brain.sqlite`` (the 0.16-era
    default before the AppData move) still holds pre-migration data. When
    the active DB is elsewhere and the stale file exists, log a warning —
    never auto-delete, never migrate silently: the user may have unmerged
    memories there.
    """
    global _dual_root_warned
    if _dual_root_warned:
        return
    _dual_root_warned = True
    try:
        repoStale = (
            Path(__file__).resolve().parent.parent.parent / 'data' / 'august_brain.sqlite'
        )
        if repoStale.resolve() != path.resolve() and repoStale.exists():
            logger.warning(
                'Two brain data roots exist: active=%s and legacy=%s '
                '(%d bytes, %s). The legacy file is ignored — to recover it, '
                'copy it into the brain backups folder named exactly '
                'brain-YYYYMMDDTHHMMSSZ-legacy.sqlite (stamp with no dashes, e.g. '
                'brain-20260922T090000Z-legacy.sqlite; the restore door rejects '
                'any other name) and use Settings → Memory → Restore. The current '
                'database is kept as a .pre-restore copy.',
                path,
                repoStale,
                repoStale.stat().st_size,
                time.strftime('%Y-%m-%d', time.localtime(repoStale.stat().st_mtime)),
            )
    except Exception:
        pass


def conn() -> sqlite3.Connection:
    """Get a thread-local connection to the brain database."""
    if not hasattr(_local, 'conn') or _local.conn is None:
        path = db_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        _warn_dual_data_roots(path)
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
