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
from typing import Optional
from app.jsonUtils import as_str, as_dict, as_list, as_int
from app.services.gateway.base import BasePlatformAdapter, MessageEvent, SessionSource
log = logging.getLogger(__name__)
_TELEGRAMApi = 'https://api.telegram.org/bot'
_TIMEOUT = 30

class TelegramAdapter(BasePlatformAdapter):
    """Telegram bot adapter — inbound via webhook, outbound via sendMessage."""
    platform = 'telegram'

    def __init__(self, config: dict[str, object] | None=None, bridge=None):
        super().__init__(config, bridge)
        self._token: str = os.environ.get('AUGUST_TELEGRAM_BOT_TOKEN', '')
        self._client: httpx.AsyncClient | None = None
        self._pollTask: asyncio.Task | None = None

    def _apiUrl(self, method: str) -> str:
        return f'{_TELEGRAMApi}{self._token}/{method}'

    async def _request(self, method: str, **kwargs: object) -> dict[str, object]:
        """Make a Bot API request and return the JSON result dict."""
        if self._client is None:
            return {'ok': False, 'description': 'Client not connected'}
        try:
            r = await self._client.post(self._apiUrl(method), json=kwargs, timeout=_TIMEOUT)
            return r.json()
        except Exception as exc:
            log.warning('telegram: %s failed: %s', method, exc)
            return {'ok': False, 'description': str(exc)}

    async def connect(self) -> bool:
        if not self._token:
            log.error('telegram: AUGUST_TELEGRAM_BOT_TOKEN not set')
            return False
        import httpx
        self._client = httpx.AsyncClient()
        me = await self._request('getMe')
        if not me.get('ok'):
            log.error('telegram: getMe failed: %s', as_str(me.get('description')))
            await self.disconnect()
            return False
        log.info('telegram: connected as @%s', as_str(as_dict(me.get('result'), {}).get('username'), '?'))
        return True

    async def disconnect(self) -> None:
        if self._pollTask:
            self._pollTask.cancel()
            self._pollTask = None
        if self._client:
            await self._client.aclose()
            self._client = None

    async def start(self) -> None:
        """Optionally set the webhook; if no base_url configured, start polling."""
        baseUrl = as_str(self.config.get('baseUrl'), '')
        webhookPath = as_str(self.config.get('webhook_path'), '/api/gateway/telegram/webhook')
        if baseUrl:
            webhookUrl = f"{baseUrl.rstrip('/')}/{webhookPath.lstrip('/')}"
            r = await self._request('setWebhook', url=webhookUrl)
            if r.get('ok'):
                log.info('telegram: webhook set to %s', webhookUrl)
            else:
                log.warning('telegram: setWebhook failed: %s', as_str(r.get('description')))
        else:
            self._pollTask = asyncio.create_task(self._pollLoop())

    async def stop(self) -> None:
        if self._pollTask:
            self._pollTask.cancel()
            self._pollTask = None

    async def _pollLoop(self) -> None:
        """Simple long-poll dev fallback (offset-based)."""
        offset = 0
        maxRetries = 5
        retries = 0
        while True:
            try:
                r = await self._request('getUpdates', offset=offset, timeout=30)
                if r.get('ok'):
                    for update in as_list(r.get('result'), []):
                        await self.handleIncoming(update)
                        offset = as_int(update.get('update_id'), offset) + 1
                    retries = 0
                else:
                    retries += 1
            except asyncio.CancelledError:
                break
            except Exception as exc:
                retries += 1
                log.warning('telegram: poll error: %s', exc)
            if retries >= maxRetries:
                log.error('telegram: too many poll failures, stopping')
                break
            await asyncio.sleep(1.0)

    async def sendMessage(self, chatId: str, text: str, **kwargs: object) -> None:
        params = {'chat_id': chatId, 'text': text}
        if kwargs.get('reply_to_message_id'):
            params['reply_to_message_id'] = kwargs['reply_to_message_id']
        if kwargs.get('message_thread_id'):
            params['message_thread_id'] = kwargs['message_thread_id']
        if kwargs.get('parse_mode'):
            params['parse_mode'] = kwargs['parse_mode']
        await self._request('sendMessage', **params)

    async def getChatInfo(self, chatId: str) -> dict[str, object]:
        r = await self._request('getChat', chat_id=chatId)
        return as_dict(r.get('result'), {}) if r.get('ok') else {'name': str(chatId), 'type': 'dm'}

    async def normalize(self, raw: dict[str, object]) -> Optional[MessageEvent]:
        """Convert a Telegram webhook update dict into a MessageEvent."""
        message = as_dict(raw.get('message')) or as_dict(raw.get('edited_message'))
        if not message:
            return None
        text = as_str(message.get('text'), '')
        if not text:
            return None
        chat = as_dict(message.get('chat'), {})
        _from = as_dict(message.get('from'), {})
        return MessageEvent(source=SessionSource(platform='telegram', chatId=as_str(chat.get('id'), ''), userId=as_str(_from.get('id'), ''), threadId=as_str(message.get('message_thread_id'), ''), messageId=as_str(message.get('message_id'), ''), chatType=as_str(chat.get('type'), 'dm')), text=text, raw=raw)
