"""
Base adapter — shared utilities for upstream API translation.
"""
from __future__ import annotations
from typing import Any, AsyncIterator
import httpx
import json

async def streamSse(client: httpx.AsyncClient, url: str, headers: dict[str, str], body: dict[str, Any], timeout: float=300.0) -> AsyncIterator[dict[str, Any]]:
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

def buildHeaders(apiKey: str, extra: dict[str, str] | None=None) -> dict[str, str]:
    headers = {'Content-Type': 'application/json', 'Authorization': f'Bearer {apiKey}'}
    if extra:
        headers.update(extra)
    return headers