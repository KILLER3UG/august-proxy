"""
Heuristics service — CRUD over the learned_heuristics table (Phase 4).

The table was created in Phase 0; this service provides the application
layer for adding, removing, listing, and clearing heuristics.

All writes go through the Phase 0 write queue (db_writer.enqueue_write)
when called from async contexts, or directly from sync ones.
"""

from __future__ import annotations

from typing import Any


def _conn():
    """Get the thread-local brain DB connection."""
    from app.services.memory_store import _conn as get_conn
    return get_conn()


def list_heuristics(category: str = "") -> list[dict[str, Any]]:
    """List all learned heuristics, optionally filtered by category."""
    conn = _conn()
    if category:
        rows = conn.execute(
            "SELECT id, rule, source, category, created_at, updated_at "
            "FROM learned_heuristics WHERE category = ? "
            "ORDER BY updated_at DESC",
            (category,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, rule, source, category, created_at, updated_at "
            "FROM learned_heuristics ORDER BY updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def add_heuristic(rule: str, source: str = "auto", category: str = "general") -> int | None:
    """Add a learned heuristic rule.

    Returns the new row id, or None if the rule already exists (duplicate).
    """
    if not rule or not rule.strip():
        return None

    conn = _conn()
    # Check for duplicate
    existing = conn.execute(
        "SELECT id FROM learned_heuristics WHERE rule = ?", (rule.strip(),)
    ).fetchone()
    if existing:
        return None  # Duplicate, already exists

    conn.execute(
        "INSERT INTO learned_heuristics (rule, source, category, updated_at) "
        "VALUES (?, ?, ?, datetime('now'))",
        (rule.strip(), source, category),
    )
    conn.commit()
    row_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

    # v4.3 — emit a brain event so the dashboard Activity tab sees new rules
    try:
        from app.services.brain_event_bus import emit_brain_event
        emit_brain_event(
            category="heuristic",
            layer="heuristics_service.add_heuristic",
            summary=f"Added heuristic [{source}]: {rule.strip()[:120]}",
            meta={"rule_id": row_id, "source": source, "category": category},
        )
    except Exception:
        pass

    return row_id


def remove_heuristic(rule_id: int) -> bool:
    """Remove a heuristic by id. Returns True if it existed."""
    conn = _conn()
    cursor = conn.execute("DELETE FROM learned_heuristics WHERE id = ?", (rule_id,))
    conn.commit()
    return cursor.rowcount > 0


def remove_by_rule(rule: str) -> bool:
    """Remove a heuristic by exact rule text. Returns True if it existed."""
    conn = _conn()
    cursor = conn.execute(
        "DELETE FROM learned_heuristics WHERE rule = ?", (rule.strip(),)
    )
    conn.commit()
    return cursor.rowcount > 0


def clear_heuristics(category: str = "") -> int:
    """Clear all heuristics, optionally filtered by category. Returns count removed."""
    conn = _conn()
    if category:
        cursor = conn.execute(
            "DELETE FROM learned_heuristics WHERE category = ?", (category,)
        )
    else:
        cursor = conn.execute("DELETE FROM learned_heuristics")
    conn.commit()
    return cursor.rowcount


def count_heuristics(category: str = "") -> int:
    """Count heuristics, optionally filtered by category."""
    conn = _conn()
    if category:
        row = conn.execute(
            "SELECT COUNT(*) FROM learned_heuristics WHERE category = ?", (category,)
        ).fetchone()
    else:
        row = conn.execute("SELECT COUNT(*) FROM learned_heuristics").fetchone()
    return row[0] if row else 0


# ── v3: Mutation helpers (used by brain router mutation endpoints) ─────


def remove_heuristic_by_id(heuristic_id: int) -> bool:
    """v3: Remove a heuristic by id. Returns True if found and deleted."""
    conn = _conn()
    cur = conn.execute("DELETE FROM learned_heuristics WHERE id = ?", (heuristic_id,))
    conn.commit()
    return cur.rowcount > 0


def update_heuristic(heuristic_id: int, new_rule: str) -> bool:
    """v3: Update a heuristic's rule text. Returns True if found and updated."""
    conn = _conn()
    cur = conn.execute(
        "UPDATE learned_heuristics SET rule = ?, updated_at = datetime('now') "
        "WHERE id = ?",
        (new_rule, heuristic_id),
    )
    conn.commit()
    return cur.rowcount > 0
