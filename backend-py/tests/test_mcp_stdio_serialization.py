"""MCP stdio requests must be serialized per server.

A stdio MCP child multiplexes ONE stdin/stdout pair. `_stdio_rpc` reads frames
until it sees the request id it sent, discarding anything else as a server
notification — which is correct in isolation and wrong under concurrency: two
callers on the same child read each other's responses, both discard them, both
block until timeout, and the loser is reaped. From the outside that looks like
the MCP server going flaky, not like a local serialization bug.

These tests drive the real read/write functions against a fake process, so the
lock is exercised rather than asserted about.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from app.services.tools import mcp_client


class _FakeStdin:
    """Captures the lines written, so a test can prove the ORDER."""

    def __init__(self) -> None:
        self.lines: list[str] = []

    def write(self, data: str) -> None:
        self.lines.append(data)

    async def drain(self) -> None:
        return None

    def close(self) -> None:  # pragma: no cover - not used on this path
        return None


class _FakeProc:
    """A child that echoes a response per request, but only after the test
    releases it — which is what makes the interleaving observable."""

    def __init__(self) -> None:
        self.stdin = _FakeStdin()
        self.stdout = object()
        self._pending: list[asyncio.Future[dict]] = []
        self.release: asyncio.Event | None = None

    def queue_response(self, payload: dict) -> None:
        fut: asyncio.Future[dict] = asyncio.get_event_loop().create_future()
        self._pending.append(fut)
        fut.set_result(payload)

    async def _next(self) -> dict:
        while not self._pending:
            await asyncio.sleep(0)
        return self._pending.pop(0)


class TestPerServerSerialization:
    def setup_method(self) -> None:
        mcp_client._stdio_locks.clear()

    def teardown_method(self) -> None:
        mcp_client._stdio_locks.clear()

    def test_a_response_is_never_consumed_by_the_wrong_caller(self, monkeypatch):
        """What the lock actually buys, stated precisely.

        The read loop DISCARDS frames whose id is not the caller's (that is how
        it skips server notifications), so a frame taken by the wrong reader is
        gone rather than returned to the other caller.

        Whether two concurrent callers CAN collide depends on arrival order —
        a reader takes the OLDEST frame, which is usually its own, which is why
        this shows up intermittently rather than constantly. That is a real
        class, not a demonstrated repro, and the lock removes it by
        construction instead of relying on ordering.

        What this asserts is therefore the invariant, not a reproduction: with
        the lock, each caller writes, then reads, before the next begins, so
        every response is read exactly once by its owner.
        """
        proc = _FakeProc()
        inbox: asyncio.Queue[dict] = asyncio.Queue()
        order: list[str] = []

        async def _write(p, payload, framing='ndjson'):
            req = json.loads(json.dumps(payload))
            if 'id' in req:
                order.append(f'write:{req["id"]}')
                inbox.put_nowait({'jsonrpc': '2.0', 'id': req['id'], 'result': {'ok': True}})

        async def _read(p, timeout=None):
            got = inbox.get_nowait() if not inbox.empty() else None
            if got is not None:
                order.append(f'read:{got["id"]}')
            return got

        monkeypatch.setattr(mcp_client, '_stdio_write', _write)
        monkeypatch.setattr(mcp_client, '_stdio_read_raw_message', _read)

        async def _run():
            return await asyncio.gather(
                mcp_client._stdio_rpc(
                    proc, 'tools/call', {}, msg_id='A', timeout=5.0, server_id='srv'
                ),
                mcp_client._stdio_rpc(
                    proc, 'tools/call', {}, msg_id='B', timeout=5.0, server_id='srv'
                ),
            )

        first, second = asyncio.run(_run())
        assert first is not None and first.get('id') == 'A'
        assert second is not None and second.get('id') == 'B'
        assert order == ['write:A', 'read:A', 'write:B', 'read:B'], order

    def test_a_server_notification_is_skipped_not_returned(self, monkeypatch):
        """The reason a cross-talk would be lossy, pinned directly.

        `_stdio_rpc` loops until it sees its own id. A frame for someone else is
        dropped — correct for a notification, lossy if that frame was another
        caller's response.
        """
        proc = _FakeProc()
        frames: list[dict] = [
            {'jsonrpc': '2.0', 'method': 'notifications/message', 'params': {}},
            {'jsonrpc': '2.0', 'id': 'MINE', 'result': {'ok': True}},
        ]

        async def _write(p, payload, framing='ndjson'):
            return None

        async def _read(p, timeout=None):
            return frames.pop(0) if frames else None

        monkeypatch.setattr(mcp_client, '_stdio_write', _write)
        monkeypatch.setattr(mcp_client, '_stdio_read_raw_message', _read)

        async def _run():
            return await mcp_client._stdio_rpc(
                proc, 'tools/call', {}, msg_id='MINE', timeout=2.0, server_id='srv'
            )

        got = asyncio.run(_run())
        assert got is not None and got.get('id') == 'MINE'
        assert not frames, 'the loop returned before consuming the pipe'

    def test_different_servers_are_not_serialized_against_each_other(self):
        """Keyed per server: an unrelated slow server must not block this one.
        A single global lock would pass the test above and fail this one."""
        a = object()
        b = object()
        lockA = mcp_client._stdio_lock_for('srv-a', a)  # type: ignore[arg-type]
        lockB = mcp_client._stdio_lock_for('srv-b', b)  # type: ignore[arg-type]
        assert lockA is not lockB

        # Same server, same process handle → the same lock.
        again = mcp_client._stdio_lock_for('srv-a', a)  # type: ignore[arg-type]
        assert again is lockA

    def test_the_same_lock_is_reused_for_one_server(self):
        lock1 = mcp_client._stdio_lock_for('x', object())  # type: ignore[arg-type]
        lock2 = mcp_client._stdio_lock_for('x', object())  # type: ignore[arg-type]
        assert lock1 is lock2

    def test_an_unnamed_process_still_gets_a_lock(self):
        """`server_id` is optional (the SSE path never passes one), so the
        fallback keys on process identity rather than disabling the gate."""
        proc = object()
        assert mcp_client._stdio_lock_for('', proc) is mcp_client._stdio_lock_for('', proc)  # type: ignore[arg-type]

    def test_stopping_a_server_drops_its_lock(self, monkeypatch):
        """A restart must not inherit a lock whose holder may never release."""
        mcp_client._stdio_locks['doomed'] = asyncio.Lock()
        monkeypatch.setattr(mcp_client, '_processes', {})
        monkeypatch.setattr(mcp_client, '_toolsCache', {})
        monkeypatch.setattr(mcp_client, '_stderr_tasks', {})

        async def _run():
            await mcp_client._stopServerProcess('doomed')

        asyncio.run(_run())
        assert 'doomed' not in mcp_client._stdio_locks
