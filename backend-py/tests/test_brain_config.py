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
from httpx import ASGITransport, AsyncClient
from app.main import app
from app.services.memory_store import listConfigAudit
_ALLCamelKeys = {'enabled', 'adaptivePolicy', 'failureLearning', 'graphMemory', 'agentJobs', 'hierarchicalAgents', 'adapterParallelTools', 'parallelReadTools', 'reviewLearnedGuidelines', 'maxAgentDepth', 'maxWorkbenchToolLoops'}

@pytest.fixture
async def client(isolatedData):
    from app.services.workbench import workbench as wb
    wb._sessions.clear()
    wb.save_sessions()
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
    """Valid patch merges into cfg.brain_orchestrator + writes an audit row."""
    resp = await client.put('/api/brain/config', json={'enabled': False, 'maxAgentDepth': 3})
    assert resp.status_code == 200
    body = resp.json()
    assert body['ok'] is True
    assert body['config']['enabled'] is False
    assert body['config']['maxAgentDepth'] == 3
    assert body['config']['adaptivePolicy'] is True
    rows = listConfigAudit(category='brain')
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
    assert not listConfigAudit(category='brain')

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
    resets = [r for r in listConfigAudit(category='brain') if r['action'] == 'reset']
    assert len(resets) == 1
    assert resets[0]['before'].get('enabled') is False
    assert resets[0]['after'] == {}

@pytest.mark.asyncio
async def testFromSessionReturnsSessionSource(client, isolatedData):
    """When a workbench session exists, source='session' + session fields populated."""
    from app.services.workbench import workbench as wb
    sess = wb.create_workbench_session(provider='anthropic', goal='draft release notes')
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