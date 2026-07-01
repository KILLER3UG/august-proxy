"""Terminal session API routes (legacy /api/terminal/* endpoints).

Delegates to the same terminal_service as /ui/terminal/* routes.
"""
from __future__ import annotations
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services.workbench import terminalService
router = APIRouter(prefix='/api/terminal')

class TerminalCreate(BaseModel):
    name: str = 'default'
    cwd: str = ''
    shell: str = ''

class TerminalWrite(BaseModel):
    data: str

@router.post('')
async def createTerminal(body: TerminalCreate):
    """Create a new terminal session."""
    session = await terminalService.create_terminal_session({'title': body.name, 'cwd': body.cwd or None})
    return session

@router.get('')
async def listTerminals():
    """List all terminal sessions."""
    return {'sessions': terminalService.listTerminalSessions()}

@router.get('/{session_id}')
async def getTerminal(sessionId: str):
    """Get a terminal session by ID."""
    try:
        return terminalService.read_terminal_buffer(sessionId)
    except KeyError:
        raise HTTPException(status_code=404, detail='Terminal session not found')

@router.delete('/{session_id}')
async def deleteTerminal(sessionId: str):
    """Delete a terminal session."""
    if not terminalService.close_terminal_session(sessionId):
        raise HTTPException(status_code=404, detail='Terminal session not found')
    return {'status': 'ok'}

@router.post('/{session_id}/write')
async def writeTerminal(sessionId: str, body: TerminalWrite):
    """Write data to a terminal session."""
    result = await terminalService.write_terminal_input(sessionId, body.data)
    if 'error' in result:
        raise HTTPException(status_code=400, detail=result['error'])
    return result

@router.get('/{session_id}/read')
async def readTerminal(sessionId: str):
    """Read output from a terminal session."""
    try:
        return terminalService.read_terminal_buffer(sessionId)
    except KeyError:
        raise HTTPException(status_code=404, detail='Session not found')