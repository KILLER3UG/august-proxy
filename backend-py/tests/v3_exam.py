"""v3 — Test /api/exam/* endpoints use Prefrontal model + validation."""
import json
from unittest.mock import patch

import pytest


@pytest.fixture(autouse=True)
def _init_db():
    from app.services.memory_store import init
    init()
    yield


VALID_EXAM = [
    {"stem": "What is 2+2?", "options": ["3", "4", "5", "6"], "correct_index": 1, "rationale": "2+2=4."},
    {"stem": "Capital of France?", "options": ["Berlin", "Madrid", "Paris", "Rome"], "correct_index": 2, "rationale": "Paris."},
]


def test_generate_exam_with_topic():
    """POST /api/exam/generate with a topic returns an exam + first question (no correct_index)."""
    from fastapi.testclient import TestClient
    from app.main import app
    with patch("app.services.exam_service._call_prefrontal", return_value=json.dumps(VALID_EXAM)):
        client = TestClient(app)
        resp = client.post("/api/exam/generate", json={"topic": "math", "count": 2, "difficulty": "easy"})
        assert resp.status_code == 200
        data = resp.json()
        assert "exam_id" in data
        assert "question" in data
        assert "correct_index" not in data["question"]
        assert "rationale" not in data["question"]
        assert "options" in data["question"]


def test_generate_exam_rejects_no_topic_no_files():
    """Neither topic nor files → 400."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.post("/api/exam/generate", json={"count": 5, "difficulty": "easy"})
    assert resp.status_code == 400


def test_generate_exam_rejects_malformed_output():
    """LLM returns 1 question with 1 option instead of 4 → 500."""
    from fastapi.testclient import TestClient
    from app.main import app
    bad = [{"stem": "Q", "options": ["only one"], "correct_index": 0, "rationale": "r"}]
    with patch("app.services.exam_service._call_prefrontal", return_value=json.dumps(bad)):
        client = TestClient(app)
        resp = client.post("/api/exam/generate", json={"topic": "x", "count": 1, "difficulty": "easy"})
        assert resp.status_code == 500


def test_generate_exam_handles_code_fences():
    """LLM wraps JSON in ```json ... ``` fences — should still parse."""
    from fastapi.testclient import TestClient
    from app.main import app
    wrapped = "```json\n" + json.dumps(VALID_EXAM) + "\n```"
    with patch("app.services.exam_service._call_prefrontal", return_value=wrapped):
        client = TestClient(app)
        resp = client.post("/api/exam/generate", json={"topic": "x", "count": 2, "difficulty": "easy"})
        assert resp.status_code == 200
        assert "exam_id" in resp.json()


def test_fetch_question_strips_correct_index():
    """GET /api/exam/{id}/question/{pos} never leaks correct_index or rationale."""
    from fastapi.testclient import TestClient
    from app.main import app
    with patch("app.services.exam_service._call_prefrontal", return_value=json.dumps(VALID_EXAM)):
        client = TestClient(app)
        gen = client.post("/api/exam/generate", json={"topic": "x", "count": 2, "difficulty": "easy"})
        exam_id = gen.json()["exam_id"]
        resp = client.get(f"/api/exam/{exam_id}/question/1")
        assert resp.status_code == 200
        data = resp.json()
        assert "correct_index" not in data
        assert "rationale" not in data


def test_answer_records_attempt():
    """POST /api/exam/{id}/answer records attempt + returns correctness."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.memory_store import _conn
    with patch("app.services.exam_service._call_prefrontal", return_value=json.dumps(VALID_EXAM)):
        client = TestClient(app)
        gen = client.post("/api/exam/generate", json={"topic": "x", "count": 2, "difficulty": "easy"})
        exam_id = gen.json()["exam_id"]
        q = _conn().execute(
            "SELECT id, correct_index FROM exam_questions WHERE exam_id = ? ORDER BY position",
            (exam_id,),
        ).fetchall()
        correct = q[0]["correct_index"]
        resp = client.post(
            f"/api/exam/{exam_id}/answer",
            json={"question_id": q[0]["id"], "selected_index": correct},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["is_correct"] is True
        assert data["correct_index"] == correct
        # Attempt recorded
        attempts = _conn().execute(
            "SELECT COUNT(*) FROM exam_attempts WHERE exam_id = ?", (exam_id,)
        ).fetchone()[0]
        assert attempts == 1


def test_help_returns_explanation_without_correctness():
    """POST /api/exam/{id}/help returns explanation, does NOT reveal correctness in banner state."""
    from fastapi.testclient import TestClient
    from app.main import app
    exam = [VALID_EXAM[0]]
    with patch("app.services.exam_service._call_prefrontal", return_value=json.dumps(exam)):
        client = TestClient(app)
        gen = client.post(
            "/api/exam/generate",
            json={"topic": "x", "count": 1, "difficulty": "easy"},
        )
        assert gen.status_code == 200, gen.text
        exam_id = gen.json()["exam_id"]
        qid = gen.json()["question"]["id"]
    with patch("app.services.exam_service._call_prefrontal", return_value="This is the concept explanation."):
        resp = client.post(
            f"/api/exam/{exam_id}/help",
            json={"question_id": qid, "ask": "Explain?"},
        )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "explanation" in data
    assert "is_correct" not in data
    assert "correct_index" not in data


def test_add_question_authors_via_model():
    """POST /api/exam/{id}/questions authors via Prefrontal, appends at next position."""
    from fastapi.testclient import TestClient
    from app.main import app
    extra = {"stem": "New Q", "options": ["a", "b", "c", "d"], "correct_index": 0, "rationale": "r"}
    with patch("app.services.exam_service._call_prefrontal", return_value=json.dumps(VALID_EXAM)):
        client = TestClient(app)
        gen = client.post("/api/exam/generate", json={"topic": "x", "count": 2, "difficulty": "easy"})
        exam_id = gen.json()["exam_id"]
    # Now ask for an additional question
    with patch("app.services.exam_service._call_prefrontal", return_value=json.dumps(extra)):
        resp = client.post(
            f"/api/exam/{exam_id}/questions",
            json={"request": "ask about X"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "position" in data
        assert data["position"] == 3  # 2 generated + 1 added