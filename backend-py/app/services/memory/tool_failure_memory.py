"""
Tool failure memory — records and surfaces tool execution failures.

Port of backend/services/memory/tool-failure-memory.js.
"""

from __future__ import annotations

import json
from typing import Any

from app.services.memory_store import save_memory, get_memory

_FAILURES_KEY = "tool_failures"


def record_tool_failure(info: dict[str, Any]) -> None:
    """Record a tool failure in memory."""
    failures = get_memory(_FAILURES_KEY) or []
    if not isinstance(failures, list):
        failures = []
    failures.append({
        "toolName": info.get("toolName", ""),
        "args": info.get("args"),
        "error": str(info.get("error", "")),
        "phase": info.get("phase", ""),
        "timestamp": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    })
    # Keep last 50
    failures = failures[-50:]
    save_memory(_FAILURES_KEY, failures)


def recall_tool_failures(tool_name: str, limit: int = 5) -> list[dict[str, Any]]:
    """Get recent failures for a specific tool."""
    failures = get_memory(_FAILURES_KEY) or []
    if not isinstance(failures, list):
        return []
    return [f for f in failures if f.get("toolName") == tool_name][:limit]


def format_failure_hints(tool_name: str) -> str:
    """Format failure history as hints for the model."""
    failures = recall_tool_failures(tool_name)
    if not failures:
        return ""
    hints = [f"Note: '{tool_name}' has had {len(failures)} recent failure(s):"]
    for f in failures:
        hints.append(f"  - {f.get('error', 'unknown error')[:200]}")
    hints.append("Adjust parameters accordingly.")
    return "\n".join(hints)
