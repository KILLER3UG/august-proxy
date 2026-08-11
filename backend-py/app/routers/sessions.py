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
    """Session message body. Internals are snake_case; JSON stays camelCase."""

    role: str
    content: str


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
    """Add a message to a session."""
    msgId = memory_store.save_message(sessionId, body.role, body.content)
    return {'id': msgId, 'status': 'ok'}
