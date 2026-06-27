"""Self-evolution engine — lightweight rule-based reflection after each turn.

Complement to ``background_review.py`` (which does LLM-based review).
This module runs lightweight regex-based reflection on every turn to:

1. Extract user corrections from natural language ("don't X", "prefer Y")
2. Detect tool failure patterns (>2 errors = learning opportunity)
3. Capture user preferences (name, occupation, likes) into user profile
4. Save reflections to memory_store for audit trail

The heavier LLM-based review (skill creation, memory facts) is handled
by ``background_review.py`` which runs interval-gated.
"""

from __future__ import annotations

import re
import time
from typing import Any

from app.services.memory_store import save_memory, get_memory
from app.services.memory.auto_memory import save_auto_memory

_REFLECTION_KEY = "self_evolution_log"
_MAX_REFLECTIONS = 50

# Patterns for extracting user corrections
_CORRECTION_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bdon'?t\s+(\w+)"), "behavior"),
    (re.compile(r"\bnever\s+(\w+)"), "behavior"),
    (re.compile(r"\balways\s+(\w+)"), "behavior"),
    (re.compile(r"\bprefer\b"), "preference"),
    (re.compile(r"\b(actually|instead|rather)\b"), "correction"),
    (re.compile(r"\bstop\s+\w+ing\b"), "behavior"),
]

# Patterns for extracting user preferences
_PREFERENCE_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"my\s+(?:name|username)\s+is\s+(\w+)"), "user_name"),
    (re.compile(r"(?:i|i'm)\s+(?:a|an)\s+(\w[\w\s]*)"), "user_identity"),
    (re.compile(r"i\s+(?:work|work\s+as)\s+(?:a|an|at)\s+(.+?)(?:\.|$)"), "user_occupation"),
    (re.compile(r"i\s+(?:like|love|prefer)\s+(\w[\w\s]*)"), "user_preference"),
]


def reflect_on_turn(
    messages: list[dict[str, Any]],
    model: str = "",
) -> dict[str, Any]:
    """Run lightweight rule-based self-reflection on a completed turn.

    This runs on every turn (unlike background_review which is interval-gated).
    It extracts corrections, tool failure patterns, and user preferences
    using regex patterns — no LLM call required.

    Args:
        messages: The full conversation messages from this turn.
        model: The model name used for this turn (for audit).

    Returns:
        Dict with reflection results: learnings, guideline_updates,
        memory_updates, tool_failures, message_count.
    """
    if not messages:
        return {"reflected": False, "reason": "no_messages"}

    learnings: list[str] = []
    guideline_updates = 0
    memory_updates = 0

    # 1. Extract user corrections
    for msg in messages:
        if msg.get("role") != "user":
            continue
        text = str(msg.get("content", "")).lower() if isinstance(msg.get("content"), str) else ""

        for pattern, category in _CORRECTION_PATTERNS:
            matches = pattern.findall(text)
            for match in matches:
                learning = f"User {category}: '{match}' in: {text[:100]}"
                learnings.append(learning)

                # Save behavioral corrections as auto-memories
                if category == "behavior":
                    save_auto_memory(
                        f"correction_{int(time.time())}",
                        f"User prefers: {match}",
                        category="correction",
                        importance=0.8,
                    )
                    guideline_updates += 1

    # 2. Detect tool failure patterns
    tool_failures = sum(
        1 for m in messages
        if m.get("role") == "tool" and "Error" in str(m.get("content", ""))
    )
    if tool_failures > 2:
        learnings.append(f"High tool failure rate: {tool_failures} errors in this turn")
        save_auto_memory(
            f"tool_failure_{int(time.time())}",
            {"count": tool_failures, "suggestion": "Review tool usage patterns"},
            category="learning",
            importance=0.7,
        )
        memory_updates += 1

    # 3. Extract user preferences from natural language
    for msg in messages:
        if msg.get("role") != "user":
            continue
        text = str(msg.get("content", "")) if isinstance(msg.get("content"), str) else ""

        for pattern, key in _PREFERENCE_PATTERNS:
            match = pattern.search(text)
            if match:
                value = match.group(1).strip()
                # Save to user profile
                profile = get_memory("user_profile") or {}
                if isinstance(profile, dict) and key not in profile:
                    profile[key] = value
                    save_memory("user_profile", profile)
                    learnings.append(f"Learned {key}: {value}")
                    memory_updates += 1

    # 4. Log this reflection for audit trail
    reflection = {
        "timestamp": time.time(),
        "model": model,
        "learnings": learnings,
        "guideline_updates": guideline_updates,
        "memory_updates": memory_updates,
        "tool_failures": tool_failures,
        "message_count": len(messages),
    }

    reflections = get_memory(_REFLECTION_KEY) or []
    if not isinstance(reflections, list):
        reflections = []
    reflections.append(reflection)
    reflections = reflections[-_MAX_REFLECTIONS:]  # Keep last 50
    save_memory(_REFLECTION_KEY, reflections)

    return reflection
