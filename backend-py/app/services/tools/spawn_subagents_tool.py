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
- ``proposed``: emit a ``subagent-proposed`` event for user approval before
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

TOOL_NAME = "spawn_subagents"
TOOL_DEFINITION = {
    "name": TOOL_NAME,
    "description": "Spawn multiple sub-agents in parallel to complete independent work items. "
                   "Each sub-agent receives its own goal and can be given a restricted set of tools. "
                   "Returns consolidated results when all sub-agents complete.",
    "input_schema": {
        "type": "object",
        "properties": {
            "workItems": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "goal": {
                            "type": "string",
                            "description": "The goal/instruction for this sub-agent.",
                        },
                        "agentId": {
                            "type": "string",
                            "description": "Agent ID to use (default 'general').",
                            "default": "general",
                        },
                        "restrictedTools": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Tool names this sub-agent is restricted from using.",
                        },
                        "context": {
                            "type": "string",
                            "description": "Additional context for the sub-agent.",
                        },
                    },
                    "required": ["goal"],
                },
                "minItems": 1,
                "maxItems": 10,
            },
            "mode": {
                "type": "string",
                "enum": ["auto", "proposed", "negotiated"],
                "default": "auto",
                "description": "Spawn mode: 'auto' spawns immediately, "
                               "'proposed' requires user approval.",
            },
        },
        "required": ["workItems"],
    },
}

# In-memory store for proposed breakdowns pending approval
_pending_proposals: dict[str, dict[str, Any]] = {}


async def execute_spawn_subagents(
    orchestrator: SubagentOrchestrator,
    session: object,
    work_items: list[dict[str, Any]],
    mode: str = "auto",
    emit: Any | None = None,
) -> dict[str, Any]:
    """Execute the spawn_subagents tool.

    Args:
        orchestrator: The subagent orchestrator instance.
        session: The parent session object.
        work_items: List of work item dicts (goal, agent_id, etc.).
        mode: Spawn mode ('auto', 'proposed', 'negotiated').
        emit: Optional SSE event emitter.

    Returns:
        Result dict with ``status`` and ``results`` keys.
    """
    if mode == "proposed":
        # Emit proposal event and wait for user approval
        proposal_id = f"proposal_{__import__('uuid').uuid4().hex[:8]}"
        _pending_proposals[proposal_id] = {
            "work_items": work_items,
            "session": session,
            "mode": mode,
            "created_at": __import__('time').time(),
        }

        if emit:
            emit({
                "type": "subagent-proposed",
                "proposal_id": proposal_id,
                "work_breakdown": [
                    {
                        "goal": item.get("goal", ""),
                        "agent_id": item.get("agent_id", "general"),
                    }
                    for item in work_items
                ],
            })

        return {
            "status": "awaiting_approval",
            "proposal_id": proposal_id,
            "message": f"Proposal {proposal_id} created. Waiting for user approval.",
        }

    # auto mode — spawn immediately
    return await _do_spawn(orchestrator, session, work_items, emit=emit)


async def approve_proposal(
    orchestrator: SubagentOrchestrator,
    proposal_id: str,
) -> dict[str, Any]:
    """Approve a pending proposal and trigger spawning."""
    proposal = _pending_proposals.pop(proposal_id, None)
    if not proposal:
        return {"status": "error", "error": f"Proposal {proposal_id} not found or already expired."}

    return await _do_spawn(
        orchestrator,
        proposal["session"],
        proposal["work_items"],
        emit=None,
    )


async def _do_spawn(
    orchestrator: SubagentOrchestrator,
    session: object,
    work_items: list[dict[str, Any]],
    emit: Any | None = None,
) -> dict[str, Any]:
    """Actually spawn the sub-agents and collect results."""
    request = SubagentSpawnRequest(
        session=session,
        work_items=[
            {
                "goal": item.get("goal", ""),
                "agent_id": item.get("agentId", item.get("agent_id", "general")),
                "restricted_tools": item.get("restrictedTools", item.get("restricted_tools")),
                "context": item.get("context", ""),
            }
            for item in work_items
        ],
        mode="auto",
    )

    handles = await orchestrator.spawn(request)

    # Wait for all handles to complete concurrently
    results = await orchestrator.wait_for_all(handles)

    succeeded = sum(1 for r in results if r["status"] == "completed")
    failed = sum(1 for r in results if r["status"] in ("failed", "error"))

    return {
        "status": "completed" if failed == 0 else "partial" if succeeded > 0 else "failed",
        "total": len(results),
        "succeeded": succeeded,
        "failed": failed,
        "results": results,
    }
