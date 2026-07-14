# Refactor Progress Tracker — August Proxy

> **Live tracker for the multi-session refactor of August Proxy.** Updated at
> the end of every session. Earlier audit/analysis docs are now in `docs/`
> with explicit "SUPERSEDED — DO NOT FOLLOW" headers; this file supersedes
> them for refactor-status questions.
>
> **Full pasteable handoff prompt for a new chat/model:**
> [`docs/REFACTOR_HANDOFF_PROMPT.md`](./REFACTOR_HANDOFF_PROMPT.md)
> (keep in sync when ending a session).

**Last updated:** 2026-07-14 (CamelModel batch: sessions/mcp/cron + terminal_routes/subagent/config)
**Current branch state:** `master` tip (= `origin/master`, expect clean). Verify with `git rev-parse HEAD` — config CamelModel on/after `95e6b0e`.
**Verification baseline on master (2026-07-14):**
`pytest 570 collected` · `mypy app/ → 0 errors / 176 source files` ·
`ruff check app/ → All checks passed` · CI green per feature branch before each FF-merge
**CI note:** Prefer `backend-py/.venv` (3.12). System Python 3.11 can fail collection.

### Phase 0 sign-off

**Signed off by user 2026-07-13** on the meta-review evidence pack (B1/B2/mypy/file
counts/test delta/gate). Phase 0 Audit baseline accepted. G5–G7 formally
**dropped** (feature branches absent on local and `origin` for the old merge
queue). Phase 2 scale-up and subsequent phases are **unblocked**.

A later same-day session re-verified a stale chat Progress Log against the repo,
accepted the live tracker, completed B21 app filenames, and started CamelModel
scale-up (`usage`).

---

## Where to pick up (next session)

1. Verify clean `master` matching `origin/master` (`git rev-parse HEAD`); config CamelModel is on/after `95e6b0e`.
2. Optional cleanup: delete leftover `refactor/b21-app-file-renames` (local + origin) if still present — content already on master.
3. **Next code chunk:** CamelModel scale-up — **one router** on a feature branch.
   - Remaining: `agents`, `august`, `desktop_automation`, `manage`, `skills`, legacy `terminal.py` (~14 BaseModel classes).
   - Pattern: inherit `CamelModel`, snake_case fields, characterization tests, push, CI green, FF-merge, update this tracker.
4. Do **not** restart Phase 0 or re-merge closed historical branches.
5. Do **not** treat B21 as closing PEP 8 for callables/TypedDict fields inside renamed modules.

---

## Meta-review evidence (required before Phase 0 sign-off)

### 1. Test count 520 → 534 (+14) — accounted for; now 570

Baseline cited in earlier audits: **520**. At Phase 0 evidence pack:
**534** (= 520 + 14). **Current: 570** (CamelModel characterization suite expanded).

| Added tests | Count | Commit | Why |
|---|---|---|---|
| `tests/testStorageKeyMigration.py` | **+6** | `2b9f9a7` (B22) | Regression for `memoryStore` table-name fix |
| `tests/test_camel_model.py` | **+4** | `c030ff6` (CamelModel pilot) | Boundary-translation characterization |
| `tests/test_db_writer_coverage.py` | **+1** | `3bc390e` (B2) | Consolidation routes writes through `db_writer` |
| `tests/test_sqlite_safety.py` | **+3** | `3bc390e` (B2) | WAL + `busy_timeout` + direct-write safety |
| `tests/test_camel_model_usage.py` | **+4** | `40606d5` | Usage router |
| `tests/test_camel_model_git.py` | **+5** | `00904fe` | Git router |
| `tests/test_camel_model_memory.py` | **+7** | `5cc6255` | Memory multi-field |
| `tests/test_camel_model_sessions.py` | **+3** | `d4da6ec` | Sessions |
| `tests/test_camel_model_mcp.py` | **+3** | `ab8807b` | MCP |
| `tests/test_camel_model_cron.py` | **+3** | `93ab8b6` | Cron |
| `tests/test_camel_model_terminal_routes.py` | **+4** | `a26509e` | Terminal UI bodies |
| `tests/test_camel_model_subagent.py` | **+3** | `ec4d289` | Subagent |
| `tests/test_camel_model_config.py` | **+4** | `95e6b0e` | Config |
| **Net vs original 520** | **+50** | | **520 + 50 = 570** |

### 2. B2 status — **CLOSED on master**

Document + characterization; role in `docs/ARCHITECTURE.md`. Keep `db_writer`.

### 3. B1 verification — **CLOSED**

`write_json_atomic` in `app/atomic_write.py`. Grep showed 0 non-atomic JSON
write sites; curator uses temp + `Path.replace`. Re-verify if time passed.

### 4. Mypy — **0 errors / 176 files** on `mypy app/`

`docs/REMAINING_MYPY_FIXES.md` is **STALE**. Scope gate is `mypy app/`, not tests.

### 5. File counts (approx at handoff)

| Path | Count | Notes |
|---|---|---|
| `app/` | **176** | Matches mypy |
| `tests/` | **~86** | + usage CamelModel tests |
| camelCase **app** filenames | **0** | B21 closed |
| camelCase **test** filenames | **~62** | B21 remainder |

---

## Decisions locked

| # | Decision | Source |
|---|---|---|
| 1 | JSON boundary Option A — `CamelModel` + `alias_generator=to_camel` | ratified |
| 2 | Lowest-risk-first order | ratified |
| 3 | Bug fixes as separate diffs from refactors | Ground Rule 3 |
| 4 | B1 non-atomic JSON — fix then verify with grep | closed |
| 5 | B2 — keep `db_writer`, document role | closed |
| 6 | B18 nanostores → Zustand relaunched (Phase 4 workstream) | open workstream |
| 7 | SQLite schema camelCase→snake_case needs **explicit** sign-off | Ground Rule 5 |
| 8 | Phase 0 signed off; G5–G7 dropped; Phase 2+ unblocked | user 2026-07-13 |
| 9 | B21 app filenames first, then CamelModel one router at a time | B21 app done; CamelModel scaled to **26** classes / **14** BaseModel remain |
| 10 | B21 = **filename rename only** — callables/TypedDict fields separate | explicit scope note |
| 11 | Merge CamelModel routers via FF after CI green; one router per branch | practice established |

---

## Phase 6 Bug Log (current)

| ID | Severity | Status |
|---|---|---|
| **B1 / B1a** | High | **CLOSED** |
| **B2** | Med | **CLOSED** |
| **B11** | Med | Nest claim wrong / absent |
| **B12** | Low | `.bak` under `data/` — optional delete |
| **B13–B14** | Low | **CLOSED** |
| **B15** | Med | **CLOSED** — `json_narrowing.py` + `atomic_write.py` |
| **B16** | Low | **CLOSED** for function APIs; SQL names deferred to Phase 4 sign-off |
| **B17** | Med | `fix/mypy-green` **dropped**; coverage tests remain |
| **B18** | Med | **Open** — nanostores in use; Zustand not installed |
| **B19** | Med | Stale mypy doc marked superseded (+ B21 path notes) |
| **B20** | Low | Dockerfile not re-verified |
| **B21** | Med | **PARTIAL** — 3 app filenames done; 62 test renames + callables/TypedDict fields open |
| **B22** | Med | **CLOSED** |
| **B23** | Low | **CLOSED** |
| **B24** | Low | **CLOSED** |
| **B25** | Low | **CLOSED** |
| **—** | Low | `UsageRecord` name collision (usage `CamelModel` vs curator `@dataclass`) — open |
| **—** | Low | `storage_key_migration` connection helper consistency — open, low priority |

---

## Recent commits (tip)

```
95e6b0e refactor(config): convert config router bodies to CamelModel
ec4d289 refactor(subagent): convert subagent router bodies to CamelModel
a26509e refactor(terminal): convert terminal_routes bodies to CamelModel
93ab8b6 refactor(cron): convert CronJobCreate to CamelModel
ab8807b refactor(mcp): convert MCPServerCreate to CamelModel
d4da6ec refactor(sessions): convert MessageCreate to CamelModel
2e6eb01 docs(refactor): record CamelModel memory router merge on master
5cc6255 refactor(memory): convert memory router bodies to CamelModel
```

---

## B21 scope note (explicit)

B21 app **filenames** are closed on master (`af9fce9` + `4f94269`). B21 was a
**filename rename only**. Public callables and TypedDict fields inside the
renamed modules remain camelCase by design for that chunk:

- `model_resolver.py`: `resolveOrFallback`, `getAliasForModel`, `listAliases`, `getDefaultAlias`
- `route_resolver.py`: `resolveForModel`
- `type_aliases.py`: TypedDict keys such as `targetModel`, `apiFormat`, `baseUrl`, …

Those identifiers are **not** closed by B21. Function/API snake_case conversion
and CamelModel scale-up are separate follow-ups. Do not treat the B21 merge as
closing the PEP 8 / naming-convention gap for this surface.

Leftover branch ref `refactor/b21-app-file-renames` (if present) is redundant —
safe to delete locally and on origin.

---

## CamelModel progress note

| Router | Classes | Commit | Status |
|---|---|---|---|
| `models.py` | `ModelInfo`, `ModelList` | pilot | ✅ |
| `usage.py` | `UsageRecord` | `40606d5` | ✅ |
| `git.py` | `GitCommand` | `00904fe` | ✅ |
| `memory.py` | 5 bodies | `5cc6255` | ✅ |
| `sessions.py` | `MessageCreate` | `d4da6ec` | ✅ |
| `mcp.py` | `MCPServerCreate` | `ab8807b` | ✅ |
| `cron.py` | `CronJobCreate` | `93ab8b6` | ✅ |
| `terminal_routes.py` | 5 bodies | `a26509e` | ✅ |
| `subagent.py` | 3 bodies | `ec4d289` | ✅ |
| `config.py` | 6 bodies | `95e6b0e` | ✅ |
| Remaining | **~14** `BaseModel` | — | ❌ Next |

**Remaining routers:** `agents`, `august`, `desktop_automation`, `manage`, `skills`, legacy `terminal.py`.

`CamelModel` base: `app/models/camel_base.py` (`alias_generator=to_camel`,
`populate_by_name=True`). Counts: **26** CamelModel / **14** BaseModel in `app/routers/`.

Note: GET/query params stay unchanged — only request **bodies**. When dumping
to service dicts that expect camelCase keys, use `model_dump(by_alias=True)`
(see `terminal_routes`). SQLite column names remain camelCase (Phase 4).

---

## What's next

1. ✅ Phase 0 signed off; major CamelModel batch on master (simple + multi-field).
2. **Next session:** convert remaining routers (`agents` / `skills` / `manage` / …) one at a time.
3. Later separate chunks: remaining camelCase callables/TypedDict fields; 62 test renames; B18 Zustand; B20 Dockerfile; Phase 3 large-file splits; SQLite index gaps; schema rename (sign-off required).
4. Out of scope for this refactor: AUG.md proxy injection; Feature Flow Visualization UI.

---

## Open questions for the user

- Which next CamelModel router? (`agents` / `skills` / `manage` / `august` / `desktop_automation` / legacy `terminal`)
- Delete leftover `refactor/b21-app-file-renames` refs?
- Manual CI loop (default) vs automation
