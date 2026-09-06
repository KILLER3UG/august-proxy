"""Egress filter proxy: deny/allow behavior for sandboxed network-off runs."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.sandbox.egress import EgressProxy, proxy_env_for_policy  # noqa: E402


async def _exchange(proxy_port: int, payload: bytes) -> bytes:
    reader, writer = await asyncio.open_connection('127.0.0.1', proxy_port)
    writer.write(payload)
    await writer.drain()
    data = await asyncio.wait_for(reader.read(4096), timeout=5)
    writer.close()
    try:
        await writer.wait_closed()
    except (ConnectionError, OSError):
        pass
    return data


@pytest.mark.asyncio
async def testConnectDeniedWhenNoAllowlist():
    proxy = EgressProxy()
    await proxy.ensure_started()
    try:
        resp = await _exchange(proxy.port, b'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n')
        assert resp.startswith(b'HTTP/1.1 403')
        assert b'blocked by sandbox policy' in resp
    finally:
        await proxy.stop()


@pytest.mark.asyncio
async def testPlainHttpDeniedWhenNoAllowlist():
    proxy = EgressProxy()
    await proxy.ensure_started()
    try:
        resp = await _exchange(
            proxy.port,
            b'GET http://example.com/path HTTP/1.1\r\nHost: example.com\r\n\r\n',
        )
        assert resp.startswith(b'HTTP/1.1 403')
    finally:
        await proxy.stop()


@pytest.mark.asyncio
async def testAllowedHostRelays():
    # A local echo server plays the "upstream": allowed host, bytes relayed.
    echo_chunks: list[bytes] = []

    async def echo_handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        while True:
            chunk = await reader.read(4096)
            if not chunk:
                break
            echo_chunks.append(chunk)
            writer.write(chunk)
            await writer.drain()
        writer.close()

    echo = await asyncio.start_server(echo_handler, '127.0.0.1', 0)
    echo_port = echo.sockets[0].getsockname()[1]
    proxy = EgressProxy(allowed_hosts=frozenset({'127.0.0.1'}))
    await proxy.ensure_started()
    try:
        reader, writer = await asyncio.open_connection('127.0.0.1', proxy.port)
        writer.write(f'CONNECT 127.0.0.1:{echo_port} HTTP/1.1\r\n\r\n'.encode())
        await writer.drain()
        banner = await asyncio.wait_for(reader.readexactly(39), timeout=5)
        assert banner == b'HTTP/1.1 200 Connection Established\r\n\r\n'
        writer.write(b'ping-through-proxy')
        await writer.drain()
        echoed = await asyncio.wait_for(reader.readexactly(18), timeout=5)
        assert echoed == b'ping-through-proxy'
        writer.close()
        try:
            await writer.wait_closed()
        except (ConnectionError, OSError):
            pass
    finally:
        echo.close()
        await proxy.stop()


@pytest.mark.asyncio
async def testProxyEnvForPolicy():
    assert await proxy_env_for_policy(network=True) == {}
    env = await proxy_env_for_policy(network=False)
    assert env['HTTP_PROXY'].startswith('http://127.0.0.1:')
    assert env['HTTPS_PROXY'] == env['HTTP_PROXY']
    assert '127.0.0.1' in env['NO_PROXY']
    # The shared proxy is a singleton — stop it so other tests start clean.
    from app.services.sandbox.egress import get_shared_proxy

    await get_shared_proxy().stop()
