"""Skill keyword expansion + the measured-effect demotion prior (audit P2#15).

Pinned here:
  * keyword expansion is DEFAULT OFF — an untouched install writes no keywords
    and pays no model call;
  * when it is on, the keywords land in frontmatter, survive the round-trip,
    and reach the BM25 corpus (a query in the user's vocabulary finds the
    skill);
  * a generation failure leaves the skill exactly as it would have been;
  * the demotion prior is bounded, applies only to MEASURED negative lift, and
    is cached per process so the per-turn prompt path never re-queries SQLite;
  * ``turn_outcomes.skill_lift`` is the same aggregation the
    ``/api/brain/skills/suggestions`` endpoint reports.
"""

from __future__ import annotations

import pytest
from app.main import app
from app.services import capabilities_prompt, skill_service
from httpx import ASGITransport, AsyncClient


@pytest.fixture()
def skills(monkeypatch):
    skill_service._bust_prompt_skills_cache()
    skill_service._flat_migrate_done = True
    capabilities_prompt._skills_bm25_cache.clear()
    capabilities_prompt._skill_lift_cache = None
    yield
    skill_service._bust_prompt_skills_cache()
    capabilities_prompt._skills_bm25_cache.clear()


def _writeAgentSkill(name: str, **frontmatter: str) -> None:
    root = skill_service._agentSkillsDir()
    root.mkdir(parents=True, exist_ok=True)
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    extra = ''.join(f'{k}: {v}\n' for k, v in frontmatter.items())
    (d / 'SKILL.md').write_text(
        f'---\nname: {name}\ndescription: a skill for the relevance test\n'
        f'category: testing\ncreated_by: agent\n{extra}---\n\nDo the thing.\n',
        'utf-8',
    )


# ── the knob ─────────────────────────────────────────────────────────────


def test_keyword_expansion_defaults_off():
    from app.services.brain_config_service import getDefaults

    assert getDefaults()['skillKeywordExpansion'] is False
    assert skill_service.keyword_expansion_enabled() is False


def test_config_accepts_the_knob():
    from app.services.brain_config_service import validatePatch

    ok, err = validatePatch({'skillKeywordExpansion': True})
    assert ok, err
    ok, err = validatePatch({'skillKeywordExpansion': 'yes'})
    assert not ok and 'boolean' in err


def test_create_writes_no_keywords_by_default(skills):
    out = skill_service.createSkill(
        'kw-off', 'a skill created with expansion off', 'Body of the skill.'
    )
    assert out is not None
    text = (skill_service._agentSkillDir('kw-off') / 'SKILL.md').read_text('utf-8')
    assert 'keywords:' not in text
    assert skill_service.get('kw-off')['keywords'] == []


def test_create_uses_explicit_keywords(skills):
    skill_service.createSkill(
        'kw-explicit', 'a skill with explicit keywords', 'Body.',
        keywords=['PCB Layout', 'gerber', 'gerber'],
    )
    entry = skill_service.get('kw-explicit')
    assert entry['keywords'] == ['pcb layout', 'gerber']
    assert 'keywords: pcb layout, gerber' in (
        skill_service._agentSkillDir('kw-explicit') / 'SKILL.md'
    ).read_text('utf-8')


def test_create_expands_when_the_knob_is_on(skills, monkeypatch):
    calls: list[str] = []

    def _expand(name, description, body, trigger=''):
        calls.append(name)
        return ['oscilloscope', 'probe']

    monkeypatch.setattr(skill_service, 'keyword_expansion_enabled', lambda: True)
    monkeypatch.setattr(skill_service, 'expand_keywords_best_effort', _expand)
    skill_service.createSkill('kw-auto', 'a skill expanded at write time', 'Body.')
    assert calls == ['kw-auto']
    assert skill_service.get('kw-auto')['keywords'] == ['oscilloscope', 'probe']


def test_expansion_failure_leaves_the_skill_written(skills, monkeypatch):
    monkeypatch.setattr(skill_service, 'keyword_expansion_enabled', lambda: True)
    monkeypatch.setattr(
        skill_service, 'expand_keywords_best_effort', lambda *a, **k: []
    )
    out = skill_service.createSkill('kw-fail', 'a skill whose expansion failed', 'Body.')
    assert out is not None
    assert skill_service.get('kw-fail')['keywords'] == []


def test_patch_expands_a_body_edit_once(skills, monkeypatch):
    _writeAgentSkill('kw-patch')
    monkeypatch.setattr(skill_service, 'keyword_expansion_enabled', lambda: True)
    monkeypatch.setattr(
        skill_service, 'expand_keywords_best_effort', lambda *a, **k: ['reflow']
    )
    skill_service.patchSkill('kw-patch', body='A new body for the patch test.')
    assert skill_service.get('kw-patch')['keywords'] == ['reflow']
    # Second edit: the keywords are already there, so no second call.
    monkeypatch.setattr(
        skill_service, 'expand_keywords_best_effort', lambda *a, **k: pytest.fail('re-expanded')
    )
    skill_service.patchSkill('kw-patch', body='Yet another body for the patch test.')
    assert skill_service.get('kw-patch')['keywords'] == ['reflow']


def test_keyword_parse_render_round_trip():
    assert skill_service.parse_keywords('a, B ,a,, c') == ['a', 'b', 'c']
    assert skill_service.parse_keywords('[x, y]') == ['x', 'y']
    assert skill_service.parse_keywords('') == []
    assert skill_service.parse_keywords(None) == []
    assert skill_service.render_keywords(['A', 'b', 'a']) == 'a, b'
    long = ','.join(f'k{i}' for i in range(30))
    assert len(skill_service.parse_keywords(long)) == skill_service._KEYWORDMax


# ── keywords reach the corpus ────────────────────────────────────────────


def test_keywords_join_the_bm25_corpus(skills):
    _writeAgentSkill('kw-corpus-plain')
    _writeAgentSkill('kw-corpus-keyed', keywords='oscilloscope, waveform')
    block, detail = capabilities_prompt.render_relevant_skills(
        'how do I read a waveform on an oscilloscope'
    )
    assert block
    assert 'kw-corpus-keyed' in detail
    assert 'kw-corpus-plain' not in detail


# ── the demotion prior ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    'lift,expected',
    [(None, 0.0), (0.0, 0.0), (0.4, 0.0), (-0.05, 0.05), (-0.3, 0.3), (-5.0, 0.5)],
)
def test_demotion_penalty_math(skills, monkeypatch, lift, expected):
    monkeypatch.setattr(
        capabilities_prompt, '_skill_lift_map', lambda: {'s': lift} if lift is not None else {}
    )
    assert capabilities_prompt._skill_demotion_penalty('s') == expected


def test_demotion_prior_reorders_two_equally_relevant_skills(skills, monkeypatch):
    # Identical name-length/description/trigger → identical BM25 score, so the
    # ONLY thing that can reorder them is the prior.
    _writeAgentSkill('dm-alpha')
    _writeAgentSkill('dm-beta')
    skill_service._bust_prompt_skills_cache()
    capabilities_prompt._skills_bm25_cache.clear()
    monkeypatch.setattr(capabilities_prompt, '_skill_lift_map', lambda: {'dm-beta': -0.4})

    _block, detail = capabilities_prompt.render_relevant_skills('a skill for the relevance test')
    assert 'dm-alpha' in detail and 'dm-beta' in detail
    order = list(detail.keys())
    assert order.index('dm-alpha') < order.index('dm-beta')


def test_no_measurements_reproduces_the_pure_ranking(skills, monkeypatch):
    _writeAgentSkill('dm-plain')
    monkeypatch.setattr(capabilities_prompt, '_skill_lift_map', lambda: {})
    _block, detail = capabilities_prompt.render_relevant_skills('a skill for the relevance test')
    assert 'dm-plain' in detail


def test_lift_map_is_cached_per_process(skills, monkeypatch):
    calls = {'n': 0}

    def _fake(days: int = 30):
        calls['n'] += 1
        return {'x': -0.1}

    monkeypatch.setattr('app.services.turn_outcomes.skill_lift', _fake)
    capabilities_prompt._skill_lift_cache = None
    assert capabilities_prompt._skill_lift_map() == {'x': -0.1}
    assert capabilities_prompt._skill_lift_map() == {'x': -0.1}
    assert calls['n'] == 1  # the per-turn path must not re-query per call
    capabilities_prompt._skill_lift_cache = None
    assert capabilities_prompt._skill_lift_map() == {'x': -0.1}
    assert calls['n'] == 2


def test_lift_map_failure_degrades_to_pure_relevance(skills, monkeypatch):
    def _boom(days: int = 30):
        raise RuntimeError('no ledger here')

    monkeypatch.setattr('app.services.turn_outcomes.skill_lift', _boom)
    capabilities_prompt._skill_lift_cache = None
    assert capabilities_prompt._skill_lift_map() == {}
    assert capabilities_prompt._skill_demotion_penalty('anything') == 0.0


# ── skill_lift agrees with the suggestions endpoint ──────────────────────


@pytest.fixture()
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


def test_skill_lift_matches_the_endpoint(brain):
    from app.services.turn_outcomes import record_turn_outcome, skill_lift

    # good: 2/2 with, 3/6 without → +0.5.  bad: 0/2 with, 5/6 without → -0.833.
    for ok, injected in [
        (True, ['good-skill']),
        (True, ['good-skill']),
        (True, []),
        (False, []),
        (False, ['bad-skill']),
        (False, ['bad-skill']),
        (True, []),
        (True, []),
    ]:
        record_turn_outcome(
            model='m', provider='p', task_type='agent', ok=ok, skills_injected=injected
        )
    lifts = skill_lift(30)
    assert lifts['good-skill'] == 0.5
    assert lifts['bad-skill'] == -0.833

    transport = ASGITransport(app=app)
    import asyncio

    async def _read():
        async with AsyncClient(transport=transport, base_url='http://test') as ac:
            return (await ac.get('/api/brain/skills/suggestions')).json()

    body = asyncio.run(_read())
    by_name = {s['skill']: s for s in body['suggestions']}
    assert by_name['good-skill']['lift'] == lifts['good-skill']
    assert by_name['bad-skill']['lift'] == lifts['bad-skill']


def test_skill_lift_omits_a_skill_with_no_denominator(brain):
    from app.services.turn_outcomes import record_turn_outcome, skill_lift

    # Every turn carries the skill → "without" turns = 0 → the difference is
    # UNDEFINED, and an absent entry is the honest shape for that.
    for ok in (True, True, False):
        record_turn_outcome(
            model='m', provider='p', task_type='agent', ok=ok, skills_injected=['only-skill']
        )
    assert 'only-skill' not in skill_lift(30)


def test_skill_lift_degrades_to_empty(brain):
    from app.services.memory_conn import conn
    from app.services.turn_outcomes import skill_lift

    conn().execute('UPDATE turn_outcomes SET skills_injected = NULL')
    conn().commit()
    assert skill_lift(30) == {}
