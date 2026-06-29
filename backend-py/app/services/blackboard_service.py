"""
Blackboard service — inter-agent shared cognitive workspace (Phase 10.1).

Allows the main loop and background daemons to share real-time state via
a SQLite table. TTL-based cleanup. Session-scoped.
"""

from __future__ import annotations

import json
import time
from typing import Any


def _conn():
    from app.services.memory_store import _conn as get_conn
    return get_conn()


def write_note(session_id: str, agent: str, key: str, value: Any,
               priority: int = 0, ttl_seconds: int = 60) -> None:
    """Write a note to the blackboard."""
    conn = _conn()
    expires = None
    if ttl_seconds > 0:
        expires = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() + ttl_seconds))
    conn.execute(
        "INSERT INTO blackboard (session_id, agent, key, value, priority, expires_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (session_id, agent, key, json.dumps(value) if not isinstance(value, str) else value,
         priority, expires),
    )
    conn.commit()


def read_notes(session_id: str, agent: str = "", key: str = "") -> list[dict[str, Any]]:
    """Read notes from the blackboard, with optional agent/key filters."""
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
    return [dict(r) for r in rows]


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
