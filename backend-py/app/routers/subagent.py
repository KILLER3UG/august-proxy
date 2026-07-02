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
from app.services.tools.spawn_subagents_tool import execute_spawn_subagents, approve_proposal

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/subagents")


class WorkItem(BaseModel):
    goal: str
    agentId: str = "general"
    restrictedTools: list[str] | None = None
    context: str = ""


class SpawnRequest(BaseModel):
    workItems: list[WorkItem]
    mode: str = "auto"  # "auto" | "proposed" | "negotiated"


class ProposeBreakdownRequest(BaseModel):
    proposalId: str
    approved: bool = True


def _get_orchestrator(request: Request) -> SubagentOrchestrator:
    """Get the orchestrator from app state."""
    orch = getattr(request.app.state, "subagent_orchestrator", None)
    if not orch:
        raise HTTPException(status_code=503, detail="Subagent orchestrator not initialized")
    return orch


def _get_session(request: Request) -> Any:
    """Get a minimal session-like object from request state."""
    # In real usage the session is resolved from the request context;
    # here we create a lightweight namespace for the orchestrator.
    import types
    return types.SimpleNamespace(
        id=request.headers.get("X-Session-Id", "default"),
        model=request.headers.get("X-Model", ""),
        agent_id=request.headers.get("X-Agent-Id", ""),
        provider=request.headers.get("X-Provider", ""),
    )


@router.post("/spawn")
async def spawn_subagents(body: SpawnRequest, request: Request):
    """Spawn one or more sub-agents for parallel execution."""
    orch = _get_orchestrator(request)
    session = _get_session(request)

    # For 'auto' mode, spawn directly
    if body.mode == "auto":
        work_items = [
            {
                "goal": w.goal,
                "agent_id": w.agentId,
                "restricted_tools": w.restrictedTools,
                "context": w.context,
            }
            for w in body.workItems
        ]
        result = await execute_spawn_subagents(
            orch, session, work_items, mode=body.mode
        )
        return result
    else:
        # For 'proposed'/'negotiated' mode, emit for approval
        work_items = [
            {
                "goal": w.goal,
                "agent_id": w.agentId,
                "restricted_tools": w.restrictedTools,
                "context": w.context,
            }
            for w in body.workItems
        ]
        result = await execute_spawn_subagents(
            orch, session, work_items, mode=body.mode
        )
        return result


@router.get("/active")
async def list_active(sessionId: Optional[str] = None, request: Request = None):
    """List active sub-agents. Optionally filter by sessionId."""
    orch = _get_orchestrator(request)
    return {"agents": orch.list_active(session_id=sessionId)}


@router.post("/{task_id}/terminate")
async def terminate_subagent(task_id: str, request: Request):
    """Terminate a running sub-agent."""
    orch = _get_orchestrator(request)
    success = await orch.terminate(task_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found or already completed")
    return {"status": "cancelled", "task_id": task_id}


@router.post("/propose-breakdown")
async def propose_breakdown(body: ProposeBreakdownRequest, request: Request):
    """Approve or reject a proposed sub-agent breakdown."""
    if not body.approved:
        return {"status": "rejected", "proposal_id": body.proposalId}

    orch = _get_orchestrator(request)
    result = await approve_proposal(orch, body.proposalId)
    return result


@router.get("/stream")
async def stream_subagent_events(sessionId: Optional[str] = None, request: Request = None):
    """SSE stream of sub-agent events for a session.

    Uses the existing ``event_log.py`` SSE pattern: yields ``data:`` lines
    as sub-agent events occur.
    """
    from app.services.eventLog import eventLog

    async def event_generator():
        # Subscribe to the event log for subagent events
        # This reuses the existing SSE infrastructure
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=256)

        def handler(ev: dict[str, Any]) -> None:
            try:
                queue.put_nowait(ev)
            except asyncio.QueueFull:
                pass  # drop oldest events when overloaded

        # Register a handler for subagent events
        unsub = eventLog.on("subagent", handler)
        try:
            while True:
                ev = await queue.get()
                yield f"data: {json.dumps(ev)}\n\n"
                if ev.get("type") in ("subagent_done", "subagent_completed", "done"):
                    break
        except asyncio.CancelledError:
            pass
        finally:
            unsub()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
