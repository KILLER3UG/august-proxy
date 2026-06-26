"""
Monitoring & debug endpoints — activity, requests, stats, host-agent health.

Port of inline Node.js routes from backend/index.js and
backend/lib/logger.js. All are read-only; no data mutations.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.services.logger import (
    get_activity_log,
    get_pending_requests,
    get_filtered_requests,
    get_stats as get_usage_stats,
    get_request_detail as get_req_detail,
)
from app.services.host_agent import get_host_info

router = APIRouter(prefix="/api")


# ── Activity log ───────────────────────────────────────────────────────


@router.get("/activity")
async def get_activity():
    """Return recent activity log entries."""
    return {"entries": get_activity_log()}


# ── Request tracking ───────────────────────────────────────────────────


@router.get("/requests")
async def get_requests(
    status: str = Query(default="all", alias="status"),
    period: str = Query(default="all", alias="period"),
):
    """Return tracked API requests.

    - status=all    → all requests
    - status=pending → only pending (in-flight) requests
    - status=completed → only completed requests
    """
    pending = get_pending_requests()
    log = get_filtered_requests(period)

    if status == "pending":
        return {"requests": pending}
    if status == "completed":
        return {"requests": [e for e in log if e.get("status") == "completed"]}

    return {"requests": pending + log}


@router.get("/requests/{request_id}")
async def get_request_detail(request_id: str):
    """Return detailed info for a specific request."""
    detail = get_req_detail(request_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Request not found")
    return detail


# ── Usage stats ────────────────────────────────────────────────────────


@router.get("/stats")
async def get_stats(period: str = Query(default="all", alias="period")):
    """Return aggregate usage statistics."""
    return get_usage_stats(period)


# ── Host agent health ──────────────────────────────────────────────────


@router.get("/host-agent/health")
async def host_agent_health():
    """Return host agent availability and health status."""
    return await get_host_info()
