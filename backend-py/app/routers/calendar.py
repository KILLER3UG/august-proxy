"""
Calendar API — internal events (August tasks, reminders, scheduled chats).
External calendar events are fetched via MCP tools on the frontend side.

Spec: docs/superpowers/specs/2026-06-30-voice-subagent-provider-overhaul-design.md
"""
from __future__ import annotations
from fastapi import APIRouter
router = APIRouter(prefix='/api/calendar')

@router.get('/internal')
async def listInternalEvents():
    """Return August internal events (tasks, reminders, scheduled chats).

    Currently returns an empty list because no event/reminder store exists yet.
    Future: query memory_store tables for tasks, reminders, and scheduled sessions.

    Shape returned per event:
    {
      id: str,
      title: str,
      date: str (ISO 8601 date),
      kind: 'task' | 'reminder' | 'scheduled_chat',
      source: 'internal'
    }
    """
    return {'events': []}