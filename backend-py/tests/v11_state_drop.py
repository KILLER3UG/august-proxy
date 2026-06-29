"""v1.1 — Test that plan submit/reject clears execution state and working memory."""
import pytest
from app.services.workbench import workbench as wb_mod
from app.services.workbench.workbench import submit_plan, reject_workbench_plan


class FakeSession:
    def __init__(self):
        self.plan = {"steps": ["old step 1"]}
        self.plan_approved = False
        self._execution_state = {"phase": "implement", "step": 3, "completed": ["x"]}
        self._working_memory = "stale scratchpad text"
        self.id = "test-session"
        self.updated_at = None


@pytest.fixture(autouse=True)
def _silence_status_emit(monkeypatch):
    """Avoid the SSE emit path which requires a full WorkbenchSession."""
    monkeypatch.setattr(wb_mod, "_emit_session_status", lambda _id: None)
    # reject_workbench_plan calls save_sessions() which writes a JSON file.
    # Stub it to avoid filesystem I/O in unit tests.
    monkeypatch.setattr(wb_mod, "save_sessions", lambda: None)
    yield


def test_submit_plan_clears_execution_state():
    """submit_plan must reset _execution_state and _working_memory."""
    session = FakeSession()
    submit_plan(session, {"steps": ["new step 1"]})
    assert session.plan == {"steps": ["new step 1"]}
    assert session.plan_approved is False
    # v1.1: state should be dropped
    assert session._execution_state is None
    assert session._working_memory is None


def test_reject_workbench_plan_clears_execution_state():
    """reject_workbench_plan must reset _execution_state and _working_memory."""
    session = FakeSession()
    # reject_workbench_plan takes a session_id and looks up the session;
    # for this test, we patch the global _sessions dict.
    wb_mod._sessions["test-session"] = session

    reject_workbench_plan("test-session")

    assert session.plan is None
    assert session.plan_approved is False
    assert session._execution_state is None
    assert session._working_memory is None

    # cleanup
    del wb_mod._sessions["test-session"]
