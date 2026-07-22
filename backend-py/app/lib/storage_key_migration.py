"""
storage_key_migration.py — One-time, idempotent runtime migration for brain
storage keys.

After the snake_case → camelCase migration, the JSON-blob memory keys are
``coreMemory`` and ``userProfile`` (was ``core_memory`` and ``user_profile``).
Table schema renames (camel→snake) are handled by
``app.services.schema_rename_migration`` via ``ensure_schema``.

This module handles the JSON-blob side: scans ``memory_store`` rows, finds
legacy snake_case keys, and rewrites the row in place. It is safe to call
on every startup (no-op if migration is already applied).
"""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

logger = logging.getLogger(__name__)
BLOB_KEY_RENAMES = {'core_memory': 'coreMemory', 'user_profile': 'userProfile'}

# Match memory_store._conn: wait up to 10s under lock contention instead of
# failing immediately with SQLITE_BUSY (Phase 4 B22 follow-up).
_BUSY_TIMEOUT_MS = 10000


def _connect(db_path: Path) -> sqlite3.Connection:
    """Open a brain-DB connection with the same safety pragmas as memory_store.

    Sets WAL journal mode and ``busy_timeout`` so concurrent writers (startup
    migration vs memory_store / daemons) wait instead of erroring.
    """
    conn = sqlite3.connect(str(db_path), timeout=_BUSY_TIMEOUT_MS / 1000)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute(f'PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}')
    return conn


def _memory_table(conn: sqlite3.Connection) -> str:
    """Prefer snake_case table; fall back to legacy camelCase for partial DBs."""
    names = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memory_store', 'memoryStore')"
        ).fetchall()
    }
    if 'memory_store' in names:
        return 'memory_store'
    if 'memoryStore' in names:
        return 'memoryStore'
    return 'memory_store'


def migrate_storage_keys(db_path: Path) -> None:
    """Walk the brain SQLite database and migrate legacy snake_case keys.

    For each row in ``memory_store`` whose ``key`` column matches a legacy
    name, copy the ``value`` to the new key and delete the old row.
    Idempotent: re-running on an already-migrated DB is a no-op.
    """
    if not db_path.exists():
        return
    conn = _connect(db_path)
    try:
        table = _memory_table(conn)
        for old_key, new_key in BLOB_KEY_RENAMES.items():
            old_row = conn.execute(f'SELECT value FROM {table} WHERE key = ?', (old_key,)).fetchone()
            if old_row is None:
                continue
            new_row = conn.execute(f'SELECT value FROM {table} WHERE key = ?', (new_key,)).fetchone()
            if new_row is None:
                conn.execute(f'INSERT INTO {table}(key, value) VALUES (?, ?)', (new_key, old_row['value']))
                logger.info('Migrated memory blob key: %s → %s', old_key, new_key)
            conn.execute(f'DELETE FROM {table} WHERE key = ?', (old_key,))
        conn.commit()
    finally:
        conn.close()


def is_already_migrated(db_path: Path) -> bool:
    """True if the DB has at least one camelCase row and no snake_case rows.

    Used as a quick guard so we don't churn logs each startup. Migration
    itself is cheap enough that ``migrate_storage_keys`` is also idempotent.
    """
    if not db_path.exists():
        return True
    conn = _connect(db_path)
    try:
        table = _memory_table(conn)
        for old_key in BLOB_KEY_RENAMES:
            row = conn.execute(f'SELECT 1 FROM {table} WHERE key = ? LIMIT 1', (old_key,)).fetchone()
            if row is not None:
                return False
        return True
    finally:
        conn.close()