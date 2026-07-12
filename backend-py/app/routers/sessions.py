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
async def listSessions():
    """List all sessions."""
    sessions = memory_store.listSessions()
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
    memory_store.saveSession(session)
    return session


@router.get('/{sessionId}')
async def getSession(sessionId: str):
    """Get a session by ID."""
    session = memory_store.getSession(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    return session


@router.delete('/{sessionId}')
async def deleteSession(sessionId: str):
    """Delete a session and its messages."""
    if not memory_store.deleteSessionRecord(sessionId):
        raise HTTPException(status_code=404, detail='Session not found')
    memory_store.deleteSessionMessages(sessionId)
    return {'status': 'ok'}


@router.get('/{sessionId}/messages')
async def getSessionMessages(sessionId: str):
    """Get messages for a session."""
    messages = memory_store.getMessages(sessionId)
    return {'messages': messages}


@router.post('/{sessionId}/messages')
async def addMessage(sessionId: str, body: MessageCreate):
    """Add a message to a session."""
    msgId = memory_store.saveMessage(sessionId, body.role, body.content)
    return {'id': msgId, 'status': 'ok'}
