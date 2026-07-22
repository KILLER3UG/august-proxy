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

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect

from app.json_narrowing import as_dict, as_int
from app.services.host_agent import getHostInfo
from app.services.logger import (
    addLogWsClient,
    getActivityLog,
    getFilteredRequests,
    getPendingRequests,
    getRecentLogEvents,
    getRequestDetails,
    removeLogWsClient,
)
from app.services.logger import (
    get_stats as getUsageStats,
)
from app.services.logger import (
    getRequestDetail as getReqDetail,
)
from app.services.logger_conversations import getConversations

router = APIRouter(prefix='/api')


@router.get('/perf/recent')
async def getRecentPerfTraces(limit: int = Query(default=20, ge=1, le=64)):
    """Recent workbench performance traces (when ``AUGUST_PERF_TIMING=1``).

    Debug/measurement only. Empty list if no traces were recorded.
    """
    from app.lib.perf_timing import recent_traces

    traces = recent_traces(limit)
    return {'traces': traces, 'count': len(traces)}


@router.get('/perf/db-writer')
async def getDbWriterStats():
    """FIFO write-queue lag / drop counters (measurement only)."""
    from app.services import db_writer

    return db_writer.get_stats()


@router.get('/activity')
async def getActivity():
    """Return recent activity log entries as a bare array.

    Node returns getActivityLog() directly (a JSON array). The frontend's
    getActivity() expects ActivityEntry[] — a wrapper object here would
    crash the renderer (see module docstring). Normalize entries so each
    has the { time, type, detail } fields the UI reads.
    """
    entries = getActivityLog() or []
    out: list[dict[str, object]] = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        out.append(
            {
                'time': e.get('time') or e.get('timestamp') or '',
                'type': e.get('type') or '',
                'detail': e.get('detail') or '',
            }
        )
    return out


@router.get('/requests')
async def getRequests(
    status: str = Query(default='all', alias='status'), period: str = Query(default='all', alias='period')
):
    """Return tracked API requests in the Node.js contract shape.

    Node returns { pending: [...], completed: [...] }. The frontend's
    RequestsResponse reads .pending and .completed directly; the previous
    { requests: [...] } wrapper made both undefined.
    """
    pending = _normRequests(getPendingRequests())
    log = _normRequests(getFilteredRequests(period))
    if status == 'pending':
        return {'pending': pending, 'completed': []}
    if status == 'completed':
        return {'pending': [], 'completed': [e for e in log if e.get('status') == 'completed']}
    return {'pending': pending, 'completed': log}


@router.get('/requests/{request_id}')
async def getRequestDetail(request_id: str):
    """Return detailed info for a specific request."""
    detail = getReqDetail(request_id)
    if not detail:
        raise HTTPException(status_code=404, detail='Request not found')
    return detail


@router.get('/stats')
async def get_stats(period: str = Query(default='all', alias='period')):
    """Return aggregate usage statistics in the Node.js StatsResponse shape.

    The Python logger returns a partial object (completed/errors/etc); the
    frontend's StatsResponse expects totalRequests, completedRequests,
    errorRequests, totalInputTokens, totalOutputTokens, totalTokens,
    estimatedInputCost/estimatedOutputCost/estimatedTotalCost, avgDurationMs,
    pendingRequests, mostUsedModel, mostUsedCount, modelBreakdown, and
    profileStats. Fill any missing fields so the UI never reads undefined.
    """
    raw = getUsageStats(period) or {}
    return _stats(raw, len(getPendingRequests() or []))


@router.get('/details')
async def getDetails(period: str = Query(default='all', alias='period')):
    """Return request detail entries as a bare array (Node contract)."""
    return getRequestDetails(period) or []


@router.get('/detail/{request_id}')
async def getSingleDetail(request_id: str):
    """Return detailed info for a specific request, or 404."""
    detail = getReqDetail(request_id)
    if not detail:
        raise HTTPException(status_code=404, detail='Request not found')
    return detail


@router.get('/conversations')
async def getConversationsEndpoint(period: str = Query(default='all', alias='period')):
    """Return conversations grouped by clientType (Node contract)."""
    return getConversations(period)


@router.get('/logs/recent')
async def getRecentLogs(limit: int = Query(default=200, ge=1, le=2000)):
    """Return recent log events — { events: [...], count: int } (Node contract)."""
    events = getRecentLogEvents(limit) or []
    return {'events': events, 'count': len(events)}


@router.get('/host-agent/health')
async def hostAgentHealth():
    """Return host agent availability and health status."""
    return await getHostInfo()


def _normRequests(entries: list[dict[str, object]] | None) -> list[dict[str, object]]:
    """Normalize a request-log entry list to the frontend's RequestEntry shape.

    The Python tracker stores fields under different names than Node
    (id vs reqId, startedAt vs time/timestamp, provider vs clientType).
    Map them so the UI's toRow() and table renderers read defined values.
    """
    if not entries:
        return []
    out: list[dict[str, object]] = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        started = e.get('startedAt') or e.get('time') or e.get('timestamp')
        out.append(
            {
                'reqId': e.get('reqId') or e.get('id') or '',
                'clientType': e.get('clientType') or e.get('provider') or 'unknown',
                'endpoint': e.get('endpoint') or e.get('path') or '',
                'model': e.get('model') or 'unknown',
                'status': e.get('status') or 'unknown',
                'durationMs': e.get('durationMs') or e.get('duration') or 0,
                'inputTokens': e.get('inputTokens') or 0,
                'outputTokens': e.get('outputTokens') or 0,
                'totalCost': e.get('totalCost') or e.get('estimatedCost') or 0.0,
                'timestamp': started or '',
                'time': started or '',
                'date': started or '',
                'error': e.get('error'),
                **{
                    k: v
                    for k, v in e.items()
                    if k
                    not in {
                        'id',
                        'reqId',
                        'clientType',
                        'provider',
                        'endpoint',
                        'path',
                        'model',
                        'status',
                        'durationMs',
                        'duration',
                        'inputTokens',
                        'outputTokens',
                        'totalCost',
                        'estimatedCost',
                        'startedAt',
                        'time',
                        'timestamp',
                        'date',
                        'error',
                    }
                },
            }
        )
    return out


def _stats(raw: dict[str, object], pendingCount: int) -> dict[str, object]:
    """Coerce the logger's partial stats into the full StatsResponse shape."""
    total = raw.get('totalRequests', 0)
    completed = raw.get('completed', raw.get('completedRequests', 0))
    errors = raw.get('errors', raw.get('errorRequests', 0))
    totalIn = as_int(raw.get('totalInputTokens', 0))
    totalOut = as_int(raw.get('totalOutputTokens', 0))
    modelBreakdown = as_dict(raw.get('modelBreakdown'))
    estIn = raw.get('estimatedInputCost')
    estOut = raw.get('estimatedOutputCost')
    estTotal = raw.get('estimatedTotalCost')
    if estTotal is None:
        estTotal = raw.get('estimatedCost', 0.0)
        if estIn is None:
            estIn = 0.0
        if estOut is None:
            estOut = estTotal
    mbFull: dict[str, dict[str, int]] = {}
    for m, v in modelBreakdown.items():
        count = v if isinstance(v, int) else as_int(v.get('requests')) if isinstance(v, dict) else 0
        mbFull[m] = {
            'requests': count,
            'inputTokens': as_int(v.get('inputTokens', 0)) if isinstance(v, dict) else 0,
            'outputTokens': as_int(v.get('outputTokens', 0)) if isinstance(v, dict) else 0,
            'totalTokens': as_int(v.get('totalTokens', 0)) if isinstance(v, dict) else 0,
        }
    mostUsed = raw.get('mostUsedModel')
    mostUsedCount = raw.get('mostUsedCount')
    if mostUsed is None or mostUsed == 'none':
        mostUsed = None
        mostUsedCount = 0
    return {
        'totalRequests': total,
        'completedRequests': completed,
        'errorRequests': errors,
        'totalInputTokens': totalIn,
        'totalOutputTokens': totalOut,
        'totalTokens': totalIn + totalOut,
        'estimatedInputCost': estIn or 0.0,
        'estimatedOutputCost': estOut or 0.0,
        'estimatedTotalCost': estTotal or 0.0,
        'avgDurationMs': raw.get('avgDurationMs', raw.get('averageDuration', 0)),
        'pendingRequests': pendingCount,
        'mostUsedModel': mostUsed,
        'mostUsedCount': mostUsedCount or 0,
        'modelBreakdown': mbFull,
        'profileStats': raw.get('profileStats') or {},
    }


@router.websocket('/logs/stream')
async def logsStream(websocket: WebSocket):
    """Live backend log event stream (newest-first snapshot + live frames).

    Final path: ``/api/logs/stream`` (router prefix ``/api`` + this route).
    On connect we send a ``{type: 'snapshot', events: [...]}`` frame with
    the most recent buffered events, then register the socket for live frames.
    """
    await websocket.accept()
    try:
        recent = getRecentLogEvents(500) or []
        await websocket.send_json({'type': 'snapshot', 'events': recent})
    except Exception:
        pass
    addLogWsClient(websocket)
    try:
        while True:
            # Client may send pings; we only need to detect disconnect.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        removeLogWsClient(websocket)
