"""Tests for the SQLite migration framework (Phase 1.3)."""

import sqlite3

import pytest
from app.lib.migrations import _discover_migrations, _ensure_migration_table, run_migrations


@pytest.fixture()
def conn(tmp_path):
    """Fresh in-memory-like DB for migration testing."""
    db = tmp_path / 'test_migrate.sqlite'
    c = sqlite3.connect(str(db))
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
