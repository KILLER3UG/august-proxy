"""
Sub-agent management API routes.

Endpoints
---------
- ``POST /api/subagents/spawn`` — spawn one or more sub-agents
- ``GET /api/subagents/active?sessionId=X`` — list active sub-agents
- ``POST /api/subagents/{taskId}/terminate`` — terminate a sub-agent
- ``GET /api/subagents/stream?sessionId=X`` — SSE stream of subagent events
- ``POST /api/subagents/propose-breakdown`` — approve a proposed breakdown

Request bodies inherit :class:`CamelModel` so internals are snake_case while
JSON from the frontend stays camelCase.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.models.camel_base import CamelModel
from app.services.subagent_orchestrator import SubagentOrchestrator
from app.services.tools.spawn_subagents_tool import approveProposal, executeSpawnSubagents

logger = logging.getLogger(__name__)
router = APIRouter(prefix='/api/subagents')


class WorkItem(CamelModel):
    """Single spawn work item. Internals snake_case; JSON camelCase."""

    goal: str
    agent_id: str = 'general'
    restricted_tools: list[str] | None = None
    context: str = ''


class SpawnRequest(CamelModel):
    """Spawn request body. Internals snake_case; JSON camelCase."""

    work_items: list[WorkItem]
    mode: str = 'auto'
    background: bool = True


class ProposeBreakdownRequest(CamelModel):
    """Propose-breakdown approval body. Internals snake_case; JSON camelCase."""

    proposal_id: str
    approved: bool = True


def _getOrchestrator(request: Request) -> SubagentOrchestrator:
    """Get the orchestrator — lifespan or lazy init (never permanent 503)."""
    from app.services.runtime_services import get_orchestrator

    return get_orchestrator(request.app)


def _getSession(request: Request) -> object:
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
    # Service layer expects camelCase keys on work-item dicts.
    workItems = [
        {
            'goal': w.goal,
            'agentId': w.agent_id,
            'restrictedTools': w.restricted_tools,
            'context': w.context,
        }
        for w in body.work_items
    ]
    result = await executeSpawnSubagents(
        orch, session, workItems, mode=body.mode, background=body.background
    )
    return result


@router.get('/active')
async def listActive(request: Request, sessionId: Optional[str] = None):
    """List active sub-agents. Optionally filter by sessionId."""
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
        return {'status': 'rejected', 'proposalId': body.proposal_id}
    orch = _getOrchestrator(request)
    result = await approveProposal(orch, body.proposal_id)
    return result


@router.get('/stream')
async def streamSubagentEvents(request: Request, sessionId: Optional[str] = None):
    """SSE stream of sub-agent events for a session.

    Fans out orchestrator lifecycle events (and, when ``sessionId`` is set,
    workbench ``event_log`` subagent payloads). Stays open across many
    parallel completions — does not close after the first done event.
    """
    from app.services.event_log import event_log

    orch = _getOrchestrator(request)

    async def eventGenerator():
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=256)

        def _push(ev: dict[str, Any]) -> None:
            if sessionId:
                sid = str(ev.get('sessionId') or '')
                if sid and sid != sessionId:
                    return
            try:
                queue.put_nowait(ev)
            except asyncio.QueueFull:
                pass

        for name in ('subagentStarted', 'subagentCompleted', 'subagentFailed'):
            orch.on(name, _push)

        log_task: asyncio.Task | None = None
        if sessionId:

            async def _forward_log() -> None:
                async for ev in event_log.subscribe(sessionId):
                    et = str(ev.get('type') or '')
                    payload = ev.get('payload') if isinstance(ev.get('payload'), dict) else {}
                    inner = str(payload.get('type') or '') if isinstance(payload, dict) else ''
                    if not (
                        et.startswith('subagent')
                        or inner.startswith('subagent')
                        or et in ('subagent_event', 'subagentStart', 'subagentDone')
                    ):
                        continue
                    out = dict(payload) if isinstance(payload, dict) else {}
                    out.setdefault('type', inner or et)
                    out.setdefault('sessionId', sessionId)
                    _push(out)

            log_task = asyncio.create_task(_forward_log())

        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=25.0)
                    yield f'data: {json.dumps(ev, default=str)}\n\n'
                except asyncio.TimeoutError:
                    yield ': keepalive\n\n'
        except asyncio.CancelledError:
            pass
        finally:
            for name in ('subagentStarted', 'subagentCompleted', 'subagentFailed'):
                handlers = orch._eventHandlers.get(name) or []
                try:
                    handlers.remove(_push)
                except ValueError:
                    pass
            if log_task is not None:
                log_task.cancel()
                try:
                    await log_task
                except (asyncio.CancelledError, Exception):
                    pass

    return StreamingResponse(
        eventGenerator(),
        media_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'},
    )
