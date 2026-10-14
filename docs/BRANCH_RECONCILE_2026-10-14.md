# Branch reconcile — measured report (2026-10-14)

Status: Stage 0 executed and decided. Verification + read-only investigation; **no new commits were
made in this pass**. All four decisions from the 2026-10-13 plan were resolved on 2026-10-14 (§6)
and the approved local cleanup is done. The backend full-suite verdict is in (Validation): exactly
one red test, an environment-caused Quartus OOM, not a code regression. Stages 1–4 are unblocked.

Supersedes the 2026-10-13 draft plan wherever the tree has moved. Everything below was re-measured
on `master` @ `fecbd979` (2026-10-14, ~00:10–01:40 GMT+8).

---

## 1. What moved since the plan was drafted

| Claim in the 2026-10-13 plan | Measured now |
|---|---|
| 0.1 fix uncommitted on master (+38 / +94) | **Landed.** `c1d06c6e`, `656e29fe`, `bb673118` (prepare in `a506af60`); `tests/test_memory_part21_oq5_retire.py` is committed; targeted run **32/32 pass** |
| `scratch_r7_headings.test.tsx` untracked and collected | **Gone** — absent from the tree and from every ref; its four probe cases now live in `ChatMarkdown.test.tsx` (§3) |
| Working tree carries only the 0.1 files | Now also carries in-flight markdown-math work (§6) |
| "**8** `archive-superseded-*` tips are not ancestors" | **9** tags exist; all 9 are not ancestors. The plan's own list had nine rows under a count of eight |
| master position vs origin | master `fecbd979`, **5 ahead** of `origin/master` `806dc3e1` (4 security fixes + 1 circuit test) |

## 2. Stage 0.0 — the merge request, re-measured

Conclusion unchanged: **there is nothing to merge.** All five refs are ancestors of `master`
with 0 unique commits.

| Ref | Tip | unique vs master | Ancestor of master |
|---|---|---|---|
| `harness-skill-autonomy` | `05632551` | 0 (103 behind) | YES |
| `master-merge` | `0980f3f1` | 0 (111 behind) | YES |
| `master-ready` (worktree `C:/Dev/august-harness-wt`) | `60bb43bb` | 0 (81 behind) | YES |
| `backup/harness-autonomy-premerge` | `3d0763ad` | 0 (140 behind) | YES |
| `origin/harness-skill-autonomy` | `453c706b` | 0 (113 behind) | YES |

The useful work is the reconcile below, not a merge.

## 3. Stage 0.1 / 0.2 — both already done on master (verified, not re-executed)

**0.1 — the consolidation fix landed.** The savepoint-ordering fix is in the source:
`consolidation.py:494-503` commits with no `RELEASE SAVEPOINT` before `brain_commit`, and the
`conn.in_transaction` probe is at `:528`. The tests are committed
(`test_memory_part21_oq5_retire.py`, amended by the fix commits) and pass: **32 passed** in the
targeted run. The prove-red step from the plan was *not* re-run this session (the fix is no longer
revertible-in-place); the failure shape it pins is documented in the comments at
`consolidation.py:494-550` and covered by those tests.

**0.2 — the scratch test is gone (deletion route).** `scratch_r7_headings.test.tsx` exists on no
ref (`git log --all -- '*scratch_r7_headings*'` is empty). Its four probe cases were verified
present in the real heading test file `ChatMarkdown.test.tsx`:

- table-then-`===` — lines 395 and 405 (`'| a | b |\n| --- | --- |\n| 1 | 2 |\n\n# After a table'`, `'| a | b\n==='`)
- CRLF — line 401 (`'Title\r\n=====\r\n\r\nCRLF setext'`)
- setext-after-`<div>` — lines 306-308 (the `Sub\n---\n` demote case)
- `#######` — line 415 (`'####### seven is not a heading'`)

Targeted run of that file plus the new math test: **37/37 pass**. So decision 4 in the plan is
**moot** — it was resolved by deletion with coverage preserved.

## 4. Stage 0.3 — content reachability (the table the plan promised)

Method: per tag, list unique commits (`git rev-list master..<tag>`) and files touched
(`git show --stat`), then test reachability on master two ways — `git log master -- <file>` for a
landing commit, and grepping the symbol in the current tree. `git apply --reverse --check` was
**not** used as evidence (inconclusive under 100+ commits of drift, as the plan said).

### 4.1 The nine archived tags — all reachable

| Tag (`archive-superseded-*`) | Unique commits | Files touched | On master? | Verdict |
|---|---|---|---|---|
| `agent-audit-1-backend` | `178b4bca` (2026-08-11) | `FINDINGS-AGENT-1-BACKEND.md` (255, repo root) | Yes — same file at `docs/audit-2026-08/FINDINGS-AGENT-1-BACKEND.md`, added by `7583404f` | **content present via `7583404f`** (path moved root → `docs/audit-2026-08/`) |
| `camelmodel-desktop-automation` | `f9436fef` | `routers/desktop_automation.py` (+12/-3), `tests/test_camel_model_desktop_automation.py` (+53) | Yes — `class ActionRequest(CamelModel)` at `desktop_automation.py:117`; test file present; landed `dbc9469d` (same subject) | **content present via `dbc9469d`** (verbatim) |
| `phase3-extract-anthropic-sse` | `d61f9cf`, `a64312b` | `services/memory_schema.py` (+300), `adapters/anthropic.py` (-136), `adapters/anthropic_sse.py` (+120), `tests/test_anthropic_sse.py` (+78) | Yes — `anthropic_sse.py` + `test_anthropic_sse.py` present; landed `676bddb6`; its other commit (schema extract) via `61067dc9` | **content present via `676bddb6` + `61067dc9`** |
| `phase3-extract-memory-schema` | `374cd942` | `services/memory_schema.py` (+300), `memory_store.py` (-50) | Yes — `memory_schema.py` present, landed `61067dc9`; later evolved by `7b6bf5f8` (snake_case migration), and `memory_store` is now a package | **content present via `61067dc9`** (evolved since) |
| `phase3-extract-openai-sse` | `8f513fd4` | `adapters/openai.py` (-131), `adapters/openai_sse.py` (+99), `tests/test_openai_sse.py` (+78) | Yes — both files present, landed `7dd972a1` (same subject) | **content present via `7dd972a1`** |
| `phase3-extract-workbench-sessions` | `ffa85ad8`, `13c7d362` | `services/workbench/sessions.py` (+353), `workbench.py` (-312, +24 re-exports) | Yes — `sessions.py` landed `22864e4b`; the F401 re-export block is at current `workbench.py:267-278` (`_statusSubscribers = _sessions_mod._statusSubscribers`, …) | **content present via `22864e4b`** |
| `phase4-busy-timeout-and-schema-plan` | `4b8bb560`, `05120dce` | `lib/storage_key_migration.py` (+18/-4), `docs/PHASE4_SQLITE_SCHEMA_RENAME_PLAN.md` (+255) | Fix yes — `PRAGMA busy_timeout` at `storage_key_migration.py:40`, landed `ab2aa281`. **Plan doc genuinely absent** from master | fix **content present via `ab2aa281`**; doc **obsolete by design** — the rename was executed differently (`7b6bf5f8` + `services/schema_rename_migration.py`) |
| `phase4-missing-indexes` | `caa15610`, `be8bcb47` | `memory_store.py` (+9), `tests/test_sqlite_safety.py` (+36); second commit is a duplicate of the OpenAI-SSE extraction | Yes — `idx_blackboard_session` at `memory_schema.py:383`, `idx_examAttempts_exam` at `schema_rename_migration.py:186`, both asserted at `test_sqlite_safety.py:69` | **content present** (adapted to snake_case columns; test renamed `test_missing_indexes_exist`) |
| `phase4-zustand-pilot` | `c328bec8` | `frontend/desktop/package.json`, `src/lib/browser-store.ts`, `RightDrawerBrowserSection.tsx`, `docs/REFACTOR_PROGRESS.md` | Yes — `"zustand": "^5.0.14"` in package.json; `browser-store.ts:6` imports `create` from zustand; landed `ea03312f` (same subject) | **content present via `ea03312f`** |

**Net: 9/9 reachable.** The word "superseded" in the tag names is now a *proven* fact, not a claim:
every tag's substance exists on master via a same-subject commit (the abandoned branches' work was
re-done on master directly). The only genuinely-absent artifact is one planning doc, and it is
obsolete by design. **There is nothing here to merge and nothing that needs a "keep vs delete"
content verdict — that question is now purely about archive hygiene (see §6).**

### 4.2 The seven stashes — all superseded in substance

| Stash | Files | Spot-check on master | Verdict |
|---|---|---|---|
| `stash@{0}` (2026-09-09) | `ChatThreadComposer.tsx` (+12/-6) — gates workspace chips on `messages.length === 0` | The gating is live at current `ChatThreadComposer.tsx:519-520` | **superseded** (landed; only the comment wording differs) |
| `stash@{1}` (2026-07-14, b21) | 11 files, settings UI + `routers/mcp.py`; deletes `useToolsConnections.ts` | `useToolsConnections.ts` absent from master; MCP registry-SoT at `mcp.py:35`; `settings-registry.ts` now 30 KB (evolved well past the stash's 10-line tweak) | **superseded in substance** |
| `stash@{2}` (2026-07-14) | untracked-only: `services/memory_schema.py` (+300) | Same extraction landed as `61067dc9` | **superseded** |
| `stash@{3}` (2026-07-14) | `REFACTOR_PROGRESS.md`, `package.json`, `RightDrawerBrowserSection.tsx`, `package-lock.json` — the zustand-pilot WIP | zustand dep + `browser-store` landed `ea03312f` | **superseded** |
| `stash@{4}` (2026-07-14) | `adapters/anthropic.py` (+36/-118) — SSE-extraction WIP | `anthropic_sse.py` present; imports at `anthropic.py` | **superseded via `676bddb6`** |
| `stash@{5}` (2026-07-14) | `adapters/proxy_tools.py` (+100/-334), `tests/test_adapters.py` | `proxy_tool_defs.py` present; re-export at `proxy_tools.py:35` | **superseded** |
| `stash@{6}` (2026-07-14) | `adapters/openai.py`, `services/tool_definitions.py` — SSE-extraction WIP | `openai_sse.py` present, landed `7dd972a1` | **superseded via `7dd972a1`** |

### 4.3 The bundle — recovery value is now zero

`august-worktree-branches-20260925_0104.bundle` (55 MB), re-listed: **17 heads, 16 ancestors of
master**, the one exception is `agent-audit-1-backend` (`178b4bca`) — whose single file is on master
at `docs/audit-2026-08/FINDINGS-AGENT-1-BACKEND.md` (§4.1). Nothing in the bundle is unreachable
from master, so it no longer protects anything. Keep-or-delete is an archive-hygiene decision, not a
technical blocker.

## 5. Plan-vs-tree discrepancies worth recording

1. The plan's "8 archived tags" was a miscount — there are **9** (the plan's own list had nine rows).
2. The plan's 0.1 CRLF caution is still open: `.gitattributes` covers only the three generated
   artifacts (`docs/api/openapi.json`, `docs/API_INDEX.md`,
   `frontend/desktop/src/api/gen/openapi.ts`) — **not** `backend-py/app/**`. That warning applies to
   any *future* backend commit from a Windows checkout; it did not block 0.1 (already landed).
3. `phase4-missing-indexes` contains a second copy of the OpenAI-SSE extraction (`be8bcb47`,
   same content as `8f513fd4` under the phase3 tag) — the branches were in sync-drift when archived.

## 6. Decisions (approved 2026-10-14) and executed cleanup

The four decisions requested by the 2026-10-13 plan, as answered:

1. **Stage 0.3 dispositions — keep as archive.** All 9 tags, 7 stashes, and the 55 MB bundle stay in
   place as provenance pointers; nothing deleted. The §4 table is the standing justification.
2. **Stage 1 — new artifact route**, not CSP relaxation. `GET /api/workbench/artifact/html` serves
   the document from its own origin with a document-scoped CSP; the frontend iframe uses
   `sandbox="allow-scripts"` without `allow-same-origin`; the shell CSP stays `script-src 'self'`.
3. **Stage order — Stage 1 → 2.** The live-preview route lands first, then the Anatomy skill port,
   so Anatomy figures animate instead of rendering inert.
4. **Stage 0.4 — local cleanup only.** Executed this session:
   - Worktree `C:/Dev/august-harness-wt` removed (clean tree, 0 unique commits, 81 behind master).
     Note: the first `git worktree remove` attempt was interrupted after it had already unlinked the
     worktree's `.git` file, leaving a `prunable` entry that plain `remove` refuses
     (`validation failed … '.git' does not exist`); `git worktree prune` + directory removal
     completed it. **If `remove` is ever interrupted mid-run, prune before retrying.**
   - Deleted local branches `master-merge`, `master-ready`, `backup/harness-autonomy-premerge` with
     safe `-d`. `harness-skill-autonomy` needed `-D` because it was 10 commits ahead of its
     *remote-tracking* counterpart (never pushed) even though merged to HEAD — its tip `05632551`
     was re-confirmed a full ancestor of master before the force delete.
   - Deliberately **not** done: deleting `origin/harness-skill-autonomy` (shared-state action
     requiring a push), and deleting any tag/stash/bundle.

## 7. Side observations (not part of the plan)

- The working tree carries **in-flight markdown-math work** not mentioned in the plan: modified
  `markdownHeadings.ts`, `ChatMarkdown.tsx`, `ChatMarkdown.test.tsx`; untracked
  `markdownMath.ts` + `markdown-math.test.ts`. It was left untouched by this pass. (The math tests
  pass when run directly: 37/37 across the two files.)
- The frontend suite is **red right now, and the cause is identified and bounded** (this matters
  because Stage 1's frontend numbers come from this suite): `src/test/v11_math_unicode.test.tsx`
  (committed, unmodified) fails 2 cases — `renders x^2 as unicode superscript` and
  `renders >= as unicode` — because the in-flight math rework deleted the old "convert
  LaTeX-style math to unicode before marked parsing" step in `ChatMarkdown.tsx` and replaced it
  with a post-parse KaTeX pass (`convertMathInHtml` from the new `markdownMath.ts`). **Proven
  in-flight-only**: with the three in-flight files stashed, that test file passes 7/7 (the stash
  was popped back immediately). So it is the old spec of the behavior being redesigned, not a
  master regression — whichever session lands the markdown-math work must update or delete
  `v11_math_unicode.test.tsx`. A third failure seen in one run (an Automations test timing out at
  5720ms against a 5000ms cap) is load flake; it did not appear in the other run.

## Validation

| Gate | Result |
|---|---|
| `uv run pytest tests/test_memory_part21_oq5_retire.py -q` (backend venv equivalent) | **32 passed** (the 55% coverage gate trips on a single-file run by design — the full suite is the gate) |
| Full backend suite, `-q -n auto` | **One red test, and it is environmental.** Plain runs reach 100% of tests but the pytest controller dies during finalization under memory pressure (exit 1, no summary printed — and `| tail -N` clips it anyway, since pytest's warnings summary prints last). The `-x --no-cov` run pinned it: `tests/test_circuit_golden.py::test_golden_fpga_compile_and_gate` — the golden FPGA compile shells out to Intel Quartus 18.1, and `quartus_map` died with Error (293007) "ended unexpectedly … sufficient memory" (peak ~4.8 GB); the test then asserts `ok is True` and fails on `{'installed': True, 'ok': False, 'exitCode': 3}`. **Toolchain OOM on this machine, not a code regression** — and it already sits in the pre-existing stale `lastfailed` cache from earlier sessions. The `-x` run otherwise stopped cleanly at **2500 passed, 2 skipped**; the full runs' progress dots show exactly one `F`. |
| Full frontend suite (`npm run test:frontend`) | Run 1: 1775/1777 (2 failed). Run 2: 1774/1777 (3 failed). Failures: 2 in `v11_math_unicode.test.tsx` — **proven caused by the in-flight markdown-math rework** (§7), not by master; plus 1 Automations timeout flake in run 2 only |
| `v11_math_unicode.test.tsx` against HEAD (in-flight files stashed) | **7/7 pass** — proves master's frontend is green and the red is the uncommitted rework |
| `ChatMarkdown.test.tsx` + `markdown-math.test.ts` targeted | 37/37 pass |
