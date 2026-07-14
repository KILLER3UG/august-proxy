"""P0 performance timing — measurement only, no behaviour change.

Enable recording with env ``AUGUST_PERF_TIMING=1`` (or force=True in tests).
Traces accumulate spans (prompt_build, llm_wait, tool_exec, sse_emit proxy,
persist) and TTFT (time from trace start to first content emit).

Ring buffer of recent traces is available for tests / debug dumps.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Iterator

logger = logging.getLogger(__name__)

_RING_MAX = 64
_ring: list[dict[str, Any]] = []
_ring_lock = threading.Lock()
_current: ContextVar[PerfTrace | None] = ContextVar('perf_trace', default=None)


def _env_enabled() -> bool:
    v = os.environ.get('AUGUST_PERF_TIMING', '').strip().lower()
    return v in ('1', 'true', 'yes', 'on')


@dataclass
class Span:
    name: str
    start: float
    end: float | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def ms(self) -> float:
        if self.end is None:
            return (time.perf_counter() - self.start) * 1000.0
        return (self.end - self.start) * 1000.0


@dataclass
class PerfTrace:
    """One request/turn timing record."""

    name: str
    force: bool = False
    t0: float = field(default_factory=time.perf_counter)
    spans: list[Span] = field(default_factory=list)
    ttft_ms: float | None = None
    meta: dict[str, Any] = field(default_factory=dict)
    _enabled: bool = field(default=False, repr=False)

    def __post_init__(self) -> None:
        self._enabled = self.force or _env_enabled()

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def total_ms(self) -> float:
        return (time.perf_counter() - self.t0) * 1000.0

    def mark_ttft(self) -> None:
        if not self._enabled:
            return
        if self.ttft_ms is None:
            self.ttft_ms = (time.perf_counter() - self.t0) * 1000.0

    @contextmanager
    def span(self, name: str, **meta: Any) -> Iterator[Span]:
        if not self._enabled:
            yield Span(name=name, start=time.perf_counter(), meta=meta)
            return
        sp = Span(name=name, start=time.perf_counter(), meta=dict(meta))
        self.spans.append(sp)
        try:
            yield sp
        finally:
            sp.end = time.perf_counter()

    def summary(self) -> dict[str, Any]:
        by_name: dict[str, list[float]] = {}
        for sp in self.spans:
            by_name.setdefault(sp.name, []).append(sp.ms)
        totals = {
            name: {
                'count': len(vals),
                'sum_ms': round(sum(vals), 3),
                'max_ms': round(max(vals), 3),
                'min_ms': round(min(vals), 3),
            }
            for name, vals in by_name.items()
        }
        return {
            'name': self.name,
            'total_ms': round(self.total_ms, 3),
            'ttft_ms': round(self.ttft_ms, 3) if self.ttft_ms is not None else None,
            'spans': totals,
            'meta': dict(self.meta),
        }

    def finish(self) -> dict[str, Any]:
        summary = self.summary()
        if self._enabled:
            with _ring_lock:
                _ring.append(summary)
                if len(_ring) > _RING_MAX:
                    del _ring[: len(_ring) - _RING_MAX]
            logger.info(
                'perf_trace name=%s total_ms=%.1f ttft_ms=%s spans=%s',
                self.name,
                summary['total_ms'],
                summary['ttft_ms'],
                {k: v['sum_ms'] for k, v in summary['spans'].items()},
            )
        return summary


def start_trace(name: str, *, force: bool = False, **meta: Any) -> PerfTrace:
    """Start a trace and install it as the current contextvar."""
    tr = PerfTrace(name=name, force=force, meta=dict(meta))
    _current.set(tr)
    return tr


def current_trace() -> PerfTrace | None:
    return _current.get()


def clear_current() -> None:
    _current.set(None)


def recent_traces(limit: int = 20) -> list[dict[str, Any]]:
    with _ring_lock:
        return list(_ring[-limit:])


def clear_traces() -> None:
    with _ring_lock:
        _ring.clear()


def percentile(values: list[float], p: float) -> float:
    """Nearest-rank percentile; values must be non-empty."""
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    k = (len(ordered) - 1) * (p / 100.0)
    f = int(k)
    c = min(f + 1, len(ordered) - 1)
    if f == c:
        return ordered[f]
    return ordered[f] + (ordered[c] - ordered[f]) * (k - f)


def aggregate_summaries(summaries: list[dict[str, Any]]) -> dict[str, Any]:
    """p50/p95 for total_ms, ttft_ms, and per-span sum_ms across runs."""
    totals = [float(s['total_ms']) for s in summaries]
    ttfts = [float(s['ttft_ms']) for s in summaries if s.get('ttft_ms') is not None]
    span_names: set[str] = set()
    for s in summaries:
        span_names.update((s.get('spans') or {}).keys())
    span_stats: dict[str, Any] = {}
    for name in sorted(span_names):
        vals = [
            float(s['spans'][name]['sum_ms'])
            for s in summaries
            if name in (s.get('spans') or {})
        ]
        if vals:
            span_stats[name] = {
                'p50_ms': round(percentile(vals, 50), 3),
                'p95_ms': round(percentile(vals, 95), 3),
                'n': len(vals),
            }
    return {
        'n': len(summaries),
        'total_ms': {
            'p50': round(percentile(totals, 50), 3) if totals else None,
            'p95': round(percentile(totals, 95), 3) if totals else None,
        },
        'ttft_ms': {
            'p50': round(percentile(ttfts, 50), 3) if ttfts else None,
            'p95': round(percentile(ttfts, 95), 3) if ttfts else None,
        },
        'spans': span_stats,
    }
