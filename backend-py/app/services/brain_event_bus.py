"""
v4.3 — Brain Event Bus (in-process pub/sub).

Mirrors `services/logger.py:ActivityLog` — append-only ring buffer plus SSE
fan-out. Used by the Brain dashboard "Activity" tab to show what the brain
subsystems are doing in realtime.

The ring is the *live tail*; every event is also mirrored to the durable
``brain_events`` table (migration 008) so the Activity feed survives
restarts (B4).
"""

from __future__ import annotations

import asyncio
import json
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

    def emit(
        self, *, category: str, layer: str, summary: str, meta: dict[str, object] | None = None
    ) -> dict[str, object]:
        entry: dict[str, object] = {
            'id': uuid.uuid4().hex,
            'category': category,
            'layer': layer,
            'summary': summary,
            'meta': dict(meta) if meta else {},
            'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        }
        self._events.appendleft(entry)
        self._persist(entry)
        dead: list[asyncio.Queue] = []
        for q in list(self._subscribers):
            try:
                q.put_nowait(entry)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self._unsubscribe(q)
        return entry

    @staticmethod
    def _persist(entry: dict[str, object]) -> None:
        """Mirror one event to the durable brain_events table (best-effort)."""
        try:
            from app.services.memory_store import _conn

            conn = _conn()
            conn.execute(
                'INSERT OR IGNORE INTO brain_events (event_id, category, layer, summary, meta, at) '
                'VALUES (?, ?, ?, ?, ?, ?)',
                (
                    str(entry.get('id') or ''),
                    str(entry.get('category') or ''),
                    str(entry.get('layer') or ''),
                    str(entry.get('summary') or '')[:2000],
                    json.dumps(entry.get('meta') or {}, default=str)[:8000],
                    str(entry.get('at') or ''),
                ),
            )
            conn.commit()
        except Exception:
            pass

    def recent(self, limit: int = 100, category: str | None = None) -> list[dict[str, object]]:
        items = list(self._events)
        if category:
            items = [e for e in items if e['category'] == category]
        return items[: max(0, limit)]

    def history(self, limit: int = 200, category: str | None = None) -> list[dict[str, object]]:
        """Durable event tail (survives restarts), merged with the live ring.

        Ring entries come first (newest); older rows are back-filled from the
        table so the Activity tab always shows a full window.
        """
        live = self.recent(limit=limit, category=category)
        live_ids = {str(e.get('id')) for e in live}
        try:
            from app.services.memory_store import _conn

            conn = _conn()
            if category:
                rows = conn.execute(
                    'SELECT event_id, category, layer, summary, meta, at '
                    'FROM brain_events WHERE category = ? ORDER BY id DESC LIMIT ?',
                    (category, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    'SELECT event_id, category, layer, summary, meta, at '
                    'FROM brain_events ORDER BY id DESC LIMIT ?',
                    (limit,),
                ).fetchall()
            out = list(live)
            for r in rows:
                eid = str(r['event_id'] or '')
                if eid in live_ids:
                    continue
                try:
                    meta = json.loads(r['meta'] or '{}')
                except Exception:
                    meta = {}
                out.append(
                    {
                        'id': eid,
                        'category': r['category'],
                        'layer': r['layer'],
                        'summary': r['summary'],
                        'meta': meta if isinstance(meta, dict) else {},
                        'at': r['at'],
                    }
                )
                if len(out) >= limit:
                    break
            return out[: max(0, limit)]
        except Exception:
            return live

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


def emitBrainEvent(
    *, category: str, layer: str, summary: str, meta: dict[str, object] | None = None
) -> dict[str, object]:
    """Publish a brain event. Safe to call from any subsystem — failures are logged not raised."""
    try:
        return brainBus.emit(category=category, layer=layer, summary=summary, meta=meta)
    except Exception:
        import logging

        logging.getLogger(__name__).exception('emit_brain_event failed')
        return {}
