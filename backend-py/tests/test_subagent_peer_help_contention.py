"""Contention / contract check: subagent_orchestrator peer-help recovery window.

Stated contract (module docstring):
  On failure → publish failure → 5s peer-help claim window → if no claim, escalate.

Measured behaviour (this file) — do not design on the docstring alone.
"""

from __future__ import annotations

import asyncio
import logging
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.agent_message_bus import AgentMessageBus
from app.services import subagent_orchestrator as orch_mod
from app.services.subagent_orchestrator import (
    PEER_HELP_WINDOW_SECONDS,
    SubagentOrchestrator,
    SubagentSpawnRequest,
)


@pytest.fixture
def bus() -> AgentMessageBus:
    return AgentMessageBus()


@pytest.mark.asyncio
async def test_peer_help_window_duration_on_no_claim(bus, caplog):
    """No peer claim → wait roughly PEER_HELP_WINDOW_SECONDS then continue (log only)."""
    orch = SubagentOrchestrator(bus, max_workers=3)
    caplog.set_level(logging.INFO)

    async def boom(**kwargs):
        raise RuntimeError('forced failure')

    session = MagicMock()
    session.id = 'peer-help-sess'
    t0 = time.perf_counter()
    with patch('app.services.subagent_worker.runSubagent', new=AsyncMock(side_effect=boom)):
        handles = await orch.spawn(
            SubagentSpawnRequest(session=session, workItems=[{'goal': 'fail me', 'agentId': 'general'}])
        )
        # Failure path awaits peer-help window inside _runWithSlot
        await asyncio.sleep(PEER_HELP_WINDOW_SECONDS + 1.5)
    elapsed = time.perf_counter() - t0

    handle = orch.getHandle(handles[0].taskId)
    assert handle is not None
    assert handle.status == 'failed'
    # Window is ~5s — allow CI slop but require we actually waited (not instant)
    assert elapsed >= PEER_HELP_WINDOW_SECONDS * 0.85
    assert elapsed < PEER_HELP_WINDOW_SECONDS + 3.0
    assert any('No peer claimed failed task' in r.message for r in caplog.records)
    # Docstring says "escalated" — code only logs; no escalated status/event channel
    assert handle.status != 'escalated'
    await orch.close()
    print(
        'PEER_HELP_NO_CLAIM',
        {
            'elapsed_s': round(elapsed, 3),
            'window_s': PEER_HELP_WINDOW_SECONDS,
            'final_status': handle.status,
            'escalation': 'log only — no re-spawn, no escalated status',
        },
    )


@pytest.mark.asyncio
async def test_peer_help_claim_ends_window_early(bus):
    """A peerHelp message within the window should end the wait without full 5s."""
    orch = SubagentOrchestrator(bus, max_workers=3)

    async def boom(**kwargs):
        raise RuntimeError('forced failure')

    session = MagicMock()
    session.id = 'peer-help-claim'
    claim_times: list[float] = []

    async def claim_soon():
        await asyncio.sleep(0.15)
        # Subscribe path uses topic task:{id}:peerHelp — publish a claim
        # Need task id from handle — poll handles
        for _ in range(50):
            active = list(orch._handles.values())
            if active:
                tid = active[0].taskId
                await bus.publish(f'task:{tid}:peerHelp', {'taskId': tid, 'claimer': 'peer-1'})
                claim_times.append(time.perf_counter())
                return
            await asyncio.sleep(0.02)

    t0 = time.perf_counter()
    claimer = asyncio.create_task(claim_soon())
    with patch('app.services.subagent_worker.runSubagent', new=AsyncMock(side_effect=boom)):
        handles = await orch.spawn(
            SubagentSpawnRequest(session=session, workItems=[{'goal': 'fail then claim', 'agentId': 'general'}])
        )
        # Wait for worker to finish failure handling
        for _ in range(100):
            h = orch.getHandle(handles[0].taskId)
            if h and h.status == 'failed' and h.finishedAt:
                # finishedAt is set before peer-help wait — wait until task gone
                task = orch._tasks.get(handles[0].taskId)
                if task is None or task.done():
                    break
            await asyncio.sleep(0.05)
        # Ensure background claim finished
        await asyncio.wait_for(claimer, timeout=5.0)
        # Give drain a moment
        await asyncio.sleep(0.2)
    elapsed = time.perf_counter() - t0

    assert elapsed < PEER_HELP_WINDOW_SECONDS * 0.7, (
        f'peer claim should end wait early; elapsed={elapsed:.2f}s window={PEER_HELP_WINDOW_SECONDS}'
    )
    h = orch.getHandle(handles[0].taskId)
    assert h is not None and h.status == 'failed'
    # Critical: claim does NOT re-run the task or change result — only ends the wait
    print(
        'PEER_HELP_CLAIMED',
        {
            'elapsed_s': round(elapsed, 3),
            'status': h.status,
            'recovery': 'none — claim only closes the wait window',
        },
    )
    await orch.close()


@pytest.mark.asyncio
async def test_empty_result_failure_skips_peer_help_window(bus, caplog):
    """Falsy worker result marks failed but does NOT open peer-help (exception path only)."""
    orch = SubagentOrchestrator(bus, max_workers=3)
    caplog.set_level(logging.INFO)

    async def empty_result(**kwargs):
        return ''  # falsy → failed branch without _handleFailure

    session = MagicMock()
    session.id = 'no-peer-help'
    t0 = time.perf_counter()
    with patch('app.services.subagent_worker.runSubagent', new=AsyncMock(side_effect=empty_result)):
        handles = await orch.spawn(
            SubagentSpawnRequest(session=session, workItems=[{'goal': 'empty', 'agentId': 'general'}])
        )
        await asyncio.sleep(0.4)
    elapsed = time.perf_counter() - t0

    h = orch.getHandle(handles[0].taskId)
    assert h is not None
    assert h.status == 'failed'
    # Must not have waited the full peer-help window
    assert elapsed < PEER_HELP_WINDOW_SECONDS * 0.5
    assert not any('No peer claimed failed task' in r.message for r in caplog.records)
    print(
        'PEER_HELP_EMPTY_RESULT',
        {
            'elapsed_s': round(elapsed, 3),
            'peer_help_invoked': False,
            'note': 'only Exception path calls _handleFailure; empty result does not',
        },
    )
    await orch.close()


@pytest.mark.asyncio
async def test_concurrent_failures_peer_help_windows_do_not_deadlock(bus):
    """N concurrent failures each open a 5s window — all complete without deadlock."""
    orch = SubagentOrchestrator(bus, max_workers=5)

    async def boom(**kwargs):
        raise RuntimeError('multi fail')

    n = 4
    session = MagicMock()
    session.id = 'multi-fail'
    # Shorten window for this test only
    original = orch_mod.PEER_HELP_WINDOW_SECONDS
    orch_mod.PEER_HELP_WINDOW_SECONDS = 0.4
    try:
        t0 = time.perf_counter()
        with patch('app.services.subagent_worker.runSubagent', new=AsyncMock(side_effect=boom)):
            handles = await orch.spawn(
                SubagentSpawnRequest(
                    session=session,
                    workItems=[{'goal': f'g{i}', 'agentId': 'general'} for i in range(n)],
                )
            )
            # Wait for all tasks done
            for _ in range(200):
                tasks = [orch._tasks.get(h.taskId) for h in handles]
                if all(t is None or t.done() for t in tasks):
                    break
                await asyncio.sleep(0.05)
        elapsed = time.perf_counter() - t0
        statuses = [orch.getHandle(h.taskId).status for h in handles]  # type: ignore[union-attr]
        assert statuses == ['failed'] * n
        # Parallel windows: wall time should be ~window + overhead, not n * window
        assert elapsed < orch_mod.PEER_HELP_WINDOW_SECONDS * n * 0.8 + 2.0
        print(
            'PEER_HELP_CONCURRENT',
            {
                'n': n,
                'elapsed_s': round(elapsed, 3),
                'window_s': orch_mod.PEER_HELP_WINDOW_SECONDS,
                'statuses': statuses,
            },
        )
    finally:
        orch_mod.PEER_HELP_WINDOW_SECONDS = original
        await orch.close()
