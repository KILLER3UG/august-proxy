"""
Tool registry — register and dispatch tools.
"""

from __future__ import annotations

from typing import Any, Callable, Coroutine

_registry: dict[str, dict[str, Any]] = {}

ToolHandler = Callable[..., Coroutine[Any, Any, str]]


def register(
    name: str,
    description: str,
    handler: ToolHandler,
    parameters: dict[str, Any] | None = None,
) -> None:
    _registry[name] = {
        "name": name,
        "description": description,
        "handler": handler,
        "parameters": parameters or {},
    }


def get(name: str) -> dict[str, Any] | None:
    return _registry.get(name)


def list_tools() -> list[dict[str, Any]]:
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


async def dispatch(name: str, args: dict[str, Any]) -> str:
    tool = _registry.get(name)
    if not tool:
        return f'Error: Tool "{name}" not found.'
    try:
        return await tool["handler"](**args)
    except Exception as e:
        return f"Error executing {name}: {e}"
