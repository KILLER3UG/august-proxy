# Implementation Tracker — v1 (Phases 0–7)

> **Spec:** [`cognitive-architecture-v1.md`](./cognitive-architecture-v1.md)
> **Scope:** Core cognitive loop — data unification, prompt restructure, cognitive
> budgeting, BM25 disclosure, heuristics, execution state, working memory, prompt caching.
> **Next file after this one:** [`tracker-v2.md`](./tracker-v2.md)

## How to use this file (read first)

1. Work phases **in order, top to bottom**. Phase N+1 assumes Phase N is done.
2. Each phase has: **Tasks** (checkboxes), **Files**, **Tests**, and a **Definition of Done (DoD)**.
3. Check a box `- [x]` only when the thing is actually done *and verified* (tests pass, not "should pass").
4. Flip the phase's feature flag in `data/config.json → cognitive_layers` only after its DoD is met.
5. Update the **Progress** table below as you go. Record blockers in the phase's **Notes**.
6. **Do not open [`tracker-v2.md`](./tracker-v2.md) until every box in this file is checked and v1 is verified in production.**
7. If reality diverges from the spec, update the spec first (the spec is the source of truth), then this tracker.

## Progress

| Phase | Title | Flag | Status | Owner | Notes |
|------:|-------|------|--------|-------|-------|
| 0 | Data Unification & Schema Migration | (proxy-side) | ☐ not started | | |
| 1 | System Prompt Restructure + Node parity | (proxy-side) | ☐ not started | | |
| 2 | Cognitive Budgeting | `cognitive_budget` | ☐ not started | | |
| 3 | BM25 + Progressive Disclosure | `progressive_disclosure` | ☐ not started | | |
| 4 | Learned Heuristics | `heuristics` | ☐ not started | | |
| 5 | Execution State Machine | `execution_state` | ☐ not started | | |
| 6 | Working Memory + Error Correction + Guardrails | `scratchpad`,`failure_feedback`,`tool_guardrails` | ☐ not started | | |
| 7 | Prompt Caching | `prompt_caching` | ☐ not started | | |

Status legend: ☐ not started · ◐ in progress · ✅ done & verified · ⚠ blocked

---

## Phase 0 — Data Unification & Schema Migration

> ⚠ **Verified current state:** `august_brain.sqlite` **already exists** with base tables. Do NOT bootstrap a new DB. `august-sessions.db` may hold Node.js data — **verify before deleting** (archive, don't `rm`). `memory_store_fts` has **no triggers** today.

### Tasks
- [ ] Delete `app/database.py`; remove `init_db()`/`close_db()` from `app/main.py` lifespan
- [ ] **Verify `august-sessions.db` ownership** (grep `backend/` for `august-sessions`; confirm Node retired) → archive to `.bak`, do **not** `rm`
- [ ] Remove `sqlalchemy` + `aiosqlite` from `pyproject.toml`
- [ ] Add `learned_heuristics` table in `memory_store.init()`
- [ ] Add flattened `auto_memories` table + `auto_memories_fts` + INSERT/UPDATE/DELETE triggers
- [ ] **Fix broken `memory_store_fts`:** add triggers + one-time backfill from `memory_store`
- [ ] Change `auto_memory.save_auto_memory()` to write individual rows (not one JSON blob)
- [ ] Delete orphaned `auto_memories` blob from `memory_store` after migration
- [ ] Write `scripts/migrate_core_memory.py` (`--dry-run`, `--source json|sqlite|merge`, merge rules per spec)
- [ ] Write `scripts/migrate_learned_heuristics.py`
- [ ] Write `scripts/migrate_auto_memories.py` (split blob → rows)
- [ ] Add `services/db_writer.py` — single async write queue (high/low priority, 2s drop for low)
- [ ] Raise `busy_timeout` to 10000ms
- [ ] Implement proactive memory prefetch in `workbench.py` (auto_memories FTS top-5, all heuristics, core facts)
- [ ] **Add `brain_query` core tool (§11)** — unified read across all brain stores; register in `AUGUST_CORE_TOOLS`
- [ ] Document `august_graph_memory.json` / `august_infinite_memory.json` as out-of-scope JSON stores
- [ ] Add `cognitive_layers` flag block to `data/config.json` (v1 flags default `true`, v2 default `false`)

### Files
`scripts/migrate_*.py` (new ×3), `services/db_writer.py` (new), `memory_store.py`, `memory/auto_memory.py`, `workbench/workbench.py`, `tool_definitions.py` (brain_query), `main.py`. Delete `database.py`.

### Tests
- [ ] Migrations import JSON correctly; row counts match (no data loss)
- [ ] Merge rule keeps richer values (no overwrite)
- [ ] `--dry-run` writes nothing; migrations idempotent on re-run
- [ ] `save_auto_memory()` writes FTS-indexed rows
- [ ] FTS triggers fire on INSERT/UPDATE/DELETE (index non-empty after write)
- [ ] `memory_store_fts` backfill populates index
- [ ] Orphaned blob deleted after migration
- [ ] `brain_query` returns rows from each available store; "not available" for unshipped stores
- [ ] Write queue drains; low-priority dropped after 2s; reads never blocked

### Definition of Done
All migrations run clean on a copy of prod data, FTS indexes are live, `brain_query` works, the write queue is the single write path, and the app starts without SQLAlchemy. `august-sessions.db` archived (not deleted) with ownership confirmed.

### Notes
_(blockers / decisions here)_

---

## Phase 1 — System Prompt Restructure + Node.js Parity

### Tasks
- [ ] Rewrite `context_builder.build_system_prompt()` → 3-tier XML structure
- [ ] Remove duplicated goal/plan (currently in BOTH `context_builder` and `workbench`) → single `<directives>` in Tier 2
- [ ] Inject `<workspace>` (use existing `session.workspace_path`)
- [ ] **Fix dead `core_memory` read:** read `core_memory` key, inject as `User facts:` in `<runtime_context>`
- [ ] Remove `build_client_tool_guidance()` but **preserve its web-tool routing guidance** (not a no-op stub) → re-home into `<system_constraints>`/`<runtime_context>`
- [ ] Wire `brain_orchestrator.classify_task()` + `policy_for_task()` into the chat loop → `<brain_policy>` Tier 3
- [ ] Add guard-mode rules to `<system_constraints>` (port `workbench.js:2326-2339`)
- [ ] Add memory/graph stats to `<runtime_context>` (port `context-builder.js:165-171`)
- [ ] Add `<whats_new>` block (port `whats-new.js`, last 24h git commits)
- [ ] Fix `list_proxy_capabilities()` → grouped by source, mutation flags, token estimate (port `workbench.js:1540`)
- [ ] Add `diagnose_proxy` / `describe_environment` tools

### Files
`memory/context_builder.py`, `workbench/workbench.py`, `routers/workbench.py`.

### Tests
- [ ] 3-tier XML structure emitted; no goal/plan duplication
- [ ] `core_memory` facts appear in prompt
- [ ] Web-tool routing guidance preserved
- [ ] Brain policy injected; guard rules + memory stats + whats-new present
- [ ] Capabilities endpoint returns grouped data

### Definition of Done
Prompt is a clean 3-tier structure with zero duplication, all listed Node parity features visible in output, brain policy wired.

### Notes

---

## Phase 2 — Cognitive Budgeting

### Tasks
- [ ] Implement `estimate_tokens()` with tokenizer priority (Anthropic SDK → tiktoken → Gemini → 3.5-char fallback)
- [ ] When using fallback heuristic, set critical threshold to 85%
- [ ] Inject `<cognitive_budget>` (context_used_pct, remaining_tokens, attention_pressure) in Tier 3
- [ ] Add compaction rules to `<system_constraints>` tied to pressure levels
- [ ] Implement auto-compaction at critical: Hippocampus summary of last 10 msgs → `<compacted_history>`, originals saved to `messages` table
- [ ] Suppress re-compaction within 5 turns (advise new session instead)

### Files
`workbench/workbench.py` (+ `lib/tokens.py` if needed).

### Tests
- [ ] Pressure levels correct at 50/75/90% boundaries
- [ ] Fallback uses 85% threshold
- [ ] Compaction triggers at critical; `<compacted_history>` format; tokens recovered after compaction

### Definition of Done
Budget is accurate per tokenizer tier; critical pressure auto-compacts and recovers context.

### Notes

---

## Phase 3 — BM25 + Progressive Disclosure

### Tasks
- [ ] New `services/tools/retrieval.py` — pure-Python BM25 (tools + skills), zero deps
- [ ] New `services/tools/tool_bridges.py` — `tool_search` / `tool_describe` / `tool_call` (reserved names)
- [ ] New `services/tools/model_tools.py` — `assemble_tool_defs()` orchestrator + `AssemblyResult`
- [ ] New `services/tools/skill_manifest.py` — manifest builder + payload loader (mtime cache)
- [ ] `tool_registry.py` — reserve bridge names, add `keywords` field
- [ ] `tool_definitions.py` — add `keywords` to tool defs
- [ ] Wire assembler + auto-priming of skills (`<primed_playbooks>`) into `workbench.py`
- [ ] Sliding 6-turn query window with recency decay; cold-start fallback (≤2 msgs → global top-K)

### Files
`retrieval.py`, `tool_bridges.py`, `model_tools.py`, `skill_manifest.py` (new ×4), `tool_registry.py`, `tool_definitions.py`, `workbench.py`.

### Tests
- [ ] BM25 ranking sane; threshold gate (pass-through < 200 tools, activate ≥200)
- [ ] Bridge dispatch works; reserved names rejected
- [ ] Core tools never deferred; budget hierarchy (skills dropped first, then K reduced)
- [ ] Cold-start + window edge cases

### Definition of Done
Tool schemas compress only above threshold; core safety preserved; skills auto-prime on keyword overlap; bridges reach all deferred tools.

### Notes

---

## Phase 4 — Learned Heuristics

### Tasks
- [ ] New `services/heuristics_service.py` — CRUD over `learned_heuristics` (table from Phase 0)
- [ ] Add `update_heuristics(action, rule)` to core set
- [ ] Inject `<learned_heuristics>` (Tier 2) from SQLite

### Files
`heuristics_service.py` (new), `context_builder.py`, `tool_definitions.py`.

### Tests
- [ ] CRUD (add/remove/clear/list); injection into prompt; tool dispatch; persists across sessions

### Definition of Done
Heuristics persist and appear in Tier 2; model can add/remove them via tool.

### Notes

---

## Phase 5 — Execution State Machine

### Tasks
- [ ] Add `update_state(phase, step, completed, blockers)` to core set
- [ ] Store state in session metadata; inject `<execution_state>` Tier 3
- [ ] `asyncio.Lock` per session around state mutations (5s timeout)
- [ ] Accept optional `verification_command` field (for Phase 10 Verifier Reflex)
- [ ] Drop state on session end / new plan

### Files
`workbench/workbench.py` (+ session dataclass field).

### Tests
- [ ] State updates persist + inject; last-write-wins under parallel `update_state`/`write_scratchpad`

### Definition of Done
Model has phase awareness; concurrent updates serialized without dropped writes.

### Notes

---

## Phase 6 — Working Memory + Reflexive Error Correction + Loop Guardrails

### Tasks
- [ ] Add `write_scratchpad(text)` to core set; keep only latest; inject `<working_memory>` Tier 3
- [ ] Reflexive error correction in `tool_executor._execute_tool()`: catch all, extract last frame + type + msg → `<failure_feedback>` Tier 3 (not chat history)
- [ ] `<system_constraints>` rule: diagnose `<failure_feedback>` before other action
- [ ] New `services/workbench/tool_guardrails.py` — ToolCallTracker (warn 3 / block 6 identical; warn 4 / block 8 same-tool failures; reset on text response)
- [ ] Wire tracker as pre-flight check in `_execute_tool()`

### Files
`workbench.py`, `tool_executor.py`, `tool_guardrails.py` (new).

### Tests
- [ ] Scratchpad overwrite (old discarded); injection
- [ ] Error truncation to last frame; `<failure_feedback>` format
- [ ] Loop detection (identical + failure); tracker reset on text; warn/block thresholds

### Definition of Done
Reasoning lives in scratchpad; errors are structured not raw tracebacks; tool-call loops are bounded.

### Notes

---

## Phase 7 — Prompt Caching

### Tasks
- [ ] Cache Tier 1 + Tier 2 per session, 5-min TTL
- [ ] In-memory LRU (max 100 sessions)

### Files
`workbench/workbench.py`.

### Tests
- [ ] Cache hit/miss; TTL eviction; LRU eviction

### Definition of Done
Stable tiers reused across turns; upstream prefix-cache hits; correct eviction.

### Notes

---

## v1 exit criteria (all must hold before [`tracker-v2.md`](./tracker-v2.md))
- [ ] Every phase box above checked
- [ ] All v1 `cognitive_layers` flags `true` and healthy
- [ ] `brain_query` (§11) live; FTS indexes populated; write queue is the single write path
- [ ] No goal/plan duplication; 3-tier prompt verified in a real session
- [ ] App runs a full chat session end-to-end without regressions
- [ ] v1 verified in production (per spec scope rule)
