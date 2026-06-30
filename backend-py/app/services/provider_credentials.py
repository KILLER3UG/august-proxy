"""Provider credentials — single source of truth.

Consults ``providers.json`` (custom store) first, then the built-in registry
+ env vars. Used by the workbench credential check and provider_resolver so
the chat thread sees the same availability the UI shows.

Cache lifecycle:
- The store is loaded once on first use and cached in ``_store_cache``.
- Call :func:`invalidate` to clear the cache (e.g. after writing to
  ``providers.json``). ``config_service.save_providers_store`` will
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

from typing import Any, Callable, Optional

from app.services import config_service


_store_cache: Optional[dict[str, Any]] = None

# Registry of invalidation callbacks. Other modules (notably
# config_service.save_providers_store) invoke these whenever the
# providers.json file changes. This avoids a hard import dependency from
# config_service -> provider_credentials, which would create a circular
# import.
_invalidation_callbacks: list[Callable[[], None]] = []


def register_invalidation_callback(callback: Callable[[], None]) -> Callable[[], None]:
    """Register a callback invoked whenever the providers.json store changes.

    Returns the callback to ease registration as a side-effect of import.
    """
    _invalidation_callbacks.append(callback)
    return callback


def _fire_invalidation() -> None:
    for cb in _invalidation_callbacks:
        try:
            cb()
        except Exception:  # pragma: no cover - defensive
            # Don't let a misbehaving callback break the write path.
            pass


def invalidate() -> None:
    """Clear the in-memory providers.json cache.

    Call this after writing to ``providers.json`` so subsequent
    :func:`resolve` calls reload from disk. ``config_service.save_providers_store``
    does this automatically via the invalidation registry.
    """
    global _store_cache
    _store_cache = None


def _load_store() -> dict[str, Any]:
    """Reload the providers.json cache from disk."""
    global _store_cache
    _store_cache = config_service.get_providers_store()
    return _store_cache


def _custom_entry(name_or_id: str) -> Optional[dict[str, Any]]:
    """Find a custom-store provider entry by id (preferred) or name.

    Lookup is case-insensitive. ``id`` matches are preferred over ``name``
    matches for stability (mirrors ``provider_resolver.resolve``).
    """
    if _store_cache is None:
        _load_store()
    store = _store_cache or {}
    target = name_or_id.lower()
    id_match: Optional[dict[str, Any]] = None
    name_match: Optional[dict[str, Any]] = None
    for entry in store.get("providers", []):
        if entry.get("id", "").lower() == target and id_match is None:
            id_match = entry
        if entry.get("name", "").lower() == target and name_match is None:
            name_match = entry
    return id_match or name_match


def _custom_provider_dict(entry: dict[str, Any]) -> dict[str, Any]:
    """Build a provider-dict shaped like the registry returns, from a custom store entry.

    All optional fields use safe defaults via ``entry.get(...)`` so downstream
    consumers can read display_name, description, default_model, etc. without
    KeyError on minimal custom entries.
    """
    return {
        "name": entry.get("name", ""),
        "id": entry.get("id", ""),
        "display_name": entry.get("display_name", entry.get("name", "")),
        "description": entry.get("description", ""),
        "aliases": [],
        "base_url": entry.get("baseUrl", ""),
        "api_mode": entry.get("apiFormat", "openai-chat"),
        "api_key": entry.get("apiKey", ""),
        "is_custom": True,
        "env_vars": [],
        "auth_type": "api_key",
        "model_profiles": {},
        "default_model": entry.get("default_model", ""),
        "fallback_models": entry.get("fallback_models", []),
        "signup_url": entry.get("signup_url", ""),
        "supports_health_check": entry.get("supports_health_check", False),
        "default_max_tokens": entry.get("default_max_tokens", 4096),
        "default_headers": entry.get("default_headers", {}),
    }


def resolve(name_or_id: str) -> Optional[dict[str, Any]]:
    """Return ``{"provider": ..., "api_key": ..., "base_url": ..., "api_mode": ...}`` or ``None``.

    Resolution order:
    1. Custom ``providers.json`` entry by id or name (authoritative for the key),
       but only if the entry is enabled AND has a non-empty ``apiKey``. Disabled
       or unkeyed custom entries fall through to the built-in registry.
    2. Built-in registry via ``provider_resolver.resolve`` (uses env vars / config.json).
    """
    if not name_or_id:
        return None

    # 1. Custom store — provides the API key saved via the UI.
    # Skip entries that are disabled or have no API key so they fall through
    # to the built-in registry path (matches model_service._aggregate_models).
    custom = _custom_entry(name_or_id)
    if custom and custom.get("enabled") and custom.get("apiKey"):
        api_key = custom.get("apiKey", "") or ""
        return {
            "provider": _custom_provider_dict(custom),
            "api_key": api_key,
            "base_url": custom.get("baseUrl", ""),
            "api_mode": custom.get("apiFormat", "openai-chat"),
            "source": "custom_store",
        }

    # 2. Built-in registry — pull client to read env key
    from app.providers import resolver as provider_resolver
    from app.providers.clients import get_client

    provider = provider_resolver.resolve(name_or_id)
    if not provider:
        return None
    client = get_client(provider) if provider else None
    api_key = client.resolve_api_key() if client else None
    return {
        "provider": provider,
        "api_key": api_key or "",
        "base_url": provider.get("base_url", ""),
        "api_mode": provider.get("api_mode", ""),
        "source": "registry",
    }


# Auto-register our invalidation callback so anyone (including
# config_service.save_providers_store) who fires the registry will clear
# our cache. Done at import time — circular-safe because
# provider_credentials already imports config_service, not the other way.
register_invalidation_callback(invalidate)
