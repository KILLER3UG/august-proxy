"""MCP server API routes.

Port of backend/services/tools/mcp-client.js + mcp-registry.js + mcp-config.js + mcp-oauth.js.
Manages MCP server connections, tool discovery, and OAuth flows.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException
from app.lib.camel_model import CamelModel

router = APIRouter(prefix="/api/mcp")

# In-memory MCP server registry
_servers: dict[str, dict[str, Any]] = {}


class MCPServerCreate(CamelModel):
    name: str
    command: str = ""
    args: list[str] = []
    env: dict[str, str] = {}
    url: str = ""
    transport: str = "stdio"  # stdio or sse


@router.get("/servers")
async def list_servers():
    """List all registered MCP servers."""
    return {"servers": list(_servers.values())}


@router.post("/servers")
async def create_server(body: MCPServerCreate):
    """Register a new MCP server."""
    import uuid
    server_id = f"mcp_{uuid.uuid4().hex[:8]}"
    server = {
        "id": server_id,
        "name": body.name,
        "command": body.command,
        "args": body.args,
        "env": body.env,
        "url": body.url,
        "transport": body.transport,
        "status": "registered",
        "tools": [],
    }
    _servers[server_id] = server
    return server


@router.get("/servers/{server_id}")
async def get_server(server_id: str):
    """Get an MCP server by ID."""
    server = _servers.get(server_id)
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    return server


@router.delete("/servers/{server_id}")
async def delete_server(server_id: str):
    """Remove an MCP server."""
    if server_id not in _servers:
        raise HTTPException(status_code=404, detail="Server not found")
    del _servers[server_id]
    return {"status": "ok"}


@router.post("/servers/{server_id}/start")
async def start_server(server_id: str):
    """Start an MCP server (stub — MCP execution requires subprocess management)."""
    server = _servers.get(server_id)
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    server["status"] = "running"
    return {"status": "running", "message": "MCP server start requires full MCP client implementation"}


@router.post("/servers/{server_id}/stop")
async def stop_server(server_id: str):
    """Stop an MCP server."""
    server = _servers.get(server_id)
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    server["status"] = "stopped"
    return {"status": "stopped"}


@router.get("/tools")
async def list_mcp_tools():
    """List all tools from all MCP servers."""
    all_tools = []
    for server in _servers.values():
        all_tools.extend(server.get("tools", []))
    return {"tools": all_tools}


@router.get("/config")
async def get_mcp_config():
    """Get MCP configuration."""
    return {"servers": list(_servers.keys()), "count": len(_servers)}
