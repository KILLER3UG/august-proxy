"""Judge success must be countable (backlog item 3b).

Measured on a real install: 13 `distiller_judge_failed` rows and no success event
type at all. "0 successes" was therefore unfalsifiable — a loop that cannot log a
win cannot show it is working. The recorder from item 7 already names the cause
of every failure; this adds the other half, at the same place, one row per batch
(not per verdict), so the pass does not gain a write per model call.
"""

from __future__ import annotations

import json

import pytest
from app.services import skill_distiller as sd


@pytest.fixture
def brain(isolatedData):
    from app.services import memory_store

    memory_store.init()
    return isolatedData


@pytest.fixture
def flagged():
    """One tier-2 episode awaiting a verdict — the pass reads nothing else.

    My first version asserted a success row with no episode flagged and no
    skillLearning mode set, so the pass returned at its `if not unjudged` gate
    and the test failed for a reason that had nothing to do with the recorder.
    """
    from app.services.brain_config_service import saveBrainConfig
    from app.services.memory_conn import conn

    saveBrainConfig({'skillLearning': 'full'})
    conn().execute(
        "INSERT INTO episodes (session_id, kind, start_message_id, end_message_id, "
        "events, outcome, fingerprint_id, tier) VALUES ('s1', 'failure_recovery', 1, 2, "
        "'[{\"type\": \"tool_error\", \"excerpt\": \"x\"}]', 'resolved', 'fp', 2)"
    )
    conn().commit()
    return 's1'


def _judge_rows(event_type=None):
    from app.services.memory_conn import conn

    if event_type:
        q = 'SELECT detail FROM lifecycle WHERE event_type = ? ORDER BY id'
        return [dict(r) for r in conn().execute(q, (event_type,)).fetchall()]
    return [
        dict(r)
        for r in conn().execute(
            'SELECT event_type, detail, created_at FROM lifecycle ORDER BY id'
        ).fetchall()
    ]


class TestSuccessIsRecorded:
    def _batch(self):
        return [{'id': 1, 'kind': 'failure_recovery', 'outcome': 'resolved', 'events': []}]

    def test_a_judged_batch_records_a_success(self, brain, flagged, monkeypatch):
        monkeypatch.setattr(sd, '_run_batch', lambda batch: {'verdicts': []})
        sd.run_distiller_pass(dryRun=False)
        rows = _judge_rows('distiller_judge_succeeded')
        assert rows, 'a pass that judged something must record that it did'
        detail = json.loads(rows[-1]['detail'])
        assert detail['batchSize'] == 1
        assert 'model' in detail, 'the reviewer that answered should be named'

    def test_one_row_per_batch_not_per_verdict(self, brain, flagged, monkeypatch):
        monkeypatch.setattr(
            sd,
            '_run_batch',
            lambda batch: {
                'verdicts': [
                    {'episode': 1, 'action': 'none', 'reason': 'x'},
                    {'episode': 2, 'action': 'none', 'reason': 'y'},
                    {'episode': 3, 'action': 'none', 'reason': 'z'},
                ]
            },
        )
        sd.run_distiller_pass(dryRun=False)
        assert len(_judge_rows('distiller_judge_succeeded')) == 1, (
            'a batch is one judge call; one row per verdict would triple the writes'
        )

    def test_a_dry_run_records_nothing(self, brain, flagged, monkeypatch):
        monkeypatch.setattr(sd, '_run_batch', lambda batch: {'verdicts': []})
        sd.run_distiller_pass(dryRun=True)
        assert _judge_rows('distiller_judge_succeeded') == []

    def test_a_failure_records_no_success(self, brain, flagged, monkeypatch):
        monkeypatch.setattr(sd, '_run_batch', lambda batch: None)
        monkeypatch.setattr(sd, '_cooldown_batch', lambda n: None)
        sd.run_distiller_pass(dryRun=False)
        assert _judge_rows('distiller_judge_succeeded') == []


class TestJudgeHealthIsReportable:
    def test_the_report_states_the_last_success_and_the_last_failure(self, brain, flagged, monkeypatch):
        from app.services.episode_miner import learning_report

        monkeypatch.setattr(sd, '_run_batch', lambda batch: {'verdicts': []})
        sd.run_distiller_pass(dryRun=False)

        rep = learning_report()
        judge = rep['judge']
        assert judge['lastSuccess'], judge
        assert judge['successes'] == 1, judge
        assert judge['failures'] == 0, judge
        assert 'model' in judge['lastSuccessDetail'], judge

    def test_the_last_failure_carries_its_named_cause(self, brain, flagged, monkeypatch):
        from app.services.episode_miner import learning_report

        monkeypatch.setattr(sd, '_run_batch', lambda batch: None)
        sd.run_distiller_pass(dryRun=False)
        judge = learning_report()['judge']
        assert judge['failures'] == 1, judge
        # The whole point of item 7's recorder: the cause is readable, not ''.
        assert judge['lastFailure'], judge
        assert judge['lastFailureDetail'].get('reason'), judge

    def test_the_report_is_falsy_but_present_before_anything_runs(self, brain):
        from app.services.episode_miner import learning_report

        judge = learning_report()['judge']
        assert judge['successes'] == 0 and judge['failures'] == 0
        assert not judge['lastSuccess'] and not judge['lastFailure']

    def test_the_key_exists_even_with_no_rows_at_all(self, brain):
        """Absent means 'never ran', never a missing key that crashes a panel."""
        from app.services.episode_miner import learning_report

        assert 'judge' in learning_report()