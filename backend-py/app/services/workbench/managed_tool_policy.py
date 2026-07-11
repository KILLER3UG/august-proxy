"""
Managed tool policy — parallel safety checks for tool execution.

Port of backend/services/workbench/managed-tool-policy.js (63 lines).

Determines which tools are safe to run in parallel vs. mutating
(read-only vs. write).
"""

from __future__ import annotations
import json
import re
from app.typeAliases import JsonValue

MUTATING_NAME_PATTERN = re.compile(
    '^(write|edit|create|delete|install|run|bash|launch|click|type|focus|set|add|remove|rename|copy|move|mkdir|touch|chmod|kill|uninstall|stop|restart|upload|download|patch|apply|commit|push|merge|deploy|start|reboot|shutdown|format|mount|unmount|browser_navigate|browser_click|browser_type|browser_snapshot)',
    re.IGNORECASE,
)
SAFE_NAME_PATTERN = re.compile(
    '^(read|list|search|fetch|get|describe|diagnose|status|recall|view|find|show|check|inspect|lookup|resolve|ping|health|info|memory_search|fact_search|context_read|list_skills)',
    re.IGNORECASE,
)


def isManagedToolParallelSafe(toolName: str, args: dict[str, object] | None = None) -> bool:
    """Check if a managed tool is safe to run in parallel.

    Returns True for:
    - WebSearch/WebFetch (and workspace MCP variants)
    - August supermemory reads (action: 'search' or 'list')
    - Safe August tools (read_file, search, recall, list, review, etc.)
    - Read-only computer tools (screenshot, position, screen size, etc.)
    - MCP/Cowork tools that match SAFE_NAME_PATTERN and not MUTATING_NAME_PATTERN
    """
    if not toolName:
        return False
    if toolName in (
        'WebSearch',
        'WebFetch',
        'web_search',
        'web_fetch',
        'mcp__workspace__web_search',
        'mcp__workspace__web_fetch',
    ):
        return True
    if MUTATING_NAME_PATTERN.match(toolName):
        return False
    if SAFE_NAME_PATTERN.match(toolName):
        return True
    return False


def isOpenaiToolCallParallelSafe(toolCall: dict[str, object]) -> bool:
    """Check if an OpenAI-format tool call is parallel-safe."""
    func = toolCall.get('function', {})
    assert isinstance(func, dict)
    name = func.get('name', '')
    assert isinstance(name, str)
    argsStr = func.get('arguments', '{}')
    try:
        args = json.loads(argsStr) if isinstance(argsStr, str) else argsStr
    except (json.JSONDecodeError, TypeError):
        args = {}
    assert isinstance(args, dict)
    return isManagedToolParallelSafe(name, args)


def isAnthropicToolUseParallelSafe(toolUse: dict[str, object]) -> bool:
    """Check if an Anthropic-format tool use is parallel-safe."""
    name = toolUse.get('name', '')
    assert isinstance(name, str)
    args = toolUse.get('input', {})
    assert isinstance(args, dict)
    return isManagedToolParallelSafe(name, args)


def parseOpenaiToolArgs(toolCall: dict[str, object]) -> dict[str, object]:
    """Parse the function.arguments JSON string from an OpenAI tool call."""
    func = toolCall.get('function', {})
    if not isinstance(func, dict):
        return {}
    argsStr = func.get('arguments', '{}')
    if isinstance(argsStr, str):
        try:
            result = json.loads(argsStr)
            assert isinstance(result, dict)
            return result
        except (json.JSONDecodeError, TypeError):
            return {}
    return argsStr if isinstance(argsStr, dict) else {}
