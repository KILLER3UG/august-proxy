# Feature Inventory Test Matrix — RETIRED (Phase 7)

> **Retired 2026-10-17.** Every test this matrix maps was deleted on 2026-10-17 at
> the owner's request: `backend-py/tests/` (1,690 files), the 235 frontend
> `*.test.ts(x)` files with their `__tests__` trees, `frontend/desktop/e2e/` and
> the payload-integrity test — together with the CI jobs, npm scripts, pytest
> configuration and coverage ratchet that ran them.
>
> **Nothing below is a current claim.** The "Covered" headings and the table
> beneath them record what the suite used to exercise; they are kept because they
> are the only inventory of which surfaces had real coverage and which were only
> ever env-gated or mocked. Read it as history, never as verification you can run.
>
> The Phase 7 inventory *feature* is untouched — feature_flow emission and the
> inventory routes still exist in the app. Only the tests around them are gone.

## What “fully E2E proven” meant here

**This table described 2026-07-14. Every "Yes" below is now "no suite exists".**

| Layer | Was proven in CI? | How it was proven |
|---|---|---|
| Backend inventory surfaces | **Yes, then** | Full `pytest` on every push (included the Phase 7 gate) |
| Live backend feature_flow during tool/proxy actions | **Yes, then** | In-process emits asserted in Phase 7 + tool stage tests |
| Desktop UI consumers | **Yes, then** | `vitest` in CI (`npm run test -w frontend/desktop`) |
| Mobile companion | **Yes** | `npm run test -w frontend/mobile` (tsc + parity audit) — this one still runs |
| Live Slack/Discord *network* bots | **Gated, then** | Normalize + connect-without-token proven; real tokens needed env secrets |
| Live upstream LLM providers | **Gated, then** | `v2_real_llm` / `v3_proxy_real_llm` when keys were present |

Isolation: `isolatedData` was **autouse** so a full pytest run could not touch the
live brain. The guard itself (`app/lib/paths.py`, `assertPytestDataDirIsolated`)
is still in the code; the fixture is gone with the suite.

---

## Suite baselines (historical — none of these commands exist any more)

| Suite | Command it used | CI job it ran in |
|---|---|---|
| Backend pytest | `pytest -q -n auto` in `backend-py/` | `backend-mypy` |
| Phase 7 gate | `pytest tests/test_phase7_e2e_inventory.py -q` | (part of full pytest) |
| Desktop vitest | `npm run test -w frontend/desktop` | `frontend-tsc-eslint` |
| Mobile | `npm run test -w frontend/mobile` | `mobile-typecheck` (still runs; it is a typecheck) |

---

## Inventory → coverage (as audited 2026-07-14; all suites since deleted)

### 1. Multi-provider proxy / adapter translation — Covered

| Surface | Tests |
|---|---|
| Anthropic ↔ OpenAI translate / SSE | `test_adapters.py`, `test_anthropic_sse.py`, `test_openai_sse.py` |
| HTTP `/v1/messages` + `/v1/chat/completions` | `test_phase7_e2e_inventory.py`, `test_feature_flow.py` inject HTTP |
| Providers / alias / fallback | `test_providers.py`, `test_alias_service.py`, `test_fallback_service.py` |

### 2. Memory & learning — Covered

| Surface | Tests |
|---|---|
| memory_store / FTS | `test_memory*.py`, `test_fts_app_path.py` |
| Auto-memory + feature_flow | `test_phase7_e2e_inventory.py::test_phase7_memory_auto_save_emits_feature_flow` |
| Daemons / blackboard / exams | `test_daemon_manager*.py`, `v2*` / `v3*` suites |

### 3. Tools — Covered

| Surface | Tests |
|---|---|
| Tool registry / loop | `test_workbench_tool_*.py` |
| **Live backend during tool exec** | `test_phase7_tools_emit_live_backend_feature_flow` (exec+result stages) |
| Browser | `test_browser.py` |

### 4. Cognitive architecture — Covered

| Surface | Tests |
|---|---|
| Fleet / effort / subagents | `v2_model_fleet.py`, `test_workbench_effort.py`, `test_subagent*.py` |

### 5. Gateway platforms — Covered (automated)

| Surface | Tests |
|---|---|
| Base / auth / Telegram | `test_gateway_base.py`, `test_gateway_auth.py`, `test_gateway_telegram.py` |
| Slack normalize + no-token connect | `test_phase7_slack_normalize_and_connect_gate` |
| Discord import gate / optional normalize | `test_phase7_discord_*` |
| Final output wire | `test_gateway_final_output.py` |

### 6. Skills — Covered

| Surface | Tests |
|---|---|
| Skills API / curator | `test_skills.py`, `test_skill_curator.py` |
| Evolving skill feature_flow | `test_phase7_skills_feature_flow_emit` + background_review emits |

### 7. Security & safety — Covered

| Surface | Tests |
|---|---|
| SSRF private URL block | `test_phase7_ssrf_private_url_blocked` |
| Browser allowlist | `test_phase7_browser_allowlist_blocks_unknown_host` |
| CORS middleware | `test_phase7_cors_middleware_registered` |
| Secret redaction | `test_phase7_log_stream_redacts_secrets` |
| Gateway auth | `test_gateway_auth.py` |

### 8. Frontend — Covered

| Surface | Tests (vitest in CI) |
|---|---|
| Feature Flow UI | `feature_flow_section.test.tsx` |
| AUG inject toggle | `inject_aug_toggle.test.tsx` |
| Collaboration banners | `collaboration_insights.test.tsx` |
| Marquee titles | `marquee_title.test.tsx` |
| Chat / brain / live / settings | existing desktop vitest suite |

### 9. Mobile — Covered (CI)

| Surface | Tests |
|---|---|
| Typecheck + parity audit | `frontend/mobile` `npm test` in CI |

---

## Live backend in CI — answer (historical)

**It used to be yes, for automated proof:** when CI ran pytest, tool stages and
proxy hops **did emit** Feature Flow events in-process (`feature_flow` bus), and
Phase 7 asserted those events. Nothing asserts them now.

**No live browser/Tauri session** was ever started in CI. Desktop proved UI
consumption via vitest (mocked/networkless EventSource where needed).

---

## How to check any of this now

```bash
# Backend: static gates only — no suite to run
cd backend-py && uv run ruff check . && uv run mypy app/

# Desktop: tsc + eslint, plus the design/docs/api gates from the repo root
npm run check -w frontend/desktop
npm run check:design && npm run check:docs && npm run check:api

# Mobile (still real: tsc + parity audit, not a test run)
npm run test -w frontend/mobile
```

Feature Flow emission itself is exercised by using the app: run
`npm run dev:desktop`, send a turn that calls a tool, and watch the Feature Flow
panel — that is the only verification left for the inventory surfaces.
