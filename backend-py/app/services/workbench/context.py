"""
Workbench execution context.

Exposes a ``ContextVar`` carrying the current workbench session id so that
tool handlers (e.g. browser tools) can resolve their per-session state without
changing the ``dispatch(name, args)`` signature or every handler.

Set by ``workbench._execute_tool`` before dispatching a tool call.
"""

from __future__ import annotations

from contextvars import ContextVar

currentSessionId: ContextVar[str] = ContextVar('workbench_session_id', default='default')

# Id of the tool call currently being executed. Set by ``workbench._execute_tool``
# so tool handlers (e.g. the subagent spawner) can stamp their emitted events
# with the parent tool call — the UI nests sub-agent blocks under it.
currentToolUseId: ContextVar[str] = ContextVar('workbench_tool_use_id', default='')

# Id of the sub-agent task whose loop is currently executing (set by
# ``workbench.subagent.executeSubAgent``). asyncio tasks copy the context at
# creation, so concurrent workers each see their OWN value — unlike the
# session-attribute hack (``_current_subagent_task_id``), which races across
# workers sharing one parent session. Todo tools use it to store per-agent
# lists on the worker's orchestrator handle instead of clobbering the parent
# session's list.
currentSubagentTaskId: ContextVar[str] = ContextVar('workbench_subagent_task_id', default='')

# Runtime recursion depth of the current sub-agent loop. Set by
# ``workbench.subagent.executeSubAgent`` to its own depth so a nested spawn
# inherits depth+1. asyncio tasks copy the context at creation, so concurrent
# workers each carry their OWN depth — unlike the old ``session.subagent_depth``
# mutation, which raced across workers sharing one parent session and leaked
# the value to later root spawns. The orchestrator reads this (default 0 = root).
currentSubagentDepth: ContextVar[int] = ContextVar('workbench_subagent_depth', default=0)

# ---------------------------------------------------------------------------
# One authority for the spawn-depth cap.
#
# `delegation.maxDepth` is a user-facing setting (Settings -> Subagents), and
# the sub-agent tool surface and the orchestrator both need the same answer.
# When the surface subtracted `spawn_subagents` unconditionally, a raised
# maxDepth was dead configuration: the child was never offered the tool, so the
# orchestrator's depth machinery could not fire above the first level. Both
# sides now call this.
# ---------------------------------------------------------------------------

MAX_SPAWN_DEPTH_DEFAULT = 1
MAX_SPAWN_DEPTH_LIMIT = 5


def resolve_max_spawn_depth(
    delegation: dict[str, object] | None = None,
    session: object = None,
) -> int:
    """Clamped maxDepth: explicit dict, then session metadata, then brain config.

    Accepts an already-resolved `delegation` mapping so the orchestrator can
    reuse the dict it built for the other limits instead of re-deriving it.
    """
    from app.json_narrowing import as_dict, as_int

    source = as_dict(delegation)
    if not source and session is not None:
        source = as_dict(as_dict(getattr(session, 'metadata', None)).get('delegation'))
    if 'maxDepth' not in source:
        try:
            from app.services.brain_config_service import getDelegationLimits

            for key, value in as_dict(getDelegationLimits()).items():
                source.setdefault(key, value)
        except Exception:
            pass
    configured = as_int(source.get('maxDepth', MAX_SPAWN_DEPTH_DEFAULT), MAX_SPAWN_DEPTH_DEFAULT)
    return max(1, min(MAX_SPAWN_DEPTH_LIMIT, configured or MAX_SPAWN_DEPTH_DEFAULT))


def may_spawn_children(
    delegation: dict[str, object] | None = None,
    session: object = None,
    depth: int | None = None,
) -> bool:
    """Can the loop at `depth` (default: the current one) legally go one deeper?

    A root turn is depth 0, so with maxDepth=1 (the default) children at depth 1
    are not offered a spawn tool — the behavior before this existed. maxDepth=3
    offers it to depth 1 and 2 and stops at 3.
    """
    current = currentSubagentDepth.get() if depth is None else depth
    return current + 1 <= resolve_max_spawn_depth(delegation, session)
