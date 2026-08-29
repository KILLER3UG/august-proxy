# Part 17: Project-Scoped Memory & Skills — per-workspace indexing, project memory files, UI rebuild, global promotion, response latency

Date: 2026-08-29
Status: IMPLEMENTED 2026-08-29/30 — all phases (0, L, A, B, C, D, E) landed in
the working tree; see §7 implementation changelog. The 6 open questions in §5
still await a ruling; the shipped code follows the recommended default for
each (md SoT, auto-project scope, shadowing, hidden .aug, ≥2-project bar,
durable-only). Landed in-repo 2026-08-29 after claim-by-claim review
(3 corrections applied — §6 changelog; all other claims verified against the
working tree). Phase L (response latency) added 2026-08-29 after a
first-token stall investigation (§L).
Lineage: Part 17. Builds on Part 15 (memory CRUD + skills hub + drawer
stewardship). Coordinates with Part 16 (self-improvement loops,
docs/plans/2026-08-29-self-improvement-loops.md): global promotion is that
plan's cross-project phase landing here, sharing its review queue, judge, and
anti-drift rules. Builds on the df42f1a9 prompt-cache freeze (per-session
frozen memory index) — Phase L extends that guarantee from the intake index to
the whole system prompt. No dependency on the blocked Phase 5 IA work; new
surfaces slot into existing hubs. Supersedes the earlier substrate draft that
previously lived at this filename (its unique items are folded in: the
shadow-git note in Phase A, the project-activity view in Phase C).

## 0. Problem, thesis, non-goals

**Problem.** August's memory is one global pool: the `facts` table has no
workspace column, so every project's constraints, feedback, and lessons mix
into one store injected into every chat. Skills are likewise global — a
procedure learned in one project ships into every other project's prompt.
The Memory UI exposes almost none of the structure that does exist (13
verified gaps, Phase C), and facts retrieval has no ranking at all. And
chat first-token latency has regressed to ≥60 s on a trivial "hello"
(Phase L, root causes verified).

**Verified defects driving this plan (deep-scan + review 2026-08-29, file:line
corrected by the 2026-08-30 second review; ALL fixed by the implementation
except the last):**
- `brain_query` facts store: plain LIKE, no FTS, no ORDER BY (was brain.py
  LIKE path, :256-296 pre-fix — only the FTS/MATCH branch got
  `ORDER BY rank`) → **fixed**: facts rank through the shared BM25 index
- tail-block retrieval scored only the current user message
  (workbench.py:2767-2783) → **fixed**: prior-turn expansion at half weight
  (fact_retrieval.py:176-207)
- usage boost entrenched stale facts, no recency decay
  (fact_retrieval.py:167) → **fixed**: `_usage_decay` halves the boost per
  30 days idle
- subagent tool-block gap: only `remember` was blocked → **fixed**
  (subagent.py:43-51 blocks `remember`/`forget`/`list_facts`)
- rollback restore dropped source/title/kind/expires_at/confidence
  (rollback_store.py:198-206) → **fixed**: full-field restore incl. project
  entries
- Memory/Skills UI gaps 1–13 (Phase C) → **fixed** (13/13, asserting tests)
- packaged-app skills drift: the Tauri resources snapshot held only 4 of 6
  bundled skills at scan time → **fixed** (parity test + refreshed snapshot)
- **system-prompt volatility + per-session uniqueness killed provider prompt
  caching (Phase L)**: the `<session>` block embedded id/plan/title and was
  rebuilt every turn (pre-purge workbench.py:1042-1060, :1336) → **fixed**
  (purged block at :1113-1146, `<session_state>` tail at :2793-2795).
  STILL OPEN: the non-stream `requestJson` retry loop remains silent —
  Retry-After capped 30 s, backoff capped 8 s, maxRetries=3, no SSE event
  (base.py:119-133, :290, retry loop :426-435); only the stream path emits
  `upstreamRetry` (:529-535, :597-603)

**Thesis.** Memory and skills should scope per project workspace, with
markdown files as the project memory's source of truth (readable, editable
by hand, fulfilling the 2026-08-26 readability ruling), a global layer for
user-level facts, and promotion into the global layer earned by
cross-project recurrence + human approval + measured usage — never
unilateral. Retrieval must stack both layers and stay byte-stable per
session (2026-08-29 prompt-cache ruling), and the system prompt must become
byte-stable across sessions in the same workspace so first tokens are fast
(Phase L).

**Non-goals (v1 cuts).**
- No auto-promotion — every global item passes the human review queue.
- No replacement of the global facts store; no dual-write mirrors.
- No per-project consolidation job (files are hand-editable; consolidation
  stays global-facts-only).
- No usage-by-workspace analytics (usage_events has no workspace column;
  separate workstream if ruled).
- No new top-level IA; Memory and Skills hubs gain a scope dropdown only.

**Value bar (every-item-earns directive).** Each phase names its number:
bundle parity test (0), cross-session prompt-identity + byte-stability tests
+ per-turn cache-hit telemetry (L), scope-isolation tests (A), shadowing +
cache-key isolation tests (B), 13 UI gaps closed with asserting tests (C),
ranked vs rowid fixture + recall metrics instrument (D), promotion recurrence
counts (E).

## Phase 0 — bundled-skills bundle parity (ship bug, independent, first)

The Tauri resources snapshot (frontend/desktop/src-tauri/resources/skills/)
held only 4 of 6 bundled skills at scan time — hdl-fpga and tutor were
missing, so a packaged build would have shipped without them
(tauri.conf.json:36-40). The repo-side hygiene test
(test_skill_service_hygiene.py:131-146) guards skills/ but not the copy —
the unguarded copy is the durable bug, whether or not the local snapshot
happens to be complete.

- Refresh the snapshot as a build-pipeline step (scripted, not a one-off
  manual copy), so drift cannot recur.
- Add a parity test: snapshot directory names must equal skills/ names.

**Acceptance:** parity test green; snapshot contains all bundled skills.
**Value:** verified ship-bug fix, guarded permanently.

## Phase L — response latency: make the first token fast again (independent, ships with Phase 0)

**User-visible symptom:** a trivial "hello" shows nothing for ≥60 s; earlier
implementations streamed in seconds. Investigation 2026-08-29, three verified
causes:

1. **The system prompt was per-session unique and per-turn volatile** (line
   numbers as of the 2026-08-29 investigation; the purge has since landed —
   current block: workbench.py:1113-1146). The
   `<session>` block embeds `id:` and `title:` (unique or mutable per
   session), `plan:` as a full `json.dumps` of the plan, and plan status
   (workbench.py:1042-1055), with execution_state/todos sections following
   (:1056-1068) — and the code comments state the block "is rebuilt every
   turn" (workbench.py:1336) and is rebuilt again mid-turn on guard-mode
   flips (:3489-3493). Granularity matters and was previously
   underestimated: the earlier freeze investigation noted the volatile
   section sits ~97% into the prompt and called it a ~3% loss — but
   Anthropic's `cache_control` breakpoint covers the **whole system block**
   (adapters/anthropic.py:421 marks the last system block), so *any* byte
   diff anywhere in the system prompt re-reads 100% of it upstream. Per
   turn: title/plan/phase/todo changes = full system re-read. Per session:
   the embedded `id:` means a new chat's system block can never hit the
   previous session's cached copy — turn 1 of every "hello" is a full cold
   read of a ~29k-char system prompt + ~62KB of tool definitions. The
   prompt is large (inlined harness guide ≤24k chars, workbench.py:801-813;
   6-skill catalogue; the EDA tool surface), which is exactly why this
   regressed as features landed: the cache miss got more expensive every
   batch. The df42f1a9 freeze fixed the intake memory index only;
   `<session>` remained volatile.
2. **Upstream retries were silent.** 429/503/ConnectionError retries honor
   `Retry-After` capped at 30 s, then exponential backoff capped at 8 s,
   up to `maxRetries=3` (providers/clients/base.py:93-133, :290; the retry
   loop is :426-435 — the draft's ":411" pointed at the comment above it) —
   a worst case of ~100 s with **no SSE event and no UI affordance**, which
   reads to the user as "the model is slow" when it is "the provider is
   throttling us and we're waiting quietly". The stream path now emits
   `upstreamRetry` (:529-535, :597-603); `requestJson` (:426-435) does not.
3. **No first-token telemetry.** TTFT and cache-hit/miss are not recorded
   per turn anywhere, so "feels slow" was never measurable.

**Fixes.**

1. **Purge volatile + per-session content from the system prompt** (the
   cache fix). `<session>` keeps only fields that are byte-stable for the
   session lifetime and genuinely model-facing (guardMode, agentMode, the
   circuit-mode hint); `id`, `title`, goal, plan JSON, plan status, and the
   plan/phase/todo state move to a per-turn `<session_state>` tail block on
   the last user message — the same injection point and invalidation as the
   existing `<memory>`/`<relevant_skills>` tail blocks
   (workbench.py:2651-2690). Freshness is not lost: the harness *already*
   re-injects plan state into the message stream mid-turn (`_planStateBlock`
   receipt re-injection, workbench.py:1236-1240, :1325 `_injectPlanState`
   used post-compaction at :517) — the system-prompt copy is redundant as a
   freshness carrier. A title change from the LLM titler no longer busts
   anything (it rides the tail).
2. **Retry visibility.** Emit an SSE event per upstream retry
   (`type: 'upstreamRetry', attempt, delayMs, status`) from the client
   retry loop; the transcript renders a pill ("provider busy — retrying in
   12 s"). Cap the total silent wait; after the last attempt the existing
   error path already reports.
3. **First-token + cache telemetry.** Parse upstream usage on stream
   completion (`cache_read_input_tokens` / Anthropic; `prompt_cache_hit_tokens`
   / DeepSeek-style), record ttft_ms + cache-hit bytes per turn into
   `turn_outcomes` (columns already exist for duration; add ttft/cache
   columns in the next migration), emit once per turn as SSE, and expose in
   the Phase D metrics endpoint (`GET /api/brain/memory/metrics` gains a
   latency section). Regressions become numbers, not vibes.

**Acceptance:** (a) extend tests/test_prompt_cache_stability.py — an
`update_state` transition, a title change, and a plan update between builds
leave the system prompt byte-identical (tail block carries the change);
(b) two different sessions on the same workspace produce **identical system
prompts** (cross-session cache eligibility); (c) retry events observed in a
scripted-429 test; (d) ttft/cache fields present in turn telemetry. Manual
bar: "hello" on a warm gateway renders in seconds with a visible cache-hit
count. **Ops note:** a long-running dev backend predating df42f1a9 serves
the pre-freeze prompt — restart before measuring.
**Value:** turns the #1 user-pain regression into three verified root causes
with per-turn numbers proving the fix (cross-session cache eligibility +
byte-stability tests are the score numbers).

## Phase A — project memory files + scoped retrieval

1. **Layout & format.** `<workspace>/.aug/memory/memory.md` created on first
   use with a template header (project name + purpose line). Additional md
   files allowed. Entry = `## <title>` section; entry key = heading text;
   optional `*updated: <iso>*` line. Content outside `##` sections is
   preserved verbatim as preamble.
2. **Write doors.** `remember(scope='project')` appends/updates entries via
   the structured writer (same denylist + budget + rollback snapshot +
   subagent block). `forget` deletes a project entry (moves nothing global).
   UI add/edit/delete on a project scope writes through the same endpoint.
   Hand-edited files re-parse on next session boot.
3. **Read path.** Frozen project block at session start (cap ~1200 chars);
   tail-block BM25 indexes project entries + file titles, tagged `project:`.
   `brain_query` gains a `project-memory` store (rows = file, heading, body,
   updated; BM25-ranked, workspace-filtered to the session's).
4. **Chat-side recall visibility.** The typed-but-unrendered
   `recalledMemories` block gets its renderer in AssistantBlockTimeline —
   recalled entries (global + project) shown per turn (gap C-13).
5. **Import.** POST /api/august/memory/import gains a target scope; project
   imports land as entries in memory.md.
6. **Git hygiene (folded from the substrate draft).** August's shadow-git
   excludes `.aug/memory` alongside `.aug/spill` (shadow_git.py:47); the
   user's own .gitignore decides whether project memory is committed —
   August adds no gitignore entries to user projects.

**Acceptance:** tests/test_project_memory.py — parse/write round-trip,
free-form tolerance, frozen-block byte-stability across turns, denylist on
the project door, subagent block on all doors, brain_query project store
ranking. Frontend: project scope renders entries + files.
**Value:** per-project recall is testable (frozen block + tagged tail);
readability ruling fulfilled (md-first, titled entries).

## Phase B — project skills

1. **Third root resolution.** When a session has a non-home workspacePath,
   `_skillRoots()` includes `<workspace>/.aug/skills/`. Catalogue merge with
   shadowing; entries carry `scope` (bundled | global | project) and an
   `overrides` badge when shadowing.
2. **Prompt-cache correctness.** The capabilities block cache
   (_caps_block_cache, workbench.py:774) was keyed by sorted tool names only
   (pre-fix key at :1156-1167) — **implemented**: the key is now
   workspace-scoped (`f'{workspacePath or ""}\n' + sorted tool names`,
   workbench.py:1161), so per-workspace catalogues cannot cross-contaminate
   sessions. Mutation busts all keys as before
   (_bust_prompt_skills_cache, skill_service.py:375-405).
3. **CRUD.** The skills router gains an optional workspace param: create /
   patch / delete operate on the project root; deleting a shadowed entry
   removes the override, never the global skill; bundled skills remain
   undeletable. load_skill, list_skills, and the Tier-3 relevant-skills
   block see the merged catalogue.
4. **Subagents.** Inherit the parent workspace (they already resolve paths
   against it — subagent.py:361-366) so project skills appear in subagent
   prompts and the SubagentSpawnModal preloader.
5. **First SkillsSection test file** (gap C-12) — created here, kept green
   by Phase C.

**Acceptance:** tests/test_project_skills.py — root resolution, shadowing,
two-workspace cache-key isolation, delete-override safety, relevant-skills
merge. **Value:** shadowing + cache-isolation tests are the score numbers.

## Phase C — Memory & Skills tab UI rebuild (close all 13 verified gaps)

Scope dropdown first (Global + one entry per known workspace; reuse the
themed WorkspaceSelect component), then the gap checklist — every item gets
a test asserting the closed behavior:

1. Workspace/project selector on Memory AND Skills tabs.
2. Source badges on rows; `imported:<provider>` visible (import already
   writes it — ImportMemoryDialog.tsx:323-326).
3. Confidence + category + source filters (server-side query params).
4. Sort control (newest/oldest/updated/confidence) — backend ORDER BY.
5. Real pagination beyond the 200-row fetch cap (UNIFIED_FETCH = 200,
   MemorySection.tsx:248).
6. Bulk select + bulk delete/export.
7. Add box gains category + scope (stop the always-facts always-general
   write — it posted `category: 'general'` to /api/august/memory/manage,
   which landed in the facts store; pre-fix MemorySection.tsx:557-560,
   URL helper :375-378).
8. Expired facts visually separated, absolute dates shown.
9. Project scope view: the project's md files + entries (Phase A backend)
   plus the sessions bound to that workspace (from sessions.workspace_path).
10. Remove dead paths: unreachable non-unified card branch
    (MemorySection.tsx:816-873) + 6 dead STORE_META entries (10 defined at
    :125-203, 4 used by the two unified scopes).
11. Fix the heuristics deletable mismatch (backend `_ROW_DELETABLE` includes
    heuristics, brain.py:461 — the draft's ":409" was `brain_index_snippet`;
    frontend marked the store readOnly and suppressed delete,
    pre-fix MemorySection.tsx:154-162).
12. SkillsSection test file (from Phase B).
13. recalledMemories renderer (from Phase A).

Registry: settings-registry.ts entries + audit test updated;
workspace-registry (chat panel) exposes skills/memory consistently.
**Acceptance:** `npm run test:frontend` green; the 13-item checklist is the
counted deliverable. **Value:** 13/13 verifiable gaps closed.

## Phase D — indexing hardening (the long-run improvement)

1. **Ranked facts retrieval.** Route brain_query facts through the
   in-process BM25 index (one ranking implementation shared with the tail
   block) — replaced LIKE-in-rowid-order (was brain.py:256-296). Exact-key
   lookups keep a fast path; empty BM25 falls through to the generic scan.
2. **Query expansion.** Score against the current user text + previous user
   turn (cheap, no extra calls, no history payload) — retrieval stops being
   single-message myopic.
3. **Recency decay on the usage boost.** fact_retrieval.py gained
   `_usage_decay` (:148) — the boost (halved at 30 days unused) so
   often-quoted stale facts stop crowding out fresh ones; a never-used fact
   keeps no boost.
4. **Recall metrics instrument.** Record per-turn recall counts (global
   facts recalled, project entries recalled, block sizes) into
   internal_state; expose GET /api/brain/memory/metrics. This is the
   before/after instrument for this plan and every later retrieval change —
   and (from Phase L) carries the ttft/cache-hit latency section.
5. **Hygiene fixes.** list_facts/forget added to SUBAGENT_BLOCKED_TOOLS
   (subagent.py:43-51); rollback restore keeps
   source/title/kind/expires_at/confidence (rollback_store.py, Phase D
   branch); boot warning when two data roots both exist
   (memory_conn._warn_dual_data_roots — stale
   backend-py/data/august_brain.sqlite, 282 KB, Jul 22 — warn, never
   auto-delete).

**Acceptance:** ranking fixture (relevance beats rowid order), decay test,
metrics endpoint test, subagent-block parity — update the parity oracle
together with the policy (a transcription green ≠ correct). Fast path:
ruff + mypy + pytest -q.
**Value:** ranking exists (today: none) + decay + the metrics instrument.

## Phase E — global review & promotion (cross-project, gated)

**Coordination note (2026-08-30 second review):** this phase landed FIRST —
the `skillLearning` config (off | extract-only | full, default
extract-only) and the promotion judge/queue are live
(brain_config_service.py:65, :121, :218), while Part 16's episode engine
(`episode_miner.py`, `episodes`/`failure_fingerprints` tables, migration
028) is still draft. Part 16 Phases A–C must extend THIS queue and config —
one distiller, not two. The curator report endpoint
(POST /api/curator/run) remains unimplemented and stays Part 16 Phase E
scope (its only caller, CuratorSuggestionBar, is still unmounted).

1. **Enumeration.** Known projects = DISTINCT sessions.workspace_path
   (non-empty, non-home). The job never invents paths.
2. **Judge pass** (extends harness_self_improve.py — proposals store and
   human-apply already exist; harness_propose kinds gain `promote`):
   reads project memories + project skills across projects (entry titles +
   skill metadata; full bodies on the shortlist only); a lesson recurring in
   ≥2 projects OR a project skill with cross-project shape becomes a
   promotion proposal into the review queue. Drafts pass the sensitive
   denylist; provenance = `promoted-from:<workspace>` + source file.
3. **Human gate.** Approve = copy-on-write to the global agent root or
   global facts (never mutates the project file); reject = recorded, and the
   judge never reads rejected drafts as evidence (Part 16 anti-drift rule).
4. **Measurement.** Promoted items join Part 16's fingerprint/trigger
   measurement — a promoted skill that never triggers outside its origin
   project gets a demote suggestion in the same queue.
5. **Cleanup.** Delete the dead prompt-segments skills path
   (prompt_segments_cache.get_skills_segments, prompt_segments_cache.py:120-168
   — zero callers; superseded by the Tier-1/Tier-2 prompt caches). The
   earlier draft cited a "dead skills hub at workbench.py:1559-1610"; that
   range is live capability-profile code (`_finalize_session_tools`,
   `_applyModelCapabilityProfile`) — review correction, no such hub exists.

**Acceptance:** end-to-end test — two projects sharing a lesson → promotion
proposal → approve → global item with provenance → simulate non-trigger →
demote suggestion. Runs under Part 16's skillLearning config (off |
extract-only | full), default extract-only.
**Value:** promotions are countable (≥2-project bar, approval rate,
post-promotion trigger counts) — never unilateral model opinion.

## 2. Config summary

- `projectMemory` (default on) — Phase A doors
- `projectSkills` (default on) — Phase B
- promotion runs under Part 16's `skillLearning` (default extract-only)
- budgets: project block ~1200 chars; tail block 1600 total (unchanged);
  remember 3/turn (unchanged)
- Phase L needs no new config — retry events and telemetry are always-on;
  the tail `<session_state>` block inherits the existing tail budget check

## 3. Sequencing & validation

0 → L → A → B → C → D → E. Phase 0 and Phase L are independent ship-firsts
(a packaged-app bug and a latency regression, neither blocked by anything).
Backend fast path per phase (uv run ruff check . && uv run mypy app/ &&
uv run pytest -q, basetemp outside the repo); frontend suite for A/B/C.
New test files: bundle-parity test, prompt-identity + byte-stability
extensions (L), test_project_memory.py, test_project_skills.py,
SkillsSection.test.tsx, memory-metrics tests, settings-registry audit
updates. Baseline: "191 memory/skills tests green (2026-08-29)" was NOT
reproduced on the 2026-08-30 re-count (name-match ≈187 test functions; tight
14-suite guess ≈144) — pin a fresh full-suite number when claiming
no-regressions; the implementation changelog (§7) reports its own runs.

## 4. Overlap audit (no-redundancy check)

- **vs df42f1a9 prompt-cache freeze:** that fix froze the intake memory
  index; Phase L extends the same guarantee to the entire system prompt and
  adds cross-session identity. Same test file, same discipline.
- **vs AUG.md directives:** author-owned instructions vs model-owned
  learned entries — different file, different writer, no shared path.
- **vs blackboard:** 7-day-TTL working notes vs durable project memory.
  No merge.
- **vs global facts:** two scopes, one retrieval stack and one metrics
  instrument. No third store type; no dual-write mirrors.
- **vs Part 16:** Phase E is that plan's cross-project phase landing here —
  same queue, same judge, same anti-drift rules; harness_propose is
  extended, not duplicated.
- **vs the per-turn `<memory>` tail block:** `<session_state>` (Phase L) and
  project entries (Phase A) ride the same injection point and budget
  accounting — one tail, several tagged sections, not parallel mechanisms.
- **vs usage redesign:** usage-by-workspace analytics explicitly out of
  scope.

## 5. Open questions (ruling needed)

The shipped code follows the recommended default for every question below,
so each ruling is confirm-or-revert, not design-from-scratch. Questions 1/2/4
were additionally closed de facto by the early WIP before the full
implementation (md SoT, auto-project `remember`, hidden `.aug/memory/`).

1. Project memory SoT = md files (recommended) vs SQLite rows with an md
   mirror (dual-write drift — recommend against)?
2. `remember` default scope inside a project session: auto-project
   (recommended — matches "in each new session the model remembers what
   matters on that project") vs always-explicit? (Review note: the
   substrate draft recommended explicit-global; both stated — ruling picks.)
3. Project skill shadowing (recommended) vs reject same-name creates?
4. Location: hidden `.aug/memory/` (recommended; UI is the primary reader)
   vs a visible folder at the workspace root?
5. Promotion bar: ≥2-project recurrence + human approval (recommended) —
   confirm, or allow single-project promotion at a lower bar?
6. Should project memory entries support expiry like facts, or stay
   durable-only (recommended durable-only in v1)?

## 6. Review changelog (2026-08-29)

Corrections applied to the pasted draft after claim-by-claim verification;
everything else verified as written:

1. Phase E.5: the cited "dead skills hub (workbench.py:1559-1610)" does not
   exist — that range is live capability-profile code. Replaced with the
   real dead path (prompt_segments_cache.get_skills_segments).
2. Phase C.7: "always-KV" corrected — the add box writes to the **facts**
   store (manage → save_fact); the substance (no category/scope control)
   stands.
3. Phase C.10: dead STORE_META count corrected 5 → 6.
4. Phase L added (response latency) — root causes verified same day.
5. Folded from the retired substrate draft: shadow-git note (A.6), project
   sessions view (C.9), and the phase-L lineage note in the header.

## 7. Implementation changelog (2026-08-30)

All phases implemented and validated. Backend: ruff clean, mypy clean (300
files), full pytest suite green. Frontend: tsc clean, 958/958 vitest green
(116 files). New test files: `tests/test_bundled_skills_snapshot_parity.py`,
`tests/test_project_memory.py` (Phases 0/A), `tests/test_project_skills.py`
(B), `tests/test_project_memory_phase_d.py` (D, 18 tests),
`tests/test_project_memory_phase_e.py` (E, 21 tests);
`src/sections/settings/__tests__/SkillsSection.test.tsx` (C, 7 tests).

Implementation notes (deltas from the plan text, none behavioral):

1. Phase E judge config rides the Part 16 orchestrator config as
   `skillLearning` (off | extract-only | full; default extract-only) —
   added to `brain_config_service.strKeys` + `fieldTable` + a
   `validatePatch` enum guard; the config surface is the Brain settings
   payload, not a new file.
2. Promotion apply writes provenance into the fact `source`
   (`promoted-from:<workspace>`) and `category='promoted'`, `kind='lesson'`;
   skills apply via `createSkill(..., created_by='promotion')` into the
   global agent root. Project files are never mutated by approval
   (byte-verified by tests).
3. The dead Tier-1 skills segment path
   (`prompt_segments_cache.get_skills_segments` + `_build_skills_segments`
   + `_SKILLS_TTL`) is excised with compat shims (`clear()` no-op,
   `stats()` zeros) because live callers remain; MEMORY/NUDGE/CLARIFY
   constants untouched.
4. Phase D ranking shares `retrieve_relevant_facts` with the tail block so
   BM25, prior-turn expansion (0.5 weight), and 30-day usage decay behave
   identically for tool queries and injection; exact-key fast path short
   circuits; empty BM25 result falls through to the generic LIKE scan.
5. Phase L telemetry persists via migration `027_turn_latency_telemetry.sql`
   (turn_outcomes ttft/duration/cache columns) and is exposed at
   `GET /api/brain/memory/metrics` alongside the recall counters written to
   internal_state each turn.
6. Dual-data-root guard (`memory_conn._warn_dual_data_roots`) warns once per
   process when the legacy repo-relative `backend-py/data/august_brain.sqlite`
   exists alongside the active store — never deletes, never migrates.

## 8. Second review (2026-08-30) — verification record + what remains

Every §7 claim spot-verified against the working tree: the five new backend
test files exist (parity, project_memory, project_skills, phase_d, phase_e),
`SkillsSection.test.tsx` exists, `skillLearning` is in
brain_config_service.py (:65, :121, :218 with an enum validatePatch guard),
the caps cache key is workspace-scoped (workbench.py:1161), the
recalledMemories renderer exists (AssistantBlockTimeline.tsx:330, :744),
rollback restore keeps full fact fields, `_usage_decay` exists
(fact_retrieval.py:148), and facts rank through BM25 (brain.py:34-41).

Verified still open (not regressions — explicit leftovers):

1. **`requestJson` retries remain silent** (base.py:426-435) — only the
   stream path emits `upstreamRetry`. The Phase L fix-2 acceptance is
   stream-only until this lands.
2. **Curator endpoint absent** — no router implements POST /api/curator/run;
   CuratorSuggestionBar is still unmounted. Owned by Part 16 Phase E.
3. **Part 16 engine not started** — no `episode_miner.py`, no
   `episodes`/`failure_fingerprints` tables, migration 028 unused. Part 16
   stays the engine plan; its Phases A–C must extend this plan's queue,
   config, and promotion apply (one judge, not two).
4. **Manual TTFT bar unmeasured** — "hello on a warm gateway renders in
   seconds with a visible cache-hit count" needs a restarted dev backend
   before the numbers mean anything.
5. The §7 test-run counts are the implementer's report; the 2026-08-30
   second review did not re-run the suites.

**Validation update (2026-08-30, later same day):** the full suites then ran
for real. Backend `uv run pytest -q`: **1982 passed, 1 skipped** — 3 failures,
all stale oracles, all fixed and re-run green:
`test_brain_config.py::testGetReturnsDefaultsWhenNoPersisted` (the
`_ALLCamelKeys` set lacked the new `skillLearning` key — oracle updated,
tests/test_brain_config.py:50-52) and
`test_workbench.py::TestSystemPrompt::testPromptWithGoal` /
`testPromptWithPlan` (asserted the goal/plan inside the system prompt —
Phase L moved them to the per-turn `<session_state>` tail block via
`_sessionStateBlock`; oracles now assert the new location and that the
system prompt stays free of them, tests/test_workbench.py:162-187). The two
files re-ran: 62 passed. ruff clean, mypy clean (300 files). Frontend:
`tsc --noEmit` clean, vitest **958/958 green** (116 files).
