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
        'streamLen': 5,
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


async def _run_resume(buffer: str, stream_len: int, offset: int) -> list[str]:
    """Connect with an offset, collect the replay, disconnect immediately."""
    session_id = 'term_test_resume'
    ts._sessions[session_id] = {
        'id': session_id,
        'buffer': buffer,
        'streamLen': stream_len,
        'status': 'running',
        'approvedInteractive': True,
    }
    ts._wsQueues[session_id] = set()

    sent: list[str] = []

    class FakeWs:
        async def send_text(self, data: str) -> None:
            sent.append(data)

        async def receive_text(self) -> str:
            raise RuntimeError('disconnect')

        async def close(self, code: int = 1000) -> None:
            pass

    await asyncio.wait_for(
        ts.handleTerminalConnection(FakeWs(), session_id, offset=offset),
        timeout=2.0,
    )
    ts._sessions.pop(session_id, None)
    ts._wsQueues.pop(session_id, None)
    return sent


@pytest.mark.asyncio
async def test_resume_replays_only_unseen_output() -> None:
    """A reconnecting client that already saw the first 5 code points of a
    10-char buffer receives only the unseen suffix — no duplication."""
    sent = await _run_resume('boot\nlive\n', 10, 5)
    assert sent == ['live\n']


@pytest.mark.asyncio
async def test_resume_first_connect_receives_full_buffer() -> None:
    sent = await _run_resume('boot\nlive\n', 10, 0)
    assert sent == ['boot\nlive\n']


@pytest.mark.asyncio
async def test_resume_after_buffer_truncation_replays_what_client_missed() -> None:
    """streamLen=50 but the buffer holds only the last 10 chars (40 truncated).
    The client saw the first 45 chars, so its unseen suffix is chars 45..50 —
    even though the buffer no longer starts at char 0."""
    sent = await _run_resume('0123456789', 50, 45)
    assert sent == ['56789']


@pytest.mark.asyncio
async def test_resume_offset_behind_truncation_gets_full_buffer() -> None:
    """The client missed output that has already been truncated out of the
    buffer — it can never recover those chars, so it gets the whole tail."""
    sent = await _run_resume('0123456789', 50, 3)
    assert sent == ['0123456789']


@pytest.mark.asyncio
async def test_resume_offset_ahead_of_stream_sends_nothing() -> None:
    sent = await _run_resume('boot\n', 5, 99)
    assert sent == []


def test_append_output_tracks_stream_len_through_truncation() -> None:
    """_append_output caps the buffer at BUFFER_LIMIT while streamLen counts
    every code point ever appended (the offset math depends on both)."""
    session: dict[str, object] = {'buffer': '', 'streamLen': 0}
    big = 'x' * 4096
    for _ in range(100):  # 409600 code points total
        ts._append_output(session, big)
    assert len(ts.as_str(session['buffer'], '')) == ts.BUFFER_LIMIT
    assert ts.as_int(session['streamLen'], 0) == 409600


@pytest.mark.asyncio
async def test_ddgs_subprocess_killed_on_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """A DDGS search that exceeds its window must hard-kill the isolated
    subprocess — a stuck search cannot hang the tool or leak a process."""
    import types

    from app.services.tool_registrations import web_tools as wt

    killed = asyncio.Event()

    class FakeProc:
        returncode: int | None = None

        async def communicate(self) -> tuple[bytes, bytes]:
            await asyncio.sleep(60)  # hangs past the timeout
            return b'', b''

        def kill(self) -> None:
            killed.set()

        async def wait(self) -> None:
            return None

    async def _fake_spawn(*_args: object, **_kwargs: object) -> FakeProc:
        return FakeProc()

    shim = types.SimpleNamespace(
        create_subprocess_exec=_fake_spawn,
        wait_for=asyncio.wait_for,
        subprocess=asyncio.subprocess,
        TimeoutError=TimeoutError,
        CancelledError=asyncio.CancelledError,
    )
    monkeypatch.setattr(wt, 'asyncio', shim)
    with pytest.raises(asyncio.TimeoutError):
        await wt._ddgs_subprocess_search('stuck query', 3, timeout=0.1)
    assert killed.is_set()
