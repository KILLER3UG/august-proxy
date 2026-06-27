"""
Browser tool handlers — the 9 workbench-callable browser tools.

Each handler reads the active workbench session id from
``current_session_id`` (set by ``workbench._execute_tool``), resolves its
per-session Playwright page, performs the action, and returns a JSON string.

Result shape: ``{ "status": "success" | "error", ... }``.
"""

from __future__ import annotations

import json
import time
from typing import Any
from urllib.parse import urlparse

from app.config import settings
from app.lib.paths import data_path
from app.services.browser.element_resolver import resolve_locator
from app.services.browser.session_manager import (
    BrowserUnavailableError,
    get_or_create_session,
    get_session,
)
from app.services.browser.snapshot import build_compact_snapshot, run_snapshot
from app.services.workbench.context import current_session_id

_NAV_TIMEOUT_MS = 30_000
_MAX_CONTENT_CHARS = 50_000


# ── Helpers ──────────────────────────────────────────────────────────


def _ok(**fields: Any) -> str:
    payload = {"status": "success", **fields}
    return json.dumps(payload, default=str)


def _err(message: str, **fields: Any) -> str:
    return json.dumps({"status": "error", "error": message, **fields}, default=str)


async def _page() -> tuple[Any, str | None]:
    """Return ``(page, error_json)``. error_json is set if unavailable."""
    sid = current_session_id.get()
    try:
        session = await get_or_create_session(sid)
    except BrowserUnavailableError as exc:
        return None, _err(str(exc))
    except Exception as exc:
        return None, _err(f"Failed to start browser: {exc}")
    if not session or session.page is None:
        return None, _err("Browser session not ready")
    return session.page, None


async def _elements_snapshot(page: Any) -> str:
    elements = await run_snapshot(page)
    return build_compact_snapshot(elements)


def _check_url_allowlist(url: str) -> str | None:
    """Return an error message if the URL is blocked by the allowlist, else None."""
    allowlist = settings.config.get("browserAllowlist") or []
    if not isinstance(allowlist, list) or not allowlist:
        return None
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return f"Invalid URL: {url}"
    if not host:
        return f"URL has no host: {url}"
    for allowed in allowlist:
        a = str(allowed).lower().lstrip(".")
        if host == a or host.endswith("." + a):
            return None
    return f"Domain '{host}' is not in the browser allowlist"


# ── Tools ────────────────────────────────────────────────────────────


async def browser_open(url: str, wait_until: str = "load") -> str:
    """Open a URL and return the page title + interactive-element snapshot."""
    if not url:
        return _err("url is required")
    blocked = _check_url_allowlist(url)
    if blocked:
        return _err(blocked)

    valid_wait = {"load", "domcontentloaded", "networkidle", "commit"}
    if wait_until not in valid_wait:
        wait_until = "load"

    page, err = await _page()
    if err:
        return err
    try:
        await page.goto(url, wait_until=wait_until, timeout=_NAV_TIMEOUT_MS)
        title = await page.title()
        elements = await _elements_snapshot(page)
        return _ok(url=page.url, title=title, elements=elements)
    except Exception as exc:
        return _err(f"Navigation failed: {exc}", url=url)


async def browser_click(
    ref: str | None = None,
    selector: str | None = None,
    text: str | None = None,
) -> str:
    """Click an element by ref, CSS/XPath selector, or visible text."""
    page, err = await _page()
    if err:
        return err
    try:
        locator = await resolve_locator(page, ref=ref, selector=selector, text=text)
        await locator.click(timeout=_NAV_TIMEOUT_MS)
        elements = await _elements_snapshot(page)
        return _ok(elements=elements)
    except Exception as exc:
        return _err(f"Click failed: {exc}")


async def browser_type(
    text: str = "",
    ref: str | None = None,
    selector: str | None = None,
    submit: bool = False,
) -> str:
    """Type ``text`` into a field (located by ref/selector) and optionally submit."""
    page, err = await _page()
    if err:
        return err
    try:
        locator = await resolve_locator(page, ref=ref, selector=selector)
        await locator.fill(text, timeout=_NAV_TIMEOUT_MS)
        if submit:
            await locator.press("Enter")
        elements = await _elements_snapshot(page)
        return _ok(typed=text, elements=elements)
    except Exception as exc:
        return _err(f"Type failed: {exc}")


async def browser_select(
    value: str,
    ref: str | None = None,
    selector: str | None = None,
) -> str:
    """Select an option from a ``<select>`` dropdown."""
    page, err = await _page()
    if err:
        return err
    try:
        locator = await resolve_locator(page, ref=ref, selector=selector)
        await locator.select_option(value, timeout=_NAV_TIMEOUT_MS)
        elements = await _elements_snapshot(page)
        return _ok(selected=value, elements=elements)
    except Exception as exc:
        return _err(f"Select failed: {exc}")


async def browser_scroll(
    direction: str = "down",
    amount: int = 400,
    selector: str | None = None,
) -> str:
    """Scroll the page (or an element) by ``amount`` px in ``direction``."""
    page, err = await _page()
    if err:
        return err
    direction = (direction or "down").lower()
    if direction not in ("up", "down"):
        direction = "down"
    dy = int(amount) if direction == "down" else -int(amount)
    try:
        if selector:
            el = await resolve_locator(page, selector=selector)
            await el.scroll_into_view_if_needed(timeout=_NAV_TIMEOUT_MS)
        else:
            await page.mouse.wheel(0, dy)
        await page.wait_for_timeout(300)
        elements = await _elements_snapshot(page)
        return _ok(scrolled=direction, amount=abs(dy), elements=elements)
    except Exception as exc:
        return _err(f"Scroll failed: {exc}")


async def browser_wait(
    strategy: str = "selector",
    selector: str | None = None,
    timeout: int = 30,
) -> str:
    """Wait for an element, a load state, or a timeout."""
    page, err = await _page()
    if err:
        return err
    strategy = (strategy or "selector").lower()
    timeout_ms = max(1000, int(timeout) * 1000)
    try:
        if strategy == "selector":
            if not selector:
                return _err("selector is required for strategy='selector'")
            await page.wait_for_selector(selector, timeout=timeout_ms)
        elif strategy == "load":
            await page.wait_for_load_state("load", timeout=timeout_ms)
        elif strategy == "networkidle":
            await page.wait_for_load_state("networkidle", timeout=timeout_ms)
        elif strategy == "timeout":
            await page.wait_for_timeout(timeout_ms)
        else:
            return _err(f"Unknown wait strategy '{strategy}'")
        return _ok(strategy=strategy, waited=True)
    except Exception as exc:
        return _err(f"Wait failed: {exc}")


async def browser_screenshot(full_page: bool = False) -> str:
    """Take a screenshot, save it to disk, and return the path + dimensions.

    Saved as a file (not base64) so the result stays well under the 100 KB
    workbench SSE truncation limit; the path can be opened by the user/agent.
    """
    page, err = await _page()
    if err:
        return err
    try:
        sid = current_session_id.get() or "default"
        folder = data_path("browser_screenshots", sid)
        folder.mkdir(parents=True, exist_ok=True)
        filename = f"{int(time.time() * 1000)}.png"
        path = folder / filename
        await page.screenshot(path=str(path), full_page=bool(full_page))
        viewport = page.viewport_size or {}
        return _ok(
            path=str(path),
            width=viewport.get("width"),
            height=viewport.get("height"),
            full_page=bool(full_page),
        )
    except Exception as exc:
        return _err(f"Screenshot failed: {exc}")


async def browser_evaluate(script: str) -> str:
    """Execute JavaScript in the page and return the JSON-serialised result."""
    if not script:
        return _err("script is required")
    page, err = await _page()
    if err:
        return err
    try:
        result = await page.evaluate(script)
        return _ok(result=result)
    except Exception as exc:
        return _err(f"Evaluate failed: {exc}")


async def browser_get_content(format: str = "text") -> str:
    """Extract page content. ``format`` ∈ html | text | markdown | elements."""
    page, err = await _page()
    if err:
        return err
    fmt = (format or "text").lower()
    try:
        if fmt == "html":
            content = await page.content()
        elif fmt == "text":
            content = await page.inner_text("body")
        elif fmt == "markdown":
            content = await page.inner_text("body")
            # Lightweight markdown-ish: nothing further; text is already flat.
        elif fmt == "elements":
            content = await _elements_snapshot(page)
        else:
            return _err(f"Unknown format '{format}'. Use html|text|markdown|elements.")
        return _ok(format=fmt, content=content[:_MAX_CONTENT_CHARS])
    except Exception as exc:
        return _err(f"Get content failed: {exc}")
