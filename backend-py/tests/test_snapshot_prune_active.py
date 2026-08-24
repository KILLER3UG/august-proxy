"""Snapshot prune must never evict an actively-chatting session; debounced
saves must flush on shutdown."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import app.services.workbench.sessions as sessions
from app.services.workbench.sessions import (
    WorkbenchSession,
    _persist_sessions_snapshot,
    _sessions,
    flush_pending_saves,
    set_active_turn_check,
)


def _reset_debounce() -> None:
    with sessions._save_thread_lock:
        sessions._save_pending = False
        if sessions._save_timer is not None:
            sessions._save_timer.cancel()
            sessions._save_timer = None


def _old_iso(hours: float = 1.0) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat().replace('+00:00', 'Z')


def test_snapshot_prune_skips_session_with_active_turn(monkeypatch):
    """A session with an in-flight turn survives the recency-window prune."""
    old = _old_iso()
    _sessions.clear()
    for i in range(205):
        _sessions[f'wb_old_{i}'] = WorkbenchSession(id=f'wb_old_{i}', title='x', updatedAt=old)
    # wb_old_200 falls outside the top-200 window by recency order — but it is
    # marked as mid-turn, so the prune must keep it.
    active_id = 'wb_old_200'
    set_active_turn_check(lambda sid: sid == active_id)
    try:
        with patch('app.services.memory_store.save_workbench_session_sot'):
            _persist_sessions_snapshot()
    finally:
        set_active_turn_check(None)
    assert active_id in _sessions
    # Recency window is 60 (0.16.9): the active session survives on top.
    assert len(_sessions) == 61


def test_snapshot_prune_skips_recently_updated_without_probe():
    """Without a probe, out-of-window sessions touched near the snapshot time
    are still kept (conservative fallback for the active-turn race)."""
    recent = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat().replace('+00:00', 'Z')
    _sessions.clear()
    for i in range(205):
        _sessions[f'wb_near_{i}'] = WorkbenchSession(id=f'wb_near_{i}', title='x', updatedAt=recent)
    set_active_turn_check(None)
    with patch('app.services.memory_store.save_workbench_session_sot'):
        _persist_sessions_snapshot()
    # All 205 survive: 200 in-window + 5 protected by the recent-skip.
    assert len(_sessions) == 205


def test_flush_pending_saves_writes_when_pending(monkeypatch):
    """flush_pending_saves persists a queued debounce and is idempotent."""
    calls: list[int] = []

    def fake_persist() -> None:
        calls.append(1)

    monkeypatch.setattr(sessions, '_persist_sessions_snapshot', fake_persist)
    monkeypatch.setattr(sessions, '_SAVE_DEBOUNCE_S', 0.05)
    _reset_debounce()
    sessions.save_sessions()
    sessions.flush_pending_saves()
    assert calls == [1]
    sessions.flush_pending_saves()
    assert calls == [1]  # nothing pending → no extra write


def test_flush_pending_saves_noop_when_nothing_pending(monkeypatch):
    calls: list[int] = []

    def fake_persist() -> None:
        calls.append(1)

    monkeypatch.setattr(sessions, '_persist_sessions_snapshot', fake_persist)
    _reset_debounce()
    sessions.flush_pending_saves()
    assert calls == []
