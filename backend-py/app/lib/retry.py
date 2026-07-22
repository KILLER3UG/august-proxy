"""
Retry helpers for upstream API calls — exponential backoff on 429/503.
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from typing import TypeVar

_T = TypeVar('_T')


async def retryWithBackoff(coroFactory: Callable[[], Awaitable[_T]], maxRetries: int = 3, baseDelay: float = 1.0) -> _T:
    """Call coro_factory() — retry on ConnectionError / 429 / 503."""
    for attempt in range(maxRetries + 1):
        try:
            return await coroFactory()
        except (ConnectionError, TimeoutError):
            if attempt >= maxRetries:
                raise
            delay = baseDelay * 2**attempt + random.uniform(0, 0.5)
            await asyncio.sleep(delay)
    raise RuntimeError('unreachable')
