"""
UI Terminal routes — /ui/terminal/* endpoints for the frontend terminal UI.

Port of the inline terminal routes in backend/index.js.

Supports:
- REST: sessions CRUD, buffer, input, resize, command, approve
- WebSocket: /ui/terminal/connect for live PTY I/O
"""
from __future__ import annotations
from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from app.services.workbench import terminalService
router = APIRouter(prefix='/api/terminal')

class CreateSessionBody(BaseModel):
    title: str = 'Terminal'
    cwd: str = ''
    command: str = ''
    approvedInteractive: bool = False
    cols: int = 80
    rows: int = 24

class InputBody(BaseModel):
    id: str
    input: str
    approved: bool = False

class ResizeBody(BaseModel):
    sessionId: str
    cols: int = 80
    rows: int = 24

class CommandBody(BaseModel):
    command: str
    cwd: str = ''
    approved: bool = False
    reason: str = ''
    timeoutMs: int = 30000

class ApproveBody(BaseModel):
    requestId: str
    approve: bool = True

@router.get('/sessions')
async def getSessions():
    """List all terminal sessions and pending approvals."""
    return {'sessions': terminalService.list_terminal_sessions(), 'approvals': terminalService.list_terminal_approvals()}

@router.post('/sessions')
async def createSession(body: CreateSessionBody | None=None):
    """Create a new terminal session."""
    params = {}
    if body:
        params = body.model_dump(exclude_none=True)
    return await terminalService.create_terminal_session(params)

@router.get('/buffer')
async def getBuffer(id: str=Query(...)):
    """Get the terminal buffer for a session."""
    try:
        return terminalService.read_terminal_buffer(id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

@router.post('/input')
async def writeInput(body: InputBody):
    """Write input to a terminal session."""
    result = await terminalService.write_terminal_input(body.id, body.input, body.approved)
    if 'error' in result:
        raise HTTPException(status_code=400, detail=result['error'])
    return result

@router.post('/resize')
async def resizeTerminal(body: ResizeBody):
    """Resize a terminal session."""
    return await terminalService.resize_terminal_session(body.sessionId, body.cols, body.rows)

@router.post('/command')
async def runCommand(body: CommandBody):
    """Submit a one-shot command for execution."""
    result = await terminalService.submit_terminal_command(body.model_dump())
    if 'error' in result:
        raise HTTPException(status_code=400, detail=result['error'])
    return result

@router.post('/approve')
async def approveRequest(body: ApproveBody):
    """Approve or reject a pending terminal request."""
    result = await terminalService.approve_terminal_request(body.requestId, body.approve)
    if 'error' in result:
        raise HTTPException(status_code=404, detail=result['error'])
    return result

@router.delete('/sessions/{session_id}')
async def deleteSession(sessionId: str):
    """Close and delete a terminal session."""
    if not terminalService.close_terminal_session(sessionId):
        raise HTTPException(status_code=404, detail='Session not found')
    return {'deleted': True}

@router.websocket('/connect')
async def terminalWebsocket(websocket: WebSocket, id: str=Query(...)):
    """WebSocket connection for live terminal I/O."""
    await websocket.accept()
    try:
        await terminalService.handle_terminal_connection(websocket, id)
    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await websocket.close(code=1011)
        except Exception:
            pass