"""Stuck-request recovery — a chat the provider can never send again (DS Bot item 5).

Deep-diving ``Fei2411/DeepSeek-Bot`` (``ds-bot/src/host/parts.js``) surfaced a
failure class August detects but does not repair. Its rule, quoted from the
source:

    "A provider may turn down one request for reasons of its own; a history that
    breaks every request fails the next turn as well."

There, a second consecutive ``INVALID_REQUEST`` starts a fresh part carrying the
recent lines, and a part that still fails starts a BARE one that leaves even
those out.

August's half was already right and its half was the whole failure: a
deterministic 400 is never re-sent identically (``_DETERMINISTIC_400_MARKERS``
takes it out of the retry policy), but nothing repaired the surface — and
``session.messages`` is exactly what the next turn sends. So one orphaned
``tool_use_id`` surviving into persisted history bricks the chat: every turn
fails the same way, and only deleting the session escapes it.

These tests pin the repair ladder, and — as a control — that a SINGLE refusal
is still not treated as a stuck history.
"""

from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

import pytest
from app.services.workbench import workbench as wb

STUB_PROVIDER = {
    'name': 'stub',
    'apiMode': 'anthropicMessages',
    'default_model': 'stub-claude',
}

# A real Anthropic refusal shape, verbatim in its objection: the pairing broke,
# not the token budget.
_ORPHAN_400 = {
    'type': 'error',
    'status': 400,
    'error': {
        'type': 'invalid_request_error',
        'message': 'messages.3.content.0.tool_use_id: tools.0.custom tool_use id does not match',
    },
}


def _toolHistory(extra: int = 3) -> list[dict[str, object]]:
    """A persisted history that carries tool pairing — the poison's vehicle."""
    out: list[dict[str, object]] = [
        {'role': 'user', 'content': 'read the config and fix the port'},
        {
            'role': 'assistant',
            'content': [
                {'type': 'text', 'text': 'Reading it now.'},
                {
                    'type': 'tool_use',
                    'id': 'toolu_stale',
                    'name': 'read_file',
                    'input': {'path': 'config.json'},
                },
            ],
        },
        {'role': 'tool', 'tool_use_id': 'toolu_stale', 'content': 'port: 8080'},
    ]
    for i in range(extra):
        out.append({'role': 'user', 'content': f'and now? ({i})'})
        out.append({'role': 'assistant', 'content': f'looking ({i})'})
    return out


def _hasToolBlocks(messages: list[dict[str, object]]) -> bool:
    from app.services.workbench.loop.recovery import _hasToolStructure

    return _hasToolStructure(messages)


class StubClient:
    """Refuses the first request the way a strict gateway does, then answers.

    Records every body it is handed, so a test can assert on the surface the
    retry actually went out with rather than on an internal call.
    """

    def __init__(self, failTimes: int = 1) -> None:
        self.callCount = 0
        self.bodies: list[dict[str, object]] = []
        self.failTimes = failTimes

    def resolveApiKey(self) -> str:
        return 'stub-key'

    def bindCancel(self, event: asyncio.Event) -> None:  # pragma: no cover - parity
        pass

    async def messages_stream(self, body) -> AsyncIterator[dict[str, object]]:
        self.callCount += 1
        self.bodies.append(body)
        await asyncio.sleep(0)
        if self.callCount <= self.failTimes:
            yield dict(_ORPHAN_400)
            return
        yield {
            '_event_type': 'content_block_start',
            'content_block': {'type': 'text', 'text': ''},
        }
        yield {
            '_event_type': 'content_block_delta',
            'delta': {'type': 'text_delta', 'text': 'The port is 8080.'},
        }
        yield {'_event_type': 'content_block_stop'}
        yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 20, 'output_tokens': 6}}


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    from app.services import memory_store
    from app.services.workbench import sessions as sessions_mod

    memory_store.init()
    empty: dict = {}
    monkeypatch.setattr(sessions_mod, '_sessions', empty)
    monkeypatch.setattr(wb, '_sessions', empty)
    monkeypatch.setattr(
        asyncio, 'create_task', lambda coro, **kw: asyncio.ensure_future(coro)
    )
    monkeypatch.setattr(
        'app.services.workbench.providers.resolve_workbench_provider', lambda *a, **kw: STUB_PROVIDER
    )
    monkeypatch.setattr('app.services.workbench.providers.resolve_model', lambda p, hint='': 'stub-claude')
    monkeypatch.setattr(wb, 'buildSystemPrompt', lambda session, tools=None: 'stub system prompt')
    import app.providers.clients as clientsMod
    from app.services import provider_credentials as providerCredsMod

    monkeypatch.setattr(providerCredsMod, 'resolve', lambda name: {'api_key': 'stub-key'})
    holder: dict[str, object] = {}
    monkeypatch.setattr(clientsMod, 'getClient', lambda provider: holder['client'])
    monkeypatch.setattr('app.providers.clients.getClient', lambda provider: holder['client'])
    from app.services.tool_registrations import register_all

    register_all()
    yield holder


@pytest.fixture
def sessions(_isolate):
    from app.services.workbench import sessions as sessions_mod

    return sessions_mod._sessions


def _seedSession(sessions, sessionId: str, history: list[dict[str, object]]):
    from app.services.workbench.sessions import WorkbenchSession

    sess = WorkbenchSession(id=sessionId, model='stub-claude', provider='stub')
    sess.messages = list(history)
    sess.messageCount = len(history)
    sessions[sessionId] = sess
    return sess


def _recordRefusedTurn(sessionId: str, times: int = 1) -> None:
    from app.services.turn_outcomes import record_turn_outcome

    for _ in range(times):
        record_turn_outcome(
            model='stub-claude',
            provider='stub',
            task_type='agent',
            ok=False,
            error_class='bad_request',
            session_id=sessionId,
            end_reason='error',
        )


def _recoveryFrames(events: list[dict[str, object]]) -> list[dict[str, object]]:
    return [e for e in events if e.get('type') == 'recovery' and e.get('kind') == 'stuck-request']


class TestStreakIsReadOffTheLedger:
    """The strike count must come from `turn_outcomes`, not new state."""

    def test_nothing_recorded_is_not_stuck(self, isolatedData):
        from app.services.workbench.loop.recovery import _requestStuckStreak

        assert _requestStuckStreak('wb_absent') == 0

    def test_one_refused_turn_is_one(self, isolatedData):
        from app.services.workbench.loop.recovery import _requestStuckStreak

        _recordRefusedTurn('wb_a', 1)
        assert _requestStuckStreak('wb_a') == 1

    def test_a_clean_turn_between_them_breaks_the_run(self, isolatedData):
        """The point of the run, not the count.

        A rate limit or a success in between means the request's SHAPE was not
        what the provider objected to, so reducing the surface would fix nothing
        and cost the user context for nothing.
        """
        from app.services.turn_outcomes import record_turn_outcome
        from app.services.workbench.loop.recovery import _requestStuckStreak

        _recordRefusedTurn('wb_b', 1)
        record_turn_outcome(
            model='stub-claude',
            provider='stub',
            task_type='agent',
            ok=True,
            error_class='',
            session_id='wb_b',
            end_reason='finished',
        )
        _recordRefusedTurn('wb_b', 1)
        assert _requestStuckStreak('wb_b') == 1

    def test_a_different_failure_class_breaks_it_too(self, isolatedData):
        from app.services.turn_outcomes import record_turn_outcome
        from app.services.workbench.loop.recovery import _requestStuckStreak

        _recordRefusedTurn('wb_c', 1)
        record_turn_outcome(
            model='stub-claude',
            provider='stub',
            task_type='agent',
            ok=False,
            error_class='rate_limit',
            session_id='wb_c',
            end_reason='error',
        )
        assert _requestStuckStreak('wb_c') == 0

    def test_subagent_fanout_rows_do_not_break_or_count(self, isolatedData):
        """They share the table AND the session id, and never carry a class."""
        from app.services.turn_outcomes import record_turn_outcome
        from app.services.workbench.loop.recovery import _requestStuckStreak

        _recordRefusedTurn('wb_d', 1)
        record_turn_outcome(
            model='',
            provider='',
            task_type='subagent_fanout',
            ok=False,
            session_id='wb_d',
            end_reason='finished',
        )
        assert _requestStuckStreak('wb_d') == 1


class TestSurfaceLadder:
    def test_flattening_keeps_the_substance_and_drops_the_pairing(self):
        from app.services.workbench.loop.recovery import _flattenedRequestSurface

        flat = _flattenedRequestSurface(_toolHistory())
        assert flat is not None
        assert not _hasToolBlocks(flat), f'tool structure survived: {flat}'
        text = json.dumps(flat, default=str)
        assert 'port: 8080' in text, 'the tool RESULT was dropped, not flattened'
        assert 'read the config' in text, 'the conversation itself was dropped'
        assert 'Tools ARE' in text or 'plain text' in text, 'the note did not ride along'

    def test_a_history_with_no_tool_pairing_is_not_flattenable(self):
        """Otherwise strike one is a no-op that costs a retry."""
        from app.services.workbench.loop.recovery import _flattenedRequestSurface

        plain = [{'role': 'user', 'content': 'hi'}, {'role': 'assistant', 'content': 'hello'}]
        assert not _hasToolBlocks(plain)
        assert _flattenedRequestSurface(plain) is None

    def test_bare_keeps_only_the_newest_ask(self):
        from app.services.workbench.loop.recovery import _bareRequestSurface

        hist = _toolHistory()
        bare = _bareRequestSurface(hist)
        assert bare is not None
        assert len(bare) == 1
        assert bare[0]['role'] == 'user'
        assert 'and now? (2)' in json.dumps(bare, default=str)
        assert 'port: 8080' not in json.dumps(bare, default=str)


class TestEscalationIsBounded:
    def _session(self, sessionId: str, sessions):
        return _seedSession(sessions, sessionId, _toolHistory())

    def test_the_first_refusal_is_not_treated_as_a_stuck_history(self, sessions):
        """The reference rule, kept honest: one bad 400 may be the provider's day.

        Without this, a single gateway refusal would rewrite the user's
        transcript on suspicion alone.
        """
        from app.services.workbench.loop.recovery import _stuckRequestEscape

        sess = self._session('wb_e1', sessions)
        assert _stuckRequestEscape(sess, _toolHistory()) is None

    def test_second_refusal_flattens(self, sessions):
        from app.services.workbench.loop.recovery import _stuckRequestEscape

        _recordRefusedTurn('wb_e2', 1)
        sess = self._session('wb_e2', sessions)
        streak, strike, surface = _stuckRequestEscape(sess, _toolHistory())  # type: ignore[misc]
        assert (streak, strike) == (1, 'flattened')
        assert not _hasToolBlocks(surface)

    def test_third_refusal_goes_bare(self, sessions):
        from app.services.workbench.loop.recovery import _stuckRequestEscape

        _recordRefusedTurn('wb_e3', 2)
        sess = self._session('wb_e3', sessions)
        streak, strike, surface = _stuckRequestEscape(sess, _toolHistory())  # type: ignore[misc]
        assert (streak, strike) == (2, 'bare')
        assert len(surface) == 1

    def test_the_ladder_stops_rather_than_eating_the_transcript(self, sessions):
        """At three recorded refusals nothing fires — the escape gets one chance
        per rung and then the turn fails honestly instead of discarding more."""
        from app.services.workbench.loop.recovery import _stuckRequestEscape

        _recordRefusedTurn('wb_e4', 3)
        sess = self._session('wb_e4', sessions)
        assert _stuckRequestEscape(sess, _toolHistory()) is None

    def test_a_one_message_history_has_nothing_to_escape(self, sessions):
        from app.services.workbench.loop.recovery import _stuckRequestEscape

        _recordRefusedTurn('wb_e5', 2)
        sess = _seedSession(sessions, 'wb_e5', [{'role': 'user', 'content': 'hi'}])
        assert _stuckRequestEscape(sess, [{'role': 'user', 'content': 'hi'}]) is None

    def test_a_tool_less_history_escalates_straight_to_bare(self, sessions):
        """Strike one cannot help, so the turn must not be spent on it."""
        from app.services.workbench.loop.recovery import _stuckRequestEscape

        _recordRefusedTurn('wb_e6', 1)
        sess = self._session('wb_e6', sessions)
        plain = [
            {'role': 'user', 'content': 'one'},
            {'role': 'assistant', 'content': 'two'},
            {'role': 'user', 'content': 'three'},
            {'role': 'assistant', 'content': 'four'},
            {'role': 'user', 'content': 'five'},
        ]
        streak, strike, _ = _stuckRequestEscape(sess, plain)  # type: ignore[misc]
        assert (streak, strike) == (1, 'bare')


class TestInTheLoop:
    @pytest.mark.asyncio
    async def test_a_stuck_session_is_repaired_and_the_turn_finishes(self, sessions, _isolate):
        stub = StubClient(failTimes=1)
        _isolate['client'] = stub
        _recordRefusedTurn('wb_live1', 1)
        sess = _seedSession(sessions, 'wb_live1', _toolHistory())
        events: list[dict[str, object]] = []
        await asyncio.wait_for(
            wb.sendWorkbenchMessageStream(
                sessionId='wb_live1',
                message='what port is it on?',
                model='stub-claude',
                emit=events.append,
            ),
            timeout=60,
        )
        assert stub.callCount == 2, f'expected one refusal then one repair, got {stub.callCount}'
        frames = _recoveryFrames(events)
        assert frames, f'no stuck-request recovery frame in {[e.get("type") for e in events]}'
        assert frames[0]['outcome'] == 'flattened'
        # Degraded is the trust signal: the answer shipped on a reduced surface.
        assert frames[0]['degraded'] is True
        warnings = [e for e in events if e.get('type') == 'warning']
        assert any('refused' in str(e.get('message', '')).lower() for e in warnings), (
            'the user was never told their history was reshaped'
        )
        # The repair is asserted on the WIRE, not on an internal call: the retry's
        # message list must carry no tool pairing, and must still carry the
        # conversation. Scoped to `messages` because the request also declares
        # the tool array, whose JSON schemas are not what is under test.
        retryMsgs = json.dumps(stub.bodies[-1].get('messages'), default=str)
        assert 'tool_use_id' not in retryMsgs, 'the retried request still carried tool pairing'
        assert '"role": "tool"' not in retryMsgs, 'a tool-role message survived into the retry'
        assert 'port: 8080' in retryMsgs, 'the retry lost the very receipt it needed'
        end = [e for e in events if e.get('type') == 'turn_end']
        assert end and end[-1]['reason'] == 'finished', f'the repaired turn did not finish: {end}'
        # And the poison leaves the PERSISTED history, or the next turn replays
        # it — which is the entire failure this item exists for.
        assert not _hasToolBlocks(sess.messages), (
            'the flattened surface was not persisted, so the next turn re-sends it'
        )

    @pytest.mark.asyncio
    async def test_a_first_refusal_is_still_just_an_error(self, sessions, _isolate):
        """The control for the control: nothing reshapes a session on one 400."""
        stub = StubClient(failTimes=1)
        _isolate['client'] = stub
        _seedSession(sessions, 'wb_live2', _toolHistory())
        events: list[dict[str, object]] = []
        await asyncio.wait_for(
            wb.sendWorkbenchMessageStream(
                sessionId='wb_live2',
                message='what port is it on?',
                model='stub-claude',
                emit=events.append,
            ),
            timeout=60,
        )
        assert not _recoveryFrames(events), 'a single refusal was treated as a stuck history'
        assert [e for e in events if e.get('type') == 'error'], 'the refusal was swallowed'

    @pytest.mark.asyncio
    async def test_an_overflow_still_uses_the_overflow_ladder(self, sessions, _isolate):
        """The two ladders must not compete.

        ``classify_error`` matches context_overflow before bad_request, so a 400
        that says the prompt is too long keeps its token-shaped rescue. If this
        ever routes to the shape ladder, a session would lose history to a
        problem that compaction already solves.
        """
        from app.services.workbench.loop import recovery as rec

        assert rec._isShapeRefusal(
            {'error': '[400] prompt is too long: 120000 tokens', 'errorStatus': 400}
        ) is False
        assert rec._isContextOverflowError(
            {'error': '[400] prompt is too long: 120000 tokens', 'errorStatus': 400}
        ) is True
