"""Feature Flow monitor API — inventory directory + SSE event stream.

Paths (handoff workstream):
  GET  /api/monitor/features       — Feature Inventory Directory
  GET  /api/monitor/events         — recent feature-flow events
  GET  /api/monitor/events/stream  — SSE live tail
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from app.services.feature_flow import feature_flow_bus, list_feature_inventory

router = APIRouter(prefix='/api/monitor')


@router.get('/features')
async def get_feature_inventory():
    """Feature Inventory Directory for the Feature Flow UI."""
    return {'features': list_feature_inventory(), 'count': len(list_feature_inventory())}


@router.get('/events')
async def list_feature_flow_events(
    limit: int = Query(200, ge=1, le=500),
    feature: str | None = Query(None),
    status: str | None = Query(None),
):
    """Recent feature-flow events, newest first."""
    return feature_flow_bus.recent(limit=limit, feature=feature, status=status)


@router.get('/events/stream')
async def stream_feature_flow_events():
    """Server-Sent Events stream of feature-flow events as they fire."""

    async def event_gen():
        yield ': connected\n\n'
        async for entry in feature_flow_bus.stream():
            yield f'data: {json.dumps(entry)}\n\n'

    return StreamingResponse(
        event_gen(),
        media_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )
