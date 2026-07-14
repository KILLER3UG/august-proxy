"""Feature Flow event bus — live pipeline stages for the Feature Flow UI.

Mirrors ``brain_event_bus``: in-memory ring buffer + SSE fan-out. Events
describe high-level feature execution (proxy hop, tool call, memory write)
so the desktop can animate traces and highlight errors in real time.

NOT persisted. For durable audit use request logs / brain tables.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections import deque
from typing import AsyncIterator

_MAX_EVENTS = 500

# Static inventory — Feature Inventory Summary from the handoff / Phase 7 matrix.
FEATURE_INVENTORY: list[dict[str, object]] = [
    {
        'id': 'proxy',
        'name': 'Multi-provider proxy',
        'description': 'Anthropic/OpenAI translation, providers, alias routing, fallback',
        'stages': ['start', 'route', 'translate', 'upstream', 'stream', 'end'],
    },
    {
        'id': 'memory',
        'name': 'Memory & learning',
        'description': 'Memory store, auto-memory, consolidation, daemons, FTS',
        'stages': ['start', 'read', 'write', 'index', 'end'],
    },
    {
        'id': 'tools',
        'name': 'Tools',
        'description': 'Workbench and proxy-managed tools across categories',
        'stages': ['start', 'dispatch', 'exec', 'result', 'end'],
    },
    {
        'id': 'cognitive',
        'name': 'Cognitive architecture',
        'description': 'Model roles, task policies, fleet, subagents',
        'stages': ['start', 'plan', 'delegate', 'verify', 'end'],
    },
    {
        'id': 'gateway',
        'name': 'Gateway platforms',
        'description': 'Telegram / Slack / Discord session bridge',
        'stages': ['start', 'inbound', 'workbench', 'outbound', 'end'],
    },
    {
        'id': 'skills',
        'name': 'Skills system',
        'description': 'Skill catalogue, curator lifecycle, progressive disclosure',
        'stages': ['start', 'load', 'apply', 'end'],
    },
    {
        'id': 'security',
        'name': 'Security & safety',
        'description': 'Allow-lists, SSRF guards, CORS, secrets redaction',
        'stages': ['check', 'allow', 'deny', 'end'],
    },
    {
        'id': 'workbench',
        'name': 'Workbench chat',
        'description': 'Desktop chat SSE loop, prompt build, tool rounds, persist',
        'stages': ['start', 'prompt', 'llm', 'tools', 'persist', 'end'],
    },
]

_FEATURE_IDS = {str(f['id']) for f in FEATURE_INVENTORY}


class FeatureFlowBus:
    """In-memory ring buffer of feature-flow events with SSE fan-out."""

    def __init__(self) -> None:
        self._events: deque[dict[str, object]] = deque(maxlen=_MAX_EVENTS)
        self._subscribers: list[asyncio.Queue] = []

    def emit(
        self,
        *,
        feature: str,
        stage: str,
        summary: str,
        status: str = 'ok',
        trace_id: str | None = None,
        error: str | None = None,
        duration_ms: float | None = None,
        meta: dict[str, object] | None = None,
    ) -> dict[str, object]:
        entry: dict[str, object] = {
            'id': uuid.uuid4().hex,
            'traceId': trace_id or uuid.uuid4().hex[:12],
            'feature': feature if feature in _FEATURE_IDS else feature,
            'stage': stage,
            'status': status,  # running | ok | error
            'summary': summary,
            'error': error,
            'durationMs': duration_ms,
            'meta': dict(meta) if meta else {},
            'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        }
        self._events.appendleft(entry)
        dead: list[asyncio.Queue] = []
        for q in list(self._subscribers):
            try:
                q.put_nowait(entry)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self._unsubscribe(q)
        # Also mirror into Backend Monitor log stream for operators who only open that panel.
        try:
            from app.services import log_stream

            level = 'error' if status == 'error' or error else 'info'
            log_stream.emitLogEvent(
                {
                    'category': 'feature_flow',
                    'level': level,
                    'message': f'[{feature}/{stage}] {summary}',
                    'metadata': {
                        'traceId': entry['traceId'],
                        'feature': feature,
                        'stage': stage,
                        'status': status,
                        'error': error,
                        'durationMs': duration_ms,
                        **(meta or {}),
                    },
                }
            )
        except Exception:
            pass
        return entry

    def recent(
        self,
        limit: int = 100,
        feature: str | None = None,
        status: str | None = None,
    ) -> list[dict[str, object]]:
        items = list(self._events)
        if feature:
            items = [e for e in items if e.get('feature') == feature]
        if status:
            items = [e for e in items if e.get('status') == status]
        return items[: max(0, limit)]

    def _subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._subscribers.append(q)
        return q

    def _unsubscribe(self, q: asyncio.Queue) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    async def stream(self) -> AsyncIterator[dict[str, object]]:
        q = self._subscribe()
        try:
            while True:
                entry = await q.get()
                yield entry
        finally:
            self._unsubscribe(q)


feature_flow_bus = FeatureFlowBus()


def emit_feature_flow(
    *,
    feature: str,
    stage: str,
    summary: str,
    status: str = 'ok',
    trace_id: str | None = None,
    error: str | None = None,
    duration_ms: float | None = None,
    meta: dict[str, object] | None = None,
) -> dict[str, object]:
    """Publish a feature-flow event. Failures are swallowed."""
    try:
        return feature_flow_bus.emit(
            feature=feature,
            stage=stage,
            summary=summary,
            status=status,
            trace_id=trace_id,
            error=error,
            duration_ms=duration_ms,
            meta=meta,
        )
    except Exception:
        import logging

        logging.getLogger(__name__).exception('emit_feature_flow failed')
        return {}


def list_feature_inventory() -> list[dict[str, object]]:
    """Return the static Feature Inventory Directory catalogue."""
    return list(FEATURE_INVENTORY)
