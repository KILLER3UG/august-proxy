"""ZCode-parity global memory (044): the `description` recall hook.

Mirrors how memory works in the ZCode harness: every durable fact carries a
one-line description that (a) rides the boot index as the scannable hook,
(b) joins the BM25 recall text, and (c) is stored on the `facts` row and
editable from the UI. The boot index itself is loaded EVERY session
(frozen per session) regardless of the per-turn memoryAutoInject flag —
that gate is pinned in test_model_memory_read.py.
"""

from __future__ import annotations

import json

import pytest
from app.services import memory_store
from app.services.tool_registrations import session_tools as st


@pytest.fixture(autouse=True)
def _freshBudget():
    st.reset_remember_turn_budget()
    yield
    st.reset_remember_turn_budget()


# ── storage ────────────────────────────────────────────────────────────


def test_save_fact_stores_description():
    memory_store.save_fact(
        'model:deploy', 'Deploy only from main',
        title='Deploy rule', description='release day steps for this repo',
    )
    row = memory_store.get_fact('model:deploy')
    assert row is not None
    assert row['description'] == 'release day steps for this repo'


def test_save_fact_update_without_description_keeps_it():
    memory_store.save_fact('model:keep', 'v1', title='Keep', description='the hook')
    memory_store.save_fact('model:keep', 'v2', title='Keep')
    row = memory_store.get_fact('model:keep')
    assert row['description'] == 'the hook', 'empty description must not erase the stored one'


@pytest.mark.asyncio
async def test_remember_global_stores_description():
    out = json.loads(await st._remember(
        fact='The user trades perps and wants second opinions',
        scope='global', description='who the user is and how they use August',
    ))
    assert out['ok'] is True
    row = memory_store.get_fact(out['key'])
    assert row['description'] == 'who the user is and how they use August'


@pytest.mark.asyncio
async def test_remember_global_derives_description_from_fact():
    out = json.loads(await st._remember(
        fact='Deploy only from the main branch. Feature branches are staging only.',
        scope='global',
    ))
    assert out['ok'] is True
    row = memory_store.get_fact(out['key'])
    assert row['description'] == 'Deploy only from the main branch'


# ── boot index ─────────────────────────────────────────────────────────


def test_boot_index_line_carries_the_hook():
    from app.services.memory_store import brain_index_snippet

    memory_store.save_fact(
        'model:ring', 'Context ring geometry copied from the reference',
        title='Context ring', description='model dropdown restyle reference',
    )
    snippet = brain_index_snippet()
    assert '- Context ring (model:ring) — model dropdown restyle reference' in snippet


def test_boot_index_falls_back_to_fact_text():
    from app.services.memory_store import brain_index_snippet

    memory_store.save_fact('model:nodesc', 'No description supplied here', title='NoDesc')
    snippet = brain_index_snippet()
    assert '- NoDesc (model:nodesc) — No description supplied here' in snippet


# ── recall ─────────────────────────────────────────────────────────────


def test_bm25_recalls_by_description_words():
    from app.services.memory_store.fact_retrieval import (
        invalidate_fact_index,
        retrieve_relevant_facts,
    )

    memory_store.save_fact(
        'model:quirks', 'Use the full interpreter path when spawning',
        title='Windows tooling', description='quirks of running pytest on this machine',
    )
    memory_store.save_fact(
        'model:doctrine', 'No SFT ever', title='Trading doctrine',
        description='pipeline rulings for the model',
    )
    invalidate_fact_index('global')
    hits = retrieve_relevant_facts('pytest quirks machine', k=3)
    keys = [str(h.get('key')) for h in hits]
    assert 'model:quirks' in keys, keys
    assert keys[0] == 'model:quirks'


@pytest.mark.asyncio
async def test_list_facts_surfaces_description():
    await st._remember(
        fact='Camera capture pattern for ingest features',
        key='model:camera', scope='global', description='template for future capture/ingest',
    )
    out = json.loads(await st._list_facts())
    assert out['ok'] is True
    row = next(f for f in out['facts'] if f['key'] == 'model:camera')
    assert row['description'] == 'template for future capture/ingest'
