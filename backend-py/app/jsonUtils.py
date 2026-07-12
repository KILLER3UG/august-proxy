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

import json
import os
import tempfile
from collections.abc import Callable

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


def write_json_atomic(
    path: str | os.PathLike[str],
    data: object,
    indent: int = 2,
    default: Callable[[object], object] | None = None,
) -> None:
    """Write ``data`` to ``path`` as JSON atomically.

    The payload is serialised to a temporary file created in the *same*
    directory as ``path`` and then moved into place with ``os.replace``.
    Because the rename is atomic on a single filesystem, any reader (or a
    crash / interruption mid-write) always sees either the old file or the
    complete new file — never a partially written one.

    Args:
        path: Destination file path (``str`` or ``os.PathLike``).
        data: JSON-serialisable object to write.
        indent: Indentation passed to ``json.dumps`` (default ``2``).
        default: Optional ``default`` callable passed to ``json.dumps`` for
            non-serialisable values (e.g. ``str``).
    """
    text = json.dumps(data, indent=indent, ensure_ascii=False, default=default)
    target = os.path.abspath(path)
    tmp = tempfile.NamedTemporaryFile(
        mode='w',
        encoding='utf-8',
        dir=os.path.dirname(target),
        delete=False,
        suffix='.tmp',
    )
    try:
        with tmp:
            tmp.write(text)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp.name, target)
    except BaseException:
        # Best-effort cleanup of the partial temp file.
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise
