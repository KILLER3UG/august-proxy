"""Skill endpoint tests."""
from httpx import AsyncClient, ASGITransport
from app.main import app


async def test_skills_list():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/ui/skills")
        assert resp.status_code == 200
        data = resp.json()
        assert "skills" in data
        assert data["total"] > 0


async def test_skills_search():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/ui/skills?q=debug")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] >= 0


async def test_models_list():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/models")
        assert resp.status_code == 200
        data = resp.json()
        assert "models" in data
        assert data["total"] > 0


async def test_v1_models():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/v1/models")
        assert resp.status_code == 200
        data = resp.json()
        assert data["object"] == "list"
        assert len(data["data"]) > 0
