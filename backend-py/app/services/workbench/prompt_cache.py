"""
Prompt cache — in-memory LRU for Tier 1 + Tier 2 system prompt content (Phase 7).

Keyed by session ID with 5-minute TTL. Max 100 sessions.
"""

from __future__ import annotations

import time
from collections import OrderedDict


class PromptCache:
    """LRU cache for system prompt tiers with TTL eviction."""

    def __init__(self, maxSessions: int = 100, ttlSeconds: int = 300):
        self.maxSessions = maxSessions
        self.ttlSeconds = ttlSeconds
        self._cache: OrderedDict[str, tuple[float, str]] = OrderedDict()
        self.hits = 0
        self.misses = 0

    def get(self, sessionId: str) -> str | None:
        """Get cached prompt for a session. Returns None if miss or expired."""
        if sessionId not in self._cache:
            self.misses += 1
            return None
        cachedAt, content = self._cache[sessionId]
        if time.monotonic() - cachedAt > self.ttlSeconds:
            del self._cache[sessionId]
            self.misses += 1
            return None
        self.hits += 1
        self._cache.move_to_end(sessionId)
        return content

    def set(self, sessionId: str, content: str) -> None:
        """Cache prompt for a session."""
        self._cache[sessionId] = (time.monotonic(), content)
        self._cache.move_to_end(sessionId)
        while len(self._cache) > self.maxSessions:
            self._cache.popitem(last=False)

    def invalidate(self, sessionId: str) -> None:
        """Remove a session's cached prompt."""
        self._cache.pop(sessionId, None)

    def clear(self) -> None:
        """Clear all cached prompts."""
        self._cache.clear()

    def stats(self) -> dict[str, object]:
        """Return cache statistics (hit rate for observability)."""
        total = self.hits + self.misses
        return {
            'size': len(self._cache),
            'max_sessions': self.maxSessions,
            'ttl_seconds': self.ttlSeconds,
            'hits': self.hits,
            'misses': self.misses,
            'hit_rate': round(self.hits / total, 3) if total else 0.0,
        }


_cache = PromptCache()


def getCache() -> PromptCache:
    """Get the global prompt cache singleton."""
    return _cache
