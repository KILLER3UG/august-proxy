"""
Route a model ID to the best provider.
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
    Priority: explicit hint -> exact model match -> prefix match -> any active provider.
    """
    providers = resolver.list_available()
    if not providers:
        return None

    # 1. Explicit hint
    if hint:
        for p in providers:
            if p["name"].lower() == hint.lower():
                return p

    # 2. Exact model match in any provider's model list
    # (This will work once model lists are populated from providers.json)

    # 3. Prefix match on provider name vs model_id prefix
    model_lower = model_id.lower()
    for p in providers:
        pname = p["name"].lower().split()[0]  # first word of provider name
        if model_lower.startswith(pname):
            return p

    # 4. First available provider
    return providers[0]
