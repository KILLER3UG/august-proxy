"""
Model aggregation service — collects models from all providers.
"""

from __future__ import annotations

from typing import Any

from app.config import settings
from app.providers import resolver as provider_resolver


def aggregate() -> list[dict[str, Any]]:
    """Return aggregated model list from all providers + user-configured models."""
    models = []

    # Built-in provider models (from their default_model)
    for p in provider_resolver.list_available():
        mid = p.get("default_model", "")
        if mid:
            models.append({
                "id": mid,
                "name": mid,
                "provider": p["name"],
                "contextWindow": p.get("default_max_tokens", 8192),
                "supportsReasoning": False,
                "supportsThinking": False,
                "isFree": False,
            })

    # User-configured models from providers.json
    try:
        store = settings.providers
        for entry in store.get("providers", []):
            for m in entry.get("models", []):
                models.append({
                    "id": m["id"],
                    "name": m.get("name", m["id"]),
                    "provider": entry.get("name", ""),
                    "contextWindow": m.get("contextWindow", 128000),
                    "supportsReasoning": m.get("reasoning", False),
                    "supportsThinking": m.get("reasoning", False),
                    "isFree": m.get("free", False),
                })
    except Exception:
        pass

    # Deduplicate by id
    seen = set()
    unique = []
    for m in models:
        if m["id"] not in seen:
            seen.add(m["id"])
            unique.append(m)

    return unique
