"""v1.1 — Test that tool errors populate session._failure_feedback with structured info."""
import pytest
from app.services.workbench.workbench import _execute_tool
from app.services import workbench as wb_mod


class FakeSession:
    """Minimal WorkbenchSession stand-in for testing."""
    def __init__(self):
        self._failure_feedback = None
        self._failure_feedback_age = None
        self.id = "test-session"
        # WorkbenchSession has many fields, but _execute_tool only touches
        # .id (via contextvar) and the failure_feedback attributes we set.
        self.status = "idle"
        self.session_id = "test-session"


@pytest.mark.asyncio
async def test_tool_error_populates_failure_feedback(monkeypatch):
    """When dispatch_tool raises, _failure_feedback is set with structured info."""
    async def fake_dispatch(tool_name, args):
        raise SyntaxError("invalid syntax")

    # _execute_tool does `from app.services.tool_registry import dispatch as dispatch_tool`
    # at call time (line 1909). Patch the source module's `dispatch`.
    from app.services import tool_registry
    monkeypatch.setattr(tool_registry, "dispatch", fake_dispatch)

    session = FakeSession()

    result = await _execute_tool(
        tool_name="run_command",
        args={"command": "def foo(:", "cwd": "/tmp"},
        session=session,
    )

    # Result is still returned as a string (backward compat)
    assert isinstance(result, str)
    assert "SyntaxError" in result or "failed" in result

    # session._failure_feedback is now populated with structured info
    assert session._failure_feedback is not None, (
        f"_failure_feedback not set. session attrs: {dir(session)}"
    )
    fb = session._failure_feedback
    assert fb["tool"] == "run_command"
    assert fb["error_type"] == "SyntaxError"
    assert "invalid syntax" in fb["error_message"]


@pytest.mark.asyncio
async def test_tool_success_does_not_set_failure_feedback(monkeypatch):
    """Happy path: no failure_feedback is set."""
    async def fake_dispatch(tool_name, args):
        return "ok"

    from app.services import tool_registry
    monkeypatch.setattr(tool_registry, "dispatch", fake_dispatch)

    session = FakeSession()
    result = await _execute_tool(
        tool_name="read_file",
        args={"path": "/tmp/x"},
        session=session,
    )
    assert result == "ok"
    assert session._failure_feedback is None
