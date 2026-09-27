"""P1#9 — a measured regression files its own revert proposal.

The ledger already classified a change as 'regressed' and then left the undo
to be rediscovered by hand. These pin the follow-through:

  * regressed  -> exactly one 'revert' proposal, carrying the regressing
                  change's OWN rollback text and a payload link to the
                  outcome row that measured it;
  * flat / improved / insufficient -> nothing filed;
  * 'revert' is human-only — the applier must never undo a learning write
    on its own;
  * a source row that is no longer on file still files, with honest text
    instead of an invented undo.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from app.services import harness_outcome as ho
from app.services import harness_self_improve as hsi


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
        c.execute('INSERT INTO episodes (outcome, created_at) VALUES (?, ?)', (outcome, created_at))
    c.commit()


def _proposals() -> list[dict]:
    return [json.loads(p.read_text(encoding='utf-8')) for p in hsi._proposals_dir().glob('prop_*.json')]


def _book_source_proposal() -> str:
    """A real applied proposal, so the ledger's source lookup has a file to read."""
    row = hsi.save_proposal(
        problem='add a circuit-sim skill',
        evidence='ngspice episodes were failing',
        proposal='create skill circuit-sim',
        rollback='delete the circuit-sim skill directory',
        kind='skill_create',
        payload={'name': 'circuit-sim'},
    )
    return str(row['id'])


def _book_regressing_outcome(pid: str, *, fp: str = '') -> str:
    """Book a change, age it past its window, and make the after-window bad.

    before = the 14 days up to now (all resolved); after = the window that
    followed the write (all unresolved) -> a real 'regressed' verdict.
    """
    now = datetime.now(timezone.utc)
    _seed_episodes(
        [('resolved', _ts(now - timedelta(days=d))) for d in range(1, 11)]
        + [('unresolved', _ts(now - timedelta(days=40 - d))) for d in range(1, 11)]
    )
    key = f'proposal:{pid}'
    ho.record('proposal', key, 'skill_create', 'circuit-sim', 'fewer ngspice failures', fp)
    from app.services.memory_conn import conn

    conn().execute(
        'UPDATE harness_outcome SET applied_at = ? WHERE key = ?',
        (_ts(now - timedelta(days=40)), key),
    )
    conn().commit()
    return key


class TestRevertProposalFiling:
    def test_regressed_files_one_revert_proposal_linked_to_the_outcome(self) -> None:
        pid = _book_source_proposal()
        key = _book_regressing_outcome(pid)
        out = ho.measure_pending()
        assert out['v_regressed'] == 1

        reverts = [p for p in _proposals() if p['kind'] == 'revert']
        assert len(reverts) == 1
        rv = reverts[0]
        assert rv['status'] == 'open'
        # The undo is the ORIGINAL author's rollback text, not something invented.
        assert rv['rollback'] == 'delete the circuit-sim skill directory'
        # Linked back to the row that measured it.
        assert rv['payload']['outcomeKey'] == key
        from app.services.memory_conn import conn

        row_id = conn().execute('SELECT id FROM harness_outcome WHERE key = ?', (key,)).fetchone()['id']
        assert rv['payload']['outcomeId'] == row_id
        # And the evidence carries the numbers behind the verdict.
        assert json.loads(rv['evidence'])['verdict'] == 'regressed'
        assert json.loads(rv['evidence'])['after']['resolvedRate'] == 0.0

    def test_measurement_is_idempotent_no_second_proposal(self) -> None:
        pid = _book_source_proposal()
        _book_regressing_outcome(pid)
        ho.measure_pending()
        # The row is stamped measured_at, so a second pass files nothing new.
        assert ho.measure_pending()['measured'] == 0
        assert len([p for p in _proposals() if p['kind'] == 'revert']) == 1

    @pytest.mark.parametrize(
        'after_outcome,before_outcome',
        [('resolved', 'unresolved'), ('resolved', 'resolved'), ('unresolved', 'unresolved')],
    )
    def test_non_regressed_verdicts_file_nothing(
        self, after_outcome: str, before_outcome: str
    ) -> None:
        now = datetime.now(timezone.utc)
        pid = _book_source_proposal()
        # before-window bad + after-window good -> improved; both same -> flat;
        # one unresolved on both sides is a small sample only if below the
        # bar, so keep 10 episodes each and assert no revert is ever filed.
        _seed_episodes(
            [(before_outcome, _ts(now - timedelta(days=d))) for d in range(1, 11)]
            + [(after_outcome, _ts(now - timedelta(days=40 - d))) for d in range(1, 11)]
        )
        key = f'proposal:{pid}'
        ho.record('proposal', key, 'skill_create', 'circuit-sim', 'fewer failures')
        from app.services.memory_conn import conn

        conn().execute(
            'UPDATE harness_outcome SET applied_at = ? WHERE key = ?',
            (_ts(now - timedelta(days=40)), key),
        )
        conn().commit()
        ho.measure_pending()
        assert [p for p in _proposals() if p['kind'] == 'revert'] == []

    def test_insufficient_sample_files_nothing(self) -> None:
        now = datetime.now(timezone.utc)
        pid = _book_source_proposal()
        # Two episodes per window is below _MIN_EPISODES.
        _seed_episodes(
            [
                ('resolved', _ts(now - timedelta(days=2))),
                ('unresolved', _ts(now - timedelta(days=3))),
                ('unresolved', _ts(now - timedelta(days=38))),
                ('unresolved', _ts(now - timedelta(days=39))),
            ]
        )
        key = f'proposal:{pid}'
        ho.record('proposal', key, 'skill_create', 'circuit-sim', 'fewer failures')
        from app.services.memory_conn import conn

        conn().execute(
            'UPDATE harness_outcome SET applied_at = ? WHERE key = ?',
            (_ts(now - timedelta(days=40)), key),
        )
        conn().commit()
        assert ho.measure_pending()['v_insufficient'] == 1
        assert [p for p in _proposals() if p['kind'] == 'revert'] == []


class TestRevertSourceResolution:
    def test_refine_source_uses_its_id_undo(self) -> None:
        change, rollback = ho._source_change('refine:rf_1:entry-9:3')
        assert 'entry-9' in change
        assert 'entry-9' in rollback

    def test_pruned_source_files_honestly_rather_than_inventing_an_undo(self) -> None:
        pid = _book_source_proposal()
        key = _book_regressing_outcome(pid)
        # The proposal file is what carries the rollback; prune it.
        (hsi._proposals_dir() / f'{pid}.json').unlink()
        ho.measure_pending()
        reverts = [p for p in _proposals() if p['kind'] == 'revert']
        assert len(reverts) == 1
        assert 'no longer on file' in reverts[0]['rollback']
        assert reverts[0]['payload']['outcomeKey'] == key


class TestRevertIsHumanOnly:
    def test_applier_refuses_to_undo_automatically(self) -> None:
        # The authority boundary: approving a revert must not silently revert.
        out = hsi._apply_approved({'kind': 'revert', 'payload': {}})
        assert out['ok'] is False
        assert 'human-only' in out['error']

    def test_revert_is_a_valid_kind(self) -> None:
        assert 'revert' in hsi.VALID_KINDS
        assert 'revert' not in hsi.APPROVABLE_KINDS
