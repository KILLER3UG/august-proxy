# August harness — enhancement roadmap (2026-09-27)

Companion to [DEEP_SCAN_FINDINGS_2026-09-27.md](./DEEP_SCAN_FINDINGS_2026-09-27.md).
That document is what is broken; this one is what to build.

## Progress

| # | Item | State |
|---|---|---|
| 4 | Gate-participation conformance test | **DONE** — `tests/test_gate_participation.py`. Found finding #53 on its first run, which the 52-item sweep had missed. |
| 2 | `ok` honouring `end_reason` | **DONE** — `turn_outcomes.turn_ok()`. **No migration needed**: `end_reason` has been persisted since 046, so the judgement could be derived at write time. The proposal for a new `ok_reason` column was over-engineered. `ok = None` persists as SQL NULL, so both readers moved to `COUNT(ok)`. |
| 1 | Runaway-turn backstop | not started — still the largest real-world turn-reliability hole |
| 3 | `edit_verify_fails` as a per-turn count | not started |
| 5-11, 13-14 | — | not started |

Items 4 and 2 went ahead of the order below because both are S effort and both
make later work measurable: #2 gives the Learning panel honest numbers, and #4
is the mechanical check that finds the next instance of the bug class the audit
could only sample.

## How this was derived, and the honest caveat

Findings came from 16 parallel read-only auditors plus an adversarial
refutation pass, all against a baseline that is already green (ruff clean,
mypy clean on 334 files, 3924 backend tests, 1486 frontend tests, 70.34%
coverage). Enhancements were proposed by auditors reading the harness
subsystems directly, and deliberately filtered against
[HARNESS-FINDINGS-2026-09-15.md](./HARNESS-FINDINGS-2026-09-15.md) and
[GAPS_AND_BUGS.md](./GAPS_AND_BUGS.md) so nothing already known or already
done is re-proposed here.

Items 1-8 are auditor proposals and carry file:line citations I have **not**
re-verified by hand — check the line before acting on it. Items 9-14 are mine.
Items 9-11 are derived from the measured coverage report and the five systemic
patterns in the findings document. Items 12-14 come from reading
`fact_retrieval.py` directly, after seven auditor attempts at that slice failed.
Item 12 is the one place in this document where I stated a hypothesis, tested it,
and **had to retract it** — the refutation is kept in the item, because "the
boost is not dead, the `k` window is closed too early" is the more useful
finding and the retracting is the evidence for it.

Four items a first pass produced were excluded as duplicates of items already
in flight.

Every item names a metric the codebase could actually emit. That is the bar:
an enhancement with no observable signal is a wish.

---

## 1. A default-on runaway-turn backstop that argument novelty cannot reset

**Effort** M · **Impact** high

**Problem.** Nothing bounds a turn by default. `MAX_MANAGED_TOOL_ROUNDS = 0`
is uncapped, and the budget ladder arms (`budgetSoftUsd` / `budgetSoftTokens` /
`budgetWallClockSec`) are all-off opt-in. What is left is the stall counter —
and the loop resets `stalledRounds = 0` on argument novelty *and* on world
delta. A model that calls a **different tool with different arguments every
round** is therefore permanently "novel": no nudge, no hard stop, no cap, no
budget arm. The only remaining bound is the context window overflowing, which
is an error, not a design.

This is the largest turn-reliability hole in the harness, and it is the direct
cause of the runaway-budget-slot burn noted in the findings register.

**Mechanism.** Add a second monotonic counter the novelty resets cannot clear:
`roundsWithoutWorldDelta`, incremented when world delta is False *and* novelty
came only from argument variety (a new call signature or prose), not from a new
path touched or a cleared error family. Nudge at 25, hard-stop at 40, both in
brain-config (`0 = off`). Reuse the existing `stall-stop` reason with a new
`recovery {kind: 'runaway'}` event so the reason vocabulary stays stable.

**Success signal.** `turn_verdict_stats().counters.rounds.max` and the
`stall-stop` share both fall while `rounds.avg` stays flat — runaway turns cut
without shortening normal ones.

## 2. Make the turn ledger's `ok` honour `end_reason`, or every learning measurement is wrong

**Effort** S · **Impact** high

**Problem.** `turn_close.py` writes `ok = turnError is None`. A turn that ends
`stall-stop`, `length`, `budget`, `cap` or `awaiting-input` raised no
exception, so it is recorded as a **clean success**. Both consumers of that
column are then wrong in exactly the direction that matters: `skill_lift`
computes ok-rate-with minus ok-rate-without as a skill's measured effect, and
`error_rate_by_model` ranks models by `SUM(CASE WHEN ok = 0)`.

So the harness's self-improvement surfaces are blind to precisely the failure
modes it built stall detection, budget ladders and length-continuations to
fix. A stall-stopping turn currently *raises a model's measured error rate by
zero*.

**Mechanism.** One authority in `turn_outcomes.py` next to the existing
`TURN_END_REASONS`: `turn_ok(end_reason, errored) -> bool | None`, mapping
`finished`→True, `awaiting-input`→None (not failure, not success — the human
owes an answer), everything else→False. Persist as a new `ok_reason` column in
the same migration as the others; keep `ok` for back-compat; have all three
readers use `COALESCE(ok_reason, ok)` so a NULL never folds into a measurement.
Gate it behind the same column-detection fallback as the existing 046 columns so
an old DB degrades instead of dropping telemetry.

**Success signal.** The top model's `errorRate` in `error_rate_by_model`
becomes non-trivial, and `skill_lift` signs flip for at least one skill once a
`stall-stop` population is in the window.

## 3. `edit_verify_fails` is a session-trailing streak, not a per-turn count

**Effort** S · **Impact** high

**Problem.** `_edit_verify_streak` returns the session's `failStreak`, which is
reset *lazily inside* `verify_after_edit`. A turn that makes no edits never
calls it, so the previous turn's streak survives and gets re-reported. Since
`turnTelemetry` runs before `persistAndClose` (where `turnCount` increments),
turn N+1 with no edits re-reports turn N's value.

Two consequences: the `turn_outcomes.edit_verify_fails` column double-counts,
and the failure-lesson promoter re-fires on every edit-free turn — so a single
real gate-failure streak can cross the promotion threshold and write a durable
lesson about a problem the model does not currently have.

**Mechanism.** Add a `turnFails` counter and a `gateRanThisTurn` flag to the
verify state, reset in the **same** turn-change branch that resets `failStreak`
(today that branch only runs when the gate runs — that is the bug). Report
`NULL` when the gate did not run this turn; gate the lesson class on the same
value. Keep `failStreak` unchanged — it is correct for its per-turn fix-budget
job.

**Success signal.** `COUNT(*) WHERE edit_verify_fails > 0` stops growing on
edit-free turns, and the set of promoted `harness-lesson:*` facts stops
climbing monotonically with session length.

## 4. A conformance test that every reachable tool entry point passes a gate

**Effort** S · **Impact** high · *mine, from the measured defect register*

**Problem.** This is the highest-leverage item on the list, because five
separate defects in the register are the same bug wearing different clothes:

| # | Entry point | Gate it misses |
|---|---|---|
| 2 | `bulk(operation='delete_sessions')` | running-session deletion guard |
| 6 | `firmware_compile` `name` | `bind_path` sandbox containment |
| 8 | `desktop_click/type/press_key/ui_act` | confirm, plan, read-only |
| 22 | `/api/git` `repoPath` | repo containment |
| 30 | `desktop_open_url` | URL allowlist / SSRF gate |

Every gate in the codebase is an inline `if toolName in (...)` at one call
site, so a new entry point is a fresh unguarded door. `tool_policy.py` already
knows how to resolve nested bulk operations — it just is not consulted
everywhere. **3924 tests are green with all five of these present**, which is
the proof that nothing enforces gate participation.

**Mechanism.** A single conformance test that imports the tool registry plus
`bulk_tools.py`'s operation literals plus the `desktop_automation` and
`firmware_tools` handler names, and asserts every one is claimed by at least one
gate predicate in `tool_policy.is_mutating` / the `workbench.py` prologue. Emit a
table of unclaimed entry points so the failure names the gap. This turns
"someone remembered to add it to the tuple" into a build failure.

**Success signal.** The test fails today on exactly the five entries above;
after the fixes it passes, and a sixth unclaimed tool fails CI rather than
shipping.

## 5. The overflow probe reads one flat field, so the reactive rescue can silently never fire

**Effort** S · **Impact** high

**Problem.** `_isContextOverflowError` reduces the response to
`as_str(response.get('error'))`. A nested envelope —
`{'error': {'message': 'prompt is too long', 'code': 'context_length_exceeded'}}`
— or a bare `{'code': ...}` stringifies to `''` and returns `False`. The
rescue is skipped and the turn falls through having done nothing. The marker
table is rich; the **shape** it is matched against is one.

Compounding it: the reactive path emits no event, while the budget path emits a
full `compaction` event. So an overflow rescue that succeeded, failed, or never
ran is indistinguishable in the stream.

**Mechanism.** Normalize the probe input — `error` when scalar, plus
`error.message` / `error.code` / `code` / `message` / `detail` when nested —
lowercased and joined, then match the existing table over that. Add a
`trigger: 'pre_turn' | 'reactive_overflow' | 'budget'` key and emit from the
reactive branch too. Table-driven test over the real envelope shapes.

**Success signal.** Share of `compaction` events tagged
`trigger='reactive_overflow'` — today that tag cannot exist, so overflow
rescues are uncountable in a stream the app already emits.

## 6. Two compaction paths, one docstring claim, three behavioural differences

**Effort** M · **Impact** high

**Problem.** The budget compaction is documented as "deliberately the SAME
compaction the pre-turn auto-compact runs". It is not the same as the reactive
one. The budget path passes a replay-user budget and a summarizer; the reactive
path passes neither and hardcodes `schema=True` where the budget path computes
it. The path that runs **after the model has already overflowed** — where the
original ask is most likely inside the summarized middle — is the one path that
cannot replay the user's own words.

The thresholds diverge too: reactive uses `before - 1`, i.e. "shrink by at
least one token", against a gate of `after >= before`. A reduction that removes
one token passes the gate and buys nothing.

**Mechanism.** One `_compactionCall(...)` helper in `recovery.py` taking
summarizer / replay / schema as arguments, called by both paths so the policy
has one site. The trigger should be the *only* intended difference; pin it with
a shared test asserting identical kwargs. Floor the reactive threshold at
`before - max(4096, before // 8)`.

**Success signal.** `compressedCount` on overflow-triggered compaction events
distinguishes a real reduction from a no-op — today the reactive path returns
`None` silently and only the internal comparison knows which happened.

## 7. The stale-write rejection is the loudest self-correction signal and lands nowhere

**Effort** S · **Impact** high

**Problem.** A hash-anchored edit whose `fileHash` no longer matches returns an
error string and nothing else — no log (contrast the PRE-hook failure two
lines away), no counter, no `record_guardrail_block`. That table's sole writer
is `tool_guardrails.py`, and `turn_close` builds the per-turn
`guardrail_classes` digest from it. So stale-write blocks never reach the turn
row and can never feed the failure-lesson path. The same holds for the timeout
returns.

Every one of these is a case where the harness **stopped the model from
corrupting a file**, and it is invisible to the evidence trail built to learn
from that.

**Mechanism.** Route the four string-return seams through one
`_recordExecInterception(session, toolName, reason)` that logs at INFO and calls
`record_guardrail_block` with stable reason strings (`stale_write`,
`tool_timeout`, `mcp_timeout`). No new table, no schema change — the log table
already has the columns and the privacy wipe already knows it.

**Success signal.** Turns whose `turn_outcomes.guardrail_classes` contains a
stale-write entry — structurally always 0 today; afterwards it is a countable
subset of `tool_guardrail_log` rows feeding `maybe_promote_failure_lesson`.

## 8. Separate the subagent-fanout population from main turns in the aggregates

**Effort** S · **Impact** medium

**Problem.** `spawn_subagents_tool.py` writes a durable row into the same
`turn_outcomes` table with `task_type='subagent_fanout'` and `model=''`. Nothing
downstream filters on `task_type`. So a 1-3 round fanout aggregate is averaged
into the same `reasons` histogram and same round average as a 20-round main
turn — the Learning panel's "avg rounds" is a blend of two populations.

Worse, `error_rate_by_model` groups by model and orders by errors descending, so
the `('', '')` bucket — which only ever holds fanout rows — sorts to the **top**
of the per-model error ranking whenever any fanout ended badly. A phantom
"model" with the highest error rate on the Observability page.

**Mechanism.** Give `turn_verdict_stats` a `task_type` predicate defaulting to
`!= 'subagent_fanout'`, and return a sibling `byTaskType` breakdown so the
population is visible rather than hidden. Add `task_type` to the group-by, and
sort unnamed rows last. `skill_lift` already filters `skills_injected IS NOT
NULL` and fanout rows never set it — record that invariant in a comment so it
stays deliberate.

**Success signal.** `error_rate_by_model` no longer leads with an empty-model
row; the Learning panel's avg-rounds stops moving when only fanout volume
changes.

## 9. A startup/reload field-parity test for every durable subsystem

**Effort** M · **Impact** high · *mine, from the measured defect register*

**Problem.** Four register entries are one bug: durable state is written with
a superset of fields and rehydrated with a subset, or keyed by content instead
of a stored id.

| # | Subsystem | Field lost at reload |
|---|---|---|
| 9 | MCP registry | the registry is never rehydrated at all |
| 23 | daemons | `expires_at` — TTL reaper is blind |
| 26 | daemons | id collides within one second, orphaning a run loop |
| 5 | project memory | filename is a title slug, no collision check |

This is the one class that directly threatens the install/update promise in
`AGENTS.md` — *a new download starts with an empty memory, an update keeps
everything*. The reason it survives a 3924-test suite is structural: the write
path runs every session, the load path runs **once at launch and asserts
nothing**, and no test restarts the process.

**Mechanism.** For each subsystem that writes then reloads (`daemon_manager`,
`mcp_client`, `project_memory`, `sessions`, `harness_jobs`, learned skills),
extract the field set from the writer and from the loader and diff them in a
test. Then a restart test per subsystem: register before reload, assert the
entity survives with identical fields. Content-derived keys get a uniqueness
assertion.

**Success signal.** The parity diff is empty for every subsystem, and a field
added to a writer without a matching loader entry fails CI.

## 10. Generate the SSE event union and assert exhaustive dispatch

**Effort** M · **Impact** medium · *mine, from the measured defect register*

**Problem.** The repo already solves this problem for REST — `npm run
gen:api` generates `frontend/desktop/src/api/gen/openapi.ts` from
`docs/api/openapi.json`. The **SSE frame union is hand-written in three
places** (a Zod schema, a TS union, and a dispatcher) with no generator and no
exhaustive-switch check. Three register entries are the predictable result:
`budget` is a valid backend reason that the frontend coerces to `undefined` so
the documented amber badge can never render; `recovery` and `subagentFanout`
are accepted by the schema with no dispatcher case; and a PATCH model drops
fields a GET returns.

**Mechanism.** Extend the existing generator to emit the SSE frame union from
the backend's declared event types, and add a build check that every union
member has a dispatcher case — an `assertNever` on the switch default makes a
new backend frame a compile error rather than a silently-dropped event. Apply
the same treatment to the PATCH request models so a field cannot be dropped on
the round trip.

**Success signal.** Adding a backend SSE event without a frontend case fails
`npm run gen:api`'s check; the three known drift entries close.

## 11. A coverage ratchet on the harness core, not just a global floor

**Effort** S · **Impact** medium · *mine, from the measured coverage report*

**Problem.** The project already has `lint:ratchet.mjs` and a 55% global
coverage floor. The global number is currently healthy at 70.34% — but it is
carried by modules that are not the harness. The measured holes sit exactly
where the guarantees live:

| Module | Coverage | What it guards |
|---|---|---|
| `loop/recovery.py` | 62% | the self-correction machinery (items 5, 6) |
| `loop/exec.py` | 63% | tool dispatch (item 7) |
| `managed_tool_policy.py` | 56% | the profile filter **both** wire paths and the executor depend on |
| `providers.py` 1010-1278 | **0%** | a 269-line block with no test at all |
| `mcp_client.py` | 28% | 606 of 837 statements uncovered |
| `web_backends.py` | 17% | the fetch path |

A 70% global average can improve while the harness core rots, because the
average is diluted by 5,000 statements of well-tested plumbing.

**Mechanism.** Extend the existing ratchet to a per-module floor for a named
harness-core set, so `managed_tool_policy.py` or `loop/exec.py` cannot lose
coverage even as the global number holds. Reuse `lint:ratchet.mjs` rather than
adding a new gate.

**Success signal.** The ratchet fails when any harness-core module drops below
its floor, independently of the global number.

---

## Where this roadmap is thin — closed

**Memory recall and durability.** Seven attempts to have an auditor read
`fact_retrieval.py`, `consolidation.py` and the learning pipeline came back
empty, including a two-file minimal prompt, so I read the recall path myself
instead. That is what items 12-14 are, and the first of them is the sharpest
data-loss bug found in the whole scan.

## 12. The `k=5` window is closed before the profile-lane exclusion, so keyword recall silently under-fills

**Effort** S · **Impact** medium · *mine, read first-hand*

**A hypothesis I had to discard first.** I believed the usage boost at
`fact_retrieval.py:344-350` was a dead loop — computed, paid, then thrown away
by a caller that re-sorted by raw BM25. **That is wrong, and the grep killed
it:** `build_memory_block:597-601` calls `retrieve_relevant_facts` directly and
consumes exactly that boosted ranking. The boost reaches the block. Recorded
because the refutation is the useful part — the recall design is tighter than it
looks, and this is the one place in this roadmap where I was wrong.

**What is actually wrong, one layer over.** `build_memory_block` asks for
`k=k` (default 5) and then filters the lane out *after* the window is closed:

```python
facts = [
    f
    for f in retrieve_relevant_facts(query, k=k, prior_turn=prior_turn, scope=scope)
    if str(f.get('key') or '') not in laneKeys
]
```

Profile facts are **deliberately not row-count capped** — the comment at
`:50-53` says a row-count cap "would be a second budget, and it would drop
facts nobody ever named", and the lane is bounded by `_PROFILE_CHAR_CAP = 600`
instead. So a user with a rich profile set holds a large number of
`kind='profile'` facts, any of which can rank into the top 5 on lexical overlap
with the message. Every such fact is **returned by the retriever, charged
against `k`, then discarded here** — so the keyword lane receives
`5 - (profile facts in the top 5)`, and `_fit_lines(facts, budget)` at `:644`
then has less to work with, leaving the 1600-char block under-filled.

The failure is silent and self-reinforcing: the more profile facts a user
accumulates, the thinner their keyword recall becomes, with no signal that
budget was spent on a lane that is *always* injected anyway.

**Mechanism.** Close the window after excluding the lane — over-fetch to
`k + len(laneKeys)` and filter, so the keyword lane always receives its full
`k`. Cheaper and better still: exclude lane keys from the corpus at
`_load_index` time, which also stops the retriever spending a query slot on a
fact that is going to be thrown away.

**Success signal.** Mean facts in the emitted keyword lane holds at `k`
regardless of profile-set size — today it decays as the profile set grows.

## 13. Recall quality is unmeasured — there is no answerable question

**Effort** S · **Impact** high · *mine, read first-hand*

**Problem.** Every knob in the recall path is a tuned constant with no feedback
loop: `k=5` (`:290`), `0.05` boost weight (`:348`), `0.5` prior-turn weight
(`:336`), `_DECAY_HALF_LIFE_DAYS = 30.0` (`:47`), `_MIN_QUERY_CHARS = 8` (`:43`),
`_BLOCK_CHAR_CAP = 1600` (`:38`), `_PROFILE_CHAR_CAP = 600` (`:54`). Recall is
BM25 over a few hundred facts, which is genuinely hard to tune by intuition, and
the two-lane budget is split so that a growth in profile facts silently starves
keyword recall without any signal.

Nothing anywhere records whether a recalled fact was the one the user then
acted on. The store already has `use_count` and `last_used_at` — the raw
material is being written and never used for evaluation.

**Mechanism.** Persist, per turn, the recalled fact keys the model *actually
called back* (`brain_query` hits, a `remember` on an existing key, a skill whose
`trigger` matched) and derive a precision@k against the tail that was injected.
Ship it as a brain router read next to `memory_context_preview`
(`:695`), which is already the model-context preview surface.

**Success signal.** Precision@5 and recall@5 over a rolling window — the
numbers that make every constant above defensible instead of conventional.

## 14. BM25 has no negative signal, so the unused half of the corpus is a permanent candidate

**Effort** M · **Impact** medium · *mine, read first-hand*

**Problem.** In `retrieve_relevant_facts` (`:331-338`) a document whose BM25
score is `<= 0` is discarded **before** the usage boost is ever applied — the
boost at `:348` can only add to an already-positive score. Combined with
`:337 if s <= 0: continue`, that means the entire never-matched part of the
corpus is structurally invisible to the one mechanism designed to learn from
usage. A fact the user is about to need is not reachable by "it has been
useful before" if it has never matched once; a stale-but-once-hot fact decays
out and can never come back.

This is the structural reason a "learning from usage" design can plateau, and
it is invisible in the current output because the fix is invisible too.

**Mechanism.** Take a top-N by `(bm25 + usage_boost)` over the whole corpus with
`N` well above `k`, *then* filter to `s > 0` and slice to `k` — so the boost can
promote a weakly-matching but previously-useful fact, and cannot invent one
from nothing. Note that the `_usage_for` cap at `:262-267` currently assumes a
large candidate set, so the raise is a query-shape change, not a new cache.

**Success signal.** Share of returned facts that had `use_count > 0` rises,
without precision@5 (item 13) falling.

---## Suggested order

1. **#4 gate conformance test** — S effort, and its failure list is the five
   confirmed security/data-loss defects. Highest leverage per line written.
2. **#2 `ok` honours `end_reason`** — S effort, and it makes items 1, 3 and 8
   measurable in the first place.
3. **#9 reload parity** — the one class that touches the install/update promise,
   and it is the only high finding here backed by a whole-repo grep.
4. **#7 exec interceptions** — S effort, and it feeds #2's lesson path.
5. **#1 runaway backstop** — the largest real-world turn-reliability hole.
6. Then #3, #5, #6, #8, #10, #11, #12, #13, #14 as capacity allows.
