"""
Terminal routes — /api/terminal/* for the frontend terminal UI.

Supports:
- REST: sessions CRUD, buffer, input, resize, command, approve
- WebSocket: /api/terminal/connect for live PTY I/O

Request bodies inherit :class:`CamelModel` so internals are snake_case while
JSON from the frontend stays camelCase. Service layer still expects camelCase
keys on dumped dicts — use ``model_dump(by_alias=True)`` at that boundary.
"""

from __future__ import annotations
from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from app.models.camel_base import CamelModel
from app.services.workbench import terminal_service

router = APIRouter(prefix='/api/terminal')


class CreateSessionBody(CamelModel):
    """Terminal session create body. Internals snake_case; JSON camelCase."""

    title: str = 'Terminal'
    cwd: str = ''
    command: str = ''
    # True = real interactive shell (default). False = gate every keystroke.
    approved_interactive: bool = True
    cols: int = 80
    rows: int = 24


class OpenExternalBody(CamelModel):
    """Open a real OS terminal window in the given working directory."""

    cwd: str = ''


class InputBody(CamelModel):
    """Terminal input body."""

    id: str
    input: str
    approved: bool = False


class ResizeBody(CamelModel):
    """Terminal resize body."""

    session_id: str
    cols: int = 80
    rows: int = 24


class CommandBody(CamelModel):
    """One-shot command body."""

    command: str
    cwd: str = ''
    approved: bool = False
    reason: str = ''
    timeout_ms: int = 30000


class ApproveBody(CamelModel):
    """Approval body."""

    request_id: str
    approve: bool = True


@router.get('/sessions')
async def getSessions():
    """List all terminal sessions and pending approvals."""
    return {'sessions': terminal_service.listTerminalSessions(), 'approvals': terminal_service.listTerminalApprovals()}


@router.post('/sessions')
async def createSession(body: CreateSessionBody | None = None):
    """Create a new terminal session."""
    params = {}
    if body:
        # Service expects camelCase keys (approvedInteractive, etc.)
        params = body.model_dump(by_alias=True, exclude_none=True)
    return await terminal_service.createTerminalSession(params)


@router.post('/open-external')
async def openExternal(body: OpenExternalBody | None = None):
    """Open Windows Terminal / system terminal in a real OS window."""
    cwd = body.cwd if body else ''
    result = terminal_service.openExternalTerminal(cwd=cwd or '')
    if not result.get('ok'):
        raise HTTPException(status_code=500, detail=str(result.get('error') or 'Failed to open terminal'))
    return result


@router.get('/buffer')
async def getBuffer(id: str = Query(...)):
    """Get the terminal buffer for a session."""
    try:
        return terminal_service.readTerminalBuffer(id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post('/input')
async def writeInput(body: InputBody):
    """Write input to a terminal session."""
    result = await terminal_service.writeTerminalInput(body.id, body.input, body.approved)
    if 'error' in result:
        raise HTTPException(status_code=400, detail=result['error'])
    return result


@router.post('/resize')
async def resizeTerminal(body: ResizeBody):
    """Resize a terminal session."""
    return await terminal_service.resizeTerminalSession(body.session_id, body.cols, body.rows)


@router.post('/command')
async def runCommand(body: CommandBody):
    """Submit a one-shot command for execution."""
    # Service reads timeoutMs / camelCase keys from the dumped dict.
    result = await terminal_service.submitTerminalCommand(body.model_dump(by_alias=True))
    if 'error' in result:
        raise HTTPException(status_code=400, detail=result['error'])
    return result


@router.post('/approve')
async def approveRequest(body: ApproveBody):
    """Approve or reject a pending terminal request."""
    result = await terminal_service.approveTerminalRequest(body.request_id, body.approve)
    if 'error' in result:
        raise HTTPException(status_code=404, detail=result['error'])
    return result


@router.delete('/sessions/{sessionId}')
async def deleteSession(sessionId: str):
    """Close and delete a terminal session."""
    if not await terminal_service.closeTerminalSession(sessionId):
        raise HTTPException(status_code=404, detail='Session not found')
    return {'deleted': True}


@router.websocket('/connect')
async def terminalWebsocket(websocket: WebSocket, id: str = Query(...)):
    """WebSocket connection for live terminal I/O."""
    await websocket.accept()
    try:
        await terminal_service.handleTerminalConnection(websocket, id)
    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
