"""Tests for the SQLite migration framework (Phase 1.3)."""

import sqlite3

import pytest
from app.lib.migrations import _discover_migrations, _ensure_migration_table, run_migrations


@pytest.fixture()
def conn(tmp_path):
    """Fresh in-memory-like DB for migration testing."""
    db = tmp_path / 'test_migrate.sqlite'
    c = sqlite3.connect(str(db))
    # Production connections use Row access (memory_schema PRAGMA reads).
    c.row_factory = sqlite3.Row
    yield c
    c.close()


def test_ensure_migration_table_creates_table(conn):
    """_ensure_migration_table creates the tracking table."""
    _ensure_migration_table(conn)
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
    ).fetchone()
    assert row is not None


def test_ensure_migration_table_idempotent(conn):
    """Calling twice doesn't error."""
    _ensure_migration_table(conn)
    _ensure_migration_table(conn)


def test_run_migrations_applies_baseline(conn):
    """run_migrations applies 001_baseline.sql on a fresh DB."""
    count = run_migrations(conn)
    assert count >= 1

    # Verify tracking
    rows = conn.execute('SELECT version, name FROM schema_migrations ORDER BY version').fetchall()
    assert len(rows) >= 1
    assert rows[0][0] == 1
    assert '001_baseline' in rows[0][1]


def test_run_migrations_idempotent(conn):
    """Second run applies nothing new."""
    first = run_migrations(conn)
    second = run_migrations(conn)
    assert first >= 1
    assert second == 0


def test_run_migrations_records_version(conn):
    """Applied migrations are tracked with version and name."""
    run_migrations(conn)
    versions = conn.execute('SELECT version FROM schema_migrations').fetchall()
    version_set = {v[0] for v in versions}
    assert 1 in version_set


def test_discover_migrations_finds_files():
    """_discover_migrations finds the baseline file."""
    migrations = _discover_migrations()
    assert len(migrations) >= 1
    assert migrations[0][0] == 1  # version
    assert '001_baseline' in migrations[0][1]  # name


def test_migration_failure_does_not_halt(conn, tmp_path, monkeypatch):
    """A failing migration logs warning but doesn't raise."""
    from pathlib import Path

    import app.lib.migrations as mod

    # Create a bad migration file
    bad_dir = tmp_path / 'migrations'
    bad_dir.mkdir()
    (bad_dir / '001_baseline.sql').write_text('SELECT 1;')
    (bad_dir / '002_bad.sql').write_text('INVALID SQL SYNTAX HERE;')

    monkeypatch.setattr(mod, '_MIGRATIONS_DIR', bad_dir)

    # Should not raise
    count = run_migrations(conn)
    assert count == 1  # Only 001 applied, 002 failed gracefully

    # 002 not recorded
    versions = {v[0] for v in conn.execute('SELECT version FROM schema_migrations').fetchall()}
    assert 2 not in versions


def _tables(conn) -> set[str]:
    return {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }


def test_migration_025_purges_dead_state_and_keeps_live(conn):
    """025 removes orphaned daemon state + turn-lessons, keeps agent_jobs.

    Plan line 534: migration 025 idempotence + keep-list (agent_jobs
    survives). Uses the production schema path (ensure_schema first, as in
    memory_store.init), seeds sentinel rows, un-records 025/026, and lets
    the runner re-apply them.
    """
    from app.services.memory_schema import ensure_schema

    ensure_schema(conn)

    # Legacy installs still had learned_heuristics (dropped when empty on
    # fresh schemas) and dead tables — recreate them for the sentinels.
    conn.execute(
        'CREATE TABLE IF NOT EXISTS learned_heuristics ('
        'id INTEGER PRIMARY KEY AUTOINCREMENT, rule TEXT, source TEXT,'
        " category TEXT DEFAULT 'general', created_at TEXT, updated_at TEXT)"
    )
    conn.execute('CREATE TABLE IF NOT EXISTS curation_ledger (id INTEGER PRIMARY KEY)')
    conn.execute('CREATE TABLE IF NOT EXISTS brain_events (id INTEGER PRIMARY KEY)')

    # Sentinel state that 025 must purge…
    conn.execute(
        "INSERT OR REPLACE INTO memory_store (key, value) VALUES ('boot_maintenance_state', '{}')"
    )
    conn.execute(
        "INSERT OR REPLACE INTO memory_store (key, value) VALUES ('userProfile', '{}')"
    )
    # …and the live registry entry it must NOT touch (keep-list).
    conn.execute(
        "INSERT OR REPLACE INTO memory_store (key, value) VALUES ('agent_jobs', '{\"kept\": true}')"
    )
    conn.execute(
        "INSERT INTO learned_heuristics (rule, source) VALUES ('dead lesson', 'turn-lesson')"
    )
    conn.execute(
        "INSERT INTO learned_heuristics (rule, source) VALUES ('kept rule', 'user')"
    )
    conn.commit()

    # Un-record 025/026 so the runner re-applies them over the sentinels.
    conn.execute('DELETE FROM schema_migrations WHERE version IN (25, 26)')
    conn.commit()
    applied = run_migrations(conn)
    assert applied >= 2

    kv = {
        r[0]
        for r in conn.execute('SELECT key FROM memory_store').fetchall()
    }
    assert 'boot_maintenance_state' not in kv
    assert 'userProfile' not in kv
    assert 'agent_jobs' in kv  # keep-list

    rules = {
        r[0]
        for r in conn.execute('SELECT rule FROM learned_heuristics').fetchall()
    }
    assert 'dead lesson' not in rules
    assert 'kept rule' in rules

    tables = _tables(conn)
    for dead in ('curation_ledger', 'brain_events', 'session_traces', 'vector_entries'):
        assert dead not in tables

    # Idempotence: re-applying 025/026 again changes nothing and never fails.
    conn.execute('DELETE FROM schema_migrations WHERE version IN (25, 26)')
    conn.commit()
    run_migrations(conn)
    kv2 = {r[0] for r in conn.execute('SELECT key FROM memory_store').fetchall()}
    assert kv2 == kv
    assert _tables(conn) == tables
