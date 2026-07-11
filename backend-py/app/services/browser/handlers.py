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
from typing import TYPE_CHECKING, Literal
from urllib.parse import urlparse
from app.config import settings
from app.lib.paths import dataPath
from app.services.browser.element_resolver import resolveLocator
from app.services.browser.session_manager import BrowserUnavailableError, getOrCreateSession, getSession
from app.services.browser.snapshot import buildCompactSnapshot, runSnapshot
from app.services.workbench.context import currentSessionId
from app.jsonUtils import as_str, as_dict, as_list, as_int, as_float

if TYPE_CHECKING:
    from playwright.async_api import Page
_NAVTimeoutMs = 30000
_MAXContentChars = 50000
_WAIT_STATES: dict[str, Literal['load', 'domcontentloaded', 'networkidle', 'commit']] = {
    'load': 'load',
    'domcontentloaded': 'domcontentloaded',
    'networkidle': 'networkidle',
    'commit': 'commit',
}


def _ok(**fields: object) -> str:
    payload = {'status': 'success', **fields}
    return json.dumps(payload, default=str)


def _err(message: str, **fields: object) -> str:
    return json.dumps({'status': 'error', 'error': message, **fields}, default=str)


async def _captureScreenshot(page: Page) -> dict[str, object] | None:
    """Save a screenshot to disk and return metadata for the frontend drawer.

    Returns ``{path, width, height}`` or ``None`` if capture fails (the tool
    result still succeeds; a missing screenshot is non-fatal).
    """
    try:
        sid = currentSessionId.get() or 'default'
        folder = dataPath('browser_screenshots', sid)
        folder.mkdir(parents=True, exist_ok=True)
        filename = f'{int(time.time() * 1000)}.png'
        path = folder / filename
        await page.screenshot(path=str(path), full_page=False)
        viewport = as_dict(page.viewport_size)
        return {'path': str(path), 'width': viewport.get('width'), 'height': viewport.get('height')}
    except Exception:
        return None


async def _locatorBbox(page: Page, ref: str | None, selector: str | None, text: str | None) -> dict[str, object] | None:
    """Return the bounding box {x, y, width, height} of the target element.

    Used so the frontend can render a cursor/highlight over the element a
    click/type/select acted on. Returns ``None`` if it can't be resolved.
    """
    try:
        locator = await resolveLocator(page, ref=ref, selector=selector, text=text)
        box = await locator.bounding_box()
        if not box:
            return None
        return {
            'x': round(box['x'] + box['width'] / 2),
            'y': round(box['y'] + box['height'] / 2),
            'width': round(box['width']),
            'height': round(box['height']),
        }
    except Exception:
        return None


async def _page() -> tuple[Page | None, str | None]:
    """Return ``(page, error_json)``. error_json is set if unavailable."""
    sid = currentSessionId.get()
    try:
        session = await getOrCreateSession(sid)
    except BrowserUnavailableError as exc:
        return (None, _err(str(exc)))
    except Exception as exc:
        return (None, _err(f'Failed to start browser: {exc}'))
    if not session or session.page is None:
        return (None, _err('Browser session not ready'))
    return (session.page, None)


async def _elementsSnapshot(page: Page) -> str:
    elements = await runSnapshot(page)
    return buildCompactSnapshot(elements)


def _checkUrlAllowlist(url: str) -> str | None:
    """Return an error message if the URL is blocked by the allowlist, else None."""
    allowlist = settings.config.get('browserAllowlist') or []
    if not isinstance(allowlist, list) or not allowlist:
        return None
    try:
        host = (urlparse(url).hostname or '').lower()
    except Exception:
        return f'Invalid URL: {url}'
    if not host:
        return f'URL has no host: {url}'
    for allowed in allowlist:
        a = str(allowed).lower().lstrip('.')
        if host == a or host.endswith('.' + a):
            return None
    return f"Domain '{host}' is not in the browser allowlist"


async def browserOpen(url: str, waitUntil: str = 'load') -> str:
    """Open a URL and return the page title + interactive-element snapshot."""
    if not url:
        return _err('url is required')
    blocked = _checkUrlAllowlist(url)
    if blocked:
        return _err(blocked)
    waitState = _WAIT_STATES.get(waitUntil, 'load')
    page, err = await _page()
    if err or page is None:
        return err or _err('Browser session not ready')
    try:
        await page.goto(url, wait_until=waitState, timeout=_NAVTimeoutMs)
        title = await page.title()
        elements = await _elementsSnapshot(page)
        screenshot = await _captureScreenshot(page)
        return _ok(url=page.url, title=title, elements=elements, screenshot=screenshot)
    except Exception as exc:
        return _err(f'Navigation failed: {exc}', url=url)


async def browserClick(ref: str | None = None, selector: str | None = None, text: str | None = None) -> str:
    """Click an element by ref, CSS/XPath selector, or visible text."""
    page, err = await _page()
    if err or page is None:
        return err or _err('Browser session not ready')
    try:
        locator = await resolveLocator(page, ref=ref, selector=selector, text=text)
        target = await _locatorBbox(page, ref=ref, selector=selector, text=text)
        await locator.click(timeout=_NAVTimeoutMs)
        elements = await _elementsSnapshot(page)
        screenshot = await _captureScreenshot(page)
        return _ok(elements=elements, target=target, screenshot=screenshot)
    except Exception as exc:
        return _err(f'Click failed: {exc}')


async def browserType(text: str = '', ref: str | None = None, selector: str | None = None, submit: bool = False) -> str:
    """Type ``text`` into a field (located by ref/selector) and optionally submit."""
    page, err = await _page()
    if err or page is None:
        return err or _err('Browser session not ready')
    try:
        locator = await resolveLocator(page, ref=ref, selector=selector)
        target = await _locatorBbox(page, ref=ref, selector=selector, text=None)
        await locator.fill(text, timeout=_NAVTimeoutMs)
        if submit:
            await locator.press('Enter')
        elements = await _elementsSnapshot(page)
        screenshot = await _captureScreenshot(page)
        return _ok(typed=text, elements=elements, target=target, screenshot=screenshot)
    except Exception as exc:
        return _err(f'Type failed: {exc}')


async def browserSelect(value: str, ref: str | None = None, selector: str | None = None) -> str:
    """Select an option from a ``<select>`` dropdown."""
    page, err = await _page()
    if err or page is None:
        return err or _err('Browser session not ready')
    try:
        locator = await resolveLocator(page, ref=ref, selector=selector)
        target = await _locatorBbox(page, ref=ref, selector=selector, text=None)
        await locator.select_option(value, timeout=_NAVTimeoutMs)
        elements = await _elementsSnapshot(page)
        screenshot = await _captureScreenshot(page)
        return _ok(selected=value, elements=elements, target=target, screenshot=screenshot)
    except Exception as exc:
        return _err(f'Select failed: {exc}')


async def browserScroll(direction: str = 'down', amount: int = 400, selector: str | None = None) -> str:
    """Scroll the page (or an element) by ``amount`` px in ``direction``."""
    page, err = await _page()
    if err or page is None:
        return err or _err('Browser session not ready')
    direction = (direction or 'down').lower()
    if direction not in ('up', 'down'):
        direction = 'down'
    dy = int(amount) if direction == 'down' else -int(amount)
    try:
        if selector:
            el = await resolveLocator(page, selector=selector)
            await el.scroll_into_view_if_needed(timeout=_NAVTimeoutMs)
        else:
            await page.mouse.wheel(0, dy)
        await page.wait_for_timeout(300)
        elements = await _elementsSnapshot(page)
        screenshot = await _captureScreenshot(page)
        return _ok(scrolled=direction, amount=abs(dy), elements=elements, screenshot=screenshot)
    except Exception as exc:
        return _err(f'Scroll failed: {exc}')


async def browserWait(strategy: str = 'selector', selector: str | None = None, timeout: int = 30) -> str:
    """Wait for an element, a load state, or a timeout."""
    page, err = await _page()
    if err or page is None:
        return err or _err('Browser session not ready')
    strategy = (strategy or 'selector').lower()
    timeoutMs = max(1000, int(timeout) * 1000)
    try:
        if strategy == 'selector':
            if not selector:
                return _err("selector is required for strategy='selector'")
            await page.wait_for_selector(selector, timeout=timeoutMs)
        elif strategy == 'load':
            await page.wait_for_load_state('load', timeout=timeoutMs)
        elif strategy == 'networkidle':
            await page.wait_for_load_state('networkidle', timeout=timeoutMs)
        elif strategy == 'timeout':
            await page.wait_for_timeout(timeoutMs)
        else:
            return _err(f"Unknown wait strategy '{strategy}'")
        return _ok(strategy=strategy, waited=True)
    except Exception as exc:
        return _err(f'Wait failed: {exc}')


async def browserScreenshot(fullPage: bool = False) -> str:
    """Take a screenshot, save it to disk, and return the path + dimensions.

    Saved as a file (not base64) so the result stays well under the 100 KB
    workbench SSE truncation limit; the path can be opened by the user/agent.
    """
    page, err = await _page()
    if err or page is None:
        return err or _err('Browser session not ready')
    try:
        sid = currentSessionId.get() or 'default'
        folder = dataPath('browser_screenshots', sid)
        folder.mkdir(parents=True, exist_ok=True)
        filename = f'{int(time.time() * 1000)}.png'
        path = folder / filename
        await page.screenshot(path=str(path), full_page=bool(fullPage))
        viewport = as_dict(page.viewport_size)
        return _ok(path=str(path), width=viewport.get('width'), height=viewport.get('height'), full_page=bool(fullPage))
    except Exception as exc:
        return _err(f'Screenshot failed: {exc}')


async def browserEvaluate(script: str) -> str:
    """Execute JavaScript in the page and return the JSON-serialised result."""
    if not script:
        return _err('script is required')
    page, err = await _page()
    if err or page is None:
        return err or _err('Browser session not ready')
    try:
        result = await page.evaluate(script)
        return _ok(result=result)
    except Exception as exc:
        return _err(f'Evaluate failed: {exc}')


async def browserGetContent(format: str = 'text') -> str:
    """Extract page content. ``format`` ∈ html | text | markdown | elements."""
    page, err = await _page()
    if err or page is None:
        return err or _err('Browser session not ready')
    fmt = (format or 'text').lower()
    try:
        if fmt == 'html':
            content = await page.content()
        elif fmt == 'text':
            content = await page.inner_text('body')
        elif fmt == 'markdown':
            content = await page.inner_text('body')
        elif fmt == 'elements':
            content = await _elementsSnapshot(page)
        else:
            return _err(f"Unknown format '{format}'. Use html|text|markdown|elements.")
        return _ok(format=fmt, content=content[:_MAXContentChars])
    except Exception as exc:
        return _err(f'Get content failed: {exc}')
