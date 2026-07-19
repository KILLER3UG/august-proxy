"""save_sessions debounce should not block callers on the hot path."""

from __future__ import annotations

import time
from unittest.mock import patch

import app.services.workbench.sessions as sessions


def test_save_sessions_debounces_and_flushes(monkeypatch, tmp_path):
    calls: list[float] = []

    def fake_persist() -> None:
        calls.append(time.monotonic())

    monkeypatch.setattr(sessions, '_persist_sessions_snapshot', fake_persist)
    monkeypatch.setattr(sessions, '_SAVE_DEBOUNCE_S', 0.05)

    # Reset debounce state between tests
    with sessions._save_thread_lock:
        sessions._save_pending = False
        if sessions._save_timer is not None:
            sessions._save_timer.cancel()
            sessions._save_timer = None

    sessions.save_sessions()
    sessions.save_sessions()
    sessions.save_sessions()
    assert calls == []

    time.sleep(0.12)
    assert len(calls) == 1


def test_save_sessions_immediate_writes_now(monkeypatch):
    calls: list[int] = []

    def fake_persist() -> None:
        calls.append(1)

    monkeypatch.setattr(sessions, '_persist_sessions_snapshot', fake_persist)
    with sessions._save_thread_lock:
        sessions._save_pending = False
        if sessions._save_timer is not None:
            sessions._save_timer.cancel()
            sessions._save_timer = None

    sessions.save_sessions(immediate=True)
    assert calls == [1]
