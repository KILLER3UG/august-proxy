"""
v4.3 — Brain Activity API: recent + SSE stream of brain events.

The feed is in-memory (Brain Event Bus) — what you'd see in a real-time
window into the brain.
"""

from __future__ import annotations
import json
from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse
from app.services.brain_event_bus import brainBus

router = APIRouter(prefix='/api/brain')


@router.get('/events')
async def listBrainEvents(limit: int = Query(200, ge=1, le=200), category: str | None = Query(None)):
    """Recent brain events, newest first, optionally filtered by category."""
    return brainBus.recent(limit=limit, category=category)


@router.get('/events/stream')
async def streamBrainEvents():
    """Server-Sent Events stream of new brain events as they fire."""

    async def eventGen():
        yield ': connected\n\n'
        async for entry in brainBus.stream():
            yield f'data: {json.dumps(entry)}\n\n'

    return StreamingResponse(
        eventGen(), media_type='text/event-stream', headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'}
    )
