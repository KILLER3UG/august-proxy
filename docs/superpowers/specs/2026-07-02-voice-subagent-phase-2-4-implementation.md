# August: Phase 2-4 Implementation Spec — Provider Overhaul, Subagents, Desktop

**Date:** 2026-07-02
**Status:** Draft
**Parent spec:** `2026-06-30-voice-subagent-provider-overhaul-design.md`
**Prerequisite:** Phase 1 complete (voice registry, CalendarCard, ModelPickerCard rewrite, 48 test files/423 tests green)

---

## Overview

This spec covers the three remaining phases from the parent spec. Each phase ships independently but they're ordered for maximum dependency efficiency:

- **Phase 2 (Provider Overhaul)** — required before Phase 3 (subagents need clean provider state).
- **Phase 3 (Parallel Subagent System)** — new capability, largest single piece.
- **Phase 4 (Desktop Hardening)** — platform polish, can be done anytime.

**Total estimated effort:** ~10-14 hours (Phase 2: 4-5h, Phase 3: 4-5h, Phase 4: 2-4h).

---

## Phase 2 — Provider Overhaul (Backend + Frontend)

### What changes

All 30 hardcoded provider Python modules (`backend-py/app/providers/anthropic.py`, `openai_api.py`, etc.) and their `builtin.py` registrar are deleted. Their metadata (base URL, API format, model profiles) is extracted into a static `provider_templates.json`. The in-memory `registry.py` is replaced by `providers.json` as the single source of truth. Users configure their own providers via the existing Settings UI; a new onboarding modal handles the "no providers yet" state.

### Backend files

#### New
1. **`backend-py/app/data/provider_templates.json`** — Template definitions for Anthropic, OpenAI, Ollama + the 27 other providers from the existing `providers/*.py` `INFO` dicts. Each template: `{id, name, baseUrl, apiFormat, description, docsUrl, requiresApiKey, defaultModels[]}`. Also includes `model_profiles` per template (reasoning capability, context window, etc.).
2. **`backend-py/app/providers/template_loader.py`** — `load_templates()` reads and caches the JSON; `get_template(id)` lookup.
3. **`backend-py/app/providers/resolver.py`** — Rewritten to:
   - Remove lines 43-44 (`register_all()`) and line 129 (`register_all()`)
   - Drop `is_custom` field distinction at line 19 — all providers are user-configured
   - `list_available()` reads from `template_loader.get_templates()` + `providers.json` entries
   - `resolve()` checks `providers.json` first (same as today), then templates (replacing builtin registry fallback)
4. **`backend-py/app/providers/model_resolver.py`** — Remove builtin registry fallback at lines 25-122; resolve via `template_loader` + `providers.json`.
5. **`backend-py/app/providers/route_resolver.py`** — Same treatment: enumerate from templates + custom store only.
6. **`backend-py/app/services/provider_credentials.py`** — `_custom_provider_dict(entry)` at lines 95-121 merges template metadata (`model_profiles`, `default_headers`, `env_vars`) where the user entry doesn't override.
7. **`backend-py/app/routers/providers.py`** — `GET /api/providers/templates` endpoint; `POST /api/providers` accepts `template?: str` field to pre-fill baseUrl/apiFormat/models.

#### Deleted
8. **`backend-py/app/providers/builtin.py`** (32 lines — the `register_all()` registrar)
9. **`backend-py/app/providers/{anthropic,openai_api,gemini,deepseek,openrouter,bedrock,azure,minimax,minimax_cn,opencode_go,opencode_zen,kilo,copilot,cline,xai,gmi,zai,xiaomi,stepfun,alibaba,kimi,nvidia,nous,novita,huggingface,arcee,ollama_cloud,tokenrouter,ai_gateway}.py`** (~28-30 individual provider modules; data extracted to templates JSON)
10. **`backend-py/app/providers/custom.py`** (46 lines; no longer needed — `providers.json` entries serve the same role)

#### Keep (no changes needed)
- `backend-py/app/services/model_service.py:_aggregate_models()` (lines 202-239)
- `backend-py/app/providers/clients/*` (HTTP protocol implementations; they dispatch based on `apiFormat` field, not module imports)
- `backend-py/app/routers/config.py:19-65` (`activeProvider` endpoint) — needs audit but no structural change

### Frontend files

#### New
11. **`frontend/desktop/src/components/overlays/ProviderOnboardingModal.tsx`** — First-launch modal per spec. Three CTAs: "Set Up a Provider" (navigates to `/settings/providers`), "Import Config" (paste JSON → POST `/api/providers/import-config`), "Skip for now" (sets `august-onboarding-skipped=true` localStorage). Dismissable. Shown when providers list is empty AND user hasn't skipped.
12. **`frontend/desktop/src/components/overlays/ProviderOnboardingModal.test.tsx`** — Modal renders, all three CTAs work, skip persists.
13. **`frontend/desktop/src/components/chat/NoProviderBanner.tsx`** — Sticky banner at top of chat thread when no providers configured. Dismissable.
14. **`frontend/desktop/src/hooks/useProviderOnboardingState.ts`** — Returns `{shouldShow, dismissed, skip, importConfig}`. Reads providers via `useQuery(['providers'], () => api.get('/api/providers'))`.
15. **`frontend/desktop/src/hooks/useProviderTemplates.ts`** — React Query wrapper for `GET /api/providers/templates`. staleTime 30min.

#### Modified
16. **`frontend/desktop/src/App.tsx`** — Mount `<ProviderOnboardingModal />` alongside `<CommandPalette />`.
17. **`frontend/desktop/src/sections/chat/ChatComposer.tsx`** — Show `<NoProviderBanner />` above input when no providers. Disable send button with toast.
18. **`frontend/desktop/src/sections/providers/Providers.tsx`** — Add template picker dropdown when adding provider. On template select: pre-fill form (baseUrl, apiFormat, defaultModels). "Custom" option for manual entry.
19. **`frontend/desktop/src/sections/workspace/LiveSettingsTab.tsx`** — Replace `sttModel`, `ttsModel`, `sttProvider`, `ttsProvider` text inputs (lines 23-59) with `<select>` dropdowns sourced from `useModels()` / `useProviderAvailability()`. Filter models by selected provider. Empty option = "(use provider default)".
20. **`frontend/desktop/src/api/providers.ts`** — Add `templates()` and `importConfig(json)` methods.

### Settings navigation audit (cross-cutting)
21. Add `staleTime: 5*60*1000` to all `useQuery` calls in `frontend/desktop/src/sections/settings/*` and `sections/workspace/*` to prevent refetch on tab switch.
22. Replace `window.location.href` / `<a href>` internal navigation with `navigate()` / `<Link>`.
23. `onSuccess` invalidation for `['providers']` and `['models']` queries on provider add/edit/delete.

### Test files
24. `backend-py/tests/test_providers.py` — templates endpoint returns templates; POST with template pre-fills entry.
25. `backend-py/tests/test_model_resolver.py` — alias resolution, prefix matching against template definitions.
26. `frontend/desktop/src/sections/workspace/LiveSettingsTab.test.tsx` — dropdown renders, provider filter works, "(use provider default)" option.
27. `frontend/desktop/src/test/settings_nav_persistence.test.tsx` — switching tabs doesn't remount components, data persists.

### Migration strategy
- Extract template JSON from existing `providers/*.py` `INFO` dicts FIRST (Step 1)
- Refactor `resolver.py` / `model_resolver.py` / `route_resolver.py` to use templates (Step 2)
- Delete old Python provider modules (Step 3 — after refactor is verified green)
- Build frontend onboarding + LiveSettings dropdowns (Step 4)
- All tests must pass before moving to Phase 3

---

## Phase 3 — Parallel Subagent System (Backend + Frontend)

### What changes

A new subagent orchestrator built on top of the existing `execute_sub_agent()` in `services/workbench/subagent.py`. Adds: batched `spawn_subagents` tool (plural), peer-to-peer `AgentMessageBus`, failure recovery flow, SSE streaming endpoint, and a configurable `SubagentPanel` on the frontend.

### Backend files

#### New
1. **`backend-py/app/services/agent_message_bus.py`** — In-process async pub/sub. Topics: `task:{taskId}:{progress|result|failure|peer-help}`. API: `publish(topic, msg)`, `subscribe(topic, handler) -> Subscription`, `unsubscribe`. Bounded queue (256, oldest dropped). Async-safe with `asyncio.Condition`.
2. **`backend-py/app/services/subagent_orchestrator.py`** — Singleton with worker pool capped at 5 (`asyncio.Semaphore`). API per spec:
   - `spawn(request: SubagentSpawnRequest) -> SubagentHandle`
   - `terminate(task_id) -> None`
   - `list_active(session_id) -> list[SubagentInfo]`
   - `on(event, handler) -> Subscription`
   - On spawn: acquire slot → subscribe to bus topics for that task → schedule `run_subagent()` → return handle.
   - On failure: broadcast to `task:{taskId}:failure` → 5-second `peer-help` claim window → escalate.
3. **`backend-py/app/services/subagent_worker.py`** — Pipeline: inherit parent tools (from `tool_registry`) → filter by `restrictedTools` allowlist → build context → invoke `execute_sub_agent()` (existing) → publish events to bus.
4. **`backend-py/app/services/tools/spawn_subagents_tool.py`** — Registers `spawn_subagents` in `tool_definitions.py:1418`. Schema: `{workItems: [{goal, restrictedTools?}], mode: 'auto'|'proposed'|'negotiated'}`. `proposed` mode writes `subagent-proposed` event, waits approval. `Promise.all(workItems.map(...))` for concurrent spawn.
5. **`backend-py/app/routers/subagent.py`** — Routes:
   - POST `/api/subagents/spawn` — orchestrator.spawn
   - GET `/api/subagents/active?sessionId=X` — list_active
   - POST `/api/subagents/{taskId}/terminate` — terminate
   - GET `/api/subagents/stream?sessionId=X` — SSE forwarding via `event_log.py` pattern
   - POST `/api/subagents/propose-breakdown` — approval callback

#### Modified
6. **`backend-py/app/main.py`** — Instantiate `SubagentOrchestrator()` in lifespan; attach to `app.state`. Include subagent router.
7. **`backend-py/app/services/tool_definitions.py`** — Register `spawn_subagents` tool alongside existing `spawn_subagent` at line 1418.

### Frontend files

#### New
8. **`frontend/desktop/src/api/subagents.ts`** — `subscribeToSubagentEvents(sessionId, onEvent) -> () => void` (EventSource), `listActive`, `spawn`, `terminate`, `proposeBreakdown`.
9. **`frontend/desktop/src/hooks/useSubagentStream.ts`** — React hook wrapping subscribeToSubagentEvents. Returns `{agents: SubagentInfo[], events: SubagentEvent[]}`.
10. **`frontend/desktop/src/hooks/useSubagentViewPreference.ts`** — Persists `subagentView: 'collapsed'|'expanded'` to localStorage `august-subagent-view`.
11. **`frontend/desktop/src/components/chat/SubagentRow.tsx`** — Single agent row: goal, status pill, current step, progress bar.
12. **`frontend/desktop/src/components/chat/SubagentPanel.tsx`** — Top-level card: collapsed shows "X/Y agents complete" + Expand/Collapse button. Expanded lists SubagentRow per agent. Auto-dismiss 3s after all complete.
13. **`frontend/desktop/src/sections/chat/SubagentApprovalCard.tsx`** — Proposed-mode approval card: lists workBreakdown items. Approve/Cancel buttons call POST/POST to `/propose-breakdown`.
14. **`frontend/desktop/src/sections/settings/SubagentViewSection.tsx`** — Settings section for collapsed/expanded preference.

#### Modified
15. **`frontend/desktop/src/sections/chat/ChatThread.tsx`** — Mount `<SubagentPanel sessionId />` above message list. Subscribe to `subagent-proposed` SSE events → push approval card.
16. **`frontend/desktop/src/api/workbench.ts`** — Extend SSE event dispatcher at lines 458-515 for `subagent-proposed` event forwarding.

### Test files
17. `backend-py/tests/test_agent_message_bus.py` — publish/subscribe, multi-subscriber, topic isolation, cleanup.
18. `backend-py/tests/test_subagent_orchestrator.py` — single + batched spawn, peer recovery, timeout escalation, terminate.
19. `backend-py/tests/test_subagent_worker.py` — restrictedTools enforcement, tool inheritance, event publication.
20. `backend-py/tests/test_subagents_e2e.py` — spawn 3 concurrent, all complete, orchestrator emits consolidated completion.
21. `frontend/desktop/src/test/subagent_panel.test.tsx` — empty (no render), 3 agents (collapsed), expand shows rows, auto-dismiss.

### Architecture notes

The existing `subagent.py` (`execute_sub_agent`) runs agents in **isolation** — no peer messaging. The new `AgentMessageBus` adds inter-agent coordination while keeping the existing execution engine unchanged. The `SubagentOrchestrator` manages the lifecycle; each `run_subagent` task publishes to the bus, and a separate orchestrator task handles failure recovery.

The existing `SubagentBlock.tsx` (nested per-tool-call renderer) is **preserved**. The new `SubagentPanel.tsx` is a **separate top-level view** that aggregates ALL active subagents in a session.

---

## Phase 4 — Desktop App Hardening (Tauri + Terminal)

### What changes

Two items from parent spec's Phase 4, plus a new sub-spec for PTY terminal spawning. The Tauri dialog plugin is added for native folder picker; the terminal is upgraded from a pipe to a real PTY.

### 4A — Terminal PTY Audit

#### New
1. **`backend-py/app/services/workbench/pty_io.py`** — Wraps `pty.openpty()` (Unix) + `pywinpty.PtyProcess` (Windows) behind one async interface: `read()`, `write()`, `resize(rows, cols)`, `close()`.

#### Modified
2. **`backend-py/app/services/workbench/terminal_service.py`**:
   - `_get_shell()` — Windows: probe `pwsh.exe` → `powershell.exe` → Git Bash → `cmd.exe`; Unix: use `$SHELL`.
   - Replace `asyncio.create_subprocess_exec` at line 113 with `pty_io.py` for real PTY support.
   - Always pass `-i` interactive flag.
3. **`backend-py/pyproject.toml`** — Add `pywinpty>=2.0.0` (Windows-only optional dep via `[project.optional-dependencies]`).

#### Test
4. `backend-py/tests/test_terminal_pty.py` — Shell detection logic, subprocess launch succeeds, basic IO roundtrip.

### 4B — Tauri Dialog + Open Folder

#### Modified
5. **`frontend/desktop/package.json`** — Add `@tauri-apps/plugin-dialog ^2`.
6. **`src-tauri/Cargo.toml`** — Add `tauri-plugin-dialog = "2"`, register in `lib.rs`.
7. **`src-tauri/capabilities/default.json`** — Add `dialog:default` + `dialog:allow-open`.

#### New
8. **`frontend/desktop/src/api/folder.ts`** — `openFolderViaTauri()` (uses `@tauri-apps/plugin-dialog`'s `open({directory:true, multiple:false})`) with browser `<input webkitdirectory>` fallback.
9. **`frontend/desktop/src/components/sidebar/OpenFolderButton.tsx`** — Top of sidebar. Calls `findOrCreateSessionForPath(path, name)`, navigates to new session.

#### Modified
10. **`frontend/desktop/src/store/sessions.ts`** — `createSession(folderId, title, workspacePath)` auto-creates folder via `folderNameFromPath(workspacePath)` when workspacePath provided and no matching folder exists.

### 4C — Tauri Build & Config Audit

11. **`src-tauri/tauri.conf.json`** — Verify `beforeBuildCommand` bundles Python backend; `resources` includes `backend-py`; `dialog` + `fs` permissions set.
12. WebSocket URL audit — verify all `frontend/desktop/src/api/*` event sources use `ws://localhost:<port>` not `window.location.host` in desktop mode.

### Manual E2E checklist
- `npm run tauri dev` on Windows: backend launches, xterm.js opens PowerShell/pwsh, `/model` slash mounts ModelPickerCard, `/calendar` mounts CalendarCard, folder picker creates session with workspacePath, auto-folder appears in sidebar.

---

## Implementation order

```
Phase 2 (Provider Overhaul)
  ├─ 2a: Extract templates JSON from existing provider INFO dicts
  ├─ 2b: Refactor resolver.py/model_resolver.py/route_resolver.py
  ├─ 2c: Add templates endpoint to providers.py
  ├─ 2d: Update provider_credentials.py for template merge
  ├─ 2e: Delete all old provider modules
  ├─ 2f: Run backend tests; fix any regressions
  ├─ 2g: Build frontend: onboarding modal + banner + hooks
  ├─ 2h: Build LiveSettings dropdowns + Providers template picker
  ├─ 2i: Settings nav audit (staleTime + internal nav)
  ├─ 2j: Run full test suite (backend + frontend)
  │
Phase 3 (Subagent System)
  ├─ 3a: Build agent_message_bus.py + tests
  ├─ 3b: Build subagent_worker.py
  ├─ 3c: Build subagent_orchestrator.py + tests
  ├─ 3d: Build spawn_subagents_tool.py
  ├─ 3e: Build subagent router + SSE + register in main.py
  ├─ 3f: Build frontend api/subagents.ts + useSubagentStream hook
  ├─ 3g: Build SubagentRow + SubagentPanel + useSubagentViewPreference
  ├─ 3h: Build SubagentApprovalCard + SubagentViewSection
  ├─ 3i: Wire SubagentPanel into ChatThread
  ├─ 3j: Run full test suite
  │
Phase 4 (Desktop Hardening)
  ├─ 4a: Build pty_io.py + update terminal_service.py
  ├─ 4b: Run terminal tests
  ├─ 4c: Add @tauri-apps/plugin-dialog + Cargo deps
  ├─ 4d: Build OpenFolderButton + folder.ts
  ├─ 4e: Auto-folder in sessions.ts
  ├─ 4f: Tauri config audit + WebSocket URLs audit
  └─ 4g: Manual E2E on Windows
```

---

## Risk register

| Risk | Mitigation |
|---|---|
| Removing 30 provider modules breaks existing custom provider config | Extract to templates FIRST, run full backend test suite after each deletion |
| `pywinpty` fails on Windows CI | Mark as Windows-only optional dep |
| Subagent SSE overload with many sessions | Cap at 5 concurrent per orchestrator |
| Tauri dialog addition breaks existing `select_directory` command | Add without removing the existing command |
| `providers.json` users suddenly lose provider data | `resolver.py` refactor preserves all custom store logic — only removes the builtin registry fallback |

---

## Files touched (total)

**Backend new:** 9 files (template_loader, resolver rewrite, agent_message_bus, two orchestrator files, spawn_subagents tool, subagent router, pty_io)
**Backend modified:** 5 files (main.py, tool_definitions.py, terminal_service.py, providers.py, pyproject.toml)
**Backend deleted:** ~32 files (builtin.py + custom.py + 30 individual provider modules)
**Frontend new:** 13 files (onboarding modal, banner, 3 hooks, subagent panel, approval card, settings section, folder picker, 2 api modules)
**Frontend modified:** 6 files (App.tsx, ChatComposer.tsx, Providers.tsx, LiveSettingsTab.tsx, providers.ts, sessions.ts)
**Tauri modified:** 3 files (Cargo.toml, capabilities, tauri.conf.json)
**Tests:** ~12 new test files

**Total:** ~75 files. Estimated effort: 10-14 hours across 2-3 sessions.
