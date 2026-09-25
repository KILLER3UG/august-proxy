"""Sub-agent result delivery — one test per path a result travels.

The user-visible symptom was "sometimes a subagent does not return its output to
the main agent, especially in the UI". Ten earlier commits (`5d67e565`,
`555baa34`, `d1938423`, `8624d9f9`, `199b48e5`, `cb626b40`, `5162051a`,
`f14452d0`, `72e729dc`, `2535a119`) each patched ONE of the four paths —
spawn → return-to-model → stream-to-UI → render — which is why the symptom kept
surviving: fixing the emitter left the truncation, and fixing the truncation
left the reducer. These tests are grouped by path so a regression in any single
one of them fails loudly rather than silently.
"""

from __future__ import annotations

import asyncio

import pytest


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.config import settings
    from app.lib import paths
    from app.services.workbench import sessions as sess

    monkeypatch.setattr(paths, 'dataDir', lambda: tmp_path)
    settings.dataDir = tmp_path
    sess._sessions.clear()
    yield
    sess._sessions.clear()


# ── PATH 1: return-to-model ────────────────────────────────────────────────


def test_answer_selector_prefers_the_final_round_over_the_narration_blob():
    """The child's conclusion is its last round, not the accumulation.

    `executeSubAgent` appends every round's text to `finalText`, so the answer
    sits at the END of a growing blob of narration. Feeding that blob to a
    head-only truncation is what delivered the narration and dropped the answer.
    """
    from app.services.workbench.subagent import _subagent_answer

    assert _subagent_answer('let me look\nstill working\nTHE ANSWER', 'THE ANSWER') == 'THE ANSWER'
    # A capped or interrupted run never reached a final round — the
    # accumulation is the honest record then, not nothing.
    assert _subagent_answer('partial progress', '') == 'partial progress'
    assert _subagent_answer('   ', '   ') == ''


def test_clip_keeps_the_tail_and_says_what_it_omitted():
    from app.services.workbench.subagent import _clip

    text = 'HEAD' + ('x' * 20_000) + 'THE_ACTUAL_ANSWER'
    clipped = _clip(text, 4000)
    assert 'THE_ACTUAL_ANSWER' in clipped, 'a head-only clip destroyed the answer'
    assert clipped.startswith('HEAD')
    assert 'omitted' in clipped
    # Under the cap, untouched.
    assert _clip('short', 4000) == 'short'


def test_completion_notice_delivers_the_tail_of_a_long_result():
    from app.services.tools.spawn_subagents_tool import _format_completion_notice

    narration = 'thinking out loud\n' * 2000
    answer = 'FINAL: the migration is in app/migrations/049.sql'
    result = {
        'taskId': 'task_abc',
        'agentId': 'research',
        'status': 'completed',
        'goal': 'find the migration',
        'result': {'result': narration + answer},
    }
    notice = _format_completion_notice(result)
    assert answer in notice, 'the parent received the narration but not the conclusion'
    assert 'SUBAGENT_COMPLETE' in notice and 'task_abc' in notice


def test_completion_notice_for_a_skipped_lane_names_the_reason():
    """A lane the DAG never launched must still be reported to the parent."""
    from app.services.tools.spawn_subagents_tool import _format_completion_notice

    notice = _format_completion_notice(
        {
            'taskId': 'skip_job_0-1',
            'agentId': 'general',
            'status': 'skipped',
            'error': 'Skipped because alpha waited on a failed workstream.',
        }
    )
    assert 'status="skipped"' in notice
    assert 'Skipped because alpha' in notice
    assert '(empty result)' not in notice


@pytest.mark.asyncio
async def test_enqueue_completion_reaches_the_parent_queue(monkeypatch):
    from app.services.tools import spawn_subagents_tool as sst

    sent: list[tuple[str, str]] = []

    def fake_enqueue(sid, text, kind='subagent'):
        sent.append((sid, text))

    monkeypatch.setattr('app.services.workbench.workbench.enqueueUserMessage', fake_enqueue)

    session = {'id': 'wb_parent'}
    sst._enqueue_completion(
        session,
        {
            'taskId': 'task_1',
            'agentId': 'general',
            'status': 'completed',
            'result': {'result': 'the answer'},
        },
    )
    assert len(sent) == 1, 'the completion never entered the parent queue'
    assert 'the answer' in sent[0][1]


# ── PATH 2: spawn + stream-to-UI announcement ──────────────────────────────


@pytest.mark.asyncio
async def test_skipped_lane_announces_itself_before_it_settles():
    """A `subagentDone` with no matching `subagentStart` is dropped by design.

    The chat reducer refuses to resurrect a row for a ghost frame, so every lane
    the backend can settle must announce itself first — including one the DAG
    skipped. Previously the skip emitted `jobId: ''`, which failed the reducer's
    falsy-jobId guard, so an entire lane vanished from the UI.
    """
    from app.services.agent_message_bus import AgentMessageBus
    from app.services.subagent_orchestrator import SubagentOrchestrator
    from app.services.tools.spawn_subagents_tool import _doSpawn
    from app.services.workbench.sessions import create_workbench_session

    async def failing_worker(**kwargs):
        return {'taskId': kwargs.get('taskId'), 'agentId': 'general', 'status': 'failed', 'error': 'boom', 'result': ''}

    import app.services.subagent_worker as worker

    original = worker.runSubagent
    worker.runSubagent = failing_worker  # type: ignore[assignment]
    try:
        bus = AgentMessageBus()
        orch = SubagentOrchestrator(bus, max_workers=2)
        session = create_workbench_session()
        events: list[dict] = []
        await _doSpawn(
            orch,
            session,
            [
                {'name': 'alpha', 'goal': 'first', 'agentId': 'general'},
                {'name': 'beta', 'goal': 'second', 'agentId': 'general', 'dependsOn': ['alpha']},
            ],
            emit=events.append,
            background=False,
        )
    finally:
        worker.runSubagent = original  # type: ignore[assignment]

    starts = [e for e in events if e.get('type') == 'subagentStart']
    dones = [e for e in events if e.get('type') == 'subagentDone']
    assert dones, 'nothing settled'

    skip_done = next((e for e in dones if e.get('status') == 'skipped'), None)
    assert skip_done is not None, f'the skipped lane was never reported: {[e.get("status") for e in dones]}'
    assert skip_done['jobId'], 'an empty jobId is dropped by the UI reducer'
    assert any(e['jobId'] == skip_done['jobId'] for e in starts), (
        'the skipped lane settled without ever announcing itself'
    )
    assert all(e['jobId'] for e in dones), 'every settled lane needs a non-empty jobId'


# ── PATH 3: orchestration durability ───────────────────────────────────────


@pytest.mark.asyncio
async def test_acquire_slot_does_not_leak_a_permit_when_cancelled():
    """A leaked permit wedges a session: later spawns queue for the full timeout
    and then fail with an empty result. Both `wait_for(sem.acquire(), t)` exits
    could strand a permit, and a Stop-all CancelledError propagated past the
    releasing `finally`."""
    from app.services.subagent_orchestrator import _acquire_slot

    sem = asyncio.Semaphore(2)
    assert await _acquire_slot(sem, 1) is True
    assert sem._value == 1
    sem.release()

    # Contended + timed out: no permit is conjured away.
    held = asyncio.Semaphore(1)
    assert await held.acquire() is True
    assert await _acquire_slot(held, 0.05) is False
    assert held._value == 0
    held.release()
    assert held._value == 1

    # Cancelled while queued.
    busy = asyncio.Semaphore(1)
    assert await busy.acquire() is True
    task = asyncio.create_task(_acquire_slot(busy, 30))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    busy.release()
    assert busy._value == 1, 'the pool shrank permanently'
    # The slot is still usable afterwards.
    assert await _acquire_slot(busy, 1) is True


@pytest.mark.asyncio
async def test_session_permit_is_released_when_the_global_acquire_is_cancelled(monkeypatch, tmp_path):
    """The historical leak: the per-session permit was taken, then a Stop-all
    cancelled the GLOBAL acquire, and the releasing `finally` was further down
    the function so it never ran."""
    from app.services import subagent_orchestrator as so
    from app.services.agent_message_bus import AgentMessageBus
    from app.services.subagent_orchestrator import (
        SubagentHandle,
        SubagentOrchestrator,
        SubagentSpawnRequest,
    )

    bus = AgentMessageBus()
    orch = SubagentOrchestrator(bus, max_workers=5)
    session_sem = asyncio.Semaphore(2)

    real_acquire = so._acquire_slot

    async def fake_acquire(sem, timeout):
        if sem is orch._semaphore:
            raise asyncio.CancelledError
        return await real_acquire(sem, timeout)

    monkeypatch.setattr(so, '_acquire_slot', fake_acquire)

    handle = SubagentHandle(taskId='task_leak', agentId='general', goal='g', sessionId='s')
    with pytest.raises(asyncio.CancelledError):
        await orch._runWithSlot(
            handle=handle,
            request=SubagentSpawnRequest(session=None, workItems=[]),
            agentId='general',
            goal='g',
            context='',
            restrictedTools=None,
            session_semaphore=session_sem,
        )
    assert session_sem._value == 2, 'the per-session permit leaked on cancellation'


def test_orphaned_run_rows_are_swept_at_startup():
    """A row left at `running` by a restart spins forever: nothing can move it
    again, and the drawer maps it to "working"."""
    from app.services import memory_store
    from app.services.subagent_orchestrator import sweep_orphaned_runs

    memory_store.init()
    conn = memory_store._conn()
    for task_id, status in (
        ('t_run', 'running'),
        ('t_queued', 'queued'),
        ('t_done', 'completed'),
    ):
        conn.execute(
            'INSERT INTO subagent_runs (task_id, session_id, agent_id, goal, status, result_full) '
            'VALUES (?, ?, ?, ?, ?, ?)',
            (task_id, 's1', 'general', 'goal', status, 'partial output kept'),
        )
    conn.commit()

    assert sweep_orphaned_runs() == 2

    rows = dict(conn.execute('SELECT task_id, status FROM subagent_runs').fetchall())
    assert rows['t_run'] == 'lost'
    assert rows['t_queued'] == 'lost'
    assert rows['t_done'] == 'completed', 'a settled row must not be rewritten'
    kept = conn.execute('SELECT result_full FROM subagent_runs WHERE task_id = ?', ('t_run',)).fetchone()[0]
    assert kept == 'partial output kept', 'the sweep must not destroy what the child wrote down'
    # Idempotent: a second boot marks nothing new.
    assert sweep_orphaned_runs() == 0
