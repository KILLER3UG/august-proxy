"""
Focused SAFETY tests for the SQLite write path (bug B2 audit).

These prove the corruption-safety mechanism that backs the ~33 direct
``memory_store`` writers:

  * ``app.services.memory_store._conn`` opens every connection with
    ``PRAGMA journal_mode=WAL`` and ``PRAGMA busy_timeout=10000``.
  * A minimal write committed through ``memory_store`` actually persists.
  * Phase 4 snake_case tables/indexes exist after init / migration.

All tests run against a TEMP database (via the ``AUGUST_BRAIN_SQLITE_FILE``
env override that ``memory_store._db_path`` honors) so the real brain file is
never touched.

Run with:  python -m pytest tests/test_sqlite_safety.py -q
"""

from __future__ import annotations

import sqlite3

import pytest

import app.services.memory_store as memoryStore


@pytest.fixture
def temp_brain(monkeypatch, tmp_path):
    """Point memoryStore at a throwaway DB and reset the thread-local conn."""
    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', str(tmp_path / 'brain.sqlite'))
    # Drop any cached connection so the next _conn() opens against the temp path.
    memoryStore.close()
    memoryStore.init()
    yield
    # Don't leak the temp connection (or the temp env) into other tests.
    memoryStore.close()


def test_memory_store_uses_wal(temp_brain):
    """The shared connection must use WAL journal mode (corruption safety)."""
    conn = memoryStore._conn()
    mode = conn.execute('PRAGMA journal_mode').fetchone()[0]
    assert mode == 'wal'


def test_memory_store_uses_busy_timeout(temp_brain):
    """The shared connection must set busy_timeout so writers wait, not error."""
    conn = memoryStore._conn()
    timeout = conn.execute('PRAGMA busy_timeout').fetchone()[0]
    assert int(timeout) == 10000


def test_direct_write_succeeds(temp_brain):
    """A write through the memoryStore helper commits and is readable back."""
    memoryStore.save_memory('safety_test_key', {'v': 1, 'nested': [1, 2, 3]})
    value = memoryStore.get_memory('safety_test_key')
    assert value == {'v': 1, 'nested': [1, 2, 3]}
    # And it survives a fresh read on a brand-new connection to the same file.
    memoryStore.close()
    assert memoryStore.get_memory('safety_test_key') == {'v': 1, 'nested': [1, 2, 3]}


# Phase 4 snake_case indexes (session / usage / blackboard / exam query paths).
_EXPECTED_INDEXES = (
    'idx_messages_session',
    'idx_usage_events_session',
    'idx_usage_events_created',
    'idx_sessions_archived',
    'idx_blackboard_session',
    'idx_exam_attempts_exam',
)

_EXPECTED_SNAKE_TABLES = (
    'memory_store',
    'session_topics',
    'usage_events',
    'config_audit',
    'learned_heuristics',
    'auto_memories',
    'episodic_timeline',
    'exam_questions',
    'exam_attempts',
    'pending_skills',
    'blackboard',
    'sessions',
    'messages',
    'facts',
)


def test_phase4_missing_indexes_exist(isolatedData):
    """memory_store.init() creates the Phase 4 session/usage/query indexes (IF NOT EXISTS)."""
    # isolatedData already calls memory_store.init() against a temp brain.
    conn = memoryStore._conn()
    names = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }
    missing = [name for name in _EXPECTED_INDEXES if name not in names]
    assert not missing, f'missing indexes after init(): {missing}; present={sorted(names)}'

    # Idempotent re-init must not fail or drop indexes.
    memoryStore.init()
    names_after = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }
    assert set(_EXPECTED_INDEXES).issubset(names_after)


def test_snake_case_tables_after_init(isolatedData):
    """ensure_schema creates snake_case table names (not camelCase)."""
    conn = memoryStore._conn()
    tables = {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    missing = [t for t in _EXPECTED_SNAKE_TABLES if t not in tables]
    assert not missing, f'missing snake tables: {missing}; present={sorted(tables)}'
    # Legacy camelCase tables must not remain
    for camel in ('memoryStore', 'sessionTopics', 'usageEvents', 'configAudit'):
        assert camel not in tables


def test_schema_migration_camel_to_snake(monkeypatch, tmp_path):
    """Old camelCase schema is renamed; data survives; FTS is recreated."""
    db_path = tmp_path / 'legacy_brain.sqlite'
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE memoryStore (
            key TEXT PRIMARY KEY,
            value TEXT,
            updatedAt TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            title TEXT,
            startedAt TEXT,
            messageCount INTEGER DEFAULT 0,
            provider TEXT DEFAULT '',
            model TEXT DEFAULT '',
            folderId TEXT,
            isArchived INTEGER DEFAULT 0,
            workspacePath TEXT
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sessionId TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            createdAt TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO memoryStore (key, value, updatedAt) VALUES ('keep_me', '"alive"', '2020-01-01');
        INSERT INTO sessions (id, title, startedAt, messageCount) VALUES ('s1', 'Legacy', 'now', 1);
        INSERT INTO messages (sessionId, role, content) VALUES ('s1', 'user', '"hi"');
        """
    )
    conn.commit()
    conn.close()

    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', str(db_path))
    memoryStore.close()
    memoryStore.init()

    c = memoryStore._conn()
    tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    assert 'memory_store' in tables
    assert 'memoryStore' not in tables
    assert 'messages' in tables

    cols = {r[1] for r in c.execute('PRAGMA table_info(memory_store)').fetchall()}
    assert 'updated_at' in cols
    assert 'updatedAt' not in cols

    msg_cols = {r[1] for r in c.execute('PRAGMA table_info(messages)').fetchall()}
    assert 'session_id' in msg_cols
    assert 'sessionId' not in msg_cols

    # Data survived
    assert memoryStore.get_memory('keep_me') == 'alive'
    sess = memoryStore.get_session('s1')
    assert sess is not None
    assert sess['title'] == 'Legacy'
    assert sess.get('startedAt') == 'now' or sess.get('messageCount') == 1
    msgs = memoryStore.get_messages('s1')
    assert len(msgs) == 1
    assert msgs[0]['role'] == 'user'

    # Wire keys are camelCase
    assert 'startedAt' in sess or 'messageCount' in sess

    # FTS exists under snake name
    assert 'memory_store_fts' in tables or any(n.startswith('memory_store_fts') for n in tables)

    # Idempotent second init
    memoryStore.init()
    assert memoryStore.get_memory('keep_me') == 'alive'
    memoryStore.close()


def test_row_as_wire_converts_snake_columns(isolatedData):
    """dict rows from SQL are converted to camelCase for API/TypedDicts."""
    memoryStore.save_session(
        {'id': 'wire-1', 'title': 'Wire', 'startedAt': 't0', 'messageCount': 2, 'isArchived': False}
    )
    row = memoryStore.get_session('wire-1')
    assert row is not None
    assert 'startedAt' in row
    assert 'messageCount' in row
    assert 'started_at' not in row
