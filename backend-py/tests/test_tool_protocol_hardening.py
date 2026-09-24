"""P0 tool-protocol hardening.

Two guarantees, tested at both the unit and the loop level:

  1. ONE normalization choke point. Every tool result is shaped by
     ``normalize_tool_result`` and the round is closed by
     ``reconcile_tool_results``, so a tool call always leaves with exactly
     one well-formed result: never zero (a dangling ``tool_use`` is a
     NON-retryable 400 that bricks the next turn), never two, never an
     orphan, never a null/empty content or an empty id.
  2. A replay-safety veto. A rescue that re-invokes the model with a
     CHANGED request (tools-fallback, context promotion, chain fallback,
     narration self-heal) is refused once the turn has already shown
     visible text or executed a tool — re-asking there is a duplicate
     answer or a double execution, not a recovery. The plain same-body
     transient retry stays allowed, so a normal turn still recovers.
"""

from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

import pytest
from app.services.workbench import workbench as wb
from app.services.workbench.tool_protocol import (
    SYNTHETIC_TOOL_RESULT_PREFIX,
    canonical_tool_calls,
    normalize_tool_result,
    reconcile_tool_results,
    synthetic_tool_result,
)

# ── 1a. the choke point itself ─────────────────────────────────────────


class TestNormalizeToolResult:
    def test_bare_string_keeps_content_and_gets_identity(self):
        out = normalize_tool_result('all good', tool_use_id='t1', tool_name='read_file')
        assert out == {
            'role': 'tool',
            'tool_use_id': 't1',
            'tool_call_id': 't1',
            'content': 'all good',
        }

    def test_null_content_becomes_a_synthetic_receipt(self):
        """A tool that returned None must not leave content=None —
        Anthropic rejects a null tool_result.content outright."""
        out = normalize_tool_result({'tool_use_id': 't1', 'content': None}, tool_name='run_command')
        assert isinstance(out['content'], str)
        assert out['content'].strip()
        assert SYNTHETIC_TOOL_RESULT_PREFIX in out['content']
        assert out['is_error'] is True

    def test_empty_string_content_is_still_a_receipt(self):
        out = normalize_tool_result({'tool_use_id': 't1', 'content': '   '}, tool_name='x')
        assert out['content'].strip(), 'an empty tool_result.content is rejected upstream'
        assert out['is_error'] is True

    def test_missing_id_is_minted_not_left_blank(self):
        out = normalize_tool_result({'content': 'x'})
        assert out['tool_use_id']
        assert out['tool_call_id'] == out['tool_use_id']

    def test_openai_shaped_id_is_accepted(self):
        out = normalize_tool_result({'tool_call_id': 'call_7', 'content': 'ok'})
        assert out['tool_use_id'] == 'call_7'

    def test_block_list_content_is_flattened_to_text(self):
        out = normalize_tool_result({'tool_use_id': 't1', 'content': [{'type': 'text', 'text': 'part one'}]})
        assert out['content'] == 'part one'

    def test_huge_non_text_payload_is_bounded(self):
        out = normalize_tool_result({'tool_use_id': 't1', 'content': {'k': 'v' * 50_000}})
        assert len(out['content']) < 50_000
        assert 'truncated' in out['content']

    def test_error_flag_survives(self):
        out = normalize_tool_result({'tool_use_id': 't1', 'content': 'boom', 'is_error': True})
        assert out['is_error'] is True


class TestReconcileToolResults:
    def test_missing_result_is_synthesized(self):
        closed = reconcile_tool_results([('t1', 'write_file')], [])
        assert len(closed.results) == 1
        assert closed.synthesized == ['t1']
        result = closed.results[0]
        assert result['tool_use_id'] == 't1'
        assert SYNTHETIC_TOOL_RESULT_PREFIX in str(result['content'])
        # The model must be able to tell "never ran" from "ran and failed".
        assert 'NOT executed' in str(result['content'])
        assert 'write_file' in str(result['content'])

    def test_exactly_one_per_call_in_call_order(self):
        calls = [('a', 'read_file'), ('b', 'run_command'), ('c', 'list_skills')]
        raw = [
            {'tool_use_id': 'b', 'content': 'b done'},
            {'tool_use_id': 'a', 'content': 'a done'},
        ]
        closed = reconcile_tool_results(calls, raw)
        assert [r['tool_use_id'] for r in closed.results] == ['a', 'b', 'c']
        assert closed.synthesized == ['c']
        assert closed.dropped == []

    def test_duplicate_result_collapses_to_one(self):
        closed = reconcile_tool_results(
            [('a', 'run_command')],
            [
                {'tool_use_id': 'a', 'content': 'first'},
                {'tool_use_id': 'a', 'content': 'second'},
            ],
        )
        assert len(closed.results) == 1
        assert closed.results[0]['content'] == 'first'

    def test_orphan_result_is_dropped(self):
        """A result whose id no call claims is the same fatal 400 as a
        missing one — it must never reach history."""
        closed = reconcile_tool_results(
            [('a', 'read_file')], [{'tool_use_id': 'a', 'content': 'ok'}, {'tool_use_id': 'zz', 'content': 'stale'}]
        )
        assert [r['tool_use_id'] for r in closed.results] == ['a']
        assert closed.dropped == ['zz']

    def test_every_exit_path_yields_a_well_formed_pair(self):
        closed = reconcile_tool_results(
            [('a', 'x'), ('b', 'y'), ('c', 'z')],
            [
                {'tool_use_id': 'a', 'content': 'ok'},
                None,
                {'tool_use_id': 'c'},
            ],
        )
        assert len(closed.results) == 3
        for result in closed.results:
            assert result['role'] == 'tool'
            assert result['tool_use_id']
            assert isinstance(result['content'], str)
            assert result['content'].strip()

    def test_no_calls_yields_no_results(self):
        closed = reconcile_tool_results([], [{'tool_use_id': 'a', 'content': 'x'}])
        assert closed.results == []
        assert closed.dropped == ['a']

    def test_synthetic_helper_is_well_formed(self):
        r = synthetic_tool_result('t9', 'run_command', 'stage died')
        assert r['role'] == 'tool'
        assert r['tool_use_id'] == 't9'
        assert 'stage died' in str(r['content'])


class TestCanonicalToolCalls:
    def test_missing_id_is_written_back_to_the_assistant_block(self):
        """An id-less tool_use cannot be referenced by any result, so the
        next request is malformed however well the tool ran."""
        calls = [{'type': 'tool_use', 'name': 'read_file', 'input': {}}]
        msg = {'role': 'assistant', 'content': [{'type': 'tool_use', 'name': 'read_file'}]}
        order = canonical_tool_calls(calls, msg, is_anthropic=True)
        assert len(order) == 1
        callId, name = order[0]
        assert callId
        assert name == 'read_file'
        assert msg['content'][0]['id'] == callId

    def test_openai_null_id_is_repaired(self):
        calls = [{'name': 'run_command', 'input': {}}]
        msg = {'role': 'assistant', 'content': '', 'tool_calls': [{'id': None, 'type': 'function'}]}
        order = canonical_tool_calls(calls, msg, is_anthropic=False)
        assert order[0][0]
        assert msg['tool_calls'][0]['id'] == order[0][0]

    def test_healthy_round_is_untouched(self):
        calls = [{'id': 'x1', 'name': 'read_file'}]
        msg = {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'x1', 'name': 'read_file'}]}
        assert canonical_tool_calls(calls, msg, is_anthropic=True) == [('x1', 'read_file')]
        assert msg['content'][0]['id'] == 'x1'


# ── 1b. the veto ───────────────────────────────────────────────────────


class TestReplayVeto:
    def test_clean_turn_allows_every_rescue(self):
        for rescue in (
            'tools_fallback',
            'context_promotion',
            'chain_fallback',
            'self_heal',
        ):
            assert wb._replayVetoReason(rescue, emitted_text=False, executed_tool=False) is None, rescue

    def test_executed_tool_vetoes_every_rescue(self):
        for rescue in (
            'tools_fallback',
            'context_promotion',
            'chain_fallback',
            'self_heal',
        ):
            reason = wb._replayVetoReason(rescue, emitted_text=False, executed_tool=True)
            assert reason is not None, rescue
            assert 'tool' in reason

    def test_visible_text_vetoes_rescues_that_change_the_answer(self):
        reason = wb._replayVetoReason('chain_fallback', emitted_text=True, executed_tool=False)
        assert reason is not None
        assert 'visible text' in reason

    def test_narration_self_heal_ignores_its_own_trigger_text(self):
        """The text that trips the stream rule is what the self-heal exists
        to discard — vetoing on it would disable the feature outright. The
        tool signal still vetoes."""
        assert wb._replayVetoReason('self_heal', emitted_text=True, executed_tool=False, text_vetoes=False) is None
        assert wb._replayVetoReason('self_heal', emitted_text=True, executed_tool=True, text_vetoes=False) is not None

    def test_unknown_rescue_fails_closed(self):
        assert wb._replayVetoReason('some_future_path', emitted_text=False, executed_tool=True) is not None
        assert wb._replayVetoReason('some_future_path', emitted_text=True, executed_tool=False) is not None

    def test_attempt_level_gate_is_unchanged(self):
        # The per-attempt emission gate keeps its own semantics: it only
        # speaks about a retryable failure, and it stays attempt-scoped.
        assert wb._retryBlockedByPartialEmission({'error': 'x', 'errorStatus': 429}, True)
        assert not wb._retryBlockedByPartialEmission({'error': 'x', 'errorStatus': 429}, False)
        assert not wb._retryBlockedByPartialEmission({'error': 'invalid api key'}, True)


# ── 1c + 2. loop-level, end to end ─────────────────────────────────────

STUB_PROVIDER = {
    'name': 'stub-anthropic',
    'apiMode': 'anthropicMessages',
    'default_model': 'stub-claude',
    'model_profiles': {},
}


class StubClient:
    """Scripted Anthropic stream, with hooks for the failure shapes."""

    def __init__(self, script: str, onceName: str = 'list_skills', onceInput: str = '{}'):
        self.script = script
        self.onceName = onceName
        self.onceInput = onceInput
        self.callCount = 0
        self.bodies: list[object] = []
        self._cancelEvent: asyncio.Event | None = None

    def resolveApiKey(self) -> str:
        return 'stub-key'

    def bindCancel(self, event: asyncio.Event) -> None:
        self._cancelEvent = event

    def _tool(self, name: str, raw: str) -> list[dict[str, object]]:
        return [
            {
                '_event_type': 'content_block_start',
                'content_block': {'type': 'tool_use', 'id': 'toolu_r1', 'name': name},
            },
            {
                '_event_type': 'content_block_delta',
                'delta': {'type': 'input_json_delta', 'partial_json': raw},
            },
            {'_event_type': 'content_block_stop'},
            {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}},
        ]

    def _text(self, text: str) -> list[dict[str, object]]:
        return [
            {
                '_event_type': 'content_block_start',
                'content_block': {'type': 'text', 'text': text},
            },
            {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}},
        ]

    def _err(self) -> list[dict[str, object]]:
        return [{'_event_type': 'error', 'error': {'type': 'upstream_error', 'status': 429, 'body': 'rate limit'}}]

    async def messages_stream(self, body) -> AsyncIterator[dict[str, object]]:
        self.callCount += 1
        roundN = self.callCount
        self.bodies.append(body)
        await asyncio.sleep(0)
        if self.script == 'vanishing_tool':
            # Round 1 calls a tool that the harness produces no receipt for;
            # round 2 must still see a well-formed round-1 history.
            events = self._tool(self.onceName, self.onceInput) if roundN == 1 else self._text('Recovered.')
        elif self.script == 'transient_then_ok':
            # Round 1 runs a tool, round 2 hits a transient 429, round 3
            # answers. The plain same-body retry must still recover.
            if roundN == 1:
                events = self._tool(self.onceName, self.onceInput)
            elif roundN == 2:
                events = self._err()
            else:
                events = self._text('Recovered.')
        elif self.script == 'text_then_429':
            # Round 1 streams prose then fails; round 2 must not be a second
            # answer generated by a blind replay.
            if roundN == 1:
                events = self._text('Here is the answer, half') + self._err()
            else:
                events = self._text('a duplicate answer')
        else:
            raise AssertionError(f'unknown script {self.script}')
        for ev in events:
            yield ev


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    from app.services.workbench import sessions as sessions_mod

    empty: dict = {}
    monkeypatch.setattr(sessions_mod, '_sessions', empty)
    monkeypatch.setattr(wb, '_sessions', empty)
    monkeypatch.setattr('app.services.workbench.providers.resolve_workbench_provider', lambda *a, **kw: STUB_PROVIDER)
    monkeypatch.setattr('app.services.workbench.providers.resolve_model', lambda p, hint='': 'stub-claude')
    monkeypatch.setattr(wb, 'buildSystemPrompt', lambda session, tools=None: 'stub system prompt')
    monkeypatch.setattr('app.services.provider_credentials.resolve', lambda name: {'api_key': 'stub-key'})
    holder: dict[str, object] = {}
    monkeypatch.setattr('app.providers.clients.getClient', lambda provider: holder['client'])
    from app.services.tool_registrations import register_all

    register_all()
    yield holder


def _events():
    captured: list[dict[str, object]] = []
    return captured


def _emitTo(captured: list[dict[str, object]]):
    def emit(ev: dict[str, object]) -> None:
        captured.append(ev)

    return emit


def _pair_ids(messages: list[dict]) -> tuple[list[str], list[str]]:
    """(tool_use ids, tool_result ids) in transcript order."""
    uses: list[str] = []
    results: list[str] = []
    for m in messages:
        content = m.get('content')
        if isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get('type') == 'tool_use':
                    uses.append(str(b.get('id')))
                elif isinstance(b, dict) and b.get('type') == 'tool_result':
                    results.append(str(b.get('tool_use_id')))
        elif m.get('role') == 'tool':
            results.append(str(m.get('tool_use_id')))
    return uses, results


def _losing_stage():
    """A stage where every tool dispatches but no receipt comes back —
    the shape that used to persist a tool_use with no tool_result."""

    async def stage(pending, run_one, is_cancelled=None):
        await asyncio.gather(*[run_one(n, i, t) for n, i, t in pending])
        return []

    return stage


def _patch_losing_stage(monkeypatch) -> None:
    # `run_regular_tools_stage` is imported function-locally, so patch the
    # defining module rather than the workbench namespace.
    monkeypatch.setattr('app.services.workbench.chat_stages.run_regular_tools_stage', _losing_stage())


class TestLoopToolResultGuarantee:
    @pytest.mark.asyncio
    async def test_normal_round_is_unchanged(self, _isolate):
        """The healthy path must be byte-identical: one real result, no
        synthetic receipt, no reconciliation warning."""
        stub = StubClient('vanishing_tool', onceName='list_skills')
        _isolate['client'] = stub
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        captured = _events()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id,
            message='go',
            model='stub-claude',
            emit=_emitTo(captured),
        )
        assert 'done' in [e['type'] for e in captured]
        assert not [e for e in captured if e.get('type') == 'warning' and 'were missing' in str(e.get('message'))]
        toolMsgs = [m for m in session.messages if m.get('role') == 'tool']
        assert len(toolMsgs) == 1
        assert SYNTHETIC_TOOL_RESULT_PREFIX not in str(toolMsgs[0].get('content'))

    @pytest.mark.asyncio
    async def test_missing_result_is_synthesized_end_to_end(self, _isolate, monkeypatch):
        """A tool that produced no receipt used to persist a tool_use with
        no tool_result — a NON-retryable 400 on the next turn."""

        async def losing_stage(pending, run_one, is_cancelled=None):
            # The tools dispatch (their side effects still happen) but no
            # receipt comes back, as a dying stage would leave it.
            await asyncio.gather(*[run_one(n, i, t) for n, i, t in pending])
            return []

        _patch_losing_stage(monkeypatch)
        stub = StubClient('vanishing_tool', onceName='list_skills')
        _isolate['client'] = stub
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        captured = _events()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='go', model='stub-claude', emit=_emitTo(captured)
        )

        uses, results = _pair_ids(session.messages)
        assert uses, 'the round should still have made its tool call'
        assert sorted(uses) == sorted(results), f'dangling tool_use: {uses} vs {results}'
        toolMsgs = [m for m in session.messages if m.get('role') == 'tool']
        assert toolMsgs
        assert SYNTHETIC_TOOL_RESULT_PREFIX in str(toolMsgs[0].get('content'))
        # The model is told, and the user is told.
        assert any(e.get('type') == 'warning' and 'were missing' in str(e.get('message')) for e in captured)
        # The loop still recovered on the next round.
        assert stub.callCount == 2
        assert 'done' in [e['type'] for e in captured]

    @pytest.mark.asyncio
    async def test_every_persisted_result_is_well_formed(self, _isolate, monkeypatch):
        _patch_losing_stage(monkeypatch)
        stub = StubClient('vanishing_tool', onceName='list_skills')
        _isolate['client'] = stub
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        captured = _events()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='go', model='stub-claude', emit=_emitTo(captured)
        )
        for m in session.messages:
            if m.get('role') != 'tool':
                continue
            assert m.get('tool_use_id'), 'a tool message with an empty id is a guaranteed 400'
            assert isinstance(m.get('content'), str) and str(m['content']).strip()
        # The next request carries the round-1 pair to the wire intact.
        assert len(stub.bodies) >= 2
        assert SYNTHETIC_TOOL_RESULT_PREFIX in str(stub.bodies[1])


class TestLoopReplayVeto:
    @pytest.mark.asyncio
    async def test_transient_retry_after_a_tool_still_recovers(self, _isolate, monkeypatch):
        """The veto is scoped to REPLAY rescues. The same-body transient
        retry after a tool ran re-asks the same question and re-executes
        nothing — it must keep working, or a normal turn would break."""
        monkeypatch.setattr(wb, '_modelRetryDelayMs', lambda *a, **kw: 0)
        stub = StubClient('transient_then_ok', onceName='list_skills')
        _isolate['client'] = stub
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        captured = _events()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='go', model='stub-claude', emit=_emitTo(captured)
        )
        assert 'done' in [e['type'] for e in captured]
        assert not [e for e in captured if e.get('type') == 'error']
        assert stub.callCount == 3, 'the transient failure should have been retried'
        assert any('Recovered.' in json.dumps(m.get('content'), default=str) for m in session.messages)

    @pytest.mark.asyncio
    async def test_partial_stream_is_not_blindly_replayed(self, _isolate, monkeypatch):
        """Text that already reached the user must not be paid for and
        answered twice. The per-attempt gate stops the identical retry;
        the turn-scoped veto stops a chain/promotion replay behind it."""
        monkeypatch.setattr(wb, '_modelRetryDelayMs', lambda *a, **kw: 0)
        stub = StubClient('text_then_429')
        _isolate['client'] = stub
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        captured = _events()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='go', model='stub-claude', emit=_emitTo(captured)
        )
        assert stub.callCount == 1, 'a turn that already emitted text was replayed'
        # No `retrying` rollback was sent — the partial text stands alone.
        assert not [e for e in captured if e.get('type') == 'retrying']
        # The failure is surfaced honestly rather than swallowed.
        assert any(e.get('type') == 'error' for e in captured)
        assert 'done' in [e['type'] for e in captured]
        answers = [str(m.get('content')) for m in session.messages if m.get('role') == 'assistant']
        assert 'a duplicate answer' not in answers

    @pytest.mark.asyncio
    async def test_chain_fallback_is_vetoed_after_a_tool_ran(self, _isolate, monkeypatch):
        """A fallback-chain model switch after a tool ran re-plans the round
        against a workspace the tool already moved — a double execution."""
        monkeypatch.setattr(wb, '_modelRetryDelayMs', lambda *a, **kw: 0)
        monkeypatch.setattr(wb, '_chatFallbackChain', lambda: ['chain-sibling'])
        # Chain sibling resolves but must never be asked.
        monkeypatch.setattr(
            wb,
            '_resolveChatLlm',
            lambda **kw: (
                (STUB_PROVIDER, 'chain-sibling')
                if kw.get('model') == 'chain-sibling'
                else (STUB_PROVIDER, 'stub-claude')
            ),
        )
        stub = StubClient('transient_then_ok', onceName='list_skills')
        _isolate['client'] = stub
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        captured = _events()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='go', model='stub-claude', emit=_emitTo(captured)
        )
        # Round 1 ran a tool, round 2's 429 exhausted the plain retry
        # budget only via the veto: the chain sibling is never dispatched
        # for the same round, and the error surfaces.
        assert stub.callCount >= 2
        assert not [e for e in captured if e.get('type') == 'retrying' and 'chain-sibling' in str(e.get('reason'))]
        uses, results = _pair_ids(session.messages)
        assert not set(results) - set(uses), 'the veto path still left a dangling tool_use'
