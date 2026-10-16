"""A user turn's attachment records must survive to the transcript row.

Proven broken end-to-end in the running app: a chat holding a PDF and a PNG
restored as the raw prompt surface — "📄 fixture.pdf" plus the extracted text
in a code block — because the persisted user row carried no `attachments`.
`ChatAttachmentService.displayText` strips that dump only when attachments are
present, `FileAttachmentCardRow` renders only when they are, and the Artifacts
gallery groups on them, so one missing field cost the card, the bubble and the
gallery at once. The row read back as
`id,sessionId,role,content,createdAt,clientMessageId,source` — no attachments.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from app.main import app
from app.routers import workbench as wr
from app.services.memory_store.transcript_blocks import structured_fields
from app.services.message_sources import strip_august_message_keys
from httpx import ASGITransport, AsyncClient

ATT = [{'name': 'fixture.pdf', 'path': '/w/.aug/attachments/s/fixture.pdf', 'type': 'text'}]


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


async def _post_chat(client, sid, body_extra):
    """Send one /chat and report the kwargs the turn runner received."""
    with patch.object(wr.wb, 'sendWorkbenchMessageStream', new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = None
        resp = await client.post(
            '/api/workbench/chat',
            json={'sessionId': sid, 'message': 'use these', **body_extra},
        )
        assert resp.status_code == 200
        for _ in range(40):
            if mock_stream.await_count:
                break
            await asyncio.sleep(0.02)
    started = wr._activeStreams.pop(sid, None)
    if started is not None and not started.done():
        started.cancel()
    wr._cancelled.pop(sid, None)
    return mock_stream


@pytest.mark.asyncio
async def test_chat_forwards_body_attachments_to_the_turn(client):
    sid = 'wb_att_forward'
    stream = await _post_chat(client, sid, {'attachments': ATT})
    assert stream.await_count == 1, 'the turn never ran — the assertion below would be vacuous'
    assert stream.await_args.kwargs['attachments'] == ATT


@pytest.mark.asyncio
async def test_chat_drops_non_object_entries_and_a_missing_key(client):
    """The body is an external boundary; junk must not reach the transcript."""
    sid = 'wb_att_junk'
    stream = await _post_chat(client, sid, {'attachments': [ATT[0], 'nope', None, 7]})
    assert stream.await_args.kwargs['attachments'] == ATT

    plain = await _post_chat(client, 'wb_att_none', {})
    assert plain.await_args.kwargs['attachments'] == []


def test_attachments_never_ride_to_the_provider():
    """The wire text already embeds the extracted content, so forwarding the
    array would re-send every base64 image on every later turn."""
    msg = {'role': 'user', 'content': 'the prompt surface', 'attachments': ATT, 'source': 'x'}
    stripped = strip_august_message_keys([msg])[0]
    assert 'attachments' not in stripped
    assert 'source' not in stripped
    # Control: the strip is a deny set, not a rewrite — the text survives.
    assert stripped['content'] == 'the prompt surface'
    assert stripped['role'] == 'user'


def test_the_transcript_encoder_still_keeps_attachments():
    """Stripping is wire-only. The same dict must persist the field, or the
    row restores exactly as broken as before the fix."""
    fields = structured_fields({'role': 'user', 'content': 'x', 'attachments': ATT})
    assert fields.get('attachments') == ATT
