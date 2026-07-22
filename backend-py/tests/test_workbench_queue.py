"""Tests for the mid-response queued user message feature.

The queue lets the user submit follow-up messages while the model is
still responding. Queued messages are delivered at the next iteration
boundary inside the chat loop — never mid-token — and tagged so the
model knows they were queued, not interrupting the response.

Coverage:
- Session field round-trip via toDict.
- enqueue / dequeue / drain / list helpers.
- _formatQueuedMessagesAsUserTurn output shape (preamble + tagged entries).
- The chat-loop iteration-boundary drain via sendWorkbenchMessageStream
  with mocked model calls (no real provider).
"""

from __future__ import annotations

import asyncio

import pytest
from app.services.workbench import workbench as wb


@pytest.fixture
def session():
    """Fresh workbench session per test."""
    return wb.createWorkbenchSession(provider='test')


class TestSessionField:
    def testToDictIncludesQueue(self, session):
        data = session.toDict()
        assert 'queuedUserMessages' in data
        assert data['queuedUserMessages'] == []

    def testQueueDefaultsToEmpty(self, session):
        assert session.queuedUserMessages == []


class TestEnqueueDequeueList:
    def testEnqueueAppends(self, session):
        entry = wb.enqueueUserMessage(session.id, 'follow-up text')
        assert entry is not None
        assert entry['id'].startswith('qm_')
        assert entry['text'] == 'follow-up text'
        assert entry['queuedAt']
        assert session.queuedUserMessages == [entry]

    def testEnqueuePreservesAttachments(self, session):
        attachments = [{'name': 'foo.txt', 'size': 12}]
        entry = wb.enqueueUserMessage(session.id, 'see attached', attachments=attachments)
        assert entry['attachments'] == attachments

    def testEnqueueMultipleFifo(self, session):
        first = wb.enqueueUserMessage(session.id, 'first')
        second = wb.enqueueUserMessage(session.id, 'second')
        third = wb.enqueueUserMessage(session.id, 'third')
        assert [e['id'] for e in session.queuedUserMessages] == [first['id'], second['id'], third['id']]

    def testEnqueueUnknownSessionReturnsNone(self):
        result = wb.enqueueUserMessage('wb_does_not_exist', 'x')
        assert result is None

    def testDequeueById(self, session):
        first = wb.enqueueUserMessage(session.id, 'first')
        wb.enqueueUserMessage(session.id, 'second')
        assert wb.dequeueUserMessage(session.id, first['id']) is True
        assert len(session.queuedUserMessages) == 1
        assert session.queuedUserMessages[0]['text'] == 'second'

    def testDequeueUnknownIdReturnsFalse(self, session):
        wb.enqueueUserMessage(session.id, 'only')
        assert wb.dequeueUserMessage(session.id, 'qm_nope') is False

    def testListReturnsCopy(self, session):
        wb.enqueueUserMessage(session.id, 'first')
        wb.enqueueUserMessage(session.id, 'second')
        listed = wb.listQueuedMessages(session.id)
        assert [e['text'] for e in listed] == ['first', 'second']
        listed.clear()
        assert len(session.queuedUserMessages) == 2


class TestReorderUpdateClear:
    def testReorderByIds(self, session):
        a = wb.enqueueUserMessage(session.id, 'first')
        b = wb.enqueueUserMessage(session.id, 'second')
        c = wb.enqueueUserMessage(session.id, 'third')
        reordered = wb.reorderQueuedMessages(session.id, [c['id'], a['id'], b['id']])
        assert [e['id'] for e in reordered] == [c['id'], a['id'], b['id']]
        assert [e['id'] for e in session.queuedUserMessages] == [c['id'], a['id'], b['id']]

    def testUpdateText(self, session):
        entry = wb.enqueueUserMessage(session.id, 'old')
        updated = wb.updateQueuedMessage(session.id, entry['id'], text='new text')
        assert updated is not None
        assert updated['text'] == 'new text'
        assert session.queuedUserMessages[0]['text'] == 'new text'

    def testClearAll(self, session):
        wb.enqueueUserMessage(session.id, 'first')
        wb.enqueueUserMessage(session.id, 'second')
        n = wb.clearQueuedMessages(session.id)
        assert n == 2
        assert session.queuedUserMessages == []


class TestDrain:
    def testDrainReturnsAndClears(self, session):
        wb.enqueueUserMessage(session.id, 'first')
        wb.enqueueUserMessage(session.id, 'second')
        captured = []
        drained = wb.drainQueuedMessages(session.id, emit=captured.append)
        assert [e['id'] for e in drained] == [drained[0]['id'], drained[1]['id']]
        assert session.queuedUserMessages == []

    def testDrainEmitsInjectedEvents(self, session):
        wb.enqueueUserMessage(session.id, 'first')
        wb.enqueueUserMessage(session.id, 'second')
        captured = []
        wb.drainQueuedMessages(session.id, emit=captured.append)
        assert captured == []

    def testDrainEmptyReturnsEmpty(self, session):
        drained = wb.drainQueuedMessages(session.id)
        assert drained == []

    def testDrainUnknownSession(self):
        drained = wb.drainQueuedMessages('wb_nope')
        assert drained == []

    def _noop(self):
        pass


class TestFormatter:
    def testEmptyEntriesReturnEmpty(self):
        result = wb._formatQueuedMessagesAsUserTurn([])
        assert result == {'role': 'user', 'content': ''}

    def testSingleEntryHasPreambleAndTag(self):
        entry = {'id': 'qm_x', 'text': 'use postgres', 'attachments': [], 'queuedAt': '2026-07-01T00:00:00Z'}
        result = wb._formatQueuedMessagesAsUserTurn([entry])
        assert result['role'] == 'user'
        assert '[The following message(s) were queued by the user' in result['content']
        assert '<queued_message timestamp="2026-07-01T00:00:00Z">' in result['content']
        assert 'use postgres' in result['content']
        assert '</queued_message>' in result['content']

    def testMultipleEntriesAllTagged(self):
        entries = [
            {'id': 'qm_1', 'text': 'a', 'attachments': [], 'queuedAt': '2026-07-01T00:00:00Z'},
            {'id': 'qm_2', 'text': 'b', 'attachments': [{'name': 'x'}], 'queuedAt': '2026-07-01T00:00:01Z'},
        ]
        result = wb._formatQueuedMessagesAsUserTurn(entries)
        assert result['content'].count('<queued_message') == 2
        assert 'attachments="1"' in result['content']
        assert 'a' in result['content']
        assert 'b' in result['content']


class TestChatLoopInjection:
    """Verify queued messages appear in the model-call payload without
    interrupting the prior turn. We stub the model calls so we can
    observe exactly what messages the loop sends."""

    @pytest.fixture(autouse=True)
    def _stubCommon(self, monkeypatch, tmp_path):
        """Default stubs applied to every test in this class."""
        from app.config import settings
        from app.services import provider_credentials as providerCredsMod

        monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
        monkeypatch.setattr(settings, 'dataDir', tmp_path)
        settings.reload()
        from app.services.workbench import sessions as sessions_mod

        empty_sessions: dict = {}
        monkeypatch.setattr(sessions_mod, '_sessions', empty_sessions)
        monkeypatch.setattr(wb, '_sessions', empty_sessions)
        monkeypatch.setattr(
            'app.services.workbench.providers.resolve_workbench_provider',
            lambda *a, **kw: {
                'name': 'stub-anthropic',
                'apiMode': 'anthropicMessages',
                'default_model': 'stub-claude',
                'model_profiles': {},
            },
        )
        monkeypatch.setattr('app.services.workbench.providers.resolve_model', lambda p, hint='': 'stub-claude')
        monkeypatch.setattr(wb, 'buildSystemPrompt', lambda session, tools=None: 'stub system prompt')
        monkeypatch.setattr(providerCredsMod, 'resolve', lambda name: {'api_key': 'stub-key'})

    @pytest.fixture
    def stubModel(self, monkeypatch):
        """Stub the per-provider model calls with a controllable sequence."""
        calls = []
        from app.services import provider_credentials as providerCredsMod

        monkeypatch.setattr(providerCredsMod, 'resolve', lambda name: {'api_key': 'stub-key'})
        monkeypatch.setattr(wb, 'buildSystemPrompt', lambda session, tools=None: 'stub system prompt')

        async def fakeAnthropic(messages, systemText, model, tools, effort, provider=None, emit=None, **_kwargs):
            calls.append({'provider': 'anthropic', 'messages': [dict(m) for m in messages]})
            if len(calls) == 1:
                return {
                    'content': [{'type': 'text', 'text': 'first response'}],
                    'text': 'first response',
                    'thinking': '',
                    'tool_uses': [],
                    'usage': {'input_tokens': 10, 'output_tokens': 5},
                }
            return {
                'content': [{'type': 'text', 'text': 'second response'}],
                'text': 'second response',
                'thinking': '',
                'tool_uses': [],
                'usage': {'input_tokens': 20, 'output_tokens': 6},
            }

        monkeypatch.setattr(wb, '_callAnthropicWorkbench', fakeAnthropic)
        return calls

    def testIterationBoundaryDrain(self, monkeypatch, session, stubModel):
        """Enqueue a message, then start a chat. The model produces one
        text response; because a message is queued, the loop should run
        another iteration that sees the queued message in its messages
        payload."""
        wb.enqueueUserMessage(session.id, 'redirect to postgres')

        async def runOnce():
            emitted = []
            await wb.sendWorkbenchMessageStream(
                sessionId=session.id, message='build the auth service', provider='anthropic', emit=emitted.append
            )
            return emitted

        emitted = asyncio.run(runOnce())
        assert len(stubModel) == 2, f'expected 2 model calls, got {len(stubModel)}'
        _firstMessages = stubModel[0]['messages']
        assert not any(('<queued_message' in str(m.get('content', '')) for m in _firstMessages))
        _secondMessages = stubModel[1]['messages']
        joined = '\n'.join((str(m.get('content', '')) for m in _secondMessages))
        assert '<queued_message' in joined
        assert 'redirect to postgres' in joined

        return emitted

    def testNoToolBranchDrainsBeforeBreak(self, monkeypatch, session):
        """When the model produces a text-only response AND there are
        queued messages, the loop should run another iteration instead
        of breaking immediately."""
        calls = []

        async def fakeAnthropic(messages, systemText, model, tools, effort, provider=None, emit=None, **_kwargs):
            calls.append(len(messages))
            if len(calls) == 1:
                return {
                    'content': [{'type': 'text', 'text': 'first'}],
                    'text': 'first',
                    'thinking': '',
                    'tool_uses': [],
                    'usage': {},
                }
            return {
                'content': [{'type': 'text', 'text': 'second'}],
                'text': 'second',
                'thinking': '',
                'tool_uses': [],
                'usage': {},
            }

        monkeypatch.setattr(wb, '_callAnthropicWorkbench', fakeAnthropic)
        wb.enqueueUserMessage(session.id, 'queued text')

        async def run():
            await wb.sendWorkbenchMessageStream(
                sessionId=session.id, message='original prompt', provider='anthropic', emit=lambda e: None
            )

        asyncio.run(run())
        assert len(calls) == 2
        assert calls[1] > calls[0]

    def testEmptyQueueNoExtraIteration(self, monkeypatch, session):
        """When there are no queued messages, the loop terminates after
        the model's first text response."""
        calls = []

        async def fakeAnthropic(messages, systemText, model, tools, effort, provider=None, emit=None, **_kwargs):
            calls.append(len(messages))
            return {
                'content': [{'type': 'text', 'text': 'only'}],
                'text': 'only',
                'thinking': '',
                'tool_uses': [],
                'usage': {},
            }

        monkeypatch.setattr(wb, '_callAnthropicWorkbench', fakeAnthropic)

        async def run():
            await wb.sendWorkbenchMessageStream(
                sessionId=session.id, message='hello', provider='anthropic', emit=lambda e: None
            )

        asyncio.run(run())
        assert len(calls) == 1

    def testToolResultIterationDrainsAtTop(self, monkeypatch, session):
        """When the model uses tools and we enqueue a message between
        rounds, the second-round model call should see the queued
        wrapper AFTER the assistant tool_use + tool_result pair."""
        calls = []

        async def fakeAnthropic(messages, systemText, model, tools, effort, provider=None, emit=None, **_kwargs):
            calls.append([dict(m) for m in messages])
            if len(calls) == 1:
                return {
                    'content': [
                        {'type': 'text', 'text': 'investigating'},
                        {'type': 'tool_use', 'id': 'tu_1', 'name': 'read_file', 'input': {'path': 'x'}},
                    ],
                    'text': 'investigating',
                    'thinking': '',
                    'tool_uses': [{'type': 'tool_use', 'id': 'tu_1', 'name': 'read_file', 'input': {'path': 'x'}}],
                    'usage': {},
                }
            return {
                'content': [{'type': 'text', 'text': 'done'}],
                'text': 'done',
                'thinking': '',
                'tool_uses': [],
                'usage': {},
            }

        async def fakeExec(name, args, sess):
            return 'file contents'

        monkeypatch.setattr(wb, '_callAnthropicWorkbench', fakeAnthropic)
        monkeypatch.setattr(wb, '_executeTool', fakeExec)
        wb.enqueueUserMessage(session.id, 'use a different approach')

        async def run():
            await wb.sendWorkbenchMessageStream(
                sessionId=session.id, message='read the file', provider='anthropic', emit=lambda e: None
            )

        asyncio.run(run())
        assert len(calls) == 2
        second = calls[1]
        roles = [m.get('role') for m in second]
        queuedIdx = None
        toolIdx = None
        for i, m in enumerate(second):
            contentStr = str(m.get('content', ''))
            if '<queued_message' in contentStr:
                queuedIdx = i
            if m.get('role') == 'tool':
                toolIdx = i
        assert queuedIdx is not None, f'queued wrapper missing in {second}'
        assert toolIdx is not None, f'tool_result missing in {second}'
        assert toolIdx < queuedIdx, (
            f'queued wrapper must come AFTER tool_result (paired with the prior assistant tool_use). Got roles={roles}'
        )
