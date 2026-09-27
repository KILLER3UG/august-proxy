# Verified-audit implementation batch (2026-09-26)

Implementation record for the externally audited roadmap whose claims were
verified claim-by-claim before any code was written. Scope agreed: **P0 #1–6
and P1 #8–12 shipped**; **P1 #7 (contract/codegen) and P1 #11 (workbench
split) are deferred to §5** with full specs; **P2 #13–18 are deferred** (§6).

Everything here is on `master` in one commit. Numbers in this document that
duplicate a code constant are guarded by `npm run check:docs`; the design
baseline is guarded by `npm run check:design`.

---

## 1. What shipped

### P0#1 — rem type scale (frontend)

The codemod retired **926** `text-[Npx]` literals across **174** files onto the
rem scale: 9px/10px → `text-3xs`, 11px → `text-2xs`, and everything else to an
exact rem equivalent. No `lineHeight` companions were touched, so the swap is
render-neutral apart from the intended scaling fix.

- `tailwind.config.cjs` — added the `fontSize` tokens `3xs` (0.625rem) and
  `2xs` (0.6875rem).
- `styles.css` — px font sizes moved to rem; the intentional 16px root base is
  the only px left.
- `eslint.config.js` — `no-restricted-syntax` bans
  `Literal[value=/text-\[\d+(\.\d+)?px\]/]`.
- `scripts/check-design.mjs` — the `px-type` rule, as the second net.

**Correction found while building the gate (see §4.1):** the codemod and the
eslint ban were both integer-only, so **113 fractional** values (`10.5px`,
`12.5px`, `11.5px`, `13.5px`, `9.5px`, `8.5px` across 43 files) survived both.
They are now converted to exact rem (`10.5px` → `text-[0.65625rem]`, matching
the codemod's existing convention) and the ban covers fractions.

### P0#2 — design-drift gate

`scripts/check-design.mjs` + `scripts/design-baseline.json` +
`npm run check:design`, wired as a step in the `frontend-tsc-eslint` job of
`.github/workflows/type-check.yml`. Mechanism copied from `check-naming.mjs`:
sorted baseline entries, `--update`, fail only on entries **not** in the
baseline. `--list` dumps `rule / path:line / match` for triage.

Five rules over `frontend/desktop/src/**/*.{ts,tsx}`: `px-type` (0),
`hex-color` (345), `raw-button` (527), `raw-fetch` (2), `inline-style` (116) —
**496 baselined entries, zero px**.

### P0#3 — error families join the ledger

- `app/services/error_families.py` — the 8-family vocabulary
  (`timeout | rate_limit | auth | permission | not_found | network |
  invalid_argument | process_exit`), the rules, the steering advice,
  `classify_family`, `family_for_class`.
- `workbench.py` re-exports `_ERROR_FAMILY_RULES` / `_ERROR_FAMILY_ADVICE` /
  `_error_family` so the existing call sites and tests keep their import path.
- `turn_outcomes.py` gained the `process_exit` class and re-exports
  `family_for_class`.
- `tests/test_error_families.py`.

### P0#4 — named best-effort

- `app/services/best_effort.py` — `best_effort(site)` context manager plus
  `AUGUST_STRICT_BEST_EFFORT=1` to re-raise. `CancelledError` is deliberately
  not caught, so a cancelled turn can never be swallowed into "best effort".
- `BLE001` added to ruff's select set with a **194-path per-file-ignores
  ratchet** spliced into `[tool.ruff.lint.per-file-ignores]` in `pyproject.toml`
  (`tests/**` and `scripts/**` blanket-ignored, plus 192 app modules). New blind
  excepts now fail lint; the existing ones migrate one file at a time.
- `tests/test_best_effort.py`.

### P0#5 — one API client

- `src/api/client.ts` — `api.get(path, init?)` with signal passthrough, and
  `api.postRaw` for `FormData`.
- **27** stray `fetch(` sites converted across **18** files, behaviour
  preserved.
- `src/lib/query-keys.ts` — the `qk` factory, migrated into
  `useReviewInboxCount` / `HarnessImprovementsSection` / `LearningPanel` with
  shape-identical keys.
- The two bootstrap `/api/health` probes (`useChatSend.ts`,
  `offline-queue-store.ts`) deliberately stay raw — they must work before the
  client is initialized — and carry comments saying so. They are the only two
  entries in the `raw-fetch` baseline.

### P0#6 — recovery + truncation honesty

- `_emitRecovery(emit, kind, attempt, outcome, degraded)` in `workbench.py`,
  one frame per self-correction rescue, wired at five sites: length
  continuation (`retrying` / `exhausted`), context reduction
  (`reduced` / `failed`), auto-compact (`compacted`), plus the budget ladder
  (`degraded` ×2 / `stopped`).
- Frontend: `WorkbenchRecoveryEventSchema` added and registered in the
  discriminated union (`api/schemas/workbench.ts`); a truncated-answer note
  renders when `turnEnd.reason === 'length'`
  (`data-testid="truncated-answer-note"`).

`degraded: true` is the trust signal: the turn looks complete but was truncated
or rescued into a reduced surface.

### P1#8 — skill and fact credit

- Migration `050_turn_skill_credit.sql`.
- `record_turn_outcome` gained `skills_injected` / `skills_loaded` /
  `facts_injected` / `error_families` via `_nullable_json_list`: **None → NULL,
  `[]` → `'[]'`**. The distinction is load-bearing — see §4.2.
- `skill_service` turn-scoped load collector (`begin_turn_skill_collection` /
  `drain_turn_loaded_skills`, appended in `record_skill_use`).
- `workbench` pre-binds `_skillsInjectedNames` from `_skillsDetail.keys()`,
  accumulates `turnErrorFamilies` at the per-round steering scan, and passes
  `skillsInjected=` / `errorFamilies=` to `_tc.turnTelemetry`;
  `turn_close` drains `skills_loaded` and derives `facts_injected` from
  `injectedFacts`.
- `GET /api/brain/skills/suggestions` (`routers/brain_config.py`) — read-time
  `json_each` aggregation, the `routing_evidence` pattern. Documented in
  `API_REFERENCE.md`.

### P1#9 — a measured regression files its own revert

- `harness_outcome.measure_pending` now calls `_file_revert_proposal` when a
  row classifies as `regressed`, inside `best_effort('learning.revert-proposal')`
  — the first real adoption of the P0#4 helper.
- The proposal carries **the source change's own rollback text** (read back off
  the originating proposal file, or the refine entry's by-id undo), plus a
  `payload` link (`outcomeId`, `outcomeKey`) and the before/after numbers as
  evidence.
- `revert` is registered in `harness_self_improve.REVERT_KINDS` and is
  **human-only**: `_apply_approved` falls through to its "human-only" branch, so
  the machine files the undo but never performs it. That is the same authority
  boundary the rest of the module already keeps.
- Frontend `HarnessImprovementsSection.tsx`: `kind === 'revert'` rows are
  **pinned above the recency order** (a row carrying evidence of harm outranks a
  newer speculative one) and tagged `measured regression`
  (`data-testid="measured-regression-tag"`). The Approve button is already
  disabled for non-approvable kinds, and its tooltip now says the rollback is
  yours to run.
- `tests/test_harness_revert_proposal.py` (10 tests) — regressed files exactly
  one linked proposal; flat / improved / insufficient file none; measurement is
  idempotent; a pruned source still files with honest text; the applier refuses.

### P1#10 — message provenance

- Migration `049_message_source.sql`; `app/services/message_sources.py` — the
  vocabulary, `AUGUST_MESSAGE_ONLY_KEYS`, `strip_august_message_keys`.
- `workbench` tags the 5 `[Proxy Self-Heal]` sites `source =
  SOURCE_HARNESS_NUDGE`; the queued composite is `SOURCE_QUEUED_USER`; a
  tail-patched message carries `_tailFrom`.
- `save_workbench_session_sot` writes the `source` column (probed, with a
  pre-049 fallback) and **trims tail-patched content at the `_tailFrom`
  boundary** — the long-standing TODO in `workbench.py`.
- Both upstream dumps strip per-message August keys.
- `episode_miner._isMachineRow` is now source-first, with the old prefix list
  kept only as the pre-049 NULL-source fallback.
- `tests/test_message_source.py`.

### P1#12 — turn budget ladder

Three soft per-turn ceilings, **each 0 = off**, so an untouched install never
walks the ladder: `budgetSoftUsd`, `budgetSoftTokens`, `budgetWallClockSec`
(`type_aliases.py` + `brain_config_service.py` fieldTable + defaults).

Checked once per round. Each fresh breach spends exactly one rung and reports
it:

| Rung | Action | Recovery frame |
|------|--------|----------------|
| 1 `surface` | narrow to the bare tool set (reuses the existing `surfaceDowngraded` mechanism and its prompt rebuild) | `degraded: true` |
| 2 `compaction` | the same prune→summarize→persist pass the pre-turn auto-compact runs | `degraded: true` |
| 3 `final` | one tool-free round (no tools advertised, `<turn_budget>` directive appended) | `stopped: true` |

Then `turn_end {reason: 'budget'}`. Cost comes from
`cost_estimator.price_for_model` via `session_cost_usd` — the one pricing
source, so the budget arm cannot disagree with the Usage page — and the clock
arm is `time.monotonic()`, not `time.time()`.

- `turn_outcomes.TURN_END_REASONS` gained `'budget'`; the AGENTS.md reason list
  was updated in the same change (`check:docs` guards it).
- `lib/turn-end.ts` phrase map gained `budget: 'budget reached'`; the existing
  amber badge renders any non-`finished` reason.
- `tests/test_turn_budget_ladder.py` (17 tests) — the arm matrix (a 0 arm is
  off, not met; one armed arm fires without the others), the escalation
  sequence and its clamp, the config defaults, the pricing delegation, and
  three loop-level tests: an armed turn walks all three rungs and ends as
  `budget`; an unarmed one keeps its full surface and ends on the cancel; a
  within-budget turn is untouched.

---

## 2. Where to look

| Item | Anchors |
|------|---------|
| Error families | `app/services/error_families.py`, `workbench.py` (`_error_family`), `tests/test_error_families.py` |
| best_effort | `app/services/best_effort.py`, `pyproject.toml` (`[tool.ruff.lint.per-file-ignores]`), `tests/test_best_effort.py` |
| Recovery frames | `workbench.py` (`_emitRecovery`), `src/api/schemas/workbench.ts` |
| API client | `src/api/client.ts`, `src/lib/query-keys.ts` |
| Skill credit | `app/migrations/050_turn_skill_credit.sql`, `app/routers/brain_config.py`, `tests/test_turn_skill_credit.py` |
| Revert proposals | `app/services/harness_outcome.py`, `app/services/harness_self_improve.py`, `src/sections/settings/HarnessImprovementsSection.tsx`, `tests/test_harness_revert_proposal.py` |
| Message source | `app/migrations/049_message_source.sql`, `app/services/message_sources.py`, `app/services/memory_store/sessions.py`, `tests/test_message_source.py` |
| Budget ladder | `workbench.py` (`_turnBudget`, `_budgetBreached`, `_nextBudgetStep`, `_budgetTriggeredCompaction`, the round-loop block), `tests/test_turn_budget_ladder.py` |
| Design gate | `scripts/check-design.mjs`, `scripts/design-baseline.json`, `.github/workflows/type-check.yml` |

---

## 3. Deliberate deviations

1. **No `skill_evidence` table.** The skill ledger aggregates read-time from
   `turn_outcomes.skills_injected` with `json_each`, exactly like
   `routing_evidence`. A second table would need a writer kept in sync with the
   turn loop for no query the read-time form cannot answer. Rationale is in the
   migration header.
2. **The machine-prefix list survives as a fallback.** `episode_miner` is
   source-first, but a row written before migration 049 has `source IS NULL`, and
   those rows are still filtered by the prefix list. Deleting it would let
   pre-049 self-heal rows into the miner.
3. **No `lineHeight` in the new type tokens.** `3xs` / `2xs` set font-size
   only, so the codemod could not silently change line spacing. 0.625rem and
   0.6875rem are the measured 10px and 11px at the default 16px root.
4. **Design-gate baseline identity omits the line number** (the spec proposed
   `relpath:line:match`). Line numbers churn on any edit above a baselined
   violation, which would fail PRs that never touched it. Identity is
   `path:match`; the failure output still prints `path:line` because that is
   what you need to fix it.
5. **`raw-fetch` requires `fetch(` with no space.** The spec's looser pattern
   also matched prose in a doc comment ("the iframe to fetch (the backend
   base…)"), which would have put a non-violation in the baseline.

---

## 4. Two things the verification changed

### 4.1 The px codemod and its eslint ban were both integer-only

Both the codemod and the `no-restricted-syntax` selector matched `\d+px`, so
**113 fractional** font sizes (`10.5px`, `12.5px`, … in 43 files) passed both —
and the audit's "all px retired" claim was true only of the integers. Building
the `px-type` rule is what surfaced it, which is the argument for the gate. The
fractions are now on the rem scale and the ban covers them.

### 4.2 The suggestions test was seeding its own denominator away

`test_skill_suggestions_endpoint` seeded its two "turns without the skill" rows
through the legacy no-args path, which writes NULL. The endpoint's `total` CTE
deliberately counts only rows where `skills_injected IS NOT NULL` — a pre-050 row
is *unrecorded*, not *measured-empty*, and must not be scored as a turn where
the skill was absent. So `turnsWithout` came back 0.

**The code was right and the test was wrong.** The fix marks those two turns
`skills_injected=[]` (measured-empty, which is what they are) and adds a
separate assertion that a NULL-only row is excluded from `turnsWithout` — which
is the honesty rule worth pinning in the first place.

---

## 5. Deferred with full specs

### P1#7 — response contracts and client codegen (1–3 weeks)

The backend has **409 endpoints and 1 `response_model`**. Every frontend type
is a hand-written mirror of a Python shape, so a renamed field is a silent
runtime `undefined` on both sides of the wire, and the two drift apart on
purpose over time.

1. Add pydantic `response_model` to routers, starting with the surfaces the UI
   reads most (`/api/harness/*`, `/api/brain/*`, `/api/skills`).
2. Commit the generated `openapi.json`. It is a build artifact with a
   generator pinned in `pyproject.toml`, not a hand-edited file.
3. `openapi-typescript` → a zod client, replacing the hand mirrors in
   `src/api/schemas/`. The zod parse at the boundary is what makes a
   contract change a **type error** instead of an `undefined` at runtime.
4. Parse the SSE stream with the same schemas in dev, so a malformed frame is
   named instead of silently dropping a field.

The risk to manage is the blast radius in step 1: adding a response model to an
endpoint that already returns a hand-shaped dict is where a serialization
difference would surface, so migrate one router at a time and let the zod parse
in step 3 find the mismatches.

### P1#11 — split `workbench.py` (1–3 weeks)

`workbench.py` is **7,684 lines** (as of this batch — the budget ladder and
the recovery frames landed here too) and holds the prompt builders, the round
loop, the tool stage, the guards, the recovery paths and the event emission.
The in-file idiom to follow is already there: `_MEMORY_NUDGE_MIN_ROUNDS` is
re-exported from its own module purely so the old import path keeps working.

Target layout: `services/workbench/loop/{runtime,guards,recovery,surface,exec,prompt,events}.py`,
each with a re-export shim in `workbench.py` so no call site and no test moves in
the same change. The constraint is the loop's shared mutable state —
`currentMessages`, `tools`, `surfaceDowngraded`, the turn-scoped counters — which
is why this is measured in weeks and not moved in one sitting: the split is
mechanical only if the state is passed explicitly, and doing that *is* the work.

---

## 6. P2 deferral rationale

#13–18 were not started. Each is a real improvement, but none blocks a
correctness or honesty gap the way P0 did, and #14 additionally touches the
Settings IA, which is under a standing blocked ruling. Sequencing them behind
P1#7 and P1#11 is also the right order: a contract layer and a smaller
`workbench.py` make the rest cheaper to land, not dearer.

For the record, one audit item did not exist as described: **P0#6's
`lengthContinuationMissing` flag was never implemented.** The recovery work was
built on the rescue paths that were verified to exist — length continuation,
reactive context reduction and auto-compact — rather than on a flag that would
have had nothing to read.
