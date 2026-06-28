# Cognitive Architecture v1 — August Proxy

> A self-correcting, stateful, cognitive loop for the agentic workbench.
>
> **Status:** Design spec — not yet implemented.
> **Target:** Python backend (`backend-py/`).

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [System Prompt Structure](#2-system-prompt-structure)
3. [Progressive Tool Disclosure (BM25)](#3-progressive-tool-disclosure-bm25)
4. [Auto-Priming Skill Reflex](#4-auto-priming-skill-reflex)
5. [Metacognitive Layers](#5-metacognitive-layers)
   - 5.1 Self-Evolving Heuristics Engine
   - 5.2 Execution State Machine
   - 5.3 Ephemeral Working Memory
6. [Implementation Phases](#6-implementation-phases)
7. [File Map](#7-file-map)
8. [Appendix: Current State Analysis](#8-appendix-current-state-analysis)

---

## 1. Architecture Overview

### The Three Cognitive Layers

```
                    ┌──────────────────────────────────────────┐
                    │           MODEL'S VIEW                    │
                    │                                          │
 LAYER 1            │  System Prompt (tiers 1-3)               │
 Base Reflexes      │    ├── Identity & Constraints (cached)   │
 (always on)        │    ├── Environment & Heuristics (cached) │
                    │    └── Dynamic Runtime (per turn)        │
                    │                                          │
 LAYER 2            │  Tool Definitions (body["tools"])        │
 Latent Actions     │    ├── 14 core tools (always)            │
 (pre-loaded)       │    ├── K pre-loaded tools (BM25)         │
                    │    └── 3 bridge tools (safety net)       │
                    └──────────────────────────────────────────┘
                                       │
 LAYER 3                               │
 Anticipatory        ┌─────────────────▼──────────────────────┐
 Knowledge           │          PROXY (model_tools.py)        │
 (proxy-side)        │                                        │
                     │  BM25 against conversation context:    │
                     │    ├── Scores tools  → top-K pre-load  │
                     │    ├── Scores skills → top-J auto-inject│
                     │    └── Budget check: skills first,     │
                     │        then tools, then bridges        │
                     └────────────────────────────────────────┘
```

### Design Principles

1. **Separation of Knowledge and Action** — Skills are knowledge (system prompt content). Tools are actions (callable functions). Never mix them.
2. **Threshold-gated complexity** — Simple setups get pass-through (all tools visible). Complex setups get progressive disclosure. Zero overhead when not needed.
3. **Metacognition over raw context** — Instead of dumping everything into the prompt, give the model structured ways to track its own state (heuristics, execution phase, scratchpad).
4. **Zero external dependencies** — BM25 is pure Python math. No vector DB, no embedding model, no rank_bm25 package.
5. **Cache-friendly tiers** — Stable content (tier 1) cached per-session for upstream API prefix caching.

---

## 2. System Prompt Structure

### Three Tiers

```
┌── TIER 1: IDENTITY & CONSTRAINTS (Static, 100% cacheable) ────┐
│                                                                 │
│  <system_constraints>                                           │
│    Platform: August Proxy                                       │
│    Identity: {core identity text}                              │
│    Rules: no honorifics, guard mode, memory always available    │
│  </system_constraints>                                          │
│                                                                 │
│  <user_state>                                                   │
│    Profile: {user_profile_snippet}                             │
│    Skills: {skill_manifest — ALL skill names + descriptions}   │
│  </user_state>                                                  │
│                                                                 │
├── TIER 2: ENVIRONMENT & EXPERIENCE (Semi-stable, high cache) ──┤
│                                                                 │
│  <workspace>                                                    │
│    Path: {session.workspace_path}                              │
│    VCS: {git branch, status}                                   │
│  </workspace>                                                   │
│                                                                 │
│  <directives>                                                   │
│    Goal: {session.goal}                                        │
│    Plan: {session.plan} ({approved|pending})                   │
│  </directives>                                                  │
│                                                                 │
│  <learned_heuristics>  ← SELF-EVOLVING                         │
│    - {rule_1}                                                  │
│    - {rule_2}                                                  │
│  </learned_heuristics>                                          │
│                                                                 │
├── TIER 3: DYNAMIC RUNTIME (Volatile, rebuilt every turn) ──────┤
│                                                                 │
│  <cognitive_budget>  ← SELF-AWARE CONTEXT                       │
│    {"context_used_pct": 45, "remaining_tokens": 110000,        │
│     "attention_pressure": "low|medium|high|critical"}          │
│  </cognitive_budget>                                            │
│                                                                 │
│  <subconscious_updates>  ← BACKGROUND DAEMON RESULTS            │
│    <daemon name="ci_watcher" status="triggered"                │
│             result="3 failures in auth.py">                    │
│    <daemon name="log_monitor" status="running" last_check=     │
│             "2s ago">                                          │
│  </subconscious_updates>                                        │
│                                                                 │
│  <execution_state>  ← PHASE AWARENESS                           │
│    {"phase": "research|plan|implement|review",                 │
│     "step": 2,                                                 │
│     "completed": ["read auth.py", "identify JWT bug"],         │
│     "blockers": []}                                            │
│  </execution_state>                                             │
│                                                                 │
│  <working_memory>  ← EPHEMERAL SCRATCHPAD                       │
│    {latest_thought_process, code_diff, or analysis}            │
│  </working_memory>                                              │
│                                                                 │
│  <runtime_context>                                              │
│    User facts: {core_memory_facts}  ← FIXED: was dead write    │
│    Active context: {global_context_lines}                      │
│    Projects: {project_names}                                   │
│    Agent: {bound_agent_context}                                │
│    What's new: {recent_git_changes, feature_updates}           │
│  </runtime_context>                                             │
│                                                                 │
│  <primed_playbooks>  ← BM25 AUTO-INJECTED SKILLS               │
│    {full SKILL.md content for top-J skills}                    │
│  </primed_playbooks>                                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Current Problems This Fixes

| Problem | Current behavior | Fix |
|---------|-----------------|-----|
| Goal/plan duplication | context_builder appends them, then workbench appends them again | Single `<directives>` block in tier 2 |
| Mixed markup | XML tags for memory/agent, Markdown headers for goal/plan | Consistent faux XML throughout |
| No structure | Flat string concatenation | 3-tier hierarchy with clear responsibility |
| No caching | Rebuilt every turn (Python); has caching (Node.js) | Tier 1 cacheable, tier 2 semi-cacheable |
| Skill cap | 15 active skills max in prompt | `<user_state>` manifest shows ALL skills; BM25 auto-primes |
| No heuristics | Model forgets lessons between sessions | `<learned_heuristics>` persists rules |
| No phase awareness | Model re-reads chat history to know where it is | `<execution_state>` tracks phase + step |
| No scratchpad | Analysis/logs clutter chat history | `<working_memory>` isolated, pruned each turn |
| Workspace missing | session.workspace_path exists but never injected | `<workspace>` in tier 2 |
| Memory summary missing | Node.js has it, Python doesn't | `<runtime_context>` with memory stats |
| Memory facts invisible | `background_review` saves facts to `core_memory` key but nobody reads it back | `<runtime_context>` reads `core_memory` and injects as `User facts:` |
| Reflection model is misnamed | `reflectionModel` field only powers regex, not an LLM | Rename to "Rule-based reflection" when adding subconscious model in Phase 7 |
| Data layer fragmentation | Python writes to SQLite, Node.js writes to JSON files. Silent divergence on `core_memory`, `learned_guidelines`, `auto_memories` | Phase 0 unifies everything into `august_brain.sqlite` with FTS5 |
| Dead SQLAlchemy database | `database.py` creates engine + runs `create_all` on every startup but no models exist | Delete `database.py`, remove from lifespan |
| Auto-memories in JSON blob | All 100 entries serialized under one `"auto_memories"` key — FTS can't rank individual entries | Flatten to individual rows with FTS5 indexing |

### Caching Strategy

| Tier | Content | Cache key | TTL | Benefit |
|------|---------|-----------|-----|---------|
| 1 | system_constraints + user_state | session.agent_id | 5 min | Upstream API prefix cache hit |
| 2 | workspace + directives + heuristics | session.id | Per-session lifetime | Avoids rebuild on every turn |
| 3 | execution_state + working_memory + runtime_context + primed_playbooks | — | Rebuilt every turn | Always fresh |

---

## 3. Progressive Tool Disclosure (BM25)

### Problem

Currently all 41+ tool schemas are sent to the model on every turn (~8,000 tokens). As MCP servers are added, this grows linearly. With 50 MCP servers, it becomes untenable.

### Solution

Instead of hiding all non-core tools behind bridges (Hermes approach), **pre-load the most relevant tools** using BM25, keeping bridges as a safety net.

### Files

#### `backend-py/app/services/tools/retrieval.py` (new, ~120 lines)

Pure BM25 retrieval — stdlib only, zero dependencies.

```python
def search_tools(tool_defs: list[dict], query: str, k: int) -> list[str]:
    """BM25 tool search. Returns top-K tool names."""

def search_skills(skill_index: list[SkillEntry], query: str, j: int) -> list[str]:
    """BM25 skill search. Returns top-J skill names."""

def build_tool_catalog(tool_defs: list[dict]) -> list[CatalogEntry]:
    """Build pre-tokenized tool catalog for BM25."""

def build_skill_catalog(skills: list[dict]) -> list[CatalogEntry]:
    """Build pre-tokenized skill catalog for BM25."""
```

**Search text per tool:**
```python
tool_name (underscores→words) + description + parameter_names + keywords[]
```

**Search text per skill:**
```python
skill_name (underscores→words) + description + tags[]
```

**Query:** Sliding window of the last 6 turns (user + assistant messages), with recency decay. Messages beyond 6 turns are excluded to keep the query focused on current context. Within the window, each message is weighted by proximity (most recent message weighted highest). The raw concatenated text is used as the BM25 query — tool names and descriptions are naturally keyword-dense so BM25 performs well even with short queries like "ship it" (the preceding turns carry the relevant terms). **Tunable:** The window size and decay factor are configurable per deployment. Initial default: 6 turns with linear decay (message at position N has weight N/window_size).

#### `backend-py/app/services/tools/tool_bridges.py` (new, ~110 lines)

Three bridge tools that replace deferred tool schemas when threshold activates:

| Bridge | Purpose | Schema cost |
|--------|---------|-------------|
| `tool_search(query, limit=5)` | BM25 search across ALL deferred tools | ~120 tokens |
| `tool_describe(name)` | Returns full JSON schema for one deferred tool | ~80 tokens |
| `tool_call(name, arguments)` | Invokes a deferred tool by name | ~110 tokens |

**Reserved names** — registry rejects registration of `tool_search`, `tool_describe`, `tool_call`.

#### `backend-py/app/services/tools/model_tools.py` (new, ~120 lines)

The orchestrator. Pure function, trivially testable.

```python
@dataclass
class AssemblyResult:
    tool_defs: list[dict]            # What the model sees
    activated: bool                  # Was progressive disclosure active?
    preloaded_tools: list[str]       # BM25 pre-loaded tool names
    preloaded_tool_count: int
    auto_loaded_skills: list[str]    # BM25 auto-primed skill names
    auto_loaded_skill_count: int
    deferred_count: int              # Total deferred tools in catalog
    deferred_tokens: int             # Token cost of deferred schemas
    threshold_tokens: int            # 10% of context window

def assemble_tool_defs(
    all_tool_defs: list[dict],
    context_messages: list[dict],     # last 3-4 turns
    core_tool_names: set[str],        # 14 core tools — never deferred
    context_length: int,              # model's max context window
    *,
    threshold_pct: float = 10.0,
    preload_k: int = 10,             # top-K tools to pre-load
    skill_index: list[dict] = None,  # skill catalog for BM25
    auto_prime_j: int = 2,           # top-J skills to auto-inject
) -> AssemblyResult:
```

**Flow:**

1. **Classify**: Split tools into core + deferrable
2. **BM25 tools**: Score deferrable tools against context → top-K
3. **BM25 skills** (if skill_index provided): Score skills against context → top-J
4. **Threshold check**: If deferrable_tokens < context_length × 10% → pass-through (all tools visible, no bridge activation)
5. **Assemble**: `core + preloaded_defs + bridge_tools`
6. **Budget check**: If over threshold → drop auto-loaded skills first (model still sees manifest + `load_skill`), then reduce K
7. **Return**: AssemblyResult

**Budget hierarchy (most → least protected):**
```
1. Core tools (14)    ← NEVER dropped
2. Bridge tools (3)   ← NEVER dropped
3. Pre-loaded tools   ← Reduced if over budget
4. Auto-loaded skills ← Dropped FIRST if over budget
```

### Core Tools (Never Deferred) — 14 → 17 tools

Added incrementally across phases:

**Phase 1 base (14):**
```python
AUGUST_CORE_TOOLS = frozenset({
    "read_file", "write_file", "list_directory", "search_files",
    "run_command",
    "web_fetch", "web_search",
    "memory_search", "fact_search", "context_read",
    "load_skill", "list_skills", "skill_manage",
    "spawn_subagent",
})
```

**Phase 2 (+1):** `update_heuristics` → 15
**Phase 3 (+1):** `update_state` → 16
**Phase 4 (+1):** `write_scratchpad` → 17
**Phase 7 (+3):** `spawn_daemon`, `list_daemons`, `kill_daemon` → 20
**Phase 9 (+1):** `search_timeline` → 21
**Phase 10 (+3):** `write_blackboard`, `read_blackboard`, `clear_blackboard` → **24 final**

### Core Tool Decision Matrix

Each tool added after Phase 4 was evaluated for core vs deferrable status:

| Tool | Phase | Core? | Rationale |
|------|-------|-------|-----------|
| `spawn_daemon` | 7 | ✅ Core | Daemon management is a fundamental primitive — the model must always be able to spawn background tasks. Hiding behind a bridge would add latency to every daemon spawn. |
| `list_daemons` | 7 | ✅ Core | Reading daemon status must be instant, no search round-trip. |
| `kill_daemon` | 7 | ✅ Core | Stopping a runaway daemon must be immediate — no time for a bridge search. |
| `search_timeline` | 9 | ✅ Core | Temporal queries ("last Tuesday") require instant access. If deferred, the model would need to search for a tool to search memories — circular. |
| `write_blackboard` | 10 | ✅ Core | Blackboard is a real-time coordination primitive. The model must be able to post notes without delay. |
| `read_blackboard` | 10 | ✅ Core | Reading daemon notes mid-execution must be instant. |
| `clear_blackboard` | 10 | ✅ Core | Cleanup must not require a bridge round-trip — the model needs to clear stale notes as part of its execution flow. |

These 24 tools are NEVER deferred. They represent the agent's base reflexes — always available, always visible, full schemas on every turn.

### Threshold Behavior

| Total tools | Deferrable tokens | 10% of 200K | Action |
|-------------|-------------------|-------------|--------|
| 30 (no MCP) | ~3,200 (16 × 200) | 20,000 | **Pass-through** — all tools visible |
| 100 (moderate MCP) | ~17,200 (86 × 200) | 20,000 | **Pass-through** — all tools visible |
| 200 (heavy MCP) | ~37,200 (186 × 200) | 20,000 | **Activated** — K=84 pre-loaded, 102 deferred |
| 500 (extreme MCP) | ~97,200 (486 × 200) | 20,000 | **Activated** — K=84 pre-loaded, 402 deferred |

The threshold only activates for very large tool sets (200+). For the typical case (30-100 tools), everything passes through unchanged.

---

## 4. Auto-Priming Skill Reflex

### Problem

Skills are knowledge (SKILL.md behavior packs), not tools. Currently the model must:
1. See skill in manifest → 2. Call `load_skill(name)` → 3. Wait for result → 4. Read skill content → 5. Act

This wastes 1-2 round-trips for every skill activation.

### Solution

**Proxy-side BM25 auto-priming.** Before the model wakes up, the proxy:
1. BM25-scores all skill descriptions against the conversation context
2. Reads the full SKILL.md content for the top-J matches
3. Injects them into `<primed_playbooks>` in the system prompt
4. The model wakes up with the relevant expertise already loaded

### Files

#### `backend-py/app/services/tools/skill_manifest.py` (new, ~80 lines)

```python
def build_skill_manifest(skills: list[dict]) -> str:
    """Build ultra-lightweight text manifest.
    Format: 'skill_name: description'
    ~800 tokens for 100 skills. Always in system prompt."""

def load_skill_payloads(skill_names: list[str]) -> str:
    """Read SKILL.md files, return concatenated content.
    Cached by mtime — skills don't change often."""
```

### Fallback

If BM25 misfires (e.g., user says "do it" referring to a skill from 5 turns ago):
- The **skill manifest** in `<user_state>` lists every skill — the model sees it
- The **`load_skill`** tool is in core — always available
- The model explicitly calls `load_skill(name)` as it does today

### Cognitive Flow

| Step | What | Latency |
|------|------|---------|
| 1 | User says "audit this Dockerfile" | — |
| 2 | Proxy BM25 scores skills → finds `docker_security` | ~1ms |
| 3 | Proxy reads SKILL.md, injects into `<primed_playbooks>` | ~2ms (cached) |
| 4 | Model wakes up, sees Docker security expertise in prompt | 0 round-trips |
| 5 | Model acts as expert immediately | — |
| 6 | (Fallback) If BM25 missed → model sees manifest → calls `load_skill` | 1 round-trip |

---

## 5. Metacognitive Layers

### 5.1 Self-Evolving Heuristics Engine

**Purpose:** Let the model persist lessons learned across sessions.

**Mechanism:**
- Core tool: `update_heuristics(action: str, rule: str)`
  - `action="add"` → append rule to persistent store
  - `action="remove"` → remove rule by index
  - `action="clear"` → clear all rules
  - `action="list"` → return current rules
- Persisted in a simple JSON file: `data/learned-heuristics.json`
- Injected into `<learned_heuristics>` in tier 2 on every turn
- Rules are short strings: "Project uses Yarn, not NPM"

**Example turn:**
```
User: Run npm start
Model: [runs npm start → error]
Model: [runs npm install → error]
Model: [runs yarn → works]
Model: update_heuristics("add", "Project uses Yarn, not NPM")
```

Next session:
```
<learned_heuristics>
- Project uses Yarn, not NPM
</learned_heuristics>
```

### 5.2 Execution State Machine

**Purpose:** Give the model phase awareness so it doesn't loop.

**Mechanism:**
- Core tool: `update_state(phase: str, step: int, completed: list[str], blockers: list[str])`
- State is stored in session metadata
- Injected into `<execution_state>` in tier 3 every turn
- Dropped when session ends or new plan is submitted

**Example:**
```
<execution_state>
{"phase": "implement", "step": 3, "completed": [
  "read auth.py (found JWT on line 12)",
  "identified expiresIn: '1d' bug",
  "replaced with expiresIn: '1h'"
], "blockers": []}
</execution_state>
```

The model reads this, sees it already completed step 3, and moves to step 4 without repeating.

### 5.3 Ephemeral Working Memory

**Purpose:** Isolate the model's "train of thought" from the conversation history.

**Mechanism:**
- Core tool: `write_scratchpad(text: str)`
- Proxy keeps only the MOST RECENT scratchpad content
- Injected into `<working_memory>` in tier 3
- Old scratchpad content is DISCARDED — not accumulated
- Tool output confirms: "Scratchpad updated."

**Why not use chat history?**
- Code diffs, log analysis, and multi-step reasoning bloat context
- Model attention degrades with long histories
- The scratchpad is a "current thought" slot, not an append log

**Example:**
```
Model: write_scratchpad("Analyzing auth.py... lines 45-50 contain the JWT
  expiry bug. The token uses expiresIn: '1d' (24 hours) but the security
  policy requires expiresIn: '1h' (1 hour). I need to change line 48.")

Next turn:
<working_memory>
Analyzing auth.py... lines 45-50 contain the JWT
expiry bug. The token uses expiresIn: '1d' (24 hours) but the security
policy requires expiresIn: '1h' (1 hour). I need to change line 48.
</working_memory>

Model: write_file("auth.py", ...)  ← continues without re-reading
```

### 5.4 Subconscious Daemons (Background Agents)

**Purpose:** Continuous background monitoring without blocking the main conversation. Jarvis doesn't wait — he runs processes in his "subconscious" while chatting.

**Mechanism:**
- Core tool: `spawn_daemon(name, prompt, watch_condition)`
  - `name`: Unique identifier for the daemon
  - `prompt`: Instructions for the background agent. The daemon runs these instructions **once per polling cycle** and returns a structured result. The daemon does NOT have tool access — it is a pure text-generation loop.
  - `watch_condition`: A structured trigger specification. One of:
    - `"on_completion"` — alert when the daemon finishes its work
    - `"on_match:ERROR"` — alert when the daemon's output contains a keyword/pattern (case-insensitive substring match)
    - `"on_change"` — alert when the daemon's output differs from the previous cycle
    - `nil` (null) — no proactive alert; model reads results via `list_daemons`
- Proxy manages an asyncio task pool for daemons
- Daemon runs headless — no user interaction, no streaming. The daemon uses the **Cerebellum** model (fast, cheap) — it can follow simple instructions but does not call tools. For tool-using background tasks, use `spawn_subagent` instead (which has full tool access).
- On completion or trigger, result is stored in session metadata
- Injected into `<subconscious_updates>` in tier 3

**Daemon evaluation contract:**
1. Proxy creates an async task that calls the cerebellum model with `prompt` as the system message
2. Daemon runs, returns raw text output
3. Proxy evaluates `watch_condition` against the output:
   - `"on_completion"` → trigger fires immediately after first run
   - `"on_match:ERROR"` → trigger fires if output contains "ERROR" (case-insensitive)
   - `"on_change"` → trigger fires if output differs from previous cycle's hash
4. If triggered, result is stored and injected into `<subconscious_updates>` on next turn
5. If not triggered, daemon sleeps and re-runs on next polling interval (default 30s, configurable)

**Daemon vs Subagent distinction:**
| Aspect | Daemon (`spawn_daemon`) | Subagent (`spawn_subagent`) |
|--------|------------------------|----------------------------|
| Model | Cerebellum (fast, cheap) | Cortex (main session model) |
| Tool access | None (text generation only) | Full tool access |
| Use case | Polling logs, watching CI, monitoring | Complex research, multi-step tasks |
| Cost | Fractions of a cent per run | Full inference cost |
| Latency | Runs in background, async | Blocks until complete |

**Lifecycle:**
```
spawn_daemon("ci_watcher", 
  "Call GET https://ci.example.com/api/status. Report PASS or FAIL.", 
  "on_match:FAIL")
  → Proxy creates async task with cerebellum model
  → Daemon polls CI endpoint every 30s
  → Main conversation continues uninterrupted
  → CI returns FAIL → proxy detects "FAIL" in output → stores result
  → Next user turn: <subconscious_updates> contains daemon output
  → Model proactively reports: "CI pipeline broke. Should I investigate?"
```

**Integration (Tier 3):**
```xml
<subconscious_updates>
  <daemon name="log_monitor" status="running" last_check="2s ago">
  <daemon name="ci_watcher" status="triggered" watch_condition="on_match:FAIL"
          result="CI check returned FAIL: 3 failures in auth.py">
</subconscious_updates>
```

**Rules:**
- Daemons are read-only by default (no mutations without approval)
- Max 3 concurrent daemons per session
- Daemon results persist for 5 turns then expire
- Critical triggers add `[CRITICAL]` prefix — model must pause and inform user
- If cerebellum model returns empty or malformed output, the daemon retries once, then marks itself as `errored`

**Implementation:**
- `services/daemon_manager.py` — Task pool, lifecycle, result storage
- Core tool: `spawn_daemon` + `list_daemons` + `kill_daemon`
- `workbench.py` — Inject `<subconscious_updates>` in tier 3

### 5.5 Cognitive Budgeting (Self-Aware Context)

**Purpose:** Prevent context degradation by making the model aware of its own token usage. A Jarvis brain knows when it's running out of "mental energy" and adjusts accordingly.

**Mechanism:**
- Proxy calculates token usage before every LLM call
- Compares against model's max context window
- Injects result into `<cognitive_budget>` in tier 3

**Integration (Tier 3):**
```xml
<cognitive_budget>
  {"context_used_pct": 45, "remaining_tokens": 110000, "attention_pressure": "low"}
</cognitive_budget>
```

**Attention pressure levels:**

| Level | Context used | Guidance to model |
|-------|-------------|-------------------|
| `low` | 0-50% | Normal operation |
| `medium` | 50-75% | Prefer `write_scratchpad` over long analysis in chat |
| `high` | 75-90% | Use `memory_search`/`fact_search` to compact context. Delegate to subagents. |
| `critical` | 90%+ | Immediate compaction required. Use `memory_search` to save state, then consider reset. |

**System constraint (Tier 1):**
```text
- Cognitive Budget: Monitor <cognitive_budget>. 
  At "high" pressure, proactively compact context. 
  At "critical" pressure, save state and ask user to start fresh.
```

**Implementation:**
- `workbench.py` — Calculate token usage from `estimate_tokens()` before LLM call, inject `<cognitive_budget>`
- No new tools needed — purely proxy-side calculation

---

## 6. Implementation Phases

### Phase 0: Data Unification & Schema Migration
**Goal:** Eliminate the JSON/SQLite divergence, kill the dead SQLAlchemy DB, and establish `august_brain.sqlite` as the single source of truth for all text-based memory and state.

**Why this must come first:** If you build metacognition (heuristics, execution state, phase awareness) on a fragmented data layer, the model will appear to have amnesia — writes go to SQLite but reads still hit JSON files. Phase 0 guarantees a single source of truth before any cognitive layers are added.

**Step 1: Kill the dead SQLAlchemy database**
- Delete `app/database.py` (SQLAlchemy engine + session factory)
- Remove `init_db()` / `close_db()` calls from `app/main.py` lifespan
- Delete `data/august-sessions.db` if it exists
- Remove `sqlalchemy` and `aiosqlite` from `pyproject.toml` dependencies
- **Rationale:** `Base.metadata.create_all` ran on every startup but no ORM models exist. Dead code wasting ~100ms on startup.

**Step 2: Consolidate `august_core_memory.json` → SQLite `memory_store`**
- Write a one-time migration script `scripts/migrate_core_memory.py` that:
  - Reads `data/august_core_memory.json`
  - Extracts `user_profile`, `global_context`, `active_projects`
  - Upserts them into `memory_store` table keys: `"user_profile"`, `"current_context"`, `"active_projects"`
- Update `workbench.build_system_prompt()` to read these exclusively from SQLite
- Deprecate `august_core_memory.json` — proxy no longer reads it

**Step 3: Consolidate `august_learned_guidelines.json` → new `learned_heuristics` table**
- Create table in `memory_store.init()`:
  ```sql
  CREATE TABLE IF NOT EXISTS learned_heuristics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule TEXT NOT NULL,
      source TEXT DEFAULT '',
      category TEXT DEFAULT 'general',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
  );
  ```
- Write migration to import all entries from `august_learned_guidelines.json`
- Wire the Phase 2 `update_heuristics` tool to write to this table (not JSON)
- Wire proxy prefetcher to read from this table for `<learned_heuristics>` injection

**Step 4: Consolidate `august_semantic_memory.json` → new `auto_memories` table**
- Create flattened table:
  ```sql
  CREATE TABLE IF NOT EXISTS auto_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT,
      content TEXT,
      category TEXT DEFAULT 'auto',
      importance REAL DEFAULT 0.5,
      source TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS auto_memories_fts USING fts5(
      key, content, content='auto_memories', content_rowid='rowid'
  );
  ```
- Change `save_auto_memory()` to write individual rows (not one JSON blob under a single key) — this enables FTS5 to properly index and rank each entry
- Write migration to split existing `auto_memories` blob into individual rows
- Wire proxy prefetcher to query `auto_memories_fts` with BM25-ranked conversation context

**Step 5: Implement Proactive Memory Prefetch**
- Before each LLM call in `workbench.py`:
  1. Query `auto_memories_fts` using last 3-4 messages as query → top 5
  2. `SELECT * FROM learned_heuristics` → all active rules
  3. `SELECT * FROM memory_store WHERE key = 'core_memory'` → user facts
- Inject results into Tier 2 (`<learned_heuristics>`) and Tier 3 (`<runtime_context>`)
- This replaces `build_client_tool_guidance()` which was a no-op stub anyway

**Step 6: Document the remaining JSON files**
- `august_graph_memory.json` — Leave as JSON. Complex entity-relationship store, not part of core text loop.
- `august_infinite_memory.json` — Leave as JSON. Vector embeddings, queried via `vector_db.search()` on demand.
- Both are "append-only knowledge stores" — documented but outside the unified data layer.

**Files touched:**
- New: `scripts/migrate_core_memory.py`, `scripts/migrate_learned_heuristics.py`, `scripts/migrate_auto_memories.py`
- Modified: `app/services/memory_store.py` (new table creation), `app/services/memory/auto_memory.py` (flattened writes), `app/services/workbench/workbench.py` (prefetch logic), `app/main.py` (remove SQLAlchemy lifecycle)
- Deleted: `app/database.py`, `app/august-sessions.db`

**Tests:**
- Migration scripts import existing JSON data correctly
- No data loss after migration (row counts match)
- `save_auto_memory()` writes individual FTS-indexed rows
- Prefetcher returns relevant results from conversation context
- `memory_search` tool still works with flattened schema
**Goal:** No behavior change. Just reorganize — but also fix the dead `core_memory` pipeline.

**Changes:**
- `context_builder.py` — Rewrite `build_system_prompt()` to emit 3-tier XML structure
- `workbench.py` — Remove duplicated goal/plan. Wire tier 3 volatile sections. Add workspace, execution state, working memory slots.
- **Fix dead `core_memory` write:** Add `memory_store.get_memory("core_memory")` read in `build_system_prompt()`, inject facts into `<runtime_context>` as `User facts:` lines. This makes background review's extracted facts visible to the model for the first time.
- Remove `build_client_tool_guidance()` from context builder (proxy-only concern).

**Files touched:** 2
**Tests:** Verify structure output matches expected XML format, `core_memory` facts appear in output when present.

### Phase 2: Learned Heuristics
**Goal:** Persist heuristics across sessions.

**Changes:**
- New file: `services/heuristics_service.py` — CRUD for `learned_heuristics` SQLite table
- Add `update_heuristics` to `AUGUST_CORE_TOOLS` (core count: 14 → 15)
- `context_builder.py` — Inject `<learned_heuristics>` in tier 2 from SQLite table
- **Note:** Phase 0 already creates the `learned_heuristics` table and migrates legacy JSON data. Phase 2 exclusively reads/writes this SQLite table — no JSON file involved.

**Files touched:** 3 (+1 new)
**Tests:** CRUD operations, injection into prompt, tool dispatch.

### Phase 3: Execution State Machine
**Goal:** Phase awareness.

**Changes:**
- Add `update_state` to `AUGUST_CORE_TOOLS` (core count: 15 → 16)
- `workbench.py` — Store state in session metadata, inject into `<execution_state>` in tier 3
- **Concurrency:** Parallel `update_state` calls use **last-write-wins** — the most recent call's payload fully replaces the previous state. No merge, no deadlocks.

**Files touched:** 2 (+ session state field in dataclass)
**Tests:** State updates, persistence, injection, last-write-wins with parallel calls.

### Phase 4: Ephemeral Working Memory + Reflexive Error Correction
**Goal:** Scratchpad for clean reasoning + clean error handling without context pollution.

**Changes:**
- Add `write_scratchpad` to `AUGUST_CORE_TOOLS` (core count: 16 → 17)
- `workbench.py` — Keep last scratchpad in session metadata, inject into `<working_memory>` in tier 3
- **Reflexive Error Correction:** In `tool_executor.py` / `_execute_tool()`, catch exceptions and truncate tracebacks to the most relevant 5 lines. Format cleanly and inject into new `<failure_feedback>` block in tier 3 instead of dumping raw traceback into chat history.
- Update `<system_constraints>` (tier 1): *"If `<failure_feedback>` is present, diagnose the error and correct approach before any other action."*

**Files touched:** 3
**Tests:** Write/overwrite behavior, old content discarded, injection. Error truncation (full traceback → 5 lines), `<failure_feedback>` injection, model behavior guidance.

### Phase 5: BM25 + Progressive Disclosure
**Goal:** Intelligent tool/skill loading.

**Changes:**
- New files: `retrieval.py`, `tool_bridges.py`, `model_tools.py`, `skill_manifest.py`
- Modified: `tool_registry.py` (reserved names, keywords), `tool_definitions.py` (keywords), `workbench.py` (wire assembler)

**Files touched:** 6 (+4 new)
**Tests:** BM25 ranking, threshold gate, bridge dispatch, core safety, budget hierarchy.

### Phase 6: Prompt Caching
**Goal:** Upstream API prefix cache hits.

**Changes:**
- `workbench.py` — Cache tier 1 + tier 2 per session with 5-min TTL
- In-memory LRU cache (max 100 sessions)

**Files touched:** 1
**Tests:** Cache hit/miss, TTL eviction, LRU eviction.

### Phase 7: Subconscious Daemons & Proactive Interrupts
**Goal:** Async background processing. The model can spawn headless agents that run alongside the main conversation.

**Changes:**
- New file: `services/daemon_manager.py` — asyncio task pool, daemon lifecycle, result storage
- New core tools: `spawn_daemon`, `list_daemons`, `kill_daemon` in core set
- `workbench.py` — Inject `<subconscious_updates>` in tier 3 from daemon results
- `system_constraints` (tier 1) — Add proactive interrupt rules

**Files touched:** 3 (+1 new)
**Tests:** Daemon lifecycle (spawn/list/kill), result injection into prompt, result expiry after 5 turns, max daemon cap (3), critical trigger behavior.

### Phase 8: Cognitive Budgeting
**Goal:** Self-aware context management. The model knows its own cognitive load and compacts proactively.

**Changes:**
- `workbench.py` — Calculate token usage before LLM call using `estimate_tokens()`
- Inject `<cognitive_budget>` block in tier 3 with context_used_pct, remaining_tokens, attention_pressure
- Update `<system_constraints>` (tier 1) with compaction rules tied to attention pressure levels
- No new tools — purely proxy-side calculation

**Files touched:** 1
**Tests:** Budget calculation accuracy, attention pressure levels at boundaries (50%, 75%, 90%), injection format.

### Phase 9: Autonomous Cognitive Maintenance
**Goal:** Background self-organization — the system consolidates memories, learns from user corrections, and indexes time.

**Three sub-components running as background daemons:**

**9a. Sleep Cycle (Consolidation Daemon)**
- Background daemon triggered during idle or every 24 hours
- Uses headless LLM to review recent `auto_memories` and `learned_heuristics`
- Merges duplicates ("User prefers Yarn" + "Use Yarn not NPM" → one)
- Promotes recurring patterns to `facts` (5× same correction → permanent structured fact)
- Deletes outdated heuristics ("Server is down" after server is back up)
- New file: `services/consolidation_daemon.py`
- **Files touched:** 2 (+1 new)

**9b. Implicit Preference Delta Engine**
- Proxy tracks `write_file` outputs per session
- If user manually edits a file that the model wrote, proxy calculates a diff
- Lightweight background LLM call: *"Assistant wrote X, user changed it to Y. Infer a preference rule."*
- Result written to `learned_heuristics` table — model sees it next turn
- New file: `services/delta_engine.py`
- **Files touched:** 2 (+1 new)

**9c. Episodic Timeline Indexing**
- New table:
  ```sql
  CREATE TABLE episodic_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT,
      session_id TEXT,
      event_summary TEXT,
      category TEXT DEFAULT 'general'
  );
  ```
- Background review writes a 1-line summary to this table when a session ends or major goal completes
- New core tool: `search_timeline(from_date, to_date, category)` — lets model answer temporal queries
- Query: "What did we decide about the database last week?"
- **Files touched:** 2

**Phase 9 total changes:**
- New files: `services/consolidation_daemon.py`, `services/delta_engine.py`
- Modified: `memory_store.py` (new table), `tool_definitions.py` (new tool), `workbench.py` (wire daemon triggers)
- Connected to Phase 7 daemon infrastructure for scheduling

---

## 7. File Map

### New Files

| File | Phase | Purpose |
|------|-------|---------|
| `scripts/migrate_core_memory.py` | 0 | One-time migration: `august_core_memory.json` → SQLite `memory_store` |
| `scripts/migrate_learned_heuristics.py` | 0 | One-time migration: `august_learned_guidelines.json` → `learned_heuristics` table |
| `scripts/migrate_auto_memories.py` | 0 | One-time migration: split JSON blob → individual FTS-indexed rows |
| `app/services/tools/retrieval.py` | 5 | BM25 scoring (tool + skill) |
| `app/services/tools/tool_bridges.py` | 5 | Bridge tool schemas + dispatch |
| `app/services/tools/model_tools.py` | 5 | `assemble_tool_defs()` orchestrator |
| `app/services/tools/skill_manifest.py` | 5 | Manifest builder + payload loader |
| `app/services/heuristics_service.py` | 2 | Learned heuristics persistence (reads `learned_heuristics` table) |
| `app/services/daemon_manager.py` | 7 | Subconscious daemon task pool + lifecycle |
| `app/services/consolidation_daemon.py` | 9 | Sleep cycle: merge/promote/delete memories |
| `app/services/delta_engine.py` | 9 | Implicit preference detection from user edits |
| `app/services/blackboard_service.py` | 10 | Inter-agent shared cognitive workspace |
| `app/services/environment_watcher.py` | 10 | Passive file/git change monitoring daemon |

### Modified Files

| File | Phase | Changes |
|------|-------|---------|
| `app/services/memory/context_builder.py` | 1, 2 | Rewrite for 3-tier XML, add heuristics |
| `app/services/workbench/workbench.py` | 1, 3, 4, 5, 6, 10 | Remove dups, wire state/scratchpad/assembler/cache, verifier reflex, blackboard injection, env watcher |
| `app/services/tool_registry.py` | 5 | Reserved names, keywords field |
| `app/services/tool_definitions.py` | 5, 10 | Add keywords, blackboard + timeline tools |
| `app/services/memory_store.py` | 0, 9, 10 | Add learned_heuristics, auto_memories, episodic_timeline, blackboard tables |
| `app/routers/workbench.py` | 1 | Update capabilities endpoint if needed |
| `app/services/memory/auto_memory.py` | 0 | Flatten writes: individual rows instead of JSON blob |
| `app/main.py` | 0 | Remove SQLAlchemy lifecycle |

### Unchanged Files

| File | Reason |
|------|--------|
| `app/adapters/proxy_tools.py` | External proxy API stays as-is |
| `app/services/tools/agent_registry.py` | Agent system unchanged |
| `app/services/skill_service.py` | Skill CRUD unchanged |
| `app/services/tools/mcp_client.py` | MCP registration unchanged (adds category metadata) |

---

## 8. Appendix: Current State Analysis

### Current System Prompt Flow (Python Backend)

```
workbench.build_system_prompt(session)
  │
  ├── Gather: user_profile, global_context, projects, agent_context
  │
  ├── Call: context_builder.build_system_prompt(memory, tools, agent)
  │     │
  │     ├── AUGUST_PLATFORM constant
  │     ├── <memory_context> (profile + context + projects)
  │     ├── <agent_context> (if bound)
  │     ├── [CLIENT TOOL INVENTORY] (from build_client_tool_guidance)
  │     ├── ## Active Goal (DUPLICATED)
  │     └── ## Current Plan (DUPLICATED)
  │
  ├── ## Active Goal (DUPLICATED)
  ├── ## Current Plan (DUPLICATED)
  └── ## Available Skills (catalogue)
```

**Issues:**
- Goal/plan duplicated (2 copies = dead tokens)
- No workspace path
- No learned heuristics
- No execution state / phase awareness
- No scratchpad
- No memory tools summary
- No brain orchestrator classification
- No whats_new section
- Client tool guidance in wrong place (proxy concern, not workbench)
- No prompt caching
- Skills limited to 15 active

### Comparison: Node.js Backend (Has More Sections)

The Node.js backend (`backend/services/workbench/workbench.js`) already has:
- `<brain_orchestrator>` — task classification, risk level, execution policy
- `<august_learned_guidelines>` — persistent rules
- `<august_memory_tools>` — checkpoint/fact/graph counts
- `<august_graph_memory>` — entity counts
- `<whats_new>` — recent git + feature updates
- `=== HARD RULE ===` — guard mode, platform rules
- `=== AVAILABLE TOOL CATEGORIES ===` — tool category descriptions
- `<team_skills>` — team-specific skill packs
- Per-session prompt caching with 5-min TTL

The Python backend should match or exceed this, which this spec accomplishes.

---

## 9. Autonomous Cognitive Maintenance

> The four pillars that make the system self-organizing rather than just reactive.

### 9.1 Sleep Cycle (Consolidation Daemon)

**Purpose:** Prevent cognitive clutter. Over months, raw memories accumulate and FTS5 returns noise. The consolidation daemon organizes the subconscious during idle time.

**Mechanism:**
- Background daemon (built on Phase 7 daemon infrastructure) triggers during idle or every 24 hours
- Calls a headless LLM with recent `auto_memories` and `learned_heuristics` content
- Three operations:
  1. **Merge duplicates:** "User prefers Yarn" + "Use Yarn not NPM" → single canonical heuristic
  2. **Promote patterns:** Same correction observed 5+ times → permanent `fact` (structured, cross-session)
  3. **Delete stale:** "Server is down" after the server is back up → removed

**Integration:**
- New file: `app/services/consolidation_daemon.py`
- Reads from `auto_memories` and `learned_heuristics` tables
- Writes merged results back, deletes stale entries, promotes to `facts` table
- Schedules via Phase 7 daemon manager

**Phase:** 9

### 9.2 Implicit Preference Delta Engine

**Purpose:** Learn from user corrections *without* the model needing to call `update_heuristics`. If the user silently fixes the model's output, the system should infer a rule.

**Mechanism:**
- Proxy tracks `write_file` calls made by the model, storing a hash of the written content per session
- Instead of relying solely on `read_file` calls, the delta engine subscribes to **environment watcher** events (Phase 10) — when the watcher detects an external file modification, it triggers a diff check
- If a modification is detected (either via `read_file` call or env watcher event), proxy compares current content against the stored hash
- If different, proxy calculates the diff and sends it to a lightweight background LLM:
  > "Assistant wrote: `npm install`  
  > User changed it to: `yarn install`  
  > Infer a one-sentence behavioral rule."
- Result is written to `learned_heuristics` table
- Model sees the new heuristic in `<learned_heuristics>` on the next turn — adapts instantly

**Integration:**
- New file: `app/services/delta_engine.py`
- Subscribes to environment watcher file-change events (not just `read_file` hooks) — catches IDE edits the proxy never reads
- Falls back gracefully if no LLM is available (skips inference, just logs the diff)
- **Note:** Phase 10 (env watcher) must be deployed before delta engine can catch external edits. If env watcher is not available, delta engine degrades to only detecting edits made via `read_file`.

**Phase:** 9 (env watcher dependency noted for Phase 10)

### 9.3 Reflexive Error Correction

**Purpose:** Prevent error loops and context pollution from raw traceback dumps.

**Mechanism:**
- In `tool_executor.py` / `_execute_tool()`, catch all exceptions
- Truncate the traceback to the most relevant 5 lines (file + line + error type + message + offending line)
- Format as clean structured block instead of raw Python traceback
- Inject into `<failure_feedback>` in Tier 3 — NOT into chat history as a tool result

**Integration (Tier 3):**
```xml
<failure_feedback>
Tool: run_command
Error: SyntaxError: invalid syntax (line 45)
Traceback:
  File "auth.py", line 45
    def login(user, pass):
                      ^
</failure_feedback>
```

**System constraint (Tier 1):**
```text
- Reflexive Errors: If <failure_feedback> is present, diagnose the error and correct
  your approach before attempting any other action.
```

**Why it matters:**
- Raw tracebacks can be 50+ lines → waste context
- Model panics when it sees a wall of red text → loops
- Structured feedback forces immediate diagnostic behavior

**Phase:** 4 (implemented alongside Ephemeral Working Memory)

### 9.4 Episodic Timeline Indexing

**Purpose:** Answer temporal queries that FTS5 cannot handle. "What did we decide about the database last Tuesday?"

**Mechanism:**
- New table in `august_brain.sqlite`:
  ```sql
  CREATE TABLE episodic_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT,
      session_id TEXT,
      event_summary TEXT,
      category TEXT DEFAULT 'general'
  );
  ```
- Populated by background review: when a session ends or a major goal completes, a 1-line summary is appended
- New core tool: `search_timeline(from_date, to_date, category)` — returns matching timeline entries
- Model can answer: "What changed in auth.py last week?" → calls `search_timeline("2026-06-20", "2026-06-27", "auth")`

**Why FTS5 isn't enough:**
- FTS5 matches keywords ("database", "PostgreSQL") but can't match "last Tuesday"
- Timeline stores structured datetime + human-readable summaries
- Combined with FTS5 for full temporal + semantic search

**Phase:** 9

### Summary: The Final Cognitive Loop

```
┌──────────────────────────────────────────────────────────────────┐
│                       THE JARVIS BRAIN                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  CONSCIOUS (Per-Turn)                                             │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ 1. Prefetch: BM25 tools + FTS5 memories + rules         │    │
│  │ 2. Assemble: core + pre-loaded + bridges                │    │
│  │ 3. Inject: state + scratchpad + feedback + blackboard   │    │
│  │ 4. Model acts, calls tools, writes memories             │    │
│  │ 5. Track: execution state, working memory               │    │
│  │ 6. Verifier Reflex: force validation before completion  │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  SUBCONSCIOUS (Post-Turn + Background)                            │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  7. Background review: extract skills + facts            │    │
│  │  8. Self-evolution: detect corrections                   │    │
│  │  9. Auto-memory: save summaries + todos                  │    │
│  │ 10. Daemons: run async background tasks                  │    │
│  │ 11. Blackboard: agents share real-time state             │    │
│  │ 12. Environment watcher: file/git changes → auto-update  │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  MAINTENANCE (Idle / Daily)                                       │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ 13. Sleep cycle: consolidate memories                    │    │
│  │ 14. Delta engine: detect implicit preferences            │    │
│  │ 15. Timeline: index episodic summaries                   │    │
│  │ 16. Skill genesis: auto-write SKILL.md from workflows    │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 10. Advanced Cognitive Frontiers

> These four pillars push the system beyond reactive agent into a collaborative, environmentally-aware, self-validating, self-growing intelligence.

### 10.1 The Shared Blackboard (Inter-Agent Coordination)

**Purpose:** Allow the main loop and background daemons to share real-time cognitive state. Daemons don't just report results — they collaborate mid-execution.

**Mechanism:**
- New table in `august_brain.sqlite`:
  ```sql
  CREATE TABLE blackboard (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,        -- "main", "ci_watcher", "env_watcher"
      key TEXT NOT NULL,          -- e.g., "test_result", "file_change", "note"
      value TEXT NOT NULL,        -- JSON or plain text payload
      priority INTEGER DEFAULT 0, -- higher = more urgent
      created_at TEXT,
      expires_at TEXT             -- auto-cleanup after TTL
  );
  ```
- New core tools: `write_blackboard(key, value, priority)`, `read_blackboard(agent, key)`, `clear_blackboard(agent)`
- Daemons write findings as structured notes
- Main proxy reads current blackboard state and injects into `<blackboard_state>` in Tier 3

**Integration (Tier 3):**
```xml
<blackboard_state>
  <note agent="ci_watcher" key="test_result" priority="8">
    Tests failing on auth.py line 45
  </note>
  <note agent="env_watcher" key="file_change" priority="3">
    src/auth.py modified externally
  </note>
</blackboard_state>
```

**Why it matters:** If the main model is rewriting `auth.py` and the `ci_watcher` daemon posts "Tests failing on line 45", the model sees this on its NEXT turn and says "Ah, I know why — let me fix it." No polling, no waiting, no context switching.

**Phase:** 10

### 10.2 Continuous Environmental Watcher (The "Eye")

**Purpose:** Passive, real-time awareness of the workspace. The model shouldn't need to poll `list_directory` or `run_command("git status")` to know what's happening.

**Mechanism:**
- New daemon: `environment_watcher` using `watchdog` (or lightweight polling fallback)
- Watches: filesystem modifications, git branch changes, terminal activity
- Pushes structured change notifications to the `<runtime_context>` (Tier 3)

**Integration (Tier 3):**
```xml
<runtime_context>
  ...
  <environment>
    File changed: src/auth.py (external edit, 2s ago)
    Git branch: feature/jwt-fix (ahead of main by 3 commits)
    Last command: git push origin feature/jwt-fix (15s ago)
  </environment>
</runtime_context>
```

**Design decisions:**
- Uses `watchdog` if available (OS-native file events), falls back to 5-second polling
- Rate-limited: max 1 update per 2 seconds to avoid flooding context
- Only reports meaningful changes (ignores `.pyc`, `node_modules`, `.git/objects`)

**Why it matters:** If you switch branches in your terminal while chatting, Jarvis knows. If you manually edit a file in your IDE, Jarvis sees the diff before you ask him to review it. He stops being blind between turns.

**Phase:** 10

### 10.3 The Verifier Reflex (Pre-Commit Validation)

**Purpose:** Prevent "it works on my machine" hallucinations. The model must prove a task is complete before declaring it done.

**Mechanism:**
- `update_state` is extended with an optional `verification_command` field:
  ```json
  {
    "phase": "review",
    "step": 4,
    "completed": ["Implement JWT fix"],
    "blockers": [],
    "verification_command": "python -m pytest tests/test_auth.py -x"
  }
  ```
- When the model calls `update_state(phase="review")` or `update_state(phase="complete")`:
  1. Proxy checks if `verification_command` was supplied
  2. If **supplied:** Proxy injects `<verifier_gate>` with that specific command, plus a reminder to check the output before declaring done:
     ```xml
     <verifier_gate>
       You marked step 4 as complete. Verify before proceeding:
       Run: python -m pytest tests/test_auth.py -x
       Confirm output shows "PASSED" or "0 failed".
       Only then use `update_state` to transition to "review".
     </verifier_gate>
     ```
  3. If **not supplied:** Proxy injects a generic reminder:
     ```xml
     <verifier_gate>
       You are about to mark a step complete without verification.
       Run the appropriate test/lint/validation command, then confirm
       the result before calling `update_state(phase="review")`.
     </verifier_gate>
     ```
- **Proxy does NOT generate verification commands** — that is the model's responsibility. The proxy only enforces that some verification happens.
- If the model runs the verification and it fails, the proxy allows the model to fix (tool calls still work). But `update_state(phase="review")` will trigger the gate again until verification passes.

**System constraint (Tier 1):**
```text
- Verifier Gate: Before transitioning to "review" or "complete", you must
  execute a verification command. Include `verification_command` in your
  `update_state` call. If verification fails, fix the issue and re-verify.
  Do not skip or fake verification output.
```

**Why the model supplies commands (not the proxy):**
- The proxy doesn't know what "verification" means for a given task. The model knows what test covers the change it just made.
- The model might need to run `npm test`, `pytest -x`, `cargo check`, `go vet`, or a custom script. Hardcoding these in the proxy would be fragile.
- This design keeps the proxy layer simple: it's a gate, not a test oracle.

**Phase:** 10

### 10.4 Dynamic Skill Genesis (Auto-Programming)

**Purpose:** The model writes its own reusable SKILL.md files from successful workflows. The system grows its own capabilities over time.

**Mechanism:**
- Sleep Cycle daemon (Phase 9) is upgraded to also analyze complex, multi-step successes
- After a successful complex session, daemon asks a headless LLM:
  > "This session completed a complex multi-step workflow. Is this workflow generic
  > enough to be turned into a reusable skill? If yes, draft a SKILL.md with:
  > name, description, trigger, and step-by-step procedure body."
- If the LLM returns a valid skill, daemon writes it to the agent skills directory
- BM25 Skill Manifest picks it up automatically on next assembly — the model can now `load_skill("jwt-debugging")` using a skill it wrote itself

**Skill quality guard:**
- Minimum 3 successful uses before skill genesis activates (prevents one-off workflows from polluting the skill library)
- Generated skills are tagged `created_by: auto-gen` for traceability
- Maximum 1 auto-generated skill per day (rate-limited)
- **User approval required before activation:** Auto-generated skills are written to a **staging directory** (`<data_dir>/skills/staging/`) and added to a `pending_skills` table in SQLite. The next time the user opens the Skills section in the UI, a banner shows: *"Jarvis generated a new skill: jwt-debugging."* The user can approve, edit, or reject it. Only approved skills are moved to the active skills directory and picked up by BM25. If the user doesn't respond within 7 days, the skill is auto-discarded.

**Why it matters:** This is recursive self-improvement. The AI learns from complex sessions and encodes its own expertise into permanent, loadable knowledge packs. Over months, the skill library evolves to perfectly match the user's workflow patterns — without manual authoring.

**Phase:** 10

### Phase 10: Advanced Cognitive Frontiers
**Goal:** Inter-agent coordination, environmental awareness, self-validation, and recursive skill generation.

**Changes:**
- New file: `services/blackboard_service.py` — Blackboard CRUD + injection
- New file: `services/environment_watcher.py` — Watchdog-based file/git monitoring daemon
- Modified: `memory_store.py` (new `blackboard` + `episodic_timeline` tables), `workbench.py` (verifier reflex, blackboard injection, env watcher injection), `tool_definitions.py` (new tools), `services/consolidation_daemon.py` (skill genesis upgrade)
- New core tools: `write_blackboard`, `read_blackboard`, `clear_blackboard`, `search_timeline`

**Files touched:** 5 (+2 new)
**Tests:** Blackboard CRUD, env watcher file detection, verifier gate state injection, skill genesis quality gate, timeline search.

---

## 11. Model Fleet Architecture

> **Do not use one model for all cognitive layers.** A true Jarvis brain routes each cognitive function to the appropriately-sized model — maximizing intelligence where it matters and speed/cost where it doesn't.

### The Four Tiers

| Tier | Role | Requirements | Recommended models | Cognitive functions |
|------|------|-------------|-------------------|-------------------|
| **Cortex** | Main conscious loop | High reasoning, 200K+ ctx, top-tier tool use | Sonnet 4, GPT-4o | Primary conversation, complex tool orchestration, multi-step reasoning, Tier 1-3 injection |
| **Cerebellum** | Subconscious daemons | Blazing fast, cheap, zero-shot formatting | Haiku, GPT-4o-mini, Llama 3 8B (local) | `environment_watcher`, `ci_watcher`, blackboard formatting, reflexive error truncation |
| **Hippocampus** | Memory consolidation | Moderate reasoning, async (latency doesn't matter) | Haiku, GPT-4o-mini | Sleep cycle (merge/promote/delete), delta engine (infer preference from diff) |
| **Prefrontal** | Skill genesis | Highest reasoning, one-off calls | Sonnet 4, Opus | Drafting new SKILL.md from successful workflows, complex task decomposition |

### Implementation

```python
# In app/config.py or app/services/workbench/model_fleet.py

MODEL_FLEET: dict[str, str] = {
    "cortex":      "",  # Falls back to session model if empty
    "cerebellum":  "claude-3-haiku-20240307",
    "hippocampus": "claude-3-haiku-20240307",
    "prefrontal":  "claude-3-5-sonnet-20240620",
}

def get_model_for_role(role: str) -> str:
    """Resolve the model for a cognitive role.
    
    Returns the role-specific model if configured, otherwise falls back
    to the session's main model (cortex).
    """
    return MODEL_FLEET.get(role) or MODEL_FLEET["cortex"]
```

### Where each tier is wired

| Phase | Component | Tier | How model is selected |
|-------|-----------|------|----------------------|
| 0-2 | Main workbench loop | Cortex | User-selected session model |
| 4 | Reflexive error truncation | Cerebellum | `get_model_for_role("cerebellum")` |
| 5 | BM25 prefetch (no LLM) | — | No model needed (pure math) |
| 7 | `spawn_daemon` | Cerebellum | Daemon spawns with cerebellum model |
| 8 | Cognitive budget (no LLM) | — | No model needed (token math) |
| 9 | Sleep cycle consolidation | Hippocampus | Async, `get_model_for_role("hippocampus")` |
| 9 | Delta engine inference | Hippocampus | Async, `get_model_for_role("hippocampus")` |
| 10 | Skill genesis drafting | Prefrontal | One-off, `get_model_for_role("prefrontal")` |
| 10 | Background review | Hippocampus | Configured via Background & Reflection subtab |

### Cost/Latency impact

| Task | Without fleet | With fleet | Savings |
|------|--------------|------------|---------|
| Daemon monitoring (100x/day) | Sonnet: $3.00/day | Haiku: $0.10/day | **97%** |
| Sleep cycle (1x/day) | Sonnet: $0.15/day | Haiku: $0.005/day | **97%** |
| Skill genesis (1x/week) | Haiku (poor quality) | Sonnet (high quality) | **Correctness** |
| Main loop | Sonnet (unchanged) | Sonnet (unchanged) | — |

### Configuration

Users can override the fleet in their `config.json`:

```json
{
  "model_fleet": {
    "cerebellum": "gpt-4o-mini",
    "hippocampus": "claude-3-haiku-20240307",
    "prefrontal": "claude-opus-4-20250514"
  }
}
```

If a role is unset, it falls back to the session's main model (cortex) — preserving backward compatibility for users who don't configure the fleet.

### UI Configuration

The Model Fleet gets its own subtab in the Model Settings section of the desktop app, alongside the existing Background & Reflection subtab.

**New subtab: "Model Fleet"** (icon: Cpu)

Four model picker dropdowns, each backed by the same `ModelPickerDropdown` component used by Background & Reflection:

| Field | Default | Hint |
|-------|---------|------|
| Cortex model | *(uses session model)* | "Main reasoning model for the conscious chat loop." |
| Cerebellum model | `claude-3-haiku-20240307` | "Fast, cheap model for background daemons and watchers." |
| Hippocampus model | `claude-3-haiku-20240307` | "Model for memory consolidation and preference inference (async, latency insensitive)." |
| Prefrontal model | `claude-3-5-sonnet-20240620` | "Highest-reasoning model for skill genesis and complex planning (rare, one-off calls)." |

**Config shape** (stored alongside `background_review` in `config.json → auxiliary`):
```json
{
  "model_fleet": {
    "cortex": "",
    "cerebellum": "claude-3-haiku-20240307",
    "hippocampus": "claude-3-haiku-20240307",
    "prefrontal": "claude-3-5-sonnet-20240620"
  }
}
```

**Backend:** New endpoints `GET/PUT /api/config/model-fleet` in `config.py` router, parallel to `GET/PUT /api/config/background-review`.

**Why this needs UI (not just config.json):**
- Users constantly switch models. A dropdown is faster than editing JSON.
- The fleet interacts with the Background & Reflection config — having both visible lets users see the complete model allocation for their proxy.
- The `cortex` field being empty = "use session model" is clearer in a dropdown with that label than an empty string in JSON.

---
