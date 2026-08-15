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

from app.json_narrowing import as_str
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
    yield_schema: dict | None = None
    name: str = ''
    workstream: str = ''
    depends_on: list[str] | None = None
    source_workstreams: list[str] | None = None
    acceptance_criteria: str = ''
    stop_condition: str = ''
    max_iterations: int = 0
    skills: list[str] | None = None


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
    """Get a minimal session-like object from request state.

    ``agent_id`` (snake) is set alongside ``agentId`` — ``executeSubAgent``
    reads ``session.agent_id`` for parent-permission derivation, and the old
    camel-only shell silently disabled ``deriveChildPermissions`` for
    user-launched agents.
    """
    import types

    return types.SimpleNamespace(
        id=request.headers.get('X-Session-Id', 'default'),
        model=request.headers.get('X-Model', ''),
        agentId=request.headers.get('X-Agent-Id', ''),
        agent_id=request.headers.get('X-Agent-Id', ''),
        provider=request.headers.get('X-Provider', ''),
        subagent_depth=0,
        workspacePath=request.headers.get('X-Workspace-Path', ''),
    )


def _makeEmit(sessionId: str):
    """SSE emitter wired to the session's event log — the same path the
    model-initiated spawn tool uses, so user-launched subagents stream into
    the active chat (subagentStart/Text/ToolCall/ToolResult/Done) instead of
    running invisibly."""
    from app.services import event_log

    def _emit(ev: dict) -> None:
        try:
            event_log.event_log.append(sessionId, str(ev.get('type') or 'subagent_event'), ev)
        except Exception:
            pass

    return _emit


@router.post('/spawn')
async def spawnSubagents(body: SpawnRequest, request: Request):
    """Spawn one or more sub-agents for parallel execution."""
    orch = _getOrchestrator(request)
    session = _getSession(request)
    sessionId = str(getattr(session, 'id', '') or '')
    # Service layer expects camelCase keys on work-item dicts.
    workItems = [
        {
            'goal': w.goal,
            'agentId': w.agent_id,
            'restrictedTools': w.restricted_tools,
            'context': w.context,
            'model': w.model,
            'effort': w.effort if w.effort in ('low', 'medium', 'high', 'max') else 'medium',
            'yieldSchema': w.yield_schema,
            'name': w.name,
            'workstream': w.workstream or w.name,
            'dependsOn': w.depends_on,
            'sourceWorkstreams': w.source_workstreams,
            'acceptanceCriteria': w.acceptance_criteria,
            'stopCondition': w.stop_condition,
            'maxIterations': w.max_iterations,
            'skills': w.skills or [],
        }
        for w in body.work_items
    ]
    result = await executeSpawnSubagents(
        orch, session, workItems, mode=body.mode, emit=_makeEmit(sessionId), background=body.background
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


@router.get('/jobs')
async def listHarnessJobs(request: Request, sessionId: Optional[str] = None):
    from app.services.harness_jobs import list_jobs

    sid = sessionId or request.headers.get('X-Session-Id', '') or ''
    if not sid:
        raise HTTPException(status_code=400, detail='sessionId is required')
    return {'jobs': list_jobs(sid)}


@router.post('/jobs/{jobId}/cancel-wave')
async def cancelHarnessWave(jobId: str, wave: int = 0):
    from app.services.harness_jobs import cancel_wave

    return await cancel_wave(jobId, wave)


@router.post('/jobs/{jobId}/cancel')
async def cancelHarnessJob(jobId: str):
    from app.services.harness_jobs import cancel_job

    return await cancel_job(jobId)


@router.post('/stop-all')
async def stopAllSubagents(request: Request):
    """Terminate every active sub-agent for a session (or all, when no
    session is given). Returns how many were stopped."""
    orch = _getOrchestrator(request)
    body = await request.json() if request.headers.get('content-type') else {}
    sessionId = as_str(body.get('sessionId') or request.headers.get('X-Session-Id', ''), '')
    active = orch.listActive(sessionId=sessionId or None)
    stopped = 0
    for a in active:
        tid = as_str(a.get('taskId'), '')
        if tid and as_str(a.get('status'), '') in ('pending', 'running'):
            try:
                if await orch.terminate(tid):
                    stopped += 1
            except Exception:
                logger.debug('stop-all terminate failed for %s', tid, exc_info=True)
    return {'status': 'stopped', 'stopped': stopped, 'total': len(active)}


@router.post('/{taskId}/terminate')
async def terminateSubagent(taskId: str, request: Request):
    """Terminate a running sub-agent."""
    orch = _getOrchestrator(request)
    success = await orch.terminate(taskId)
    if not success:
        raise HTTPException(status_code=404, detail=f'Task {taskId} not found or already completed')
    return {'status': 'cancelled', 'taskId': taskId}


@router.post('/{taskId}/resume')
async def resumeSubagent(taskId: str, request: Request):
    """Re-run a finished/failed sub-agent with the same goal + agent role.

    Looks the run up in the persisted history and re-dispatches it through
    the orchestrator bound to the ORIGINAL session (so events stream into
    the same transcript). Returns the NEW task id — the old run's history
    row is preserved.
    """
    from app.services.memory_store import _conn

    conn = _conn()
    row = conn.execute(
        'SELECT task_id, session_id, agent_id, goal FROM subagent_runs WHERE task_id = ?',
        (taskId,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f'Task {taskId} not found in run history')
    orch = _getOrchestrator(request)
    sessionId = as_str(row['session_id'] if isinstance(row, dict) or hasattr(row, 'keys') else row[1], '') or 'default'
    goal = as_str(row['goal'] if isinstance(row, dict) or hasattr(row, 'keys') else row[3], '')
    agentId = as_str(row['agent_id'] if isinstance(row, dict) or hasattr(row, 'keys') else row[2], '') or 'general'
    if not goal:
        raise HTTPException(status_code=400, detail=f'Task {taskId} has no goal to resume')
    session = _getSession(request)
    setattr(session, 'id', sessionId)
    workItems = [{'goal': goal, 'agentId': agentId}]
    result = await executeSpawnSubagents(
        orch, session, workItems, mode='auto', emit=_makeEmit(sessionId), background=True
    )
    return {**result, 'resumedFrom': taskId}


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


class SteerRequest(CamelModel):
    message: str


class ContinueWorkstreamRequest(CamelModel):
    message: str
    agent_id: str = 'general'


@router.get('/workstreams')
async def listWorkstreamsApi(request: Request, sessionId: Optional[str] = None):
    """Named threads + latest episode for a session (Nac-style dashboard)."""
    from app.services.workstreams import list_workstreams

    sid = sessionId or request.headers.get('X-Session-Id', '') or ''
    if not sid:
        raise HTTPException(status_code=400, detail='sessionId is required')
    return {'workstreams': list_workstreams(sid)}


@router.get('/workstreams/{name}/episodes')
async def listWorkstreamEpisodes(name: str, request: Request, sessionId: Optional[str] = None):
    from app.services.workstreams import list_episodes

    sid = sessionId or request.headers.get('X-Session-Id', '') or ''
    if not sid:
        raise HTTPException(status_code=400, detail='sessionId is required')
    return {'name': name, 'episodes': list_episodes(sid, name)}


@router.post('/{taskId}/steer')
async def steerSubagent(taskId: str, body: SteerRequest, request: Request):
    """Queue a steering message for the worker's next round (does not interrupt)."""
    orch = _getOrchestrator(request)
    if not orch.enqueueMailbox(taskId, body.message):
        raise HTTPException(
            status_code=404,
            detail=f'Task {taskId} is not running — continue a workstream instead.',
        )
    return {'status': 'queued', 'taskId': taskId}


@router.get('/digest')
async def harnessDigest(
    request: Request, sessionId: Optional[str] = None, workspace: Optional[str] = None
):
    from app.services.harness_playbook import session_digest

    sid = sessionId or request.headers.get('X-Session-Id', '') or ''
    if not sid:
        raise HTTPException(status_code=400, detail='sessionId is required')
    return session_digest(sid, workspace or request.headers.get('X-Workspace-Path', ''))


@router.get('/specialists')
async def listSpecialistsApi(request: Request, sessionId: Optional[str] = None):
    from app.services.harness_playbook import list_specialists

    sid = sessionId or request.headers.get('X-Session-Id', '') or ''
    if not sid:
        raise HTTPException(status_code=400, detail='sessionId is required')
    return {'specialists': list_specialists(sid)}


class SpecialistBody(CamelModel):
    name: str = ''
    workstream: str = ''
    agent_id: str = 'general'
    skills: list[str] | None = None
    model: str = ''
    acceptance: str = ''
    restricted_tools: list[str] | None = None
    autonomy: str = 'ask'
    id: str = ''


@router.post('/specialists')
async def upsertSpecialistApi(body: SpecialistBody, request: Request):
    from app.services.harness_playbook import upsert_specialist

    sid = request.headers.get('X-Session-Id', '') or as_str(getattr(_getSession(request), 'id', ''), '')
    payload = body.model_dump()
    payload['workspacePath'] = request.headers.get('X-Workspace-Path', '')
    try:
        return upsert_specialist(sid, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/specialists/{specialistId}/autonomy')
async def setSpecialistAutonomy(specialistId: str, body: dict):
    from app.services.harness_playbook import set_autonomy

    try:
        return set_autonomy(specialistId, str(body.get('autonomy') or ''))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete('/specialists/{specialistId}')
async def deleteSpecialistApi(specialistId: str):
    from app.services.harness_playbook import delete_specialist

    delete_specialist(specialistId)
    return {'status': 'ok'}


@router.get('/routines')
async def listRoutinesApi(request: Request, sessionId: Optional[str] = None):
    from app.services.harness_playbook import list_routines

    sid = sessionId or request.headers.get('X-Session-Id', '') or ''
    if not sid:
        raise HTTPException(status_code=400, detail='sessionId is required')
    return {'routines': list_routines(sid)}


class SaveRoutineBody(CamelModel):
    name: str = ''
    workstream: str = ''
    seq: int | None = None


@router.post('/routines')
async def saveRoutineApi(body: SaveRoutineBody, request: Request):
    from app.services.harness_playbook import save_routine_from_episode

    sid = request.headers.get('X-Session-Id', '') or as_str(getattr(_getSession(request), 'id', ''), '')
    try:
        return save_routine_from_episode(
            sid, body.workstream, body.seq, request.headers.get('X-Workspace-Path', '')
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/routines/{routineId}/run')
async def runRoutineApi(routineId: str, request: Request):
    orch = _getOrchestrator(request)
    session = _getSession(request)
    sessionId = str(getattr(session, 'id', '') or request.headers.get('X-Session-Id', '') or '')
    setattr(session, 'id', sessionId)
    from app.services.harness_playbook import get_routine, routine_work_item

    routine = get_routine(routineId)
    if not routine:
        raise HTTPException(status_code=404, detail='Routine not found')
    item = routine_work_item(sessionId, routine)
    result = await executeSpawnSubagents(
        orch, session, [item], mode='auto', emit=_makeEmit(sessionId), background=True
    )
    return {**result, 'routineId': routineId, 'workstream': routine.get('workstream')}


@router.post('/routines/{routineId}/schedule')
async def scheduleRoutineApi(routineId: str, body: dict):
    from app.services.harness_ops import set_routine_schedule

    try:
        return set_routine_schedule(
            routineId,
            str(body.get('schedule') or ''),
            body.get('paused') if 'paused' in body else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/workstreams/{name}/save-skill')
async def saveSkillFromWorkstream(name: str, request: Request, body: dict | None = None):
    from app.services.harness_ops import skill_from_episode
    from app.services.skill_service import SkillValidationError

    sid = request.headers.get('X-Session-Id', '') or as_str(getattr(_getSession(request), 'id', ''), '')
    seq = (body or {}).get('seq')
    try:
        return skill_from_episode(sid, name, int(seq) if seq is not None else None)
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/workstreams/{name}/read')
async def markWorkstreamRead(name: str, request: Request, sessionId: Optional[str] = None):
    from app.services.harness_ops import mark_read
    from app.services.workstreams import latest_episode

    sid = sessionId or request.headers.get('X-Session-Id', '') or ''
    if not sid:
        raise HTTPException(status_code=400, detail='sessionId is required')
    ep = latest_episode(sid, name)
    mark_read(sid, name, int((ep or {}).get('seq') or 0))
    return {'status': 'ok', 'name': name}


@router.get('/search')
async def searchHarnessApi(request: Request, q: str = '', sessionId: Optional[str] = None):
    from app.services.harness_ops import search_harness

    sid = sessionId or request.headers.get('X-Session-Id', '') or ''
    if not sid:
        raise HTTPException(status_code=400, detail='sessionId is required')
    return search_harness(sid, q, workspace=request.headers.get('X-Workspace-Path', ''))


@router.delete('/routines/{routineId}')
async def deleteRoutineApi(routineId: str):
    from app.services.harness_playbook import delete_routine

    delete_routine(routineId)
    return {'status': 'ok'}


@router.post('/workstreams/{name}/continue')
async def continueWorkstream(name: str, body: ContinueWorkstreamRequest, request: Request):
    """Spawn a fresh worker on a named thread with prior episodes."""
    orch = _getOrchestrator(request)
    session = _getSession(request)
    sessionId = str(getattr(session, 'id', '') or request.headers.get('X-Session-Id', '') or '')
    setattr(session, 'id', sessionId)
    try:
        from app.services.harness_ops import touch_activity

        touch_activity()
    except Exception:
        pass
    from app.services.harness_playbook import continue_work_item

    item = continue_work_item(sessionId, name, body.message)
    if body.agent_id and body.agent_id != 'general':
        item['agentId'] = body.agent_id
    result = await executeSpawnSubagents(
        orch, session, [item], mode='auto', emit=_makeEmit(sessionId), background=True
    )
    return {**result, 'workstream': name}
