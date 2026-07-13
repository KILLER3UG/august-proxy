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
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Callable, cast
from app.json_narrowing import as_dict, as_int, as_list, as_str
from app.atomic_write import write_json_atomic
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
        self._entries: deque[dict[str, object]] = deque(maxlen=MAX_ACTIVITY_LOG)
        self._subscribers: list[Callable[[dict[str, object]], None]] = []

    def append(self, type: str, detail: str) -> dict[str, object]:
        entry: dict[str, object] = {
            'id': str(uuid.uuid4()),
            'type': type,
            'detail': detail,
            'timestamp': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        }
        self._entries.appendleft(entry)
        self._broadcast(entry)
        return entry

    def get(self) -> list[dict[str, object]]:
        return list(self._entries)

    def subscribe(self, callback: Callable[[dict[str, object]], None]) -> Callable[[], None]:
        self._subscribers.append(callback)

        def unsubscribe() -> None:
            if callback in self._subscribers:
                self._subscribers.remove(callback)

        return unsubscribe

    def _broadcast(self, entry: dict[str, object]) -> None:
        for cb in self._subscribers:
            try:
                cb(entry)
            except Exception:
                pass


activityLog = ActivityLog()


def logActivity(type: str, detail: str) -> None:
    """Append an activity log entry."""
    activityLog.append(type, detail)


def getActivityLog() -> list[dict[str, object]]:
    return activityLog.get()


class RequestTracker:
    """Tracks API requests, responses, tokens, and errors."""

    def __init__(self) -> None:
        self._pending: dict[str, dict[str, object]] = {}
        self._log: deque[dict[str, object]] = deque(maxlen=MAX_REQUEST_LOG)
        self._details: dict[str, dict[str, object]] = {}
        self._sseClients: list[object] = []
        self._wsClients: list[object] = []
        self._logEvents: deque[dict[str, object]] = deque(maxlen=MAX_LOG_EVENTS)

    def startRequest(self, info: dict[str, object]) -> str:
        """Register a pending request. Returns the request ID."""
        reqId = str(uuid.uuid4())
        self._pending[reqId] = {'id': reqId, 'startedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'), **info}
        self._cleanupStale()
        return reqId

    def endRequest(self, reqId: str, result: dict[str, object]) -> dict[str, object] | None:
        """Finalize a request."""
        pending = self._pending.pop(reqId, None)
        if not pending:
            return None
        entry = self._finalize(reqId, pending, result)
        self._log.appendleft(entry)
        self._broadcastSse(entry)
        self._persist()
        return entry

    def captureRequest(self, reqId: str, body: object, metadata: dict[str, object] | None = None) -> None:
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

    def capture_response(self, reqId: str, responseData: dict[str, object]) -> None:
        """Store the response body with token/usage extraction."""
        detail = self._details.get(reqId)
        if not detail:
            detail = {}
            self._details[reqId] = detail
        detail['response'] = self._sanitize(responseData)
        usage = as_dict(responseData.get('usage'), {})
        if usage:
            detail['inputTokens'] = as_int(usage.get('prompt_tokens')) or as_int(usage.get('input_tokens'))
            detail['outputTokens'] = as_int(usage.get('completion_tokens')) or as_int(usage.get('output_tokens'))
        choices = as_list(responseData.get('choices'), [])
        if choices:
            choice = as_dict(choices[0])
            detail['finishReason'] = as_str(choice.get('finish_reason'), '')
            message = as_dict(choice.get('message')) or as_dict(choice.get('delta'))
            if as_str(message.get('content')):
                detail['responseContent'] = str(message['content'])[:500]
            if as_list(message.get('tool_calls'), []):
                detail['toolCalls'] = len(as_list(message.get('tool_calls'), []))

    def capture_tokens(self, reqId: str, inputTokens: int, outputTokens: int) -> None:
        """Push token counts into an existing detail entry."""
        detail = self._details.get(reqId)
        if not detail:
            detail = {}
            self._details[reqId] = detail
        detail['inputTokens'] = as_int(detail.get('inputTokens')) + inputTokens
        detail['outputTokens'] = as_int(detail.get('outputTokens')) + outputTokens

    def capture_error(self, reqId: str, error: str) -> None:
        """Set error on a request detail."""
        detail = self._details.get(reqId)
        if not detail:
            detail = {}
            self._details[reqId] = detail
        detail['error'] = str(error)[:500]

    def getPending(self) -> list[dict[str, object]]:
        self._cleanupStale()
        return [
            {**v, 'elapsed': int((time.time() - _parseTimestamp(as_str(v.get('startedAt')))) * 1000)}
            for v in self._pending.values()
        ]

    def getLog(self) -> list[dict[str, object]]:
        self._cleanupStale()
        return list(self._log)

    def getFiltered(self, period: str = 'all') -> list[dict[str, object]]:
        """Filter request log by time period."""
        cutoff = _periodCutoff(period)
        if cutoff is None:
            return list(self._log)
        return [e for e in self._log if _parseTimestamp(as_str(e.get('startedAt'), '')) >= cutoff]

    def get_stats(self, period: str = 'all') -> dict[str, object]:
        """Compute aggregate stats from the request log."""
        entries = self.getFiltered(period)
        total = len(entries)
        completed = sum((1 for e in entries if as_str(e.get('status')) == 'completed'))
        errors = sum((1 for e in entries if as_str(e.get('status')) == 'error'))
        totalInput = sum((as_int(e.get('inputTokens')) for e in entries))
        totalOutput = sum((as_int(e.get('outputTokens')) for e in entries))
        models: dict[str, int] = {}
        for e in entries:
            m = as_str(e.get('model'), 'unknown')
            models[m] = models.get(m, 0) + 1
        inputCost = totalInput / 1000000 * 3.0
        outputCost = totalOutput / 1000000 * 15.0
        return {
            'totalRequests': total,
            'completed': completed,
            'errors': errors,
            'totalInputTokens': totalInput,
            'totalOutputTokens': totalOutput,
            'estimatedCost': round(inputCost + outputCost, 4),
            'mostUsedModel': max(models, key=lambda k: models.get(k, 0)) if models else 'none',
            'modelBreakdown': models,
            'averageDuration': 0,
        }

    def getRequestDetails(self, period: str = 'all') -> list[dict[str, object]]:
        """Return stored request details."""
        cutoff = _periodCutoff(period)
        if cutoff is None:
            return list(self._details.values())
        return [v for v in self._details.values() if _parseTimestamp(as_str(v.get('startedAt'), '')) >= cutoff]

    def getRequestDetail(self, reqId: str) -> dict[str, object] | None:
        return self._details.get(reqId)

    def addSseClient(self, client: object) -> None:
        self._sseClients.append(client)

    def removeSseClient(self, client: object) -> None:
        if client in self._sseClients:
            self._sseClients.remove(client)

    def addWsClient(self, ws: object) -> None:
        self._wsClients.append(ws)

    def removeWsClient(self, ws: object) -> None:
        if ws in self._wsClients:
            self._wsClients.remove(ws)

    def emitLogEvent(self, event: dict[str, object]) -> None:
        """Create a log event and broadcast to WS clients (thread-safe).

        Delegates to the log-stream hub, which keeps a newest-first ring
        buffer and fans out to live WebSocket clients from the asyncio
        event loop. The default category is ``info`` (not ``general``) so
        events are visible under the default filter set.
        """
        from app.services import log_stream

        event = dict(event)
        if not as_str(event.get('category')):
            event['category'] = 'info'
        log_stream.emitLogEvent(event)

    def getRecentLogEvents(self, limit: int = 100) -> list[dict[str, object]]:
        from app.services import log_stream

        return log_stream.getRecentLogEvents(limit)

    def _finalize(self, reqId: str, pending: dict[str, object], result: dict[str, object]) -> dict[str, object]:
        """Build the final request log entry."""
        usage = as_dict(result.get('usage'), {})
        detail = self._details.pop(reqId, {})
        return {
            'id': reqId,
            'startedAt': as_str(pending.get('startedAt'), ''),
            'completedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'status': 'error' if as_str(result.get('error')) else 'completed',
            'model': as_str(pending.get('model'), ''),
            'provider': as_str(pending.get('provider'), ''),
            'inputTokens': as_int(usage.get('prompt_tokens'))
            or as_int(usage.get('input_tokens'))
            or as_int(detail.get('inputTokens')),
            'outputTokens': as_int(usage.get('completion_tokens'))
            or as_int(usage.get('output_tokens'))
            or as_int(detail.get('outputTokens')),
            'error': as_str(result.get('error')) or as_str(detail.get('error')),
            'method': as_str(pending.get('method'), 'POST'),
            'path': as_str(pending.get('path'), ''),
            'sessionId': as_str(result.get('sessionId')) or as_str(pending.get('sessionId'), ''),
            **detail,
        }

    def _cleanupStale(self, timeoutS: int = 600) -> None:
        """Remove pending requests older than timeout."""
        now = time.time()
        stale = [
            rid for rid, v in self._pending.items() if now - _parseTimestamp(as_str(v.get('startedAt'), '')) > timeoutS
        ]
        for rid in stale:
            del self._pending[rid]

    def _broadcastSse(self, entry: dict[str, object]) -> None:
        for client in list(self._sseClients):
            try:
                cast('Callable[[dict[str, object]], None]', client)({'type': 'request_log', 'data': entry})
            except Exception:
                self._sseClients.remove(client)

    def _persist(self) -> None:
        """Persist request log to disk."""
        try:
            path = dataPath(REQUEST_LOG_FILE)
            path.parent.mkdir(parents=True, exist_ok=True)
            write_json_atomic(path, list(self._log)[:100], indent=2, default=str)
        except Exception:
            pass

    def _sanitize(self, data: object) -> object:
        """Redact API keys from stored data."""
        if isinstance(data, dict):
            return {k: self._sanitize(v) for k, v in data.items() if k != 'apiKey'}
        if isinstance(data, list):
            return [self._sanitize(v) for v in data]
        return data


_tracker = RequestTracker()


def startRequest(info: dict[str, object]) -> str:
    return _tracker.startRequest(info)


def endRequest(reqId: str, result: dict[str, object]) -> dict[str, object] | None:
    return _tracker.endRequest(reqId, result)


def captureRequest(reqId: str, body: object, metadata: dict[str, object] | None = None) -> None:
    _tracker.captureRequest(reqId, body, metadata)


def capture_response(reqId: str, responseData: dict[str, object]) -> None:
    _tracker.capture_response(reqId, responseData)


def capture_tokens(reqId: str, inputTokens: int, outputTokens: int) -> None:
    _tracker.capture_tokens(reqId, inputTokens, outputTokens)


def capture_error(reqId: str, error: str) -> None:
    _tracker.capture_error(reqId, error)


def getPendingRequests() -> list[dict[str, object]]:
    return _tracker.getPending()


def getRequestLog() -> list[dict[str, object]]:
    return _tracker.getLog()


def getFilteredRequests(period: str = 'all') -> list[dict[str, object]]:
    return _tracker.getFiltered(period)


def get_stats(period: str = 'all') -> dict[str, object]:
    return _tracker.get_stats(period)


def getRequestDetails(period: str = 'all') -> list[dict[str, object]]:
    return _tracker.getRequestDetails(period)


def getRequestDetail(reqId: str) -> dict[str, object] | None:
    return _tracker.getRequestDetail(reqId)


def addSseClient(client: object) -> None:
    _tracker.addSseClient(client)


def removeSseClient(client: object) -> None:
    _tracker.removeSseClient(client)


def addLogWsClient(ws: object) -> None:
    from app.services import log_stream

    log_stream.addLogWsClient(ws)


def removeLogWsClient(ws: object) -> None:
    from app.services import log_stream

    log_stream.removeLogWsClient(ws)


def emitLogEvent(event: dict[str, object]) -> None:
    _tracker.emitLogEvent(event)


def getRecentLogEvents(limit: int = 100) -> list[dict[str, object]]:
    return _tracker.getRecentLogEvents(limit)


def extractSessionId(body: dict[str, object]) -> str:
    """Extract a session ID from a request body."""
    for key in ('sessionId', 'session_id', 'x-session-id'):
        val = as_str(body.get(key), '')
        if val:
            return val
    return ''


def resolveSessionId(body: dict[str, object], metadata: dict[str, object] | None = None) -> str:
    """Resolve final session ID with priority: metadata > body > synthetic."""
    if metadata:
        sid = as_str(metadata.get('sessionId')) or as_str(metadata.get('session_id'))
        if sid:
            return sid
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
