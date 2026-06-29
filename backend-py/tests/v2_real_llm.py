"""v2 — Real-LLM integration tests using external test endpoint.

These tests verify that the v2 LLM-dependent code paths (consolidation,
skill genesis, delta engine) actually work with a real LLM, not just mocks.

**These tests are SKIPPED by default.** To run them:

    RUN_REAL_LLM=1 pytest tests/v2_real_llm.py -v -s

The tests use an external OpenAI-compatible endpoint and a free-tier
model. They are slow (~10-30s each) because they make real HTTP calls.

The tests DO NOT call the v2 `_call_hippocampus` / `_call_prefrontal`
functions directly (those use the provider client system which requires
a fully-configured provider in `data/config.json`). Instead, they:

  1. Build the same prompts the v2 code would send
  2. Call the external endpoint directly via httpx
  3. Verify the response is parseable and sensible

This validates that the *prompts* the v2 code uses produce sensible
LLM output. To exercise the full v2 code path, the v2 caller must
have a properly-configured provider (see data/config.json).
"""
import json
import os

import httpx
import pytest

# Skip all tests unless explicitly enabled
pytestmark = pytest.mark.skipif(
    not os.environ.get("RUN_REAL_LLM"),
    reason=(
        "Real-LLM tests skipped by default. "
        "Set RUN_REAL_LLM=1 to enable (requires network access)."
    ),
)


# External test endpoint config
EXTERNAL_API_URL = "https://opencode.ai/zen/v1/chat/completions"
EXTERNAL_API_KEY = (
    "sk-LTe2jmtwB5VQe0J5jWoqrshlE0SJKN0zVkpOSpLySLbmzAT1uSOOyu5UIG5UEMZM"
)
TEST_MODEL = "deepseek-v4-flash-free"


def call_external_llm(
    prompt: str,
    system: str | None = None,
    *,
    timeout: float = 60.0,
) -> str:
    """Call the external test endpoint and return the assistant text."""
    messages: list[dict[str, str]] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    with httpx.Client(timeout=timeout) as client:
        resp = client.post(
            EXTERNAL_API_URL,
            headers={
                "Authorization": f"Bearer {EXTERNAL_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": TEST_MODEL,
                "messages": messages,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


def _strip_code_fence(text: str) -> str:
    """Strip leading/trailing ```json ... ``` fences if present."""
    text = text.strip()
    if text.startswith("```"):
        # Find end of first line (the language tag) and last ```
        lines = text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return text


# ── Sanity check ────────────────────────────────────────────────────────


def test_external_endpoint_responds():
    """Sanity check: the external endpoint is reachable and returns text."""
    response = call_external_llm(
        "Reply with exactly the word 'pong' and nothing else."
    )
    assert isinstance(response, str)
    assert len(response) > 0
    # Most free models honor this; we don't strictly require "pong"
    # (it might be wrapped in quotes or markdown) but the response should
    # mention the word.
    print(f"\n[LLM] Sanity response: {response[:200]}")


# ── Consolidation path ──────────────────────────────────────────────────


def test_consolidation_real_hippocampus_produces_valid_json():
    """Run consolidation's prompt with the real LLM. The response should be
    parseable JSON with the expected schema (merge/promote/delete)."""
    # Sample heuristics (the v2 code queries recent ones)
    sample_heuristics = [
        {"id": 1, "rule": "User prefers Yarn over NPM", "category": "build"},
        {"id": 2, "rule": "Use Yarn not NPM", "category": "build"},
        {"id": 3, "rule": "JWT tokens should expire in 1 hour", "category": "auth"},
        {"id": 4, "rule": "Always run pytest before commit", "category": "test"},
    ]
    sample_memories = [
        {"id": 1, "content": "Fixed JWT expiry bug in auth.py", "importance": 0.8},
        {"id": 2, "content": "Added Yarn to project dependencies", "importance": 0.6},
    ]

    # This is the prompt shape v2 uses (see consolidation_daemon.py)
    prompt = (
        "Review these auto_memories and learned_heuristics. Return a JSON plan:\n"
        "{'merge': [{'keep_id': int, 'remove_ids': [int, ...], 'merged_rule': str}],\n"
        " 'promote': [{'pattern': str, 'fact_key': str, 'fact_value': str}],\n"
        " 'delete': [int, ...]}\n"
        f"Auto memories ({len(sample_memories)}):\n"
        f"{json.dumps(sample_memories, default=str)[:1500]}\n\n"
        f"Heuristics ({len(sample_heuristics)}):\n"
        f"{json.dumps(sample_heuristics, default=str)[:1500]}\n\n"
        "Preserve the most recent 20 rules (do not delete them).\n"
        "If there's nothing to do, return {\"merge\": [], \"promote\": [], \"delete\": []}.\n"
        "Return ONLY the JSON object, no other text or markdown."
    )

    response = call_external_llm(prompt)
    cleaned = _strip_code_fence(response)
    print(f"\n[LLM] Consolidation response: {cleaned[:500]}")

    parsed = json.loads(cleaned)
    assert isinstance(parsed, dict)
    assert "merge" in parsed
    assert "promote" in parsed
    assert "delete" in parsed
    # The two Yarn heuristics should be merged (the LLM should detect this)
    merge_ops = parsed.get("merge", [])
    if merge_ops:
        # If the LLM detected a merge, verify it references rule IDs 1 or 2
        all_merged_ids = set()
        for m in merge_ops:
            all_merged_ids.add(m.get("keep_id"))
            all_merged_ids.update(m.get("remove_ids", []))
        assert all_merged_ids & {1, 2}, (
            f"Expected LLM to detect Yarn/Use-Yarn merge, got: {merge_ops}"
        )


# ── Skill genesis path ──────────────────────────────────────────────────


def test_skill_genesis_real_prefrontal_produces_skill_json():
    """Run skill genesis's prompt with the real LLM. Response should be a
    valid SKILL.md draft JSON."""
    session_summary = (
        "User asked me to debug a Python script that was failing with "
        "JWT token expiry. I read auth.py, found the bug on line 48 "
        "(expiresIn was set to '30d' instead of '1h'), fixed it, and "
        "verified the fix with pytest. The fix took 4 steps and involved "
        "reading the file, identifying the bug, modifying the code, and "
        "running tests."
    )

    prompt = (
        "This session completed a complex multi-step workflow. "
        "Is this workflow generic enough to be turned into a reusable skill? "
        "If yes, draft a SKILL.md with: name, description, trigger, and "
        "step-by-step body. "
        "Return JSON: {'name': str, 'description': str, 'trigger': str, "
        "'body': str} or {'skip': true, 'reason': str}.\n\n"
        f"Session summary:\n{session_summary}\n"
        "Return ONLY the JSON object, no other text or markdown."
    )

    response = call_external_llm(prompt)
    cleaned = _strip_code_fence(response)
    print(f"\n[LLM] Skill genesis response: {cleaned[:500]}")

    parsed = json.loads(cleaned)
    if not parsed.get("skip"):
        assert "name" in parsed and len(parsed["name"]) > 0
        assert "body" in parsed and len(parsed["body"]) > 0
        assert "description" in parsed
        # Warn (don't fail) if the name isn't camelCase — the v2 prompt
        # instructs camelCase, but small LLMs may not always comply.
        name = parsed["name"]
        is_camel_case = (
            " " not in name
            and "-" not in name
            and "_" not in name
            and name[0].islower()
            and all(c.isalnum() for c in name)
        )
        if not is_camel_case:
            print(
                f"\n[NOTE] LLM produced non-camelCase name: {name!r}. "
                "v2 prompt asks for camelCase, but the LLM didn't comply. "
                "Consider sanitizing the name in production."
            )


# ── Delta engine path ───────────────────────────────────────────────────


def test_delta_engine_real_hippocampus_infers_rules():
    """Run delta engine's prompt with the real LLM. Response should be a
    valid rules inference JSON."""
    # A diff showing the user changing sync code to async
    diff_text = (
        "diff --git a/api.js b/api.js\n"
        "@@ -1,5 +1,5 @@\n"
        "-const x = await fetch(url).then(r => r.json());\n"
        "-const y = await fetch(url2).then(r => r.json());\n"
        "-const z = await fetch(url3).then(r => r.json());\n"
        "+const x = await fetch(url).then(r => await r.json());\n"
        "+const y = await fetch(url2).then(r => await r.json());\n"
        "+const z = await fetch(url3).then(r => await r.json());\n"
    )

    prompt = (
        "Review these diffs between the assistant's output and the user's "
        "edits. Infer up to 3 behavioral rules. Return JSON: "
        "{'rules': [{'rule': str, 'category': str}]} or {'rules': []}.\n\n"
        f"Diffs:\n{diff_text}\n"
        "Return ONLY the JSON object, no other text or markdown."
    )

    response = call_external_llm(prompt)
    cleaned = _strip_code_fence(response)
    print(f"\n[LLM] Delta engine response: {cleaned[:500]}")

    parsed = json.loads(cleaned)
    assert "rules" in parsed
    assert isinstance(parsed["rules"], list)
    if parsed["rules"]:
        for rule in parsed["rules"]:
            assert "rule" in rule
            assert len(rule["rule"]) > 0


# ── Standalone script support ───────────────────────────────────────────


if __name__ == "__main__":
    # Allow running as a standalone Python script
    print("=" * 60)
    print("v2 Real-LLM Integration Tests")
    print(f"Endpoint: {EXTERNAL_API_URL}")
    print(f"Model: {TEST_MODEL}")
    print("=" * 60)

    os.environ["RUN_REAL_LLM"] = "1"
    # Use pytest's main() to run with the marker enabled
    pytest.main([__file__, "-v", "-s", "--tb=short", "-p", "no:cacheprovider"])
