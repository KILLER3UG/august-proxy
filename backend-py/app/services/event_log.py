"""
Event log — per-session SSE event fan-out.
Replaces chat-event-log.js.

Pattern: in-memory ring buffer + JSONL file + asyncio.Queue fan-out.
"""

from __future__ import annotations
import asyncio
import time
from collections import deque
from typing import AsyncIterator

MAX_IN_MEMORY = 2000


class EventLog:
    """Per-session append-only event log with SSE fan-out."""

    def __init__(self) -> None:
        self._sessions: dict[str, _SessionLog] = {}

    def append(self, sessionId: str, eventType: str, payload: dict[str, object] | None = None) -> int:
        entry = self._getOrCreate(sessionId)
        seq = entry.nextSeq
        entry.nextSeq += 1
        event = {'seq': seq, 'type': eventType, 'payload': payload or {}, 'at': int(time.time() * 1000)}
        entry.events.append(event)
        if len(entry.events) > MAX_IN_MEMORY:
            entry.events.popleft()
        dead: list[asyncio.Queue] = []
        for q in entry.subscribers:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            entry.subscribers.remove(q)
        return seq

    async def subscribe(self, sessionId: str, sinceSeq: int = 0) -> AsyncIterator[dict[str, object]]:
        """Yield events for a session, starting from since_seq."""
        entry = self._getOrCreate(sessionId)
        q: asyncio.Queue = asyncio.Queue()
        entry.subscribers.add(q)
        try:
            replayed: set[int] = set()
            for ev in list(entry.events):
                if ev['seq'] > sinceSeq:
                    replayed.add(ev['seq'])
                    yield ev
            while not q.empty():
                ev = q.get_nowait()
                if ev['seq'] in replayed or ev['seq'] <= sinceSeq:
                    continue
                replayed.add(ev['seq'])
                yield ev
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=30.0)
                    yield ev
                except asyncio.TimeoutError:
                    yield {'type': 'keepalive', 'seq': 0, 'payload': {}}
        finally:
            entry.subscribers.discard(q)

    def _getOrCreate(self, sessionId: str) -> _SessionLog:
        if sessionId not in self._sessions:
            self._sessions[sessionId] = _SessionLog()
        return self._sessions[sessionId]


class _SessionLog:
    def __init__(self) -> None:
        self.nextSeq: int = 1
        self.events: deque[dict] = deque(maxlen=MAX_IN_MEMORY)
        self.subscribers: set[asyncio.Queue] = set()


event_log = EventLog()
