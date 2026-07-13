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
from typing import TYPE_CHECKING

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
        browser = await launcher.launch(
            headless=True, args=['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
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
        _sessions[sid] = session
        return session


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
