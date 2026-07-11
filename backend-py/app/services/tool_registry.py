"""
Tool registry — register, describe, and dispatch tools (Phase 3).

Supports reserved bridge names and optional keywords per tool.
"""
from __future__ import annotations
import contextvars
from typing import Callable, Coroutine
from app.typeAliases import JsonValue
_registry: dict[str, dict[str, object]] = {}
ToolHandler = Callable[..., Coroutine[object, object, str]]
_RESERVEDNames: frozenset[str] = frozenset({'tool_search', 'tool_describe', 'tool_call'})
_daemonContext: contextvars.ContextVar[bool] = contextvars.ContextVar('daemon_context', default=False)
_DAEMONBlockedCommandPatterns = ['rm ', ' rm', 'mv ', ' mv', 'del ', ' del', 'format', 'mkfs', 'dd ', ' dd', 'shutdown', 'reboot', 'halt', ':(){:|:&};:', 'curl -X POST', 'wget -O', 'chmod 777', 'chown']

def setDaemonContext(*, pollInterval: int=30) -> None:
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

def register(name: str, description: str, handler: ToolHandler, parameters: dict[str, JsonValue] | None=None, keywords: list[str] | None=None) -> None:
    """Register a tool.

    Raises ValueError if the name is reserved (tool_search, tool_describe, tool_call).

    ``keywords`` is an optional list of search terms for BM25 retrieval (Phase 3).
    """
    if name in _RESERVEDNames:
        raise ValueError(f"Cannot register reserved bridge name: '{name}'")
    _registry[name] = {'name': name, 'description': description, 'handler': handler, 'parameters': parameters or {}, 'keywords': keywords or []}

def get(name: str) -> dict[str, object] | None:
    """Get a tool definition by name."""
    return _registry.get(name)

def getTool(name: str) -> dict[str, object] | None:
    """Alias for get()."""
    return _registry.get(name)

def listTools() -> list[dict[str, JsonValue]]:
    """List all registered tools in Anthropic/OpenAI-compatible format."""
    result: list[dict[str, JsonValue]] = []
    for t in _registry.values():
        name = t.get('name')
        description = t.get('description')
        parameters = t.get('parameters')
        assert isinstance(name, str)
        assert isinstance(description, str)
        assert isinstance(parameters, dict)
        result.append({'type': 'function', 'function': {'name': name, 'description': description, 'parameters': parameters}})
    return result

def listRaw() -> list[dict[str, object]]:
    """List all registered tools in raw (internal) format with keywords."""
    return list(_registry.values())

async def dispatch(name: str, args: dict[str, JsonValue]) -> str:
    """Dispatch a tool call by name and arguments.

    v2: When called from a daemon (set via set_daemon_context), `run_command`
    rejects mutating commands per the daemon blocklist.
    """
    tool = _registry.get(name)
    if not tool:
        return f'Error: Tool "{name}" not found.'
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