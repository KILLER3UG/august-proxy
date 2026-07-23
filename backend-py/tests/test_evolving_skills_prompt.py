"""Evolving skills + genesis approve → catalogue / load_skill."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from app.services import skill_service
from app.services.tool_definitions import _loadSkill


@pytest.fixture
def agent_skills(tmp_path, monkeypatch):
    root = tmp_path / 'data' / 'skills'
    root.mkdir(parents=True)

    class _S:
        dataDir = str(tmp_path / 'data')

    monkeypatch.setattr('app.config.settings', _S(), raising=False)
    # Reset migrate-once flag so list_all sees this root
    skill_service._flat_migrate_done = False
    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: root)
    return root


class TestEvolvingLoadSkill:
    @pytest.mark.asyncio
    async def test_create_skill_appears_in_catalogue_and_load(self, agent_skills):
        skill_service.createSkill(
            'prefer-tabs',
            'Prefer tabs in repo',
            '## Procedure\n\n1. Use tabs.\n',
            trigger='formatting',
            category='style',
            createdBy='agent',
        )
        cat = skill_service.catalogue()
        entry = next(c for c in cat if c['name'] == 'prefer-tabs')
        assert entry.get('created_by') == 'agent'
        body = await _loadSkill('prefer-tabs')
        assert 'Use tabs' in body
        assert 'Error' not in body[:40]

    @pytest.mark.asyncio
    async def test_bundled_skill_still_loads_after_refactor(self, isolatedSkills):
        """Regression: bundled (non-evolving) skills remain loadable via load_skill."""
        __, bundled = isolatedSkills
        d = bundled / 'alpha-bundled'
        d.mkdir(parents=True)
        (d / 'SKILL.md').write_text(
            '---\nname: alpha-bundled\ndescription: Bundled skill ok.\n'
            'category: testing\n---\n\n# Alpha\n\nBundled body step.\n',
            'utf-8',
        )
        skill_service._flat_migrate_done = True  # skip migrate noise
        got = skill_service.get('alpha-bundled')
        assert got is not None
        body = await _loadSkill('alpha-bundled')
        assert 'Bundled body step' in body


class TestGenesisApprove:
    def test_approve_writes_agent_root_not_flat(self, agent_skills, tmp_path, monkeypatch):
        from app.services import consolidation_daemon as cd

        staging = tmp_path / 'staging'
        staging.mkdir()
        draft = staging / 'debug-python-script.md'
        draft.write_text(
            '---\nname: debug-python-script\ndescription: Debug python scripts\n'
            'trigger: debug py\ncreated_by: auto-gen\n---\n\n# Debug\n\n1. Reproduce.\n',
            'utf-8',
        )

        class FakeConn:
            def __init__(self):
                self.row = {
                    'name': 'debug-python-script',
                    'description': 'Debug python scripts',
                    'trigger_text': 'debug py',
                    'draft_path': str(draft),
                }
                self.updates = []

            def execute(self, sql, params=()):
                if sql.strip().upper().startswith('SELECT'):
                    return self

                self.updates.append((sql, params))
                return self

            def fetchone(self):
                return self.row

            def commit(self):
                pass

        fake = FakeConn()
        monkeypatch.setattr('app.services.memory_store._conn', lambda: fake)

        ok = cd.approvePendingSkill('debug-python-script')
        assert ok is True
        dest = agent_skills / 'debug-python-script' / 'SKILL.md'
        assert dest.is_file()
        assert skill_service.get('debug-python-script') is not None
        # Must not leave a flat skills/{name}.md under agent root
        assert not (agent_skills / 'debug-python-script.md').exists()


class TestFlatMigration:
    def test_migrate_flat_md_into_skill_dir(self, tmp_path):
        agent = tmp_path / 'agent'
        agent.mkdir()
        flat = agent / 'old-lesson.md'
        flat.write_text(
            '---\nname: old-lesson\ndescription: Old flat skill\n---\n\nBody here.\n',
            'utf-8',
        )
        migrated = skill_service.migrate_flat_skills(bundled_root=tmp_path / 'missing', agent_root=agent)
        assert 'old-lesson' in migrated
        assert (agent / 'old-lesson' / 'SKILL.md').is_file()
        assert not flat.exists()
