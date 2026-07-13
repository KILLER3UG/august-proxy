"""Bridge gateway sessions to the workbench agent loop.

Maps a gateway ``session_key`` (e.g. ``telegram:12345``) to a workbench
session id, invokes ``sendWorkbenchMessageStream`` (the same entry the
REST ``POST /api/workbench/chat`` uses — ``routers/workbench.py:127``), and
accumulates the assistant reply from ``final_output`` events.

The workbench runner, session factory, and delete fn are injectable so the
bridge is unit-testable without touching real workbench state.
"""

from __future__ import annotations
import asyncio
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable
from app.json_narrowing import as_str
from app.atomic_write import write_json_atomic

log = logging.getLogger(__name__)
WorkbenchRunner = Callable[..., Awaitable[None]]
SessionFactory = Callable[..., object]
DeleteSession = Callable[[str], bool]


@dataclass
class TurnResult:
    text: str = ''
    cancelled: bool = False


def _defaultMapPath() -> Path:
    try:
        from app.config import settings

        base = Path(settings.dataDir)
    except Exception:
        base = Path.cwd()
    return base / 'gateway' / 'session_map.json'


def _loadMap(path: Path) -> dict[str, str]:
    try:
        if path.exists():
            data = json.loads(path.read_text('utf-8'))
            return data if isinstance(data, dict) else {}
    except Exception:
        pass
    return {}


def _saveMap(path: Path, mapping: dict[str, str]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(path, mapping, indent=2)
    except Exception as exc:
        log.warning('gateway: could not persist session map: %s', exc)


class SessionBridge:
    """Maps gateway session keys to workbench sessions and runs agent turns."""

    def __init__(
        self,
        *,
        runner: WorkbenchRunner | None = None,
        sessionFactory: SessionFactory | None = None,
        deleteSession: DeleteSession | None = None,
        provider: str = '',
        model: str = '',
        agentId: str = '',
        modelProvider: str = '',
        guardMode: str = 'full',
        mapPath: Path | None = None,
    ) -> None:
        from app.services.workbench import workbench as wb

        self._runner = runner or wb.sendWorkbenchMessageStream
        self._sessionFactory = sessionFactory or wb.createWorkbenchSession
        self._deleteSession = deleteSession or wb.deleteWorkbenchSession
        self._provider = provider
        self._model = model
        self._agentId = agentId
        self._modelProvider = modelProvider
        self._guardMode = guardMode
        self._mapPath = mapPath or _defaultMapPath()
        self._map: dict[str, str] = _loadMap(self._mapPath)
        self._cancels: dict[str, asyncio.Event] = {}

    def sessionIdFor(self, sessionKey: str) -> str:
        """Resolve (creating on first contact) the workbench session id."""
        sid = self._map.get(sessionKey)
        if not sid:
            session = self._sessionFactory(provider=self._provider, agentId=self._agentId, guardMode=self._guardMode)
            sid = getattr(session, 'id', None) or str(session)
            self._map[sessionKey] = sid
            _saveMap(self._mapPath, self._map)
        return sid

    def getSessionId(self, sessionKey: str) -> str | None:
        """Return the mapped workbench session id, or None if never mapped."""
        return self._map.get(sessionKey)

    async def invokeAgent(
        self, sessionKey: str, text: str, *, onEvent: Callable[[dict[str, object]], None] | None = None
    ) -> TurnResult:
        """Run one agent turn for the session; return accumulated reply text."""
        sessionId = self.sessionIdFor(sessionKey)
        cancel = asyncio.Event()
        self._cancels[sessionKey] = cancel
        parts: list[str] = []

        def emit(event: dict[str, object]) -> None:
            if event.get('type') == 'final_output' and event.get('content'):
                parts.append(as_str(event['content']))
            if onEvent:
                try:
                    onEvent(event)
                except Exception:
                    pass

        try:
            await self._runner(
                sessionId=sessionId,
                message=text,
                provider=self._provider,
                agentId=self._agentId,
                model=self._model,
                modelProvider=self._modelProvider,
                guardMode=self._guardMode,
                emit=emit,
                signal=cancel,
            )
        finally:
            self._cancels.pop(sessionKey, None)
        return TurnResult(text=''.join(parts), cancelled=cancel.is_set())

    async def cancelRunning(self, sessionKey: str) -> None:
        ev = self._cancels.get(sessionKey)
        if ev and (not ev.is_set()):
            ev.set()

    async def resetSession(self, sessionKey: str) -> None:
        """Cancel any running turn and drop the session mapping (next msg = fresh)."""
        await self.cancelRunning(sessionKey)
        sid = self._map.pop(sessionKey, None)
        if sid:
            _saveMap(self._mapPath, self._map)
            try:
                self._deleteSession(sid)
            except Exception as exc:
                log.warning('gateway: could not delete workbench session %s: %s', sid, exc)
