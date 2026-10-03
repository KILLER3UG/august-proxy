# Current-state audit — desktop shell, launch, sidebar, right drawer

Stage 1 evidence for the 2026-10-03 UI/UX refactor spec. Read-only audit by a subagent on
2026-10-03 of `C:\Dev\august-proxy\frontend\desktop`. All paths relative to `frontend/desktop/`
unless noted; line numbers 1-based as read that day. Includes a verification pass over the
claims in `docs/plans/AUGUST-UI-ENHANCEMENTS.md` (several corrected — see §8).

---

# August Proxy — Desktop Shell UI Audit (current state, 2026-10-03)

## 1. Launch sequence (app start → chat usable)

1. `src/App.tsx:84` — everything renders inside `BackendBootstrapGate`; `CommandPalette`, `ShortcutsModal`, `ConversationSearchModal`, `OnboardingTour`, `ProviderOnboardingModal`, `UpdateConversation` mount inside the gate; `QuitConfirmModal` and `UpdateRelaunchOverlay` mount outside it (comment at App.tsx:110-116 explains why: close must work even with a dead backend).
2. `src/components/overlays/BackendBootstrapGate.tsx:81-88` — 1 s poll of `proxy_status` / `backend_last_error`; `:93-111` auto-restarts the proxy once after 8 s. Gate unlocks only when `proxyUp && convDone && phase !== 'error'` (`:121-125`); `failed || materializing || !unlocked` keeps the full-screen `z-[200]` veil up (`:159,188`).
3. While gated, `LaunchConversation` (`components/overlays/LaunchConversation.tsx:35-47`) plays a scripted animated chat whose live status row reflects the real setup phase; the reveal waits for its closing beat.
4. Error state (`BackendBootstrapGate.tsx:190-226`): card with retry, last error, and a "Common fixes" list that appears after 10 s ("slow") / 30 s ("critical") wait-phase escalation (`:128-133`).
5. There is **no splash screen**; the window shows `backgroundColor #0e0e10` (`src-tauri/tauri.conf.json:27`) until React paints the gate veil.
6. First-run onboarding exists — two independent overlays, both mounted at `App.tsx:105-106`:
   - `OnboardingTour` (`components/overlays/OnboardingTour.tsx:77-84`): 4-step tour, opens 1.2 s after mount when `sessions.length === 0` and `august_onboarding_done` unset; z-50, focus trap, X button; no Escape/backdrop dismiss.
   - `ProviderOnboardingModal` (`components/overlays/ProviderOnboardingModal.tsx:31-49` + `hooks/useProviderOnboardingState.ts:119`): setup checklist shown while no provider is configured and not skipped/done; deliberately not backdrop-dismissible (`:82-83`); first API key is set by navigating to `/settings/providers` (`useProviderOnboardingState.ts:83`).
   - **Gap:** the two overlays have no mutual gate — on a truly fresh install both conditions hold, both render at z-50, and stacking order is portal-timing luck.
7. Chat becomes usable without any user action: `ChatLayout.tsx:349-385` redirects `/` to the last-active session, or **auto-creates one** (`createSessionInCurrentWorkspace`, `:328-336`) when none exists — a brand-new user never sees an empty session list; they land in an auto-created "New chat" in the "Tasks" group with the OS home dir as workspace.
8. `PageLoader` (`src/components/PageLoader.tsx`) is only the Suspense fallback for lazy sections (`src/routes.ts:48-59`); it never gates first paint of the shell.

## 2. Titlebar — `components/shell/ChatTitlebar.tsx`

- Contents left→right (`:120-245`): sidebar-show button (only when collapsed, `:126-135`), Back/Forward (`:137-156`), session-title dropdown (Rename via `window.prompt` `:183`, Open workspace folder, Copy path), folder chip (`:221-233`), branch chip (`:236-243`). Right side (`:247-303`): Artifacts button, Share (copies `window.location.href` `:260-265`), workbench launcher with workers badge (`RightDrawerLauncher.tsx:29-54`), Windows-style min/max/close (`:280-302`).
- `data-tauri-drag-region` on the `<header>` (`:122`) and left cluster (`:125`); buttons don't opt out but sit above the attribute, so they stay clickable.
- `isMaximized` is read once on mount (`:83-92`, `useEffect []`) and re-synced only after the app's own toggle (`:108`). No `onResized`/maximize listener → external maximize (Win+Up, drag-to-edge, double-click on drag region) leaves the restore/maximize icon and `aria-label` stale.
- Height conflict: `h-10` at `:123` vs `.august-titlebar { height: 2.85rem !important }` in `src/styles/chat.css:385-390` — effective 45.6 px; the `h-10` window buttons (`:283,290,297`) stay 40 px inside it, and `SessionListNav.tsx:72` aligns its brand bar to `h-10` (40 px) with a comment claiming it is "aligned with main ChatTitlebar" — it is 5.6 px off from what actually renders.
- Close does not quit: `handleClose` → `getCurrentWindow().close()` (`:112-118`) → Rust `CloseRequested` handler does `api.prevent_close()` and emits `quit-requested` (`src-tauri/src/lib.rs:109-117`), which opens `QuitConfirmModal` (`components/overlays/QuitConfirmModal.tsx:56-67`, z-70, Escape ✓).

## 3. Left sidebar — `SessionSidebar.tsx` + `components/sidebar/*`

- `SessionSidebar.tsx:93-134`: width-animated `motion.aside`, inner width pinned via style (`:107`), 1 px pointer resize handle (`:119-131`). Collapse state persists to `localStorage` (`ChatLayout.tsx:38,47-49,559-561`).
- Widths: default 280, min 220, max 33vw (`SessionSidebar.tsx:16-19`); persisted `:48-51`; clamped but **not re-clamped on window resize** (unlike the drawer, `RightDrawer.tsx:150-157`).
- Contents via `SessionList.tsx`: brand bar + collapse + destination dock with review-inbox badge (`SessionListNav.tsx:69-182`), New chat (`:95-110`), Artifacts/Customize rows (`:116-145`), title-filter search box (`SessionList.tsx:520-544`, Escape clears `:527`), Pinned section (`:553-575`, pin persisted in `august-pinned-sessions`), BotsRail (`:579-590`), project folders with collapse/new/rename/delete (`:600-646`), "Chats and tasks" uncategorized group capped at 5 with "Show N more" (`:663-691`), "View all" → full conversation search modal (`:702-712`), account footer with UserDropdown + update button (`:720-782`).
- Needs-attention indicators: one aggregate poll `getNeedsAttention` every 15 s (`ChatLayout.tsx:118-136`) feeding `needs-handoff-store.ts:21-32`; amber dot rendered per `SessionRow.tsx:381-382`. Working/streaming pulse dot merged from live poller (`SessionList.tsx:249-262`).
- Rename/create-folder use native `window.prompt` (`SessionList.tsx:368,375`; `ChatTitlebar.tsx:183`) — inconsistent with the styled ConfirmDialogs used for deletes, and `window.prompt` is unsupported in some Tauri webviews (WKWebView/macOS).
- Dead subscriptions: `SessionSidebar.tsx:42-44` (`_sessions`, `_folders`, `_sessionStates`) subscribe the shell to the whole sessions store for no rendered output — every session-state change re-renders the sidebar chrome.
- Reference-class gaps: no drag-reorder, no date grouping, no per-session context menu on the group headers beyond collapse/new/rename/delete; otherwise search/pin/folders/rename/delete/account footer all exist.

## 4. Right drawer — `RightDrawer.tsx` + `RightDrawerState.ts` + sections

- 13 section ids (`RightDrawerState.ts:7-20`); sections render as a Zed-style tab strip with single active view (`RightDrawer.tsx:255-315`); "+" opens the full-body chooser card grid (`:428-480`). Terminal is a separate **bottom dock** (`BottomTerminalDock.tsx`), not a drawer tab.
- Width: default 420, min 200, max 60vw (`RightDrawer.tsx:54-60`), persisted (`:106-109`), re-clamped on window resize (`:150-157`), keyboard resizable (`:159-161,220-234`).
- `MAX_SECTIONS = 4` (`RightDrawerState.ts:36`); adding a 5th **silently drops the oldest** (`:273`, `:118`, `:226`) — no toast, no overflow affordance. `SECTION_ORDER` fallback list (`:37-48`) omits `routines`/`jobs`/`file` while `SECTION_ADD_ORDER` in the chooser includes them (`RightDrawer.tsx:343-356`) — inconsistent.
- Escape closes the drawer (`RightDrawer.tsx:124-134`) unless typing in an input/textarea or the chooser is up; chooser Escape backs out (`:112-119`).
- Header height duplicated again: `h-10` at `:245` vs `.august-right-drawer-header { height: 3.35rem !important }` (`chat.css:489-494`) — effective 53.6 px.
- Auto-open/close hooks in `ChatLayout.tsx`: subagents auto-open once per run (`:282-296`), Tasks auto-open/close on todos (`:299-311`), Plan on plan presence (`:314-326`), workbench session polled at 2 s open / 15 s closed (`:236-256`).

### Deep dive: `RightDrawerSubagentsSection.tsx`

- Tab strip `:486-534`: status glyph + task-title label + elapsed + "Remove view" ×; horizontal scroll container (`:492`), tabs capped `max-w-[12rem]` (`:501`); `TabSearchDropdown` (`:230-308`) filters by label with per-tab elapsed.
- Per-agent view `:536-656`: "Working for 31m 19s" header (`:550-571`), `ProgressPopover` todos chip (`:167-226`), live `SubagentTimeline` or persisted-transcript replay (`:579-624`), steer form (`:626-652`).
- Elapsed: one shared 1 s ticker at component top (`:365-371`, gated on `anyRunning`) — while any worker runs, the **whole section re-renders every second**, including the full selected timeline; per-tab elapsed only when the backend supplies `agent.elapsed` (`:483,514-518`).
- Steer/stop: steer only for the selected active worker; per-row stop in the roster list (`:687-699`) with `useSubagentActions` mutations (`hooks/useSubagentActions.ts:18-49`, toasts + invalidations); **Stop all** appears only when `activeAgents.length > 1` (`:705-725`) behind a styled confirm (`:709-716`).
- Polling: roster 2 s while any agent active else 10 s (`:348-356`, shares the `['session-agents']` key with ChatLayout so React Query dedupes); runs 10 s always (`:335-346`).

**At 5–10 simultaneous subagents:**
- Tab overflow is the real degradation: a single horizontal scroll strip with no wrap and no overflow cue; the search dropdown is the only findability aid. Because entries also merge **all persisted runs** for the session (`:382-395`, runs query returns full history), the strip accumulates every delegation of the session and never prunes.
- The per-tab × "Remove view" button (`:519-527`) is a **no-op**: it only sets `selectedTaskId` to null if that tab is already selected, and `entries` derive from server queries + the stream store, so nothing is ever removed. With 10 workers there is no way to clear a tab.
- A worker that finished/failed while unseen has **no unread/attention affordance** on its tab — only the glyph changes. The only proactive signals are the once-per-run drawer auto-open (`ChatLayout.tsx:282-296`, suppressed if the user closed the drawer until the next run), the titlebar `workersBadge` = needs + working (`ChatLayout.tsx:277-279`), and the sidebar amber dot. A failure can sit unnoticed indefinitely.
- Memory/compute: roster polling is shared (deduped), the 1 s ticker is one interval, transcript blocks live in `session-stream-store` keyed per job; cost is the per-second re-render plus an ever-growing block map, not fan-out. Acceptable at 10, but the per-second full-section re-render scales with the selected timeline's block count.
- Empty-state auto-dismiss: section closes itself 15 s after everything drains (`:459-472`).

## 5. Responsiveness

- Minimum window: `minWidth 960 / minHeight 600` (`src-tauri/tauri.conf.json:16-17`). Therefore the single width breakpoint, `@media (max-width: 900px)` (`src/styles/chat.css:504-518` — the only max-width media query in `src/`), **can never fire in the packaged desktop app**; it only matters for dev-server browser use. Below 960 px the Tauri WM clamps, so the shell's real minimum is 960×600: sidebar (≤33vw) + chat + optional 60vw drawer overlap rather than reflow (the drawer is an overlay, `RightDrawer.tsx:194-206`), plus the bottom dock up to 70vh (`BottomTerminalDock.tsx:90`).
- JS width clamps: `clampWidth` in `SessionSidebar.tsx:29-32` and `RightDrawer.tsx:70-73`; dock height clamp `BottomTerminalDock.tsx:90`; titlebar title `max-w-[min(48vw,32rem)]` (`ChatTitlebar.tsx:159`); subagent tab `max-w-[12rem]`.
- Touch resize is wired for both sidebars (`SessionSidebar.tsx:87,127-129`; `RightDrawer.tsx:186,239-241`) but **not** the bottom dock (`BottomTerminalDock.tsx:82-92`, mouse-only).

## 6. Shell keyboard shortcuts (inventory)

- Global (`src/App.tsx:51-80`): Ctrl/⌘+K or P → command palette; Ctrl/⌘+N → new chat (skips typing targets); `?` → shortcuts modal; `,` → Settings. Nothing handles Escape globally; no shortcut toggles the sidebar or drawer.
- Command palette (`components/overlays/CommandPalette.tsx:64-72`): Escape closes; cmdk arrows; focus trap.
- Drawer (`RightDrawer.tsx`): Escape closes (`:124-134`); handle arrows/Home/End resize (`:220-234`); tablist arrows/Home/End with roving focus (`:263-284`); tabs Enter/Space (`:370-375`).
- Modals with Escape: ConfirmDialog (`:36`), QuitConfirmModal (`:61`), ShortcutsModal (`:62`), ConversationSearchModal (`:87`), BotsRail per-bot menu (`BotsRail.tsx:141-160`, with arrow roving).
- Session search Escape clears (`SessionList.tsx:527`).
- Focus management: `useFocusTrap` on palette/shortcuts/onboarding/quit modals; drawer handle and tabs are focusable; **no focus roving between the three panes** (sidebar ↔ chat ↔ drawer) and no "focus composer" hotkey (`dispatchFocusComposer` exists only as an LLM ui-action, `ChatLayout.tsx:220-222`).
- ShortcutsModal (`components/overlays/ShortcutsModal.tsx:13-45`) documents Global/Composer/Approvals/Git-panel keys but omits Ctrl+N — the only shell shortcut it fails to list.

## 7. Overlay / z-order map (top → bottom)

| z | Overlay |
|---|---|
| 200 | `BackendBootstrapGate` veil (`BackendBootstrapGate.tsx:188`); `UpdateRelaunchOverlay` (`:69`) |
| 150 | `UpdateConversation` what's-new animation (`UpdateConversation.tsx:92`) |
| 70 | `ConfirmDialog`, `QuitConfirmModal` (Backdrop `z-[70]`, `ConfirmDialog.tsx:56`, `QuitConfirmModal.tsx:88`) |
| 60 | BotsRail profile/rooms Backdrops (`BotsRail.tsx:672,735`); ExamBanner explanation modal (`sections/exam/ExamBanner.tsx:171-173`) |
| 50 | `Backdrop` default (`Backdrop.tsx:29`) — CommandPalette, ShortcutsModal, ProviderOnboardingModal, BotCreateModal, SwitchAccountModal; `OnboardingTour` (`:103`); `ConversationSearchModal` (`:70`); ModelVisibilityModal (`:100`); BotsRail menu popovers (scrim z-40, menu z-50, `BotsRail.tsx:195-196,516-521`) |
| 30 | Right drawer panel (`RightDrawer.tsx:206`); drawer-internal tab search (`:266`) |
| 20 | Drawer/sidebar/dock resize handles; ProgressPopover (`RightDrawerSubagentsSection.tsx:198`) |
| flow | BottomTerminalDock is an in-flow flex child of the main column (`ChatLayout.tsx:650-652`), not an overlay; toasts (sonner) are outside this map |

## 8. Claim verification (docs/plans/AUGUST-UI-ENHANCEMENTS.md vs code)

| Claim | Verdict | Current evidence |
|---|---|---|
| isMaximized never re-syncs on external maximize (ChatTitlebar.tsx:83-92) | ✓ | `ChatTitlebar.tsx:83-92` mount-only effect; re-sync only at `:108` after own toggle |
| Titlebar height twice: tsx:123 `h-10` vs chat.css:385-391 `2.85rem !important` | ✓ | `ChatTitlebar.tsx:123`; `chat.css:385-390` (block ends 390, not 391) |
| Window buttons 38/38/42px (283,290,297) | ✓ | `ChatTitlebar.tsx:283,290,297` exactly |
| Sidebar resize mouse-only (SessionSidebar.tsx:122, no role/value/key) | ✗ mostly | `SessionSidebar.tsx:119-131`: `role="separator"` exists (`:120`) and **touch** resize works; correct part: no `aria-valuenow/min/max`, no `tabIndex`, no `onKeyDown` — keyboard-dead |
| Drawer handle keyboard-operable (RightDrawer.tsx:215-233 role=separator) | ✓ (shifted) | `RightDrawer.tsx:211-243`: role `:212`, `aria-valuemin` `:215`, `tabIndex` `:219`, keys `:220-234` |
| Widths 280/220/33vw; 420/200/60vw; dock 120/70vh; duplicated TS+Tailwind+chat.css:273-278,470,485,489 | ◐ | TS values all ✓ (`SessionSidebar.tsx:17-19`, `RightDrawer.tsx:54,57,60`, `BottomTerminalDock.tsx:37,90`). The chat.css duplication claim is stale: no width literals in CSS; `chat.css:273-276` is `will-change`, `:470-487,:489-494` are border/height rules. The *pattern* survives as height duplication: drawer header `h-10` (`RightDrawer.tsx:245`) vs `3.35rem !important` (`chat.css:490`) |
| Collapse animates width (SessionSidebar.tsx:98-100; RightDrawer.tsx:199-201) | ✓ | exact lines both files |
| Only one `@media (max-width: 900px)` | ✓ | `chat.css:504`; all other media queries are `prefers-reduced-motion` |
| Needs-attention poll every 15s (ChatLayout.tsx:120-136) | ✓ | `ChatLayout.tsx:120-136`, `15_000` at `:131` |
| Five overlays without Escape: BotsRail:196,517; ExamBanner:173; Backdrop:34 | ◐ | BotsRail `:516-521` "+" menu scrim — ✓ no Escape; BotsRail `:196` scrim — ✗ that menu **has** Escape (`:141`); ExamBanner explanation modal ✓ no Escape (now `:171-198`); Backdrop ✓ click-only (`Backdrop.tsx:32-34`) — but its major consumers add their own Escape |
| `decorations: false` (tauri.conf.json:22) | ✓ (shifted) | `src-tauri/tauri.conf.json:26`; also `minWidth 960` `:16` |
| Close routes through webview modal (lib.rs:112-117) | ✓ | `lib.rs:109-117` (`prevent_close` `:113`, emit `quit-requested` `:116`) |
| MAX_SECTIONS = 4 (RightDrawerState.ts:36) | ✓ | `RightDrawerState.ts:36` exactly |

## Consolidated findings

### (1) Inconsistencies
- `components/shell/ChatTitlebar.tsx:123` vs `src/styles/chat.css:385-390` — titlebar height defined twice (40 vs 45.6 px); window buttons (`:283,290,297`) stay 40 px in a 45.6 px bar.
- `components/sidebar/SessionListNav.tsx:70-72` — brand bar `h-10` "aligned with main ChatTitlebar" but renders 5.6 px shorter than the CSS-overridden titlebar.
- `components/shell/RightDrawer.tsx:245` vs `src/styles/chat.css:489-494` — drawer header height duplicated (`h-10` vs `3.35rem !important`).
- `components/shell/RightDrawerState.ts:37-48` vs `RightDrawer.tsx:343-356` — `SECTION_ORDER` omits `routines`/`jobs`/`file` while the chooser offers them; fallback target after cap-drop can differ from what the chooser shows.
- `src/components/shell/ChatTitlebar.tsx:183`, `src/components/sidebar/SessionList.tsx:368,375` — `window.prompt` for rename/folder-create amid styled dialogs; silent no-op risk on WKWebView-based Tauri builds.
- `src/components/shell/SessionSidebar.tsx:29-32` vs `RightDrawer.tsx:150-157` — drawer re-clamps width on window resize; sidebar does not.
- `src/App.tsx:105-106` + `components/overlays/OnboardingTour.tsx:77-84` + `hooks/useProviderOnboardingState.ts:119` — two first-run overlays with no mutual gate; both can stack at z-50.
- `components/overlays/ShortcutsModal.tsx:17-24` — omits Ctrl/⌘+N, the one shell-level shortcut App.tsx implements.
- `src/components/shell/ChatTitlebar.tsx:283,290,297` — window buttons hardcode `hover:bg-white/10` (close uses `hover:bg-red-500`), off-token vs the rest of the bar's `hover:bg-accent`.

### (2) Dead UI / hardcoded or fake status
- `components/shell/RightDrawerSubagentsSection.tsx:519-527` — per-tab "Remove view" × never removes anything (entries derive from queries/store; button only deselects when already selected); tab strip is un-prunable for the session.
- `src/styles/chat.css:261-267` (`august-app-chrome`), `:291-293` (`august-brand-mark`), `:496-502` (`august-drawer-card`, only referenced by a test asserting absence) — dead CSS classes with no TSX usage.
- `src/components/sidebar/SessionList.tsx:761` — hardcoded `· Free` plan suffix regardless of any account state.
- `src/components/shell/SessionSidebar.tsx:42-44` — `_sessions/_folders/_sessionStates` store subscriptions with no rendered output (dead re-render source).
- `src/components/shell/ChatTitlebar.tsx:31,273-277` — `RightDrawerDropdown` keeps a `workersBadge` prop but ignores `onSelect` (`RightDrawerLauncher.tsx:15,20` `void onSelect`); the "dropdown" is now only a chooser toggle.
- `src/styles/chat.css:504-518` — the 900 px breakpoint is unreachable in the packaged app (`minWidth 960`, `tauri.conf.json:16`); it styles a state the product cannot enter.

### (3) Accessibility gaps
- `src/components/shell/SessionSidebar.tsx:119-131` — resize separator: no `tabIndex`, no `onKeyDown`, no `aria-valuenow/min/max`; keyboard users cannot resize (drawer counterpart `RightDrawer.tsx:211-243` shows the intended pattern).
- `src/components/shell/BottomTerminalDock.tsx:320-332` — dock resize handle: `role="separator"` + label only; no keyboard, no touch (mouse-only drag).
- `src/components/overlays/Backdrop.tsx:26-38` — scrim has click-dismiss but no Escape handling, no `role="dialog"`/`aria-modal`, no focus trap of its own; correctness depends on each consumer.
- `src/sections/exam/ExamBanner.tsx:171-198` — explanation modal: no Escape, no `role="dialog"`/`aria-modal`, no focus trap.
- `src/components/sidebar/BotsRail.tsx:505-521` — "+" "New" menu: click-outside only, no Escape, no arrow-key roving (unlike the per-bot menu at `:134-167`).
- `src/components/overlays/OnboardingTour.tsx:101-109` — tour is `role="dialog" aria-modal` with focus trap but no Escape and no backdrop-click dismiss; X only.
- `src/components/overlays/ModelVisibilityModal.tsx:100-108` — custom fixed overlay without `role="dialog"`/`aria-modal`/Escape/focus trap.
- `src/components/shell/ChatTitlebar.tsx:83-92` — maximize button's icon/`aria-label` go stale after external maximize (no window-event resync).
- `src/components/shell/RightDrawerSubagentsSection.tsx:498-529` — subagent tab strip is plain divs with embedded buttons: no `role="tablist"/tab`, no arrow navigation, and the finished/failed state change is glyph-only (no text for screen readers beyond glyph color classes).
