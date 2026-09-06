"""Local egress filter: makes ``network: false`` actually enforced.

History: network-off was a shell denylist — chained-command scanning blocked
``curl``/``wget`` heads while ``python -c "import urllib…"`` reached the
network untouched. This module runs a small local HTTP proxy on loopback and
sandboxed processes get ``HTTP(S)_PROXY`` env-injected, so well-behaved HTTP
clients (urllib, requests, httpx, npm, pip…) are blocked at CONNECT with a
clear 403 instead of silently reaching out.

Honest scope: the proxy constrains HTTP-client traffic only. Raw sockets to
hard-coded IPs bypass it (no transparent interception on a desktop host) —
for real enforcement pair it with the container backend, which uses
``--network none``. The two compose: policy heuristics + this proxy on the
host, kernel-level isolation in a container.
"""

from __future__ import annotations

import asyncio

_DEFAULT_DENY_BODY = b'blocked by sandbox policy (network disabled)'


class EgressProxy:
    """Loopback HTTP proxy that allows or denies outbound connections.

    ``allowed_hosts=None`` denies every outbound target (the sandbox
    ``network: false`` case). Pass a frozenset of hostnames to allow exactly
    those; everything else is refused with 403. Only loopback is bound.
    """

    def __init__(self, allowed_hosts: frozenset[str] | None = None) -> None:
        self._allow_set = allowed_hosts
        self._server: asyncio.Server | None = None
        self.port = 0

    async def ensure_started(self) -> int:
        """Start the proxy once; returns its loopback port."""
        if self._server is None:
            self._server = await asyncio.start_server(self._handle, '127.0.0.1', 0)
            self.port = int(self._server.sockets[0].getsockname()[1])
        return self.port

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            try:
                # wait_closed() blocks while open relayed sockets linger —
                # never let shutdown hang on them.
                await asyncio.wait_for(self._server.wait_closed(), timeout=2)
            except asyncio.TimeoutError:
                pass
            self._server = None
            self.port = 0

    def _is_allowed(self, target: str) -> bool:
        host = target.strip('[]').lower()
        # Strip the port — CONNECT targets arrive as host:port and the
        # allowlist is keyed by host name.
        if ':' in host and not host.endswith(']'):
            host = host.rsplit(':', 1)[0]
        if self._allow_set is None:
            return False
        return host in self._allow_set

    async def _handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            try:
                first = await asyncio.wait_for(reader.readline(), timeout=10)
            except asyncio.TimeoutError:
                return
            target = _target_host(first)
            if not target or not self._is_allowed(target):
                writer.write(
                    b'HTTP/1.1 403 Forbidden\r\n'
                    b'Content-Length: ' + str(len(_DEFAULT_DENY_BODY)).encode() + b'\r\n'
                    b'Connection: close\r\n\r\n' + _DEFAULT_DENY_BODY
                )
                await writer.drain()
                return
            host, port = target, 443
            if ':' in target and not target.endswith(']'):
                host, _, port_s = target.rpartition(':')
                try:
                    port = int(port_s)
                except ValueError:
                    port = 443
            if first.startswith(b'CONNECT'):
                # Drain the rest of the CONNECT request headers — leftover
                # bytes would otherwise leak into the tunnel as data.
                for _ in range(16):
                    leftover = await asyncio.wait_for(reader.readline(), timeout=5)
                    if leftover in (b'\r\n', b'\n', b''):
                        break
                await self._relay_connect(reader, writer, host, port)
            else:
                # Absolute-URI plain HTTP: forward the raw stream to :80.
                await self._relay_plain(reader, writer, host)
        except (ConnectionError, OSError, asyncio.IncompleteReadError):
            pass
        finally:
            # close() only — wait_closed() can hang indefinitely on the
            # proactor loop while the peer holds its side open.
            try:
                writer.close()
            except (OSError, ConnectionError):
                pass

    async def _relay_connect(
        self,
        client_reader: asyncio.StreamReader,
        client_writer: asyncio.StreamWriter,
        host: str,
        port: int,
    ) -> None:
        up_reader, up_writer = await asyncio.open_connection(host, port)
        client_writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
        await client_writer.drain()
        pump_a = _pump(client_reader, up_writer)
        pump_b = _pump(up_reader, client_writer)
        await asyncio.gather(pump_a, pump_b, return_exceptions=True)

    async def _relay_plain(
        self,
        client_reader: asyncio.StreamReader,
        client_writer: asyncio.StreamWriter,
        host: str,
    ) -> None:
        up_reader, up_writer = await asyncio.open_connection(host, 80)
        # Re-emit the request line as origin-form (proxy → origin request).
        first = await client_reader.readline()
        parts = first.split(b' ', 2)
        if len(parts) == 3:
            path = parts[1]
            origin = path.split(b'/', 3)
            origin_form = b'/' + origin[3] if len(origin) == 4 else b'/'
            up_writer.write(parts[0] + b' ' + origin_form + b' ' + parts[2])
        else:
            up_writer.write(first)
        headers = await client_reader.readuntil(b'\r\n\r\n')
        up_writer.write(headers)
        await up_writer.drain()
        pump_a = _pump(client_reader, up_writer)
        pump_b = _pump(up_reader, client_writer)
        await asyncio.gather(pump_a, pump_b, return_exceptions=True)


async def _pump(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    try:
        while chunk := await reader.read(65536):
            writer.write(chunk)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        try:
            writer.close()
        except (OSError, ConnectionError):
            pass


def _target_host(request_line: bytes) -> str | None:
    """Extract the destination host from a CONNECT line or absolute-URI GET."""
    try:
        parts = request_line.strip().split(b' ')
        if len(parts) < 2:
            return None
        target = parts[1].decode('latin-1')
        if target.lower().startswith('http://'):
            rest = target[7:]
            return rest.split('/', 1)[0].split('@')[-1] or None
        if target.lower().startswith('https://'):
            rest = target[8:]
            return rest.split('/', 1)[0].split('@')[-1] or None
        return target or None
    except (UnicodeDecodeError, IndexError):
        return None


_shared = EgressProxy()


def get_shared_proxy() -> EgressProxy:
    """Process-wide deny-all proxy for ``network: false`` sandbox runs."""
    return _shared


async def proxy_env_for_policy(network: bool) -> dict[str, str]:
    """Env vars forcing HTTP clients through the shared egress filter.

    Returns {} when the policy allows network (no proxy) — container-mode
    enforcement comes from ``--network none`` instead.
    """
    if network:
        return {}
    port = await get_shared_proxy().ensure_started()
    proxy = f'http://127.0.0.1:{port}'
    return {
        'HTTP_PROXY': proxy,
        'HTTPS_PROXY': proxy,
        'ALL_PROXY': proxy,
        'http_proxy': proxy,
        'https_proxy': proxy,
        'all_proxy': proxy,
        # The model routinely talks to local dev servers it spawned itself.
        'NO_PROXY': 'localhost,127.0.0.1,::1',
        'no_proxy': 'localhost,127.0.0.1,::1',
    }
