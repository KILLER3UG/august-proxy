"""Terminal session API routes.

Port of backend/services/workbench/terminal-service.js + august-terminal.js.
Manages interactive terminal sessions via PTY.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/terminal")

# In-memory terminal sessions
_sessions: dict[str, dict[str, Any]] = {}


class TerminalCreate(BaseModel):
    name: str = "default"
    cwd: str = ""
    shell: str = ""


@router.post("")
async def create_terminal(body: TerminalCreate):
    """Create a new terminal session."""
    import uuid
    session_id = f"term_{uuid.uuid4().hex[:8]}"
    session = {
        "id": session_id,
        "name": body.name or "default",
        "cwd": body.cwd or "",
        "shell": body.shell or "",
        "status": "created",
        "createdAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    }
    _sessions[session_id] = session
    return session


@router.get("")
async def list_terminals():
    """List all terminal sessions."""
    return {"sessions": list(_sessions.values())}


@router.get("/{session_id}")
async def get_terminal(session_id: str):
    """Get a terminal session by ID."""
    session = _sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Terminal session not found")
    return session


@router.delete("/{session_id}")
async def delete_terminal(session_id: str):
    """Delete a terminal session."""
    if session_id not in _sessions:
        raise HTTPException(status_code=404, detail="Terminal session not found")
    del _sessions[session_id]
    return {"status": "ok"}


@router.post("/{session_id}/write")
async def write_terminal(session_id: str, data: str):
    """Write data to a terminal session (stub — real PTY requires node-pty or similar)."""
    session = _sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Terminal session not found")
    return {"status": "written", "message": "Terminal write requires PTY implementation"}
