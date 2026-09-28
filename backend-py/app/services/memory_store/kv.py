"""Key-value memory blob + FTS search domain."""
from __future__ import annotations

import json
import re
import sqlite3

from app.lib.paths import assertPytestDataDirIsolated
from app.services.deferred_writes import defer_commit
from app.services.memory_conn import conn as _conn
from app.services.memory_schema import ensure_schema
from app.services.memory_store.wire import _json
from app.type_aliases import JsonValue


def init() -> None:
    """Create all tables on first use (migrates camel→snake if needed)."""
    ensure_schema(_conn())


def _write_with_fts_recovery(
    conn: sqlite3.Connection, sql: str, params: tuple[object, ...]
) -> None:
    """Run a `memory_store` write, and repair the search index if it vetoes it.

    `memory_store` carries an AFTER INSERT/UPDATE/DELETE trigger that
    maintains `memory_store_fts`. In SQLite a trigger that raises aborts the
    statement that fired it, so a search index that cannot be opened takes the
    durable row down with it — the wrong way round, because the index is
    derived and rebuildable from the very table it indexes.

    The state that triggers this is a vtable entry that survived in
    sqlite_master while its shadow tables did not. `CREATE VIRTUAL TABLE IF
    NOT EXISTS` then skips it forever, so the failure is permanent for that
    file: every subsequent write raises, and every search returns nothing.

    So: attempt the write, and if the index is what failed, rebuild the index
    and retry ONCE. If the retry still fails the error propagates — a broken
    database must not be reported as a successful write.
    """
    try:
        conn.execute(sql, params)
        return
    except (sqlite3.OperationalError, sqlite3.DatabaseError) as first:
        if 'memory_store_fts' not in str(first) and 'malformed' not in str(first):
            raise
        try:
            conn.rollback()
        except sqlite3.Error:
            # A rollback on a connection that never opened a transaction is
            # not interesting; the rebuild below is what has to work.
            pass
        from app.services.memory_schema import rebuild_fts_index

        if not rebuild_fts_index(conn):
            raise first
        conn.execute(sql, params)


def save_internal(key: str, value: JsonValue) -> None:
    """Save a key-value pair to the internal KV store.

    Renamed from ``save_memory`` (plan §3.3 M2): the KV store is machine
    state / registry data, not user-visible memory. Durable memory goes
    through the facts store (``save_fact``); this name makes misuse obvious.
    """
    # Surface tests that bypass the autouse isolatedData fixture.
    assertPytestDataDirIsolated('memory_store.save_internal')
    conn = _conn()
    # An upsert, NOT `INSERT OR REPLACE`. REPLACE removes the conflicting row
    # without firing its AFTER DELETE trigger, so `memory_store_fts` — an
    # external-content index, kept in sync by triggers — keeps a posting for a
    # rowid that no longer exists. The index then raises
    # `fts5: missing row N from content table` for any search that matches that
    # stale term, which is every overwrite of an existing key. `set_internal_state`
    # below already uses this form.
    _write_with_fts_recovery(
        conn,
        "INSERT INTO memory_store (key, value, updated_at) VALUES (?, ?, datetime('now')) "
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        (key, _json(value)),
    )
    conn.commit()


def get_memory(key: str) -> JsonValue | None:
    """Get a value from memory by key."""
    conn = _conn()
    row = conn.execute('SELECT value FROM memory_store WHERE key = ?', (key,)).fetchone()
    if row:
        try:
            return json.loads(row['value'])
        except (json.JSONDecodeError, TypeError):
            return row['value']
    return None


def set_internal_state(key: str, value: JsonValue) -> None:
    """Write machine state to ``internal_state``.

    Maintenance/cron/daemon bookkeeping lives here — never in the
    user-visible ``memory_store`` KV and never in facts. Not exposed to
    the Brain stores UI; only reachable via the Settings raw-state lookup.
    """
    conn = _conn()
    conn.execute(
        "INSERT INTO internal_state (key, value, updated_at) VALUES (?, ?, datetime('now')) "
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        (key, _json(value)),
    )
    # P4.2: internal_state is machine bookkeeping, not read back
    # cross-thread within the turn — debounce the commit (≤2s).
    defer_commit(conn)


def get_internal_state(key: str) -> JsonValue | None:
    """Read a row from ``internal_state`` (None when absent)."""
    conn = _conn()
    row = conn.execute('SELECT value FROM internal_state WHERE key = ?', (key,)).fetchone()
    if row:
        try:
            return json.loads(row['value'])
        except (json.JSONDecodeError, TypeError):
            return row['value']
    return None


def _fts_match_query(query: str) -> str:
    """Build a safe FTS5 MATCH expression from free text (prefix OR tokens).

    Tokens are split on whitespace AND non-alphanumeric boundaries: the
    default unicode61 tokenizer indexes ``my note`` as two tokens, so a
    merged query token like ``my-note`` matched NEITHER and silently fell
    back to LIKE (audit finding).
    """
    tokens = [t for t in re.split(r'[^\w]+', query or '') if t]
    if not tokens:
        return ''
    # Quote tokens so punctuation does not break MATCH parsing.
    return ' OR '.join(f'"{t.replace(chr(34), "")}"*' for t in tokens if t.replace('"', ''))


