"""Pure proxy tool definition builders, schema sanitizers, and format converters.

Extracted from :mod:`app.adapters.proxy_tools` so execution dispatch stays
separate from definition/schema helpers (Phase 3 modularization).
"""

from __future__ import annotations

from app.models import ToolDefinition


def _stub_tool_definitions() -> list[dict[str, object]]:
    """Placeholder — returns empty list until MCP/Cowork/August tools are implemented."""
    return []


def sanitize_tool_schema(schema: object) -> dict[str, object]:
    """Sanitize a JSON Schema to ensure it has the expected structure."""
    if not isinstance(schema, dict):
        return {'type': 'object', 'properties': {}}
    result = dict(schema)
    if 'type' not in result:
        result['type'] = 'object'
    if 'properties' not in result:
        result['properties'] = {}
    return result


def get_managed_anthropic_web_tool_definitions() -> list[dict[str, object]]:
    """Return Anthropic-format tool definitions for managed web/bash tools."""
    return [
        {
            'name': 'WebSearch',
            'description': 'Search the public web for ranked titles, URLs, and snippets only (does not download page bodies). Supports DuckDuckGo (default), Brave Search, and SearXNG. Then use WebFetch for pages you need. External/public information only. Do not combine this tool with any other tool in the same turn.',
            'input_schema': {
                'type': 'object',
                'properties': {
                    'query': {'type': 'string', 'description': 'The web search query.'},
                    'prompt': {
                        'type': 'string',
                        'description': 'Compatibility alias for query when a stale client schema still sends prompt.',
                    },
                    'max_results': {'type': 'integer', 'description': 'Maximum number of results to return (max 20).'},
                },
                'required': ['query'],
            },
        },
        {
            'name': 'WebFetch',
            'description': 'Fetch a public webpage by URL and convert it to clean Markdown. Use after WebSearch when you need page content. Long pages may be summarized. Private/local network addresses are blocked. Do not combine this tool with any other tool in the same turn.',
            'input_schema': {
                'type': 'object',
                'properties': {
                    'url': {'type': 'string', 'description': 'The public HTTP or HTTPS URL to fetch.'},
                    'prompt': {
                        'type': 'string',
                        'description': 'Compatibility alias for url when a stale client schema still sends prompt containing the URL.',
                    },
                },
                'required': ['url'],
            },
        },
        {
            'name': 'mcp__workspace__web_search',
            'description': 'Search the public web for ranked titles, URLs, and snippets only (does not download page bodies). Supports DuckDuckGo (default), Brave Search, and SearXNG. Workspace-compatible alias for third-party Claude clients. Do not combine this tool with any other tool in the same turn.',
            'input_schema': {
                'type': 'object',
                'properties': {
                    'query': {'type': 'string', 'description': 'The web search query.'},
                    'prompt': {
                        'type': 'string',
                        'description': 'Compatibility alias for query when a stale client schema still sends prompt.',
                    },
                    'max_results': {'type': 'integer', 'description': 'Maximum number of results to return (max 20).'},
                },
                'required': ['query'],
            },
        },
        {
            'name': 'mcp__workspace__web_fetch',
            'description': 'Fetch a public webpage by URL and convert it to clean Markdown. Use after web search when you need page content. Long pages may be summarized. Workspace-compatible alias for third-party Claude clients. Private/local network addresses are blocked. Do not combine this tool with any other tool in the same turn.',
            'input_schema': {
                'type': 'object',
                'properties': {
                    'url': {'type': 'string', 'description': 'The public HTTP or HTTPS URL to fetch.'},
                    'prompt': {
                        'type': 'string',
                        'description': 'Compatibility alias for url when a stale client schema still sends prompt containing the URL.',
                    },
                },
                'required': ['url'],
            },
        },
        {
            'name': 'mcp__workspace__bash',
            'description': 'Execute a bash command in the proxy workspace container. Returns stdout, stderr, and exit code. Use for file operations, code analysis, git commands, and scripting.',
            'input_schema': {
                'type': 'object',
                'properties': {
                    'command': {'type': 'string', 'description': 'The bash command to execute.'},
                    'timeout_ms': {'type': 'integer', 'description': 'Timeout in milliseconds (default 60000).'},
                },
                'required': ['command'],
            },
        },
    ]


def sanitize_anthropic_tool_definition(tool: dict[str, object] | None) -> dict[str, object] | None:
    """Normalize an Anthropic-format tool definition."""
    if not tool or not isinstance(tool, dict):
        return None
    normalized = tool
    if tool.get('type') == 'function':
        func = tool.get('function')
        if isinstance(func, dict):
            normalized = {
                'name': func.get('name'),
                'description': func.get('description', ''),
                'input_schema': func.get('parameters', {'type': 'object', 'properties': {}}),
            }
    name = str(normalized.get('name', '')).strip() if normalized.get('name') else ''
    if not name:
        return None
    return {
        'name': name,
        'description': str(normalized.get('description', '')),
        'input_schema': sanitize_tool_schema(normalized.get('input_schema', {})),
    }


def dedupe_and_canonicalize_anthropic_tools(tools: list[dict[str, object]]) -> list[dict[str, object]]:
    """Deduplicate and canonicalize Anthropic-format tool definitions.

    Replaces managed web tool variants with canonical versions, and
    strips browser automation tools.
    """
    # Lazy imports avoid a circular dependency with proxy_tools (name helpers).
    from app.adapters.proxy_tools import get_managed_web_tool_kind, is_browser_automation_tool_name

    sanitized: list[dict[str, object]] = []
    includeManagedSearch = False
    includeManagedFetch = False
    seenNames: set[str] = set()
    for raw in tools or []:
        t = sanitize_anthropic_tool_definition(raw)
        if not t:
            continue
        name = t.get('name')
        assert isinstance(name, str)
        if is_browser_automation_tool_name(name):
            continue
        kind = get_managed_web_tool_kind(name)
        if kind == 'search':
            includeManagedSearch = True
            continue
        if kind == 'fetch':
            includeManagedFetch = True
            continue
        if name in seenNames:
            continue
        seenNames.add(name)
        sanitized.append(t)
    for ct in get_managed_anthropic_web_tool_definitions():
        ctName = ct.get('name')
        assert isinstance(ctName, str)
        kind = get_managed_web_tool_kind(ctName)
        if kind == 'search' and includeManagedSearch or (kind == 'fetch' and includeManagedFetch):
            if ctName not in seenNames:
                seenNames.add(ctName)
                sanitized.append(ct)
    bashDefs = [t for t in get_managed_anthropic_web_tool_definitions() if t.get('name') == 'mcp__workspace__bash']
    for bd in bashDefs:
        bdName = bd.get('name')
        assert isinstance(bdName, str)
        if bdName not in seenNames:
            seenNames.add(bdName)
            sanitized.append(bd)
    return sanitized


def get_canonical_managed_anthropic_web_tools() -> list[dict[str, object]]:
    """Return only the canonical web tool definitions."""
    return [
        t
        for t in get_managed_anthropic_web_tool_definitions()
        if t['name'] in ('WebSearch', 'WebFetch', 'mcp__workspace__bash')
    ]


def openai_to_anthropic_tool_definition(tool: dict[str, object]) -> dict[str, object]:
    """Convert an OpenAI-format tool definition to Anthropic format."""
    if tool and tool.get('type') == 'function':
        func = tool.get('function')
        assert isinstance(func, dict)
        return {
            'name': func.get('name'),
            'description': func.get('description', ''),
            'input_schema': sanitize_tool_schema(func.get('parameters', {})),
        }
    return tool


def anthropic_to_openai_tool_definition(tool: dict[str, object]) -> dict[str, object]:
    """Convert an Anthropic-format tool definition to OpenAI format."""
    return {
        'type': 'function',
        'function': {
            'name': tool.get('name', ''),
            'description': tool.get('description', ''),
            'parameters': sanitize_tool_schema(tool.get('input_schema', {})),
            'strict': tool.get('strict'),
        },
    }


def get_canonical_cowork_anthropic_tools() -> list[dict[str, object]]:
    """Return Cowork tools in Anthropic format."""
    return [openai_to_anthropic_tool_definition(t) for t in _stub_tool_definitions()]


def get_canonical_managed_openai_web_tools() -> list[dict[str, object]]:
    """Return OpenAI-format managed web tool definitions."""
    return [
        {
            'type': 'function',
            'function': {
                'name': 'WebSearch',
                'description': 'Search the public web for relevant pages.',
                'parameters': {
                    'type': 'object',
                    'properties': {
                        'query': {'type': 'string', 'description': 'The web search query.'},
                        'prompt': {'type': 'string', 'description': 'Compatibility alias for query.'},
                        'max_results': {'type': 'integer', 'description': 'Maximum number of results (max 20).'},
                    },
                    'required': ['query'],
                },
            },
        },
        {
            'type': 'function',
            'function': {
                'name': 'WebFetch',
                'description': 'Fetch a public webpage by URL and convert it to clean Markdown.',
                'parameters': {
                    'type': 'object',
                    'properties': {
                        'url': {'type': 'string', 'description': 'The public HTTP or HTTPS URL to fetch.'},
                        'prompt': {'type': 'string', 'description': 'Compatibility alias for url.'},
                    },
                    'required': ['url'],
                },
            },
        },
        {
            'type': 'function',
            'function': {
                'name': 'mcp__workspace__web_search',
                'description': 'Search the public web. Workspace-compatible alias.',
                'parameters': {
                    'type': 'object',
                    'properties': {
                        'query': {'type': 'string', 'description': 'The web search query.'},
                        'prompt': {'type': 'string', 'description': 'Compatibility alias for query.'},
                        'max_results': {'type': 'integer', 'description': 'Maximum number of results (max 20).'},
                    },
                    'required': ['query'],
                },
            },
        },
        {
            'type': 'function',
            'function': {
                'name': 'mcp__workspace__web_fetch',
                'description': 'Fetch a webpage by URL. Workspace-compatible alias.',
                'parameters': {
                    'type': 'object',
                    'properties': {
                        'url': {'type': 'string', 'description': 'The public HTTP or HTTPS URL to fetch.'},
                        'prompt': {'type': 'string', 'description': 'Compatibility alias for url.'},
                    },
                    'required': ['url'],
                },
            },
        },
    ]


def get_canonical_managed_anthropic_openai_web_tools() -> list[dict[str, object]]:
    """Return managed web tools in OpenAI format (Anthropic-mapped)."""
    return [anthropic_to_openai_tool_definition(t) for t in get_canonical_managed_anthropic_web_tools()]


def get_proxy_openai_tool_definitions() -> list[dict[str, object]]:
    """Return all proxy tool definitions in OpenAI format."""
    return [
        *_stub_tool_definitions(),
        *_stub_tool_definitions(),
        *_stub_tool_definitions(),
        *get_canonical_managed_openai_web_tools(),
    ]


def get_proxy_openai_tool_definitions_for_anthropic() -> list[dict[str, object]]:
    """Return all proxy tool definitions in Anthropic format."""
    return [
        *_stub_tool_definitions(),
        *_stub_tool_definitions(),
        *_stub_tool_definitions(),
        *get_canonical_managed_anthropic_openai_web_tools(),
    ]


def get_tool_definition_name(tool: ToolDefinition | dict[str, object]) -> str:
    """Extract the name from a tool definition (Anthropic or OpenAI format)."""
    if isinstance(tool, ToolDefinition):
        return tool.function.name
    func = tool.get('function', {})
    if isinstance(func, dict):
        name = func.get('name')
        if isinstance(name, str):
            return name
    name = tool.get('name')
    return name if isinstance(name, str) else ''


def append_missing_tools(targetTools: list[dict[str, object]], extraTools: list[dict[str, object]]) -> list[str]:
    """Append tools from extra_tools that are not already in target_tools."""
    seen = {get_tool_definition_name(t) for t in targetTools or [] if get_tool_definition_name(t)}
    appended: list[str] = []
    for tool in extraTools or []:
        name = get_tool_definition_name(tool)
        if not name or name in seen:
            continue
        seen.add(name)
        targetTools.append(tool)
        appended.append(name)
    return appended


appendMissingAnthropicTools = append_missing_tools
appendMissingOpenaiTools = append_missing_tools
