"""
Workbench chat routes — POST to start, GET SSE stream.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.services import event_log

router = APIRouter(prefix="/ui/workbench")

# In-memory active generations
_active: dict[str, dict[str, Any]] = {}


@router.post("/chat")
async def start_chat(request: Request):
    """Start a chat generation. Returns sinceSeq immediately; events stream."""
    body = await request.json()
    session_id = body.get("sessionId", str(uuid.uuid4()))

    # Emit started event
    seq = event_log.event_log.append(session_id, "started", {"sinceSeq": 0})

    # Track active generation
    _active[session_id] = {"status": "streaming"}

    return {
        "status": "started",
        "sessionId": session_id,
        "sinceSeq": seq,
    }


@router.get("/chat/stream")
async def stream_chat(request: Request):
    """SSE stream for chat events."""
    session_id = request.query_params.get("sessionId", "")
    since_seq_raw = request.query_params.get("sinceSeq")
    since_seq = int(since_seq_raw) if since_seq_raw and since_seq_raw.isdigit() else 0

    async def generate():
        async for event in event_log.event_log.subscribe(session_id, since_seq):
            yield f"event: {event['type']}\ndata: {json.dumps(event['payload'])}\nid: {event['seq']}\n\n"
            if event["type"] in ("done", "error", "aborted"):
                break

    return StreamingResponse(generate(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    })


@router.post("/chat/stop")
async def stop_chat(request: Request):
    """Abort a running generation."""
    body = await request.json()
    session_id = body.get("sessionId", "")
    gen = _active.get(session_id)
    if gen:
        gen["status"] = "aborted"
        event_log.event_log.append(session_id, "aborted", {})
    return {"status": "ok"}


@router.get("/chat/active")
async def active_chats():
    """List active generations."""
    return {sid: g["status"] for sid, g in _active.items() if g["status"] == "streaming"}
