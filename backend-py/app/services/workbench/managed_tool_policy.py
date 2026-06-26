"""
Managed tool policy — parallel safety checks for tool execution.

Port of backend/services/workbench/managed-tool-policy.js (63 lines).

Determines which tools are safe to run in parallel vs. mutating
(read-only vs. write).
"""

from __future__ import annotations

import json
import re
from typing import Any

# ── Patterns ──────────────────────────────────────────────────────────

MUTATING_NAME_PATTERN = re.compile(
    r"^(write|edit|create|delete|install|run|bash|launch|click|type|focus|"
    r"set|add|remove|rename|copy|move|mkdir|touch|chmod|kill|uninstall|"
    r"stop|restart|upload|download|patch|apply|commit|push|merge|deploy|"
    r"start|reboot|shutdown|format|mount|unmount|"
    r"browser_navigate|browser_click|browser_type|browser_snapshot)",
    re.IGNORECASE,
)

SAFE_NAME_PATTERN = re.compile(
    r"^(read|list|search|fetch|get|describe|diagnose|status|recall|"
    r"view|find|show|check|inspect|lookup|resolve|ping|health|info|"
    r"memory_search|fact_search|context_read|list_skills)",
    re.IGNORECASE,
)


def is_managed_tool_parallel_safe(tool_name: str, args: dict[str, Any] | None = None) -> bool:
    """Check if a managed tool is safe to run in parallel.

    Returns True for:
    - WebSearch/WebFetch (and workspace MCP variants)
    - August supermemory reads (action: 'search' or 'list')
    - Safe August tools (read_file, search, recall, list, review, etc.)
    - Read-only computer tools (screenshot, position, screen size, etc.)
    - MCP/Cowork tools that match SAFE_NAME_PATTERN and not MUTATING_NAME_PATTERN
    """
    if not tool_name:
        return False

    # Web tools are always parallel-safe
    if tool_name in (
        "WebSearch", "WebFetch",
        "web_search", "web_fetch",
        "mcp__workspace__web_search", "mcp__workspace__web_fetch",
    ):
        return True

    # Check name patterns
    if MUTATING_NAME_PATTERN.match(tool_name):
        return False
    if SAFE_NAME_PATTERN.match(tool_name):
        return True

    return False


def is_openai_tool_call_parallel_safe(tool_call: dict[str, Any]) -> bool:
    """Check if an OpenAI-format tool call is parallel-safe."""
    name = tool_call.get("function", {}).get("name", "")
    args_str = tool_call.get("function", {}).get("arguments", "{}")
    try:
        args = json.loads(args_str) if isinstance(args_str, str) else args_str
    except (json.JSONDecodeError, TypeError):
        args = {}
    return is_managed_tool_parallel_safe(name, args)


def is_anthropic_tool_use_parallel_safe(tool_use: dict[str, Any]) -> bool:
    """Check if an Anthropic-format tool use is parallel-safe."""
    name = tool_use.get("name", "")
    args = tool_use.get("input", {})
    return is_managed_tool_parallel_safe(name, args)


def parse_openai_tool_args(tool_call: dict[str, Any]) -> dict[str, Any]:
    """Parse the function.arguments JSON string from an OpenAI tool call."""
    args_str = tool_call.get("function", {}).get("arguments", "{}")
    if isinstance(args_str, str):
        try:
            return json.loads(args_str)
        except (json.JSONDecodeError, TypeError):
            return {}
    return args_str if isinstance(args_str, dict) else {}
