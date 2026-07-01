"""
Tool failure memory — records and surfaces tool execution failures.

Port of backend/services/memory/tool-failure-memory.js.
"""
from __future__ import annotations
import json
from app.services.memoryStore import saveMemory, getMemory
_FAILURESKey = 'tool_failures'

def recordToolFailure(info: dict[str, object]) -> None:
    """Record a tool failure in memory."""
    failures = getMemory(_FAILURESKey) or []
    if not isinstance(failures, list):
        failures = []
    failures.append({'toolName': info.get('toolName', ''), 'args': info.get('args'), 'error': str(info.get('error', '')), 'phase': info.get('phase', ''), 'timestamp': __import__('datetime').datetime.utcnow().isoformat() + 'Z'})
    failures = failures[-50:]
    saveMemory(_FAILURESKey, failures)

def recallToolFailures(toolName: str, limit: int=5) -> list[dict[str, object]]:
    """Get recent failures for a specific tool."""
    failures = getMemory(_FAILURESKey) or []
    if not isinstance(failures, list):
        return []
    return [f for f in failures if f.get('toolName') == toolName][:limit]

def formatFailureHints(toolName: str) -> str:
    """Format failure history as hints for the model."""
    failures = recallToolFailures(toolName)
    if not failures:
        return ''
    hints = [f"Note: '{toolName}' has had {len(failures)} recent failure(s):"]
    for f in failures:
        hints.append(f"  - {f.get('error', 'unknown error')[:200]}")
    hints.append('Adjust parameters accordingly.')
    return '\n'.join(hints)