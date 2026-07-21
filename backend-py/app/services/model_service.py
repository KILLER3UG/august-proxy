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
    # Provider model edits write providers.json then call invalidate_cache.
    # Without a settings reload, aggregate() keeps serving the pre-edit snapshot
    # (so every model looks stuck at the default 128k context window).
    try:
        from app.config import settings

        settings.reload()
    except Exception:
        pass


def _extract_context_window_value(raw: object) -> int:
    """Positive int from int/float/numeric-string; else 0."""
    if isinstance(raw, bool):
        return 0
    if isinstance(raw, (int, float)):
        n = int(raw)
        return n if n > 0 else 0
    if isinstance(raw, str):
        s = raw.strip().replace(',', '')
        if s.isdigit():
            n = int(s)
            return n if n > 0 else 0
    return 0


def _context_from_model_entry(entry: dict[str, object]) -> int:
    for key in ('contextWindow', 'context_window', 'context_length', 'max_model_len'):
        n = _extract_context_window_value(entry.get(key))
        if n > 0:
            return n
    return 0


def _getContextWindow(
    modelId: str, provider: dict[str, object] | None = None, fallback: object = None
) -> int:
    """Resolve context window.

    Priority (user intent first — applies to every model, not one family):
      1. Per-model entry from Model Providers UI (``providers.json``)
      2. modelProfiles exact → longest prefix (not ``*``)
      3. Explicit fallback (live ``/models`` metadata from the host)
      4. Family heuristic
      5. Wildcard ``*`` profile (weak — often a stale 128k boilerplate)
      6. 128000
    """
    profiles: dict[str, object] = {}
    if provider:
        for m_raw in as_list(provider.get('models'), []):
            m = as_dict(m_raw)
            if as_str(m.get('id')) == modelId:
                n = _context_from_model_entry(m)
                if n > 0:
                    # Historical refresh stamped every fetched model with 128k.
                    # Treat that boilerplate as unset so heuristics/profiles apply
                    # until the user explicitly edits the model (source → manual).
                    if n == 128000 and as_str(m.get('source')) == 'fetched':
                        break
                    return n
                break

        profiles = as_dict(
            provider.get('modelProfiles') or provider.get('model_profiles'),
            {},
        )
        exact = as_dict(profiles.get(modelId))
        n = _context_from_model_entry(exact) if exact else 0
        if n > 0:
            return n
        # Longest prefix match (stable for model family profiles).
        prefix_hits = sorted(
            (
                (k, as_dict(profiles.get(k)))
                for k in profiles
                if k != '*' and isinstance(k, str) and modelId.startswith(k)
            ),
            key=lambda kv: len(kv[0]),
            reverse=True,
        )
        for _, profile in prefix_hits:
            n = _context_from_model_entry(profile)
            if n > 0:
                return n

    explicit = _extract_context_window_value(fallback)
    if explicit > 0:
        return explicit

    # Family heuristics when nothing was configured.
    mid = (modelId or '').lower()
    if 'claude' in mid:
        return 200000
    if 'gemini' in mid and any(x in mid for x in ('1.5', '2.0', '2.5', 'pro', 'flash', 'ultra')):
        return 1_000_000
    if 'deepseek-v4' in mid or re.search(r'deepseek[-_]?v4', mid):
        return 1_000_000
    if any(x in mid for x in ('gpt-4.1',)):
        return 1_047_576
    if any(x in mid for x in ('gpt-4o', 'chatgpt-4o')):
        return 128000
    if re.search(r'\b(o1|o3|o4)\b', mid):
        return 200000
    if 'deepseek' in mid:
        return 128000
    if 'kimi' in mid or 'moonshot' in mid:
        return 128000
    if 'grok' in mid:
        return 131072

    if profiles:
        wildcard = as_dict(profiles.get('*'), {})
        n = _context_from_model_entry(wildcard) if wildcard else 0
        if n > 0:
            return n
    return 128000


def _resolve_context_window(raw: object) -> int:
    """Stored contextWindow, or 128k when unset."""
    n = _extract_context_window_value(raw)
    return n if n > 0 else 128000


_STATICModelLists: dict[str, list[dict[str, object]]] = {
    'Anthropic': [
        {'id': 'claude-sonnet-4-7'},
        {'id': 'claude-sonnet-4-6'},
        {'id': 'claude-opus-4-7'},
        {'id': 'claude-opus-4-6'},
        {'id': 'claude-haiku-4-5'},
    ],
    'OpenAI API': [
        {'id': 'gpt-4o'},
        {'id': 'gpt-4o-mini'},
        {'id': 'o1'},
        {'id': 'o3'},
    ],
    'Google AI Studio': [
        {'id': 'gemini-2.0-flash'},
        {'id': 'gemini-2.0-pro'},
        {'id': 'gemini-1.5-pro'},
    ],
    'DeepSeek': [
        {'id': 'deepseek-v4'},
        {'id': 'deepseek-v4-flash'},
        {'id': 'deepseek-reasoner'},
    ],
}


def _deriveModelsUrl(baseUrl: str) -> str | None:
    """Derive the /models endpoint URL from a provider's base URL."""
    from app.providers.api_format import join_provider_url, normalize_provider_base_url

    base = normalize_provider_base_url(baseUrl)
    return join_provider_url(base, 'models') if base else None


def _lookup_model_profile(
    model_id: str, provider: dict[str, object] | None
) -> dict[str, object]:
    if not provider:
        return {}
    profiles = as_dict(provider.get('modelProfiles') or provider.get('model_profiles'), {})
    if not profiles:
        return {}
    if model_id in profiles:
        return as_dict(profiles.get(model_id))
    model_l = (model_id or '').lower()
    best_key = ''
    best: dict[str, object] = {}
    for key, val in profiles.items():
        if key == '*' or not isinstance(key, str):
            continue
        if model_l.startswith(str(key).lower()) and len(str(key)) > len(best_key):
            best_key = str(key)
            best = as_dict(val)
    if best_key:
        return best
    return as_dict(profiles.get('*'))


def get_max_output_tokens(
    model_id: str,
    provider: dict[str, object] | None = None,
    fallback: object = None,
) -> int:
    """Resolve max completion tokens from the **model** (not workbench policy).

    Order:
      1. Explicit profile ``maxOutputTokens`` / aliases
      2. Caller ``fallback`` when positive
      3. Derived from the model's ``contextWindow`` (~1/8, clamped)
      4. Known model-family defaults (Claude / o-series / generic)
    """
    profile = _lookup_model_profile(model_id, provider)
    for key in ('maxOutputTokens', 'max_output_tokens', 'maxTokens', 'max_tokens'):
        n = as_int(profile.get(key), 0)
        if n > 0:
            return n
    if isinstance(fallback, (int, float)) and not isinstance(fallback, bool):
        n = int(fallback)
        if n > 0:
            return n
    # Prefer an explicit contextWindow on the model profile. Avoid the bare
    # 128k _getContextWindow default when no provider/profile is present —
    # that would invent a workbench-like ceiling instead of a model one.
    ctx = as_int(profile.get('contextWindow') or profile.get('context_window'), 0)
    if ctx <= 0 and provider is not None and (
        as_dict(provider.get('modelProfiles') or provider.get('model_profiles'))
    ):
        ctx = _getContextWindow(model_id, provider)
    if ctx > 0:
        return max(4096, min(65536, ctx // 8))
    mid = (model_id or '').lower()
    if 'claude' in mid:
        return 64000
    if any(tok in mid for tok in ('o1', 'o3', 'o4', 'gpt-5', 'reasoner')):
        return 32768
    return 16384


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
                            'contextWindow': _getContextWindow(
                                m['id'],
                                provider,
                                _context_from_model_entry(as_dict(m)) or None,
                            ),
                        }
                        for m in (modelList if isinstance(modelList, list) else [])
                        if isinstance(m, dict) and as_str(m.get('id'))
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
            'contextWindow': _resolve_context_window(m.get('contextWindow')),
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
        # Always read providers.json fresh — settings.providers can lag behind
        # Model Providers UI edits until the next process restart.
        from app.services import config_service

        store = config_service.getProvidersStore()
        for entry_raw in as_list(store.get('providers'), []):
            entry = as_dict(entry_raw)
            if not entry.get('enabled') or not entry.get('apiKey'):
                continue
            for m_raw in as_list(entry.get('models'), []):
                m = as_dict(m_raw)
                mid = as_str(m['id'])
                mid_l = mid.lower()
                likely_reasoning = bool(
                    re.search(
                        r'(?:\b(?:o1|o3|o4|reasoner|thinking|reasoning)\b|'
                        r'claude|gpt-5|deepseek|qwen3|qwq|minimax-m2|minimax-m3|'
                        r'glm-4|glm-5|kimi-k2|grok-[34]|gemini-3)',
                        mid_l,
                        re.IGNORECASE,
                    )
                )
                reasoning = (
                    bool(m.get('reasoning', False))
                    or supports_thinking(entry, mid)
                    or likely_reasoning
                )
                allModels.append(
                    {
                        'id': mid,
                        'name': as_str(m.get('name'), mid),
                        'provider': entry['name'],
                        'contextWindow': _getContextWindow(
                            mid,
                            entry,
                            _context_from_model_entry(m) or None,
                        ),
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
