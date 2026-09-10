"""Model pinning: persistence via PATCH, aggregation ranking (pinned → free → name)."""

from app.main import app
from app.services import config_service, model_service
from httpx import ASGITransport, AsyncClient


def _seedProviders(providers: list[dict]) -> None:
    config_service.saveProvidersStore({'providers': providers})


def _provider(pid: str, models: list[dict]) -> dict:
    return {
        'id': pid,
        'name': pid,
        'apiFormat': 'openaiChat',
        'baseUrl': 'https://example.test/v1',
        'apiKey': 'sk-test',
        'enabled': True,
        'models': models,
    }


async def test_update_model_sets_pinned():
    _seedProviders(
        [_provider('p-one', [{'id': 'model-a', 'name': 'Model A', 'source': 'manual'}])]
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        patch = await client.patch('/api/providers/p-one/models/model-a', json={'pinned': True})
        got = await client.get('/api/providers')

    assert patch.status_code == 200
    models = got.json()[0]['models']
    assert models[0]['pinned'] is True

    # And unpin again.
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        await client.patch('/api/providers/p-one/models/model-a', json={'pinned': False})
        got = await client.get('/api/providers')
    assert got.json()[0]['models'][0]['pinned'] is False


async def test_aggregate_sorts_pinned_before_free_before_name():
    _seedProviders(
        [
            _provider(
                'p-one',
                [
                    {'id': 'zeta-paid', 'source': 'manual', 'pinned': True},
                    {'id': 'alpha-free', 'source': 'manual', 'free': True},
                    {'id': 'mid-paid', 'source': 'manual'},
                ],
            ),
        ]
    )
    model_service.invalidate_cache()

    models = await model_service._aggregateModels()
    ids = [m['id'] for m in models]

    # Pinned first (even though alphabetically last), then free, then the rest.
    assert ids.index('zeta-paid') == 0
    assert ids.index('alpha-free') < ids.index('mid-paid')
    pinned = next(m for m in models if m['id'] == 'zeta-paid')
    assert pinned['pinned'] is True


async def test_aggregate_keeps_same_model_per_provider():
    """(id, provider) dedupe, not id-only: the same model offered by two
    gateways appears under BOTH provider groups (the chat dropdown was
    hiding Kilo's copy of every OpenRouter-shared id — the 'dropdown is
    missing models' bug). The old cross-provider collapse test encoded the
    bug as a contract; /v1/models still exposes ids uniquely below."""
    _seedProviders(
        [
            _provider('p-one', [{'id': 'shared-model', 'source': 'manual'}]),
            _provider('p-two', [{'id': 'shared-model', 'source': 'manual', 'pinned': True}]),
        ]
    )
    model_service.invalidate_cache()

    models = await model_service._aggregateModels()
    shared = [m for m in models if m['id'] == 'shared-model']
    assert len(shared) == 2
    byProvider = {m['provider']: m for m in shared}
    assert byProvider['p-two']['pinned'] is True
    assert byProvider['p-one']['pinned'] is False
    # Pinned sorts first even with a second copy of the id present.
    assert models[0]['pinned'] is True


async def test_v1_models_ids_unique_across_providers():
    """The OpenAI wire contract wants unique ids; the /v1/models view
    collapses the per-provider duplicates while /api/models keeps them.
    Route fn called directly — over HTTP it sits behind require_gateway_key."""
    from app.routers.models import openaiModels

    _seedProviders(
        [
            _provider('p-one', [{'id': 'shared-model', 'source': 'manual'}]),
            _provider('p-two', [{'id': 'shared-model', 'source': 'manual', 'pinned': True}]),
        ]
    )
    model_service.invalidate_cache()
    body = await openaiModels(_auth=True)
    ids = [m['id'] for m in body['data']]
    assert ids.count('shared-model') == 1
    assert body['data'][0]['owned_by'] in ('p-one', 'p-two')


async def test_api_models_exposes_pinned():
    _seedProviders(
        [_provider('p-one', [{'id': 'model-a', 'source': 'manual', 'pinned': True}])]
    )
    model_service.invalidate_cache()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/api/models')

    entry = next(m for m in resp.json()['models'] if m['id'] == 'model-a')
    assert entry.get('pinned') is True
