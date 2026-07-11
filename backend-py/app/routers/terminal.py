"""Terminal session API routes (legacy /api/terminal/* endpoints).

Delegates to the same terminal_service as /ui/terminal/* routes.
"""
from __future__ import annotations
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services.workbench import terminal_service
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
    session = await terminal_service.create_terminal_session({'title': body.name, 'cwd': body.cwd or None})
    return session

@router.get('')
async def listTerminals():
    """List all terminal sessions."""
    return {'sessions': terminal_service.listTerminalSessions()}

@router.get('/{sessionId}')
async def getTerminal(sessionId: str):
    """Get a terminal session by ID."""
    try:
        return terminal_service.read_terminal_buffer(sessionId)
    except KeyError:
        raise HTTPException(status_code=404, detail='Terminal session not found')

@router.delete('/{sessionId}')
async def deleteTerminal(sessionId: str):
    """Delete a terminal session."""
    if not terminal_service.close_terminal_session(sessionId):
        raise HTTPException(status_code=404, detail='Terminal session not found')
    return {'status': 'ok'}

@router.post('/{sessionId}/write')
async def writeTerminal(sessionId: str, body: TerminalWrite):
    """Write data to a terminal session."""
    result = await terminal_service.write_terminal_input(sessionId, body.data)
    if 'error' in result:
        raise HTTPException(status_code=400, detail=result['error'])
    return result

@router.get('/{sessionId}/read')
async def readTerminal(sessionId: str):
    """Read output from a terminal session."""
    try:
        return terminal_service.read_terminal_buffer(sessionId)
    except KeyError:
        raise HTTPException(status_code=404, detail='Session not found')