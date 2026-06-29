"""
Context builder — assembles the 3-tier XML system prompt (Phase 1).

Tier 1: Identity & Constraints (static, cacheable)
Tier 2: Environment & Experience (semi-stable, high cache)
Tier 3: Dynamic Runtime (volatile, rebuilt every turn)

Port of backend/services/memory/context-builder.js (224 lines).
"""

from __future__ import annotations

from typing import Any

from app.services.memory_store import get_memory


# ── Constants ───────────────────────────────────────────────────────────

AUGUST_PLATFORM: str = (
    "Platform: August Proxy.\n"
    "- Cross-session memory tools are available: memory_search() to find past conversations, "
    "fact_search() for structured facts, context_read() for user profile.\n"
    "- Save recurring user corrections/lessons as skills via `skill_manage`; load them via `load_skill`.\n"
    '- Note: "August" or "August Proxy" is the name of this proxy platform. '
    "You are still yourself — respond as your actual underlying model identity.\n"
    "- Address the user neutrally without honorifics."
)

DEFAULT_CONTEXT_MAX_CHARS: int = 24000


# ── Helpers ─────────────────────────────────────────────────────────────


def wrap_tag(tag: str, content: str, attrs: str = "") -> str:
    """Wrap content in a faux XML tag."""
    suffix = f" {attrs}" if attrs else ""
    return f"<{tag}{suffix}>\n{content or ''}\n</{tag}>"


def _fmt_val(val: Any, max_chars: int = 500) -> str:
    """Format a value as a string, truncated to max_chars."""
    if val is None:
        return ""
    s = str(val)
    if len(s) > max_chars:
        s = s[:max_chars] + "..."
    return s


# ── Tier 1: Identity & Constraints ─────────────────────────────────────


def build_tier1(session: dict[str, Any] | None = None) -> str:
    """Build Tier 1 — static identity and constraints."""
    blocks: list[str] = []

    # System constraints
    constraints = [AUGUST_PLATFORM]

    # Guard mode rules (Phase 1 — ported from workbench.js:2326-2339)
    # The model sees these upfront instead of hitting the guard wall at runtime.
    constraints.extend([
        "=== GUARD MODE RULES ===",
        "- This session enforces a guard mode. You operate in one of three modes:",
        "  * ask: All mutating actions (write, edit, delete, run_command with mutations)",
        "         require user confirmation. Propose the action and wait for approval.",
        "  * plan: Destructive tools are blocked until a plan is submitted and approved.",
        "          Submit a plan via submit_plan(), then execute only approved steps.",
        "  * full: All tools available. Use responsibly.",
        "- Cognitive Budget: Monitor <cognitive_budget>.",
        "  At 'high' pressure, proactively compact context.",
        "  At 'critical' pressure, save state and ask user to start fresh.",
        "- Proactive Interrupts: <subconscious_updates> may contain daemon",
        "  results with [CRITICAL] prefix. If [CRITICAL] is present, pause",
        "  and inform the user before continuing.",
        "- Verifier Gate: Before transitioning to 'review' or 'complete', you must",
        "  execute a verification command. Do not skip or fake verification output.",
        "- Brain Access: You have a unified long-term brain (august_brain.sqlite).",
        "  Call brain_query(store, query, filters) to recall anything not in the prompt.",
        "- Math: Prefer unicode math symbols (², ³, √, ∑, ∏, ∫, π, ≈, ≤, ≥, ±, →,",
        "  ×, ÷, ∈, ∉, ∞, ∂) over LaTeX. Use plain unicode fractions (½) or",
        "  parentheses ((a+b)/c) instead of \\frac{a+b}{c}. Reserve LaTeX $...$",
        "  / $$...$$ for genuinely complex formulas (matrices, multi-line derivations).",
    ])
    blocks.append(wrap_tag("system_constraints", "\n".join(constraints)))

    # User state (profile + skill manifest)
    user_parts: list[str] = []
    profile = get_memory("user_profile") if session else None
    if profile:
        user_parts.append(f"Profile: {_fmt_val(profile, 300)}")

    # Skill manifest from session
    skills_manifest = (session or {}).get("skills_manifest", "")
    if skills_manifest:
        user_parts.append(f"Skills:\n{skills_manifest}")

    blocks.append(wrap_tag("user_state", "\n".join(user_parts)))

    return "\n\n".join(b for b in blocks if b.strip())


# ── Tier 2: Environment & Experience (semi-stable) ─────────────────────


def build_tier2(session: dict[str, Any] | None = None) -> str:
    """Build Tier 2 — workspace, directives, learned heuristics."""
    blocks: list[str] = []

    # Workspace
    ws_parts: list[str] = []
    ws_path = (session or {}).get("workspace_path", "")
    if ws_path:
        ws_parts.append(f"Path: {ws_path}")

    vcs = (session or {}).get("vcs", "")
    if vcs:
        ws_parts.append(f"VCS: {vcs}")

    if ws_parts:
        blocks.append(wrap_tag("workspace", "\n".join(ws_parts)))

    # Directives (single source of truth — eliminates goal/plan duplication)
    dir_parts: list[str] = []
    goal = (session or {}).get("goal", "")
    if goal:
        dir_parts.append(f"Goal: {goal}")

    plan = (session or {}).get("plan")
    if plan:
        plan_text = plan.get("plan", str(plan)) if isinstance(plan, dict) else str(plan)
        status = "approved" if (session or {}).get("planApproved") else "pending"
        dir_parts.append(f"Plan ({status}):\n{_fmt_val(plan_text, 2000)}")

    if dir_parts:
        blocks.append(wrap_tag("directives", "\n".join(dir_parts)))

    # Learned heuristics (from Phase 0 prefetch)
    heuristics = (session or {}).get("learned_heuristics", [])
    if heuristics:
        lines = []
        for h in heuristics:
            rule = h.get("rule", "") if isinstance(h, dict) else str(h)
            if rule:
                lines.append(f"- {rule}")
        if lines:
            blocks.append(wrap_tag("learned_heuristics", "\n".join(lines)))

    return "\n\n".join(b for b in blocks if b.strip())


# ── Tier 3: Dynamic Runtime (volatile, rebuilt every turn) ─────────────


def build_tier3(session: dict[str, Any] | None = None) -> str:
    """Build Tier 3 — volatile runtime state.

    Each block is injected conditionally (only when it contains data).
    Empty blocks are never rendered.
    """
    blocks: list[str] = []

    # Cognitive budget (populated by Phase 2 — empty for now)
    budget = (session or {}).get("cognitive_budget")
    if budget:
        import json
        blocks.append(wrap_tag("cognitive_budget", json.dumps(budget, indent=2)))

    # Brain policy (from brain_orchestrator wiring)
    brain_policy = (session or {}).get("brain_policy")
    if brain_policy:
        import json
        blocks.append(wrap_tag("brain_policy", json.dumps(brain_policy, indent=2)))

    # Execution state (populated by Phase 5 — empty for now)
    exec_state = (session or {}).get("execution_state")
    if exec_state:
        import json
        blocks.append(wrap_tag("execution_state", json.dumps(exec_state, indent=2)))

    # Working memory (populated by Phase 6 — empty for now)
    working_memory = (session or {}).get("working_memory")
    if working_memory:
        blocks.append(wrap_tag("working_memory", _fmt_val(working_memory, 2000)))

    # Failure feedback (populated by Phase 6 — empty for now)
    failure = (session or {}).get("failure_feedback")
    if failure:
        blocks.append(wrap_tag("failure_feedback", failure))

    # Subconscious updates (populated by Phase 8 — empty for now)
    daemon_updates = (session or {}).get("subconscious_updates")
    if daemon_updates:
        blocks.append(wrap_tag("subconscious_updates", daemon_updates))

    # Blackboard state (populated by Phase 10)
    blackboard = (session or {}).get("blackboard_state")
    if blackboard:
        blocks.append(wrap_tag("blackboard_state", blackboard))

    # v2: Environment changes (file/git/terminal) from environment_watcher
    environment = (session or {}).get("environment", [])
    if environment:
        env_lines: list[str] = []
        for e in environment:
            if isinstance(e, dict):
                if "path" in e:
                    env_lines.append(
                        f"File changed: {e['path']} "
                        f"({e.get('kind', 'modify')}, {e.get('when', 'recently')})"
                    )
                if "git_branch" in e:
                    env_lines.append(
                        f"Git branch: {e['git_branch']} "
                        f"(ahead of main by {e.get('ahead', 0)} commits)"
                    )
                if "last_command" in e:
                    env_lines.append(
                        f"Last command: {e['last_command']} "
                        f"({e.get('when', 'recently')})"
                    )
        if env_lines:
            blocks.append(wrap_tag("environment", "\n".join(env_lines)))

    # Primed playbooks (populated by Phase 3 BM25 — empty for now)
    primed = (session or {}).get("primed_playbooks")
    if primed:
        blocks.append(wrap_tag("primed_playbooks", primed))

    # Runtime context
    rc_parts: list[str] = []

    # User facts (fixes dead core_memory write — Phase 0 prefetch populates this)
    core_facts = (session or {}).get("core_memory")
    if core_facts:
        rc_parts.append("User facts:")
        if isinstance(core_facts, dict):
            for k, v in core_facts.items():
                rc_parts.append(f"  {k}: {_fmt_val(v, 300)}")
        elif isinstance(core_facts, list):
            for item in core_facts[:10]:
                rc_parts.append(f"  {_fmt_val(item, 300)}")
        else:
            rc_parts.append(f"  {_fmt_val(core_facts, 500)}")
        rc_parts.append("")

    # Active context / global context
    active_context = (session or {}).get("global_context", "")
    if active_context:
        rc_parts.append(f"Active context:\n{_fmt_val(active_context, 1000)}\n")

    # Projects
    projects = (session or {}).get("active_projects", [])
    if isinstance(projects, list) and projects:
        names = []
        for p in projects:
            if isinstance(p, dict):
                names.append(p.get("name", ""))
            else:
                names.append(str(p))
        if names:
            rc_parts.append(f"Projects: {', '.join(n for n in names if n)}\n")

    # Agent context
    agent_context = (session or {}).get("agent_context", "")
    if agent_context:
        rc_parts.append(f"Agent:\n{_fmt_val(agent_context, 500)}\n")

    # What's new (git + feature awareness)
    whats_new = (session or {}).get("whats_new", "")
    if whats_new:
        rc_parts.append(f"What's new:\n{_fmt_val(whats_new, 1000)}\n")

    # Memory/graph stats
    memory_stats = (session or {}).get("memory_stats", {})
    if memory_stats:
        stats_lines = []
        for k, v in memory_stats.items():
            if v is not None:
                stats_lines.append(f"  {k}: {v}")
        if stats_lines:
            rc_parts.append("Memory stats:\n" + "\n".join(stats_lines))

    if rc_parts:
        blocks.append(wrap_tag("runtime_context", "\n".join(rc_parts)))

    return "\n\n".join(b for b in blocks if b.strip())


# ── Composite builder ──────────────────────────────────────────────────


def build_system_prompt(
    session: dict[str, Any] | None = None,
    memory: dict[str, Any] | None = None,
    tools: list[dict[str, Any]] | None = None,
    agent_context: str | None = None,
    cached_t12: str | None = None,
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
    # Merge memory into session for the tier builders
    merged = dict(session or {})
    if memory:
        # Phase 0 prefetched data feeds the tiers
        if "core_memory" in memory:
            merged["core_memory"] = memory["core_memory"]
        if "learned_heuristics" in memory:
            merged["learned_heuristics"] = memory["learned_heuristics"]
        if "auto_memories" in memory:
            merged["auto_memories"] = memory["auto_memories"]
        if "user_profile" in memory:
            merged["user_profile"] = memory["user_profile"]
        if "global_context" in memory:
            merged["global_context"] = memory["global_context"]
        if "active_projects" in memory:
            merged["active_projects"] = memory["active_projects"]

    if agent_context:
        merged["agent_context"] = agent_context

    # Tool guidance (replaces the old build_client_tool_guidance)
    # We inject a compact routing hint so the model knows what's available.
    if tools:
        core_count = len(tools)
        merged["tool_guidance"] = (
            f"You have {core_count} tools available. "
            "To learn about any tool, call tool_describe(name). "
            "To search for a tool, call tool_search(query, limit)."
        )

    tiers: list[str] = []

    if cached_t12:
        # Use cached T1+T2 (Phase 7 optimization)
        tiers.append(cached_t12)
    else:
        tier1 = build_tier1(merged)
        if tier1:
            tiers.append(wrap_tag("tier1_identity", tier1))
            tiers.append(tier1)

        tier2 = build_tier2(merged)
        if tier2:
            tiers.append(wrap_tag("tier2_experience", tier2))
            tiers.append(tier2)

    # Tier 3 is ALWAYS regenerated (volatile runtime state)
    tier3 = build_tier3(merged)
    if tier3:
        tiers.append(wrap_tag("tier3_runtime", tier3))
        tiers.append(tier3)

    return "\n\n".join(tiers)


# ── Slim context (legacy — kept for backward compat, delegates to tiers) ─


def build_slim_core_context(memory: dict[str, Any] | None = None) -> str:
    """Legacy slim context builder. Delegates to Tier 3 runtime context."""
    if not memory:
        return ""
    return build_tier3({"core_memory": memory.get("core_memory"),
                        "global_context": memory.get("global_context"),
                        "active_projects": memory.get("active_projects")})
