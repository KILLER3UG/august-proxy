"""Audit log API routes.

Port of backend/services/audit/audit-log.js.
Uses memory_store lifecycle events for persistence.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.services import memory_store

router = APIRouter(prefix="/api/audit")


@router.get("")
async def list_audit_log(session_id: str = "", event_type: str = "", limit: int = 100):
    """List audit log entries."""
    if session_id:
        events = memory_store.list_lifecycle(session_id, event_type, limit)
    else:
        events = memory_store.list_lifecycle("", event_type, limit)
    return {"events": events}


@router.get("/stats")
async def audit_stats():
    """Get audit statistics."""
    stats = memory_store.get_stats()
    return {
        "total_events": stats.get("lifecycle", 0),
        "total_sessions": stats.get("sessions", 0),
    }
