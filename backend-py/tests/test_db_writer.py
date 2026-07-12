"""
Safety-net CHARACTERIZATION tests for ``app.services.db_writer``.

These tests capture the CURRENT (as-observed) behavior of the db_writer
module. They are intentionally NOT designed to assert "intended" behavior —
they pin down what the code actually does today so the Phase 0 refactor
cannot silently change behavior.

While writing these tests two pre-existing bugs in the current code were
confirmed empirically. They were subsequently fixed (the ``global``
declarations now reference the real module globals ``_writeQueue`` /
``_workerTask``, and the drop-check reads ``item.enqueuedAt``). The tests
below now pin down the CORRECT post-fix behavior:

  FIX 1 (ensureQueue): declares ``global _writeQueue, _workerTask`` so the
          queue and worker are created/started on a fresh module without
          raising. ``enqueueWrite`` / ``enqueueWriteSync`` now enqueue and the
          worker runs the supplied ``fn``.

  FIX 2 (_drainLoop): the drop-check reads ``item.enqueuedAt`` (matching
          ``QueueItem.__init__``), so low-priority items whose age is within
          ``_LOWDropAfter`` are executed by the worker.

Run with:  python -m pytest tests/test_db_writer.py -q
"""
from __future__ import annotations
import asyncio
import importlib
import time

import pytest

import app.services.db_writer as dbw


@pytest.fixture(autouse=True)
async def _isolate_module_state():
    """Reset the module-level singletons around every test.

    dbWriter uses module-level globals (``_writeQueue`` / ``_workerTask``) as
    process-wide singletons. We reset them so tests cannot leak worker tasks or
    queued state into each other.
    """
    if dbw._workerTask is not None and not dbw._workerTask.done():
        dbw._workerTask.cancel()
    dbw._writeQueue = None
    dbw._workerTask = None
    yield
    leftover = dbw._workerTask
    if leftover is not None and not leftover.done():
        leftover.cancel()
        try:
            await leftover
        except asyncio.CancelledError:
            pass
    dbw._writeQueue = None
    dbw._workerTask = None


# ---------------------------------------------------------------------------
# Constants & data structures
# ---------------------------------------------------------------------------

def test_module_constants_are_exposed():
    assert dbw._LOWDropAfter == 2.0
    assert dbw._HIGHDrainTimeout == 5.0


def test_queueitem_records_fields_and_defaults():
    def fn():
        return 42
    item = dbw.QueueItem(fn, priority='high')
    assert item.fn is fn
    assert item.priority == 'high'
    assert isinstance(item.enqueuedAt, float)
    assert item.enqueuedAt > 0
    assert item.id == id(item)
    # Default priority is 'low' when omitted.
    low = dbw.QueueItem(fn)
    assert low.priority == 'low'


# ---------------------------------------------------------------------------
# Public entry points — correct post-fix behavior
# ---------------------------------------------------------------------------

async def test_ensureQueue_starts_queue_and_worker():
    # On a fresh module (globals are None) ensureQueue must create the queue
    # and schedule the drain worker without raising.
    dbw.ensureQueue()
    assert isinstance(dbw._writeQueue, asyncio.Queue)
    assert dbw._workerTask is not None
    assert not dbw._workerTask.done()


async def test_enqueueWrite_high_succeeds_and_runs_fn():
    # ensureQueue now works, so enqueueWrite reaches the put() call and the
    # worker eventually runs the supplied fn.
    called = []
    result = await dbw.enqueueWrite(lambda: called.append(1), priority='high')
    assert result is True
    # Give the worker a chance to process the item.
    for _ in range(20):
        if called:
            break
        await asyncio.sleep(0.01)
    assert called == [1]


async def test_enqueueWrite_low_succeeds():
    called = []
    result = await dbw.enqueueWrite(lambda: called.append(1), priority='low')
    assert result is True
    for _ in range(20):
        if called:
            break
        await asyncio.sleep(0.01)
    assert called == [1]


async def test_enqueueWriteSync_low_succeeds():
    # enqueueWriteSync simply awaits enqueueWrite, so it now succeeds too.
    called = []
    result = await dbw.enqueueWriteSync(lambda: called.append(1), priority='low')
    assert result is True
    for _ in range(20):
        if called:
            break
        await asyncio.sleep(0.01)
    assert called == [1]


# ---------------------------------------------------------------------------
# shutdown() — correct post-fix behavior
# ---------------------------------------------------------------------------

async def test_shutdown_is_clean_noop_on_fresh_module():
    # On a fresh module (no worker installed) shutdown is a clean no-op and
    # must not raise.
    await dbw.shutdown()
    assert dbw._workerTask is None


async def test_shutdown_cancels_and_resets_installed_worker():
    # With an installed worker task, shutdown cancels it and resets the module
    # singleton to None.
    dbw._writeQueue = asyncio.Queue()
    task = asyncio.create_task(dbw._drainLoop())
    dbw._workerTask = task
    await asyncio.sleep(0.02)
    await dbw.shutdown()
    assert task.done()
    assert dbw._workerTask is None


# ---------------------------------------------------------------------------
# _drainLoop worker — drives the queue directly to characterize the
# serialization / drop logic.
# ---------------------------------------------------------------------------

async def test_drainLoop_executes_high_priority_item_fn():
    # High-priority items bypass the (buggy) drop-check and ARE executed.
    dbw._writeQueue = asyncio.Queue()
    called = []
    await dbw._writeQueue.put(dbw.QueueItem(lambda: called.append('H'), priority='high'))
    task = asyncio.create_task(dbw._drainLoop())
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert called == ['H']


async def test_drainLoop_handles_low_priority_items():
    # After FIX 2 the drop-check reads item.enqueuedAt, so a low-priority item
    # whose age is within _LOWDropAfter is executed by the worker (fn runs).
    dbw._writeQueue = asyncio.Queue()
    called = []
    await dbw._writeQueue.put(dbw.QueueItem(lambda: called.append('L'), priority='low'))
    task = asyncio.create_task(dbw._drainLoop())
    await asyncio.sleep(0.1)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert called == ['L']


async def test_drainLoop_processes_high_items_in_fifo_order():
    # The worker is a single ``while True`` loop that pulls one item at a time
    # and runs fn() synchronly, giving single-writer (FIFO serial) processing.
    # (Characterized here only for the high-priority path, which currently
    # executes — see BUG 2.)
    dbw._writeQueue = asyncio.Queue()
    order: list[int] = []
    for i in (1, 2, 3):
        await dbw._writeQueue.put(
            dbw.QueueItem((lambda n=i: order.append(n)), priority='high')
        )
    task = asyncio.create_task(dbw._drainLoop())
    await asyncio.sleep(0.15)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert order == [1, 2, 3]
