# Feature Inventory Test Matrix — Phase 7

> **Status:** **DONE — fully automated E2E proven (2026-07-14)**  
> **Purpose:** Map Feature Inventory Summary items → automated coverage.  
> **Live tracker:** `docs/REFACTOR_PROGRESS.md`  
> **Permanent gate:** `backend-py/tests/test_phase7_e2e_inventory.py` (runs in CI pytest)

## What “fully E2E proven” means here

| Layer | Proven in CI? | How |
|---|---|---|
| Backend inventory surfaces | **Yes** | Full `pytest` on every push (includes Phase 7 gate) |
| Live backend feature_flow during tool/proxy actions | **Yes** | In-process emits asserted in Phase 7 + tool stage tests |
| Desktop UI consumers | **Yes** | `vitest` in CI (`npm run test -w frontend/desktop`) |
| Mobile companion | **Yes** | `npm run test -w frontend/mobile` (tsc + parity audit) in CI |
| Live Slack/Discord *network* bots | **Gated** | Normalize + connect-without-token proven; real tokens need env secrets |
| Live upstream LLM providers | **Gated** | `v2_real_llm` / `v3_proxy_real_llm` when keys present |

Isolation: `isolatedData` is **autouse** — full pytest must not touch live brain.

---

## Suite baselines (re-run to refresh)

| Suite | Command | CI job |
|---|---|---|
| Backend pytest | `pytest -q` in `backend-py/` | `backend-mypy` |
| Phase 7 gate | `pytest tests/test_phase7_e2e_inventory.py -q` | (part of full pytest) |
| Desktop vitest | `npm run test -w frontend/desktop` | `frontend-tsc-eslint` |
| Mobile | `npm run test -w frontend/mobile` | `mobile-typecheck` |

---

## Inventory → coverage (all **Covered** at automated E2E level)

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

## Live backend in CI — answer

**Yes, for automated proof:** when CI runs pytest, tool stages and proxy hops **do emit** Feature Flow events in-process (`feature_flow` bus). Phase 7 asserts those events.

**No live browser/Tauri session** is started in CI. Desktop proves UI consumption via vitest (mocked/networkless EventSource where needed). That is intentional: CI must stay credential-free and non-flaky.

---

## How to re-verify locally

```bash
# Backend (includes Phase 7 gate + full suite)
backend-py/.venv/Scripts/python.exe -m pytest backend-py/tests -q

# Desktop UI
cd frontend/desktop && npx vitest run

# Mobile
npm run test -w frontend/mobile
```
