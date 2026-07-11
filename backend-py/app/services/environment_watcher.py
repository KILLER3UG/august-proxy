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
from typing import TYPE_CHECKING, Callable
from app.jsonUtils import as_str, as_int, as_float

if TYPE_CHECKING:
    from watchdog.observers import Observer

logger = logging.getLogger(__name__)
_POLLInterval = 5
_RATELimit = 2.0
_IGNOREPatterns = [
    '*.pyc',
    '*.pyo',
    '*.pyd',
    '*__pycache__*',
    '*node_modules*',
    '*.git/objects*',
    '*.git/index.lock*',
    '*.swp',
    '*.swo',
    '*.DS_Store',
    '*.log',
]


def shouldIgnore(path: str) -> bool:
    """v2: Return True if the path matches an ignore pattern."""
    return any((fnmatch.fnmatch(path, pat) for pat in _IGNOREPatterns))


@dataclass
class ChangeEvent:
    """v2: A file/git/terminal change event."""

    path: str
    kind: str
    timestamp: float
    source: str


_recentChanges: dict[str, list[dict]] = {}


def getRecentChanges(sessionId: str, maxAgeSeconds: int = 300) -> list[dict]:
    """v2: Return recent environment changes for the session."""
    cutoff = time.time() - maxAgeSeconds
    changes = _recentChanges.get(sessionId, [])
    return [c for c in changes if as_float(c.get('timestamp'), 0.0) >= cutoff]


def recordChange(sessionId: str, change: dict) -> None:
    """v2: Record an environment change (called by EnvironmentWatcher on emit)."""
    if sessionId not in _recentChanges:
        _recentChanges[sessionId] = []
    _recentChanges[sessionId].append(change)


def watch(workspacePath: str, sessionId: str) -> None:
    """v2: Start watching the workspace. Delegates to EnvironmentWatcher class.

    Kept for backwards compatibility with callers that use the
    functional API. New code should use EnvironmentWatcher.
    """
    try:
        watcher = EnvironmentWatcher(rate_limit_seconds=_RATELimit)
        watcher.subscribe(
            lambda e: recordChange(
                sessionId, {'path': e.path, 'kind': e.kind, 'timestamp': e.timestamp, 'source': e.source}
            )
        )
        watcher.start(workspacePath)
    except Exception as exc:
        logger.warning('watch() failed: %s; falling back to polling', exc)
        _pollingWatch(workspacePath, sessionId)


def _pollingWatch(workspacePath: str, sessionId: str) -> None:
    """Fallback polling-based watcher (no watchdog)."""
    if not workspacePath or not os.path.isdir(workspacePath):
        return
    try:
        import subprocess

        now = time.time()
        branch = subprocess.run(
            ['git', 'branch', '--show-current'], cwd=workspacePath, capture_output=True, text=True, timeout=5
        ).stdout.strip()
        if branch:
            recordChange(
                sessionId,
                {'path': workspacePath, 'kind': 'git', 'timestamp': now, 'source': 'git', 'git_branch': branch},
            )
    except Exception:
        pass


def checkForChanges(workspacePath: str, sessionId: str) -> list[dict[str, object]]:
    """v2: Poll for recent file/git changes. Returns list of change events."""
    events: list[dict[str, object]] = []
    now = time.time()
    if not workspacePath or not os.path.isdir(workspacePath):
        return events
    try:
        import subprocess

        branch = subprocess.run(
            ['git', 'branch', '--show-current'], cwd=workspacePath, capture_output=True, text=True, timeout=5
        ).stdout.strip()
        status = subprocess.run(
            ['git', 'status', '--short'], cwd=workspacePath, capture_output=True, text=True, timeout=5
        ).stdout.strip()
        if branch:
            dirty = ' (dirty)' if status else ' (clean)'
            events.append({'type': 'git', 'detail': f'Branch: {branch}{dirty}', 'timestamp': now})
    except Exception:
        pass
    return events


class EnvironmentWatcher:
    """v2: Watchdog-based observer with rate limiting and event emission."""

    def __init__(self, rate_limit_seconds: float = 2.0):
        self._rateLimitSeconds = rate_limit_seconds
        self._lastEmit = 0.0
        self._changeBuffer: list[ChangeEvent] = []
        self._subscribers: list[Callable[[ChangeEvent], None]] = []
        self._observer: Observer | None = None

    def subscribe(self, callback: Callable[[ChangeEvent], None]) -> None:
        """v2: Register a subscriber to receive change events."""
        self._subscribers.append(callback)

    def start(self, rootPath: str) -> None:
        """v2: Begin watching the given directory. Falls back to no-op if watchdog unavailable."""
        try:
            from watchdog.observers import Observer
            from watchdog.events import FileSystemEventHandler

            class _Handler(FileSystemEventHandler):
                def __init__(self, w: EnvironmentWatcher):
                    self._w = w

                def onModified(self, event):
                    if event.is_directory:
                        return
                    if shouldIgnore(event.src_path):
                        return
                    ce = ChangeEvent(path=event.src_path, kind='modify', timestamp=time.time(), source='fs')
                    self._w._emit(ce)

            self._observer = Observer()
            self._observer.schedule(_Handler(self), rootPath, recursive=True)
            self._observer.start()
        except ImportError:
            logger.warning('watchdog not available; env watcher running in degraded mode')

    def stop(self) -> None:
        if self._observer is not None:
            self._observer.stop()
            self._observer.join()

    def _emit(self, event: ChangeEvent) -> None:
        if time.monotonic() - self._lastEmit < self._rateLimitSeconds:
            return
        self._lastEmit = time.monotonic()
        for sub in self._subscribers:
            try:
                sub(event)
            except Exception:
                pass
