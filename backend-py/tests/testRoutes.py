"""Route integration tests using FastAPI TestClient."""

import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


@pytest.mark.asyncio
async def testHealth(client):
    resp = await client.get('/api/health')
    assert resp.status_code == 200
    assert resp.json()['status'] == 'ok'


@pytest.mark.asyncio
async def testProvidersList(client):
    resp = await client.get('/api/providers')
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) >= 1


@pytest.mark.asyncio
async def testModelsList(client):
    resp = await client.get('/api/models')
    assert resp.status_code == 200
    data = resp.json()
    assert data['total'] >= 1


@pytest.mark.asyncio
async def testV1Models(client):
    resp = await client.get('/v1/models')
    assert resp.status_code == 200
    data = resp.json()
    assert data['object'] == 'list'


@pytest.mark.asyncio
async def testSkills(client):
    resp = await client.get('/api/skills')
    assert resp.status_code == 200
    data = resp.json()
    assert 'skills' in data


@pytest.mark.asyncio
async def testWorkbenchSessions(client):
    resp = await client.get('/api/workbench/sessions')
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)


@pytest.mark.asyncio
async def testWorkbenchActivity(client):
    resp = await client.get('/api/workbench/activity')
    assert resp.status_code == 200
    data = resp.json()
    assert 'sessions' in data


@pytest.mark.asyncio
async def testWorkbenchCapabilities(client):
    resp = await client.get('/api/workbench/capabilities')
    assert resp.status_code == 200
    data = resp.json()
    assert 'tools_by_group' in data
    assert 'total_tools' in data
    assert 'mutating_tools' in data


@pytest.mark.asyncio
async def testApiSessionsList(client):
    resp = await client.get('/api/sessions')
    assert resp.status_code == 200
    data = resp.json()
    assert 'sessions' in data


@pytest.mark.asyncio
async def testApiSessionsCreate(client):
    resp = await client.post('/api/sessions')
    assert resp.status_code == 200
    data = resp.json()
    assert 'id' in data
    sessionId = data['id']
    await client.delete(f'/api/sessions/{sessionId}')


@pytest.mark.asyncio
async def testApiAgentsList(client):
    resp = await client.get('/api/agents')
    assert resp.status_code == 200
    data = resp.json()
    assert 'agents' in data


@pytest.mark.asyncio
async def testApiMcpServers(client):
    resp = await client.get('/api/mcp/servers')
    assert resp.status_code == 200


@pytest.mark.asyncio
async def testApiAudit(client):
    resp = await client.get('/api/audit')
    assert resp.status_code == 200


@pytest.mark.asyncio
async def testApiUsage(client):
    resp = await client.get('/api/usage')
    assert resp.status_code == 200


@pytest.mark.asyncio
async def testApiUsageSessionRecordsAndReturnsContextTokens(client, isolatedData):
    """POST /api/usage records an event; GET /api/usage/session?id= returns
    contextTokens = the recorded context_tokens (true current context fill)."""
    from app.services import memory_store

    sid = 'test-ctx-session'
    memory_store.recordUsage(
        sessionId=sid, model='claude-sonnet', inputTokens=12000, outputTokens=900, contextTokens=4823
    )
    resp = await client.get(f'/api/usage/session?id={sid}')
    assert resp.status_code == 200
    data = resp.json()
    assert data['contextTokens'] == 4823
    assert data['latestContextTokens'] == 4823
    assert data['totalInputTokens'] == 12000
    assert data['totalOutputTokens'] == 900
    assert data['totalEvents'] == 1
    assert data['events'][0]['contextTokens'] == 4823


@pytest.mark.asyncio
async def testApiUsageSessionMissingIdIs400(client):
    resp = await client.get('/api/usage/session')
    assert resp.status_code in (400, 422)


@pytest.mark.asyncio
async def testApiUsageSessionUnknownSessionReturnsZeros(client, isolatedData):
    resp = await client.get('/api/usage/session?id=nonexistent-session')
    assert resp.status_code == 200
    data = resp.json()
    assert data['contextTokens'] == 0
    assert data['totalEvents'] == 0


@pytest.mark.asyncio
async def testApiUsageSessionContextTokensFallsBackToInputTokens(client, isolatedData):
    """For rows recorded before the context_tokens column existed (value 0),
    the endpoint falls back to input_tokens so the gauge still has a value."""
    from app.services import memory_store

    sid = 'test-fallback-session'
    memory_store.recordUsage(sessionId=sid, model='claude-sonnet', inputTokens=7777, outputTokens=100, contextTokens=0)
    resp = await client.get(f'/api/usage/session?id={sid}')
    data = resp.json()
    assert resp.status_code == 200
    assert data['contextTokens'] == 7777


@pytest.mark.asyncio
async def testApiCron(client):
    resp = await client.get('/api/cron')
    assert resp.status_code == 200


@pytest.mark.asyncio
async def testApiGitStatus(client):
    resp = await client.get('/api/git/status')
    assert resp.status_code in (200, 400, 500)


@pytest.mark.asyncio
async def testApiTerminal(client):
    resp = await client.get('/api/terminal')
    assert resp.status_code == 200


@pytest.mark.asyncio
async def testApiMemoryKv(client):
    """Test memory KV endpoint lifecycle."""
    resp = await client.post('/api/memory/kv', json={'key': 'route_test', 'value': 'works'})
    assert resp.status_code == 200
    resp = await client.get('/api/memory/kv/route_test')
    assert resp.status_code == 200
    assert resp.json()['value'] == 'works'
    resp = await client.get('/api/memory/kv')
    assert resp.status_code == 200
    resp = await client.get('/api/memory/search?query=works')
    assert resp.status_code == 200
    assert resp.json()['count'] >= 1
    resp = await client.delete('/api/memory/kv/route_test')
    assert resp.status_code == 200


@pytest.mark.asyncio
async def testApiMemoryFacts(client):
    """Test memory facts endpoint lifecycle."""
    resp = await client.post(
        '/api/memory/facts', json={'factKey': 'route_fact', 'factValue': 'fact_value', 'category': 'test'}
    )
    assert resp.status_code == 200
    resp = await client.get('/api/memory/facts')
    assert resp.status_code == 200
    assert resp.json()['facts'] is not None
    resp = await client.get('/api/memory/facts/route_fact')
    assert resp.status_code == 200
    resp = await client.delete('/api/memory/facts/route_fact')
    assert resp.status_code == 200


@pytest.mark.asyncio
async def testApiMemoryProposals(client):
    """Test proposals endpoint lifecycle."""
    resp = await client.post(
        '/api/memory/proposals', json={'sessionId': 'route_s1', 'proposalType': 'plan', 'content': {'x': 1}}
    )
    assert resp.status_code == 200
    pid = resp.json()['id']
    resp = await client.get(f'/api/memory/proposals/{pid}')
    assert resp.status_code == 200
    assert resp.json()['status'] == 'pending'
    resp = await client.post(f'/api/memory/proposals/{pid}/decide', json={'status': 'approved', 'decidedBy': 'test'})
    assert resp.status_code == 200


@pytest.mark.asyncio
async def testApiMemoryStats(client):
    resp = await client.get('/api/memory/stats')
    assert resp.status_code == 200
    data = resp.json()
    assert 'memoryStore' in data
