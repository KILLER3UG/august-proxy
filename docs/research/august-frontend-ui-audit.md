# August Proxy — Frontend UI Audit (React/TS desktop surface)

**Date:** 2026-09-24 · **Scope:** `frontend/desktop/src/` (React 18 + Tauri 2 + Zustand + TanStack Query/ Virtual + framer-motion). ~97k LOC across 503 non-test source files.
**Method:** read-only static audit. No test suite, no dev server, no browser driving (per instruction). Every claim is anchored to `file:line` in the current tree. Prior audits were re-verified line by line, not assumed.

---

## 0. Verdict on prior audits

### 0.1 `docs/UI-SCAN-2026-09-16.md`

| ID | Finding | Status | Evidence |
|----|---------|--------|----------|
| B1 | Bots-rail rows collapse to height 0 and overlap Projects/Tasks | **FIXED** | `lib/motion.ts:38-45` — `sessionRow` no longer animates `height` on `initial`/`animate`; collapse is exit-only. `BotsRail.tsx:292` consumes the fixed variant. |
| B2 | Titlebar never leaves chat context | **FIXED** | `components/shell/ChatTitlebar.tsx:61-79` — route-aware `barTitle` with settings-section lookup and a route-label table. |
| B3 | Opening a session renders the empty state; messages appear only after reload | **LIKELY FIXED (unverified at runtime)** | The mechanism named in the scan was rewritten: `stream/session-history.ts:178-204` is now a single-flight `ensureSessionHistory` with a history-identity guard, bounded retry (`[1s,3s,8s]`), and `reconcileHistory` merge. `ChatThread.tsx:813-818` lands at bottom on `loadedSessionId === sessionId`. Residual risk noted as F-09. |
| B4 | Workbench drawer overlays the chat column | **STILL-PRESENT (by design)** | `RightDrawer.tsx:190-207` — the comment calls the absolute overlay a "Part 15.4 hard rule". Mitigated by the 60 % viewport cap (`RightDrawer.tsx:60`) and the centered `max-w-3xl` thread. Re-opens below ~1100 px. See F-01. |
| B5 | Settings rail bottom item clipped | **FIXED** | `WorkspaceShell.tsx:257` — the rail is `min-h-0 flex-1 overflow-y-auto` with a `shrink-0` profile footer; "Review Inbox" is no longer pinned under a clipped edge. |
| B6 | History plural bug (`1 msgs`) | **FIXED** | `sections/history/HistoryPage.tsx:131` — `${s.messageCount === 1 ? 'msg' : 'msgs'}`. |
| B7 | Indexing settings is an unmigrated placeholder | **FIXED** | No `SettingsStub` component and no "hasn't been migrated" string anywhere in `sections/settings/`. `sections/settings/CapabilitySections.tsx:2` records that the stub path was deleted. |
| B8 | ErrorBoundary crash screen is raw | **FIXED** | `components/ErrorBoundary.tsx:42-89` — styled `CrashCard` with icon, headline, reassurance, collapsible stack, Reload + Copy error, persisted to `localStorage` on catch. |
| §3.1 | Brand color / primaries are near-monochrome | **STILL-PRESENT** | `styles.css:250-252` defines sanctioned `--dt-primary` tiers and they are used (Send, Dispatch, the focus rings), but the secondary surfaces remain neutral. No new status-color language on Runs/Board. |
| §3.2 | Contrast tiers systematically too low | **PARTIALLY ADDRESSED** | A three-tier system now exists and is documented with contrast targets (`styles.css:17-19, 248-252`). Adoption is roughly half-done: 71 `text-tier-*` usages vs **69** raw low-opacity foreground utilities, of which 33 are `muted-foreground/40` and 10 `sidebar-foreground/40` — the exact classes the scan flagged. |
| §3.3 | Composer polish (`+` orphaned, model pill weight, cryptic ring) | **MOSTLY FIXED** | The `+` merged into the toolbar row (`ComposerToolbar.tsx:248-290`). Ring is now 20 px with a full hover popover and live cache stats. Still no search in the model picker (F-24) and no numerals on the ring. |
| §3.4 | Empty/loading state discipline | **PARTIALLY FIXED** | Chat hero is now vertically centered with starters (`ChatEmptyState.tsx:73`) — the "top-anchored 50 % void" is gone. Usage panels now distinguish error from zero (`WorkspaceUsageSection.tsx:68-71`). |
| §3.5 | Sidebar IA (duplicate "Assistant", two searches, always-visible delete-all) | **NOT VERIFIED / PARTIALLY** | `BotsRail.tsx:528`-area was reworked; the duplicate-label and double-search issues were not re-checked line by line in this pass. |
| §3.6 | Command palette (ALL-CAPS, no per-row shortcuts, dead-center) | **PARTIALLY FIXED** | Palette has a roving-focus keyboard path and grouped items; the `ALL-CAPS` group labels and per-row shortcut hints were not verified changed. |
| §3.7 | Live voice page is a placeholder | **NOT RE-VERIFIED** | Out of the depth budget for this pass. |
| §3.8 | Update lifecycle | **MOSTLY FIXED** | Bootstrap gate (`BackendBootstrapGate.tsx:180-226`) has a real error state with common fixes + Retry; `UpdateConversation` + `UpdateRelaunchOverlay` are mounted outside the gate so a stopped backend cannot hide them (`App.tsx:110-116`). The web-mode "Version web" dead end is in the hidden About section. |
| §3.9 | Light theme: Apply/Discard enabled while "In sync" | **FIXED** | `sections/settings/UiDesignerSection.tsx:102, 125, 130` — all three gates are `disabled={!dirty}` / `disabled={!hasApplied && !dirty}`. |
| §3.10 | API key masking as `••••last4` | **PARTIALLY ADDRESSED** | Fields are `type="password"` (`ProviderDetailForm.tsx:231`), so the length leak is gone; the `••••last4` affordance and a "remove key" action are not implemented. |

### 0.2 `docs/CHAT_UI_DEEP_DIVE_2026-08-23.md`

Accurate as a description of the chat surface. Every claimed component still exists: `ChatThreadMessagePane` + `VirtualizedMessageList` (windowed, id-keyed, `VirtualizedMessageList.tsx:33-43`), incremental markdown with a live-parse fast path (`ChatMarkdown.tsx:24-27, 52-56`), `ThinkingDisclosure` → `ThoughtStep`, `InThreadSearch` ⌘F, `ContextRing` with MCP/cache rows, `SubagentExpandedCard` roster in the drawer, `SelfImprovementStrip` (memory-notice chip), interactive Tasks with optimistic toggle, diff section + `CommitComposer`, memory graph tabs.

Two claims have drifted:
- **"ChatMarkdown incremental block cache … 5.5× faster"** — the cache was replaced by a *streaming highlight skip* (`ChatMarkdown.tsx:52-56` sets `liveMarkdownParse` and defers highlight.js until the turn settles). Different mechanism, same goal.
- **"No `/verbose` / plan tree in the doc"** — both have since landed (`lib/verbose-mode.ts`, `AssistantBlockTimeline.tsx:171-223`).

### 0.3 `docs/SETTINGS_UX_REDESIGN.md`

Mostly a historical roadmap, several lines now **STALE**:
- "5-group rail implemented … `Usage & Limits` section added; Agent Board hidden from the rail" — the rail is now **3 header groups** (`settings-registry.ts:110-126`) and the Usage section is labelled **"Usage stats"**, not "Usage & Limits".
- "Reliability dashboard — new Diagnostics section (`/settings/reliability`)" — **the section no longer exists**; `/settings/reliability` is a `legacyAlias` of `harness-improve` (Review Inbox), which is a *human-decision inbox*, not a reliability dashboard.
- "5 groups: Essentials / AI / Capabilities / Permissions / Diagnostics & Developer" — never shipped in that shape.
- "New shared `useFocusTrap` applied to CommandPalette, Shortcuts, Conversation Search, Onboarding, Quit-Confirm" — accurate, but coverage is 6 of 23 dialogs. See **F-12**.

### 0.4 `docs/settings-audit.md`

Materially **STALE**:
- "38 sections across 3 header groups" — the registry now has **47**.
- Header ids are `settings` / `capabilities` / `data` — the code uses **`basics`** / `capabilities` / `data` (`settings-registry.ts:110-126`).
- "`ui-designer` additionally renders as a visible tree grandchild under Appearance via `RAIL_CHILDREN`" — **`RAIL_CHILDREN` has no importer.** It is a dead export (`settings-registry.ts:697-699`; only comment references elsewhere). See **F-17**.
- "`tier` is retained for `hidden` interior views" — true in letter, but 28 of 47 sections are `hidden`, including first-class surfaces (System Status, Account, Data & Privacy, Activity Log, External API Access, Files & Shell Access). See **F-16**.
- "`Show advanced` toggle removed" — accurate; the hook `hooks/useSettingsAdvancedPreference.ts` is now orphaned (test-only). See **F-18**.

---

## 1. App shell & layout

### What works
- **Titlebar** (`ChatTitlebar.tsx:61-79`) is genuinely route-aware; the session dropdown only mounts on a chat route (`:161`), and the Tauri window controls carry `aria-label`s (`:284, 291, 298`).
- **ChatLayout** is disciplined about lifecycle: 60 s session reconcile with cleanup (`:104-110`), a 15 s needs-handoff poll with a `cancelled` flag (`:120-136`), a `handleNewSessionRef` to keep the `/new` listener stable across polls (`:493-515`), and a redirect-away effect for realtime-deleted sessions (`:139-147`).
- **Dirty/streaming confirm on New chat** is real: streaming *and* unsent-draft both gate it, with distinct copy (`:387-411`).
- **Right drawer** has a proper ARIA tablist with roving tabindex and arrow/Home/End navigation (`:263-284, 358-376`), a keyboard-resizable separator with `aria-valuenow/min/max/text` (`:211-234`), a 60 % viewport cap (`:60`) and a re-clamp on window resize (`:150-157`).
- **Layout is a real `SectionBoundary` per top-level route** (`routes.ts:49-55`) so a crashed Runs/Board/History cannot take down the shell.
- **Bots-rail collapse bug** is genuinely fixed at the motion primitive, not papered over at one call site.

### Defects

**F-01 · Right drawer covers the transcript at narrow widths** — P2 · S · Low risk
`components/shell/RightDrawer.tsx:190-207`. The drawer is `absolute right-0` inside `.august-content-area` and does not reflow the chat column. The 60 % cap (`RightDrawer.tsx:60`) protects the left 40 %, but the message column is `max-w-3xl` centered (`VirtualizedMessageList.tsx:54`), so below roughly 1100 px of content width the drawer's left edge crosses the centered text and long lines run under it. Suggest a `padding-right` on `.august-message-list` equal to the drawer width while open.

**F-02 · ⌘/Ctrl+N bypasses every New-chat guard** — P1 · S · Low risk
`App.tsx:59-67` calls `createSession(null)` and navigates directly. The sidebar "+" path (`ChatLayout.tsx:387-411`) confirms when a run is streaming *or* a draft is unsent. The global hotkey skips both, so a keystroke silently leaves a running turn's transcript and discards the composer's draft. Route the hotkey through the same `confirm` flow (lift `handleNewSession` to a module-level registry or dispatch `august:new-session`, which `ChatLayout.tsx:513` already listens for).

**F-03 · Chat error copy is empty after a reload for block-only turns** — P2 · S · Low risk
`MessageBubble.tsx:230` (`handleCopy`) and `:287` (`handleSpeak`) both read `message.content` only. On a live turn that field is kept in sync (`makeStreamHandlers.ts:222, 289`), but `mapRemoteMessages` (`stream/session-history.ts:117-137`) only falls back to `contentFromBlocks(blocks)` when `looksLikeJsonPayload(text)` is true — i.e. never for `content: ''`. A row persisted with structured blocks and empty `content` hydrates with an empty string: **Copy copies nothing and TTS speaks nothing, with no error.** Use `content || contentFromBlocks(message.blocks)`.

**F-04 · "Share" is a dead control on every non-chat route** — P2 · S · Low risk
`ChatTitlebar.tsx:258-271`. The button renders unconditionally; its `onClick` is guarded by `if (session)`. On `/runs`, `/board`, `/settings/*` the session is null, so the button is focusable, hoverable, and does nothing. Hide it (and the session dropdown trigger) when `!session`.

**F-05 · Rename chat uses a blocking `window.prompt`** — P2 · M · Low risk
`ChatTitlebar.tsx:183`. A native blocking prompt inside a Tauri webview looks and behaves like a different application. There is already a `ConfirmDialog` + `useConfirmDialog` pattern in the codebase.

**F-06 · Windows-style window controls render on macOS and Linux** — P2 · S · Low risk
`ChatTitlebar.tsx:280-302`. The close button is hard-coded `hover:bg-red-500` and all three use fixed pixel widths. Branch on `platform()` from `@tauri-apps/api/os`, or use the Tauri native decorations.

**F-07 · No responsive behaviour below the desktop breakpoint** — P2 · L · Medium risk
`WorkspaceShell.tsx:130` pins the settings rail at `w-64 shrink-0`; the right drawer clamps by viewport fraction; there is no `useMediaQuery` anywhere in `src/`. At the app's minimum window size the settings rail plus a 200 px drawer leaves a very narrow content column with `overflow-x-hidden` (`:263`) silently clipping wide tables. Consider collapsing the settings rail to icons below ~900 px.

**F-08 · Global hotkeys fire over open dialogs** — P2 · S · Low risk
`App.tsx:51-80`. `isTypingTarget` (`:22-30`) correctly skips text fields, but a focused *button* inside a modal is not a typing target, so `?` and `,` toggle the Shortcuts modal / navigate to Settings while e.g. the model-edit modal is open.

---

## 2. Chat area

### What works
This is the strongest surface in the app and shows deliberate design.
- **Error visibility is first-class.** `AssistantBlockTimeline.tsx:1162-1235` renders provider/turn failures as a standalone `role="alert"` bubble with friendly copy, a `<details>` raw-upstream block, **Try again**, **Switch model**, and a corner ✕ — never buried in the collapsed activity pack. `splitProcessAndFinal` (`:131-166`) pulls `error` and `system` blocks *out* of the process pack for exactly this reason.
- **Minimal-output transcript** is implemented end to end: `update_state` bookkeeping rows suppressed (`:701-708`), mixed read runs collapsed into `ExploreGroup` (`:719-786`), same-file repeats into `read x.ts ×4` (`:853-896`), edits/memory writes as rail rows (`:823-841`), recall as one chip (`:965-1014`), plan tree with auto-collapsing finished subtrees and an open active group (`:1063-1115`).
- **Sticky composer footer** — `ChatThreadMessagePane.tsx:277-286` reserves the working strip's height and `h-0 overflow-hidden` when idle, so the transcript never jumps.
- **Virtualization is id-keyed**, which is the correct fix for the measured-height-across-sessions bug (`VirtualizedMessageList.tsx:36-42`).
- **Markdown is hardened**: raw HTML escaped (`ChatMarkdown.tsx:29-33`), `javascript:` hrefs rejected via `safeExternalHref` (`:44-51`), code blocks escaped before `dangerouslySetInnerHTML` (`:57-81`).
- **Focus/keyboard**: `InThreadSearch` is virtualizer-aware (jumps through `virtRef`, not `querySelector`) — `ChatThreadMessagePane.tsx:126-140`.
- **Scroll anchoring** is among the best-in-class: unpin-on-upward, no re-pin mid-stream, a "New content" pill, and a `chat-scroll-anchor` sentinel. `useStickToBottomScroll` documents exactly why each guard exists.

### Defects

**F-09 · The chat has no live region** — P2 · M · Low risk
`ChatThreadMessagePane.tsx:158-242`. The scroll container is a `div` soup; there is no `role="log"`, no `aria-live`, no `aria-busy` while streaming. A screen-reader user gets *only* the `WorkingIndicator`'s `role="status"` (`WorkingIndicator.tsx:119-124`) and then silence when the answer lands. Add `role="log" aria-live="polite" aria-relevant="additions text"` to the scroller and `aria-busy` while streaming.

**F-10 · `×N` consolidated reads expand to only the first read** — P2 · M · Low risk
`AssistantBlockTimeline.tsx:872-895` builds the label `read foo.py ×4` but renders `<ToolCallItemBody tool={tool} />` where `tool` is the **first** element of the run. Expanding shows one file's output under a label claiming four. Either list the other three inside the body or drop the ×N label and keep four rows.

**F-11 · Non-expandable tool rows still draw a chevron affordance** — P2 · S · Low risk
`ToolStepRow.tsx:377-387`. When `canExpand` is false (the `minimalLocked` path for settled reads and plain tools) the row renders a `ChevronRight` glyph on a `disabled` button. It reads as clickable and never is. Render a dot or nothing in the non-expandable case.

**F-12 · 17 of 23 dialogs have no focus trap or focus restoration** — P2 · M · Medium risk
`useFocusTrap` (`hooks/useFocusTrap.ts`) is imported by exactly six components (`CommandPalette`, `ShortcutsModal`, `ConversationSearchModal`, `OnboardingTour`, `QuitConfirmModal`, `ProviderOnboardingModal`). `role="dialog"` appears in 23 files. Untrapped: `components/overlays/ConfirmDialog.tsx`, `NotificationsPanel`, `SwitchAccountModal`, `WhatsNewModal`, `components/sidebar/BotCreateModal.tsx`, `BotsRail`, `RoomView`, `components/chat/ClarifyTool.tsx`, `components/chat/git/ChangesPill.tsx` (CommitModal), `sections/chat/arena/ArenaView.tsx`, `composer/ArenaLaunchModal`, `debate/DebateLaunchModal`, `sections/settings/ImportMemoryDialog.tsx`, `integrations/IntegrationDirectoryModal`, `SkillsSection`, `sections/workspace/models/AddModelForm.tsx`, `ModelRow.tsx`, `RightDrawerFileSection`. `ConfirmDialog` is the worst case — it is the app's *destructive-action* gate everywhere.

**F-13 · `liveSessionKey` falls back to the message id** — P2 · S · Low risk
`AssistantBlockTimeline.tsx:294-295`: `resolveUiSessionId(routeSessionId || message.id)`. On the `/` route there is no `:sessionId` param, so the live-activity store is keyed by a *message* id while `WorkingIndicator` (`:70`) subscribes by ui session id. Publishes land in an unread key and `clearLiveActivity` never cleans them — a slow per-message leak in the zustand store. Prefer a guaranteed session id prop over a route-param fallback.

**F-14 · `virtRef.current` is mutated during render** — P2 · S · Low risk
`VirtualizedMessageList.tsx:45-50`. Assigning a ref inside the render body is an impure render; under `React.StrictMode` (enabled in `main.tsx:49`) the double-invoked render writes twice and the value is not owned by a committed render. Move to a `useLayoutEffect` or use the instance directly at the call site.

**F-15 · 500 ms timer per running tool row** — P2 · M · Low risk
`ToolStepRow.tsx:178-183` and `components/chat/tool/ToolCallItem.tsx:63` each run a 500 ms `setInterval` while a tool is running. A turn with several concurrent tool rows multiplies re-renders of the whole memo subtree. One shared ticker in the stream store would collapse N timers to 1.

---

## 3. Composer

### What works
- **Send gating is layered and correct** (`ComposerToolbar.tsx:160-165`): needs a session, a *loaded* session (`loadedSessionId === sessionId`, so a mid-hydration Enter is refused), a selected model, no in-flight attachment reads, and non-empty content. `useChatSend` re-checks the model guard **before** mutating state (`:428-440`) so a model-less send leaves no ghost bubble — a bug the comment at `:428-430` records as already fixed.
- **Double-Enter latch** (`useChatSend.ts:171-174, 410-411`) with a documented release protocol on every exit path, including a `catch` guard at `:698-703` specifically so a pre-registration throw cannot wedge it.
- **Offline compose** distinguishes cold-start (`connecting` → wait up to 10 s for the poller) from genuinely-down (2 s health probe) before parking a message (`:563-607`).
- **Slash dispatch** is registry-driven, mutates no state directly, and latches correctly on both sync throw and async rejection (`:470-507`).
- **Attachment upload ordering** is right: `ensureWorkbenchSession()` runs *before* `uploadImages` on the first message, because otherwise the upload 409s (`:225-242`).
- **Agent mode selector** is three orthogonal axes in one popover — harness mode `chat|agent|code|orchestrator` (a side flyout), guard mode `ask|edit|plan|full`, and sandbox reach (`WorkbenchModeSelector.tsx:103-118, 300-385, 455-485`). All `role="menuitemradio"` with `aria-checked`.
- **Draft persistence** is per-session and correctly scoped (`message-storage.ts:8, 48, 58, 68`; `ChatThread.tsx:854-856`).
- **Stop vs. Steer** are distinct affordances (`ComposerToolbar.tsx:324-346`) and stop preserves the backend queue (`:220-225` in `start-stop-stream.ts`).
- **Drag/drop** has both paths: Tauri real paths (`:210-226`) and browser `File` objects (`:1521-1548`), with a non-dismissing overlay and an explicit guard against double-attach under Tauri.

### Defects

**F-16 · Model picker has no search, by explicit decision** — P2 · M · Low risk
`sections/chat/composer/ModelEffortMenu.tsx:8` states it in the file header: "No search, no filters — the calm three-part layout." With a single-provider gateway this is fine; with OpenCode Zen or any 80-model multi-provider catalog the provider → model cascade is a scroll hunt with no way to jump. The `?` filters the Settings registry but nothing filters the model list. A 28 px search field above the provider column would cost ~30 lines.

**F-17 · The agent mode is invisible on the chip in the default mode** — P2 · S · Low risk
`WorkbenchModeSelector.tsx:522-524`: the label is `'Orchestrator'` for orchestrator, `harnessMeta.label` for `chat`/`code`, and **`guard.label` for `agent`** — the default. So a user in agent mode sees "Full access" or "Plan mode" and the word *Agent* never appears. The `title`/`aria-label` (`:511-512`) do carry both, so it is an aria-correct but visually ambiguous chip. Render the harness label as a second segment when it is not the default.

**F-18 · Draft persistence writes localStorage on every keystroke** — P2 · S · Low risk
`ChatThread.tsx:854-856` calls `persistComposerDraft` in an effect keyed on `input`. Synchronous `localStorage.setItem` per character. Debounce to ~250 ms and flush on unmount/send.

**F-19 · Tauri drag-drop listener can leak across a session switch** — P2 · S · Low risk
`ChatThread.tsx:210-226`. The effect does `void import('@tauri-apps/api/window').then(async () => { unlisten = await …onDragDropEvent(…) })`. If the component unmounts *before* the promise resolves, the cleanup runs with `unlisten === undefined`, the listener is never removed, and every later drop in the app calls `attachPaths` against a dead session. Capture a `cancelled` flag and call `unlisten()` inside the `.then` when set.

**F-20 · ⌘⇧Space and ⌘⇧P are bound globally with no typing guard** — P2 · S · Low risk
`ChatThreadComposer.tsx:270-285`. ⌘⇧Space focuses the composer from anywhere and ⌘⇧P toggles the markdown preview, both via `window` listeners with `preventDefault()`. ⌘⇧Space is a macOS input-source switch on several layouts; the handler will swallow it. Neither checks `isTypingTarget` the way `App.tsx:22` does.

**F-21 · Context ring still shows no numerals** — P2 · S · Low risk
`ComposerToolbar.tsx:480-503` renders `ContextRing size={20}`. The hover popover (usage bar, per-category breakdown, prompt-cache hit, Compact) is excellent, but the resting state is still an unlabeled donut. The prior scan's "show 9 % or a tooltip" is half done.

---

## 4. Settings

### What works
- **Registry is a genuine single source of truth.** `settings-registry.ts:718-781` enforces unique ids, unique icons, single-owner keywords, unique legacy aliases, valid tiers and known categories. Deep links resolve through `LEGACY_TAB_MAP` / `resolveLegacyTab` (`:665-679`) and `railCanonicalId` (`:702-704`).
- **`SettingsPage` lazy-loads every section** (`:245-332`) with a Suspense spinner, and the parent route is declared once (`App.tsx:92-95`) so tab switches do not remount the shell.
- **Tab-switch cache invalidation is scoped**: `:160-166` invalidates only 39 known settings-domain query keys instead of the whole app cache. (Fragile — see F-23.)
- **Model settings are complete and correct.** `ModelRow.tsx:397-492` exposes per-model `toolSurface`, `maxTools`, `maxToolResultChars`, `maxReasoningEffort`, `free`, `priceInPerM`, `priceOutPerM`, `apiFormat`, plus the family-hint readout at `:386-396`; all persisted at `:503-531`. The "0.0 is a price, not an absence" rule is honoured via `parsePriceInput` (`:94-97, 524-525`) and the hint at `:488-492` spells out the estimated-vs-fact distinction. Test-connection and tool-probe results are `role="status"` / `role="alert"` with a one-click "Apply {surface} surface" remediation (`:672-705`). The model Test path shares `_probe_connectivity` with the health simulator, as the redesign doc claims.
- **Appearance** gates Apply/Discard on `dirty` and embeds the UI Designer with a `/settings/ui-designer` scroll target.
- **"Back to workspace" returns to the exact chat** via `sessionStorage['pre-settings-path']` (`ChatLayout.tsx:579-582`, `WorkspaceShell.tsx:131-138`) — the redesign doc's fix, still intact.
- **Onboarding "Open a project folder" launches the real picker** via the `august:open-folder` event (`ProviderOnboardingModal.tsx:71-75` → `ChatLayout.tsx:160-174`), not `navigate('/')` as the doc's bug list described.
- **Review Inbox is now a first-class rail item** with a live count badge (`WorkspaceShell.tsx:179-181`, `registry:612-623`).

### Defects

**F-22 · A crash in any settings section destroys the whole window** — P1 · M · Low risk
`components/shell/ChatLayout.tsx:602-605` renders the settings `<Outlet/>` **outside** the `ErrorBoundary` that wraps the chat outlet (`:610, 644`), and `sections/settings/SettingsPage.tsx:189-193` wraps the section in `React.Suspense` only — no `SectionBoundary`. Every top-level *route* gets a `SectionBoundary` (`routes.ts:49-55`); settings does not. A render throw in any of ~38 lazy settings chunks therefore escalates all the way to the app-level `CrashCard` in `main.tsx:54`, taking the sidebar, titlebar and chat with it. Fix: wrap `<SectionComponent>` in `SectionBoundary` in `SettingsPage`, or move the settings branch inside the existing `ErrorBoundary`.

**F-23 · 28 of 47 settings sections are invisible in the rail** — P1 · M · Medium risk
`settings-registry.ts` marks `tier: 'hidden'` on: `system-health`, `account`, `privacy`, `ui-designer`, `hooks`, `model-catalog`, `model-fleet`, `model-reflection`, `model-live`, `model-aliases`, `model-fallback`, `model-quotas`, `memory-facts`, `recurring-tasks`, `agents-automation`, `agent-board`, `agent-sandbox`, `tool-grants`, `python-sandbox`, `computer-access`, `api-access`, `indexing`, `observability`, `conversations-history`, `conversation-inspector`, `feature-flow`, `backend-monitor`, `health-simulator`. `WorkspaceShell.tsx:198-201` filters on `s.tier !== 'hidden'`, so the rail shows ~16 of 47. **Data & Privacy, System Status, Account, Activity Log, External API Access, Files & Shell Access, Conversations and Indexing have no rail row at all** — they are reachable only through the search box or a deep link. This directly contradicts the redesign doc's intent and the `settings-audit.md` claim that the rail is the IA. Either un-hide the first-class surfaces or add a "More" disclosure group per header.

**F-24 · Hidden parents make some sections dead-ends with no active rail item** — P2 · S · Low risk
`settings-registry.ts:683-692` maps `tool-grants` and `python-sandbox` → `agent-sandbox` and `health-simulator` → `system-health`, but both parents are themselves `hidden`. `WorkspaceShell.tsx:68, 213` computes `railActive = railCanonicalId(active)` and highlights `active === s.id || railActive === s.id` — with no visible row matching, **no rail item is highlighted** and "Back to workspace" is the only way out.

**F-25 · `RAIL_CHILDREN` is dead code** — P2 · S · Low risk
`settings-registry.ts:697-699` exports `RAIL_CHILDREN = { appearance: ['ui-designer'] }` and nothing imports it. The doc's claim that UI Designer renders as a tree grandchild under Appearance is false; `/settings/ui-designer` maps to the `AppearanceWrapper` component (`SettingsPage.tsx:356`) and is reachable only by deep link or search.

**F-26 · `auditRegistry()` is not invoked at build time** — P2 · S · Low risk
`settings-registry.ts:714-717` says "Throw with a descriptive message if any invariant is broken — **the build will fail** rather than silently ship a buggy IA." It is only called from `src/test/settings-registry-audit.test.ts:29`. Add it to a Vite plugin hook or module top-level so the invariant is real.

**F-27 · `useSettingsAdvancedPreference` is orphaned** — P2 · S · Low risk
`hooks/useSettingsAdvancedPreference.ts` is imported only by its own test. Dead hook; delete or re-wire.

**F-28 · The settings invalidation allowlist is fragile** — P2 · M · Medium risk
`SettingsPage.tsx:57-97` enumerates 39 query-key prefixes. Any section that introduces a new key is silently excluded from the on-tab-switch refetch and shows a 5-minute-stale `staleTime` view. A section that needs freshness has no compile-time signal. Invert it: namespace every settings query under a common prefix (`['settings', ...]`) and invalidate by prefix.

**F-29 · Memory and Facts & Rules share one component** — P2 · S · Low risk
`SettingsPage.tsx:378-379` maps both `memory-knowledge` and `memory-facts` to `MemoryWrapper` (the 2309-line `MemorySection.tsx`). Deep-linking to one does not land on the other tab, and the rail cannot express that they are two views of one hub. `RAIL_PARENT` even carries a comment about this (`registry:293-294`).

**F-30 · Model-key masking is password-only** — P2 · S · Low risk
`sections/workspace/models/ProviderDetailForm.tsx:231`. A fixed-length `••••last4` chip plus a "remove key" action (both called for in the prior scan) are still absent.

---

## 5. Panels & surfaces

### What works
- **Git** is fully integrated in two places: an always-where-you-need-it `ChangesCard` per assistant turn (`AssistantMessageContent.tsx:102-108`, deferred until the turn settles so the totals are honest) and a `ChangesPill` cluster in the transcript corner with a per-file list, a shared branch menu, a commit modal with AI message generation (`/api/workbench/btw`), include-unstaged, commit / commit-and-push (Ctrl+↵) / push, and a **live sub-agent roster** (`ChangesPill.tsx:222-242`).
- **Subagents** are first-class: inline `SubagentDelegateRow` per spawn, resolved through a three-tier fallback — live SSE containers → persisted roster → a stub parsed from the spawn tool's own args (`AssistantBlockTimeline.tsx:623-694`). The roster poll (`:281-288`) is what makes delegation visible after a reload.
- **The subagent drawer** replays the persisted orchestrator jsonl into real chat blocks (`RightDrawerSubagentsSection.tsx:144-163`) with a three-way status mapping that deliberately preserves failure semantics (`:96-106`).
- **Tasks** are interactive with optimistic toggle + rollback (`RightDrawerTasksSection.tsx:57-101`).
- **Auto-open choreography** is thoughtful: subagents auto-open once per run and respect a manual close (`:282-296`), Tasks and Plan auto-open/auto-close on content (`:298-326`).
- **Usage** has per-panel error-vs-zero discrimination (`WorkspaceUsageSection.tsx:68-71`) — a dropped connection no longer looks like an idle install.
- **Rate chip** is honest: it only renders from real `outputTokens / durationMs` after the turn (`AssistantMessageContent.tsx:121-129`).
- **`turn_end` badge** renders for every non-`finished` stop with the raw token and round count in the tooltip (`:158-185`), matching the AGENTS.md contract.

### Defects

**F-31 · The todo toggle's optimistic update targets the wrong cache shape** — P1 · S · Low risk
`RightDrawerTasksSection.tsx:61-85` and `:88-95` read `data?.workbenchSession?.todos` from every query whose key contains `"workbench"`. But `ChatLayout.tsx:236-256` caches `getWorkbenchSession(id)` — the **`WorkbenchSession` itself**, not a `{ workbenchSession }` wrapper. `data.workbenchSession` is therefore always `undefined`, so **both the optimistic write and the server-reconcile write are silent no-ops**. A click on a todo appears to do nothing for up to the 2 s drawer poll (`refetchInterval: rightDrawer.open ? 2_000 : 15_000`). Fix: read `data?.todos` and write `{ ...data, todos }` for the `['workbench-session', id]` key.

**F-32 · The Git popover vanishes on a clean working tree, taking the agent roster with it** — P1 · S · Low risk
`components/chat/git/ChangesPill.tsx:100-101`: `if (files.length === 0 && !open) return null;`. The popover hosts the branch menu, the plan "Progress" step list (`:201-220`) and the **live sub-agent roster** (`:222-242`). On an orchestrator run that is still in its `explore` wave — no edits yet, `files.length === 0` — the entire roster is unreachable from this surface, and the right drawer is not open by default. Split the trigger: keep a small always-on session chip (roster count / progress) independent of the git delta.

**F-33 · `CommitModal` re-registers a document listener on every render** — P2 · S · Low risk
`ChangesPill.tsx:349-359` — the `useEffect` handling Escape and Ctrl+↵ has **no dependency array**. It removes and re-adds a `document` keydown listener on every render of the modal (which re-renders on each keystroke in the textarea). Add `[onClose]` and a stable `doCommit` ref.

**F-34 · Tasks rows use `role="checkbox"` on a `div`** — P2 · S · Low risk
`RightDrawerTasksSection.tsx:165-185`. A `div` with `role="checkbox"`, `aria-checked`, `tabIndex` and a key handler is *technically* conformant but fragile (no `aria-labelledby` pointing at the content, no `aria-readonly` for the `in_progress` state, no focus ring class). A real `<button role="checkbox">` is simpler and strictly better.

**F-35 · `subagentProposed` is delayed by a full turn, not lost** — P2 · S · Low risk
`api/workbench/streamEvents.ts:227-232` dispatches `onSubagentProposed`, which the per-turn bundle handles (`makeStreamHandlers.ts:339`) and the idle subscriber does not. Because `subagentProposed` is *not* in `RENDERED_EVENT_TYPES`, `lastSeq` is correctly left un-advanced so it replays into the next per-turn bundle — the design is right and the proposal is never lost. The cost is latency: a worker that proposes a breakdown **after the parent turn has ended** shows no approval bar until the next turn starts. `subagentWarning` is fine for the same reason — `streamEvents.ts:265-275` funnels it through `onWarning`.

---

## 6. State & data layer

### What works
- **The per-turn ↔ durable-subscriber handoff is the best-engineered part of the codebase.** `stream/session-subscriber.ts:96-117` documents precisely why the idle subscriber must *not* advance `lastSeq` past turn-content frames (doing so makes the per-turn reconnect skip them and the reply never render), and `RENDERED_EVENT_TYPES` is the mechanism. `onStarted`/`onDone` detach so the two consumers can never race. `lastSeq` is persisted per workbench id in `localStorage` (`:44-58`).
- **`reconnectChatStream` deliberately upgrades to the full per-turn handler bundle** (`:326-330` comment) so a reload mid-stream completes the reply instead of leaving a truncated bubble.
- **Debounced resync** on focus/visibility (2 s) with a stable `ensureWorkbenchSession` identity (`:1095-1119`; the comment at `ChatThread.tsx:524-528` records the ~1,800-requests-per-turn regression that the ref pattern fixed).
- **`MAX_CACHED_SESSIONS = 12` LRU** with a two-pass eviction (`session-stream-store.ts:82-116`) bounds memory in a long-lived desktop process.
- **Tombstones** stop a deleted session's aborting handlers from resurrecting a transcript (`session-stream-store.ts:149, 168, 225, 302`).
- **`MessageBubble`'s memo comparator is precise** (`MessageBubble.tsx:393-432`): message identity, `isLast`/`streaming`, `models`, and Map identity for tool-bearing rows — with the reasoning written out. This is the fix for the ~30 re-renders/second the docstring describes.
- **`ChatMarkdown` skips highlight.js while streaming** and applies colors once the turn settles (`ChatMarkdown.tsx:52-56`).
- **`peekSessionStreamState` vs `getOrInitSessionStreamState`** (`session-stream-store.ts:281-294`) is a correct fix for the React "cannot update a component while rendering" hazard.
- **Optimistic updates with rollback** in `useChatSend` (title, transcript, model) and the queue store, each with a stale-response guard.

### Defects

**F-36 · The global realtime bridge can die permanently with no recovery** — P1 · S · Low risk
`realtime/bridge.ts:257-290`. `startRealtimeBridge` sets `started = true` and then runs `void (async () => { … const base = (await whenReady()) ?? ''; … })()` with **no `try`/`catch`**. `whenReady()` rejects with "August backend did not become ready" after 120 attempts (~3 minutes — `api/client.ts:59-77`). On that rejection: the promise is unhandled, `started` stays `true` while `es` is `null`, and `scheduleReconnect()` is never reached because it is only wired inside `es.onerror`. Subsequent calls return early only if `es` is non-null, but nothing calls them again. **For the rest of the session the app has no `session.status`, no `chat.active`, no `invalidate`, and no `ui.customization` push** — sidebar dots, streaming indicators, background-subagent arrivals and the model's own color changes all go dark, with the only symptom being a console rejection. Wrap the IIFE body in `try/catch` and route failures through `scheduleReconnect`.

**F-37 · Every unhandled rejection becomes a user-facing "Unexpected error" toast** — P1 · S · Low risk
`main.tsx:21-33`. The global `unhandledrejection` handler toasts `Unexpected error: ${msg.slice(0,200)}` with an 8 s duration. This app aborts `AbortController`s constantly — stop (`:196-226`), session switch, model switch, attachment races — and an `AbortError` is **not filtered**. Any fire-and-forget promise that rejects without a `.catch` produces a scary toast in the corner of a working app. Filter `AbortError` (and `NotFoundError` from aborted fetches) before showing, and downgrade the rest to the crash log.

**F-38 · The idle subscriber permanently swallows `warning` and `info` events** — P1 · S · Low risk
`stream/session-subscriber.ts:102-117` includes `'warning'` and `'info'` in `RENDERED_EVENT_TYPES`, so `onSeq` (`:120-125`) **advances the persisted `lastSeq` past them**. But the handlers at `:144-167` only `console.warn` / `console.info`. Compare the per-turn bundle, which turns the same frames into visible `system` blocks (`makeStreamHandlers.ts:857-862, 890-894`). A harness stall nudge, a self-heal reminder, a rate-limit warning, or an info frame emitted while no per-turn stream owns the session (a background auto-turn, a subagent completing after the parent turn ended, or a reconnect that missed `started`) is **written to the console and permanently skipped on every subsequent replay**. Either render them into the transcript on the idle path, or remove them from `RENDERED_EVENT_TYPES` so they replay into the next per-turn bundle.

**F-39 · `stopRealtimeBridge` is dead** — P2 · S · Low risk
`realtime/bridge.ts:292-304`. Never imported. (Correct today, since the bridge is a module singleton, but the export invites a caller that would break HMR.)

**F-40 · Uncapped 1.5 s reconnect loop** — P2 · S · Low risk
`realtime/bridge.ts:247-254`. Fixed 1.5 s, no cap, no jitter, no attempt counter. A backend that is down for hours is a 0.67 Hz reconnect loop. Add exponential backoff to ~30 s and reset on a successful open.

**F-41 · `store/gateway.ts` starts a module-level interval and a 60 s boot loop on import** — P2 · S · Low risk
`store/gateway.ts:54-69`. The `setInterval` handle is discarded (no teardown), and the IIFE runs up to 60 one-second health probes at import time. Fine for a single-window Tauri process; breaks under HMR and any future multi-window mode.

**F-42 · The model-switch handoff uses a stale transcript snapshot** — P2 · M · Medium risk
`ComposerToolbar.tsx:426-477`. `const msgs = sessionId ? getOrInitSessionStreamState(sessionId).messages || [] : []` is captured when the menu row is clicked, and `getMessages: () => msgs` hands that frozen array to `switchChatModel`. `ChatThread.tsx:1003` does the same via `chatMessagesRef.current` (fresher) but the composer path is the one users hit. If a turn appends between opening the picker and choosing, the handoff summary is computed from a truncated transcript. Use `getOrInitSessionStreamState(sessionId).messages` *inside* `getMessages`.

**F-43 · `new Map()` allocated in a render body** — P2 · S · Low risk
`useSessionStream.ts:194`: `subagentBlocks: streamState.subagentBlocks || new Map()`. The fallback is unreachable (`emptyStreamState` always sets the field), but if it ever fires it produces a fresh Map on every render, defeating the `MessageBubble` memo comparator at `MessageBubble.tsx:422-428` and re-rendering the whole transcript. Hoist a module-level `const EMPTY_MAP = new Map()`.

**F-44 · LRU eviction can strand a transcript** — P2 · M · Medium risk
`session-stream-store.ts:92-116` silently drops the in-memory transcript past 12 sessions. If the localStorage copy for that session was evicted by a quota failure (the app handles that at `useChatSend.ts:680-683`), the user returns to an empty chat with no explanation. Consider a one-line "transcript for this chat is no longer available locally — reload from the backend" state.

---

## 7. Feedback & polish

### What works
- **Toasts**: `sonner` with `richColors`, `position="bottom-right"`, theme-synced (`main.tsx:57`).
- **Destructive-action guards are consistent and confirmed**: start-new-chat with streaming/draft copy (`ChatLayout.tsx:387-411`), remove-model with a typed confirm (`ModelRow.tsx:622-631`), session delete with an explicit irreversibility sentence (`HistoryPage.tsx:37`), and Data & Privacy purge/export behind confirm-gated rows.
- **Error surfaces are actionable, not dead ends**: the "Chat failed" toast carries **Retry** (re-sending the clean text, with the comment at `useChatSend.ts:322-326` explaining why the annotated text would stack duplicate git blocks and bot notes) and **Provider settings** → `/settings/model-providers` (`:318-332`).
- **A11y foundations are strong**: `role="alert"` error bubbles, `aria-live="polite"` on the working indicator and model-test results, `aria-expanded` on every disclosure, ARIA tabs with roving tabindex in the drawer, `aria-label` on all window controls and icon buttons in the hot paths, and `prefers-reduced-motion` honored in the scroll lerp (`useStickToBottomScroll.ts:23-29`).
- **No i18n framework, no locale files, no mixed-language strings** — English-only is enforced by construction. Nothing to fix; the risk is documentation drift (see §0.4).

### Defects

**F-45 · ConfirmDialog has no focus trap and no `aria-modal`** — P2 · M · Medium risk
`components/overlays/ConfirmDialog.tsx` is the gate in front of every destructive action (see F-12) and has neither. Keyboard users can Tab straight out of the confirmation into the page behind it, and focus is not restored on close.

**F-46 · In-thread search hijacks ⌘/Ctrl+F app-wide** — P2 · S · Low risk
`sections/chat/InThreadSearch.tsx:49-61` binds a `window` listener and calls `preventDefault()` whenever `messageCount > 0` — with no `isTypingTarget` guard. With a chat open, ⌘F inside a Settings field, the commit-message textarea, or any modal input opens the transcript search instead of focusing the field. This is the same class of bug as F-20.

**F-47 · Reminders, memory writes and circuit-mode acks are per-turn only** — P2 · S · Low risk
`makeStreamHandlers.ts:895-927` toasts recurring-task reminders (`pushNotification` + `toast.message('⏰ Reminder')`), renders memory-write chips, and opens/closes the Circuit drawer. None of `recurringTask`, `memoryUpdated`, `circuitMode` is in the idle subscriber's `RENDERED_EVENT_TYPES`, so a reminder that fires while the chat is idle replays on the next reconnect — correct, but the user gets nothing until then. A due reminder is precisely the event that must not wait.

---

## Ranked backlog

### P0 — none
No P0 (crash-on-launch, data loss, or total-surface failure) was found. The chat, settings and stream layers are well defended.

### P1

| # | Finding | File | Effort | Risk if fixed |
|---|---------|------|--------|---------------|
| F-22 | A crash in any of ~38 settings sections destroys the whole window (no `SectionBoundary`) | `ChatLayout.tsx:602-605`, `SettingsPage.tsx:189-193` | M | Low |
| F-02 | ⌘/Ctrl+N bypasses the New-chat streaming/draft confirm | `App.tsx:59-67` | S | Low |
| F-36 | Realtime bridge dies permanently and silently if `whenReady()` rejects | `realtime/bridge.ts:257-290` | S | Low |
| F-37 | Every unhandled rejection (incl. `AbortError`) toasts "Unexpected error" | `main.tsx:21-33` | S | Low |
| F-38 | Idle subscriber advances `lastSeq` past `warning`/`info` and console-logs them — permanently lost backend events | `session-subscriber.ts:102-167` | S | Low |
| F-31 | Todo optimistic toggle writes the wrong cache shape — the click is a no-op | `RightDrawerTasksSection.tsx:61-95` | S | Low |
| F-32 | Git popover (and its live agent roster) disappears on a clean working tree | `ChangesPill.tsx:100-101` | S | Low |
| F-23 | 28 of 47 settings sections have no rail row; 8 first-class surfaces are search-only | `settings-registry.ts`, `WorkspaceShell.tsx:198-201` | M | Medium |

### P2 (grouped by theme)

**Event/data visibility**
- F-47 reminder / memory / circuit acks are per-turn only — `makeStreamHandlers.ts:895-927`
- F-42 model-switch handoff uses a frozen transcript snapshot — `ComposerToolbar.tsx:430-448`
- F-44 LRU eviction strands a transcript with no explanation — `session-stream-store.ts:92-116`

**Settings IA**
- F-24 hidden-parent sections leave the rail with no active row — `settings-registry.ts:683-692`
- F-25 `RAIL_CHILDREN` is a dead export — `settings-registry.ts:697-699`
- F-26 `auditRegistry()` not run at build time despite the "build will fail" comment — `settings-registry.ts:714-717`
- F-27 `useSettingsAdvancedPreference` orphaned — `hooks/useSettingsAdvancedPreference.ts`
- F-28 settings invalidation allowlist is fragile — `SettingsPage.tsx:57-97`
- F-29 Memory / Facts & Rules share one component — `SettingsPage.tsx:378-379`
- F-30 API key shown as a plain password field — `ProviderDetailForm.tsx:231`

**Chat rendering**
- F-09 no live region on the transcript — `ChatThreadMessagePane.tsx:158-242`
- F-10 `×N` read groups expand to only the first read — `AssistantBlockTimeline.tsx:872-895`
- F-11 non-expandable rows draw a chevron affordance — `ToolStepRow.tsx:377-387`
- F-13 `liveSessionKey` falls back to the message id — `AssistantBlockTimeline.tsx:294-295`
- F-14 `virtRef.current` mutated during render — `VirtualizedMessageList.tsx:45-50`
- F-15 one 500 ms timer per running tool row — `ToolStepRow.tsx:178-183`
- F-03 Copy / TTS read empty `content` after a reload for block-only turns — `MessageBubble.tsx:230, 287`

**Composer**
- F-16 model picker has no search (deliberate) — `ModelEffortMenu.tsx:8`
- F-17 agent mode invisible on the chip in the default mode — `WorkbenchModeSelector.tsx:522-524`
- F-18 draft written to localStorage on every keystroke — `ChatThread.tsx:854-856`
- F-19 Tauri drag-drop listener can leak — `ChatThread.tsx:210-226`
- F-20 ⌘⇧Space / ⌘⇧P bound globally with no typing guard — `ChatThreadComposer.tsx:270-285`
- F-21 context ring has no numerals — `ComposerToolbar.tsx:480-503`

**Shell / layout**
- F-01 drawer overlays the transcript below ~1100 px — `RightDrawer.tsx:190-207`
- F-04 dead "Share" button on non-chat routes — `ChatTitlebar.tsx:258-271`
- F-05 `window.prompt` for rename — `ChatTitlebar.tsx:183`
- F-06 Windows window controls on all platforms — `ChatTitlebar.tsx:280-302`
- F-07 no responsive behaviour below the desktop breakpoint — `WorkspaceShell.tsx:130`
- F-08 global hotkeys fire over open dialogs — `App.tsx:51-80`

**Panels**
- F-33 `CommitModal` effect has no dependency array — `ChangesPill.tsx:349-359`
- F-34 `role="checkbox"` on a `div` — `RightDrawerTasksSection.tsx:165-185`
- F-35 `subagentProposed` shows no approval bar until the next turn starts — `streamEvents.ts:227-232`

**State layer**
- F-39 `stopRealtimeBridge` dead export — `realtime/bridge.ts:292`
- F-40 uncapped 1.5 s reconnect — `realtime/bridge.ts:247-254`
- F-41 module-level interval + 60 s boot loop in the gateway store — `store/gateway.ts:54-69`
- F-43 `new Map()` in a render body — `useSessionStream.ts:194`

**Accessibility / polish**
- F-12 17 of 23 dialogs have no focus trap
- F-45 `ConfirmDialog` has no focus trap / `aria-modal`
- F-46 ⌘F hijacked app-wide by in-thread search — `InThreadSearch.tsx:49-61`
- Contrast sweep: 69 raw low-opacity foreground utilities remain alongside 71 sanctioned `text-tier-*` usages (`styles.css:248-252`)

---

## Documentation follow-ups (no code change)

1. `docs/settings-audit.md` — rewrite. 38 → 47 sections, `settings` → `basics`, drop the `RAIL_CHILDREN` claim, and state plainly that 28 sections are rail-hidden.
2. `docs/SETTINGS_UX_REDESIGN.md` — mark the 5-group rail, the `Usage & Limits` label, and the `/settings/reliability` dashboard as historical. `reliability` is now an alias of the Review Inbox.
3. `docs/UI-SCAN-2026-09-16.md` — B1/B2/B5/B6/B7/B8 and §3.9 are closed; §3.2 is half-closed; B4 is a live, deliberate trade-off; B3 is likely closed but needs one runtime confirmation.
