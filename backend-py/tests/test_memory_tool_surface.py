"""The model's memory must be manageable end-to-end: recall, correct, retire.

Each test here pins one half of a door that was previously incomplete:
`remember` was offered where `list_facts`/`forget` could be deferred away (a
write door whose keys the model cannot enumerate), the bare surface for weak
models had no memory tools at all while the prompt still told it to revise and
retire facts, and an explicit short search was silenced by the floor meant for
automatic per-turn injection.
"""

from __future__ import annotations

import json

import pytest
from app.services import memory_store
from app.services.memory_store.fact_retrieval import (
    _MIN_QUERY_CHARS,
    invalidate_fact_index,
    retrieve_relevant_facts,
)
from app.services.tools.model_tools import AUGUST_CORE_TOOLS
from app.services.workbench import prompt_segments_cache as seg
from app.services.workbench import workbench as wb

_MEMORY_CRUD = {'remember', 'list_facts', 'forget'}


@pytest.fixture(autouse=True)
def _fresh_index():
    invalidate_fact_index()
    yield
    invalidate_fact_index()


def _save(key: str, body: str, **kwargs: str) -> None:
    memory_store.save_fact(key, body, title=kwargs.pop('title', key), **kwargs)


def test_bare_surface_offers_the_whole_memory_door() -> None:
    """A weak model is the one that most needs to be told what it remembers."""
    assert _MEMORY_CRUD <= set(wb._BARE_TOOL_ALLOW)


def test_bare_names_are_real_tools() -> None:
    from app.services.tool_definitions import registerAll
    from app.services.tool_registry import listTools

    registerAll()
    registered = {str(t['function']['name']) for t in listTools()}
    missing = set(wb._BARE_TOOL_ALLOW) - registered
    assert not missing, f'_BARE_TOOL_ALLOW references unregistered tools: {sorted(missing)}'


def test_progressive_disclosure_cannot_defer_the_key_lookup() -> None:
    """`remember` is core, so the tools its own instructions depend on cannot be
    the ones disclosure hides."""
    assert 'remember' in AUGUST_CORE_TOOLS
    assert _MEMORY_CRUD <= set(AUGUST_CORE_TOOLS)


def test_automatic_recall_still_ignores_a_tiny_query() -> None:
    _save('fact:pool', 'Connection pooling is configured in app/config.py.')
    assert retrieve_relevant_facts('pool') == []
    assert len('pool') < _MIN_QUERY_CHARS


def test_explicit_recall_answers_a_query_the_tail_would_refuse() -> None:
    _save('fact:hardware', 'The user trains models on one 6GB GPU.')
    hits = retrieve_relevant_facts('gpu', min_query_chars=1)
    assert [h.get('key') for h in hits] == ['fact:hardware']


def test_brain_query_ranks_a_short_deliberate_search() -> None:
    from app.services.memory_store.brain import brain_query as bq

    _save('fact:hardware2', 'The user trains models on one 6GB GPU.', category='user')
    rows = json.loads(bq('facts', 'gpu', None, 10))

    keys = [str(r.get('factKey') or r.get('key') or '') for r in rows]
    assert 'fact:hardware2' in keys


def test_policy_tells_the_model_the_index_is_frozen() -> None:
    """The guidance must match the behaviour, or the model trusts a stale index
    and saves twins of what it wrote five minutes ago."""
    assert 'frozen' in seg.MEMORY_BLOCK
    assert 'list_facts' in seg.MEMORY_BLOCK
