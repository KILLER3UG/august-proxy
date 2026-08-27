"""M1/M3/M4/M5 knowledge-base tests (plan 2026-08-27 §3.3–§3.6, line 534).

Covers:
- M1 ``internal_state`` round-trip + isolation from the model query surface
- M3 BM25 fact retrieval / ``<memory>`` block injection + usage feedback
- M4 consolidation: expiry, near-duplicate merge, same-title contradiction
- M5 turn outcomes telemetry + gated failure-lesson promotion
"""

from __future__ import annotations

import json

import pytest
from app.services import memory_store
from app.services.memory_conn import conn as _conn


@pytest.fixture(autouse=True)
def _fresh_index():
    from app.services.memory_store.fact_retrieval import invalidate_fact_index

    invalidate_fact_index()
    yield
    invalidate_fact_index()


def _age(key: str, seconds: int) -> None:
    """Push a fact's updated_at into the past so newest-first ordering is
    deterministic (datetime('now') has second resolution)."""
    _conn().execute(
        "UPDATE facts SET updated_at = datetime('now', ?) WHERE fact_key = ?",
        (f'-{int(seconds)} seconds', key),
    )
    _conn().commit()


# ---------------------------------------------------------------- M1


def test_internal_state_round_trip():
    from app.services.memory_store import get_internal_state, set_internal_state

    assert get_internal_state('missing:key') is None
    set_internal_state('test:str', 'hello')
    set_internal_state('test:dict', {'a': 1, 'b': [2, 3]})
    assert get_internal_state('test:str') == 'hello'
    assert get_internal_state('test:dict') == {'a': 1, 'b': [2, 3]}
    # Upsert overwrites in place.
    set_internal_state('test:str', 'world')
    assert get_internal_state('test:str') == 'world'


def test_internal_state_isolated_from_brain_query():
    """Harness state must never surface through the model-facing query tool."""
    from app.services.memory_store import set_internal_state

    set_internal_state('secret:internal', 'should-not-leak')
    raw = memory_store.brain_query(store='internal_state', query='', limit=5)
    data = json.loads(raw)
    assert isinstance(data, dict)
    assert 'not available' in str(data.get('error', ''))
    # Not reachable through the kv alias either.
    rawKv = memory_store.brain_query(store='kv', query='should-not-leak', limit=5)
    assert 'should-not-leak' not in rawKv


# ---------------------------------------------------------------- M3


def test_build_memory_block_injects_relevant_facts():
    from app.services.memory_store import save_fact
    from app.services.memory_store.fact_retrieval import build_memory_block

    save_fact('user:editor', {'fact': 'User edits in Vim with Neovim config'}, title='Editor setup')
    save_fact('user:dog', {'fact': 'The family dog is named Biscuit'}, title='Dog name')
    block, injected = build_memory_block('How do I open my vim config file?')
    assert '<memory>' in block and '</memory>' in block
    keys = [k for k, _ in injected]
    assert 'user:editor' in keys
    assert 'user:dog' not in keys
    assert 'Editor setup' in block


def test_build_memory_block_short_query_empty():
    from app.services.memory_store import save_fact
    from app.services.memory_store.fact_retrieval import build_memory_block

    save_fact('user:editor', {'fact': 'User edits in Vim'}, title='Editor setup')
    block, injected = build_memory_block('hi')
    assert block == '' and injected == []


def test_build_memory_block_excludes_expired_and_superseded():
    from app.services.memory_store import save_fact
    from app.services.memory_store.fact_retrieval import build_memory_block

    save_fact(
        'old:expired',
        {'fact': 'Expired vim note should never surface'},
        title='Expired vim note',
        expires_at='2020-01-01T00:00:00',
    )
    save_fact('old:superseded', {'fact': 'Superseded vim note hidden'}, title='Superseded vim note')
    _conn().execute("UPDATE facts SET status = 'superseded' WHERE fact_key = 'old:superseded'")
    _conn().commit()
    save_fact('user:editor', {'fact': 'Active vim configuration note'}, title='Active vim note')
    block, injected = build_memory_block('please show my vim configuration')
    keys = [k for k, _ in injected]
    assert keys == ['user:editor']


def test_touch_fact_usage_boosts_ranking():
    from app.services.memory_store import get_fact, save_fact, touch_fact_usage
    from app.services.memory_store.fact_retrieval import retrieve_relevant_facts

    # Both facts match the query; 'a' is the stronger lexical match.
    save_fact('a:plain', {'fact': 'deployment target is production cluster'}, title='Deploy target A')
    save_fact('b:boosted', {'fact': 'destination for release trains'}, title='Ops note B')
    query = 'deployment target destination'
    before = retrieve_relevant_facts(query, k=2)
    assert [f['key'] for f in before] == ['a:plain', 'b:boosted']
    assert touch_fact_usage(['b:boosted']) == 1
    fact = get_fact('b:boosted')
    assert fact is not None and int(fact.get('useCount') or 0) == 1
    # 20 touches = max boost (+1.0) — flips the weaker lexical match to #1.
    for _ in range(19):
        touch_fact_usage(['b:boosted'])
    ranked = retrieve_relevant_facts(query, k=2)
    assert ranked and ranked[0]['key'] == 'b:boosted'


def test_find_similar_facts_ratio():
    from app.services.memory_store import save_fact
    from app.services.memory_store.fact_retrieval import find_similar_facts

    body = 'always run ruff before committing python code'
    save_fact('dup:one', {'fact': body}, title='Lint before commit')
    # A candidate lesson parroting the stored body must clear the M5 dedupe
    # threshold (0.55) so exact re-promotions get caught.
    similar = find_similar_facts(body, k=1)
    assert similar and similar[0][1] == 'dup:one'
    assert similar[0][0] > 0.55
    # Unrelated text must not look similar.
    unrelated = find_similar_facts('quarterly budget spreadsheet formatting', k=1)
    assert not unrelated or unrelated[0][0] < 0.3
    assert find_similar_facts('', k=1) == []


# ---------------------------------------------------------------- M4


def test_consolidation_expires_facts():
    from app.services.memory_store import get_fact, save_fact
    from app.services.memory_store.consolidation import run_consolidation

    save_fact('exp:gone', {'fact': 'temporary note'}, title='Temp', expires_at='2020-01-01T00:00:00')
    summary = run_consolidation(modelSummarize=False)
    assert summary['expired'] == 1
    assert get_fact('exp:gone') is None


def test_consolidation_merges_near_duplicates():
    from app.services.memory_store import get_fact, save_fact
    from app.services.memory_store.consolidation import run_consolidation

    # Slug-equal keys → merge regardless of BM25.
    save_fact('user-prefers-dark-mode', 'The user prefers dark mode in every app')
    _age('user-prefers-dark-mode', 120)
    save_fact('user_prefers_dark_mode', 'User prefers dark mode in every app')
    summary = run_consolidation(modelSummarize=False)
    assert summary['merged'] >= 1
    survivor = get_fact('user_prefers_dark_mode')  # newest wins
    gone = get_fact('user-prefers-dark-mode')
    assert survivor is not None and gone is None
    assert 'merged from' in str(survivor.get('factValue', ''))


def test_consolidation_supersedes_same_title_conflicts():
    from app.services.memory_store import save_fact
    from app.services.memory_store.consolidation import run_consolidation

    save_fact('cfg:old', 'Preferred python version is 3.10', title='Preferred Python version')
    _age('cfg:old', 120)
    save_fact('cfg:new', {'fact': 'Preferred python version is 3.12 now'}, title='Preferred Python version')
    summary = run_consolidation(modelSummarize=False)
    assert summary['superseded'] == 1
    rows = _conn().execute(
        'SELECT fact_key, status FROM facts ORDER BY updated_at DESC'
    ).fetchall()
    byKey = {r['fact_key']: r['status'] for r in rows}
    assert byKey['cfg:new'] in (None, 'active')
    assert byKey['cfg:old'] == 'superseded'
    # Superseded rows are kept, not deleted (plan §3.5-c).
    assert len(rows) == 2


def test_consolidation_records_state_and_lifecycle():
    from app.services.memory_store import get_internal_state
    from app.services.memory_store.consolidation import _STATE_KEY_LAST_RUN, run_consolidation

    summary = run_consolidation(modelSummarize=False)
    assert 'error' not in summary
    assert get_internal_state(_STATE_KEY_LAST_RUN)
    life = _conn().execute(
        "SELECT COUNT(*) AS c FROM lifecycle WHERE event_type = 'consolidation'"
    ).fetchone()
    assert int(life['c']) >= 1


# ---------------------------------------------------------------- M5


def test_classify_error():
    from app.services.turn_outcomes import classify_error

    assert classify_error('') == ''
    assert classify_error('[429] rate limit exceeded') == 'rate_limit'
    assert classify_error('401 Unauthorized: bad api key') == 'auth'
    assert classify_error('request cancelled by user') == 'cancelled'
    assert classify_error('maximum context length exceeded') == 'context_overflow'
    assert classify_error('[500] internal server error') == 'upstream_5xx'
    assert classify_error('totally novel failure') == 'other'


def test_record_and_error_rate():
    from app.services.turn_outcomes import error_rate_by_model, record_turn_outcome

    record_turn_outcome(model='m1', provider='p1', task_type='agent', ok=True)
    record_turn_outcome(model='m1', provider='p1', task_type='agent', ok=False, error_class='rate_limit')
    record_turn_outcome(model='m1', provider='p1', task_type='agent', ok=False, error_class='rate_limit')
    record_turn_outcome(model='m2', provider='p1', task_type='agent', ok=True)
    rates = {r['model']: r for r in error_rate_by_model(days=7)}
    assert rates['m1']['turns'] == 3
    assert rates['m1']['errors'] == 2
    assert abs(float(rates['m1']['errorRate']) - 0.667) < 0.01
    assert rates['m2']['errors'] == 0


def test_sweep_old_outcomes():
    from app.services.turn_outcomes import record_turn_outcome, sweep_old_outcomes

    record_turn_outcome(model='old', provider='p', task_type='agent', ok=True)
    _conn().execute(
        "UPDATE turn_outcomes SET ts = datetime('now', '-40 days') WHERE model = 'old'"
    )
    _conn().commit()
    record_turn_outcome(model='fresh', provider='p', task_type='agent', ok=True)
    assert sweep_old_outcomes(days=30) == 1
    rows = _conn().execute('SELECT model FROM turn_outcomes').fetchall()
    assert [r['model'] for r in rows] == ['fresh']


@pytest.mark.asyncio
async def test_promotion_below_threshold():
    from app.services.turn_outcomes import maybe_promote_failure_lesson, record_turn_outcome

    record_turn_outcome(model='m1', provider='p1', task_type='agent', ok=False, error_class='auth')
    record_turn_outcome(model='m1', provider='p1', task_type='agent', ok=False, error_class='auth')
    status = await maybe_promote_failure_lesson(
        model='m1', provider='p1', error_class='auth', sample_error='401 bad key'
    )
    assert status == 'below-threshold'
    # Cancelled turns never promote.
    assert (
        await maybe_promote_failure_lesson(
            model='m1', provider='p1', error_class='cancelled', sample_error='x'
        )
        == 'below-threshold'
    )


@pytest.mark.asyncio
async def test_promotion_discard_default_without_review(monkeypatch):
    """No reachable review model → lesson discarded, cooldown still set."""
    from app.services import turn_outcomes
    from app.services.memory_store import get_internal_state

    async def deny(*_a, **_k):
        return False

    monkeypatch.setattr(turn_outcomes, '_review_lesson', deny)
    for _ in range(3):
        turn_outcomes.record_turn_outcome(
            model='m1', provider='p1', task_type='agent', ok=False, error_class='auth'
        )
    status = await turn_outcomes.maybe_promote_failure_lesson(
        model='m1', provider='p1', error_class='auth', sample_error='401 Unauthorized'
    )
    assert status == 'review-rejected'
    assert get_internal_state('turn_outcomes:last_promotion:p1-m1-auth')
    assert memory_store.get_fact('harness-lesson:p1-m1-auth') is None
    # Second call inside the cooldown window short-circuits.
    again = await turn_outcomes.maybe_promote_failure_lesson(
        model='m1', provider='p1', error_class='auth', sample_error='401 Unauthorized'
    )
    assert again == 'cooldown'


@pytest.mark.asyncio
async def test_promotion_writes_lesson_when_reviewed(monkeypatch):
    from app.services import turn_outcomes

    async def approve(*_a, **_k):
        return True

    monkeypatch.setattr(turn_outcomes, '_review_lesson', approve)
    for _ in range(3):
        turn_outcomes.record_turn_outcome(
            model='m9', provider='p9', task_type='agent', ok=False, error_class='timeout'
        )
    status = await turn_outcomes.maybe_promote_failure_lesson(
        model='m9', provider='p9', error_class='timeout', sample_error='request timed out after 60s'
    )
    assert status == 'promoted'
    fact = memory_store.get_fact('harness-lesson:p9-m9-timeout')
    assert fact is not None
    assert fact.get('kind') == 'lesson'
    assert fact.get('category') == 'harness'
    assert fact.get('title')


@pytest.mark.asyncio
async def test_review_lesson_discards_without_client(monkeypatch):
    from app.services import turn_outcomes

    monkeypatch.setattr(
        'app.services.workbench.providers.make_review_llm_client', lambda *_a, **_k: None
    )
    assert await turn_outcomes._review_lesson('lesson', 'sample', '') is False
