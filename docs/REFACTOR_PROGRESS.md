# Refactor Progress Tracker — August Proxy

> **Live tracker for the multi-session refactor of August Proxy.** Updated at
> the end of every session. Earlier audit/analysis docs are now in `docs/`
> with explicit "SUPERSEDED — DO NOT FOLLOW" headers; this file supersedes
> them for refactor-status questions.
>
> **Full pasteable handoff prompt for a new chat/model:**
> [`docs/REFACTOR_HANDOFF_PROMPT.md`](./REFACTOR_HANDOFF_PROMPT.md)
> (keep in sync when ending a session).

**Last updated:** 2026-07-14 (B21 **test filenames** closed — 62 renames + flake fix)
**Current branch state:** `master` tip (= `origin/master`, expect clean). Verify with `git rev-parse HEAD` — B21 tests on/after `1265716`.
**Verification baseline on master (2026-07-14):**
`pytest 604 collected` · `mypy app/ → 0 errors / 176 source files` ·
`ruff check app/ → All checks passed` · CI green on `refactor/b21-test-filename-renames`
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

1. Verify clean `master` matching `origin/master` (`git rev-parse HEAD`); B21 tests on/after `1265716`.
2. Optional cleanup: delete leftover `refactor/b21-app-file-renames` (local + origin) if still present — content already on master.
3. **Next code chunk (Phase 2 remainder):**
   - camelCase **callables** in `model_resolver` / `route_resolver`
   - camelCase **TypedDict fields** in `type_aliases` (JSON contract — careful)
4. Do **not** restart Phase 0 or re-merge closed historical branches.
5. Do **not** treat B21 filename renames as closing callables/TypedDict fields.

---

## Meta-review evidence (required before Phase 0 sign-off)

### 1. Test count 520 → 534 (+14) — accounted for; now 604

Baseline cited in earlier audits: **520**. At Phase 0 evidence pack:
**534** (= 520 + 14). **Current: 604** (full CamelModel router characterization suite).

CamelModel test files: `test_camel_model*.py` covering all converted routers
(+ agents, august, manage, skills, desktop_automation, terminal final batch).
Net vs original 520: **+84** (= 604).

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
| camelCase **test** filenames | **0** | B21 closed (`380ad2f`) |

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
| 9 | B21 app filenames first, then CamelModel one router at a time | B21 app + test filenames done; **all router bodies are CamelModel** |
| 10 | B21 = **filename rename only** — callables/TypedDict fields separate | still open for callables/TypedDict |
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
| **B21** | Med | **PARTIAL** — app + test filenames done; callables/TypedDict fields still open |
| **B22** | Med | **CLOSED** |
| **B23** | Low | **CLOSED** |
| **B24** | Low | **CLOSED** |
| **B25** | Low | **CLOSED** |
| **—** | Low | `UsageRecord` name collision (usage `CamelModel` vs curator `@dataclass`) — open |
| **—** | Low | `storage_key_migration` connection helper consistency — open, low priority |

---

## Recent commits (tip)

```
1265716 fix(tests): harden parallel subagent blackboard coordination test
380ad2f refactor(tests): rename 62 camelCase test modules to snake_case
ef20d67 docs(refactor): mark CamelModel router scale-up complete
1d66d4d refactor(terminal): convert legacy terminal bodies to CamelModel
dbc9469 refactor(desktop-automation): convert ActionRequest to CamelModel
e900f10 refactor(skills): convert skills router bodies to CamelModel
be14f92 refactor(manage): convert manage router bodies to CamelModel
d2f5d10 refactor(august): convert alias manage bodies to CamelModel
```

---

## B21 scope note (explicit)

B21 **filenames** are closed on master:
- App modules: `af9fce9` + `4f94269`
- Test modules: `380ad2f` (62 renames; flake harden `1265716`)

B21 remains **filename rename only**. Public callables and TypedDict fields
inside the renamed app modules stay camelCase until their own chunks:

- `model_resolver.py`: `resolveOrFallback`, `getAliasForModel`, `listAliases`, `getDefaultAlias`
- `route_resolver.py`: `resolveForModel`
- `type_aliases.py`: TypedDict keys such as `targetModel`, `apiFormat`, `baseUrl`, …

Leftover branch ref `refactor/b21-app-file-renames` (if present) is redundant —
safe to delete locally and on origin.

---

## CamelModel progress note

| Status | Detail |
|---|---|
| **Router bodies** | **✅ COMPLETE** — 0 `BaseModel` subclasses remain under `app/routers/` |
| **CamelModel count** | **40** classes in `app/routers/` |
| Final batch | `agents`, `august`, `manage`, `skills`, `desktop_automation`, legacy `terminal` (`15774e1`…`1d66d4d`) |

`CamelModel` base: `app/models/camel_base.py` (`alias_generator=to_camel`,
`populate_by_name=True`). When dumping to service dicts that expect camelCase
keys, use `model_dump(by_alias=True)` (see `agents` updateAgent, `terminal_routes`).

Query params and SQLite column names remain camelCase where applicable (Phase 4).

---

## What's next

1. ✅ Phase 0 signed off; CamelModel routers complete; B21 app + test **filenames** complete.
2. **Next Phase 2 chunks:** resolver callables; TypedDict fields (JSON contract).
3. Later: B18 Zustand; B20 Dockerfile; Phase 3 large-file splits; SQLite index gaps; schema rename (sign-off required).
4. Out of scope for this refactor: AUG.md proxy injection; Feature Flow Visualization UI.

---

## Open questions for the user

- Next Phase 2 chunk: callables vs TypedDict fields?
- Delete leftover `refactor/b21-app-file-renames` refs?
- Manual CI loop (default) vs automation
