"""Browser tool tests — pure helpers + graceful degradation (no real browser)."""
import json
from app.services.browser import elementResolver, snapshot
from app.services.browser.sessionManager import BrowserUnavailableError

def testRefToSelector():
    assert elementResolver._ref_to_selector('@e3') == '[data-august-ref="3"]'
    assert elementResolver._ref_to_selector('7') == '[data-august-ref="7"]'
    assert elementResolver._ref_to_selector('bogus') is None
    assert elementResolver._ref_to_selector('') is None

def testIsXpath():
    assert elementResolver._is_xpath('//div')
    assert elementResolver._is_xpath('  //div')
    assert elementResolver._is_xpath('(//div)[1]')
    assert not elementResolver._is_xpath('div.foo')

def testCompactSnapshotFormat():
    elements = [{'ref': '@e1', 'role': 'button', 'name': 'Search', 'value': '', 'description': ''}, {'ref': '@e2', 'role': 'textbox', 'name': 'Query', 'value': 'hello', 'description': ''}, {'ref': '@e3', 'role': 'img', 'name': '', 'value': '', 'description': ''}]
    out = snapshot.build_compact_snapshot(elements)
    lines = out.split('\n')
    assert any(('[@e1] button "Search"' in l for l in lines))
    assert any(("value='hello'" in l for l in lines))
    assert not any(('@e3' in l for l in lines))

def testBrowserOpenWithoutEngineReturnsError(monkeypatch):
    """When Playwright is unavailable, browser tools return a clear error."""
    import asyncio
    from app.services.browser import handlers
    from app.services.browser.sessionManager import _startEngine

    async def _boom():
        raise BrowserUnavailableError('no playwright')
    monkeypatch.setattr('app.services.browser.session_manager._start_engine', _boom)
    result = json.loads(asyncio.run(handlers.browserOpen('https://example.com')))
    assert result['status'] == 'error'
    assert 'Playwright' in result['error'] or 'playwright' in result['error'].lower()