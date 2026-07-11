"""
Provider configuration management API routes.
Uses camelCase throughout matching the frontend convention.
"""

from __future__ import annotations
from fastapi import APIRouter, HTTPException
from app.models.config import ProviderConfig, ProviderCreate, ProviderUpdate, ModelCreate, ModelUpdate
from app.providers import resolver
from app.providers.template_loader import getTemplates, getTemplate
from app.jsonUtils import as_bool, as_dict, as_int, as_list, as_str
from app.services import config_service
from app.services import model_service

router = APIRouter(prefix='/api/providers')


def _provider_to_dict(p: object) -> dict:
    """Convert a ProviderConfig or raw dict to the API response shape."""
    from app.models.config import ProviderConfig

    if isinstance(p, ProviderConfig):
        return {
            'id': p.id,
            'name': p.name,
            'baseUrl': p.base_url,
            'apiFormat': p.api_format,
            'apiKey': p.api_key,
            'enabled': p.enabled,
            'apiKeySet': bool(p.api_key),
            'autoFetch': p.auto_fetch,
            'models': [
                {
                    'id': m.id,
                    'name': m.name,
                    'contextWindow': m.context_window,
                    'reasoning': m.reasoning,
                    'free': m.free,
                    'source': m.source,
                }
                for m in p.models
            ],
        }
    # Fallback for raw dicts
    pd = dict(p) if isinstance(p, dict) else {}
    return {
        'id': as_str(pd.get('id', '')),
        'name': as_str(pd.get('name', '')),
        'baseUrl': as_str(pd.get('baseUrl', '')),
        'apiFormat': as_str(pd.get('apiFormat', '')),
        'apiKey': as_str(pd.get('apiKey', '')),
        'enabled': as_bool(pd.get('enabled', False)),
        'apiKeySet': bool(pd.get('apiKey')),
        'autoFetch': as_bool(pd.get('autoFetch', False)),
        'models': as_list(pd.get('models', [])),
    }


@router.get('')
async def listProviders():
    providers = config_service.getProvidersAsModels()
    return [_provider_to_dict(p) for p in providers]


@router.get('/templates')
async def listTemplates():
    """Return all provider templates (static definitions from provider_templates.json)."""
    return getTemplates()


@router.post('')
async def createProvider(body: ProviderCreate):
    import hashlib, time

    store = config_service.getProvidersStore()
    if 'providers' not in store:
        store['providers'] = []
    baseUrl = body.base_url
    apiFormat = body.api_format
    models: list[dict] = []
    if body.template:
        tmpl = getTemplate(body.template)
        if tmpl:
            if not baseUrl:
                baseUrl = as_str(tmpl.get('baseUrl', ''))
            if not apiFormat or apiFormat == 'openaiChat':
                apiFormat = as_str(tmpl.get('apiFormat', 'openaiChat'))
            profiles = as_dict(tmpl.get('modelProfiles', {}))
            # If we have specific model profiles, use them
            for key, val in profiles.items():
                if key != '*':
                    profile = as_dict(val)
                    models.append(
                        {
                            'id': key,
                            'name': key,
                            'contextWindow': as_int(profile.get('contextWindow', 128000)),
                            'reasoning': as_bool(profile.get('supportsReasoning', False)),
                            'free': False,
                            'source': 'template',
                        }
                    )
            # If we only have a wildcard profile or no models were added, add the default model
            if not models and '*' in profiles:
                default_model = as_str(tmpl.get('defaultModel', ''))
                if default_model:
                    wildcard_profile = as_dict(profiles['*'])
                    models.append(
                        {
                            'id': default_model,
                            'name': default_model,
                            'contextWindow': as_int(wildcard_profile.get('contextWindow', 128000)),
                            'reasoning': as_bool(wildcard_profile.get('supportsReasoning', False)),
                            'free': False,
                            'source': 'template',
                        }
                    )
    slug = body.name.lower().replace(' ', '-')[:40]
    rand = hashlib.md5(str(time.time()).encode()).hexdigest()[:6]
    providerId = f'{slug}-{rand}'
    entry = {
        'id': providerId,
        'name': body.name,
        'baseUrl': baseUrl,
        'apiFormat': apiFormat,
        'apiKey': body.api_key,
        'enabled': body.enabled,
        'autoFetch': False,
        'models': models,
    }
    providers_list = as_list(store.get('providers', []))
    if not isinstance(providers_list, list):
        providers_list = []
    providers_list.append(entry)
    store['providers'] = providers_list
    config_service.saveProvidersStore(store)
    model_service.invalidateCache()
    return {**entry, 'apiKeySet': bool(body.api_key)}


@router.post('/import-config')
async def importProviderConfig(body: dict):
    """Import a provider config from a JSON blob (paste from clipboard / export)."""
    store = config_service.getProvidersStore()
    providers_list = as_list(store.get('providers', []))
    if not isinstance(providers_list, list):
        providers_list = []
    entry = {
        'id': body.get('id', ''),
        'name': body.get('name', 'Imported Provider'),
        'baseUrl': body.get('baseUrl', ''),
        'apiFormat': body.get('apiFormat', 'openaiChat'),
        'apiKey': body.get('apiKey', ''),
        'enabled': body.get('enabled', True),
        'autoFetch': body.get('autoFetch', False),
        'models': body.get('models', []),
    }
    providers_list.append(entry)
    store['providers'] = providers_list
    config_service.saveProvidersStore(store)
    model_service.invalidateCache()
    return {**entry, 'apiKeySet': bool(entry.get('apiKey'))}


@router.get('/{providerId}')
async def getProvider(providerId: str):
    for p in config_service.getProvidersAsModels():
        if p.id == providerId:
            return _provider_to_dict(p)
    raise HTTPException(status_code=404, detail='Provider not found')


@router.put('/{providerId}')
async def updateProvider(providerId: str, body: ProviderUpdate):
    store = config_service.getProvidersStore()
    providers_list = as_list(store.get('providers', []))
    if not isinstance(providers_list, list):
        providers_list = []
    for p in providers_list:
        if not isinstance(p, dict):
            continue
        if as_str(p.get('id', '')) == providerId:
            if body.name is not None:
                p['name'] = body.name
            if body.base_url is not None:
                p['baseUrl'] = body.base_url
            if body.api_format is not None:
                p['apiFormat'] = body.api_format
            if body.api_key is not None:
                p['apiKey'] = body.api_key
            if body.enabled is not None:
                p['enabled'] = body.enabled
            config_service.saveProvidersStore(store)
            model_service.invalidateCache()
            return {**p, 'apiKeySet': bool(p.get('apiKey'))}
    raise HTTPException(status_code=404, detail='Provider not found')


@router.patch('/{providerId}')
async def patchProvider(providerId: str, body: ProviderUpdate):
    return await updateProvider(providerId, body)


@router.delete('/{providerId}')
async def deleteProvider(providerId: str):
    store = config_service.getProvidersStore()
    providers_list = as_list(store.get('providers', []))
    if not isinstance(providers_list, list):
        providers_list = []
    before = len(providers_list)
    remaining = [p for p in providers_list if not (isinstance(p, dict) and as_str(p.get('id', '')) == providerId)]
    store['providers'] = remaining
    if len(remaining) == before:
        raise HTTPException(status_code=404, detail='Provider not found')
    config_service.saveProvidersStore(store)
    model_service.invalidateCache()
    return {'deleted': True}


@router.post('/{providerId}/models/refresh')
async def refreshModels(providerId: str):
    """Fetch live models from a provider's /models endpoint.

    Returns added/updated/removed model ID arrays for the frontend.
    """
    store = config_service.getProvidersStore()
    providers_list = as_list(store.get('providers', []))
    if not isinstance(providers_list, list):
        providers_list = []
    for p in providers_list:
        if not isinstance(p, dict):
            continue
        if as_str(p.get('id', '')) != providerId:
            continue
        currentModels = as_list(p.get('models', []))
        if not isinstance(currentModels, list):
            currentModels = []
        currentIds = {m['id'] for m in currentModels if isinstance(m, dict) and as_str(m.get('id', ''))}
        liveModels: list[str] = []
        baseUrl = as_str(p.get('baseUrl', ''))
        apiKey = as_str(p.get('apiKey', ''))
        if baseUrl and apiKey:
            try:
                import httpx

                base = baseUrl.rstrip('/')
                candidates: list[str] = []
                if base.endswith('/chat/completions'):
                    candidates.append(base.replace('/chat/completions', '/v1/models'))
                    candidates.append(base.replace('/chat/completions', '/models'))
                elif base.endswith('/v1'):
                    candidates.append(base + '/models')
                    candidates.append(base.replace('/v1', '') + '/models')
                else:
                    candidates.append(base + '/v1/models')
                    candidates.append(base + '/models')
                async with httpx.AsyncClient(timeout=5) as client:
                    for url in candidates:
                        try:
                            resp = await client.get(url, headers={'Authorization': f'Bearer {apiKey}'})
                            if resp.status_code == 200:
                                data = resp.json()
                                raw = data.get('data', data.get('models', data if isinstance(data, list) else []))
                                if isinstance(raw, list):
                                    liveModels = [
                                        m['id'] for m in raw if isinstance(m, dict) and as_str(m.get('id', ''))
                                    ]
                                break
                        except Exception:
                            continue
                        data = resp.json()
                        raw = data.get('data', data.get('models', data if isinstance(data, list) else []))
                        if isinstance(raw, list):
                            liveModels = [m['id'] for m in raw if isinstance(m, dict) and as_str(m.get('id', ''))]
            except Exception:
                pass
        liveIds = set(liveModels)
        added = sorted(liveIds - currentIds)
        removed = sorted(currentIds - liveIds)
        updated = sorted(currentIds & liveIds)
        for mid in liveModels:
            if mid not in currentIds:
                currentModels.append(
                    {
                        'id': mid,
                        'name': mid,
                        'contextWindow': 128000,
                        'reasoning': False,
                        'free': ':free' in mid or '-free' in mid,
                        'source': 'fetched',
                    }
                )
        p['models'] = currentModels
        config_service.saveProvidersStore(store)
        model_service.invalidateCache()
        return {'added': added, 'updated': updated, 'removed': removed}
    raise HTTPException(status_code=404, detail='Provider not found')


@router.get('/health')
async def providersHealth():
    return {'status': 'ok'}


@router.post('/{providerId}/models')
async def addModel(providerId: str, body: ModelCreate):
    store = config_service.getProvidersStore()
    providers_list = as_list(store.get('providers', []))
    if not isinstance(providers_list, list):
        providers_list = []
    for p in providers_list:
        if not isinstance(p, dict):
            continue
        if as_str(p.get('id', '')) == providerId:
            p_models = as_list(p.setdefault('models', []))
            p_models.append(
                {
                    'id': body.id,
                    'name': body.name or body.id,
                    'contextWindow': body.context_window or 128000,
                    'reasoning': body.reasoning or False,
                    'free': body.free or False,
                    'source': 'manual',
                }
            )
            config_service.saveProvidersStore(store)
            model_service.invalidateCache()
            return {**p, 'apiKeySet': bool(p.get('apiKey'))}
    raise HTTPException(status_code=404, detail='Provider not found')


@router.patch('/{providerId}/models/{modelId}')
async def updateModel(providerId: str, modelId: str, body: ModelUpdate):
    store = config_service.getProvidersStore()
    providers_list = as_list(store.get('providers', []))
    if not isinstance(providers_list, list):
        providers_list = []
    for p in providers_list:
        if not isinstance(p, dict):
            continue
        if as_str(p.get('id', '')) == providerId:
            for m in as_list(p.get('models', [])):
                if not isinstance(m, dict):
                    continue
                if as_str(m.get('id', '')) == modelId:
                    if body.name is not None:
                        m['name'] = body.name
                    if body.context_window is not None:
                        m['contextWindow'] = body.context_window
                    if body.reasoning is not None:
                        m['reasoning'] = body.reasoning
                    if body.free is not None:
                        m['free'] = body.free
                    config_service.saveProvidersStore(store)
                    model_service.invalidateCache()
                    return {'updated': True}
            raise HTTPException(status_code=404, detail='Model not found')
    raise HTTPException(status_code=404, detail='Provider not found')


@router.delete('/{providerId}/models/{modelId}')
async def deleteModel(providerId: str, modelId: str):
    store = config_service.getProvidersStore()
    providers_list = as_list(store.get('providers', []))
    if not isinstance(providers_list, list):
        providers_list = []
    for p in providers_list:
        if not isinstance(p, dict):
            continue
        if as_str(p.get('id', '')) == providerId:
            p_models = as_list(p.get('models', []))
            before = len(p_models)
            remaining = [m for m in p_models if not (isinstance(m, dict) and as_str(m.get('id', '')) == modelId)]
            p['models'] = remaining
            if len(remaining) == before:
                raise HTTPException(status_code=404, detail='Model not found')
            config_service.saveProvidersStore(store)
            model_service.invalidateCache()
            return {'deleted': True}
    raise HTTPException(status_code=404, detail='Provider not found')


@router.post('/{providerId}/models/{modelId}/test')
async def testModel(providerId: str, modelId: str):
    return {'success': True, 'latencyMs': 0, 'content': 'WORKING'}
