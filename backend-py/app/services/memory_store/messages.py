"""Session messages domain (hot path for chat open / pagination)."""
from __future__ import annotations
import asyncio
import json
from typing import cast
from app.json_narrowing import as_int
from app.services.memory_conn import conn as _conn
from app.services.memory_store.wire import _json, _row_as_wire
from app.type_aliases import JsonValue, MessageDict

def save_message(sessionId: str, role: str, content: JsonValue) -> int:
    """Save a message to a session.

    FTS index ``messages_fts`` is kept in sync via SQLite content-sync triggers
    created in ``memory_schema`` (insert/update/delete).
    """
    conn = _conn()
    cursor = conn.execute(
        'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
        (sessionId, role, _json(content)),
    )
    conn.commit()
    return as_int(cursor.lastrowid)


def get_messages(
    sessionId: str,
    *,
    limit: int | None = None,
    offset: int = 0,
    before_id: int | None = None,
) -> list[MessageDict]:
    """Get messages for a session, with optional pagination.

    Default (no limit) returns all messages — historical API contract.
    Pass ``limit`` / ``offset`` / ``before_id`` for paged loads.
    """
    conn = _conn()
    if before_id is not None:
        sql = 'SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC'
        params: list[object] = [sessionId, before_id]
        if limit is not None and limit > 0:
            sql += f' LIMIT {int(limit)}'
        rows = list(conn.execute(sql, params).fetchall())
        rows.reverse()
    else:
        sql = 'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, id'
        params = [sessionId]
        if limit is not None and limit > 0:
            sql += f' LIMIT {int(limit)}'
            if offset and offset > 0:
                sql += f' OFFSET {int(offset)}'
        elif offset and offset > 0:
            # OFFSET without LIMIT is undefined in older SQLite — use large limit
            sql += f' LIMIT -1 OFFSET {int(offset)}'
        rows = conn.execute(sql, params).fetchall()
    results: list[MessageDict] = []
    for r in rows:
        msg = cast(MessageDict, _row_as_wire(r))
        try:
            msg['content'] = json.loads(msg['content']) if isinstance(msg['content'], str) else msg['content']
        except (json.JSONDecodeError, TypeError):
            pass
        results.append(msg)
    return results


def count_messages(sessionId: str) -> int:
    """Count messages for a session (pagination helpers)."""
    conn = _conn()
    row = conn.execute(
        'SELECT COUNT(*) FROM messages WHERE session_id = ?', (sessionId,)
    ).fetchone()
    return int(row[0]) if row else 0


async def get_messages_async(
    sessionId: str,
    *,
    limit: int | None = None,
    offset: int = 0,
    before_id: int | None = None,
) -> list[MessageDict]:
    """Async wrapper: run sync SQLite ``get_messages`` on a worker thread.

    Avoids blocking the asyncio event loop during message list loads.
    """

    return await asyncio.to_thread(
        get_messages,
        sessionId,
        limit=limit,
        offset=offset,
        before_id=before_id,
    )


def delete_session_messages(sessionId: str) -> int:
    """Delete all messages for a session."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM messages WHERE session_id = ?', (sessionId,))
    conn.commit()
    return cursor.rowcount


