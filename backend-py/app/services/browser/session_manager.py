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
from typing import Any

logger = logging.getLogger(__name__)

_VIEWPORT = {"width": 1280, "height": 720}
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
_MAX_CONSOLE = 500


class BrowserSession:
    """A live Playwright browser/context/page triple for one session id."""

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.playwright: Any = None
        self.browser: Any = None
        self.context: Any = None
        self.page: Any = None
        self.console_logs: list[dict[str, Any]] = []

    @property
    def ready(self) -> bool:
        return self.page is not None


_sessions: dict[str, BrowserSession] = {}
_lock = asyncio.Lock()


class BrowserUnavailableError(RuntimeError):
    """Raised when Playwright/chromium is not installed."""


async def _start_engine() -> Any:
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise BrowserUnavailableError(
            "Playwright is not installed. Run `uv add playwright` then "
            "`uv run playwright install chromium`."
        ) from exc
    return await async_playwright().start()


async def get_or_create_session(session_id: str) -> BrowserSession:
    """Return the browser session for ``session_id``, creating it if needed."""
    sid = session_id or "default"
    existing = _sessions.get(sid)
    if existing and existing.ready:
        return existing

    async with _lock:
        existing = _sessions.get(sid)
        if existing and existing.ready:
            return existing

        session = BrowserSession(sid)
        session.playwright = await _start_engine()
        engine = "chromium"  # could be made configurable via env later
        launcher = getattr(session.playwright, engine) or session.playwright.chromium
        session.browser = await launcher.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
            ],
        )
        session.context = await session.browser.new_context(
            viewport=_VIEWPORT,
            user_agent=_USER_AGENT,
        )
        session.page = await session.context.new_page()

        def _on_console(msg: Any) -> None:
            entry = {
                "type": msg.type,
                "text": msg.text,
            }
            session.console_logs.append(entry)
            if len(session.console_logs) > _MAX_CONSOLE:
                del session.console_logs[: len(session.console_logs) - _MAX_CONSOLE]

        session.page.on("console", _on_console)

        _sessions[sid] = session
        return session


def get_session(session_id: str) -> BrowserSession | None:
    return _sessions.get(session_id or "default")


async def close_session(session_id: str) -> None:
    sid = session_id or "default"
    session = _sessions.pop(sid, None)
    if not session:
        return
    await _teardown(session)


async def _teardown(session: BrowserSession) -> None:
    for attr in ("page", "context", "browser", "playwright"):
        obj = getattr(session, attr, None)
        if obj is None:
            continue
        try:
            close = getattr(obj, "close", None) or getattr(obj, "stop", None)
            if close:
                res = close()
                if asyncio.iscoroutine(res):
                    await res
        except Exception as exc:  # noqa: BLE001
            logger.warning("[browser] error closing %s: %s", attr, exc)
        setattr(session, attr, None)


async def close_all() -> None:
    """Close every browser session — called on FastAPI shutdown."""
    sessions = list(_sessions.values())
    _sessions.clear()
    for session in sessions:
        await _teardown(session)
