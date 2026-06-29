"""
Exam router — generate, fetch, answer, and help preparation exams (v3, §13).

The defining rule: the model authors every question. No endpoint accepts a
client-supplied correct_index. Questions are served one at a time as banners.
"""

from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, HTTPException

from app.services.memory_store import _conn
from app.services import exam_service

router = APIRouter(prefix="/api/exam")


def _db():
    return _conn()


@router.post("/generate")
async def generate_exam(body: dict[str, Any]):
    """Generate a new exam via Prefrontal. Topic can be a string or derived from uploaded files."""
    topic = (body.get("topic") or "").strip()
    count = min(int(body.get("count", 5)), 50)
    difficulty = body.get("difficulty", "medium")
    files = body.get("files") or []

    if not topic and not files:
        raise HTTPException(status_code=400, detail="topic or files required")

    # Extract context from files (text/code pass-through; v3 keeps it simple)
    context = ""
    source_files = ""
    if files:
        import os
        chunks = []
        for fp in files:
            if os.path.exists(fp):
                try:
                    with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                        chunks.append(f.read()[:5000])
                except Exception:
                    continue
        context = "\n\n".join(chunks)[:10000]
        source_files = json.dumps(files)

    if not topic:
        topic = f"the content of {len(files)} uploaded file(s)"

    # Author questions via Prefrontal
    try:
        questions = await exam_service.generate_questions(
            topic=topic,
            count=count,
            difficulty=difficulty,
            context=context,
        )
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    # Persist
    conn = _db()
    source = "files" if files else ("topic" if body.get("topic") else "model")
    cur = conn.execute(
        "INSERT INTO exams (title, topic, source, source_files) VALUES (?, ?, ?, ?)",
        (f"Exam: {topic[:80]}", topic, source, source_files),
    )
    exam_id = cur.lastrowid

    for i, q in enumerate(questions):
        conn.execute(
            "INSERT INTO exam_questions "
            "(exam_id, position, stem, options, correct_index, rationale, origin) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                exam_id,
                i + 1,
                q["stem"],
                json.dumps(q["options"]),
                q["correct_index"],
                q["rationale"],
                "generated",
            ),
        )
    conn.commit()

    # Fetch the first question to return its row id
    first = conn.execute(
        "SELECT id, position, stem, options FROM exam_questions "
        "WHERE exam_id = ? ORDER BY position LIMIT 1",
        (exam_id,),
    ).fetchone()

    first_q = exam_service.strip_answer({
        "id": first["id"],
        "exam_id": exam_id,
        "position": first["position"],
        "stem": first["stem"],
        "options": json.loads(first["options"]),
    })

    return {
        "exam_id": exam_id,
        "question": first_q,
        "total_questions": len(questions),
    }


@router.post("/{exam_id}/questions")
async def add_question(exam_id: int, body: dict[str, Any]):
    """Add a user-requested question. The model authors it (origin='user-requested')."""
    request_text = (body.get("request") or "").strip()
    after_position = body.get("after_position")

    conn = _db()
    exam = conn.execute("SELECT topic FROM exams WHERE id = ?", (exam_id,)).fetchone()
    if not exam:
        raise HTTPException(status_code=404, detail="Exam not found")
    topic = exam["topic"] or "general"

    # Find existing questions as style reference
    existing = conn.execute(
        "SELECT stem, options FROM exam_questions WHERE exam_id = ? "
        "ORDER BY position LIMIT 3",
        (exam_id,),
    ).fetchall()
    similar = []
    for row in existing:
        try:
            similar.append({"stem": row["stem"], "options": json.loads(row["options"])})
        except Exception:
            continue

    # Author one question
    try:
        q = await exam_service.generate_one_question(
            topic=topic,
            request_text=request_text,
            similar_to=similar,
        )
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    # Determine position
    if after_position is not None:
        # Shift positions >= after_position+1 up by 1
        conn.execute(
            "UPDATE exam_questions SET position = position + 1 "
            "WHERE exam_id = ? AND position > ?",
            (exam_id, after_position),
        )
        next_pos = after_position + 1
    else:
        row = conn.execute(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM exam_questions WHERE exam_id = ?",
            (exam_id,),
        ).fetchone()
        next_pos = row[0]

    cur = conn.execute(
        "INSERT INTO exam_questions "
        "(exam_id, position, stem, options, correct_index, rationale, origin) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            exam_id,
            next_pos,
            q["stem"],
            json.dumps(q["options"]),
            q["correct_index"],
            q["rationale"],
            f"user-requested: {request_text}" if request_text else "user-requested",
        ),
    )
    question_id = cur.lastrowid
    conn.commit()

    new_q = exam_service.strip_answer({
        "id": question_id,
        "exam_id": exam_id,
        "position": next_pos,
        "stem": q["stem"],
        "options": q["options"],
    })

    return {"position": next_pos, "question_id": question_id, "question": new_q}


@router.get("/{exam_id}/question/{position}")
async def get_question(exam_id: int, position: int):
    """Fetch one question. NEVER leaks correct_index or rationale (the authoring invariant)."""
    conn = _db()
    q = conn.execute(
        "SELECT id, stem, options FROM exam_questions WHERE exam_id = ? AND position = ?",
        (exam_id, position),
    ).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail="Question not found")

    return exam_service.strip_answer({
        "id": q["id"],
        "exam_id": exam_id,
        "position": position,
        "stem": q["stem"],
        "options": json.loads(q["options"]),
    })


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
        "INSERT INTO exam_attempts (exam_id, question_id, selected_index, is_correct, answered_at) "
        "VALUES (?, ?, ?, ?, datetime('now'))",
        (exam_id, question_id, selected_index, is_correct),
    )
    conn.commit()

    return {
        "is_correct": bool(is_correct),
        "correct_index": q["correct_index"],
        "rationale": q["rationale"],
    }


@router.post("/{exam_id}/help")
async def help_question(exam_id: int, body: dict[str, Any]):
    """Explain a question via Prefrontal without revealing the answer in the banner state."""
    question_id = body.get("question_id")
    ask = body.get("ask", "")

    conn = _db()
    q = conn.execute(
        "SELECT stem, options FROM exam_questions WHERE id = ? AND exam_id = ?",
        (question_id, exam_id),
    ).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail="Question not found")

    options = json.loads(q["options"])
    explanation = await exam_service.help_explanation(
        stem=q["stem"],
        options=options,
        user_question=ask or "Explain this question.",
    )

    # Mark that help was asked (best-effort; doesn't dismiss the banner)
    try:
        conn.execute(
            "UPDATE exam_attempts SET asked_for_help = 1 WHERE question_id = ?",
            (question_id,),
        )
        conn.commit()
    except Exception:
        pass

    return {
        "explanation": explanation,
        "banner_dismissed": False,
    }