"""SSE line formatting helpers for proxy adapters.

Extracted from ``stream_state`` so stream accumulators stay focused on
state machines while wire formatting lives in one small module.
"""

from __future__ import annotations

import json
from typing import Any


def write_sse_event(event: str, data: dict[str, Any]) -> str:
    """Serialize an Anthropic-style SSE event line."""
    return f'event: {event}\ndata: {json.dumps(data)}\n\n'


def write_sse_data_only(data: dict[str, Any]) -> str:
    """Serialize a data-only SSE line (event line omitted)."""
    return f'data: {json.dumps(data)}\n\n'
