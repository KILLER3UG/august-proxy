"""
Activity logging, request tracking, and SSE/WebSocket broadcast.

Port of backend/lib/logger.js (820 lines).

Handles:
- Activity log with in-memory ring buffer + SSE broadcast
- Request tracking (start/end details, capture request/response/tokens)
- SSE client management for live log streaming
- WebSocket-based log event broadcast
- Usage extraction and cost estimation
- Conversation grouping
- Session ID resolution
"""
from __future__ import annotations
import asyncio
import json
import os
import time
import uuid
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from app.lib.paths import dataPath
MAX_ACTIVITY_LOG = 200
MAX_REQUEST_LOG = 1000
MAX_LOG_EVENTS = 5000
MAX_REQUEST_DETAILS = 100
ACTIVITY_LOG_FILE = 'activity-log.json'
REQUEST_LOG_FILE = 'request-log.json'

class ActivityLog:
    """In-memory activity log with SSE broadcast."""

    def __init__(self) -> None:
        self._entries: deque[dict[str, Any]] = deque(maxlen=MAX_ACTIVITY_LOG)
        self._subscribers: list[Callable[[dict[str, Any]], None]] = []

    def append(self, type: str, detail: str) -> dict[str, Any]:
        entry = {'id': str(uuid.uuid4()), 'type': type, 'detail': detail, 'timestamp': datetime.utcnow().isoformat() + 'Z'}
        self._entries.appendleft(entry)
        self._broadcast(entry)
        return entry

    def get(self) -> list[dict[str, Any]]:
        return list(self._entries)

    def subscribe(self, callback: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
        self._subscribers.append(callback)

        def unsubscribe() -> None:
            if callback in self._subscribers:
                self._subscribers.remove(callback)
        return unsubscribe

    def _broadcast(self, entry: dict[str, Any]) -> None:
        for cb in self._subscribers:
            try:
                cb(entry)
            except Exception:
                pass
activityLog = ActivityLog()

def logActivity(type: str, detail: str) -> None:
    """Append an activity log entry."""
    activityLog.append(type, detail)

def getActivityLog() -> list[dict[str, Any]]:
    return activityLog.get()

class RequestTracker:
    """Tracks API requests, responses, tokens, and errors."""

    def __init__(self) -> None:
        self._pending: dict[str, dict[str, Any]] = {}
        self._log: deque[dict[str, Any]] = deque(maxlen=MAX_REQUEST_LOG)
        self._details: dict[str, dict[str, Any]] = {}
        self._sseClients: list[Any] = []
        self._wsClients: list[Any] = []
        self._logEvents: deque[dict[str, Any]] = deque(maxlen=MAX_LOG_EVENTS)

    def startRequest(self, info: dict[str, Any]) -> str:
        """Register a pending request. Returns the request ID."""
        reqId = str(uuid.uuid4())
        self._pending[reqId] = {'id': reqId, 'startedAt': datetime.utcnow().isoformat() + 'Z', **info}
        self._cleanupStale()
        return reqId

    def endRequest(self, reqId: str, result: dict[str, Any]) -> dict[str, Any] | None:
        """Finalize a request."""
        pending = self._pending.pop(reqId, None)
        if not pending:
            return None
        entry = self._finalize(reqId, pending, result)
        self._log.appendleft(entry)
        self._broadcastSse(entry)
        self._persist()
        return entry

    def captureRequest(self, reqId: str, body: Any, metadata: dict[str, Any] | None=None) -> None:
        """Store the request body for debug inspection."""
        detail = self._details.get(reqId)
        if not detail:
            if len(self._details) >= MAX_REQUEST_DETAILS:
                oldest = next(iter(self._details))
                del self._details[oldest]
            detail = {}
            self._details[reqId] = detail
        detail['request'] = self._sanitize(body)
        if metadata:
            detail.update(metadata)

    def captureResponse(self, reqId: str, responseData: dict[str, Any]) -> None:
        """Store the response body with token/usage extraction."""
        detail = self._details.get(reqId)
        if not detail:
            detail = {}
            self._details[reqId] = detail
        detail['response'] = self._sanitize(responseData)
        usage = responseData.get('usage', {})
        if usage:
            detail['inputTokens'] = usage.get('prompt_tokens') or usage.get('input_tokens', 0)
            detail['outputTokens'] = usage.get('completion_tokens') or usage.get('output_tokens', 0)
        choices = responseData.get('choices', [])
        if choices:
            detail['finishReason'] = choices[0].get('finish_reason', '')
            message = choices[0].get('message', {}) or choices[0].get('delta', {})
            if message.get('content'):
                detail['responseContent'] = str(message['content'])[:500]
            if message.get('tool_calls'):
                detail['toolCalls'] = len(message['tool_calls'])

    def captureTokens(self, reqId: str, inputTokens: int, outputTokens: int) -> None:
        """Push token counts into an existing detail entry."""
        detail = self._details.get(reqId)
        if not detail:
            detail = {}
            self._details[reqId] = detail
        detail['inputTokens'] = detail.get('inputTokens', 0) + inputTokens
        detail['outputTokens'] = detail.get('outputTokens', 0) + outputTokens

    def captureError(self, reqId: str, error: str) -> None:
        """Set error on a request detail."""
        detail = self._details.get(reqId)
        if not detail:
            detail = {}
            self._details[reqId] = detail
        detail['error'] = str(error)[:500]

    def getPending(self) -> list[dict[str, Any]]:
        self._cleanupStale()
        now = time.time()
        return [{**v, 'elapsed': int((time.time() - _parseTimestamp(v['startedAt'])) * 1000)} for v in self._pending.values()]

    def getLog(self) -> list[dict[str, Any]]:
        self._cleanupStale()
        return list(self._log)

    def getFiltered(self, period: str='all') -> list[dict[str, Any]]:
        """Filter request log by time period."""
        cutoff = _periodCutoff(period)
        if cutoff is None:
            return list(self._log)
        return [e for e in self._log if _parseTimestamp(e.get('startedAt', '')) >= cutoff]

    def getStats(self, period: str='all') -> dict[str, Any]:
        """Compute aggregate stats from the request log."""
        entries = self.getFiltered(period)
        total = len(entries)
        completed = sum((1 for e in entries if e.get('status') == 'completed'))
        errors = sum((1 for e in entries if e.get('status') == 'error'))
        totalInput = sum((e.get('inputTokens', 0) for e in entries))
        totalOutput = sum((e.get('outputTokens', 0) for e in entries))
        models: dict[str, int] = {}
        for e in entries:
            m = e.get('model', 'unknown')
            models[m] = models.get(m, 0) + 1
        inputCost = totalInput / 1000000 * 3.0
        outputCost = totalOutput / 1000000 * 15.0
        return {'totalRequests': total, 'completed': completed, 'errors': errors, 'totalInputTokens': totalInput, 'totalOutputTokens': totalOutput, 'estimatedCost': round(inputCost + outputCost, 4), 'mostUsedModel': max(models, key=models.get) if models else 'none', 'modelBreakdown': models, 'averageDuration': 0}

    def getRequestDetails(self, period: str='all') -> list[dict[str, Any]]:
        """Return stored request details."""
        cutoff = _periodCutoff(period)
        if cutoff is None:
            return list(self._details.values())
        return [v for v in self._details.values() if _parseTimestamp(v.get('startedAt', '')) >= cutoff]

    def getRequestDetail(self, reqId: str) -> dict[str, Any] | None:
        return self._details.get(reqId)

    def addSseClient(self, client: Any) -> None:
        self._sseClients.append(client)

    def removeSseClient(self, client: Any) -> None:
        if client in self._sseClients:
            self._sseClients.remove(client)

    def addWsClient(self, ws: Any) -> None:
        self._wsClients.append(ws)

    def removeWsClient(self, ws: Any) -> None:
        if ws in self._wsClients:
            self._wsClients.remove(ws)

    def emitLogEvent(self, event: dict[str, Any]) -> None:
        """Create a log event and broadcast to WS clients."""
        entry = {'id': str(uuid.uuid4()), 'category': event.get('category', 'general'), 'level': event.get('level', 'info'), 'message': event.get('message', ''), 'metadata': event.get('metadata'), 'timestamp': datetime.utcnow().isoformat() + 'Z'}
        self._logEvents.append(entry)
        for ws in list(self._wsClients):
            try:
                ws.send_json(entry)
            except Exception:
                self._wsClients.remove(ws)

    def getRecentLogEvents(self, limit: int=100) -> list[dict[str, Any]]:
        return list(self._logEvents)[:limit]

    def _finalize(self, reqId: str, pending: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        """Build the final request log entry."""
        usage = result.get('usage', {})
        detail = self._details.pop(reqId, {})
        return {'id': reqId, 'startedAt': pending.get('startedAt', ''), 'completedAt': datetime.utcnow().isoformat() + 'Z', 'status': 'error' if result.get('error') else 'completed', 'model': pending.get('model', ''), 'provider': pending.get('provider', ''), 'inputTokens': usage.get('prompt_tokens') or usage.get('input_tokens') or detail.get('inputTokens', 0), 'outputTokens': usage.get('completion_tokens') or usage.get('output_tokens') or detail.get('outputTokens', 0), 'error': result.get('error') or detail.get('error'), 'method': pending.get('method', 'POST'), 'path': pending.get('path', ''), 'sessionId': result.get('sessionId') or pending.get('sessionId', ''), **detail}

    def _cleanupStale(self, timeoutS: int=600) -> None:
        """Remove pending requests older than timeout."""
        now = time.time()
        stale = [rid for rid, v in self._pending.items() if now - _parseTimestamp(v.get('startedAt', '')) > timeoutS]
        for rid in stale:
            del self._pending[rid]

    def _broadcastSse(self, entry: dict[str, Any]) -> None:
        for client in list(self._sseClients):
            try:
                client({'type': 'request_log', 'data': entry})
            except Exception:
                self._sseClients.remove(client)

    def _persist(self) -> None:
        """Persist request log to disk."""
        try:
            path = dataPath(REQUEST_LOG_FILE)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(list(self._log)[:100], indent=2, default=str), 'utf-8')
        except Exception:
            pass

    def _sanitize(self, data: Any) -> Any:
        """Redact API keys from stored data."""
        if isinstance(data, dict):
            return {k: self._sanitize(v) for k, v in data.items() if k != 'apiKey'}
        if isinstance(data, list):
            return [self._sanitize(v) for v in data]
        return data
_tracker = RequestTracker()

def startRequest(info: dict[str, Any]) -> str:
    return _tracker.start_request(info)

def endRequest(reqId: str, result: dict[str, Any]) -> dict[str, Any] | None:
    return _tracker.end_request(reqId, result)

def captureRequest(reqId: str, body: Any, metadata: dict[str, Any] | None=None) -> None:
    _tracker.capture_request(reqId, body, metadata)

def captureResponse(reqId: str, responseData: dict[str, Any]) -> None:
    _tracker.capture_response(reqId, responseData)

def captureTokens(reqId: str, inputTokens: int, outputTokens: int) -> None:
    _tracker.capture_tokens(reqId, inputTokens, outputTokens)

def captureError(reqId: str, error: str) -> None:
    _tracker.capture_error(reqId, error)

def getPendingRequests() -> list[dict[str, Any]]:
    return _tracker.get_pending()

def getRequestLog() -> list[dict[str, Any]]:
    return _tracker.get_log()

def getFilteredRequests(period: str='all') -> list[dict[str, Any]]:
    return _tracker.get_filtered(period)

def getStats(period: str='all') -> dict[str, Any]:
    return _tracker.get_stats(period)

def getRequestDetails(period: str='all') -> list[dict[str, Any]]:
    return _tracker.get_request_details(period)

def getRequestDetail(reqId: str) -> dict[str, Any] | None:
    return _tracker.get_request_detail(reqId)

def addSseClient(client: Any) -> None:
    _tracker.add_sse_client(client)

def removeSseClient(client: Any) -> None:
    _tracker.remove_sse_client(client)

def addLogWsClient(ws: Any) -> None:
    _tracker.add_ws_client(ws)

def removeLogWsClient(ws: Any) -> None:
    _tracker.remove_ws_client(ws)

def emitLogEvent(event: dict[str, Any]) -> None:
    _tracker.emit_log_event(event)

def getRecentLogEvents(limit: int=100) -> list[dict[str, Any]]:
    return _tracker.get_recent_log_events(limit)

def extractSessionId(body: dict[str, Any]) -> str:
    """Extract a session ID from a request body."""
    for key in ('sessionId', 'session_id', 'x-session-id'):
        val = body.get(key, '')
        if val:
            return str(val)
    return ''

def resolveSessionId(body: dict[str, Any], metadata: dict[str, Any] | None=None) -> str:
    """Resolve final session ID with priority: metadata > body > synthetic."""
    if metadata:
        sid = metadata.get('sessionId') or metadata.get('session_id')
        if sid:
            return str(sid)
    return extractSessionId(body) or _syntheticSessionId()

def _syntheticSessionId() -> str:
    return f'proxy:{uuid.uuid4().hex[:12]}'

def _parseTimestamp(ts: str) -> float:
    """Parse an ISO timestamp string to a Unix timestamp."""
    try:
        dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
        return dt.timestamp()
    except (ValueError, AttributeError):
        return 0

def _periodCutoff(period: str) -> float | None:
    """Return the cutoff timestamp for a given period string."""
    if period == 'all':
        return None
    now = time.time()
    periods = {'day': 86400, 'week': 604800, 'month': 2592000, 'year': 31536000}
    seconds = periods.get(period)
    if seconds:
        return now - seconds
    return None