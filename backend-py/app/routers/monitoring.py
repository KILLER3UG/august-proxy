"""
Monitoring & debug endpoints — activity, requests, stats, host-agent health.

Port of inline Node.js routes from backend/index.js and backend/lib/logger.js.
All are read-only; no data mutations.

Response shapes MUST match what the Node.js backend returned, because the
frontend (api-client.ts) was built against those shapes and the
useTrafficActivity hook iterates over them directly. The previous version
returned wrapper objects ({ entries: [...] }, { requests: [...] }) which are
truthy non-arrays — they bypassed the hook's `?? []` null-guard and threw
"activity is not iterable", crashing the Observability section (black screen).

Canonical shapes (from backend/index.js):
  /api/activity      → bare array of { time, type, detail }
  /api/requests      → { pending: [...], completed: [...] }
  /api/stats         → StatsResponse object (see _stats)
  /api/details       → bare array
  /api/detail/{id}   → object or 404
  /api/conversations → Record<clientType, entries[]>
  /api/logs/recent   → { events: [...], count: int }

Note: /api/health is owned by app/main.py (the single source of truth).
An earlier @router.get("/health") here collided with it (first-match-wins
dropped the `python` field); it was removed.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.services.logger import (
    get_activity_log,
    get_pending_requests,
    get_filtered_requests,
    get_stats as get_usage_stats,
    get_request_details,
    get_request_detail as get_req_detail,
    get_recent_log_events,
)
from app.services.logger_conversations import get_conversations
from app.services.host_agent import get_host_info

router = APIRouter(prefix="/api")


# ── Activity log ───────────────────────────────────────────────────────


@router.get("/activity")
async def get_activity():
    """Return recent activity log entries as a bare array.

    Node returns getActivityLog() directly (a JSON array). The frontend's
    getActivity() expects ActivityEntry[] — a wrapper object here would
    crash the renderer (see module docstring). Normalize entries so each
    has the { time, type, detail } fields the UI reads.
    """
    entries = get_activity_log() or []
    out: list[dict[str, Any]] = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        out.append({
            "time": e.get("time") or e.get("timestamp") or "",
            "type": e.get("type") or "",
            "detail": e.get("detail") or "",
        })
    return out


# ── Request tracking ───────────────────────────────────────────────────


@router.get("/requests")
async def get_requests(
    status: str = Query(default="all", alias="status"),
    period: str = Query(default="all", alias="period"),
):
    """Return tracked API requests in the Node.js contract shape.

    Node returns { pending: [...], completed: [...] }. The frontend's
    RequestsResponse reads .pending and .completed directly; the previous
    { requests: [...] } wrapper made both undefined.
    """
    pending = _norm_requests(get_pending_requests())
    log = _norm_requests(get_filtered_requests(period))

    if status == "pending":
        return {"pending": pending, "completed": []}
    if status == "completed":
        return {"pending": [], "completed": [e for e in log if e.get("status") == "completed"]}

    return {"pending": pending, "completed": log}


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
    """Return aggregate usage statistics in the Node.js StatsResponse shape.

    The Python logger returns a partial object (completed/errors/etc); the
    frontend's StatsResponse expects totalRequests, completedRequests,
    errorRequests, totalInputTokens, totalOutputTokens, totalTokens,
    estimatedInputCost/estimatedOutputCost/estimatedTotalCost, avgDurationMs,
    pendingRequests, mostUsedModel, mostUsedCount, modelBreakdown, and
    profileStats. Fill any missing fields so the UI never reads undefined.
    """
    raw = get_usage_stats(period) or {}
    return _stats(raw, len(get_pending_requests() or []))


# ── Request details ────────────────────────────────────────────────────


@router.get("/details")
async def get_details(period: str = Query(default="all", alias="period")):
    """Return request detail entries as a bare array (Node contract)."""
    return get_request_details(period) or []


@router.get("/detail/{request_id}")
async def get_single_detail(request_id: str):
    """Return detailed info for a specific request, or 404."""
    detail = get_req_detail(request_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Request not found")
    return detail


# ── Conversations ──────────────────────────────────────────────────────


@router.get("/conversations")
async def get_conversations_endpoint(period: str = Query(default="all", alias="period")):
    """Return conversations grouped by clientType (Node contract)."""
    return get_conversations(period)


# ── Recent logs ────────────────────────────────────────────────────────


@router.get("/logs/recent")
async def get_recent_logs(limit: int = Query(default=200, ge=1, le=2000)):
    """Return recent log events — { events: [...], count: int } (Node contract)."""
    events = get_recent_log_events(limit) or []
    return {"events": events, "count": len(events)}


# ── Host agent health ──────────────────────────────────────────────────


@router.get("/host-agent/health")
async def host_agent_health():
    """Return host agent availability and health status."""
    return await get_host_info()


# ── Helpers ────────────────────────────────────────────────────────────


def _norm_requests(entries: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Normalize a request-log entry list to the frontend's RequestEntry shape.

    The Python tracker stores fields under different names than Node
    (id vs reqId, startedAt vs time/timestamp, provider vs clientType).
    Map them so the UI's toRow() and table renderers read defined values.
    """
    if not entries:
        return []
    out: list[dict[str, Any]] = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        started = e.get("startedAt") or e.get("time") or e.get("timestamp")
        out.append({
            "reqId": e.get("reqId") or e.get("id") or "",
            "clientType": e.get("clientType") or e.get("provider") or "unknown",
            "endpoint": e.get("endpoint") or e.get("path") or "",
            "model": e.get("model") or "unknown",
            "status": e.get("status") or "unknown",
            "durationMs": e.get("durationMs") or e.get("duration") or 0,
            "inputTokens": e.get("inputTokens") or 0,
            "outputTokens": e.get("outputTokens") or 0,
            "totalCost": e.get("totalCost") or e.get("estimatedCost") or 0.0,
            "timestamp": started or "",
            "time": started or "",
            "date": started or "",
            "error": e.get("error"),
            # Preserve any extra fields the tracker attached (sessionId, etc.)
            **{k: v for k, v in e.items() if k not in {
                "id", "reqId", "clientType", "provider", "endpoint", "path",
                "model", "status", "durationMs", "duration", "inputTokens",
                "outputTokens", "totalCost", "estimatedCost", "startedAt",
                "time", "timestamp", "date", "error",
            }},
        })
    return out


def _stats(raw: dict[str, Any], pending_count: int) -> dict[str, Any]:
    """Coerce the logger's partial stats into the full StatsResponse shape."""
    total = raw.get("totalRequests", 0)
    completed = raw.get("completed", raw.get("completedRequests", 0))
    errors = raw.get("errors", raw.get("errorRequests", 0))
    total_in = raw.get("totalInputTokens", 0)
    total_out = raw.get("totalOutputTokens", 0)
    model_breakdown = raw.get("modelBreakdown") or {}

    # Cost: prefer already-computed fields, else fall back to the rough estimate
    # the logger produces under `estimatedCost`.
    est_in = raw.get("estimatedInputCost")
    est_out = raw.get("estimatedOutputCost")
    est_total = raw.get("estimatedTotalCost")
    if est_total is None:
        est_total = raw.get("estimatedCost", 0.0)
        if est_in is None:
            est_in = 0.0
        if est_out is None:
            est_out = est_total

    # modelBreakdown in Python is { model: count }; the UI wants richer objects.
    mb_full: dict[str, dict[str, int]] = {}
    for m, v in model_breakdown.items():
        count = v if isinstance(v, int) else (v.get("requests") if isinstance(v, dict) else 0)
        mb_full[m] = {
            "requests": count,
            "inputTokens": v.get("inputTokens", 0) if isinstance(v, dict) else 0,
            "outputTokens": v.get("outputTokens", 0) if isinstance(v, dict) else 0,
            "totalTokens": v.get("totalTokens", 0) if isinstance(v, dict) else 0,
        }

    # mostUsedModel/mostUsedCount
    most_used = raw.get("mostUsedModel")
    most_used_count = raw.get("mostUsedCount")
    if most_used is None or most_used == "none":
        most_used = None
        most_used_count = 0

    return {
        "totalRequests": total,
        "completedRequests": completed,
        "errorRequests": errors,
        "totalInputTokens": total_in,
        "totalOutputTokens": total_out,
        "totalTokens": total_in + total_out,
        "estimatedInputCost": est_in or 0.0,
        "estimatedOutputCost": est_out or 0.0,
        "estimatedTotalCost": est_total or 0.0,
        "avgDurationMs": raw.get("avgDurationMs", raw.get("averageDuration", 0)),
        "pendingRequests": pending_count,
        "mostUsedModel": most_used,
        "mostUsedCount": most_used_count or 0,
        "modelBreakdown": mb_full,
        "profileStats": raw.get("profileStats") or {},
    }
