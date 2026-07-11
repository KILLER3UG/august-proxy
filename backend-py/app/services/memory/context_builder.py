"""
Context builder — assembles the 3-tier XML system prompt (Phase 1).

Tier 1: Identity & Constraints (static, cacheable)
Tier 2: Environment & Experience (semi-stable, high cache)
Tier 3: Dynamic Runtime (volatile, rebuilt every turn)

Port of backend/services/memory/context-builder.js (224 lines).
"""

from __future__ import annotations
from app.jsonUtils import as_str, as_dict, as_list, as_int
from app.services.memory_store import getMemory

AUGUST_PLATFORM: str = 'Platform: August Proxy.\n- Cross-session memory tools are available: memory_search() to find past conversations, fact_search() for structured facts, context_read() for user profile.\n- Save recurring user corrections/lessons as skills via `skill_manage`; load them via `load_skill`.\n- Note: "August" or "August Proxy" is the name of this proxy platform. You are still yourself — respond as your actual underlying model identity.\n- Address the user neutrally without honorifics.'
DEFAULT_CONTEXT_MAX_CHARS: int = 24000


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
    profile = getMemory('userProfile') if session else None
    if profile:
        userParts.append(f'Profile: {_fmtVal(profile, 300)}')
    skillsManifest = as_str((session or {}).get('skills_manifest'), '')
    if skillsManifest:
        userParts.append(f'Skills:\n{skillsManifest}')
    blocks.append(wrapTag('user_state', '\n'.join(userParts)))
    return '\n\n'.join((b for b in blocks if b.strip()))


def buildTier2(session: dict[str, object] | None = None) -> str:
    """Build Tier 2 — workspace, directives, learned heuristics."""
    blocks: list[str] = []
    wsParts: list[str] = []
    wsPath = as_str((session or {}).get('workspace_path'), '')
    if wsPath:
        wsParts.append(f'Path: {wsPath}')
    vcs = as_str((session or {}).get('vcs'), '')
    if vcs:
        wsParts.append(f'VCS: {vcs}')
    if wsParts:
        blocks.append(wrapTag('workspace', '\n'.join(wsParts)))
    dirParts: list[str] = []
    goal = as_str((session or {}).get('goal'), '')
    if goal:
        dirParts.append(f'Goal: {goal}')
    plan_raw = (session or {}).get('plan')
    if plan_raw:
        if isinstance(plan_raw, dict):
            planText = as_str(as_dict(plan_raw).get('plan'), str(plan_raw))
        else:
            planText = str(plan_raw)
        status = 'approved' if (session or {}).get('planApproved') else 'pending'
        dirParts.append(f'Plan ({status}):\n{_fmtVal(planText, 2000)}')
    if dirParts:
        blocks.append(wrapTag('directives', '\n'.join(dirParts)))
    augMd = as_str((session or {}).get('augMd'), '')
    if augMd:
        blocks.append(wrapTag('aug_directives', _fmtVal(augMd, 4000)))
    heuristics = as_list((session or {}).get('learnedHeuristics'), [])
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
    budget = (session or {}).get('cognitive_budget')
    if budget:
        import json

        blocks.append(wrapTag('cognitive_budget', json.dumps(budget, indent=2)))
    brainPolicy = (session or {}).get('brain_policy')
    if brainPolicy:
        import json

        blocks.append(wrapTag('brain_policy', json.dumps(brainPolicy, indent=2)))
    execState_raw = (session or {}).get('execution_state')
    execState = as_dict(execState_raw)
    if execState:
        import json

        blocks.append(wrapTag('execution_state', json.dumps(execState, indent=2)))
        phase = as_str(execState.get('phase'), '')
        if phase in ('review', 'complete'):
            verificationCommand = as_str(execState.get('verification_command'), '')
            step = as_int(execState.get('step'), 0)
            if verificationCommand:
                gateBody = f'You marked step {step} as complete. Verify before proceeding:\nRun: {verificationCommand}\nConfirm output shows "PASSED" or "0 failed".\nOnly then use update_state to transition to "review".'
            else:
                gateBody = 'You are about to mark a step complete without verification.\nRun the appropriate test/lint/validation command, then confirm\nthe result before calling update_state(phase="review").'
            blocks.append(wrapTag('verifier_gate', gateBody))
    workingMemory = (session or {}).get('working_memory')
    if workingMemory:
        blocks.append(wrapTag('working_memory', _fmtVal(workingMemory, 2000)))
    failure = (session or {}).get('failure_feedback')
    if failure:
        blocks.append(wrapTag('failure_feedback', as_str(failure)))
    daemonUpdates = (session or {}).get('subconscious_updates')
    if daemonUpdates:
        blocks.append(wrapTag('subconscious_updates', as_str(daemonUpdates)))
    blackboard = (session or {}).get('blackboard_state')
    if blackboard:
        blocks.append(wrapTag('blackboard_state', as_str(blackboard)))
    environment = as_list((session or {}).get('environment'), [])
    if environment:
        envLines: list[str] = []
        for e in environment:
            if isinstance(e, dict):
                if 'path' in e:
                    envLines.append(
                        f'File changed: {e["path"]} ({e.get("kind", "modify")}, {e.get("when", "recently")})'
                    )
                if 'git_branch' in e:
                    envLines.append(f'Git branch: {e["git_branch"]} (ahead of main by {e.get("ahead", 0)} commits)')
                if 'last_command' in e:
                    envLines.append(f'Last command: {e["last_command"]} ({e.get("when", "recently")})')
        if envLines:
            blocks.append(wrapTag('environment', '\n'.join(envLines)))
    primed = (session or {}).get('primed_playbooks')
    if primed:
        blocks.append(wrapTag('primed_playbooks', as_str(primed)))
    rcParts: list[str] = []
    coreFacts = (session or {}).get('coreMemory')
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
    activeContext = as_str((session or {}).get('global_context'), '')
    if activeContext:
        rcParts.append(f'Active context:\n{_fmtVal(activeContext, 1000)}\n')
    projects = as_list((session or {}).get('active_projects'), [])
    if isinstance(projects, list) and projects:
        names = []
        for p in projects:
            if isinstance(p, dict):
                names.append(as_str(p.get('name'), ''))
            else:
                names.append(str(p))
        if names:
            rcParts.append(f'Projects: {", ".join((n for n in names if n))}\n')
    agentContext = as_str((session or {}).get('agent_context'), '')
    if agentContext:
        rcParts.append(f'Agent:\n{_fmtVal(agentContext, 500)}\n')
    whatsNew = as_str((session or {}).get('whats_new'), '')
    if whatsNew:
        rcParts.append(f"What's new:\n{_fmtVal(whatsNew, 1000)}\n")
    memoryStats = as_dict((session or {}).get('memory_stats'), {})
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


def buildSystemPrompt(
    session: dict[str, object] | None = None,
    memory: dict[str, object] | None = None,
    tools: list[dict[str, object]] | None = None,
    agentContext: str | None = None,
    cachedT12: str | None = None,
) -> str:
    """Build the full 3-tier system prompt.

    This is the Phase 1 rewrite: produces clean faux-XML with 3 tiers,
    no goal/plan duplication, all Node.js parity features injected.

    The ``memory`` dict feeds Tier 2/3 with prefetched data from Phase 0
    (auto_memories, learned_heuristics, core_memory).

    The ``session`` dict carries runtime state: goal, plan, workspace,
    brain policy, execution state, working memory, etc.

    The ``tools`` list is used for tool guidance routing (replaces the old
    ``build_client_tool_guidance()`` call).
    """
    merged = dict(session or {})
    if memory:
        if 'coreMemory' in memory:
            merged['coreMemory'] = memory['coreMemory']
        if 'learnedHeuristics' in memory:
            merged['learnedHeuristics'] = memory['learnedHeuristics']
        if 'autoMemories' in memory:
            merged['autoMemories'] = memory['autoMemories']
        if 'userProfile' in memory:
            merged['userProfile'] = memory['userProfile']
        if 'global_context' in memory:
            merged['global_context'] = memory['global_context']
        if 'active_projects' in memory:
            merged['active_projects'] = memory['active_projects']
    if agentContext:
        merged['agent_context'] = agentContext
    if tools:
        coreCount = len(tools)
        merged['tool_guidance'] = (
            f'You have {coreCount} tools available. To learn about any tool, call tool_describe(name). To search for a tool, call tool_search(query, limit). When doing web research, call web_search with maxResults=5 or more -- it automatically fetches full content from the top results, so you get rich content in one call. To configure a model provider hands-free (name, base URL, API format), use web_search to find its details, then call setup_provider without an apiKey -- the chat UI will prompt the user to paste their key.'
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
            'coreMemory': memory.get('coreMemory'),
            'global_context': memory.get('global_context'),
            'active_projects': memory.get('active_projects'),
        }
    )
