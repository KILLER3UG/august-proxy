"""Agent system API routes.

Backed by the persistent ``agent_registry`` service (SQLite KV) — the
previous in-memory store is gone, so agents now survive restarts. Adds an
update route and a rooted-tree query used by the frontend AgentTree.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.services.tools import agent_registry

router = APIRouter(prefix="/api/agents")


class AgentCreate(BaseModel):
    name: str
    parent_id: str = ""
    parent_agent: str = ""
    permissions: list[str] = []
    toolsets: list[str] = []
    tools: list[str] = []
    model: str = ""
    provider: str = ""
    model_alias: str = ""
    role: str = ""
    description: str = ""


class AgentUpdate(BaseModel):
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


class AgentJob(BaseModel):
    agent_id: str
    goal: str
    context: str = ""


@router.get("")
async def list_agents():
    """List all registered agents."""
    return {"agents": agent_registry.list_agents()}


@router.post("")
async def create_agent(body: AgentCreate):
    """Register a new agent (persisted)."""
    return agent_registry.create_agent(
        name=body.name,
        parent_id=body.parent_id,
        parent_agent=body.parent_agent,
        permissions=body.permissions,
        toolsets=body.toolsets,
        tools=body.tools,
        model=body.model,
        provider=body.provider,
        model_alias=body.model_alias,
        role=body.role,
        description=body.description,
        actor="ui",
    )


# Must be registered before /{agent_id} so "tree" isn't captured as an id.
@router.get("/tree")
async def get_tree(root: str = "", maxDepth: int = Query(4)):
    """Return a recursive agent tree (frontend AgentTree)."""
    return agent_registry.get_agent_tree_rooted(root=root, max_depth=maxDepth)


@router.get("/{agent_id}")
async def get_agent(agent_id: str):
    agent = agent_registry.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.put("/{agent_id}")
async def update_agent(agent_id: str, body: AgentUpdate):
    """Update an existing agent's configuration."""
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    agent = agent_registry.update_agent(agent_id, updates, actor="ui")
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.delete("/{agent_id}")
async def delete_agent(agent_id: str):
    if not agent_registry.delete_agent(agent_id, actor="ui"):
        raise HTTPException(status_code=404, detail="Agent not found")
    return {"status": "ok", "deleted": agent_id}


@router.get("/{agent_id}/tree")
async def get_agent_tree(agent_id: str):
    """Get an agent and its direct children."""
    tree = agent_registry.get_agent_tree(agent_id)
    if not tree:
        raise HTTPException(status_code=404, detail="Agent not found")
    return tree


# ── Jobs ─────────────────────────────────────────────────────────────


@router.post("/jobs")
async def create_job(body: AgentJob):
    return agent_registry.create_job(body.agent_id, body.goal, body.context)


@router.get("/jobs")
async def list_jobs(agent_id: str = ""):
    return {"jobs": agent_registry.list_jobs(agent_id)}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    for job in agent_registry.list_jobs():
        if job.get("id") == job_id:
            return job
    raise HTTPException(status_code=404, detail="Job not found")
