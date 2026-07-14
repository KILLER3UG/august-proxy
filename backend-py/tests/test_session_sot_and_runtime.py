"""Session SQLite store + curator/subagent runtime bootstraps."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.lib import paths
    from app.config import settings
    from app.services import memory_store
    from app.services.workbench import sessions as sess_mod

    monkeypatch.setattr(paths, 'dataDir', lambda: tmp_path)
    settings.dataDir = tmp_path
    settings._config = {}
    # Reset in-memory session store between tests
    sess_mod._sessions.clear()
    from app.services import automations_store
    from app.services import runtime_services

    automations_store.reset_store()
    # Force runtime re-bind for new data dir
    runtime_services._curator = None
    runtime_services._orchestrator = None
    runtime_services._bus = None
    memory_store.init()

    from app.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


@pytest.mark.asyncio
async def test_curator_and_subagents_no_longer_503(client):
    r = await client.get('/api/curator/usage')
    assert r.status_code == 200, r.text
    assert 'usage' in r.json()

    r2 = await client.get('/api/subagents/active')
    assert r2.status_code == 200, r2.text
    assert 'agents' in r2.json()


@pytest.mark.asyncio
async def test_session_sot_sqlite_blob(client, tmp_path):
    from app.services.memory_store import list_workbench_blobs, get_session
    from app.services.workbench import sessions as sess_mod

    sess_mod._sessions.clear()
    r = await client.post('/api/workbench/session', json={'provider': '', 'agentId': 'build'})
    assert r.status_code == 200
    sid = r.json()['id']

    # SQLite should hold the full session blob.
    blobs = list_workbench_blobs()
    assert any(b.get('id') == sid for b in blobs), blobs

    rec = get_session(sid)
    assert rec is not None

    # Reload from SQLite into empty memory.
    sess_mod._sessions.clear()
    loaded = sess_mod.get_workbench_session(sid)
    assert loaded is not None
    assert loaded.id == sid


@pytest.mark.asyncio
async def test_automations_durable(client, tmp_path):
    r = await client.post(
        '/api/automations',
        json={'name': 'echo-test', 'command': 'echo hi', 'enabled': True},
    )
    assert r.status_code == 200, r.text
    job = r.json()
    assert job.get('id')
    assert (tmp_path / 'automations.json').exists()

    r2 = await client.get('/api/automations')
    assert r2.status_code == 200
    assert any(j['id'] == job['id'] for j in r2.json().get('jobs', []))


@pytest.mark.asyncio
async def test_live_session_real_workbench_id(client):
    r = await client.post('/api/live/session', json={'action': 'start'})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get('sessionId', '').startswith('wb_')
    assert data.get('status') == 'started'


@pytest.mark.asyncio
async def test_btw_honest_without_provider(client):
    r = await client.post('/api/workbench/session', json={})
    sid = r.json()['id']
    r2 = await client.post(
        '/api/workbench/btw',
        json={'sessionId': sid, 'question': 'hello?'},
    )
    # 503 is honest when no provider/key — not a fake offline answer
    assert r2.status_code in (200, 503), r2.text
    if r2.status_code == 503:
        assert 'provider' in r2.text.lower() or 'BTW' in r2.text or 'configured' in r2.text.lower()
