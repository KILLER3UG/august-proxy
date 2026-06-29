"""v2 — Test [CRITICAL] prefix preservation through Tier 3 injection."""
import pytest
from app.services import daemon_manager
from app.services.workbench.workbench import _build_daemon_updates


@pytest.fixture(autouse=True)
def _cleanup():
    if hasattr(daemon_manager, "_daemons"):
        daemon_manager._daemons.clear()
    yield
    if hasattr(daemon_manager, "_daemons"):
        daemon_manager._daemons.clear()


def test_critical_prefix_preserved_in_daemon_output():
    """When a daemon output starts with [CRITICAL], the prefix is in the XML."""
    mgr = daemon_manager.get_manager()
    mgr._daemons.clear()

    # Manually populate a daemon with [CRITICAL] output
    result = daemon_manager.DaemonResult()
    result.status = "triggered"
    result.triggered = True
    result.output = "[CRITICAL] Database is down"
    mgr._daemons["test-id"] = {
        "id": "test-id",
        "name": "db_watcher",
        "session_id": "test-session",
        "prompt": "watch",
        "watch_condition": "on_match:DOWN",
        "result": result,
    }

    xml = _build_daemon_updates("test-session")
    assert "<subconscious_updates>" in xml
    assert "</subconscious_updates>" in xml
    assert "db_watcher" in xml
    assert "[CRITICAL] Database is down" in xml


def test_no_subconscious_updates_block_when_no_daemons():
    """When no daemons exist for the session, the block is empty."""
    mgr = daemon_manager.get_manager()
    mgr._daemons.clear()
    xml = _build_daemon_updates("empty-session")
    assert xml == ""


def test_non_critical_output_included():
    """Non-critical daemon output is also rendered (not just metadata)."""
    mgr = daemon_manager.get_manager()
    mgr._daemons.clear()
    result = daemon_manager.DaemonResult()
    result.status = "triggered"
    result.triggered = True
    result.output = "Build passed, version 1.2.3"
    mgr._daemons["ci-id"] = {
        "id": "ci-id",
        "name": "ci_watcher",
        "session_id": "test-session",
        "prompt": "watch",
        "watch_condition": "on_change",
        "result": result,
    }
    xml = _build_daemon_updates("test-session")
    assert "ci_watcher" in xml
    assert "Build passed" in xml
