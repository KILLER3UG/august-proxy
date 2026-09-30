"""The subagent fanout is a different population, and must not pollute the panel.

Roadmap #8. `spawn_subagents_tool.py` writes a durable row into the same
`turn_outcomes` table with `task_type='subagent_fanout'` and `model=''`. Nothing
downstream filtered on `task_type`, so a 1-3 round fanout aggregate was
averaged into the same `reasons` histogram and the same round average as a
20-round main turn — the Learning panel's "avg rounds" was a blend of two
populations that mean different things.

Worse: `error_rate_by_model` grouped by model and ordered by errors descending,
so the `('', '')` bucket — which only ever holds fanout rows — sorted to the
TOP of the per-model error ranking whenever any fanout ended badly. A phantom
"model" with the highest error rate on the Observability page.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


def _main(rounds: int, ok: bool = True) -> None:
    from app.services.turn_outcomes import record_turn_outcome

    record_turn_outcome(
        model='claude-opus', provider='anthropic', task_type='agent',
        ok=ok, rounds=rounds, end_reason='finished',
    )


def _fanout(rounds: int, ok: bool = True) -> None:
    from app.services.turn_outcomes import record_turn_outcome

    # Exactly how the fanout writes it: no model, no provider, 1-3 rounds.
    record_turn_outcome(
        model='', provider='', task_type='subagent_fanout',
        ok=ok, rounds=rounds, end_reason='finished' if ok else 'error',
    )


class TestVerdictStatsExcludeTheFanout:
    def test_fanout_rows_do_not_move_avg_rounds(self, brain):
        """The headline: fanout volume must not move the panel's number."""
        from app.services.turn_outcomes import turn_verdict_stats

        for _ in range(4):
            _main(20)
        before = turn_verdict_stats(30)
        assert before['turns'] == 4
        assert before['counters']['rounds']['avg'] == 20.0

        for _ in range(20):
            _fanout(1)
        after = turn_verdict_stats(30)
        assert after['turns'] == 4, 'fanout rows were counted as main turns'
        assert after['counters']['rounds']['avg'] == 20.0, (
            'short fanout rows dragged the main-turn average down'
        )

    def test_the_excluded_rows_are_still_reachable(self, brain):
        """Filtered, not hidden — an explicit taskType selects exactly one."""
        from app.services.turn_outcomes import turn_verdict_stats

        _main(20)
        _fanout(1)

        assert turn_verdict_stats(30)['turns'] == 1
        assert turn_verdict_stats(30, task_type='subagent_fanout')['turns'] == 1
        assert turn_verdict_stats(30, task_type='agent')['turns'] == 1

    def test_by_task_type_shows_the_split(self, brain):
        """The panel must be able to show what was excluded, not assert it."""
        from app.services.turn_outcomes import turn_verdict_stats

        _main(20)
        _main(20)
        _fanout(1)

        rows = {r['taskType']: r for r in turn_verdict_stats(30)['byTaskType']}
        assert rows['agent']['turns'] == 2
        assert rows['agent']['avgRounds'] == 20.0
        assert rows['subagent_fanout']['turns'] == 1
        assert rows['subagent_fanout']['avgRounds'] == 1.0

    def test_a_failure_in_a_fanout_does_not_pollute_the_reasons(self, brain):
        from app.services.turn_outcomes import turn_verdict_stats

        _main(20, ok=True)
        _fanout(1, ok=False)

        reasons = {r['reason']: r['turns'] for r in turn_verdict_stats(30)['reasons']}
        assert 'error' not in reasons, (
            f"a subagent's failure was attributed to the user's turn reasons: {reasons}"
        )
        assert reasons.get('finished') == 1


class TestErrorRateHasNoPhantomModel:
    def test_the_unnamed_bucket_never_leads_the_ranking(self, brain):
        """The visible defect: a fake model at the top of the error board."""
        from app.services.turn_outcomes import error_rate_by_model

        # A well-behaved model, and a fanout that failed hard.
        _main(10, ok=True)
        for _ in range(9):
            _fanout(1, ok=False)

        rows = error_rate_by_model(30)
        assert rows, 'no rows at all'
        assert str(rows[0]['model'] or ''), (
            f'the phantom unnamed model led the ranking: {rows}'
        )

    def test_named_models_still_rank_by_errors(self, brain):
        from app.services.turn_outcomes import error_rate_by_model

        for _ in range(3):
            _main(10, ok=False)
        for _ in range(5):
            _main(10, ok=True)

        rows = error_rate_by_model(30)
        assert rows[0]['model'] == 'claude-opus'
        assert rows[0]['errors'] == 3

    def test_an_unnamed_row_is_kept_not_dropped(self, brain):
        """Demoted, not deleted — the data is still there for a by-task view."""
        from app.services.memory_conn import conn
        from app.services.turn_outcomes import error_rate_by_model

        _fanout(1, ok=False)
        rows = error_rate_by_model(30)
        # The fanout is excluded from THIS aggregate...
        assert all(str(r['model'] or '') for r in rows), (
            f'fanout rows still reach the per-model ranking: {rows}'
        )
        # ...but the row itself was never deleted.
        total = conn().execute(
            "SELECT COUNT(*) AS n FROM turn_outcomes WHERE task_type = 'subagent_fanout'"
        ).fetchone()
        assert int(total['n']) == 1


class TestPredicateIsShared:
    def test_one_predicate_serves_both_readers(self, brain):
        """The aggregates drifted because each had its own idea of the filter."""
        from app.services.turn_outcomes import _turnTypePredicate

        where, params = _turnTypePredicate(None)
        assert 'subagent_fanout' in params, 'the fanout is the default exclusion'
        assert 'COALESCE' in where, (
            "a bare inequality would evaluate to NULL for a NULL task_type and "
            'silently drop every row written before task_type existed'
        )
        where2, params2 = _turnTypePredicate('agent')
        assert where2 == 'task_type = ?'
        assert params2 == ['agent']

    def test_rows_with_no_task_type_still_count(self, brain):
        """The NULL case the COALESCE exists for."""
        from app.services.memory_conn import conn
        from app.services.turn_outcomes import _turnTypePredicate

        where, params = _turnTypePredicate(None)
        n = conn().execute(
            "SELECT COUNT(*) AS n FROM turn_outcomes WHERE COALESCE(task_type, '') != ?",
            params,
        ).fetchone()
        # A row with task_type NULL must be selected by the default predicate.
        conn().execute('INSERT INTO turn_outcomes (model, provider, task_type) VALUES (?,?,?)',
                       ('legacy', 'p', None))
        n2 = conn().execute(
            "SELECT COUNT(*) AS n FROM turn_outcomes WHERE COALESCE(task_type, '') != ?",
            params,
        ).fetchone()
        assert int(n2['n']) == int(n['n']) + 1, 'a NULL task_type row was excluded'
        assert where, 'predicate must be usable standalone'
