"""Terminal session API routes (legacy /api/terminal/* endpoints).

Delegates to the same terminal_service as /ui/terminal/* routes.

Request bodies inherit :class:`CamelModel` so internals are snake_case while
JSON from the frontend stays camelCase. (All current fields are single-word,
so JSON keys match attribute names.)
"""

from __future__ import annotations
from fastapi import APIRouter, HTTPException
from app.models.camel_base import CamelModel
from app.services.workbench import terminal_service

router = APIRouter(prefix='/api/terminal')


class TerminalCreate(CamelModel):
    name: str = 'default'
    cwd: str = ''
    shell: str = ''


class TerminalWrite(CamelModel):
    data: str


@router.post('')
async def createTerminal(body: TerminalCreate):
    """Create a new terminal session."""
    session = await terminal_service.createTerminalSession({'title': body.name, 'cwd': body.cwd or None})
    return session


@router.get('')
async def listTerminals():
    """List all terminal sessions."""
    return {'sessions': terminal_service.listTerminalSessions()}


@router.get('/{sessionId}')
async def getTerminal(sessionId: str):
    """Get a terminal session by ID."""
    try:
        return terminal_service.readTerminalBuffer(sessionId)
    except KeyError:
        raise HTTPException(status_code=404, detail='Terminal session not found')


@router.delete('/{sessionId}')
async def deleteTerminal(sessionId: str):
    """Delete a terminal session."""
    if not terminal_service.closeTerminalSession(sessionId):
        raise HTTPException(status_code=404, detail='Terminal session not found')
    return {'status': 'ok'}


@router.post('/{sessionId}/write')
async def writeTerminal(sessionId: str, body: TerminalWrite):
    """Write data to a terminal session."""
    result = await terminal_service.writeTerminalInput(sessionId, body.data)
    if 'error' in result:
        raise HTTPException(status_code=400, detail=result['error'])
    return result


@router.get('/{sessionId}/read')
async def readTerminal(sessionId: str):
    """Read output from a terminal session."""
    try:
        return terminal_service.readTerminalBuffer(sessionId)
    except KeyError:
        raise HTTPException(status_code=404, detail='Session not found')
