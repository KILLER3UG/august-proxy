"""
Model aggregation service — collects models from all providers with live
fetching, caching, fallback to static lists, and display alias generation.

Port of backend/providers/model-list.js (277 lines).

Key functions:
- ``aggregate()`` — full model list with caching
- ``get_model_display_alias()`` — human-readable model name
- ``resolve_model_alias_details()`` — find provider for an alias
- ``invalidate_cache()`` — clear the cache
"""

from __future__ import annotations
import asyncio
import re
import time
import httpx
from app.config import settings
from app.json_narrowing import as_str, as_list, as_dict, as_int
from app.providers.clients import getClient
from app.services.workbench.providers import supports_thinking

_modelCache: list[dict[str, object]] | None = None
_modelCacheAt: float = 0
_MODELCacheTtl: float = 300
_aliasCache: dict[str, object] | None = None
_aliasCacheAt: float = 0
_ALIASCacheTtl: float = 60
_refreshInFlight: asyncio.Task | None = None


def invalidate_cache() -> None:
    global _modelCache, _modelCacheAt, _aliasCache, _aliasCacheAt
    _modelCache = None
    _modelCacheAt = 0
    _aliasCache = None
    _aliasCacheAt = 0


_STATICModelLists: dict[str, list[dict[str, object]]] = {
    'Anthropic': [
        {'id': 'claude-sonnet-4-7', 'contextWindow': 200000},
        {'id': 'claude-sonnet-4-6', 'contextWindow': 200000},
        {'id': 'claude-opus-4-7', 'contextWindow': 200000},
        {'id': 'claude-opus-4-6', 'contextWindow': 200000},
        {'id': 'claude-haiku-4-5', 'contextWindow': 200000},
    ],
    'OpenAI API': [
        {'id': 'gpt-4o', 'contextWindow': 128000},
        {'id': 'gpt-4o-mini', 'contextWindow': 128000},
        {'id': 'o1', 'contextWindow': 200000},
        {'id': 'o3', 'contextWindow': 200000},
    ],
    'Google AI Studio': [
        {'id': 'gemini-2.0-flash', 'contextWindow': 1048576},
        {'id': 'gemini-2.0-pro', 'contextWindow': 1048576},
        {'id': 'gemini-1.5-pro', 'contextWindow': 1048576},
    ],
    'DeepSeek': [
        {'id': 'deepseek-v4', 'contextWindow': 131072},
        {'id': 'deepseek-v4-flash', 'contextWindow': 131072},
        {'id': 'deepseek-reasoner', 'contextWindow': 131072},
    ],
}


def _deriveModelsUrl(baseUrl: str) -> str | None:
    """Derive the /models endpoint URL from a provider's base URL."""
    base = baseUrl.rstrip('/')
    for suffix in ['/chat/completions', '/messages', '/responses', '/v1']:
        if base.endswith(suffix):
            base = base[: -len(suffix)]
    return f'{base}/models' if base else None


def _getContextWindow(modelId: str, provider: dict[str, object] | None = None, fallback: int | None = None) -> int:
    """Resolve context window from provider profile or inference."""
    if provider:
        profiles = as_dict(provider.get('modelProfiles'), {})
        for key in [modelId] + [k for k in profiles if modelId.startswith(k)]:
            profile = as_dict(profiles.get(key))
            if isinstance(profile, dict) and profile.get('contextWindow'):
                return as_int(profile['contextWindow'])
        wildcard = as_dict(profiles.get('*'), {})
        if isinstance(wildcard, dict) and wildcard.get('contextWindow'):
            return as_int(wildcard['contextWindow'])
    return fallback or 128000


def _isFreeModelId(modelId: str) -> bool:
    """Check if a model ID indicates a free tier (:free / -free)."""
    if not isinstance(modelId, str):
        return False
    lower = modelId.lower()
    return ':free' in lower or '-free' in lower or lower.endswith('free')


def _prettifyModelBase(base: str) -> str:
    """Generate a human-readable model name."""
    if re.match('^claude-', base, re.IGNORECASE):
        name = re.sub('^claude-', '', base, flags=re.IGNORECASE).replace('-', ' ')
        return name.title()
    if re.match('^gpt-', base, re.IGNORECASE):
        return base.replace('gpt-', 'GPT-', 1)
    if re.match('^gemini-', base, re.IGNORECASE):
        return 'Gemini ' + re.sub('^gemini-', '', base, flags=re.IGNORECASE).replace('-', ' ').title()
    if re.match('^deepseek-', base, re.IGNORECASE):
        return 'DeepSeek ' + re.sub('^deepseek-', '', base, flags=re.IGNORECASE).replace('-', ' ').title()
    return base.replace('-', ' ').title()


def _getModelDisplayAlias(model: dict[str, object]) -> str:
    """Generate a display alias for a model."""
    modelId = as_str(model.get('id'), '')
    base = modelId.split('/')[-1].split(':')[-1] if '/' in modelId or ':' in modelId else modelId
    tag = ''
    for pattern, label in [
        ('-fast$', 'Fast'),
        ('-thinking$', 'Thinking'),
        ('-preview$', 'Preview'),
        ('-latest$', 'Latest'),
        (':free$', 'Free'),
        ('-free$', 'Free'),
    ]:
        if re.search(pattern, base, re.IGNORECASE):
            base = re.sub(pattern, '', base, flags=re.IGNORECASE)
            tag = label
            break
    display = _prettifyModelBase(base)
    return f'{display}{(f" ({tag})" if tag else "")}'


async def _fetchProviderModels(provider: dict[str, object], timeoutS: float = 5.0) -> list[dict[str, object]]:
    """Fetch models from a provider's /models endpoint.

    Falls back to static list if the endpoint is unavailable.
    """
    client = getClient(provider)
    if not client:
        return []
    apiKey = client.resolveApiKey()
    baseUrl = client.resolveBaseUrl()
    providerName = as_str(provider.get('name'), '')
    modelsUrl = _deriveModelsUrl(baseUrl)
    if modelsUrl and apiKey:
        try:
            headers = client.buildAuthHeaders(apiKey)
            async with httpx.AsyncClient(timeout=timeoutS) as http:
                resp = await http.get(modelsUrl, headers=headers)
                if resp.status_code == 200:
                    data = resp.json()
                    modelList = data.get('data', data.get('models', data if isinstance(data, list) else []))
                    return [
                        {
                            'id': m['id'],
                            'name': m['id'],
                            'provider': providerName,
                            'contextWindow': _getContextWindow(m['id'], provider, m.get('context_length')),
                        }
                        for m in (modelList if isinstance(modelList, list) else [])
                    ]
        except Exception:
            pass
    static = _STATICModelLists.get(providerName, [])
    if not static:
        defaultModel = as_str(provider.get('defaultModel'))
        if defaultModel:
            static = [{'id': defaultModel, 'contextWindow': _getContextWindow(defaultModel, provider)}]
        fallbackModels = as_list(provider.get('fallbackModels'), [])
        for fmEntry in fallbackModels:
            fm = as_str(fmEntry)
            if not any((s['id'] == fm for s in static)):
                static.append({'id': fm, 'contextWindow': _getContextWindow(fm, provider)})
    return [
        {
            'id': m['id'],
            'name': m['id'],
            'provider': providerName,
            'contextWindow': as_int(m.get('contextWindow'), 128000),
        }
        for m in static
    ]


async def _aggregateModels() -> list[dict[str, object]]:
    """Aggregate models from providers + alias models for /v1/models.

    This returns ALL models the proxy can route to:
    1. User-configured provider models (from ``providers.json``)
    2. Alias models (from ``config.json modelAliases``) — each alias is
       exposed as a model entry so clients see alias names in the list.

    Alias models get ``isAlias: True`` so callers can distinguish them
    from real provider models.
    """
    allModels: list[dict[str, object]] = []
    try:
        store = settings.providers
        for entry_raw in as_list(store.get('providers'), []):
            entry = as_dict(entry_raw)
            if not entry.get('enabled') or not entry.get('apiKey'):
                continue
            for m_raw in as_list(entry.get('models'), []):
                m = as_dict(m_raw)
                mid = as_str(m['id'])
                # `supports_thinking` is the same capability check the request
                # path uses to decide whether to attach Anthropic-style
                # extended-thinking params — it reads the provider's
                # `modelProfiles` (exact id, longest-prefix, or wildcard `*`
                # claims). Falling back to a bare id-keyword regex (below)
                # left every reasoning-capable model whose id doesn't literally
                # contain "o1"/"o3"/"reasoner"/"thinking"/"reasoning" (e.g.
                # `claude-sonnet-4-7`, most Anthropic/OpenAI models configured
                # via `modelProfiles`) reported as non-reasoning, which
                # permanently disabled the Thinking toggle in the UI for them.
                reasoning = (
                    bool(m.get('reasoning', False))
                    or supports_thinking(entry, mid)
                    or bool(re.search('\\b(o1|o3|reasoner|thinking|reasoning)\\b', mid, re.IGNORECASE))
                )
                allModels.append(
                    {
                        'id': mid,
                        'name': as_str(m.get('name'), mid),
                        'provider': entry['name'],
                        'contextWindow': as_int(m.get('contextWindow'), 128000),
                        'supportsReasoning': reasoning,
                        'supportsThinking': reasoning,
                        'isFree': m.get('free', False) or _isFreeModelId(mid),
                    }
                )
    except Exception:
        pass
    # Inject alias models so /v1/models exposes them alongside provider models.
    try:
        from app.services.alias_mapping_service import get_alias_models_for_v1_models

        aliasModels = get_alias_models_for_v1_models()
        allModels.extend(aliasModels)
    except Exception:
        pass
    seen: dict[str, dict[str, object]] = {}
    for m in allModels:
        mid = as_str(m['id'])
        if mid not in seen or (m.get('isFree') and (not seen[mid].get('isFree'))):
            seen[mid] = m
    result = list(seen.values())
    result.sort(key=lambda m: (0 if m.get('isFree') else 1, as_str(m.get('id'), '')))
    return result


async def aggregate(refresh: bool = False) -> list[dict[str, object]]:
    """Get the aggregated model list with caching."""
    global _modelCache, _modelCacheAt, _refreshInFlight
    now = time.time()
    if refresh:
        _modelCache = None
        _modelCacheAt = 0
    if _modelCache is not None and now - _modelCacheAt < _MODELCacheTtl:
        return _modelCache
    if _modelCache is not None:
        if _refreshInFlight is None or _refreshInFlight.done():
            _refreshInFlight = asyncio.create_task(_refreshBackground())
        return _modelCache
    models = await _aggregateModels()
    _modelCache = models
    _modelCacheAt = now
    return models


async def _refreshBackground() -> None:
    """Background cache refresh."""
    global _modelCache, _modelCacheAt
    try:
        fresh = await _aggregateModels()
        _modelCache = fresh
        _modelCacheAt = time.time()
    except Exception:
        pass


async def prewarm() -> None:
    """Pre-warm the model cache on startup."""
    try:
        models = await _aggregateModels()
        global _modelCache, _modelCacheAt
        _modelCache = models
        _modelCacheAt = time.time()
    except Exception:
        pass


def getModelDisplayAlias(model: dict[str, object]) -> str:
    return _getModelDisplayAlias(model)


def isFreeModelId(modelId: str) -> bool:
    return _isFreeModelId(modelId)
