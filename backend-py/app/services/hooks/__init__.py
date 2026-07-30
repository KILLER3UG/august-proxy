"""August lifecycle hook system.

Provides a programmable constraint layer around tool execution:
hooks can inspect, warn, modify, or block tool calls at defined
lifecycle points (pre/post tool use, session start, stop).

Usage:
    from app.services.hooks import registry, HookEvent, HookContext, HookResult

    # Register a hook
    registry.register('my_hook', HookEvent.PRE_TOOL_USE, handler, matcher='write_file')

    # Emit (called by workbench internally)
    results = await registry.emit(HookEvent.PRE_TOOL_USE, ctx)
"""

from app.services.hooks.registry import HookRegistry, registry
from app.services.hooks.types import HookContext, HookEvent, HookResult

__all__ = ['HookContext', 'HookEvent', 'HookResult', 'HookRegistry', 'registry']
