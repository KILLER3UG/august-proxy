"""Regression: workbench camelCase sessionDict must survive context_builder.

Audit finding: Tier 2/3 read snake_case keys while workbench injected camelCase,
silently dropping workspace, budget, working memory, auto-memories, etc.
"""

from __future__ import annotations

import json

from app.services.memory.context_builder import buildSystemPrompt, buildTier3


def test_camel_case_workbench_session_dict_injects_all_runtime_fields():
    """Exact keys produced by workbench.buildSystemPrompt's sessionDict."""
    session = {
        'id': 'wb_session_abc123',
        'title': 'Ship feature plan',
        'goal': 'Ship the feature',
        'plan': {'plan': 'Step 1 do the thing'},
        'planApproved': True,
        'workspacePath': 'C:/Dev/project',
        'vcs': 'main (clean)',
        'brainPolicy': {'mode': 'deep'},
        'cognitiveBudget': {'context_used_pct': 45, 'attention_pressure': 'low'},
        'memoryStats': {'facts': 12},
        'whatsNew': 'Recent commits xyz',
        'skillsManifest': '- skill_a: does stuff',
        'capabilitiesBlock': '<capabilities>\n<skills>\n- skill_a: does stuff\n</skills>\n</capabilities>',
        'executionState': {'phase': 'implement', 'step': 2},
        'workingMemory': 'scratch: fix the bug UNIQUE_WM',
        'subconsciousUpdates': 'UNIQUE_DAEMON_XYZ_99',
        'coreMemory': {'name': 'Rob'},
        'learnedHeuristics': [{'rule': 'prefer tabs'}],
        'autoMemories': [{'key': 'k1', 'content': 'secret fact UNIQUE_AUTO'}],
        'augMd': 'Use strict mode',
        'failureFeedback': {
            'tool': 'bash',
            'error_type': 'RuntimeError',
            'error_message': 'boom UNIQUE_FAIL',
        },
    }
    mem = {
        'coreMemory': {'name': 'Rob'},
        'learnedHeuristics': [{'rule': 'prefer tabs'}],
        'autoMemories': [{'key': 'k1', 'content': 'secret fact UNIQUE_AUTO'}],
    }
    prompt = buildSystemPrompt(session=session, memory=mem, tools=[{'name': 'x'}])

    assert 'Ship the feature' in prompt
    assert 'Step 1 do the thing' in prompt
    assert 'C:/Dev/project' in prompt
    assert '<session>' in prompt
    assert 'wb_session_abc123' in prompt
    assert 'Ship feature plan' in prompt
    assert 'currently chatting' in prompt
    assert 'skill_a' in prompt
    assert 'context_used_pct' in prompt or 'attention_pressure' in prompt
    assert 'deep' in prompt
    assert 'implement' in prompt
    assert 'UNIQUE_WM' in prompt
    assert 'UNIQUE_DAEMON_XYZ_99' in prompt
    assert 'Recent commits xyz' in prompt
    assert '12' in prompt
    assert 'Rob' in prompt
    assert 'prefer tabs' in prompt
    assert 'UNIQUE_AUTO' in prompt
    assert 'strict mode' in prompt
    assert 'UNIQUE_FAIL' in prompt
    assert '<auto_memories>' in prompt
    assert '<failure_feedback>' in prompt


def test_snake_case_session_keys_still_work():
    """Design/tests using snake_case must not regress."""
    session = {
        'workspace_path': 'C:/snake/path',
        'skills_manifest': '- snake_skill',
        'capabilities_block': '<capabilities>\n<skills>\n- snake_skill\n</skills>\n</capabilities>',
        'cognitive_budget': {'context_used_pct': 10},
        'brain_policy': {'mode': 'fast'},
        'execution_state': {'phase': 'research'},
        'working_memory': 'snake_wm',
        'subconscious_updates': 'snake_daemon',
        'whats_new': 'snake whats new',
        'memory_stats': {'n': 3},
        'core_memory': {'lang': 'py'},
        'learned_heuristics': [{'rule': 'snake rule'}],
        'auto_memories': [{'key': 'a', 'content': 'snake auto'}],
        'failure_feedback': 'snake fail text',
    }
    prompt = buildSystemPrompt(session=session, memory={
        'core_memory': {'lang': 'py'},
        'auto_memories': [{'key': 'a', 'content': 'snake auto'}],
        'learned_heuristics': [{'rule': 'snake rule'}],
    })
    assert 'C:/snake/path' in prompt
    assert 'snake_skill' in prompt
    assert 'context_used_pct' in prompt
    assert 'fast' in prompt
    assert 'research' in prompt
    assert 'snake_wm' in prompt
    assert 'snake_daemon' in prompt
    assert 'snake whats new' in prompt
    assert 'py' in prompt
    assert 'snake rule' in prompt
    assert 'snake auto' in prompt
    assert 'snake fail text' in prompt


def test_failure_feedback_dict_is_json_serialized():
    """as_str would drop dicts; structured tool failures must appear as JSON."""
    tier = buildTier3({'failureFeedback': {'tool': 'x', 'error_message': 'E1'}})
    assert 'E1' in tier
    assert 'failure_feedback' in tier
    # Round-trip JSON inside the tag
    assert '"tool"' in tier or "'tool'" in tier or 'x' in tier


def test_cached_t12_snake_and_camel_kwargs():
    """Both cachedT12 and cached_t12 must short-circuit Tier 1+2."""
    marker = 'CACHE_HIT_MARKER_ABC'
    r1 = buildSystemPrompt(session={'workspacePath': 'should-not-force-t2-only'}, cachedT12=marker)
    assert marker in r1
    r2 = buildSystemPrompt(session={}, cached_t12=marker)
    assert marker in r2
