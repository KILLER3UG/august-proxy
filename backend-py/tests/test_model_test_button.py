"""Model Test button (POST /api/providers/{id}/models/{modelId}/test) behavior.

Covers two regressions:

1. **"Not found" on all manual providers with slashy model ids** — the route
   used the default ``{modelId}`` converter, which matches a single path
   segment. A model id like ``openai/gpt-4o`` (encoded as ``openai%2Fgpt-4o``)
   failed to match the route, hit August's SPA 404 fallback, and surfaced as
   the HTTP status text "Not Found". The fix is ``{modelId:path}``.

2. **Strict ``Connected!`` match false-failed reachable models** — reasoning
   models often emit thinking but a short/empty ``content``, or prefix the
   reply. The probe now accepts any non-empty reply as success.
"""

import app.services.workbench.providers as wb_providers
from app.main import app
from httpx import ASGITransport, AsyncClient


async def _setup_provider(client: AsyncClient, *, name: str = 'Slash Test') -> str:
    """Create a provider and return its store id."""
    resp = await client.post(
        '/api/providers',
        json={
            'name': name,
            'baseUrl': 'https://gateway.example.com/v1',
            'apiFormat': 'openaiChat',
            'apiKey': 'sk-test',
            'enabled': True,
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()['id']


async def _add_model(client: AsyncClient, provider_id: str, model_id: str) -> None:
    resp = await client.post(
        f'/api/providers/{provider_id}/models',
        json={'id': model_id, 'contextWindow': 128000},
    )
    assert resp.status_code == 200, resp.text


async def test_test_route_matches_slashy_model_id(isolatedData, monkeypatch):
    """A model id with a ``/`` must reach the handler, not 404.

    Regression for: "Test button always says Not found" — the default
    ``{modelId}`` converter rejected ``openai/gpt-4o`` and the SPA fallback
    returned status 404 (surfaced as the bare status text "Not Found").
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        provider_id = await _setup_provider(client)
        await _add_model(client, provider_id, 'openai/gpt-4o')

        # Stub the upstream call so no real network is made.
        async def _fake_call_openai(messages, system, model, tools, effort, **kwargs):
            return {'text': 'Connected!', 'thinking': '', 'tool_uses': []}

        monkeypatch.setattr(wb_providers, 'call_openai_workbench', _fake_call_openai)

        resp = await client.post(
            f'/api/providers/{provider_id}/models/openai%2Fgpt-4o/test'
        )
        # Before the fix this was 404 ("Not Found"). Now the route matches.
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data['success'] is True


async def test_update_route_matches_slashy_model_id(isolatedData):
    """PATCH model with a slashy id must reach the handler, not 404."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        provider_id = await _setup_provider(client, name='Update Slash')
        await _add_model(client, provider_id, 'anthropic/claude-sonnet-4')

        resp = await client.patch(
            f'/api/providers/{provider_id}/models/anthropic%2Fclaude-sonnet-4',
            json={'contextWindow': 200000},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {'updated': True}


async def test_delete_route_matches_slashy_model_id(isolatedData):
    """DELETE model with a slashy id must reach the handler, not 404."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        provider_id = await _setup_provider(client, name='Delete Slash')
        await _add_model(client, provider_id, 'meta-llama/Llama-3.1-405B')

        resp = await client.delete(
            f'/api/providers/{provider_id}/models/meta-llama%2FLlama-3.1-405B'
        )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {'deleted': True}


async def test_probe_passes_thinking_enabled_false(isolatedData, monkeypatch):
    """The connectivity probe must disable thinking/reasoning extras.

    Some gateways reject ``reasoning_effort`` / ``thinking.budget_tokens``
    even when they accept chat's richer body. The probe mirrors a minimal
    chat request by passing ``thinking_enabled=False``.
    """
    captured: dict = {}

    async def _fake_call_openai(messages, system, model, tools, effort, **kwargs):
        captured.update(kwargs)
        return {'text': 'Connected!', 'thinking': '', 'tool_uses': []}

    monkeypatch.setattr(wb_providers, 'call_openai_workbench', _fake_call_openai)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        provider_id = await _setup_provider(client, name='Thinking Probe')
        await _add_model(client, provider_id, 'gpt-4o')

        resp = await client.post(f'/api/providers/{provider_id}/models/gpt-4o/test')
        assert resp.status_code == 200, resp.text
        assert resp.json()['success'] is True

    assert captured.get('thinking_enabled') is False
    assert captured.get('emit') is None


async def test_probe_accepts_non_connected_reply(isolatedData, monkeypatch):
    """A reachable model that replies with something other than ``Connected!``
    still counts as success — the endpoint answered, so it is connected.

    Regression for: reasoning models emitting thinking-only content or
    prefixed replies false-failed the strict ``Connected!`` exact match.
    """
    async def _fake_call_openai(messages, system, model, tools, effort, **kwargs):
        # Model ignores the probe instruction and greets instead.
        return {'text': 'Hello! How can I help?', 'thinking': '', 'tool_uses': []}

    monkeypatch.setattr(wb_providers, 'call_openai_workbench', _fake_call_openai)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        provider_id = await _setup_provider(client, name='Relaxed Match')
        await _add_model(client, provider_id, 'gpt-4o')

        resp = await client.post(f'/api/providers/{provider_id}/models/gpt-4o/test')
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data['success'] is True
        assert data['error'] is None


async def test_probe_reports_upstream_error_as_failure(isolatedData, monkeypatch):
    """A real upstream error (404/auth/billing) stays a failure with the message."""
    async def _fake_call_openai(messages, system, model, tools, effort, **kwargs):
        return {'error': '[404] model not found', 'text': '', 'thinking': '', 'tool_uses': []}

    monkeypatch.setattr(wb_providers, 'call_openai_workbench', _fake_call_openai)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        provider_id = await _setup_provider(client, name='Upstream Error')
        await _add_model(client, provider_id, 'gpt-4o')

        resp = await client.post(f'/api/providers/{provider_id}/models/gpt-4o/test')
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data['success'] is False
        assert '404' in data['error']


async def test_probe_reports_empty_reply_as_failure(isolatedData, monkeypatch):
    """An empty reply (reachable but no text) stays a distinct failure."""
    async def _fake_call_openai(messages, system, model, tools, effort, **kwargs):
        return {'text': '', 'thinking': '', 'tool_uses': []}

    monkeypatch.setattr(wb_providers, 'call_openai_workbench', _fake_call_openai)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        provider_id = await _setup_provider(client, name='Empty Reply')
        await _add_model(client, provider_id, 'gpt-4o')

        resp = await client.post(f'/api/providers/{provider_id}/models/gpt-4o/test')
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data['success'] is False
        assert 'empty' in data['error'].lower()
