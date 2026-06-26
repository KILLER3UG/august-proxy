"""
Tool call classification — categorize tool calls as managed, client-owned, or unknown.

Port of backend/adapters/tool-classification.js.

This module classifies tool call/use arrays so the adapters know which
tools to execute locally vs. forward to the client.
"""

from __future__ import annotations

from typing import Any

from app.adapters.proxy_tools import is_proxy_managed_local_tool_name


def get_tool_name_from_openai_tool(tool: dict[str, Any] | None) -> str | None:
    """Extract the tool name from an OpenAI-format tool call."""
    if not tool:
        return None
    return tool.get("name") or tool.get("function", {}).get("name")


def get_tool_name_from_anthropic_tool(tool: dict[str, Any] | None) -> str | None:
    """Extract the tool name from an Anthropic-format tool use."""
    if not tool:
        return None
    return tool.get("name")


def _is_managed_proxy_tool_name(
    name: str | None,
    managed_local_tool_names: set[str] | None = None,
) -> bool:
    """Check if a tool name is proxy-managed.

    A tool is "managed" if the proxy knows how to execute it locally
    (web search, bash, August tools, MCP, Cowork).
    """
    if not name:
        return False
    if not is_proxy_managed_local_tool_name(name):
        return False
    if managed_local_tool_names is not None and len(managed_local_tool_names) > 0:
        if name not in managed_local_tool_names:
            return False
    return True


def _is_client_owned_tool_name(name: str | None, client_tool_names: set[str] | None = None) -> bool:
    """Check if a tool name is owned by the client (not proxy-managed)."""
    if not name:
        return False
    if client_tool_names is None:
        return False
    return name in client_tool_names


def classify_openai_tool_calls(
    tool_calls: list[dict[str, Any]] | None,
    managed_local_tool_names: set[str] | None = None,
    client_tool_names: set[str] | None = None,
) -> dict[str, Any]:
    """Classify OpenAI-format tool calls into managed and client/unknown groups."""
    if managed_local_tool_names is None:
        managed_local_tool_names = set()
    if client_tool_names is None:
        client_tool_names = set()

    calls = [tc for tc in (tool_calls or []) if tc]
    managed: list[dict[str, Any]] = []
    client_or_unknown: list[dict[str, Any]] = []

    for tc in calls:
        name = get_tool_name_from_openai_tool(tc)
        if (
            _is_managed_proxy_tool_name(name, managed_local_tool_names)
            and not _is_client_owned_tool_name(name, client_tool_names)
        ):
            managed.append(tc)
        else:
            client_or_unknown.append(tc)

    return {
        "tool_calls": calls,
        "managed_tool_calls": managed,
        "client_or_unknown_tool_calls": client_or_unknown,
        "has_managed": len(managed) > 0,
        "has_client_or_unknown": len(client_or_unknown) > 0,
        "can_execute_managed": len(managed) > 0 and len(client_or_unknown) == 0,
    }


def classify_anthropic_tool_uses(
    tool_uses: list[dict[str, Any]] | None,
    managed_local_tool_names: set[str] | None = None,
    client_tool_names: set[str] | None = None,
) -> dict[str, Any]:
    """Classify Anthropic-format tool uses into managed and client/unknown groups."""
    if managed_local_tool_names is None:
        managed_local_tool_names = set()
    if client_tool_names is None:
        client_tool_names = set()

    uses = [tu for tu in (tool_uses or []) if tu]
    managed: list[dict[str, Any]] = []
    client_or_unknown: list[dict[str, Any]] = []

    for tu in uses:
        name = get_tool_name_from_anthropic_tool(tu)
        if (
            _is_managed_proxy_tool_name(name, managed_local_tool_names)
            and not _is_client_owned_tool_name(name, client_tool_names)
        ):
            managed.append(tu)
        else:
            client_or_unknown.append(tu)

    return {
        "tool_uses": uses,
        "managed_tool_uses": managed,
        "client_or_unknown_tool_uses": client_or_unknown,
        "has_managed": len(managed) > 0,
        "has_client_or_unknown": len(client_or_unknown) > 0,
        "can_execute_managed": len(managed) > 0 and len(client_or_unknown) == 0,
    }
