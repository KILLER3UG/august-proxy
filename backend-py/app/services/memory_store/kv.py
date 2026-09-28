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
    """Run a `memory_store` write, and repair the search index if it vetoed it.

    `memory_store` carries an AFTER INSERT/UPDATE/DELETE trigger that
    maintains `memory_store_fts`. In SQLite a trigger that raises aborts the
    statement that fired it, so a search index that cannot be opened takes the
    durable row down with it — the wrong way round, because the index is
    derived and rebuildable from the very table it indexes.

    On ANY SQLite error from the write: roll back, rebuild the index from the
    base table, and retry once. Whatever goes wrong, the ORIGINAL error is
    what escapes if the retry does not succeed, so a broken database is never
    reported as a successful write.

    Deliberately not pattern-matching the error text. The same corrupt state
    reports `vtable constructor failed` on one SQLite build, `SQL logic error`
    on another and `database disk image is malformed` on a third, so a
    string filter works on the machine it was written on and nowhere else —
    which is precisely how the first attempt at this shipped a fix that passed
    locally and did nothing in CI. Probing the index instead is not better: a
    MATCH query can still succeed on a half-built index. Rebuilding is
    idempotent, lossless and cheap, and this is an error path that should
    essentially never run, so the honest trade is a possible wasted rebuild on
    an unrelated error in exchange for never losing a row to a cache.

    THAT LAST TRADE WAS THE BUG, and it took five CI failures to see it.
    "Rebuild on any error" is not a cheap idempotent repair — it is five
    `DROP TABLE` statements plus a `CREATE VIRTUAL TABLE` against a file that
    every other thread in the process also has open, executed on a REQUEST
    path. A write that failed only because the file was momentarily busy
    (`database is locked` after the busy timeout, which on a 4-vCPU CI runner
    is routine) therefore escalated to destructive DDL, and the DROP is
    exactly what makes some *other* connection's next statement fail with
    `vtable constructor failed`. The recovery path was manufacturing the
    symptom it was written to cure, which is why it survived locally — no
    local run has the contention — and failed on CI five times across five
    different tests, whichever one happened to be writing memory.

    So the rebuild is now conditional on the index actually being broken:
    `fts_index_intact` checks structurally (the vtable entry plus all four
    shadow tables) rather than by parsing the error, which keeps the property
    this function exists for — a genuinely half-built index still gets rebuilt
    and the row still lands — while a transient failure no longer costs the
    file five drops. An intact index means the error was not the index, so the
    write is simply retried, which is the correct response to contention.
    """
    try:
        conn.execute(sql, params)
        return
    except (sqlite3.OperationalError, sqlite3.DatabaseError) as first:
        try:
            conn.rollback()
        except sqlite3.Error:
            # A rollback on a connection with no open transaction is not
            # interesting; whatever the write needs is what has to work.
            pass
        from app.services.memory_schema import fts_index_intact, rebuild_fts_index

        # A whole index means this error was never about the index, so do not
        # do DDL about it. The write is retried either way.
        if fts_index_intact(conn) and _retry_write(conn, sql, params):
            return
        if not rebuild_fts_index(conn):
            raise first
        if not _retry_write(conn, sql, params):
            raise first


def _retry_write(conn: sqlite3.Connection, sql: str, params: tuple[object, ...]) -> bool:
    """One more attempt at the write. False means it failed again."""
    try:
        conn.execute(sql, params)
    except (sqlite3.OperationalError, sqlite3.DatabaseError):
        return False
    return True


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


