"""
Element resolver — turn a ref/selector/text spec into a Playwright Locator.

Supports the four selection strategies the spec requires:
- ``ref``: a snapshot ref like ``@e3`` → ``[data-august-ref="3"]`` (set by
  ``snapshot.run_snapshot``).
- ``selector``: a CSS selector, or an XPath expression starting with ``//``
  or ``(/``.
- ``text``: visible text → ``page.get_by_text``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from playwright.async_api import Locator, Page


def _refToSelector(ref: str) -> str | None:
    """Map an ``@eN`` ref to the ``[data-august-ref="N"]`` attribute selector."""
    if not ref:
        return None
    s = ref.strip()
    if s.startswith('@e'):
        n = s[2:]
        if n.isdigit():
            return f'[data-august-ref="{n}"]'
    if s.isdigit():
        return f'[data-august-ref="{s}"]'
    return None


def _isXpath(selector: str) -> bool:
    s = selector.lstrip()
    return s.startswith('//') or s.startswith('(')


async def resolveLocator(
    page: Page, *, ref: str | None = None, selector: str | None = None, text: str | None = None
) -> Locator:
    """Return a Playwright Locator for the given spec, or raise.

    Exactly one of ``ref``/``selector``/``text`` should be provided. Playwright
    locators are lazy, so this returns immediately; the auto-wait happens on
    the subsequent action (click/fill/...).
    """
    if ref:
        sel = _refToSelector(ref)
        if not sel:
            raise ValueError(f"Invalid ref '{ref}'. Expected '@eN'.")
        return page.locator(sel)
    if selector:
        if _isXpath(selector):
            return page.locator(f'xpath={selector}')
        return page.locator(selector)
    if text:
        return page.get_by_text(text, exact=False)
    raise ValueError('One of ref, selector, or text is required.')
