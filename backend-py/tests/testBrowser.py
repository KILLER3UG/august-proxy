"""Browser tool tests — pure helpers + graceful degradation (no real browser)."""

import json
from app.services.browser import element_resolver, snapshot
from app.services.browser.session_manager import BrowserUnavailableError


def testRefToSelector():
    assert element_resolver._refToSelector('@e3') == '[data-august-ref="3"]'
    assert element_resolver._refToSelector('7') == '[data-august-ref="7"]'
    assert element_resolver._refToSelector('bogus') is None
    assert element_resolver._refToSelector('') is None


def testIsXpath():
    assert element_resolver._isXpath('//div')
    assert element_resolver._isXpath('  //div')
    assert element_resolver._isXpath('(//div)[1]')
    assert not element_resolver._isXpath('div.foo')


def testCompactSnapshotFormat():
    elements = [
        {'ref': '@e1', 'role': 'button', 'name': 'Search', 'value': '', 'description': ''},
        {'ref': '@e2', 'role': 'textbox', 'name': 'Query', 'value': 'hello', 'description': ''},
        {'ref': '@e3', 'role': 'img', 'name': '', 'value': '', 'description': ''},
    ]
    out = snapshot.buildCompactSnapshot(elements)
    lines = out.split('\n')
    assert any(('[@e1] button "Search"' in line for line in lines))
    assert any(("value='hello'" in line for line in lines))
    assert not any(('@e3' in line for line in lines))


def testBrowserOpenWithoutEngineReturnsError(monkeypatch):
    """When Playwright is unavailable, browser tools return a clear error."""
    import asyncio
    from app.services.browser import handlers
    from app.services.browser.session_manager import _startEngine

    async def _boom():
        raise BrowserUnavailableError('no playwright')

    monkeypatch.setattr('app.services.browser.session_manager._startEngine', _boom)
    result = json.loads(asyncio.run(handlers.browserOpen('https://example.com')))
    assert result['status'] == 'error'
    assert 'Playwright' in result['error'] or 'playwright' in result['error'].lower()
