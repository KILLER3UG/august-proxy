"""Slack adapter for the gateway (Socket Mode).

Reads the bot token from the ``AUGUST_SLACK_BOT_TOKEN`` env var and the
app-level token from ``AUGUST_SLACK_APP_TOKEN`` (required for Socket Mode).

Configuration lives in ``data/config.json`` under
``gateway.platforms.slack``:

.. code:: json

    {
      "gateway": {
        "enabled": true,
        "platforms": {
          "slack": {
            "enabled": true
          }
        }
      }
    }

Socket Mode requires an App-Level Token with ``connections:write`` scope
and a Bot Token with ``chat:write``, ``channels:history``, ``groups:history``,
``im:history``, ``mpim:history`` scopes.
"""
from __future__ import annotations
import asyncio
import logging
import os
from typing import Optional
from app.jsonUtils import as_str, as_dict
from app.services.gateway.base import BasePlatformAdapter, MessageEvent, SessionSource
log = logging.getLogger(__name__)

class SlackAdapter(BasePlatformAdapter):
    """Slack bot adapter — inbound via Socket Mode, outbound via Web API."""
    platform = 'slack'

    def __init__(self, config: dict[str, object] | None=None, bridge=None):
        super().__init__(config, bridge)
        self._botToken: str = os.environ.get('AUGUST_SLACK_BOT_TOKEN', '')
        self._appToken: str = os.environ.get('AUGUST_SLACK_APP_TOKEN', '')
        self._client = None
        self._socketClient = None
        self._listenerTask: asyncio.Task | None = None

    async def connect(self) -> bool:
        if not self._botToken:
            log.error('slack: AUGUST_SLACK_BOT_TOKEN not set')
            return False
        if not self._appToken:
            log.error('slack: AUGUST_SLACK_APP_TOKEN not set (required for Socket Mode)')
            return False
        try:
            from slack_sdk import WebClient
            from slack_sdk.socket_mode import SocketModeClient
            from slack_sdk.socket_mode.request import SocketModeRequest
            self._client = WebClient(token=self._botToken)
            self._socketClient = SocketModeClient(app_token=self._appToken, web_client=self._client)

            async def _onMessage(client, request: SocketModeRequest) -> None:
                if request.type == 'events_api':
                    payload = request.payload
                    event = as_dict(payload.get('event'), {})
                    if as_str(event.get('type')) == 'message' and 'text' in event:
                        if as_str(event.get('bot_id')) or as_str(event.get('subtype')) == 'bot_message':
                            return
                        await self.handleIncoming({'event': event, 'team_id': as_str(payload.get('team_id'), ''), 'api_app_id': as_str(payload.get('api_app_id'), '')})
            self._socketClient.socket_mode_request_listeners.append(_onMessage)
            auth = await asyncio.get_event_loop().run_in_executor(None, lambda: self._client.auth_test())
            log.info('slack: connected as %s', as_str(auth.get('user'), '?'))
            return True
        except ImportError:
            log.error('slack: slack_sdk not installed (run: pip install slack_sdk)')
            return False
        except Exception as exc:
            log.error('slack: connect failed: %s', exc)
            return False

    async def disconnect(self) -> None:
        if self._listenerTask:
            self._listenerTask.cancel()
            self._listenerTask = None
        if self._socketClient:
            try:
                self._socketClient.close()
            except Exception:
                pass
            self._socketClient = None
        self._client = None

    async def start(self) -> None:
        """Start the Socket Mode listener in a background thread."""
        if self._socketClient is None:
            return
        loop = asyncio.get_event_loop()
        self._listenerTask = asyncio.create_task(self._runSocketClient())

    async def _runSocketClient(self) -> None:
        """Run the Socket Mode client in a thread executor (it's blocking)."""
        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(None, lambda: self._socketClient.connect())
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            log.error('slack: socket client error: %s', exc)

    async def stop(self) -> None:
        if self._listenerTask:
            self._listenerTask.cancel()
            self._listenerTask = None

    async def sendMessage(self, chatId: str, text: str, **kwargs: object) -> None:
        if self._client is None:
            log.warning('slack: cannot send, client not connected')
            return
        try:
            await asyncio.get_event_loop().run_in_executor(None, lambda: self._client.chat_postMessage(channel=chatId, text=text, **{k: v for k, v in kwargs.items() if k in ('thread_ts',)}))
        except Exception as exc:
            log.warning('slack: send_message failed: %s', exc)

    async def getChatInfo(self, chatId: str) -> dict[str, object]:
        if self._client is None:
            return {'name': chatId, 'type': 'dm'}
        try:
            info = await asyncio.get_event_loop().run_in_executor(None, lambda: self._client.conversations_info(channel=chatId))
            channel = as_dict(info.get('channel'), {})
            return {'name': as_str(channel.get('name'), chatId), 'type': channel.get('is_im', False) and 'dm' or 'channel'}
        except Exception:
            return {'name': chatId, 'type': 'dm'}

    async def normalize(self, raw: dict[str, object]) -> Optional[MessageEvent]:
        """Convert a Slack Socket Mode payload into a MessageEvent."""
        event = as_dict(raw.get('event'), {})
        text = as_str(event.get('text'), '')
        if not text:
            return None
        channel = as_str(event.get('channel'), '')
        user = as_str(event.get('user'), '')
        threadTs = as_str(event.get('thread_ts'), as_str(event.get('ts'), ''))
        channelType = as_str(event.get('channel_type'), 'im')
        chatTypeMap = {'im': 'dm', 'group': 'group', 'channel': 'channel', 'mpim': 'group'}
        chatType = chatTypeMap.get(channelType, 'dm')
        return MessageEvent(source=SessionSource(platform='slack', chat_id=channel, user_id=user, thread_id=threadTs, message_id=as_str(event.get('ts'), ''), chat_type=chatType), text=text, raw=raw)
