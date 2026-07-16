from httpx import ASGITransport, AsyncClient
from app.main import app


async def test_live_config_defaults_browser_mode(isolatedData):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        resp = await client.get('/api/config/live')
        assert resp.status_code == 200
        data = resp.json()
        assert data.get('sttReady') is False
        assert data.get('ttsReady') is False
        assert data.get('sttMode') == 'browser'
