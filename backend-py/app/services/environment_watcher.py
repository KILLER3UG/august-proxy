"""
Environment watcher — passive file/git monitoring daemon (Phase 10.2).

Watches filesystem modifications, git branch changes, and terminal activity.
Pushes structured change notifications to the blackboard for Tier 3 injection.

Uses ``watchdog`` if available, falls back to 5-second polling.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_POLL_INTERVAL = 5  # seconds
_RATE_LIMIT = 2.0   # max 1 update per 2 seconds


def watch(workspace_path: str, session_id: str) -> None:
    """Start watching the workspace for changes.

    In production this runs as a Phase 8 daemon. For now, provides
    the polling-based check that the workbench calls each turn.
    """
    pass  # Placeholder — full watchdog integration in future


def check_for_changes(workspace_path: str, session_id: str) -> list[dict[str, Any]]:
    """Poll for recent file/git changes. Returns list of change events.

    Each event: {"type": "file"|"git", "detail": "...", "timestamp": ...}
    """
    events: list[dict[str, Any]] = []
    now = time.time()

    if not workspace_path or not os.path.isdir(workspace_path):
        return events

    # Check git branch/status changes
    try:
        import subprocess
        branch = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=workspace_path, capture_output=True, text=True, timeout=5
        ).stdout.strip()
        status = subprocess.run(
            ["git", "status", "--short"],
            cwd=workspace_path, capture_output=True, text=True, timeout=5
        ).stdout.strip()
        if branch:
            dirty = " (dirty)" if status else " (clean)"
            events.append({
                "type": "git",
                "detail": f"Branch: {branch}{dirty}",
                "timestamp": now,
            })
    except Exception:
        pass

    return events
