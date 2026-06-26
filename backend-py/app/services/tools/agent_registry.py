"""
Agent registry — hierarchical agent management, job tracking, and sub-agent dispatch.

Port of backend/services/tools/agent-registry.js + agent-sessions.js + agent-jobs.js + agent-tree.js.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime
from typing import Any

from app.services.memory_store import save_memory, get_memory

_AGENTS_KEY = "agent_registry"
_JOBS_KEY = "agent_jobs"
_MAX_AGENT_DEPTH = 4


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


# ── Agent CRUD ───────────────────────────────────────────────────────


def list_agents() -> list[dict[str, Any]]:
    return get_memory(_AGENTS_KEY) or []


def get_agent(agent_id: str) -> dict[str, Any] | None:
    agents = list_agents()
    for a in agents:
        if a["id"] == agent_id:
            return a
    return None


def create_agent(name: str, parent_id: str = "", permissions: list[str] | None = None, toolsets: list[str] | None = None, model: str = "", provider: str = "") -> dict[str, Any]:
    """Create a new agent in the hierarchy."""
    agents = list_agents()
    agent_id = f"agent_{uuid.uuid4().hex[:8]}"
    agent = {
        "id": agent_id,
        "name": name,
        "parentId": parent_id or None,
        "permissions": permissions or [],
        "toolsets": toolsets or [],
        "model": model,
        "provider": provider,
        "createdAt": _now(),
        "depth": _calculate_depth(parent_id, agents),
    }
    agents.append(agent)
    save_memory(_AGENTS_KEY, agents)
    return agent


def update_agent(agent_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    agents = list_agents()
    for a in agents:
        if a["id"] == agent_id:
            a.update(updates)
            save_memory(_AGENTS_KEY, agents)
            return a
    return None


def delete_agent(agent_id: str) -> bool:
    agents = list_agents()
    new_agents = [a for a in agents if a["id"] != agent_id]
    if len(new_agents) == len(agents):
        return False
    save_memory(_AGENTS_KEY, new_agents)
    return True


def get_agent_tree(agent_id: str) -> dict[str, Any] | None:
    """Get an agent and its children as a tree."""
    agent = get_agent(agent_id)
    if not agent:
        return None
    all_agents = list_agents()
    children = [a for a in all_agents if a.get("parentId") == agent_id]
    return {"agent": agent, "children": children}


# ── Permissions ──────────────────────────────────────────────────────


def evaluate_agent_tool(agent_id: str, tool_name: str) -> dict[str, Any]:
    """Check if an agent is permitted to use a tool."""
    agent = get_agent(agent_id)
    if not agent:
        return {"allowed": False, "reason": "agent_not_found"}

    permissions = agent.get("permissions", [])
    if "all" in permissions:
        return {"allowed": True}

    # Check tool-specific permission
    if tool_name in permissions:
        return {"allowed": True}

    # Check tool category
    for perm in permissions:
        if tool_name.startswith(perm):
            return {"allowed": True}

    # Inherit from parent
    parent_id = agent.get("parentId")
    if parent_id:
        return evaluate_agent_tool(parent_id, tool_name)

    return {"allowed": False, "reason": f"tool '{tool_name}' not in permissions"}


# ── Jobs ──────────────────────────────────────────────────────────────


def list_jobs(agent_id: str = "") -> list[dict[str, Any]]:
    jobs = get_memory(_JOBS_KEY) or []
    if agent_id:
        return [j for j in jobs if j.get("agentId") == agent_id]
    return jobs


def create_job(agent_id: str, goal: str, context: str = "") -> dict[str, Any]:
    jobs = get_memory(_JOBS_KEY) or []
    job_id = f"job_{uuid.uuid4().hex[:8]}"
    job = {
        "id": job_id,
        "agentId": agent_id,
        "goal": goal,
        "context": context,
        "status": "pending",
        "createdAt": _now(),
    }
    jobs.append(job)
    save_memory(_JOBS_KEY, jobs)
    return job


def update_job(job_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    jobs = get_memory(_JOBS_KEY) or []
    for j in jobs:
        if j["id"] == job_id:
            j.update(updates)
            save_memory(_JOBS_KEY, jobs)
            return j
    return None


async def execute_sub_agent(agent_id: str, goal: str, context: str = "") -> dict[str, Any]:
    """Execute a sub-agent task."""
    job = create_job(agent_id, goal, context)
    update_job(job["id"], {"status": "running"})

    try:
        # In a full implementation, this would make an HTTP call to
        # the workbench chat endpoint with the agent's model/provider
        result = f"Sub-agent '{agent_id}' completed task: {goal[:100]}"
        update_job(job["id"], {"status": "completed", "result": result})
        return {"job": job, "result": result}
    except Exception as exc:
        update_job(job["id"], {"status": "failed", "error": str(exc)})
        return {"job": job, "error": str(exc)}


# ── Helpers ──────────────────────────────────────────────────────────


def _calculate_depth(parent_id: str | None, agents: list[dict[str, Any]]) -> int:
    if not parent_id:
        return 0
    for a in agents:
        if a["id"] == parent_id:
            return a.get("depth", 0) + 1
    return 0


def render_agent_context(agent_id: str) -> str:
    """Build a context string for an agent."""
    agent = get_agent(agent_id)
    if not agent:
        return ""
    parts = [f"Agent: {agent.get('name', 'unknown')}"]
    if agent.get("permissions"):
        parts.append(f"Permissions: {', '.join(agent['permissions'])}")
    if agent.get("toolsets"):
        parts.append(f"Toolsets: {', '.join(agent['toolsets'])}")
    return "\n".join(parts)
