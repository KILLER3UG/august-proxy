"""Service connections + mcp-env + usage analytics routes."""

from __future__ import annotations

import os

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app

_GOOGLE_ENV_KEYS = (
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REDIRECT_URI',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'USER_GOOGLE_EMAIL',
)


@pytest.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    # Reset settings data dir if cached
    from app.config import settings
    from app.lib import paths

    monkeypatch.setattr(paths, 'dataDir', lambda: tmp_path)
    settings.dataDir = tmp_path
    settings._config = {}
    # Isolate Google OAuth env left by prior tests / set_mcp_env side effects
    for k in _GOOGLE_ENV_KEYS:
        monkeypatch.delenv(k, raising=False)
        os.environ.pop(k, None)
    # Clear in-memory OAuth state
    from app.services import service_connections as sc

    sc._oauth_pending.clear()

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
async def test_mcp_env_merge_keeps_existing_keys(client):
    await client.post(
        '/api/mcp-env',
        json={'env': {'KEEP_ME': 'yes', 'REPLACE_ME': 'old'}},
    )
    r = await client.post(
        '/api/mcp-env',
        json={
            'env': {
                'REPLACE_ME': 'new',
                'WORKSPACE_HINT': 'cid.apps.googleusercontent.com',
            },
            'merge': True,
        },
    )
    assert r.status_code == 200
    keys = {e['key']: e for e in r.json()['env']}
    assert keys['KEEP_ME']['value'] == 'yes'
    assert keys['REPLACE_ME']['value'] == 'new'
    assert keys['WORKSPACE_HINT']['value'] == 'cid.apps.googleusercontent.com'


@pytest.mark.asyncio
async def test_google_auth_requires_config(client):
    r = await client.post('/api/service-connections/google/auth', json={'email': ''})
    assert r.status_code == 200
    body = r.json()
    assert not body.get('authUrl')
    assert body.get('needsClientId') is True
    msg = (body.get('message') or '').lower()
    assert 'client id' in msg or 'oauth' in msg


@pytest.mark.asyncio
async def test_google_native_auth_url_when_client_id_set(client, monkeypatch):
    monkeypatch.setenv('GOOGLE_OAUTH_CLIENT_ID', 'test-client.apps.googleusercontent.com')
    monkeypatch.setenv('GOOGLE_OAUTH_CLIENT_SECRET', 'test-secret')
    r = await client.post('/api/service-connections/google/auth', json={'email': 'me@example.com'})
    assert r.status_code == 200
    body = r.json()
    url = body.get('authUrl') or ''
    assert url.startswith('https://accounts.google.com/o/oauth2/v2/auth')
    assert 'test-client.apps.googleusercontent.com' in url
    assert 'state=' in url
    from urllib.parse import parse_qs, unquote, urlparse

    q = parse_qs(urlparse(url).query)
    redirect = unquote(q.get('redirect_uri', [''])[0])
    assert redirect.endswith('/api/service-connections/google/callback')
    assert q.get('code_challenge_method') == ['S256']
    assert q.get('code_challenge')


@pytest.mark.asyncio
async def test_google_pkce_auth_url_without_secret(client, monkeypatch):
    """Desktop / public clients need only Client ID + PKCE."""
    monkeypatch.setenv('GOOGLE_OAUTH_CLIENT_ID', 'desktop-client.apps.googleusercontent.com')
    monkeypatch.delenv('GOOGLE_OAUTH_CLIENT_SECRET', raising=False)
    r = await client.post('/api/service-connections/google/auth', json={})
    assert r.status_code == 200
    body = r.json()
    assert body.get('authUrl')
    assert body.get('pkce') is True
    from urllib.parse import parse_qs, urlparse

    q = parse_qs(urlparse(body['authUrl']).query)
    assert 'code_challenge' in q


@pytest.mark.asyncio
async def test_google_callback_exchanges_code(client, monkeypatch):
    monkeypatch.setenv('GOOGLE_OAUTH_CLIENT_ID', 'test-client.apps.googleusercontent.com')
    monkeypatch.setenv('GOOGLE_OAUTH_CLIENT_SECRET', 'test-secret')

    # Seed a pending OAuth state via auth URL
    auth = await client.post('/api/service-connections/google/auth', json={'email': ''})
    url = auth.json()['authUrl']
    from urllib.parse import parse_qs, urlparse

    state = parse_qs(urlparse(url).query)['state'][0]

    class FakeResponse:
        def __init__(self, status_code: int, payload: dict | str):
            self.status_code = status_code
            self._payload = payload
            self.text = payload if isinstance(payload, str) else str(payload)

        def json(self):
            assert isinstance(self._payload, dict)
            return self._payload

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, url, data=None, headers=None):
            assert 'oauth2.googleapis.com/token' in url
            assert data['code'] == 'auth-code-xyz'
            assert data['client_secret'] == 'test-secret'
            assert data.get('code_verifier')  # PKCE always sent when auth started via August
            return FakeResponse(
                200,
                {
                    'access_token': 'ya29.access',
                    'refresh_token': '1//refresh',
                    'token_type': 'Bearer',
                    'expires_in': 3600,
                    'scope': 'email profile',
                },
            )

        async def get(self, url, headers=None):
            assert 'userinfo' in url
            return FakeResponse(200, {'email': 'user@gmail.com'})

    monkeypatch.setattr('app.services.service_connections.httpx.AsyncClient', FakeClient)

    r = await client.get(
        '/api/service-connections/google/callback',
        params={'code': 'auth-code-xyz', 'state': state},
    )
    assert r.status_code == 200
    assert 'Connected' in r.text or 'connected' in r.text.lower()

    listed = await client.get('/api/service-connections')
    google = listed.json()['connections']['google']
    assert google['connected'] is True
    assert google.get('account') == 'user@gmail.com'


@pytest.mark.asyncio
async def test_google_callback_pkce_without_secret(client, monkeypatch):
    monkeypatch.setenv('GOOGLE_OAUTH_CLIENT_ID', 'desktop.apps.googleusercontent.com')
    monkeypatch.delenv('GOOGLE_OAUTH_CLIENT_SECRET', raising=False)

    auth = await client.post('/api/service-connections/google/auth', json={})
    url = auth.json()['authUrl']
    from urllib.parse import parse_qs, urlparse

    state = parse_qs(urlparse(url).query)['state'][0]
    seen: dict = {}

    class FakeResponse:
        def __init__(self, status_code: int, payload: dict | str):
            self.status_code = status_code
            self._payload = payload
            self.text = payload if isinstance(payload, str) else str(payload)

        def json(self):
            assert isinstance(self._payload, dict)
            return self._payload

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, url, data=None, headers=None):
            seen['data'] = dict(data or {})
            assert 'client_secret' not in data
            assert data.get('code_verifier')
            return FakeResponse(
                200,
                {
                    'access_token': 'ya29.pkce',
                    'refresh_token': '1//pkce',
                    'token_type': 'Bearer',
                    'expires_in': 3600,
                },
            )

        async def get(self, url, headers=None):
            return FakeResponse(200, {'email': 'pkce@gmail.com'})

    monkeypatch.setattr('app.services.service_connections.httpx.AsyncClient', FakeClient)
    r = await client.get(
        '/api/service-connections/google/callback',
        params={'code': 'pkce-code', 'state': state},
    )
    assert r.status_code == 200
    assert 'Connected' in r.text or 'connected' in r.text.lower()
    listed = await client.get('/api/service-connections')
    assert listed.json()['connections']['google']['account'] == 'pkce@gmail.com'


@pytest.mark.asyncio
async def test_mcp_directory_includes_google_workspace(client):
    r = await client.get('/api/mcp/directory')
    assert r.status_code == 200
    ids = {e['id'] for e in r.json().get('entries', [])}
    assert 'mcp-google-workspace' in ids


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
