"""
Tool bridges — bridge tools that replace deferred tool schemas (Phase 3).

When progressive disclosure activates (≥200 tools), the three bridge tools
let the model search, describe, and call any deferred tool without their
schemas taking up prompt space.

Reserved names (registry rejects these):
    tool_search, tool_describe, tool_call
"""
from __future__ import annotations
import json
from typing import Any
_RESERVEDNames = frozenset({'tool_search', 'tool_describe', 'tool_call'})

def isReserved(name: str) -> bool:
    """Check if a tool name is reserved for bridges."""
    return name in _RESERVEDNames

async def handleToolSearch(query: str, limit: int=5) -> str:
    """Search across ALL deferred tools using BM25."""
    from app.services.tools.retrieval import buildToolCatalog, searchTools
    from app.services.tool_registry import listTools
    allTools = listTools()
    catalog = buildToolCatalog(allTools)
    results = searchTools(catalog, query, k=limit)
    if not results:
        return 'No matching tools found.'
    lines = [f'Tool search results for: {query}']
    for name in results:
        for t in allTools:
            if isinstance(t, dict) and t.get('name') == name:
                desc = t.get('description', '')
                if desc:
                    lines.append(f'  {name}: {desc}')
                else:
                    lines.append(f'  {name}')
                break
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
    except json.JSONDecodeError as e:
        return f'Invalid arguments JSON: {e}'
    try:
        result = await dispatch(name, **args)
        return str(result)
    except Exception as exc:
        return f"Error calling '{name}': {exc}"