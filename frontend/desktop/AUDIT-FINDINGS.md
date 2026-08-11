# Frontend Desktop UI/UX Audit Findings

**Scope:** `frontend/desktop/src/` — React + Vite + TypeScript + Tauri desktop shell  
**Date:** 2025-07-17  
**Codebase size:** ~200+ TS/TSX files

---

## Executive Summary

The frontend is well-architected overall: lazy-loaded route sections with error boundaries, a polished design token system, Zustand + React Query state management, and sensible performance patterns (virtualized messages, stick-to-bottom scroll, idle-deferred imports). However, several structural and UX issues emerged across the audit.

**Critical (3)** · **High (7)** · **Medium (12)** · **Low (8)**

---

## 🔴 Critical Issues

### C1. ChatThread.tsx is a 1,556-line God Component (59 KB)

**File:** `sections/chat/ChatThread.tsx`  
**Problem:** This single component owns ~25 `useState` hooks, ~20 `useEffect` hooks, ~10 `useCallback`/`useMemo` blocks, and 5 custom hooks. It manages: message state, model selection, attachments, streaming, plan approval, effort/thinking toggles, exam mode, aug preview, arena/debate orchestration, offline queue flushing, drag-and-drop, scroll tracking, workbench session lifecycle, and the entire render tree including the composer slot.

**Impact:**
- Any state change triggers a near-full re-render of the chat surface
- Impossible to unit-test individual behaviors in isolation
- Merge conflicts are constant — nearly every feature touches this file
- The component mixes UI orchestration (drag-drop, scroll), business logic (model switching, workbench session creation), and stream management

**Recommendation:** Extract into composable units:
- `ChatThreadShell` — layout + scroll container + drag-drop
- `useChatState` — consolidate the 25 useState into a single reducer/slice
- Move workbench session lifecycle to a dedicated hook
- Move model selection logic to `useChatModels` (already partially done)
- Move arena/debate launch to a separate orchestrator

### C2. ChatComposer Prop Explosion — 35+ Props

**File:** `sections/chat/ChatComposer.tsx`  
**Problem:** `ChatComposerProps` has 35+ individual props passed through from ChatThread → ChatThreadComposer → ChatComposer. Each intermediate layer must thread every prop through.

**Impact:**
- Fragile: adding a prop requires touching 3+ files
- The `ChatThreadComposer` file is 474 lines of pure prop threading
- IDE autocompletion is slow; TypeScript inference is expensive

**Recommendation:** Group related props into interfaces:
```ts
interface ModelProps { selectedModel, models, visibleModels, onSelect, ... }
interface StreamProps { streaming, onSend, onStop, effort, ... }
interface AttachProps { attachments, onRemove, onUpload, ... }
```
Or use a context provider for the chat composer scope.

### C3. Dual Dropdown Pattern — Two Competing Model Pickers

**Files:** `sections/chat/ChatComposer.tsx` (ModelDropdown), `overlays/ModelPickerDropdown.tsx`, `sections/chat/ModelPickerCard.tsx`, `composer/ModelEffortMenu.tsx`  
**Problem:** There are **four** different model selection UIs:
1. `ModelDropdown` inline in the old ChatComposer (pop-out from toolbar)
2. `ModelPickerDropdown` with portal-based positioning and search
3. `ModelPickerCard` as an inline card in the message pane
4. `ModelEffortMenu` combining model + effort in a popover

Each has slightly different behavior, positioning logic, and keyboard handling.

**Impact:** Users encounter different model pickers depending on how they trigger selection (toolbar button, command palette, mid-stream switch). The experience is inconsistent.

**Recommendation:** Consolidate into a single `ModelPicker` component with variant props (`inline`, `portal`, `compact`).

---

## 🟠 High Issues

### H1. Missing `aria-label` on Interactive Toolbar Buttons

**File:** `sections/chat/ChatComposer.tsx`, lines ~310-340  
**Problem:** The `ToolBtn` component renders `<button>` elements with only a `title` attribute but no `aria-label`:
```tsx
function ToolBtn({ Icon, label, onClick }) {
  return (
    <button onClick={onClick} className="..." title={label}>
      <Icon className="size-4" />
    </button>
  );
}
```
Screen readers announce "button" without context. Similarly, the effort dropdown button and model dropdown button in the same file lack accessible names.

**Recommendation:** Add `aria-label={label}` to all icon-only buttons. The `ModelDropdown` and `EffortDropdown` buttons should also have `aria-haspopup="listbox"` and `aria-expanded`.

### H2. Dropdown Popovers Lack Focus Management and Keyboard Navigation

**Files:** `sections/chat/ChatComposer.tsx` (ModelDropdown, EffortDropdown), `components/shell/ChatTitlebar.tsx` (overflow menu)  
**Problem:** Custom dropdowns are implemented as raw `<div>` elements with `position: absolute` — they don't trap focus, don't support arrow-key navigation, and don't announce themselves as menus. The `ModelDropdown` has no `role="listbox"` or `role="option"` on items.

Compare with `components/overlays/CommandPalette.tsx` which correctly uses `cmdk` with proper ARIA. The composer dropdowns should match this quality.

**Recommendation:** Either:
- Migrate to `@radix-ui/react-select` or `cmdk` for consistent keyboard + ARIA behavior
- Or add `role="listbox"`, `role="option"`, `aria-activedescendant`, and arrow-key handlers manually

### H3. Backdrop Component Has No Keyboard Dismiss Safety

**File:** `components/overlays/Backdrop.tsx`  
**Problem:** The `Backdrop` component uses `onClick={onClose}` on the overlay div but doesn't:
1. Trap focus inside the dialog content
2. Handle Escape key to close
3. Prevent background scrolling (scroll lock)

While individual modals like `CommandPalette` add their own Escape listener and focus trap, the `Backdrop` base component is reused by several overlays (QuitConfirmModal, ProxyStatusOverlay, etc.) and some callers don't add these protections.

**Recommendation:** Build `Backdrop` as a proper `Dialog` primitive that includes focus trapping, Escape handling, scroll lock, and `aria-modal="true"` by default. Individual modals should not need to re-implement these.

### H4. ErrorBoundary Reset Button Uses `location.reload()` — Loss of All State

**File:** `components/ErrorBoundary.tsx`  
**Problem:** The global error boundary's recovery action is a hard page reload:
```tsx
<Button onClick={() => location.reload()}>Reload</Button>
```
This wipes all in-memory state (Zustand stores, React Query cache, streaming connections). For a chat application with potentially long-running streams, this is destructive.

The `SectionBoundary` (per-section boundary) is better — it has a retry mechanism via `retryKey` that remounts just the crashed section.

**Recommendation:**
- Add a "reset" callback that attempts to remount the subtree without a full reload
- At minimum, persist the active session ID so the reload navigates back to the right chat
- Consider a toast notification explaining what was lost

### H5. Chat Thread Empty State Doesn't Show When Backend Is Down

**File:** `sections/chat/ChatEmptyState.tsx`, `components/overlays/BackendBootstrapGate.tsx`  
**Problem:** `BackendBootstrapGate` gates the entire app behind a health check in Tauri mode. However:
1. In web/browser mode (`!isTauri`), the gate is bypassed (`return <>{children}</>`) — the chat shows with no backend indication
2. If the backend goes down mid-session (after initial health), the chat shows a "Send" button that silently fails

**Recommendation:**
- Show a subtle connection status indicator in the titlebar or composer when the backend is unreachable
- The `ProxyStatusOverlay` handles this, but it's separate from the chat flow — users may not notice a backdrop overlay behind their chat

### H6. 50+ `console.warn/error` Statements in Production Code

**Problem:** The codebase has 50+ `console.warn` and `console.error` statements across production code paths. While most are in catch blocks (acceptable for diagnostics), several are in hot paths:
- `message-blocks.ts:136` — `console.error('Failed to parse blocks')` on every render of a malformed message
- `tool-labels.ts:271` — `console.warn` for unknown tool names (noisy during streaming)
- `streamEvents.ts:23` — `console.warn` for unrecognized events

**Impact:** Console pollution makes debugging real issues harder. Users with DevTools open see noise.

**Recommendation:** 
- Gate warnings behind `import.meta.env.DEV` or a debug flag
- Use a structured logger with levels (error/warn/info/debug) that can be silenced in production

### H7. Settings Page Has 30+ Lazy-Loaded Sections — Massive Bundle Split

**File:** `settings/settings-registry.ts` (23 KB), `sections/settings/SettingsPage.tsx`  
**Problem:** The settings page lazy-loads ~30 section components. While `React.lazy` handles code splitting, the registry itself is 23 KB and imports every section's icon + metadata. On first navigation to Settings, the user downloads the registry + the active section chunk.

More importantly, the `SettingsPage` component imports ALL section components directly (not lazily) for the `WorkspaceShell` render:
```tsx
// SettingsPage imports these directly:
import { WorkspaceUsageSection } from '@/sections/workspace/WorkspaceUsageSection';
import { WorkspaceMemorySection } from '@/sections/workspace/WorkspaceMemorySection';
// ... 20+ more
```

**Recommendation:** Make `SettingsPage` itself fully lazy (it's already in a `Lazy` wrapper in `routes.ts`). Move section component resolution to a dynamic import map so only the active section's code is downloaded.

---

## 🟡 Medium Issues

### M1. `eslint-disable` Proliferation — 25+ Suppressed Warnings

**Problem:** 25+ `eslint-disable` comments across the codebase:
- 7x `react-refresh/only-export-components` — indicates components that export non-component types alongside components (a code organization smell)
- 10x `react-hooks/exhaustive-deps` — suggests unstable references or complex effect dependencies that should be refactored

**Files:** `ChatThread.tsx` (3), `ChatMarkdown.tsx`, `ExamHost.tsx`, `WorkspaceDonut.tsx`, `DiffView.tsx`, `ClarifyTool.tsx`, `button.tsx`, `SandboxModeSelector.tsx`, `WorkbenchModeSelector.tsx`, `ModelVisibilityModal.tsx`

**Recommendation:**
- For `react-refresh`: Move type exports to separate `*.types.ts` files
- For `exhaustive-deps`: Refactor effects to use proper dependency arrays or consolidate into custom hooks with stable references

### M2. ChatComposer Has Both Old and New Versions — Dead Code Risk

**Files:** `sections/chat/ChatComposer.tsx` (original, simpler), `sections/chat/ChatThreadComposer.tsx` (new, more features), `sections/chat/composer/ComposerToolbar.tsx`  
**Problem:** The original `ChatComposer.tsx` is imported and rendered inside `ChatThread.tsx`, but `ChatThreadComposer.tsx` is also present and renders `ComposerToolbar`. The architecture appears to have gone through a refactor where the old `ChatComposer` was replaced by `ChatThreadComposer`, but both still exist. The old one has a simpler `ModelDropdown` and `EffortDropdown` while the new one uses `ModelEffortMenu` (31 KB!).

**Recommendation:** Confirm which is the canonical composer. If the old `ChatComposer.tsx` is dead code, remove it. If both are in use, document the split.

### M3. No Loading State for Model Catalog on First Load

**Files:** `sections/chat/hooks/useChatModels.ts`, `sections/chat/ChatThread.tsx`  
**Problem:** On initial load, `models` is an empty array until the provider catalog is fetched. The model dropdown shows "No model loaded" as a button label — this is a poor first impression. The `modelsLoading` flag exists but the dropdown doesn't show a skeleton or loading spinner in the button itself.

**Recommendation:** Show a skeleton shimmer on the model selector button while models are loading. Consider defaulting to the previously-selected model from localStorage immediately (this partially exists via `localStorage.getItem('august_last_model')` but the placeholder model doesn't have enriched metadata).

### M4. No Optimistic UI for Session Renaming

**File:** `components/sidebar/SessionRow.tsx`, `store/sessions.ts`  
**Problem:** Renaming a session calls `renameSession()` which updates Zustand state synchronously, but the backend title sync is fire-and-forget. If the backend rejects the rename (unlikely but possible), the UI shows the new name while the backend has the old one. On next reconcile (60s interval), the title snaps back.

**Recommendation:** Add a brief optimistic confirmation toast that can be undone, or validate the rename against the backend before updating UI state.

### M5. Scroll-to-Bottom Button Animation Can Race with Content Growth

**File:** `sections/chat/hooks/useStickToBottomScroll.ts`, `sections/chat/ChatThread.tsx`  
**Problem:** The stick-to-bottom uses a smooth lerp (requestAnimationFrame-based smooth scroll). When the user scrolls up and new content arrives, the "jump to bottom" pill appears. Clicking it snaps instantly (by design — documented in comments). However, if the user clicks while the lerp is still running, the `programmaticScrollRef` guard may not have cleared, causing the click to be partially eaten.

The code has a thorough comment explaining this decision, so this is a known tradeoff rather than a bug.

**Impact:** Minor — occasional missed clicks during rapid scroll transitions.

### M6. Right Drawer Width Persistence Doesn't Account for Window Resize

**File:** `components/shell/RightDrawer.tsx`  
**Problem:** The drawer width is persisted to localStorage and restored on mount. However, `clampWidth` only runs on initialization — if the user resizes the window to be narrower than the stored width, the drawer is wider than the 60% viewport fraction limit until the next mount.

**Recommendation:** Add a `ResizeObserver` on the window to clamp drawer width dynamically, or re-clamp on the next drawer open.

### M7. No Skeleton/Progress for Brain Dashboard or Other Heavy Sections

**Files:** `sections/brain/BrainDashboard.tsx`, `sections/skills/SkillsPage.tsx`  
**Problem:** These sections use `React.lazy` with `<Suspense fallback={<PageLoader />}>`, which is good. But the `PageLoader` only shows generic skeleton shapes. For a dashboard with charts (Brain), the skeleton should roughly match the layout of the actual content (chart placeholder, stat cards, etc.).

**Recommendation:** Create section-specific skeleton components (similar to how `PageLoader` already has `variant="card"` for denser panels).

### M8. Voice Input Button Has No Loading/Permission State

**File:** `sections/chat/ChatComposer.tsx`, `sections/chat/hooks/useChatVoiceCommands.ts`  
**Problem:** Clicking the microphone button immediately calls `startVoiceInput()`. If the browser/Tauri hasn't granted microphone permission yet, there's a delay with no feedback. The `voiceActive` state only becomes true after the microphone is actually open.

**Recommendation:** Show a "Requesting microphone…" state between the click and the `voiceActive` state. Handle permission denial gracefully with a toast explaining how to enable it.

### M9. Inconsistent Toast Positioning and Theming

**File:** `main.tsx`  
**Problem:** The global `Toaster` is hardcoded:
```tsx
<Toaster position="bottom-right" theme="dark" />
```
The `theme="dark"` means toasts are always dark-themed even in light mode. The `position="bottom-right"` may overlap with the right drawer or composer area on smaller windows.

**Recommendation:** 
- Use `theme="system"` or remove the theme prop to follow the app theme
- Consider `position="bottom-center"` to avoid right-drawer conflicts, or make it configurable

### M10. Session Sidebar Doesn't Announce Active Session to Screen Readers

**File:** `components/sidebar/SessionList.tsx`, `components/sidebar/SessionRow.tsx`  
**Problem:** While `SessionRow` has `role="menuitem"` for its context menu, the session list itself doesn't use `aria-current="page"` or equivalent to indicate the active session. A screen reader navigating the session list can't tell which session is currently open.

**Recommendation:** Add `aria-current="true"` or `aria-selected="true"` to the active `SessionRow`, and wrap the list in `role="listbox"` with `aria-label="Chat sessions"`.

### M11. ConfirmDialog Doesn't Auto-Focus the Confirm Button

**File:** `components/overlays/ConfirmDialog.tsx`, `hooks/useConfirmDialog.ts`  
**Problem:** The `useConfirmDialog` hook creates a promise-based confirm dialog. The `ConfirmDialog` component renders with `role="dialog"` but doesn't auto-focus the confirm or cancel button. For destructive actions, the cancel button should be focused by default to prevent accidental confirmation.

**Recommendation:** Add focus management: focus the cancel button on mount, or use the `useFocusTrap` hook (which is used by some other modals but not this one).

### M12. `ProxyStatusOverlay` and `BackendBootstrapGate` Have Overlapping Responsibilities

**Files:** `overlays/ProxyStatusOverlay.tsx`, `overlays/BackendBootstrapGate.tsx`  
**Problem:** Both components monitor the backend health and show error/retry UIs. `BackendBootstrapGate` gates the entire app in Tauri mode; `ProxyStatusOverlay` shows a modal overlay when the connection drops. The logic for "materializing" phase handling is duplicated (`MATERIALIZING` Set is defined in both files). If one is updated, the other may drift.

**Recommendation:** Consolidate into a single `BackendHealthProvider` that exposes status via context/hook, and have both UI consumers read from it.

---

## 🟢 Low Issues

### L1. `styles.css` Is 60 KB — Consider Splitting

**File:** `styles.css` (2,230 lines)  
**Problem:** A single CSS file with all design tokens, component styles, animations, and responsive breakpoints. While Vite handles tree-shaking of unused styles, the file is hard to navigate and maintain.

**Recommendation:** Split into `tokens.css`, `components.css`, `animations.css`, `chat.css`, `settings.css`.

### L2. `SessionList` Has Inline `localStorage` Access for Pinned Sessions

**File:** `components/sidebar/SessionList.tsx`, line 10  
**Problem:** `const STORAGE = (() => { try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]") as string[]; } catch { return []; } })();` — This runs at module evaluation time (not inside a hook), which means:
1. It runs during SSR/hydration mismatch if ever server-rendered
2. It's not reactive — changes to pinned sessions in another tab won't update

**Recommendation:** Move to a Zustand store with `localStorage` persistence (like the sessions store already does).

### L3. ChatEmptyState Header Text Is Truncated on Narrow Windows

**File:** `sections/chat/ChatEmptyState.tsx`  
**Problem:** The "What should we build in {project}?" heading uses `text-2xl` with no responsive sizing. On narrow Tauri windows (< 800px), this may wrap awkwardly or overflow.

**Recommendation:** Use `text-xl sm:text-2xl` for responsive sizing, or truncate the project name with `max-w-[200px] truncate`.

### L4. `Backdrop` Blur Can Cause Performance Issues on Low-End GPUs

**File:** `components/overlays/Backdrop.tsx`  
**Problem:** `backdrop-blur-sm` (5px Gaussian blur) is GPU-intensive on some hardware, especially when layered (command palette over onboarding tour over bootstrap gate).

**Recommendation:** Use `will-change: backdrop-filter` or consider a semi-transparent overlay without blur for performance-sensitive contexts.

### L5. No Keyboard Shortcut to Switch Between Sessions

**File:** `App.tsx` (global hotkeys)  
**Problem:** Global hotkeys cover Cmd+K (palette), `?` (shortcuts), `,` (settings). There's no shortcut to cycle through sessions (e.g., Cmd+1-9 or Cmd+[/]). Power users working with multiple sessions must use the mouse.

**Recommendation:** Add Cmd+↑/↓ or Cmd+1-9 session switching shortcuts.

### L6. `useStickToBottomScroll` Creates a New Controller Instance Per Call

**File:** `sections/chat/hooks/useSessionStream.ts`  
**Problem:** Every setter callback (setMessages, setToolProgress, etc.) creates a `new SessionStreamController(sessionId)` on each invocation. While lightweight, this is unnecessary allocation in a hot path (called on every SSE event during streaming).

**Recommendation:** Memoize the controller instance with `useMemo` or store it in a ref.

### L7. No Dark/Light Mode Transition Animation

**File:** `lib/theme.ts`, `store/theme.ts`  
**Problem:** Theme switching is instant — all colors snap to the new theme in one frame. This can be visually jarring, especially for large surfaces.

**Recommendation:** Add a brief CSS transition (`transition: background-color 200ms, color 200ms`) during theme changes, then remove it after the transition completes.

### L8. `useEffect` Cleanup Functions Sometimes Don't Clean Up

**File:** `sections/chat/ChatThread.tsx`, line ~380 (Tauri drag-drop listener)  
**Problem:** The Tauri `onDragDropEvent` listener is set up in an async `import()` callback. If the component unmounts before the import resolves, `unlisten` is still `undefined` and the cleanup function does nothing:
```tsx
let unlisten: (() => void) | undefined;
void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
  unlisten = await getCurrentWindow().onDragDropEvent(...);
});
return () => { unlisten?.(); };
```

**Recommendation:** Track a mounted ref and skip the listener setup if unmounted, or use an AbortController pattern.

---

## Positive Observations (What's Working Well)

1. **Section-level error boundaries** (`SectionBoundary`) prevent one crashed section from taking down the entire app — excellent resilience pattern
2. **Virtualized message list** kicks in at 40+ messages with `@tanstack/react-virtual` — smart threshold
3. **Stick-to-bottom scroll** uses smooth rAF lerp with user-intent detection (wheel/touch events) — polished behavior
4. **Lazy route loading** with Suspense boundaries keeps the chat shell on the critical path
5. **Design token system** (60 KB CSS with CSS custom properties) supports light/dark themes and user customization
6. **Focus trap hook** (`useFocusTrap`) is well-implemented with proper Tab cycling and restore
7. **Confirm dialog pattern** (`useConfirmDialog`) replaces `window.confirm()` with styled, promise-based dialogs
8. **BackendBootstrapGate** with graceful degradation phases (normal → slow → critical) is thoughtful UX
9. **Offline queue** with auto-flush and manual "Send now" is a solid resilience feature
10. **Model handoff** during streaming (stop → summary → switch → auto-continue) is a sophisticated UX flow

---

## Priority Matrix

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| 🔴 C1 | ChatThread god component | High (2-3 weeks) | High — affects all future development |
| 🔴 C2 | ChatComposer prop explosion | Medium (1 week) | High — affects all composer changes |
| 🔴 C3 | Four competing model pickers | Medium (1 week) | High — user confusion |
| 🟠 H1 | Missing aria-labels | Low (1 day) | High — accessibility compliance |
| 🟠 H2 | Dropdown keyboard navigation | Medium (3-5 days) | High — keyboard-only users |
| 🟠 H3 | Backdrop lacks focus trap | Low (1 day) | High — modal accessibility |
| 🟠 H4 | ErrorBoundary reload | Low (1 day) | Medium — data loss |
| 🟠 H5 | No backend-down indicator | Low (2 days) | Medium — silent failures |
| 🟠 H6 | Console pollution | Low (1 day) | Low — developer experience |
| 🟠 H7 | Settings bundle size | Medium (3 days) | Medium — load time |
