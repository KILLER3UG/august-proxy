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
from typing import Any, Optional

from app.services.gateway.base import (
    BasePlatformAdapter,
    MessageEvent,
    SessionSource,
)

log = logging.getLogger(__name__)


class SlackAdapter(BasePlatformAdapter):
    """Slack bot adapter — inbound via Socket Mode, outbound via Web API."""

    platform = "slack"

    def __init__(self, config: dict[str, Any] | None = None, bridge=None):
        super().__init__(config, bridge)
        self._bot_token: str = os.environ.get("AUGUST_SLACK_BOT_TOKEN", "")
        self._app_token: str = os.environ.get("AUGUST_SLACK_APP_TOKEN", "")
        self._client = None  # slack_sdk.WebClient
        self._socket_client = None  # SocketModeClient
        self._listener_task: asyncio.Task | None = None

    # ── lifecycle ─────────────────────────────────────────────────────

    async def connect(self) -> bool:
        if not self._bot_token:
            log.error("slack: AUGUST_SLACK_BOT_TOKEN not set")
            return False
        if not self._app_token:
            log.error("slack: AUGUST_SLACK_APP_TOKEN not set (required for Socket Mode)")
            return False

        try:
            from slack_sdk import WebClient
            from slack_sdk.socket_mode import SocketModeClient
            from slack_sdk.socket_mode.request import SocketModeRequest

            self._client = WebClient(token=self._bot_token)
            self._socket_client = SocketModeClient(
                app_token=self._app_token,
                web_client=self._client,
            )

            # Register message handler
            async def _on_message(client, request: SocketModeRequest) -> None:
                if request.type == "events_api":
                    payload = request.payload
                    event = payload.get("event", {})
                    if event.get("type") == "message" and "text" in event:
                        # Ignore bot's own messages
                        if event.get("bot_id") or event.get("subtype") == "bot_message":
                            return
                        await self.handle_incoming({
                            "event": event,
                            "team_id": payload.get("team_id", ""),
                            "api_app_id": payload.get("api_app_id", ""),
                        })

            self._socket_client.socket_mode_request_listeners.append(_on_message)

            # Test connection with auth.test
            auth = await asyncio.get_event_loop().run_in_executor(
                None, lambda: self._client.auth_test()
            )
            log.info("slack: connected as %s", auth.get("user", "?"))

            return True
        except ImportError:
            log.error("slack: slack_sdk not installed (run: pip install slack_sdk)")
            return False
        except Exception as exc:
            log.error("slack: connect failed: %s", exc)
            return False

    async def disconnect(self) -> None:
        if self._listener_task:
            self._listener_task.cancel()
            self._listener_task = None
        if self._socket_client:
            try:
                self._socket_client.close()
            except Exception:
                pass
            self._socket_client = None
        self._client = None

    async def start(self) -> None:
        """Start the Socket Mode listener in a background thread."""
        if self._socket_client is None:
            return

        loop = asyncio.get_event_loop()
        self._listener_task = asyncio.create_task(
            self._run_socket_client()
        )

    async def _run_socket_client(self) -> None:
        """Run the Socket Mode client in a thread executor (it's blocking)."""
        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(
                None, lambda: self._socket_client.connect()
            )
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            log.error("slack: socket client error: %s", exc)

    async def stop(self) -> None:
        if self._listener_task:
            self._listener_task.cancel()
            self._listener_task = None

    # ── messaging ─────────────────────────────────────────────────────

    async def send_message(self, chat_id: str, text: str, **kwargs: Any) -> None:
        if self._client is None:
            log.warning("slack: cannot send, client not connected")
            return
        try:
            await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: self._client.chat_postMessage(
                    channel=chat_id,
                    text=text,
                    **{k: v for k, v in kwargs.items() if k in ("thread_ts",)},
                ),
            )
        except Exception as exc:
            log.warning("slack: send_message failed: %s", exc)

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        if self._client is None:
            return {"name": chat_id, "type": "dm"}
        try:
            info = await asyncio.get_event_loop().run_in_executor(
                None, lambda: self._client.conversations_info(channel=chat_id)
            )
            channel = info.get("channel", {})
            return {
                "name": channel.get("name", chat_id),
                "type": channel.get("is_im", False) and "dm" or "channel",
            }
        except Exception:
            return {"name": chat_id, "type": "dm"}

    # ── incoming normalization ────────────────────────────────────────

    async def normalize(self, raw: dict[str, Any]) -> Optional[MessageEvent]:
        """Convert a Slack Socket Mode payload into a MessageEvent."""
        event = raw.get("event", {})
        text = event.get("text", "")
        if not text:
            return None

        channel = event.get("channel", "")
        user = event.get("user", "")
        thread_ts = event.get("thread_ts", event.get("ts", ""))
        channel_type = event.get("channel_type", "im")

        # Map Slack channel types
        chat_type_map = {
            "im": "dm",
            "group": "group",
            "channel": "channel",
            "mpim": "group",
        }
        chat_type = chat_type_map.get(channel_type, "dm")

        return MessageEvent(
            source=SessionSource(
                platform="slack",
                chat_id=channel,
                user_id=user,
                thread_id=thread_ts,
                message_id=event.get("ts", ""),
                chat_type=chat_type,
            ),
            text=text,
            raw=raw,
        )
