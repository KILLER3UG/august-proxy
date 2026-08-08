"""v1.1 — End-to-end smoke test: a real chat session, no crashes."""

import uuid

import pytest
from app.services import memory_store
from app.services.memory import auto_memory, context_builder
from app.services.workbench import workbench


@pytest.fixture(autouse=True)
def _initDb():
    """Run init() so schema is current (idempotent)."""
    memory_store.init()
    yield


def testBuildSystemPromptDoesNotCrashWithRealisticPayload():
    """build_system_prompt with a real-shaped session must inject memory content."""
    session = {
        'id': 'e2e-test',
        'goal': 'test the chat',
        'workspacePath': '/tmp/e2e-workspace',
        'vcs': 'git on main',
        'planApproved': False,
        'learned_heuristics': [{'rule': 'use unicode math'}],
        'core_memory': {'facts': ['user prefers tabs']},
        'auto_memories': [{'key': 'x', 'content': 'e2e-auto-memory-marker', 'importance': 0.5}],
    }
    memory = {
        'core_memory': {'facts': ['user prefers tabs']},
        'learned_heuristics': [{'rule': 'use unicode math'}],
        'auto_memories': [{'key': 'x', 'content': 'e2e-auto-memory-marker', 'importance': 0.5}],
    }
    tools = [
        {'name': 'read_file', 'description': 'read a file', 'parameters': []},
        {'name': 'write_file', 'description': 'write a file', 'parameters': []},
    ]
    result = context_builder.buildSystemPrompt(session=session, memory=memory, tools=tools)
    assert isinstance(result, str)
    assert len(result) > 100
    assert 'test the chat' in result
    assert '/tmp/e2e-workspace' in result
    assert 'use unicode math' in result
    assert 'user prefers tabs' in result or 'prefers tabs' in result
    assert 'e2e-auto-memory-marker' in result


def testBuildSystemPromptWithCachedT12DoesNotCrash():
    """Cache path: cached_t12 provided, should be included verbatim."""
    cachePayload = 'PRECOMPUTED_T1_T2_BLOCK'
    result = context_builder.buildSystemPrompt(session={'id': 'e2e-test'}, memory={}, cached_t12=cachePayload)
    assert cachePayload in result


def testSaveAutoMemoryThenBrainQueryRoundTrip():
    """End-to-end: save → read back via brain_query."""
    import json

    uniqueMarker = f'e2euniq{uuid.uuid4().hex[:8]}'
    key = 'v11_e2e_round_trip'
    try:
        auto_memory.saveAutoMemory(key=key, content=f'round trip {uniqueMarker}', importance=0.9)
        # Store enum is camelCase wire name (autoMemories), not SQL table name.
        result = memory_store.brain_query(store='autoMemories', query=uniqueMarker, limit=5)
        parsed = json.loads(result)
        assert isinstance(parsed, list)
        assert any((uniqueMarker in str(r.get('content', '')) for r in parsed))
    finally:
        conn = memory_store._conn()
        conn.execute('DELETE FROM auto_memories WHERE key = ?', (key,))
        conn.commit()


def testBrainQueryAllStoresNoException():
    """All brain stores respond without raising (wire store names)."""
    import json

    stores = [
        'memory',
        'autoMemories',
        'heuristics',
        'facts',
        'sessions',
        'messages',
        'timeline',
        'graph',
        'blackboard',
        'daemons',
        'exams',
        'examAttempts',
    ]
    for store in stores:
        result = memory_store.brain_query(store=store, query='', limit=5)
        assert isinstance(result, str)
        parsed = json.loads(result)
        assert isinstance(parsed, (list, dict)), f'{store}: {type(parsed)}'
        # Unknown/missing table should be structured error dict, not a crash.
        if isinstance(parsed, dict) and 'error' in parsed:
            assert 'not available' in parsed['error'] or 'not yet' in parsed['error'] or 'brain_query' in parsed['error']


def testFailureFeedbackRoundTrip():
    """Tool error populates session._failure_feedback and lands in the system prompt."""
    import asyncio

    from app.services.workbench.workbench import _executeTool

    class FakeSession:
        def __init__(self):
            self._failure_feedback = None
            self._failure_feedback_age = None
            self.id = 'e2e-feedback'
            self.status = 'idle'
            self.sessionId = 'e2e-feedback'

    async def runError():
        from app.services import tool_registry

        originalDispatch = tool_registry.dispatch

        async def boom(toolName, args):
            raise ValueError('e2e test error')

        tool_registry.dispatch = boom
        try:
            session = FakeSession()
            result = await _executeTool('run_command', {'command': 'test'}, session)
            return (result, session._failure_feedback)
        finally:
            tool_registry.dispatch = originalDispatch

    result, feedback = asyncio.run(runError())
    assert 'failed' in result.lower()
    assert feedback is not None
    assert feedback['tool'] == 'run_command'
    assert feedback['error_type'] == 'ValueError'
    assert 'e2e test error' in feedback['error_message']
    # Prompt path: workbench sessionDict uses failureFeedback (camelCase).
    prompt = context_builder.buildSystemPrompt(session={'failureFeedback': feedback}, memory={})
    assert 'e2e test error' in prompt
    assert '<failure_feedback>' in prompt
