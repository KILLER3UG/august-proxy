"""Regression: path param names must match handler args (FastAPI 422 otherwise)."""

import pytest
from httpx import ASGITransport, AsyncClient
from app.main import app


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


@pytest.mark.asyncio
async def test_session_agents_path_accepts_session_id(client):
    """GET /sessions/{sessionId}/agents must not 422 on missing query sessionId."""
    resp = await client.get('/api/workbench/sessions/wb_nonexistent_test/agents')
    # 200 with empty agents is fine; 422 means path/param name mismatch.
    assert resp.status_code != 422, resp.text
    assert resp.status_code == 200
    data = resp.json()
    assert 'agents' in data
    assert isinstance(data['agents'], list)


@pytest.mark.asyncio
async def test_session_status_path_still_works(client):
    resp = await client.get('/api/workbench/sessions/wb_nonexistent_test/status')
    # Missing session → 404; must not be 422.
    assert resp.status_code != 422, resp.text
