"""
Health probes — check if each provider is reachable.
"""

from __future__ import annotations

import httpx


async def probe_url(url: str, timeout: float = 5.0) -> bool:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(url)
            return r.is_success
    except Exception:
        return False
