"""Provider credentials — single source of truth from ``providers.json``."""

from __future__ import annotations

from typing import Callable, Optional

from app.json_narrowing import as_list, as_str
from app.services import config_service

_storeCache: Optional[dict[str, object]] = None
_invalidationCallbacks: list[Callable[[], None]] = []


def registerInvalidationCallback(callback: Callable[[], None]) -> Callable[[], None]:
    _invalidationCallbacks.append(callback)
    return callback


def _fireInvalidation() -> None:
    for cb in _invalidationCallbacks:
        try:
            cb()
        except Exception:
            pass


def invalidate() -> None:
    global _storeCache
    _storeCache = None
    try:
        from app.providers.clients import clear_client_pool

        clear_client_pool()
    except Exception:
        pass


def _loadStore() -> dict[str, object]:
    global _storeCache
    _storeCache = config_service.getProvidersStore()
    return _storeCache


def _customEntry(nameOrId: str) -> Optional[dict[str, object]]:
    if _storeCache is None:
        _loadStore()
    store = _storeCache or {}
    target = nameOrId.lower()
    id_match: Optional[dict[str, object]] = None
    name_match: Optional[dict[str, object]] = None
    for entry in as_list(store.get('providers'), []):
        if isinstance(entry, dict):
            if as_str(entry.get('id'), '').lower() == target and id_match is None:
                id_match = entry
            if as_str(entry.get('name'), '').lower() == target and name_match is None:
                name_match = entry
    return id_match or name_match


def _customProviderDict(entry: dict[str, object]) -> dict[str, object]:
    from app.providers.resolver import entry_to_provider_dict

    return entry_to_provider_dict(entry)


def resolve(nameOrId: str) -> Optional[dict[str, object]]:
    """Return ``{provider, api_key, baseUrl, apiMode, source}`` or ``None``."""
    if not nameOrId:
        return None
    custom = _customEntry(nameOrId)
    if custom and custom.get('enabled') and custom.get('apiKey'):
        api_key: Optional[str] = as_str(custom.get('apiKey'), '')
        return {
            'provider': _customProviderDict(custom),
            'api_key': api_key,
            'baseUrl': as_str(custom.get('baseUrl'), ''),
            'apiMode': as_str(custom.get('apiFormat'), 'openaiChat'),
            'source': 'custom_store',
        }
    from app.providers import resolver as provider_resolver
    from app.providers.clients import getClient

    provider = provider_resolver.resolve(nameOrId)
    if not provider:
        return None
    api_key = as_str(provider.get('api_key') or provider.get('apiKey'))
    if not api_key:
        client = getClient(provider)
        if client:
            api_key = client.resolveApiKey() or ''
    if not api_key:
        return None
    return {
        'provider': provider,
        'api_key': api_key,
        'baseUrl': as_str(provider.get('baseUrl'), ''),
        'apiMode': as_str(provider.get('apiMode'), 'openaiChat'),
        'source': 'providers_store',
    }
