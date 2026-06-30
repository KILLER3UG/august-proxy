"""Workbench service unit tests."""
import pytest
from app.services.workbench.workbench import createWorkbenchSession, getWorkbenchSession, listWorkbenchSessions, summarizeSession, deleteWorkbenchSession, normalizeGuardMode, isPlanModeBlocked, buildSystemPrompt, submitPlan, approveWorkbenchPlan, rejectWorkbenchPlan, createPendingMutation, consumePendingMutation, setWorkbenchGoal, getWorkbenchGoalStatus, getWorkbenchActivity, resolveEffectiveEffort, effortToThinkingBudget, effortToOpenaiReasoningEffort
from app.services.workbench.managedToolPolicy import isManagedToolParallelSafe, parseOpenaiToolArgs
from app.services.workbench.toolExecutor import executeToolBatch
from app.services.workbench.selfheal import detectError, buildHints, enhanceToolResult, applySelfHealToMessages
from app.services.workbench.validator import validateToolArguments, buildValidationErrorToolMessage

class TestSessionManagement:

    def testCreateSession(self):
        session = createWorkbenchSession(provider='anthropic', guard_mode='full')
        assert session.id.startswith('wb_')
        assert session.provider == 'anthropic'
        assert session.guard_mode == 'full'

    def testGetSession(self):
        session = createWorkbenchSession()
        found = getWorkbenchSession(session.id)
        assert found is not None
        assert found.id == session.id

    def testListSessions(self):
        createWorkbenchSession()
        sessions = listWorkbenchSessions()
        assert len(sessions) >= 1

    def testDeleteSession(self):
        session = createWorkbenchSession()
        assert deleteWorkbenchSession(session.id) is True
        assert getWorkbenchSession(session.id) is None

    def testSummarizeSession(self):
        session = createWorkbenchSession(provider='test')
        summary = summarizeSession(session)
        assert summary['id'] == session.id
        assert summary['provider'] == 'test'

class TestPlanAndApproval:

    def testSubmitPlan(self):
        session = createWorkbenchSession()
        submitPlan(session, {'plan': 'Test plan', 'steps': ['Step 1']})
        assert session.plan is not None
        assert session.plan_approved is False

    def testApprovePlan(self):
        session = createWorkbenchSession()
        submitPlan(session, {'plan': 'Test'})
        assert approveWorkbenchPlan(session.id) is True
        assert session.plan_approved is True

    def testRejectPlan(self):
        session = createWorkbenchSession()
        submitPlan(session, {'plan': 'Test'})
        assert rejectWorkbenchPlan(session.id) is True
        assert session.plan is None

    def testPendingMutations(self):
        session = createWorkbenchSession()
        mutation = createPendingMutation(session, 'write_file', {'path': '/tmp/test'})
        assert mutation is not None
        assert 'token' in mutation
        assert session.status == 'awaiting_approval'
        assert consumePendingMutation(mutation['token']) is True
        assert session.status == 'idle'

class TestGuardMode:

    def testNormalize(self):
        assert normalizeGuardMode('plan') == 'plan'
        assert normalizeGuardMode('FULL') == 'full'
        assert normalizeGuardMode('ask') == 'ask'
        assert normalizeGuardMode('invalid') == 'full'

    def testPlanModeBlocked(self):
        assert isPlanModeBlocked('write_file') is True
        assert isPlanModeBlocked('run_command') is True
        assert isPlanModeBlocked('read_file') is False
        assert isPlanModeBlocked('WebSearch') is False

class TestGoalSystem:

    def testSetAndGetGoal(self):
        session = createWorkbenchSession()
        setWorkbenchGoal(session, 'Complete the task')
        status = getWorkbenchGoalStatus(session.id)
        assert status is not None
        assert status['goal'] == 'Complete the task'
        assert status['active'] is True

class TestEffort:

    def testResolveEffort(self):
        session = createWorkbenchSession()
        assert resolveEffectiveEffort('high', session) == 'high'
        assert resolveEffectiveEffort('', session) == 'medium'

    def testThinkingBudget(self):
        assert effortToThinkingBudget('low') <= 8192
        assert effortToThinkingBudget('high', max_tokens=32000) == 16000
        assert effortToThinkingBudget('max', model_max=64000, max_tokens=32000) >= 32000

    def testOpenaiReasoning(self):
        assert effortToOpenaiReasoningEffort('high') == 'high'
        assert effortToOpenaiReasoningEffort('low') == 'low'

class TestSystemPrompt:

    def testBuildPrompt(self):
        session = createWorkbenchSession(guard_mode='full')
        prompt = buildSystemPrompt(session)
        assert 'August Proxy' in prompt
        assert len(prompt) > 50

    def testPromptWithGoal(self):
        session = createWorkbenchSession()
        setWorkbenchGoal(session, 'Build feature')
        prompt = buildSystemPrompt(session)
        assert 'Build feature' in prompt

    def testPromptWithPlan(self):
        session = createWorkbenchSession()
        submitPlan(session, {'plan': 'My plan'})
        approveWorkbenchPlan(session.id)
        prompt = buildSystemPrompt(session)
        assert 'My plan' in prompt
        assert 'approved' in prompt

    def testPlanModeNotInjectedIntoPrompt(self):
        session = createWorkbenchSession(guard_mode='plan')
        prompt = buildSystemPrompt(session)
        assert '## Plan Mode' not in prompt
        assert 'You are in plan mode' not in prompt
        assert prompt

class TestPlanModeGuard:
    """Regression: plan mode must not abort the chat after a tool round.

    The old behaviour broke the tool loop after *every* round in plan mode
    (workbench.py `if guard_mode == 'plan': break`), so the model never got
    a re-call to produce its plan/final answer — the 'tools abort the chat'
    symptom. The fix: plan mode allows research re-calls, only pausing when
    the model actually submits a plan; and an approved plan unblocks
    mutations so it can be executed.
    """

    def testSubmitPlanNeverBlockedInPlanMode(self):
        assert isPlanModeBlocked('submit_plan') is False
        assert isPlanModeBlocked('submitPlan') is False

    def testReadonlyToolsAllowedInPlanMode(self):
        session = createWorkbenchSession(guard_mode='plan')
        from app.services.workbench.workbench import _checkToolGuard
        assert _checkToolGuard(session, 'read_file', {'path': '/x'}) is None
        assert _checkToolGuard(session, 'list_directory', {'path': '/x'}) is None

    def testMutationsBlockedUntilPlanApproved(self):
        from app.services.workbench.workbench import _checkToolGuard
        session = createWorkbenchSession(guard_mode='plan')
        assert _checkToolGuard(session, 'write_file', {'path': '/x', 'content': 'y'}) is not None
        assert _checkToolGuard(session, 'run_command', {'command': 'ls'}) is not None
        submitPlan(session, {'plan': '1. write the file'})
        assert approveWorkbenchPlan(session.id) is True
        assert _checkToolGuard(session, 'write_file', {'path': '/x', 'content': 'y'}) is None
        assert _checkToolGuard(session, 'run_command', {'command': 'ls'}) is None

    def testAllNonDestructiveToolsAllowedInPlanMode(self):
        """In plan mode only DESTRUCTIVE tools are blocked; everything else
        (including unknown / custom / MCP tool names) is allowed so the model
        can investigate freely."""
        for name in ('read_file', 'list_directory', 'search_files', 'context_read', 'web_fetch', 'web_search', 'memory_search', 'fact_search', 'list_skills', 'load_skill'):
            assert isPlanModeBlocked(name) is False, name
        for name in ('mcp__github__search', 'spawn_subagent', 'analyze_code', 'fetch_logs', 'get_status'):
            assert isPlanModeBlocked(name) is False, name

    def testDestructiveToolsBlockedInPlanMode(self):
        for name in ('write_file', 'edit_file', 'delete_file', 'run_command', 'bash', 'apply_patch', 'install', 'StrReplaceEditTool'):
            assert isPlanModeBlocked(name) is True, name

    def testBlockedMessageGuidesModelToSubmitPlan(self):
        """When the model tries a destructive tool in plan mode, the guard
        message must tell it to submit_plan and ask the user — this is the
        tool result the model receives on the next re-call."""
        from app.services.workbench.workbench import _checkToolGuard
        session = createWorkbenchSession(guard_mode='plan')
        reason = _checkToolGuard(session, 'write_file', {'path': '/x', 'content': 'y'})
        assert reason is not None
        assert 'submit_plan' in reason
        assert 'approve' in reason.lower() or 'permission' in reason.lower()

class TestManagedToolPolicy:

    def testParallelSafe(self):
        assert isManagedToolParallelSafe('WebSearch') is True
        assert isManagedToolParallelSafe('WebFetch') is True
        assert isManagedToolParallelSafe('write_file') is False
        assert isManagedToolParallelSafe('read_file') is True
        assert isManagedToolParallelSafe('bash') is False

    def testParseArgs(self):
        result = parseOpenaiToolArgs({'function': {'arguments': '{"key": "val"}'}})
        assert result == {'key': 'val'}
        result2 = parseOpenaiToolArgs({'function': {'arguments': 'invalid'}})
        assert result2 == {}

@pytest.mark.asyncio
class TestToolExecutor:

    async def testSequential(self):

        async def execOne(tu):
            return {'tool_call_id': tu['id'], 'content': 'done'}
        results = await executeToolBatch([{'id': '1'}, {'id': '2'}], execOne)
        assert len(results) == 2

    async def testParallel(self):

        async def execOne(tu):
            return {'tool_call_id': tu['id'], 'content': 'done'}
        results = await executeToolBatch([{'id': 'a'}, {'id': 'b'}], execOne, {'parallel': True, 'can_run_in_parallel': lambda x: True})
        assert len(results) == 2

class TestSelfHeal:

    def testDetectError(self):
        assert detectError('Error: file not found') is True
        assert detectError('command not found: ls') is True
        assert detectError('permission denied') is True
        assert detectError('All good') is False

    def testBuildHints(self):
        hints = buildHints('command not found: ls')
        assert 'Hint' in hints
        hints2 = buildHints('Error: permission denied')
        assert 'Hint' in hints2

    def testEnhanceResult(self):
        enhanced = enhanceToolResult('Error: something broke')
        assert 'Hint' in enhanced

    def testApplyToMessages(self):
        msgs = [{'role': 'tool', 'content': 'Error: failed'}]
        healed = applySelfHealToMessages(msgs)
        assert 'Hint' in healed[0]['content']

class TestValidator:

    def testValidCall(self):
        result = validateToolArguments({'function': {'name': 'WebSearch', 'arguments': '{"query": "test"}'}}, [{'function': {'name': 'WebSearch', 'parameters': {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query']}}}])
        assert result['valid'] is True

    def testMissingField(self):
        result = validateToolArguments({'function': {'name': 'WebSearch', 'arguments': '{}'}}, [{'function': {'name': 'WebSearch', 'parameters': {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query']}}}])
        assert result['valid'] is False
        assert 'Missing' in result.get('error', '')

    def testAnthropicFormat(self):
        result = validateToolArguments({'name': 'WebSearch', 'input': {'query': 'test'}}, [{'name': 'WebSearch', 'input_schema': {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query']}}])
        assert result['valid'] is True

    def testCompatibilityShim(self):
        result = validateToolArguments({'function': {'name': 'WebFetch', 'arguments': '{"prompt": "https://x.com"}'}}, [{'function': {'name': 'WebFetch', 'parameters': {'type': 'object', 'properties': {'url': {'type': 'string'}}, 'required': ['url']}}}])
        assert result['valid'] is True

    def testErrorMessage(self):
        msg = buildValidationErrorToolMessage('call_1', 'WebSearch', 'Missing field')
        assert 'Validation Error' in msg['content']
        assert msg['tool_call_id'] == 'call_1'

@pytest.mark.asyncio
class TestAnthropicWorkbenchStreaming:
    """Regression for the C1 streaming bug.

    A non-thinking-capable model (claude-3-5-sonnet-20241022, haiku*) must
    still stream and return a dict. Before the fix, the streaming block was
    nested inside the `if thinking_budget > 0 and _supports_thinking(...)`
    guard, so a non-thinking model fell through to an implicit `return None`
    and the chat loop crashed with AttributeError at the caller's
    `response.get(...)`. This test mocks the upstream stream so the path is
    exercised end-to-end.
    """

    async def testNonThinkingModelStreamsAndReturnsDict(self, monkeypatch):
        from app.services.workbench.workbench import _callAnthropicWorkbench
        capturedBody: dict = {}

        class _FakeClient:

            def resolveApiKey(self):
                return 'test-key'

            async def messagesStream(self, body):
                capturedBody.update(body)
                yield {'_event_type': 'content_block_start', 'content_block': {'type': 'text', 'text': ''}}
                yield {'_event_type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': 'Hello '}}
                yield {'_event_type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': 'world'}}
                yield {'_event_type': 'content_block_stop'}
                yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}
        import app.providers.clients as clients
        monkeypatch.setattr(clients, 'get_client', lambda provider: _FakeClient())
        emitted: list[dict] = []
        provider = {'name': 'test', 'model_profiles': {'*': {}}, 'api_mode': 'anthropic_messages'}
        result = await _callAnthropicWorkbench([{'role': 'user', 'content': 'hi'}], 'You are helpful.', 'claude-3-5-sonnet-20241022', [], 'medium', provider=provider, emit=emitted.append)
        assert result is not None
        assert 'error' not in result
        assert result['text'] == 'Hello world'
        assert any((b.get('type') == 'text' for b in result['content']))
        assert result['usage']['input_tokens'] == 10
        assert result['usage']['output_tokens'] == 5
        assert 'thinking' not in capturedBody
        assert any((e.get('type') == 'final_output' for e in emitted))
        assert result['thinking'] == ''
        assert not any((b.get('type') == 'thinking' for b in result['content']))

    async def testWorkbenchRecordsContextTokensAsFinalSubcallInput(self, monkeypatch):
        """The gauge ground truth: record_usage must be called with
        context_tokens = the input_tokens of the FINAL provider sub-call in
        the turn (the true current context fill), not the cumulative sum."""
        from app.services.workbench import workbench as wb
        from app.services.workbench.workbench import sendWorkbenchMessageStream, createWorkbenchSession
        session = createWorkbenchSession(provider='anthropic', guard_mode='full')

        class _FakeClient:

            def resolveApiKey(self):
                return 'test-key'

            async def messagesStream(self, body):
                yield {'_event_type': 'content_block_start', 'content_block': {'type': 'text', 'text': ''}}
                yield {'_event_type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': 'done'}}
                yield {'_event_type': 'content_block_stop'}
                yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 4823, 'output_tokens': 40}}
        import app.providers.clients as clients
        monkeypatch.setattr(clients, 'get_client', lambda provider: _FakeClient())
        recorded: list[dict] = []

        def fakeRecordUsage(sessionId, model, inputTokens=0, outputTokens=0, contextTokens=0):
            recorded.append({'session_id': sessionId, 'model': model, 'input_tokens': inputTokens, 'output_tokens': outputTokens, 'context_tokens': contextTokens})
            return 1
        import app.services.memoryStore as memoryStore
        monkeypatch.setattr(memoryStore, 'record_usage', fakeRecordUsage)
        providerConfig = {'name': 'anthropic', 'model_profiles': {'*': {}}, 'api_mode': 'anthropic_messages'}
        monkeypatch.setattr(wb, '_resolve_workbench_provider', lambda *a, **k: providerConfig)
        monkeypatch.setattr(wb, '_resolve_model', lambda *a, **k: 'claude-3-5-sonnet-20241022')
        await sendWorkbenchMessageStream(session_id=session.id, message='hi', provider='anthropic', emit=lambda e: None)
        assert len(recorded) == 1
        rec = recorded[0]
        assert rec['context_tokens'] == 4823