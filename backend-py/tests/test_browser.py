"""Browser tool tests — pure helpers + graceful degradation (no real browser)."""
import json

from app.services.browser import element_resolver, snapshot
from app.services.browser.session_manager import BrowserUnavailableError


def test_ref_to_selector():
    assert element_resolver._ref_to_selector("@e3") == '[data-august-ref="3"]'
    assert element_resolver._ref_to_selector("7") == '[data-august-ref="7"]'
    assert element_resolver._ref_to_selector("bogus") is None
    assert element_resolver._ref_to_selector("") is None


def test_is_xpath():
    assert element_resolver._is_xpath("//div")
    assert element_resolver._is_xpath("  //div")
    assert element_resolver._is_xpath("(//div)[1]")
    assert not element_resolver._is_xpath("div.foo")


def test_compact_snapshot_format():
    elements = [
        {"ref": "@e1", "role": "button", "name": "Search", "value": "", "description": ""},
        {"ref": "@e2", "role": "textbox", "name": "Query", "value": "hello", "description": ""},
        {"ref": "@e3", "role": "img", "name": "", "value": "", "description": ""},
    ]
    out = snapshot.build_compact_snapshot(elements)
    lines = out.split("\n")
    assert any('[@e1] button "Search"' in l for l in lines)
    assert any("value='hello'" in l for l in lines)
    # img is not interactive and has no role in the interactive set → omitted.
    assert not any("@e3" in l for l in lines)


def test_browser_open_without_engine_returns_error(monkeypatch):
    """When Playwright is unavailable, browser tools return a clear error."""
    import asyncio

    from app.services.browser import handlers
    from app.services.browser.session_manager import _start_engine

    async def _boom():
        raise BrowserUnavailableError("no playwright")

    monkeypatch.setattr("app.services.browser.session_manager._start_engine", _boom)

    result = json.loads(asyncio.run(handlers.browser_open("https://example.com")))
    assert result["status"] == "error"
    assert "Playwright" in result["error"] or "playwright" in result["error"].lower()
