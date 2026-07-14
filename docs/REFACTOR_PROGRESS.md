# Refactor Progress Tracker — August Proxy

> **Live tracker for the multi-session refactor of August Proxy.** Updated at
> the end of every session. Earlier audit/analysis docs are now in `docs/`
> with explicit "SUPERSEDED — DO NOT FOLLOW" headers; this file supersedes
> them for refactor-status questions.
>
> **Full pasteable handoff prompt for a new chat/model:**
> [`docs/REFACTOR_HANDOFF_PROMPT.md`](./REFACTOR_HANDOFF_PROMPT.md)
> (keep in sync when ending a session).

**Last updated:** 2026-07-14 (Phase 3 extracts + Phase 4 missing indexes on master)
**Current branch state:** `master` tip (= `origin/master`, expect clean). Verify with `git rev-parse HEAD` — tip ≥ `5b21a50`.
**Verification baseline:**
`pytest 625 passed` · `mypy app/ → 0 errors` · `ruff check app/ → clean` · CI Type check **green** on master
**CI note:** Prefer `backend-py/.venv` (3.12).

### Phase 0 sign-off

**Signed off by user 2026-07-13** on the meta-review evidence pack.

### Phase 2 sign-off

**Signed off 2026-07-14** after full verification evidence pack (below). Naming rails
for Phase 2 are complete within the agreed scope. Remaining camelCase in
adapters/services is **out-of-scope residual** (not blocking Phase 3). WIRE
TypedDict keys stay camelCase until Phase 4 schema work.

#### Phase 2 verification evidence (2026-07-14)

| Check | Result |
|---|---|
| `pytest -q` | **605 passed** |
| `mypy app/` | **0 errors / 176 files** |
| `ruff check app/` | **All checks passed** |
| Router `BaseModel` count | **0** |
| Router `CamelModel` count | **40** |
| camelCase app filenames | **0** |
| camelCase test filenames | **0** |
| Old resolver names (`resolveOrFallback`, …) | **none** |
| CI Type check (residual naming branch) | **green** |

#### Phase 2 completed rails

| Rail | Status | Key commits |
|---|---|---|
| CamelModel router scale-up | ✅ | through `1d66d4d` |
| B21 app filenames | ✅ | `af9fce9` |
| B21 test filenames (62) | ✅ | `380ad2f` |
| Resolver callables | ✅ | `4b1b327` |
| INTERNAL TypedDicts + AliasDict wire boundary | ✅ | `0bc3e40` |
| Residual alias_mapping / curator / templates / skill list_all | ✅ | `1cd1a09`–`8f10a50` |

#### Explicitly deferred (not Phase 2 blockers)

- WIRE TypedDict keys (SQLite/JSON column parity) → Phase 4 schema
- Broad camelCase still present in adapters/workbench (~hundreds of identifiers)
- UsageRecord curator field names (wire JSON)
- B18 Zustand (**pilot done** — full migration open); B20 Dockerfile

---

## Where to pick up (next session)

1. Verify clean `master` matching `origin/master`.
2. **Continue Phase 3** — remaining large files still open:
   - `workbench.py` (~2011), `anthropic.py` (~1277), `tool_definitions.py` (~1302 after HTML extract), `memory_store.py` (~804)
3. **Phase 4** — missing indexes **done**; B18 Zustand **pilot** (`browser-store`) done; still open: remaining nanostores stores, busy_timeout consistency, schema rename (**needs sign-off**).
4. Prefer cohesive helper extracts; characterization tests before risky splits.
5. Do **not** rename SQLite schema without explicit user sign-off.

---

## Meta-review evidence (Phase 0 — historical)

### 1. Test count — now 605+

Baseline original audits: **520**. Phase 2 added CamelModel characterization suite and retained full suite green at **605**.

### 2–5. B1/B2/mypy/file counts

Unchanged closures from Phase 0 evidence pack (B1a atomic writes, B2 db_writer docs, mypy gate `app/`, 176 files).

---

## Decisions locked

| # | Decision | Source |
|---|---|---|
| 1 | JSON boundary Option A — `CamelModel` | ratified |
| 2 | Lowest-risk-first order | ratified |
| 3 | Bug fixes separate from refactors | Ground Rule 3 |
| 7 | SQLite schema rename needs explicit sign-off | Ground Rule 5 |
| 8 | Phase 0 signed off | user 2026-07-13 |
| 9 | B21 filenames then CamelModel then callables | completed |
| 12 | Phase 2 signed off; Phase 3 unblocked | user 2026-07-14 |

---

## Phase 6 Bug Log (current)

| ID | Severity | Status |
|---|---|---|
| **B1 / B1a** | High | **CLOSED** |
| **B2** | Med | **CLOSED** |
| **B11–B16, B19, B21–B25** | various | See prior log; B21 **MOSTLY CLOSED** (WIRE TypedDict deferred) |
| **B18** | Med | **Pilot done** — `browser-store` → Zustand; other stores still nanostores |
| **B20** | Low | Dockerfile not re-verified |
| **—** | Low | `UsageRecord` name collision (usage CamelModel vs curator dataclass) — open |

---

## Recent commits (tip)

```
(see git log) Phase 3 SSE extract; Phase 2 residual naming; B21 TypedDict/callables; CamelModel batch
```

---

## B21 / naming notes

- App + test filenames closed
- Resolver + alias_mapping callables snake_case
- INTERNAL TypedDicts converted; AliasDict uses `alias_from_wire` / `alias_to_wire`
- WIRE TypedDicts intentionally camelCase until Phase 4

---

## CamelModel progress note

**COMPLETE** for `app/routers/` (0 BaseModel remaining). Characterization: `tests/test_camel_model*.py`.

---

## Phase 3 progress note

| Extract | From | To | Status |
|---|---|---|---|
| SSE format helpers | `stream_state.py` | `adapters/sse_format.py` | ✅ `6a88ed7` |
| OpenAI SSE helpers | `openai.py` | `adapters/openai_sse.py` | ✅ `7dd972a` |
| Proxy tool defs | `proxy_tools.py` | `adapters/proxy_tool_defs.py` | ✅ `d845192` |
| HTML helpers | `tool_definitions.py` | `services/tool_html.py` | ✅ `bb29e21` |

Approx sizes after extracts:

| File | ~Lines |
|---|---|
| `workbench.py` | 2011 (still open) |
| `anthropic.py` | 1277 (still open) |
| `tool_definitions.py` | 1302 |
| `memory_store.py` | 804 |
| `openai.py` | 493 |
| `proxy_tools.py` | 310 |
| `proxy_tool_defs.py` | 306 (new) |
| `stream_state.py` | 467 |

---

## Phase 4 progress note

| Item | Status |
|---|---|
| Missing indexes (`messages.sessionId`, `usageEvents.*`, `sessions.isArchived`, `blackboard.sessionId`, `examAttempts.examId`) | ✅ `5b21a50` |
| Schema camelCase→snake_case | **Deferred** — needs explicit sign-off |
| B18 nanostores → Zustand | **Pilot done** — `browser-store` on Zustand; remaining stores still nanostores |
| storage_key_migration busy_timeout consistency | Open / low priority |


### B18 Zustand pilot (2026-07-14)

- **Migrated:** `frontend/desktop/src/lib/browser-store.ts` (nanostores atom → Zustand)
- **Dependency:** `zustand` added to `frontend/desktop/package.json`
- **Consumer updated:** `RightDrawerBrowserSection.tsx` (`useBrowserDrawerStore`)
- **Imperative API kept:** `pushBrowserAction` / `clearBrowserDrawer` for SSE handlers

**Remaining nanostores modules (do not migrate in this pilot):**

| File | Notes |
|---|---|
| `src/lib/theme.ts` | `$themeMode`, `$textSize` + DOM/localStorage |
| `src/store/theme.ts` | re-export + `$theme` compat shim |
| `src/store/sessions.ts` | session list atom |
| `src/store/workspaces.ts` | workspace atom |
| `src/store/gateway.ts` | gateway status atom |
| `src/store/command-palette.ts` | palette open state |
| `src/store/chat-active-streams.ts` | active stream map |
| `src/sections/chat/queue-store.ts` | message queue |
| `src/sections/chat/chat-stream-manager.ts` | stream atoms |
| `src/components/shell/RightDrawerState.ts` | drawer open/section atoms |
| `src/hooks/useLogStream.ts` | log stream atom + `onMount` |

---

## What's next

1. ✅ Phase 0 + Phase 2 signed off.
2. ✅ Phase 3 first wave of extracts landed; continue with `anthropic` / `workbench` / `memory_store`.
3. ✅ Phase 4 missing indexes landed.
4. Later: finish B18 Zustand migration (remaining nanostores); schema rename (sign-off); Phase 7 feature testing.

---

## Open questions for the user

- Next Phase 3 target? (`anthropic` SSE/helpers / `workbench` slice / `memory_store` helpers)
- Approve SQLite schema rename planning? (high risk — not started)
- Delete leftover `refactor/b21-app-file-renames` refs?
