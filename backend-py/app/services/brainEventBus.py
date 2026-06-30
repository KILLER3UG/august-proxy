"""
v4.3 — Brain Event Bus (in-process pub/sub).

Mirrors `services/logger.py:ActivityLog` — append-only ring buffer plus SSE
fan-out. Used by the Brain dashboard "Activity" tab to show what the brain
subsystems are doing in realtime.

NOT persisted to disk. Events that should be audited belong on their
own tables (heuristics, auto_memories, episodic_timeline, …). This is
the *live tail* — what you'd see if you had a window into the brain.
"""
from __future__ import annotations
import asyncio
import time
import uuid
from collections import deque
from typing import AsyncIterator
_MAXEvents = 200

class BrainEventBus:
    """In-memory ring buffer of brain events with SSE fan-out."""

    def __init__(self) -> None:
        self._events: deque[dict[str, object]] = deque(maxlen=_MAXEvents)
        self._subscribers: list[asyncio.Queue] = []

    def emit(self, *, category: str, layer: str, summary: str, meta: dict[str, object] | None=None) -> dict[str, object]:
        entry = {'id': uuid.uuid4().hex, 'category': category, 'layer': layer, 'summary': summary, 'meta': dict(meta) if meta else {}, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        self._events.appendleft(entry)
        dead: list[asyncio.Queue] = []
        for q in list(self._subscribers):
            try:
                q.put_nowait(entry)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self._unsubscribe(q)
        return entry

    def recent(self, limit: int=100, category: str | None=None) -> list[dict[str, object]]:
        items = list(self._events)
        if category:
            items = [e for e in items if e['category'] == category]
        return items[:max(0, limit)]

    def _subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._subscribers.append(q)
        return q

    def _unsubscribe(self, q: asyncio.Queue) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    async def stream(self) -> AsyncIterator[dict[str, object]]:
        """Async generator that yields events as they're emitted."""
        q = self._subscribe()
        try:
            while True:
                entry = await q.get()
                yield entry
        finally:
            self._unsubscribe(q)
brainBus = BrainEventBus()

def emitBrainEvent(*, category: str, layer: str, summary: str, meta: dict[str, object] | None=None) -> dict[str, object]:
    """Publish a brain event. Safe to call from any subsystem — failures are logged not raised."""
    try:
        return brainBus.emit(category=category, layer=layer, summary=summary, meta=meta)
    except Exception:
        import logging
        logging.getLogger(__name__).exception('emit_brain_event failed')
        return {}