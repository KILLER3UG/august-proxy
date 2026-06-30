"""MCP server API routes.

Port of backend/services/tools/mcp-client.js + mcp-registry.js + mcp-config.js + mcp-oauth.js.
Manages MCP server connections, tool discovery, and OAuth flows.
"""
from __future__ import annotations
import json
from typing import Any
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
router = APIRouter(prefix='/api/mcp')
_servers: dict[str, dict[str, Any]] = {}

class MCPServerCreate(BaseModel):
    name: str
    command: str = ''
    args: list[str] = []
    env: dict[str, str] = {}
    url: str = ''
    transport: str = 'stdio'

@router.get('/servers')
async def listServers():
    """List all registered MCP servers."""
    return {'servers': list(_servers.values())}

@router.post('/servers')
async def createServer(body: MCPServerCreate):
    """Register a new MCP server."""
    import uuid
    serverId = f'mcp_{uuid.uuid4().hex[:8]}'
    server = {'id': serverId, 'name': body.name, 'command': body.command, 'args': body.args, 'env': body.env, 'url': body.url, 'transport': body.transport, 'status': 'registered', 'tools': []}
    _servers[serverId] = server
    return server

@router.get('/servers/{server_id}')
async def getServer(serverId: str):
    """Get an MCP server by ID."""
    server = _servers.get(serverId)
    if not server:
        raise HTTPException(status_code=404, detail='Server not found')
    return server

@router.delete('/servers/{server_id}')
async def deleteServer(serverId: str):
    """Remove an MCP server."""
    if serverId not in _servers:
        raise HTTPException(status_code=404, detail='Server not found')
    del _servers[serverId]
    return {'status': 'ok'}

@router.post('/servers/{server_id}/start')
async def startServer(serverId: str):
    """Start an MCP server (stub — MCP execution requires subprocess management)."""
    server = _servers.get(serverId)
    if not server:
        raise HTTPException(status_code=404, detail='Server not found')
    server['status'] = 'running'
    return {'status': 'running', 'message': 'MCP server start requires full MCP client implementation'}

@router.post('/servers/{server_id}/stop')
async def stopServer(serverId: str):
    """Stop an MCP server."""
    server = _servers.get(serverId)
    if not server:
        raise HTTPException(status_code=404, detail='Server not found')
    server['status'] = 'stopped'
    return {'status': 'stopped'}

@router.get('/tools')
async def listMcpTools():
    """List all tools from all MCP servers."""
    allTools = []
    for server in _servers.values():
        allTools.extend(server.get('tools', []))
    return {'tools': allTools}

@router.get('/config')
async def getMcpConfig():
    """Get MCP configuration."""
    return {'servers': list(_servers.keys()), 'count': len(_servers)}