"""Provider and config endpoint tests."""
from httpx import AsyncClient, ASGITransport
from app.main import app

async def testTemplatesEndpointReturnsTemplates():
    """Templates endpoint returns the full list of provider templates."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/api/providers/templates')
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) > 0
        tmpl = data[0]
        assert 'id' in tmpl
        assert 'name' in tmpl
        assert 'baseUrl' in tmpl
        assert 'apiFormat' in tmpl
        assert 'modelProfiles' in tmpl
        ids = {t['id'] for t in data}
        assert 'anthropic' in ids
        assert 'openai-api' in ids
        assert 'deepseek' in ids

async def testCreateProvider(monkeypatch):
    from app.services import modelService
    monkeypatch.setattr(modelService, 'invalidate_cache', modelService.invalidateCache, raising=False)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.post('/api/providers', json={'name': 'Test Provider', 'baseUrl': 'https://test.api.com/v1', 'apiFormat': 'openaiChat', 'apiKey': 'sk-test123', 'enabled': True})
        assert resp.status_code == 200
        data = resp.json()
        assert data['name'] == 'Test Provider'
        assert data['apiKeySet'] is True

async def testCreateProviderWithTemplate(monkeypatch):
    """Creating a provider with a template id pre-fills baseUrl and models."""
    from app.services import modelService
    monkeypatch.setattr(modelService, 'invalidate_cache', modelService.invalidateCache, raising=False)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.post('/api/providers', json={'name': 'My Anthropic', 'template': 'anthropic', 'apiKey': 'sk-ant-test123', 'enabled': True})
        assert resp.status_code == 200
        data = resp.json()
        assert data['name'] == 'My Anthropic'
        assert 'api.anthropic.com' in data['baseUrl']
        assert data['apiFormat'] == 'anthropicMessages'
        assert len(data['models']) > 0
        modelIds = {m['id'] for m in data['models']}
        assert 'claude-sonnet-4' in modelIds or 'claude-opus-4' in modelIds

async def testActiveProviderReturnsEmptyWhenNoneConfigured(isolatedData):
    """With no providers configured, activeProvider returns empty list."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/api/config/activeProvider')
        assert resp.status_code == 200
        data = resp.json()
        assert 'providers' in data
        assert len(data['providers']) == 0

async def testImportProviderConfig(monkeypatch):
    """Importing a provider config works."""
    from app.services import modelService
    monkeypatch.setattr(modelService, 'invalidate_cache', modelService.invalidateCache, raising=False)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.post('/api/providers/import-config', json={'name': 'Imported Provider', 'baseUrl': 'https://imported.api.com/v1', 'apiFormat': 'openaiChat', 'apiKey': 'sk-imported', 'models': [{'id': 'model-1', 'name': 'Model 1'}]})
        assert resp.status_code == 200
        data = resp.json()
        assert data['name'] == 'Imported Provider'
        assert data['apiKeySet'] is True
        assert len(data['models']) == 1