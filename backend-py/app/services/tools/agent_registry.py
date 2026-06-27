"""
Agent registry — hierarchical agent management, job tracking, and sub-agent dispatch.

Port of backend/services/tools/agent-registry.js + agent-sessions.js + agent-jobs.js + agent-tree.js.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime
from typing import Any

from app.services.memory_store import save_memory, get_memory, record_config_audit

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


def create_agent(
    name: str,
    parent_id: str = "",
    permissions: list[str] | None = None,
    toolsets: list[str] | None = None,
    model: str = "",
    provider: str = "",
    description: str = "",
    role: str = "",
    tools: list[str] | None = None,
    model_alias: str = "",
    parent_agent: str = "",
    actor: str = "system",
) -> dict[str, Any]:
    """Create a new agent in the hierarchy.

    Extended schema fields (description, role, tools, modelAlias) align with
    the autonomous-creation spec; ``parent_agent`` is an alias for
    ``parent_id`` (spec uses ``parentAgent``).
    """
    resolved_parent = parent_id or parent_agent
    agents = list_agents()
    agent_id = f"agent_{uuid.uuid4().hex[:8]}"
    agent = {
        "id": agent_id,
        "name": name,
        "description": description,
        "role": role,
        "parentId": resolved_parent or None,
        "permissions": permissions or [],
        "toolsets": toolsets or [],
        "tools": tools or [],
        "model": model,
        "provider": provider,
        "modelAlias": model_alias,
        "createdAt": _now(),
        "depth": _calculate_depth(resolved_parent, agents),
    }
    agents.append(agent)
    save_memory(_AGENTS_KEY, agents)
    record_config_audit("agent", "create", actor, before=None, after=agent)
    return agent


def update_agent(agent_id: str, updates: dict[str, Any], actor: str = "system") -> dict[str, Any] | None:
    agents = list_agents()
    for a in agents:
        if a["id"] == agent_id:
            before = dict(a)
            a.update(updates)
            save_memory(_AGENTS_KEY, agents)
            record_config_audit("agent", "update", actor, before=before, after=a)
            return a
    return None


def delete_agent(agent_id: str, actor: str = "system") -> bool:
    agents = list_agents()
    before = next((a for a in agents if a["id"] == agent_id), None)
    new_agents = [a for a in agents if a["id"] != agent_id]
    if len(new_agents) == len(agents):
        return False
    save_memory(_AGENTS_KEY, new_agents)
    record_config_audit("agent", "delete", actor, before=before, after=None)
    return True


def get_agent_tree(agent_id: str) -> dict[str, Any] | None:
    """Get an agent and its children as a tree."""
    agent = get_agent(agent_id)
    if not agent:
        return None
    all_agents = list_agents()
    children = [a for a in all_agents if a.get("parentId") == agent_id]
    return {"agent": agent, "children": children}


def get_agent_tree_rooted(root: str = "", max_depth: int = 4) -> dict[str, Any]:
    """Build a recursive agent tree from ``root`` (or all roots if empty).

    Used by the frontend AgentTree via ``GET /api/agents/tree?root=&maxDepth=``.
    """
    all_agents = list_agents()

    def build_node(agent: dict[str, Any], depth: int) -> dict[str, Any]:
        children = []
        if depth < max_depth:
            for a in all_agents:
                if a.get("parentId") == agent.get("id"):
                    children.append(build_node(a, depth + 1))
        return {"agent": agent, "children": children}

    if root:
        root_agent = next((a for a in all_agents if a.get("id") == root), None)
        if not root_agent:
            return {"agent": None, "children": []}
        return build_node(root_agent, 0)

    # No root → return forest of top-level agents (no parentId).
    roots = [a for a in all_agents if not a.get("parentId")]
    return {"agent": None, "children": [build_node(a, 0) for a in roots]}


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


def _effective_permissions(agent_id: str) -> set[str] | None:
    """Resolve the effective permission set, walking parents.

    Returns ``None`` when ``"all"`` appears in the chain (no restriction),
    otherwise the most-restrictive intersection across the lineage.
    """
    agent = get_agent(agent_id)
    if not agent:
        return set()
    perms = set(agent.get("permissions") or [])
    if "all" in perms:
        return None
    parent_id = agent.get("parentId")
    if parent_id:
        parent_eff = _effective_permissions(parent_id)
        if parent_eff is None:
            return perms
        return perms & parent_eff
    return perms


def derive_child_permissions(parent_id: str, child_id: str) -> list[str]:
    """Most-restrictive merge of a child's permissions under its parent.

    Port of ``agent-registry.js``'s ``deriveChildAgentPermissions``, adapted
    to the flat-list permission model (deny/allow/ask categories don't exist
    here, so the merge is a set intersection).
    """
    child_eff = _effective_permissions(child_id)
    if child_eff is None:
        return ["all"]
    parent_eff = _effective_permissions(parent_id)
    if parent_eff is None:
        return sorted(child_eff)
    return sorted(child_eff & parent_eff)


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
    if agent.get("role"):
        parts.append(f"Role: {agent['role']}")
    if agent.get("description"):
        parts.append(f"Description: {agent['description']}")
    if agent.get("tools"):
        parts.append(f"Tools: {', '.join(agent['tools'])}")
    if agent.get("permissions"):
        parts.append(f"Permissions: {', '.join(agent['permissions'])}")
    if agent.get("toolsets"):
        parts.append(f"Toolsets: {', '.join(agent['toolsets'])}")
    if agent.get("modelAlias"):
        parts.append(f"Model alias: {agent['modelAlias']}")
    return "\n".join(parts)
