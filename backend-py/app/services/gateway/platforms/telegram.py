"""Telegram adapter for the gateway (webhook mode).

Reads the bot token from the ``AUGUST_TELEGRAM_BOT_TOKEN`` env var (secret,
never in config).  Configuration lives in ``data/config.json`` under
``gateway.platforms.telegram``:

.. code:: json

    {
      "gateway": {
        "enabled": true,
        "platforms": {
          "telegram": {
            "enabled": true,
            "webhook_path": "/api/gateway/telegram/webhook"
          }
        }
      }
    }

The webhook URL is set by calling ``setWebhook`` when the adapter ``start()``-s
if a ``base_url`` is provided in config (your server's public HTTPS URL).
For local dev, set the webhook manually via the Bot API or use polling.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Optional

from app.services.gateway.base import (
    BasePlatformAdapter,
    MessageEvent,
    SessionSource,
)

log = logging.getLogger(__name__)

_TELEGRAM_API = "https://api.telegram.org/bot"
_TIMEOUT = 30  # seconds for Bot API calls


class TelegramAdapter(BasePlatformAdapter):
    """Telegram bot adapter — inbound via webhook, outbound via sendMessage."""

    platform = "telegram"

    def __init__(self, config: dict[str, Any] | None = None, bridge=None):
        super().__init__(config, bridge)
        self._token: str = os.environ.get("AUGUST_TELEGRAM_BOT_TOKEN", "")
        self._client: httpx.AsyncClient | None = None
        self._poll_task: asyncio.Task | None = None

    # ── helpers ───────────────────────────────────────────────────────

    def _api_url(self, method: str) -> str:
        return f"{_TELEGRAM_API}{self._token}/{method}"

    async def _request(self, method: str, **kwargs: Any) -> dict[str, Any]:
        """Make a Bot API request and return the JSON result dict."""
        if self._client is None:
            return {"ok": False, "description": "Client not connected"}
        try:
            r = await self._client.post(self._api_url(method), json=kwargs, timeout=_TIMEOUT)
            return r.json()
        except Exception as exc:
            log.warning("telegram: %s failed: %s", method, exc)
            return {"ok": False, "description": str(exc)}

    # ── lifecycle ─────────────────────────────────────────────────────

    async def connect(self) -> bool:
        if not self._token:
            log.error("telegram: AUGUST_TELEGRAM_BOT_TOKEN not set")
            return False
        import httpx
        self._client = httpx.AsyncClient()
        me = await self._request("getMe")
        if not me.get("ok"):
            log.error("telegram: getMe failed: %s", me.get("description"))
            await self.disconnect()
            return False
        log.info("telegram: connected as @%s", me.get("result", {}).get("username", "?"))
        return True

    async def disconnect(self) -> None:
        if self._poll_task:
            self._poll_task.cancel()
            self._poll_task = None
        if self._client:
            await self._client.aclose()
            self._client = None

    async def start(self) -> None:
        """Optionally set the webhook; if no base_url configured, start polling."""
        base_url = self.config.get("base_url", "")
        webhook_path = self.config.get("webhook_path", "/api/gateway/telegram/webhook")
        if base_url:
            webhook_url = f"{base_url.rstrip('/')}/{webhook_path.lstrip('/')}"
            r = await self._request("setWebhook", url=webhook_url)
            if r.get("ok"):
                log.info("telegram: webhook set to %s", webhook_url)
            else:
                log.warning("telegram: setWebhook failed: %s", r.get("description"))
        else:
            # Fallback to long-polling for dev
            self._poll_task = asyncio.create_task(self._poll_loop())

    async def stop(self) -> None:
        if self._poll_task:
            self._poll_task.cancel()
            self._poll_task = None

    async def _poll_loop(self) -> None:
        """Simple long-poll dev fallback (offset-based)."""
        offset = 0
        max_retries = 5
        retries = 0
        while True:
            try:
                r = await self._request("getUpdates", offset=offset, timeout=30)
                if r.get("ok"):
                    for update in r.get("result", []):
                        await self.handle_incoming(update)
                        offset = update.get("update_id", offset) + 1
                    retries = 0
                else:
                    retries += 1
            except asyncio.CancelledError:
                break
            except Exception as exc:
                retries += 1
                log.warning("telegram: poll error: %s", exc)
            if retries >= max_retries:
                log.error("telegram: too many poll failures, stopping")
                break
            await asyncio.sleep(1.0)

    # ── messaging ─────────────────────────────────────────────────────

    async def send_message(self, chat_id: str, text: str, **kwargs: Any) -> None:
        params = {"chat_id": chat_id, "text": text}
        if kwargs.get("reply_to_message_id"):
            params["reply_to_message_id"] = kwargs["reply_to_message_id"]
        if kwargs.get("message_thread_id"):
            params["message_thread_id"] = kwargs["message_thread_id"]
        if kwargs.get("parse_mode"):
            params["parse_mode"] = kwargs["parse_mode"]
        await self._request("sendMessage", **params)

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        r = await self._request("getChat", chat_id=chat_id)
        return r.get("result", {}) if r.get("ok") else {"name": str(chat_id), "type": "dm"}

    # ── incoming normalization ────────────────────────────────────────

    async def normalize(self, raw: dict[str, Any]) -> Optional[MessageEvent]:
        """Convert a Telegram webhook update dict into a MessageEvent."""
        message = raw.get("message") or raw.get("edited_message")
        if not message:
            return None
        text = message.get("text", "")
        if not text:
            return None
        chat = message.get("chat", {})
        _from = message.get("from", {})
        return MessageEvent(
            source=SessionSource(
                platform="telegram",
                chat_id=str(chat.get("id", "")),
                user_id=str(_from.get("id", "")),
                thread_id=str(message.get("message_thread_id", "")),
                message_id=str(message.get("message_id", "")),
                chat_type=chat.get("type", "dm"),
            ),
            text=text,
            raw=raw,
        )
