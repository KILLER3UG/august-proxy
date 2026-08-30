# Part 16 — Self-Improvement Loops

**Status:** IMPLEMENTED 2026-08-30 — Step-0 + Phases A–E landed (see §11 for
the per-phase changelog); OQ 1–6 follow the recommended defaults
(confirm-or-revert). Third review 2026-08-30 (§9): every
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
