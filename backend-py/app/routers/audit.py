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
        events = memoryStore.listLifecycle(sessionId, eventType, limit)
    else:
        events = memoryStore.listLifecycle('', eventType, limit)
    return {'events': events}

@router.get('/stats')
async def auditStats():
    """Get audit statistics."""
    stats = memoryStore.getStats()
    return {'totalEvents': stats.get('lifecycle', 0), 'totalSessions': stats.get('sessions', 0)}