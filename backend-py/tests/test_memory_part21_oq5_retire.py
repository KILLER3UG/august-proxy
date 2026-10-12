"""Part 21 OQ5 (2026-09-04) — propose-only retire + OQ1 retire.

OQ5: a durable memory of ANY kind untouched for its window (``memoryRetireDays``
default 180, ``profileRetireDays`` default 45 for the always-injected profile
lane) AND never quoted (use_count 0) is PROPOSED for retirement — the scan
flips nothing; a human decides via ``apply_retire_decision`` (approve →
status 'retired', reversible; reject → stays). Non-destructive by
construction so it rides the scheduled consolidation pass.

The scan covered only ``kind = 'preference'`` until 2026-10-10, which made a
stale profile row permanent — see ``test_every_kind_is_now_a_candidate``.

OQ1: auto_memories is retired (migration 033) — the privacy summary/export
and the memory UI no longer surface it.
"""

from __future__ import annotations

import pytest


@pytest.fixture()
def store(isolatedData):
    from app.services.memory_store import init as init_store

    init_store()
    from app.services import memory_store

    return memory_store


def _backdate(key: str, days: int) -> None:
    from app.services.memory_conn import conn

    conn().execute(
        "UPDATE facts SET created_at = datetime('now', ?), updated_at = datetime('now', ?) "
        "WHERE fact_key = ?",
        (f'-{days} days', f'-{days} days', key),
    )
    conn().commit()


class TestPreferenceRetire:
    def test_stale_never_quoted_preference_is_proposed(self, store):
        from app.services.memory_store import consolidation

        store.save_fact('user:oldpref', {'fact': 'prefers serif fonts'}, kind='preference', title='Serif')
        _backdate('user:oldpref', 200)
        proposed, notes = consolidation._retire_stale_memories()
        assert proposed == 1
        assert any('Serif' in n for n in notes)
        # The fact is UNTOUCHED — propose-only, non-destructive.
        assert store.get_fact('user:oldpref') is not None
        from app.services.memory_conn import conn

        row = conn().execute(
            "SELECT status FROM facts WHERE fact_key = 'user:oldpref'"
        ).fetchone()
        assert str(row['status']) == 'active'

    def test_recent_preference_not_proposed(self, store):
        from app.services.memory_store import consolidation

        store.save_fact('user:fresh', {'fact': 'prefers dark mode'}, kind='preference', title='Dark')
        _backdate('user:fresh', 30)
        proposed, _ = consolidation._retire_stale_memories()
        assert proposed == 0

    def test_quoted_preference_not_proposed(self, store):
        from app.services.memory_store import consolidation, touch_fact_usage

        store.save_fact('user:used', {'fact': 'prefers metric units'}, kind='preference', title='Metric')
        _backdate('user:used', 400)
        touch_fact_usage(['user:used'])  # use_count > 0 → never-quoted fails
        proposed, _ = consolidation._retire_stale_memories()
        assert proposed == 0

    def test_every_kind_is_now_a_candidate(self, store):
        """Widened 2026-10-10. The scan used to filter ``kind = 'preference'``,
        so a stale ``profile`` / ``lesson`` / ``fact`` row could never even be
        proposed — and ``profile`` is the lane injected into EVERY turn
        regardless of the auto-inject gate. Measured on a live install: four
        stale kinds, 200 days old, never quoted, and exactly ONE was proposed."""
        import json

        from app.services.memory_conn import conn
        from app.services.memory_store import consolidation

        for key, kind in (('p:stale', 'profile'), ('l:stale', 'lesson'), ('f:stale', 'fact')):
            store.save_fact(
                key, {'fact': f'a durable {kind} statement about the user'}, kind=kind, title=f'{kind} title'
            )
            _backdate(key, 200)

        proposed, notes = consolidation._retire_stale_memories()
        assert proposed == 3, notes
        rows = conn().execute(
            "SELECT content FROM proposals WHERE proposal_type = 'retire-fact'"
        ).fetchall()
        kinds = sorted(json.loads(r['content'])['kind'] for r in rows)
        assert kinds == ['fact', 'lesson', 'profile']

    def test_the_always_in_lane_uses_the_tighter_window(self, store):
        """45 days for ``profile`` against 180 for a preference: a stale profile
        line is paid for on every turn, not only when something matches it."""
        from app.services.memory_store import consolidation

        store.save_fact('p:mid', {'fact': 'an older profile statement about the user'}, kind='profile', title='Mid')
        store.save_fact('u:mid', {'fact': 'prefers serif fonts in documents'}, kind='preference', title='MidPref')
        _backdate('p:mid', 60)
        _backdate('u:mid', 60)

        proposed, notes = consolidation._retire_stale_memories()
        assert proposed == 1, notes
        assert any('Mid' in n for n in notes)

    def test_dedupe_no_double_proposal(self, store):
        from app.services.memory_store import consolidation

        store.save_fact('user:dup', {'fact': 'prefers tabs'}, kind='preference', title='Tabs')
        _backdate('user:dup', 300)
        first, _ = consolidation._retire_stale_memories()
        second, _ = consolidation._retire_stale_memories()
        assert first == 1
        assert second == 0  # already has an open proposal

    def test_approve_retires_reversible(self, store):
        from app.services.memory_conn import conn
        from app.services.memory_store import consolidation

        store.save_fact('user:go', {'fact': 'prefers go'}, kind='preference', title='Go')
        _backdate('user:go', 300)
        consolidation._retire_stale_memories()
        pid = int(
            conn().execute(
                "SELECT id FROM proposals WHERE proposal_type = 'retire-fact' "
                "AND status = 'pending' ORDER BY id DESC LIMIT 1"
            ).fetchone()['id']
        )
        res = consolidation.apply_retire_decision(pid, approve=True)
        assert res['ok'] and res['retired']
        row = conn().execute("SELECT status FROM facts WHERE fact_key = 'user:go'").fetchone()
        assert str(row['status']) == 'retired'
        # The proposal itself is stamped approved.
        prow = conn().execute('SELECT status FROM proposals WHERE id = ?', (pid,)).fetchone()
        assert str(prow['status']) == 'approved'

    def test_approval_closes_a_proposal_if_the_fact_was_used_after_filing(self, store):
        from app.services.memory_conn import conn
        from app.services.memory_store import consolidation, touch_fact_usage

        store.save_fact('user:changed', {'fact': 'prefers a changed value'}, kind='preference', title='Changed')
        _backdate('user:changed', 300)
        consolidation._retire_stale_memories()
        pid = int(
            conn().execute(
                "SELECT id FROM proposals WHERE proposal_type = 'retire-fact' "
                "AND status = 'pending' ORDER BY id DESC LIMIT 1"
            ).fetchone()['id']
        )

        touch_fact_usage(['user:changed'])
        result = consolidation.apply_retire_decision(pid, approve=True)

        assert result['ok'] is True
        assert result['retired'] is False
        assert result['decision'] == 'rejected'
        assert 'changed after this proposal' in result['error']
        fact = conn().execute("SELECT status FROM facts WHERE fact_key = 'user:changed'").fetchone()
        proposal = conn().execute('SELECT status FROM proposals WHERE id = ?', (pid,)).fetchone()
        assert str(fact['status']) == 'active'
        assert str(proposal['status']) == 'rejected'

    def test_reject_keeps_fact(self, store):
        from app.services.memory_conn import conn
        from app.services.memory_store import consolidation

        store.save_fact('user:keep', {'fact': 'prefers keep'}, kind='preference', title='Keep')
        _backdate('user:keep', 300)
        consolidation._retire_stale_memories()
        pid = int(
            conn().execute(
                "SELECT id FROM proposals WHERE proposal_type = 'retire-fact' "
                "AND status = 'pending' ORDER BY id DESC LIMIT 1"
            ).fetchone()['id']
        )
        res = consolidation.apply_retire_decision(pid, approve=False)
        assert res['ok'] and not res['retired']
        row = conn().execute("SELECT status FROM facts WHERE fact_key = 'user:keep'").fetchone()
        assert str(row['status']) == 'active'

    def test_disabled_by_config(self, store, monkeypatch):
        from app.services import brain_config_service
        from app.services.memory_store import consolidation

        monkeypatch.setattr(
            brain_config_service,
            'getRuntimeConfig',
            lambda: {'memoryRetireEnabled': False},
        )
        store.save_fact('user:off', {'fact': 'prefers off'}, kind='preference', title='Off')
        _backdate('user:off', 300)
        proposed, _ = consolidation._retire_stale_memories()
        assert proposed == 0


class TestOQ1RetireSurface:
    def test_privacy_summary_has_no_auto_memories(self, store):
        from app.main import app
        from fastapi.testclient import TestClient

        with TestClient(app) as client:
            r = client.get('/api/privacy/summary')
            assert r.status_code == 200
            assert 'autoMemories' not in r.json()['counts']

    def test_privacy_export_has_no_auto_memories(self, store):
        from app.main import app
        from fastapi.testclient import TestClient

        with TestClient(app) as client:
            r = client.post('/api/privacy/export')
            assert r.status_code == 200
            # The export no longer carries the retired store key.
            assert 'autoMemories' not in r.json().get('entries', {})


class TestRestoreRetired:
    """The un-retire door: the Memory UI's row PATCH whitelists `status` so a
    human can bring a parked row back. Without it the docstring's promise —
    "approve → status 'retired', REVERSIBLE" — had no surface to reverse on:
    the upsert door exists but silently nulls expires_at and clobbers source,
    so a restore through it damaged the row it was reviving."""

    def test_row_patch_restores_a_retired_fact(self, store):
        from app.services.memory_conn import conn
        from app.services.memory_store import brain as brain_mod

        store.save_fact(
            'user:restore-me', {'fact': 'prefers morning runs'},
            kind='preference', title='Morning runs',
        )
        conn().execute(
            "UPDATE facts SET status = 'retired' WHERE fact_key = 'user:restore-me'"
        )
        conn().commit()

        row_id = conn().execute(
            "SELECT id FROM facts WHERE fact_key = 'user:restore-me'"
        ).fetchone()['id']
        result = brain_mod.brain_update_row('facts', str(row_id), {'status': 'active'})
        assert result['ok'] is True
        status = conn().execute(
            "SELECT status FROM facts WHERE fact_key = 'user:restore-me'"
        ).fetchone()['status']
        assert status == 'active'

    def test_restored_fact_is_visible_to_recall_again(self, store):
        from app.services.memory_conn import conn
        from app.services.memory_store import brain as brain_mod

        store.save_fact('user:recall-me', {'fact': 'drinks espresso'}, title='Espresso')
        conn().execute("UPDATE facts SET status = 'retired' WHERE fact_key = 'user:recall-me'")
        conn().commit()
        # Retired: the visibility clause every non-ranked facts read applies
        # filters the row out.
        from app.services.memory_store.rest import _visibility_where
        where, _params = _visibility_where('global')
        found = conn().execute(
            f"SELECT fact_key FROM facts WHERE fact_key = 'user:recall-me' AND {where}"
        ).fetchall()
        assert found == []

        row_id = conn().execute(
            "SELECT id FROM facts WHERE fact_key = 'user:recall-me'"
        ).fetchone()['id']
        assert brain_mod.brain_update_row('facts', str(row_id), {'status': 'active'})['ok']
        found = conn().execute(
            f"SELECT fact_key FROM facts WHERE fact_key = 'user:recall-me' AND {where}"
        ).fetchall()
        assert len(found) == 1

    def test_status_patch_never_parks_a_row(self, store):
        """The settings door only LIFTS retirement; it refuses to impose it —
        consolidation's proposal flow stays the only writer of 'retired'."""
        from app.services.memory_conn import conn
        from app.services.memory_store import brain as brain_mod

        store.save_fact('user:no-retire', {'fact': 'keeps its status'}, title='Keep')
        row_id = conn().execute(
            "SELECT id FROM facts WHERE fact_key = 'user:no-retire'"
        ).fetchone()['id']
        result = brain_mod.brain_update_row('facts', str(row_id), {'status': 'retired'})
        assert result['ok'] is False
        status = conn().execute(
            "SELECT status FROM facts WHERE fact_key = 'user:no-retire'"
        ).fetchone()['status']
        assert status != 'retired'

    def test_the_value_the_guard_tests_is_the_value_stored(self, store):
        """The gate stripped for the check but wrote the raw patch, so
        `{'status': ' active '}` passed the door and landed as `' active '` —
        which `_visibility_where` (`status = 'active'`) and the UI badge both
        miss. The user got "Entry restored — it is recalled again" over a fact
        that stayed parked. Casing was the same hole: `'RETIRED'` used to pass
        through as a fourth value nobody reads."""
        from app.services.memory_conn import conn
        from app.services.memory_store import brain as brain_mod
        from app.services.memory_store.rest import _visibility_where

        store.save_fact('user:padded', {'fact': 'prefers aisle seats'}, title='Aisle')
        conn().execute("UPDATE facts SET status = 'retired' WHERE fact_key = 'user:padded'")
        conn().commit()
        row_id = conn().execute(
            "SELECT id FROM facts WHERE fact_key = 'user:padded'").fetchone()['id']

        assert brain_mod.brain_update_row('facts', str(row_id), {'status': ' active '})['ok'] is True
        stored = conn().execute(
            "SELECT status FROM facts WHERE fact_key = 'user:padded'").fetchone()['status']
        assert stored == 'active', f'stored verbatim instead of normalised: {stored!r}'
        where, _p = _visibility_where('global')
        assert conn().execute(
            f"SELECT fact_key FROM facts WHERE fact_key = 'user:padded' AND {where}"
        ).fetchall(), 'a restored fact must be recallable'

        # 'RETIRED' is the refused direction whether or not it is shouted.
        refused = brain_mod.brain_update_row('facts', str(row_id), {'status': 'RETIRED'})
        assert refused['ok'] is False
        assert conn().execute(
            "SELECT status FROM facts WHERE fact_key = 'user:padded'").fetchone()['status'] == 'active'

    def test_a_blank_status_field_does_not_hide_the_row(self, store):
        """`''` passed the old guard (it is in the allowed set) and would have
        been written — and `status = ''` fails the visibility clause exactly
        like 'retired' does, so a UI field cleared to empty would park a live
        fact while reporting success. It now means "leave it alone"."""
        from app.services.memory_conn import conn
        from app.services.memory_store import brain as brain_mod

        store.save_fact('user:blank', {'fact': 'prefers dark mode'}, title='Dark')
        row_id = conn().execute(
            "SELECT id FROM facts WHERE fact_key = 'user:blank'").fetchone()['id']
        result = brain_mod.brain_update_row('facts', str(row_id), {'status': ''})
        assert result['ok'] is False, result
        stored = conn().execute(
            "SELECT status FROM facts WHERE fact_key = 'user:blank'").fetchone()['status']
        assert stored == 'active', f'a blank patch wrote {stored!r}'


class TestRetireDecisionIsDecidedOnce:
    """`apply_retire_decision` used to stamp the proposal LAST, unconditionally:
    a decision was a rewrite, not a transition. So approving a proposal someone
    had already rejected ran the retire UPDATE anyway, and a crash between the
    commit and the stamp could leave a retired fact filed under 'rejected'.
    The decision is now a claim that only fires while the row is pending."""

    def _file(self, store, key: str, title: str = 'Pref') -> int:
        from app.services.memory_conn import conn
        from app.services.memory_store import consolidation

        store.save_fact(key, {'fact': 'prefers something durable'}, kind='preference', title=title)
        _backdate(key, 300)
        consolidation._retire_stale_memories()
        return int(
            conn().execute(
                "SELECT id FROM proposals WHERE proposal_type = 'retire-fact' "
                "AND status = 'pending' ORDER BY id DESC LIMIT 1"
            ).fetchone()['id']
        )

    def test_rejecting_then_approving_a_proposal_changes_nothing(self, store):
        from app.services.memory_conn import conn
        from app.services.memory_store import consolidation

        pid = self._file(store, 'user:twice')
        assert consolidation.apply_retire_decision(pid, approve=False)['ok'] is True
        res = consolidation.apply_retire_decision(pid, approve=True)
        assert res['ok'] is False, f'an already-rejected proposal was re-opened: {res}'
        assert str(conn().execute(
            "SELECT status FROM facts WHERE fact_key = 'user:twice'").fetchone()['status']) == 'active'
        assert str(conn().execute(
            'SELECT status FROM proposals WHERE id = ?', (pid,)).fetchone()['status']) == 'rejected'

    def test_approving_twice_does_not_re_stamp_the_decision(self, store):
        from app.services.memory_conn import conn
        from app.services.memory_store import consolidation

        pid = self._file(store, 'user:double')
        first = consolidation.apply_retire_decision(pid, approve=True)
        assert first['ok'] and first['retired']
        second = consolidation.apply_retire_decision(pid, approve=False)
        assert second['ok'] is False, 'a reject re-stamped an approval'
        assert str(conn().execute(
            'SELECT status FROM proposals WHERE id = ?', (pid,)).fetchone()['status']) == 'approved'

    def test_a_failing_fact_write_rolls_the_claim_back(self, store, monkeypatch):
        """The claim is written on the thread-local connection BEFORE the fact
        UPDATE and committed with it. If the UPDATE raises, an uncommitted
        'approved' survives on that connection — and the NEXT unrelated write on
        the same thread lands it, leaving a proposal stamped approved over a fact
        that was never retired and that can never be re-decided (the claim is
        spent). The flow must roll the claim back with the statement that failed.
        """
        import sqlite3

        from app.services.memory_conn import conn as real_conn
        from app.services.memory_store import consolidation

        pid = self._file(store, 'user:raise')

        class _Boom:
            def __init__(self, c):
                self._c = c

            def execute(self, sql, *a, **k):
                if str(sql).lstrip().startswith('UPDATE facts'):
                    raise sqlite3.OperationalError('disk I/O error (simulated)')
                return self._c.execute(sql, *a, **k)

            def __getattr__(self, name):
                return getattr(self._c, name)

        monkeypatch.setattr(consolidation, '_conn', lambda: _Boom(real_conn()))
        res = consolidation.apply_retire_decision(pid, approve=True)
        assert res['ok'] is False, res
        assert 'simulated' in str(res['error'])

        monkeypatch.undo()
        # The proposal is decidable again — the spent claim went back with it.
        status = real_conn().execute(
            'SELECT status FROM proposals WHERE id = ?', (pid,)
        ).fetchone()['status']
        assert str(status) == 'pending', f'the failed flow left the claim landed: {status}'
        assert str(real_conn().execute(
            "SELECT status FROM facts WHERE fact_key = 'user:raise'").fetchone()['status']) == 'active'
        again = consolidation.apply_retire_decision(pid, approve=True)
        assert again['ok'] is True and again['retired'] is True

    def test_a_failed_retire_does_not_swallow_an_unrelated_pending_write(self, store, monkeypatch):
        """The undo is bounded to this decision, not to the whole transaction.

        `_conn()` is the thread-local handle, so whatever else that thread has
        written and not yet committed shares the transaction with the claim:
        a fact saved moments earlier by the same tool loop, a KV row, a
        transcript block. The first version unwound the failure with
        `conn.rollback()`, which drops the last COMMIT onward — so a simulated
        disk error on the retire UPDATE silently destroyed work the caller was
        never told about, and reported only `apply_retire_decision(...)` failed.
        A SAVEPOINT rolls back the claim plus the UPDATE and nothing else.
        """
        import sqlite3

        from app.services.memory_conn import conn as real_conn
        from app.services.memory_store import consolidation

        pid = self._file(store, 'user:nearby')

        class _Boom:
            def __init__(self, c):
                self._c = c

            def execute(self, sql, *a, **k):
                if str(sql).lstrip().startswith('UPDATE facts'):
                    raise sqlite3.OperationalError('disk I/O error (simulated)')
                return self._c.execute(sql, *a, **k)

            def __getattr__(self, name):
                return getattr(self._c, name)

        # An unrelated write, left uncommitted on the same handle on purpose —
        # that is the state the rollback would eat.
        c = real_conn()
        c.execute(
            "INSERT INTO facts (fact_key, fact_value, kind, title) "
            "VALUES ('user:neighbour', '\"kept\"', 'general', 'Neighbour')"
        )

        monkeypatch.setattr(consolidation, '_conn', lambda: _Boom(c))
        res = consolidation.apply_retire_decision(pid, approve=True)
        monkeypatch.undo()

        assert res['ok'] is False and 'simulated' in str(res['error'])
        row = c.execute("SELECT fact_value FROM facts WHERE fact_key = 'user:neighbour'").fetchone()
        assert row is not None, 'an unrelated uncommitted write was eaten by the failed decision'
        # The neighbour write is still pending, exactly as it was left; the
        # claim, by contrast, must be gone.
        assert str(c.execute('SELECT status FROM proposals WHERE id = ?', (pid,)).fetchone()['status']) == 'pending'
        c.execute("DELETE FROM facts WHERE fact_key = 'user:neighbour'")
        c.commit()

    def test_a_failure_in_the_corrective_branch_leaves_no_open_savepoint(self, store, monkeypatch):
        """The guard covers the whole unit, not just its first two statements.

        The stale-evidence branch writes a SECOND claim (correcting our own
        'approved' to 'rejected') and then RELEASEs. When only the claim plus the
        fact UPDATE were inside the try, an error there escaped the handler with
        `retire_decision` still open on the thread-local handle — and the next
        unrelated `brain_commit` on that thread landed the spent 'approved' claim
        over a fact that was never retired. That is the one state the whole
        claim-before-write design says cannot exist, reached through the branch
        written to prevent it.
        """
        import sqlite3

        from app.services.memory_conn import conn as real_conn
        from app.services.memory_store import consolidation, save_fact

        store.save_fact('user:branch', {'fact': 'prefers something durable'}, kind='preference', title='Pref')
        _backdate('user:branch', 300)
        consolidation._retire_stale_memories()
        pid = int(real_conn().execute(
            "SELECT id FROM proposals WHERE proposal_type = 'retire-fact' "
            "AND status = 'pending' ORDER BY id DESC LIMIT 1"
        ).fetchone()['id'])
        # Make the evidence stale so the flow takes the corrective branch, and
        # make that branch's second claim raise.
        from app.services.memory_store import touch_fact_usage

        touch_fact_usage(['user:branch'])

        calls = {'n': 0}
        # `apply_retire_decision` imports the claim inside its own body, so the
        # name to patch is the package attribute it reads at call time.
        import app.services.memory_store as ms

        real_claim = ms.claim_proposal_decision

        def claim_then_boom(conn, proposal_id, status, decidedBy='', from_status='pending'):
            calls['n'] += 1
            if calls['n'] == 2:
                raise sqlite3.OperationalError('second claim failed (simulated)')
            return real_claim(conn, proposal_id, status, decidedBy, from_status)

        monkeypatch.setattr(ms, 'claim_proposal_decision', claim_then_boom)
        res = consolidation.apply_retire_decision(pid, approve=True)
        monkeypatch.undo()

        assert res['ok'] is False, res
        assert 'simulated' in str(res['error'])
        assert not real_conn().in_transaction, (
            'the savepoint was left open — the next unrelated commit on this '
            'thread would land the spent claim'
        )
        # Nothing of this decision survives to be committed by someone else.
        status = str(real_conn().execute(
            'SELECT status FROM proposals WHERE id = ?', (pid,)
        ).fetchone()['status'])
        assert status == 'pending', f'the failed branch left the proposal {status!r}'
        # And an unrelated write on the same handle is not carrying our debris.
        real_conn().execute(
            "INSERT INTO facts (fact_key, fact_value, kind, title) "
            "VALUES ('user:unrelated', '\"x\"', 'general', 'Unrelated')"
        )
        real_conn().commit()
        assert str(real_conn().execute(
            'SELECT status FROM proposals WHERE id = ?', (pid,)
        ).fetchone()['status']) == 'pending', 'an unrelated commit published the retire claim'
        real_conn().execute("DELETE FROM facts WHERE fact_key = 'user:unrelated'")
        real_conn().commit()

    def test_a_stale_approval_closes_as_rejected_with_the_fact_recalled(self, store):
        """The one transition that is still allowed from a claim: correcting
        OUR OWN un-committed claim when the evidence turns out stale. Both
        halves must land in the same COMMIT, so no crash leaves 'approved' over
        an un-retired fact or 'rejected' over a retired one."""
        from app.services.memory_conn import conn
        from app.services.memory_store import consolidation, touch_fact_usage

        pid = self._file(store, 'user:stale-claim')
        touch_fact_usage(['user:stale-claim'])
        res = consolidation.apply_retire_decision(pid, approve=True)
        assert res['decision'] == 'rejected' and res['retired'] is False
        assert str(conn().execute(
            "SELECT status FROM facts WHERE fact_key = 'user:stale-claim'").fetchone()['status']) == 'active'
        assert str(conn().execute(
            'SELECT status FROM proposals WHERE id = ?', (pid,)).fetchone()['status']) == 'rejected'
        # And the corrected row is still closed: it cannot be re-opened.
        assert consolidation.apply_retire_decision(pid, approve=True)['ok'] is False

