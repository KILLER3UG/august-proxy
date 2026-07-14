"""
Proxy tool definitions and managed tool execution dispatch.

Port of backend/adapters/proxy-tools.js.

This module provides:
- Managed tool name sets (web search/fetch, bash)
- Tool definition builders (Anthropic and OpenAI format) — re-exported from proxy_tool_defs
- Format converters (Anthropic ↔ OpenAI tool definitions) — re-exported from proxy_tool_defs
- Tool execution dispatch for proxy-managed tools
- Tool result formatting
"""

from __future__ import annotations
import json
from typing import Callable

from app.adapters.proxy_tool_defs import (
    append_missing_tools,
    anthropic_to_openai_tool_definition,
    appendMissingAnthropicTools,
    appendMissingOpenaiTools,
    dedupe_and_canonicalize_anthropic_tools,
    get_canonical_cowork_anthropic_tools,
    get_canonical_managed_anthropic_openai_web_tools,
    get_canonical_managed_anthropic_web_tools,
    get_canonical_managed_openai_web_tools,
    get_managed_anthropic_web_tool_definitions,
    get_proxy_openai_tool_definitions,
    get_proxy_openai_tool_definitions_for_anthropic,
    get_tool_definition_name,
    openai_to_anthropic_tool_definition,
    sanitize_anthropic_tool_definition,
    sanitize_tool_schema,
)

# Re-export definition helpers for back-compat (``from app.adapters.proxy_tools import X``).
__all__ = [
    'MANAGED_WEB_TOOL_NAMES',
    'MANAGED_BASH_TOOL_NAMES',
    'is_managed_web_tool_name',
    'is_managed_bash_tool_name',
    'get_managed_web_tool_kind',
    'get_managed_web_local_tool_name',
    'sanitize_tool_schema',
    'get_managed_anthropic_web_tool_definitions',
    'sanitize_anthropic_tool_definition',
    'dedupe_and_canonicalize_anthropic_tools',
    'get_canonical_managed_anthropic_web_tools',
    'openai_to_anthropic_tool_definition',
    'anthropic_to_openai_tool_definition',
    'get_canonical_cowork_anthropic_tools',
    'get_canonical_managed_openai_web_tools',
    'get_canonical_managed_anthropic_openai_web_tools',
    'get_proxy_openai_tool_definitions',
    'get_proxy_openai_tool_definitions_for_anthropic',
    'get_tool_definition_name',
    'append_missing_tools',
    'appendMissingAnthropicTools',
    'appendMissingOpenaiTools',
    'is_proxy_managed_local_tool_name',
    'remember_managed_local_tool_definitions',
    'build_client_tool_guidance',
    'is_browser_automation_tool_name',
    'format_managed_web_result',
    'format_managed_tool_result',
    'execute_managed_proxy_tool',
    'execute_managed_openai_tool_calls',
]

MANAGED_WEB_TOOL_NAMES: set[str] = {
    'WebSearch',
    'WebFetch',
    'web_search',
    'web_fetch',
    'mcp__workspace__web_search',
    'mcp__workspace__web_fetch',
}
MANAGED_BASH_TOOL_NAMES: set[str] = {'bash', 'mcp__workspace__bash'}


def is_managed_web_tool_name(name: str) -> bool:
    return isinstance(name, str) and name in MANAGED_WEB_TOOL_NAMES


def is_managed_bash_tool_name(name: str) -> bool:
    return isinstance(name, str) and name in MANAGED_BASH_TOOL_NAMES


def get_managed_web_tool_kind(name: str) -> str | None:
    if not isinstance(name, str):
        return None
    if name in ('WebSearch', 'web_search', 'mcp__workspace__web_search'):
        return 'search'
    if name in ('WebFetch', 'web_fetch', 'mcp__workspace__web_fetch'):
        return 'fetch'
    return None


def get_managed_web_local_tool_name(toolName: str) -> str:
    """Map variant tool names to canonical local names."""
    if toolName in ('WebSearch', 'web_search', 'mcp__workspace__web_search'):
        return 'web_search'
    return 'web_fetch'


def _stub_is_tool_name(name: str) -> bool:
    return False


def _stub_execute_tool(name: str, args: dict[str, object]) -> str:
    return f'Stub: {name} not yet implemented'


def _stub_log_activity(category: str, detail: str) -> None:
    pass


def _get_brain_config() -> dict[str, object]:
    """Placeholder — returns defaults until brain-orchestrator is ported."""
    return {'adapter_parallel_tools': False}


def _record_tool_failure(info: dict[str, object]) -> None:
    """Placeholder — no-op until tool-failure-memory is ported."""
    pass


def _validate_tool_arguments(
    toolCall: dict[str, object], toolDefinitions: list[dict[str, object]], messages: list[dict[str, object]]
) -> dict[str, object]:
    """Placeholder — returns valid until validator is ported."""
    return {'valid': True}


def _execute_tool_batch(
    toolCalls: list[dict[str, object]], executeOne: Callable[..., object], options: dict[str, object] | None = None
) -> list[object]:
    """Placeholder — returns empty list until tool-executor is ported."""
    return []


def _is_tool_parallel_safe(toolName: str, args: dict[str, object] | None = None) -> bool:
    """Placeholder — returns False until managed-tool-policy is ported."""
    return False


def is_proxy_managed_local_tool_name(name: str) -> bool:
    """Check if a tool name is proxy-managed."""
    return (
        is_managed_web_tool_name(name)
        or is_managed_bash_tool_name(name)
        or _stub_is_tool_name(name)
        or _stub_is_tool_name(name)
        or _stub_is_tool_name(name)
    )


def remember_managed_local_tool_definitions(
    tools: list[dict[str, object]], ctx: dict[str, object] | None = None
) -> list[str]:
    """Remember which tool definitions are proxy-managed."""
    if not ctx or 'managed_local_tool_names' not in ctx:
        return []
    names: list[str] = []
    for tool in tools or []:
        name = get_tool_definition_name(tool)
        if not is_proxy_managed_local_tool_name(name):
            continue
        managedNames = ctx.get('managed_local_tool_names')
        assert isinstance(managedNames, set)
        managedNames.add(name)
        names.append(name)
    return names


def build_client_tool_guidance(clientTools: list[dict[str, object]] | None) -> str:
    """Build system prompt guidance for client-side tools."""
    if not clientTools:
        return ''
    visibleNames: list[str] = []
    for t in clientTools:
        name = t.get('name')
        if isinstance(name, str):
            visibleNames.append(name)
        else:
            func = t.get('function', {})
            if isinstance(func, dict):
                fname = func.get('name')
                if isinstance(fname, str):
                    visibleNames.append(fname)
    if not visibleNames:
        return ''
    webLike = [n for n in visibleNames if 'fetch' in n.lower() or 'search' in n.lower()]
    lines = ['[CLIENT TOOL INVENTORY]', f'Visible client tools include: {", ".join(visibleNames)}.']
    if webLike:
        lines.append(f'For web access, prefer these visible client-compatible tool names first: {", ".join(webLike)}.')
        lines.append(
            'If one of those visible web-fetch tools fails or is blocked, retry the research using the same compatible web-fetch/search name that remains available.'
        )
        lines.append(
            'Do not switch to browser automation for ordinary public web research while a compatible web fetch/search tool is available.'
        )
    return '\n'.join(lines)


def is_browser_automation_tool_name(name: str) -> bool:
    """Check if a tool name looks like a browser automation tool."""
    if not isinstance(name, str):
        return False
    lower = name.lower()
    browserKeywords = [
        'list_connected_browsers',
        'browser_navigate',
        'browser_snapshot',
        'browser_click',
        'browser_type',
        'browser_wait',
        'browser',
        'chrome',
    ]
    return any((kw in lower for kw in browserKeywords))


def format_managed_web_result(result: object) -> str:
    """Format web search/fetch results as readable text."""
    if not result or not isinstance(result, dict):
        return str(result or '')
    if isinstance(result.get('results'), list):
        lines: list[str] = []
        query = result.get('query', '')
        if query:
            lines.append(f'Search query: {query}'.strip())
        lines.append(f'Result count: {result.get("count") or len(result["results"])}')
        for i, item in enumerate(result['results']):
            lines.append(f'[{i + 1}] {item.get("title", "Untitled")}')
            if item.get('url'):
                lines.append(f'URL: {item["url"]}')
            if item.get('snippet'):
                lines.append(f'Snippet: {item["snippet"]}')
        return '\n'.join(lines)
    if result.get('url') or result.get('content'):
        parts = [
            f'Title: {result.get("title", "")}'.strip(),
            f'URL: {result.get("url", "")}'.strip(),
            f'Status: {result["status"]}' if result.get('status') else '',
            '',
            result.get('content', ''),
        ]
        return '\n'.join((p for p in parts if p))
    return json.dumps(result)


def format_managed_tool_result(toolName: str, result: object) -> str:
    """Format a managed tool execution result."""
    if is_managed_web_tool_name(toolName):
        return format_managed_web_result(result)
    if is_managed_bash_tool_name(toolName):
        if not isinstance(result, dict):
            return str(result or '')
        parts = []
        if result.get('stdout'):
            parts.append(result['stdout'])
        if result.get('stderr'):
            parts.append(f'STDERR:\n{result["stderr"]}')
        if result.get('exit_code'):
            parts.append(f'Exit code: {result["exit_code"]}')
        return '\n'.join(parts) or '(no output)'
    if isinstance(result, str):
        return result
    if result is None:
        return ''
    return json.dumps(result)


async def execute_managed_proxy_tool(
    toolName: str,
    args: dict[str, object],
    workspace_path: str | None = None,
    onProgress: Callable[[str], None] | None = None,
    parentSignal: object = None,
) -> object:
    """Execute a managed proxy tool by dispatching to the correct backend.

    Currently stubs all external service calls. Real implementations come
    in Phases 3-5 (tool handlers, MCP client, etc.).
    """
    if is_managed_web_tool_name(toolName):
        localName = get_managed_web_local_tool_name(toolName)
        _stub_log_activity('WEB', f'{toolName} executed locally')
        return _stub_execute_tool(localName, args or {})
    if is_managed_bash_tool_name(toolName):
        _stub_log_activity('BASH', f'{toolName} executed locally')
        return _stub_execute_tool(toolName, args or {})
    if _stub_is_tool_name(toolName):
        _stub_log_activity('TOOL', f'{toolName} executed by proxy')
        return _stub_execute_tool(toolName, args or {})
    raise ValueError(f'Unsupported managed proxy tool: {toolName}')


async def execute_managed_openai_tool_calls(
    toolCalls: list[dict[str, object]],
    knownTools: list[dict[str, object]],
    messages: list[dict[str, object]],
    workspace_path: str | None = None,
    onToolEvent: Callable[[dict[str, object]], None] | None = None,
    parentSignal: object = None,
) -> list[dict[str, object]]:
    """Execute OpenAI-format managed tool calls.

    Currently uses stubs for validation and brain config.
    """
    results: list[dict[str, object]] = []
    for tc in toolCalls:
        func = tc.get('function', {})
        if isinstance(func, dict):
            toolName = func.get('name')
        else:
            toolName = None
        if not toolName or not isinstance(toolName, str):
            results.append({'tool_call_id': tc.get('id'), 'role': 'tool', 'content': 'Error: missing tool name'})
            continue
        if isinstance(func, dict):
            argsRaw = func.get('arguments', '{}')
        else:
            argsRaw = '{}'
        syntheticCall: dict[str, object] = {'function': {'name': toolName, 'arguments': argsRaw}}
        validation = _validate_tool_arguments(syntheticCall, knownTools, messages)
        if not validation.get('valid'):
            _stub_log_activity('VALIDATOR', f"OpenAI tool '{toolName}' rejected: {validation.get('error')}")
            results.append(
                {
                    'tool_call_id': tc.get('id'),
                    'role': 'tool',
                    'content': f"[Validation Error] Tool '{toolName}' rejected before execution:\n{validation.get('error')}\n\n[Proxy Self-Heal]: Fix the tool arguments and retry.",
                }
            )
            continue
        try:
            if isinstance(func, dict):
                argStr = func.get('arguments', '{}')
                assert isinstance(argStr, str)
                parsedArgs = json.loads(argStr)
            else:
                parsedArgs = {}
        except (json.JSONDecodeError, TypeError):
            parsedArgs = {}
        try:
            result = await execute_managed_proxy_tool(toolName, parsedArgs, workspace_path, parentSignal=parentSignal)
            results.append(
                {'tool_call_id': tc.get('id'), 'role': 'tool', 'content': format_managed_tool_result(toolName, result)}
            )
        except Exception as exc:
            _record_tool_failure(
                {'tool_name': toolName, 'args': parsedArgs, 'error': str(exc), 'phase': 'openai-managed-tool'}
            )
            results.append({'tool_call_id': tc.get('id'), 'role': 'tool', 'content': f'Error: {exc}'})
    return results
