"""POST /api/automations is a partial upsert, not a full replace.

``UpsertBody`` used to default every field (``model: str = ''``,
``timeout_ms: int = 60000``, ``paused: bool = False``, ``timezone: str = ''``)
and ``automations_store._merge_upsert`` merges with ``{**existing, **job}`` —
so a body that mentioned only the field being edited rewrote everything else to
its default. Two live surfaces do exactly that: the Automations page's edit
form and a Bot's routines pane. The observable consequences were a job losing
its pinned model, its timeout, its schedule timezone, and — worst — resuming a
job the user had paused.

The store's own merge logic keys off *presence* (``'schedule' in job``,
``job.get('paused', existing.get('paused'))``), which is what these tests pin:
absent means unchanged, and the runner's defaults (not the router's) answer for
fields a created job never set.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

FULL_BODY = {
    'name': 'Nightly triage',
    'schedule': '17 3 * * *',
    'jobType': 'workbench',
    'prompt': 'Summarize yesterday failures',
    'model': 'qwen3-test',
    'modelProvider': 'deepseek',
    'agentId': 'agent-9',
    'timezone': 'Asia/Tokyo',
    'timeoutMs': 240000,
    'maxRuns': 5,
    'deliver': 'bot-chat',
    'respond': False,
    'continuity': True,
    'approvalRequired': True,
}

# The fields a one-field edit must not touch, with the value the body above set.
PRESERVED = {
    'model': 'qwen3-test',
    'modelProvider': 'deepseek',
    'agentId': 'agent-9',
    'timezone': 'Asia/Tokyo',
    'timeoutMs': 240000,
    'maxRuns': 5,
    'deliver': 'bot-chat',
    'respond': False,
    'continuity': True,
    'approvalRequired': True,
    'name': 'Nightly triage',
    'schedule': '17 3 * * *',
    'jobType': 'workbench',
}


def _client():
    from app.main import app

    return TestClient(app)


def _create(client: TestClient) -> str:
    resp = client.post('/api/automations', json=FULL_BODY)
    assert resp.status_code == 200, resp.text
    return str(resp.json()['id'])


def _job(client: TestClient, job_id: str) -> dict[str, object]:
    listed = client.get('/api/automations').json()['jobs']
    matches = [j for j in listed if j['id'] == job_id]
    assert matches, f'{job_id} disappeared from the list'
    return dict(matches[0])


def test_partial_upsert_preserves_fields_the_body_omits(isolatedData):
    client = _client()
    job_id = _create(client)

    resp = client.post('/api/automations', json={'id': job_id, 'prompt': 'Triage open bugs first'})
    assert resp.status_code == 200, resp.text

    job = _job(client, job_id)
    assert job['prompt'] == 'Triage open bugs first'
    for field, value in PRESERVED.items():
        assert job[field] == value, f'{field} was rewritten by an edit that never mentioned it'


def test_partial_upsert_does_not_resume_a_paused_job(isolatedData):
    client = _client()
    job_id = _create(client)
    assert client.patch(f'/api/automations/{job_id}', json={'paused': True}).status_code == 200

    client.post('/api/automations', json={'id': job_id, 'name': 'Renamed'})

    job = _job(client, job_id)
    assert job['paused'] is True
    assert job['name'] == 'Renamed'


def test_upsert_without_job_type_keeps_a_shell_job_a_shell_job(isolatedData):
    client = _client()
    created = client.post(
        '/api/automations',
        json={'name': 'Run tests', 'schedule': 'every 2h', 'jobType': 'shell', 'command': 'pytest -q'},
    )
    assert created.status_code == 200, created.text
    job_id = str(created.json()['id'])

    client.post('/api/automations', json={'id': job_id, 'command': 'pytest -x'})

    job = _job(client, job_id)
    assert job['jobType'] == 'shell'
    assert job['command'] == 'pytest -x'


def test_explicit_empty_value_still_clears_a_field(isolatedData):
    """'' must clear — otherwise the filter swallows a deliberate un-pin."""
    client = _client()
    job_id = _create(client)

    client.post('/api/automations', json={'id': job_id, 'model': '', 'modelProvider': ''})

    job = _job(client, job_id)
    assert not job['model']
    assert job['agentId'] == 'agent-9'


def test_create_without_optional_fields_gets_no_phantom_values(isolatedData):
    client = _client()
    created = client.post(
        '/api/automations',
        json={'prompt': 'Summarize the inbox', 'schedule': 'every 30m'},
    )
    assert created.status_code == 200, created.text
    job = _job(client, str(created.json()['id']))

    # Nothing was sent for these, so the job carries no value for them; the
    # runner supplies its own default at execution time.
    assert not job['model']
    assert not job['deliver']
    assert not job['timeoutMs']
    assert job['jobType'] == 'workbench'
    assert job['name'] == 'Summarize the inbox'
    assert job['nextRunAt']
