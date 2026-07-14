# Feature Inventory Test Matrix — Phase 7

> **Status:** Operationalized 2026-07-14  
> **Purpose:** Map Feature Inventory Summary items → automated coverage + gaps.  
> **Live tracker:** `docs/REFACTOR_PROGRESS.md`  
> Re-run evidence commands after material changes; do not treat this file as a substitute for CI.

## Suite baselines (2026-07-14)

| Suite | Command | Result |
|---|---|---|
| Backend pytest | `backend-py/.venv/Scripts/python.exe -m pytest backend-py/tests -q` | **723 passed**, 3 warnings |
| Frontend vitest | `npx vitest run` (from `frontend/desktop`) | **58 files / 543 passed** |
| Phase 4 indexes | `python backend-py/scripts/_check_phase4_indexes.py` | `ALL_SIX_PRESENT` |
| Phase P exit gate | `pytest backend-py/tests/test_phase_p_exit_gate.py -q` | green (part of full suite) |

Isolation: `isolatedData` is **autouse** — full pytest must not touch live brain.

---

## Inventory → coverage

Legend: **Covered** = automated tests exercise the surface; **Partial** = unit/characterization but not full E2E with real providers/platforms; **Gap** = little/no automated coverage (manual or future work).

### 1. Multi-provider proxy / adapter translation

| Surface | Coverage | Primary tests |
|---|---|---|
| Anthropic ↔ OpenAI message translate | Covered | `test_adapters.py`, `test_anthropic_system.py` |
| Anthropic / OpenAI SSE | Covered | `test_anthropic_sse.py`, `test_openai_sse.py`, `test_sse_format.py` |
| OpenAI→Anthropic stream translate | Covered | `test_adapters.py` (re-export via `anthropic` facade) |
| Proxy tools / managed tools | Covered | `test_adapters.py` (proxy_tools imports), workbench tool tests |
| Providers / clients / credentials | Covered | `test_providers.py`, `test_clients.py`, `test_provider_credentials.py` |
| Alias / routing / fallback | Covered | `test_alias_service.py`, `test_fallback_service.py` |
| Real upstream LLM | Partial | `v2_real_llm.py`, `v3_proxy_real_llm.py` (env/network gated) |

### 2. Memory & learning system

| Surface | Coverage | Primary tests |
|---|---|---|
| memory_store CRUD / FTS | Covered | `test_memory.py`, `test_memory_store_characterization.py`, `test_fts_app_path.py` |
| Schema / pragmas / indexes | Covered | `test_sqlite_pragma_defaults.py`, `test_sqlite_safety.py`, Phase 4 scripts |
| Auto memory / background review | Covered | `test_background_review*.py`, Phase P side-effect paths |
| Self-evolution / daemons | Covered | `test_daemon_manager*.py`, `v2_daemon_*.py`, `v2Consolidation.py` |
| Blackboard / timeline / exams | Covered | `v2Blackboard.py`, `v2Timeline.py`, `v3Exam.py`, `v11_*.py` |
| db_writer FIFO / age-drop | Covered | `test_db_writer*.py`, `test_perf_p0_baselines.py` |
| Live multi-session E2E | Partial | `v2E2e.py`, `v3E2e.py`, `v11_e2e_chat.py` |

### 3. Tools (~50 categories)

| Surface | Coverage | Primary tests |
|---|---|---|
| Tool registry / definitions | Covered | `test_workbench_tool_definitions.py`, `test_tool_html.py` |
| Tool loop / MCP tools | Covered | `test_workbench_tool_loop.py`, `test_workbench_mcp_tools.py` |
| Parallel RO tools (Phase P) | Covered | `test_phase_p_remaining.py`, `test_phase_p_exit_gate.py` |
| Browser automation | Covered | `test_browser.py` |
| Desktop automation models | Covered | `test_desktop_automation.py`, `test_camel_model_desktop_automation.py` |
| Every individual skill tool path | Partial | Catalogue + skill tests; not one test per tool |

### 4. Cognitive architecture (roles / policies / fleet)

| Surface | Coverage | Primary tests |
|---|---|---|
| Model fleet / brain config | Covered | `v2_model_fleet.py`, `v41_model_fleet.py`, `test_brain_config.py` |
| Effort / workbench policies | Covered | `test_workbench_effort.py`, `test_workbench.py` |
| Subagents / orchestrator | Covered | `test_subagent*.py`, peer-help contention tests |
| Verifier / delta / env watcher | Covered | `v2_verifier_gate.py`, `v2_delta_llm.py`, `v2_env_watcher.py` |

### 5. Gateway platforms

| Surface | Coverage | Primary tests |
|---|---|---|
| Gateway base / auth | Covered | `test_gateway_base.py`, `test_gateway_auth.py` |
| Telegram | Covered | `test_gateway_telegram.py` |
| Final output / reply text | Covered | `test_gateway_final_output.py` |
| Slack / Discord live bots | **Gap** | No dedicated live platform suite (manual / env) |

### 6. Skills system

| Surface | Coverage | Primary tests |
|---|---|---|
| Skills API / manage | Covered | `test_skills.py`, `test_skill_manage.py` |
| Curator lifecycle | Covered | `test_skill_curator.py` |
| Skills catalogue in prompt | Covered | `test_workbench_skills_catalogue.py` |
| Guideline migration | Covered | `test_guideline_migration.py` |
| Full 85+ skill content E2E | Partial | Inventory exists; not each skill executed |

### 7. Security & safety

| Surface | Coverage | Primary tests |
|---|---|---|
| Health / lib characterization | Covered | `test_health.py`, `test_lib_characterization.py` |
| Atomic JSON stores | Covered | `test_json_store_atomic.py` |
| Audit / config audit routes | Covered | `test_audit.py`, CamelModel config tests |
| SSRF / allow-lists / CORS deep E2E | **Gap** | Rely on code review + targeted unit paths; expand if needed |
| Secrets handling | Partial | provider credential tests |

### 8. Frontend capabilities

| Surface | Coverage | Primary tests (vitest) |
|---|---|---|
| Chat SSE / reconnect | Covered | `src/api/workbench.test.ts`, chat-runtime / thread tests |
| Stream perf marks | Covered | `src/lib/__tests__/stream-perf.test.ts` |
| Sessions store | Covered | `src/store/__tests__/sessions.test.ts` |
| Skills section | Covered | `src/test/skills-section.test.tsx` |
| Brain dashboard / popup | Covered | `v3_brain_dashboard`, `v4_4_*brain*`, activity tests |
| Settings / observability | Covered | settings-registry-audit, ObservabilitySection, PlansSection |
| Live / voice surfaces | Covered | `v4_live_*`, voice-intent, speech adapter |
| Model fleet UI | Covered | `v4_1_model_fleet.test.tsx` |
| Terminal / providers deep E2E | Partial | CamelModel terminal routes (backend); limited FE E2E |
| Mobile companion (Expo) | **Gap** | No matrix run in this pass |

---

## Gaps (explicit backlog — not blocking Phase 7 operationalization)

1. **Slack / Discord gateway live E2E** — needs credentials + sandbox.
2. **SSRF / CORS / allow-list integration suite** — security-focused expansion.
3. **Mobile companion** — separate Expo test harness.
4. **Real-provider proxy soak** — optional; env-gated `v2`/`v3` real LLM tests.
5. **Per-skill execution** — catalogue coverage ≠ every skill body.

---

## How to re-verify

```bash
# Backend (from repo root, Python 3.12 venv)
backend-py/.venv/Scripts/python.exe -m pytest backend-py/tests -q

# Frontend
cd frontend/desktop && npx vitest run

# Phase 4 + Phase P gates
backend-py/.venv/Scripts/python.exe backend-py/scripts/_check_phase4_indexes.py
backend-py/.venv/Scripts/python.exe -m pytest backend-py/tests/test_phase_p_exit_gate.py -q
```

Update this matrix when adding inventory surfaces or closing gaps.
