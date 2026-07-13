"""Session management API routes.

Port of backend/services/storage/session-store.js.
"""

from __future__ import annotations
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services import memory_store

router = APIRouter(prefix='/api/sessions')


class MessageCreate(BaseModel):
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
    """Delete a session and its messages."""
    if not memory_store.delete_session_record(sessionId):
        raise HTTPException(status_code=404, detail='Session not found')
    memory_store.delete_session_messages(sessionId)
    return {'status': 'ok'}


@router.get('/{sessionId}/messages')
async def getSessionMessages(sessionId: str):
    """Get messages for a session."""
    messages = memory_store.get_messages(sessionId)
    return {'messages': messages}


@router.post('/{sessionId}/messages')
async def addMessage(sessionId: str, body: MessageCreate):
    """Add a message to a session."""
    msgId = memory_store.save_message(sessionId, body.role, body.content)
    return {'id': msgId, 'status': 'ok'}
