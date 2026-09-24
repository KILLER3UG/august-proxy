"""Session messages domain (hot path for chat open / pagination)."""
from __future__ import annotations

import asyncio
import json
from typing import cast

from app.json_narrowing import as_int
from app.services.memory_conn import conn as _conn
from app.services.memory_store.transcript_blocks import (
    MAX_ENRICHMENT_BYTES,
    decode_blocks,
    encode_blocks,
    fit_enrichment,
    sanitize_enrichment,
)
from app.services.memory_store.wire import _json, _row_as_wire
from app.type_aliases import JsonValue, MessageDict

# Longest client identity accepted. The desktop mints `m<epoch>` / `a<epoch>`;
# the bound only exists so a hostile body cannot stuff a megabyte into an
# indexed column.
MAX_CLIENT_MESSAGE_ID_CHARS = 200


def normalize_client_message_id(value: object) -> str | None:
    """Trim + bound a client message id. None when absent/unusable."""
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    return trimmed[:MAX_CLIENT_MESSAGE_ID_CHARS]


def save_message(
    sessionId: str,
    role: str,
    content: JsonValue,
    blocks: JsonValue | None = None,
    client_message_id: str | None = None,
) -> int:
    """Save a message to a session.

    ``blocks`` is the optional structured transcript payload (migration 047):
    a block list, or an object of structured fields. Stored as JSON in
    ``messages.blocks_json``; ``content`` stays the FTS-indexed text.

    ``client_message_id`` (migration 048) is the desktop's own message id, used
    to re-find the same row for a later enrichment write. Prefer
    ``upsert_client_message`` when the id is set — a plain INSERT can produce a
    second row for a replayed client message.

    FTS index ``messages_fts`` is kept in sync via SQLite content-sync triggers
    created in ``memory_schema`` (insert/update/delete). The UPDATE trigger is
    scoped to the indexed columns, so writing ``blocks_json`` alone never
    rewrites the search index.
    """
    conn = _conn()
    source: dict[str, object] = {'role': role, 'content': content}
    if isinstance(blocks, list):
        source['blocks'] = blocks
    elif isinstance(blocks, dict):
        for key, value in blocks.items():
            source[key] = value
    cursor = conn.execute(
        'INSERT INTO messages (session_id, role, content, blocks_json, client_message_id)'
        ' VALUES (?, ?, ?, ?, ?)',
        (
            sessionId,
            role,
            _json(content),
            encode_blocks(source),
            normalize_client_message_id(client_message_id),
        ),
    )
    conn.commit()
    return as_int(cursor.lastrowid)


def upsert_client_message(
    session_id: str,
    client_message_id: str,
    role: str,
    content: JsonValue,
    blocks: JsonValue | None = None,
) -> dict[str, object]:
    """Idempotently write a client-authored message (migration 048).

    Three-step reconciliation, in order, so a replayed POST converges on ONE
    row instead of appending a duplicate bubble to the transcript:

    1. the row already carries this ``client_message_id`` -> update it
       (same id is returned, so the client keeps its identity);
    2. an unclaimed row with the same role + content exists -> ADOPT it by
       stamping the client id on it. This is the case that matters: the
       workbench loop already wrote the user/assistant turn, and inserting
       again would double every bubble in the restored chat;
    3. otherwise insert a new row.

    Returns ``{id, status}`` with status in ``created`` / ``updated`` /
    ``adopted``.
    """
    cid = normalize_client_message_id(client_message_id)
    if not cid:
        raise ValueError('client_message_id required')
    conn = _conn()
    content_text = _json(content)
    source: dict[str, object] = {'role': role, 'content': content}
    if isinstance(blocks, list):
        source['blocks'] = blocks
    elif isinstance(blocks, dict):
        for key, value in blocks.items():
            source[key] = value
    encoded = encode_blocks(source)

    row = conn.execute(
        'SELECT id, blocks_json FROM messages WHERE session_id = ? AND client_message_id = ?',
        (session_id, cid),
    ).fetchone()
    if row is not None:
        mid = as_int(row['id'] if hasattr(row, 'keys') else row[0], 0)
        conn.execute(
            'UPDATE messages SET role = ?, content = ?,'
            ' blocks_json = COALESCE(?, blocks_json) WHERE id = ?',
            (role, content_text, encoded, mid),
        )
        conn.commit()
        return {'id': mid, 'status': 'updated'}

    twin = conn.execute(
        'SELECT id FROM messages WHERE session_id = ? AND role = ? AND content = ?'
        ' AND client_message_id IS NULL ORDER BY id LIMIT 1',
        (session_id, role, content_text),
    ).fetchone()
    if twin is not None:
        mid = as_int(twin['id'] if hasattr(twin, 'keys') else twin[0], 0)
        conn.execute(
            'UPDATE messages SET client_message_id = ?,'
            ' blocks_json = COALESCE(?, blocks_json) WHERE id = ?',
            (cid, encoded, mid),
        )
        conn.commit()
        return {'id': mid, 'status': 'adopted'}

    cursor = conn.execute(
        'INSERT INTO messages (session_id, role, content, blocks_json, client_message_id)'
        ' VALUES (?, ?, ?, ?, ?)',
        (session_id, role, content_text, encoded, cid),
    )
    conn.commit()
    return {'id': as_int(cursor.lastrowid), 'status': 'created'}


def enrich_client_message(
    session_id: str,
    client_message_id: str,
    blocks: object = None,
    structured: object = None,
) -> dict[str, object]:
    """Write the client-authored structured payload onto an existing row.

    Idempotent by construction: an identical payload is a NO-OP
    (``unchanged: True``) rather than a redundant write, so a debounced client
    can re-send freely. Only ``blocks_json`` is written — ``content`` is never
    touched, which is what keeps the row's FTS text and the session search
    index intact (the 048 trigger is scoped to the indexed columns as well).

    Returns ``{ok, id, status, reason?}``. ``ok: False`` carries a ``reason``
    the route maps onto a status code:
      * ``not_found``  — no row for this client id in this session
      * ``empty``      — nothing allow-listed in the payload
      * ``too_large``  — even the reduced payload exceeds the byte budget
    """
    cid = normalize_client_message_id(client_message_id)
    if not cid:
        return {'ok': False, 'reason': 'not_found'}
    fields = sanitize_enrichment(blocks, structured)
    if not fields:
        return {'ok': False, 'reason': 'empty'}
    fitted = fit_enrichment(fields)
    if fitted is None:
        return {'ok': False, 'reason': 'too_large'}
    encoded = json.dumps(fitted, ensure_ascii=False, default=str)

    conn = _conn()
    row = conn.execute(
        'SELECT id, blocks_json FROM messages WHERE session_id = ? AND client_message_id = ?',
        (session_id, cid),
    ).fetchone()
    if row is None:
        return {'ok': False, 'reason': 'not_found'}
    mid = as_int(row['id'] if hasattr(row, 'keys') else row[0], 0)
    current = row['blocks_json'] if hasattr(row, 'keys') else row[1]
    # Compare decoded payloads, not the raw string: key order or a
    # re-serialization of the same timeline must not re-write the row.
    if isinstance(current, str) and decode_blocks(current) == decode_blocks(encoded):
        return {'ok': True, 'id': mid, 'status': 'ok', 'unchanged': True}
    conn.execute('UPDATE messages SET blocks_json = ? WHERE id = ?', (encoded, mid))
    conn.commit()
    return {'ok': True, 'id': mid, 'status': 'ok', 'unchanged': False}


def enrichment_byte_budget() -> int:
    """Exposed for the route/tests — the per-message byte cap (048)."""
    return MAX_ENRICHMENT_BYTES


def get_messages(
    sessionId: str,
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
        # 047: merge the structured transcript payload (blocks + thinking /
        # tools / attachments / todos …) onto the wire message. A NULL
        # blocks_json is a legacy text-only row and stays exactly as it was.
        wire = cast('dict[str, object]', msg)
        structured = decode_blocks(wire.pop('blocksJson', None))
        if structured:
            wire.update(structured)
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


