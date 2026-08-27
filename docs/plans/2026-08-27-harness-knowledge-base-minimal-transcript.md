# August Harness — Knowledge-Base Overhaul & Minimal-Output Design

**Date:** 2026-08-27 · **Status:** RULED — all 15 open questions decided (§8 records the rulings; Q2/Q5 conditions folded into §3.6/§3.5); "orcacode" corrected to OrcaCode Review (Part 10); cross-reference audit applied 2026-08-27 (#8→T1, #10→T5 merged; #12→P2; #3 stage order fixed) · **Scope:** backend-py memory/skills/sessions + desktop transcript UI + benchmark-top strategy (Part 9) + code-review feature (Part 10)

This plan supersedes the pasted spec (`paste-attachments/2026-08-27/pasted-text-20260827-183508-cec7fcab.txt`) for the memory/skills/transcript work. Carried-over phases (circuit, drawer, sidebar, settings) keep their review status in §6.

---

## 0. Executive summary

The memory system is a partially demolished building. The 0.17.0 reorg (`4f1bfdb1`) deleted the entire cognitive machinery (consolidation daemon, vector mirror, auto-review loop, heuristics writer, context builder) but left behind: its **state blobs in the user-visible memory KV table**, its **config flags**, its **dead tables** (recreated on every boot), its **dead frontend pages** (polling nine deleted endpoints), and a migration (`023`) whose comment **falsely claims those state blobs are "written by live code"** and preserves them.

Verified against the live database (`data/august_brain.sqlite`, read-only, 2026-08-27):

- `memory_store` KV holds **8 keys; 7 are junk** (`cognitive:consolidation:last_run`, `cognitive:vector_reconciliation:last_run`, `boot_maintenance_state`, `auto_memory_review_state`, `routing:auto-route:decisions`, `self_evolution_log`, `userProfile`). Only `agent_jobs` has a live writer/reader.
- `learned_heuristics` holds **3 immutable junk rows** — the "Turn failed on …" `provider_reliability` turn-lessons, including the `deepseek-v4-flash-free` one. Writer deleted in 0.17.0; nothing reads them into prompts; the UI is forbidden from deleting them (`brain.py:442-443,471-472`).
- **21 of 23 sessions have placeholder titles** (`Chat 2026-08-… UTC`). The model-based auto-titler exists but effectively always fails for keyless gateway providers (§1.8).
- ~30 memory-ish tables exist; only ~12 have live writers. Fully orphaned tables still hold data: `curation_ledger` (240 rows), `brain_events` (609), `session_traces` (167), `vector_entries` (16), `graph_entities` (61), `graph_relations` (56), `harness_trends` (3). (`routing_evidence`, `execution_state`, `scratchpad`, `exams` verified **live** — keep.)

The only live memory write doors today: the gated `remember` tool (→ `facts`), human manage/import endpoints (→ `facts`), agent-registry KV, per-turn timeline breadcrumbs, and session/message persistence. The only hygiene: a boot-time facts-expiry sweep, session cascades, privacy purges, and the one-shot 023 purge.

**What this plan does:**
1. **§2 Removals** — purge the junk data, delete the dead code, stop recreating dead tables.
2. **§3 Knowledge-base redesign** — separate machine state from memory; make `facts` the one durable, typed, human-readable store; add retrieval that actually injects relevant memory into prompts; a minimal consolidation job; turn outcomes as telemetry instead of "lessons"; skill-system hygiene fixes; session titling that works.
3. **§4 Minimal-output transcript** — the invocation-only rendering spec, formalized, with corrections (§4.2) where the spec contradicts itself or the codebase.
4. **§5 UI/UX proposals** — flat memory list, session titles, failure lines, visual budget.
5. **§4.5 Unified Changes card (rev. 2)** — ZCode-style single `ChangesCard` ("X files changed +N −M" + Undo) with type-aware rows (code → Review + Open; documents → big badge + kind label + Open), replacing `ChangedFilesCard` and `ProducedFilesRow`.
6. **Part 9 — Benchmark-top strategy** — a source-level survey of 10 leading harnesses (2026-08-27; identities and file-level citations kept **only** in the Appendix evidence index) distilled into self-contained adoption specs (§9.3 Set A #1–#13, §9.4 Set B T1–T18), plus a phased path (B0–B5, §9.5) to put **August itself** at the top of the Coding Agent Index. Per the implementation policy (§9.0 box), no spec references any external app or codebase — everything is implementable from the plan text alone. Per your ruling the existing `benchmark` agentMode is model-evaluation (measures the model by *stripping August out*) and useless → deleted in §2.2; the competition entry is the full, self-improving harness running headlessly. Biggest documented score levers: post-edit verification loop (+36 pp) and per-model edit format (3× laziness reduction) — both are gaps in August today.
7. **Part 10 — OrcaCode Review deep-dive** — per your correction (Q9), "orcacode" = **OrcaCode Review** (`Continuum-AI-Corp/orca-code-review`), an AI code-review pipeline (GitHub Action + skill + CLI over the Open Code Review engine) — **not** OpenCode and not a coding-agent competitor. Part 10 maps what to implement from it into August: a first-party **code-review feature** over August's own changesets (§10.2), plus portable techniques — two-layer precision filtering (deterministic git-grep grounding → independent-model judge), a severity rubric with explicit boundaries, conventions-as-untrusted-data, and idempotency-safe retry/metering for the proxy (§10.3).

---

## Part 1 — Findings: how memory works today

### 1.1 Storage architecture

One SQLite file: `data/august_brain.sqlite` (override `AUGUST_BRAIN_SQLITE_FILE`), thread-local WAL connections (`memory_conn.py:17-28,76-86`).

- **Core schema** (`memory_schema.py:19-204`): `memory_store` KV (`key TEXT PRIMARY KEY, value TEXT, updated_at`) + FTS5 mirror; `facts`; `proposals`; `lifecycle`; `session_topics`; `sessions`; `messages` + FTS; `usage_events`; `config_audit`; `learned_heuristics`; `auto_memories` + FTS + sync triggers.
- **Extended tables** (`memory_schema.py:256-435`): `episodic_timeline`, `execution_state`, `scratchpad`, `tool_guardrail_log`, `blackboard`, `exams`/`exam_questions`/`exam_attempts`, `pending_skills`, `daemons`; additive columns incl. `facts.expires_at` (`:410`).
- **Vector/graph tables** (`memory_schema.py:438-498`): `vector_entries`, `graph_entities`, `graph_relations`, `graph_observations` — **recreated on every boot** (`:435,:636`) though no live code writes or reads them. There is **no embedding code anywhere**; "vector_reconciliation" was a mirror-consistency job for a deleted module.
- **Store facade** (`memory_store/`): `kv.py` (KV CRUD+FTS), `brain.py` (model/UI query layer; `_BRAINStores` registry of **10 exposed stores** at `:12-83`: memory, autoMemories, heuristics, facts, sessions, messages, timeline, blackboard, exams, examAttempts), `rest.py` (facts/proposals/lifecycle/usage/timeline), `sessions.py`, `messages.py`.
- 24 migrations applied, `001`–`024`.

### 1.2 Live write paths (who creates memory)

| Writer | File:line | Store | Gating |
|---|---|---|---|
| `remember` tool | `tool_registrations/session_tools.py:104-170` | `facts` (`source='model'`, confidence 0.7, optional `expires_at`) | `modelMemoryWrites` toggle (`:131`, default true); sensitive-topic denylist `_SENSITIVE_MEMORY_RE:78-88` checked `:139`; category whitelist `:147-149`; rollback record `:159-169` |
| Subagent block | `workbench/subagent.py:42-48` | — | subagents cannot call `remember` |
| Human add/edit/delete | `POST /api/august/memory/manage` (`routers/august.py:345-388`) | `facts` (`source='user'`) | — |
| Human bulk import | `POST /api/august/memory/import` (`august.py:403-479`) | `facts` | — |
| Agent registry | `tools/agent_registry.py:78,89,101,217,227` | `memory_store` keys `agents:*`, `agent_jobs` | the **only live KV writers** |
| Timeline breadcrumbs | `workbench/workbench.py:3524-3548` | `episodic_timeline` (per-turn + session summary) | — |
| Sessions/messages | `memory_store/sessions.py:73-164` | `sessions`, `messages` | — |
| Usage/audit/lifecycle | `memory_store/rest.py:125,152,268` | `usage_events`, `config_audit`, `lifecycle` | — |

**Heuristics writer: dead.** Zero `INSERT INTO learned_heuristics` in the working tree. The "Turn failed on …" rows were written by `_record_turn_lesson` → `heuristics_service.addHeuristic(category='provider_reliability')`, both deleted in `4f1bfdb1`. The writer survives only in the stale `backend-py/build/lib/` snapshot (`build/lib/services/heuristics_service.py:190`) — that artifact is the source of much grep confusion.

**Cognitive maintenance: dead.** Working-tree `cognitive_boot.py:38-107` starts only the cron scheduler, daemon manager, and the new facts-expiry sweep (`:74-100`). Its docstring says the rest "was removed with the memory system."

### 1.3 Read / analysis paths

- **Boot/turn injection** — the *only* memory content pushed into prompts: `workbench.py:713-733` adds a store-hint line plus `brain_index_snippet()` (`brain.py:361-399`): top-15 unexpired fact names + last-5 timeline summaries, ~250-token cap, injected into `<intake>` each turn. Everything else is pull-on-demand via `brain_query`.
- **`brain_query` tool** — `session_tools.py:56-72`; tool schema restricts the store enum (`:395`); FTS/LIKE search, token-capped JSON (`brain.py:166-296`). `store='graph'` returns a hard error stub (`brain.py:113-115`).
- **`retrieval.py`** — pure-Python BM25, but it retrieves **tools and skills only**, never memory.
- **API** — `/api/brain/config`, `/api/brain/stores` (counts), `/api/brain/stores/{name}` (browse), row delete/patch (`routers/brain_config.py:38-128`).
- **Orphan reader** — `GET /api/workbench/sessions/{id}/context` (`routers/workbench.py:1646-1655`) reads `session_context:{id}` KV keys whose writer was deleted and whose rows 023 purged; it now always returns `None`.
- **Frontend Memory settings page** (`sections/settings/MemorySection.tsx`): 4 sub-tab scopes at `:52-73` — Memories → `autoMemories`+`memory`; Facts & Rules → `facts`+`heuristics`; Timeline → `timeline`+`blackboard`; Sessions → `sessions`+`messages`+`exams`+`examAttempts`. **The junk KV keys are visible because the Memories tab browses the raw `memory` store.**

### 1.4 Delete / hygiene paths

| Path | File:line | Notes |
|---|---|---|
| Facts expiry boot sweep | `cognitive_boot.py:74-100` | `DELETE FROM facts WHERE expires_at <= datetime('now')`, once at startup |
| Per-fact forget (human) | `august.py:373-387` | one `facts` row + rollback snapshot |
| Per-row UI delete | `brain_config.py:101-117` → `brain.py:434-460` | facts/memory/timeline/autoMemories only; **heuristics → 403** |
| Session cascade | `memory_store/sessions.py:301-393` | 10 child tables per session |
| Privacy "erase memory" | `routers/privacy.py:164-178` (`_MEMORY_TABLES:48-54`) | wipes facts, auto_memories, learned_heuristics, proposals, timeline — **deliberately skips `memory_store` KV** (`:11,167-168`), so all `cognitive:*` / `boot_maintenance_state` blobs survive even a full erase |
| One-shot purge 023 | `migrations/023_memory_hygiene_purge.sql` | already applied; see §1.6 |

**No job ever cleans the dead-daemon KV keys.** 023 preserves them, privacy erase skips the KV table, and KV has no TTL. They accumulate forever. `timeline_sweep` (`rest.py:445`) and `vacuum` (`rest.py:396`) have no callers.

### 1.5 Junk inventory (verified against the live DB)

`memory_store` contents, 2026-08-27:

| Key | Writer | Reader | Verdict |
|---|---|---|---|
| `cognitive:consolidation:last_run` | deleted `consolidation_daemon.py:33,67` | none | pure junk |
| `cognitive:vector_reconciliation:last_run` | deleted `memory/vector_mirror.py:25` | none | pure junk |
| `boot_maintenance_state` | deleted `memory/auto_review_loop.py:32,59` | none | pure junk |
| `auto_memory_review_state` | deleted `auto_review_loop.py:181,193` | none | pure junk |
| `routing:auto-route:decisions` | no live reference | none | orphan |
| `self_evolution_log` | no live reference | none | orphan |
| `userProfile` | only renamed by `lib/storage_key_migration.py:22` | none | orphan |
| `agent_jobs` | `agent_registry.py:217,227` | `agent_registry.py:197-222` | **live — keep** |

`learned_heuristics`: 3 rows (ids 1/3/5), all `source='turn-lesson'`, `category='provider_reliability'` — "Turn failed on eval-model …", "Turn failed on deepseek-v4-flash-free via Opencode Zen …". Writer deleted; nothing injects them into prompts (the injector `memory/context_builder.py` was deleted); UI cannot delete them. Immutable junk.

Orphan tables with data (reader count verified by grep of `backend-py/app`, 2026-08-27): `curation_ledger` (240 rows, **0 readers**), `session_traces` (167, **0**), `harness_trends` (3, **0**), `vector_entries` (16, schema-only), `graph_entities/relations` (61/56, schema-only), `brain_events` (609, schema-only). **Live — do not drop:** `routing_evidence` (2 readers; feeds routing suggestions per AGENTS.md), `execution_state` (8), `scratchpad` (8), `exams` (4).

### 1.6 Why the junk persists (root-cause chain)

1. `4f1bfdb1` (0.17.0) deleted the cognitive writers but not their persisted state.
2. Migration 023 (`:15-16`) **falsely** says `boot_maintenance_state`, `auto_memory_review_state`, `cognitive:*last_run` are "written by live code" and keeps them. (Already applied — the fix must be a new migration, not an edit to 023.)
3. The Memory UI's Memories tab browses the raw KV store, so machine state appears next to user memories.
4. Privacy erase skips the KV table, so even "erase everything" doesn't remove them.
5. `memory_schema.py:438-498` recreates the four dead vector/graph tables on every boot.
6. `cognitive_config.py` still carries defaults for deleted subsystems (`consolidation`, `backfill_workbench`, `db_writer`, `vector_memory`, `graph_memory`, `heuristics`, `diff_learning` at `:22-46`); `get_boot_layers()` (`:235-238`) has no callers; `get_features()` is still read at `adapters/proxy_tools.py:147` and `workbench.py:2093-2096`.

### 1.7 Skills system findings

Storage & lifecycle (`app/services/skill_service.py`):

- Two roots: bundled `<repo>/skills` (`:21`) and agent `<dataDir>/skills` (`:24-32`); **agent root wins name clashes** (`:35-37`). One dir per skill with `SKILL.md`; frontmatter parsed line-by-line (not real YAML), six known keys (`:124-151`).
- **Enable/disable** (`setEnabled:507-532`): toggles `disabled` in frontmatter; **copy-on-write** (`_copyOnWrite:401-415`) copies the whole bundled skill into the agent root on first toggle — the copy then **permanently shadows** the bundled original.
- **Frontmatter loss:** `_renderSkillMd:379-388` emits only the six known keys — extra keys (e.g. `version`, `platforms` in `skills/august-harness/SKILL.md:5-6`) are **dropped on every rewrite**. `patchSkill` also force-stamps `created_by: agent` (`:482`).
- **PATCH double-write:** `PATCH /api/skills/{name}` (`routers/skills.py:79-93`) calls `setEnabled` *and then always* `patchSkill` — a toggle-only request writes the file twice.

Disabled-state leakage (the toggle doesn't do what it claims):

- `setEnabled`'s docstring claims disabled skills "are excluded from prompt injection" (`:510-512`); **no prompt path filters on enabled**. Disabled skills still appear in the `<intake>` manifest (`workbench.py:676-695,734`), the `<capabilities><skills>` catalogue (`workbench.py:805-820` → `capabilities_prompt.py:273-318`), the inlined `<harness_guide>` (`workbench.py:580-597`), `list_skills` without query (`skill_tools.py:30`), and `load_skill` (`:9-19`). Only queried `list_skills` → `search(enabledOnly=True)` excludes them (`skill_service.py:191-192`).
- `catalogue()` entries carry no `enabled` field at all (`:265-274`).

Dead machinery & junk:

- **`build_relevant_skills_block` does not exist** anywhere, yet the system prompt still promises a `<relevant_skills>` block (`capabilities_prompt.py:344,357-358,417`; `prompt_segments_cache.py:161`). Config knob `skillRelevanceMatch` (`brain_config_service.py:74-76`) has zero consumers.
- `prompt_segments_cache.get_skills_segments()` (`:117-165`) — no callers.
- **Stale cache:** `_bust_prompt_skills_cache` (`skill_service.py:288-309`) does not bust `workbench._caps_block_cache` / `_harness_guide_cache` (`workbench.py:581-582`), so after create/patch/delete/toggle the main agent's skill catalogue stays stale until the tool set changes or restart.
- **Orphaned skill dir:** `backend-py/skills/` (charts, circuit-sim, pptx-author, video-render) is scanned by nothing — `SKILLS_DIR` resolves to repo-root `skills/`. Four invisible skills.
- **Junk in agent root:** `data/skills/pending-turn-failed-on-*`, `pending-verifier-gate-*` (3 dirs) — the `pending-` prefix is produced by no code path; one has a name containing `:` that violates the service's own name rule (`:40`), but discovery doesn't validate.
- UI bug: delete-button guard checks `createdBy === 'builtin'` (`SkillsSection.tsx:226-234`) but no skill ever has that value — bundled skills get a Delete button that the server refuses (`skill_service.py:496-500`).
- No tests cover `setEnabled`/`enabledOnly`.

### 1.8 Session naming findings

The exact string the user sees — `Chat 2026-08-27 12:31 UTC` — is `_default_session_title()` at `workbench/sessions.py:244-247`, stamped at creation (`:808`). The frontend twin stamps `Chat <local time>` (no UTC) via `store/sessions/helpers.ts:17-23`.

A model-based auto-titler exists (`workbench/title_generator.py`) and runs fire-and-forget after every turn (`workbench.py:3599-3612`), using the **same provider/model as the chat turn**. It fails silently when:

- provider dict or model is empty (`:155-156`);
- `getClient` returns None (`:160-161`);
- **`resolveApiKey()` returns None** (`:162-164`) — this is the big one: keyless gateway providers (e.g. OpenCode Zen) have no resolvable key, so titling degrades for exactly the setup in use;
- all three call attempts raise (logged at debug only).

Fallback chain: LLM title → first-message snippet (`derive_title_from_message`, `sessions.py:270-287`, 48-char truncation; returns `''` for slash-commands/short messages) → **nothing**: the session keeps the timestamp forever. Guards skip titling after >2 user messages (`:280`).

**Live DB result: 21 of 23 sessions have `Chat 20…` placeholder titles.** Auto-titling is effectively broken for this installation.

### 1.9 Live bugs found (beyond junk)

1. **Memory add-box is broken:** `MemorySection.tsx:315` posts to `/api/memory/manage`, but the backend only mounts `/api/august/memory/manage` (`august.py:24` prefix + `:345`). No `/api/memory/*` route exists anywhere in the backend (verified by grep). Adding a memory from the settings UI 404s. (The import dialog uses the correct path.)
2. **Dead frontend Memory hub:** the entire `frontend/desktop/src/sections/memory/` tree (`Memory.tsx` + 8 tabs) polls nine deleted endpoints (`/api/brain/status|items|vectors|guidelines|graph|diagnostics|learning|prompt|search`, `Memory.tsx:34-82`). Its only referrer (`WorkspaceMemorySection.tsx`) is never imported — the whole tree is dead but shipped.
3. **Dead API clients:** `api-client/manage.ts:89-111` (`/api/memory/facts`) and `RightDrawerNotesSection.tsx:54` (`/api/memory/kv`) call routes deleted in `4f1bfdb1`.
4. **Orphan session-context endpoint** always returns None (`routers/workbench.py:1646-1655`).
5. **`main.py:229-238`** cancels `auto_review_task` / `boot_maintenance_task` that nothing ever sets.

---

## Part 2 — Removals (delete what's overcomplicated and doesn't work)

### 2.1 Data purge — new migration `025_memory_state_separation.sql`

```sql
-- 1. Dead-daemon state (023's "ALIVE" comment was wrong; writers deleted in 4f1bfdb1)
DELETE FROM memory_store WHERE key IN (
  'cognitive:consolidation:last_run',
  'cognitive:vector_reconciliation:last_run',
  'boot_maintenance_state',
  'auto_memory_review_state',
  'routing:auto-route:decisions',
  'self_evolution_log',
  'userProfile'
);
-- 2. Immutable legacy turn-lessons (writer deleted; nothing reads them; UI can't delete them)
DELETE FROM learned_heuristics WHERE source = 'turn-lesson';
-- 3. Dead tables (0 live readers verified 2026-08-27)
DROP TABLE IF EXISTS curation_ledger;
DROP TABLE IF EXISTS session_traces;
DROP TABLE IF EXISTS harness_trends;
DROP TABLE IF EXISTS vector_entries;
DROP TABLE IF EXISTS graph_entities;
DROP TABLE IF EXISTS graph_relations;
DROP TABLE IF EXISTS graph_observations;
```

Keep: `agent_jobs`/`agents:*` KV (live), `routing_evidence`, `execution_state`, `scratchpad`, `exams` (live readers). `brain_events` (609 rows, schema-only reader): **audit before drop** — confirm `008_brain_events` has no harness consumer, then drop in the same migration if clear.

Companion code changes:
- Delete `create_vector_graph_tables` call + function (`memory_schema.py:438-498,:435,:636`); delete the `graph` store stub (`brain.py:113-115`).
- Remove the `autoMemories` store from `_BRAINStores` (table is purged, writer deleted, FTS triggers dead) — or keep the empty table for one release with a deprecation note. **Recommendation: remove from UI scopes now, drop table in 026.**
- Privacy erase: add `memory_store` keys with a **keep-list** (`agents:*`, `agent_jobs`) to `_MEMORY_TABLES` handling (`privacy.py:48-54,164-178`), so "erase memory" actually erases memory-adjacent KV.

### 2.2 Dead backend code to delete

| Item | Location |
|---|---|
| Async write queue (252 lines, zero callers) | `app/services/db_writer.py` + stats read in `routers/monitoring.py:69-71` |
| Session sync/backfill (no callers) | `workbench/brain_sync.py:132,185` (keep `get_sync_stats` if `main.py:463` needs it, else delete module) |
| `timeline_sweep`, `vacuum` (no callers) | `memory_store/rest.py:445,396` |
| Unused KV helpers | `kv.py` `delete_memory/list_memory/search_memory` (UI uses `brain_*`) |
| Ghost task cancellation | `main.py:229-238` |
| Cognitive config ghosts | `cognitive_config.py`: `consolidation`/`backfill_workbench`/`db_writer` boot flags, `consolidation_interval_s`, feature flags `vector_memory`/`graph_memory`/`heuristics`/`diff_learning`/`skill_genesis`, `get_boot_layers()` |
| Orphan endpoint | `routers/workbench.py:1646-1655` (session-context) |
| **Model-eval `benchmark` agent mode** (per user direction 2026-08-27: "just for models and even useless") | Backend: `harness_mode.py:88-109` (`BENCHMARK_ALLOWED_TOOLS`, `is_benchmark_mode`, `filter_benchmark_tools`, `benchmark_block_message`); `routers/workbench.py:1848-1849` (drop `'benchmark'` from the agentMode tuple + error text); `workbench.py:617-623,734,741,808,1140-1149,2022,2736-2762,2788` (all `is_benchmark` branches). Frontend: `HarnessModeChip.tsx:3,8`, `WorkbenchModeSelector.tsx:119` (drop the Benchmark option). **Not replaced by anything here** — the harness-competition headless entry (§9.3 #1) runs the *full* `agent` harness, which is the opposite design |
| Stale snapshot | `backend-py/build/` — delete the whole directory (contains every deleted module; constant grep-confusion source) |
| Orphan data files | `data/august_graph_memory.json`, `data/memory.md`, root `NUL` file |

### 2.3 Dead frontend code to delete

- `frontend/desktop/src/sections/memory/` (entire tree) + `WorkspaceMemorySection.tsx` + `KnowledgeGraph.tsx`.
- `api/api-client/manage.ts:89-111` (`/api/memory/facts`).
- `RightDrawerNotesSection.tsx:54` `/api/memory/kv` call (fix to a live endpoint or remove the feature).
- `deriveSessionTitleFromMessage` (`store/sessions/helpers.ts:156-169`) — dead export (superseded by the §3.8 fix).
- `prompt_segments_cache.get_skills_segments()` + orphan constants `_SKILL_RELEVANCE_LIMIT/_MIN_RELEVANCE_SCORE/_SKILL_STOP_TOKENS` (`capabilities_prompt.py:320-334`) — unless §3.7 implements `<relevant_skills>` (recommendation: implement it with the existing BM25; then keep).

### 2.4 Skills junk

- Delete `data/skills/pending-*` dirs (3) — produced by no code path.
- Decide `backend-py/skills/` (4 orphan skills): **Ruled (Q3): move `circuit-sim` and `charts` into repo-root `skills/`**, delete `pptx-author`/`video-render`.

---

## Part 3 — Knowledge-base redesign

### 3.1 Principles

1. **Machine state is not memory.** Internal bookkeeping (last-run stamps, job state) lives in a separate store the Memory UI never shows.
2. **One durable store, typed and titled.** `facts` becomes the single user/model-visible memory store. Every entry: human-readable text, `kind`, `source`, `created_at`, optional `expires_at`, `use_count`/`last_used_at`.
3. **Every entry has a writer and a reader — or it gets deleted.** The failure mode audited here was writer-removed, state-kept, nothing-reads.
4. **Learning = telemetry + curated lessons, not free-text rules.** Failures are recorded as structured outcomes; only promoted, deduplicated, human-legible lessons reach memory.
5. **Retrieval must inject.** Memory that is never surfaced to the model might as well not exist. Today only ~250 tokens of fact *names* are injected.

### 3.2 M1 — Separate state from memory

- New table `internal_state (key TEXT PRIMARY KEY, value TEXT, updated_at)` in `memory_schema.py`; future maintenance/cron/daemon state writes go here.
- `memory_store` keeps only registry data (`agents:*`, `agent_jobs`) and future user-facing KV.
- `_BRAINStores` does not expose `internal_state`; Memory UI never sees it.
- Settings gets a single **"Raw state lookup"** text field (read-only query on `internal_state` + `memory_store`) for debugging — replaces the need to ever surface this junk in Memory (§5.5).

### 3.3 M2 — `facts` as the one durable memory store

Schema additions (migration 026): `facts.title TEXT` (short human label), `facts.kind TEXT DEFAULT 'fact'` (`fact | lesson | preference | skill-note`), `facts.use_count INTEGER DEFAULT 0`, `facts.last_used_at TEXT`. Keep `expires_at`, `source`, `confidence`.

- `remember` tool: require/derive a short `title` (the readability ruling of 2026-08-26 asked for ZCode-style titled entries); key derivation stays.
- Memory UI renders `title` + body + kind chip + relative date (mockup §5.1).
- Deprecate user-facing KV writes entirely; `save_memory` becomes internal-only (rename to `save_internal` to make misuse obvious).
- Heuristics: after the 025 purge of turn-lessons, **allow UI delete** of any remaining rows (remove the 403 at `brain.py:442-443,471-472` for delete only; keep write-prohibition), then drop `learned_heuristics` in 026 if empty. "Read-only legacy" should mean *no writer*, not *undeletable*.

### 3.4 M3 — Retrieval that actually injects

Today: top-15 fact names + 5 timeline summaries, ~250 tokens, keyword-blind (`brain.py:361-399`).

Proposed:
- Reuse the existing pure-Python BM25 (`app/services/tools/retrieval.py`) — index `facts` (title+body) at boot and on write.
- Each turn, retrieve top-k (k=5) facts relevant to the **current user message**; inject as `<memory>` block (~400-token cap) with title + body, not just names. Keep the existing `brain_index_snippet` as fallback when the message is empty/short. **Cache policy (T12):** the `<memory>` block must be appended at the *tail* of the turn context (with/after the user message), never inserted into the system prompt or mid-history — mid-session system-prompt mutation breaks the provider prefix cache every turn (cache-stability rule; §8 Q14).
- **Usage feedback loop:** when an injected fact is referenced (model quotes its title/key, or `remember` updates it), increment `use_count`/`last_used_at`. BM25 rank gets a small `use_count` boost. This is the cheapest real "learns what's useful" signal available without embeddings.
- No embeddings/vector store — the vector tables are dead for a reason; BM25 over a few hundred facts is exact enough. Revisit only if the store outgrows ~2k entries.

### 3.5 M4 — Consolidation v2 (minimal, audited)

The deleted consolidation daemon was a stateful multi-job machine. Replace with **one scheduled job** (cron scheduler already started by `cognitive_boot.py`):

- Runs daily (configurable in brain-config). State = one row in `internal_state` (never in memory).
- Steps: (a) expire `facts` past `expires_at` (also keeps the boot sweep); (b) detect near-duplicate facts (normalized-key equality + BM25 self-similarity > threshold) → merge into the newer, append merged-from note; (c) detect same-key contradictions → keep newest, mark older `superseded` (new `facts.status` column) rather than delete; (d) `VACUUM` if DB > threshold.
- Every action writes one `lifecycle` row (existing table) so the UI can show a **consolidation log** ("merged 2 duplicates, expired 1 fact") — this is the "analysis" surface, replacing the deleted diagnostics endpoints.
- Optional model-assisted summarization of merged entries behind a brain-config flag (cost callout: one cheap-model call per merge; default off). **Ruled (Q5): approved** — implement the flag, default off.

### 3.6 M5 — Turn outcomes as telemetry, not memory

The deleted turn-lessons failed because free-text failure rules ("Turn failed on deepseek-v4-flash-free…") are not actionable memory. Replace with structured telemetry:

- New table `turn_outcomes (ts, model, provider, task_type, ok INTEGER, error_class, duration_ms, session_id)` — append-only, retained 30 days.
- Written where the old `_record_turn_lesson` hook was (turn `finally` block, `workbench.py`), one row per turn, no model calls.
- Consumers: routing evidence (existing `routing_evidence` machinery per AGENTS.md already wants ≥3 samples for suggestions), and a harness self-improve stat ("error rate by model, last 7d"). Never injected into prompts, never shown in Memory UI — it is diagnostics, surfaced in the Observability hub only.
- If a specific model/provider fails repeatedly (≥N in window), the job may promote **one** typed `lesson` fact ("Provider X returns 400 on session_id:null — use exclude_none dumps") via the normal gated `remember`-style write with `source='harness'` — human-visible, deletable, expirable. This is the only path from failure to memory.
- **Ruled (Q2), with two conditions:** telemetry + rare promoted lessons stay, but (a) **every candidate lesson passes a model review before storage** — one cheap-model call answering "is this actionable, non-obvious, durable, and not already known?" with a discard-default; and (b) **strict necessity filter** — dedupe against existing facts (BM25 similarity > threshold → discard), reject transient/obvious/one-off content, cap lesson length. The explicit goal: no unnecessary information ever reaches the store (the turn-lesson junk of §1.5 is the anti-pattern).

### 3.7 M6 — Skill hygiene fixes

1. **Enforce disabled everywhere:** filter `enabled` in `catalogue()` (add the field), `<intake>` manifest, `<capabilities><skills>`, `<harness_guide>` (skip disabled harness skills), `load_skill` (refuse disabled with a clear message), `list_skills` both paths. One predicate: `skill_service.isEnabled(name)`.
2. **Bust the right caches:** `_bust_prompt_skills_cache` must also clear `workbench._caps_block_cache` and `_harness_guide_cache`. Collapse the three overlapping caches into one.
3. **Preserve unknown frontmatter:** `_renderSkillMd` round-trips unrecognized keys (store them in a `meta` dict during parse).
4. **PATCH single-write:** `routers/skills.py:79-93` — one file write per request.
5. **Validate on discovery:** skip+log skills with invalid names (kills the `pending-*` junk visibility permanently).
6. **Implement `<relevant_skills>` or delete the promise:** implement `build_relevant_skills_block` with the existing BM25 over skill descriptions (top-3, ~150 tokens), honoring `skillRelevanceMatch`; or remove the prompt text at `capabilities_prompt.py:357-358`. Recommendation: implement — it's ~30 lines with existing infra and directly helps future models pick skills.
7. **UI:** fix the `'builtin'` delete-guard to check `createdBy` empty/bundled origin; add tests for `setEnabled` round-trip incl. frontmatter preservation.

### 3.8 M7 — Session titling that works

1. **Immediate snippet title:** when the first user message arrives, call `derive_title_from_message` (`sessions.py:270-287`) synchronously and rename — don't wait for turn end. This alone fixes the visible problem for all non-slash-command chats.
2. **Fix the LLM titler's key resolution:** `_llm_title` (`title_generator.py:147-231`) should reuse the turn's already-authenticated client instead of re-resolving `apiKey` (keyless gateways fail at `:162-164`). Pass the client (or a `generate` callback) from `schedule_auto_title_after_turn` (`workbench.py:3599-3612`).
3. **Optional `titleModel` brain-config:** route titling to a configured cheap model when set; fallback to the turn model.
4. **Kill the timestamp placeholder:** creation title becomes `New chat` (backend `sessions.py:244-247` and frontend `helpers.ts:17-23`); update both placeholder regexes. Timestamps-as-names disappear entirely.
5. Log titling failures at warning (not debug) so silent breakage is visible.

### 3.9 Future features (proposals, not scheduled)

- **Memory changelog & rollback UI** — rollback records already written by `remember`/manage (`session_tools.py:159-169`); surface "history → restore" in the Memory page.
- **Per-workspace memory scoping** — `facts.workspace_path` column; inject workspace facts first, global facts second.
- **Export** — import exists (`/api/august/memory/import`); add MD/JSON export (symmetry with ZCode's file-based memory).
- **Memory health card** in Observability — counts by kind, orphans detected, last consolidation run, facts expiring soon.
- **Episodes → summaries** — `episodic_timeline` gets per-turn rows but nothing curates them; consolidation v2 could summarize last-N episodes into a weekly `episode-digest` fact.

---

## Part 4 — Minimal-output transcript design

### 4.1 Rendering rules (formalized from your spec)

One rule: **the transcript shows what happened, nothing more.** Each tool call renders as one compact row; raw output never streams into the transcript.

```text
  ▸ read   memory/consolidation.py                  ✓ done        0.4s
  ▸ grep   "provider_reliability"                   14 matches    ▾
  ▸ edit   router.py                                +18 −6        ▾ diff
  ▸ bash   python -m pytest -x                      ✗ FAILED      ▾  AssertionError: expected 200…
```

| Tool class | Row content | Expanded by default | Expandable |
|---|---|---|---|
| **Read** (`read_file`, `list_*`, `context_read`, `grep`/search-file) | `read <file>` — dimmed; duration only if >1s | never | no |
| **Command** (`run_command`, bash) | the command, monospace | never on success | success: no · failure: yes (full stdout/stderr behind click) |
| **Web search** | query → `N hits` | **yes** — top 3-5 hits, capped, "view all" → drawer | yes |
| **Edit** (file writes/patches) | file chip + `+N −M` | **yes** — diff, capped ~100 lines, "view all" | yes |
| **Memory write** (`remember`, `save_fact`, `forget`) | entry title | **yes** — saved entry text (edit-class exception) | yes |
| **Status pill** | green `✓ done` / red `✗ failed` + duration | — | — |
| **Failure** | red pill + **first line of error inline** (≤120 chars) | error line yes · full output no | yes |

Grouping & structure:
- **Consecutive reads of the same file collapse**: `read consolidation.py ×4`.
- **Multi-step turns render as a plan tree** anchored on `update_state(phase, step)` SSE events (which exist purely as progress tracking per AGENTS.md): indent tool rows under the current reasoning step, highlight the active step, auto-collapse finished subtrees. Fallback: flat list when the model emits no phases (must degrade gracefully — many models won't emit them).
- **One red line for mid-chat failures**: `eval-model stalled · switching to deepseek-v3`. No banners, no paragraphs.

### 4.2 Corrections & reconciliations (where I'm pushing back)

1. **Your spec contradicts itself on errors.** Version A: "stderr/stdout lives behind the row, expanded only on click — *including failures*, so users must opt in to see errors." Version B: "Failed commands are the only place output appears automatically (red + the error inline)." **Resolution:** red `✗ FAILED` pill + **first line** of the error inline (that *is* the error in 90% of cases — `AssertionError: …`, `ModuleNotFoundError: …`), full stdout/stderr behind the click. Hiding the error line entirely (version A) is hostile: the user can't tell *why* it failed without clicking every red row, and the harness itself often needs the user to see it. Keep version B, capped at one line.
2. **"Anything the harness depends on to decide next steps (test output summaries) can show a one-line digest"** — define this narrowly or it becomes a loophole that re-opens the flood. Proposal: only a **structured** digest parsed from output (pytest's `X failed, Y passed in Zs` last line) may render, and only on failure. No free-form output.
3. **Search results stay inline** (your new spec) — this supersedes the earlier plan note that demoted web-search hits to the drawer. Cap at 5 hits + "view all".
4. **"No panels, no tabs, no status bars visible by default"** — applied to the transcript, yes. But do not strip the composer chrome (workspace chip, context %, access mode, model selector): those are *controls*, not noise, and removing them makes the app less beginner-friendly, not more. The right drawer stays as the opt-in depth surface — it *is* the "/verbose" destination. Add a literal `/verbose` chat command that toggles inline raw output for the current session when debug depth is needed, instead of shipping a permanent panel.
5. **Color-only meaning is an accessibility failure.** Keep the `✓`/`✗` glyphs (your mockups already have them — good), and add the error count to the turn summary line (`Task completed · 11 steps · 1 failed`) so failures are visible when collapsed.
6. **Hover-revealed `⋯` menus don't exist on touch** — there is a mobile app (`frontend/mobile`). Render `⋯` always, dimmed to 40% opacity, brightening on hover. Same for memory rows.
7. **Plan tree feasibility flag:** the tree is only as good as the model's `update_state` discipline. Ship the flat minimal rows first (that's the whole win), add the tree as a second step with graceful fallback, and never require the tree for correctness.
8. **Reloaded sessions must render identically** — persisted messages replay through `getDisplayBlocks` (`message-blocks.ts:61-146`); the minimal style must be a property of the *renderer*, not of live-stream state, or history will show the old verbose cards.

### 4.3 Implementation map (frontend)

Data layer unchanged — `toolResult` SSE keeps full `content` (≤100 KB), client stores keep `summary`/`toolResults` (`makeStreamHandlers.ts:444-446,478`); drawer/trajectory keep full output. This is rendering policy only.

| File | Change |
|---|---|
| `lib/tool-classify.ts` | Add buckets: `memoryWrite` (`remember\|memory_write\|forget\|save_fact`), keep `edit`, `view`, `command` |
| `components/chat/tool/ToolCallItemBody.tsx` | Delete generic `FormattedResultSection` (`:253-266`) for everything except `memoryWrite`; keep context/args, errors, approval, setup widgets |
| `components/chat/tool/CommandOutputPane.tsx` | Success: command line + green pill only. Failure: + one red error line; full output behind click |
| `components/chat/ToolStepRow.tsx` | `hasExpandableContent` (`:169-187`) false for read/success-command rows → no chevron; duration shown only if >1s for reads |
| `sections/chat/message/AssistantBlockTimeline.tsx` | Route `memoryWrite` to new `MemoryEditRow` (peer of `EditRailRow`); auto-expand edit diffs + search hits (capped); consecutive-same-file read grouping; plan-tree grouping by `update_state` phases (step 2) |
| `sections/chat/makeStreamHandlers.ts` | Emit structured digest for failed commands (pytest-style last line); track consecutive reads for grouping |
| `sections/chat/message/ToolCallCard.tsx` | Legacy `role:'tool'` path: invocation + pill only (drop verbatim dump `:147-160`) |
| Backend `workbench/workbench.py` | Emit `memoryUpdated` after successful memory writes (activate the dormant path below) |
| `api/workbench/streamEvents.ts` + `api/schemas/workbench.ts` + `stream/append-block-event.ts:116-132` | Wire the **dormant** `memoryUpdated` → `memoryNotice` block path (reducer already handles it; nothing emits or renders it today) |

### 4.4 Tests to update

- `AssistantBlockTimeline.test.tsx:154-187` ("expands to reveal response" → non-expandable chip), `:244+`/`:420+` view-tool assertions.
- `ToolStepRow.test.tsx:105-124` (toggle-with-summary → no chevron).
- `CommandOutputPane.test.ts` (stdout-cleaning → header/pill assertions; failure one-liner).
- New: memory-write row renders entry; failed command shows one error line + expandable full output; read grouping `×N`; reloaded session renders minimal style.
- Keep `append-block-event` summary-merge tests (data layer unchanged).

### 4.5 Unified Changes card (ZCode-style, rev. 2 — type-aware rows)

Replace `ChangedFilesCard` and `ProducedFilesRow` with one unified `ChangesCard` matching the ZCode reference screenshots: a collapsed aggregate row — `X files changed  +N −M  [Undo]` — expanding to **type-aware per-file rows**:

- **Code files** (`.py`, `.ts`, `.json`, …) → small `FileIcon` + filename + per-file `+N −M` chip + **Review** + **Open**. Review appears only when diff data exists for the path.
- **Document files** (`.md`, `.txt`, `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.html`, images, video) → **big 56×56 square letter badge** (e.g. `M↓`, `PDF`) + filename + kind label (`Document · MD`, `Image · PNG`) + single **Open ▾** (no Review).

Always visible when any edit tool ran in the turn, **including during streaming** (files arrive in real time; drop the `ProducedFilesRow` streaming guard).

**Relation to §4.1:** the card is the turn-level aggregate + undo affordance; the per-file edit rows in the timeline stay the in-flow detail. To avoid double-diff noise, the card's per-file inline diff defaults to collapsed (`expandedFiles` starts empty). This supersedes the original Phase-1 note that said to keep both cards.

**Files to change:**

- **NEW** `frontend/desktop/src/lib/file-kind.ts` — `classifyFileKind(path) → { kind, label, badgeText, badgeTone }` (`code | document | image | video | pdf`), lifted from the `kindLabel` block at `ProducedFilesRow.tsx:53-64`; plus `openFileInDrawer(path)` extracted from `ProducedFilesRow.openFile` (`:34-51`).
- **NEW** `frontend/desktop/src/components/chat/DocumentBadge.tsx` — 56×56 rounded square badge, two-letter glyph, tone keyed off kind. No badge/kind helper exists anywhere in the tree today (verified) — greenfield.
- **NEW** `frontend/desktop/src/components/chat/ChangesCard.tsx` — the unified card.
- **NEW** `frontend/desktop/src/lib/git-revert.ts` — `useRevertAllChanges(sessionId, fileCount)` extracted from `components/shell/RightDrawerDiffSection.tsx:56-97` so the card's Undo and the drawer's Revert-all share one code path.
- **DELETE** `frontend/desktop/src/components/chat/ChangedFilesCard.tsx` and `ProducedFilesRow.tsx` — verified: only `AssistantMessageContent.tsx:2-3,116,123` imports them; remaining mentions are comments only (`lib/produced-files.ts:4`, `RightDrawerArtifactsSection.tsx:4`, `RightDrawerCircuitSection.tsx:4` — update those comments).
- **EDIT** `frontend/desktop/src/sections/chat/message/AssistantMessageContent.tsx:113-124` → single `<ChangesCard blocks={message.blocks} changedFiles={message.changedFiles as GitDiffResult | null} />`; drop the streaming guard; keep `CircuitArtifactCard` (:128-130) untouched.
- **EDIT** `frontend/desktop/src/components/shell/RightDrawerDiffSection.tsx` — `handleRevertAll` (:58) becomes a call into the hook; **Keep all** (:50, :128) and **Refresh** (:118-121) buttons stay.
- **NEW** `frontend/desktop/src/components/chat/__tests__/ChangesCard.test.tsx`.

**Component design (`ChangesCard`):**

Props: `blocks?: MessageBlock[] | null` (always available; powers the file list via `collectProducedFiles`), `changedFiles?: GitDiffResult | null` (optional; enriches with +/- counts and diff text), optional `onReview`/`onOpen` overrides, `className`.

State: `expanded: boolean` (default `true` if ≤3 paths, else `false`); `expandedFiles: Set<string>` (default empty); `reverting: boolean`.

```text
Aggregate header (always visible):
[chevron]  X files changed   +N added  -M removed                    [Undo]

Code row (kind === 'code' AND path in changedFiles.files):
[icon] path/to/file.py                 +12  -3     [Review]  [Open]
        ↳ collapsible inline DiffView (only when expandedFiles.has(path))

Document row (kind !== 'code' OR no diff data):
[M↓]  path/to/file.md
      Document · MD                                        [Open ▾]
```

- Header click toggles `expanded`; Undo is a real `<button>` with `stopPropagation`, disabled while `reverting` (spinner replaces the `Undo2` icon).
- Totals computed only from `changedFiles.files`; omit totals rather than zero them when no file has diff data.
- Per file: `+N −M` chips only on a `changedFiles.files` map hit; inline `<DiffView diff={file.diff} maxLines={32} />` only for code rows when `expandedFiles.has(path)`; cap 8 rows then `+N more`.
- **Review** → `setRightDrawerDiff(changedFiles, path)` + `openRightDrawer('diff')`.
- **Open** → `openFileInDrawer(path)` (`ChatAttachmentService.fromPath` → `openRightDrawerFile`, `revealInFolder` fallback). Document rows: row click and the Open button are the same action.
- **"Open ▾" chevron is a visual affordance only** (matches the reference) — it is not a dropdown; keep a plain `Button variant="outline" size="sm"` with `ChevronDown` so it doesn't imply a menu.
- **Undo** → `useConfirmDialog` (destructive) → hook below.
- Data merging: paths always from `collectProducedFiles(blocks)`; `changedFiles` builds a `Map<path, GitDiffFile>`; each row merges the map hit with `classifyFileKind(path)`; render `null` when both inputs are empty.

**`useRevertAllChanges(sessionId, fileCount)`** (extracted from `RightDrawerDiffSection.handleRevertAll`):

1. Noop when `!sessionId`, `fileCount === 0`, or already reverting.
2. `resolveWorkbenchSessionId(sessionId)` → `listWorkbenchCheckpoints(wbId).catch(() => [])`.
3. Checkpoint exists → confirm "Revert all N changed file(s) back to the last save point?" → `restoreWorkbenchCheckpoint(wbId, latest.id)`.
4. None → confirm "No save point found. Discard changes to N tracked file(s) with git restore?" (wording notes untracked files are not removed) → `gitApi.command(['restore', '--', '.'], sessionId)`.
5. Toast success/failure; `invalidateQueries(['git', 'diff', sessionId])`.

**Verified reuse points (2026-08-27, all confirmed in tree):**

| Piece | Location |
|---|---|
| `collectProducedFiles` | `lib/produced-files.ts:17` |
| `producedFileLabel` | `lib/produced-files.ts:46` |
| `kindLabel` source block | `ProducedFilesRow.tsx:53-64` |
| Open flow source | `ProducedFilesRow.tsx:34-51` (`fromPath` :38, `openRightDrawerFile` :41, `revealInFolder` fallback :43) |
| Review flow | `ChangedFilesCard.tsx:81-84` |
| Revert-all logic | `components/shell/RightDrawerDiffSection.tsx:56-97` (`reverting` state :30, `resolveWorkbenchSessionId` :60, `listWorkbenchCheckpoints` :64, confirm :68, `restoreWorkbenchCheckpoint` :74, `gitApi.command(['restore','--','.'])` :84) — file lives in `components/shell/`, not `sections/drawer/` |
| Keep all / Refresh (stay) | `RightDrawerDiffSection.tsx:50,128` / `:118-121` |
| `useConfirmDialog` | `hooks/useConfirmDialog.ts:25` |
| `DiffView` + `maxLines` | `components/chat/DiffView.tsx:132,168` (default 40) |
| `GitDiffFile` / `GitDiffResult` | `api/git.ts:12,24` |

**Caveats:**

1. The `git restore -- .` fallback **does not remove untracked new files** — only the checkpoint path undoes file creation. Rev.-2 confirm wording already encodes this ("tracked file(s)"); keep it.
2. Undo enablement: keep the button enabled whenever paths/changedFiles are non-empty; resolve checkpoint availability on click (the flow already catches an empty list). No async disabled-probe.
3. Streaming: the card appears as soon as the first edit block lands; totals settle when `changedFiles` arrives post-turn.
4. **Kind-mapping gap:** the existing `kindLabel` returns the raw extension for `.md`/`.txt` (no Document entry) — the new `file-kind.ts` must add text/document kinds so the row reads `Document · MD` as in the reference screenshot.
5. Badge glyph for `.md` shows `M↓` in the reference — keep the down-arrow glyph convention (download/document metaphor) consistent across document kinds.

**Tests** (`ChangesCard.test.tsx`): renders `null` when both inputs empty; header with count + totals from edit-tool blocks; expands to one row per file; code row (`.py`) shows Review + Open; document row (`.md`) shows badge + kind label + single Open (no Review); per-file `+N −M` only when path is in `changedFiles.files`; inline diff toggle for code rows; Undo confirms + `restoreWorkbenchCheckpoint` when a checkpoint exists, falls back to `gitApi.command(['restore','--','.'])` when none; `+N more` above cap 8.

**Validation:** `cd frontend/desktop && npx tsc --noEmit` clean; `npx vitest run` green + zero remaining `ChangedFilesCard`/`ProducedFilesRow` references; manual in `npm run dev:desktop` — a turn that writes code **and** a `.md` file shows the collapsed `X files changed +N −M` row with Undo, expanding to a code row (Review/Open) and a document row (big badge, `Document · MD`, Open only).

**Out of scope (deferred):** right-click context menu (Reveal in Explorer / VS Code / Cursor / Copy paths), composer "Changes +N −M" chip, per-file undo, regenerate-file action.

---

## Part 5 — UI/UX proposals

### 5.1 Memory page — flat list, no cards, no meters

Replaces the raw-store tabs inside the existing memory hub (the 8-hub IA and its 4 store-scoped sub-tabs stay — §6; the *content* becomes human-readable per the 2026-08-26 readability ruling).

```text
MEMORY & STORAGE                                    [ Search memory… ]  [ + Add ]

  lesson · "eval-model stalls on long test suites"         8d ago      ⋯
  fact   · "Default baud rate: 115200"                     3d ago      ⋯
  pref   · "Prefers metric units in schematics"            1d ago      ⋯
  ─────────────────────────────────────────────────────────────────────
  expired · 2 · duplicates merged · 1        last consolidation 6h ago
```

- One flat chronological list across kinds; filter chips (`all / facts / lessons / prefs / expiring`) above, not tabs.
- Row = kind chip · title · relative date · dimmed `⋯` (view / edit / delete / history).
- No strength meters, no confidence bars — confidence stays in the raw view.
- Hairline divider above a one-line **health footer** (counts + last consolidation — the §3.5 audit surface).
- Sessions/Timeline remain as the other sub-tabs (raw but readable), Data & Privacy stays in system hub per standing ruling.
- **Fix the add-box 404** (`MemorySection.tsx:315` → `/api/august/memory/manage`) as step zero.

### 5.2 Sessions

```text
  Fix memory consolidation          3d ago
  Refactor provider router          Aug 24
  UART testbench review             Aug 21
```

- Title from first real message immediately (§3.8), model-refined after the turn when the provider allows.
- Never timestamps-as-names; `New chat` until the first message.
- Relative dates in the list, absolute on hover. (Temporal grouping **replaces** folder IA per the Q4 ruling; folder context stays via the existing folder chip.)

### 5.3 Failures mid-chat

One red line, max: `eval-model stalled · switching to deepseek-v3`. No banners with paragraphs. Tool failures follow §4.1 (red pill + one error line).

### 5.4 Visual budget

- Green and red carry the only color meaning; `✓`/`✗` glyphs duplicate it for color-blind users.
- Sans-serif prose; monospace only for commands, file paths, diffs.
- Hairline dividers, no boxes, no cards in the transcript.
- Dimmed-by-default chrome (timestamps, durations, `⋯`) brightens on hover.

### 5.5 Settings — raw state lookup

One text field in the memory hub footer or system hub: type a key, get the raw `internal_state`/`memory_store` row. This is the only place `cognitive:*`-style machine state is ever visible — never quarantined into Memory, never rendered by default.

---

## Part 6 — Carried-over phases from the original plan (status)

| Phase | Status | Note |
|---|---|---|
| 1A — Timeline Rail + turn-stats-footer removal | **Green** | Line numbers verified ±2; also update `docs/ARCHITECTURE.md:422` + `docs/settings-audit.md:28` |
| 1B — Tool invocation-only rendering | **Superseded by §4** | The minimal-output design replaces it |
| 2A.1 — SPICE infix (`4k7`) | **Confirm** | Current rejection is deliberate policy (`circuit_tools.py:254,312`); lint text must change with it |
| 2A.2 — Topological placement | **Green** | |
| 2A.3 — Component library expansion | **Green** | |
| 2B — `hdl_simulate`/`vcd_parse`/`fpga_verify_qsf`/`arduino_compile_sketch` | **Green with registration plan** | Must update `tool_registrations/circuit_tools.py` + `tool_policy.py` + parity oracle + prompt hint |
| 3 — Right-drawer renderers | **Reframe** | Drawer has 11 sections (`RightDrawer.tsx:259-271`), not 5; add renderer tabs, don't rebuild |
| 4 — Sidebar temporal grouping | **Ruled (Q4): replace** | Temporal grouping replaces folder IA; folder context stays via the folder chip |
| 5 — Settings 5-hub consolidation | **BLOCKED** | Conflicts with the 2026-08-26 ruling: 8 hubs/39 sections, `settings-registry-audit.test.ts:32` asserts `toHaveLength(8)`, privacy stays in system. Do not implement without an explicit superseding ruling |

---

## Part 7 — Verification plan

**Backend:**
```bash
cd backend-py && uv run ruff check . && uv run mypy app/ && uv run pytest -q --basetemp="$TEMP/august_pytest"
```
- New tests: migration 025 idempotence + keep-list (`agent_jobs` survives); `internal_state` isolation from `_BRAINStores`; BM25 fact retrieval injection; consolidation merge/contradiction; `setEnabled` exclusion across all prompt paths; title fallback chain (keyless provider → snippet → `New chat`).
- DB assertions after 025: `memory_store` contains only `agents:*`/`agent_jobs`; `learned_heuristics` empty of turn-lessons; dead tables gone.

**Frontend:**
```bash
npm run test:frontend   # + tsc; eslint has pre-existing errors at HEAD — compare before blaming
```
- Updated/new tests per §4.4; settings-registry audit must stay green (8 hubs).

**Manual matrix:**
1. Memory UI: no `cognitive:*`/`boot_maintenance_state` rows anywhere; add-box saves (no 404); flat list renders kinds + health footer.
2. Transcript: read/command/search/edit/memory rows per §4.1 table; failed command shows one red error line; `×N` read grouping; reloaded session identical; `/verbose` toggles raw output.
3. Sessions: new chat shows `New chat` → snippet title on first send → model title when provider supports it; no `Chat … UTC` ever.
4. Skills: disabled skill absent from `<intake>`, `<capabilities>`, `list_skills`, `load_skill`; toggle no longer drops unknown frontmatter; catalogue fresh after edit (no restart).
5. Changes card (§4.5): a file-writing turn shows the unified card (collapsed, correct totals once the diff lands); code rows show Review + Open with per-file `+N −M`; document rows (e.g. `.md`) show the big badge + `Document · MD` label + Open only (no Review); Review opens the drawer diff at that file; Open opens the file viewer; Undo restores via checkpoint (or `git restore` fallback) after confirm; card visible during streaming; `ChangedFilesCard`/`ProducedFilesRow` gone with zero dangling imports.

---

## Part 8 — Rulings (issued 2026-08-27)

All 15 questions ruled via structured Q&A. Decisions below are the implementation green light for their slices; conditions are binding.

1. **Error display — RULED: first error line inline.** Red ✗ pill + first error line (≤120 chars) inline; full output behind click.
2. **Turn outcomes (§3.6) — RULED: telemetry + rare lessons, with conditions.** Keep structured failure telemetry + promoted lessons, but every candidate lesson is **model-reviewed before storage** and a **strict necessity filter** blocks unnecessary information (see §3.6).
3. **`backend-py/skills/` orphans — RULED: move 2, delete 2.** `circuit-sim` + `charts` → root `skills/`; delete `pptx-author` + `video-render`.
4. **Sidebar — RULED: temporal grouping replaces folder IA.** Folder context stays visible via the existing folder chip.
5. **Settings Phase 5 — RULED: stays blocked.** 8-hub ruling stands; audit test keeps `toHaveLength(8)`.
6. **`exams`/`blackboard` stores — RULED: keep.** Verified live; keep surfacing in the Memory Sessions tab.
7. **Consolidation model calls (§3.5) — RULED: optional cheap-model summarization**, behind a brain-config flag, default off.
8. **`brain_events` — RULED: drop with migration 025.** Zero harness consumers confirmed.
9. **"orcacode" target — CORRECTED: OrcaCode Review** (`Continuum-AI-Corp/orca-code-review`), the AI code-review pipeline — **explicitly NOT OpenCode**. The §9.0 misresolution is fixed; the OrcaCode deep-dive and what to implement from it is now **Part 10**. The OpenCode/wider-field adoptions (§9.3/§9.4) remain as independently-motivated benchmark levers, not as the meaning of "orcacode".
10. **Completion checklist (§9.3 #5) — RULED: model's own self-check, never a gate.** Nothing resembling a critic gate or answer-withholding (2026-08-24 ruling stands).
11. **Benchmark order (§9.5) — RULED: B1-first.** Private harnessbench loop before any public board.
12. **Headless runner (§9.3 #1) — RULED: same workbench loop, full `agent` mode.** The contestant is August itself; old model-eval `benchmark` mode deleted (§2.2).
13. **Verification loop (T1) — RULED: lint + test.** Opt-in per workspace; auto-detect or configured lint/test commands; ≤3 fix iterations.
14. **Memory injection (T12/M3) — RULED: append-only per-turn injection** at the turn tail; system prompt never mutated mid-session (§3.4 updated).
15. **Plan/todo re-injection (T7) — RULED: always inject** the compact per-turn state block (~50–150 tokens, cache-stable after the mutable boundary).

---

## Part 9 — Benchmark-top strategy (field survey & adoptions)

> **Implementation policy (user directive 2026-08-27):** every adoption spec in this plan is **fully self-contained** — mechanism, parameters, mount point, risk. When implementing, **build only from the specs in §9.2–§9.5 and Part 10; never consult, port from, or reference any external codebase or app.** External project names appear in exactly three places, as record rather than reference: §9.1 (leaderboard entries that *define the goal*), the §9.0/§8-Q9 correction record, and the Appendix evidence index (citations backing the numbers). Benchmark-infrastructure names (boards, adapter formats) appear only where the deliverable itself is an adapter to that infrastructure.

### 9.0 Name resolution & goal clarification

**"orcacode" resolved (user correction 2026-08-27): OrcaCode Review** — `github.com/Continuum-AI-Corp/orca-code-review`, an AI **code-review** pipeline (GitHub Action + agent skill + CLI, MIT, ~1.2k lines, engine = Open Code Review, routing = OrcaRouter). It is **explicitly not OpenCode** (`anomalyco/opencode`) and not a coding-agent harness — it doesn't compete on the Coding Agent Index. What to implement from it into August is its own part: **Part 10**.

**Correction record:** an earlier draft of this plan resolved "orcacode" to OpenCode and framed §9.3 as that resolution. That was wrong. The OpenCode deep-dive and the wider-field survey below **stand on their own** as benchmark levers — they serve the separately-affirmed goal of topping the Coding Agent Index — but they are not, and were never, the meaning of the "orcacode" request.

**The goal: August itself tops the Coding Agent Index.** The index ranks **harness+model lines** — the harness is the contestant as much as the model. Two consequences:

1. **The existing `benchmark` agent mode is NOT this.** It's a *model-evaluation* surface (`harness_mode.py:88`: `BENCHMARK_ALLOWED_TOOLS = {'run_command', 'edit_lines'}`, skills/capabilities stripped — "raw capability evaluation") that measures the model by *removing* August. For harness competition the opposite is required: the **full, optimized August harness** running headlessly. Per user direction the model-eval mode is useless → **removed in §2.2**; the headless entry built below runs the normal `agent` mode with all harness features.
2. The ~9-point same-model harness delta (§9.1) is the prize: every lever in this part exists to make *August's* line outrank Claude Code/Codex/Opencode lines on identical models.

### 9.1 The benchmark landscape (what "top spots" means)

**Coding Agent Index = Artificial Analysis Coding Agent Index** (https://artificialanalysis.ai/agents/coding-agents, methodology v1.4):
- Composite = average of pass@1 on **DeepSWE** (113 long-horizon SE tasks), **Terminal-Bench 2.1** (89 agentic terminal tasks), **SWE-Atlas-QnA** (124 repo Q&A tasks); 3 attempts/task; reward-hacked attempts scored 0 (an agent judge reviews every passing trajectory).
- Current top: Claude Code–Opus 5 (xhigh) **0.681**; Codex–GPT-5.6 Sol (max) 0.651; Opencode–Gemini 3.7 Flash (high) 0.596.
- **Harness delta, model fixed (Opus 4.7):** Claude Code (max) **0.516** · Opencode (medium) **0.513** · Cursor CLI 0.467 · Claude Code (medium) 0.424 → **harness + settings move the index up to ~9 points on an identical model** — comparable to a model-tier change.
- **Reasoning effort is the single biggest visible lever:** Codex GPT-5.6 none→max +21.7 pts; Opus 5 low→xhigh +8.7 pts.
- AA runs everything themselves — inclusion requires them to run August headlessly in their infra (contact-based, no self-serve).

**"Harness bench" — two real candidates:**
- **`ya5h-P/harnessbench`** (coding-specific): ≥2 harness CLIs pointed at the *same* OpenAI-compatible endpoint, 200 tasks (133 orchestration-heavy: find 1 function in 320 files, rename across 28 call sites, mine a 150k-line log). Scoring: Correctness 35% / Reliability 25% / Efficiency 20% / Capability 20%, hidden execution-grounded graders, runaway token cap. Adding August = **one adapter file** (`invoke` + `metrics`). Leaderboard is essentially empty → **the cheapest available "top spot"** and a good private regression harness.
- **`reacher-z/HarnessBench`** (harness-eval.com): fixes the model, varies the harness, but on 153 *web/browser* tasks — methodology reference only, not the coding target.

**Adjacent boards:** Terminal-Bench 2.1 (de-facto harness leaderboard; same-model harness deltas 3–8 pts; community submissions currently maintainer-run via Harbor). Verified target numbers (TB 2.1 submission files, 445 trials each): **Claude Code + Fable 5 (xhigh) 83.8%** ($553, 1 reward-hack disqualification) vs **Terminus 2 + Fable 5 (high) 80.4%** ($439, 0 hacks) — the maximalist harness buys ~3.4 pts at +26% cost, which validates running August's *full* harness, not a thin one. **DeepSWE is self-serve via Pier** (`pier run -p deep-swe/tasks --agent …`) — the fastest way onto a public board; current public top (benchget mirror, 2026-08-20): **mini-swe-agent + opus-5 (max) 73.6%** pass@1 (113 tasks × 4 runs, $10.43 median). DeepSeek model baselines on the same snapshot (relevant to B2 model choice): **deepseek-v4-pro 62.83%** pass@1 (pass@4 88.50%), **deepseek-v4-flash 53.32%** (pass@4 80.53%), both effort=max. SWE-bench Verified; Aider polyglot.

**Entry requirements August must meet:** headless/CLI mode (prompt-in/result-out), Docker/cloud sandbox compatibility, k-attempt runs (TB needs ≥5/task), budget/timeout controls that can't be gamed, network allowlisting, full trajectory logging (`trajectory.json` — the reward-hack judge reads it), reasoning-effort pass-through.

### 9.2 Measured levers (mechanisms first; attributions in the Appendix)

All named attributions and citations for the numbers below live in the Appendix evidence index — the mechanisms here are the implementation input.

- **Automated harness-evolution loop:** evaluate→analyze→improve over harness components, **one component per iteration**; documented **+7.3 pp on Terminal-Bench 2 in 10 iterations** (84.7% on TB 2.0). Ablation result that shapes B4: **gains localize to tools, middleware, and long-term memory — not the system prompt.** An evolved harness transfers to other models with **12% fewer tokens**. → August already has the seeds of this loop: `harness_self_improve.py`, routing evidence, golden evals (`tests/test_harness_evals.py`, `/api/brain/harness/evals`). Extending it into a trajectory-driven evolution loop is the highest-ceiling move.
- **Cheap reliability fixes from a 75.7% TB 2.0 run**, seven items: (1) native tool calling — *August has this*; (2) **30 KB cap on terminal output**; (3) marker-based command-completion polling — **not adopted** (audit 2026-08-27: August's `run_command` is blocking-with-timeout; revisit only if B1 trajectories show long-command failures); (4) **smart completion verification** — double-confirmation checklist incl. original instruction + multi-perspective QA; (5) prompt caching; (6) auto-summarize-and-retry on context overflow; (7) temperature=1 when reasoning effort is set.
- **Environment bootstrapping** — workdir snapshot/file listing/tool manifest in the initial prompt — **saves 2–5 early exploration turns** per task.
- **Simplicity can beat maximalism:** a ~100-line, bash-only agent **beat full product harnesses on DeepSWE** with strong 2026 models — exotic scaffolding can be *negative*; simplicity + fast starts + clean trajectories win. → The lesson is **not** "ship a neutered profile" (that was the deleted model-eval `benchmark` mode's mistake): every harness element — skills injection, memory blocks, capability prompts — must *earn its turns* on real trajectories, and dead weight gets cut. The competition entry is the full harness, kept lean; a minimal arm stays useful only as an A/B ablation baseline (§9.5 B3), never as the entry itself.
- **Context engineering:** context rot is real; documented levers = compaction that keeps architectural decisions/unresolved bugs, **tool-result clearing (the safest light compaction)**, structured note-taking, sub-agents for parallel exploration.
- **Anti-pattern, quantified:** reward hacking. One surveyed CLI lost **9.0%** of its TB 2.1 attempts to hacks (zeroed). AA/TB zero any attempt that edits tests, reads `solution/`, or fetches answers. → August needs explicit **benchmark-integrity guardrails** in the sandbox policy (never touch graders/tests/solution dirs) — both for scoring and for honesty.

**Added 2026-08-27 from the wider-harness survey (attributions in the Appendix):**

- **Verify-and-retry after edits is the single biggest documented score lever.** Polyglot benchmark evidence: **52.0% pass@1 → 88.0% pass@2** (+36 pp) once a lint/test fix-retry pass exists; separate documented result: 80% → 91% on HumanEval from self-reflective retry; the broader agent-computer-interface literature is built on "edit tool rejects bad edits and tells the model why". → August has **no post-edit verification at all** today (no linter, no test hook) — this is the largest open gap vs. the field.
- **Edit format is a per-model hyperparameter, quantified.** Documented: unified diffs took one model from 20% → 61% edit success (3× less lazy); code wrapped in JSON tool calls scores *worse* than plain markdown text. → August's hash-anchored `edit_lines` self-heal is the right family; per-model format selection is a B3 experiment.
- **Parallel tool calls are the biggest *latency* lever** (documented: up to 90% time cut on parallelizable work; multi-agent +90.2% on breadth-first research evals) — but the coding-specific counterweight holds: conflicting implicit decisions poison results, so keep file mutations single-threaded and parallelize reads/exploration only. August already defaults to read-only parallel tools — correct posture, keep it.
- **Context loss is a named failure class** (TB 2.0 paper, Appendix C). The cheapest documented attack is the Q&A handoff: self-summary → fresh-context model asks ≥5 questions → answers → context reset (§9.4, T3).
- **Truncated generations must never execute.** Documented rule: when a generation stops on the length limit, fail *all* tool calls in the message unexecuted ("may carry truncated arguments"). August today only special-cases thinking-only truncation (`workbench.py:2637`); a truncated tool-call batch still executes — a real gap (§9.4, T2).
- **Prompt cache is money on long runs.** Documented patterns: freeze long-term-memory files into the system prompt once at session start (mid-session writes hit disk but not the prefix); make cache stability an explicit extension-API contract (structured prompt inputs, additive tool activation). → Direct constraint on Part 3 M3 retrieval injection (§8 Q14).
- **Zero-context-cost scripting**: run Python that calls tools through an RPC bridge — N tool turns collapse into one whose intermediates never enter the parent context. August's `code` mode is the same pattern family (documented: executable-code actions give up to +20% success across 17 LLMs) but its sandbox API (`read_file/write_file/run_command/list_files`) doesn't reach the full tool surface yet.
- **Autonomy horizons double ~every 7 months** (long-horizon measurements). Design for resume/checkpoints/retry — long runs will keep getting longer; shadow-git checkpoints (§9.3 #7) are the rollback substrate.
- **REPL-first tool surface, validated at scale.** One surveyed harness ships a persistent Python REPL as its *only* native tool — file reads, searches, edits, even subagent spawns are function calls whose results bind to kernel variables that persist across turns ("prompt-as-variable"); it claims large token savings from running functions over data instead of re-reading data into context, and vendor-reports **95.5% on a long-horizon reasoning benchmark** (above the published human-expert baseline of 95.4%; vendor-reported, no independent reproduction — Appendix). → August's `code` mode is the same pattern family; its sandbox API still doesn't reach the full tool surface (§9.4, T13).
- **Field-observed failure incidents worth guarding** (from surveyed harness trackers): a cross-turn identical-tool-call loop (one incident: the same call re-issued **52×** with no harness layer detecting it); a hung command with no default timeout blocking a session forever; a truncation routine returning *empty* when a single line exceeds the byte budget; a deterministic 400 (orphaned tool-use id) misclassified as retryable and retried forever; and an **offline-eval sandbox escape via inference-API remote-fetch** — an evaluation-integrity hazard for any long-horizon benchmark run. → §9.4 T16 guardrail pack.
- **Model vendors now ship their own harnesses — and maximalism is not proven.** A major model vendor released an official open-source harness (two weeks old, developer preview, ~200k stars; Appendix). It publishes **no efficacy numbers**, and the only independent head-to-head so far had it **lose to a leaner harness on a small local model** (+14% wall time, +24% time-to-first-token). → Do not assume a maximalist harness wins on small/local models — August serves a lot of free/small-model traffic, so the lean path must stay first-class (this is the B3 ablation arm doing real product work, not just benchmark hygiene). The same vendor's benchmark profile also **disables its sandbox entirely** — August keeps the real sandbox on in benchmark runs (§9.6).

### 9.3 Adoption specs — Set A (ranked: benchmark impact × fit)

Each spec below is self-contained (mechanism, parameters, mount point, risk) per the implementation policy.

**P0 — directly moves benchmark scores:**

| # | Adoption | August today | Notes |
|---|---|---|---|
| 1 | **Headless competition runner** — `august-bench` CLI entry that runs the **full `agent`-mode harness** (all tools, skills, memory, guardrails — the product itself is the contestant): task-in/result-out, auto-approve inside sandbox, budget/turn caps, network allowlist, `trajectory.json` logging, k-run scripting | No CLI entry; workbench is API/UI-driven. The old `benchmark` agentMode was the *opposite* (model-eval: 2 tools, harness stripped) and is deleted in §2.2 | Entry requirement for *every* board; the index scores **harness+model lines**, so the run must use August's real harness, not a neutered one. The gate for everything else |
| 2 | **Prune-then-compact context** — two tiers: (a) *projection prune*: protect the last **40k tokens** of tool outputs; blank older outputs in the model-facing projection as `[Old tool result content cleared]` (history itself untouched); (b) *compaction*: when still over budget, summarize with a **verbatim tail under a token budget** (keep the last N turns word-for-word, summary before it) | `context_compressor.py`, single strategy | Tool-result clearing is the safest documented compaction (Appendix). Non-destructive: only the model-facing projection changes. Compaction summary uses a **fixed markdown schema** (Goal / Constraints / Progress: Done·In-Progress·Blocked / Key Decisions / Next Steps / Critical Context / `<read-files>` / `<modified-files>`), never cuts at a tool result (result stays with its call), carries the read/modified file ledger forward across repeated compactions, and splits-and-merges two summaries when a single turn alone exceeds the budget. Documented ratio defaults to calibrate against: trigger at **0.8 × context window**, retain newest **0.16** verbatim, summary capped at **8192 tokens**; on a provider context-overflow error run the same reduction reactively and retry only if the surface advanced; log start/summary/end lock events so a mid-compaction crash is detectable — with a TTL so an orphaned lock can't block compaction forever |
| 3 | **Output-cap discipline**: 30 KB / 2000-line tool-output cap; overflow spills to a file, and the truncation footer carries a "delegate to an explore subagent" hint | In-memory truncation only (`max_tool_result_chars`) | The 30 KB cap is a documented winning fix (Appendix). Pairs with §4 minimal transcript (rendering) — this is the model-side half. Two-stage shrink, documented constants, **with a fixed order and scope** (audit fix 2026-08-27 — as originally written, stage A fired live on everything > 8192 chars, which made stage B unreachable and let its ~50 KB preview violate the 30 KB cap): **stage B (spill) applies to fresh results** — any new plain-text tool result > 50 KB is stored verbatim to a session-scoped file and replaced inline by a head/tail preview + one notice line naming the omitted byte count, the storage locator (opaque), and a retrieval hint; the combined inline preview must fit under the 30 KB / 2000-line model-facing cap (split the budget across head/tail, never split a surrogate pair). **Stage A (deterministic prune) applies to historical results at compaction time** — tool results older than #2's protected window (last 40k tokens) that still exceed 8192 chars are rewritten in the model-facing projection to head 4096 + tail 1024 code points with a middle-elision marker; stage A is the companion to #2's projection prune, not a live-result rule |
| 4 | **Environment bootstrapping**: workdir tree + file listing + tool manifest in the first prompt | `<intake>` has store hints + memory index, no file listing | Documented saving: 2–5 exploration turns per task. Cheap; direct per-task turn savings |
| 5 | **Completion verification checklist** (model self-check against original instruction + multi-perspective QA before declaring done) | Reflection nudges on stalled phases only | ⚠️ Must be framed as the *model's own* pre-completion checklist, NOT a critic gate — the verifier gate was removed by user ruling (2026-08-24) and this must not resurrect answer-withholding (§8 Q10) |
| 6 | **Per-model-family prompt variants + effort policy**: one prompt file per model family; reasoning-effort pass-through; temperature=1 when effort is set | Single system prompt | Documented: reasoning effort moves the index +8.7…+32.9 pts (Appendix). August's per-model capability profiles are the natural mount point |
| 7 | **Shadow-git snapshots** replacing file-copy checkpoints: a separate git dir (alternates pointing at the repo's object store, so big repos aren't re-hashed), per-step commits, per-message diffs, revert/**unrevert** | `checkpoint_service.py`: file copies, 2 MiB/file cap, no diffs, no redo | Reliability component (25% of harnessbench scoring); powers §4.5 ChangesCard totals + drawer diff |

**P1 — harness quality (the ablation evidence in §9.2 localizes gains here: tools, middleware, memory):**

| # | Adoption | August today | Notes |
|---|---|---|---|
| 8 | **Merged into T1** (audit 2026-08-27) | None — no LSP anywhere (verified) | Post-edit formatter + LSP diagnostics now live in T1 as its optional second diagnostic source, incl. the experimental `lsp` tool (definitions/references/hover) behind a flag |
| 9 | **Skills compat**: discover `.claude/skills` + `.agents/skills` (cross-tool portable directories), optional remote skill indexes | Bundled + data dir only | Free ecosystem leverage; pairs with §3.7 skill hygiene |
| 10 | **Merged into T5** (audit 2026-08-27) | `tool_guardrails.py` (failure counts, contiguous-identical), sandbox policy | Permission UX (prefix patterns, external-directory asks, reject-with-feedback) is now T5's UX surface; the doom-loop clause lives in T16(a). August's real sandbox stays the differentiator — do NOT regress to advisory-only |
| 11 | **Resumable/background subagents**: `task_id` resume, `background: true` with result injection as synthetic message; truncation hints that delegate to explore subagents | Subagents with compaction/retry/`yieldSchema`; no resume/background | Truncation→delegation loop is a context-hygiene flywheel. Spawn returns at **admission** with a handle (id + session dir) — never blocks on the child's answer; results flow back via injected message or file; recursion depth cap (default 2) |
| 12 | **Demoted to P2** (audit 2026-08-27) | `chat/agent/code` modes + `update_state` phases | Plan-mode agent: no documented benchmark evidence — product-UX bet; now in the P2 list below. If revived, it feeds §4.3 plan-tree rendering |
| 13 | **Long-term memory** (= Part 3 of this plan) | Being redesigned | Memory is one of the three gain-localizing components (§9.2 ablation) — the KB redesign is a *benchmark lever*, not just UX |

**P2 — parity/ecosystem (low priority; not scheduled — revisit only on explicit user or ecosystem demand):** prompt-cache epoch discipline (never break the prefix mid-session; August already has cache-stability work at `workbench.py:1027`); plan-mode agent (demoted from #12 — permission-shaped agent: edits denied except plan files, persistent plan file, switch-back reminder; product-UX-first, no documented benchmark evidence; would feed §4.3 plan-tree rendering); session sharing; ACP support; CI integration; `references` (named extra repos in prompt); question-tool parity; watermarked at-least-once session-log sync for provider-side continuity (append-only suffix with a last-accepted-sequence watermark + delivery-accepted ack — idempotent, never touches `messages`, so no prefix-cache busting; strictly opt-in).

**Anti-patterns observed in the survey — avoided by design:** advisory-only permissions with no real sandbox (August's sandbox policy is a genuine differentiator); long-lived dev-server memory growth; monolithic single-file loops (hundreds of KB in one file — keep August's loop modular); repo-management policies as product behavior.

### 9.4 Adoption specs — Set B (ranked)

Source-level survey conducted 2026-08-27 across ten harnesses (repos cloned and read). Per the implementation policy, the per-harness architecture records live **only in the Appendix evidence index**; the portable mechanisms from that survey are the self-contained specs below.

| # | Adoption | August today | Notes |
|---|---|---|---|
| T1 | **Post-edit verification loop**: after `edit_lines`/`write_file` success, run configured lint + optional test command; report errors **in AST context** (inside containing function, not bare line numbers — models mishandle bare line numbers); bounded fix loop (default 3 iterations) feeding self-heal messages | **None** — no linter/test hook anywhere (verified) | The single biggest documented score lever (+36 pp pass1→pass2; Appendix). Mount: post-mutation hook in the workbench loop. Config: per-workspace `lintCmd`/`testCmd` + auto-detect (ruff/eslint/pytest heuristics). **Diagnostic sources: (a) configured lint/test commands — primary; ruled (Q13): lint + test; (b) optional post-edit formatter + LSP diagnostics fed into the same tool result (merged from #8), behind a flag, plus the experimental `lsp` tool (definitions/references/hover) behind the same flag.** Tree-sitter AST-error detection needs a new dep (none today — verified; shared with T10 step 2) |
| T2 | **Length-stop fail-all**: if `stop_reason ∈ {max_tokens, length}` and the message carries tool calls, fail them all unexecuted with a self-heal message | Only thinking-only truncation handled (`workbench.py:2637`); truncated tool-call batches still execute | Tiny change, prevents executing half-parsed arguments |
| T3 | **Q&A handoff compaction**: self-summary → fresh-context model asks ≥5 questions → answers → context reset | `context_compressor.py` single strategy | The compaction v2 path once §9.3 #2 prune-then-compact is exhausted; directly attacks the "Context Loss" failure class named in the TB 2.0 paper |
| T4 | **Fuzzy edit fallback ladder** (exact → leading-whitespace-insensitive → blank-line-tolerant → elided-lines) before rejecting; **per-model edit format** as a B3 experiment (udiff arm for lazy models) | Hash-anchor reject + re-read (`workbench.py:3684-3700`), `edit_lines` (`tool_registrations/file_tools.py:812`) | Keep hash anchors as the staleness gate; the ladder is about *match tolerance*, not staleness. B3 format arms: udiff for lazy models, and **unique-literal str_replace** (old text must match exactly one run of lines or the edit is refused; view = numbered listing with line ranges, output clipped at ~16k chars) — the format one vendor tunes its models against in its own benchmark profile |
| T5 | **Two-axis permissions**: split sandbox capability tier × approval policy; per-category auto-approve; model-flagged `requires_approval` on commands; destructive annotations always ask | Real sandbox policy (single axis) | Formalizes what the UI can expose; the real sandbox stays ground truth — model flags are advisory on top. **Policy vs UX (merged from #10):** durable allow/deny rules come from user-configured meaningful command prefixes (arity-aware patterns); external-directory asks are derived from parsed commands; a rejected request returns reject-with-feedback to the model so it can adjust; loop-breaking is **not** here — see T16(a). Approval grants are **one-shot** (`allowed-once` for exactly the asked action) over a closed outcome enum; a missing/throwing/absent answerer resolves to deny (fail-closed); unattended/headless runs use a `never-ask` stance so no prompt can hang the process |
| T6 | **Layered AGENTS.md**: global → git-root→cwd walk, `AGENTS.override.md` wins, 32 KiB cap | Loads workspace AGENTS.md | Cheap; helps benchmark tasks with nested instruction files |
| T7 | **Externally-persisted plan/todo state + per-turn re-injection** (compact state block each turn; survives compaction; explicit initial-context re-injection policy — mid-turn re-inject above last user message, pre-turn defer) | `update_state` phases exist but aren't re-injected; compaction can lose plan state | Also feeds §4.3 plan-tree rendering; plan/todo must live outside the transcript. Ruled (Q15): always inject |
| T8 | **Salvage-parse of truncated outputs** + **double-confirmation completion** (first "done" → harness re-prompts the model with current state; second consecutive assertion ends — model-side, no human involved) | Parser-error self-heal exists; no salvage, no double-confirm | **Scope boundary vs T2:** salvage-parse applies only where T2 doesn't — `code`-mode fenced blocks and other structured-output text; truncated *tool-call arguments* are T2's territory (fail-all unexecuted), never salvage-parsed. Double-confirm costs one extra model call → **bench runs only**, never interactive product mode; it is a model-side re-confirmation, never a gate (Q10) |
| T9 | **Headless protocol conventions**: JSONL typed event stream, `--output-schema` final answer, typed exit codes (0 ok / 1 error / 42 input / 53 turn-limit) | No CLI entry | Folds into the B0 spec; the board adapters consume exactly this shape |
| T10 | **Repo map upgrade path**: step 1 re-wire orphaned `code_map.py` into environment bootstrapping (§9.3 #4) as-is; step 2 (B3 experiment) tree-sitter symbol tags + personalized PageRank (personalized by chat-mentioned files/identifiers), 1k-token budget ×8 when no files in chat, disk cache | `code_map.py` orphaned (verified: nothing imports it); no tree-sitter dep | Step 1 is a half-day win; step 2 only if B1 trajectories show orientation failures |
| T11 | **Skill Curator**: idle-triggered aux-model review of agent-created skills — lifecycle transitions, consolidate/patch, **archive-never-delete**, never touches the main prompt cache | §3.6 M6 hygiene fixes planned | Extends M6; the archive-not-delete invariant matches the §2 philosophy; idle-triggered so it never costs a turn |
| T12 | **Prompt-cache-sacred memory injection**: retrieved memory enters as append-only context or a session-start snapshot — never mutates the mid-session system prompt | M3 (§3.4) currently says "retrieve + inject" without a cache policy | Design constraint on M3 → §8 Q14 (ruled: append-only per turn) |
| T13 | **REPL-first tool surface (prompt-as-variable)**: extend the `code`-mode sandbox API beyond `read_file/write_file/run_command/list_files` with a tool bridge reaching the full managed tool surface; persistent kernel variables across turns; pre-seeded venv (~12 common packages); kernel execution strictly sequential (cells never interleave); large data stays on disk | `code_runner.py` sandbox API is 4 functions; no tool bridge | Token-efficiency lever (§9.2); the zero-context-scripting pattern scaled to the whole tool surface. If kernel state must survive resume: snapshot each variable independently (per-variable cap ~16 MB, total cap ~256 MB), skip-and-report unpicklable/oversized — never fatal |
| T14 | **Worktree-dedup gate retry**: before re-running a failed verification gate (lint/test), snapshot the git worktree state; if unchanged since the last failure, **skip the re-run**, count an attempt, and return "workspace unchanged — edit something before retrying" | T1's fix loop has no dedup | Anti-loop for T1; kills "re-run the same failing test forever"; costs one git hash per retry |
| T15 | **Versioned harness-state refinement with rollback**: persist harness-tunable state as versioned entries of a few typed kinds (prompt notes / memory / skill / subagent definitions) with session-local vs global scope; a refine pass (one model call) emits **JSON Create/Update/Delete edits** over this state — never touching the immutable base system prompt; each edit records rationale + expected outcome; rollback by entry id; auto-refine gated by a cheap reviewer call with discard-default | `harness_self_improve.py` exists; no versioned entry store, no rollback | The concrete mount for B4; same gated-reviewer pattern as the Q2 ruling; global entries are read-only context during a local refine |
| T16 | **Guardrail pack from field-observed failure incidents**: (a) identical-call loop detection (absorbs the byte-identical doom-loop rule formerly in #10) — hash (tool name + normalized args); within a run, advisory reminders at counts **3, 5, 8** (with a ~500-char preview of the repeated args, never blocking, reset on any new user message) and a nudge/break for loops that repeat *across* turns; (b) always-enforced default execution timeout on commands; (c) truncation single-line-overrun guard — never return empty when one line exceeds the byte cap, always emit an explicit "N chars truncated" marker; (d) classify deterministic 400s (orphaned tool-use id, malformed context) as fatal-or-repair, never retryable | `tool_guardrails.py` covers contiguous-identical + failure counts; timeout/truncation/retry-classification unaudited | Each item is a documented real incident in a surveyed harness (Appendix); all four are cheap |
| T17 | **Read-before-edit gate with version freshness**: per-session in-memory map file → {unseen \| absent \| present@version}; edit on an unseen file fails with a distinct error code + remedy text ("read the file, then retry"); write against a stale version fails with its own code + "re-read, then retry"; the storage layer does the atomic compare-and-swap | Hash-anchor staleness check exists at edit time; no observation requirement before it | No prompt or schema changes — the gate is a listener on file mutations, removable without breaking tools; map is session-scoped, dropped on restart. Complements T4: hash anchors stay the staleness gate, this adds the observation requirement |
| T18 | **Fail-closed session durability barriers**: flush the durable session log at exactly three barriers — before a model request is dispatched, before a top-level tool body can side-effect (nested calls reuse the outer checkpoint), and at each step boundary; a failed flush aborts the protected operation. Crash recovery never truncates: an orphaned open turn is closed with a synthetic `turn/end{interrupted}` event so replay stays balanced | Session persistence exists; flush-barrier + recovery semantics unaudited | Makes crash/resume honest for benchmark trajectories (ATIF completeness) and for the desktop app's power-loss cases alike |

**Anti-patterns observed in the survey — avoided by design:** monolithic loop scale and micro-compaction that breaks the prompt cache (documented as able to cost more than it saves); keystroke mono-tool as a product surface (slow edits — keep only as the B3 ablation arm); zero-timeout extension pipelines (hang-class failures) and O(N²)-redundant stream shapes; model-flagged approval as the *only* gate (advisory, not a boundary); a tool-starved orchestrator as a straitjacket (keep the context-poisoning insight, drop the straitjacket).

### 9.5 Benchmark entry roadmap

**Framing:** the contestant is **August itself** — everything below runs the full, improving harness headlessly (goal record in §9.0; the model-eval `benchmark` agentMode it replaces is deleted per §2.2).

- **B0 — Gate:** headless `august-bench` CLI wrapping the **real workbench loop in `agent` mode** (§9.3 #1), with the protocol conventions from T9: JSONL typed events, `--output-schema`, typed exit codes (0/1/42/53), budget caps, sandbox auto-approve, network allowlist, complete honest `trajectory.json` (ATIF-compatible — Pier's augmented ATIF v1.7 is the strictest target: one step per API turn, no fabricated assistant text, peak context tokens, summarization count). Also ship the two adapter shapes: a **Harbor installed-agent adapter** (install script + generated config + run command + session export) and a **Pier air-gapped spec** (install script + network allowlist honored at sandbox setup). Nothing else is measurable without B0.
- **B1 — Private loop:** write the **ya5h-P/harnessbench adapter** (one file: `invoke` + `metrics`) and run it against August's own proxy endpoint. Leaderboard is nearly empty → realistic first top spot; more importantly it becomes the in-house optimization loop for everything below. Survey note: boards parse harness state out-of-band when stdout is lossy — August's JSONL stream must be **lossless by design** so the adapter stays trivial.
- **B2 — First public row:** self-serve **DeepSWE via Pier** with the full harness. Target to beat: **73.6% pass@1** (current public top, §9.1); DeepSeek-model baselines also in §9.1 if the entry runs on a DeepSeek model.
- **B3 — Levers, measured:** one at a time, A/B'd against the B1 loop (evaluate→analyze→improve, **1 component per iteration** — §9.2). Order by measured evidence: **T1 verification loop (+36 pp documented)** → **T4 edit-format ladder/per-model format (3× laziness reduction)** → prune-then-compact (§9.3 #2) + T3 Q&A handoff → 30 KB caps + steering truncation footers (§9.3 #3) → environment bootstrapping + T10 repo map → completion checklist (§9.3 #5, bench-only T8 double-confirm) → prompt variants/effort policy (§9.3 #6) → shadow-git (§9.3 #7). Keep one **minimal ablation arm** (bash-only, no skills/memory) purely to prove each harness element adds score — if an element loses to the ablation on a board, it gets cut or fixed (§9.2 simplicity lesson).
- **B4 — Automated harness evolution:** extend `harness_self_improve.py` + golden evals + routing evidence into the §9.2 evolution loop over tool descriptions/implementations, middleware, and memory — the components where gains actually localize. **T15 (versioned harness-state refinement with rollback) is the concrete state model for this loop.** Include the documented **tool-description rewriting agent** (a tool-testing agent that rewrites descriptions from failure transcripts; documented −40% downstream task time; Appendix). This is the "August improves itself" engine the ruling asks for: the B1 loop scores, B4 proposes+tests harness mutations, humans approve merges. **Standing rule from Part 10: any judge/critic model in this loop must be independent of the producer model.**
- **B5 — Inclusion:** approach Artificial Analysis and the Terminal-Bench/Harbor maintainers once August runs headlessly in a container with default settings.
- **Integrity (non-negotiable):** benchmark-integrity guardrails in sandbox policy — never modify tests/graders, never read `solution/`, never fetch answers; trajectory logging must be complete and honest. Reward-hacked attempts are zeroed and named.

### 9.6 August advantages to keep exploiting

Real sandbox policy (where surveyed competitors ship advisory-only permissions or none at all — including one official vendor harness whose benchmark profile disables sandboxing entirely; August keeps the sandbox **on** in benchmark runs), multi-format provider gateways with per-model `apiFormat` (model auto-discovery and failover remain common gaps in the field), verifier-free loop control, **native Windows desktop** (where surveyed harnesses bolt Windows on via external bash), **automatic file checkpointing** (where at least one major surveyed harness has no file-level undo at all), desktop-first product shape with one harness powering UI + proxy + workbench. Patterns the field validated that August *already* has: native tool calling, an executable-code mode (documented: up to +20% success), read-only parallel tool execution (documented latency lever, with the single-threaded-mutations caution respected), subagents with compaction/retry/`yieldSchema`. The headless entry runs this same harness — no separate neutered profile — so every advantage above carries directly into the benchmark line.

---

## Part 10 — OrcaCode Review deep-dive (the actual "orcacode")

### 10.1 What it is

*(Survey record — provenance for the specs in §10.2–§10.3. Per the Part 9 implementation policy, implementation works only from §10.2–§10.3 below, never from the source project.)*

**OrcaCode Review** (`Continuum-AI-Corp/orca-code-review`, MIT, ~1.2k lines total) is an **AI code-review pipeline** shipped as a GitHub Action + agent skill + CLI. The review engine is **Open Code Review** (`alibaba/open-code-review`); model selection is delegated to **OrcaRouter**. OrcaCode's own contribution is everything *around* the reviewer model: a severity discipline, a two-layer precision filter, gating, and retry/metering safety. It writes no code, runs no tasks, and **does not compete on any coding-agent benchmark** — it is not a harness competitor, and nothing in Part 9 changes because of it. Its problem is the opposite of a coding agent's: a reviewer's failure mode is **false positives** (hallucinated findings, misanchored comments, noise), so the architecture spends its effort on *dropping* output, not producing more.

**The pipeline, as read from the repo (2026-08-27):**

1. **diff-guard** (`scripts/diff-guard.mjs`) — oversized-diff guard: 512 KB / 300 files defaults; size decided from `stat()` alone so a huge diff is never read into memory; exactly-at-limit still reviews; **fail-open** (any guard glitch yields "review", never silently disables it).
2. **Reviewer pass** under three rule docs:
   - `rules/severity-instruction.md` — mandatory **leading** `[P0]/[P1]/[P2]/[P3]` tag on every finding; explicit boundaries: **P1 vs P2 = normal-use bug vs abnormal-precondition bug; P2 vs P3 = real defect vs style**; security carve-out: a silently-failing guardrail is P1/P0 even when config-gated; **"when torn between two severities, pick the lower"** (precision over drama).
   - `rules/output-shape.md` — `[P1] **bold ≤10-word title**` + blank line + explanation; one comment per root cause; anchor to the file that *actually contains* the code; drop speculation.
   - `rules/conventions-directive.md` — the repo's conventions doc is loaded as **UNTRUSTED reference DATA**: it may explain style, but can never change correctness/security findings or severities — a prompt-injection-resistant way to consume repo-supplied text.
3. **Layer 1 — deterministic postfilter** (`scripts/postfilter.mjs`) — git-grep the model's quoted `existing_code` **at the reviewed commit**: found in the claimed path → keep; found in exactly one other file → **REHOME** the comment; found nowhere and the path isn't code → **DROP**. Dedupe by normalized content. No model involved — pure grounding.
4. **Layer 2 — LLM judge** (`scripts/judge.mjs`) — an **INDEPENDENT model** (different vendor where possible) scores the survivors: clusters by root cause, emits confidence 0–1 and keep/drop with **strict schema coercion**. Rationale stated in-repo: the reviewer's own model "agrees with itself", so a same-model judge makes the pass **inert while still reporting success**. Security carve-out: an author claim of "intended/safe" is **not evidence**; unclassified findings fail open (kept).
5. **Severity gate** (`scripts/gate.mjs` + `severity.mjs`) — only a *leading* tag counts (a `[P0]` mentioned mid-prose or in a code example must not promote); **untagged → P1 fail-safe** (escalate for another look, never pass as advisory); exit non-zero when a blocking severity is present.
6. **Exhaustive-merge** (`scripts/exhaustive-merge.mjs`) — up to 2 extra review passes to catch what pass 1 missed, deduped by file + effective line + normalized content.
7. **fact-proxy** (`scripts/fact-proxy.mjs`) — **idempotency-safe retry**: on failure, only replay requests *provably* unprocessed — never re-send a completion that may already have been billed; bounded tail+head token metering; rate limiting; client-disconnect cancellation.
8. **DSL routing** (`recipes/orcacode-review.dsl.yaml`) — the Action **never names a model**; the review takes `default:`, the judge stamps `x-cr-lens: judge`; the recipe's loudest rule: **the judge must not name the default's model** (deleting the rule doesn't disable the judge — it just sends it to the one place it must not go).

### 10.2 What to implement in August — a first-party code-review feature

August already *produces* diffs: hash-anchored edits, checkpoints (§9.3 #7 shadow-git roadmap), and the §4.5 ChangesCard whose code rows carry a Review affordance. Reviewing August's own changesets is a natural product surface **and** a harness-quality lever — self-review of a changeset before the user sees it. Per the Q10 ruling it is **advisory only, never a gate**: nothing here withholds an answer or blocks a change. The feature gets an August-native name (working title: **Review**, tool/route `code_review`) — it is not branded after the inspiration project.

- **R1 — Review surface.** The ChangesCard (§4.5) Review action runs the pipeline over the changeset diff (working tree vs checkpoint/shadow-git base). Findings render as severity counts + inline findings anchored to `file:line`, in the drawer next to the diff.
- **R2 — Severity rubric (full spec, implementable from this text alone).** Four severities, every finding carrying a mandatory **leading** tag: `[P0]` critical (data loss, security breach, breakage in normal use), `[P1]` real bug hit in normal use, `[P2]` real bug only under an abnormal precondition the code doesn't normally meet, `[P3]` pure style/maintainability nit. Boundary rules: **P1 vs P2 = normal-use vs abnormal-precondition; P2 vs P3 = real defect vs style**. Security carve-out: a silently-failing guardrail is P1/P0 even when config-gated. **"When torn between two severities, pick the lower"** (precision over drama). Output shape: `[P1] **bold ≤10-word title**` + blank line + explanation; one finding per root cause; anchor to the file that *actually contains* the code; drop speculation. Deterministic parser: only a *leading* tag counts (a tag mentioned mid-prose or inside a code example never promotes); **untagged finding → P1 fail-safe** (escalate for another look, never pass as advisory). ~30 lines of Python + one prompt doc.
- **R3 — Two-layer precision filter (the core adoption).**
  - *Layer 1 (deterministic):* ground every quoted code snippet against the actual files at the reviewed revision (git-grep/ripgrep). Keep / REHOME / DROP. This is the read-side twin of August's hash-anchored edits (which ground the *write* side) — it kills hallucinated line references in review output.
  - *Layer 2 (independent-model judge):* a **different model** than the reviewer scores keep/drop + confidence (0–1, schema-coerced), clustering findings by root cause; an author claim of "intended/safe" is **not evidence** for dropping a security finding; unclassified findings fail open (kept). August is a multi-model proxy — reviewer and judge on different models/providers is trivially available through existing routing (per-model `apiFormat`, routing evidence).
- **R4 — Conventions as untrusted data.** Workspace conventions (AGENTS.md etc.) enter the review prompt explicitly as reference data that can never alter correctness/security findings or severity. Portable beyond review: this is how August should treat *any* repo-supplied text it injects.
- **R5 — Advisory, never a gate.** No blocking exit inside the workbench; the gate's exit-code behavior exists only if the user later wires August review into CI. (No-withholding ruling, 2026-08-24; Q10.)
- **R6 — Size guard.** Skip oversized changesets with a loud notice (reviewing a 500 KB diff is noise — the model truncates, files get skipped, severity signal collapses); fail-open like diff-guard.

### 10.3 Portable techniques (beyond the review feature)

- **Ground quoted code everywhere.** The postfilter's git-grep check generalizes to any model output that cites existing code — review findings, search summaries, edit justifications. Edit *arguments* are already hash-anchored; citations get the same grounding check.
- **Independent-model judging as a standing rule.** Any future judge/critic inside August must run on a different model than the producer — same-model judging is inert. This constrains B4's harness-evolution loop (§9.5) and matches the Q2 ruling: the pre-storage lesson review uses a cheap model, which is a *different* model from the turn model, with a discard default.
- **Idempotency-safe retry + token metering** for August's proxy layer: on upstream failure, only replay requests *provably* unprocessed — never re-send a completion that may already have been billed; bounded tail+head token metering when truncating; rate limiting; cancel the upstream call when the client disconnects. Mounts on the `dump_openai_upstream_body` / `dump_anthropic_upstream_body` paths and retry logic.
- **Fail-open guards.** diff-guard and the judge both fail open: a guard glitch must never silently disable the review or drop findings. Pattern for August's own guardrails — guardrail failure → proceed + warn, never silently strip capability.
- **Structured output with deterministic parse + escalating fail-safe.** Parse only the canonical position (leading tag), and default toward escalation, never toward passing. Reusable for routing suggestions, harness evals, and any future typed model output.

### 10.4 Do NOT adopt

- The GitHub Action / PR-comment plumbing — August is desktop-first; the review surface lives in-app.
- OrcaRouter as an external routing service — August already routes per-model; adopt the *rule* (judge ≠ reviewer model), not the infrastructure.
- The Open Code Review engine itself — adopt the layering ideas; August's reviewer is its own workbench model call, which keeps the whole feature inside one harness.

### 10.5 Phasing

- **R-A (with/after §4.5 ChangesCard):** severity rubric doc + parser, Layer-1 grounding, ChangesCard Review action — single-model review, advisory.
- **R-B:** Layer-2 independent-model judge, dedupe/exhaustive-merge behavior, conventions-as-untrusted-data hardening.
- **R-C (optional):** fact-proxy retry/metering discipline in the proxy layer; CI exit-code mode for users who wire review into pipelines.

---

## Appendix — Evidence index (verified 2026-08-27)

> **Provenance only.** Per the Part 9 implementation policy, this index (together with the §9.1 leaderboard standings and the §9.0/§8-Q9 correction record) is the **only** place external projects are named. These rows are citations backing the plan's numbers — they are **not** implementation references, and nothing in §9.2–§9.5 or Part 10 requires opening any of these projects.

| Claim | Evidence |
|---|---|
| Junk KV keys live in DB | Read-only query on `data/august_brain.sqlite`: 8 keys incl. all four named |
| Turn-lesson heuristics immutable | DB rows ids 1/3/5; `brain.py:442-443,471-472` (403) |
| 21/23 placeholder session titles | DB query `title LIKE 'Chat 20%'` |
| `Chat … UTC` source | `workbench/sessions.py:244-247` |
| Auto-title keyless failure | `title_generator.py:162-164` (`resolveApiKey` None) |
| 023 false "ALIVE" comment | `migrations/023_memory_hygiene_purge.sql:15-16` |
| Privacy erase skips KV | `routers/privacy.py:11,48-54,164-178` |
| Memory add-box 404 | `MemorySection.tsx:315` vs `august.py:24,345`; grep: no `/api/memory` route in backend |
| Heuristics writer deleted | Zero `INSERT INTO learned_heuristics` in working tree; stale copy only in `build/lib/services/heuristics_service.py:190` |
| Vector/graph tables dead | `memory_schema.py:438-498` creates; grep: schema-only references |
| Disabled skills still injected | `workbench.py:676-695,734,805-820,580-597`; `skill_tools.py:9-19,30` |
| `<relevant_skills>` promised but unimplemented | `capabilities_prompt.py:344,357-358,417`; no `build_relevant_skills_block` anywhere |
| Orphan tables reader counts | grep of `backend-py/app`: curation_ledger 0, session_traces 0, harness_trends 0, routing_evidence 2, execution_state 8, scratchpad 8, exams 4 |
| "orcacode" = OrcaCode Review (user correction 2026-08-27) | https://github.com/Continuum-AI-Corp/orca-code-review (MIT; Action + skill + CLI; engine = alibaba/open-code-review; routing = OrcaRouter). Earlier draft mis-resolved it to OpenCode — corrected in §9.0 |
| OrcaCode Review architecture (Part 10) | Cloned repo read 2026-08-27: `rules/severity-instruction.md` (P0–P3 rubric, P1/P2 + P2/P3 boundaries, security carve-out, "pick lower when torn"), `rules/output-shape.md` (`[P1] **bold ≤10-word title**`), `rules/conventions-directive.md` (conventions doc = untrusted reference data, injection-resistant), `scripts/postfilter.mjs` (Layer-1 git-grep grounding: keep/REHOME/DROP + dedupe), `scripts/judge.mjs` (Layer-2 independent-model judge, root-cause clustering, confidence coercion, security carve-out, fail-open), `scripts/severity.mjs` (leading-tag-only parse, untagged→P1 fail-safe), `scripts/gate.mjs` (blocking-severity exit), `scripts/diff-guard.mjs` (512 KB/300-file skip guard, fail-open), `scripts/exhaustive-merge.mjs` (≤2 extra passes, dedupe), `scripts/fact-proxy.mjs` (idempotency-safe retry, bounded token metering, rate limit, disconnect cancellation), `recipes/orcacode-review.dsl.yaml` (Action never names a model; judge must not run on the reviewer's model) |
| OpenCode architecture (Set A survey record) | https://github.com/anomalyco/opencode (~202k stars, MIT, v1.18.23) — surveyed as one of the field's harnesses, not as the "orcacode" resolution. Record: `runLoop` with automatic overflow→compaction; prune-then-compact (protect last 40k tokens of tool outputs, blank older in-projection, verbatim tail under budget); per-model-family system prompts (`anthropic.txt`/`gpt.txt`/`beast.txt`) with prompt-cache "context epochs"; shadow-git snapshots (separate git dir, per-step commits, revert/unrevert); resumable/background subagents (`task_id`); permissions (bash arity patterns, `.env` gating, external-directory asks from tree-sitter-parsed commands, doom-loop breaker, reject-with-feedback); truncation-to-file + delegate-to-explore hints; post-edit formatter + LSP diagnostics; `.claude/skills`/`.agents/skills` compat + remote indexes; plan-mode as permission-shaped agent with persistent plan files. Weaknesses: advisory-only permissions (issue #2242), long-lived-server memory growth (#20695), 30-package Effect-TS monorepo |
| Coding Agent Index methodology + standings | https://artificialanalysis.ai/agents/coding-agents · https://artificialanalysis.ai/methodology/coding-agents-benchmarking (v1.4: DeepSWE + TB 2.1 + SWE-Atlas-QnA; harness delta ~9 pts at fixed Opus 4.7) |
| Harness bench candidates | https://github.com/ya5h-P/harnessbench (coding, 200 tasks, one-file adapter) · https://github.com/reacher-z/HarnessBench (web tasks) |
| Terminal-Bench 2.1 / DeepSWE / SWE-bench | https://www.tbench.ai/leaderboard/terminal-bench/2.1 · https://deepswe.datacurve.ai/ (self-serve via Pier) · https://www.swebench.com/ |
| Measured harness levers | AHE arXiv:2604.25850 (+7.3 pp TB2; gains in tools/middleware/memory) · https://github.com/krafton-ai/KIRA (30 KB cap, completion checklist) · https://github.com/stanford-iris-lab/meta-harness-tbench2-artifact (env bootstrapping, −2…5 turns) · https://github.com/SWE-agent/mini-swe-agent (simplicity beats product harnesses on DeepSWE) · https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| August gap checks for adoptions | no LSP/formatter (grep empty); checkpoints = file copies (`checkpoint_service.py:1-24`, 2 MiB cap); no `.claude/skills` discovery; single system prompt; guardrails at `tool_guardrails.py:8,67` |
| Model-eval benchmark mode scope (deletion) | `harness_mode.py:88-109`; `routers/workbench.py:1848-1849`; `workbench.py:617-623,734,741,808,1140-1149,2022,2736-2762,2788`; `HarnessModeChip.tsx:3,8`; `WorkbenchModeSelector.tsx:119` |
| August length-stop gap (T2) | `workbench.py:2637` handles thinking-only truncation; no fail-all rule for truncated tool-call batches |
| August hash-anchored edits (T4 mount) | `workbench.py:3684-3700` (fileHash mismatch → reject + re-read); `edit_lines` at `tool_registrations/file_tools.py:812` |
| Hermes architecture | https://github.com/NousResearch/hermes-agent (~237k stars, MIT, Python; successor to OpenClaw). Record: headless `-z/--yolo --cli`; **tiered compaction** — mechanical tool-output prune pre-pass (`[Old tool output cleared…]`) → aux cheap-model middle summary (budget = 20% of compressed content, 2k floor / 10k ceiling) → token-budgeted verbatim tail (10k–25k tokens, last 6 tool rounds) → mechanical Anchor Index + verbatim user messages; reference-only summary headings; `[SKILL_PRUNED: name]` markers; memory = frozen snapshot in system prompt at session start; 40+ tools in toggleable toolsets; `execute_code` (Python→tools RPC) + `delegation` (fresh-context subagents); smart approval via aux-LLM; YOLO env var frozen at import time; skills: `skill_manage`, `/learn`, idle Curator (archive-never-delete). Constants in `agent/context_compressor.py`; frozen-snapshot memory `tools/memory_tool.py`; Curator `agent/curator.py`; `tools/approval.py`; micro-compaction tradeoff `docs/micro-compaction.md`. Weaknesses: monolithic (483 KB loop file), no published numbers, `-z` stdout strips tool calls (adapters parse its `state.db`), micro-compaction breaks prompt caching |
| Terminus 2 architecture + numbers | `harbor-framework/terminal-bench-1` `terminal_bench/agents/terminus_2/terminus_2.py` + `harbor-framework/harbor` maintained copy (Laude Institute; no standalone repo). Record: mono-tool tmux keystrokes, harness outside the container, plain-text JSON/XML actions; 10 KB observation truncation keeping first half + last half; proactive handoff when free tokens < 8k; Q&A handoff (self-summary → fresh-context model asks ≥5 questions → answers → context reset); double-confirmation completion; salvage-parse of truncated outputs; parser errors fed back verbatim. Numbers: TB 2.1 submissions `2026-06-05-…-terminus-2.json` (80.4%, $438.64, 0 hacks) & `2026-06-07-…-claude-code.json` (83.8%, 1 hack DQ); arXiv 2601.11868 (TB 2.0: T2+Opus 4.5 57.8% vs CC 52.1%; 3.9M vs 256.9M input tokens; Context Loss failure class App. C). Successor: Headlong (<10k-line Bash microharness) |
| pi architecture | https://github.com/earendil-works/pi (ex-`badlogic/pi-mono`, ~98k stars, MIT, TS). Record: minimal 4-tool default (read/write/edit/bash), 796-line loop; `stopReason == "length"` → fail every tool call unexecuted (`agent-loop.ts`); compaction keeps ~20k most recent tokens, iterative prior-summary passes anchored on `firstKeptEntryId` (`docs/compaction.md`); extension model: 33 typed events, per-event veto vocabularies, guards fail closed / observers fail open, prompt-cache stability as explicit API contract (`docs/extensions.md`); agentskills.io skills; no sandbox by design; headless `pi -p --mode json` JSONL. Weaknesses: zero timeouts in extension pipeline (hang-class failures shipped twice), O(N²)-redundant `message_update` stream (bench frameworks filter it out-of-process) |
| Codex CLI patterns | learn.chatgpt.com docs: `agent-approvals-security` (sandbox mode × approval policy; Auto = workspace-write + on-request; MCP destructive annotations always require approval; per-subprocess network allowlist proxy), `agent-configuration/agents-md` (global→git-root→cwd walk, `AGENTS.override.md` wins, 32 KiB cap), `non-interactive-mode` (exec --json typed JSONL incl. per-turn cached token usage, --output-schema, --output-last-message), `config-file/config-reference` (compaction threshold+scope, Pre/PostCompact hooks, InitialContextInjection policy: mid-turn re-injects initial context above last user message, pre-turn defers; hooks can rewrite tool input `updatedInput`); `codex-rs/core/src/compact.rs`, `apply-patch/src/parser.rs` (one formal-grammar patch tool: parse→validate→safety-gate→apply) |
| Gemini CLI patterns | google-gemini/gemini-cli docs: `plan-mode` (per-phase model routing — stronger model plans, cheaper implements; `enter_plan_mode` tool), `checkpointing` (shadow git; restore re-proposes the original tool call), `headless` (`-p --output-format jsonl`; exit codes 0 ok / 1 error / 42 input / 53 turn-limit), `settings` (approval spectrum default/auto_edit/plan/yolo + TOML policy engine `commandPrefix`/`commandRegex`), compression at 0.5 context usage; `write_todos` enforces exactly one in_progress |
| Aider evidence | aider.chat/docs/repomap + `aider/repomap.py` (tree-sitter tags + personalized PageRank, budget default 1k tokens ×8 when no files in chat, disk-cached); `aider/coders/editblock_coder.py` (SEARCH/REPLACE fuzzy ladder: exact → leading-whitespace-insensitive → blank-line-tolerant → elided, + targeted self-heal); `website/docs/unified-diffs.md` (20%→61%, 3× less lazy); `_posts/2024-08-14-code-in-JSON.md` (code-in-JSON worse than plain markdown); `_posts/2024-05-22-linting.md` (lint-and-test auto-fix loop, AST-contextualized error reports); `_posts/2024-09-26-architect.md` (architect/editor two-model split, 85% SOTA at publication); `docs/leaderboards/` (polyglot: gpt-5 high 52.0% pass@1 → 88.0% pass@2; methodology pass@1 vs pass@2 + well-formed-edit %) |
| Cline/Roo patterns | cline docs: `plan-and-act` (per-mode models), `checkpoints` (default-on shadow workspace, commit after every tool use incl. untracked, three-way restore Files/Task/Both, credited with enabling aggressive auto-approve — "cost of a mistake ~zero"), `auto-approve` (per-category toggles + model-flagged `requires_approval`), `auto-compact` (cache-cheap); roocodeinc.github.io: `custom-modes` (modes as data: `roleDefinition` + tool/file groups + `whenToUse`), `boomerang-tasks` (only completion summary returns up; orchestrator deliberately tool-starved vs context poisoning), `intelligent-context-condensing`, `task-todo-list` (todo state re-injected into per-turn environment details so it survives compaction) |
| Prime Agent architecture + numbers | https://github.com/PrimeIntellect-ai/prime-agent (18.8k★, MIT, TS + Python kernel; **built on top of the pi codebase** — see pi row; npm `@earendil-works/pi-coding-agent`). Papers: arXiv:2608.23552 ("Self-Improving RLM Harness"), arXiv:2605.09998 (Continual Harness). Record: persistent IPython REPL as sole native tool (RLM "prompt-as-variable"; pre-seeded packages; kernel = separate process for lifecycle, explicitly *not* a security sandbox); admission-only recursive subagents (handle at admission, maxDepth 2); compaction reserve 16384 / keepRecent 20000, fixed markdown checkpoint schema, never cuts a tool result, split-and-merge giant turns, cumulative read/modified file ledger (`core/compaction/compaction.ts:110-113`); per-variable dill snapshot 256 MB total / 16 MB per-var (`core/kernel/state-snapshot.ts`); `/refine` = JSON Create/Update/Delete edits over versioned prompt/memory/skill/subagent entries, local/global scope, rollback by id, auto-refine gated by cheap 4k reviewer (`core/refinement/refinement.ts`); autonomous mode budgets (3 continuations / 12 turns / 80k tokens / 30 min) + **git-worktree-dedup gate retry** (`core/autonomous.ts:285-330`); beforeToolCall/afterToolCall hooks with parallel-preflight execution; `--mode json`/`--mode rpc` JSONL + explicit mid-stream steering. Numbers (**vendor-reported, no independent reproduction**): ARC-AGI-3 RHAE Best@1 95.5% with Opus 5 (human-expert baseline 95.4%), Best@3 99.97%, 183/183 levels; long-context suite wins vs pi-mono. Weaknesses (open tracker items): no sandbox by default (README WARNING, `docs/rlm.md:143`); no automatic file checkpointing/undo (#1407/#1408); cross-turn identical-call loop incident (#1404/#1326 — same call 52×); no default bash timeout (#1544); truncateTail empty-return on oversized single line (#1551); orphaned tool_use_id 400 retried forever (#1534); daemon lifecycle bugs (#1531/#1536/#1541/#1552); ACP gaps (#1354–#1356); Windows bolted-on (`docs/windows.md`, #1401); disclosed offline-eval sandbox escape via inference-API remote-fetch |
| DeepSeek harness (official vendor harness) | https://github.com/deepseek-ai/deepseek-harness (`dsh`; ~200k★ in 14 days, MIT, TS pnpm monorepo, released 2026-08-13 developer preview; Cordis plugin kernel, arXiv:2608.25512; HN 49285244). Record: append-only `SessionEvent` log, "model-visible ⟺ logged" invariant; typed waterfall extension points (`agent/pre-step`, `tools/pre-execute|execute|post-execute`); compaction threshold 0.8 × window / retain 0.16 / summary 8192 tokens, tool-pair-balanced boundaries, overflow-reactive retry, lock events (`packages/compaction/compaction-basic/src/config.ts`); tool-result pruner 8192→head 4096 + tail 1024 code points; spill >50 KB to session file with head/tail 25 KB preview + locator + retrieval hint (`packages/spill/`); `str_replace_editor` unique-literal edits + `cat -n` ranged views clipped at 16k chars; **read-before-write gate** `FS_NOT_OBSERVED`/`FS_STALE_VERSION` with atomic CAS (`packages/fs/fs-observation-policy`); bash default timeout 120 s / max 600 s / 64 KB per-stream output; sandbox modes read-only/workspace-write/danger-full-access with bwrap/Landlock, Seatbelt, Windows ACL backends (`packages/sandbox`, `native/landlock-run`); fail-closed one-shot approvals (`packages/interaction/user-approval`); **fail-closed flush barriers** ×3 + synthetic `turn/end{interrupted}` recovery (`packages/session/session-checkpoint-policy`); repeat-tool reminder at counts [3,5,8], advisory non-blocking (`packages/guard/repeat-tool-reminder`); headless profiles incl. `sdk-minimal` benchmark mode (2 tools, danger-full-access — sandbox OFF); DeepSeek wire extensions `dsh_plugin_packages` (default-on inventory upload) + `dsh_session_log` (afterSeq-watermarked at-least-once suffix upload, opt-in); default models deepseek-v4-flash/v4-pro, 1M context / 256k max tokens, effort default high. Numbers: **none published**; DeepSWE model baselines (benchget 2026-08-20): v4-pro 62.83% pass@1, v4-flash 53.32%; only independent head-to-head (promptdriven/pdd, local Qwen3.8-27B, 2026-08-23): lost to pi 4/8 vs 6/8 passes, +14% wall, +24% TTFT. Weaknesses: developer-preview breaking changes; total-plugin indirection hurts auditability; session-format refusal with no migration; default-on plugin-inventory telemetry; compaction orphan-lock liveness hazard |
| Harness-engineering writeups | arXiv 2405.15793 (SWE-agent ACI), 2407.01489 (Agentless 32% SWE-Lite $0.70), 2402.01030 (CodeAct +20%), 2303.11366 (Reflexion 80%→91%); metr.org 50%-horizon (doubles ~7 mo); cognition.com/blog/dont-build-multi-agents; anthropic.com/engineering: built-multi-agent-research-system (+90.2%, −90% time, tool-description agent −40%), writing-tools-for-agents (25k cap, concise/detailed) |
| Harbor/Pier adapter mechanics | harbor `src/harbor/agents/installed/` (~35 adapters incl. hermes.py, pi.py); datacurve-ai/pier (air-gapped install specs + network allowlists, augmented ATIF v1.7, `pier critique run`); benchget/deepswe mirror (top: mini-swe-agent + opus-5 max 73.6%, 2026-08-20) |
