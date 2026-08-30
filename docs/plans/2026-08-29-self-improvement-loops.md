# Part 16 — Self-Improvement Loops

**Status:** IMPLEMENTED 2026-08-30 — Step-0 + Phases A–E landed (see §11 for
the per-phase changelog); OQ 1–6 follow the recommended defaults
(confirm-or-revert). THIRD REVIEW OF THE IMPLEMENTATION 2026-08-30 (§12):
11 findings F-1…F-11 from executable probes against live data; the §12 fix
batch (all 11) LANDED 2026-08-30 test-first — see §12.1. Original plan review (§9): every
citation re-verified against the working tree (all hold; two line-number
drifts noted; the frontmatter quote bug confirmed LIVE by execution);
implementation is gated behind the Part 17 §9 fix batch. Reconstructed into the repo on 2026-08-29 from the drafted design record, then re-grounded against a same-day full scan of the memory/skills stack (live smoke test 2026-08-29). SECOND review 2026-08-30: every file:line re-verified against the working tree — citations corrected, Step 0 trimmed (search memory-section CUT; guidance/refine-store/curator-bar demoted), migration retargeted 027 → **028**, and the two failure→memory lanes (`turn_outcomes` vs episode fingerprints) explicitly separated. Implementation status after the 2026-08-30 Part 17 landing: `skillLearning` (off | extract-only | full, default extract-only) and the promotion judge/queue are ALIVE via Part 17 Phase E (brain_config_service.py:65, :121, :218); the episode engine itself is NOT — no `episode_miner.py`, no `episodes`/`failure_fingerprints` tables, migration 028 unused. Phases A–C below must extend the landed queue/config, not duplicate it.
**Series:** Part 15 = tool-step rendering + memory cleanup (2026-08-28). This is Part 16. Sibling plan: *Project-Scoped Memory & Skills* (`2026-08-29-project-scoped-memory.md`) — that plan is the substrate (where per-project memories/skills live); this plan is the engine (how they improve). Neither blocks the other for Phases A–D; Part 17's Phase E distillation calls this plan's Phase C engine when both are adopted.

---

## 1. Goal

August should get measurably better at the user's actual recurring work without anyone hand-writing rules. The loop:

```
extract episodes from stored transcripts → score on a fixed rubric, fingerprint failures →
escalate the top slice to an LLM judge → human-approved skill / distilled memory →
measure whether the recurring failure actually stopped → draft revision-or-retire
```

Two-tier on purpose: **tier 1 is deterministic and free** (heuristics over telemetry already being recorded); only the small flagged slice pays for a model call. Design center: *the model's lived experience (turn outcomes, retries, self-corrections) becomes durable skill and memory, gated by recurrence evidence and human approval for skills.* Nothing here withholds, delays, or degrades an answer; the entire loop is asynchronous and post-hoc — the judge never runs inside a live turn or inside a sub-agent.

**Already shipped (in-loop sibling, keep distinct):** the memory-habit nudge (2026-08-29, `queue_memory_habit_nudge` / `memory_nudge_block` in workbench.py + the upgraded `<memory_policy>`) teaches the *main model itself* to consolidate single-episode lessons via `remember` right after substantial turns. That habit covers what one session can see; Phase A's mining exists for what it cannot — cross-session recurrence patterns, abandoned-approach windows, and skill-worthy workflows. No overlap: the nudge writes via the existing door, mining proposes via the judge.

**Two failure→memory lanes, kept separate (2026-08-30 second review):** the shipped `turn_outcomes` promotion lane is the **provider/error grain** — signature `provider/model:error_class`, fact key `harness-lesson:<sig>` (`maybe_promote_failure_lesson` :229-311) — and it already has a cheap-model YES/NO gate (`_review_lesson` :191-226, discard-default). Phase B fingerprints are the **workflow/tool grain** (`missing-binary:ngspice`). The lanes deliberately do NOT share a fact-key prefix and must not be merged: the same lesson under two grains = two duplicate facts with different keys. The `_review_lesson` gate is NOT this plan's judge — the judge is post-hoc, batched, and reads episode windows, not single candidate strings.

## 2. What already exists (build on, don't duplicate)

| Piece | State (verified 2026-08-29) | Role in this plan |
|---|---|---|
| `harness_self_improve.py` — proposal queue, human approval, deterministic applier (`_apply_approved` :421-510, `skill_create/patch/delete` :441-508), scheduled introspection (:518-590; boots and files real proposals — confirmed live) | ALIVE | **Is** the review queue + applier for drafts (Phase D). No new approval machinery. |
| `turn_outcomes.py` — one telemetry row per turn (error_class/duration/task_type), failure-lesson promotion ≥3 same-signature failures in 7d → BM25 dedupe >0.55 → one `harness-lesson:<sig>` fact (`maybe_promote_failure_lesson` :229-311, plus a `_review_lesson` cheap-model YES/NO gate :191-226) | ALIVE | Tier-1 raw material + the fingerprint discipline Phase B generalizes. Its promotion lane is kept as-is. |
| `consolidation.py` — BM25 near-duplicate merge ≥0.85, contradiction supersede, expiry sweep (:91-235) | ALIVE | All distilled memories route through `save_fact`, so dedupe/supersede/expiry apply for free. |
| `skill_service.py` — learned-skill roots (`data/skills/` — **empty; nothing has ever written a learned skill**), canonical body normalizer :532-577, enabled-filtered catalogue :359-361 | ALIVE | Where approved skills land; canonical template (Title / When to Use / How to Run / Pitfalls / Verification) enforced at write time. |
| Workbench loop telemetry — retry/self-heal receipts, malformed-tool-JSON validation errors, non-advancing `update_state` reflection nudges, routing evidence | ALIVE | Episode events are read from what these already record. No new chat-loop instrumentation. |
| Cheap-model call idiom — `title_generator.py:147-169` reuses the turn's already-authenticated provider client (keyless gateways work) | ALIVE | The judge's model-call idiom. |
| `background_review_service` — `auxiliary.background_review.autoMemoryModel` | **DEAD selector** (zero readers) | Fallback in the judge-model resolver (§4). |
| Disabled-skills prompt injection (the 2026-08-27 audit bug) | **FIXED** — enabled-filter at catalogue (skill_service.py:359-361), cache busts on every mutation (:375-405), tool-level refusals (skill_tools.py:17-21). Verified in code 2026-08-29. | The Phase D step-1 prerequisite is satisfied; **residual leaks remain** (§3.4 step 1). |

**Dead surfaces this plan sweeps (Step 0 — each is wired into the loop or deleted; nothing stays half-dead):**

| Item | Evidence | Action |
|---|---|---|
| `/api/curator/run` 404 | `CuratorSuggestionBar.tsx:31` calls it; no router implements it (live: HTTP 404) — and the bar itself is **never mounted** (zero imports), while the palette's "Review pending skills" navigates `/brain?tab=learning`, a tab that does not exist (CommandPalette.tsx:294) | **Implement the report endpoint in Phase E** (`POST /api/curator/run?dryRun=` + `GET /api/curator/report`); mounting the chip + the Learning tab is the prerequisite work, not an afterthought. |
| Command Palette "Run sleep cycle now" 404 | `CommandPalette.tsx:310` posts `/api/brain/run-consolidation`; route is `/api/brain/consolidation/run` (brain_config.py:167; live: HTTP 404) | One-line frontend fix; independent ship-now bugfix — do not wait for the loop. |
| `memorySuggestions` F3 pattern | `_MEMORY_SUGGESTION_PATTERNS` `workbench.py:4680-4700` + `types/workbench.ts:413` have no readers on either side | Delete; Phase A supersedes it with evidence-backed candidates. |
| `guidance.py` | zero **production** callers, but `tests/test_phase5_features.py` imports it | **Demoted:** delete only together with that test's rewrite — not a Step-0 sweep item. |
| `search` tool label | tool_policy.py:61-62 comment claims "memory/files/web"; implementation (session_tools.py:12-53) is files+web only — registration copy already honest (:773-776) | Fix the comment only. The "memory hit section via `brain_query`" add is **CUT** — `brain_query` already is the memory search tool; unifying search is a new product surface, not loop work. |
| refine-store `skill`/`subagent` kinds | stored (refine_store.py:34) but never injected (:389) and never touch `data/skills/` | **Demoted:** a second skill-draft path beside `harness_self_improve` is the duplication this plan avoids; escalate only if refine_store is touched for another reason. |

## 3. Architecture

New service `backend-py/app/services/episode_miner.py` + two tables + skill-store extensions. Everything downstream reuses existing machinery.

### 3.1 Phase A — Episode extraction (deterministic, post-hoc)

**Unit = the episode, not the conversation:** a failure→recovery window, a correction→accepted window, or an abandoned-approach window. Extracted by a scheduled pass over stored transcripts (`messages` table) + turn telemetry; **no runtime change to the chat loop**.

Typed events mined (all already observable): tool errors/exit codes, retries of the same tool+args, malformed-tool-JSON validation errors, non-advancing `update_state` rounds, user-correction messages after an assistant claim, abandoned approaches (plan/branch discarded), user rescue (user performing the step themselves). Sub-agent transcripts are minable post-hoc.

Migration (**028** — 027 is taken by Part 17 Phase L's untracked `027_turn_latency_telemetry.sql`, whose ttft/cache columns are already documented as schema v12):

```sql
CREATE TABLE episodes (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  kind TEXT,                 -- failure_recovery | correction_accepted | abandoned_approach
  start_message_id INTEGER, end_message_id INTEGER,
  events TEXT,               -- JSON: typed event list with tool/outcome/excerpt
  outcome TEXT,              -- resolved | unresolved | rescued
  fingerprint_id TEXT,
  tier INTEGER DEFAULT 1,    -- 1 scored | 2 judged
  judge_verdict TEXT,
  created_at TEXT
);
CREATE TABLE failure_fingerprints (
  fingerprint TEXT PRIMARY KEY,  -- normalized signature, e.g. missing-binary:ngspice
  episode_count INTEGER DEFAULT 1,
  first_seen TEXT, last_seen TEXT,
  flagged INTEGER DEFAULT 0,     -- promoted to tier 2
  status TEXT                    -- open | skill_drafted | resolved | retired
);
```

### 3.2 Phase B — Tier-1 scoring + fingerprints (no model calls)

- **Fingerprint** = turn_outcomes' signature discipline generalized: `cause-class + normalized key tokens` (slug-cased, stopword-stripped; `missing-binary:ngspice` is the canonical shape). Same fingerprint increments `episode_count`; paraphrase-level dedupe via the consolidation BM25 similarity (≥0.85, consolidation.py:122-187, extracted to a shared `text_similarity.py`).
- **Six fixed rubric criteria** (deterministic, no LLM): completion (did the turn end resolved), correction count, recurrence (fingerprint count), recovery quality (rounds to recovery), cause stability (same cause across sessions?), generalizability (does the cause mention project-specific names). Weighted score; **only the top ≤5% of episodes are flagged to tier 2** — the cost gate.
- **Fingerprints are `brain_query`-searchable (not a `search`-tool add):** fingerprints join the `facts`-adjacent query surface so `brain_query` can hit them; the earlier draft's "add a memory section to the `search` tool" is CUT (2026-08-30) — `brain_query` already is the memory search tool.

### 3.3 Phase C — Tier-2 judge + distiller

One model call per flagged cluster (batched ≤5; piggybacks the consolidation cadence loop, cognitive_boot.py:102-114 — no new scheduler). **The judge sees only the flagged episode windows plus skill titles/descriptions — never whole conversations, never full skill bodies.** Strict JSON out:

```json
{"verdicts": [
  {"episode": 12, "action": "none", "reason": "one-off environment quirk"},
  {"episode": 13, "action": "memory", "summary": "...", "category": "project|reference|feedback|general",
   "title": "...", "expires_days": 90},
  {"episode": 14, "action": "create_skill", "name": "...", "description": "...",
   "trigger": "...", "body_markdown": "..."},
  {"episode": 15, "action": "amend_trigger", "skill": "...", "description": "..."},
  {"episode": 16, "action": "amend_body", "skill": "...", "patch_markdown": "..."}
]}
```

- `memory` → `save_fact(source='harness', kind='lesson')` (the server-side path `remember` uses, rest.py:30-73) — lands in the facts store, consolidation-deduped, **human-deletable in the Memory UI** (`_ROW_DELETABLE` includes `facts`, brain.py:461; only the model's `forget` tool defers to system lanes, session_tools.py:467-474 via `_FORGET_ALLOWED_SOURCES` :360-363).
- `create_skill` / `amend_*` → `harness_self_improve.save_proposal(kind='skill_create'|'skill_patch')` — the existing queue. Bodies normalized through `_ensure_canonical_body(..., is_learned=True)` at **propose** time so reviewers see the final shape (today only the applier normalizes, harness_self_improve.py:464-469 — propose-time normalization is new work).
- Sensitive-topic denylist (session_tools.py:75-93, extracted to a shared util) applies to every drafted summary/body before persist.
- **Ship bar:** judge precision ≥ 0.8 on ≥ 30 hand-labeled episodes before any `amend_body` is enabled; until then `amend_body` verdicts downgrade to proposals-with-note.
- **Frontmatter quote fix (earns its place — live bug):** `_parse_frontmatter_block` never strips quotes (skill_service.py:197-204) while `_skill_frontmatter` writes quoted descriptions (harness_self_improve.py:414), and the bundled `august-harness`/`august-tools` SKILL.md files are quoted too — confirmed live: `GET /api/skills` returns literal quote characters that then ride into every prompt's skills index. One parse-time strip fixes both.
- Judge failures (bad JSON/timeout) log to `lifecycle`, episode returns to tier 1 with a cooldown — no retry storms.

### 3.4 Phase D — Review queue, versioning, demotion

**Step 1 — residual demotion-leak closure (the original step-1 bug is verified fixed; these are what remain):**
1. `catalogue()` memoizes on root-dir mtime only (skill_service.py:43-65, :341-365) — in-place SKILL.md edits never bust prompt caches until an unrelated mutation. Fix: per-skill SKILL.md mtime in the memo key.
2. No supersession link — a distilled v2 can ship while v1 stays enabled (double injection). Fix: applier honors `supersedes` — disables the old skill in the same write (patchSkill's enabled flip :725-729 via copy-on-write `_copyOnWrite` :636-650; `setEnabled` :768-776; full cache bust :375-405) and stamps `supersedes:` in the new frontmatter.

**Step 2 — skill-store extensions:** learned skills carry frontmatter `origin: human|distilled|amended`, `learned_from: <episode ids>`, `version: N`, `status: active|stale|retired`. Bundled skills are never amended (proposals against them become fresh drafts referencing them).

**Step 3 — review UX (existing surfaces):** proposals endpoint gains `source`/`origin` grouping so self-improvement drafts are recognizable; approve/reject via the existing `/api/harness/proposals/{pid}/decide` (routers/harness_proposals.py:36). Batch-approve is out of scope until the queue earns it. Anti-drift rules enforced here: the judge never sees its own pending/rejected drafts; **one draft per (fingerprint, action, target)** — enforced by a uniqueness check at propose time.

### 3.5 Phase E — Measurement (recurrence meter)

- **Usage tracking:** `load_skill`/`load_skills` handlers (skill_tools.py:9-24, bulk_tools.py:204-210) bump per-skill use_count/last_used in a skill-usage sidecar (internal_state-style). Without this, "zero trigger-hits" is unknowable — which is why the curator endpoint could not honestly exist before.
- **Resolution check:** a shipped skill's fingerprint is monitored; **0 recurrences in 30 days = resolved**; recurrence re-flags the fingerprint and drafts a revision-or-retire proposal.
- **Report:** metrics (`drafts, approval_rate, open/resolved/recurred, judge cost, demotions`) in a `skillLearningReport` internal_state blob served by the newly implemented `POST /api/curator/run?dryRun=…` + `GET /api/curator/report`, un-404-ing the existing `CuratorSuggestionBar` button and rendering in the Learning section header.
- **Demotion:** zero loads and no recurrence in the window → `skill_delete`/disable **proposal** (human-approved) — never auto-deleted; demotion is suggestion-only (open question 5).

## 4. Config surface

`skillLearning: off | extract-only | full` (rec ship default **`extract-only`**: mining + scoring + memory distillation run; skill drafting requires flipping to `full`) + `skillLearningJudgeModel` (resolver: explicit setting → `auxiliary.background_review.autoMemoryModel` — its first reader → titler resolver order, title_generator.py:147-169, so keyless gateways work). Budget knobs: `escalationBudgetPerDay` (2), `flagRateCap` (5%).

**Status (2026-08-30):** `skillLearning` is already live via Part 17 Phase E (brain_config_service.py:65, :121, :218, enum-guarded to off/extract-only/full, default extract-only) — this plan consumes it; only `skillLearningJudgeModel` and the two budget knobs remain to add.

## 5. UI

Learning section in the existing Skills hub **vertical rail** (no pill tabs, 2026-08-27 ruling): metric header from the report, flagged-episode list with fingerprint + rubric scores, proposal drafts inline with approve/reject, resolved/recurred history. All read-only until a deliberate approve.

## 6. Validation

- New tests: `tests/test_episode_miner.py` (window extraction from synthetic transcripts, typed events, no-live-turn coupling), `tests/test_fingerprints.py` (signature stability, paraphrase dedupe, ≤5% flag cap), `tests/test_distiller.py` (JSON contract, all five actions, denylist on drafts, one-draft-per-(fp,action,target)), `tests/test_skill_supersession.py` (v2 approval disables v1, caches busted, mtime-staleness fix, quote strip), `tests/test_recurrence_meter.py` (usage recording, resolution math, curator report).
- Judge-precision harness: 30 hand-labeled episodes scripted against the real loop, as a NEW `tests/test_distiller_precision.py` (the previously cited `tests/test_harness_evals.py` does not exist) — the ship bar is a test, not a vibe.
- Existing baseline: "191 memory/skills tests green (2026-08-29)" was NOT reproduced on the 2026-08-30 re-count (name-match ≈187 test functions; tight 14-suite guess ≈144) — re-run once and pin the real number before claiming no-regressions. Run subsets with `--basetemp="$TEMP/august_pytest"`; never two suites concurrently.
- Fast path: `cd backend-py && uv run ruff check . && uv run mypy app/ && uv run pytest -q` on the touched subset first. Frontend bits (curator bar, palette fix, Learning section): `npm run test:frontend` (tsc + vitest; eslint has pre-existing errors at HEAD — diff before blaming).
- Desktop ship rule: backend changes are bundled — the 7-file version bump applies on release.

## 7. Open questions for ruling (draft §11 carried forward)

1. **Ship default** — `extract-only` (recommended) vs `off` vs `full`.
2. **May drafts amend bodies of human-authored skills** — the ruling wanted FIRST: recommended no until the precision ship bar is met (Pitfalls-section-only amendments as the intermediate). Decides how much the judge is trusted at birth.
3. **Sub-agent transcript mining** — recommended in scope (post-hoc only; judge never runs inside a sub-agent).
4. **Judge model default** — dedicated `skillLearningJudgeModel` vs always-session-model; recommended dedicated-with-fallback (§4).
5. **Demotion** — suggestion-only (recommended) vs auto-disable.
6. **Episode retention** — recommend 90-day prune in the consolidation sweep (turn_outcomes uses 30 days).

**Reserved not-v1 track:** correction-in-success episodes (the How-section vein) — extraction records them, judge action stays `none`.

## 8. Non-goals

- No embeddings/vector DB (lexical BM25 everywhere, consistent with the whole store).
- No auto-executing or auto-shipping skills (approval queue is load-bearing; `full` mode still queues).
- No changes to `remember`/`forget` model semantics; no new always-on prompt sections beyond what the freeze already covers.
- No per-project scoping here — Part 17's substrate; its global distillation (Phase E) calls this plan's Phase C engine when both are adopted.
- **Coordination update (2026-08-30):** Part 17 Phase E landed FIRST — `skillLearning` config + a promotion judge/queue are already live (brain_config_service.py:65, :121, :218). This plan's Phases A–C must extend that machinery (one distiller, one queue, one config knob), NOT add a parallel engine; the earlier "hard gate on Part 16 Phase C" is satisfied in reverse — the gate now binds Part 16 to reuse what landed.

## 9. Third review (2026-08-30) — citation re-verification + implementation gate

Adversarial re-verification against the working tree (live probes + full
suite runs; see Part 17 §9 for the shared validation record: backend 1985
passed / 1 skipped, ruff + mypy clean, frontend 958/958 + tsc clean).

**§2 table — all ALIVE claims hold.** `harness_self_improve` applier +
scheduled introspection wired; `turn_outcomes` `maybe_promote_failure_lesson`
:229 and `_review_lesson` gate :191 confirmed at cited lines; consolidation
`_MERGE_SIMILARITY = 0.85` (:27) + supersede (:190-211); refine_store kinds
:34; `data/skills/` holds only `.usage.json` — nothing has ever written a
learned skill, confirmed on disk.

**Step-0 dead-surface sweep — all hold, with line drifts:**
`/api/curator/run` still has no router (grep: zero hits in routers/);
`CuratorSuggestionBar.tsx:31` still zero importers; palette dead links
confirmed at `components/overlays/CommandPalette.tsx:294` (`/brain?tab=learning`
— no such tab in routes/settings-registry) and `:310`
(`/api/brain/run-consolidation` vs real route `POST /api/brain/consolidation/run`,
now at brain_config.py:184, not :167). `_MEMORY_SUGGESTION_PATTERNS` has
drifted to workbench.py:4761 (was :4680-4700), still zero readers;
`memorySuggestions` now types/workbench.ts:425 (was :413), still unread.
`guidance.py` zero production callers confirmed. `tool_policy.py:61-62`
comment mismatch unchanged.

**The frontmatter quote bug is CONFIRMED LIVE by execution:**
`list_all()` returns descriptions with literal surrounding quotes
(`'"How the August agent loop works…'`) — `_parse_frontmatter_block`
(skill_service.py:219-226, drifted from :197-204) never strips them while
`_skill_frontmatter` (harness_self_improve.py:417-422) and the bundled
august-harness/august-tools SKILL.md files write quoted values. These quoted
strings ride into every prompt's skills index. Phase C's quote-strip fix is
justified and independent — it can ship any time.

**New dependency on Part 17 §9 (implementation gate):** Part 17's third
review found the `skill_delete` proposal applier (harness_self_improve.py
:491-503) rmtree's `_agentSkillsDir() / name` with NO `_validateName`
(Part 17 finding F-2), and `save_proposal` doesn't validate payload.name.
This plan's Phase C/D distiller FILES skill proposals into that same queue —
so the F-2 fix (validate at propose time + apply time) MUST land before any
automated drafting is enabled, or the judge becomes a programmatic caller of
the unvalidated delete path. Same for the project-memory rollback gap (F-3)
and home-scope leak (F-5): Phase A's episode miner reads sessions and
workspace state and would inherit those defects as noise.

**Sequencing ruling (for the implementing agent):**
1. Part 17 §9 fix batch F-1…F-7 first (small, security + correctness). — **LANDED** `1721b2a9` (2026-08-30).
2. Part 16 Step-0 quick wins any time after: palette route fix (:310),
   tab=learning dead link (:294) or create the Learning tab, quote-strip
   fix, tool_policy comment. — **LANDED in the working tree** (2026-08-30:
   palette routes → `/settings/skills` + `/api/brain/consolidation/run`,
   `_MEMORY_SUGGESTION_PATTERNS` + `memorySuggestions` deleted,
   `tool_policy.py` search comment fixed, `_parse_frontmatter_block`
   quote-strip + hygiene test).
3. Part 16 Phases A–E only after (1) lands — the engine builds on the
   substrate; migration 028 retarget still correct. — **IN PROGRESS**
   (2026-08-30 implementation pass; see §11 for live status).

---

## 10. External research deltas (2026-08-30) — PROVENANCE RECORD AREA

> Record area per the plans directive: the two externally-scanned agent
> harnesses are named here ONLY. Every adopted delta below is restated in
> August-native terms in the phases above/below; nothing in §10 defines new
> behavior by reference.

Two external harnesses were deep-scanned this day (4 subagent scans each;
reports in session transcript; clones in `%TEMP%`):

* **prime-agent** (PrimeIntellect-ai) — a "Self-Improving RLM Harness";
  its `/refine` mechanism is the closest shipped cousin of this plan's
  Phase C/D.
* **zed** (zed-industries) — its `agent_skills` crate README + prompt-cache
  discipline informed the skills surfaces.

**Adopted into this plan (all restated natively in code):**

| Delta | Where it lands |
|---|---|
| Separate plan from apply; LLM only proposes, a deterministic validator gates every edit; per-edit failure isolation (one bad verdict never aborts the batch) | Phase C distiller verdict loop + the existing proposal queue's `save_proposal` validation |
| Cheap review-gate before distiller spend: cooldown + "prefer an empty verdict list over speculative drafts" instruction in the judge prompt | Phase C `run_distiller_pass` gating |
| Evidence as two mandatory structured fields — rationale (trajectory evidence) + expectedOutcome (what should improve, how to validate) — recorded per judgment and REPLAYED into future judge prompts (last N) | Phase C verdict records (`judge_verdict` blob) + judge prompt assembly |
| Optimistic concurrency: state re-read at apply time; per-edit validation at propose time (payload.name validated at file time) | Already shipped (§9 F-2); reaffirmed as the boundary |
| Skill catalog memo keyed per-skill SKILL.md mtime so in-place edits bust prompt caches | Phase D step 1 |
| Supersession on approval: approved v2 disables v1 in the same write and stamps `supersedes:` frontmatter | Phase D step 2 |
| Learned-skill frontmatter provenance: origin / learned_from / version / status | Phase D step 2 |
| Amends never touch bundled skills — proposals against them become fresh drafts referencing them | Phase C distiller target resolution |
| Usage sidecar (per-skill trigger counts) as the precondition for honest recurrence measurement | Phase E `record_skill_use` |

**Considered and NOT adopted (each cut by the every-item-earns rule):**

* Executable Python-skill packaging (skills as importable modules) — August
  skills are markdown procedures; the judge writing code files violates the
  refiner-never-writes-code boundary anyway.
* Full persistent-REPL / prompt-as-variable architecture and the multi-process
  daemon topology — different design point; August's conventional loop and
  single backend process are deliberate.
* Skill catalog byte-budget + deterministic overflow (50KB) — worth adopting
  only when the catalogue first exceeds a few KB in practice; recorded as a
  future knob, not v1.
* `disable-model-invocation` frontmatter flag — overlaps August's existing
  `disabled` + enabled-filter machinery; no second mechanism.

---

## 11. Implementation status (2026-08-30, updated after the Phase C landing)

* **Landed (working tree):**
  * *Phase A+B* — `episode_miner.py` (window extraction, typed events,
    fingerprints, six-criterion rubric, flag-rate-cap + daily escalation
    budget, 90-day prune), migration `028_episodes_fingerprints.sql`,
    shared `text_similarity.py` BM25 ratio, `test_episode_miner.py`,
    `test_fingerprints.py`.
  * *Shared denylist* — `sensitive_topics.py` extracted from
    session_tools' remember-gate scanner (Phase C prerequisite); the
    remember door aliases it unchanged.
  * *Fingerprint visibility* — `brain.py` `_brain_query_fingerprints`:
    `brain_query store=failure-fingerprints` virtual store (recurrence-
    ranked), per the §3.2 CUT note (no `search`-tool add).
  * *Phase C* — `skill_distiller.py` (batched ≤5 judge, strict 5-action
    JSON, judge timeout/cooldown, `precision_state`/`record_precision_run`
    ship-bar machinery, `_draftExists` anti-drift, `dryRun` support,
    propose-time canonical bodies) + `test_distiller.py`.
  * *Cadence wiring* — consolidation `_skill_learning_pass`: mine → flag →
    distill → prune piggyback the consolidation loop, `skillLearning`-gated.
  * *Step-0 sweep* — palette routes (`/settings/skills`,
    `/api/brain/consolidation/run`), `_MEMORY_SUGGESTION_PATTERNS` +
    `memorySuggestions` deleted, tool_policy comment, frontmatter
    quote-strip + hygiene test.
  * *Config knobs REGISTERED (2026-08-30, later — the "live gap" below is
    CLOSED):* `skillLearningJudgeModel` (str), `escalationBudgetPerDay`
    (num 0-50, default 2), `flagRateCap` (float 0.0-0.5, default 0.05) are
    in `brain_config_service.py` key tuples + `fieldTable` + range
    validation; `_ALLCamelKeys` oracle in test_brain_config.py extended.
    (The reverted first draft had registered them; the revert dropped the
    registrations — re-landed deliberately with validation branches.)
* **Phase D LANDED (2026-08-30, same-day implementation pass):**
  per-skill SKILL.md mtimes in the catalogue memo key
  (`_skillMdMarks` — in-place edits bust the memo); `supersedes` honored
  by the applier (v2 approval disables v1 in the same write + stamps
  `supersedes:` frontmatter); learned provenance
  (`origin`/`learned_from`/`version`/`status`) written at apply time with
  version bump on patch; proposals endpoint `origin` filter (§3.4 step 3);
  bundled-skill amends convert to fresh `-revised` drafts referencing the
  original (distiller side).
* **Phase E LANDED (same pass):** `record_skill_use` sidecar
  (`.usage.json`) wired into `load_skill` (bulk inherits); recurrence
  meter `run_resolution_check` (resolve / re-flag / revision-or-retire /
  demotion suggestions — all suggestion-only, deduped via
  `_draftExists`); `/api/curator/run` + `/api/curator/report` +
  `/api/curator/episodes` router (CuratorSuggestionBar un-404'd, its
  report shape composed); LearningPanel mounted in the Skills hub
  (metric header, flagged episodes with rubric scores, distiller drafts
  with approve/reject through the existing queue).
* **Remaining test files LANDED:** `test_skill_supersession.py` (5),
  `test_recurrence_meter.py` (7), `test_distiller_precision.py` (6 — the
  ship-bar harness: gate math + scripted-judge accumulation; production
  hand-labels accumulate in `data/skill_learning_precision.json`).
* **Still open (design in §10 / phases above):**
  * Production hand-labeling of ≥30 real episodes to actually open the
    `amend_body` gate (the harness + gate ship; real labels accumulate).
  * OQ 1–6 confirm-or-revert rulings (code follows recommended defaults:
    extract-only, no amend-body at birth, sub-agent mining in scope,
    dedicated judge model with fallback, suggestion-only demotion, 90-day
    prune).
  * A first agent-written draft of Phase C–E was written and REVERTED the
    same day on the user's hold — §10 is the reviewed design record it was
    re-implemented from (this pass re-lands the reviewed design; the
    revert's unregistered-knobs gap was found and fixed en route).

---

## 12. Third review (2026-08-30) — adversarial findings → fix batch (§12.1)

Executable probes against the working tree + a copy of the LIVE production
DB (`AppData/Roaming/com.august.proxy/data/august_brain.sqlite`, 1244
messages / 34 recent sessions). Probe scripts + raw outputs:
`%TEMP%/probe{1,2,3,4,5,6,7,8,8b,9}_*.py` (copied to the reviewer profile's
`probes/part16-review/`). Baseline re-verified before probing: ruff + mypy
clean (305 files); the 7 Part 16 suites = 65 passed.

**Headline: the loop as landed cannot learn anything from real transcripts
(F-1/F-2/F-3/F-4 — four independent blockers, each sufficient alone), and
one queue item is a loaded weapon that destroys a skill body on approval
(F-5).** The 56 new tests are green because they seed the DB in shapes the
app never writes (JSON-string content, assistant-role errors) and call
`apply_verdict`/`_run_batch` directly instead of the wired chain.

### F-1 (Critical) — miner reads the wrong transcript shape; Phase A mines zero episodes from real data

`_messageText` (episode_miner.py:75-85) handles `str` and block-LIST, but
the app stores assistant/tool messages as JSON **dicts**
`{"content": "...", "tool_calls": [...]}` (memory_store/sessions.py:139-147
— the workbench persistence path; routers/sessions.py:170 is the only
plain-string writer). `_messageText` returns `''` for dicts.

Probe 1 (live DB): parsed content types `{str: 10, dict: 1177}`; non-empty
text after flatten `{assistant: 0, tool: 0, user: 10}` — **531 assistant +
646 tool messages all flatten to empty**. `_TOOL_ERROR_RE` matches 19
messages on their INNER text, every one role=`tool` (assistant-role hits:
0) — the miner only scans role=assistant (episode_miner.py:97), so the
typed-event layer is blind to where errors actually live. Probe 7-C:
end-to-end `mine_sessions` on an app-shaped seeded session →
`{'sessions': 1, 'episodes': 0}`. Fix direction: flatten dict content
(`content` + `tool_calls` names/args), scan role=`tool` for errors, and
treat the assistant→tool pair as the failure event.

### F-2 (Critical) — raw-text stored messages crash mining; `POST /api/curator/run` 500s on real data

episode_miner.py:128 `json.loads(str(r['content']))` has no try/except, and
57/1244 live messages are raw text (sessions.py:144 stores `content_str`
verbatim when the payload is already a str — e.g. `[Proxy Self-Heal]`
nudges, plain user turns). Probe 2: `extract_episodes` RAISES
`JSONDecodeError` on the busiest session AND on the session with raw rows;
`mine_sessions()` aborts entirely. Probe 5 (handlers called directly against
a copy of the live DB): `POST /api/curator/run` **with dryRun=true and
without — both RAISED JSONDecodeError → HTTP 500**. User-visible: the
LearningPanel "Run now" toast fails, CuratorSuggestionBar shows "Curation
pass failed — check backend". The 24h consolidation pass swallows the same
crash at debug level (consolidation.py:275-277) → silent zero-learning.

### F-3 (High) — `flag_top_slice` pre-marks episodes judged; the distiller never judges

`flag_top_slice` writes the tier-1 rubric into `judge_verdict`
(episode_miner.py:484-487), but `run_distiller_pass` selects
`unjudged = tier-2 episodes with EMPTY judge_verdict`
(skill_distiller.py:417-421). Every flagged episode already carries a
non-empty verdict → `unjudged` is **always empty by construction**. Probe 3:
episode flagged via the real `set_flagged` + tier-1 verdict write →
`run_distiller_pass: {'batches': 0, 'verdicts': 0}`, scripted judge called
0 times even with `skillLearning=full`. The only test touching
`run_distiller_pass` asserts the cooldown skip, so the hole is invisible.
Fix direction: a distinct column/state for tier-1 score vs tier-2 verdict
(the schema has both `tier` and `judge_verdict`; conflating them broke the
state machine).

### F-4 (High) — `_run_batch` returns None inside a live loop; the manual curator run can never judge

skill_distiller.py:458-464: when `asyncio.get_running_loop()` succeeds,
`_run_batch` returns `None` ("schedule via the sync path" — no such path
exists). The consolidation cadence is safe (`asyncio.to_thread`,
consolidation.py:356), but `runCurator` is an `async def` handler
(routers/curator.py:27) that calls `mine_sessions()` +
`run_distiller_pass()` inline → judge always "fails" → 30-min cooldown
fires on a manual run. Probe 3: `_run_batch inside live loop returns: None`.
Secondary: the same handler runs the full multi-session mining pass
synchronously ON the event loop (blocks the API for the scan's duration).

### F-5 (High) — approving an `amend_body` downgrade proposal WIPES the target skill's body

The downgrade path (skill_distiller.py:376-391) files `kind='skill_patch'`
with **no `payload.body`**. The applier reads
`body = as_str(payload.get('body'), '')` (harness_self_improve.py:495) →
`''` → `_ensure_canonical_body('')` renders an all-placeholder canonical
body → `md.write_text(frontmatter + normalized)` overwrites the real
SKILL.md. Probe 6-A: a learned skill with a real How-to-Run/Pitfalls body
(331 chars) → human approves the downgrade proposal → 735 chars of
placeholders, `body prose preserved? False`. The proposal's own rollback
text claims "the existing skill body is untouched" — false. The precision
ship bar is therefore moot until this is fixed: the "safe" pre-bar artifact
is the destructive one. (The Part 17 §9 F-2 name validation holds —
`save_proposal` + applier both `_validateName`; the traversal hunt came up
clean everywhere else: curator router takes no paths, `record_skill_use`
derives its path from the catalogue, `_isBundledSkill` only probes
existence.)

### F-6 (Medium) — re-mining the same window inflates recurrence and churns resolution state

`save_episode` dedupes on (session, start, kind) and returns early, but
`record_episode` (episode_miner.py:341-342) calls `upsert_fingerprint(fp)`
unconditionally → `episode_count += 1` on EVERY 24h pass for the same
window (probe 4-1: same window twice → count 2). `last_seen` also bumps.
Probe 8b (clean chain): fingerprint resolved (45d old, skill shipped) →
cadence re-mines the same window → `last_seen` = now → next
`run_resolution_check` sees `recurred: 1` with **zero new failures**,
re-flags, and files a revise-or-retire suggestion. Related: the
paraphrase-dedupe text lane is dead — `record_episode` reads
`r.get('last_excerpt','')` (episode_miner.py:336) but no such column
exists, so only the token-containment path ever runs.

### F-7 (Medium) — pooled httpx client reused across `asyncio.run` passes → alternating "Event loop is closed"

`_run_batch` opens a fresh loop per pass (skill_distiller.py:466) while
`getClient` POOLS clients (providers/clients/__init__.py:57-73) whose
`httpx.AsyncClient` keeps a connection bound to the previous, now-closed
loop. Probe 7-B′ (keep-alive local server): pass 1 ok → pass 2 `RuntimeError:
Event loop is closed` → pass 3 ok. Each transport failure burns the 30-min
judge cooldown, halving effective judge throughput on top of F-3/F-4.

### F-8 (Medium) — rejected demotion suggestions re-file forever

`_draftExists` (skill_distiller.py:195-213) only matches `status == 'open'`.
After a human REJECTS a demotion, the next resolution pass re-files the
identical `skill_delete` proposal (probe 4-2: after reject, third pass
`demotionSuggestions: 1`, fresh open proposal). The queue refills with
rejected noise every 24h — and §3.4's anti-drift rule ("the judge never
sees its own pending/rejected drafts") is violated in the filing direction.

### F-9 (Low) — curator report status fields are dead

`_parseSkill` (skill_service.py:208-236) puts unrecognized frontmatter —
including the new `status:` — into `meta`, not top-level.
`_skillStatusReport` reads `s.get('status')` (curator.py:62) → always `''`
→ every skill counts active; `staled`/`archived` are permanently empty
(probe 9-G: applied skill with `status: active` frontmatter → report
`{'active': 7, 'staled': [], 'archived': []}`).

### F-10 (Low) — `skill_drafted` / `retired` fingerprint statuses never written

Migration 028 + §3.1 advertise `open | skill_drafted | resolved | retired`;
grep shows `skill_drafted` only READ (episode_miner.py:646), nothing sets
it, and `retired` appears nowhere in app code. A fingerprint whose skill
was just drafted+approved stays `open`, so the resolution clock starts from
the LAST mined occurrence (see F-6) rather than from ship time.

### F-11 (Low) — correction regex false-positives on machine-injected user blocks

Probe 9-H: 7/67 real user messages hit `_CORRECTION_RE` (~10%), including
`[SUBAGENT RESULTS …]` / `[SUBAGENT_COMPLETE …]` harness-injected blocks
(user-role but machine-authored) and a pasted-article dump. These mine as
`correction_accepted` episodes. The miner has no notion of the
`[SYSTEM: …]`/injection prefixes the workbench itself writes.

### Verified clean (probed, no defect)

* `_fingerprintSkillMap` (episode_miner.py:583-602): newest-applied wins —
  `list_proposals` sorts `createdAt` DESC and `setdefault` keeps the first
  (probe 8-E: v2 held after both applied). Correct as designed.
* Supersession write path: v2 approval disables v1 in the same write
  (`setEnabled` → `patchSkill`, single write) + stamps `supersedes:`;
  `skill_delete` applier carries the §9 F-2 `_validateName` guard
  (harness_self_improve.py:575-591).
* Config knobs: `skillLearningJudgeModel` / `escalationBudgetPerDay` /
  `flagRateCap` registered + range-validated + oracle-extended (the
  reverted-draft trap checked — registrations present, not phantom).
* Frontmatter quote-strip: matching-pair strip only, bundled unquoted
  frontmatter unaffected (hygiene test green).
* Judge model resolver order + `_extractJson` fence tolerance behave.

### Severity roll-up

| # | Sev | One-liner |
|---|---|---|
| F-1 | Critical | dict-shaped real messages flatten to empty — engine mines 0 episodes from live data |
| F-2 | Critical | raw-text rows crash mining — `/api/curator/run` 500s on real data (both UI buttons) |
| F-3 | High | tier-1 verdict pre-fills `judge_verdict` — distiller's unjudged set is always empty |
| F-4 | High | `_run_batch` no-ops inside a live loop — manual curator run can never judge |
| F-5 | High | approving the amend_body downgrade proposal overwrites the skill body with placeholders |
| F-6 | Medium | re-mine inflates `episode_count`/`last_seen` — false recurrence + suggestion churn |
| F-7 | Medium | pooled client across `asyncio.run` — alternating "Event loop is closed" judge failures |
| F-8 | Medium | rejected demotions re-file every pass (`_draftExists` open-only) |
| F-9 | Low | curator report reads top-level `status` that `_parseSkill` nests under `meta` |
| F-10 | Low | `skill_drafted`/`retired` states advertised but never written |
| F-11 | Low | correction regex fires on `[SUBAGENT …]` machine blocks (~10% FP on live users) |

**Review verdict:** Phases A–E are structurally present but the end-to-end
chain (mine → flag → judge → draft) has never executed successfully on
real-shaped data — each link breaks independently (F-1→F-2→F-3→F-4). The
loop is currently a no-op with a 500-ing button and one destructive queue
item (F-5). Recommend F-1…F-5 as the fix batch (test-first, with at least
one test seeded in the REAL storage shape + one chain test through
`run_distiller_pass` via `flag_top_slice`), F-6…F-8 second tier, F-9…F-11
folded in opportunistically. (2026-08-30, later: the full batch was ruled in
and landed — see §12.1; the text above is the review as written.)

### 12.1 Fix-batch changelog (2026-08-30) — all 11 landed test-first

Batch order F-1→F-11; every fix has a regression test in
`tests/test_part16_review_fixes.py` seeded in the REAL storage shapes
(dict payloads with tool_calls, tool-role errors, raw-text rows) — the
seed-shape gap §12 called out. All 15 tests green before the full-suite run.

* **F-1** — `_messageText` flattens dict-shaped content (`content` +
  `tool_calls` names/args, the workbench persistence shape); `_extractEvents`
  scans role=`tool` too (errors live there in real transcripts); recovery
  detection uses `_innerText` (prose only — a tool-call-only retry is not a
  clean continuation).
* **F-2** — `_loadContent` parses the content column defensively; raw-text
  rows (e.g. `[Proxy Self-Heal]` nudges) no longer abort mining, and
  `/api/curator/run` no longer 500s on real data.
* **F-3** — migration `029_episode_tier1_score.sql` adds `episodes.tier1_result`
  and backfills the F-3 shape (tier-1 blob out of `judge_verdict`);
  `flag_top_slice` writes the rubric there; `unscored_episodes` selects on
  `tier1_result IS NULL`; curator `/episodes` reads the rubric from
  `tier1_result`. NOTE: the flag cap keeps its strict `int(n*cap)` semantics
  (the Phase B oracle `test_zero_score_never_flagged` depends on it) — the
  chain tests use `flagRateCap=1.0` to flag their single episode.
* **F-4** — `_run_batch` no longer returns None inside a live loop: it
  offloads to a worker thread owning a fresh loop (`_run_batch_off_loop`).
  `runCurator` additionally runs the whole sync pass via `asyncio.to_thread`
  so mining never blocks the event loop.
* **F-5** — the `amend_body` downgrade files `kind='observation'`
  (review-only, never approvable) instead of a body-less `skill_patch`; the
  applier independently refuses `skill_patch` payloads with an empty body
  (`applyResult.ok=false`), so no approval can ever overwrite a SKILL.md
  with placeholder canonical text.
* **F-6** — `record_episode`/`mine_sessions` detect existing (session,
  window, kind) episodes and only `upsert_fingerprint` on NEW ones —
  re-mining no longer inflates `episode_count`/`last_seen`, so a resolved
  fingerprint stays resolved across cadence re-mines; `mine_sessions` counts
  only new episodes. The dead paraphrase lane is fixed: `_existingFingerprintTexts`
  rebuilds (fingerprint, excerpt) pairs from the episodes table (the
  nonexistent `last_excerpt` column read is gone) and is shared by both paths.
* **F-7** — `call_judge` uses a new `getUnpooledClient` factory (fresh
  client per batch, closed after the call) — the pooled client's keep-alive
  connections used to bind to each throwaway per-pass loop and alternate
  "Event loop is closed" failures. Test: `TestF7UnpooledJudgeClient`.
* **F-8** — `_draftExists` matches proposals in ALL statuses: a rejected
  suggestion is never re-filed, an applied draft is never re-filed;
  `_file_suggestion` returns whether it filed and `run_resolution_check`
  counts only actual filings.
* **F-9** — `_skillStatusReport` reads `status` from `_parseSkill`'s `meta`
  fallback, so `status: stale` frontmatter actually reaches the report.
* **F-10** — `set_fingerprint_status` writes the advertised statuses:
  `skill_drafted` when a distilled draft files (only from `open` — no
  resurrection of resolved fingerprints), `retired` when a fingerprint's
  `skill_delete` applies (from any state).
* **F-11** — `_isMachineInjected` skips harness-injected user-role blocks
  (`[SUBAGENT RESULTS`, `[Proxy Self-Heal]`, `[SYSTEM:`, `<memory_nudge`, …)
  for correction/rescue/abandon mining (~10% false positives on live users).

Validation: ruff clean, mypy clean (305 files), the 6 Part 16 suites +
the fix-batch file 68 passed; full suite numbers in the final report.
