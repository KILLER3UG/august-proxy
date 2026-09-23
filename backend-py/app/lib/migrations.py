"""Lightweight versioned migration runner for the August brain SQLite database.

Migrations are numbered .sql files in app/migrations/. Each is idempotent
(uses IF NOT EXISTS / IF EXISTS guards). The runner applies them in numeric
order, tracking applied versions in a schema_migrations table.

Called from memory_schema.ensure_schema() on every boot. Cost: one SELECT
per pending migration check (negligible).

A failure is not the end of the story: most failures on first attempt are
transient (locked database, a cold-start ordering quirk), so each version gets
``_MAX_ATTEMPTS`` tries before it is treated as permanently broken. Only then
does the log go to ERROR — a skipped migration means a column or table some
later code path expects does not exist.

Usage:
    from app.lib.migrations import run_migrations
    run_migrations(conn)
"""

from __future__ import annotations

import logging
import re
import shutil
import sqlite3
from pathlib import Path

logger = logging.getLogger(__name__)

_MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / 'migrations'

_MIGRATION_FILE_RE = re.compile(r'^(\d+)_.+\.sql$')

# How many times a given version is attempted before it is skipped for good.
_MAX_ATTEMPTS = 3


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
    # re-warned on every boot (audit finding). `attempts` bounds that: a
    # version is retried until it has failed _MAX_ATTEMPTS times, so a
    # one-off lock error no longer leaves a silent, permanent schema hole.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schema_migration_failures (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            error TEXT,
            attempts INTEGER NOT NULL DEFAULT 1,
            failed_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    cols = {
        row[1] for row in conn.execute('PRAGMA table_info(schema_migration_failures)').fetchall()
    }
    if 'attempts' not in cols:
        # Pre-existing installs recorded failures with no retry budget; give
        # them one so a single historical failure is not treated as spent.
        conn.execute(
            'ALTER TABLE schema_migration_failures'
            " ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1"
        )


def _applied_versions(conn: sqlite3.Connection) -> set[int]:
    """Return the set of already-applied migration versions."""
    rows = conn.execute('SELECT version FROM schema_migrations').fetchall()
    return {row[0] for row in rows}


def _failed_versions(conn: sqlite3.Connection) -> set[int]:
    """Versions whose retry budget is spent — these are skipped for good."""
    try:
        rows = conn.execute(
            f'SELECT version FROM schema_migration_failures WHERE attempts >= {_MAX_ATTEMPTS}'
        ).fetchall()
    except sqlite3.Error:
        return set()
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


def _snapshot_before_migration(conn: sqlite3.Connection, versions: list[int]) -> None:
    """Copy the database to ``<db>.pre-migration`` before schema is changed.

    One rolling snapshot, not an archive: enough to undo a bad migration on a
    desktop install whose brain DB holds the user's memory, cheap enough to
    take on every boot that actually applies something (rare — an upgrade).
    Taken before any DDL runs, so it always shows the database as it was going
    in. Skipped for in-memory or unpathed connections, and a failed snapshot
    never blocks the migration.
    """
    try:
        row = conn.execute('PRAGMA database_list').fetchone()
        path = (row or (None, 'main', ''))[2]
        if not path or path == ':memory:':
            return
        target = Path(f'{path}.pre-migration')
        # A file copy after a PASSIVE checkpoint, deliberately not sqlite's
        # backup API: backup() takes a read lock on the source and waits for
        # one, and a boot path must never block on a busy database. PASSIVE
        # flushes what is safe to flush and returns immediately, so the copy
        # can be slightly stale — a recovery aid, not a guaranteed restore
        # point.
        try:
            conn.execute('PRAGMA wal_checkpoint(PASSIVE)')
        except sqlite3.Error:
            pass
        source = Path(path)
        shutil.copy2(source, target)
        wal = Path(f'{path}-wal')
        if wal.exists():
            shutil.copy2(wal, Path(f'{target}-wal'))
        logger.info(
            'Snapshot of the brain database written to %s before migrations %s',
            target.name,
            ', '.join(f'{v:03d}' for v in versions),
        )
    except Exception as exc:
        logger.warning('Pre-migration snapshot skipped: %s', exc)


def run_migrations(conn: sqlite3.Connection) -> int:
    """Apply pending migrations in order. Returns count of newly applied.

    Idempotent — already-applied migrations are skipped. Each migration
    runs in its own transaction. Failures do not halt the app (the caller
    wraps this in try/except); a version gets _MAX_ATTEMPTS tries before it
    is skipped permanently and logged as an error.
    """
    _ensure_migration_table(conn)
    applied = _applied_versions(conn)
    skipped = _failed_versions(conn)
    migrations = _discover_migrations()
    pending = [m for m in migrations if m[0] not in applied and m[0] not in skipped]
    if pending:
        _snapshot_before_migration(conn, [m[0] for m in pending])
    newly_applied = 0

    for version, name, path in pending:
        sql = path.read_text(encoding='utf-8')
        try:
            conn.executescript(sql)
            conn.execute(
                'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
                (version, name),
            )
            # A retried failure that now succeeds leaves nothing to report.
            conn.execute('DELETE FROM schema_migration_failures WHERE version = ?', (version,))
            conn.commit()
            newly_applied += 1
            logger.info('Applied migration %03d: %s', version, name)
        except Exception as exc:
            attempts = _record_failure(conn, version, name, exc)
            if attempts >= _MAX_ATTEMPTS:
                # Loud on purpose: from here on the schema is knowingly partial,
                # and every consumer of whatever this DDL adds will not know why.
                logger.error(
                    'Migration %03d (%s) failed %s times and will be skipped for good: %s'
                    ' — the brain database is missing whatever it creates.',
                    version,
                    name,
                    attempts,
                    exc,
                )
            else:
                logger.warning(
                    'Migration %03d (%s) failed (attempt %s/%s, will retry on next boot): %s',
                    version,
                    name,
                    attempts,
                    _MAX_ATTEMPTS,
                    exc,
                )
            # Do not re-raise — allow app to start with partial schema.
            # CONTINUE to later migrations: a failing ALTER (e.g. duplicate
            # column on a DB that already has it) must not block the rest of
            # the chain (007–012) forever (audit finding).
            continue

    return newly_applied


def _record_failure(conn: sqlite3.Connection, version: int, name: str, exc: Exception) -> int:
    """Bump the retry counter for a failed version; returns attempts used."""
    attempts = 1
    try:
        conn.execute(
            """
            INSERT INTO schema_migration_failures (version, name, error, attempts)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(version) DO UPDATE SET
                name = excluded.name,
                error = excluded.error,
                attempts = schema_migration_failures.attempts + 1,
                failed_at = datetime('now')
            """,
            (version, name, str(exc)[:500]),
        )
        conn.commit()
        row = conn.execute(
            'SELECT attempts FROM schema_migration_failures WHERE version = ?', (version,)
        ).fetchone()
        if row is not None:
            attempts = int(row[0])
    except Exception:
        # The ledger itself is best-effort; losing it must not mask the failure.
        logger.debug('Could not record migration failure for %03d', version, exc_info=True)
    return attempts
