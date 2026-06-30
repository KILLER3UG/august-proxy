"""Provider and config endpoint tests."""
from httpx import AsyncClient, ASGITransport
from app.main import app

async def testActiveProviderReturnsProviders():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/api/config/activeProvider')
        assert resp.status_code == 200
        data = resp.json()
        assert 'providers' in data
        assert len(data['providers']) > 0

async def testCreateProvider():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.post('/api/providers', json={'name': 'Test Provider', 'baseUrl': 'https://test.api.com/v1', 'apiFormat': 'openai-chat', 'apiKey': 'sk-test123', 'enabled': True})
        assert resp.status_code == 200
        data = resp.json()
        assert data['name'] == 'Test Provider'
        assert data['apiKeySet'] is True