"""Global UI realtime bus — backend → frontend push channel.

All workbench / brain / catalog mutations that the desktop should reflect
instantly emit here. The frontend keeps a single ``EventSource`` on
``GET /api/realtime/stream`` and applies events to Zustand / React Query.

This is the product-wide equivalent of the session-delete SSE path: no
waiting on multi-second pollers for state that already changed server-side.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import deque
from typing import Any, AsyncIterator

logger = logging.getLogger('realtime')

_MAX_RECENT = 200
_KEEPALIVE_S = 20.0


class RealtimeBus:
    """In-memory ring buffer + asyncio fan-out for UI realtime events."""

    def __init__(self) -> None:
        self._events: deque[dict[str, Any]] = deque(maxlen=_MAX_RECENT)
        self._subscribers: list[asyncio.Queue[dict[str, Any]]] = []

    def emit(self, event_type: str, **payload: Any) -> dict[str, Any]:
        entry: dict[str, Any] = {
            'id': uuid.uuid4().hex[:16],
            'type': str(event_type),
            'at': int(time.time() * 1000),
            **payload,
        }
        self._events.appendleft(entry)
        dead: list[asyncio.Queue[dict[str, Any]]] = []
        for q in list(self._subscribers):
            try:
                q.put_nowait(entry)
            except asyncio.QueueFull:
                dead.append(q)
            except Exception:
                dead.append(q)
        for q in dead:
            self._unsubscribe(q)
        return entry

    def recent(self, limit: int = 50, event_type: str | None = None) -> list[dict[str, Any]]:
        items = list(self._events)
        if event_type:
            items = [e for e in items if e.get('type') == event_type]
        return items[: max(0, min(limit, _MAX_RECENT))]

    def _subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=500)
        self._subscribers.append(q)
        return q

    def _unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    async def stream(self) -> AsyncIterator[dict[str, Any]]:
        q = self._subscribe()
        try:
            # Replay a short tail so reconnects catch recent deletes/creates.
            for entry in reversed(list(self._events)[:30]):
                yield entry
            while True:
                try:
                    entry = await asyncio.wait_for(q.get(), timeout=_KEEPALIVE_S)
                    yield entry
                except asyncio.TimeoutError:
                    yield {'type': 'keepalive', 'at': int(time.time() * 1000)}
        finally:
            self._unsubscribe(q)


realtime_bus = RealtimeBus()


def emit_realtime(event_type: str, **payload: Any) -> dict[str, Any]:
    """Publish a UI realtime event. Safe from any thread/async context."""
    try:
        return realtime_bus.emit(event_type, **payload)
    except Exception:
        logger.exception('emit_realtime failed type=%s', event_type)
        return {}


def emit_invalidate(*query_keys: str, session_id: str = '') -> dict[str, Any]:
    """Tell the frontend to invalidate one or more React Query keys."""
    keys = [k for k in query_keys if k]
    if not keys:
        return {}
    payload: dict[str, Any] = {'queryKeys': keys}
    if session_id:
        payload['sessionId'] = session_id
    return emit_realtime('invalidate', **payload)
