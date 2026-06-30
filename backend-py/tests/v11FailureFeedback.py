"""v1.1 — Test that tool errors populate session._failure_feedback with structured info."""
import pytest
from app.services.workbench.workbench import _executeTool
from app.services import workbench as wbMod

class FakeSession:
    """Minimal WorkbenchSession stand-in for testing."""

    def __init__(self):
        self._failureFeedback = None
        self._failureFeedbackAge = None
        self.id = 'test-session'
        self.status = 'idle'
        self.sessionId = 'test-session'

@pytest.mark.asyncio
async def testToolErrorPopulatesFailureFeedback(monkeypatch):
    """When dispatch_tool raises, _failure_feedback is set with structured info."""

    async def fakeDispatch(toolName, args):
        raise SyntaxError('invalid syntax')
    from app.services import toolRegistry
    monkeypatch.setattr(toolRegistry, 'dispatch', fakeDispatch)
    session = FakeSession()
    result = await _executeTool(tool_name='run_command', args={'command': 'def foo(:', 'cwd': '/tmp'}, session=session)
    assert isinstance(result, str)
    assert 'SyntaxError' in result or 'failed' in result
    assert session._failure_feedback is not None, f'_failure_feedback not set. session attrs: {dir(session)}'
    fb = session._failure_feedback
    assert fb['tool'] == 'run_command'
    assert fb['error_type'] == 'SyntaxError'
    assert 'invalid syntax' in fb['error_message']

@pytest.mark.asyncio
async def testToolSuccessDoesNotSetFailureFeedback(monkeypatch):
    """Happy path: no failure_feedback is set."""

    async def fakeDispatch(toolName, args):
        return 'ok'
    from app.services import toolRegistry
    monkeypatch.setattr(toolRegistry, 'dispatch', fakeDispatch)
    session = FakeSession()
    result = await _executeTool(tool_name='read_file', args={'path': '/tmp/x'}, session=session)
    assert result == 'ok'
    assert session._failure_feedback is None