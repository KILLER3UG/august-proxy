# August Full Access — Design

**Date:** 2026-06-19
**Status:** Approved
**Source plan:** User-provided "August Full Access Plan — Final" (third plan: "High-Level and Low-Level"), corrected with 11 repo-grounded fixes.

## Overview

Augment August Proxy's Workbench with **full host access** (filesystem, shell, processes, env, network, system info, app allowlisting) plus **August self-management** (sessions, settings, providers, aliases, models, tools, MCP, memory, agents), **declarative audit + rollback**, **UI automation via API/state events**, **agent permission classification**, and **post-observation screenshots** for computer-use.

Workbench remains the single control plane. New layers stack on top of existing infrastructure — no parallel control paths.

## Locked Decisions

1. **Filesystem scope:** Project cwd + `security.allowedRoots` + August data dir + temp dir. `security.filesystemScope = 'root'` allows the full machine. Default: `'allowlist'`.
2. **Full Access mode:** Critical actions (per `classifyCriticalAction`) always require `confirm-mutation`, even in `guardMode: 'full'`.
3. **UI automation:** API/state events only. No DOM clicks/fills. Actions: `navigate | open_drawer | close_drawer | set_drawer_section | set_guard_mode | refresh | focus_composer | insert_composer_text`.
4. **Rollback:** Declarative records (`type`, `target`, `before`, `after`). No stored closures. Dispatch `undo` by `type`.

## Architecture

### Existing modules to reuse

- `backend/lib/redact.js` (`redactForDisplay`, `maskSecretValue`)
- `backend/lib/path-permissions.js` (`extractPathsFromCommand`, `checkPathPermission`, `checkCommandPaths`)
- `backend/lib/config.js` (will be extended with `security.*` keys)
- `backend/services/tools/august-tools.js` (OpenAI-format tool definitions, `MUTATING_WORKBENCH_TOOLS`, `SAFE_COMPUTER_TOOLS`, `requiresHostAgentConfirmation`)
- `backend/services/tools/agent-registry.js` (`classifyTool`, `allow/ask/deny`)
- `backend/services/tools/host-agent-tools.js`
- `backend/services/workbench/workbench.js` (`guardMode`, `pendingMutations`, `createPendingMutation`, `/ui/workbench/confirm-mutation`, `executeWorkbenchTool` — policy hook added)
- `backend/services/sessions/` (SQLite CRUD)
- `backend/services/providers/` (CRUD helpers, `listPublicProviders()`)
- `backend/services/catalog/model-catalog.js` (`list(opts)`)
- `backend/services/semantic-memory/` (`setFact`, `deleteFact`)
- 16 `computer_*` tools
- Frontend: `$rightDrawer` nanostore, `SETTINGS_SECTIONS`, `RightDrawerState.ts`, `SettingsPage.tsx SECTION_COMPONENTS`

### Verified Assumptions (re-confirmed)

- `backend/lib/redact.js` exists with `redactForDisplay`, `maskSecretValue`. Audit log composes these with a small `patternRedact(text)` helper for free-text matches (`sk-...`, `Authorization`, cookies, `API_KEY=...`).
- `backend/lib/path-permissions.js` exports `extractPathsFromCommand`, `checkPathPermission`, `checkCommandPaths`. New `permission-profiles.js` wraps these AND `getAllowedBasePaths()` is updated to include `security.allowedRoots` (otherwise `checkPathPermission` rejects them).
- `backend/lib/config.js` does NOT yet contain `security.allowedRoots` or `security.filesystemScope`. Add these keys with getters/setters.
- Canonical settings routes confirmed in `settings-registry.ts:59-189`: `memory-knowledge`, `model-providers`, `conversations-history`, `tools-connections`, `agents-automation`, etc.
- `RightDrawerState.ts` is at `frontend/desktop/src/components/shell/RightDrawerState.ts`.
- `SettingsPage.tsx:54-67` has `SECTION_COMPONENTS` map — new section needs an entry there too, not only in `settings-registry.ts`.
- `backend/services/providers/providers-routes.js:328` exports `listPublicProviders()`. `backend/services/catalog/model-catalog.js:165` exports `list(opts)`. Use these directly.
- `backend/services/tools/agent-registry.js:251` `classifyTool(toolName)` only takes a name — must extend to `(toolName, args)` so `august__ui_control navigate` vs `set_guard_mode` and `system_network GET` vs non-GET classify correctly. Thread `args` through `evaluateAgentTool()` and `requireAgentPermission()`.
- `backend/services/workbench/workbench.js:1680` calls `hostAgent.execute(name, args)` directly — policy enforcement (app allowlist) MUST go through a new `executeHostAgentToolWithPolicy()` helper, not only in `host-agent-tools.js`.
- `backend/host-agent/index.js:40-46` `screenshot()` returns `{ base64: ... }`. Post-observation stores to `dataPath('computer-observations', '<id>.png')` and audits `{ screenshotPath, capturedAt, focusedApp }`. No base64 in JSONL.
- `backend/index.js:776` `confirm-mutation` retries with `{ approvedMutation: true }`. New tools must accept approval via `toolContext.approvedMutation` / `bypassConfirmation`. Keep `args.confirmed` only as a direct-tool fallback.
- `backend/services/tools/host-agent-tools.js:24` `requiresHostAgentConfirmation()` is read-only/decision logic only. App-allowlist gating happens in Workbench's new helper, not here.
- `frontend/desktop/package.json` has `build` and `test` scripts but no `typecheck`. Add `"typecheck": "tsc -b --noEmit"`.
- `backend/lib/host-agent.js:3` defaults to `host.docker.internal`; line 260 has a Docker error message. August is self-contained now — flip default to `127.0.0.1` / `localhost` and update the message.
- `backend/services/{audit,rollback,permissions,august-api,system,ui,computer}/` — none exist yet. All new files.

### Computer-Use App Policy Detection

- **Default detection:** `computer_list_windows`, find entry with `isForeground === true` (NOT `computer_focus_window`, which mutates focus).
- **`computer_launch`:** evaluate the target path/app name (basename of path or argv[0]) as the focused app after launch.
- **`computer_clipboard_set`:** treat as global mutating computer action; require app policy check using last-known foreground app, deny if unknown/denied.

## Critical Files

### Create

- `backend/services/permissions/permission-profiles.js`
- `backend/services/permissions/critical-actions.js`
- `backend/services/audit/audit-log.js`
- `backend/services/rollback/rollback-store.js`
- `backend/services/system/system-tools.js`
- `backend/services/system/process-tools.js`
- `backend/services/system/network-tools.js`
- `backend/services/august-api/august-api.js`
- `backend/services/august-api/august-api-routes.js`
- `backend/services/august-api/intent-mapping.js`
- `backend/services/ui/ui-automation.js`
- `backend/services/computer/app-allowlist.js`
- `frontend/desktop/src/sections/settings/ComputerAccessSettings.tsx`

### Modify

- `backend/services/tools/august-tools.js`
- `backend/services/tools/agent-registry.js` (signature change: `classifyTool(toolName, args)`)
- `backend/services/tools/host-agent-tools.js` (no policy enforcement, only reads `READ_ONLY_HOST_AGENT_TOOLS` etc.)
- `backend/services/workbench/workbench.js` (add `executeHostAgentToolWithPolicy`, gate app allowlist + post-observation here)
- `backend/services/sessions/*` (no signature change; reused)
- `backend/services/providers/providers-routes.js` (no change; use `listPublicProviders()` from `august-api`)
- `backend/services/catalog/model-catalog.js` (no change; use `list(opts)` from `august-api`)
- `backend/lib/config.js` (add `security.allowedRoots`, `security.filesystemScope`, `security.postObservationScreenshot`)
- `backend/lib/path-permissions.js` (extend `getAllowedBasePaths()` to include config roots — otherwise `checkPathPermission` still rejects)
- `backend/lib/host-agent.js` (default host → `127.0.0.1` / `localhost`; update Docker error message)
- `backend/index.js` (mount new routes, expose approve via `toolContext`)
- `frontend/desktop/src/api/backend-ui.ts` (wrappers for all new routes)
- `frontend/desktop/src/components/shell/ChatLayout.tsx` (listen `august:ui-action` CustomEvent)
- `frontend/desktop/src/components/shell/RightDrawerState.ts` (extend with `setRightDrawerSection`)
- `frontend/desktop/src/sections/settings/SettingsPage.tsx` (add `SECTION_COMPONENTS['computer-access']`)
- `frontend/desktop/src/settings/settings-registry.ts` (register `computer-access` section)
- `frontend/desktop/package.json` (add `"typecheck": "tsc -b --noEmit"`)

## Tasks

### Task 0: Pre-flight repo corrections (run first)

These are small but block correctness of later tasks. Land them first.

**0.1 Host agent default** (`backend/lib/host-agent.js`):
- Line 3: change `DEFAULT_HOST` fallback from `'host.docker.internal'` to `'127.0.0.1'` (or `'localhost'`).
- Update line ~260 error message so it no longer tells the user to connect via Docker.

**0.2 Path permissions accept config roots** (`backend/lib/path-permissions.js`):
- Update `getAllowedBasePaths()` (line 39-52) to also include `security.allowedRoots` from `config.js` and `augustDataDir` (project root + data path) and `os.tmpdir()`. Make it a function of dynamic config so `permission-profiles.js` can rely on it.

**0.3 Frontend typecheck script** (`frontend/desktop/package.json`):
- Add `"typecheck": "tsc -b --noEmit"` under scripts.

No tests for this task — these are pure corrections to make later tasks possible.

### Task 1: Permission Profiles + Critical Actions

**1.1 `permission-profiles.js`**
- `loadPermissionProfile()` → `{ allowedRoots, filesystemScope, deniedPatterns }`
- `resolveAllowedRoots()` → `[projectCwd, security.allowedRoots, augustDataDir, os.tmpdir()]` deduped. Returns `null` if `filesystemScope === 'root'`.
- `checkAugustPathPermission(filePath, { operation })` → wraps `checkPathPermission` (which now reads the same config via the updated `getAllowedBasePaths()`). Uses `resolveAllowedRoots()` for scope check at this layer.
- `checkCommandPermission(command, { cwd })` → `extractPathsFromCommand` + per-path `checkAugustPathPermission`.

Add `security.allowedRoots` (default `[]`) and `security.filesystemScope` (default `'allowlist'`) to `config.js`. Expose `getComputerRoots()` / `saveComputerRoots(roots, scope)`.

**1.2 `critical-actions.js`**
`classifyCriticalAction({ toolName, args, operation })` → `{ critical, reasons }`. Critical rules: recursive delete; mutations under system dirs (`C:\Windows`, `/usr`, `/etc`, `/var`, `/Library`); credential/env changes; package installs; service/registry commands; killing non-August PIDs; broad destructive shell commands (`rm -rf`, `Remove-Item -Recurse -Force`, `Format-*`, `del /s /q`, `rd /s /q`); changing `security.*` config keys; `august__agents_manage delete`; deleting audit/rollback files.

**1.3 `workbench.js`**
Gate execution on `classifyCriticalAction(toolName, args)`. If critical and `guardMode === 'full'`, still require `confirm-mutation`. Add `isCritical` to `createPendingMutation`.

**Test:** `node --test backend/test/permission-profiles.test.js backend/test/critical-actions.test.js`
- ✔ root scope bypasses allowlist
- ✔ allowlist scope rejects /etc/passwd
- ✔ recursive delete is critical
- ✔ env-set is critical

### Task 2: Audit + Declarative Rollback

**2.1 `audit-log.js`**
Exports `appendAuditEntry`, `readAuditEntries`. JSONL at `dataPath('august_audit_log.jsonl')`. Entry shape:
```js
{ id, at, actor, agentId, sessionId, mode, action, target, category, critical,
  approved, approvalToken, inputSummary, beforeSummary, afterSummary,
  rollbackId, postObservation, result, error }
```
Compose `redactForDisplay(value)` with `patternRedact(text)` (new helper) for `sk-...`, `Bearer ...`, `Authorization`, cookies, `API_KEY=...`.

**2.2 `rollback-store.js`**
Exports `recordRollback({ type, target, before, after })`, `undoRollback(id)`, `listRollbacks()`. Records declarative — no closures. JSON at `dataPath('august_rollback.json')`, cap 100 FIFO. Record:
```js
{ id, at, type, target, before, after, status }
```
Types: `restore_file | delete_created_file | restore_setting | restore_provider | restore_model_selection | restore_agent_config | restore_memory_item`. `undoRollback(id)` dispatches by `type`.

**2.3 Routes**
`GET /ui/audit?limit=200`, `GET /ui/rollback`, `POST /ui/rollback/:id/undo`.

**Test:** `node --test backend/test/audit-log.test.js backend/test/rollback-store.test.js`
- ✔ audit logging redacts secrets
- ✔ rollback restores file content declaratively

### Task 3: Host System Tools

`system-tools.js` registers via `august-tools.js`:
- `august__filesystem_list`, `august__filesystem_read`, `august__filesystem_write`, `august__filesystem_copy`, `august__filesystem_move`, `august__filesystem_delete`
- `august__system_exec`, `august__system_process`, `august__system_env`, `august__system_info`, `august__system_network`

Uniform tool result: `{ ok, requiresApproval?, preview?, result?, auditId?, rollbackId?, error? }`.

**Rules:**
- Paths use `checkAugustPathPermission()` against `resolveAllowedRoots()`
- Mutating file ops `recordRollback()` before write + audit
- Windows shell default `powershell`
- `system_process list` is `read`; `start`/`stop` is `shell` (stop refuses non-August PIDs without explicit confirm)
- `system_env set/delete` always require confirmation (locked decision 2)
- Network redacts auth headers

**Approval flow:** When called from Workbench, approval is granted via `toolContext.approvedMutation: true` (set by `/ui/workbench/confirm-mutation` per `backend/index.js:776-787`). Tools also accept `args.confirmed: true` as a direct-tool fallback only — never require it after Workbench approval.

**Add to `MUTATING_WORKBENCH_TOOLS`:**
- All mutating `august__filesystem_*`
- `august__system_exec`
- `august__system_process` (start/stop)
- `august__system_env` (set/delete)
- `august__system_network` (non-GET)

`process-tools.js` keeps the August-owned PID registry shared with `host-agent-tools.js`. `network-tools.js` provides redacted-fetch.

**Test:** `node --test backend/test/system-tools.test.js`
- ✔ filesystem list works
- ✔ filesystem write previews without confirmed
- ✔ system info returns host summary
- ✔ network request redacts auth headers
- ✔ recursive delete is critical
- ✔ env-set is critical
- ✔ network test uses a local http server (no `https://example.com`)

### Task 4: August Self-Management APIs + Tools

**4.1 `august-api.js`**:
- `snapshot()` — uses `listPublicProviders()` (from `providers-routes.js:328`) and `modelCatalog.list()` (from `model-catalog.js:165`)
- `updateSetting(keyPath, value)` — allowlist-validated for `security.*`; preserves `${env:VAR}` via `collapseEnvVars`; audit + rollback
- `selectModel(model, provider)` — audit + rollback
- Session helpers: `list | create | rename | archive | restore | delete`
- `upsertProvider | deleteProvider`
- `upsertAlias | deleteAlias` (using `model-profiles.js`)
- `upsertTool | deleteTool | upsertMcpServer` (using `mcp-registry`, `plugins`, `service-connections`)
- `upsertAgent`
- `updateMemoryFact | deleteMemoryFact`

**4.2 Tools in `august-tools.js`:**
`august__self_snapshot`, `august__sessions_manage`, `august__settings_update`, `august__providers_manage`, `august__aliases_manage`, `august__models_select`, `august__tools_manage`, `august__memory_manage`, `august__agents_manage`, `august__rollback_undo`.

**Approval flow:** Each mutating tool checks `(toolContext.approvedMutation || args.confirmed === true)`. If neither, returns `{ requiresApproval: true, preview: ... }`. Audit + rollback records only on the actual apply path.

**4.3 `august-api-routes.js`:**
- `GET /ui/august/snapshot`
- `POST /ui/august/sessions/manage`
- `POST /ui/august/settings/update`
- `POST /ui/august/providers/manage`
- `POST /ui/august/aliases/manage`
- `POST /ui/august/models/select`
- `POST /ui/august/tools/manage`
- `POST /ui/august/memory/manage`
- `POST /ui/august/agents/manage`
- `POST /ui/august/rollback/:id/undo`

Mount from `backend/index.js`.

**4.4 Frontend wrappers** in `backend-ui.ts` for all routes.

**Test:** `node --test backend/test/august-api.test.js`
- Snapshot returns all domains
- Preview calls return `requiresConfirmation`
- Settings update blocked unless `confirmed:true` OR `toolContext.approvedMutation`
- Rollback dispatches by `type`

### Task 5: UI Automation + Synchronization

**`ui-automation.js`:** `createUiEvent({ action, target, payload })` validates against `VALID_UI_ACTIONS`. JSONL at `dataPath('august_ui_events.jsonl')`.

Add `august__ui_control` tool (API/state only). Mutating actions require `toolContext.approvedMutation || args.confirmed` (same pattern as Task 4) and join `MUTATING_WORKBENCH_TOOLS`. Audit each.

Routes:
- `POST /ui/august/ui-action`
- `GET /ui/august/ui-events?since=<id>` (replay)

Frontend `ChatLayout.tsx` listens for `august:ui-action` CustomEvents. Action handlers:
- `navigate` → `navigate(target)` (e.g. `/settings/memory-knowledge`)
- `open_drawer`/`close_drawer` → `$rightDrawer` helpers
- `set_drawer_section` → `setRightDrawerSection(target)` (extend `RightDrawerState.ts`)
- `set_guard_mode` → workbench `updateGuardMode`
- `refresh` → TanStack Query `invalidateQueries()`
- `focus_composer` → focus event
- `insert_composer_text` → append to composer value

`backend-ui.ts`: `controlAugustUi(payload)`, `subscribeUiEvents(sinceId)`.

**Test:** Vitest with JSDOM.
- Dispatch `{action:'navigate', target:'/settings/memory-knowledge'}` → route matches
- `{action:'set_drawer_section', target:'tasks'}` → `$rightDrawer.section === 'tasks'`
- ✔ UI navigation action updates route
- ✔ UI drawer action updates drawer state
- ✔ insert_composer_text appends text

### Task 6: Computer-Use App Allowlist (Lift L1)

**`app-allowlist.js`:**
- `getAppPolicy(appName)` → `'allow' | 'ask' | 'deny'`
- `setAppPolicy(appName, policy)`
- Persist `data/computer_apps.json`
- Default for unknown apps: `'ask'`
- Audit policy changes

**`august__app_policy(action, app, policy)`** tool. Audit each change.

**Enforcement site is Workbench**, not `host-agent-tools.js`. `host-agent-tools.js:24` `requiresHostAgentConfirmation()` is decision logic only — it does not see app policy.

In `backend/services/workbench/workbench.js`:
1. Replace `hostAgent.execute(name, args)` at line 1680 with a new `executeHostAgentToolWithPolicy(name, args, toolContext)` helper.
2. Inside that helper, for any mutating `computer_*` tool:
   - Resolve focused app via `computer_list_windows` (NOT `computer_focus_window`) — find `isForeground === true`. If unknown, policy = `'ask'`.
   - `computer_launch`: evaluate target path/app name (basename of `path`/`app` arg) after launch.
   - `computer_clipboard_set`: treat as global mutating action; use last-known foreground app; if none or `'deny'`, refuse.
   - Apply `getAppPolicy`:
     - `deny` → refuse with `error: { code: 'app_denied', focusedApp }`. Audit the refusal.
     - `ask` → if no `toolContext.approvedMutation`, return `requiresApproval: true, preview: { focusedApp, action }` and create pending mutation.
     - `allow` → proceed.
   - Audit each outcome (allow / ask-confirmed / deny).

**Test:** `node --test backend/test/app-allowlist.test.js`
- ✔ app allowlist denies blocked apps
- ✔ app allowlist prompts for unlisted apps
- ✔ `hostAgent.execute` is NOT called directly for mutating computer_* (test calls `executeWorkbenchTool` and asserts hook fires)

### Task 7: Intent Mapping Tool

**`intent-mapping.js`:** `mapAugustIntent(text)` → `{ tool, action, target?, rationale } | null`.

Covers:
- Delete/archive session → `august__sessions_manage`
- Add provider → `august__providers_manage`
- Change model → `august__models_select`
- Open settings → `august__ui_control navigate /settings[/<subroute>]` (resolve subroutes to canonical IDs from `settings-registry.ts`)
- Create file → `august__filesystem_write`
- Remember fact → `august__memory_manage`
- Launch app → `august__system_process start` or `computer_launch`

Add `august__map_intent(text)` tool. Classified `read` — no confirmation needed for the mapping itself, only for the action it returns.

Document the intent→tool table in tool descriptions so the LLM can self-route without calling `mapAugustIntent` first.

**Test:** `node --test backend/test/intent-mapping.test.js`
- "Delete the session called Project Alpha" → `august__sessions_manage`
- "Change the selected model to Claude 3.5 Sonnet" → `august__models_select`
- "Open settings and show me Memory & Knowledge" → `august__ui_control navigate /settings/memory-knowledge`

### Task 8: Computer-Access Settings UI

**`frontend/desktop/src/sections/settings/ComputerAccessSettings.tsx`:**
- Filesystem scope radio (`allowlist`/`root`) + editable `security.allowedRoots` list (Add/Remove)
- Computer-use app allowlist table with Add App and policy dropdown
- Persists via `POST /ui/august/settings/update` (scope/roots) and `POST /ui/august/computer/app-policy` (new route from Task 6)
- Subscribes to `$rightDrawer` for inline diff preview

Register new section in `settings-registry.ts`: `{ id: 'computer-access', label: 'Computer Access', icon: ... }`. **Also** add `SECTION_COMPONENTS['computer-access'] = ComputerAccessSettingsWrapper` in `SettingsPage.tsx:54-67` (otherwise it renders the stub). Produces route `/settings/computer-access` integrated with sidebar + command palette.

**Test:** Vitest + React Testing Library.
- Render section, change scope, add root, set `notepad.exe` to `deny`. Verify via `GET /ui/august/snapshot`.
- ✔ ComputerAccessSettings persists scope
- ✔ ComputerAccessSettings persists app policy
- ✔ SettingsPage mounts ComputerAccessSettingsWrapper for `computer-access` (not stub)

### Task 9: Agent Permissions

In `agent-registry.js`, add: `SYSTEM_TOOLS`, `AUGUST_API_TOOLS`, `UI_TOOLS`, `COMPUTER_POLICY_TOOLS` constants.

**Critical signature change:** `classifyTool(toolName)` → `classifyTool(toolName, args)`. Thread `args` through:
- `evaluateAgentTool(agentId, toolName, args)` — so `august__ui_control navigate` and `august__ui_control set_guard_mode` classify differently
- `requireAgentPermission(agentId, toolName, args)` — so `august__system_network` GET vs non-GET classify differently

Classification:
- `read`: `august__system_info`, `august__filesystem_list/read`, `august__self_snapshot`, `august__map_intent`, `august__ui_control navigate/refresh`
- `edit`: `august__filesystem_write/copy/move/delete`, `august__app_policy`
- `shell`: `august__system_exec`, `august__system_process start/stop`, `august__system_env set/delete`, `august__system_network non-GET`
- `august_api`: self-management mutating tools
- `memory_write`: `august__memory_*` writes
- `ui`: `august__ui_control` mutating

Defaults:
- `build` → `system: ask, august_api: ask, ui: ask`
- `project_manager` and team agents → `allow`
- `plan`, `explore`, `general`, `coordinator` → `deny`
- Subagents inherit parent denies

**Test:** `node --test backend/test/agent-permissions.test.js`
- ✔ agent permissions classify new system/self/UI tools
- ✔ `classifyTool('august__ui_control', { action: 'navigate' })` → `read`
- ✔ `classifyTool('august__ui_control', { action: 'set_guard_mode' })` → `ui`
- ✔ `classifyTool('august__system_network', { method: 'GET' })` → `read`
- ✔ `classifyTool('august__system_network', { method: 'POST' })` → `shell`
- ✔ subagent inherits parent deny

### Task 10: Post-Observation Re-Screenshot (Lift L3)

In `workbench.js`, after any mutating `computer_*` tool in `executeWorkbenchTool` (via `executeHostAgentToolWithPolicy`) succeeds, run the post-observation step:

1. Call `computer_screenshot` via `host-agent-tools.js`. Result is `{ base64 }`.
2. Write the decoded PNG to `dataPath('computer-observations', `${id}.png`)` using `fs.writeFileSync`. Create the dir if missing.
3. Attach to the audit entry as:
   ```js
   postObservation: { screenshotPath, capturedAt, focusedApp }
   ```
4. Do NOT write the base64 string into JSONL audit.

`POST_OBSERVATION_TOOLS` = subset of `MUTATING_WORKBENCH_TOOLS` that are mutating `computer_*`. Add `security.postObservationScreenshot` config (default `true`) to disable; when off, `postObservation: null`.

`focusedApp` = captured during the allowlist check in Task 6.

**Test:** `node --test backend/test/post-observation.test.js`
- Run mutating `computer_*` against safe sandbox app, assert `postObservation.screenshotPath` present and file exists on disk.
- Toggle off, assert `postObservation` is `null`.
- ✔ mutating computer action records post-observation screenshot
- ✔ post-observation disabled by config
- ✔ audit JSONL never contains base64 strings

### Task 11: Verification + Acceptance

**11.1 Backend tests:**
```
node --test backend/test/permission-profiles.test.js
node --test backend/test/critical-actions.test.js
node --test backend/test/audit-log.test.js
node --test backend/test/rollback-store.test.js
node --test backend/test/system-tools.test.js
node --test backend/test/august-api.test.js
node --test backend/test/intent-mapping.test.js
node --test backend/test/agent-permissions.test.js
node --test backend/test/app-allowlist.test.js
node --test backend/test/post-observation.test.js
```

**11.2 Frontend:**
```
cd frontend/desktop
npm run typecheck && npm run build && npm run test
```

(`typecheck` added in Task 0.3.)

**11.3 Manual Workbench acceptance:**
- Plan mode blocks file writes, shell exec, provider edits, model changes
- Ask mode creates pending confirmations for any mutating tool
- Full mode allows normal mutations but confirms critical actions (recursive delete, env-set, package install)
- "Open settings and show Memory & Knowledge" → `/settings/memory-knowledge`
- "Change selected model to Claude 3.5 Sonnet" → preview, confirm, apply, audit, rollback via `august__rollback_undo`
- "Create a file in Documents" → only when Documents is in `allowedRoots` or `filesystemScope: 'root'`
- "Click in focused notepad" → denied/prompted/allowed by app policy. Audit always written
- After any mutating `computer_*`, audit entry contains `postObservation.screenshotPath` (file on disk)
- Audit log redacts `sk-...`, `Authorization`, cookies, `API_KEY=...`
- Rollback restores supported file, setting, model, provider, memory, agent changes

**11.4** `GET /ui/audit?limit=20` returns entries with all required fields, redacted inputs, post-observation `{ screenshotPath, capturedAt, focusedApp }` when applicable.

## Final Self-Review Checklist

- [ ] Every requested capability (filesystem, directories, shell, processes, env, system info, network, sessions, settings, providers, aliases, models, tools, MCP, skills, memory, agents, UI automation, permissions, audit, confirmations, rollback, app allowlist, post-observation, intent mapping, settings UI) maps to a task
- [ ] No destructive host operation executes without a confirmation path. Critical actions always require `confirm-mutation` regardless of `guardMode`
- [ ] Secrets redacted via `redactForDisplay` + `patternRedact` in audit output
- [ ] `collapseEnvVars` preserved through `updateSetting`
- [ ] Mutations under `security.*` keys require explicit confirmation even in `full` mode
- [ ] UI actions update or refresh frontend state; canonical settings routes used
- [ ] Agent permissions classify every new tool consistently; subagents inherit parent denies
- [ ] `permission-profiles.js` wraps existing `path-permissions.js` rather than duplicating; `getAllowedBasePaths()` includes `security.allowedRoots`
- [ ] Rollback records are declarative; `undoRollback` dispatches by `type`
- [ ] Lift L1 (app allowlist) enforced at Workbench `executeHostAgentToolWithPolicy`, NOT only `host-agent-tools.js`
- [ ] Focused-app detection uses `computer_list_windows` (`isForeground === true`); `computer_focus_window` not used
- [ ] `computer_clipboard_set` is treated as global mutating computer action
- [ ] `computer_screenshot` base64 → written to `dataPath('computer-observations', '<id>.png')`; only `screenshotPath` in audit JSONL
- [ ] `hostAgent.execute` defaults to `127.0.0.1` / `localhost`; Docker error text removed
- [ ] Lift L3 (post-observation re-screenshot) implemented with storage step
- [ ] `ComputerAccessSettings.tsx` provides UI for `security.allowedRoots`, `security.filesystemScope`, and computer-app allowlist
- [ ] `SECTION_COMPONENTS['computer-access']` added to `SettingsPage.tsx`
- [ ] `package.json` has `typecheck` script
- [ ] Network test uses local http server, not `https://example.com`
- [ ] Service calls use `listPublicProviders()` and `modelCatalog.list()` (current exports)
- [ ] `classifyTool(toolName, args)` threaded through `evaluateAgentTool` / `requireAgentPermission`
- [ ] Approval flows accept `toolContext.approvedMutation` (Workbench) OR `args.confirmed` (direct-tool fallback); never require `confirmed` after Workbench approval
- [ ] Verification covers backend tests, frontend typecheck/build/test, and Workbench E2E scenarios including the four locked decisions