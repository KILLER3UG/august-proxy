"""Canonical workbench SSE / emit event type names (camelCase wire).

Gateway, desktop stream handlers, and tests should import from here so
snake_case drift (e.g. ``final_output``) is visible in one place.
"""

from __future__ import annotations

# Types the chat UI and gateway commonly observe on the workbench stream.
WORKBENCH_EMIT_TYPES: frozenset[str] = frozenset(
    {
        'started',
        'finalOutput',
        'thinking',
        'toolCall',
        'toolResult',
        'done',
        'error',
        'planProposed',
        'clarifyProposed',
        'todosUpdated',
        'browserAction',
        'compaction',
        'subagentStart',
        'subagentText',
        'subagentToolCall',
        'subagentToolResult',
        'subagentDone',
        'warning',
        'session_status',
    }
)

# Text chunks that form the assistant reply (gateway SessionBridge accumulation).
ASSISTANT_TEXT_EMIT_TYPES: frozenset[str] = frozenset(
    {
        'finalOutput',  # canonical workbench / BatchedEmit
        'final_output',  # legacy snake_case — accept but do not emit new
    }
)
