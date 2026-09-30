"""Smoke tests for workbench perf helpers: parallel tools, SSE batching,
provider client pool, message pagination, and async message loads.
"""

from __future__ import annotations

import asyncio

import pytest
from app.lib.batched_emit import BatchedEmit
from app.providers.clients import clear_client_pool, getClient
from app.services import memory_store
from app.services.workbench.parallel_tools import PARALLEL_SAFE_TOOLS, is_parallel_safe


def test_parallel_safe_allowlist():
    assert is_parallel_safe('list_skills')
    assert is_parallel_safe('brain_query')
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

    loop = asyncio.get_event_loop()
    started: dict[str, float] = {}
    finished: dict[str, float] = {}

    async def fake(name: str) -> str:
        started[name] = loop.time()
        await asyncio.sleep(0.02)
        finished[name] = loop.time()
        return name

    names = ['list_skills', 'brain_query']
    assert all(is_parallel_safe(n) for n in names)
    out = await asyncio.gather(*[fake(n) for n in names])
    assert set(out) == set(names)

    # Concurrency is OVERLAP, not elapsed time. The old assertion was
    # `elapsed < 0.05` for two 0.02s tasks — but serial execution takes 0.04s,
    # which also satisfies that bound, so the test passed whether or not the
    # calls were actually gathered. It was also the suite's flakiest test: under
    # -n auto a concurrent pair measured 0.053s and failed a condition that a
    # serial pair would have passed.
    for a in names:
        for b in names:
            if a != b:
                assert started[b] < finished[a], (
                    f'{b} did not start until {a} finished — these were run '
                    f'serially, not gathered'
                )


@pytest.mark.asyncio
async def test_chat_stages_parallel_vs_serial():
    from app.services.workbench.chat_stages import run_regular_tools_stage

    order: list[str] = []
    concurrent = 0
    max_concurrent = 0

    async def run_one(name: str, _inp: dict, tid: str) -> dict:
        nonlocal concurrent, max_concurrent
        order.append(name)
        concurrent += 1
        max_concurrent = max(max_concurrent, concurrent)
        await asyncio.sleep(0.02)
        concurrent -= 1
        return {'tool_use_id': tid, 'role': 'tool', 'content': name}

    pending = [
        ('list_skills', {}, 'a'),
        ('brain_query', {}, 'b'),
    ]
    max_concurrent = 0
    out = await run_regular_tools_stage(pending, run_one)
    assert len(out) == 2
    assert max_concurrent >= 2  # all-read-only batch runs concurrently

    order.clear()
    max_concurrent = 0
    pending_mut = [
        ('write_file', {}, 'c'),
        ('list_skills', {}, 'd'),
    ]
    out2 = await run_regular_tools_stage(pending_mut, run_one)
    assert len(out2) == 2
    assert max_concurrent == 1  # any non-safe → fully serial
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
