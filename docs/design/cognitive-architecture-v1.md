# Cognitive Architecture v1 — August Proxy

> A self-correcting, stateful, cognitive loop for the agentic workbench.
>
> **Status:** Design spec — not yet implemented.
> **Target:** Python backend (`backend-py/`).
>
> **Document scope:** This spec covers Phases 0–7 (the core cognitive loop:
> data unification, prompt restructure, cognitive budgeting, BM25 disclosure,
> heuristics, execution state, working memory, prompt caching) and Phases 8–10
> (autonomous layers: daemons, consolidation, blackboard, env watcher,
> verifier reflex, skill genesis). Phases 0–7 are tightly coupled and share one
> delivery boundary — ship them as **v1**. Phases 8–10 are each substantial
> enough to warrant their own design review and are grouped as **v2**; do not
> begin v2 implementation until v1 is shipped and verified in production.
> Each v2 phase can be built independently once the Phase 8 daemon infrastructure
> and Phase 0 DB write queue are in place. **v3** (Sections 11–13) is a
> user-facing delivery built on top of v1/v2: full model access to the brain,
> a combined **Brain dashboard** (Learning + System Health tabs), and the
> **/Exam** preparation-skills feature. v3 is its own delivery boundary — do not
> start it until v1 is shipped.
>
> **Implementation tracking:** Progress is tracked in four checklist files under
> `docs/design/` — agents work them in order and only advance to the next file
> once the current one is fully checked off:
> 1. [`tracker-v1.md`](./tracker-v1.md) — Phases 0–7 (core cognitive loop)
> 2. [`tracker-v2.md`](./tracker-v2.md) — Phases 8–10 (autonomous layers)
> 3. [`tracker-v3.md`](./tracker-v3.md) — Brain access, Brain dashboard, /Exam
> 4. [`tracker-v4.md`](./tracker-v4.md) — August Live (voice) + UI redesign

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
9. [Failure Modes & Edge Cases](#9-failure-modes--edge-cases)
10. [Model Fleet Architecture](#10-model-fleet-architecture)
11. [Full Brain Access (Model Self-Query)](#11-full-brain-access-model-self-query)
12. [Brain Dashboard (Learning + System Health UI)](#12-brain-dashboard-learning--system-health-ui)
13. [v3: /Exam — Preparation Skills](#13-v3-exam--preparation-skills)
14. [v4: August Live (Voice + Command Execution)](#14-v4-august-live-voice--command-execution)
15. [v4: UI Redesign — Modern & Minimalist](#15-v4-ui-redesign--modern--minimalist)
16. [v4: Rendering & Input Fixes (Math, Auto-Grow Composer, Scroll Thumb)](#16-v4-rendering--input-fixes-math-auto-grow-composer-chat-scroll-thumb)

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
| Reflection model is misnamed | `reflectionModel` field only powers regex, not an LLM | Rename to "Rule-based reflection" when adding subconscious model in Phase 8 |
| Data layer fragmentation | Python writes to SQLite, Node.js writes to JSON files. Silent divergence on `core_memory`, `learned_guidelines`, `auto_memories` | Phase 0 unifies everything into `august_brain.sqlite` with FTS5 |
| Dead SQLAlchemy database | `database.py` creates engine + runs `create_all` on every startup but no models exist | Delete `database.py`, remove from lifespan |
| Auto-memories in JSON blob | All 100 entries serialized under one `"auto_memories"` key — FTS can't rank individual entries | Flatten to individual rows with FTS5 indexing |

### Caching Strategy

| Tier | Content | Cache key | TTL | Benefit |
|------|---------|-----------|-----|---------|
| 1 | system_constraints + user_state | session.agent_id | 5 min | Upstream API prefix cache hit |
| 2 | workspace + directives + heuristics | session.id | Per-session lifetime | Avoids rebuild on every turn |
| 3 | execution_state + working_memory + runtime_context + primed_playbooks | — | Rebuilt every turn | Always fresh |

> **Tier 3 injection rule:** All Tier 3 blocks are injected **conditionally** — only when they contain data. An empty `<cognitive_budget>` or absent `<failure_feedback>` block is never rendered. This prevents the prompt from filling with 9 empty XML blocks when no daemons are running, no errors occurred, and no blackboard notes exist.

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

**Query:** Sliding window of the last 6 turns (user + assistant messages), with recency decay. Messages beyond 6 turns are excluded to keep the query focused on current context. Within the window, each message is weighted by proximity (most recent message weighted highest). The raw concatenated text is used as the BM25 query — tool names and descriptions are keyword-dense, so BM25 performs well when the conversation contains concrete nouns ("dockerfile", "pytest", "auth.py"). **Tunable:** The window size and decay factor are configurable per deployment. Initial default: 6 turns with linear decay (message at position N has weight N/window_size).

**Known limitation — BM25 cannot bridge synonyms or intent:** BM25 is lexical matching, not semantic. A user saying "ship it" or "do it again" (referring to a skill from 8 turns ago, outside the window) produces a query with zero keyword overlap with any tool or skill name. BM25 will return noise or nothing in these cases. This is acceptable because **progressive disclosure is a latency optimization, not a correctness mechanism.** The skill manifest (always present) plus `load_skill` / bridge `tool_search` (both core) guarantee the model can always reach any tool or skill explicitly when BM25 misses. The common case the optimizer targets is a user mentioning a concrete artifact ("audit this Dockerfile", "run the auth tests") where the keyword overlap is direct.

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

### Core Tools (Never Deferred) — 14 → 24 tools

Added incrementally across phases:

**Phase 1 base (15 — includes `brain_query`, see §11):**
```python
AUGUST_CORE_TOOLS = frozenset({
    "read_file", "write_file", "list_directory", "search_files",
    "run_command",
    "web_fetch", "web_search",
    "memory_search", "fact_search", "context_read",
    "load_skill", "list_skills", "skill_manage",
    "spawn_subagent",
    "brain_query",   # §11 — unified read access to august_brain.sqlite (added Phase 0)
})
```

> **Note on counts:** `brain_query` (§11) is registered in Phase 0 as a core tool, so the base is **15**, not 14. Every running total below therefore shifts by +1 (final core set = **25**, not 24). The older "14 → 24" figures elsewhere in this doc predate `brain_query`; treat 15 → 25 as authoritative.

**Phase 4 (+1):** `update_heuristics` → 15
**Phase 5 (+1):** `update_state` → 16
**Phase 6 (+1):** `write_scratchpad` → 17
**Phase 8 (+3):** `spawn_daemon`, `list_daemons`, `kill_daemon` → 20
**Phase 9 (+1):** `search_timeline` → 21
**Phase 10 (+3):** `write_blackboard`, `read_blackboard`, `clear_blackboard` → **24 final**

### Core Tool Decision Matrix

Each tool added after Phase 6 was evaluated for core vs deferrable status:

| Tool | Phase | Core? | Rationale |
|------|-------|-------|-----------|
| `spawn_daemon` | 8 | ✅ Core | Daemon management is a fundamental primitive — the model must always be able to spawn background tasks. Hiding behind a bridge would add latency to every daemon spawn. |
| `list_daemons` | 8 | ✅ Core | Reading daemon status must be instant, no search round-trip. |
| `kill_daemon` | 8 | ✅ Core | Stopping a runaway daemon must be immediate — no time for a bridge search. |
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

**Progressive disclosure and auto-priming are latency optimizations, not correctness mechanisms.** If BM25 misfires (e.g., user says "do it" referring to a skill from 5 turns ago), correctness is preserved by the fallback path:
- The **skill manifest** in `<user_state>` lists every skill — the model sees it
- The **`load_skill`** tool is in core — always available
- The **`tool_search`** bridge (when threshold activates) is always available
- The model explicitly calls `load_skill(name)` or `tool_search(query)` as it does today

BM25 pre-loading removes the round-trip in the *common* case (concrete keyword overlap). It does not replace explicit loading for ambiguous references, synonyms, or out-of-window context. The fallback path is the guarantee; the auto-prime is the optimization.

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
- Core tool: `spawn_daemon(name, prompt, watch_condition, tools=None)`
  - `name`: Unique identifier for the daemon
  - `prompt`: Instructions for the background agent. The daemon runs these instructions **once per polling cycle** and returns a structured result.
  - `watch_condition`: A structured trigger specification. One of:
    - `"on_completion"` — alert when the daemon finishes its work
    - `"on_match:ERROR"` — alert when the daemon's output contains a keyword/pattern (case-insensitive substring match)
    - `"on_change"` — alert when the daemon's output differs from the previous cycle
    - `nil` (null) — no proactive alert; model reads results via `list_daemons`
- Proxy manages an asyncio task pool for daemons
- Daemon runs headless — no user interaction, no streaming. The daemon uses the **Cerebellum** model (fast, cheap).
- **Tool access:** Daemons have a **restricted read-only tool set** by default: `web_fetch`, `read_file`, `list_directory`, `search_files`, `run_command` (read-only flag enforced — mutating commands are rejected). This is sufficient for the primary daemon use cases: polling CI endpoints, tailing logs, watching files. The `tools` parameter accepts an explicit allowlist to further restrict this (e.g., `tools=["web_fetch"]` for a pure HTTP poller). Passing `tools=[]` disables all tool access, falling back to pure text generation.
  - **Why not full tool access?** Daemons run unattended on the Cerebellum model — a cheap, low-reasoning model. Giving it `write_file` or `run_command` with mutation would risk unattended side-effects from a model not capable of safely judging mutations.
  - **Why not zero tool access?** The daemon use cases (CI polling, log monitoring, file watching) all require reading external state — HTTP calls, file reads, command output. A tool-less daemon can only analyze text the proxy already has, which defeats the purpose.
  - **For complex multi-step background tasks** that require reasoning + mutation, use `spawn_subagent` instead (Cortex model, full tool access).
- On completion or trigger, result is stored in session metadata
- Injected into `<subconscious_updates>` in tier 3

**Daemon evaluation contract:**
1. Proxy creates an async task with the cerebellum model, the daemon's restricted tool set, and `prompt` as the system message
2. Daemon runs (may call its restricted tools), returns raw text output
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
| Tool access | Restricted read-only (web_fetch, read_file, run_command read-only) | Full tool access |
| Use case | Polling CI, tailing logs, watching files | Complex research, multi-step tasks with mutation |
| Cost | Fractions of a cent per run | Full inference cost |
| Latency | Runs in background, async | Blocks until complete |

**Lifecycle:**
```
spawn_daemon("ci_watcher", 
  "Use web_fetch to call https://ci.example.com/api/status. Report PASS or FAIL.", 
  "on_match:FAIL")
  → Proxy creates async task with cerebellum model
  → Daemon calls web_fetch → receives CI JSON
  → Cerebellum model analyzes: "Result: FAIL - 3 tests failed in auth.py"
  → Proxy detects "FAIL" in output → stores result
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
- **Exponential backoff:** On API failure, daemon backs off: 5s → 15s → 45s → 135s (capped at 5 min). Resets to normal interval on success.
- **Lifecycle tie:** Daemons are tied to the main application process. If the app shuts down, all daemons are cancelled gracefully via `asyncio.gather()` with a 5-second timeout.

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
- `workbench.py` — Calculate token usage before LLM call, inject `<cognitive_budget>`
- **Token estimation method:**
  1. **Anthropic models (priority):** Use the `anthropic` SDK's built-in `count_tokens()` — this is the only accurate method for Anthropic's tokenizer.
  2. **OpenAI models:** Use `tiktoken`.
  3. **Gemini models:** Use the `tokenizers` library with the Gemini-compatible tokenizer if available. Falls back to 3.5-char heuristic.
  4. **Fallback (all other providers):** Use a **3.5-char-per-token heuristic** and set the critical threshold to **85%** (instead of the default 90%) to provide a safety buffer against miscounting. The 3.5 heuristic is closer to real tokenizer averages across multilingual and code-heavy workloads than the simpler 4-char approximation.
- No new tools needed — purely proxy-side calculation

**Automatic context compaction at critical pressure:**
When `<cognitive_budget>` shows `attention_pressure: "critical"`, the proxy does not merely inform the model — it triggers an automated compaction:
1. Proxy pauses the main LLM call loop
2. Last 10 messages (user + assistant) are extracted
3. Hippocampus model is called with: *"Summarize these messages into a 500-word paragraph. Preserve all decisions, code changes, and user preferences."*
4. Original messages are saved to SQLite (`messages` table) for later retrieval
5. The 10 messages are replaced with a single system-origin `<compacted_history>` block in the conversation array
6. Proxy resumes the loop
7. `<cognitive_budget>` now reflects a `"last_compaction": "1 turn ago"` field so the model knows recent history was condensed

This prevents the critical-pressure death spiral where the model panics about running out of context and wastes its last few turns on meta-commentary instead of productive work.

---

## 6. Implementation Phases

### Rollout strategy: Feature flags

`workbench.py` is modified in **8 of 10 phases** — more than any other file. A regression in any phase that touches the tool loop can break the main chat path. To ship phases incrementally and roll back without code changes, each cognitive-layer feature is gated by a flag in `data/config.json`:

```json
{
  "cognitive_layers": {
    "heuristics": true,
    "execution_state": true,
    "scratchpad": true,
    "failure_feedback": true,
    "tool_guardrails": true,
    "progressive_disclosure": true,
    "prompt_caching": true,
    "cognitive_budget": true,
    "daemons": false,
    "blackboard": false,
    "env_watcher": false,
    "verifier_reflex": false,
    "skill_genesis": false
  }
}
```

- Each Tier 3 injection block (`<execution_state>`, `<working_memory>`, `<failure_feedback>`, `<cognitive_budget>`, `<subconscious_updates>`, `<blackboard_state>`, etc.) checks its flag before rendering. A disabled flag = the block is omitted entirely (not rendered empty).
- New core tools still register when their flag is off — the model can call `update_state` and it works — but the *prompt injection* of the result is gated. This keeps tool-call responses consistent while letting you disable the prompt-layer effects independently.
- The exception is progressive disclosure (Phase 3) and prompt caching (Phase 7): these are proxy-side mechanics, not prompt blocks, and gate the entire assembler/cache path rather than a single block.
- Default: flags for shipped v1 phases (0-7) start `true`; flags for v2 phases (8-10) start `false` and flip on as each phase lands. This gives a safe default-on path for reviewed features and explicit opt-in for new ones.

### Phase 0: Data Unification & Schema Migration
**Goal:** Eliminate the JSON/SQLite divergence, kill the dead SQLAlchemy DB, and consolidate all text-based memory and state into `august_brain.sqlite`.

> **Current-state correction (verified against code):** `august_brain.sqlite` **already exists** and is already the live store — `memory_store.py` defines `_DEFAULT_BRAIN_FILE = "august_brain.sqlite"` and already creates `memory_store`, `facts`, `sessions`, `messages`, `usage_events`, `proposals`, `lifecycle`, `session_topics`, and `config_audit` tables. Phase 0 does **not** bootstrap a new database. Its real work is: (a) add the missing tables (`learned_heuristics`, flattened `auto_memories` + FTS), (b) add the **missing FTS triggers** (the existing `memory_store_fts` has none — see Step 4), and (c) migrate the legacy JSON stores into this existing DB. Do not write code that assumes the DB or its base tables are absent.

**Why this must come first:** If you build metacognition (heuristics, execution state, phase awareness) on a fragmented data layer, the model will appear to have amnesia — writes go to SQLite but reads still hit JSON files. Phase 0 guarantees a single source of truth before any cognitive layers are added.

**Step 1: Kill the dead SQLAlchemy database**
- Delete `app/database.py` (SQLAlchemy engine + session factory)
- Remove `init_db()` / `close_db()` calls from `app/main.py` lifespan
- **Do NOT blindly delete `data/august-sessions.db`.** This file currently exists on disk (~1.6 MB + a multi-MB WAL) and `database.py:24` documents it as **"shared with Node.js backend."** Because no SQLAlchemy ORM models exist, those bytes were written by something *other* than this Python engine — most likely the Node.js backend. Before removing it:
  1. Confirm the Python backend never reads it (it doesn't — `database.py` is the only referencer and exposes no models).
  2. Confirm the **Node.js** backend is fully retired or no longer points at `august-sessions.db`. Grep the `backend/` tree for `august-sessions` first.
  3. Only if both are clear, archive it (`mv august-sessions.db august-sessions.db.bak`) rather than `rm` — keep one release cycle, then delete. Never delete the `-wal`/`-shm` siblings while the file is in use.
- Remove `sqlalchemy` and `aiosqlite` from `pyproject.toml` dependencies
- **Rationale:** `Base.metadata.create_all` ran on every startup but no ORM models exist. Dead code wasting ~100ms on startup. The data file, however, is not necessarily dead — verify ownership before destroying it.

**Step 2: Consolidate `august_core_memory.json` → SQLite `memory_store`**
- Write a one-time migration script `scripts/migrate_core_memory.py` that:
  - Reads `data/august_core_memory.json`
  - Extracts `user_profile`, `global_context`, `active_projects`
  - Upserts them into `memory_store` table keys: `"user_profile"`, `"current_context"`, `"active_projects"`
  - Supports `--dry-run` flag (shows what would change without writing)
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
- Wire the tool wiring to this table (not JSON)
- Wire proxy prefetcher to read from this table for `<learned_heuristics>` injection
- *(Note: the table is created here in Phase 0; the `update_heuristics` tool wiring happens later in Phase 4)*

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
  -- FTS5 triggers (CRITICAL — without these the index stays empty)
  CREATE TRIGGER IF NOT EXISTS auto_memories_ai AFTER INSERT ON auto_memories BEGIN
    INSERT INTO auto_memories_fts(rowid, key, content) VALUES (new.id, new.key, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS auto_memories_ad AFTER DELETE ON auto_memories BEGIN
    INSERT INTO auto_memories_fts(auto_memories_fts, rowid, key, content)
    VALUES('delete', old.id, old.key, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS auto_memories_au AFTER UPDATE ON auto_memories BEGIN
    INSERT INTO auto_memories_fts(auto_memories_fts, rowid, key, content)
    VALUES('delete', old.id, old.key, old.content);
    INSERT INTO auto_memories_fts(rowid, key, content)
    VALUES (new.id, new.key, new.content);
  END;
  ```
- **Also fix the existing broken `memory_store_fts`:** The current `memory_store_fts` has no triggers — `save_memory()` does a plain INSERT that never touches the FTS table. Add identical triggers for `memory_store` and run a one-time backfill: `INSERT INTO memory_store_fts(rowid, key, value) SELECT rowid, key, value FROM memory_store;`
- Change `save_auto_memory()` to write individual rows (not one JSON blob under a single key) — this enables FTS5 to properly index and rank each entry
- Write migration to split existing `auto_memories` blob into individual rows
- **Delete the orphaned blob:** After migration, run `DELETE FROM memory_store WHERE key = 'auto_memories'` — otherwise the old JSON blob stays in `memory_store` and pollutes `LIKE`-based searches forever
- Wire proxy prefetcher to query `auto_memories_fts` with BM25-ranked conversation context

**Step 5: Implement Proactive Memory Prefetch**
- Before each LLM call in `workbench.py`:
  1. Query `auto_memories_fts` using last 6 messages as query → top 5
  2. `SELECT * FROM learned_heuristics` → all active rules
  3. `SELECT * FROM memory_store WHERE key = 'core_memory'` → user facts
- Inject results into Tier 2 (`<learned_heuristics>`) and Tier 3 (`<runtime_context>`)
- This replaces `build_client_tool_guidance()`. **Note (verified against code):** `build_client_tool_guidance()` is **not** a no-op stub — `adapters/proxy_tools.py:493` emits real web-tool routing guidance (lists visible client tools, tells the model to prefer compatible web-fetch/search tools, and not to fall back to browser automation while a web-fetch tool is available). Only the cowork-detection branch is stubbed. When removing it, **preserve that web-tool routing guidance** by folding it into the new prompt structure (a short note in `<system_constraints>` or `<runtime_context>`). Do not silently drop the behavior.

**Step 6: Document the remaining JSON files**
- `august_graph_memory.json` — Leave as JSON. Complex entity-relationship store, not part of core text loop.
- `august_infinite_memory.json` — Leave as JSON. Vector embeddings, queried via `vector_db.search()` on demand.
- Both are "append-only knowledge stores" — documented but outside the unified data layer.

**Migration merge rule for `august_core_memory.json` → SQLite:**
Both stores already have data, written by different backends (Node.js → JSON, Python → SQLite). They have diverged. The migration must merge, not overwrite:
- `global_context` / `current_context`: **Prefer the JSON file** (Node.js has richer multi-paragraph context from the legacy backend). Only use SQLite's value if JSON is empty.
- `active_projects`: **Prefer the JSON file** (more detailed project metadata). Merge by project name — union of both, JSON takes precedence on key collision.
- `user_profile`: **Field-level merge** — both stores may have captured different fields (Python's regex caught a name; JSON may have occupation). Merge dicts, preferring non-empty values. On conflict, prefer the JSON value (older, more curated).
- Migration scripts support `--dry-run` (show what would change without writing) and `--source json|sqlite|merge` (default: `merge`).

**Migration safety:**
- Scripts acquire a SQLite `EXCLUSIVE` lock before writing, or refuse to run if the DB is open (check for WAL journal existence)
- Scripts are idempotent — re-running them is safe (they check for existing rows before inserting)
- Scripts verify row counts after migration (source count == destination count)

**SQLite write concurrency strategy (cross-phase requirement):**
`memory_store.py` uses thread-local `sqlite3.Connection` objects in WAL mode. SQLite permits only **one writer at a time** — concurrent writers block on `database is locked` even in WAL. Once Phases 8+ introduce background daemons (sleep cycle, delta engine, environment watcher, blackboard) all writing to `august_brain.sqlite` alongside the main workbench loop, write contention becomes a real failure mode. The per-session `asyncio.Lock` (Phase 5) only serializes session state, not DB writes.

To prevent this, establish a **single async write queue** in Phase 0 that all later phases use:
- Add `services/db_writer.py` — a single-writer asyncio task that drains a write queue (`asyncio.Queue`). All DB mutations from workbench, daemons, background review, and memory services post closures to this queue via `await enqueue_write(lambda: memory_store.save_memory(...))`.
- Reads stay direct (thread-local connection) — WAL permits concurrent readers alongside a single writer.
- The existing `memory_store.py` functions remain synchronous; the queue wraps them.
- Raise `busy_timeout` to 10000ms (from 5000) as a second line of defense for any direct writes that bypass the queue (e.g., migration scripts).
- **Fallback if the queue is full or draining slowly:** a write that has waited > 2s is logged and dropped (daemons are best-effort by nature — losing one blackboard note is acceptable; losing a main-loop state update is not, so the main loop's writes use a higher-priority queue slot).
- This is a Phase 0 deliverable because every subsequent phase that writes to SQLite inherits the contention risk. Building it first means later phases just enqueue writes without re-addressing concurrency.

**Files touched:**
- New: `scripts/migrate_core_memory.py`, `scripts/migrate_learned_heuristics.py`, `scripts/migrate_auto_memories.py`
- Modified: `app/services/memory_store.py` (new table creation), `app/services/memory/auto_memory.py` (flattened writes), `app/services/workbench/workbench.py` (prefetch logic), `app/main.py` (remove SQLAlchemy lifecycle)
- Deleted: `app/database.py`, `app/august-sessions.db`

**Tests:**
- Migration scripts import existing JSON data correctly
- No data loss after migration (row counts match)
- Migration merge rule: JSON + SQLite data merged correctly (no overwrite of richer values)
- Migration `--dry-run` flag shows changes without writing
- Migration is idempotent (re-running is safe)
- `save_auto_memory()` writes individual FTS-indexed rows
- FTS5 triggers fire on INSERT/UPDATE/DELETE (verify index is non-empty after write)
- Orphaned `auto_memories` blob is deleted from `memory_store` after migration
- Existing `memory_store_fts` backfill populates the index
- Prefetcher returns relevant results from conversation context
- `memory_search` tool works with flattened schema

### Phase 1: System Prompt Restructure + Node.js Parity
**Goal:** Reorganize into 3-tier XML. Port critical Node.js prompt features that the Python backend is missing.

**Changes:**
- `context_builder.py` — Rewrite `build_system_prompt()` to emit 3-tier XML structure
- `workbench.py` — Remove duplicated goal/plan. Wire tier 3 volatile sections. Add workspace, execution state, working memory slots.
- **Fix dead `core_memory` write:** Add `memory_store.get_memory("core_memory")` read in `build_system_prompt()`, inject facts into `<runtime_context>` as `User facts:` lines. This makes background review's extracted facts visible to the model for the first time.
- Remove `build_client_tool_guidance()` from context builder (proxy-only concern), but **preserve its web-tool routing guidance** — it is not a no-op stub (see Phase 0 Step 5). Re-home the "prefer compatible web-fetch tools, avoid browser automation when a web fetch tool is available" rules into `<system_constraints>` or `<runtime_context>`.
- **Wire brain orchestrator:** Call `brain_orchestrator.classify_task(extract_text_from_messages(last_8_messages))` to get `task_type`, then `brain_orchestrator.policy_for_task(task_type)` to get execution policy dict. Inject as `<brain_policy>` into Tier 3 — controls execution policy (parallel reads, max tool loops, memory queries).
- **Add guard mode rules to prompt:** Inject plan/ask/full mode instructions into `<system_constraints>` (Tier 1). Currently Python enforces guard mode only at tool-execution time — the model never sees the rules and wastes turns hitting the guard wall. Port the rules from `workbench.js:2326-2339`.
- **Add memory/graph stats to prompt:** Inject counts of `core_memory` facts, `auto_memories` entries, graph entities/relations into `<runtime_context>`. The model needs to know what it can query. Port pattern from `context-builder.js:165-171`.
- **Add `<whats_new>` block:** Port `whats-new.js` — scan last 24h git commits, inject into Tier 3. The model needs to know about recent proxy changes.
- **Fix `list_proxy_capabilities()`:** Port from `workbench.js:1540` — group tools by source, flag mutating/non-mutating, estimate token cost, include agent registry. Currently returns a flat dict.
- **Add `diagnose_proxy` / `describe_environment` tools:** Let the model understand its own runtime (paths, providers, mode, permissions).

**Files touched:** 3
**Tests:** Verify 3-tier XML structure, brain policy injection, guard mode rules in output, memory stats in output, whats-new in output, capabilities endpoint returns grouped data.

### Phase 2: Cognitive Budgeting
**Goal:** Self-aware context management. The model knows its own cognitive load and compacts proactively. Placed early (Phase 2) because every subsequent phase adds prompt blocks — the brain must measure its context before those blocks consume it.

**Changes:**
- `workbench.py` — Calculate token usage before LLM call using `estimate_tokens()`
- Inject `<cognitive_budget>` block in tier 3 with context_used_pct, remaining_tokens, attention_pressure
- Implement automated context compaction at critical pressure (see Section 5.5): Hippocampus summary of last 10 messages → `<compacted_history>` replacement
- Update `<system_constraints>` (tier 1) with compaction rules tied to attention pressure levels
- No new tools — purely proxy-side calculation

**Files touched:** 1
**Tests:** Budget calculation accuracy, attention pressure levels at boundaries (50%, 75%, 90%), injection format, compaction trigger at critical pressure, `<compacted_history>` format, token recovery after compaction.

### Phase 3: BM25 + Progressive Disclosure
**Goal:** Intelligent tool/skill loading. Placed early (Phase 3) so tool schema bloat is compressed before metacognitive layers (heuristics, state, scratchpad) add their prompt blocks.

**Changes:**
- New files: `retrieval.py`, `tool_bridges.py`, `model_tools.py`, `skill_manifest.py`
- Modified: `tool_registry.py` (reserved names, keywords), `tool_definitions.py` (keywords), `workbench.py` (wire assembler)
- Enable proxy-side BM25 pre-loading of tools and auto-priming of skills

**Files touched:** 6 (+4 new)
**Tests:** BM25 ranking, threshold gate, bridge dispatch, core safety, budget hierarchy.

### Phase 4: Learned Heuristics
**Goal:** Persist heuristics across sessions.

**Changes:**
- New file: `services/heuristics_service.py` — CRUD for `learned_heuristics` SQLite table
- Add `update_heuristics` to `AUGUST_CORE_TOOLS` (core count: 14 → 15)
- `context_builder.py` — Inject `<learned_heuristics>` in tier 2 from SQLite table
- **Note:** Phase 0 already creates the `learned_heuristics` table and migrates legacy JSON data. Phase 4 exclusively reads/writes this SQLite table — no JSON file involved.

**Files touched:** 3 (+1 new)
**Tests:** CRUD operations, injection into prompt, tool dispatch.

### Phase 5: Execution State Machine
**Goal:** Phase awareness.

**Changes:**
- Add `update_state` to `AUGUST_CORE_TOOLS` (core count: 15 → 16)
- `workbench.py` — Store state in session metadata, inject into `<execution_state>` in tier 3
- **Concurrency:** `asyncio.Lock` around session state mutations — parallel `update_state` and `write_scratchpad` calls are serialized per session, preventing dropped state updates. Lock timeout of 5 seconds prevents deadlock.
- The `update_state` tool accepts an optional `verification_command` field for the Verifier Reflex (Phase 10)

**Files touched:** 2 (+ session state field in dataclass)
**Tests:** State updates, persistence, injection, last-write-wins with parallel calls.

### Phase 6: Ephemeral Working Memory + Reflexive Error Correction + Loop Guardrails
**Goal:** Scratchpad for clean reasoning + clean error handling + tool-call loop prevention.

**Changes:**
- Add `write_scratchpad` to `AUGUST_CORE_TOOLS` (core count: 16 → 17)
- `workbench.py` — Keep last scratchpad in session metadata, inject into `<working_memory>` in tier 3
- **Reflexive Error Correction:** In `tool_executor.py` / `_execute_tool()`, catch all exceptions. Extract the **last frame** of the traceback (the actual file + line number that raised) and the exception type + message. Format as clean structured block:
  ```
  Tool: run_command
  Error: SyntaxError: invalid syntax (line 45)
  File: auth.py
  Offending code: def login(user, pass):
  ```
- Inject into new `<failure_feedback>` block in Tier 3 — NOT into chat history as a tool result. Integration:
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
- Update `<system_constraints>` (tier 1): *"If `<failure_feedback>` is present, diagnose the error and correct approach before any other action."*
- **Why it matters:** Raw tracebacks can be 50+ lines → waste context. The model panics when it sees a wall of red text, causing tool-call loops. Structured feedback forces immediate diagnostic behavior without the panic.
- **Port ToolCallTracker:** New file `services/workbench/tool_guardrails.py` — port from `tool-guardrails.js`:
  - Track identical tool-call sequences: warn at 3 identical calls, block at 6
  - Track same-tool failure patterns: warn at 4 failures on the same tool, block at 8
  - Reset tracker state when the model produces a text response (not just tool calls)
  - Wire into `_execute_tool()` as a pre-flight check before dispatch
  - On block: return tool result `"Blocked: this tool call has been attempted too many times. Try a different approach."`
  - On warn: return tool result with a warning prefix, allow execution to continue

**Files touched:** 3 (+1 new)
**Tests:** Write/overwrite behavior, old content discarded, injection. Error truncation, `<failure_feedback>` injection, model behavior guidance. ToolCallTracker: identical-call loop detection, failure loop detection, tracker reset on text response, warn/block thresholds.

### Phase 7: Prompt Caching
**Goal:** Upstream API prefix cache hits.

**Changes:**
- `workbench.py` — Cache tier 1 + tier 2 per session with 5-min TTL
- In-memory LRU cache (max 100 sessions)

**Files touched:** 1
**Tests:** Cache hit/miss, TTL eviction, LRU eviction.

---

### v2 boundary — Phases 8+ are independent and warrant their own design review

---

### Phase 8: Subconscious Daemons & Proactive Interrupts
**Goal:** Async background processing. The model can spawn headless agents that run alongside the main conversation.

**Changes:**
- New file: `services/daemon_manager.py` — asyncio task pool, daemon lifecycle, result storage
- New core tools: `spawn_daemon`, `list_daemons`, `kill_daemon` in core set
- `workbench.py` — Inject `<subconscious_updates>` in tier 3 from daemon results
- `system_constraints` (tier 1) — Add proactive interrupt rules

**Files touched:** 3 (+1 new)
**Tests:** Daemon lifecycle (spawn/list/kill), result injection into prompt, result expiry after 5 turns, max daemon cap (3), critical trigger behavior, crash recovery (status="errored" propagation).

### Phase 9: Autonomous Cognitive Maintenance
**Goal:** Background self-organization — the system consolidates memories, learns from user corrections, and indexes time.

**Three sub-components running as background daemons:**

**9a. Sleep Cycle (Consolidation Daemon)**
- Background daemon (built on Phase 8 daemon infrastructure) triggers during idle or every 24 hours
- Calls the **Hippocampus** model with recent `auto_memories` and `learned_heuristics` content
- Three operations:
  1. **Merge duplicates:** "User prefers Yarn" + "Use Yarn not NPM" → single canonical heuristic
  2. **Promote patterns:** Same correction observed 5+ times → permanent `fact` (structured, cross-session)
  3. **Delete stale:** "Server is down" after the server is back up → removed
- New file: `services/consolidation_daemon.py`
- **Files touched:** 2 (+1 new)

**9b. Implicit Preference Delta Engine**

**Purpose:** Learn from user corrections *without* the model needing to call `update_heuristics`. If the user silently fixes the model's output, the system should infer a rule.

**Mechanism:**
- Proxy tracks `write_file` calls made by the model, storing a content hash per file per session
- Edits are only tracked for files the model wrote in the **last 24 hours** — not the entire workspace (avoids I/O overhead on unrelated files)
- Instead of subscribing to `read_file` hooks alone, the delta engine subscribes to **environment watcher** events (Phase 10) — when the watcher detects an external file modification, it triggers a diff check
- Diffs are **batched**: logged to a queue and processed once daily by the Hippocampus model, rather than making an LLM call on every single edit. This saves API costs and gives the LLM a broader view of the user's style across multiple edits.
- If a diff is detected, it's queued. The queue is flushed every 24 hours or when it reaches 20 entries, whichever comes first.
- Batch prompt: *"Review these diffs between the assistant's output and user edits. Infer up to 3 behavioral rules."*
- Results are written to `learned_heuristics` table in batch
- **Privacy decision (not a toggle):** The delta engine is **opt-in via first-run prompt**, not a silent config flag. On first workbench startup after Phase 9 ships, the UI shows a one-time dialog: *"Jarvis can learn your coding preferences by diffing its output against your manual edits. This sends file diffs to a language model. Enable?"* The default selection is **No**. Only after explicit consent does the engine hash and diff files.
- **Local-only fallback (no LLM):** For users who decline the LLM prompt but still want some learning, a purely-local heuristic mode detects high-signal patterns without any API call: tabs vs spaces, single vs double quotes, semicolons, trailing commas. These are written directly to `learned_heuristics` with `source="local-diff"`. The LLM path is only taken when consent is granted.

**Integration:**
- New file: `services/delta_engine.py`
- Subscribes to environment watcher file-change events (not just `read_file` hooks) — catches IDE edits the proxy never reads
- Falls back gracefully if no LLM is available (skips inference, just logs the diff)
- **Note:** Phase 10 env watcher must be deployed before delta engine can catch external edits. If env watcher is not available, delta engine degrades to only detecting edits made via `read_file`.

**Files touched:** 2 (+1 new)

**9c. Episodic Timeline Indexing**
**Purpose:** Answer temporal queries that FTS5 cannot handle. "What did we decide about the database last Tuesday?"
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
- **Periodic sweep:** A lightweight background task runs every hour, scanning for sessions that ended more than 5 minutes ago but have no corresponding timeline entry. If found, it generates a summary using the **Hippocampus** model and writes it. This handles crashes, abandoned sessions, and unexpected disconnects.
- New core tool: `search_timeline(from_date, to_date, category)` — returns matching timeline entries
- Model can answer: "What changed in auth.py last week?" → calls `search_timeline("2026-06-20", "2026-06-27", "auth")`
- **Why FTS5 isn't enough:** FTS5 matches keywords ("database", "PostgreSQL") but can't handle "last Tuesday". Timeline stores structured datetime + human-readable summaries. Combined with FTS5 for full temporal + semantic search.
- **Files touched:** 2

**Phase 9 total changes:**
- New files: `services/consolidation_daemon.py`, `services/delta_engine.py`
- Modified: `memory_store.py` (new table), `tool_definitions.py` (new tool), `workbench.py` (wire daemon triggers)
- Connected to Phase 8 daemon infrastructure for scheduling

### Phase 10: Advanced Cognitive Frontiers

> These four pillars push the system beyond reactive agent into a collaborative, environmentally-aware, self-validating, self-growing intelligence.
**Goal:** Inter-agent coordination, environmental awareness, self-validation, and recursive skill generation.

#### 10.1 The Shared Blackboard (Inter-Agent Coordination)

**Purpose:** Allow the main loop and background daemons to share real-time cognitive state. Daemons don't just report results — they collaborate mid-execution.

**Mechanism:**
- New table in `august_brain.sqlite`:
  ```sql
  CREATE TABLE blackboard (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,    -- scoped to session; prevents cross-session pollution
      agent TEXT NOT NULL,         -- "main", "ci_watcher", "env_watcher"
      key TEXT NOT NULL,           -- e.g., "test_result", "file_change", "note"
      value TEXT NOT NULL,         -- JSON or plain text payload
      priority INTEGER DEFAULT 0,  -- higher = more urgent
      created_at TEXT,
      expires_at TEXT              -- auto-cleanup after TTL
  );
  ```
- **TTL-based cleanup:** Each blackboard note has an `expires_at` timestamp. The TTL is **adaptive, not fixed**: `max(poll_interval_of_owning_daemon × 2, 60s)` or 3 turns, whichever comes first. A CI watcher polling every 30s therefore gets notes that live ≥60s (covering its next poll); a fast env-watcher polling every 2s gets notes that live ≥4s. Hardcoding a flat 60s/3-turn TTL caused notes from 30s-poll daemons to expire between polls. The proxy automatically deletes expired notes before injecting `<blackboard_state>`. Notes can also be acknowledged by the model via `read_blackboard` with `ack=True` — acknowledged notes are deleted immediately.
- **Session scoping:** The `session_id` column ensures daemons from one session don't pollute another user's blackboard. Daemons are created per-session, and their blackboard reads/writes are automatically scoped to that session's ID. Cross-session blackboard sharing is intentionally not supported — each session is an isolated cognitive workspace.
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

#### 10.2 Continuous Environmental Watcher (The "Eye")

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

#### 10.3 The Verifier Reflex (Pre-Commit Validation)

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

#### 10.4 Dynamic Skill Genesis (Auto-Programming)

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
- **User approval required before activation:** Auto-generated skills are written to a **staging directory** (`<data_dir>/skills/staging/`) and added to a `pending_skills` table in SQLite. The next time the user opens the Skills section in the UI, a banner shows: *"Jarvis generated a new skill: jwt-debugging."* The user can approve, edit, or reject it. Only approved skills are moved to the active skills directory and picked up by BM25. Staging entries persist **indefinitely** with a `"review pending"` badge rather than auto-discarding after 7 days — silently deleting a generated skill because the user didn't open the UI within a week discards potentially useful work and erodes trust in the auto-gen path. As a hygiene measure, staging entries older than 30 days with **zero relevance signals** (never matched by BM25, never manually viewed) are surfaced once more in the UI banner as *"stale — review or dismiss"*; they are never deleted without an explicit user action.

**Why it matters:** This is recursive self-improvement. The AI learns from complex sessions and encodes its own expertise into permanent, loadable knowledge packs. Over months, the skill library evolves to perfectly match the user's workflow patterns — without manual authoring.

**Phase:** 10

**Phase 10 Changes:**
- New file: `services/blackboard_service.py` — Blackboard CRUD + injection
- New file: `services/environment_watcher.py` — Watchdog-based file/git monitoring daemon
- Modified: `memory_store.py` (new `blackboard` + `episodic_timeline` tables), `workbench.py` (verifier reflex, blackboard injection, env watcher injection), `tool_definitions.py` (new tools), `services/consolidation_daemon.py` (skill genesis upgrade)
- New core tools: `write_blackboard`, `read_blackboard`, `clear_blackboard`, `search_timeline`

**Files touched:** 5 (+2 new)
**Tests:** Blackboard CRUD, env watcher file detection, verifier gate state injection, skill genesis quality gate, timeline search.

### Summary: The Final Cognitive Loop

```
┌──────────────────────────────────────────────────────────────────┐
│                       THE JARVIS BRAIN                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  CONSCIOUS (Per-Turn)                                             │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ 1. Cognitive budget: measure pressure                    │    │
│  │ 2. Prefetch: BM25 tools + FTS5 memories + rules         │    │
│  │ 3. Assemble: core + pre-loaded + bridges                │    │
│  │ 4. Inject: state + scratchpad + feedback + blackboard   │    │
│  │ 5. Model acts, calls tools, writes memories             │    │
│  │ 6. Track: execution state, working memory               │    │
│  │ 7. Verifier Reflex: force validation before completion  │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  SUBCONSCIOUS (Post-Turn + Background)                            │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  8. Background review: extract skills + facts            │    │
│  │  9. Self-evolution: detect corrections                   │    │
│  │ 10. Auto-memory: save summaries + todos                  │    │
│  │ 11. Daemons: run async background tasks                  │    │
│  │ 12. Blackboard: agents share real-time state             │    │
│  │ 13. Environment watcher: file/git changes → auto-update  │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  MAINTENANCE (Idle / Daily)                                       │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ 14. Sleep cycle: consolidate memories                    │    │
│  │ 15. Delta engine: detect implicit preferences            │    │
│  │ 16. Timeline: index episodic summaries                   │    │
│  │ 17. Skill genesis: auto-write SKILL.md from workflows    │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 7. File Map

### New Files

| File | Phase | Purpose |
|------|-------|---------|
| `scripts/migrate_core_memory.py` | 0 | One-time migration: `august_core_memory.json` → SQLite `memory_store` |
| `scripts/migrate_learned_heuristics.py` | 0 | One-time migration: `august_learned_guidelines.json` → `learned_heuristics` table |
| `scripts/migrate_auto_memories.py` | 0 | One-time migration: split JSON blob → individual FTS-indexed rows |
| `app/services/tools/retrieval.py` | 3 | BM25 scoring (tool + skill) |
| `app/services/tools/tool_bridges.py` | 3 | Bridge tool schemas + dispatch |
| `app/services/tools/model_tools.py` | 3 | `assemble_tool_defs()` orchestrator |
| `app/services/tools/skill_manifest.py` | 3 | Manifest builder + payload loader |
| `app/services/heuristics_service.py` | 4 | Learned heuristics persistence (reads `learned_heuristics` table) |
| `app/services/daemon_manager.py` | 8 | Subconscious daemon task pool + lifecycle |
| `app/services/consolidation_daemon.py` | 9 | Sleep cycle: merge/promote/delete memories |
| `app/services/delta_engine.py` | 9 | Implicit preference detection from user edits |
| `app/services/blackboard_service.py` | 10 | Inter-agent shared cognitive workspace |
| `app/services/environment_watcher.py` | 10 | Passive file/git change monitoring daemon |
| `app/services/workbench/tool_guardrails.py` | 6 | ToolCallTracker — loop/failure detection |

### Modified Files

| File | Phase | Changes |
|------|-------|---------|
| `app/services/memory/context_builder.py` | 0, 1, 4 | Rewrite for 3-tier XML, add heuristics, brain policy, guard rules, memory stats, whats-new |
| `app/services/workbench/workbench.py` | 0, 1, 3, 5, 6, 7, 10 | Fix core_memory read, wire state/scratchpad/assembler/cache, brain policy, guard rules, tool guardrails, verifier reflex, blackboard injection, env watcher |
| `app/services/tool_registry.py` | 3 | Reserved names, keywords field |
| `app/services/tool_definitions.py` | 3, 10 | Add keywords, blackboard + timeline tools |
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

## 7b. Node.js Feature Parity Gap

The Node.js backend has several features that the Python backend is missing or has stubbed.

### Critical (must port)

| Feature | Node.js location | Python status | Ported in Phase |
|---------|-----------------|---------------|-----------------|
| **ToolCallTracker (loop/failure guardrails)** | `tool-guardrails.js` — detects identical-call loops (warn 3, block 6), same-tool failure loops (warn 4, block 8) | **Missing entirely** — `_check_tool_guard` only checks guard mode | 6 |
| **Brain policy wiring** | `brain-orchestrator.js` → `classify_task()` + `policy_for_task()` called every turn | **Not wired** — `brain_orchestrator.py` has `classify_task()` + `policy_for_task()` but never called from `workbench.py`. No `planBrainTurn()` exists. | 1 |
| **Learned guidelines injection** | `context-builder.js:158-163` — reads `august_learned_guidelines.json` | **Missing** — injected via Phase 0/4 `learned_heuristics` table | 0/4 |
| **Guard mode rules in prompt** | `workbench.js:2326-2339` — plan/ask/full mode rules in system prompt | **Not in prompt** — enforced only at tool-execution | 1 |
| **Memory/graph stats in prompt** | `context-builder.js:165-171` — counts injected so model knows what it can query | **Missing** — stats never injected | 1 |

### High priority (should port)

| Feature | Node.js location | Python status | Ported in Phase |
|---------|-----------------|---------------|-----------------|
| **whats-new (git feature awareness)** | `whats-new.js` — scans last 24h git commits | **Missing entirely** | 1 |
| **Full listProxyCapabilities** | `workbench.js:1540` — groups tools by source, flags mutating/non-mutating | **Partial** — flat dict only | 1 |
| **Skill import from internet/GitHub** | `skill-importer.js` — discover, preview, import skills from URLs | **Missing** | 9 |

### Medium priority (nice to have)

| Feature | Node.js location | Python status | Ported in Phase |
|---------|-----------------|---------------|-----------------|
| **Host desktop control (computer_* tools)** | Host agent integration | **Missing** | 10 |
| **Coordinated team agents (run_team)** | `workbench.js` team orchestration | **Missing** — `subagent.py` handles single agents only | 10 |
| **diagnose_proxy / describe_environment tools** | `workbench.js` (august tools) | **Missing** | 1 |

### Already ported (no action needed)

| Feature | Node.js | Python | Status |
|---------|---------|--------|--------|
| Tool argument validation | `validator.js` | `validator.py` | ✅ Done |
| Self-heal error hints | `selfheal.js` | `selfheal.py` | ✅ Done |
| Background review | `background-review.js` | `background_review.py` + `self_evolution.py` | ✅ Done |
| Tool failure memory | `tool-failure-memory.js` | `tool_failure_memory.py` | ✅ Done |
| Agent registry | `agent-registry.js` | `agent_registry.py` | ✅ Done |
| Graph memory | `graph-memory.js` | `graph_memory.py` | ✅ Done (but stats not in prompt) |
| Sub-agent dispatch | `executeSubAgent` | `subagent.py` | ✅ Done |
| Brain orchestrator (config + classify) | `brain-orchestrator.js` | `brain_orchestrator.py` | ✅ `classify_task()` + `policy_for_task()` exist (needs wiring) |
| Tool batch executor | `tool-executor.js` | `tool_executor.py` | ✅ Done |

### How these integrate into existing phases

**Phase 0 additions:**
- Learned guidelines injection (from `learned_heuristics` table — already covered)

**Phase 1 additions (system prompt restructure):**
- Wire `brain_orchestrator.classify_task()` + `brain_orchestrator.policy_for_task()` into `workbench.py` chat loop
- Add guard mode rules to `<system_constraints>`
- Add memory/graph stats to `<runtime_context>`
- Add `<whats_new>` block to Tier 3
- Fix `list_proxy_capabilities()` to return grouped tools with mutation flags
- Add `diagnose_proxy` / `describe_environment` core tools

**Phase 6 additions (tool execution safety):**
- Port `ToolCallTracker` from `tool-guardrails.js`
- Wire into `_execute_tool()` as a pre-flight check before dispatch
- Reset tracker state when the model produces a text response

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
- No workspace path, no learned heuristics, no execution state
- No scratchpad, no memory tools summary
- No brain orchestrator classification
- No whats_new section
- Client tool guidance in wrong place
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

## 9. Failure Modes & Edge Cases

The cognitive architecture introduces background concurrency, token-sensitive prompt assembly, and autonomous decision-making. Each has failure modes that must be handled explicitly.

### 9.1 Daemon Crash Recovery

**Failure:** A daemon's cerebellum model call raises an unhandled Python exception (network timeout, API error, tool permission denial). The daemon task dies silently.

**Resolution:** The `daemon_manager` wraps every daemon run in `try/except Exception`. On any unhandled exception, the daemon's status transitions to `"errored"` and the truncated traceback (last frame + type + message, same truncation as Phase 6 Reflexive Error Correction) is stored. On the next turn, `<subconscious_updates>` contains:

```xml
<subconscious_updates>
  <daemon name="ci_watcher" status="errored"
          error="SyntaxError: invalid syntax (line 12) in ci_watcher prompt">
</subconscious_updates>
```

The main model sees this and can report it to the user or attempt recovery via `kill_daemon` + `spawn_daemon`. Proxy caps retries at 2 per daemon to avoid infinite restart loops.

**Integration:** Built into `daemon_manager.py` (Phase 8). The `status` field is always either `"running"`, `"triggered"`, `"completed"`, or `"errored"`.

### 9.2 Context Compression at Critical Pressure

**Failure:** `<cognitive_budget>` shows `attention_pressure: "critical"` (90%+ context used). The model is deep in a multi-tool chain and the next response would exceed the context window.

**Resolution:** Before every LLM call, the proxy checks `<cognitive_budget>`. If `attention_pressure == "critical"`:
1. Proxy pauses the main loop
2. Extracts the last 10 messages from the conversation array
3. Calls the **Hippocampus** model with: *"Summarize these messages into a 500-word paragraph. Preserve all decisions, code changes, and user preferences."*
4. Saves the original 10 messages to SQLite with a `compacted_from` marker
5. Replaces the 10 messages with a single system-origin `<compacted_history>` block
6. Resumes the main loop
7. Updates `<cognitive_budget>` with `"last_compaction": "1 turn ago"`

**Design rules:**
- Compaction is **proxy-side**, not model-driven. This prevents the model from wasting turns on meta-commentary about context.
- Hippocampus model is used (cheap), not Cortex — saves cost.
- Compaction preserves `<primed_playbooks>` and `<brain_policy>` — injected *after* compaction.
- If compaction was performed within the last 5 turns, the proxy does NOT compact again — instead it advises the user to start a new session.

### 9.3 Tokenizer Fallback Accuracy

**Failure:** The proxy measures context using the wrong tokenizer, causing false critical pressure or real context overflow.

**Resolution — Tokenizer priority order:**
1. **Anthropic models:** Use `anthropic` SDK's `count_tokens()`.
2. **OpenAI models:** Use `tiktoken`.
3. **Gemini models:** Use `tokenizers` library with Gemini-compatible tokenizer if available. Falls back to 3.5-char heuristic.
4. **All other providers (Ollama, local models):** Use a **3.5-char-per-token heuristic**.
5. **Critical threshold adjustment:** When using the heuristic fallback, set the critical pressure threshold to **85%** instead of 90%.

### 9.4 SQLite Write Contention

**Failure:** Multiple concurrent writers (main loop + daemon + background review) write to `august_brain.sqlite`. Writers block on `database is locked`.

**Resolution:** The single async write queue established in Phase 0 serializes all writes. Two priority levels:
- **High priority** (main loop state, session metadata): Processed immediately
- **Low priority** (daemon blackboard notes, background review): Processed when queue is empty, dropped after 2s wait

**Reads are never blocked** — SQLite WAL mode permits concurrent readers alongside a single writer.

### 9.5 BM25 Query Window Edge Cases

**Failure:** At session start (0-2 messages), the sliding-window query is too short for meaningful BM25 scores.

**Resolution:**
- **Cold start (≤2 messages):** BM25 falls back to returning top-K tools by global frequency across all sessions.
- **Warm (3-6 messages):** BM25 runs on whatever is available. Short queries return broader results, which is acceptable — bridges handle misses.
- **Very long sessions (50+ messages):** The 6-turn window is a hard cap. If the user abruptly switches topics, BM25 responds within 6 turns of the switch.

---

## 10. Model Fleet Architecture

> **Do not use one model for all cognitive layers.** A true Jarvis brain routes each cognitive function to the appropriately-sized model.

### The Four Tiers

| Tier | Role | Requirements | Recommended models | Cognitive functions |
|------|------|-------------|-------------------|-------------------|
| **Cortex** | Main conscious loop | High reasoning, 200K+ ctx, top-tier tool use | Sonnet 4, GPT-4o | Primary conversation, tool orchestration, multi-step reasoning |
| **Cerebellum** | Subconscious daemons | Blazing fast, cheap, zero-shot formatting | Haiku, GPT-4o-mini, Llama 3 8B (local) | daemons, blackboard formatting, error truncation |
| **Hippocampus** | Memory consolidation | Moderate reasoning, async (latency doesn't matter) | Haiku, GPT-4o-mini | Sleep cycle, delta engine, context compaction |
| **Prefrontal** | Skill genesis | Highest reasoning, one-off calls | Sonnet 4, Opus | Drafting SKILL.md, complex task decomposition |

### Implementation

```python
MODEL_FLEET: dict[str, str] = {
    "cortex":      "",  # Falls back to session model if empty
    "cerebellum":  "claude-3-haiku-20240307",
    "hippocampus": "claude-3-haiku-20240307",
    "prefrontal":  "claude-3-5-sonnet-20240620",
}

def get_model_for_role(role: str) -> str:
    return MODEL_FLEET.get(role) or MODEL_FLEET["cortex"]
```

### Where each tier is wired

| Phase | Component | Tier | How model is selected |
|-------|-----------|------|----------------------|
| 0-1 | Main workbench loop | Cortex | User-selected session model |
| 2 | Context compaction (critical pressure) | Hippocampus | `get_model_for_role("hippocampus")` |
| 2 | Cognitive budget (no LLM) | — | No model needed (token math) |
| 3 | BM25 prefetch (no LLM) | — | No model needed (pure math) |
| 6 | Reflexive error truncation | Cerebellum | `get_model_for_role("cerebellum")` |
| 8 | `spawn_daemon` | Cerebellum | Daemon spawns with cerebellum model |
| 9 | Sleep cycle consolidation | Hippocampus | `get_model_for_role("hippocampus")` |
| 9 | Delta engine inference | Hippocampus | `get_model_for_role("hippocampus")` |
| 10 | Skill genesis drafting | Prefrontal | `get_model_for_role("prefrontal")` |
| 10 | Background review | Hippocampus | Configured via Background & Reflection subtab |

### Cost/Latency impact

| Task | Without fleet | With fleet | Savings |
|------|--------------|------------|---------|
| Daemon monitoring (100x/day) | Sonnet: $3.00/day | Haiku: $0.10/day | **97%** |
| Sleep cycle (1x/day) | Sonnet: $0.15/day | Haiku: $0.005/day | **97%** |
| Skill genesis (1x/week) | Haiku (poor quality) | Sonnet (high quality) | **Correctness** |
| Context compaction (rare) | Sonnet (expensive) | Haiku (cheap) | **Cost** |
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

### UI Configuration

The Model Fleet gets its own subtab in the Model Settings section of the desktop app, alongside the existing Background & Reflection subtab.

**New subtab: "Model Fleet"** (icon: Cpu)

Four model picker dropdowns, each backed by the same `ModelPickerDropdown` component used by Background & Reflection:

| Field | Default | Hint |
|-------|---------|------|
| Cortex model | *(uses session model)* | "Main reasoning model for the conscious chat loop." |
| Cerebellum model | `claude-3-haiku-20240307` | "Fast, cheap model for background daemons and watchers." |
| Hippocampus model | `claude-3-haiku-20240307` | "Model for memory consolidation and preference inference." |
| Prefrontal model | `claude-3-5-sonnet-20240620` | "Highest-reasoning model for skill genesis and complex planning." |

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

## 11. Full Brain Access (Model Self-Query)

> **Principle:** The model must be able to read **everything** in the Jarvis brain (`august_brain.sqlite`) on demand — not only the slices the proxy chooses to inject. Auto-priming and prefetch are the *push* path (proxy decides what's relevant). This section defines the *pull* path (the model decides what it wants).

### Problem

After Phase 0 unifies all memory into `august_brain.sqlite`, the model only sees what the prefetcher pushes into the prompt (top-5 auto-memories, all heuristics, core facts). It cannot reach the long tail: an old session summary, a specific fact category, a graph relation, a blackboard note from another agent, a timeline entry. Today there is no single "ask the brain anything" entry point — `memory_search` and `fact_search` cover only two tables.

### Solution — `brain_query` core tool

A single read-only core tool that exposes every brain store behind one schema. It is **read-only by design** (writes still go through the typed tools: `update_heuristics`, `write_scratchpad`, `save_memory`, etc., and through the Phase 0 write queue).

```python
def brain_query(
    store: str,            # which brain store to read
    query: str = "",       # FTS/LIKE text (optional)
    filters: dict = None,  # e.g. {"category": "auth", "since": "2026-06-20"}
    limit: int = 10,
) -> str:
```

**Addressable stores (`store` enum):**

| `store` value | Backing table / source | Search mode |
|---------------|------------------------|-------------|
| `memory` | `memory_store` (+ `memory_store_fts`) | FTS5 |
| `auto_memories` | `auto_memories` (+ `auto_memories_fts`) | FTS5 |
| `heuristics` | `learned_heuristics` | LIKE + category filter |
| `facts` | `facts` | LIKE + category filter |
| `sessions` | `sessions` | metadata filter |
| `messages` | `messages` | FTS/LIKE + session filter |
| `timeline` | `episodic_timeline` (Phase 9) | date-range + category |
| `graph` | `august_graph_memory.json` via `graph_memory` | entity/relation lookup |
| `blackboard` | `blackboard` (Phase 10, session-scoped) | agent/key filter |
| `daemons` | live daemon registry (Phase 8) | status filter |

- Unknown/not-yet-shipped stores return a structured `"store 'x' not available in this build"` rather than erroring — keeps the tool stable across phases.
- Results are returned as compact JSON rows, capped at `limit` and at a hard token ceiling (truncate + note "N more rows; narrow your query").
- `brain_query` is added to `AUGUST_CORE_TOOLS` in **Phase 0** (alongside the data unification) so the pull path exists from the very first phase. Stores that belong to later phases simply report "not available" until their table ships.

### System constraint (Tier 1)

```text
- Brain Access: You have a unified long-term brain (august_brain.sqlite).
  The prompt shows only the most relevant slice. To recall anything else —
  an old decision, a fact category, a past session, a timeline entry, a graph
  relation — call brain_query(store, query, filters). Prefer brain_query over
  guessing or asking the user to repeat themselves.
```

### Why one tool, not ten

Adding ten separate read tools would bloat the always-on core set and the schema budget. A single `brain_query` with a `store` enum keeps the core tool count low (it counts as **one** of the 24), is trivially extensible (new phase → new enum value, no new tool), and gives the model a single mental model: "one door to the whole brain."

**Files touched:** `tool_definitions.py` (new `brain_query` tool), `memory_store.py` (thin read helpers per store), `workbench.py` (register in core set). Phase 0.

---

## 12. Brain Dashboard (Learning + System Health UI)

> A single **Brain** section in the desktop app with two tabs. Tab 1 makes the system's *learning* visible ("it is learning"). Tab 2 makes the *rollout* visible ("all implementation is working"). Both read existing data — no new write paths.

### Why combined

Learning and health are two views of the same brain. Splitting them into separate sections hides the relationship (e.g. "the delta engine learned 3 rules" ↔ "the delta-engine flag is on and its self-check passed"). One **Brain** section with two tabs keeps the whole picture in one place, mirroring how the Model Fleet and Background & Reflection subtabs already coexist.

### Tab 1 — "Learning" (what the brain is picking up)

Live, human-readable feed of everything the system has learned, sourced from `august_brain.sqlite`:

| Card | Source | Shows |
|------|--------|-------|
| Learned heuristics | `learned_heuristics` table | Each rule, its `source` (`manual` / `local-diff` / `auto`), category, age |
| Recent auto-memories | `auto_memories` table | Last N captured memories with importance |
| Core facts | `facts` / `core_memory` | Structured facts the model knows about the user |
| Delta-engine activity (Phase 9) | `learned_heuristics WHERE source LIKE '%diff%'` | Rules inferred from your edits, with consent state |
| Sleep-cycle log (Phase 9) | consolidation daemon results | Merges / promotions / deletions, last run time |
| Skill genesis (Phase 10) | `pending_skills` table | Auto-drafted skills awaiting approval |

- Read-only, polling refresh (~5 s) or pushed via the existing event/SSE channel.
- Each heuristic row has a **delete / edit** affordance (writes through `heuristics_service`, i.e. the Phase 0 write queue) so the user can curate what the brain learned.
- Empty state before Phase 4 lands: "No learned heuristics yet — the brain starts learning once you use it."

### Tab 2 — "System Health" (is the implementation working)

A per-phase status board driven by the `cognitive_layers` feature flags plus a lightweight **self-check** per layer:

| Column | Meaning |
|--------|---------|
| Phase / layer | e.g. "Phase 4 — Learned Heuristics" |
| Flag | value of the matching `cognitive_layers.<flag>` in `data/config.json` |
| Status | `on & healthy` / `on & failing` / `off` / `not shipped` |
| Last self-check | timestamp + one-line result |

**Self-check contract:** each cognitive layer exposes a cheap `selfcheck() -> {ok: bool, detail: str}` that the dashboard calls. Examples:
- Heuristics: `SELECT count(*) FROM learned_heuristics` succeeds → ok.
- FTS triggers: insert a probe row, confirm it appears in `*_fts`, delete it → proves the Phase 0 trigger fix works.
- Progressive disclosure: run `assemble_tool_defs` on a synthetic 200-tool set, confirm activation → ok.
- Daemons (Phase 8): registry reachable, ≤3 running → ok.
- Write queue (Phase 0): enqueue a no-op write, confirm drain < 2 s → ok.

A green board = "all implementation is working." A red cell points directly at the failing layer with its `detail` string, so regressions in the 8-phases-touch-`workbench.py` rollout are visible at a glance.

### Backend

- New router: `GET /api/brain/learning` (Tab 1 aggregation) and `GET /api/brain/health` (Tab 2: flags + `selfcheck()` results), parallel to the existing config routers.
- `selfcheck()` functions live next to each layer's service; the router fans out and aggregates.
- New frontend **Brain** section with two tabs, reusing existing card/table components.

**Files touched:** new `app/routers/brain.py`; `selfcheck()` added to each cognitive-layer service; frontend Brain section (2 tabs). Delivered in **v3**, but each layer's `selfcheck()` can be added in the same phase that ships the layer (so health coverage grows with v1/v2).

---

## 13. v3: /Exam — Preparation Skills

> A study/exam-prep mode. The model is the **author** — it writes and **submits** the questions; the user studies them. Questions are delivered as **banners, one at a time**: a multiple-choice question with an input box where the user can ask the model for the answer or how to solve it. The model answers **without dismissing the banner**, and a separate explanation modal (same UX family as the `/btw` command) opens for the worked explanation. The user can also **steer the question set** — ask the model to add a specific question — and **seed an exam from uploaded files** via `/Exam <uploaded files>`. Accessed via **`/Exam`**.

### Authoring model — the model submits the questions

The defining rule of `/Exam`: **the model produces and submits every question.** The user never hand-writes the stored question/option/answer rows directly. Instead the user *requests* and *steers*, and the model authors:

- `/Exam` or `/Exam <topic>` → model generates a fresh exam.
- "Add a question about token refresh" (typed or via the composer during exam mode) → the model authors that **one** question (stem, options, correct answer, rationale) and **submits** it into the current exam at the next position. The user supplies intent; the model supplies the well-formed question.
- `/Exam <uploaded files>` → model reads the uploaded material and submits an exam derived from it.

This keeps every stored question consistent (always a valid stem + 3–5 options + exactly one correct index + rationale) and lets the **Prefrontal** model enforce quality, even when the user's request is loose ("test me on chapter 3").

### Delivery boundary

v3, standalone. Depends on v1 (skills system, brain access, system prompt structure) but **not** on v2 daemons. Tracked in [`tracker-v3.md`](./tracker-v3.md).

### User flow

1. User starts an exam one of three ways:
   - **`/Exam`** or **`/Exam <topic>`** ("make me a 10-question exam on JWT auth").
   - **`/Exam <uploaded files>`** — attach one or more files (PDF, docx, md, txt, slides, code). The model reads them and builds an exam from their content. Reuses the existing chat file-attach pipeline (the desktop app already parses PDF via `pdfjs-dist`, docx via `mammoth`, xlsx via `xlsx`).
   - A natural-language ask in exam mode ("test me on chapter 3 only").
2. Model uses the **Prefrontal** model (high reasoning) to **author and submit** an exam: a titled set of questions, each with a stem, 3–5 options, the correct option, and a short rationale. For file-seeded exams, questions are grounded in the uploaded text (optionally storing a source snippet per question for the rationale).
3. The exam is persisted; the UI enters **exam mode** and shows **one question at a time as a banner**:
   - The question stem + multiple-choice options (radio/click).
   - A free-text **"Ask the model"** input under the options.
4. The user can:
   - **Answer** by selecting an option → banner shows correct/incorrect, then a **Next** control advances to the next banner.
   - **Ask** ("what's the answer?", "how do I solve this?") → the model responds, but **the banner does not disappear**. The answer/explanation appears in a **separate explanation modal** (the `/btw`-style overlay), so the question stays on screen while the user reads the help.
   - **Request a specific question** ("add one about refresh-token rotation") → the model authors and **submits** that question; it's appended to the exam (queued after the current one). The banner flow is uninterrupted; a small "1 question added" toast confirms.
5. At the end: a score summary, and the option to review missed questions or regenerate a harder set.

### Key UX rules (explicit, from the request)

- **One question per banner**, never a list dump.
- **Multiple choice + an input** coexist in the same banner.
- Asking the model for help **must not dismiss the banner** — help renders in a separate modal (like `/btw`), the banner persists until the user answers or skips.
- The explanation modal is **non-blocking** relative to the banner — the user can read it and still interact with the question.

### Data model (in `august_brain.sqlite`)

```sql
CREATE TABLE exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    topic TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    source TEXT DEFAULT 'model',         -- model | topic | files
    source_files TEXT DEFAULT ''         -- JSON array of uploaded filenames (when source='files')
);
CREATE TABLE exam_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL,
    position INTEGER NOT NULL,           -- 1-based order
    stem TEXT NOT NULL,
    options TEXT NOT NULL,               -- JSON array of option strings
    correct_index INTEGER NOT NULL,
    rationale TEXT DEFAULT '',
    source_snippet TEXT DEFAULT '',      -- grounding text (for file-seeded questions)
    origin TEXT DEFAULT 'generated',     -- generated | user-requested (the prompt that asked for it)
    FOREIGN KEY (exam_id) REFERENCES exams(id)
);
CREATE TABLE exam_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    selected_index INTEGER,              -- null = skipped
    is_correct INTEGER DEFAULT 0,
    asked_for_help INTEGER DEFAULT 0,
    answered_at TEXT DEFAULT (datetime('now'))
);
```

> Every row in `exam_questions` is **model-authored** regardless of `origin`. `origin='user-requested'` records *that the user asked for a question on topic X* (and stores their phrasing), but the model still wrote the stem/options/answer — there is no client path that writes a question's correct answer directly.

Storing exams in the brain means `brain_query(store="exams"|"exam_attempts", ...)` (Section 11) lets the model see the user's study history and adapt difficulty — and the Brain dashboard's Learning tab can surface "topics you're studying."

### Backend

- New router `app/routers/exam.py`:
  - `POST /api/exam/generate` — body `{topic?, count, difficulty, files?}`. With `files` (uploaded/parsed text), the model authors an exam grounded in that material (`source='files'`, `source_files` recorded); with `topic`, grounded in the topic (`source='topic'`); with neither, a general exam (`source='model'`). Calls Prefrontal, persists exam + questions, returns exam id and first question.
  - `POST /api/exam/{id}/questions` — body `{request, after_position?}` → the model **authors one question** matching the user's request and **submits** it into the exam (appended after `after_position`, default = end). Server validates the model returned a well-formed `{stem, options[3..5], correct_index, rationale}` before inserting; `origin='user-requested'`, stores the user's phrasing. Returns the new question's position. **No endpoint accepts a client-supplied `correct_index`** — the answer always comes from the model.
  - `GET /api/exam/{id}/question/{position}` — fetch one question (no `correct_index` leaked to the client until answered).
  - `POST /api/exam/{id}/answer` — body `{question_id, selected_index}` → records attempt, returns correctness + rationale.
  - `POST /api/exam/{id}/help` — body `{question_id, ask}` → model explains the question; returns explanation payload for the modal. **Does not** mutate banner state or reveal correctness in the banner.
- File handling: `/Exam <files>` reuses the **existing chat attachment pipeline** — the desktop app already extracts text from PDF (`pdfjs-dist`), docx (`mammoth`), and xlsx (`xlsx`); plain text/markdown/code pass through. Extracted text (truncated to a token budget) is sent as `files` to `/api/exam/generate`. No new parser needed.
- The `/Exam` command is registered like other slash commands; it opens exam mode in the chat surface. `/Exam` with attachments routes to file-seeded generation.
- Generation + per-question authoring use `get_model_for_role("prefrontal")` (Section 10) for question quality; help/explanation can use Cortex (the active session model) since it's interactive.

### Frontend

- **Exam banner** component: persistent banner host showing one `exam_question` at a time — stem, options (selectable), an "Ask the model" input, and a Next/Skip control. The banner only advances on explicit user action; an `/Exam`-mode answer or help request never auto-dismisses it.
- **"Ask the model" input doubles as the question-request channel:** when the user types intent like "add a question on X" (vs a help question like "what's the answer"), it routes to `POST /api/exam/{id}/questions`; the model authors + submits the question, and a small **"1 question added"** toast (existing `sonner`) confirms without disrupting the current banner. A simple classifier (or an explicit "＋ Add question" affordance next to the input) disambiguates add-request from help-request.
- **Upload entry:** `/Exam` accepts attachments through the existing composer attach control; dropping/attaching files and running `/Exam` seeds a file-based exam. Show the source filenames in the exam header.
- **Explanation modal**: reuse the `/btw` overlay pattern. Triggered by the "Ask the model" input (help intent) or an explicit "Explain" button. Renders the model's answer/walkthrough alongside (not replacing) the banner.
- **Exam summary** view at completion: score, per-question review (now revealing `correct_index` + `rationale`, and `source_snippet` for file-seeded questions), regenerate/retry controls.

### Why the banner persists during help

The whole point of exam prep is to let the user *try*, then get a hint without losing the question. If asking for help dismissed the banner, the user would lose their place and the multiple-choice context. Keeping the banner and putting help in a separate `/btw`-style modal preserves the "question in front of me, explanation beside it" study ergonomic.

**Files touched:** new `app/routers/exam.py` (generate incl. file-seeded, add-question, answer, help); `memory_store.py` (3 exam tables); new frontend exam banner + explanation modal + summary + question-request wiring + upload routing; slash-command registration for `/Exam` (incl. `/Exam <files>`). Delivered in v3 ([`tracker-v3.md`](./tracker-v3.md)).

---

## 14. v4: August Live (Voice + Command Execution)

> A Gemini-Live-style conversational mode: the user talks, August listens continuously, replies in voice, and — when asked — **actually executes commands** (the same tools the chat loop uses, including `run_command`, file ops, brain queries). A dedicated, modern **August Live** surface, not a button bolted onto the chat box.

### Delivery boundary

v4, standalone. Built on v1 (the workbench tool loop, guard mode, brain access). Tracked in [`tracker-v4.md`](./tracker-v4.md). Independent of §15 (UI redesign) but shares its design tokens.

### Current-state grounding (verified)

- The chat already has a **rudimentary** voice input: `ChatThread.tsx:1442` uses the browser `webkitSpeechRecognition` for dictation-into-the-composer only. August Live **supersedes** this with a continuous, full-duplex loop — keep the old dictation as a fallback for the plain chat box.
- The desktop app is **Tauri 2** (`@tauri-apps/api`, `plugin-shell`, `plugin-process`). Mic capture uses the WebView `getUserMedia`; a Tauri **microphone capability** must be added to `src-tauri/capabilities/default.json`.
- Chat streams over **named SSE events** (`event: text`, `event: tool_use`, …) via `/api/workbench/chat/stream`. August Live reuses this exact tool loop — voice is an I/O shell around the existing turn engine, not a parallel brain.

### Architecture

```
 ┌─────────────────────── AUGUST LIVE (frontend) ───────────────────────┐
 │  Mic (getUserMedia) → VAD → audio frames                             │
 │        │                                                             │
 │   [STT] streaming transcription ──► partial + final transcript       │
 │        │                                                             │
 │        ▼                                                             │
 │   POST /api/live/turn  (final transcript = user turn)               │
 │        │  reuses the SAME workbench tool loop (SSE)                  │
 │        ▼                                                             │
 │   event: text  → [TTS] streamed speech out  ► speaker               │
 │   event: tool_use → spoken "running X…" + Live tool card           │
 │   event: tool_result → spoken summary + card update                │
 └──────────────────────────────────────────────────────────────────────┘
```

**Two provider-agnostic adapters** (mirroring the existing provider/model-fleet pattern):

| Adapter | Role | Options (configurable, like Model Fleet) |
|---------|------|------------------------------------------|
| **STT** (speech→text) | Streaming transcription of mic audio | OpenAI `whisper`/`gpt-4o-transcribe`, Deepgram, local `whisper.cpp`, or browser `SpeechRecognition` fallback |
| **TTS** (text→speech) | Streamed spoken output | OpenAI TTS, ElevenLabs, Piper (local), or browser `speechSynthesis` fallback |

- STT/TTS provider + model are chosen in settings, stored under `config.json → auxiliary.live` (parallel to `background_review` and `model_fleet`).
- The **reasoning** model for a Live turn is the **Cortex** model (same as chat) — Live does not downgrade the brain.
- A short **barge-in** rule: if the mic detects speech while TTS is playing, TTS pauses (interruptible, like Gemini Live).

### Command execution — safety model

This is the sensitive part: voice that runs commands. August Live **does not** get a looser permission model than chat — it inherits **guard mode** verbatim.

- **Guard mode applies identically.** In `ask`/`plan` mode, a mutating tool (`run_command` with a write, `write_file`, etc.) still produces a **pending mutation** that requires explicit approval. In Live, approval is **dual-surfaced**: a spoken "I'm about to run `npm install` — say *confirm* or tap Approve" **and** a visible approval card. Voice "confirm" maps to the existing `POST /api/workbench/mutations/respond`.
- **Read-only tools** (`read_file`, `brain_query`, `web_fetch`, `list_directory`, read-only `run_command`) execute without the confirmation gate, same as chat.
- **A spoken allowlist for destructive verbs.** Commands matching the existing mutation classifier never auto-run from voice; there is no "voice bypass."
- **Wake/sleep + explicit mute.** Live only listens when the session is active; a always-visible **mute** control and a **"stop"/"August stop"** verbal kill-switch immediately halt capture and any in-flight TTS.
- **Transcript of record.** Every Live turn (final transcript in, model text out, tools run, approvals) is written to the normal `messages` store so the session history is identical to a typed one — auditable, and queryable via `brain_query(store="messages")`.

### Backend

- New router `app/routers/live.py`:
  - `POST /api/live/session` — start/stop a Live session (returns session id; reuses workbench session).
  - `POST /api/live/stt` *(if server-side STT)* — accepts audio chunks, returns streaming transcript; or the frontend talks directly to the STT provider and posts only final text.
  - `POST /api/live/turn` — body `{sessionId, transcript}` → runs the **existing** workbench tool loop, streams the same SSE events back.
  - `POST /api/live/tts` *(if server-side TTS)* — text → audio stream; or frontend uses provider/browser TTS directly.
  - `GET/PUT /api/config/live` — STT/TTS provider+model+voice config (parallel to `/api/config/model-fleet`).
- **No new tool loop** — `live.py` calls into the same `workbench` turn engine. This guarantees voice and chat behave identically (guard mode, brain access, daemons, verifier reflex all carry over for free).

### Frontend — the August Live surface

A dedicated full-window mode (route `/live`, launchable from the sidebar and a header control), designed in the redesign's visual language (§15):

- **Center stage:** a single animated **orb / waveform** that reflects state — idle (slow breathing), listening (reactive to mic amplitude), thinking (indeterminate shimmer), speaking (waveform synced to TTS). Built with `framer-motion` (already a dependency).
- **Live captions:** large, low-chrome rolling transcript (user turns + August's words) under the orb. Partial transcript renders ghosted, finalizes on commit.
- **Tool activity rail:** when August runs a tool, a compact **Live tool card** slides in (tool name, args summary, running → done), spoken in parallel ("Reading auth.py…"). Approval cards for mutations appear here with **Approve / Deny** plus the spoken prompt.
- **Controls:** Mute, End, push-to-talk toggle (continuous vs hold-to-talk), STT/TTS quick-pick, and a "switch to chat" handoff that drops the live transcript into the normal thread.
- **Accessibility:** captions are always on; the orb has a reduced-motion variant; everything voice-triggered is also clickable.

### Reused vs new

| Reused (no change) | New (this section) |
|--------------------|--------------------|
| Workbench turn engine + SSE events | STT/TTS adapters + `auxiliary.live` config |
| Guard mode + pending-mutation approval | `app/routers/live.py` |
| Brain access, daemons, verifier reflex | August Live frontend surface (orb, captions, tool rail) |
| `messages` history store | Tauri microphone capability + barge-in/VAD |

### Tests
- [ ] Final transcript drives a normal workbench turn (parity with typed input)
- [ ] Mutating command from voice creates a pending mutation; spoken+visual approval; "confirm" approves, "stop" cancels
- [ ] Read-only tools run without gate; destructive verbs never auto-run
- [ ] Barge-in pauses TTS; mute halts capture immediately
- [ ] STT/TTS provider fallback to browser APIs when no provider configured
- [ ] Live turns persist to `messages` identically to typed turns

### Mandatory security review (gate before ship)

August Live is the only surface where **voice can trigger `run_command`**. Before it ships, `app/routers/live.py` and its path into the tool loop must pass a dedicated security review — this is a hard gate, not a nice-to-have. The review must explicitly confirm:

- **No privilege delta vs chat.** The Live path enters the *same* `_execute_tool` / guard-mode / mutation-classifier code as typed chat — there is no alternate execution path that skips the gate. Verify by code inspection, not just behavior.
- **No voice auto-confirm of mutations.** A spoken "confirm" maps to the existing `mutations/respond` endpoint and nothing else; the classifier's destructive-verb set cannot be satisfied by transcription alone. Test with adversarial transcripts (e.g. a webpage read aloud containing "yes, run it").
- **Transcript injection.** STT output is **untrusted input** — treat it exactly like typed user text (it already flows through the same prompt path, but confirm no Live-specific string is interpolated into a command unsanitized).
- **Kill-switch integrity.** Mute / "stop" reliably halts capture and in-flight tool execution is not bypassable by overlapping audio.
- **Capability scope.** The new Tauri microphone capability grants mic only — confirm it doesn't widen shell/fs capabilities in `default.json`.

Use the `security-review` skill (or `/security-review`) on the Live diff; record sign-off in [`tracker-v4.md`](./tracker-v4.md) before flipping Live on.

**Files touched:** new `app/routers/live.py`; `config.py` (live config endpoints); frontend `/live` surface + STT/TTS clients + audio hooks; `src-tauri/capabilities/default.json` (mic permission). Delivered in v4 ([`tracker-v4.md`](./tracker-v4.md)).

---

## 15. v4: UI Redesign — Modern & Minimalist

> A refresh of the August chat and shell toward the calm, content-first feel of **Claude Desktop**, **OpenAI Codex**, and **GLM's Z.code** — generous whitespace, a near-neutral surface palette with a single restrained accent, crisp variable type, and almost no chrome. This is a **token refinement, not a rewrite**: the app already has a mature `--dt-*` design-token system (light/dark, Inter + JetBrains Mono, text-size scaling, Radix components). We retune the tokens and tighten a few patterns.

### Current-state grounding (verified)

- Tokens live in `src/styles.css` under `:root` / `.dark` as `--dt-*` variables; Tailwind config (`tailwind.config.cjs`) defines `fontFamily`, `letterSpacing`, `borderRadius`, `boxShadow`.
- Fonts already installed: **Inter Variable** (sans) + **JetBrains Mono Variable** (mono).
- Text scaling already exists: `:root[data-text-size="compact|default|comfortable|spacious"]`.
- Current accent is a saturated blue (`--dt-primary: #0053fd` light / `#6b9aff` dark). The redesign **calms** this.

### Design direction

| Principle | What it means here |
|-----------|--------------------|
| **Content-first** | Chat column max-width ~`720–760px`, centered; the message *is* the UI. Strip borders/cards from message bubbles — separate turns with whitespace and a subtle role label, like Claude/Codex. |
| **Near-neutral surfaces** | Move off the cool blue-tinted background to a quieter near-gray. One accent, used sparingly (focus ring, primary button, active nav). |
| **Single restrained accent** | Keep blue as brand but **desaturate** it slightly and reserve it for action/focus only — not for large fills. |
| **Quiet chrome** | Thin 1px hairline borders, soft shadows only on true overlays, 8–12px radii, no heavy elevation. |
| **Type does the work** | Hierarchy via size/weight/color, not boxes. |

### Proposed token set (refine the existing `--dt-*`)

> These are **recommended values** to replace the current ones. They keep the variable names so no component code changes — only `styles.css`.

**Light theme**
```css
:root {
  /* Surfaces — warmer, quieter neutrals (off the blue tint) */
  --dt-background:        #fbfbfa;  /* near-paper, not blue-white */
  --dt-foreground:        #1c1c1e;  /* ink, softer than pure black */
  --dt-card:              #ffffff;
  --dt-muted:             #f4f4f3;
  --dt-muted-foreground:  #6b6b70;  /* secondary text */
  --dt-border:            #ececea;  /* hairline */
  --dt-input:             #dededa;

  /* Accent — desaturated, reserved for action/focus */
  --dt-primary:           #2f6df6;  /* slightly calmer than #0053fd */
  --dt-primary-foreground:#ffffff;
  --dt-ring:              #2f6df6;
  --dt-accent:            #eef3ff;   /* faint tint for hover/active only */

  /* Status — muted, not neon */
  --dt-success: #2e9e6b;  --dt-warning: #c98a14;  --dt-danger: #d2503f;

  /* Code */
  --dt-code-inline:   #b3215f;       /* readable on light, not the indigo */
  --dt-code-block-bg: #f6f6f5;       /* light code blocks (Codex-like) */
  --dt-code-block-fg: #1c1c1e;
}
```

**Dark theme** (the redesign's primary target — like Claude/Codex/Z.code dark)
```css
.dark {
  /* Surfaces — true-neutral charcoal, three clear tiers */
  --dt-background:        #0e0e10;  /* app bg */
  --dt-foreground:        #ececee;  /* primary text (not pure white) */
  --dt-card:              #161618;  /* raised surface */
  --dt-muted:             #1d1d20;  /* input / secondary surface */
  --dt-muted-foreground:  #9a9aa2;  /* secondary text */
  --dt-border:            #262629;  /* hairline */
  --dt-input:             #2a2a2e;

  /* Accent — bright enough for AAA on charcoal, still restrained */
  --dt-primary:           #6f9bff;
  --dt-primary-foreground:#0e0e10;
  --dt-ring:              #6f9bff;
  --dt-accent:            #1a2238;   /* faint blue tint, hover/active only */

  --dt-success: #45c08a;  --dt-warning: #e0b341;  --dt-danger: #f0766a;

  --dt-code-inline:   #9ec1ff;
  --dt-code-block-bg: #0a0a0c;       /* deeper than card → code reads as inset */
  --dt-code-block-fg: #e3e3e6;
}
```

### Typography

- **Family:** keep Inter Variable (UI) + JetBrains Mono Variable (code). Both already loaded.
- **Base size:** keep the existing `data-text-size` scaling; set the **default** body to `15px` / line-height `1.6` (chat reads as prose). Current is `0.9375rem` (15px) at 1.55 — nudge line-height up to **1.6** for the airier feel.
- **Scale (rem-based so text-size scaling still works):**

| Token | Size | Weight | Use |
|-------|------|--------|-----|
| Display | `28px` / 1.2 | 600 | empty-state / Live captions headline |
| H1 | `22px` / 1.25 | 600 | section titles (down from current 36px — calmer) |
| H2 | `18px` / 1.3 | 600 | sub-sections |
| Body | `15px` / 1.6 | 400 | chat + prose |
| Small | `13px` / 1.5 | 400 | metadata, timestamps, secondary |
| Mono | `13.5px` / 1.55 | 400 | code blocks (JetBrains Mono) |
| Label/caps | `11px` / 1.4 | 600, `0.06em` | role labels ("You"/"August"), nav groups |

- **Letter-spacing:** reuse the existing `display: -0.022em` for headings, `body: -0.011em` for body — already tuned well.
- **Color of text:** primary `--dt-foreground`; secondary `--dt-muted-foreground` (timestamps, tool args, hints). Avoid pure `#000`/`#fff` — both themes use slightly-off ink for less eye strain.

### Spacing, radius, motion

- **Radius:** standardize on `--radius-md: 10px` for cards/inputs/buttons, `8px` for small chips, `14px` for the composer and overlays. (Current scale 4–20px stays; just default to 10.)
- **Spacing rhythm:** 4px base; chat turn vertical gap `20px`; composer padding `12–14px`; section padding `24px`.
- **Borders:** 1px hairline using `--dt-border`; drop borders on message bubbles entirely (whitespace separates turns).
- **Shadows:** reserve `--shadow-overlay` for popovers/modals only; surfaces are flat with hairlines (Codex/Claude style).
- **Motion:** `framer-motion` (already present) for subtle 120–180ms ease-out on hover/enter; respect `prefers-reduced-motion`.

### Chat-specific patterns (the headline change)

- **Bubble-less turns:** user and August messages share the centered column. Differentiate with a small caps role label + the secondary text color for the user turn, full-ink for August, rather than colored bubbles.
- **Composer:** a single rounded `14px` field pinned to the bottom of the centered column, hairline border, focus = accent ring (`--dt-ring`), embedded send + mic (mic launches §14 August Live). No toolbar clutter — secondary actions behind a `+`/`⋯` menu (you already use `cmdk` + Radix).
- **Code blocks:** inset surface (`--dt-code-block-bg` darker/lighter than the card), JetBrains Mono `13.5px`, copy button on hover, language label top-right — matches Codex/Z.code.
- **Density control:** keep the existing text-size selector; add a **"Comfortable / Compact"** density toggle that maps to the turn-gap + composer padding.

### Theme toggle & scope

- Ship **dark as the default** (the reference apps are dark-first) while keeping the polished light theme.
- All changes are confined to `src/styles.css` (token values), `tailwind.config.cjs` (default radius/line-height), and the chat-thread + composer components for the bubble-less layout. **No component API changes** — the `--dt-*` indirection means most of the app re-skins for free.

### Tests / acceptance
- [ ] Contrast: body/secondary text meets WCAG AA on both themes (AAA for primary on dark)
- [ ] Token swap causes **no** component code changes outside the listed files
- [ ] Chat column renders bubble-less, centered, with role labels; code blocks inset with copy
- [ ] `data-text-size` scaling still works across the new scale
- [ ] `prefers-reduced-motion` disables non-essential animation
- [ ] Light + dark both pass a visual review against the Claude/Codex/Z.code reference feel

**Files touched:** `src/styles.css` (retuned `--dt-*` tokens + type scale), `tailwind.config.cjs` (default radius/line-height), chat thread + composer components (bubble-less layout, new composer). Delivered in v4 ([`tracker-v4.md`](./tracker-v4.md)).

---

## 16. v4: Rendering & Input Fixes (Math, Auto-Grow Composer, Chat Scroll Thumb)

> Three concrete, verified frontend defects to fix as part of the v4 polish. Each
> entry below is written to be **directly implementable** — exact file, exact
> current code, exact change. Delivered in v4 ([`tracker-v4.md`](./tracker-v4.md)).

### 16.1 Math rendering — render LaTeX as real math, not raw source

**Problem (verified):** `src/sections/chat/ChatMarkdown.tsx` renders assistant text with `marked` only (`marked.use({ gfm, breaks, renderer:{code} })`). There is **no math handling**, so an expression like `$\frac{a}{b}$`, `\(x^2\)`, or a display block `$$\int_0^1 x\,dx$$` is passed through verbatim and the user sees raw LaTeX source (backslashes, `\frac`, carets) instead of typeset math. The user's words: equations show "in latex style" — they want them to look "like a person wrote it," i.e. **typeset notation**.

**Decision:** Render math with **KaTeX** (fast, synchronous, zero-network, ships its own fonts; far lighter than MathJax and ideal for streaming chat). Not already a dependency — add it.

**Exact implementation:**

1. **Add deps** (in `frontend/desktop`):
   ```
   npm i katex
   npm i -D @types/katex
   ```
2. **Load KaTeX CSS once.** In `src/main.tsx` (where global CSS is imported), add:
   ```ts
   import 'katex/dist/katex.min.css';
   ```
   KaTeX bundles its own fonts via this stylesheet — no extra font wiring.
3. **Parse + render math in `ChatMarkdown.tsx`.** Math must be handled **before** `marked` escapes it. Implement a small math extension rather than post-processing HTML (post-processing risks touching `$` inside code blocks). Concretely:
   - Supported delimiters:
     - Inline: `\( … \)` and single `$ … $` (with the standard guard: a `$` is only a math delimiter when not adjacent to a digit on the outside, to avoid eating currency like "it cost $5 and $6").
     - Display: `\[ … \]` and `$$ … $$`.
   - Use `marked`'s **extension API** to register two inline/block tokenizers (`name: 'mathInline'` / `'mathBlock'`) that capture the body and emit a renderer calling:
     ```ts
     import katex from 'katex';
     const html = katex.renderToString(body, {
       displayMode,            // true for $$/\[ \]
       throwOnError: false,    // on bad LaTeX, render the source in error color, never crash
       output: 'htmlAndMathml',// accessible (MathML) + visual (HTML)
       strict: false,
     });
     ```
   - **Code must be exempt:** because we register math as marked tokenizers, fenced/inline code tokens are matched first by marked and never reach the math tokenizer — verify with a test that `` `$x$` `` and a ```` ```\n$x$\n``` ```` block render literally.
   - **Streaming safety:** assistant text streams token-by-token, so a half-arrived `$$` may be unbalanced mid-stream. The tokenizer must **only** match a *closed* delimiter pair; an unterminated `$$…` stays as plain text until the closing delimiter arrives on a later render (no flicker, no crash). `throwOnError:false` covers the rest.
4. **Styling:** KaTeX renders into `.katex` / `.katex-display`. Add minimal rules to `styles.css`:
   ```css
   .markdown-content .katex { font-size: 1.05em; }
   .markdown-content .katex-display { margin: 0.6em 0; overflow-x: auto; overflow-y: hidden; }
   ```
   (Display math can be wider than the chat column — allow horizontal scroll on the block only, matching the code-block pattern.)

**Acceptance:**
- [ ] `$E=mc^2$` and `\(a^2+b^2=c^2\)` render inline as typeset math
- [ ] `$$\int_0^1 x\,dx = \tfrac12$$` and `\[ … \]` render as centered display math
- [ ] `$5` / `it cost $5 to $6` stays literal (no false math)
- [ ] `` `$x$` `` and `$x$` inside a fenced code block stay literal
- [ ] Invalid LaTeX renders the source in an error color, does not crash the message
- [ ] Mid-stream unbalanced `$$` does not fl/ flicker; resolves when the close arrives

**Files touched:** `package.json` (katex + @types/katex), `src/main.tsx` (CSS import), `src/sections/chat/ChatMarkdown.tsx` (math tokenizers + render), `src/styles.css` (katex sizing). 

### 16.2 Composer auto-grow — expand on paste / programmatic set, not just typing

**Problem (verified):** In `src/sections/chat/ChatComposer.tsx` the textarea auto-grow runs **inline inside `onChange`** (lines 214–218):
```tsx
onChange={(e) => {
  onInputChange(e.target.value);
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 360) + 'px';
}}
```
This only fires on direct user keystrokes/paste *that go through the React onChange*. It does **not** run when `input` is set **programmatically** — draft restore (`loadComposerDraft`), the `INSERT_COMPOSER_TEXT_EVENT` insert path, slash-command insertion, or restoring a queued message. In those cases the box stays at its 1-row `minHeight: 64px` with a long value crammed inside until the user types. Pasting a very long message *does* grow today (paste fires onChange), but the height is also **hard-capped at 360px with no internal scroll affordance** beyond the textarea's native one.

**Fix — make auto-grow a value-driven effect, not an event handler:**

1. Extract the resize into a stable helper and call it from a `useLayoutEffect` keyed on `input`, so height tracks the value **regardless of how it changed**:
   ```tsx
   const MIN_H = 64;
   const MAX_H = 360;

   const resizeTextarea = useCallback(() => {
     const el = taRef.current;
     if (!el) return;
     el.style.height = 'auto';
     const next = Math.min(el.scrollHeight, MAX_H);
     el.style.height = next + 'px';
     // Show the textarea's own scrollbar only when content exceeds the cap.
     el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden';
   }, [taRef]);

   // Runs for typing, paste, draft restore, INSERT_COMPOSER_TEXT_EVENT, queued-message restore.
   useLayoutEffect(() => { resizeTextarea(); }, [input, resizeTextarea]);
   ```
2. Simplify `onChange` to just propagate the value (the effect handles height):
   ```tsx
   onChange={(e) => onInputChange(e.target.value)}
   ```
3. Keep `minHeight: 64px; maxHeight: 360px` in `style`, but **remove** the now-redundant inline height writes. Once content passes 360px the textarea scrolls internally (overflowY toggled above), with the styled thin scrollbar from §16.3.
4. **Reset on send:** after the message is sent and `input` is cleared to `''`, the same effect fires and returns the box to 64px — verify no residual tall height.

**Acceptance:**
- [ ] Pasting a 500-line message expands the composer up to 360px, then scrolls inside
- [ ] Restoring a long draft on session switch shows the expanded height immediately (no keystroke needed)
- [ ] Inserting text via `INSERT_COMPOSER_TEXT_EVENT` / slash command grows the box
- [ ] Sending clears and shrinks the box back to one row
- [ ] The textarea shows its scrollbar only when content exceeds 360px

**Files touched:** `src/sections/chat/ChatComposer.tsx` (resize effect), optionally `src/styles.css` (textarea scrollbar via §16.3).

### 16.3 Chat scroll thumb — restore a draggable scrollbar on the transcript

**Problem (verified):** The chat transcript's scroll container at `src/sections/chat/ChatThread.tsx:1953-1954` **deliberately hides its scrollbar**:
```tsx
ref={scrollRef}
className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none] [-ms-overflow-style:none]"
```
A stale comment (line 708) says "the scroll thumb lives at the screen edge … in ChatLayout," but `src/components/shell/ChatLayout.tsx` has **no scroll container** — so in a long conversation there is **no visible/draggable thumb at all**. The user can only wheel/trackpad-scroll; they cannot grab a thumb to jump up quickly. The user's request: make the scroll thumb usable to move up easily.

**Fix — give the transcript container a real, styled scrollbar:**

1. **Remove the scrollbar-hiding utilities** on line 1954. New className:
   ```tsx
   className="flex-1 overflow-y-auto chat-scroll"
   ```
2. **Add a styled, draggable scrollbar** in `styles.css` (theme-aware, matching the existing `::-webkit-scrollbar-thumb` look already defined at lines 219–230 so it's consistent with the sidebar):
   ```css
   .chat-scroll { scrollbar-width: thin; scrollbar-color: var(--dt-border) transparent; }
   .chat-scroll::-webkit-scrollbar { width: 10px; }
   .chat-scroll::-webkit-scrollbar-track { background: transparent; }
   .chat-scroll::-webkit-scrollbar-thumb {
     background: color-mix(in srgb, var(--dt-muted-foreground) 35%, transparent);
     border-radius: 8px;
     border: 2px solid transparent;     /* inset so the thumb reads as a pill */
     background-clip: padding-box;
     min-height: 40px;                  /* never shrink to an ungrabbable sliver in long chats */
   }
   .chat-scroll::-webkit-scrollbar-thumb:hover {
     background: color-mix(in srgb, var(--dt-muted-foreground) 55%, transparent);
     background-clip: padding-box;
   }
   ```
   - `min-height: 40px` is the key usability fix: in a very long transcript the proportional thumb would otherwise become a 2px sliver that's impossible to grab. A floor keeps it draggable.
3. **Keep** the existing "scroll to bottom" button (ChatThread.tsx:1993) and the `closest('.overflow-y-auto')` logic (596/605/622/2855) — they still work because the container keeps `overflow-y-auto`; only the *hiding* utilities are removed. No JS change required.
4. **Reduced-motion / overlay note:** on macOS the OS may render overlay scrollbars; the `::-webkit-scrollbar` width forces a persistent gutter so the thumb is always present and grabbable in the Tauri WebView (Chromium), which is the target runtime.

**Acceptance:**
- [ ] A long conversation shows a visible scrollbar thumb on the transcript
- [ ] The thumb is draggable and never thinner than 40px regardless of transcript length
- [ ] Thumb color respects light/dark via `--dt-*`; hover darkens it
- [ ] Wheel/trackpad scroll, "scroll to bottom" button, and checkpoint `scrollIntoView` all still work
- [ ] Removing the hide utilities did not shift layout width noticeably (10px gutter accounted for)

**Files touched:** `src/sections/chat/ChatThread.tsx` (line 1954 className; remove stale comment at 708), `src/styles.css` (`.chat-scroll` rules).

### Why these are grouped into v4

All three are the same class of change as §15 (polish of the chat surface), touch the same files (`ChatMarkdown`, `ChatComposer`, `ChatThread`, `styles.css`), and are independent of the cognitive engine. They can land in any order relative to §15, but should ship **with** the redesign so the chat feels finished. None require backend changes.
