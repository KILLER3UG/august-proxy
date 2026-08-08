"""Audit log API routes.

Reads the durable ``config_audit`` table (category/action/actor + before/
after JSON) — the previous implementation read the ``lifecycle`` table with
a mandatory session filter, so the Audit tab always came back empty, and
its response shape (``{events}``) didn't match what the frontend expects
(``{entries, total, at}`` + a ``?summary=1`` aggregate).
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Query

from app.json_narrowing import as_int, as_str
from app.services import memory_store

router = APIRouter(prefix='/api/audit')


def _row_to_entry(row: dict[str, object]) -> dict[str, object]:
    """Map a config_audit row (snake_case) to the wire entry shape."""
    import json

    def _parse(raw: object) -> object:
        if not raw:
            return None
        try:
            return json.loads(as_str(raw, ''))
        except Exception:
            return None

    return {
        'id': as_int(row.get('id'), 0),
        'at': as_str(row.get('created_at'), ''),
        'category': as_str(row.get('category'), ''),
        'action': as_str(row.get('action'), ''),
        'actor': as_str(row.get('actor'), ''),
        'before': _parse(row.get('before_json')),
        'after': _parse(row.get('after_json')),
    }


@router.get('')
async def listAuditLog(
    limit: int = Query(100, ge=1, le=500),
    category: str = '',
    actor: str = '',
    action: str = '',
    since: str = '',
    until: str = '',
    summary: int = 0,
):
    """List audit entries, newest first.

    Filters: ``category``, ``actor``, ``action``, ``since``/``until``
    (ISO timestamps). ``summary=1`` returns the aggregate instead of rows.
    """
    conn = memory_store._conn()  # noqa: SLF001
    clauses: list[str] = []
    params: list[object] = []
    if category:
        clauses.append('category = ?')
        params.append(category)
    if actor:
        clauses.append('actor = ?')
        params.append(actor)
    if action:
        clauses.append('action = ?')
        params.append(action)
    if since:
        clauses.append('created_at >= ?')
        params.append(since)
    if until:
        clauses.append('created_at <= ?')
        params.append(until)
    where = f'WHERE {" AND ".join(clauses)}' if clauses else ''

    if summary:
        try:
            rows = conn.execute(
                f'SELECT category, action, actor, created_at FROM config_audit {where}'
            ).fetchall()
        except Exception:
            rows = []
        by_category: dict[str, int] = {}
        by_action: dict[str, int] = {}
        by_actor: dict[str, int] = {}
        for r in rows:
            by_category[as_str(r['category'], '')] = by_category.get(as_str(r['category'], ''), 0) + 1
            by_action[as_str(r['action'], '')] = by_action.get(as_str(r['action'], ''), 0) + 1
            by_actor[as_str(r['actor'], '')] = by_actor.get(as_str(r['actor'], ''), 0) + 1
        return {
            'count': len(rows),
            'byCategory': by_category,
            'byResult': by_action,
            'byActor': by_actor,
            'byCritical': {'true': 0, 'false': 0, 'null': len(rows)},
            'at': time.time(),
        }

    try:
        rows = conn.execute(
            f'SELECT * FROM config_audit {where} ORDER BY created_at DESC LIMIT ?',
            (*params, limit),
        ).fetchall()
    except Exception:
        rows = []
    entries = [_row_to_entry(dict(r)) for r in rows]
    return {'entries': entries, 'total': len(entries), 'at': time.time()}


@router.get('/stats')
async def auditStats():
    """Get audit statistics."""
    stats = memory_store.get_stats()
    return {'totalEvents': stats.get('lifecycle', 0), 'totalSessions': stats.get('sessions', 0)}
