"""
Resolve a provider by name or model ID, with fallback logic.

Port of backend/providers/provider-resolver.js (enhanced).
"""

from __future__ import annotations

from typing import Any, Optional

from app.config import settings
from app.providers import registry, aliases
from app.providers.builtin import register_all


def resolve(name: str) -> Optional[dict[str, Any]]:
    """Find a provider by name, alias, or model ID."""
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

    # 2. Case-insensitive name match
    for p in registry.list_all():
        if p["name"].lower() == name_str.lower():
            return p

    # 3. Check aliases
    for p in registry.list_all():
        p_aliases = p.get("aliases", [])
        if isinstance(p_aliases, list):
            if name_str.lower() in [a.lower() for a in p_aliases]:
                return p

    # 4. Model-based matching: check if model ID matches profile keys
    for p in registry.list_all():
        profiles = p.get("model_profiles", {})
        if name_str in profiles:
            return p
        # Check prefix matching against profile keys
        for profile_key in profiles:
            if profile_key != "*" and name_str.lower().startswith(profile_key.lower()):
                return p

    # 5. Prefix-based name matching
    for p in registry.list_all():
        pname = p["name"].lower().split()[0]
        if name_str.lower().startswith(pname):
            return p

    return None


def list_available() -> list[dict[str, Any]]:
    """Return all registered providers."""
    if not registry.names():
        register_all()
    return registry.list_all()
