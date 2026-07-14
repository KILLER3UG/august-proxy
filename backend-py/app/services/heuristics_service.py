"""
Heuristics service — CRUD over the learned_heuristics table (Phase 4).

The table was created in Phase 0; this service provides the application
layer for adding, removing, listing, and clearing heuristics.

Writes are performed DIRECTLY through ``memoryStore`` (the shared,
thread-local brain connection). Every connection opened by
``memoryStore._conn`` sets ``PRAGMA journal_mode=WAL`` and
``PRAGMA busy_timeout=10000``, so direct writes from the many callers are
safe from "database is locked" errors and corruption under WAL.

``db_writer`` (``app.services.dbWriter``) is a SEPARATE single-writer queue
that serializes writes through one asyncio worker task. It is an ADDITIONAL
serialization layer, NOT the universal write path: as of this writing it is
used only by ``consolidationDaemon``. This service does NOT enqueue through
``db_writer``; it commits changes directly via ``memoryStore``.
"""

from __future__ import annotations


def _conn():
    """Get the thread-local brain DB connection."""
    from app.services.memory_store import _conn as getConn

    return getConn()


def listHeuristics(category: str = '') -> list[dict[str, object]]:
    """List all learned heuristics, optionally filtered by category."""
    from app.services.memory_store import _row_as_wire

    conn = _conn()
    if category:
        rows = conn.execute(
            'SELECT id, rule, source, category, created_at, updated_at FROM learned_heuristics WHERE category = ? ORDER BY updated_at DESC',
            (category,),
        ).fetchall()
    else:
        rows = conn.execute(
            'SELECT id, rule, source, category, created_at, updated_at FROM learned_heuristics ORDER BY updated_at DESC'
        ).fetchall()
    return [_row_as_wire(r) for r in rows]


def addHeuristic(rule: str, source: str = 'auto', category: str = 'general') -> int | None:
    """Add a learned heuristic rule.

    Returns the new row id, or None if the rule already exists (duplicate).
    """
    if not rule or not rule.strip():
        return None
    conn = _conn()
    existing = conn.execute('SELECT id FROM learned_heuristics WHERE rule = ?', (rule.strip(),)).fetchone()
    if existing:
        return None
    conn.execute(
        "INSERT INTO learned_heuristics (rule, source, category, updated_at) VALUES (?, ?, ?, datetime('now'))",
        (rule.strip(), source, category),
    )
    conn.commit()
    rowId = conn.execute('SELECT last_insert_rowid()').fetchone()[0]
    try:
        from app.services.brain_event_bus import emitBrainEvent

        emitBrainEvent(
            category='heuristic',
            layer='heuristics_service.add_heuristic',
            summary=f'Added heuristic [{source}]: {rule.strip()[:120]}',
            meta={'rule_id': rowId, 'source': source, 'category': category},
        )
    except Exception:
        pass
    return rowId


def removeHeuristic(ruleId: int) -> bool:
    """Remove a heuristic by id. Returns True if it existed."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM learned_heuristics WHERE id = ?', (ruleId,))
    conn.commit()
    return cursor.rowcount > 0


def removeByRule(rule: str) -> bool:
    """Remove a heuristic by exact rule text. Returns True if it existed."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM learned_heuristics WHERE rule = ?', (rule.strip(),))
    conn.commit()
    return cursor.rowcount > 0


def clearHeuristics(category: str = '') -> int:
    """Clear all heuristics, optionally filtered by category. Returns count removed."""
    conn = _conn()
    if category:
        cursor = conn.execute('DELETE FROM learned_heuristics WHERE category = ?', (category,))
    else:
        cursor = conn.execute('DELETE FROM learned_heuristics')
    conn.commit()
    return cursor.rowcount


def countHeuristics(category: str = '') -> int:
    """Count heuristics, optionally filtered by category."""
    conn = _conn()
    if category:
        row = conn.execute('SELECT COUNT(*) FROM learned_heuristics WHERE category = ?', (category,)).fetchone()
    else:
        row = conn.execute('SELECT COUNT(*) FROM learned_heuristics').fetchone()
    return row[0] if row else 0


def removeHeuristicById(heuristicId: int) -> bool:
    """v3: Remove a heuristic by id. Returns True if found and deleted."""
    conn = _conn()
    cur = conn.execute('DELETE FROM learned_heuristics WHERE id = ?', (heuristicId,))
    conn.commit()
    return cur.rowcount > 0


def updateHeuristic(heuristicId: int, newRule: str) -> bool:
    """v3: Update a heuristic's rule text. Returns True if found and updated."""
    conn = _conn()
    cur = conn.execute(
        "UPDATE learned_heuristics SET rule = ?, updated_at = datetime('now') WHERE id = ?", (newRule, heuristicId)
    )
    conn.commit()
    return cur.rowcount > 0
