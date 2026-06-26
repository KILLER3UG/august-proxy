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

from app.lib.paths import data_path

# ── Configuration ────────────────────────────────────────────────────

MAX_ACTIVITY_LOG = 200
MAX_REQUEST_LOG = 1000
MAX_LOG_EVENTS = 5000
MAX_REQUEST_DETAILS = 100
ACTIVITY_LOG_FILE = "activity-log.json"
REQUEST_LOG_FILE = "request-log.json"

# ── Activity log ─────────────────────────────────────────────────────


class ActivityLog:
    """In-memory activity log with SSE broadcast."""

    def __init__(self) -> None:
        self._entries: deque[dict[str, Any]] = deque(maxlen=MAX_ACTIVITY_LOG)
        self._subscribers: list[Callable[[dict[str, Any]], None]] = []

    def append(self, type_: str, detail: str) -> dict[str, Any]:
        entry = {
            "id": str(uuid.uuid4()),
            "type": type_,
            "detail": detail,
            "timestamp": datetime.utcnow().isoformat() + "Z",
        }
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


activity_log = ActivityLog()


def log_activity(type_: str, detail: str) -> None:
    """Append an activity log entry."""
    activity_log.append(type_, detail)


def get_activity_log() -> list[dict[str, Any]]:
    return activity_log.get()


# ── Request tracking ─────────────────────────────────────────────────


class RequestTracker:
    """Tracks API requests, responses, tokens, and errors."""

    def __init__(self) -> None:
        self._pending: dict[str, dict[str, Any]] = {}
        self._log: deque[dict[str, Any]] = deque(maxlen=MAX_REQUEST_LOG)
        self._details: dict[str, dict[str, Any]] = {}
        self._sse_clients: list[Any] = []
        self._ws_clients: list[Any] = []
        self._log_events: deque[dict[str, Any]] = deque(maxlen=MAX_LOG_EVENTS)

    def start_request(self, info: dict[str, Any]) -> str:
        """Register a pending request. Returns the request ID."""
        req_id = str(uuid.uuid4())
        self._pending[req_id] = {
            "id": req_id,
            "startedAt": datetime.utcnow().isoformat() + "Z",
            **info,
        }
        self._cleanup_stale()
        return req_id

    def end_request(self, req_id: str, result: dict[str, Any]) -> dict[str, Any] | None:
        """Finalize a request."""
        pending = self._pending.pop(req_id, None)
        if not pending:
            return None

        entry = self._finalize(req_id, pending, result)
        self._log.appendleft(entry)
        self._broadcast_sse(entry)
        self._persist()
        return entry

    def capture_request(self, req_id: str, body: Any, metadata: dict[str, Any] | None = None) -> None:
        """Store the request body for debug inspection."""
        detail = self._details.get(req_id)
        if not detail:
            if len(self._details) >= MAX_REQUEST_DETAILS:
                oldest = next(iter(self._details))
                del self._details[oldest]
            detail = {}
            self._details[req_id] = detail
        detail["request"] = self._sanitize(body)
        if metadata:
            detail.update(metadata)

    def capture_response(self, req_id: str, response_data: dict[str, Any]) -> None:
        """Store the response body with token/usage extraction."""
        detail = self._details.get(req_id)
        if not detail:
            detail = {}
            self._details[req_id] = detail

        detail["response"] = self._sanitize(response_data)

        # Extract usage
        usage = response_data.get("usage", {})
        if usage:
            detail["inputTokens"] = usage.get("prompt_tokens") or usage.get("input_tokens", 0)
            detail["outputTokens"] = usage.get("completion_tokens") or usage.get("output_tokens", 0)

        # Extract finish reason
        choices = response_data.get("choices", [])
        if choices:
            detail["finishReason"] = choices[0].get("finish_reason", "")
            message = choices[0].get("message", {}) or choices[0].get("delta", {})
            if message.get("content"):
                detail["responseContent"] = str(message["content"])[:500]
            if message.get("tool_calls"):
                detail["toolCalls"] = len(message["tool_calls"])

    def capture_tokens(self, req_id: str, input_tokens: int, output_tokens: int) -> None:
        """Push token counts into an existing detail entry."""
        detail = self._details.get(req_id)
        if not detail:
            detail = {}
            self._details[req_id] = detail
        detail["inputTokens"] = detail.get("inputTokens", 0) + input_tokens
        detail["outputTokens"] = detail.get("outputTokens", 0) + output_tokens

    def capture_error(self, req_id: str, error: str) -> None:
        """Set error on a request detail."""
        detail = self._details.get(req_id)
        if not detail:
            detail = {}
            self._details[req_id] = detail
        detail["error"] = str(error)[:500]

    def get_pending(self) -> list[dict[str, Any]]:
        self._cleanup_stale()
        now = time.time()
        return [
            {**v, "elapsed": int((time.time() - _parse_timestamp(v["startedAt"])) * 1000)}
            for v in self._pending.values()
        ]

    def get_log(self) -> list[dict[str, Any]]:
        self._cleanup_stale()
        return list(self._log)

    def get_filtered(self, period: str = "all") -> list[dict[str, Any]]:
        """Filter request log by time period."""
        cutoff = _period_cutoff(period)
        if cutoff is None:
            return list(self._log)
        return [e for e in self._log if _parse_timestamp(e.get("startedAt", "")) >= cutoff]

    def get_stats(self, period: str = "all") -> dict[str, Any]:
        """Compute aggregate stats from the request log."""
        entries = self.get_filtered(period)
        total = len(entries)
        completed = sum(1 for e in entries if e.get("status") == "completed")
        errors = sum(1 for e in entries if e.get("status") == "error")
        total_input = sum(e.get("inputTokens", 0) for e in entries)
        total_output = sum(e.get("outputTokens", 0) for e in entries)

        models: dict[str, int] = {}
        for e in entries:
            m = e.get("model", "unknown")
            models[m] = models.get(m, 0) + 1

        # Cost estimation (rough)
        input_cost = (total_input / 1_000_000) * 3.0  # $3/M tokens
        output_cost = (total_output / 1_000_000) * 15.0  # $15/M tokens

        return {
            "totalRequests": total,
            "completed": completed,
            "errors": errors,
            "totalInputTokens": total_input,
            "totalOutputTokens": total_output,
            "estimatedCost": round(input_cost + output_cost, 4),
            "mostUsedModel": max(models, key=models.get) if models else "none",
            "modelBreakdown": models,
            "averageDuration": 0,
        }

    def get_request_details(self, period: str = "all") -> list[dict[str, Any]]:
        """Return stored request details."""
        cutoff = _period_cutoff(period)
        if cutoff is None:
            return list(self._details.values())
        return [
            v for v in self._details.values()
            if _parse_timestamp(v.get("startedAt", "")) >= cutoff
        ]

    def get_request_detail(self, req_id: str) -> dict[str, Any] | None:
        return self._details.get(req_id)

    # ── SSE client management ───────────────────────────────────────

    def add_sse_client(self, client: Any) -> None:
        self._sse_clients.append(client)

    def remove_sse_client(self, client: Any) -> None:
        if client in self._sse_clients:
            self._sse_clients.remove(client)

    # ── WebSocket client management ─────────────────────────────────

    def add_ws_client(self, ws: Any) -> None:
        self._ws_clients.append(ws)

    def remove_ws_client(self, ws: Any) -> None:
        if ws in self._ws_clients:
            self._ws_clients.remove(ws)

    def emit_log_event(self, event: dict[str, Any]) -> None:
        """Create a log event and broadcast to WS clients."""
        entry = {
            "id": str(uuid.uuid4()),
            "category": event.get("category", "general"),
            "level": event.get("level", "info"),
            "message": event.get("message", ""),
            "metadata": event.get("metadata"),
            "timestamp": datetime.utcnow().isoformat() + "Z",
        }
        self._log_events.append(entry)
        for ws in list(self._ws_clients):
            try:
                ws.send_json(entry)
            except Exception:
                self._ws_clients.remove(ws)

    def get_recent_log_events(self, limit: int = 100) -> list[dict[str, Any]]:
        return list(self._log_events)[:limit]

    # ── Internal ─────────────────────────────────────────────────────

    def _finalize(self, req_id: str, pending: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        """Build the final request log entry."""
        usage = result.get("usage", {})
        detail = self._details.pop(req_id, {})
        return {
            "id": req_id,
            "startedAt": pending.get("startedAt", ""),
            "completedAt": datetime.utcnow().isoformat() + "Z",
            "status": "error" if result.get("error") else "completed",
            "model": pending.get("model", ""),
            "provider": pending.get("provider", ""),
            "inputTokens": usage.get("prompt_tokens") or usage.get("input_tokens") or detail.get("inputTokens", 0),
            "outputTokens": usage.get("completion_tokens") or usage.get("output_tokens") or detail.get("outputTokens", 0),
            "error": result.get("error") or detail.get("error"),
            "method": pending.get("method", "POST"),
            "path": pending.get("path", ""),
            "sessionId": result.get("sessionId") or pending.get("sessionId", ""),
            **detail,
        }

    def _cleanup_stale(self, timeout_s: int = 600) -> None:
        """Remove pending requests older than timeout."""
        now = time.time()
        stale = [
            rid for rid, v in self._pending.items()
            if now - _parse_timestamp(v.get("startedAt", "")) > timeout_s
        ]
        for rid in stale:
            del self._pending[rid]

    def _broadcast_sse(self, entry: dict[str, Any]) -> None:
        for client in list(self._sse_clients):
            try:
                client({"type": "request_log", "data": entry})
            except Exception:
                self._sse_clients.remove(client)

    def _persist(self) -> None:
        """Persist request log to disk."""
        try:
            path = data_path(REQUEST_LOG_FILE)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps(list(self._log)[:100], indent=2, default=str),
                "utf-8",
            )
        except Exception:
            pass

    def _sanitize(self, data: Any) -> Any:
        """Redact API keys from stored data."""
        if isinstance(data, dict):
            return {k: self._sanitize(v) for k, v in data.items() if k != "apiKey"}
        if isinstance(data, list):
            return [self._sanitize(v) for v in data]
        return data


_tracker = RequestTracker()


# ── Public API ───────────────────────────────────────────────────────


def start_request(info: dict[str, Any]) -> str:
    return _tracker.start_request(info)


def end_request(req_id: str, result: dict[str, Any]) -> dict[str, Any] | None:
    return _tracker.end_request(req_id, result)


def capture_request(req_id: str, body: Any, metadata: dict[str, Any] | None = None) -> None:
    _tracker.capture_request(req_id, body, metadata)


def capture_response(req_id: str, response_data: dict[str, Any]) -> None:
    _tracker.capture_response(req_id, response_data)


def capture_tokens(req_id: str, input_tokens: int, output_tokens: int) -> None:
    _tracker.capture_tokens(req_id, input_tokens, output_tokens)


def capture_error(req_id: str, error: str) -> None:
    _tracker.capture_error(req_id, error)


def get_pending_requests() -> list[dict[str, Any]]:
    return _tracker.get_pending()


def get_request_log() -> list[dict[str, Any]]:
    return _tracker.get_log()


def get_filtered_requests(period: str = "all") -> list[dict[str, Any]]:
    return _tracker.get_filtered(period)


def get_stats(period: str = "all") -> dict[str, Any]:
    return _tracker.get_stats(period)


def get_request_details(period: str = "all") -> list[dict[str, Any]]:
    return _tracker.get_request_details(period)


def get_request_detail(req_id: str) -> dict[str, Any] | None:
    return _tracker.get_request_detail(req_id)


def add_sse_client(client: Any) -> None:
    _tracker.add_sse_client(client)


def remove_sse_client(client: Any) -> None:
    _tracker.remove_sse_client(client)


def add_log_ws_client(ws: Any) -> None:
    _tracker.add_ws_client(ws)


def remove_log_ws_client(ws: Any) -> None:
    _tracker.remove_ws_client(ws)


def emit_log_event(event: dict[str, Any]) -> None:
    _tracker.emit_log_event(event)


def get_recent_log_events(limit: int = 100) -> list[dict[str, Any]]:
    return _tracker.get_recent_log_events(limit)


# ── Helpers ──────────────────────────────────────────────────────────


def extract_session_id(body: dict[str, Any]) -> str:
    """Extract a session ID from a request body."""
    for key in ("sessionId", "session_id", "x-session-id"):
        val = body.get(key, "")
        if val:
            return str(val)
    return ""


def resolve_session_id(body: dict[str, Any], metadata: dict[str, Any] | None = None) -> str:
    """Resolve final session ID with priority: metadata > body > synthetic."""
    if metadata:
        sid = metadata.get("sessionId") or metadata.get("session_id")
        if sid:
            return str(sid)
    return extract_session_id(body) or _synthetic_session_id()


def _synthetic_session_id() -> str:
    return f"proxy:{uuid.uuid4().hex[:12]}"


def _parse_timestamp(ts: str) -> float:
    """Parse an ISO timestamp string to a Unix timestamp."""
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.timestamp()
    except (ValueError, AttributeError):
        return 0


def _period_cutoff(period: str) -> float | None:
    """Return the cutoff timestamp for a given period string."""
    if period == "all":
        return None
    now = time.time()
    periods = {
        "day": 86400,
        "week": 604800,
        "month": 2592000,
        "year": 31536000,
    }
    seconds = periods.get(period)
    if seconds:
        return now - seconds
    return None
