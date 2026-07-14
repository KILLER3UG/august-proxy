# Refactor Progress Tracker — August Proxy

> **Live tracker for the multi-session refactor of August Proxy.** Updated at
> the end of every session. Earlier audit/analysis docs are now in `docs/`
> with explicit "SUPERSEDED — DO NOT FOLLOW" headers; this file supersedes
> them for refactor-status questions.
>
> **Full pasteable handoff prompt for a new chat/model:**
> [`docs/REFACTOR_HANDOFF_PROMPT.md`](./REFACTOR_HANDOFF_PROMPT.md)
> (keep in sync when ending a session).

**Last updated:** 2026-07-14 (Ground Rule 1 correction: Phase 3/4 scope narrowed; Phase P = **P0 only**)
**Current branch state:** `master` — verify with `git rev-parse HEAD`.
**Verification baseline:**
`pytest 679 passed` · `mypy app/ → 0 errors / 195 files` · `ruff check app/ → clean` · CI Type check green at `dcce2bb` wave
**CI note:** Prefer `backend-py/.venv` (3.12).

### Phase 0 — SIGNED OFF (2026-07-13)
### Phase 2 — SIGNED OFF (2026-07-14) — includes B1a + B16 (see residual ledger)
### Phase 3 — **DONE against modularization exit criteria** (not “all large files gone”)
### Phase 4 — **DONE against modernization exit criteria** (indexes, busy_timeout, schema rename hybrid, Zustand)
### Phase P — **P0 ONLY approved** (baselines); P1–P5 not approved

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
| **Schema rename** | **Implemented as hybrid boundary** (see below) — full **table/column** snake rename + camel **wire**, not dual columns | Phase 4 |

**Correct phrasing:** Phase 3/4 exit criteria for **modularization + Phase 4 modernization menu** are met. That is **not** the same as “100% of every historical audit bullet including residual param naming and optional file splits.”

---

## Where to pick up (next session)

1. **Phase P0 only** (user-approved): baselines — product overhead vs provider RTT; include gateway/multi-agent surfaces in measurement; no P1–P5 until numbers justify scope.
2. Do **not** treat Phase P as fully greenlit; doc exists for design, execution gated.
3. Phase 5 docs / Phase 7 feature E2E remain open on the long roadmap.
4. Optional Phase 3 polish only if it unblocks measured work later.

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

### What “schema hybrid” means (one line + detail)

**One line:** Tables/columns were **fully renamed to snake_case in SQLite**; HTTP/JSON **still camelCase** via `_row_as_wire` (`snakeToCamel` on row dicts) — **not** dual columns or a permanent dual schema.

| Layer | Convention |
|---|---|
| SQLite DDL / SQL identifiers | `memory_store`, `session_id`, `created_at`, … |
| Startup migration | `schema_rename_migration.migrate_camel_to_snake` (idempotent) before `CREATE TABLE IF NOT EXISTS` |
| Python function names | snake_case (B16) |
| Returned dicts / API JSON | camelCase (`sessionId`, `createdAt`) |
| WIRE TypedDicts | Still camelCase keys (wire contract) |

**Not done / not claimed:** renaming every Python **parameter** to snake_case; converting WIRE TypedDict key names; dual-writing old+new columns.

---

## Phase P — scope decision (user 2026-07-14)

Plan doc: [`docs/PHASE_PERF_AND_FLEXIBILITY_PLAN.md`](./PHASE_PERF_AND_FLEXIBILITY_PLAN.md)

| Decision | Status |
|---|---|
| Full Phase P (P0–P5) as committed initiative | **Not approved** |
| **P0 baselines only** | **Approved** |
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
| Phase 4 modernization exit criteria | met |
| “100% of entire handoff checklist” | **false** — use residual ledger |
| Schema rename | hybrid wire/SQL boundary; full table/column snake rename |
| Phase P | **P0 only** until further approval |

---

## What's next

1. Implement **P0 only** when user says start (instrument + measure; no optimizations).
2. Report baselines; then **separate** go/no-go for any P1+ work.
3. Phase 5/7 as needed; optional modularization polish not blocking.

---

## Open questions

- Start P0 instrumentation implementation now?
- Any extra surfaces to include in P0 (e.g. mobile companion)?
