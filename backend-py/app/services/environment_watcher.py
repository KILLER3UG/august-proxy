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
import threading
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Callable

from app.json_narrowing import as_float

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

# Per-session cap on the change buffer. `getRecentChanges` only ever returns
# the last `maxAgeSeconds` (default 5 min) of changes, so anything older is
# unreachable by design — the list used to keep them anyway, and there was no
# cap on either the length or the number of sessions, so a long-lived process
# accumulated every change for every session it had ever watched.
_MAX_CHANGES_PER_SESSION = 200
# The buffer is shared between the watchdog observer threads (which call
# `recordChange`) and whichever thread asks for changes (which sweeps). Every
# access is under this lock, so a sweep cannot discard a record appended
# microseconds earlier.
_recent_lock = threading.Lock()


def getRecentChanges(sessionId: str, maxAgeSeconds: int = 300) -> list[dict]:
    """v2: Return recent environment changes for the session.

    The expiry sweep runs under the same lock `recordChange` takes. Rebuilding
    a filtered list and assigning it back was a lost update — `recordChange`
    is called from watchdog observer THREADS, so anything appended between
    building the copy and assigning it was silently discarded, and the old
    `else` branch was worse: it popped the dict key and threw away a whole
    freshly-appended buffer. Adversarial review made the window deterministic
    with a list subclass, though it could not hit it with real threads, so
    treat the rate as unmeasured.

    A lock is the honest fix rather than another slice trick: the list is
    shared between two threads by construction, so the read-modify-write has
    to be atomic. It is held for microseconds over a bounded list.
    """
    cutoff = time.time() - maxAgeSeconds
    with _recent_lock:
        changes = _recentChanges.get(sessionId)
        if changes is None:
            return []
        changes[:] = [c for c in changes if as_float(c.get('timestamp'), 0.0) >= cutoff]
        if not changes:
            _recentChanges.pop(sessionId, None)
            return []
        return list(changes)


def forgetSessionChanges(sessionId: str) -> None:
    """Drop a session's change buffer outright.

    Called when the session leaves the RAM recency window, not when its
    changes merely age out — otherwise the dict key outlives the session it
    belongs to, and the number of keys tracks every session the process ever
    watched rather than the ones still in play. Takes the same lock as
    `recordChange` so a concurrent append cannot re-create the key between
    this check and the pop.
    """
    with _recent_lock:
        _recentChanges.pop(sessionId, None)


def recordChange(sessionId: str, change: dict) -> None:
    """v2: Record an environment change (called by EnvironmentWatcher on emit).

    The timestamp is stamped HERE, by the recorder, rather than expected of
    each caller. The `EnvironmentChange` dataclass above declares one and
    `getRecentChanges` filters on it, but the only production caller
    (`cognitive_boot._on_event`) was building the dict by hand without it — so
    every change was written, grew without bound, and then failed its own age
    check and was never returned. A field the reader depends on belongs to the
    writer that owns the record, not to whoever happens to call it.

    Takes `_recent_lock` because the buffer is shared with
    `getRecentChanges`, which sweeps it from whichever thread asked for
    changes — the watchdog observer threads are not the loop thread.
    """
    with _recent_lock:
        entry = _recentChanges.get(sessionId)
        if entry is None:
            entry = _recentChanges[sessionId] = []
        if 'timestamp' not in change:
            change = {**change, 'timestamp': time.time()}
        entry.append(change)
        if len(entry) > _MAX_CHANGES_PER_SESSION:
            del entry[: len(entry) - _MAX_CHANGES_PER_SESSION]


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
            from watchdog.events import FileSystemEventHandler
            from watchdog.observers import Observer

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
