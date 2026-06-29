# Chat UX & Provider/MCP Fixes — Design

Date: 2026-06-30
Branch: python-backend
Status: Approved design → implementation

## Goal

Fix seven related defects/features in the desktop chat experience and its
backend model/provider/MCP plumbing:

1. The "AUG" working animation intermittently fails to appear while the model is responding.
2. The chat area is width-capped and its scrollbar is not at the screen edge.
3. The model can't reliably see/execute all MCP tools (Google Workspace, GitHub).
4. The chat model dropdown doesn't pick up newly-added providers/models; its refresh button is a no-op without a backend restart.
5. `API key not configured for MiniMax (Global)` even though the key is set in the Model Provider tab.
6. Typing `/` then selecting a command yields `//command`; several slash commands are stubs.
7. No proper "list all slash commands and their capabilities" feature.

Locked decisions (from clarifying round):
- **Layout:** full-width chat that re-flows with sidebars; scroll thumb at the chat-area edge.
- **Tools:** all MCP tools always exposed to the model; keep BM25 progressive disclosure for the rest.
- **Help:** both a rich in-thread `/help` panel and an upgraded live slash dropdown.
- **Scope:** all seven in one sequenced plan.

---

## 1. AUG working animation

### Current behavior
- `WorkingIndicator` renders the A-U-G animation
  (`frontend/desktop/src/components/chat/WorkingIndicator.tsx`).
- It is mounted only when `isLast && streaming && !showRaw`
  (`ChatThread.tsx:2662`).
- `streaming = chatRuntime.isSessionStreaming(sessionId)` (`ChatThread.tsx:371`)
  and the Stop button uses the **same** `streaming` value (`ChatThread.tsx:1810`).
  So AUG and the Stop button already share one source of truth.
- `chatRuntime` is a module-level singleton (`chat-runtime.ts:193`), so streaming
  state survives component remount. The component subscribes for re-render via
  `chatRuntime.subscribe(...)` (`ChatThread.tsx:704`).

### Root cause
The Stop/AUG divergence is the extra `isLast` gate. On session/tab switch the
thread remounts and rebuilds `messages` from the per-session stream state /
localStorage; the in-flight assistant message may briefly not be the array's
last element (or have zero display blocks), so `isLast` is false even though
`streaming` is true. Result: Stop button shows, AUG does not.

### Fix
Decouple AUG visibility from message identity so it tracks `streaming` exactly
(matching the Stop button, as the user requested):
- Render the AUG indicator based on session-level `streaming` alone, not
  `isLast`. Concretely, render a single `WorkingIndicator` anchored just above
  the composer (inside the chat column) whenever `streaming === true` for the
  active session, and remove/relax the per-message `isLast && streaming` mount
  so we don't double-render. (If we keep the per-message one, gate the
  composer-anchored one on "no streaming assistant block is currently the last
  message" to avoid duplicates.)
- Ensure `streaming` is read live on mount (already the case) and that
  switching sessions recomputes it for the new `sessionId` (already keyed on
  `sessionId`).

### Test
`frontend/desktop/src/test/` — add a test that mounts ChatThread with
`chatRuntime` reporting a streaming turn for the session but with `messages`
arranged so the streaming assistant message is NOT last, and assert the
WorkingIndicator (AUG) is present. Also assert AUG is present iff the Stop
button is present.

---

## 2. Full-width chat + edge scrollbar

### Current behavior
- `ChatLayout.tsx:280-295` wraps the chat `<Outlet/>` in
  `flex-1 ... justify-center` with an inner `w-full max-w-3xl` column, so the
  chat is capped and centered; the scroll container
  (`ChatThread.tsx:1987`, `flex-1 overflow-y-auto chat-scroll`) lives inside
  that capped column. A stale comment (`ChatThread.tsx:714`) claims the thumb is
  at the screen edge — it is not.
- `SessionSidebar` and `RightDrawer` are already flex siblings, so the chat
  area's available width already changes when they open/close.

### Fix
- Remove the `max-w-3xl` cap (and the `justify-center` wrapper) so the chat
  column is `flex-1 min-w-0` and fills the space between the sidebars. The
  existing flex layout makes it re-flow automatically when the session list or
  right drawer expand/collapse.
- Keep message readability with internal padding (e.g. inner content
  `max-w-3xl mx-auto` on the message list only) while the **scroll container**
  spans the full chat-area width so the scrollbar/thumb sits at the chat-area
  (screen, or right-drawer) edge.
- Verify the scroll-to-bottom / fade-indicator logic
  (`ChatThread.tsx:600-628, 3209-3221`) still targets the correct
  `.overflow-y-auto` ancestor after the wrapper change.

### Test
Manual/visual via the run skill: chat fills width with both sidebars closed;
opening the session list and right drawer shrinks the chat and the thumb stays
at the chat-area edge.

---

## 3. MCP tools always visible + executable

### Current behavior
- `tool_definitions()` / `openai_tool_definitions()`
  (`workbench.py:766-855`) DO include MCP tools via
  `_mcp_tool_definitions_anthropic/openai` →
  `mcp_client.get_mcp_tool_definitions_sync()`.
- Execution routes correctly: `_execute_tool` (`workbench.py:1948`) detects
  `is_mcp_tool_name` and calls `execute_mcp_tool_call` (`workbench.py:1977`).
- BUT `assemble_tool_defs` (`model_tools.py:123`) splits tools into
  `core` (frozenset `AUGUST_CORE_TOOLS`) vs `deferrable`, and when the
  deferrable token mass exceeds the threshold it BM25-defers non-core tools —
  so some MCP tools may not be presented to the model.
- The MCP tool cache (`mcp_client._tools_cache`) is only populated by
  `refresh_mcp_tools()` at startup / on config change; empty until then.

### Fix
- In `assemble_tool_defs`, treat MCP tools (name prefix `mcp__`) as **core**
  (never deferrable) so they are always presented. Implementation: when
  classifying (`model_tools.py:149-155`), route `name.startswith("mcp__")` into
  `core_defs`. This satisfies "all MCP, keep disclosure for the rest."
- Ensure MCP tool cache freshness: trigger `refresh_mcp_tools()` not just at
  startup but lazily when `get_mcp_tool_definitions_sync()` is empty and servers
  are registered, so Google Workspace / GitHub tools appear without a restart.
- Confirm Google Workspace and GitHub MCP servers are registered in the MCP
  config (`mcp_client._mcp_config_path()` / `_load_config`) and started; if the
  startup fan-out doesn't auto-start configured servers, ensure registered
  servers get discovered. (Verification step — only add code if a gap is found.)

### Test
- `backend-py/tests/` — unit test for `assemble_tool_defs`: given a tool set
  over threshold including `mcp__github__*` and `mcp__workspace__*` tools,
  assert every `mcp__`-prefixed tool is present in `result.tool_defs` even when
  `activated` is true.

---

## 4. Model dropdown refresh / new-provider propagation

### Current behavior
- Dropdown models come from `useModels()` (`hooks/useModels.ts`) →
  `getAggregatedModels()` → `/api/models` (backend `model_service.aggregate`,
  5-min cache, invalidated on provider writes via `model_service.invalidate_cache()`).
- The list is then filtered by `availableProviders`
  (`ChatThread.tsx:411-425`), a `Set` populated **once on mount** by
  `initProviderAvailability()` (`ChatThread.tsx:769-818`, called at 816). It is
  never refreshed, so a newly-added provider's models stay filtered out until
  remount/restart.
- The dropdown's refresh button calls `refetchModels()`
  (`ChatThread.tsx:1791`), which re-runs the React Query with the same key and
  no `refresh=true`, so the backend's cached list is returned unchanged.

### Fix
- Move provider availability into React Query (new `useProviderAvailability`
  hook keyed `['provider-availability']`, or fold into `useModels`) so it polls
  and can be invalidated, replacing the one-shot `useEffect`.
- Make the refresh button force a real refresh:
  - call `getAggregatedModels({ refresh: true })` (bypasses backend cache), and
  - `queryClient.invalidateQueries({ queryKey: ['aggregated-models'] })` and
    `['provider-availability']`.
- When providers change in the Providers/Models tabs, invalidate both query
  keys (frontend already invalidates models in some places — extend to provider
  availability). Backend already calls `invalidate_cache()` on provider writes.
- Net effect: adding a provider, or clicking refresh, updates the chat dropdown
  without a backend restart.

### Test
`frontend/desktop/src/test/` — test that invalidating `['provider-availability']`
re-runs the fetch and that a model whose provider becomes available appears in
the filtered `models`. Test that the refresh handler calls
`getAggregatedModels` with `{refresh:true}` and invalidates both keys.

---

## 5. MiniMax (Global) — provider/key resolution mismatch

### Root cause
Two independent provider stores, not cross-consulted:
- **Built-in registry**: `minimax.py` (`INFO.name = "MiniMax (Global)"`),
  registered via `builtin.register_all()`. Its `resolve_api_key(env_key)` only
  returns the passed env key (`MINIMAX_API_KEY`).
- **Custom store** `providers.json` (`config_service.get_providers_store`),
  where the "Add provider" UI (`routers/providers.py` POST) saves
  `{id, name, apiKey, ...}`.

`/api/config/activeProvider` (`routers/config.py:19-65`) reads BOTH stores, so
the Models/Providers tab shows MiniMax as available. But the workbench resolves
providers via `_resolve_workbench_provider` → `provider_resolver.resolve`
(`resolver.py:26`), which searches the **registry only** and never the custom
store. So:
- Name "MiniMax (Global)" matches the built-in (`resolver.py:57-59`), whose
  `resolve_api_key()` reads the env var — empty if the key was saved in
  `providers.json` → workbench credential check fails (`workbench.py:964-973`)
  → `API key not configured for MiniMax (Global)`.

### Fix
Make provider + key resolution consult the custom providers store, so the
workbench sees the same availability the UI shows.
- Add a single source-of-truth helper (e.g. in `config_service` or a small
  `provider_credentials` module) that, given a provider name/id, returns the
  effective `{provider_def, api_key, base_url, api_mode}` by checking, in order:
  custom `providers.json` entry (by id or name) → built-in registry +
  config.json/env key.
- Update `provider_resolver.resolve` and `_has_api_key` to recognize custom
  store entries (build a provider dict from the store entry: name, baseUrl,
  apiFormat→api_mode, apiKey) so name/id resolution succeeds for custom
  providers.
- Update the workbench credential check (`workbench.py:964-973`) and
  `get_client(...).resolve_api_key()` path to use the stored key when present.
- Built-in MiniMax: ensure that when a key is saved against the built-in
  provider name (config.json under `"MiniMax (Global)"`), `resolve_api_key`
  receives it (the client wrapper passes the config/env key). Confirm and fix
  the wiring so a key set in the UI for the built-in is honored.

### Test
`backend-py/tests/` — given a `providers.json` with a MiniMax-like custom entry
that has `apiKey`, assert `_resolve_workbench_provider` returns a provider whose
resolved key is non-empty and the credential check passes (no
"API key not configured" error path). Also test the built-in path with a key in
config.json.

---

## 6. Slash command double-slash + stubs

### Root cause
- Selecting from the commands dropdown calls `insertText(c.name + ' ')`
  (`ChatThread.tsx:1582`); `insertText` (`ChatThread.tsx:1512`) inserts at the
  cursor while the typed `/` remains → `//help`.
- Several commands are stubs (`/new` shows a toast `ChatThread.tsx:1198-1202`;
  others may be partial). Dropdown has no keyboard navigation, and Enter always
  calls `send()` (`onKey`, `ChatThread.tsx:1415-1417`), so you can't pick the
  highlighted item with Enter.

### Fix
- Replace the current slash token instead of appending: when a command is
  chosen, set the input to the command (`/help `) by replacing the leading
  `/...` token rather than inserting. Add an `insertCommand(name)` that computes
  the replacement against the current input so no duplicate `/` can occur.
- Add keyboard support to the commands dropdown: ArrowUp/Down to move a
  highlight, Enter to select the highlighted command (and only fall through to
  `send()` when the dropdown is closed or nothing is highlighted), Esc to close.
- Audit `COMMANDS` (`ChatThread.tsx:267-280`) and wire the stubs:
  - `/new` → actually create a new session (dispatch the same path the sidebar
    uses; ChatLayout already has `createSession`/navigate — expose via a UI
    event like the existing `august:*` events).
  - Verify `/clear`, `/reset`, `/debug`, `/model`, `/provider`, `/load`,
    `/skills`, `/exam`, `/btw`, `/goal` each have a working handler; fix or
    remove any that don't.

### Test
`frontend/desktop/src/test/` — typing `/` then selecting `/help` yields input
`/help ` (exactly one slash). Arrow+Enter selects a command. Enter with the
dropdown closed sends.

---

## 7. `/help` — list all commands + capabilities

### Current behavior
`/help` builds a string from `COMMANDS` and shows a 12s toast
(`ChatThread.tsx:1183-1186`).

### Fix
- **Single source of truth:** extend the `COMMANDS` array entries with
  `{ name, desc, usage?, example?, category? }` so both the dropdown and the
  help panel render from one list.
- **In-thread panel:** `/help` (and a new `/commands` alias) injects a
  non-LLM assistant "command" block / card into the thread listing every
  command with description, usage, and example, grouped by category. Persistent
  and scrollable (not a toast). Reuse the existing message/disclosure rendering
  patterns in ChatThread rather than a modal.
- **Dropdown upgrade:** the live slash dropdown
  (`ChatThread.tsx:1566-1600`) shows description + example per command from the
  same enriched list.

### Test
`frontend/desktop/src/test/` — `/help` renders an in-thread panel containing
every entry in `COMMANDS`. Dropdown lists the same commands with descriptions.

---

## Implementation sequencing

Backend correctness first (unblocks the dropdown/MiniMax symptoms), then
frontend:

1. **Backend:** provider/key resolution consults custom store (#5).
2. **Backend:** MCP tools forced core in `assemble_tool_defs` + cache freshness (#3).
3. **Frontend:** provider-availability + refresh via React Query (#4).
4. **Frontend:** AUG decoupled from `isLast` (#1).
5. **Frontend:** full-width layout + edge scrollbar (#2).
6. **Frontend:** slash command token-replace + keyboard nav + wire stubs (#6).
7. **Frontend:** enriched COMMANDS + `/help` panel + dropdown (#7).

Each step ships with the test named in its section. Backend tests via the
existing `backend-py/tests` harness; frontend via the existing
`frontend/desktop/src/test` (vitest) harness.

## Non-goals / YAGNI

- No redesign of the provider/registry architecture beyond making the custom
  store consulted by the resolver.
- No new MCP server types; only ensure existing configured servers
  (Google Workspace, GitHub) are visible/executable.
- No change to the BM25 disclosure algorithm itself, only the MCP
  classification.
- No general slash-command framework rewrite; enrich the existing array and
  handlers.
