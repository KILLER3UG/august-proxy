"""
Heuristics service — CRUD over the learned_heuristics table (Phase 4).

The table was created in Phase 0; this service provides the application
layer for adding, removing, listing, and clearing heuristics.

All writes go through the Phase 0 write queue (db_writer.enqueue_write)
when called from async contexts, or directly from sync ones.
"""
from __future__ import annotations

def _conn():
    """Get the thread-local brain DB connection."""
    from app.services.memory_store import _conn as getConn
    return getConn()

def listHeuristics(category: str='') -> list[dict[str, object]]:
    """List all learned heuristics, optionally filtered by category."""
    conn = _conn()
    if category:
        rows = conn.execute('SELECT id, rule, source, category, createdAt, updatedAt FROM learnedHeuristics WHERE category = ? ORDER BY updatedAt DESC', (category,)).fetchall()
    else:
        rows = conn.execute('SELECT id, rule, source, category, createdAt, updatedAt FROM learnedHeuristics ORDER BY updatedAt DESC').fetchall()
    return [dict(r) for r in rows]

def addHeuristic(rule: str, source: str='auto', category: str='general') -> int | None:
    """Add a learned heuristic rule.

    Returns the new row id, or None if the rule already exists (duplicate).
    """
    if not rule or not rule.strip():
        return None
    conn = _conn()
    existing = conn.execute('SELECT id FROM learnedHeuristics WHERE rule = ?', (rule.strip(),)).fetchone()
    if existing:
        return None
    conn.execute("INSERT INTO learnedHeuristics (rule, source, category, updatedAt) VALUES (?, ?, ?, datetime('now'))", (rule.strip(), source, category))
    conn.commit()
    rowId = conn.execute('SELECT last_insert_rowid()').fetchone()[0]
    try:
        from app.services.brain_event_bus import emitBrainEvent
        emitBrainEvent(category='heuristic', layer='heuristics_service.add_heuristic', summary=f'Added heuristic [{source}]: {rule.strip()[:120]}', meta={'rule_id': rowId, 'source': source, 'category': category})
    except Exception:
        pass
    return rowId

def removeHeuristic(ruleId: int) -> bool:
    """Remove a heuristic by id. Returns True if it existed."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM learnedHeuristics WHERE id = ?', (ruleId,))
    conn.commit()
    return cursor.rowcount > 0

def removeByRule(rule: str) -> bool:
    """Remove a heuristic by exact rule text. Returns True if it existed."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM learnedHeuristics WHERE rule = ?', (rule.strip(),))
    conn.commit()
    return cursor.rowcount > 0

def clearHeuristics(category: str='') -> int:
    """Clear all heuristics, optionally filtered by category. Returns count removed."""
    conn = _conn()
    if category:
        cursor = conn.execute('DELETE FROM learnedHeuristics WHERE category = ?', (category,))
    else:
        cursor = conn.execute('DELETE FROM learnedHeuristics')
    conn.commit()
    return cursor.rowcount

def countHeuristics(category: str='') -> int:
    """Count heuristics, optionally filtered by category."""
    conn = _conn()
    if category:
        row = conn.execute('SELECT COUNT(*) FROM learnedHeuristics WHERE category = ?', (category,)).fetchone()
    else:
        row = conn.execute('SELECT COUNT(*) FROM learnedHeuristics').fetchone()
    return row[0] if row else 0

def removeHeuristicById(heuristicId: int) -> bool:
    """v3: Remove a heuristic by id. Returns True if found and deleted."""
    conn = _conn()
    cur = conn.execute('DELETE FROM learnedHeuristics WHERE id = ?', (heuristicId,))
    conn.commit()
    return cur.rowcount > 0

def updateHeuristic(heuristicId: int, newRule: str) -> bool:
    """v3: Update a heuristic's rule text. Returns True if found and updated."""
    conn = _conn()
    cur = conn.execute("UPDATE learnedHeuristics SET rule = ?, updatedAt = datetime('now') WHERE id = ?", (newRule, heuristicId))
    conn.commit()
    return cur.rowcount > 0