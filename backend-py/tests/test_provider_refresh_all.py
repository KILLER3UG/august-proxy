"""Startup bulk refresh of provider model lists.

Covers:
  • POST /api/providers/refresh-all — syncs every enabled, keyed provider,
    skips disabled/keyless ones, tolerates per-provider failures.
  • Prune-on-refresh — models previously fetched from upstream that vanished
    upstream are removed from the store; manual models are never pruned; an
    empty live list (failed fetch) prunes nothing.
"""

from app.main import app
from app.services import config_service
from httpx import ASGITransport, AsyncClient


def _seedProviders(providers: list[dict]) -> None:
    config_service.saveProvidersStore({'providers': providers})


def _provider(
    pid: str,
    *,
    enabled: bool = True,
    apiKey: str = 'sk-test',
    models: list[dict] | None = None,
) -> dict:
    return {
        'id': pid,
        'name': pid,
        'apiFormat': 'openaiChat',
        'baseUrl': 'https://example.test/v1',
        'apiKey': apiKey,
        'enabled': enabled,
        'models': models or [],
    }


# ── POST /api/providers/refresh-all ────────────────────────────────────


async def test_refresh_all_syncs_only_enabled_keyed_providers(monkeypatch):
    from app.routers import providers as providers_router

    _seedProviders(
        [
            _provider('p-one', models=[{'id': 'a', 'source': 'fetched'}]),
            _provider('p-two'),
            _provider('p-disabled', enabled=False),
            _provider('p-nokey', apiKey=''),
        ]
    )

    seen: list[tuple[str, bool]] = []

    async def _fakeDiscover(provider_id, *, persist=False):
        seen.append((provider_id, persist))
        return (['new-model'], ['a'], [], ['a', 'new-model'])

    monkeypatch.setattr(providers_router, '_discoverProviderModels', _fakeDiscover)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.post('/api/providers/refresh-all')

    assert resp.status_code == 200
    assert resp.json() == {'refreshed': 2, 'failed': 0, 'added': 2, 'removed': 0}
    # Disabled and keyless providers are skipped; sync always persists.
    assert seen == [('p-one', True), ('p-two', True)]


async def test_refresh_all_counts_unreachable_provider_as_failed(monkeypatch):
    from app.routers import providers as providers_router

    _seedProviders([_provider('p-one'), _provider('p-down')])

    async def _fakeDiscover(provider_id, *, persist=False):
        if provider_id == 'p-down':
            # Empty live list == upstream unreachable; nothing synced/pruned.
            return ([], [], [], [])
        return ([], ['a'], [], ['a'])

    monkeypatch.setattr(providers_router, '_discoverProviderModels', _fakeDiscover)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.post('/api/providers/refresh-all')

    assert resp.status_code == 200
    assert resp.json() == {'refreshed': 1, 'failed': 1, 'added': 0, 'removed': 0}


async def test_refresh_all_tolerates_provider_errors(monkeypatch):
    from app.routers import providers as providers_router

    _seedProviders([_provider('p-boom'), _provider('p-ok')])

    async def _fakeDiscover(provider_id, *, persist=False):
        if provider_id == 'p-boom':
            raise RuntimeError('upstream exploded')
        return ([], [], [], ['m'])

    monkeypatch.setattr(providers_router, '_discoverProviderModels', _fakeDiscover)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.post('/api/providers/refresh-all')

    assert resp.status_code == 200
    assert resp.json()['refreshed'] == 1
    assert resp.json()['failed'] == 1


# ── prune-on-refresh semantics (_discoverProviderModels persist) ───────


class _FakeResponse:
    def __init__(self, ids: list[str]):
        self._ids = ids
        self.status_code = 200

    def json(self):
        return {'data': [{'id': mid} for mid in self._ids]}


class _FakeAsyncClient:
    def __init__(self, ids: list[str]):
        self._ids = ids

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, headers=None):
        return _FakeResponse(self._ids)


def _patchUpstreamModels(monkeypatch, ids: list[str]) -> None:
    import httpx

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *a, **kw: _FakeAsyncClient(ids))


async def test_refresh_prunes_fetched_models_removed_upstream(monkeypatch):
    _seedProviders(
        [
            _provider(
                'p-one',
                models=[
                    {'id': 'alive', 'source': 'fetched'},
                    {'id': 'deprecated', 'source': 'fetched'},
                    {'id': 'my-custom', 'source': 'manual'},
                ],
            ),
        ]
    )
    _patchUpstreamModels(monkeypatch, ['alive', 'brand-new'])

    from app.routers import providers as providers_router

    added, _updated, removed, live = await providers_router._discoverProviderModels(
        'p-one', persist=True
    )

    assert live == ['alive', 'brand-new']
    assert added == ['brand-new']
    assert 'deprecated' in removed

    store = config_service.getProvidersStore()
    ids = {m['id'] for m in store['providers'][0]['models']}
    # Deprecated fetched model is gone, manual model is untouched, new model added.
    assert ids == {'alive', 'brand-new', 'my-custom'}


async def test_refresh_prunes_nothing_when_upstream_returns_empty(monkeypatch):
    _seedProviders(
        [_provider('p-one', models=[{'id': 'alive', 'source': 'fetched'}])]
    )
    _patchUpstreamModels(monkeypatch, [])

    from app.routers import providers as providers_router

    _added, _updated, removed, live = await providers_router._discoverProviderModels(
        'p-one', persist=True
    )

    assert live == []
    assert 'alive' in removed  # reported in the diff...

    store = config_service.getProvidersStore()
    ids = {m['id'] for m in store['providers'][0]['models']}
    assert ids == {'alive'}  # ...but NOT pruned from the store
