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
        context = await browser.new_context(
            viewport=_VIEWPORT,
            user_agent=_USERAgent,
            # A service worker's `fetch()` is not routed at all, so a hostile
            # page could register one and read a private address through it
            # while every route handler reported the request as fine.
            service_workers='block',
        )
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

    WHAT ROUTING CAN AND CANNOT DO — measured, not assumed. The first version
    of this used `page.route('**/*')` and claimed "the check cannot be stepped
    over, so the check cannot be stepped over". Adversarial review with a real
    Chromium found that false: Playwright does NOT invoke a route handler for
    an HTTP 3xx redirect hop. The handler fires for the original request and
    never for the follow-up, so `302 → 127.0.0.1` completed and
    `browser_get_content` returned the blocked body. It also missed requests
    made by a service worker, and popups opened with `window.open` (a
    different `Page` with no routes at all).

    So this is defence in LAYERS, and the load-bearing one is the last:

      1. routing on the CONTEXT, not the page, which covers popups and every
         page the context ever makes, installed once instead of per page;
      2. `service_workers='block'` on the context, because a worker's
         `fetch()` is not routed at all;
      3. routing still blocks the direct, subresource and client-side
         navigation cases (meta refresh and `location.href` are fresh
         document requests, and those ARE routed);
      4. and the control that actually closes the redirect case —
         `assertFinalUrlAllowed` below, which re-checks where the browser
         ENDED UP and refuses to return the body.

    Layer 4 is the one that matters for this threat model. Chromium may
    already have issued the redirect request by the time we look; what must
    never happen is the response reaching the model. A private address can
    still be *contacted* through a redirect, but nothing it returns is ever
    read back.
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

    context = page.context
    # Context-level so a popup — a fresh Page the model opened — inherits it.
    await context.route('**/*', _guard)
    # Belt and braces for a page created before this ran.
    await page.route('**/*', _guard)


def assertFinalUrlAllowed(page: Page, session: BrowserSession) -> str | None:
    """Refuse a navigation that ENDED on a blocked address. Returns a reason.

    This is the layer that closes the redirect hole routing cannot. A
    `page.goto` that followed a 3xx to a private address leaves `page.url`
    pointing at the private host, so the check runs against where the browser
    actually arrived rather than where it was told to go.

    The caller must treat a non-None result as "discard everything the page
    produced" — not merely "note it". A refused navigation has still executed
    JavaScript and still populated the DOM, so the screenshot and the
    element snapshot have to be dropped too, or the same bytes come back
    through the other return values.
    """
    from app.services.browser.handlers import _checkUrlAllowlist

    final = page.url
    if not final or final == 'about:blank':
        return None
    reason = _checkUrlAllowlist(final)
    if reason:
        session.navBlockReason = reason
        return reason
    return None


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
