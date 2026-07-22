"""
Cross-session bridge — links related sessions and provides continuity.

Port of backend/services/memory/cross-session-bridge.js.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.json_narrowing import as_dict, as_list
from app.services.memory_store import get_memory, save_memory, search_memory

_BRIDGEKey = 'session_bridges'


def bridgeSessions(sourceId: str, targetId: str, reason: str = 'related') -> None:
    """Create a bridge between two sessions."""
    bridges = get_memory(_BRIDGEKey) or {}
    if not isinstance(bridges, dict):
        bridges = {}
    targets = as_list(bridges.get(sourceId))
    targets.append(
        {
            'targetId': targetId,
            'reason': reason,
            'createdAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        }
    )
    bridges[sourceId] = targets
    save_memory(_BRIDGEKey, bridges)


def getSessionBridges(sessionId: str) -> list[dict[str, object]]:
    """Get all bridges for a session."""
    bridges = get_memory(_BRIDGEKey) or {}
    if not isinstance(bridges, dict):
        return []
    return [as_dict(item) for item in as_list(bridges.get(sessionId))]


def findRelatedSessions(sessionId: str, topic: str = '') -> list[dict[str, object]]:
    """Find sessions related to the given one."""
    related = []
    for b in getSessionBridges(sessionId):
        related.append({'id': b['targetId'], 'reason': b.get('reason', 'bridged'), 'score': 1.0})
    if topic:
        topicSessions = search_memory(f'session_topic:{topic}')
        for s in topicSessions:
            sid = s.get('key', '')
            if sid != sessionId and (not any((r['id'] == sid for r in related))):
                related.append({'id': sid, 'reason': 'same_topic', 'score': 0.8})
    return related
