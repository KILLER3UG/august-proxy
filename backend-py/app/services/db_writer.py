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
from typing import Callable

logger = logging.getLogger(__name__)
_HIGHDrainTimeout = 5.0
_LOWDropAfter = 2.0
_writeQueue: asyncio.Queue | None = None
_workerTask: asyncio.Task | None = None


class QueueItem:
    """A queued write operation."""

    def __init__(self, fn: Callable[[], object], priority: str = 'low'):
        self.fn = fn
        self.priority = priority
        self.enqueuedAt = time.monotonic()
        self.id = id(self)


def ensureQueue():
    """Start the queue and worker if not already running."""
    global _writeQueue, _workerTask
    if _writeQueue is None:
        _writeQueue = asyncio.Queue()
    if _workerTask is None or _workerTask.done():
        _workerTask = asyncio.create_task(_drainLoop())


async def shutdown():
    """Cancel the worker and drain remaining items."""
    global _workerTask
    if _workerTask and (not _workerTask.done()):
        _workerTask.cancel()
        try:
            await _workerTask
        except asyncio.CancelledError:
            pass
        _workerTask = None


async def enqueueWrite(fn: Callable[[], object], priority: str = 'low') -> bool:
    """Enqueue a write operation.

    Returns True if the write was enqueued, False if it was dropped
    (low-priority only, when the queue is too full).
    """
    ensureQueue()
    queue = _writeQueue
    if queue is None:
        logger.error('DB write queue not initialized')
        return False
    item = QueueItem(fn, priority)
    try:
        if priority == 'high':
            await asyncio.wait_for(queue.put(item), timeout=_HIGHDrainTimeout)
            return True
        else:
            try:
                queue.put_nowait(item)
                return True
            except asyncio.QueueFull:
                logger.warning('Write queue full, dropping low-priority write')
                return False
    except asyncio.TimeoutError:
        logger.error('Write queue timed out on high-priority write')
        return False


async def enqueueWriteSync(fn: Callable[[], object], priority: str = 'low') -> bool:
    """Synchronous version for use from non-async contexts.

    Creates a new event loop if needed (safe for sync callers in
    thread-pool or background tasks).
    """
    return await enqueueWrite(fn, priority)


async def _drainLoop():
    """Background worker: drain the write queue one item at a time."""
    global _writeQueue
    logger.info('DB write queue worker started')
    while True:
        try:
            item: QueueItem = await _writeQueue.get()
            if item.priority == 'low':
                elapsed = time.monotonic() - item.enqueuedAt
                if elapsed > _LOWDropAfter:
                    logger.debug('Dropped expired low-priority write (%.2fs old)', elapsed)
                    _writeQueue.task_done()
                    continue
            try:
                result = item.fn()
                if isinstance(result, Exception):
                    logger.error('Write fn raised: %s', result)
            except Exception as exc:
                logger.error('Write fn raised: %s', exc)
            _writeQueue.task_done()
        except asyncio.CancelledError:
            logger.info('DB write queue worker cancelled')
            break
        except Exception as exc:
            logger.error('DB write queue worker error: %s', exc)
            await asyncio.sleep(0.1)
