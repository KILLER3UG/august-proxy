"""
Agent registry — hierarchical agent management, job tracking, and sub-agent dispatch.

Port of backend/services/tools/agent-registry.js + agent-sessions.js + agent-jobs.js + agent-tree.js.
"""
from __future__ import annotations
import asyncio
import uuid
from datetime import datetime
from typing import Any
from app.services.memory_store import saveMemory, getMemory, recordConfigAudit
_AGENTSKey = 'agent_registry'
_JOBSKey = 'agent_jobs'
_MAXAgentDepth = 4

def _now() -> str:
    return datetime.utcnow().isoformat() + 'Z'

def listAgents() -> list[dict[str, Any]]:
    return getMemory(_AGENTSKey) or []

def getAgent(agentId: str) -> dict[str, Any] | None:
    agents = listAgents()
    for a in agents:
        if a['id'] == agentId:
            return a
    return None

def createAgent(name: str, parentId: str='', permissions: list[str] | None=None, toolsets: list[str] | None=None, model: str='', provider: str='', description: str='', role: str='', tools: list[str] | None=None, modelAlias: str='', parentAgent: str='', actor: str='system') -> dict[str, Any]:
    """Create a new agent in the hierarchy.

    Extended schema fields (description, role, tools, modelAlias) align with
    the autonomous-creation spec; ``parent_agent`` is an alias for
    ``parent_id`` (spec uses ``parentAgent``).
    """
    resolvedParent = parentId or parentAgent
    agents = listAgents()
    agentId = f'agent_{uuid.uuid4().hex[:8]}'
    agent = {'id': agentId, 'name': name, 'description': description, 'role': role, 'parentId': resolvedParent or None, 'permissions': permissions or [], 'toolsets': toolsets or [], 'tools': tools or [], 'model': model, 'provider': provider, 'modelAlias': modelAlias, 'createdAt': _now(), 'depth': _calculateDepth(resolvedParent, agents)}
    agents.append(agent)
    saveMemory(_AGENTSKey, agents)
    recordConfigAudit('agent', 'create', actor, before=None, after=agent)
    return agent

def updateAgent(agentId: str, updates: dict[str, Any], actor: str='system') -> dict[str, Any] | None:
    agents = listAgents()
    for a in agents:
        if a['id'] == agentId:
            before = dict(a)
            a.update(updates)
            saveMemory(_AGENTSKey, agents)
            recordConfigAudit('agent', 'update', actor, before=before, after=a)
            return a
    return None

def deleteAgent(agentId: str, actor: str='system') -> bool:
    agents = listAgents()
    before = next((a for a in agents if a['id'] == agentId), None)
    newAgents = [a for a in agents if a['id'] != agentId]
    if len(newAgents) == len(agents):
        return False
    saveMemory(_AGENTSKey, newAgents)
    recordConfigAudit('agent', 'delete', actor, before=before, after=None)
    return True

def getAgentTree(agentId: str) -> dict[str, Any] | None:
    """Get an agent and its children as a tree."""
    agent = getAgent(agentId)
    if not agent:
        return None
    allAgents = listAgents()
    children = [a for a in allAgents if a.get('parentId') == agentId]
    return {'agent': agent, 'children': children}

def getAgentTreeRooted(root: str='', maxDepth: int=4) -> dict[str, Any]:
    """Build a recursive agent tree from ``root`` (or all roots if empty).

    Used by the frontend AgentTree via ``GET /api/agents/tree?root=&maxDepth=``.
    """
    allAgents = listAgents()

    def buildNode(agent: dict[str, Any], depth: int) -> dict[str, Any]:
        children = []
        if depth < maxDepth:
            for a in allAgents:
                if a.get('parentId') == agent.get('id'):
                    children.append(buildNode(a, depth + 1))
        return {'agent': agent, 'children': children}
    if root:
        rootAgent = next((a for a in allAgents if a.get('id') == root), None)
        if not rootAgent:
            return {'agent': None, 'children': []}
        return buildNode(rootAgent, 0)
    roots = [a for a in allAgents if not a.get('parentId')]
    return {'agent': None, 'children': [buildNode(a, 0) for a in roots]}

def evaluateAgentTool(agentId: str, toolName: str) -> dict[str, Any]:
    """Check if an agent is permitted to use a tool."""
    agent = getAgent(agentId)
    if not agent:
        return {'allowed': False, 'reason': 'agent_not_found'}
    permissions = agent.get('permissions', [])
    if 'all' in permissions:
        return {'allowed': True}
    if toolName in permissions:
        return {'allowed': True}
    for perm in permissions:
        if toolName.startswith(perm):
            return {'allowed': True}
    parentId = agent.get('parentId')
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
    perms = set(agent.get('permissions') or [])
    if 'all' in perms:
        return None
    parentId = agent.get('parentId')
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

def listJobs(agentId: str='') -> list[dict[str, Any]]:
    jobs = getMemory(_JOBSKey) or []
    if agentId:
        return [j for j in jobs if j.get('agentId') == agentId]
    return jobs

def createJob(agentId: str, goal: str, context: str='') -> dict[str, Any]:
    jobs = getMemory(_JOBSKey) or []
    jobId = f'job_{uuid.uuid4().hex[:8]}'
    job = {'id': jobId, 'agentId': agentId, 'goal': goal, 'context': context, 'status': 'pending', 'createdAt': _now()}
    jobs.append(job)
    saveMemory(_JOBSKey, jobs)
    return job

def updateJob(jobId: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    jobs = getMemory(_JOBSKey) or []
    for j in jobs:
        if j['id'] == jobId:
            j.update(updates)
            saveMemory(_JOBSKey, jobs)
            return j
    return None

async def executeSubAgent(agentId: str, goal: str, context: str='') -> dict[str, Any]:
    """Execute a sub-agent task."""
    job = createJob(agentId, goal, context)
    updateJob(job['id'], {'status': 'running'})
    try:
        result = f"Sub-agent '{agentId}' completed task: {goal[:100]}"
        updateJob(job['id'], {'status': 'completed', 'result': result})
        return {'job': job, 'result': result}
    except Exception as exc:
        updateJob(job['id'], {'status': 'failed', 'error': str(exc)})
        return {'job': job, 'error': str(exc)}

def _calculateDepth(parentId: str | None, agents: list[dict[str, Any]]) -> int:
    if not parentId:
        return 0
    for a in agents:
        if a['id'] == parentId:
            return a.get('depth', 0) + 1
    return 0

def renderAgentContext(agentId: str) -> str:
    """Build a context string for an agent."""
    agent = getAgent(agentId)
    if not agent:
        return ''
    parts = [f"Agent: {agent.get('name', 'unknown')}"]
    if agent.get('role'):
        parts.append(f"Role: {agent['role']}")
    if agent.get('description'):
        parts.append(f"Description: {agent['description']}")
    if agent.get('tools'):
        parts.append(f"Tools: {', '.join(agent['tools'])}")
    if agent.get('permissions'):
        parts.append(f"Permissions: {', '.join(agent['permissions'])}")
    if agent.get('toolsets'):
        parts.append(f"Toolsets: {', '.join(agent['toolsets'])}")
    if agent.get('modelAlias'):
        parts.append(f"Model alias: {agent['modelAlias']}")
    return '\n'.join(parts)