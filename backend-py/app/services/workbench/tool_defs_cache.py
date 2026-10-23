"""Cache provider tool definitions at registry and session scope.

The shared cache holds registry → provider-format conversion. Each session
also holds its final disclosed and filtered array, keyed by the session's tool
SET, model profile and gates. The per-turn BM25 query chooses membership on the
first build but is deliberately not part of the key: including it made the
"session" cache a per-turn cache and let the provider's tool-array prefix move
mid-session. Disable with ``AUGUST_P1_TOOL_CACHE=0`` to rebuild both layers on
every call (useful for A/B latency measurements).
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import threading
from typing import Any

_lock = threading.Lock()
# format -> (registry_gen, mcp_sig, tools)
_cache: dict[str, tuple[int, str, list[dict[str, object]]]] = {}
_hits = 0
_misses = 0


def session_key(payload: dict[str, object]) -> str:
    """Stable identity for the complete, session-filtered provider tool array."""
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(',', ':'), default=str)
    return hashlib.sha256(encoded.encode('utf-8')).hexdigest()


def get_session_cached(session: object, fmt: str, key: str) -> list[dict[str, object]] | None:
    """Return a copy of the session's final provider tool array on an exact hit."""
    if not enabled():
        return None
    cache = getattr(session, '_tool_defs_cache', None)
    if not isinstance(cache, dict):
        return None
    entry = cache.get(fmt)
    if not isinstance(entry, tuple) or len(entry) != 2 or entry[0] != key:
        return None
    tools = entry[1]
    return copy.deepcopy(tools) if isinstance(tools, list) else None


def store_session_cached(
    session: object, fmt: str, key: str, tools: list[dict[str, object]]
) -> None:
    """Store a private copy of the fully filtered provider tool array on session."""
    if not enabled():
        return
    cache = getattr(session, '_tool_defs_cache', None)
    if not isinstance(cache, dict):
        cache = {}
        setattr(session, '_tool_defs_cache', cache)
    cache[fmt] = (key, copy.deepcopy(tools))


def enabled() -> bool:
    v = os.environ.get('AUGUST_P1_TOOL_CACHE', '1').strip().lower()
    return v not in ('0', 'false', 'no', 'off')


def clear() -> None:
    global _hits, _misses
    with _lock:
        _cache.clear()
        _hits = 0
        _misses = 0


def stats() -> dict[str, object]:
    with _lock:
        return {
            'enabled': enabled(),
            'entries': len(_cache),
            'hits': _hits,
            'misses': _misses,
        }


def _mcp_signature() -> str:
    try:
        from app.services.tools.mcp_client import getMcpToolDefinitionsSync

        defs = getMcpToolDefinitionsSync()
        encoded = json.dumps(defs, sort_keys=True, ensure_ascii=False, separators=(',', ':'), default=str)
        return hashlib.sha256(encoded.encode('utf-8')).hexdigest()
    except Exception:
        return ''


def get_or_build(
    fmt: str,
    builder: Any,
) -> list[dict[str, object]]:
    """Return a **copy** of cached tools for ``fmt`` ('anthropic'|'openai')."""
    global _hits, _misses
    if not enabled():
        return builder()
    from app.services import tool_registry

    gen = tool_registry.generation()
    mcp_sig = _mcp_signature()
    with _lock:
        hit = _cache.get(fmt)
        if hit is not None and hit[0] == gen and hit[1] == mcp_sig:
            _hits += 1
            return copy.deepcopy(hit[2])
        _misses += 1
    built = builder()
    with _lock:
        _cache[fmt] = (gen, mcp_sig, copy.deepcopy(built))
    return built
