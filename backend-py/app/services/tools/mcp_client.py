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
from app.lib.paths import dataPath
from app.json_narrowing import as_str, as_list, as_dict

_mcpCleanupTasks: set[asyncio.Task] = set()
MCP_CONFIG_FILE = 'mcp-servers.json'
MCP_TIMEOUT_MS = 30000


def _mcpConfigPath() -> Path:
    return dataPath(MCP_CONFIG_FILE)


_servers: dict[str, dict[str, object]] = {}
_toolsCache: dict[str, list[dict[str, object]]] = {}
_processes: dict[str, asyncio.subprocess.Process] = {}


def _loadConfig() -> dict[str, object]:
    """Load MCP server config from disk."""
    path = _mcpConfigPath()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text('utf-8'))
    except (json.JSONDecodeError, OSError):
        return {}


def _saveConfig() -> None:
    """Persist the in-memory registry to mcp-servers.json."""
    path = _mcpConfigPath()
    servers_out: dict[str, object] = {}
    for sid, srv in _servers.items():
        if not isinstance(srv, dict):
            continue
        servers_out[sid] = {
            'id': sid,
            'name': srv.get('name', ''),
            'command': srv.get('command', ''),
            'args': list(as_list(srv.get('args'))),
            'env': dict(as_dict(srv.get('env'), {})),  # type: ignore[arg-type]
            'enabled': bool(srv.get('enabled', True)),
            'transport': as_str(srv.get('transport'), 'stdio'),
            'url': as_str(srv.get('url'), ''),
        }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'servers': servers_out}, indent=2), encoding='utf-8')


def listRegisteredServers() -> list[dict[str, object]]:
    """List all registered MCP servers."""
    return list(_servers.values())


def registerServer(
    name: str,
    command: str,
    args: list[str] | None = None,
    env: dict[str, str] | None = None,
    *,
    enabled: bool = True,
    transport: str = 'stdio',
    url: str = '',
    server_id: str | None = None,
    persist: bool = True,
) -> dict[str, object]:
    """Register an MCP server and optionally persist to disk."""
    serverId = server_id or f'mcp_{uuid.uuid4().hex[:8]}'
    server: dict[str, object] = {
        'id': serverId,
        'name': name,
        'command': command,
        'args': args or [],
        'env': env or {},
        'status': 'registered',
        'enabled': enabled,
        'transport': transport or 'stdio',
        'url': url or '',
    }
    _servers[serverId] = server
    if persist:
        try:
            _saveConfig()
        except OSError:
            pass
    return server


def unregisterServer(serverId: str) -> bool:
    """Unregister an MCP server."""
    if serverId not in _servers:
        return False
    task = asyncio.create_task(_stopServerProcess(serverId))
    _mcpCleanupTasks.add(task)
    task.add_done_callback(_mcpCleanupTasks.discard)
    del _servers[serverId]
    _toolsCache.pop(serverId, None)
    try:
        _saveConfig()
    except OSError:
        pass
    return True


async def _mcp_initialize(proc: asyncio.subprocess.Process) -> bool:
    """Send MCP initialize + notifications/initialized handshake over stdio."""
    if not proc.stdin or not proc.stdout:
        return False
    init_req = {
        'jsonrpc': '2.0',
        'id': 0,
        'method': 'initialize',
        'params': {
            'protocolVersion': '2024-11-05',
            'capabilities': {},
            'clientInfo': {'name': 'august-proxy', 'version': '1.0.0'},
        },
    }
    try:
        proc.stdin.write((json.dumps(init_req) + '\n').encode())
        await proc.stdin.drain()
        raw = await asyncio.wait_for(proc.stdout.readline(), timeout=10)
        if not raw:
            return False
        # Best-effort: accept any JSON-RPC response; some servers reply without id match.
        try:
            json.loads(raw.decode())
        except json.JSONDecodeError:
            return False
        note = {'jsonrpc': '2.0', 'method': 'notifications/initialized'}
        proc.stdin.write((json.dumps(note) + '\n').encode())
        await proc.stdin.drain()
        return True
    except (asyncio.TimeoutError, ConnectionError, OSError):
        return False


async def _startServerProcess(serverId: str) -> asyncio.subprocess.Process | None:
    """Start an MCP server subprocess (stdio) with initialize handshake."""
    server = _servers.get(serverId)
    if not server:
        return None
    if serverId in _processes:
        return _processes[serverId]
    transport = as_str(server.get('transport'), 'stdio')
    if transport == 'sse' or transport == 'http':
        # SSE/HTTP transport: store URL only; tools/list via HTTP JSON-RPC.
        url = as_str(server.get('url'), '')
        if not url:
            server['status'] = 'error'
            server['error'] = 'SSE/HTTP transport requires url'
            return None
        server['status'] = 'running'
        server['transport'] = transport
        return None  # no local process; discoverTools handles HTTP
    env = dict(os.environ)
    env_cfg = server.get('env', {})
    if isinstance(env_cfg, dict):
        env.update({str(k): str(v) for k, v in env_cfg.items()})
    args_list = [as_str(a) for a in as_list(server.get('args'))]
    try:
        proc = await asyncio.create_subprocess_exec(
            as_str(server['command']),
            *args_list,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        _processes[serverId] = proc
        ok = await _mcp_initialize(proc)
        if not ok:
            # Some servers still work without strict handshake; mark running anyway.
            server['handshake'] = 'skipped_or_failed'
        else:
            server['handshake'] = 'ok'
        server['status'] = 'running'
        return proc
    except (FileNotFoundError, PermissionError) as exc:
        server['status'] = 'error'
        server['error'] = str(exc)
        return None


async def _stopServerProcess(serverId: str) -> None:
    """Stop an MCP server subprocess."""
    proc = _processes.pop(serverId, None)
    if proc:
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=5)
        except (asyncio.TimeoutError, ProcessLookupError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
    if serverId in _servers:
        _servers[serverId]['status'] = 'stopped'


async def stopServer(serverId: str) -> bool:
    """Public stop helper used by the HTTP router."""
    if serverId not in _servers and serverId not in _processes:
        return False
    await _stopServerProcess(serverId)
    return True


async def _discover_tools_http(serverId: str, url: str) -> list[dict[str, object]]:
    """tools/list over HTTP JSON-RPC (SSE endpoint base URL)."""
    import httpx

    request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'params': {}}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, json=request, headers={'Accept': 'application/json, text/event-stream'})
            resp.raise_for_status()
            data = resp.json()
            tools = as_list(as_dict(data.get('result'), {}).get('tools'), [])
            typed = [t for t in tools if isinstance(t, dict)]
            _toolsCache[serverId] = typed  # type: ignore[assignment]
            return typed  # type: ignore[return-value]
    except Exception as exc:
        srv = _servers.get(serverId)
        if isinstance(srv, dict):
            srv['error'] = str(exc)
        return []


async def discoverTools(serverId: str) -> list[dict[str, object]]:
    """Call the tools/list RPC method on an MCP server (stdio or HTTP)."""
    server = _servers.get(serverId)
    if not server:
        return []
    transport = as_str(server.get('transport'), 'stdio')
    if transport in ('sse', 'http'):
        url = as_str(server.get('url'), '')
        if not url:
            return []
        return await _discover_tools_http(serverId, url)

    proc = await _startServerProcess(serverId)
    if not proc or not proc.stdin or (not proc.stdout):
        return []
    request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}
    try:
        proc.stdin.write((json.dumps(request) + '\n').encode())
        await proc.stdin.drain()
        response = await asyncio.wait_for(proc.stdout.readline(), timeout=10)
        result = json.loads(response.decode())
        tools = result.get('result', {}).get('tools', [])
        _toolsCache[serverId] = tools
        return tools
    except (asyncio.TimeoutError, json.JSONDecodeError, ConnectionError) as exc:
        _servers.get(serverId, {})['error'] = str(exc)
        return []


async def executeTool(serverId: str, toolName: str, args: dict[str, object]) -> str:
    """Call a tool on an MCP server via JSON-RPC."""
    proc = await _startServerProcess(serverId)
    if not proc or not proc.stdin or (not proc.stdout):
        return f"Error: MCP server '{serverId}' not running"
    request = {
        'jsonrpc': '2.0',
        'id': str(uuid.uuid4()),
        'method': 'tools/call',
        'params': {'name': toolName, 'arguments': args},
    }
    try:
        proc.stdin.write((json.dumps(request) + '\n').encode())
        await proc.stdin.drain()
        response = await asyncio.wait_for(proc.stdout.readline(), timeout=MCP_TIMEOUT_MS / 1000)
        result = json.loads(response.decode())
        if 'error' in result:
            return f'Error: {result["error"].get("message", str(result["error"]))}'
        content = result.get('result', {}).get('content', [])
        textParts = [c.get('text', '') for c in content if c.get('type') in ('text', 'output_text')]
        return '\n'.join(textParts) if textParts else json.dumps(result['result'])
    except asyncio.TimeoutError:
        return f"Error: MCP tool '{toolName}' timed out"
    except json.JSONDecodeError:
        return 'Error: Invalid JSON response from MCP server'
    except Exception as exc:
        return f'Error: {exc}'


def getAllMcpTools() -> list[dict[str, object]]:
    """Get all tools from all registered MCP servers."""
    allTools = []
    for sid, tools in _toolsCache.items():
        for tool in tools:
            tool['_mcp_server_id'] = sid
            allTools.append(tool)
    return allTools


def getMcpToolDefinitions() -> list[dict[str, object]]:
    """Get MCP tools in a format compatible with the tool registry."""
    tools = getAllMcpTools()
    return [
        {
            'type': 'function',
            'function': {
                'name': f'mcp__{t.get("_mcp_server_id", "unknown")}__{t["name"]}',
                'description': t.get('description', ''),
                'parameters': t.get('inputSchema', {'type': 'object', 'properties': {}}),
            },
        }
        for t in tools
    ]


def getMcpToolDefinitionsSync() -> list[dict[str, object]]:
    """Sync accessor over the lazily-populated MCP tool cache.

    Triggers a background ``refresh_mcp_tools()`` when the cache is empty
    but servers are registered, so newly-added servers surface without a
    restart.
    """
    if not _toolsCache and _servers:
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(refreshMcpTools())
        except RuntimeError:
            pass
    return getMcpToolDefinitions()


async def refreshMcpTools() -> None:
    """Discover tools from every registered MCP server into the cache.

    Fire-and-forget-safe: called at startup (lifespan) and whenever MCP
    configuration changes. Failures per-server are swallowed and logged
    so one unhealthy server doesn't blank the rest of the tool list.
    """
    for serverId in list(_servers.keys()):
        try:
            await discoverTools(serverId)
        except Exception as exc:
            srv = _servers.get(serverId)
            if isinstance(srv, dict):
                srv['error'] = str(exc)


async def load_and_start_from_config() -> dict[str, object]:
    """Load mcp-servers.json, register, auto-start enabled servers, discover tools.

    Idempotent for already-registered ids. Returns a status summary for boot.
    """
    raw = _loadConfig()
    servers_raw = raw.get('servers', raw)
    loaded = 0
    started = 0
    errors: list[str] = []
    if isinstance(servers_raw, dict):
        items = list(servers_raw.items())
    elif isinstance(servers_raw, list):
        items = [(as_str(s.get('id'), f'mcp_{i}'), s) for i, s in enumerate(servers_raw) if isinstance(s, dict)]
    else:
        items = []

    for sid, entry in items:
        if not isinstance(entry, dict):
            continue
        name = as_str(entry.get('name'), sid)
        command = as_str(entry.get('command'), '')
        enabled = bool(entry.get('enabled', True))
        transport = as_str(entry.get('transport'), 'stdio')
        url = as_str(entry.get('url'), '')
        args = [as_str(a) for a in as_list(entry.get('args'))]
        env_raw = entry.get('env') if isinstance(entry.get('env'), dict) else {}
        env = {str(k): str(v) for k, v in env_raw.items()} if isinstance(env_raw, dict) else {}
        if sid in _servers:
            continue
        if not command and transport == 'stdio':
            continue
        registerServer(
            name,
            command,
            args=args,
            env=env,
            enabled=enabled,
            transport=transport,
            url=url,
            server_id=str(sid),
            persist=False,
        )
        loaded += 1
        if enabled:
            try:
                await _startServerProcess(str(sid))
                await discoverTools(str(sid))
                started += 1
            except Exception as exc:
                errors.append(f'{sid}: {exc}')
    return {'ok': True, 'loaded': loaded, 'started': started, 'errors': errors, 'registered': len(_servers)}


async def stop_all_servers() -> None:
    """Stop every running MCP subprocess (shutdown path)."""
    for sid in list(_processes.keys()):
        await _stopServerProcess(sid)


def isMcpToolName(name: str) -> bool:
    """Check if a tool name belongs to an MCP server."""
    return isinstance(name, str) and name.startswith('mcp__')


async def executeMcpToolCall(name: str, args: dict[str, object]) -> str:
    """Execute an MCP tool call by routing to the correct server."""
    parts = name.split('__', 2)
    if len(parts) < 3:
        return f'Error: Invalid MCP tool name: {name}'
    __, serverId, toolName = parts
    return await executeTool(serverId, toolName, args)


def sanitize_tool_schema(schema: object) -> dict[str, object]:
    """Sanitize a JSON Schema to ensure it has expected structure."""
    if not isinstance(schema, dict):
        return {'type': 'object', 'properties': {}}
    result = dict(schema)
    result.setdefault('type', 'object')
    result.setdefault('properties', {})
    return result