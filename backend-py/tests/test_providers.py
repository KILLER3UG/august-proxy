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


async def test_api_key_is_never_serialized_back_to_the_client(isolatedData):
    """A stored key must not be readable over HTTP in any response shape.

    `/api/*` is served on 127.0.0.1 with an origin guard
    (app/lib/local_api_guard.py); the guard protects against a remote page, not
    against anything else running as this user, so the secret stays server-side
    and only `apiKeySet` / `apiKeyMasked` cross the wire.
    """
    secret = 'sk-super-secret-abcdef4321'
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        created = await client.post(
            '/api/providers',
            json={
                'name': 'Masked Provider',
                'baseUrl': 'https://masked.api/v1',
                'apiFormat': 'openaiChat',
                'apiKey': secret,
                'enabled': True,
            },
        )
        assert created.status_code == 200
        assert created.json().get('apiKey') is None
        assert created.json()['apiKeySet'] is True
        assert secret not in created.text

        listed = await client.get('/api/providers')
        assert listed.status_code == 200
        assert secret not in listed.text
        assert all('apiKey' not in item for item in listed.json())

        provider_id = created.json()['id']
        fetched = await client.get(f'/api/providers/{provider_id}')
        assert fetched.status_code == 200
        assert fetched.json().get('apiKey') is None
        assert secret not in fetched.text
        # The display hint exists so the UI can show *which* key is stored.
        assert fetched.json()['apiKeyMasked'].endswith(secret[-4:])


async def test_active_provider_returns_empty_when_none_configured(isolatedData):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/api/config/activeProvider')
        assert resp.status_code == 200
        data = resp.json()
        assert 'providers' in data
        assert len(data['providers']) == 0
