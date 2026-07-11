"""Agent system API routes.

Backed by the persistent ``agent_registry`` service (SQLite KV) — the
previous in-memory store is gone, so agents now survive restarts. Adds an
update route and a rooted-tree query used by the frontend AgentTree.
"""
from __future__ import annotations
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from app.services.tools import agent_registry
router = APIRouter(prefix='/api/agents')

class AgentCreate(BaseModel):
    name: str
    parentId: str = ''
    parentAgent: str = ''
    permissions: list[str] = []
    toolsets: list[str] = []
    tools: list[str] = []
    model: str = ''
    provider: str = ''
    modelAlias: str = ''
    role: str = ''
    description: str = ''

class AgentUpdate(BaseModel):
    name: str | None = None
    parentId: str | None = None
    permissions: list[str] | None = None
    toolsets: list[str] | None = None
    tools: list[str] | None = None
    model: str | None = None
    provider: str | None = None
    modelAlias: str | None = None
    role: str | None = None
    description: str | None = None

class AgentJob(BaseModel):
    agentId: str
    goal: str
    context: str = ''

@router.get('')
async def listAgents():
    """List all registered agents."""
    return {'agents': agent_registry.listAgents()}

@router.post('')
async def createAgent(body: AgentCreate):
    """Register a new agent (persisted)."""
    return agent_registry.createAgent(name=body.name, parentId=body.parentId, parentAgent=body.parentAgent, permissions=body.permissions, toolsets=body.toolsets, tools=body.tools, model=body.model, provider=body.provider, modelAlias=body.modelAlias, role=body.role, description=body.description, actor='ui')

@router.get('/tree')
async def getTree(root: str='', maxDepth: int=Query(4)):
    """Return a recursive agent tree (frontend AgentTree)."""
    return agent_registry.getAgentTreeRooted(root=root, maxDepth=maxDepth)

@router.get('/{agentId}')
async def getAgent(agentId: str):
    agent = agent_registry.getAgent(agentId)
    if not agent:
        raise HTTPException(status_code=404, detail='Agent not found')
    return agent

@router.put('/{agentId}')
async def updateAgent(agentId: str, body: AgentUpdate):
    """Update an existing agent's configuration."""
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
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
    tree = agent_registry.getAgent_tree(agentId)
    if not tree:
        raise HTTPException(status_code=404, detail='Agent not found')
    return tree

@router.post('/jobs')
async def createJob(body: AgentJob):
    return agent_registry.create_job(body.agentId, body.goal, body.context)

@router.get('/jobs')
async def listJobs(agentId: str=''):
    return {'jobs': agent_registry.listJobs(agentId)}

@router.get('/jobs/{job_id}')
async def getJob(jobId: str):
    for job in agent_registry.listJobs():
        if job.get('id') == jobId:
            return job
    raise HTTPException(status_code=404, detail='Job not found')