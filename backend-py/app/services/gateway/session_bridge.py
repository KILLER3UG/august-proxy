"""Bridge gateway sessions to the workbench agent loop.

Maps a gateway ``session_key`` (e.g. ``telegram:12345``) to a workbench
session id, invokes ``send_workbench_message_stream`` (the same entry the
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
from typing import Any, Awaitable, Callable, Optional

log = logging.getLogger(__name__)

# Injectable workbench entry: matches wb.send_workbench_message_stream.
WorkbenchRunner = Callable[..., Awaitable[None]]
# Injectable factory returning an object with an ``.id`` attribute.
SessionFactory = Callable[..., Any]
DeleteSession = Callable[[str], bool]


@dataclass
class TurnResult:
    text: str = ""
    cancelled: bool = False


def _default_map_path() -> Path:
    try:
        from app.config import settings
        base = Path(settings.data_dir)
    except Exception:
        base = Path.cwd()
    return base / "gateway" / "session_map.json"


def _load_map(path: Path) -> dict[str, str]:
    try:
        if path.exists():
            data = json.loads(path.read_text("utf-8"))
            return data if isinstance(data, dict) else {}
    except Exception:
        pass
    return {}


def _save_map(path: Path, mapping: dict[str, str]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(mapping, indent=2), "utf-8")
    except Exception as exc:
        log.warning("gateway: could not persist session map: %s", exc)


class SessionBridge:
    """Maps gateway session keys to workbench sessions and runs agent turns."""

    def __init__(
        self,
        *,
        runner: WorkbenchRunner | None = None,
        session_factory: SessionFactory | None = None,
        delete_session: DeleteSession | None = None,
        provider: str = "",
        model: str = "",
        agent_id: str = "",
        model_provider: str = "",
        guard_mode: str = "full",
        map_path: Path | None = None,
    ) -> None:
        from app.services.workbench import workbench as wb

        self._runner = runner or wb.send_workbench_message_stream
        self._session_factory = session_factory or wb.create_workbench_session
        self._delete_session = delete_session or wb.delete_workbench_session
        self._provider = provider
        self._model = model
        self._agent_id = agent_id
        self._model_provider = model_provider
        self._guard_mode = guard_mode
        self._map_path = map_path or _default_map_path()
        self._map: dict[str, str] = _load_map(self._map_path)
        self._cancels: dict[str, asyncio.Event] = {}

    def session_id_for(self, session_key: str) -> str:
        """Resolve (creating on first contact) the workbench session id."""
        sid = self._map.get(session_key)
        if not sid:
            session = self._session_factory(
                provider=self._provider,
                agent_id=self._agent_id,
                guard_mode=self._guard_mode,
            )
            sid = getattr(session, "id", None) or str(session)
            self._map[session_key] = sid
            _save_map(self._map_path, self._map)
        return sid

    def get_session_id(self, session_key: str) -> str | None:
        """Return the mapped workbench session id, or None if never mapped."""
        return self._map.get(session_key)

    async def invoke_agent(
        self,
        session_key: str,
        text: str,
        *,
        on_event: Callable[[dict[str, Any]], None] | None = None,
    ) -> TurnResult:
        """Run one agent turn for the session; return accumulated reply text."""
        session_id = self.session_id_for(session_key)
        cancel = asyncio.Event()
        self._cancels[session_key] = cancel
        parts: list[str] = []

        def emit(event: dict[str, Any]) -> None:
            if event.get("type") == "final_output" and event.get("content"):
                parts.append(event["content"])
            if on_event:
                try:
                    on_event(event)
                except Exception:
                    pass

        try:
            await self._runner(
                session_id=session_id,
                message=text,
                provider=self._provider,
                agent_id=self._agent_id,
                model=self._model,
                model_provider=self._model_provider,
                guard_mode=self._guard_mode,
                emit=emit,
                signal=cancel,
            )
        finally:
            self._cancels.pop(session_key, None)

        return TurnResult(text="".join(parts), cancelled=cancel.is_set())

    async def cancel_running(self, session_key: str) -> None:
        ev = self._cancels.get(session_key)
        if ev and not ev.is_set():
            ev.set()

    async def reset_session(self, session_key: str) -> None:
        """Cancel any running turn and drop the session mapping (next msg = fresh)."""
        await self.cancel_running(session_key)
        sid = self._map.pop(session_key, None)
        if sid:
            _save_map(self._map_path, self._map)
            try:
                self._delete_session(sid)
            except Exception as exc:
                log.warning("gateway: could not delete workbench session %s: %s", sid, exc)
