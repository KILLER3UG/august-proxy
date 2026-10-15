"""Two context-relief routes: stack another summary, or re-anchor on a fresh note.

Compact-in-place keeps the first N messages verbatim FOREVER and summarizes what
comes after, so from the second relief onward the note is built from a follow-up
turn — the original ask sits outside the summarized span — and everything earlier
survives only as the prose the previous note squeezed out of itself. Rotating
drops the verbatim head, so the note describes the task again, and claims the
original ask back verbatim inside the replay budget that already exists.

Off by default: the route changes what the provider cache sees mid-chat, so an
absent brain key must mean today's behavior.
"""

from __future__ import annotations

import pytest
from app.services.workbench.context_compressor import (
    DEFAULT_HEAD_COUNT,
    RELIEF_COMPACT,
    RELIEF_ROTATE,
    buildSummaryMessage,
    compressMessages,
    reliefHeadCount,
    reliefStrategy,
)

ORIGINAL_ASK = 'ORIGINALASK migrate the billing service to the new ledger, keep idempotency.'
NOTE_TEXT = '## Goal\n(an old note)\n\n## State\n- Done: step one'


def _conversation(turns: int = 20, filler: int = 1200) -> list[dict[str, object]]:
    out: list[dict[str, object]] = [
        {'role': 'system', 'content': 'you are a coding agent'},
        {'role': 'user', 'content': ORIGINAL_ASK},
    ]
    for i in range(turns):
        out.append({'role': 'assistant', 'content': f'reply {i} ' + ('y' * filler)})
        out.append({'role': 'user', 'content': f'follow-up {i} ' + ('z' * filler)})
    return out


def _note() -> dict[str, object]:
    return buildSummaryMessage([{'role': 'user', 'content': 'x'}], NOTE_TEXT)


class TestStrategyIsStateNotModel:
    def test_disarmed_means_todays_route(self):
        msgs = _conversation() + [_note()]
        assert reliefStrategy(msgs, armed=False) == RELIEF_COMPACT

    def test_the_first_relief_never_rotates_even_when_armed(self):
        """Before a note exists the verbatim head IS the live task; folding it into
        a summary that says decisions were not analyzed trades a fact for a guess."""
        assert reliefStrategy(_conversation(), armed=True) == RELIEF_COMPACT

    def test_the_second_relief_rotates(self):
        msgs = _conversation() + [_note()]
        assert reliefStrategy(msgs, armed=True) == RELIEF_ROTATE

    def test_a_user_message_that_opens_with_the_marker_is_not_a_note(self):
        """The trigger reads the fenced shape, not the prefix, or a user pasting
        the marker text would silently re-route every later compaction."""
        msgs = _conversation()
        msgs.append({'role': 'user', 'content': '<<compressed_summary not a note'})
        assert reliefStrategy(msgs, armed=True) == RELIEF_COMPACT

    def test_the_head_count_map_is_total(self):
        assert reliefHeadCount(RELIEF_COMPACT) == DEFAULT_HEAD_COUNT
        assert reliefHeadCount(RELIEF_ROTATE) == 0


class TestArmingReachesTheLoop:
    """A key that Settings can write but the loop never reads is a dead switch.
    These go through `_compactionCall` — the one site every compaction path shares.
    """

    @pytest.mark.asyncio
    async def test_disarmed_stacks_even_after_a_note_exists(self, monkeypatch):
        from app.services.workbench.loop import recovery as rec

        monkeypatch.setattr(rec, '_contextRotateArmed', lambda: False)
        msgs = _conversation(turns=20, filler=1200) + [_note()]
        out, relief = await rec._compactionCall(
            msgs, context_window=4000, goalHint='billing ledger', summarizer=None
        )
        assert len(out) < len(msgs), 'nothing compacted, so this asserts nothing'
        assert relief == RELIEF_COMPACT
        assert any(m.get('content') == ORIGINAL_ASK for m in out), (
            'the compact route dropped the verbatim head it is supposed to keep'
        )

    @pytest.mark.asyncio
    async def test_armed_rotates_and_names_the_route(self, monkeypatch):
        from app.services.workbench.loop import recovery as rec

        monkeypatch.setattr(rec, '_contextRotateArmed', lambda: True)
        msgs = _conversation(turns=20, filler=1200) + [_note()]
        # No goalHint: a session with a recorded goal takes Goal from it, so the
        # route's effect on the note is only visible on the fallback path.
        out, relief = await rec._compactionCall(
            msgs, context_window=4000, goalHint='', summarizer=None
        )
        assert len(out) < len(msgs), 'nothing compacted, so this asserts nothing'
        assert relief == RELIEF_ROTATE
        notes = [m for m in out if str(m.get('content', '')).startswith('<<compressed_summary')]
        assert len(notes) == 1, 'rotating left more than one note in the projection'
        goal = str(notes[0]['content']).split('## Goal', 1)[1].split('##', 1)[0]
        assert 'ORIGINALASK' in goal
        assert any(m.get('content') == ORIGINAL_ASK for m in out), (
            'the note claims the ask but the projection no longer carries it verbatim'
        )

    def test_the_key_is_writable_and_read_back(self, isolatedData):
        """The three-door rule: a brain key needs boolKeys, a fieldTable entry and
        a runtime read — missing any one makes it unsettable, invisible, or dead."""
        from app.services import brain_config_service as bc

        assert 'contextReliefRotate' in bc.allowedKeys
        entry = next(e for e in bc.fieldTable if e[0] == 'contextReliefRotate')
        assert entry[2] is False, 'an armed-by-default relief route is not opt-in'

        assert bc.getRuntimeConfig().get('contextReliefRotate') is False, (
            'absent must read as off, not unset'
        )
        ok, err, _cfg = bc.saveBrainConfig({'contextReliefRotate': True})
        assert ok is True, f'Settings could not arm the route: {err}'
        assert bc.getRuntimeConfig().get('contextReliefRotate') is True


class TestRotateBehaviour:
    @pytest.mark.asyncio
    async def test_rotating_puts_the_original_ask_into_the_note(self):
        msgs = _conversation()
        out = await compressMessages(
            msgs,
            threshold=64,
            head_count=DEFAULT_HEAD_COUNT,
            contextWindow=4000,
            schema=True,
            rotate=True,
        )
        assert len(out) < len(msgs), 'nothing compacted, so this asserts nothing'
        note = next(m for m in out if str(m.get('content', '')).startswith('<<compressed_summary'))
        goal = str(note['content']).split('## Goal', 1)[1].split('##', 1)[0]
        assert 'ORIGINALASK' in goal, (
            'rotating still built Goal from a follow-up turn, so the head was '
            'never in the summarized span'
        )

    @pytest.mark.asyncio
    async def test_the_control_stacking_route_does_not(self):
        """The defect the route fixes, pinned on the route that still has it.

        With the head kept verbatim, the summarized middle begins after it, so the
        note's Goal names whatever the user said fifth.
        """
        msgs = _conversation()
        out = await compressMessages(
            msgs,
            threshold=64,
            head_count=DEFAULT_HEAD_COUNT,
            contextWindow=4000,
            schema=True,
        )
        assert len(out) < len(msgs), 'nothing compacted, so this asserts nothing'
        note = next(m for m in out if str(m.get('content', '')).startswith('<<compressed_summary'))
        goal = str(note['content']).split('## Goal', 1)[1].split('##', 1)[0]
        assert 'ORIGINALASK' not in goal

    @pytest.mark.asyncio
    async def test_the_original_ask_is_claimed_back_verbatim_and_first(self):
        out = await compressMessages(
            _conversation(),
            threshold=64,
            head_count=DEFAULT_HEAD_COUNT,
            contextWindow=4000,
            schema=True,
            replayUserBytes=4096,
            rotate=True,
        )
        verbatim = [m for m in out if m.get('content') == ORIGINAL_ASK]
        assert verbatim, 'the opening was neither kept nor replayed — it is gone'
        # Chronology: the ask predates every other replayed user turn.
        userIds = [i for i, m in enumerate(out) if m.get('role') == 'user' and not str(
            m.get('content', '')
        ).startswith('<<compressed_summary')]
        askIdx = out.index(verbatim[0])
        assert askIdx == min(userIds), 'the replayed opening landed out of order'

    @pytest.mark.asyncio
    async def test_the_opening_spends_budget_the_newest_turns_would_have_used(self):
        """The stated trade, measured: a budget that fits the ask alone replays
        nothing else, so the route cannot quietly grow the context.

        Count-budgeted with an empty tail and no pins, so a follow-up could only
        reach the output through the replay channel — otherwise the verbatim tail
        would show up as a false replay.
        """
        msgs = _conversation()
        askCost = len(ORIGINAL_ASK) + 40
        out = await compressMessages(
            msgs,
            threshold=64,
            head_count=DEFAULT_HEAD_COUNT,
            tail_count=0,
            contextWindow=None,
            schema=True,
            replayUserBytes=askCost,
            rotate=True,
        )
        assert len(out) < len(msgs), 'nothing compacted, so this asserts nothing'
        users = [str(m.get('content', '')) for m in out if m.get('role') == 'user']
        assert any(c == ORIGINAL_ASK for c in users), 'the opening was not claimed back'
        assert not [c for c in users if c.startswith('follow-up')], (
            'the replay budget was spent twice over, so rotating costs more context '
            'than stacking — the trade the docstring claims is not real'
        )

    @pytest.mark.asyncio
    async def test_rotating_never_orphans_a_tool_result_from_its_call(self):
        """Unit splitting has to survive a zero-length head or the rescue itself
        would 400 the next turn."""
        msgs = [
            {'role': 'system', 'content': 'sys'},
            {
                'role': 'assistant',
                'content': 'opening',
                'tool_calls': [{'id': 'c1', 'function': {'name': 'read_file', 'arguments': '{}'}}],
            },
            {'role': 'tool', 'tool_call_id': 'c1', 'content': 'file body ' + ('a' * 2000)},
        ]
        for i in range(10):
            msgs.append({'role': 'user', 'content': f'note {i} ' + ('b' * 400)})
            msgs.append({'role': 'assistant', 'content': f'reply {i} ' + ('c' * 400)})
        out = await compressMessages(
            msgs, threshold=64, head_count=DEFAULT_HEAD_COUNT, contextWindow=4000,
            schema=True, rotate=True,
        )
        for i, m in enumerate(out):
            if m.get('role') == 'tool':
                prev = out[i - 1]
                assert prev.get('role') in ('assistant', 'tool'), (
                    f'tool result at {i} follows {prev.get("role")}'
                )
                assert prev.get('tool_calls') or prev.get('role') == 'tool', (
                    f'tool result at {i} lost the call that produced it'
                )

    @pytest.mark.asyncio
    async def test_rotate_still_refuses_a_useless_reduction(self):
        """The size guard is route-independent: a relief that does not shrink is
        not a relief, and must return the transcript untouched."""
        msgs = [{'role': 'user', 'content': 'tiny'}, {'role': 'assistant', 'content': 'short'}]
        out = await compressMessages(msgs, threshold=1, schema=True, rotate=True)
        assert out == msgs
