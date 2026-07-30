"""Hook event types and data contracts for the August lifecycle hook system."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Literal


class HookEvent(str, Enum):
    """Lifecycle events that hooks can subscribe to."""

    SESSION_START = 'session_start'
    PRE_TOOL_USE = 'pre_tool_use'
    POST_TOOL_USE = 'post_tool_use'
    PRE_MODEL_CALL = 'pre_model_call'
    STOP = 'stop'


@dataclass
class HookContext:
    """Context passed to every hook handler."""

    event: HookEvent
    session_id: str
    tool_name: str | None = None
    tool_args: dict[str, Any] | None = None
    tool_result: str | None = None  # POST_TOOL_USE only
    workspace_path: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class HookResult:
    """Result returned by a hook handler."""

    action: Literal['allow', 'deny', 'modify'] = 'allow'
    message: str | None = None  # shown to user/model on deny
    data: dict[str, Any] | None = None  # SSE payload for frontend
    modified_args: dict[str, Any] | None = None  # for 'modify' action
    modified_result: str | None = None  # for 'modify' on POST_TOOL_USE


# Type alias for hook handler functions.
# Handlers are async, receive context, return a result.
HookHandler = Any  # Callable[[HookContext], Awaitable[HookResult]]
