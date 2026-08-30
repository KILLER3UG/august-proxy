# Part 18 — Harness Performance & Smoothness

**Status:** DRAFT — awaiting ruling. Written 2026-08-30 from a performance
lens over two deep-scanned external harnesses (see §7 provenance record)
plus a hot-path audit of the August working tree. Citation verification
against the post-Part-16 tree: §8 — P1.1 and P1.4 are ALREADY SHIPPED
(cut), P2.1/P2.4 need re-scoping, P3.3 cites a wrong identifier.
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
regardless), and the rest are genuine open work. Awaiting user ruling;
nothing implemented.
