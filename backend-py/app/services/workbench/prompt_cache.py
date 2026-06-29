"""
Prompt cache — in-memory LRU for Tier 1 + Tier 2 system prompt content (Phase 7).

Keyed by session ID with 5-minute TTL. Max 100 sessions.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any


class PromptCache:
    """LRU cache for system prompt tiers with TTL eviction."""

    def __init__(self, max_sessions: int = 100, ttl_seconds: int = 300):
        self.max_sessions = max_sessions
        self.ttl_seconds = ttl_seconds
        self._cache: OrderedDict[str, tuple[float, str]] = OrderedDict()

    def get(self, session_id: str) -> str | None:
        """Get cached prompt for a session. Returns None if miss or expired."""
        if session_id not in self._cache:
            return None
        cached_at, content = self._cache[session_id]
        if time.monotonic() - cached_at > self.ttl_seconds:
            del self._cache[session_id]
            return None
        # Move to end (most recently used)
        self._cache.move_to_end(session_id)
        return content

    def set(self, session_id: str, content: str) -> None:
        """Cache prompt for a session."""
        self._cache[session_id] = (time.monotonic(), content)
        self._cache.move_to_end(session_id)
        # Evict oldest if over max
        while len(self._cache) > self.max_sessions:
            self._cache.popitem(last=False)

    def invalidate(self, session_id: str) -> None:
        """Remove a session's cached prompt."""
        self._cache.pop(session_id, None)

    def clear(self) -> None:
        """Clear all cached prompts."""
        self._cache.clear()

    def stats(self) -> dict[str, Any]:
        """Return cache statistics."""
        return {
            "size": len(self._cache),
            "max_sessions": self.max_sessions,
            "ttl_seconds": self.ttl_seconds,
        }


# Global singleton
_cache = PromptCache()


def get_cache() -> PromptCache:
    """Get the global prompt cache singleton."""
    return _cache
