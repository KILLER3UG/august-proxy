# Full Codebase Refactor & Modernization Prompt
### (Production Refactor Edition — August Proxy)

> **Handoff snapshot:** 2026-07-14 · live tracker: `docs/REFACTOR_PROGRESS.md` · tip: verify with `git rev-parse master` (**Phases 0–4 DONE**)  
> Paste this entire document into a new session. Then **verify it against the repo** (Ground Rule 1) before coding.

Act as a Senior Principal Software Architect and Lead Developer. Your task is a comprehensive, end-to-end refactor of **August Proxy** — a large, working AI-agent proxy system: a Tauri + React 19 + TypeScript desktop app (plus an Expo React Native mobile companion) on the frontend, and a FastAPI Python backend spanning ~195 `app/` Python files across **32 routers** (200+ endpoints) and ~95 service files. This is a multi-phase migration of a live system, not a quick cleanup pass — treat the scale below as the default assumption for how you plan your work, not an edge case.

**This is a handoff, not a fresh start — and it's already mid-flight.** Phase 0–2 are signed off. **Phase 3 is DONE** against exit criteria (modular extracts including tool_registrations/`register_all`, workbench providers, SSE/system helpers, memory_schema; residual large files optional). **Phase 4 is DONE** against exit criteria: indexes, busy_timeout, hybrid SQLite schema rename (snake DDL + camel wire via `_row_as_wire`), full Zustand B18 migration (zero nanostores). **Not done:** true runtime performance program — see `docs/PHASE_PERF_AND_FLEXIBILITY_PLAN.md` (Phase P). Also Phase 5+ docs/tooling and Phase 7 feature testing. **Pick up from the Progress Log's current step** — do not restart Phase 0–4. Before doing anything else, read the Progress Log, then scan the actual repository yourself to confirm what it says is still accurate. Do not take the Progress Log, or any prior audit report it references, at face value — see Ground Rule 1.

**Authoritative live tracker:** `docs/REFACTOR_PROGRESS.md` (not repo root). Prefer it over any older chat paste if they disagree — but still verify both against the repo.

---

## Ground Rules (apply to every phase below)

1. **Verify, don't trust — including this document.** Any prior report, commit message, "resolved" label, or "proven" pilot result (including everything in the Progress Log below) is a claim, not a fact, until you've independently confirmed it by scanning the actual codebase yourself — use your own judgment on how thoroughly to check, based on how much is riding on the claim. If something doesn't match what's reported, stop and report the discrepancy — don't silently proceed on an unverified claim, and don't silently "fix" it into alignment without flagging it first. This applies to your own prior output too, not just other reports — if you find you verified something against the wrong state (e.g. a dirty working tree instead of actual HEAD), say so plainly rather than letting it stand uncorrected.
2. **Behavior-preserving by default.** The app works today. Nothing about what it *does* should change unless you find an actual bug — and bug fixes are reported and approved separately, never silently bundled into a rename or restructure.
3. **Never refactor and fix a bug in the same commit/diff.** Restructuring and behavior changes are two different diffs, so either can be reverted independently.
4. **Small, reviewable, iterative chunks.** One logical change per step. **CRITICAL:** Do not attempt to rewrite entire folders or modules at once. If a module has many files, work through them one by one, or provide refactored code file-by-file. Don't risk truncated or dropped output by trying to do too much in a single response. With ~95 backend service files and 32 routers here, expect this refactor to span many sessions — plan and communicate accordingly rather than trying to compress it.
   - Follow the **Commit Message Standard** below for every commit — see that section for the required format.
   - CamelModel scale-up rule: **one router per commit/branch**, push, wait for CI (`type-check.yml`, Python 3.12), then FF-merge when approved. Do not batch all remaining routers.
5. **Flag risky changes before applying them** — anything touching auth, payments, data writes/migrations, or shared state gets called out explicitly and waits for my go-ahead instead of being pushed through automatically. This includes destructive or ambiguous working-tree state left by a prior session (stashes, uncommitted changes, stray artifact files) — present options and wait, don't silently discard or silently commit someone else's in-flight work.
6. **Maintain a "Refactor Progress Tracker."** Update `docs/REFACTOR_PROGRESS.md` as you go. At the end of every response, include a brief checklist of what was just completed and what the next immediate step is.
7. **Don't modernize for its own sake.** Every change should have a reason (readability, performance, maintainability, bug prevention) — if you can't articulate why a pattern is better here, don't apply it just because it's newer.

### Commit Message Standard (Conventional Commits — required for every commit)

Every commit should state clearly and specifically **what the commit does** — not why it was needed. No vague messages ("update files", "fix stuff", "cleanup"). Format:

```
<type>(<scope>): <specific, imperative summary of what changed, ≤72 chars>

<optional body — only if the header can't fully cover it: a short,
factual list of what changed (files split, functions moved/renamed,
etc.). Describes the change itself, not the reasoning behind it.>

<optional footer — `BREAKING CHANGE: <what changed>`, `Refs: <phase/audit item>`>
```

- **Header:** imperative mood ("convert", "extract", "fix" — not "converted"/"extracting"/"fixed"), specific about what changed rather than generic.
- **Types:** `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `style`, `perf`, `build`, `ci`.
- **Scope:** the module/file group affected (e.g. `workbench`, `memory-store`, `naming`, `adapters`, `usage`).
- **Body is optional** — add it only when the header alone doesn't fully describe the change. Keep it a factual list of what changed, not a narrative justification.
- **Breaking changes** get a `BREAKING CHANGE:` footer.
- **Reference the source** in the footer where useful — Phase item, bug ID, or Known Large Files entry.

Example:

```
refactor(usage): convert UsageRecord to CamelModel with snake_case fields

- session_id, input_tokens, output_tokens, context_tokens
- JSON boundary remains camelCase via CamelModel aliases

No intentional behavior change to the usage API contract.

Refs: Phase 2 CamelModel scale-up
```

---

## Phase 0 — Audit & Planning (COMPLETED — verify, don't redo)

- **Phase 0 is signed off (2026-07-13).** Do not restart a full Phase 0 audit from scratch unless repo state contradicts the Progress Log.
- **Still required on every new session:** Read the Progress Log + `docs/REFACTOR_PROGRESS.md`, then independently verify key claims (HEAD SHA, branch list, open bugs, CamelModel progress, test/mypy baseline) against the real repo. Report discrepancies before coding.
- **Branch Audit:** As of this handoff, active remote work lives on `master` only. Enumerate branches anyway — a stale `refactor/b21-app-file-renames` may still exist locally/remotely at an old tip and is **safe to delete** (content already FF-merged). Do not resurrect closed merge-queue branches.
- Start from the **Codebase Reference** and **Database Overview** below — confirm drift, don't re-discover architecture.
- Check existing docs: `docs/REVIEW_REPORT.md`, `docs/PHASE2_TYPE_REMEDIATION_PLAN.md`, `docs/REMAINING_MYPY_FIXES.md` (**STALE** banner), `docs/STATIC_ANALYSIS_ERRORS.md`, and **`docs/REFACTOR_PROGRESS.md`**.
- Feature Inventory Summary below remains the Phase 7 checklist.
- Known residual audit notes (still open or partial — verify):
  - `UsageRecord` **name collision** (not the same type): API `CamelModel` in `routers/usage.py` vs curator `@dataclass` in `services/skills/curator.py` — consolidate/rename carefully; do not silently merge types.
  - Circular deps: none found last audit (lazy imports) — re-verify after module moves.
  - Monoliths: see Known Large Files.
- **Do not block on a new Phase 0 sign-off** unless verification finds material drift. Proceed from Progress Log "What's next."

## Phase 1 — Safety Net (non-negotiable, since this is a live codebase)

- Work on a dedicated branch per module/feature — never directly on the main branch for code changes (docs-only tracker commits on master are OK when recording merges).
- Before restructuring a module, record its current observable behavior so behavior parity can be verified afterward.
- If automated tests exist for a module you're about to touch, they must pass before and after.
- If tests **don't** exist for a module you're about to restructure, write minimal characterization tests first. Especially for `services/db_writer.py`, `services/daemon_manager.py`, `services/subagent_orchestrator.py`.
- Ensure type-checking passes (`tsc`/eslint for frontend, `mypy` for backend) after every module refactor. Capture baseline (pytest/mypy/ruff/tsc/eslint) before each change and diff against it after. **CI:** `.github/workflows/type-check.yml` pins Python **3.12** and runs ruff + mypy + pytest + frontend tsc/eslint. Push feature branches and wait for CI before merging — do not merge on local-venv alone. Local system Python 3.11 can fail collection; use `backend-py/.venv` (3.12).

## Phase 2 — Naming & Formatting Standardization (SIGNED OFF 2026-07-14)

Confirm baseline in Progress Log / live tracker before starting — **do not assume older prompt text.**

**Verified baseline (2026-07-13 handoff — re-verify):**
- Most backend modules/files are `snake_case`.
- **B16 function APIs closed** for `memory_store.py`, `db_writer.py`, `adapters/proxy_tools.py` (there is **no** `services/proxy_tools.py`). SQL table/column names remain camelCase until Phase 4 explicit sign-off.
- **B21 closed (filenames + callables + INTERNAL TypedDicts):** app/test renames; `resolve_or_fallback` / `resolve_for_model` etc.; AliasDict + related INTERNAL TypedDicts with wire conversion. **WIRE** TypedDicts still camelCase (SQLite/JSON parity) — see Progress Log.
- **CamelModel router scale-up COMPLETE:**
  - All request bodies under `app/routers/` use `CamelModel` (0 remaining `BaseModel` subclasses there).
  - Characterization tests: `tests/test_camel_model*.py`.

**Frontend (TypeScript/JavaScript) — Target: `camelCase`** *(keep/standardize)*
- Variables, functions, methods: `camelCase`
- Classes/Interfaces/Types: `PascalCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Files: `camelCase.ts` for utilities/services/hooks, `PascalCase.tsx` for components

**Backend (Python) — Target: `snake_case`**
- Variables, functions, methods: convert remaining `camelCase` to `snake_case`
- Classes: `PascalCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Files: rename remaining camelCase → snake_case (app files done; tests deferred)

**Reuse existing utilities:**
- `adapters/case_converters.py` — string-level camelCase ↔ snake_case
- `app/models/camel_base.py` — `CamelModel` with `ConfigDict(alias_generator=to_camel, populate_by_name=True)` — note: **`extra="allow"` is NOT on the base**; add it per-model when needed (as `ModelInfo` does)

**Database & ORM Safety (CRITICAL)**
- Python attribute renames must not change SQLite column names without an explicit, signed-off migration. Keep column mappings / raw SQL column names intact.

**Data Boundary Translation — proven and scaling**
- Option A (`CamelModel`) is ratified. Do not build a competing frontend interceptor.
- When converting a request model: rename fields to snake_case internally; keep JSON camelCase via aliases; add characterization tests (serialize `by_alias=True`, accept camelCase input, optional HTTP POST).
- **CamelModel ≠ converting callables in `model_resolver` / TypedDict keys in `type_aliases`.** Those are separate chunks (tracker calls this out).

**Enforcement**
- Set up/keep automated enforcement: ESLint naming-convention (frontend); Ruff (+ naming lint if added) on Python backend.

## Phase 3 — Structural Refactor (SUBSTANTIALLY COMPLETE; further slices optional)

**Modularization**
- Break up Known Large Files — still open for most targets.
- Reinforce existing layered folders; don't invent a new top-level shape.
- **`app/jsonUtils.py` split — DONE (B15):** now `json_narrowing.py` + `atomic_write.py`. Do not re-flag.

**OOP & Design Patterns** — same guidance as before; preserve existing factory/adapter/registry patterns.

**Data Structures & Algorithmic Efficiency** — same guidance as before; reuse `prompt_cache.py` LRU pattern where consolidating caches.

**File & Folder Structure** — same guidance; list dead code before deleting. B13/B14 cleanup already landed; B12 `.bak` files optional.

## Phase 4 — Modernization Pass

**Backend / Frontend** — same modernization menu as before. **B18:** nanostores → Zustand is confirmed and still **open** (Zustand not installed).

**Database**
- Keep raw `sqlite3` + `db_writer` design — no ORM reintroduction unless asked.
- **`db_writer` role — DOCUMENTED (B2 closed):** `_conn()` = WAL/busy_timeout write serialization; `enqueue_write` = priority/drop-policy queue on top (caller: `consolidation_daemon`). See `docs/ARCHITECTURE.md`. Do not "simplify away."
- `lib/storage_key_migration.py` busy_timeout inconsistency — still low priority / verify current state (B22 fixed a related table-name bug).
- **Missing indexes — CLOSED** (`5b21a50`): `messages(sessionId)`, `usageEvents(sessionId/createdAt)`, `sessions(isArchived)`, `blackboard(sessionId)`, `examAttempts(examId)`.
- **B1a non-atomic JSON writes — CLOSED.** `write_json_atomic` lives in `app/atomic_write.py`. Former sites fixed; curator uses temp + `Path.replace`. Re-verify with grep before assuming closed if time has passed.
- SQLite table/column camelCase→snake_case: **needs explicit sign-off** (high risk) — not bundled with naming work.

## Phase 5 — Dependency, Tooling & Documentation

- Same goals. Update `docs/ARCHITECTURE.md` / guides as structure changes. Tracker is `docs/REFACTOR_PROGRESS.md`.
- Pre-commit present (`B23`). CI type-check workflow present.

## Phase 6 — Bug, Error & Logic Reporting (mandatory, ongoing)

Report bugs with what / where / why / suggested fix. **Add to the Bug Tracker numbering below — do not renumber.**

## Phase 7 — Feature-Level Testing & Documentation

Still required before overall refactor sign-off. Feature Inventory Summary is the checklist. Not yet operationalized end-to-end.

## Phase 8 — Final Deliverables

Same deliverables as before when the full refactor completes.

### Definition of Done (updated checkmarks)

- [ ] All existing functionality verified working (tests and/or manual trace)
- [ ] No unapproved behavior changes
- [x] Boundary translation pattern proven (`CamelModel`) — **router scale-up complete** (0 BaseModel in `app/routers/`)
- [x] B16 function APIs snake_case for memory_store / db_writer / proxy_tools (SQL names deferred)
- [x] B21 app + test filenames snake_case; resolver callables snake_case; INTERNAL TypedDicts converted
- [x] Phase 2 signed off (2026-07-14) — full verification evidence pack in Progress Log
- [ ] Naming 100% consistent language-wide (WIRE TypedDicts + remaining adapter/service camelCase deferred)
- [ ] No remaining dead code (or explicitly listed as pending removal) — B12 `.bak` optional
- [ ] All flagged bugs documented with suggested fixes
- [x] `db_writer` role documented in `ARCHITECTURE.md` (B2)
- [x] B1a non-atomic JSON writes closed
- [x] B15 `jsonUtils` split landed
- [x] Historical merge-queue branches resolved (merged or dropped)
- [ ] Dependencies audited, lint/format tooling complete
- [ ] Every Feature Inventory item tested end-to-end and documented (Phase 7)
- [ ] Progress Log claims independently verified each session (Ground Rule 1)

---

## Execution Plan (pick up here — do not restart at Phase 0)

Because this is a large codebase, work iteratively.

**Current step:** Optional further Phase 3 slices (workbench chat loop / registerAll / anthropic stream). Phase 4: finish remaining Zustand stores or wait for schema rename sign-off.

**On session start:**
1. Acknowledge these instructions and the Codebase Reference.
2. Read Progress Log + `docs/REFACTOR_PROGRESS.md`; verify against repo (HEAD, branches, open bugs, CamelModel counts).
3. Confirm working tree clean; note any leftover `refactor/b21-app-file-renames` and offer delete.
4. Propose the next CamelModel router (or other chunk if user redirects) and **wait for approval** before coding if the change touches auth/data migrations/shared state — for routine CamelModel router conversions, proceed on a feature branch after stating which router, then push/CI before merge.
5. Do **not** start Phase 3 large-file splits or SQLite schema rename without explicit go-ahead.

---

## Progress Log (verify this, don't just read it — see Ground Rule 1)

*Last updated 2026-07-14 (Phase 2 signed off; Phase 3 started). Tip: `master` / `origin/master` (verify `git rev-parse HEAD`).*

### Merge Status (historical queue — CLOSED)

| Branch / item | Verdict | Status |
|---|---|---|
| `chore/cleanup-post-merge` | Merged | **✅ Done** |
| `fix/db-writer-coverage` / B2 | Cherry-pick + ARCHITECTURE docs | **✅ Done** (`3bc390e` / `894ecad`) |
| B1a atomic JSON writes | Fixed site-by-site | **✅ Closed** |
| `refactor/phase2-naming-pilot` / CamelModel pilot | On master | **✅ Done** (`c030ff6` / `5c2794a`) |
| `fix/mypy-green` | Never merge blindly | **✅ Dropped** — branch gone; characterization tests remain on master |
| Stale feature branches (phase0-cleanup, json-stores-atomic, etc.) | Absorbed | **✅ Gone** |
| `refactor/b21-app-file-renames` | FF-merged to master | **✅ Content on master**; local/remote branch ref may linger — **safe to delete** |
| `refactor/camelmodel-usage` | FF-merged | **✅ Done** (`40606d5`); branch deleted |
| `refactor/camelmodel-git` | FF-merged | **✅ Done** (`00904fe`); branch deleted |
| `refactor/camelmodel-memory` | FF-merged | **✅ Done** (`5cc6255`); branch deleted |
| `refactor/camelmodel-sessions` … `config` | FF-merged | **✅ Done** (`d4da6ec`…`95e6b0e`); branches deleted |

**Working tree:** expect clean on `master`. If dirty, stop and report (Ground Rule 5).

### Phase 0 sign-off — CLOSED

Signed off 2026-07-13 (meta-review evidence pack). G5–G7 dropped. Phase 2+ unblocked. Earlier "Resolved"/"User Decision" labels from prior audits remain less authoritative than verified repo state — especially SQLite schema snake_case (needs **explicit** future sign-off) and B18 Zustand (relaunched, not done).

### Naming Conversion Status

| Item | Status |
|---|---|
| Bulk backend snake_case (lib/memory/adapters/routers/services) | **Done** (prior rounds) |
| B16 `memory_store` / `db_writer` / `proxy_tools` **function** APIs | **Closed** |
| B21 app **filenames** | **Closed** |
| B21 **test** filenames (62 modules) | **Closed** (`380ad2f`) |
| camelCase **callables** in resolvers | **Closed** (`4b1b327`) |
| INTERNAL **TypedDict** fields | **Closed** (`0bc3e40`) — AliasDict + boundary helpers |
| WIRE **TypedDict** fields (SQLite/JSON) | **Deferred** to Phase 4 schema |
| CamelModel router scale-up | **✅ Complete** — 0 BaseModel in `app/routers/` |
| Phase 2 overall | **✅ Signed off 2026-07-14** (evidence pack in Progress Log) |
| Phase 3 modularization | **Substantially complete** (9 extracts; residual large chat/registerAll cores) |
| Phase 4 missing indexes | **✅ Done** |
| Phase 4 busy_timeout | **✅ Done** |
| Phase 4 schema rename | **Design only** — needs sign-off |
| Phase 4 B18 Zustand | **Pilot done** (browser-store); remaining nanostores open |
| SQLite schema/table camelCase | **Deferred** — needs explicit sign-off |

### Priority decision (current)

1. **Continue CamelModel scale-up** (one router at a time) — current rail.
2. Do **not** mix with large-file splits or SQLite schema migration in the same commit.
3. Remaining camelCase callables in renamed modules are a **separate** chunk from CamelModel (tracker B21 scope note).
4. B1/B2 data-safety gate already closed — do not re-open unless verification finds regressions.

### Bug Tracker (numbered, cumulative — add to this, don't renumber)

| ID | Severity | Location | Issue | Status |
|---|---|---|---|---|
| B1a | High | former JSON write sites | Non-atomic JSON writes | **CLOSED** |
| B2 | Med | `db_writer` / ARCHITECTURE | Queue role clarification | **CLOSED** (document only) |
| B11 | Med | nested `backend-py/backend-py/tests/` | Claimed nest | **Absent / closed** |
| B12 | Low | `data/*.bak` | Leftover backups | Open — optional delete |
| B13–B14 | Low | docs scratch / `server.log` | Stray artifacts | **CLOSED** |
| B15 | Med | `jsonUtils.py` | Mixed responsibilities | **CLOSED** → `json_narrowing.py` + `atomic_write.py` |
| B16 | Low | memory_store / db_writer / proxy_tools | camelCase function APIs | **CLOSED** (SQL names deferred) |
| B17 | Med | `fix/mypy-green` | Would delete characterization tests | **Dropped** — branch gone |
| B18 | Med | desktop frontend | nanostores → Zustand | **Open** — relaunch |
| B19 | Low | `REMAINING_MYPY_FIXES.md` | Stale branch refs | Marked STALE; paths updated for B21 |
| B20 | Low | Dockerfile | Claim not re-verified | **Open** |
| B21 | Med | app filenames + tests | camelCase filenames | **PARTIAL** — 3 app files done; 62 tests + callables/TypedDict fields remain |
| B22 | Med | storage_key_migration | Wrong table name | **CLOSED** |
| B23 | Low | pre-commit dep | Missing | **CLOSED** |
| B24 | Low | mcp `_saveConfig` | Dead writer | **CLOSED** |
| B25 | Low | ARCHITECTURE drift | enqueue_write / atomic_write docs | **CLOSED** |
| — | Low | `UsageRecord` name collision | usage router vs skills curator | **Open** — different types; rename/consolidate carefully |
| — | Low | `storage_key_migration` connection helper | Consistency with `_conn()` | **Open** — low priority |

### New features — tracked, but out of this refactor's scope

Same as before — do **not** fold into behavior-preserving phases:

**Feature Workstream — Real-Time Feature Flow Visualization UI** (backend execution visualizer, frontend)
- Feature Flow Schema & Events via log stream or `/api/monitor/events` SSE
- Trace animations; real-time error visualization; Feature Inventory Directory UI

**Feature Workstream — Optional Proxy-Path AUG.md Injection** (backend + settings UI)
- Config flag `inject_aug_on_proxy` (default `False`)
- When enabled, inject `AUG.md` into `/v1/messages` and `/v1/chat/completions` system prompt
- Frontend settings toggle

### Modularization gap (still open)

Scheduled/known: `workbench.py`, `anthropic.py`, `tool_definitions.py`, plus `adapters/openai.py`, `adapters/proxy_tools.py`, `adapters/stream_state.py`, `services/memory_store.py`. Naming-before-split rule still applies when both apply. **B16 naming for memory_store/proxy_tools APIs is done** — structural split can proceed later as its own commits.

### Feature-level testing (Phase 7) — not yet operationalized

Still required before Phase 8 sign-off.

### CamelModel progress (current rail)

| Item | Status |
|---|---|
| All `app/routers/` request bodies → `CamelModel` | ✅ Complete (`1d66d4d`) |
| Characterization tests `test_camel_model*.py` | ✅ Present |
| Remaining Phase 2 naming | WIRE TypedDict keys only (deferred); optional curator methods |

**Suggested next:** Phase 3 large-file splits with user go-ahead, or residual naming cleanup.

---

## Codebase Reference (August Proxy — ground truth, last verified 2026-07-13 handoff)

**Scale (re-verify if time has passed):**
- `backend-py/app/**/*.py` ≈ **176** (matches mypy)
- `adapters/` ≈ **7**; `models/` ≈ **8** (incl. `camel_base.py`, `config.py`); `lib/` ≈ **10**
- `providers/` top-level + `clients/` ≈ **6+7**
- `routers/` ≈ **32** (not 33)
- `services/` ≈ **95** incl. `memory/` ≈ **18**, `browser/` 5, `gateway/` (+platforms), `tools/` 7, `workbench/` 13, `skills/curator.py`
- Frontend: Tauri + React 19 + TS desktop; Expo RN mobile

**Known Large Files (Phase 3 targets — re-count lines before splitting):**

| File | Approx size | Notes |
|---|---|---|
| `services/workbench/workbench.py` | ~2239 lines | Chat engine |
| `services/tool_definitions.py` | ~1435 lines | Tool handlers |
| `adapters/anthropic.py` | ~1352 lines | Format translation |
| `services/memory_store.py` | ~907 lines | SQLite + FTS5 |
| `adapters/openai.py` | ~610 lines | Format translation |
| `adapters/proxy_tools.py` | ~638 lines | Tool interception |
| `adapters/stream_state.py` | ~543 lines | SSE state machine |

**Existing utilities to reuse:**
- `adapters/case_converters.py`
- `app/models/camel_base.py` — `CamelModel`
- `app/json_narrowing.py` / `app/atomic_write.py` (ex-`jsonUtils`)
- `services/workbench/prompt_cache.py`
- `services/logger.py` / `services/log_stream.py`
- `memory_store._conn()` — canonical SQLite gate
- `db_writer.enqueue_write` — priority queue on top of `_conn()`

**Docs:** `docs/REFACTOR_PROGRESS.md` (live), `docs/ARCHITECTURE.md`, guides, plus STALE analysis docs. Prefer tracker over STALE docs.

**Feature Inventory Summary** (Phase 7 checklist — unchanged):
- Multi-provider proxy/adapter translation (6 formats, providers, alias/routing/fallback)
- Memory & learning system (memory subsystem + background processes incl. self-evolution, auto memory, consolidation, daemons)
- Tools (~50 across categories)
- Cognitive architecture (4 model roles, 7 task-type policies)
- Gateway platforms (Telegram / Slack / Discord)
- Skills system (85+ skills, curator)
- Security & safety (allow-lists, SSRF, guardrails, CORS, secrets)
- Frontend capabilities (chat SSE, monitor, memory browser, providers, sessions, terminal, skills, brain dashboard, settings, mobile)

## Database Overview (Reference — re-verify runtime facts)

**1. SQLite — `august_brain.sqlite`**
- Driver: raw `sqlite3` (no ORM)
- `./data/august_brain.sqlite` (`AUGUST_BRAIN_SQLITE_FILE`)
- Core: `services/memory_store.py` — tables still camelCase names (`memoryStore`, `usageEvents`, …)
- Write path: `_conn()` WAL + busy_timeout; `enqueue_write` for priority queue (consolidation only)
- **Missing indexes — still open** (list above in Phase 4)

**2. JSON-file stores**

| Store | Status |
|---|---|
| `config.json`, `providers.json`, `request-log.json`, `workbench-sessions.json` | Typically present |
| `august_vector_memory.json`, `august_graph_memory.json`, `scheduled-jobs.json` | Often absent until first write (lazy) |
| Atomic writes | Use `app.atomic_write.write_json_atomic` |

## Project Context

- **Frontend:** Tauri + React 19 + TypeScript (desktop), Expo React Native (mobile)
- **Backend:** FastAPI (Python 3.12+; CI pins 3.12)
- **Database:** SQLite + JSON stores
- **Tests / types (baseline at handoff):** pytest **604** collected · mypy **0 / 176** · ruff clean · CI `type-check.yml`
- **Current priority:** CamelModel scale-up (next router) — not B1a, not branch merges, not Phase 0 redo
- **Risky modules:** `workbench.py`, `memory_store.py`, `db_writer.py`, `self_evolution.py`, `delta_engine.py`, `daemon_manager.py`, `subagent_orchestrator.py`

---

## Session close note (for the next model)

Stop state: Phase 2 signed off; Phase 3 substantially complete; Phase 4 almost done (indexes, busy_timeout, schema plan, Zustand pilot). Next: optional further modularization, remaining Zustand stores, or schema rename after sign-off. Keep Ground Rule 1.

Are you ready to begin? If so, verify the Progress Log and Codebase Reference against the real repository first, report anything that doesn't match, then continue CamelModel scale-up from the current step rather than restarting from scratch.
