from httpx import ASGITransport, AsyncClient
from app.main import app


async def test_gateway_status_includes_platforms_and_install_hint():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/api/gateway/status')
        assert resp.status_code == 200
        data = resp.json()
        assert 'platforms' in data
        assert 'installHint' in data
        names = {p['platform'] for p in data['platforms']}
        assert {'telegram', 'slack', 'discord'} <= names
