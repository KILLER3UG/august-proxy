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

    def __init__(self, mode: str='tool_forever', cancelAfter: int | None=None):
        self.mode = mode
        self.callCount = 0
        self.cancelAfter = cancelAfter
        self._cancelEvent: asyncio.Event | None = None

    def resolveApiKey(self) -> str:
        return 'stub-key'

    def bindCancel(self, event: asyncio.Event) -> None:
        self._cancelEvent = event

    async def messagesStream(self, body) -> AsyncIterator[dict[str, object]]:
        self.callCount += 1
        roundN = self.callCount
        await asyncio.sleep(0)
        if self.mode == 'tool_forever':
            yield {'_event_type': 'content_block_start', 'content_block': {'type': 'tool_use', 'id': f'toolu_{roundN}', 'name': 'list_skills'}}
            yield {'_event_type': 'content_block_delta', 'delta': {'type': 'input_json_delta', 'partial_json': '{}'}}
            yield {'_event_type': 'content_block_stop'}
            yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
            if self.cancelAfter is not None and self.callCount >= self.cancelAfter and (self._cancelEvent is not None) and (not self._cancelEvent.is_set()):
                self._cancelEvent.set()
        elif self.mode == 'text_once':
            yield {'_event_type': 'content_block_start', 'content_block': {'type': 'text', 'text': 'Hello.'}}
            yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
        elif self.mode == 'error':
            yield {'_event_type': 'error', 'error': {'type': 'upstream_error'}}
STUB_PROVIDER = {'name': 'stub-anthropic', 'api_mode': 'anthropic_messages', 'default_model': 'stub-claude', 'model_profiles': {}}

@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    """Redirect the data dir + clear in-memory session state."""
    from app.config import settings
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    monkeypatch.setattr(wb, '_sessions', {})
    monkeypatch.setattr(asyncio, 'create_task', lambda coro, **kw: asyncio.ensure_future(coro))
    monkeypatch.setattr(wb, '_resolveWorkbenchProvider', lambda *a, **kw: STUB_PROVIDER)
    monkeypatch.setattr(wb, '_resolveModel', lambda p, hint='': 'stub-claude')
    monkeypatch.setattr(wb, 'buildSystemPrompt', lambda session: 'stub system prompt')
    import app.providers.clients as clientsMod
    from app.services import providerCredentials as providerCredsMod
    monkeypatch.setattr(providerCredsMod, 'resolve', lambda name: {'api_key': 'stub-key'})
    stubHolder: dict[str, object] = {}

    def fakeGetClient(provider):
        return stubHolder['client']
    monkeypatch.setattr(clientsMod, 'getClient', fakeGetClient)
    monkeypatch.setattr('app.providers.clients.getClient', fakeGetClient)
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
        await wb.sendWorkbenchMessageStream(sessionId='wb_test_loop', message='loop test', model='stub-claude', emit=_emitTo(events), signal=cancel)
        assert stub.callCount >= 11, f'loop stopped too early: {stub.callCount} rounds'
        types = [e['type'] for e in events]
        assert 'done' in types, "terminal 'done' event not emitted"

    @pytest.mark.asyncio
    async def testNormalCompletionEmitsDone(self, _isolate):
        stub = StubClient(mode='text_once')
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(sessionId='wb_test_done', message='hi', model='stub-claude', emit=_emitTo(events))
        types = [e['type'] for e in events]
        assert 'done' in types
        assert stub.callCount == 1

class TestTerminalEventGuaranteed:

    @pytest.mark.asyncio
    async def testDoneOnModelError(self, _isolate):
        stub = StubClient(mode='error')
        _isolate['client'] = stub
        events = _capturedEvents()
        await wb.sendWorkbenchMessageStream(sessionId='wb_test_err', message='hi', model='stub-claude', emit=_emitTo(events))
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
        await wb.sendWorkbenchMessageStream(sessionId='wb_test_cancel', message='hi', model='stub-claude', emit=_emitTo(events), signal=cancel)
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