"""v2 — Test the centralized scheduler."""
import asyncio
import time
import pytest
from app.services.scheduler import Scheduler


@pytest.mark.asyncio
async def test_periodic_task_fires_at_interval():
    """Periodic task fires every N seconds."""
    sched = Scheduler()
    call_count = 0
    async def task():
        nonlocal call_count
        call_count += 1
    sched.register_periodic("test", task, interval_seconds=0.05)
    await sched.start()
    await asyncio.sleep(0.18)  # ~3 fires
    await sched.stop()
    assert call_count >= 2


@pytest.mark.asyncio
async def test_idle_task_fires_after_threshold():
    """Idle task fires when no activity for `idle_threshold_seconds`."""
    sched = Scheduler()
    fired = False
    async def task():
        nonlocal fired
        fired = True
    sched.register_idle("test", task, idle_threshold_seconds=0.1)
    await sched.start()
    await asyncio.sleep(0.25)
    await sched.stop()
    assert fired is True


@pytest.mark.asyncio
async def test_record_activity_resets_idle_timer():
    """Calling record_activity prevents the idle task from firing."""
    sched = Scheduler()
    fired = False
    async def task():
        nonlocal fired
        fired = True
    sched.register_idle("test", task, idle_threshold_seconds=0.1)
    await sched.start()
    for _ in range(5):
        await asyncio.sleep(0.05)
        sched.record_activity("session-1")
    await asyncio.sleep(0.05)
    await sched.stop()
    assert sched._idle_resets >= 5
