# Current-state audit — design tokens, theming, icons, update flow, Tauri shell, tooling, motion

Stage 1 evidence for the 2026-10-03 UI/UX refactor spec. Read-only audit by a subagent on
2026-10-03 of `C:\Dev\august-proxy\frontend\desktop`. All paths relative to
`frontend/desktop/`; line numbers 1-based as read that day. Includes a verification pass over
the claims in `docs/plans/AUGUST-UI-ENHANCEMENTS.md` (several corrected — see the closing note).

---

# August Proxy Desktop — Current-State UI Audit (tokens, theming, icons, update flow, Tauri shell, tooling, motion)

## 1. Token inventory (`src/styles/tokens.css`)

**Application mechanism.** Dark/light is an `html.dark` class (`tailwind.config.cjs:2` `darkMode: 'class'`), toggled by `applyTheme()` in `src/lib/theme.ts:54-67`; resolved mode persisted to localStorage key `august.theme`. `system` mode follows the OS live via a `matchMedia('(prefers-color-scheme: dark)')` listener (`theme.ts:108-120`). `hydrateTheme()` runs synchronously before React mounts (`src/main.tsx:46`) to prevent FOUC, with a pre-CSS background painted in `index.html:10-14` (dark `#0e0e10`, light `#fbfbfa` under `prefers-color-scheme`). UI selector: Settings → Appearance (`src/sections/settings/AppearanceSection.tsx:57-59` — Light / Dark / System). Default is **dark** (`theme.ts:20,55`). Text size is a `data-text-size` attribute on `<html>` (`theme.ts:80`), also pre-hydrated.

**Surface tiers** (`:root` light / `.dark`):
| Token | Light | Dark |
|---|---|---|
| `--dt-background` | `#fbfbfa` (tokens.css:20) | `#0F0F0F` (:133) |
| `--dt-card` | `#ffffff` (:32) | `#171717` (:140) |
| `--dt-muted` | `#f4f4f3` (:36) | `#1E1E1E` (:144) |
| `--dt-popover` | `#ffffff` (:40) | `#1A1A1A` (:148) |
| `--dt-elevated` | `#ffffff` (:44) | `#232323` (:152) |
| `--dt-sidebar` | `#f8f8f7` (:90) | `#141414` (:186) |
| `--dt-border` / `--dt-input` | `#ececea` / `#dededa` (:55,57) | `#262626` / `#2A2A2A` (:163,165) |

**Foreground tiers** — `--dt-fg-1/2/3` light `#1c1c1e / #4a4a52 / #6b6b70` (:29-31), dark `#f0f0f0 / #c8c8cc / #a6a6a6` (:137-139). The comments claim ~15:1 / ~7:1 / ~4.5:1; computed WCAG ratios (verified by calculation): **light 16.43 / 8.48 / 5.12 vs background; dark 16.82 / 11.49 / 7.87 vs background, 7.36 vs card**. The claim is accurate (actual values exceed the stated targets; nothing fails). Exposed as `text-tier-1/2/3`, `[data-tier]` (tokens.css:275-280) and Tailwind `tier` colors (`tailwind.config.cjs:41-45`).

**Accent** — `--dt-primary` `#2f6df6` light / `#6f9bff` dark (:47,155), ring matches. **Status** — destructive/success/warning/info/danger each with `-fg` companions (:61-70 light, :169-178 dark). **Code** — inline, block bg/fg (:73-75), plus theme-invariant `--dt-code-surface-*` for highlighted code/diffs (:78-87; same in both themes because highlight.js supplies a dark theme). **Elevation** — exactly 4 rungs `--elev-flat/ring/raised/overlay` (:116-119), consumed as `shadow-elev-*` (`tailwind.config.cjs:95-100`) and by `<Surface>`; `shadow-soft`/`shadow-overlay` alias the same vars (:105-106).

**Text-size presets** — exactly 4: `compact/default/comfortable/spacious` at 0.92/1.00/1.08/1.18 × 16px (tokens.css:197-200), union `TextSize` in `theme.ts:9`.

**Fonts** — Inter Variable + JetBrains Mono **bundled locally** via `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` imported at `src/main.tsx:2-3`; no font files in repo source, no `@font-face` of our own, no remote loading. CSP enforces this: `font-src 'self' data:` (`src-tauri/tauri.conf.json:27`). Font stacks registered in `tailwind.config.cjs:47-65` and `tokens.css:213,228`.

**Is light mode maintained?** Nominally yes — full light token set, light selectable in UI, `index.html` paints light pre-CSS. In practice it is **second-class**: only 29 `dark:` variants exist in all of `src` (hardcoded dark surfaces render unchanged in light mode — see §2), raw Tailwind `*-400` status colors that fail contrast on white appear in 52 files (green-400 on white = **1.74:1**, red-400 2.77:1, amber-400 1.67:1), and `THEME_PRESETS` in `src/lib/ui-customization.ts:178` is documented as "hand-tuned dark palettes" — the UI Designer presets have no light counterparts.

## 2. Token leakage (hex/rgba outside tokens.css + code.css)

`scripts/check-design.mjs` ratchets hexes in `.ts/.tsx` only (CSS partials are not scanned) and today **345 hex occurrences are baselined**, i.e. grandfathered, not fixed. Verified per-file top offenders (from `--list`):

| File | Hex count | Note |
|---|---|---|
| `src/lib/tool-icon.ts` | 77 | brand-color map (semi-legitimate) |
| `src/lib/file-icon.ts` | 70 | brand-color map |
| `src/lib/ui-customization.ts` | 53 | THEME_PRESETS user palettes |
| `src/sections/settings/FeatureFlowCanvas.tsx` | 28 | **not in prior doc** — dark-tuned canvas (`:166,179` `rgba(0,0,0,0.5)` shadows; `:294-295` `rgba(255,255,255,0.03)` grid; `:313` `rgba(0,0,0,0.45)`) |
| `src/lib/bot-avatar.ts` | 16 | deterministic avatar palette |
| `src/components/shell/BottomTerminalDock.tsx` | 5 | `#181818` at :183,:316,:393 + `#d4d4d4` :184,:185 |
| `src/components/shell/RightDrawerTerminalSection.tsx` | 4 | `#181818` :139,:333,:377 + `#e5e7eb` :140 |
| `src/components/shell/CircuitSchematicEditor.tsx` | 5 | `#334155`/`#475569` :18-19, `#fdfdfb` :367, `#2563eb` :380, `#0f172a` :411 |
| `src/components/workspace/WorkspaceDonut.tsx` | 8 | chart palette |

Prior-doc claims — verified with corrections:
- `BottomTerminalDock.tsx` `#181818`: confirmed at **:183, :316, :393** (3 in this file, not 4; 3 more live in RightDrawerTerminalSection).
- `RightDrawerFileSection.tsx` :37 `bg-[#171717]`, :88 `bg-[#111]`, :105 `dark:bg-[#111]` — all confirmed. :37 and :88 have **no `dark:` prefix**, so light mode renders dark previews.
- `DiffView.tsx:6-8,284,286` — confirmed: comment documents `rgba(248,113,113,0.09)` / `rgba(74,222,128,0.09)` and lines 284/286 apply them as inline `backgroundColor` with **no light-theme inverse**; also `:280` uses raw `text-zinc-300`. Duplicates the existing `--dt-code-added/removed-wash` tokens (tokens.css:83,86), which this file ignores.
- `WorkspaceTrendChart.tsx:280` `#1a1c20` — confirmed; plus an additional `#18181b` at **:221** (not in prior doc).
- `CircuitSchematicEditor.tsx:367` `bg-[#fdfdfb]` — confirmed.
- rgba-without-light-inverse: `UpdateProgressBar.tsx:60` (white shimmer gradient) and `:68` (black drop-shadow) — confirmed; `RightDrawerBrowserSection.tsx:128` (`rgba(0,0,0,0.8)` drop-shadow) — confirmed; `BackendBootstrapGate.tsx:189` (`rgba(255,255,255,0.04)` radial) — confirmed.
- **New:** `src/sections/settings/FeatureFlowSection.tsx:289` `shadow-[...rgba(239,68,68,0.15)]`.

Separate leak class — **raw Tailwind status palette instead of `--dt-*` status tokens**: 52 files use `text-green|red|amber|emerald|yellow|blue-3xx/4xx/5xx` (e.g. `src/sections/settings/UpdateSection.tsx:77,82,89,232,248,252-254`; `src/components/overlays/BackendBootstrapGate.tsx:196,202`). The four status `-400`s fail AA on light backgrounds outright.

## 3. Type scale

- `text-[NNpx]`: **0 occurrences** — the px-type ratchet is at zero.
- `text-3xs` (0.625rem = 10px): **441 occurrences in 135 files** (`tailwind.config.cjs:87-88`). Prior doc said 134 — now 135.
- `text-2xs` (0.6875rem = 11px): **373 occurrences in 128 files** (config :89-90). Prior doc said 127 — now 128.
- Both rungs sit below Tailwind's `text-xs` and overlap heavily in use (e.g. same metadata rendered at both — `NotificationsPanel.tsx:172` uses `text-3xs` for the byte counter while `UpdateSection.tsx:196` uses `text-2xs` for the identical string). Densest remaining scale inconsistency: two 10-11px rungs used interchangeably across 130+ files.

## 4. Icon inventory

- **lucide-react**: 203 files import it.
- **react-icons**: exactly **6 files** confirmed — `src/components/overlays/SwitchAccountModal.tsx`, `src/sections/settings/AccountSection.tsx`, `src/sections/settings/IntegrationCard.tsx`, `src/sections/settings/integrations/brandIcons.tsx`, and the two barrel imports `src/lib/file-icon.ts:29` and `src/lib/tool-icon.ts:37` (`from 'react-icons/si'`), both confirmed pulling many dozens of Simple Icons.
- **Hand-rolled inline `<svg>`** — 15 sites total. The 9 delete candidates all confirmed: `sections/chat/ChatMarkdown.tsx:64` (raw HTML string injected into markdown, not even JSX), `components/chat/DisclosureRow.tsx:58`, `components/overlays/ModelPickerDropdown.tsx:179,195,312`, `sections/chat/message/AssistantMessageActions.tsx:67`, `sections/chat/message/UserMessageBubble.tsx:160,171,189`, `sections/chat/composer/ComposerAttachmentChips.tsx:42`. Keepers confirmed: `sections/chat/ChatEmptyState.tsx:48` (hero glow, has `dark:` variant), `sections/chat/ContextRing.tsx:169` (parametric ring), plus chart graphics `components/workspace/WorkspaceDonut.tsx:90`, `WorkspaceTrendChart.tsx:149`, `components/shell/CircuitSchematicEditor.tsx:364`.
- **`size={N}` prop distribution**: 14×16, 10×5, 13×3, 11×3, 48×2, 28×2, 16×2, 15×2, 12×2, then singles: **72** (`components/sidebar/BotsRail.tsx:689` bot avatar), **60** (`components/sidebar/BotCreateModal.tsx:225`), 40, 32, 20, 18, 17, **15** (`components/shell/RightDrawerFileSection.tsx:342`, `RightDrawer.tsx:249`), **13** (FileIcon in `ChangesCard.tsx:258`, `EditRailRow.tsx:136`, `RightDrawerDiffSection.tsx:216`), **10** (`ToolCallItemBody.tsx:231,244,246`; `ToolCallCard.tsx:127,129`). The odd sizes (10/13/15/17) are all confirmed live.
- **Class channel**: `size-3` exactly **384×** (confirmed), `size-3.5` **370×** (confirmed), `size-4` 139×, `size-11` 6× (avatars), `h-N w-N` pairs 21× in components. Two parallel sizing vocabularies (prop vs class) plus a long tail of magic numbers.
- **strokeWidth**: set in only **10 places**, all hand-rolled SVGs — `2` (8×), `1.5` (1×), `2.2` (1×). Lucide defaults to 2 everywhere else, so it is consistent by default rather than by policy; the 1.5/2.2 outliers are in the inline SVGs slated for deletion.

## 5. shadcn inventory (`src/components/ui/` — 15 files)

| File | What it is | Importers |
|---|---|---|
| `avatar.tsx`, `badge.tsx`, `button.tsx`, `card.tsx`, `collapsible.tsx`, `dropdown-menu.tsx`, `input.tsx`, `skeleton.tsx` | shadcn vanilla (Radix-based) | 4 / 27 / 46 / 13 / 1 / 2 / 11 / 4 |
| `task.tsx` | vendored shadcn-style Task block; **customized** — `task.tsx:65` default trigger is a `<div className="...cursor-pointer">` not a `<button>`: no role, no keyboard activation, no focus ring (raw-button rule doesn't even flag it because it's inside `ui/`'s exclusion) | 2 |
| `user-dropdown.tsx` | app-specific (user menu, action enum incl. `'whats-new'` at :48/:127/:173) | 2 |
| `FileIcon.tsx`, `ToolIcon.tsx`, `MarqueeTitle.tsx`, `UpdateProgressBar.tsx`, `Surface.tsx` | app primitives, not shadcn | 8 / 3 / 3 / 3 / **0** |
- **`Surface.tsx` is dead** — zero importers outside itself, despite tokens.css:113 and the tailwind config comment telling developers to use it for the elevation ladder.
- `collapsible.tsx` is imported only by `task.tsx`, so the Task block is its only consumer.

## 6. Update flow end-to-end

**Phase machine** — `AppUpdatePhase = 'idle' | 'downloading' | 'ready' | 'installing' | 'restarting'` (`src/store/app-update-install.ts:7`). Sole writer is `useAppUpdate` (`src/hooks/useAppUpdate.ts`): `downloading` (:176,:193,:238,:241), `ready` (:113,:205-210,:254-260), `restarting` (:141,:151), `idle` via `reset()` (:37). **`'installing'` is never written anywhere** — it is a dead union member, read at 10 sites: `UpdateProgressBar.tsx:21,42`; `UpdateRelaunchOverlay.tsx:27,42,137`; `UpdateSection.tsx:132,173,182,188`; `NotificationsPanel.tsx:159,164` (all prior-doc sites confirmed; `useBackendSetup.ts:14` and `BackendBootstrapGate.tsx:20` are a different, unrelated `installing`). Side effect: during `restarting`, `UpdateRelaunchOverlay.tsx:38-42`'s pill ternary falls through to text **"installing"** — the restarting state is mislabeled in its own status pill.

**Rust contract** (`src-tauri/src/backend.rs`, registered `lib.rs:128-133`): `stop_backend_for_update` (:1801, 3 JS-side retries with 400 ms backoff, continues on failure — `useAppUpdate.ts:54-68`); `schedule_post_update_relaunch` (:1817, non-Windows only path); `download_release_installer` (:1976) streams the GitHub release asset into `{temp}/august-updates/`, verifies its minisign signature, rejects files <1 MB, emits `update-download-progress { downloadedBytes, totalBytes }` throttled to 150 ms (:2019); `cancel_update_download` (:2116); `downloaded_installer` (:2158) returns a previously downloaded file only when it exactly matches what `download_release_installer` would write; `launch_installer_and_exit` (:2188).

**Plugin vs custom flow.** `tauri.conf.json:55-66` configures the updater plugin (pubkey :58, endpoint `…/releases/latest/download/latest.json` :60, `windows.installMode: "quiet"` :63); the dialog plugin is registered (`lib.rs:47`; capabilities grant `updater:default`, `dialog:default`). On **Windows the plugin install path is not used**: `check()` supplies metadata, but the artifact is fetched by the custom command and applied by running the NSIS setup exe interactively (`useAppUpdate.ts:131-146`), so `installMode: quiet` is effectively inert on Windows; the plugin `update.install()` + relaunch path (:148-161) serves non-Windows only. Bundle targets are msi+nsis (`tauri.conf.json:32-35`).

**Where checks trigger** — `queryKey: ['app-update']`, `staleTime` 30 min, `refetchOnWindowFocus` (`useAppUpdate.ts:92-99`). `useAppUpdate()` is mounted by `WorkspaceShell.tsx` (i.e. at app start), `NotificationsPanel`, `SessionList.tsx:121`, `UpdateSection` (About page), `UpdateRelaunchOverlay`. A stale downloaded installer is re-surfaced as "Restart to update" after restart (:103-119). No automatic download; a "check failed" is now distinct — **the prior-doc claim that UpdateSection:88-92 shows "up to date" after failure is stale**: the error branch renders first (`UpdateSection.tsx:76-80`). Residual failure-path gap: **download/install failures are toast-only** (`useAppUpdate.ts:213,263; :165`) and `resetInstall()` returns the status row to amber "A new update is ready" with no inline error.

**Release notes** — rendered as a raw `<pre className="whitespace-pre-wrap ...">` inside a `max-h-32` scroll box at **`UpdateSection.tsx:101-107`** (the prior doc's `useAppUpdate.ts:47-49` location is wrong — that's just the check return). No markdown rendering; `WhatsNewModal`/NotificationsPanel never show the body as markdown either (`NotificationsPanel.tsx:84` uses `update.body?.trim()` as plain text).

**`WhatsNewModal.tsx` (218 lines) is NOT dead** — prior claim wrong. Reachable: `user-dropdown.tsx:173` "What's new?" menu item → action `'whats-new'` → `SessionList.tsx:171` `setWhatsNewOpen(true)` → rendered `SessionList.tsx:785`. It feeds on `GET /api/whats-new` (`NotificationsPanel.tsx:72`).

**`readyDismissed`** is `useState` (`UpdateRelaunchOverlay.tsx:22`) — confirmed. It resets to false whenever `ready` flips (:32-34) and does not survive overlay remount; the progress store itself is memory-only, so nothing persists across a restart beyond the `downloaded_installer` re-surface path.

**Cancel affordances** — Cancel exists only in the overlay while downloading (`UpdateRelaunchOverlay.tsx:162-171`, backed by `cancel_update_download` + `update.close()`, `useAppUpdate.ts:268-277`). `UpdateSection` has **no Cancel** during download; once `ready`, the only escape is the "Later" X (:172-183), which is dismissal, not cancellation. During `restarting` nothing is cancelable (acceptable).

## 7. Tauri shell

- Window: `decorations: false` (`tauri.conf.json:22` — confirmed), `backgroundColor #0e0e10` :23, 1280×800 min 960×600. Custom titlebar painted in-app; the pre-CSS background in `index.html:10-14` exists to hide the native hairline.
- CSP (`tauri.conf.json:27`): `default-src 'self'`, `style-src 'unsafe-inline'`, `connect-src` limited to `127.0.0.1:*` http/ws, `img-src 'self' data: blob:`, `font-src 'self' data:` — **remote assets are impossible**, consistent with bundled fonts/icons.
- Close routing: `CloseRequested` → `prevent_close()` → `show()`+`set_focus()` → `emit('quit-requested')` (`lib.rs:112-117` — confirmed); UI confirm modal → `confirm_quit` command (`lib.rs:22-26`) stops the backend then `exit(0)`. Hide-to-tray only from the tray menu (:111 comment).
- Single instance: **custom file-lock** `acquireInstanceLock` (`backend.rs:253-266`), not `tauri-plugin-single-instance`; second launch logs and exits.
- Tray: `tray.rs` — Show / Hide / Quit (`tray.rs:1-48`). No deep-link plugin (Cargo.toml:17-21 lists only clipboard/process/shell/updater/dialog). WebView2 default context menus disabled (`lib.rs:96-105`); AppUserModelID set for Task Manager grouping (:35-40).
- `backend.rs` recursive deletes: the only production `remove_dir_all` is inside `wipeStaleTreeWith` (`backend.rs:586`, wrapper `wipeStaleTree` :572); all others (:2556+) are under `#[cfg(test)]`. Matches the AGENTS.md guarantee (refuses targets outside `backend-runtime/`).
- Backend boot UI: `BackendBootstrapGate.tsx` gates the whole app on `proxyUp && convDone` (:159), shows a full-screen `bg-background` with a chat-style `LaunchConversation` while booting (:229), an error card with Retry (:190-226), and the `rgba(255,255,255,0.04)` radial leak at :189.

## 8. Design tooling

- **`scripts/check-design.mjs`** (repo root) — 5 rule families: `px-type` (`text-[Npx]`), `hex-color` (6/8-digit), `raw-button` (excludes `src/components/ui/`), `raw-fetch` (excludes `src/api/`), `inline-style` (`style={{`). It is a **ratchet** against `scripts/design-baseline.json`, keyed `path:match` without line numbers. **Passes today**: `[check-design] ok — no new design drift (496 baselined: px-type=0 hex-color=345 raw-button=527 raw-fetch=2 inline-style=115)`. Two observations: 527 raw `<button>`s grandfathered despite the Button primitive (46 importers), and CSS files are entirely unscanned, so stylesheet hexes/rgba are outside the net.
- **`e2e/design-smoke.spec.ts`** — confirmed: 3 routes (`/`, `/automations`, `/settings` :16), one axe scan each, **gates CRITICAL only** (:26; serious logged, non-gating :33-36), runs in web/Vite mode with a 1.5 s settle and explicitly accepts offline states (:22-24), serial mode. No backend required — all confirmed.

## 9. Motion

- **Documented scale**: `src/lib/motion.ts` — easings `easeOut`/`easeInOut`, transitions `t.fast` 0.12 s / `t.base` 0.18 / `t.smooth` 0.24 / `t.spring` (380/32) / `t.springSoft` (220/26), `PANEL_MS` 0.18, plus `fadeUp` and other variants. Intended as "one place to tune the feel".
- **Reduced motion**, three coordinated layers: `MotionConfig reducedMotion="user"` at the root (`main.tsx:61`); the single sanctioned hook `useReducedMotion` (`lib/motion.ts:22-32`, read-once caveat documented); CSS `@media (prefers-reduced-motion: reduce)` blocks (6 in `styles/chat.css` :48,:219,:233,:520,:686,:1075) plus the in-app `data-reduce-motion='1'` kill-switch that zeroes all animation/transition durations (`styles/motion.css:66-73`). Coverage is unusually thorough.
- **Actual usage drifts from the scale**: Tailwind channel is dominated by bare `transition` (360×), `transition-colors` 85, `transition-transform` 27, `transition-opacity` 15, `transition-all` 12; durations cluster on `duration-150` (25) / `duration-200` (16) with a tail of 100/300/75. Meanwhile overlays hand-roll springs instead of using presets — `UpdateProgressBar.tsx:55` (spring 140/26/0.55), `UpdateRelaunchOverlay.tsx:82` (spring 280/28), `ChatEmptyState.tsx:44` (inline cubic-bezier). No enforcement ties these to `lib/motion.ts`.

---

## Consolidated findings

### (1) Inconsistencies
- `components/chat/DiffView.tsx:284,286` (+`text-zinc-300` :280) — hand-rolls diff wash colors that already exist as `--dt-code-added/removed-wash` (`src/styles/tokens.css:83,86`).
- Raw Tailwind status palette (`text-green|red|amber|emerald-4xx`) in **52 files** alongside the sanctioned `--dt-*` status tokens — e.g. `src/sections/settings/UpdateSection.tsx:77,82,89,232,248,252-254`; `src/components/overlays/BackendBootstrapGate.tsx:196,202`.
- Two overlapping micro type rungs used interchangeably: `text-3xs` (135 files) vs `text-2xs` (128 files) — same metadata rendered at both, e.g. byte counter `src/components/overlays/NotificationsPanel.tsx:172` (`text-3xs`) vs `src/sections/settings/UpdateSection.tsx:196` (`text-2xs`).
- Icon sizing has three vocabularies: `size-3` 384× / `size-3.5` 370× classes, `size={N}` props with magic values 10/13/15/17/60/72, and 21 `h-N w-N` pairs.
- Motion presets exist (`src/lib/motion.ts`) but overlays hand-roll springs: `UpdateProgressBar.tsx:55`, `UpdateRelaunchOverlay.tsx:82`; duration tail 75/100/300 outside the implicit 150/200 convention.
- 527 raw `<button>` elements baselined while `components/ui/button.tsx` has only 46 importers — the primitive and the practice disagree.
- `scripts/check-design.mjs` scans only `.ts/.tsx` — all stylesheet hexes/rgba (chat.css, settings.css, etc.) escape the hex rule.

### (2) Dead UI / hardcoded or fake status
- `AppUpdatePhase` member `'installing'` (`src/store/app-update-install.ts:7`) is written by nobody; 10 read sites keep dead branches alive (`UpdateProgressBar.tsx:21,42`; `UpdateRelaunchOverlay.tsx:27,42,137`; `UpdateSection.tsx:132,173,182,188`; `NotificationsPanel.tsx:159,164`).
- `UpdateRelaunchOverlay.tsx:38-42` — during `restarting` the status pill reads "installing" (fall-through ternary), mislabeling the one state users actually see at the end.
- `components/ui/Surface.tsx` — 0 importers; the elevation-ladder primitive the tokens comment points to is dead code.
- `components/sidebar/SessionList.tsx:168` — "download" menu action answers with a canned toast "You're already in the desktop app" (fake affordance).
- `tauri.conf.json:63` `windows.installMode: "quiet"` — inert on Windows, where the custom NSIS wizard flow (`useAppUpdate.ts:131-146`) is used instead.
- Hardcoded dark surfaces with no light inverse (render dark in light mode): `RightDrawerFileSection.tsx:37,88`, `BottomTerminalDock.tsx:183,316,393`, `RightDrawerTerminalSection.tsx:139,333,377`, `WorkspaceTrendChart.tsx:221,280`, `FeatureFlowCanvas.tsx:166,179,294-295,313`.
- THEME_PRESETS (`src/lib/ui-customization.ts:178+`) — dark-only palettes in a UI that sells a light mode.

### (3) Accessibility gaps
- Raw Tailwind `*-400` status text fails contrast in light mode: green-400 1.74:1, amber-400 1.67:1, red-400 2.77:1 on white (52 files; the `--dt-success-fg` etc. tokens exist precisely for this).
- `components/ui/task.tsx:65` — collapsible trigger rendered as a `<div>`: no button role, no keyboard activation, no focus ring (inside the `ui/` exclusion, so invisible to the raw-button gate).
- `UpdateSection.tsx:101-107` — release notes as raw `<pre>` of unrendered markdown; long bodies truncated at `max-h-32` with no "open full notes" affordance (only an external-link).
- `e2e/design-smoke.spec.ts:26` — axe gates **critical only**; serious violations are logged and tracked by eye (deliberate, but leaves the known 400-color failures ungated in light mode, which axe on dark defaults may never surface).
- `UpdateSection.tsx` has no Cancel during download (Cancel only in `UpdateRelaunchOverlay.tsx:162-171`); keyboard users on the About page cannot abort a large download.
- Light-mode contrast tier system (`--dt-fg-3` 5.12:1) is fine, but the 29 total `dark:` variants mean light mode inherits dark-tuned washes (rgba black shadows in `FeatureFlowCanvas.tsx:166,179,313,362`) rather than token-derived ones.

**Prior-doc corrections**: WhatsNewModal is reachable (user-dropdown → SessionList:171/785); UpdateSection error-vs-up-to-date was fixed; release-notes `<pre>` lives at UpdateSection.tsx:101-107, not useAppUpdate.ts:47-49; text-3xs/2xs counts are now 135/128 files; `#181818` is 3× per terminal file, not 4× in BottomTerminalDock; contrast-tier claims verified accurate (actual ratios exceed stated targets).
