"""
Memory retention — time-based eviction and importance-weighted retention policies.

Port of backend/services/memory/memory-retention.js.
"""

from __future__ import annotations
import time
from datetime import datetime, timezone
from app.services.memory_store import listMemory, deleteMemory, listFacts, deleteFact

_RETENTION = {'transient': 86400 * 7, 'normal': 86400 * 30, 'important': 86400 * 90, 'critical': 86400 * 365}


def _parseTimestamp(ts: str) -> float:
    try:
        dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
        return dt.timestamp()
    except (ValueError, AttributeError):
        return time.time()


def applyRetentionPolicy(policy: str = 'normal') -> dict[str, object]:
    """Apply retention policy, removing expired entries."""
    maxAge = _RETENTION.get(policy, _RETENTION['normal'])
    now = time.time()
    memoryRemoved = 0
    factsRemoved = 0
    for entry in listMemory():
        updated = entry.get('updatedAt', '')
        age = now - _parseTimestamp(updated) if updated else maxAge + 1
        if age > maxAge:
            deleteMemory(entry['key'])
            memoryRemoved += 1
    for fact in listFacts():
        updated = fact.get('updatedAt', '')
        age = now - _parseTimestamp(updated) if updated else maxAge + 1
        if age > maxAge:
            deleteFact(fact['factKey'])
            factsRemoved += 1
    stats: dict[str, object] = {'memory_removed': memoryRemoved, 'facts_removed': factsRemoved}
    return stats


def getEntryAge(key: str) -> float | None:
    """Get the age in seconds of a memory entry."""
    for entry in listMemory():
        if entry.get('key') == key:
            updated = entry.get('updatedAt', '')
            if updated:
                return time.time() - _parseTimestamp(updated)
    return None
