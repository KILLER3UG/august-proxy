"""Brain Orchestrator settings-tab HTTP API tests.

Covers the four routes mounted by ``app.routers.brain_config``:

  GET  /api/brain/config                — read effective config + defaults
  PUT  /api/brain/config                — partial merge + audit
  POST /api/brain/config/reset          — clear persisted override + audit
  GET  /api/brain/config/from-session   — session-derived view

Uses the ``isolated_data`` conftest fixture so config.json and the SQLite
brain DB never touch the user's real data directory.
"""

from __future__ import annotations

import pytest
from app.main import app
from app.services.memory_store import list_config_audit
from httpx import ASGITransport, AsyncClient

_ALLCamelKeys = {
    'enabled',
    'adaptivePolicy',
    'failureLearning',
    'graphMemory',
    'agentJobs',
    'hierarchicalAgents',
    'adapterParallelTools',
    'parallelReadTools',
    'reviewLearnedGuidelines',
    # Per-turn skill relevance gating (compact Tier-1 index + Tier-3 picks).
    'skillRelevanceMatch',
    'maxAgentDepth',
    'maxWorkbenchToolLoops',
    # Evidence-driven auto-routing (surpass #1 closed loop).
    'autoRoute',
    'autoRouteMinSamples',
    'autoRouteMinWinRate',
    'autoRouteWinGap',
    # Memory read gate (Bug 8a) + write door + sensitive-topic toggle.
    'modelMemoryRead',
    'modelMemoryWrites',
    'memorySensitiveTopics',
    # Camera capture access toggle (Workstream D).
    'cameraAccess',
    # M4 consolidation v2 cadence + model-summarize toggle (plan §3.5).
    'consolidationIntervalHours',
    'consolidationModelSummarize',
    # M7 titling target override (plan §3.7).
    'titleModel',
    # Part 16/17 skill-learning judge mode (off | extract-only | full).
    'skillLearning',
    # Part 16 Phase C: dedicated judge model + tier-2 cost gates.
    'skillLearningJudgeModel',
    'escalationBudgetPerDay',
    'flagRateCap',
}


@pytest.fixture
async def client(isolatedData):
    from app.services.workbench import workbench as wb

    wb._sessions.clear()
    wb.saveSessions()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


@pytest.mark.asyncio
async def testGetReturnsDefaultsWhenNoPersisted(client):
    """Empty config.json → source='fallback', defaults fully populated."""
    resp = await client.get('/api/brain/config')
    assert resp.status_code == 200
    body = resp.json()
    assert body['source'] == 'fallback'
    assert set(body['defaults'].keys()) == _ALLCamelKeys
    assert body['config'] == body['defaults']
    assert body['sessionId'] in (None, '')
    assert body['session'] in (None, '')


@pytest.mark.asyncio
async def testGetReflectsPersistedOverrides(client, isolatedData, monkeypatch):
    """Manually persist a snake_case override → source='persisted' + camelCase config."""
    import json

    from app.lib.paths import dataPath

    cfgPath = dataPath('config.json')
    # Legacy top-level key must migrate into auxiliary.cognitive.orchestrator.
    cfgPath.write_text(json.dumps({'brain_orchestrator': {'enabled': False, 'max_agent_depth': 2}}), 'utf-8')
    resp = await client.get('/api/brain/config')
    assert resp.status_code == 200
    body = resp.json()
    assert body['source'] == 'persisted'
    assert body['config']['enabled'] is False
    assert body['config']['maxAgentDepth'] == 2
    assert body['defaults']['enabled'] is True
    assert body['defaults']['maxAgentDepth'] == 4


@pytest.mark.asyncio
async def testPutMergesAndAudits(client, isolatedData):
    """Valid patch merges into cognitive.orchestrator + writes an audit row."""
    resp = await client.put('/api/brain/config', json={'enabled': False, 'maxAgentDepth': 3})
    assert resp.status_code == 200
    body = resp.json()
    assert body['ok'] is True
    assert body['config']['enabled'] is False
    assert body['config']['maxAgentDepth'] == 3
    assert body['config']['adaptivePolicy'] is True
    rows = list_config_audit(category='brain')
    assert any((r['action'] == 'update' for r in rows))
    update = next((r for r in rows if r['action'] == 'update'))
    assert update['actor'] == 'user'
    assert update['after']['enabled'] is False
    assert update['after']['max_agent_depth'] == 3


@pytest.mark.asyncio
async def testPutRejectsUnknownKey(client, isolatedData):
    """Unknown field → 400, no save, no audit row."""
    resp = await client.put('/api/brain/config', json={'notARealKey': True})
    assert resp.status_code == 400
    detail = resp.json().get('detail', {})
    assert 'notARealKey' in detail.get('message', '')
    body = (await client.get('/api/brain/config')).json()
    assert body['source'] == 'fallback'
    assert not list_config_audit(category='brain')


@pytest.mark.asyncio
async def testPutRejectsWrongType(client, isolatedData):
    """Boolean field given a string → 400."""
    resp = await client.put('/api/brain/config', json={'enabled': 'yes'})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def testPutRejectsOutOfRangeNumber(client, isolatedData):
    """maxAgentDepth outside [1,5] → 400."""
    resp = await client.put('/api/brain/config', json={'maxAgentDepth': 99})
    assert resp.status_code == 400
    resp = await client.put('/api/brain/config', json={'maxAgentDepth': 0})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def testResetClearsPersistedAndAudits(client, isolatedData):
    """After reset, source returns to 'fallback' and defaults are restored."""
    await client.put('/api/brain/config', json={'enabled': False})
    resp = await client.post('/api/brain/config/reset')
    assert resp.status_code == 200
    body = resp.json()
    assert body['ok'] is True
    assert body['config'] == body['defaults']
    assert body['config']['enabled'] is True
    body2 = (await client.get('/api/brain/config')).json()
    assert body2['source'] == 'fallback'
    assert body2['config']['enabled'] is True
    resets = [r for r in list_config_audit(category='brain') if r['action'] == 'reset']
    assert len(resets) == 1
    assert resets[0]['before'].get('enabled') is False
    assert resets[0]['after'] == {}


@pytest.mark.asyncio
async def testFromSessionReturnsSessionSource(client, isolatedData):
    """When a workbench session exists, source='session' + session fields populated."""
    from app.services.workbench import workbench as wb

    sess = wb.createWorkbenchSession(provider='anthropic', goal='draft release notes')
    resp = await client.get('/api/brain/config/from-session', params={'sessionId': sess.id})
    assert resp.status_code == 200
    body = resp.json()
    assert body['source'] == 'session'
    assert body['sessionId'] == sess.id
    assert body['session']['id'] == sess.id
    assert body['session']['task'] == 'draft release notes'


@pytest.mark.asyncio
async def testFromSessionRequiresSessionId(client):
    """Missing sessionId → 400 (FastAPI's Query(..., min_length=1) enforces it)."""
    resp = await client.get('/api/brain/config/from-session')
    assert resp.status_code in (400, 422)


@pytest.mark.asyncio
async def testStateLookupReturnsInternalStateRow(client, isolatedData):
    """§5.5: a key in internal_state comes back verbatim with its source."""
    from app.services.memory_store.kv import set_internal_state

    set_internal_state('cognitive:boot', {'phase': 'done', 'step': 3})
    resp = await client.get('/api/brain/state-lookup', params={'key': 'cognitive:boot'})
    assert resp.status_code == 200
    body = resp.json()
    assert body['found'] is True
    assert body['source'] == 'internal_state'
    assert body['value'] == {'phase': 'done', 'step': 3}
    assert body['updatedAt']


@pytest.mark.asyncio
async def testStateLookupFallsBackToMemoryStore(client, isolatedData):
    """§5.5: keys absent from internal_state resolve against memory_store."""
    from app.services.memory_store.kv import save_internal

    save_internal('user:plant', 'My plant is named Gerald')
    resp = await client.get('/api/brain/state-lookup', params={'key': 'user:plant'})
    assert resp.status_code == 200
    body = resp.json()
    assert body['found'] is True
    assert body['source'] == 'memory_store'
    assert body['value'] == 'My plant is named Gerald'


@pytest.mark.asyncio
async def testStateLookupPrefersInternalStateOnCollision(client, isolatedData):
    """§5.5: machine state wins when the same key exists in both tables."""
    from app.services.memory_store.kv import save_internal, set_internal_state

    save_internal('dup:key', 'memory-store-value')
    set_internal_state('dup:key', 'internal-state-value')
    resp = await client.get('/api/brain/state-lookup', params={'key': 'dup:key'})
    body = resp.json()
    assert body['found'] is True
    assert body['source'] == 'internal_state'
    assert body['value'] == 'internal-state-value'


@pytest.mark.asyncio
async def testStateLookupMissingKeyReportsNotFound(client, isolatedData):
    resp = await client.get('/api/brain/state-lookup', params={'key': 'nope:not-here'})
    assert resp.status_code == 200
    body = resp.json()
    assert body == {'key': 'nope:not-here', 'found': False, 'source': None, 'value': None, 'updatedAt': None}


@pytest.mark.asyncio
async def testStateLookupRejectsBlankKey(client):
    resp = await client.get('/api/brain/state-lookup', params={'key': '   '})
    assert resp.status_code == 400
