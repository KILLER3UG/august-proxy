"""Session management API routes.

Port of backend/services/storage/session-store.js.
"""
from __future__ import annotations
import uuid
from datetime import datetime
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services import memoryStore
router = APIRouter(prefix='/api/sessions')

class MessageCreate(BaseModel):
    role: str
    content: str

@router.get('')
async def listSessions():
    """List all sessions."""
    sessions = memoryStore.listSessions()
    return {'sessions': sessions}

@router.post('')
async def createSession():
    """Create a new session."""
    sessionId = str(uuid.uuid4())
    now = datetime.utcnow().isoformat() + 'Z'
    session = {'id': sessionId, 'title': 'New Session', 'startedAt': now, 'messageCount': 0, 'provider': '', 'model': '', 'isArchived': False}
    memoryStore.saveSession(session)
    return session

@router.get('/{sessionId}')
async def getSession(sessionId: str):
    """Get a session by ID."""
    session = memoryStore.getSession(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    return session

@router.delete('/{sessionId}')
async def deleteSession(sessionId: str):
    """Delete a session and its messages."""
    if not memoryStore.deleteSessionRecord(sessionId):
        raise HTTPException(status_code=404, detail='Session not found')
    memoryStore.deleteSessionMessages(sessionId)
    return {'status': 'ok'}

@router.get('/{sessionId}/messages')
async def getSessionMessages(sessionId: str):
    """Get messages for a session."""
    messages = memoryStore.getMessages(sessionId)
    return {'messages': messages}

@router.post('/{sessionId}/messages')
async def addMessage(sessionId: str, body: MessageCreate):
    """Add a message to a session."""
    msgId = memoryStore.saveMessage(sessionId, body.role, body.content)
    return {'id': msgId, 'status': 'ok'}