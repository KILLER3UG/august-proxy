# Reference study — Claude Desktop (Anthropic)

Stage 1 evidence for the 2026-10-03 UI/UX refactor spec. Produced by a research subagent on
2026-10-03 from the local MSIX install (`C:\Program Files\WindowsApps\Claude_2.19675.0.0_x64__pzs8sxrjxfjjc`,
app.asar extracted and read), live config/logs under `$LOCALAPPDATA`, and official
support.claude.com articles. Claim labels: desktop-verified (asar/config), claude.ai-web-verified
(desktop mirrors it), UNVERIFIED.

---

# Claude Desktop — UI/UX Study for August Proxy

## 0. What this app is + exact version studied + verification method

- Claude Desktop for Windows is an **Electron shell whose main window loads the claude.ai web app** — the bundled `index.html` states it outright: *"this is the html for app title bar and error UI. everything else gets loaded from claude.ai"* (`app.asar → .vite/renderer/main_window/index.html`, line 1). The native layer owns: custom title bar/drag regions, boot placeholder, multi-window management (main, Quick Entry, About, Find-in-page, "Artifact window", side panes), updater, tray, MCP host, Cowork VM. The chat UI is the claude.ai React app.
- **Version studied: 2.19675.0.0** (MSIX, `Claude_pzs8sxrjxfjjc`, Electron 44.4.3; Node 24.18.1 per log). Log evidence of auto-update progression 1.32885.1 → 1.34493.1 → 2.19675.0 (`C:\Users\rober\AppData\Local\Claude\logs\main.log`).
- Verification: (1) extracted and read `app.asar` members (`index.html`, `window-shared.css`, `MainWindowPage-BhJD_LC3.css`, main-process `index.chunk-CN7MfJQH.js`, `mainView.js`) — desktop-app-verified; (2) read live config/logs under `$LOCALAPPDATA/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude` and `$LOCALAPPDATA/Claude(-3p)`; (3) official support.claude.com articles; (4) third-party shortcut lists flagged UNVERIFIED.

## 1. Launch experience

- **No splash window.** A *boot placeholder* painted by the shell before the web app arrives: a fixed sidebar-colored strip (hairline seam `rgba(11,11,11,.1)` light / `rgba(255,255,255,.1)` dark) with gray skeleton "rows" plus a **48px drag strip** across the top so the un-drawn window is still draggable (`index.html` boot-placeholder CSS/JS). Auto-collapses below `narrowViewportMaxWidth: 700px`; hidden if a load-error overlay appears.
- **First-frame theming is inlined in HTML** to avoid a dark-mode flash: body `#fcfcfb` (light) / `#151515` (dark) resolved from `prefers-color-scheme` before any CSS loads; values are "pinned equal by build/mainWindowFirstFrame.test.ts" (`index.html` lines 91–127; `window-shared.css` lines 198–218). The window is only *revealed after load* when constructed hidden.
- Default window **1200×800**; `minWidth: 600/720`, `minHeight: 400/560` across window types. Window size/position persisted (`window-state.json`, `quickWindowPosition` in `config.json`).
- Sign-in is OAuth against claude.ai with `https://claude.ai/desktop/callback`. First-run guidance in docs is just: install → "Sign in with your account to get started" (https://support.claude.com/en/articles/10065433-install-claude-desktop). `config.json` records `first_launch_at`, `userThemeMode: "system"`, `windowSizeWasSignedIn`.
- Close ≠ quit: **tray-resident background** with the copy "Claude runs in the background even when you close the window. Click the Claude icon in the system tray to reopen the app, or right-click to quit." (`index.chunk-CN7MfJQH.js`).

**Adopt for August:**
1. Kill the splash; paint a **static skeleton sidebar + drag strip in the HTML itself** so the very first frame is already the final layout, at the last-known sidebar width.
2. Inline the light/dark ground color in `index.html` from the OS scheme and **test-pin it to the design-system token**.
3. Ship 1200×800 default with persisted state; open the window only when the renderer is ready.
4. Make app-close minimize-to-tray with that exact explanatory one-liner.
5. Record `first_launch_at`/`updaterLastSeenVersion`-style facts in a tiny JSON next to user data.

## 2. Layout, spacing, typography, color, theming (exact tokens)

All from `window-shared.css` + `MainWindowPage-BhJD_LC3.css` — desktop-app-verified.

- **Fonts (bundled woff2, variable, weight 300–800):** `AnthropicSans-Roman/Italic-Variable` and `AnthropicSerif-Roman/Italic-Variable`; sans stack `var(--font-anthropic-sans), ui-sans-serif, system-ui…`; mono = `ui-monospace, SFMono-Regular, Menlo…`. Body rendering: `-webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility`.
- **Dark-mode optical weight pin:** bold text gets `font-variation-settings: wght bold + "GRAD"` via `data-mode=dark` selectors — a deliberate dark-mode legibility trick.
- **Ground colors:** light `#fcfcfb` ("warm white"), dark `#151515`; secondary dark text `#a6a39b` (`--claude-text-500`).
- **Gray ramp (CDS, warm-tinted):** `--cds-gray-0 #fff`, `10 #fcfcfb`, `20 #f9f9f7`, `30 #f6f6f4`, `40 #f3f3f0`, `100 #e1e0d9`, `150 #d2d1c7`, `200 #c3c2b7`, `250 #b4b3a8`, `300 #a5a49a`, `350 #97958d`, `400 #898781`, `450 #7b7974`, `500 #6d6b67`…
- **HSL semantic tokens** ("values taken from claude.ai on 2025-10-17"): light bg ramp `--bg-000 0 0% 100%` → `--bg-400 50 20.7% 88.6%` (warm ivory); text `--text-000 60 2.6% 7.6%` → `--text-400 51 3.1% 43.7%`; **brand orange `--accent-brand: 15 63.1% 59.6%`**; blue `--accent-100: 210 70.9% 51.6%`; purple `--accent-pro-*` (251°); danger 0°, success 103° light / 97° dark (`window-shared.css` lines 104–189).
- **Radius scale (density-scaled):** `--cds-radius .25rem` base; comfortable: 0.5rem, xs/sm/lg 0.375/0.4375/0.625rem, **`--cds-radius-composer` 0.875rem**, `--cds-panel-radius` 0.75rem, `--cds-checkbox-radius` 0.3125rem; `9999px` for pills.
- **Spacing rhythm (comfortable density, rem-scaled by `--cds-rem-scale`):** pad xs–xl = 0.375/0.5/0.75/1/1.5rem; gap xs–xl = 0.5/0.75/1/1.75/2.5rem; control heights: `--cds-h-control` 2rem, nested 1.375rem, `--cds-switch-h` 1.25rem; `--cds-icon` 1.25rem (xs 1rem, lg 1.5rem).
- **Type scale (comfortable):** caption .75rem/1.0625rem; footnote & code .8125rem/1.1875rem; **body .875rem/1.25rem**; prose 1rem/1.5rem; heading .9375rem/1.25rem; title 1.375rem/1.75rem; text-entry floor **16px** (`--cds-font-size-text-entry-floor:16px`). Per-message text size variants (`--cds-font-size-prose--textsm .9375rem` … `--textlg 1.125rem`) = the user-facing font-size setting.
- **Density system:** `data-density="comfortable"` on `html` (vs. compact variants) drives every size token through `--cds-rem-scale`.
- **Elevation:** flat design; `--cds-panel-shadow: 0 0 0 1px` (1px ring, no blur), `--cds-shadow-md/lg` subtle (8%/7% black), focus ring = inset page-bg + 1px accent + 6px glow; hairline `.5px` ring support; scroll-fade masks 28px.
- **Theming mechanics:** `data-mode="system|light|dark"` on root + `body.darkTheme`; CDS scopes via `.cds-root`/`.cds-dark-scope`; appearance setting offers **"Light, Match System, and Dark"**; `userThemeMode: "system"` is the live default.

**Adopt for August:**
1. Adopt the **warm-white/charcoal duotone** (`#fcfcfb` / `#151515`) with a warm gray ramp — the single strongest "Claude look" signal.
2. Use **two typefaces only**: a UI sans (w300–800) and a display serif for assistant "prose" moments; keep body at 14px UI / 16px prose with 1.4–1.5 leading.
3. Encode the whole system as **CSS custom properties on `:root[data-density]`** exactly like CDS — one token file, three densities for free.
4. Flat surfaces + **1px ring shadows** and a 6px focus glow; avoid blur-heavy elevation.
5. Dark-mode **optical boldness**: bump `GRAD`/weight on `<b>` in dark theme.
6. Set a **16px floor on the composer input**; expose message text size as sm/md/lg variants of one token.

## 3. Left sidebar

- Width **288px expanded** (boot-frame constant `sidebarWidth:288`); auto-collapse under 700px viewport; toggle via menu **"Hide Sidebar"/"Show Sidebar" — CmdOrCtrl+B**, and a top-right button ("It's not currently possible to completely disable the sidebar", https://support.claude.com/en/articles/8887527-customizing-your-appearance-settings).
- Contents (desktop-verified strings from the bundle; organization claude.ai-web-verified): **New Chat / New Task** actions; **starred** items (localStorage keys `starred` + `epitaxyPrefs` — `claude_desktop_config.json`), **recents**, **Projects**, **Artifacts tab**, plus desktop-mode sections (Code sessions, Cowork spaces) and a **sidebar footer** ("Show the signed-in user's identity… in the sidebar and account menu").
- Account/plan entry: **initials/name button in the lower-left → Settings** (…/8887527; …/10185728).
- **Ctrl+K is the Command Palette** — menu label "Command Palette…" `CmdOrCtrl+K`, *not* chat search; past-chat recall is conversational RAG ("searches … appear as tool calls", https://support.claude.com/en/articles/11817273). Incognito chats are a "ghost icon" and never searched.

**Adopt for August:**
1. 288px sidebar, hairline seam, **auto-collapse < 700px** window width with the same persistence of collapsed state.
2. Three-tier history: **Starred → Projects → Recents**, with starred flags persisted locally per item type.
3. Put an **Artifacts-equivalent tab** in the sidebar so outputs are addressable outside a conversation.
4. **Ctrl+K = command palette** (commands + navigation), not search.
5. Footer = account chip → settings; show provider/identity status there.

## 4. Right panel: artifacts

- **Never inline**: "An artifact opens in its own window beside your conversation" (https://support.claude.com/en/articles/17153992). Panel is a canvas/page for template artifacts and a preview for freeform ones.
- **Sidebar ↔ panel loop**: everything saved to the sidebar Artifacts tab, openable from any conversation.
- Legacy artifacts have "controls at the top of the artifact panel" for view-code/copy/download; errors surface a **"Try fixing with Claude"** button; highlight-to-**"Edit with Claude"** on docs/markdown; **Export** menus per type.
- Versions: editing an earlier message forks a chat version with its own artifacts.
- Rendering isolation is explicit in the shell: dedicated "Artifact preview iframe origin", "Artifact window" window type.
- **Multiple simultaneous items:** the desktop shell has a real pane manager — "Split View", "Close Pane" `CmdOrCtrl+\`, "New Side Chat" `CmdOrCtrl+;`, Move/Focus Split View accelerators, and `desktop-frame.paneStore.v1` persisting `extraPanesByMode`, `colWeightsByMode`, `rowSplit: 0.5` (bundle + config).

**Adopt for August:**
1. Artifacts/outputs open in a dockable right pane beside the chat, never inline; keep a persistent tab list in the sidebar.
2. Implement the pane store as **persisted fractional weights** (`colWeights`, `rowSplit`) keyed by mode.
3. Put **"Edit with Claude" and "Try fixing with Claude"** as first-class panel actions — turn every panel error into a one-click repair prompt.
4. Render untrusted artifact previews in an isolated webview/iframe origin.
5. Version artifacts per message-fork so going back in history never destroys panel state.

## 5. Settings

- Entry: **lower-left initials → Settings**; desktop menu item **"Settings" CmdOrCtrl+,**. In-app page/overlay — not an OS dialog.
- Confirmed section names via docs: **Appearance** (Color mode: "Light, Match System, and Dark"; Chat font: "Default, Match System, and Dyslexic Friendly") (…/8887527); **Memory** ("Topics" list with read/edit/delete per entry, "Search and reference chats" toggle) (…/11817273); **Extensions** ("Browse extensions" directory, `.mcpb` files) (…/10949351); **Capabilities** (code execution & file creation toggles); plus **"Instructions for Claude"** (personalization), **Reflect**, **Time and focus** pages added Jul 9 2026 (release notes; …/10185728).
- Presentation: toggles, selects, per-entry edit dialogs; model/effort defaults are per-chat composer controls rather than settings (…/8664678). Developer settings exist: `developer_settings.json` (`{"allowDevTools": true}`) next to config, plus "Developer settings (under Desktop app)" for MCP logs. Enterprise admins can hide models/effort levels and block auto-updates.
- No settings search documented anywhere in official articles — UNVERIFIED whether one exists.

**Adopt for August:**
1. One settings surface with **stable section names that docs can cite verbatim**.
2. Structure: General / Appearance / Memory / Capabilities / Extensions (MCP) / Developer.
3. Memory page = **browsable, editable list of entries ("Topics")** with per-entry delete and a global "search my chats" toggle — maps 1:1 to August's brain facts.
4. Keep model/effort-style controls **in the composer**, not buried in settings; settings only set defaults.
5. Ship a hidden-but-file-based developer settings plus a visible Developer section for MCP logs.

## 6. Update flow

- **MSIX/Store installs (this machine): in-app updater disabled** — log line "[CCD-autoupdate] Disabled: MSIX install"; the Store delivers updates.
- **Direct installs: Electron autoUpdater** (`autoUpdater.setFeedURL({url:…, serverType:"json"})`) with feed host `https://api.anthropic.com` (log) and **`releases.claude.com`**.
- **Menu/UX:** "Check for Updates…" → "Checking for Updates…" → "You are running the latest version." / "A new version is available. It will be downloaded and installed automatically." Failure copy is precise and actionable: "Claude couldn't reach the update server. If you're on a work network, a firewall or proxy may be blocking {hosts} — ask your IT team to allow them. Otherwise, check your connection and try again, or download the latest version from claude.ai/download." (`index.chunk-CN7MfJQH.js`).
- **Apply semantics:** `restartToUpdate`, **`restartToUpdateWhenIdle`**, `installUpdateWithSessionGuard` — the app waits for running sessions to be safe before restarting. Boot-time "Version changed since last launch: 1.32885.1 → 1.34493.1" detection (`main.log`), plus `updaterLastSeenVersion` in `config.json` for one-time migration prompts.
- User-facing release notes live in one rolling article: https://support.claude.com/en/articles/12138966-release-notes (no in-app notes page found — UNVERIFIED if shown in-app).

**Adopt for August:**
1. Split the flow by install channel.
2. Adopt **idle-guarded restart**: never kill a running turn — precisely August's `turn_end`-aware chance to schedule updates.
3. Copy the three update strings verbatim-in-spirit and the **firewall failure message with the actual host names**.
4. Boot-time "version changed" detection to trigger one-time migrations/notes.
5. Publish one canonical **rolling release-notes article** and link it from the About window.

## 7. Icon system

- Icons are a **custom variable icon font "Anthropicons-Variable"** — not Lucide/FontAwesome.
- Size scale rides the CDS tokens: `--cds-icon` = **1.25rem (20px)** comfortable; xs/sm = 1rem (16px); lg = 1.5rem (24px).
- Stroke weight: UNVERIFIED (font glyphs; no stroke data extractable from CSS).
- MSIX `assets/` carry `Square44x44Logo.targetsize-16/20/30…` with `altform-lightunplated` variants for taskbar theming.

**Adopt for August:**
1. One icon **font or sprite at 16/20/24px** with a single CSS variable controlling default size.
2. Ship **light/dark + unplated tray/taskbar variants** of the app icon.
3. Keep icons geometric-neutral; never let provider logos set the icon style.

## 8. Micro-interactions

- **Motion tokens:** `--cds-dur-fast 60ms`, `--cds-dur-snap 120ms`, `--cds-dur-base 200ms`, `--cds-dur-sheet 300ms`, `--cds-dur-slow 450ms`; eases: out `cubic-bezier(.165,.84,.44,1)`, overshoot `cubic-bezier(.34,1.3,.64,1)`, snap `cubic-bezier(.32,.72,0,1)`, spring for button transforms (`MainWindowPage-*.css`).
- **Streaming/loading:** thinking dots pulse `1.8s linear infinite`; text shimmer `3s linear infinite`; attachment enter/exit 130ms ease; chips/pills animate in with overshoot + fade.
- **Message actions:** hover-revealed — `--cds-message-actions-opacity` 0→1, reveal-in delay `.1s` at snap duration, reveal-out at fast duration (appear slightly delayed, vanish instantly).
- **Composer:** `--cds-radius-composer` 0.875rem; model name + **Effort** menu (Low/Medium/High/Max, one marked "Default"), separate **"Thinking"/"Extended"** toggle (https://support.claude.com/en/articles/8664678).
- **Extended thinking:** "a 'Thinking' indicator with a timer and an expandable 'Thinking' section above the response" — a live elapsed timer, not just a spinner.
- **Tool calls:** claude.ai RAG search "will appear as tool calls"; MCP tools reachable via composer "+"; MCP Apps render as widgets with a text fallback.
- **Empty/error states:** dedicated load-error overlay in the shell (`[data-load-error-overlay]` hides the boot placeholder); crash-recovery copy: "Claude crashed repeatedly. Try restarting… Disable Hardware Acceleration".
- **Keyboard shortcuts (desktop-verified, application menu):** CmdOrCtrl+K Command Palette · CmdOrCtrl+B Toggle Sidebar · CmdOrCtrl+, Settings · CmdOrCtrl+/ Keyboard Shortcuts overlay (Help) · CmdOrCtrl+N (+ variants) / "New Chat" · CmdOrCtrl+; New Side Chat · CmdOrCtrl+\ Close Pane · CmdOrCtrl+Shift+O Open Folder · Ctrl+Alt+Shift+O Open File · CmdOrCtrl+Shift+T Reopen Closed Session · CmdOrCtrl+F Find… · CmdOrCtrl+=/-/0 zoom, F11 full screen · standard edit ops incl. "Paste and Match Style" CmdOrCtrl+Alt+Shift+V. Quick Entry (mac): double-tap Option, Option+Space, or custom. Third-party web-app lists — UNVERIFIED.

**Adopt for August:**
1. Encode motion as **five durations + three eases** (60/120/200/300/450ms; out/overshoot/snap) and use overshoot only for pill/chip entries.
2. Copy the **thinking indicator pattern: elapsed timer + collapsible reasoning block** — August already has phase/step state to feed it.
3. Hover-revealed message actions: **100ms-delayed fade-in, instant fade-out** so they never flicker.
4. Tool/MCP progress = named tool call cards with a text fallback when a widget can't render.
5. Build the **Help → Keyboard Shortcuts overlay (Cmd+/) generated from the real accelerator table** so it can never drift.
6. Adopt "Paste and Match Style" and "Reopen Closed Session" — cheap desktop-native trust builders.

---

**Cross-cutting architecture lessons:** (1) the shell/web split lets Claude ship UI daily while the Electron shell changes rarely — August's equivalent is `web-dist/` + Rust shell; (2) first-frame correctness is engineered with dedicated tests (`mainWindowFirstFrame.test.ts`) — worth replicating; (3) every guardrail is persisted as small typed JSON stores (`epitaxyPrefs`, `paneStore.v1`, `window-state`) rather than hidden state.
