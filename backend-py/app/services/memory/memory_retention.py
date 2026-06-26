"""
Memory retention — time-based eviction and importance-weighted retention policies.

Port of backend/services/memory/memory-retention.js.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from app.services.memory_store import list_memory, delete_memory, list_facts, delete_fact

# Retention periods (seconds)
_RETENTION = {
    "transient": 86400 * 7,       # 1 week
    "normal": 86400 * 30,          # 30 days
    "important": 86400 * 90,       # 90 days
    "critical": 86400 * 365,       # 1 year
}


def _parse_timestamp(ts: str) -> float:
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.timestamp()
    except (ValueError, AttributeError):
        return time.time()


def apply_retention_policy(policy: str = "normal") -> dict[str, Any]:
    """Apply retention policy, removing expired entries."""
    max_age = _RETENTION.get(policy, _RETENTION["normal"])
    now = time.time()
    stats = {"memory_removed": 0, "facts_removed": 0}

    for entry in list_memory():
        updated = entry.get("updated_at", "")
        age = now - _parse_timestamp(updated) if updated else max_age + 1
        if age > max_age:
            delete_memory(entry["key"])
            stats["memory_removed"] += 1

    for fact in list_facts():
        updated = fact.get("updated_at", "")
        age = now - _parse_timestamp(updated) if updated else max_age + 1
        if age > max_age:
            delete_fact(fact["fact_key"])
            stats["facts_removed"] += 1

    return stats


def get_entry_age(key: str) -> float | None:
    """Get the age in seconds of a memory entry."""
    for entry in list_memory():
        if entry.get("key") == key:
            updated = entry.get("updated_at", "")
            if updated:
                return time.time() - _parse_timestamp(updated)
    return None
