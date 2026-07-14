# Refactor Progress Tracker — August Proxy

> **Live tracker for the multi-session refactor of August Proxy.** Updated at
> the end of every session. This file is the authority for refactor-status
> questions. Stale archaeology audits were removed from `docs/`.
>
> **Full pasteable handoff prompt for a new chat/model:**
> [`docs/REFACTOR_HANDOFF_PROMPT.md`](./REFACTOR_HANDOFF_PROMPT.md)
> (keep in sync when ending a session).

**Last updated:** 2026-07-14 — **Phase 8 SIGNED OFF** (full refactor program complete)
**Current branch state:** `master` — verify with `git rev-parse HEAD`.
**Verification baseline:**
pytest **748** · vitest **547** · Phase 7 gate · indexes `ALL_SIX_PRESENT` · isolation autouse
**CI note:** Prefer `backend-py/.venv` (3.12). Isolation is **autouse** — do not remove.
**Sign-off pack:** [`docs/PHASE8_FINAL_DELIVERABLES.md`](./PHASE8_FINAL_DELIVERABLES.md)

### Feature workstreams (shipped)

| Workstream | Status | Surface |
|---|---|---|
| Real-Time Feature Flow Visualization | ✅ | `/api/monitor/events` SSE + Settings → Feature Flow |
| Optional Proxy-Path AUG.md Injection | ✅ | `injectAugOnProxy` + API Access toggle + HTTP tests |
| Marquee titles / live backend actions / collab banners | ✅ | titlebar, tools, chat insights |

### Phase status

| Phase | Status |
|---|---|
| 0 Audit | **SIGNED OFF** |
| 1 Safety net | **DONE** (ongoing discipline) |
| 2 Naming / CamelModel | **SIGNED OFF** |
| 3 Modularization | **DONE** (optional residual large files) |
| 4 Modernization | **100%** exit checklist |
| P Performance | **DONE** (P0–P5 + exit gate) |
| 5 Deps / tooling / docs | **DONE** |
| 6 Bug ledger | **DONE** (B27 partial by design) |
| 7 Feature inventory testing | **DONE — fully automated E2E proven** (gate + vitest + mobile in CI) |
| **8 Final deliverables** | **SIGNED OFF** — [`PHASE8_FINAL_DELIVERABLES.md`](./PHASE8_FINAL_DELIVERABLES.md) |

---

## Ground Rule 1 correction (2026-07-14)

The earlier “Phase 3/4: 100%” summary was **measured against a narrower exit
checklist** than the full handoff prompt. That overstated completeness if
read as “every open item in the prompt is closed.” Correct ledger below.

| Prompt item | Actual status (verified in repo) | Belongs to |
|---|---|---|
| **B16** function APIs on `memory_store` / `db_writer` / `proxy_tools` | **CLOSED** — `def` names are snake_case (`save_memory`, `enqueue_write`, `execute_managed_proxy_tool`, …). **Residual naming debt:** many **parameters** still camelCase (`sessionId`, `factKey`). WIRE TypedDict keys still camelCase **by design**. | Phase 2 (not Phase 3/4) |
| **B1a** non-atomic JSON writes | **CLOSED** for listed sites: `aug_artifact_service` + `gateway/session_bridge` use `write_json_atomic`; `skills/curator` uses temp + `Path.replace`; `mcp_client` stdin JSON-RPC is not a durable JSON store write. **Residual (low, different class):** `consolidation_daemon` skill-draft `.md` uses plain `open(..., 'w')` (markdown staging, not the B1a JSON-store bug). | Phase 0/1 safety (gated Phase 2; closed before scale-up) |
| **Known large files** beyond workbench/anthropic | **Deferred, not forgotten** — see modularization residual table | Phase 3 optional polish |
| **Schema rename** | **CLOSED** on live DB — snake tables only; pass 1 merge + pass 2 drop verified | Phase 4 |

**Correct phrasing:** Phase 3/4 exit criteria for **modularization + Phase 4 modernization menu** are met. That is **not** the same as “100% of every historical audit bullet including residual param naming and optional file splits.”

---

## Where to pick up (next session)

1. **Refactor program complete.** Further work is product/features/ops, not reopening closed phases.
2. **B27** stays PARTIAL until product asks for peer-help re-spawn.
3. Live bot / real-LLM soaks remain **env-gated** (optional secrets).
4. **Contention gate** still applies before *raising* daemon/subagent caps.
5. Do **not** remove `isolatedData` autouse without safety review.
6. Optional polish only with go-ahead: ruff rule expansion; residual large-file splits.

---

## Standing principle — described-but-not-load-tested gate

Anything whose behaviour was **described in docs/audit** but never forced under
contention gets a **load/contention check before further work builds on it** —
not only after a surprise finding.

| Candidate | Status |
|---|---|
| `db_writer` | **Checked P0** — FIFO + age-drop; B26 closed |
| `subagent_orchestrator` peer-help | **Checked** — no recovery; silent success **fixed** (status + empty payload) |
| `daemon_manager` | **Checked** — cap enforced; backoff schedule used; BACKOFF_CAP dead vs schedule |
| **FTS app-path column MATCH** (`search_memory` / `auto_memory` / `brain_query`) | **Caught late (2026-07-14 audit)** — docs said Phase P complete; app SQL used nonexistent `content` column / wrong SELECT on FTS; silent LIKE / full-table fallback. Fixed + `tests/test_fts_app_path.py`. Tooling gap closed with permanent `scripts/_check_fts_query_hygiene.py` (static anti-patterns + live probes). `_verify_fts_sync.py` remains coverage-only. |
| **FTS alias MATCH** (`WHERE fts MATCH`) | **Same audit** — SQLite rejected alias left-hand MATCH (`no such column: fts`). Grep of `app/**/*.py`: only `memory_store` + `auto_memory` used MATCH; both use real table names. Hygiene script flags alias form permanently. |
| **Gateway workbench event names** (`finalOutput` vs `final_output`) | **Caught late (same audit)** — SessionBridge accumulated snake_case only; workbench emits camelCase. Fixed accept both; `tests/test_gateway_final_output.py`. Watch other bridge consumers of emit types. |
| **Optimistic “complete” plan status** | **Process debt** — third time this thread (schema hybrid, db_writer priority, Phase P complete). Status updates must cite verification command output, not intent. |

### Process fix (status reporting)

Before marking a workstream **DONE** in plan/progress docs:

1. Run the **named** scripts in `ARCHITECTURE.md` permanent tooling table when the change class matches (FTS → `_verify_fts_sync.py` **and** a test that calls the app function, not only raw SQL).
2. Paste or summarize **command exit + key lines** in the Progress Log entry.
3. Prefer “measured / verified” language over “complete” until (1)–(2) exist.
4. Correctness fixes and perf knobs land in **separate commits** (Ground Rule 3).

### Subagent peer-help + result handling (2026-07-14) — **higher severity than B26**

This is **not** the same class as db_writer’s misnamed priority. Peer-help does
not recover work; and until fixed, worker `{status: failed}` dicts were marked
**`completed`** because the orchestrator used `if result:` on a always-truthy dict.

#### Production reliance (verified in repo)

| Surface | Uses orchestrator? | Depends on peer-help *recovery*? |
|---|---|---|
| Tool `spawn_subagents` → `executeSpawnSubagents` → `waitForAll` | **Yes** | **No** consumer of peerHelp re-run (none exists). **Yes** depends on `handle.status` for succeeded/failed counts |
| `POST /api/subagents/spawn` | **Yes** | Same |
| `main.py` lifespan attaches orchestrator to `app.state` | **Yes** | Wired for production use |
| Any code that re-spawns on peerHelp | **None found** | — |

#### Measured behaviour

| Path | What happens |
|---|---|
| Exception in worker slot | `_handleFailure`: 5s wait for `peerHelp` signal; claim ends wait only; **no re-run** |
| Worker returns `{status: 'failed', ...}` | **Pre-fix:** handle.status=`completed`, `subagentCompleted` fired (**silent success**). **Post-fix:** handle.status=`failed`, `subagentFailed` |
| Worker returns `''` / falsy | `failed`, no peer-help window |
| Result content validation | Worker checks `subResult.status` only; orchestrator now requires non-empty stripped `result`/`output` when status is completed/success/ok |

#### Decision table (explicit — not pattern-matched to B26)

| Question | Answer |
|---|---|
| Does anything rely on peer-help *recovering* a failed subagent? | **No** — no re-spawn path and no callers of recovery; multi-agent still runs via orchestrator for **delegation + status tally** |
| Is “silent no-recovery” only doc debt? | **No** for result→status: failed workers were counted **completed** in `spawn_subagents` tallies — live correctness gap |
| Accept peer-help as non-recovering wait/signal? | **Yes** for now — do not claim recovery; real re-spawn needs a product feature |
| Accept silent success on `{status:failed}` dict? | **No** — fixed in orchestrator (`_result_is_failure`) |
| What triggers implementing real peer recovery? | Product asks for multi-agent reliability / re-spawn on failure; until then B27 tracks remaining gaps |

| B27 remainder (OPEN) | Notes |
|---|---|
| No automatic re-spawn / escalation after no claim | By design until product prioritizes |
| Peer claim does not re-run work | Documented |
| Logical failure does not open peer-help wait | OK while recovery is a no-op |

| B27 fixes (behavior commits, not docs-only) | |
|---|---|
| Failed worker `{status: failed}` → handle failed | `fix(subagent): treat failed status…` |
| `{status: completed, result: ''}` / whitespace → failed | same family, non-empty payload required |
| `{status: partial, ...}` | handle.status=`partial` — **not** tallied as `completed` by `spawn_subagents` (`succeeded` only counts exact `completed`) |

Tests: `tests/test_subagent_peer_help_contention.py`.
### Daemon manager contention check (2026-07-14)

| Contract | Measured |
|---|---|
| Max 3 daemons / session | **Enforced**; 4th returns error; other sessions independent; `errored` frees a slot |
| Concurrent 8 spawns | Exactly 3 ok / 5 errors; live ≤ 3 |
| Backoff schedule | First delay = `BACKOFF_SCHEDULE[0]` (5s) on forced errors |
| `BACKOFF_CAP` 300 | **Does not bind** (schedule max 135) |

**BACKOFF_CAP meaning:** Design (`cognitive-architecture-v1.md` §5.4) specifies
backoff **5→15→45→135s, capped at 5 min**. The schedule already ends at 135;
the cap is a **harmless leftover safety bound** for a longer schedule that was
never added — not a bug that the schedule “should” reach 300. Safe to leave;
only becomes load-bearing if someone extends `BACKOFF_SCHEDULE` past 300s.

Tests: `tests/test_daemon_manager_contention.py`.---

## P1.1 / P1.2 — prompt segments + tool defs (isolated)

**Scope (this pass only):** caching near workbench chat loop. **No** schema or
`db_writer` changes. Tests live in `test_perf_p1_prompt_tool_cache.py` only.

| Change | Detail |
|---|---|
| P1.1 | `prompt_segments_cache` — skills catalogue (30s TTL), static clarify block; single catalogue build; `buildSystemPrompt(..., tools=)` avoids double `toolDefinitions` |
| P1.2 | `tool_defs_cache` — registry→Anthropic/OpenAI base lists keyed by `tool_registry.generation()` + MCP sig; progressive disclosure still per-session |
| Disable flags | `AUGUST_P1_TOOL_CACHE=0` / `AUGUST_P1_PROMPT_CACHE=0` for A/B |

### Before / after (this machine, mock LLM, 8 text turns)

| Metric | BEFORE (caches off) | AFTER (caches on) |
|---|---|---|
| **prompt_build p50** | **~13.0 ms** | **~1.5 ms** (~8.6×) |
| prompt_build p95 | ~19.4 ms | ~8.3 ms |
| **total_ms p50** | **~25.0 ms** | **~17.6 ms** (~1.4×) |
| ttft_ms p50 | ~16.9 ms | ~5.5 ms |
| tool cache | — | 14 hits / 2 misses |
| skills cache | — | 7 hits / 1 miss |

**Cache correctness (added after review):**

| Case | Covered |
|---|---|
| `register` bumps gen → cache miss | yes |
| **`unregister` removes tool → cache must not serve withdrawn name** | yes (`test_p1_tool_defs_cache_invalidates_on_unregister`) |
| **MCP signature change with stable registry gen** | yes (`test_p1_tool_defs_cache_invalidates_on_mcp_signature_change`) |
| 30s skills TTL under real churn | **not** load-tested — kill switch `AUGUST_P1_PROMPT_CACHE=0`; synthetic hit rates (7/1, 14/2) are 8-turn static mocks only |

Kill switches documented in `docs/ARCHITECTURE.md` § Runtime kill switches.

---

## Phase P0 baselines (2026-07-14 — measure-only; closed after review gaps)

**How to re-run:**  
`pytest backend-py/tests/test_perf_p0_baselines.py -q -s`  
`python backend-py/scripts/p0_explain_plans.py`  
`python backend-py/scripts/_check_phase4_indexes.py`  
`npx vitest run src/lib/__tests__/stream-perf.test.ts` (from `frontend/desktop`)  
Enable backend logs: `AUGUST_PERF_TIMING=1`. Frontend: `localStorage.august_stream_perf='1'`.

### Mock-LLM workbench (product overhead only)

| Metric | p50 | p95 | Notes |
|---|---|---|---|
| **total_ms** (text turn) | ~35–41 ms | ~53–83 ms | 8 runs; stub Anthropic stream |
| **ttft_ms** | ~27–29 ms | ~39–40 ms | first content emit |
| **prompt_build** sum | ~22–23 ms | ~30–32 ms | system prompt + tool defs (~55–60% of local turn) |
| **llm_wait** sum | ~0.2 ms | ~4 ms | **stub only — not provider RTT** |
| **persist** (in-stream span) | ~7 ms | ~18–54 ms | see persist diagnosis below |
| **tool_exec** (1× list_skills) | ~10–11 ms | — | one tool round then text |

### Persist p95 spread (second look)

| Measurement | p50 | p95 | Finding |
|---|---|---|---|
| In-stream `persist` span (mixed suite) | ~7–10 ms | up to ~54 ms | Includes `saveSessions` + `record_usage` + status emit; first runs pay cold path |
| **Isolated `saveSessions()` only** (30 runs, 20 sessions) | **~4.4 ms** | **~5.8 ms** | Tight — not unexplained SQLite chaos |

**Conclusion:** Stream-level persist p95 was mostly **first-sample / cold + extra work in the span**, not indexless table scans. Isolated session JSON write is stable.

### Multi-agent / shared state

| Metric | Value | Notes |
|---|---|---|
| Blackboard 8×5 write+read | ~309–316 ms wall | 40 notes |
| **`db_writer` contention** (not idle) | see below | |

### `db_writer` contention (real load) — B2 mental model falsified

Earlier B2/ARCHITECTURE text claimed “priority + drop-policy / high processed immediately.”
**P0 measured the opposite of priority jump:**

| Fact | Measured |
|---|---|
| Queue shape | **FIFO** shared; high does **not** jump the line |
| Boundedness | **Unbounded** `asyncio.Queue()` |
| Live drop policy | **Age-based at dequeue** (low > 2.0s skipped) |
| Dead code | **`QueueFull` low-pri drop at enqueue** — unreachable → **Phase 6 B26** |
| Sole caller | `consolidation_daemon` only |

| Result (12 slow low-pri @ 0.35s each + 1 high) | Value |
|---|---|
| low executed / dropped (est.) | **6 / 6** |
| high enqueue_ms | ~0.02 ms |
| high completion_ms (FIFO wait) | **~2100 ms** |
| high put-timeout (5s) | put succeeds immediately; completion is FIFO wait |

#### Product decision (2026-07-14) — explicit

| Option | Choice |
|---|---|
| **Accept as-is** for current sole caller (`consolidation_daemon`, best-effort) | **YES — accepted** |
| Treat ~2.1s high completion under backlog as a user-facing defect today | **No** — no interactive path uses this queue |
| Open a real priority-queue fix now | **No** — not without a caller that needs “high = fast” |
| Document truth; ban “high means fast” for new callers | **YES** — ARCHITECTURE + module docstring corrected |
| Track dead `QueueFull` path | **YES — B26 OPEN** (cleanup or wire a bounded queue intentionally) |

**P0 may only be called closed with the above decision + ARCHITECTURE correction landed.**

### Phase-4 indexes — all six present + EXPLAIN-used

| Index | Present | EXPLAIN |
|---|---|---|
| `idx_messages_session` | YES | SEARCH messages |
| `idx_usage_events_session` | YES | SEARCH usage_events |
| `idx_usage_events_created` | YES | SCAN…USING INDEX (by `created_at`) |
| `idx_sessions_archived` | YES | SEARCH sessions |
| `idx_blackboard_session` | YES | SEARCH blackboard |
| `idx_exam_attempts_exam` | YES | SEARCH exam_attempts |

Script: `backend-py/scripts/_check_phase4_indexes.py` → `ALL_SIX_PRESENT`.

### P0.4 Frontend stream profiler

| Piece | Detail |
|---|---|
| Module | `frontend/desktop/src/lib/stream-perf.ts` |
| Wired into | `makeStreamHandlers` flush throttle (`streamPerfStart/Content/Flush/End`) |
| Enable | `localStorage.setItem('august_stream_perf','1')` |
| Tests | `src/lib/__tests__/stream-perf.test.ts` (3 passed) |
| Marks | TTFT, flush duration, inter-flush gap; Performance API marks when available |

### Code (measurement only)

| Path | Role |
|---|---|
| `app/lib/perf_timing.py` | Backend traces |
| workbench stream | `prompt_build` / `llm_wait` / `tool_exec` / `persist` |
| `tests/test_perf_p0_baselines.py` | Mock-LLM + blackboard + **contention** db_writer + persist isolate |
| `scripts/p0_explain_plans.py` | EXPLAIN pack (includes all six indexes) |
| `lib/stream-perf.ts` | Frontend P0.4 |

**P1+ still gated** — do not start optimisations without a separate approval.

---

## HEADLINE: Test suite was mutating live production data

### What was wrong

| Issue | Detail |
|---|---|
| `test_memory.py` autouse | `DELETE FROM memory_store/sessions/usage_events/...` on the **live** brain after every test |
| Many `v2*`/`v3*`/`v11*` tests | Called `memory_store.init()` / `_conn()` without redirecting `AUGUST_BRAIN_SQLITE_FILE` |
| Consequence | Full pytest was **not** a safe verification step — it could destroy merge recovery mid-run |
| Historical note | Prior “N tests passed” this session were not proof of side-effect-free checks |

### Root cause (why the gap existed)

`isolatedData` in `conftest.py` was **opt-in** (tests had to request the fixture).
`test_memory.py` (and older `v2*`/`v3*`/`v11*` files) never requested it and used
their own `init()` + teardown against the default live path. Opt-in isolation
fails open: new tests that forget the fixture hit production. **Fix:** make
isolation **default-on** (`autouse=True`), not something each file must remember.

### Fix (blocking, done)

| Change | Detail |
|---|---|
| `tests/conftest.py` | **`isolatedData` is `autouse=True`** for every test: temp `AUGUST_DATA_DIR` + `AUGUST_BRAIN_SQLITE_FILE` + minimal `providers.json`/`config.json` |
| Proof | `_live_db_fingerprint.py` before full suite + after → **`FINGERPRINT_IDENTICAL True`** (row counts + content hashes + FTS counts + blob hashes) |
| Suite | **680 passed** with isolation on |

Permanent tooling (also listed in `docs/ARCHITECTURE.md`): `_live_db_fingerprint.py`, `_verify_fts_sync.py`, `_spotcheck_schema.py`.

---

## B16 / B1a evidence (re-verified)

### B16 — function APIs snake_case

| File | Function names | Notes |
|---|---|---|
| `services/memory_store.py` | snake_case (`save_memory`, `list_sessions`, `get_messages`, …) | Params often still `sessionId` / `factKey` |
| `services/db_writer.py` | snake_case (`enqueue_write`, `enqueue_write_sync`, `ensure_queue`) | Thin module |
| `adapters/proxy_tools.py` | snake_case (`execute_managed_proxy_tool`, `is_managed_web_tool_name`, …) | Some param names camelCase |

### B1a — atomic JSON durability

| Site | Status |
|---|---|
| `aug_artifact_service.py` | `write_json_atomic` |
| `gateway/session_bridge.py` | `write_json_atomic` |
| `skills/curator.py` | temp file + `tmp.replace(path)` |
| `tools/mcp_client.py` | N/A for B1a (process stdin, not store file) |
| Helper | `app/atomic_write.write_json_atomic` |

---

## Phase 3 — modularization status

**Exit criteria met:** cohesive extracts + re-exports + tests green.

### Extracts landed

| Extract | Module | Status |
|---|---|---|
| SSE format | `adapters/sse_format.py` | ✅ |
| OpenAI SSE | `adapters/openai_sse.py` | ✅ |
| Anthropic SSE | `adapters/anthropic_sse.py` | ✅ |
| Anthropic system/model | `adapters/anthropic_system.py` | ✅ |
| Proxy tool defs | `adapters/proxy_tool_defs.py` | ✅ |
| Tool HTML | `services/tool_html.py` | ✅ |
| Workbench effort / sessions / providers | `workbench/*` | ✅ |
| Memory schema | `services/memory_schema.py` | ✅ |
| Tool register groups | `tool_registrations/*` + `register_all` | ✅ |
| `tool_definitions.py` facade | ~49 lines | ✅ |

### Known large files — residual ledger (not “forgotten”)

| File | ~Lines (now) | Status |
|---|---|---|
| `workbench/workbench.py` | ~1460 | **Partial** — sessions/effort/providers out; **chat loop remains** (optional) |
| `adapters/anthropic.py` | ~1094 | **Partial** — SSE/system out; **stream translate remains** (optional) |
| `adapters/openai.py` | ~493 | **Partial** — SSE extracted; remaining format path still here; **not fully split** |
| `adapters/proxy_tools.py` | ~310 | **Partial** — defs extracted to `proxy_tool_defs`; interception/exec remains |
| `adapters/stream_state.py` | ~467 | **Unsplit** — still one SSE state machine module (optional) |
| `services/memory_store.py` | ~828 | **Partial** — schema/migration out; CRUD remains |

Phase 3 “done” = major targets modularized enough for safer change, **not** zero files over N lines.

---

## Phase 4 — modernization status

| Item | Status | Evidence |
|---|---|---|
| Missing SQLite indexes | ✅ | `idx_messages_session`, usage, sessions, blackboard, exams, … in `memory_schema` |
| storage_key_migration busy_timeout + WAL | ✅ | |
| Schema rename | ✅ hybrid (see below) | User-approved; shipped |
| B18 Zustand | ✅ | Zero `nanostores` in frontend |
| Raw sqlite3 + db_writer (no ORM) | ✅ | No SQLAlchemy; `memory_conn` + FIFO queue |

### Phase 4 — independent re-verification (2026-07-14, post-merge)

**Verdict: 100% of Phase 4 exit checklist** (indexes + busy_timeout/WAL + schema snake-only + Zustand + no ORM).  
Not the same as “100% of entire multi-phase handoff” (B16 residual params, optional large files, Phase 5–8 remain).

| Check | Command / method | Result |
|---|---|---|
| Six indexes present + EXPLAIN-used | `python backend-py/scripts/_check_phase4_indexes.py` | **ALL_SIX_PRESENT** |
| Indexes in DDL | `memory_schema.py` CREATE INDEX IF NOT EXISTS | All six present |
| Live tables snake-only | `sqlite_master` on `data/august_brain.sqlite` | **CAMEL_OR_MIXED: NONE** (28 tables) |
| Live columns snake-only | `_spotcheck_schema.py` | camel leftovers **NONE**; dual pairs **0/10** |
| Migration idle | `_spotcheck_schema.py` migrate section | `needs_migration before/after: False`; change count 0 |
| Wire hybrid | `memory_store/wire.py` `_row_as_wire` + `snakeToCamel` | Present |
| busy_timeout + WAL (brain) | `memory_conn.apply_conn_pragmas` | WAL + busy_timeout=10000 + FK ON; sync FULL default |
| busy_timeout + WAL (storage keys) | `lib/storage_key_migration.py` | WAL + busy_timeout set |
| Durable defaults test | `pytest tests/test_sqlite_pragma_defaults.py` | Passed |
| nanostores | rg frontend | **0 hits** |
| Zustand | `frontend/desktop` imports + `package.json` | 12+ stores; `"zustand": "^5.0.14"` |
| No ORM | `pyproject.toml` comment + no sqlalchemy dep | Confirmed |

### What “schema hybrid” was *intended* to mean

**Intended design:** Tables/columns **fully renamed** camel→snake in SQLite; HTTP/JSON stays camelCase via `_row_as_wire` — **not** dual live schemas.

| Layer | Intended convention |
|---|---|
| SQLite DDL / SQL identifiers | `memory_store`, `session_id`, `created_at`, … |
| Startup migration | `migrate_camel_to_snake` before `CREATE TABLE IF NOT EXISTS` |
| Returned dicts / API JSON | camelCase via `_row_as_wire` |

### Schema merge pass 1 (live DB) — 2026-07-14 — **DATA MERGE VERIFIED; camel tables retained**

**Protocol executed:**

1. Backup: `data/august_brain.sqlite.pre-merge-20260714-175223`
2. Per-table conflict analysis + merge (camel → snake), **no camel drops**
3. Id-collision recovery for `auto_memories` (logical `key` when ids collide)
4. Same spot-check script re-run with **coverage** section
5. Full pytest green (680 after dual-merge unit test)
6. Camel tables **still present** pending second confirmation → `drop_legacy_camel_tables(confirm=True)`

**Scripts:** `backend-py/scripts/merge_dual_schema_tables.py`, `_spotcheck_schema.py`, `_recover_auto_mem_conflicts.py`  
**Code fix:** `schema_rename_migration.migrate_camel_to_snake` now **merges** when both exist (never overwrites conflicting snake rows); `drop_legacy_camel_tables(confirm=True)` is explicit only.

#### Spot-check after merge (`coverage_all_ok: True`)

| Pair | Camel | Snake | Camel rows missing on snake |
|---|---|---|---|
| `memoryStore` / `memory_store` | 2 | 2 | **0** (blobs content-unioned — see below) |
| `usageEvents` / `usage_events` | 4 | 8+ | **0** (camel ids present) |
| `configAudit` / `config_audit` | 2 | 2 | **0** |
| `autoMemories` / `auto_memories` | 100 | 101 | **0** by **key** (was 100 vs 6) |
| `examQuestions` / `exam_questions` | 29 | 29 | **0** |
| `examAttempts` / `exam_attempts` | 4 | 4 | **0** |

**Conflicts — content-diffed (not timestamp-only):**

| Key | Finding | Resolution |
|---|---|---|
| `agent_jobs` | Disjoint job ids (camel 6 ∩ snake 12 = ∅) | **Union by id** → 18; snake ⊇ camel |
| `self_evolution_log` | Accumulating list; camel timestamp missing from snake | **Union by timestamp** → 3; snake ⊇ camel |
| `auto_memories` id 5/6 | Id collision, different keys | Re-insert camel keys under new ids |

**FTS5:** `memory_store` 2/2, `auto_memories` 101/101, 0 missing by rowid — `_verify_fts_sync.py` PASS.

### Pass 2 (camel drop) — CLOSED 2026-07-14

| Step | Result |
|---|---|
| Backup | `data/august_brain.sqlite.pre-drop-*` |
| `drop_legacy_camel_tables(confirm=True)` | **10 dropped**; camel list **NONE** |
| `needs_migration` | **False** |
| Spot-check | camel tables missing; columns snake; migrate no-op |
| Full pytest | **680 passed** (autouse isolation) |
| Snake-side fingerprint vs pre-drop | **identical** (tables + FTS + `memory_store` blobs); camel fingerprint keys gone as expected |
| FTS | PASS |

**Phase 4 schema status:** **CLOSED** — snake-only live schema + camel wire.

**Wire hybrid:** `_row_as_wire` on snake reads unchanged.

---

## Phase P — scope decision (user 2026-07-14)

Plan doc: [`docs/PHASE_PERF_AND_FLEXIBILITY_PLAN.md`](./PHASE_PERF_AND_FLEXIBILITY_PLAN.md)

| Decision | Status |
|---|---|
| Full Phase P (P0–P5) as committed initiative | **Not approved** |
| **P0 baselines only** | **Unblocked** — start when user says go; no optimisations without new approval |
| P1–P5 optimization/extension work | **Gated** on P0 numbers + explicit go |
| Baseline surfaces | Desktop **and** gateway/multi-agent (measure both) |
| Parallel tool execution | **Deferred** to post-safety Wave 2 if ever approved |
| Process | Doc may exist; **implementation of new initiative** requires go/no-go first |

### P2 vs Phase 4 (no double-claim)

| Phase 4 already closed | Phase P / P2 would be **new** if ever approved |
|---|---|
| Additive indexes, busy_timeout, WAL | FTS query-shape tuning, message **pagination**, write-queue lag measurement, PRAGMA tune **only if** EXPLAIN/baselines demand it |
| Schema rename hybrid | Not re-doing rename |

If P0 shows DB is not the bottleneck, P2 may never be worth opening.

---

## Decisions locked

| # | Decision |
|---|---|
| Phase 0/2 signed off | yes (B1a + B16 function APIs included) |
| Phase 3 modularization exit criteria | met; residual large files optional |
| Phase 4 modernization exit criteria | **100%** (re-verified evidence pack) |
| “100% of entire handoff checklist” | **false** for residual naming params / optional large files |
| Schema rename | **CLOSED** (pass 1 + pass 2) |
| Phase P | **COMPLETE** (P0–P5 streams) |
| B26 dead QueueFull | **CLOSED** (removed; age-drop remains) |
| UsageRecord collision | **CLOSED** (`SkillUsageRecord`) |
| Live test isolation | **Required** — `isolatedData` autouse; opt-in was the root failure mode |

---

## What's next

1. ~~Phases 0–5 / P~~ — complete.
2. ~~Phase 6~~ — bug ledger closed (B27 partial by design).
3. ~~Phase 7~~ — matrix operationalized; suite baselines recorded.
4. **Phase 8** final deliverables / overall sign-off when requested.
5. Optional backlog: Phase 7 gaps, ruff expansion, residual large-file polish.

---

## Open questions

- Expand ruff select rules beyond E4/E7/E9/F in a dedicated PR?
- Close Phase 7 gaps (Slack/Discord live, mobile, SSRF suite) now or defer to product?
- Run Phase 8 final deliverable pack?


---

## Phase 6 — Bug ledger re-verification (2026-07-14 — CLOSED)

| ID | Prior | Verified | Verdict |
|---|---|---|---|
| B1a | CLOSED | atomic writes at aug_artifact + session_bridge; curator tmp+replace | **CLOSED** |
| B2 | AMENDED | FIFO + age-drop docs match code | **CLOSED** (amended truth) |
| B11 | absent | no `backend-py/backend-py/` | **CLOSED** |
| B12 | open optional | deleted `data/august_brain.sqlite.bak`, `data/providers.json.bak` | **CLOSED** |
| B13–B25 | mostly closed | spot-check; B20 Dockerfile 3.12; B18 no nanostores; B26 no QueueFull | **CLOSED** |
| B26 | closed | no `QueueFull` in `db_writer.py` | **CLOSED** |
| B27 | PARTIAL | correctness fixed; no re-spawn by product decision | **PARTIAL (accepted)** |
| UsageRecord collision | closed | `SkillUsageRecord` vs API `UsageRecord` | **CLOSED** |
| storage_key conn helper | open | WAL + busy_timeout=10000; prefers `memory_store` table | **CLOSED** (parity verified) |
| B28 (new) | — | stream-translate extract dropped anthropic re-exports → collection fail | **CLOSED** — re-export restored |

**Open only:** B27 remainder (re-spawn feature) — product gated.

---

## Phase 7 — Feature inventory testing (2026-07-14 — OPERATIONALIZED)

Authoritative matrix: [`docs/FEATURE_INVENTORY_TEST_MATRIX.md`](./FEATURE_INVENTORY_TEST_MATRIX.md)

| Baseline | Result |
|---|---|
| Backend pytest | **723 passed** |
| Frontend vitest | **543 passed** (58 files) |
| Inventory map | 8 areas → Covered / Partial / Gap |
| Explicit gaps | Slack/Discord live, mobile, SSRF deep suite, per-skill E2E, real-provider soak |

Phase 7 **exit for operationalization:** matrix exists, suites green, gaps listed.  
Phase 7 **exit for zero-gap E2E:** not claimed — see matrix Gaps section.

---

## Phase 5 — Dependency, Tooling & Documentation (2026-07-14 — DONE)

### Dependency audit (verified)

| Surface | Status | Notes |
|---|---|---|
| `requires-python` | ✅ `>=3.12` | Matches Dockerfile `python:3.12-slim` and CI 3.12 |
| `[project.optional-dependencies].dev` vs `[dependency-groups].dev` | ✅ **in sync** | Same 9 packages (pytest, mypy, ruff, pre-commit, …) |
| Runtime deps | ✅ lean | fastapi, uvicorn, httpx, pydantic, playwright, ddgs, … — no ORM |
| Frontend store lib | ✅ Zustand only | `zustand@^5.0.14`; nanostores absent from deps + source |
| Optional extras | ✅ | `ml`, `desktop`, `pty` documented in pyproject |

### Tooling audit (verified)

| Tool | Status | Notes |
|---|---|---|
| Ruff | ✅ configured | `[tool.ruff]` in pyproject; select E4/E7/E9/F; format not forced yet |
| Pre-commit | ✅ present | `.pre-commit-config.yaml` → ruff on `backend-py/` |
| mypy | ✅ CI | `type-check.yml` |
| pytest | ✅ | `isolatedData` autouse; Phase P exit gate present |
| Frontend eslint/tsc | ✅ CI | same workflow |
| Ruff rule expansion | Open (optional) | Intentionally narrow; expand in dedicated PR only |

### Docs / deploy residual

| Item | Status | Evidence |
|---|---|---|
| B26 dead `QueueFull` path | ✅ CLOSED | removed earlier this session |
| `UsageRecord` name collision | ✅ CLOSED | `SkillUsageRecord` |
| Handoff prompt sync | ✅ | aligned to Phase P / Phase 5 |
| ARCHITECTURE memory_store paths | ✅ this commit | package + `memory_conn` links |
| DEVELOPER_GUIDE Python version | ✅ this commit | was wrongly 3.13+ → **3.12+** |
| B20 Dockerfile | ✅ CLOSED | `FROM python:3.12-slim`; `uv sync`; uvicorn :8085 — matches project pin |
| B12 `data/*.bak` | ✅ CLOSED | deleted with user go |
| Dependency audit write-up | ✅ | |

---

## Phase P COMPLETE — plan scope 100% (2026-07-14, exit gate)

| Stream | Deliverables |
|---|---|
| **P0** | `perf_timing`, mock-LLM baselines, EXPLAIN pack, stream marks, `GET /api/perf/recent` |
| **P1** | caches, parallel RO tools, BatchedEmit char+time, client pool, side-effects off path, async messages |
| **P2** | FTS app-path + hygiene tool; pagination; db_writer stats; schema warm path; PRAGMA **opt-in** (default FULL) |
| **P3** | stream throttle, virtualize, lazy routes, selectors, deferred FE, **Tauri wait-for-health** |
| **P4** | DEVELOPER_GUIDE checklists |
| **P5** | `chat_stages`, stream extracts, `memory_conn`, **`memory_store/` domain package** |
| **Gateway** | `emit_types` + SessionBridge assistant-text accumulation |

**Exit gate:** `tests/test_phase_p_exit_gate.py` + `scripts/_check_fts_query_hygiene.py`.

**Evidence:** Phase P related pytest green (60+); FTS hygiene PASS.

**Out of Phase P scope (next plans):** B16 camelCase params, Phase 5 residual tooling, Phase 6–8, raising caps.

**Decisions retained:** db_writer FIFO (B26); peer-help non-recovery (B27); daemon cap holds.
