"""v2 — Test environment watcher (ignore patterns, rate limit, ChangeEvent)."""
import time
import pytest
from app.services import environmentWatcher
from app.services.environmentWatcher import shouldIgnore, EnvironmentWatcher, ChangeEvent, recordChange, getRecentChanges

def testShouldIgnorePycache():
    assert shouldIgnore('__pycache__/foo.pyc') is True
    assert shouldIgnore('src/foo.pyc') is True
    assert shouldIgnore('node_modules/foo.js') is True
    assert shouldIgnore('.git/objects/abc') is True
    assert shouldIgnore('src/main.py') is False
    assert shouldIgnore('README.md') is False

def testShouldIgnoreSwapFiles():
    assert shouldIgnore('.main.py.swp') is True
    assert shouldIgnore('foo.swo') is True

def testChangeEventFormat():
    """ChangeEvent has the expected fields."""
    e = ChangeEvent(path='src/auth.py', kind='modify', timestamp=time.time(), source='fs')
    assert e.path == 'src/auth.py'
    assert e.kind == 'modify'
    assert e.source == 'fs'

def testWatcherEmitRespectsRateLimit():
    """Events within rate_limit are not emitted."""
    watcher = EnvironmentWatcher(rate_limit_seconds=1.0)
    received: list[ChangeEvent] = []
    watcher.subscribe(lambda e: received.append(e))
    watcher._last_emit = time.monotonic()
    e = ChangeEvent(path='a', kind='modify', timestamp=time.time(), source='fs')
    watcher._emit(e)
    assert len(received) == 0

def testWatcherEmitPassesAfterRateLimit():
    """After rate limit window, events are emitted."""
    watcher = EnvironmentWatcher(rate_limit_seconds=0.05)
    received: list[ChangeEvent] = []
    watcher.subscribe(lambda e: received.append(e))
    watcher._last_emit = time.monotonic() - 1.0
    e = ChangeEvent(path='a', kind='modify', timestamp=time.time(), source='fs')
    watcher._emit(e)
    assert len(received) == 1

def testRecordAndGetRecentChanges():
    """record_change and get_recent_changes work together."""
    import uuid
    sid = f'v2-env-{uuid.uuid4().hex[:8]}'
    recordChange(sid, {'path': 'a.py', 'kind': 'modify', 'timestamp': time.time(), 'source': 'fs'})
    changes = getRecentChanges(sid, max_age_seconds=300)
    assert len(changes) == 1
    assert changes[0]['path'] == 'a.py'

def testGetRecentChangesFiltersOld():
    """Changes older than max_age_seconds are filtered out."""
    import uuid
    sid = f'v2-env-old-{uuid.uuid4().hex[:8]}'
    recordChange(sid, {'path': 'old.py', 'kind': 'modify', 'timestamp': time.time() - 1000, 'source': 'fs'})
    changes = getRecentChanges(sid, max_age_seconds=300)
    assert len(changes) == 0