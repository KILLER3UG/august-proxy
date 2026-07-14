# Phase P — True Performance + Feature Flexibility Plan

> **Status (2026-07-14):** **P0 CLOSED**. **P1.1 + P1.2 DONE** (prompt/tool
> caches with isolated before/after). Further P1 items / P2–P5 need new go.
> Standing gate: load-test described contracts before building on them
> (`daemon_manager`, `subagent_orchestrator` next).
>
> **Why a plan exists:** Phases 3–4 improved structure and naming. They did
> **not** prove end-to-end speed. *If* baselines show product-side waste,
> later workstreams would target measured latency and extension points.
>
> **Refs:** `docs/REFACTOR_PROGRESS.md` · workbench · gateway · subagents ·
> `db_writer` · tool registry · SQLite brain · desktop streaming UI.

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

## 2. Phase 3 / 4 vs full handoff checklist (Ground Rule 1)

**Do not wave “100%” through.** Status is checklist-relative.

| Claim | Verdict |
|---|---|
| Phase 3 **modularization exit criteria** | Met (extracts + re-exports + tests) |
| Phase 4 **modernization exit criteria** | Met (indexes, busy_timeout, schema hybrid, Zustand) |
| Full handoff residual ledger (B16 params, optional large files, Phase 5–8) | **Not** “100% closed” |
| B16 **function** APIs (`memory_store` / `db_writer` / `proxy_tools`) | **Closed** (Phase 2) — params often still camelCase |
| B1a atomic JSON stores | **Closed** (Phase 0/1) — listed sites use atomic helper / temp+replace |
| Known large files `openai` / `proxy_tools` / `stream_state` | **Deferred optional**, not forgotten — partial extracts only |
| Schema “hybrid” | Full snake **tables/columns** + camel **wire** via `_row_as_wire` — **not** dual columns |
| Proven runtime performance | **Not done** — P0 will measure whether Phase P is even warranted |

Authoritative residual table: `docs/REFACTOR_PROGRESS.md` § Ground Rule 1 correction.

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

**Exit:** Written baseline numbers in Progress Log (p50/p95) — **met 2026-07-14**.

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

### P2 — Data layer performance (**not approved**; only if P0 blames DB)

**Phase 4 already closed (do not re-claim as Phase P wins):** additive indexes,
`busy_timeout`, WAL, schema rename hybrid.

**P2 is only new work if baselines prove need:**

| Task | Notes | Overlap with Phase 4? |
|---|---|---|
| P2.1 EXPLAIN pack on hot queries | Confirm indexes are *used* | Audit only; not re-adding the same indexes |
| P2.2 FTS query-shape tuning | Avoid bad MATCH / `SELECT *` on large payloads | **New** |
| P2.3 Message pagination | Unbounded `get_messages` risk | **New** |
| P2.4 `db_writer` queue lag | Measure under load | Instrumentation / possible tuning — **new** if lag real |
| P2.5 Startup migration no-op cost | Already snake path should be fast | Micro; only if P0 shows startup pain |
| P2.6 PRAGMA tune | `mmap` / `cache_size` only after measure | **New**, gated |

**Exit (if opened):** Documented query plans + fixes only where EXPLAIN/baselines demand.

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

## 6. Execution order (gated)

```text
[APPROVED] P0 baselines (desktop + gateway/multi-agent measure)
                │
                ▼
        report numbers → explicit go/no-go
                │
                ├── stop (no Phase P) if overhead is fine / LLM-bound only
                └── [NOT APPROVED YET] P1 → optional P2/P3/P4…
                      parallel tools: only after dedicated safety pass (Wave 2+)
```

**P0 measurement surfaces (required):**

| Surface | What to time |
|---|---|
| Desktop workbench chat | prompt_build, tool_def build, local tool, sse emit, persist (mock LLM) |
| Gateway path | session bridge / platform ingress → same core loop if shared |
| Multi-agent | subagent spawn + blackboard/db_writer contention under N parallel agents |
| Daemons | sample daemon tick cost (not full soak unless easy) |

Do **not** start P1+ without a new approval.

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

## 9. What is approved to implement

**Only P0** (when user says start):

1. P0.1 Instrumented timings on desktop chat critical path  
2. P0.2 Mock-LLM smoke for product overhead (exclude provider RTT)  
3. P0.3 EXPLAIN pack for hot SQL (read-only measurement)  
4. P0.4 Light frontend stream marks (optional if cheap)  
5. P0.5 Gateway + multi-agent/subagent baseline harness (measure contention)  

**Explicitly not approved yet:** P1 caching, P2 tuning, P3 UI optimizes, P4 flexibility program expansion, parallel tools, P5 splits.

**After P0:** deliver a short findings report → user decides stop vs open P1+.

---

## 10. Relationship to later refactor phases

| Phase | Role relative to this plan |
|---|---|
| Phase 5 (docs/tooling) | Only if still on roadmap; not implied by P0 |
| Phase 6 (bug reporting) | Ongoing |
| Phase 7 (feature E2E) | Separate |
| Phase 3/4 | Structure/naming foundation; residual ledger in Progress Log |

---

## Locked decisions (user 2026-07-14)

1. **P0 only** — do not commit to full Phase P until baselines justify it.  
2. **Measure gateway/multi-agent in P0**; optimize desktop first only if numbers say so.  
3. **Parallel tools deferred** past any first optimization wave; needs safety pass (`db_writer`, daemon/subagent shared state).
