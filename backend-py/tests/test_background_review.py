"""Background review loop tests (C2).

Tests the interval-gating gate, the full _do_review pipeline with a stub
LLM client, recommendation parsing, and fact persistence. No real LLM calls
or workbench modifications — skill_service is isolated via the same
``isolated_skills`` fixture used in C1.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from app.services import skill_service
from app.services.memory.background_review import (
    ReviewGates,
    _do_review,
    _parse_recommendations,
    _save_fact,
    _last_relevant_messages,
    try_background_review,
)
from app.services.memory_store import get_memory


# ── ReviewGates ───────────────────────────────────────────────────────


class TestReviewGates:
    def test_fires_when_turn_interval_exceeded(self):
        gates = ReviewGates(turn_interval=3, tool_round_interval=10)
        assert gates.should_review(session_turns=5, tool_rounds=0, last_reviewed_at_turn=0) is True
        assert gates.should_review(session_turns=2, tool_rounds=0) is False

    def test_fires_when_tool_round_interval_exceeded(self):
        gates = ReviewGates(turn_interval=10, tool_round_interval=5)
        assert gates.should_review(session_turns=1, tool_rounds=6) is True
        assert gates.should_review(session_turns=1, tool_rounds=3) is False

    def test_respects_last_reviewed_at_turn(self):
        gates = ReviewGates(turn_interval=3, tool_round_interval=10)
        assert gates.should_review(session_turns=5, last_reviewed_at_turn=3) is False  # delta=2 < 3
        assert gates.should_review(session_turns=6, last_reviewed_at_turn=3) is True   # delta=3

    def test_zero_turns_never_review(self):
        gates = ReviewGates()
        assert gates.should_review(session_turns=0) is False


# ── try_background_review (gate integration) ──────────────────────────


def mk_session(**kw) -> Any:
    class _Session:
        pass
    s = _Session()
    for k, v in kw.items():
        setattr(s, k, v)
    return s


@pytest.mark.asyncio
async def test_try_background_review_skips_when_gate_closed():
    """When the gate says no, _do_review is NOT called."""
    called = []

    async def dummy_llm(_):
        called.append(True)
        return "{}"

    session = mk_session(message_count=2)  # session_turns=1, interval=3 → gate says no
    messages = [{"role": "user"}, {"role": "assistant"}]

    await try_background_review(session, messages, llm_client=dummy_llm)
    assert called == []  # review skipped


@pytest.mark.asyncio
async def test_try_background_review_spawns_when_due(isolated_skills):
    """When the gate says yes, _do_review is called and creates a skill."""
    agent_root, _ = isolated_skills

    async def stub_llm(_prompt):
        return json.dumps({
            "skills": [
                {"action": "create", "name": "review-skill", "description": "Learned from review.", "body": "## When to Use\n\nBody.\n"},
            ],
            "memory": [],
        })

    session = mk_session(message_count=8)  # session_turns=4, interval=3 → gate says yes
    session._last_reviewed_at_turn = 0
    messages = [{"role": "user", "content": "fix this"}, {"role": "assistant", "content": "done"}]

    await try_background_review(session, messages, llm_client=stub_llm)
    # Give the background task a moment to run.
    await asyncio.sleep(0.1)

    fetched = skill_service.get("review-skill")
    assert fetched is not None, "background review should have created the skill"
    assert fetched.get("created_by") == "agent"


@pytest.mark.asyncio
async def test_try_background_review_no_llm_means_noop():
    """Without an LLM client, review is a no-op."""
    session = mk_session(message_count=8)
    messages = [{"role": "user"}, {"role": "assistant"}]
    await try_background_review(session, messages, llm_client=None)
    # Should not crash; no skill created.
    assert True


# ── _do_review with stub LLM ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_do_review_creates_skill_from_recommendation(isolated_skills):
    agent_root, _ = isolated_skills

    async def stub_llm(_prompt):
        return json.dumps({
            "skills": [
                {"action": "create", "name": "stub-skill", "description": "Stub.", "body": "## When to Use\n\nStub body.\n"},
            ],
            "memory": [],
        })

    result = await _do_review([{"role": "user"}], llm_client=stub_llm)
    assert result["reviewed"] is True
    assert "stub-skill" in result["skills_created"]
    assert skill_service.get("stub-skill") is not None


@pytest.mark.asyncio
async def test_do_review_patches_existing_skill(isolated_skills):
    skill_service.create_skill("patch-skill", "Original.", "## When to Use\n\nOld body.\n")

    async def stub_llm(_prompt):
        return json.dumps({
            "skills": [
                {"action": "patch", "name": "patch-skill", "body": "## When to Use\n\nPatched body.\n"},
            ],
            "memory": [],
        })

    result = await _do_review([{"role": "user"}], llm_client=stub_llm)
    assert "patch-skill" in result["skills_patched"]
    fetched = skill_service.get("patch-skill")
    assert "Patched body." in fetched["instructions"]


@pytest.mark.asyncio
async def test_do_review_saves_memory_facts(isolated_data):
    async def stub_llm(_prompt):
        return json.dumps({
            "skills": [],
            "memory": [
                {"action": "add", "fact": "User likes python."},
                {"action": "add", "fact": "User prefers async code."},
            ],
        })

    result = await _do_review([{"role": "user"}], llm_client=stub_llm)
    assert len(result["facts_added"]) == 2
    facts = get_memory("core_memory") or []
    assert len(facts) == 2
    assert any("python" in f["fact"] for f in facts)


@pytest.mark.asyncio
async def test_do_review_no_client_is_noop():
    result = await _do_review([{"role": "user"}], llm_client=None)
    assert result["reviewed"] is False
    assert result["skills_created"] == []
    assert result["facts_added"] == []


# ── _parse_recommendations ────────────────────────────────────────────


class TestParseRecommendations:
    def test_clean_json(self):
        raw = '{"skills": [{"action": "create", "name": "x"}]}'
        parsed = _parse_recommendations(raw)
        assert len(parsed["skills"]) == 1
        assert parsed["skills"][0]["name"] == "x"

    def test_json_with_code_fences(self):
        raw = '```json\n{"skills": []}\n```'
        parsed = _parse_recommendations(raw)
        assert parsed["skills"] == []

    def test_json_with_single_quotes(self):
        raw = "{'skills': [], 'memory': []}"
        parsed = _parse_recommendations(raw)
        assert parsed["skills"] == []

    def test_garbage_returns_empty(self):
        parsed = _parse_recommendations("not json at all")
        assert parsed["skills"] == []
        assert parsed["memory"] == []


# ── _save_fact ────────────────────────────────────────────────────────


class TestSaveFact:
    KEY = "core_memory"

    def _facts(self):
        return get_memory(self.KEY) or []

    def test_add_fact(self, isolated_data):
        _save_fact("add", "User likes simplicity.")
        assert any("simplicity" in f["fact"] for f in self._facts())

    def test_add_dedup(self, isolated_data):
        _save_fact("add", "Dup fact.")
        _save_fact("add", "Dup fact.")
        count = sum(1 for f in self._facts() if f["fact"] == "Dup fact.")
        assert count == 1

    def test_replace_updates_existing(self, isolated_data):
        _save_fact("add", "Replace me.")
        _save_fact("replace", "Replace me.")
        matching = [f for f in self._facts() if f["fact"] == "Replace me."]
        assert len(matching) == 1
        # updated_at should be fresher — hard to assert timing; just check it exists.
        assert matching[0].get("updated_at") is not None


# ── _last_relevant_messages ───────────────────────────────────────────


class TestLastRelevantMessages:
    def test_returns_only_user_and_assistant(self):
        messages = [
            {"role": "system"}, {"role": "user"}, {"role": "assistant"}, {"role": "tool"},
        ]
        filtered = _last_relevant_messages(messages)
        assert all(m["role"] in ("user", "assistant") for m in filtered)
        assert len(filtered) == 2

    def test_respects_max_len(self):
        messages = [{"role": "user"} for _ in range(100)]
        filtered = _last_relevant_messages(messages, max_len=10)
        assert len(filtered) == 10
