"""Part 18 P2.2 — compaction handoff format + verbatim user replay.

Two upgrades from the Zed pattern:
(a) the compaction summary renders a fixed handoff shape — Goal / State /
    Context / Next / Pitfalls — so the next agent can act without re-asking
    the user;
(b) after compaction the most recent verbatim USER messages are replayed on
    top of the summary under a byte budget (whole messages only), because
    the summary inevitably loses nuance the user already paid for. Tool
    results are never replayed and never cut from their call (the
    tool-pair-safe unit split already guarantees the wire shape).
"""

from __future__ import annotations

import pytest
from app.services.workbench import context_compressor as cc


def _userMsg(text: str) -> dict[str, object]:
    return {'role': 'user', 'content': text}


def _toolMsg(text: str) -> dict[str, object]:
    return {'role': 'tool', 'content': text}


def _assistantText(text: str) -> dict[str, object]:
    return {'role': 'assistant', 'content': text}


def _assistantToolUse(toolId: str = 'toolu_1', name: str = 'read_file') -> dict[str, object]:
    return {
        'role': 'assistant',
        'content': [{'type': 'tool_use', 'id': toolId, 'name': name, 'input': {'path': 'a.py'}}],
    }


class TestHandoffShape:
    def test_all_five_sections_present(self):
        out = cc.schemaSummarize([_userMsg('fix the login bug'), _assistantText('looking')], goalHint='Fix login')
        for section in ('## Goal', '## State', '## Context', '## Next', '## Pitfalls'):
            assert section in out, section
        # ledger tags stay (they are mechanics, not handoff prose)
        assert '<read-files>' in out and '<modified-files>' in out

    def test_state_carries_update_state(self):
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
        state = out[out.index('## State'):out.index('## Context')]
        assert 'explore' in state and 'draft' in state
        assert 'phase=implement step=2' in state
        assert 'no api key' in state

    def test_pitfalls_carries_latest_failure(self):
        msgs = [
            _userMsg('go'),
            _assistantText('let me run it'),
            _toolMsg('Error: command failed\nExit code: 1\nstack of truth'),
            _assistantText('retrying'),
        ]
        out = cc.schemaSummarize(msgs)
        pitfalls = out[out.index('## Pitfalls'):out.index('<read-files>')]
        assert 'Error: command failed' in pitfalls

    def test_context_carries_prior_summaries(self):
        prior = '## Goal\nold\n\n<read-files>\nz.py\n</read-files>\n\n<modified-files>\nw.py\n</modified-files>'
        out = cc.schemaSummarize([_userMsg('go')], priorSummaryTexts=[prior])
        context = out[out.index('## Context'):out.index('## Next')]
        assert 'Earlier context:' in context


class TestVerbatimUserReplay:
    @pytest.mark.asyncio
    async def test_recent_users_replayed_after_summary(self):
        msgs = [_userMsg('goal: ship it')]
        for i in range(12):
            msgs.append(_assistantText(f'work {i} ' + 'a' * 400))
            msgs.append(_userMsg(f'ask {i} ' + 'b' * 400))
        out = await cc.compressMessages(
            msgs,
            threshold=0,
            contextWindow=2000,
            retainRatio=0.16,
            schema=True,
            goalHint='ship it',
            replayUserBytes=8 * 1024,
        )
        summaries = [m for m in out if cc._isSummaryMessage(m)]
        assert len(summaries) == 1
        idx = out.index(summaries[0])
        # The summary text itself never repeats the replayed user texts.
        summaryText = cc._extractSummaryText(summaries[0])
        replayedUsers = [m for m in out[idx + 1:] if m.get('role') == 'user' and not cc._isToolResultMsg(m)]
        assert replayedUsers, 'expected verbatim user replays between summary and tail'
        originalTexts = {m['content'] for m in msgs if m.get('role') == 'user'}
        assert all(m['content'] in originalTexts for m in replayedUsers)
        assert not any(t in summaryText for t in originalTexts if t in {
            m['content'] for m in replayedUsers}), 'summary duplicated a replayed user turn'
        # The newest user turn survives verbatim in the output (replay or
        # the preserved tail) — the summary never has to re-explain it.
        outUserTexts = {m.get('content') for m in out if m.get('role') == 'user'}
        assert msgs[-1]['content'] in outUserTexts

    @pytest.mark.asyncio
    async def test_replay_whole_messages_only(self):
        """A unit that alone would overflow the budget is NOT cut — it is
        either replayed whole or (if it does not fit) never emitted as a
        partial fragment."""
        msgs = [_userMsg('start')]
        msgs.append(_assistantText('m ' + 'a' * 300))
        msgs.append(_userMsg('huge ' + 'u' * 5000))
        msgs.append(_assistantText('m ' + 'a' * 300))
        msgs.append(_userMsg('latest'))
        out = await cc.compressMessages(
            msgs, threshold=0, head_count=1, tail_count=1, replayUserBytes=1024
        )
        # No partial fragments anywhere: nothing starts like the huge turn
        # without being the whole turn.
        contents = [m.get('content', '') for m in out if m.get('role') == 'user']
        assert 'latest' in contents, 'the newest user turn must be replayed (fits the budget)'
        frags = [c for c in contents if c.startswith('huge ') and len(c) < 5005]
        assert not frags, f'partial-cut user message emitted: {frags[:1]}'
        # With room for both, everything is replayed whole.
        out2 = await cc.compressMessages(
            msgs, threshold=0, head_count=1, tail_count=1,
            replayUserBytes=8 * 1024,
        )
        assert 'huge ' + 'u' * 5000 in [m.get('content') for m in out2 if m.get('role') == 'user']

    @pytest.mark.asyncio
    async def test_replay_never_carries_tool_results(self):
        msgs = [_userMsg('start')]
        for i in range(10):
            msgs.append(_assistantToolUse(toolId=f'toolu_{i}'))
            msgs.append(_toolMsg(f'result {i} ' + 'r' * 300))
        # A question that ages out of the tail into the summarized middle —
        # it is exactly what the replay must preserve verbatim.
        msgs.append(_userMsg('the question that must not be lost'))
        for i in range(10, 14):
            msgs.append(_assistantToolUse(toolId=f'toolu_{i}'))
            msgs.append(_toolMsg(f'result {i} ' + 'r' * 300))
        out = await cc.compressMessages(
            msgs, threshold=0, contextWindow=1500, retainRatio=0.2, schema=True,
            replayUserBytes=16 * 1024,
        )
        idx = next(i for i, m in enumerate(out) if cc._isSummaryMessage(m))
        # The contiguous user-text run right after the summary is the replay;
        # it may contain ONLY user text — a tool result would mean the
        # replay orphaned a result from its call.
        after = out[idx + 1:]
        run: list[dict[str, object]] = []
        for m in after:
            if m.get('role') == 'user' and not cc._isToolResultMsg(m):
                run.append(m)
            else:
                break
        assert run, 'expected a replay run after the summary'
        assert all(cc._isSummaryMessage(m) is False for m in run)
        assert any('must not be lost' in str(m.get('content')) for m in run), (
            'the aged user question was lost instead of replayed'
        )
        # And no tool result ever appears BEFORE first replayed run ends —
        # trivially covered above: the run stops at the first non-user msg.

    def test_default_budget_within_8_16_kb(self):
        assert 8 * 1024 <= cc.REPLAY_USER_BUDGET_BYTES <= 16 * 1024
