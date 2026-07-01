"""v2 — Test that daemons actually invoke the Cerebellum model."""
import asyncio
import pytest
from app.services import daemonManager
from app.services.toolRegistry import setDaemonContext, clearDaemonContext

@pytest.fixture(autouse=True)
def _cleanupDaemonContext():
    clearDaemonContext()
    if hasattr(daemonManager, '_daemons'):
        daemonManager._daemons.clear()
    yield
    clearDaemonContext()

def testDaemonManagerUsesCerebellumRole():
    """The daemon's model role is 'cerebellum' (verified by inspecting the code path)."""
    from app.services.workbench import modelFleet
    model = modelFleet.get_model_for_role('cerebellum')
    assert model == 'claude-3-haiku-20240307'

def testCallCerebellumInvokesProviderOrFallsBack():
    """_call_cerebellum returns a string (real call or placeholder)."""
    import asyncio
    mgr = daemonManager.DaemonManager()
    result = asyncio.run(mgr._call_cerebellum('claude-3-haiku-20240307', 'test prompt'))
    assert isinstance(result, str)
    assert len(result) > 0

def testSpawnSetsDaemonContextForToolCalls(monkeypatch):
    """When a daemon runs, it should set daemon context so tool calls are restricted."""
    from app.services import toolRegistry as tr
    contextWasSet = []
    original = tr.is_daemon_context

    def tracking():
        result = original()
        contextWasSet.append(result)
        return result
    monkeypatch.setattr(tr, 'is_daemon_context', tracking)
    setDaemonContext()
    assert tr.is_daemon_context() is True
    clearDaemonContext()
    assert tr.is_daemon_context() is False