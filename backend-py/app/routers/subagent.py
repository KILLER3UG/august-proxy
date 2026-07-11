"""
Sub-agent management API routes.

Endpoints
---------
- ``POST /api/subagents/spawn`` — spawn one or more sub-agents
- ``GET /api/subagents/active?sessionId=X`` — list active sub-agents
- ``POST /api/subagents/{taskId}/terminate`` — terminate a sub-agent
- ``GET /api/subagents/stream?sessionId=X`` — SSE stream of subagent events
- ``POST /api/subagents/propose-breakdown`` — approve a proposed breakdown
"""

from __future__ import annotations
import asyncio
import json
import logging
from typing import Any, Optional
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from app.services.subagent_orchestrator import SubagentOrchestrator, SubagentSpawnRequest
from app.services.tools.spawn_subagents_tool import executeSpawnSubagents, approveProposal

logger = logging.getLogger(__name__)
router = APIRouter(prefix='/api/subagents')


class WorkItem(BaseModel):
    goal: str
    agentId: str = 'general'
    restrictedTools: list[str] | None = None
    context: str = ''


class SpawnRequest(BaseModel):
    workItems: list[WorkItem]
    mode: str = 'auto'


class ProposeBreakdownRequest(BaseModel):
    proposalId: str
    approved: bool = True


def _getOrchestrator(request: Request) -> SubagentOrchestrator:
    """Get the orchestrator from app state."""
    orch = getattr(request.app.state, 'subagent_orchestrator', None)
    if not orch:
        raise HTTPException(status_code=503, detail='Subagent orchestrator not initialized')
    return orch


def _getSession(request: Request) -> Any:
    """Get a minimal session-like object from request state."""
    import types

    return types.SimpleNamespace(
        id=request.headers.get('X-Session-Id', 'default'),
        model=request.headers.get('X-Model', ''),
        agentId=request.headers.get('X-Agent-Id', ''),
        provider=request.headers.get('X-Provider', ''),
    )


@router.post('/spawn')
async def spawnSubagents(body: SpawnRequest, request: Request):
    """Spawn one or more sub-agents for parallel execution."""
    orch = _getOrchestrator(request)
    session = _getSession(request)
    if body.mode == 'auto':
        workItems = [
            {'goal': w.goal, 'agentId': w.agentId, 'restrictedTools': w.restrictedTools, 'context': w.context}
            for w in body.workItems
        ]
        result = await executeSpawnSubagents(orch, session, workItems, mode=body.mode)
        return result
    else:
        workItems = [
            {'goal': w.goal, 'agentId': w.agentId, 'restrictedTools': w.restrictedTools, 'context': w.context}
            for w in body.workItems
        ]
        result = await executeSpawnSubagents(orch, session, workItems, mode=body.mode)
        return result


@router.get('/active')
async def listActive(sessionId: Optional[str] = None, request: Request | None = None):
    """List active sub-agents. Optionally filter by sessionId."""
    if request is None:
        raise HTTPException(status_code=400, detail='request is required')
    orch = _getOrchestrator(request)
    return {'agents': orch.listActive(sessionId=sessionId)}


@router.post('/{taskId}/terminate')
async def terminateSubagent(taskId: str, request: Request):
    """Terminate a running sub-agent."""
    orch = _getOrchestrator(request)
    success = await orch.terminate(taskId)
    if not success:
        raise HTTPException(status_code=404, detail=f'Task {taskId} not found or already completed')
    return {'status': 'cancelled', 'taskId': taskId}


@router.post('/propose-breakdown')
async def proposeBreakdown(body: ProposeBreakdownRequest, request: Request):
    """Approve or reject a proposed sub-agent breakdown."""
    if not body.approved:
        return {'status': 'rejected', 'proposalId': body.proposalId}
    orch = _getOrchestrator(request)
    result = await approveProposal(orch, body.proposalId)
    return result


@router.get('/stream')
async def streamSubagentEvents(sessionId: Optional[str] = None, request: Request | None = None):
    """SSE stream of sub-agent events for a session.

    Uses the existing ``event_log.py`` SSE pattern: yields ``data:`` lines
    as sub-agent events occur.
    """
    from app.services.event_log import event_log

    async def eventGenerator():
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=256)

        def handler(ev: dict[str, Any]) -> None:
            try:
                queue.put_nowait(ev)
            except asyncio.QueueFull:
                pass

        unsub = event_log.on('subagent', handler)
        try:
            while True:
                ev = await queue.get()
                yield f'data: {json.dumps(ev)}\n\n'
                if ev.get('type') in ('subagentDone', 'subagentCompleted', 'done'):
                    break
        except asyncio.CancelledError:
            pass
        finally:
            unsub()

    return StreamingResponse(
        eventGenerator(),
        media_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'},
    )
