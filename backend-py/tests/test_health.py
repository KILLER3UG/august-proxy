"""Health endpoint tests."""

from app.main import app
from httpx import ASGITransport, AsyncClient


async def testHealthReturnsOk():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/api/health')
        assert resp.status_code == 200
        data = resp.json()
        assert data['status'] == 'ok'
        assert data['python'] is True


async def testHealthDetailed():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/api/health/detailed')
        assert resp.status_code == 200
        data = resp.json()
        assert data['status'] == 'ok'
        assert data['mode'] == 'python'
