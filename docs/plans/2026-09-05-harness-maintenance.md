> **Open items are tracked in `docs/ROADMAP.md`. This document is a record of the
> findings and the design, not a task list** — the open items live in the roadmap;
> the reasoning that produced them lives here.
>
> **Corrected 2026-10-20 against the tree at `5cdae644`.**
>
> - **The header's "Status: DRAFT awaiting ruling" is wrong — most of this plan
>   shipped.** §1, §2.2–§2.4 and §6 are landed; §2.1 and §3 are still open.
> - **§7's validation gates are HISTORICAL.** The whole test suite was deleted
>   on 2026-10-17: `uv run pytest` and `npm run test:frontend` no longer exist.
>   The live gates are `uv run ruff check . && uv run mypy app/` and
>   `npm run check -w frontend/desktop`, plus the static `check:*` scripts.
> - **§6b and §8 are now STANDING RULES IN `AGENTS.md`.** They used to live only
>   in this file and nowhere else in the tree, so a session that never opened
>   this plan never saw them. They were moved verbatim into
>   `AGENTS.md` ("Two standing rules") on 2026-10-20; the text below is kept as
>   the record of where they came from.
>
> Earlier note (2026-09-27) — Header says "DRAFT awaiting ruling", but most of
> it has since shipped. Landed: `_frozen_vcs` and the date line removed from the
> prompt, `load_layered` mtime cache (`aug_directive_service.py:151-164`), the
> `AUGUST_AUTO_PROFILE` comment gone, `write_files` in `GATED_EDIT_TOOLS`
> (`read_before_edit.py:49`), sub-agent observation, and the bridge gate +
> ledger. Still open: §2.1 (auto-trust is retained) and §3's comment sweep.

# Harness Maintenance — Prompt Cache, Edit Gate Hardening, Comment Tags
Date: 2026-09-05 · **Status: MOSTLY SHIPPED — §1, §2.2–§2.4 and §6 landed; §2.1 and §3 still open** (the original header read "DRAFT awaiting ruling", which was true on 2026-09-05 and is not now) · Continues the numbered plan series (Part 27 was 2026-09-05-subagent-ui-parity.md)

> **The two standing rules this plan introduced (§6b and §8) now live in
> `AGENTS.md`**, under "Two standing rules (moved here from
> `docs/plans/2026-09-05-harness-maintenance.md`)". They are read by every agent
> session, which is where rules about *how to work* belong; a rule that lives
> only in a plan doc is a rule nobody follows. §6b and §8 below are kept as the
> record.

This plan is written self-contained from the working tree. Every item was verified at file:line level against HEAD `3a658a9c`; corrections to the source audit that motivated it are folded in and cited inline, so nothing here repeats a claim that failed verification. Two of the three workstreams ship as rider items under existing Part 1–27 scope names (no new part number is minted; see §8 naming rule).

## §1 Prompt-cache stability — kill the last unstable bytes in the system prompt

Goal: the system prompt is byte-identical across every turn of a session (and across same-workspace sessions), so provider prefix-cache hit rate reaches what the earlier prompt-cache freeze work promised. All verification of the motivating claims is at workbench.py current line numbers.

### 1.1 Workspace VCS line — the one real turn-buster
The workspace block embeds `vcs: {branch}{dirty}` and a recent-commits line, refreshed by a 60 s probe (`workbench.py:847-890`). Every commit the agent itself makes (or any dirty-state flip) re-renders the prefix after probe TTL. Fix: freeze the rendered vcs string once at session start (first `buildSystemPrompt` call); do not re-probe for prompt purposes until a new session starts. The UI/right-drawer can keep live probing — only the PROMPT must freeze. A probe-cache hit must still not string-format per call: capture the frozen string.

- `backend-py/app/services/workbench/workbench.py` — `buildSystemPrompt` vcs embed; add a per-session `_frozen_vcs` field beside `_frozen_mem_index` (`sessions.py:143` — the field landed there; `_frozen_mem_index` is at `:130`). **SHIPPED**: the freeze is in the tree at `workbench.py:789-797` (read `session._frozen_vcs`, probe once, reuse).
- `tests/test_prompt_cache_stability.py` — new test: agent makes a commit mid-session (fixture: run `git commit` between two `buildSystemPrompt` calls); assert both prompts byte-identical.

### 1.2 Date line — move to volatile tail — **SHIPPED, in a stronger form than planned**
`- Date: {nowLabel}` (`workbench.py:1148-1150`, embedded :1283) changes at midnight/DST — one bust/day. Move it into `_sessionStateBlock` (`workbench.py:1647-1681`), which is appended to the last user message and is the designated volatile region. Note the correction: this was never a per-turn buster (the audit overstated), but it is still a guaranteed once-a-day cache kill for late-night sessions. — **What shipped is stronger than "moved": the date line is GONE from the system prompt entirely.** There is no `Date:` line anywhere in `backend-py/app/services/workbench/` (a grep for `Date:` across the package returns zero hits); the `<intake>` manifest that lists what the context carries (`workbench.py:879-899`) does not name a date either.

- `workbench.py` — move line from intake block to `_sessionStateBlock`; keep date format identical.
- `tests/test_prompt_cache_stability.py` — `test_session_block_holds_no_volatile_or_unique_fields` (:123) currently asserts the session block has no volatile fields; amend it to assert the date lives there now (its purpose is exactly to hold volatile content).
- `tests/test_prompt_slim.py`, `tests/test_bot_mode_phase_e.py` — fixture updates where they pin current prompt shape.

### 1.3 AUG.md re-read — per-round disk IO, not a cache buster
`aug_directive_service.load_layered()` is called on every `buildSystemPrompt` (workbench.py:1099) — every model round — and each call re-reads AUG.md layers from disk (`aug_directive_service.py:174`) with no memoization. The intake line embeds only the char count (byte-stable), so this is a disk-IO cost, not a cache buster (audit correction folded in). Fix: memoize per (path, mtime) — mtime check already exists in the module for other paths; re-read only on file change.

- `backend-py/app/services/aug_directive_service.py` — mtime-keyed cache for `load_layered` body reads. **SHIPPED**: `_layered_cache` at `aug_directive_service.py:157`, the fingerprint helper `_stat_sig` at `:186-189`, the lookup at `:267-269`; the anchor this line used to quote (`:174`) has moved.
- New test in `tests/test_prompt_slim.py` or a small standalone test file: write AUG.md, build prompt, rewrite AUG.md, build again → second prompt differs (proves cache invalidation fires); two consecutive builds identical.

### 1.4 Death of stale comment — **SHIPPED**
`workbench.py:1720` referenced `AUGUST_AUTO_PROFILE` — a variable that was never read anywhere. The comment line was removed; a grep for `AUGUST_AUTO_PROFILE` across `backend-py/app/` now returns **zero** hits.

## §2 Edit-gate hardening — read-before-write, fully enforced

Goal: whenever the model calls a tool that writes or edits a workspace file, the harness verifies it has read that file since the last change on disk (including changes made by the model's own previous write). If not, the tool refuses with a notice telling it to read first. The gate already exists — `read_before_edit.py` implements the `[edit-unseen]` / `[edit-stale]` refusal loop (parent loop check workbench.py:4546-4560, observation :4859-4866) — but verification found four gaps, one of which directly contradicts the spirit of the ruling: after a successful gated edit, `observe_after_mutation` auto-records the new content as read, so the model can chain edits without ever re-reading.

### 2.1 Enforce re-read after own writes (user ruling) — **STILL OPEN**
Change `observe_after_mutation` (`read_before_edit.py:228-245` — the anchor has drifted from `:116-128`) to NOT auto-trust post-write content. **Re-verified 2026-10-20: the auto-trust is still there.** The docstring now says it in as many words — *"The observation from the model's read STAYS — that is what lets the model chain several edits to the same file in one turn"*. The ruling the user gave is the opposite of what shipped, so this item is still open and the user's stated rule is still not enforced. After `write_file`/`edit_lines`/`apply_patch` succeeds, clear the ledger entry instead of seeding it, so a follow-up edit is refused with `[edit-unseen]` until the model re-reads. The refusal text already teaches the recovery loop (":…Read the file with read_file first, then retry the edit.").

Rationale: the user's stated rule — "if the model change/update a line of code it must read it again so that it got the latest code" — is the opposite of auto-trust. The hash-anchor check (workbench.py:5501-5543) remains as the second line of defense when the model passes `fileHash`.
- `read_before_edit.py` — change `observe_after_mutation` semantics; update module docstring (which currently documents the auto-trust behavior).
- `tests/test_read_before_edit_t17.py` — flip the post-write test expectation: second edit after own write → `[edit-unseen]` (currently asserts pass-through).
- `tests/test_workbench_tool_loop.py:881 TestReadBeforeEditInLoop` — the in-loop end-to-end test; extend for the own-write case.

### 2.2 Bulk write gate — **SHIPPED**
`write_files` (`bulk_tools.py:92`, `_bulk_write_files` — the anchor has drifted from `:82`) was not in `GATED_EDIT_TOOLS` and bypassed the gate entirely. **It is now gated**: `GATED_EDIT_TOOLS = frozenset({'write_file', 'edit_lines', 'apply_patch', 'write_files'})` at `backend-py/app/services/workbench/read_before_edit.py:49` (the anchor has drifted from `:31`), and the module's own comment records that "`bulk` is gated only when its operation resolves to write_files".

- `read_before_edit.py` — multi-path extraction + `write_files` into `GATED_EDIT_TOOLS`.
- `bulk_tools.py` — no executor change (gate fires pre-dispatch), but confirm cache clears.
- `tests/test_read_before_edit_t17.py` — bulk-unseen and bulk-stale cases.

### 2.3 Subagent observation parity — **SHIPPED**
The subagent worker loop used to check the gate but never record observations. **It records them now**: `backend-py/app/services/workbench/subagent.py:1293` imports `_observeReadFile` and calls it at `:1346` and `:1357` inside the worker loop (the anchors this paragraph used to quote — `:1037-1042`, `:1016-1021`, `:1046-1048` — have all drifted).

- `backend-py/app/services/workbench/subagent.py` — add observation recording after tool execution.
- `tests/test_subagent_capabilities_prompt.py` or the worker-loop suite — subagent reads → edits → passes; subagent edits unread file → refused.

### 2.4 Code-mode bridge gate — **SHIPPED**
Code mode's `call_tool` bridge (`kernel.bridge_call`, `backend-py/app/services/workbench/kernel.py:833` — the anchor has drifted from `:514-542`) used to check guards but not the read gate. **It checks both now**: `kernel.py:857` calls `wb._readBeforeEditGate(session, name, args)` and returns the refusal, and `kernel.py:862-874` keeps the ledger in parity (pin versions on reads, forget them on writes) — the comment there names the reason: "otherwise the next bridge edit is refused against a ledger that no longer matches disk". Child-side embedded `write_file` (inside the fenced python block itself) stays out of scope — it runs in a child process, cannot see the parent ledger, and its sandbox already contains it.

- `backend-py/app/services/workbench/kernel.py` — gate at :535.
- `tests/test_kernel_t13.py` — bridge write without read → refused with `[edit-unseen]`.

### 2.5 Optional completeness (recommend, low priority)
`pptx_comment` and artifact-creation tools (render_chart, draw_circuit, …) write workspace files ungated. Mostly create-new-file style (always-allowed anyway); only `pptx_comment` mutates in place. Add it to `GATED_EDIT_TOOLS` only if cheap; else document the exclusion in read_before_edit.py's docstring.

## §3 Comment-tag sweep — comments describe the fix, not the plan tag

Goal: no source comment, docstring, or user-visible string carries "Part N / Wave X / Phase Y / T-number / § / OQ" plan tags. A reader of the code should understand each comment from the comment itself. Verified scope: ~330 files, ~940 genuine tag lines (95% of raw grep hits are genuine; the rest are ISO timestamps and EDA-domain words). Sources for what each tag meant: the plan docs in `docs/plans/` and git history. **STILL OPEN.** Re-measured 2026-10-20 across `backend-py/app` and `frontend/desktop/src`: **77** `\bPart\s+2[0-9]\b` line matches and **174** `\bPart\s+\d+\b` matches remain (this plan's earlier note said "~55 `Part 2x` tags"; the count moves as other work lands, so re-measure before quoting it).

### 3.1 Sweep rules
- REWRITE, don't delete: every tagged comment gets a replacement sentence describing the actual constraint/fix (e.g. `# Part 27 T5: _record_run is a SELECT+UPDATE+commit…` → `# _record_run persists on every streamed subagent event; keep it time-throttled — this runs on the hot path.`). The tag never survives; the knowledge does.
- Tag families: `Part \d+` (515), `Phase [A-Z0-9]` (330), `§` (286), `T\d+:` genuine (43), `Wave [A-Z0-9]` (3), `OQ \d` (52). Case-sensitive, word-boundary matching.
- Docstrings count as comments: ~99 backend docstring lines start with a tag (e.g. routers/curator.py:1 `"""Curator API routes (Part 16 Phase E)…"""` → describe what the router does).
- Test names and describe/it blocks: rewrite the prose (33 backend `test_phase7_*` style names + 33 frontend describe/it). Keep the assertion content unchanged.
- 5 user-visible strings reworded (review_cli.py:114 --help, brain_config.py:96 OpenAPI description, harness_promote.py:270+451 evidence strings — these two persist into the proposals DB, so old rows keep old wording; cosmetic, not a join key — refine_store.py:757).
- Migration header comments: safe to reword (`--` comments only, never statement text) — 21 migrations, 25 lines.

### 3.2 Do NOT touch
- `plan_waves` / `activeWave` / `harness-wave.ts` / `workstreams.py` — domain code for subagent wave dispatch (a real feature), not plan tags.
- EDA deep-dive plan headers (6 lines: kicad/fpga/hdl/firmware_tools.py:1, CircuitWaveformViewer/Instruments.tsx) — a separate plan lineage; sweep only if that plan is retired.
- Version anchors: `(0.17.0)`, `0.12.21 incident` — 7 lines, meaningful. Keep.
- Test FILENAMES (30 part-tagged test files, 7,014 lines of regression snapshots). Renames are mechanically safe but git-blame-hostile; first pass leaves filenames alone. Tagged prose inside them still gets rewritten.
- Root `CHANGELOG.md`, `docs/plans/*.md`, git history — out of scope by definition.
- Functional fixture keys like `p26:*` inside test_part26_wave3.py — internal to the test, keep.

### 3.3 Effort split
~327 files / ~940 lines, split: backend app 138 files (~340 comment + ~99 docstring + 21 SQL headers), backend tests 88, frontend src 76, frontend tests 25, scripts 4+1. Top single files: workbench.py 89 hits, episode_miner.py 32, MemorySection.tsx 22. Suggested split into 3 PR-sized batches: (A) backend app + migrations, (B) backend tests, (C) frontend + scripts. Suggested order: A → B → C, each batch independently tsc/ruff/mypy/pytest-green before moving on.

## §4 Deferred items recorded, not planned
- Docker/LAN authz (the six unauth surfaces) — needs a ruling on whether Docker/LAN is a supported deployment; if yes, that becomes a standalone security plan, not a rider.
- §3.4 authz / mega-function split (2,695 lines) — after §1-§3 land and a green baseline exists.
- Version-sync note: none of the touch lists below bump any of the 7 version-sync files. If §2 changes wire behavior (write-refusals), consider a version bump + release-notes line at ship time (release notes are generated; test_release_notes_features.py guards them).

## §5 File manifest (per workstream)

### Prompt-cache (§1)
| File | Change |
|---|---|
| backend-py/app/services/workbench/workbench.py | vcs freeze, date-to-tail move, AUG auto-profile comment removal |
| backend-py/app/services/aug_directive_service.py | mtime-keyed read cache |
| backend-py/app/services/workbench/sessions.py | `_frozen_vcs` RAM-only field |
| backend-py/tests/test_prompt_cache_stability.py | new freeze tests + amend :123 assertion |
| backend-py/tests/test_prompt_slim.py, test_bot_mode_phase_e.py | fixture updates |

### Edit gate (§2)
| File | Change |
| backend-py/app/services/workbench/read_before_edit.py | no auto-trust after own write; bulk multi-path gate; (optional) pptx_comment |
| backend-py/app/services/tool_registrations/bulk_tools.py | confirm cache clears on bulk write |
| backend-py/app/services/workbench/subagent.py | observation recording after tool exec |
| backend-py/app/services/workbench/kernel.py | bridge gate at :535 |
| backend-py/tests/test_read_before_edit_t17.py | flipped + bulk + subagent cases |
| backend-py/tests/test_workbench_tool_loop.py | extend TestReadBeforeEditInLoop |
| backend-py/tests/test_kernel_t13.py | bridge refusal case |

### Comment sweep (§3)
| Scope | Files |
|---|---|
| Backend app + migrations | ~138 files (top: workbench.py 89, episode_miner.py 32, brain.py 20, skill_service.py 17, fact_retrieval.py 17, consolidation.py 17, type_aliases.py 15, session_tools.py 14; full inventory in the review session's findings) |
| Backend tests | ~88 files |
| Frontend src | ~76 files (MemorySection.tsx 22, AssistantBlockTimeline.tsx 16) |
| Frontend tests | ~25 files |
| Scripts | 4 + check-doc-links.mjs + genPhase8.py delete |
| User-visible strings | review_cli.py:114, brain_config.py:96, harness_promote.py:270,451, refine_store.py:75 §5 outputs |
| Test-name rewrites | 33 backend test funcs + 33 frontend describe/it |

## §6 Deletion manifest (bloat cleanup, verified zero-reference)
| File | Status |
|---|---|
| backend-py/scripts/genPhase8.py | untracked-orphan one-shot generator, zero refs — DELETE |
| The 8 scratch audit files (_bloat_*.py/txt, _real_zero, _zero_*) | already deleted this session |
| backend-py/app/adapters/anthropic_stream_translate.py | functionality-dead; delete + remove re-export shim in anthropic.py:101-105 + update test_adapters.py:8,15 |

## §6b Junk-file rule (standing) — **MOVED TO `AGENTS.md`**
When finishing a session, delete scratch files you created (scan outputs, generator scripts, unused drafts) before committing. The repo carries no `_*.py` / `_*.txt` scratch artifacts; genPhase8.py is the last such leftover. Keep this rule stated in this plan so future sessions see it. — **This rule used to live ONLY here, in a plan file, and nowhere else in the tree or in `AGENTS.md`. That is why it was not followed: a rule a session never reads is not a rule. It was moved verbatim into `AGENTS.md` on 2026-10-20, under "Two standing rules", where every agent session sees it. The text above is kept as the record of where it came from.**

The repo working tree at plan-write time holds one intentional uncommitted WIP: frontend/desktop/src/store/sessions/helpers.ts (dedupeSessions O(n)→O(1)) and one untracked WIP component ActionNeededCard.tsx — both are the user's, do not touch, do not fold into this plan's commits.

## §7 Validation gates — **HISTORICAL; the live gates are below**
> **The commands in this section no longer exist.** The whole test suite was
> deleted on 2026-10-17: `backend-py/tests/` (1,690 files), the 235 frontend
> `*.test.ts(x)` files with their `__tests__/` directories, `frontend/desktop/e2e/`,
> the `pytest` configuration, the coverage floor and the `npm test` /
> `npm run test:frontend` scripts. `uv run pytest` and `npm run test:frontend`
> are gone. **The live gates are:**
>
> - **Backend:** `cd backend-py && uv run ruff check . && uv run mypy app/`
> - **Frontend:** `npm run check -w frontend/desktop` (tsc + eslint)
> - **Docs/design, repo root:** `npm run check:docs`, `check:design`,
>   `check:naming`, `check:api`, `check:api-index`, `check:sse`, `check:version`,
>   `check:doc-links`, `check:minisign`, `check:truncate`, `check:brain-config`,
>   `lint:ratchet`
> - **Smoke:** `npm run e2e:smoke` — starts the backend against a throwaway
>   data directory and asks its basic doors a question
>
> The gates below are kept as the record of what this plan was verified with.

- Backend: `uv run ruff check . && uv run mypy app/ && uv run pytest -q --basetemp="$TEMP/august_pytest"` (~2,313 tests expected) — **the pytest half is gone; the ruff + mypy half is the live backend gate.**
- Frontend: `npm run test:frontend` at repo root or `cd frontend/desktop && npm run test` (988/988) + `npm run typecheck` (tsc -b) — **gone; `npm run check -w frontend/desktop` is the live gate.**
- §1: new byte-stability tests green — **the tests are gone; §1's behaviour is verified by reading the code** (the frozen vcs at `workbench.py:789-797`, the absent date line).
- §2: flipped auto-trust test + bulk + bridge + subagent cases green — **the tests are gone; §2.2–§2.4 are verified by reading the code** (`read_before_edit.py:49`, `subagent.py:1293/1346/1357`, `kernel.py:857`).
- §3: `grep -rnE 'Part [0-9]+|Wave [A-Z]|Phase [A-Z0-9]|§|OQ [0-9]' backend-py/app frontend/desktop/src` returning only the do-not-touch list (§3.2 exclusions) — target zero genuine hits outside that list — **still the live check for §3, and it is not at zero yet.**
- Coverage gate runs on full suite only; targeted runs fail it by design (not a blocker) — **the coverage gate was retired with the suite.**

## §8 Naming rule (the reason there is no Part 28) — **MOVED TO `AGENTS.md`**
Standing rule from this plan onward: **new work riders under existing part numbers where the scope fits, and never mint "Part 28+" tags in code or commit messages.** Comments and identifiers describe what the code does and why, not which plan document created them. When a change doesn't fit an existing part's scope, it gets a plan doc under `docs/plans/<date>-<slug>.md` with a descriptive slug (like this one), and code references it by slug, never by number. The numbered series (Part 1–27) remains closed. — **This rule used to live ONLY here. It was moved verbatim into `AGENTS.md` on 2026-10-20, under "Two standing rules", because the numbered Part series stopped at 27 partly BECAUSE the rule was in one file instead of where every session reads it. The text above is kept as the record.**

## §9 Open questions (researched recommendations, confirm or revert)
- OQ1: §2.1 auto-trust removal will make multi-edit sessions chattier (one extra read per edit). Recommendation: ship as ruled; the read is cheap and the refusal text teaches recovery. (Default: ship.)
- OQ2: §2.5 pptx_comment gating — recommendation: skip; document exclusion instead. (Default: skip.)
- OQ3: §3 test-filename renames — recommendation: leave filenames, rewrite inner prose only. (Default: leave.)
- OQ4: genPhase8.py — recommendation: delete. (Default: delete, already verified zero refs.)
- OQ5: The plan deliberately does NOT mint a new part number. If you later want a numbered continuation for the mega-function split or authz work, mint it as a new dated-slug plan doc and reference by slug.
