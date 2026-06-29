"""v2 — Test daemon watch conditions."""
import pytest
from app.services import daemon_manager
from app.services.tool_registry import clear_daemon_context


@pytest.fixture(autouse=True)
def _cleanup():
    clear_daemon_context()
    if hasattr(daemon_manager, "_daemons"):
        daemon_manager._daemons.clear()
    yield
    if hasattr(daemon_manager, "_daemons"):
        daemon_manager._daemons.clear()


def test_max_three_concurrent_daemons():
    """spawn() returns an error string on 4th daemon (caller checks for "Error: max")."""
    import asyncio
    mgr = daemon_manager.DaemonManager()
    sid = "test-max-session"
    # Kill any tasks from prior tests
    for d in list(mgr._tasks.values()):
        try:
            d.cancel()
        except Exception:
            pass
    mgr._tasks.clear()
    mgr._daemons.clear()

    spec1 = daemon_manager.DaemonSpec(name="d1", prompt="x", watch_condition="on_completion")
    spec2 = daemon_manager.DaemonSpec(name="d2", prompt="x", watch_condition="on_completion")
    spec3 = daemon_manager.DaemonSpec(name="d3", prompt="x", watch_condition="on_completion")
    spec4 = daemon_manager.DaemonSpec(name="d4", prompt="x", watch_condition="on_completion")

    async def go():
        r1 = await mgr.spawn(spec1, session_id=sid)
        r2 = await mgr.spawn(spec2, session_id=sid)
        r3 = await mgr.spawn(spec3, session_id=sid)
        r4 = await mgr.spawn(spec4, session_id=sid)
        # First 3 succeed, 4th returns error
        assert not r1.startswith("Error"), f"r1 unexpected: {r1}"
        assert not r2.startswith("Error"), f"r2 unexpected: {r2}"
        assert not r3.startswith("Error"), f"r3 unexpected: {r3}"
        assert r4.startswith("Error"), f"r4 should be error: {r4}"
        assert "max" in r4.lower() or "3" in r4

    asyncio.run(go())


def test_on_completion_fires_after_first_run():
    """`on_completion` triggers after the daemon's first run completes."""
    mgr = daemon_manager.DaemonManager()
    info = {
        "result": type("R", (), {"output": "first run output"})(),
        "watch_condition": "on_completion",
    }
    fired = mgr._evaluate_watch(info)
    assert fired is True


def test_on_match_keyword_substring_case_insensitive():
    """`on_match:ERROR` fires when output contains 'error' (case-insensitive)."""
    mgr = daemon_manager.DaemonManager()
    info_fine = {
        "result": type("R", (), {"output": "everything is fine"})(),
        "watch_condition": "on_match:ERROR",
    }
    fired = mgr._evaluate_watch(info_fine)
    assert fired is False

    info_err = {
        "result": type("R", (), {"output": "got an Error here"})(),
        "watch_condition": "on_match:ERROR",
    }
    fired = mgr._evaluate_watch(info_err)
    assert fired is True

    info_upper = {
        "result": type("R", (), {"output": "ERROR FOUND"})(),
        "watch_condition": "on_match:ERROR",
    }
    fired = mgr._evaluate_watch(info_upper)
    assert fired is True


def test_on_change_fires_on_hash_diff():
    """`on_change` fires when output md5 differs from previous cycle."""
    mgr = daemon_manager.DaemonManager()
    # Use the same DaemonResult instance so previous_hash persists
    result = daemon_manager.DaemonResult()
    info1 = {
        "result": result,
        "watch_condition": "on_change",
    }
    result.output = "output A"
    # First call sets baseline (no previous → no change)
    fired = mgr._evaluate_watch(info1)
    # Second call same = no change
    fired = mgr._evaluate_watch(info1)
    assert fired is False
    # Third call different = change
    result.output = "output B"
    fired = mgr._evaluate_watch(info1)
    assert fired is True
