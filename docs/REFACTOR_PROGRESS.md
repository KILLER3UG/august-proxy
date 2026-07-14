# Refactor Progress Tracker — August Proxy

> **Live tracker for the multi-session refactor of August Proxy.** Updated at
> the end of every session. Earlier audit/analysis docs are now in `docs/`
> with explicit "SUPERSEDED — DO NOT FOLLOW" headers; this file supersedes
> them for refactor-status questions.
>
> **Full pasteable handoff prompt for a new chat/model:**
> [`docs/REFACTOR_HANDOFF_PROMPT.md`](./REFACTOR_HANDOFF_PROMPT.md)
> (keep in sync when ending a session).

**Last updated:** 2026-07-14 (Phase 3 major wave + Phase 4 almost done)
**Current branch state:** `master` tip (= `origin/master`). Verify with `git rev-parse HEAD`.
**Verification baseline:**
`pytest 676 passed` · `mypy app/ → 0 errors / 185 files` · `ruff check app/ → clean` · CI Type check green
**CI note:** Prefer `backend-py/.venv` (3.12).

### Phase 0 — SIGNED OFF (2026-07-13)
### Phase 2 — SIGNED OFF (2026-07-14)
### Phase 3 — SUBSTANTIALLY COMPLETE (modularization wave landed)
### Phase 4 — ALMOST DONE (indexes, busy_timeout, schema plan, Zustand pilot)

---

## Where to pick up (next session)

1. Verify clean `master`.
2. Optional further Phase 3: slice remaining bulk in `workbench.py` (~1776 chat loop), `tool_definitions.py` (~1302 registerAll), `anthropic.py` (~1094 stream translate).
3. Phase 4 leftovers: finish B18 Zustand migration for remaining nanostores; implement schema rename **only after** sign-off of `docs/PHASE4_SQLITE_SCHEMA_RENAME_PLAN.md`.
4. Phase 5+ docs/tooling; Phase 7 feature testing.

---

## Phase 3 progress (extracts)

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
| Memory schema | `services/memory_schema.py` | ✅ |

### Known large files (approx lines after wave)

| File | ~Lines | Notes |
|---|---|---|
| `workbench.py` | **1776** | Sessions + effort extracted; chat loop remains |
| `tool_definitions.py` | **1302** | HTML extracted; `registerAll` monolith remains |
| `anthropic.py` | **1094** | SSE + system extracted; stream translate remains |
| `memory_store.py` | **759** | Schema extracted; CRUD remains |
| `openai.py` | **493** | SSE extracted |
| `proxy_tools.py` | **310** | Defs extracted |

---

## Phase 4 progress

| Item | Status |
|---|---|
| Missing SQLite indexes | ✅ Done |
| storage_key_migration busy_timeout + WAL | ✅ Done |
| Schema rename design doc | ✅ `docs/PHASE4_SQLITE_SCHEMA_RENAME_PLAN.md` (**implementation needs sign-off**) |
| B18 Zustand pilot | ✅ browser-store migrated; other nanostores remain |
| B18 full migration | Open (theme, sessions, gateway, chat streams, …) |
| Schema rename implementation | **Blocked on user sign-off** |

---

## Phase 2 verification evidence (archived)

| Check | Result |
|---|---|
| pytest | 605+ at sign-off; **676** after Phase 3/4 wave |
| mypy | 0 errors |
| CamelModel routers | complete |
| B21 filenames/callables/INTERNAL TypedDicts | complete |

---

## Decisions locked

| # | Decision |
|---|---|
| Phase 0/2 signed off | yes |
| SQLite schema rename | design only until explicit user approval |
| Phase 3 approach | cohesive extract + re-exports + characterization tests |

---

## What's next

1. Optional: more workbench/tool_definitions/anthropic slices → Phase 3 fully done.
2. Finish B18 Zustand stores (remaining list in prior pilot notes).
3. User decision on schema rename plan before any SQL rename work.
4. Phase 5/7 as needed.

---

## Open questions

- Approve SQLite schema rename implementation per plan doc?
- Continue remaining Zustand stores now?
- Further workbench chat-loop split?
