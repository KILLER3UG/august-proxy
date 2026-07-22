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
from typing import TYPE_CHECKING, Optional

from app.json_narrowing import as_bool

if TYPE_CHECKING:
    from app.services.gateway.session_bridge import SessionBridge
BYPASS_COMMANDS = {'stop', 'new', 'reset', 'approve', 'deny', 'status'}


@dataclass
class SessionSource:
    platform: str
    chat_id: str
    user_id: str = ''
    thread_id: str = ''
    message_id: str = ''
    chat_type: str = ''


@dataclass
class MessageEvent:
    source: SessionSource
    text: str
    timestamp: str = ''
    raw: object = None

    def getCommand(self) -> str:
        """Return the canonical slash-command name (without leading /), or ''."""
        t = (self.text or '').strip()
        if not t.startswith('/'):
            return ''
        rest = t[1:]
        if not rest:
            return ''
        head = rest.split()[0]
        head = head.split('@')[0]
        return head.lower()


def buildSessionKey(source: SessionSource, *, groupPerUser: bool = True) -> str:
    """Deterministic session key.

    DMs → ``platform:chat_id``; groups → ``platform:chat_id:user_id`` so each
    user in a shared chat gets their own agent session.
    """
    if source.chat_type == 'dm' or not groupPerUser or (not source.user_id):
        return f'{source.platform}:{source.chat_id}'
    return f'{source.platform}:{source.chat_id}:{source.user_id}'


def shouldBypassActiveSession(cmd: str) -> bool:
    return cmd in BYPASS_COMMANDS


class BasePlatformAdapter(ABC):
    """Abstract base for platform adapters."""

    platform: str = 'base'

    def __init__(self, config: dict[str, object] | None = None, bridge: 'SessionBridge | None' = None):
        self.config = config or {}
        self._bridge = bridge
        self._activeSessions: dict[str, asyncio.Task] = {}
        self._pending: dict[str, list[MessageEvent]] = {}

    @abstractmethod
    async def connect(self) -> bool: ...

    @abstractmethod
    async def disconnect(self) -> None: ...

    @abstractmethod
    async def sendMessage(self, chat_id: str, text: str, **kwargs: object) -> None: ...

    @abstractmethod
    async def getChatInfo(self, chat_id: str) -> dict[str, object]: ...

    @abstractmethod
    async def normalize(self, raw: object) -> Optional[MessageEvent]: ...

    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    async def handleIncoming(self, raw: object) -> None:
        """Entry point for an inbound platform payload."""
        event = await self.normalize(raw)
        if event is None:
            return
        await self.dispatch(event)

    async def dispatch(self, event: MessageEvent) -> None:
        sessionKey = buildSessionKey(event.source, groupPerUser=as_bool(self.config.get('groupPerUser'), True))
        cmd = event.getCommand()
        if shouldBypassActiveSession(cmd):
            await self._handleBypassCommand(sessionKey, event, cmd)
            return
        if sessionKey in self._activeSessions:
            task = self._activeSessions[sessionKey]
            if task.done():
                self._activeSessions.pop(sessionKey, None)
            else:
                self._pending.setdefault(sessionKey, []).append(event)
                return
        self._spawnTurn(sessionKey, event)

    def _spawnTurn(self, sessionKey: str, event: MessageEvent) -> None:
        task = asyncio.create_task(self._turnAndDrain(sessionKey, event))
        self._activeSessions[sessionKey] = task

        def _onDone(_task: object) -> None:
            self._activeSessions.pop(sessionKey, None)

        task.add_done_callback(_onDone)

    async def _turnAndDrain(self, sessionKey: str, event: MessageEvent) -> None:
        try:
            await self._turnTask(sessionKey, event)
        except Exception:
            pass
        while True:
            queue = self._pending.get(sessionKey)
            if not queue:
                break
            nxt = queue.pop(0)
            if not queue:
                self._pending.pop(sessionKey, None)
            try:
                await self._turnTask(sessionKey, nxt)
            except Exception:
                continue

    async def _turnTask(self, sessionKey: str, event: MessageEvent) -> None:
        if self._bridge is None:
            return
        try:
            result = await self._bridge.invokeAgent(sessionKey, event.text)
            if result.text and (not result.cancelled):
                await self.sendMessage(event.source.chat_id, result.text)
        except Exception as exc:
            try:
                await self.sendMessage(event.source.chat_id, f'[error] {exc}')
            except Exception:
                pass

    async def _handleBypassCommand(self, sessionKey: str, event: MessageEvent, cmd: str) -> None:
        if self._bridge is None:
            return
        if cmd in {'stop', 'reset'}:
            await self._bridge.cancelRunning(sessionKey)
            await self.sendMessage(event.source.chat_id, 'Stopped.')
        elif cmd == 'new':
            await self._bridge.cancelRunning(sessionKey)
            await self._bridge.resetSession(sessionKey)
            await self.sendMessage(event.source.chat_id, 'New session started.')
        elif cmd == 'status':
            active = sessionKey in self._activeSessions and (not self._activeSessions[sessionKey].done())
            await self.sendMessage(event.source.chat_id, 'active' if active else 'idle')
        elif cmd == 'approve':
            from app.services.workbench import workbench as wb

            sid = self._bridge.getSessionId(sessionKey) if self._bridge else None
            if sid and wb.approveWorkbenchPlan(sid):
                await self.sendMessage(event.source.chat_id, 'Plan approved.')
            else:
                await self.sendMessage(event.source.chat_id, 'No pending plan to approve.')
        elif cmd == 'deny':
            from app.services.workbench import workbench as wb

            sid = self._bridge.getSessionId(sessionKey) if self._bridge else None
            if sid and wb.rejectWorkbenchPlan(sid):
                await self.sendMessage(event.source.chat_id, 'Plan rejected.')
            else:
                await self.sendMessage(event.source.chat_id, 'No pending plan to reject.')
        else:
            await self.sendMessage(event.source.chat_id, f'(command /{cmd} not yet wired)')
