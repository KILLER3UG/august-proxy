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


@router.get('')
async def list_sessions():
    """List all sessions."""
    sessions = memory_store.list_sessions()
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
