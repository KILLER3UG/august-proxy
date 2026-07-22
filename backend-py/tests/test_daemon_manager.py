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
    assert MAX_DAEMONS_PER_SESSION == 3
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
