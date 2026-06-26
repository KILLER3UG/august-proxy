"""
Cross-session bridge — links related sessions and provides continuity.

Port of backend/services/memory/cross-session-bridge.js.
"""

from __future__ import annotations

from typing import Any

from app.services.memory_store import save_memory, get_memory, search_memory, index_session_topic

_BRIDGE_KEY = "session_bridges"


def bridge_sessions(source_id: str, target_id: str, reason: str = "related") -> None:
    """Create a bridge between two sessions."""
    bridges = get_memory(_BRIDGE_KEY) or {}
    if not isinstance(bridges, dict):
        bridges = {}

    if source_id not in bridges:
        bridges[source_id] = []
    bridges[source_id].append({
        "targetId": target_id,
        "reason": reason,
        "createdAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    })
    save_memory(_BRIDGE_KEY, bridges)


def get_session_bridges(session_id: str) -> list[dict[str, Any]]:
    """Get all bridges for a session."""
    bridges = get_memory(_BRIDGE_KEY) or {}
    if not isinstance(bridges, dict):
        return []
    return bridges.get(session_id, [])


def find_related_sessions(session_id: str, topic: str = "") -> list[dict[str, Any]]:
    """Find sessions related to the given one."""
    related = []

    # Direct bridges
    for b in get_session_bridges(session_id):
        related.append({"id": b["targetId"], "reason": b.get("reason", "bridged"), "score": 1.0})

    # Same topic
    if topic:
        topic_sessions = search_memory(f"session_topic:{topic}")
        for s in topic_sessions:
            sid = s.get("key", "")
            if sid != session_id and not any(r["id"] == sid for r in related):
                related.append({"id": sid, "reason": "same_topic", "score": 0.8})

    return related
