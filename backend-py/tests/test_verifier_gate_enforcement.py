"""Verifier gate enforcement — update_state rejects review/complete without
a passing command receipt this turn (Phase B)."""

import pytest
from app.services.tool_registrations import system_tools

# ── _verificationVerdict unit tests ────────────────────────────────────


def testVerdictNoneWithoutReceipts():
    assert system_tools._verificationVerdict([])[0] == 'none'


def testVerdictPassOnExitZero():
    receipts = [{'name': 'run_command', 'content': '5 passed in 1.2s\nExit code: 0'}]
    verdict, _ = system_tools._verificationVerdict(receipts)
    assert verdict == 'pass'


def testVerdictFailOnNonZeroExit():
    receipts = [{'name': 'run_command', 'content': 'boom\nExit code: 1'}]
    verdict, detail = system_tools._verificationVerdict(receipts)
    assert verdict == 'fail'
    assert 'exited 1' in detail


def testVerdictFailWhenMixedSummary():
    # "2 failed, 10 passed" must NOT pass just because 'passed' appears.
    receipts = [{'name': 'run_command', 'content': '2 failed, 10 passed'}]
    assert system_tools._verificationVerdict(receipts)[0] == 'fail'


def testVerdictPassOnCleanRunMarker():
    receipts = [{'name': 'run_command', 'content': '0 failed'}]
    assert system_tools._verificationVerdict(receipts)[0] == 'pass'


def testVerdictPassOnWeakMarker():
    receipts = [{'name': 'run_command', 'content': 'tests passed'}]
    assert system_tools._verificationVerdict(receipts)[0] == 'pass'


def testVerdictMostRecentReceiptWins():
    receipts = [
        {'name': 'run_command', 'content': 'Exit code: 1'},
        {'name': 'run_command', 'content': 'Exit code: 0'},
    ]
    assert system_tools._verificationVerdict(receipts)[0] == 'pass'


def testVerdictUnclearGetsBenefitOfDoubt():
    receipts = [{'name': 'run_command', 'content': 'done doing things'}]
    assert system_tools._verificationVerdict(receipts)[0] == 'unclear'


# ── update_state gate integration ──────────────────────────────────────


class _FakeSession:
    def __init__(self, phase: str = 'implement', receipts=None):
        self._execution_state = {'phase': phase, 'step': 1}
        self._verification_receipts = receipts


@pytest.fixture
def patchedSession(monkeypatch):
    """Patch get_session/updateSessionState inside the workbench module
    (system_tools imports them lazily from there)."""
    from app.services.workbench import workbench as wb

    holder: dict = {}

    async def _fakeUpdate(session, executionState=None, **_kw):
        holder['state'] = executionState
        session._execution_state = executionState

    monkeypatch.setattr(wb, 'get_session', lambda: holder.get('session'))
    monkeypatch.setattr(wb, 'updateSessionState', _fakeUpdate)
    return holder


@pytest.mark.asyncio
async def testGateBlocksReviewWithoutRun(patchedSession):
    patchedSession['session'] = _FakeSession(phase='implement', receipts=None)
    result = await system_tools._updateState(phase='review', step=1)
    assert 'Verifier gate' in result
    assert 'state' not in patchedSession  # never persisted


@pytest.mark.asyncio
async def testGateBlocksReviewOnFailedRun(patchedSession):
    receipts = [{'name': 'run_command', 'content': '3 failed\nExit code: 1'}]
    patchedSession['session'] = _FakeSession(phase='implement', receipts=receipts)
    result = await system_tools._updateState(phase='review', step=1)
    assert 'did not pass' in result
    assert 'state' not in patchedSession


@pytest.mark.asyncio
async def testGateAllowsReviewAfterPassingRun(patchedSession):
    receipts = [{'name': 'run_command', 'content': '12 passed\nExit code: 0'}]
    patchedSession['session'] = _FakeSession(phase='implement', receipts=receipts)
    result = await system_tools._updateState(phase='review', step=1)
    assert result.startswith('State updated')
    assert patchedSession['state']['phase'] == 'review'


@pytest.mark.asyncio
async def testGateIgnoresNonGatePhases(patchedSession):
    # implement → implement needs no verification.
    patchedSession['session'] = _FakeSession(phase='implement', receipts=None)
    result = await system_tools._updateState(phase='implement', step=2)
    assert result.startswith('State updated')


@pytest.mark.asyncio
async def testGateSkippedWhenAlreadyInReview(patchedSession):
    # Updating step/blockers while already in review must not re-gate.
    patchedSession['session'] = _FakeSession(phase='review', receipts=None)
    result = await system_tools._updateState(phase='review', step=3)
    assert result.startswith('State updated')
