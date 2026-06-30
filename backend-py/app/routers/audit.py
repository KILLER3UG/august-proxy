"""Audit log API routes.

Port of backend/services/audit/audit-log.js.
Uses memory_store lifecycle events for persistence.
"""
from __future__ import annotations
from fastapi import APIRouter
from app.services import memoryStore
router = APIRouter(prefix='/api/audit')

@router.get('')
async def listAuditLog(sessionId: str='', eventType: str='', limit: int=100):
    """List audit log entries."""
    if sessionId:
        events = memoryStore.list_lifecycle(sessionId, eventType, limit)
    else:
        events = memoryStore.list_lifecycle('', eventType, limit)
    return {'events': events}

@router.get('/stats')
async def auditStats():
    """Get audit statistics."""
    stats = memoryStore.get_stats()
    return {'total_events': stats.get('lifecycle', 0), 'total_sessions': stats.get('sessions', 0)}