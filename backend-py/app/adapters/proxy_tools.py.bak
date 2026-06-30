"""
Proxy tool definitions and managed tool execution dispatch.

Port of backend/adapters/proxy-tools.js.

This module provides:
- Managed tool name sets (web search/fetch, bash)
- Tool definition builders (Anthropic and OpenAI format)
- Format converters (Anthropic ↔ OpenAI tool definitions)
- Tool execution dispatch for proxy-managed tools
- Tool result formatting
"""

from __future__ import annotations

import json
from typing import Any, Callable

# ── Managed tool name sets ────────────────────────────────────────────

MANAGED_WEB_TOOL_NAMES: set[str] = {
    "WebSearch",
    "WebFetch",
    "web_search",
    "web_fetch",
    "mcp__workspace__web_search",
    "mcp__workspace__web_fetch",
}

MANAGED_BASH_TOOL_NAMES: set[str] = {
    "bash",
    "mcp__workspace__bash",
}


def is_managed_web_tool_name(name: str) -> bool:
    return isinstance(name, str) and name in MANAGED_WEB_TOOL_NAMES


def is_managed_bash_tool_name(name: str) -> bool:
    return isinstance(name, str) and name in MANAGED_BASH_TOOL_NAMES


def get_managed_web_tool_kind(name: str) -> str | None:
    if not isinstance(name, str):
        return None
    if name in ("WebSearch", "web_search", "mcp__workspace__web_search"):
        return "search"
    if name in ("WebFetch", "web_fetch", "mcp__workspace__web_fetch"):
        return "fetch"
    return None


def get_managed_web_local_tool_name(tool_name: str) -> str:
    """Map variant tool names to canonical local names."""
    if tool_name in ("WebSearch", "web_search", "mcp__workspace__web_search"):
        return "web_search"
    return "web_fetch"


# ── External service stubs (filled in during Phases 3-5) ──────────────

def _stub_tool_definitions() -> list[dict[str, Any]]:
    """Placeholder — returns empty list until MCP/Cowork/August tools are implemented."""
    return []


def _stub_is_tool_name(name: str) -> bool:
    return False


def _stub_execute_tool(name: str, args: dict[str, Any]) -> str:
    return f"Stub: {name} not yet implemented"


def _stub_log_activity(category: str, detail: str) -> None:
    pass


def _get_brain_config() -> dict[str, Any]:
    """Placeholder — returns defaults until brain-orchestrator is ported."""
    return {"adapter_parallel_tools": False}


def _record_tool_failure(info: dict[str, Any]) -> None:
    """Placeholder — no-op until tool-failure-memory is ported."""
    pass


def _validate_tool_arguments(
    tool_call: dict[str, Any],
    tool_definitions: list[dict[str, Any]],
    messages: list[dict[str, Any]],
) -> dict[str, Any]:
    """Placeholder — returns valid until validator is ported."""
    return {"valid": True}


def _execute_tool_batch(
    tool_calls: list[dict[str, Any]],
    execute_one: Callable,
    options: dict[str, Any] | None = None,
) -> list[Any]:
    """Placeholder — returns empty list until tool-executor is ported."""
    return []


def _is_tool_parallel_safe(tool_name: str, args: dict[str, Any] | None = None) -> bool:
    """Placeholder — returns False until managed-tool-policy is ported."""
    return False


# ── Sanitize tool schema ──────────────────────────────────────────────

def sanitize_tool_schema(schema: Any) -> dict[str, Any]:
    """Sanitize a JSON Schema to ensure it has the expected structure."""
    if not isinstance(schema, dict):
        return {"type": "object", "properties": {}}
    result = dict(schema)
    if "type" not in result:
        result["type"] = "object"
    if "properties" not in result:
        result["properties"] = {}
    return result


# ── Anthropic-format tool definitions ─────────────────────────────────

def get_managed_anthropic_web_tool_definitions() -> list[dict[str, Any]]:
    """Return Anthropic-format tool definitions for managed web/bash tools."""
    return [
        {
            "name": "WebSearch",
            "description": "Search the public web for relevant pages. "
            "Supports DuckDuckGo (default), Brave Search, and SearXNG backends. "
            "Use only for external/public information. Do not combine this tool with any other tool in the same turn.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The web search query."},
                    "prompt": {
                        "type": "string",
                        "description": "Compatibility alias for query when a stale client schema still sends prompt.",
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of results to return (max 20).",
                    },
                },
                "required": ["query"],
            },
        },
        {
            "name": "WebFetch",
            "description": "Fetch a public webpage by URL and convert it to clean Markdown. "
            "Private/local network addresses are blocked. Do not combine this tool with any other tool in the same turn.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The public HTTP or HTTPS URL to fetch."},
                    "prompt": {
                        "type": "string",
                        "description": "Compatibility alias for url when a stale client schema still sends prompt containing the URL.",
                    },
                },
                "required": ["url"],
            },
        },
        {
            "name": "mcp__workspace__web_search",
            "description": "Search the public web for relevant pages. "
            "Supports DuckDuckGo (default), Brave Search, and SearXNG backends. "
            "Workspace-compatible alias for third-party Claude clients. "
            "Do not combine this tool with any other tool in the same turn.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The web search query."},
                    "prompt": {
                        "type": "string",
                        "description": "Compatibility alias for query when a stale client schema still sends prompt.",
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of results to return (max 20).",
                    },
                },
                "required": ["query"],
            },
        },
        {
            "name": "mcp__workspace__web_fetch",
            "description": "Fetch a public webpage by URL and convert it to clean Markdown. "
            "Workspace-compatible alias for third-party Claude clients. "
            "Private/local network addresses are blocked. Do not combine this tool with any other tool in the same turn.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The public HTTP or HTTPS URL to fetch."},
                    "prompt": {
                        "type": "string",
                        "description": "Compatibility alias for url when a stale client schema still sends prompt containing the URL.",
                    },
                },
                "required": ["url"],
            },
        },
        {
            "name": "mcp__workspace__bash",
            "description": "Execute a bash command in the proxy workspace container. "
            "Returns stdout, stderr, and exit code. "
            "Use for file operations, code analysis, git commands, and scripting.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The bash command to execute."},
                    "timeout_ms": {"type": "integer", "description": "Timeout in milliseconds (default 60000)."},
                },
                "required": ["command"],
            },
        },
    ]


def sanitize_anthropic_tool_definition(tool: dict[str, Any] | None) -> dict[str, Any] | None:
    """Normalize an Anthropic-format tool definition."""
    if not tool or not isinstance(tool, dict):
        return None

    normalized = tool
    if tool.get("type") == "function" and isinstance(tool.get("function"), dict):
        normalized = {
            "name": tool["function"].get("name"),
            "description": tool["function"].get("description", ""),
            "input_schema": tool["function"].get("parameters", {"type": "object", "properties": {}}),
        }

    name = str(normalized.get("name", "")).strip() if normalized.get("name") else ""
    if not name:
        return None

    return {
        "name": name,
        "description": str(normalized.get("description", "")),
        "input_schema": sanitize_tool_schema(normalized.get("input_schema", {})),
    }


def dedupe_and_canonicalize_anthropic_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate and canonicalize Anthropic-format tool definitions.

    Replaces managed web tool variants with canonical versions, and
    strips browser automation tools.
    """
    sanitized: list[dict[str, Any]] = []
    include_managed_search = False
    include_managed_fetch = False
    seen_names: set[str] = set()

    for raw in tools or []:
        t = sanitize_anthropic_tool_definition(raw)
        if not t:
            continue
        if is_browser_automation_tool_name(t["name"]):
            continue

        kind = get_managed_web_tool_kind(t["name"])
        if kind == "search":
            include_managed_search = True
            continue
        if kind == "fetch":
            include_managed_fetch = True
            continue

        if t["name"] in seen_names:
            continue
        seen_names.add(t["name"])
        sanitized.append(t)

    # Add canonical managed tool definitions
    for ct in get_managed_anthropic_web_tool_definitions():
        kind = get_managed_web_tool_kind(ct["name"])
        if (kind == "search" and include_managed_search) or (kind == "fetch" and include_managed_fetch):
            if ct["name"] not in seen_names:
                seen_names.add(ct["name"])
                sanitized.append(ct)

    # Always add bash
    bash_defs = [t for t in get_managed_anthropic_web_tool_definitions() if t["name"] == "mcp__workspace__bash"]
    for bd in bash_defs:
        if bd["name"] not in seen_names:
            seen_names.add(bd["name"])
            sanitized.append(bd)

    return sanitized


def get_canonical_managed_anthropic_web_tools() -> list[dict[str, Any]]:
    """Return only the canonical web tool definitions."""
    return [
        t for t in get_managed_anthropic_web_tool_definitions()
        if t["name"] in ("WebSearch", "WebFetch", "mcp__workspace__bash")
    ]


# ── Format converters ─────────────────────────────────────────────────

def openai_to_anthropic_tool_definition(tool: dict[str, Any]) -> dict[str, Any]:
    """Convert an OpenAI-format tool definition to Anthropic format."""
    if tool and tool.get("type") == "function":
        return {
            "name": tool["function"]["name"],
            "description": tool["function"].get("description", ""),
            "input_schema": sanitize_tool_schema(tool["function"].get("parameters", {})),
        }
    return tool


def anthropic_to_openai_tool_definition(tool: dict[str, Any]) -> dict[str, Any]:
    """Convert an Anthropic-format tool definition to OpenAI format."""
    return {
        "type": "function",
        "function": {
            "name": tool.get("name", ""),
            "description": tool.get("description", ""),
            "parameters": sanitize_tool_schema(tool.get("input_schema", {})),
            "strict": tool.get("strict"),
        },
    }


# ── Aggregated tool definitions ───────────────────────────────────────

def get_canonical_cowork_anthropic_tools() -> list[dict[str, Any]]:
    """Return Cowork tools in Anthropic format."""
    return [openai_to_anthropic_tool_definition(t) for t in _stub_tool_definitions()]


def get_canonical_managed_openai_web_tools() -> list[dict[str, Any]]:
    """Return OpenAI-format managed web tool definitions."""
    return [
        {
            "type": "function",
            "function": {
                "name": "WebSearch",
                "description": "Search the public web for relevant pages.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "The web search query."},
                        "prompt": {"type": "string", "description": "Compatibility alias for query."},
                        "max_results": {"type": "integer", "description": "Maximum number of results (max 20)."},
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "WebFetch",
                "description": "Fetch a public webpage by URL and convert it to clean Markdown.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string", "description": "The public HTTP or HTTPS URL to fetch."},
                        "prompt": {"type": "string", "description": "Compatibility alias for url."},
                    },
                    "required": ["url"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "mcp__workspace__web_search",
                "description": "Search the public web. Workspace-compatible alias.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "The web search query."},
                        "prompt": {"type": "string", "description": "Compatibility alias for query."},
                        "max_results": {"type": "integer", "description": "Maximum number of results (max 20)."},
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "mcp__workspace__web_fetch",
                "description": "Fetch a webpage by URL. Workspace-compatible alias.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string", "description": "The public HTTP or HTTPS URL to fetch."},
                        "prompt": {"type": "string", "description": "Compatibility alias for url."},
                    },
                    "required": ["url"],
                },
            },
        },
    ]


def get_canonical_managed_anthropic_openai_web_tools() -> list[dict[str, Any]]:
    """Return managed web tools in OpenAI format (Anthropic-mapped)."""
    return [
        anthropic_to_openai_tool_definition(t)
        for t in get_canonical_managed_anthropic_web_tools()
    ]


def get_proxy_openai_tool_definitions() -> list[dict[str, Any]]:
    """Return all proxy tool definitions in OpenAI format."""
    return [
        *_stub_tool_definitions(),  # MCP tools (placeholder)
        *_stub_tool_definitions(),  # Cowork tools (placeholder)
        *_stub_tool_definitions(),  # August tools (placeholder)
        *get_canonical_managed_openai_web_tools(),
    ]


def get_proxy_openai_tool_definitions_for_anthropic() -> list[dict[str, Any]]:
    """Return all proxy tool definitions in Anthropic format."""
    return [
        *_stub_tool_definitions(),  # MCP
        *_stub_tool_definitions(),  # Cowork
        *_stub_tool_definitions(),  # August
        *get_canonical_managed_anthropic_openai_web_tools(),
    ]


# ── Tool name utilities ───────────────────────────────────────────────

def get_tool_definition_name(tool: dict[str, Any]) -> str:
    """Extract the name from a tool definition (Anthropic or OpenAI format)."""
    return tool.get("function", {}).get("name") or tool.get("name") or ""


def append_missing_tools(
    target_tools: list[dict[str, Any]],
    extra_tools: list[dict[str, Any]],
) -> list[str]:
    """Append tools from extra_tools that are not already in target_tools."""
    seen = {get_tool_definition_name(t) for t in (target_tools or []) if get_tool_definition_name(t)}
    appended: list[str] = []
    for tool in extra_tools or []:
        name = get_tool_definition_name(tool)
        if not name or name in seen:
            continue
        seen.add(name)
        target_tools.append(tool)
        appended.append(name)
    return appended


append_missing_anthropic_tools = append_missing_tools
append_missing_openai_tools = append_missing_tools


def is_proxy_managed_local_tool_name(name: str) -> bool:
    """Check if a tool name is proxy-managed."""
    return (
        is_managed_web_tool_name(name)
        or is_managed_bash_tool_name(name)
        or _stub_is_tool_name(name)  # Cowork
        or _stub_is_tool_name(name)  # August
        or _stub_is_tool_name(name)  # MCP
    )


def remember_managed_local_tool_definitions(
    tools: list[dict[str, Any]],
    ctx: dict[str, Any] | None = None,
) -> list[str]:
    """Remember which tool definitions are proxy-managed."""
    if not ctx or "managed_local_tool_names" not in ctx:
        return []
    names: list[str] = []
    for tool in tools or []:
        name = get_tool_definition_name(tool)
        if not is_proxy_managed_local_tool_name(name):
            continue
        ctx["managed_local_tool_names"].add(name)
        names.append(name)
    return names


# ── Client tool guidance ──────────────────────────────────────────────

def build_client_tool_guidance(client_tools: list[dict[str, Any]] | None) -> str:
    """Build system prompt guidance for client-side tools."""
    if not client_tools:
        return ""

    visible_names = [
        t.get("name") or t.get("function", {}).get("name")
        for t in client_tools
    ]
    visible_names = [n for n in visible_names if n]
    if not visible_names:
        return ""

    web_like = [n for n in visible_names if "fetch" in n.lower() or "search" in n.lower()]
    # (cowork detection stubbed)

    lines = [
        "[CLIENT TOOL INVENTORY]",
        f"Visible client tools include: {', '.join(visible_names)}.",
    ]

    if web_like:
        lines.append(
            f"For web access, prefer these visible client-compatible tool names first: "
            f"{', '.join(web_like)}."
        )
        lines.append(
            "If one of those visible web-fetch tools fails or is blocked, retry the research "
            "using the same compatible web-fetch/search name that remains available."
        )
        lines.append(
            "Do not switch to browser automation for ordinary public web research while "
            "a compatible web fetch/search tool is available."
        )

    return "\n".join(lines)


# ── Browser automation detection ──────────────────────────────────────

def is_browser_automation_tool_name(name: str) -> bool:
    """Check if a tool name looks like a browser automation tool."""
    if not isinstance(name, str):
        return False
    lower = name.lower()
    browser_keywords = [
        "list_connected_browsers",
        "browser_navigate",
        "browser_snapshot",
        "browser_click",
        "browser_type",
        "browser_wait",
        "browser",
        "chrome",
    ]
    return any(kw in lower for kw in browser_keywords)


# ── Result formatting ─────────────────────────────────────────────────

def format_managed_web_result(result: Any) -> str:
    """Format web search/fetch results as readable text."""
    if not result or not isinstance(result, dict):
        return str(result or "")

    if isinstance(result.get("results"), list):
        lines: list[str] = []
        query = result.get("query", "")
        if query:
            lines.append(f"Search query: {query}".strip())
        lines.append(f"Result count: {result.get('count') or len(result['results'])}")

        for i, item in enumerate(result["results"]):
            lines.append(f"[{i + 1}] {item.get('title', 'Untitled')}")
            if item.get("url"):
                lines.append(f"URL: {item['url']}")
            if item.get("snippet"):
                lines.append(f"Snippet: {item['snippet']}")
        return "\n".join(lines)

    if result.get("url") or result.get("content"):
        parts = [
            f"Title: {result.get('title', '')}".strip(),
            f"URL: {result.get('url', '')}".strip(),
            f"Status: {result['status']}" if result.get("status") else "",
            "",
            result.get("content", ""),
        ]
        return "\n".join(p for p in parts if p)

    return json.dumps(result)


def format_managed_tool_result(tool_name: str, result: Any) -> str:
    """Format a managed tool execution result."""
    if is_managed_web_tool_name(tool_name):
        return format_managed_web_result(result)
    if is_managed_bash_tool_name(tool_name):
        if not isinstance(result, dict):
            return str(result or "")
        parts = []
        if result.get("stdout"):
            parts.append(result["stdout"])
        if result.get("stderr"):
            parts.append(f"STDERR:\n{result['stderr']}")
        if result.get("exit_code"):
            parts.append(f"Exit code: {result['exit_code']}")
        return "\n".join(parts) or "(no output)"
    if isinstance(result, str):
        return result
    if result is None:
        return ""
    return json.dumps(result)


# ── Tool execution dispatch ───────────────────────────────────────────

async def execute_managed_proxy_tool(
    tool_name: str,
    args: dict[str, Any],
    workspace_path: str | None = None,
    on_progress: Callable[[str], None] | None = None,
    parent_signal: Any = None,
) -> Any:
    """Execute a managed proxy tool by dispatching to the correct backend.

    Currently stubs all external service calls. Real implementations come
    in Phases 3-5 (tool handlers, MCP client, etc.).
    """
    if is_managed_web_tool_name(tool_name):
        local_name = get_managed_web_local_tool_name(tool_name)
        _stub_log_activity("WEB", f"{tool_name} executed locally")
        return _stub_execute_tool(local_name, args or {})

    if is_managed_bash_tool_name(tool_name):
        _stub_log_activity("BASH", f"{tool_name} executed locally")
        return _stub_execute_tool(tool_name, args or {})

    # Cowork, August, MCP tools (stubbed)
    if _stub_is_tool_name(tool_name):
        _stub_log_activity("TOOL", f"{tool_name} executed by proxy")
        return _stub_execute_tool(tool_name, args or {})

    raise ValueError(f"Unsupported managed proxy tool: {tool_name}")


async def execute_managed_openai_tool_calls(
    tool_calls: list[dict[str, Any]],
    known_tools: list[dict[str, Any]],
    messages: list[dict[str, Any]],
    workspace_path: str | None = None,
    on_tool_event: Callable[[dict[str, Any]], None] | None = None,
    parent_signal: Any = None,
) -> list[dict[str, Any]]:
    """Execute OpenAI-format managed tool calls.

    Currently uses stubs for validation and brain config.
    """
    results: list[dict[str, Any]] = []

    for tc in tool_calls:
        tool_name = tc.get("function", {}).get("name")
        if not tool_name:
            results.append({
                "tool_call_id": tc.get("id"),
                "role": "tool",
                "content": "Error: missing tool name",
            })
            continue

        # Validate (stub)
        synthetic_call = {"function": {"name": tool_name, "arguments": tc.get("function", {}).get("arguments", "{}")}}
        validation = _validate_tool_arguments(synthetic_call, known_tools, messages)
        if not validation.get("valid"):
            _stub_log_activity("VALIDATOR", f"OpenAI tool '{tool_name}' rejected: {validation.get('error')}")
            results.append({
                "tool_call_id": tc.get("id"),
                "role": "tool",
                "content": f"[Validation Error] Tool '{tool_name}' rejected before execution:\n{validation.get('error')}\n\n[Proxy Self-Heal]: Fix the tool arguments and retry.",
            })
            continue

        # Parse args
        try:
            parsed_args = json.loads(tc.get("function", {}).get("arguments", "{}"))
        except (json.JSONDecodeError, TypeError):
            parsed_args = {}

        # Execute
        try:
            result = await execute_managed_proxy_tool(
                tool_name, parsed_args, workspace_path, parent_signal=parent_signal,
            )
            results.append({
                "tool_call_id": tc.get("id"),
                "role": "tool",
                "content": format_managed_tool_result(tool_name, result),
            })
        except Exception as exc:
            _record_tool_failure({
                "tool_name": tool_name,
                "args": parsed_args,
                "error": str(exc),
                "phase": "openai-managed-tool",
            })
            results.append({
                "tool_call_id": tc.get("id"),
                "role": "tool",
                "content": f"Error: {exc}",
            })

    return results
