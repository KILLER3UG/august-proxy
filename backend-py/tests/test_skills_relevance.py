"""Skill-loop round: per-turn relevance injection + real usage telemetry.

Covers:
- select_relevant_skills ranking (trigger > name > description), fallback,
  evolving floor, limit;
- format_skill_index compactness (names only, grouped, [evolving] markers);
- build_relevant_skills_block kill switches (env + brain config);
- load_skill bumps BOTH view and use (effectiveness scoring was starved);
- patchSkill snapshots the prior SKILL.md into <skill>/.history/.
"""

from __future__ import annotations

import pytest
from app.services.memory.capabilities_prompt import (
    build_relevant_skills_block,
    format_skill_index,
    select_relevant_skills,
    skill_relevance_enabled,
)


def _entry(name, desc, trigger='', category='general', created_by=''):
    return {
        'name': name,
        'description': desc,
        'trigger': trigger,
        'category': category,
        'created_by': created_by,
    }


CATALOGUE = [
    _entry('docker-deploy', 'Deploy services with docker compose.', trigger='deploy the stack', category='devops'),
    _entry('pytest-patterns', 'Fixtures and parametrize recipes.', category='testing'),
    _entry('learned-review-rule', 'Lesson about review gates.', category='process', created_by='agent'),
]


class TestSelectRelevantSkills:
    def testTriggerPhraseHitRanksFirst(self):
        text = 'please help me deploy the stack on staging before noon'
        entries, fell_back = select_relevant_skills(CATALOGUE, text)
        assert fell_back is False
        assert entries[0]['name'] == 'docker-deploy'

    def testNameTokenMatchSurfaces(self):
        text = 'my pytest fixtures keep failing in ci'
        entries, fell_back = select_relevant_skills(CATALOGUE, text)
        assert fell_back is False
        assert entries[0]['name'] == 'pytest-patterns'

    def testShortTextFallsBack(self):
        entries, fell_back = select_relevant_skills(CATALOGUE, 'hi')
        assert (entries, fell_back) == ([], True)

    def testNoSignalFallsBack(self):
        text = 'quantum umbrellas disagree with harmonicas'
        entries, fell_back = select_relevant_skills(CATALOGUE, text)
        assert fell_back is True

    def testEvolvingWinsTies(self):
        """Agent-authored skills get a tie-break bonus over bundled entries
        with identical relevance signal — relevance still wins outright, but
        the loop's own lessons are favored on equal signal."""
        bundled = _entry('guide-alpha', 'Widget guide for widgets.')
        evolving = _entry('guide-beta', 'Widget guide for widgets.', created_by='agent')
        entries, fell_back = select_relevant_skills([bundled, evolving], 'widget guide please')
        assert fell_back is False
        assert [e['name'] for e in entries] == ['guide-beta', 'guide-alpha']

    def testLimitRespected(self):
        many = [_entry(f'alpha-{i}', 'alpha tool for alpha jobs') for i in range(6)]
        entries, fell_back = select_relevant_skills(many, 'need an alpha tool right now', limit=3)
        assert fell_back is False
        assert len(entries) == 3


class TestFormatSkillIndex:
    def testNamesOnlyGroupedByCategory(self):
        idx = format_skill_index(CATALOGUE)
        assert '### devops' in idx
        assert '- docker-deploy' in idx
        assert '- learned-review-rule [evolving]' in idx
        # Descriptions must NOT ride in the compact index (they move to the
        # per-turn Tier-3 block).
        assert 'Deploy services with docker compose.' not in idx

    def testKeepsDiscoveryInstructions(self):
        idx = format_skill_index(CATALOGUE)
        assert 'load_skill' in idx
        assert '<relevant_skills>' in idx

    def testEmptyCatalogue(self):
        assert '(no skills discovered)' in format_skill_index([])


class TestKillSwitches:
    def testEnvKillSwitch(self, monkeypatch):
        monkeypatch.setenv('AUGUST_SKILL_RELEVANCE', '0')
        assert skill_relevance_enabled() is False
        assert build_relevant_skills_block('deploy the stack please') == ''

    def testBrainConfigOff(self, monkeypatch):
        from app.services import brain_config_service

        monkeypatch.setattr(
            brain_config_service,
            'getRuntimeConfig',
            lambda: {'skillRelevanceMatch': False},
        )
        assert skill_relevance_enabled() is False

    def testDefaultOn(self, monkeypatch):
        monkeypatch.delenv('AUGUST_SKILL_RELEVANCE', raising=False)
        from app.services import brain_config_service

        monkeypatch.setattr(brain_config_service, 'getRuntimeConfig', lambda: {})
        assert skill_relevance_enabled() is True


class TestBuildRelevantSkillsBlock:
    def testTopKSelectionBoundsEntries(self):
        many = [
            _entry(f'deploy-step-{i}', f'Deploy stage number {i}.', category='devops') for i in range(5)
        ]
        entries, fell_back = select_relevant_skills(many, 'help me deploy the service end to end')
        assert fell_back is False
        assert len(entries) <= 8
        assert all('deploy' in e['name'] or 'Deploy' in e['description'] for e in entries)

    def testFallbackContainsFullCatalogue(self, monkeypatch):
        from app.services import skill_service

        cat = list(CATALOGUE)

        def fake_catalogue():
            return cat

        monkeypatch.setattr(skill_service, 'catalogue', fake_catalogue)
        block = build_relevant_skills_block('hi there')
        assert 'Deploy services with docker compose.' in block
        assert '(0 more available' not in block


class TestLoadSkillUsageTelemetry:
    @pytest.mark.asyncio
    async def testLoadBumpsViewAndUse(self, isolatedSkills, monkeypatch):
        agentRoot, bundledRoot = isolatedSkills
        d = bundledRoot / 'telemetry-skill'
        d.mkdir()
        (d / 'SKILL.md').write_text(
            '---\nname: telemetry-skill\ndescription: Counts loads.\n---\n\nbody here\n', 'utf-8'
        )
        from app.services.skills import curator as curator_mod
        from app.services.tool_definitions import _loadSkill

        fresh = curator_mod.SkillCurator(dataDir=agentRoot.parent)
        monkeypatch.setattr(curator_mod, 'shared_curator', lambda: fresh)
        result = await _loadSkill('telemetry-skill')
        assert 'body here' in result
        rec = fresh.get_record('telemetry-skill')
        assert rec is not None
        assert rec.viewCount == 1
        assert rec.useCount == 1


class TestPatchHistory:
    def testPatchSnapshotsPriorBody(self, isolatedSkills):
        from app.services import skill_service

        agentRoot, _bundledRoot = isolatedSkills
        skill_service.createSkill('history-skill', 'Original.', 'original body')
        skill_service.patchSkill('history-skill', body='rewritten body')
        historyDir = agentRoot / 'history-skill' / '.history'
        assert historyDir.is_dir(), '.history dir missing after patch'
        snaps = sorted(historyDir.glob('SKILL.*.md'))
        assert len(snaps) == 1
        assert 'original body' in snaps[0].read_text('utf-8')

    def testHistoryRetainedCapTen(self, isolatedSkills):
        from app.services import skill_service

        skill_service.createSkill('cap-history', 'Cap.', 'v0 body')
        for i in range(14):
            skill_service.patchSkill('cap-history', body=f'v{i + 1} body')
        snaps = sorted((isolatedSkills[0] / 'cap-history' / '.history').glob('SKILL.*.md'))
        assert len(snaps) <= 10
