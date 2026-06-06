# Host Agent Computer Use — Design Spec

**Date:** 2026-06-03
**Status:** Approved Design
**Author:** AUGUST

## 1. Problem

The August Proxy has a host-agent sidecar (`apps/host-agent/`) running on the Windows host that can control the desktop — screenshots, mouse, keyboard, window management, app launching, clipboard, and browser automation. However, the upstream AI model has no visibility into these 15 tools because they are not injected into the proxy's tool dispatch chain (`executeManagedProxyTool()`). The model cannot autonomously use the user's computer.

## 2. Goal

Expose all 15 host-agent computer control tools to the upstream AI model through the proxy's existing managed-tool pipeline, with per-action confirmation for input operations and a UI toggle for enabling/disabling the capability.

## 3. Architecture

```
AI Client (Claude Desktop, OpenAI API, etc.)
    |
    | POST /v1/messages or /v1/chat/completions
    v
August Proxy (Docker container)
    |
    |-- Inject host-agent tool definitions into system prompt
    |-- Forward to upstream AI model
    |
    |-- Intercept model response for tool calls
    |   executeManagedProxyTool("computer_*", args)
    |       |
    |       |-- Read-only tools (screenshot, screen size,
    |       |   mouse position, list windows, clipboard get)
    |       |   → execute immediately
    |       |
    |       |-- Input tools (mouse click, mouse move, type,
    |       |   key press, window focus, app launch,
    |       |   clipboard set, browser open/close)
    |       |   → client confirmation prompt → execute
    |       |
    |       v
    |   host-agent.js:execute(toolName, args)
    |       |
    |       | HTTP POST http://host.docker.internal:6312/
    |       v
    Host Agent (Windows host, port 6312)
        |
        | PowerShell / C# execution
        v
    Windows Desktop (actual user machine)
```

## 4. Tool Definitions

15 tools in 6 categories, defined in a new file `apps/proxy/src/services/tools/host-agent-tools.js`:

### 4.1 Screenshot & Screen Info (read-only, no confirmation)

| Tool | Description | Parameters |
|---|---|---|
| `computer_screenshot` | Capture full desktop screenshot | None |
| `computer_screen_size` | Get display resolution | None |
| `computer_mouse_position` | Get cursor coordinates | None |

### 4.2 Mouse Control (input, requires confirmation)

| Tool | Description | Parameters |
|---|---|---|
| `computer_mouse_move` | Move cursor | `x: number, y: number` |
| `computer_mouse_click` | Click at position | `x: number, y: number, button: "left"\|"right"` |
| `computer_mouse_double_click` | Double-click at position | `x: number, y: number` |
| `computer_mouse_right_click` | Right-click at position | `x: number, y: number` |

### 4.3 Keyboard (input, requires confirmation)

| Tool | Description | Parameters |
|---|---|---|
| `computer_type` | Type text string | `text: string` |
| `computer_key` | Key press | `keys: string, modifiers?: string[]` |

### 4.4 Window & App Management (input except list_windows)

| Tool | Description | Parameters | Confirmation |
|---|---|---|---|
| `computer_list_windows` | List visible windows | None | No |
| `computer_focus_window` | Bring window to foreground | `window_title: string` | Yes |
| `computer_launch` | Launch app or URL | `target: string, args?: string[]` | Yes |

### 4.5 Clipboard

| Tool | Description | Parameters | Confirmation |
|---|---|---|---|
| `computer_clipboard_get` | Read clipboard text | None | No |
| `computer_clipboard_set` | Write clipboard text | `text: string` | Yes |

### 4.6 Browser (all require confirmation)

| Tool | Description | Parameters |
|---|---|---|
| `computer_open_browser` | Open Chromium | `headless?: boolean` |
| `computer_close_browser` | Close browser | None |

## 5. Files to Modify

| File | Change | Size |
|---|---|---|
| `apps/proxy/src/services/tools/host-agent-tools.js` | **New** — exports `getHostAgentToolDefinitions()` | ~90 lines |
| `apps/proxy/src/services/tools/anthropic-tools.js` | Add `isHostAgentToolName()`, import and merge host-agent definitions into the managed tool list | ~15 lines |
| `apps/proxy/src/adapters/anthropic.js` | Add `isHostAgentToolName()` check in `executeManagedProxyTool()`, route to `host-agent.js:execute()` | ~10 lines |
| `apps/proxy/src/adapters/openai.js` | Same check in `resolveManagedWebToolCalls()` | ~10 lines |
| `apps/proxy/src/ui/ui.html` | Add Host Agent status card with Start/Stop toggle | ~40 lines |
| `apps/proxy/src/ui/ui.js` | Add toggle and status-polling handlers | ~60 lines |
| `apps/proxy/src/index.js` | Add `/api/host-agent/status`, `/api/host-agent/toggle`, and `POST /api/host-agent/execute` REST endpoints | ~50 lines |
| `apps/proxy/src/data/config.json` | Add `hostAgent.enabled`, `hostAgent.autoStart`, `hostAgent.bindAddress` config keys | ~5 lines |
| `apps/host-agent/index.js` | Change bind address from `127.0.0.1` to `0.0.0.0` (configurable); add `Authorization: Bearer` check | ~25 lines |

Total: ~305 lines across 9 files (1 new, 8 modified).

## 6. Confirmation Flow

Read-only tools pass through without interruption. Input tools use the adapter's existing `bypassConfirmation` mechanism:

1. Model calls `computer_mouse_click({"x": 500, "y": 300})`
2. Proxy intercepts, sees it's a host-agent input tool
3. Proxy returns a `tool_use` with `{"bypassConfirmation": false}` — the client displays "Model wants to click at (500, 300)"
4. User approves → client retries same call with `bypassConfirmation: true`
5. Proxy executes via `host-agent.js:execute()`

This is identical to how `august__bash` confirmation works today, applied at the adapter level so both Claude-format and OpenAI-format clients get it.

## 7. UI Toggle

A small card in the proxy dashboard sidebar showing:
- Current status (Connected / Disconnected / Starting...)
- Port indicator
- Start / Stop / Restart buttons
- Auto-polls `/api/host-agent/status` every 5 seconds when in Starting state

When disabled: host-agent tools are excluded from the injected tool definitions. Model cannot see or call them.

## 8. REST API Access (Proxy-Level)

All host-agent tools are accessible as a REST API on the proxy, similar to August Tools at `/august/tools`.

**Endpoint:** `POST /api/host-agent/execute`

**Auth:** Same `x-august-key` header or `Authorization: Bearer` as the proxy's existing API.

**Request body:**
```json
{
  "tool": "computer_screenshot",
  "args": {},
  "bypassConfirmation": false
}
```

**Behavior:**
- Read-only tools (`computer_screenshot`, `computer_screen_size`, etc.) execute immediately.
- Input tools with `bypassConfirmation: false` return a preview response showing what the tool will do.
- Input tools with `bypassConfirmation: true` execute the action.

This lets external scripts, automation tools, or any HTTP client on the LAN call any desktop action through the proxy at port 8085.

## 9. Direct Host-Agent Access (External Clients)

The host-agent (`apps/host-agent/index.js`) binds to `0.0.0.0:6312` so it's reachable from other machines on the network, not just localhost.

**Authentication:** Every HTTP request must include `Authorization: Bearer <AUGUST_SECRET_KEY>` matching the proxy's configured key. Requests without valid auth are rejected with 401.

**Request format** (unchanged from current protocol):
```json
{
  "action": "computer_screenshot",
  "args": {}
}
```

**Security notes:**
- Uses the same shared key as the proxy (`AUGUST_SECRET_KEY` from `.env` or config)
- Plain HTTP (no TLS) — suitable for trusted LAN only
- Direct calls bypass the per-action confirmation flow (auth key is the gate)
- The `0.0.0.0` binding is configurable — can be reverted to `127.0.0.1` for local-only access

## 10. Non-Changes (explicitly out of scope)

- **No changes to the host-agent's core execution logic** — PowerShell commands, C# helpers are untouched
- **No changes to Dockerfile or docker-compose** — the proxy reaches the host via `host.docker.internal:6312` which already works

## 11. Verification

1. **Start host-agent:** `cd apps/host-agent && npm start` (Windows)
2. **Start proxy:** `docker-compose up` (Docker)
3. **Check UI:** Dashboard sidebar shows Host Agent status card → Connected
4. **Send test prompt to Claude:** "Take a screenshot of my desktop" — model should call `computer_screenshot`, return image
5. **Send input test:** "Open Notepad" — model should call `computer_launch`, require confirmation, then execute
6. **Toggle off:** Click Stop in UI — subsequent tool calls return "Host agent is disabled"
7. **Toggle on:** Click Start — tools become available again
