"""
Tool failure memory — records and surfaces tool execution failures.

Port of backend/services/memory/tool-failure-memory.js.
"""

from __future__ import annotations
from app.jsonUtils import as_str, as_dict
from datetime import datetime, timezone
from app.services.memory_store import saveMemory, getMemory

_FAILURESKey = 'tool_failures'


def recordToolFailure(info: dict[str, object]) -> None:
    """Record a tool failure in memory."""
    failures = getMemory(_FAILURESKey) or []
    if not isinstance(failures, list):
        failures = []
    failures.append(
        {
            'toolName': as_str(info.get('toolName'), ''),
            'args': info.get('args'),
            'error': str(info.get('error', '')),
            'phase': as_str(info.get('phase'), ''),
            'timestamp': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        }
    )
    failures = failures[-50:]
    saveMemory(_FAILURESKey, failures)


def recallToolFailures(toolName: str, limit: int = 5) -> list[dict[str, object]]:
    """Get recent failures for a specific tool."""
    failures = getMemory(_FAILURESKey) or []
    if not isinstance(failures, list):
        return []
    matches: list[dict[str, object]] = []
    for f in failures:
        fd = as_dict(f)
        if fd and as_str(fd.get('toolName')) == toolName:
            matches.append(fd)
    return matches[:limit]


def formatFailureHints(toolName: str) -> str:
    """Format failure history as hints for the model."""
    failures = recallToolFailures(toolName)
    if not failures:
        return ''
    hints = [f"Note: '{toolName}' has had {len(failures)} recent failure(s):"]
    for f in failures:
        hints.append(f'  - {as_str(f.get("error"), "unknown error")[:200]}')
    hints.append('Adjust parameters accordingly.')
    return '\n'.join(hints)
