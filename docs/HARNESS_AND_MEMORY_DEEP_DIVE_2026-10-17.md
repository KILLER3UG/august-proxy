<!--
  HISTORICAL - a point-in-time deep dive, kept as a record.

  Read on 2026-10-17 against the tree of that day. Much has changed since,
  including the compaction policy it analyses - the five compaction paths were
  reconciled into one call site afterwards. Read the code before working from
  any of it.

  Current guidance lives in the index in DOCUMENTATION.md.
-->


# Harness & Memory — Deep Dive and Improvement Plan

Date: 2026-10-17 · Scope: `backend-py/app` (turn loop, memory, learning loop) · Evidence: code read + read-only query of `data/august_brain.sqlite`

---

## 0. First, a scope correction: this repo does not trade

The brief asked how August trades. It does not, and it never has. There is no broker
client, no order model, no position/portfolio code, and no market-data ingestion in
this tree. `grep -ri "alpaca"` matches only generated prompt-eval fixtures under
`data/.aug/system-prompt/`; "backtest"/"candlestick"/"ohlcv" match only an unrelated
config key and the generated OpenAPI client.

The trading product is a **separate** app. This repo's own plan doc draws the line:
`docs/plans/2026-10-14-harness-ui-claude-parity.md:8` puts **Trade, Journal, Learn**
out of scope because "they belong to August Trading — don't touch, don't add here".
A sibling checkout exists at `C:\Dev\Agentic-Trading`.

So there are two readings of the request, and this document serves both:

1. **If the goal is a harness that learns from its own decisions**, the trading
   vocabulary is still the right metaphor — a decision journal with theses,
   counterfactuals and P&L. That is the feature designed in §6, and it is the single
   highest-leverage thing missing from this codebase.
2. **If the goal is literally trading**, August's job is to be the model/gateway
   layer: the trading app calls `/v1/chat/completions` or `/v1/messages`, and the
   daily journal belongs on the trading side, reading outcomes from the broker. The
   harness half of that story is §6's ledger — it works either way, because a "trade"
   and a "decision" have the same shape: thesis, commitment, cost, resolution.

Everything below is grounded in this tree as it stands today.

---

## 1. What August actually is

A local **AI gateway + agentic workbench**. Three concentric things:

| Layer | What it does | Where |
|---|---|---|
| **Gateway** | OpenAI/Anthropic-compatible `/v1/*`, format translation, provider/model routing, credential scrubbing | `app/routers/proxy.py`, `app/adapters/`, `app/providers/` |
| **Workbench** | A managed tool loop: multi-round turns, tools, compaction, checkpoints, sub-agents | `app/services/workbench/` |
| **Brain** | SQLite: sessions, transcripts, facts, episodes, the turn ledger, the learning jobs | `app/services/memory_store/`, `app/services/*learning*` |

The product is the Tauri desktop app; the FastAPI server is bundled inside it
(`README.md:29-34`). `web-dist/` is a build artifact, not a second product.

---

## 2. The spine: one turn, end to end

Entry is `POST /api/workbench/chat` (`routers/workbench.py:475`), which appends a
`started` seq to the session event log and spawns the stream task. SSE is a separate
`GET /chat/stream` that replays `event_log.subscribe(sessionId, sinceSeq)`
(`routers/workbench.py:561-577`), so a reconnecting tab resumes rather than restarts.

The loop itself is `sendWorkbenchMessageStream` →
`_sendWorkbenchMessageStreamImpl` (`workbench/workbench.py:2207`, `:2331`). One
coroutine, ~3,400 lines, four nested control flows:

```
while True:                      # rounds              (:3296)
  cap / budget / stall / cancel checks
  drain queued user messages
  for chainIndex:                # model re-entry      (:3603)
    flush session barrier         # durable before dispatch
    for retryAttempt:            # transport retry     (:3668)
      provider call → parse
      if tool calls:  guard → approval → checkpoint → execute → world-delta → verify
      if text:        terminal
  reconcile results, append, step snapshot
```

**Exit vocabulary** is fixed at `turn_outcomes.py:76-85` and reconciled by exactly one
function, `_finalTurnEndReason` (`loop/guards.py:122-136`):
`finished | length | cap | stall-stop | budget | error | interrupted | awaiting-input`.

Worth knowing: **nothing bounds a turn by default.** The managed-round cap is 0
(uncapped), the budget ladder is all-off, and the runaway backstop is absent-key = off.
The only default bound is the stall detector, and it resets on argument novelty and on
world delta — so a model that calls a *different* no-path tool every round never trips
it. That is a deliberate, documented trade (`AGENTS.md:106-122`), not an oversight.

> **SUPERSEDED 2026-10-22.** That paragraph was true on the date of this dive, and the
> paragraph it described is what the owner then hit: a model did loop forever, because
> the trade was deliberate and nothing was armed. Two bounds are now armed by default —
> the world-delta backstop at nudge 25 / stop 40, and a 150-round ceiling counted on
> requests actually sent rather than on `toolRound` (which the self-heal legs
> decrement, so a failing model could re-arm it). The "resets on world delta" hole in
> the last sentence was real twice over: a *failed* call used to credit a new path, so
> guessing at filenames was "progress". See `AGENTS.md` "Two bounds are armed by
> default". The budget ladder is still off by default.

Context assembly: the system prompt is built **once** per turn (`:2710`) and only
rebuilt on surface/mode change. Volatile content — the memory block, the profile lane,
relevant skills, the code map, session state — is appended to the **last user message**
(`:3047-3074`) and stripped before persistence (`workbench/durability.py:57-85`). This
is deliberate: a byte-stable prefix is what makes provider prefix caching work.

Compaction has one shared call site, `_compactionCall` (`loop/recovery.py:150`), reached
by five paths (pre-turn, budget rung, reactive overflow, manual button, subagent).

---

## 3. Memory: seven layers, one store, several doors

One SQLite file, `data/august_brain.sqlite` (`memory_conn.py:20-21`), WAL,
`busy_timeout=10000`, `synchronous=FULL`, schema v16.

| Layer | Written by | Enters context | Gate |
|---|---|---|---|
| `kind='profile'` facts | `remember`, UI | **every turn**, always | none — this is the "who you are" lane |
| BM25 recall tail | all fact writers | per-turn `<memory>` block | `memoryAutoInject`, **default off** |
| Boot index (40 facts + 10 KV notes + 5 timeline) | `brain_index_snippet` | system prompt `<intake>`, **frozen per session** | none |
| KV notes (`memory_store`) | UI, machine keys | boot index, `brain_query` | — |
| Project `.aug/memory/*.md` | `remember scope=project` | boot index + tail | `projectMemory` |
| Skills `<relevant_skills>` | skill service | every turn, BM25 over name+desc+trigger | — |
| Transcript / episodes | session writer, miner | history; episodes never direct | — |

Recall is **pure-Python Okapi BM25** over an in-process corpus (`fact_retrieval.py:121-199`),
not FTS — the `facts` table has no FTS index at all (`brain.py:29-38`). Score is
`bm25(query) + 0.5·bm25(prior turn)`, then a confidence prior and a usage boost
(`fact_retrieval.py:427-464`). Facts dropped for budget are **named** in a
`recall partial:` line rather than vanishing — a genuinely good decision.

Write doors are layered and mostly sound: length bounds, a per-turn write cap,
sensitive-topic denylist, a read-before-write gate, exact-duplicate refusal,
secret scanning, and scope checks (`tool_registrations/session_tools.py:340-612`,
`memory_store/rest.py:100-160`).

Consolidation runs on the 24 h job: expire → merge duplicates → supersede
contradictions → propose retirements → LLM review → skill review → sweeps → VACUUM
(`memory_store/consolidation.py:1492-1595`).

---

## 4. The learning loop, as built

Six jobs, one poller, 60 s tick, serial, ledger-backed (`learning_scheduler.py:310-315`):

| Job | Default cadence | What it does |
|---|---|---|
| `introspection` | 6 h | scheduled pass + promotion pass |
| `consolidation` | 24 h | memory hygiene **+ mining + distiller** |
| `refine` | 24 h | gated auto-refine (`autoRefine`) |
| `reviewer` | 6 h | reviewer pass |
| `outcome` | 72 h | `harness_outcome.measure_pending` |
| `review` | 24 h | `skill_distiller.run_review_pass` (**off by default**) |

Due-ness is computed from the last **finished** ledger row, not from a clock, so a
crashed run never blocks the job and cadence survives restarts
(`learning_scheduler.py:131-185`). There is **no wall-clock daily job** — "daily" today
means "24 h rolling".

The chain is: turn → `turn_outcomes` row → episode (mined from failure windows) →
fingerprint → tier-1 rubric → top-slice flagging → tier-2 judge → verdict →
`apply_verdict` → fact or skill proposal → `harness_outcome` pre/post measurement.

---

## 5. Measured state of this install — and the four breaks

Read-only query of `data/august_brain.sqlite`, 2026-10-17:

```
facts                    0      episodes                 45   (all quarantined=1)
memory_store (KV)        1      judge_verdict non-null    0
sessions                54      tier2 unjudged & unquar  0
messages               422      proposals                 0
turn_outcomes           42      harness_outcome            0
learning_job_run       132      failure_fingerprints       3
```

Every learning job reports `status='ok'`, most recently 2026-10-17T06:04. The loop is
running. It has produced **zero durable memory**. This is not a crash — it is a chain
with four clean breaks.

### Break 1 — the ledger has holes exactly where failure lives

Four early returns emit `done` and `return` **before** the post-loop
`turnTelemetry` / `persistAndClose` / `turn_end` block, so they write no
`turn_outcomes` row and no `turn_end` event:

- circuit-mode interception — `workbench.py:2390-2404`
- no provider configured — `workbench.py:2555-2574`
- no API key — `workbench.py:2592-2612`
- session cost ceiling — `workbench.py:3200-3235` (its own comment admits it
  "bypasses the post-loop persist block")

The cost-ceiling branch even has to hand-reset the cancel ContextVar because it exits
outside the turn's `try/finally` (`:3234`). Any daily journal built on this ledger
would be systematically blind to the four ways a turn fails before it starts.

### Break 2 — two failure sensors that disagree

`turn_outcomes.error_families` is written by the loop's steering scan. In this DB it
holds real values (`["not_found"]` on several rows). Meanwhile the **persisted
transcript** — which is what episode mining reads — contains:

```
tool blocks: 322   status: running 161, done 161, error 0
tone:  none 161, null 161
```

Not one error. `_errorReceipts` (`episode_miner.py:172-197`) requires
`tool.status == 'error'`; it therefore returns an empty list for every message, so
`mine_sessions` has no windows to build and no new episode has appeared since
2026-10-05. The two sensors are derived from different sources and neither reconciles
the other.

### Break 3 — the failure verdict itself is a four-string prefix test

`tool_result_failed` is `text.startswith(ERROR_RECEIPT_PREFIXES)`
(`tool_protocol.py:80-86`) over `('Error', '[Validation Error]', '[Blocked]',
'[Tool result missing]')`. A `run_command` that returns `exit code 1`, an HTTP error
body from `web_fetch`, an MCP tool returning a structured error object, a tool that
returns `{"ok": false}` — none of these start with those prefixes, so none is a failure
by this test. The docstring promises "the SSE status the UI renders and the durable
`is_error` the episode miner reads must never disagree"; in practice both are fed by a
heuristic that cannot see most failures.

Compounding it: `normalize_tool_result` **receives `tool_name` and never puts it on the
output dict** (`tool_protocol.py:160-217`), and `messages` has no `name` column. So a
persisted tool row carries no tool identity. `_errorReceipts` builds `f'{name}: {body}'`
(`episode_miner.py:190-192`) — with an empty name, every receipt would read `': …'`,
and the fingerprint's `tool-error:<token>` would be built from the body alone.

### Break 4 — nothing measures the loop's own decisions

`harness_outcome` is a pre/post cohort over **all** episodes: 14 days before
application vs 14 days after, minimum 8 episodes each side, ±0.15 hysteresis
(`harness_outcome.py:103-136`, `:350-383`). There is no control arm, no matching by
fingerprint, no randomization, and the stored `expected` string is never compared to
anything. A quiet fortnight reads as "improved". This is why `harness_outcome` has zero
rows here — nothing has been applied, so nothing is measured.

Meanwhile `data/harness_proposals/shadow_decisions.jsonl` already logs what autonomy
*would* have done when it is off (`harness_rails.py:136-144`). That is a free control
cohort, and nothing reads it.

### The result

45 episodes, every one quarantined by the post-mortem of the prose detector that
invented 41 of 41 (`episode_miner.py:742-758`). Zero judge verdicts. Zero facts. Zero
proposals. The harness is a loop whose sensor is narrower than its own ledger, whose
ledger has holes, and whose only measurement has no control group.

That is the honest diagnosis, and it is also the opportunity: the plumbing is good.
The feedback path is not connected.

---

## 6. The feature: a Daily Decision Ledger

The idea in the brief — a daily pass that logs *possible trades* and uses them to
improve the harness — is right, and it fixes Break 4 directly. It is also what a
trading desk already does: a journal of theses, commitments, counterfactuals and
realized P&L, reviewed on a schedule.

The design principle that matters most: **the mechanical half must not depend on the
model.** If logging requires the model to remember to log, you get the current
situation — a sensor that fires only when something goes wrong in a detectable way.

### 6.1 Schema (migration 053)

```sql
CREATE TABLE decision_ledger (
  id            INTEGER PRIMARY KEY,
  ts            TEXT NOT NULL,
  session_id    TEXT,
  turn_id       INTEGER,          -- turn_outcomes.id, when the turn closed
  kind          TEXT NOT NULL,    -- plan | tool_choice | answer | routing | memory | skill | refusal
  source        TEXT NOT NULL,    -- 'mechanical' | 'model'
  chosen        TEXT NOT NULL,    -- canonical action id
  alternatives  TEXT,             -- JSON [{action, why_rejected}]  ← the counterfactual
  thesis        TEXT,             -- what the decision expects to be true
  observable    TEXT,             -- what would confirm or falsify it
  confidence    REAL,             -- 0..1, model-declared
  horizon_turns INTEGER,          -- resolution window
  due_at        TEXT,
  cost_usd      REAL,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  status        TEXT NOT NULL DEFAULT 'open',   -- open|resolved|expired|unscorable
  outcome       REAL,             -- -1..1; NULL until resolved
  resolved_at   TEXT,
  evidence      TEXT,             -- JSON pointers: message ids, tool ids, turn ids
  model         TEXT,
  provider      TEXT,
  prompt_hash   TEXT
);
CREATE INDEX idx_decision_open ON decision_ledger(status, due_at);
CREATE INDEX idx_decision_turn ON decision_ledger(turn_id);
```

Deliberately **not** in `facts`. A ledger row is evidence about a decision, not a
belief about the world; it must never be injected into a prompt as memory. Lessons
still reach the model the existing way — through the gated `apply_verdict` door.

### 6.2 Two writers

**Mechanical (always on, no model call).** In `turn_close`, alongside the existing
`turnTelemetry` write, insert one row per turn: `kind='answer'`, `chosen=end_reason`,
`alternatives` = the tool names offered but not called, `cost_usd` and tokens from the
usage already computed at `turn_close.py:453-459`, `outcome` = `turn_ok(...)`. This
gives a complete, cheap record of every turn even when nothing interesting happened —
and it is the completeness that Break 1 stole.

**Model-declared (opt-in, cheap).** A `record_decision` tool, capped per turn like
`remember`, for the moments that actually carry a thesis: choosing an approach,
declining a tool, refusing a request, writing a memory, loading a skill. The model
supplies `alternatives`, `confidence` and `observable`. This is the "possible trades"
half — the candidates it considered and did not take.

The model half is worth having but never load-bearing. If it goes unused, the ledger
still has rows.

### 6.3 The daily job

One new `learning_scheduler` job, `journal`, interval knob `journalIntervalHours`
(default 24), which does three passes:

1. **Resolve.** For every `open` row past `due_at`, gather evidence automatically:
   did the turn end `finished`? did the edit get reverted? did the same error family
   recur within the horizon? did the user re-ask the same question? did the skill
   survive consolidation? Each signal is already stored somewhere (§7).
2. **Score.** Write `outcome` ∈ [-1, 1] and a Brier component `(confidence − hit)²`.
   If the evidence is ambiguous, write `unscorable` **with a reason** — never a guess.
   The 41 invented episodes are the standing argument for that rule, and the
   `unscorable` rate is itself the metric that tells you your `observable` specs are
   bad.
3. **Summarize.** One digest row per day: decisions logged, resolved, unscorable,
   mean Brier by model and by `kind`, cost per resolved decision, and the top three
   recurring `alternatives` that were rejected and would have worked.

Cost: one model call per day at most (the digest prose), or zero if the digest is
rendered from aggregates.

### 6.4 What it feeds

| Consumer | Gain |
|---|---|
| `skill_distiller` | a measured outcome instead of a prefix-matched failure window |
| `harness_outcome` | a per-decision cohort with a real control arm (the shadow log) |
| skill credit (`skills_injected`) | the missing join: did injected skills improve resolution? |
| routing | per-model calibration feeds `routing_evidence`, which already has an arena endpoint |
| the Learning panel | "yesterday: 12 decisions, 9 resolved, Brier 0.18, 3 lessons filed" — an answer to "is anything being learned?" |

### 6.5 Guardrails

- Journal writes never touch `facts`; lessons go through the existing proposal door.
- `unscorable` is first-class. A resolver that always produces a verdict is the
  failure mode that produced the quarantine.
- Mechanical rows are cheap; the daily digest is the only model spend, and it is
  bounded by the job cadence.
- Retention: aggregate to daily digests before pruning rows, same pattern as the
  `turn_outcomes` 30-day retention.
- Off by default, like every other rule in this repo that can change behaviour.

---

## 7. Fixes that should land before the journal

The journal is only as good as the ledger under it. In priority order:

**P0 — completeness and correctness of the existing record**

1. **One terminal path.** Route the four early returns (`:2390`, `:2555`, `:2592`,
   `:3200`) through a single `_finishTurn(...)` helper that always writes
   `turn_outcomes`, always emits `turn_end`, and always resets the cancel token.
   Today each one re-implements part of that protocol, and one of them says so in a
   comment.
2. **Carry the tool name.** `normalize_tool_result` already has `tool_name`; put it on
   the output dict. One line, and persisted tool rows stop being anonymous.
3. **One failure verdict.** Replace the prefix allowlist with a structured `ok` flag
   set by the executor (exit code for `run_command`, status for `http`/MCP tools,
   `is_error` passthrough otherwise), and derive both the SSE tone and the durable
   `is_error` from it. Then `_errorReceipts` and `error_families` cannot disagree.
4. **`facts_injected` is already wired — the NULLs are real.** `turn_close.py:329-331`
   builds the list from `session._injected_facts` and passes it to
   `record_turn_outcome`; every row here is NULL because the `facts` table is empty,
   so nothing was ever injected. No code change is needed — the column populates the
   first time a fact rides in a tail. (The first draft of this document claimed the
   column was unwired; that was wrong, and this is the correction.)
5. **Stop caching a failed corpus.** `_load_index` catches every exception and stores
   an **empty** corpus under the scope key (`fact_retrieval.py:193-199`). A transient
   DB error therefore silently disables recall *and* the always-on profile lane until
   the next fact write, with no signal. Cache the failure separately and retry; log at
   warning.
6. **Checkpoint the WAL.** The DB is 154 MB and its WAL is 158 MB — a WAL larger than
   its database means no checkpoint has completed in a long time, usually because a
   reader holds an old snapshot. Worth a `PRAGMA wal_checkpoint(TRUNCATE)` on idle and
   a health read.

**P1 — measurement that can be trusted**

7. Persist verdict labels. `apply_verdict` returns one of ~13 labels, but consolidation
   keeps only `{'verdicts','skipped'}` (`consolidation.py:794`) and the review job
   strips `results` to a `kept` count. "How often was a `memory` verdict dropped as a
   duplicate?" is currently unanswerable, which means the distiller's precision is
   unfalsifiable.
8. **Give the ledgers a shared key.** `turn_outcomes` (23 columns, no money),
   `usage_events` (tokens + cache split, no turn id), `subagent_runs` and
   `episodes` are four separate records of the same turn with **no key between
   them**. Cost is computed at read time by `cost_estimator.price_for_model`, so
   the fix is not another column: add a `turn_id` to `usage_events` and price on
   join. "Which tool wastes the most money per success" then becomes a query
   instead of a guess.
   **Correction from the first draft of this document:** I listed
   `routing_evidence` (224 rows) as a fifth per-turn table. It is not — it is
   the Arena/Debate verdict table, written only by the arena endpoint with
   `source='arena'` (`routers/brain_config.py:470-495`). Worth noting
   separately: it carries `input_tokens`/`output_tokens` columns its only writer
   never populates, while an aggregate reads them (`routers/brain_config.py:537`),
   so that average is computed over NULLs.
   Note also that `friction_events` (migration 003) has a schema, a reader in
   `routers/privacy.py`, and **no writer at all** — 0 rows. It is the clearest
   example of a sensor that was designed and never connected.
9. Make `rounds` honest. Self-heal decrements the round counter in place
   (`workbench.py:4176`, `:4409`), so the number in telemetry is not a count of model
   calls. Count separately.
10. Use the shadow log as a control arm. `shadow_decisions.jsonl` already records what
    autonomy would have done; comparing shadow-applied vs actually-applied cohorts is
    a real counterfactual for free.
11. Revive calibration. `record_precision_run` has no production caller, so
    `amendBodyEnabled` is permanently false and every `amend_body` verdict downgrades
    (`skill_distiller.py:941`, `:1321-1323`). `scripts/harness_eval.py` already exists
    with 14 labelled cases and a rails mode that needs no tokens — make it a nightly
    job with a precision floor.

**P2 — memory hygiene**

12. **Unify dedupe.** Three definitions today: exact-normalized (`remember`), 0.85
    (`consolidation._MERGE_SIMILARITY`), 0.55 (`memory_quality.DEDUPE_SIMILARITY`). One
    policy, one ladder: exact → merge, high → supersede, medium → duplicate-refuse.
13. **Make merge recoverable.** Merge groups by slugged key and **DELETEs** the older
    row (`consolidation.py:600-695`), while retiring a single unused fact requires a
    human proposal. Same store, opposite risk. Snapshot the row into `lifecycle` before
    deleting, or supersede instead of delete.
14. **Fix scope.** `fact_key` is globally UNIQUE, `project:<path>` is documented then
    refused at the write door, and `NULL` scope is treated as global — three answers to
    "whose memory is this row?". Pick one, and make the boot index and recall agree.
15. **Be honest about budgets.** `_fit_lines` always ships the first line even when over
    budget (`fact_retrieval.py:524-526`) and the profile lane deliberately overruns.
    That may be right; the docstring should not claim a hard cap. Better: count
    overruns and put the number in the ledger.

---

## 8. What not to do

- **Do not add a vector store.** `README.md:42-44` states there is none, and three
  modules say so by name. BM25 over a personal fact store is adequate; the failure here
  is not ranking quality, it is that the store is empty.
- **Do not make the journal a second memory store.** It is a ledger of decisions, not
  beliefs. Facts still enter through `apply_verdict` and `save_fact`.
- **Do not let the daily job write skills directly.** Autonomy is off by default for a
  reason; a calibration signal is evidence for a proposal, not a grant.
- **Do not revive the verifier gate** (`AGENTS.md:65-68`) as a way to "score" answers.
  The journal scores *decisions against their own stated observables*, which is a
  narrower and defensible claim.
- **Do not add a second scheduler.** `learning_scheduler` already has the ledger,
  cadence knobs, run-now endpoint and UI surface; the `journal` job belongs there.

---

## 9. Suggested sequence

| Step | Work | Why first |
|---|---|---|
| 1 | P0 items 1–4 | the ledger becomes complete; without this the journal logs holes |
| 2 | P0 items 5–6 | recall stops silently disabling itself; DB stops growing a WAL |
| 3 | Migration 053 + mechanical writer | a complete decision record with zero model spend |
| 4 | `journal` job: resolve + score + digest | the daily loop the brief asked for |
| 5 | `record_decision` tool | the counterfactual half ("possible trades") |
| 6 | P1 items 7–11 | measurement becomes falsifiable, then calibration becomes real |
| 7 | P2 items 12–15 | memory hygiene, now with evidence about which rules pay |

Steps 1–4 are the load-bearing ones. Everything after them is refinement.

---

## 10. Cross-review: a second audit of this repo

A second agent produced an independent review. It is a competent structural map and
its central instinct — *the data exists but nothing closes the loop* — matches §5.
Its **mechanism** claims are weaker, because it read code shape and never read the
database. Five of the memory mechanisms it calls missing already exist.

### 10.1 Where it is right

| Claim | Verdict | Evidence |
|---|---|---|
| Repo identity, `backend-py` / `frontend/desktop` split, static-gate validation, no test suite | Correct | `README.md:66-104`, `AGENTS.md:3-25` |
| `brain_backup.py`: integrity check, retention limit, staged restore at next startup | Correct and precise | `brain_backup.py:32-36,79-93` |
| `memory_store.close()` closes only thread-local connections, so a live restore is impossible | Correct — and it is why restore is staged | `memory_conn.py:345-358` |
| Usage tracking, cost estimator, eight error families, `_stuckRequestEscape` | Correct | `routers/usage.py`, `cost_estimator.py`, `error_families.py`, `loop/recovery.py` |
| Retrieval is BM25 only; `find_similar_facts` is a lexical ratio | Correct | `fact_retrieval.py:202-235,368-467` |
| `project:<path>` writes are rejected; project memory is a separate `.aug/memory` layer | Correct | `rest.py:102-115` |
| Six learning jobs behind one `learning_job_run` ledger | Correct | `learning_scheduler.py:310-315` |
| Consolidation expires / merges / supersedes / vacuums | Correct | `consolidation.py:1492-1595` |
| Skills are SKILL.md procedure docs registered as tools; review is opt-in | Correct | `skill_service.py`, `brain_config_service.py:248` |
| The `usage_events` table, `refine_store/`, `checkpoints/`, `sections/learning/` | Correct — and it caught a table I had missed | see §10.4 |

### 10.2 Where it is wrong

| Claim | Reality |
|---|---|
| "Memory access depends on `brain_query` tool calls; there is a memory gate" | Auto-injection is **built**: `build_memory_block` runs every turn and `kind='profile'` facts always ride in. It is gated by `memoryAutoInject`, whose default is **False** (`brain_config_service.py:220`). This is a default, not a missing mechanism. |
| "No automatic expiration / no pruning" | `_expire_facts` **hard-DELETEs** expired rows on the 24 h job (`consolidation.py:110-132`), and retirement proposals cover never-used rows. The real defect is the opposite of what it claims: merge deletes without a proposal while retirement needs one. |
| "No feedback loop for memory usage; no signal whether memory is used" | `use_count` / `last_used_at` / `touch_fact_usage` feed a 0.05 usage boost, and `recall_quality` computes precision@k (`fact_retrieval.py:891-965`). The signal exists; the function's own docstring admits it was never *measured*. That supports its conclusion and refutes its evidence. |
| "`brain_query` is not aware of current message content" | `retrieve_relevant_facts` takes `prior_turn` and adds `0.5 × BM25(prior)` (`fact_retrieval.py:420-431`). Only the tool path omits it; the automatic tail passes it. |
| "No temporal awareness; the model cannot know what was learned today" | The boot index is `ORDER BY updated_at DESC LIMIT 40` plus the last 5 `episodic_timeline` rows (`brain.py:748-750`). Recent memory is exactly what rides in at session start. True only mid-session. |
| "No cross-entry consistency or dedupe validation after writes" | There are **three** dedupe thresholds: exact-normalized at the write door, 0.85 in consolidation, 0.55 in the distiller. The defect is inconsistency, not absence. |
| "Profile lane is constrained by `budget_chars` (1600)" | 1600 is the whole block; the profile lane's own cap is 600 (`fact_retrieval.py:38,54`). |
| "`data/.aug/` is the memory layer (`memory.md`, `MEMORY-INDEX.md`)" | In this install `data/.aug/` contains only `system-prompt`. Project memory lives in `<workspace>/.aug/memory`, not the data dir. |
| "Automatic tool selection is missing" | Progressive disclosure already ships: `assembleToolDefs` BM25-ranks deferrable tools, preloads the top slice, and exposes `tool_search` / `tool_describe` / `tool_call` (`tools/model_tools.py:116-182`). |
| "Model calls tools in the desktop; results return via API" | Inverted. The model call and the tool loop run server-side in `workbench.py`; the desktop is an SSE client. |

### 10.3 What it missed entirely

It never queried `august_brain.sqlite`, so none of §5 appears in it: `facts`=0, 45
episodes all quarantined, zero judge verdicts, zero proposals, zero `harness_outcome`
— and the four breaks that cause that. Its headline recommendation is therefore to
improve **ranking** for an **empty index**, while the mechanism that would fill the
index (the episode sensor) is blind. That is the difference between "the memory
algorithm is weak" and "the memory is empty because nothing ever writes to it".

It also recommends adding **embeddings** as the P1 fix. That is a direct contract
violation: `README.md:42-44` states there is no vector store and instructs anyone
adding one to delete the three modules that document the decision
(`fact_retrieval.py`, `tools/retrieval.py`, `text_similarity.py`). A recommendation
that starts by deleting the repo's stated architecture needs a much stronger
argument than "BM25 is lexical" — especially when the corpus is empty.

### 10.4 What it got right that I had underweighted

`usage_events` is real and populated (68 rows, tokens + cache split + model +
session). That changes one of my own recommendations: the harness does not lack cost
data, it lacks a **join key**. `turn_outcomes`, `usage_events`, `subagent_runs` and
`episodes` are four records of the same turn with no key between them;
`friction_events` is a fifth that has a schema, a reader in
`routers/privacy.py`, and **no writer**. §7 item 8 is corrected accordingly: add
`turn_id` and price on join, do not add another column.

A correction to the correction: the first draft of §7 item 8 also counted
`routing_evidence` (224 rows) as a per-turn table. It is not — it is the
Arena/Debate verdict table, written only by the arena endpoint
(`routers/brain_config.py:470-495`). Four tables, not five.

This also sharpens the case for §6. The decision ledger should not be a sixth silo.
It should **be** the key: one row per decision, carrying `turn_id`, so the existing
ledgers become joinable rather than replaceable.

### 10.5 Its recommendations, judged

| # | Recommendation | Verdict |
|---|---|---|
| S1 | Semantic/embedding retrieval | **Reject as P1.** Violates `README.md:42-44`; optimizes an empty corpus. Revisit only after facts > 0 and `recall_quality` is actually measured. |
| S2 | Task/domain classification of memory | **Marginal.** `kind`, `category`, `scope` and `session_topics` already exist; the missing piece is one coherent policy, not a new axis. |
| S3 | Auto-inject memory, remove the gate | **Already built.** It is a one-line default flip (`memoryAutoInject`), with a real trade-off: the per-turn tail costs prefix-cache stability. |
| S4 | Per-turn memory pruning | **Reject.** Write amplification on a 154 MB WAL database every turn; the daily consolidation already owns this. |
| S5 | Write validation for relevance/consistency | **Adopt the kernel** — collapse three dedupe thresholds into one ladder (§7 item 12). "Relevance at write time" is not decidable cheaply. |
| S6–S8 | Usage → learning linkage; effectiveness metrics | **Adopt the intent, fix the join.** `turn_outcomes` is the right hub, not `usage_events` alone. |
| S9 | Derive improvement suggestions from error classes | **Adopt, but after the sensor.** `maybe_promote_failure_lesson` already exists and is starved by the four-prefix test (§5, break 3). |
| S10 | Rule-based retry by error family | **Mostly exists** — eight-family steering already fires once per family. Low value. |
| S11–S13 | Unified analysis layer over event logs, usage, skills | **Adopt as "one key", not a new pipeline.** A second analysis engine over five unjoined tables reproduces the problem. |
| S15 | Multi-version memory persistence | **Reject.** WAL + integrity-checked backups + staged restore already cover it; the gap is checkpointing, not versioning. |
| S16 | Automatic tool selection by task | **Stale.** Ships today (progressive disclosure + `tool_search`). |
| S17 | Dynamic budget adjustment | **Defer.** The opt-in ladder exists; adapting it from usage data is speculative until the ledger is trustworthy. |

### 10.6 Merged priority

The two reviews agree on the destination and disagree on the starting point. The
merged order is:

1. **Complete the ledger** (§7 P0 1–4) — nothing downstream can be measured otherwise.
2. **Connect the sensor** (§7 P0 3, the structured failure verdict) — this is what
   makes episodes exist at all, and it is the precondition for every memory
   recommendation in either review.
3. **One join key** across the five existing ledgers, then the decision journal (§6).
4. **Memory hygiene** (§7 P2) — dedupe ladder, recoverable merge, scope integrity.
5. **Only then** argue about ranking. If `recall_quality` measured over a non-empty
   corpus says BM25 is the bottleneck, that is the moment to discuss semantic recall
   — with a number, not an intuition.

---

## 11. Implementation status (2026-10-17)

This section records what was actually built from §6–§7, so the plan and the tree
do not drift. Everything below is in the working tree, verified by the static
gates plus scripted smoke runs against a throwaway database.

### Shipped

| Item | Where | What changed |
|---|---|---|
| **One terminal path** (§7 P0 1) | `workbench.py` `_recordPreLoopExit` | The four pre-loop exits (circuit, no provider, no API key, cost ceiling) now write a `turn_outcomes` row and emit `turn_end` before `done`. Verified: a synthetic no-provider exit lands `end_reason=error, ok=0, error_class=auth`. |
| **Tool identity** (§7 P0 2) | `tool_protocol.normalize_tool_result` | `tool_name` — already a parameter, previously used only for the synthetic label — is written onto the result dict, so the durable transcript can label a card and mining can build `tool-error:<name>` fingerprints. Omitted when unknown (an empty `name` is invalid on both wire formats). |
| **One failure verdict** (§7 P0 3) | `tool_protocol.tool_result_failed` | Beyond the four receipt prefixes, it now recognises `Exit code: <nonzero>` (the shape `code_runner` actually emits) and JSON receipts with `ok`/`success: false`, `isError: true`, or a non-empty `error`. `receipt_tone` maps both new shapes to `failure`, so the SSE status and the durable `is_error` still come from one predicate. 9/9 behaviour cases pass. |
| **Honest rounds** (§7 P1 9) | `workbench.py`, `turn_close.py` | `modelRounds` counts loop iterations; `rounds` in `turn_outcomes` and `turn_end` now reports it. `toolRound` keeps its meaning for the cap and stall detector (self-heal still decrements it). |
| **Join key** (§7 P1 8) | migration `053`, `record_usage`, `turn_close` | `usage_events.turn_id`; `record_turn_outcome` returns its row id; the turn close passes it to `record_usage`. Falls back to a 7-column insert if 053 has not applied. |
| **Decision ledger** (§6) | migration `053`, `services/decision_ledger.py` | `decision_ledger` table + mechanical writer (one row per turn, no model call, priced with the same estimator the Usage page uses) + model writer + resolver + `stats`/`digest`/`list_decisions`. |
| **Daily journal job** (§6.3) | `learning_scheduler._journal_job` | Registered as `journal`, cadence `journalIntervalHours` (default 24). Resolves due rows, writes a digest, reports per-model Brier and unscorable rate. No model call. |
| **`record_decision` tool** (§6.2) | `tool_registrations/decision_tools.py` | Captures kind, chosen action, rejected alternatives, thesis, confidence, horizon. Not in `AUGUST_CORE_TOOLS`, so progressive disclosure can defer it. Errors use the `Error:` contract. |
| **API surface** | `routers/brain_config.py` | `GET /api/brain/decisions` (digest + stats + rows) and `POST /api/brain/decisions/resolve`. OpenAPI and `docs/API_INDEX.md` regenerated. |
| **Recall survives a bad moment** (§7 P0 5) | `fact_retrieval._load_index` | A failed corpus build is no longer cached as "no memory". It degrades that one call and logs a warning; the next call rebuilds. |
| **Recoverable merge** (§7 P2 13) | `consolidation._merge_duplicates` | The absorbed row is written to `lifecycle` (`event_type='fact_merged'`, full key/value/scope/kind/title + survivor) immediately before the DELETE. Verified on a two-row merge. |
| **Dedupe ladder** (§7 P2 12) | `memory_quality.py` | One ladder with three named doors (`EXACT_SIMILARITY` 1.0, `MERGE_SIMILARITY` 0.85, `DUPLICATE_SIMILARITY` 0.55); `consolidation` imports its threshold instead of defining its own, and `DEDUPE_SIMILARITY` remains as the alias the distiller and turn-outcome doors import. **Values are unchanged** — each was tuned per door and nothing has measured them. What changed is that they now live in one place, so the next tuning pass sees all three. |
| **Verdict labels persisted** (§7 P1 7) | migration `054`, `skill_distiller.py` | `episodes.applied_label` stores what the door DID with a verdict, written by a wrapper around `apply_verdict`'s existing label return. `verdict_label_stats(days)` counts them, and the review job reports the counts next to `kept` — so "how often is a `memory` verdict dropped as a duplicate?" stops being unanswerable. Verified: a `none` verdict round-trips into the count. |
| **WAL checkpoint** (§7 P0 6) | `memory_conn.checkpoint_wal` + the scheduler tick | `PRAGMA wal_checkpoint(TRUNCATE)` on a short-lived connection, rate-limited to one attempt per 6 h via `internal_state`, invoked from the existing 60 s scheduler tick. TRUNCATE returns BUSY (harmlessly) when a reader is mid-read. Verified on a fresh DB: a 3.19 MB WAL truncates to 0. |

### Deferred, with reasons

| Item | Why not now |
|---|---|
| **Scope integrity** (§7 P2 14) | `fact_key` is globally UNIQUE; per-scope keys need a table rebuild (SQLite cannot drop a unique constraint in place). A rebuild of the memory table is not a change to land alongside a feature. |
| **Learning-panel UI** | The endpoint and the job ledger row are in place; the React surface is a separate change and cannot be verified without running the app. |
| **`routing_evidence` token average over NULLs** | Pre-existing, not part of this plan and found on the way: that table carries `input_tokens`/`output_tokens` its only writer never populates, while an aggregate reads them. Either wire the arena writer or drop the aggregate — a decision about the arena, not the journal. |

### Verification performed

No test suite exists in this repo (removed 2026-10-17), so verification was:

* `ruff check app/` — clean; `mypy app/` — clean (340 files).
* `check:api`, `check:api-index`, `check:docs`, `check:doc-links`, `check:naming`,
  `check:sse`, `check:version`, `check:design`, `lint:ratchet` — all pass. (The two
  gates that run eslint/node over the tree take minutes, not seconds.)
* Scripted smoke on a throwaway `AUGUST_BRAIN_SQLITE_FILE`: migrations apply from
  scratch (54 versions); `decision_ledger` present with `usage_events.turn_id` and
  `episodes.applied_label`; a finished turn resolves `outcome=1.0`; an unverifiable
  observable resolves `unscorable` with `reason=unsupported-observable`; a decision
  with no turn resolves `unscorable` with `reason=no-turn-row`; Brier 0.01 for a
  0.9-confidence correct call; `record_decision` normalises string and dict
  alternatives and rejects a bad kind; the merge snapshot round-trips; the four
  pre-loop exits write a row; an `action='none'` verdict round-trips into
  `verdict_label_stats`; a 3.19 MB WAL truncates to 0 bytes; the dedupe ladder's
  three constants resolve to their documented values and the merge still fires.

### What is still unmeasured

The ledger is empty in this install (`facts=0`), so the first real numbers —
`unscorableRate`, Brier per model — will only exist after some turns run with the
new code. That is the point: the journal's first job is to make its own absence
visible, and `digest.logged` is the number to watch on the next launch.
