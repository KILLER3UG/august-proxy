"""Deleting a session must release the two OS processes it was holding.

A browser session is not a light object: `getOrCreateSession` starts a
Playwright node driver AND a headless Chromium PER SESSION ID, which is
hundreds of MB resident. Before this was wired into
`delete_workbench_session`, the only caller of `closeSession` was the
model-facing `session_delete` tool, so deleting a chat from the sidebar — the
ordinary way a user cleans up — left every browser that session had opened
running until the app exited.
"""

from __future__ import annotations

import pytest
from app.services.workbench import sessions as sessions_mod


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


class TestSessionDeleteClosesTheBrowser:
    def test_ui_delete_path_closes_the_browser(self, brain, monkeypatch):
        """The bug, stated as a test: the delete route never reached the browser."""
        from app.services.browser import session_manager

        closed: list[str] = []

        async def fake_close(session_id: str) -> None:
            closed.append(session_id)

        monkeypatch.setattr(session_manager, 'closeSession', fake_close)

        sess = sessions_mod.create_workbench_session(goal='uses the browser', workspacePath=None)
        assert sessions_mod.delete_workbench_session(sess.id) is True
        assert closed == [sess.id], 'deleting a session left its browser running'

    def test_close_is_attempted_even_when_the_session_is_unknown(self, brain, monkeypatch):
        """Idempotent teardown.

        A session can be deleted twice (UI race, or a second cascade), and a
        browser may exist for a session that is no longer in the RAM window.
        The teardown must not depend on the session being present, or the
        second door is the one that leaks.
        """
        from app.services.browser import session_manager

        closed: list[str] = []

        async def fake_close(session_id: str) -> None:
            closed.append(session_id)

        monkeypatch.setattr(session_manager, 'closeSession', fake_close)
        sessions_mod.delete_workbench_session('session_that_is_not_loaded')
        assert closed == ['session_that_is_not_loaded']

    def test_a_failing_browser_close_does_not_abort_the_delete(self, brain, monkeypatch):
        """Teardown is best-effort in BOTH directions.

        The session is already removed from the in-memory map by the time the
        browser is released, so a browser that refuses to close must not leave
        the rest of the cascade — and the caller's deletion — half done.
        """
        from app.services.browser import session_manager

        async def boom(session_id: str) -> None:
            raise RuntimeError('playwright already gone')

        monkeypatch.setattr(session_manager, 'closeSession', boom)
        sess = sessions_mod.create_workbench_session(goal='browser dies mid-teardown')
        assert sessions_mod.delete_workbench_session(sess.id) is True
        assert sess.id not in sessions_mod.list_workbench_sessions()

    def test_missing_playwright_is_not_fatal(self, brain, monkeypatch):
        """An install without Playwright must still delete its session."""
        import builtins

        real_import = builtins.__import__

        def no_browser(name, *args, **kwargs):
            if name.startswith('app.services.browser'):
                raise ImportError('no playwright here')
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, '__import__', no_browser)
        sess = sessions_mod.create_workbench_session(goal='no playwright installed')
        assert sessions_mod.delete_workbench_session(sess.id) is True
