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
from typing import Optional

import discord

from app.services.gateway.base import BasePlatformAdapter, MessageEvent, SessionSource

log = logging.getLogger(__name__)


class DiscordAdapter(BasePlatformAdapter):
    """Discord bot adapter — inbound via gateway events, outbound via HTTP."""

    platform = 'discord'

    def __init__(self, config: dict[str, object] | None = None, bridge=None):
        super().__init__(config, bridge)
        self._token: str = os.environ.get('AUGUST_DISCORD_BOT_TOKEN', '')
        self._client: discord.Client | None = None
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
            client = discord.Client(intents=intents)
            self._client = client

            @client.event
            async def onReady():
                log.info('discord: connected as %s', client.user or '?')
                self._ready.set()

            @client.event
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
        if self._client is None:
            return
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

    async def sendMessage(self, chat_id: str, text: str, **kwargs: object) -> None:
        if self._client is None:
            log.warning('discord: cannot send, client not connected')
            return
        try:
            channel = await self._fetchChannel(chat_id)
            if channel:
                await channel.send(text)
        except Exception as exc:
            log.warning('discord: send_message failed: %s', exc)

    async def _fetchChannel(self, chat_id: str):
        """Fetch a channel by ID (runs in executor for thread safety)."""
        if self._client is None:
            return None

        loop = asyncio.get_event_loop()
        client = self._client
        try:
            return await loop.run_in_executor(None, lambda: client.get_channel(int(chat_id)))
        except (ValueError, AttributeError):
            pass
        try:
            return await self._client.fetch_channel(int(chat_id))
        except Exception:
            return None

    async def getChatInfo(self, chat_id: str) -> dict[str, object]:
        channel = await self._fetchChannel(chat_id)
        if channel is None:
            return {'name': chat_id, 'type': 'dm'}
        chat_type = 'dm' if isinstance(channel, discord.DMChannel) else 'channel'
        return {'name': getattr(channel, 'name', str(chat_id)), 'type': chat_type}

    async def normalize(self, raw: object) -> Optional[MessageEvent]:
        """Convert a Discord on_message event into a MessageEvent."""
        if not isinstance(raw, dict):
            return None
        import discord

        message: discord.Message = raw.get('message')
        if message is None:
            return None
        text = message.content
        if not text:
            return None
        channel = message.channel
        chat_type = 'dm' if isinstance(channel, discord.DMChannel) else 'channel'
        return MessageEvent(
            source=SessionSource(
                platform='discord',
                chat_id=str(channel.id) if channel else '',
                user_id=str(message.author.id),
                thread_id=str(message.id),
                message_id=str(message.id),
                chat_type=chat_type,
            ),
            text=text,
            timestamp=message.created_at.isoformat() if message.created_at else '',
            raw=raw,
        )
