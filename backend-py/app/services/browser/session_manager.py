"""
Playwright session manager — one headless browser per workbench session.

Port of ``backend/services/tools/browser-tools.js`` session model. Each
workbench session id maps to an isolated browser/context/page so cookies and
localStorage don't leak across sessions.

Playwright is imported lazily so the rest of the proxy boots fine even when
the browser engine isn't installed; browser tools then return a clear error.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from playwright.async_api import Browser, BrowserContext, ConsoleMessage, Page, Playwright, ViewportSize
logger = logging.getLogger(__name__)
_VIEWPORT: ViewportSize = {'width': 1280, 'height': 720}
_USERAgent = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
)
_MAXConsole = 500


class BrowserSession:
    """A live Playwright browser/context/page triple for one session id."""

    def __init__(self, sessionId: str) -> None:
        self.sessionId = sessionId
        self.playwright: Playwright | None = None
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None
        self.page: Page | None = None
        self.consoleLogs: list[dict[str, object]] = []
        # Why the last request was refused by the navigation guard, so a
        # blocked redirect can be reported instead of surfacing as a generic
        # "navigation failed".
        self.navBlockReason: str | None = None

    @property
    def ready(self) -> bool:
        return self.page is not None


_sessions: dict[str, BrowserSession] = {}
_lock = asyncio.Lock()


class BrowserUnavailableError(RuntimeError):
    """Raised when Playwright/chromium is not installed."""


async def _startEngine() -> Playwright:
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise BrowserUnavailableError(
            'Playwright is not installed. Run `uv add playwright` then `uv run playwright install chromium`.'
        ) from exc
    return await async_playwright().start()


async def getOrCreateSession(sessionId: str) -> BrowserSession:
    """Return the browser session for ``session_id``, creating it if needed."""
    sid = sessionId or 'default'
    existing = _sessions.get(sid)
    if existing and existing.ready:
        return existing
    async with _lock:
        existing = _sessions.get(sid)
        if existing and existing.ready:
            return existing
        session = BrowserSession(sid)
        pw = await _startEngine()
        session.playwright = pw
        engine = 'chromium'
        launcher = getattr(pw, engine) or pw.chromium
        # No --no-sandbox: this is a user-machine browser, not a container —
        # the sandbox flag weakens the browser's own isolation for no benefit
        # on Windows (audit finding).
        browser = await launcher.launch(
            headless=True,
            args=['--disable-dev-shm-usage', '--disable-gpu'],
        )
        session.browser = browser
        context = await browser.new_context(viewport=_VIEWPORT, user_agent=_USERAgent)
        session.context = context
        page = await context.new_page()
        session.page = page

        def _onConsole(msg: ConsoleMessage) -> None:
            entry: dict[str, object] = {'type': msg.type, 'text': msg.text}
            session.consoleLogs.append(entry)
            if len(session.consoleLogs) > _MAXConsole:
                del session.consoleLogs[: len(session.consoleLogs) - _MAXConsole]

        page.on('console', _onConsole)
        await _installNavigationGuard(page, session)
        _sessions[sid] = session
        return session


async def _installNavigationGuard(page: Page, session: BrowserSession) -> None:
    """Refuse any request to a blocked address, on EVERY request.

    Checking the URL the model supplied is not enough, and the gap was
    exploitable: `browserOpen` validated `url` and then called
    `page.goto(url)`, which follows 3xx INTERNALLY. A public host answering
    `302 Location: http://169.254.169.254/…` (or loopback, or August's own
    backend) sailed past the guard, and `browser_get_content` then handed the
    body back. This is the bug the `web_fetch` docstring says was fixed
    ("redirects were never re-checked"); it was fixed only there.

    Interception is the durable shape. Re-validating after `goto` returns is
    too late — the request has already been made — and a manual redirect loop
    is not possible when the browser, not this code, drives the navigation.
    `page.route` sees each hop as its own request, so the check cannot be
    stepped over, and it also covers subresources a redirected page pulls in.

    Installed on the page when it is created, not in `browserOpen`, so every
    browser operation is behind it rather than the one that was audited.
    """
    from urllib.parse import urlparse

    # Imported here: handlers imports this module, so a top-level import would
    # be circular. The page exists long after both modules are loaded.
    from app.services.browser.handlers import _checkUrlAllowlist

    async def _guard(route: Any, request: Any) -> None:
        target = request.url
        # data:/blob:/about: are not network fetches and have no host to
        # judge; blocking them would break rendering without adding safety.
        if urlparse(target).scheme not in ('http', 'https'):
            await route.continue_()
            return
        reason = _checkUrlAllowlist(target)
        if reason:
            session.navBlockReason = reason
            await route.abort('blockedbyclient')
            return
        await route.continue_()

    await page.route('**/*', _guard)


def get_session(sessionId: str) -> BrowserSession | None:
    return _sessions.get(sessionId or 'default')


async def closeSession(sessionId: str) -> None:
    sid = sessionId or 'default'
    session = _sessions.pop(sid, None)
    if not session:
        return
    await _teardown(session)


async def _teardown(session: BrowserSession) -> None:
    for attr in ('page', 'context', 'browser', 'playwright'):
        obj = getattr(session, attr, None)
        if obj is None:
            continue
        try:
            close = getattr(obj, 'close', None) or getattr(obj, 'stop', None)
            if close:
                res = close()
                if asyncio.iscoroutine(res):
                    await res
        except Exception as exc:
            logger.warning('[browser] error closing %s: %s', attr, exc)
        setattr(session, attr, None)


async def closeAll() -> None:
    """Close every browser session — called on FastAPI shutdown."""
    sessions = list(_sessions.values())
    _sessions.clear()
    for session in sessions:
        await _teardown(session)
