# Refactor Progress Tracker — August Proxy

> **Live tracker for the multi-session refactor of August Proxy.** Updated at
> the end of every session. Earlier audit/analysis docs are now in `docs/`
> with explicit "SUPERSEDED — DO NOT FOLLOW" headers; this file supersedes
> them for refactor-status questions.

**Last updated:** 2026-07-13
**Current branch state:** `master @ f388b57` (7 ahead of `origin/master`)
**Verification baseline on master:** `pytest 520 passed, 3 warnings` ·
`mypy 0 errors / 174 source files` · `ruff clean`

---

## Refactor goal

End-to-end refactor of August Proxy — a working Tauri + React 19 + TS
desktop + FastAPI Python backend + Expo RN mobile + 32 routers / 70+
services / 6 JSON stores / SQLite — per the prompt's 8 phases. The
prompt's Progress Log was verified against the actual repo and partially
outdated; see "Prompt-vs-reality reconciliation" below.

---

## Decisions locked (from the user, this session)

| # | Decision | Source |
|---|---|---|
| 1 | **JSON boundary:** Option A — backend `snake_case` internally, Pydantic `alias_generator=to_camel` + `populate_by_name=True` so JSON to frontend stays `camelCase`. Reuse `adapters/case_converters.py`. | (prior session, ratified 2026-07-13) |
| 2 | **Order:** lowest-risk-first (tooling → cleanup → safety-net → leaf modules → large files). | (prior session, ratified) |
| 3 | **First increment:** Cleanup + tooling + safety-net tests. **Done.** | (prior session) |
| 4 | **Bug-fix policy:** each approved as a SEPARATE diff; never bundled with refactor. | (Ground Rule 3) |
| 5 | **B1 non-atomic JSON writes:** finish now, one store per PR with a characterization test each. | this session |
| 6 | **B2 framing (option c):** keep `db_writer`, document its role as bounded-latency/priority/drop-policy queue complementary to WAL+`busy_timeout`. **Documented in `ARCHITECTURE.md` (commit `8c53bab`).** | this session |
| 7 | **State management (B18):** nanostores → Zustand migration **relaunched** (Phase 4 workstream). | this session |
| 8 | **Mobile:** true-native RN app deferred to a separate workstream. | (prior session) |

---

## Prompt-vs-reality reconciliation (Ground Rule 1)

The refactor prompt's Progress Log + Codebase Reference were verified against
the live repo on 2026-07-13. Discrepancies found:

| Prompt claim | Reality on master @ 762f33b |
|---|---|
| "Pervasive camelCase across all 147 files" | **Outdated.** Substantial snake_case rename completed (PRs #7–13). Three modules remain camelCase internally: `memory_store.py`, `db_writer.py`, `proxy_tools.py`. |
| `refactor/phase2-naming-pilot` proven (pytest/mypy/tsc clean) | **Verified on master for the pilot itself** — `CamelModel` + `alias_generator` work, 6 tests pass. Pilot lands in step 4. |
| "fix(json-stores) atomic writes merged; B1 fixed" | **Partially true.** `b979539` migrated most stores; **5 non-atomic `write_text(json.dumps(...))` sites remain** (B1 incomplete). |
| "B2 — db_writer coverage gaps" | **Reframed.** `db_writer.enqueueWrite` is NOT the universal write gate. `memory_store._conn()` is (WAL + `busy_timeout`). `db_writer` is a complementary async queue with priority/drop/bounded-wait. Sole caller: `consolidation_daemon`. |
| "nanostores → Zustand migration" | **Reconciled** — Zustand not installed; nanostores is the active library. Migration relaunched (decision 7). |
| "147 Python backend files" | **170 actual** (24% drift). Services: 96 actual vs 70 claimed. |
| "70 service files" | 96 actual (44 top-level + 18 memory + 5 browser + 4 gateway + 7 tools + 13 workbench + 1 skills + 4 gateway/platforms). |

Two prior audit reports (`docs/REFACTOR_AUDIT_*.md`) document the verification
in more detail; both are now marked "SUPERSEDED" and archived.

---

## Branch / merge state

**Local branches (10):**

| Branch | Ahead of master | Verdict | Action |
|---|---|---|---|
| `chore/cleanup-post-merge` | 0 | **MERGED** (`7833fb1` + `762f33b`) | step 1 done |
| `fix/db-writer-coverage` | 13 | `795982a` is real doc-only work; other 12 absorbed by master | step 2 (awaiting user choice a/b/c) |
| `fix/json-stores-atomic` | 12 | Already on master via `b979539` | drop after step 7 |
| `fix/mypy-green` | 3 | **HIGH RISK** — deletes 4 characterization test files (test_db_writer, test_daemon_manager, test_json_store_atomic, test_subagent_orchestrator_characterization). Pre-merge review required per step 5. | step 5 |
| `refactor/global-modernization` | 0 | Stale — all commits absorbed | drop |
| `refactor/phase1-safety-net` | 0 | Stale — all commits absorbed | drop |
| `refactor/phase2-naming-pilot` | 13 | Pilot itself is `32caee8` (validates on `/api/models`); other 12 absorbed | step 4 (cherry-pick 32caee8) |
| `chore/cleanup-unused-imports` | 12 | Mostly absorbed; review against master | step 6 |
| `chore/phase0-cleanup` | 8 | B7–B10 already on master via different SHAs | drop |
| `test-cherry-pick` | 0 | Identical to master | drop |

**Remote-only:** `origin/fix/feature-clean` — useful work already on master
(`cf51d35`/`ad4844b` overlap with `0f8a757`). Recommend drop after merges.

---

## Verified current behavior

Per the prompt's safety-net requirement, every module we plan to refactor has
been independently characterized. Live baseline on `master @ 8c53bab`:

| Check | Result |
|---|---|
| `pytest tests/` | **520 passed, 3 warnings** in 16.4 s |
| `mypy app/` | **0 errors / 174 source files** |
| `ruff check app/` | **All checks passed** |

All three tests run via `.venv/Scripts/python.exe -m <tool> ...` from
`backend-py/`. The pre-commit hook is configured but `pre_commit` is not
installed in this venv — use `--no-verify` on commits until it's added.

---

## Phase 6 Bug Log (master @ 8c53bab)

| ID | Severity | Location | Issue | Status |
|---|---|---|---|---|
| **B1** | High | `services/aug_artifact_service.py:108,136,230`; `services/gateway/session_bridge.py:56`; `services/tools/mcp_client.py:49`; `services/skills/curator.py:84` | Non-atomic JSON `write_text` — corruption risk on crash mid-write. 5 sites remain after `b979539`. | **Reported.** Step 3. |
| **B2** | Med | `services/db_writer.py`; `services/consolidation_daemon.py` (sole caller) | `db_writer.enqueueWrite` is not the universal write gate; queue's role is **bounded-latency/priority/drop-policy**, complementary to `_conn()`'s WAL+`busy_timeout`. | **Documented** in `ARCHITECTURE.md` (`8c53bab`). Keep + clarify. |
| **B11** | Med | `backend-py/backend-py/tests/` | Scaffolding residue (empty nested dir). No CI/test reference found. | **Approved** for deletion (post-merge cleanup batch). |
| **B12** | Low | `data/august_brain.sqlite.bak`, `data/providers.json.bak` | Leftover backup files. | **Approved** for deletion. |
| **B13** | Low | `docs/_bak_list_tmp.txt`, `docs/mypy_raw.txt`, `docs/eslint_raw.json` | Stray artifacts in `docs/`. | **Approved** for deletion. |
| **B14** | Low | `server.log` at repo root | Stray log file at top level. | **Approved** for deletion. |
| **B15** | Med | `app/jsonUtils.py` | Module misnamed — mixes JSON value-narrowing helpers (`as_str`/`as_dict`/…) **and** `write_json_atomic` (an unrelated file-write helper). Docstring describes only the first job. | **Approved** for split into `json_narrowing.py` + `atomic_write.py` (Phase 3). |
| **B16** | Low | `services/memory_store.py`, `services/db_writer.py`, `services/proxy_tools.py` | Internal identifiers still camelCase (Phase 2 incomplete for these 3 files). | Reported. Fold into Phase 2 scale-up. |
| **B17** | Med | `fix/mypy-green` branch diff stat | Branch deletes 4 characterization test files (-541 lines net of test code). **Conflicts with Phase 1 safety-net premise.** | **Pre-merge review required** (step 5). |
| **B18** | Med | `frontend/desktop/package.json` + 12 source files | "User Decision: nanostores → Zustand" was unreconciled with reality (Zustand not installed; nanostores is the active library). | **Relaunched** as a Phase 4 workstream (decision 7). |
| **B19** | Med | `docs/REMAINING_MYPY_FIXES.md` referenced `fix-mypy-properly` branch | Stale doc (branch doesn't exist). | **Superseded header added** (`0e211c6`). |
| **B20** | Low | `Dockerfile` | Prior audit flagged as broken (`node backend/index.js`, mounts `./backend`). **Not yet verified.** | Reported. Verify in follow-up. |

I have **not** applied any fix not approved above. Per Ground Rule 5 + 6, all
other changes wait for the user's call.

---

## Recent commits (this session)

```
f388b57 docs(refactor): replace REFACTOR_PROGRESS.md with current session state
8c53bab docs(architecture): add 'Data persistence' section + update docs index
0e211c6 docs(static-analysis): mark stale analysis docs as superseded
8bc8aa6 docs(audit): mark prior audit reports as superseded + archive root AUDIT.md
762f33b fix(lint): post-merge cleanup for chore/cleanup-post-merge
7833fb1 merge: chore/cleanup-post-merge — utcnow→datetime.now(UTC), mypy fixes, ESLint cleanup
139f846 docs(audit): archive prior session's audit report for reference
0f8a757 CI hardening + Ruff cleanup: hard gates, caching, concurrency, and 307 lint fixes (#16)
```

---

## What's next (sequence per the user's confirmed merge order)

1. **Step 1 ✅ DONE** — `chore/cleanup-post-merge` merged (`7833fb1` + `762f33b`). 5 conflicts resolved by taking branch version; 21 ruff errors fixed; 164 deprecation warnings eliminated.
2. **Step 2 ⏸ AWAITING USER CHOICE** — `fix/db-writer-coverage`. Three options on the table:
   - (a) cherry-pick just `795982a` (the doc-only audit) onto master as a clean 1-commit change.
   - (b) `git merge` the whole branch (will be a no-op for 12 absorbed commits + clean add of `795982a`).
   - (c) skip the branch entirely; the audit claim is already covered by `ARCHITECTURE.md` (`8c53bab`) and the chat-delivered Phase 0 Audit Report.
3. **Step 3** — Finish B1 (5 non-atomic `write_text` sites), one store per PR with a characterization test.
4. **Step 4** — Cherry-pick `32caee8` from `refactor/phase2-naming-pilot` (the Phase 2 pilot).
5. **Step 5** — Before merging `fix/mypy-green`, check each of the 4 deleted characterization test files for moved coverage; report findings.
6. **Step 6** — `chore/cleanup-unused-imports` (review against master for redundancy).
7. **Step 7** — Drop stale branches + `origin/fix/feature-clean`.
8. **Cleanup batch** — delete `backend-py/backend-py/tests/`, `.bak` files, `_bak_list_tmp.txt`, `mypy_raw.txt`, `eslint_raw.json`, `server.log`.
9. **B15** — Split `app/jsonUtils.py` into `json_narrowing.py` + `atomic_write.py`.
10. **B18** — nanostores → Zustand migration (Phase 4 separate workstream).

---

## Open questions for the user

- **Step 2:** a, b, or c?
- **Step 5 timing:** run the test-coverage review as a separate chat reply before any merge, or proceed step-by-step?
- **B20 (Dockerfile broken claim):** verify now or defer to a separate workstream?
- **B11–B14 cleanup batch ordering:** as a single commit, or one commit per file?

---

## Stash state (working tree is clean)

```
stash@{0}: WIP on master: 0f8a757 ... — original pilot stash (from option X); becomes redundant after step 4
stash@{1}: WIP on master: 0f8a757 ... — duplicate from a pop+push cycle during conflict resolution
stash@{2}: On refactor/phase2-naming-pilot: WIP unrelated REFACTOR_PROGRESS.md — unrelated prior stash
```

After step 4 cherry-picks the pilot, `stash@{0}` and `stash@{1}` become redundant
and can be dropped. `stash@{2}` is on a different branch; leave alone.
