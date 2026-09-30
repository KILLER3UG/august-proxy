"""The turn ledger's `ok` must mean WHY THE TURN STOPPED (roadmap item #2).

Regression cover for the audit finding that the harness's own learning signals
were blind to its own failure modes: `ok` was `turnError is None`, so a turn
that ended `stall-stop`, `length`, `budget`, `cap` or `awaiting-input` — none of
which raise — was recorded as a CLEAN SUCCESS. `skill_lift` measured a skill's
effect on that column and `error_rate_by_model` ranked models by it, so a turn
the harness built stall detection and budget ladders to catch contributed zero
to the error rate.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


class TestTurnOkAuthority:
    @pytest.mark.parametrize(
        'reason,errored,expected',
        [
            # The only clean success.
            ('finished', False, True),
            # Every one of these is a failure the harness exists to fix, and
            # none of them raises an exception.
            ('stall-stop', False, False),
            ('length', False, False),
            ('budget', False, False),
            ('cap', False, False),
            ('interrupted', False, False),
            ('error', False, False),
            # The human owes an answer: not a failure, not a success.
            ('awaiting-input', False, None),
            # An exception is a failure whatever the reason says.
            ('finished', True, False),
            ('awaiting-input', True, False),
            # Never classified -> unmeasured, NOT a success.
            (None, False, None),
            ('', False, None),
        ],
    )
    def test_mapping(self, reason, errored, expected):
        from app.services.turn_outcomes import turn_ok

        assert turn_ok(reason, errored) is expected

    def test_case_and_whitespace_are_tolerated(self):
        from app.services.turn_outcomes import turn_ok

        assert turn_ok('  FINISHED ', False) is True
        assert turn_ok('Stall-Stop', False) is False


class TestNullIsNotZero:
    def test_unclassified_turns_persist_as_null(self, brain):
        """NULL, never 0 — 'unmeasured' must stay distinguishable from 'failed'."""
        from app.services.memory_conn import conn
        from app.services.turn_outcomes import record_turn_outcome, turn_ok

        record_turn_outcome(model='m', provider='p', task_type='agent', ok=turn_ok(None, False))
        row = conn().execute('SELECT ok FROM turn_outcomes ORDER BY id DESC LIMIT 1').fetchone()
        assert row['ok'] is None, 'an unmeasured turn was written as a measured failure'

    def test_a_stall_stop_is_no_longer_a_clean_success(self, brain):
        """The finding itself: a stall used to record ok=1."""
        from app.services.memory_conn import conn
        from app.services.turn_outcomes import record_turn_outcome, turn_ok

        record_turn_outcome(
            model='m', provider='p', task_type='agent', ok=turn_ok('stall-stop', False),
            end_reason='stall-stop',
        )
        row = conn().execute('SELECT ok FROM turn_outcomes ORDER BY id DESC LIMIT 1').fetchone()
        assert row['ok'] == 0, 'a stalled turn is still being recorded as a success'


class TestReadersHonourNull:
    def test_error_rate_excludes_unclassified_turns(self, brain):
        """COUNT(ok), not COUNT(*): an unmeasured row must not dilute the rate."""
        from app.services.turn_outcomes import error_rate_by_model, record_turn_outcome, turn_ok

        record_turn_outcome(model='m1', provider='p', task_type='agent', ok=True)
        record_turn_outcome(model='m1', provider='p', task_type='agent', ok=False)
        # Unclassified: must not count as a turn NOR as a success.
        for _ in range(5):
            record_turn_outcome(model='m1', provider='p', task_type='agent', ok=None)

        row = next(r for r in error_rate_by_model() if r['model'] == 'm1')
        assert row['turns'] == 2, f"unclassified turns leaked into the denominator: {row}"
        assert row['errorRate'] == 0.5

    def test_skill_lift_excludes_unclassified_turns(self, brain):
        """Same for skill_lift: SUM ignores NULL, so COUNT must too."""
        from app.services.turn_outcomes import record_turn_outcome, skill_lift, turn_ok

        # 2 turns with the skill (1 ok), 2 without (2 ok) -> lift 1.0 - 1.0 = 0.0
        record_turn_outcome(model='m', provider='p', task_type='agent', ok=True,
                            skills_injected=['good'])
        record_turn_outcome(model='m', provider='p', task_type='agent', ok=False,
                            skills_injected=['good'])
        record_turn_outcome(model='m', provider='p', task_type='agent', ok=True,
                            skills_injected=[])
        record_turn_outcome(model='m', provider='p', task_type='agent', ok=True,
                            skills_injected=[])
        # Unclassified turns would drag the with-skill rate down if counted.
        for _ in range(4):
            record_turn_outcome(model='m', provider='p', task_type='agent', ok=None,
                                skills_injected=['good'])

        lift = skill_lift()
        assert 'good' in lift, f'the skill vanished from the map: {lift}'
        # with: 1/2 = 0.5. without: 2/2 = 1.0. lift = -0.5.
        # Counting the 4 NULL rows would give with = 1/6 = 0.167 -> -0.833.
        assert lift['good'] == pytest.approx(-0.5), (
            f'unclassified turns were counted in the denominator: {lift["good"]}'
        )
