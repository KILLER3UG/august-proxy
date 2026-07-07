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
    global _storeCache
    _storeCache = None

def _loadStore() -> dict[str, object]:
    """Reload the providers.json cache from disk."""
    global _storeCache
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
    from app.providers.template_loader import getTemplate
    tmpl = getTemplate(str(entry.get('id') or '') or str(entry.get('name') or ''))
    tmplProfiles = {}
    tmplHeaders = {}
    tmplEnv = []
    if tmpl:
        tmplProfiles = tmpl.get('modelProfiles', {}) or {}
        tmplHeaders = tmpl.get('defaultHeaders', {}) or {}
        tmplEnv = tmpl.get('envVars', []) or []
    return {'name': entry.get('name', ''), 'id': entry.get('id', ''), 'displayName': entry.get('displayName', entry.get('name', '')), 'description': entry.get('description', tmpl.get('description', '') if tmpl else ''), 'aliases': tmpl.get('aliases', []) if tmpl else [], 'baseUrl': entry.get('baseUrl', ''), 'apiMode': entry.get('apiFormat', 'openaiChat'), 'api_key': entry.get('apiKey', ''), 'is_custom': True, 'envVars': entry.get('envVars', tmplEnv), 'authType': entry.get('authType', tmpl.get('authType', 'api_key') if tmpl else 'api_key'), 'modelProfiles': entry.get('modelProfiles', tmplProfiles), 'defaultModel': entry.get('defaultModel', tmpl.get('defaultModel', '') if tmpl else ''), 'fallbackModels': entry.get('fallbackModels', tmpl.get('fallbackModels', []) if tmpl else []), 'signupUrl': entry.get('signupUrl', tmpl.get('signupUrl', '') if tmpl else ''), 'supportsHealthCheck': entry.get('supportsHealthCheck', tmpl.get('supportsHealthCheck', False) if tmpl else False), 'defaultMaxTokens': entry.get('defaultMaxTokens', tmpl.get('defaultMaxTokens', 4096) if tmpl else 4096), 'defaultHeaders': entry.get('defaultHeaders', tmplHeaders)}

def resolve(nameOrId: str) -> Optional[dict[str, object]]:
    """Return ``{"provider": ..., "api_key": ..., "baseUrl": ..., "apiMode": ...}`` or ``None``.

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
        return {'provider': _customProviderDict(custom), 'api_key': apiKey, 'baseUrl': custom.get('baseUrl', ''), 'apiMode': custom.get('apiFormat', 'openaiChat'), 'source': 'custom_store'}
    from app.providers import resolver as providerResolver
    from app.providers.clients import getClient
    provider = providerResolver.resolve(nameOrId)
    if not provider:
        return None
    client = getClient(provider) if provider else None
    apiKey = client.resolveApiKey() if client else None
    return {'provider': provider, 'api_key': apiKey or '', 'baseUrl': provider.get('baseUrl', ''), 'apiMode': provider.get('apiMode', ''), 'source': 'registry'}
registerInvalidationCallback(invalidate)