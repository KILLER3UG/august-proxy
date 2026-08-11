# Agent 4 — Frontend Desktop Audit (re-audit + fresh UI/UX review)

**Scope:** `frontend/desktop/src/` — React + Vite + TypeScript + Tauri shell
**Baseline:** `master @ ce538561` ("release: 0.14.0"), prior audit dated 2025-07-17
**Environment:** Static review; `tsc -b` typecheck passes clean. `npm run dev:desktop` was not feasible here (no Rust toolchain cache; `src-tauri/target` empty), so findings lean on wiring traces and component-level evidence with `file:line`.

**File counts:** 576 TS/TSX files under `src/`. 90 `*.test.*` files. 23 `eslint-disable` comments remain. Zero `as any` in production code (one `@ts-expect-error` in a test). Below: every prior finding verified against current line numbers, plus 20 new issues found.

---

## Prior audit — status now

| # | Finding | Status | Evidence (master@ce538561) |
|---|---|---|---|
| **C1** | ChatThread.tsx god component (1,556 LoC) | 🔴 Still open, unchanged | `frontend/desktop/src/sections/chat/ChatThread.tsx:1-1556` — same 1,556 lines, still 18 `useState` / 25 `useEffect` / 10 `useCallback` / 4 `useMemo`. Since the last audit it has *grown*: new banner mounts for `MemorySuggestionBar`, `CuratorSuggestionBar`, `SubagentProposalBar`, `ChatCheckpoints`, `InitAugCard`, `QueuePills`, `ArenaView`, `DebateView`, `WorkbenchBtwDrawer` all wire top-down from this one file. The promised `useChatState` reducer/split never landed. |
| **C2** | ChatComposer prop-explosion (35+ props) | 🔴 Still open, partially relocated | `frontend/desktop/src/sections/chat/ChatComposer.tsx:33-66` — `ChatComposerProps` still ~35 props. The now-live `ChatThreadComposer.tsx:1-474` is itself a 474-line prop-threader. The grouped `ModelProps` / `StreamProps` / `AttachProps` interfaces never landed. |
| **C3** | Four model pickers | 🟠 Still 4 pickers | `ModelDropdown` (still inside dead `ChatComposer.tsx:318`), `ModelPickerDropdown` (`components/overlays/ModelPickerDropdown.tsx:1-`), `ModelPickerCard` (`sections/chat/ModelPickerCard.tsx:206`), `ModelEffortMenu` (`sections/chat/composer/ModelEffortMenu.tsx`). `ComposerToolbar` exclusively uses `ModelEffortMenu`, but the other three are still reachable (`ModelPickerCard` mounts via `ChatThreadMessagePane.tsx:206`). Consolidation never happened. |
| **H1** | Icon-only buttons missing `aria-label` | 🟢 Mostly fixed in the live path | Live `ComposerToolbar.tsx:267,370,397,419` all ship `aria-label`. **However** the still-shipped `ChatComposer.tsx` (currently dead code) at line 306-315 keeps `ToolBtn` with `title={label}` only. So the bug is gone from the live path but the dead-code file still has it. |
| **H2** | Dropdown keyboard nav missing | 🟠 Partially fixed | `ModelPickerCard.tsx:92-95,206-225` now has `role="listbox"`, `role="option"`, `ArrowDown`/`ArrowUp`. `ModelEffortMenu.tsx:768-769` still has `aria-haspopup="dialog"` but **no** ArrowUp/Down handler inside the menu (`grep -n "ArrowDown\|ArrowUp" ModelEffortMenu.tsx` returns nothing). `overlays/ModelPickerDropdown.tsx` has only `Escape` (line 90-94); no arrow nav, no `role="listbox"` anywhere. |
| **H3** | Backdrop lacks focus trap / Escape / scroll-lock | 🔴 Still open | `components/overlays/Backdrop.tsx` is still 18 lines: a single `<div onClick={onClose}>` with `bg-foreground/40 backdrop-blur-sm` and a stopPropagation child — no `useFocusTrap`, no Escape key, no scroll lock, no `aria-modal` on the dialog body. Several consumers (`QuitConfirmModal`, `ProxyStatusOverlay`) still rely on it. |
| **H4** | ErrorBoundary hard reload | 🔴 Still open | `components/ErrorBoundary.tsx:25` — `<Button onClick={() => location.reload()}>Reload</Button>` unchanged. No retry, no session restore, no toast. |
| **H5** | No backend-down indicator | 🟢 Fixed | `BackendBootstrapGate.tsx:19-152` handles `MATERIALIZING` phases (`copying / creating_venv / installing`), retries with backoff, dedicated "Backend starting…" UI. Mid-session dropouts bubble via `ProxyStatusOverlay.tsx` + `verifierBlocked` SSE channel. Titlebar still has no always-on connection dot (residual). |
| **H6** | 50+ console.* in production | 🟠 Partially fixed | Current probe: 66 `console.*` occurrences across 31 files (same magnitude). Hot-path offenders still live: `sections/chat/message-blocks.ts:136` `console.error('Failed to parse blocks, falling back:', err)` (per malformed render); `lib/tool-labels.ts:271` `console.warn` per unknown tool name; `api/workbench/streamEvents.ts:23` `console.warn` per unrecognized SSE event. None gated behind `import.meta.env.DEV`. |
| **H7** | Settings eager section imports | 🔴 Still open | `settings/settings-registry.ts` = 615 lines (grew from 23 KB-class). `sections/settings/SettingsPage.tsx:12-55` still imports ~30 section components directly (all eagerly bundled). |
| **M1** | eslint-disable proliferation (25+) | 🟡 Slightly improved | Now 23 (was 25+). Still 9 `react-refresh/only-export-components` + 9 `react-hooks/exhaustive-deps`. |
| **M2** | Old + new composer dead code | 🔴 Confirmed dead code still shipped | `ChatComposer` JSX has **zero** call sites (`grep -r "<ChatComposer"` only finds the definition at `sections/chat/ChatComposer.tsx:76`). Only `estimateContextBreakdown` and `ContextRing` re-exports are used. The 457-line component should be deleted; those two exports moved to `context-breakdown.ts` / `ContextRing.tsx`. |
| **M3** | No skeleton for model catalog | 🟢 Fixed | `ModelEffortMenu.tsx` shows "Loading…" while `modelsLoading`. `ChatThread.tsx:284-294` restores last model from `localStorage` so the composer isn't blank on first paint. |
| **M4** | No optimistic UI for rename | 🟡 Unchanged | `store/sessions.ts` rename logic still fire-and-forget. |
| **M5** | Scroll-to-bottom race | ✅ Acknowledged tradeoff | `ChatThreadMessagePane.tsx:222-244` documents the snap-instant choice. |
| **M6** | Drawer width not reclamped on resize | 🟢 Fixed | `components/shell/RightDrawer.tsx:105-111` adds a `window.resize` listener that re-clamps `baseWidth` and `wideWidth`. |
| **M7** | No skeleton for Brain | 🔴 Still open | `sections/brain/YouTab.tsx` (827 lines) issues 6+ `useQuery` calls with no `Skeleton` fallback (`grep -n "Skeleton\|isLoading" YouTab.tsx` returns nothing). All seven Brain tabs paint from empty. |
| **M8** | Voice input no permission state | 🟡 Unchanged | `ComposerToolbar.tsx:365-373` still calls `onVoice` with no "Requesting mic…" state. |
| **M9** | Toaster hardcoded dark + bottom-right | 🔴 Still open | `main.tsx:32` — `<Toaster position="bottom-right" theme="dark" />`. Light-mode users get dark toasts; bottom-right collides with the workbench drawer. |
| **M10** | Session sidebar no `aria-current` | 🔴 Still open | `components/sidebar/SessionRow.tsx:279,316,394` uses Tailwind class active state only; no `aria-current` / `aria-selected` anywhere in the row. |
| **M11** | ConfirmDialog no autofocus | 🔴 Still open | `grep -n "autoFocus\|useFocusTrap" components/overlays/ConfirmDialog.tsx` returns nothing. |
| **M12** | `MATERIALIZING` duplicated | 🔴 Still open | `BackendBootstrapGate.tsx:19` + `ProxyStatusOverlay.tsx:13` each define the same `Set(['copying','creating_venv','installing'])`. |
| **L1** | styles.css 60 KB | 🔴 Still open | `styles.css` still 2,230 lines. |
| **L2** | SessionList module-time localStorage | 🔴 Still open | `components/sidebar/SessionList.tsx:56` executes `JSON.parse(localStorage.getItem(...))` during module evaluation. |
| **L3** | ChatEmptyState narrow wrap | 🔴 Still open | `ChatEmptyState.tsx:25` — `text-2xl` heading with no responsive class. |
| **L4** | Backdrop blur perf | 🟡 Unchanged, low priority | `Backdrop.tsx:12` still `backdrop-blur-sm`. |
| **L5** | No session-switch hotkey | 🟡 Unchanged | `App.tsx:50-67` global hotkeys are palette / shortcuts modal / settings only. |
| **L6** | New controller per setter | 🔴 Still open, **plus new dead export** | `sections/chat/hooks/useSessionStream.ts:137,144,157,170` — `new SessionStreamController(sessionId).setMessages/setSubagentPrompts/setToolProgress/...` allocate one per call. **Bonus**: the memoized `controller` factory at lines 130-133 is exported in the return object (line 198) but **no consumer calls it** (`grep -rn "\.controller()" src/sections` empty). Dead export. |
| **L7** | No theme transition | 🟡 Unchanged | `lib/theme.ts` + `store/theme.ts` — no transition class around theme flips. |
| **L8** | Tauri drag-drop listener leak | 🔴 Still open | `ChatThread.tsx:209-222` — same `unlisten?.()` pattern; if unmount precedes the import resolution, the listener is never unregistered. |

**Score**: 4 fixed (H5, M3, M6, partial H2), 2 acknowledged (M5), 17 still open (C1, C2, C3, H3, H4, H6, H7, M2, M7, M9, M10, M11, M12, L1, L2, L3, L6, L8), 7 partial / unchanged (H1, M1, M4, M8, L4, L5, L7). The big structural items (C1 god component, C2 prop explosion, C3 four pickers, H7 eager settings) are entirely untouched.

---

## New bugs & mismatches

### 🔴 N1 — `SubagentRow` shows the literal string `\u2026` instead of an ellipsis

File: `frontend/desktop/src/components/chat/SubagentRow.tsx:136,148`

```tsx
<div className="text-[11px] text-muted-foreground/70 italic py-1">
  Waiting for output\u2026           {/* ← line 136: JSX text, not a string literal */}
</div>
…
Running\u2026                        {/* ← line 148: same */}
```

JSX text children are not string-literal escape contexts. Both lines render as the visible text `Waiting for output\u2026` / `Running\u2026` to the user. The other 4 unicode escapes in the codebase (`ToolCallItem.tsx:177`, `ChatMarkdown.tsx:97,173`) are correct because they're inside string literals.

**Fix**: `{'\u2026'}` or just write the actual `…` character.

### 🔴 N2 — ChatTitlebar overflow menu button has no `aria-label`

File: `frontend/desktop/src/components/shell/ChatTitlebar.tsx:163-184`

```tsx
<button
  type="button"
  onClick={() => setOverflowOpen((v) => !v)}
  className={…}
  title="More"
  aria-expanded={overflowOpen}
  aria-haspopup="menu"      // ← has aria-haspopup but no accessible name
>
  <MoreHorizontal className="size-3.5" />
</button>
{overflowOpen && (
  <div role="menu" className="…">
    {/* exactly one <button role="menuitem">Read aloud</button>; no ArrowUp/Down, no Escape */}
  </div>
)}
```

Every other chrome button on the same titlebar (lines 222, 229, 236 — minimize / maximize / close) has an `aria-label`. This one relies on `title`. Screen readers announce "button." The opened `role="menu"` div has no keyboard handling (no Escape, no ArrowDown) — compare with the well-behaved `cmdk`-based `CommandPalette.tsx`.

### 🟠 N3 — `/c/new` resolves via fallback redirect, not a real route

`OnboardingTour.tsx:43` links to `/c/new` from step 3 ("Try the harness" → "Start a chat"). There is no registered route for `/c/new`; the catch-all in `ChatLayout.tsx:289-325` notices there's no session with id `new`, calls `createSessionInCurrentWorkspace()`, then `navigate('/c/<realId>', { replace: true })`. This happens to work, but:

- The URL briefly flashes `/c/new` before being replaced.
- `ChatThread` mounts with `sessionId='new'` and a transient empty `active` session before the redirect — visible as a flicker of the empty state.
- It's a maintenance landmine: any future change to the fallback ordering breaks the CTA.

**Fix**: register `/c/new` as a first-class route that calls `createSessionInCurrentWorkspace` and immediately replaces the URL.

### 🟠 N4 — Subagent UX: no way to *stop* a running sub-agent from the chat thread

Files: `components/chat/SubagentRow.tsx`, `components/chat/SubagentLaunchList.tsx`, `components/chat/SubagentExpandedCard.tsx`.

The backend API exposes `POST /api/subagents/{taskId}/terminate` (`api/subagents.ts:55`). The frontend calls it from `sections/board/BoardPage.tsx:124` and `sections/brain/RunsTab.tsx:150` — but **not** from any surface inside the chat. A user watching a sub-agent spiral in `SubagentRow`/`SubagentExpandedCard` has to switch routes to Board or Brain→Runs to kill it.

In the same chat thread, `SubagentRow` shows a status pill (`Completed / Failed / Running / Cancelled`) — but no action button. Composer-level stop button (`ComposerToolbar.tsx:393-399`) stops the *main* stream, not a running sub-agent.

### 🟠 N5 — Two adjacent context chips in composer

`ComposerToolbar.tsx:243` renders `<ContextRing …/>` (token fill donut) immediately followed by `<ContextUsedBadge sessionId/>` at line 261 (memory provenance chip). Both are hover-popover chips in a 22px-tall toolbar, similar iconography (donut vs Brain). It's not obvious which to click, and they tell two halves of the same story (cost + provenance). Consider merging into one chip with two tabs, or moving the brain chip to the titlebar.

### 🟠 N6 — LocalStorage key naming is inconsistent (`august_xxx` vs `august-xxx`)

Probe: `grep -roE "august_[a-zA-Z_]+" src/` and `grep -roE "august-[a-zA-Z-]+" src/` return disjoint sets with no clear convention (`august_last_model`, `august_onboarding_done`, but `august-sessions-collapsed`, `august-workbench-sidebar-open`). Worse: two separate "onboarding" keys exist — `august_onboarding_done` (`OnboardingTour.tsx:9`) and `august-onboarding-skipped`. Any future "reset onboarding" pass has to know to clear both. **Split-brain onboarding state is one missed key away.**

### 🟡 N7 — `useSessionStream` exports a memoized `controller` nothing calls

`sections/chat/hooks/useSessionStream.ts:130-133` wraps `new SessionStreamController(sessionId)` in a `useCallback` and exports it (line 198). No consumer invokes `controller()` (`grep -rn "\.controller()" src/sections` empty). Dead API surface — and reinforces L6 (each setter still allocates a fresh controller instead of using the memoized factory).

### 🟡 N8 — Verifier toggle is disabled when no workbench session, with no reason tooltip

`ComposerToolbar.tsx:266-285` — `disabled={!workbenchSession?.id}` with `aria-label="Enforce verification before final answer"` and a `title` that describes what ON does. The disabled state has no explanatory tooltip: a casual chat user hovering the grayed shield sees "Verifier ON: final answer withheld…" — which they can't act on. Either show a "Start a workbench session to enable verification" tooltip for the disabled state, or hide the shield outside workbench mode.

### 🟡 N9 — BrainDashboard reads `?tab=` from `window.location.search`, not react-router

`sections/brain/BrainDashboard.tsx:23-28`:

```ts
const [tab, setTab] = useState<BrainTab>(() => {
  const t = new URLSearchParams(window.location.search).get('tab');
  return BRAIN_TABS.includes(t as BrainTab) ? (t as BrainTab) : 'you';
});
```

Bypasses `useSearchParams`, so back/forward nav and any subsequent `?tab=` change after mount don't update the active tab. Deep links from elsewhere in the app (`/brain?tab=you` from the composer's context badge) only work on cold mount.

### 🟡 N10 — `subagent` vs `sub-agent` nomenclature inconsistency

Probe: `grep -c "sub-agent"` and `grep -c "subagent"` — both forms are in heavy rotation (`SubagentRow`, `SubagentLaunchList`, `focused-subagent.ts` vs copy "Send follow-up with subagent" at `ChatThreadComposer.tsx:349`). The user-visible string `Send follow-up with subagent` reads like a placeholder and is missing an article: "Send a follow-up to the focused sub-agent" would be warmer.

### 🟡 N11 — No small-window handling on the chat layout

`ChatLayout.tsx` only handles responsive at 900px via `styles.css:891`. Below ~640px there is no breakpoint at all. `ChatEmptyState.tsx:25` `text-2xl` overflows at ~600px (L3). The `SessionSidebar` resizer supports touch but its minimum width exceeds a phone-scale window. A 50%-width 1080p Tauri install will feel cramped.

### 🟡 N12 — `useConfirmDialog` + `ConfirmDialog` no keyboard affordances

Already cited at M11, but worth a new callout because the pattern is **used 20+ times**: `hooks/useConfirmDialog.ts` creates a Promise-based API, but the rendered `ConfirmDialog` mounts without focus management. Escape doesn't cancel. Confirming destructive actions requires a mouse. Central fix (auto-focus the cancel button + Escape handler) rolls out everywhere.

### 🟡 N13 — ChatThread ORs 4 sources of `streaming` truth

`ChatThread.tsx:237-242`:

```ts
const streaming =
  chatRuntime.isSessionStreaming(sessionId) ||
  (!!workbenchStreamId && chatRuntime.isSessionStreaming(workbenchStreamId)) ||
  !!(sessionId && activeChatSessions[sessionId]) ||
  !!(workbenchStreamId && activeChatSessions[workbenchStreamId]);
```

Four boolean sources OR'd together. Any desync between `chatRuntime`, `activeChatStreamsStore`, and the workbench session id mapping causes stuck "AUG" working-indicator UI. Consolidate into a single `useIsSessionStreaming(sessionId)` hook.

### 🟡 N14 — `ChatComposer.tsx` component is dead code; only its re-exports are used

`sections/chat/ChatComposer.tsx` — only `estimateContextBreakdown`, `ContextBreakdown` type, and `ContextRing` are imported elsewhere. The 381-line `ChatComposer` JSX function (line 76-457) has zero call sites (`grep -rn "<ChatComposer" src/` returns only the definition). Either delete it or move `ContextRing` and `estimateContextBreakdown` into `chat/context-breakdown.ts` so the file can be fully retired.

### 🟡 N15 — SubagentProposalBar has no pending state beyond button disable

`sections/chat/SubagentProposalBar.tsx:60-83` — During `decide.isPending` the Launch/Reject buttons disable, but the bar itself stays interactive: clicking again will no-op silently. If the model re-proposes before `qc.invalidateQueries({ queryKey: ['subagent-runs'] })` lands, the local `$subagentProposals` map lags. Optimistically mark the proposal `pending` in the store, and only re-render the bar when the store is stable.

### 🟡 N16 — Composer "Send follow-up with subagent" has no visual pin

`ChatThreadComposer.tsx:349` — when `focusedSubagent` is set (from expanding a `SubagentExpandedCard`), only the textarea placeholder changes. No chip like "→ Agent X", no close affordance to de-focus, no color shift on the composer. User has to expand another sub-agent or close the card to clear focus. A "Focusing: <title> ×" chip under the toolbar would be cheap and discoverable.

### 🟡 N17 — Empty-state copy identical across runs / agents / brain

- `sections/agents/Agents.tsx:55` — `No agents registered.`
- `sections/runs/RunsPage.tsx:298` — `No runs yet — start a chat and workbench runs appear here.`
- `sections/automations/Automations.tsx:641` — `No runs yet.`
- `components/settings/SettingsEmptyState.tsx` — generic, with title + description props.

Inconsistent detail and tone. Adopt one pattern (e.g. `EmptyState` with `icon`, `title`, `description`, `action`) everywhere.

### 🟡 N18 — Onboarding copy violates the "warm, plain, concrete" goal

`OnboardingTour.tsx:30` — "A harness that learns you — it remembers your preferences, tracks which models actually win your tasks, and runs arena comparisons and debates so you always pick the best answer." Terms like "harness," "arena," "debates" are heavy; "always pick the best answer" is hype. Step 4 pairs a `Gavel` icon with "See what August knows" — wrong metaphor.

Suggest: "August watches how you work and shows which model actually wins your tasks. Everything it learns is editable — this is your AI."

### 🟡 N19 — Upstream `[400]` errors leak verbatim in chat toasts

`ChatThread.tsx` + `makeStreamHandlers.ts` frequently bubble up provider errors as raw `e.message` toasts. The 0.12.21 release fixed `[400] session_id: Invalid input: expected string, received null` at the cause, but any future provider error will surface as `[400] …` with raw Pydantic output. There is a "friendly chat errors" helper (commit `f405d079`) but it's not applied uniformly.

### 🟡 N20 — No loading skeletons in Brain `YouTab`

`sections/brain/YouTab.tsx:1-827` makes 6+ `useQuery` calls (`timeline`, `routingStats`, `friction`, `audit`, plus profile + heuristics) and renders the layout unconditionally. Cold load paints empty section after empty section. (`grep -n "Skeleton\|isLoading" YouTab.tsx` returns nothing.)

---

## UI/UX & flow review

### Onboarding / first-run

- **Smooth**: `BackendBootstrapGate` (3 materializing phases + retry/backoff) — the first-boot experience is genuinely considered, better than what the prior audit found.
- **Rough**: 4-step tour covers Welcome → Provider → Harness → Brain. No mention of skills, automations, or the `/` command surface inside chat. `?tab=you` deep-link relies on the N9 `window.location` hack.
- **Friction**: N3 (`/c/new` flicker), N18 (copy), N6 (duplicate onboarding keys).

### Chat & composer

- **Smooth**: Stream eviction, scroll anchoring, steer-mid-run, handoff-between-models, `@tool` palette, `/` command palette, model/effort menu — all wired and reasonably polished. Reasoning trace well-separated.
- **Rough**: C3 — 4 model pickers with different affordances (toolbar popover vs command-palette `ModelPickerDropdown` vs mid-stream `ModelPickerCard` vs `ModelEffortMenu`). Each entry point feels different; keyboard model differs.
- **Confusing**: N5 double chip (ring + brain) side-by-side; N8 disabled shield with no "why" hint; N13 4-source OR for streaming is the root of any "AUG indicator stuck" report.

### Composer specifically

- Auto-grow (max 360px) + Cmd+Shift+P live preview is a nice touch.
- Copy voice is inconsistent: `Write a message...` (quiet period) vs `Add a direction while August works…` (warm) vs `Send follow-up with subagent` (clipped).
- The `Steer` CTA is unusual. Rename to "Redirect" or add a one-line first-use tooltip; "steer" only makes sense after you've seen the behavior.

### Workbench surface

- **Smooth**: Right-drawer persistence, M6 resize fix landed, approval banner + plan-proposal handled at the right layer, BTW drawer has clean separation.
- **Rough**: WorkbenchModeSelector + SandboxModeSelector both visible in toolbar and in the right drawer — two places to flip the same state. Consider one "Guards & sandbox" popover that owns both.

### Sub-agents

- **Working**: `SubagentLaunchList` checklist, `SubagentExpandedCard` inline detail, `SubagentTimeline` per-tool trace, focused-subagent propagation to composer placeholder.
- **Missing**: N4 (no kill in chat), N16 (no focus pin). No toast when terminate fails. No batch "Cancel all running" affordance.
- **See dedicated section below.**

### Brain

- Tabs (You / Runs / Learning / Journey / Ops / Activity / Health) — clean and consistent, minus N9 (`?tab=` hack).
- `YouTab.tsx` is 827 lines — splitting into `ProfileSection`, `HeuristicsSection`, `FrictionSection`, `RoutingStatsSection` would improve both testability and enable N20's skeletons.

### Settings

- ~40 sections findable via search; 5 top-level buckets left rail. Reasonable organization.
- H7 still forces ~30 modules through the wire on one click. Easiest click-speed win in the app.
- `SettingsEmptyState` + `SettingsPage` skeleton patterns are starting to standardize — spread this to Brain (N20).

### Live / BTW surface

- `LiveSurface.tsx` (200 lines) + `LiveOrb`, `LiveCaptions`, `LiveControls`, `LiveApprovalCard`, `LiveToolRail` — cleanly split. Reduced-motion honored (line 33-39).
- BTW drawer in chat flips from offline to streaming without transition. A soft `framer-motion` height tween would feel less abrupt (low priority).

### Narrow-window / "mobile of the desktop"

- Tailwind breakpoints only at 900px (styles.css:891). No 640px rule (N11). Below ~600px: ChatEmptyState title overflows; Brain tabs wrap to 4 lines; titlebar buttons hold 32px; composer MAX height (360px) is absolute — should be `min(360px, 40vh)`.

### Loading / empty / error states

- Strong in chat (WorkingIndicator, scroll pills, virtualized rows with skeletons).
- Weak in Brain, Skills, Automations, Agents (N17, N20) — pages that can take a beat on cold backend.

---

## Suggested UI for launching sub-agents

Concrete component tree:

```
ComposerToolbar
└── <SubagentLauncherTrigger />          // "+ Spawn agents" chip; visible when input non-empty OR a plan banner is open
       │  (click) →
       ▼
<SubagentLauncherDialog />               // reuse ConfirmDialog pattern + useFocusTrap (fixes N12 for free)
   ├─ Header: "Split this task across N agents"
   ├─ Body:
   │    <WorkItemList>
   │       ├─ auto-suggested breakdown from POST /api/subagents/propose
   │       ├─ per-row editable: goal, agentId, model, effort
   │       └─ per-row "Tools…" collapsible that sets restrictedTools
   ├─ Footer: [Cancel]  [Spawn N agents]
   └─ Hotkeys: Esc / Cmd+Enter
```

After spawn, surface the existing `SubagentLaunchList` (Cursor-style inline checklist in the chat thread) upgraded with:

```
SubagentLaunchList (existing, upgraded)
   ├─ Header: "Running N agents" + [Cancel all]
   ├─ Row
   │   ├─ Pulsing activity dot + elapsed (existing)
   │   ├─ ⋯ menu: [Focus follow-up] [Open full modal] [Cancel this agent] — wires subagents.terminate
   │   └─ On failure: red ⋯ + "Last error" tooltip
   └─ Footer rollup: "3 of 5 done · 47s elapsed · ~123k tok" — aggregates SubagentBlockState
```

`SubagentExpandedCard` gains a `Stop` button next to `Maximize2` / `X` that calls `subagents.terminate(state.taskId)`. Disabled unless `state.status === 'running'`. ConfirmDialog on click (same one used for chat archive).

`SubagentRow` (compact row) gains the same affordance, both backed by a shared hook:

```ts
// hooks/useSubagentActions.ts — new
export function useSubagentActions(taskId: string) {
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => subagents.terminate(taskId),
    onSuccess: () => {
      toast.success('Sub-agent stopped');
      void qc.invalidateQueries({ queryKey: ['subagent-runs'] });
    },
    onError: (e: Error) =>
      toast.error(e.message ?? 'Failed to stop sub-agent'),
  });
  const focus = () =>
    setFocusedSubagent({ jobId: taskId, title: '<resolved>' });
  return { cancel, focus };
}
```

**Progress UX**: each agent row keeps its status pill + elapsed timer. Add a thin top progress bar across `SubagentLaunchList` (`<SubagentProgressHeader>`) that aggregates `completed / total` so a long list doesn't require scrolling for status.

**Toast on terminate failure** distinguishes "already finished" (info) from "backend error" (error) — surface via the 409 vs 500 responses from `/api/subagents/{id}/terminate`.

**Coordinate with Agent 3 (backend)**: this UI assumes the backend exposes per-task `terminate` (it does at `api/subagents.ts:55`) and a "cancel many" batch endpoint would help but is not required. The proposal-approval flow already exists (`SubagentProposalBar`) — wire that to feed `SubagentLauncherDialog` as the reviewable form (skip the auto-suggestion call when a proposal is already pending).

---

## Suggested improvements (ordered by impact)

1. **Delete the dead `ChatComposer.tsx` JSX (N14 + M2 + C2-partial, plus removes H1)** — single source of composer truth. Lowest-risk high-payoff cleanup in the audit.
2. **Fix N1 `\u2026` in `SubagentRow` immediately** — copy pollution on every running sub-agent row.
3. **Split `ChatThread.tsx` (C1)** — it now owns arena, debate, exam, handoff, plan banner, scroll, voice, queue, offline, composer orchestration. Even pulling `useChatQueueFlush` and `useChatOfflineBanner` into their own hooks would unlock the rest.
4. **Sub-agent launcher dialog (see prior section)** — closes the biggest UX gap (N4, plus adds the missing "+ Spawn agents" entry point in chat).
5. **Backdrop primitive fix (H3) + ConfirmDialog focus (N12)** — one fix rolls out accessibility improvements across every modal in the app.
6. **H7 lazy-loaded settings sections** — either `React.lazy` per section id, or split the registry into smaller registries loaded by route. Currently ~30 modules ship through the wire for one click.
7. **Merge the two context chips (N5) or move ContextUsedBadge to the titlebar** — pick one surface.
8. **Single `useIsStreaming(sessionId)` hook (N13)** — replace the 4-source OR, kill the "stuck AUG" class of bugs.
9. **LocalStorage key convention pass (N6)** — write `lib/storage.ts` with `storage.get('lastModel')` / `storage.get('onboardingDone')` so we stop mixing `_` and `-`, and the duplicate onboarding keys are merged.
10. **Backend-down indicator (H5 residual)** — a small status dot in `ChatTitlebar` would close the loop on mid-session drops.
11. **Responsive breakpoints for narrow Tauri windows (L3, N11)** — add 640px breakpoint for ChatEmptyState, Brain tabs, Titlebar; switch composer max-height to `min(360px, 40vh)`.
12. **`?tab=` deep links via `useSearchParams` (N9)** — small fix, big robustness win for Brain + Settings deep-link flows.
13. **Toaster theme bound to UI theme (M9)** — `<Toaster theme="system" position="bottom-center" />`.
14. **SessionRow `aria-current="page"` (M10)** — one attribute, real a11y win.
15. **Empty-state pattern unification (N17)** — pick `SettingsEmptyState` style and roll it out to Runs, Agents, Brain tabs.
16. **Continue M1 cleanup**: 9 `react-hooks/exhaustive-deps` eslint-disables point to real effect-dependency bugs waiting to happen.
17. **Console statement gating (H6 residual)** — wrap in `if (import.meta.env.DEV)` or provide a logger with levels.
18. **Onboarding copy pass (N18, N19)** — drop "harness", "arena", "debates" in user-facing strings; say what the user gets.
19. **Tauri drag-drop listener abort (L8)** — add a `mountedRef` and skip `unlisten` setup if already unmounted.
20. **Run the Browser Use GUI test session as a follow-up** to discover runtime-only regressions static review can't surface (barge-in behavior in LiveSurface, drawer animation smoothness, focused-subagent placeholder timing, narrow-window overflow).

---

## What I could not verify

- **Real behavior of `npm run dev:desktop`** in this worktree (no Rust cache; cold build would exceed audit budget). Animation smoothness, focus management inside modals, barge-in feel — those need a running shell. Flag for Agent 3's redesign sweep using the Browser Use plugin against the dev server.
- Live STT/TTS handshake (Web Speech API availability inside the Tauri webview).
- Arena / Debate / Exam views under stress (these mount from inside ChatThread — couldn't verify render states without a live session).
