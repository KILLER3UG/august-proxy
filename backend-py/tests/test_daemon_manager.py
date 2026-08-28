"""
Safety-net CHARACTERIZATION tests for ``app.services.daemon_manager``.

These are deliberately lightweight: they exercise the public API surface that
can be tested WITHOUT spawning real daemon poll loops (which block on
``POLL_INTERVAL`` and import the model/provider stack). Spawning is out of
scope here to avoid fragile, slow fixtures; it should be covered by dedicated
integration tests. We still import the module and exercise the safe public
helpers (singleton accessor, listing, watch-condition evaluation, backoff
schedule, and the no-op shutdown path).
"""
from __future__ import annotations

import asyncio

import app.services.daemon_manager as dm
import pytest
from app.services.daemon_manager import (
    BACKOFF_CAP,
    BACKOFF_SCHEDULE,
    MAX_DAEMONS_PER_SESSION,
    RESULT_EXPIRY_TURNS,
    DaemonManager,
    DaemonResult,
    DaemonSpec,
    getManager,
    shutdownAll,
)


def test_get_manager_returns_singleton():
    m1 = getManager()
    m2 = getManager()
    assert isinstance(m1, DaemonManager)
    assert m1 is m2


def test_constants_are_exposed():
    assert MAX_DAEMONS_PER_SESSION == 10
    assert BACKOFF_SCHEDULE == [5, 15, 45, 135]
    assert BACKOFF_CAP == 300
    assert RESULT_EXPIRY_TURNS == 5


def test_fresh_manager_has_no_daemons():
    mgr = DaemonManager()
    assert mgr.list_daemons() == []
    assert mgr.getResult('does-not-exist') is None


async def test_kill_returns_false_for_unknown_daemon():
    # NOTE: kill is a coroutine (async def) and must be awaited. On an unknown
    # id it returns False.
    mgr = DaemonManager()
    assert await mgr.kill('does-not-exist') is False


def test_get_result_returns_result_object_for_known_daemon():
    mgr = DaemonManager()
    mgr._daemons['d1'] = {'result': DaemonResult(output='hi')}
    res = mgr.getResult('d1')
    assert isinstance(res, DaemonResult)
    assert res.output == 'hi'


def test_list_daemons_includes_daemon_with_result():
    # listDaemons must read the ``turnsAlive`` attribute (camelCase) on
    # DaemonResult rather than ``turns_alive``, so listing a daemon that has a
    # result returns the list without raising.
    mgr = DaemonManager()
    mgr._daemons['d1'] = {
        'id': 'd1',
        'name': 'd',
        'session_id': 's1',
        'result': DaemonResult(output='x', status='completed', triggered=True, turnsAlive=10),
    }
    result = mgr.list_daemons('s1')
    assert isinstance(result, list)
    assert len(result) == 1
    assert result[0]['id'] == 'd1'
    assert result[0]['name'] == 'd'


def test_evaluate_watch_returns_false_without_condition():
    mgr = DaemonManager()
    info = {'watch_condition': None, 'result': DaemonResult()}
    assert mgr._evaluateWatch(info) is False


def test_evaluate_watch_on_completion():
    mgr = DaemonManager()
    triggered = {'watch_condition': 'on_completion', 'result': DaemonResult(output='  done  ')}
    assert mgr._evaluateWatch(triggered) is True
    empty = {'watch_condition': 'on_completion', 'result': DaemonResult(output='')}
    assert mgr._evaluateWatch(empty) is False


def test_evaluate_watch_on_match_is_case_insensitive_substring():
    mgr = DaemonManager()
    hit = {'watch_condition': 'on_match:alert', 'result': DaemonResult(output='an ALERT happened')}
    assert mgr._evaluateWatch(hit) is True
    miss = {'watch_condition': 'on_match:alert', 'result': DaemonResult(output='all quiet')}
    assert mgr._evaluateWatch(miss) is False


def test_backoff_returns_schedule_values_and_respects_cap():
    mgr = DaemonManager()
    info = {'backoff_index': 0, 'backoff_until': 0.0, 'result': DaemonResult()}
    first = mgr._backoff(info)
    assert first == BACKOFF_SCHEDULE[0]
    assert info['backoff_index'] == 1
    assert info['backoff_until'] > 0
    # Pushing the index past the schedule clamps to the last entry (still capped).
    info['backoff_index'] = 99
    capped = mgr._backoff(info)
    assert capped == min(BACKOFF_SCHEDULE[-1], BACKOFF_CAP)


async def test_shutdown_all_is_noop_without_active_manager():
    # Force a clean singleton state so the assertion is deterministic.
    dm._manager = None
    result = await shutdownAll()
    assert result is None


async def test_kill_for_session_kills_only_that_sessions_daemons():
    """Session deletion must take its daemons with it — other sessions'
    daemons stay alive."""
    mgr = DaemonManager()
    t1 = asyncio.create_task(asyncio.sleep(60))
    t2 = asyncio.create_task(asyncio.sleep(60))
    mgr._daemons['s1_d1'] = {'id': 's1_d1', 'name': 'a', 'session_id': 's1', 'result': DaemonResult()}
    mgr._daemons['s2_d1'] = {'id': 's2_d1', 'name': 'b', 'session_id': 's2', 'result': DaemonResult()}
    mgr._tasks['s1_d1'] = t1
    mgr._tasks['s2_d1'] = t2
    killed = await mgr.kill_for_session('s1')
    assert killed == 1
    for _ in range(5):
        await asyncio.sleep(0)  # deliver the cancellation
    assert t1.cancelled()
    assert not t2.cancelled()
    assert 's1_d1' not in mgr._daemons
    assert 's2_d1' in mgr._daemons
    t2.cancel()


async def test_kill_for_session_empty_session_is_noop():
    mgr = DaemonManager()
    assert await mgr.kill_for_session('ghost') == 0
    assert await mgr.kill_for_session('') == 0


async def test_cancel_session_work_kills_session_daemons(monkeypatch):
    """cancel_session_work (session-delete path) schedules the daemon kill
    on the running loop."""
    mgr = DaemonManager()
    task = asyncio.create_task(asyncio.sleep(60))
    mgr._daemons['sess_x_d'] = {
        'id': 'sess_x_d',
        'name': 'watcher',
        'session_id': 'sess_x',
        'result': DaemonResult(),
    }
    mgr._tasks['sess_x_d'] = task
    monkeypatch.setattr(dm, 'getManager', lambda: mgr)

    from app.services.workbench.sessions import cancel_session_work

    cancel_session_work('sess_x')
    for _ in range(5):
        await asyncio.sleep(0)  # let the scheduled kill task run
    assert task.cancelled()
    assert 'sess_x_d' not in mgr._daemons
