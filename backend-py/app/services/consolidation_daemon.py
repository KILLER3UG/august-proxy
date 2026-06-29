"""
Sleep Cycle — consolidation daemon (Phase 9a).

Background daemon (built on Phase 8 daemon infrastructure) triggered during
idle or every 24 hours. Uses the Hippocampus model to review recent
auto_memories and learned_heuristics, then merges duplicates, promotes
recurring patterns to facts, and deletes stale entries.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)


_CONSOLIDATION_INTERVAL = 86400  # 24 hours


def run_consolidation() -> dict[str, Any]:
    """Run one consolidation cycle.

    Returns stats about what was done: merges, promotions, deletions.
    In production this would be scheduled via the Phase 8 daemon manager.
    """
    stats: dict[str, Any] = {
        "merged": 0,
        "promoted": 0,
        "deleted_stale": 0,
        "errors": [],
    }

    try:
        conn = _brain_conn()

        # ── 1. Merge duplicate heuristics ──
        dupes = conn.execute("""
            SELECT rule, COUNT(*) as cnt
            FROM learned_heuristics
            GROUP BY rule
            HAVING cnt > 1
        """).fetchall()

        for row in dupes:
            rule = row["rule"]
            rows = conn.execute(
                "SELECT id FROM learned_heuristics WHERE rule = ? ORDER BY id",
                (rule,),
            ).fetchall()
            # Keep the first (oldest), delete the rest
            for dup_row in rows[1:]:
                conn.execute("DELETE FROM learned_heuristics WHERE id = ?", (dup_row["id"],))
            stats["merged"] += len(rows) - 1

        # ── 2. Promote patterns (5× same correction → fact) ──
        from app.services.memory_store import save_fact
        patterns = conn.execute("""
            SELECT rule, COUNT(*) as cnt
            FROM learned_heuristics
            GROUP BY rule
            HAVING cnt >= 5
        """).fetchall()

        for row in patterns:
            rule = row["rule"]
            save_fact(f"heuristic_pattern_{int(time.time())}", rule,
                       category="learned", source="consolidation", confidence=0.9)
            stats["promoted"] += 1

        # ── 3. Delete stale heuristics ──
        # Heuristics older than 30 days with no recent updates
        stale = conn.execute("""
            SELECT id FROM learned_heuristics
            WHERE updated_at < datetime('now', '-30 days')
        """).fetchall()
        for row in stale:
            conn.execute("DELETE FROM learned_heuristics WHERE id = ?", (row["id"],))
        stats["deleted_stale"] = len(stale)

        conn.commit()

    except Exception as exc:
        stats["errors"].append(str(exc))
        logger.error("Consolidation error: %s", exc)

    return stats


def _brain_conn():
    """Get the brain DB connection."""
    from app.services.memory_store import _conn as get_conn
    return get_conn()
