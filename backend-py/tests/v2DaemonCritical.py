"""v2 — Test [CRITICAL] prefix preservation through Tier 3 injection."""
import pytest
from app.services import daemon_manager
from app.services.workbench.workbench import _buildDaemonUpdates

@pytest.fixture(autouse=True)
def _cleanup():
    if hasattr(daemon_manager, '_daemons'):
        daemon_manager._daemons.clear()
    yield
    if hasattr(daemon_manager, '_daemons'):
        daemon_manager._daemons.clear()

def testCriticalPrefixPreservedInDaemonOutput():
    """When a daemon output starts with [CRITICAL], the prefix is in the XML."""
    mgr = daemon_manager.get_manager()
    mgr._daemons.clear()
    result = daemon_manager.DaemonResult()
    result.status = 'triggered'
    result.triggered = True
    result.output = '[CRITICAL] Database is down'
    mgr._daemons['test-id'] = {'id': 'test-id', 'name': 'db_watcher', 'session_id': 'test-session', 'prompt': 'watch', 'watch_condition': 'on_match:DOWN', 'result': result}
    xml = _buildDaemonUpdates('test-session')
    assert '<subconscious_updates>' in xml
    assert '</subconscious_updates>' in xml
    assert 'db_watcher' in xml
    assert '[CRITICAL] Database is down' in xml

def testNoSubconsciousUpdatesBlockWhenNoDaemons():
    """When no daemons exist for the session, the block is empty."""
    mgr = daemon_manager.get_manager()
    mgr._daemons.clear()
    xml = _buildDaemonUpdates('empty-session')
    assert xml == ''

def testNonCriticalOutputIncluded():
    """Non-critical daemon output is also rendered (not just metadata)."""
    mgr = daemon_manager.get_manager()
    mgr._daemons.clear()
    result = daemon_manager.DaemonResult()
    result.status = 'triggered'
    result.triggered = True
    result.output = 'Build passed, version 1.2.3'
    mgr._daemons['ci-id'] = {'id': 'ci-id', 'name': 'ci_watcher', 'session_id': 'test-session', 'prompt': 'watch', 'watch_condition': 'on_change', 'result': result}
    xml = _buildDaemonUpdates('test-session')
    assert 'ci_watcher' in xml
    assert 'Build passed' in xml