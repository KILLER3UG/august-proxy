"""
v4.3 — Brain Activity API: recent + SSE stream of brain events.

The feed is in-memory (Brain Event Bus) — what you'd see in a real-time
window into the brain.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from app.services.brain_event_bus import brain_bus

router = APIRouter(prefix="/api/brain")


@router.get("/events")
async def list_brain_events(
    limit: int = Query(200, ge=1, le=200),
    category: str | None = Query(None),
):
    """Recent brain events, newest first, optionally filtered by category."""
    return brain_bus.recent(limit=limit, category=category)


@router.get("/events/stream")
async def stream_brain_events():
    """Server-Sent Events stream of new brain events as they fire."""

    async def event_gen():
        # Initial comment keeps the connection alive past proxies that
        # buffer SSE up until the first byte.
        yield ": connected\n\n"
        async for entry in brain_bus.stream():
            yield f"data: {json.dumps(entry)}\n\n"

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx buffering
        },
    )
