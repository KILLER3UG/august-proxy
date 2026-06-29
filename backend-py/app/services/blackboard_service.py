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
from datetime import datetime, timedelta
from typing import Any


def _conn():
    from app.services.memory_store import _conn as get_conn
    return get_conn()


def compute_ttl(poll_interval: int) -> str:
    """v2: Adaptive TTL = max(poll_interval * 2, 60). Returns ISO timestamp string.

    A CI watcher polling every 30s gets notes that live >= 60s.
    A fast env-watcher polling every 2s gets notes that live >= 4s.
    """
    ttl_seconds = max(poll_interval * 2, 60)
    expires = datetime.utcnow() + timedelta(seconds=ttl_seconds)
    return expires.strftime("%Y-%m-%d %H:%M:%S")


def write_note(
    session_id: str,
    agent: str,
    key: str,
    value: Any,
    priority: int = 0,
    ttl_seconds: int | None = None,
    poll_interval: int | None = None,
) -> None:
    """Write a note to the blackboard.

    v2: If `poll_interval` is provided, the TTL is computed adaptively
    (max(poll_interval*2, 60)). If `ttl_seconds` is also provided, ttl_seconds wins.
    """
    conn = _conn()
    expires = None
    if poll_interval is not None and ttl_seconds is None:
        expires = compute_ttl(poll_interval)
    elif ttl_seconds and ttl_seconds > 0:
        expires = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() + ttl_seconds))
    conn.execute(
        "INSERT INTO blackboard (session_id, agent, key, value, priority, expires_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (session_id, agent, key, json.dumps(value) if not isinstance(value, str) else value,
         priority, expires),
    )
    conn.commit()


def read_notes(
    session_id: str,
    agent: str = "",
    key: str = "",
    ack: bool = False,
) -> list[dict[str, Any]]:
    """Read notes from the blackboard, with optional agent/key filters.

    v2: If `ack=True`, the read notes are deleted on read (acknowledged
    by the consumer).
    """
    conn = _conn()
    _cleanup_expired(conn)
    query = "SELECT * FROM blackboard WHERE session_id = ?"
    params: list[Any] = [session_id]
    if agent:
        query += " AND agent = ?"
        params.append(agent)
    if key:
        query += " AND key = ?"
        params.append(key)
    query += " ORDER BY priority DESC, created_at DESC"
    rows = conn.execute(query, params).fetchall()
    notes = [dict(r) for r in rows]

    if ack and notes:
        # Delete the acknowledged notes
        for n in notes:
            if n.get("id"):
                conn.execute("DELETE FROM blackboard WHERE id = ?", (n["id"],))
        conn.commit()

    return notes


def clear_notes(session_id: str, agent: str = "") -> int:
    """Clear blackboard notes, optionally for a specific agent."""
    conn = _conn()
    if agent:
        cursor = conn.execute(
            "DELETE FROM blackboard WHERE session_id = ? AND agent = ?",
            (session_id, agent),
        )
    else:
        cursor = conn.execute(
            "DELETE FROM blackboard WHERE session_id = ?",
            (session_id,),
        )
    conn.commit()
    return cursor.rowcount


def _cleanup_expired(conn) -> None:
    """Delete expired notes."""
    conn.execute(
        "DELETE FROM blackboard WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
    )
    conn.commit()
