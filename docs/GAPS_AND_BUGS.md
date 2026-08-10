# Gaps and bugs

Living list. Prefer fixing code first, then ticking items off here.

---

## Closed (2026-08-01)

| Item | Resolution |
|------|------------|
| OpenCode Zen: models list ≠ usable chat path | **Per-model `apiFormat` override** — a model entry can carry its own format, which wins over the provider-level format. Honored by workbench chat, Test button, Live/BTW, and the `/v1` proxy adapters (OpenAI→Anthropic body + SSE translation added for Claude models reached via `/v1/chat/completions`). UI: model row → Wire format dropdown with family hint. See `CONFIGURATION.md`. Tests: `test_model_format_override.py` (21) |
| Verifier gate advisory w.r.t. final-response emission | **Opt-in per-session `verifierEnforced` flag** (chosen over guard-mode scoping to keep casual chat untouched). While on, `finalOutput` text is withheld until `update_state(phase='complete')` passes; a `verifierBlocked` SSE event + amber banner explains why. Toggle: composer shield button; also settable at session creation. Tests: `test_verifier_enforced_flag.py` |
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
