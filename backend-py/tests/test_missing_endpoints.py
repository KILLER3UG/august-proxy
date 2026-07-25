"""Endpoint coverage for previously-missing routes:

  • POST /v1/messages/count_tokens  — was an unwired handler (404)
  • GET  /api/providers/{id}/models — collection list (provider detail only)
  • POST /api/providers/{id}/discover — read-only live /models probe

The count_tokens handler estimates locally (no upstream call), so the route
test asserts wiring + payload shape without network.
"""

from app.config import settings
from app.main import app
from httpx import ASGITransport, AsyncClient

# ── POST /v1/messages/count_tokens ─────────────────────────────────────

# count_tokens lives on the /v1/* proxy surface, so it is gated behind
# require_gateway_key (external-access opt-in + Bearer key). These tests
# enable external access and set a key so the route is reachable; the handler
# itself never makes an upstream call.


def _enable_external_access(monkeypatch, key: str = 'test-gw-key') -> str:
    """Turn on /v1/* external access and return the Bearer key to send."""
    monkeypatch.setattr(settings, 'gatewayApiKey', key)
    monkeypatch.setenv('GATEWAY_API_KEY', key)
    # Flip the externalAccess flag read by require_gateway_key. `settings.config`
    # is a read-only property over `_config`, so patch the backing dict.
    monkeypatch.setattr(
        settings,
        '_config',
        {'gateway': {'externalAccess': {'enabled': True}}},
    )
    return key


async def test_count_tokens_returns_estimated_input_tokens(monkeypatch):
    key = _enable_external_access(monkeypatch)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.post(
            '/v1/messages/count_tokens',
            headers={'Authorization': f'Bearer {key}'},
            json={
                'model': 'claude-3-5-sonnet-20241022',
                'messages': [{'role': 'user', 'content': 'Hello, world.'}],
            },
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data['estimated'] is True
    assert isinstance(data['input_tokens'], int)
    assert data['input_tokens'] > 0


async def test_count_tokens_with_tools_counts_them(monkeypatch):
    key = _enable_external_access(monkeypatch)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        no_tools = await client.post(
            '/v1/messages/count_tokens',
            headers={'Authorization': f'Bearer {key}'},
            json={'messages': [{'role': 'user', 'content': 'ping'}]},
        )
        with_tools = await client.post(
            '/v1/messages/count_tokens',
            headers={'Authorization': f'Bearer {key}'},
            json={
                'messages': [{'role': 'user', 'content': 'ping'}],
                'tools': [
                    {
                        'name': 'run_command',
                        'description': 'Run a shell command.',
                        'input_schema': {
                            'type': 'object',
                            'properties': {'command': {'type': 'string'}},
                            'required': ['command'],
                        },
                    }
                ],
            },
        )
    assert no_tools.status_code == 200
    assert with_tools.status_code == 200
    # Adding a tool definition must not reduce the estimated token count.
    assert with_tools.json()['input_tokens'] >= no_tools.json()['input_tokens']


async def test_count_tokens_rejects_without_external_access():
    """When external access is disabled (conftest default), /v1/* → 403.

    Confirms the new route is correctly wired into the gateway gate rather
    than accidentally open.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.post(
            '/v1/messages/count_tokens',
            json={'messages': [{'role': 'user', 'content': 'ping'}]},
        )
    assert resp.status_code == 403


# ── GET /api/providers/{id}/models ─────────────────────────────────────


async def test_list_provider_models_returns_stored_set():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/api/providers/test-openai/models')
    assert resp.status_code == 200
    data = resp.json()
    assert data['count'] == 1
    assert data['models'][0]['id'] == 'gpt-4o-mini'


async def test_list_provider_models_404_for_unknown_provider():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/api/providers/does-not-exist/models')
    assert resp.status_code == 404


# ── POST /api/providers/{id}/discover ──────────────────────────────────


async def test_discover_does_not_mutate_store(monkeypatch):
    """discover returns a prospective diff but must NOT persist new models.

    We stub the live fetch to return an extra model id, then assert the stored
    provider's model list is unchanged after the call.
    """
    from app.routers import providers as providers_router

    async def _fake_discover(provider_id, *, persist=False):
        # Simulate a live /models response that sees one new model.
        return (['gpt-4o-new'], ['gpt-4o-mini'], [], ['gpt-4o-mini', 'gpt-4o-new'])

    monkeypatch.setattr(providers_router, '_discoverProviderModels', _fake_discover)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        before = await client.get('/api/providers/test-openai/models')
        discover = await client.post('/api/providers/test-openai/discover')
        after = await client.get('/api/providers/test-openai/models')

    assert discover.status_code == 200
    payload = discover.json()
    assert payload['added'] == ['gpt-4o-new']
    assert payload['live'] == ['gpt-4o-mini', 'gpt-4o-new']
    # Store untouched: same count before and after.
    assert before.json()['count'] == after.json()['count'] == 1


async def test_discover_404_for_unknown_provider():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.post('/api/providers/does-not-exist/discover')
    assert resp.status_code == 404
