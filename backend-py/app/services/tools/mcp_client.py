"""
MCP client — Model Context Protocol server management, tool discovery,
and tool execution.

Port of backend/services/tools/mcp-client.js + mcp-registry.js + mcp-config.js + mcp-oauth.js.

Manages MCP server subprocesses, discovers available tools, and
executes tool calls via JSON-RPC over stdio/SSE.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from pathlib import Path
from typing import Any

from app.lib.paths import data_path

# ── Configuration ────────────────────────────────────────────────────

MCP_CONFIG_FILE = "mcp-servers.json"
MCP_TIMEOUT_MS = 30000


def _mcp_config_path() -> Path:
    return data_path(MCP_CONFIG_FILE)


# ── In-memory server registry ────────────────────────────────────────

_servers: dict[str, dict[str, Any]] = {}
_tools_cache: dict[str, list[dict[str, Any]]] = {}
_processes: dict[str, asyncio.subprocess.Process] = {}


# ── Server management ───────────────────────────────────────────────


def _load_config() -> dict[str, Any]:
    """Load MCP server config from disk."""
    path = _mcp_config_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text("utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_config(config: dict[str, Any]) -> None:
    """Save MCP server config to disk."""
    path = _mcp_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2), "utf-8")


def list_registered_servers() -> list[dict[str, Any]]:
    """List all registered MCP servers."""
    return list(_servers.values())


def register_server(name: str, command: str, args: list[str] | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
    """Register an MCP server."""
    server_id = f"mcp_{uuid.uuid4().hex[:8]}"
    server = {
        "id": server_id,
        "name": name,
        "command": command,
        "args": args or [],
        "env": env or {},
        "status": "registered",
    }
    _servers[server_id] = server
    return server


def unregister_server(server_id: str) -> bool:
    """Unregister an MCP server."""
    if server_id not in _servers:
        return False
    # Kill if running
    asyncio.create_task(_stop_server_process(server_id))
    del _servers[server_id]
    _tools_cache.pop(server_id, None)
    return True


async def _start_server_process(server_id: str) -> asyncio.subprocess.Process | None:
    """Start an MCP server subprocess."""
    server = _servers.get(server_id)
    if not server:
        return None

    if server_id in _processes:
        return _processes[server_id]

    env = dict(os.environ)
    env.update(server.get("env", {}))

    try:
        proc = await asyncio.create_subprocess_exec(
            server["command"],
            *server.get("args", []),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        _processes[server_id] = proc
        server["status"] = "running"
        return proc
    except (FileNotFoundError, PermissionError) as exc:
        server["status"] = "error"
        server["error"] = str(exc)
        return None


async def _stop_server_process(server_id: str) -> None:
    """Stop an MCP server subprocess."""
    proc = _processes.pop(server_id, None)
    if proc:
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=5)
        except (asyncio.TimeoutError, ProcessLookupError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
    if server_id in _servers:
        _servers[server_id]["status"] = "stopped"


async def discover_tools(server_id: str) -> list[dict[str, Any]]:
    """Call the tools/list RPC method on an MCP server."""
    proc = await _start_server_process(server_id)
    if not proc or not proc.stdin or not proc.stdout:
        return []

    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list",
    }

    try:
        proc.stdin.write((json.dumps(request) + "\n").encode())
        await proc.stdin.drain()

        response = await asyncio.wait_for(
            proc.stdout.readline(), timeout=10
        )
        result = json.loads(response.decode())
        tools = result.get("result", {}).get("tools", [])
        _tools_cache[server_id] = tools
        return tools
    except (asyncio.TimeoutError, json.JSONDecodeError, ConnectionError) as exc:
        _servers.get(server_id, {})["error"] = str(exc)
        return []


async def execute_tool(server_id: str, tool_name: str, args: dict[str, Any]) -> str:
    """Call a tool on an MCP server via JSON-RPC."""
    proc = await _start_server_process(server_id)
    if not proc or not proc.stdin or not proc.stdout:
        return f"Error: MCP server '{server_id}' not running"

    request = {
        "jsonrpc": "2.0",
        "id": str(uuid.uuid4()),
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": args,
        },
    }

    try:
        proc.stdin.write((json.dumps(request) + "\n").encode())
        await proc.stdin.drain()

        response = await asyncio.wait_for(
            proc.stdout.readline(), timeout=MCP_TIMEOUT_MS / 1000
        )
        result = json.loads(response.decode())

        if "error" in result:
            return f"Error: {result['error'].get('message', str(result['error']))}"

        content = result.get("result", {}).get("content", [])
        text_parts = [
            c.get("text", "") for c in content if c.get("type") in ("text", "output_text")
        ]
        return "\n".join(text_parts) if text_parts else json.dumps(result["result"])
    except asyncio.TimeoutError:
        return f"Error: MCP tool '{tool_name}' timed out"
    except json.JSONDecodeError:
        return f"Error: Invalid JSON response from MCP server"
    except Exception as exc:
        return f"Error: {exc}"


# ── Tool discovery aggregation ───────────────────────────────────────


def get_all_mcp_tools() -> list[dict[str, Any]]:
    """Get all tools from all registered MCP servers."""
    all_tools = []
    for sid, tools in _tools_cache.items():
        for tool in tools:
            tool["_mcp_server_id"] = sid
            all_tools.append(tool)
    return all_tools


def get_mcp_tool_definitions() -> list[dict[str, Any]]:
    """Get MCP tools in a format compatible with the tool registry."""
    tools = get_all_mcp_tools()
    return [
        {
            "type": "function",
            "function": {
                "name": f"mcp__{t.get('_mcp_server_id', 'unknown')}__{t['name']}",
                "description": t.get("description", ""),
                "parameters": t.get("inputSchema", {"type": "object", "properties": {}}),
            },
        }
        for t in tools
    ]


def is_mcp_tool_name(name: str) -> bool:
    """Check if a tool name belongs to an MCP server."""
    return isinstance(name, str) and name.startswith("mcp__")


async def execute_mcp_tool_call(name: str, args: dict[str, Any]) -> str:
    """Execute an MCP tool call by routing to the correct server."""
    # Extract server_id from the prefixed name: mcp__{server_id}__{tool_name}
    parts = name.split("__", 2)
    if len(parts) < 3:
        return f"Error: Invalid MCP tool name: {name}"
    _, server_id, tool_name = parts
    return await execute_tool(server_id, tool_name, args)


def sanitize_tool_schema(schema: Any) -> dict[str, Any]:
    """Sanitize a JSON Schema to ensure it has expected structure."""
    if not isinstance(schema, dict):
        return {"type": "object", "properties": {}}
    result = dict(schema)
    result.setdefault("type", "object")
    result.setdefault("properties", {})
    return result
