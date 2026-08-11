"""Lightweight versioned migration runner for the August brain SQLite database.

Migrations are numbered .sql files in app/migrations/. Each is idempotent
(uses IF NOT EXISTS / IF EXISTS guards). The runner applies them in numeric
order, tracking applied versions in a schema_migrations table.

Called from memory_schema.ensure_schema() on every boot. Cost: one SELECT
per pending migration check (negligible).

Usage:
    from app.lib.migrations import run_migrations
    run_migrations(conn)
"""

from __future__ import annotations

import logging
import re
import sqlite3
from pathlib import Path

logger = logging.getLogger(__name__)

_MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / 'migrations'

_MIGRATION_FILE_RE = re.compile(r'^(\d+)_.+\.sql$')


def _ensure_migration_table(conn: sqlite3.Connection) -> None:
    """Create the schema_migrations tracking table if it doesn't exist."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    # Failed migrations are recorded so a permanently-broken DDL (e.g. an
    # ALTER whose column is already ensured by schema code) is NOT re-run and
    # re-warned on every boot (audit finding). A migration that failed once
    # with a partial executescript is never blindly re-executed.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schema_migration_failures (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            error TEXT,
            failed_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)


def _applied_versions(conn: sqlite3.Connection) -> set[int]:
    """Return the set of already-applied migration versions."""
    rows = conn.execute('SELECT version FROM schema_migrations').fetchall()
    return {row[0] for row in rows}


def _failed_versions(conn: sqlite3.Connection) -> set[int]:
    """Return the set of migration versions that previously failed."""
    rows = conn.execute('SELECT version FROM schema_migration_failures').fetchall()
    return {row[0] for row in rows}


def _discover_migrations() -> list[tuple[int, str, Path]]:
    """Find all migration files, sorted by version number.

    Returns list of (version, name, path) tuples.
    """
    if not _MIGRATIONS_DIR.is_dir():
        return []
    migrations = []
    for f in sorted(_MIGRATIONS_DIR.iterdir()):
        m = _MIGRATION_FILE_RE.match(f.name)
        if m:
            migrations.append((int(m.group(1)), f.name, f))
    migrations.sort(key=lambda x: x[0])
    return migrations


def run_migrations(conn: sqlite3.Connection) -> int:
    """Apply pending migrations in order. Returns count of newly applied.

    Idempotent — already-applied migrations are skipped. Each migration
    runs in its own transaction. Failures log a warning but do not halt
    the app (the caller wraps this in try/except).
    """
    _ensure_migration_table(conn)
    applied = _applied_versions(conn)
    failed = _failed_versions(conn)
    migrations = _discover_migrations()
    newly_applied = 0

    for version, name, path in migrations:
        if version in applied or version in failed:
            continue
        sql = path.read_text(encoding='utf-8')
        try:
            conn.executescript(sql)
            conn.execute(
                'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
                (version, name),
            )
            conn.commit()
            newly_applied += 1
            logger.info('Applied migration %03d: %s', version, name)
        except Exception as exc:
            logger.warning('Migration %03d (%s) failed: %s', version, name, exc)
            # Record the failure so this migration is not re-run on every
            # boot (a partial executescript must not be re-executed blindly).
            try:
                conn.execute(
                    'INSERT OR REPLACE INTO schema_migration_failures (version, name, error) VALUES (?, ?, ?)',
                    (version, name, str(exc)[:500]),
                )
                conn.commit()
            except Exception:
                pass
            # Do not re-raise — allow app to start with partial schema.
            # CONTINUE to later migrations: a failing ALTER (e.g. duplicate
            # column on a DB that already has it) must not block the rest of
            # the chain (007–012) forever (audit finding).
            continue

    return newly_applied
