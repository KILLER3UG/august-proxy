"""
``spawn_subagents`` tool — registered alongside ``spawn_subagent``.

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
      "mode": "auto" | "proposed" | "negotiated" (default 'auto'),
      "background": bool (default true) — return immediately; each
        completion is delivered to the parent model as it settles
    }

Modes
-----
- ``auto``: spawn immediately.
- ``proposed``: emit a ``subagentProposed`` event for user approval before
  spawning. The frontend shows an approval card; the user must approve via
  ``POST /api/subagents/propose-breakdown`` before spawning begins.
- ``negotiated``: like proposed, but the orchestrator may rebalance work
  items before spawning.

Background (default)
--------------------
When ``background`` is true (the default for multi-spawn), the tool returns
as soon as every worker is dispatched. Each subagent's completion is emitted
as an SSE event *and* enqueued for the parent model so the parent sees
per-subagent results incrementally rather than after a blocking join.
"""

from __future__ import annotations
import logging
from typing import Any, Callable
from app.services.subagent_orchestrator import SubagentOrchestrator, SubagentSpawnRequest

logger = logging.getLogger(__name__)
TOOL_NAME = 'spawn_subagents'
TOOL_DEFINITION = {
    'name': TOOL_NAME,
    'description': (
        'Spawn multiple sub-agents in parallel for independent work items. '
        'Prefer this (or several spawn_subagent calls in one turn) when investigating '
        'different areas at once. By default returns immediately after dispatch; each '
        'subagent completion is delivered to you individually as it finishes. '
        'Set background=false only when you must block until every item completes.'
    ),
    'input_schema': {
        'type': 'object',
        'properties': {
            'workItems': {
                'type': 'array',
                'items': {
                    'type': 'object',
                    'properties': {
                        'goal': {'type': 'string', 'description': 'The goal/instruction for this sub-agent.'},
                        'agentId': {
                            'type': 'string',
                            'description': "Agent ID to use (e.g. 'explore', 'general'). Default 'general'.",
                            'default': 'general',
                        },
                        'restrictedTools': {
                            'type': 'array',
                            'items': {'type': 'string'},
                            'description': 'Tool names this sub-agent is restricted from using.',
                        },
                        'context': {'type': 'string', 'description': 'Additional context for the sub-agent.'},
                    },
                    'required': ['goal'],
                },
                'minItems': 1,
                'maxItems': 10,
            },
            'mode': {
                'type': 'string',
                'enum': ['auto', 'proposed', 'negotiated'],
                'default': 'auto',
                'description': "Spawn mode: 'auto' spawns immediately, 'proposed' requires user approval.",
            },
            'background': {
                'type': 'boolean',
                'default': True,
                'description': (
                    'If true (default), return as soon as workers are dispatched and deliver '
                    'each completion to you as it settles. If false, block until all finish.'
                ),
            },
        },
        'required': ['workItems'],
    },
}
_pendingProposals: dict[str, dict[str, Any]] = {}


def _session_id(session: object) -> str:
    if hasattr(session, 'id'):
        return str(session.id)
    if isinstance(session, dict):
        return str(session.get('id', '') or '')
    return ''


def _format_completion_notice(result: dict[str, Any]) -> str:
    task_id = result.get('taskId', '')
    agent_id = result.get('agentId', 'general')
    status = result.get('status', 'completed')
    goal = str(result.get('goal') or '')[:200]
    payload = result.get('result')
    if isinstance(payload, dict):
        text = str(payload.get('result') or payload.get('output') or payload.get('error') or '')
    else:
        text = str(payload or result.get('error') or '')
    text = text.strip()
    if len(text) > 8000:
        text = text[:8000] + '\n…[truncated]'
    lines = [
        f'[SUBAGENT_COMPLETE taskId="{task_id}" agentId="{agent_id}" status="{status}"]',
        f'goal: {goal}' if goal else '',
        text or '(empty result)',
        '[/SUBAGENT_COMPLETE]',
    ]
    return '\n'.join(line for line in lines if line)


def _enqueue_completion(session: object, result: dict[str, Any]) -> None:
    """Deliver one settled subagent result to the parent model ASAP."""
    sid = _session_id(session)
    if not sid:
        return
    try:
        from app.services.workbench.workbench import enqueueUserMessage

        enqueueUserMessage(sid, _format_completion_notice(result), kind='subagent')
    except Exception:
        logger.debug('failed to enqueue subagent completion', exc_info=True)


async def executeSpawnSubagents(
    orchestrator: SubagentOrchestrator,
    session: object,
    workItems: list[dict[str, Any]],
    mode: str = 'auto',
    emit: Callable | None = None,
    background: bool = True,
) -> dict[str, Any]:
    """Execute the spawn_subagents tool.

    Args:
        orchestrator: The subagent orchestrator instance.
        session: The parent session object.
        workItems: List of work item dicts (goal, agentId, etc.).
        mode: Spawn mode ('auto', 'proposed', 'negotiated').
        emit: Optional SSE event emitter.
        background: If True, return after dispatch; completions arrive per-subagent.

    Returns:
        Result dict with ``status`` and either ``handles`` (background) or ``results``.
    """
    if mode == 'proposed':
        proposalId = f'proposal_{__import__("uuid").uuid4().hex[:8]}'
        _pendingProposals[proposalId] = {
            'workItems': workItems,
            'session': session,
            'mode': mode,
            'background': background,
            'createdAt': __import__('time').time(),
        }
        if emit:
            emit(
                {
                    'type': 'subagentProposed',
                    'proposalId': proposalId,
                    'workBreakdown': [
                        {'goal': item.get('goal', ''), 'agentId': item.get('agentId', 'general')} for item in workItems
                    ],
                }
            )
        return {
            'status': 'awaiting_approval',
            'proposalId': proposalId,
            'message': f'Proposal {proposalId} created. Waiting for user approval.',
        }
    return await _doSpawn(orchestrator, session, workItems, emit=emit, background=background)


async def approveProposal(orchestrator: SubagentOrchestrator, proposalId: str) -> dict[str, Any]:
    """Approve a pending proposal and trigger spawning."""
    proposal = _pendingProposals.pop(proposalId, None)
    if not proposal:
        return {'status': 'error', 'error': f'Proposal {proposalId} not found or already expired.'}
    return await _doSpawn(
        orchestrator,
        proposal['session'],
        proposal['workItems'],
        emit=None,
        background=bool(proposal.get('background', True)),
    )


async def _doSpawn(
    orchestrator: SubagentOrchestrator,
    session: object,
    workItems: list[dict[str, Any]],
    emit: Any | None = None,
    background: bool = True,
) -> dict[str, Any]:
    """Spawn sub-agents; optionally wait or return after dispatch."""
    request = SubagentSpawnRequest(
        session=session,
        workItems=[
            {
                'goal': item.get('goal', ''),
                'agentId': item.get('agentId', 'general'),
                'restrictedTools': item.get('restrictedTools'),
                'context': item.get('context', ''),
            }
            for item in workItems
        ],
        mode='auto',
    )
    handles = await orchestrator.spawn(request)
    dispatch = [
        {
            'taskId': h.taskId,
            'agentId': h.agentId,
            'goal': h.goal,
            'status': h.status,
        }
        for h in handles
    ]
    if emit:
        for h in handles:
            emit(
                {
                    'type': 'subagentStart',
                    'jobId': h.taskId,
                    'agentId': h.agentId,
                    'task': h.goal,
                }
            )

    if background:
        # Watch completions without blocking the parent tool result.
        async def _watch() -> None:
            try:
                async for result in orchestrator.waitForEach(handles):
                    if emit:
                        emit(
                            {
                                'type': 'subagentDone',
                                'jobId': result.get('taskId'),
                                'status': result.get('status'),
                                'result': result.get('result'),
                                'message': result.get('error') or '',
                            }
                        )
                    _enqueue_completion(session, result)
            except Exception:
                logger.exception('background subagent watch failed')

        import asyncio

        asyncio.create_task(_watch())
        return {
            'status': 'started',
            'total': len(handles),
            'background': True,
            'handles': dispatch,
            'message': (
                f'Dispatched {len(handles)} subagent(s). Each completion will be delivered '
                'to you individually as it finishes — do not poll; continue other work or wait.'
            ),
        }

    # Blocking: still emit/enqueue incrementally as each settles, then return join.
    results: list[dict[str, Any]] = []
    async for result in orchestrator.waitForEach(handles):
        results.append(result)
        if emit:
            emit(
                {
                    'type': 'subagentDone',
                    'jobId': result.get('taskId'),
                    'status': result.get('status'),
                    'result': result.get('result'),
                    'message': result.get('error') or '',
                }
            )
        _enqueue_completion(session, result)

    succeeded = sum((1 for r in results if r['status'] == 'completed'))
    failed = sum((1 for r in results if r['status'] in ('failed', 'error')))
    return {
        'status': 'completed' if failed == 0 else 'partial' if succeeded > 0 else 'failed',
        'total': len(results),
        'succeeded': succeeded,
        'failed': failed,
        'background': False,
        'results': results,
    }
