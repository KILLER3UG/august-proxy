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

pytestmark = pytest.mark.skipif(
    not os.environ.get('RUN_REAL_LLM'),
    reason='Real-LLM tests skipped by default. Set RUN_REAL_LLM=1 to enable (requires network access).',
)
EXTERNAL_API_URL = 'https://opencode.ai/zen/v1/chat/completions'
EXTERNAL_API_KEY = 'sk-LTe2jmtwB5VQe0J5jWoqrshlE0SJKN0zVkpOSpLySLbmzAT1uSOOyu5UIG5UEMZM'
TEST_MODEL = 'deepseek-v4-flash-free'


def callExternalLlm(prompt: str, system: str | None = None, *, timeout: float = 60.0) -> str:
    """Call the external test endpoint and return the assistant text."""
    messages: list[dict[str, str]] = []
    if system:
        messages.append({'role': 'system', 'content': system})
    messages.append({'role': 'user', 'content': prompt})
    with httpx.Client(timeout=timeout) as client:
        resp = client.post(
            EXTERNAL_API_URL,
            headers={'Authorization': f'Bearer {EXTERNAL_API_KEY}', 'Content-Type': 'application/json'},
            json={'model': TEST_MODEL, 'messages': messages},
        )
        resp.raise_for_status()
        data = resp.json()
        return data['choices'][0]['message']['content']


def _stripCodeFence(text: str) -> str:
    """Strip leading/trailing ```json ... ``` fences if present."""
    text = text.strip()
    if text.startswith('```'):
        lines = text.split('\n')
        if lines[0].startswith('```'):
            lines = lines[1:]
        if lines and lines[-1].startswith('```'):
            lines = lines[:-1]
        text = '\n'.join(lines).strip()
    return text


def testExternalEndpointResponds():
    """Sanity check: the external endpoint is reachable and returns text."""
    response = callExternalLlm("Reply with exactly the word 'pong' and nothing else.")
    assert isinstance(response, str)
    assert len(response) > 0
    print(f'\n[LLM] Sanity response: {response[:200]}')


def testConsolidationRealHippocampusProducesValidJson():
    """Run consolidation's prompt with the real LLM. The response should be
    parseable JSON with the expected schema (merge/promote/delete)."""
    sampleHeuristics = [
        {'id': 1, 'rule': 'User prefers Yarn over NPM', 'category': 'build'},
        {'id': 2, 'rule': 'Use Yarn not NPM', 'category': 'build'},
        {'id': 3, 'rule': 'JWT tokens should expire in 1 hour', 'category': 'auth'},
        {'id': 4, 'rule': 'Always run pytest before commit', 'category': 'test'},
    ]
    sampleMemories = [
        {'id': 1, 'content': 'Fixed JWT expiry bug in auth.py', 'importance': 0.8},
        {'id': 2, 'content': 'Added Yarn to project dependencies', 'importance': 0.6},
    ]
    prompt = f"""Review these auto_memories and learned_heuristics. Return a JSON plan:\n{{'merge': [{{'keep_id': int, 'remove_ids': [int, ...], 'merged_rule': str}}],\n 'promote': [{{'pattern': str, 'fact_key': str, 'fact_value': str}}],\n 'delete': [int, ...]}}\nAuto memories ({len(sampleMemories)}):\n{json.dumps(sampleMemories, default=str)[:1500]}\n\nHeuristics ({len(sampleHeuristics)}):\n{json.dumps(sampleHeuristics, default=str)[:1500]}\n\nPreserve the most recent 20 rules (do not delete them).\nIf there's nothing to do, return {{"merge": [], "promote": [], "delete": []}}.\nReturn ONLY the JSON object, no other text or markdown."""
    response = callExternalLlm(prompt)
    cleaned = _stripCodeFence(response)
    print(f'\n[LLM] Consolidation response: {cleaned[:500]}')
    parsed = json.loads(cleaned)
    assert isinstance(parsed, dict)
    assert 'merge' in parsed
    assert 'promote' in parsed
    assert 'delete' in parsed
    mergeOps = parsed.get('merge', [])
    if mergeOps:
        allMergedIds = set()
        for m in mergeOps:
            allMergedIds.add(m.get('keep_id'))
            allMergedIds.update(m.get('remove_ids', []))
        assert allMergedIds & {1, 2}, f'Expected LLM to detect Yarn/Use-Yarn merge, got: {mergeOps}'


def testSkillGenesisRealPrefrontalProducesSkillJson():
    """Run skill genesis's prompt with the real LLM. Response should be a
    valid SKILL.md draft JSON."""
    sessionSummary = "User asked me to debug a Python script that was failing with JWT token expiry. I read auth.py, found the bug on line 48 (expiresIn was set to '30d' instead of '1h'), fixed it, and verified the fix with pytest. The fix took 4 steps and involved reading the file, identifying the bug, modifying the code, and running tests."
    prompt = f"This session completed a complex multi-step workflow. Is this workflow generic enough to be turned into a reusable skill? If yes, draft a SKILL.md with: name, description, trigger, and step-by-step body. Return JSON: {{'name': str, 'description': str, 'trigger': str, 'body': str}} or {{'skip': true, 'reason': str}}.\n\nSession summary:\n{sessionSummary}\nReturn ONLY the JSON object, no other text or markdown."
    response = callExternalLlm(prompt)
    cleaned = _stripCodeFence(response)
    print(f'\n[LLM] Skill genesis response: {cleaned[:500]}')
    parsed = json.loads(cleaned)
    if not parsed.get('skip'):
        assert 'name' in parsed and len(parsed['name']) > 0
        assert 'body' in parsed and len(parsed['body']) > 0
        assert 'description' in parsed
        name = parsed['name']
        isCamelCase = (
            ' ' not in name
            and '-' not in name
            and ('_' not in name)
            and name[0].islower()
            and all((c.isalnum() for c in name))
        )
        if not isCamelCase:
            print(
                f"\n[NOTE] LLM produced non-camelCase name: {name!r}. v2 prompt asks for camelCase, but the LLM didn't comply. Consider sanitizing the name in production."
            )


def testDeltaEngineRealHippocampusInfersRules():
    """Run delta engine's prompt with the real LLM. Response should be a
    valid rules inference JSON."""
    diffText = 'diff --git a/api.js b/api.js\n@@ -1,5 +1,5 @@\n-const x = await fetch(url).then(r => r.json());\n-const y = await fetch(url2).then(r => r.json());\n-const z = await fetch(url3).then(r => r.json());\n+const x = await fetch(url).then(r => await r.json());\n+const y = await fetch(url2).then(r => await r.json());\n+const z = await fetch(url3).then(r => await r.json());\n'
    prompt = f"Review these diffs between the assistant's output and the user's edits. Infer up to 3 behavioral rules. Return JSON: {{'rules': [{{'rule': str, 'category': str}}]}} or {{'rules': []}}.\n\nDiffs:\n{diffText}\nReturn ONLY the JSON object, no other text or markdown."
    response = callExternalLlm(prompt)
    cleaned = _stripCodeFence(response)
    print(f'\n[LLM] Delta engine response: {cleaned[:500]}')
    parsed = json.loads(cleaned)
    assert 'rules' in parsed
    assert isinstance(parsed['rules'], list)
    if parsed['rules']:
        for rule in parsed['rules']:
            assert 'rule' in rule
            assert len(rule['rule']) > 0


if __name__ == '__main__':
    print('=' * 60)
    print('v2 Real-LLM Integration Tests')
    print(f'Endpoint: {EXTERNAL_API_URL}')
    print(f'Model: {TEST_MODEL}')
    print('=' * 60)
    os.environ['RUN_REAL_LLM'] = '1'
    pytest.main([__file__, '-v', '-s', '--tb=short', '-p', 'no:cacheprovider'])
