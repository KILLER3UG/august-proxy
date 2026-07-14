"""
Provider registry — in-memory store of all provider configs.
"""

from __future__ import annotations
from typing import Optional

_registry: dict[str, dict[str, object]] = {}


def register(info: dict[str, object]) -> None:
    """Register a provider by its name."""
    name = str(info.get('name', ''))
    if name:
        _registry[name] = dict(info)


def get(name: str) -> Optional[dict[str, object]]:
    return _registry.get(name)


def list_all() -> list[dict[str, object]]:
    return list(_registry.values())


def names() -> list[str]:
    return list(_registry.keys())


def clear() -> None:
    _registry.clear()
