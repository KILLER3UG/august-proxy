"""v2 — End-to-end integration: chat + daemons + blackboard + verifier + consolidation."""
import asyncio
import json
import pytest
from app.services import daemonManager, blackboardService, consolidationDaemon
from app.services.memoryStore import init, _conn
from app.services.workbench import workbench
from app.services.memory import context_builder
from app.services.workbench import modelFleet

@pytest.fixture(autouse=True)
def _initDb():
    init()
    if hasattr(daemonManager, '_daemons'):
        daemonManager._daemons.clear()
    yield
    if hasattr(daemonManager, '_daemons'):
        daemonManager._daemons.clear()

def testChatWithDaemonBlackboardAndVerifier():
    """A chat turn integrates daemons, blackboard, and verifier gate."""
    import uuid
    sid = f'v2-e2e-{uuid.uuid4().hex[:8]}'
    mgr = daemonManager.get_manager()
    mgr._daemons.clear()
    result = daemonManager.DaemonResult()
    result.status = 'triggered'
    result.triggered = True
    result.output = '3 failures in auth.py'
    mgr._daemons[f'{sid}_ci'] = {'id': f'{sid}_ci', 'name': 'ci_watcher', 'session_id': sid, 'prompt': 'watch', 'watch_condition': 'on_match:FAIL', 'result': result}
    blackboardService.write_note(sid, 'ci_watcher', 'result', 'Tests failing on line 45', 60)
    session = {'id': sid, 'execution_state': {'phase': 'review', 'step': 3, 'verification_command': 'pytest tests/test_auth.py'}, 'subconscious_updates': [{'name': 'ci_watcher', 'status': 'triggered', 'result': '3 failures in auth.py'}], 'blackboard_state': blackboardService.read_notes(sid)}
    prompt = context_builder.build_system_prompt(session=session, memory={})
    assert 'ci_watcher' in prompt
    assert '<blackboard_state>' in prompt
    assert '<verifier_gate>' in prompt
    assert 'pytest tests/test_auth.py' in prompt
    blackboardService.clear_notes(sid)

def testModelFleetResolution():
    """getModelForRole returns proper models for each cognitive role."""
    assert modelFleet.getModelForRole('cerebellum') == 'claude-3-haiku-20240307'
    assert modelFleet.getModelForRole('hippocampus') == 'claude-3-haiku-20240307'
    assert modelFleet.getModelForRole('prefrontal') == 'claude-3-5-sonnet-20240620'

@pytest.mark.asyncio
async def testConsolidationRunsEndToEnd(monkeypatch):
    """Consolidation runs, calls Hippocampus (mocked), writes through db_writer."""

    async def fakeCallHippocampus(prompt, **kwargs):
        return json.dumps({'merge': [], 'promote': [], 'delete': []})
    monkeypatch.setattr(consolidationDaemon, '_call_hippocampus', fakeCallHippocampus)
    stats = await consolidationDaemon.run_consolidation()
    assert 'merged' in stats
    assert 'promoted' in stats
    assert 'deleted_stale' in stats

def testEnvWatcherIgnorePatterns():
    """Environment watcher correctly filters noise files."""
    from app.services.environmentWatcher import shouldIgnore
    assert shouldIgnore('__pycache__/foo.pyc') is True
    assert shouldIgnore('node_modules/x.js') is True
    assert shouldIgnore('.git/objects/abc') is True
    assert shouldIgnore('src/main.py') is False

def testBlackboardAckDeletes():
    """Ack=True on read_notes deletes the note."""
    import uuid
    sid = f'v2-e2e-ack-{uuid.uuid4().hex[:8]}'
    blackboardService.write_note(sid, 'test', 'k', 'v', 60)
    notes = blackboardService.read_notes(sid, ack=True)
    assert len(notes) >= 1
    notes2 = blackboardService.read_notes(sid)
    assert notes2 == []

def testPendingSkillsTableExists():
    """pending_skills table is present and queryable."""
    conn = _conn()
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_skills'").fetchall()
    assert len(rows) == 1

def testDaemonContextBlocksMutatingCommands():
    """run_command blocked in daemon context (tool blocklist)."""
    from app.services.toolRegistry import setDaemonContext, clearDaemonContext, isCommandBlocked
    setDaemonContext()
    assert isCommandBlocked('rm -rf /tmp') is True
    assert isCommandBlocked('mv x y') is True
    assert isCommandBlocked('ls') is False
    clearDaemonContext()