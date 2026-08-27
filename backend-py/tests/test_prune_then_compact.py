"""Prune-then-compact (plan §9.3 #2).

Tier (a) projection prune protects the newest 40k tokens of tool outputs and
rewrites older ones in a model-facing COPY (stage A shape: >8192 chars keep
head 4096 + tail 1024 with an elision marker; smaller ones are cleared).
Tier (b) compaction keeps a token-budgeted verbatim tail (retain 0.16 of the
window), summarizes the middle with a fixed markdown schema carrying the
file ledger forward, never orphans a tool result from its call, caps the
summary at 8192 tokens (split-and-merge above that), and guards itself with
TTL'd lock events.
"""

from __future__ import annotations

import pytest
from app.services.workbench import context_compressor as cc


def _toolMsg(text: str) -> dict[str, object]:
    return {'role': 'tool', 'content': text}


def _userMsg(text: str) -> dict[str, object]:
    return {'role': 'user', 'content': text}


def _assistantText(text: str) -> dict[str, object]:
    return {'role': 'assistant', 'content': text}


def _assistantToolUse(toolId: str = 'toolu_1', name: str = 'read_file') -> dict[str, object]:
    return {
        'role': 'assistant',
        'content': [{'type': 'tool_use', 'id': toolId, 'name': name, 'input': {'path': 'a.py'}}],
    }


class TestPruneToolOutputs:
    def testRecentOutputsProtected(self):
        msgs = [_userMsg('hi'), _toolMsg('x' * 5000), _assistantText('ok')]
        out = cc.pruneToolOutputs(msgs, protectTokens=10_000)
        assert out[1]['content'] == 'x' * 5000

    def testOldSmallOutputCleared(self):
        msgs = [_toolMsg('old small result'), _assistantText('mid'), _toolMsg('y' * 5000)]
        out = cc.pruneToolOutputs(msgs, protectTokens=100)
        assert out[0]['content'] == cc.CLEARED_MARKER
        # the newest result stays
        assert out[2]['content'] == 'y' * 5000

    def testOldLargeOutputKeepsHeadAndTail(self):
        big = ''.join(f'L{i:06d}\n' for i in range(3000))  # ~21 KB
        msgs = [_toolMsg(big), _assistantText('mid'), _toolMsg('z' * 5000)]
        out = cc.pruneToolOutputs(msgs, protectTokens=100)
        pruned = str(out[0]['content'])
        assert pruned.startswith('L000000')
        assert pruned.endswith(big[-cc.PRUNE_TAIL_CHARS:])
        assert cc.PRUNE_ELISION_MARKER in pruned
        assert 'characters cleared' in pruned
        assert len(pruned) < len(big)

    def testInputNotMutated(self):
        msgs = [_toolMsg('old small result'), _toolMsg('y' * 5000)]
        cc.pruneToolOutputs(msgs, protectTokens=100)
        assert msgs[0]['content'] == 'old small result'

    def testIdempotent(self):
        msgs = [_toolMsg('old small result'), _toolMsg('y' * 5000)]
        once = cc.pruneToolOutputs(msgs, protectTokens=100)
        twice = cc.pruneToolOutputs(once, protectTokens=100)
        assert [m['content'] for m in once] == [m['content'] for m in twice]

    def testUserToolResultBlocksPrunedPerBlock(self):
        msgs = [
            {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 't1', 'name': 'read_file', 'input': {}}]},
            {
                'role': 'user',
                'content': [
                    {'type': 'tool_result', 'tool_use_id': 't1', 'content': 'old result text'},
                ],
            },
            _toolMsg('newest ' + 'q' * 5000),
        ]
        out = cc.pruneToolOutputs(msgs, protectTokens=100)
        block = out[1]['content'][0]  # type: ignore[index]
        assert block['content'] == cc.CLEARED_MARKER
        # original untouched
        assert msgs[1]['content'][0]['content'] == 'old result text'  # type: ignore[index]

    def testNonToolMessagesUntouched(self):
        msgs = [_userMsg('a'), _assistantText('b'), _userMsg('c')]
        out = cc.pruneToolOutputs(msgs, protectTokens=1)
        assert [m['content'] for m in out] == ['a', 'b', 'c']


class TestSplitUnits:
    def testToolCallAndResultsAreOneUnit(self):
        msgs = [
            _userMsg('go'),
            _assistantToolUse(),
            _toolMsg('result one'),
            _toolMsg('result two'),
            _assistantText('done'),
        ]
        units = cc._splitUnits(msgs)
        assert len(units) == 3
        assert [m['role'] for m in units[1]] == ['assistant', 'tool', 'tool']

    def testPlainMessagesAreSingletonUnits(self):
        msgs = [_userMsg('a'), _assistantText('b')]
        units = cc._splitUnits(msgs)
        assert len(units) == 2


class TestSchemaSummarize:
    def testAllSectionsPresent(self):
        msgs = [_userMsg('fix the login bug'), _assistantText('looking')]
        out = cc.schemaSummarize(msgs, goalHint='Fix login')
        for section in (
            '## Goal',
            '## Constraints',
            '## Progress',
            '## Key Decisions',
            '## Next Steps',
            '## Critical Context',
            '<read-files>',
            '</read-files>',
            '<modified-files>',
            '</modified-files>',
        ):
            assert section in out
        assert 'Fix login' in out

    def testGoalFallsBackToFirstUserMessage(self):
        out = cc.schemaSummarize([_userMsg('refactor the parser'), _assistantText('k')])
        assert 'refactor the parser' in out

    def testProgressFromUpdateStateInputs(self):
        msgs = [
            _userMsg('go'),
            {
                'role': 'assistant',
                'content': [
                    {
                        'type': 'tool_use',
                        'id': 't1',
                        'name': 'update_state',
                        'input': {'phase': 'implement', 'step': 2, 'completed': 'explore\ndraft', 'blockers': 'no api key'},
                    }
                ],
            },
            _toolMsg('State updated: phase=implement, step=2'),
        ]
        out = cc.schemaSummarize(msgs)
        assert 'explore' in out and 'draft' in out
        assert 'phase=implement step=2' in out
        assert 'no api key' in out

    def testFileLedgerAndPromotion(self):
        msgs = [
            _userMsg('go'),
            {
                'role': 'assistant',
                'content': [
                    {'type': 'tool_use', 'id': 't1', 'name': 'read_file', 'input': {'path': 'a.py'}},
                    {'type': 'tool_use', 'id': 't2', 'name': 'read_file', 'input': {'path': 'b.py'}},
                    {'type': 'tool_use', 'id': 't3', 'name': 'write_file', 'input': {'path': 'a.py'}},
                ],
            },
        ]
        out = cc.schemaSummarize(msgs)
        read, modified = cc._parseLedgerTags(out)
        # a.py was read then modified → listed only under modified
        assert modified == ['a.py']
        assert read == ['b.py']

    def testLedgerCarriedForwardAcrossCompactions(self):
        prior = '## Goal\nold\n\n<read-files>\nz.py\n</read-files>\n\n<modified-files>\nw.py\n</modified-files>'
        msgs = [
            _userMsg('go'),
            {
                'role': 'assistant',
                'content': [
                    {'type': 'tool_use', 'id': 't1', 'name': 'read_file', 'input': {'path': 'new.py'}},
                ],
            },
        ]
        out = cc.schemaSummarize(msgs, priorSummaryTexts=[prior])
        read, modified = cc._parseLedgerTags(out)
        assert 'z.py' in read and 'new.py' in read
        assert modified == ['w.py']
        assert 'Earlier context:' in out  # prior prose carried in Critical Context

    def testSummaryCappedAtTokenBudget(self):
        msgs = [_userMsg('u' * 50000), _assistantText('a' * 50000)]
        out = cc.schemaSummarize(msgs, maxChars=4000)
        assert len(out) <= 4000 + len('\n[... summary truncated at the token cap]')


class TestCompressMessages:
    @pytest.mark.asyncio
    async def testCountModeBackCompat(self):
        msgs = [_userMsg('start')]
        for i in range(20):
            msgs.append(_userMsg(f'q{i} ' + 'x' * 800) if i % 2 else _assistantText(f'm{i} ' + 'y' * 800))
        out = await cc.compressMessages(msgs, threshold=0, head_count=4, tail_count=6)
        assert len(out) < len(msgs)
        summaries = [m for m in out if cc._isSummaryMessage(m)]
        assert len(summaries) == 1
        # head preserved
        assert out[0]['content'] == 'start'

    @pytest.mark.asyncio
    async def testTokenBudgetedTailAndSchema(self):
        msgs = [_userMsg('goal: ship it')]
        for i in range(30):
            msgs.append(_assistantText(f'work {i} ' + 'a' * 400))
            msgs.append(_userMsg(f'ask {i} ' + 'b' * 400))
        out = await cc.compressMessages(
            msgs, threshold=0, contextWindow=2000, retainRatio=0.16, schema=True, goalHint='ship it'
        )
        summaries = [m for m in out if cc._isSummaryMessage(m)]
        assert len(summaries) == 1
        summaryText = cc._extractSummaryText(summaries[0])
        assert '## Goal' in summaryText
        assert 'ship it' in summaryText
        # tail is verbatim: the last message survives word-for-word
        assert out[-1]['content'] == msgs[-1]['content']

    @pytest.mark.asyncio
    async def testTailNeverStartsWithOrphanedToolResult(self):
        msgs = [_userMsg('start')]
        for i in range(12):
            msgs.append(_assistantToolUse(toolId=f'toolu_{i}'))
            msgs.append(_toolMsg(f'result {i} ' + 'r' * 300))
        msgs.append(_userMsg('latest'))
        out = await cc.compressMessages(msgs, threshold=0, contextWindow=1500, retainRatio=0.2, schema=True)
        # find the tail start: first message after the summary
        idx = next(i for i, m in enumerate(out) if cc._isSummaryMessage(m))
        tail = out[idx + 1 :]
        if tail:
            first = tail[0]
            assert not cc._isToolResultMsg(first), 'tail starts with an orphaned tool result'

    @pytest.mark.asyncio
    async def testUnderThresholdUnchanged(self):
        msgs = [_userMsg('small'), _assistantText('fine')]
        out = await cc.compressMessages(msgs, threshold=10_000_000)
        assert out == msgs

    @pytest.mark.asyncio
    async def testUsageAggregatedIntoSummary(self):
        msgs = [_userMsg('start')]
        for i in range(12):
            m = _assistantText(f'm{i} ' + 'y' * 3000)
            m['usage'] = {'inputTokens': 100, 'outputTokens': 50}
            msgs.append(m)
        out = await cc.compressMessages(msgs, threshold=0)
        summaries = [m for m in out if cc._isSummaryMessage(m)]
        usage = summaries[0].get('usage')
        assert isinstance(usage, dict) and usage.get('compacted') is True
        assert usage.get('inputTokens', 0) >= 100


class TestCompactionLock:
    def _session(self):
        class S:
            id = 's1'

        return S()

    def testAcquireReleaseCycle(self):
        s = self._session()
        assert cc.acquireCompactionLock(s) is True
        assert cc.acquireCompactionLock(s) is False  # held
        cc.noteCompactionPhase(s, 'summary')
        cc.releaseCompactionLock(s)
        assert cc.acquireCompactionLock(s) is True

    def testOrphanedLockReacquiredAfterTtl(self):
        s = self._session()
        assert cc.acquireCompactionLock(s) is True
        # Simulate a mid-compaction crash: the lock is left far in the past.
        s._compaction_lock['startedAt'] -= cc.LOCK_TTL_S + 10  # type: ignore[operator]
        assert cc.acquireCompactionLock(s) is True
