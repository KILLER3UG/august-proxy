"""
Provider registry — in-memory store of all provider configs.
"""

from __future__ import annotations

from typing import Any, Optional

_registry: dict[str, dict[str, Any]] = {}


def register(info: dict[str, Any]) -> None:
    """Register a provider by its name."""
    name = info.get("name", "")
    if name:
        _registry[name] = dict(info)


def get(name: str) -> Optional[dict[str, Any]]:
    return _registry.get(name)


def list_all() -> list[dict[str, Any]]:
    return list(_registry.values())


def names() -> list[str]:
    return list(_registry.keys())


def clear() -> None:
    _registry.clear()
