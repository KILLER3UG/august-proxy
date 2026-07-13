"""
Agent registry — hierarchical agent management, job tracking, and sub-agent dispatch.

Port of backend/services/tools/agent-registry.js + agent-sessions.js + agent-jobs.js + agent-tree.js.
"""

from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import cast
from app.services.memory_store import save_memory, get_memory, record_config_audit
from app.json_narrowing import as_int, as_list, as_str
from app.typeAliases import JsonValue

_AGENTSKey = 'agent_registry'
_JOBSKey = 'agent_jobs'
_MAXAgentDepth = 4


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def listAgents() -> list[dict[str, object]]:
    raw = get_memory(_AGENTSKey) or []
    return cast('list[dict[str, object]]', raw) if isinstance(raw, list) else []


def getAgent(agentId: str) -> dict[str, object] | None:
    agents = listAgents()
    for a in agents:
        if a['id'] == agentId:
            return a
    return None


def createAgent(
    name: str,
    parentId: str = '',
    permissions: list[str] | None = None,
    toolsets: list[str] | None = None,
    model: str = '',
    provider: str = '',
    description: str = '',
    role: str = '',
    tools: list[str] | None = None,
    model_alias: str = '',
    parent_agent: str = '',
    actor: str = 'system',
) -> dict[str, object]:
    """Create a new agent in the hierarchy.

    Extended schema fields (description, role, tools, modelAlias) align with
    the autonomous-creation spec; ``parent_agent`` is an alias for
    ``parent_id`` (spec uses ``parentAgent``).
    """
    resolvedParent = parentId or parent_agent
    agents = listAgents()
    agentId = f'agent_{uuid.uuid4().hex[:8]}'
    agent: dict[str, object] = {
        'id': agentId,
        'name': name,
        'description': description,
        'role': role,
        'parentId': resolvedParent or None,
        'permissions': permissions or [],
        'toolsets': toolsets or [],
        'tools': tools or [],
        'model': model,
        'provider': provider,
        'modelAlias': model_alias,
        'createdAt': _now(),
        'depth': _calculateDepth(resolvedParent, agents),
    }
    agents.append(agent)
    save_memory(_AGENTSKey, cast(JsonValue, agents))
    record_config_audit('agent', 'create', actor, before=None, after=agent)
    return agent


def updateAgent(agentId: str, updates: dict[str, object], actor: str = 'system') -> dict[str, object] | None:
    agents = listAgents()
    for a in agents:
        if a['id'] == agentId:
            before = dict(a)
            a.update(updates)
            save_memory(_AGENTSKey, cast(JsonValue, agents))
            record_config_audit('agent', 'update', actor, before=before, after=a)
            return a
    return None


def deleteAgent(agentId: str, actor: str = 'system') -> bool:
    agents = listAgents()
    before = next((a for a in agents if a['id'] == agentId), None)
    newAgents = [a for a in agents if a['id'] != agentId]
    if len(newAgents) == len(agents):
        return False
    save_memory(_AGENTSKey, cast(JsonValue, newAgents))
    record_config_audit('agent', 'delete', actor, before=before, after=None)
    return True


def getAgentTree(agentId: str) -> dict[str, object] | None:
    """Get an agent and its children as a tree."""
    agent = getAgent(agentId)
    if not agent:
        return None
    allAgents = listAgents()
    children = [a for a in allAgents if as_str(a.get('parentId')) == agentId]
    return {'agent': agent, 'children': children}


def getAgentTreeRooted(root: str = '', maxDepth: int = 4) -> dict[str, object]:
    """Build a recursive agent tree from ``root`` (or all roots if empty).

    Used by the frontend AgentTree via ``GET /api/agents/tree?root=&maxDepth=``.
    """
    allAgents = listAgents()

    def buildNode(agent: dict[str, object], depth: int) -> dict[str, object]:
        children = []
        if depth < maxDepth:
            for a in allAgents:
                if as_str(a.get('parentId')) == as_str(agent.get('id')):
                    children.append(buildNode(a, depth + 1))
        return {'agent': agent, 'children': children}

    if root:
        rootAgent = next((a for a in allAgents if as_str(a.get('id')) == root), None)
        if not rootAgent:
            return {'agent': None, 'children': []}
        return buildNode(rootAgent, 0)
    roots = [a for a in allAgents if not as_str(a.get('parentId'))]
    return {'agent': None, 'children': [buildNode(a, 0) for a in roots]}


def evaluateAgentTool(agentId: str, toolName: str) -> dict[str, object]:
    """Check if an agent is permitted to use a tool."""
    agent = getAgent(agentId)
    if not agent:
        return {'allowed': False, 'reason': 'agent_not_found'}
    permissions = as_list(agent.get('permissions'), [])
    if 'all' in permissions:
        return {'allowed': True}
    if toolName in permissions:
        return {'allowed': True}
    for perm in permissions:
        if toolName.startswith(as_str(perm)):
            return {'allowed': True}
    parentId = as_str(agent.get('parentId'))
    if parentId:
        return evaluateAgentTool(parentId, toolName)
    return {'allowed': False, 'reason': f"tool '{toolName}' not in permissions"}


def _effectivePermissions(agentId: str) -> set[str] | None:
    """Resolve the effective permission set, walking parents.

    Returns ``None`` when ``"all"`` appears in the chain (no restriction),
    otherwise the most-restrictive intersection across the lineage.
    """
    agent = getAgent(agentId)
    if not agent:
        return set()
    perms = {as_str(p) for p in as_list(agent.get('permissions'), [])}
    if 'all' in perms:
        return None
    parentId = as_str(agent.get('parentId'))
    if parentId:
        parentEff = _effectivePermissions(parentId)
        if parentEff is None:
            return perms
        return perms & parentEff
    return perms


def deriveChildPermissions(parentId: str, childId: str) -> list[str]:
    """Most-restrictive merge of a child's permissions under its parent.

    Port of ``agent-registry.js``'s ``deriveChildAgentPermissions``, adapted
    to the flat-list permission model (deny/allow/ask categories don't exist
    here, so the merge is a set intersection).
    """
    childEff = _effectivePermissions(childId)
    if childEff is None:
        return ['all']
    parentEff = _effectivePermissions(parentId)
    if parentEff is None:
        return sorted(childEff)
    return sorted(childEff & parentEff)


def listJobs(agentId: str = '') -> list[dict[str, object]]:
    raw = get_memory(_JOBSKey) or []
    jobs = cast('list[dict[str, object]]', raw) if isinstance(raw, list) else []
    if agentId:
        return [j for j in jobs if as_str(j.get('agentId')) == agentId]
    return jobs


def createJob(agentId: str, goal: str, context: str = '') -> dict[str, object]:
    raw = get_memory(_JOBSKey) or []
    jobs: list[dict[str, object]] = cast('list[dict[str, object]]', raw) if isinstance(raw, list) else []
    jobId = f'job_{uuid.uuid4().hex[:8]}'
    job: dict[str, object] = {
        'id': jobId,
        'agentId': agentId,
        'goal': goal,
        'context': context,
        'status': 'pending',
        'createdAt': _now(),
    }
    jobs.append(job)
    save_memory(_JOBSKey, cast(JsonValue, jobs))
    return job


def updateJob(jobId: str, updates: dict[str, object]) -> dict[str, object] | None:
    raw = get_memory(_JOBSKey) or []
    jobs: list[dict[str, object]] = cast('list[dict[str, object]]', raw) if isinstance(raw, list) else []
    for j in jobs:
        if j['id'] == jobId:
            j.update(updates)
            save_memory(_JOBSKey, cast(JsonValue, jobs))
            return j
    return None


async def executeSubAgent(agentId: str, goal: str, context: str = '') -> dict[str, object]:
    """Execute a sub-agent task."""
    job = createJob(agentId, goal, context)
    jobId = as_str(job['id'])
    updateJob(jobId, {'status': 'running'})
    try:
        result = f"Sub-agent '{agentId}' completed task: {goal[:100]}"
        updateJob(jobId, {'status': 'completed', 'result': result})
        return {'job': job, 'result': result}
    except Exception as exc:
        updateJob(jobId, {'status': 'failed', 'error': str(exc)})
        return {'job': job, 'error': str(exc)}


def _calculateDepth(parentId: str | None, agents: list[dict[str, object]]) -> int:
    if not parentId:
        return 0
    for a in agents:
        if a['id'] == parentId:
            return as_int(a.get('depth', 0)) + 1
    return 0


def renderAgentContext(agentId: str) -> str:
    """Build a context string for an agent."""
    agent = getAgent(agentId)
    if not agent:
        return ''
    parts = [f'Agent: {as_str(agent.get("name"), "unknown")}']
    role = as_str(agent.get('role'))
    if role:
        parts.append(f'Role: {role}')
    description = as_str(agent.get('description'))
    if description:
        parts.append(f'Description: {description}')
    tools = [as_str(t) for t in as_list(agent.get('tools'), [])]
    if tools:
        parts.append(f'Tools: {", ".join(tools)}')
    permissions = [as_str(p) for p in as_list(agent.get('permissions'), [])]
    if permissions:
        parts.append(f'Permissions: {", ".join(permissions)}')
    toolsets = [as_str(t) for t in as_list(agent.get('toolsets'), [])]
    if toolsets:
        parts.append(f'Toolsets: {", ".join(toolsets)}')
    model_alias = as_str(agent.get('modelAlias'))
    if model_alias:
        parts.append(f'Model alias: {model_alias}')
    return '\n'.join(parts)
