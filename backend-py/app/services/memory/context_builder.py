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

AUGUST_PLATFORM: str = (
    'Platform: August Proxy.\n'
    '- You are the underlying model. "August" / "August Proxy" is the platform name — respond as yourself.\n'
    '- Address the user neutrally without honorifics.\n'
    '- Skills = on-demand knowledge. Tools = callable actions (schemas are in the tools array).\n'
    '- To use a skill: call load_skill(name), then follow the returned instructions.\n'
    '- load_skill works for ALL catalogued skills: bundled AND evolving skills created through chat\n'
    '  (background review / approved genesis). Evolving entries are marked [evolving] in <skills>.\n'
    '- Save recurring user corrections/lessons as skills via skill_manage.\n'
    '- Cross-session / recalled memory is ON-DEMAND only — do NOT assume past-session details are\n'
    '  already in this prompt. When the user asks about a prior session, preference, or fact you may\n'
    '  have stored, call memory_search(), fact_search(), context_read(), or brain_query() to retrieve it.\n'
    '  Do not invent recalled memories; fetch them with tools when needed.\n'
    '- User-Added Memory (facts the user explicitly saved) appears in <added_memories> when present —\n'
    '  treat those as durable preferences/facts to honor without a tool call.\n'
    '- To discover or inspect a tool schema beyond the index: tool_describe(name) or tool_search(query).\n'
    '- Prefer unicode math symbols over LaTeX except for genuinely complex formulas.'
)
DEFAULT_CONTEXT_MAX_CHARS: int = 24000

# camelCase (workbench) → snake_case (design/tests) aliases for dual-get.
_KEY_ALIASES: dict[str, tuple[str, ...]] = {
    'skills_manifest': ('skillsManifest', 'skills_manifest'),
    'capabilities_block': ('capabilitiesBlock', 'capabilities_block'),
    'tool_names': ('toolNames', 'tool_names'),
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
    'addedMemories': ('addedMemories', 'added_memories'),
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


def _active_guard_mode(session: dict[str, object] | None) -> str:
    """Resolve active guard mode for this session (system barrier)."""
    raw = as_str(_get(session, 'guardMode', 'guard_mode'), 'full').strip().lower()
    if raw in ('plan', 'full', 'ask'):
        return raw
    return 'full'


def _guard_mode_barrier_lines(mode: str) -> list[str]:
    """Hard system-barrier instructions for the active agent mode only."""
    lines = [
        f'- Agent mode: {mode} — hard constraint, not a suggestion.',
        '- You must not invent another mode. Follow ONLY the rules for the active mode.',
    ]
    if mode == 'full':
        lines.extend(
            [
                '- Full access: you may execute tools (including writes, edits, deletes, shell)',
                '  immediately when needed. Do NOT call submit_plan. Do NOT pause for plan',
                '  approval. Do NOT present multi-step plans as gated workflows — just do the work.',
                '- You may briefly outline intent in prose if helpful, then act with tools.',
                '- Plan-approval UI must not be used in this mode.',
            ]
        )
    elif mode == 'plan':
        lines.extend(
            [
                '- Plan mode: investigate with non-destructive tools only.',
                '- Destructive tools (write/edit/delete/shell/install) are blocked until the user',
                '  approves a plan. When ready, call submit_plan with concrete steps, then wait.',
                '- After approval, execute only approved steps.',
            ]
        )
    else:  # ask
        lines.extend(
            [
                '- Ask before changes: mutating tools require user confirmation before execution.',
                '- Propose the mutation clearly; do not bypass the approval gate.',
                '- Prefer submit_plan only when a multi-step mutation sequence needs review.',
            ]
        )
    return lines


def buildTier1(session: dict[str, object] | None = None) -> str:
    """Build Tier 1 — static identity, constraints, and capabilities."""
    blocks: list[str] = []
    mode = _active_guard_mode(session)
    constraints = [AUGUST_PLATFORM]
    constraints.extend(_guard_mode_barrier_lines(mode))
    constraints.extend(
        [
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
        ]
    )
    blocks.append(wrapTag('system_constraints', '\n'.join(constraints)))
    userParts: list[str] = []
    profile = get_memory('userProfile') if session else None
    if not profile and session:
        profile = _get(session, 'userProfile', 'user_profile')
    if profile:
        userParts.append(f'Profile: {_fmtVal(profile, 300)}')
    if userParts:
        blocks.append(wrapTag('user_state', '\n'.join(userParts)))
    # Capabilities: prefer prebuilt block from workbench; else build from session hints.
    capabilities = as_str(_get(session, 'capabilities_block', 'capabilitiesBlock'), '')
    if not capabilities:
        try:
            from app.services.memory.capabilities_prompt import build_capabilities_block

            tool_names = as_list(_get(session, 'tool_names', 'toolNames'), [])
            names = [as_str(n, '') for n in tool_names if as_str(n, '')]
            capabilities = build_capabilities_block(names or None)
        except Exception:
            capabilities = ''
    if capabilities:
        blocks.append(capabilities)
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
    # Current chat identity (title changes after auto-title / rename).
    session_id = as_str(_get(session, 'id', 'sessionId'), '').strip()
    session_title = as_str(_get(session, 'title', 'sessionTitle'), '').strip()
    if session_id or session_title:
        session_lines = [
            'You are currently chatting in this session.',
            'Use this id when calling session tools (delete_session, rename_session, brain_query).',
            'For the current chat, rename_session may omit sessionId.',
        ]
        if session_id:
            session_lines.append(f'id: {session_id}')
        if session_title:
            session_lines.append(f'title: {session_title}')
        blocks.append(wrapTag('session', '\n'.join(session_lines)))
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
    # Optional auto-memories block — only when the caller explicitly set them
    # (e.g. tests or a future on-demand inject). Workbench turns no longer
    # FTS-prefetch every message; the model uses memory_* tools instead.
    autoMemories = as_list(_get(session, 'autoMemories', 'auto_memories'), [])
    if autoMemories:
        lines: list[str] = []
        for item in autoMemories[:8]:
            if isinstance(item, dict):
                key = as_str(item.get('key'), '')
                label = as_str(item.get('label'), '')
                description = as_str(item.get('description'), '')
                content = item.get('content', '')
                if isinstance(content, (dict, list)):
                    content = json.dumps(content, default=str, ensure_ascii=False)
                if not label or not description:
                    try:
                        from app.services.memory.auto_memory import enrich_memory_for_model

                        enriched = enrich_memory_for_model(dict(item))
                        label = as_str(enriched.get('label'), label)
                        description = as_str(enriched.get('description'), description)
                    except Exception:
                        pass
                body = description or _fmtVal(content, 400)
                title = label or (key.replace('_', ' ') if key else '')
                # One readable line: prefer the ask/summary; use title when it
                # adds info (e.g. dated "Chat summary · …") beyond the body.
                if title and body:
                    title_l = title.lower()
                    body_l = body.lower()
                    if body_l in title_l or title_l.removeprefix('chat:').strip() in body_l:
                        line = f'- {title if len(title) >= len(body) else body}'
                    elif title_l.startswith('chat summary'):
                        line = f'- {title}: {body}'
                    else:
                        line = f'- {body}'
                else:
                    line = f'- {title or body}'
                if key and key not in line:
                    line = f'{line} [id: {key}]'
                lines.append(_fmtVal(line, 480))
            else:
                lines.append(f'- {_fmtVal(item, 400)}')
        if lines:
            blocks.append(wrapTag('auto_memories', '\n'.join(lines)))
    # User-Added Memory — always injected when present (opposite of recalled).
    addedMemories = as_list(_get(session, 'addedMemories', 'added_memories'), [])
    if addedMemories:
        added_lines: list[str] = []
        for item in addedMemories[:40]:
            if isinstance(item, dict):
                title = as_str(item.get('title') or item.get('label'), '')
                summary = as_str(item.get('summary') or item.get('description'), '')
                content = item.get('content', '')
                if isinstance(content, (dict, list)):
                    content = json.dumps(content, default=str, ensure_ascii=False)
                body = summary or _fmtVal(content, 400)
                line = f'- {title}: {body}' if title and body and title not in body else f'- {title or body}'
                added_lines.append(_fmtVal(line, 480))
            else:
                added_lines.append(f'- {_fmtVal(item, 400)}')
        if added_lines:
            blocks.append(wrapTag('added_memories', '\n'.join(added_lines)))
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
        _merge_memory_key(merged, memory, 'addedMemories', 'added_memories')
        _merge_memory_key(merged, memory, 'userProfile', 'user_profile')
        _merge_memory_key(merged, memory, 'global_context', 'globalContext')
        _merge_memory_key(merged, memory, 'active_projects', 'activeProjects')
    if agentContext:
        merged['agent_context'] = agentContext
        merged['agentContext'] = agentContext
    if tools:
        # Prefer explicit names; fall back to extracting from tool defs.
        names: list[str] = []
        for t in tools:
            if not isinstance(t, dict):
                continue
            n = as_str(t.get('name'), '')
            if not n:
                n = as_str(as_dict(t.get('function')).get('name'), '')
            if n:
                names.append(n)
        if names and not _get(merged, 'tool_names', 'toolNames'):
            merged['tool_names'] = names
            merged['toolNames'] = names
    tiers: list[str] = []
    if cachedT12:
        tiers.append(cachedT12)
    else:
        # Emit each tier once (wrapped). Callers/cache must not depend on a
        # duplicate unwrapped copy — audited 2026-07: workbench cache, dashboard,
        # and tests only assert content tags, never "wrap + raw".
        tier1 = buildTier1(merged)
        if tier1:
            tiers.append(wrapTag('tier1_identity', tier1))
        tier2 = buildTier2(merged)
        if tier2:
            tiers.append(wrapTag('tier2_experience', tier2))
    tier3 = buildTier3(merged)
    if tier3:
        tiers.append(wrapTag('tier3_runtime', tier3))
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
