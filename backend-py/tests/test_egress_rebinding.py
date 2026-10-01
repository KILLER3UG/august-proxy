"""The egress proxy must dial a vetted address, not re-resolve the name (#5).

`_is_allowed()` matched a HOSTNAME STRING against the allowlist, and
`asyncio.open_connection(host, port)` then resolved that name a second time.
A hostile authoritative DNS server can answer public for the first lookup and
`169.254.169.254` for the second, so the address that was vetted was never the
address that was dialled. An allowlisted name was enough to reach anything
inside the network.

This is the same time-of-check/time-of-use gap `web_tools._vetted_public_ips`
was written to close, with the same fix: resolve once, check every answer, and
dial the vetted address.
"""

from __future__ import annotations

import asyncio
import socket

import pytest
from app.services.sandbox.egress import EgressProxy


def _resolve_to(mapping: dict[str, list[str]]):
    """Patch getaddrinfo so specific names resolve to specific addresses."""

    async def fake(host, port, *a, **kw):
        addrs = mapping.get(host)
        if not addrs:
            raise socket.gaierror(-2, 'Name or service not known')
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, 0)) for ip in addrs
        ]

    return fake


class TestVettedAddresses:
    @pytest.mark.asyncio
    async def test_a_name_resolving_private_is_refused(self, monkeypatch):
        loop = asyncio.get_running_loop()
        monkeypatch.setattr(
            loop,
            'getaddrinfo',
            _resolve_to({'evil.test': ['169.254.169.254']}),
        )
        proxy = EgressProxy(allowed_hosts=frozenset({'evil.test'}))
        assert await proxy._vetted_addresses('evil.test', proxy._allow_set) == [], (
            'an allowlisted NAME that resolves to a link-local address was '
            'vetted — that is the whole rebinding case'
        )

    @pytest.mark.asyncio
    async def test_a_name_resolving_loopback_is_refused(self, monkeypatch):
        loop = asyncio.get_running_loop()
        monkeypatch.setattr(
            loop, 'getaddrinfo', _resolve_to({'sneaky.test': ['127.0.0.1']})
        )
        proxy = EgressProxy(allowed_hosts=frozenset({'sneaky.test'}))
        assert await proxy._vetted_addresses('sneaky.test', proxy._allow_set) == []

    @pytest.mark.asyncio
    async def test_a_split_answer_is_refused_entirely(self, monkeypatch):
        """Public AND private in one answer is refused, not resolved by luck."""
        loop = asyncio.get_running_loop()
        monkeypatch.setattr(
            loop,
            'getaddrinfo',
            _resolve_to({'split.test': ['93.184.216.34', '10.0.0.5']}),
        )
        proxy = EgressProxy(allowed_hosts=frozenset({'split.test'}))
        assert await proxy._vetted_addresses('split.test', proxy._allow_set) == [], (
            'a name resolving to both a public and a private address was '
            'accepted — picking the public one and hoping is the bypass'
        )

    @pytest.mark.asyncio
    async def test_a_public_name_still_works(self, monkeypatch):
        loop = asyncio.get_running_loop()
        monkeypatch.setattr(
            loop,
            'getaddrinfo',
            _resolve_to({'good.test': ['93.184.216.34', '93.184.216.34']}),
        )
        proxy = EgressProxy(allowed_hosts=frozenset({'good.test'}))
        got = await proxy._vetted_addresses('good.test', proxy._allow_set)
        assert got == ['93.184.216.34'], 'duplicate answers were not collapsed'
        assert got == list(dict.fromkeys(got)), 'a CDN returning repeats must still work'

    @pytest.mark.asyncio
    async def test_an_explicit_literal_on_the_allowlist_is_honoured(self):
        """Naming a private literal is a deliberate operator choice.

        The existing `testAllowedHostRelays` allowlists 127.0.0.1 and relays to a
        local echo server. Nobody rebinds a literal, so refusing it would break
        a legitimate use to close a hole that does not exist there.
        """
        proxy = EgressProxy(allowed_hosts=frozenset({'127.0.0.1'}))
        assert await proxy._vetted_addresses('127.0.0.1', proxy._allow_set) == [
            '127.0.0.1'
        ]

    @pytest.mark.asyncio
    async def test_a_literal_not_on_the_allowlist_is_refused(self):
        proxy = EgressProxy(allowed_hosts=frozenset({'other.test'}))
        assert await proxy._vetted_addresses('127.0.0.1', proxy._allow_set) == []

    @pytest.mark.asyncio
    async def test_an_unresolvable_name_is_refused(self, monkeypatch):
        loop = asyncio.get_running_loop()
        monkeypatch.setattr(loop, 'getaddrinfo', _resolve_to({}))
        proxy = EgressProxy(allowed_hosts=frozenset({'gone.test'}))
        assert await proxy._vetted_addresses('gone.test', proxy._allow_set) == []


class TestTheHandlerVetsBeforeDialing:
    @pytest.mark.asyncio
    async def test_a_rebinding_name_gets_403(self, monkeypatch):
        """End to end: allowlisted name, private answer, refused before dialling.

        No `open_connection` patch here on purpose. The test reaches the proxy
        through that same module attribute, so patching it hijacked the test's
        OWN connection and failed for the wrong reason. The 403 banner is itself
        the proof — the handler returns before it would have dialled — so there
        is no second assertion to make.
        """
        proxy = EgressProxy(allowed_hosts=frozenset({'evil.test'}))
        await proxy.ensure_started()
        try:
            monkeypatch.setattr(
                asyncio.get_running_loop(),
                'getaddrinfo',
                _resolve_to({'evil.test': ['169.254.169.254']}),
            )
            reader, writer = await asyncio.open_connection('127.0.0.1', proxy.port)
            writer.write(b'CONNECT evil.test:443 HTTP/1.1\r\n\r\n')
            await writer.drain()
            banner = await asyncio.wait_for(reader.readline(), timeout=5)
            assert banner.startswith(b'HTTP/1.1 403'), (
                f'expected 403 for a rebinding target, got {banner!r}'
            )
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass
        finally:
            await proxy.stop()