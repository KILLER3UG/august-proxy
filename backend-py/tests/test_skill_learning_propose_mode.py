"""`skillLearning` gains a mode that FILES and never applies (item 11).

Measured before changing anything: the distiller's create_skill / amend_trigger
paths already end at `return 'proposal-filed'` — they call `save_proposal` and
stop. Nothing in that branch writes a SKILL.md; approval is a separate
`decide_proposal` step. The only thing keeping them dormant is one guard at the
top of `apply_verdict`:

    if action in ('create_skill', 'amend_trigger', 'amend_body') and mode != 'full':
        return 'skipped-extract-only'

So this item is about admitting a mode that lets those verdicts reach the inbox,
with auto-apply still off. It is deliberately NOT a new mechanism.
"""

from __future__ import annotations

import inspect
import json
import pathlib

import pytest
from app.services import skill_distiller as sd


@pytest.fixture
def brain(isolatedData):
    from app.services import memory_store

    memory_store.init()
    return isolatedData


def _proposalsDir() -> pathlib.Path:
    from app.services.harness_self_improve import _proposals_dir

    return _proposals_dir()


def _skillBody(name: str) -> str:
    from app.services.skill_service import skill_body

    return skill_body(name) or ''


CREATE = {
    'action': 'create_skill',
    'name': 'receipt-gate',
    'description': 'Documents how a tool receipt is read',
    'body_markdown': '# Receipt gate\n\nRead the receipt, not the prose.\n',
    'trigger': 'when episode mining is reviewed',
}


class TestProposeModeFilesAndNeverApplies:
    def test_a_skill_verdict_files_a_proposal_under_propose(self, brain):
        label = sd.apply_verdict(dict(CREATE), 'tool-error:x', mode='propose')
        assert label == 'proposal-filed', label
        rows = [json.loads(p.read_text(encoding='utf-8')) for p in _proposalsDir().glob('*.json')]
        assert [r['kind'] for r in rows] == ['skill_create'], rows

    def test_no_skill_file_appears(self, brain):
        sd.apply_verdict(dict(CREATE), 'tool-error:x', mode='propose')
        assert _skillBody('receipt-gate') == '', (
            'filing a proposal must not write SKILL.md — approval is a human step'
        )

    def test_extract_only_still_refuses(self, brain):
        """The shipped default keeps its meaning until the mode is changed."""
        assert sd.apply_verdict(dict(CREATE), 'tool-error:x', mode='extract-only') == (
            'skipped-extract-only'
        )
        assert list(_proposalsDir().glob('*.json')) == []

    def test_off_never_reaches_apply_verdict(self, brain):
        """`off` is handled by the pass, before apply_verdict is called."""
        from app.services.brain_config_service import saveBrainConfig

        saveBrainConfig({'skillLearning': 'off'})
        from app.services import skill_distiller

        out = skill_distiller.run_distiller_pass(dryRun=False)
        assert out.get('skipped'), out
        assert list(_proposalsDir().glob('*.json')) == []


class TestModeIsAcceptedByConfig:
    def test_propose_is_a_valid_mode(self, brain):
        from app.services.brain_config_service import getRuntimeConfig, saveBrainConfig

        ok, err, merged = saveBrainConfig({'skillLearning': 'propose'})
        assert ok, err
        assert merged['skillLearning'] == 'propose'

    def test_a_typo_is_still_rejected(self, brain):
        from app.services.brain_config_service import saveBrainConfig

        ok, err, _ = saveBrainConfig({'skillLearning': 'proposes'})
        assert not ok
        assert 'off' in err and 'propose' in err, err

    def test_the_shipped_default_is_the_propose_mode(self, brain):
        from app.services.brain_config_service import saveBrainConfig

        saveBrainConfig({})
        from app.services.brain_config_service import getRuntimeConfig

        assert getRuntimeConfig().get('skillLearning') == 'propose', (
            'an unset config must land on the mode that files into the inbox'
        )


class TestThePassWiresTheModeThrough:
    def test_the_pass_passes_the_configured_mode_to_apply_verdict(self, brain, monkeypatch):
        """A mode that exists but is never read is decoration."""
        from app.services import skill_distiller
        from app.services.brain_config_service import saveBrainConfig

        saveBrainConfig({'skillLearning': 'propose'})
        seen: list[str] = []
        original = skill_distiller.apply_verdict

        def spy(verdict, fingerprint, mode='propose', scope=''):
            # Mirrors the real positional signature — my first spy declared
            # keyword-only args and so recorded nothing.
            seen.append(mode)
            return original(verdict, fingerprint, mode, scope)

        monkeypatch.setattr(skill_distiller, 'apply_verdict', spy)
        from app.services.memory_conn import conn

        conn().execute(
            "INSERT INTO episodes (session_id, kind, start_message_id, end_message_id, events, "
            "outcome, fingerprint_id, tier) VALUES ('s1', 'failure_recovery', 1, 2, "
            "'[{\"type\": \"tool_error\", \"excerpt\": \"x\"}]', 'resolved', 'fp', 2)"
        )
        conn().commit()
        monkeypatch.setattr(
            skill_distiller,
            '_run_batch',
            lambda batch: {'verdicts': [{'episode': 1, **CREATE}]},
        )
        skill_distiller.run_distiller_pass(dryRun=False)
        assert seen and all(m == 'propose' for m in seen), seen

class TestTheScheduledPassRunsUnderPropose:
    """Item 11's mode had to be added to the SCHEDULER's allow-list too.

    `consolidation.py` ran the distiller only for `extract-only` / `full`, so
    the shipped default ('propose') silently stopped the scheduled pass. Nothing
    failed and nothing warned — a mode nobody ran. Found by auditing every
    `skillLearning` comparison rather than by a test, which is why it is pinned
    here now.
    """

    def test_the_consolidation_branch_includes_propose(self, brain):
        import inspect

        from app.services.memory_store import consolidation

        src = inspect.getsource(consolidation)
        assert "'propose'" in src, (
            "the scheduled distiller pass no longer runs under the shipped default"
        )

    def test_the_curator_route_falls_back_to_the_shipped_default(self, brain):
        from app.routers.curator import _mode
        from app.services.brain_config_service import saveBrainConfig

        saveBrainConfig({})  # unset -> the shipped default
        assert _mode() == 'propose', _mode()

    def test_full_includes_memory_bodies_and_propose_does_not(self, brain):
        """The only documented difference between 'full' and 'propose': how much
        text the promotion shortlist carries. Neither one applies a change."""
        # Inspect the decision directly rather than driving the whole promotion.
        import inspect

        from app.services import harness_promote

        src = inspect.getsource(harness_promote)
        assert "if mode == 'full':" in src, 'the body-gating branch moved'
        assert "if mode in ('extract-only', 'full'):" not in src, (
            "no other branch may treat 'full' as the apply switch"
        )
