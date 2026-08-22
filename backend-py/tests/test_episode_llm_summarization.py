"""Episode summarization (#5): LLM narrative with mechanical fallback.

consolidate_conv_summaries(summarizer=...) must:
- call the summarizer with exactly the oldest merge-candidate parts,
- store its output as the episode content when it returns real prose,
- fall back to the '; '-join on None/''/exception (never fail on the LLM),
- keep importance 0.55 and the episode_<seq> keying intact.
"""

from __future__ import annotations

import asyncio

import pytest


@pytest.fixture(autouse=True)
def _no_md_export(monkeypatch):
    monkeypatch.setenv('AUGUST_MEMORY_MD_EXPORT', '0')


@pytest.fixture()
def brain_conn(brain_ready):
    """Fresh brain schema per test (shared conftest fixture)."""
    return brain_ready


def _seed(count: int):
    """Seed summaries with pairwise-distinct content (the 0.85 near-dup gate
    absorbs near-identical rows into one, which would break the threshold)."""
    from app.services.memory import auto_memory as am

    topics = [
        'docker compose deploys on staging',
        'pytest fixture refactor for the auth module',
        'the rate limiter for the login endpoint',
        'migrating the graph store to sqlite',
        'the review gate tool-round delta fix',
        'vector recall degradation warnings',
        'the pending skills approval queue',
        'heuristic promotion thresholds',
        'episode consolidation timing',
        'plan mode risk assessments',
        'daemon spawn contention caps',
        'skill quality scoring badges',
    ]
    for i in range(count):
        am.saveAutoMemory(
            f'conv_summary_wb_{i}',
            f'User asked: help with {topics[i % len(topics)]} (session wb_{i})',
            category='conversation',
            source='auto',
            importance=0.3,
        )


def _episode_contents():
    from app.services.memory import auto_memory as am
    from app.services.memory_store import _conn

    rows = _conn().execute(
        "SELECT key, content FROM auto_memories WHERE key LIKE 'episode_%' ORDER BY key"
    ).fetchall()
    return {r['key']: r['content'] for r in rows}


class TestLlmEpisodeSummarization:
    def test_summarizer_output_becomes_episode(self, brain_conn):
        """A working summarizer's prose replaces the raw join."""
        from app.services.memory import auto_memory as am

        _seed(8)

        async def fake_llm(parts):
            assert len(parts) == am._EPISODE_MERGE_COUNT
            return 'Across five sessions the user worked on deploys, test refactors, rate limiting and graph storage, leaving the login throttling question open.'

        n = am.consolidate_conv_summaries(summarizer=fake_llm)
        assert n == 5
        episodes = _episode_contents()
        body = next(iter(episodes.values()))
        assert 'rate limiting' in body, 'LLM narrative must win over join'
        assert '(session wb_' not in body, 'mechanical filler must be gone'

    def test_empty_summary_falls_back_to_join(self, brain_conn):
        from app.services.memory import auto_memory as am

        _seed(8)

        async def empty_llm(parts):
            return ''

        n = am.consolidate_conv_summaries(summarizer=empty_llm)
        assert n == 5
        body = next(iter(_episode_contents().values()))
        assert 'User asked: help with' in body, 'fallback must be the join'

    def test_raising_summarizer_falls_back(self, brain_conn):
        from app.services.memory import auto_memory as am

        _seed(8)

        async def broken_llm(parts):
            raise RuntimeError('provider down')

        n = am.consolidate_conv_summaries(summarizer=broken_llm)
        assert n == 5, 'LLM failure must never abort consolidation'
        body = next(iter(_episode_contents().values()))
        assert 'help with' in body

    def test_no_summarizer_keeps_legacy_behavior(self, brain_conn):
        from app.services.memory import auto_memory as am

        _seed(8)
        n = am.consolidate_conv_summaries()
        assert n == 5
        body = next(iter(_episode_contents().values()))
        assert '; ' in body

    def test_below_threshold_never_calls_summarizer(self, brain_conn):
        from app.services.memory import auto_memory as am

        _seed(4)
        calls: list[list[str]] = []

        async def spy(parts):
            calls.append(parts)
            return 'should not be reached'

        assert am.consolidate_conv_summaries(summarizer=spy) == 0
        assert calls == []

    def test_importance_and_key_unchanged(self, brain_conn):
        from app.services.memory import auto_memory as am
        from app.services.memory_store import _conn

        _seed(8)

        async def llm(parts):
            return 'A narrative paragraph long enough to pass the thirty-two character gate.'

        am.consolidate_conv_summaries(summarizer=llm)
        row = _conn().execute(
            "SELECT importance, category FROM auto_memories WHERE key LIKE 'episode_%'"
        ).fetchone()
        assert float(row['importance']) == 0.55
        assert row['category'] == 'conversation'


class TestWorkbenchWiring:
    def test_finalizer_builds_prompt_and_uses_review_client(self):
        """The end-of-session hook passes a prompt-based summarizer that routes
        through make_review_llm_client (the user's selected model)."""
        import inspect

        from app.services.workbench import workbench

        src = inspect.getsource(workbench)
        assert 'episode_summarization' in src
        assert '_summarizeEpisodeParts' in src
        # The prompt instructs compression and caps input size.
        assert 'max 120 words' in src or '120 words' in src
