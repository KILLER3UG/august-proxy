"""MCP server API routes.

Delegates to ``app.services.tools.mcp_client`` so HTTP registration,
subprocess start/stop, and tool discovery share one in-process registry
(the workbench tool path uses the same client).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from app.models.camel_base import CamelModel
from app.services.tools import mcp_client

router = APIRouter(prefix='/api/mcp')


class MCPServerCreate(CamelModel):
    """MCP server create body. Internals are snake_case; JSON stays camelCase."""

    name: str
    command: str = ''
    args: list[str] = []
    env: dict[str, str] = {}
    url: str = ''
    transport: str = 'stdio'


@router.get('/servers')
async def listServers():
    """List all registered MCP servers."""
    return {'servers': mcp_client.listRegisteredServers()}


@router.post('/servers')
async def createServer(body: MCPServerCreate):
    """Register a new MCP server (does not start the process yet)."""
    if not body.command and not body.url:
        raise HTTPException(status_code=400, detail='command or url is required')
    # stdio servers need a command; URL-only is stored for future SSE transport.
    server = mcp_client.registerServer(
        body.name,
        body.command or body.url or 'true',
        args=list(body.args) if body.args else None,
        env=dict(body.env) if body.env else None,
    )
    if body.url:
        server['url'] = body.url
    if body.transport:
        server['transport'] = body.transport
    return server


@router.get('/servers/{server_id}')
async def getServer(serverId: str):
    """Get an MCP server by ID."""
    for s in mcp_client.listRegisteredServers():
        if s.get('id') == serverId:
            return s
    raise HTTPException(status_code=404, detail='Server not found')


@router.delete('/servers/{server_id}')
async def deleteServer(serverId: str):
    """Remove an MCP server and stop its process if running."""
    if not mcp_client.unregisterServer(serverId):
        raise HTTPException(status_code=404, detail='Server not found')
    return {'status': 'ok'}


@router.post('/servers/{server_id}/start')
async def startServer(serverId: str):
    """Start an MCP server subprocess and discover its tools."""
    server = next((s for s in mcp_client.listRegisteredServers() if s.get('id') == serverId), None)
    if not server:
        raise HTTPException(status_code=404, detail='Server not found')
    tools = await mcp_client.discoverTools(serverId)
    # Re-read status after start attempt
    server = next((s for s in mcp_client.listRegisteredServers() if s.get('id') == serverId), server)
    status = server.get('status', 'error')
    if status == 'error':
        raise HTTPException(
            status_code=500,
            detail=str(server.get('error') or 'Failed to start MCP server'),
        )
    return {
        'status': status,
        'tools': tools,
        'toolCount': len(tools),
        'id': serverId,
    }


@router.post('/servers/{server_id}/stop')
async def stopServer(serverId: str):
    """Stop an MCP server subprocess."""
    server = next((s for s in mcp_client.listRegisteredServers() if s.get('id') == serverId), None)
    if not server:
        raise HTTPException(status_code=404, detail='Server not found')
    ok = await mcp_client.stopServer(serverId)
    if not ok:
        raise HTTPException(status_code=404, detail='Server not found')
    return {'status': 'stopped', 'id': serverId}


@router.get('/tools')
async def listMcpTools():
    """List all tools from all MCP servers (discovered cache)."""
    return {'tools': mcp_client.getAllMcpTools()}


@router.get('/config')
async def getMcpConfig():
    """Get MCP configuration snapshot."""
    servers = mcp_client.listRegisteredServers()
    return {
        'servers': [s.get('id') for s in servers],
        'count': len(servers),
        'details': servers,
    }
