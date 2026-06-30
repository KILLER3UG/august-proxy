"""v1.1 — End-to-end smoke test: a real chat session, no crashes."""
import pytest
import uuid
from app.services.memory import contextBuilder, autoMemory
from app.services.workbench import workbench
from app.services import memoryStore

@pytest.fixture(autouse=True)
def _initDb():
    """Run init() so schema is current (idempotent)."""
    memoryStore.init()
    yield

def testBuildSystemPromptDoesNotCrashWithRealisticPayload():
    """The most common failure mode: build_system_prompt with a real-shaped session."""
    session = {'id': 'e2e-test', 'user_state': {'profile': 'developer', 'skills': [{'name': 'test', 'description': 'x'}]}, 'workspace': {'path': '/tmp', 'vcs': 'git on main'}, 'directives': {'goal': 'test the chat', 'plan': None, 'plan_approved': False}, 'learned_heuristics': [{'rule': 'use unicode math'}], 'core_memory': {'facts': ['user prefers tabs']}, 'auto_memories': [{'key': 'x', 'content': 'y', 'importance': 0.5}]}
    memory = {'core_memory': {'facts': ['user prefers tabs']}, 'learned_heuristics': [{'rule': 'use unicode math'}], 'auto_memories': [{'key': 'x', 'content': 'y', 'importance': 0.5}]}
    tools = [{'name': 'read_file', 'description': 'read a file', 'parameters': []}, {'name': 'write_file', 'description': 'write a file', 'parameters': []}]
    result = contextBuilder.build_system_prompt(session=session, memory=memory, tools=tools)
    assert isinstance(result, str)
    assert len(result) > 100

def testBuildSystemPromptWithCachedT12DoesNotCrash():
    """Cache path: cached_t12 provided, should be included verbatim."""
    cachePayload = 'PRECOMPUTED_T1_T2_BLOCK'
    result = contextBuilder.build_system_prompt(session={'id': 'e2e-test'}, memory={}, cached_t12=cachePayload)
    assert cachePayload in result

def testSaveAutoMemoryThenBrainQueryRoundTrip():
    """End-to-end: save → read back via brain_query."""
    import json
    uniqueMarker = f'e2euniq{uuid.uuid4().hex[:8]}'
    key = f'v11_e2e_round_trip'
    try:
        autoMemory.save_auto_memory(key=key, content=f'round trip {uniqueMarker}', importance=0.9)
        result = memoryStore.brain_query(store='auto_memories', query=uniqueMarker, limit=5)
        parsed = json.loads(result)
        assert isinstance(parsed, list)
        assert any((uniqueMarker in str(r.get('content', '')) for r in parsed))
    finally:
        conn = memoryStore._conn()
        conn.execute('DELETE FROM auto_memories WHERE key = ?', (key,))
        conn.commit()

def testBrainQueryAllStoresNoException():
    """All 12 stores respond without raising."""
    import json
    stores = ['memory', 'auto_memories', 'heuristics', 'facts', 'sessions', 'messages', 'timeline', 'graph', 'blackboard', 'daemons', 'exams', 'exam_attempts']
    for store in stores:
        result = memoryStore.brain_query(store=store, query='', limit=5)
        assert isinstance(result, str)
        parsed = json.loads(result)
        assert isinstance(parsed, (list, dict)), f'{store}: {type(parsed)}'

def testFailureFeedbackRoundTrip():
    """Tool error populates session._failure_feedback; subsequent build_system_prompt
    includes it via context_builder (we just check the attribute round-trip)."""
    import asyncio
    from app.services.workbench.workbench import _executeTool

    class FakeSession:

        def __init__(self):
            self._failureFeedback = None
            self._failureFeedbackAge = None
            self.id = 'e2e-feedback'
            self.status = 'idle'
            self.sessionId = 'e2e-feedback'

    async def runError():
        from app.services import toolRegistry
        originalDispatch = toolRegistry.dispatch

        async def boom(toolName, args):
            raise ValueError('e2e test error')
        toolRegistry.dispatch = boom
        try:
            session = FakeSession()
            result = await _executeTool(tool_name='run_command', args={'command': 'test'}, session=session)
            return (result, session._failure_feedback)
        finally:
            toolRegistry.dispatch = originalDispatch
    result, feedback = asyncio.run(runError())
    assert 'failed' in result.lower()
    assert feedback is not None
    assert feedback['tool'] == 'run_command'
    assert feedback['error_type'] == 'ValueError'
    assert 'e2e test error' in feedback['error_message']