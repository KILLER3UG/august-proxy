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


class _SilentByteStream(httpx._content.AsyncByteStream):
    """Simulates a stalled upstream: headers sent, then NO bytes for hangS."""

    def __init__(self, hangS: float) -> None:
        self._hangS = hangS

    async def __aiter__(self):
        await asyncio.sleep(self._hangS)
        yield b''
        return

    async def aclose(self) -> None:
        pass


class _GapByteStream(httpx._content.AsyncByteStream):
    """Wraps an async generator of byte chunks as an httpx response body."""

    def __init__(self, gen) -> None:
        self._gen = gen

    async def __aiter__(self):
        async for chunk in self._gen:
            yield chunk

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


class TestUpstreamRetryVisibility:
    """Phase L (Part 17): silent retries became visible events.

    A capped Retry-After wait (up to 30 s) inside the client retry loop
    previously produced ZERO stream events — the transcript sat frozen and
    users read it as "the model is slow". The retry loop must yield a
    type='upstreamRetry' marker (attempt/delayMs/status) before each wait,
    both for retryable HTTP statuses and pre-response transport failures.
    """

    @pytest.mark.asyncio
    async def test429RetryEmitsUpstreamRetryEvent(self, fastSleep):
        calls = {'n': 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls['n'] += 1
            if calls['n'] == 1:
                return httpx.Response(429, headers={'retry-after': '2'}, json={'error': 'slow down'})
            return httpx.Response(200, stream=_SseByteStream([b'data: {"n": 1}\n\n']))

        client = _clientWithHandler(handler)
        events = [e async for e in client.streamSse('http://upstream.test/x', {}, {})]
        retryEvents = [e for e in events if e.get('type') == 'upstreamRetry']
        assert len(retryEvents) == 1, 'one retry marker expected, before the content'
        assert events[0].get('type') == 'upstreamRetry'
        assert retryEvents[0].get('attempt') == 1
        assert retryEvents[0].get('status') == 429
        # Retry-After: 2 → 2000 ms (delay surfaced so the UI can show the wait).
        assert retryEvents[0].get('delayMs') == 2000
        assert any(e.get('n') == 1 for e in events)
        await client.close()

    @pytest.mark.asyncio
    async def testConnectErrorRetryEmitsUpstreamRetryEvent(self, fastSleep):
        calls = {'n': 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls['n'] += 1
            if calls['n'] == 1:
                raise httpx.ConnectError('refused')
            return httpx.Response(200, stream=_SseByteStream([b'data: {"n": 1}\n\n']))

        client = _clientWithHandler(handler)
        events = [e async for e in client.streamSse('http://upstream.test/x', {}, {})]
        retryEvents = [e for e in events if e.get('type') == 'upstreamRetry']
        assert len(retryEvents) == 1
        assert retryEvents[0].get('status') == 0  # transport-level failure
        assert retryEvents[0].get('attempt') == 1
        assert retryEvents[0].get('delayMs', 0) > 0
        await client.close()

    @pytest.mark.asyncio
    async def testNoRetryNoMarker(self, fastSleep):
        """A clean first-attempt stream must NOT emit any retry marker."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, stream=_SseByteStream([b'data: {"n": 1}\n\n']))

        client = _clientWithHandler(handler)
        events = [e async for e in client.streamSse('http://upstream.test/x', {}, {})]
        assert not any(e.get('type') == 'upstreamRetry' for e in events)
        await client.close()


# ── TTFB watchdog + connect timeout (2026-08-31 speed audit) ────────────


class TestTtfbWatchdog:
    """A stalled upstream (connection accepted, no bytes) used to hold a
    turn open for the full 300 s request timeout — reading to the user as
    "the model is slow". The watchdog bounds the PRE-first-token window
    only; once events flow, chunk gaps are never interrupted."""

    @pytest.mark.asyncio
    async def test_stalled_upstream_fails_fast_and_retries(self):
        import time as _time

        # Simulate a STALLED first attempt: headers OK, zero bytes — the
        # first queue item never arrives within the watchdog window. The
        # retry then succeeds instantly (retry-safe: nothing was generated
        # — no bytes were received). Real timing, no sleep patching: the
        # watchdog (0.2s) + one real 1s backoff + instant retry ≈ 1.2s.
        calls = {'n': 0}
        stalled = {'arm': True}

        def stallingHandler(request: httpx.Request) -> httpx.Response:
            calls['n'] += 1
            if stalled['arm'] and calls['n'] == 1:
                return httpx.Response(
                    200,
                    headers={'content-type': 'text/event-stream'},
                    content=_SilentByteStream(hangS=5.0),
                )
            stalled['arm'] = False
            return httpx.Response(
                200,
                headers={'content-type': 'text/event-stream'},
                content=_SseByteStream([b'data: {"ok": 1}\n\n', b'data: [DONE]\n\n']),
            )

        client2 = _clientWithHandler(stallingHandler)
        client2.ttfbTimeoutS = 0.2
        t0 = _time.monotonic()
        events = [e async for e in client2.streamSse('http://upstream.test/x', {}, {})]
        elapsed = _time.monotonic() - t0
        assert elapsed < 2.5, f'watchdog did not fail fast: {elapsed:.1f}s'
        types = [e.get('type') for e in events]
        assert 'upstreamRetry' in types, f'expected a retry after the watchdog trip: {types}'
        assert not any(e.get('type') == 'error' for e in events), f'retry should have recovered: {events}'
        assert any(e.get('ok') == 1 for e in events), events
        await client2.close()

    @pytest.mark.asyncio
    async def test_watchdog_never_trips_midstream(self):
        """After the first event, a long chunk gap must NOT be interrupted."""
        import time as _time

        def handler(request: httpx.Request) -> httpx.Response:
            async def gen():
                yield b'data: {"n": 1}\n\n'
                await asyncio.sleep(1.2)  # a "thinking" pause mid-generation
                yield b'data: {"n": 2}\n\n'
                yield b'data: [DONE]\n\n'

            return httpx.Response(
                200,
                headers={'content-type': 'text/event-stream'},
                content=_GapByteStream(gen()),
            )

        client = _clientWithHandler(handler)
        client.ttfbTimeoutS = 0.3
        t0 = _time.monotonic()
        events = [e async for e in client.streamSse('http://upstream.test/x', {}, {})]
        elapsed = _time.monotonic() - t0
        payloads = [e.get('n') for e in events if isinstance(e.get('n'), int)]
        assert payloads == [1, 2], f'mid-stream gap was interrupted: {events}'
        assert elapsed >= 1.0, 'the mid-stream pause was not actually waited out'
        assert not any(e.get('type') == 'error' for e in events)
        await client.close()

    def test_env_knobs_feed_the_client(self, monkeypatch):
        monkeypatch.setenv('AUGUST_TTFB_TIMEOUT_S', '12.5')
        monkeypatch.setenv('AUGUST_CONNECT_TIMEOUT_S', '3')
        c = BaseProviderClient({'name': 't'})
        assert c.ttfbTimeoutS == 12.5
        assert c.connectTimeout == 3.0
        # 0 disables the watchdog entirely.
        monkeypatch.setenv('AUGUST_TTFB_TIMEOUT_S', '0')
        assert BaseProviderClient({'name': 't'}).ttfbTimeoutS == 0.0
        # Malformed values fall back to the default.
        monkeypatch.setenv('AUGUST_TTFB_TIMEOUT_S', 'nonsense')
        assert BaseProviderClient({'name': 't'}).ttfbTimeoutS == 45.0
