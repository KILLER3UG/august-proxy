"""The range aggregates must report the cache split, not just billed tokens.

`usage_events` has carried `cache_hit_tokens` / `cache_miss_tokens` since
migration 044 and `record_usage` fills them on every event, but `/api/usage/stats`
and `/api/usage/by-model` summed only `input + output`. A session that re-read
60k cached tokens every turn therefore looked identical on the Usage page to one
that re-sent them — and nothing in the app could explain why a heavy week cost
almost nothing.

`totalTokens` deliberately stays BILLED tokens: folding cache reads in would
move every historical number on the page and double-count the prompt.
"""

from __future__ import annotations

import pytest
from app.routers import usage as usage_api


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


def _seed() -> None:
    from app.services.memory_store import record_usage

    # A warm session: 1k fresh input, 40k re-read from cache, 5k written.
    record_usage(
        'sess-warm', 'deepseek-v4', inputTokens=1000, outputTokens=500,
        contextTokens=46000, cacheHitTokens=40000, cacheMissTokens=5000,
    )
    # A cold one: no cache activity at all.
    record_usage('sess-cold', 'gpt-4o-mini', inputTokens=2000, outputTokens=800)


class TestStatsCacheSplit:
    def test_the_range_totals_carry_the_cache_columns(self, brain):
        _seed()
        stats = usage_api.get_usage_stats(range='30d')
        assert stats['totalTokens'] == 1000 + 500 + 2000 + 800
        assert stats['cacheHitTokens'] == 40000
        assert stats['cacheMissTokens'] == 5000
        # Cached reads are NOT folded into the billed total.
        assert stats['totalTokens'] < stats['cacheHitTokens']

    def test_hit_rate_is_the_share_of_cache_activity_not_of_all_tokens(self, brain):
        _seed()
        stats = usage_api.get_usage_stats(range='30d')
        assert stats['cacheHitRate'] == pytest.approx(0.889, abs=0.001)

    def test_a_range_with_no_cache_activity_reports_zero_not_a_crash(self, brain):
        from app.services.memory_store import record_usage

        record_usage('sess-x', 'gpt-4o-mini', inputTokens=10, outputTokens=5)
        stats = usage_api.get_usage_stats(range='7d')
        assert stats['cacheHitTokens'] == 0
        assert stats['cacheHitRate'] == 0.0

    def test_the_keys_match_the_session_endpoint_vocabulary(self, brain):
        """One vocabulary for the same two columns across both read paths —
        `get_usage` already named them cacheHitTokens/cacheMissTokens."""
        from app.services.memory_store import get_usage

        _seed()
        stats = usage_api.get_usage_stats(range='30d')
        session = get_usage('sess-warm')
        assert {'cacheHitTokens', 'cacheMissTokens', 'cacheHitRate'} <= set(stats)
        assert {'cacheHitTokens', 'cacheMissTokens', 'cacheHitRate'} <= set(session)


class TestByModelCacheSplit:
    def test_each_model_row_carries_its_own_cache_split(self, brain):
        _seed()
        rows = {r['model']: r for r in usage_api.get_usage_by_model(range='30d')['results']}
        assert rows['deepseek-v4']['cacheHitTokens'] == 40000
        assert rows['deepseek-v4']['cacheMissTokens'] == 5000
        assert rows['gpt-4o-mini']['cacheHitTokens'] == 0
