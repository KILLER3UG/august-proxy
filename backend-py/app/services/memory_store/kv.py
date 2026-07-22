"""Key-value memory blob + FTS search domain."""
from __future__ import annotations

import json
import sqlite3
from typing import cast

from app.services.memory_conn import conn as _conn
from app.services.memory_schema import ensure_schema
from app.services.memory_store.wire import _json, _row_as_wire
from app.type_aliases import JsonValue, MemoryEntryDict


def init() -> None:
    """Create all tables on first use (migrates camel→snake if needed)."""
    ensure_schema(_conn())


def save_memory(key: str, value: JsonValue) -> None:
    """Save a key-value pair to memory."""
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


def delete_memory(key: str) -> bool:
    """Delete a memory key. Returns True if it existed."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM memory_store WHERE key = ?', (key,))
    conn.commit()
    return cursor.rowcount > 0


def list_memory(pattern: str = '%') -> list[MemoryEntryDict]:
    """List memory entries with optional key pattern matching."""
    conn = _conn()
    rows = conn.execute(
        'SELECT key, value, updated_at FROM memory_store WHERE key LIKE ? ORDER BY updated_at DESC',
        (pattern,),
    ).fetchall()
    results: list[MemoryEntryDict] = []
    for r in rows:
        try:
            val = json.loads(r['value'])
        except (json.JSONDecodeError, TypeError):
            val = r['value']
        wire = _row_as_wire(r)
        wire['value'] = val
        results.append(cast(MemoryEntryDict, wire))
    return results


def _fts_match_query(query: str) -> str:
    """Build a safe FTS5 MATCH expression from free text (prefix OR tokens)."""
    tokens = [w for w in query.strip().split() if w]
    if not tokens:
        return ''
    # Quote tokens so punctuation does not break MATCH parsing.
    return ' OR '.join(f'"{t.replace(chr(34), "")}"*' for t in tokens if t.replace('"', ''))


def search_memory(query: str, *, limit: int = 20, value_max_chars: int | None = 4000) -> list[MemoryEntryDict]:
    """Full-text search across memory keys and values.

    Uses the FTS5 table (columns ``key``, ``value``) via table-level MATCH —
    not a nonexistent ``content`` column. Falls back to LIKE only if FTS fails.
    Large ``value`` blobs are truncated for search results when ``value_max_chars``
    is set (pass ``None`` for full values).
    """
    if not query or not query.strip():
        return []
    conn = _conn()
    lim = max(1, min(int(limit), 100))
    try:
        ftsQuery = _fts_match_query(query)
        if not ftsQuery:
            return []
        # Table-level MATCH (correct for fts5 key,value content=memory_store).
        rows = conn.execute(
            'SELECT key, value FROM memory_store_fts WHERE memory_store_fts MATCH ? '
            'ORDER BY rank LIMIT ?',
            (ftsQuery, lim),
        ).fetchall()
        results: list[MemoryEntryDict] = []
        for r in rows:
            try:
                val = json.loads(r['value'])
            except (json.JSONDecodeError, TypeError):
                val = r['value']
            if value_max_chars is not None and isinstance(val, str) and len(val) > value_max_chars:
                val = val[:value_max_chars] + '…'
            results.append(cast(MemoryEntryDict, {'key': r['key'], 'value': val}))
        return results
    except sqlite3.OperationalError:
        likeQuery = f'%{query.strip()}%'
        rows = conn.execute(
            'SELECT key, value FROM memory_store WHERE key LIKE ? OR value LIKE ? LIMIT ?',
            (likeQuery, likeQuery, lim),
        ).fetchall()
        results = []
        for r in rows:
            try:
                val = json.loads(r['value'])
            except (json.JSONDecodeError, TypeError):
                val = r['value']
            results.append(cast(MemoryEntryDict, {'key': r['key'], 'value': val}))
        return results


