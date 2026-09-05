# Harness Maintenance — Prompt Cache, Edit Gate Hardening, Comment Tags
Date: 2026-09-05 · Status: DRAFT awaiting ruling · Continues the numbered plan series (Part 27 was 2026-09-05-subagent-ui-parity.md)

This plan is written self-contained from the working tree. Every item was verified at file:line level against HEAD `3a658a9c`; corrections to the source audit that motivated it are folded in and cited inline, so nothing here repeats a claim that failed verification. Two of the three workstreams ship as rider items under existing Part 1–27 scope names (no new part number is minted; see §8 naming rule).

## §1 Prompt-cache stability — kill the last unstable bytes in the system prompt

Goal: the system prompt is byte-identical across every turn of a session (and across same-workspace sessions), so provider prefix-cache hit rate reaches what the earlier prompt-cache freeze work promised. All verification of the motivating claims is at workbench.py current line numbers.

### 1.1 Workspace VCS line — the one real turn-buster
The workspace block embeds `vcs: {branch}{dirty}` and a recent-commits line, refreshed by a 60 s probe (`workbench.py:847-890`). Every commit the agent itself makes (or any dirty-state flip) re-renders the prefix after probe TTL. Fix: freeze the rendered vcs string once at session start (first `buildSystemPrompt` call); do not re-probe for prompt purposes until a new session starts. The UI/right-drawer can keep live probing — only the PROMPT must freeze. A probe-cache hit must still not string-format per call: capture the frozen string.

- `backend-py/app/services/workbench/workbench.py` — `buildSystemPrompt` vcs embed (~:1186-1192 intake line, ~:1294-1297 workspace block); add a per-session `_frozen_vcs` field beside `_frozen_mem_index` (sessions.py:129 pattern for RAM-only fields).
- `tests/test_prompt_cache_stability.py` — new test: agent makes a commit mid-session (fixture: run `git commit` between two `buildSystemPrompt` calls); assert both prompts byte-identical.

### 1.2 Date line — move to volatile tail
`- Date: {nowLabel}` (`workbench.py:1148-1150`, embedded :1283) changes at midnight/DST — one bust/day. Move it into `_sessionStateBlock` (`workbench.py:1647-1681`), which is appended to the last user message and is the designated volatile region. Note the correction: this was never a per-turn buster (the audit overstated), but it is still a guaranteed once-a-day cache kill for late-night sessions.

- `workbench.py` — move line from intake block to `_sessionStateBlock`; keep date format identical.
- `tests/test_prompt_cache_stability.py` — `test_session_block_holds_no_volatile_or_unique_fields` (:123) currently asserts the session block has no volatile fields; amend it to assert the date lives there now (its purpose is exactly to hold volatile content).
- `tests/test_prompt_slim.py`, `tests/test_bot_mode_phase_e.py` — fixture updates where they pin current prompt shape.

### 1.3 AUG.md re-read — per-round disk IO, not a cache buster
`aug_directive_service.load_layered()` is called on every `buildSystemPrompt` (workbench.py:1099) — every model round — and each call re-reads AUG.md layers from disk (`aug_directive_service.py:174`) with no memoization. The intake line embeds only the char count (byte-stable), so this is a disk-IO cost, not a cache buster (audit correction folded in). Fix: memoize per (path, mtime) — mtime check already exists in the module for other paths; re-read only on file change.

- `backend-py/app/services/aug_directive_service.py` — mtime-keyed cache for `load_layered` body reads (~:174 area, beside the existing mtime cache at :105).
- New test in `tests/test_prompt_slim.py` or a small standalone test file: write AUG.md, build prompt, rewrite AUG.md, build again → second prompt differs (proves cache invalidation fires); two consecutive builds identical.

### 1.4 Death of stale comment
`workbench.py:1720` references `AUGUST_AUTO_PROFILE` — a variable that is never read anywhere. Remove the comment line (verified comment-only, zero reads repo-wide).

## §2 Edit-gate hardening — read-before-write, fully enforced

Goal: whenever the model calls a tool that writes or edits a workspace file, the harness verifies it has read that file since the last change on disk (including changes made by the model's own previous write). If not, the tool refuses with a notice telling it to read first. The gate already exists — `read_before_edit.py` implements the `[edit-unseen]` / `[edit-stale]` refusal loop (parent loop check workbench.py:4546-4560, observation :4859-4866) — but verification found four gaps, one of which directly contradicts the spirit of the ruling: after a successful gated edit, `observe_after_mutation` auto-records the new content as read, so the model can chain edits without ever re-reading.

### 2.1 Enforce re-read after own writes (user ruling)
Change `observe_after_mutation` (`read_before_edit.py:116-128`) to NOT auto-trust post-write content. After `write_file`/`edit_lines`/`apply_patch` succeeds, clear the ledger entry instead of seeding it, so a follow-up edit is refused with `[edit-unseen]` until the model re-reads. The refusal text already teaches the recovery loop (":…Read the file with read_file first, then retry the edit.").

Rationale: the user's stated rule — "if the model change/update a line of code it must read it again so that it got the latest code" — is the opposite of auto-trust. The hash-anchor check (workbench.py:5501-5543) remains as the second line of defense when the model passes `fileHash`.
- `read_before_edit.py` — change `observe_after_mutation` semantics; update module docstring (which currently documents the auto-trust behavior).
- `tests/test_read_before_edit_t17.py` — flip the post-write test expectation: second edit after own write → `[edit-unseen]` (currently asserts pass-through).
- `tests/test_workbench_tool_loop.py:881 TestReadBeforeEditInLoop` — the in-loop end-to-end test; extend for the own-write case.

### 2.2 Bulk write gate
`write_files` (bulk_tools.py:82) is not in `GATED_EDIT_TOOLS` (read_before_edit.py:31) and bypasses the gate entirely. Add it: the gate needs a multi-path variant (its check path extracts a single `path` arg at :80) — either iterate `files:[{path, content}]` entries or pre-check all paths, refusing the whole batch when any target is unseen/stale. New-file creation stays always-allowed.

- `read_before_edit.py` — multi-path extraction + `write_files` into `GATED_EDIT_TOOLS`.
- `bulk_tools.py` — no executor change (gate fires pre-dispatch), but confirm cache clears.
- `tests/test_read_before_edit_t17.py` — bulk-unseen and bulk-stale cases.

### 2.3 Subagent observation parity
The subagent worker loop checks the gate (subagent.py:1037-1042) but never records observations: no `_observeReadFile` after reads, no mutation recording after edits. A subagent that reads a file itself still gets refused on follow-up edit unless the parent read it first. Since workers share the parent session object (subagent.py:1016-1021), add the observation block from workbench.py:4859-4874 into the worker loop after the `_executeTool` call (subagent.py:1046-1048).

- `backend-py/app/services/workbench/subagent.py` — add observation recording after tool execution.
- `tests/test_subagent_capabilities_prompt.py` or the worker-loop suite — subagent reads → edits → passes; subagent edits unread file → refused.

### 2.4 Code-mode bridge gate
Code mode's `call_tool` bridge (`kernel.bridge_call`, kernel.py:514-542) checks guards but not the read gate — child-side `write_file` (code_runner.py:88) is sandboxed but ledger-untracked. Gate `bridge_call` write tools at kernel.py:535, reusing `check_read_before_edit` against the bridge session's ledger; child-side embedded `write_file` (inside the fenced python block itself) stays out of scope — it runs in a child process, cannot see the parent ledger, and its sandbox already contains it.

- `backend-py/app/services/workbench/kernel.py` — gate at :535.
- `tests/test_kernel_t13.py` — bridge write without read → refused with `[edit-unseen]`.

### 2.5 Optional completeness (recommend, low priority)
`pptx_comment` and artifact-creation tools (render_chart, draw_circuit, …) write workspace files ungated. Mostly create-new-file style (always-allowed anyway); only `pptx_comment` mutates in place. Add it to `GATED_EDIT_TOOLS` only if cheap; else document the exclusion in read_before_edit.py's docstring.

## §3 Comment-tag sweep — comments describe the fix, not the plan tag

Goal: no source comment, docstring, or user-visible string carries "Part N / Wave X / Phase Y / T-number / § / OQ" plan tags. A reader of the code should understand each comment from the comment itself. Verified scope: ~330 files, ~940 genuine tag lines (95% of raw grep hits are genuine; the rest are ISO timestamps and EDA-domain words). Sources for what each tag meant: the plan docs in `docs/plans/` and git history.

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

## §6b Junk-file rule (standing)
When finishing a session, delete scratch files you created (scan outputs, generator scripts, unused drafts) before committing. The repo carries no `_*.py` / `_*.txt` scratch artifacts; genPhase8.py is the last such leftover. Keep this rule stated in this plan so future sessions see it.

The repo working tree at plan-write time holds one intentional uncommitted WIP: frontend/desktop/src/store/sessions/helpers.ts (dedupeSessions O(n)→O(1)) and one untracked WIP component ActionNeededCard.tsx — both are the user's, do not touch, do not fold into this plan's commits.

## §7 Validation gates
- Backend: `uv run ruff check . && uv run mypy app/ && uv run pytest -q --basetemp="$TEMP/august_pytest"` (~2,313 tests expected)
- Frontend: `npm run test:frontend` at repo root or `cd frontend/desktop && npm run test` (988/988) + `npm run typecheck` (tsc -b)
- §1: new byte-stability tests green
- §2: flipped auto-trust test + bulk + bridge + subagent cases green
- §3: `grep -rnE 'Part [0-9]+|Wave [A-Z]|Phase [A-Z0-9]|§|OQ [0-9]' backend-py/app frontend/desktop/src` returning only the do-not-touch list (§3.2 exclusions) — target zero genuine hits outside that list
- Coverage gate runs on full suite only; targeted runs fail it by design (not a blocker).

## §8 Naming rule (the reason there is no Part 28)
Standing rule from this plan onward: **new work riders under existing part numbers where the scope fits, and never mint "Part 28+" tags in code or commit messages.** Comments and identifiers describe what the code does and why, not which plan document created them. When a change doesn't fit an existing part's scope, it gets a plan doc under `docs/plans/<date>-<slug>.md` with a descriptive slug (like this one), and code references it by slug, never by number. The numbered series (Part 1–27) remains closed.

## §9 Open questions (researched recommendations, confirm or revert)
- OQ1: §2.1 auto-trust removal will make multi-edit sessions chattier (one extra read per edit). Recommendation: ship as ruled; the read is cheap and the refusal text teaches recovery. (Default: ship.)
- OQ2: §2.5 pptx_comment gating — recommendation: skip; document exclusion instead. (Default: skip.)
- OQ3: §3 test-filename renames — recommendation: leave filenames, rewrite inner prose only. (Default: leave.)
- OQ4: genPhase8.py — recommendation: delete. (Default: delete, already verified zero refs.)
- OQ5: The plan deliberately does NOT mint a new part number. If you later want a numbered continuation for the mega-function split or authz work, mint it as a new dated-slug plan doc and reference by slug.
