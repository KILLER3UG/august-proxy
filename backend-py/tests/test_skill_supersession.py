"""Skill supersession + catalogue mtime staleness.

Plan acceptance (§3.4/§6): v2 approval disables v1 in the same write and
stamps ``supersedes:`` provenance; caches bust; in-place SKILL.md edits
bust the catalogue memo without an explicit bust; learned skills carry
origin/learned_from/version/status frontmatter.
"""

from __future__ import annotations

import asyncio
import json
import time

import pytest
from app.services import harness_self_improve as hsi
from app.services import skill_service


@pytest.fixture()
def isolated(monkeypatch, tmp_path):
    """Sandboxed agent root + proposals dir."""
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path / 'data'))
    skill_service._bust_prompt_skills_cache()
    skill_service._flat_migrate_done = True
    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: tmp_path / 'agent-skills')
    (tmp_path / 'agent-skills').mkdir(parents=True, exist_ok=True)
    (tmp_path / 'data' / 'harness_proposals').mkdir(parents=True, exist_ok=True)
    yield tmp_path
    skill_service._bust_prompt_skills_cache()


def _writeSkill(root, name: str, description: str) -> None:
    d = root / 'agent-skills' / name
    d.mkdir(parents=True, exist_ok=True)
    (d / 'SKILL.md').write_text(
        '---\n'
        f'name: {name}\n'
        f'description: {description}\n'
        'category: learned\n'
        'created_by: human\n'
        '---\n\n'
        'Body.\n',
        'utf-8',
    )
    skill_service._bust_prompt_skills_cache()


class TestMtimeStaleness:
    def test_in_place_edit_busts_catalogue(self, isolated):
        _writeSkill(isolated, 'mtime-skill', 'first description')
        first = {e['name']: e['description'] for e in skill_service.catalogue()}
        assert first['mtime-skill'] == 'first description'

        # In-place edit: the skill DIR mtime does not change on Windows
        # unless a file is added — the per-skill SKILL.md mtime in the memo
        # key must catch it.
        time.sleep(0.02)
        md = isolated / 'agent-skills' / 'mtime-skill' / 'SKILL.md'
        md.write_text(
            md.read_text('utf-8').replace('first description', 'second description'),
            'utf-8',
        )
        second = {e['name']: e['description'] for e in skill_service.catalogue()}
        assert second['mtime-skill'] == 'second description'


class TestSupersession:
    def test_approved_v2_disables_v1_same_write(self, isolated):
        _writeSkill(isolated, 'legacy-flow', 'v1 of the flow')
        row = hsi.save_proposal(
            problem='supersede legacy-flow',
            evidence='recurring fingerprint evidence',
            proposal='create the v2',
            rollback='delete the v2; re-enable v1 in Settings → Skills',
            kind='skill_create',
            payload={
                'name': 'legacy-flow-v2',
                'description': 'v2 of the flow',
                'body': 'Better body.',
                'supersedes': 'legacy-flow',
                'origin': 'distilled',
                'episodeIds': ['12', '13'],
            },
        )
        res = hsi.decide_proposal(row['id'], 'approve')
        assert res['status'] == 'applied', res.get('applyResult')
        assert 'legacy-flow' in str(res['applyResult'].get('superseded', ''))
        # v1 disabled in the same write
        assert skill_service.isEnabled('legacy-flow') is False
        # v2 live with provenance frontmatter
        v2 = skill_service.get('legacy-flow-v2')
        assert v2 is not None and v2['enabled'] is True
        raw = (isolated / 'agent-skills' / 'legacy-flow-v2' / 'SKILL.md').read_text('utf-8')
        assert 'supersedes: legacy-flow' in raw
        assert 'origin: distilled' in raw
        assert 'learned_from: 12,13' in raw
        assert 'version: 1' in raw
        assert 'status: active' in raw
        # double injection guard: only v2 in the enabled catalogue
        names = [e['name'] for e in skill_service.catalogue()]
        assert 'legacy-flow-v2' in names and 'legacy-flow' not in names

    def test_a_silent_patch_keeps_the_lineage_the_create_wrote(self, isolated):
        """A patch restates the body, not the skill's history.

        Without the carry-over, the second approved revision of a learned
        skill lost ``supersedes`` (so the retired v1 was no longer named
        anywhere) and flipped ``origin`` from distilled back to human —
        rewriting a skill as a side effect of improving it.
        """
        created = hsi.save_proposal(
            problem='learn the flow',
            evidence='e',
            proposal='create v1',
            rollback='delete it',
            kind='skill_create',
            payload={
                'name': 'kept-lineage',
                'description': 'v1',
                'body': 'Body.',
                'trigger': 'close timing',
                'supersedes': 'legacy-flow',
                'origin': 'distilled',
                'episodeIds': ['7', '8'],
            },
        )
        assert hsi.decide_proposal(created['id'], 'approve')['status'] == 'applied'
        patched = hsi.save_proposal(
            problem='tighten the steps',
            evidence='e',
            proposal='patch it',
            rollback='git restore',
            kind='skill_patch',
            payload={'name': 'kept-lineage', 'description': 'v2', 'body': 'Better body.'},
        )
        assert hsi.decide_proposal(patched['id'], 'approve')['status'] == 'applied'
        raw = (isolated / 'agent-skills' / 'kept-lineage' / 'SKILL.md').read_text('utf-8')
        assert 'supersedes: legacy-flow' in raw
        assert 'origin: distilled' in raw
        assert 'learned_from: 7,8' in raw
        # The trigger is what per-turn relevance matching reads; a patch that
        # restates only the body used to retire the skill from recall.
        assert 'trigger: close timing' in raw
        assert 'version: 2' in raw

    def test_patch_bumps_version(self, isolated):
        _writeSkill(isolated, 'versioned-skill', 'v1')
        raw = (isolated / 'agent-skills' / 'versioned-skill' / 'SKILL.md').read_text('utf-8')
        (isolated / 'agent-skills' / 'versioned-skill' / 'SKILL.md').write_text(
            raw.replace('created_by: human', 'created_by: harness-proposal\nversion: 3'),
            'utf-8',
        )
        skill_service._bust_prompt_skills_cache()
        row = hsi.save_proposal(
            problem='patch versioned-skill',
            evidence='e',
            proposal='improve it',
            rollback='git restore the skill dir',
            kind='skill_patch',
            payload={'name': 'versioned-skill', 'description': 'v4 body', 'body': 'New body.'},
        )
        res = hsi.decide_proposal(row['id'], 'approve')
        assert res['status'] == 'applied', res.get('applyResult')
        assert res['applyResult']['version'] == 4
        raw2 = (isolated / 'agent-skills' / 'versioned-skill' / 'SKILL.md').read_text('utf-8')
        assert 'version: 4' in raw2

    def test_supersession_result_reported_even_when_target_missing(self, isolated):
        row = hsi.save_proposal(
            problem='supersede ghost',
            evidence='e',
            proposal='create v2',
            rollback='delete the v2',
            kind='skill_create',
            payload={
                'name': 'ghost-v2',
                'description': 'v2',
                'body': 'Body.',
                'supersedes': 'ghost-skill-that-never-existed',
            },
        )
        res = hsi.decide_proposal(row['id'], 'approve')
        assert res['status'] == 'applied'
        assert 'failed to disable' in str(res['applyResult'].get('superseded', ''))

    def test_proposal_payload_roundtrips_supersedes(self, isolated):
        row = hsi.save_proposal(
            problem='p', evidence='e', proposal='x', rollback='r',
            kind='skill_create',
            payload={'name': 'rt-skill', 'description': 'd', 'body': 'b', 'supersedes': 'older'},
        )
        stored = hsi.get_proposal(row['id'])
        assert stored is not None
        assert stored['payload']['supersedes'] == 'older'
        assert json.dumps(stored)  # serializable


class TestLineageReachesTheHttpRow:
    """Settings can only show what the routes send.

    Both ``GET /api/skills`` and ``GET /api/skills/{name}`` rebuild their
    payload field by field from the parse, and the provenance keys live in the
    unrecognized-frontmatter bag rather than as parsed fields — so a lineage
    key carried by one endpoint and dropped by the other is a write-only
    field, which is the failure this repo has already been bitten by once.
    """

    def _approve_v2(self, isolated) -> None:
        _writeSkill(isolated, 'legacy-flow', 'v1 of the flow')
        row = hsi.save_proposal(
            problem='supersede legacy-flow',
            evidence='e',
            proposal='create the v2',
            rollback='delete the v2',
            kind='skill_create',
            payload={
                'name': 'legacy-flow-v2',
                'description': 'v2 of the flow',
                'body': 'Better body.',
                'supersedes': 'legacy-flow',
                'origin': 'distilled',
            },
        )
        assert hsi.decide_proposal(row['id'], 'approve')['status'] == 'applied'

    def test_list_and_detail_carry_the_same_stamp(self, isolated):
        from app.routers import skills as skills_route

        self._approve_v2(isolated)
        listed = asyncio.run(skills_route.listSkills(q='', category='', workspace=''))
        rows = {str(s['name']): s for s in listed['skills']}
        detail = asyncio.run(skills_route.getSkill('legacy-flow-v2', workspace=''))
        for row in (rows['legacy-flow-v2'], detail):
            assert row['supersedes'] == 'legacy-flow'
            assert row['origin'] == 'distilled'
            assert row['version'] == 1
            assert row['status'] == 'active'

    def test_the_route_reports_the_bumped_version(self, isolated):
        """Frontmatter values are strings, so an ``int``-only narrow here read
        every learned skill as version 1 straight off a file saying 3."""
        from app.routers import skills as skills_route

        self._approve_v2(isolated)
        patch = hsi.save_proposal(
            problem='refine', evidence='e', proposal='improve it', rollback='git restore',
            kind='skill_patch',
            payload={'name': 'legacy-flow-v2', 'description': 'v2', 'body': 'Newer body.'},
        )
        assert hsi.decide_proposal(patch['id'], 'approve')['status'] == 'applied'
        row = asyncio.run(skills_route.getSkill('legacy-flow-v2', workspace=''))
        assert row['version'] == 2
        assert row['supersedes'] == 'legacy-flow'

    def test_a_hand_written_skill_reads_as_version_one_with_no_lineage(
        self, isolated
    ):
        from app.routers import skills as skills_route

        _writeSkill(isolated, 'plain-skill', 'no provenance frontmatter')
        row = asyncio.run(skills_route.getSkill('plain-skill', workspace=''))
        # Absent must not render as "v0", "replaces ", or an error.
        assert row['supersedes'] == ''
        assert row['origin'] == ''
        assert row['version'] == 1
