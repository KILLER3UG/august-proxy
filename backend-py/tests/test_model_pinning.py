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


async def test_aggregate_dedupe_keeps_pinned_across_providers():
    _seedProviders(
        [
            _provider('p-one', [{'id': 'shared-model', 'source': 'manual'}]),
            _provider('p-two', [{'id': 'shared-model', 'source': 'manual', 'pinned': True}]),
        ]
    )
    model_service.invalidate_cache()

    models = await model_service._aggregateModels()
    shared = [m for m in models if m['id'] == 'shared-model']
    assert len(shared) == 1
    assert shared[0]['pinned'] is True


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
