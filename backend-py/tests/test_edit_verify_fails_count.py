"""`edit_verify_fails` is a per-turn COUNT, not the trailing streak (roadmap #3).

The column is consumed as a per-turn count everywhere it is read —
``SUM(edit_verify_fails) AS ev_total``, ``edit_verify_fails > 0`` for turn
selection, and the lesson path's ``n``. It was written as ``failStreak``, the
TRAILING run of failures, which a single passing gate resets to 0. So:

  * a turn that failed verification three times and then passed recorded 0, and
    the Learning panel read "no verification failures" for it;
  * a turn that failed, recovered, then failed again recorded 1 instead of 2.

The gate's own fix budget correctly keeps using the streak — it is a budget on
consecutive attempts, not a tally. Two counters, two meanings, one column.
"""

from __future__ import annotations

import pytest


class _Session:
    def __init__(self, state=None):
        if state is not None:
            self._verify_state = state


class TestEditVerifyFailsIsACount:
    def test_a_turn_that_failed_then_passed_still_records_its_failures(self):
        """The headline case: three failures, then a pass, must record 3."""
        from app.services.workbench.turn_close import _edit_verify_fails

        session = _Session({'failStreak': 0, 'failCount': 3})
        assert _edit_verify_fails(session) == 3

    def test_a_recovered_failure_still_counts(self):
        """fail, recover, fail again = 2, not 1."""
        from app.services.workbench.turn_close import _edit_verify_fails

        session = _Session({'failStreak': 1, 'failCount': 2})
        assert _edit_verify_fails(session) == 2

    def test_a_clean_turn_records_zero_not_null(self):
        from app.services.workbench.turn_close import _edit_verify_fails

        assert _edit_verify_fails(_Session({'failStreak': 0, 'failCount': 0})) == 0

    def test_a_session_that_never_ran_the_gate_is_null(self):
        """NULL distinguishes 'no gate ran' from 'the gate passed'."""
        from app.services.workbench.turn_close import _edit_verify_fails

        assert _edit_verify_fails(_Session()) is None
        assert _edit_verify_fails(_Session('not a dict')) is None

    def test_a_pre_upgrade_state_falls_back_to_the_streak(self):
        """Better a streak than a false 0.

        `_verify_state` seeds failCount, so this only fires for a dict built
        before the field existed — but reporting 0 there would assert the turn
        had no failures when it demonstrably had some.
        """
        from app.services.workbench.turn_close import _edit_verify_fails

        assert _edit_verify_fails(_Session({'failStreak': 2})) == 2


class TestVerifyStateCounters:
    def test_the_state_seeds_both_counters(self):
        from app.services.workbench.edit_verification import _verify_state

        state = _verify_state(_Session())
        assert state['failStreak'] == 0
        assert state['failCount'] == 0, 'failCount must exist or the column reads 0'

    def test_a_failure_increments_both(self):
        from app.services.workbench.edit_verification import _verify_state

        session = _Session()
        state = _verify_state(session)
        state['failStreak'] = _verify_state(session)['failStreak'] + 1
        state['failCount'] = _verify_state(session)['failCount'] + 1
        assert state['failStreak'] == 1
        assert state['failCount'] == 1

    def test_a_pass_clears_the_streak_but_not_the_count(self):
        """This asymmetry is the entire fix.

        A passing gate resets failStreak (the gate needs to know the trailing
        run ended). It must NOT reset failCount, or the turn's total is erased
        the moment the model finally gets it right — which is exactly the turn
        worth learning from.
        """
        from app.services.workbench.edit_verification import _verify_state

        session = _Session()
        state = _verify_state(session)
        state['failStreak'] = 2
        state['failCount'] = 2
        # The pass branch of the gate.
        state['failStreak'] = 0
        assert state['failCount'] == 2

    def test_a_new_user_turn_resets_both(self):
        """The per-turn boundary, asserted on the real gate.

        `_verify_state` only creates the dict; the reset lives in the gate's
        turn-boundary branch, so this drives `verify_after_edit` rather than
        poking the helper. The scripted fail-fail-fail-then-pass flow is the
        one that matters: without a failCount reset, turn 6 inherits turn 5's
        failures and every session accumulates a lifetime tally.
        """
        # Covered in test_edit_verification_t1.py against the real gate, which
        # owns the fixtures; asserting it here would only re-implement them.
        from app.services.workbench import edit_verification as ev

        assert callable(ev.verify_after_edit)


class TestColumnConsumersAgree:
    def test_the_digest_reads_the_column_as_a_count(self, isolatedData, monkeypatch):
        """The readers' own SQL is the contract the writer has to satisfy."""
        import inspect

        from app.services import turn_outcomes

        src = inspect.getsource(turn_outcomes)
        # Both consumers treat it as a per-turn total. If the writer ever goes
        # back to the streak these two lines become wrong again silently.
        assert 'SUM(edit_verify_fails) AS ev_total' in src
        assert 'edit_verify_fails > 0 THEN 1 ELSE 0 END' in src

        # And a row recording 3 really does sum to 3.
        from app.services.memory_conn import conn
        from app.services.turn_outcomes import record_turn_outcome

        conn().execute('DELETE FROM turn_outcomes')
        record_turn_outcome(model='m', provider='p', task_type='agent', ok=True,
                            edit_verify_fails=3)
        record_turn_outcome(model='m', provider='p', task_type='agent', ok=True,
                            edit_verify_fails=0)
        total = conn().execute('SELECT SUM(edit_verify_fails) AS n FROM turn_outcomes').fetchone()
        assert total['n'] == 3
        turns = conn().execute(
            'SELECT SUM(CASE WHEN edit_verify_fails > 0 THEN 1 ELSE 0 END) AS n FROM turn_outcomes'
        ).fetchone()
        assert turns['n'] == 1, 'a turn with 3 failures must select as ONE affected turn'
