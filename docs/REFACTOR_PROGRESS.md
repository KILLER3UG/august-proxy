# Refactor Progress Tracker — August Proxy

> **Live tracker for the multi-session refactor of August Proxy.** Updated at
> the end of every session. Earlier audit/analysis docs are now in `docs/`
> with explicit "SUPERSEDED — DO NOT FOLLOW" headers; this file supersedes
> them for refactor-status questions.

**Last updated:** 2026-07-13 (CamelModel usage router merged to master)
**Current branch state:** `master @ 40606d5` (= `origin/master`, clean working tree after tracker commit)
**Verification baseline on master (user + CI, 2026-07-13):**
`pytest 538 passed`; `mypy app/` / `ruff check app/` green on feature branch before FF merge
**CI:** green on `refactor/camelmodel-usage` @ `40606d5`; fast-forwarded onto `master`

### Phase 0 sign-off

**Signed off by user 2026-07-13** on the meta-review evidence pack (B1/B2/mypy/file
counts/test delta/gate). Phase 0 Audit baseline accepted. G5–G7 formally
**dropped** (feature branches absent on local and `origin`; only `master`
remains). Phase 2 scale-up and subsequent phases are **unblocked**.

---

## Meta-review evidence (required before Phase 0 sign-off)

### 1. Test count 520 → 534 (+14) — accounted for

Baseline cited in earlier audits: **520**. Current collect/run on
`master @ 6765b85`: **534 collected / 534 passed**.

| Added tests | Count | Commit | Why |
|---|---|---|---|
| `tests/testStorageKeyMigration.py` | **+6** | `2b9f9a7` (B22) | Regression for `memoryStore` table-name fix |
| `tests/test_camel_model.py` | **+4** | `c030ff6` (Step 4 / CamelModel pilot) | Boundary-translation characterization |
| `tests/test_db_writer_coverage.py` | **+1** | `3bc390e` (Step 2 / B2 cherry-pick of `795982a`) | Consolidation routes writes through `db_writer` |
| `tests/test_sqlite_safety.py` | **+3** | `3bc390e` (same B2 cherry-pick) | WAL + `busy_timeout` + direct-write safety |
| **Net** | **+14** | | **520 + 14 = 534** |

Transient +4 then −4 (does **not** affect current 534):
`tests/testMcpClientAtomicWrite.py` was added in `1b3e0d6` (B1a mcp) and
removed when B24 deleted dead `_saveConfig` (`420b80f` intent / deleted in
`fe4ed55`). That explains the brief **538** figure in an intermediate tracker
revision (534 + 4 mcp tests).

B16 function renames (`6765b85`) did **not** add tests — rename-only, 1:1.

### 2. B2 status — **CLOSED on master**

| Evidence | Value |
|---|---|
| Cherry-pick commit | `3bc390e` (`fix(db-writer): audit SQLite writes; correct heuristicsService queue docstring`) — rewrite of `795982a` |
| Merge commit | `894ecad` (`Merge branch 'cherry-pick/db-writer-coverage-795982a' into master`) |
| Ancestor of HEAD? | Yes (`git merge-base --is-ancestor 3bc390e HEAD` → 0; same for `894ecad`) |
| Test file present | `backend-py/tests/test_db_writer_coverage.py` — **1** test collected |
| Companion tests | `backend-py/tests/test_sqlite_safety.py` — **3** tests |
| Role documentation | `docs/ARCHITECTURE.md` § Data persistence (`8c53bab`) — keep queue; not a bug |

B2 was **document + characterization**, not a code defect. Closed.

### 3. B1 verification — **CLOSED** (grep evidence)

Command (run from `backend-py/` on `6765b85`):

```python
import os, re
hits = []
for root, dirs, files in os.walk('app'):
    if '__pycache__' in root: continue
    for f in files:
        if not f.endswith('.py'): continue
        path = os.path.join(root, f)
        for lineno, line in enumerate(open(path, encoding='utf-8'), 1):
            if re.search(r'write_text\([^)]*json\.dump', line) or re.search(r'\.write\(json\.dump', line):
                hits.append((path, lineno, line.strip()[:140]))
for h in hits: print(f'{h[0]}:{h[1]}: {h[2]}')
print('---total:', len(hits))
```

**Verbatim output:**

```
app\services\skills\curator.py:84: tmp.write_text(json.dumps(raw, indent=2), 'utf-8')
---total: 1
```

Manual follow-up on that sole hit (`curator.py:84–85`):

```python
tmp.write_text(json.dumps(raw, indent=2), 'utf-8')
tmp.replace(self._usagePath)   # atomic via pathlib.Path.replace → os.replace
```

So **0 non-atomic JSON write sites remain.** The five B1a sites previously
flagged are now on `write_json_atomic`:

| Former site | Status on `6765b85` |
|---|---|
| `aug_artifact_service.py` (3) | `write_json_atomic` at lines 110, 138, 232 |
| `gateway/session_bridge.py` (1) | `write_json_atomic` at line 57 |
| `tools/mcp_client.py` (1) | Writer removed with dead `_saveConfig` (B24, `420b80f`) |

`write_json_atomic` implementation (`app/atomic_write.py`): temp file in same
dir → `flush` + `os.fsync` → `os.replace`. Atomic on a single filesystem.

### 4. Mypy “22 errors” vs “0 errors” — reconciled

**Authoritative command (same as CI / this tracker):**

```text
cd backend-py && .venv/Scripts/python.exe -m mypy app/
→ Success: no issues found in 176 source files
```

(notes only: `annotation-unchecked` on a few untyped bodies — severity `note`, not `error`)

**Where “22 errors” came from:** it is **not reproducible on current master**.
`docs/REMAINING_MYPY_FIXES.md` is marked **STALE** and itself notes that at
`master @ 762f33b` mypy was already `0 / 174`. That doc’s older claims
(“1,002 errors”, branch `fix-mypy-properly`) refer to a pre-rename /
non-existent branch state. No live `mypy app/` run on `6765b85` produces 22
errors.

Config note: `mypy.ini` sets `[mypy-tests.*] ignore_errors = True`. Scope for
the green gate is **`mypy app/`**, not `mypy tests/`. Running `mypy tests/`
still reports success on imported app modules (85 files walked) with the same
notes.

### 5. File counts reconciled (B21 updated)

Counted on `6765b85` (PowerShell, excluding `__pycache__`):

| Path | Count |
|---|---|
| `backend-py/app/**/*.py` | **176** |
| `backend-py/tests/**/*.py` | **85** |
| **Total app + tests** | **261** |
| `app/` camelCase filenames | **3** |
| `tests/` camelCase filenames | **62** |
| **Total camelCase filenames (B21)** | **65 / 261 ≈ 25%** |

**App camelCase files remaining:**

- *(none after B21)* — renamed to `type_aliases.py`, `model_resolver.py`, `route_resolver.py`

(`jsonUtils.py` removed by B15 split → `json_narrowing.py` + `atomic_write.py`.)

Prior tracker figures (174/81/255 and 72 camelCase) are **superseded**. Drift
causes: B15 added a file (+1 app), CamelModel/`camel_base.py`, and test files
added above; some earlier counts under-counted subpackages.

### 6. Phase 2 integration gate — concrete items (no vague “steps 1–7”)

**Gate checklist (must all be true before CamelModel/identifier scale-up across remaining routers):**

| # | Concrete item | Status on `6765b85` |
|---|---|---|
| G1 | `chore/cleanup-post-merge` on master (`7833fb1`+`762f33b`) | ✅ |
| G2 | B2 / `db_writer` cherry-pick on master (`3bc390e`/`894ecad`) + ARCHITECTURE paragraph | ✅ |
| G3 | B1a non-atomic JSON writes closed (grep evidence above) | ✅ |
| G4 | CamelModel pilot on master (`c030ff6`+`b1d1217`) | ✅ |
| G5 | `fix/mypy-green` pre-merge review **or** branch confirmed gone | ✅ **Dropped** — branch absent; characterization tests remain on master |
| G6 | `chore/cleanup-unused-imports` review **or** branch confirmed gone | ✅ **Dropped** — branch absent |
| G7 | Stale feature branches dropped | ✅ **Dropped** — only `master` / `origin/master` remain |
| G8 | `pytest tests/` green | ✅ 534/534 |
| G9 | `mypy app/` green | ✅ 0/176 |
| G10 | `ruff check app/` green | ✅ |
| G11 | B15 `jsonUtils` split landed | ✅ `fe4ed55` |
| G12 | B16 remaining camelCase **function** APIs in `memory_store`/`proxy_tools`/`db_writer` | ✅ (`2c63762`, `6765b85`) |
| G13 | User explicitly approves Phase 0 / Phase 2 gate after reviewing evidence | ✅ **Signed off 2026-07-13** |

**Not gate blockers:** B18 (Zustand), B20 (Dockerfile), B21 (file renames), SQLite
schema snake_case migration (Phase 4, needs separate sign-off).

---

## File counts (authoritative — see evidence §5)

| Path | Count | Notes |
|---|---|---|
| `app/` | **176** | Matches `mypy app/` “176 source files” |
| `tests/` | **85** | |
| **Total** | **261** | |
| camelCase filenames | **62** | B21: 0 app + 62 tests (3 app files renamed) |

---

## Decisions locked

| # | Decision | Source |
|---|---|---|
| 1 | JSON boundary Option A — `CamelModel` + `alias_generator=to_camel` | ratified |
| 2 | Lowest-risk-first order | ratified |
| 3 | Bug fixes as separate diffs from refactors | Ground Rule 3 |
| 4 | B1 non-atomic JSON — fix then verify with grep | closed |
| 5 | B2 — keep `db_writer`, document role | closed (`8c53bab` + `3bc390e`) |
| 6 | B18 nanostores → Zustand relaunched (Phase 4 workstream) | open workstream |
| 7 | SQLite schema camelCase→snake_case needs **explicit** sign-off (not bundled with B16) | Ground Rule 5 — enforced in `6765b85` |
| 8 | Phase 0 evidence pack signed off; G5–G7 dropped; Phase 2+ unblocked | user 2026-07-13 |
| 9 | Next chunk order: B21 app filenames first, then CamelModel scale-up one router at a time | B21 done; CamelModel **usage** router merged (`40606d5`) - first scale-up after `models` pilot |

---

## Phase 6 Bug Log (current)

| ID | Severity | Status |
|---|---|---|
| **B1 / B1a** | High | **CLOSED** — grep shows 0 non-atomic sites; curator uses temp+`Path.replace` |
| **B2** | Med | **CLOSED** — documented + `3bc390e`/`894ecad` on master |
| **B11** | Med | Nest `backend-py/backend-py/tests/` claim was wrong / absent |
| **B12** | Low | `.bak` files still under `data/` (gitignored) — optional delete |
| **B13–B14** | Low | Dead-tracked docs/log removed via `66bd9de` |
| **B15** | Med | **CLOSED** — `fe4ed55` split to `json_narrowing.py` + `atomic_write.py` |
| **B16** | Low | **CLOSED** for function APIs — `db_writer` (`2c63762`), `memory_store`+`proxy_tools` (`6765b85`). SQL table/column names remain camelCase by design until Phase 4 sign-off |
| **B17** | Med | `fix/mypy-green` — **branch gone**; coverage files still on master (`test_db_writer.py`, `test_json_store_atomic.py`, etc.) |
| **B18** | Med | Open — nanostores still in desktop `package.json`; Zustand not installed |
| **B19** | Med | Stale mypy doc marked superseded |
| **B20** | Low | Dockerfile claim not yet re-verified |
| **B21** | Med | **PARTIAL** — app **filenames** closed on master (`af9fce9`+`4f94269`, FF merge). Filename-only; camelCase callables/TypedDict fields inside those modules intentionally unchanged. **62** camelCase test filenames remain. |
| **B22** | Med | **CLOSED** — `2b9f9a7` / `9a10b57` |
| **B23** | Low | **CLOSED** — `pre-commit>=4.6.0` in `pyproject.toml` (`420b80f`) |
| **B24** | Low | **CLOSED** — dead `_saveConfig` removed (`420b80f`) |
| **B25** | Low | **CLOSED** — `ARCHITECTURE.md` updated for `enqueue_write` / `atomic_write.py` in `635b2cc` |

---

## Recent commits (tip)

```
40606d5 refactor(usage): convert UsageRecord to CamelModel with snake_case fields
aa8930a docs(refactor): record B21 app-filename merge on master
4f94269 docs(naming): fix stale B21 path refs and record filename-only scope
af9fce9 refactor(naming): rename three remaining app camelCase modules to snake_case
320079e docs(refactor): record Phase 0 sign-off and open Phase 2+
```


---

## B21 scope note (explicit)

B21 app **filenames** are closed on `master @ 4f94269` (fast-forward of
`af9fce9` + `4f94269`). B21 was a **filename rename only**. Public callables
and TypedDict fields inside the renamed modules remain camelCase by design
for that chunk:

- `model_resolver.py`: `resolveOrFallback`, `getAliasForModel`, `listAliases`, `getDefaultAlias`
- `route_resolver.py`: `resolveForModel`
- `type_aliases.py`: TypedDict keys such as `targetModel`, `apiFormat`, `baseUrl`, …

Those identifiers are **not** closed by B21. Function/API snake_case conversion
and CamelModel scale-up are separate follow-ups. Do not treat the B21 merge
as closing the PEP 8 / naming-convention gap for this surface.

Feature branch `refactor/b21-app-file-renames` shares HEAD with master and is
safe to delete locally + on origin when desired.

---


## CamelModel progress note

Phase 2 CamelModel scale-up **started**. Pilot remains `models.py` (`c030ff6` / `b1d1217`). First post-pilot router: **`usage`** - `UsageRecord` -> `CamelModel` with snake_case fields (`40606d5`, FF onto master). Rough progress: **1 / ~32** routers after pilot (usage done). Characterization: `tests/test_camel_model_usage.py` (4 passed on master post-merge).

## What's next

1. Phase 0 signed off; B21 app filenames merged; CamelModel **usage** router on master (`40606d5`).
2. **Next:** CamelModel scale-up - one router per commit on a feature branch; push + CI before merge. Suggested low-risk next: `git.py`, or `sessions` / `mcp` / `cron`; or continue with routers that already expose camelCase response fields.
3. Separate later chunks: remaining camelCase callables/TypedDict fields in renamed modules; B21 test renames (62 files); B18 Zustand; B20 Dockerfile; Phase 3 large-file splits.

---

## Open questions for the user

- Which next CamelModel router (`git.py` / sessions / mcp / cron, or another with camelCase fields)?
- Manual CI loop vs cron ping - defaulting to manual unless asked.
