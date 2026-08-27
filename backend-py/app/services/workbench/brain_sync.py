"""Workbench → SQLite health stats.

Normal chat turns call ``save_sessions()``, which writes the full session
blob and messages to SQLite. The legacy explicit sync/backfill path
(``sync_workbench_session_to_brain`` / ``backfill_workbench_json_to_brain``)
had no live callers and was removed with the memory-system cleanup
(plan §2.2). Only the operator health snapshot remains.
"""

from __future__ import annotations

from typing import Any

# Process-level status for health / smoke scripts. With the sync path
# removed these counters stay at their initial values; the shape is kept
# so the /api/health consumer in main.py continues to work.
_stats: dict[str, Any] = {
    'last_ok_at': None,
    'last_error_at': None,
    'last_error': None,
    'last_session_id': None,
    'success_count': 0,
    'failure_count': 0,
    'backfill_last': None,
}


def get_sync_stats() -> dict[str, object]:
    """Snapshot of brain sync health counters."""
    return dict(_stats)
