"""
Safety-net CHARACTERIZATION tests for ``app.services.dbWriter``.

These tests capture the CURRENT (as-observed) behavior of the db_writer
module. They are intentionally NOT designed to assert "intended" behavior —
they pin down what the code actually does today so the Phase 0 refactor
cannot silently change behavior.

While writing these tests two pre-existing bugs in the current code were
confirmed empirically (see assertions below). The characterization pins
them down as the current behavior; when the refactor fixes them these
specific tests will fail, which is the desired signal that behavior changed:

  BUG 1 (ensureQueue): the function declares ``global _write_queue, _worker_task``
          but the module globals are named ``_writeQueue`` / ``_workerTask``.
          Because ``_writeQueue`` is assigned inside the function without being
          declared global, it is treated as a local and read before assignment,
          so ``ensureQueue()`` raises ``UnboundLocalError`` on a fresh module.
          Consequence: the public ``enqueueWrite`` / ``enqueueWriteSync`` paths
          currently cannot enqueue anything.

  BUG 2 (_drainLoop): the drop-check reads ``item.enqueued_at`` but
          ``QueueItem.__init__`` stores the timestamp as ``self.enqueuedAt``.
          For a low-priority item this raises ``AttributeError`` inside the
          worker, which is swallowed, so ``item.fn()`` is never invoked for
          low-priority items. High-priority items bypass the drop-check and ARE
          executed.

Run with:  python -m pytest tests/test_db_writer.py -q
"""
from __future__ import annotations
import asyncio
import importlib
import time

import pytest

import app.services.dbWriter as dbw


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
# Public entry points — current (broken) behavior
# ---------------------------------------------------------------------------

def test_ensureQueue_raises_unboundlocalerror_on_fresh_module():
    # See BUG 1 in the module docstring. On a fresh module (globals are None)
    # ensureQueue raises UnboundLocalError instead of starting the queue+worker.
    with pytest.raises(UnboundLocalError):
        dbw.ensureQueue()


async def test_enqueueWrite_high_raises_because_ensureQueue_is_broken():
    # Because ensureQueue raises, enqueueWrite cannot reach the put() call;
    # the supplied fn is never invoked.
    called = []
    with pytest.raises(UnboundLocalError):
        await dbw.enqueueWrite(lambda: called.append(1), priority='high')
    assert called == []


async def test_enqueueWrite_low_raises_because_ensureQueue_is_broken():
    called = []
    with pytest.raises(UnboundLocalError):
        await dbw.enqueueWrite(lambda: called.append(1), priority='low')
    assert called == []


async def test_enqueueWriteSync_low_raises_because_ensureQueue_is_broken():
    # enqueueWriteSync simply awaits enqueueWrite, so it inherits the same
    # broken path today.
    called = []
    with pytest.raises(UnboundLocalError):
        await dbw.enqueueWriteSync(lambda: called.append(1), priority='low')
    assert called == []


# ---------------------------------------------------------------------------
# shutdown() — works independently of the ensureQueue bug
# ---------------------------------------------------------------------------

async def test_shutdown_raises_unboundlocalerror_on_fresh_module():
    # BUG 1 (shutdown variant): shutdown declares ``global _worker_task`` but
    # reads ``_workerTask``, so on a fresh module it raises UnboundLocalError
    # instead of being a clean no-op.
    with pytest.raises(UnboundLocalError):
        await dbw.shutdown()


async def test_shutdown_cannot_cancel_an_installed_worker_currently():
    # Even if a worker task is installed as the module-level _workerTask, the
    # naming bug means shutdown raises before it can cancel — so the worker
    # keeps running and _workerTask is never reset. Pins current (broken)
    # behavior; the refactor must make shutdown actually cancel the worker.
    dbw._writeQueue = asyncio.Queue()
    task = asyncio.create_task(dbw._drainLoop())
    dbw._workerTask = task
    await asyncio.sleep(0.02)
    with pytest.raises(UnboundLocalError):
        await dbw.shutdown()
    # shutdown never reached its cancel/reset logic:
    assert not task.done()
    assert dbw._workerTask is task
    # Manual cleanup so the loop/autouse fixture stays clean.
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


# ---------------------------------------------------------------------------
# _drainLoop worker — drives the queue directly (bypassing the broken
# ensureQueue entry point) to characterize the serialization / drop logic.
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


async def test_drainLoop_does_not_execute_low_priority_item_fn_currently():
    # See BUG 2 in the module docstring. For a low-priority item the worker
    # raises AttributeError while evaluating the drop-check, so item.fn() is
    # never invoked. This pins the CURRENT (broken) behavior.
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
    assert called == []


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
