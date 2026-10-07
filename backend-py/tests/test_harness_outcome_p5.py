"""P5 outcome-ledger tests: record, schedule, measure, verdict."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
from app.services import harness_outcome as ho


def _ts(dt: datetime) -> str:
    return dt.strftime(ho._TS)


def _seed_episodes(rows: list[tuple[str, str]]) -> None:
    """rows: (outcome, created_at) — episodes carry the outcome field + clock."""
    from app.services.memory_conn import conn

    c = conn()
    c.execute(
        'CREATE TABLE IF NOT EXISTS episodes ('
        '  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, kind TEXT,'
        '  outcome TEXT, fingerprint_id TEXT, created_at TEXT)'
    )
    for outcome, created_at in rows:
        c.execute(
            'INSERT INTO episodes (outcome, created_at) VALUES (?, ?)', (outcome, created_at)
        )
    c.commit()


class TestEpisodeStats:
    def test_window_bounds_and_weighting(self) -> None:
        now = datetime(2026, 9, 10, 12, 0, 0, tzinfo=timezone.utc)
        inside = _ts(now - timedelta(days=3))
        outside = _ts(now - timedelta(days=30))
        _seed_episodes(
            [
                ('resolved', inside),
                ('rescued', inside),   # counts 0.5
                ('unresolved', inside),
                ('resolved', outside),  # must be excluded
            ]
        )
        stats = ho.episode_stats(now - timedelta(days=10), now)
        assert stats['episodes'] == 3
        # (1 + 0.5) / 3
        assert abs(stats['resolvedRate'] - 0.5) < 1e-6

    def test_fingerprint_recurrence_counted(self) -> None:
        from app.services.memory_conn import conn

        now = datetime(2026, 9, 10, 12, 0, 0, tzinfo=timezone.utc)
        _seed_episodes([('unresolved', _ts(now - timedelta(days=1)))])
        conn().execute('UPDATE episodes SET fingerprint_id = ? WHERE fingerprint_id IS NULL', ('ngspice-missing',))
        conn().commit()
        stats = ho.episode_stats(now - timedelta(days=5), now, 'ngspice-missing')
        assert stats['fingerprintRecurrence'] == 1


class TestRecord:
    def test_record_books_a_row_idempotently(self) -> None:
        ho.record('proposal', 'proposal:p1', 'skill_create', 'fix-lockfile', 'fewer CI failures', 'lockfile-regen')
        ho.record('proposal', 'proposal:p1', 'skill_create', 'fix-lockfile', 'fewer CI failures', 'lockfile-regen')
        from app.services.memory_conn import conn

        rows = conn().execute('SELECT COUNT(*) AS n FROM harness_outcome').fetchone()
        assert rows['n'] == 1
        row = conn().execute('SELECT * FROM harness_outcome').fetchone()
        assert row['fingerprint'] == 'lockfile-regen'
        assert json.loads(row['before_json'])['window'] is not None

    def test_record_never_raises_into_the_caller(self) -> None:
        # A missing table would raise; record() must swallow it. Drop the
        # table out from under the service and record anyway.
        ho.record('proposal', 'proposal:ok', 'observation', '', '')
        from app.services.memory_conn import conn

        conn().execute('DROP TABLE harness_outcome')
        conn().commit()
        ho.record('proposal', 'proposal:boom', 'observation', '', '')  # must not raise
        assert conn().execute('SELECT 1').fetchone() is not None


class TestClassify:
    """The classifier is the ONLY thing that decides whether a change stays in
    place or is put back, so its thresholds are the safety property. Two rules
    were wrong and are corrected here rather than tuned:

      * untargeted read a resolved-rate move of 0.05 on as few as 3 episodes per
        side — on a rate estimated from 3 samples, ±0.05 is inside the noise, so
        the job could call a change regressed and revert it on nothing;
      * targeted compared the recurrence COUNT against zero, ignoring the
        denominator entirely, so a busier window looked worse even if the
        failure became proportionally rarer. Its own fixture proved the bug:
        `episodes: 1` with `fingerprintRecurrence: 3` is not a possible
        measurement — recurrence counts episodes carrying the fingerprint, so it
        can never exceed the total. A rule that accepts that input is not
        reading a rate.
    """

    def test_small_sample_says_insufficient(self) -> None:
        assert ho._classify({'episodes': 1}, {'episodes': 1}) == 'insufficient'

    def test_the_noisy_three_episode_case_is_insufficient(self) -> None:
        """The exact case the old floor let through: a full 1.0 → 0.8 swing on 3
        samples is a coin flip, not a regression, and must never revert a
        change."""
        b = {'episodes': 3, 'resolvedRate': 1.0}
        a = {'episodes': 3, 'resolvedRate': 0.0}
        assert ho._classify(b, a) == 'insufficient'
        # One side short is enough to refuse the verdict.
        assert ho._classify({'episodes': 7, 'resolvedRate': 1.0}, {'episodes': 8, 'resolvedRate': 0.2}) == (
            'insufficient'
        )
        # Eight on both sides is the floor, and it is measured, not assumed.
        assert ho._classify({'episodes': 8, 'resolvedRate': 1.0}, {'episodes': 8, 'resolvedRate': 0.2}) == (
            'regressed'
        )

    def test_a_small_rate_move_is_flat(self) -> None:
        """0.05 and 0.10 used to classify as improved/regressed. On this scale
        they are noise, and the cost of a false 'regressed' is an automated
        revert."""
        assert ho._classify({'episodes': 20, 'resolvedRate': 0.5}, {'episodes': 20, 'resolvedRate': 0.55}) == 'flat'
        assert ho._classify({'episodes': 20, 'resolvedRate': 0.5}, {'episodes': 20, 'resolvedRate': 0.4}) == 'flat'
        assert ho._classify({'episodes': 20, 'resolvedRate': 0.5}, {'episodes': 20, 'resolvedRate': 0.34}) == 'regressed'
        assert ho._classify({'episodes': 20, 'resolvedRate': 0.5}, {'episodes': 20, 'resolvedRate': 0.66}) == 'improved'

    def test_rate_moves_classify(self) -> None:
        assert ho._classify({'episodes': 10, 'resolvedRate': 0.4}, {'episodes': 10, 'resolvedRate': 0.6}) == 'improved'
        assert ho._classify({'episodes': 10, 'resolvedRate': 0.6}, {'episodes': 10, 'resolvedRate': 0.4}) == 'regressed'
        assert ho._classify({'episodes': 10, 'resolvedRate': 0.6}, {'episodes': 10, 'resolvedRate': 0.62}) == 'flat'

    def test_targeted_reads_the_recurrence_RATE(self) -> None:
        """Same absolute recurrence, different denominators, different verdict —
        which is what "compare the rates" means."""
        # 6/20 → 6/24 is 0.30 → 0.25: the failure got proportionally RARER, so
        # the old count rule's "any recurrence is a regression" was wrong here.
        assert ho._classify(
            {'episodes': 20, 'fingerprintRecurrence': 6},
            {'episodes': 24, 'fingerprintRecurrence': 6},
            targeted=True,
        ) == 'flat'
        # 2/20 → 8/20 is 0.10 → 0.40: a real worsening.
        assert ho._classify(
            {'episodes': 20, 'fingerprintRecurrence': 2},
            {'episodes': 20, 'fingerprintRecurrence': 8},
            targeted=True,
        ) == 'regressed'
        # 8/20 → 1/20 is 0.40 → 0.05: a real improvement.
        assert ho._classify(
            {'episodes': 20, 'fingerprintRecurrence': 8},
            {'episodes': 20, 'fingerprintRecurrence': 1},
            targeted=True,
        ) == 'improved'

    def test_targeted_still_needs_a_sample_on_both_sides(self) -> None:
        """The retracted rule claimed a verdict on any sample. It no longer
        does: a rate over 2 episodes is not a rate."""
        b = {'episodes': 2, 'fingerprintRecurrence': 2}
        a = {'episodes': 2, 'fingerprintRecurrence': 0}
        assert ho._classify(b, a, targeted=True) == 'insufficient'
        assert ho._classify(b, a) == 'insufficient'


class TestMeasureAndJob:
    def test_measure_classifies_only_elapsed_windows(self) -> None:
        now = datetime.now(timezone.utc)
        from app.services.memory_conn import conn

        ho.record('proposal', 'proposal:old', 'skill_create', 's', 'x')
        conn().execute(
            'UPDATE harness_outcome SET applied_at = ? WHERE key = ?',
            (_ts(now - timedelta(days=40)), 'proposal:old'),
        )
        ho.record('proposal', 'proposal:young', 'skill_create', 's', 'x')
        conn().commit()
        out = ho.measure_pending()
        assert out['measured'] == 1
        row = conn().execute(
            'SELECT measured_at, verdict FROM harness_outcome WHERE key = ?', ('proposal:old',)
        ).fetchone()
        assert row['measured_at'] is not None and row['verdict']
        young = conn().execute(
            'SELECT measured_at FROM harness_outcome WHERE key = ?', ('proposal:young',)
        ).fetchone()
        assert young['measured_at'] is None

    def test_outcome_job_registered(self) -> None:
        from app.services.learning_scheduler import JOBS

        assert 'outcome' in JOBS and 'refine' in JOBS


class TestApprovalBooksOutcome:
    def test_approved_proposal_records_a_row(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path / 'data'))
        from app.services import harness_self_improve as hsi
        from app.services.memory_conn import conn

        conn().execute('SELECT 1')  # init the brain under the isolated dataDir
        # Stub the applier: what's under test is that a SUCCESSFUL apply of a
        # side-effecting kind books exactly one outcome row (a failed apply
        # or a never-apply kind must book nothing).
        monkeypatch.setattr(hsi, '_apply_approved', lambda row: {'ok': True})
        row = hsi.save_proposal(
            problem='tweak loops', evidence='e', proposal='set 20 rounds',
            rollback='reset', kind='brain_config', payload={'patch': {}},
            expected_metric='shorter loops',
        )
        out = hsi.decide_proposal(row['id'], 'approve')
        assert out['status'] == 'applied'
        booked = conn().execute(
            'SELECT COUNT(*) AS n FROM harness_outcome WHERE source=? AND key=?',
            ('proposal', f'proposal:{row["id"]}'),
        ).fetchone()
        assert booked['n'] == 1
        # A rejected proposal books nothing.
        row2 = hsi.save_proposal(
            problem='second', evidence='e', proposal='p', rollback='r', kind='brain_config',
        )
        hsi.decide_proposal(row2['id'], 'reject')
        n2 = conn().execute(
            "SELECT COUNT(*) AS n FROM harness_outcome WHERE source='proposal'"
        ).fetchone()
        assert n2['n'] == 1


class TestRefineKeepBooksOutcomes:
    @pytest.mark.asyncio
    async def test_kept_batch_books_one_row_per_edit(self, monkeypatch) -> None:
        from app.services import refine_store as rs

        async def _producer(messages):
            return json.dumps({'edits': [{
                'op': 'create', 'kind': 'prompt_note', 'scope': 'global',
                'content': {'text': 'outcome test note'},
                'rationale': 'r', 'expectedOutcome': 'fewer failures'}]})

        async def _reviewer(messages):
            return 'KEEP'

        rs.set_refine_config({'autoRefine': True, 'producerModel': 'p', 'reviewModel': 'r'})
        monkeypatch.setattr(rs, '_resolve_producer', lambda: _producer)
        import app.services.workbench.providers as prov

        monkeypatch.setattr(prov, 'make_review_llm_client', lambda mp, hint: _reviewer)
        out = await rs.auto_refine(evidence='evidence')
        assert out['status'] == 'kept'
        from app.services.memory_conn import conn

        n = conn().execute(
            "SELECT COUNT(*) AS n FROM harness_outcome WHERE source='refine'"
        ).fetchone()
        assert n['n'] >= 1
