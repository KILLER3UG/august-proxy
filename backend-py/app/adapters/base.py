"""
Base adapter — shared utilities for upstream API translation.
"""

from __future__ import annotations
from typing import AsyncIterator, TYPE_CHECKING
import httpx
import json

if TYPE_CHECKING:
    pass


async def streamSse(
    client: httpx.AsyncClient, url: str, headers: dict[str, str], body: dict[str, object], timeout: float = 300.0
) -> AsyncIterator[dict[str, object]]:
    """Stream SSE events from an upstream API."""
    async with client.stream('POST', url, headers=headers, json=body, timeout=timeout) as resp:
        async for line in resp.aiter_lines():
            line = line.strip()
            if line.startswith('data: '):
                data = line[6:].strip()
                if data == '[DONE]':
                    return
                if data:
                    yield json.loads(data)


def buildHeaders(apiKey: str, extra: dict[str, str] | None = None) -> dict[str, str]:
    headers = {'Content-Type': 'application/json', 'Authorization': f'Bearer {apiKey}'}
    if extra:
        headers.update(extra)
    return headers


# Header keys extracted into a plain dict (used by both adapters).
_REQUEST_HEADER_KEYS: tuple[str, ...] = (
    'x-session-id',
    'x-conversation-id',
    'x-request-id',
    'x-correlation-id',
    'user-agent',
    'x-august-client',
)


def extractRequestHeaders(request: object) -> dict[str, str]:
    """Safely extract relevant request headers into a plain dict."""
    if not request or not hasattr(request, 'headers'):
        return {}
    out: dict[str, str] = {}
    for key in _REQUEST_HEADER_KEYS:
        value = request.headers.get(key)
        if value:
            out[key] = str(value)
    return out


# Session-ID header precedence: same for both API surfaces.
_SESSION_HEADER_KEYS: tuple[str, ...] = (
    'x-session-id',
    'x-conversation-id',
    'x-claude-code-session-id',
)

_EXTENDED_SESSION_HEADER_KEYS: tuple[str, ...] = (
    *_SESSION_HEADER_KEYS,
    'x-request-id',
    'x-correlation-id',
)


def _scanHeadersForSessionId(
    request: object,
    keys: tuple[str, ...] = _EXTENDED_SESSION_HEADER_KEYS,
) -> str:
    """Return the first session id header value present, or ''."""
    if not request or not hasattr(request, 'headers'):
        return ''
    for key in keys:
        value = request.headers.get(key)
        if value:
            return str(value)
    return ''
