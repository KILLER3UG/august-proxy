"""Provider endpoint tests — user-configured providers only (no templates)."""

from app.main import app
from httpx import ASGITransport, AsyncClient


async def test_templates_endpoint_returns_empty():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/api/providers/templates')
        assert resp.status_code == 200
        assert resp.json() == []


async def test_create_provider_requires_base_url():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.post(
            '/api/providers',
            json={'name': 'No URL', 'apiFormat': 'openaiChat', 'apiKey': 'sk-test', 'enabled': True},
        )
        assert resp.status_code == 400


async def test_create_provider():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.post(
            '/api/providers',
            json={
                'name': 'Test Provider',
                'baseUrl': 'https://test.api.com/v1',
                'apiFormat': 'openaiChat',
                'apiKey': 'sk-test123',
                'enabled': True,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data['name'] == 'Test Provider'
        assert data['apiKeySet'] is True
        assert data['baseUrl'] == 'https://test.api.com/v1'


async def test_active_provider_returns_empty_when_none_configured(isolatedData):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/api/config/activeProvider')
        assert resp.status_code == 200
        data = resp.json()
        assert 'providers' in data
        assert len(data['providers']) == 0
