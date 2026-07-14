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
from app.json_narrowing import as_str, as_dict, as_list, as_int
from app.services import config_service

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
    _storeCache = config_service.getProvidersStore()
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
    for entry in as_list(store.get('providers'), []):
        if isinstance(entry, dict):
            if as_str(entry.get('id'), '').lower() == target and idMatch is None:
                idMatch = entry
            if as_str(entry.get('name'), '').lower() == target and nameMatch is None:
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
    from app.providers.template_loader import get_template

    tmpl = get_template(str(entry.get('id') or '') or str(entry.get('name') or ''))
    tmplProfiles: dict[str, object] = {}
    tmplHeaders: dict[str, object] = {}
    tmplEnv: list[object] = []
    if tmpl:
        tmplProfiles = as_dict(tmpl.get('modelProfiles'))
        tmplHeaders = as_dict(tmpl.get('defaultHeaders'))
        tmplEnv = as_list(tmpl.get('envVars'))
    return {
        'name': as_str(entry.get('name'), ''),
        'id': as_str(entry.get('id'), ''),
        'displayName': as_str(entry.get('displayName'), as_str(entry.get('name'), '')),
        'description': as_str(entry.get('description'), as_str(tmpl.get('description'), '') if tmpl else ''),
        'aliases': as_list(tmpl.get('aliases'), []) if tmpl else [],
        'baseUrl': as_str(entry.get('baseUrl'), ''),
        'apiMode': as_str(entry.get('apiFormat'), 'openaiChat'),
        'api_key': as_str(entry.get('apiKey'), ''),
        'is_custom': True,
        'envVars': as_list(entry.get('envVars'), tmplEnv),
        'authType': as_str(entry.get('authType'), as_str(tmpl.get('authType'), 'api_key') if tmpl else 'api_key'),
        'modelProfiles': as_dict(entry.get('modelProfiles'), tmplProfiles),
        'defaultModel': as_str(entry.get('defaultModel'), as_str(tmpl.get('defaultModel'), '') if tmpl else ''),
        'fallbackModels': as_list(entry.get('fallbackModels'), as_list(tmpl.get('fallbackModels'), []) if tmpl else []),
        'signupUrl': as_str(entry.get('signupUrl'), as_str(tmpl.get('signupUrl'), '') if tmpl else ''),
        'supportsHealthCheck': entry.get(
            'supportsHealthCheck', tmpl.get('supportsHealthCheck', False) if tmpl else False
        ),
        'defaultMaxTokens': as_int(
            entry.get('defaultMaxTokens'), as_int(tmpl.get('defaultMaxTokens'), 4096) if tmpl else 4096
        ),
        'defaultHeaders': as_dict(entry.get('defaultHeaders'), tmplHeaders),
    }


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
        apiKey: Optional[str] = as_str(custom.get('apiKey'), '')
        return {
            'provider': _customProviderDict(custom),
            'api_key': apiKey,
            'baseUrl': as_str(custom.get('baseUrl'), ''),
            'apiMode': as_str(custom.get('apiFormat'), 'openaiChat'),
            'source': 'custom_store',
        }
    from app.providers import resolver as providerResolver
    from app.providers.clients import getClient

    provider = providerResolver.resolve(nameOrId)
    if not provider:
        return None
    client = getClient(provider) if provider else None
    apiKey = client.resolveApiKey() if client else None
    return {
        'provider': provider,
        'api_key': apiKey or '',
        'baseUrl': as_str(provider.get('baseUrl'), ''),
        'apiMode': as_str(provider.get('apiMode'), ''),
        'source': 'registry',
    }


registerInvalidationCallback(invalidate)
