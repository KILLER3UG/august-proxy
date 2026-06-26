"""Route integration tests using FastAPI TestClient."""
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.mark.asyncio
async def test_health(client):
    resp = await client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_providers_list(client):
    resp = await client.get("/api/providers")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) >= 1


@pytest.mark.asyncio
async def test_models_list(client):
    resp = await client.get("/api/models")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] >= 1


@pytest.mark.asyncio
async def test_v1_models(client):
    resp = await client.get("/v1/models")
    assert resp.status_code == 200
    data = resp.json()
    assert data["object"] == "list"


@pytest.mark.asyncio
async def test_skills(client):
    resp = await client.get("/api/skills")
    assert resp.status_code == 200
    data = resp.json()
    assert "skills" in data


@pytest.mark.asyncio
async def test_workbench_sessions(client):
    resp = await client.get("/api/workbench/sessions")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)


@pytest.mark.asyncio
async def test_workbench_activity(client):
    resp = await client.get("/api/workbench/activity")
    assert resp.status_code == 200
    data = resp.json()
    assert "sessions" in data


@pytest.mark.asyncio
async def test_workbench_capabilities(client):
    resp = await client.get("/api/workbench/capabilities")
    assert resp.status_code == 200
    data = resp.json()
    assert "workbench_tools" in data


@pytest.mark.asyncio
async def test_api_sessions_list(client):
    resp = await client.get("/api/sessions")
    assert resp.status_code == 200
    data = resp.json()
    assert "sessions" in data


@pytest.mark.asyncio
async def test_api_sessions_create(client):
    resp = await client.post("/api/sessions")
    assert resp.status_code == 200
    data = resp.json()
    assert "id" in data
    # Cleanup
    session_id = data["id"]
    await client.delete(f"/api/sessions/{session_id}")


@pytest.mark.asyncio
async def test_api_agents_list(client):
    resp = await client.get("/api/agents")
    assert resp.status_code == 200
    data = resp.json()
    assert "agents" in data


@pytest.mark.asyncio
async def test_api_mcp_servers(client):
    resp = await client.get("/api/mcp/servers")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_api_audit(client):
    resp = await client.get("/api/audit")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_api_usage(client):
    resp = await client.get("/api/usage")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_api_cron(client):
    resp = await client.get("/api/cron")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_api_git_status(client):
    resp = await client.get("/api/git/status")
    # May fail if not in a git repo, but should return a response
    assert resp.status_code in (200, 400, 500)


@pytest.mark.asyncio
async def test_api_terminal(client):
    resp = await client.get("/api/terminal")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_api_memory_kv(client):
    """Test memory KV endpoint lifecycle."""
    # Save
    resp = await client.post("/api/memory/kv", json={"key": "route_test", "value": "works"})
    assert resp.status_code == 200

    # Get
    resp = await client.get("/api/memory/kv/route_test")
    assert resp.status_code == 200
    assert resp.json()["value"] == "works"

    # List
    resp = await client.get("/api/memory/kv")
    assert resp.status_code == 200

    # Search
    resp = await client.get("/api/memory/search?query=works")
    assert resp.status_code == 200
    assert resp.json()["count"] >= 1

    # Delete
    resp = await client.delete("/api/memory/kv/route_test")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_api_memory_facts(client):
    """Test memory facts endpoint lifecycle."""
    # Save
    resp = await client.post("/api/memory/facts", json={
        "fact_key": "route_fact", "fact_value": "fact_value", "category": "test",
    })
    assert resp.status_code == 200

    # List
    resp = await client.get("/api/memory/facts")
    assert resp.status_code == 200
    assert resp.json()["facts"] is not None

    # Get
    resp = await client.get("/api/memory/facts/route_fact")
    assert resp.status_code == 200

    # Delete
    resp = await client.delete("/api/memory/facts/route_fact")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_api_memory_proposals(client):
    """Test proposals endpoint lifecycle."""
    # Create
    resp = await client.post("/api/memory/proposals", json={
        "session_id": "route_s1", "proposal_type": "plan", "content": {"x": 1},
    })
    assert resp.status_code == 200
    pid = resp.json()["id"]

    # Get
    resp = await client.get(f"/api/memory/proposals/{pid}")
    assert resp.status_code == 200
    assert resp.json()["status"] == "pending"

    # Decide
    resp = await client.post(f"/api/memory/proposals/{pid}/decide", json={
        "status": "approved", "decided_by": "test",
    })
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_api_memory_stats(client):
    resp = await client.get("/api/memory/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert "memory_store" in data
