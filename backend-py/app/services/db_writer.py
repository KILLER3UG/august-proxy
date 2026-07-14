"""
DB Writer — single-writer **FIFO** async queue for selected brain writes.

SQLite permits only one writer at a time (even in WAL mode). This module
serializes enqueued callables through one asyncio worker.

Usage:
    await enqueue_write(lambda: ..., priority="high")
    await enqueue_write(lambda: ..., priority="low")

**Actual behaviour (verified 2026-07-14 — see docs/ARCHITECTURE.md):**

* Shared **FIFO** queue — ``priority`` does **not** reorder items. A "high"
  write still runs after every item already ahead of it.
* Queue is **unbounded** (``asyncio.Queue()`` default). Enqueue always
  succeeds once the queue exists; there is no enqueue-time capacity drop.
* Low-pri **drop** is **age-based at dequeue**: if a low item has waited
  more than ``_LOW_DROP_AFTER`` (2.0s) before the worker picks it up, it is
  skipped. High items are never age-dropped.
* High ``put`` is wrapped in ``wait_for(..., _HIGH_DRAIN_TIMEOUT=5s)`` for
  API stability if a future change reintroduces a bounded queue; with the
  current unbounded queue that timeout effectively never fires on put.

Sole production caller today: ``consolidation_daemon`` (best-effort). Do not
use this for user-facing "must be fast" paths unless you accept FIFO wait.

Reads bypass the queue (WAL concurrent readers + ``memory_store._conn()``).
"""

from __future__ import annotations
import asyncio
import logging
import time
from typing import Callable

logger = logging.getLogger(__name__)
_HIGH_DRAIN_TIMEOUT = 5.0
_LOW_DROP_AFTER = 2.0
_write_queue: asyncio.Queue | None = None
_worker_task: asyncio.Task | None = None


class QueueItem:
    """A queued write operation."""

    def __init__(self, fn: Callable[[], object], priority: str = 'low'):
        self.fn = fn
        self.priority = priority
        self.enqueued_at = time.monotonic()
        self.id = id(self)


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
    if _worker_task and (not _worker_task.done()):
        _worker_task.cancel()
        try:
            await _worker_task
        except asyncio.CancelledError:
            pass
        _worker_task = None


async def enqueue_write(fn: Callable[[], object], priority: str = 'low') -> bool:
    """Enqueue a write operation (FIFO — priority does not reorder).

    Returns True if the write was enqueued, False only if the queue could not
    be initialized or (for high priority) the put wait timed out. With the
    current unbounded queue, put always succeeds once initialized. Low-pri
    age-based drops happen later in ``_drain_loop``, not at enqueue time.
    """
    ensure_queue()
    queue = _write_queue
    if queue is None:
        logger.error('DB write queue not initialized')
        return False
    item = QueueItem(fn, priority)
    try:
        if priority == 'high':
            # wait_for reserved for a possible future bounded queue; unbounded today.
            await asyncio.wait_for(queue.put(item), timeout=_HIGH_DRAIN_TIMEOUT)
        else:
            queue.put_nowait(item)
        return True
    except asyncio.TimeoutError:
        logger.error('Write queue timed out on high-priority write')
        return False


async def enqueue_write_sync(fn: Callable[[], object], priority: str = 'low') -> bool:
    """Synchronous version for use from non-async contexts.

    Creates a new event loop if needed (safe for sync callers in
    thread-pool or background tasks).
    """
    return await enqueue_write(fn, priority)


async def _drain_loop():
    """Background worker: drain the write queue one item at a time."""
    global _write_queue
    logger.info('DB write queue worker started')
    while True:
        try:
            item: QueueItem = await _write_queue.get()
            if item.priority == 'low':
                elapsed = time.monotonic() - item.enqueued_at
                if elapsed > _LOW_DROP_AFTER:
                    logger.debug('Dropped expired low-priority write (%.2fs old)', elapsed)
                    _write_queue.task_done()
                    continue
            try:
                result = item.fn()
                if isinstance(result, Exception):
                    logger.error('Write fn raised: %s', result)
            except Exception as exc:
                logger.error('Write fn raised: %s', exc)
            _write_queue.task_done()
        except asyncio.CancelledError:
            logger.info('DB write queue worker cancelled')
            break
        except Exception as exc:
            logger.error('DB write queue worker error: %s', exc)
            await asyncio.sleep(0.1)
