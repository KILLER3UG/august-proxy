"""GET /api/usage/sessions — the ONE read behind the sidebar's token deltas.

The sidebar renders `+input / −output` on every visible chat row. Reading that
per row meant one request per row, each pulling back a 500-event list plus a
per-event pricing sweep the row never reads. This is the grouped query that
replaces the N, so the two failure modes below are the ones that matter:
it must NOT cost a round trip per session, and it must not answer for a
session that has no usage rows.
"""

from __future__ import annotations

import pytest
from app.routers import usage as usage_api


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


@pytest.fixture
def usage_queries(monkeypatch):
    """Every `usage_events` statement the memory store runs, in order.

    `rest._conn` is the store's single database door, so swapping it counts
    reads across the whole module without any per-call-site instrumentation.
    """
    from app.services.memory_store import rest

    real_conn = rest._conn
    seen: list[str] = []

    class _Counting:
        def __init__(self, conn: object) -> None:
            self._conn = conn

        def execute(self, sql, *args, **kwargs):  # type: ignore[no-untyped-def]
            seen.append(str(sql))
            return self._conn.execute(sql, *args, **kwargs)  # type: ignore[attr-defined]

        def __getattr__(self, name):  # type: ignore[no-untyped-def]
            return getattr(self._conn, name)

    monkeypatch.setattr(rest, '_conn', lambda: _Counting(real_conn()))
    return seen


def _seed() -> None:
    from app.services.memory_store import record_usage

    # Two turns in one chat — the delta has to be the SUM, not the latest row.
    record_usage('sid-a', 'gpt-4o', inputTokens=100, outputTokens=40)
    record_usage('sid-a', 'gpt-4o', inputTokens=900, outputTokens=60)
    record_usage('sid-b', 'claude-sonnet-5', inputTokens=1234, outputTokens=567)
    # 'sid-c' deliberately has no usage at all.


class TestSessionUsageBatch:
    def test_totals_are_summed_across_every_event(self, brain):
        _seed()
        results = usage_api.get_sessions_usage(ids='sid-a,sid-b,sid-c')['results']
        assert results['sid-a']['totalInputTokens'] == 1000
        assert results['sid-a']['totalOutputTokens'] == 100
        assert results['sid-a']['totalEvents'] == 2
        assert results['sid-a']['totalTokens'] == 1100
        assert results['sid-b']['totalInputTokens'] == 1234
        assert results['sid-b']['totalOutputTokens'] == 567

    def test_a_chat_with_no_usage_is_absent_not_zero(self, brain):
        _seed()
        results = usage_api.get_sessions_usage(ids='sid-a,sid-c')['results']
        # The row renders nothing at all rather than claiming "+0 −0".
        assert set(results) == {'sid-a'}

    def test_the_whole_batch_is_one_query_not_one_per_session(self, brain, usage_queries):
        """The point of the endpoint: cost must not scale with row count."""
        _seed()
        usage_queries.clear()
        results = usage_api.get_sessions_usage(ids='sid-a,sid-b,sid-c')['results']
        assert set(results) == {'sid-a', 'sid-b'}
        statements = [sql for sql in usage_queries if 'usage_events' in sql]
        assert len(statements) == 1, f'expected one grouped query, ran {len(statements)}'
        assert 'GROUP BY session_id' in statements[0]

    def test_duplicates_and_blank_ids_do_not_duplicate_a_session(self, brain):
        _seed()
        results = usage_api.get_sessions_usage(ids='sid-a, sid-a , ,sid-a')['results']
        assert results['sid-a']['totalInputTokens'] == 1000

    def test_no_ids_is_an_empty_result_not_an_error(self, brain):
        assert usage_api.get_sessions_usage(ids='  , ,')['results'] == {}

    def test_an_unknown_session_never_raises(self, brain):
        assert usage_api.get_sessions_usage(ids='never-existed')['results'] == {}

    def test_the_batch_is_capped_rather_than_unbounded(self, brain):
        from app.services.memory_store import rest

        # Under SQLite's default bound-parameter ceiling, or the cap itself
        # would be the thing that breaks on a long history.
        assert rest.MAX_USAGE_BATCH_IDS <= 999
        ids = ','.join(f'sid-{i}' for i in range(rest.MAX_USAGE_BATCH_IDS + 50))
        assert usage_api.get_sessions_usage(ids=ids)['results'] == {}

    def test_the_batch_and_the_single_session_agree(self, brain):
        """Two doors onto the same numbers must not drift: the sidebar row and
        the composer chip show the same chat's usage side by side."""
        _seed()
        from app.services.memory_store import get_usage

        batch = usage_api.get_sessions_usage(ids='sid-b')['results']['sid-b']
        single = get_usage('sid-b')
        assert batch['totalInputTokens'] == single['totalInputTokens']
        assert batch['totalOutputTokens'] == single['totalOutputTokens']