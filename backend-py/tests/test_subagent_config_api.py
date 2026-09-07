"""Settings → Subagents delegation config (GET/POST /api/subagents/config).

The settings panel posts with NO session id — that used to 400
('sessionId is required') so every Save failed. Delegation limits are now a
GLOBAL brain_config layer (subagentMaxConcurrent / subagentMaxIterations /
subagentMaxDepth / subagentWorktreeIsolation); a session may still carry a
per-session ``metadata['delegation']`` override, which wins key-by-key on
read, and the spawn path (subagent_orchestrator) falls back to the global
values when a session has no override.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _freshBrainConfigCache():
    """getRuntimeConfig memoizes on a 2s TTL in a module global — without a
    reset, a previous test's write leaks into the next test's fresh data dir."""
    from app.services import brain_config_service as bcs

    bcs._runtime_cache = None
    yield
    bcs._runtime_cache = None


def _client() -> TestClient:
    from app.main import app

    return TestClient(app)


def test_get_without_session_returns_global_defaults(isolatedData):
    resp = _client().get('/api/subagents/config')
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body['maxConcurrent'] == 5
    assert body['maxIterations'] == 50
    assert body['maxDepth'] == 1
    assert body['worktreeIsolation'] is False


def test_post_without_session_saves_globally(isolatedData):
    """The exact panel flow: POST without a session id must persist."""
    client = _client()
    resp = client.post(
        '/api/subagents/config',
        json={'maxConcurrent': 2, 'maxIterations': 80, 'maxDepth': 3, 'worktreeIsolation': True},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()['ok'] is True

    # GET (no session) reads back what the panel saved, not hardcoded defaults.
    got = client.get('/api/subagents/config').json()
    assert got['maxConcurrent'] == 2
    assert got['maxIterations'] == 80
    assert got['maxDepth'] == 3
    assert got['worktreeIsolation'] is True

    # Landed in the brain_config global layer the orchestrator reads.
    from app.services.brain_config_service import getDelegationLimits

    assert getDelegationLimits() == got


def test_post_without_session_clamps_out_of_range(isolatedData):
    client = _client()
    resp = client.post(
        '/api/subagents/config',
        json={'maxConcurrent': 99, 'maxIterations': 1, 'maxDepth': 99},
    )
    assert resp.status_code == 200, resp.text
    got = client.get('/api/subagents/config').json()
    assert got['maxConcurrent'] == 30
    assert got['maxIterations'] == 5
    assert got['maxDepth'] == 5


def test_unknown_keys_are_ignored(isolatedData):
    """Only the four delegation keys are picked up (same ignore-unknowns
    behavior the old per-session path had); nothing 400s the panel."""
    client = _client()
    resp = client.post('/api/subagents/config', json={'maxConcurrent': 3, 'bogus': True})
    assert resp.status_code == 200, resp.text
    got = client.get('/api/subagents/config').json()
    assert got['maxConcurrent'] == 3
    assert 'bogus' not in got


def test_get_unknown_session_falls_back_to_global(isolatedData):
    client = _client()
    client.post('/api/subagents/config', json={'maxConcurrent': 7})
    got = client.get('/api/subagents/config', params={'sessionId': 'no-such-session'}).json()
    assert got['maxConcurrent'] == 7


def test_session_override_wins_key_by_key(isolatedData):
    client = _client()
    client.post('/api/subagents/config', json={'maxConcurrent': 2, 'maxIterations': 80})

    from app.services.workbench import workbench as wb

    sess = wb.createWorkbenchSession()
    meta = dict(sess.metadata or {})
    meta['delegation'] = {'maxConcurrent': 7}
    sess.metadata = meta
    wb.saveSessions()

    got = client.get('/api/subagents/config', params={'sessionId': sess.id}).json()
    assert got['maxConcurrent'] == 7  # session override
    assert got['maxIterations'] == 80  # global fills the rest
    assert got['maxDepth'] == 1  # default


def test_post_with_session_stays_per_session(isolatedData):
    client = _client()
    client.post('/api/subagents/config', json={'maxConcurrent': 9})

    from app.services.workbench import workbench as wb

    sess = wb.createWorkbenchSession()
    resp = client.post('/api/subagents/config', params={'sessionId': sess.id}, json={'maxConcurrent': 4})
    assert resp.status_code == 200, resp.text
    assert resp.json()['sessionId'] == sess.id

    assert client.get('/api/subagents/config').json()['maxConcurrent'] == 9  # global untouched
    sess_got = client.get('/api/subagents/config', params={'sessionId': sess.id}).json()
    assert sess_got['maxConcurrent'] == 4


def test_orchestrator_resolution_falls_back_to_global(isolatedData):
    """getDelegationLimits — the fallback the spawn path merges — reflects the
    saved global layer (session metadata overrides take precedence upstream)."""
    from app.services.brain_config_service import getDelegationLimits

    client = _client()
    client.post('/api/subagents/config', json={'maxConcurrent': 3})
    assert getDelegationLimits()['maxConcurrent'] == 3
    assert getDelegationLimits()['maxIterations'] == 50  # untouched default
