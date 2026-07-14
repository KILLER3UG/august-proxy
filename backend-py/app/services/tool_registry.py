"""
Tool registry — register, describe, and dispatch tools (Phase 3).

Supports reserved bridge names and optional keywords per tool.
"""

from __future__ import annotations
import contextvars
from typing import Callable, Coroutine

_registry: dict[str, dict[str, object]] = {}
ToolHandler = Callable[..., Coroutine[object, object, str]]
_RESERVEDNames: frozenset[str] = frozenset({'tool_search', 'tool_describe', 'tool_call'})
_daemonContext: contextvars.ContextVar[bool] = contextvars.ContextVar('daemon_context', default=False)
# Monotonic generation for tool-definition caches (increments on register/clear).
_generation: int = 0
_DAEMONBlockedCommandPatterns = [
    'rm ',
    ' rm',
    'mv ',
    ' mv',
    'del ',
    ' del',
    'format',
    'mkfs',
    'dd ',
    ' dd',
    'shutdown',
    'reboot',
    'halt',
    ':(){:|:&};:',
    'curl -X POST',
    'wget -O',
    'chmod 777',
    'chown',
]


def setDaemonContext(*, pollInterval: int = 30) -> None:
    """v2: Mark subsequent tool calls as coming from a daemon.

    While this context is set, `run_command` rejects mutating commands.
    The `poll_interval` is recorded for use in adaptive TTL (Phase 10.1).
    """
    _daemonContext.set(True)


def clearDaemonContext() -> None:
    """v2: Exit daemon context."""
    _daemonContext.set(False)


def isDaemonContext() -> bool:
    """v2: Check if currently in daemon context."""
    return _daemonContext.get()


def isCommandBlocked(command: str) -> bool:
    """v2: Check if a command matches a mutating pattern."""
    cmdLower = command.lower()
    return any((p in cmdLower for p in _DAEMONBlockedCommandPatterns))


def register(
    name: str,
    description: str,
    handler: ToolHandler,
    parameters: dict[str, object] | None = None,
    keywords: list[str] | None = None,
) -> None:
    """Register a tool.

    Raises ValueError if the name is reserved (tool_search, tool_describe, tool_call).

    ``keywords`` is an optional list of search terms for BM25 retrieval (Phase 3).
    """
    global _generation
    if name in _RESERVEDNames:
        raise ValueError(f"Cannot register reserved bridge name: '{name}'")
    _registry[name] = {
        'name': name,
        'description': description,
        'handler': handler,
        'parameters': parameters or {},
        'keywords': keywords or [],
    }
    _generation += 1


def generation() -> int:
    """Monotonic counter bumped on each register/unregister.

    Tool-definition caches key on this so they rebuild after the registry changes.
    """
    return _generation


def unregister(name: str) -> bool:
    """Remove a registered tool. Returns True if it was present.

    Bumps ``generation()`` so tool-definition caches drop entries for withdrawn
    tools and stop serving stale schemas.
    """
    global _generation
    if name not in _registry:
        return False
    del _registry[name]
    _generation += 1
    return True


def get(name: str) -> dict[str, object] | None:
    """Get a tool definition by name."""
    return _registry.get(name)


def getTool(name: str) -> dict[str, object] | None:
    """Alias for get()."""
    return _registry.get(name)


def listRaw() -> list[dict[str, object]]:
    """List all registered tools in raw (internal) format with keywords."""
    return list(_registry.values())


_DESKTOP_TOOL_PREFIXES = (
    'desktop_',
    'computer_',
    'host_',
)


def is_host_agent_tool(name: str) -> bool:
    """Tools that require a reachable host agent / local desktop automation."""
    if not isinstance(name, str):
        return False
    return name.startswith(_DESKTOP_TOOL_PREFIXES) or name in (
        'screenshot',
        'computer_use',
        'move_mouse',
        'click_mouse',
        'type_text',
    )


async def host_agent_available() -> bool:
    """True when host agent URL is set and health responds, or local desktop is usable."""
    import os

    url = os.environ.get('AUGUST_HOST_AGENT_URL', '').strip()
    if url:
        try:
            from app.services.host_agent import getHostInfo

            info = await getHostInfo()
            return bool(info.get('available'))
        except Exception:
            return False
    # Local pyautogui path: available when import works (desktop_automation)
    try:
        import app.services.desktop_automation as da  # noqa: F401

        return True
    except Exception:
        return False


def listTools(*, include_host_agent: bool | None = None) -> list[dict[str, object]]:
    """List tools; hide host/desktop tools when host agent is unavailable.

    ``include_host_agent``:
      - None: best-effort sync check (env URL unset → keep local desktop tools)
      - True/False: force include/exclude
    """
    show_host = include_host_agent
    if show_host is None:
        import os

        url = os.environ.get('AUGUST_HOST_AGENT_URL', '').strip()
        # When URL is set but we can't async-check here, hide until proven up
        # (callers that need async should pass include_host_agent after await).
        if url:
            show_host = False
        else:
            show_host = True  # local desktop path
    result: list[dict[str, object]] = []
    for t in _registry.values():
        name = t.get('name')
        assert isinstance(name, str)
        if not show_host and is_host_agent_tool(name):
            continue
        description = t.get('description')
        parameters = t.get('parameters')
        assert isinstance(description, str)
        assert isinstance(parameters, dict)
        result.append(
            {'type': 'function', 'function': {'name': name, 'description': description, 'parameters': parameters}}
        )
    return result


async def dispatch(name: str, args: dict[str, object]) -> str:
    """Dispatch a tool call by name and arguments.

    v2: When called from a daemon (set via set_daemon_context), `run_command`
    rejects mutating commands per the daemon blocklist.
    Host/desktop tools refuse when the host agent is configured but down.
    """
    tool = _registry.get(name)
    if not tool:
        return f'Error: Tool "{name}" not found.'
    if is_host_agent_tool(name):
        import os

        if os.environ.get('AUGUST_HOST_AGENT_URL', '').strip():
            if not await host_agent_available():
                return (
                    f'[UNAVAILABLE] Tool "{name}" requires the host agent, '
                    'which is disconnected. Set AUGUST_HOST_AGENT_URL to a healthy '
                    'agent or clear it to use local desktop automation.'
                )
    if name == 'run_command' and isDaemonContext():
        command = args.get('command', '')
        assert isinstance(command, str)
        if isCommandBlocked(command):
            return f"[BLOCKED] run_command rejected in daemon context: '{command}' contains a mutating pattern. Daemons are read-only."
    try:
        handler = tool['handler']
        assert callable(handler)
        result: str = await handler(**args)
        return result
    except Exception as e:
        return f'Error executing {name}: {e}'
