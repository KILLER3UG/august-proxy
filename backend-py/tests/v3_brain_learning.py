"""v3 — Test /api/brain/learning returns all required fields."""
import pytest
from app.services.memory_store import init


@pytest.fixture(autouse=True)
def _init_db():
    init()
    yield


def test_learning_response_has_auto_memories():
    """Response includes 'auto_memories' field."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.get("/api/brain/learning")
    assert resp.status_code == 200
    data = resp.json()
    assert "auto_memories" in data
    assert isinstance(data["auto_memories"], list)


def test_learning_response_has_sleep_cycle():
    """Response includes 'sleep_cycle' field with last_run_at."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.get("/api/brain/learning")
    data = resp.json()
    assert "sleep_cycle" in data
    assert "last_run_at" in data["sleep_cycle"]
    assert "last_merged" in data["sleep_cycle"]
    assert "last_promoted" in data["sleep_cycle"]
    assert "last_deleted" in data["sleep_cycle"]


def test_learning_response_has_delta_engine_last_flush():
    """delta_engine includes last_flush_at."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.get("/api/brain/learning")
    data = resp.json()
    assert "delta_engine" in data
    assert "last_flush_at" in data["delta_engine"]
