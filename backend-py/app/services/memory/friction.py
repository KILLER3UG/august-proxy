"""Friction attribution — structured recording of why things go wrong.

Categories: provider, harness, model, requirement, tool, external, complexity.
Part of Better Harness Plan Phase 3.2.
"""

from __future__ import annotations

import logging
from enum import Enum

logger = logging.getLogger(__name__)


class FrictionCategory(str, Enum):
    """Structured friction categories for attribution."""

    PROVIDER = 'provider'        # timeout, auth, rate-limit, 5xx
    HARNESS = 'harness'          # missing context, skill, rule, AGENTS.md gap
    MODEL = 'model'              # wrong approach, hallucination, loop
    REQUIREMENT = 'requirement'  # ambiguous goal, unclear acceptance
    TOOL = 'tool'                # tool execution failure, wrong args
    EXTERNAL = 'external'        # network, OS, filesystem
    COMPLEXITY = 'complexity'    # inherently hard task, no single cause


def record_friction(
    session_id: str,
    category: FrictionCategory | str,
    detail: str | None = None,
    tool_name: str | None = None,
) -> None:
    """Record a friction event. Fire-and-forget — never raises."""
    try:
        from app.services.memory_store import _conn

        cat = category.value if isinstance(category, FrictionCategory) else str(category)
        conn = _conn()
        conn.execute(
            'INSERT INTO friction_events (session_id, category, detail, tool_name) VALUES (?, ?, ?, ?)',
            (session_id, cat, (detail or '')[:500], tool_name),
        )
        conn.commit()
    except Exception as exc:
        logger.debug('Friction recording failed (non-fatal): %s', exc)


def record_tool_friction(session_id: str, tool_name: str, error: str) -> None:
    """Convenience: record a TOOL category friction from a tool error."""
    record_friction(session_id, FrictionCategory.TOOL, detail=error[:300], tool_name=tool_name)


def record_provider_friction(session_id: str, status_code: int, detail: str = '') -> None:
    """Convenience: record a PROVIDER category friction from a retry/error."""
    record_friction(
        session_id, FrictionCategory.PROVIDER,
        detail=f'HTTP {status_code}: {detail[:200]}',
    )


def get_friction_stats(since_days: int = 7) -> dict:
    """Aggregate friction events by category over a time window.

    Returns: {total, byCategory: {category: count}, daily: [{date, count}], topTools: [...]}
    """
    try:
        from datetime import datetime, timedelta, timezone

        from app.services.memory_store import _conn

        conn = _conn()
        # friction_events.created_at is UTC 'YYYY-MM-DD HH:MM:SS'
        # (datetime('now') default) — a naive-local ISO cutoff would shift
        # the window by the local-UTC offset.
        cutoff = (datetime.now(timezone.utc) - timedelta(days=since_days)).strftime('%Y-%m-%d %H:%M:%S')

        # Total and by-category
        rows = conn.execute('''
            SELECT category, COUNT(*) as cnt
            FROM friction_events
            WHERE created_at > ?
            GROUP BY category
            ORDER BY cnt DESC
        ''', (cutoff,)).fetchall()

        by_category = {row['category']: row['cnt'] for row in rows}
        total = sum(by_category.values())

        # Daily trend
        daily_rows = conn.execute('''
            SELECT DATE(created_at) as day, COUNT(*) as cnt
            FROM friction_events
            WHERE created_at > ?
            GROUP BY DATE(created_at)
            ORDER BY day
        ''', (cutoff,)).fetchall()
        daily = [{'date': r['day'], 'count': r['cnt']} for r in daily_rows]

        # Top tools causing friction
        tool_rows = conn.execute('''
            SELECT tool_name, COUNT(*) as cnt
            FROM friction_events
            WHERE created_at > ? AND tool_name IS NOT NULL
            GROUP BY tool_name
            ORDER BY cnt DESC
            LIMIT 5
        ''', (cutoff,)).fetchall()
        top_tools = [{'tool': r['tool_name'], 'count': r['cnt']} for r in tool_rows]

        return {
            'total': total,
            'sinceDays': since_days,
            'byCategory': by_category,
            'daily': daily,
            'topTools': top_tools,
        }
    except Exception as exc:
        logger.debug('Friction stats query failed: %s', exc)
        return {'total': 0, 'sinceDays': since_days, 'byCategory': {}, 'daily': [], 'topTools': []}


def recent_friction(limit: int = 20) -> list[dict]:
    """Return the most recent raw friction events, newest first.

    Used by the Brain "You" tab to show what went wrong per conversation.
    """
    try:
        from app.services.memory_store import _conn, _row_as_wire

        if limit < 1 or limit > 200:
            limit = 20
        conn = _conn()
        rows = conn.execute(
            'SELECT id, session_id, category, detail, tool_name, created_at '
            'FROM friction_events ORDER BY id DESC LIMIT ?',
            (limit,),
        ).fetchall()
        return [_row_as_wire(r) for r in rows]
    except Exception as exc:
        logger.debug('Friction recent query failed: %s', exc)
        return []
