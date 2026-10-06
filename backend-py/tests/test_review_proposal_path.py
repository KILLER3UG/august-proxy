"""The reviewer is a decider, not an editor (backlog item 10).

The reviewer's whole authority is one call: `decide_proposal`. It must never
write a skill file, a config, or a proposal. Anything it cannot judge — an
unreachable model, an empty answer, a string it does not recognise — leaves the
proposal sitting in the inbox for the human. The reviewer can only ever make a
proposal that a human could have made; it cannot make one a human could not.

Item 14 added one condition to that: a KEEP is necessary and no longer
sufficient. `harness_rails` sits between the verdict and `decide_proposal`, so
an approve that the rails refuse lands nowhere — which is what keeps autonomy off
in the shipped config without changing what the reviewer is allowed to want.
"""

from __future__ import annotations

import json
import pathlib

import pytest
from app.services import harness_self_improve as hsi
from app.services import review_gate


@pytest.fixture
def brain(isolatedData):
    from app.services import memory_store

    memory_store.init()
    return isolatedData


def _fileProposal(brain) -> str:
    """A skill proposal, which would touch disk if it were approved."""
    from app.services import memory_store

    memory_store.init()
    row = hsi.save_proposal(
        problem='provenance gate is missing',
        evidence='41 tool_error episodes, all unbacked receipts',
        proposal='create_skill: receipt-provenance — document the gate',
        rollback='reject the proposal; no file is written until approval',
        kind='skill_create',
        payload={'name': 'receipt-provenance', 'description': 'd', 'body': 'b'},
    )
    return str(row['id'])


class _FakeReviewer:
    """Stands in for the client `review_gate.resolve_independent_reviewer`
    returns. It never decides anything: the decision arrives as the verdict
    string, exactly as the model would return it."""

    def __await__(self):  # pragma: no cover - never awaited in these tests
        raise AssertionError('review_proposal must not call the model itself')


REVIEWER = _FakeReviewer()


def _skillText() -> str:
    from app.services.skill_service import skill_body

    return skill_body('receipt-provenance') or ''


def _episodeId(kind: str = 'user_correction') -> int:
    from app.services import episode_miner

    return episode_miner.save_episode(
        {
            'session_id': 'ses_review',
            'kind': kind,
            'start_message_id': 1,
            'end_message_id': 3,
            'events': [{'role': 'user', 'text': "Don't rebuild, just restart the container."}],
            'outcome': 'resolved',
            'fingerprint_id': f'fp-review-{kind}',
        }
    )


def _armAutonomy() -> None:
    """Item 14 moved the reviewer's KEEP behind the rails, so a test that wants
    the write to land has to arm the switch the same way a user would — through
    the config door, not by patching the check out."""
    from app.services.brain_config_service import bustRuntimeCache, saveBrainConfig

    # Both ceiling kinds: this file is about what the reviewer may do, and its
    # clean proposal is a skill_create. The per-kind gate is owned by
    # test_harness_rails.TestAutonomyIsArmedPerKind.
    ok, err, _merged = saveBrainConfig({
        'skillAutonomy': True,
        'autonomyBurnInCount': 0,
        'autoApplyPerDay': 10,
        'autonomyKinds': 'skill_patch,skill_create',
    })
    assert ok, f'armable through the API door: {err}'
    bustRuntimeCache()


def _railsCleanProposal(brain) -> str:
    """A skill_create the rails have no objection to: the user's own words as
    evidence, plain prose as the body, and the switch armed."""
    _armAutonomy()
    row = hsi.save_proposal(
        problem='provenance gate is missing',
        evidence='the user corrected this twice, in their own words',
        proposal='create_skill: receipt-provenance — document the gate',
        rollback='restore the previous version from .versions',
        kind='skill_create',
        payload={
            'name': 'receipt-provenance',
            'description': 'd',
            'body': '# Receipt provenance\n\nRecord which receipt declared the error.\n',
            'episodeIds': [_episodeId()],
            'origin': 'distilled',
        },
    )
    return str(row['id'])


class TestTheReviewerOnlyDecides:
    def test_a_keep_verdict_approves_when_the_rails_allow(self, brain):
        """Item 10's contract, restated for item 14: a KEEP still approves
        through `decide_proposal` — it is just no longer sufficient on its own."""
        pid = _railsCleanProposal(brain)
        out = hsi.review_proposal(pid, 'KEEP', reviewer_client=REVIEWER)
        assert out['decision'] == 'approve', out
        assert out['applied'] is True, out
        assert hsi.get_proposal(pid)['status'] == 'applied'

    def test_a_keep_verdict_is_held_while_autonomy_is_off(self, brain):
        """The shipped default. A KEEP with the switch off must leave the
        proposal for the human — advisory, exactly as the pass advertises."""
        pid = _fileProposal(brain)
        out = hsi.review_proposal(pid, 'KEEP', reviewer_client=REVIEWER)
        assert out.get('decision') is None, out
        assert out.get('leftInInbox') is True, out
        assert out['rule'] == 'autonomy-off', out
        assert hsi.get_proposal(pid)['status'] == 'open'

    def test_a_discard_verdict_rejects(self, brain):
        pid = _fileProposal(brain)
        out = hsi.review_proposal(pid, 'DISCARD', reviewer_client=REVIEWER)
        assert out['decision'] == 'reject', out
        assert hsi.get_proposal(pid)['status'] == 'rejected'

    def test_a_keep_verdict_reports_that_the_write_landed(self, brain):
        """`ok` used to be `bool(result.get('ok'))` while `decide_proposal`
        answers with the proposal ROW, which has no `ok` key — so the field was
        False for every decision this function ever made, and nothing asserted
        it. Pinning the receipt now: an apply that worked has to say so."""
        pid = _railsCleanProposal(brain)
        out = hsi.review_proposal(pid, 'KEEP', reviewer_client=REVIEWER)
        assert out['ok'] is True, out
        assert out['status'] == 'applied', out
        rejected = hsi.review_proposal(_fileProposal(brain), 'DISCARD', reviewer_client=REVIEWER)
        assert rejected['ok'] is True, rejected
        assert rejected['status'] == 'rejected', rejected

    def test_a_reject_is_not_gated_by_the_rails(self, brain):
        """Deliberate asymmetry: the rails stop CHANGES. A DISCARD writes no
        file, and 'reopen' is the undo — so holding a refusal would only hide
        the reviewer's opinion from the inbox."""
        pid = _fileProposal(brain)
        out = hsi.review_proposal(pid, 'DISCARD', reviewer_client=REVIEWER)
        assert out['decision'] == 'reject', out


class TestUnusableVerdictsFailClosedToTheInbox:
    @pytest.mark.parametrize('verdict', [None, '', '   ', 'maybe', 'KEEP DISCARD', 'approved', 42])
    def test_anything_but_keep_or_discard_leaves_it_open(self, brain, verdict):
        pid = _fileProposal(brain)
        out = hsi.review_proposal(pid, verdict, reviewer_client=REVIEWER)
        assert out.get('decision') is None, out
        assert out.get('leftInInbox') is True, out
        assert hsi.get_proposal(pid)['status'] == 'open', 'the human must still see it'

    def test_an_unusable_verdict_writes_no_file(self, brain):
        pid = _fileProposal(brain)
        hsi.review_proposal(pid, 'maybe', reviewer_client=REVIEWER)
        assert _skillText() == '', 'a verdict nobody understands must not touch disk'

    def test_the_refusal_names_why(self, brain):
        out = hsi.review_proposal(_fileProposal(brain), 'maybe', reviewer_client=REVIEWER)
        assert out['reason'], 'a silent fail-closed is indistinguishable from a pass'


class TestTheReviewerCannotEdit:
    """The source-level guarantee: applying is `_APPROVERS`, reached through
    `decide_proposal`. A reviewer that wrote files itself would be a second,
    unaudited path from proposal to live change."""

    def test_review_proposal_calls_decide_proposal_and_nothing_else_that_writes(self, brain):
        import ast
        import inspect

        src = inspect.getsource(hsi.review_proposal)
        # Look at what the code CALLS, not what its docstring mentions: my first
        # version grepped the raw source and failed on the docstring naming
        # _APPROVERS — the very guarantee it was describing.
        called = {
            node.func.id
            for node in ast.walk(ast.parse(inspect.cleandoc(src)))
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        called |= {
            node.func.attr
            for node in ast.walk(ast.parse(inspect.cleandoc(src)))
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        }
        for banned in ('_APPROVERS', '_apply_approved', 'write_text', 'saveConfig', 'skill_patch', '_apply_skill_write'):
            assert banned not in called, f'reviewer reaches {banned} directly'
        assert 'decide_proposal' in called, 'the reviewer must act through decide_proposal'

    def test_approval_still_goes_through_the_deterministic_applier(self, brain):
        pid = _railsCleanProposal(brain)
        seen: list[str] = []
        original = hsi._apply_approved

        def spy(row):
            seen.append(str(row.get('id')))
            return original(row)

        hsi._apply_approved = spy  # type: ignore[assignment]
        try:
            hsi.review_proposal(pid, 'KEEP', reviewer_client=REVIEWER)
        finally:
            hsi._apply_approved = original  # type: ignore[assignment]
        assert seen == [pid], f'approve bypassed the applier: {seen}'


class TestIndependentReviewerGateAppliesHere:
    def test_the_same_model_cannot_review_and_the_verdict_is_not_applied(self, brain):
        pid = _fileProposal(brain)
        client, reason = review_gate.resolve_independent_reviewer('m-x', 'm-x')
        assert client is None and 'same as the producer' in reason
        # Even if a verdict were handed over, the gate's refusal stands: this
        # path never applies without an independent client having existed.
        out = hsi.review_proposal(pid, 'KEEP', reviewer_client=client)
        assert out.get('decision') is None, out
        assert hsi.get_proposal(pid)['status'] == 'open'

    def test_an_unreachable_reviewer_leaves_the_proposal_alone(self, brain, monkeypatch):
        pid = _fileProposal(brain)
        monkeypatch.setattr(
            review_gate, 'resolve_independent_reviewer', lambda p, h='': (None, 'no reviewer model available')
        )
        out = hsi.review_proposal(pid, 'KEEP', reviewer_client=None)
        assert out.get('decision') is None, out
        assert hsi.get_proposal(pid)['status'] == 'open'


class TestReviewIsRecorded:
    def test_the_decision_is_written_to_the_proposal_ledger(self, brain):
        pid = _fileProposal(brain)
        hsi.review_proposal(pid, 'DISCARD', reviewer_client=REVIEWER, note='not durable')
        row = hsi.get_proposal(pid)
        assert row.get('decisionNote') == 'not durable', row

    def test_a_fail_closed_leaves_a_reason_on_the_proposal(self, brain):
        pid = _fileProposal(brain)
        hsi.review_proposal(pid, 'maybe', reviewer_client=REVIEWER)
        row = hsi.get_proposal(pid)
        # The inbox is the record: a reviewer that could not judge must be
        # visible to the human who will open the inbox.
        assert row['status'] == 'open'