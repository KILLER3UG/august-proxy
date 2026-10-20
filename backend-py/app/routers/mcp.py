"""MCP server API routes.

Delegates to ``app.services.tools.mcp_client`` so HTTP registration,
subprocess start/stop, and tool discovery share one in-process registry
(the workbench tool path uses the same client).
"""

from __future__ import annotations

import shutil

from fastapi import APIRouter, HTTPException

from app.json_narrowing import as_dict, as_list
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
    """List all registered MCP servers (env/header VALUES masked)."""
    return {'servers': [mcp_client.redactedServerRow(s) for s in mcp_client.listRegisteredServers()]}


def _launcher_available(command: str) -> bool:
    """True when the recipe's launcher is on PATH on THIS machine.

    A recipe whose launcher is missing cannot start here, so the UI says so
    instead of offering an install that is guaranteed to fail.
    """
    return bool(command) and shutil.which(command) is not None


def _recipe(
    entry_id: str,
    name: str,
    package_name: str,
    command: str,
    args: list[str],
    package_version: str = '',
) -> dict[str, object]:
    """One curated install recipe.

    A recipe is a LAUNCH INSTRUCTION for a third-party MCP server, not a
    capability August has: the tools it exposes exist only once that server
    is installed and running. `launcherAvailable` says whether the launcher
    is even present on this host.
    """
    return {
        'id': entry_id,
        'name': name,
        'packageName': package_name,
        'packageVersion': package_version,
        'kind': 'install-recipe',
        'command': command,
        'args': args,
        'launcherAvailable': _launcher_available(command),
    }


@router.get('/directory')
async def mcpDirectory():
    """Static MCP install recipes for the Integrations add modal (frontend also ships a catalog)."""
    return {
        'source': 'curated-recipes',
        'discovered': False,
        'note': (
            'A curated list of install RECIPES baked into August — not a discovered registry. '
            'August does not query the MCP registry, npm, PyPI or GitHub: there is no search, no '
            'pagination and no version resolution behind this list. An entry says how to launch a '
            'third-party MCP server; it is not a capability August has. The tools a recipe exposes '
            'exist only once that server is installed and running.'
        ),
        'entries': [
            _recipe(
                'mcp-filesystem',
                'Filesystem',
                '@modelcontextprotocol/server-filesystem',
                'npx',
                ['-y', '@modelcontextprotocol/server-filesystem@2026.7.4', '.'],
                '2026.7.4',
            ),
            _recipe(
                'mcp-memory',
                'Knowledge Graph Memory',
                '@modelcontextprotocol/server-memory',
                'npx',
                ['-y', '@modelcontextprotocol/server-memory'],
                'latest',
            ),
            _recipe(
                'mcp-fetch',
                'Fetch',
                '@modelcontextprotocol/server-fetch',
                'npx',
                ['-y', '@modelcontextprotocol/server-fetch'],
                'latest',
            ),
            _recipe(
                'mcp-github',
                'GitHub MCP',
                '@modelcontextprotocol/server-github',
                'npx',
                ['-y', '@modelcontextprotocol/server-github'],
                'latest',
            ),
            _recipe(
                'mcp-google-workspace',
                'Google Workspace MCP',
                'workspace-mcp',
                'uvx',
                ['workspace-mcp', '--tool-tier', 'core'],
                'latest',
            ),
        ],
    }


@router.post('/servers')
async def createServer(body: MCPServerCreate):
    """Register a new MCP server (does not start the process yet).

    400s when the stdio launch fails validation (shell command, catastrophic
    args) — the check is non-overridable and lives in mcp_client.
    """
    if not body.command and not body.url:
        raise HTTPException(status_code=400, detail='command or url is required')
    # stdio servers need a command; URL-only is stored for future SSE transport.
    try:
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
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if body.catalog_id:
        mcp_client.set_server_meta(str(server.get('id')), catalogId=body.catalog_id)
        server['catalogId'] = body.catalog_id
    if body.url:
        server['url'] = body.url
    if body.transport:
        server['transport'] = body.transport
    return mcp_client.redactedServerRow(server)


@router.get('/servers/{serverId}')
async def getServer(serverId: str):
    """Get an MCP server by ID (env/header VALUES masked)."""
    for s in mcp_client.listRegisteredServers():
        if s.get('id') == serverId:
            return mcp_client.redactedServerRow(s)
    raise HTTPException(status_code=404, detail='Server not found')


@router.delete('/servers/{serverId}')
async def deleteServer(serverId: str):
    """Remove an MCP server and stop its process if running."""
    if not mcp_client.unregisterServer(serverId):
        raise HTTPException(status_code=404, detail='Server not found')
    return {'status': 'ok'}


class MCPServerUpdate(CamelModel):
    """MCP server update body — only provided fields are changed."""

    name: str = ''
    command: str = ''
    args: list[str] | None = None
    env: dict[str, str] | None = None
    url: str = ''
    transport: str = ''
    enabled: bool | None = None
    # Added so a client can SET these; when omitted they are carried forward
    # from the current row, which is what stopped an edit of the detail pane
    # from silently dropping a remote server's Authorization header.
    headers: dict[str, str] | None = None
    catalog_id: str = ''


@router.patch('/servers/{serverId}')
async def updateServer(serverId: str, body: MCPServerUpdate):
    """Update an MCP server in place (preserves its id and persisted config).

    A running process is stopped first so the new command/args/env actually
    apply on the next start.
    """
    current = _resolve_server(serverId)
    if not current:
        raise HTTPException(status_code=404, detail='Server not found')
    command = body.command or str(current.get('command') or '')
    url = body.url or str(current.get('url') or '')
    if not command and not url:
        raise HTTPException(status_code=400, detail='command or url is required')
    try:
        await mcp_client.stopServer(str(current.get('id')))
    except Exception:
        pass
    current_args = [str(a) for a in as_list(current.get('args'), [])]
    current_env = {str(k): str(v) for k, v in as_dict(current.get('env'), {}).items()}
    # Carry the fields this route does not model. registerServer rebuilds the
    # row from its own parameter list, so anything not passed here is DROPPED:
    # a remote server lost its Authorization header on every save of its detail
    # pane, and an installed server lost its catalog mapping.
    current_headers = {str(k): str(v) for k, v in as_dict(current.get('headers'), {}).items()}
    current_catalog = str(current.get('catalogId') or '')
    try:
        updated = mcp_client.registerServer(
            body.name or str(current.get('name') or ''),
            command or url or 'true',
            args=body.args if body.args is not None else current_args,
            env=body.env if body.env is not None else current_env,
            enabled=body.enabled if body.enabled is not None else bool(current.get('enabled', True)),
            transport=body.transport or str(current.get('transport') or 'stdio'),
            url=url,
            server_id=str(current.get('id')),
            persist=True,
            headers=body.headers if body.headers is not None else (current_headers or None),
        )
        catalog_id = str(body.catalog_id or '') or current_catalog
        if catalog_id:
            updated = mcp_client.set_server_meta(str(current.get('id')), catalogId=catalog_id) or updated
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return mcp_client.redactedServerRow(updated)


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
    """Get MCP configuration snapshot (secrets masked)."""
    servers = mcp_client.listRegisteredServers()
    return {
        'servers': [s.get('id') for s in servers],
        'count': len(servers),
        'details': [mcp_client.redactedServerRow(s) for s in servers],
    }
