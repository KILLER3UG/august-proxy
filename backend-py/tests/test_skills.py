"""Skill endpoint tests."""

from app.main import app
from httpx import ASGITransport, AsyncClient


async def testSkillsList():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/api/skills')
        assert resp.status_code == 200
        data = resp.json()
        assert 'skills' in data
        assert data['total'] > 0


async def testSkillsSearch():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/api/skills?q=debug')
        assert resp.status_code == 200
        data = resp.json()
        assert data['total'] >= 0


async def testModelsList():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/api/models')
        assert resp.status_code == 200
        data = resp.json()
        assert 'models' in data
        assert data['total'] > 0


async def testV1Models():
    # /v1/models is part of the gated external surface — closed by default
    # (external access disabled → 403), like every other /v1/* endpoint
    # (audit finding: the route previously served unauthenticated).
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/v1/models')
        assert resp.status_code == 403
