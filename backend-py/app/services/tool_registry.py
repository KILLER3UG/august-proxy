"""
Tool registry — register, describe, and dispatch tools (Phase 3).

Supports reserved bridge names and optional keywords per tool.
"""

from __future__ import annotations

import contextvars
from typing import Any, Callable, Coroutine

_registry: dict[str, dict[str, Any]] = {}

ToolHandler = Callable[..., Coroutine[Any, Any, str]]

# Bridge tool names — registry rejects registration of these
_RESERVED_NAMES: frozenset[str] = frozenset({
    "tool_search", "tool_describe", "tool_call",
})

# v2: Daemon context (read-only tool enforcement)
_daemon_context: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "daemon_context", default=False
)

# Commands that mutate state and MUST be blocked when called from a daemon.
# Match is substring on the command string (case-insensitive).
_DAEMON_BLOCKED_COMMAND_PATTERNS = [
    "rm ", " rm",        # rm
    "mv ", " mv",        # mv
    "del ", " del",      # del
    "format",            # mkfs / format
    "mkfs",
    "dd ", " dd",        # dd
    "shutdown", "reboot", "halt",
    ":(){:|:&};:",       # fork bomb
    "curl -X POST",      # POST via curl (avoid unintended external mutation)
    "wget -O",           # download-and-exec pattern
    "chmod 777",         # permission escalation
    "chown",
]


def set_daemon_context(*, poll_interval: int = 30) -> None:
    """v2: Mark subsequent tool calls as coming from a daemon.

    While this context is set, `run_command` rejects mutating commands.
    The `poll_interval` is recorded for use in adaptive TTL (Phase 10.1).
    """
    _daemon_context.set(True)


def clear_daemon_context() -> None:
    """v2: Exit daemon context."""
    _daemon_context.set(False)


def is_daemon_context() -> bool:
    """v2: Check if currently in daemon context."""
    return _daemon_context.get()


def is_command_blocked(command: str) -> bool:
    """v2: Check if a command matches a mutating pattern."""
    cmd_lower = command.lower()
    return any(p in cmd_lower for p in _DAEMON_BLOCKED_COMMAND_PATTERNS)


def register(
    name: str,
    description: str,
    handler: ToolHandler,
    parameters: dict[str, Any] | None = None,
    keywords: list[str] | None = None,
) -> None:
    """Register a tool.

    Raises ValueError if the name is reserved (tool_search, tool_describe, tool_call).

    ``keywords`` is an optional list of search terms for BM25 retrieval (Phase 3).
    """
    if name in _RESERVED_NAMES:
        raise ValueError(f"Cannot register reserved bridge name: '{name}'")

    _registry[name] = {
        "name": name,
        "description": description,
        "handler": handler,
        "parameters": parameters or {},
        "keywords": keywords or [],
    }


def get(name: str) -> dict[str, Any] | None:
    """Get a tool definition by name."""
    return _registry.get(name)


def get_tool(name: str) -> dict[str, Any] | None:
    """Alias for get()."""
    return _registry.get(name)


def list_tools() -> list[dict[str, Any]]:
    """List all registered tools in Anthropic/OpenAI-compatible format."""
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["parameters"],
            },
        }
        for t in _registry.values()
    ]


def list_raw() -> list[dict[str, Any]]:
    """List all registered tools in raw (internal) format with keywords."""
    return list(_registry.values())


async def dispatch(name: str, args: dict[str, Any]) -> str:
    """Dispatch a tool call by name and arguments.

    v2: When called from a daemon (set via set_daemon_context), `run_command`
    rejects mutating commands per the daemon blocklist.
    """
    tool = _registry.get(name)
    if not tool:
        return f'Error: Tool "{name}" not found.'

    # v2: Daemon-context blocklist check for run_command
    if name == "run_command" and is_daemon_context():
        command = args.get("command", "")
        if is_command_blocked(command):
            return (
                f"[BLOCKED] run_command rejected in daemon context: "
                f"'{command}' contains a mutating pattern. "
                f"Daemons are read-only."
            )

    try:
        return await tool["handler"](**args)
    except Exception as e:
        return f"Error executing {name}: {e}"
