"""v4.1 — Test /api/config/model-fleet endpoints (Model Fleet UI gap)."""
import json
import pytest


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    """Redirect config.json to a temp path so tests don't touch real config."""
    monkeypatch.setenv("AUGUST_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AUGUST_BRAIN_SQLITE_FILE", str(tmp_path / "test_brain.sqlite"))
    from app.config import settings
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    settings.reload()
    yield tmp_path
    settings.reload()


def test_get_returns_defaults_when_config_is_empty():
    """GET returns the fleet merged with defaults if config.json has no model_fleet."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.get("/api/config/model-fleet")
    assert resp.status_code == 200
    data = resp.json()
    assert data["cortex"] == ""  # empty = use session primary
    assert data["cerebellum"] == "claude-3-haiku-20240307"
    assert data["hippocampus"] == "claude-3-haiku-20240307"
    assert data["prefrontal"] == "claude-3-5-sonnet-20240620"


def test_get_merges_user_overrides_with_defaults():
    """A user-set value overrides the default; unset roles fall back to defaults."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.lib.paths import data_path
    import json

    cfg_path = data_path("config.json")
    cfg_path.write_text(json.dumps({
        "auxiliary": {
            "model_fleet": {"cerebellum": "gpt-4o-mini"}
        }
    }))
    client = TestClient(app)
    data = client.get("/api/config/model-fleet").json()
    assert data["cerebellum"] == "gpt-4o-mini"  # user override
    assert data["cortex"] == ""                 # default
    assert data["hippocampus"] == "claude-3-haiku-20240307"  # default
    assert data["prefrontal"] == "claude-3-5-sonnet-20240620"  # default


def test_put_partial_update_persists():
    """PUT with a single role persists to config.json; other roles keep their values."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.lib.paths import data_path

    client = TestClient(app)
    resp = client.put("/api/config/model-fleet", json={"cerebellum": "gpt-4o-mini"})
    assert resp.status_code == 200
    assert resp.json()["cerebellum"] == "gpt-4o-mini"

    # Persisted to disk
    cfg = json.loads(data_path("config.json").read_text())
    assert cfg["auxiliary"]["model_fleet"]["cerebellum"] == "gpt-4o-mini"


def test_put_allows_empty_cortex():
    """Empty cortex = "use session model" is valid."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.put("/api/config/model-fleet", json={"cortex": ""})
    assert resp.status_code == 200
    assert resp.json()["cortex"] == ""


def test_put_rejects_unknown_role():
    """PUT must reject roles outside the four documented ones."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.put("/api/config/model-fleet", json={"thalamus": "x"})
    assert resp.status_code == 400


def test_put_rejects_non_string_value():
    """Each role value must be a string (or omitted for partial-update semantics)."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.put("/api/config/model-fleet", json={"cerebellum": 42})
    assert resp.status_code == 400
