"""Skill usage sidecars — one resolver path, loud failures, small ranking boost.

Plan acceptance (usage telemetry follow-up):

* writer and reader agree on ONE path, under the data dir, for a BUNDLED skill;
* nothing is ever created under the install ``SKILLS_DIR`` (an update re-copies
  it, so user state there is both doomed and invisible);
* a pre-fix sidecar beside a bundled skill is relocated exactly ONCE (moved, not
  copied) and a second read moves nothing;
* a failed usage write logs at warning and never raises into the turn;
* the disclosure boost leaves the BM25 order untouched while all counts are 0,
  lets a used skill beat an equally relevant unused one, and never lets it beat
  a clearly more relevant unused one.
"""

from __future__ import annotations

import json
import logging

import pytest
from app.services import capabilities_prompt, skill_service

_QUERY = 'please align the zebra prism lattice'

@pytest.fixture
def roots(monkeypatch, tmp_path):
    """Both skill roots redirected to temp dirs (never the real repo bundle)."""
    agentRoot = tmp_path / 'data' / 'skills'
    bundledRoot = tmp_path / 'install' / 'skills'
    agentRoot.mkdir(parents=True)
    bundledRoot.mkdir(parents=True)
    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: agentRoot)
    monkeypatch.setattr(skill_service, 'SKILLS_DIR', bundledRoot)
    monkeypatch.setattr(capabilities_prompt, 'skill_relevance_enabled', lambda: True)
    from app.services.workbench import prompt_segments_cache

    prompt_segments_cache.clear()
    capabilities_prompt._skills_bm25_cache.clear()
    yield agentRoot, bundledRoot
    prompt_segments_cache.clear()
    capabilities_prompt._skills_bm25_cache.clear()


def _writeSkill(root, name: str, description: str, trigger: str = '') -> str:
    """Create a discoverable skill directory under ``root``; return SKILL.md."""
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    md = d / 'SKILL.md'
    fm = [
        '---',
        f'name: {name}',
        f'description: {description}',
    ]
    if trigger:
        fm.append(f'trigger: {trigger}')
    fm += ['---', '', 'Body text.']
    md.write_text('\n'.join(fm), 'utf-8')
    skill_service._bust_catalogue_cache()
    return str(md)


def _relevantOrder(query: str = _QUERY) -> list[str]:
    block = capabilities_prompt.render_relevant_skills(query)[0]
    return [
        ln.split(':')[0].removeprefix('- ').strip()
        for ln in block.splitlines()
        if ln.startswith('- ')
    ]


# ---------------------------------------------------------------------------
# (1) one resolver, install tree stays clean, legacy relocation happens once
# ---------------------------------------------------------------------------


class TestOneResolverPath:
    def test_writer_and_reader_agree_for_a_bundled_skill(self, roots):
        agentRoot, bundledRoot = roots
        md = _writeSkill(bundledRoot, 'zebra-basics', 'zebra prism lattice primer')
        assert skill_service.usage_sidecar_path('zebra-basics') == (
            agentRoot / 'zebra-basics' / '.usage.json'
        )
        assert skill_service.usage_sidecar_path('zebra-basics').is_relative_to(agentRoot)

        skill_service.record_skill_use(md)
        usage = skill_service.read_skill_usage('zebra-basics')
        assert usage['count'] == 1 and usage['lastUsed']

        skill_service.record_skill_use(md)
        assert skill_service.read_skill_usage('zebra-basics')['count'] == 2

    def test_no_sidecar_is_ever_created_under_the_install_tree(self, roots):
        _agentRoot, bundledRoot = roots
        md = _writeSkill(bundledRoot, 'prism-basics', 'zebra prism lattice primer')
        skill_service.record_skill_use(md)
        assert list(bundledRoot.rglob('.usage.json')) == []
        assert sorted(p.name for p in (bundledRoot / 'prism-basics').iterdir()) == ['SKILL.md']

    def test_legacy_sidecar_beside_a_bundled_skill_moves_once(self, roots, caplog):
        agentRoot, bundledRoot = roots
        _writeSkill(bundledRoot, 'lattice-basics', 'zebra prism lattice primer')
        legacy = bundledRoot / 'lattice-basics' / '.usage.json'
        legacy.write_text(json.dumps({'count': 7, 'lastUsed': 'earlier'}), 'utf-8')

        with caplog.at_level(logging.INFO, logger='august.skills'):
            assert skill_service.read_skill_usage('lattice-basics')['count'] == 7
        assert legacy.exists() is False, 'must MOVE, not copy — the install tree stops holding state'
        dest = agentRoot / 'lattice-basics' / '.usage.json'
        assert dest.is_file()
        assert 'relocated' in caplog.text

        # Second read: nothing left to move, the count is still authoritative.
        caplog.clear()
        with caplog.at_level(logging.INFO, logger='august.skills'):
            assert skill_service.read_skill_usage('lattice-basics')['count'] == 7
        assert 'relocated' not in caplog.text
        assert legacy.exists() is False

    def test_relocated_counter_keeps_counting(self, roots):
        agentRoot, bundledRoot = roots
        md = _writeSkill(bundledRoot, 'zebra-loop', 'zebra prism lattice drills')
        legacy = bundledRoot / 'zebra-loop' / '.usage.json'
        legacy.write_text(json.dumps({'count': 3, 'lastUsed': 'earlier'}), 'utf-8')
        skill_service.record_skill_use(md)
        assert skill_service.read_skill_usage('zebra-loop')['count'] == 4
        assert list(bundledRoot.rglob('.usage.json')) == []
        assert (agentRoot / 'zebra-loop' / '.usage.json').is_file()

    def test_bundled_skill_stays_patchable_after_a_usage_write(self, roots):
        """The usage directory must not read as an already-patched skill copy."""
        agentRoot, bundledRoot = roots
        md = _writeSkill(bundledRoot, 'zebra-cowrite', 'zebra prism lattice primer')
        skill_service.record_skill_use(md)
        assert (agentRoot / 'zebra-cowrite' / '.usage.json').is_file()
        skill_service.patchSkill('zebra-cowrite', description='patched primer')
        assert (agentRoot / 'zebra-cowrite' / 'SKILL.md').is_file()
        assert skill_service.get('zebra-cowrite')['description'] == 'patched primer'

    def test_usage_write_cannot_make_a_bundled_skill_deletable(self, roots):
        _agentRoot, bundledRoot = roots
        md = _writeSkill(bundledRoot, 'zebra-keep', 'zebra prism lattice primer')
        skill_service.record_skill_use(md)
        with pytest.raises(skill_service.SkillValidationError, match='Refusing to delete bundled'):
            skill_service.deleteSkill('zebra-keep')
        assert (bundledRoot / 'zebra-keep' / 'SKILL.md').is_file()


# ---------------------------------------------------------------------------
# (2) failures are loud, and never break the turn
# ---------------------------------------------------------------------------


class TestLoudFailures:
    def test_failed_usage_write_logs_and_does_not_raise(self, roots, monkeypatch, caplog):
        agentRoot, bundledRoot = roots
        md = _writeSkill(bundledRoot, 'zebra-blocked', 'zebra prism lattice primer')
        blocker = agentRoot.parent / 'blocked'
        blocker.write_text('a file where a directory must be', 'utf-8')
        monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: blocker / 'skills')

        with caplog.at_level(logging.WARNING, logger='august.skills'):
            skill_service.record_skill_use(md)  # must NOT raise
        assert 'failed to write sidecar' in caplog.text
        assert '.usage.json' in caplog.text
        assert skill_service.read_skill_usage('zebra-blocked')['count'] == 0

    def test_load_still_returns_when_the_sidecar_fails(self, roots, monkeypatch):
        import asyncio

        from app.services.tool_registrations.skill_tools import _loadSkill

        agentRoot, bundledRoot = roots
        _writeSkill(bundledRoot, 'zebra-load', 'zebra prism lattice primer')
        blocker = agentRoot.parent / 'blocked2'
        blocker.mkdir(parents=True)
        (blocker / 'skills').write_text('not a directory', 'utf-8')
        monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: blocker / 'skills')
        out = asyncio.run(_loadSkill('zebra-load'))
        assert not out.startswith('Error')


# ---------------------------------------------------------------------------
# (3) usage feeds disclosure ranking as a SMALL tie-breaker only
# ---------------------------------------------------------------------------


@pytest.fixture
def threeSkills(roots):
    """Two equally-relevant skills + one clearly more relevant one."""
    _agentRoot, bundledRoot = roots
    _writeSkill(bundledRoot, 'alpha-one', 'zebra notes')
    _writeSkill(bundledRoot, 'beta-one', 'zebra notes')
    _writeSkill(bundledRoot, 'gamma-one', 'zebra prism prism lattice lattice alignment')
    return roots


@pytest.fixture
def tieSkills(roots):
    """Two skills with byte-identical relevance text (only the name differs)."""
    _agentRoot, bundledRoot = roots
    _writeSkill(bundledRoot, 'alpha-one', 'zebra notes')
    _writeSkill(bundledRoot, 'beta-one', 'zebra notes')
    return roots


class TestUsageBoostIsSmall:
    def test_zero_usage_everywhere_leaves_the_bm25_order_untouched(self, threeSkills, monkeypatch):
        _agentRoot, _bundledRoot = threeSkills
        with monkeypatch.context() as m:
            # A pure-BM25 reference: every usage read answers zero.
            m.setattr(skill_service, 'read_skill_usage', lambda *a, **k: {'count': 0, 'lastUsed': ''})
            reference = _relevantOrder()
        assert reference, 'the fixture must produce a relevance block'
        assert _relevantOrder() == reference  # nothing recorded yet
        for name in ('alpha-one', 'beta-one', 'gamma-one'):
            _bump(name, 0)  # recorded, but zero
        assert _relevantOrder() == reference

    def test_used_skill_beats_an_equally_relevant_unused_one(self, tieSkills, monkeypatch):
        with monkeypatch.context() as m:
            m.setattr(skill_service, 'read_skill_usage', lambda *a, **k: {'count': 0, 'lastUsed': ''})
            assert _relevantOrder() == ['alpha-one', 'beta-one']  # name order on a true tie
        _bump('beta-one', 1)  # a single load (+0.05) is enough on an exact tie
        assert _relevantOrder() == ['beta-one', 'alpha-one']
        _bump('alpha-one', 4)
        assert _relevantOrder() == ['alpha-one', 'beta-one']  # more loads win

    def test_boost_is_capped_so_a_clearly_better_match_still_wins(self, threeSkills):
        _bump('alpha-one', 500)  # far past the cap
        order = _relevantOrder()
        assert order[0] == 'gamma-one', f'usage must not outrank relevance, got {order}'
        assert order.index('alpha-one') > order.index('gamma-one')

    def test_usage_failure_degrades_to_pure_relevance(self, threeSkills, monkeypatch, caplog):
        def boom(*_a, **_k):
            raise RuntimeError('sidecar store offline')

        monkeypatch.setattr(skill_service, 'read_skill_usage', boom)
        with caplog.at_level(logging.WARNING):
            order = _relevantOrder()
        assert order and order[0] == 'gamma-one'
        assert 'usage lookup failed' in caplog.text

    def test_no_skill_is_added_or_removed_by_usage(self, threeSkills):
        before = skill_service.catalogue()
        _bump('alpha-one', 40)
        after = skill_service.catalogue()
        assert [s['name'] for s in before] == [s['name'] for s in after]
        assert all(s['enabled'] for s in after)


# ---------------------------------------------------------------------------
# (4) episode_miner reads through the shared resolver
# ---------------------------------------------------------------------------


class TestEpisodeMinerUsesTheResolver:
    def test_load_count_reads_through_the_shared_resolver(self, roots, monkeypatch):
        from app.services import episode_miner as em

        agentRoot, bundledRoot = roots
        _writeSkill(bundledRoot, 'zebra-meter', 'zebra prism lattice primer')
        seen: list[str] = []

        def spy(name, **kw):
            seen.append(name)
            return {'count': 42, 'lastUsed': ''}

        monkeypatch.setattr(skill_service, 'read_skill_usage', spy)
        assert em._skillLoadCount('zebra-meter') == 42
        assert seen == ['zebra-meter']
        # no path construction left in the caller: the data dir stays untouched
        assert list(agentRoot.rglob('.usage.json')) == []

    def test_recorded_loads_are_visible_to_the_demotion_reader(self, roots):
        from app.services import episode_miner as em

        _agentRoot, bundledRoot = roots
        md = _writeSkill(bundledRoot, 'zebra-counts', 'zebra prism lattice primer')
        assert em._skillLoadCount('zebra-counts') == 0
        skill_service.record_skill_use(md)
        assert em._skillLoadCount('zebra-counts') == 1


# ---------------------------------------------------------------------------
# helpers for the ranking tests
# ---------------------------------------------------------------------------


def _bump(name: str, count: int) -> None:
    dest = skill_service.usage_sidecar_path(name)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({'count': count, 'lastUsed': 'recent'}), 'utf-8')
    skill_service._bust_catalogue_cache()
    capabilities_prompt._skills_bm25_cache.clear()


class TestUsageIsVisibleToTheClient:
    """The counters existed only for ranking: neither skill endpoint serialized
    them, so the catalogue could not answer "does anyone use this skill" and
    the UI had nothing to render.

    An untouched skill reports ``0`` rather than omitting the key. That
    distinction is the whole contract for the client: a missing field forces
    the renderer to guess between "nobody has used this" and "the server never
    looked", and a guess there is how a used skill ends up looking unused.
    """

    @staticmethod
    def _client():
        from app.main import app
        from httpx import ASGITransport, AsyncClient

        return AsyncClient(transport=ASGITransport(app=app), base_url='http://test')

    async def test_a_recorded_hit_shows_up_in_the_list(self, roots):
        agentRoot, _bundledRoot = roots
        md = _writeSkill(agentRoot, 'used-twice', 'Align the zebra prism lattice')
        skill_service.record_skill_use(md)
        skill_service.record_skill_use(md)
        async with self._client() as ac:
            body = (await ac.get('/api/skills')).json()
        row = next(r for r in body['skills'] if r['name'] == 'used-twice')
        assert row['usageCount'] == 2
        assert row['lastUsed'], 'a counted hit must also carry when it happened'

    async def test_an_untouched_skill_reports_zero_rather_than_omitting(self, roots):
        agentRoot, _bundledRoot = roots
        _writeSkill(agentRoot, 'never-used', 'Realign the zebra prism lattice')
        async with self._client() as ac:
            body = (await ac.get('/api/skills')).json()
        row = next(r for r in body['skills'] if r['name'] == 'never-used')
        assert row['usageCount'] == 0
        assert row['lastUsed'] == ''

    async def test_the_detail_endpoint_carries_the_same_counters(self, roots):
        agentRoot, _bundledRoot = roots
        md = _writeSkill(agentRoot, 'detail-used', 'Realign the zebra prism prism lattice')
        skill_service.record_skill_use(md)
        async with self._client() as ac:
            body = (await ac.get('/api/skills/detail-used')).json()
        assert body['usageCount'] == 1
        assert body['lastUsed']
