"""
Topic index — topic classification + grouping for sessions.

Port of backend/services/memory/topic-index.js (213 lines).
"""

from __future__ import annotations

from typing import Any

from app.services.memory.brain_orchestrator import classify_task
from app.services.memory_store import index_session_topic as _index

VALID_TOPICS = {
    "debug", "code_edit", "research", "memory_question",
    "planning", "system_control", "chat",
}


def classify_topic(text: str) -> str:
    """Normalize arbitrary text into a topic slug.

    Falls back to 'chat' when no category matches.
    """
    t = str(text or "").strip()
    if not t:
        return "chat"
    category = classify_task(t)
    if category in VALID_TOPICS:
        return category
    return "chat"


def index_session(session_id: str, task_text: str, parent_topic: str | None = None, confidence: float = 0.75) -> dict[str, Any] | None:
    """Record the topic for a session.

    Idempotent — calling twice with the same session id overwrites.
    Returns the persisted record.
    """
    if not session_id:
        return None
    topic = classify_topic(task_text)
    success = _index(session_id, topic, parent_topic, confidence)
    if not success:
        return None
    return {
        "session_id": session_id,
        "topic": topic,
        "parent_topic": parent_topic,
        "confidence": confidence,
    }


def get_session_topic(session_id: str) -> dict[str, Any] | None:
    """Get the classified topic for a session."""
    from app.services.memory_store import get_session_topic as _get
    return _get(session_id)


def list_topics(limit: int = 50) -> list[dict[str, Any]]:
    """List all classified session topics."""
    from app.services.memory_store import list_topics as _list
    return _list(limit)


def search_sessions_by_topic(topic: str) -> list[dict[str, Any]]:
    """Find sessions with a given topic classification."""
    from app.services.memory_store import search_sessions_by_topic as _search
    return _search(topic)
