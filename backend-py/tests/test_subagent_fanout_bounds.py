"""Fan-out bounds for sub-agents: bounded concurrency, bounded children per
turn, bounded aggregate work per dispatch — and observable when any of them
binds.

What these tests are for
------------------------
A constant's value proves nothing; a model asking for a fleet is the thing that
must not balloon a developer laptop. Every bound here is therefore measured
INSIDE a fake worker (a live counter incremented on entry, decremented on exit,
with the maximum recorded), across a dispatch that asks for far more children
than the bound allows.

Three claims, three shapes of test:

  * **Concurrency** — the pool never runs more children than the limit *at the
    same instant*, and the excess QUEUEs rather than vanishes (every requested
    lane still answers).
  * **Children per turn** — asking for more than the cap is refused with a
    ``[Proxy Self-Heal]`` receipt and starts NOTHING (not a silent truncation),
    and the cap is a setting, not a literal.
  * **Aggregate work** — one round budget across ALL children of one dispatch,
    charged by the real sub-agent loop, so N children cannot collectively do N
    times the work.

Plus the gate's own failure modes (a cancelled or timed-out waiter must not
strand a slot — a leaked permit wedges a session for the whole acquire
timeout), and the telemetry an auditor reads afterwards.
"""

from __future__ import annotations

import asyncio
import types
from typing import Any

import pytest
from app.services import subagent_worker as sw
from app.services.agent_message_bus import AgentMessageBus
from app.services.subagent_orchestrator import (
    SubagentOrchestrator,
    SubagentSpawnRequest,
)
from app.services.workbench import subagent_fanout as fanout

# The loop-cap harness (tests/test_subagent_cap_break.py) drives the REAL
# executeSubAgent against a stubbed model call, which is what an aggregate-work
# test needs: the bound has to be charged by the thing that actually loops.
from tests.test_subagent_cap_break import _patch_env as _patch_loop_env
from tests.test_subagent_cap_break import _tool_only_response


def _session(sid: str = 'sess_fanout') -> types.SimpleNamespace:
    return types.SimpleNamespace(
        id=sid,
        model='m',
        provider='',
        agentId='',
        agent_id='',
        subagent_depth=0,
        metadata={},
        workspacePath='',
    )


def _patchDelegation(monkeypatch: pytest.MonkeyPatch, **overrides: object) -> None:
    """Force one answer from the single resolver both doors read."""
    limits = dict(fanout._delegation_source())
    limits.update(overrides)
    monkeypatch.setattr('app.services.brain_config_service.getDelegationLimits', lambda: limits)


def _useSessionForSpawn(monkeypatch: pytest.MonkeyPatch, session: types.SimpleNamespace) -> None:
    """Make the orchestrator's session lookup return `session`.

    spawn() reads `delegation` off the WORKBENCH session it looks up by id (not
    off the object handed in), so a per-session override has to be reachable
    through that lookup for the fairness gate to bind.
    """
    from app.services.workbench import workbench as wb

    monkeypatch.setattr(wb, 'getWorkbenchSession', lambda sid: session if sid == session.id else None)


class _Fleet:
    """Stand-in for ``runSubagent`` that measures its own concurrency.

    Each fake child runs exactly one model round and charges it to its
    dispatch's shared budget, the way a real child charges every round of its
    loop — so the ledger these tests assert on is fed by the same call the
    production loop makes.
    """

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.inFlight = 0
        self.peak = 0
        self.violated = 0
        self.calls = 0

    async def __call__(self, **kwargs: Any) -> dict[str, Any]:
        self.inFlight += 1
        self.peak = max(self.peak, self.inFlight)
        if self.inFlight > self.limit:
            self.violated = self.inFlight
        self.calls += 1
        fanout.charge_fanout_round(str(kwargs.get('harness_job_id') or ''))
        try:
            await asyncio.sleep(0.01)
        finally:
            self.inFlight -= 1
        return {
            'taskId': str(kwargs.get('taskId') or ''),
            'agentId': 'general',
            'status': 'completed',
            'result': f"finished {kwargs.get('goal')}",
        }


def _installFleet(monkeypatch: pytest.MonkeyPatch, limit: int) -> _Fleet:
    fleet = _Fleet(limit)
    monkeypatch.setattr(sw, 'runSubagent', fleet)
    return fleet


# ── 1. concurrency: bounded, and the bound is a setting ────────────────────


@pytest.mark.asyncio
async def test_peak_concurrency_never_exceeds_the_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    """Twelve children into a pool of 3: three at a time, all twelve done.

    The counter lives inside the fake worker, so the assertion is about what
    actually ran concurrently — not about the value of a constant.
    """
    _patchDelegation(monkeypatch, maxChildrenPerTurn=24, maxConcurrent=3)
    fleet = _installFleet(monkeypatch, limit=3)
    orch = SubagentOrchestrator(AgentMessageBus(), max_workers=3)
    handles = await orch.spawn(
        SubagentSpawnRequest(session=_session(), workItems=[{'goal': f'lane {i}'} for i in range(12)])
    )
    assert len(handles) == 12, 'a bounded pool must queue, not drop lanes'
    results = await orch.waitForAll(handles)

    assert fleet.violated == 0, f'pool of 3 ran {fleet.violated} children at once'
    assert fleet.peak == 3, f'expected the pool to be saturated, peak was {fleet.peak}'
    assert len(results) == 12
    assert all(r['status'] == 'completed' for r in results), results
    assert fleet.calls == 12


@pytest.mark.asyncio
async def test_pool_follows_brain_config_without_a_restart(monkeypatch: pytest.MonkeyPatch) -> None:
    """The SAME orchestrator changes its applied limit between dispatches.

    An explicit ``max_workers`` stays pinned (that is the compatibility being
    kept for tests and any caller wanting a fixed fleet), so this builds the
    pool unpinned — which is what runtime_services now does.
    """
    _patchDelegation(monkeypatch, maxChildrenPerTurn=24, maxConcurrent=2)
    fleet = _installFleet(monkeypatch, limit=99)
    orch = SubagentOrchestrator(AgentMessageBus())
    # The pool is constructed at the default and re-applied from brain config on
    # each dispatch — reading config in the constructor is precisely the
    # restart-required behaviour this avoids.
    await orch.waitForAll(await orch.spawn(_wave([f'a{i}' for i in range(6)])))
    assert orch.workerPoolSnapshot()['limit'] == 2, orch.workerPoolSnapshot()
    assert fleet.peak == 2

    # Settings → Subagents moved. No new orchestrator, no restart.
    _patchDelegation(monkeypatch, maxChildrenPerTurn=24, maxConcurrent=5)
    fleet.peak = 0
    await orch.waitForAll(await orch.spawn(_wave([f'b{i}' for i in range(6)])))
    assert orch.workerPoolSnapshot()['limit'] == 5
    # Peak occupancy is NOT asserted here. The pool is only one of two gates: a
    # per-session fairness semaphore also binds, and this test never gives the
    # looked-up session its own delegation, so the session gate — not the
    # raised pool limit — decides how many ran. Asserting a peak here would
    # measure the fairness gate while reading like a test of hot re-application,
    # which line above already proves.


def _wave(goals: list[str]) -> SubagentSpawnRequest:
    return SubagentSpawnRequest(session=_session(), workItems=[{'goal': g} for g in goals])


@pytest.mark.asyncio
async def test_desktop_ceiling_bounds_a_request_for_thirty(monkeypatch: pytest.MonkeyPatch) -> None:
    """maxConcurrent=30 is intent; the process pool stays inside the ceiling.

    A desktop backend shares the machine with the IDE and the Tauri shell, and
    the panel may legitimately run on a workstation — so the applied number is
    reported NEXT TO the requested one rather than silently disagreeing.
    """
    _patchDelegation(monkeypatch, maxChildrenPerTurn=24, maxConcurrent=30)
    ceiling = fanout.SUBAGENT_CONCURRENCY_CEILING
    fleet = _installFleet(monkeypatch, limit=ceiling)
    orch = SubagentOrchestrator(AgentMessageBus())
    await orch.waitForAll(await orch.spawn(_wave([f'c{i}' for i in range(10)])))

    assert orch.workerPoolSnapshot()['limit'] == ceiling
    assert fleet.violated == 0
    assert fleet.peak == ceiling
    assert ceiling > 1, 'a ceiling must still allow real parallelism'


@pytest.mark.asyncio
async def test_per_session_gate_still_fairs_one_session_below_the_pool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """min(per-session intent, pool) survives — 2 for the session, 8 for the pool.

    Without this the pool change would have flattened the layering that stops
    one chatty session occupying every slot.
    """
    _patchDelegation(monkeypatch, maxChildrenPerTurn=24, maxConcurrent=8)
    fleet = _installFleet(monkeypatch, limit=2)
    session = _session('sess_fair')
    session.metadata = {'delegation': {'maxConcurrent': 2, 'maxChildrenPerTurn': 24}}
    _useSessionForSpawn(monkeypatch, session)

    orch = SubagentOrchestrator(AgentMessageBus(), max_workers=8)
    await orch.waitForAll(
        await orch.spawn(
            SubagentSpawnRequest(session=session, workItems=[{'goal': f'd{i}'} for i in range(6)])
        )
    )

    assert fleet.violated == 0, f'the per-session gate leaked: {fleet.violated} at once'
    assert fleet.peak == 2, f'the per-session gate did not bind: {fleet.peak}'


# ── 2. children per dispatch: refuse loudly, never truncate silently ───────


@pytest.mark.asyncio
async def test_over_cap_dispatch_is_refused_and_nothing_starts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.tools import spawn_subagents_tool as sst

    _patchDelegation(monkeypatch, maxChildrenPerTurn=3)
    spawned = {'calls': 0}

    class _NeverOrchestrator:
        async def spawn(self, request: SubagentSpawnRequest) -> list[Any]:
            spawned['calls'] += 1
            return []

        def workerPoolSnapshot(self) -> dict[str, Any]:
            return {}

    events: list[dict[str, Any]] = []
    result = await sst.executeSpawnSubagents(
        _NeverOrchestrator(),  # type: ignore[arg-type]
        _session('sess_cap_refuse'),
        [{'goal': f'lane {i}'} for i in range(9)],
        mode='auto',
        emit=events.append,
        background=False,
    )

    assert spawned['calls'] == 0, 'an over-cap dispatch must not reach the pool at all'
    assert result['status'] == 'error'
    assert result['reason'] == 'children-cap'
    assert result['requested'] == 9 and result['childrenCap'] == 3
    assert result['total'] == 0
    # The self-heal convention: says what to do instead, says it is
    # runtime-only so it never gets filed back as a durable memory, and admits
    # nothing ran so the parent does not wait on six phantom lanes.
    assert '[Proxy Self-Heal]' in result['error']
    assert 'at most 3' in result['error']
    assert 'NOTHING WAS STARTED' in result['error']
    assert 'runtime resource limit' in result['error']

    refused = [e for e in events if e.get('type') == 'subagentFanout']
    assert refused and refused[0]['phase'] == 'refused'
    assert refused[0]['childrenCap'] == 3 and refused[0]['requested'] == 9


@pytest.mark.asyncio
async def test_exactly_the_cap_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    """The bound is inclusive — 3 of 3 must not be rejected as an overflow."""
    _patchDelegation(monkeypatch, maxChildrenPerTurn=3, fanoutRoundBudget=0)
    fleet = _installFleet(monkeypatch, limit=99)
    orch = SubagentOrchestrator(AgentMessageBus(), max_workers=2)
    handles = await orch.spawn(_wave([f'e{i}' for i in range(3)]))
    assert len(handles) == 3
    assert not [h for h in handles if h.status == 'failed']
    await orch.waitForAll(handles)
    assert fleet.calls == 3


@pytest.mark.asyncio
async def test_orchestrator_backstop_refuses_the_excess_with_a_receipt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A caller that skips the tool still cannot exceed the cap silently.

    Refused lanes come back as failed handles carrying the same self-heal text,
    so the parent's tally counts the loss instead of waiting on lanes that were
    never launched.
    """
    _patchDelegation(monkeypatch, maxChildrenPerTurn=4)
    fleet = _installFleet(monkeypatch, limit=4)
    orch = SubagentOrchestrator(AgentMessageBus(), max_workers=4)
    handles = await orch.spawn(_wave([f'f{i}' for i in range(10)]))

    assert len(handles) == 10, 'every requested lane must answer, refused ones included'
    refused = [h for h in handles if h.status == 'failed' and 'Proxy Self-Heal' in h.error]
    assert len(refused) == 6, [h.status for h in handles]
    assert '10 sub-agents' in refused[0].error
    results = await orch.waitForAll(handles)
    assert sum(1 for r in results if r['status'] == 'failed') == 6
    assert fleet.violated == 0


# ── 3. aggregate work: one budget across the whole fleet ───────────────────


def test_round_budget_is_shared_across_children() -> None:
    """Six rounds for a fleet of four, not six each.

    Direct on the ledger the worker loop charges, so the arithmetic of the
    bound is pinned independently of how many children get scheduled.
    """
    fanout.reset_fanout_registry()
    fanout.begin_fanout('fan_shared', round_budget=6, children_requested=4)
    granted = [fanout.charge_fanout_round('fan_shared') for _ in range(10)]
    assert granted.count(True) == 6, granted
    snap = fanout.fanout_snapshot('fan_shared')
    assert snap['roundsUsed'] == 6 and snap['roundBudget'] == 6
    ended = fanout.end_fanout('fan_shared')
    assert ended['stoppedBy'] == 'round-budget', ended


def test_budget_zero_is_an_optout_but_still_counts() -> None:
    """0 means "no aggregate bound", not "no rounds" — and stays measurable."""
    fanout.reset_fanout_registry()
    fanout.begin_fanout('fan_unbounded', round_budget=0)
    assert all(fanout.charge_fanout_round('fan_unbounded') for _ in range(50))
    assert fanout.fanout_snapshot('fan_unbounded')['roundsUsed'] == 50
    assert fanout.end_fanout('fan_unbounded')['stoppedBy'] == 'finished'


def test_unknown_fanout_is_not_bounded_by_a_budget_never_opened() -> None:
    """A child outside a dispatch (daemon, recurring task) keeps old behaviour."""
    fanout.reset_fanout_registry()
    assert all(fanout.charge_fanout_round('fan_never_begun') for _ in range(20))
    assert all(fanout.charge_fanout_round('') for _ in range(20))
    assert fanout.active_fanout_count() == 0


def test_fanout_registry_itself_is_bounded() -> None:
    """The ledger of dispatches must not be the thing that grows without limit."""
    fanout.reset_fanout_registry()
    for i in range(400):
        fanout.begin_fanout(f'fan_leak_{i}', round_budget=10)
    assert fanout.active_fanout_count() <= fanout._MAX_RETAINED_FANOUTS


@pytest.mark.asyncio
async def test_children_of_one_dispatch_share_one_round_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Four real child loops × their own 50-round cap is the hole this closes.

    Each child is the genuine ``executeSubAgent`` against a stubbed model that
    always asks for another tool round, so the only thing that can stop it is
    its own cap or the dispatch's shared budget. The sum of model calls across
    all four must be the budget — never budget × 4.
    """
    from app.services.workbench.subagent import executeSubAgent

    counter = _patch_loop_env_for(monkeypatch, cap=50)
    fanout.reset_fanout_registry()
    fanout.begin_fanout('fan_budget', round_budget=6, children_requested=4)

    async def _child(index: int) -> dict[str, Any]:
        return await executeSubAgent(
            _session('sess_budget'),
            'general',
            f'lane {index}',
            'ctx',
            harness_job_id='fan_budget',
            task_id=f'task_budget_{index}',
        )

    try:
        results = await asyncio.gather(*(_child(i) for i in range(4)))
    finally:
        snap = fanout.end_fanout('fan_budget')

    assert counter['calls'] == 6, (
        f"the shared budget did not bound the fleet: {counter['calls']} model calls for a budget of 6"
    )
    assert snap['roundsUsed'] == 6
    assert snap['stoppedBy'] == 'round-budget'
    bounded = [r for r in results if 'shared round budget' in str(r.get('error') or '')]
    assert bounded, [r.get('error') for r in results]
    # A bounded run is never tallied as a clean completion (the same rule as the
    # per-child loop cap): partial when it produced text, failed when it did not.
    assert all(str(r.get('status')) in ('partial', 'failed') for r in bounded), results


@pytest.mark.asyncio
async def test_a_child_with_no_dispatch_is_bounded_only_by_its_own_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Backwards compatibility: the per-child cap still does the work alone."""
    from app.services.workbench.subagent import executeSubAgent

    counter = _patch_loop_env_for(monkeypatch, cap=3)
    fanout.reset_fanout_registry()
    result = await executeSubAgent(_session('sess_nobudget'), 'general', 'solo', 'ctx', task_id='task_solo')

    assert counter['calls'] == 3, counter
    assert '[loop cap reached]' in str(result.get('error'))
    assert 'round budget' not in str(result.get('error'))
    assert fanout.active_fanout_count() == 0


def _patch_loop_env_for(monkeypatch: pytest.MonkeyPatch, cap: int) -> dict[str, int]:
    """Reuse the cap-break harness, with a call counter it can hand back.

    `_patch_env` only fakes the provider plumbing; the cap-break test supplies
    the tool-only reply separately. Without that reply a child gets a final
    answer on its first round and returns cleanly, so neither its own cap nor
    the dispatch budget is ever reached — the counters came back as one call
    per child and the budget tests could not fail loudly even if the bound were
    missing entirely.
    """
    counters: dict[str, int] = {'calls': 0}

    _patch_loop_env(monkeypatch, cap)
    import app.services.workbench.workbench as wb

    async def _tool_only_then_count(messages, systemText, model, tools, effort,
                                    provider=None, emit=None):
        counters['calls'] += 1
        return _tool_only_response()

    monkeypatch.setattr(wb, '_callAnthropicWorkbench', _tool_only_then_count)
    return counters


# ── 4. the gate itself: no stranded slots ──────────────────────────────────


@pytest.mark.asyncio
async def test_cancelled_waiter_does_not_strand_a_slot() -> None:
    """Cancellation while queued must leave the pool exactly as it was found.

    A leaked permit shrinks the pool permanently, and the symptom is a later
    spawn that queues for the whole timeout and returns nothing — which reads
    as a sub-agent that silently produced no answer.
    """
    gate = fanout.ConcurrencyGate(1, name='test')
    assert await gate.acquire(timeout=1) is True

    parked = asyncio.create_task(gate.acquire(timeout=30))
    await asyncio.sleep(0.01)
    assert not parked.done()
    parked.cancel()
    with pytest.raises(asyncio.CancelledError):
        await parked

    assert gate.in_use == 1, gate.snapshot()
    gate.release()
    assert gate.in_use == 0
    # ...and the pool is whole, not permanently one short.
    assert await gate.acquire(timeout=1) is True
    assert gate.snapshot()['queued'] == 0
    gate.release()


@pytest.mark.asyncio
async def test_timed_out_acquire_returns_false_and_admits_later() -> None:
    gate = fanout.ConcurrencyGate(1, name='test')
    assert await gate.acquire(timeout=1) is True
    assert await gate.acquire(timeout=0.05) is False
    assert gate.snapshot()['slotTimeouts'] == 1
    gate.release()
    assert await gate.acquire(timeout=0.05) is True
    assert gate.in_use == 1, 'a timeout must not have consumed a permit'
    gate.release()


@pytest.mark.asyncio
async def test_shrinking_the_limit_stops_admissions_without_breaking_holders() -> None:
    """Settings can move while children run; a shrink binds the next acquire."""
    gate = fanout.ConcurrencyGate(4, name='test')
    for _ in range(4):
        assert await gate.acquire(timeout=1) is True
    gate.set_limit(2)
    assert await gate.acquire(timeout=0.05) is False
    gate.release()
    assert await gate.acquire(timeout=0.05) is False, 'still at the new limit of 2'
    assert gate.in_use == 3
    for _ in range(3):
        gate.release()
    assert gate.in_use == 0
    assert await gate.acquire(timeout=0.05) is True
    gate.release()


@pytest.mark.asyncio
async def test_growth_wakes_a_queued_child() -> None:
    gate = fanout.ConcurrencyGate(1, name='test')
    assert await gate.acquire(timeout=1) is True
    waiter = asyncio.create_task(gate.acquire(timeout=5))
    await asyncio.sleep(0.01)
    assert not waiter.done()
    gate.set_limit(2)
    gate.release()  # the release is what delivers the wake
    assert await waiter is True
    assert gate.in_use == 1
    gate.release()


@pytest.mark.asyncio
async def test_gate_admits_exactly_limit_workers_under_pressure() -> None:
    """Forty takers, gate of 4: never more than four inside, all forty through."""
    gate = fanout.ConcurrencyGate(4, name='test')
    inside = {'now': 0, 'peak': 0, 'done': 0}

    async def _take() -> None:
        assert await gate.acquire(timeout=30) is True
        inside['now'] += 1
        inside['peak'] = max(inside['peak'], inside['now'])
        try:
            await asyncio.sleep(0)
        finally:
            inside['now'] -= 1
            inside['done'] += 1
            gate.release()

    await asyncio.gather(*(_take() for _ in range(40)))
    assert inside['peak'] == 4, inside
    assert inside['done'] == 40
    assert gate.in_use == 0


# ── 5. observability: an auditor can read what the cap was ─────────────────


@pytest.mark.asyncio
async def test_fanout_event_and_outcome_row_report_the_bounds(monkeypatch: pytest.MonkeyPatch) -> None:
    """A dispatch records its caps and its observed peak, in both mechanisms.

    ``subagentFanout`` in the session event log (the turn_end convention, per
    session) and a ``turn_outcomes`` row with task_type='subagent_fanout' (the
    counter convention, durable) — the two mechanisms the repo already has, not
    a third.
    """
    from app.services import memory_store
    from app.services.tools import spawn_subagents_tool as sst

    _patchDelegation(monkeypatch, maxChildrenPerTurn=24, maxConcurrent=2, fanoutRoundBudget=40)
    fleet = _installFleet(monkeypatch, limit=2)
    events: list[dict[str, Any]] = []
    memory_store.init()

    orch = SubagentOrchestrator(AgentMessageBus())
    result = await sst.executeSpawnSubagents(
        orch,
        _session('sess_telemetry'),
        [{'goal': f'g{i}'} for i in range(5)],
        mode='auto',
        emit=events.append,
        background=False,
    )

    fanoutEvents = [e for e in events if e.get('type') == 'subagentFanout']
    phases = [e.get('phase') for e in fanoutEvents]
    assert 'dispatched' in phases and 'ended' in phases, phases
    ended = next(e for e in fanoutEvents if e.get('phase') == 'ended')
    assert ended['concurrencyLimit'] == 2
    assert ended['childrenCap'] == 24
    assert ended['roundBudget'] == 40
    # The peak answers "did the cap bind this run": five lanes requested, two
    # ran at once, so the pool was the bound.
    assert ended['childrenPeak'] == 2 == fleet.peak, ended
    assert ended['roundsUsed'] == 5
    assert result['fanout']['concurrencyLimit'] == 2, result

    rows = memory_store._conn().execute(
        "SELECT end_reason, rounds, task_type FROM turn_outcomes WHERE task_type = 'subagent_fanout'"
    ).fetchall()
    assert len(rows) == 1, f'one dispatch must write exactly one row, got {len(rows)}'
    assert rows[0]['end_reason'] == 'finished'
    assert rows[0]['rounds'] == 5


@pytest.mark.asyncio
async def test_refused_dispatch_records_the_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    """The refusal is durable too, with the cap that bound it."""
    from app.services import memory_store
    from app.services.tools import spawn_subagents_tool as sst

    _patchDelegation(monkeypatch, maxChildrenPerTurn=2)
    memory_store.init()
    await sst.executeSpawnSubagents(
        SubagentOrchestrator(AgentMessageBus()),
        _session('sess_refuse_row'),
        [{'goal': 'a'}, {'goal': 'b'}, {'goal': 'c'}],
        mode='auto',
        emit=None,
        background=True,
    )
    row = memory_store._conn().execute(
        "SELECT end_reason, rounds FROM turn_outcomes WHERE task_type = 'subagent_fanout' "
        'ORDER BY id DESC LIMIT 1'
    ).fetchone()
    assert row is not None
    assert row['end_reason'] == 'children-cap'
    assert row['rounds'] == 0


@pytest.mark.asyncio
async def test_round_budget_stop_is_recorded_as_the_bound_that_bit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An ended fleet says WHICH bound stopped it, in the row an audit reads."""
    from app.services import memory_store
    from app.services.tools import spawn_subagents_tool as sst

    _patchDelegation(monkeypatch, maxChildrenPerTurn=24, maxConcurrent=2, fanoutRoundBudget=3)
    fanout.reset_fanout_registry()
    memory_store.init()

    async def _chargingChild(**kwargs: Any) -> dict[str, Any]:
        # A worker that keeps looping until the shared budget refuses it.
        fid = str(kwargs.get('harness_job_id') or '')
        rounds = 0
        while fanout.charge_fanout_round(fid):
            rounds += 1
            await asyncio.sleep(0)
        return {
            'taskId': str(kwargs.get('taskId') or ''),
            'agentId': 'general',
            'status': 'partial',
            'result': f'{rounds} rounds then the budget',
        }

    monkeypatch.setattr(sw, 'runSubagent', _chargingChild)
    events: list[dict[str, Any]] = []
    orch = SubagentOrchestrator(AgentMessageBus())
    await sst.executeSpawnSubagents(
        orch,
        _session('sess_budget_stop'),
        [{'goal': f'x{i}'} for i in range(4)],
        mode='auto',
        emit=events.append,
        background=False,
    )
    ended = next(e for e in events if e.get('type') == 'subagentFanout' and e.get('phase') == 'ended')
    assert ended['roundBudget'] == 3
    assert ended['roundsUsed'] == 3, ended
    assert ended['reason'] == 'round-budget', ended
    row = memory_store._conn().execute(
        "SELECT end_reason, rounds FROM turn_outcomes WHERE task_type = 'subagent_fanout' "
        'ORDER BY id DESC LIMIT 1'
    ).fetchone()
    assert row['end_reason'] == 'round-budget'
    assert row['rounds'] == 3


def test_messages_say_runtime_only() -> None:
    """Both receipts must mark themselves runtime-only, per AGENTS.md."""
    cap_msg = fanout.children_cap_message(12, 8)
    budget_msg = fanout.round_budget_message('fan_x', 240, 240)
    for text in (cap_msg, budget_msg):
        assert text.startswith('[Proxy Self-Heal]')
        assert 'runtime' in text.lower()
        assert 'durable' in text.lower()


def test_defaults_are_desktop_conservative_but_parallel() -> None:
    """Pin the shipped numbers AGENTS.md quotes, and their shape.

    Not a substitute for the behavioural tests above — this only catches a
    default drifting away from what the docs tell an agent to plan against.
    """
    assert fanout.SUBAGENT_CONCURRENCY_DEFAULT == 4
    assert fanout.SUBAGENT_CONCURRENCY_CEILING == 8
    assert fanout.MAX_CHILDREN_PER_FANOUT_DEFAULT == 8
    assert fanout.FANOUT_ROUND_BUDGET_DEFAULT == 240
    # 240 rounds over 8 children is 30 per lane: a lane can still do a real
    # job, while eight children cannot each burn the full default depth.
    assert fanout.FANOUT_ROUND_BUDGET_DEFAULT // fanout.MAX_CHILDREN_PER_FANOUT_DEFAULT == 30
    limits = fanout.resolve_fanout_limits()
    assert limits.concurrency == 4 and limits.max_children_per_fanout == 8
    # The brain-config schema and the resolver must not disagree.
    from app.services.brain_config_service import getDefaults

    defaults = getDefaults()
    assert defaults['subagentMaxConcurrent'] == fanout.SUBAGENT_CONCURRENCY_DEFAULT
    assert defaults['subagentMaxChildrenPerTurn'] == fanout.MAX_CHILDREN_PER_FANOUT_DEFAULT
    assert defaults['subagentFanoutRoundBudget'] == fanout.FANOUT_ROUND_BUDGET_DEFAULT


def test_brain_config_accepts_the_new_keys_and_their_optout() -> None:
    from app.services.brain_config_service import validatePatch

    assert validatePatch({'subagentMaxChildrenPerTurn': 8}) == (True, '')
    assert validatePatch({'subagentFanoutRoundBudget': 0})[0] is True, '0 is the documented opt-out'
    assert validatePatch({'subagentFanoutRoundBudget': 240})[0] is True
    assert validatePatch({'subagentMaxChildrenPerTurn': 0})[0] is False
    assert validatePatch({'subagentMaxChildrenPerTurn': 25})[0] is False
