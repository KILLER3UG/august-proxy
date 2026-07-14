"""Service connections + mcp-env + usage analytics routes."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    # Reset settings data dir if cached
    from app.config import settings
    from app.lib import paths

    monkeypatch.setattr(paths, 'dataDir', lambda: tmp_path)
    settings.dataDir = tmp_path
    settings._config = {}
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


@pytest.mark.asyncio
async def test_service_connections_list_and_github(client):
    r = await client.get('/api/service-connections')
    assert r.status_code == 200
    data = r.json()
    assert 'connections' in data
    assert 'github' in data['connections']
    assert data['connections']['github']['connected'] is False

    r2 = await client.post('/api/service-connections/github', json={'token': 'ghp_testtoken1234'})
    assert r2.status_code == 200
    assert r2.json()['connection']['connected'] is True

    r3 = await client.get('/api/service-connections')
    assert r3.json()['connections']['github']['connected'] is True

    r4 = await client.delete('/api/service-connections/github')
    assert r4.status_code == 200
    r5 = await client.get('/api/service-connections')
    assert r5.json()['connections']['github']['connected'] is False


@pytest.mark.asyncio
async def test_mcp_env_roundtrip(client):
    r = await client.get('/api/mcp-env')
    assert r.status_code == 200
    assert 'env' in r.json()

    r2 = await client.post(
        '/api/mcp-env',
        json={'env': [{'key': 'FOO_BAR', 'value': 'baz'}, {'key': 'API_TOKEN', 'value': 'secret1234'}]},
    )
    assert r2.status_code == 200
    env = r2.json()['env']
    keys = {e['key']: e for e in env}
    assert keys['FOO_BAR']['value'] == 'baz'
    assert keys['API_TOKEN']['masked'] is True
    assert 'secret' not in keys['API_TOKEN']['value']


@pytest.mark.asyncio
async def test_usage_analytics_empty(client):
    for path in ('/api/usage/stats', '/api/usage/heatmap', '/api/usage/by-model', '/api/usage/by-day'):
        r = await client.get(f'{path}?range=30d')
        assert r.status_code == 200, path


@pytest.mark.asyncio
async def test_security_and_system(client):
    r = await client.put(
        '/api/security',
        json={'filesystemScope': 'allowlist', 'postObservationScreenshot': True, 'allowedRoots': ['C:/tmp']},
    )
    assert r.status_code == 200
    assert r.json()['ok'] is True
    assert r.json()['security']['allowedRoots'] == ['C:/tmp']

    r2 = await client.post('/api/system/restart')
    assert r2.status_code == 200
    assert r2.json()['ok'] is True
