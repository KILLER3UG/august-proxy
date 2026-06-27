"""
Workbench execution context.

Exposes a ``ContextVar`` carrying the current workbench session id so that
tool handlers (e.g. browser tools) can resolve their per-session state without
changing the ``dispatch(name, args)`` signature or every handler.

Set by ``workbench._execute_tool`` before dispatching a tool call.
"""

from __future__ import annotations

from contextvars import ContextVar

# The workbench session id active for the current tool dispatch, or
# ``"default"`` when called outside a session (e.g. ad-hoc service calls).
current_session_id: ContextVar[str] = ContextVar("workbench_session_id", default="default")
