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
    catalog_id: str = ''
    enabled: bool = True


@router.get('/servers')
async def listServers():
    """List all registered MCP servers."""
    return {'servers': mcp_client.listRegisteredServers()}


@router.get('/directory')
async def mcpDirectory():
    """Static MCP install recipes for the Integrations add modal (frontend also ships a catalog)."""
    return {
        'entries': [
            {
                'id': 'mcp-filesystem',
                'name': 'Filesystem',
                'packageName': '@modelcontextprotocol/server-filesystem',
                'packageVersion': '2026.7.4',
            },
            {
                'id': 'mcp-memory',
                'name': 'Knowledge Graph Memory',
                'packageName': '@modelcontextprotocol/server-memory',
            },
            {
                'id': 'mcp-fetch',
                'name': 'Fetch',
                'packageName': '@modelcontextprotocol/server-fetch',
            },
            {
                'id': 'mcp-github',
                'name': 'GitHub MCP',
                'packageName': '@modelcontextprotocol/server-github',
            },
            {
                'id': 'mcp-google-workspace',
                'name': 'Google Workspace MCP',
                'packageName': 'workspace-mcp',
                'command': 'uvx',
                'args': ['workspace-mcp', '--tool-tier', 'core'],
            },
        ]
    }


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
        enabled=body.enabled,
        transport=body.transport or 'stdio',
        url=body.url or '',
        persist=True,
    )
    if body.catalog_id:
        mcp_client.set_server_meta(str(server.get('id')), catalogId=body.catalog_id)
        server['catalogId'] = body.catalog_id
    if body.url:
        server['url'] = body.url
    if body.transport:
        server['transport'] = body.transport
    return server


@router.get('/servers/{serverId}')
async def getServer(serverId: str):
    """Get an MCP server by ID."""
    for s in mcp_client.listRegisteredServers():
        if s.get('id') == serverId:
            return s
    raise HTTPException(status_code=404, detail='Server not found')


@router.delete('/servers/{serverId}')
async def deleteServer(serverId: str):
    """Remove an MCP server and stop its process if running."""
    if not mcp_client.unregisterServer(serverId):
        raise HTTPException(status_code=404, detail='Server not found')
    return {'status': 'ok'}


def _resolve_server(server_id: str) -> dict[str, object] | None:
    """Match by id first, then by name (frontend sometimes has only display name)."""
    servers = mcp_client.listRegisteredServers()
    for s in servers:
        if s.get('id') == server_id:
            return s
    for s in servers:
        if str(s.get('name', '')).lower() == server_id.lower():
            return s
    return None


@router.post('/servers/{serverId}/start')
async def startServer(serverId: str):
    """Start an MCP server subprocess and discover its tools."""
    server = _resolve_server(serverId)
    if not server:
        raise HTTPException(
            status_code=404,
            detail=f"Server not found: {serverId!r}. Register it under Settings → Integrations first.",
        )
    sid = str(server.get('id') or serverId)
    tools = await mcp_client.discoverTools(sid)
    # Re-read status after start attempt
    server = _resolve_server(sid) or server
    status = server.get('status', 'error')
    if status == 'error':
        raise HTTPException(
            status_code=500,
            detail=str(server.get('error') or 'Failed to start MCP server'),
        )
    # registered with no process is still a soft failure for stdio
    if status not in ('running',) and not tools:
        err = server.get('error') or status
        raise HTTPException(
            status_code=500,
            detail=f'Failed to start MCP server {sid}: {err}',
        )
    return {
        'status': status if status == 'running' else ('running' if tools else status),
        'tools': tools,
        'toolCount': len(tools),
        'id': sid,
    }


@router.post('/servers/{serverId}/stop')
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
