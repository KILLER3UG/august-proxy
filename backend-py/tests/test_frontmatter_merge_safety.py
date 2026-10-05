"""Frontmatter is merged, never replaced (backlog item 12).

`_apply_skill_write` re-renders the WHOLE frontmatter block, so any field the
proposal is silent about would vanish — and one of them, `disabled`, is the
kind of loss that is both invisible and functional: setEnabled writes exactly
`disabled: true`, and _parseSkill keys enablement off it, so a patch that
restated nothing would quietly put a retired skill back into <capabilities>,
<relevant_skills> and the intake line.

The merge logic existed before this test (Part 16 Phase D). What did NOT exist
was a test pinning it, which is why the guarantee was unverified.
"""

from __future__ import annotations

import pytest
from app.services import harness_self_improve as hsi


@pytest.fixture
def brain(isolatedData):
    from app.services import memory_store

    memory_store.init()
    return isolatedData


def _skillDir(name: str):
    from app.services.skill_service import _agentSkillsDir

    return _agentSkillsDir() / name


def _writeSkill(name: str, frontmatter: str, body: str = '# Body\n\ntext\n') -> None:
    d = _skillDir(name)
    d.mkdir(parents=True, exist_ok=True)
    (d / 'SKILL.md').write_text(f'---\n{frontmatter.strip()}\n---\n\n{body}', encoding='utf-8')


def _frontmatter(name: str) -> dict[str, str]:
    return hsi._parse_frontmatter_from_md((_skillDir(name) / 'SKILL.md').read_text('utf-8'))


def _patch(name: str, **payload) -> dict:
    row = hsi.save_proposal(
        problem=f'patch {name}',
        evidence='measured recurrence',
        proposal='amend the body only',
        rollback='reject the proposal',
        kind='skill_patch',
        payload={'name': name, 'body': '# Body\n\nrevised text\n', **payload},
    )
    return hsi._apply_approved(row)


class TestCarriedFields:
    """A body-only patch must not erase what only the SKILL knows."""

    RICH = (
        'name: carried\n'
        'description: carries its provenance\n'
        'trigger: when reviewing episode mining\n'
        'origin: distilled\n'
        'learned_from: ep-1, ep-2\n'
        'status: active\n'
        'disabled: true\n'
        'supersedes: older-skill\n'
        'keywords: [alpha, beta]\n'
        'version: 4\n'
    )

    def _patched(self, brain):
        _writeSkill('carried', self.RICH)
        out = _patch('carried')
        assert out.get('ok'), out
        return _frontmatter('carried')

    def test_trigger_survives_a_body_only_patch(self, brain):
        assert self._patched(brain).get('trigger') == 'when reviewing episode mining'

    def test_origin_survives(self, brain):
        assert self._patched(brain).get('origin') == 'distilled'

    def test_learned_from_survives(self, brain):
        learned = self._patched(brain).get('learned_from', '')
        assert 'ep-1' in learned and 'ep-2' in learned, learned

    def test_supersedes_survives(self, brain):
        assert self._patched(brain).get('supersedes') == 'older-skill'

    def test_version_bumps_rather_than_resetting(self, brain):
        assert int(self._patched(brain).get('version') or 0) == 5

    def test_keywords_survive(self, brain):
        kw = self._patched(brain).get('keywords', '')
        assert 'alpha' in kw and 'beta' in kw, kw


class TestTheSilentOne:
    def test_a_disabled_skill_stays_disabled(self, brain):
        """The loss that is invisible and functional: the skill would reappear
        in <capabilities> and the intake line with nobody deciding to revive it."""
        _writeSkill(
            'quiet',
            'name: quiet\ndescription: retired on purpose\nstatus: retired\ndisabled: true\n',
        )
        out = _patch('quiet')
        assert out.get('ok'), out
        fm = _frontmatter('quiet')
        assert str(fm.get('disabled', '')).strip().lower() in ('true', '1', 'yes'), fm

    def test_a_disabled_skill_is_not_offered_for_dispatch(self, brain):
        from app.services.skill_service import isEnabled

        _writeSkill(
            'quiet2',
            'name: quiet2\ndescription: retired on purpose\nstatus: retired\ndisabled: true\n',
        )
        _patch('quiet2')
        assert isEnabled('quiet2') is False

    def test_status_is_carried_but_an_approved_patch_revives_a_retired_one(self, brain):
        """Documented behavior, pinned so it cannot drift silently: the code
        treats an approved patch as the explicit act of reviving a retired
        skill (status falls back to the prior value; `disabled` does not)."""
        _writeSkill(
            'retired',
            'name: retired\ndescription: was retired\nstatus: retired\ndisabled: false\n',
        )
        _patch('retired')
        assert _frontmatter('retired').get('status') == 'retired'


class TestAnEnabledSkillIsUnaffected:
    def test_an_enabled_skill_stays_enabled_through_a_patch(self, brain):
        from app.services.skill_service import isEnabled

        _writeSkill('loud', 'name: loud\ndescription: fine\ndisabled: false\n')
        _patch('loud')
        assert isEnabled('loud') is True
        assert str(_frontmatter('loud').get('disabled', '')).lower() not in ('true',)