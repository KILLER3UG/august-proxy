"""
Sub-agent worker — runs a single sub-agent task, publishing lifecycle
events to the ``AgentMessageBus``.

Pipeline
--------
1. Inherit parent tools from the tool registry
2. Filter by ``restrictedTools`` allowlist (if provided)
3. Build agent context
4. Invoke ``execute_sub_agent()`` (the existing single-agent runner)
5. Publish events (progress, result, failure) to the message bus
"""
from __future__ import annotations
import asyncio
import logging
import time
from typing import Any, Callable

from app.services.agent_message_bus import AgentMessageBus

logger = logging.getLogger(__name__)


async def run_subagent(
    bus: AgentMessageBus,
    session: object,
    agent_id: str,
    goal: str,
    context: str = "",
    task_id: str | None = None,
    restricted_tools: list[str] | None = None,
    parent_tool_registry: Callable | None = None,
    parent_openai_tools: Callable | None = None,
    emit: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Run a sub-agent and publish lifecycle events to the bus.

    Args:
        bus: Shared message bus for inter-agent coordination.
        session: The parent session object.
        agent_id: Agent id to run.
        goal: The goal / instruction for this sub-agent.
        context: Additional context text.
        task_id: Unique task identifier (auto-generated if not provided).
        restricted_tools: Optional list of tool names the agent is restricted
            from using. If None, all tools are inherited.
        parent_tool_registry: Function returning the parent's tool list.
        parent_openai_tools: Function returning the parent's OpenAI-format tools.
        emit: Optional callback for direct event emission (legacy path).

    Returns:
        Result dict with keys ``task_id``, ``agent_id``, ``status``, ``result``.
    """
    import uuid
    if task_id is None:
        task_id = f"task_{uuid.uuid4().hex[:12]}"

    started_at = time.time()
    topic_prefix = f"task:{task_id}"

    # Publish initial progress
    await bus.publish(f"{topic_prefix}:progress", {
        "type": "subagent_started",
        "task_id": task_id,
        "agent_id": agent_id,
        "goal": goal,
        "timestamp": started_at,
    })

    # Build a wrapped emit function that also publishes to the bus
    def _combined_emit(ev: dict[str, Any]) -> None:
        if emit:
            emit(ev)
        # Also publish key events to the bus
        ev_type = ev.get("type", "")
        if ev_type in ("subagent_text", "subagent_tool_call", "subagent_tool_result"):
            asyncio.ensure_future(bus.publish(f"{topic_prefix}:progress", {
                "type": ev_type,
                "task_id": task_id,
                "agent_id": agent_id,
                **ev,
            }))

    # Publish a peer-help request failure topic so other agents can claim it
    async def _fail_and_broadcast(error_msg: str) -> dict[str, Any]:
        result = {
            "task_id": task_id,
            "agent_id": agent_id,
            "status": "failed",
            "error": error_msg,
        }
        await bus.publish(f"{topic_prefix}:failure", result)
        return result

    try:
        from app.services.workbench.subagent import executeSubAgent

        # Apply tool restrictions if provided
        if restricted_tools:
            original_defs = parent_tool_registry(session) if parent_tool_registry else None
            original_openai = parent_openai_tools(session) if parent_openai_tools else None
            # We monkey-patch toolDefinitions temporarily
            if original_defs:
                import app.services.workbench.workbench as wb
                original_td = wb.toolDefinitions

                def filtered_tool_defs(s):
                    all_tools = original_td(s)
                    return [t for t in all_tools if t.get("name") not in restricted_tools]

                wb.toolDefinitions = filtered_tool_defs
                try:
                    sub_result = await executeSubAgent(
                        session, agent_id, goal, context, emit=_combined_emit
                    )
                finally:
                    wb.toolDefinitions = original_td
            else:
                sub_result = await executeSubAgent(
                    session, agent_id, goal, context, emit=_combined_emit
                )
        else:
            sub_result = await executeSubAgent(
                session, agent_id, goal, context, emit=_combined_emit
            )

        elapsed = time.time() - started_at
        status = sub_result.get("status", "completed")

        if status == "completed":
            await bus.publish(f"{topic_prefix}:result", {
                "type": "subagent_completed",
                "task_id": task_id,
                "agent_id": agent_id,
                "result": sub_result.get("result", ""),
                "elapsed_s": round(elapsed, 2),
            })
        else:
            return await _fail_and_broadcast(sub_result.get("error", "Unknown error"))

        return {
            "task_id": task_id,
            "agent_id": agent_id,
            "status": status,
            "result": sub_result.get("result", ""),
        }

    except Exception as exc:
        logger.exception("[SubagentWorker] error running agent %s", agent_id)
        return await _fail_and_broadcast(str(exc))
