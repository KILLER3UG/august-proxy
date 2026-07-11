"""
Topic index — topic classification + grouping for sessions.

Port of backend/services/memory/topic-index.js (213 lines).
"""
from __future__ import annotations
from app.services.memory.brain_orchestrator import classifyTask
from app.services.memory_store import indexSessionTopic as _index
VALID_TOPICS = {'debug', 'code_edit', 'research', 'memory_question', 'planning', 'system_control', 'chat'}

def classifyTopic(text: str) -> str:
    """Normalize arbitrary text into a topic slug.

    Falls back to 'chat' when no category matches.
    """
    t = str(text or '').strip()
    if not t:
        return 'chat'
    category = classifyTask(t)
    if category in VALID_TOPICS:
        return category
    return 'chat'

def indexSession(sessionId: str, taskText: str, parentTopic: str | None=None, confidence: float=0.75) -> dict[str, object] | None:
    """Record the topic for a session.

    Idempotent — calling twice with the same session id overwrites.
    Returns the persisted record.
    """
    if not sessionId:
        return None
    topic = classifyTopic(taskText)
    success = _index(sessionId, topic, parentTopic, confidence)
    if not success:
        return None
    return {'session_id': sessionId, 'topic': topic, 'parent_topic': parentTopic, 'confidence': confidence}

def getSessionTopic(sessionId: str) -> dict[str, object] | None:
    """Get the classified topic for a session."""
    from app.services.memory_store import getSessionTopic as _get
    return _get(sessionId)

def listTopics(limit: int=50) -> list[dict[str, object]]:
    """List all classified session topics."""
    from app.services.memory_store import listTopics as _list
    return _list(limit)

def searchSessionsByTopic(topic: str) -> list[dict[str, object]]:
    """Find sessions with a given topic classification."""
    from app.services.memory_store import searchSessionsByTopic as _search
    return _search(topic)