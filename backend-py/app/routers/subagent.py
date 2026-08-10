"""
Sub-agent management API routes.

Endpoints
---------
- ``POST /api/subagents/spawn`` — spawn one or more sub-agents
- ``GET /api/subagents/active?sessionId=X`` — list active sub-agents
- ``POST /api/subagents/{taskId}/terminate`` — terminate a sub-agent
- ``POST /api/subagents/propose-breakdown`` — approve a proposed breakdown

Request bodies inherit :class:`CamelModel` so internals are snake_case while
JSON from the frontend stays camelCase.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Request

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
    model: str = ''
    effort: str = 'medium'


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
            'model': w.model,
            'effort': w.effort if w.effort in ('low', 'medium', 'high', 'max') else 'medium',
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


@router.get('/runs')
async def listRuns(sessionId: Optional[str] = None, limit: int = 50):
    """List persisted sub-agent run history (newest first).

    Optional ``sessionId`` filter narrows to one conversation; ``limit``
    caps the page (default 50, max 500).
    """
    from app.services.memory_store import _conn, _row_as_wire

    if limit < 1 or limit > 500:
        limit = 50
    conn = _conn()
    if sessionId:
        rows = conn.execute(
            'SELECT id, task_id, session_id, agent_id, goal, status, result_summary, error, '
            'started_at, finished_at, created_at FROM subagent_runs '
            'WHERE session_id = ? ORDER BY id DESC LIMIT ?',
            (sessionId, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            'SELECT id, task_id, session_id, agent_id, goal, status, result_summary, error, '
            'started_at, finished_at, created_at FROM subagent_runs '
            'ORDER BY id DESC LIMIT ?',
            (limit,),
        ).fetchall()
    return {'runs': [_row_as_wire(r) for r in rows]}


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
        from app.services.tools.spawn_subagents_tool import _mark_proposal_decided

        _mark_proposal_decided(body.proposal_id, 'rejected')
        return {'status': 'rejected', 'proposalId': body.proposal_id}
    orch = _getOrchestrator(request)
    result = await approveProposal(orch, body.proposal_id)
    return result


@router.get('/proposals')
async def listProposals():
    """List pending breakdown proposals awaiting user approval.

    Proposals are created when a model uses ``spawn_subagents`` in
    ``proposed`` mode; they are persisted (B5) and approved/rejected via
    ``POST /propose-breakdown`` (from chat or the Brain Runs tab).
    """
    from app.services.tools.spawn_subagents_tool import (
        _pendingProposals,
        list_persisted_proposals,
    )

    out = []
    seen: set[str] = set()
    for pid, p in _pendingProposals.items():
        items = p.get('workItems') if isinstance(p, dict) else []
        out.append(
            {
                'proposalId': pid,
                'createdAt': p.get('createdAt', 0) if isinstance(p, dict) else 0,
                'workItemCount': len(items) if isinstance(items, list) else 0,
                'goals': [
                    str((w.get('goal') or '') if isinstance(w, dict) else '')[:200]
                    for w in items
                    if isinstance(w, dict)
                ],
            }
        )
        seen.add(pid)
    # Durable-store rows (survive restarts); skip ones still in memory.
    for p in list_persisted_proposals():
        if p['proposalId'] not in seen:
            out.append(p)
    return {'proposals': out}
