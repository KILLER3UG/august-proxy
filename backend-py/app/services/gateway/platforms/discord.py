"""Discord adapter for the gateway (bot gateway).

Reads the bot token from the ``AUGUST_DISCORD_BOT_TOKEN`` env var.

Configuration lives in ``data/config.json`` under
``gateway.platforms.discord``:

.. code:: json

    {
      "gateway": {
        "enabled": true,
        "platforms": {
          "discord": {
            "enabled": true
          }
        }
      }
    }

Requires ``discord.py`` (``pip install discord.py``) and a Bot Token
with ``Message Content Intent`` enabled in the Discord Developer Portal.
"""
from __future__ import annotations
import asyncio
import logging
import os
from typing import Any, Optional
from app.services.gateway.base import BasePlatformAdapter, MessageEvent, SessionSource
log = logging.getLogger(__name__)

class DiscordAdapter(BasePlatformAdapter):
    """Discord bot adapter — inbound via gateway events, outbound via HTTP."""
    platform = 'discord'

    def __init__(self, config: dict[str, Any] | None=None, bridge=None):
        super().__init__(config, bridge)
        self._token: str = os.environ.get('AUGUST_DISCORD_BOT_TOKEN', '')
        self._client = None
        self._ready = asyncio.Event()
        self._listenerTask: asyncio.Task | None = None

    async def connect(self) -> bool:
        if not self._token:
            log.error('discord: AUGUST_DISCORD_BOT_TOKEN not set')
            return False
        try:
            import discord
            import discord.client
            intents = discord.Intents.default()
            intents.message_content = True
            self._client = discord.Client(intents=intents)

            @self._client.event
            async def onReady():
                log.info('discord: connected as %s', self._client.user or '?')
                self._ready.set()

            @self._client.event
            async def onMessage(message):
                if message.author.bot:
                    return
                await self.handleIncoming({'message': message})
            return True
        except ImportError:
            log.error('discord: discord.py not installed (run: pip install discord.py)')
            return False
        except Exception as exc:
            log.error('discord: connect failed: %s', exc)
            return False

    async def disconnect(self) -> None:
        if self._client:
            try:
                await self._client.close()
            except Exception:
                pass
            self._client = None

    async def start(self) -> None:
        """Start the Discord client in a background task."""
        if self._client is None:
            return
        self._listenerTask = asyncio.create_task(self._runClient())
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=30.0)
        except asyncio.TimeoutError:
            log.warning('discord: client not ready within 30s')

    async def _runClient(self) -> None:
        """Run the Discord client via client.start() coroutine."""
        try:
            await self._client.start(self._token)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            log.error('discord: client error: %s', exc)

    async def stop(self) -> None:
        if self._listenerTask:
            self._listenerTask.cancel()
            self._listenerTask = None

    async def sendMessage(self, chatId: str, text: str, **kwargs: Any) -> None:
        if self._client is None:
            log.warning('discord: cannot send, client not connected')
            return
        try:
            channel = await self._fetchChannel(chatId)
            if channel:
                await channel.send(text)
        except Exception as exc:
            log.warning('discord: send_message failed: %s', exc)

    async def _fetchChannel(self, chatId: str):
        """Fetch a channel by ID (runs in executor for thread safety)."""
        import discord
        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, lambda: self._client.get_channel(int(chatId)))
        except (ValueError, AttributeError):
            pass
        try:
            return await self._client.fetch_channel(int(chatId))
        except Exception:
            return None

    async def getChatInfo(self, chatId: str) -> dict[str, Any]:
        channel = await self._fetchChannel(chatId)
        if channel is None:
            return {'name': chatId, 'type': 'dm'}
        chatType = 'dm' if isinstance(channel, discord.DMChannel) else 'channel'
        return {'name': getattr(channel, 'name', str(chatId)), 'type': chatType}

    async def normalize(self, raw: dict[str, Any]) -> Optional[MessageEvent]:
        """Convert a Discord on_message event into a MessageEvent."""
        import discord
        message: discord.Message = raw.get('message')
        if message is None:
            return None
        text = message.content
        if not text:
            return None
        channel = message.channel
        chatType = 'dm' if isinstance(channel, discord.DMChannel) else 'channel'
        return MessageEvent(source=SessionSource(platform='discord', chat_id=str(channel.id) if channel else '', user_id=str(message.author.id), thread_id=str(message.id), message_id=str(message.id), chat_type=chatType), text=text, timestamp=message.created_at.isoformat() if message.created_at else '', raw=raw)