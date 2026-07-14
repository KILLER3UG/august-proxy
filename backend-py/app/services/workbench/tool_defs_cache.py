"""Cache base workbench tool definitions (registry → provider format).

Caches only the **stable** conversion of registered tools (+ MCP append),
keyed by ``tool_registry.generation()`` and a light MCP signature.

Progressive disclosure / session-message filtering still runs outside this
cache (see ``toolDefinitions`` in workbench.py).

Disable with env ``AUGUST_P1_TOOL_CACHE=0`` to force a rebuild every call
(useful for A/B latency measurements).
"""

from __future__ import annotations

import copy
import os
import threading
from typing import Any

_lock = threading.Lock()
# format -> (registry_gen, mcp_sig, tools)
_cache: dict[str, tuple[int, str, list[dict[str, object]]]] = {}
_hits = 0
_misses = 0


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
        names: list[str] = []
        for raw in defs:
            if raw.get('type') == 'function':
                names.append(str((raw.get('function') or {}).get('name', '')))
            else:
                names.append(str(raw.get('name', '')))
        return ','.join(sorted(n for n in names if n))
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
