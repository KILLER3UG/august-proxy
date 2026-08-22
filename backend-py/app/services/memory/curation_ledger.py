"""Unified curation ledger — one decision journal for every loop that
creates, merges, promotes, supersedes, archives, or deletes memory and
skill assets.

Round-5 loop unification. Three curators previously kept three overlapping
bookkeeping streams (brain events + feature_flow + consolidation_audit) with
no shared view of each other's decisions, so the sleep cycle could propose
deleting a fact the reflection loop had just reinforced, and "why did the
harness learn this?" had no single answer. Every curation mutation now
appends one row here; the consolidation prompt and the model-review payload
read recent entries so downstream loops respect upstream decisions.

Fire-and-forget by contract: ledger failures must never break a curation
action that already succeeded.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# Bounded trail: this is a decision journal, not an event firehose.
_MAX_ROWS = 5000
_PRUNE_CHUNK = 500


def record(
    actor: str,
    action: str,
    target_kind: str,
    target_key: str = '',
    reason: str = '',
    detail: str = '',
) -> None:
    """Append one curation decision. Never raises."""
    try:
        from app.services.memory_store import _conn

        conn = _conn()
        conn.execute(
            'INSERT INTO curation_ledger (actor, action, target_kind, target_key, reason, detail) '
            'VALUES (?, ?, ?, ?, ?, ?)',
            (
                str(actor or '')[:40],
                str(action or '')[:40],
                str(target_kind or '')[:40],
                str(target_key or '')[:160],
                str(reason or '')[:300],
                str(detail or '')[:500],
            ),
        )
        _prune_if_needed(conn)
        conn.commit()
    except Exception:
        logger.debug('curation ledger record failed', exc_info=True)


def recent(
    limit: int = 50,
    *,
    actor: str = '',
    target_kind: str = '',
) -> list[dict[str, object]]:
    """Newest-first ledger rows, optionally filtered."""
    try:
        from app.services.memory_store import _conn

        conn = _conn()
        sql = 'SELECT id, actor, action, target_kind, target_key, reason, detail, created_at FROM curation_ledger'
        clauses: list[str] = []
        params: list[object] = []
        if actor:
            clauses.append('actor = ?')
            params.append(actor)
        if target_kind:
            clauses.append('target_kind = ?')
            params.append(target_kind)
        if clauses:
            sql += ' WHERE ' + ' AND '.join(clauses)
        sql += ' ORDER BY id DESC LIMIT ?'
        params.append(max(1, min(int(limit), 500)))
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        logger.debug('curation ledger read failed', exc_info=True)
        return []


def summary_for_prompt(limit: int = 12) -> str:
    """Compact recent-decision lines for LLM prompts ('' when empty).

    Consumers (sleep-cycle planner, model review) prepend this so they do not
    contradict or redo what another loop just decided.
    """
    rows = recent(limit)
    if not rows:
        return ''
    lines: list[str] = []
    for r in rows:
        key = str(r.get('target_key') or '')
        action = str(r.get('action') or '')
        actor = str(r.get('actor') or '')
        reason = str(r.get('reason') or '')[:80]
        line = f'- [{actor}] {action} {key}' + (f': {reason}' if reason else '')
        lines.append(line)
    return '\n'.join(lines)


def _prune_if_needed(conn: object) -> None:
    try:
        row = conn.execute('SELECT COUNT(*) AS c FROM curation_ledger').fetchone()  # type: ignore[attr-defined]
        if int(row['c']) <= _MAX_ROWS + _PRUNE_CHUNK:
            return
        conn.execute(  # type: ignore[attr-defined]
            'DELETE FROM curation_ledger WHERE id NOT IN '
            '(SELECT id FROM curation_ledger ORDER BY id DESC LIMIT ?)',
            (_MAX_ROWS,),
        )
    except Exception:
        logger.debug('curation ledger prune failed', exc_info=True)
