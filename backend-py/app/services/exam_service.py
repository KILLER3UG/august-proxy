"""
v3 — Exam service: Prefrontal-driven exam authoring, validation, and persistence.

The defining rule: the model authors every question. No endpoint accepts a
client-supplied correct_index. Questions are validated (4 options, valid
correct_index, non-empty rationale) before being persisted.
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


async def _call_prefrontal(prompt: str) -> str:
    """v3: Call the Prefrontal model. Returns raw text response (may include code fences)."""
    try:
        from app.services.workbench import model_fleet
        from app.providers.clients import get_client
        model = model_fleet.get_model_for_role("prefrontal")
        client = get_client({"model": model})
        if client and hasattr(client, "generate"):
            response = await client.generate(prompt)
            return response or ""
    except Exception as exc:
        logger.warning("_call_prefrontal failed: %s", exc)
    return ""


def _validate_question(q: Any) -> bool:
    """A valid question has stem, 4 options, valid correct_index, non-empty rationale."""
    if not isinstance(q, dict):
        return False
    if not isinstance(q.get("stem"), str) or not q["stem"].strip():
        return False
    opts = q.get("options")
    if not isinstance(opts, list) or len(opts) != 4:
        return False
    if not all(isinstance(o, str) and o.strip() for o in opts):
        return False
    ci = q.get("correct_index")
    if not isinstance(ci, int) or ci < 0 or ci > 3:
        return False
    if not isinstance(q.get("rationale"), str) or not q["rationale"].strip():
        return False
    return True


def _strip_code_fences(raw: str) -> str:
    """Remove ```json ... ``` wrappers that models commonly emit."""
    cleaned = (raw or "").strip()
    if cleaned.startswith("```"):
        lines = cleaned.split("\n")
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()
    return cleaned


def _parse_questions(raw: str) -> list[dict]:
    """Parse the Prefrontal response into a list of validated questions."""
    cleaned = _strip_code_fences(raw)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Prefrontal returned invalid JSON: {exc}") from exc
    if not isinstance(data, list):
        raise ValueError("Prefrontal output is not a JSON array")
    valid = [q for q in data if _validate_question(q)]
    return valid


def _build_prompt(
    topic: str,
    count: int,
    difficulty: str,
    context: str = "",
    similar_to: list[dict] | None = None,
) -> str:
    """Build the Prefrontal prompt for exam authoring."""
    parts = [
        f"Generate {count} multiple-choice question(s) on the topic: {topic}.",
        f"Difficulty: {difficulty}.",
        "",
        "Each question must have:",
        "  - 'stem': a clear question string",
        "  - 'options': exactly 4 distinct non-empty strings",
        "  - 'correct_index': integer 0-3 pointing to the correct option",
        "  - 'rationale': a 1-sentence explanation of the correct answer",
        "",
        'Return ONLY a JSON array (no other text, no markdown fences): '
        '[{"stem": str, "options": [str, str, str, str], "correct_index": 0-3, "rationale": str}]',
    ]
    if context:
        parts.insert(1, f"\nGrounded in the following source material:\n{context}\n")
    if similar_to:
        example = similar_to[0]
        parts.insert(
            1,
            f"\nSimilar in style to: stem=\"{example.get('stem','')}\" "
            f"options={example.get('options', [])}",
        )
    return "\n".join(parts)


async def generate_questions(
    topic: str,
    count: int,
    difficulty: str,
    context: str = "",
) -> list[dict]:
    """Call Prefrontal, validate, and return up to `count` valid question dicts.

    Raises ValueError if the model output can't be made valid.
    """
    prompt = _build_prompt(topic=topic, count=count, difficulty=difficulty, context=context)
    raw = await _call_prefrontal(prompt)
    if not raw:
        raise ValueError("Prefrontal returned empty response")
    valid = _parse_questions(raw)
    if len(valid) < count:
        raise ValueError(
            f"Prefrontal produced {len(valid)} valid question(s); need {count}"
        )
    return valid[:count]


async def generate_one_question(
    topic: str,
    request_text: str,
    similar_to: list[dict] | None = None,
) -> dict:
    """Generate a single question based on a user request (for /api/exam/{id}/questions).

    Accepts either a JSON object (preferred — matches the "one question" intent)
    or a JSON array with one element.
    """
    prompt = _build_prompt(
        topic=f"{topic} (specific ask: {request_text})",
        count=1,
        difficulty="medium",
        similar_to=similar_to,
    )
    raw = await _call_prefrontal(prompt)
    if not raw:
        raise ValueError("Prefrontal returned empty response")
    cleaned = _strip_code_fences(raw)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Prefrontal returned invalid JSON: {exc}") from exc

    # If the LLM returned a single dict, wrap it in a list
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list) or not data:
        raise ValueError("Prefrontal output is not a valid question (or list)")
    valid = [q for q in data if _validate_question(q)]
    if not valid:
        raise ValueError("Prefrontal produced no valid question")
    return valid[0]


async def help_explanation(
    stem: str,
    options: list[str],
    user_question: str,
) -> str:
    """Get a model-generated explanation that does NOT reveal the correct answer."""
    prompt = (
        f"Question: {stem}\n"
        f"Options: {' / '.join(options)}\n"
        f"User asks: {user_question}\n\n"
        "Explain the underlying concept so the user can answer the question themselves. "
        "Do NOT reveal which option is correct."
    )
    explanation = await _call_prefrontal(prompt)
    return explanation or "(no explanation available)"


def strip_answer(question: dict) -> dict:
    """Strip correct_index and rationale before sending to the client."""
    return {
        "id": question.get("id"),
        "exam_id": question.get("exam_id"),
        "position": question.get("position"),
        "stem": question.get("stem"),
        "options": question.get("options"),
    }