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
            'contextWindow', 'goalHint', 'schema', 'replayUserBytes', 'rotate',
        ):
            assert reactive.get(key) == budget.get(key), (
                f'the two compaction paths disagree on {key!r}: '
                f"reactive={reactive.get(key)!r} budget={budget.get(key)!r}"
            )

    def test_exactly_one_site_builds_a_compaction_request(self):
        """`_compactionCall`'s docstring claims every path shares it. The pre-turn
        auto-compact did not — it passed the same arguments inline, and the parity
        test above could never see the divergence because it compared the two
        recovery paths against EACH OTHER, not against the third caller.

        So the gate is on the shape: one call site for `compressMessages` in the
        workbench package means no path can quietly own a second policy.
        """
        from pathlib import Path

        root = Path(__file__).resolve().parents[1] / 'app' / 'services' / 'workbench'
        sites: list[str] = []
        for py in sorted(root.rglob('*.py')):
            text = py.read_text(encoding='utf-8')
            for i, line in enumerate(text.splitlines(), 1):
                if 'compressMessages(' in line and 'def ' not in line:
                    sites.append(f'{py.relative_to(root).as_posix()}:{i}')
        assert sites, 'no compaction call site at all — the gate would pass on an empty census'
        assert len(sites) == 1, (
            f'compressMessages is called from {len(sites)} site(s): {sites} — every path '
            'must go through `_compactionCall` or a rescue becomes a second context '
            'policy wearing the same name'
        )
        assert sites[0].startswith('loop/recovery.py:'), sites

    def test_only_the_manual_path_may_use_the_count_budgeted_tail(self):
        """The census counts SITES; this reads ARGUMENTS, and the distinction paid.

        `context_window=0` is not "size unknown" downstream: `_compactionCall`
        turns it into `contextWindow=None`, which selects the count-budgeted tail.
        That is right for the "Free up memory" button and wrong for every automatic
        path — and I once "fixed" the button by giving it the real window, which
        measured 71 messages -> 71 messages and 0 tokens freed on a transcript below
        16% of a 128k window, i.e. the button silently stopped working.
        """
        from pathlib import Path

        root = Path(__file__).resolve().parents[1] / 'app' / 'services' / 'workbench'
        callLines: list[str] = []
        zeroWindow: list[str] = []
        forced: list[str] = []
        for py in sorted(root.rglob('*.py')):
            for i, line in enumerate(py.read_text(encoding='utf-8').splitlines(), 1):
                where = f'{py.relative_to(root).as_posix()}:{i}'
                if '_compactionCall(' in line and 'async def ' not in line:
                    callLines.append(where)
                if 'context_window=0' in line.replace(' ', ''):
                    zeroWindow.append(py.name)
                if 'thresholdOverride=0' in line.replace(' ', ''):
                    forced.append(py.name)
        assert len(callLines) >= 4, f'expected one call line per compaction path, got {callLines}'
        assert zeroWindow == ['sessions.py'], (
            f'the count-budgeted tail belongs to the manual button alone: {zeroWindow}'
        )
        assert forced == ['sessions.py'], (
            f'forcing and the count tail travel together: {forced}'
        )

    def test_the_subagent_compacts_with_its_own_models_window(self):
        """The mid-run subagent branch sits inside a function no test drives, so
        this pins the two arguments that decide its policy.

        A subagent defaults to a cheap 32k/64k model; hardcoding a window (an old
        110k threshold here) overflowed those windows before compaction could run.
        It must pass the RESOLVED window and must not force: forcing is the manual
        button's contract, not a subagent's.
        """
        from pathlib import Path

        src = (
            Path(__file__).resolve().parents[1] / 'app' / 'services' / 'workbench' / 'subagent.py'
        ).read_text(encoding='utf-8')
        i = src.index('_compactionCall(')
        block = src[i : i + 600]
        assert 'context_window=_contextWindow' in block, block[:200]
        assert 'thresholdOverride' not in block, 'a subagent must not force a compaction'
        assert 'summarizer=None' in block, block[:200]

    def test_the_auto_compact_archive_is_written_before_the_projection_prune(self):
        """The chat card says "The full transcript is archived". The pre-turn path
        archived AFTER `pruneToolOutputs`, so the snapshot held
        `[Old tool result content cleared]` where the old tool outputs had been,
        and compaction then persisted that reduced list — the content ended up in
        neither place.

        No test drives the pre-turn turn function, so this pins the ORDER in the
        source: the archive must not be handed the pruned variable.
        """
        from pathlib import Path

        src = (
            Path(__file__).resolve().parents[1] / 'app' / 'services' / 'workbench' / 'workbench.py'
        ).read_text(encoding='utf-8')
        lines = src.splitlines()
        archive = next((i for i, ln in enumerate(lines) if "reason='auto-compact')" in ln), None)
        assert archive is not None, 'the gate lost its target line'
        callLine = next(ln for ln in lines[archive - 8 : archive + 1] if 'archive_messages(' in ln)
        assert 'currentMessages' not in callLine, (
            f'the archive is handed the pruned projection: {callLine.strip()}'
        )
        assert 'unprunedMessages' in callLine, f'unknown archive argument: {callLine.strip()}'

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


class TestFrameReportsTheSplitItUsed:
    """A frame that reports the defaults instead of the result is a lie the card
    repeats: `tailCount: 6` was the compressor's default, while the tail is
    token-budgeted, so the card said "kept the first 4 and last 6" about a
    compaction that had kept far more verbatim."""

    def test_the_budget_frame_reports_the_real_tail_not_the_default(self, monkeypatch):
        import asyncio

        from app.services.workbench import context_compressor as cc
        from app.services.workbench.loop import recovery as rec

        events: list[dict] = []
        msgs: list[dict[str, object]] = [{'role': 'system', 'content': 'sys'}]
        for i in range(20):
            msgs.append({'role': 'user', 'content': f'note {i} ' + ('x' * 3000)})
            msgs.append({'role': 'assistant', 'content': f'reply {i} ' + ('y' * 3000)})

        class _S:
            goal = ''
            messages: list = list(msgs)
            messageCount = len(msgs)
            turnCount = 1

        monkeypatch.setattr(cc, 'acquireCompactionLock', lambda s: True)
        monkeypatch.setattr(cc, 'releaseCompactionLock', lambda s: None)

        asyncio.run(
            rec._budgetTriggeredCompaction(
                _S(), 'sess', msgs, contextWindow=40_000, emit=events.append,
                resolvedProvider=None, resolvedModel='m', currentTurn=1,
            )
        )

        frames = [e for e in events if e.get('type') == 'compaction']
        assert len(frames) == 1, f'expected one compaction frame, got {events}'
        f = frames[0]
        assert f['tailCount'] > 6, f'a token-budgeted tail reported the default: {f}'
        assert f['headCount'] == 4, f
        assert {'pinnedCount', 'replayedCount', 'relief'} <= set(f), sorted(f)
