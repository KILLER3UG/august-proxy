"""
Retry helpers for upstream API calls — exponential backoff on 429/503.
"""

from __future__ import annotations

import asyncio
import random


async def retry_with_backoff(coro_factory, max_retries: int = 3, base_delay: float = 1.0):
    """Call coro_factory() — retry on ConnectionError / 429 / 503."""
    for attempt in range(max_retries + 1):
        try:
            return await coro_factory()
        except (ConnectionError, TimeoutError) as exc:
            if attempt >= max_retries:
                raise
            delay = base_delay * (2 ** attempt) + random.uniform(0, 0.5)
            await asyncio.sleep(delay)
    raise RuntimeError("unreachable")
