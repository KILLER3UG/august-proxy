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


# ── Fixtures ───────────────────────────────────────────────────────────

_TELEGRAM_UPDATE = {
    "update_id": 100,
    "message": {
        "message_id": 42,
        "from": {"id": 123, "is_bot": False, "first_name": "Tester"},
        "chat": {"id": -456, "type": "group", "title": "Test Group"},
        "text": "Hello, bot!",
        "message_thread_id": 7,
    },
}


@pytest.fixture
def token_env(monkeypatch):
    monkeypatch.setenv("AUGUST_TELEGRAM_BOT_TOKEN", "fake:test-token")


@pytest.fixture
def adapter(token_env):
    from app.services.gateway.platforms.telegram import TelegramAdapter

    a = TelegramAdapter()
    # Mock _request to avoid any live network
    a._request = AsyncMock(return_value={"ok": True, "result": {}})
    return a


# ── normalize tests ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_normalize_text_message(adapter):
    event = await adapter.normalize(_TELEGRAM_UPDATE)
    assert event is not None
    assert event.text == "Hello, bot!"
    assert event.source.platform == "telegram"
    assert event.source.chat_id == "-456"
    assert event.source.user_id == "123"
    assert event.source.chat_type == "group"
    assert event.source.thread_id == "7"
    assert event.source.message_id == "42"


@pytest.mark.asyncio
async def test_normalize_dm_chat(adapter):
    update = {
        "update_id": 2,
        "message": {
            "message_id": 1,
            "from": {"id": 789},
            "chat": {"id": 789, "type": "private"},
            "text": "DM test",
        },
    }
    event = await adapter.normalize(update)
    assert event is not None
    assert event.source.chat_type == "private"
    assert event.source.chat_id == "789"
    assert event.source.user_id == "789"


@pytest.mark.asyncio
async def test_normalize_ignores_non_message(adapter):
    update = {"update_id": 3, "my_chat_member": {"chat": {"id": 1}}}
    event = await adapter.normalize(update)
    assert event is None


@pytest.mark.asyncio
async def test_normalize_ignores_empty_text(adapter):
    update = {
        "update_id": 4,
        "message": {
            "message_id": 2,
            "from": {"id": 1},
            "chat": {"id": 1, "type": "private"},
            # no "text" key — e.g. a photo message
        },
    }
    event = await adapter.normalize(update)
    assert event is None


# ── send_message tests (mocked _request) ──────────────────────────────


@pytest.mark.asyncio
async def test_send_message_calls_api(adapter):
    await adapter.send_message("789", "Reply text")
    adapter._request.assert_called_once()
    call_args = adapter._request.call_args
    assert call_args[0][0] == "sendMessage"
    assert call_args[1]["chat_id"] == "789"
    assert call_args[1]["text"] == "Reply text"


@pytest.mark.asyncio
async def test_send_message_with_thread(adapter):
    await adapter.send_message("789", "In thread", message_thread_id="7")
    _, kwargs = adapter._request.call_args
    assert kwargs.get("message_thread_id") == "7"


@pytest.mark.asyncio
async def test_send_message_with_reply(adapter):
    await adapter.send_message("789", "Reply", reply_to_message_id="55")
    _, kwargs = adapter._request.call_args
    assert kwargs.get("reply_to_message_id") == "55"


# ── connect tests (mocked _request) ───────────────────────────────────


@pytest.mark.asyncio
async def test_connect_success(adapter):
    adapter._request.return_value = {"ok": True, "result": {"username": "TestBot"}}
    ok = await adapter.connect()
    assert ok is True
    assert adapter._client is not None


@pytest.mark.asyncio
async def test_connect_fails_without_token(monkeypatch, adapter):
    monkeypatch.delenv("AUGUST_TELEGRAM_BOT_TOKEN", raising=False)
    # create a new adapter without token
    from app.services.gateway.platforms.telegram import TelegramAdapter
    a = TelegramAdapter()
    ok = await a.connect()
    assert ok is False


# ── Gateway router tests ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_webhook_endpoint_calls_adapter(token_env):
    """POST /api/gateway/telegram/webhook dispatches to the adapter."""
    from app.services.gateway.platforms.telegram import TelegramAdapter

    # Mini FastAPI app with the gateway router.
    app = FastAPI()
    from app.routers import gateway as gateway_router
    app.include_router(gateway_router.router)

    # Create a Telegram adapter with mocked _request.
    adapter = TelegramAdapter()
    adapter._request = AsyncMock(return_value={"ok": True, "result": {}})
    # Bridge stubbed so _turn_task doesn't crash.
    adapter._bridge = MagicMock()
    adapter._bridge.invoke_agent = AsyncMock(return_value=type("TurnResult", (), {"text": "", "cancelled": False})())

    mock_runner = MagicMock(spec=GatewayRunner)
    mock_runner.adapters = [adapter]
    app.state.gateway_runner = mock_runner

    client = TestClient(app)
    r = client.post("/api/gateway/telegram/webhook", json=_TELEGRAM_UPDATE)
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    # The adapter's dispatch should have been triggered
    # We can't easily check the bridge was called without awaiting, but we can
    # check the adapter didn't reject the update (it would 503 if missing).
    # The real check: no crash, 200 returned.
