"""Route integration tests using FastAPI TestClient."""

import pytest
from app.main import app
from httpx import ASGITransport, AsyncClient


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
    assert data['total'] >= 0


@pytest.mark.asyncio
async def testV1Models(client):
    # /v1/models is part of the gated external surface — closed by default
    # (external access disabled → 403), like every other /v1/* endpoint.
    # The old behavior served it unauthenticated because the models router
    # shadowed the gated proxy route (audit finding).
    resp = await client.get('/v1/models')
    assert resp.status_code == 403


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


# testApiCron / testApiTerminal removed (Part 25 Phase 6): the cron + legacy
# terminal REST routers had zero callers and were deleted; the live terminal
# surface is terminal_routes.py (websocket/session), covered elsewhere.

@pytest.mark.asyncio
async def testApiGitStatus(client):
    resp = await client.get('/api/git/status')
    assert resp.status_code in (200, 400, 500)


@pytest.mark.asyncio
async def testWorkbenchDefaultWorkspace(client):
    # Folderless "Tasks" sessions anchor at the OS user's home directory —
    # resolved dynamically per host user, never hardcoded.
    from pathlib import Path

    resp = await client.get('/api/workbench/default-workspace')
    assert resp.status_code == 200
    data = resp.json()
    assert data['path'] == str(Path.home())
    assert data['path']

