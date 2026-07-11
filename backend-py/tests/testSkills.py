"""Skill endpoint tests."""

from httpx import AsyncClient, ASGITransport
from app.main import app


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
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/v1/models')
        assert resp.status_code == 200
        data = resp.json()
        assert data['object'] == 'list'
        assert len(data['data']) > 0
