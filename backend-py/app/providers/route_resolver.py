"""
Route a model ID to the best provider.

Port of backend/providers/route-resolver.js + model-resolver.js.

Resolution order:
1. User-defined alias in config.json modelAliases → use targetProvider
2. Exact model match in any provider's model_profiles keys
3. Prefix match on provider name vs model_id prefix
4. Partial match on model_profiles keys (model starts with profile key)
5. First available provider
"""

from __future__ import annotations

from typing import Any, Optional

from app.config import settings
from app.providers import registry, resolver


def resolve_for_model(
    model_id: str,
    hint: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """
    Find the best provider for a model ID.

    Priority:
    1. Explicit provider hint
    2. User-defined alias in config.json modelAliases
    3. Exact model match in any provider's model_profiles
    4. Prefix match on provider name
    5. Model profiles partial match
    6. First available provider
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
            # Check aliases too
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
                        # Match by alias
                        if target_provider.lower() in [a.lower() for a in p.get("aliases", [])]:
                            return p
                # If no targetProvider, use the alias's targetModel
                target_model = alias_entry.get("targetModel", "")
                if target_model:
                    return resolve_for_model(target_model, hint)

    # 3. Exact model match in any provider's model_profiles
    for p in providers:
        profiles = p.get("model_profiles", {})
        if model_id in profiles:
            return p
        for profile_key in profiles:
            if model_lower == profile_key.lower():
                return p

    # 4. Prefix match on provider name vs model_id prefix
    for p in providers:
        pname = p["name"].lower().split()[0]
        if model_lower.startswith(pname):
            return p

    # 5. Partial match on model_profiles keys
    for p in providers:
        profiles = p.get("model_profiles", {})
        for profile_key in profiles:
            if profile_key != "*" and model_lower.startswith(profile_key.lower()):
                return p

    # 6. Alias name match
    for p in providers:
        p_aliases = p.get("aliases", [])
        for alias in p_aliases:
            if model_lower.startswith(alias.lower()):
                return p

    # 7. First available provider
    return providers[0] if providers else None
