"""Model memory CRUD: ``list_facts`` (read) + ``forget`` (delete).

Part 15.5 of docs/plans/2026-08-27-harness-knowledge-base-minimal-transcript.md.
``remember`` (write) already has test_remember_throttle.py; this file covers
the two new model-facing tools that make remember's stable keys usable:

- ``list_facts`` — gated by ``modelMemoryRead``; bounded key/title listing
  with category filter + query search, unwrapping {"fact","details"} values.
- ``forget`` — gated by ``modelMemoryWrites``; deletes model/user/imported
  facts only (system-owned sources survive), records a rollback snapshot so
  the delete is undoable like the Memory UI's delete path.

Plus the ``<memory>`` block index line that surfaces injected fact keys so
the model knows which keys it may revise or forget.
"""

from __future__ import annotations

import json

import pytest
from app.services import brain_config_service as bcs
from app.services import memory_store
from app.services.tool_registrations import session_tools as st


@pytest.fixture(autouse=True)
def _freshBudget():
    # remember's per-turn budget is module state; keep tests independent.
    st.reset_remember_turn_budget()
    yield
    st.reset_remember_turn_budget()


@pytest.fixture(autouse=True)
def _fresh_index():
    from app.services.memory_store.fact_retrieval import invalidate_fact_index

    invalidate_fact_index()
    yield
    invalidate_fact_index()


# ------------------------------------------------------------ list_facts


@pytest.mark.asyncio
async def testListFactsReturnsSeededRows():
    memory_store.save_fact(
        'user:editor', {'fact': 'User edits in Vim', 'details': 'init.lua'},
        category='user', source='model', title='Editor setup',
    )
    memory_store.save_fact(
        'project:stack', 'FastAPI backend with a Tauri shell',
        category='project', source='user',
    )
    out = json.loads(await st._list_facts())
    assert out['ok'] is True
    assert out['count'] == 2
    byKey = {f['key']: f for f in out['facts']}
    assert byKey['user:editor']['title'] == 'Editor setup'
    assert byKey['user:editor']['category'] == 'user'
    assert byKey['user:editor']['source'] == 'model'
    # No title column: the {"fact","details"} JSON unwraps to the fact text.
    assert byKey['project:stack']['title'] == 'FastAPI backend with a Tauri shell'
    assert byKey['project:stack']['source'] == 'user'


@pytest.mark.asyncio
async def testListFactsCategoryFilter():
    memory_store.save_fact('user:a', 'first user fact for the filter test', category='user')
    memory_store.save_fact('project:b', 'one project fact for the filter test', category='project')
    out = json.loads(await st._list_facts(category='user'))
    assert out['ok'] is True
    assert [f['key'] for f in out['facts']] == ['user:a']


@pytest.mark.asyncio
async def testListFactsQuerySearch():
    memory_store.save_fact('user:editor', 'User edits in Vim', category='user')
    memory_store.save_fact('user:dog', 'The family dog is named Biscuit', category='user')
    out = json.loads(await st._list_facts(query='Biscuit'))
    assert out['ok'] is True
    assert [f['key'] for f in out['facts']] == ['user:dog']


@pytest.mark.asyncio
async def testListFactsLimitClamped():
    for i in range(4):
        memory_store.save_fact(f'bulk:{i}', f'bulk fact number {i} for clamp test')
    out = json.loads(await st._list_facts(limit=2))
    assert out['count'] == 2
    # limit=0 clamps up to 1, never to an empty page.
    out = json.loads(await st._list_facts(limit=0))
    assert out['count'] == 1
    # Oversized limits clamp to the 50-row ceiling (only 4 rows exist).
    out = json.loads(await st._list_facts(limit=999))
    assert out['count'] == 4


@pytest.mark.asyncio
async def testListFactsGatedByModelMemoryRead(monkeypatch):
    memory_store.save_fact('user:a', 'a user fact saved before the read gate')
    monkeypatch.setattr(bcs, 'getRuntimeConfig', lambda: {'modelMemoryRead': False})
    out = json.loads(await st._list_facts())
    assert out['ok'] is False
    assert 'disabled' in out['policy']


# ------------------------------------------------------------ forget


@pytest.mark.asyncio
async def testForgetDeletesModelFactAndRecordsRollback():
    from app.services import rollback_store

    memory_store.save_fact('model:temp', 'throwaway model fact for forget test', source='model')
    out = json.loads(await st._forget('model:temp'))
    assert out == {'ok': True, 'deleted': True, 'key': 'model:temp'}
    assert memory_store.get_fact('model:temp') is None
    entries = [
        e for e in rollback_store.list_entries()
        if e.get('type') == 'restore_memory_item' and e.get('target') == 'model:temp'
    ]
    assert len(entries) == 1
    assert entries[0]['after'] is None
    assert entries[0]['before']


@pytest.mark.asyncio
async def testForgetAllowsUserAndImportedSources():
    memory_store.save_fact('user:note', 'a user-added fact for the source test', source='user')
    memory_store.save_fact('claude:legacy', 'an imported fact for the source test', source='imported:claude')
    out = json.loads(await st._forget('user:note'))
    assert out['deleted'] is True
    out = json.loads(await st._forget('claude:legacy'))
    assert out['deleted'] is True


@pytest.mark.asyncio
async def testForgetRefusesSystemOwnedFact():
    memory_store.save_fact('lesson:extracted', 'a daemon-extracted fact that must survive', source='extracted')
    out = json.loads(await st._forget('lesson:extracted'))
    assert out['ok'] is False
    assert 'system-owned' in out['policy']
    assert memory_store.get_fact('lesson:extracted') is not None


@pytest.mark.asyncio
async def testForgetMissingKeyPointsAtListFacts():
    out = json.loads(await st._forget('nope:not-here'))
    assert out['ok'] is False
    assert out['deleted'] is False
    assert 'list_facts' in out['error']


@pytest.mark.asyncio
async def testForgetEmptyKeyRejected():
    out = json.loads(await st._forget('   '))
    assert out['ok'] is False
    assert 'list_facts' in out['error']


@pytest.mark.asyncio
async def testForgetGatedByModelMemoryWrites(monkeypatch):
    memory_store.save_fact('model:temp', 'model fact that must survive the write gate')
    monkeypatch.setattr(bcs, 'getRuntimeConfig', lambda: {'modelMemoryWrites': False})
    out = json.loads(await st._forget('model:temp'))
    assert out['ok'] is False
    assert 'disabled' in out['policy']
    assert memory_store.get_fact('model:temp') is not None


# ------------------------------------------------------------ round trip


@pytest.mark.asyncio
async def testRememberListForgetRoundTrip():
    # Write through the model handler...
    out = json.loads(await st._remember(fact='User prefers the dark theme', key='user:theme'))
    assert out['ok'] is True and out['key'] == 'user:theme'
    # ...read back through list_facts...
    listing = json.loads(await st._list_facts())
    assert 'user:theme' in [f['key'] for f in listing['facts']]
    # ...revise with the same key (update, not duplicate)...
    out = json.loads(
        await st._remember(fact='User prefers the light theme now', key='user:theme')
    )
    assert out['ok'] is True and out['updated'] is True
    listing = json.loads(await st._list_facts())
    rows = [f for f in listing['facts'] if f['key'] == 'user:theme']
    assert len(rows) == 1
    assert rows[0]['title'] == 'User prefers the light theme now'
    # ...then delete.
    out = json.loads(await st._forget('user:theme'))
    assert out['deleted'] is True
    listing = json.loads(await st._list_facts())
    assert 'user:theme' not in [f['key'] for f in listing['facts']]


# ------------------------------------------------------------ <memory> index


def testMemoryBlockCarriesFactKeyIndex():
    from app.services.memory_store.fact_retrieval import build_memory_block

    memory_store.save_fact(
        'user:editor', {'fact': 'User edits in Vim with Neovim config'}, title='Editor setup',
    )
    block, injected = build_memory_block('How do I open my vim config file?')
    assert injected
    assert 'index: [user:editor]' in block
    # The footer tells the model how to use the keys it was just handed.
    assert 'passing its key to remember' in block
    assert 'forget' in block
