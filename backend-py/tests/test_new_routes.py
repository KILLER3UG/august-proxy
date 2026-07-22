"""GET-only smoke tests for the new self-configuration routes (real app)."""

import pytest
from app.main import app
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


@pytest.mark.asyncio
async def testConfigModelAliases(client):
    resp = await client.get('/api/config/model-aliases')
    assert resp.status_code == 200
    assert 'aliases' in resp.json()


@pytest.mark.asyncio
async def testConfigSubagentFallback(client):
    resp = await client.get('/api/config/subagent-fallback')
    assert resp.status_code == 200
    data = resp.json()
    assert 'enabled' in data and 'mode' in data


@pytest.mark.asyncio
async def testAugustAudit(client):
    resp = await client.get('/api/august/audit')
    assert resp.status_code == 200
    data = resp.json()
    assert 'entries' in data and data['count'] >= 0


@pytest.mark.asyncio
async def testAugustRollbackEmpty(client):
    resp = await client.get('/api/august/rollback')
    assert resp.status_code == 200
    assert resp.json()['entries'] == []


@pytest.mark.asyncio
async def testWorkbenchAgents(client):
    resp = await client.get('/api/workbench/agents')
    assert resp.status_code == 200
    assert 'agents' in resp.json()


@pytest.mark.asyncio
async def testAgentsTree(client):
    resp = await client.get('/api/agents/tree')
    assert resp.status_code == 200
    assert 'children' in resp.json()
