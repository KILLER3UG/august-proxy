"""
Exam router — generate, answer, and review preparation exams (v3, §13).

The defining rule: the model authors every question. No endpoint accepts a
client-supplied correct_index. Questions are served one at a time as banners.
"""

from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, HTTPException

from app.services.memory_store import _conn

router = APIRouter(prefix="/api/exam")


def _db():
    return _conn()


@router.post("/generate")
async def generate_exam(body: dict[str, Any]):
    """Generate a new exam. Topic can be a string or derived from uploaded files."""
    topic = body.get("topic", "")
    count = min(body.get("count", 10), 50)
    difficulty = body.get("difficulty", "medium")
    files = body.get("files", [])

    source = "model"
    source_files = ""
    if files:
        source = "files"
        source_files = json.dumps(files)

    conn = _db()
    conn.execute(
        "INSERT INTO exams (title, topic, source, source_files) VALUES (?, ?, ?, ?)",
        (topic or f"Exam {int(time.time())}", topic, source, source_files),
    )
    conn.commit()
    exam_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

    # Generate first question using Prefrontal model (delegated to caller)
    # For now, insert placeholder questions
    for i in range(min(count, 3)):  # limit initial generation
        conn.execute(
            "INSERT INTO exam_questions (exam_id, position, stem, options, correct_index, rationale) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (exam_id, i + 1,
             f"Sample question {i + 1} for {topic or 'general'}",
             json.dumps(["Option A", "Option B", "Option C", "Option D"]),
             0,
             f"The correct answer is A because..."),
        )
    conn.commit()

    # Return first question
    q = conn.execute(
        "SELECT id, stem, options FROM exam_questions WHERE exam_id = ? AND position = 1",
        (exam_id,),
    ).fetchone()

    return {
        "exam_id": exam_id,
        "question_count": count,
        "first_question": {
            "id": q["id"],
            "stem": q["stem"],
            "options": json.loads(q["options"]),
        } if q else None,
    }


@router.post("/{exam_id}/questions")
async def add_question(exam_id: int, body: dict[str, Any]):
    """Add a user-requested question. The model authors it; no client-supplied answer."""
    request_text = body.get("request", "")
    conn = _db()

    # Get next position
    row = conn.execute(
        "SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM exam_questions WHERE exam_id = ?",
        (exam_id,),
    ).fetchone()
    next_pos = row["next_pos"] if row else 1

    # The model authors the question (placeholder)
    conn.execute(
        "INSERT INTO exam_questions (exam_id, position, stem, options, correct_index, rationale, origin) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (exam_id, next_pos,
         f"Question about: {request_text or 'general'}",
         json.dumps(["Option A", "Option B", "Option C"]),
         0,
         "Explanation...",
         f"user-requested: {request_text}"),
    )
    conn.commit()

    return {"position": next_pos, "question_id": conn.execute("SELECT last_insert_rowid()").fetchone()[0]}


@router.get("/{exam_id}/question/{position}")
async def get_question(exam_id: int, position: int):
    """Fetch one question (no correct_index leaked to client)."""
    conn = _db()
    q = conn.execute(
        "SELECT id, stem, options FROM exam_questions WHERE exam_id = ? AND position = ?",
        (exam_id, position),
    ).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail="Question not found")

    return {
        "id": q["id"],
        "stem": q["stem"],
        "options": json.loads(q["options"]),
    }


@router.post("/{exam_id}/answer")
async def answer_question(exam_id: int, body: dict[str, Any]):
    """Record an answer for a question. Returns correctness + rationale."""
    question_id = body.get("question_id")
    selected_index = body.get("selected_index")

    conn = _db()
    q = conn.execute(
        "SELECT correct_index, rationale FROM exam_questions WHERE id = ? AND exam_id = ?",
        (question_id, exam_id),
    ).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail="Question not found")

    is_correct = 1 if selected_index == q["correct_index"] else 0

    conn.execute(
        "INSERT INTO exam_attempts (exam_id, question_id, selected_index, is_correct) "
        "VALUES (?, ?, ?, ?)",
        (exam_id, question_id, selected_index, is_correct),
    )
    conn.commit()

    return {
        "correct": bool(is_correct),
        "correct_index": q["correct_index"],
        "rationale": q["rationale"],
    }


@router.post("/{exam_id}/help")
async def help_question(exam_id: int, body: dict[str, Any]):
    """Explain a question without revealing the answer in the banner.

    Returns explanation for the explanation modal.
    """
    question_id = body.get("question_id")
    ask = body.get("ask", "")
    conn = _db()

    q = conn.execute(
        "SELECT stem, correct_index, rationale FROM exam_questions WHERE id = ? AND exam_id = ?",
        (question_id, exam_id),
    ).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail="Question not found")

    # Record that help was asked
    conn.execute(
        "UPDATE exam_attempts SET asked_for_help = 1 WHERE question_id = ?",
        (question_id,),
    )
    conn.commit()

    return {
        "explanation": f"Help for: {q['stem'][:100]}...\n\n{q['rationale']}",
        "banner_dismissed": False,
    }
