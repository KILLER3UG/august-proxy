"""Sub-agent output must survive every non-clean exit.

Regression: ``runSubagent`` returned only the ``error`` string whenever
``executeSubAgent`` reported anything other than ``completed``, discarding
``subResult['result']``. The loop-cap path in ``workbench/subagent.py`` puts the
worker's ENTIRE accumulated answer in that field under status ``partial``, so a
sub-agent that did substantial real work and then hit the round cap reported
only ``[loop cap reached]`` to the parent model, and the orchestrator persisted
``subagent_runs.result_full = ''``. That is the canonical "sub-agent output never
came back" failure.

These tests drive ``runSubagent`` with a stubbed ``executeSubAgent`` so the
worker-boundary contract is pinned without any provider, DB, or event loop.
"""

from __future__ import annotations

import sys
import types

import pytest
from app.services import subagent_worker
from app.services.agent_message_bus import AgentMessageBus
from app.services.subagent_orchestrator import SubagentOrchestrator


class _StubSession:
    """Minimal stand-in for WorkbenchSession — the worker only sets attributes."""

    id = 'sess_stub'


_BUS = AgentMessageBus()


@pytest.fixture
def stubExecute(monkeypatch):
    """Install a fake ``app.services.workbench.subagent.executeSubAgent``."""

    def _install(returnValue):
        calls = {}

        async def _fake(session, agentId, goal, context, **kwargs):
            calls['agentId'] = agentId
            calls['goal'] = goal
            calls['kwargs'] = kwargs
            return returnValue

        mod = types.ModuleType('app.services.workbench.subagent')
        mod.executeSubAgent = _fake
        monkeypatch.setitem(sys.modules, 'app.services.workbench.subagent', mod)
        return calls

    return _install


@pytest.mark.asyncio
async def test_partial_run_preserves_the_accumulated_answer(stubExecute):
    """A capped ('partial') worker keeps its whole answer — the exact shape
    produced by the managed tool-round cap in executeSubAgent."""
    answer = '[loop cap reached] tool round limit 25 exceeded\nHere is the analysis I produced.'
    stubExecute({
        'jobId': 'job_1',
        'agentId': 'a1',
        'status': 'partial',
        'error': '[loop cap reached] tool round limit 25 exceeded',
        'result': answer,
    })

    out = await subagent_worker.runSubagent(
        _BUS, _StubSession(), 'a1', 'do the thing', '', taskId='t1',
    )

    assert out['status'] == 'partial', 'partial must not be flattened to failed'
    assert out['result'] == answer, 'the accumulated answer must not be discarded'
    assert out['error']


@pytest.mark.asyncio
async def test_partial_answer_reaches_the_orchestrator_record(stubExecute):
    """End of the old loss chain: what _record_run persists as result_full is
    handle.result['result'], so preserving 'result' here is what makes the
    drawer's replayable output non-empty."""
    answer = 'substantial work product from the sub-agent'
    stubExecute({
        'jobId': 'job_2', 'agentId': 'a1', 'status': 'partial',
        'error': 'capped', 'result': answer,
    })

    out = await subagent_worker.runSubagent(
        _BUS, _StubSession(), 'a1', 'goal', '', taskId='t2',
    )

    # Mirrors SubagentOrchestrator._record_run's summary extraction.
    summary = str(out.get('result') or out.get('output') or out.get('summary') or '').strip()
    assert summary == answer


@pytest.mark.asyncio
async def test_failed_run_still_carries_partial_output(stubExecute):
    """A hard failure keeps status='failed' (so tallies stay honest) but does
    not throw away whatever text the worker managed to produce."""
    stubExecute({
        'jobId': 'job_3', 'agentId': 'a1', 'status': 'failed',
        'error': 'provider 500', 'result': 'partial findings before the crash',
    })

    out = await subagent_worker.runSubagent(
        _BUS, _StubSession(), 'a1', 'goal', '', taskId='t3',
    )

    assert out['status'] == 'failed'
    assert out['error'] == 'provider 500'
    assert out['result'] == 'partial findings before the crash'


@pytest.mark.asyncio
async def test_completed_run_is_unchanged(stubExecute):
    """The happy path must be byte-identical to before the fix."""
    stubExecute({
        'jobId': 'job_4', 'agentId': 'a1', 'status': 'completed', 'result': 'all done',
    })

    out = await subagent_worker.runSubagent(
        _BUS, _StubSession(), 'a1', 'goal', '', taskId='t4',
    )

    assert out == {
        'taskId': 't4', 'agentId': 'a1', 'status': 'completed', 'result': 'all done',
    }


@pytest.mark.asyncio
async def test_worker_exception_still_reports_failure(stubExecute):
    """An exception out of executeSubAgent keeps the existing failure shape."""

    async def _boom(*a, **k):
        raise RuntimeError('kaboom')

    mod = types.ModuleType('app.services.workbench.subagent')
    mod.executeSubAgent = _boom
    sys.modules['app.services.workbench.subagent'] = mod
    try:
        out = await subagent_worker.runSubagent(
            _BUS, _StubSession(), 'a1', 'goal', '', taskId='t5',
        )
    finally:
        sys.modules.pop('app.services.workbench.subagent', None)

    assert out['status'] == 'failed'
    assert 'kaboom' in out['error']


def test_orchestrator_partial_branch_is_reachable():
    """Guard against the regression returning: the orchestrator tallies
    status=='partial' distinctly, and that branch is only reachable if the
    worker stops flattening the status."""
    result = {'status': 'partial', 'result': 'work', 'error': 'capped'}
    assert SubagentOrchestrator._result_is_failure(result) is False
    assert str(result.get('status')).lower() == 'partial'
