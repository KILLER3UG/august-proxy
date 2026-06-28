"""Usage tracking API routes.

Port of backend/services/usage/ (4 files).
Uses memory_store for usage event persistence.

Route contract (matches the frontend's ``/api/usage/*`` calls):
  • POST   /api/usage                       — record a usage event
  • GET    /api/usage/session?id=<sessionId> — aggregated per-session usage
  • GET    /api/usage                       — list all usage events (stub)

Note: the per-session route is a literal ``/session`` path with an ``id`` query
param. A previous version used ``GET /api/usage/{session_id}`` (path param),
which the frontend never called (it requests ``/api/usage/session?id=``) and
which collided with the literal ``/session`` segment. The literal route is
declared first so FastAPI cannot shadow it.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.services import memory_store

router = APIRouter(prefix="/api/usage")


class UsageRecord(BaseModel):
    session_id: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    context_tokens: int = 0


@router.post("")
async def record_usage(body: UsageRecord):
    """Record a usage event."""
    usage_id = memory_store.record_usage(
        body.session_id,
        body.model,
        body.input_tokens,
        body.output_tokens,
        body.context_tokens,
    )
    return {"id": usage_id}


@router.get("/session")
async def get_session_usage(id: str = Query(..., description="Session id")):
    """Get aggregated usage for a session.

    Returns the full ``SessionUsage`` shape the frontend expects, including
    ``contextTokens`` — the provider-reported ``input_tokens`` of the most
    recent provider request (the true current context fill, counted once).
    """
    if not id:
        raise HTTPException(status_code=400, detail="Missing session id")
    return memory_store.get_usage(id)


@router.get("")
async def list_usage():
    """List all usage events (stub)."""
    return {"usage": [], "message": "Full usage listing requires phase 7 implementation"}
