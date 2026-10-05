"""A reviewer pass over filed proposals (check 3 / item 9 wiring).

`review_proposal` had no caller: the gate and the reviewer's single act existed,
so nothing ever ran a reviewer. This adds the pass — and, deliberately, it is
ADVISORY only while autonomy is off. It writes one line onto the proposal
record and never calls `decide_proposal`.

Every verdict path uses a deterministic fake client: this suite must not depend
on a live provider, and the live reviewer call is a separate pending item.
"""

from __future__ import annotations

import pytest
from app.services import harness_self_improve as hsi


@pytest.fixture
def brain(isolatedData):
    from app.services import memory_store

    memory_store.init()
    return isolatedData


def _fileProposal(brain, kind: str = 'skill_create', name: str = 'reviewed-skill') -> str:
    row = hsi.save_proposal(
        problem='provenance gate is missing',
        evidence='41 tool_error episodes, all unbacked receipts',
        proposal=f'{kind}: {name} — document the gate',
        rollback='reject the proposal; nothing is written until approval',
        kind=kind,
        payload={'name': name, 'description': 'd', 'body': '# b\n\nbody\n'},
    )
    return str(row['id'])


class _FakeClient:
    """Deterministic reviewer client. `reply` is what the model 'says'."""

    def __init__(self, reply: str = 'KEEP — the gap is real and durable', fail: str = ''):
        self.reply = reply
        self.fail = fail
        self.calls: list = []

    async def __call__(self, prompt):
        self.calls.append(prompt)
        if self.fail == 'raise':
            raise RuntimeError('reviewer socket closed')
        if self.fail == 'empty':
            return ''
        if self.fail == 'timeout':
            import asyncio

            raise asyncio.TimeoutError()
        return self.reply


def _gate(monkeypatch, client, reason: str = ''):
    """Force review_gate to hand back our fake (or refuse, with a reason)."""
    monkeypatch.setattr(
        'app.services.harness_self_improve.resolve_independent_reviewer',
        lambda producer, hint='': (client, reason),
    )


class TestAdvisoryVerdictsOnly:
    """Autonomy is OFF: the pass records what the reviewer said and changes
    nothing. The proposal must still be open for the human."""

    def test_a_keep_verdict_is_recorded_and_the_proposal_stays_open(self, brain, monkeypatch):
        pid = _fileProposal(brain)
        _gate(monkeypatch, _FakeClient('KEEP — real and durable'))
        out = hsi.run_reviewer_pass()
        assert out.get('reviewed', 0) >= 1, out
        row = hsi.get_proposal(pid)
        assert row['status'] == 'open', 'advisory must not decide'
        assert row['review']['verdict'] == 'KEEP', row
        assert 'durable' in row['review']['reason'], row

    def test_a_discard_verdict_is_recorded_and_still_stays_open(self, brain, monkeypatch):
        pid = _fileProposal(brain)
        _gate(monkeypatch, _FakeClient('DISCARD — one-off, not durable'))
        hsi.run_reviewer_pass()
        row = hsi.get_proposal(pid)
        assert row['status'] == 'open'
        assert row['review']['verdict'] == 'DISCARD'
        assert 'one-off' in row['review']['reason']

    def test_the_reviewer_never_calls_decide_proposal_in_this_mode(self, brain, monkeypatch):
        _fileProposal(brain)
        _gate(monkeypatch, _FakeClient('KEEP'))
        called: list[str] = []
        monkeypatch.setattr(
            hsi, 'decide_proposal', lambda pid, decision, note='', **kw: called.append(pid) or {'ok': True}
        )
        hsi.run_reviewer_pass()
        assert called == [], f'advisory pass decided something: {called}'

    def test_the_prompt_carries_the_proposal_and_not_the_proposer_s_reasoning(self, brain, monkeypatch):
        _fileProposal(brain)
        client = _FakeClient('KEEP')
        _gate(monkeypatch, client)
        hsi.run_reviewer_pass()
        assert client.calls, 'the reviewer was never called'
        text = ' '.join(
            str(m.get('content')) for m in client.calls[0] if isinstance(m, dict)
        )
        assert 'provenance gate is missing' in text, text[:300]
        assert '41 tool_error episodes' in text, 'evidence must travel with the proposal'


class TestEveryUnusableReviewerFailsClosed:
    """Each path the user named, with a deterministic client."""

    def _run(self, brain, monkeypatch, client, reason=''):
        pid = _fileProposal(brain)
        _gate(monkeypatch, client, reason)
        hsi.run_reviewer_pass()
        return hsi.get_proposal(pid)

    def test_the_same_model_as_the_producer_is_unavailable(self, brain, monkeypatch):
        row = self._run(brain, monkeypatch, None, 'reviewer model is the same as the producer')
        assert row['status'] == 'open'
        assert row['review']['verdict'] == 'unavailable'
        assert 'same as the producer' in row['review']['reason']

    def test_an_unresolved_model_is_unavailable(self, brain, monkeypatch):
        row = self._run(brain, monkeypatch, None, 'no reviewer model available')
        assert row['review']['verdict'] == 'unavailable'
        assert 'no reviewer' in row['review']['reason']

    def test_a_timeout_is_unavailable(self, brain, monkeypatch):
        row = self._run(brain, monkeypatch, _FakeClient(fail='timeout'))
        assert row['review']['verdict'] == 'unavailable'
        assert 'time' in row['review']['reason'].lower()

    def test_an_error_is_unavailable_and_names_its_type(self, brain, monkeypatch):
        row = self._run(brain, monkeypatch, _FakeClient(fail='raise'))
        assert row['review']['verdict'] == 'unavailable'
        assert 'RuntimeError' in row['review']['reason']

    def test_an_empty_answer_is_unavailable(self, brain, monkeypatch):
        row = self._run(brain, monkeypatch, _FakeClient(fail='empty'))
        assert row['review']['verdict'] == 'unavailable'

    @pytest.mark.parametrize('reply', ['maybe', 'KEEP DISCARD', 'approved', '', 'I think we should keep it'])
    def test_malformed_output_is_unavailable(self, brain, monkeypatch, reply):
        row = self._run(brain, monkeypatch, _FakeClient(reply))
        assert row['review']['verdict'] == 'unavailable', row
        assert row['status'] == 'open'

    def test_every_failure_still_leaves_the_human_the_proposal(self, brain, monkeypatch):
        # Distinct problems: save_proposal refuses a near-duplicate open row, so
        # my first version (same problem text) raised ValueError instead of
        # exercising the three reviewer failures.
        for i, (client, reason) in enumerate(
            (
                (None, 'same model'),
                (_FakeClient(fail='raise'), ''),
                (_FakeClient('maybe'), ''),
            )
        ):
            row = hsi.save_proposal(
                problem=f'provenance gap number {i}',
                evidence='41 tool_error episodes',
                proposal='document the gate',
                rollback='reject it',
                kind='skill_create',
                payload={'name': f'kept-{i}', 'description': 'd', 'body': '# b\n'},
            )
            pid = str(row['id'])
            _gate(monkeypatch, client, reason)
            hsi.run_reviewer_pass()
            assert hsi.get_proposal(pid)['status'] == 'open', pid


class TestPassMechanics:
    def test_an_already_reviewed_proposal_is_not_reviewed_again(self, brain, monkeypatch):
        _fileProposal(brain)
        client = _FakeClient('KEEP')
        _gate(monkeypatch, client)
        hsi.run_reviewer_pass()
        first = len(client.calls)
        hsi.run_reviewer_pass()
        assert len(client.calls) == first, 'a reviewed proposal must not burn another call'

    def test_non_skill_proposals_are_not_sent_to_the_reviewer(self, brain, monkeypatch):
        hsi.save_proposal(
            problem='an observation',
            evidence='e',
            proposal='p',
            rollback='r',
            kind='observation',
        )
        client = _FakeClient('KEEP')
        _gate(monkeypatch, client)
        hsi.run_reviewer_pass()
        assert not client.calls, 'observations are human-only and must not be auto-reviewed'

    def test_a_rejected_proposal_is_not_revised(self, brain, monkeypatch):
        pid = _fileProposal(brain)
        hsi.decide_proposal(pid, 'reject', 'not needed')
        client = _FakeClient('KEEP')
        _gate(monkeypatch, client)
        hsi.run_reviewer_pass()
        assert not client.calls

    def test_the_review_line_is_shaped_for_the_inbox(self, brain, monkeypatch):
        pid = _fileProposal(brain)
        _gate(monkeypatch, _FakeClient('DISCARD — one-off'))
        hsi.run_reviewer_pass()
        row = hsi.get_proposal(pid)
        summary = hsi.review_summary(row)
        assert summary.startswith('Reviewer: discard'), summary
        assert 'one-off' in summary

    def test_an_unavailable_reviewer_says_so_on_one_line(self, brain, monkeypatch):
        pid = _fileProposal(brain)
        _gate(monkeypatch, None, 'no reviewer model available')
        hsi.run_reviewer_pass()
        assert hsi.review_summary(hsi.get_proposal(pid)).startswith('Reviewer unavailable')