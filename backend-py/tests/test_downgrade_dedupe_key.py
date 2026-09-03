"""Part 16 §12 follow-up (2026-09-02 code-read finding) — the F-5 downgrade
observation's dedupe key.

The amend_body downgrade (pre-ship-bar) files a review-only ``observation``
whose payload carried ``action: 'amend_trigger'`` — the dedupe key
``_draftExists(fp, 'amend_trigger', skill)`` then matched ANY later genuine
``amend_trigger`` verdict for the same fingerprint+skill and silently dropped
it as ``duplicate-draft``. The observation is NOT an amend_trigger — its
``note`` field is the marker. Distinct intents must occupy distinct dedupe
keys; an observation must never suppress a genuine amend.

The fix: the downgrade observation files under its own ``action:
'amend_body_downgrade'`` key so it dedupes only against itself (re-file
suppression across passes — F-8 semantics preserved).
"""

from __future__ import annotations

import pytest
from app.services import episode_miner as em
from app.services import skill_distiller as sd


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


@pytest.fixture()
def agentRoot(monkeypatch, tmp_path):
    from app.services import skill_service

    root = tmp_path / 'agent-skills'
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: root)
    return root


def _learnedSkill(root, name: str = 'fixable-skill') -> None:
    (root / name).mkdir(parents=True, exist_ok=True)
    (root / name / 'SKILL.md').write_text(
        '---\nname: fixable-skill\ndescription: Fix.\ncreated_by: harness-proposal\n---\n'
        '# What this skill is\n\nA learnable skill.\n\n## When to Use\n\nWhen fixing.\n\n'
        '## How to Run\n\n1. do it\n\n## Pitfalls\n\nNone.\n\n## Verification\n\nCheck.\n',
        'utf-8',
    )


class TestDowngradeDedupeKey:
    def test_downgrade_observation_does_not_block_genuine_amend_trigger(self, brain, agentRoot):
        """RED case: F-5 downgrade (observation) then a genuine amend_trigger
        verdict for the same fingerprint+skill — the genuine amend MUST file,
        not read as duplicate against the observation."""
        _learnedSkill(agentRoot)
        # 1) Pre-bar amend_body downgrade files the observation.
        label1 = sd.apply_verdict(
            {'episode': 1, 'action': 'amend_body', 'skill': 'fixable-skill',
             'patch_markdown': '## Pitfalls\n\nnew thing'},
            'tool-error:dup-key',
            mode='full',
        )
        assert label1 == 'downgraded-proposal'

        from app.services import harness_self_improve as hsi

        # 2) A later genuine amend_trigger verdict for the SAME fp+skill.
        label2 = sd.apply_verdict(
            {'episode': 2, 'action': 'amend_trigger', 'skill': 'fixable-skill',
             'description': 'Better trigger wording'},
            'tool-error:dup-key',
            mode='full',
        )
        # The observation must not have consumed the amend_trigger dedupe key.
        assert label2 == 'proposal-filed', (
            'genuine amend_trigger must file even when a downgrade observation '
            'for the same fingerprint+skill exists'
        )
        props = hsi.list_proposals()
        kinds = [p['kind'] for p in props]
        assert 'skill_patch' in kinds, 'the genuine amend filed a real proposal'
        # The observation stays review-only.
        assert 'observation' in kinds

    def test_downgrade_observation_still_dedupes_against_itself(self, brain, agentRoot):
        """F-8 semantics preserved: a SECOND downgrade for the same fp+skill
        must not re-file the identical observation every pass."""
        _learnedSkill(agentRoot)
        label1 = sd.apply_verdict(
            {'episode': 1, 'action': 'amend_body', 'skill': 'fixable-skill',
             'patch_markdown': '## Pitfalls\n\nnew thing'},
            'tool-error:self-dedupe',
            mode='full',
        )
        assert label1 == 'downgraded-proposal'
        # Second pass, same fingerprint+skill → suppressed, not re-filed.
        label2 = sd.apply_verdict(
            {'episode': 1, 'action': 'amend_body', 'skill': 'fixable-skill',
             'patch_markdown': '## Pitfalls\n\nnew thing'},
            'tool-error:self-dedupe',
            mode='full',
        )
        assert label2 == 'downgraded-proposal'
        from app.services import harness_self_improve as hsi

        obs = [p for p in hsi.list_proposals() if p['kind'] == 'observation']
        assert len(obs) == 1, 'repeated downgrades must not re-file the observation'
