# Harness skill autonomy — status

Resumes Pass 1 of the four-pass plan. Read this before touching code.

## Done
- **Nothing committed yet.** Tip is `c332b526`. Pass 1 not started.
- Backup taken: `%LOCALAPPDATA%\Temp\august_brain.pre-signal-fix.<ts>.sqlite` (copy of
  `data/august_brain.sqlite`). No data mutated.

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

## Key discovery for item 1
`messages` has **no `is_error` column** (`memory_schema.py:82-98`). The structured flag exists at
the adapter layer (`ToolResultBlock(is_error=True)`: `anthropic.py:669,679,1019,1119`;
`resp.is_error`: `openai.py:221,561,634,1085`). **First task: confirm whether it survives into
`blocks_json` (migration 047) tool blocks.** If it does not, the receipt must be persisted there
before the miner can read it — that is the real scope of item 1, and it is larger than a swap.
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

## Next
Pass 1 item 1 — confirm `is_error` persistence in `blocks_json`, then replace the prose regex with
the structured receipt. Red test first: a transcript whose text contains `[Validation Error]` but
whose tool block is not an error must produce **no** episode.
