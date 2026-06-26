"""Terminal session API routes.

Port of backend/services/workbench/terminal-service.js + august-terminal.js.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.workbench import terminal_service

router = APIRouter(prefix="/api/terminal")


class TerminalCreate(BaseModel):
    name: str = "default"
    cwd: str = ""
    shell: str = ""


class TerminalWrite(BaseModel):
    data: str


@router.post("")
async def create_terminal(body: TerminalCreate):
    """Create a new terminal session."""
    session = await terminal_service.create_session(
        name=body.name,
        cwd=body.cwd or None,
        shell=body.shell or None,
    )
    return session


@router.get("")
async def list_terminals():
    """List all terminal sessions."""
    return {"sessions": terminal_service.list_sessions()}


@router.get("/{session_id}")
async def get_terminal(session_id: str):
    """Get a terminal session by ID."""
    session = terminal_service.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Terminal session not found")
    return session


@router.delete("/{session_id}")
async def delete_terminal(session_id: str):
    """Delete a terminal session."""
    if not await terminal_service.close_session(session_id):
        raise HTTPException(status_code=404, detail="Terminal session not found")
    return {"status": "ok"}


@router.post("/{session_id}/write")
async def write_terminal(session_id: str, body: TerminalWrite):
    """Write data to a terminal session."""
    result = await terminal_service.write_stdin(session_id, body.data)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.get("/{session_id}/read")
async def read_terminal(session_id: str):
    """Read output from a terminal session."""
    output = await terminal_service.read_stdout(session_id)
    return {"output": output}


@router.post("/{session_id}/resize")
async def resize_terminal(session_id: str, cols: int = 80, rows: int = 24):
    """Resize the terminal."""
    await terminal_service.resize(session_id, cols, rows)
    return {"status": "ok"}
