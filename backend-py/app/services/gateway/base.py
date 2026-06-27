"""Gateway platform adapter base — ingest-side messaging.

Modeled on Hermes ``gateway/platforms/base.py:2085`` (BasePlatformAdapter) +
``handle_message`` (``base.py:4284``). Two-guard pattern:

  * First guard (here): a 2nd message arriving while a turn is running for the
    same session is queued, not run concurrently — so each platform chat gets
    one in-flight agent turn at a time.
  * Second guard (here + runner): control commands (``/stop`` ``/new``
    ``/reset``) bypass the queue and cancel the running turn before dispatching.

Subclasses implement only the platform-specific bits (connect/disconnect,
normalize an inbound payload, send_message, get_chat_info, start/stop
listeners). ``dispatch`` is concrete here.
"""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.gateway.session_bridge import SessionBridge

# Commands that bypass the active-session queue (second guard).
BYPASS_COMMANDS = {"stop", "new", "reset", "approve", "deny", "status"}


@dataclass
class SessionSource:
    platform: str
    chat_id: str
    user_id: str = ""
    thread_id: str = ""
    message_id: str = ""
    chat_type: str = ""  # "dm" | "group" | "channel"


@dataclass
class MessageEvent:
    source: SessionSource
    text: str
    timestamp: str = ""
    raw: Any = None

    def get_command(self) -> str:
        """Return the canonical slash-command name (without leading /), or ''."""
        t = (self.text or "").strip()
        if not t.startswith("/"):
            return ""
        rest = t[1:]
        if not rest:
            return ""
        head = rest.split()[0]
        head = head.split("@")[0]  # strip Telegram "@botname" suffix
        return head.lower()


def build_session_key(source: SessionSource, *, group_per_user: bool = True) -> str:
    """Deterministic session key.

    DMs → ``platform:chat_id``; groups → ``platform:chat_id:user_id`` so each
    user in a shared chat gets their own agent session.
    """
    if source.chat_type == "dm" or not group_per_user or not source.user_id:
        return f"{source.platform}:{source.chat_id}"
    return f"{source.platform}:{source.chat_id}:{source.user_id}"


def should_bypass_active_session(cmd: str) -> bool:
    return cmd in BYPASS_COMMANDS


class BasePlatformAdapter(ABC):
    """Abstract base for platform adapters."""

    platform: str = "base"

    def __init__(self, config: dict[str, Any] | None = None, bridge: "SessionBridge | None" = None):
        self.config = config or {}
        self._bridge = bridge
        self._active_sessions: dict[str, asyncio.Task] = {}
        self._pending: dict[str, list[MessageEvent]] = {}

    # ── Abstract: platform-specific surface ───────────────────────────

    @abstractmethod
    async def connect(self) -> bool: ...
    @abstractmethod
    async def disconnect(self) -> None: ...
    @abstractmethod
    async def send_message(self, chat_id: str, text: str, **kwargs: Any) -> None: ...
    @abstractmethod
    async def get_chat_info(self, chat_id: str) -> dict[str, Any]: ...
    @abstractmethod
    async def normalize(self, raw: Any) -> Optional[MessageEvent]: ...

    # Default no-ops for polling/webhook listeners; subclasses override.
    async def start(self) -> None: ...
    async def stop(self) -> None: ...

    # ── Concrete: ingest dispatch with both guards ────────────────────

    async def handle_incoming(self, raw: Any) -> None:
        """Entry point for an inbound platform payload."""
        event = await self.normalize(raw)
        if event is None:
            return
        await self.dispatch(event)

    async def dispatch(self, event: MessageEvent) -> None:
        session_key = build_session_key(
            event.source,
            group_per_user=self.config.get("group_per_user", True),
        )
        cmd = event.get_command()

        # Second guard: bypass commands cancel the running turn first.
        if should_bypass_active_session(cmd):
            await self._handle_bypass_command(session_key, event, cmd)
            return

        # Stale-lock self-heal: if an entry exists but its task already
        # finished, clear it and fall through (mirrors Hermes base.py:4313).
        if session_key in self._active_sessions:
            task = self._active_sessions[session_key]
            if task.done():
                self._active_sessions.pop(session_key, None)
            else:
                # First guard: queue while a turn is running for this session.
                self._pending.setdefault(session_key, []).append(event)
                return

        self._spawn_turn(session_key, event)

    def _spawn_turn(self, session_key: str, event: MessageEvent) -> None:
        task = asyncio.create_task(self._turn_and_drain(session_key, event))
        self._active_sessions[session_key] = task
        task.add_done_callback(lambda _t, k=session_key: self._active_sessions.pop(k, None))

    async def _turn_and_drain(self, session_key: str, event: MessageEvent) -> None:
        try:
            await self._turn_task(session_key, event)
        except Exception:
            pass
        # Drain queued messages inline (we are still this session's active task).
        while True:
            queue = self._pending.get(session_key)
            if not queue:
                break
            nxt = queue.pop(0)
            if not queue:
                self._pending.pop(session_key, None)
            try:
                await self._turn_task(session_key, nxt)
            except Exception:
                continue

    async def _turn_task(self, session_key: str, event: MessageEvent) -> None:
        if self._bridge is None:
            return
        try:
            result = await self._bridge.invoke_agent(session_key, event.text)
            if result.text and not result.cancelled:
                await self.send_message(event.source.chat_id, result.text)
        except Exception as exc:
            try:
                await self.send_message(event.source.chat_id, f"[error] {exc}")
            except Exception:
                pass

    async def _handle_bypass_command(self, session_key: str, event: MessageEvent, cmd: str) -> None:
        if self._bridge is None:
            return
        if cmd in {"stop", "reset"}:
            await self._bridge.cancel_running(session_key)
            await self.send_message(event.source.chat_id, "Stopped.")
        elif cmd == "new":
            await self._bridge.cancel_running(session_key)
            await self._bridge.reset_session(session_key)
            await self.send_message(event.source.chat_id, "New session started.")
        elif cmd == "status":
            active = session_key in self._active_sessions and not self._active_sessions[session_key].done()
            await self.send_message(event.source.chat_id, "active" if active else "idle")
        elif cmd == "approve":
            from app.services.workbench import workbench as wb

            sid = self._bridge.get_session_id(session_key) if self._bridge else None
            if sid and wb.approve_workbench_plan(sid):
                await self.send_message(event.source.chat_id, "Plan approved.")
            else:
                await self.send_message(event.source.chat_id, "No pending plan to approve.")
        elif cmd == "deny":
            from app.services.workbench import workbench as wb

            sid = self._bridge.get_session_id(session_key) if self._bridge else None
            if sid and wb.reject_workbench_plan(sid):
                await self.send_message(event.source.chat_id, "Plan rejected.")
            else:
                await self.send_message(event.source.chat_id, "No pending plan to reject.")
        else:
            await self.send_message(event.source.chat_id, f"(command /{cmd} not yet wired)")
