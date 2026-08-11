"""
Tool bridges — bridge tools that replace deferred tool schemas (Phase 3).

When progressive disclosure activates (≥200 tools), the three bridge tools
let the model search, describe, and call any deferred tool without their
schemas taking up prompt space.

The bridge names are registered with real handlers (``register()``) so a
model call to ``tool_call`` actually executes — previously the names were
reserved-but-unregistered, so calls returned "Tool not found" (audit finding).
"""

from __future__ import annotations

import json

# Names are now registered like any other tool; the set documents which names
# belong to the bridge (kept for import-compat with isReserved callers).
_RESERVEDNames = frozenset({'tool_search', 'tool_describe', 'tool_call'})


def isReserved(name: str) -> bool:
    """Check if a tool name is a bridge tool."""
    return name in _RESERVEDNames


def _toolDefName(t: object) -> str:
    """Extract the tool name from internal or OpenAI-wrapped definitions."""
    if not isinstance(t, dict):
        return ''
    direct = t.get('name')
    if isinstance(direct, str):
        return direct
    fn = t.get('function')
    if isinstance(fn, dict):
        wrapped = fn.get('name')
        if isinstance(wrapped, str):
            return wrapped
    return ''


async def handleToolSearch(query: str, limit: int = 5) -> str:
    """Search across ALL deferred tools using BM25."""
    from app.services.tool_registry import listTools
    from app.services.tools.retrieval import buildToolCatalog, searchTools

    allTools = listTools()
    catalog = buildToolCatalog(allTools)
    results = searchTools(catalog, query, k=limit)
    if not results:
        return 'No matching tools found.'
    byName = {_toolDefName(t): t for t in allTools if _toolDefName(t)}
    lines = [f'Tool search results for: {query}']
    for name in results:
        t = byName.get(name)
        desc = t.get('description', '') if isinstance(t, dict) else ''
        if desc:
            lines.append(f'  {name}: {desc}')
        else:
            lines.append(f'  {name}')
    return '\n'.join(lines)


async def handleToolDescribe(name: str) -> str:
    """Return the full JSON schema for one deferred tool."""
    from app.services.tool_registry import getTool

    tool = getTool(name)
    if not tool:
        return f"Tool '{name}' not found."
    schema = tool.get('input_schema', tool.get('parameters', {}))
    desc = tool.get('description', '')
    parts = [f'Tool: {name}']
    if desc:
        parts.append(f'Description: {desc}')
    parts.append(f'Schema:\n{json.dumps(schema, indent=2)}')
    return '\n'.join(parts)


async def handleToolCall(name: str, arguments: str) -> str:
    """Invoke a deferred tool by name.

    ``arguments`` should be a JSON string matching the tool's schema.
    """
    from app.services.tool_registry import dispatch

    try:
        args = json.loads(arguments) if arguments else {}
        if not isinstance(args, dict):
            return 'Invalid arguments JSON: expected an object.'
    except json.JSONDecodeError as e:
        return f'Invalid arguments JSON: {e}'
    try:
        # dispatch(name, args: dict) — previously called with **args, which
        # passed the argument VALUES as the `args` parameter (a string for
        # most tools) and always raised TypeError.
        result = await dispatch(name, args)
        return str(result)
    except Exception as exc:
        return f"Error calling '{name}': {exc}"


def register() -> None:
    """Register the bridge tools with their handlers."""
    from app.services import tool_registry

    tool_registry.register(
        'tool_search',
        'Search across ALL available tools using BM25. Use this when you need a tool you do not see listed.',
        handleToolSearch,
        {
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': 'Search query describing what you need.'},
                'limit': {'type': 'integer', 'description': 'Max results (1-10).', 'default': 5},
            },
            'required': ['query'],
        },
        keywords=['search', 'find tool', 'discover'],
    )
    tool_registry.register(
        'tool_describe',
        'Get the full JSON schema for any tool.',
        handleToolDescribe,
        {
            'type': 'object',
            'properties': {'name': {'type': 'string', 'description': 'The tool name to describe.'}},
            'required': ['name'],
        },
        keywords=['describe', 'schema', 'usage'],
    )
    tool_registry.register(
        'tool_call',
        "Call a tool by name with JSON arguments. Use this to invoke a tool that isn't directly visible.",
        handleToolCall,
        {
            'type': 'object',
            'properties': {
                'name': {'type': 'string', 'description': 'The tool name to call.'},
                'arguments': {'type': 'string', 'description': "JSON arguments matching the tool's schema."},
            },
            'required': ['name', 'arguments'],
        },
        keywords=['call tool', 'invoke', 'execute'],
    )
