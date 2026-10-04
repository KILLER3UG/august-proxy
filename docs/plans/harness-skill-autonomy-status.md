# Harness skill autonomy — status

Resumes Pass 1 of the four-pass plan. Read this before touching code.

## Done
- **Item 1 — the structured tool-error receipt.** Mined failures now come from what the
  harness recorded, never from prose.
  - `tool_protocol.tool_result_failed()` is the ONE classifier: prefix-anchored on the
    receipt's own declaration, over `ERROR_RECEIPT_PREFIXES = ('Error', '[Validation Error]',
    '[Blocked]', '[Tool result missing]')`. All four literals verified as harness-written
    (`validator.py:128`, `kernel.py:642`, `subagent.py:1164,1224`, `tool_protocol.py:46`).
  - `normalize_tool_result` now makes `is_error` **total** (always a bool) — the ~15 gate
    sites needed no edits because they all pass through this one choke point.
  - `workbench.py`: `toolStatus` computed once from the shared rule and used by BOTH the SSE
    frame and the returned transcript message (previously duplicated inline at :5172).
  - `transcript_blocks.derive_blocks` / `structured_fields` map it onto the UI's existing
    `tool.status = 'error'`. **No migration** — `blocks_json` is a JSON blob and
    `types/chat.ts:119` already declares `'running' | 'done' | 'error'`;
    `ToolStepRow.tsx:130` already renders it.
  - `episode_miner`: `_TOOL_ERROR_RE` is **deleted**; `extract_episodes` selects
    `blocks_json` and reads receipts via `_errorReceipts()`. Legacy rows with no receipt
    mine nothing — by design, the prose fallback was the 41/41.
  - **USER-VISIBLE:** `[Blocked]` / `[Validation Error]` / `[Tool result missing]` tool cards
    now render red instead of neutral. Adjacent to `d73022be` B6 but NOT it — B6's four prose
    patterns stay unimplemented.
  - **Verified no provider leak:** every `role == 'tool'` translator rebuilds the message from
    scratch, so `is_error` never reaches an upstream body
    (`openai.py:511,704,826`; `anthropic.py:275,1268`). Checked, not assumed — AGENTS.md's
    0.12.21 null-forwarding bug is the precedent.
  - Tests: 21 new (`tests/test_tool_error_receipt.py`, incl. end-to-end through
    `save_workbench_session_sot`); 6 pre-existing tests rewritten to the receipt contract
    (`test_episode_miner.py` ×5, `test_tool_protocol_hardening.py` ×1) + 4 seeds in
    `test_part16_review_fixes.py`, each keeping its original purpose.
- Backup taken: `%LOCALAPPDATA%\Temp\august_brain.pre-signal-fix.<ts>.sqlite` (copy of
  `data/august_brain.sqlite`). **No data mutated yet** — the 41 bogus episodes are still in
  the dev DB for item 4 to quarantine.

## Item 2 finding (measured, ready to implement)
Dedupe identity is `episodes (session_id, start_message_id, kind)` (`_episodeExists:439`,
`save_episode:406`) and `start_message_id` is a **`messages.rowid`** — while
`save_workbench_session_sot` rewrites the transcript as DELETE-all + re-INSERT
(`memory_store/sessions.py:297`). So every durability barrier mints new ids, the same window
never matches, and each 24h pass re-inserts and re-increments `failure_fingerprints.episode_count`.
That is the "4 windows → 41 firings" mechanism, independent of the detector fix.
Fix without a new column: the episodes table already stores `events` (JSON with excerpts), so
a content-derived key over `(session_id, kind, first excerpt)` is stable across rewrites.

## Verified facts (re-measured by hand, not inherited from a subagent)
- `data/august_brain.sqlite`: **54** `turn_outcomes`, **41** `episodes`, **3** `failure_fingerprints`.
  **41/41 episodes carry `tool_error`; 0 carry a user correction.**
- Harness proposals are JSON files, not a DB table: dev store 2, installed store 1 —
  **all `kind='observation'`, 0 applied, 0 skill proposals ever.**
- Root cause of the false positives: `_TOOL_ERROR_RE` (`episode_miner.py:71-75`) matches the
  literal `[Validation Error]`, applied to assistant/tool text at `:173`. August's own
  `skills/august-harness/SKILL.md:30` contains that string — the skill that documents error
  receipts generates fake errors about itself. 41 firings come from **4** message windows
  re-mined 10–11× each, because dedupe keys on rotating message IDs (`:439-447`).
- Proposer is gated off regardless: `skillLearning` defaults `'extract-only'`
  (`brain_config_service.py:235`) → `apply_verdict` returns `skipped-extract-only`
  (`skill_distiller.py:580`) before reaching `skill_create|skill_patch` (`:667`).
- **UNVERIFIED:** "distiller judge 13 failures / 0 successes" — the lifecycle table's columns are
  not named as reported. Re-derive in Pass 1 item 7 with a real call.

## Key discovery for item 1 — CONFIRMED, `is_error` does NOT survive
`messages` has **no `is_error` column** (`memory_schema.py:82-98`). Read over the real dev DB:
268 messages yielded only two block kinds, `finalOutput` (49) and `toolCall` (252). A `toolCall`
block is exactly `{id, type, tool, content}` with `tool = {id, name, args, status}`, and `status`
is observed **only** as `"running"`. Only 126/252 carry `content` at all. `is_error` appears
nowhere in `workbench.py`; it exists only at the adapter layer
(`ToolResultBlock(is_error=True)`: `anthropic.py:669,679,1019,1119`; `resp.is_error`:
`openai.py:221,561,634,1085`). **So the receipt has to be persisted before the miner can read it —
item 1 is a write-path change plus a migration, not a regex swap.**
Write path located: `app/services/memory_store/transcript_blocks.py` (builder) and
`app/routers/sessions.py:218,247` (writer).
Do NOT add a second prose matcher. `d73022be` item B6 stays stale and unimplemented.

## Decisions already made (do not re-open)
- Skill evolution becomes autonomous **with a model reviewer**; human gate replaced.
- Reviewer must be a **different model** from the producer; same-model / unresolved / timeout /
  error / malformed all **fail closed to the inbox, never apply**.
- Reviewer default chosen: **`claude-sonnet-5`** on provider `opencode-zen-41527c` (different
  family from every producer in use — all cheap flash tiers — strictly more capable, already
  configured). **Must still be proven with a real resolve+call** before it ships. Remains a setting.
- Tool-failure-count: **dropped as a reviewer input** (41/41 FP, 0 downstream). Not narrowed, not
  a tiebreaker.
- Pass 3 burn-in: first 5 clean-verdict proposals go to the inbox with the verdict shown, then
  auto-apply; counter configurable, `0` disables burn-in.

## Reuse map (extend, do not add)
- Proposals: `harness_self_improve.save_proposal:293` → `data/harness_proposals/*.json` +
  `ledger.jsonl` (`_append_ledger:359`). Apply: `decide_proposal:419` → `_apply_approved:840` over
  `_APPROVERS:830`, documented as the ONLY proposal→change path. Reviewer never writes files.
- Undo: `skill_versions.read_version:117` returns exact previous bytes, `MAX_VERSIONS=20`, but
  **no restore endpoint exists** — `SkillVersionsPanel.tsx:11-17` says so. That route is new work.
- Rate limit: reuse `harness_outcome` (`record_proposal_outcome:173`, `applied_at`+`target`);
  per-day precedent `escalationBudgetPerDay` (`brain_config_service.py:242`, default 2).
- Probation: reuse `turn_outcomes.skill_lift:617` (absent key = no evidence, never 0.0) and
  `harness_outcome.measure_pending:208`. Provenance: `messages.source` + `MACHINE_SOURCES`.
- Kill switch: add to `brain_config_service.fieldTable:139` **and** `boolKeys:47`/`numKeys:69`,
  else `allowedKeys:101` rejects the PUT silently.
- Shared helper: `review_gate.resolve_independent_reviewer(producer_model, hint) -> (client|None, reason)`;
  `refine_store._review_refine_batch:905` must call it. **Import `make_review_llm_client` lazily at
  call time** — `test_refine_store_t15.py:551` monkeypatches it by path, and a module-level import
  would make those tests pass while testing nothing. Add a test that fails on module-import binding.

## Landmines
- `_apply_skill_write:589` rewrites frontmatter wholesale, reading back 7 fields (`version`,
  `supersedes`, `trigger`, `origin`, `learned_from`, `status`, `disabled`, `keywords`). A
  body-only patch that omits them **silently resurrects retired skills**. Pass 3 item 1 fixes this.
- `test_harness_revert_proposal.py:10,192` pins "the applier must never undo a learning write" →
  probation revert must be a version restore, not a revert proposal.
- `consolidation.py:752,903` currently files `skill_delete` from a model pass as approvable —
  must become human-only. Rewrite `test_skill_review_pass.py` rather than deleting it.
- `AGENTS.md:149`, `docs/ARCHITECTURE.md:412`, `docs/CONFIGURATION.md` duplicate numbers pinned by
  `npm run check:docs` — any changed constant must be updated there too.

## Working tree
Dirty with **another session's** in-flight work (`app-update-install.ts`, `useAppUpdate.ts`,
`UpdateSection.tsx`, `UpdateRelaunchOverlay.tsx`, `QuitConfirmModal.tsx`, `SettingsCard.tsx`,
`ui/card.tsx`, regenerated `openapi.json`/`openapi.ts`/`API_INDEX.md`, untracked
`useActiveSessions.ts`, `test_skill_trash.py`, `.ui-review/`). **Commit explicit paths only; never
`git add -A`.** My own uncommitted UI work is listed in `docs/ui-refactor/minimalism/` and
`docs/plans/2026-10-05-harness-pattern-gap-analysis.md`.

## Resume facts
- Worktree: `C:\Dev\august-harness-wt`, branch `harness-skill-autonomy`, from `70ee6744`.
  It is a SIBLING of `C:\Dev\august-proxy`, not nested inside it.
- Tests/lint/typecheck run from the worktree with the MAIN venv (the worktree has none):
  `cd /c/Dev/august-harness-wt/backend-py && PYTHONPATH=. /c/Dev/august-proxy/backend-py/.venv/Scripts/python.exe -m pytest <files> --no-cov -q`
  (`--no-cov` on a partial run, otherwise the 55% project gate fails spuriously and the real
  result is buried. Full suite: `-n auto`, ~14 min on this box.)
- Autonomous apply is **OFF** and stays off until the end-of-run review.

## Ordered backlog (the user's list, verbatim intent — do not renumber)
Pass 1, fix the signal
1. Confirm read-only whether `is_error` survives into `blocks_json`; if not, persist the
   receipt then point the miner at it. No new prose regex. `d73022be` B6 stays unimplemented.
2. Fix the re-mining inflation: dedupe on a stable window/content key; test that mining the
   same window twice does not increase `episode_count`.
3. Drop tool-failure-count as a reviewer input; keep only as plain telemetry if useful, say which.
4. Verify the correction detector with a seeded transcript containing a real user correction.
5. Quarantine, do not delete, the existing bogus episodes. Record counts before and after.
6. Tests: the skill docs' literal `[Validation Error]` yields no episodes; re-mining is
   idempotent; a real structured error does yield an episode.
7. Reproduce the distiller judge failure with a real call and report the cause.

Pass 2, reviewer and proposal path
8. `review_gate.py` with `resolve_independent_reviewer`; lazy-import the provider factory at
   call time, with a test that fails if it is bound at module import.
9. Reviewer default model: verify the exact ID resolves with a real call. Same model,
   unresolved, timeout, error or malformed output all fail closed to the inbox.
10. The reviewer never writes files; its only act is `decide_proposal`. `_APPROVERS` stays the
    only proposal→change path.
11. `skillLearning` moves from extract-only to a mode that files proposals into the inbox only.
    Rewrite (don't delete) the contracts this changes — `test_skill_review_pass`, and
    `consolidation.py` `skill_delete` becomes human-only — naming each in its commit.

Pass 3, autonomy machinery (all behind the OFF switch)
12. Frontmatter safety: merge the proposed body into existing frontmatter, never rewrite it
    wholesale from reviewer output. Tests for trigger, disabled, status, supersedes, origin,
    learned_from, version, keywords, and a disabled skill staying disabled.
13. Undo: the version-restore route + one Undo button; probation auto-revert uses version
    restore, not a revert proposal. Update the `SkillVersionsPanel` comment.
14. Rails: hard-limit categories always to inbox, daily rate limit + one change per skill per
    day, probation, kill switch in settings, readable history, burn-in counter (first 5 clean
    verdicts still go to inbox, configurable, 0 turns it off).
15. `SkillEvolvedChip` announces only applied changes, with Undo.

END OF RUN: full suite/typecheck/lint/build vs baseline; self-diff review commit by commit
(dead code, unused exports, uncalled new code, unnamed changed contracts); real-app
verification of proposal → reviewer verdict → inbox → chip → undo → probation revert,
screenshots in `.probe-artifacts/`, including an injection-style proposal blocked from auto-apply.

## Item log (item → commit → result)
- 1 → `2c8f6ac7` → receipt persisted end-to-end; prose regex deleted; 4722 passed / 9 skipped /
  0 failed. 21 new tests, 10 pre-existing rewritten.
- 2 → (this commit) → dedupe keyed on `(session, kind, events, outcome)`; the rewrite test went
  red at 3 rows for 1 window and now holds at 1; `episode_count` no longer inflates.

## Next
Item 3 — drop tool-failure-count as a reviewer input.
