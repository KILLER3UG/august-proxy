"""Agent system API routes.

Port of backend/services/tools/agent-registry.js + agent-sessions.js + agent-jobs.js + agent-tree.js.
Provides agent management, job tracking, and tree hierarchy.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from app.lib.camel_model import CamelModel

router = APIRouter(prefix="/api/agents")

# In-memory agent store (persisted via memory lifecycle)
_agents: dict[str, dict[str, Any]] = {}
_jobs: dict[str, dict[str, Any]] = {}


class AgentCreate(CamelModel):
    name: str
    parent_id: str = ""
    permissions: list[str] = []
    toolsets: list[str] = []
    model: str = ""
    provider: str = ""


class AgentJob(CamelModel):
    agent_id: str
    goal: str
    context: str = ""


@router.get("")
async def list_agents():
    """List all registered agents."""
    return {"agents": list(_agents.values())}


@router.post("")
async def create_agent(body: AgentCreate):
    """Register a new agent."""
    import uuid
    agent_id = f"agent_{uuid.uuid4().hex[:8]}"
    agent = {
        "id": agent_id,
        "name": body.name,
        "parentId": body.parent_id,
        "permissions": body.permissions,
        "toolsets": body.toolsets,
        "model": body.model or "",
        "provider": body.provider or "",
    }
    _agents[agent_id] = agent
    return agent


@router.get("/{agent_id}")
async def get_agent(agent_id: str):
    """Get an agent by ID."""
    agent = _agents.get(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.delete("/{agent_id}")
async def delete_agent(agent_id: str):
    """Delete an agent."""
    if agent_id not in _agents:
        raise HTTPException(status_code=404, detail="Agent not found")
    del _agents[agent_id]
    return {"status": "ok"}


@router.get("/{agent_id}/tree")
async def get_agent_tree(agent_id: str):
    """Get the agent tree hierarchy."""
    agent = _agents.get(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    # Build simple tree
    children = [a for a in _agents.values() if a.get("parentId") == agent_id]
    return {"agent": agent, "children": children}


@router.post("/jobs")
async def create_job(body: AgentJob):
    """Create a sub-agent job."""
    import uuid
    job_id = f"job_{uuid.uuid4().hex[:8]}"
    job = {
        "id": job_id,
        "agentId": body.agent_id,
        "goal": body.goal,
        "context": body.context,
        "status": "pending",
        "createdAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    }
    _jobs[job_id] = job
    return job


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    """Get a job by ID."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/jobs")
async def list_jobs(agent_id: str = ""):
    """List jobs, optionally filtered by agent."""
    if agent_id:
        jobs = [j for j in _jobs.values() if j.get("agentId") == agent_id]
    else:
        jobs = list(_jobs.values())
    return {"jobs": jobs}
