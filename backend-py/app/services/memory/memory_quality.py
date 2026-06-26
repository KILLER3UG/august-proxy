"""
Memory quality — scores and filters memory entries by quality metrics.

Port of backend/services/memory/memory-quality.js.
"""

from __future__ import annotations

import re
from typing import Any


def score_quality(text: str) -> dict[str, Any]:
    """Score the quality of a memory text entry."""
    if not text:
        return {"score": 0, "reasons": ["empty"]}

    score = 1.0
    reasons = []

    # Length penalty
    if len(text) < 10:
        score -= 0.3
        reasons.append("too_short")
    elif len(text) > 100:
        score += 0.1
        reasons.append("substantial")

    # Contains useful structure
    if re.search(r"[A-Z]", text):
        score += 0.1
    if re.search(r"\d+", text):
        score += 0.1
    if ":" in text or "- " in text:
        score += 0.1

    # Contains actionable content
    action_words = ["implemented", "created", "fixed", "changed", "added", "removed", "updated"]
    if any(w in text.lower() for w in action_words):
        score += 0.2
        reasons.append("actionable")

    # Gibberish detection
    unique_chars = len(set(text.lower()))
    if unique_chars < 5 and len(text) > 20:
        score -= 0.5
        reasons.append("low_entropy")

    # Duplicate-like (repeated phrases)
    if re.search(r"(.{10,})\1", text):
        score -= 0.3
        reasons.append("repetitive")

    return {"score": round(max(0, min(score, 2.0)), 2), "reasons": reasons}


def filter_high_quality(entries: list[dict[str, Any]], min_score: float = 0.5) -> list[dict[str, Any]]:
    """Filter memory entries by quality score."""
    scored = []
    for e in entries:
        text = e.get("content", "") or e.get("text", "") or str(e.get("value", ""))
        q = score_quality(text)
        if q["score"] >= min_score:
            scored.append({**e, "_quality": q})
    return scored


def deduplicate(entries: list[dict[str, Any]], threshold: float = 0.85) -> list[dict[str, Any]]:
    """Remove near-duplicate entries."""
    if not entries:
        return []
    from app.services.memory.fuzzy_match import similarity

    kept = [entries[0]]
    for e in entries[1:]:
        text_e = str(e.get("content", "") or e.get("text", ""))
        if all(similarity(text_e, str(k.get("content", "") or k.get("text", ""))) < threshold for k in kept):
            kept.append(e)
    return kept
