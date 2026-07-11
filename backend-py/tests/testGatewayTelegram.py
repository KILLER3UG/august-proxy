"""Telegram adapter + gateway router tests (A2).

No live network — Telegram adapter ``_request`` is mocked for ``send_message``
and ``connect`` tests; the gateway router is tested via TestClient with a
real adapter that has its Bot API calls stubbed.
"""

from __future__ import annotations
import os
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.services.gateway.base import MessageEvent, SessionSource
from app.services.gateway.runner import GatewayRunner

_TELEGRAMUpdate = {
    'update_id': 100,
    'message': {
        'message_id': 42,
        'from': {'id': 123, 'is_bot': False, 'first_name': 'Tester'},
        'chat': {'id': -456, 'type': 'group', 'title': 'Test Group'},
        'text': 'Hello, bot!',
        'message_thread_id': 7,
    },
}


@pytest.fixture
def tokenEnv(monkeypatch):
    monkeypatch.setenv('AUGUST_TELEGRAM_BOT_TOKEN', 'fake:test-token')


@pytest.fixture
def adapter(tokenEnv):
    from app.services.gateway.platforms.telegram import TelegramAdapter

    a = TelegramAdapter()
    a._request = AsyncMock(return_value={'ok': True, 'result': {}})
    return a


@pytest.mark.asyncio
async def testNormalizeTextMessage(adapter):
    event = await adapter.normalize(_TELEGRAMUpdate)
    assert event is not None
    assert event.text == 'Hello, bot!'
    assert event.source.platform == 'telegram'
    assert event.source.chat_id == '-456'
    assert event.source.user_id == '123'
    assert event.source.chat_type == 'group'
    assert event.source.thread_id == '7'
    assert event.source.message_id == '42'


@pytest.mark.asyncio
async def testNormalizeDmChat(adapter):
    update = {
        'update_id': 2,
        'message': {'message_id': 1, 'from': {'id': 789}, 'chat': {'id': 789, 'type': 'private'}, 'text': 'DM test'},
    }
    event = await adapter.normalize(update)
    assert event is not None
    assert event.source.chat_type == 'private'
    assert event.source.chat_id == '789'
    assert event.source.user_id == '789'


@pytest.mark.asyncio
async def testNormalizeIgnoresNonMessage(adapter):
    update = {'update_id': 3, 'my_chat_member': {'chat': {'id': 1}}}
    event = await adapter.normalize(update)
    assert event is None


@pytest.mark.asyncio
async def testNormalizeIgnoresEmptyText(adapter):
    update = {'update_id': 4, 'message': {'message_id': 2, 'from': {'id': 1}, 'chat': {'id': 1, 'type': 'private'}}}
    event = await adapter.normalize(update)
    assert event is None


@pytest.mark.asyncio
async def testSendMessageCallsApi(adapter):
    await adapter.sendMessage('789', 'Reply text')
    adapter._request.assert_called_once()
    callArgs = adapter._request.call_args
    assert callArgs[0][0] == 'sendMessage'
    assert callArgs[1]['chat_id'] == '789'
    assert callArgs[1]['text'] == 'Reply text'


@pytest.mark.asyncio
async def testSendMessageWithThread(adapter):
    await adapter.sendMessage('789', 'In thread', message_thread_id='7')
    __, kwargs = adapter._request.call_args
    assert kwargs.get('message_thread_id') == '7'


@pytest.mark.asyncio
async def testSendMessageWithReply(adapter):
    await adapter.sendMessage('789', 'Reply', reply_to_message_id='55')
    __, kwargs = adapter._request.call_args
    assert kwargs.get('reply_to_message_id') == '55'


@pytest.mark.asyncio
async def testConnectSuccess(adapter):
    adapter._request.return_value = {'ok': True, 'result': {'username': 'TestBot'}}
    ok = await adapter.connect()
    assert ok is True
    assert adapter._client is not None


@pytest.mark.asyncio
async def testConnectFailsWithoutToken(monkeypatch, adapter):
    monkeypatch.delenv('AUGUST_TELEGRAM_BOT_TOKEN', raising=False)
    from app.services.gateway.platforms.telegram import TelegramAdapter

    a = TelegramAdapter()
    ok = await a.connect()
    assert ok is False


@pytest.mark.asyncio
async def testWebhookEndpointCallsAdapter(tokenEnv):
    """POST /api/gateway/telegram/webhook dispatches to the adapter."""
    from app.services.gateway.platforms.telegram import TelegramAdapter

    app = FastAPI()
    from app.routers import gateway as gatewayRouter

    app.include_router(gatewayRouter.router)
    adapter = TelegramAdapter()
    adapter._request = AsyncMock(return_value={'ok': True, 'result': {}})
    adapter._bridge = MagicMock()
    adapter._bridge.invoke_agent = AsyncMock(return_value=type('TurnResult', (), {'text': '', 'cancelled': False})())
    mockRunner = MagicMock(spec=GatewayRunner)
    mockRunner.adapters = [adapter]
    app.state.gateway_runner = mockRunner
    client = TestClient(app)
    r = client.post('/api/gateway/telegram/webhook', json=_TELEGRAMUpdate)
    assert r.status_code == 200
    assert r.json() == {'ok': True}
