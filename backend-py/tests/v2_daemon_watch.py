"""v2 — Test daemon watch conditions."""
import pytest
from app.services import daemonManager
from app.services.tool_registry import clearDaemonContext

@pytest.fixture(autouse=True)
def _cleanup():
    clearDaemonContext()
    if hasattr(daemonManager, '_daemons'):
        daemonManager._daemons.clear()
    yield
    if hasattr(daemonManager, '_daemons'):
        daemonManager._daemons.clear()

def testMaxThreeConcurrentDaemons():
    """spawn() returns an error string on 4th daemon (caller checks for "Error: max")."""
    import asyncio
    mgr = daemonManager.DaemonManager()
    sid = 'test-max-session'
    for d in list(mgr._tasks.values()):
        try:
            d.cancel()
        except Exception:
            pass
    mgr._tasks.clear()
    mgr._daemons.clear()
    spec1 = daemonManager.DaemonSpec(name='d1', prompt='x', watch_condition='on_completion')
    spec2 = daemonManager.DaemonSpec(name='d2', prompt='x', watch_condition='on_completion')
    spec3 = daemonManager.DaemonSpec(name='d3', prompt='x', watch_condition='on_completion')
    spec4 = daemonManager.DaemonSpec(name='d4', prompt='x', watch_condition='on_completion')

    async def go():
        r1 = await mgr.spawn(spec1, session_id=sid)
        r2 = await mgr.spawn(spec2, session_id=sid)
        r3 = await mgr.spawn(spec3, session_id=sid)
        r4 = await mgr.spawn(spec4, session_id=sid)
        assert not r1.startswith('Error'), f'r1 unexpected: {r1}'
        assert not r2.startswith('Error'), f'r2 unexpected: {r2}'
        assert not r3.startswith('Error'), f'r3 unexpected: {r3}'
        assert r4.startswith('Error'), f'r4 should be error: {r4}'
        assert 'max' in r4.lower() or '3' in r4
    asyncio.run(go())

def testOnCompletionFiresAfterFirstRun():
    """`on_completion` triggers after the daemon's first run completes."""
    mgr = daemonManager.DaemonManager()
    info = {'result': type('R', (), {'output': 'first run output'})(), 'watch_condition': 'on_completion'}
    fired = mgr._evaluate_watch(info)
    assert fired is True

def testOnMatchKeywordSubstringCaseInsensitive():
    """`on_match:ERROR` fires when output contains 'error' (case-insensitive)."""
    mgr = daemonManager.DaemonManager()
    infoFine = {'result': type('R', (), {'output': 'everything is fine'})(), 'watch_condition': 'on_match:ERROR'}
    fired = mgr._evaluate_watch(infoFine)
    assert fired is False
    infoErr = {'result': type('R', (), {'output': 'got an Error here'})(), 'watch_condition': 'on_match:ERROR'}
    fired = mgr._evaluate_watch(infoErr)
    assert fired is True
    infoUpper = {'result': type('R', (), {'output': 'ERROR FOUND'})(), 'watch_condition': 'on_match:ERROR'}
    fired = mgr._evaluate_watch(infoUpper)
    assert fired is True

def testOnChangeFiresOnHashDiff():
    """`on_change` fires when output md5 differs from previous cycle."""
    mgr = daemonManager.DaemonManager()
    result = daemonManager.DaemonResult()
    info1 = {'result': result, 'watch_condition': 'on_change'}
    result.output = 'output A'
    fired = mgr._evaluate_watch(info1)
    fired = mgr._evaluate_watch(info1)
    assert fired is False
    result.output = 'output B'
    fired = mgr._evaluate_watch(info1)
    assert fired is True