"""
MCP client — Model Context Protocol server management, tool discovery,
and tool execution.

Transports:
  * stdio — JSON-RPC newline-delimited over subprocess stdin/stdout
  * sse   — legacy HTTP+SSE (GET event stream + POST messages endpoint)
  * http  — streamable HTTP (single endpoint POST; JSON or SSE body)

Manages MCP server subprocesses / remote sessions, discovers tools, and
executes tool calls via JSON-RPC.
"""

from __future__ import annotations
import asyncio
import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

from app.lib.paths import dataPath
from app.json_narrowing import as_str, as_list, as_dict

logger = logging.getLogger(__name__)

_mcpCleanupTasks: set[asyncio.Task] = set()
MCP_CONFIG_FILE = 'mcp-servers.json'
MCP_TIMEOUT_MS = 30000
_PROTOCOL_VERSION = '2024-11-05'

# Remote SSE/HTTP session state: serverId → {endpoint, session_id, initialized}
_remote_sessions: dict[str, dict[str, object]] = {}


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
        row: dict[str, object] = {
            'id': sid,
            'name': srv.get('name', ''),
            'command': srv.get('command', ''),
            'args': list(as_list(srv.get('args'))),
            'env': dict(as_dict(srv.get('env'), {})),  # type: ignore[arg-type]
            'enabled': bool(srv.get('enabled', True)),
            'transport': as_str(srv.get('transport'), 'stdio'),
            'url': as_str(srv.get('url'), ''),
        }
        if srv.get('catalogId'):
            row['catalogId'] = srv.get('catalogId')
        servers_out[sid] = row
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


def set_server_meta(server_id: str, **meta: object) -> dict[str, object] | None:
    """Attach metadata (e.g. catalogId) and persist."""
    srv = _servers.get(server_id)
    if not isinstance(srv, dict):
        return None
    for k, v in meta.items():
        if v is not None:
            srv[k] = v
    try:
        _saveConfig()
    except OSError:
        pass
    return srv


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
    """Stop an MCP server subprocess and clear remote session state."""
    proc = _processes.pop(serverId, None)
    _remote_sessions.pop(serverId, None)
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


def _parse_sse_block(block: str) -> tuple[str, str]:
    """Parse one SSE event block into (event_name, data_payload)."""
    event_name = 'message'
    data_lines: list[str] = []
    for line in block.splitlines():
        if line.startswith('event:'):
            event_name = line[6:].strip() or 'message'
        elif line.startswith('data:'):
            data_lines.append(line[5:].lstrip())
    return event_name, '\n'.join(data_lines)


def _iter_sse_events(text: str) -> list[tuple[str, str]]:
    """Split an SSE body into (event, data) pairs."""
    events: list[tuple[str, str]] = []
    for block in text.replace('\r\n', '\n').split('\n\n'):
        block = block.strip()
        if not block:
            continue
        events.append(_parse_sse_block(block))
    return events


def _json_from_sse_body(text: str, prefer_id: object | None = None) -> dict[str, object] | None:
    """Extract a JSON-RPC response object from an SSE stream body."""
    candidates: list[dict[str, object]] = []
    for event_name, data in _iter_sse_events(text):
        if not data or event_name in ('endpoint', 'ping'):
            continue
        try:
            parsed = json.loads(data)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            candidates.append(parsed)
    if not candidates:
        return None
    if prefer_id is not None:
        for c in candidates:
            if c.get('id') == prefer_id:
                return c
    # Last response-like object wins
    for c in reversed(candidates):
        if 'result' in c or 'error' in c:
            return c
    return candidates[-1]


async def _read_sse_until_endpoint(client: Any, url: str, timeout: float = 15.0) -> tuple[str, str]:
    """Open GET SSE stream; return (messages_endpoint_url, raw_prefix_body).

    MCP HTTP+SSE: server sends ``event: endpoint`` with the POST URI for messages.
    """
    async with client.stream(
        'GET',
        url,
        headers={'Accept': 'text/event-stream', 'Cache-Control': 'no-cache'},
        timeout=timeout,
    ) as resp:
        resp.raise_for_status()
        buffer = ''
        async for chunk in resp.aiter_text():
            buffer += chunk
            for event_name, data in _iter_sse_events(buffer):
                if event_name == 'endpoint' and data:
                    endpoint = data.strip()
                    if endpoint.startswith('/'):
                        endpoint = urljoin(url if url.endswith('/') else url + '/', endpoint.lstrip('/'))
                    elif not endpoint.startswith('http'):
                        endpoint = urljoin(url.rstrip('/') + '/', endpoint)
                    return endpoint, buffer
            # Cap wait: if we already have a full event block and no endpoint, break
            if '\n\n' in buffer and len(buffer) > 65536:
                break
    raise RuntimeError('SSE stream did not yield an endpoint event')


async def _http_jsonrpc(
    client: Any,
    post_url: str,
    request: dict[str, object],
    *,
    headers: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> dict[str, object]:
    """POST JSON-RPC; accept application/json or text/event-stream responses."""
    hdrs = {
        'Accept': 'application/json, text/event-stream',
        'Content-Type': 'application/json',
    }
    if headers:
        hdrs.update(headers)
    resp = await client.post(post_url, json=request, headers=hdrs, timeout=timeout)
    resp.raise_for_status()
    ctype = (resp.headers.get('content-type') or '').lower()
    body = resp.text or ''
    if 'text/event-stream' in ctype or body.lstrip().startswith('event:') or '\ndata:' in body:
        parsed = _json_from_sse_body(body, prefer_id=request.get('id'))
        if parsed is None:
            raise RuntimeError('SSE response contained no JSON-RPC object')
        return parsed
    try:
        data = resp.json()
    except json.JSONDecodeError as exc:
        # Some servers still return SSE without the right content-type
        parsed = _json_from_sse_body(body, prefer_id=request.get('id'))
        if parsed is not None:
            return parsed
        raise RuntimeError(f'Invalid JSON-RPC response: {exc}') from exc
    if not isinstance(data, dict):
        raise RuntimeError('JSON-RPC response is not an object')
    return data


async def _ensure_remote_session(serverId: str) -> dict[str, object]:
    """Initialize remote SSE/HTTP session; return session dict with post endpoint."""
    import httpx

    existing = _remote_sessions.get(serverId)
    if isinstance(existing, dict) and existing.get('endpoint') and existing.get('initialized'):
        return existing

    server = _servers.get(serverId)
    if not server:
        raise RuntimeError(f'unknown server {serverId}')
    base_url = as_str(server.get('url'), '')
    if not base_url:
        raise RuntimeError('remote transport requires url')
    transport = as_str(server.get('transport'), 'http')

    session: dict[str, object] = {
        'endpoint': base_url,
        'session_id': None,
        'initialized': False,
        'transport': transport,
    }

    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        post_url = base_url
        if transport == 'sse':
            try:
                post_url, _ = await _read_sse_until_endpoint(client, base_url)
                session['endpoint'] = post_url
            except Exception as exc:
                # Fall back: treat base URL as streamable HTTP POST endpoint
                logger.info('SSE endpoint handshake failed for %s (%s); using base URL', serverId, exc)
                post_url = base_url
                session['endpoint'] = post_url
                session['transport'] = 'http'

        init_req: dict[str, object] = {
            'jsonrpc': '2.0',
            'id': 0,
            'method': 'initialize',
            'params': {
                'protocolVersion': _PROTOCOL_VERSION,
                'capabilities': {},
                'clientInfo': {'name': 'august-proxy', 'version': '1.0.0'},
            },
        }
        try:
            init_resp = await _http_jsonrpc(client, post_url, init_req)
            if 'error' in init_resp:
                err = init_resp.get('error')
                msg = as_dict(err, {}).get('message') if isinstance(err, dict) else err
                raise RuntimeError(f'initialize failed: {msg}')
            # Session id header (streamable HTTP)
            # httpx response is inside _http_jsonrpc — capture via second call path if needed
        except Exception as exc:
            # Some servers accept tools/list without initialize
            logger.info('MCP remote initialize soft-fail for %s: %s', serverId, exc)
            session['handshake'] = 'skipped_or_failed'
        else:
            session['handshake'] = 'ok'
            # notifications/initialized (no id)
            try:
                await client.post(
                    post_url,
                    json={'jsonrpc': '2.0', 'method': 'notifications/initialized'},
                    headers={'Accept': 'application/json, text/event-stream', 'Content-Type': 'application/json'},
                    timeout=10.0,
                )
            except Exception:
                pass

        session['initialized'] = True
        session['endpoint'] = post_url
        _remote_sessions[serverId] = session
        server['status'] = 'running'
        server['handshake'] = session.get('handshake', 'ok')
        return session


async def _remote_rpc(serverId: str, method: str, params: dict[str, object] | None = None) -> dict[str, object]:
    """JSON-RPC request over remote HTTP/SSE session."""
    import httpx

    session = await _ensure_remote_session(serverId)
    post_url = as_str(session.get('endpoint'), '')
    req_id = str(uuid.uuid4())
    request: dict[str, object] = {
        'jsonrpc': '2.0',
        'id': req_id,
        'method': method,
        'params': params if params is not None else {},
    }
    headers: dict[str, str] = {}
    sid = session.get('session_id')
    if sid:
        headers['Mcp-Session-Id'] = str(sid)

    async with httpx.AsyncClient(timeout=MCP_TIMEOUT_MS / 1000, follow_redirects=True) as client:
        data = await _http_jsonrpc(client, post_url, request, headers=headers or None)
        return data


async def discoverTools(serverId: str) -> list[dict[str, object]]:
    """Call the tools/list RPC method on an MCP server (stdio, SSE, or HTTP)."""
    server = _servers.get(serverId)
    if not server:
        return []
    transport = as_str(server.get('transport'), 'stdio')
    if transport in ('sse', 'http'):
        try:
            data = await _remote_rpc(serverId, 'tools/list', {})
            if 'error' in data:
                err = data.get('error')
                msg = as_dict(err, {}).get('message') if isinstance(err, dict) else str(err)
                server['error'] = str(msg)
                return []
            tools = as_list(as_dict(data.get('result'), {}).get('tools'), [])
            typed = [t for t in tools if isinstance(t, dict)]
            _toolsCache[serverId] = typed  # type: ignore[assignment]
            return typed  # type: ignore[return-value]
        except Exception as exc:
            server['error'] = str(exc)
            return []

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
    """Call a tool on an MCP server via JSON-RPC (stdio or remote SSE/HTTP)."""
    server = _servers.get(serverId)
    if not server:
        # Helpful hint when callers use a stale/wrong id (e.g. bare "mcp")
        known = ', '.join(sorted(_servers.keys())[:12]) or '(none registered)'
        return (
            f"Error: MCP server '{serverId}' is not registered. "
            f"Registered servers: {known}. Add it under Settings → Integrations."
        )
    transport = as_str(server.get('transport'), 'stdio')
    if transport in ('sse', 'http'):
        try:
            data = await _remote_rpc(
                serverId,
                'tools/call',
                {'name': toolName, 'arguments': args},
            )
            if 'error' in data:
                err = data.get('error')
                msg = as_dict(err, {}).get('message') if isinstance(err, dict) else str(err)
                return f'Error: {msg}'
            content = as_list(as_dict(data.get('result'), {}).get('content'), [])
            text_parts = [
                as_str(c.get('text'))
                for c in content
                if isinstance(c, dict) and c.get('type') in ('text', 'output_text')
            ]
            text_parts = [t for t in text_parts if t]
            if text_parts:
                return '\n'.join(text_parts)
            result = data.get('result')
            return json.dumps(result) if result is not None else ''
        except Exception as exc:
            return f'Error: {exc}'

    proc = await _startServerProcess(serverId)
    if not proc or not proc.stdin or (not proc.stdout):
        err = as_str(server.get('error')) if isinstance(server, dict) else ''
        detail = f' ({err})' if err else ''
        return (
            f"Error: MCP server '{serverId}' is not running{detail}. "
            'Open Settings → Integrations and Start the server (Node/npx must be on PATH for npx-based installs).'
        )
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
        reg = registerServer(
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
        if entry.get('catalogId'):
            reg['catalogId'] = entry.get('catalogId')
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
    if not isinstance(name, str):
        return False
    n = name[len('august__') :] if name.startswith('august__') else name
    return n.startswith('mcp__')


def parse_mcp_tool_name(name: str) -> tuple[str, str] | None:
    """Parse ``mcp__{serverId}__{toolName}`` (optional ``august__`` prefix).

    Server ids may contain hyphens (e.g. ``workspace-mcp``). Tool names may
    contain single underscores (e.g. ``start_google_auth``). We split on the
    first ``__`` after the ``mcp__`` prefix so serverId is never truncated to
    just ``mcp``.
    """
    if not isinstance(name, str):
        return None
    n = name[len('august__') :] if name.startswith('august__') else name
    if not n.startswith('mcp__'):
        return None
    rest = n[len('mcp__') :]
    sep = rest.find('__')
    if sep <= 0:
        return None
    server_id = rest[:sep]
    tool_name = rest[sep + 2 :]
    if not server_id or not tool_name:
        return None
    return server_id, tool_name


async def executeMcpToolCall(name: str, args: dict[str, object]) -> str:
    """Execute an MCP tool call by routing to the correct server."""
    parsed = parse_mcp_tool_name(name)
    if not parsed:
        return f'Error: Invalid MCP tool name: {name}'
    server_id, tool_name = parsed
    return await executeTool(server_id, tool_name, args)


def find_server_for_tool(tool_name: str) -> str | None:
    """Return a registered server id that has ``tool_name`` in its tools cache."""
    for sid, tools in _toolsCache.items():
        for t in tools:
            if isinstance(t, dict) and as_str(t.get('name')) == tool_name:
                return sid
    # Fallback: name/id heuristic (workspace-mcp package)
    for sid, srv in _servers.items():
        if not isinstance(srv, dict):
            continue
        blob = f"{srv.get('id', '')} {srv.get('name', '')} {srv.get('command', '')} {' '.join(as_list(srv.get('args')))}".lower()
        if tool_name.replace('_', '-') in blob or 'workspace' in blob and 'google' in tool_name:
            return sid
        if 'workspace-mcp' in blob or 'workspace_mcp' in blob:
            return sid
    return None


def sanitize_tool_schema(schema: object) -> dict[str, object]:
    """Sanitize a JSON Schema to ensure it has expected structure."""
    if not isinstance(schema, dict):
        return {'type': 'object', 'properties': {}}
    result = dict(schema)
    result.setdefault('type', 'object')
    result.setdefault('properties', {})
    return result