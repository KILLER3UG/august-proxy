"""
Environment watcher — passive file/git monitoring daemon (Phase 10.2).

v2: Uses ``watchdog`` if available (with ignore patterns and rate limiting),
falls back to polling. Emits events to subscribers; the workbench subscribes
for Tier 3 <environment> injection.
"""

from __future__ import annotations

import fnmatch
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger(__name__)

_POLL_INTERVAL = 5  # seconds (fallback polling)
_RATE_LIMIT = 2.0   # max 1 update per 2 seconds

# v2: ignore patterns
_IGNORE_PATTERNS = [
    "*.pyc", "*.pyo", "*.pyd",
    "*__pycache__*",
    "*node_modules*",
    "*.git/objects*", "*.git/index.lock*",
    "*.swp", "*.swo", "*.DS_Store",
    "*.log",
]


def should_ignore(path: str) -> bool:
    """v2: Return True if the path matches an ignore pattern."""
    return any(fnmatch.fnmatch(path, pat) for pat in _IGNORE_PATTERNS)


@dataclass
class ChangeEvent:
    """v2: A file/git/terminal change event."""
    path: str
    kind: str  # "create" | "modify" | "delete" | "move"
    timestamp: float
    source: str  # "fs" | "git" | "terminal"


_recent_changes: dict[str, list[dict]] = {}  # session_id -> list of changes


def get_recent_changes(session_id: str, max_age_seconds: int = 300) -> list[dict]:
    """v2: Return recent environment changes for the session."""
    cutoff = time.time() - max_age_seconds
    changes = _recent_changes.get(session_id, [])
    return [c for c in changes if c.get("timestamp", 0) >= cutoff]


def record_change(session_id: str, change: dict) -> None:
    """v2: Record an environment change (called by EnvironmentWatcher on emit)."""
    if session_id not in _recent_changes:
        _recent_changes[session_id] = []
    _recent_changes[session_id].append(change)


def watch(workspace_path: str, session_id: str) -> None:
    """v2: Start watching the workspace. Delegates to EnvironmentWatcher class.

    Kept for backwards compatibility with callers that use the
    functional API. New code should use EnvironmentWatcher.
    """
    try:
        watcher = EnvironmentWatcher(rate_limit_seconds=_RATE_LIMIT)
        watcher.subscribe(lambda e: record_change(session_id, {
            "path": e.path,
            "kind": e.kind,
            "timestamp": e.timestamp,
            "source": e.source,
        }))
        watcher.start(workspace_path)
    except Exception as exc:
        logger.warning("watch() failed: %s; falling back to polling", exc)
        _polling_watch(workspace_path, session_id)


def _polling_watch(workspace_path: str, session_id: str) -> None:
    """Fallback polling-based watcher (no watchdog)."""
    if not workspace_path or not os.path.isdir(workspace_path):
        return
    try:
        import subprocess
        now = time.time()
        branch = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=workspace_path, capture_output=True, text=True, timeout=5
        ).stdout.strip()
        if branch:
            record_change(session_id, {
                "path": workspace_path,
                "kind": "git",
                "timestamp": now,
                "source": "git",
                "git_branch": branch,
            })
    except Exception:
        pass


def check_for_changes(workspace_path: str, session_id: str) -> list[dict[str, Any]]:
    """v2: Poll for recent file/git changes. Returns list of change events."""
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


class EnvironmentWatcher:
    """v2: Watchdog-based observer with rate limiting and event emission."""

    def __init__(self, rate_limit_seconds: float = 2.0):
        self._rate_limit_seconds = rate_limit_seconds
        self._last_emit = 0.0
        self._change_buffer: list[ChangeEvent] = []
        self._subscribers: list[Callable[[ChangeEvent], None]] = []
        self._observer: Any = None

    def subscribe(self, callback: Callable[[ChangeEvent], None]) -> None:
        """v2: Register a subscriber to receive change events."""
        self._subscribers.append(callback)

    def start(self, root_path: str) -> None:
        """v2: Begin watching the given directory. Falls back to no-op if watchdog unavailable."""
        try:
            from watchdog.observers import Observer
            from watchdog.events import FileSystemEventHandler

            class _Handler(FileSystemEventHandler):
                def __init__(self, w: EnvironmentWatcher):
                    self._w = w
                def on_modified(self, event):
                    if event.is_directory:
                        return
                    if should_ignore(event.src_path):
                        return
                    ce = ChangeEvent(path=event.src_path, kind="modify",
                                     timestamp=time.time(), source="fs")
                    self._w._emit(ce)

            self._observer = Observer()
            self._observer.schedule(_Handler(self), root_path, recursive=True)
            self._observer.start()
        except ImportError:
            logger.warning("watchdog not available; env watcher running in degraded mode")

    def stop(self) -> None:
        if self._observer is not None:
            self._observer.stop()
            self._observer.join()

    def _emit(self, event: ChangeEvent) -> None:
        # Rate limit: only emit if 2s+ has passed since last emit
        if (time.monotonic() - self._last_emit) < self._rate_limit_seconds:
            return
        self._last_emit = time.monotonic()
        for sub in self._subscribers:
            try:
                sub(event)
            except Exception:
                pass
