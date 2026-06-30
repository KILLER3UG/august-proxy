"""Brain Orchestrator settings-tab HTTP API tests.

Covers the four routes mounted by ``app.routers.brain_config``:

  GET  /api/brain/config                — read effective config + defaults
  PUT  /api/brain/config                — partial merge + audit
  POST /api/brain/config/reset          — clear persisted override + audit
  GET  /api/brain/config/from-session   — session-derived view

Uses the ``isolated_data`` conftest fixture so config.json and the SQLite
brain DB never touch the user's real data directory.
"""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services.memory_store import list_config_audit


# All 11 keys the React form declares (BOOLEAN_KEYS + maxAgentDepth + maxWorkbenchToolLoops).
_ALL_CAMEL_KEYS = {
    "enabled", "adaptivePolicy", "failureLearning", "graphMemory",
    "agentJobs", "hierarchicalAgents", "adapterParallelTools",
    "parallelReadTools", "reviewLearnedGuidelines",
    "maxAgentDepth", "maxWorkbenchToolLoops",
}


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest.fixture
async def client(isolated_data):
    # ``isolated_data`` resets config.json + memory_store SQLite, but the
    # workbench session store lives in a module-level dict that persists
    # across tests in the same process. Tests like ``test_workbench.py``
    # leave sessions behind, which would flip ``source`` from ``"fallback"``
    # to ``"session"`` in the tests below. Clear it explicitly.
    from app.services.workbench import workbench as wb
    wb._sessions.clear()
    wb.save_sessions()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


# ── GET /api/brain/config ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_returns_defaults_when_no_persisted(client):
    """Empty config.json → source='fallback', defaults fully populated."""
    resp = await client.get("/api/brain/config")
    assert resp.status_code == 200
    body = resp.json()

    assert body["source"] == "fallback"
    assert set(body["defaults"].keys()) == _ALL_CAMEL_KEYS
    # defaults must equal config (no overrides yet)
    assert body["config"] == body["defaults"]
    # session fields are nullable when no sessions exist
    assert body["sessionId"] in (None, "")
    assert body["session"] in (None, "")


@pytest.mark.asyncio
async def test_get_reflects_persisted_overrides(client, isolated_data, monkeypatch):
    """Manually persist a snake_case override → source='persisted' + camelCase config."""
    import json
    from app.lib.paths import data_path

    cfg_path = data_path("config.json")
    cfg_path.write_text(
        json.dumps(
            {
                "brain_orchestrator": {
                    "enabled": False,
                    "max_agent_depth": 2,
                }
            }
        ),
        "utf-8",
    )

    resp = await client.get("/api/brain/config")
    assert resp.status_code == 200
    body = resp.json()

    assert body["source"] == "persisted"
    assert body["config"]["enabled"] is False
    assert body["config"]["maxAgentDepth"] == 2
    # Defaults must remain untouched
    assert body["defaults"]["enabled"] is True
    assert body["defaults"]["maxAgentDepth"] == 4


# ── PUT /api/brain/config ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_put_merges_and_audits(client, isolated_data):
    """Valid patch merges into cfg.brain_orchestrator + writes an audit row."""
    resp = await client.put(
        "/api/brain/config",
        json={"enabled": False, "maxAgentDepth": 3},
    )
    assert resp.status_code == 200
    body = resp.json()

    assert body["ok"] is True
    assert body["config"]["enabled"] is False
    assert body["config"]["maxAgentDepth"] == 3
    # Untouched keys keep their defaults
    assert body["config"]["adaptivePolicy"] is True

    # Audit row recorded with category='brain', action='update'
    rows = list_config_audit(category="brain")
    assert any(r["action"] == "update" for r in rows)
    update = next(r for r in rows if r["action"] == "update")
    assert update["actor"] == "user"
    assert update["after"]["enabled"] is False
    assert update["after"]["max_agent_depth"] == 3


@pytest.mark.asyncio
async def test_put_rejects_unknown_key(client, isolated_data):
    """Unknown field → 400, no save, no audit row."""
    resp = await client.put("/api/brain/config", json={"notARealKey": True})
    assert resp.status_code == 400
    detail = resp.json().get("detail", {})
    assert "notARealKey" in detail.get("message", "")

    # Nothing persisted
    body = (await client.get("/api/brain/config")).json()
    assert body["source"] == "fallback"

    # No audit row
    assert not list_config_audit(category="brain")


@pytest.mark.asyncio
async def test_put_rejects_wrong_type(client, isolated_data):
    """Boolean field given a string → 400."""
    resp = await client.put("/api/brain/config", json={"enabled": "yes"})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_put_rejects_out_of_range_number(client, isolated_data):
    """maxAgentDepth outside [1,5] → 400."""
    resp = await client.put("/api/brain/config", json={"maxAgentDepth": 99})
    assert resp.status_code == 400

    resp = await client.put("/api/brain/config", json={"maxAgentDepth": 0})
    assert resp.status_code == 400


# ── POST /api/brain/config/reset ─────────────────────────────────────


@pytest.mark.asyncio
async def test_reset_clears_persisted_and_audits(client, isolated_data):
    """After reset, source returns to 'fallback' and defaults are restored."""
    # First persist something
    await client.put("/api/brain/config", json={"enabled": False})

    # Then reset
    resp = await client.post("/api/brain/config/reset")
    assert resp.status_code == 200
    body = resp.json()

    assert body["ok"] is True
    assert body["config"] == body["defaults"]
    assert body["config"]["enabled"] is True

    # GET reflects the reset
    body2 = (await client.get("/api/brain/config")).json()
    assert body2["source"] == "fallback"
    assert body2["config"]["enabled"] is True

    # Audit row recorded with action='reset'
    resets = [r for r in list_config_audit(category="brain") if r["action"] == "reset"]
    assert len(resets) == 1
    assert resets[0]["before"].get("enabled") is False
    assert resets[0]["after"] == {}


# ── GET /api/brain/config/from-session ───────────────────────────────


@pytest.mark.asyncio
async def test_from_session_returns_session_source(client, isolated_data):
    """When a workbench session exists, source='session' + session fields populated."""
    from app.services.workbench import workbench as wb

    sess = wb.create_workbench_session(provider="anthropic", goal="draft release notes")

    resp = await client.get(
        "/api/brain/config/from-session",
        params={"sessionId": sess.id},
    )
    assert resp.status_code == 200
    body = resp.json()

    assert body["source"] == "session"
    assert body["sessionId"] == sess.id
    assert body["session"]["id"] == sess.id
    # goal was mapped to task (the dataclass has no task field)
    assert body["session"]["task"] == "draft release notes"


@pytest.mark.asyncio
async def test_from_session_requires_session_id(client):
    """Missing sessionId → 400 (FastAPI's Query(..., min_length=1) enforces it)."""
    resp = await client.get("/api/brain/config/from-session")
    # FastAPI returns 422 for missing required Query params
    assert resp.status_code in (400, 422)