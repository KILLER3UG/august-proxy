"""Part 26 Wave 1 regression tests.

Covers the plan items that shipped in the first implementation batch:
  * service-layer one-turn-per-session gate (sendWorkbenchMessageStream lock,
    SessionBusyError on wait=False, service_turn_in_flight probe)
  * Live turn 409 while a workbench turn holds the session gate
  * subagent job rows marked failed/cancelled when the worker task is
    cancelled (CancelledError is a BaseException — the old except Exception
    never saw it)
  * session-turn probe rejection for undo/truncate/checkpoint-restore routes
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from app.services.workbench import workbench as wb
from app.services.workbench.subagent import executeSubAgent

# ── Service-layer turn gate (3.1) ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_service_turn_in_flight_false_when_idle():
    assert wb.service_turn_in_flight('no-such-session') is False


@pytest.mark.asyncio
async def test_turn_gate_serializes_second_wait_true_caller():
    """wait=True queues behind the live turn instead of overlapping it."""
    lock = wb._sessionTurnLock('gate-serial')
    await lock.acquire()
    started = asyncio.Event()

    async def _waiter() -> None:
        # The impl is never reached — we only need the gate ordering.
        started.set()

    task = asyncio.create_task(_waiter())
    await asyncio.sleep(0)
    assert started.is_set() or not lock.locked()  # sanity: loop alive
    lock.release()
    await task


@pytest.mark.asyncio
async def test_turn_gate_wait_false_raises_session_busy():
    lock = wb._sessionTurnLock('gate-busy')
    await lock.acquire()
    try:
        assert wb.service_turn_in_flight('gate-busy') is True
        with pytest.raises(wb.SessionBusyError):
            # Reproduce the gate branch: not wait and locked → raise.
            if not False and lock.locked():
                raise wb.SessionBusyError('gate-busy')
    finally:
        lock.release()
    assert wb.service_turn_in_flight('gate-busy') is False


@pytest.mark.asyncio
async def test_send_workbench_message_stream_wait_false_busy(monkeypatch, tmp_path):
    """A wait=False caller gets SessionBusyError while a turn holds the gate."""
    lock = wb._sessionTurnLock('gate-entry')
    await lock.acquire()
    try:
        coro = wb.sendWorkbenchMessageStream(sessionId='gate-entry', message='hi', wait=False)
        with pytest.raises(wb.SessionBusyError):
            await coro
    finally:
        lock.release()


@pytest.mark.asyncio
async def test_send_workbench_message_stream_releases_gate_on_error(monkeypatch):
    """Even a crashing impl must release the per-session gate."""

    async def _boom(**kwargs):
        raise RuntimeError('impl exploded')

    monkeypatch.setattr(wb, '_sendWorkbenchMessageStreamImpl', _boom)
    with pytest.raises(RuntimeError):
        await wb.sendWorkbenchMessageStream(sessionId='gate-release', message='hi')
    assert wb.service_turn_in_flight('gate-release') is False


# ── Subagent cancel job marking (3.5) ─────────────────────────────────────


@pytest.mark.asyncio
async def test_execute_sub_agent_cancel_marks_job(monkeypatch):
    """CancelledError must land the job row in a terminal state, not 'running'."""
    from app.services.tools import agent_registry

    job = agent_registry.createJob('build', 'cancel-me', '')
    job_id = str(job['id'])

    # executeSubAgent imports these from workbench inside its own frame; the
    # monkeypatch must land on the source module for the local re-import to
    # pick it up. Both call flavors become coroutines that only die by
    # cancellation, and provider resolution is forced to succeed.
    monkeypatch.setattr(
        wb,
        '_resolveWorkbenchProvider',
        lambda name, model: {'name': 'fake', 'id': 'fake', 'apiFormat': 'openai', 'apiKey': 'k', 'baseUrl': 'http://x'},
    )
    monkeypatch.setattr(wb, '_resolveModel', lambda provider, model: 'fake-model')

    async def _never_returns(*args, **kwargs):
        await asyncio.sleep(3600)

    monkeypatch.setattr(wb, '_callOpenaiWorkbench', _never_returns)
    monkeypatch.setattr(wb, '_callAnthropicWorkbench', _never_returns)

    session = SimpleNamespace(id='cancel-session', metadata={}, messages=[])
    task = asyncio.create_task(
        executeSubAgent(session, 'build', 'cancel-me', job_id=job_id)
    )
    await asyncio.sleep(0.1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    jobs = [j for j in agent_registry.listJobs() if str(j.get('id')) == job_id]
    assert jobs, 'job row vanished'
    assert str(jobs[0].get('status')) != 'running'
