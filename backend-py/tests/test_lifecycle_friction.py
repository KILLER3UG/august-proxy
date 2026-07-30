"""Tests for memory lifecycle tracking (Phase 3.1) and friction attribution (Phase 3.2)."""

import sqlite3

import pytest
from app.services.memory_schema import ensure_schema


@pytest.fixture()
def brain_conn(tmp_path, monkeypatch):
    """Create a fresh brain DB and patch memory_store._conn to use it."""
    db_file = tmp_path / 'test_brain.sqlite'
    conn = sqlite3.connect(str(db_file))
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    ensure_schema(conn)

    # Patch _conn so lifecycle/friction modules use this DB
    import app.services.memory_store as ms
    monkeypatch.setattr(ms, '_conn', lambda: conn)

    yield conn
    conn.close()


# ─── Memory Lifecycle (3.1) ───────────────────────────────────────────────────


class TestMemoryLifecycle:
    def test_record_and_query(self, brain_conn):
        from app.services.memory.lifecycle import get_memory_lifecycle_stats, record_lifecycle_event

        record_lifecycle_event('user_prefers_uv', 'created')
        record_lifecycle_event('user_prefers_uv', 'retrieved', session_id='s1')
        record_lifecycle_event('user_prefers_uv', 'retrieved', session_id='s2')
        record_lifecycle_event('user_prefers_uv', 'applied', session_id='s2')

        stats = get_memory_lifecycle_stats()
        assert len(stats) == 1
        assert stats[0]['key'] == 'user_prefers_uv'
        assert stats[0]['retrievedCount'] == 2
        assert stats[0]['appliedCount'] == 1
        assert stats[0]['state'] == 'active'

    def test_dormant_state(self, brain_conn):
        from app.services.memory.lifecycle import get_memory_lifecycle_stats, record_lifecycle_event

        record_lifecycle_event('never_used', 'created')

        stats = get_memory_lifecycle_stats()
        assert stats[0]['state'] == 'dormant'
        assert stats[0]['retrievedCount'] == 0

    def test_batch_retrieved(self, brain_conn):
        from app.services.memory.lifecycle import get_memory_lifecycle_stats, record_lifecycle_event, record_retrieved

        record_lifecycle_event('mem_a', 'created')
        record_lifecycle_event('mem_b', 'created')
        record_retrieved(['mem_a', 'mem_b'], session_id='s1')

        stats = get_memory_lifecycle_stats()
        keys = {s['key']: s for s in stats}
        assert keys['mem_a']['retrievedCount'] == 1
        assert keys['mem_b']['retrievedCount'] == 1

    def test_mark_stale(self, brain_conn):
        from app.services.memory.lifecycle import (
            get_memory_lifecycle_stats,
            mark_stale_memories,
            record_lifecycle_event,
        )

        record_lifecycle_event('old_memory', 'created')
        # Backdate the created event to 60 days ago
        brain_conn.execute(
            "UPDATE memory_lifecycle SET created_at = datetime('now', '-60 days') WHERE memory_key = 'old_memory'"
        )
        brain_conn.commit()

        count = mark_stale_memories(days=30)
        assert count == 1

        stats = get_memory_lifecycle_stats()
        mem = next(s for s in stats if s['key'] == 'old_memory')
        assert mem['state'] == 'stale'

    def test_stale_not_double_marked(self, brain_conn):
        from app.services.memory.lifecycle import mark_stale_memories, record_lifecycle_event

        record_lifecycle_event('old2', 'created')
        brain_conn.execute(
            "UPDATE memory_lifecycle SET created_at = datetime('now', '-60 days') WHERE memory_key = 'old2'"
        )
        brain_conn.commit()

        assert mark_stale_memories(days=30) == 1
        assert mark_stale_memories(days=30) == 0  # Already marked


# ─── Friction Attribution (3.2) ──────────────────────────────────────────────


class TestFrictionAttribution:
    def test_record_and_stats(self, brain_conn):
        from app.services.memory.friction import FrictionCategory, get_friction_stats, record_friction

        record_friction('s1', FrictionCategory.TOOL, detail='write_file failed', tool_name='write_file')
        record_friction('s1', FrictionCategory.TOOL, detail='read_file timeout', tool_name='read_file')
        record_friction('s1', FrictionCategory.PROVIDER, detail='HTTP 429')
        record_friction('s2', FrictionCategory.HARNESS, detail='missing AGENTS.md')

        stats = get_friction_stats(since_days=7)
        assert stats['total'] == 4
        assert stats['byCategory']['tool'] == 2
        assert stats['byCategory']['provider'] == 1
        assert stats['byCategory']['harness'] == 1

    def test_tool_friction_convenience(self, brain_conn):
        from app.services.memory.friction import get_friction_stats, record_tool_friction

        record_tool_friction('s1', 'run_command', 'Permission denied')
        stats = get_friction_stats()
        assert stats['byCategory']['tool'] == 1
        assert stats['topTools'][0]['tool'] == 'run_command'

    def test_provider_friction_convenience(self, brain_conn):
        from app.services.memory.friction import get_friction_stats, record_provider_friction

        record_provider_friction('s1', 429, 'Rate limited')
        stats = get_friction_stats()
        assert stats['byCategory']['provider'] == 1

    def test_empty_stats(self, brain_conn):
        from app.services.memory.friction import get_friction_stats

        stats = get_friction_stats()
        assert stats['total'] == 0
        assert stats['byCategory'] == {}
        assert stats['daily'] == []

    def test_detail_truncated(self, brain_conn):
        from app.services.memory.friction import FrictionCategory, record_friction

        # Detail > 500 chars should be truncated without error
        record_friction('s1', FrictionCategory.COMPLEXITY, detail='x' * 1000)
        row = brain_conn.execute('SELECT detail FROM friction_events').fetchone()
        assert len(row['detail']) == 500

    def test_all_categories_valid(self, brain_conn):
        from app.services.memory.friction import FrictionCategory, get_friction_stats, record_friction

        for cat in FrictionCategory:
            record_friction('s1', cat, detail=f'test {cat.value}')

        stats = get_friction_stats()
        assert stats['total'] == 7
        assert len(stats['byCategory']) == 7
