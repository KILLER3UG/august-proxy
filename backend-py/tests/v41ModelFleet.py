"""v4.1 — Test /api/config/model-fleet endpoints (Model Fleet UI gap)."""
import json
import pytest

@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    """Redirect config.json to a temp path so tests don't touch real config."""
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', str(tmp_path / 'test_brain.sqlite'))
    from app.config import settings
    monkeypatch.setattr(settings, 'data_dir', tmp_path)
    settings.reload()
    yield tmp_path
    settings.reload()

def testGetReturnsDefaultsWhenConfigIsEmpty():
    """GET returns the fleet merged with defaults if config.json has no model_fleet."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.get('/api/config/model-fleet')
    assert resp.status_code == 200
    data = resp.json()
    assert data['cortex'] == ''
    assert data['cerebellum'] == 'claude-3-haiku-20240307'
    assert data['hippocampus'] == 'claude-3-haiku-20240307'
    assert data['prefrontal'] == 'claude-3-5-sonnet-20240620'

def testGetMergesUserOverridesWithDefaults():
    """A user-set value overrides the default; unset roles fall back to defaults."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.lib.paths import dataPath
    import json
    cfgPath = dataPath('config.json')
    cfgPath.write_text(json.dumps({'auxiliary': {'model_fleet': {'cerebellum': 'gpt-4o-mini'}}}))
    client = TestClient(app)
    data = client.get('/api/config/model-fleet').json()
    assert data['cerebellum'] == 'gpt-4o-mini'
    assert data['cortex'] == ''
    assert data['hippocampus'] == 'claude-3-haiku-20240307'
    assert data['prefrontal'] == 'claude-3-5-sonnet-20240620'

def testPutPartialUpdatePersists():
    """PUT with a single role persists to config.json; other roles keep their values."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.lib.paths import dataPath
    client = TestClient(app)
    resp = client.put('/api/config/model-fleet', json={'cerebellum': 'gpt-4o-mini'})
    assert resp.status_code == 200
    assert resp.json()['cerebellum'] == 'gpt-4o-mini'
    cfg = json.loads(dataPath('config.json').read_text())
    assert cfg['auxiliary']['model_fleet']['cerebellum'] == 'gpt-4o-mini'

def testPutAllowsEmptyCortex():
    """Empty cortex = "use session model" is valid."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.put('/api/config/model-fleet', json={'cortex': ''})
    assert resp.status_code == 200
    assert resp.json()['cortex'] == ''

def testPutRejectsUnknownRole():
    """PUT must reject roles outside the four documented ones."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.put('/api/config/model-fleet', json={'thalamus': 'x'})
    assert resp.status_code == 400

def testPutRejectsNonStringValue():
    """Each role value must be a string (or omitted for partial-update semantics)."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.put('/api/config/model-fleet', json={'cerebellum': 42})
    assert resp.status_code == 400