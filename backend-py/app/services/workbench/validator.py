"""
Tool argument validation — validates tool calls against JSON schemas
before execution.

Port of backend/services/workbench/validator.js (136 lines).
"""

from __future__ import annotations

import json
import re
from typing import Any

# ── Validation ───────────────────────────────────────────────────────


def validate_tool_arguments(
    tool_call: dict[str, Any],
    tool_definitions: list[dict[str, Any]],
    messages: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Validate a tool call against its schema.

    Args:
        tool_call: The tool call to validate. OpenAI format with
            ``function.name`` and ``function.arguments``.
        tool_definitions: List of known tool definitions.
        messages: Optional conversation history (used for plan-mode gating).

    Returns:
        ``{"valid": True}`` or ``{"valid": False, "error": "..."}``.
    """
    if messages is None:
        messages = []

    # Extract tool name
    tool_name = (
        tool_call.get("function", {}).get("name")
        or tool_call.get("name")
    )
    if not tool_name:
        return {"valid": False, "error": "Missing tool name"}

    # Find matching definition
    tool_def = _find_tool_definition(tool_name, tool_definitions)
    if not tool_def:
        # Unknown tools pass through (they might be client-side)
        return {"valid": True}

    # Parse arguments (supports both OpenAI function.arguments and Anthropic input)
    args_raw = tool_call.get("function", {}).get("arguments", tool_call.get("input", "{}"))
    if isinstance(args_raw, str):
        try:
            args = json.loads(args_raw)
        except (json.JSONDecodeError, TypeError):
            return {"valid": False, "error": f"Invalid JSON in arguments: {args_raw[:200]}"}
    else:
        args = args_raw

    # Get schema (supports both Anthropic and OpenAI formats)
    schema = (
        tool_def.get("parameters")
        or tool_def.get("input_schema")
        or tool_def.get("function", {}).get("parameters")
        or {}
    )
    if not schema:
        # No schema means no validation needed
        return {"valid": True}

    # Compatibility shim: for WebFetch/WebSearch, map 'prompt' to 'url'/'query'
    args = _apply_compatibility_shims(tool_name, args)

    # Proxy Execution Gate: block mutating tools if no plan.md in conversation
    gate_result = _check_proxy_execution_gate(tool_name, args, messages)
    if not gate_result["valid"]:
        return gate_result

    # Check required fields
    required = schema.get("required", [])
    for field in required:
        if field not in args or args[field] is None or (isinstance(args[field], str) and not args[field].strip()):
            return {"valid": False, "error": f"Missing required field: '{field}'"}

    # Check additionalProperties
    if schema.get("additionalProperties") is False:
        allowed = set(schema.get("properties", {}).keys())
        extra = set(args.keys()) - allowed
        if extra:
            return {
                "valid": False,
                "error": f"Unknown fields: {', '.join(sorted(extra))}. "
                f"Allowed fields: {', '.join(sorted(allowed))}",
            }

    # Type checks for specified properties
    properties = schema.get("properties", {})
    for field, value in args.items():
        prop_schema = properties.get(field, {})
        prop_type = prop_schema.get("type", "")
        if prop_type == "string" and not isinstance(value, str):
            return {"valid": False, "error": f"Field '{field}' must be a string"}
        if prop_type == "integer" and not isinstance(value, int):
            return {"valid": False, "error": f"Field '{field}' must be an integer"}
        if prop_type == "number" and not isinstance(value, (int, float)):
            return {"valid": False, "error": f"Field '{field}' must be a number"}
        if prop_type == "boolean" and not isinstance(value, bool):
            return {"valid": False, "error": f"Field '{field}' must be a boolean"}
        if prop_type == "array" and not isinstance(value, list):
            return {"valid": False, "error": f"Field '{field}' must be an array"}
        if prop_type == "object" and not isinstance(value, dict):
            return {"valid": False, "error": f"Field '{field}' must be an object"}

    return {"valid": True}


def build_validation_error_tool_message(tool_call_id: str, tool_name: str, error_msg: str) -> dict[str, Any]:
    """Build a tool result message for a validation error."""
    return {
        "tool_call_id": tool_call_id,
        "role": "tool",
        "content": (
            f"[Validation Error] Tool '{tool_name}' rejected before execution:\n"
            f"{error_msg}\n\n"
            f"[Proxy Self-Heal]: Fix the tool arguments and retry. Do NOT stop."
        ),
    }


# ── Internal helpers ─────────────────────────────────────────────────


def _find_tool_definition(name: str, definitions: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Find a tool definition by name, supporting both Anthropic and OpenAI formats."""
    for t in definitions:
        t_name = t.get("function", {}).get("name") or t.get("name")
        if t_name == name:
            return t
    return None


def _apply_compatibility_shims(tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Apply compatibility shims for common tool name mappings."""
    if tool_name in ("WebFetch", "web_fetch", "mcp__workspace__web_fetch"):
        if "prompt" in args and "url" not in args:
            args = dict(args)
            args["url"] = args["prompt"]
    if tool_name in ("WebSearch", "web_search", "mcp__workspace__web_search"):
        if "prompt" in args and "query" not in args:
            args = dict(args)
            args["query"] = args["prompt"]
    return args


# Mutating tool name patterns that require plan-mode approval
_MUTATING_TOOL_PATTERNS = re.compile(
    r"^(StrReplaceEditTool|BashTool|MCP.*(?:write|create|move|edit|delete|rename|copy)|"
    r"mcp__.*(?:write|create|move|edit|delete))",
    re.IGNORECASE,
)


def _check_proxy_execution_gate(
    tool_name: str,
    args: dict[str, Any],
    messages: list[dict[str, Any]],
) -> dict[str, Any]:
    """Proxy Execution Gate: block mutating tools if no plan.md in context.

    This prevents the model from making changes before a plan has been
    explicitly approved.
    """
    if not _MUTATING_TOOL_PATTERNS.match(tool_name):
        return {"valid": True}

    # Check if any message mentions plan.md
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str) and "plan.md" in content:
            return {"valid": True}
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and "plan.md" in str(block.get("text", "")):
                    return {"valid": True}

    return {
        "valid": False,
        "error": (
            f"Tool '{tool_name}' is blocked by the Proxy Execution Gate. "
            f"No plan.md was found in the conversation. "
            f"Create and approve a plan before using mutating tools."
        ),
    }
