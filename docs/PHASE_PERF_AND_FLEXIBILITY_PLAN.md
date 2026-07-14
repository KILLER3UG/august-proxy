# Phase P — True Performance + Feature Flexibility Plan

> **Status:** Design / execution plan only. **Do not implement** until you
> pick a workstream and we establish baselines (P0).
>
> **Why this exists:** Phases 3–4 improved structure and naming. They did
> **not** prove end-to-end speed. This plan targets **measured latency,
> throughput, and extension points** so the product feels fast *and* stays
> easy to extend.
>
> **Refs:** `docs/REFACTOR_PROGRESS.md` · workbench chat loop · `db_writer` ·
> tool registry · SQLite brain · desktop streaming UI.

---

## 1. Goals and non-goals

### Goals

| Goal | Definition of success |
|---|---|
| **Feel fast** | Time-to-first-token (TTFT), tool-round latency, UI paint stay within budgets below |
| **Stay scalable** | Adding a tool / provider / panel does not require editing monoliths |
| **Data-driven** | Every perf change has before/after numbers; no “feels faster” claims |
| **Safe** | Behavior-preserving by default; regressions caught by suite + new perf smoke |

### Non-goals (for this phase)

- Full rewrite of workbench or adapters
- Migrating off SQLite unless measurement proves it is the bottleneck
- Micro-optimizing Python for its own sake while the LLM network dominates wall clock
- Replacing Zustand / React just because something “newer” exists

### Reality check

For chat, wall-clock time is usually:

```
network LLM  >>  tool I/O  >>  JSON/SSE parse  >>  SQLite  >>  React paint
```

So “true performance” means **shaving the critical path and removing stalls**,
not only making files smaller. Flexibility means **stable extension points**
so features plug in without rewriting the hot path.

---

## 2. Are Phase 3 & 4 “100%”?

### Short answer

| Claim | Verdict |
|---|---|
| Phase 3 exit criteria (declared modularization) | **Yes — complete** |
| Phase 4 exit criteria (indexes, busy_timeout, schema hybrid, B18 Zustand) | **Yes — complete** |
| Every large file fully split | **No** (optional leftovers) |
| Entire multi-phase refactor finished (5–8) | **No** |
| Proven maximum runtime performance | **No** — that is **this** plan |

### Phase 3 — complete against exit criteria, not infinite modularization

**Done:**

- SSE / OpenAI / Anthropic helpers extracted
- Proxy tool defs, tool HTML extracted
- Workbench: sessions, effort, providers extracted
- Memory schema extracted
- Tool registration: `tool_registrations/*` + `register_all()`; `tool_definitions.py` is a thin facade (~49 lines)

**Not 100% of all possible splits (explicitly optional):**

| Residual large surface | ~Lines | Why not “incomplete Phase 3” |
|---|---|---|
| `workbench/workbench.py` | ~1460 | Chat loop still there; optional polish |
| `adapters/anthropic.py` | ~1094 | Stream translate remains; optional |
| `memory_store.py` | ~828 | CRUD still dense; schema/migration out |
| `adapters/openai.py` | ~493 | Acceptable after SSE extract |

Phase 3 was signed off as **“major monoliths modularized + public APIs preserved + tests green”**, not “no file over N lines forever.”

### Phase 4 — complete against exit criteria

**Done:**

- Missing indexes (`idx_messages_session`, usage, sessions, blackboard, exams, …)
- `busy_timeout` + WAL on brain paths / storage_key_migration
- Schema rename **implemented** (hybrid: snake SQL + camel wire via `_row_as_wire`)
- Zustand B18 complete (`nanostores` gone from frontend)

**Not claimed / not required for Phase 4 “done”:**

- Zero residual camelCase in every SQL string outside the brain inventory (worth a residual audit)
- WIRE TypedDict keys still camelCase **by design** (API contract)
- Absolute best DB engine or best frontend state library for micro-bundle size

### Verification already on record

- pytest **679** passed · mypy **195** files clean · ruff clean · CI Type check green at sign-off tip

**Bottom line:** Phase 3 & 4 are **100% of what those phases promised**. They are **not** 100% of “perfect structure forever” or “fastest possible product.” This Phase P plan is the performance/flexibility track.

---

## 3. Success budgets (targets — calibrate after P0)

Set provisional budgets; replace with measured p50/p95 after baselining.

| Metric | Provisional target | Notes |
|---|---|---|
| **TTFT** (user send → first SSE token) | p50 &lt; 400 ms *local overhead* excluding provider RTT | Measure with mocked LLM for product overhead |
| **Tool round** (tool_call → tool_result injected) | p50 &lt; 50 ms local tools; I/O-bound tools separate | File read vs web fetch |
| **Session list / open** | p50 &lt; 100 ms for typical DB size | Index already present |
| **Brain memory search** | p50 &lt; 50 ms FTS top-k | Confirm FTS query plans |
| **UI stream jank** | no main-thread stalls &gt; 50 ms during token flood | Virtualization already available (`@tanstack/react-virtual`) |
| **Cold backend start** | track; no hard fail yet | Import cost + schema migrate |

---

## 4. Architecture principles (speed + flexibility)

1. **Measure before rewrite** — profile, don’t guess.
2. **Critical path stays thin** — chat loop orchestrates; tools/providers/memory are plugins.
3. **Extension via registration, not edit-monolith** — already started with `tool_registrations` / provider clients; finish the pattern for UI panels and daemons.
4. **Async where we wait** — never block the event loop on sync SQLite or heavy CPU without offload.
5. **Push work off the hot path** — persistence, auto-memory, consolidation, logging are best-effort or queued.
6. **Cache with invalidation** — tool defs, system prompt segments, model lists; never stale forever.
7. **Stable contracts** — wire camelCase, internal snake_case; new features respect that boundary.

---

## 5. Workstreams (ordered)

### P0 — Baseline & observability (must do first)

**Why:** Without numbers, “performance work” is fashion again.

| Task | Deliverable |
|---|---|
| P0.1 Instrumented chat path | Structured timings: prompt_build, llm_wait, tool_exec, sse_emit, persist |
| P0.2 Mock-LLM perf smoke | pytest or script: fixed tokens, no network; assert overhead budgets |
| P0.3 SQLite `EXPLAIN QUERY PLAN` pack | Scripts/docs for session list, messages by session, FTS, blackboard |
| P0.4 Frontend stream profiler | React Profiler + optional marks around stream buffer flush |
| P0.5 Dashboard metrics (optional) | Export timings to log or `/health` debug only |

**Exit:** Written baseline numbers in this doc or Progress Log (p50/p95).

---

### P1 — Hot-path latency (true speed)

Focus: `sendWorkbenchMessageStream` and tool execution.

| Task | Hypothesis | Approach |
|---|---|---|
| P1.1 Prompt build cost | `buildSystemPrompt` rebuilds too much per turn | Cache stable tiers (core memory, skills catalog); only rebuild dirty segments |
| P1.2 Tool definition lists | Rebuilding Anthropic/OpenAI tool JSON every turn is wasteful | Cache per session permission set + registry generation counter |
| P1.3 Sync SQLite on async loop | Thread-local sync `sqlite3` may block event loop | Confirm with P0; route reads through async or `asyncio.to_thread` for hot reads; writes already prefer `db_writer` queue |
| P1.4 Tool execution parallelism | Sequential tool calls when independent | Safe parallel for read-only tools; keep serial for mutating/guarded tools |
| P1.5 SSE emit batching | Per-token await overhead | Coalesce micro-batches under 8–16 ms frame budget without hurting TTFT |
| P1.6 Auto-memory / side effects | Post-turn work stalls stream close | Fire-and-forget or queue after final SSE; never block first token |
| P1.7 Provider client reuse | New HTTP client per request | Confirm connection pooling / shared `httpx.AsyncClient` per provider |

**Exit:** Mock-LLM overhead improved vs P0 baseline by agreed % (e.g. ≥20% p50 local overhead).

---

### P2 — Data layer performance

| Task | Notes |
|---|---|
| P2.1 Residual index audit | Verify all hot queries use indexes; add covering indexes only if EXPLAIN says so |
| P2.2 FTS quality/latency | `memory_store_fts` / `auto_memories_fts` query shapes; avoid `SELECT *` on large rows |
| P2.3 Message pagination | Session open must not load entire history unbounded |
| P2.4 Write path | Ensure high-churn writes go through `db_writer`; measure queue lag |
| P2.5 Migration cost | Schema rename migration is one-time; ensure startup path skips fast when already snake |
| P2.6 Vacuum / PRAGMA tune | Only after measurement (`mmap`, `cache_size`, `synchronous`) — document chosen values |

**Exit:** Documented query plans + no full-table scans on hot paths for typical DB size.

---

### P3 — Frontend performance (perceived speed)

| Task | Notes |
|---|---|
| P3.1 Stream buffer strategy | Throttle React commits; accumulate tokens, flush on rAF or size/time |
| P3.2 Virtualize long threads | Ensure chat list uses `@tanstack/react-virtual` for long sessions |
| P3.3 Zustand selector discipline | Components subscribe to slices only; avoid whole-store re-renders |
| P3.4 Code-splitting routes | Lazy-load settings/health/archive panels |
| P3.5 Asset / Tauri cold start | Profile webview load; defer non-critical work |

**Exit:** Smooth token stream on long sessions; no multi-second UI freezes on open.

---

### P4 — Flexibility for new features (extension architecture)

Speed without extensibility fails the second goal. Finish patterns Phase 3 started.

| Extension point | Current state | Target |
|---|---|---|
| **Tools** | `tool_registrations/*` + registry | New tool = new module + `register()` only; no edits to chat loop |
| **Providers / models** | provider clients + resolvers | New provider = client module + registry entry + tests |
| **Adapters (SSE)** | partial extracts | Protocol quirks isolated; workbench talks to a small stream interface |
| **Workbench steps** | large chat loop | Optional: state-machine or pipeline stages (`prompt → call → tools → persist`) as named functions/modules |
| **UI surfaces** | sections + stores | Feature = route/section + store slice + API client; no shell rewrite |
| **Daemons / background** | daemon_manager | New background job registers with manager + config flag |
| **Config** | live config services | Feature flags / capability bits for gradual rollout |

#### P4 design rules (when adding features)

1. **No new logic in `workbench.py` chat loop** unless it is orchestration only.
2. **Register, don’t hardcode lists** (tools, providers, slash commands).
3. **Contract tests** for each extension point (tool schema, provider stream shape).
4. **Feature flag** for risky features until Phase 7 E2E passes.

**Exit:** Written “how to add a tool / provider / panel” in `DEVELOPER_GUIDE.md` (or link) with a checklist under 30 minutes for a stub feature.

---

### P5 — Optional structural polish (only if it helps P1/P4)

These are **not** performance by default; do them when they unblock speed or features:

| Item | When |
|---|---|
| Extract workbench chat loop stages | When P1 changes keep conflicting in one file |
| Extract anthropic stream translate | When adapter bugs slow iteration |
| Split memory_store CRUD by domain | When DB perf work needs clearer ownership |

---

## 6. Execution order (recommended)

```text
P0 baselines  ──►  P1 hot path  ──►  P2 data  ──►  P3 frontend
                      │
                      └── parallel early: P4.1 docs + “add a tool” checklist
```

Do **not** start P5 file splits until P0 numbers exist.

Suggested chunking (same discipline as earlier phases):

1. One workstream slice per branch
2. Behavior-preserving unless a measured bug
3. Perf claim only with before/after numbers in the PR/commit body
4. Full pytest + mypy + ruff + CI green before merge

---

## 7. Risk register

| Risk | Mitigation |
|---|---|
| Optimizing the wrong layer (LLM dominates) | Mock-LLM budgets separate from provider RTT |
| Parallel tools break ordering / guards | Parallel only read-only + allowlisted tools |
| Cache staleness (tools, prompt) | Generation counters / explicit invalidate |
| Async offload races | Keep single-writer via `db_writer` |
| Frontend throttle increases TTFT | Never delay first token flush |
| Scope creep into rewrite | Hard non-goals; P0 gate |

---

## 8. Verification pack (Phase P done when…)

- [ ] P0 baselines recorded (p50/p95) for mock-LLM chat overhead
- [ ] At least one P1 win with measured improvement
- [ ] Hot SQLite queries EXPLAIN-clean
- [ ] Stream UI remains smooth under token flood test
- [ ] “Add a tool” and “Add a provider” checklists exist and were exercised with a stub
- [ ] pytest / mypy / ruff / CI still green
- [ ] Progress Log updated; no silent behavior changes

---

## 9. What to implement first (if you say go)

**Wave 1 (smallest high value):**

1. P0.1 + P0.2 — timing instrumentation + mock-LLM smoke  
2. P1.1 + P1.2 — cache system prompt segments + tool defs  
3. P4 checklist — document extension points while code is fresh  

**Wave 2:**

4. P1.3 / P1.6 — event-loop safety + move side effects off hot path  
5. P2.3 — message pagination if open-session is slow  
6. P3.1 / P3.3 — stream flush + Zustand selectors  

---

## 10. Relationship to later refactor phases

| Phase | Role relative to this plan |
|---|---|
| Phase 5 (docs/tooling) | Absorb P4 checklists into developer docs |
| Phase 6 (bug reporting) | Ongoing |
| Phase 7 (feature E2E) | Validates flexibility + no perf regressions on real features |
| Phase 3/4 | **Foundation done** — structure/naming; not a substitute for Phase P |

---

## Open decisions for the user

1. Approve **P0 baselines first**, or jump to a suspected hot spot? (**Recommend P0 first.**)
2. Target environment for budgets: local desktop only, or also multi-agent / gateway load?
3. Is **parallel tool execution** in scope for Wave 1, or Wave 2 after safety review?
