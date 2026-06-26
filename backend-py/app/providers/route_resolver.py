"""
Route a model ID to the best provider.

Port of backend/providers/route-resolver.js + model-resolver.js.

Resolution order:
1. User-defined alias in config.json modelAliases → use targetProvider
2. Exact model match in provider's model_profiles (credential-aware)
3. Prefix match on provider name (credential-aware)
4. Model profile partial match (credential-aware)
5. Exact model match (any provider)
6. Prefix match (any provider)
7. Active provider (first with credentials)
"""

from __future__ import annotations

from typing import Any, Optional

from app.config import settings
from app.providers import registry, resolver


def _has_credentials(provider: dict[str, Any]) -> bool:
    """Check if a provider has API credentials configured."""
    from app.providers.clients import get_client

    client = get_client(provider)
    if not client:
        return False
    return client.resolve_api_key() is not None


def resolve_for_model(
    model_id: str,
    hint: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """
    Find the best provider for a model ID.

    Returns the first provider with credentials that supports the model.
    Falls through to credential-less providers only if no credentialled
    provider matches.
    """
    providers = resolver.list_available()
    if not providers:
        return None

    model_lower = model_id.lower()

    # 1. Explicit hint
    if hint:
        for p in providers:
            if p["name"].lower() == hint.lower():
                return p
            if hint.lower() in [a.lower() for a in p.get("aliases", [])]:
                return p

    # 2. User-defined alias in config.json modelAliases
    aliases = settings.config.get("modelAliases", [])
    if isinstance(aliases, list):
        for alias_entry in aliases:
            if alias_entry.get("alias", "").lower() == model_lower:
                target_provider = alias_entry.get("targetProvider", "")
                if target_provider:
                    for p in providers:
                        if p["name"].lower() == target_provider.lower():
                            return p
                        if target_provider.lower() in [a.lower() for a in p.get("aliases", [])]:
                            return p

    # 3. Exact model match in model_profiles (credential-aware first)
    for p in providers:
        profiles = p.get("model_profiles", {})
        if (model_id in profiles or model_lower in {k.lower() for k in profiles}) and _has_credentials(p):
            return p

    # 4. Prefix match on provider name (credential-aware)
    for p in providers:
        pname = p["name"].lower().split()[0]
        if model_lower.startswith(pname) and _has_credentials(p):
            return p

    # 5. Partial match on model_profiles keys (credential-aware)
    for p in providers:
        profiles = p.get("model_profiles", {})
        for profile_key in profiles:
            if profile_key != "*" and model_lower.startswith(profile_key.lower()) and _has_credentials(p):
                return p

    # 6. Alias name match (credential-aware)
    for p in providers:
        for alias in p.get("aliases", []):
            if model_lower.startswith(alias.lower()) and _has_credentials(p):
                return p

    # 7-10: Same matches but without credential requirement
    for p in providers:
        profiles = p.get("model_profiles", {})
        if model_id in profiles or model_lower in {k.lower() for k in profiles}:
            return p

    for p in providers:
        pname = p["name"].lower().split()[0]
        if model_lower.startswith(pname):
            return p

    for p in providers:
        profiles = p.get("model_profiles", {})
        for profile_key in profiles:
            if profile_key != "*" and model_lower.startswith(profile_key.lower()):
                return p

    for p in providers:
        for alias in p.get("aliases", []):
            if model_lower.startswith(alias.lower()):
                return p

    return providers[0] if providers else None
