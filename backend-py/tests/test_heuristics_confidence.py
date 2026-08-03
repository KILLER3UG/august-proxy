"""Heuristic confidence scoring + merge semantics."""

from __future__ import annotations

import json

import pytest


def test_add_default_confidence(brain_ready):
    from app.services.heuristics_service import addHeuristic, listHeuristics

    rid = addHeuristic('Prefer tabs over spaces', source='reflection', category='correction')
    assert rid is not None
    rows = listHeuristics()
    assert rows[0]['rule'] == 'Prefer tabs over spaces'
    assert rows[0]['confidence'] == 0.5


def test_add_explicit_confidence_clamped(brain_ready):
    from app.services.heuristics_service import addHeuristic, listHeuristics

    addHeuristic('Use branded types for IDs', confidence=0.9)
    addHeuristic('Never use any', confidence=2.0)  # clamped to 1.0
    addHeuristic('Always run tests', confidence=-1)  # clamped to 0.0
    rows = {r['rule']: r['confidence'] for r in listHeuristics()}
    assert rows['Use branded types for IDs'] == 0.9
    assert rows['Never use any'] == 1.0
    assert rows['Always run tests'] == 0.0


def test_exact_duplicate_bumps_confidence_and_returns_id(brain_ready):
    from app.services.heuristics_service import addHeuristic, listHeuristics

    first = addHeuristic('Prefer pnpm over npm', confidence=0.6)
    second = addHeuristic('Prefer pnpm over npm', confidence=0.6)
    assert second == first  # same row, not a new one
    rows = listHeuristics()
    assert len(rows) == 1
    assert rows[0]['confidence'] == 0.7  # 0.6 + 0.1 step


def test_repeat_bumps_capped_at_one(brain_ready):
    from app.services.heuristics_service import addHeuristic, listHeuristics

    addHeuristic('Always verify before commit', confidence=0.95)
    for _ in range(3):
        addHeuristic('Always verify before commit', confidence=0.95)
    rows = listHeuristics()
    assert rows[0]['confidence'] == 1.0


def test_near_duplicate_bumps(brain_ready):
    from app.services.heuristics_service import addHeuristic, listHeuristics

    addHeuristic('The user prefers pnpm over npm for installs', confidence=0.5)
    rid = addHeuristic('User prefers pnpm over npm')
    assert rid is not None
    rows = listHeuristics()
    assert len(rows) == 1
    assert rows[0]['confidence'] == 0.6


def test_list_orders_by_confidence(brain_ready):
    from app.services.heuristics_service import addHeuristic, listHeuristics

    addHeuristic('Weak rule', confidence=0.3)
    addHeuristic('Strong rule', confidence=0.9)
    rows = listHeuristics()
    assert [r['rule'] for r in rows] == ['Strong rule', 'Weak rule']


@pytest.mark.asyncio
async def test_reflection_dict_corrections_with_confidence(brain_ready):
    from app.services.heuristics_service import listHeuristics
    from app.services.memory import background_review as br

    async def stubLlm(_prompt):
        return json.dumps(
            {
                'corrections': [
                    {'rule': 'Use branded types for IDs', 'confidence': 0.9},
                    {'rule': 'Never use any for entity IDs', 'confidence': 1.5},  # clamped
                ],
                'facts': [],
                'skills': [],
                'frustration': False,
            }
        )

    result = await br._doReview([{'role': 'user', 'content': 'x'}], llm_client=stubLlm)
    assert len(result['corrections_added']) == 2
    rows = {r['rule']: r['confidence'] for r in listHeuristics()}
    assert rows['Use branded types for IDs'] == 0.9
    assert rows['Never use any for entity IDs'] == 1.0


@pytest.mark.asyncio
async def test_reflection_plain_string_corrections_still_work(brain_ready):
    from app.services.heuristics_service import listHeuristics
    from app.services.memory import background_review as br

    async def stubLlm(_prompt):
        return json.dumps(
            {
                'corrections': ['Always use pnpm'],
                'facts': [],
                'skills': [],
                'frustration': False,
            }
        )

    result = await br._doReview([{'role': 'user', 'content': 'x'}], llm_client=stubLlm)
    assert len(result['corrections_added']) == 1
    rows = listHeuristics()
    assert rows[0]['rule'] == 'Always use pnpm'
    assert rows[0]['confidence'] == 0.5  # default when no explicit score


def test_confidence_column_migrates_on_warm_path(tmp_path, monkeypatch):
    """A legacy DB without the confidence column gains it via the additive migration."""
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.services.memory_schema import ensure_schema
    from app.services.memory_store import _conn

    conn = _conn()
    conn.execute('DROP TABLE IF EXISTS learned_heuristics')
    conn.execute(
        'CREATE TABLE learned_heuristics ('
        'id INTEGER PRIMARY KEY AUTOINCREMENT, rule TEXT NOT NULL, source TEXT DEFAULT "", '
        'category TEXT DEFAULT "general", created_at TEXT, updated_at TEXT)'
    )
    conn.execute('PRAGMA user_version=8')
    conn.commit()
    ensure_schema(conn)
    conn.commit()
    cols = {r['name'] for r in conn.execute('PRAGMA table_info(learned_heuristics)').fetchall()}
    assert 'confidence' in cols
