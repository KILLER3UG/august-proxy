"""
Sub-agent worker — runs a single sub-agent task, publishing lifecycle
events to the ``AgentMessageBus``.

Pipeline
--------
1. Inherit parent tools from the tool registry
2. Filter by ``restrictedTools`` allowlist (if provided)
3. Build agent context
4. Invoke ``executeSubAgent()`` (the existing single-agent runner)
5. Publish events (progress, result, failure) to the message bus
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from app.json_narrowing import as_str
from app.services.agent_message_bus import AgentMessageBus

logger = logging.getLogger(__name__)


async def runSubagent(
    bus: AgentMessageBus,
    session: object,
    agentId: str,
    goal: str,
    context: str = '',
    taskId: str | None = None,
    restrictedTools: list[str] | None = None,
    yieldSchema: dict[str, Any] | None = None,
    effort: str = 'medium',
    model: str = '',
    parentToolRegistry: Callable | None = None,
    parentOpenaiTools: Callable | None = None,
    emit: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Run a sub-agent and publish lifecycle events to the bus.

    Args:
        bus: Shared message bus for inter-agent coordination.
        session: The parent session object.
        agentId: Agent id to run.
        goal: The goal / instruction for this sub-agent.
        context: Additional context text.
        taskId: Unique task identifier (auto-generated if not provided).
        restrictedTools: Optional list of tool names the agent is restricted
            from using. If None, all tools are inherited.
        yieldSchema: Optional JSON Schema — the sub-agent returns a single
            JSON object matching it (validated before delivery).
        effort: Reasoning/thinking budget for this sub-agent ('low'|'medium'|'high'|'max').
        model: Optional model override (agent alias / smol role routing is
            the default when blank).
        parentToolRegistry: Function returning the parent's tool list.
        parentOpenaiTools: Function returning the parent's OpenAI-format tools.
        emit: Optional callback for direct event emission (legacy path).

    Returns:
        Result dict with keys ``taskId``, ``agentId``, ``status``, ``result``.
    """
    import uuid

    if taskId is None:
        taskId = f'task_{uuid.uuid4().hex[:12]}'

    # NOTE: lifecycle signaling is handled by the orchestrator (handle
    # status + return dict) and the spawn tool's SSE emits. The message-bus
    # topic publishes that used to live here were dead letters — nothing
    # subscribed to task:{taskId}:{progress|result|failure}.

    def _combinedEmit(ev: dict[str, Any]) -> None:
        if emit:
            emit(ev)

    async def _failAndBroadcast(errorMsg: str) -> dict[str, Any]:
        return {'taskId': taskId, 'agentId': agentId, 'status': 'failed', 'error': errorMsg}

    try:
        from app.services.workbench.subagent import executeSubAgent

        # restrictedTools is applied inside executeSubAgent (both wire formats)
        # — never monkeypatch the module-level toolDefinitions, which races
        # across concurrent workers.
        restrictedNames = set(restrictedTools) if restrictedTools else None
        subResult = await executeSubAgent(
            session,
            agentId,
            goal,
            context,
            emit=_combinedEmit,
            restricted_names=restrictedNames,
            yield_schema=yieldSchema,
            effort=effort or 'medium',
            model_override=model or '',
        )
        status = as_str(subResult.get('status'), 'completed')
        if status != 'completed':
            return await _failAndBroadcast(as_str(subResult.get('error'), 'Unknown error'))
        return {'taskId': taskId, 'agentId': agentId, 'status': status, 'result': as_str(subResult.get('result'), '')}
    except Exception as exc:
        logger.exception('[SubagentWorker] error running agent %s', agentId)
        return await _failAndBroadcast(str(exc))
