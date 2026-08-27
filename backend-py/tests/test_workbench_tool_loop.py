"""Chunk 4 — tool loop: no round cap, guaranteed terminal event, observability.

Asserts the core issue-#2 fix:
  * The loop runs >10 rounds and only stops when the cancel signal is set
    (the old MAX_MANAGED_TOOL_ROUNDS=10 cap is gone).
  * A terminal ``done`` event is ALWAYS emitted — on normal completion,
    on a model error, and on cancellation — even if persistence raises.

Uses a stub provider/client whose ``messages_stream`` yields controllable
Anthropic stream events so we can drive the loop deterministically.
"""

from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

import pytest
from app.services.workbench import workbench as wb


class StubClient:
    """Stub upstream client yielding scripted Anthropic stream events."""

    def __init__(
        self,
        mode: str = 'tool_forever',
        cancelAfter: int | None = None,
        onceName: str = '',
        onceInput: str = '{}',
    ):
        self.mode = mode
        self.callCount = 0
        self.cancelAfter = cancelAfter
        self.onceName = onceName
        self.onceInput = onceInput
        self._cancelEvent: asyncio.Event | None = None

    def resolveApiKey(self) -> str:
        return 'stub-key'

    def bindCancel(self, event: asyncio.Event) -> None:
        self._cancelEvent = event

    async def messages_stream(self, body) -> AsyncIterator[dict[str, object]]:
        self.callCount += 1
        roundN = self.callCount
        await asyncio.sleep(0)
        if self.mode == 'tool_forever':
            yield {
                '_event_type': 'content_block_start',
                'content_block': {'type': 'tool_use', 'id': f'toolu_{roundN}', 'name': 'list_skills'},
            }
            yield {'_event_type': 'content_block_delta', 'delta': {'type': 'input_json_delta', 'partial_json': '{}'}}
            yield {'_event_type': 'content_block_stop'}
            yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
            if (
                self.cancelAfter is not None
                and self.callCount >= self.cancelAfter
                and (self._cancelEvent is not None)
                and (not self._cancelEvent.is_set())
            ):
                self._cancelEvent.set()
        elif self.mode == 'text_once':
            yield {'_event_type': 'content_block_start', 'content_block': {'type': 'text', 'text': 'Hello.'}}
            yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
        elif self.mode == 'remember_once':
            if roundN == 1:
                yield {
                    '_event_type': 'content_block_start',
                    'content_block': {'type': 'tool_use', 'id': f'toolu_{roundN}', 'name': 'remember'},
                }
                yield {
                    '_event_type': 'content_block_delta',
                    'delta': {
                        'type': 'input_json_delta',
                        'partial_json': '{"fact": "User prefers dark mode", "title": "Dark mode preference"}',
                    },
                }
                yield {'_event_type': 'content_block_stop'}
                yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
            else:
                yield {'_event_type': 'content_block_start', 'content_block': {'type': 'text', 'text': 'Saved.'}}
                yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
        elif self.mode == 'error':
            yield {'_event_type': 'error', 'error': {'type': 'upstream_error'}}
        elif self.mode == 'tool_truncated_once':
            # T2: round 1 stops on the output token limit while carrying a
            # tool call; round 2 answers in text.
            if roundN == 1:
                yield {
                    '_event_type': 'content_block_start',
                    'content_block': {'type': 'tool_use', 'id': f'toolu_{roundN}', 'name': 'list_skills'},
                }
                yield {
                    '_event_type': 'content_block_delta',
                    'delta': {'type': 'input_json_delta', 'partial_json': '{}'},
                }
                yield {'_event_type': 'content_block_stop'}
                yield {
                    '_event_type': 'message_delta',
                    'delta': {'stop_reason': 'max_tokens'},
                    'usage': {'input_tokens': 10, 'output_tokens': 5},
                }
            else:
                yield {'_event_type': 'content_block_start', 'content_block': {'type': 'text', 'text': 'Done.'}}
                yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
        elif self.mode == 'todos_once':
            # T7: round 1 submits a todo list; round 2 answers in text.
            if roundN == 1:
                yield {
                    '_event_type': 'content_block_start',
                    'content_block': {'type': 'tool_use', 'id': f'toolu_{roundN}', 'name': 'submit_todos'},
                }
                yield {
                    '_event_type': 'content_block_delta',
                    'delta': {
                        'type': 'input_json_delta',
                        'partial_json': json.dumps(
                            {
                                'todos': [
                                    {'content': 'explore repo', 'status': 'pending'},
                                    {'content': 'write tests', 'status': 'pending'},
                                ]
                            }
                        ),
                    },
                }
                yield {'_event_type': 'content_block_stop'}
                yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
            else:
                yield {'_event_type': 'content_block_start', 'content_block': {'type': 'text', 'text': 'Planned.'}}
                yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
        elif self.mode == 'state_once':
            # T7: round 1 updates execution state; round 2 answers in text.
            if roundN == 1:
                yield {
                    '_event_type': 'content_block_start',
                    'content_block': {'type': 'tool_use', 'id': f'toolu_{roundN}', 'name': 'update_state'},
                }
                yield {
                    '_event_type': 'content_block_delta',
                    'delta': {
                        'type': 'input_json_delta',
                        'partial_json': json.dumps({'phase': 'implement', 'step': 2}),
                    },
                }
                yield {'_event_type': 'content_block_stop'}
                yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
            else:
                yield {'_event_type': 'content_block_start', 'content_block': {'type': 'text', 'text': 'Moving on.'}}
                yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
        elif self.mode == 'tool_once':
            # Generic: round 1 issues one scripted tool call; round 2 answers.
            if roundN == 1:
                yield {
                    '_event_type': 'content_block_start',
                    'content_block': {'type': 'tool_use', 'id': f'toolu_{roundN}', 'name': self.onceName},
                }
                yield {
                    '_event_type': 'content_block_delta',
                    'delta': {'type': 'input_json_delta', 'partial_json': self.onceInput},
                }
                yield {'_event_type': 'content_block_stop'}
                yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
            else:
                yield {'_event_type': 'content_block_start', 'content_block': {'type': 'text', 'text': 'Done.'}}
                yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
        elif self.mode == 'read_then_write':
            # T17: round 1 reads existing.txt, round 2 overwrites it,
            # round 3 answers in text.
            if roundN == 1:
                yield {
                    '_event_type': 'content_block_start',
                    'content_block': {'type': 'tool_use', 'id': f'toolu_{roundN}', 'name': 'read_file'},
                }
                yield {
                    '_event_type': 'content_block_delta',
                    'delta': {
                        'type': 'input_json_delta',
                        'partial_json': json.dumps({'path': 'existing.txt'}),
                    },
                }
                yield {'_event_type': 'content_block_stop'}
                yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
            elif roundN == 2:
                yield {
                    '_event_type': 'content_block_start',
                    'content_block': {'type': 'tool_use', 'id': f'toolu_{roundN}', 'name': 'write_file'},
                }
                yield {
                    '_event_type': 'content_block_delta',
                    'delta': {
                        'type': 'input_json_delta',
                        'partial_json': json.dumps({'path': 'existing.txt', 'content': 'updated'}),
                    },
                }
                yield {'_event_type': 'content_block_stop'}
                yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
            else:
                yield {'_event_type': 'content_block_start', 'content_block': {'type': 'text', 'text': 'Updated.'}}
                yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
        elif self.mode == 'overflow_once':
            # §9.3 #2: attempt 1 hits a context-overflow error; after the
            # reactive reduction the retry (attempt 2) answers in text.
            if roundN == 1:
                yield {
                    '_event_type': 'error',
                    'error': {
                        'type': 'invalid_request_error',
                        'message': 'prompt is too long: 999999 tokens > 200000 maximum',
                    },
                }
            else:
                yield {'_event_type': 'content_block_start', 'content_block': {'type': 'text', 'text': 'Recovered.'}}
                yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}


STUB_PROVIDER = {
    'name': 'stub-anthropic',
    'apiMode': 'anthropicMessages',
    'default_model': 'stub-claude',
    'model_profiles': {},
}


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    """Redirect the data dir + clear in-memory session state."""
    from app.config import settings

    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    from app.services.workbench import sessions as sessions_mod

    empty_sessions: dict = {}
    monkeypatch.setattr(sessions_mod, '_sessions', empty_sessions)
    monkeypatch.setattr(wb, '_sessions', empty_sessions)
    monkeypatch.setattr(asyncio, 'create_task', lambda coro, **kw: asyncio.ensure_future(coro))
    monkeypatch.setattr('app.services.workbench.providers.resolve_workbench_provider', lambda *a, **kw: STUB_PROVIDER)
    monkeypatch.setattr('app.services.workbench.providers.resolve_model', lambda p, hint='': 'stub-claude')
    monkeypatch.setattr(wb, 'buildSystemPrompt', lambda session, tools=None: 'stub system prompt')
    import app.providers.clients as clientsMod
    from app.services import provider_credentials as providerCredsMod

    monkeypatch.setattr(providerCredsMod, 'resolve', lambda name: {'api_key': 'stub-key'})
    stubHolder: dict[str, object] = {}

    def fakeGetClient(provider):
        return stubHolder['client']

    monkeypatch.setattr(clientsMod, 'getClient', fakeGetClient)
    monkeypatch.setattr('app.providers.clients.getClient', fakeGetClient)
    # Populate the tool registry (the app does this at boot via
    # tool_definitions; the stubbed prompt path skips it).
    from app.services.tool_registrations import register_all

    register_all()
    yield stubHolder


def _capturedEvents():
    events: list[dict[str, object]] = []
    return events


def _emitTo(events: list[dict[str, object]]):

    def emit(ev: dict[str, object]) -> None:
        events.append(ev)

    return emit


class TestNoRoundCap:
    @pytest.mark.asyncio
    async def testLoopExceedsTenRoundsAndStopsOnCancel(self, _isolate):
        cancel = asyncio.Event()
        stub = StubClient(mode='tool_forever', cancelAfter=12)
        stub.bindCancel(cancel)
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId='wb_test_loop', message='loop test', model='stub-claude', emit=_emitTo(events), signal=cancel
        )
        assert stub.callCount >= 11, f'loop stopped too early: {stub.callCount} rounds'
        types = [e['type'] for e in events]
        assert 'done' in types, "terminal 'done' event not emitted"

    @pytest.mark.asyncio
    async def testNormalCompletionEmitsDone(self, _isolate):
        stub = StubClient(mode='text_once')
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId='wb_test_done', message='hi', model='stub-claude', emit=_emitTo(events)
        )
        types = [e['type'] for e in events]
        assert 'done' in types
        assert stub.callCount == 1


class TestTerminalEventGuaranteed:
    @pytest.mark.asyncio
    async def testDoneOnModelError(self, _isolate):
        stub = StubClient(mode='error')
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId='wb_test_err', message='hi', model='stub-claude', emit=_emitTo(events)
        )
        types = [e['type'] for e in events]
        assert 'error' in types
        assert 'done' in types, 'done must be emitted even after a model error'

    @pytest.mark.asyncio
    async def testDoneOnCancellationBeforeFirstRound(self, _isolate):
        stub = StubClient(mode='tool_forever')
        _isolate['client'] = stub
        cancel = asyncio.Event()
        cancel.set()
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId='wb_test_cancel', message='hi', model='stub-claude', emit=_emitTo(events), signal=cancel
        )
        types = [e['type'] for e in events]
        assert 'done' in types, 'done must be emitted on cancellation'
        assert stub.callCount == 0

    @pytest.mark.asyncio
    async def testDoneEmittedEvenIfSaveSessionsRaises(self, _isolate, monkeypatch):
        """The try/finally guarantees done even when persistence fails."""
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        sid = session.id
        stub = StubClient(mode='text_once')
        _isolate['client'] = stub
        callCount = {'n': 0}
        realSave = wb.saveSessions

        def boom():
            callCount['n'] += 1
            if callCount['n'] >= 1:
                raise RuntimeError('disk full')
            realSave()

        monkeypatch.setattr(wb, 'saveSessions', boom)
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(sessionId=sid, message='hi', model='stub-claude', emit=_emitTo(events))
        types = [e['type'] for e in events]
        assert 'done' in types, 'done must be emitted even if saveSessions raises'


class TestMemoryUpdatedEmission:
    """Plan §4.3: a successful `remember` emits `memoryUpdated` so the
    transcript can render the subtle memory chip (dormant path activated)."""

    @pytest.mark.asyncio
    async def testRememberEmitsMemoryUpdated(self, _isolate):
        stub = StubClient(mode='remember_once')
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId='wb_test_mem', message='remember this', model='stub-claude', emit=_emitTo(events)
        )
        memoryEvents = [e for e in events if e.get('type') == 'memoryUpdated']
        assert memoryEvents, f'no memoryUpdated event in {[e.get("type") for e in events]}'
        summary = str(memoryEvents[0].get('summary') or '')
        assert summary.startswith('Remembered:')
        assert 'Dark mode preference' in summary
        assert memoryEvents[0].get('key')

    @pytest.mark.asyncio
    async def testFailedRememberEmitsNothing(self, _isolate, monkeypatch):
        from app.services import brain_config_service

        # modelMemoryWrites off → remember refuses → no memoryUpdated.
        monkeypatch.setattr(
            brain_config_service,
            'getRuntimeConfig',
            lambda: {'modelMemoryWrites': False},
        )
        stub = StubClient(mode='remember_once')
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId='wb_test_mem_off', message='remember this', model='stub-claude', emit=_emitTo(events)
        )
        assert not [e for e in events if e.get('type') == 'memoryUpdated']


class TestLengthStopFailAll:
    """T2 (plan §9.4): a generation that stopped on the output token limit
    may carry half-parsed tool arguments — every tool call in the batch
    fails unexecuted with a self-heal message, and the loop continues."""

    @pytest.mark.asyncio
    async def testTruncatedToolBatchFailsUnexecuted(self, _isolate):
        stub = StubClient(mode='tool_truncated_once')
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId='wb_test_t2', message='do it', model='stub-claude', emit=_emitTo(events)
        )
        toolResults = [e for e in events if e.get('type') == 'toolResult']
        assert toolResults, f'no toolResult events in {[e.get("type") for e in events]}'
        failed = [e for e in toolResults if e.get('status') == 'error']
        assert failed, 'truncated tool call was not failed'
        assert 'NOT executed' in str(failed[0].get('content'))
        assert failed[0].get('blocked') is True
        # The tool itself never ran — no successful result for list_skills.
        assert not [e for e in toolResults if e.get('status') == 'done']
        # The loop continued with the self-heal: round 2 answered in text.
        assert stub.callCount == 2
        types = [e['type'] for e in events]
        assert 'done' in types
        assert any(
            e.get('type') == 'warning' and 'Truncated generation' in str(e.get('message'))
            for e in events
        )


class TestPlanStateReinjection:
    """T7 (plan §9.4): plan/todo state changed mid-turn must be re-injected
    on the state tool's receipt — the <session> block in the system text was
    built at turn start and goes stale within the same turn."""

    @pytest.mark.asyncio
    async def testTodosReceiptCarriesStateBlock(self, _isolate):
        stub = StubClient(mode='todos_once')
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId='wb_test_t7_todos', message='plan it', model='stub-claude', emit=_emitTo(events)
        )
        results = [e for e in events if e.get('type') == 'toolResult' and e.get('name') == 'submit_todos']
        assert results, f'no submit_todos toolResult in {[e.get("type") for e in events]}'
        content = str(results[0].get('content'))
        assert content.startswith('Todo list saved.')
        assert '<plan_state>' in content
        assert 'todos: 0/2 done' in content
        assert 'next: explore repo' in content
        # The history copy (what the model sees next round) carries it too.
        # createWorkbenchSession generates its own id, so take the only session.
        session = next(iter(wb._sessions.values()))
        toolMsgs = [m for m in session.messages if m.get('role') == 'tool']
        assert toolMsgs and '<plan_state>' in str(toolMsgs[-1].get('content'))

    @pytest.mark.asyncio
    async def testUpdateStateReceiptCarriesStateBlock(self, _isolate):
        stub = StubClient(mode='state_once')
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId='wb_test_t7_state', message='go', model='stub-claude', emit=_emitTo(events)
        )
        results = [e for e in events if e.get('type') == 'toolResult' and e.get('name') == 'update_state']
        assert results, f'no update_state toolResult in {[e.get("type") for e in events]}'
        content = str(results[0].get('content'))
        assert content.startswith('State updated: phase=implement')
        assert '<plan_state>' in content
        assert 'execution: phase=implement step=2' in content
        assert stub.callCount == 2
        assert 'done' in [e['type'] for e in events]


class TestSpillInLoop:
    """Stage B end-to-end (plan §9.3 #3): a >50 KB fresh result from a real
    tool dispatch is spilled to a session file; the history copy the model
    sees next round is the bounded head/tail preview."""

    @pytest.mark.asyncio
    async def testBigReadFileSpillsToSessionFile(self, _isolate, tmp_path):
        # ~68 KB: over the 50 KB spill threshold, under the 100 KB SSE cap —
        # so the SSE copy IS the full result and we can compare against it.
        bigContent = ''.join(f'data line {i:06d}\n' for i in range(4000))
        (tmp_path / 'big.txt').write_text(bigContent, encoding='utf-8')
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        session.workspacePath = str(tmp_path)
        stub = StubClient(
            mode='tool_once', onceName='read_file', onceInput=json.dumps({'path': 'big.txt'})
        )
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='read it', model='stub-claude', emit=_emitTo(events)
        )
        assert 'done' in [e['type'] for e in events]
        # The SSE copy carries the full result (UI side, 100 KB cap not hit).
        sseResults = [e for e in events if e.get('type') == 'toolResult' and e.get('name') == 'read_file']
        assert sseResults
        fullResult = str(sseResults[0].get('content'))
        assert len(fullResult) > wb._SPILL_THRESHOLD_CHARS
        # The spill file holds the verbatim result.
        spilled = sorted((tmp_path / '.aug' / 'spill').rglob('*.txt'))
        assert len(spilled) == 1, f'expected one spill file, got {spilled}'
        assert spilled[0].read_text(encoding='utf-8') == fullResult
        # The history copy is the bounded preview with the notice line.
        toolMsgs = [m for m in session.messages if m.get('role') == 'tool']
        assert toolMsgs
        history = str(toolMsgs[-1].get('content'))
        assert 'characters omitted' in history
        assert '.aug/spill/' in history
        assert len(history) < 32 * 1024
        assert len(history) < len(fullResult) // 2


class TestPostEditVerificationInLoop:
    """T1/T14 end-to-end (plan §9.4): a successful write_file dispatch runs
    the workspace verification gate and the receipt is appended to the tool
    result in BOTH the SSE copy and the model-facing history."""

    @pytest.mark.asyncio
    async def testWriteFileCarriesVerificationReceipt(self, _isolate, tmp_path, monkeypatch):
        from app.services.workbench import edit_verification as ev

        (tmp_path / '.aug').mkdir()
        (tmp_path / '.aug' / 'verify.json').write_text(
            '{"lintCmd": "mylint {file}", "testCmd": "mytest"}',
            encoding='utf-8',
        )
        ran: list[str] = []

        async def fake_run(command, workspace, session, timeout):
            ran.append(command)
            return True, 'All checks passed.'

        async def fake_hash(workspace):
            return None  # dedup off — no git in the tmp workspace

        monkeypatch.setattr(ev, '_run_gate_command', fake_run)
        monkeypatch.setattr(ev, 'worktree_hash', fake_hash)

        session = wb.createWorkbenchSession(provider='stub-anthropic')
        session.workspacePath = str(tmp_path)
        stub = StubClient(
            mode='tool_once',
            onceName='write_file',
            onceInput=json.dumps({'path': 'foo.py', 'content': 'x = 1\n'}),
        )
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='write it', model='stub-claude', emit=_emitTo(events)
        )
        assert 'done' in [e['type'] for e in events]
        assert ran and ran[0] == 'mylint foo.py'
        sseResults = [
            e for e in events if e.get('type') == 'toolResult' and e.get('name') == 'write_file'
        ]
        assert sseResults
        sseContent = str(sseResults[0].get('content'))
        assert '[verification passed] lint + tests clean.' in sseContent
        toolMsgs = [m for m in session.messages if m.get('role') == 'tool']
        assert toolMsgs
        assert '[verification passed]' in str(toolMsgs[-1].get('content'))

    @pytest.mark.asyncio
    async def testFailedGateFeedsSelfHealToHistory(self, _isolate, tmp_path, monkeypatch):
        from app.services.workbench import edit_verification as ev

        (tmp_path / '.aug').mkdir()
        (tmp_path / '.aug' / 'verify.json').write_text(
            '{"lintCmd": "mylint {file}"}',
            encoding='utf-8',
        )

        async def fake_run(command, workspace, session, timeout):
            return False, 'foo.py:1:1: E999 syntax error'

        async def fake_hash(workspace):
            return None

        monkeypatch.setattr(ev, '_run_gate_command', fake_run)
        monkeypatch.setattr(ev, 'worktree_hash', fake_hash)

        session = wb.createWorkbenchSession(provider='stub-anthropic')
        session.workspacePath = str(tmp_path)
        stub = StubClient(
            mode='tool_once',
            onceName='write_file',
            onceInput=json.dumps({'path': 'foo.py', 'content': 'x = = 1\n'}),
        )
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='write it', model='stub-claude', emit=_emitTo(events)
        )
        assert 'done' in [e['type'] for e in events]
        toolMsgs = [m for m in session.messages if m.get('role') == 'tool']
        assert toolMsgs
        history = str(toolMsgs[-1].get('content'))
        assert '[verification FAILED' in history
        assert 'Fix iteration 1/3' in history


class TestDurabilityBarriersInLoop:
    """T18 end-to-end (plan §9.4): barrier flushes persist the session with
    turnOpen=True mid-turn, the turn closes with turnOpen=False, and a
    failed flush aborts the protected operation (fail-closed)."""

    @pytest.mark.asyncio
    async def testBarrierFlushLifecycle(self, _isolate, tmp_path, monkeypatch):
        import app.services.memory_store as ms

        saved: list[dict[str, object]] = []

        def fake_save(blob):
            saved.append(dict(blob))

        monkeypatch.setattr(ms, 'save_workbench_session_sot', fake_save)
        monkeypatch.setattr(ms, 'init', lambda: None)

        session = wb.createWorkbenchSession(provider='stub-anthropic')
        session.workspacePath = str(tmp_path)
        stub = StubClient(
            mode='tool_once', onceName='list_skills', onceInput='{}'
        )
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='go', model='stub-claude', emit=_emitTo(events)
        )
        assert 'done' in [e['type'] for e in events]
        # Mid-turn barrier flushes persisted turnOpen=True…
        assert any(b.get('turnOpen') is True for b in saved)
        # …and the session ends the turn closed.
        assert session.turnOpen is False

    @pytest.mark.asyncio
    async def testFailedFlushAbortsBeforeDispatch(self, _isolate, tmp_path, monkeypatch):
        import app.services.memory_store as ms

        def boom(blob):
            raise OSError('disk full')

        monkeypatch.setattr(ms, 'save_workbench_session_sot', boom)
        monkeypatch.setattr(ms, 'init', lambda: None)

        session = wb.createWorkbenchSession(provider='stub-anthropic')
        session.workspacePath = str(tmp_path)
        stub = StubClient(mode='text_once')
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='go', model='stub-claude', emit=_emitTo(events)
        )
        # Terminal event guarantee holds even on durability abort.
        assert 'done' in [e['type'] for e in events]
        errors = [e for e in events if e.get('type') == 'error']
        assert any('durability flush failed' in str(e.get('message')) for e in errors)
        # Fail-closed: the model request was never dispatched.
        assert stub.callCount == 0


class TestShadowGitInLoop:
    """§9.3 #7 end-to-end: a turn over a workspace commits a baseline
    snapshot, and a round that runs a mutating tool commits a step snapshot."""

    @pytest.mark.asyncio
    async def testMutatingRoundSnapshots(self, _isolate, tmp_path, monkeypatch):
        from app.services.workbench import shadow_git as sg

        session = wb.createWorkbenchSession(provider='stub-anthropic')
        session.workspacePath = str(tmp_path)
        (tmp_path / 'seed.txt').write_text('seed', encoding='utf-8')
        stub = StubClient(
            mode='tool_once',
            onceName='write_file',
            onceInput=json.dumps({'path': 'new.txt', 'content': 'hello\n'}),
        )
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='write it', model='stub-claude', emit=_emitTo(events)
        )
        assert 'done' in [e['type'] for e in events]
        snaps = sg.list_snapshots(session.id, str(tmp_path))
        messages = [s['message'] for s in snaps]
        assert any(m.startswith('turn ') for m in messages)
        assert any(m.startswith('step ') and 'mutation' in m for m in messages)
        # The step snapshot captured the written file.
        assert (tmp_path / 'new.txt').read_text(encoding='utf-8') == 'hello\n'


class TestApprovalAxisInLoop:
    """T5 end-to-end (plan §9.4): the approval axis is a second, independent
    axis over command tools. Inert when no policy is configured (default);
    when enabled it denies via durable rules with feedback, asks on
    destructive commands (queueing an ApprovalBanner pending mutation), and
    resolves one-shot grants for exactly the asked command. Headless runs
    fail closed instead of hanging on a prompt."""

    @staticmethod
    def _policy(**kw: object) -> dict[str, object]:
        base: dict[str, object] = {'enabled': True}
        base.update(kw)
        return base

    @pytest.mark.asyncio
    async def testNoPolicyMeansNoChange(self, _isolate, tmp_path):
        # Default: no approval policy configured anywhere → axis inert.
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        session.workspacePath = str(tmp_path)
        stub = StubClient(
            mode='tool_once',
            onceName='run_command',
            onceInput=json.dumps({'command': 'echo hi'}),
        )
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='run it', model='stub-claude', emit=_emitTo(events)
        )
        assert 'done' in [e['type'] for e in events]
        results = [e for e in events if e.get('type') == 'toolResult' and e.get('name') == 'run_command']
        assert results
        content = str(results[0].get('content'))
        assert 'permission' not in content
        assert 'requires approval' not in content

    @pytest.mark.asyncio
    async def testDenyRuleBlocksBeforeExecution(self, _isolate, tmp_path):
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        session.workspacePath = str(tmp_path)
        session.metadata = {'approvalPolicy': self._policy(denyRules=['touch'])}
        stub = StubClient(
            mode='tool_once',
            onceName='run_command',
            onceInput=json.dumps({'command': 'touch marker.txt'}),
        )
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='create it', model='stub-claude', emit=_emitTo(events)
        )
        assert 'done' in [e['type'] for e in events]
        results = [e for e in events if e.get('type') == 'toolResult' and e.get('name') == 'run_command']
        assert results
        content = str(results[0].get('content'))
        assert '[permission:denied]' in content
        assert "deny rule 'touch'" in content
        assert 'Do not retry' in content
        # The command never executed.
        assert not (tmp_path / 'marker.txt').exists()
        assert not session.pendingMutations

    @pytest.mark.asyncio
    async def testDestructiveAsksAndQueuesPendingMutation(self, _isolate, tmp_path):
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        session.workspacePath = str(tmp_path)
        session.metadata = {'approvalPolicy': self._policy()}
        stub = StubClient(
            mode='tool_once',
            onceName='run_command',
            onceInput=json.dumps({'command': 'rm -rf builddir'}),
        )
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='delete it', model='stub-claude', emit=_emitTo(events)
        )
        assert 'done' in [e['type'] for e in events]
        results = [e for e in events if e.get('type') == 'toolResult' and e.get('name') == 'run_command']
        assert results
        content = str(results[0].get('content'))
        assert 'requires approval' in content
        assert 'destructive' in content
        # A pending mutation was queued for the ApprovalBanner UI.
        assert len(session.pendingMutations) == 1
        pm = session.pendingMutations[0]
        assert pm.get('kind') == 'approval_axis'
        assert pm.get('toolName') == 'run_command'
        assert 'destructive' in str(pm.get('approvalReason'))

    @pytest.mark.asyncio
    async def testHeadlessFailsClosed(self, _isolate, tmp_path, monkeypatch):
        monkeypatch.setenv('AUGUST_HEADLESS', '1')
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        session.workspacePath = str(tmp_path)
        session.metadata = {'approvalPolicy': self._policy()}
        stub = StubClient(
            mode='tool_once',
            onceName='run_command',
            onceInput=json.dumps({'command': 'rm -rf builddir'}),
        )
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='delete it', model='stub-claude', emit=_emitTo(events)
        )
        assert 'done' in [e['type'] for e in events]
        results = [e for e in events if e.get('type') == 'toolResult' and e.get('name') == 'run_command']
        assert results
        content = str(results[0].get('content'))
        assert '[permission:denied]' in content
        assert 'unattended' in content
        # Nothing was queued for a prompt that could never be answered.
        assert not session.pendingMutations

    @pytest.mark.asyncio
    async def testOneShotGrantCoversExactlyTheAskedCommand(self, _isolate, tmp_path):
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        session.workspacePath = str(tmp_path)
        # Empty auto-approve → even `echo` asks; the pre-recorded one-shot
        # grant covers exactly 'echo granted', nothing else.
        session.metadata = {'approvalPolicy': self._policy(autoApprove=[])}
        wb.add_tool_grant(session, 'run_command', {'command': 'echo granted'}, scope='once')
        stub = StubClient(
            mode='tool_once',
            onceName='run_command',
            onceInput=json.dumps({'command': 'echo granted'}),
        )
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='run it', model='stub-claude', emit=_emitTo(events)
        )
        assert 'done' in [e['type'] for e in events]
        results = [e for e in events if e.get('type') == 'toolResult' and e.get('name') == 'run_command']
        assert results
        content = str(results[0].get('content'))
        # The grant let it through to the real sandbox (axis 1).
        assert 'granted' in content
        assert '[sandbox:' in content
        assert 'requires approval' not in content
        # The one-shot grant was consumed by the check.
        assert not wb.has_tool_grant(session, 'run_command', {'command': 'echo granted'})

    @pytest.mark.asyncio
    async def testGrantDoesNotCoverDifferentCommand(self, _isolate, tmp_path):
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        session.workspacePath = str(tmp_path)
        session.metadata = {'approvalPolicy': self._policy(autoApprove=[])}
        wb.add_tool_grant(session, 'run_command', {'command': 'echo granted'}, scope='once')
        stub = StubClient(
            mode='tool_once',
            onceName='run_command',
            onceInput=json.dumps({'command': 'echo somethingelse'}),
        )
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='run it', model='stub-claude', emit=_emitTo(events)
        )
        assert 'done' in [e['type'] for e in events]
        results = [e for e in events if e.get('type') == 'toolResult' and e.get('name') == 'run_command']
        assert results
        content = str(results[0].get('content'))
        # Different command → the grant does not cover it → asks.
        assert 'requires approval' in content
        assert len(session.pendingMutations) == 1
        # The original grant is still intact (untouched by the other command).
        assert wb.has_tool_grant(session, 'run_command', {'command': 'echo granted'})

    @pytest.mark.asyncio
    async def testModelFlagForcesAskOverAutoApprove(self, _isolate, tmp_path):
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        session.workspacePath = str(tmp_path)
        session.metadata = {'approvalPolicy': self._policy(autoApprove=['read', 'build', 'general'])}
        stub = StubClient(
            mode='tool_once',
            onceName='run_command',
            onceInput=json.dumps({'command': 'echo hi', 'requires_approval': True}),
        )
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='run it', model='stub-claude', emit=_emitTo(events)
        )
        assert 'done' in [e['type'] for e in events]
        results = [e for e in events if e.get('type') == 'toolResult' and e.get('name') == 'run_command']
        assert results
        content = str(results[0].get('content'))
        assert 'requires approval' in content
        assert 'model flagged' in content
        assert len(session.pendingMutations) == 1


class TestReadBeforeEditInLoop:
    """T17 end-to-end (plan §9.4): editing a file the session never read is
    refused pre-dispatch with the [edit-unseen] code — the tool never runs —
    and a successful read_file observation unblocks the follow-up edit."""

    @pytest.mark.asyncio
    async def testUnseenEditRefusedWithoutExecuting(self, _isolate, tmp_path):
        (tmp_path / 'existing.txt').write_text('original', encoding='utf-8')
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        session.workspacePath = str(tmp_path)
        stub = StubClient(
            mode='tool_once',
            onceName='write_file',
            onceInput=json.dumps({'path': 'existing.txt', 'content': 'overwritten'}),
        )
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='overwrite it', model='stub-claude', emit=_emitTo(events)
        )
        assert 'done' in [e['type'] for e in events]
        toolMsgs = [m for m in session.messages if m.get('role') == 'tool']
        assert toolMsgs
        history = str(toolMsgs[-1].get('content'))
        assert '[edit-unseen]' in history
        assert 'read_file' in history
        # The tool never executed — the file is untouched.
        assert (tmp_path / 'existing.txt').read_text(encoding='utf-8') == 'original'
        sseResults = [
            e for e in events if e.get('type') == 'toolResult' and e.get('name') == 'write_file'
        ]
        assert sseResults and sseResults[0].get('status') == 'error'

    @pytest.mark.asyncio
    async def testReadThenWritePassesGate(self, _isolate, tmp_path):
        # No .aug/verify.json and no marker files → the T1 gate is disabled
        # for this workspace; only the T17 observation gate is under test.
        (tmp_path / 'existing.txt').write_text('original', encoding='utf-8')
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        session.workspacePath = str(tmp_path)
        stub = StubClient(mode='read_then_write')
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='update it', model='stub-claude', emit=_emitTo(events)
        )
        assert 'done' in [e['type'] for e in events]
        assert (tmp_path / 'existing.txt').read_text(encoding='utf-8') == 'updated'
        writeResults = [
            e for e in events if e.get('type') == 'toolResult' and e.get('name') == 'write_file'
        ]
        assert writeResults
        assert '[edit-unseen]' not in str(writeResults[0].get('content'))


class TestReactiveOverflowReduction:
    """§9.3 #2: on a provider context-overflow error run the same
    prune-then-compact reduction reactively and retry only if the surface
    actually advanced (token count dropped)."""

    @staticmethod
    def _fatHistory() -> list[dict[str, object]]:
        msgs: list[dict[str, object]] = []
        for i in range(30):
            msgs.append({'role': 'user', 'content': f'question {i} ' + 'x' * 400})
            msgs.append({'role': 'assistant', 'content': f'answer {i} ' + 'y' * 400})
        return msgs

    @pytest.mark.asyncio
    async def testOverflowShrinksAndRetries(self, _isolate, monkeypatch):
        stub = StubClient(mode='overflow_once')
        _isolate['client'] = stub
        monkeypatch.setattr(wb, '_resolveModelContextWindow', lambda *a, **kw: 1000)
        monkeypatch.setattr(wb, '_shouldAutoCompact', lambda *a, **kw: False)
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        session.messages = self._fatHistory()
        session.messageCount = len(session.messages)
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='continue', model='stub-claude', emit=_emitTo(events)
        )
        warnings = [str(e.get('message')) for e in events if e.get('type') == 'warning']
        assert any('Context overflow — reduced context' in w for w in warnings), warnings
        assert 'done' in [e['type'] for e in events]
        assert not [e for e in events if e.get('type') == 'error']
        assert stub.callCount == 2  # overflow attempt + post-reduction retry

    @pytest.mark.asyncio
    async def testOverflowWithoutAdvanceFallsThrough(self, _isolate, monkeypatch):
        # Tiny history: nothing to prune or summarize → reduction cannot
        # advance the surface → the error surfaces instead of a retry loop.
        stub = StubClient(mode='overflow_once')
        _isolate['client'] = stub
        monkeypatch.setattr(wb, '_resolveModelContextWindow', lambda *a, **kw: 0)
        monkeypatch.setattr(wb, '_shouldAutoCompact', lambda *a, **kw: False)
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(
            sessionId=session.id, message='hi', model='stub-claude', emit=_emitTo(events)
        )
        errors = [str(e.get('message')) for e in events if e.get('type') == 'error']
        assert any('prompt is too long' in e for e in errors), errors
        assert 'done' in [e['type'] for e in events]
        assert stub.callCount == 1  # no retry when the surface cannot advance
