"""
Health probes — check if each provider is reachable.
"""
from __future__ import annotations
import httpx

async def probeUrl(url: str, timeout: float=5.0) -> bool:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(url)
            return r.isSuccess
    except Exception:
        return False