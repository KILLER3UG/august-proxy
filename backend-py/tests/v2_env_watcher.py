"""v2 — Test environment watcher (ignore patterns, rate limit, ChangeEvent)."""
import time
import pytest
from app.services import environment_watcher
from app.services.environment_watcher import (
    should_ignore,
    EnvironmentWatcher,
    ChangeEvent,
    record_change,
    get_recent_changes,
)


def test_should_ignore_pycache():
    assert should_ignore("__pycache__/foo.pyc") is True
    assert should_ignore("src/foo.pyc") is True
    assert should_ignore("node_modules/foo.js") is True
    assert should_ignore(".git/objects/abc") is True
    assert should_ignore("src/main.py") is False
    assert should_ignore("README.md") is False


def test_should_ignore_swap_files():
    assert should_ignore(".main.py.swp") is True
    assert should_ignore("foo.swo") is True


def test_change_event_format():
    """ChangeEvent has the expected fields."""
    e = ChangeEvent(
        path="src/auth.py",
        kind="modify",
        timestamp=time.time(),
        source="fs",
    )
    assert e.path == "src/auth.py"
    assert e.kind == "modify"
    assert e.source == "fs"


def test_watcher_emit_respects_rate_limit():
    """Events within rate_limit are not emitted."""
    watcher = EnvironmentWatcher(rate_limit_seconds=1.0)
    received: list[ChangeEvent] = []
    watcher.subscribe(lambda e: received.append(e))

    # Force last_emit to now
    watcher._last_emit = time.monotonic()
    # First emit should be blocked (within 1s window)
    e = ChangeEvent(path="a", kind="modify", timestamp=time.time(), source="fs")
    watcher._emit(e)
    assert len(received) == 0


def test_watcher_emit_passes_after_rate_limit():
    """After rate limit window, events are emitted."""
    watcher = EnvironmentWatcher(rate_limit_seconds=0.05)
    received: list[ChangeEvent] = []
    watcher.subscribe(lambda e: received.append(e))
    watcher._last_emit = time.monotonic() - 1.0  # 1s ago, past the window

    e = ChangeEvent(path="a", kind="modify", timestamp=time.time(), source="fs")
    watcher._emit(e)
    assert len(received) == 1


def test_record_and_get_recent_changes():
    """record_change and get_recent_changes work together."""
    import uuid
    sid = f"v2-env-{uuid.uuid4().hex[:8]}"
    record_change(sid, {"path": "a.py", "kind": "modify", "timestamp": time.time(), "source": "fs"})
    changes = get_recent_changes(sid, max_age_seconds=300)
    assert len(changes) == 1
    assert changes[0]["path"] == "a.py"


def test_get_recent_changes_filters_old():
    """Changes older than max_age_seconds are filtered out."""
    import uuid
    sid = f"v2-env-old-{uuid.uuid4().hex[:8]}"
    # Record an old change
    record_change(sid, {"path": "old.py", "kind": "modify", "timestamp": time.time() - 1000, "source": "fs"})
    changes = get_recent_changes(sid, max_age_seconds=300)
    assert len(changes) == 0
