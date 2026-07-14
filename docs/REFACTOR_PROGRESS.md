# Refactor Progress Tracker — August Proxy

> **Live tracker for the multi-session refactor of August Proxy.** Updated at
> the end of every session. Earlier audit/analysis docs are now in `docs/`
> with explicit "SUPERSEDED — DO NOT FOLLOW" headers; this file supersedes
> them for refactor-status questions.
>
> **Full pasteable handoff prompt for a new chat/model:**
> [`docs/REFACTOR_HANDOFF_PROMPT.md`](./REFACTOR_HANDOFF_PROMPT.md)
> (keep in sync when ending a session).

**Last updated:** 2026-07-14 — **P0 closed**; **P1.1/P1.2 landed** (prompt/tool caches, isolated before/after)
**Current branch state:** `master` — verify with `git rev-parse HEAD`.
**Verification baseline:**
P0 + P1 cache tests green · schema closed · isolation autouse · db_writer FIFO documented
**CI note:** Prefer `backend-py/.venv` (3.12). Isolation is **autouse** — do not remove.

### Phase 0 — SIGNED OFF (2026-07-13)
### Phase 2 — SIGNED OFF (2026-07-14) — includes B1a + B16 (see residual ledger)
### Phase 3 — **DONE against modularization exit criteria** (not “all large files gone”)
### Phase 4 — **DONE** (all **six** indexes present + EXPLAIN-used; busy_timeout; Zustand; schema closed)
### Phase P — **P0 CLOSED**; **P1.1 + P1.2 DONE** (caches); P1 rest / P2–P5 **not approved**

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

1. Optional further Phase P only with explicit go (P1 remaining / P2+).
2. **Contention gate** before relying on: `daemon_manager` (backoff / 3-daemon cap), `subagent_orchestrator` (peer-help window) — same shape as db_writer was.
3. Do **not** remove `isolatedData` autouse without safety review.
4. Phase 5 / Phase 7 remain open on the long roadmap.

---

## Standing principle — described-but-not-load-tested gate

Anything whose behaviour was **described in docs/audit** but never forced under
contention gets a **load/contention check before further work builds on it** —
not only after a surprise finding.

| Candidate | Status |
|---|---|
| `db_writer` | **Checked P0** — FIFO + age-drop; B26 open |
| `subagent_orchestrator` peer-help | **Checked** — no recovery; silent success **fixed** (status + empty payload) |
| `daemon_manager` | **Checked** — cap enforced; backoff schedule used; BACKOFF_CAP dead vs schedule |

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

Tests: `tests/test_subagent_peer_help_contention.py`.

### Daemon manager contention check (2026-07-14)

| Contract | Measured |
|---|---|
| Max 3 daemons / session | **Enforced**; 4th returns error; other sessions independent; `errored` frees a slot |
| Concurrent 8 spawns | Exactly 3 ok / 5 errors; live ≤ 3 |
| Backoff schedule | First delay = `BACKOFF_SCHEDULE[0]` (5s) on forced errors |
| `BACKOFF_CAP` 300 | **Does not bind** with current schedule (max 135) — cap is dead for today's constants |

Tests: `tests/test_daemon_manager_contention.py`. No production code change (contracts hold for cap; cap constant is soft dead).
---

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
| Phase 4 modernization exit criteria | **met** including schema rename closed on live DB |
| “100% of entire handoff checklist” | **false** for residual naming params / optional large files |
| Schema rename | **CLOSED** (pass 1 + pass 2) |
| Phase P / P0 | **P0 unblocked** |
| Live test isolation | **Required** — `isolatedData` autouse; opt-in was the root failure mode |

---

## What's next

1. Implement **P0 only** when user says start (instrument + measure; no optimizations).
2. Report baselines; then **separate** go/no-go for any P1+ work.
3. Phase 5/7 as needed; optional modularization polish not blocking.

---

## Open questions

- Start P0 instrumentation implementation now?
- Any extra surfaces to include in P0 (e.g. mobile companion)?
