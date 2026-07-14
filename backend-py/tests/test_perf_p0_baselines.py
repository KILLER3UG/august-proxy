"""P0 baselines — measurement only (no optimisations).

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
    from app.services.workbench import sessions as sessions_mod
    from app.services import provider_credentials as providerCredsMod
    import app.providers.clients as clientsMod

    monkeypatch.setenv('AUGUST_PERF_TIMING', '1')
    empty: dict = {}
    monkeypatch.setattr(sessions_mod, '_sessions', empty)
    monkeypatch.setattr(wb, '_sessions', empty)
    monkeypatch.setattr(wb, '_resolveWorkbenchProvider', lambda *a, **kw: STUB_PROVIDER)
    monkeypatch.setattr(wb, '_resolveModel', lambda p, hint='': 'stub-claude')
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
    """P0.2: mock-LLM text-only turn — collect p50/p95 local overhead."""
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
    """P0.2: one tool round then text — tool_exec + llm_wait spans present."""
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
    """P0.5: N concurrent blackboard writers — measure wall time (no optimisations)."""
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
async def test_p0_db_writer_queue_lag(isolatedData):
    """P0.5: enqueue_write lag under burst — measurement only."""
    from app.services import db_writer, memory_store

    memory_store.init()
    db_writer.ensure_queue()
    lags: list[float] = []

    def _write(i: int) -> None:
        memory_store.save_memory(f'p0_burst_{i}', {'i': i})

    for i in range(20):
        t0 = time.perf_counter()
        ok = await db_writer.enqueue_write(lambda i=i: _write(i), priority='high')
        lags.append((time.perf_counter() - t0) * 1000.0)
        assert ok is True or ok is False  # API returns bool
    # drain a bit
    await asyncio.sleep(0.2)
    print(
        'P0_BASELINE_DB_WRITER',
        {
            'n': len(lags),
            'p50_ms': round(statistics.median(lags), 3),
            'max_ms': round(max(lags), 3),
        },
    )
    assert max(lags) < 10000
