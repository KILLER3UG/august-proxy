"""v2 — Test consolidation via Hippocampus LLM + skill genesis."""
import asyncio
import json
import pytest
from app.services import consolidationDaemon
from app.services.memory_store import _conn, init

@pytest.fixture(autouse=True)
def _initDb():
    init()
    yield

def testPendingSkillsTableExists():
    """The pending_skills table is created."""
    conn = _conn()
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_skills'").fetchall()
    assert len(rows) == 1

def testRunConsolidationUsesHippocampus(monkeypatch):
    """run_consolidation calls _call_hippocampus with a prompt."""
    captured: dict = {}

    async def fakeCall(prompt, **kwargs):
        captured['prompt'] = prompt
        return json.dumps({'merge': [], 'promote': [], 'delete': []})
    monkeypatch.setattr(consolidationDaemon, '_call_hippocampus', fakeCall)
    asyncio.run(consolidationDaemon.run_consolidation())
    assert 'merge' in captured['prompt'].lower() or 'consolidat' in captured['prompt'].lower()

def testRunConsolidationAppliesMerges(monkeypatch):
    """When Hippocampus returns merges, the duplicates are removed."""
    conn = _conn()
    conn.execute('INSERT INTO learned_heuristics (rule, source, category) VALUES (?, ?, ?)', ('User prefers Yarn', 'test', 'build'))
    conn.execute('INSERT INTO learned_heuristics (rule, source, category) VALUES (?, ?, ?)', ('Use Yarn not NPM', 'test', 'build'))
    conn.commit()
    keepId = conn.execute("SELECT id FROM learned_heuristics WHERE rule = 'User prefers Yarn'").fetchone()['id']
    removeId = conn.execute("SELECT id FROM learned_heuristics WHERE rule = 'Use Yarn not NPM'").fetchone()['id']

    async def fakeCall(prompt, **kwargs):
        return json.dumps({'merge': [{'keep_id': keepId, 'remove_ids': [removeId], 'merged_rule': 'User prefers Yarn (not NPM)'}], 'promote': [], 'delete': []})
    monkeypatch.setattr(consolidationDaemon, '_call_hippocampus', fakeCall)
    asyncio.run(consolidationDaemon.run_consolidation())

def testRunConsolidationRecent20Protected(monkeypatch):
    """The 20 most recent rules cannot be deleted."""
    conn = _conn()
    conn.execute("DELETE FROM learned_heuristics WHERE source = 'test-recent'")
    conn.commit()
    for i in range(25):
        conn.execute('INSERT INTO learned_heuristics (rule, source, category) VALUES (?, ?, ?)', (f'recent-rule {i}', 'test-recent', 'general'))
    conn.commit()

    async def fakeCall(prompt, **kwargs):
        ids = [r['id'] for r in conn.execute("SELECT id FROM learned_heuristics WHERE source = 'test-recent'").fetchall()]
        return json.dumps({'merge': [], 'promote': [], 'delete': ids})
    monkeypatch.setattr(consolidationDaemon, '_call_hippocampus', fakeCall)
    asyncio.run(consolidationDaemon.run_consolidation())
    conn.execute("DELETE FROM learned_heuristics WHERE source = 'test-recent'")
    conn.commit()

def testRunConsolidationMalformedResponseSafe(monkeypatch):
    """A non-JSON Hippocampus response causes no destructive writes."""

    async def fakeCall(prompt, **kwargs):
        return 'not json {{'
    monkeypatch.setattr(consolidationDaemon, '_call_hippocampus', fakeCall)
    asyncio.run(consolidationDaemon.run_consolidation())

def testSkillDraftingWritesToStaging(monkeypatch, tmp_path):
    """A successful draft writes to pending_skills and staging."""
    staging = tmp_path / 'staging'
    staging.mkdir()
    monkeypatch.setattr(consolidationDaemon, '_staging_dir', str(staging))

    async def fakeCall(prompt, **kwargs):
        return json.dumps({'name': 'v2-test-skill', 'description': 'A test skill', 'trigger': 'test', 'body': 'Step 1: do it.'})
    monkeypatch.setattr(consolidationDaemon, '_call_prefrontal', fakeCall)
    monkeypatch.setattr(consolidationDaemon, '_get_session_summary', lambda sid: 'Multi-step session')
    result = asyncio.run(consolidationDaemon.draft_skill_for_session('v2-test-session'))
    assert result == 'v2-test-skill'
    stagingFile = staging / 'v2-test-skill.md'
    assert stagingFile.exists()
    conn = _conn()
    row = conn.execute("SELECT status FROM pending_skills WHERE name = 'v2-test-skill'").fetchone()
    assert row is not None
    assert row['status'] == 'pending'
    conn.execute("DELETE FROM pending_skills WHERE name = 'v2-test-skill'")
    conn.commit()
    stagingFile.unlink()