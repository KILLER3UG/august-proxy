"""
UI Terminal routes — /ui/terminal/* endpoints for the frontend terminal UI.

Port of the inline terminal routes in backend/index.js.

Supports:
- REST: sessions CRUD, buffer, input, resize, command, approve
- WebSocket: /ui/terminal/connect for live PTY I/O
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from app.lib.camel_model import CamelModel

from app.services.workbench import terminal_service

router = APIRouter(prefix="/ui/terminal")


class CreateSessionBody(CamelModel):
    title: str = "Terminal"
    cwd: str = ""
    command: str = ""
    approved_interactive: bool = False
    cols: int = 80
    rows: int = 24


class InputBody(CamelModel):
    id: str
    input: str
    approved: bool = False


class ResizeBody(CamelModel):
    sessionId: str
    cols: int = 80
    rows: int = 24


class CommandBody(CamelModel):
    command: str
    cwd: str = ""
    approved: bool = False
    reason: str = ""
    timeoutMs: int = 30000


class ApproveBody(CamelModel):
    requestId: str
    approve: bool = True


# ── REST endpoints ───────────────────────────────────────────────────


@router.get("/sessions")
async def get_sessions():
    """List all terminal sessions and pending approvals."""
    return {
        "sessions": terminal_service.list_terminal_sessions(),
        "approvals": terminal_service.list_terminal_approvals(),
    }


@router.post("/sessions")
async def create_session(body: CreateSessionBody | None = None):
    """Create a new terminal session."""
    params = {}
    if body:
        params = body.model_dump(exclude_none=True)
    return await terminal_service.create_terminal_session(params)


@router.get("/buffer")
async def get_buffer(id: str = Query(...)):
    """Get the terminal buffer for a session."""
    try:
        return terminal_service.read_terminal_buffer(id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/input")
async def write_input(body: InputBody):
    """Write input to a terminal session."""
    result = await terminal_service.write_terminal_input(body.id, body.input, body.approved)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.post("/resize")
async def resize_terminal(body: ResizeBody):
    """Resize a terminal session."""
    return await terminal_service.resize_terminal_session(body.sessionId, body.cols, body.rows)


@router.post("/command")
async def run_command(body: CommandBody):
    """Submit a one-shot command for execution."""
    result = await terminal_service.submit_terminal_command(body.model_dump())
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.post("/approve")
async def approve_request(body: ApproveBody):
    """Approve or reject a pending terminal request."""
    result = await terminal_service.approve_terminal_request(body.requestId, body.approve)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Close and delete a terminal session."""
    if not terminal_service.close_terminal_session(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return {"deleted": True}


# ── WebSocket endpoint ───────────────────────────────────────────────


@router.websocket("/connect")
async def terminal_websocket(websocket: WebSocket, id: str = Query(...)):
    """WebSocket connection for live terminal I/O."""
    await websocket.accept()
    try:
        await terminal_service.handle_terminal_connection(websocket, id)
    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
