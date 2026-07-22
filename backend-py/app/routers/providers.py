"""
Provider configuration management API routes.
Uses camelCase throughout matching the frontend convention.
"""

from __future__ import annotations
from fastapi import APIRouter, HTTPException
from app.models.config import ProviderConfig, ProviderCreate, ProviderUpdate, ModelCreate, ModelUpdate
from app.json_narrowing import as_bool, as_dict, as_list, as_str
from app.services import config_service
from app.services import model_service

router = APIRouter(prefix='/api/providers')


def _provider_to_dict(p: object) -> dict:
    """Convert a ProviderConfig or raw dict to the API response shape."""
    from app.providers.api_format import normalize_api_format

    if isinstance(p, ProviderConfig):
        return {
            'id': p.id,
            'name': p.name,
            'baseUrl': p.base_url,
            'apiFormat': normalize_api_format(p.api_format, default='openaiChat'),
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
        'apiFormat': normalize_api_format(pd.get('apiFormat'), default='openaiChat'),
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
    """Deprecated: templates removed. Always returns ``[]`` for back-compat."""
    return []


# Static `/health` must be registered before `/{providerId}` or "health" is captured as an id.
@router.get('/health')
async def providersHealth():
    return {'status': 'ok'}


@router.post('')
async def createProvider(body: ProviderCreate):
    import hashlib
    import time

    store = config_service.getProvidersStore()
    if 'providers' not in store:
        store['providers'] = []
    from app.providers.api_format import normalize_api_format, normalize_provider_base_url

    baseUrl = normalize_provider_base_url(body.base_url)
    apiFormat = normalize_api_format(body.api_format, default='openaiChat')
    if not baseUrl:
        raise HTTPException(
            status_code=400,
            detail='baseUrl is required — configure the provider endpoint yourself (no built-in templates).',
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
        'models': [],
    }
    providers_list = as_list(store.get('providers', []))
    if not isinstance(providers_list, list):
        providers_list = []
    providers_list.append(entry)
    store['providers'] = providers_list
    config_service.saveProvidersStore(store)
    model_service.invalidate_cache()
    try:
        from app.services.realtime_bus import emit_invalidate

        emit_invalidate('models', 'providers', 'provider-health')
    except Exception:
        pass
    return {**entry, 'apiKeySet': bool(body.api_key)}


@router.post('/import-config')
async def importProviderConfig(body: dict):
    """Import a provider config from a JSON blob (paste from clipboard / export)."""
    store = config_service.getProvidersStore()
    providers_list = as_list(store.get('providers', []))
    if not isinstance(providers_list, list):
        providers_list = []
    from app.providers.api_format import normalize_api_format, normalize_provider_base_url

    entry = {
        'id': body.get('id', ''),
        'name': body.get('name', 'Imported Provider'),
        'baseUrl': normalize_provider_base_url(body.get('baseUrl', '')),
        'apiFormat': normalize_api_format(body.get('apiFormat'), default='openaiChat'),
        'apiKey': body.get('apiKey', ''),
        'enabled': body.get('enabled', True),
        'autoFetch': body.get('autoFetch', False),
        'models': body.get('models', []),
    }
    providers_list.append(entry)
    store['providers'] = providers_list
    config_service.saveProvidersStore(store)
    model_service.invalidate_cache()
    try:
        from app.services.realtime_bus import emit_invalidate

        emit_invalidate('models', 'providers', 'provider-health')
    except Exception:
        pass
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
                from app.providers.api_format import normalize_provider_base_url

                p['baseUrl'] = normalize_provider_base_url(body.base_url)
            if body.api_format is not None:
                from app.providers.api_format import normalize_api_format

                p['apiFormat'] = normalize_api_format(body.api_format, default='openaiChat')
            if body.api_key is not None:
                p['apiKey'] = body.api_key
            if body.enabled is not None:
                p['enabled'] = body.enabled
            config_service.saveProvidersStore(store)
            model_service.invalidate_cache()
            try:
                from app.services.realtime_bus import emit_invalidate

                emit_invalidate('models', 'providers', 'provider-health')
            except Exception:
                pass
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
    model_service.invalidate_cache()
    try:
        from app.services.realtime_bus import emit_invalidate

        emit_invalidate('models', 'providers', 'provider-health')
    except Exception:
        pass
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

                from app.providers.api_format import join_provider_url, normalize_provider_base_url

                # Exact pasted base + /models — never invent /v1.
                base = normalize_provider_base_url(baseUrl)
                models_url = join_provider_url(base, 'models') if base else ''
                if models_url:
                    async with httpx.AsyncClient(timeout=5) as client:
                        try:
                            resp = await client.get(
                                models_url, headers={'Authorization': f'Bearer {apiKey}'}
                            )
                            if resp.status_code == 200:
                                data = resp.json()
                                raw = data.get(
                                    'data', data.get('models', data if isinstance(data, list) else [])
                                )
                                if isinstance(raw, list):
                                    liveModels = [
                                        m['id']
                                        for m in raw
                                        if isinstance(m, dict) and as_str(m.get('id', ''))
                                    ]
                        except Exception:
                            pass
            except Exception:
                pass
        liveIds = set(liveModels)
        added = sorted(liveIds - currentIds)
        removed = sorted(currentIds - liveIds)
        updated = sorted(currentIds & liveIds)
        for mid in liveModels:
            if mid not in currentIds:
                # Prefer family heuristics / profiles over a hardcoded 128k —
                # that default made every refreshed model look identical in chat.
                currentModels.append(
                    {
                        'id': mid,
                        'name': mid,
                        'contextWindow': model_service._getContextWindow(mid, p),
                        'reasoning': False,
                        'free': ':free' in mid or '-free' in mid,
                        'source': 'fetched',
                    }
                )
        p['models'] = currentModels
        config_service.saveProvidersStore(store)
        model_service.invalidate_cache()
        return {'added': added, 'updated': updated, 'removed': removed}
    raise HTTPException(status_code=404, detail='Provider not found')


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
            entry: dict = {
                'id': body.id,
                'name': body.name or body.id,
                'contextWindow': body.context_window if body.context_window and body.context_window > 0 else 128000,
                'reasoning': body.reasoning or False,
                'free': body.free or False,
                'source': 'manual',
            }
            p_models.append(entry)
            config_service.saveProvidersStore(store)
            model_service.invalidate_cache()
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
                    dumped = body.model_dump(exclude_unset=True)
                    if 'context_window' in dumped:
                        cw = dumped['context_window']
                        if cw is None or (isinstance(cw, int) and cw <= 0):
                            m['contextWindow'] = 128000
                        else:
                            m['contextWindow'] = cw
                        # Mark user-edited so a 128k value is kept (not treated as
                        # the old fetched-default stamp).
                        m['source'] = 'manual'
                    if body.reasoning is not None:
                        m['reasoning'] = body.reasoning
                    if body.free is not None:
                        m['free'] = body.free
                    config_service.saveProvidersStore(store)
                    model_service.invalidate_cache()
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
            model_service.invalidate_cache()
            return {'deleted': True}
    raise HTTPException(status_code=404, detail='Provider not found')


@router.post('/{providerId}/models/{modelId}/test')
async def testModel(providerId: str, modelId: str):
    """Probe a model with a real chat request.

    Instructs the model to reply with exactly ``Connected!``.
    Returns ``success: true`` only when the trimmed reply matches that
    string. Any upstream/auth/billing failure is returned as
    ``success: false`` with the exact error message.
    """
    import time

    from app.services.workbench.providers import (
        call_anthropic_workbench,
        call_openai_workbench,
        is_anthropic_provider,
        is_openai_provider,
        resolve_chat_llm,
    )

    # Prefer explicit provider id/name, then model id ownership.
    provider, resolved_model = resolve_chat_llm(
        model=modelId,
        model_provider=providerId,
        session_provider=providerId,
        session_model=modelId,
    )
    if not provider:
        return {
            'success': False,
            'latencyMs': 0,
            'error': f'Provider "{providerId}" not found or has no API key configured.',
            'content': None,
        }

    # Ensure the resolved provider matches the one the user clicked when possible.
    pid = as_str(provider.get('id'))
    pname = as_str(provider.get('name'))
    if providerId and providerId not in (pid, pname) and providerId.lower() not in (
        pid.lower(),
        pname.lower(),
    ):
        # Still try the named provider first for a clearer error
        from app.providers import resolver as providerResolver

        explicit = providerResolver.resolve(providerId)
        if explicit:
            provider = explicit
            resolved_model = modelId

    t0 = time.perf_counter()
    messages: list[dict[str, object]] = [
        {
            'role': 'user',
            'content': 'Reply with exactly this text and nothing else: Connected!',
        }
    ]
    system = (
        'You are a connectivity probe. Reply with exactly the characters Connected! '
        'and nothing else — no greeting, no punctuation variants, no tools, no markdown.'
    )

    try:
        if is_anthropic_provider(provider):
            resp = await call_anthropic_workbench(
                messages,
                system,
                resolved_model or modelId,
                [],
                'low',
                provider=provider,
                emit=None,
            )
        elif is_openai_provider(provider):
            resp = await call_openai_workbench(
                messages,
                system,
                resolved_model or modelId,
                [],
                'low',
                provider=provider,
                emit=None,
            )
        else:
            return {
                'success': False,
                'latencyMs': 0,
                'error': f'Unsupported API format for provider "{pname or providerId}".',
                'content': None,
            }
    except Exception as exc:
        latency_ms = int((time.perf_counter() - t0) * 1000)
        return {
            'success': False,
            'latencyMs': latency_ms,
            'error': str(exc) or 'Model test failed',
            'content': None,
        }

    latency_ms = int((time.perf_counter() - t0) * 1000)
    err = as_str(resp.get('error')) if isinstance(resp, dict) else ''
    if err:
        return {
            'success': False,
            'latencyMs': latency_ms,
            'error': err,
            'content': None,
        }

    text = as_str(resp.get('text') if isinstance(resp, dict) else '').strip()
    if not text:
        # Anthropic path may put text only in content blocks
        if isinstance(resp, dict) and not text:
            blocks = as_list(resp.get('content'), [])
            parts: list[str] = []
            for b in blocks:
                bd = as_dict(b)
                if as_str(bd.get('type')) == 'text':
                    parts.append(as_str(bd.get('text')))
            text = ' '.join(parts).strip()

    if not text:
        return {
            'success': False,
            'latencyMs': latency_ms,
            'error': (
                f'Model "{modelId}" returned an empty response. '
                'Check the model id, API key, and provider billing/credits.'
            ),
            'content': None,
        }

    # Accept exact match, or a short reply that is only Connected! (trim quotes/spaces).
    normalized = text.strip().strip('"').strip("'")
    if normalized != 'Connected!':
        return {
            'success': False,
            'latencyMs': latency_ms,
            'error': (
                f'Model "{modelId}" responded with {text[:80]!r} instead of Connected!. '
                'The endpoint is reachable, but the reply was not the expected probe text.'
            ),
            'content': text[:200],
        }

    return {
        'success': True,
        'latencyMs': latency_ms,
        'content': 'Connected!',
        'error': None,
    }
