"""R-C (plan §10.3): idempotency-safe upstream retry + per-host rate gate.

The billing-safety rule: only requests PROVABLY unprocessed are ever
replayed. A refused connection retries; a timeout waiting on response data
or a mid-stream failure after events were emitted never replays — the
provider may already have generated (and been billed for) those tokens.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
from app.providers.clients.base import BaseProviderClient
from app.providers.clients.rate_gate import ProviderRateGate, hostOfUrl, rateGate


@pytest.fixture(autouse=True)
def _clearGate():
    rateGate.clear()
    yield
    rateGate.clear()


@pytest.fixture
def fastSleep(monkeypatch):
    """Skip real backoff delays — retry sleeps yield control instantly."""
    original = asyncio.sleep

    async def _fast(delay: float) -> None:
        await original(0)

    monkeypatch.setattr(asyncio, 'sleep', _fast)
    return original


def _clientWithHandler(handler) -> BaseProviderClient:
    client = BaseProviderClient({'name': 'test'}, timeout=5.0, maxRetries=3)
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return client


class _SseByteStream(httpx._content.AsyncByteStream):
    """Async byte stream yielding SSE chunks, then optionally failing."""

    def __init__(self, chunks: list[bytes], exc: Exception | None = None) -> None:
        self._chunks = chunks
        self._exc = exc

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk
        if self._exc is not None:
            raise self._exc

    async def aclose(self) -> None:
        pass


class TestRequestJsonIdempotency:
    @pytest.mark.asyncio
    async def testConnectErrorRetriesThenSucceeds(self, fastSleep):
        calls = {'n': 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls['n'] += 1
            if calls['n'] < 3:
                raise httpx.ConnectError('refused')
            return httpx.Response(200, json={'ok': True})

        client = _clientWithHandler(handler)
        resp = await client.requestJson('POST', 'http://upstream.test/x', headers={}, body={})
        assert resp.status == 200
        assert calls['n'] == 3  # provably-unprocessed failures replayed
        await client.close()

    @pytest.mark.asyncio
    async def testReadTimeoutNeverReplayed(self, fastSleep):
        """A read timeout means the provider may be generating (billing) —
        the request must NOT be re-sent."""
        calls = {'n': 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls['n'] += 1
            raise httpx.ReadTimeout('timed out')

        client = _clientWithHandler(handler)
        resp = await client.requestJson('POST', 'http://upstream.test/x', headers={}, body={})
        assert resp.status == 0
        assert calls['n'] == 1  # exactly one attempt — no replay
        assert 'not retried' in str(resp.body)
        await client.close()

    @pytest.mark.asyncio
    async def testConnectErrorExhaustionSurfaces(self, fastSleep):
        calls = {'n': 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls['n'] += 1
            raise httpx.ConnectError('refused')

        client = _clientWithHandler(handler)
        resp = await client.requestJson('POST', 'http://upstream.test/x', headers={}, body={})
        assert resp.status == 0
        assert calls['n'] == 4  # initial + maxRetries
        assert 'retries' in str(resp.body)
        await client.close()

    @pytest.mark.asyncio
    async def testRateLimit429RetriesAndRecordsGate(self, fastSleep):
        calls = {'n': 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls['n'] += 1
            if calls['n'] == 1:
                return httpx.Response(429, headers={'retry-after': '2'}, json={'error': 'slow down'})
            return httpx.Response(200, json={'ok': True})

        client = _clientWithHandler(handler)
        resp = await client.requestJson('POST', 'http://upstream.test/x', headers={}, body={})
        assert resp.status == 200
        assert calls['n'] == 2
        # The 429 armed the per-host cooldown for other callers.
        assert rateGate.cooldownRemainingS('upstream.test') > 0
        await client.close()


class TestStreamSseIdempotency:
    @pytest.mark.asyncio
    async def testMidStreamFailureAfterEmissionNeverReplayed(self, fastSleep):
        """Once events were yielded the completion may be billed — a
        mid-stream transport failure surfaces as partial error, no retry."""
        calls = {'n': 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls['n'] += 1
            return httpx.Response(
                200,
                stream=_SseByteStream([b'data: {"n": 1}\n\n'], httpx.ReadError('dropped mid-stream')),
            )

        client = _clientWithHandler(handler)
        events = [e async for e in client.streamSse('http://upstream.test/x', {}, {})]
        assert calls['n'] == 1  # never replayed a possibly-billed stream
        assert events[0].get('n') == 1
        assert events[-1]['type'] == 'error'
        assert events[-1].get('partial') is True
        await client.close()

    @pytest.mark.asyncio
    async def testPreResponseFailureRetries(self, fastSleep):
        """Connection refused before any response: provably unprocessed —
        the request retries and succeeds."""
        calls = {'n': 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls['n'] += 1
            if calls['n'] == 1:
                raise httpx.ConnectError('refused')
            return httpx.Response(200, stream=_SseByteStream([b'data: {"n": 1}\n\n']))

        client = _clientWithHandler(handler)
        events = [e async for e in client.streamSse('http://upstream.test/x', {}, {})]
        assert calls['n'] == 2
        assert any(e.get('n') == 1 for e in events)
        assert not any(e.get('type') == 'error' for e in events)
        await client.close()

    @pytest.mark.asyncio
    async def testPreResponse429Retries(self, fastSleep):
        calls = {'n': 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls['n'] += 1
            if calls['n'] == 1:
                return httpx.Response(429, headers={'retry-after': '1'}, json={'error': 'slow down'})
            return httpx.Response(200, stream=_SseByteStream([b'data: {"n": 1}\n\n']))

        client = _clientWithHandler(handler)
        events = [e async for e in client.streamSse('http://upstream.test/x', {}, {})]
        assert calls['n'] == 2
        assert any(e.get('n') == 1 for e in events)
        assert rateGate.cooldownRemainingS('upstream.test') > 0
        await client.close()


class TestRateGate:
    def testHostOfUrl(self):
        assert hostOfUrl('https://api.example.com/v1/chat') == 'api.example.com'
        assert hostOfUrl('http://localhost:11434/api') == 'localhost:11434'
        assert hostOfUrl('not a url ::') == ''

    def testCooldownRecordedAndDecays(self):
        gate = ProviderRateGate()
        assert gate.cooldownRemainingS('h') == 0.0
        gate.recordRateLimit('h', 5000)
        remaining = gate.cooldownRemainingS('h')
        assert 4.0 < remaining <= 5.0
        # Longer cooldown wins, shorter never shrinks it.
        gate.recordRateLimit('h', 1000)
        assert gate.cooldownRemainingS('h') >= remaining - 0.1

    def testBare429WithoutHintGetsCourtesyCooldown(self):
        gate = ProviderRateGate()
        gate.recordRateLimit('h', None)
        assert gate.cooldownRemainingS('h') > 0.0

    def testWaitBoundedByMaxWait(self):
        gate = ProviderRateGate(maxWaitS=0.01)
        gate.recordRateLimit('h', 60_000)  # huge Retry-After
        assert gate.cooldownRemainingS('h') <= 0.01 + 0.001

    @pytest.mark.asyncio
    async def testWaitSleepsOutCooldown(self):
        gate = ProviderRateGate()
        gate.recordRateLimit('h', 50)
        await gate.wait('h')  # ~50 ms
        assert gate.cooldownRemainingS('h') < 0.05

    @pytest.mark.asyncio
    async def testWaitOnUnknownHostIsInstant(self):
        gate = ProviderRateGate()
        await gate.wait('never-seen')  # must not raise or block
