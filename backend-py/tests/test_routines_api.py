"""Part 19 Phase B — routine fields on the automations API + RoutinesPane data.

The runner path already honors ``deliver`` / ``respond`` / ``continuity``
(``automations_store._run_workbench_stream`` + ``automation_memory``), but the
HTTP API surface dropped them — a UI could never CREATE a routine that
delivers into a Bot's chat. These tests pin the router fix (Phase B's
"Routines pane" prerequisite) using the same TestClient shape as
``test_bot_mode_router.py``.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def _client():
    from app.main import app

    return TestClient(app)


def _ensure_bot(client: TestClient, name: str) -> str:
    created = client.post('/api/agents', json={'name': name, 'title': f'{name} Bot'})
    assert created.status_code == 200, created.text
    return str(created.json()['id'])


def test_upsert_accepts_routine_fields(isolatedData):
    client = _client()
    agent_id = _ensure_bot(client, 'routinetest')

    resp = client.post(
        '/api/automations',
        json={
            'name': '[bot:routinetest] morning brief',
            'schedule': 'daily 09:00',
            'jobType': 'workbench',
            'prompt': 'Summarize my open threads.',
            'agentId': agent_id,
            'deliver': 'bot-chat',
            'respond': True,
            'continuity': True,
        },
    )
    assert resp.status_code == 200, resp.text
    job = resp.json()
    assert job['deliver'] == 'bot-chat'
    assert job['respond'] is True
    assert job['continuity'] is True
    assert job['agentId'] == agent_id

    listed = client.get('/api/automations').json()
    mine = [j for j in listed['jobs'] if j['id'] == job['id']]
    assert mine and mine[0]['deliver'] == 'bot-chat'


def test_upsert_defaults_for_plain_automation(isolatedData):
    """A plain automation (no deliver) is unchanged — deliver stays '' and
    the job never routes into a Bot chat."""
    client = _client()
    resp = client.post(
        '/api/automations',
        json={'name': 'plain job', 'schedule': 'every 1h', 'prompt': 'ping'},
    )
    assert resp.status_code == 200, resp.text
    job = resp.json()
    # Plain automation: no chat routing. ``respond`` echoes its default
    # (harmless — ``deliver`` is the routing gate), so only pin deliver.
    assert job.get('deliver', '') == ''


def test_patch_roundtrips_routine_fields(isolatedData):
    client = _client()
    agent_id = _ensure_bot(client, 'patchtest')
    created = client.post(
        '/api/automations',
        json={
            'name': '[bot:patchtest] ticker',
            'schedule': 'every 2h',
            'prompt': 'check',
            'agentId': agent_id,
            'deliver': 'bot-chat',
        },
    ).json()
    patched = client.patch(
        f"/api/automations/{created['id']}",
        json={'respond': False, 'continuity': True},
    )
    assert patched.status_code == 200, patched.text
    job = patched.json()
    assert job['respond'] is False
    assert job['continuity'] is True
    assert job['deliver'] == 'bot-chat'
