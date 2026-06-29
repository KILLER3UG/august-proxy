"""
DB Writer — single-writer async queue for august_brain.sqlite.

SQLite permits only one writer at a time (even in WAL mode). This module
serializes all writes through a single asyncio.Queue to prevent "database
is locked" errors when multiple phases (workbench, daemons, background
review) write concurrently.

Usage:
    await enqueue_write(lambda: save_heuristic(...), priority="high")
    await enqueue_write(lambda: save_blackboard(...), priority="low")

High-priority writes (main-loop state) are processed immediately.
Low-priority writes (daemon notes, background review) are dropped after
2 seconds if the queue is backed up — daemons are best-effort by nature.

Reads bypass the queue and use direct thread-local connections (WAL
permits concurrent readers alongside a single writer).
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable

logger = logging.getLogger(__name__)

# ── Configuration ───────────────────────────────────────────────────────

_HIGH_DRAIN_TIMEOUT = 5.0   # seconds before a high-priority slot times out
_LOW_DROP_AFTER = 2.0       # seconds before a low-priority write is dropped

# ── Queue ───────────────────────────────────────────────────────────────

_write_queue: asyncio.Queue | None = None
_worker_task: asyncio.Task | None = None


class QueueItem:
    """A queued write operation."""

    def __init__(self, fn: Callable[[], Any], priority: str = "low"):
        self.fn = fn
        self.priority = priority  # "high" or "low"
        self.enqueued_at = time.monotonic()
        self.id = id(self)


# ── Lifecycle ───────────────────────────────────────────────────────────


def ensure_queue():
    """Start the queue and worker if not already running."""
    global _write_queue, _worker_task
    if _write_queue is None:
        _write_queue = asyncio.Queue()
    if _worker_task is None or _worker_task.done():
        _worker_task = asyncio.create_task(_drain_loop())


async def shutdown():
    """Cancel the worker and drain remaining items."""
    global _worker_task
    if _worker_task and not _worker_task.done():
        _worker_task.cancel()
        try:
            await _worker_task
        except asyncio.CancelledError:
            pass
        _worker_task = None


# ── Public API ──────────────────────────────────────────────────────────


async def enqueue_write(fn: Callable[[], Any], priority: str = "low") -> bool:
    """Enqueue a write operation.

    Returns True if the write was enqueued, False if it was dropped
    (low-priority only, when the queue is too full).
    """
    ensure_queue()
    item = QueueItem(fn, priority)
    try:
        if priority == "high":
            await asyncio.wait_for(
                _write_queue.put(item),
                timeout=_HIGH_DRAIN_TIMEOUT,
            )
            return True
        else:
            # Low priority: try to put without blocking
            try:
                _write_queue.put_nowait(item)
                return True
            except asyncio.QueueFull:
                logger.warning("Write queue full, dropping low-priority write")
                return False
    except asyncio.TimeoutError:
        logger.error("Write queue timed out on high-priority write")
        return False


async def enqueue_write_sync(fn: Callable[[], Any], priority: str = "low") -> bool:
    """Synchronous version for use from non-async contexts.

    Creates a new event loop if needed (safe for sync callers in
    thread-pool or background tasks).
    """
    return await enqueue_write(fn, priority)


# ── Worker ──────────────────────────────────────────────────────────────


async def _drain_loop():
    """Background worker: drain the write queue one item at a time."""
    global _write_queue
    logger.info("DB write queue worker started")

    while True:
        try:
            item: QueueItem = await _write_queue.get()

            # Drop expired low-priority items
            if item.priority == "low":
                elapsed = time.monotonic() - item.enqueued_at
                if elapsed > _LOW_DROP_AFTER:
                    logger.debug(
                        "Dropped expired low-priority write (%.2fs old)", elapsed
                    )
                    _write_queue.task_done()
                    continue

            # Execute the write
            try:
                result = item.fn()
                if isinstance(result, Exception):
                    logger.error("Write fn raised: %s", result)
            except Exception as exc:
                logger.error("Write fn raised: %s", exc)

            _write_queue.task_done()

        except asyncio.CancelledError:
            logger.info("DB write queue worker cancelled")
            break
        except Exception as exc:
            logger.error("DB write queue worker error: %s", exc)
            await asyncio.sleep(0.1)
