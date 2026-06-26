"""
Learned guidelines — stores user corrections as persistent behavioral rules.

Port of backend/services/memory/learned-guidelines.js.
"""

from __future__ import annotations

from typing import Any

from app.services.memory_store import save_memory, get_memory

_GUIDELINES_KEY = "learned_guidelines"


def add_guideline(text: str, source: str = "user_correction", category: str = "behavior") -> dict[str, Any]:
    """Add a learned guideline."""
    guidelines = get_memory(_GUIDELINES_KEY) or []
    if not isinstance(guidelines, list):
        guidelines = []

    guideline = {
        "id": f"gl_{len(guidelines) + 1}",
        "text": text,
        "source": source,
        "category": category,
        "created_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "active": True,
    }
    guidelines.append(guideline)
    save_memory(_GUIDELINES_KEY, guidelines)
    return guideline


def get_active_guidelines(category: str = "") -> list[dict[str, Any]]:
    """Get all active guidelines, optionally filtered by category."""
    guidelines = get_memory(_GUIDELINES_KEY) or []
    if not isinstance(guidelines, list):
        return []
    active = [g for g in guidelines if g.get("active", True)]
    if category:
        active = [g for g in active if g.get("category") == category]
    return active


def get_active_guideline_texts(category: str = "") -> list[str]:
    """Get just the text of active guidelines."""
    return [g["text"] for g in get_active_guidelines(category) if g.get("text")]


def deactivate_guideline(guideline_id: str) -> bool:
    """Mark a guideline as inactive."""
    guidelines = get_memory(_GUIDELINES_KEY) or []
    if not isinstance(guidelines, list):
        return False
    for g in guidelines:
        if g.get("id") == guideline_id:
            g["active"] = False
            save_memory(_GUIDELINES_KEY, guidelines)
            return True
    return False


def clear_guidelines(category: str = "") -> int:
    """Clear all guidelines, optionally by category."""
    guidelines = get_memory(_GUIDELINES_KEY) or []
    if not isinstance(guidelines, list):
        return 0
    if category:
        new_list = [g for g in guidelines if g.get("category") != category]
        removed = len(guidelines) - len(new_list)
        save_memory(_GUIDELINES_KEY, new_list)
        return removed
    else:
        count = len(guidelines)
        save_memory(_GUIDELINES_KEY, [])
        return count
