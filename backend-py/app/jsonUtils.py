"""Safe narrowing helpers for ``JsonValue``-typed provider payloads.

Provider payloads (Anthropic / OpenAI / etc.) are represented as
``JsonValue`` (a broad recursive union: ``str | int | float | bool | None
| list[JsonValue] | dict[str, object]``). Because the union is broad,
operating on a value directly makes mypy reject it (e.g. ``JsonValue +
str`` or ``.get`` on a non-dict member).

These helpers narrow a ``JsonValue`` to a concrete type at runtime. They
are the single, shared convention for touching dynamic payloads across the
codebase, which keeps mypy satisfied while staying flexible for new or
optional fields: a missing or oddly-typed value degrades gracefully to the
provided default instead of raising. Prefer them over ad-hoc ``isinstance``
checks so the behavior is consistent everywhere.
"""

from __future__ import annotations

from app.typeAliases import JsonValue


def as_str(value: object, default: str = '') -> str:
    """Return ``value`` as a ``str``, or ``default`` if it is not a str/None."""
    return value if isinstance(value, str) else default


def as_dict(value: object, default: dict[str, object] | None = None) -> dict[str, object]:
    """Return ``value`` as a ``dict``, or ``default``/``{}`` if it is not a dict."""
    if isinstance(value, dict):
        return value
    return default if default is not None else {}


def as_list(value: object, default: list[object] | None = None) -> list[object]:
    """Return ``value`` as a ``list``, or ``default``/``[]`` if it is not a list."""
    if isinstance(value, list):
        return value
    return default if default is not None else []


def as_int(value: object, default: int = 0) -> int:
    """Return ``value`` as an ``int`` (excluding ``bool``), or ``default``."""
    return value if isinstance(value, int) and not isinstance(value, bool) else default


def as_float(value: object, default: float = 0.0) -> float:
    """Return ``value`` as a ``float``/``int`` (excluding ``bool``), or ``default``."""
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else default


def as_bool(value: object, default: bool = False) -> bool:
    """Return ``value`` as a ``bool``, or ``default`` if it is not a bool."""
    return value if isinstance(value, bool) else default
