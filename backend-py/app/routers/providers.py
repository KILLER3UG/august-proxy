"""
Provider configuration management API routes.
Uses camelCase throughout matching the frontend convention.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.json_narrowing import as_bool, as_dict, as_list, as_str
from app.models.config import ModelCreate, ModelUpdate, ProviderConfig, ProviderCreate, ProviderUpdate
from app.services import config_service, model_service

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
                    'pinned': m.pinned,
                    'source': m.source,
                    'apiFormat': m.api_format,
                    'supportsReasoningEffort': m.supports_reasoning_effort,
                    'maxReasoningEffort': m.max_reasoning_effort,
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


@router.post('/refresh-all')
async def refreshAllModels():
    """Refresh stored model lists from every enabled provider's /models endpoint.

    Best-effort per provider: one unreachable provider never aborts the rest.
    The desktop app calls this once at startup so the model selection dropdown
    reflects models added or removed upstream since the last run.
    """
    store = config_service.getProvidersStore()
    providers_list = as_list(store.get('providers', []))
    refreshed = 0
    failed = 0
    addedTotal = 0
    removedTotal = 0
    for raw in providers_list:
        entry = as_dict(raw)
        if not as_bool(entry.get('enabled', False)):
            continue
        providerId = as_str(entry.get('id', ''))
        if not providerId or not as_str(entry.get('baseUrl', '')) or not as_str(entry.get('apiKey', '')):
            continue
        try:
            added, _updated, removed, live = await _discoverProviderModels(providerId, persist=True)
        except Exception:
            failed += 1
            continue
        if not live:
            # Upstream unreachable or empty — nothing was synced (and the prune
            # guard kept the stored list intact). Report it as failed.
            failed += 1
            continue
        refreshed += 1
        addedTotal += len(added)
        removedTotal += len(removed)
    try:
        from app.services.realtime_bus import emit_invalidate

        emit_invalidate('models', 'providers', 'provider-health')
    except Exception:
        pass
    return {'refreshed': refreshed, 'failed': failed, 'added': addedTotal, 'removed': removedTotal}


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
    added, updated, removed, _live = await _discoverProviderModels(providerId, persist=True)
    return {'added': added, 'updated': updated, 'removed': removed}


async def _discoverProviderModels(
    providerId: str, *, persist: bool = False
) -> tuple[list[str], list[str], list[str], list[str]]:
    """Fetch a provider's live model list from its /models endpoint.

    Returns ``(added, updated, removed, liveModels)`` relative to the
    currently-stored models. When ``persist`` is True, newly seen models are
    appended to the store (the refresh behavior); when False (discover), the
    store is left untouched and the caller gets the diff prospectively.
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
        if persist:
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
            # Drop auto-discovered models that vanished upstream so deleted
            # models leave the selection dropdown. Manually added models are
            # never pruned, and an empty live list (failed/unreachable fetch)
            # prunes nothing so a flaky upstream can't wipe a provider's list.
            if liveIds:
                currentModels = [
                    m
                    for m in currentModels
                    if not (
                        isinstance(m, dict)
                        and as_str(m.get('source', '')) == 'fetched'
                        and as_str(m.get('id', '')) not in liveIds
                    )
                ]
            p['models'] = currentModels
            config_service.saveProvidersStore(store)
            model_service.invalidate_cache()
        return (added, updated, removed, liveModels)
    raise HTTPException(status_code=404, detail='Provider not found')


@router.get('/{providerId}/models')
async def listProviderModels(providerId: str):
    """List the models currently stored for a provider.

    Returns the provider's stored ``models`` array (the configured set, not a
    live fetch). For a live refresh use ``POST /{providerId}/models/refresh``;
    for a read-only live preview use ``POST /{providerId}/discover``.
    """
    store = config_service.getProvidersStore()
    providers_list = as_list(store.get('providers', []))
    if not isinstance(providers_list, list):
        providers_list = []
    for p in providers_list:
        if not isinstance(p, dict):
            continue
        if as_str(p.get('id', '')) == providerId:
            models = as_list(p.get('models', []))
            return {'models': models, 'count': len(models)}
    raise HTTPException(status_code=404, detail='Provider not found')


@router.post('/{providerId}/discover')
async def discoverProviderModels(providerId: str):
    """Probe a provider's live /models endpoint without persisting changes.

    Returns the prospective added/updated/removed diff plus the live model IDs,
    so the UI can preview what ``models/refresh`` would apply. The store is
    left untouched.
    """
    added, updated, removed, liveModels = await _discoverProviderModels(providerId, persist=False)
    return {'added': added, 'updated': updated, 'removed': removed, 'live': liveModels}


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
                'pinned': body.pinned or False,
                'source': 'manual',
            }
            if body.api_format:
                entry['apiFormat'] = body.api_format
            if body.supports_reasoning_effort is not None:
                entry['supportsReasoningEffort'] = body.supports_reasoning_effort
            if body.max_reasoning_effort:
                entry['maxReasoningEffort'] = body.max_reasoning_effort
            p_models.append(entry)
            config_service.saveProvidersStore(store)
            model_service.invalidate_cache()
            return {**p, 'apiKeySet': bool(p.get('apiKey'))}
    raise HTTPException(status_code=404, detail='Provider not found')


@router.patch('/{providerId}/models/{modelId:path}')
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
                    # Any per-model patch marks the entry manual so refresh /
                    # discovery pruning never drops it (and its overrides).
                    if dumped:
                        m['source'] = 'manual'
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
                    if body.pinned is not None:
                        m['pinned'] = body.pinned
                    # Per-model wire-format override; explicit null clears it.
                    if 'api_format' in dumped:
                        if dumped['api_format'] is None:
                            m.pop('apiFormat', None)
                        else:
                            m['apiFormat'] = dumped['api_format']
                    # Per-model reasoning_effort overrides.
                    if 'supports_reasoning_effort' in dumped:
                        val = dumped['supports_reasoning_effort']
                        if val is None:
                            m.pop('supportsReasoningEffort', None)
                        else:
                            m['supportsReasoningEffort'] = val
                    if 'max_reasoning_effort' in dumped:
                        val = dumped['max_reasoning_effort']
                        if val is None:
                            m.pop('maxReasoningEffort', None)
                        else:
                            m['maxReasoningEffort'] = val
                    config_service.saveProvidersStore(store)
                    model_service.invalidate_cache()
                    return {'updated': True}
            raise HTTPException(status_code=404, detail='Model not found')
    raise HTTPException(status_code=404, detail='Provider not found')


@router.delete('/{providerId}/models/{modelId:path}')
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


@router.post('/{providerId}/models/{modelId:path}/test')
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
                # Connectivity probe — disable thinking/reasoning extras so the
                # body mirrors a minimal chat request. Some gateways reject
                # `thinking.budget_tokens` / `reasoning_effort` even when they
                # accept the chat path's richer body.
                thinking_enabled=False,
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
                # Connectivity probe — disable thinking/reasoning extras (see above).
                thinking_enabled=False,
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

    # Connectivity is proven by a non-empty reply. The probe asks for exactly
    # "Connected!", but many models prefix/punctuate, and reasoning models may
    # emit thinking-only or a short `content`. A reachable model that answers
    # is connected — accept any non-empty reply as success and surface the text
    # for transparency. The distinct empty-reply and upstream-error branches
    # above keep real failures clearly labeled.
    return {
        'success': True,
        'latencyMs': latency_ms,
        'content': text[:200],
        'error': None,
    }
