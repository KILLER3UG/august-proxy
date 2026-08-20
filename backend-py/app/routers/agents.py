"""Agent system API routes.

Backed by the persistent ``agent_registry`` service (SQLite KV) — the
previous in-memory store is gone, so agents now survive restarts. Adds an
update route and a rooted-tree query used by the frontend AgentTree.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Query

from app.json_narrowing import as_str
from app.models.camel_base import CamelModel
from app.services.tools import agent_registry

logger = logging.getLogger('agents')

router = APIRouter(prefix='/api/agents')


class AgentCreate(CamelModel):
    name: str
    parent_id: str = ''
    parent_agent: str = ''
    permissions: list[str] = []
    toolsets: list[str] = []
    tools: list[str] = []
    model: str = ''
    provider: str = ''
    model_alias: str = ''
    role: str = ''
    description: str = ''


class AgentUpdate(CamelModel):
    name: str | None = None
    parent_id: str | None = None
    permissions: list[str] | None = None
    toolsets: list[str] | None = None
    tools: list[str] | None = None
    model: str | None = None
    provider: str | None = None
    model_alias: str | None = None
    role: str | None = None
    description: str | None = None


class AgentJob(CamelModel):
    agent_id: str
    goal: str
    context: str = ''
    session_id: str = ''


@router.get('')
async def listAgents():
    """List all registered agents."""
    return {'agents': agent_registry.listAgents()}


@router.post('')
async def createAgent(body: AgentCreate):
    """Register a new agent (persisted)."""
    return agent_registry.createAgent(
        name=body.name,
        parentId=body.parent_id,
        parent_agent=body.parent_agent,
        permissions=body.permissions,
        toolsets=body.toolsets,
        tools=body.tools,
        model=body.model,
        provider=body.provider,
        model_alias=body.model_alias,
        role=body.role,
        description=body.description,
        actor='ui',
    )


@router.get('/tree')
async def getTree(root: str = '', maxDepth: int = Query(4)):
    """Return a recursive agent tree (frontend AgentTree)."""
    return agent_registry.getAgentTreeRooted(root=root, maxDepth=maxDepth)


def _record_api_job_run(
    job_id: str,
    session_id: str,
    agent_id: str,
    goal: str,
    status: str,
    result: str = '',
    error: str = '',
) -> None:
    """Write one API-agent job into subagent_runs (fire-and-forget)."""
    try:
        import time

        from app.services.memory_store import _conn

        now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        conn = _conn()
        existing = conn.execute(
            'SELECT id FROM subagent_runs WHERE task_id = ?', (job_id,)
        ).fetchone()
        if existing:
            conn.execute(
                'UPDATE subagent_runs SET status = ?, result_summary = ?, error = ?, '
                'finished_at = ? WHERE task_id = ?',
                (status, (result or '')[:4000], (error or '')[:2000], now, job_id),
            )
        else:
            conn.execute(
                'INSERT INTO subagent_runs '
                '(task_id, session_id, agent_id, goal, status, started_at, finished_at, '
                'result_summary, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (
                    job_id,
                    session_id or '',
                    agent_id or 'general',
                    (goal or '')[:500],
                    status,
                    now,
                    now,
                    (result or '')[:4000],
                    (error or '')[:2000],
                ),
            )
        conn.commit()
    except Exception:
        logger.debug('api job run record failed (non-fatal)', exc_info=True)


async def _run_api_agent_job(
    job_id: str,
    agent_id: str,
    goal: str,
    context: str,
    session_id: str = '',
) -> None:
    """Background runner for POST /api/agents/jobs — real workbench sub-agent."""
    import os

    timeout_s = float(os.environ.get('AUGUST_AGENT_JOB_TIMEOUT', '180') or '180')
    status = 'failed'
    result_text = ''
    error_text = ''
    try:
        from app.services.config_service import getConfig
        from app.services.workbench import workbench as wb
        from app.services.workbench.subagent import executeSubAgent

        session = wb.getWorkbenchSession(session_id) if session_id else None
        if session is None:
            cfg = getConfig()
            session = wb.createWorkbenchSession(
                provider=as_str(cfg.get('activeProvider')) or '',
                agentId=agent_id or 'build',
                guardMode='ask',
                goal=goal,
            )
            session.model = as_str(cfg.get('activeModel')) or ''
            meta = dict(session.metadata or {})
            meta['apiAgentJob'] = True
            meta['isolateSubagents'] = False
            session.metadata = meta
            try:
                wb.saveSessions()
            except Exception:
                pass
        elif not (session.provider or session.model):
            cfg = getConfig()
            if not session.provider:
                session.provider = as_str(cfg.get('activeProvider')) or ''
            if not session.model:
                session.model = as_str(cfg.get('activeModel')) or ''
        outcome = await asyncio.wait_for(
            executeSubAgent(
                session,
                agent_id,
                goal,
                context,
                job_id=job_id,
            ),
            timeout=max(5.0, timeout_s),
        )
        status = as_str(outcome.get('status'), 'completed') or 'completed'
        result_text = as_str(outcome.get('result'), '')
        error_text = as_str(outcome.get('error'), '')
    except asyncio.TimeoutError:
        logger.error('api agent job %s timed out after %ss', job_id, timeout_s)
        error_text = f'Timed out after {int(timeout_s)}s'
        try:
            agent_registry.updateJob(
                job_id,
                {'status': 'failed', 'error': error_text},
            )
        except Exception:
            pass
    except Exception as exc:
        logger.exception('api agent job %s failed', job_id)
        error_text = str(exc)
        try:
            agent_registry.updateJob(job_id, {'status': 'failed', 'error': error_text})
        except Exception:
            pass
    finally:
        # Mirror the outcome into subagent_runs so API jobs appear in the
        # Runs tab (the orchestrator path records its own rows; this path
        # runs executeSubAgent directly with a job_xxx id).
        try:
            _record_api_job_run(
                job_id=job_id,
                session_id=session_id,
                agent_id=agent_id,
                goal=goal,
                status=status,
                result=result_text,
                error=error_text,
            )
        except Exception:
            pass
        # Never leave API jobs stuck in pending/running.
        try:
            for job in agent_registry.listJobs():
                if as_str(job.get('id')) == job_id and as_str(job.get('status')) in (
                    'pending',
                    'running',
                ):
                    agent_registry.updateJob(
                        job_id,
                        {
                            'status': 'failed',
                            'error': 'Job ended without a terminal status',
                        },
                    )
                    break
        except Exception:
            pass


# Literal /jobs routes must be registered before /{agentId} or FastAPI
# treats "jobs" as an agent id and 404s list/create.
@router.post('/jobs')
async def createJob(body: AgentJob):
    """Enqueue a job and start real sub-agent execution in the background."""
    if not (body.goal or '').strip():
        raise HTTPException(status_code=400, detail='goal is required')
    agent_id = (body.agent_id or 'general').strip() or 'general'
    job = agent_registry.createJob(agent_id, body.goal, body.context)
    job_id = as_str(job.get('id'))
    asyncio.create_task(
        _run_api_agent_job(job_id, agent_id, body.goal, body.context, body.session_id or '')
    )
    return job


@router.get('/jobs')
async def listJobs(agentId: str = ''):
    return {'jobs': agent_registry.listJobs(agentId)}


@router.get('/jobs/{job_id}')
async def getJob(job_id: str):
    for job in agent_registry.listJobs():
        if job.get('id') == job_id:
            return job
    raise HTTPException(status_code=404, detail='Job not found')


@router.get('/{agentId}')
async def getAgent(agentId: str):
    agent = agent_registry.getAgent(agentId)
    if not agent:
        raise HTTPException(status_code=404, detail='Agent not found')
    return agent


@router.put('/{agentId}')
async def updateAgent(agentId: str, body: AgentUpdate):
    """Update an existing agent's configuration."""
    # Service layer stores camelCase keys (parentId, modelAlias, …).
    updates = {k: v for k, v in body.model_dump(by_alias=True).items() if v is not None}
    agent = agent_registry.updateAgent(agentId, updates, actor='ui')
    if not agent:
        raise HTTPException(status_code=404, detail='Agent not found')
    return agent


@router.delete('/{agentId}')
async def deleteAgent(agentId: str):
    if not agent_registry.deleteAgent(agentId, actor='ui'):
        raise HTTPException(status_code=404, detail='Agent not found')
    return {'status': 'ok', 'deleted': agentId}


@router.get('/{agentId}/tree')
async def getAgentTree(agentId: str):
    """Get an agent and its direct children."""
    tree = agent_registry.getAgentTree(agentId)
    if not tree:
        raise HTTPException(status_code=404, detail='Agent not found')
    return tree
