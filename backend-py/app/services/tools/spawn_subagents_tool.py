"""
``spawn_subagents`` tool — registered in ``tool_definitions.py`` alongside
the existing ``spawn_subagent`` tool.

Enables an agent to spawn multiple sub-agents in parallel via the
``SubagentOrchestrator``.

Schema
------
    {
      "workItems": [
        {
          "goal": "string (required)",
          "agentId": "string (optional, default 'general')",
          "restrictedTools": ["string"] (optional),
          "context": "string (optional)"
        }
      ],
      "mode": "auto" | "proposed" | "negotiated" (default 'auto')
    }

Modes
-----
- ``auto``: spawn immediately.
- ``proposed``: emit a ``subagentProposed`` event for user approval before
  spawning. The frontend shows an approval card; the user must approve via
  ``POST /api/subagents/propose-breakdown`` before spawning begins.
- ``negotiated``: like proposed, but the orchestrator may rebalance work
  items before spawning.
"""
from __future__ import annotations
import json
import logging
from typing import Any
from app.services.subagent_orchestrator import SubagentOrchestrator, SubagentSpawnRequest
logger = logging.getLogger(__name__)
TOOL_NAME = 'spawn_subagents'
TOOL_DEFINITION = {'name': TOOL_NAME, 'description': 'Spawn multiple sub-agents in parallel to complete independent work items. Each sub-agent receives its own goal and can be given a restricted set of tools. Returns consolidated results when all sub-agents complete.', 'input_schema': {'type': 'object', 'properties': {'workItems': {'type': 'array', 'items': {'type': 'object', 'properties': {'goal': {'type': 'string', 'description': 'The goal/instruction for this sub-agent.'}, 'agentId': {'type': 'string', 'description': "Agent ID to use (default 'general').", 'default': 'general'}, 'restrictedTools': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Tool names this sub-agent is restricted from using.'}, 'context': {'type': 'string', 'description': 'Additional context for the sub-agent.'}}, 'required': ['goal']}, 'minItems': 1, 'maxItems': 10}, 'mode': {'type': 'string', 'enum': ['auto', 'proposed', 'negotiated'], 'default': 'auto', 'description': "Spawn mode: 'auto' spawns immediately, 'proposed' requires user approval."}}, 'required': ['workItems']}}
_pendingProposals: dict[str, dict[str, Any]] = {}

async def executeSpawnSubagents(orchestrator: SubagentOrchestrator, session: object, workItems: list[dict[str, Any]], mode: str='auto', emit: Any | None=None) -> dict[str, Any]:
    """Execute the spawn_subagents tool.

    Args:
        orchestrator: The subagent orchestrator instance.
        session: The parent session object.
        workItems: List of work item dicts (goal, agentId, etc.).
        mode: Spawn mode ('auto', 'proposed', 'negotiated').
        emit: Optional SSE event emitter.

    Returns:
        Result dict with ``status`` and ``results`` keys.
    """
    if mode == 'proposed':
        proposalId = f"proposal_{__import__('uuid').uuid4().hex[:8]}"
        _pendingProposals[proposalId] = {'workItems': workItems, 'session': session, 'mode': mode, 'createdAt': __import__('time').time()}
        if emit:
            emit({'type': 'subagentProposed', 'proposalId': proposalId, 'workBreakdown': [{'goal': item.get('goal', ''), 'agentId': item.get('agentId', 'general')} for item in workItems]})
        return {'status': 'awaiting_approval', 'proposalId': proposalId, 'message': f'Proposal {proposalId} created. Waiting for user approval.'}
    return await _doSpawn(orchestrator, session, workItems, emit=emit)

async def approveProposal(orchestrator: SubagentOrchestrator, proposalId: str) -> dict[str, Any]:
    """Approve a pending proposal and trigger spawning."""
    proposal = _pendingProposals.pop(proposalId, None)
    if not proposal:
        return {'status': 'error', 'error': f'Proposal {proposalId} not found or already expired.'}
    return await _doSpawn(orchestrator, proposal['session'], proposal['workItems'], emit=None)

async def _doSpawn(orchestrator: SubagentOrchestrator, session: object, workItems: list[dict[str, Any]], emit: Any | None=None) -> dict[str, Any]:
    """Actually spawn the sub-agents and collect results."""
    request = SubagentSpawnRequest(session=session, workItems=[{'goal': item.get('goal', ''), 'agentId': item.get('agentId', 'general'), 'restrictedTools': item.get('restrictedTools'), 'context': item.get('context', '')} for item in workItems], mode='auto')
    handles = await orchestrator.spawn(request)
    results = await orchestrator.waitForAll(handles)
    succeeded = sum((1 for r in results if r['status'] == 'completed'))
    failed = sum((1 for r in results if r['status'] in ('failed', 'error')))
    return {'status': 'completed' if failed == 0 else 'partial' if succeeded > 0 else 'failed', 'total': len(results), 'succeeded': succeeded, 'failed': failed, 'results': results}