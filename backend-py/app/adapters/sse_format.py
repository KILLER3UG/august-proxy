"""SSE line formatting helpers for proxy adapters.

Extracted from ``stream_state`` so stream accumulators stay focused on
state machines while wire formatting lives in one small module.
"""

from __future__ import annotations

import json
from typing import Any


def _clean_payload(data: dict[str, Any]) -> dict[str, Any]:
    """Drop internal bookkeeping keys that must never reach clients."""
    if '_event_type' in data:
        return {k: v for k, v in data.items() if k != '_event_type'}
    return data


def write_sse_event(event: str, data: dict[str, Any]) -> str:
    """Serialize an Anthropic-style SSE event line."""
    return f'event: {event}\ndata: {json.dumps(_clean_payload(data))}\n\n'


def write_sse_data_only(data: dict[str, Any]) -> str:
    """Serialize a data-only SSE line (event line omitted)."""
    return f'data: {json.dumps(_clean_payload(data))}\n\n'
