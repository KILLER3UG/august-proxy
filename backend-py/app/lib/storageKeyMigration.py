"""
storageKeyMigration.py — One-time, idempotent runtime migration for brain
storage keys.

After the snake_case → camelCase migration, the JSON-blob memory keys are
``coreMemory`` and ``userProfile`` (was ``core_memory`` and ``user_profile``).
The SQLite tables ``learnedHeuristics`` / ``autoMemories`` are renamed by
``scripts.migrateDbColumns.migrateDatabase``.

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

def migrateStorageKeys(dbPath: Path) -> None:
    """Walk the brain SQLite database and migrate legacy snake_case keys.

    For each row in ``memory_store`` whose ``key`` column matches a legacy
    name, copy the ``value`` to the new key and delete the old row.
    Idempotent: re-running on an already-migrated DB is a no-op.
    """
    if not dbPath.exists():
        return
    conn = sqlite3.connect(str(dbPath))
    try:
        conn.row_factory = sqlite3.Row
        for oldKey, newKey in BLOB_KEY_RENAMES.items():
            oldRow = conn.execute('SELECT value FROM memory_store WHERE key = ?', (oldKey,)).fetchone()
            if oldRow is None:
                continue
            newRow = conn.execute('SELECT value FROM memory_store WHERE key = ?', (newKey,)).fetchone()
            if newRow is None:
                conn.execute('INSERT INTO memory_store(key, value) VALUES (?, ?)', (newKey, oldRow['value']))
                logger.info('Migrated memory blob key: %s → %s', oldKey, newKey)
            conn.execute('DELETE FROM memory_store WHERE key = ?', (oldKey,))
        conn.commit()
    finally:
        conn.close()

def isAlreadyMigrated(dbPath: Path) -> bool:
    """True if the DB has at least one camelCase row and no snake_case rows.

    Used as a quick guard so we don't churn logs each startup. Migration
    itself is cheap enough that ``migrateStorageKeys`` is also idempotent.
    """
    if not dbPath.exists():
        return True
    conn = sqlite3.connect(str(dbPath))
    try:
        for oldKey in BLOB_KEY_RENAMES:
            row = conn.execute('SELECT 1 FROM memory_store WHERE key = ? LIMIT 1', (oldKey,)).fetchone()
            if row is not None:
                return False
        return True
    finally:
        conn.close()