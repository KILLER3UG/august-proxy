"""v2 — End-to-end integration: chat + daemons + blackboard + verifier + consolidation."""
import asyncio
import json
import pytest
from app.services import (
    daemon_manager,
    blackboard_service,
    consolidation_daemon,
)
from app.services.memory_store import init, _conn
from app.services.workbench import workbench
from app.services.memory import context_builder
from app.services.workbench import model_fleet


@pytest.fixture(autouse=True)
def _init_db():
    init()
    if hasattr(daemon_manager, "_daemons"):
        daemon_manager._daemons.clear()
    yield
    if hasattr(daemon_manager, "_daemons"):
        daemon_manager._daemons.clear()


def test_chat_with_daemon_blackboard_and_verifier():
    """A chat turn integrates daemons, blackboard, and verifier gate."""
    import uuid
    sid = f"v2-e2e-{uuid.uuid4().hex[:8]}"

    # Setup: a triggered daemon
    mgr = daemon_manager.get_manager()
    mgr._daemons.clear()
    result = daemon_manager.DaemonResult()
    result.status = "triggered"
    result.triggered = True
    result.output = "3 failures in auth.py"
    mgr._daemons[f"{sid}_ci"] = {
        "id": f"{sid}_ci",
        "name": "ci_watcher",
        "session_id": sid,
        "prompt": "watch",
        "watch_condition": "on_match:FAIL",
        "result": result,
    }

    # Setup: a blackboard note
    blackboard_service.write_note(sid, "ci_watcher", "result", "Tests failing on line 45", 60)

    # Setup: execution state in review
    session = {
        "id": sid,
        "execution_state": {
            "phase": "review",
            "step": 3,
            "verification_command": "pytest tests/test_auth.py",
        },
        "subconscious_updates": [
            {"name": "ci_watcher", "status": "triggered", "result": "3 failures in auth.py"},
        ],
        "blackboard_state": blackboard_service.read_notes(sid),
    }

    # Build the prompt
    prompt = context_builder.build_system_prompt(session=session, memory={})

    # All three blocks should be present
    assert "ci_watcher" in prompt
    assert "<blackboard_state>" in prompt
    assert "<verifier_gate>" in prompt
    assert "pytest tests/test_auth.py" in prompt

    # Cleanup
    blackboard_service.clear_notes(sid)


def test_model_fleet_resolution():
    """get_model_for_role returns proper models for each cognitive role."""
    assert model_fleet.get_model_for_role("cerebellum") == "claude-3-haiku-20240307"
    assert model_fleet.get_model_for_role("hippocampus") == "claude-3-haiku-20240307"
    assert model_fleet.get_model_for_role("prefrontal") == "claude-3-5-sonnet-20240620"


@pytest.mark.asyncio
async def test_consolidation_runs_end_to_end(monkeypatch):
    """Consolidation runs, calls Hippocampus (mocked), writes through db_writer."""
    async def fake_call_hippocampus(prompt, **kwargs):
        return json.dumps({"merge": [], "promote": [], "delete": []})

    monkeypatch.setattr(consolidation_daemon, "_call_hippocampus", fake_call_hippocampus)
    # Should not raise
    stats = await consolidation_daemon.run_consolidation()
    assert "merged" in stats
    assert "promoted" in stats
    assert "deleted_stale" in stats


def test_env_watcher_ignore_patterns():
    """Environment watcher correctly filters noise files."""
    from app.services.environment_watcher import should_ignore
    assert should_ignore("__pycache__/foo.pyc") is True
    assert should_ignore("node_modules/x.js") is True
    assert should_ignore(".git/objects/abc") is True
    assert should_ignore("src/main.py") is False


def test_blackboard_ack_deletes():
    """Ack=True on read_notes deletes the note."""
    import uuid
    sid = f"v2-e2e-ack-{uuid.uuid4().hex[:8]}"
    blackboard_service.write_note(sid, "test", "k", "v", 60)
    notes = blackboard_service.read_notes(sid, ack=True)
    assert len(notes) >= 1
    notes2 = blackboard_service.read_notes(sid)
    assert notes2 == []


def test_pending_skills_table_exists():
    """pending_skills table is present and queryable."""
    conn = _conn()
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_skills'"
    ).fetchall()
    assert len(rows) == 1


def test_daemon_context_blocks_mutating_commands():
    """run_command blocked in daemon context (tool blocklist)."""
    from app.services.tool_registry import (
        set_daemon_context, clear_daemon_context, is_command_blocked,
    )
    set_daemon_context()
    assert is_command_blocked("rm -rf /tmp") is True
    assert is_command_blocked("mv x y") is True
    assert is_command_blocked("ls") is False
    clear_daemon_context()
