"""Recall must not starve itself, and usage must be able to teach it (items 12, 14).

Two structural defects in the keyword recall lane, both silent.

**#12 — the profile lane ate the keyword lane's budget.** ``build_memory_block``
asked for ``k`` facts and then removed the always-in profile lane from the
RESULT. Every profile fact that happened to rank into the top k consumed a slot
and was then discarded, so the keyword lane received
``k - (profile facts in the top k)``. Profile facts are deliberately NOT
row-count capped (they are bounded by ``_PROFILE_CHAR_CAP``), so a user with a
rich profile set holds many of them, any of which can rank in on lexical
overlap. The richer the profile set grew, the thinner keyword recall became,
and nothing reported it: the budget was being spent on a lane that is injected
regardless.

**#14 — the usage boost could not reach anything BM25 had not already found.**
``if s <= 0: continue`` ran BEFORE the boost, so the boost could only reshuffle
an already-positive set. The entire never-matched part of the corpus was
structurally invisible to the one mechanism designed to learn from usage: a fact
the user is about to need is unreachable by "it has been useful before" if it
has never matched once, and a stale-but-once-hot fact decays out and can never
come back.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


def _save(key: str, body: str, title: str = '', *, kind: str = 'general', count: int = 0):
    from app.services import memory_store

    memory_store.save_fact(key, body, category='general', title=title or key, kind=kind)
    if count:
        from app.services.memory_conn import conn

        conn().execute('UPDATE facts SET use_count = ? WHERE fact_key = ?', (count, key))
        conn().commit()


def _bump_use(key: str, count: int, lastUsed: str = '') -> None:
    from app.services.memory_conn import conn

    conn().execute(
        'UPDATE facts SET use_count = ?, last_used_at = ? WHERE fact_key = ?',
        (count, lastUsed, key),
    )
    conn().commit()


class TestProfileLaneDoesNotStarveTheKeywordLane:
    def test_the_keyword_lane_keeps_its_full_k(self, brain):
        """The headline: k keyword facts, whatever the profile set contains.

        Note what the keyword lane is allowed to contain. Profile facts are
        bounded by ``_PROFILE_CHAR_CAP``, not by row count, so a large profile
        set is only PARTLY admitted to the always-in lane — and a profile fact
        that did not fit is not a duplicate, so it is legitimately eligible
        here. The invariant is "k non-duplicate facts", not "k facts of a
        particular kind".
        """
        from app.services.memory_store.fact_retrieval import (
            build_memory_block,
            build_profile_block,
            retrieve_relevant_facts,
        )

        for i in range(12):
            _save(f'kw.{i}', f'deployment pipeline note number {i} about servers', title=f'kw {i}')
        for i in range(12):
            _save(f'prof.{i}', f'deployment pipeline preference number {i}',
                  title=f'prof {i}', kind='profile')

        _lane, profileRows = build_profile_block(scope='global')
        laneKeys = {str(r.get('key') or '') for r in profileRows}
        assert len(laneKeys) > 1, 'the profile set must be big enough to starve the lane'

        facts = retrieve_relevant_facts(
            'deployment pipeline notes', k=5, exclude_keys=laneKeys
        )
        assert len(facts) == 5, (
            f'the keyword lane received {len(facts)} of 5 — profile facts '
            'consumed slots that were then discarded'
        )
        assert not (laneKeys & {str(f.get('key')) for f in facts}), (
            'a fact appears in both lanes'
        )

        recalled: list = []
        build_memory_block('deployment pipeline notes', recalled=recalled)
        assert len(recalled) > 5, 'the recalled list collapsed'

    def test_growing_the_profile_set_does_not_thin_keyword_recall(self, brain):
        """The self-reinforcing part: the decay was silent and monotonic.

        Counts the KEYWORD portion of the recalled list, not the list length.
        The pre-fix list was pinned at k+3 either way, because the profile rows
        filled it to k and left three — the number that shrinks is how many
        non-profile facts got in.
        """
        from app.services.memory_store.fact_retrieval import build_memory_block

        for i in range(20):
            _save(f'kw.{i}', f'release checklist item {i} for the pipeline', title=f'kw {i}')

        def keyword_count(nProfile: int) -> int:
            for j in range(nProfile):
                _save(f'p{j}.{i}', f'release checklist preference {j}', title=f'p{j}',
                      kind='profile')
            recalled: list = []
            build_memory_block('release checklist pipeline', recalled=recalled)
            return len([r for r in recalled if not str(r.get('key', '')).startswith('p')])

        small = keyword_count(0)
        large = keyword_count(15)
        assert large >= small, (
            f'adding 15 profile facts cut keyword recall from {small} to {large} rows'
        )

    def test_lane_facts_are_never_duplicated_into_the_keyword_lane(self, brain):
        """The other half of the original filter must survive the move.

        The profile lane legitimately reports ITS OWN rows in the recalled list,
        so the invariant is "no key appears twice", not "no profile key appears".
        """
        from app.services.memory_store.fact_retrieval import (
            build_memory_block,
            build_profile_block,
            retrieve_relevant_facts,
        )

        _save('shared.one', 'the same body used by both lanes', title='shared', kind='profile')
        _save('other.one', 'an unrelated plain fact about servers', title='other')

        _lane, profileRows = build_profile_block(scope='global')
        laneKeys = {str(r.get('key') or '') for r in profileRows}
        assert 'shared.one' in laneKeys

        facts = retrieve_relevant_facts('same body servers', k=5, exclude_keys=laneKeys)
        assert 'shared.one' not in {str(f.get('key')) for f in facts}, (
            'a fact already in the always-in lane came back through the keyword '
            'lane and would be rendered twice'
        )

        recalled: list = []
        build_memory_block('same body servers', recalled=recalled)
        keys = [str(r.get('key')) for r in recalled]
        assert len(keys) == len(set(keys)), f'a fact was recalled twice: {keys}'
        assert 'other.one' in keys

    def test_exclude_keys_is_accepted_by_the_retriever(self, brain):
        """The retriever is where the exclusion has to happen to be useful."""
        from app.services.memory_store.fact_retrieval import retrieve_relevant_facts

        _save('a.one', 'matching servers content here', title='a')
        _save('b.two', 'matching servers content here too', title='b')
        out = retrieve_relevant_facts('servers content', k=5, exclude_keys={'a.one'})
        assert all(str(r.get('key')) != 'a.one' for r in out)
        assert len(out) == 1, 'excluding a fact also shrank the window'

class TestUsageBoostCanTeachRecall:
    def test_a_used_fact_with_no_lexical_match_is_reachable(self, brain):
        """#14: the case the pre-fix code could not express at all."""
        from app.services.memory_store.fact_retrieval import retrieve_relevant_facts

        # Zero lexical overlap with the query, but used a lot.
        _save('hot.secret', 'the wifi passphrase is hunter2', title='hot')
        _bump_use('hot.secret', 20)
        out = retrieve_relevant_facts('quarterly budget forecast', k=5)
        assert any(str(r.get('key')) == 'hot.secret' for r in out), (
            'a fact the user has relied on 20 times is unreachable by usage, '
            'because the boost ran after the zero-lexical facts were discarded'
        )

    def test_a_never_used_fact_with_no_match_is_still_not_invented(self, brain):
        """The counterweight: the boost must not manufacture results."""
        from app.services.memory_store.fact_retrieval import retrieve_relevant_facts

        _save('cold.secret', 'the wifi passphrase is hunter2', title='cold')
        out = retrieve_relevant_facts('quarterly budget forecast', k=5)
        assert not any(str(r.get('key')) == 'cold.secret' for r in out)

    def test_a_strong_lexical_match_still_beats_usage_alone(self, brain):
        """Usage is a nudge, not an override — precision must not collapse."""
        from app.services.memory_store.fact_retrieval import retrieve_relevant_facts

        _save('exact.hit', 'quarterly budget forecast spreadsheet numbers', title='exact')
        _save('hot.elsewhere', 'unrelated note about printers', title='hot')
        _bump_use('hot.elsewhere', 20)
        out = retrieve_relevant_facts('quarterly budget forecast', k=1)
        assert str(out[0].get('key')) == 'exact.hit', (
            'a maxed-out usage boost displaced the only real lexical match'
        )

    def test_a_decayed_fact_loses_its_promotion(self, brain):
        """The decay has to still work, or stale facts become permanent."""
        from app.services.memory_store.fact_retrieval import retrieve_relevant_facts

        _save('stale.one', 'unrelated note about printers', title='stale')
        _bump_use('stale.one', 20, '2000-01-01 00:00:00')
        out = retrieve_relevant_facts('quarterly budget forecast', k=5)
        assert not any(str(r.get('key')) == 'stale.one' for r in out), (
            'a fact unused for decades still promotes itself off usage alone'
        )

    def test_the_hot_usage_query_covers_more_than_the_bm25_candidates(self, brain):
        """The query shape is the fix; a fact outside the top 200 must be visible."""
        from app.services.memory_store.fact_retrieval import _hot_usage

        for i in range(250):
            _save(f'bulk.{i}', f'filler fact {i} about nothing in particular', title=f'b{i}')
        _save('far.one', 'the wifi passphrase is hunter2', title='far')
        _bump_use('far.one', 5)

        hot = _hot_usage()
        assert 'far.one' in hot, (
            'the boost still cannot see a fact outside the BM25-strongest 200 — '
            'the 999-placeholder IN-list is the wrong query shape for this'
        )
