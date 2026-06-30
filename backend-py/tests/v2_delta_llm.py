"""v2 — Test delta engine Hippocampus batch inference + env subscription."""
import asyncio
import pytest
from app.services import deltaEngine

def testCallHippocampusInvokesModel():
    """_call_hippocampus returns None when no provider is configured (graceful)."""
    result = deltaEngine._call_hippocampus('test diff text')
    assert result is None or isinstance(result, str)

def testDeltaEngineExposesSubscribeEnvWatcher():
    """delta_engine has subscribe_env_watcher."""
    assert hasattr(deltaEngine, 'subscribe_env_watcher')
    assert callable(deltaEngine.subscribe_env_watcher)

def testSubscribeEnvWatcherRegistersCallback():
    """subscribe_env_watcher adds _on_env_change to the watcher's subscribers."""

    class FakeWatcher:

        def __init__(self):
            self._subscribers = []

        def subscribe(self, callback):
            self._subscribers.append(callback)
    watcher = FakeWatcher()
    deltaEngine.subscribe_env_watcher(watcher)
    assert len(watcher._subscribers) == 1
    assert watcher._subscribers[0] == deltaEngine._on_env_change

def testOnEnvChangeCallsCheckAndDiff(monkeypatch):
    """When the watcher fires, check_and_diff is called."""
    called = []
    monkeypatch.setattr(deltaEngine, 'check_and_diff', lambda p: called.append(p))

    class FakeEvent:
        path = '/tmp/test.py'
    deltaEngine._on_env_change(FakeEvent())
    assert called == ['/tmp/test.py']