"""
Event log — per-session SSE event fan-out.
Replaces chat-event-log.js.

Pattern: in-memory ring buffer + JSONL file + asyncio.Queue fan-out.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import deque
from pathlib import Path
from typing import Any, AsyncIterator

from app.lib.paths import data_path

MAX_IN_MEMORY = 2000


class EventLog:
    """Per-session append-only event log with SSE fan-out."""

    def __init__(self) -> None:
        self._sessions: dict[str, _SessionLog] = {}

    def append(self, session_id: str, event_type: str, payload: dict[str, Any] | None = None) -> int:
        entry = self._get_or_create(session_id)
        seq = entry.next_seq
        entry.next_seq += 1

        event = {
            "seq": seq,
            "type": event_type,
            "payload": payload or {},
            "at": int(time.time() * 1000),
        }
        entry.events.append(event)
        if len(entry.events) > MAX_IN_MEMORY:
            entry.events.popleft()

        # Fan-out to all subscribers
        dead: list[asyncio.Queue] = []
        for q in entry.subscribers:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            entry.subscribers.remove(q)

        return seq

    async def subscribe(self, session_id: str, since_seq: int = 0) -> AsyncIterator[dict[str, Any]]:
        """Yield events for a session, starting from since_seq."""
        entry = self._get_or_create(session_id)
        q: asyncio.Queue = asyncio.Queue()

        # Replay past events (sync iteration, async yield)
        for ev in list(entry.events):
            if ev["seq"] > since_seq:
                yield ev

        entry.subscribers.add(q)
        try:
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=30.0)
                    yield ev
                except asyncio.TimeoutError:
                    yield {"type": "keepalive", "seq": 0, "payload": {}}
        finally:
            entry.subscribers.discard(q)

    def _get_or_create(self, session_id: str) -> _SessionLog:
        if session_id not in self._sessions:
            self._sessions[session_id] = _SessionLog()
        return self._sessions[session_id]


class _SessionLog:
    def __init__(self) -> None:
        self.next_seq: int = 1
        self.events: deque[dict] = deque(maxlen=MAX_IN_MEMORY)
        self.subscribers: set[asyncio.Queue] = set()


event_log = EventLog()
