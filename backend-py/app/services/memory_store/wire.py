"""Row/wire helpers for the brain SQLite store."""
from __future__ import annotations
import json
import sqlite3
from typing import cast
from app.adapters.case_converters import snakeToCamel
from app.type_aliases import JsonValue, SessionRecord

def _q(value: object) -> str:
    """Quote a value for SQL (sync helper)."""
    if value is None:
        return 'NULL'
    return f"'{str(value).replace(chr(39), chr(39) + chr(39))}'"


def _json(value: object) -> str:
    """Serialize a value to JSON for storage."""
    return json.dumps(value)


def _row_as_wire(row: sqlite3.Row | dict[str, object] | None) -> dict[str, object]:
    """Convert a SQLite row (snake_case columns) to a camelCase wire dict."""
    if row is None:
        return {}
    raw = dict(row)
    converted = snakeToCamel(cast(JsonValue, raw))
    return cast(dict[str, object], converted) if isinstance(converted, dict) else raw


def _session_field(session: SessionRecord | dict[str, object], camel: str, default: object = None) -> object:
    """Read a session field accepting camelCase wire keys or snake_case."""
    snake = ''.join((('_' + c.lower()) if c.isupper() else c) for c in camel)
    # Prefer explicit dual-get for common keys without full dict convert
    if camel in session and session.get(camel) is not None:
        return session.get(camel)
    if snake in session and session.get(snake) is not None:  # type: ignore[arg-type]
        return session.get(snake)  # type: ignore[arg-type]
    return default


