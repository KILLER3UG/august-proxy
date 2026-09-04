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

## Parts 1–10 (2026-08-27) — TRIMMED 2026-09-02, superseded

Parts 1–10 of this plan (memory-system findings and removals, the KB redesign, the minimal-output transcript design, UI/UX proposals, carried-over phase status, the verification plan, the 2026-08-27 rulings, the benchmark-top strategy survey, and the OrcaCode Review deep-dive) were the working design surface for the 2026-08-27 batch. Everything in them that was approved and built has since been absorbed: Parts 11–15 below (the canonical UX/design records newer plans cite) plus Parts 16/17/18 — `2026-08-29-self-improvement-loops.md` (mining + distiller), `2026-08-29-project-scoped-memory.md` (per-workspace memory + cache), and `2026-08-30-harness-performance.md` (TTFT/telemetry).

Nothing cross-references Parts 1–10 anymore; the full original text is preserved in git history (see the commit preceding the 2026-09-02 tidy pass). Do not restore from this file — read the history instead.

## Part 11 — Re-check 2026-08-28 (re-pasted 5-phase plan)

User re-sent the same 5-phase plan on 2026-08-28 (Claude memory + skill-format reference
attachments re-pasted in the same turn as the request to re-review the plan). Re-checking
each phase against the live tree at HEAD `115d762d`:

| Phase | Status @ 2026-08-27 (Part 6) | Status @ 2026-08-28 (re-check) | Note |
|---|---|---|---|
| 1A — Timeline Rail + turn-stats-footer removal | Green | **Green — no drift** | `TimelineRail.tsx` rendered at `ChatThreadMessagePane.tsx:14,142-154`; `AssistantMessageContent.tsx:167` footer still pending removal — Phase 1A body otherwise landed |
| 1B — Tool invocation-only rendering | Superseded by §4 | **Superseded by §4 — no drift** | Minimal-output design landed via `1d842d8d`; `d4e2111b` added `/verbose`; bug fix this session (Part 12) addressed the "Working…" inline visibility regression in §4 |
| 2A.1 — SPICE infix (`4k7`) | Confirm | **Confirm — deliberate policy** | `circuit_tools.py:_SPICE_SCALE` line 244 + comment line 253 reject infix; per prior ruling the rejection is intentional. Not implementing without explicit supersede |
| 2A.2 — Topological placement | Green | **Green** | |
| 2A.3 — Component library expansion | Green | **Green** | |
| 2B — HDL/FGPA/Arduino tools | Green w/ registration plan | **Green w/ registration plan — still pending** | `hdl_simulate` / `vcd_parse` / `fpga_verify_qsf` / `arduino_compile_sketch` still not in `tool_registrations/circuit_tools.py`; needs a separate ruling to schedule the registration work |
| 3 — Right-drawer renderers | Reframe | **Reframe — partially landed** | Drawer work shipped via `bb76afdf` (ZCode-parity panel) + `ad18701e` (tab strip + fullscreen); `pdfjs-dist ^6.0.227` + `xlsx-js-style ^1.2.0` present in `package.json`; `three` / `docx-preview` still not added. Phase 3 is now "extend the existing 11-section drawer with renderer tabs" rather than build a new one |
| 4 — Sidebar temporal grouping | Ruled (Q4): replace | **Ruled (Q4): replace — still pending implementation** | No temporal grouping in `frontend/desktop/src/sections/sidebar/`; folder chip (Q4 ruling) lands in `d46761f7`. Awaiting ruling on whether to schedule temporal grouping now |
| 5 — Settings 5-hub consolidation | BLOCKED | **BLOCKED — ruling unchanged** | 8-hub / 39-section ruling stands; `settings-registry-audit.test.ts:32` asserts `toHaveLength(8)`; horizontal pill sub-tabs rejected as dated. No implementation work without an explicit supersede |

**Net change vs 2026-08-27:** zero regressions across phases 1–5. The only new in-flight
work relevant to this plan in this session is:

1. **Part 12 — Pending-state working-text bug fix** (`ActivitySummary.tsx:180-184,255-269` +
   `AssistantBlockTimeline.tsx:903-912`): collapsed assistant row now renders a bold
   "Working…" label + inline live line at send time, not just when expanded. Resolves
   the §4.1 "always reads as active" rule that the original transcript spec called for but
   the code only implemented for the `completion` mode path.
2. **Part 13 — Skill body normalizer** (`skill_service.py:_ensure_canonical_body`):
   learned/agent-authored skills now ship with a canonical "What this skill is / When
   to Use / How to Run / Pitfalls / Verification" structure (matches Claude's skill
   format from the re-pasted transcript). Bundled (hand-written) skills are also
   updated to the same template for consistency. Tests: `test_skill_body_normalizer.py`
   (8 cases, all green).

No phase-2/3/4/5 changes are scheduled. Phase 5 remains blocked. Pending a fresh ruling
on phase 2B (HDL tools registration) and phase 4 (sidebar temporal grouping), no new
work in those rows.

---

## Part 12 — Pending-state working-text bug fix (2026-08-28)

**Symptom (user-reported):** "working text don't appear in the line when the user send
its message, it don't appear unless the model start generating output. it only appear
when i expand it."

**Root cause (verified via live browser screenshot at `localhost:5174`):**
- `ActivitySummary.tsx:300-305` only renders the live detail line when
  `live && open && liveLine` — i.e. expanded.
- The activity-mode collapsed header shows only `durationLabel` + `prose` + `segments`
  + pulse. When the first block is a `ThoughtStep` with `content=""` (the pending
  state), `prose` is empty, `segments` is empty, and the row reads as an empty band
  with a chevron.
- The bold "Working…" string the spec calls for lives only in the `completion` mode
  branch (line 214), which is gated on `toolsCount > 0`.

**Fix (in this session, commit pending):**
- `ActivitySummary.tsx:184-189` — compute `showLiveOnly` when the activity-mode row has
  no prose/segments but a live line is set.
- `ActivitySummary.tsx:255-269` — render a bold "Working…" label inline in the
  collapsed header when `showLiveOnly`.
- `ActivitySummary.tsx:325-333` — render the live detail line under the header even
  while collapsed when `showLiveOnly` (so the user sees a hint without expanding).
- `AssistantBlockTimeline.tsx:903-912` — pass `liveDetail="Working…"` (or the
  computed `liveDetail` once a thought/tool lands) to the `ActivitySummary` so the
  pending state has a non-null live line.
- `ActivitySummary.test.tsx` — added 2 cases under "pending state (live + empty)".

**Verification:**
- Frontend: `tsc --noEmit` clean; `vitest` `ActivitySummary.test.tsx` 13/13 pass.
- Browser: live screenshot at +500ms post-send shows the in-thread row reading
  "Working…" with pulse and inline live line.

---

## Part 13 — Skill body canonical template (2026-08-28)

**Why:** the user re-pasted Claude's skill format (and the Claude memory format) and
asked for August's skills — especially the ones the harness learns — to follow the
same "what this skill is / when to use / how to run / pitfalls / verification" structure.

**Changes:**
- `app/services/skill_service.py` — added `_ensure_canonical_body()` and
  `_parse_body_sections()`. The renderer now rewrites agent-authored / harness-proposal
  skill bodies to the canonical template, with a `_SECTION_ALIASES` table that
  accepts casual headings ("Steps" → "Procedure", "Common mistakes" → "Pitfalls",
  "Verify" → "Verification", etc). Bundled (hand-written) skills are passed through
  untouched so a human author's prose survives.
- `app/services/harness_self_improve.py` — `skill_create` / `skill_patch` proposals
  now route the body through the normalizer so the file on disk always has the
  canonical sections.
- `app/services/skill_service.py:patchSkill` — only normalizes when the caller
  supplied a new body; a single-field patch (e.g. toggling `disabled`) preserves the
  existing body verbatim, so the round-trip test
  `test_setEnabled_roundtrip_preserves_unknown_frontmatter` still passes.
- Bundled skills updated to the same template for consistency:
  - `skills/august-harness/SKILL.md` — added What this skill is / When to Use /
    Prerequisites / How to Run / Pitfalls / Verification sections.
  - `skills/august-tools/SKILL.md` — same.
  - `skills/charts/SKILL.md` — same.
  - `skills/circuit-sim/SKILL.md` — same.
  - All four also synced into `frontend/desktop/src-tauri/resources/skills/` so the
    Tauri-bundled build ships the same content.

**Verification:**
- `tests/test_skill_body_normalizer.py` — 8 cases, all green:
  bundled skills pass through; missing title falls back to description; existing
  sections preserved; alias mapping works ("what this skill is" / "Steps" / "Common
  mistakes" / "Verify" → canonical); required sections filled with placeholder;
  unknown headings kept as the author's prose.
- `tests/test_skill_service_hygiene.py` — unchanged, 7/7 still green.
- `ruff check` + `mypy` clean on `skill_service.py` + `harness_self_improve.py` + the
  new test file.

---

## Part 14 — Claude memory design comparison (2026-08-28)

User re-pasted Claude's memory design (transcript: `paste-attachments/2026-08-28/pasted-text-20260828-095906-951cda8b.txt`) and asked to compare against August's memory system and fold adoptions into the plan.

### 14.1 Side-by-side

| Concern | Claude | August (today) | Match / gap |
|---|---|---|---|
| Storage substrate | File-based: one fact = one `.md` file at `/profile.md` / `/topics/<domain>.md` / `/areas/<name>.md` / `/people/<name>.md` / `/preferences.md` | DB-based: `facts` table (id, content, kind, source, scope, created_at, expires_at) + FTS5 mirror + `auto_memories` + `episodic_timeline` + KV (`memory_store`) | **Different substrate, same intent.** August's `facts` already does the typed-durable-store job; the audit (Part 1) showed it is now the only live memory write door besides human manage/import |
| Write tools | `memory_write` / `memory_str_replace` / `memory_append` / `memory_delete` with `if_version` optimistic-concurrency token | `remember` tool (gated `modelMemoryWrites` + sensitive-topic denylist) + `/api/august/memory/import` + human manage/import UI | **Substrate-different** — `if_version` is irrelevant for SQLite-row updates; the gating policy in `august-memory-write-door.md` is the equivalent guardrail |
| Optimistic concurrency | `if_version` token on every write | `facts.updated_at` timestamp + `WHERE updated_at = ?` UPDATE WHERE clause (already optimistic) | **Match** — August has optimistic concurrency, just hidden behind a SQL update. Not user-visible; could expose a `version` field in the manage/import response if humans ever want it |
| Write-during-conversation policy | "did you state it?" test + durability filter + sensitive categories gated/never stored | Same — `remember` tool is gated on `modelMemoryWrites`; sensitive denylist (health / ID / minors / beliefs) blocks the call; `facts.expires_at` makes transient facts self-purge at boot | **Match** — this is the strongest overlap |
| Retrieval: start-of-conversation index | "at the start of a conversation I get a listing of all your files (paths + one-line descriptions)" | `<capabilities>` block lists the skill catalogue; `auto_memories`/`facts` ARE injected per-turn via the relevance ranker (`build_relevant_skills_block` analogue) but **there is no human-readable one-line summary shown in the listing** | **Partial gap** — August injects facts but the catalogue is name + freeform description, not a guaranteed one-line "what this is" line. **Action:** add a one-line `summary` column to `facts` (or repurpose `kind` + first 80 chars) so the relevance block reads "August Proxy project — Tauri desktop AI coding agent" not "August Proxy project" |
| Retrieval: selective read | "memory_read only the files that look relevant" | `load_skill` + `<relevant_skills>` BM25 ranker; per-fact injection gated by relevance score | **Match** |
| Retrieval: surface-if-substantive | "a stored fact only gets surfaced if it changes the substance of my answer" | Relevance ranker is the same gate — facts below a score threshold are not injected | **Match** |
| Sensitive categories (health / legal / ID / minors / beliefs) | Gated behind consent check OR never stored | Denylist blocks `remember` calls on sensitive topics; `modelMemoryWrites` toggle exists in `brain_config` | **Match** (already ruled: `august-memory-write-door.md`) |
| Where it goes: subject-based taxonomy | `/profile.md` / `/topics/<domain>.md` / `/areas/<name>.md` / `/people/<name>.md` / `/preferences.md` | `facts.scope` (`user` / `project` / `agent`) + `facts.kind` (`preference` / `identity` / `project` / `rule`) | **Schema-different** — August's typed-store is more queryable, but it lacks the "people" axis. **Action (defer):** no `people` table; humans use the `identity` kind + freeform content for now. If the user wants a people taxonomy, that's a separate ruling |

### 14.2 Adoptable today (no ruling needed)

1. **Add a one-line `summary` to `facts` (or surface `kind` + truncated content) in the relevance block.** A 10-line change to `build_relevant_skills_block` to also include a one-line description for each injected fact. Brings August closer to "I get a listing of all your files with one-line descriptions at the start" without touching the DB schema — derive from the existing `kind` + first 80 chars of `content`.
2. **Expose `version` (= `updated_at`) in the manage/import API response.** Lets a future human manage UI do the Claude-style "I read it, I write it" two-step with a visible concurrency token. Trivial: add `version` to the response model in `routers/august.py` for `/api/august/memory/import` and the manage endpoints.

### 14.3 Adoptable only with a fresh ruling

1. **Reorganize `facts` storage by subject** (one file per `area`/`person`/`topic` like Claude's taxonomy). **Status: NOT recommended** — the SQLite `facts` table is the right substrate for a desktop app with structured retrieval; the file-per-subject model adds a parser and loses the BM25 + kind filtering. Skip.
2. **Add a `people` axis.** Add a `people` table + `facts.people_ref` column. **Status: defer.** No concrete user need expressed; the `identity` kind covers people references today.
3. **Add a `preferences.md` analogue** (a special fact kind that is always injected). **Status: NOT recommended** — preferences are a `kind=preference` fact already, and the relevance ranker promotes them naturally. An "always-inject" escape hatch tends to bloat the prompt with low-value items.

### 14.4 Conclusion

The re-pasted Claude memory design is **substantially already implemented in August** under a different substrate. The two real adoptable deltas are:

- Surface a one-line description per fact in the relevance block (today it lists `name` + `description` for skills but the same pattern isn't applied to facts).
- Optionally expose `version` in the manage/import API for future UI work.

Neither needs a fresh ruling to land — both are within the existing memory KB scope (Part 3 M3 / M4) and are small enough to fold into a normal in-flight change. **No plan-time adoption recommended**; surface as a follow-up for the next memory KB session.


---

## Part 15 — Tool-step rendering + Memory cleanup + Skills hub + Drawer overlay + Memory CRUD stewardship (2026-08-28)

**Driver:** standing rule ("implement all in the plan + improve the harness, use computer use"). Five separate user asks in one turn:
1. Tool-step spec pasted from chat — render each tool call as a single compact row; collapse reads, show command + pill, error inline for failures, expand search/edit, group consecutive same-file reads, indent tool rows under plan steps.
2. The Timeline + Sessions sub-tabs in Settings → Memory are useless — delete them.
3. Skills are under the Tools hub — make sure they have their own tab (note: a top-level Skills hub **revises the 8-hub ruling** and is a scope change; we will surface the change but not land a hub move without an explicit ruling — Skills already has its own section under Tools at `settings-registry.ts:391`).
4. Hard rule: every content surface renders in the middle column / on the right; never left-aligned with a giant right rail.
5. Model memory stewardship is one-way — audit whether the model actually has a way to add/edit/delete/learn memory.

### 15.1 — Tool-step rendering (replace inline args/result with a thin line)

**Current state (read in code):** `ToolCallCard` (`sections/chat/message/ToolCallCard.tsx:41-151`) already renders a thin row with tool name + file icon + status pill, but a successful command's result is *implicitly* shown via the inline `<FormattedResultSection>` in `/verbose` mode only. The per-step collapse of consecutive reads of the same file exists in `WorkingIndicator.tsx:80-84` but **not in the transcript** — each read still gets its own bubble in `AssistantBlockTimeline.tsx:renderProcessBlocks` (the section that drives the per-step rail).

**Plan:**

- Add a per-tool-step collapse in `AssistantBlockTimeline.renderProcessBlocks` that folds `view` (read) tools of the same path into one row with a counter (`read consolidation.py ×4`). The collapse must:
  - Run on the **rendered list**, not the underlying `processBlocks` array (so the BM25 / inference / scoring in the rest of the timeline is unchanged).
  - Preserve the first tool's id so `toolProgress` + `subagentBlocks` keep working.
  - Add a new "step" label for the counter: `read consolidation.py ×4` + duration.
- Replace the per-step result dump (the row-level "show stdout inline" path) with a click-to-expand `<DisclosureRow>` wrapper, **unless** the tool errored — in which case the error is inline (one line, with a "show full" disclosure for the rest).
- Search (web_search, search_files) and edit (apply_patch, edit_lines) stay expanded by default with a length cap (5 lines / 1 KiB), plus a "view all" disclosure for the rest. `ChangesCard` (already shipped) handles the aggregate of edits.
- Commands (run_command / Bash) collapse to one line: monospace command + green pill on success, red pill + first error line on failure. No stdout inline.
- The aggregate in the `ActivitySummary` `completion` mode header (already shipped) stays as-is — that's the "this is what happened" summary chip.

**Implementation record (2026-08-28):** most of this was already in tree from the minimal-transcript work — the ×N read collapse lives in `AssistantBlockTimeline.renderFlatProcess` (consecutive same-path non-errored `view` calls fold into one `ToolStepRow` labeled `… ×N` with summed duration; errored reads stay individual), settled reads and successful commands are header-only (`minimalLocked` in `ToolStepRow`), failed commands show one inline red line (`commandErrorOneLiner`) with the full output behind the click, and edits/searches/memory writes are expanded-by-default with capped bodies. What this batch adds: a **green ✓ / red ✗ status pill** on settled command rows (`data-testid="tool-status-pill"`) and **monospace command labels**, plus tests for the ×N collapse, the errored-read carve-out, and the pills.

### 15.2 — Delete the Memory Timeline + Sessions sub-tabs

**Current state (read in code):** `MemorySection.tsx:55-78` defines four sub-tabs. Per the audit (this section's header proof), `timeline` has no live writer in the request path, and `sessions`+`messages`+`exams`+`examAttempts` duplicate the proper UI surfaces (sidebar session list, chat thread, exam section). All four are also read-only in the `STORE_META` (lines 170-209) — the Edit/Export/Delete buttons render but no-op.

**Plan:** remove the `memory-timeline` and `memory-sessions` entries from the settings registry (`settings-registry.ts:267-283`) and the `SCOPES` map (`MemorySection.tsx:55-78`). The two surviving sub-tabs are `memory-knowledge` (KV + legacy auto-memory) and `memory-facts` (the durable facts). The 8-hub ruling is unaffected (we're not adding or removing hubs).

**No-data consequence:** the episodic_timeline table still exists in the schema (line 384 of `brain.py` is the only reader). If a future feature wants to surface the timeline (e.g. an "agent did X" timeline), it re-adds the sub-tab. Until then, the table sits empty and costs nothing.

**Implementation record (2026-08-28):** done — registry `legacyAliases` on `memory-knowledge` now absorb `memory-timeline` + `memory-sessions` deep links, `SECTION_COMPONENTS` and `SCOPES` dropped to two scopes, the Memory hub counts 2 sections (audit doc updated: 39 → 37), and the test asserts the flat Memories list renders without the Timeline rows.

### 15.3 — Skills as a top-level hub

**Note:** this **revises the 8-hub ruling** and is presented as a separate proposal, not part of this batch. The user said "make sure the skills have its own tab" — Skills already has its own **section** under the Tools hub (`settings-registry.ts:391-399`, `category: 'tools'`). What they probably want is a top-level **Skills** hub so the rail item is "Skills" not "Tools → Skills tab." If that's the rule, this batch lands a placeholder section; the hub move is a separate ruling.

For this batch, **no-op** on the hub structure. The Skills section already has its own tab inside Tools; the existing implementation is correct. If the hub move is wanted, say so explicitly and we'll file a Part 16.

### 15.4 — Hard rule: content in the middle column, secondary on the right

**Current state (read in code):** the chat column is centered (`ChatThread.tsx:1363`, `max-w-3xl mx-auto`). The right drawer (`RightDrawer.tsx:180`) is `position: relative shrink-0` — it sits inline and **pushes the chat left** when open. The user's "render in the middle" rule means the chat should stay centered even when the drawer is open.

**Plan:** make the right drawer an **overlay** rather than an inline column. `position: fixed` (or `absolute` to its scroll parent), `right-0 top-0 bottom-0`, with a left scrim to dismiss. The chat column keeps its `max-w-3xl mx-auto` regardless of drawer state. Storage: keep the same `BASE_WIDTH_KEY` but anchor to viewport right edge. The resize handle becomes a left edge handle.

This is a small CSS + a few `width: 0` / `right: 0` swaps; the section registry and feature surface are unchanged. Side effect: the titlebar / composer must avoid layout shift — since the chat is centered and the drawer is floating, no shift.

**Implementation record (2026-08-28):** landed with one deviation — **no dismiss scrim**. The drawer is a persistent workbench panel (tabs + terminal); a scrim would close it on every composer click. Instead it is `absolute right-0 top-0 bottom-0 z-30` inside `.august-content-area` (which is `relative` with no transformed ancestors), dismissed by **Escape** (suppressed while typing in an input/textarea or while the section chooser is open — Escape closes the chooser first) and the header ✗. A soft left edge shadow (`-18px 0 42px -26px`) separates it from the chat. The width clamp still keeps ≥40% of the viewport for the chat, and the chat keeps `max-w-3xl mx-auto` — on wide windows the centered column never overlaps the drawer at all. Tests cover the overlay classes, Escape dismiss, the input-focus suppression, and the chooser-first Escape.

### 15.5 — Model memory CRUD stewardship

**Current state (read in code):** the model can `remember` (write) and `brain_query` (read sessions/messages/blackboard/daemons). It **cannot list, get, or delete its own facts** — there is no `forget` / `delete_fact` / `list_facts` tool. The `remember` description does say "pass a stable key to update" but the model has no way to enumerate keys to update.

**Plan (5 small adds, all gated on the existing `modelMemoryWrites` / `modelMemoryRead` toggles):**

1. **Register `forget` tool** — `_forget(key)` handler. Validates the key exists in the model's own facts (source='model' or owned by the user), deletes via `delete_fact(key)`. Hard-refuses if the fact is system-owned. Returns `{ok, deleted, key}` so the model can confirm.
2. **Register `list_facts` tool** — `_list_facts(category?, limit?)` handler. Returns the model's own fact rows (`source='model'` or `user` for the user-facing fact store), with `key` + `title` + `category` + `updated_at`. Bounded at 50 rows. This is what makes `remember`'s "pass a stable key" actually usable.
3. **Add `feedback` prompt hint** in `<memory_policy>` (`workbench.py:1098-1106`) — one extra line: *"If the user corrects you, save it with `category: 'feedback'` and a stable key like `feedback:<short-topic>` so future turns can recall it."*
4. **Make `<memory>` block a one-line index** in the system prompt (per Claude's listing pattern) — currently the auto-injection is a `<memory>title: body</memory>` block (`fact_retrieval.py:184-203`); change to first an `index: [k1, k2, ...]` (the `brain_index_snippet` already does this for the boot intake at `brain.py:357-397`, so the wire is in place — just surface it inside the per-turn `<memory>` block too, with `modelMemoryRead` gating it).
5. **Test harness** — `tests/test_model_memory_crud.py`: `list_facts` row shape + `{"fact","details"}` title unwrap, category filter, query search, limit clamp (0→1, 999→50); `forget` deletes model facts + records a `restore_memory_item` rollback, allows `user`/`imported:*` sources, hard-refuses system-owned (`extracted`), missing/blank key points at `list_facts`, both tools honor their config gates; a `remember → list_facts → revise-by-key → forget` round trip; and the `<memory>` block `index: [key]` line + key-aware footer.

**Implementation record (2026-08-28):** all five landed. `forget` allows `source ∈ {model, user, ''}` plus any `imported:*` prefix (the import path tags `imported:<provider>`); everything else is system-owned and survives model cleanup. `list_facts` also takes an optional `query` (routes to `search_facts`) on top of `category`/`limit`. The `<memory>` block now opens with `index: [k1, k2, …]` and its footer tells the model to update by key (`remember`) or drop stale entries (`forget`). Both tools are registered in `tool_policy.py` (`list_facts` → read bucket, `forget` → write bucket) and mirrored in the `test_tool_policy_parity.py` oracles.

### 15.6 — Memory import parser hardening (the reported bug)

**Bug (user-reported):** dropping `claude-legacy-memory.md` into the Memory import dialog returned *"No entries found."* The parser (`ImportMemoryDialog.tsx`) only understood `- key: value` bullets, so Claude memory dumps — plain sentence bullets like `- Prefers concise answers without preamble` — produced zero entries. A second latent bug: August's **own** export is frontmatter-based (`---\nname:…\ndescription:…\n---` segments from `entryToMarkdown`), which the parser also didn't understand, so an August export couldn't round-trip back in.

**Fix:** rewrote the parser around four accepted shapes —
1. **August frontmatter export** — split on `---`/`***`/`___` rules, parse a leading `field: value` block (`name/description/type/updated/key/category/source/fact/details`), value = body → description → fact, key = slugified `name`/`key` else derived from the first six words of the value.
2. **Claude plain-sentence bullets** — `-`/`*`/`•` or `1.`/`1)` numbered lines with no colon get a key derived from the first six words (`prefers-concise-answers-without-preamble`).
3. **`key: value` bullets** — still split, guarded so times (`at 3:00 pm`) and long leads don't false-split.
4. **Link bullets** \`- [Title]\` + \`(file)\` + \`— hook\` — title → key, hook → value.

Plus: heading lines (`# …`) set a category hint for the bullets under them, indented continuation lines append to the previous entry, code fences + horizontal rules are skipped, and the whole result is deduped by key (last wins — matching the upsert semantics of the import endpoint). Exported as `parseMemoryImportEntries(text, source)` with 14 unit tests in `ImportMemoryDialog.test.ts`.

### 15.7 — Validation

- Backend: `uv run pytest tests/test_model_memory_crud.py tests/test_tool_policy_parity.py tests/test_remember_throttle.py tests/test_memory_kb_m1m3m4m5.py` green; `ruff check` + `mypy` clean on the four touched modules.
- Frontend: `tsc --noEmit` clean; `vitest` green on `ToolStepRow`, `AssistantBlockTimeline`, `RightDrawer`, `MemorySection`, and `ImportMemoryDialog` suites.

### 15.8 — Out of scope (deferred / needs a ruling)

- **Skills top-level hub (15.3):** no-op this batch — Skills already has its own section under Tools. Moving it to a top-level hub revises the 8-hub ruling and needs an explicit ruling (filed as a Part 16 candidate).
- **Episodic timeline table:** `episodic_timeline` stays in the schema with no live writer; a future feature re-adds the sub-tab if it wants the surface.
