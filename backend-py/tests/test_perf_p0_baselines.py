"""Performance baselines — measurement only (no optimisations under test).

Records mock-LLM workbench overhead and multi-agent/blackboard contention
timings. Does not assert hard product SLOs yet (budgets are recorded for the
Progress Log); only fails if instrumentation is broken or paths error.
"""

from __future__ import annotations

import asyncio
import statistics
import time
from typing import Any, AsyncIterator

import pytest
from app.lib.perf_timing import (
    aggregate_summaries,
    clear_traces,
    recent_traces,
)
from app.services.workbench import workbench as wb


class StubClient:
    """Zero-network Anthropic stream stub (fixed tiny payload)."""

    def __init__(self, mode: str = 'text_once') -> None:
        self.mode = mode
        self.call_count = 0

    def resolveApiKey(self) -> str:
        return 'stub-key'

    async def messages_stream(self, body: object) -> AsyncIterator[dict[str, object]]:
        self.call_count += 1
        await asyncio.sleep(0)  # yield; no artificial delay
        if self.mode == 'text_once':
            yield {
                '_event_type': 'content_block_start',
                'content_block': {'type': 'text', 'text': 'ok'},
            }
            yield {
                '_event_type': 'content_block_delta',
                'delta': {'type': 'text_delta', 'text': 'ok'},
            }
            yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 2}}
        elif self.mode == 'one_tool':
            yield {
                '_event_type': 'content_block_start',
                'content_block': {
                    'type': 'tool_use',
                    'id': f'toolu_{self.call_count}',
                    'name': 'list_skills',
                    'input': {},
                },
            }
            yield {
                '_event_type': 'content_block_delta',
                'delta': {'type': 'input_json_delta', 'partial_json': '{}'},
            }
            yield {'_event_type': 'content_block_stop'}
            yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
            self.mode = 'text_once'


STUB_PROVIDER = {
    'name': 'stub-anthropic',
    'apiMode': 'anthropicMessages',
    'default_model': 'stub-claude',
    'model_profiles': {},
}


@pytest.fixture
def stub_workbench(monkeypatch, isolatedData):
    """Stub provider + empty session store; enable AUGUST_PERF_TIMING."""
    import app.providers.clients as clientsMod
    from app.services import provider_credentials as providerCredsMod
    from app.services.workbench import sessions as sessions_mod

    monkeypatch.setenv('AUGUST_PERF_TIMING', '1')
    empty: dict = {}
    monkeypatch.setattr(sessions_mod, '_sessions', empty)
    monkeypatch.setattr(wb, '_sessions', empty)
    monkeypatch.setattr(wb, '_resolveWorkbenchProvider', lambda *a, **kw: STUB_PROVIDER)
    monkeypatch.setattr(wb, '_resolveModel', lambda p, hint='': 'stub-claude')
    # Current stream path resolves provider+model through _resolveChatLlm.
    monkeypatch.setattr(wb, '_resolveChatLlm', lambda *a, **kw: (STUB_PROVIDER, 'stub-claude'))
    # Keep real buildSystemPrompt / tool defs so prompt_build is realistic.
    monkeypatch.setattr(providerCredsMod, 'resolve', lambda name: {'api_key': 'stub-key'})
    holder: dict[str, Any] = {}

    def fake_get_client(provider: object) -> object:
        return holder['client']

    monkeypatch.setattr(clientsMod, 'getClient', fake_get_client)
    monkeypatch.setattr('app.providers.clients.getClient', fake_get_client)
    # Suppress fire-and-forget background tasks for clean timing
    monkeypatch.setattr(asyncio, 'create_task', lambda coro, **kw: asyncio.ensure_future(coro))
    clear_traces()
    yield holder
    clear_traces()


@pytest.mark.asyncio
async def test_p0_mock_llm_text_turn_overhead(stub_workbench):
    """Mock-LLM text-only turn — collect p50/p95 local overhead (no network)."""
    holder = stub_workbench
    n = 8
    summaries = []
    for i in range(n):
        holder['client'] = StubClient('text_once')
        events: list[dict[str, object]] = []
        await wb.sendWorkbenchMessageStream(
            sessionId=f'p0-text-{i}',
            message='hello',
            emit=events.append,
        )
        ring = recent_traces(1)
        assert ring, f'expected finished perf trace on run {i}'
        summaries.append(ring[-1])
        assert 'done' in [e.get('type') for e in events]

    agg = aggregate_summaries(summaries)
    assert agg['n'] == n
    assert agg['total_ms']['p50'] is not None
    assert agg['total_ms']['p50'] >= 0
    print('P0_BASELINE_TEXT', agg)
    assert agg['total_ms']['p95'] is not None
    assert agg['total_ms']['p95'] < 5000


@pytest.mark.asyncio
async def test_p0_mock_llm_tool_round(stub_workbench):
    """One tool round then text — expect tool_exec + llm_wait spans in the trace."""
    holder = stub_workbench
    holder['client'] = StubClient('one_tool')
    try:
        from app.services.tool_definitions import registerAll

        registerAll()
    except Exception:
        pass
    events: list[dict[str, object]] = []
    await wb.sendWorkbenchMessageStream(
        sessionId='p0-tool-1',
        message='use a tool',
        emit=events.append,
    )
    ring = recent_traces(1)
    assert ring, 'expected a finished perf trace'
    summary = ring[0]
    print('P0_BASELINE_TOOL', summary)
    assert 'prompt_build' in summary['spans']
    assert 'llm_wait' in summary['spans']
    types = [e.get('type') for e in events]
    assert 'done' in types


@pytest.mark.asyncio
async def test_p0_multi_agent_blackboard_contention(isolatedData):
    """N concurrent blackboard writers — measure wall time (baseline, no optimisations)."""
    from app.services import blackboard_service

    memory_store = pytest.importorskip('app.services.memory_store')
    memory_store.init()

    n_agents = 8
    writes_each = 5
    sid = 'p0-bb-contention'

    async def agent_writer(agent: str) -> None:
        for i in range(writes_each):
            await asyncio.to_thread(
                blackboard_service.writeNote,
                sid,
                agent,
                f'k{i}',
                {'v': i, 'agent': agent},
                60,
            )
            await asyncio.to_thread(blackboard_service.readNotes, sid, agent, f'k{i}')

    t0 = time.perf_counter()
    await asyncio.gather(*[agent_writer(f'agent-{i}') for i in range(n_agents)])
    wall_ms = (time.perf_counter() - t0) * 1000.0
    notes = blackboard_service.readNotes(sid)
    print(
        'P0_BASELINE_BLACKBOARD',
        {
            'agents': n_agents,
            'writes_each': writes_each,
            'wall_ms': round(wall_ms, 3),
            'notes': len(notes),
        },
    )
    assert len(notes) >= n_agents  # at least some notes survived
    assert wall_ms < 30000  # safety upper bound only


@pytest.mark.asyncio
async def test_p0_db_writer_contention_age_drops_and_high_pri(isolatedData):
    """Real db_writer contention — age-drop + high-pri under backlog.

    Notes on actual implementation (measured, not assumed):
      * ``asyncio.Queue()`` is **unbounded** — no enqueue-time capacity drop
        never fires in production config.
      * Real drop policy is **age-based**: low-pri items older than
        ``_LOW_DROP_AFTER`` (2.0s) are skipped when dequeued.
      * High/low share one FIFO queue — high does not jump the queue; it only
        gets a longer put-timeout (unused with unbounded queue).

    This test saturates with slow low-pri work, then:
      1. Confirms some low-pri items are dropped by age.
      2. Measures high-pri enqueue→completion wall time under that backlog.
    """
    from app.services import db_writer as dbw

    # Fresh queue (fixture may leave none)
    if dbw._worker_task and not dbw._worker_task.done():
        dbw._worker_task.cancel()
        try:
            await dbw._worker_task
        except asyncio.CancelledError:
            pass
    dbw._write_queue = None
    dbw._worker_task = None
    dbw.ensure_queue()

    executed: list[str] = []

    def slow_work(label: str, hold_s: float = 0.35) -> None:
        time.sleep(hold_s)
        executed.append(label)

    # Flood low-priority slow writes so later items age past 2s before dequeue
    n_low = 12
    for i in range(n_low):
        ok = await dbw.enqueue_write(lambda i=i: slow_work(f'low-{i}', 0.35), priority='low')
        assert ok is True  # unbounded queue always accepts

    high_done = asyncio.Event()
    high_started = time.perf_counter()
    high_finished_ms: list[float] = []

    def high_work() -> None:
        high_finished_ms.append((time.perf_counter() - high_started) * 1000.0)
        executed.append('high')
        high_done.set()

    t_enq0 = time.perf_counter()
    high_ok = await dbw.enqueue_write(high_work, priority='high')
    high_enqueue_ms = (time.perf_counter() - t_enq0) * 1000.0
    assert high_ok is True

    # Wait for high to run (may sit behind several 0.35s lows)
    try:
        await asyncio.wait_for(high_done.wait(), timeout=30.0)
    except asyncio.TimeoutError:
        pytest.fail('high-priority write never completed under backlog')

    # Drain remaining
    await asyncio.sleep(0.5)
    for _ in range(50):
        if dbw._write_queue and dbw._write_queue.empty():
            break
        await asyncio.sleep(0.1)

    low_executed = [x for x in executed if x.startswith('low-')]
    dropped_est = n_low - len(low_executed)
    high_completion_ms = high_finished_ms[0] if high_finished_ms else None

    report = {
        'n_low_enqueued': n_low,
        'n_low_executed': len(low_executed),
        'n_low_dropped_est': dropped_est,
        'high_enqueue_ms': round(high_enqueue_ms, 3),
        'high_completion_ms': round(high_completion_ms, 3) if high_completion_ms is not None else None,
        'high_within_5s_budget': (
            high_completion_ms is not None and high_completion_ms < dbw._HIGH_DRAIN_TIMEOUT * 1000
        ),
        'note': 'Queue unbounded: drops are age-based at dequeue only',
    }
    print('P0_BASELINE_DB_WRITER_CONTENTION', report)

    # Prove drop policy does something under this load
    assert dropped_est >= 1, f'expected some age-based low drops, got {report}'
    assert 'high' in executed
    assert high_completion_ms is not None
    # Documented high put timeout is 5s; completion under FIFO may exceed that —
    # record whether it stayed under budget without failing the suite if machine is slow.
    # Hard fail only if absurdly stuck.
    assert high_completion_ms < 30000


@pytest.mark.asyncio
async def test_p0_persist_tail_variance(stub_workbench):
    """Diagnose persist p95 spread: isolate saveSessions vs full stream persist span."""
    from app.services.workbench import sessions as sessions_mod
    from app.services.workbench.sessions import WorkbenchSession, saveSessions

    # Build a realistic in-memory session blob
    sessions_mod._sessions.clear()
    for i in range(20):
        s = WorkbenchSession(
            id=f'p0-persist-{i}',
            title=f's{i}',
            provider='stub',
            model='stub',
        )
        s.messages = [{'role': 'user', 'content': f'x{i}' * 50} for _ in range(5)]
        sessions_mod._sessions[s.id] = s

    samples: list[float] = []
    for _ in range(30):
        t0 = time.perf_counter()
        saveSessions()
        samples.append((time.perf_counter() - t0) * 1000.0)

    samples.sort()
    p50 = samples[len(samples) // 2]
    p95 = samples[int((len(samples) - 1) * 0.95)]
    print(
        'P0_BASELINE_PERSIST_ISOLATED',
        {
            'n': len(samples),
            'p50_ms': round(p50, 3),
            'p95_ms': round(p95, 3),
            'max_ms': round(max(samples), 3),
            'min_ms': round(min(samples), 3),
            'note': 'saveSessions only; stream persist span also includes record_usage + status emit',
        },
    )
    assert p50 < 500
