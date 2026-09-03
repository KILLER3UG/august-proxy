# Part 18 — Harness Performance & Smoothness

**Status:** IMPLEMENTED 2026-08-31 — all remaining items landed test-first
(P1.2/P1.3/P2.1/P2.2/P2.4 in `07d87d75`; P3.1 early-dispatch telemetry,
P3.2 warm interpreter, P4.1 off-load gates, P4.2 debounced persistence in
the working tree). Originally written 2026-08-30 from a performance lens over
two deep-scanned external harnesses (see §7 provenance record) plus a
hot-path audit of the August working tree. Citation verification against the
post-Part-16 tree: §8 — P1.1 and P1.4 were ALREADY SHIPPED (cut), P2.1/P2.4
re-scoped as noted, P3.3 cited a wrong identifier (event is `retrying`).
See §9 for the implementation changelog and §8 for the citation record.
**Series:** Part 16 = self-improvement engine (sibling plan). This plan is
the speed/smoothness twin: every item here either cuts tokens (→ TTFT and
cost), cuts wall-clock work per turn, or keeps background work off the hot
path. Non-goal: micro-optimizations with no user-observable effect.

---

## 1. The performance model

User-perceived chat speed = **TTFT** (provider prefix-cache hit? silent
retries? prompt size?) + **turn length** (tool-round count × round cost) +
**UI smoothness** (transcript rendering, streaming). Both external
harnesses converge on the same three levers, in priority order:

1. **Prompt-cache stability** — the provider re-reading N% of a cold
   prefix dominates everything else. A 30k-token prompt re-read at 0% hit
   can add tens of seconds before the first token; at 100% hit it's ~free.
2. **Context size discipline** — every token in the request is TTFT and
   cost. Bounded output, bounded digests, aggressive-but-safe compaction.
3. **Background work never runs inside a turn** — mining, judging,
   consolidation, introspection are all post-hoc on scheduled cadences.

August already landed the big Part 17 Phase L pieces (per-turn TTFT +
cache-token telemetry, `_frozen_mem_index`, visible backoff notice). This
plan closes the remaining measured gaps.

## 2. Phase P1 — Prompt-cache stability (highest leverage)

**P1.1 Session-block split (the known remaining root cause).**
The `<session>` block embeds session id/title/plan JSON near the TOP of
the system block (workbench.py system-prompt build), so (a) brand-new
sessions never hit the system-block cache and (b) any title/state change
re-reads 100% of it. Fix: restructure so the byte-stable prefix (persona,
tools, capabilities, memory policy, frozen memory index) never contains a
per-turn-volatile field; the `<session>` identity block moves to the
**tail** of the system block (or into the first user message), below the
last stable breakpoint. Acceptance: a title change busts ≤ the tail block,
measured by the cache-sentinel test.

**P1.2 Cache-sentinel test suite (extend `test_prompt_cache_stability.py`).**
Property: for a fixed session, the system prefix is byte-identical across
N synthetic turns under: title change, plan update, phase/step advance,
memory nudge, skill catalogue change (P1.4), tool-profile downgrade.
Each scenario asserts the provider-visible prefix hash is unchanged up to
the declared breakpoint. This turns "cache feels slow" bug reports into a
red test instead of an investigation.

**P1.3 Serialization stability audit.**
Prefix caching requires byte-identical serialization. Audit every JSON
blob embedded in the prompt path (tool definitions, tool results, memory
index, session state) for dict-ordering stability — fixed construction
order or `sort_keys`; never `dict(**kwargs)` from request data. One
unstable key order silently re-reads the whole tail.

**P1.4 Catalogue memo staleness fix (in-place SKILL.md edits).**
`catalogue()` memoizes on root-dir mtime only (skill_service.py:43-65,
:341-365) — an in-place SKILL.md edit leaves a stale skills index until an
unrelated mutation. This is BOTH a correctness bug (stale index in every
prompt) and a cache hazard. Fix: fold per-skill SKILL.md mtimes (stat-only,
no parse) into the memo key. (Part 16 Phase D step 1 — same fix serves
both plans; implement once.)

## 3. Phase P2 — Context-size discipline

**P2.1 Skills-index byte budget with deterministic stop.**
The skills catalogue grows unboundedly with learned skills; every entry is
prompt bytes on every turn. Adopt a fixed byte budget (start 24 KB) for the
whole `<capabilities>` skills index: pack alphabetically, stop at the
first entry that overflows (deterministic, no silent mid-entry cuts), and
surface an issue when overflow first happens (same discipline as the
external pattern in §7). Earns the moment the catalogue passes the budget;
costs nothing before.

**P2.2 Compaction: handoff format + verbatim-intent replay.**
August auto-compacts at high pressure. Two upgrades from the Zed pattern:
(a) the compaction prompt asks for a fixed handoff shape — Goal / State /
Context / Next / Pitfalls — "so the next agent can act without re-asking
the user" (fewer post-compaction recovery rounds = fewer turns = faster);
(b) after compaction, the most recent verbatim user messages are replayed
on top of the summary under a byte budget (~8-16 KB), because the summary
inevitably loses nuance the user already paid for. Never cut at tool
results (a result stays with its call).

**P2.3 Head+tail tool-output truncation — ALREADY SHIPPED.**
`_truncateToolOutput` (workbench.py:267) keeps head+tail with an explicit
omitted-bytes marker, and per-model `maxToolResultChars` caps apply. No
work — recorded so the audit trail shows the item was checked, plus one
follow-up: verify the `[N chars omitted]` marker text is itself
cache-stable (constant string, not per-call).

**P2.4 Token-budget accounting excludes cacheRead.**
Wherever budgets count tokens (auto-compact threshold, future autonomous
budgets), count `input + output + cacheWrite` and EXCLUDE `cacheRead` —
long cached contexts must not exhaust a budget early (verifier/eval loops
with 100k+ cached tokens would otherwise trip the budget on every pass).

## 4. Phase P3 — Loop latency

**P3.1 Measure-then-decide: early tool dispatch.**
Both external harnesses dispatch a tool the moment its arguments arrive,
before the stream ends. August executes after the stream completes. Gain
per turn ≈ the trailing stream tail after the last tool call (often small,
occasionally large when a model narrates after calling). ACTION: add one
telemetry field (`toolArgsReadyToStreamEndMs`, rides the Phase L ttft
pipeline), ship no behavior change, decide from data in a follow-up.
Honest no-op until measured.

**P3.2 Warm interpreter for `code` mode.**
`run_command`'s python path snapshots/restores per call (code_runner.py
has per-variable caps at 384-389). Ensure the interpreter process is
REUSED across calls in a session (spawn-once, snapshot between calls)
rather than cold-started per call; the snapshot caps already bound memory.
Acceptance: second `code` call in a session shows no interpreter boot in
its duration breakdown.

**P3.3 Retry visibility — ALREADY SHIPPED.**
Bounded exponential backoff with Retry-After support
(providers/clients/base.py:92-136) + the visible `retryingBackoff` SSE
notice (types/workbench.ts) landed in Part 17. Recorded as verified.

## 5. Phase P4 — Background work stays background

**P4.1 Off-load guarantee for the learning loop.**
Part 16's engine is post-hoc by design (its §1). Reaffirm as a hard rule
with a test: no mining/scoring/judging/consolidation code runs inside a
live turn or inside `_executeTool` — grep-gated test that the workbench
loop module never imports the miner/distiller/consolidation modules.

**P4.2 Debounced persistence for high-frequency writes.**
Turn telemetry (turn_outcomes), lifecycle rows, and internal_state writes
are per-turn SQLite commits on the turn thread. Batch writes that are not
read-back within the turn into a single debounced commit (≤2s window)
where correctness allows — measured via the existing usage endpoints, not
speculated.

## 6. Validation

- New: `test_prompt_cache_stability.py` extensions (P1.2 scenarios),
  `test_skills_index_budget.py` (P2.1 deterministic stop + issue surfacing),
  `test_compaction_format.py` (P2.2 handoff shape + verbatim replay +
  never-cut-at-tool-results), `test_offload_guarantee.py` (P4.1 grep gate),
  warm-interpreter duration test (P3.2).
- Existing: full suite + `test_prompt_cache_stability.py` must stay green;
  ruff + mypy clean; frontend untouched except (optional) the P2.1 issue
  surfacing in the Learning/settings header.
- Measurement gate: before/after on a scripted 10-turn session comparing
  TTFT p50/p95 and total tokens (Phase L telemetry fields) — the plan
  claims no number it hasn't measured.

**Measurement record (2026-08-31, gate executed).** Two live backends, each
with an isolated `AUGUST_DATA_DIR` and the real providers.json, drove the
same scripted 10-turn session (alternating plain-chat and `update_state`
tool turns; model `stepfun/step-3.7-flash:free` on KiloCode, streaming):
"after" = the Part 18 working tree; "before" = commit `73c0e898`
(pre-Part-18; Phase L telemetry only) booted from a throwaway worktree.
Numbers from the `turn_outcomes` table (10 rows per run):

| metric | before (73c0e898) | after (Part 18 tree) |
|---|---|---|
| TTFT p50 / p95 | 10 658 / 45 570 ms | 33 470 / 47 784 ms |
| duration p50 / p95 | 15 487 / 47 716 ms | 41 818 / 49 920 ms |
| cache hit / miss tokens | 208 768 / 209 794 | 176 512 / 240 968 |
| cache hit rate | 0.499 | 0.423 |
| `toolArgsReadyToStreamEndMs` | (field absent) | p50 15.5 ms, max 21 ms, 2/10 turns |

Read honestly: **the upstream free-tier model dominates these numbers.**
Within-run TTFT swung 8–70 s in the same session, so the before/after
deltas are NOT attributable to Part 18 — they are the noise floor of a
free gateway whose queueing varies by the minute. What the gate does
establish:

* The Phase L + P3.1 telemetry pipeline works end-to-end live: every turn
  wrote a `turn_outcomes` row (ttft, cache split, tool-tail) and emitted a
  `turnTelemetry` SSE event.
* The P3.1 tool-tail on this gateway is **~0–21 ms** (p50 15.5 ms): after
  the last tool-call arguments arrive, the tooled round's stream ends
  almost immediately. Early dispatch (P3.1's candidate optimization) has
  essentially nothing to save against THIS upstream — measured, so
  measure-then-decide is decided: P3.1 stays telemetry-only. Note the tail
  measures the TOOLED round's stream end, not tool→done — the 9–13 s
  tool-to-done gaps in the event log are the final text round streaming
  after the tool round (the toolCall SSE event is emitted at tool
  execution, not at args arrival, by design).
* `ttft_ms` can exceed `duration_ms` on turn 1 (51.8 s vs 49.9 s observed):
  the trace t0 anchors at `start_trace` (workbench.py:2335, before the
  impl) while `duration_ms` anchors at `_turnStartMs` (workbench.py:3014,
  inside the impl) — ttft legitimately includes pre-impl setup.
* `AUGUST_PERF_TIMING=1` is REQUIRED for real ttft values — without it
  `mark_ttft` is a no-op (perf_timing.py:73) and every row records
  `ttft_ms=0` (found live: three zero-ttft runs before the flag was set
  on the measurement backend). The desktop app does not set this env by
  default, so production rows will show `ttft_ms=0` unless it is set.
  Follow-up worth a ruling (force the trace on for telemetry, or accept
  zeros).

  **Ruled + implemented (2026-09-01):** ttft now records WITHOUT the env
  var. `mark_ttft` (perf_timing.py) is ungated the same way
  `mark_tool_args_ready` already is — both feed persisted turn telemetry
  (`turn_outcomes.ttft_ms` + the `turnTelemetry` SSE event), which must
  record in production; spans/ring/logging stay behind `AUGUST_PERF_TIMING`
  (forcing spans on every production turn would drag ring churn + an INFO
  log line per turn). Guarded by `tests/test_ttft_always_on.py` (unit
  contract + live turn without the env). The gateway's stale
  force=True-comment (session_bridge.py) was corrected in passing — its
  `force=False` code was already the right behavior.

## 7. Provenance record area (external names)

> Record area per the plans directive. Every adopted technique above is
> restated natively; this section records where the idea was observed.

* **zed** (zed-industries/zed): prompt-assembly discipline — rebuild the
  system prompt every request but swap only when the rendered context
  differs (crates/agent/src/agent.rs `maintain_project_context`,
  ProjectContext derives Eq), cache breakpoint on the LAST history message
  (thread.rs:4347), 50KB skill-catalog byte budget with deterministic
  stop-packing (`MAX_SKILL_DESCRIPTIONS_SIZE`), compaction handoff prompt
  (Goal/State/Context/Next/Pitfalls) + recent-verbatim-user-messages
  replay under an 80KB budget (`COMPACTION_RETAINED_USER_MESSAGES_BYTE_BUDGET`),
  early tool dispatch on partial streamed args (`ToolInput` channel),
  zstd-compressed single-blob thread persistence.
* **prime-agent** (PrimeIntellect-ai/prime-agent): head+tail bounded output
  with explicit `[N bytes dropped]` markers (512KiB head / 1.5MiB tail),
  bounded digests everywhere (memory overview 120-char entries, bounded
  stderr tails), plan/apply separation keeping refinement off the hot path,
  per-worker transcript caches above 4MiB, attachment-local backpressure.

---

## 8. Citation verification (2026-08-30, against the post-af51762e tree)

Line references re-checked against the working tree after Part 16 landed.
No implementation performed — this section only records what holds.

**VERIFIED (claim holds as written):**

* **P1.2** — `tests/test_prompt_cache_stability.py` exists (4 tests,
  shipped in df42f1a9); the scenario extensions are genuinely new work.
* **P2.3** — `_truncateToolOutput` at workbench.py:267 exactly as cited;
  head+tail + per-model caps live. **Follow-up finding:** the marker is
  `f'[... {omitted} characters omitted ...]'` (workbench.py:304) — the
  template is constant but the embedded count is per-call, so the marker
  is NOT a byte-stable string. It rides in tool results (message tail),
  not the system prefix, so cache impact is limited to re-sent history.
* **P3.2** — premise true: code mode spawns an isolated `python -I`
  subprocess per call (code_runner.py:233 comment); persistence is
  snapshot/restore (code_runner.py:158-229), not a warm process. Line
  drift: the caps are the `_SNAPSHOT_TAIL.format(...)` call at
  code_runner.py:388 with constants defined at kernel.py:39
  (`PER_VARIABLE_CAP_BYTES = 16 MiB`) — the cited "384-389" covers the
  use site, not the definition.
* **P3.3** — shipped, but the identifier is wrong: the SSE event is
  `{'type': 'retrying'}` (workbench.py:3112, :3263, :3291) handled by
  `onRetrying` (types/workbench.ts:426). `retryingBackoff` exists nowhere
  in frontend or backend. Backoff + Retry-After at base.py:92-136 as
  cited (`parseRetryAfterMs` :92, `getRetryDelayMs` :119).
* **§1 Phase-L premise** — ttft_ms + cache_hit/miss columns wired
  (turn_outcomes.py:84-109; recorded at workbench.py:4571);
  `_frozen_mem_index` at workbench/sessions.py:130. Caveat: never yet
  observed with LIVE data (schema v12 columns unexercised since the
  landing — see the TTFT-measurement task).

**STALE — already shipped; CUT from this plan's scope:**

* **P1.1 session-block split** — done by Part 17 Phase L before this
  draft was written. workbench.py:1113-1127 documents it: id/title/plan/
  state moved OUT of `<session>` into the per-turn `<session_state>` tail
  on the last user message; only byte-stable fields (guardMode,
  agentMode, circuit hint) remain (workbench.py:1129-1145). The
  acceptance property (title change busts ≤ tail) is already the design.
* **P1.4 catalogue memo** — shipped in af51762e (Part 16 Phase D step 1):
  `_skillMdMarks` (skill_service.py:78) folds per-skill SKILL.md mtimes
  into the memo key at :423. The plan's own note anticipated this
  ("implement once") — it was implemented; cited lines :43-65/:341-365
  are pre-drift positions.

**PREMISE PARTIALLY STALE — re-scope before any ruling:**

* **P2.1 skills-index byte budget** — the main-agent path no longer
  embeds the descriptive catalogue: `build_capabilities_block` renders a
  NAME-ONLY index for the main agent (`compact_skills=True`,
  capabilities_prompt.py:408-434) and per-turn descriptions ride in
  `<relevant_skills>` under a 600-char cap
  (`_RELEVANT_SKILLS_CHAR_CAP`, :453, enforced :524-531). `load_bodies`
  caps at 24000 (skill_service.py:361). The unbounded surface that
  remains is the SUBAGENT descriptive catalogue
  (`format_skills_by_category`) — the budget idea survives only there.
* **P2.4 cacheRead exclusion** — vacuous against current code: the
  auto-compact budget (`token_budget.computeBudget`) estimates tokens
  from the message TEXT (estimateTokens over flattened messages), never
  from provider usage, so no budget currently counts cacheRead tokens at
  all. The exclusion rule is only meaningful if a usage-based budget is
  introduced; recorded as a design constraint, not a task.

**OPEN WORK (no citations to check):** P1.3 serialization audit, P2.2
compaction handoff format, P3.1 early-dispatch telemetry field, P4.1
grep-gate test (note: the workbench loop module does not import the
miner/distiller — the real off-loop violation is Part 16 §12 F-4, the
curator ROUTER running mining inline on the event loop; a P4.1 test
should cover router doors too), P4.2 debounced persistence.

**Net:** of the plan's 12 items, 2 are already shipped (P1.1, P1.4), 2
need re-scoping (P2.1, P2.4), 1 has a wrong identifier (P3.3 — shipped
regardless), and the rest are genuine open work. ~~Awaiting user ruling;
nothing implemented.~~ — superseded by §9 below (all remaining items
landed 2026-08-31).

---

## 9. Implementation changelog (2026-08-31) — remaining items landed test-first

Validation for the whole batch: ruff clean, mypy clean (306 files), the 18
touched suites = 219 tests green (cache-sentinel, skills budget, compaction,
serialization, token budget, prune-then-compact, warm kernel, early
dispatch, off-load gates, deferred writes, kernel T13, code runner x2,
async subprocess, sandbox policy + hardline, workbench tool loop, shadow
git).

* **P1.2/P1.3/P2.1/P2.2/P2.4** — landed in commit `07d87d75` (cache-sentinel
  scenario extensions, sort_keys serialization audit, 24 KiB skills-index
  budget with deterministic stop-packing, compaction handoff schema
  Goal/State/Context/Next/Pitfalls + verbatim user replay, budget
  cacheRead-exclusion guard). P2.1's overflow issue is now also PERSISTED
  (`skillsIndexOverflow` internal_state, written on first overflow and on
  shape changes only) and surfaced in the curator report / Learning header.
* **P3.1 early-dispatch telemetry** — measure-then-decide, no behavior
  change. `mark_tool_args_ready` (perf_timing) fires at the provider parse
  sites (OpenAI argument decode in providers.py; Anthropic
  content_block_stop in stream_translate.py); the turn loop snapshots the
  trailing stream tail after each model call (`_toolArgsTailMs`,
  workbench.py) — the value surfaced is the last tooled round. Persisted as
  `turn_outcomes.tool_args_ready_to_stream_end_ms` (migration
  `030_early_dispatch_telemetry.sql`, schema v13, warm-path ensure_column)
  and emitted as `toolArgsReadyToStreamEndMs` in the turnTelemetry SSE
  event. 0 = no tool call this turn. Tests:
  `tests/test_early_dispatch_telemetry.py` (10) — primitives, column,
  SSE shape, plus a scripted-stream end-to-end through the real loop
  asserting SSE == persisted row, and text-only turns staying 0.
* **P3.2 warm interpreter for code mode** — `kernel.py` gains a
  per-(workspace, session) persistent `python -I` child (WarmKernel)
  serving cells over stdin (line-delimited JSON, one result line per
  cell). Each cell executes the SAME runner source the cold path writes
  to disk (`build_runner_source`: embedded hardline guard,
  workspace-bound tool API, sandbox-mode flags, bridge client, restore /
  snapshot pickle tails) in a fresh namespace — the security posture is
  identical BY CONSTRUCTION, not re-implemented. Parent-side parity:
  `preflight_warm_cell` runs the same soft preflight the cold boot
  command would get, per cell, against the session's CURRENT sandbox
  mode (read-only refuses interpreters exactly like the cold path).
  `sys.exit` in a cell is captured as its exit code and the worker keeps
  serving; worker death is detected and respawned transparently; idle
  kernels self-reap (WARM_KERNEL_IDLE_S = 15 min);
  `AUGUST_WARM_KERNEL_OFF=1` forces the cold-spawn fallback, which
  remains fully intact. Plan acceptance proven
  (`test_warm_kernel.py::TestWarmBootCost`): a second warm cell skips
  interpreter boot — measured warm-cell wall-clock < identical cold
  spawn. 20 tests: lifecycle, state-via-pickle, exit/exception capture,
  cwd binding, env scrub, hardline + read-only enforcement inside the
  warm child, boot-cost, idle reap, preflight gates, and source-wiring
  of `_runFencedCodeBlock` (warm preferred, cold fallback).
* **P4.1 off-load guarantee** — `tests/test_offload_guarantee.py`: AST
  gates proving (1) the workbench turn-loop package never imports the
  learning engine (episode_miner / skill_distiller / consolidation), and
  (2) the curator router routes every engine call (mine_sessions /
  run_distiller_pass / run_resolution_check) through `asyncio.to_thread`
  — the Part 16 §12 F-4 violation class can never silently return.
* **P4.2 debounced persistence** — `app/services/deferred_writes.py`:
  turn_outcomes, lifecycle, and internal_state writes commit through
  `defer_commit` (≤2s debounce window, ≤10s max hold, deferral only on
  loop threads, flush-on-shutdown via `flush_thread_pending` in the
  lifespan teardown). Writes still execute immediately (same-connection
  readers see them uncommitted, exactly as before); sync contexts and
  `asyncio.to_thread` workers commit immediately. Tests:
  `tests/test_deferred_writes.py`.
* **Pre-existing bugs fixed en route (P3.2's tests exposed them):**
  1. `_CREDENTIAL_ENV_RE` (async_subprocess.py) and the mirrored env
     scrub in the code_runner preamble had a double-anchored `AUGUST_`
     branch matching only the exact literal — `AUGUST_BRAIN_SQLITE_FILE`
     / `AUGUST_DATA_DIR` leaked into EVERY agent child process, cold
     path included (the brain DB location is not a secret per se, but
     the documented scrub contract was silently broken). Now
     `AUGUST_\w*.*`; regression test in test_async_subprocess.py.
  2. `shadow_git._EXCLUDES` did not exclude the brain SQLite files —
     when the data dir lives inside the workspace (AUGUST_DATA_DIR
     override, tests, or a user workspace pointing at the data root),
     `git add -A` tried to index the live WAL `-shm` file (locked by the
     open connection) and the whole turn snapshot failed silently.
     `test_brain.sqlite*` / `august_brain.sqlite*` are now excluded;
     the previously-failing workbench tool-loop suite is green again.

**Deliberately left open:** the P2.3 follow-up (byte-stable omitted-bytes
marker) — evaluated and left as-is; the marker rides in tool results
(message tail), not the system prefix, so its cache impact is limited to
re-sent history, and changing the marker text would itself bust caches.
