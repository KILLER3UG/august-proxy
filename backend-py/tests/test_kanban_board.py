"""Agent board: durable store + HTTP surface.

The board used to live only in the desktop's localStorage while its header
claimed a "durable kanban across agents and jobs". These tests pin the durable
half — one shared store, reached over /api/kanban, whose columns and card
identity survive a reload and are readable by the model-facing tools.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def _client() -> TestClient:
    from app.main import app

    return TestClient(app)


def _add(client: TestClient, title: str, **fields: object) -> dict:
    resp = client.post('/api/kanban', json={'title': title, **fields})
    assert resp.status_code == 200, resp.text
    return dict(resp.json())


def test_round_trip_keeps_columns_and_agent_fields(isolatedData):
    client = _client()
    card = _add(client, 'Wire the retry policy', column='doing', agentId='agent-7', taskId='t-1')
    assert card['column'] == 'doing'
    assert card['agentId'] == 'agent-7'
    assert card['taskId'] == 't-1'
    assert card['id'].startswith('kb_')

    listed = client.get('/api/kanban').json()
    assert [c['id'] for c in listed['cards']] == [card['id']]
    assert set(listed['columns']) == {'backlog', 'doing', 'review', 'done'}


def test_moves_are_persisted_and_unknown_columns_rejected(isolatedData):
    client = _client()
    card = _add(client, 'Review the migration')

    moved = client.patch(f"/api/kanban/{card['id']}", json={'column': 'review'})
    assert moved.status_code == 200, moved.text
    assert moved.json()['column'] == 'review'
    assert client.get('/api/kanban').json()['cards'][0]['column'] == 'review'

    bad = client.patch(f"/api/kanban/{card['id']}", json={'column': 'shredded'})
    assert bad.status_code == 400
    assert client.get('/api/kanban').json()['cards'][0]['column'] == 'review', (
        'a rejected move must not half-apply'
    )


def test_missing_card_and_empty_title_are_refused(isolatedData):
    client = _client()
    assert client.patch('/api/kanban/kb_nope', json={'column': 'done'}).status_code == 404
    assert client.delete('/api/kanban/kb_nope').status_code == 404
    assert client.post('/api/kanban', json={'title': '   '}).status_code == 400


def test_card_survives_a_store_reload(isolatedData):
    """'Durable' means the file, not the process cache."""
    from app.services import kanban_store

    client = _client()
    card = _add(client, 'Persist me', column='review')
    kanban_store.reset_store()
    assert [c['id'] for c in client.get('/api/kanban').json()['cards']] == [card['id']]


def test_clear_done_only_drops_done(isolatedData):
    client = _client()
    keep = _add(client, 'Still open')
    _add(client, 'Finished', column='done')

    resp = client.post('/api/kanban/clear-done')
    assert resp.status_code == 200 and resp.json()['removed'] == 1
    assert [c['id'] for c in client.get('/api/kanban').json()['cards']] == [keep['id']]


def test_import_merges_a_browser_board_without_duplicates(isolatedData):
    client = _client()
    server = _add(client, 'Created on the server', column='done')

    resp = client.post(
        '/api/kanban/import',
        json={
            'cards': [
                {'id': server['id'], 'title': 'Stale tab overwrites', 'column': 'doing'},
                {'id': 'kb_local1', 'title': 'From localStorage', 'column': 'review'},
                {'title': ''},
                'not-an-object',
            ]
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()['added'] == 1, 'only the genuinely new, titled card lands'
    # A body that is not a list is a client bug, not something to swallow.
    assert client.post('/api/kanban/import', json={'cards': 'everything'}).status_code == 422

    cards = {c['id']: c for c in client.get('/api/kanban').json()['cards']}
    assert cards[server['id']]['title'] == 'Created on the server', (
        'server cards win over a stale client copy'
    )
    assert cards['kb_local1']['column'] == 'review'
    assert len(cards) == 2


def test_import_is_idempotent_on_retry(isolatedData):
    client = _client()
    payload = {'cards': [{'id': 'kb_x', 'title': 'Once', 'column': 'backlog'}]}
    assert client.post('/api/kanban/import', json=payload).json()['added'] == 1
    assert client.post('/api/kanban/import', json=payload).json()['added'] == 0
    assert len(client.get('/api/kanban').json()['cards']) == 1


def test_column_filter(isolatedData):
    client = _client()
    _add(client, 'A', column='doing')
    _add(client, 'B', column='backlog')
    doing = client.get('/api/kanban', params={'column': 'doing'}).json()['cards']
    assert [c['title'] for c in doing] == ['A']
