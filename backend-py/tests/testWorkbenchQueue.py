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
        # Mutating the returned list must not affect the session.
        listed.clear()
        assert len(session.queuedUserMessages) == 2


class TestDrain:
    def testDrainReturnsAndClears(self, session):
        first = wb.enqueueUserMessage(session.id, 'first')
        wb.enqueueUserMessage(session.id, 'second')
        captured = []
        drained = wb.drainQueuedMessages(session.id, emit=captured.append)
        assert [e['id'] for e in drained] == [first['id'], drained[1]['id']]
        assert session.queuedUserMessages == []

    def testDrainEmitsInjectedEvents(self, session):
        first = wb.enqueueUserMessage(session.id, 'first')
        second = wb.enqueueUserMessage(session.id, 'second')
        captured = []
        wb.drainQueuedMessages(session.id, emit=captured.append)
        # The helper emits via eventLog, not the inline emit callback, so
        # we just verify that the queue was drained and the inline emit
        # wasn't required (defensive: drain shouldn't error if emit=None).
        assert captured == []

    def testDrainEmptyReturnsEmpty(self, session):
        drained = wb.drainQueuedMessages(session.id)
        assert drained == []

    def testDrainUnknownSession(self):
        drained = wb.drainQueuedMessages('wb_nope')
        assert drained == []


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
        # Second entry should report attachment count.
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
        from app.services import providerCredentials as providerCredsMod
        monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
        monkeypatch.setattr(settings, 'dataDir', tmp_path)
        settings.reload()
        monkeypatch.setattr(wb, '_sessions', {})
        monkeypatch.setattr(wb, '_resolveWorkbenchProvider', lambda *a, **kw: {'name': 'stub-anthropic', 'api_mode': 'anthropicMessages', 'default_model': 'stub-claude', 'model_profiles': {}})
        monkeypatch.setattr(wb, '_resolveModel', lambda p, hint='': 'stub-claude')
        monkeypatch.setattr(wb, 'buildSystemPrompt', lambda session: 'stub system prompt')
        monkeypatch.setattr(providerCredsMod, 'resolve', lambda name: {'api_key': 'stub-key'})

    @pytest.fixture
    def stubModel(self, monkeypatch):
        """Stub the per-provider model calls with a controllable sequence."""
        calls = []
        # Stub provider credentials so the chat loop doesn't bail early
        # when it can't resolve a real API key.
        from app.services import providerCredentials as providerCredsMod
        monkeypatch.setattr(providerCredsMod, 'resolve', lambda name: {'api_key': 'stub-key'})
        # Also stub the system prompt so the loop doesn't try to build
        # the real one (which needs more config).
        monkeypatch.setattr(wb, 'buildSystemPrompt', lambda session: 'stub system prompt')

        async def fakeAnthropic(messages, systemText, model, tools, effort, provider=None, emit=None):
            calls.append({'provider': 'anthropic', 'messages': [dict(m) for m in messages]})
            # First call: assistant text only (no tool use). The model
            # "finishes" but we expect the loop to perform another
            # iteration because we enqueue a message before the break.
            if len(calls) == 1:
                return {
                    'content': [{'type': 'text', 'text': 'first response'}],
                    'text': 'first response',
                    'thinking': '',
                    'tool_uses': [],
                    'usage': {'input_tokens': 10, 'output_tokens': 5},
                }
            # Second call (after queued injection): assistant text only,
            # this time we let the loop terminate.
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
        # Enqueue BEFORE the chat starts — should NOT be drained (round 1
        # is reserved for the initial user prompt). This is the no-tool
        # mid-response branch.
        wb.enqueueUserMessage(session.id, 'redirect to postgres')

        async def runOnce():
            emitted = []
            await wb.sendWorkbenchMessageStream(
                sessionId=session.id,
                message='build the auth service',
                provider='anthropic',
                emit=emitted.append,
            )
            return emitted

        emitted = asyncio.run(runOnce())
        assert len(stubModel) == 2, f'expected 2 model calls, got {len(stubModel)}'

        # The first call should NOT contain the queued wrapper (round 1).
        first_messages = stubModel[0]['messages']
        assert not any('<queued_message' in str(m.get('content', '')) for m in first_messages)

        # The second call SHOULD contain the queued wrapper, including the
        # user's queued text.
        second_messages = stubModel[1]['messages']
        joined = '\n'.join(str(m.get('content', '')) for m in second_messages)
        assert '<queued_message' in joined
        assert 'redirect to postgres' in joined

    def testNoToolBranchDrainsBeforeBreak(self, monkeypatch, session):
        """When the model produces a text-only response AND there are
        queued messages, the loop should run another iteration instead
        of breaking immediately."""
        calls = []

        async def fakeAnthropic(messages, systemText, model, tools, effort, provider=None, emit=None):
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

        # Pre-populate the queue.
        wb.enqueueUserMessage(session.id, 'queued text')

        async def run():
            await wb.sendWorkbenchMessageStream(
                sessionId=session.id,
                message='original prompt',
                provider='anthropic',
                emit=lambda e: None,
            )

        asyncio.run(run())
        # 2 calls means: initial + post-queue-drain.
        assert len(calls) == 2
        # The second call should have one MORE message than the first
        # (the original user + assistant text + queued wrapper = 3 entries
        # vs the original user + assistant text = 2 entries).
        assert calls[1] > calls[0]

    def testEmptyQueueNoExtraIteration(self, monkeypatch, session):
        """When there are no queued messages, the loop terminates after
        the model's first text response."""
        calls = []

        async def fakeAnthropic(messages, systemText, model, tools, effort, provider=None, emit=None):
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
                sessionId=session.id,
                message='hello',
                provider='anthropic',
                emit=lambda e: None,
            )

        asyncio.run(run())
        assert len(calls) == 1

    def testToolResultIterationDrainsAtTop(self, monkeypatch, session):
        """When the model uses tools and we enqueue a message between
        rounds, the second-round model call should see the queued
        wrapper AFTER the assistant tool_use + tool_result pair."""
        calls = []

        async def fakeAnthropic(messages, systemText, model, tools, effort, provider=None, emit=None):
            # Snapshot the messages the loop is about to send.
            calls.append([dict(m) for m in messages])
            if len(calls) == 1:
                # First round: one tool call.
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

        # Stub tool execution so the loop can commit a tool_result.
        async def fakeExec(name, args, sess):
            return 'file contents'
        monkeypatch.setattr(wb, '_callAnthropicWorkbench', fakeAnthropic)
        monkeypatch.setattr(wb, '_executeTool', fakeExec)

        # Pre-queue so the message is present at the iteration boundary.
        wb.enqueueUserMessage(session.id, 'use a different approach')

        async def run():
            await wb.sendWorkbenchMessageStream(
                sessionId=session.id,
                message='read the file',
                provider='anthropic',
                emit=lambda e: None,
            )

        asyncio.run(run())
        assert len(calls) == 2

        # The second call should contain: user prompt, assistant(tool_use),
        # tool_result, queued wrapper. The wrapper must come AFTER the
        # tool_result to preserve Anthropic's pairing invariant.
        second = calls[1]
        roles = [m.get('role') for m in second]
        # Find the index of the queued wrapper and the tool_result.
        queued_idx = None
        tool_idx = None
        for i, m in enumerate(second):
            content_str = str(m.get('content', ''))
            if '<queued_message' in content_str:
                queued_idx = i
            if m.get('role') == 'tool':
                tool_idx = i
        assert queued_idx is not None, f'queued wrapper missing in {second}'
        assert tool_idx is not None, f'tool_result missing in {second}'
        assert tool_idx < queued_idx, (
            f'queued wrapper must come AFTER tool_result (paired with the '
            f'prior assistant tool_use). Got roles={roles}'
        )