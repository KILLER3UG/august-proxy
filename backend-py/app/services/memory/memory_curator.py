"""
Memory curator — autonomous memory management: eviction, consolidation, archiving.

Port of backend/services/memory/memory-curator.js.
"""

from __future__ import annotations

from typing import Any

from app.services.memory_store import list_memory, save_memory, delete_memory
from app.services.memory.memory_quality import score_quality, deduplicate

_MAX_MEMORY_ENTRIES = 500
_MAX_FACTS = 200


def curate() -> dict[str, Any]:
    """Run curation cycle on memory store."""
    stats = {"removed": 0, "consolidated": 0, "archived": 0}

    # Score and remove low-quality entries
    entries = list_memory()
    for e in entries:
        val = e.get("value", "")
        text = str(val) if isinstance(val, str) else str(val.get("content", "") if isinstance(val, dict) else "")
        q = score_quality(text)
        if q["score"] < 0.3 and q["reasons"] != ["empty"]:
            delete_memory(e["key"])
            stats["removed"] += 1

    # Deduplicate
    remaining = list_memory()
    if len(remaining) > 1:
        deduped = deduplicate(remaining)
        if len(deduped) < len(remaining):
            # Rewrite deduplicated entries
            for old in remaining:
                if old not in deduped:
                    delete_memory(old["key"])
            stats["consolidated"] = len(remaining) - len(deduped)

    # Enforce limits
    for table, limit in [("memory_store", _MAX_MEMORY_ENTRIES)]:
        entries = list_memory()
        if len(entries) > limit:
            sorted_entries = sorted(entries, key=lambda e: e.get("updated_at", ""))
            for old in sorted_entries[:len(entries) - limit]:
                delete_memory(old["key"])
                stats["archived"] += 1

    return stats
