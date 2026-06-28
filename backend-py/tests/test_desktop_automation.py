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
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.mark.asyncio
async def test_health_reports_capability(client):
    resp = await client.get("/api/desktop-automation/health")
    assert resp.status_code == 200
    data = resp.json()
    assert set(data.keys()) >= {"platform", "overall", "checks", "timestamp"}
    assert data["overall"] in ("ok", "error")
    assert isinstance(data["checks"], list)
    assert len(data["checks"]) >= 1
    # Each check carries the shape the frontend renders.
    for c in data["checks"]:
        assert {"name", "status", "message", "details"} <= set(c.keys())


@pytest.mark.asyncio
async def test_config_shape(client):
    resp = await client.get("/api/desktop-automation/config")
    assert resp.status_code == 200
    data = resp.json()
    # The legacy page expected backend "cua"; we now report the real engine.
    assert data["backend"] == "pyautogui"
    assert "enabled" in data
    assert isinstance(data["auto_approve"], list)
    assert isinstance(data["blocklist_keys"], list)
    assert isinstance(data["blocklist_patterns"], list)


@pytest.mark.asyncio
async def test_action_unknown_returns_error(client):
    resp = await client.post(
        "/api/desktop-automation/action",
        json={"action": "definitely-not-a-real-action", "params": {}},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "error" in data
    assert "Unknown action" in data["error"]


@pytest.mark.asyncio
async def test_action_dispatches_to_automation_layer(client, monkeypatch):
    """The action endpoint routes through desktop_dispatch.automate_action."""
    seen = {}

    async def fake_automate_action(action, params=None):
        seen["action"] = action
        seen["params"] = params or {}
        return {"ok": True, "echo": action}

    monkeypatch.setattr(
        "app.routers.desktop_automation.automate_action", fake_automate_action
    )
    resp = await client.post(
        "/api/desktop-automation/action",
        json={"action": "screenshot", "params": {"x": 1}},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "echo": "screenshot"}
    assert seen == {"action": "screenshot", "params": {"x": 1}}


@pytest.mark.asyncio
async def test_graceful_degradation_when_pyautogui_missing(monkeypatch):
    """When pyautogui can't be imported, tools return a clear error JSON."""
    import builtins

    real_import = builtins.__import__

    def blocking_import(name, *args, **kwargs):
        if name == "pyautogui":
            raise ImportError("simulated: pyautogui missing")
        if name == "pygetwindow":
            raise ImportError("simulated: pygetwindow missing")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocking_import)

    from app.services import desktop_automation as da

    assert (await da.get_screen_size())["error"].startswith("pyautogui not installed")
    assert (await da.take_screenshot())["error"].startswith("pyautogui not installed")
    assert await da.list_windows() == [{"note": "pygetwindow not installed. Run `uv sync --extra desktop`."}]
