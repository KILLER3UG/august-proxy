"""
Event log — per-session SSE event fan-out.
Replaces chat-event-log.js.

Pattern: in-memory ring buffer + JSONL file + asyncio.Queue fan-out.

The JSONL file makes reconnect-after-restart replay possible: events are
appended durably per session and the ring is rehydrated from the file tail
on first access. Previously the log was memory-only, so a backend restart
reset seq to 1 and ``sinceSeq`` replays came back empty — remote sessions
silently lost every update that happened while they were disconnected
(audit fix).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections import deque
from pathlib import Path
from typing import AsyncIterator

logger = logging.getLogger(__name__)

MAX_IN_MEMORY = 2000
# Rewrite the JSONL with the in-memory tail once it exceeds this size.
MAX_LOG_BYTES = 8 * 1024 * 1024

_SAFE_NAME_RE = re.compile(r'[^A-Za-z0-9_.-]')


def _log_path(sessionId: str) -> Path:
    from app.lib.paths import dataPath

    safe = _SAFE_NAME_RE.sub('_', sessionId or 'default')[:120] or 'default'
    return dataPath('event_log', f'{safe}.jsonl')


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
        self._persist(entry, event)
        dead: list[asyncio.Queue] = []
        for q in entry.subscribers:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            entry.subscribers.remove(q)
        return seq

    def _persist(self, entry: '_SessionLog', event: dict) -> None:
        try:
            entry.path.parent.mkdir(parents=True, exist_ok=True)
            line = json.dumps(event, separators=(',', ':')) + '\n'
            entry.sizeHint += len(line)
            with entry.path.open('a', encoding='utf-8') as f:
                f.write(line)
            if entry.sizeHint > MAX_LOG_BYTES:
                self._trim(entry)
        except OSError:
            logger.debug('event log persist failed for %s', entry.path)

    def _trim(self, entry: '_SessionLog') -> None:
        """Rewrite the JSONL with the in-memory tail (bounded disk use)."""
        try:
            tail = list(entry.events)
            with entry.path.open('w', encoding='utf-8') as f:
                for ev in tail:
                    f.write(json.dumps(ev, separators=(',', ':')) + '\n')
            entry.sizeHint = entry.path.stat().st_size
        except OSError:
            logger.debug('event log trim failed for %s', entry.path)

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

    def _getOrCreate(self, sessionId: str) -> '_SessionLog':
        if sessionId not in self._sessions:
            self._sessions[sessionId] = _SessionLog(sessionId)
        return self._sessions[sessionId]


class _SessionLog:
    def __init__(self, sessionId: str) -> None:
        self.path = _log_path(sessionId)
        self.nextSeq: int = 1
        self.events: deque[dict] = deque(maxlen=MAX_IN_MEMORY)
        self.subscribers: set[asyncio.Queue] = set()
        self.sizeHint: int = 0
        self._rehydrate()

    def _rehydrate(self) -> None:
        """Load the durable tail (reconnect-after-restart replay) + seq."""
        try:
            if not self.path.exists():
                return
            lines: list[str] = []
            with self.path.open('r', encoding='utf-8') as f:
                for ln in f:
                    ln = ln.strip()
                    if ln:
                        lines.append(ln)
            self.sizeHint = sum((len(ln) + 1 for ln in lines))
            for ln in lines[-MAX_IN_MEMORY:]:
                try:
                    ev = json.loads(ln)
                except (json.JSONDecodeError, TypeError):
                    # Tolerate a torn last line (crash mid-write).
                    continue
                if isinstance(ev, dict) and isinstance(ev.get('seq'), int):
                    self.events.append(ev)
                    self.nextSeq = max(self.nextSeq, ev['seq'] + 1)
        except OSError:
            logger.debug('event log rehydrate failed for %s', self.path)


event_log = EventLog()
