"""
Focused SAFETY tests for the SQLite write path (bug B2 audit).

These prove the corruption-safety mechanism that backs the ~33 direct
``memoryStore`` writers:

  * ``app.services.memoryStore._conn`` opens every connection with
    ``PRAGMA journal_mode=WAL`` and ``PRAGMA busy_timeout=10000``.
  * A minimal write committed through ``memoryStore`` actually persists.

All tests run against a TEMP database (via the ``AUGUST_BRAIN_SQLITE_FILE``
env override that ``memoryStore._db_path`` honors) so the real brain file is
never touched.

Run with:  python -m pytest tests/test_sqlite_safety.py -q
"""

from __future__ import annotations

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


# Phase 4 additive indexes (session / usage / blackboard / exam query paths).
_EXPECTED_INDEXES = (
    'idx_messages_session',
    'idx_usageEvents_session',
    'idx_usageEvents_created',
    'idx_sessions_archived',
    'idx_blackboard_session',
    'idx_examAttempts_exam',
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
