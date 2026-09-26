"""The always-on profile lane (facts store, kind='profile') + budget honesty.

Why this exists: BM25 recall is keyword-gated, so a durable fact about *who
the user is* only surfaced when the current message happened to share words
with it — the reported "August does not actually remember me". ``profile``
facts now ride a dedicated lane that needs no query at all, and any fact the
block budget forces out is NAMED instead of vanishing.

Every test here pins a contract:
  1. a profile fact is recalled with ZERO lexical overlap with the message
  2. a non-profile fact still requires a match (the lane is not a firehose)
  3. the lane cannot starve the BM25 lane
  4. the lane is byte-bounded and every dropped fact is named
  5. ``build_memory_block`` renders the lane once, not twice
  6. a corpus with no profile kinds renders byte-identically to before
  7. the lane reuses the existing scope union / visibility / ordering rules on
     the one facts store — no second resolver, no second budget
"""

from __future__ import annotations

import re

import pytest
from app.services import memory_store
from app.services.memory_conn import conn as _conn
from app.services.memory_store.fact_retrieval import (
    _BLOCK_CHAR_CAP,
    _PROFILE_CHAR_CAP,
    build_memory_block,
    build_profile_block,
    invalidate_fact_index,
)
from app.services.memory_store.rest import _FACT_KINDS

# The message and the profile fact below are hand-checked to share no token of
# length > 1 (what _tokenize keeps), so a hit can only come from the lane.
_PROFILE_KEY = 'profile:identity'
_PROFILE_TITLE = 'Who the user is'
_PROFILE_BODY = 'The user is a Korean backend engineer based in Seoul.'
_MESSAGE = 'why did my database connection pool exhaust during tonights deploy'
_LANE_HEADER = 'profile (always included, not keyword-matched):'


@pytest.fixture(autouse=True)
def _isolated_facts():
    """Own the facts table for each test.

    Every case here counts rows and spends a character budget against the whole
    profile lane, so a `profile` fact left behind by another test file sharing
    the same brain database changes how many of its own twelve fit — and the
    named-plus-counted arithmetic stops describing the code. It held while the
    suite ran serially in one process; under xdist the file lands on whichever
    worker, next to whichever neighbours.
    """
    _conn().execute('DELETE FROM facts')
    _conn().commit()
    invalidate_fact_index()
    yield
    _conn().execute('DELETE FROM facts')
    _conn().commit()
    invalidate_fact_index()


def _save(
    key: str,
    body: str,
    title: str,
    kind: str = 'fact',
    scope: str = 'global',
    expires_at: str | None = None,
) -> None:
    memory_store.save_fact(
        key, {'fact': body}, title=title, kind=kind, scope=scope, expires_at=expires_at
    )


def _profile(key: str, body: str, title: str, **kwargs: str) -> None:
    _save(key, body, title, kind=memory_store.PROFILE_FACT_KIND, **kwargs)  # type: ignore[arg-type]


def _age(key: str, seconds: int) -> None:
    """Push a fact's ``updated_at`` into the past (datetime('now') is only
    second-resolution, so recency ordering is otherwise a coin flip)."""
    _conn().execute(
        "UPDATE facts SET updated_at = datetime('now', ?) WHERE fact_key = ?",
        (f'-{int(seconds)} seconds', key),
    )
    _conn().commit()
    invalidate_fact_index()


def _bullet_lines(block: str) -> list[str]:
    return [line for line in block.splitlines() if line.startswith('- ')]


# ── 1 + 2: the lane is not keyword-gated; the BM25 lane still is ────────────


def test_profile_fact_recalled_with_zero_lexical_overlap():
    from app.services.tools.retrieval import _tokenize

    _profile(_PROFILE_KEY, _PROFILE_BODY, _PROFILE_TITLE)
    _save('ops:unrelated', 'Quarterly board deck template lives in drive.', 'Deck note')
    overlap = set(_tokenize(_MESSAGE)) & set(
        _tokenize(f'{_PROFILE_TITLE} {_PROFILE_BODY} {_PROFILE_KEY}')
    )
    assert overlap == set(), f'test corpus is not overlap-free: {sorted(overlap)}'

    block, injected = build_memory_block(_MESSAGE)
    assert _PROFILE_TITLE in block, 'profile fact must be recalled without any keyword match'
    assert (_PROFILE_KEY, _PROFILE_TITLE) in injected
    # An unrelated non-profile fact is NOT dragged in by the lane.
    assert 'Deck note' not in block


def test_non_profile_fact_still_requires_a_match():
    _save('clone:identity', _PROFILE_BODY, _PROFILE_TITLE)  # same text, kind='fact'
    block, injected = build_memory_block(_MESSAGE)
    assert block == '' and injected == [], 'a non-profile fact must not ride the always-on lane'
    # ...and it does come back once the message actually matches it.
    hit, hitInjected = build_memory_block('who is the korean backend engineer')
    assert _PROFILE_TITLE in hit
    assert ('clone:identity', _PROFILE_TITLE) in hitInjected


def test_profile_lane_survives_a_query_too_short_for_bm25():
    """The keyword lane has a minimum-query gate; the profile lane has none."""
    _profile(_PROFILE_KEY, _PROFILE_BODY, _PROFILE_TITLE)
    block, injected = build_memory_block('hi')
    assert _PROFILE_TITLE in block
    assert injected == [(_PROFILE_KEY, _PROFILE_TITLE)]


# ── 3: the lane cannot starve BM25 ─────────────────────────────────────────


def test_big_profile_set_still_leaves_bm25_content():
    for i in range(23):
        _profile(
            f'profile:note{i}',
            f'Long standing identity note number {i} about the user.',
            f'Identity note {i}',
        )
    _save('db:vim', 'User edits config files in vim with a neovim init.', 'Vim setup')
    block, injected = build_memory_block('how do I open my vim config file', k=5)

    lane = build_profile_block()[0]
    assert lane, 'the lane must be carrying the big profile set'
    assert 'Vim setup' in block, 'the BM25 lane must still ship next to a full profile lane'
    assert block.index(_LANE_HEADER) < block.index('- Vim setup'), 'the lane renders first'
    # Starvation is structural, not luck: the lane budget is a small slice of
    # the block cap, so keyword recall always keeps the rest.
    assert len(lane) <= _PROFILE_CHAR_CAP < _BLOCK_CHAR_CAP / 2
    assert ('db:vim', 'Vim setup') in injected


# ── 4: byte bound + named drops ────────────────────────────────────────────


def test_profile_lane_is_byte_bounded_and_names_every_drop():
    # A budget that can carry the header, a couple of lines and the whole
    # receipt: every omitted fact must be named by title, with no "(+N more)"
    # escape hatch.
    for i in range(1, 5):
        _profile(
            f'profile:s{i}', f'Standing profile note number {i} about the user.', f'Profile note {i}'
        )
    budget = 300
    lane, rows = build_profile_block(budget_chars=budget)
    assert len(lane) <= budget, f'lane overflowed its own budget: {len(lane)} > {budget}'
    included = [str(r['key']) for r in rows]
    assert included and len(included) < 4, 'the budget must actually bite for this to mean anything'
    assert '(+' not in lane, 'a short drop list must be named in full'
    for i in range(1, 5):
        if f'profile:s{i}' not in included:
            assert f'Profile note {i}' in lane, f'omitted profile:s{i} was not named'
    assert f'{4 - len(included)} omitted for budget' in lane


def test_a_big_drop_list_is_counted_as_well_as_named_never_vanished():
    for i in range(12):
        _profile(
            f'profile:n{i}',
            f'Profile detail {i} describing the person reading this right now.',
            f'Profile detail {i}',
        )
    budget = 240
    lane, rows = build_profile_block(budget_chars=budget)
    assert len(lane) <= budget
    included = {str(r['key']) for r in rows}
    assert 0 < len(included) < 12
    receipt = next(line for line in lane.splitlines() if 'omitted for budget' in line)
    total = 12 - len(included)
    assert f'profile lane partial: {total} omitted for budget' in receipt
    # Read the named titles back out of the receipt rather than testing for
    # each one with `in`. They are `; `-joined, and `Profile detail 1` is a
    # substring of `Profile detail 10` — so a substring count reported one more
    # name than the lane actually showed whenever the ranking happened to name
    # a teens.
    counted_m = re.search(r'\(\+(\d+) more\)', receipt)
    counted = int(counted_m.group(1)) if counted_m else 0
    _, _, shown = receipt.partition('omitted for budget:')
    assert shown != receipt, f'receipt has no named-title section: {receipt!r}'
    if counted_m:
        shown = shown[: shown.find(counted_m.group(0))]
    named_titles = [t.strip() for t in shown.split(';') if t.strip()]
    assert len(named_titles) + counted == total, (
        f'{len(named_titles)} named + {counted} counted != {total} dropped: {receipt!r}'
    )
    dropped_titles = {f'Profile detail {i}' for i in range(12) if f'profile:n{i}' not in included}
    assert set(named_titles) <= dropped_titles, (
        f'receipt named a fact that was included: {set(named_titles) - dropped_titles}'
    )


def test_hostile_lane_budget_reports_drops_instead_of_omitting_silently():
    """A budget too small to pay for header + lines + receipt buys honesty
    first: a dropped profile fact is still named, because a silently missing
    one is the failure this whole lane exists to fix."""
    _profile('profile:a', 'A long profile note describing who the user is in some detail.', 'Profile note A')
    _profile('profile:b', 'Another long profile note about the same person and their habits.', 'Profile note B')
    lane, rows = build_profile_block(budget_chars=40)
    assert len(rows) < 2
    assert 'Profile note B' in lane and 'omitted for budget' in lane


def test_bm25_drops_are_named_in_the_block():
    for i in range(18):
        _save(
            f'vim:n{i}',
            f'Very long vim configuration note {i} about mappings, plugins and init files. ' * 2,
            f'Vim note {i:02d}',
        )
    block, injected = build_memory_block('vim configuration init mappings', k=18)
    assert 'recall partial:' in block, 'an over-budget recall must say so'
    assert 0 < len(injected) < 18
    assert 'Vim note 00' in block
    tail = next(line for line in block.splitlines() if line.startswith('recall partial:'))
    named = int(tail.split(':')[1].strip().split()[0])
    assert named == 18 - len(injected), 'the receipt must count exactly what it dropped'


def test_receipt_is_bounded_and_the_cap_is_unchanged():
    for i in range(40):
        _save(
            f'vim:x{i}',
            'Vim configuration init file note with a deliberately long body. ' * 3,
            f'Vim overflow note {i:02d}',
        )
    block, injected = build_memory_block('vim configuration init file', k=40)
    assert '(+' in block, 'a huge drop list must be truncated, not open-ended'
    assert len('\n'.join(_bullet_lines(block))) <= _BLOCK_CHAR_CAP
    assert injected, 'the strongest match always ships'
    assert _PROFILE_CHAR_CAP == 600 and _BLOCK_CHAR_CAP == 1600, 'the 1600 cap did not move'


# ── 5: the lane renders once, not twice ────────────────────────────────────


def test_profile_fact_matching_the_query_is_rendered_exactly_once():
    _profile('profile:stack', 'The user is a Korean backend engineer in Seoul.', 'Backend engineer')
    block, injected = build_memory_block('which backend engineer roles exist in Seoul')
    assert block.count('- Backend engineer:') == 1, 'lane + BM25 must not duplicate a fact'
    assert injected.count(('profile:stack', 'Backend engineer')) == 1
    assert block.count(_LANE_HEADER) == 1
    assert block.count('index: [') == 1
    indexLine = next(line for line in block.splitlines() if line.startswith('index:'))
    assert indexLine.count('profile:stack') == 1


def test_lane_rows_reach_the_recalled_payload_once():
    _profile('profile:lang', 'The user writes Go and Rust for a living.', 'Working languages')
    recalled: list[dict[str, object]] = []
    block, injected = build_memory_block('weather in Geneva', recalled=recalled)
    assert 'Working languages' in block
    assert [r['key'] for r in recalled] == ['profile:lang']
    assert injected == [('profile:lang', 'Working languages')]
    # Same four keys the keyword lane has always emitted — no new UI contract.
    assert set(recalled[0]) == {'key', 'category', 'snippet', 'scope'}


# ── 6: legacy behaviour is untouched for a corpus with no profile kinds ─────


def test_block_is_byte_identical_to_legacy_for_a_non_profile_corpus():
    _save('user:editor', 'User edits in Vim with Neovim config', 'Editor setup')
    _save('user:dog', 'The family dog is named Biscuit', 'Dog name')
    block, injected = build_memory_block('How do I open my vim config file?')
    assert block == '\n'.join(
        [
            '<memory>',
            'index: [user:editor]',
            '- Editor setup: User edits in Vim with Neovim config',
            'These are stored facts relevant to this message; cite them, update one by passing its key '
            'to remember, or remove a stale one with forget.',
            '</memory>',
        ]
    )
    assert injected == [('user:editor', 'Editor setup')]
    assert build_profile_block() == ('', [])


def test_empty_store_yields_no_lane_and_no_block():
    assert build_profile_block() == ('', [])
    assert build_memory_block('anything at all here') == ('', [])


# ── 7: one store, one scope rule, one visibility rule ──────────────────────


def test_lane_honors_the_existing_scope_union():
    _profile('profile:mine', 'The user prefers terse answers.', 'Terse answers', scope='bot:alpha')
    _profile('profile:rival', 'The user prefers verbose answers.', 'Verbose answers', scope='bot:beta')
    _profile('profile:shared', 'The user is based in Seoul.', 'Home city')

    laneAlpha, rowsAlpha = build_profile_block(scope='bot:alpha')
    assert 'Terse answers' in laneAlpha and 'Home city' in laneAlpha
    assert 'Verbose answers' not in laneAlpha, 'never another bot private note'
    assert {str(r['scope']) for r in rowsAlpha} == {'global', 'bot:alpha'}

    laneGlobal, _ = build_profile_block(scope='global')
    assert 'Home city' in laneGlobal
    assert 'Terse answers' not in laneGlobal


def test_lane_skips_expired_and_superseded_profile_facts():
    _profile('profile:live', 'The user works night hours.', 'Night hours')
    _profile(
        'profile:dead',
        'The user works weekend hours.',
        'Weekend hours',
        expires_at='2020-01-01T00:00:00',
    )
    _profile('profile:gone', 'The user works only at weekends.', 'Weekend only')
    _conn().execute("UPDATE facts SET status = 'superseded' WHERE fact_key = 'profile:gone'")
    _conn().commit()
    invalidate_fact_index()
    lane, rows = build_profile_block()
    assert 'Night hours' in lane
    assert 'Weekend hours' not in lane and 'Weekend only' not in lane
    assert [str(r['key']) for r in rows] == ['profile:live']


def test_lane_orders_by_the_existing_recency_then_usage_signals():
    _profile('profile:old', 'The user has not quoted this note in a while.', 'Stale note')
    _profile('profile:new', 'The user has recently refreshed this other note.', 'Fresh note')
    _age('profile:old', 3600)
    lane, rows = build_profile_block()
    assert [str(r['key']) for r in rows] == ['profile:new', 'profile:old']
    # Usage is the SAME decayed boost keyword recall uses: 20 quotes outweigh
    # plain recency.
    memory_store.touch_fact_usage(['profile:old'] * 20)
    lane, rows = build_profile_block()
    assert [str(r['key']) for r in rows] == ['profile:old', 'profile:new']
    assert lane.index('Stale note') < lane.index('Fresh note')


def test_profile_kind_is_accepted_by_the_write_door():
    assert memory_store.PROFILE_FACT_KIND == 'profile'
    assert 'profile' in _FACT_KINDS
    _profile('profile:k', 'The user keeps a single durable memory store.', 'One store')
    row = memory_store.get_fact('profile:k')
    assert row is not None and row.get('kind') == 'profile'
    listed = [str(f.get('factKey')) for f in memory_store.list_facts(scope='global')]
    assert 'profile:k' in listed, 'no second store: the lane reads the same rows'
    lane, rows = build_profile_block()
    assert len(rows) == 1 and 'One store' in lane
