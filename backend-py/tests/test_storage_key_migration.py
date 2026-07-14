"""Regression tests for ``app.lib.storage_key_migration``.

The startup migration renames legacy snake_case JSON-blob keys
(``core_memory`` -> ``coreMemory``, ``user_profile`` -> ``userProfile``)
in the ``memoryStore`` table. It is called from ``app/main.py:97`` on
every startup.

B22: prior to the fix, every SQL query in this module referenced
``memory_store`` (snake_case), which does not exist as a table; the
real table is ``memoryStore`` (camelCase, per
``scripts/migrateDbColumns.py:74``). The module therefore raised
``sqlite3.OperationalError: no such table: memory_store`` on every
startup, silently caught by ``main.py``.

These tests build a small in-memory SQLite database with the
``memoryStore`` schema and exercise the real (file-based) ``migrate_storage_keys``
function against it.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from app.lib.storage_key_migration import (
    BLOB_KEY_RENAMES,
    _BUSY_TIMEOUT_MS,
    _connect,
    is_already_migrated,
    migrate_storage_keys,
)


def _seedDb(path: Path, rows: dict[str, str]) -> None:
    """Create a fresh SQLite DB with the ``memoryStore`` schema and seed rows."""
    conn = sqlite3.connect(str(path))
    try:
        conn.executescript(
            """
            CREATE TABLE memoryStore (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
            """
        )
        for k, v in rows.items():
            conn.execute('INSERT INTO memoryStore(key, value) VALUES (?, ?)', (k, v))
        conn.commit()
    finally:
        conn.close()


def _readKeys(path: Path) -> set[str]:
    conn = sqlite3.connect(str(path))
    try:
        return {row[0] for row in conn.execute('SELECT key FROM memoryStore')}
    finally:
        conn.close()


def testMigrateRenamesLegacyKeys(tmp_path: Path):
    db = tmp_path / 'brain.sqlite'
    _seedDb(db, {'core_memory': '"hello"', 'user_profile': '{"name":"x"}'})

    migrate_storage_keys(db)

    keys = _readKeys(db)
    assert 'core_memory' not in keys
    assert 'user_profile' not in keys
    assert 'coreMemory' in keys
    assert 'userProfile' in keys


def testMigrateIsIdempotent(tmp_path: Path):
    db = tmp_path / 'brain.sqlite'
    _seedDb(db, {'core_memory': '"hello"'})

    migrate_storage_keys(db)
    # Second call should not crash, should not duplicate, should not delete the new key.
    migrate_storage_keys(db)

    keys = _readKeys(db)
    assert keys == {'coreMemory'}, f'expected only coreMemory, got {keys}'


def testMigrateSkipsMissingDb(tmp_path: Path):
    db = tmp_path / 'does_not_exist.sqlite'
    # Should not raise.
    migrate_storage_keys(db)


def testIsAlreadyMigratedTrueOnFreshDb(tmp_path: Path):
    db = tmp_path / 'brain.sqlite'
    _seedDb(db, {'coreMemory': '"hello"', 'userProfile': '{"name":"x"}'})

    assert is_already_migrated(db) is True


def testIsAlreadyMigratedFalseOnLegacyDb(tmp_path: Path):
    db = tmp_path / 'brain.sqlite'
    _seedDb(db, {'core_memory': '"hello"'})

    assert is_already_migrated(db) is False


def testRenameMapCoversExpectedKeys():
    """Sanity check: the rename map still matches the docstring's claim."""
    assert set(BLOB_KEY_RENAMES) == {'core_memory', 'user_profile'}
    assert BLOB_KEY_RENAMES['core_memory'] == 'coreMemory'
    assert BLOB_KEY_RENAMES['user_profile'] == 'userProfile'


def testConnectUsesBusyTimeoutAndWal(tmp_path: Path):
    """Connections must match memory_store safety pragmas (Phase 4 B22 follow-up).

    Bare sqlite3.connect without busy_timeout races with concurrent writers
    (memory_store / daemons) and surfaces SQLITE_BUSY during startup migration.
    """
    db = tmp_path / 'brain.sqlite'
    _seedDb(db, {'coreMemory': '"x"'})

    conn = _connect(db)
    try:
        timeout = conn.execute('PRAGMA busy_timeout').fetchone()[0]
        mode = conn.execute('PRAGMA journal_mode').fetchone()[0]
        assert int(timeout) == _BUSY_TIMEOUT_MS == 10000
        assert mode == 'wal'
    finally:
        conn.close()