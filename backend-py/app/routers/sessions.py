"""Session management API routes.

Port of backend/services/storage/session-store.js.

Request body ``MessageCreate`` inherits :class:`CamelModel` so internals are
snake_case while JSON from the frontend stays camelCase.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from app.models.camel_base import CamelModel
from app.services import memory_store

router = APIRouter(prefix='/api/sessions')


class MessageCreate(CamelModel):
    """Session message body. Internals are snake_case; JSON stays camelCase.

    ``blocks`` / ``structured`` are the optional durable transcript payload
    (migration 047). Both are additive: a client that only knows role +
    content still works, and the structured fields are what a restore needs to
    rebuild tool calls, reasoning, attachments and todos instead of flat text.

    ``clientMessageId`` (migration 048) is the caller's own message id. When
    present the write is an UPSERT keyed on it, so a replayed send converges
    on one row instead of appending a duplicate bubble.
    """

    role: str
    content: str
    blocks: list[dict[str, object]] | None = None
    structured: dict[str, object] | None = None
    client_message_id: str | None = None


class MessageEnrichment(CamelModel):
    """Structured-payload-only write for a message the client already owns.

    Deliberately has no ``role`` / ``content``: enrichment must never rewrite
    the FTS-indexed text of a row, only the ``blocks_json`` beside it.
    """

    client_message_id: str
    blocks: list[dict[str, object]] | None = None
    structured: dict[str, object] | None = None


class SessionPatch(CamelModel):
    """Partial session update. Absent fields are unchanged, not cleared."""

    is_archived: bool | None = None


@router.get('/search')
async def search_sessions(q: str, limit: int = 20):
    """Full-text search across conversation messages (C8).

    Uses the ``messages_fts`` FTS5 index (kept in sync by triggers).
    Returns per-session hits with the matching snippet, newest first.
    """
    from app.json_narrowing import as_str

    query = (q or '').strip()
    if not query:
        return {'results': []}
    if limit < 1 or limit > 100:
        limit = 20
    try:
        conn = memory_store._conn()
        # FTS5 MATCH with a quoted-phrase + prefix fallback for multi-word
        # queries ("build" matches "building"; phrase quotes keep exactness).
        match_expr = f'"{query.replace(chr(34), "")}"*'
        rows = conn.execute(
            """
            SELECT m.session_id, m.role, m.content, s.title,
                   snippet(messages_fts, 0, '[', ']', '…', 24) AS snip,
                   m.id AS message_id
            FROM messages_fts f
            JOIN messages m ON m.id = f.rowid
            LEFT JOIN sessions s ON s.id = m.session_id
            WHERE messages_fts MATCH ?
            ORDER BY m.id DESC
            LIMIT ?
            """,
            (match_expr, limit),
        ).fetchall()
        results = []
        seen: set[str] = set()
        for r in rows:
            sid = as_str(r['session_id'], '')
            if not sid or sid in seen:
                continue
            seen.add(sid)
            results.append(
                {
                    'sessionId': sid,
                    'title': as_str(r['title'], '') or 'Untitled conversation',
                    'role': as_str(r['role'], ''),
                    'snippet': as_str(r['snip'], '') or as_str(r['content'], '')[:240],
                    'messageId': r['message_id'],
                }
            )
            if len(results) >= limit:
                break
        return {'results': results}
    except Exception as exc:
        return {'results': [], 'error': str(exc)}


@router.get('')
async def list_sessions(
    status: str = '',
    agentType: str = '',
    limit: int = 0,
    order: str = 'desc',
):
    """List all sessions.

    The legacy frontend client sends status/agentType/limit/order — they were
    silently dropped before (audit finding). limit and order are applied;
    status/agentType are accepted for compatibility (the sessions table has
    no such columns today — the Observability UI uses /api/monitoring/*).
    """
    sessions = memory_store.list_sessions()
    if order and str(order).lower() in ('asc', 'ascending'):
        sessions = list(reversed(sessions))
    if limit and int(limit) > 0:
        sessions = sessions[: int(limit)]
    return {'sessions': sessions}


@router.post('')
async def createSession():
    """Create a new session."""
    sessionId = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    session = {
        'id': sessionId,
        'title': 'New Session',
        'startedAt': now,
        'messageCount': 0,
        'provider': '',
        'model': '',
        'isArchived': False,
    }
    memory_store.save_session(session)
    return session


@router.get('/{sessionId}')
async def get_session(sessionId: str):
    """Get a session by ID."""
    session = memory_store.get_session(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    return session


@router.patch('/{sessionId}')
async def patch_session(sessionId: str, body: SessionPatch):
    """Update a session's durable flags.

    ``isArchived`` is the only one today, and it is written through the single
    store authority so the legacy action route and this one cannot diverge.
    """
    if body.is_archived is None:
        raise HTTPException(400, detail='No supported fields provided')
    updated = memory_store.set_session_archived(sessionId, bool(body.is_archived))
    if not updated:
        raise HTTPException(status_code=404, detail='Session not found')
    return updated


@router.delete('/{sessionId}')
async def deleteSession(sessionId: str):
    """Delete a session and all dependent rows (messages, timeline, …)."""
    result = memory_store.delete_session_cascade(sessionId)
    if not result.get('ok'):
        raise HTTPException(status_code=404, detail='Session not found')
    return {
        'status': 'ok',
        'messages': result.get('messages', 0),
        'children': result.get('children', {}),
    }


@router.get('/{sessionId}/messages')
async def getSessionMessages(
    sessionId: str,
    limit: int | None = None,
    offset: int = 0,
):
    """Get messages for a session.

    SQLite work runs on a worker thread so the event loop stays free.
    Optional ``limit`` / ``offset`` support paged loads.
    """
    messages = await memory_store.get_messages_async(
        sessionId, limit=limit, offset=offset
    )
    return {
        'messages': messages,
        'count': memory_store.count_messages(sessionId) if limit is not None else len(messages),
    }


@router.post('/{sessionId}/messages')
async def addMessage(sessionId: str, body: MessageCreate):
    """Add a message to a session.

    Structured transcript fields (``blocks`` / ``structured``) are stored
    alongside the text in ``messages.blocks_json`` so a later restore can
    rebuild the message. Omitting them writes a legacy text-only row.

    With ``clientMessageId`` (migration 048) the write is idempotent: the row
    is found by that id, or by an identical unclaimed role+content row, so the
    desktop can re-send a message (or replay after a reconnect) without
    duplicating the bubble in the restored chat.
    """
    payload: dict[str, object] = dict(body.structured or {})
    if body.blocks is not None:
        payload['blocks'] = body.blocks
    client_id = memory_store.normalize_client_message_id(body.client_message_id)
    if client_id:
        result = memory_store.upsert_client_message(
            sessionId, client_id, body.role, body.content, payload or None
        )
        return {'id': result['id'], 'status': 'ok', 'write': result['status']}
    msgId = memory_store.save_message(
        sessionId, body.role, body.content, payload or None
    )
    return {'id': msgId, 'status': 'ok'}


@router.patch('/{sessionId}/messages/enrichment')
@router.put('/{sessionId}/messages/enrichment')
async def enrichMessage(sessionId: str, body: MessageEnrichment):
    """Attach the client-authored structured transcript to one message.

    The rich-transcript sync counterpart to the POST above (migration 048).
    Only ``messages.blocks_json`` is written: ``content`` is never touched, so
    the FTS-indexed text and the session search index stay exactly as the send
    wrote them, and the 048 UPDATE trigger is scoped to those columns so the
    write is FTS-neutral by construction.

    The payload is allow-listed (``STRUCTURED_FIELDS``) and size-capped
    (64 KB encoded per message) before it is stored; trailing blocks are
    dropped to fit rather than storing a timeline that no longer restores.

    Re-sending an identical payload is a no-op (``unchanged: true``), so a
    debounced client can retry freely. PATCH and PUT are the same operation —
    the body replaces the structured payload wholesale, so "merge" semantics
    would be a lie.
    """
    if not memory_store.normalize_client_message_id(body.client_message_id):
        raise HTTPException(400, detail='clientMessageId is required')
    result = memory_store.enrich_client_message(
        sessionId, body.client_message_id, body.blocks, body.structured
    )
    if result.get('ok'):
        return {
            'status': 'ok',
            'messageId': result['id'],
            'clientMessageId': body.client_message_id.strip(),
            'unchanged': bool(result.get('unchanged')),
        }
    reason = str(result.get('reason', ''))
    if reason == 'not_found':
        raise HTTPException(404, detail='Message not found for clientMessageId')
    if reason == 'too_large':
        raise HTTPException(413, detail='Structured payload exceeds the size cap')
    raise HTTPException(400, detail='No supported structured fields provided')
