"""Session management API routes.

Port of backend/services/storage/session-store.js.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import memory_store

router = APIRouter(prefix="/api/sessions")


class MessageCreate(BaseModel):
    role: str
    content: str


@router.get("")
async def list_sessions():
    """List all sessions."""
    sessions = memory_store.list_sessions()
    return {"sessions": sessions}


@router.post("")
async def create_session():
    """Create a new session."""
    session_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat() + "Z"
    session = {
        "id": session_id,
        "title": "New Session",
        "startedAt": now,
        "messageCount": 0,
        "provider": "",
        "model": "",
        "isArchived": False,
    }
    memory_store.save_session(session)
    return session


@router.get("/{session_id}")
async def get_session(session_id: str):
    """Get a session by ID."""
    session = memory_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.delete("/{session_id}")
async def delete_session(session_id: str):
    """Delete a session and its messages."""
    if not memory_store.delete_session_record(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    memory_store.delete_session_messages(session_id)
    return {"status": "ok"}


@router.get("/{session_id}/messages")
async def get_session_messages(session_id: str):
    """Get messages for a session."""
    messages = memory_store.get_messages(session_id)
    return {"messages": messages}


@router.post("/{session_id}/messages")
async def add_message(session_id: str, body: MessageCreate):
    """Add a message to a session."""
    msg_id = memory_store.save_message(session_id, body.role, body.content)
    return {"id": msg_id, "status": "ok"}
