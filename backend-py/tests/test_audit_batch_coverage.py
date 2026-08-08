"""Coverage for surfaces added in the 0.13 audit batches (no tests existed):

- /api/privacy/* (summary, export, purge, clear-logs, delete-usage, delete-sessions)
- /api/providers/health new {results, at} shape
- /api/brain/heuristics/{id}/trail + /rollback (versioned heuristics)
- /api/brain/routing/best-by-task + /decisions (auto-routing audit trail)
- /api/brain/harness/evals + /evals/run endpoints
- health_monitor.sync_providers diff-registration
"""

from __future__ import annotations

import pytest
from app.main import app
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client(isolatedData):
    from app.services.workbench import workbench as wb

    wb._sessions.clear()
    wb.saveSessions()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


# ── /api/privacy/* ───────────────────────────────────────────────────────


async def test_privacy_summary_shape(client):
    resp = await client.get('/api/privacy/summary')
    assert resp.status_code == 200
    counts = resp.json()['counts']
    for key in (
        'facts',
        'autoMemories',
        'heuristics',
        'sessions',
        'messages',
        'usageEvents',
        'auditEvents',
        'observations',
        'dbSizeBytes',
    ):
        assert key in counts, f'missing {key}'


async def test_privacy_export_writes_file(client, isolatedData):
    resp = await client.post('/api/privacy/export')
    assert resp.status_code == 200
    body = resp.json()
    assert body['path']
    assert body['bytes'] > 0
    assert 'entries' in body


async def test_privacy_purge_memories_and_usage(client):
    # Seed a fact + a usage event, then purge and confirm they're gone.
    from app.services.memory_store import _conn

    conn = _conn()
    conn.execute(
        "INSERT OR REPLACE INTO facts (fact_key, fact_value, category) VALUES ('audit-fact', 'v', 'general')"
    )
    conn.execute(
        "INSERT INTO usage_events (session_id, model, input_tokens, output_tokens) VALUES ('s1', 'm', 1, 1)"
    )
    conn.commit()

    resp = await client.post('/api/privacy/purge-memories')
    assert resp.status_code == 200
    assert resp.json()['deleted'].get('facts', 0) >= 1

    resp = await client.post('/api/privacy/delete-usage')
    assert resp.status_code == 200
    assert resp.json()['deleted'].get('usage_events', 0) >= 1

    row = conn.execute("SELECT COUNT(*) FROM facts WHERE fact_key = 'audit-fact'").fetchone()
    assert row[0] == 0


async def test_privacy_clear_logs_and_delete_sessions(client):
    resp = await client.post('/api/privacy/clear-logs')
    assert resp.status_code == 200
    assert 'deleted' in resp.json()

    resp = await client.post('/api/privacy/delete-sessions')
    assert resp.status_code == 200
    assert 'workbenchSessions' in resp.json()['deleted']


# ── /api/providers/health shape ──────────────────────────────────────────


async def test_providers_health_returns_results_shape(client):
    """The desktop polls {results, at} — the old {'status':'ok'} shape was
    the bug that made the Health dot never render."""
    resp = await client.get('/api/providers/health')
    assert resp.status_code == 200
    body = resp.json()
    assert 'results' in body
    assert 'at' in body
    assert isinstance(body['results'], list)


# ── heuristic version trail + rollback ───────────────────────────────────


async def test_heuristic_trail_and_rollback(client):
    from app.services.heuristics_service import addHeuristic, listHeuristics

    rid = addHeuristic('audit rollback v1', source='test', category='general')
    assert rid is not None
    from app.services.heuristics_service import updateHeuristic

    assert updateHeuristic(rid, 'audit rollback v2')

    trail = await client.get(f'/api/brain/heuristics/{rid}/trail')
    assert trail.status_code == 200
    actions = [e['action'] for e in trail.json()['trail']]
    assert 'edit' in actions and 'add' in actions

    rb = await client.post(f'/api/brain/heuristics/{rid}/rollback')
    assert rb.status_code == 200
    assert rb.json()['rolledBack'] is True
    current = [h for h in listHeuristics() if h['id'] == rid][0]
    assert current['rule'] == 'audit rollback v1'

    # Second rollback has nothing earlier → False (not an error).
    rb2 = await client.post(f'/api/brain/heuristics/{rid}/rollback')
    assert rb2.json()['rolledBack'] is False

    from app.services.heuristics_service import removeHeuristicById

    removeHeuristicById(rid)


# ── auto-routing audit endpoints ─────────────────────────────────────────


async def test_routing_best_by_task_and_decisions(client):
    from app.services.routing_evidence import record_turn

    record_turn(session_id='s', task_type='tests', model='m-a', provider='p', ok=True)
    record_turn(session_id='s', task_type='tests', model='m-b', provider='p', ok=False)

    resp = await client.get('/api/brain/routing/best-by-task?minSamples=1')
    assert resp.status_code == 200
    rows = resp.json()['results']
    assert any(r['taskType'] == 'tests' for r in rows)

    resp = await client.get('/api/brain/routing/decisions')
    assert resp.status_code == 200
    assert isinstance(resp.json()['decisions'], list)


# ── harness evals endpoints ──────────────────────────────────────────────


async def test_harness_evals_endpoints(client):
    resp = await client.get('/api/brain/harness/evals?limit=5')
    assert resp.status_code == 200
    body = resp.json()
    assert 'runs' in body and 'passRate' in body

    resp = await client.post('/api/brain/harness/evals/run')
    assert resp.status_code == 200
    assert resp.json()['started'] is True


# ── health_monitor.sync_providers ────────────────────────────────────────


def test_sync_providers_diff_registration(isolatedData):
    from app.services.health_monitor import health_monitor

    health_monitor.sync_providers(
        [{'id': 'p1', 'name': 'P1', 'enabled': True, 'baseUrl': 'https://a.example'},
         {'id': 'p2', 'name': 'P2', 'enabled': False, 'baseUrl': 'https://b.example'}]
    )
    health = {h['providerId'] for h in health_monitor.get_all_health()}
    assert 'p1' in health  # enabled + keyed
    assert 'p2' not in health  # disabled → dropped

    # Removing p1 from the store unregisters it (self-healing diff).
    health_monitor.sync_providers([])
    health = {h['providerId'] for h in health_monitor.get_all_health()}
    assert 'p1' not in health
