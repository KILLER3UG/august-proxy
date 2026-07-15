"""Realtime UI event stream — single SSE channel for instant backend→frontend sync."""

from __future__ import annotations

import json

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from app.services.realtime_bus import realtime_bus

router = APIRouter(prefix='/api/realtime', tags=['realtime'])


@router.get('/stream')
async def realtime_stream():
    """Server-Sent Events stream of UI realtime events.

    Event payload shape::

        { "id": "...", "type": "session.deleted", "at": 1710000000000, ... }

    Known types (non-exhaustive):
      - session.created / session.updated / session.deleted / session.status
      - chat.active / chat.idle
      - invalidate  (queryKeys: string[])
      - keepalive
    """

    async def event_gen():
        yield ': connected\n\n'
        async for entry in realtime_bus.stream():
            if entry.get('type') == 'keepalive':
                yield ': keepalive\n\n'
                continue
            yield f'data: {json.dumps(entry, default=str)}\n\n'

    return StreamingResponse(
        event_gen(),
        media_type='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    )


@router.get('/recent')
async def realtime_recent(limit: int = 50, type: str | None = None):
    """Recent realtime events (debug / reconnect catch-up)."""
    return {'events': realtime_bus.recent(limit=limit, event_type=type)}
