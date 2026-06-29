"""
Model tools — assembles the tool definitions that the model sees (Phase 3).

The ``assemble_tool_defs()`` function is the orchestrator:
1. Classify tools into core + deferrable
2. BM25-score deferrable tools against conversation context → top-K pre-loaded
3. Check threshold: if deferrable tokens < 10% of context → pass-through
4. Assemble: core + preloaded + bridge tools
5. Budget check: drop auto-loaded skills first, then reduce K

This is a pure function — trivially testable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.services.tools.retrieval import build_tool_catalog, search_tools, build_query_from_messages


# ── Core tools (never deferred) ─────────────────────────────────────────


AUGUST_CORE_TOOLS: frozenset[str] = frozenset({
    # Phase 1 base
    "read_file", "write_file", "list_directory", "search_files",
    "run_command",
    "web_fetch", "web_search",
    "memory_search", "fact_search", "context_read", "brain_query",
    "load_skill", "list_skills", "skill_manage",
    "spawn_subagent",
    "diagnose_proxy", "describe_environment",
    # Bridge tools (always available)
    "tool_search", "tool_describe", "tool_call",
    # Phase 4: Learned heuristics
    "update_heuristics",
    # Phase 5: Execution state
    "update_state",
    # Phase 6: Working memory
    "write_scratchpad",
    # Phase 8: Daemons
    "spawn_daemon", "list_daemons", "kill_daemon",
    # Phase 9+ will add: search_timeline
    # Phase 8+ will add: spawn_daemon, list_daemons, kill_daemon
    # Phase 9+ will add: search_timeline
    # Phase 10+ will add: write_blackboard, read_blackboard, clear_blackboard
})


# ── Assembly result ─────────────────────────────────────────────────────


@dataclass
class AssemblyResult:
    tool_defs: list[dict] = field(default_factory=list)
    activated: bool = False
    preloaded_tools: list[str] = field(default_factory=list)
    preloaded_tool_count: int = 0
    auto_loaded_skills: list[str] = field(default_factory=list)
    auto_loaded_skill_count: int = 0
    deferred_count: int = 0
    deferred_tokens: int = 0
    threshold_tokens: int = 0


_BRIDGE_TOOL_DEFS: list[dict[str, Any]] = [
    {
        "name": "tool_search",
        "description": "Search across ALL available tools using BM25. "
                       "Use this when you need a tool you don't see listed.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query describing what you need."},
                "limit": {"type": "integer", "description": "Max results (1-10).", "default": 5},
            },
            "required": ["query"],
        },
    },
    {
        "name": "tool_describe",
        "description": "Get the full JSON schema for any tool.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "The tool name to describe."},
            },
            "required": ["name"],
        },
    },
    {
        "name": "tool_call",
        "description": "Call a tool by name with JSON arguments. "
                       "Use this to invoke a tool that isn't directly visible.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "The tool name to call."},
                "arguments": {"type": "string", "description": "JSON arguments matching the tool's schema."},
            },
            "required": ["name", "arguments"],
        },
    },
]


# ── Token estimator ─────────────────────────────────────────────────────


def _estimate_tool_tokens(tool_def: dict) -> int:
    """Rough estimate of how many tokens a tool schema consumes."""
    schema_str = str(tool_def.get("input_schema", tool_def.get("parameters", {})))
    desc = tool_def.get("description", "")
    return (len(desc) + len(schema_str)) // 4 + 20


# ── Assembler ───────────────────────────────────────────────────────────


def assemble_tool_defs(
    all_tool_defs: list[dict],
    context_messages: list[dict] | None = None,
    core_tool_names: set[str] | None = None,
    context_length: int = 200000,
    *,
    threshold_pct: float = 10.0,
    preload_k: int = 10,
    skill_index: list[dict] | None = None,
    auto_prime_j: int = 2,
) -> AssemblyResult:
    """Assemble the tool definitions the model will see.

    Returns an ``AssemblyResult`` with the assembled tool list and metadata.
    """
    if core_tool_names is None:
        core_tool_names = set(AUGUST_CORE_TOOLS)

    result = AssemblyResult()
    result.threshold_tokens = int(context_length * threshold_pct / 100)

    # ── 1. Classify into core + deferrable ──
    core_defs: list[dict] = []
    deferrable_defs: list[dict] = []
    deferrable_tokens = 0

    for td in all_tool_defs:
        name = td.get("name", "") if isinstance(td, dict) else ""
        if name in core_tool_names:
            core_defs.append(td)
        else:
            deferrable_defs.append(td)
            deferrable_tokens += _estimate_tool_tokens(td)

    result.deferred_tokens = deferrable_tokens

    # ── 2. Threshold check ──
    if deferrable_tokens < result.threshold_tokens or not deferrable_defs:
        # Pass-through: show all tools
        result.tool_defs = core_defs + deferrable_defs
        result.activated = False
        return result

    result.activated = True
    result.deferred_count = len(deferrable_defs)

    # ── 3. BM25 pre-load tools ──
    query = ""
    if context_messages:
        query = build_query_from_messages(context_messages)

    if query:
        catalog = build_tool_catalog(deferrable_defs)
        preloaded_names = search_tools(catalog, query, k=preload_k)
    else:
        # Cold start: first K deferrable tools
        preloaded_names = [
            td.get("name", "") if isinstance(td, dict) else ""
            for td in deferrable_defs[:preload_k]
        ]

    result.preloaded_tools = preloaded_names
    result.preloaded_tool_count = len(preloaded_names)

    # ── 4. BM25 auto-prime skills ──
    auto_skills: list[str] = []
    if skill_index and query:
        from app.services.tools.retrieval import build_skill_catalog, search_skills
        sk_catalog = build_skill_catalog(skill_index)
        auto_skills = search_skills(sk_catalog, query, j=auto_prime_j)
    elif skill_index:
        # Cold start: first J skills
        auto_skills = [
            s.get("name", "") if isinstance(s, dict) else str(s)
            for s in skill_index[:auto_prime_j]
        ]

    result.auto_loaded_skills = auto_skills
    result.auto_loaded_skill_count = len(auto_skills)

    # ── 5. Build preloaded defs ──
    preloaded_defs: list[dict] = []
    for td in deferrable_defs:
        name = td.get("name", "") if isinstance(td, dict) else ""
        if name in preloaded_names:
            preloaded_defs.append(td)

    # ── 6. Budget check ──
    total_tokens = sum(_estimate_tool_tokens(t) for t in core_defs)
    total_tokens += sum(_estimate_tool_tokens(t) for t in preloaded_defs)
    total_tokens += sum(_estimate_tool_tokens(t) for t in _BRIDGE_TOOL_DEFS)

    # If over threshold, drop auto-loaded skills first (manifest + load_skill still available)
    if total_tokens >= result.threshold_tokens:
        result.auto_loaded_skills = []
        result.auto_loaded_skill_count = 0

    # If still over, reduce K (drop lowest-scored pre-loaded tools)
    while total_tokens >= result.threshold_tokens and len(preloaded_defs) > 3:
        removed = preloaded_defs.pop()
        total_tokens -= _estimate_tool_tokens(removed)
        result.preloaded_tool_count = len(preloaded_defs)

    # ── 7. Assemble ──
    result.tool_defs = core_defs + preloaded_defs + _BRIDGE_TOOL_DEFS
    return result
