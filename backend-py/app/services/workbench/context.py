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
