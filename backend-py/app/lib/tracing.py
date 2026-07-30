"""Request tracing — structured timing for /v1/ proxy requests.

Part of Better Harness Plan Phase 6.4.
Records timing waterfall per request in a ring buffer.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field

_RING_SIZE = 100


@dataclass
class RequestTrace:
    request_id: str
    method: str
    path: str
    provider: str | None = None
    model: str | None = None
    route_resolve_ms: float = 0.0
    provider_connect_ms: float = 0.0
    first_token_ms: float = 0.0
    total_ms: float = 0.0
    status_code: int = 0
    started_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            'requestId': self.request_id,
            'method': self.method,
            'path': self.path,
            'provider': self.provider,
            'model': self.model,
            'timing': {
                'routeResolveMs': round(self.route_resolve_ms, 1),
                'providerConnectMs': round(self.provider_connect_ms, 1),
                'firstTokenMs': round(self.first_token_ms, 1),
                'totalMs': round(self.total_ms, 1),
            },
            'statusCode': self.status_code,
            'startedAt': self.started_at,
        }


class TraceBuffer:
    """Ring buffer for recent request traces."""

    def __init__(self, maxlen: int = _RING_SIZE) -> None:
        self._traces: deque[RequestTrace] = deque(maxlen=maxlen)

    def record(self, trace: RequestTrace) -> None:
        self._traces.append(trace)

    def get_recent(self, limit: int = 20) -> list[dict]:
        """Get most recent traces (newest first)."""
        items = list(self._traces)[-limit:]
        return [t.to_dict() for t in reversed(items)]

    def get_stats(self) -> dict:
        """Aggregate stats from buffered traces."""
        if not self._traces:
            return {'count': 0, 'avgTotalMs': 0, 'avgFirstTokenMs': 0, 'p95TotalMs': 0}

        totals = sorted(t.total_ms for t in self._traces if t.total_ms > 0)
        first_tokens = sorted(t.first_token_ms for t in self._traces if t.first_token_ms > 0)

        return {
            'count': len(self._traces),
            'avgTotalMs': round(sum(totals) / len(totals), 1) if totals else 0,
            'avgFirstTokenMs': round(sum(first_tokens) / len(first_tokens), 1) if first_tokens else 0,
            'p95TotalMs': round(totals[int(len(totals) * 0.95)] if totals else 0, 1),
        }


# Module-level singleton
trace_buffer = TraceBuffer()
