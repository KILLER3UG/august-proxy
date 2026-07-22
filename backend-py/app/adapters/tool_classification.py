"""
Tool call classification — categorize tool calls as managed, client-owned, or unknown.

Port of backend/adapters/tool-classification.js.

This module classifies tool call/use arrays so the adapters know which
tools to execute locally vs. forward to the client.
"""

from __future__ import annotations

from app.adapters.proxy_tools import is_proxy_managed_local_tool_name
from app.json_narrowing import as_str
from app.models import ToolCall, ToolClassificationResult, ToolUseBlock


def getToolNameFromOpenaiTool(tool: ToolCall | dict[str, object] | None) -> str | None:
    """Extract the tool name from an OpenAI-format tool call."""
    if not tool:
        return None
    if isinstance(tool, ToolCall):
        return tool.function.name
    name = as_str(tool.get('name'))
    if name:
        return name
    func = tool.get('function')
    if isinstance(func, dict):
        name = as_str(func.get('name'))
        if name:
            return name
    return None


def getToolNameFromAnthropicTool(tool: ToolUseBlock | dict[str, object] | None) -> str | None:
    """Extract the tool name from an Anthropic-format tool use."""
    if not tool:
        return None
    if isinstance(tool, ToolUseBlock):
        return tool.name
    name = tool.get('name')
    return name if isinstance(name, str) else None


def _isManagedProxyToolName(name: str | None, managedLocalToolNames: set[str] | None = None) -> bool:
    """Check if a tool name is proxy-managed.

    A tool is "managed" if the proxy knows how to execute it locally
    (web search, bash, August tools, MCP, Cowork).
    """
    if not name:
        return False
    if not is_proxy_managed_local_tool_name(name):
        return False
    if managedLocalToolNames is not None and len(managedLocalToolNames) > 0:
        if name not in managedLocalToolNames:
            return False
    return True


def _isClientOwnedToolName(name: str | None, clientToolNames: set[str] | None = None) -> bool:
    """Check if a tool name is owned by the client (not proxy-managed)."""
    if not name:
        return False
    if clientToolNames is None:
        return False
    return name in clientToolNames


def classifyOpenaiToolCalls(
    toolCalls: list[dict[str, object]] | None,
    managedLocalToolNames: set[str] | None = None,
    clientToolNames: set[str] | None = None,
) -> ToolClassificationResult:
    """Classify OpenAI-format tool calls into managed and client/unknown groups."""
    if managedLocalToolNames is None:
        managedLocalToolNames = set()
    if clientToolNames is None:
        clientToolNames = set()
    calls = [tc for tc in toolCalls or [] if tc]
    managed: list[dict[str, object]] = []
    clientOrUnknown: list[dict[str, object]] = []
    for tc in calls:
        name = getToolNameFromOpenaiTool(tc)
        if _isManagedProxyToolName(name, managedLocalToolNames) and (not _isClientOwnedToolName(name, clientToolNames)):
            managed.append(tc)
        else:
            clientOrUnknown.append(tc)
    return ToolClassificationResult(
        tool_calls=calls,
        managed_tool_calls=managed,
        client_or_unknown_tool_calls=clientOrUnknown,
        has_managed=len(managed) > 0,
        has_client_or_unknown=len(clientOrUnknown) > 0,
        can_execute_managed=len(managed) > 0 and len(clientOrUnknown) == 0,
    )


def classifyAnthropicToolUses(
    toolUses: list[dict[str, object]] | None,
    managedLocalToolNames: set[str] | None = None,
    clientToolNames: set[str] | None = None,
) -> ToolClassificationResult:
    """Classify Anthropic-format tool uses into managed and client/unknown groups."""
    if managedLocalToolNames is None:
        managedLocalToolNames = set()
    if clientToolNames is None:
        clientToolNames = set()
    uses = [tu for tu in toolUses or [] if tu]
    managed: list[dict[str, object]] = []
    clientOrUnknown: list[dict[str, object]] = []
    for tu in uses:
        name = getToolNameFromAnthropicTool(tu)
        if _isManagedProxyToolName(name, managedLocalToolNames) and (not _isClientOwnedToolName(name, clientToolNames)):
            managed.append(tu)
        else:
            clientOrUnknown.append(tu)
    return ToolClassificationResult(
        tool_uses=uses,
        managed_tool_uses=managed,
        client_or_unknown_tool_uses=clientOrUnknown,
        has_managed=len(managed) > 0,
        has_client_or_unknown=len(clientOrUnknown) > 0,
        can_execute_managed=len(managed) > 0 and len(clientOrUnknown) == 0,
    )
