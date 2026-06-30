"""Provider credentials — single source of truth.

Consults ``providers.json`` (custom store) first, then the built-in registry
+ env vars. Used by the workbench credential check and provider_resolver so
the chat thread sees the same availability the UI shows.
"""
from __future__ import annotations

from typing import Any, Optional

from app.services import config_service


_store_cache: Optional[dict[str, Any]] = None


def _load_store() -> dict[str, Any]:
    """Reload the providers.json cache from disk."""
    global _store_cache
    _store_cache = config_service.get_providers_store()
    return _store_cache


def _custom_entry(name_or_id: str) -> Optional[dict[str, Any]]:
    """Find a custom-store provider entry by name or id."""
    if _store_cache is None:
        _load_store()
    store = _store_cache or {}
    for entry in store.get("providers", []):
        if entry.get("name") == name_or_id or entry.get("id") == name_or_id:
            return entry
    return None


def _custom_provider_dict(entry: dict[str, Any]) -> dict[str, Any]:
    """Build a provider-dict shaped like the registry returns, from a custom store entry."""
    return {
        "name": entry.get("name", ""),
        "id": entry.get("id", ""),
        "aliases": [],
        "base_url": entry.get("baseUrl", ""),
        "api_mode": entry.get("apiFormat", "openai-chat"),
        "api_key": entry.get("apiKey", ""),
        "is_custom": True,
        "env_vars": [],
        "auth_type": "api_key",
        "model_profiles": {},
    }


def resolve(name_or_id: str) -> Optional[dict[str, Any]]:
    """Return ``{"provider": ..., "api_key": ..., "base_url": ..., "api_mode": ...}`` or ``None``.

    Resolution order:
    1. Custom ``providers.json`` entry by id or name (authoritative for the key).
    2. Built-in registry via ``provider_resolver.resolve`` (uses env vars / config.json).
    """
    if not name_or_id:
        return None

    # 1. Custom store — provides the API key saved via the UI
    custom = _custom_entry(name_or_id)
    if custom:
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
