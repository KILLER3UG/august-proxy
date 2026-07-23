"""Prompt-segment and tool-definition cache tests (isolated from schema/db_writer).

Before/after uses the mock-LLM harness, toggling:
  AUGUST_P1_TOOL_CACHE / AUGUST_P1_PROMPT_CACHE
so regressions are attributable only to the cache layer.
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator

import pytest
from app.lib.perf_timing import aggregate_summaries, clear_traces, recent_traces
from app.services.workbench import prompt_segments_cache, tool_defs_cache
from app.services.workbench import workbench as wb


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
    import app.providers.clients as clientsMod
    from app.services import provider_credentials as providerCredsMod
    from app.services.tool_definitions import registerAll
    from app.services.workbench import sessions as sessions_mod

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
    # Current stream path resolves provider+model through _resolveChatLlm.
    monkeypatch.setattr(wb, '_resolveChatLlm', lambda *a, **kw: (STUB_PROVIDER, 'stub-claude'))
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
    # Compare in-process span time (prompt_build + persist) rather than
    # wall-clock total: total_ms includes scheduler gaps between spans
    # (asyncio jitter on a loaded machine), which the caches do not influence
    # and which made the old total_ms guard flaky in full-suite runs.
    b_persist = before['spans'].get('persist', {}).get('p50_ms') or 0.0
    a_persist = after['spans'].get('persist', {}).get('p50_ms') or 0.0
    b_overhead = b_pb + b_persist
    a_overhead = a_pb + a_persist
    assert a_overhead <= b_overhead * 1.15 + 5.0, (
        f'in-process overhead regressed: before={b_overhead} after={a_overhead}'
    )
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


@pytest.mark.asyncio
async def test_p1_tool_defs_cache_invalidates_on_unregister(stub_wb, monkeypatch):
    """Withdrawn tools must not remain in the cached Anthropic list."""
    monkeypatch.setenv('AUGUST_P1_TOOL_CACHE', '1')
    tool_defs_cache.clear()
    from app.services import tool_registry

    async def _noop(**kwargs: object) -> str:
        return 'ok'

    tool_registry.register(
        'p1_withdraw_me', 'will remove', _noop, parameters={'type': 'object', 'properties': {}}
    )
    defs = wb.toolDefinitions(type('S', (), {'messages': []})())
    assert 'p1_withdraw_me' in {t.get('name') for t in defs}

    assert tool_registry.unregister('p1_withdraw_me') is True
    defs2 = wb.toolDefinitions(type('S', (), {'messages': []})())
    names2 = {t.get('name') for t in defs2}
    assert 'p1_withdraw_me' not in names2, 'stale cache served withdrawn tool definition'


@pytest.mark.asyncio
async def test_p1_tool_defs_cache_invalidates_on_mcp_signature_change(stub_wb, monkeypatch):
    """MCP tool list change must miss cache even if registry generation is stable."""
    monkeypatch.setenv('AUGUST_P1_TOOL_CACHE', '1')
    tool_defs_cache.clear()

    mcp_state: dict[str, list] = {
        'defs': [
            {
                'type': 'function',
                'function': {
                    'name': 'mcp__a__tool',
                    'description': 'a',
                    'parameters': {'type': 'object', 'properties': {}},
                },
            }
        ]
    }

    def fake_mcp():
        return list(mcp_state['defs'])

    monkeypatch.setattr(
        'app.services.tools.mcp_client.getMcpToolDefinitionsSync',
        fake_mcp,
    )
    # Also patch the import path used inside tool_defs_cache / workbench helpers
    monkeypatch.setattr(
        'app.services.workbench.tool_defs_cache._mcp_signature',
        lambda: ','.join(
            sorted(
                str((d.get('function') or {}).get('name', ''))
                for d in mcp_state['defs']
                if d.get('type') == 'function'
            )
        ),
    )
    monkeypatch.setattr(
        'app.services.workbench.workbench._mcpToolDefinitionsAnthropic',
        lambda seen: [
            {
                'name': str((d.get('function') or {}).get('name', '')),
                'description': 'a',
                'input_schema': {'type': 'object', 'properties': {}},
            }
            for d in mcp_state['defs']
            if str((d.get('function') or {}).get('name', '')) not in seen
        ],
    )

    d1 = wb.toolDefinitions(type('S', (), {'messages': []})())
    names1 = {t.get('name') for t in d1}
    assert 'mcp__a__tool' in names1

    # Same registry gen, different MCP set
    mcp_state['defs'] = [
        {
            'type': 'function',
            'function': {
                'name': 'mcp__b__tool',
                'description': 'b',
                'parameters': {'type': 'object', 'properties': {}},
            },
        }
    ]
    d2 = wb.toolDefinitions(type('S', (), {'messages': []})())
    names2 = {t.get('name') for t in d2}
    assert 'mcp__b__tool' in names2
    assert 'mcp__a__tool' not in names2, 'stale MCP tool still served after signature change'
    # Should have been a miss (new entry), not only hits on old entry
    assert tool_defs_cache.stats()['misses'] >= 2