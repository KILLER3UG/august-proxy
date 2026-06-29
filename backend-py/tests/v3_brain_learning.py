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


def test_delete_heuristic():
    """DELETE /api/brain/heuristics/{id} removes a heuristic."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.heuristics_service import add_heuristic
    import uuid
    h_id = add_heuristic(f"v3 test delete rule {uuid.uuid4().hex[:8]}", source="v3-test")
    assert h_id is not None
    client = TestClient(app)
    resp = client.delete(f"/api/brain/heuristics/{h_id}")
    assert resp.status_code == 200
    assert resp.json().get("deleted") is True


def test_edit_heuristic():
    """PATCH /api/brain/heuristics/{id} updates the rule."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.heuristics_service import add_heuristic
    import uuid
    rule = f"v3 original rule {uuid.uuid4().hex[:8]}"
    h_id = add_heuristic(rule, source="v3-test")
    assert h_id is not None
    client = TestClient(app)
    resp = client.patch(
        f"/api/brain/heuristics/{h_id}",
        json={"rule": f"v3 updated rule {uuid.uuid4().hex[:8]}"},
    )
    assert resp.status_code == 200
    assert resp.json().get("updated") is True
    # Cleanup
    client.delete(f"/api/brain/heuristics/{h_id}")


def test_run_consolidation_endpoint():
    """POST /api/brain/run-consolidation triggers consolidation."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.post("/api/brain/run-consolidation")
    assert resp.status_code == 200
    data = resp.json()
    assert "merged" in data
    assert "promoted" in data
    assert "deleted_stale" in data
