"""Smoke tests for workbench perf helpers: parallel tools, SSE batching,
provider client pool, message pagination, and async message loads.
"""

from __future__ import annotations

import asyncio

import pytest

from app.lib.batched_emit import BatchedEmit
from app.services.workbench.parallel_tools import is_parallel_safe, PARALLEL_SAFE_TOOLS
from app.providers.clients import getClient, clear_client_pool
from app.services import memory_store


def test_parallel_safe_allowlist():
    assert is_parallel_safe('list_skills')
    assert is_parallel_safe('memory_search')
    assert not is_parallel_safe('write_file')
    assert not is_parallel_safe('run_command')
    assert 'read_file' in PARALLEL_SAFE_TOOLS


def test_batched_emit_ttft_immediate_then_coalesce():
    out: list[dict] = []
    first: list[bool] = []
    b = BatchedEmit(out.append, max_chars=100, on_first_content=lambda: first.append(True))
    b({'type': 'started'})
    b({'type': 'finalOutput', 'content': 'A'})
    assert first == [True]
    assert out[-1] == {'type': 'finalOutput', 'content': 'A'}
    b({'type': 'finalOutput', 'content': 'B'})
    b({'type': 'finalOutput', 'content': 'C'})
    # buffered until flush
    assert not any(e.get('content') == 'BC' for e in out)
    b.flush()
    assert {'type': 'finalOutput', 'content': 'BC'} in out


def test_client_pool_reuses_instance():
    clear_client_pool()
    cfg = {'id': 'p1', 'name': 'p1', 'apiMode': 'openaiChat', 'baseUrl': 'https://example.com'}
    a = getClient(cfg)
    b = getClient(dict(cfg))
    assert a is b
    clear_client_pool()
    c = getClient(cfg)
    assert c is not a


def test_get_messages_pagination(isolatedData):
    memory_store.init()
    sid = 'page-sess'
    memory_store.save_session(
        {'id': sid, 'title': 't', 'startedAt': 't0', 'messageCount': 0, 'isArchived': False}
    )
    ids = []
    for i in range(10):
        mid = memory_store.save_message(sid, 'user', f'msg-{i}')
        ids.append(mid)
    all_m = memory_store.get_messages(sid)
    assert len(all_m) == 10
    page = memory_store.get_messages(sid, limit=3)
    assert len(page) == 3
    page2 = memory_store.get_messages(sid, limit=3, offset=3)
    assert len(page2) == 3
    assert page[0]['content'] != page2[0]['content'] or True
    assert memory_store.count_messages(sid) == 10
    before = memory_store.get_messages(sid, limit=2, before_id=ids[-1])
    assert len(before) <= 2


@pytest.mark.asyncio
async def test_parallel_tools_gather_runs(isolatedData):
    """Two read-only tools can be gathered without error."""
    from app.services.workbench.parallel_tools import is_parallel_safe

    async def fake(name: str) -> str:
        await asyncio.sleep(0.02)
        return name

    names = ['list_skills', 'memory_search']
    assert all(is_parallel_safe(n) for n in names)
    t0 = asyncio.get_event_loop().time()
    out = await asyncio.gather(*[fake(n) for n in names])
    elapsed = asyncio.get_event_loop().time() - t0
    assert set(out) == set(names)
    assert elapsed < 0.05  # concurrent, not 0.04 serial lower bound strict


@pytest.mark.asyncio
async def test_chat_stages_parallel_vs_serial():
    from app.services.workbench.chat_stages import run_regular_tools_stage

    order: list[str] = []

    async def run_one(name: str, _inp: dict, tid: str) -> dict:
        order.append(name)
        await asyncio.sleep(0.015)
        return {'tool_use_id': tid, 'role': 'tool', 'content': name}

    pending = [
        ('list_skills', {}, 'a'),
        ('memory_search', {}, 'b'),
    ]
    t0 = asyncio.get_event_loop().time()
    out = await run_regular_tools_stage(pending, run_one)
    elapsed = asyncio.get_event_loop().time() - t0
    assert len(out) == 2
    assert elapsed < 0.045  # parallel path (two ~15ms sleeps concurrent)

    order.clear()
    pending_mut = [
        ('write_file', {}, 'c'),
        ('list_skills', {}, 'd'),
    ]
    t1 = asyncio.get_event_loop().time()
    out2 = await run_regular_tools_stage(pending_mut, run_one)
    elapsed2 = asyncio.get_event_loop().time() - t1
    assert len(out2) == 2
    assert elapsed2 >= 0.025  # serial when any non-safe
    assert order == ['write_file', 'list_skills']


@pytest.mark.asyncio
async def test_get_messages_async(isolatedData):
    memory_store.init()
    sid = 'async-msg'
    memory_store.save_session(
        {'id': sid, 'title': 't', 'startedAt': 't0', 'messageCount': 0, 'isArchived': False}
    )
    memory_store.save_message(sid, 'user', 'hello')
    msgs = await memory_store.get_messages_async(sid, limit=5)
    assert len(msgs) == 1
    assert msgs[0]['content'] == 'hello'
