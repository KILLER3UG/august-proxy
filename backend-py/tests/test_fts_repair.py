"""Tests for FTS5 desync repair (Phase 1.8)."""

import sqlite3

import pytest
from app.services.memory_schema import ensure_schema, repair_fts_sync


@pytest.fixture()
def brain_conn(tmp_path):
    """Create a fresh brain DB with schema applied."""
    db_file = tmp_path / 'test_brain.sqlite'
    conn = sqlite3.connect(str(db_file))
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    ensure_schema(conn)
    return conn


def test_repair_noop_when_synced(brain_conn):
    """repair_fts_sync does nothing when index and base are in sync."""
    # Insert a row through the proper path (triggers keep FTS in sync)
    brain_conn.execute(
        "INSERT OR REPLACE INTO memory_store (key, value) VALUES ('test_key', 'test_value')"
    )
    brain_conn.commit()

    # Verify synced
    idx_n = brain_conn.execute('SELECT count(*) FROM memory_store_fts_docsize').fetchone()[0]
    base_n = brain_conn.execute('SELECT count(*) FROM memory_store').fetchone()[0]
    assert idx_n == base_n

    # Repair should be a no-op (no exception, no rebuild)
    repair_fts_sync(brain_conn)

    # Still synced
    idx_n2 = brain_conn.execute('SELECT count(*) FROM memory_store_fts_docsize').fetchone()[0]
    assert idx_n2 == base_n


def test_repair_fixes_stale_index_entries(brain_conn):
    """repair_fts_sync rebuilds when index has more docs than base table."""
    # Insert a row normally (trigger syncs FTS)
    brain_conn.execute(
        "INSERT OR REPLACE INTO memory_store (key, value) VALUES ('keep_me', 'good data')"
    )
    brain_conn.commit()

    # Simulate a pre-trigger delete: remove from base but leave FTS stale
    # First, manually insert into FTS to simulate a stale entry
    brain_conn.execute(
        "INSERT INTO memory_store_fts(rowid, key, value) VALUES (9999, 'stale_key', 'stale data')"
    )
    brain_conn.commit()

    # Verify desync exists
    idx_n = brain_conn.execute('SELECT count(*) FROM memory_store_fts_docsize').fetchone()[0]
    base_n = brain_conn.execute('SELECT count(*) FROM memory_store').fetchone()[0]
    assert idx_n > base_n, 'Precondition: index should have more docs than base'

    # Run repair
    repair_fts_sync(brain_conn)

    # After repair: counts must match
    idx_n2 = brain_conn.execute('SELECT count(*) FROM memory_store_fts_docsize').fetchone()[0]
    base_n2 = brain_conn.execute('SELECT count(*) FROM memory_store').fetchone()[0]
    assert idx_n2 == base_n2


def test_repair_match_query_works_after_fix(brain_conn):
    """After repair, MATCH queries return correct results without errors."""
    brain_conn.execute(
        "INSERT OR REPLACE INTO memory_store (key, value) VALUES ('august_proxy', 'local ai gateway')"
    )
    brain_conn.commit()

    # Simulate stale entry
    brain_conn.execute(
        "INSERT INTO memory_store_fts(rowid, key, value) VALUES (8888, 'ghost', 'phantom entry')"
    )
    brain_conn.commit()

    # Repair
    repair_fts_sync(brain_conn)

    # MATCH query should work without 'missing row' errors
    rows = brain_conn.execute(
        "SELECT key FROM memory_store_fts WHERE memory_store_fts MATCH 'august'"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0][0] == 'august_proxy'

    # The stale entry should not appear
    rows2 = brain_conn.execute(
        "SELECT key FROM memory_store_fts WHERE memory_store_fts MATCH 'ghost'"
    ).fetchall()
    assert len(rows2) == 0


def test_repair_handles_missing_fts_table_gracefully(brain_conn):
    """If an FTS table doesn't exist, repair skips it without error."""
    # Drop a LIVE fts table to simulate a fresh/partial DB (auto_memories_fts
    # was retired by migration 033, so it no longer exercises this path —
    # Part 25 Phase 7.4 switched to memory_store_fts).
    brain_conn.execute('DROP TABLE IF EXISTS memory_store_fts')
    brain_conn.commit()

    # Should not raise
    repair_fts_sync(brain_conn)


def test_ensure_schema_calls_repair_on_warm_path(brain_conn):
    """ensure_schema on a warm (already-versioned) DB still runs repair."""
    # Insert + create stale entry
    brain_conn.execute(
        "INSERT OR REPLACE INTO memory_store (key, value) VALUES ('warm_test', 'data')"
    )
    brain_conn.execute(
        "INSERT INTO memory_store_fts(rowid, key, value) VALUES (7777, 'warm_stale', 'x')"
    )
    brain_conn.commit()

    # Re-run ensure_schema (warm path since user_version is set)
    ensure_schema(brain_conn)

    # Desync should be fixed
    idx_n = brain_conn.execute('SELECT count(*) FROM memory_store_fts_docsize').fetchone()[0]
    base_n = brain_conn.execute('SELECT count(*) FROM memory_store').fetchone()[0]
    assert idx_n == base_n
