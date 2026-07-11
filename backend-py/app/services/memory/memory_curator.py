"""
Memory curator — autonomous memory management: eviction, consolidation, archiving.

Port of backend/services/memory/memory-curator.js.
"""
from __future__ import annotations
from typing import cast
from app.jsonUtils import as_float, as_int, as_str
from app.services.memory_store import listMemory, saveMemory, deleteMemory
from app.services.memory.memory_quality import scoreQuality, deduplicate
_MAXMemoryEntries = 500
_MAXFacts = 200

def curate() -> dict[str, object]:
    """Run curation cycle on memory store."""
    stats: dict[str, object] = {'removed': 0, 'consolidated': 0, 'archived': 0}
    entries = listMemory()
    for e in entries:
        val = e.get('value', '')
        text = str(val) if isinstance(val, str) else str(val.get('content', '') if isinstance(val, dict) else '')
        q = scoreQuality(text)
        if as_float(q['score']) < 0.3 and q['reasons'] != ['empty']:
            deleteMemory(e['key'])
            stats['removed'] = as_int(stats['removed']) + 1
    remaining = listMemory()
    if len(remaining) > 1:
        deduped = deduplicate(cast(list[dict[str, object]], remaining))
        if len(deduped) < len(remaining):
            for old in remaining:
                if old not in deduped:
                    deleteMemory(old['key'])
            stats['consolidated'] = len(remaining) - len(deduped)
    for table, limit in [('memory_store', _MAXMemoryEntries)]:
        entries = listMemory()
        if len(entries) > limit:
            sortedEntries = sorted(entries, key=lambda e: as_str(e.get('updated_at', '')))
            for old in sortedEntries[:len(entries) - limit]:
                deleteMemory(old['key'])
                stats['archived'] = as_int(stats['archived']) + 1
    return stats
