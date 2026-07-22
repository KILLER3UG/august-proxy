"""Contention / contract check: daemon_manager cap + exponential backoff.

Stated contract (module + Codebase Reference):
  - Max 3 daemons per session
  - Crash path uses BACKOFF_SCHEDULE [5, 15, 45, 135] capped at BACKOFF_CAP 300
  - MAX_RETRIES = 2 then stop

Measured under force — not assumed from constants alone.
"""

from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, patch

import app.services.daemon_manager as dm
import pytest
from app.services.daemon_manager import (
    BACKOFF_CAP,
    BACKOFF_SCHEDULE,
    MAX_DAEMONS_PER_SESSION,
    MAX_RETRIES,
    DaemonManager,
    DaemonSpec,
)


@pytest.fixture
def mgr():
    """Isolated manager (not the process singleton)."""
    m = DaemonManager()
    yield m
    # cancel any loops
    for t in list(m._tasks.values()):
        t.cancel()
    if m._tasks:
        try:
            asyncio.get_event_loop().run_until_complete(
                asyncio.gather(*m._tasks.values(), return_exceptions=True)
            )
        except Exception:
            pass
    m._tasks.clear()
    m._daemons.clear()


@pytest.mark.asyncio
async def test_max_three_daemons_per_session_enforced(mgr):
    """4th spawn in same session is rejected; other sessions independent."""
    # Patch poll loop to idle without model/network
    async def idle_loop(daemonId: str):
        try:
            while True:
                await asyncio.sleep(3600)
        except asyncio.CancelledError:
            return

    with patch.object(mgr, '_runLoop', side_effect=idle_loop):
        ids = []
        for i in range(MAX_DAEMONS_PER_SESSION):
            out = await mgr.spawn(DaemonSpec(name=f'd{i}', prompt='p'), sessionId='s1')
            assert not out.startswith('Error:'), out
            ids.append(out)
        fourth = await mgr.spawn(DaemonSpec(name='d3', prompt='p'), sessionId='s1')
        assert fourth.startswith('Error:'), fourth
        assert str(MAX_DAEMONS_PER_SESSION) in fourth

        # Different session still allowed
        other = await mgr.spawn(DaemonSpec(name='other', prompt='p'), sessionId='s2')
        assert not other.startswith('Error:')

        # Errored daemon does not count toward cap (stated filter)
        r = mgr._daemons[ids[0]]['result']
        r.status = 'errored'
        fifth = await mgr.spawn(DaemonSpec(name='d4', prompt='p'), sessionId='s1')
        assert not fifth.startswith('Error:'), fifth

    print(
        'DAEMON_CAP',
        {
            'max': MAX_DAEMONS_PER_SESSION,
            'fourth': fourth,
            'other_session_ok': True,
            'errored_slot_freed': not fifth.startswith('Error:'),
        },
    )


@pytest.mark.asyncio
async def test_backoff_schedule_on_repeated_errors(mgr):
    """Force _runOnce failures → backoff delays follow schedule (first steps)."""
    delays: list[float] = []
    real_backoff = mgr._backoff

    def tracking_backoff(info: dict) -> float:
        d = real_backoff(info)
        delays.append(d)
        return 0.01  # don't actually sleep full 5/15/45 in the test

    sleep_calls: list[float] = []
    original_sleep = asyncio.sleep

    async def fake_sleep(delay: float, *a, **k):
        sleep_calls.append(delay)
        # short real sleep so the loop advances
        await original_sleep(0.001)

    call_n = {'n': 0}

    async def always_error(daemonId: str):
        call_n['n'] += 1
        raise RuntimeError(f'forced {call_n["n"]}')

    with (
        patch.object(mgr, '_runOnce', side_effect=always_error),
        patch.object(mgr, '_backoff', side_effect=tracking_backoff),
        patch('asyncio.sleep', side_effect=fake_sleep),
    ):
        did = await mgr.spawn(DaemonSpec(name='boom', prompt='p'), sessionId='sb')
        assert not did.startswith('Error:')
        # Let loop exhaust retries
        for _ in range(200):
            if did not in mgr._tasks or mgr._tasks[did].done():
                break
            await original_sleep(0.01)
        await original_sleep(0.05)

    # MAX_RETRIES=2 → two retry sleeps after errors; backoff_index advances
    assert len(delays) >= 1
    # First backoff should be schedule[0] before we stubbed return to 0.01
    # tracking_backoff records real_backoff's delay before override
    assert delays[0] == BACKOFF_SCHEDULE[0]
    if len(delays) > 1:
        assert delays[1] == BACKOFF_SCHEDULE[1]
    assert all(d <= BACKOFF_CAP for d in delays)
    print(
        'DAEMON_BACKOFF',
        {
            'delays_computed': delays,
            'schedule': BACKOFF_SCHEDULE,
            'max_retries': MAX_RETRIES,
            'runOnce_calls': call_n['n'],
        },
    )


@pytest.mark.asyncio
async def test_backoff_schedule_tail_and_cap_relationship(mgr):
    """High backoff_index uses last schedule entry; CAP is redundant with current schedule.

    Code: delay = min(BACKOFF_SCHEDULE[min(idx, len-1)], BACKOFF_CAP).
    Schedule max is 135 < BACKOFF_CAP 300 → cap never binds with today's constants.
    """
    info = {'backoff_index': 100, 'backoff_until': 0.0}
    d = mgr._backoff(info)
    assert d == BACKOFF_SCHEDULE[-1]
    assert d <= BACKOFF_CAP
    assert BACKOFF_SCHEDULE[-1] < BACKOFF_CAP  # documents dead cap with current schedule
    assert info['backoff_index'] == 101
    print(
        'DAEMON_BACKOFF_CAP',
        {
            'delay_at_high_idx': d,
            'schedule_last': BACKOFF_SCHEDULE[-1],
            'cap': BACKOFF_CAP,
            'cap_binds_today': BACKOFF_SCHEDULE[-1] >= BACKOFF_CAP,
        },
    )


@pytest.mark.asyncio
async def test_concurrent_spawns_respect_cap(mgr):
    """Parallel spawn attempts for same session never exceed 3 live non-errored."""

    async def idle_loop(daemonId: str):
        try:
            while True:
                await asyncio.sleep(3600)
        except asyncio.CancelledError:
            return

    with patch.object(mgr, '_runLoop', side_effect=idle_loop):
        results = await asyncio.gather(
            *[
                mgr.spawn(DaemonSpec(name=f'c{i}', prompt='p'), sessionId='conc')
                for i in range(8)
            ]
        )
    oks = [r for r in results if not str(r).startswith('Error:')]
    errs = [r for r in results if str(r).startswith('Error:')]
    assert len(oks) == MAX_DAEMONS_PER_SESSION
    assert len(errs) == 8 - MAX_DAEMONS_PER_SESSION
    # Live non-errored count
    live = [
        d
        for d in mgr._daemons.values()
        if d.get('session_id') == 'conc'
        and getattr(d.get('result'), 'status', '') != 'errored'
    ]
    assert len(live) <= MAX_DAEMONS_PER_SESSION
    print(
        'DAEMON_CONCURRENT_SPAWN',
        {'ok': len(oks), 'err': len(errs), 'live': len(live), 'max': MAX_DAEMONS_PER_SESSION},
    )
