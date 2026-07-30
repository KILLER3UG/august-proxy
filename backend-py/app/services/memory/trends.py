"""Longitudinal trends — weekly aggregation of harness metrics.

Part of Better Harness Plan Phase 5.4.
Tracks: friction, evidence verified-%, memory retrievals, skill invocations.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)


def record_weekly_snapshot() -> dict | None:
    """Aggregate the past week's metrics into harness_trends.

    Called by consolidation daemon on its 24h cycle (only writes once per week).
    Returns the snapshot dict or None if already recorded this week.
    """
    try:
        from app.services.memory_store import _conn

        conn = _conn()
        week_start = (datetime.now() - timedelta(days=datetime.now().weekday())).strftime('%Y-%m-%d')

        # Check if already recorded
        existing = conn.execute(
            'SELECT id FROM harness_trends WHERE week_start = ?', (week_start,)
        ).fetchone()
        if existing:
            return None

        week_ago = (datetime.now() - timedelta(days=7)).isoformat()

        # Friction stats
        friction_rows = conn.execute('''
            SELECT category, COUNT(*) as cnt FROM friction_events
            WHERE created_at > ? GROUP BY category
        ''', (week_ago,)).fetchall()
        friction_total = sum(r['cnt'] for r in friction_rows)
        friction_by_cat = {r['category']: r['cnt'] for r in friction_rows}

        # Memory retrievals
        mem_row = conn.execute('''
            SELECT COUNT(*) as cnt FROM memory_lifecycle
            WHERE event = 'retrieved' AND created_at > ?
        ''', (week_ago,)).fetchone()
        memory_retrievals = mem_row['cnt'] if mem_row else 0

        # Sessions count
        sess_row = conn.execute('''
            SELECT COUNT(*) as cnt FROM sessions
            WHERE started_at > ?
        ''', (week_ago,)).fetchone()
        sessions_count = sess_row['cnt'] if sess_row else 0

        snapshot = {
            'weekStart': week_start,
            'frictionTotal': friction_total,
            'frictionByCategory': friction_by_cat,
            'evidenceVerifiedPct': 0.0,  # Populated when evidence tracking is wired
            'memoryRetrievals': memory_retrievals,
            'skillInvocations': 0,  # Populated from curator usage
            'sessionsCount': sessions_count,
        }

        conn.execute('''
            INSERT INTO harness_trends (week_start, friction_total, friction_by_category,
                evidence_verified_pct, memory_retrievals, skill_invocations, sessions_count)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (
            week_start, friction_total, json.dumps(friction_by_cat),
            0.0, memory_retrievals, 0, sessions_count,
        ))
        conn.commit()
        logger.info('Recorded weekly harness trend: %s', week_start)
        return snapshot
    except Exception as exc:
        logger.debug('Weekly snapshot failed: %s', exc)
        return None


def get_trends(weeks: int = 12) -> list[dict]:
    """Retrieve trend history for the last N weeks."""
    try:
        from app.services.memory_store import _conn

        conn = _conn()
        rows = conn.execute('''
            SELECT week_start, friction_total, friction_by_category,
                   evidence_verified_pct, memory_retrievals, skill_invocations, sessions_count
            FROM harness_trends
            ORDER BY week_start DESC
            LIMIT ?
        ''', (weeks,)).fetchall()

        return [
            {
                'weekStart': r['week_start'],
                'frictionTotal': r['friction_total'],
                'frictionByCategory': json.loads(r['friction_by_category'] or '{}'),
                'evidenceVerifiedPct': r['evidence_verified_pct'],
                'memoryRetrievals': r['memory_retrievals'],
                'skillInvocations': r['skill_invocations'],
                'sessionsCount': r['sessions_count'],
            }
            for r in reversed(rows)  # Chronological order
        ]
    except Exception as exc:
        logger.debug('Trends query failed: %s', exc)
        return []
