"""
Cross-session bridge — links related sessions and provides continuity.

Port of backend/services/memory/cross-session-bridge.js.
"""
from __future__ import annotations
from typing import Any
from app.services.memoryStore import saveMemory, getMemory, searchMemory, indexSessionTopic
_BRIDGEKey = 'session_bridges'

def bridgeSessions(sourceId: str, targetId: str, reason: str='related') -> None:
    """Create a bridge between two sessions."""
    bridges = getMemory(_BRIDGEKey) or {}
    if not isinstance(bridges, dict):
        bridges = {}
    if sourceId not in bridges:
        bridges[sourceId] = []
    bridges[sourceId].append({'targetId': targetId, 'reason': reason, 'createdAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z'})
    saveMemory(_BRIDGEKey, bridges)

def getSessionBridges(sessionId: str) -> list[dict[str, Any]]:
    """Get all bridges for a session."""
    bridges = getMemory(_BRIDGEKey) or {}
    if not isinstance(bridges, dict):
        return []
    return bridges.get(sessionId, [])

def findRelatedSessions(sessionId: str, topic: str='') -> list[dict[str, Any]]:
    """Find sessions related to the given one."""
    related = []
    for b in getSessionBridges(sessionId):
        related.append({'id': b['targetId'], 'reason': b.get('reason', 'bridged'), 'score': 1.0})
    if topic:
        topicSessions = searchMemory(f'session_topic:{topic}')
        for s in topicSessions:
            sid = s.get('key', '')
            if sid != sessionId and (not any((r['id'] == sid for r in related))):
                related.append({'id': sid, 'reason': 'same_topic', 'score': 0.8})
    return related