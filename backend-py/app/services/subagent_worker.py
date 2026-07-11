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
import asyncio
import logging
import time
from typing import Any, Callable
from app.services.agent_message_bus import AgentMessageBus
from app.jsonUtils import as_str, as_dict, as_list, as_int

logger = logging.getLogger(__name__)


async def runSubagent(
    bus: AgentMessageBus,
    session: object,
    agentId: str,
    goal: str,
    context: str = '',
    taskId: str | None = None,
    restrictedTools: list[str] | None = None,
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
        parentToolRegistry: Function returning the parent's tool list.
        parentOpenaiTools: Function returning the parent's OpenAI-format tools.
        emit: Optional callback for direct event emission (legacy path).

    Returns:
        Result dict with keys ``taskId``, ``agentId``, ``status``, ``result``.
    """
    import uuid

    if taskId is None:
        taskId = f'task_{uuid.uuid4().hex[:12]}'
    startedAt = time.time()
    topicPrefix = f'task:{taskId}'
    await bus.publish(
        f'{topicPrefix}:progress',
        {'type': 'subagentStarted', 'taskId': taskId, 'agentId': agentId, 'goal': goal, 'timestamp': startedAt},
    )

    def _combinedEmit(ev: dict[str, Any]) -> None:
        if emit:
            emit(ev)
        evType = as_str(ev.get('type'), '')
        if evType in ('subagentText', 'subagentToolCall', 'subagentToolResult'):
            asyncio.ensure_future(
                bus.publish(f'{topicPrefix}:progress', {'type': evType, 'taskId': taskId, 'agentId': agentId, **ev})
            )

    async def _failAndBroadcast(errorMsg: str) -> dict[str, Any]:
        result = {'taskId': taskId, 'agentId': agentId, 'status': 'failed', 'error': errorMsg}
        await bus.publish(f'{topicPrefix}:failure', result)
        return result

    try:
        from app.services.workbench.subagent import executeSubAgent

        if restrictedTools:
            originalDefs = parentToolRegistry(session) if parentToolRegistry else None
            originalOpenai = parentOpenaiTools(session) if parentOpenaiTools else None
            if originalDefs:
                import app.services.workbench.workbench as wb

                originalTd = wb.toolDefinitions

                def filteredToolDefs(s):
                    allTools = originalTd(s)
                    return [t for t in allTools if t.get('name') not in restrictedTools]

                wb.toolDefinitions = filteredToolDefs
                try:
                    subResult = await executeSubAgent(session, agentId, goal, context, emit=_combinedEmit)
                finally:
                    wb.toolDefinitions = originalTd
            else:
                subResult = await executeSubAgent(session, agentId, goal, context, emit=_combinedEmit)
        else:
            subResult = await executeSubAgent(session, agentId, goal, context, emit=_combinedEmit)
        elapsed = time.time() - startedAt
        status = as_str(subResult.get('status'), 'completed')
        if status == 'completed':
            await bus.publish(
                f'{topicPrefix}:result',
                {
                    'type': 'subagentCompleted',
                    'taskId': taskId,
                    'agentId': agentId,
                    'result': as_str(subResult.get('result'), ''),
                    'elapsedS': round(elapsed, 2),
                },
            )
        else:
            return await _failAndBroadcast(as_str(subResult.get('error'), 'Unknown error'))
        return {'taskId': taskId, 'agentId': agentId, 'status': status, 'result': as_str(subResult.get('result'), '')}
    except Exception as exc:
        logger.exception('[SubagentWorker] error running agent %s', agentId)
        return await _failAndBroadcast(str(exc))
