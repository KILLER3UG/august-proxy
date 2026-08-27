"""Key-value memory blob + FTS search domain."""
from __future__ import annotations

import json
import re

from app.services.memory_conn import conn as _conn
from app.services.memory_schema import ensure_schema
from app.services.memory_store.wire import _json
from app.type_aliases import JsonValue


def init() -> None:
    """Create all tables on first use (migrates camel→snake if needed)."""
    ensure_schema(_conn())


def save_internal(key: str, value: JsonValue) -> None:
    """Save a key-value pair to the internal KV store.

    Renamed from ``save_memory`` (plan §3.3 M2): the KV store is machine
    state / registry data, not user-visible memory. Durable memory goes
    through the facts store (``save_fact``); this name makes misuse obvious.
    """
    conn = _conn()
    conn.execute(
        "INSERT OR REPLACE INTO memory_store (key, value, updated_at) VALUES (?, ?, datetime('now'))",
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
    """Write machine state to ``internal_state`` (plan §3.2 M1).

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
    conn.commit()


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


