"""Part 25 Phase 4 — Arena/Debate routing-evidence endpoints (the missing
backend the live UIs call). POST a verdict → winner ok=1 + losers ok=0 rows;
GET history + win-rate suggestions."""

from __future__ import annotations

import pytest


@pytest.fixture()
def client(isolatedData):
    from app.main import app
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        yield c


def test_record_and_read_arena_verdict(client):
    body = {
        'sessionId': 'sess_1',
        'prompt': 'write a python decorator',
        'winner': {'modelId': 'gpt-x', 'provider': 'p1'},
        'losers': [{'modelId': 'claude-y', 'provider': 'p2'}],
    }
    r = client.post('/api/brain/routing/arena', json=body)
    assert r.status_code == 200, r.text
    assert r.json()['recorded'] == 2  # winner + one loser

    hist = client.get('/api/brain/routing/arena')
    assert hist.status_code == 200
    results = hist.json()['results']
    assert len(results) == 2
    winner = next(x for x in results if x['model'] == 'gpt-x')
    loser = next(x for x in results if x['model'] == 'claude-y')
    assert winner['won'] is True and loser['won'] is False
    assert winner['prompt'] == 'write a python decorator'


def test_suggestions_rank_by_win_rate(client):
    # gpt-x wins twice, claude-y loses twice → gpt-x tops the suggestions.
    for _ in range(2):
        client.post(
            '/api/brain/routing/arena',
            json={
                'sessionId': 's',
                'prompt': 'p',
                'winner': {'modelId': 'gpt-x', 'provider': 'p1'},
                'losers': [{'modelId': 'claude-y', 'provider': 'p2'}],
            },
        )
    sug = client.get('/api/brain/routing/suggestions?prompt=p')
    assert sug.status_code == 200
    suggestions = sug.json()['suggestions']
    assert suggestions and suggestions[0]['modelId'] == 'gpt-x'
    assert suggestions[0]['winRate'] == 1.0
    assert suggestions[0]['wins'] == 2 and suggestions[0]['total'] == 2


def test_verdict_requires_winner(client):
    r = client.post('/api/brain/routing/arena', json={'sessionId': 's', 'prompt': 'p'})
    assert r.status_code == 400
