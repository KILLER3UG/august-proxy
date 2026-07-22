"""Terminal WebSocket fan-out should deliver live output via queues."""

from __future__ import annotations

import asyncio

import pytest

from app.services.workbench import terminal_service as ts


@pytest.mark.asyncio
async def test_broadcast_terminal_delivers_to_queue() -> None:
    session_id = 'term_test_broadcast'
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    ts._wsQueues[session_id] = {queue}
    try:
        ts._broadcastTerminal(session_id, 'hello\n')
        assert queue.get_nowait() == 'hello\n'
    finally:
        ts._wsQueues.pop(session_id, None)


@pytest.mark.asyncio
async def test_handle_terminal_connection_pumps_output() -> None:
    session_id = 'term_test_ws'
    ts._sessions[session_id] = {
        'id': session_id,
        'buffer': 'boot\n',
        'status': 'running',
        'approvedInteractive': True,
    }
    ts._wsQueues[session_id] = set()

    sent: list[str] = []
    closed = asyncio.Event()

    class FakeWs:
        async def send_text(self, data: str) -> None:
            sent.append(data)

        async def receive_text(self) -> str:
            # Wait until pump has a chance to deliver a live chunk, then disconnect.
            await asyncio.sleep(0.05)
            raise RuntimeError('disconnect')

        async def close(self, code: int = 1000) -> None:
            closed.set()

    task = asyncio.create_task(ts.handleTerminalConnection(FakeWs(), session_id))
    await asyncio.sleep(0.02)
    # Simulate PTY reader broadcasting after the WS subscribed.
    ts._broadcastTerminal(session_id, 'live-out\n')
    await asyncio.wait_for(task, timeout=2.0)
    assert 'boot\n' in sent
    assert 'live-out\n' in sent
    assert closed.is_set()
    ts._sessions.pop(session_id, None)
    ts._wsQueues.pop(session_id, None)
