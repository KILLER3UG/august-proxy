"""v3 — Test /api/brain/health returns selfcheck results for all layers."""
import pytest

@pytest.fixture(autouse=True)
def _initDb():
    from app.services.memoryStore import init
    init()
    yield

def testHealthResponseHasPhasesArray():
    """/api/brain/health returns a 'phases' array covering the cognitive layers."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.get('/api/brain/health')
    assert resp.status_code == 200
    data = resp.json()
    assert 'phases' in data
    assert isinstance(data['phases'], list)
    assert len(data['phases']) >= 12

def testHealthEachPhaseHasRequiredFields():
    """Each phase has layer, flag, flag_value, status, detail, last_check_at."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.get('/api/brain/health')
    phases = resp.json()['phases']
    assert phases, 'expected at least one phase'
    for phase in phases:
        assert 'layer' in phase
        assert 'flag' in phase
        assert 'flag_value' in phase
        assert 'status' in phase
        assert 'detail' in phase
        assert 'last_check_at' in phase
        assert phase['status'] in ('on & healthy', 'on & failing', 'off', 'not shipped')

def testHealthCoversRequiredLayers():
    """All 12 expected layers from the design doc are present."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.get('/api/brain/health')
    flags = {p['flag'] for p in resp.json()['phases']}
    expected = {'heuristics', 'execution_state', 'scratchpad', 'tool_guardrails', 'progressive_disclosure', 'prompt_caching', 'cognitive_budget', 'daemons', 'blackboard', 'env_watcher', 'verifier_reflex', 'skill_genesis'}
    missing = expected - flags
    assert not missing, f'missing layers: {missing}'