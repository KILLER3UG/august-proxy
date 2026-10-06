# Harness skill autonomy — status

> **Handing over? Read `docs/plans/HANDOFF-2026-10-05.md` first** — it carries the
> worktree/command setup, what is done and NOT done, the two user decisions that
> block progress, and the traps. This file remains the full item log and the
> reasoning behind each call.

**State: the four-pass plan is FINISHED.** Pass 1 (items 1-7), Pass 2 (8-11), Pass 3 (12-15) and
both review rounds are merged into `master`. What is open is listed in `## Open, in order` below
and nowhere else.

**How to read this file.** Everything from `## Item log` down is append-only history: each entry
records what was true at the commit it names, including the errors the session made and the numbers
it first reported wrong. Do not correct history — add the correction. The sections ABOVE the item
log were written as planning text before the work landed; they are labelled as such now, and only
their current-state claims are maintained.

## Done — Pass 1 item 1, as planned for it

Written before that commit landed. The mechanism below is what shipped; the USER-VISIBLE bullet is
the claim `## Open, in order` still owes a real-browser check on.

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
- Backups taken: `data/backups/MANUAL-pre-052-20261004T184540Z.sqlite` (the one that matters —
  integrity ok, schema v51, 323 messages, 41 episodes) and
  `%LOCALAPPDATA%\Temp\august_brain.pre-quarantine-20261005-023651.sqlite`. The
  `pre-signal-fix.<ts>` copy first named here is gone; the quarantine run replaced it.
  **Still true, and still the user's boot to make false:** the 41 invented episodes remain in
  `data/august_brain.sqlite`, because migration 052 has not run on that store yet. It marks them
  `quarantined`, it does not delete them — 052's own header says the rows are the audit trail for
  how the loop escalated, and only the doors that ACT on an episode go blind to them.

## Item 2 finding (measured, ready to implement) — LANDED as predicted
The content-derived dedupe key this section asked for is what shipped:
`episode_miner.py:449-456` keys a window on its own content, and `start_message_id` is still
stored but read by nothing — provenance only, exactly the reasoning below.
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
Half of this conclusion was right and half was wrong, and the wrong half is worth keeping:
the diagnosis (no persisted error state to read) is what shipped against, but the predicted
"**plus a migration**" was not needed — `blocks_json` is a JSON blob and
`types/chat.ts` already declared `tool.status = 'error'`, so item 1 was a write-path change
only. The migration that did land in this window, 052, is the episode quarantine, not this.
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
Anchors here are **symbols, not line numbers**. I re-measured all eleven numbered ones against the
merged tree: **nine had drifted**, two had not (`read_version:117`, `boolKeys:47`). The worst was
`_apply_approved:840`, which now lives at `:1280` — a pointer that looked like proof and pointed at
nothing is worse than no pointer. Grep the name.

- Proposals: `harness_self_improve.save_proposal` → `data/harness_proposals/*.json` +
  `ledger.jsonl` (`_append_ledger`). Apply: `decide_proposal` → `_apply_approved` over
  `_APPROVERS`, documented as the ONLY proposal→change path. Reviewer never writes files.
- Undo: `skill_versions.read_version` returns exact previous bytes, `MAX_VERSIONS=20`. The
  restore route landed in Pass 3 item 13: `POST /api/skills/{name}/versions/{ts}/restore` →
  `skill_service.restoreVersion`, which is the only path from a version id to file content and is
  what item 14's probation auto-revert calls (not a revert proposal).
- Rate limit: reuse `harness_outcome.record_proposal_outcome` (`applied_at`+`target`);
  per-day precedent `escalationBudgetPerDay` (default 2).
- Probation: reuse `turn_outcomes.skill_lift` (absent key = no evidence, never 0.0) and
  `harness_outcome.measure_pending`. Provenance: `messages.source` + `MACHINE_SOURCES`.
- Kill switch: add the key to `brain_config_service.fieldTable` **and** the typed door it needs
  (`boolKeys` / `numKeys` / `strKeys`), else `allowedKeys` rejects the PUT silently. All six
  autonomy keys went through all four doors, and `test_brain_config._ALLCamelKeys` is what fails
  if one is missed again.
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
- 2 → `023aa374` → dedupe keyed on `(session, kind, events, outcome)`; the rewrite test went red
  at 3 rows for 1 window and now holds at 1; `episode_count` no longer inflates.
- 3 → **no code change; the input does not exist.** Grepped every reviewer path:
  - `episode_miner.score_episode:622-651` — the six rubric criteria contain no tool-error count.
    `recurrence:639` counts *episodes per fingerprint*, which items 1+2 keep honest and item 5
    must still recompute for the 41 rows already stored.
  - `skill_distiller._episodeWindow:240-251` + `build_judge_prompt:254` — the judge receives
    typed events, never a count.
  - The only count that does reach a reviewer is `episode_miner.guardrail_block_hotspots`,
    read by the refine pass (`refine_store.py:797,983`). Its source is `tool_guardrail_log`,
    written by the guard itself — not a regex — so it is accurate and **stays as telemetry**.
  So "0 downstream" was right, and the reason is stronger than expected: there is no wiring to
  remove. Item 5 must fix the stale counts this left behind.
- 4 → `819c3b9f` → **found a real bug.** A recall sweep of seven realistic phrasings, seeded
  through the real save path: `"Don’t rebuild, just restart the container."` mined nothing,
  because `_CORRECTION_RE` wrote `don\'?t` and phones/Word emit U+2019. Same hole in
  `_ABANDON_RE`'s `let's`. Both take one shared `_APOS` class now. My first fix broke
  `"That's wrong"` (the substitution ate the literal `s`) — caught by the sweep re-running.
  Also verified: a tail-patched user row still mines its own stripped sentence; a
  `harness_nudge` row is not mistaken for the human; a correction window survives a rewrite.
- 5 → `108ede9e` → migration **052** + `quarantine_unverified_tool_errors()`, run at the head of
  `mine_sessions`. Measured on an online-backup snapshot: 41 candidates → 41 marked, 41 rows
  still present, both `tool-error:*` fingerprints recounted 32→0 and 10→0 **and unflagged**
  (the distiller selects by `flagged = 1`, so clearing the count alone would keep proposing it),
  while `user-correction:harness-august-model` was left untouched at 1. Second sweep: 0
  candidates. Consumers filtered: `unscored_episodes`, `flagged_episodes`, `_sameCauseSessions`,
  `learning_report` (which now reports `quarantined` as history).
  **NOT applied to the live DB** — it was being written when I checked (WAL mtime seconds ahead,
  `schema_migrations` max 51, 41 episodes). Read back after my run: still 51 / 41 / no
  `quarantined` column, i.e. untouched. 052 lands at the app's next boot; the sweep at its
  first mining pass. If the user wants it now, they must close the app first.

## Item 6 is already satisfied — verify, do not re-implement
The three tests item 6 asks for all exist and pass:
- skill docs' literal `[Validation Error]` produces no episodes →
  `test_tool_error_receipt.py::TestMinerReadsOnlyTheReceipt::test_quoted_error_vocabulary_mines_nothing`
  (and `test_a_pre_receipt_row_is_not_reinvented_from_text`, and the E2E
  `test_a_quoted_error_document_reaches_storage_and_mines_nothing`)
- re-mining is idempotent → `test_part16_review_fixes.py::...test_a_transcript_rewrite_does_not_duplicate_the_window`
  and `test_episode_miner.py::TestQuarantine...::test_the_sweep_is_idempotent`
- a real structured error does produce an episode →
  `test_a_real_failure_mines_an_episode` / `test_a_failed_call_reaches_storage_and_mines_one_episode`
So item 6 = read these three, confirm they name the contract asked for, and only add what is
genuinely missing.

## Process deviations to report
- Item 5's sweep code was written before its tests (items 1-4 were red-first). The tests do
  cover it, but the order was wrong and I should say so rather than imply otherwise.
- Item 1 is **user-visible**: `[Blocked]` / `[Validation Error]` / `[Tool result missing]` tool
  cards now render red (`ToolStepRow.tsx:130` already handled `status: 'error'`). Not yet
  verified in the running app — deferred to the end-of-run real-app pass.
- Deviation cost me two bogus results: I ran a dry-run without `AUGUST_DATA_DIR` and read a
  freshly created empty DB ("0 episodes"); the live DB was never touched, but the lesson is to
  print the data dir in any script that reports counts.

## RUN RULES (effective 2026-10-05, user-set; read before doing anything)
- **Do not stop voluntarily.** Work the backlog in order until it is finished
  or a hard stop is reached (user data, security/permissions, turning on auto-apply, a product
  decision the user has not made). Nothing tells you context is running out unless it actually
  does — a session-timing counter is not that signal, and acting on one stopped this run twice
  mid-backlog. Every item is committed and logged here, so a platform cut-off loses nothing: the
  next session resumes from this file. Never stop on a guess.
- **Report the suite result from pytest itself** — never from a wrapper `echo`, never from a
  background-task completion notice. Capture the exit code immediately after pytest returns
  (`set -o pipefail` if piping to tee), and ALSO read the final summary line from the log, and
  **report both**. This rule exists because a completion notice said `exit code 0` over a run
  whose log said `FULL_EXIT=1`, and because `pytest … | tail; echo $?` reports the last stage.
- Run the full suite **only from a committed tip, with no edits to the tree while it runs**.
  Do read-only work in the meantime.
- Red test first, and show it failing, for every remaining item — most importantly the
  migration/sweep ones, where a wrong implementation is hard to undo.
- App checks against a **labeled seeded session in a test profile or a snapshot copy**, never
  the live store. Say so in the report.

## Decisions (supersede anything I reported as "your call")
1. **Red tool cards:** red ONLY for genuine tool failures — `is_error` receipts and validation
   errors. `[Blocked]` guardrail blocks and `[Tool result missing]` get a **muted, neutral**
   treatment from the existing styling vocabulary, **no new UI**. One render test per status
   class asserting the class or token, red first. Real-browser check via the repo's existing
   probe approach (vite + headless); time-boxed to a handful of attempts. If it can't be done,
   mark it "unverified in a real browser, covered by render tests" and move on.
   Implementation note: this means the loop's `toolStatus` and the mined `is_error` verdict
   must split — see "Order now" item 2.
2. **Correction detector: stop.** 0 real corrections in 54 human messages, all scripted. Do not
   add patterns for imagined phrasings. The signal is **unvalidated on real data** — say that,
   do not imply it has been proven to work.
3. **Autonomy stays OFF.** No auto-apply at any point.

## Definitive full suite (tip `61bbb06c`, no edits to the tree while it ran)
**4743 passed, 9 skipped, 0 failed in 11:14** — `PYTEST_EXIT=0`. Both numbers read from
`full4.log`: the exit code captured immediately after pytest with no pipe in front of it, and
pytest's own final summary line. They agree, which is the point of the rule.

## Decision — presentation split (user, 2026-10-05)
1. **The receipt stays honest.** `[Blocked]` and `[Tool result missing]` remain in
   `ERROR_RECEIPT_PREFIXES`, and durable `is_error` stays true for both — the call did not
   succeed, so the record says so. Do not narrow the list; do not change what the miner sees.
2. **Tone is chosen only where the status is rendered.** Map prefix → display tone in ONE small
   function next to the prefix list so the two cannot drift: genuine failures (an `is_error`
   receipt, a validation error) stay red; `[Blocked]` and `[Tool result missing]` render muted
   and neutral from the existing styling vocabulary. No new UI, no new column.
3. **Tests, red first:** one render test per status class asserting the class or token (never
   pixels); a test that FAILS if a prefix is added to `ERROR_RECEIPT_PREFIXES` without a tone-map
   entry, so a new marker cannot silently default to red; and a test that `is_error` is still
   true and persisted for both muted markers, which guards the mining behavior.
4. **Mining of denials is left unchanged, deliberately:** *guardrail denials are mined as
   failures; revisit with real usage data.* With zero real sessions this cannot be tuned, so do
   not tune it from guesses.
5. Order after this: red/muted split → provenance sweep for harness-authored `source = NULL`
   rows → item 7 → Pass 2 items 8–11.
2. Decision 1 — the red/muted split. `[Blocked]` and `[Tool result missing]` are currently
   folded into the same prefix list that produces `is_error`, which is wrong: quarantining and
   rendering need to stay receipt-driven, so the split belongs at the *presentation* layer
   (block `status` stays `error` for mining; the card picks muted styling for the two harness
   markers) rather than by narrowing `ERROR_RECEIPT_PREFIXES` and silently un-recording real
   harness failures from mining. Verify that reasoning against the code before implementing.
3. Provenance sweep: grep every place the backend writes a `source = NULL` message row that the
   harness authored; for each, confirm the miner's human-speech filter excludes it or fix it,
   red test per case. (`[interrupted]` is already done — the known remaining case.)
4. Item 7 — measure "13 failures / 0 successes" from a read-only snapshot with the correct
   lifecycle columns, reproduce with a real model call, report the cause. Fix only if clear and
   small; otherwise stop and ask.
5. Pass 2, items 8–11, as specified. Pass 3 (12–15) only if room remains.

## Live database (user decision 2026-10-05: leave it untouched)
- Migration 052 and the sweep land through the app's own boot, NOT by hand.
- Pre-boot backup already taken with SQLite's online backup API (the WAL is live):
  `C:\Dev\august-proxy\data\backups\MANUAL-pre-052-20261004T184540Z.sqlite`
  — 63,913,984 bytes, `PRAGMA integrity_check` = ok, 323 messages, 41 episodes, schema v51.
  Named `MANUAL-*` on purpose: `_prune` and `list_backups` glob `brain-*.sqlite`, so the
  app's rolling set will neither delete nor offer this file.
- **Restore (one line):** close the app completely, then copy that file over
  `C:\Dev\august-proxy\data\august_brain.sqlite` (and delete the sibling
  `august_brain.sqlite-wal` / `-shm` so SQLite does not replay onto a replaced main file).

## Item log — session 2
- 6 → **verified, nothing added.** The three contracts item 6 asks for already exist; all ran
  green by explicit node id (8 passed): the verbatim `[Validation Error]` skill text yields no
  episode (unit + pre-receipt row + end-to-end through the real save), re-mining is idempotent
  (transcript rewrite + sweep), and a real structured error does yield an episode.
- Migration 052 idempotency (user instruction 1): `test_migrations.py::
  test_052_quarantine_column_survives_being_applied_twice` — column exists exactly once after
  two runs, second run applies 0, version recorded once, fresh rows default to visible.
- Correction detector against the REAL corpus (user instruction 5), read-only from the backup:
  **56 user rows → 54 human, 2 machine, and 0 corrections / 0 rescues / 0 abandons detected.**
  The corpus is a dev/test corpus — mostly `hello`, `what can you do?`, and scripted probe
  prompts. So recall CANNOT be assessed from it, and that is the honest finding rather than a
  pass. Only **one** message contains any non-ASCII character and it is the harness notice
  below, so there is no non-English or mixed-language material to test either.
- **Real gap found by that sweep:** `[interrupted] …` (written verbatim by
  `workbench/sessions.py:223` when a turn never closed) arrives with `source = NULL` and was
  not in `_INJECTION_PREFIXES`, so harness instruction text entered the human-speech lane.
  Its current wording happens not to trip any pattern — no episode is being invented by it
  today — but it is the same class as the 41 false positives. Fixed by adding the prefix;
  red test asserts `_isMachineRow('', <verbatim notice>) is True`, plus a guard that a real
  correction beside the notice still fires. My first version of that test used an embellished
  notice text containing "start over"/"never mind" and produced a false episode — I replaced
  it with the shipped literal rather than ship a result caused by my own wording.
- Reported, deliberately NOT fixed (vocabulary, not the apostrophe class): `'i just want a
  schematic for simulation'` is a scope correction the detector does not match; `'revert all
  changes you made'` likewise. Changing `_CORRECTION_RE`'s wording is a redesign you asked me
  not to do.
- **Full-suite caveat:** `full3.log` is PROVISIONAL. I edited `episode_miner.py` and two test
  files mid-run, so it does not describe one clean tree. A definitive full run is still owed
  at the end-of-run review, from a committed tip.
- Red-first discipline held this session: the `[interrupted]` test and the 052 test were both
  run and shown failing (or newly asserting) before/with the change.

## Open, in order
1. **The real-browser check of red vs muted tool cards.** Everything else in this plan has a
   measurement behind it; this has 25 render tests that assert class names and no pixels. The
   design QUESTION this line used to leave open — "decide whether guardrail blocks deserve a
   quieter treatment" — is already answered in code: `types/chat.ts` carries
   `tone?: 'failure' | 'denial'`, `ToolStepRow` mutes a denial and reddens a failure, and a
   MISSING tone stays red on purpose. What is owed is the look, not the decision.
2. **A real reviewer call has never run.** Provider `opencode-zen-41527c` answers
   `Insufficient account funds`; `claude-sonnet-5` resolves and the gate hands back a client.
   Blocked on the user. The action after funding is
   `POST /api/curator/scheduler/run/reviewer`.
3. **Migration 052 has not run on the live store.** It lands at the app's next boot, and the
   quarantine sweep at its first mining pass. Pre-boot backup:
   `data/backups/MANUAL-pre-052-20261004T184540Z.sqlite`.
4. **Two test artifacts sit in the live `config.json`**
   (`auxiliary.cognitive.orchestrator.skill_learning_judge_model = 'judge-model-x'` and a stray
   top-level `_tier3_test_flag`). The exact unified diff was reported; applying it is the user's.

Items 2-4 of the previous version of this list — item 7's judge measurement, Pass 2, Pass 3, and
the tidy pass — are all closed, and this file's own Item log is where they were closed. The list had
simply not been re-read since. Autonomy still defaults **OFF**, and `autonomyKinds` still arms
`skill_patch` only.

## Item log — session 3
- **Correction to `da7cf07f`'s message:** it says 145 passed; the run reported **165 passed**
  (ruff clean, mypy clean on the three modules). The commit is not amended — a typo in history
  is cheaper than rewriting a branch. This is the record.
- Frontend half of the tone split → committed with this file. `ToolEntry.tone`,
  `MessageBlockToolCall.tone` and `AppendBlockEvent.tone` added; threaded from the SSE
  `toolResult` frame (`schemas/workbench.ts` → `streamEvents.ts` → `makeStreamHandlers.ts` →
  `append-block-event.ts`) and from persisted `tool.tone` in `blocks_json`.
  `ToolStepRow` now mutes a denial (icon drops `text-danger` and inherits the gutter's existing
  `--dt-muted-foreground`; the command pill uses the existing `border-border/60 bg-muted/25
  text-muted-foreground`) and keeps `failure` red. **No new colors, no new UI, no new CSS.**
- **Compatibility decision (yours):** a missing tone renders RED. Rows stored before this field,
  or a frame that omits it, are unknowns, and an unknown error must look like an error — the
  muted-by-default mistake hides a real failure. There is no backfill, and the frontend does NOT
  re-match the marker text: that would be a second list to keep in step with the first. Pinned by
  a test, not just intended.
- **The user-visible change from item 1 is now complete:** `[Blocked]` / `[Tool result missing]`
  render quiet, real failures stay red, and the receipt underneath is unchanged for mining.
- Frontend test/verification facts:
  - Render tests assert the class, never pixels: failure red, denial not red, missing tone red,
    and a settled row never tinted by tone alone. 25 passed in `ToolStepRow.test.tsx`;
    full frontend suite **195 files / 1517 tests passed**; `tsc --noEmit` clean.
  - **A worktree has no `node_modules`** (same class of gap as the missing venv). Vitest could
    not run until junctions were created:
    `C:\Devugust-harness-wt
ode_modules` → `C:\Devugust-proxy
ode_modules`, and the
    same pair under `frontend/desktop`. Created with PowerShell `New-Item -ItemType Junction`; `mklink` through Git Bash mangles the quoting and fails. Junctions are
    untracked and must be deleted before the worktree is removed.
  - Two red-test failures were MY harness, not the feature: I wrote `describe(..., () {` and
    `it(..., () {` without the `=>`, and I asserted the command pill without passing the
    `isCommand` prop. Both fixed before implementing, so the one remaining failure was genuinely
    the unimplemented case.

## Definitive full suite (tip `be62ba0c`, no edits to the tree during the run)
**4756 passed, 9 skipped, 0 failed in 9:31** — `PYTEST_EXIT=0`, `grep -c '^FAILED'` = 0, both
read from the log itself. Supersedes `full6.log` (1 failed / 4755 passed), whose failure was my
own `MACHINE_SOURCES` closed-world guard, fixed in `be62ba0c`.

## Item log — session 4
- Provenance sweep → committed with this file → two harness-authored user rows had no
  `source`: passive memory delivery (`automation_memory.py`) and the Live/BTW exchange
  (`routers/live.py`). Both tagged; `MACHINE_SOURCES` gained `memory_delivery` and
  `live_transcript`. A memory body routinely contains "actually" / "don't", i.e. the
  correction detector's own vocabulary, so a memory delivery could previously manufacture a
  correction episode about itself. The other `{'role':'user'}` writes build a throwaway prompt
  for one model call and never persist to `messages`, so the miner cannot see them — checked
  per file, not assumed.
- **Real-browser card check: NOT done. `unverified in a real browser, covered by render tests`.**
  It needs a live backend plus a labeled seeded session, which is the same setup the end-of-run
  real-app pass requires; doing it there is cheaper and produces the screenshot evidence you
  asked for. What IS verified: 25 render tests in `ToolStepRow.test.tsx` asserting the class,
  not pixels — failure red, denial not red, absent tone red, settled row never tinted by tone.
- Two of my own errors worth keeping in this file, because both would have hidden a bug:
  my mixed-session provenance guard initially asserted nothing (the "human" sentence I wrote
  never matched the detector, so the test passed while the feature was broken), and I launched
  a full suite before committing the sweep, contradicting the no-edits rule; I stopped it,
  committed, and re-ran.

## Next
Item 7 — measure the "13 failures / 0 successes" distiller-judge claim from a read-only
snapshot using the correct lifecycle columns, then reproduce with a real model call and report
the cause. Fix only if clear and small; otherwise stop and ask. Then Pass 2 items 8–11.

## Item 7 — measured from the read-only backup (UNVERIFIED claim now resolved)
`lifecycle` columns are `(id, session_id, event_type, detail, created_at)` — no
success/failure column, the distinction lives in `event_type`. 37 rows total:

    19  consolidation
    13  distiller_judge_failed
     4  lesson_promotion_skipped
     1  automation_memory_sweep

- **"13 failures" is REAL.** I had marked it UNVERIFIED because the column names did not match
  how it was reported; measured directly, `distiller_judge_failed` = 13, spanning 2026-09-10 to
  2026-10-04 — roughly one per curator pass, every one entering a 30-minute cooldown.
- **"0 successes" is a measurement artifact, not evidence.** No `event_type` for a successful
  judge exists anywhere in the table, so success was never countable. Whether the judge ever
  succeeded is still unknown from storage. Before reporting "0 successes" again, check whether
  `skill_distiller` writes a success row at all — if it does not, add one, because a loop that
  logs only failure cannot show it is working.
- **The cause is NOT recorded.** Every one of the 13 rows has detail shaped exactly
  `{"batchSize": N, "cooldownUntil": ...}` — no exception text, no status, no model. That is why
  this stayed "unexplained" for a month: the failure path swallows the reason into a log line
  and persists only the cooldown bookkeeping.
- Still owed: reproduce with a real model call (needs a live provider call, not a snapshot).
  Likely first fix once the cause is known: persist the reason in `detail`.

## Definitive full suite (tip `7e53bfc2`, no edits during the run)
**4759 passed, 9 skipped, 0 failed in 10:07** — `PYTEST_EXIT=0`, zero `FAILED` lines, read from
the log itself. Includes item 7's judge-failure work and the frontend tone split.

## Item 7 — CAUSE FOUND AND FIXED
Reproduced with a real call against an isolated profile built from
`MANUAL-pre-052-*.sqlite` + a copy of `providers.json` + `config.json` (never the live store).

Chain: stored `skillLearningJudgeModel` = `'judge-model-x'` → resolves to a provider with
`id=None` and empty `baseUrl` → the HTTP layer returns an **empty body and raises nothing** →
`_extractJson('')` throws `JSONDecodeError` → `call_judge` swallows it into a bare `None` →
`_cooldown_batch` records only `{batchSize, cooldownUntil}` and arms 30 minutes.

Fixed (the two small parts only):
- reason channel: `no-judge-model` / `no-provider` / `no-client` / `timeout` /
  `unparseable-response` / `request-failed`, persisted into the lifecycle detail with the
  exception text and the first 120 chars of the body;
- a config fault records `distiller_judge_unavailable` and does **not** arm a cooldown —
  cooling down something that needs a human to change a setting is what turned one
  misconfiguration into 13 indistinguishable "transient" rows;
- timeouts named in both loop shapes, including the off-loop worker that outlives its grace
  window while still holding a socket.

Verified by read-back, not by the code looking right: `_run_batch` on this install now yields
`('unparseable-response', "JSONDecodeError: Expecting value: line 1 column 1 (char 0) | body=''")`.
One caveat about that probe: `take_judge_failure()` clears on read, so calling it to print the
reason consumed it and the following lifecycle row showed `reason: unknown`. The single-consumer
design is fine; my probe ordering was the mistake, and it is worth knowing before anyone adds a
second reader.

## NEEDS YOUR DECISION (user data + test isolation, both hard stops)
1. Your **live** store holds `skillLearningJudgeModel = 'judge-model-x'`, and an `apiFormat`
   field also holds that same string. Nothing real answers to that name, so the distiller judge
   has never run on this install. Clearing/setting it is a mutation of your data — say the word
   and which model you want (the planned reviewer default is `claude-sonnet-5`).
2. Origin: `tests/test_distiller.py:342` writes it via `saveBrainConfig(...)`. A backend test
   reached a **real** brain config — an isolation leak. Fixing it means putting the
   `assertPytestDataDirIsolated` guard (already used by `episode_miner.save_episode`) on the
   brain-config write path. Small, but it may expose other leaking writers, so I stopped.
3. Whether to add a `distiller_judge_succeeded` event, so "0 successes" stops being
   unfalsifiable. Item 7 proved the loop can only ever report failure today.

## Item log — session 5 (Pass 2 + the small fixes)
- 2 (isolation leak) → `e0ef6fb8` → the guard that protects the user's stores only
  WARNINGED, and no JSON writer was guarded at all. Now: `assertPytestDataDirIsolated`
  RAISES for the checkout data dir, and the refusal sits in `write_json_atomic` — the one
  function every store write passes through (config/providers/automations/aliases/background
  review) — judging the TARGET path, not the env var. `data_2`-style siblings are not blocked.
  Self-inflicted trace recorded: my first guard consulted the env var, warned instead of
  raising, and my own test wrote a 20-byte providers.json into the worktree data dir. Removed.
- 3a (qualified hint) → `a74cae4e` → `provider/model` hints now split; a qualified provider
  must be a REAL store entry (resolve() fabricates one when nothing matches, by design for bare
  model names). Reached after three wrong guesses on my own test, each recorded.
- 3b (judge success) → `7cf222a9` → one `distiller_judge_succeeded` row per judged batch (not
  per verdict); `learning_report()['judge']` derives successes/failures/lastSuccess/
  lastFailure/details from those rows — one backend consumer, no frontend reference, so no
  visible UI. "0 successes" is now falsifiable.
- 8 (review_gate) → `77b15938` → one independence rule, two callers; lazy import guarded twice
  (source check + a by-path patch test). refine_store defers to it; its wording contracts hold.
- 9 (reviewer verified) → `d4ec5f4d` → **gate verified; the real reviewer call is blocked by an
  upstream funding error** (`{"error":{"type":"server_error","message":"Upstream request failed:
  Insufficient account funds"}}`) on provider `opencode-zen-41527c`. Same-model / unresolved /
  no-client all fail closed. `reviewLlm`'s four-into-one `''` swallow is fixed — each cause is
  now named. PENDING the user's action (fund or switch provider) to re-run the real call; add
  that to the end of the backlog.
- 10 (reviewer decides, never edits) → `6cf6dbae` → `review_proposal` maps KEEP/DISCARD to
  exactly one `decide_proposal` and nothing else; everything unusable fails closed to the inbox.
  `decide_proposal` now takes an `actor` so a reviewer decision is not logged as a human's.
- 11 (skillLearning 'propose') → `8df7c710` → new mode files skill verdicts into the inbox and
  stops (the branches already ended at `save_proposal`). Default switched because the live config
  does NOT set `skillLearning`. Auto-apply still off. Named contract rewritten:
  `test_recurrence_meter.py::test_report_blob`.
- 12 (frontmatter merge) → `75bf3587` → **no code changed; the merge was already correct.** The
  deliverable is 10 tests pinning each carried field and that a disabled skill stays disabled
  (proven to bite by breaking the carry and watching exactly those two fail).

## Live-config correction the user must apply (not done by me — hard stop)
The live store's brain config carries TWO test artifacts:
  - `auxiliary.cognitive.orchestrator.skill_learning_judge_model = 'judge-model-x'` (snake_case)
    → set to your reviewer model, or clear it so `resolve_judge_model` falls back.
  - `_tier3_test_flag` (stray top-level key) → safe to remove.
Set these in Settings, or tell me the model id and I'll put the exact edit in a report.

## Remaining backlog — closed, superseded
This is where items 13, 14 and 15 were marked "Not started" long after they shipped. They landed as
`eef0b3fd` (undo + restore route), `1553d369`/`29758a69` (the rails, then the rails round) and
`732e295e` (the chip). The one line here that was still true — re-run the reviewer once the provider
is funded — now lives as `## Open, in order` item 2. The heading stays so anyone reaching this
section from the handoff or from a search finds the answer instead of a hole.

## Definitive suites (tip `ecd56fa5`, no edits to the tree during either run)
- **backend: 4829 passed, 10 skipped, 0 failed in 10:01** — `PYTEST_EXIT=0`, zero FAILED/ERROR
  lines, read from the log itself.
- **frontend: 1517 passed across 195 files** (vitest).
- `npm run check:docs` passes (all 6 pinned claims). `check:api` FAILS, and the cause is now
  known: `c332b526` added `POST /api/skills/restore/{trashId}` (undo a *deleted* skill) and never
  regenerated `docs/api/openapi.json`, so the committed spec lacks one path. It is NOT a
  half-built version-restore route — item 13's route (`/api/skills/{name}/restore`) is a
  different path and does not collide with it. Regenerate once item 13's route lands, so one
  commit carries the route and its spec.

## Checks on the shipped work (2026-10-05, post-acceptance)

### 1. Isolation guard scope — SAFE, and now pinned
Verified by hand against a real launch: with `PYTEST_CURRENT_TEST` unset and
`AUGUST_DATA_DIR` unset, `dataDir()` resolves to the checkout `data/`,
`_refuse_live_store_write` does NOT raise, `assertPytestDataDirIsolated` is a
no-op, and both `saveConfig` and `write_json_atomic` write normally (proved
against a throwaway profile; the live store was never written).
Pinned by `TestTheGuardIsInertOutsidePytest` — including one test that asserts
the SAME call raises under pytest and passes without the marker, so the gate
cannot be "fixed" by loosening only the pytest check. August can save its own
data in a normal run.

### 2. 'propose' vs 'full' — what 'full' does that 'propose' does not
Exactly ONE thing, and it is not applying anything:
`harness_promote.py:132` — under `full`, memory **bodies** are included in the
promotion shortlist (a budget/cost rule for what the promotion pass reads);
under `propose` only file and title travel. That is the whole difference.
Neither mode applies a skill change: the create/amend branches end at
`save_proposal` → `return 'proposal-filed'`, and approval is a separate
`decide_proposal` step that a human (or, one day, the reviewer behind every hard
limit) performs. Verified by grepping EVERY `skillLearning` comparison in app/.
So the new default cannot auto-apply anything.

**The audit found a real defect I had introduced:** `consolidation.py:546` ran
the scheduled distiller only for `extract-only`/`full`, so the new default
(`propose`) silently stopped the scheduled pass entirely — a mode nobody ran.
Fixed, pinned by a test. Also fixed `curator.py:23`, whose fallback default still
said `extract-only` while the config default said `propose`.

## Item log — session 6
- **The branch landed.** `harness-skill-autonomy` is now `master` (`3d0763ad`); the worktree is
  the working copy for the rest of the backlog. **Everything committed after that point in this
  file — items 13, 14, 15 and the reviewer wiring — is on the branch only, not on `master`.** The main checkout keeps the *other* session's
  39 dirty files — no path overlap, verified again by diffing changed-path lists.
- **`check:api` drift resolved (item 13's "investigate first")** — see the correction in the
  definitive-suites section above. No half-built route exists; the committed spec is simply one
  path behind `c332b526`.
- **Reviewer pass now has a caller** → `learning_scheduler._reviewer_job`, registered as job
  `reviewer` with cadence key `reviewerIntervalHours` (default 6h, matching the introspection
  cadence that files what it reviews). Wiring was the whole gap: the pass had 20 tests and zero
  callers, which is the failure mode this file's own `test_learning_scheduler_wiring.py` exists
  to catch — and did not, because it only asserted the *two original* jobs.
  - New brain-config key done through all four doors the handoff warns about: `numKeys`,
    `fieldTable`, the interval validation branch, and `test_brain_config.py::_ALLCamelKeys`
    (a closed-world list, so the new key is a conscious addition, not a silent one).
  - The job imports `run_reviewer_pass` at call time, so patching the module attribute is the
    thing that runs — pinned, not assumed.
  - Cost is nil while no reviewer model resolves: the gate refuses before any HTTP call, so the
    pass writes a verdict line and returns.
- **A refusal is no longer a verdict.** `run_reviewer_pass` used to skip any proposal carrying a
  non-empty `review`, so the first scheduler tick on this install — where the configured reviewer
  is `judge-model-x` and the provider is unfunded — would have stamped every open proposal
  `unavailable` **permanently**, and fixing the config later would never re-review them. That is
  item 7's cooldown-on-a-config-fault mistake in new clothing, and it would have poisoned item
  14's rails, which read the verdict. Now an `unavailable` row is retried (free: no call was
  made); a `KEEP`/`DISCARD` row stays terminal, which the pre-existing
  `test_an_already_reviewed_proposal_is_not_reviewed_again` still pins.
- Tests: 4 written red first and shown failing (job registered / cadence tunable / job calls the
  pass / unavailable retried), then 51 green across the three files, plus 97 green across the
  harness+review cluster (`test_harness_self_improve`, `test_harness_wiring`, `test_review_gate`,
  `test_review_proposal_path`, `test_proposal_expiry`, `test_skill_learning_propose_mode`,
  `test_skill_review_pass`, `test_gate_participation`). ruff and mypy clean on the changed files.
  **A full backend suite from this tip is still owed** (it was already owed from `3300f28d`).
- **Reviewer line in the inbox** (handoff §5) → one muted `<p>` under the detail header's badge
  row in `HarnessImprovementsSection.tsx`, plus `review?: {verdict, reason, model, advisory}` on
  that file's `Proposal` type. No new section, no backend change — **verified**, not inherited:
  `routers/harness_proposals.py:26` returns `list_proposals()` rows whole, and
  `list_proposals:400` returns the parsed proposal file, so the `review` object already travels.
  - `reviewerLine()` mirrors `review_summary()`'s wording. That is two formatters, which this
    project normally refuses (the tone-split decision rejected a second marker list). Accepted
    here because the backend already persists the structured fields, and each side is pinned by
    its own test: `test_reviewer_pass.py` asserts `'Reviewer unavailable'` / `'Reviewer: discard'`
    prefixes there, `HarnessImprovementsSection.reviewer.test.tsx` asserts the same strings here.
    A rename on one side fails a test and names the other side in its comment.
  - Rendered in the detail view because that is where the human decides. 152 tests green across
    `src/sections/settings/__tests__/` (22 files); `tsc --noEmit` clean.
  - My own harness bug, recorded because it looked like a feature failure at first: all three
    tests reported an empty `<body />`, which was `openDetail()` querying before anything was
    rendered — not a component crash. Debugged by dumping the DOM in a scratch test rather than
    by guessing, then the scratch file was deleted. The same class bit once more in item 13's
    panel tests: `findByTestId('skill-version-diff')` resolves the instant the wrapper renders,
    while the diff query is still loading, so the assertions had to await the control itself.
- **Item 13 — undo lands.** One write path, from both ends:
  - `skill_service.restoreVersion(name, ts, workspace)` is the ONLY route from a version id to
    file content. Verbatim bytes, NOT `patchSkill` — that canonicalizes the body and re-renders
    frontmatter, and an undo that rewrites the bytes it restores is not an undo. It snapshots the
    content it replaces first, so every restore is itself undoable (which is what item 14's
    probation auto-revert needs) and the history keeps agreeing with the file.
  - **Refuses a bundled root.** The install tree is the payload an update replaces, so a write
    there is invisible to the next patch and unfixable by it. Pinned by a test that plants a
    `.versions` directory in a fake install tree and checks the bytes are untouched.
  - Route `POST /api/skills/{name}/versions/{ts}/restore` — 404 for an unknown skill or version
    (the vocabulary its two sibling GET routes already use), 400 for a refusal. Chosen over
    `/api/skills/{name}/restore` + body: no shape collision with the trash route at all, and the
    version id stays in the path where the digit guard already applies.
  - `test_harness_revert_proposal.py`'s rule is untouched: the applier still never undoes a
    learning write; a revert is a *user* action through this route, and item 14's probation will
    call the same service function directly rather than file a proposal.
  - Frontend: `restoreSkillVersion()` in `api-client/skills-versions.ts` (same all-digits gate)
    and ONE button in the diff pane, offered only when the diff is non-empty — restoring the
    version already in force is a write with nothing to say. The button label is a sentence, not
    the unixts it posts. On success both reads are invalidated, so the history shows the snapshot
    the restore took and the diff goes empty, which IS the confirmation; no toast was added.
  - Comments REWRITTEN, not appended, in three places that argued for read-only
    (`SkillVersionsPanel.tsx` header, `api-client/skills-versions.ts` header, and the old §101
    reuse-map line here): each now says why the write path exists and where it lives.
- **Generated artifacts back in step.** `check:api` was red at session start for the reason in
  the correction above; after item 13's route `npm run gen:openapi`, `gen:api-index` and `gen:api`
  were run and all three checks pass (`check:api`, `check:api-index`, `check:docs` — 6 claims).
  Spec diff: +95 lines, exactly the two missing paths, zero deletions. Client: +114, zero
  deletions. **`openapi.ts` is regenerated too** so the three derived files move together — there
  is no CI check on the typed client, so leaving it behind would have been silent drift.
- Item 13 checks: 6 backend tests red-first then green (36 in the file), 4 panel tests red-first
  then green (13 in the file, 156 across `settings/__tests__/`), `-k skill` across the backend
  **242 passed / 2 skipped**, `test_gate_participation` 27 passed, ruff + mypy clean on the
  changed modules, `tsc --noEmit` clean.

## Item 14 — what landed and what is still open
- **Rails core landed** (`app/services/harness_rails.py`, 25 tests in `test_harness_rails.py`):
  one entry point `auto_apply_allowed(row)` answering with `{allowed, rule, reason}`, and it sits
  ON the path — `review_proposal` asks before it decides, so a caller cannot read the answer and
  ignore it. Autonomy ships off, so every answer in the shipped config is `autonomy-off`.
  - **Allow-list, not deny-list**: only `skill_create` / `skill_patch` may auto-apply; `HARD_KINDS`
    is written out and a test proves it still equals `VALID_KINDS` minus those two, so a new kind
    is held by default and the derivation cannot rot.
  - Evidence must be the user's own words: cited episodes have to include a trusted kind
    (`user_correction` / `user_rescue` / `abandoned_approach`), **quarantined rows excluded** —
    item 5's 41 invented episodes still have ids, and one must not vouch for a write. A URL in
    the evidence is fetched content and is refused on its own, so the fetched-evidence hold fires
    even with a real citation behind it.
  - Content rails on the skill body: shell fence or shell prose, any URL, any credential
    vocabulary. Coarse on purpose — a false positive costs a human a glance, a false negative
    costs an unreviewed write to the agent's own instructions.
  - Rate rails read the proposal ledger (`action: 'auto_apply'`), which is the one existing
    store for "who did what, when": daily cap (`autoApplyPerDay`, default 2), one change per
    skill per day, and burn-in (`autonomyBurnInCount`, default 5, **0 disables**) holding the
    first N clean verdicts in the inbox beside their verdict.
  - `RULES` is a declared set and a test walks real refusals through it, because an unnamed rule
    is how a guard starts defaulting to allowing.
- **Three config keys, in every door the handoff warns about**: `boolKeys` / `numKeys`,
  `fieldTable`, the validation branch, and `test_brain_config._ALLCamelKeys`. Plus one door the
  handoff did NOT list: `saveBrainConfig` takes a **flat camelCase patch** — the nested
  `auxiliary.cognitive.orchestrator` shape is what it WRITES, not what it reads. A test helper
  that posts the nested shape "succeeds" and changes nothing; `_configure` now asserts `ok` and
  the arm is exercised through the real API door in every armed test.
- **Two contracts rewritten, not deleted** (`test_review_proposal_path.py`, item 10's file):
  `test_a_keep_verdict_approves_through_the_normal_path` → `..._when_the_rails_allow` plus a new
  `..._is_held_while_autonomy_is_off`; `test_approval_still_goes_through_the_deterministic_applier`
  now arms the switch. DISCARD still rejects with the switch off, and that asymmetry is pinned by
  its own test: the rails stop CHANGES, a refusal writes no file, and `reopen` is the undo.
- **A latent bug found while wiring the receipt**: `review_proposal` returned
  `ok=bool(result.get('ok'))` while `decide_proposal` answers with the proposal ROW, which has no
  `ok` key — so `ok` was False for every decision the reviewer ever made and nothing asserted it.
  Now derived from `status` (`applied` / `rejected`), with `applied` and `status` added to the
  receipt and a test naming the old mistake.
- **A test-isolation leak found by an in-suite failure that passed alone**: `getRuntimeConfig`
  memoizes for 2s and records no data dir, so a test that wrote `skillAutonomy=True` handed it to
  the next test's fresh directory — the kill switch read True in a test that never armed it, and
  that test APPLIED a proposal. `bustRuntimeCache()` now runs in conftest's
  `_reset_module_singletons` beside the model-cache bust, which is the same class of swap. This is
  the `judge-model-x` failure mode again, one layer up.
- Still open in item 14: **probation auto-revert** (uses item 13's `restoreVersion`, and needs
  `snapshot_before_write` to hand back the ts it wrote so the apply can name the version it took
  back) and the **readable history of auto-changes** (settings only; `auto_apply_history()` is
  already the only reader of those ledger rows).

## Item 14 — probation and the history (the rest of it)
- `snapshot_before_write` now RETURNS the id it wrote (`''` for a no-op or a swallowed failure).
  Without an addressable id, "restore the previous version" is a guess the moment anyone else has
  written the file. The applier carries it as `applyResult.snapshotTs`, and `record_auto_apply`
  stores it on the ledger row (`version_ts`) — so the record of an auto-change names the exact
  bytes it can put back.
- **`harness_rails.probation_revert(...)`** is called by `harness_outcome._file_revert_proposal`
  BEFORE it files, and returns `None` for everything that is not ours to undo, in which case the
  old behavior is unchanged. It restores only when ALL of: the outcome's source is a proposal of a
  skill kind; an `auto_apply` row exists for that proposal (a human's apply is a human's undo);
  autonomy is still on; a `version_ts` is on file; and **our snapshot is still the newest version**
  — if a human edited the skill afterwards, restoring would delete their work to undo our mistake,
  so the regression is left to the human with its proposal. The revert goes through
  `skill_service.restoreVersion`, item 13's single path, so it is itself recorded in the history.
- `test_harness_revert_proposal.py` is untouched and still green: that file pins the PROPOSAL
  APPLIER never undoing a learning write. Probation is the measurement job putting back bytes it
  took, through a different door, and the distinction is written into both docstrings.
- The kill switch stops this too, deliberately, even though refusing means a known regression
  stays in place: "off" has to mean the machine is not writing to my files, in either direction.
  The honest consequence is that the revert proposal is filed instead, so the human is handed the
  regression rather than the machine quietly fixing or ignoring it. Pinned by
  `test_the_kill_switch_hands_the_regression_to_the_human`.
- **History**: `GET /api/harness/proposals/auto-history` (registered BEFORE `/{pid}`, or the
  literal would be captured as a proposal id and 404) joins `auto_apply` rows to their
  `probation_revert` and returns `{autonomy, changes[]}`. The switch rides every response: a list
  of auto-changes without it reads as "this is what happens" when it is "what happened".
  Frontend: one `<details>` disclosure in the Review Inbox, rows labelled by skill + relative time
  (never the proposal id), `restored` on the reverted ones, and NOTHING rendered when the list is
  empty — the switch state already says it.
- Known limit, not fixed (inventing it would be a new feature): after a probation revert the same
  distiller verdict can re-file and re-apply tomorrow, because a reverted skill is not
  blacklisted. The per-day and per-skill rails bound the rate, not the repeat. Worth a decision
  with the user rather than a guessed blocklist.
- Checks: 8 new tests red-first (arity error on `record_auto_apply` was the honest red) then green,
  **131 passed** across probation/rails/revert-proposal/reviewer/pass/versions/outcome-P5,
  ruff clean on `app/` + the new tests, mypy clean on the four changed modules, 160 frontend tests
  in `settings/__tests__` (23 files), `tsc --noEmit` clean, and `check:api` / `check:api-index`
  green after regeneration (diffs additive: +39 spec, +60 client, 7 lines of index).
- Item 14 rails-core checks: 25 new tests red-first then green, 96 across
  rails/reviewer/proposal-path/brain-config/propose-mode, and a broad
  `-k "brain or harness or skill or review or distill or consolid or config or autonomy or learning"`
  slice **855 passed / 3 skipped / 0 failed** with `-n auto`. ruff + mypy clean.

## Definitive suites (tip `29758a69`, clean tree, no edits during either run)
The run the handoff owed since `3300f28d`. Both numbers are read from the logs themselves — the
runner's summary line AND the exit code captured immediately after the runner returned, with no
pipe in front of it.
- **backend: 4902 passed, 10 skipped, 0 failed in 13:06** — `PYTEST_EXIT=0`, `grep -c '^FAILED'`
  = 0. Up from 4829 at `ecd56fa5`: session 6 added 73 tests.
- **frontend: 1528 passed across 197 files** (vitest) — `VITEST_EXIT=0`. Up from 1517/195.
- `git status --porcelain | wc -l` was 0 at the tip before the run and after it, so the numbers
  describe one tree.

## Item 15 — SkillEvolvedChip
- **Placement was the user's call and they chose live event + history read** (asked, because the
  handoff specified the chip's content but never where it lives or how it learns).
- The implementation turned out to need NO new frontend channel: `emit_realtime('skill-evolved',
  …, queryKeys=['harness-auto-history'])` rides the bridge's already-existing forward-compatible
  default case, which invalidates any `queryKeys` it is handed. So the chip and the settings
  history read the SAME query key, and a live apply refreshes it. One store, one signal, no
  second mechanism.
- `src/realtime/bridge.test.ts` (new, the bridge had no test) pins exactly that hop — an event
  nobody invalidates would be a chip that only appears after a reload, and "the chip shows up
  live" would otherwise be a claim with nothing behind it.
- Backend emits from `review_proposal`'s applied branch next to `record_auto_apply`, so the event
  and the ledger row are written by the same success. A **human `decide_proposal` emits nothing and
  records nothing** — pinned by `test_a_human_approval_is_not_an_auto_change`, which is also what
  makes "a human-approved change does not get a chip" true by construction rather than by a
  frontend filter.
- Chip: one line above the composer (`ComposerDecisionStack`, beside `SubagentProposalBar`),
  skill name + Undo + details + dismiss. Never rendered while `autonomy` is false even when a
  change is on file — the required OFF test, seeded with a change. Rows name skills and relative
  times; the proposal id is never a label.
- **Narrowed the plan's "with Undo" in one case, deliberately:** an auto-CREATED skill has no
  previous version — `snapshot_before_write` returns '' for a create — so there is nothing to
  restore and the chip announces it WITHOUT an undo. Offering "delete it" would be a second write
  path invented in the UI, the exact mistake item 13's comment rewrite was about. Pinned by
  `test_announces_a_change_it_cannot_undo_without_pretending_it_can`. If the user wants a create
  to be undoable, that is a new backend operation (retire-or-delete with its own route), not a
  frontend choice.
- Dismissal is a localStorage watermark on the newest `at` (anything older is quiet), with local
  state as well so clicking dismiss actually hides the chip; storage failures fall back to showing
  it rather than throwing.
- Client: `getAutoApplyHistory()` + `AutoAppliedChange` moved into
  `api-client/skills-versions.ts` because two surfaces read them — the settings disclosure now
  uses the same function instead of a second inline copy of the shape.
- Checks: 2 backend tests (one red first) then 10 green in the probation file, 86 green across the
  harness cluster; 6 chip tests + 1 bridge test red-first then green; 169 across
  chat/settings/realtime (25 files); `tsc --noEmit` clean; ruff + mypy clean.

## One reviewer-line formatter (found by the self-diff review)
- The review asked "is any new code uncalled?" and the answer was yes: `review_summary()` had no
  production caller, because item 15-era inbox re-implemented its wording in TypeScript. Two
  formatters for one record is the pattern this project refuses (the tone-split decision rejected a
  second marker list for exactly this reason), so `routers/harness_proposals.py` now adds
  `reviewLine` from `review_summary()` on BOTH reads (list and single), and the inbox renders that
  field. The local `reviewerLine()` and the UI's `review?: {verdict, reason, model, advisory}`
  type are deleted, not left as an alternative surface.
- Asserting the exact sentence then exposed **two real defects**, neither of which any previous
  test could have caught because they only asserted substrings:
  1. `run_reviewer_pass` called bare `asyncio.run(...)`, which RAISES inside a running loop. The
     scheduled path is safe (`run_job_async` → `asyncio.to_thread`, no loop), but any in-loop
     caller — a route that awaited the job body without the thread hop — would have stamped EVERY
     open proposal `Reviewer unavailable: RuntimeError: asyncio.run() cannot be called from a
     running event loop`, and the record would look like a reviewer problem. Now handles both loop
     shapes the way `skill_distiller._run_batch` already does, including a named grace-window
     timeout instead of silence.
  2. The verdict parser stripped `' -–:.'` — an EN dash — while models answer `KEEP — reason` with
     an EM dash, so the reason kept its leading dash and the inbox line read
     `Reviewer: keep — — reason`. Fixed with `_VERDICT_PUNCT` spelling both as escapes. **This is
     item 4's bug class a second time**: the punctuation a model or a phone emits is not the
     punctuation a source file happens to contain, and a substring assertion cannot see it.
- Timeout reason wording changed from "did not answer within 60s" to name `timeout`, because
  `test_a_timeout_is_unavailable` pins that the reason contains 'time' — an existing contract the
  refactor briefly broke, caught by running the file rather than by trusting the new code.
- Checks: 3 backend tests red-first then green (79 across reviewer/rails/probability/proposal-path
  after the loop fix), 161 frontend in `settings/__tests__` (23 files), `tsc --noEmit` clean, ruff
  clean on `app/` + tests, `check:api` and `check:docs` green (the response shape is untyped in the
  spec, so no regeneration churn for a derived key).

## Real-app verification (end-of-run item, done 2026-10-06)
Run against **a labeled test profile** — `C:\Dev\august-verify-profile`, created for this and
deleted afterwards — with the real backend (`uvicorn app.main:app`, port 8091, real migrations
including 052) serving the real `web-dist` bundle, driven by headless chromium (playwright).
**Your live store was never the target**: `C:\Dev\august-proxy\data` has no `verify-restore` skill
and no `prop_verify*` file, and your own app on :8085 was not touched.
- `POST /api/skills` → `PATCH` → `GET /versions` → `POST /versions/{ts}/restore` over HTTP: the
  restore is **byte-exact** (`sha256[:12]` `b6d2996cdc1b` round-tripped), the restore itself lands
  in the history (`restored verify-restore to version …`), and an unknown version is a real 404.
- `GET /api/harness/proposals` and `/api/harness/proposals/{pid}` both carry `reviewLine`, formed
  server-side, and agree with each other. The rendered inbox line reads
  `Reviewer: keep — the gap is real and durable` with **exactly one** em dash — the doubled-dash
  bug was measured in the running app, not only in a unit test.
- `PUT /api/brain/config` accepts `skillAutonomy` / `autoApplyPerDay` / `autonomyBurnInCount` and
  they read back — the closed-world key door is open for all three.
- `POST /api/curator/scheduler/run/reviewer` with autonomy ON and no reviewer model: ledger row
  written, detail `{reviewed: 1, unavailable: 1, applied: 0, held: 0}`, the proposal stamped with
  the real cause `no reviewer model available` (NOT the asyncio RuntimeError the old code produced),
  and nothing applied.
- **Chip in the running app**: renders `August updated verify-restore by itself · Undo · details`
  (skill name as the label, no id). Clicking Undo posted the restore and **changed the file on
  disk**, then the chip dismissed itself.
- **Version panel in the running app**: the undo is offered only on a snapshot that differs from
  what is live (`Undo — restore this version`), clicking it changed the file, and afterwards the
  control disappeared and the `No differences — this snapshot is exactly what the current file
  says` message appeared. The withheld-when-live rule works against a real file.
- Screenshots: `.probe-artifacts/01…12` (untracked scratch evidence, not committed).
- **Two environment findings worth keeping**:
  1. The first-run **setup modal covers the composer**, so the chip is not clickable until it is
     dismissed. A fresh install with autonomy armed will show the chip behind that modal.
  2. `AUGUST_CORS_ORIGINS` is **comma**-separated (`_cors_extra_origins` splits on `,`), and a
     browser POST from an origin the guard does not trust is a 403 `untrusted origin` — including
     same-origin `http://127.0.0.1:8091` for a backend started without it. My first browser run
     "failed to undo" for exactly this reason; the chip correctly surfaced the named error rather
     than pretending, which is the behavior the error path was built for.

## A UI promise my own work made false (found by looking at the screenshot)
The inbox header said "Nothing applies until you approve it" unconditionally. With item 14 that is
only true while the switch is off, so the page misdescribed when its own machinery writes. The
sentence now tracks `autonomy` (read through the same deduped `harness-auto-history` query):
on → "the rails apply qualifying skill changes on their own, and every one of them is listed below
and undoable"; off → the original promise. Two tests red-first, and both wait for the switch read
because the first paint is the off-state sentence. Verified in the running app: the header reads
the on-state sentence against a live `autonomy: true` config.

## User review round (2026-10-06, items 3–7 requested explicitly)
- **(3) Ambiguous / unparseable verdicts.** No production change was needed and that is stated
  rather than dressed up as a fix: the parser already fails closed. What was missing is a test that
  proves it **with the rails armed** — every pre-existing fail-closed test ran with autonomy off, so
  none of them could tell a refusal apart from a switch that was never going to write anyway. Nine
  tests now: seven garbled replies through the real pass (`applied == 0`, status open, verdict
  `unavailable`, reason named), the parser's own KEEP/DISCARD-vs-tie boundary asserted directly, and
  a direct `review_proposal(pid, 'KEEP DISCARD')` call. The last one pins the ordering that matters:
  an unusable answer is refused **before** the rails are consulted, so a garbled string can never
  reach `decide_proposal` even if the proposal is otherwise clean.
- **(6) Shadow mode.** `skillAutonomyShadow` (bool, default False) — the reviewer decides, the run
  records `wouldApply`, nothing is written. Two ordering rules make it meaningful, both tested:
  the rails are consulted FIRST (a shadow that reported "would apply" for a fetched-content
  proposal would be lying about a write it is not allowed to make), and `skillAutonomy` remains the
  master (shadow on + autonomy off rehearses nothing). A shadow run writes no ledger row, so it
  cannot spend the daily budget it is rehearsing against. `rule: 'shadow-mode'` is in `RULES`, and
  the pass counts `wouldApply` separately from `applied` and `held`.
- Config door: `skillAutonomyShadow` added to `boolKeys`, `fieldTable` and
  `test_brain_config._ALLCamelKeys` in the same commit, which is what makes the closed-world list
  earn its keep.
- Checks: 9 + 6 tests red-first (the shadow ones failed on the config door, which is the honest
  red), then 124 green across rails/reviewer/proposal-path/probation/brain-config/propose-mode;
  ruff clean.

## (5) Cooldown after a probation revert
A revert that only puts the bytes back leaves the same finding free to re-apply the next morning,
so the rails now hold it. Keyed on the **finding**, not the skill: `finding_key(row)` is
`sha256(skill + fingerprint)[:16]`, falling back to the normalized problem text when the distiller
supplied no fingerprint. The fingerprint is preferred because it is stable across re-filings while
the evidence prose shifts with the episode window — and the test asserts exactly that precedence.
- `record_auto_apply` gained a `findingKey` argument (passed by `review_proposal`), and
  `probation_revert` copies it onto the revert row, so the ban is written by the same path that
  performed the undo.
- New rule `probation-cooldown`, checked **after** the content rails and **before** burn-in and the
  rate rails, so the reason a human reads is the real one.
- `PROBATION_COOLDOWN_DAYS = 30`, deliberately longer than the 14-day measurement window: the
  measurement that condemned the change took that long to arrive, and a shorter cooldown would
  expire about when the evidence did.
- An empty key matches nothing, on purpose: rows written before this field existed must not read as
  "every finding is barred".
- 7 tests: held after a revert, different finding on the same skill passes, same finding on another
  skill passes, the window expires, an unkeyed row blocks nothing, the key is stable across reloads
  and prefers the fingerprint, and one end-to-end through `measure_pending` (the revert row carries
  a key, and the re-filed finding is held by `probation-cooldown`).

## (7) What an auto-applied change can actually touch
- **The two allow-listed kinds are `skill_create` and `skill_patch`.** Every other kind in
  `VALID_KINDS` — `brain_config`, `skill_delete`, `retire`, `promote`, `revert`, `observation`,
  `tool_bucket`, `tool_description`, `flow_map` — is refused with `rule: 'hard-kind'`, and a test
  sweeps the vocabulary rather than a hand-written list, so a new kind cannot enter silently.
- **Measured, not asserted.** `tests/test_harness_rails_containment.py` fingerprints every
  `.py`/`.json`/`.md` under `app/` (size + sha256), performs a real auto-apply through the reviewer
  path, and requires the diff to be empty. Backend source, the rails module, `brain_config_service`
  (the allow-list and every setting), `skill_service`, `tool_registry` and the whole `sandbox/`
  policy tree are named explicitly so a refactor cannot move them out of the glob and leave the
  test measuring nothing.
- **The instrument is proved to bite** (`TestTheInstrumentItself`): it writes one file under `app/`
  and asserts the scan reports exactly that path. A green tree-scan that cannot see a write is the
  failure mode this whole file keeps hitting.
- **A payload cannot smuggle a config change.** A `skill_create` carrying `patch`, `brain_config`
  and a nested `auxiliary` block applies only its SKILL.md; `maxAgentDepth` and `enabled` are
  unchanged afterwards. The applier dispatches on kind, never on payload keys.
- **Names cannot escape**: `../evil`, `a/b`, `..\evil`, `/etc/passwd`, `.hidden`, empty and
  over-length all raise `SkillValidationError`.
- **One real side effect found and gated.** `_apply_skill_write` honours `payload.supersedes` by
  calling `setEnabled(other, False)` — disabling a SECOND skill inside the same write. Both writes
  are inside the skills root, so the tree scan would not have flagged it; it is now its own rule,
  `supersedes-another-skill`, because a change that quietly retires another skill is not one the
  machine should make unwatched. `''` (the applier's "nothing superseded") still passes.

## (4) An auto-created skill now has an undo: the soft disable
The earlier decision — announce a create with no button, because there is no version to restore —
is superseded by the user's instruction: undo a create by **disabling** it through the existing
enable/disable path, never by deleting.
- `record_auto_apply` gained `apply_action` (`'created'` / `'patched'`, straight from the applier's
  own receipt), and `auto_apply_history()` exposes it as `created`. The history has to say which
  kind of change it was or the UI cannot offer the right undo.
- `disableSkill(name)` in `api-client/skills-versions.ts` is `PATCH /api/skills/{name}
  {disabled: true}` — the identical call the Skills page toggle makes. No new write path is
  invented; the existing one is named. A delete would have taken the user's file with it.
- The chip branches: a patch restores its version, a create disables the skill, and the button says
  which ("Undo — restore the earlier version" / "Undo — disable the skill"). Tests assert the
  negative too — `restoreSkillVersion` and `api.delete` are both *not* called for a create.
- Backend tests pin the distinction end-to-end through the real reviewer path: a create's history
  row is `created: true` with an empty `versionTs` (there genuinely is nothing to restore), a patch
  is `created: false` with a version the applier's own snapshot took.

## Real-app re-check of the two chip branches (2026-10-06, after item 4)
Same method as before: the backend serving `web-dist` on :8092 against a labeled test profile
(`C:\Dev\august-verify-profile2`, deleted afterwards — the live store again shows no
`*-undo-demo` skill), headless chromium, real clicks, files inspected on disk afterwards.
- **Create branch.** Chip read `August updated created-undo-demo by itself | Undo — disable the
  skill`. After the click: the file **still exists**, its frontmatter gained `disabled: true`, the
  body text is preserved, and the chip is gone. No 4xx/5xx. So the undo is the soft disable, not a
  delete — the property the user asked for, measured rather than asserted.
- **Patch branch (regression, because the mutation code was rewritten).** Chip read
  `Undo — restore the earlier version`; the file went from the v2 body back to the v1 body, the
  chip dismissed itself, no error responses.
- `GET /api/harness/proposals/auto-history` returned `created: true` for the create row and
  `created: false` with a real `versionTs` for the patch row, over HTTP — the field the UI branches
  on is produced by the server, not inferred in the browser.
- Screenshots: `.probe-artifacts/13…15`.

## Definitive suites (tip `85e10438`, clean tree, nothing edited during the runs)
- **backend: 4940 passed, 10 skipped, 0 failed in 9:53** — `PYTEST_EXIT=0`, `grep -c '^FAILED'`
  = 0. Measured at `2df1d601`; `git diff 2df1d601..HEAD -- backend-py` is empty, so the number
  still describes this tip. Up from 4907 before the review round (+33 tests).
- **frontend: 1538 passed across 199 files** — `VITEST_EXIT=0`, re-run at `85e10438` after the
  `act()` fix. Count unchanged because item 4 replaced one chip test with one.
- **Every repo gate green**: `check:api`, `check:api-index`, `check:docs` (6 claims),
  `check:doc-links` (123 files), `check:version`.
- The only remaining stderr in the frontend run is `src/api/workbench/stream.test.ts`, a
  pre-existing SSE-parser suite this workstream never touched. The chip tests are silent now.
- **Live config**: the two test artifacts are gone from `C:\Dev\august-proxy\data\config.json`
  (backup `config.json.pre-artifact-cleanup-20261005T201148Z`), verified by re-reading the file.
  `skill_learning_judge_model` and top-level `_tier3_test_flag` removed; the `rollbackLog` entry
  that merely *mentions* the flag was left alone — it is history, not a setting. The earlier claim
  that an `apiFormat` field also held `judge-model-x` did not survive a scan: only the one field did.

## (3) Autonomy is now armed per kind
`autonomyKinds` (str, default `'skill_patch'`) selects which kinds the switch automates, **inside**
the code's ceiling. `AUTO_APPLIABLE_KINDS` stays the maximum: `armed_kinds()` intersects the config
value with it, so no setting can widen what may be automated. A create — inventing an instruction
that never existed — stays on review until the user asks for it.
- New rule `kind-not-armed`, checked right after `hard-kind` (the cheaper, more fundamental reason
  first).
- **The config door validates rather than filters.** A value naming `skill_delete` is refused at
  `PUT` (an escalation attempt), and so is a typo like `skill_pach` — silently intersecting away an
  unknown name would arm nothing and read as "autonomy is broken" rather than "your value was
  wrong". `''` is valid and arms nothing, which is the way to keep the switch on and automate
  nothing.
- Contracts rewritten, not deleted, because the default changed what "armed" means:
  `test_the_kill_switch_is_the_only_thing_holding_it` now arms both ceiling kinds so the switch is
  again the single variable it claims to test; and the `_arm()`/`_armAutonomy()` helpers in
  `test_harness_rails_containment.py`, `test_harness_probation.py` and
  `test_review_proposal_path.py` arm both explicitly — those files test what a change can touch,
  not which kinds are automatable, and eight of their tests were failing for the unrelated reason.
  Each says so in a comment.
- 8 new tests: default arms only patch, create held with `kind-not-armed`, patch passes, explicit
  arming works, ceiling cannot be widened, unknown kind refused, empty value valid, and a held
  create emits no `skill-evolved` event and spends no budget.

## (1) Shadow decisions get their own log, and a readout
- **A separate store, not the proposal ledger.** Burn-in, the daily cap and the per-skill rule all
  read `ledger.jsonl`; a rehearsal recorded there would be counted as a change that happened and
  would spend the budget it was rehearsing against. So: `<proposals>/shadow_decisions.jsonl`,
  capped at 200 entries on write (a 6-hour cadence with no prune is an unbounded file).
- Each entry: `at, proposalId, kind, skill, verdict, wouldApply, heldBy, reason, rails[]` where
  `rails[]` is `{rule, passed}` for **every** rail.
- **`rail_trace(row)` is now the single implementation** and `auto_apply_allowed` is derived from it
  (first failing rail). That was the design point, not a convenience: two orderings — the one that
  decides and the one that logs — is exactly the drift this project keeps having to fix. The trace
  evaluates every rail even after one fails, because a trace that stops at the first refusal
  answers the question the decision already answered. All rails are reads.
  - Pinned by `test_the_decision_and_the_trace_cannot_disagree` (four shapes, decision vs trace) and
    `test_the_trace_covers_every_rail` (every name in `RULES` except the two non-rails is
    evaluated, so a new rail cannot be declared and never run).
- Written from `review_proposal`'s approve branch, once per KEEP, **before** the shadow answer —
  so a shadow run that the rails held is logged too, with `heldBy` naming the rail. A DISCARD is
  not logged: nothing was rehearsed, and recording it would fill the file with non-decisions.
- **Readout**: the auto-history endpoint gained `shadow: [...]`, kept as a separate array from
  `changes` precisely so a would-have-applied cannot be read as an apply. The panel's disclosure now
  counts them apart ("1 change applied by itself · 2 shadow decisions · autonomy is on") and each
  row says `would have applied` or `held by <rail-name>` — the rail's own name, not a paraphrase,
  because which rail held it is the whole reason to read the list. Renders nothing when both lists
  are empty.
- 10 new tests (7 rails + 1 endpoint + 3 panel), 170 green across the harness cluster, 173 across
  chat/settings/realtime, ruff + mypy clean, `check:api` and `check:docs` green (the response is an
  untyped dict, so no spec churn).

## Definitive suites (tip `656df7be`, clean tree, nothing edited during the runs)
- **backend: 4958 passed, 10 skipped, 0 failed in 10:38** — `PYTEST_EXIT=0`, `grep -c '^FAILED'`
  = 0. Up from 4940 before this round (+18 tests).
- **frontend: 1541 passed across 199 files** — `VITEST_EXIT=0`. Up from 1538 (+3 panel tests).
- **`npm run build:web` green** (`BUILD_EXIT=0`).
- **All five gates green**: `check:api`, `check:api-index`, `check:docs`, `check:doc-links`,
  `check:version`.
- Dead-code pass over this round's symbols: `rail_trace`, `record_shadow_decision`,
  `shadow_decisions`, `_append_shadow`, `armed_kinds`, `disableSkill`, `ShadowDecision`,
  `kind-not-armed` — every one has a caller outside its own definition and its own tests.

## Session 8 — the merge, and what "all five gates" did not cover
- **Merged.** `harness-skill-autonomy` → `master` with `--no-ff` in a clean worktree (the main
  checkout carries another session's ~39 uncommitted files), pushed as a fast-forward to
  `origin/master` at `9a686bec`. The three generated artifacts (`docs/api/openapi.json`,
  `docs/API_INDEX.md`, `src/api/gen/openapi.ts`) were **regenerated from the merged tree**, not
  hand-merged, and proved to have zero content drift. `.gitignore` was the only hand-resolved
  conflict, keeping both sides' rules.
- **The CRLF class, separately committed** (`0980f3f1`, `.gitattributes` `eol=lf` for those three
  generated files): `check:api-index` fails in a fresh Windows worktree while passing on Linux,
  because `core.autocrlf=true` rewrites the generated LF files at checkout. Same blob hash
  (`f1b11faa`), zero diff after stripping CR — so it was never a content problem. Verified green in
  a second fresh worktree after the rule.
- **Item 15 left a collision, now fixed** (`7231a756`): `sections/chat/SkillEvolvedChip.tsx` and a
  pre-existing `components/chat/SkillEvolvedChip.tsx` shared a component name AND
  `data-testid="skill-evolved-chip"`. With autonomy on, both are in the document at once — proven
  red first (`getAllByTestId` returned 2). They are different news: the transcript chip reports a
  SKILL.md THIS turn wrote (no backend event exists for a tool-path write), the composer chip
  reports what the six-hour job did on its own with no turn to point at. The first is now
  `SkillReceiptChip`.
- **The gate this workstream did not run.** Every session here reported "all five gates" —
  `check:api`, `check:api-index`, `check:docs`, `check:doc-links`, `check:version`. `check:design`
  is a **sixth** gate and CI runs it (`.github/workflows/type-check.yml:172`). Item 15's chip added
  three raw `<button>`s, which the ratchet counts as new drift, so `check:design` has been red on
  master since `732e295e` landed and no report in this file said so. The buttons are on the `Button`
  primitive now and the gate is green. Lesson: a gate list copied between sessions needs to be
  re-derived from the workflow file, not inherited.
- **`Type check` is red on `master` and it is not the harness.** Last green run was 2026-10-01;
  the merge commit failed in ~2 minutes because both jobs fail before their test steps:
  - Backend — mypy on Ubuntu reports `Module has no attribute 'WinDLL'` at
    `app/services/computer_use_policy.py:151-152`. `ctypes.WinDLL` is behind a `sys.platform`
    guard in typeshed, so it typechecks on this Windows machine and not on the runner. **pytest
    never runs at all** on that job.
  - Frontend — 4 `@typescript-eslint/no-unnecessary-type-assertion` **errors** (the warning budget
    of 600 is not what fails it): `src/components/shell/__tests__/RightDrawer.test.tsx:453`,
    `src/hooks/useResizablePane.ts:141`,
    `src/sections/settings/__tests__/TurnLimitsSection.test.tsx:36` and `:42`.
  Neither set is harness code. AGENTS.md says to confirm `Type check` is green before pushing a
  tag, so this blocks the next release until it is fixed — and it is a third party to the
  autonomy work, not a consequence of it.
- Frontend suite from tip `7231a756`, clean tree, nothing edited during the run: **1542 passed
  across 199 files** (`VITEST_EXIT=0`), +1 over the previous tip for the collision test.
  `check:design` green, `tsc -b` green, eslint clean on all five touched files.
- One flake worth recording rather than repeating: `ChatMarkdown.perf.test.tsx` asserted a 2x
  wall-clock ratio and measured **1.99** in one full-suite run, then passed twice on the same tree.
  Its own duration in those runs was 6.8s and 13.8s. A perf assertion with a threshold that close
  to the measured value is load-sensitive by construction — the same class as the `-n auto`
  failures in this project's history. Not touched here; it needs the mechanism fixed, not the
  number lowered.
