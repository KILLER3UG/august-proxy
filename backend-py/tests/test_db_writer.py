"""
Safety-net CHARACTERIZATION tests for ``app.services.db_writer``.

These tests capture the CURRENT (as-observed) behavior of the db_writer
module. They are intentionally NOT designed to assert "intended" behavior —
they pin down what the code actually does today so the Phase 0 refactor
cannot silently change behavior.

While writing these tests two pre-existing bugs in the current code were
confirmed empirically. They were subsequently fixed (the ``global``
declarations now reference the real module globals ``_write_queue`` /
``_worker_task``, and the drop-check reads ``item.enqueued_at``). The tests
below now pin down the CORRECT post-fix behavior:

  FIX 1 (ensure_queue): declares ``global _write_queue, _worker_task`` so the
        queue and worker are created/started on a fresh module without
        raising. ``enqueue_write`` / ``enqueue_write_sync`` now enqueue and the
        worker runs the supplied ``fn``.

  FIX 2 (_drain_loop): the drop-check reads ``item.enqueued_at`` (matching
        ``QueueItem.__init__``), so low-priority items whose age is within
        ``_LOW_DROP_AFTER`` are executed by the worker.

Run with:  python -m pytest tests/test_db_writer.py -q
"""
from __future__ import annotations
import asyncio
import time

import pytest

import app.services.db_writer as dbw


@pytest.fixture(autouse=True)
async def _isolate_module_state():
    """Reset the module-level singletons around every test.

    db_writer uses module-level globals (``_write_queue`` / ``_worker_task``) as
    process-wide singletons. We reset them so tests cannot leak worker tasks or
    queued state into each other.
    """
    if dbw._worker_task is not None and not dbw._worker_task.done():
        dbw._worker_task.cancel()
    dbw._write_queue = None
    dbw._worker_task = None
    yield
    leftover = dbw._worker_task
    if leftover is not None and not leftover.done():
        leftover.cancel()
        try:
            await leftover
        except asyncio.CancelledError:
            pass
    dbw._write_queue = None
    dbw._worker_task = None


# ---------------------------------------------------------------------------
# Constants & data structures
# ---------------------------------------------------------------------------

def test_module_constants_are_exposed():
    assert dbw._LOW_DROP_AFTER == 2.0
    assert dbw._HIGH_DRAIN_TIMEOUT == 5.0


def test_queueitem_records_fields_and_defaults():
    def fn():
        return 42
    item = dbw.QueueItem(fn, priority='high')
    assert item.fn is fn
    assert item.priority == 'high'
    assert isinstance(item.enqueued_at, float)
    assert item.enqueued_at > 0
    assert item.id == id(item)
    # Default priority is 'low' when omitted.
    low = dbw.QueueItem(fn)
    assert low.priority == 'low'


# ---------------------------------------------------------------------------
# Public entry points — correct post-fix behavior
# ---------------------------------------------------------------------------

async def test_ensure_queue_starts_queue_and_worker():
    # On a fresh module (globals are None) ensure_queue must create the queue
    # and schedule the drain worker without raising.
    dbw.ensure_queue()
    assert isinstance(dbw._write_queue, asyncio.Queue)
    assert dbw._worker_task is not None
    assert not dbw._worker_task.done()


async def test_enqueue_write_high_succeeds_and_runs_fn():
    # ensure_queue now works, so enqueue_write reaches the put() call and the
    # worker eventually runs the supplied fn.
    called = []
    result = await dbw.enqueue_write(lambda: called.append(1), priority='high')
    assert result is True
    # Give the worker a chance to process the item.
    for _ in range(20):
        if called:
            break
        await asyncio.sleep(0.01)
    assert called == [1]


async def test_enqueue_write_low_succeeds():
    called = []
    result = await dbw.enqueue_write(lambda: called.append(1), priority='low')
    assert result is True
    for _ in range(20):
        if called:
            break
        await asyncio.sleep(0.01)
    assert called == [1]


async def test_enqueue_write_sync_low_succeeds():
    # enqueue_write_sync simply awaits enqueue_write, so it now succeeds too.
    called = []
    result = await dbw.enqueue_write_sync(lambda: called.append(1), priority='low')
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
    assert dbw._worker_task is None


async def test_shutdown_cancels_and_resets_installed_worker():
    # With an installed worker task, shutdown cancels it and resets the module
    # singleton to None.
    dbw._write_queue = asyncio.Queue()
    task = asyncio.create_task(dbw._drain_loop())
    dbw._worker_task = task
    await asyncio.sleep(0.02)
    await dbw.shutdown()
    assert task.done()
    assert dbw._worker_task is None


# ---------------------------------------------------------------------------
# _drain_loop worker — drives the queue directly to characterize the
# serialization / drop logic.
# ---------------------------------------------------------------------------

async def test_drain_loop_executes_high_priority_item_fn():
    # High-priority items bypass the (buggy) drop-check and ARE executed.
    dbw._write_queue = asyncio.Queue()
    called = []
    await dbw._write_queue.put(dbw.QueueItem(lambda: called.append('H'), priority='high'))
    task = asyncio.create_task(dbw._drain_loop())
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert called == ['H']


async def test_drain_loop_handles_low_priority_items():
    # After FIX 2 the drop-check reads item.enqueued_at, so a low-priority item
    # whose age is within _LOW_DROP_AFTER is executed by the worker (fn runs).
    dbw._write_queue = asyncio.Queue()
    called = []
    await dbw._write_queue.put(dbw.QueueItem(lambda: called.append('L'), priority='low'))
    task = asyncio.create_task(dbw._drain_loop())
    await asyncio.sleep(0.1)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert called == ['L']


async def test_drain_loop_processes_high_items_in_fifo_order():
    # The worker is a single ``while True`` loop that pulls one item at a time
    # and runs fn() synchronly, giving single-writer (FIFO serial) processing.
    # (Characterized here only for the high-priority path, which currently
    # executes — see FIX 2.)
    dbw._write_queue = asyncio.Queue()
    order: list[int] = []
    for i in (1, 2, 3):
        await dbw._write_queue.put(
            dbw.QueueItem((lambda n=i: order.append(n)), priority='high')
        )
    task = asyncio.create_task(dbw._drain_loop())
    await asyncio.sleep(0.15)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert order == [1, 2, 3]