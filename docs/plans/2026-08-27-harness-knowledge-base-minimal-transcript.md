# August Harness — Knowledge-Base Overhaul & Minimal-Output Design

**Date:** 2026-08-27 · **Status:** DRAFT — awaiting review & ruling · **Scope:** backend-py memory/skills/sessions + desktop transcript UI

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
5. **§4.5 Unified Changes card** — ZCode-style single `ChangesCard` ("X files changed +N −M" + Undo) replacing `ChangedFilesCard` and `ProducedFilesRow`.

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
- Decide `backend-py/skills/` (4 orphan skills): **recommendation: move `circuit-sim` and `charts` into repo-root `skills/`** (relevant to the product), delete `pptx-author`/`video-render` if superseded by document-skills, else move. Needs your call (§8 Q3).

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
- Each turn, retrieve top-k (k=5) facts relevant to the **current user message**; inject as `<memory>` block (~400-token cap) with title + body, not just names. Keep the existing `brain_index_snippet` as fallback when the message is empty/short.
- **Usage feedback loop:** when an injected fact is referenced (model quotes its title/key, or `remember` updates it), increment `use_count`/`last_used_at`. BM25 rank gets a small `use_count` boost. This is the cheapest real "learns what's useful" signal available without embeddings.
- No embeddings/vector store — the vector tables are dead for a reason; BM25 over a few hundred facts is exact enough. Revisit only if the store outgrows ~2k entries.

### 3.5 M4 — Consolidation v2 (minimal, audited)

The deleted consolidation daemon was a stateful multi-job machine. Replace with **one scheduled job** (cron scheduler already started by `cognitive_boot.py`):

- Runs daily (configurable in brain-config). State = one row in `internal_state` (never in memory).
- Steps: (a) expire `facts` past `expires_at` (also keeps the boot sweep); (b) detect near-duplicate facts (normalized-key equality + BM25 self-similarity > threshold) → merge into the newer, append merged-from note; (c) detect same-key contradictions → keep newest, mark older `superseded` (new `facts.status` column) rather than delete; (d) `VACUUM` if DB > threshold.
- Every action writes one `lifecycle` row (existing table) so the UI can show a **consolidation log** ("merged 2 duplicates, expired 1 fact") — this is the "analysis" surface, replacing the deleted diagnostics endpoints.
- Optional model-assisted summarization of merged entries behind a brain-config flag (cost callout: one cheap-model call per merge; default off).

### 3.6 M5 — Turn outcomes as telemetry, not memory

The deleted turn-lessons failed because free-text failure rules ("Turn failed on deepseek-v4-flash-free…") are not actionable memory. Replace with structured telemetry:

- New table `turn_outcomes (ts, model, provider, task_type, ok INTEGER, error_class, duration_ms, session_id)` — append-only, retained 30 days.
- Written where the old `_record_turn_lesson` hook was (turn `finally` block, `workbench.py`), one row per turn, no model calls.
- Consumers: routing evidence (existing `routing_evidence` machinery per AGENTS.md already wants ≥3 samples for suggestions), and a harness self-improve stat ("error rate by model, last 7d"). Never injected into prompts, never shown in Memory UI — it is diagnostics, surfaced in the Observability hub only.
- If a specific model/provider fails repeatedly (≥N in window), the job may promote **one** typed `lesson` fact ("Provider X returns 400 on session_id:null — use exclude_none dumps") via the normal gated `remember`-style write with `source='harness'` — human-visible, deletable, expirable. This is the only path from failure to memory.

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

### 4.5 Unified Changes card (ZCode-style)

Replace `ChangedFilesCard` and `ProducedFilesRow` with a single `ChangesCard` matching the ZCode reference: one collapsed row — `X files changed  +N −M  [Undo]` — expandable to per-file rows with Review + Open buttons. Always visible when any edit tool ran in the turn, **including during streaming** (files arrive in real time; drop the `ProducedFilesRow` streaming guard).

**Relation to §4.1:** the card is the turn-level aggregate + undo affordance; the per-file edit rows in the timeline stay the in-flow detail. To avoid double-diff noise, the card's per-file inline diff defaults to collapsed (`expandedFiles` starts empty). This supersedes the original Phase-1 note that said to keep both cards.

**Files to change:**

- **NEW** `frontend/desktop/src/components/chat/ChangesCard.tsx`
- **DELETE** `frontend/desktop/src/components/chat/ChangedFilesCard.tsx` and `ProducedFilesRow.tsx` — verified: only `AssistantMessageContent.tsx:2-3,116,123` imports them; remaining mentions are comments only (`lib/produced-files.ts:4`, `RightDrawerArtifactsSection.tsx:4`, `RightDrawerCircuitSection.tsx:4` — update those comments)
- **EDIT** `frontend/desktop/src/sections/chat/message/AssistantMessageContent.tsx:113-124` → single `<ChangesCard blocks={message.blocks} changedFiles={message.changedFiles as GitDiffResult | null} />`; keep `CircuitArtifactCard` (:128-130) untouched
- **NEW** `frontend/desktop/src/lib/git-revert.ts` — extract the revert-all flow into `useRevertAllChanges(sessionId)` shared by the card and the drawer
- **NEW** `frontend/desktop/src/components/chat/__tests__/ChangesCard.test.tsx`

**Component design:**

Props: `blocks?: MessageBlock[] | null` (always available; powers the file list via `collectProducedFiles`), `changedFiles?: GitDiffResult | null` (optional; enriches with +/- counts and diff text), optional `onReview`, `className`.

State: `expanded: boolean` (default `true` if ≤3 files, else `false`); `expandedFiles: Set<string>` (default empty).

```text
Collapsed:  [chevron]  X files changed   +N added  -M removed          [Undo]
Expanded:   [icon] path/to/file.py       +12  -3      [Review] [Open]
                   ↳ collapsible inline diff (only when diff text available)
```

- Header click toggles `expanded`; Undo is a real `<button>` with `stopPropagation`.
- Per file: `+N −M` chips only when the path has a `changedFiles.files` hit; inline `<DiffView diff={file.diff} maxLines={32} />` only when `expandedFiles.has(path)` and diff text exists; `+N more` overflow cap = 8.
- **Review** → `setRightDrawerDiff(changedFiles, path)` + `openRightDrawer('diff')`.
- **Open** → `ChatAttachmentService.fromPath(path)` → `openRightDrawerFile(attachment)`, `revealInFolder` fallback.
- **Undo** → `useConfirmDialog` (destructive) → `resolveWorkbenchSessionId` → `listWorkbenchCheckpoints(wbId)` → checkpoint exists: `restoreWorkbenchCheckpoint(wbId, latest.id)`; else `gitApi.command(['restore', '--', '.'], sessionId)` → toast + `invalidateQueries(['git','diff',sessionId])`.
- Data merging: paths always from `collectProducedFiles(blocks)`; `changedFiles` builds a `path → GitDiffFile` lookup map; render nothing when both are empty.

**Verified reuse points (2026-08-27, all confirmed in tree):**

| Piece | Location |
|---|---|
| `collectProducedFiles` | `lib/produced-files.ts:17` |
| Review flow | `ChangedFilesCard.tsx:81-84` |
| Open flow | `ProducedFilesRow.tsx:34-51` (`fromPath` :38, `openRightDrawerFile` :41, `revealInFolder` fallback :43) |
| Revert-all logic | `components/shell/RightDrawerDiffSection.tsx:58-97` (`resolveWorkbenchSessionId` :60, `listWorkbenchCheckpoints` :64, `restoreWorkbenchCheckpoint` :74, `gitApi.command(['restore','--','.'])` :84) — **path correction:** the file lives in `components/shell/`, not `sections/drawer/` as drafted |
| `useConfirmDialog` | `hooks/useConfirmDialog.ts:25` |
| `DiffView` + `maxLines` | `components/chat/DiffView.tsx:132,168` (default 40) |

**Caveats:**

1. The `git restore -- .` fallback **does not remove untracked new files** — only the checkpoint path undoes file creation. Inherited from the existing drawer behavior; the confirm dialog text should distinguish "restore checkpoint" vs "discard tracked changes".
2. "Undo disabled when no changes AND no checkpoints" needs an async checkpoint probe — keep the button enabled whenever paths/changedFiles are non-empty and resolve checkpoint availability on click (the existing flow already catches an empty list).
3. Streaming visibility: the card appears as soon as the first edit block lands; totals settle when `changedFiles` arrives post-turn.

**Tests** (`ChangesCard.test.tsx`): renders nothing when both inputs empty; collapsed header with count + totals; expands to per-file rows; Review calls `setRightDrawerDiff` + `openRightDrawer('diff')` (mock stores); Open calls `openRightDrawerFile` after `fromPath` resolves (mock `ChatAttachmentService`); Undo confirms + `restoreWorkbenchCheckpoint` when a checkpoint exists, falls back to `gitApi.command` when none; per-file +/- and inline diff only when path is in `changedFiles.files`; `+N more` above cap.

**Validation:** `cd frontend/desktop && npx tsc --noEmit` clean; `npx vitest run` green; manual in `npm run dev:desktop` — turn that writes files shows the card collapsed, expands, Review opens drawer diff, Open opens file viewer, Undo reverts with confirm.

**Out of scope:** right-click context menu (Reveal/VS Code/Copy paths), composer "Changes +N −M" chip, per-file undo.

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
- Relative dates in the list, absolute on hover. (Temporal grouping vs folders question from the original plan still open — §8 Q4.)

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
| 4 — Sidebar temporal grouping | **Confirm** | Replace or augment folder IA (§8 Q4) |
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
5. Changes card (§4.5): a file-writing turn shows the unified card (collapsed, correct totals once the diff lands); Review opens the drawer diff at that file; Open opens the file viewer; Undo restores via checkpoint (or `git restore` fallback) after confirm; card visible during streaming; `ChangedFilesCard`/`ProducedFilesRow` gone with zero dangling imports.

---

## Part 8 — Open questions for your ruling

1. **Error display** — confirm the reconciliation: first error line inline (red), full output behind click. (Or do you want strict opt-in, version A?)
2. **Turn outcomes (§3.6)** — keep structured failure telemetry + rare promoted lessons, or drop failure-learning entirely?
3. **`backend-py/skills/` orphans** — move `circuit-sim`/`charts` to root `skills/` and delete the other two, or another disposition?
4. **Sidebar** — temporal grouping replaces or augments folder IA (original Phase 4)?
5. **Settings Phase 5** — confirm still blocked (8-hub ruling stands)? If you now want 5 hubs, that's a new ruling and the audit test changes first.
6. **`exams`/`blackboard` stores** — keep (semi-live, surfaced in Memory Sessions tab), audit-and-drop, or revive as a real feature later?
7. **Consolidation model calls (§3.5)** — allow optional cheap-model summarization of merges (default off), or keep consolidation purely deterministic?
8. **`brain_events` (609 rows)** — confirm no harness consumer I may have missed, then drop with 025?

---

## Appendix — Evidence index (verified 2026-08-27)

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
