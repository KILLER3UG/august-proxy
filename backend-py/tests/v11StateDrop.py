"""v1.1 — Test that plan submit/reject clears execution state and working memory."""
import pytest
from app.services.workbench import workbench as wbMod
from app.services.workbench.workbench import submitPlan, rejectWorkbenchPlan

class FakeSession:

    def __init__(self):
        self.plan = {'steps': ['old step 1']}
        self.planApproved = False
        self._executionState = {'phase': 'implement', 'step': 3, 'completed': ['x']}
        self._workingMemory = 'stale scratchpad text'
        self.id = 'test-session'
        self.updatedAt = None

@pytest.fixture(autouse=True)
def _silenceStatusEmit(monkeypatch):
    """Avoid the SSE emit path which requires a full WorkbenchSession."""
    monkeypatch.setattr(wbMod, '_emit_session_status', lambda _id: None)
    monkeypatch.setattr(wbMod, 'saveSessions', lambda: None)
    yield

def testSubmitPlanClearsExecutionState():
    """submit_plan must reset _execution_state and _working_memory."""
    session = FakeSession()
    submitPlan(session, {'steps': ['new step 1']})
    assert session.plan == {'steps': ['new step 1']}
    assert session.planApproved is False
    assert session._execution_state is None
    assert session._working_memory is None

def testRejectWorkbenchPlanClearsExecutionState():
    """reject_workbench_plan must reset _execution_state and _working_memory."""
    session = FakeSession()
    wbMod._sessions['test-session'] = session
    rejectWorkbenchPlan('test-session')
    assert session.plan is None
    assert session.planApproved is False
    assert session._execution_state is None
    assert session._working_memory is None
    del wbMod._sessions['test-session']