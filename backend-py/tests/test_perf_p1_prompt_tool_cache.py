"""P1.1 / P1.2 — prompt segment + tool-def cache (isolated from schema/db_writer).

Before/after uses the same mock-LLM harness as P0, toggling:
  AUGUST_P1_TOOL_CACHE / AUGUST_P1_PROMPT_CACHE
so regressions are attributable only to this change set.
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator

import pytest

from app.lib.perf_timing import aggregate_summaries, clear_traces, recent_traces
from app.services.workbench import workbench as wb
from app.services.workbench import tool_defs_cache, prompt_segments_cache


class StubClient:
    def __init__(self) -> None:
        self.call_count = 0

    def resolveApiKey(self) -> str:
        return 'stub-key'

    async def messages_stream(self, body: object) -> AsyncIterator[dict[str, object]]:
        self.call_count += 1
        await asyncio.sleep(0)
        yield {
            '_event_type': 'content_block_start',
            'content_block': {'type': 'text', 'text': 'ok'},
        }
        yield {
            '_event_type': 'content_block_delta',
            'delta': {'type': 'text_delta', 'text': 'ok'},
        }
        yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 2}}


STUB_PROVIDER = {
    'name': 'stub-anthropic',
    'apiMode': 'anthropicMessages',
    'default_model': 'stub-claude',
    'model_profiles': {},
}


@pytest.fixture
def stub_wb(monkeypatch, isolatedData):
    from app.services.workbench import sessions as sessions_mod
    from app.services import provider_credentials as providerCredsMod
    import app.providers.clients as clientsMod
    from app.services.tool_definitions import registerAll

    try:
        registerAll()
    except Exception:
        pass

    monkeypatch.setenv('AUGUST_PERF_TIMING', '1')
    empty: dict = {}
    monkeypatch.setattr(sessions_mod, '_sessions', empty)
    monkeypatch.setattr(wb, '_sessions', empty)
    monkeypatch.setattr(wb, '_resolveWorkbenchProvider', lambda *a, **kw: STUB_PROVIDER)
    monkeypatch.setattr(wb, '_resolveModel', lambda p, hint='': 'stub-claude')
    monkeypatch.setattr(providerCredsMod, 'resolve', lambda name: {'api_key': 'stub-key'})
    holder: dict[str, Any] = {'client': StubClient()}

    def fake_get_client(provider: object) -> object:
        return holder['client']

    monkeypatch.setattr(clientsMod, 'getClient', fake_get_client)
    monkeypatch.setattr('app.providers.clients.getClient', fake_get_client)
    monkeypatch.setattr(asyncio, 'create_task', lambda coro, **kw: asyncio.ensure_future(coro))
    clear_traces()
    tool_defs_cache.clear()
    prompt_segments_cache.clear()
    yield holder
    clear_traces()
    tool_defs_cache.clear()
    prompt_segments_cache.clear()


async def _run_text_turns(n: int = 8) -> dict[str, Any]:
    summaries = []
    for i in range(n):
        events: list[dict[str, object]] = []
        await wb.sendWorkbenchMessageStream(
            sessionId=f'p1-bench-{i}',
            message='hello',
            emit=events.append,
        )
        ring = recent_traces(1)
        assert ring
        summaries.append(ring[-1])
    return aggregate_summaries(summaries)


@pytest.mark.asyncio
async def test_p1_before_after_prompt_build(stub_wb, monkeypatch):
    """Before = caches off; after = caches on. Assert prompt_build p50 improves or holds."""
    # BEFORE
    monkeypatch.setenv('AUGUST_P1_TOOL_CACHE', '0')
    monkeypatch.setenv('AUGUST_P1_PROMPT_CACHE', '0')
    tool_defs_cache.clear()
    prompt_segments_cache.clear()
    clear_traces()
    before = await _run_text_turns(8)
    print('P1_BEFORE', before)

    # AFTER
    monkeypatch.setenv('AUGUST_P1_TOOL_CACHE', '1')
    monkeypatch.setenv('AUGUST_P1_PROMPT_CACHE', '1')
    tool_defs_cache.clear()
    prompt_segments_cache.clear()
    clear_traces()
    after = await _run_text_turns(8)
    print('P1_AFTER', after)
    print('P1_TOOL_CACHE_STATS', tool_defs_cache.stats())
    print('P1_PROMPT_CACHE_STATS', prompt_segments_cache.stats())

    b_pb = before['spans'].get('prompt_build', {}).get('p50_ms')
    a_pb = after['spans'].get('prompt_build', {}).get('p50_ms')
    b_tot = before['total_ms']['p50']
    a_tot = after['total_ms']['p50']
    assert b_pb is not None and a_pb is not None
    assert b_tot is not None and a_tot is not None
    # Allow small noise; expect improvement or near-parity (not large regression)
    assert a_pb <= b_pb * 1.15 + 5.0, f'prompt_build regressed: before={b_pb} after={a_pb}'
    assert a_tot <= b_tot * 1.15 + 5.0, f'total_ms regressed: before={b_tot} after={a_tot}'
    # Cache should have hits on after path
    assert tool_defs_cache.stats()['hits'] >= 1
    assert prompt_segments_cache.stats()['hits'] >= 1


@pytest.mark.asyncio
async def test_p1_tool_defs_cache_invalidates_on_register(stub_wb, monkeypatch):
    monkeypatch.setenv('AUGUST_P1_TOOL_CACHE', '1')
    tool_defs_cache.clear()
    from app.services import tool_registry

    a1 = wb.toolDefinitions(type('S', (), {'messages': []})())
    a2 = wb.toolDefinitions(type('S', (), {'messages': []})())
    assert len(a1) == len(a2)
    assert tool_defs_cache.stats()['hits'] >= 1
    gen0 = tool_registry.generation()

    async def _noop(**kwargs: object) -> str:
        return 'ok'

    tool_registry.register('p1_test_only_tool', 'test', _noop, parameters={'type': 'object', 'properties': {}})
    assert tool_registry.generation() > gen0
    a3 = wb.toolDefinitions(type('S', (), {'messages': []})())
    names = {t.get('name') for t in a3}
    assert 'p1_test_only_tool' in names
