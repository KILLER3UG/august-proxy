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


def _seed_many(count: int) -> None:
    """`count` sessions that DO have usage rows, one event each.

    A cap test needs rows on both sides of the line — an unseeded range answers
    `{}` whether or not the code truncated anything. Inserted as events rather
    than through `record_usage` only because that would be 250 commits; the
    rows are the same shape the store writes."""
    from app.services.memory_conn import conn

    conn().executemany(
        'INSERT INTO usage_events (session_id, model, input_tokens, output_tokens) '
        "VALUES (?, 'gpt-4o', ?, 1)",
        [(f'cap-{i}', 10 + i) for i in range(count)],
    )
    conn().commit()


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
        """Truncation has to be OBSERVED. The old version of this test asked
        for 300 ids and asserted `{}` — with nothing seeded, so deleting the
        `break` entirely still passed (300 placeholders sit under SQLite's 999
        ceiling, and an empty result proves nothing about which ids were
        dropped). Rows now exist on both sides of the cap."""
        from app.services.memory_store import rest

        # Under SQLite's default bound-parameter ceiling, or the cap itself
        # would be the thing that breaks on a long history.
        assert rest.MAX_USAGE_BATCH_IDS <= 999
        cap = rest.MAX_USAGE_BATCH_IDS
        _seed_many(cap + 50)
        ids = ','.join(f'cap-{i}' for i in range(cap + 50))
        results = usage_api.get_sessions_usage(ids=ids)['results']
        # The FIRST `cap` ids are answered; the ones past it are not asked for.
        assert len(results) == cap, f'{len(results)} sessions came back for a cap of {cap}'
        for i in range(cap):
            assert results[f'cap-{i}']['totalInputTokens'] == 10 + i
        for i in range(cap, cap + 50):
            assert f'cap-{i}' not in results, f'id past the cap was queried: cap-{i}'

    def test_the_cap_still_costs_one_query(self, brain, usage_queries):
        from app.services.memory_store import rest

        cap = rest.MAX_USAGE_BATCH_IDS
        _seed_many(cap)
        usage_queries.clear()
        usage_api.get_sessions_usage(ids=','.join(f'cap-{i}' for i in range(cap)))
        statements = [sql for sql in usage_queries if 'usage_events' in sql]
        assert len(statements) == 1, f'the capped batch ran {len(statements)} queries'

    def test_the_route_parses_commas_and_refuses_an_overlong_list(self, brain):
        """The validation the direct calls bypass. `get_sessions_usage(ids=…)`
        in a test hands the function a plain string; only the route exercises
        `Query(max_length=8000)` and the real comma split, so an overlong list
        — which used to be a 422 nobody had proven, or a giant `IN (...)` —
        and the whitespace/empty-field parsing are checked at the door the
        sidebar actually calls."""
        from app.main import app
        from fastapi.testclient import TestClient

        client = TestClient(app)
        _seed()
        r = client.get('/api/usage/sessions', params={'ids': 'sid-a, sid-a , ,sid-a'})
        assert r.status_code == 200, r.text
        assert set(r.json()['results']) == {'sid-a'}
        assert r.json()['results']['sid-a']['totalInputTokens'] == 1000

        too_long = ','.join(f'sid-{i}' for i in range(1200))  # >8000 chars
        assert len(too_long) > 8000
        refused = client.get('/api/usage/sessions', params={'ids': too_long})
        assert refused.status_code == 422, refused.text

        missing = client.get('/api/usage/sessions', params={'ids': 'never-existed'})
        assert missing.status_code == 200 and missing.json()['results'] == {}

    def test_both_doors_read_the_same_rows_however_usage_was_recorded(self, brain):
        """`get_usage` resolves the session SoT id and the batch did not, which
        looks like a divergence — it is only one if the resolver can answer
        with a DIFFERENT id than it was given. It cannot: it returns the row it
        found by that exact id, else the id unchanged. Pin that, because the
        moment the resolver grows a real alias, the batch door silently shows
        no delta and this test is the thing that says so."""
        from app.services.memory_store import get_usage, record_usage, resolve_sot_session_id

        _seed()
        assert resolve_sot_session_id('sid-a') == 'sid-a'
        assert resolve_sot_session_id('a-provisional-frontend-id') == 'a-provisional-frontend-id'

        # A usage row recorded against a provisional id (no `sessions` row) is
        # readable by that id through BOTH doors, with the same numbers.
        record_usage('prov-9', 'gpt-4o', inputTokens=5, outputTokens=7)
        batch = usage_api.get_sessions_usage(ids='prov-9')['results']['prov-9']
        single = get_usage('prov-9')
        for field in ('totalInputTokens', 'totalOutputTokens', 'totalEvents'):
            assert batch[field] == single[field], f'{field}: {batch[field]} vs {single[field]}'
        assert batch['sessionId'] == 'prov-9'

    def test_the_batch_and_the_single_session_agree(self, brain):
        """Two doors onto the same numbers must not drift: the sidebar row and
        the composer chip show the same chat's usage side by side."""
        _seed()
        from app.services.memory_store import get_usage

        batch = usage_api.get_sessions_usage(ids='sid-b')['results']['sid-b']
        single = get_usage('sid-b')
        assert batch['totalInputTokens'] == single['totalInputTokens']
        assert batch['totalOutputTokens'] == single['totalOutputTokens']