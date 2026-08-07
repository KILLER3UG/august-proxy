"""
Tool argument validation — validates tool calls against JSON schemas
before execution.

Port of backend/services/workbench/validator.js (136 lines).
"""

from __future__ import annotations

import json
import re


def validateToolArguments(
    toolCall: dict[str, object],
    toolDefinitions: list[dict[str, object]],
    messages: list[dict[str, object]] | None = None,
) -> dict[str, object]:
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
    func = toolCall.get('function', {})
    if isinstance(func, dict):
        tool_name = func.get('name') or toolCall.get('name')
    else:
        tool_name = toolCall.get('name')
    if not isinstance(tool_name, str) or not tool_name:
        return {'valid': False, 'error': 'Missing tool name'}
    toolDef = _findToolDefinition(tool_name, toolDefinitions)
    if not toolDef:
        return {'valid': True}
    argsRaw = toolCall.get('input', '{}')
    if isinstance(func, dict):
        argsRaw = func.get('arguments', argsRaw)
    if isinstance(argsRaw, str):
        try:
            args = json.loads(argsRaw)
        except (json.JSONDecodeError, TypeError):
            return {'valid': False, 'error': f'Invalid JSON in arguments: {argsRaw[:200]}'}
    else:
        args = argsRaw
    if not isinstance(args, dict):
        return {'valid': False, 'error': f'Arguments must be a dict, got {type(args).__name__}'}
    schema = toolDef.get('parameters') or toolDef.get('input_schema')
    if isinstance(schema, dict):
        pass
    elif isinstance(toolDef.get('function'), dict):
        func = toolDef.get('function')
        if not isinstance(func, dict):
            schema = None
        else:
            schema = func.get('parameters')
    else:
        schema = None
    if not schema or not isinstance(schema, dict):
        return {'valid': True}
    args = _applyCompatibilityShims(tool_name, args)
    gateResult = _checkProxyExecutionGate(tool_name, args, messages)
    if not gateResult.get('valid'):
        return gateResult
    required = schema.get('required', [])
    if not isinstance(required, list):
        required = []
    for field in required:
        if not isinstance(field, str):
            continue
        if field not in args:
            return {'valid': False, 'error': f"Missing required field: '{field}'"}
        val = args[field]
        if val is None:
            return {'valid': False, 'error': f"Missing required field: '{field}'"}
        if isinstance(val, str) and (not val.strip()):
            return {'valid': False, 'error': f"Missing required field: '{field}'"}
    if schema.get('additionalProperties') is False:
        props = schema.get('properties', {})
        if not isinstance(props, dict):
            props = {}
        allowed = set(props.keys())
        extra = set(args.keys()) - allowed
        if extra:
            return {
                'valid': False,
                'error': f'Unknown fields: {", ".join(sorted(extra))}. Allowed fields: {", ".join(sorted(allowed))}',
            }
    properties = schema.get('properties', {})
    if not isinstance(properties, dict):
        properties = {}
    for field, value in args.items():
        propSchema = properties.get(field, {})
        if not isinstance(propSchema, dict):
            propSchema = {}
        propType = propSchema.get('type', '')
        if propType == 'string' and (not isinstance(value, str)):
            return {'valid': False, 'error': f"Field '{field}' must be a string"}
        if propType == 'integer' and (not isinstance(value, int)):
            return {'valid': False, 'error': f"Field '{field}' must be an integer"}
        if propType == 'number' and (not isinstance(value, (int, float))):
            return {'valid': False, 'error': f"Field '{field}' must be a number"}
        if propType == 'boolean' and (not isinstance(value, bool)):
            return {'valid': False, 'error': f"Field '{field}' must be a boolean"}
        if propType == 'array' and (not isinstance(value, list)):
            return {'valid': False, 'error': f"Field '{field}' must be an array"}
        if propType == 'object' and (not isinstance(value, dict)):
            return {'valid': False, 'error': f"Field '{field}' must be an object"}
    return {'valid': True}


def buildValidationErrorToolMessage(tool_call_id: str, tool_name: str, error_msg: str) -> dict[str, object]:
    """Build a tool result message for a validation error."""
    return {
        'tool_call_id': tool_call_id,
        'role': 'tool',
        'content': f"[Validation Error] Tool '{tool_name}' rejected before execution:\n{error_msg}\n\n[Proxy Self-Heal]: Fix the tool arguments and retry. Do NOT stop.",
    }


def _findToolDefinition(name: str, definitions: list[dict[str, object]]) -> dict[str, object] | None:
    """Find a tool definition by name, supporting both Anthropic and OpenAI formats."""
    for t in definitions:
        func = t.get('function', {})
        if isinstance(func, dict):
            tName = func.get('name') or t.get('name')
        else:
            tName = t.get('name')
        if tName == name:
            return t
    return None


def _applyCompatibilityShims(tool_name: str, args: dict[str, object]) -> dict[str, object]:
    """Apply compatibility shims for common tool name mappings."""
    if tool_name in ('WebFetch', 'web_fetch', 'mcp__workspace__web_fetch'):
        if 'prompt' in args and 'url' not in args:
            args = dict(args)
            args['url'] = args['prompt']
    if tool_name in ('WebSearch', 'web_search', 'mcp__workspace__web_search'):
        if 'prompt' in args and 'query' not in args:
            args = dict(args)
            args['query'] = args['prompt']
    return args


_MUTATINGToolPatterns = re.compile(
    '^(StrReplaceEditTool|BashTool|MCP.*(?:write|create|move|edit|delete|rename|copy)|mcp__.*(?:write|create|move|edit|delete))',
    re.IGNORECASE,
)


_PLAN_APPROVAL_PATTERNS = re.compile(
    r'(\.aug/plans/|plan\.md|plan_approved|Plan approved)',
    re.IGNORECASE,
)


def _checkProxyExecutionGate(
    tool_name: str, args: dict[str, object], messages: list[dict[str, object]]
) -> dict[str, object]:
    """Proxy Execution Gate: block mutating tools until a plan is approved.

    Checks for plan approval signals in the conversation context:
    - ``.aug/plans/`` path references (session plan files)
    - ``plan.md`` references (legacy plan files)
    - ``plan_approved`` or ``Plan approved`` markers
    """
    if not _MUTATINGToolPatterns.match(tool_name):
        return {'valid': True}
    for msg in messages:
        content = msg.get('content', '')
        if isinstance(content, str) and _PLAN_APPROVAL_PATTERNS.search(content):
            return {'valid': True}
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    text = block.get('text', '')
                    if isinstance(text, str) and _PLAN_APPROVAL_PATTERNS.search(text):
                        return {'valid': True}
    return {
        'valid': False,
        'error': f"Tool '{tool_name}' is blocked by the Proxy Execution Gate. No approved plan was found in the conversation. Create and approve a plan before using mutating tools.",
    }
