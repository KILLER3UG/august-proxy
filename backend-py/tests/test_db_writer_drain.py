"""Tests for db_writer shutdown drain behaviour (Phase 1.7)."""

import asyncio

import pytest
from app.services import db_writer


@pytest.fixture(autouse=True)
def _reset_queue():
    """Ensure a clean queue state for each test."""
    db_writer._write_queue = None
    db_writer._worker_task = None
    db_writer.reset_stats()
    yield
    # Cleanup: cancel any lingering worker
    if db_writer._worker_task and not db_writer._worker_task.done():
        db_writer._worker_task.cancel()
    db_writer._write_queue = None
    db_writer._worker_task = None


@pytest.mark.asyncio
async def test_shutdown_drains_pending_items():
    """Shutdown must execute all queued writes before completing."""
    results = []

    db_writer.ensure_queue()
    # Enqueue 5 writes without giving the worker time to process them all
    for i in range(5):
        await db_writer.enqueue_write(lambda i=i: results.append(i), must_succeed=True)

    # Immediately shutdown — some items may still be in the queue
    await db_writer.shutdown()

    # All 5 writes must have been executed (by worker or by drain)
    assert len(results) == 5
    stats = db_writer.get_stats()
    assert stats['executed'] == 5


@pytest.mark.asyncio
async def test_shutdown_empty_queue_no_error():
    """Shutdown with an empty queue completes without error."""
    db_writer.ensure_queue()
    # Let the worker start
    await asyncio.sleep(0.05)
    await db_writer.shutdown()
    # No exception raised — pass


@pytest.mark.asyncio
async def test_shutdown_without_queue_no_error():
    """Shutdown when queue was never initialized is a no-op."""
    await db_writer.shutdown()
    # No exception raised — pass


@pytest.mark.asyncio
async def test_drain_error_does_not_prevent_shutdown():
    """A failing write during drain does not block shutdown completion."""
    results = []

    db_writer.ensure_queue()
    await db_writer.enqueue_write(lambda: results.append('ok1'), must_succeed=True)
    await db_writer.enqueue_write(lambda: (_ for _ in ()).throw(ValueError('boom')), must_succeed=True)
    await db_writer.enqueue_write(lambda: results.append('ok2'), must_succeed=True)

    await db_writer.shutdown()

    # The good writes still executed despite the bad one
    assert 'ok1' in results
    assert 'ok2' in results
    stats = db_writer.get_stats()
    assert stats['errors'] >= 1


@pytest.mark.asyncio
async def test_queue_reset_after_shutdown():
    """After shutdown, the queue is None and can be re-initialized."""
    db_writer.ensure_queue()
    await db_writer.shutdown()
    assert db_writer._write_queue is None
    assert db_writer._worker_task is None

    # Can re-initialize
    db_writer.ensure_queue()
    assert db_writer._write_queue is not None
    await db_writer.shutdown()
