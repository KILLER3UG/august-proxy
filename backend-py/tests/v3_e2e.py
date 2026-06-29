"""v3 — End-to-end test: Brain dashboard aggregation + /Exam full lifecycle."""
import json
from unittest.mock import patch

import pytest


VALID_EXAM = [
    {"stem": "What is 2+2?", "options": ["3", "4", "5", "6"], "correct_index": 1, "rationale": "2+2=4."},
    {"stem": "Capital of France?", "options": ["Berlin", "Madrid", "Paris", "Rome"], "correct_index": 2, "rationale": "Paris."},
]


@pytest.fixture(autouse=True)
def _init_db():
    from app.services.memory_store import init
    init()
    yield


def test_brain_dashboard_aggregates_real_data():
    """Learning + health endpoints surface real data; mutation flow works end-to-end."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.heuristics_service import add_heuristic

    client = TestClient(app)

    # Learning endpoint returns the full shape
    learning = client.get("/api/brain/learning").json()
    assert "heuristics" in learning
    assert "auto_memories" in learning
    assert "sleep_cycle" in learning
    assert "delta_engine" in learning
    assert "pending_skills" in learning

    # Health endpoint covers all required layers
    health = client.get("/api/brain/health").json()
    flags = {p["flag"] for p in health["phases"]}
    for f in ("heuristics", "daemons", "blackboard", "verifier_reflex", "skill_genesis"):
        assert f in flags, f"missing layer: {f}"

    # Mutation lifecycle: add → edit → delete a heuristic
    h = add_heuristic("v3 e2e rule", source="v3-e2e")
    assert h is not None

    resp = client.patch(f"/api/brain/heuristics/{h}", json={"rule": "v3 e2e updated"})
    assert resp.status_code == 200
    assert resp.json().get("updated") is True

    resp = client.delete(f"/api/brain/heuristics/{h}")
    assert resp.status_code == 200
    assert resp.json().get("deleted") is True


def test_exam_full_lifecycle():
    """Generate → fetch → answer → help — full /Exam flow with Prefrontal mocked."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.memory_store import _conn

    client = TestClient(app)

    # Generate
    with patch("app.services.exam_service._call_prefrontal", return_value=json.dumps(VALID_EXAM)):
        gen = client.post(
            "/api/exam/generate",
            json={"topic": "math+geography", "count": 2, "difficulty": "easy"},
        )
    assert gen.status_code == 200
    body = gen.json()
    exam_id = body["exam_id"]
    assert body["total_questions"] == 2
    assert "correct_index" not in body["question"]

    # Fetch (also strips correct_index)
    fetched = client.get(f"/api/exam/{exam_id}/question/1").json()
    assert "correct_index" not in fetched
    assert "rationale" not in fetched
    q1_id = fetched["id"]

    # Answer correctly
    ans = client.post(
        f"/api/exam/{exam_id}/answer",
        json={"question_id": q1_id, "selected_index": 1},
    )
    assert ans.status_code == 200
    ans_body = ans.json()
    assert ans_body["is_correct"] is True
    assert ans_body["correct_index"] == 1
    assert ans_body["rationale"] == "2+2=4."

    # Help returns explanation, no correctness leak
    with patch("app.services.exam_service._call_prefrontal", return_value="The concept is..."):
        help_resp = client.post(
            f"/api/exam/{exam_id}/help",
            json={"question_id": q1_id, "ask": "Explain addition"},
        )
    assert help_resp.status_code == 200
    help_body = help_resp.json()
    assert "explanation" in help_body
    assert "is_correct" not in help_body
    assert "correct_index" not in help_body
    assert help_body["banner_dismissed"] is False

    # Attempts persisted
    attempts = _conn().execute(
        "SELECT COUNT(*) FROM exam_attempts WHERE exam_id = ?", (exam_id,)
    ).fetchone()[0]
    assert attempts == 1


def test_add_question_authors_and_appends():
    """User adds a custom question mid-exam; the model authors it."""
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)

    # Generate first
    with patch("app.services.exam_service._call_prefrontal", return_value=json.dumps(VALID_EXAM)):
        gen = client.post(
            "/api/exam/generate",
            json={"topic": "x", "count": 2, "difficulty": "easy"},
        )
    exam_id = gen.json()["exam_id"]

    # Add an extra question
    extra = {"stem": "Bonus", "options": ["a", "b", "c", "d"], "correct_index": 0, "rationale": "r"}
    with patch("app.services.exam_service._call_prefrontal", return_value=json.dumps(extra)):
        resp = client.post(
            f"/api/exam/{exam_id}/questions",
            json={"request": "ask about bonus"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["position"] == 3  # 2 generated + 1 added
    assert body["question"]["stem"] == "Bonus"