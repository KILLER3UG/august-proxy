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
        toolName = func.get('name') or toolCall.get('name')
    else:
        toolName = toolCall.get('name')
    if not isinstance(toolName, str) or not toolName:
        return {'valid': False, 'error': 'Missing tool name'}
    toolDef = _findToolDefinition(toolName, toolDefinitions)
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
    assert isinstance(args, dict)
    schema = toolDef.get('parameters') or toolDef.get('input_schema')
    if isinstance(schema, dict):
        pass
    elif isinstance(toolDef.get('function'), dict):
        func = toolDef.get('function')
        assert isinstance(func, dict)
        schema = func.get('parameters')
    else:
        schema = None
    if not schema or not isinstance(schema, dict):
        return {'valid': True}
    args = _applyCompatibilityShims(toolName, args)
    gateResult = _checkProxyExecutionGate(toolName, args, messages)
    if not gateResult.get('valid'):
        return gateResult
    required = schema.get('required', [])
    assert isinstance(required, list)
    for field in required:
        assert isinstance(field, str)
        if field not in args:
            return {'valid': False, 'error': f"Missing required field: '{field}'"}
        val = args[field]
        if val is None:
            return {'valid': False, 'error': f"Missing required field: '{field}'"}
        if isinstance(val, str) and (not val.strip()):
            return {'valid': False, 'error': f"Missing required field: '{field}'"}
    if schema.get('additionalProperties') is False:
        props = schema.get('properties', {})
        assert isinstance(props, dict)
        allowed = set(props.keys())
        extra = set(args.keys()) - allowed
        if extra:
            return {
                'valid': False,
                'error': f'Unknown fields: {", ".join(sorted(extra))}. Allowed fields: {", ".join(sorted(allowed))}',
            }
    properties = schema.get('properties', {})
    assert isinstance(properties, dict)
    for field, value in args.items():
        propSchema = properties.get(field, {})
        assert isinstance(propSchema, dict)
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


def buildValidationErrorToolMessage(toolCallId: str, toolName: str, errorMsg: str) -> dict[str, object]:
    """Build a tool result message for a validation error."""
    return {
        'tool_call_id': toolCallId,
        'role': 'tool',
        'content': f"[Validation Error] Tool '{toolName}' rejected before execution:\n{errorMsg}\n\n[Proxy Self-Heal]: Fix the tool arguments and retry. Do NOT stop.",
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


def _applyCompatibilityShims(toolName: str, args: dict[str, object]) -> dict[str, object]:
    """Apply compatibility shims for common tool name mappings."""
    if toolName in ('WebFetch', 'web_fetch', 'mcp__workspace__web_fetch'):
        if 'prompt' in args and 'url' not in args:
            args = dict(args)
            args['url'] = args['prompt']
    if toolName in ('WebSearch', 'web_search', 'mcp__workspace__web_search'):
        if 'prompt' in args and 'query' not in args:
            args = dict(args)
            args['query'] = args['prompt']
    return args


_MUTATINGToolPatterns = re.compile(
    '^(StrReplaceEditTool|BashTool|MCP.*(?:write|create|move|edit|delete|rename|copy)|mcp__.*(?:write|create|move|edit|delete))',
    re.IGNORECASE,
)


def _checkProxyExecutionGate(
    toolName: str, args: dict[str, object], messages: list[dict[str, object]]
) -> dict[str, object]:
    """Proxy Execution Gate: block mutating tools if no plan.md in context.

    This prevents the model from making changes before a plan has been
    explicitly approved.
    """
    if not _MUTATINGToolPatterns.match(toolName):
        return {'valid': True}
    for msg in messages:
        content = msg.get('content', '')
        if isinstance(content, str) and 'plan.md' in content:
            return {'valid': True}
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    text = block.get('text', '')
                    if isinstance(text, str) and 'plan.md' in text:
                        return {'valid': True}
    return {
        'valid': False,
        'error': f"Tool '{toolName}' is blocked by the Proxy Execution Gate. No plan.md was found in the conversation. Create and approve a plan before using mutating tools.",
    }
