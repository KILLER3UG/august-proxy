# Part 16 — Self-Improvement Loops

**Status:** DRAFT — awaiting ruling. Reconstructed into the repo on 2026-08-29 from the drafted design record, then re-grounded against a same-day full scan of the memory/skills stack (all file:line verified against the working tree; live smoke test 2026-08-29).
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

## 2. What already exists (build on, don't duplicate)

| Piece | State (verified 2026-08-29) | Role in this plan |
|---|---|---|
| `harness_self_improve.py` — proposal queue, human approval, deterministic applier (`_apply_approved` :421-510, `skill_create/patch/delete` :441-508), scheduled introspection (:515-590; boots and files real proposals — confirmed live) | ALIVE | **Is** the review queue + applier for drafts (Phase D). No new approval machinery. |
| `turn_outcomes.py` — one telemetry row per turn (error_class/duration/task_type), failure-lesson promotion ≥3 same-signature failures in 7d → BM25 dedupe >0.55 → one `harness-lesson:<sig>` fact (:178-213, :267-291) | ALIVE | Tier-1 raw material + the fingerprint discipline Phase B generalizes. Its promotion lane is kept as-is. |
| `consolidation.py` — BM25 near-duplicate merge ≥0.85, contradiction supersede, expiry sweep (:91-235) | ALIVE | All distilled memories route through `save_fact`, so dedupe/supersede/expiry apply for free. |
| `skill_service.py` — learned-skill roots (`data/skills/` — **empty; nothing has ever written a learned skill**), canonical body normalizer :532-577, enabled-filtered catalogue :359-361 | ALIVE | Where approved skills land; canonical template (Title / When to Use / How to Run / Pitfalls / Verification) enforced at write time. |
| Workbench loop telemetry — retry/self-heal receipts, malformed-tool-JSON validation errors, non-advancing `update_state` reflection nudges, routing evidence | ALIVE | Episode events are read from what these already record. No new chat-loop instrumentation. |
| Cheap-model call idiom — `title_generator.py:147-169` reuses the turn's already-authenticated provider client (keyless gateways work) | ALIVE | The judge's model-call idiom. |
| `background_review_service` — `auxiliary.background_review.autoMemoryModel` | **DEAD selector** (zero readers) | Fallback in the judge-model resolver (§4). |
| Disabled-skills prompt injection (the 2026-08-27 audit bug) | **FIXED** — enabled-filter at catalogue (skill_service.py:359-361), cache busts on every mutation (:375-405), tool-level refusals (skill_tools.py:17-21). Verified in code 2026-08-29. | The Phase D step-1 prerequisite is satisfied; **residual leaks remain** (§3.4 step 1). |

**Dead surfaces this plan sweeps (Step 0 — each is wired into the loop or deleted; nothing stays half-dead):**

| Item | Evidence | Action |
|---|---|---|
| `/api/curator/run` 404 | `CuratorSuggestionBar.tsx:31` calls it; no router implements it (live: HTTP 404) | **Implement in Phase E** — it becomes the staleness/demotion report the loop already computes. |
| Command Palette "Run sleep cycle now" 404 | `CommandPalette.tsx:310` posts `/api/brain/run-consolidation`; route is `/api/brain/consolidation/run` (brain_config.py:167; live: HTTP 404) | One-line frontend fix, ships with the Step 0 batch. |
| `memorySuggestions` F3 pattern | `workbench.py:4525-4552` + `types/workbench.ts:413` have no readers on either side | Delete; Phase A supersedes it with evidence-backed candidates. |
| `guidance.py` | zero callers repo-wide | Delete file. |
| `search` tool label | tool_policy.py:61-62 claims "memory/files/web"; implementation (session_tools.py:12-53) is files+web only | Fix label; Phase B adds the memory hit section via `brain_query`. |
| refine-store `skill`/`subagent` kinds | stored (refine_store.py:34) but never injected (:389) and never touch `data/skills/` | `skill` entries gain an escalate-to-proposal path (Phase D). No new store. |

## 3. Architecture

New service `backend-py/app/services/episode_miner.py` + two tables + skill-store extensions. Everything downstream reuses existing machinery.

### 3.1 Phase A — Episode extraction (deterministic, post-hoc)

**Unit = the episode, not the conversation:** a failure→recovery window, a correction→accepted window, or an abandoned-approach window. Extracted by a scheduled pass over stored transcripts (`messages` table) + turn telemetry; **no runtime change to the chat loop**.

Typed events mined (all already observable): tool errors/exit codes, retries of the same tool+args, malformed-tool-JSON validation errors, non-advancing `update_state` rounds, user-correction messages after an assistant claim, abandoned approaches (plan/branch discarded), user rescue (user performing the step themselves). Sub-agent transcripts are minable post-hoc.

Migration (next free number; 027 at draft time — coordinate with Part 17 if both land in one batch):

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
- **Unified search memory scope:** the `search` tool's memory section is a thin `brain_query` call over `facts` + fingerprints — makes the Step 0 label fix real.

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

- `memory` → `save_fact(source='harness', kind='lesson')` (the server-side path `remember` uses, rest.py:30-73) — lands in the facts store, consolidation-deduped, **human-deletable in the Memory UI** (`_ROW_DELETABLE` includes `facts`, brain.py:409; only the model's `forget` tool defers to system lanes, session_tools.py:294-302).
- `create_skill` / `amend_*` → `harness_self_improve.save_proposal(kind='skill_create'|'skill_patch')` — the existing queue. Bodies normalized through `_ensure_canonical_body(..., is_learned=True)` at **propose** time so reviewers see the final shape (applier re-normalizes at apply, harness_self_improve.py:464-469).
- Sensitive-topic denylist (session_tools.py:75-93, extracted to a shared util) applies to every drafted summary/body before persist.
- **Ship bar:** judge precision ≥ 0.8 on ≥ 30 hand-labeled episodes before any `amend_body` is enabled; until then `amend_body` verdicts downgrade to proposals-with-note.
- **Frontmatter quote fix (earns its place — live bug):** `_parse_frontmatter_block` never strips quotes (skill_service.py:197-204) while `_skill_frontmatter` writes quoted descriptions (harness_self_improve.py:414), and the bundled `august-harness`/`august-tools` SKILL.md files are quoted too — confirmed live: `GET /api/skills` returns literal quote characters that then ride into every prompt's skills index. One parse-time strip fixes both.
- Judge failures (bad JSON/timeout) log to `lifecycle`, episode returns to tier 1 with a cooldown — no retry storms.

### 3.4 Phase D — Review queue, versioning, demotion

**Step 1 — residual demotion-leak closure (the original step-1 bug is verified fixed; these are what remain):**
1. `catalogue()` memoizes on root-dir mtime only (skill_service.py:43-65, :341-365) — in-place SKILL.md edits never bust prompt caches until an unrelated mutation. Fix: per-skill SKILL.md mtime in the memo key.
2. No supersession link — a distilled v2 can ship while v1 stays enabled (double injection). Fix: applier honors `supersedes` — disables the old skill in the same write (`setEnabled` → copy-on-write + full cache bust, skill_service.py:725-729, :375-405) and stamps `supersedes:` in the new frontmatter.

**Step 2 — skill-store extensions:** learned skills carry frontmatter `origin: human|distilled|amended`, `learned_from: <episode ids>`, `version: N`, `status: active|stale|retired`. Bundled skills are never amended (proposals against them become fresh drafts referencing them).

**Step 3 — review UX (existing surfaces):** proposals endpoint gains `source`/`origin` grouping so self-improvement drafts are recognizable; approve/reject via the existing `/api/harness/proposals/{pid}/decide` (routers/harness_proposals.py:36). Batch-approve is out of scope until the queue earns it. Anti-drift rules enforced here: the judge never sees its own pending/rejected drafts; **one draft per (fingerprint, action, target)** — enforced by a uniqueness check at propose time.

### 3.5 Phase E — Measurement (recurrence meter)

- **Usage tracking:** `load_skill`/`load_skills` handlers (skill_tools.py:9-24, bulk_tools.py:204-210) bump per-skill use_count/last_used in a skill-usage sidecar (internal_state-style). Without this, "zero trigger-hits" is unknowable — which is why the curator endpoint could not honestly exist before.
- **Resolution check:** a shipped skill's fingerprint is monitored; **0 recurrences in 30 days = resolved**; recurrence re-flags the fingerprint and drafts a revision-or-retire proposal.
- **Report:** metrics (`drafts, approval_rate, open/resolved/recurred, judge cost, demotions`) in a `skillLearningReport` internal_state blob served by the newly implemented `POST /api/curator/run?dryRun=…` + `GET /api/curator/report`, un-404-ing the existing `CuratorSuggestionBar` button and rendering in the Learning section header.
- **Demotion:** zero loads and no recurrence in the window → `skill_delete`/disable **proposal** (human-approved) — never auto-deleted; demotion is suggestion-only (open question 5).

## 4. Config surface

`skillLearning: off | extract-only | full` (rec ship default **`extract-only`**: mining + scoring + memory distillation run; skill drafting requires flipping to `full`) + `skillLearningJudgeModel` (resolver: explicit setting → `auxiliary.background_review.autoMemoryModel` — its first reader → titler resolver order, title_generator.py:147-169, so keyless gateways work). Budget knobs: `escalationBudgetPerDay` (2), `flagRateCap` (5%).

## 5. UI

Learning section in the existing Skills hub **vertical rail** (no pill tabs, 2026-08-27 ruling): metric header from the report, flagged-episode list with fingerprint + rubric scores, proposal drafts inline with approve/reject, resolved/recurred history. All read-only until a deliberate approve.

## 6. Validation

- New tests: `tests/test_episode_miner.py` (window extraction from synthetic transcripts, typed events, no-live-turn coupling), `tests/test_fingerprints.py` (signature stability, paraphrase dedupe, ≤5% flag cap), `tests/test_distiller.py` (JSON contract, all five actions, denylist on drafts, one-draft-per-(fp,action,target)), `tests/test_skill_supersession.py` (v2 approval disables v1, caches busted, mtime-staleness fix, quote strip), `tests/test_recurrence_meter.py` (usage recording, resolution math, curator report).
- Judge-precision harness: 30 hand-labeled episodes scripted against the real loop (same discipline as `tests/test_harness_evals.py`) — the ship bar is a test, not a vibe.
- Existing baseline: the 14 memory/skills suites + `test_prompt_cache_stability.py` = **191 passed** (2026-08-29). Run subsets with `--basetemp="$TEMP/august_pytest"`; never two suites concurrently.
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
