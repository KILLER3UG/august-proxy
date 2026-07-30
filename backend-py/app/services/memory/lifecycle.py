"""Memory lifecycle tracking — records evidence states for memories.

Tracks: created → retrieved → applied → effective → stale.
Part of Better Harness Plan Phase 3.1.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)


def record_lifecycle_event(memory_key: str, event: str, session_id: str | None = None) -> None:
    """Record a lifecycle event for a memory key.

    Events: created, retrieved, applied, effective, stale.
    Fire-and-forget — never raises.
    """
    try:
        from app.services.memory_store import _conn

        conn = _conn()
        conn.execute(
            'INSERT INTO memory_lifecycle (memory_key, event, session_id) VALUES (?, ?, ?)',
            (memory_key, event, session_id),
        )
        conn.commit()
    except Exception as exc:
        logger.debug('Lifecycle event recording failed (non-fatal): %s', exc)


def record_retrieved(memory_keys: list[str], session_id: str | None = None) -> None:
    """Batch-record retrieval events for multiple memories."""
    try:
        from app.services.memory_store import _conn

        conn = _conn()
        for key in memory_keys:
            conn.execute(
                'INSERT INTO memory_lifecycle (memory_key, event, session_id) VALUES (?, ?, ?)',
                (key, 'retrieved', session_id),
            )
        conn.commit()
    except Exception as exc:
        logger.debug('Batch lifecycle recording failed (non-fatal): %s', exc)


def get_memory_lifecycle_stats() -> list[dict]:
    """Aggregate lifecycle stats per memory key.

    Returns list of dicts with: key, created, retrieved_count, applied_count,
    last_retrieved, state (active|stale|dormant).
    """
    try:
        from app.services.memory_store import _conn

        conn = _conn()
        rows = conn.execute('''
            SELECT
                memory_key,
                MIN(CASE WHEN event = 'created' THEN created_at END) as created,
                SUM(CASE WHEN event = 'retrieved' THEN 1 ELSE 0 END) as retrieved_count,
                SUM(CASE WHEN event = 'applied' THEN 1 ELSE 0 END) as applied_count,
                MAX(CASE WHEN event = 'retrieved' THEN created_at END) as last_retrieved,
                MAX(CASE WHEN event = 'stale' THEN 1 ELSE 0 END) as is_stale
            FROM memory_lifecycle
            GROUP BY memory_key
            ORDER BY retrieved_count DESC
            LIMIT 100
        ''').fetchall()

        results = []
        for row in rows:
            state = 'stale' if row['is_stale'] else ('active' if row['retrieved_count'] > 0 else 'dormant')
            results.append({
                'key': row['memory_key'],
                'created': row['created'],
                'retrievedCount': row['retrieved_count'],
                'appliedCount': row['applied_count'],
                'lastRetrieved': row['last_retrieved'],
                'state': state,
            })
        return results
    except Exception as exc:
        logger.debug('Lifecycle stats query failed: %s', exc)
        return []


def mark_stale_memories(days: int = 30) -> int:
    """Mark memories not retrieved in `days` as stale. Returns count marked.

    Called by consolidation daemon on its 24h cycle.
    """
    try:
        from app.services.memory_store import _conn

        conn = _conn()
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()

        # Find keys that have been created but never retrieved (or last retrieved before cutoff)
        stale_keys = conn.execute('''
            SELECT DISTINCT memory_key FROM memory_lifecycle
            WHERE memory_key NOT IN (
                SELECT memory_key FROM memory_lifecycle
                WHERE event = 'retrieved' AND created_at > ?
            )
            AND memory_key NOT IN (
                SELECT memory_key FROM memory_lifecycle WHERE event = 'stale'
            )
            AND event = 'created'
        ''', (cutoff,)).fetchall()

        count = 0
        for row in stale_keys:
            conn.execute(
                'INSERT INTO memory_lifecycle (memory_key, event) VALUES (?, ?)',
                (row['memory_key'], 'stale'),
            )
            count += 1
        if count:
            conn.commit()
            logger.info('Marked %d memories as stale (not retrieved in %d days)', count, days)
        return count
    except Exception as exc:
        logger.debug('Stale marking failed: %s', exc)
        return 0
