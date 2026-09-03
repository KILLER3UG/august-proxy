"""Bot Mode Phase A — /api/agents/bots router surface.

Roster list, uiMeta merge, avatar endpoint, canonical-chat resolution, and
the default-bot backfill — exercised through the FastAPI TestClient.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def _client():
    from app.main import app

    return TestClient(app)


def test_bots_router_roundtrip(isolatedData):
    client = _client()

    created = client.post(
        '/api/agents',
        json={'name': 'Researcher', 'title': 'Research Buddy', 'role': 'Research.'},
    )
    assert created.status_code == 200, created.text
    bot = created.json()
    assert bot['uiMeta']['title'] == 'Research Buddy'
    agent_id = bot['id']

    listed = client.get('/api/agents/bots')
    assert listed.status_code == 200
    names = [b['name'] for b in listed.json()['bots']]
    assert 'Researcher' in names

    one = client.get(f'/api/agents/bots/{agent_id}')
    assert one.status_code == 200
    assert one.json()['uiMeta']['title'] == 'Research Buddy'

    # uiMeta merge: update one leaf, the others survive.
    upd = client.put(
        f'/api/agents/bots/{agent_id}/ui-meta', json={'hidden': True, 'groups': ['team-a']}
    )
    assert upd.status_code == 200
    meta = upd.json()['uiMeta']
    assert meta['hidden'] is True
    assert meta['title'] == 'Research Buddy', 'merge must not drop untouched leaves'
    assert meta['groups'] == ['team-a']

    # Create-with-title is idempotent on name (roster stays one row).
    again = client.post('/api/agents', json={'name': 'Researcher', 'title': 'X'})
    assert again.json()['id'] == agent_id


def test_avatar_endpoint(isolatedData):
    client = _client()
    res = client.get('/api/agents/bots/avatar', params={'name': 'Researcher'})
    assert res.status_code == 200
    svg = res.json()['svg']
    assert svg.startswith('<svg')


def test_canonical_chat_endpoint(isolatedData):
    client = _client()
    bot = client.post('/api/agents', json={'name': 'Scribe', 'title': 'S'}).json()
    agent_id = bot['id']

    created = client.post(f'/api/agents/bots/{agent_id}/chat')
    assert created.status_code == 200
    session_id = created.json()['sessionId']

    # Idempotent: create-again resolves the same chat.
    again = client.post(f'/api/agents/bots/{agent_id}/chat')
    assert again.json()['sessionId'] == session_id

    resolved = client.get(f'/api/agents/bots/{agent_id}/chat')
    assert resolved.status_code == 200
    assert resolved.json()['sessionId'] == session_id


def test_ensure_default_bot(isolatedData):
    client = _client()
    first = client.post('/api/agents/bots/ensure-default')
    assert first.status_code == 200
    second = client.post('/api/agents/bots/ensure-default')
    assert second.json()['id'] == first.json()['id']

    # Default bot is undeletable.
    res = client.delete(f"/api/agents/bots/{first.json()['id']}")
    assert res.status_code == 400


def test_delete_bot(isolatedData):
    client = _client()
    bot = client.post('/api/agents', json={'name': 'Temp', 'title': 'T'}).json()
    res = client.delete(f"/api/agents/bots/{bot['id']}")
    assert res.status_code == 200
    gone = client.get(f"/api/agents/bots/{bot['id']}")
    assert gone.status_code == 404