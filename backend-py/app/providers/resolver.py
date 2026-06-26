"""
Resolve a provider by name or model ID, with fallback logic.

Port of backend/providers/provider-resolver.js + model-resolver.js (enhanced).
"""

from __future__ import annotations

from typing import Any, Optional

from app.config import settings
from app.providers import registry, aliases
from app.providers.builtin import register_all


def _has_api_key(provider: dict[str, Any]) -> bool:
    """Check if a provider has credentials configured (API key or env var)."""
    from app.providers.clients import get_client

    client = get_client(provider)
    if not client:
        return False
    return client.resolve_api_key() is not None


def resolve(name: str) -> Optional[dict[str, Any]]:
    """Find a provider by name, alias, or model ID.

    Resolution order:
    1. Normalize via aliases map
    2. Exact name match
    3. Provider aliases list match
    4. Config.json modelAliases targetProvider
    5. Model profile key match (prefers provider with API key)
    6. Prefix-based name match (prefers provider with API key)
    7. Model profile key match (any provider)
    8. Prefix-based name match (any provider)
    """
    if not registry.names():
        register_all()

    if not name:
        providers = list_available()
        return providers[0] if providers else None

    name_str = str(name)

    # 1. Normalize via aliases
    canonical = aliases.normalize(name_str)
    provider = registry.get(canonical)
    if provider:
        return provider

    all_providers = registry.list_all()

    # 2. Case-insensitive name match
    for p in all_providers:
        if p["name"].lower() == name_str.lower():
            return p

    # 3. Check provider aliases list
    for p in all_providers:
        p_aliases = p.get("aliases", [])
        if isinstance(p_aliases, list):
            if name_str.lower() in [a.lower() for a in p_aliases]:
                return p

    # 4. Config.json modelAliases targetProvider
    aliases_cfg = settings.config.get("modelAliases", [])
    if isinstance(aliases_cfg, list):
        for alias_entry in aliases_cfg:
            if alias_entry.get("alias", "").lower() == name_str.lower():
                target_provider = alias_entry.get("targetProvider", "")
                if target_provider:
                    for p in all_providers:
                        if p["name"].lower() == target_provider.lower():
                            return p
                        if target_provider.lower() in [a.lower() for a in p.get("aliases", [])]:
                            return p

    # 5. Model profile key match (prefer configured)
    for p in all_providers:
        profiles = p.get("model_profiles", {})
        if name_str in profiles and _has_api_key(p):
            return p

    # 6. Prefix-based name match (prefer configured)
    for p in all_providers:
        pname = p["name"].lower().split()[0]
        if name_str.lower().startswith(pname) and _has_api_key(p):
            return p

    # 7. Model profile key match (any provider)
    for p in all_providers:
        profiles = p.get("model_profiles", {})
        if name_str in profiles:
            return p
        for profile_key in profiles:
            if profile_key != "*" and name_str.lower().startswith(profile_key.lower()):
                return p

    # 8. Prefix-based name match (any provider)
    for p in all_providers:
        pname = p["name"].lower().split()[0]
        if name_str.lower().startswith(pname):
            return p

    return None


def list_available() -> list[dict[str, Any]]:
    """Return all registered providers."""
    if not registry.names():
        register_all()
    return registry.list_all()
