# Refactor Progress Tracker — August Proxy

> **Live tracker for the multi-session refactor of August Proxy.** Updated at
> the end of every session. Earlier audit/analysis docs are now in `docs/`
> with explicit "SUPERSEDED — DO NOT FOLLOW" headers; this file supersedes
> them for refactor-status questions.
>
> **Full pasteable handoff prompt for a new chat/model:**
> [`docs/REFACTOR_HANDOFF_PROMPT.md`](./REFACTOR_HANDOFF_PROMPT.md)
> (keep in sync when ending a session).

**Last updated:** 2026-07-14 (Phase 3 **DONE** · Phase 4 **DONE**)
**Current branch state:** `master` (ahead of `origin/master` until pushed). Verify with `git rev-parse HEAD`.
**Verification baseline (2026-07-14 integration wave):**
`pytest 679 passed` (1 Windows file-lock flake re-pass on re-run) · `mypy app/ → Success: no issues found in 195 source files` · `ruff check app/ → All checks passed` · CI Type check: push to confirm
**CI note:** Prefer `backend-py/.venv` (3.12).

### Phase 0 — SIGNED OFF (2026-07-13)
### Phase 2 — SIGNED OFF (2026-07-14)
### Phase 3 — **DONE** (2026-07-14)
### Phase 4 — **DONE** (2026-07-14)

---

## Where to pick up (next session)

1. Verify clean `master` at tip after push; confirm CI Type check green.
2. **Phase 5+** docs/tooling; **Phase 7** feature testing checklist.
3. Optional polish only: further split of remaining large files (`workbench.py` chat loop ~1.6k, `anthropic.py` stream translate ~1.1k) — **not required for Phase 3 done**.

---

## Phase 3 — DONE proof

**Goal:** Modularize oversized modules via cohesive extracts + re-exports + characterization tests. Behavior-preserving.

### Extracts landed

| Extract | Module | Status |
|---|---|---|
| SSE format | `adapters/sse_format.py` | ✅ |
| OpenAI SSE | `adapters/openai_sse.py` | ✅ |
| Anthropic SSE | `adapters/anthropic_sse.py` | ✅ |
| Anthropic system/model | `adapters/anthropic_system.py` | ✅ |
| Proxy tool defs | `adapters/proxy_tool_defs.py` | ✅ |
| Tool HTML | `services/tool_html.py` | ✅ |
| Workbench effort | `workbench/effort.py` | ✅ |
| Workbench sessions | `workbench/sessions.py` | ✅ |
| Workbench providers/LLM | `workbench/providers.py` | ✅ (~414 lines) |
| Memory schema | `services/memory_schema.py` | ✅ |
| Tool register groups | `services/tool_registrations/*` | ✅ (`register_all`) |

### Line-count evidence (post-integration)

| File | ~Lines | Notes |
|---|---|---|
| `tool_definitions.py` | **49** | Thin entry: re-exports + `registerAll` → `register_all()` |
| `tool_registrations/` | ~1.5k total | 7 groups: file, web, desktop, memory, system, agent, skill |
| `workbench.py` | **~1612** | Sessions, effort, providers extracted; chat loop remains (optional) |
| `providers.py` | **~414** | LLM/provider helpers |
| `anthropic.py` | **~1144** | SSE + system extracted; stream translate remains (optional) |
| `memory_store.py` | **~938** | Schema + rename migration extracted |
| `openai.py` | **~540** | SSE extracted |
| `proxy_tools.py` | thin after defs extract | |

### Phase 3 exit criteria met

| Criterion | Evidence |
|---|---|
| Major monoliths modularized | `registerAll` split; workbench providers split; adapter SSE/system split; memory schema split |
| Public entry points preserved | `tool_definitions.registerAll`, workbench re-exports |
| Tests green | 679 pytest pass |
| Types clean | mypy 195 files, 0 errors |
| Lint clean | ruff clean |

---

## Phase 4 — DONE proof

**Goal:** Modernization — SQLite indexes, busy_timeout, hybrid camel→snake schema rename, Zustand (B18).

| Item | Status | Evidence |
|---|---|---|
| Missing SQLite indexes | ✅ | Prior wave (`idx_*` on sessions/messages/usage/blackboard/exams) |
| storage_key_migration busy_timeout + WAL | ✅ | `_BUSY_TIMEOUT_MS`, WAL pragma |
| Schema rename design doc | ✅ | `docs/PHASE4_SQLITE_SCHEMA_RENAME_PLAN.md` |
| Schema rename **implementation** | ✅ | User-approved 2026-07-14; shipped |
| B18 Zustand pilot | ✅ | browser-store, theme |
| B18 full migration | ✅ | Zero `nanostores` in `frontend/`; stores use zustand |

### Schema rename implementation evidence

| Piece | Path / detail |
|---|---|
| Migration | `services/schema_rename_migration.py` — idempotent camel→snake tables/columns/indexes/FTS |
| Snake DDL | `services/memory_schema.py` — `CREATE TABLE` snake_case; `ensure_schema` runs rename first |
| Wire conversion | `memory_store._row_as_wire` — `snakeToCamel` on row dicts for HTTP/JSON |
| Services/SQL | brain routers, blackboard, heuristics, auto_memory, consolidation, exam, etc. use snake SQL |
| Hybrid contract | **DB/SQL = snake_case** · **HTTP/JSON wire = camelCase** |
| Tests | `test_sqlite_safety.py` expanded; storage_key_migration tests use `memory_store` table |

### Zustand (B18) evidence

| Store / area | Status |
|---|---|
| `store/theme.ts` | zustand |
| `store/sessions.ts` | zustand |
| `store/workspaces.ts` | zustand |
| `store/gateway.ts` | zustand |
| `store/command-palette.ts` | zustand |
| `store/chat-active-streams.ts` | zustand |
| `lib/browser-store.ts` | zustand |
| chat stream manager / queue-store / useLogStream / shell components | consumers updated |
| `nanostores` package | removed from `frontend/desktop/package.json` (only `zustand` remains) |
| `rg nanostores frontend` | **0 matches** |

### Phase 4 exit criteria met

| Criterion | Evidence |
|---|---|
| Indexes + busy_timeout | landed prior wave |
| Schema rename after sign-off | approved + implemented hybrid |
| B18 complete | no nanostores remaining |
| Tests / types / lint | pytest 679 · mypy 195 clean · ruff clean |

---

## Integration commits (this wave)

| Commit | Summary |
|---|---|
| `7b6bf5f` | schema rename core |
| `4d0c27b` | merge schema core onto master |
| `547b51c` | merge services SQL (resolve via `_row_as_wire`, not AS aliases) |
| `1c565cb` / `154fe38` | workbench providers extract |
| `f644c07` / `2f53b1c` | tool_registrations split |
| `7b69282` / `a37f1a4` | Zustand finish |

---

## Decisions locked

| # | Decision |
|---|---|
| Phase 0/2 signed off | yes |
| Phase 3 done | yes (2026-07-14) |
| Phase 4 done | yes (2026-07-14) |
| SQLite schema rename | **approved + implemented** hybrid: snake DDL + camel wire via `_row_as_wire` |
| Phase 3 approach | cohesive extract + re-exports + characterization tests |
| B18 | Zustand only; nanostores removed |

---

## What's next

1. Push `master` and confirm CI Type check green.
2. Phase 5 (docs/tooling modernization) / Phase 7 (feature inventory testing) as needed.
3. Optional non-blocking extracts: workbench chat loop, anthropic stream translate.

---

## Open questions

- None blocking Phase 3/4.
- Optional: further monolith slices for readability only.
