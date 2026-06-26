"""
Route a model ID to the best provider.

Port of backend/providers/route-resolver.js (enhanced).

Resolution order:
1. Explicit provider hint
2. Exact model match in any provider's model_profiles keys
3. Prefix match on provider name vs model_id prefix
4. Partial match on model_profiles keys
5. First available provider
"""

from __future__ import annotations

from typing import Optional

from app.providers import registry, resolver


def resolve_for_model(
    model_id: str,
    hint: Optional[str] = None,
) -> Optional[dict]:
    """
    Find the best provider for a model ID.
    """
    providers = resolver.list_available()
    if not providers:
        return None

    # 1. Explicit hint
    if hint:
        for p in providers:
            if p["name"].lower() == hint.lower():
                return p

    model_lower = model_id.lower()

    # 2. Exact model match in any provider's model_profiles
    for p in providers:
        profiles = p.get("model_profiles", {})
        if model_id in profiles:
            return p
        # Also check keys that the model starts with
        for profile_key in profiles:
            if model_lower == profile_key.lower():
                return p

    # 3. Prefix match on provider name vs model_id prefix
    for p in providers:
        pname = p["name"].lower().split()[0]  # first word of provider name
        if model_lower.startswith(pname):
            return p

    # 4. Partial match on model_profiles keys (model starts with profile key)
    for p in providers:
        profiles = p.get("model_profiles", {})
        for profile_key in profiles:
            if profile_key != "*" and model_lower.startswith(profile_key.lower()):
                return p

    # 5. Fallback: check aliases
    from app.providers import aliases as alias_module
    for p in providers:
        p_aliases = p.get("aliases", [])
        for alias in p_aliases:
            if model_lower.startswith(alias.lower()):
                return p

    # 6. First available provider
    return providers[0]
