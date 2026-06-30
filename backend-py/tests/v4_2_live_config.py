"""v4.2 — Test /api/config/live endpoints (STT/TTS Live settings)."""
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
    """GET returns the live config merged with defaults."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.get("/api/config/live")
    assert resp.status_code == 200
    data = resp.json()
    # Defaults: empty provider = use browser default
    assert data["sttProvider"] == ""
    assert data["ttsProvider"] == ""
    assert data["sttModel"] == ""
    assert data["ttsModel"] == ""
    assert data["ttsVoice"] == ""


def test_get_merges_user_overrides_with_defaults():
    from fastapi.testclient import TestClient
    from app.main import app
    from app.lib.paths import data_path

    (data_path("config.json").parent).mkdir(exist_ok=True)
    data_path("config.json").write_text(json.dumps({
        "auxiliary": {
            "live": {"sttProvider": "openai", "sttModel": "whisper-1"}
        }
    }))
    client = TestClient(app)
    data = client.get("/api/config/live").json()
    assert data["sttProvider"] == "openai"  # user override
    assert data["sttModel"] == "whisper-1"
    assert data["ttsProvider"] == ""  # default
    assert data["ttsVoice"] == ""


def test_put_partial_update_persists():
    from fastapi.testclient import TestClient
    from app.main import app
    from app.lib.paths import data_path

    client = TestClient(app)
    resp = client.put("/api/config/live", json={"ttsProvider": "elevenlabs", "ttsVoice": "alloy"})
    assert resp.status_code == 200
    assert resp.json()["ttsProvider"] == "elevenlabs"

    # Persisted
    cfg = json.loads(data_path("config.json").read_text())
    assert cfg["auxiliary"]["live"]["ttsProvider"] == "elevenlabs"
    assert cfg["auxiliary"]["live"]["ttsVoice"] == "alloy"


def test_put_allows_empty_provider_use_browser_default():
    """Empty provider field = "use browser default" per spec §14."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.put("/api/config/live", json={"sttProvider": ""})
    assert resp.status_code == 200
    assert resp.json()["sttProvider"] == ""


def test_put_rejects_unknown_field():
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.put("/api/config/live", json={"invented": "x"})
    assert resp.status_code == 400


def test_put_rejects_non_string_value():
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.put("/api/config/live", json={"sttProvider": 42})
    assert resp.status_code == 400
