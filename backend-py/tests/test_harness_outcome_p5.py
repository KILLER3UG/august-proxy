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
    def test_small_sample_says_insufficient(self) -> None:
        assert ho._classify({'episodes': 1}, {'episodes': 1}) == 'insufficient'

    def test_rate_moves_classify(self) -> None:
        assert ho._classify({'episodes': 10, 'resolvedRate': 0.4}, {'episodes': 10, 'resolvedRate': 0.6}) == 'improved'
        assert ho._classify({'episodes': 10, 'resolvedRate': 0.6}, {'episodes': 10, 'resolvedRate': 0.4}) == 'regressed'
        assert ho._classify({'episodes': 10, 'resolvedRate': 0.6}, {'episodes': 10, 'resolvedRate': 0.62}) == 'flat'

    def test_targeted_recurrence_decides_on_any_sample(self) -> None:
        b = {'episodes': 1, 'fingerprintRecurrence': 3}
        a0 = {'episodes': 1, 'fingerprintRecurrence': 0}
        a3 = {'episodes': 1, 'fingerprintRecurrence': 2}
        assert ho._classify(b, a0, targeted=True) == 'improved'
        assert ho._classify(b, a3, targeted=True) == 'regressed'


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
