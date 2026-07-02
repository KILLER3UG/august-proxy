"""Provider credentials — single source of truth.

Consults ``providers.json`` (custom store) first, then the built-in registry
+ env vars. Used by the workbench credential check and provider_resolver so
the chat thread sees the same availability the UI shows.

Cache lifecycle:
- The store is loaded once on first use and cached in ``_store_cache``.
- Call :func:`invalidate` to clear the cache (e.g. after writing to
  ``providers.json``). ``config_service.saveProvidersStore`` will
  automatically call :func:`invalidate` via the invalidation registry, so
  direct callers normally don't need to.

Custom-store entry filtering:
- Custom-store entries with ``enabled`` set to False OR ``apiKey`` empty
  are **skipped** — they fall through to the built-in registry path. This
  mirrors ``model_service._aggregate_models`` behavior so disabled/
  unconfigured custom providers don't masquerade as available.
- Lookup is **case-insensitive** and prefers ``id`` over ``name`` for
  stability, matching ``provider_resolver.resolve``.
"""
from __future__ import annotations
from typing import Callable, Optional
from app.services import configService
_storeCache: Optional[dict[str, object]] = None
_invalidationCallbacks: list[Callable[[], None]] = []

def registerInvalidationCallback(callback: Callable[[], None]) -> Callable[[], None]:
    """Register a callback invoked whenever the providers.json store changes.

    Returns the callback to ease registration as a side-effect of import.
    """
    _invalidationCallbacks.append(callback)
    return callback

def _fireInvalidation() -> None:
    for cb in _invalidationCallbacks:
        try:
            cb()
        except Exception:
            pass

def invalidate() -> None:
    """Clear the in-memory providers.json cache.

    Call this after writing to ``providers.json`` so subsequent
    :func:`resolve` calls reload from disk. ``config_service.saveProvidersStore``
    does this automatically via the invalidation registry.
    """
    global _store_cache
    _storeCache = None

def _loadStore() -> dict[str, object]:
    """Reload the providers.json cache from disk."""
    global _store_cache
    _storeCache = configService.getProvidersStore()
    return _storeCache

def _customEntry(nameOrId: str) -> Optional[dict[str, object]]:
    """Find a custom-store provider entry by id (preferred) or name.

    Lookup is case-insensitive. ``id`` matches are preferred over ``name``
    matches for stability (mirrors ``provider_resolver.resolve``).
    """
    if _storeCache is None:
        _loadStore()
    store = _storeCache or {}
    target = nameOrId.lower()
    idMatch: Optional[dict[str, object]] = None
    nameMatch: Optional[dict[str, object]] = None
    for entry in store.get('providers', []):
        if entry.get('id', '').lower() == target and idMatch is None:
            idMatch = entry
        if entry.get('name', '').lower() == target and nameMatch is None:
            nameMatch = entry
    return idMatch or nameMatch

def _customProviderDict(entry: dict[str, object]) -> dict[str, object]:
    """Build a provider-dict shaped like the registry returns, from a custom store entry.

    Merges template metadata (``model_profiles``, ``default_headers``, ``env_vars``)
    from the matching template when the user entry does not provide its own value.

    All optional fields use safe defaults via ``entry.get(...)`` so downstream
    consumers can read display_name, description, default_model, etc. without
    KeyError on minimal custom entries.
    """
    # Try to find a matching template for merging metadata
    from app.providers.template_loader import get_template
    tmpl = get_template(str(entry.get('id') or '') or str(entry.get('name') or ''))
    tmpl_profiles = {}
    tmpl_headers = {}
    tmpl_env = []
    if tmpl:
        tmpl_profiles = tmpl.get('modelProfiles', {}) or {}
        tmpl_headers = tmpl.get('defaultHeaders', {}) or {}
        tmpl_env = tmpl.get('envVars', []) or []

    return {
        'name': entry.get('name', ''),
        'id': entry.get('id', ''),
        'display_name': entry.get('display_name', entry.get('name', '')),
        'description': entry.get('description', tmpl.get('description', '') if tmpl else ''),
        'aliases': tmpl.get('aliases', []) if tmpl else [],
        'base_url': entry.get('baseUrl', ''),
        'api_mode': entry.get('apiFormat', 'openai-chat'),
        'api_key': entry.get('apiKey', ''),
        'is_custom': True,
        'env_vars': entry.get('env_vars', tmpl_env),
        'auth_type': entry.get('auth_type', tmpl.get('authType', 'api_key') if tmpl else 'api_key'),
        'model_profiles': entry.get('model_profiles', tmpl_profiles),
        'default_model': entry.get('default_model', tmpl.get('defaultModel', '') if tmpl else ''),
        'fallback_models': entry.get('fallback_models', tmpl.get('fallbackModels', []) if tmpl else []),
        'signup_url': entry.get('signup_url', tmpl.get('signupUrl', '') if tmpl else ''),
        'supports_health_check': entry.get('supports_health_check', tmpl.get('supportsHealthCheck', False) if tmpl else False),
        'default_max_tokens': entry.get('default_max_tokens', tmpl.get('defaultMaxTokens', 4096) if tmpl else 4096),
        'default_headers': entry.get('default_headers', tmpl_headers),
    }

def resolve(nameOrId: str) -> Optional[dict[str, object]]:
    """Return ``{"provider": ..., "api_key": ..., "base_url": ..., "api_mode": ...}`` or ``None``.

    Resolution order:
    1. Custom ``providers.json`` entry by id or name (authoritative for the key),
       but only if the entry is enabled AND has a non-empty ``apiKey``. Disabled
       or unkeyed custom entries fall through to template resolution.
    2. Template via ``provider_resolver.resolve`` (uses provider_templates.json).
    """
    if not nameOrId:
        return None
    custom = _customEntry(nameOrId)
    if custom and custom.get('enabled') and custom.get('apiKey'):
        apiKey = custom.get('apiKey', '') or ''
        return {'provider': _customProviderDict(custom), 'api_key': apiKey, 'base_url': custom.get('baseUrl', ''), 'api_mode': custom.get('apiFormat', 'openai-chat'), 'source': 'custom_store'}
    from app.providers import resolver as providerResolver
    from app.providers.clients import getClient
    provider = providerResolver.resolve(nameOrId)
    if not provider:
        return None
    client = getClient(provider) if provider else None
    apiKey = client.resolveApiKey() if client else None
    return {'provider': provider, 'api_key': apiKey or '', 'base_url': provider.get('base_url', ''), 'api_mode': provider.get('api_mode', ''), 'source': 'registry'}
registerInvalidationCallback(invalidate)