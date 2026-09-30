"""Every compaction path runs the SAME policy (roadmap #6).

Pre-turn auto-compact, the budget ladder's middle rung and the reactive
overflow rescue all reduce context for the same session, so they must agree on
HOW — a rescue that summarizes differently is a second context policy wearing
the same name. They used to differ in three ways, none deliberate:

* the reactive path passed no ``replayUserBytes``, so the newest whole USER
  messages from the summarized middle were dropped — on the one path that runs
  *after* the model already overflowed, where the original ask is most likely
  to be sitting in that middle;
* it hardcoded ``schema=True`` where the budget path computed
  ``schema=summarizer is None``;
* it passed no summarizer, so a provider with the LLM compactor enabled still
  got the heuristic on the overflow path.

Plus the waste: both gates accepted ANY reduction, so a 1-token shave counted as
a successful rescue and the retry overflowed again — the turn paid a whole extra
request to learn nothing.
"""

from __future__ import annotations

import pytest


def _conversation(messages: int = 60, filler: int = 400) -> list[dict[str, object]]:
    out: list[dict[str, object]] = [
        {'role': 'system', 'content': 'you are a coding agent'},
        {'role': 'user', 'content': 'Here is the original ask, in full detail. ' * 8},
    ]
    for i in range(messages):
        out.append({'role': 'user', 'content': f'note {i} ' + ('x' * filler)})
        out.append({'role': 'assistant', 'content': f'reply {i} ' + ('y' * filler)})
    return out


class TestOneCompactionPolicy:
    @pytest.mark.asyncio
    async def test_both_paths_pass_identical_policy(self, monkeypatch):
        """The regression guard for the whole item: one policy, two call sites.

        Records the kwargs each path hands the compressor. They must match on
        every POLICY argument. `summarizer` is excluded from the comparison
        because the budget path may have the LLM compactor enabled and the
        reactive path cannot — but `schema` and `replayUserBytes` must agree,
        because those are consequences of the summarizer, not of the trigger.
        """
        from app.services.workbench import context_compressor as cc
        from app.services.workbench.loop import recovery as rec

        calls: list[dict[str, object]] = []

        async def _capture(*_a, **kw):
            calls.append(dict(kw))
            return list(_a[0]) if _a else []

        monkeypatch.setattr(cc, 'acquireCompactionLock', lambda s: True)
        monkeypatch.setattr(cc, 'releaseCompactionLock', lambda s: None)
        monkeypatch.setattr(cc, 'compressMessages', _capture)
        monkeypatch.setattr(cc, 'pruneToolOutputs', lambda m: list(m))
        monkeypatch.setattr(cc, 'REPLAY_USER_BUDGET_BYTES', 12 * 1024)
        monkeypatch.setattr(rec, 'REPLAY_USER_BUDGET_BYTES', 12 * 1024, raising=False)

        class _S:
            goal = ''
            messages: list = []
            messageCount = 0
            turnCount = 1

        msgs = _conversation()
        await rec._reactiveContextReduction(msgs, 200_000, _S())  # type: ignore[arg-type]
        await rec._budgetTriggeredCompaction(
            _S(), 'sess', msgs, contextWindow=200_000, emit=None,
            resolvedProvider=None, resolvedModel='m', currentTurn=1,
        )

        assert len(calls) == 2, f'expected one compressor call per path, got {len(calls)}'
        reactive, budget = calls
        for key in (
            'threshold', 'head_count', 'tail_count', 'pin_predicates',
            'contextWindow', 'goalHint', 'schema', 'replayUserBytes',
        ):
            assert reactive.get(key) == budget.get(key), (
                f'the two compaction paths disagree on {key!r}: '
                f"reactive={reactive.get(key)!r} budget={budget.get(key)!r}"
            )

    @pytest.mark.asyncio
    async def test_the_reactive_path_replays_the_users_own_words(self, monkeypatch):
        """The defect that mattered most, stated as an assertion."""
        from app.services.workbench import context_compressor as cc
        from app.services.workbench.loop import recovery as rec

        seen: dict[str, object] = {}

        async def _capture(*_a, **kw):
            seen.update(kw)
            return list(_a[0]) if _a else []

        monkeypatch.setattr(cc, 'acquireCompactionLock', lambda s: True)
        monkeypatch.setattr(cc, 'releaseCompactionLock', lambda s: None)
        monkeypatch.setattr(cc, 'compressMessages', _capture)
        monkeypatch.setattr(cc, 'pruneToolOutputs', lambda m: list(m))
        monkeypatch.setattr(rec, 'REPLAY_USER_BUDGET_BYTES', 12 * 1024, raising=False)

        class _S:
            goal = ''

        await rec._reactiveContextReduction(_conversation(), 200_000, _S())  # type: ignore[arg-type]
        assert seen.get('replayUserBytes', 0) > 0, (
            'the overflow path still drops the newest whole user messages from '
            'the summarized middle — the one path where the original ask is most '
            'likely to BE that middle'
        )


class TestMeaningfulReduction:
    def test_a_one_token_shave_is_not_a_rescue(self):
        from app.services.workbench.loop.recovery import _reductionIsWorthwhile

        assert not _reductionIsWorthwhile(100_000, 99_999), (
            'a 1-token reduction passed the gate, so the retry overflows again'
        )

    def test_a_real_reduction_is_accepted(self):
        from app.services.workbench.loop.recovery import _reductionIsWorthwhile

        assert _reductionIsWorthwhile(100_000, 60_000)

    def test_a_growth_is_never_a_reduction(self):
        from app.services.workbench.loop.recovery import _reductionIsWorthwhile

        assert not _reductionIsWorthwhile(10_000, 12_000)
        assert not _reductionIsWorthwhile(10_000, 10_000)

    def test_the_floor_scales_so_small_turns_are_not_blocked(self):
        """A turn at 5k tokens can never free 3k, and must not be asked to."""
        from app.services.workbench.loop.recovery import _reductionIsWorthwhile

        before = 5_000
        assert _reductionIsWorthwhile(before, before - 300)
        assert not _reductionIsWorthwhile(before, before - 10)


class TestThreshold:
    def test_a_known_window_uses_the_window_share(self):
        from app.services.workbench.loop.recovery import _compactionThreshold

        assert _compactionThreshold(90_000, 200_000) == 110_000

    def test_no_window_uses_the_floor_not_a_tautology(self):
        """The old reactive value was `before - 1`, which only ever said 'yes'."""
        from app.services.workbench.loop.recovery import _compactionThreshold

        before = 90_000
        assert _compactionThreshold(before, 0) == 4096
        assert _compactionThreshold(before, 0) < before - 1


class TestOneEventPerCompaction:
    @pytest.mark.asyncio
    async def test_budget_compaction_emits_exactly_one_frame(self, monkeypatch):
        """Regression: the trigger tag briefly made the ladder emit a second."""
        from app.services.workbench import context_compressor as cc
        from app.services.workbench.loop import recovery as rec

        events: list[dict] = []
        msgs = _conversation()

        async def _shrink(*_a, **_kw):
            return msgs[:6]

        monkeypatch.setattr(cc, 'acquireCompactionLock', lambda s: True)
        monkeypatch.setattr(cc, 'releaseCompactionLock', lambda s: None)
        monkeypatch.setattr(cc, 'compressMessages', _shrink)
        monkeypatch.setattr(cc, 'pruneToolOutputs', lambda m: list(m))

        class _S:
            goal = ''
            messages: list = []
            messageCount = 0
            turnCount = 1

        await rec._budgetTriggeredCompaction(
            _S(), 'sess', msgs, contextWindow=200_000, emit=events.append,
            resolvedProvider=None, resolvedModel='m', currentTurn=1,
        )
        frames = [e for e in events if e.get('type') == 'compaction']
        assert len(frames) == 1, f'one compaction published {len(frames)} frames: {frames}'
        assert frames[0]['trigger'] == 'budget', (
            'an untagged compaction frame is anonymous in the stream'
        )
