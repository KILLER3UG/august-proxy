"""Skill/fact credit assignment (migration 050 — audit D1, 2026-09-26).

Pinned here:
  * record_turn_outcome persists skills_injected / skills_loaded /
    facts_injected / error_families as JSON arrays — NULL for legacy callers
    (unrecorded), '[]' for measured-empty;
  * the turn-scoped load collector ties load_skill calls to the turn row;
  * GET /api/brain/skills/suggestions aggregates the ledger read-time
    (the routing_evidence pattern) into per-skill resolved-rate lift.
"""

from __future__ import annotations

import json

import pytest
from app.main import app
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


def test_record_persists_credit_columns(brain):
    from app.services.memory_conn import conn
    from app.services.turn_outcomes import record_turn_outcome

    record_turn_outcome(
        model='m1',
        provider='p1',
        task_type='agent',
        ok=True,
        skills_injected=['circuit-sim', 'tutor'],
        skills_loaded=['tutor'],
        facts_injected=['pref.editor'],
        error_families=['timeout', 'process_exit'],
    )
    # Legacy caller (no credit args) → NULL, never '[]'.
    record_turn_outcome(model='m1', provider='p1', task_type='agent', ok=False)
    rows = conn().execute(
        'SELECT skills_injected, skills_loaded, facts_injected, error_families '
        'FROM turn_outcomes ORDER BY id'
    ).fetchall()
    first, legacy = rows[0], rows[1]
    assert json.loads(first['skills_injected']) == ['circuit-sim', 'tutor']
    assert json.loads(first['skills_loaded']) == ['tutor']
    assert json.loads(first['facts_injected']) == ['pref.editor']
    assert json.loads(first['error_families']) == ['process_exit', 'timeout']
    assert (
        legacy['skills_injected']
        is legacy['skills_loaded']
        is legacy['facts_injected']
        is legacy['error_families']
        is None
    )


def test_record_measured_empty_is_empty_array(brain):
    from app.services.memory_conn import conn
    from app.services.turn_outcomes import record_turn_outcome

    record_turn_outcome(model='m1', provider='p1', task_type='agent', ok=True, skills_injected=[])
    row = conn().execute('SELECT skills_injected FROM turn_outcomes ORDER BY id DESC').fetchone()
    assert json.loads(row['skills_injected']) == []


def test_turn_load_collector(brain):
    from pathlib import Path

    from app.services.skill_service import (
        begin_turn_skill_collection,
        drain_turn_loaded_skills,
        record_skill_use,
    )

    assert drain_turn_loaded_skills() == []
    begin_turn_skill_collection()
    skillDir = Path(brain) / 'skills' / 'myskill'
    skillDir.mkdir(parents=True, exist_ok=True)
    record_skill_use(str(skillDir / 'SKILL.md'))
    record_skill_use(str(skillDir / 'SKILL.md'))  # duplicate load → deduped
    assert drain_turn_loaded_skills() == ['myskill']
    # After the drain the collector is closed — later loads are not collected.
    record_skill_use(str(skillDir / 'SKILL.md'))
    assert drain_turn_loaded_skills() == []


async def test_skill_suggestions_endpoint(brain):
    from app.services.turn_outcomes import record_turn_outcome

    # Skill rides 2 turns, both ok; other turns measured without it (1 ok, 1 fail).
    record_turn_outcome(model='m', provider='p', task_type='agent', ok=True, skills_injected=['good-skill'])
    record_turn_outcome(model='m', provider='p', task_type='agent', ok=True, skills_injected=['good-skill'])
    record_turn_outcome(model='m', provider='p', task_type='agent', ok=True, skills_injected=[])
    record_turn_outcome(model='m', provider='p', task_type='agent', ok=False, skills_injected=[])
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        res = await ac.get('/api/brain/skills/suggestions')
    assert res.status_code == 200
    body = res.json()
    assert body['days'] == 30
    top = next(s for s in body['suggestions'] if s['skill'] == 'good-skill')
    assert top['turnsWith'] == 2
    assert top['okRateWith'] == 1.0
    assert top['turnsWithout'] == 2
    assert top['okRateWithout'] == 0.5
    assert top['lift'] == 0.5
    # A legacy NULL row (unrecorded, pre-050) is excluded from the denominator
    # — the honesty rule, not a zero.
    record_turn_outcome(model='m', provider='p', task_type='agent', ok=True)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        res = await ac.get('/api/brain/skills/suggestions')
    top = next(s for s in res.json()['suggestions'] if s['skill'] == 'good-skill')
    assert top['turnsWith'] == 2
    assert top['turnsWithout'] == 2


async def test_skill_suggestions_degrades_without_column(brain):
    """A DB without the 050 columns yields empty suggestions, not a 500."""
    from app.services.memory_conn import conn

    conn().execute('UPDATE turn_outcomes SET skills_injected = NULL')
    conn().commit()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        res = await ac.get('/api/brain/skills/suggestions')
    assert res.status_code == 200
    assert res.json()['suggestions'] == []
