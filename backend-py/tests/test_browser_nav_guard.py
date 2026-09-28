"""The browser must not be able to reach a private address by being redirected.

`browserOpen` used to check the URL the model supplied and then call
`page.goto(url)`, which follows 3xx INTERNALLY. A public host that answers
`302 Location: http://169.254.169.254/…` — or loopback, or August's own
backend — walked straight past the guard, and `browser_get_content` then
returned the body. The same bug the `web_fetch` docstring says was fixed
there, and only there.

These tests drive the real `_installNavigationGuard` route handler with a fake
Playwright route, so they assert the decision the guard makes rather than
mocking the guard away.
"""

from __future__ import annotations

import pytest
from app.services.browser import session_manager as sm


class _FakeRequest:
    def __init__(self, url: str) -> None:
        self.url = url


class _FakeRoute:
    """Records what the guard decided, the way Playwright would see it."""

    def __init__(self, url: str) -> None:
        self.request = _FakeRequest(url)
        self.continued = False
        self.aborted_with: str | None = None

    async def continue_(self) -> None:
        self.continued = True

    async def abort(self, reason: str = 'failed') -> None:
        self.aborted_with = reason


class _FakePage:
    def __init__(self) -> None:
        self.handler = None
        self.events: list[str] = []

    def on(self, event: str, _cb) -> None:
        self.events.append(event)

    async def route(self, _pattern: str, handler) -> None:
        self.handler = handler


async def _guard_for(url: str) -> tuple[_FakeRoute, sm.BrowserSession]:
    session = sm.BrowserSession('s1')
    page = _FakePage()
    await sm._installNavigationGuard(page, session)  # type: ignore[arg-type]
    route = _FakeRoute(url)
    await page.handler(route, route.request)  # type: ignore[misc]
    return route, session


class TestNavigationGuardBlocksPrivateAddresses:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        'url',
        [
            'http://127.0.0.1:19387/api/providers',  # August's own backend
            'http://localhost:8000/',
            'http://169.254.169.254/latest/meta-data/',  # cloud credentials
            'http://10.0.0.5/internal',
            'http://192.168.1.1/router',
            'https://[::1]/',
        ],
    )
    async def test_refused(self, url: str):
        route, session = await _guard_for(url)
        assert route.continued is False
        assert route.aborted_with == 'blockedbyclient'
        # The reason is retained so the tool can report the refusal instead of
        # surfacing a bare "navigation failed".
        assert session.navBlockReason

    @pytest.mark.asyncio
    async def test_a_public_url_is_allowed_through(self):
        route, session = await _guard_for('https://example.com/')
        assert route.continued is True
        assert route.aborted_with is None
        assert session.navBlockReason is None

    @pytest.mark.asyncio
    @pytest.mark.parametrize('url', ['about:blank', 'data:text/html,<p>hi', 'blob:null/abc'])
    async def test_non_network_schemes_pass_through(self, url: str):
        """Blocking these would break rendering and add no safety.

        A `data:` URL has no host to judge; refusing it would break inline
        images and about:blank initial states on ordinary pages.
        """
        route, _ = await _guard_for(url)
        assert route.continued is True
        assert route.aborted_with is None

    @pytest.mark.asyncio
    async def test_the_guard_is_installed_on_page_creation(self, monkeypatch):
        """It has to be on the session, not on the one audited function.

        Otherwise the next browser tool that navigates inherits the hole.
        """
        captured: dict[str, object] = {}

        class _Ctx:
            async def new_page(self):
                return _FakePage()

        class _Browser:
            async def new_context(self, **_kw):
                return _Ctx()

        class _Launcher:
            async def launch(self, **_kw):
                return _Browser()

        class _PW:
            chromium = _Launcher()

        async def _fake_engine():
            return _PW()

        monkeypatch.setattr(sm, '_startEngine', _fake_engine)
        sm._sessions.clear()
        session = await sm.getOrCreateSession('guard-install')
        page = session.page
        assert isinstance(page, _FakePage)
        assert callable(page.handler), 'navigation guard was not installed on the new page'
        assert captured == {}
        sm._sessions.clear()
