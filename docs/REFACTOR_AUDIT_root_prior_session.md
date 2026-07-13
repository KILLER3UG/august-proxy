# AUDIT.md — August Proxy Refactor, Phase 0

> **⚠️ SUPERSEDED — DO NOT USE AS CURRENT REFERENCE ⚠️**
>
> This is an even-earlier audit report (predates 2026-07-12). Many of its
> claims are stale: the codebase has since had its snake_case rename
> completed (PRs #7–13), B1 partially fixed, .bak cleanup landed, and the
> refactor pilot validated on `/api/models`.
>
> **For current refactor status, see `docs/REFACTOR_PROGRESS.md`.**
> For the current audit findings (this session), see the Phase 0 Audit
> Report delivered in chat on 2026-07-13.
>
> Preserved here for archaeology only. References that are now wrong:
> - "Phase 1 committed (`4a3e90a`)" → no such commit exists; Phase 1 of
>   the type-remediation plan was later superseded by the snake_case rename
>   + alias_generator approach in PRs #11–13.
> - Working-tree claims of "many .bak files / many modified files" → the
>   subsequent `chore/phase0-cleanup` branch landed the .bak cleanup
>   (`d58c882`, `8b0fa9f`).
> - Files named in `camelCase` (`memoryStore.py`, `providerSetupTool.py`,
>   `toolDefinitions.py`, etc.) → all renamed to snake_case by PRs #8, #9,
>   #10, #13.

> **Status: Phase 0 complete. This document is the deliverable. Do not start
> code changes until the findings below are confirmed.** The refactor spec
> (Sections 1–8) is assumed as the target; this audit maps the *actual* repo
> against it and flags where the spec overlaps with — or diverges from — work
> that is already in flight.

---

## 0. The single most important finding

**The backend type-remediation called for in the spec (§2 Pydantic models, §5.1
`as_str`/`cast` clean-up) is already planned and partially executed inside this
repo.** Two artifacts already exist:

- `docs/PHASE2_TYPE_REMEDIATION_PLAN.md` — a full sprint-by-sprint plan for
  per-provider Pydantic models using `extra="allow"` (identical in spirit to the
  spec), with the `app/models/` layout, strangler-fig migration order, and mypy
  burn-down targets.
- `docs/STATIC_ANALYSIS_ERRORS.md` — the error inventory that plan was derived
  from (mypy baseline 1,870 → 1,248 after Phase 1).

And the work is **live**: `backend-py/app/models/` already contains
`base.py`, `aliases.py`, `anthropic.py`, `openai.py`, `config.py`, `proxy.py`
(all modified today, 2026-07-09, in the current working tree). The git working
tree also shows a large set of uncommitted modifications across
`backend-py/app/adapters/*`, `backend-py/app/models/*`,
`backend-py/app/routers/providers.py`, `backend-py/app/services/*`, and many
`frontend/desktop/src/**` files (active "python-backend" branch work).

**Implication:** this refactor must *adopt and extend* the existing Phase-2 plan,
not re-plan it. Starting a parallel backend type effort would create merge
conflicts and duplicate the in-flight work. The audit below separates "already
covered" from "genuine gaps the existing plan does not address."

---

## 1. `[VERIFY]` — unknowns filled in

| Item | Finding | Source |
|------|---------|--------|
| Backend framework | **FastAPI** (Python). `requires-python >=3.12`; `mypy.ini` targets 3.12. README claims "3.13" — minor doc drift. | `backend-py/pyproject.toml`, `backend-py/mypy.ini`, `README.md` |
| Frontend build tool | **Vite** (`vite.config.ts`). React 19, `react-router-dom` 7. | `frontend/desktop/package.json`, `vite.config.ts` |
| TypeScript strict mode | **`strict: true`** — ON. **`noUncheckedIndexedAccess` — NOT set** (spec §3 wants it). | `frontend/desktop/tsconfig.json` |
| Frontend state mgmt | **nanostores** (in use). Spec §3 suggests Zustand/Jotai — deviation; nanostores is acceptable for a single-user project, but this is a decision to confirm, not auto-change. | `frontend/desktop/package.json` |
| Frontend styling | Tailwind v3.4 **and** `@tailwindcss/postcss` v4 mixed — minor inconsistency. | `package.json`, `tailwind.config.cjs`, `postcss.config.js` |
| Repo layout | **Monorepo, single git repo**: `backend-py/` (Python API), `frontend/desktop/` (React SPA), `frontend/src-tauri/` (Tauri shell), plus `web-dist/`, `data/`, `skills/`, `docs/`. | root `ls`, `README.md` |
| Deployment target | **Docker intended** (`Dockerfile` + `docker-compose.yml`). **But the `Dockerfile` is STALE/BROKEN**: `CMD ["node", "backend/index.js"]` and `docker-compose.yml` mounts `./backend:/app/backend`, while the real backend is Python FastAPI in `backend-py/` and **no `backend/` directory exists**. This is a deployment defect, not a refactor concern — see §4/§5. | `Dockerfile`, `docker-compose.yml` |
| Test coverage (backend) | **73 test files / ~584 test functions.** Strong: workbench, memory, adapters, clients, gateway. **Thin/absent:** providers (thin), MCP tool invocation (only `testWorkbenchMcpTools.py`), `models` package (none), retrieval/RRF (none), and most routers. | `backend-py/tests/` (counted), `docs/STATIC_ANALYSIS_ERRORS.md` |
| Test coverage (frontend) | **62 test files** (Vitest + RTL). Concentrated in `sections/chat`, `store`, `lib`, `api`. | `frontend/desktop/src/**/*.test.*` |
| CI | `.github/workflows/type-check.yml` runs `mypy app/` + `pytest -q` (backend) and `tsc` + `eslint` (frontend) on push/PR to `master`/`python-backend`. `release-desktop.yml` builds Tauri on tags. **No ruff / lint CI step.** | `.github/workflows/` |
| Lint/format tooling | **mypy only** for backend. **ruff: NOT configured.** No black/isort/flake8. No formatter. No `.pre-commit-config.yaml`. | `backend-py/pyproject.toml`, repo root `ls` |

---

## 2. In-flight effort to coordinate with (do not duplicate)

| Artifact | State | Relationship to this spec |
|----------|-------|---------------------------|
| `docs/STATIC_ANALYSIS_ERRORS.md` | Current | Baseline inventory. Spec §2/§5.1 already reflected here. |
| `docs/PHASE2_TYPE_REMEDIATION_PLAN.md` | Planned, Sprint 1 **executed** | Covers spec §2 + §5.1 exactly. **Adopt as the backend track.** |
| `backend-py/mypy.ini` | Committed | `--strict` target + per-module gradual overrides + third-party `ignore_missing_imports`. Keep. |
| `backend-py/app/jsonUtils.py` | Committed (Phase 1) | `as_str/as_dict/as_list/as_int/as_float` narrowing helpers. The spec's "strangler-fig" boundary helpers. |
| `eslint.config.js` | Committed | Flat config, `recommendedTypeChecked`, `camelcase` enforcement, tests relaxed. Covers spec §3 linting. |
| Uncommitted WIP | **Working tree dirty** | Large set of `M` files in adapters/models/routers/services + frontend. **Refactor must build on a clean, committed base or risk conflict.** |

---

## 3. §5 known trouble spots — cross-checked against real code

| Spec item | Status | What the code actually shows | Covered by existing Phase-2 plan? |
|-----------|--------|------------------------------|-----------------------------------|
| **§5.1** Provider payload typing (`as_str`/`as_dict`/`cast`) | **In progress** | `jsonUtils.py:21-45` defines 5 helpers; **~185 call sites** (`as_str`≈97, `as_dict`≈39, `as_list`≈26, `as_int`≈23, `as_float`=0) + **17 bare `cast(`**. Heavily concentrated in `adapters/anthropic.py` (≈117 of the helper calls). | **Yes** — Sprint 3/4 target `anthropic.py`/`openai.py`/`workbench.py`. |
| **§5.2** MCP schema `inputSchema` vs `input_schema` | **No active bug, but latent risk** | Both keys exist and are *currently* bridged consistently (MCP protocol side uses `inputSchema` per `services/tools/mcpClient.py:111,152`; internal canonical uses `input_schema`/`parameters`). But the conversion is **duplicated across ~10 sites** (`proxyTools.py:98,102,159,164`, `mcpClient.py:152`, `base.py:195`, `retrieval.py:100`, `toolBridges.py:48`, `workbench/validator.py:47`, `workbench.py:1515`, `modelTools.py:33`) each doing `func.get('input_schema', …)`. No single typed model. | **No** — Phase-2 plan models *tool definitions* but does not canonicalize the MCP schema key. **Gap.** |
| **§5.3** `fallbackContextWindows` staleness | **Partial / misnamed** | Literal `fallbackContextWindows` does not exist. Real mechanism: `services/modelService.py:48 _getContextWindow()` (single owner) falls back to a hardcoded `128000` (`modelService.py:58-59`, repeated inline at `:114,121,125,126,140`) plus a static `_STATICModelLists` table (`:38`) that is **not updated when providers change limits**. Default `128000` also duplicated in `routers/providers.py:107,251,273`, `configService.py:55`, `models/config.py:15`. | **Partially** — `models/config.py` exists but does not centralize the default/static table. **Gap: extract one config-owned constant + table.** |
| **§5.4** `ruleInstructions` / AGENT.md reaching the model | **Misnamed; real gap + test candidate** | Spec's `ruleInstructions`/`AGENT.md` do not exist. Real mechanism is **AUG.md** → system prompt: loaded by `services/augDirectiveService.py:67` (`_AUG_FILENAME='AUG.md'`), threaded in workbench path `workbench.py:346-352` → `buildSystemPrompt` (`workbench.py:358/723`) → `services/memory/contextBuilder.py:182 buildSystemPrompt()`. **On the raw proxy path (`/v1/*`) AUG.md is NOT injected** — system blocks come straight from the client request (`adapters/anthropic.py:114,145,150`). | **No** — not in Phase-2 plan. **Gap: add a regression test on `contextBuilder.buildSystemPrompt` asserting AUG.md body appears; decide whether proxy path should also inject (behavior question — see §5).** |

---

## 4. Structural findings

### 4.1 God files (maintainability risk)
| Lines | File | Role |
|------:|------|------|
| 1566 | `app/services/workbench/workbench.py` | Streaming chat engine, tool dispatch, plan/approval, system-prompt build. Docstring admits it's a 3,675-line JS port. |
| 981 | `app/adapters/anthropic.py` | Anthropic↔OpenAI translation, SSE, managed-tool loop. 3,408-line JS port. |
| 660 | `app/services/toolDefinitions.py` | All built-in tool handler registration. |
| 625 | `app/services/memoryStore.py` | Core SQLite brain persistence. |
| 467 | `app/providers/clients/base.py` | Shared HTTP/SSE + retry. |
| 434 | `app/adapters/openai.py` | Mirror of `anthropic.py`. |

These two (`workbench.py`, `anthropic.py`) are the highest-leverage refactor
targets and already the Phase-2 focus.

### 4.2 Circular imports
**None found** (AST import graph, direct + 1-level, all 171 modules). Safe to
refactor incrementally.

### 4.3 Dead code / artifacts (cheap cleanup, separate from behavior)
- `backend-py/app/database.py` — entire body is `"REMOVED IN PHASE 0"` docstring; **zero importers**. Safe delete.
- `UsageRecord` **duplicated** in `app/routers/usage.py` and `app/services/skills/curator.py` — review for consolidation.
- **63 `.bak` files** across `app/`, `scripts/`, `tests/`, `frontend/` — leftover backups. Exclude from refactor; delete in a cleanup pass.
- `backend-py/verifyAll.py`, `backend-py/C:Usersrobermypy_output.txt`, `mypy_base.txt`, `mypy_after_a.txt` — mypy dump artifacts (hundreds of KB). Not source.
- `backend-py/app/august_proxy.egg-info/`, `*.tsbuildinfo` (committed) — build artifacts that should be gitignored.

### 4.4 Tooling / packaging nits
- **ruff absent** (spec §2 requires it). Setup task for Phase 1.
- `backend-py/pyproject.toml` declares dev deps **twice** — `[project.optional-dependencies].dev` (pytest 8.3) **and** `[dependency-groups].dev` (pytest 9.1). Conflicting; consolidate.
- README doc drift: says Python 3.13 (code targets 3.12); references `frontend-src/` (actual `frontend/desktop/`); `Dockerfile` broken (see §1/§5).
- `tsconfig.json` missing `noUncheckedIndexedAccess` (spec §3).

---

## 5. Risk-ranked findings

| # | Finding | Risk | Impact | Action |
|---|---------|------|--------|--------|
| 1 | **Uncommitted WIP** on active `python-backend` branch (dirty tree across adapters/models/routers/frontend) | High | Merge conflicts if refactor builds on top | **Coordinate:** commit/stash current WIP or branch from clean `master` before starting. Blocking for Phase 1. |
| 2 | **Dockerfile / compose broken** (`node backend/index.js`, `./backend` mount; backend is Python) | High | App will not boot in Docker as documented | **Separate defect** — flag for its own fix; do not silently fold into refactor (anti-goal: no unapproved behavior change). |
| 3 | **MCP `inputSchema`/`input_schema` dual-key sprawl** (~10 duplicated bridges) | Med | Latent silent bug if one side drifts | Introduce one canonical tool-schema model + single `normalize()`; delete per-site fallbacks. (Gap vs existing plan.) |
| 4 | **Context-window hardcoded default `128000` + static table duplicated** across ~8 sites | Med | Stale limits underestimate silently | Centralize default + static table into one config-owned constant/module. (Gap vs existing plan.) |
| 5 | **AUG.md not injected on proxy path + no regression test** | Med | Config built but dropped → spec §5.4 class of bug | Add regression test on `contextBuilder.buildSystemPrompt`; decide proxy-path injection (behavior question → ask). |
| 6 | **God files** `workbench.py` (1566) / `anthropic.py` (981) | Med | Hard to test/refactor safely | Already Phase-2 target; keep incremental, test-backed splits. |
| 7 | **ruff not configured**; no formatter; no pre-commit | Low–Med | Lint/format debt; spec §2 requires ruff | Add ruff + pre-commit as a Phase 1 setup task; keep mypy. |
| 8 | **Dead code / `.bak` / mypy-dump artifacts** in tree | Low | Noise, accidental commits | Cleanup pass; gitignore artifacts. |
| 9 | **`noUncheckedIndexedAccess` off**; Tailwind v3/v4 mix; README drift | Low | Type-safety gap; doc confusion | Enable in tsconfig; fix README; align Tailwind. |
| 10 | **Thin/absent tests**: providers, MCP invocation, retrieval/RRF, `models`, most routers | Med | Spec §6 Phase 1 safety-net not met | Add characterization tests (routing, retrieval ranking, MCP call) before refactoring those paths. |

---

## 6. Recommended sequencing (so Phase 1+ align, not conflict)

1. **Resolve the WIP (finding #1) first.** Either land the current
   `python-backend` changes or branch from a clean `master`. Everything below
   assumes a stable base.
2. **Adopt `docs/PHASE2_TYPE_REMEDIATION_PLAN.md` as the backend type track.**
   Do **not** re-plan §2/§5.1. Continue its sprints (models → providers router →
   anthropic adapter → openai/workbench → sweep).
3. **Extend Phase 2 with the three genuine gaps it omits:**
   - §5.2 MCP schema canonicalization (single model + `normalize()`).
   - §5.3 context-window default/table centralization.
   - §5.4 AUG.md regression test (+ proxy-path decision).
4. **Phase 1 safety-net (spec §6) not yet satisfied** — add characterization
   tests the existing plan doesn't mention: routing/alias decisions,
   **retrieval/RRF ranking (currently NONE)**, MCP tool invocation. These are
   prerequisites before touching those modules.
5. **Tooling setup (spec §2):** introduce `ruff` (format+lint) and
   `.pre-commit-config.yaml`; keep `mypy.ini` as-is. Consolidate the duplicate
   dev-dep groups in `pyproject.toml`.
6. **Frontend track (spec §3/§4) is largely untouched by the existing effort**
   and should run **after** the backend is green:
   - Generate typed API client from the (now-accurate) OpenAPI schema
     (`openapi-typescript` + `openapi-fetch`) — currently hand-maintained
     `src/api/*` returning `any` (the source of ~613 eslint `any`-family errors).
   - Migrate ad-hoc `useEffect` fetching → TanStack Query, feature by feature.
   - Move to feature-folder layout incrementally (no mass file-move).
   - Decide Zustand/Jotai vs current nanostores (confirm, don't force).
   - Enable `noUncheckedIndexedAccess`.
7. **Cleanup pass (spec §7):** delete `database.py` stub, `.bak` files, mypy-dump
   artifacts; gitignore build artifacts. **Separate from behavior.**
8. **Dockerfile fix (#2) handled out-of-band** as its own change — flag to user,
   do not silently alter documented deploy behavior inside the refactor.

---

## 7. Open questions for the user (decisions before Phase 1)

1. **WIP base:** should I (a) wait for the current `python-backend` WIP to land,
   or (b) branch from clean `master` and proceed? *(Blocks start.)*
2. **Zustand/Jotai vs nanostores:** keep nanostores (works, smaller) or migrate
   per spec §3?
3. **AUG.md on the proxy path:** should `/v1/*` requests also inject AUG.md into
   the system prompt, or keep it workbench-only? *(Behavior change — needs
   explicit approval either way.)*
4. **Dockerfile:** fix now as a separate PR, or leave for later? (Not part of the
   refactor's behavior contract, but it's currently broken.)
5. **ruff:** confirm adopting ruff (spec §2) on top of the existing mypy setup.

---

## 8. Scope affirmation (anti-goals)

- No behavior changes without approval. Items #2 (Dockerfile) and #3 (AUG.md on
  proxy path) are behavior/defect fixes and are **flagged, not actioned**.
- Refactor in place; no rewrites. The existing Phase-2 plan is the in-place
  strangler-fig approach — consistent with this.
- Right-sized: no k8s / service mesh / multi-region ceremony introduced.
- Every deleted/changed path keeps a passing test proving equivalent behavior.

---

### Deliverable status
**Phase 0 complete.** Awaiting confirmation on §7 before proceeding to Phase 1
(safety net: characterization tests + ruff/pre-commit setup).
