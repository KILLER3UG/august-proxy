# Gaps and bugs

Living list. Prefer fixing code first, then ticking items off here.

---

## Closed (2026-09-27 — docs audit against the tree)

A full sweep of `docs/`, `README.md`, `CHANGELOG.md` and the scattered markdown
against the working tree. The pattern: **`AGENTS.md`, `CONFIGURATION.md` and
`GAPS_AND_BUGS.md` had been kept current; the older reference docs had not.**

| Item | Resolution |
|------|------------|
| `ARCHITECTURE.md` memory-subsystem table named 15 modules | **14 did not exist.** Rewritten against the real `services/memory_store/` package (`brain`, `consolidation`, `fact_retrieval`, `kv`, `messages`, `rest`, `sessions`, `transcript_blocks`, `wire`) + `memory_conn` / `memory_schema` |
| `ARCHITECTURE.md` "Brain write classes": `db_writer.enqueue_write(must_succeed=…)`, `brain_write_facade` | **No such module, symbol or kwarg anywhere.** Replaced with what exists: direct `memory_store` txn + `deferred_writes.defer_commit(conn, window_s=2.0)` coalescing + `best_effort(site)`. `AUGUST_DB_WRITER_LOW_DROP_S` was also dead in `DEVELOPER_GUIDE.md` |
| "`Vector / graph` SQLite tables" | **There is no vector store and no graph store** — `fact_retrieval.py`, `tools/retrieval.py` and `text_similarity.py` each state it. Recall is BM25/FTS. `august_graph_memory.json` is read by nothing |
| `/api/memory/*` (incl. `/review` + `/review/apply`) documented as live | **Router deleted.** Was repeated in FOUR live docs (`ARCHITECTURE`, `CONFIGURATION`, `TROUBLESHOOTING`, plus `README`'s "Review what I remember" chip). All replaced with the real surface: `remember`/`list_facts`/`forget` tools, `/api/brain/consolidation/*`, `/api/august/memory/proposals[/{id}/decide]` |
| `POST /api/curator/{pin,unpin,archive,restore}` + `GET /api/curator/usage` | **None exist.** Curation lifecycle is a `SKILL.md` **frontmatter flag**, not an endpoint and not a `.archive/` move. Fixed in `API_REFERENCE` and `TROUBLESHOOTING` |
| Provider **templates** still documented as shipped | `GET /api/providers/templates` returns `[]`. Fixed in `SETUP`, `TROUBLESHOOTING` (whole "Only three templates?" section), `API_REFERENCE`, `DEVELOPER_GUIDE` and `README`'s tree |
| **`gateway.guard_mode` silently ignored** | `runner.py:52` reads `cfg.get('guardMode')`. The doc example used `guard_mode` **and** the code default equals the documented value, so it looked like it worked. Fixed + a casing warning added to `CONFIGURATION.md` |
| `/api/usage` documented as `POST`, `?period=`, `?sessionId=` | Route is GET-only; the param is `range`; `/session` takes `id`. `currentStreak` is now genuinely computed (the old "placeholder" note was stale) |
| SSE event table in snake_case | `emit_types.py` is canonical and camelCase (`finalOutput`, `toolCall`, `toolResult`, `planProposed`); the snake forms are legacy-accept-only. Table completed with `turn_end`, `recovery`, `subagent*`, `checkpoint` etc. |
| `GET /api/brain/harness/evals`, `GET /api/perf/db-writer`, `/api/skills/*/files`, `POST /api/mcp/harness` | All dead or mis-pathed (the MCP harness router has **no `/api` prefix**). `harness/evals` also contradicted the same doc's own removal note |
| `ARCHITECTURE.md`: Settings "8 hubs", `ChatRunHeader`, `TimelineRail`, `SubagentLaunchList`, `get_curator`, `send_workbench_message_stream` | Registry is 3 headers (`basics`/`capabilities`/`data`, 44 sections); those components do not exist; symbol is `sendWorkbenchMessageStream` in `services/workbench/workbench.py` |
| `DEVELOPER_GUIDE.md` debugging tips pointed at `/api/brain/{status,diagnostics,events/stream}` | None exist. Replaced with the real `/api/brain/*` set |
| `uv run pytest -q` without `-n auto` | In `README` (×2), `SETUP`, `DEVELOPER_GUIDE`, `FEATURE_INVENTORY_TEST_MATRIX`. `AGENTS.md` mandates it (serial ≈ 2 h; 8 m 22 s parallel) |
| `README.md` said "seven" version sources and "Verifier is opt-in" | `check-version-sync.mjs` guards **8**; the verifier gate was removed 2026-08-24. Release flow also corrected: `release-desktop.yml` triggers on a `v*.*.*` **tag**, builds without running pytest, and `Type check` does not gate publication |
| `.env.example` referenced a "claude profile + bookmarks" / "codex profile" | No profile or bookmark machinery exists in `app/`. Keys resolve generically via `providers.json` → `{NAME}_API_KEY` |
| 48 dated docs read as live guidance | Tagged with an explicit provenance banner: shipped plans, June–July specs, `audit-2026-08/` reports with **no disposition**, and `archive/` files whose bodies still said "Ready for implementation". **Re-counted 2026-10-07: 49 of 119 docs under `docs/` now carry such a banner, and four dated ones still do not** — `UI-SCAN-2026-09-16.md`, `CHANGES_AUDIT_PASS_2026-08.md`, `CHAT_UI_DEEP_DIVE_2026-08-23.md`, `audit-2026-08/FINDINGS-AGENT-1-BACKEND.md`. The last of those is the harmful one: it tells a reader not to regress the verifier gate that was removed on 2026-08-24 |
| Dead prose path references into moved files | `CHANGELOG.md` → `docs/archive/SMOOTHNESS_PLAN_STATUS.md`; `REFACTOR_HANDOFF_PROMPT.md` × 6 → `docs/archive/PHASE8_…`. `check-doc-links.mjs` cannot catch these — it only validates resolving markdown link syntax, not inline-code paths |
| `settings-audit.md` claimed "38 sections", header id `settings` | id is `basics`, banner added. The "44 sections" recorded here as the correction has itself gone stale, and the rest of this row's disposition is wrong: `settings-registry.ts` now declares **43 tiered sections (17 `basic`, 26 `hidden`, and no `advanced` tier at all)**, and both `useSettingsAdvancedPreference.ts` and `RAIL_CHILDREN` are **deleted from the tree**, not merely unimported — `WorkspaceShell.tsx` no longer names them either. See `docs/ARCHITECTURE.md` §Settings, which now carries the counted figures and the grep trap in them |
| `skills/charts/SKILL.md` told the model to plot `simulate_circuit` output | **Live product defect** — the registered tool is `circuit_simulate`; `simulate_circuit` is an internal function only. Every other skill used the right name. Fixed |
| `IDENTITY.md`, `USER.md`, `frontend/desktop/AUDIT-FINDINGS.md` | Deleted. First two are unhooked **AutoClaw** template remnants (`autoclaw.schema` has zero hits in `backend-py/`) with placeholder values; the third is a 2025-07-17 audit, ~50% resolved, citations rotted. `IDEA.md` **kept** — `archive/HARNESS_IMPROVEMENT_PLAN_2026-08-23.md` cites it as the product north star |

### Still open

- **`CHANGELOG.md` has no entry newer than `0.17.0 (2026-08-24)`** while the tree
  is `0.18.15` — 15 tags shipped as two undated "Unreleased (working tree)"
  blocks. Not cosmetic: `/api/whats-new` falls back to this file offline, so the
  desktop app titles everything "Unreleased". Needs a decision, not a sweep.
- **`docs/releases/` covers 15 of 68 tags** — but nothing reads the directory, so
  this is archaeology, not a bug (recorded in `DOCUMENTATION.md` now).
- Per-model **pricing** (`priceInPerM` / `priceOutPerM`), **bot mode**
  (`services/bot_mode/`) and the **circuit workbench** have effectively no
  user-facing doc outside `AGENTS.md` and one env-var line.
- ~20 env vars are read by code but documented nowhere (`AUGUST_CORS_ORIGINS`,
  `AUGUST_TOOL_TIMEOUT_S`, `AUGUST_{CONNECT,TTFB}_TIMEOUT_S`,
  `AUGUST_ANTHROPIC_CACHE`, `AUGUST_QUOTA_OBSERVATION_TTL_S`, the
  `cognitive_config` group, `AUGUST_{GHDL,MODELSIM,FIRMWARE_MCU}`, …).
  `.env.example` shares only 2 of ~30 runtime vars with `CONFIGURATION.md`.
- `memoryAutoInject` — default OFF, the gate `AGENTS.md` calls load-bearing — is
  absent from `CONFIGURATION.md`'s key list.
- Dual naming, mobile docs, gateway platform UI: unchanged from below.

---

## Closed (2026-08-01)

| Item | Resolution |
|------|------------|
| OpenCode Zen: models list ≠ usable chat path | **Per-model `apiFormat` override** — a model entry can carry its own format, which wins over the provider-level format. Honored by workbench chat, Test button, Live/BTW, and the `/v1` proxy adapters (OpenAI→Anthropic body + SSE translation added for Claude models reached via `/v1/chat/completions`). UI: model row → Wire format dropdown with family hint. See `CONFIGURATION.md`. Tests: `test_model_format_override.py` (21) |
| Verifier gate advisory w.r.t. final-response emission | **Resolved, then removed entirely (2026-08-24, user request).** The opt-in `verifierEnforced` flag described here no longer exists — there is no final-answer review step and nothing withholds answers; `update_state(phase=…)` is progress tracking only. See AGENTS.md "No verifier gate exists". |
| Naming debt guardrail | New `scripts/check-naming.mjs` + checked-in `scripts/naming-baseline.json` — CI fails only on **new** camelCase params in service signatures (221 legacy entries grandfathered; 5 renamed incl. `heuristics_service.ruleIds → rule_ids`). Bulk rename remains deferred (see below) |

## Closed (2026-07-25)

| Item | Resolution |
|------|------------|
| `/api/live/*` returned stub data (fake session id, `Processing: …`, empty STT, null TTS) | `live.py` fully implemented — `liveSession` creates real workbench sessions; `liveTurn` calls the workbench engine; STT/TTS delegate to `live_speech` (501 only when unconfigured) |
| CORS `allow_origins=['*']` + credentials | `main.py` `_cors_allow_origins()` returns explicit localhost/tauri allowlist + `AUGUST_CORS_ORIGINS` |
| Deprecated `datetime.utcnow()` | Replaced with `datetime.now(timezone.utc)` across workbench / scheduler / sessions / agent_registry |
| `record_mutation` / `create_pending_mutation` dead code; `mutationCount` always 0 | Now called; `mutationCount` increments per approved mutation |
| `routers/cron.py` in-memory dict | Now durable via `services/scheduler` (`scheduled-jobs.json`) |
| `app/database.py` leftover | Deleted |
| `/api/health` dual registration | Confirmed single SoT in `main.py` (monitoring router's `/health` removed) |
| `WS /api/logs/stream` + `GET /api/logs/recent` undocumented | Documented in API_REFERENCE; implemented in `monitoring.py` |
| `/api/usage` list-all stub | Implemented (`usage.py:194`); full `/api/usage/*` surface (7 endpoints) |
| Save-point chips in chat | `SavePointChip.tsx` removed; backend checkpoint endpoints retained for RightDrawer revert-all |
| Context window stuck at 128k + Test button "Not found" | `model_service.py:95-102` honors stored `contextWindow`; providers routes use `{modelId:path}` converter (`providers.py:328/365/387`) |
| Tauri quiet-patch updater could miss bundled backend changes | Windows now downloads the full GitHub-release NSIS installer (`useAppUpdate.ts:109-175`, `backend.rs:1142-1262`) |
| Brain Orchestrator settings panel | Removed (controls live in session sidebar); backend module + `/api/brain/config*` remain |
| Starter prompt cards / v4.4.x brain popup tests | Removed together with their feature source (commit `1b796ffe`) |
| Verifier gate "stubbed" | Genuinely enforced (`system_tools.py:149-177, 203-217`) — see open caveats below |
| `currentStreak` hardcoded to 0 (`usage.py:124`) | Now computed as consecutive days with usage ending today/yesterday; today is allowed empty so a streak isn't reset before the day's first event |
| Verifier same-turn bypass (`review`→`complete` skipped re-verification) | `system_tools.py:203` now re-verifies entering `complete` from any non-`complete` phase (incl. `review`); same-phase no-op updates still skip the gate. 5 regression tests added to `test_verifier_gate_enforcement.py` |
| `asset_updater.py` orphaned dead code | Deleted (`backend-py/app/services/asset_updater.py`); zero imports repo-wide; Tauri full-installer owns updates |
| Dangling `SavePointChip` comment (`SkillEvolvedChip.tsx:4`) | Comment rewritten — `SavePointChip` reference removed |
| `release-desktop.mjs` "custom sidecar updater" framing | Header note (2026-07-25) clarifies the manifest is no longer consumed by a sidecar updater and points to `download_release_installer`; `asset-updater.js` path reference removed |
| v4.4.2 / v4.4.3 release notes missing | `docs/releases/v4.4.2-brain-popup-drag-resize.md` + `v4.4.3-portal-fix.md` added as rollback stubs citing commit `1b796ffe` |
| v0.12.22–v0.12.36 release notes missing | Consolidated `docs/releases/0.12.22-36.md` added covering the 15 desktop releases (context-window fix, auto-update switch, tar-extraction build fix, chat truncation/warning-collapse fixes) |
| `POST /v1/messages/count_tokens` had no route (unwired handler) | Wired as `@router.post('/v1/messages/count_tokens')` in `routers/proxy.py`; delegates to `anthropicAdapter.handleCountTokens` (local estimation, no upstream call). 3 tests added to `test_missing_endpoints.py` |
| `GET /api/providers/{id}/models` + `POST /api/providers/{id}/discover` missing | Implemented in `routers/providers.py`. `GET /{id}/models` returns stored model list; `POST /{id}/discover` is a read-only live-probe (extracted from refresh into shared `_discoverProviderModels` helper). 3 tests added |

## Closed (2026-07-20)

| Item | Resolution |
|------|------------|
| OpenCode Console `session_id: null` 400 on workbench/Test | Desktop **0.12.21** — `dump_openai_upstream_body` / `dump_anthropic_upstream_body` on workbench + proxy |
| API format dropdown showed `base + /chat/completions` | Labels are leaf paths only (`chat/completions`, `messages`, `responses`) |

## Closed (2026-07-15)

| Item | Resolution |
|------|------------|
| Docs vs code drift | Primary docs rewritten (SETUP/ARCHITECTURE/API/CONFIGURATION/…) |
| Health dual registration | Single SoT in `main.py` |
| Provider **templates** | **Removed** — users configure providers fully; `/templates` returns `[]` |
| Discord/Slack optional SDKs | `.[gateway]` extra + `/api/gateway/status` platforms + Settings UI card |
| Live STT/TTS 501 UX | `sttReady`/`ttsReady` + factories only use server when ready |
| Thinking on non-Claude models | Conservative `supports_thinking()` + tests |
| API path inventory false positives | Fixed `_list_api_paths.py` (0 unmatched) |
| Secrets under `data/` | Already gitignored |

---

## Open / deferred

### Dual naming (Python params vs camelCase wire) — **DEFERRED by design (guarded)**

| Layer | Convention |
|-------|------------|
| HTTP JSON / path params | **camelCase** (stable frontend contract) |
| SQLite | **snake_case** |
| New Python service APIs | Prefer **snake_case** params |
| Legacy Python params | Mixed; mass rename is high-risk |

A bulk camel→snake param rewrite was attempted and **reverted** after ~125
test failures (incomplete body renames + path/param mismatches). Fixing this
requires a purpose-built codemod (AST-aware, skip string keys / path templates),
not a regex pass. Since 2026-08-01 a guardrail (`scripts/check-naming.mjs`,
wired into CI) blocks **new** camelCase params, and small modules are renamed
incrementally with tests green after each (`terminal_service`, `validator`,
`delta_engine` done).

### Mobile companion docs — partial

### Optional: expand gateway platform UI beyond System Health

---

Update this file when items close.
