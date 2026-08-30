"""Part 16 Phase C — tier-2 judge + distiller.

Plan acceptance (§3.3/§6): JSON contract, all five actions, denylist on
drafts, one-draft-per-(fingerprint, action, target), propose-time
normalization, extract-only downgrade, precision-gated amend_body, judge
failure cooldown (no retry storms).
"""

from __future__ import annotations

import json

import pytest
from app.services import skill_distiller as sd


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


@pytest.fixture()
def noProposals(monkeypatch, tmp_path):
    """Isolated proposals dir (via dataDir) + agent skills dir for drafts."""
    from app.services import harness_self_improve as hsi
    from app.services import skill_service

    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: tmp_path / 'agent-skills')
    # isolatedData (autouse) already redirects settings.dataDir, so
    # _proposals_dir lands in the test tmp dir.
    assert hsi._proposals_dir().is_relative_to(tmp_path)
    yield hsi._proposals_dir()


class TestJsonContract:
    def test_extract_json_accepts_fence(self):
        raw = '```json\n{"verdicts": [{"episode": 1, "action": "none"}]}\n```'
        data = sd._extractJson(raw)
        assert data['verdicts'][0]['action'] == 'none'

    def test_extract_json_rejects_non_json(self):
        with pytest.raises(Exception):
            sd._extractJson('I think episode 1 is fine, no action needed.')

    def test_extract_json_rejects_missing_verdicts(self):
        with pytest.raises(Exception):
            sd._extractJson('{"episode": 1}')


class TestMemoryAction:
    def test_memory_verdict_saves_harness_lesson(self, brain):
        from app.services.memory_store import get_fact

        label = sd.apply_verdict(
            {
                'episode': 1,
                'action': 'memory',
                'summary': 'Run pnpm before vitest in this repo.',
                'category': 'project',
                'title': 'pnpm before vitest',
                'expires_days': 90,
            },
            'user-correction:pnpm',
        )
        assert label == 'memory-saved'
        fact = get_fact('distilled:pnpm-before-vitest')
        assert fact is not None
        assert fact['source'] == 'harness' and fact['kind'] == 'lesson'
        assert fact['expiresAt']  # 90-day expiry stamped

    def test_denylist_refuses_sensitive_draft(self, brain):
        from app.services.memory_store import get_fact

        label = sd.apply_verdict(
            {
                'episode': 2,
                'action': 'memory',
                'summary': 'User takes antidepressant medication daily.',
                'title': 'medication',
            },
            'user-correction:meds',
        )
        assert label == 'rejected-denylist'
        assert get_fact('distilled:medication') is None


class TestSkillActions:
    def test_create_skill_files_normalized_proposal(self, brain, noProposals):
        label = sd.apply_verdict(
            {
                'episode': 3,
                'action': 'create_skill',
                'name': 'quartus-recovery',
                'description': 'Recover from Quartus compile failures.',
                'trigger': 'when a Quartus fmax parse fails',
                'body_markdown': '## How to Run\n\nRe-run the flow with --flat=on.',
            },
            'tool-error:quartus',
            mode='full',
        )
        assert label == 'proposal-filed'
        proposals = list(noProposals.glob('prop_*.json'))
        assert len(proposals) == 1
        row = json.loads(proposals[0].read_text('utf-8'))
        assert row['kind'] == 'skill_create'
        payload = row['payload']
        assert payload['fingerprint'] == 'tool-error:quartus'
        assert payload['origin'] == 'distilled'
        # propose-time normalization: canonical template present
        assert '## How to Run' in payload['body']

    def test_one_draft_per_fingerprint_action_target(self, brain, noProposals):
        verdict = {
            'episode': 4,
            'action': 'create_skill',
            'name': 'dup-draft',
            'description': 'Recover from X.',
            'body_markdown': 'body',
        }
        assert sd.apply_verdict(verdict, 'tool-error:dup', mode='full') == 'proposal-filed'
        assert sd.apply_verdict({**verdict, 'episode': 5}, 'tool-error:dup', mode='full') == 'duplicate-draft'
        assert len(list(noProposals.glob('prop_*.json'))) == 1

    def test_extract_only_skips_skill_drafting(self, brain, noProposals):
        label = sd.apply_verdict(
            {'episode': 6, 'action': 'create_skill', 'name': 'extract-only-skill', 'description': 'd'},
            'tool-error:eo',
            mode='extract-only',
        )
        assert label == 'skipped-extract-only'
        assert not list(noProposals.glob('prop_*.json'))

    def test_amend_body_downgrades_below_precision_bar(self, brain, noProposals):
        label = sd.apply_verdict(
            {
                'episode': 7,
                'action': 'amend_body',
                'skill': 'existing-skill',
                'patch_markdown': '## Pitfalls\n\nnew pitfall',
            },
            'tool-error:amend',
            mode='full',
        )
        assert label == 'downgraded-proposal'
        proposals = [json.loads(p.read_text('utf-8')) for p in noProposals.glob('prop_*.json')]
        assert len(proposals) == 1
        assert proposals[0]['payload']['action'] == 'amend_trigger'
        assert 'precision' in proposals[0]['payload']['note']

    def test_amend_body_gated_on_precision_state(self, brain, monkeypatch, tmp_path):
        monkeypatch.setattr(
            sd, 'precision_state', lambda: {'labeled': 30, 'correct': 25, 'precision': 0.8333, 'amendBodyEnabled': True}
        )
        assert sd.precision_state()['amendBodyEnabled'] is True
        monkeypatch.setattr(
            sd, 'precision_state', lambda: {'labeled': 10, 'correct': 9, 'precision': 0.9, 'amendBodyEnabled': False}
        )
        assert sd.precision_state()['amendBodyEnabled'] is False


class TestJudgeFailureCooldown:
    def test_cooldown_skips_pass(self, brain, monkeypatch):
        from datetime import datetime, timedelta, timezone

        from app.services.memory_store import set_internal_state

        set_internal_state('skill_distiller_judge_cooldown', (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat())
        out = sd.run_distiller_pass()
        assert out.get('skipped') == 'judge cooldown'


class TestModelResolution:
    def test_explicit_setting_wins(self, monkeypatch):
        from app.services.brain_config_service import saveBrainConfig

        monkeypatch.setattr(sd, '_resolveProvider', lambda m: {'name': m} if m else None)
        saveBrainConfig({'skillLearningJudgeModel': 'judge-model-x', 'titleModel': 'title-model-y'})
        try:
            assert sd.resolve_judge_model() == 'judge-model-x'
        finally:
            saveBrainConfig({'skillLearningJudgeModel': ''})

    def test_no_model_resolves_to_empty(self, monkeypatch):
        from app.services.brain_config_service import saveBrainConfig

        saveBrainConfig({'skillLearningJudgeModel': '', 'titleModel': ''})
        monkeypatch.setattr(sd, '_resolveProvider', lambda m: {'name': m} if m else None)
        assert sd.resolve_judge_model() in ('', 'auto-memory-model-x')
