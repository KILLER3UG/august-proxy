"""Background review — interval-gated after-turn reflection loop.

Modeled on Hermes ``agent/background_review.py`` which runs a daemon AIAgent
that replays the conversation snapshot and asks whether any skill or memory
should be saved or updated.

Key design points (matching Hermes):
- Fires after a turn, **interval-gated** — not every turn (controlled by
  ``ReviewGates.turn_interval`` and ``tool_round_interval``).
- Runs as a background ``asyncio.Task`` (does not block the response).
- Uses a **side LLM** call (separate from the main session's prompt cache;
  configurable, defaults to no-op unless ``llm_client`` is provided).
- Skill review: writes lessons into **agent-authored skills** via
  ``skill_service.create_skill/patch_skill`` so the model loads them via
  ``load_skill`` (the Hermes model — replacing the learned-guidelines store).
- Memory review: stores user facts in the core memory KV store.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from app.services import skill_service

log = logging.getLogger(__name__)

# ── Gates (interval control) ──────────────────────────────────────────

_TURN_INTERVAL = 3        # fire review every N complete user turns
_TOOL_ROUND_INTERVAL = 6  # or every M tool-call rounds, whichever hits first


@dataclass
class ReviewGates:
    turn_interval: int = _TURN_INTERVAL
    tool_round_interval: int = _TOOL_ROUND_INTERVAL

    def should_review(
        self,
        *,
        session_turns: int = 0,
        tool_rounds: int = 0,
        last_reviewed_at_turn: int = 0,
    ) -> bool:
        if session_turns <= 0:
            return False
        turn_delta = session_turns - last_reviewed_at_turn
        return turn_delta >= self.turn_interval or tool_rounds >= self.tool_round_interval


# ── Injectable LLM client ─────────────────────────────────────────────
# Accepts an OpenAI-format message list, returns the assistant content string.
# Default ``None`` → no-op (review skipped until configured).
ReviewClient = Optional[Callable[[list[dict[str, Any]]], str]]


async def try_background_review(
    session: Any,
    messages_snapshot: list[dict[str, Any]],
    *,
    gates: ReviewGates | None = None,
    llm_client: ReviewClient = None,
) -> None:
    """Check gates and, if it is time, fire a background review.

    Called once per turn from the workbench finalizer. The gate check is
    synchronous; the actual review spawns a background ``asyncio.Task`` so
    the user receives the response immediately.
    """
    if not messages_snapshot:
        return

    last_turn = getattr(session, "_last_reviewed_at_turn", 0)
    session_turns = getattr(session, "message_count", 0) // 2
    tool_rounds = len([m for m in messages_snapshot if m.get("role") == "tool"])
    gates = gates or ReviewGates()

    if not gates.should_review(
        session_turns=session_turns,
        tool_rounds=tool_rounds,
        last_reviewed_at_turn=last_turn,
    ):
        return

    session._last_reviewed_at_turn = session_turns

    asyncio.create_task(
        _do_review(messages_snapshot, llm_client=llm_client),
    )


async def _do_review(
    messages_snapshot: list[dict[str, Any]],
    *,
    llm_client: ReviewClient = None,
) -> dict[str, Any]:
    """Run the actual review — call the side LLM, parse recommendations, apply."""
    result: dict[str, Any] = {
        "reviewed": False,
        "skills_created": [],
        "skills_patched": [],
        "facts_added": [],
        "errors": [],
    }

    if llm_client is None:
        return result

    prompt = _build_review_prompt(messages_snapshot)
    try:
        raw = await llm_client(prompt)
    except Exception as exc:
        log.warning("background_review: LLM call failed: %s", exc)
        result["errors"].append(str(exc))
        return result

    recommendations = _parse_recommendations(raw)
    result["reviewed"] = True

    for rec in recommendations.get("skills", []):
        try:
            action = rec.get("action", "create")
            name = rec.get("name", "")
            if not name:
                continue
            if action == "create":
                skill_service.create_skill(
                    name,
                    rec.get("description", ""),
                    rec.get("body", ""),
                    trigger=rec.get("trigger", ""),
                    category=rec.get("category", "uncategorized"),
                )
                result["skills_created"].append(name)
            elif action == "patch":
                skill_service.patch_skill(
                    name,
                    body=rec.get("body"),
                    description=rec.get("description"),
                )
                result["skills_patched"].append(name)
        except Exception as exc:
            log.warning("background_review: skill '%s' failed: %s", rec.get("name"), exc)
            result["errors"].append(str(exc))

    for fact in recommendations.get("memory", []):
        try:
            action = fact.get("action", "add")
            content = fact.get("fact", "")
            if not content:
                continue
            _save_fact(action, content)
            result["facts_added"].append(content[:80])
        except Exception as exc:
            result["errors"].append(str(exc))

    return result


# ── Prompt building ───────────────────────────────────────────────────


def _build_review_prompt(messages_snapshot: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Build an OpenAI-format message list for the review LLM."""
    system_msg = {
        "role": "system",
        "content": (
            "You are reviewing a conversation between a user and an AI assistant. "
            "Identify any lessons, corrections, or recurring patterns that should be "
            "saved for future interactions.\n\n"
            "Respond with a JSON object only (no markdown, no code fences):\n"
            "{\n"
            '  "skills": [\n'
            "    {\n"
            '      "action": "create" | "patch",\n'
            '      "name": "lowercase-dotted-name",\n'
            '      "description": "≤60 chars, one sentence",\n'
            '      "body": "Full SKILL.md body markdown (sections: When to Use, Prerequisites, How to Run, Quick Reference, Procedure, Pitfalls, Verification)",\n'
            '      "trigger": "optional trigger phrase",\n'
            '      "category": "optional-category"\n'
            "    }\n"
            "  ],\n"
            '  "memory": [\n'
            "    {\n"
            '      "action": "add" | "replace",\n'
            '      "fact": "User prefers short answers."\n'
            "    }\n"
            "  ]\n"
            "}\n\n"
            "Only include skills/memory that are genuinely new or corrective. "
            "Do NOT create a skill for every turn — be selective."
        ),
    }
    # The snapshot is already in OpenAI message format.
    return [system_msg] + _last_relevant_messages(messages_snapshot, max_len=60)


def _last_relevant_messages(
    messages: list[dict[str, Any]],
    max_len: int = 60,
) -> list[dict[str, Any]]:
    """Take the tail of the conversation — user + assistant turns only."""
    relevant = [m for m in messages if m.get("role") in ("user", "assistant")]
    return relevant[-max_len:] if len(relevant) > max_len else relevant


# ── Response parsing ──────────────────────────────────────────────────


def _parse_recommendations(raw: str) -> dict[str, Any]:
    """Parse the LLM JSON response, handling common edge cases."""
    text = raw.strip()
    if text.startswith("```"):
        lines = text.split("\n", 1)
        text = lines[1] if len(lines) > 1 else ""
        if text.endswith("```"):
            text = text[:-3]
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Fallback: single-quote keys.
        text = text.replace("'", '"')
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            log.warning("background_review: could not parse: %.200s", text)
            return {"skills": [], "memory": []}


# ── Fact persistence ──────────────────────────────────────────────────


def _save_fact(action: str, content: str) -> None:
    """Save a fact to the core memory KV store."""
    from app.services.memory_store import get_memory, save_memory  # noqa: PLC0415

    KEY = "core_memory"
    facts: list[dict] = get_memory(KEY) or []
    if not isinstance(facts, list):
        facts = []

    now = __import__("time").time()

    if action == "replace":
        for i, f in enumerate(facts):
            if isinstance(f, dict) and f.get("fact", "") == content:
                facts[i] = {"fact": content, "updated_at": now}
                save_memory(KEY, facts)
                return
        # No match → append.
        facts.append({"fact": content, "updated_at": now})
    else:
        # add — avoid exact duplicate.
        for f in facts:
            if isinstance(f, dict) and f.get("fact", "") == content:
                return
        facts.append({"fact": content, "updated_at": now})

    save_memory(KEY, facts)
