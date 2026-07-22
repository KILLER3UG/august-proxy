"""
Blackboard service — inter-agent shared cognitive workspace (Phase 10.1).

Allows the main loop and background daemons to share real-time state via
a SQLite table. TTL-based cleanup. Session-scoped.

v2: Adaptive TTL (`max(poll_interval*2, 60s)` or 3 turns), `ack` parameter
on read to delete-on-read, and Tier 3 injection support.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from typing import cast

from app.type_aliases import BlackboardNoteDict


def _conn():
    from app.services.memory_store import _conn as getConn

    return getConn()


def computeTtl(pollInterval: int) -> str:
    """v2: Adaptive TTL = max(poll_interval * 2, 60). Returns ISO timestamp string.

    A CI watcher polling every 30s gets notes that live >= 60s.
    A fast env-watcher polling every 2s gets notes that live >= 4s.
    """
    ttlSeconds = max(pollInterval * 2, 60)
    expires = datetime.now(timezone.utc) + timedelta(seconds=ttlSeconds)
    return expires.strftime('%Y-%m-%d %H:%M:%S')


def writeNote(
    sessionId: str,
    agent: str,
    key: str,
    value: object,
    priority: int = 0,
    ttlSeconds: int | None = None,
    pollInterval: int | None = None,
) -> None:
    """Write a note to the blackboard.

    v2: If `poll_interval` is provided, the TTL is computed adaptively
    (max(poll_interval*2, 60)). If `ttl_seconds` is also provided, ttl_seconds wins.
    """
    conn = _conn()
    expires = None
    if pollInterval is not None and ttlSeconds is None:
        expires = computeTtl(pollInterval)
    elif ttlSeconds and ttlSeconds > 0:
        expires = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(time.time() + ttlSeconds))
    conn.execute(
        'INSERT INTO blackboard (session_id, agent, key, value, priority, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        (sessionId, agent, key, json.dumps(value) if not isinstance(value, str) else value, priority, expires),
    )
    conn.commit()


def readNotes(sessionId: str, agent: str = '', key: str = '', ack: bool = False) -> list[BlackboardNoteDict]:
    """Read notes from the blackboard, with optional agent/key filters.

    v2: If `ack=True`, the read notes are deleted on read (acknowledged
    by the consumer). Returns camelCase wire dicts via ``_row_as_wire``.
    """
    from app.services.memory_store import _row_as_wire

    conn = _conn()
    _cleanupExpired(conn)
    query = 'SELECT * FROM blackboard WHERE session_id = ?'
    params: list[object] = [sessionId]
    if agent:
        query += ' AND agent = ?'
        params.append(agent)
    if key:
        query += ' AND key = ?'
        params.append(key)
    query += ' ORDER BY priority DESC, created_at DESC'
    rows = conn.execute(query, params).fetchall()
    notes: list[dict[str, object]] = [_row_as_wire(r) for r in rows]
    if ack and notes:
        for n in notes:
            if n.get('id'):
                conn.execute('DELETE FROM blackboard WHERE id = ?', (n['id'],))
        conn.commit()
    return cast('list[BlackboardNoteDict]', notes)


def clearNotes(sessionId: str, agent: str = '') -> int:
    """Clear blackboard notes, optionally for a specific agent."""
    conn = _conn()
    if agent:
        cursor = conn.execute('DELETE FROM blackboard WHERE session_id = ? AND agent = ?', (sessionId, agent))
    else:
        cursor = conn.execute('DELETE FROM blackboard WHERE session_id = ?', (sessionId,))
    conn.commit()
    return cursor.rowcount


def _cleanupExpired(conn) -> None:
    """Delete expired notes."""
    conn.execute("DELETE FROM blackboard WHERE expires_at IS NOT NULL AND expires_at < datetime('now')")
    conn.commit()
