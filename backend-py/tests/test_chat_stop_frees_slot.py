"""Stop must free the in-flight slot so the next /chat is not queued."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from app.main import app
from app.routers import workbench as wr
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


@pytest.mark.asyncio
async def test_stop_frees_active_stream_slot(client):
    sid = 'wb_stop_slot_test'

    async def hang() -> None:
        await asyncio.Event().wait()

    task = asyncio.create_task(hang())
    cancel = asyncio.Event()
    wr._activeStreams[sid] = task
    wr._cancelled[sid] = cancel

    with patch.object(wr.wb, 'clearQueuedMessages', return_value=0), patch.object(
        wr.wb, 'getWorkbenchSession', return_value=None
    ):
        resp = await client.post('/api/workbench/chat/stop', json={'sessionId': sid})

    assert resp.status_code == 200
    assert resp.json().get('status') == 'ok'
    assert cancel.is_set()
    assert wr._activeStreams.get(sid) is None

    # Allow cancel to settle
    await asyncio.sleep(0)
    if not task.done():
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    wr._activeStreams.pop(sid, None)
    wr._cancelled.pop(sid, None)


@pytest.mark.asyncio
async def test_chat_after_cancel_flag_does_not_queue(client):
    sid = 'wb_cancel_then_chat'

    async def hang() -> None:
        await asyncio.Event().wait()

    task = asyncio.create_task(hang())
    cancel = asyncio.Event()
    cancel.set()  # stop already signaled
    wr._activeStreams[sid] = task
    wr._cancelled[sid] = cancel

    with patch.object(
        wr.wb,
        'sendWorkbenchMessageStream',
        new_callable=AsyncMock,
    ) as mock_stream:
        mock_stream.return_value = None
        resp = await client.post(
            '/api/workbench/chat',
            json={'sessionId': sid, 'message': 'hello', 'handoffSummary': 'brief'},
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body.get('status') != 'queued'
    assert body.get('status') == 'started'

    # Cleanup background task from startChat
    started = wr._activeStreams.get(sid)
    if started and not started.done():
        cancel_ev = wr._cancelled.get(sid)
        if cancel_ev:
            cancel_ev.set()
        started.cancel()
        try:
            await started
        except (asyncio.CancelledError, Exception):
            pass
    if not task.done():
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
    wr._activeStreams.pop(sid, None)
    wr._cancelled.pop(sid, None)
