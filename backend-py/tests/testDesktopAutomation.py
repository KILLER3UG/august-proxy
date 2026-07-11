"""Desktop automation tests — router shapes + graceful degradation.

Covers the /api/desktop-automation endpoints against the real app and the
lazy-import graceful-degradation contract (pyautogui missing → clear error).
"""
import pytest
from httpx import ASGITransport, AsyncClient
from app.main import app

@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac

@pytest.mark.asyncio
async def testHealthReportsCapability(client):
    resp = await client.get('/api/desktop-automation/health')
    assert resp.status_code == 200
    data = resp.json()
    assert set(data.keys()) >= {'platform', 'overall', 'checks', 'timestamp'}
    assert data['overall'] in ('ok', 'error')
    assert isinstance(data['checks'], list)
    assert len(data['checks']) >= 1
    for c in data['checks']:
        assert {'name', 'status', 'message', 'details'} <= set(c.keys())

@pytest.mark.asyncio
async def testConfigShape(client):
    resp = await client.get('/api/desktop-automation/config')
    assert resp.status_code == 200
    data = resp.json()
    assert data['backend'] == 'pyautogui'
    assert 'enabled' in data
    assert isinstance(data['auto_approve'], list)
    assert isinstance(data['blocklist_keys'], list)
    assert isinstance(data['blocklist_patterns'], list)

@pytest.mark.asyncio
async def testActionUnknownReturnsError(client):
    resp = await client.post('/api/desktop-automation/action', json={'action': 'definitely-not-a-real-action', 'params': {}})
    assert resp.status_code == 200
    data = resp.json()
    assert 'error' in data
    assert 'Unknown action' in data['error']

@pytest.mark.asyncio
async def testActionDispatchesToAutomationLayer(client, monkeypatch):
    """The action endpoint routes through desktop_dispatch.automate_action."""
    seen = {}

    async def fakeAutomateAction(action, params=None):
        seen['action'] = action
        seen['params'] = params or {}
        return {'ok': True, 'echo': action}
    monkeypatch.setattr('app.routers.desktop_automation.automateAction', fakeAutomateAction)
    resp = await client.post('/api/desktop-automation/action', json={'action': 'screenshot', 'params': {'x': 1}})
    assert resp.status_code == 200
    assert resp.json() == {'ok': True, 'echo': 'screenshot'}
    assert seen == {'action': 'screenshot', 'params': {'x': 1}}

@pytest.mark.asyncio
async def testGracefulDegradationWhenPyautoguiMissing(monkeypatch):
    """When pyautogui can't be imported, tools return a clear error JSON."""
    import builtins
    realImport = builtins.__import__

    def blockingImport(name, *args, **kwargs):
        if name == 'pyautogui':
            raise ImportError('simulated: pyautogui missing')
        if name == 'pygetwindow':
            raise ImportError('simulated: pygetwindow missing')
        return realImport(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', blockingImport)
    from app.services import desktopAutomation as da
    assert (await da.getScreenSize())['error'].startswith('pyautogui not installed')
    assert (await da.takeScreenshot())['error'].startswith('pyautogui not installed')
    assert await da.listWindows() == [{'note': 'pygetwindow not installed. Run `uv sync --extra desktop`.'}]