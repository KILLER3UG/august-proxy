"""
Log stream hub — thread-safe fan-out of backend log events to WebSocket
clients, with an in-memory ring buffer for snapshot/backfill.

Design (per plan Task 2.2):
  * Ring buffer ``deque(maxlen=5000)`` kept **newest-first** via
    ``appendleft`` so ``getRecentLogEvents`` returns the most recent N.
  * A single asyncio task drains an ``asyncio.Queue`` and awaits
    ``send_json`` per client. Producers call ``emitLogEvent`` from any
    thread; we never ``create_task(send_json)`` from a logging handler or
    other non-event-loop thread — instead we hand the frame to the loop via
    ``loop.call_soon_threadsafe(queue.put_nowait, frame)``.
  * Clients are stored as a ``set`` of WebSocket objects.

The hub must be started from the asyncio event loop (``start_hub()``) once
at app lifespan; ``emitLogEvent`` is safe to call before/after start.
"""
from __future__ import annotations

import asyncio
import re
import threading
from collections import deque
from datetime import datetime, timezone
from typing import Any, Optional

MAX_LOG_EVENTS = 5000
_REDACT_RE = re.compile(r'(?i)(api_?key|token|secret|password|authorization|cookie)')

# Guarded so a single hub instance lives for the process.
_lock = threading.Lock()
_buffer: deque[dict[str, Any]] = deque(maxlen=MAX_LOG_EVENTS)
_clients: set[Any] = set()
_queue: Optional[asyncio.Queue[dict[str, Any]]] = None
_drain_task: Optional[asyncio.Task[None]] = None
_loop: Optional[asyncio.AbstractEventLoop] = None


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _redact(obj: Any) -> Any:
    """Recursively redact secret-shaped values in event metadata."""
    if isinstance(obj, dict):
        return {k: ('[REDACTED]' if _REDACT_RE.search(str(k)) else _redact(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_redact(v) for v in obj]
    return obj


def redactMetadata(metadata: Any) -> Any:
    return _redact(metadata)


def buildEvent(
    *,
    category: str = 'info',
    level: str = 'info',
    message: str = '',
    metadata: Any = None,
    eventId: Optional[str] = None,
) -> dict[str, Any]:
    """Construct a canonical LogEvent dict (matches the frontend LogEvent)."""
    import uuid

    return {
        'id': eventId or uuid.uuid4().hex,
        'timestamp': _now_ms(),
        'category': category,
        'level': level,
        'message': message,
        'metadata': redactMetadata(metadata),
        'raw': None,
    }


def getRecentLogEvents(limit: int = 100) -> list[dict[str, Any]]:
    """Return the most recent ``limit`` events (newest-first)."""
    if limit <= 0:
        return []
    return list(_buffer)[:limit]


def addLogWsClient(ws: Any) -> None:
    _clients.add(ws)


def removeLogWsClient(ws: Any) -> None:
    _clients.discard(ws)


def emitLogEvent(event: dict[str, Any]) -> None:
    """Thread-safe emit: append to buffer and enqueue for broadcast.

    Safe to call from any thread (logging handlers, sync tools, the async
    chat loop). If the hub loop is not running yet, the event is still
    buffered for backfill but not pushed to live clients.
    """
    entry = {
        'id': event.get('id') or __import__('uuid').uuid4().hex,
        'timestamp': event.get('timestamp') or _now_ms(),
        'category': event.get('category', 'info'),
        'level': event.get('level', 'info'),
        'message': event.get('message', ''),
        'metadata': redactMetadata(event.get('metadata')),
        'raw': event.get('raw'),
    }
    _buffer.appendleft(entry)
    if _loop is not None and _queue is not None:
        try:
            _loop.call_soon_threadsafe(_queue.put_nowait, entry)
        except Exception:
            pass


async def _drain() -> None:
    assert _queue is not None
    while True:
        frame = await _queue.get()
        # Snapshot clients; drop any that fail to send.
        dead: list[Any] = []
        for ws in list(_clients):
            try:
                await ws.send_json({'type': 'event', 'event': frame})
            except Exception:
                dead.append(ws)
        for ws in dead:
            _clients.discard(ws)


async def startHub() -> None:
    """Start the drain task and record the running loop. Idempotent."""
    global _queue, _drain_task, _loop
    async with _lock_async():
        if _drain_task is not None and not _drain_task.done():
            return
        _loop = asyncio.get_event_loop()
        _queue = asyncio.Queue()
        _drain_task = asyncio.create_task(_drain())


async def stopHub() -> None:
    global _drain_task, _queue, _loop
    if _drain_task is not None:
        _drain_task.cancel()
        _drain_task = None
    _queue = None
    _loop = None


import contextlib


@contextlib.asynccontextmanager
async def _lock_async():
    yield
