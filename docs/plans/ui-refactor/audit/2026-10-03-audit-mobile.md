# Current-state audit — mobile companion (frontend/mobile)

Stage 1 evidence for the 2026-10-03 UI/UX refactor spec. Read-only audit by a subagent on
2026-10-03 of `C:\Dev\august-proxy\frontend\mobile`. Line numbers 1-based as read that day.

---

# Mobile app audit — `frontend/mobile` (Expo / React Native companion)

## 1. Architecture — what it actually is

The app is a **single-screen WebView wrapper, exactly 383 lines**, with no screens, no navigation, and no native feature UI. Every product surface is the desktop SPA served by FastAPI and rendered inside `react-native-webview`.

- `App.tsx:159-284` — the entire app component: one `KeyboardAvoidingView` (181), one `WebView` bound to `source={{ uri: proxyUrl }}` (186-217), a loading pill overlay (219-226), and a native error/fallback card (228-281). Nothing else. There is no router; `scripts/audit-mobile-parity.js:96-102` **bans** `@react-navigation/*` and `react-native-screens` as dependencies, and `src/` does not exist (no other TS source files).
- Prior-doc claims verified with precision:
  - **"~60 lines of injected CSS (App.tsx:21-83)"** — confirmed: `MOBILE_WEB_BOOTSTRAP` is exactly lines 21-83, a JS string injected via `injectedJavaScriptBeforeContentLoaded` (App.tsx:199) that sets a `data-august-mobile-shell` attribute (23), rewrites the viewport meta (25-31), and appends a `<style>` block of ~20 CSS rules (33-64).
  - **"targets ~15 desktop class names"** — confirmed at App.tsx:43-61: `.bottom-nav`, `.tab-bar`, `[data-mobile-bottom-nav]`, ~12 `[class*="purple|violet|indigo"]` attribute selectors, `.accent-violet`, `.accent-indigo`, `.dashboard-shell`, `.dashboard-main`, `.dashboard-section`, `.surface`, `.subtle-surface`, `.card-hover`, `.period-btn`, `button[onclick="loadModels()"]`, `.overflow-x-auto`, `#voicePanel`.
  - **"second hand-copied token set (App.tsx:85-126)"** — confirmed: `ShellColors` type + `getShellColors()` return exactly 10 hand-coded hex values per mode (dark: 100-112, light: 114-125), unrelated to the desktop's `--dt-*` tokens (`frontend/desktop/src/styles/tokens.css:19+`).
- **No icons, no vector library**: `@expo/vector-icons` is not a dependency (`package.json:5-12`); the only native "graphic" is an `ActivityIndicator` (App.tsx:222).
- Staleness timeline: App.tsx last changed **2026-08-12** (`git log -- frontend/mobile/App.tsx` → bf8beab3); the desktop React `sections/` tree last changed **2026-10-02** (4fb9a00c), and `tokens.css` comments date the current token system to 2026-09-16. The mobile layer predates the entire current desktop UI.

## 2. Connectivity

- **URL config** — `EXPO_PUBLIC_PROXY_URL` env override, else default derived from Expo `hostUri` via `Constants` (App.tsx:135-157): a LAN host from the dev-client manifest becomes `http://<host>:PORT`; Android emulator falls back to `http://10.0.2.2:PORT` (152-154); otherwise `http://localhost:PORT`. Port from `EXPO_PUBLIC_PROXY_PORT`, default `8085` (App.tsx:19). `normalizeProxyUrl` trims trailing slashes and prepends `http://` when scheme missing (128-133).
- **Auth** — none. The WebView loads the root URL directly (App.tsx:189) and the backend serves the SPA with no auth: `backend-py/app/main.py:520-541` mounts `/assets` and a 404 `spaFallback` returning `index.html` for any non-`/api`/`/v1` path. The only bearer-token check in the backend is the automations webhook (`app/routers/automations.py:288`), unrelated.
- **What it loads** — the full desktop SPA (`/` → `web-dist/index.html`). The parity audit's live section confirms the intended API reachability surface: `/api/health`, `/api/config/safe`, `/api/stats`, `/api/requests`, `/api/workbench/sessions|capabilities|agents`, and a workbench session/goal create-status-clear roundtrip (`scripts/audit-mobile-parity.js:177-243`).
- **Unreachable-desktop states** — `onError` sets `loadError` from the event description (App.tsx:208-211); `onHttpError` sets an error only for status ≥ 500 (212-216). A native fallback card then shows: eyebrow "AUGUST PROXY", title "Connect to the web app", explanatory copy (233-236), an **editable URL input** (237-254), Reload (reloads in place) and Connect (re-key the WebView) buttons (255-275), and the truncated error text (276-278). 4xx responses do **not** surface an error — the SPA HTML loads regardless.
- `applicationNameForUserAgent="AugustProxyMobile"` (App.tsx:198) has **no consumer** anywhere in the repo.

## 3. Theming & icons

- **Two independent theming layers, neither shared with desktop:**
  1. Injected CSS: `:root { color-scheme: light dark }` (App.tsx:35) plus `.dark`-scoped overrides (App.tsx:49-51). The `.dark` hook is correct for the current desktop — `frontend/desktop/src/lib/theme.ts:60-61` toggles `classList` `dark` on `documentElement`, default mode `'dark'` (theme.ts:20) — so dark mode of the SPA content works.
  2. Native shell colors: the hand-copied set (App.tsx:98-126) driven by RN `useColorScheme()` (App.tsx:161), used for loading/fallback chrome and WebView background only.
- **De-branding overrides still partially live**: light mode force-zincs any Tailwind `purple|violet|indigo` class (App.tsx:44-48, gradient overrides 47, accent bars 48). Six desktop files still emit such classes (`frontend/desktop/src/components/shell/RightDrawerTasksSection.tsx`, `components/sidebar/RoomView.tsx`, `sections/chat/ModelPickerCard.tsx`, `sections/settings/BackendMonitorSection.tsx`, `sections/settings/HarnessImprovementsSection.tsx`, `sections/settings/MemorySection.tsx`), so these rules still bite today.
- **Icons/splash**: `assets/icon.png` is the **stock Expo SDK 54 template icon** (blue chevron with template alignment guides, verified visually; 1024×1024). `app.json:14` adaptive-icon background `#E6F4FE` is the Expo template default. `app.json` has **no `splash` key at all** — `assets/splash-icon.png` exists but is unreferenced. App name is `"mobile"` (app.json:3) — no product branding anywhere in config.
- `userInterfaceStyle: "automatic"` (app.json:8) matches the native-chrome dark handling.

## 4. Feature coverage vs desktop

Because the WebView renders the same SPA at `/`, **the user can do everything the web build does**: chat/Workbench, agents, runs, board, automations, terminal, exam, live, history, learning, settings, memory, workspace — all present as desktop sections (`frontend/desktop/src/sections/`: agents, archive, automations, board, chat, conversations, exam, history, learning, live, runs, settings, terminal, workspace). The mobile layer adds **zero product features**; it contributes only viewport forcing, safe-area bottom padding (App.tsx:54, 60), iOS 16px input font to stop focus-zoom (61), horizontal-overflow clamps (55-59), and the purple de-branding. The fallback copy says this honestly: "Mobile now runs the same dashboard and Workbench as the browser" (App.tsx:233-235).

## 5. Tests / build

- `npm run test -w frontend/mobile` **exists**: `frontend/mobile/package.json:25` → `"test": "npm run typecheck && npm run audit:parity"`. `typecheck` = `tsc --noEmit` (22) under `strict` (`tsconfig.json`). Root `package.json` has no `test:mobile` aggregate (its `test:frontend` at root line 40 targets desktop only).
- **audit:parity** (`scripts/audit-mobile-parity.js`) — static checks pass today: WebView present (90-92), old `src/api/proxy.ts` removed (93), nav deps banned (96-102), app.json settings (105-107), no `/ui/*` refs, desktop has ≥20 `/api` refs (132-133). Live HTTP checks (177-243) run only when a backend is reachable and are **skipped on ECONNREFUSED** (249-261) — so `npm test` silently covers less when the backend is off.
- **audit:visual** (`scripts/audit-mobile-visual.js`) — runs only via `verify` (package.json:26), not `test`. It is **broken against the current desktop**: it waits for `window.switchSection` (51), `[data-section]` (52-56), `#section-<name>` (61), `#workbenchInput` (85, 157), `.wb-header` / `.wb-input-pill` / `.wb-mobile-nav-btn` / `.wb-welcome-icon` / `.wb-agent-card` (104-127), `#wbMobileActionsToggle` / `#wbHeaderActions` / `#wbInfoToggle` / `#wbDrawer` (139-166). **Every one of these hooks exists in 0 files** in `frontend/desktop/src` (grep verified); the script targets the pre-React dashboard DOM.
- Expo SDK `~54.0.0`, RN 0.81.5, react-native-webview 13.15.0 (package.json:6-11); `app.json`: name/slug `"mobile"`, version 1.0.0, portrait-only, `supportsTablet: true`, `usesCleartextTraffic: true` (20), permissions `INTERNET` + `ACCESS_NETWORK_STATE` (21-24), no plugins, no splash config. Mobile `AGENTS.md:5-9` itself warns the resolved Expo version may differ from the pin.

## 6. Breakage coupling

- **The desktop-classname coupling is already broken, silently.** Grep across the whole repo: `.dashboard-shell`, `.dashboard-main`, `.dashboard-section`, `.period-btn`, `.subtle-surface`, `.card-hover`, `.accent-violet`, `.accent-indigo`, `.bottom-nav`, `.tab-bar`, `#voicePanel`, and `loadModels()` appear in **only one file — `frontend/mobile/App.tsx`**. They were written for the pre-React server-rendered dashboard and died in the 2026-06-15 desktop migration (`git log`: "chore: finish desktop migration and proxy cleanup", 4affc454). Nothing errored; the CSS just stopped matching. Of the injected rules, only three groups still do anything: `overflow-x-auto` (App.tsx:59; still a Tailwind utility in 8 desktop files), the element-selector `input/textarea/select { font-size: 16px }` (61), and the `[class*="purple|violet|indigo"]` overrides (44-51, matching the 6 desktop files above).
- **Live half of the same coupling**: if the desktop ever renames those Tailwind color utilities or adopts `--dt-*`-based classes, the de-branding silently stops working — the mobile app has no test that would notice (the visual audit that used to catch purple, `audit-mobile-visual.js:137,199-200`, is itself dead).
- **audit-mobile-parity.js live checks** hardcode response shapes (`stats.totalRequests`, `requests.completed`, goal `set/status/clear` semantics, 187-242) — a backend contract change fails `npm test` only where a backend is running.
- Minor: `Constants.expoConfig/manifest/manifest2` fallback chain (App.tsx:136-145) couples to Expo dev-client manifest shapes; `.dark` scoping couples to desktop's `theme.ts` class mechanism (currently correct).

## 7. Assessment (facts only)

- Native UI share of the codebase: ~100 of 383 lines (loading + error chrome); product surface share: 100% WebView of the desktop SPA.
- The mobile-specific layer is ~60% dead selectors, ~30% generic mobile hygiene (16px inputs, safe-area, overflow), ~10% brand-police that still works.
- No native navigation (deliberately banned by its own audit), no icons/vector library, stock Expo template icon, no splash entry, no deep links, no push, hardcoded cleartext HTTP.
- Maintenance signals: last meaningful change 2026-08-12 (two desktop restyles behind), its own visual audit is unrunnable against the current desktop, and its color set has already drifted from the desktop tokens it once mirrored.
- Consequence: the kept-but-hardened-WebView path consists almost entirely of *deletions* (dead bootstrap rules, dead visual audit) plus reconnecting the de-purple rules to something the desktop guarantees; the native-redesign path starts from zero, since there is no native UI to redesign.

## Consolidated lists

**(1) Inconsistencies**
- `frontend/mobile/App.tsx:53-61` — 11 targeted class names (`.dashboard-shell`, `.dashboard-main`, `.dashboard-section`, `.surface`, `.subtle-surface`, `.card-hover`, `.period-btn`, `.accent-violet`, `.accent-indigo`, `#voicePanel`, `button[onclick="loadModels()"]`) exist nowhere outside App.tsx — dead since the desktop React migration.
- `frontend/mobile/App.tsx:43` — hides `.bottom-nav`/`.tab-bar`; no such elements exist in `frontend/desktop/src`.
- `frontend/mobile/App.tsx:85-126` vs `frontend/desktop/src/styles/tokens.css:19-30` — two unrelated palettes already drifted (`#f7f7f5`/`#0f0f0f` vs `--dt-background: #fbfbfa`).
- `frontend/mobile/scripts/audit-mobile-visual.js:51-200` — audits a DOM (`window.switchSection`, `.wb-*`, `#wb*`) that no longer exists; `npm run verify` (`package.json:26`) cannot pass against the current desktop build.
- `frontend/mobile/scripts/audit-mobile-parity.js:187-242` — hardcoded API response shapes; live coverage silently skipped when backend unreachable (249-261).
- `frontend/mobile/app.json:3-5` — name/slug "mobile", version 1.0.0, no August branding, vs repo/desktop version 0.18.17.
- `frontend/mobile/AGENTS.md:5-9` — pinned `expo ~54.0.0` but resolved version acknowledged as uncertain.
- Prior-doc claim "App.tsx:21-83 injects ~60 lines of CSS targeting ~15 desktop class names" — region and count correct; nuance: it is a JS bootstrap string (63 lines) whose 15 selectors are almost all dead, and the "second token set (85-126)" claim is exact.

**(2) Dead UI / hardcoded or fake status**
- `frontend/mobile/App.tsx:43,53-61` — dead CSS rules listed above; `:57,66-73` targets inline-`onclick` HTML from the old server-rendered dashboard.
- `frontend/mobile/scripts/audit-mobile-visual.js` — entire script audits a nonexistent DOM (only reachable via `verify`).
- `frontend/mobile/assets/splash-icon.png` — unreferenced; `app.json` has no `splash` key.
- `frontend/mobile/assets/*.png` + `app.json:14` — stock Expo template icon set, unbranded.
- `frontend/mobile/App.tsx:198` — `applicationNameForUserAgent="AugustProxyMobile"` has no consumer in the repo.
- `frontend/mobile/app.json:20` — `usesCleartextTraffic: true` hardcoded on (dev convenience shipping unconditionally).
- `frontend/mobile/App.tsx:57` — `loadModels()` refresh-button restyling targets a button that no longer exists.

**(3) Accessibility gaps**
- `frontend/mobile/App.tsx:31` — injected `maximum-scale=1, user-scalable=no` blocks pinch zoom (WCAG 1.4.4) on all SPA content.
- `frontend/mobile/App.tsx:219-226` — "Connecting" pill: no `accessibilityLabel`, no live-region announcement.
- `frontend/mobile/App.tsx:276-278` — error text truncated to 3 lines (`numberOfLines`), no live region, no expand path.
- `frontend/mobile/App.tsx:186-217` — WebView has no `accessibilityLabel`.
- `frontend/mobile/App.tsx:38-39` — global `-webkit-user-select: none` (inputs exempted) removes text selection everywhere else.
- `frontend/mobile/App.tsx:244,231` — `colors.subtle` #71717a for placeholder/eyebrow ignores the desktop's documented 3-tier contrast policy (`tokens.css:24-29`); 11px bold eyebrow is marginal.
- Native layer contributes no reduced-motion handling (spinner overlay unconditional, App.tsx:219-226).
