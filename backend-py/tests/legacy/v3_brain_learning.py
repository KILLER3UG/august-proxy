"""v3 — Test /api/brain/learning returns all required fields."""

import pytest
from app.services.memory_store import init


@pytest.fixture(autouse=True)
def _initDb():
    init()
    yield


def testLearningResponseHasAutoMemories():
    """Response includes 'autoMemories' field."""
    from app.main import app
    from fastapi.testclient import TestClient

    client = TestClient(app)
    resp = client.get('/api/brain/learning')
    assert resp.status_code == 200
    data = resp.json()
    assert 'autoMemories' in data
    assert isinstance(data['autoMemories'], list)


def testLearningResponseHasSleepCycle():
    """Response includes 'sleepCycle' field with last_run_at."""
    from app.main import app
    from fastapi.testclient import TestClient

    client = TestClient(app)
    resp = client.get('/api/brain/learning')
    data = resp.json()
    assert 'sleepCycle' in data
    assert 'lastRunAt' in data['sleepCycle']
    assert 'lastMerged' in data['sleepCycle']
    assert 'lastPromoted' in data['sleepCycle']
    assert 'lastDeleted' in data['sleepCycle']


def testLearningResponseHasDeltaEngineLastFlush():
    """delta_engine includes last_flush_at."""
    from app.main import app
    from fastapi.testclient import TestClient

    client = TestClient(app)
    resp = client.get('/api/brain/learning')
    data = resp.json()
    assert 'delta_engine' in data
    assert 'lastFlushAt' in data['delta_engine']


def testDeleteHeuristic():
    """DELETE /api/brain/heuristics/{id} removes a heuristic."""
    import uuid

    from app.main import app
    from app.services.heuristics_service import addHeuristic
    from fastapi.testclient import TestClient

    hId = addHeuristic(f'v3 test delete rule {uuid.uuid4().hex[:8]}', source='v3-test')
    assert hId is not None
    client = TestClient(app)
    resp = client.delete(f'/api/brain/heuristics/{hId}')
    assert resp.status_code == 200
    assert resp.json().get('deleted') is True


def testEditHeuristic():
    """PATCH /api/brain/heuristics/{id} updates the rule."""
    import uuid

    from app.main import app
    from app.services.heuristics_service import addHeuristic
    from fastapi.testclient import TestClient

    rule = f'v3 original rule {uuid.uuid4().hex[:8]}'
    hId = addHeuristic(rule, source='v3-test')
    assert hId is not None
    client = TestClient(app)
    resp = client.patch(f'/api/brain/heuristics/{hId}', json={'rule': f'v3 updated rule {uuid.uuid4().hex[:8]}'})
    assert resp.status_code == 200
    assert resp.json().get('updated') is True
    client.delete(f'/api/brain/heuristics/{hId}')


def testRunConsolidationEndpoint():
    """POST /api/brain/run-consolidation triggers consolidation."""
    from app.main import app
    from fastapi.testclient import TestClient

    client = TestClient(app)
    resp = client.post('/api/brain/run-consolidation')
    assert resp.status_code == 200
    data = resp.json()
    assert 'merged' in data
    assert 'promoted' in data
    assert 'deleted_stale' in data
