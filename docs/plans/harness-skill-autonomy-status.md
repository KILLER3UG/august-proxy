# Harness skill autonomy — status

> **Handing over? Read `docs/plans/HANDOFF-2026-10-05.md` first** — it carries the
> worktree/command setup, what is done and NOT done, the two user decisions that
> block progress, and the traps. This file remains the full item log and the
> reasoning behind each call.

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
  ^ STALE — superseded by the item 5 entry in the Item log and by
  `data/backups/MANUAL-pre-052-20261004T184540Z.sqlite` (see "Live database" below).

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
- Undo: `skill_versions.read_version:117` returns exact previous bytes, `MAX_VERSIONS=20`. The
  restore route landed in Pass 3 item 13: `POST /api/skills/{name}/versions/{ts}/restore` →
  `skill_service.restoreVersion`, which is the only path from a version id to file content and is
  what item 14's probation auto-revert must call (not a revert proposal).
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
1. **Item 2 of your follow-ups is NOT done: the real-app check of the red tool cards.** I
   cannot launch the packaged desktop app from here and the in-app browser reports
   `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`. So item 1's `[Blocked]` / `[Tool result missing]`
   red rendering remains **UNVERIFIED**. If you can run it, that is the thing to look at: one
   genuine tool error, one guardrail block, one missing-result card. Decide there whether
   guardrail blocks deserve a quieter treatment than a real failure — my code currently makes
   all four prefixes equally red.
2. Item 7 — reproduce the distiller judge failure with a real call; measure "13 failures /
   0 successes" from the snapshot using the correct lifecycle columns (still UNVERIFIED).
3. Pass 2 (items 8-11), then Pass 3 (12-15) if room remains. Autonomy stays **OFF**.
4. Tidy pass: the top "## Done" and "## Key discovery for item 1" sections now describe
   pre-commit state and are marked stale — worth folding into the Item log when convenient.

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

## Remaining backlog
- 13 (undo): the version-restore route + one Undo button; probation auto-revert uses version
  restore, not a revert proposal; update the `SkillVersionsPanel` comment. Not started.
- 14 (rails): hard-limit categories to inbox, daily rate limit + one change per skill per day,
  probation, kill switch, readable history, burn-in counter. Not started.
- 15 (SkillEvolvedChip announces only applied changes, with Undo). Not started.
- Re-run the real reviewer call once the provider funding is fixed (item 9).

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
  the working copy for the rest of the backlog. The main checkout keeps the *other* session's
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
