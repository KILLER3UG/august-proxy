"""
Integration tool handlers — expose the service-connection + MCP surface to the
model as registered tools.

Mirrors ``provider_setup_tool``: the model drives setup, secrets are kept out of
the model's reasoning text (the chat UI renders an inline token field / Google
sign-in button via the ``integrationSetup`` payload attached to tool results).

Delegates to the existing services — ``app.services.service_connections`` and
``app.services.tools.mcp_client`` — so there is no self-HTTP and behavior stays
consistent with the Settings → Integrations UI.
"""

from __future__ import annotations

import json

from app.json_narrowing import as_dict, as_list, as_str


def _ok(**fields: object) -> str:
    return json.dumps({'status': 'success', **fields}, default=str)


def _err(message: str, **fields: object) -> str:
    return json.dumps({'status': 'error', 'error': message, **fields}, default=str)


def listRegisteredForSummary(servers: list[dict[str, object]]) -> list[dict[str, object]]:
    """Compact MCP server list for the model (id, name, status, toolCount, error)."""
    out: list[dict[str, object]] = []
    for s in servers:
        srv = as_dict(s)
        tools = as_list(srv.get('tools'), [])
        tool_names: list[str] = []
        for t in tools:
            if isinstance(t, dict):
                n = as_str(t.get('name') or t.get('displayName'))
            else:
                n = as_str(t)
            if n:
                tool_names.append(n)
        out.append(
            {
                'id': as_str(srv.get('id')),
                'name': as_str(srv.get('name')),
                'status': as_str(srv.get('status'), 'registered'),
                'enabled': srv.get('enabled', True),
                'toolCount': len(tool_names),
                'tools': sorted(set(tool_names)),
                'error': as_str(srv.get('error')) or None,
            }
        )
    return out


async def listIntegrations() -> str:
    """Read-only status of Google / GitHub / Slack connections + MCP servers.

    Also surfaces scopes / instructions so the model can tell the user what to
    configure before connecting.
    """
    from app.services import service_connections as sc

    try:
        connections = sc.list_connections()
        servers: list[dict[str, object]] = []
        try:
            from app.services.tools import mcp_client

            servers = listRegisteredForSummary(mcp_client.listRegisteredServers())
        except Exception:
            servers = []
        summary = {
            'connections': connections.get('connections'),
            'mcp_servers': servers,
            'instructions': {
                'google': {
                    'scopes': sc.SERVICE_META['google']['scopes'],
                    'note': 'Use connect_google to start OAuth (gmail | calendar | drive).',
                },
                'github': {
                    'scopes': sc.SERVICE_META['github']['scopes'],
                    'helpUrl': 'https://github.com/settings/tokens',
                    'note': 'Use connect_github with a PAT, or leave token empty for the inline field.',
                },
                'slack': {
                    'scopes': sc.SERVICE_META['slack']['scopes'],
                    'helpUrl': 'https://api.slack.com/apps',
                    'note': 'Use connect_slack with a bot token (xoxb-…) + optional team id.',
                },
            },
        }
        return _ok(**summary)
    except Exception as exc:
        return _err(f'Failed to list integrations: {exc}')


async def connectGithub(token: str = '') -> str:
    """Store a GitHub Personal Access Token.

    Pass an empty token to let the user paste it in the chat UI inline field
    (the secret never enters the model's reasoning text).
    """
    from app.services import service_connections as sc

    try:
        conn = await sc.connect_github(token)
        if conn.get('status') == 'error':
            return _err(
                conn.get('validationError', 'GitHub token validation failed'),
                integrationSetup={
                    'provider': 'github',
                    'label': 'GitHub',
                    'needsToken': True,
                    'connected': False,
                    'status': 'disconnected',
                },
            )
        card = as_dict(conn.get('connection'))
        return _ok(
            integrationSetup={
                'provider': 'github',
                'label': 'GitHub',
                'needsToken': not bool((token or '').strip()),
                'maskedToken': as_str(card.get('maskedToken')),
                'connected': bool(card.get('connected')),
                'account': as_str(card.get('account')) or None,
                'status': 'connected' if card.get('connected') else 'disconnected',
            },
            connection=conn,
        )
    except Exception as exc:
        return _err(f'Failed to connect GitHub: {exc}')


async def connectSlack(bot_token: str = '', team_id: str = '') -> str:
    """Store a Slack Bot User token (xoxb-…), with optional team id.

    With an empty bot token, the chat UI shows an inline token field.
    """
    from app.services import service_connections as sc

    try:
        conn = await sc.connect_slack(bot_token, team_id)
        if conn.get('status') == 'error':
            return _err(
                conn.get('validationError', 'Slack token validation failed'),
                integrationSetup={
                    'provider': 'slack',
                    'label': 'Slack',
                    'needsToken': True,
                    'connected': False,
                    'status': 'disconnected',
                },
            )
        card = as_dict(conn.get('connection'))
        return _ok(
            integrationSetup={
                'provider': 'slack',
                'label': 'Slack',
                'needsToken': not bool((bot_token or '').strip()),
                'maskedToken': as_str(card.get('maskedToken')),
                'connected': bool(card.get('connected')),
                'teamId': as_str(card.get('teamId')) or None,
                'status': 'connected' if card.get('connected') else 'disconnected',
            },
            connection=conn,
        )
    except Exception as exc:
        return _err(f'Failed to connect Slack: {exc}')


async def connectGoogle(email: str = '', facet: str = 'gmail') -> str:
    """Start Google OAuth sign-in for a facet (gmail | calendar | drive).

    Returns an authUrl the model should open (via desktop_open_url / browser).
    The chat UI also exposes a 'Sign in with Google' button from the
    integrationSetup payload. Completion is confirmed by re-checking
    list_integrations.
    """
    from app.services import service_connections as sc

    try:
        res = await sc.google_auth_url(email, facet=facet)
        return _ok(
            google=res,
            integrationSetup={
                'kind': 'google',
                'provider': 'google',
                'label': 'Google',
                'facet': as_str(res.get('facet'), 'gmail'),
                'authUrl': as_str(res.get('authUrl')),
                'needsClientId': bool(res.get('needsClientId')),
                'connected': bool(res.get('connected')),
                'message': as_str(res.get('message')),
                'status': 'connected' if res.get('connected') else 'auth_required',
            },
        )
    except Exception as exc:
        return _err(f'Failed to connect Google: {exc}')


async def installMcpServer(
    name: str,
    command: str = '',
    args: list[str] | None = None,
    url: str = '',
    env: dict[str, str] | None = None,
    transport: str = 'stdio',
    catalog_id: str = '',
    start: bool = True,
    source: str = '',
) -> str:
    """Register (and optionally start) an MCP server from chat.

    Examples:
      - command='npx', args=['-y','@modelcontextprotocol/server-filesystem','/tmp']
      - url='http://localhost:3000/mcp', transport='http'
      - source='owner/repo' (or a github.com URL) — installs a public GitHub
        plugin: git clone when git exists, otherwise the HTTP tarball, then
        registers it as `node <entry>` (audit feature: installs even without
        Git).
    Rare secrets may be passed in env (prefer asking the user to add them in the
    chat UI inline field).
    """
    if not name:
        return _err('name is required.')
    if source:
        from app.services import plugin_installer

        installed = await plugin_installer.install_from_github(name, source)
        if not installed.get('ok'):
            return _err(as_str(installed.get('error'), 'Plugin install failed.'))
        command = as_str(installed.get('command'), 'node')
        args = [as_str(a, '') for a in as_list(installed.get('args'), []) if as_str(a, '')]
        transport = 'stdio'
        url = ''
    if not command and not url:
        return _err("A 'command' (stdio), 'url' (http/sse), or 'source' (GitHub) is required.")
    from app.services.tools import mcp_client

    try:
        resolved_transport = transport or ('sse' if url else 'stdio')
        server = mcp_client.registerServer(
            name,
            command if command else url or 'true',
            args=list(args) if args else None,
            env=dict(env) if env else None,
            enabled=True,
            transport=resolved_transport,
            url=url or '',
            persist=True,
        )
        sid = as_str(server.get('id'))
        if catalog_id:
            mcp_client.set_server_meta(sid, catalogId=catalog_id)
        started = False
        toolCount = 0
        tool_names: list[str] = []
        error: str = ''
        if start:
            try:
                found = await mcp_client.discoverTools(sid)
                found_list = as_list(found, [])
                tool_names = sorted(
                    {as_str(t.get('name')) for t in found_list if isinstance(t, dict) and as_str(t.get('name'))}
                )
                toolCount = len(tool_names)
                started = True
            except Exception as exc:
                error = str(exc)
        # Do NOT include the raw `server` record: it carries the `env` map,
        # which may hold secrets, and would be echoed into the model-visible
        # tool result and the SSE content/summary. integrationSetup above is
        # the sanitized, model-safe summary.
        return _ok(
            integrationSetup={
                'kind': 'mcp',
                'provider': 'mcp',
                'name': name,
                'serverId': sid,
                'label': name,
                'status': 'registered' if not started else 'active',
                'started': started,
                'toolCount': toolCount,
                'tools': tool_names,
                'transport': resolved_transport,
                'error': error or None,
            },
        )
    except Exception as exc:
        return _err(f'Failed to install MCP server: {exc}')


async def listMcpServers() -> str:
    """List installed MCP servers and the tools each exposes."""
    try:
        from app.services.tools import mcp_client

        servers = listRegisteredForSummary(mcp_client.listRegisteredServers())
        return _ok(servers=servers, count=len(servers))
    except Exception as exc:
        return _err(f'Failed to list MCP servers: {exc}')


async def disconnectIntegration(name: str, facet: str = '') -> str:
    """Disconnect an account integration or unregister an MCP server.

    Account names: google (optionally facet gmail|calendar|drive), github,
    slack. Pass an MCP server id to unregister that server (also stops it).
    Destructive — confirm before calling.
    """
    from app.services import service_connections as sc

    lowered = (name or '').strip().lower()
    if not lowered:
        return _err('name is required (google | github | slack, or an MCP server id).')

    mcp_servers: list[dict[str, object]] = []
    try:
        from app.services.tools import mcp_client

        mcp_servers = listRegisteredForSummary(mcp_client.listRegisteredServers())
    except Exception:
        mcp_servers = []

    # If it matches a registered MCP server id or name, unregister it.
    target = next((s for s in mcp_servers if as_str(s.get('id')) == lowered), None)
    if not target:
        target = next((s for s in mcp_servers if as_str(s.get('name')).lower() == lowered), None)
    if target:
        from app.services.tools import mcp_client

        sid = as_str(target.get('id'))
        if mcp_client.unregisterServer(sid):
            return _ok(deleted=True, kind='mcp', name=lowered)
        return _err(f"Could not unregister MCP server '{lowered}'.")

    if lowered not in sc.SERVICE_META:
        return _err(
            f"Unknown integration '{name}'. Use one of google / github / slack, or an MCP server id."
        )
    try:
        result = sc.disconnect(lowered, facet=facet)
        return _ok(deleted=True, kind='account', name=lowered, result=result)
    except ValueError as exc:
        return _err(str(exc))
    except Exception as exc:
        return _err(f'Failed to disconnect {lowered}: {exc}')


def register() -> None:
    """Register the integration tools with the tool registry."""
    from app.services import tool_registry

    tool_registry.register(
        'list_integrations',
        'List the status of connected integrations (Google / GitHub / Slack) and MCP servers, '
        'plus what each needs to be configured. Use before deciding what to connect.',
        listIntegrations,
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'connect_github',
        'Store a GitHub Personal Access Token (PAT). Passing an empty token opens an inline '
        'field in the chat for the user to paste the secret (never echoed to the model). '
        'Returns connection status + masked token.',
        connectGithub,
        {
            'type': 'object',
            'properties': {
                'token': {
                    'type': 'string',
                    'description': 'Optional GitHub PAT. Leave empty to show the user an inline token field.',
                    'default': '',
                }
            },
            'required': [],
        },
    )
    tool_registry.register(
        'connect_slack',
        'Store a Slack Bot User OAuth token (xoxb-…). Passing an empty token opens the '
        'inline field in the chat UI. Bot token scopes: channels/messages/files/workspace.',
        connectSlack,
        {
            'type': 'object',
            'properties': {
                'bot_token': {
                    'type': 'string',
                    'description': 'Slack Bot User OAuth token (xoxb-…). Empty → inline field.',
                    'default': '',
                },
                'team_id': {
                    'type': 'string',
                    'description': 'Optional Slack team/workspace id.',
                    'default': '',
                },
            },
            'required': [],
        },
    )
    tool_registry.register(
        'connect_google',
        'Start Google OAuth sign-in for gmail | calendar | drive. Returns an authUrl the model '
        'opens (desktop_open_url) and the user approves in the browser; the chat UI shows a '
        'Sign in with Google button. Confirmation is via list_integrations afterwards.',
        connectGoogle,
        {
            'type': 'object',
            'properties': {
                'email': {'type': 'string', 'description': 'Optional Google account email hint.', 'default': ''},
                'facet': {
                    'type': 'string',
                    'description': 'gmail | calendar | drive (default gmail).',
                    'default': 'gmail',
                },
            },
            'required': [],
        },
    )
    tool_registry.register(
        'install_mcp_server',
        'Register (and optionally start) an MCP server. Provide name + command/args (stdio) '
        'or url (http/sse). Examples: npx -y @modelcontextprotocol/server-filesystem /tmp/x.',
        installMcpServer,
        {
            'type': 'object',
            'properties': {
                'name': {'type': 'string', 'description': 'Display/registry name of the server.'},
                'command': {'type': 'string', 'description': 'Executable for stdio transport (e.g. npx, uvx).', 'default': ''},
                'args': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Command arguments.', 'default': []},
                'url': {'type': 'string', 'description': 'Server URL for http/sse transport.', 'default': ''},
                'env': {'type': 'object', 'additionalProperties': {'type': 'string'}, 'description': 'Extra env vars.', 'default': {}},
                'transport': {
                    'type': 'string',
                    'description': 'stdio | http | sse.',
                    'default': 'stdio',
                },
                'source': {
                    'type': 'string',
                    'description': 'GitHub plugin source (owner/repo or github.com URL, optional #ref). '
                    'Installs via git clone when git exists, otherwise downloads the tarball — '
                    'no git binary needed. Registers as `node <entry>`.',
                    'default': '',
                },
                'catalog_id': {'type': 'string', 'description': 'Optional integration-catalog id for UI grouping.', 'default': ''},
                'start': {'type': 'boolean', 'description': 'Start and discover tools after registering (default true).', 'default': True},
            },
            'required': ['name'],
        },
    )
    tool_registry.register(
        'list_mcp_servers',
        'List installed MCP servers and the tools each exposes.',
        listMcpServers,
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'disconnect_integration',
        'Remove a connected integration (google | github | slack, optionally google facet '
        'gmail|calendar|drive) or unregister an MCP server by name/id. DESTRUCTIVE — '
        'confirm with the user before calling.',
        disconnectIntegration,
        {
            'type': 'object',
            'properties': {
                'name': {'type': 'string', 'description': 'google | github | slack, or an MCP server id/name.'},
                'facet': {'type': 'string', 'description': 'Optional Google facet (gmail|calendar|drive).', 'default': ''},
            },
            'required': ['name'],
        },
    )