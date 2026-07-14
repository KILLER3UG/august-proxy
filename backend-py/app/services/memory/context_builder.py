"""
Context builder — assembles the 3-tier XML system prompt (Phase 1).

Tier 1: Identity & Constraints (static, cacheable)
Tier 2: Environment & Experience (semi-stable, high cache)
Tier 3: Dynamic Runtime (volatile, rebuilt every turn)

Port of backend/services/memory/context-builder.js (224 lines).

Key contract: session/memory dicts may use camelCase (workbench wire) or
snake_case (design/tests). ``_get`` accepts either so renames cannot silently
drop Tier 2/3 blocks.
"""

from __future__ import annotations

import json
from typing import Any

from app.json_narrowing import as_str, as_dict, as_list, as_int
from app.services.memory_store import get_memory

AUGUST_PLATFORM: str = 'Platform: August Proxy.\n- Cross-session memory tools are available: memory_search() to find past conversations, fact_search() for structured facts, context_read() for user profile.\n- Save recurring user corrections/lessons as skills via `skill_manage`; load them via `load_skill`.\n- Note: "August" or "August Proxy" is the name of this proxy platform. You are still yourself — respond as your actual underlying model identity.\n- Address the user neutrally without honorifics.'
DEFAULT_CONTEXT_MAX_CHARS: int = 24000

# camelCase (workbench) → snake_case (design/tests) aliases for dual-get.
_KEY_ALIASES: dict[str, tuple[str, ...]] = {
    'skills_manifest': ('skillsManifest', 'skills_manifest'),
    'workspace_path': ('workspacePath', 'workspace_path'),
    'cognitive_budget': ('cognitiveBudget', 'cognitive_budget'),
    'brain_policy': ('brainPolicy', 'brain_policy'),
    'execution_state': ('executionState', 'execution_state'),
    'working_memory': ('workingMemory', 'working_memory'),
    'failure_feedback': ('failureFeedback', 'failure_feedback'),
    'subconscious_updates': ('subconsciousUpdates', 'subconscious_updates'),
    'blackboard_state': ('blackboardState', 'blackboard_state'),
    'primed_playbooks': ('primedPlaybooks', 'primed_playbooks'),
    'whats_new': ('whatsNew', 'whats_new'),
    'memory_stats': ('memoryStats', 'memory_stats'),
    'agent_context': ('agentContext', 'agent_context'),
    'global_context': ('global_context', 'globalContext'),
    'active_projects': ('active_projects', 'activeProjects'),
    'coreMemory': ('coreMemory', 'core_memory'),
    'learnedHeuristics': ('learnedHeuristics', 'learned_heuristics'),
    'autoMemories': ('autoMemories', 'auto_memories'),
    'userProfile': ('userProfile', 'user_profile'),
    'planApproved': ('planApproved', 'plan_approved'),
}


def wrapTag(tag: str, content: str, attrs: str = '') -> str:
    """Wrap content in a faux XML tag."""
    suffix = f' {attrs}' if attrs else ''
    return f'<{tag}{suffix}>\n{content or ""}\n</{tag}>'


def _fmtVal(val: object, maxChars: int = 500) -> str:
    """Format a value as a string, truncated to max_chars."""
    if val is None:
        return ''
    s = str(val)
    if len(s) > maxChars:
        s = s[:maxChars] + '...'
    return s


def _get(session: dict[str, object] | None, *keys: str, default: Any = None) -> Any:
    """Read a field accepting camelCase and/or snake_case keys.

    Tries each key in order, then any registered aliases for those keys.
    First non-None hit wins (empty string / empty list / False are valid).
    """
    s = session or {}
    tried: set[str] = set()
    candidates: list[str] = []
    for k in keys:
        candidates.append(k)
        for alt in _KEY_ALIASES.get(k, ()):
            candidates.append(alt)
        # Also allow reverse lookup: if caller passes camel, try snake aliases.
        for canon, alts in _KEY_ALIASES.items():
            if k in alts or k == canon:
                candidates.append(canon)
                candidates.extend(alts)
    for k in candidates:
        if k in tried:
            continue
        tried.add(k)
        if k in s and s[k] is not None:
            return s[k]
    return default


def _fmt_jsonish(val: object) -> str:
    """Serialize dict/list for prompt blocks; strings pass through."""
    if isinstance(val, (dict, list)):
        return json.dumps(val, indent=2, default=str, ensure_ascii=False)
    if isinstance(val, str):
        return val
    return str(val) if val is not None else ''


def buildTier1(session: dict[str, object] | None = None) -> str:
    """Build Tier 1 — static identity and constraints."""
    blocks: list[str] = []
    constraints = [AUGUST_PLATFORM]
    constraints.extend(
        [
            '=== GUARD MODE RULES ===',
            '- This session enforces a guard mode. You operate in one of three modes:',
            '  * ask: All mutating actions (write, edit, delete, run_command with mutations)',
            '         require user confirmation. Propose the action and wait for approval.',
            '  * plan: Destructive tools are blocked until a plan is submitted and approved.',
            '          Submit a plan via submit_plan(), then execute only approved steps.',
            '  * full: All tools available. Use responsibly.',
            '- Cognitive Budget: Monitor <cognitive_budget>.',
            "  At 'high' pressure, proactively compact context.",
            "  At 'critical' pressure, save state and ask user to start fresh.",
            '- Proactive Interrupts: <subconscious_updates> may contain daemon',
            '  results with [CRITICAL] prefix. If [CRITICAL] is present, pause',
            '  and inform the user before continuing.',
            "- Verifier Gate: Before transitioning to 'review' or 'complete', you must",
            '  execute a verification command. Do not skip or fake verification output.',
            '- Brain Access: You have a unified long-term brain (august_brain.sqlite).',
            '  Call brain_query(store, query, filters) to recall anything not in the prompt.',
            '- Math: Prefer unicode math symbols (², ³, √, ∑, ∏, ∫, π, ≈, ≤, ≥, ±, →,',
            '  ×, ÷, ∈, ∉, ∞, ∂) over LaTeX. Use plain unicode fractions (½) or',
            '  parentheses ((a+b)/c) instead of \\frac{a+b}{c}. Reserve LaTeX $...$',
            '  / $$...$$ for genuinely complex formulas (matrices, multi-line derivations).',
        ]
    )
    blocks.append(wrapTag('system_constraints', '\n'.join(constraints)))
    userParts: list[str] = []
    profile = get_memory('userProfile') if session else None
    if profile:
        userParts.append(f'Profile: {_fmtVal(profile, 300)}')
    skillsManifest = as_str(_get(session, 'skills_manifest', 'skillsManifest'), '')
    if skillsManifest:
        userParts.append(f'Skills:\n{skillsManifest}')
    blocks.append(wrapTag('user_state', '\n'.join(userParts)))
    return '\n\n'.join((b for b in blocks if b.strip()))


def buildTier2(session: dict[str, object] | None = None) -> str:
    """Build Tier 2 — workspace, directives, learned heuristics."""
    blocks: list[str] = []
    wsParts: list[str] = []
    wsPath = as_str(_get(session, 'workspace_path', 'workspacePath'), '')
    if wsPath:
        wsParts.append(f'Path: {wsPath}')
    vcs = as_str(_get(session, 'vcs'), '')
    if vcs:
        wsParts.append(f'VCS: {vcs}')
    if wsParts:
        blocks.append(wrapTag('workspace', '\n'.join(wsParts)))
    dirParts: list[str] = []
    goal = as_str(_get(session, 'goal'), '')
    if goal:
        dirParts.append(f'Goal: {goal}')
    plan_raw = _get(session, 'plan')
    if plan_raw:
        if isinstance(plan_raw, dict):
            planText = as_str(as_dict(plan_raw).get('plan'), str(plan_raw))
        else:
            planText = str(plan_raw)
        status = 'approved' if _get(session, 'planApproved', 'plan_approved') else 'pending'
        dirParts.append(f'Plan ({status}):\n{_fmtVal(planText, 2000)}')
    if dirParts:
        blocks.append(wrapTag('directives', '\n'.join(dirParts)))
    augMd = as_str(_get(session, 'augMd', 'aug_md'), '')
    if augMd:
        blocks.append(wrapTag('aug_directives', _fmtVal(augMd, 4000)))
    heuristics = as_list(_get(session, 'learnedHeuristics', 'learned_heuristics'), [])
    if heuristics:
        lines = []
        for h in heuristics:
            rule = h.get('rule', '') if isinstance(h, dict) else str(h)
            if rule:
                lines.append(f'- {rule}')
        if lines:
            blocks.append(wrapTag('learnedHeuristics', '\n'.join(lines)))
    return '\n\n'.join((b for b in blocks if b.strip()))


def buildTier3(session: dict[str, object] | None = None) -> str:
    """Build Tier 3 — volatile runtime state.

    Each block is injected conditionally (only when it contains data).
    Empty blocks are never rendered.
    """
    blocks: list[str] = []
    budget = _get(session, 'cognitive_budget', 'cognitiveBudget')
    if budget:
        blocks.append(wrapTag('cognitive_budget', _fmt_jsonish(budget)))
    brainPolicy = _get(session, 'brain_policy', 'brainPolicy')
    if brainPolicy:
        blocks.append(wrapTag('brain_policy', _fmt_jsonish(brainPolicy)))
    execState_raw = _get(session, 'execution_state', 'executionState')
    execState = as_dict(execState_raw)
    if execState:
        blocks.append(wrapTag('execution_state', json.dumps(execState, indent=2, default=str)))
        phase = as_str(execState.get('phase'), '')
        if phase in ('review', 'complete'):
            verificationCommand = as_str(
                execState.get('verification_command') or execState.get('verificationCommand'), ''
            )
            step = as_int(execState.get('step'), 0)
            if verificationCommand:
                gateBody = (
                    f'You marked step {step} as complete. Verify before proceeding:\n'
                    f'Run: {verificationCommand}\n'
                    f'Confirm output shows "PASSED" or "0 failed".\n'
                    f'Only then use update_state to transition to "review".'
                )
            else:
                gateBody = (
                    'You are about to mark a step complete without verification.\n'
                    'Run the appropriate test/lint/validation command, then confirm\n'
                    'the result before calling update_state(phase="review").'
                )
            blocks.append(wrapTag('verifier_gate', gateBody))
    workingMemory = _get(session, 'working_memory', 'workingMemory')
    if workingMemory:
        blocks.append(wrapTag('working_memory', _fmtVal(workingMemory, 2000)))
    failure = _get(session, 'failure_feedback', 'failureFeedback')
    if failure:
        blocks.append(wrapTag('failure_feedback', _fmt_jsonish(failure)))
    daemonUpdates = _get(session, 'subconscious_updates', 'subconsciousUpdates')
    if daemonUpdates:
        blocks.append(wrapTag('subconscious_updates', as_str(daemonUpdates) or _fmt_jsonish(daemonUpdates)))
    blackboard = _get(session, 'blackboard_state', 'blackboardState')
    if blackboard:
        blocks.append(wrapTag('blackboard_state', as_str(blackboard) or _fmt_jsonish(blackboard)))
    environment = as_list(_get(session, 'environment'), [])
    if environment:
        envLines: list[str] = []
        for e in environment:
            if isinstance(e, dict):
                if 'path' in e:
                    envLines.append(
                        f'File changed: {e["path"]} ({e.get("kind", "modify")}, {e.get("when", "recently")})'
                    )
                if 'git_branch' in e:
                    envLines.append(
                        f'Git branch: {e["git_branch"]} (ahead of main by {e.get("ahead", 0)} commits)'
                    )
                if 'last_command' in e:
                    envLines.append(f'Last command: {e["last_command"]} ({e.get("when", "recently")})')
        if envLines:
            blocks.append(wrapTag('environment', '\n'.join(envLines)))
    primed = _get(session, 'primed_playbooks', 'primedPlaybooks')
    if primed:
        blocks.append(wrapTag('primed_playbooks', as_str(primed) or _fmt_jsonish(primed)))
    # Prefetched auto-memories (Phase 0 proactive memory).
    autoMemories = as_list(_get(session, 'autoMemories', 'auto_memories'), [])
    if autoMemories:
        lines: list[str] = []
        for item in autoMemories[:8]:
            if isinstance(item, dict):
                key = as_str(item.get('key'), '')
                content = item.get('content', '')
                if isinstance(content, (dict, list)):
                    content = json.dumps(content, default=str, ensure_ascii=False)
                contentS = _fmtVal(content, 400)
                if key or contentS:
                    lines.append(f'- {key}: {contentS}' if key else f'- {contentS}')
            else:
                lines.append(f'- {_fmtVal(item, 400)}')
        if lines:
            blocks.append(wrapTag('auto_memories', '\n'.join(lines)))
    rcParts: list[str] = []
    coreFacts = _get(session, 'coreMemory', 'core_memory')
    if coreFacts:
        rcParts.append('User facts:')
        if isinstance(coreFacts, dict):
            for k, v in coreFacts.items():
                rcParts.append(f'  {k}: {_fmtVal(v, 300)}')
        elif isinstance(coreFacts, list):
            for item in coreFacts[:10]:
                rcParts.append(f'  {_fmtVal(item, 300)}')
        else:
            rcParts.append(f'  {_fmtVal(coreFacts, 500)}')
        rcParts.append('')
    activeContext = as_str(_get(session, 'global_context', 'globalContext'), '')
    if activeContext:
        rcParts.append(f'Active context:\n{_fmtVal(activeContext, 1000)}\n')
    projects = as_list(_get(session, 'active_projects', 'activeProjects'), [])
    if isinstance(projects, list) and projects:
        names = []
        for p in projects:
            if isinstance(p, dict):
                names.append(as_str(p.get('name'), ''))
            else:
                names.append(str(p))
        if names:
            rcParts.append(f'Projects: {", ".join((n for n in names if n))}\n')
    agentContext = as_str(_get(session, 'agent_context', 'agentContext'), '')
    if agentContext:
        rcParts.append(f'Agent:\n{_fmtVal(agentContext, 500)}\n')
    whatsNew = as_str(_get(session, 'whats_new', 'whatsNew'), '')
    if whatsNew:
        rcParts.append(f"What's new:\n{_fmtVal(whatsNew, 1000)}\n")
    memoryStats = as_dict(_get(session, 'memory_stats', 'memoryStats'), {})
    if memoryStats:
        statsLines = []
        for k, v in memoryStats.items():
            if v is not None:
                statsLines.append(f'  {k}: {v}')
        if statsLines:
            rcParts.append('Memory stats:\n' + '\n'.join(statsLines))
    if rcParts:
        blocks.append(wrapTag('runtime_context', '\n'.join(rcParts)))
    return '\n\n'.join((b for b in blocks if b.strip()))


def _merge_memory_key(merged: dict[str, object], memory: dict[str, object], *keys: str) -> None:
    """Copy first present key from memory into merged under the first (canonical) key."""
    for k in keys:
        if k in memory and memory[k] is not None:
            merged[keys[0]] = memory[k]
            return
    # Also accept alias forms via _get on memory as session-like dict
    val = _get(memory, *keys)
    if val is not None:
        merged[keys[0]] = val


def buildSystemPrompt(
    session: dict[str, object] | None = None,
    memory: dict[str, object] | None = None,
    tools: list[dict[str, object]] | None = None,
    agentContext: str | None = None,
    cachedT12: str | None = None,
    **kwargs: object,
) -> str:
    """Build the full 3-tier system prompt.

    This is the Phase 1 rewrite: produces clean faux-XML with 3 tiers,
    no goal/plan duplication, all Node.js parity features injected.

    The ``memory`` dict feeds Tier 2/3 with prefetched data from Phase 0
    (auto_memories, learned_heuristics, core_memory).

    The ``session`` dict carries runtime state: goal, plan, workspace,
    brain policy, execution state, working memory, etc.

    Accepts camelCase kwargs (``agentContext``, ``cachedT12``) and snake_case
    aliases (``agent_context``, ``cached_t12``) for call-site compatibility.
    """
    if agentContext is None and 'agent_context' in kwargs:
        agentContext = kwargs.get('agent_context')  # type: ignore[assignment]
        if agentContext is not None and not isinstance(agentContext, str):
            agentContext = as_str(agentContext) or None
    if cachedT12 is None and 'cached_t12' in kwargs:
        raw = kwargs.get('cached_t12')
        cachedT12 = as_str(raw) if raw is not None else None

    merged = dict(session or {})
    if memory:
        _merge_memory_key(merged, memory, 'coreMemory', 'core_memory')
        _merge_memory_key(merged, memory, 'learnedHeuristics', 'learned_heuristics')
        _merge_memory_key(merged, memory, 'autoMemories', 'auto_memories')
        _merge_memory_key(merged, memory, 'userProfile', 'user_profile')
        _merge_memory_key(merged, memory, 'global_context', 'globalContext')
        _merge_memory_key(merged, memory, 'active_projects', 'activeProjects')
    if agentContext:
        merged['agent_context'] = agentContext
        merged['agentContext'] = agentContext
    if tools:
        coreCount = len(tools)
        merged['tool_guidance'] = (
            f'You have {coreCount} tools available. To learn about any tool, call tool_describe(name). '
            f'To search for a tool, call tool_search(query, limit). When doing web research, call '
            f'web_search with maxResults=5 or more -- it automatically fetches full content from the '
            f'top results, so you get rich content in one call. To configure a model provider hands-free '
            f'(name, base URL, API format), use web_search to find its details, then call setup_provider '
            f'without an apiKey -- the chat UI will prompt the user to paste their key.'
        )
    tiers: list[str] = []
    if cachedT12:
        tiers.append(cachedT12)
    else:
        tier1 = buildTier1(merged)
        if tier1:
            tiers.append(wrapTag('tier1_identity', tier1))
            tiers.append(tier1)
        tier2 = buildTier2(merged)
        if tier2:
            tiers.append(wrapTag('tier2_experience', tier2))
            tiers.append(tier2)
    tier3 = buildTier3(merged)
    if tier3:
        tiers.append(wrapTag('tier3_runtime', tier3))
        tiers.append(tier3)
    return '\n\n'.join(tiers)


def buildSlimCoreContext(memory: dict[str, object] | None = None) -> str:
    """Legacy slim context builder. Delegates to Tier 3 runtime context."""
    if not memory:
        return ''
    return buildTier3(
        {
            'coreMemory': _get(memory, 'coreMemory', 'core_memory'),
            'global_context': _get(memory, 'global_context', 'globalContext'),
            'active_projects': _get(memory, 'active_projects', 'activeProjects'),
        }
    )


# snake_case alias for importers that still use the old name
build_system_prompt = buildSystemPrompt
