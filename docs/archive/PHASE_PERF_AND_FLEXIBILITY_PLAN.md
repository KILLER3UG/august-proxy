# Phase P — True Performance + Feature Flexibility Plan

> **Status (2026-07-14, closed with verification evidence):** **PHASE P 100%
> for plan scope** — not the entire monorepo residual ledger (B16 params,
> Phase 5–8, etc.). Exit pack §8 re-run green; FTS app-path hygiene +
> durable SQLite defaults + gateway emit contract gated by permanent tests.
>
> **Standing gate:** load-test before raising daemon/subagent caps
> (`db_writer` FIFO retained). Status claims require command output, not intent.

**Why a plan exists:** Phases 3–4 improved structure and naming. Phase P
measured and reduced product-side overhead and locked extension points.

**Refs:** `docs/REFACTOR_PROGRESS.md` · workbench · gateway · subagents ·
`db_writer` · tool registry · SQLite brain · desktop streaming UI.

---

## 1. Goals and non-goals

### Goals

| Goal | Definition of success |
|---|---|
| **Feel fast** | TTFT, tool-round latency, UI paint stay within budgets |
| **Stay scalable** | Adding a tool / provider / panel does not require editing monoliths |
| **Data-driven** | Perf claims have numbers or kill-switch A/B paths |
| **Safe** | Behavior-preserving by default; regressions caught by suite + exit gate |

### Non-goals (for this phase)

- Full rewrite of workbench or adapters
- Migrating off SQLite unless measurement proves it is the bottleneck
- Micro-optimizing Python while LLM network dominates wall clock
- Replacing Zustand / React for its own sake
- Closing the entire handoff residual ledger (Phase 5–8, B16 param rename)

### Reality check

```
network LLM  >>  tool I/O  >>  JSON/SSE parse  >>  SQLite  >>  React paint
```

---

## 8. Verification pack (Phase P done when…)

- [x] P0 baselines recorded (p50/p95) for mock-LLM chat overhead
- [x] At least one P1 win with measured improvement (prompt_build ~13→1.5ms p50)
- [x] Hot SQLite queries EXPLAIN-clean (Phase 4 indexes + P0 EXPLAIN pack)
- [x] Stream UI: throttled flush + virtualized long threads + lazy routes
- [x] Extension checklists in DEVELOPER_GUIDE; exercised via tests
- [x] pytest Phase P suite green (`test_phase_p_*`, `test_fts_app_path`, `test_phase_p_exit_gate`)
- [x] Progress Log updated; kill switches for caches/parallel tools
- [x] FTS **app-path** hygiene (not only index sync): `_check_fts_query_hygiene.py` + exit gate
- [x] Durable SQLite defaults (FULL sync); PRAGMA cache/mmap **opt-in only**
- [x] Gateway `finalOutput` contract + emit_types single source
- [x] `memory_store` domain package (kv / messages / sessions / brain / rest)
- [x] Tauri spawn waits for `/api/health` (not success-on-spawn)

### Re-run (evidence commands)

```text
cd backend-py
uv run python scripts/_check_fts_query_hygiene.py
uv run python scripts/_verify_fts_sync.py
uv run pytest tests/test_phase_p_exit_gate.py tests/test_fts_app_path.py \
  tests/test_gateway_final_output.py tests/test_sqlite_pragma_defaults.py \
  tests/test_phase_p_remaining.py tests/test_phase_p_followups.py \
  tests/test_perf_p0_baselines.py tests/test_perf_p1_prompt_tool_cache.py -q
```

---

## 9. What was implemented (code-verified)

| Stream | Status |
|---|---|
| P0 baselines + `/api/perf/recent` | Done |
| P1.1–P1.7 hot path | Done (caches, parallel RO tools, BatchedEmit char+time, client pool, side-effects off path, get_messages_async) |
| P2.1 EXPLAIN + P2.2 FTS | Done (table-level MATCH; auto_memory JOIN; hygiene tool) |
| P2.3 message pagination | Done |
| P2.4 `db_writer` lag | Done (stats + `/api/perf/db-writer`; FIFO unchanged) |
| P2.5 startup no-op | Done (`user_version` warm skip) |
| P2.6 PRAGMA | Done as **opt-in only**; default **FULL** durability (no unmeasured NORMAL) |
| P3 UI | Done (throttle, virtualize, lazy routes, selectors, Tauri health wait) |
| P4 extension checklists | Done (`DEVELOPER_GUIDE.md`) |
| P5 structure | Done (`chat_stages`, stream extracts, `memory_store` domain package, `memory_conn`) |

Kill switches / knobs: `AUGUST_P1_TOOL_CACHE=0`, `AUGUST_P1_PROMPT_CACHE=0`, `AUGUST_P1_PARALLEL_TOOLS=0`, `AUGUST_SQLITE_CACHE_KB`, `AUGUST_SQLITE_MMAP_MB`, `AUGUST_SQLITE_SYNC` (opt-in), `AUGUST_DB_WRITER_LOW_DROP_S`.

### Explicitly out of Phase P scope (next plans)

| Item | Where tracked |
|---|---|
| B16 remaining camelCase **parameters** | REFACTOR_PROGRESS residual ledger |
| Optional large-file splits beyond current extracts | REFACTOR_PROGRESS |
| Phase 5–8 roadmap | REFACTOR_PROGRESS / later plans |
| Raising daemon/subagent caps | Requires new load-test |

---

## 10. Relationship to later refactor phases

| Phase | Role relative to this plan |
|---|---|
| Phase 5 (docs/tooling) | Separate plan — not implied closed by Phase P |
| Phase 6 (bug reporting) | Ongoing |
| Phase 7 (feature E2E) | Separate |
| Phase 3/4 | Structure/naming foundation; residual ledger in Progress Log |

---

## Locked decisions

1. P0 first — baselines before optimization (done).
2. Parallel tools only for allowlisted read-only tools.
3. `db_writer` FIFO accepted (B26).
4. Status **DONE** requires verification command output (process rule 2026-07-14).
5. Full Phase P plan scope closed 2026-07-14 after exit gate + FTS hygiene PASS.
