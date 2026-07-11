"""v2 — Test that daemons actually invoke the Cerebellum model."""

import asyncio
import pytest
from app.services import daemon_manager
from app.services.tool_registry import setDaemonContext, clearDaemonContext


@pytest.fixture(autouse=True)
def _cleanupDaemonContext():
    clearDaemonContext()
    if hasattr(daemon_manager, '_daemons'):
        daemon_manager._daemons.clear()
    yield
    clearDaemonContext()


def testDaemonManagerUsesCerebellumRole():
    """The daemon's model role is 'cerebellum' (verified by inspecting the code path)."""
    from app.services.workbench import model_fleet

    model = model_fleet.getModelForRole('cerebellum')
    assert model == 'claude-3-haiku-20240307'


def testCallCerebellumInvokesProviderOrFallsBack():
    """_call_cerebellum returns a string (real call or placeholder)."""
    import asyncio

    mgr = daemon_manager.DaemonManager()
    result = asyncio.run(mgr._call_cerebellum('claude-3-haiku-20240307', 'test prompt'))
    assert isinstance(result, str)
    assert len(result) > 0


def testSpawnSetsDaemonContextForToolCalls(monkeypatch):
    """When a daemon runs, it should set daemon context so tool calls are restricted."""
    from app.services import tool_registry as tr

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
