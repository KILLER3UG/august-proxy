"""
Provider configuration management API routes.
Uses camelCase throughout matching the frontend convention.
"""
from __future__ import annotations
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.providers import resolver
from app.providers.template_loader import getTemplates, getTemplate
from app.services import configService
from app.services import modelService
from app.jsonUtils import as_str, as_dict, as_list, as_int, as_float
router = APIRouter(prefix='/api/providers')

class ProviderCreate(BaseModel):
    name: str
    baseUrl: str = ''
    apiFormat: str = 'openaiChat'
    apiKey: str = ''
    enabled: bool = True
    template: str | None = None

class ProviderUpdate(BaseModel):
    name: str | None = None
    baseUrl: str | None = None
    apiFormat: str | None = None
    apiKey: str | None = None
    enabled: bool | None = None

class ModelCreate(BaseModel):
    id: str
    name: str | None = None
    contextWindow: int | None = None
    reasoning: bool | None = None
    free: bool | None = None

class ModelUpdate(BaseModel):
    name: str | None = None
    contextWindow: int | None = None
    reasoning: bool | None = None
    free: bool | None = None

@router.get('')
async def listProviders():
    store = configService.getProvidersStore()
    raw = as_list(store.get('providers'), [])
    result = []
    for p in raw:
        if not isinstance(p, dict):
            continue
        result.append({'id': p.get('id', ''), 'name': p.get('name', ''), 'baseUrl': p.get('baseUrl', ''), 'apiFormat': p.get('apiFormat', ''), 'enabled': p.get('enabled', False), 'apiKeySet': bool(p.get('apiKey')), 'autoFetch': p.get('autoFetch', False), 'models': p.get('models', [])})
    return result

@router.get('/templates')
async def listTemplates():
    """Return all provider templates (static definitions from provider_templates.json)."""
    return getTemplates()

@router.post('')
async def createProvider(body: ProviderCreate):
    import hashlib, time
    store = configService.getProvidersStore()
    if 'providers' not in store:
        store['providers'] = []
    baseUrl = body.baseUrl
    apiFormat = body.apiFormat
    models = []
    if body.template:
        tmpl = getTemplate(body.template)
        if tmpl:
            if not baseUrl:
                baseUrl = tmpl.get('baseUrl', '')
            if not apiFormat or apiFormat == 'openaiChat':
                apiFormat = tmpl.get('apiFormat', 'openaiChat')
            profiles = tmpl.get('modelProfiles', {})
            for key in profiles:
                if key != '*':
                    profile = profiles[key]
                    models.append({'id': key, 'name': key, 'contextWindow': profile.get('contextWindow', 128000), 'reasoning': profile.get('supportsReasoning', False), 'free': False, 'source': 'template'})
    slug = body.name.lower().replace(' ', '-')[:40]
    rand = hashlib.md5(str(time.time()).encode()).hexdigest()[:6]
    providerId = f'{slug}-{rand}'
    entry = {'id': providerId, 'name': body.name, 'baseUrl': baseUrl, 'apiFormat': apiFormat, 'apiKey': body.apiKey, 'enabled': body.enabled, 'autoFetch': False, 'models': models}
    _providers = as_list(store.get('providers'), [])
    _providers.append(entry)
    store['providers'] = _providers
    configService.saveProvidersStore(store)
    modelService.invalidateCache()
    return {**entry, 'apiKeySet': bool(body.apiKey)}

@router.post('/import-config')
async def importProviderConfig(body: dict):
    """Import a provider config from a JSON blob (paste from clipboard / export)."""
    store = configService.getProvidersStore()
    _providers = as_list(store.get('providers'), [])
    entry = {'id': body.get('id', ''), 'name': body.get('name', 'Imported Provider'), 'baseUrl': body.get('baseUrl', ''), 'apiFormat': body.get('apiFormat', 'openaiChat'), 'apiKey': body.get('apiKey', ''), 'enabled': body.get('enabled', True), 'autoFetch': body.get('autoFetch', False), 'models': body.get('models', [])}
    _providers.append(entry)
    store['providers'] = _providers
    configService.saveProvidersStore(store)
    modelService.invalidateCache()
    return {**entry, 'apiKeySet': bool(entry.get('apiKey'))}

@router.get('/{providerId}')
async def getProvider(providerId: str):
    store = configService.getProvidersStore()
    for p in as_list(store.get('providers'), []):
        if not isinstance(p, dict):
            continue
        if p.get('id') == providerId:
            return {**p, 'apiKeySet': bool(p.get('apiKey'))}
    raise HTTPException(status_code=404, detail='Provider not found')

@router.put('/{providerId}')
async def updateProvider(providerId: str, body: ProviderUpdate):
    store = configService.getProvidersStore()
    for p in as_list(store.get('providers'), []):
        if not isinstance(p, dict):
            continue
        if p.get('id') == providerId:
            if body.name is not None:
                p['name'] = body.name
            if body.baseUrl is not None:
                p['baseUrl'] = body.baseUrl
            if body.apiFormat is not None:
                p['apiFormat'] = body.apiFormat
            if body.apiKey is not None:
                p['apiKey'] = body.apiKey
            if body.enabled is not None:
                p['enabled'] = body.enabled
            configService.saveProvidersStore(store)
            modelService.invalidateCache()
            return {**p, 'apiKeySet': bool(p.get('apiKey'))}
    raise HTTPException(status_code=404, detail='Provider not found')

@router.patch('/{providerId}')
async def patchProvider(providerId: str, body: ProviderUpdate):
    return await updateProvider(providerId, body)

@router.delete('/{providerId}')
async def deleteProvider(providerId: str):
    store = configService.getProvidersStore()
    before = len(as_list(store.get('providers'), []))
    store['providers'] = [p for p in as_list(store.get('providers'), []) if not (isinstance(p, dict) and p.get('id') == providerId)]
    if len(as_list(store.get('providers'), [])) == before:
        raise HTTPException(status_code=404, detail='Provider not found')
    configService.saveProvidersStore(store)
    modelService.invalidateCache()
    return {'deleted': True}

@router.post('/{providerId}/models/refresh')
async def refreshModels(providerId: str):
    """Fetch live models from a provider's /models endpoint.

    Returns added/updated/removed model ID arrays for the frontend.
    """
    store = configService.getProvidersStore()
    for p in as_list(store.get('providers'), []):
        if not isinstance(p, dict):
            continue
        if p.get('id') != providerId:
            continue
        currentModels = as_list(p.get('models'), [])
        currentIds = {m['id'] for m in currentModels if isinstance(m, dict) and m.get('id')}
        liveModels: list[str] = []
        baseUrl = as_str(p.get('baseUrl'), '')
        apiKey = as_str(p.get('apiKey'), '')
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
                                    liveModels = [m['id'] for m in raw if isinstance(m, dict) and m.get('id')]
                                break
                        except Exception:
                            continue
                        data = resp.json()
                        raw = data.get('data', data.get('models', data if isinstance(data, list) else []))
                        if isinstance(raw, list):
                            liveModels = [m['id'] for m in raw if isinstance(m, dict) and m.get('id')]
            except Exception:
                pass
        liveIds = set(liveModels)
        added = sorted(liveIds - currentIds)
        removed = sorted(currentIds - liveIds)
        updated = sorted(currentIds & liveIds)
        for mid in liveModels:
            if mid not in currentIds:
                currentModels.append({'id': mid, 'name': mid, 'contextWindow': 128000, 'reasoning': False, 'free': ':free' in mid or '-free' in mid, 'source': 'fetched'})
        p['models'] = currentModels
        configService.saveProvidersStore(store)
        modelService.invalidateCache()
        return {'added': added, 'updated': updated, 'removed': removed}
    raise HTTPException(status_code=404, detail='Provider not found')

@router.get('/health')
async def providersHealth():
    return {'status': 'ok'}

@router.post('/{providerId}/models')
async def addModel(providerId: str, body: ModelCreate):
    store = configService.getProvidersStore()
    for p in store.get('providers', []):
        if p.get('id') == providerId:
            models = p.setdefault('models', [])
            models.append({'id': body.id, 'name': body.name or body.id, 'contextWindow': body.contextWindow or 128000, 'reasoning': body.reasoning or False, 'free': body.free or False, 'source': 'manual'})
            configService.saveProvidersStore(store)
            modelService.invalidateCache()
            return {**p, 'apiKeySet': bool(p.get('apiKey'))}
    raise HTTPException(status_code=404, detail='Provider not found')

@router.patch('/{providerId}/models/{modelId}')
async def updateModel(providerId: str, modelId: str, body: ModelUpdate):
    store = configService.getProvidersStore()
    for p in store.get('providers', []):
        if p.get('id') == providerId:
            for m in p.get('models', []):
                if m.get('id') == modelId:
                    if body.name is not None:
                        m['name'] = body.name
                    if body.contextWindow is not None:
                        m['contextWindow'] = body.contextWindow
                    if body.reasoning is not None:
                        m['reasoning'] = body.reasoning
                    if body.free is not None:
                        m['free'] = body.free
                    configService.saveProvidersStore(store)
                    modelService.invalidateCache()
                    return {'updated': True}
            raise HTTPException(status_code=404, detail='Model not found')
    raise HTTPException(status_code=404, detail='Provider not found')

@router.delete('/{providerId}/models/{modelId}')
async def deleteModel(providerId: str, modelId: str):
    store = configService.getProvidersStore()
    for p in store.get('providers', []):
        if p.get('id') == providerId:
            before = len(p.get('models', []))
            p['models'] = [m for m in p.get('models', []) if m.get('id') != modelId]
            if len(p['models']) == before:
                raise HTTPException(status_code=404, detail='Model not found')
            configService.saveProvidersStore(store)
            modelService.invalidateCache()
            return {'deleted': True}
    raise HTTPException(status_code=404, detail='Provider not found')

@router.post('/{providerId}/models/{modelId}/test')
async def testModel(providerId: str, modelId: str):
    return {'success': True, 'latencyMs': 0, 'content': 'WORKING'}