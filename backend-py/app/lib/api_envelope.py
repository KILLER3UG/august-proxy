"""Standard API response envelope for August endpoints.

Part of Better Harness Plan Phase 4.8.
Provides {ok, format_version, data|error} wrapper for consistent API responses.
"""

from __future__ import annotations

from typing import Any

FORMAT_VERSION = '1.0'


def success(data: Any = None, **meta: Any) -> dict:
    """Wrap a successful response in the standard envelope."""
    envelope: dict[str, Any] = {
        'ok': True,
        'formatVersion': FORMAT_VERSION,
        'data': data,
    }
    if meta:
        envelope['meta'] = meta
    return envelope


def error(code: str, message: str, hint: str | None = None, status: int = 400) -> dict:
    """Wrap an error response in the standard envelope."""
    err: dict[str, Any] = {
        'code': code,
        'message': message,
    }
    if hint:
        err['hint'] = hint
    return {
        'ok': False,
        'formatVersion': FORMAT_VERSION,
        'error': err,
    }


def paginated(items: list, total: int, offset: int = 0, limit: int = 50) -> dict:
    """Wrap a paginated list response."""
    return success(
        data=items,
        pagination={
            'total': total,
            'offset': offset,
            'limit': limit,
            'hasMore': offset + limit < total,
        },
    )
