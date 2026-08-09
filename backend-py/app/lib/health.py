"""
Health probes — check if each provider is reachable.
"""

from __future__ import annotations


async def probeUrl(url: str, timeout: float = 5.0) -> bool:
    try:
        # Lazy import: httpx costs ~170 ms of import time; the health probe
        # only runs at request time (cold-start win for the desktop shell).
        import httpx

        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(url)
            return r.is_success
    except Exception:
        return False
