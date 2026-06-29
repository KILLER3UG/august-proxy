"""
Tool registry — register, describe, and dispatch tools (Phase 3).

Supports reserved bridge names and optional keywords per tool.
"""

from __future__ import annotations

from typing import Any, Callable, Coroutine

_registry: dict[str, dict[str, Any]] = {}

ToolHandler = Callable[..., Coroutine[Any, Any, str]]

# Bridge tool names — registry rejects registration of these
_RESERVED_NAMES: frozenset[str] = frozenset({
    "tool_search", "tool_describe", "tool_call",
})


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
    """Dispatch a tool call by name and arguments."""
    tool = _registry.get(name)
    if not tool:
        return f'Error: Tool "{name}" not found.'
    try:
        return await tool["handler"](**args)
    except Exception as e:
        return f"Error executing {name}: {e}"
