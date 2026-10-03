# Reference study — Hermes desktop (Nous Research)

Stage 1 evidence for the 2026-10-03 UI/UX refactor spec. Produced by a research subagent on
2026-10-03 from the local checkout at `C:\Users\rober\AppData\Local\hermes\hermes-agent`
(version `0.21.5+5778.g0a374d1`, verified via `install-stamp.json` + git log). Path shorthand:
`H:` = the checkout, `D:` = `H:\apps\desktop`. Every claim is source-cited; the one unverifiable
item (the "Pantheon" codename) is marked UNVERIFIED.

---

# Hermes Desktop — UI/UX Study for August Proxy (2026-10-03)

## 0. What this app is + exact version + how verified

- **Nous Research "Hermes"** — a local-first AI agent with four frontends sharing one agent core: CLI, TUI, web dashboard, and the **Desktop app** (the product surface studied here). Desktop is Electron + React + TypeScript + nanostores + `@assistant-ui/react`, rendering over a spawned headless Python backend (`hermes serve`) via JSON-RPC/WS. Three-party ownership: Electron owns the machine, renderer owns experience, backend owns work. (D:\src\AGENTS.md:8-25; D:\AGENTS.md:12-26; H:\website\docs\user-guide\desktop.md:9-19)
- **Version studied: `0.21.5+5778.g0a374d1`** — verified from `H:\install-stamp.json` (`baseVersion 0.21.5`, commit `0a374d167424cdc730ce9761368b62255b551e58`, `builtAt 2026-10-02T14:02:43Z`, `branch main`, `updateMechanism: "self"`), confirmed by `git log` at HEAD (`0a374d167 "docs: Supermemory installs from the plugin catalog"`). Live install proven by Electron user data at `C:\Users\rober\AppData\Roaming\Hermes\` (`window-state.json`, `zoom-state.json`, `connections.json` — all read).
- **Release tags** in the local clone: calver `v2026.8.3 … v2026.9.24` plus `rc.N-v0.21.5` / `v0.21.4+canary.*`. No `v0.21.0` tag exists locally.
- **"Pantheon" codename (prior August doc lead):** UNVERIFIED locally — the string appears nowhere in the checkout (repo-wide grep, all file types). Web search corroborates it third-hand only (an X.com roundup, 2026-09-12). Treat codename as plausible but weakly sourced.
- **Prior-doc leads re-verified (all against current source):** Bot roster — VERIFIED (`H:\website\docs\user-guide\bot-mode.md`; Bots tab next to Sessions). @-mention identification-only — VERIFIED (D:\src\plugins\hermes-bots\plugin.tsx:880). `message_agent` single send path — VERIFIED (H:\tools\bot_mode_dm.py:1-34). Rooms — VERIFIED (D:\src\plugins\hermes-bots\group-rounds.ts:39: "ONE ordered room log… serial round-robin… never parallel"). Plugins ecosystem — VERIFIED (D:\src\app\capabilities; `H:\plugin-catalog\*.yaml`). Memory/skills isolated per bot home — VERIFIED (bot-mode.md:14-21: everything under `~/.hermes/profiles/<name>/`). Schedules/goals — VERIFIED as "Routines" backed by cron. Voice — VERIFIED present (Settings → Voice section, D:\src\app\settings\constants.ts:761; H:\website\docs\user-guide\features\voice-mode.md).
- **CHANGED since the 2026-09-01 study:** canonical bot identity is **no longer a stored session-id pointer**. It is now the pair *(profile, session titled exactly "Bot Chat")* with "NO session-id pin" after five hardening waves (D:\src\AGENTS.md:65-99).

## 1. Launch experience

- **Two-phase first run.** Phase 1: a bootstrap installer overlay renders real install stages as rows with pending/running/failed states, live per-stage elapsed time (m:ss), and an installer-output log that **auto-expands on failure**; Esc dismisses a failed install only, never a running one (D:\src\components\desktop-install-overlay.tsx:28-44, 320-400).
- Phase 2: the onboarding overlay builds its provider catalog from the backend's model options — API-key providers get a "paste key" form, OAuth providers go through the browser flow, and **"Choose provider later" is a durable skip** so a broken provider can't trap the user (D:\src\components\onboarding\index.tsx:127-165, 368-387; H:\website\docs\user-guide\desktop.md:259).
- **Free tier has one state machine:** the first-launch ready screen and the "bring your own key" strip are the same state keyed on a backend-persisted `notice_pending` flag — no localStorage latch, so CLI and desktop cannot disagree (D:\AGENTS.md:277-289).
- **Boot surfaces are distinct experiences with shared primitives:** install, onboarding, connecting, boot failure, and reauthentication each have their own copy and their own way out; a z-index ladder reserves `--z-connecting:1200 → --z-onboarding:1300 → --z-setup:1400 → --z-crash:1500` (D:\DESIGN.md:449-451; D:\src\styles.css:292-296).
- **Startup shows a dedicated landing screen** with the shared long-operation Loader; "No greeting, composer, Skip setup, or statusbar appears early… Never fabricate progress… or replace a resumed conversation with a new greeting." On readiness, the real conversation reveals and controls fade in over 100 ms (D:\DESIGN.md:452-458).
- **Reopen Last Chat on Launch** is on by default; turning it off always begins with a fresh chat; deep links always win (H:\website\docs\user-guide\desktop.md:251).
- Context switches are "a re-home, not a reboot": shell stays mounted; only gateway-bound stores are wiped (D:\AGENTS.md:102-124).

**Adopt for August:** (1) Split first-run into install-progress vs onboarding overlays with distinct z-rungs and distinct recovery copy — August's Tauri backend-boot could reuse the "auto-expand log on failure" pattern. (2) Make "skip provider setup" durable in backend state, not localStorage. (3) A dedicated loading landing screen that never fabricates progress and never replaces a resumed session with a greeting. (4) Never let a failed provider block entry.

## 2. Layout, spacing, typography, color, theming

- The whole visual contract lives in one doc, `D:\DESIGN.md` ("one source per concern, tokens over literals, flat over boxed"), updated in the same change as any token/primitive — "a stale name in this file is a bug."
- **Token system:** `--ui-stroke-primary…quaternary` hairlines, `--ui-text-primary/secondary/tertiary/quaternary`, `--ui-bg-chrome/sidebar/editor/elevated/card/input…quinary`, `--theme-primary: #0053fd` (light default), `--ui-accent`, and the overlay pair `shadow-nous` + `--stroke-nous`. Backgrounds are `color-mix()` derivatives of theme seed colors, not literals (D:\src\styles.css:187-196, 207, 297-367). Raw hex is banned except the two BrandMark tiles.
- **Themes:** built-in presets `github, nous, catppuccin, everforest, solarized, nous-alt` plus classic skins `classic, midnight, ember, mono, cyberpunk, slate` (D:\src\themes\presets.ts:68-461); **VS Code Marketplace themes can be imported live** (H:\website\docs\user-guide\desktop.md:254; D:\src\themes\vscode.ts).
- **Typography:** brand display font `Collapse`, bundled **JetBrains Mono** woff2 for terminal/code, per-CJK fallback stacks (styles.css:94-119, 1748-1756). **UI Scale** is whole-window zoom (default 90%); **Chat Text Size** is a separate 110% multiplier applied only to conversation text + composer (D:\DESIGN.md:374-382). The real user's `zoom-state.json` shows `-0.5779` — zoom is a first-class persisted setting.
- **Spacing:** `PAGE_INSET_X = 'px-[clamp(1.25rem,4vw,4rem)]'` ratio-based page gutter; `PAGE_MAX_W = 'max-w-[75rem]'` overlay body cap; radius scale driven by one `--radius-scalar` (D:\src\app\layout-constants.ts:1-21; styles.css:155-160).
- **Flatness rules:** no card-in-card, no divider borders inside panels, group with whitespace + one `--ui-stroke-tertiary` hairline; overlays float on shadow+hairline instead of framed boxes (D:\DESIGN.md:25-36, 319).
- **Window glass:** defaults to 29% tint, sidebar only, in both light and dark; text stays opaque; one shared resolver owns defaults for renderer and first paint (D:\DESIGN.md:139-146).
- Light/Dark/System is a `SegmentedControl` (constants.ts:849-852); `Shift+X` toggles mode. Motion budget: ~100 ms control transitions, `prefers-reduced-motion` respected beyond a fade (D:\DESIGN.md:488-503).

**Adopt for August:** (1) A single tokens-over-literals CSS-var layer with a doc that is type-checked against primitives. (2) Separate "chat text size" from "UI zoom". (3) `clamp()` gutters + max-width overlay bodies. (4) Sidebar-only glass tint with opaque content column. (5) The retint-from-seed `color-mix` preset system is the cheap 80% of theming.

## 3. Left sidebar

- **Chat-first IA:** "Chat is the home surface"; durable pages (Chat, Skills, Messaging, Artifacts) live in shell chrome; everything else (Settings, Command Center, Cron, Profiles, Agents) renders as overlay cards that return to the previous route (D:\DESIGN.md:46-59). Route registry at D:\src\app\routes.ts:7-19.
- **Sessions | Bots tab strip:** Bot Mode "lives in the left sidebar as a tab next to your conversations — a **Sessions | Bots** tab strip — rather than a second pane stacked below the session list"; the Cronjobs/Routines pane docks beside the chat only while the Bots tab is active (H:\website\docs\user-guide\desktop.md:313-318).
- **Sessions list:** one flat list of ALL recent sessions plus an opt-in **Group by → Projects** tree; project rows preview their 3 most recent sessions with a "Show all N" expander (desktop.md:81-98; D:\src\app\chat\sidebar\index.tsx:1398).
- **New-chat entry:** the section header "+" is hover-revealed and is also a **drag source** — drag onto a tab strip/edge/center to create the session exactly there; sub-threshold release falls through to a plain click (D:\src\app\chat\sidebar\chrome.tsx:41-52). Keyboard: `mod+n` new session, `mod+t` new tab, `mod+shift+n` new window (D:\src\lib\keybinds\actions.ts:121-123).
- **Search:** `mod+shift+f` focuses session search; the only search input is `SearchField` (borderless, underline-on-focus, auto-width) (D:\DESIGN.md:274-277; desktop.md:372).
- **History hygiene:** archiving, pinning (shift-click pins), virtualized list, load-more rows, drag-reorder, per-row context menus.
- **Bot roster rows:** avatar + latest-message preview + timestamp + unread; an **Active now** filter (focused live turn, wrote within 90 s, or recent worker heartbeat — "a connected gateway alone does not mean a Bot is working"); **Hide Bot** display-only with an eye toggle that badges a dot when a hidden bot accumulates activity; user-made **sections** with drag-to-file, Esc cancels the drag, deleting a section never deletes bots and offers Undo (H:\website\docs\user-guide\bot-mode.md:47-55; desktop.md:318-330).
- **Profile rail:** horizontal snap-scrolling `Reel` of profile squares; context menus offer **Open in new window** and **Set as default** (D:\DESIGN.md:66-74, 245-254).
- **Connection/account area:** a connection switcher (local / SSH / URL+token / Cloud) lives in the sidebar (D:\src\app\chat\sidebar\connection-switcher.tsx).
- **Collapse behavior:** below 640 px window width both rails become **hover-reveal overlays** (single source of truth `SIDEBAR_DOCK_MIN_WIDTH_PX`, arithmetic documented — a rail costs 237 px) (D:\src\app\layout-constants.ts:22-40). `mod+b` toggles left, `mod+j` right, `mod+\` flips sides (desktop.md:130).
- Sidebar projects own workspace cwd — "do not reintroduce a per-session/right-sidebar folder-picker flow" (D:\DESIGN.md:63-64).
- Background rule: "Navigation must preserve context… a background session finishing… may update badges and cached data; it must not replace the foreground transcript or steal focus" (D:\DESIGN.md:76-78).

**Adopt for August:** (1) Sessions|Bots as sibling *tabs in one sidebar strip* with the bot detail pane docking beside chat only while Bots is active. (2) Roster "Active now" filter defined by concrete signals. (3) New-chat "+" that doubles as a drag source. (4) Hidden-item pattern: display-only hide + eye toggle that badges on silent unread accumulation. (5) One dock-collapse breakpoint constant with its arithmetic documented. (6) The "background events update badges, never steal foreground" rule as a written invariant.

## 4. Right panel

- **Contents:** the right sidebar hosts the **Files** project tree, **Review** pane, **Terminal**, and a **Preview rail** (D:\src\app\right-sidebar\; desktop.md:52, 155-171).
- **Panes are working context, not navigation:** "Preview, files, review, and terminal remain attached to the current task. Their state survives temporary hiding and chat switches" (D:\DESIGN.md:57-59).
- **Hide vs Close for stateful panes:** **Hide** keeps the body mounted (live page keeps form input, timers, scroll; terminal keeps scrollback); hidden body is inert and never takes shortcuts; **Close** (the tab's ×) actually releases it (desktop.md:53).
- **Terminal:** real terminals under the chat; `ctrl+\`` shows one, `ctrl+shift+\`` spawns another; multiple terminals stack in a tab rail walked with `ctrl+shift+↓/↑`; shells persist while hidden (desktop.md:157-160).
- **Review:** `mod+g` toggles a git pane — branch/ahead-behind, changed files, diffs scoped to **Uncommitted / Branch / Last turn** ("just what the agent changed in its most recent turn"), stage/unstage, commit message generation, Commit & Push, Create PR via `gh` (desktop.md:171).
- **Parallel sessions:** every chat zone holds session **tiles** in a tab strip of a dockable pane tree; ⌘1…⌘9 jumps to the Nth tab, and holding Cmd/Ctrl after 400 ms reveals slot numbers over the target strip's status dots (D:\DESIGN.md:333-341; desktop.md:128). "Live agent output streams into every window showing the session" (desktop.md:129).
- **Attention economy for parallel work:** focused *and* hovered panes keep full color; only panes that are neither recede, with 20% desaturation; sidebar selection follows the focused chat pane (D:\DESIGN.md:536-541; desktop.md:39).
- **Subagent monitoring:** while delegated workers run, a **Subagents frame above the composer** shows count, task names, elapsed, latest activity; previews up to three, expandable roster, per-worker Steer/Stop; "Steering acknowledges that guidance is queued for a checkpoint, not that the child has already read it" (desktop.md:165).
- **Saved layouts:** Basic / Focus / Default / Terminal deck / Quad; applying a layout *opens* panes it places and *closes* the ones it doesn't, so shortcuts always agree with what's on screen (desktop.md:137-141).
- **Preview security model:** guest content never opens anything by itself — sandboxed iframes, no `allowpopups`, `setWindowOpenHandler` denies everything (D:\AGENTS.md:165-192).

**Adopt for August:** (1) Hide-vs-Close semantics for any stateful pane. (2) Per-zone tab strips with slot-number hints on a held modifier — the cheapest legible model for N parallel agent turns. (3) 20% desaturation for unfocused-and-unhovered panes only. (4) A Subagents frame with per-worker Steer/Stop and "queued for checkpoint" honesty. (5) The "Last turn" review scope is directly adoptable. (6) Layouts that open/close panes so shortcuts and screen always agree.

## 5. Settings

- Settings is a **route overlay card** using the shared `OverlaySplitLayout` + `OverlayNav` master/detail chrome (D:\src\app\settings\index.tsx:64-66; D:\DESIGN.md:303-305).
- **Structure:** config-backed sections — Model, Chat, Appearance, Workspace, Safety, Browser, Memory & Context, Voice, Advanced — plus top-level pages Providers (Accounts / API keys / Custom endpoints / Local models), Gateway, Keybinds, Keys, Vault, Notifications, Billing, Sessions, About (D:\src\app\settings\constants.ts:687-814). MCP and Plugins live in a Capabilities page, with old deep links redirected (index.tsx:92-98).
- **Navigation vs disclosure are separate:** labels navigate; a `DisclosureCaret` button opens a branch without changing the page; "General comes first wherever present"; narrow windows collapse nav into a shared dropdown (D:\DESIGN.md:305-315).
- **Search is schema-driven and deep:** a settings-search catalog feeds the command palette; every entry deep-links like `/settings?tab=X&field=Y` and "Search and saved field links resolve to the owning child before highlighting" (D:\src\app\settings\use-settings-search.ts:33-45).
- **Row presentation:** `ListRow` label/description/action rows, flush-left; inputs share `controlVariants`; small exclusive choices use `SegmentedControl`; `Switch size="xs"` bare (D:\DESIGN.md:274-283, 316-319).
- **Per-profile scope:** with ≥2 profiles, config-backed pages show an **"Applies to" chip row** targeting edits at any profile without switching the app (desktop.md:261-268). Persisted state must declare its scope in its key (D:\AGENTS.md:45-47).
- **Config export/import/reset** sit in the settings header with tooltips (index.tsx:489-504); credentials fold env-var groups into provider cards with taglines and signup URLs (constants.ts:23-35).
- **Keybinds page** remaps almost every binding with conflict detection (store/keybinds.ts:145-148).

**Adopt for August:** (1) Master/detail overlay settings with navigation and disclosure as separate controls. (2) Schema-driven settings search that deep-links to a field and highlights it — August has the brain-config schema to power this. (3) The "Applies to" scope chip for per-agent settings. (4) Provider cards that fold env-var families with signup links. (5) Keybind remapping with conflict flags.

## 6. Update flow

- **Desktop and backend update on separate clocks; one button updates everything in order:** connected backend first, then other gateways, then the desktop app itself last. After a backend update the app re-checks its own version and offers one-click **Update desktop app** — "updating a remote backend can never silently leave you on a stale desktop build" (desktop.md:387-393). The overlay's `guiSkew` stage models exactly this skew (D:\src\app\updates-overlay.tsx:87-106).
- **Background check** asks the GitHub API for the branch tip with a credential ladder `GITHUB_TOKEN` → `gh auth token` → anonymous (desktop.md:380-385).
- **Windows mechanism:** MSIX-style feed per channel (stable/canary), build-baked feed base URL validated canonical-https at build time (D:\electron\app-updater.ts:26-109; D:\update-feed.cjs:16-45).
- **In-app Updates overlay:** one dialog hosting checking / check-failed / available / up-to-date / applying / restart / manual / error / guiSkew states, a `Progress` bar, version details, and **release notes generated from the commit changelog**; pip/non-git backends "degrade to honest 'no release notes' copy" (updates-overlay.tsx:1-106, 286-305).
- **Progress during apply:** build output streams to `logs/update.log`; "The Windows hand-off counts new output in this log as progress; a child that produces no output is still subject to the idle watchdog. Process liveness alone does not reset that watchdog" (desktop.md:393-398).
- **The out-of-app hand-off UI:** while the app is closed, `scripts/desktop-update/windows.ps1` serves a tiny HTML progress page on a localhost port opened as a chromeless 280×320 px window with a throwaway Chromium profile; fallback is a WinForms card of the same footprint whose dark palette is "neutral charcoal, never brand blue" (H:\scripts\desktop-update\windows.ps1:385-467). POSIX: `hermes_cli/update_stage.py` publishes stage strings via atomic file replace.
- **Failure/rollback:** check failure, apply error, and manual-update-command states are first-class overlay states; "failed *authoritative writes* surface or roll back rather than silently retargeting" (D:\AGENTS.md:135-140).

**Adopt for August:** (1) Update-everything ordering (backend first, app last) with an explicit stale-GUI warning — August ships desktop+backend together and this is the exact gap. (2) An updates dialog with a fixed state vocabulary including "manual" and "skew" stages. (3) Release notes assembled from commits, with an honest empty-state. (4) Log-tail-as-progress with an idle watchdog, not process liveness. (5) The 280×320 out-of-app progress card is a model for August's MSI/update UX.

## 7. Icon system

- **Two vocabularies, owned in one place each:** **Tabler** (`@tabler/icons-react`) is the default component/chrome set — feature code imports curated aliases + the `iconSize` scale from `D:\src\lib\icons.ts`, never the package directly; **Codicon** (VS Code font) is "the compact editor/tool/status vocabulary" via `D:\src\components\ui\codicon.tsx` (D:\DESIGN.md:470-478).
- **Size scale:** `iconSize = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24 }`, replacing ad-hoc `h-N w-N`; buttons auto-size their SVGs and call sites must not re-set icon size (D:\src\lib\icons.ts:281-293; D:\DESIGN.md:228-229).
- **Selection rule:** "Pick the vocabulary by semantic context and reuse the existing icon for an action. Do not introduce a third icon set or mix styles within one control group" (D:\DESIGN.md:476-478).
- **Brand:** `BrandMark` renders the mark on a fixed squircle tile — black-on-white light, white-on-`#0d1117` dark — generated by `scripts/generate_icons.py`; it "replaced scattered Sparkles glyphs… don't reintroduce decorative star/sparkle icons" (D:\DESIGN.md:479-486).
- **Tooltip discipline is part of the icon contract:** `Tip` only when hover teaches something new; never on menu triggers or close X's; never native `title=` (a test fails any button with `title=`); 200 ms first-open delay, 300 ms warm re-open, 100 ms exit fade; placement intents; rebindable-hotkey tips use `TipKeybindLabel` so the combo always reflects current bindings (D:\DESIGN.md:184-224).

**Adopt for August:** (1) One curated icon re-export + one size scale; forbid raw package imports. (2) A second "status" vocabulary with a written semantic-context rule. (3) Adopt the tooltip timing/placement contract wholesale. (4) A generated brand mark with fixed light/dark tiles.

## 8. Micro-interactions

- **Loading:** `Loader` renders **animated math curves** on an SVG via rAF — 19 named types; `lemniscate-bloom` is the long-operation loader; "Never ship the literal text 'Loading…'" (D:\src\components\ui\loader.tsx:9-30, 150-175, 319-374; D:\DESIGN.md:352-353).
- **Streaming text:** markdown streams through `@assistant-ui/react`; code cards carry a `data-streaming` attribute that pauses their entry animation mid-stream (styles.css:85-89). Reasoning text deliberately does **not** smooth-reveal — "a smoothed reasoning stream re-types from the first character on every delta (the flash). Token-streaming reasoners (R1/Qwen/GLM/Claude thinking) hit it hardest… Plain append matches the answer" (D:\src\components\assistant-ui\markdown-text.tsx:845-857). Thinking previews follow new tokens only while the user is near the bottom (D:\DESIGN.md:410-412).
- **Tool-call progress:** live tool activity rows with expandable structured summaries; destructive red is reserved for explicit failures — "Missing read paths and ambiguous exit-1 results use neutral notices… Errors described inside returned data are not tool failures" (D:\DESIGN.md:402-406).
- **Approval stack:** one persistent transcript-level `CardStack` hosts approvals — current card plus a 96%-scale silhouette 7 px above, 220 ms promotion, 180 ms upward clearance, no rotation; "Gestures never grant approval"; departing cards are immediately inert; reduced motion settles instantly (D:\DESIGN.md:106-126).
- **Composer status stack:** status groups start collapsed except todos; pause/resume preserves disclosure choice; a centered ridge hides the entire stack, persisted per conversation; ↑/↓ recalls previous prompts (D:\DESIGN.md:413-421).
- **Empty/error states:** `EmptyState` (pages) vs `PanelEmpty` (overlay master/detail); one `ErrorState` + canonical `ErrorIcon` for boundary, in-dialog, and boot-failure; `ConfirmDialog` is the only confirmation — opens focused on Confirm, owns pending→done→close plus inline error, and a programmatic `confirm()` renders through a single host (D:\DESIGN.md:350-373).
- **Optimistic honesty:** direct manipulation paints first; persistence reconciles after and rolls back visibly on failure; stale async results can never overwrite newer intent (D:\DESIGN.md:43-44, 505-510).
- **Voice/dictation:** the mic is dictation; hovering **fans out** sibling toggles (`FanMenu`); active voice pins the composer recipient (desktop.md:104; D:\DESIGN.md:284-289).
- **Keyboard (rebindable, conflict-checked):** `mod+k`/`mod+p` palette, `mod+,` settings, `mod+.` command center, `mod+shift+f` session search, `ctrl+tab` cycle sessions, `mod+b/j/\` panels, `ctrl+\`` terminal, `shift+x` light/dark, `mod+1…9` slot tabs; "Keyboard ownership follows focus… one cancel gesture does exactly one thing" (D:\src\lib\keybinds\actions.ts:84-225; D:\DESIGN.md:536-548).
- **Transcript niceties:** a conversation **timeline rail** of per-prompt markers with hover-list and jump; **reading-position memory** restores distance-from-bottom per session; find-in-page; unsent drafts survive a lost session with an inline undoable restore strip (desktop.md:59-61, 50).
- **Statusbar:** customizable items — context meter, **cache hit rate**, **tokens/sec (last 10 calls)**, workspace, model, approvals, timers — toggled via right-click; both usage metrics update live during a turn (desktop.md:63-70).

**Adopt for August:** (1) Reserve red for explicit tool failures and render in-data errors as neutral notices. (2) The approval CardStack geometry is a finished spec for August's queued approval UI. (3) No smooth-reveal on reasoning streams. (4) Chat-text-size decoupled from UI zoom plus reading-position memory. (5) The math-curve Loader as a single long-operation indicator. (6) Cache-hit-rate / tokens-per-sec statusbar items priced through the same estimator as the usage page.

---

**Sources:** all local files above were read directly (paths cited inline; base `C:\Users\rober\AppData\Local\hermes\hermes-agent` and `C:\Users\rober\AppData\Roaming\Hermes`). Official docs are bundled at `H:\website\docs\user-guide\desktop.md` and `H:\website\docs\user-guide\bot-mode.md`. Nothing outside these sources is asserted; single unverifiable items are marked UNVERIFIED (the "Pantheon" codename locally).
