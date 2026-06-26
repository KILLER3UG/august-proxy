"""Usage tracking API routes.

Port of backend/services/usage/ (4 files).
Uses memory_store for usage event persistence.
"""

from __future__ import annotations

from fastapi import APIRouter
from app.lib.camel_model import CamelModel

from app.services import memory_store

router = APIRouter(prefix="/api/usage")


class UsageRecord(CamelModel):
    session_id: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0


@router.post("")
async def record_usage(body: UsageRecord):
    """Record a usage event."""
    usage_id = memory_store.record_usage(body.session_id, body.model, body.input_tokens, body.output_tokens)
    return {"id": usage_id}


@router.get("/{session_id}")
async def get_session_usage(session_id: str):
    """Get aggregated usage for a session."""
    usage = memory_store.get_usage(session_id)
    return usage


@router.get("")
async def list_usage():
    """List all usage events (stub)."""
    return {"usage": [], "message": "Full usage listing requires phase 7 implementation"}
