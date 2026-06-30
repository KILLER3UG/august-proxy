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
    sessions = memoryStore.list_sessions()
    return {'sessions': sessions}

@router.post('')
async def createSession():
    """Create a new session."""
    sessionId = str(uuid.uuid4())
    now = datetime.utcnow().isoformat() + 'Z'
    session = {'id': sessionId, 'title': 'New Session', 'startedAt': now, 'messageCount': 0, 'provider': '', 'model': '', 'isArchived': False}
    memoryStore.save_session(session)
    return session

@router.get('/{session_id}')
async def getSession(sessionId: str):
    """Get a session by ID."""
    session = memoryStore.get_session(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    return session

@router.delete('/{session_id}')
async def deleteSession(sessionId: str):
    """Delete a session and its messages."""
    if not memoryStore.delete_session_record(sessionId):
        raise HTTPException(status_code=404, detail='Session not found')
    memoryStore.delete_session_messages(sessionId)
    return {'status': 'ok'}

@router.get('/{session_id}/messages')
async def getSessionMessages(sessionId: str):
    """Get messages for a session."""
    messages = memoryStore.get_messages(sessionId)
    return {'messages': messages}

@router.post('/{session_id}/messages')
async def addMessage(sessionId: str, body: MessageCreate):
    """Add a message to a session."""
    msgId = memoryStore.save_message(sessionId, body.role, body.content)
    return {'id': msgId, 'status': 'ok'}