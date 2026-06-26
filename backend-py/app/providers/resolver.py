"""
Resolve a provider by name, with fallback logic.
"""

from __future__ import annotations

from typing import Any, Optional

from app.config import settings
from app.providers import registry, aliases
from app.providers.builtin import register_all


def resolve(name: str) -> Optional[dict[str, Any]]:
    """Find a provider by name or alias."""
    if not registry.names():
        register_all()

    canonical = aliases.normalize(name)
    provider = registry.get(canonical)
    if provider:
        return provider

    # Try case-insensitive match
    for p in registry.list_all():
        if p["name"].lower() == name.lower():
            return p
    return None


def list_available() -> list[dict[str, Any]]:
    """Return all registered providers."""
    if not registry.names():
        register_all()
    return registry.list_all()
