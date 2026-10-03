# Reference study — DeepSeek Harness (DSH) + chat.deepseek.com

Stage 1 evidence for the 2026-10-03 UI/UX refactor spec. Produced by a research subagent on
2026-10-03 from the local install (`C:\Users\rober\AppData\Local\Programs\DeepSeek Harness`,
v0.2.0-rc.2 nightly, app.asar extracted — package READMEs are design documents), the public
chat.deepseek.com CSS bundle, and official pages. Extracted evidence cached at `%TEMP%\dshui\`
(565 files). Key discovery: **DeepSeek Harness is open source (MIT) at
github.com/deepseek-ai/deepseek-harness** — August can adopt patterns from readable source.

---

# DeepSeek Harness — UI/UX Study for August

**Scope note on naming:** "DeepSeek Harness" is today an *official product name*. Two artifacts studied:
- **A. DeepSeek Harness (DSH)** — DeepSeek's official open-source agentic desktop app (Electron; "Everything is a Plugin"). Installed locally.
- **B. chat.deepseek.com** — the consumer chat web app (PWA; login-walled beyond shell/CSS).

## 0. What this app is + exact variant studied + verification method

- **Variant A (primary): DeepSeek Harness Desktop, Windows x64, v0.2.0-rc.2, nightly channel.** Verified locally: `resources/app.asar` contains `dsh/package.json` = `@deepseek-ai/dsh-desktop-runtime`, version `0.2.0-rc.2`; `resources/app-update.yml` names publisher `CN=Hangzhou DeepSeek Artificial Intelligence Co., Ltd.` and channel `nightly`; pending update file `$LOCALAPPDATA/@deepseek-aidsh-desktop-updater/pending/deepseek-harness-0.2.0-rc.2-win-x64.exe`. Electron 44.0.0.
- It is a **local agent harness**, not a thin chat client: bundles Node 24.21.0 + Python 3.12.14 + pnpm 11.7.0 as a tool runtime (numpy/pandas/python-docx/python-pptx/openpyxl/Pillow bundled), plus `office-skills/`, `cli/`, `bin/` — the same shape as August's `backend-py` payload.
- **Open source + official**: MIT repo `github.com/deepseek-ai/deepseek-harness` ("DeepSeek Harness: Everything is a Plugin.", 242,450 stars, active 2026-10-03), docs at deepseek-harness.github.io, official page https://www.deepseek.com/en/harness/.
- **Variant B: chat.deepseek.com web** (unauthenticated only): HTML shell (title `DeepSeek`, PWA `manifest.json` `display: standalone`) and CSS bundle `https://fe-static.deepseek.com/chat/static/main.6c351450f6.css` (288,638 bytes, fetched 2026-10-03). Logged-in chat internals are **UNVERIFIED** from primary sources.
- Mobile exists (official iOS App Store id6737597349, Android APK `https://download.deepseek.com/apk/deepseek.apk`) — not installed here; mobile UI **UNVERIFIED**.
- Method: extracted all `@deepseek-ai/dsh-*` package READMEs + client bundles + shipped styles from the local asar; parsed the chat CSS; fetched official pages.

### Adopt for August
1. Treat DeepSeek's desktop harness as the closest public reference architecture to August (shell + bundled Python/Node backend) — its UI package READMEs are a design-spec goldmine.
2. Ship user-visible strings in a complete zh+en dictionary from day one.
3. Users conflate "harness" with the whole app; keep August's "harness" terminology consistent with its own docs.

## 1. Launch experience

- **Boot**: a framework-free static boot page is hydrated only after the *entire* client plugin roster settles; "the first application frame waits for every client entry" — no partial shells, no per-entry lazy mount (asar: `dsh-client-ui-renderer--README.md`).
- **Desktop onboarding (account path)**: sequential dialog flow — welcome page (mandatory "Get started") → credit page (always shown; positive balance ⇒ primary Continue / secondary "Add credits"; zero balance adds a recharge confirmation) → purpose questions (office vs development) that set preferences directly. Figma-derived illustrations as palette-compressed 3x PNGs; **headings use the bundled Montserrat brand font — Light 300, with "DeepSeek Harness" inside a heading in Medium 500** (asar: `dsh-client-ui-settings-account--README.md`).
- Onboarding forces a **960px minimum window width** while active (released after completion, not restored); completion reveals the workspace through a **180ms fade**; progress is durable in Host settings and **resumes after restart**; skip applies defaults (standard process view, compact usage, Coding Tools off) (same README).
- **API-key onboarding (non-account path)**: first-run shows a *versioned* welcome notice (re-shown when the copy version bumps; only explicit Continue records it), then a conditional API-key step rendered only if *no* provider is reachable; "Configure later" completes it. Keys are stored **write-only** (`credentials.set`), inputs use `autocomplete="new-password"` to block password autofill, and key state is a green/red solid dot on the provider row — never echoing secret material (asar: `dsh-client-ui-settings-models--README.md`).
- **Empty-state hero**: a blank Session keeps header controls and mounts an inert composer while a Workspace picker connects; selecting a Workspace creates the Session — "the first message is not required" (asar: `dsh-client-ui-conversation--README.md`).

### Adopt for August
1. Boot to a static loading page and swap to the full app in one paint after everything is ready.
2. Copy versioning on first-run notices (re-show when the text materially changes).
3. API-key fields: `autocomplete="new-password"`, write-only storage, green/red dot state, never echo the value.
4. Force a minimum window width only while onboarding runs, then release it.
5. Make "skip" a *real* configuration (sane defaults), not a dead end.
6. Blank-session hero: composer visible but inert until a workspace is chosen; don't require a first message.

## 2. Layout, spacing, typography, color, theming

- **Three-column AppFrame**: left sidebar 264–420px (default **280px**, collapse rail **56px**), auto-collapse below 1024px viewport, right panel first opens at **45% of viewport** capped at **70%**, and the center column is protected by a ladder: shrink right panel to 300px → auto-close it → only then compress center below 400px (asar: `dsh-client-ui-layout--README.md`). chat.deepseek.com defines `:root{--sider-width:261px}` (main.css).
- **Palette (chat.deepseek.com, from main.css static tokens)**: brand family `--dsw-static-deepseek-*`: 50 `#edf3fe`, 200 `#d3e2ff`, 400 `#679efe`, **500 `#3964fe`**, 800 `#34415b`; neutral scale `#fff → #0f0f0f` (50 `#fafafa`, 100 `#f5f5f5`, 400 `#a2a4a6`, 900 `#0f0f0f`) and a parallel **neutral-bluish scale** (950 `#151517`) for dark mode — near-monochrome; color = brand blue + semantic amber/green/red only.
- **Alias-token architecture**: 75 `--dsw-alias-*` semantic names (`bg-base`, `bg-layer-1/2/3`, `label-primary`, `border-l1..l4`, `brand-primary`…) resolved per theme; chat main.css has 684 custom properties total. Desktop harness: `--dsw-*` tokens are "the sole color authority," dark mode = `body[data-ds-dark-theme]`, `system` resolves via `prefers-color-scheme` (asar: `dsh-client-ui-theme--README.md`).
- **Typography**: UI font stack `Inter, system-ui, -apple-system, …, Noto Sans, …` with Inter self-hosted as **unicode-range subsets** (400/500/600/700 + italics, woff2). One stack entry leads with **`"quote-cjk-patch"`** — a dedicated patch font so CJK quote glyphs don't render with Latin metrics. Code fonts: `Fira Code, Fira Mono, Menlo, Consolas, …` ([CSS]).
- **Desktop harness brand font is separate**: Montserrat 300/400/500 bundled (SIL OFL), used **only** for brand/welcome text (`--dsw-font-family-brand`); "ordinary UI keeps its system font stack" (asar theme README + `lib/styles/brand-font.css`).
- **Content font-size setting**: 10–22px integer stepper, default **14px**, shifting headings/body of the conversation ladder by a delta; secondary tier = setting −1 (≤14) or −2 (>14); small text and code stay fixed (asar theme README).
- **Corners**: `corner-shape.css` applies **`superellipse(1.5)` "squared-squircle" corners universally** inside `@supports (corner-shape: superellipse(1.5))` — Chromium-only progressive enhancement (Tauri's WebView2 is Chromium — it will apply).
- **Elevation**: hairline `--dsw-elevation-stroke` (0.5px) + two soft-shadow tiers; elevated surfaces drop borders; menus are **translucent with backdrop blur**; modal masks stay dark translucent *without* blur.
- **Focus**: single focus-ring system — color `#4176E6` light / `#7AAAFF` dark, 2px width, transparent on `:focus-visible` in pointer modality except editable fields; `data-input-modality` on `<html>`.
- **Scrollbars**: 5px WebKit thumbs bound to surface tokens, `transparent` when the pointer is outside the column (sidebar keeps thumb 2s after pointer-leave) — scrollbars are a pointer affordance, never layout-shifting.
- **CJK handling (verified pieces)**: `quote-cjk-patch` font patch, `Noto Sans` in the fallback stack, complete zh dictionaries shipped, IME-safe input (command hints/placeholder hidden during composition until commit; shared `observeComposition` IME guard). The **"2.6–3.2× CJK expansion" figure is August's own measurement** (`docs/plans/AUGUST-UI-ENHANCEMENTS.md:399-401`); no public DeepSeek source states a ratio — UNVERIFIED externally.

### Adopt for August
1. Two-scale neutral palette (warm-neutral light + **neutral-bluish dark**) with exactly one brand family; expose only semantic alias tokens to components.
2. `prefers-color-scheme` + explicit override, applied as `data-*` attribute + `color-scheme` before first paint — no theme flash.
3. Adopt the *pattern* of an inline `@supports corner-shape: superellipse(1.5)` progressive squircle.
4. Hairline 0.5px stroke + soft-shadow elevation instead of visible borders; translucent blurred menus over opaque ones.
5. Content font-size as a delta over a 14px base ladder with fixed-size small/code text.
6. Subset Inter woff2 + a CJK punctuation patch font at the head of the stack; keep code font fixed.
7. Pointer-aware focus rings and pointer-aware scrollbars.

## 3. Left sidebar

- **Contents (desktop harness)**: brand row (fish mark + name; clicking the brand = New Session), version badge `version[-commit][-dirty]`; New Session button (shows its shortcut in grey trailing text on hover); global panel-list entries; `sidebar.workspaces` seat (Workspace + Session browser); bottom-pinned Settings seat (asar: `dsh-client-ui-sidebar--README.md`).
- **Workspaces + Sessions**: grouped by Workspace (default) or nested "Workspace Tree"; each Workspace shows **5 idle non-blank Sessions by default, "Show more" reveals 5 more**; running sessions always visible outside the quota; **pin / rename / fork / archive** row actions; sort by Last updated (remembers choice) or Manual drag order; three-way archive filter (Hide archived / All / Archived only); archived rows greyed but recoverable — **no deletion exists, archive is the lifecycle end**; unnamed sessions show 未命名/Untitled; title overflow ellipses at rest and *scrolls to its far edge on hover* (asar: `dsh-client-ui-workspace--README.md`).
- **Status per row**: shared `StateDot` language — green done, amber warning, red error, grey idle, 14px rotating `ongoing` loader (all loaders phase-locked); **pending interactions replace the timestamp with a warning dot + label "Approval / Plan review / Answer"**; clock mark for scheduled tasks; subagent-origin sessions hidden (asar workspace + ui-primitives READMEs).
- **Search**: collapsed to a header action; expands across the header; instant title/Workspace substring matches + 250ms-debounced content search with snippets, capped at 20 results; archived results offer Unarchive in place.
- **Collapse**: animated — expanded content fades and translates leftward into the 56px rail; **Mod+B** toggles; below 1024px auto-collapse; opening the right panel collapses a manually expanded sidebar; a status badge (e.g., update availability) rides the top expand button while collapsed.
- **Platform chrome**: Windows — caption row with sidebar toggle fixed top-left, caption icon buttons 28px circles with 16px glyphs; macOS — 52px top strip clears hiddenInset traffic lights, drag regions are per-row (`data-window-drag`).
- **Account area**: 24px sidebar / 32px settings circular profile image with icon fallback; collapsed rail centers avatar in a 36×36 button; signed-out shows a More row instead; menu includes Feedback with prefilled uid/version/locale/resolution.
- **chat.deepseek.com** sidebar beyond `--sider-width:261px`: **UNVERIFIED** (login-walled).

### Adopt for August
1. Row-status vocabulary as one primitive (done/warning/error/idle dots + phase-locked rotating loader) reused across sidebar, tool rows, and settings.
2. Pending-interaction surfacing in the session list ("Approval/Plan review/Answer" replacing timestamp) — the agent-app killer detail chat apps lack.
3. 5-at-a-time folded history with running sessions exempt from the fold.
4. Archive-not-delete lifecycle with a three-way filter and in-search unarchive.
5. Hover-scroll long titles instead of tooltips as the first resort.
6. Debounced instant+remote two-stage search capped at 20 results.

## 4. Right panel

- **Right Sidebar** = a real docking system (`dockkit`), one persisted surface **per session**: tab capsules + add control + split control; max two horizontal panes (ratios 20–80%); float/dock operations; **fullscreen presentation** covering the viewport while keeping columns underneath; below 768px opens fullscreen automatically (asar: `dsh-client-ui-sidebar-right--README.md`).
- **Layout stored per session** as JSON `dsh.sidebar-right.v1.<sessionId>` in localStorage, replayable; reload restores tabs/splits/selection before bodies render (same README).
- **Tab types**: files, embedded browser, terminal, document preview, plus a **"guide" default page** — a muted compass of entry capsules shown when a new pane opens; the sole docked guide can't be closed; closing the last real tab collapses the column (same README).
- **When it opens**: conversation file links, tool-row line references (`#L24`/`#L24-L30`), file-mention chips, and skill references all route here via `openResource`; the panel expands because "content the user cannot see is not opened." Hidden state shows one button in the conversation header corner (the sidebar's collapse icon **mirrored**) (same README; `ui-chat--README.md`).
- **The panel is a column, not a card**: "takes the conversation's ground colour and content font sizes rather than a raised layer of its own." Width: first open 45%, remembered, capped 70%, center protected at 400px.

### Adopt for August
1. Per-session right-panel layout persistence.
2. File links from the transcript open in the right panel with line anchors; `#L24-L30` reuse of an open file tab.
3. "Guide" empty-page of entry capsules instead of a bare empty panel.
4. Keep the panel ground-colored (no card chrome) so it reads as page, not overlay.
5. Mirror-icon affordance in the header corner as the only reopen control when hidden.

## 5. Settings

- **Shell**: a modal **800×800** panel (viewport-bounded, min 24px margins), left navigation projected from a `settings.section` ledger (sections independently registered), independent scroll of nav vs content, fixed title; portals beside `#root` so window drag regions can't swallow controls (asar: `dsh-client-ui-settings-general--README.md`).
- **Sections observed**: General (Appearance/theme + font size, Coding Tools switch, Send behavior, "Work details", "Performance & usage", "Open chat links in", Current version row, "Open configuration file" loopback action), **Account** (first only while signed in), **Models** (provider rows: DeepSeek Account first, DeepSeek second, then third-party; one editor card at a time; API keys; per-model rows with contextWindow/maxTokens and Text/Image checkboxes; "Fetch available models" live endpoint interrogation with a searchable picker, monospace model ids; protocol picker named by product name — OpenAI Chat Completions / OpenAI Responses / Anthropic Messages), **Plugins** (inventory + per-plugin pages).
- **Every feature owns its row**: the settings shell renders *no* generic form — sections are slot contributions, so a feature not composed leaves no trace (`whileServed` semantics) (asar: `dsh-client-ui-settings--README.md`).
- **Staged forms**: settings pages save only on the save button, discard on unmount, show an "overridden" badge + reset per field, and send one atomic op-list with revision (asar: `ui-primitives--README.md`).
- **Keyboard**: Settings command Desktop `Mod+,`, Web `Mod+Alt+,`; Escape closes top dialog restoring focus; no focus outline on auto-focus, visible ring under Tab navigation.

### Adopt for August
1. Ledger-driven settings nav where each feature contributes its own page.
2. "Save only on button" staged-edit model with per-field override badge/reset is worth porting verbatim (behavior change — needs a ruling).
3. Provider editing: one-card-at-a-time, key state as dot, live "Fetch available models", protocol picker with product names (August's apiFormat labels already match).
4. Show app version at the bottom of General.

## 6. Update flow

- **Mechanism (verified locally)**: electron-builder generic feed — `resources/app-update.yml`: provider `generic`, url `https://download.deepseek.com/dsh-desk/feeds/win-x64/`, channel `nightly`, signed-publisher check; cache dir `$LOCALAPPDATA/@deepseek-aidsh-desktop-updater` holds `current.blockmap`, downloaded `installer.exe`, `pending/update-info.json` (`{fileName, sha512, isAdminRightsRequired:false}` → no UAC prompt).
- **In-UI presentation**: the Account/settings row exposes availability → progress → verification → readiness → retry with **persistent retry feedback**, sharing the connection pill's geometry (28px height, 8px corners); update accents use brand blue; exact strings verified: "Checking for updates…", "Downloading update: {percent}%\nTarget version: {version}", "Verifying update files…", "Could not download the update. Please try again.", "Retry update" (asar: `ui-settings-general--README.md` + locale extraction). **Installation requires a separate shell-owned confirmation**; collapsed sidebar shows update state as a **brand-blue dot on the top expand button, including failures**.
- **Failure states**: check/download/install failures each have distinct copy + retry; "Connection feedback takes priority except during shell-reported installation". The web app ships as immutable hashed static bundles — updates = new asset hashes on reload; **UNVERIFIED** beyond file naming.

### Adopt for August
1. Download → verify → *explicit confirm* → install, with the whole ladder visible in one 28px status pill; never auto-restart.
2. Mirrored collapsed-state indicator (dot on the sidebar toggle) so update status never needs the sidebar open.
3. Keep separate user-facing copy for check/download/verify/install failure, each with its own retry.
4. sha512 + blockmap diffing and `isAdminRightsRequired:false` is the bar for August's updater UX (no UAC mid-session).

## 7. Icon system

- **Desktop harness**: no icon font — inline React SVG components in `dsh-client-ui-primitives`, **size-neutral with two weights: `Regular` (1px stroke) and `Medium` (1.3px stroke)**, same geometry, rendered size via prop; every glyph ships both weights (asar: `ui-primitives--README.md`). Named scale: 16px viewBox product icons, `LinkIconMedium` 14px for clickable-link categories + ~40 known-site marks (GitHub, npm, Stack Overflow, MDN, Wikipedia, Bilibili, Zhihu, CSDN, Weibo, Taobao...), `FileTypeIcon` **28px** category-colored file glyphs, plugin artwork **36×36**, permission-mode glyphs, `FishLogo` + `BrandWordmark`.
- **Special animated mark**: the running status uses a **whale APNG** embedded in the stylesheet, "a 28×28 image at a default 14×14 CSS size" whose mask inherits text color, with a static SVG fallback under reduced-motion/forced-colors (asar: `ui-chat--README.md`).
- **chat.deepseek.com**: no icon font, inline SVG + 14 `mask` uses in main.css; icons **UNVERIFIED** in detail.

### Adopt for August
1. Two-stroke-weight size-neutral icon components (Regular/Medium) — one geometry, two emphases, no per-size assets.
2. A fixed known-site mark list for cited domains (the web-search citation-chip primitive) with globe fallback — no runtime favicon fetching.
3. One animated brand mascot (APNG/mask inheriting text color) as the *only* running indicator, with static fallback for reduced motion.

## 8. Micro-interactions

- **Reasoning presentation (the DeepThink-equivalent, verified in the harness)**: reasoning and tool activity are **process groups** — collapsible cards that fold completed turns without ever hiding the final answer. Collapsed title is a quiet summary line: **"Thought for a while"** with activity rollups ("{count} tool calls · {count} messages · {count} subagents", separator " · "), completed header "Completed in {duration}"; the running state title is **"Deep diving" / "Deep diving for {duration} ···"** (zh: 深度求索中) with the whale animation (locale + `dsh-client-ui-chat--lib--client.js`).
- **Work-details modes**: one setting — **Compact / Standard / Detailed / Verbose** ("Choose how much detail to show for tool calls") — controls process-group folding and reasoning previews without hiding answers; Verbose keeps rows visible with no collapse action; mode changes preserve each group's open state (asar: `ui-chat--README.md`).
- **Streaming**: incremental markdown that freezes all but the trailing two blocks (only the tail re-parses per chunk), code fences advanced line-by-line from saved Shiki grammar state, completed lines sealed into fixed-size React groups (asar: `ui-primitives--README.md`). **TextShimmer** is the running-text treatment: one left-to-right highlight across a row's whole text — 300ms initial delay, 1s sweep, 500ms rest, mask tilted 15°, base color inherited, icons/chevrons excluded (same README). Process rows sit 6px apart; expanded group title 8px before content; answers 12px from process rows.
- **Tool progress**: every tool call is a row with three frozen stages (preparing → start → result) owned by one callId; preparation shows "Preparing content NKB"; a keyed per-tool view renders terminal/read/diff/search/web cards read in place; failures keep semantic red/amber; "in-flight rows show a start marker without inventing elapsed time" (asar: `ui-tool--README.md`, `ui-trajectory--README.md`).
- **Stop/interrupt**: two Escape presses within `stopSequenceMs` (default **500ms**) stop the running turn; the Stop button's tooltip literally shows `Esc Esc`; queued messages survive (asar: `ui-conversation--README.md`, `client-shortcuts--README.md`).
- **Busy composer**: Send button becomes **Queue message / Steer message** per the stored busy-Enter setting while running; Cmd/Ctrl+Enter always uses the complement; queued rows show "Sending…" with edit/remove/steer; echo rows appear instantly and are replaced atomically by durable records (same README).
- **Scroll behavior**: independent follow for outer transcript and any open capped process group (4-state table; back-to-bottom button appears exactly when outer follow is off); Turn navigation **rail** with fixed-pitch marks 10px apart and hover previews (1 prompt line of 50 chars / 3 response lines of 120 chars), hidden when transcript width ≤900px (asar: `ui-chat--README.md`).
- **States**: connection pills — pale-yellow "Disconnected/Reconnecting" (1–3 dots advancing every 500ms, 800ms minimum visibility so retries don't flicker) → pale-green "Connected" for 2s, 150ms fade-out; quota failure = persistent inline red-dot row + one frame-wide notice; terminal turn failure rows; amber warning dot for output-token limits; archive notices with undo.
- **Trajectory view (power surface)**: turn-aware event ledger + timing overview with TTFT/generation/throughput, 500ms-hover details, drag-to-filter, wheel zoom, right-drag pan; inspector at fixed 13px/20px for thinking text (asar: `ui-trajectory--README.md`).
- **Keyboard**: Mod+B sidebar; Mod+, / Mod+Alt+, settings; **Mod+/** shortcut reference (480×600 searchable card, inline recorders, conflict rejection, per-platform profiles, overrides in `userData/keybindings.json`); Mod+K search sessions; Mod+Alt+G rename; Enter/Cmd+Enter/Shift+Enter delivery; Tab settles command completion.
- **chat.deepseek.com DeepThink panel / citation chips**: **UNVERIFIED** from primary sources (login-walled). August's own prior observation — reasoning collapsed by default as a quiet one-click line — is recorded at `docs/CHAT_UI_DEEP_DIVE_2026-08-23.md:12` and matches the verified harness pattern above.

### Adopt for August
1. "Thought for a while" + activity rollup as the collapsed reasoning title; elapsed-duration running title with a mascot; never hide the final answer behind folded process.
2. TextShimmer as the single running-text treatment (delay 300 / sweep 1s / rest 500) instead of spinners on every row.
3. One 4-mode "Work details" dial (Compact/Standard/Detailed/Verbose) instead of per-row toggles — it maps directly onto August's `toolSurface` profiles.
4. Freeze-parsed-prefix streaming markdown (only the tail re-parses) — keep parity with sealed code-fence groups.
5. Double-Escape stop with `Esc Esc` shown in the Stop tooltip; Queue/Steer composer duality.
6. Connection pills with min-visibility holds (800ms) and a 2s green confirmation — silence on healthy state.
7. Turn rail with 10px marks + card-sized previews only when the transcript is >900px wide.

---

**Key local paths for follow-up**: `%TEMP%\dshui\` (extracted READMEs/bundles/locales — 565 files), `%TEMP%\dsh-chat-main.css` (chat web tokens), `C:\Users\rober\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`, `…\resources\app-update.yml`.

**Sources**: [deepseek.com/en/harness](https://www.deepseek.com/en/harness/), [deepseek.com/en/download](https://www.deepseek.com/en/download/), [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), [chat.deepseek.com](https://chat.deepseek.com/) (shell + main.6c351450f6.css), plus local asar/package evidence cited inline.
