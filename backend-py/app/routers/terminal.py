"""Terminal session API routes (legacy /api/terminal/* endpoints).

Delegates to the same terminal_service as /ui/terminal/* routes.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from app.lib.camel_model import CamelModel

from app.services.workbench import terminal_service

router = APIRouter(prefix="/api/terminal")


class TerminalCreate(CamelModel):
    name: str = "default"
    cwd: str = ""
    shell: str = ""


class TerminalWrite(CamelModel):
    data: str


@router.post("")
async def create_terminal(body: TerminalCreate):
    """Create a new terminal session."""
    session = await terminal_service.create_terminal_session({
        "title": body.name,
        "cwd": body.cwd or None,
    })
    return session


@router.get("")
async def list_terminals():
    """List all terminal sessions."""
    return {"sessions": terminal_service.list_terminal_sessions()}


@router.get("/{session_id}")
async def get_terminal(session_id: str):
    """Get a terminal session by ID."""
    try:
        return terminal_service.read_terminal_buffer(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Terminal session not found")


@router.delete("/{session_id}")
async def delete_terminal(session_id: str):
    """Delete a terminal session."""
    if not terminal_service.close_terminal_session(session_id):
        raise HTTPException(status_code=404, detail="Terminal session not found")
    return {"status": "ok"}


@router.post("/{session_id}/write")
async def write_terminal(session_id: str, body: TerminalWrite):
    """Write data to a terminal session."""
    result = await terminal_service.write_terminal_input(session_id, body.data)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.get("/{session_id}/read")
async def read_terminal(session_id: str):
    """Read output from a terminal session."""
    try:
        return terminal_service.read_terminal_buffer(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")
