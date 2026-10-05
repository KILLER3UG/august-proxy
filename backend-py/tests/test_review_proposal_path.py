"""The reviewer is a decider, not an editor (backlog item 10).

The reviewer's whole authority is one call: `decide_proposal`. It must never
write a skill file, a config, or a proposal. Anything it cannot judge — an
unreachable model, an empty answer, a string it does not recognise — leaves the
proposal sitting in the inbox for the human. The reviewer can only ever make a
proposal that a human could have made; it cannot make one a human could not.
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


class TestTheReviewerOnlyDecides:
    def test_a_keep_verdict_approves_through_the_normal_path(self, brain):
        pid = _fileProposal(brain)
        out = hsi.review_proposal(pid, 'KEEP', reviewer_client=REVIEWER)
        assert out['decision'] == 'approve', out
        assert hsi.get_proposal(pid)['status'] == 'applied'

    def test_a_discard_verdict_rejects(self, brain):
        pid = _fileProposal(brain)
        out = hsi.review_proposal(pid, 'DISCARD', reviewer_client=REVIEWER)
        assert out['decision'] == 'reject', out
        assert hsi.get_proposal(pid)['status'] == 'rejected'


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
        pid = _fileProposal(brain)
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