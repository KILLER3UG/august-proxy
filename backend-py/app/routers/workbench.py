"""
Workbench chat routes — POST to start, GET SSE stream.

Port of the Express routes from the JS backend. Uses the workbench
service for session management and chat loop.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app.services import event_log
from app.services.workbench import workbench as wb

router = APIRouter(prefix="/api/workbench")


# ── Session management ───────────────────────────────────────────────


@router.post("/sessions")
async def create_session(request: Request):
    """Create a new workbench session."""
    body = await request.json() if request.headers.get("content-type") else {}
    session = wb.create_workbench_session(
        provider=body.get("provider", ""),
        agent_id=body.get("agentId", ""),
        guard_mode=body.get("guardMode", ""),
        task=body.get("task", ""),
        goal=body.get("goal", ""),
    )
    return session.to_dict()


@router.get("/sessions")
async def list_sessions():
    """List all workbench sessions."""
    return wb.list_workbench_sessions()


@router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """Get a session by ID."""
    session = wb.get_workbench_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session.to_dict()


# Frontend also calls /api/workbench/session?sessionId=X (singular)
@router.get("/session")
async def get_session_by_query(sessionId: str = ""):
    """Get a session by ID from query parameter."""
    if not sessionId:
        raise HTTPException(status_code=400, detail="sessionId required")
    session = wb.get_workbench_session(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session.to_dict()


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a session."""
    if not wb.delete_workbench_session(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": "ok"}


@router.post("/sessions/{session_id}/reset")
async def reset_session(session_id: str, request: Request):
    """Reset a session (delete and recreate)."""
    body = await request.json() if request.headers.get("content-type") else {}
    session = wb.reset_workbench_session(
        session_id,
        provider=body.get("provider", ""),
        agent_id=body.get("agentId", ""),
    )
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session.to_dict()


@router.get("/sessions/{session_id}/status")
async def session_status(session_id: str):
    """Get session status (for approval banner)."""
    status = wb.get_workbench_session_status(session_id)
    if not status:
        raise HTTPException(status_code=404, detail="Session not found")
    return status


# ── Chat ─────────────────────────────────────────────────────────────


@router.post("/chat")
async def start_chat(request: Request):
    """Start a chat generation.

    Returns sessionId immediately; actual events stream through the
    SSE endpoint using the event log.
    """
    body = await request.json()
    session_id = body.get("sessionId", str(uuid.uuid4()))
    message = body.get("message", "")
    provider = body.get("provider", "")
    agent_id = body.get("agentId", "")
    effort = body.get("effort", "")
    model = body.get("model", "")
    model_provider = body.get("modelProvider", "")
    guard_mode = body.get("guardMode", "")

    # Start the chat loop in the background
    seq = event_log.event_log.append(session_id, "started", {"sinceSeq": 0})

    # Launch workbench chat loop in background task
    asyncio.create_task(
        wb.send_workbench_message_stream(
            session_id=session_id,
            message=message,
            provider=provider,
            agent_id=agent_id,
            effort=effort,
            model=model,
            model_provider=model_provider,
            guard_mode=guard_mode,
            emit=lambda event: event_log.event_log.append(
                session_id, event.get("type", "message"), event
            ),
        )
    )

    return {
        "status": "started",
        "sessionId": session_id,
        "sinceSeq": seq,
    }


@router.get("/chat/stream")
async def stream_chat(
    session_id: str = Query(""),
    since_seq_raw: str = Query(default="0", alias="sinceSeq"),
):
    """SSE stream for chat events."""
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
    # TODO: implement abort via cancellation token
    body = await request.json()
    session_id = body.get("sessionId", "")
    event_log.event_log.append(session_id, "aborted", {})
    return {"status": "ok"}


@router.get("/chat/active")
async def active_chats():
    """List active status for all sessions."""
    activity = wb.get_workbench_activity()
    return activity


# ── Plans ────────────────────────────────────────────────────────────


@router.post("/plan")
async def submit_plan_route(request: Request):
    """Submit a plan for a session."""
    body = await request.json()
    session_id = body.get("sessionId", "")
    plan_data = body.get("plan", {})
    session = wb.get_workbench_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    wb.submit_plan(session, plan_data)
    return {"status": "ok"}


@router.post("/plan/approve")
async def approve_plan(session_id: str = Query("")):
    """Approve a pending plan."""
    if not wb.approve_workbench_plan(session_id):
        raise HTTPException(status_code=404, detail="Session not found or no plan pending")
    return {"status": "approved"}


@router.post("/plan/reject")
async def reject_plan(session_id: str = Query("")):
    """Reject a pending plan."""
    if not wb.reject_workbench_plan(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": "rejected"}


# ── Mutations / approval ─────────────────────────────────────────────


@router.post("/mutations/respond")
async def respond_mutation(request: Request):
    """Respond to a pending mutation (approve/reject)."""
    body = await request.json()
    token = body.get("token", "")
    reject = body.get("reject", False)
    if not wb.consume_pending_mutation(token, reject=reject):
        raise HTTPException(status_code=404, detail="Mutation token not found")
    return {"status": "consumed"}


# ── Goals ────────────────────────────────────────────────────────────


@router.post("/goal")
async def update_goal(request: Request):
    """Set/clear/status for goals."""
    body = await request.json()
    session_id = body.get("sessionId", "")
    action = body.get("action", "status")
    condition = body.get("condition", "")
    result = wb.update_workbench_goal(session_id, action, condition)
    if result is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return result


# ── Activity / capabilities ──────────────────────────────────────────


@router.get("/activity")
async def workbench_activity():
    """Return recent workbench activity."""
    return wb.get_workbench_activity()


@router.get("/capabilities")
async def proxy_capabilities():
    """List all tools grouped by source."""
    return wb.list_proxy_capabilities()
