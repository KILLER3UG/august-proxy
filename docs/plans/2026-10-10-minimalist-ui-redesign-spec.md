# August Desktop UI Redesign Spec — minimalist, clean, still powerful

**Status: Stage 1, awaiting approval. Zero code changed.**

**Date:** 2026-10-10 · **Scope:** `frontend/desktop/` only (Tauri 2 + React 19 + TS +
Tailwind 3.4 + Zustand 5). No library swaps, no Tailwind v4, no backend changes.

**The brief:** *"redesign the whole UI of august harness to be minimalist, clean yet
still powerful"*, with 14 reference screenshots showing Claude.ai (Claude desktop),
ChatGPT desktop's Skills page, Haze's Settings modal, and KiloCode's coding shell.

---

## 0. How to read this document

Every claim is traceable to either a `file:line` citation in `frontend/desktop/src/`,
a measured number from the DOM census (§1.2), or a reference screenshot the user
supplied. Numbers that duplicate code constants are re-measured, not inherited —
**two prior planning documents carry numbers that are now wrong**, and this spec
replaces them:

| Prior doc | Claimed | Measured now | Verdict |
|---|---|---|---|
| `docs/plans/2026-10-03-ui-ux-refactor-spec.md` §5.1 | 45 sections / 43 implemented / 17 rail rows | **43 registered, 43 implemented, 17 rail rows** | the 45 was stale |
| `docs/ui-refactor/minimalism/stage1-inventory.md` §3.3 | settings rail-visible ≈714 | **17 rail rows** | off by ~42× — it counted every control inside every section, not rail rows |
| `docs/plans/2026-10-03-ui-ux-refactor-spec.md` §5.1 | 304 search keywords | **294** | minor |

**What is already done that this spec must not re-plan.** That October 3 spec shipped
a large batch of its own phases (27 commits on master). Verified still-green today:
`npm run check:design` passes with zero new drift (499 baselined violations, none
new); `tsc -b` clean; **1653/1653 vitest**; `text-3xs` is gone entirely (0 uses; the
`text-2xs` rung is the only sub-xs step, 840 uses); `size-3.5` is gone (0 uses). The
token architecture in `src/styles/tokens.css` (3 contrast tiers, 4-rung elevation
ladder, per-theme `--dt-*` set wired through `tailwind.config.cjs`) is healthy and
**stays** — this spec is a *surface* redesign, not a token rebuild.

**What is genuinely missing** (the actual work): personalization depth, nav
discoverability, composer density, and a status bar. Details in §2–§6.

---

## 1. Measured baseline

### 1.1 Reference behaviour, distilled from the user's screenshots

| Reference | Shell | Composer | Settings / personalization |
|---|---|---|---|
| **Claude.ai / Claude desktop** | `+ New` · Projects · Artifacts · Customize · Pinned · "Chats and tasks" + search + capped recents + "View all" · account row at the very bottom. A **right-side Artifacts panel** lists files from the current chat. | One rounded card: `+` attach (left), text field, then model+effort as ONE chip ("Sonnet 5.5 High"), mic, send. Nothing else persistent. Process detail collapsed. | — |
| **ChatGPT desktop (Skills)** | Narrow **icon rail**, then a secondary **"Customize"** sidebar (Plugins / Skills / Installed), then a content pane. | — | Page title + one-line subtitle; search field, **Refresh** icon, **gear**, white **Add** button; **2-column card grid** (icon + name + one-line description + checkmark); **category filter pills** below. |
| **Haze (Settings modal)** | Wordmark + collapse toggle, **workspace switcher** ("Personal" + chevron + "+"), then just **three nav rows** (New / Automations / Review), then "Recent" with per-row status glyph + timestamp + **token delta (+4,574 / −808)**, then Settings at the bottom. | "Send follow-up"; one model button ("GPT 6 Sol High"); a small **context-percentage ring**; permissions + locale as **quiet labels**. | A small dialog: left tab column (Account / Appearance / Providers / Team / Shortcuts / About) + right pane. Appearance = **5 named theme swatches**, a System\|Light\|Dark **segmented control**, a toggle, and **4 per-surface font-size rows** (Interface / Chat messages / Chat input / Code) each with a pill value button. |
| **KiloCode** | Sidebar with **3 tabs (SESSIONS / BOTS / TERMINAL)**, quick actions, search, PINNED, and a **PROJECTS tree with a coloured status dot per project** and sessions nested beneath. | Bottom bar reads "What's next?" with the model picker and a token delta beside it. | — |

**Convergent rules** (what all four agree on, and therefore what August should adopt):

1. **The composer is one card.** Attach, text, model+effort, send. Everything else is
   behind the `+` menu or transient.
2. **Model and effort are one control**, not two chips.
3. **The sidebar has 3–5 destinations visible**, not 1 and not 20.
4. **Recents are grouped and capped**, with an escape hatch ("View all"), never
   hidden behind a popover. (ChatGPT shipped "5 recent + more" and reverted under
   user backlash — do not repeat it.)
5. **A status/footer strip exists** and carries quiet context (workspace, model,
   token delta) rather than persistent chrome.
6. **Personalization is a real surface**: named themes, a mode control, and
   per-surface font sizes — not a single global text-size slider.
7. **Collections render as card grids with one-line descriptions**, not as dense lists.

### 1.2 DOM census (measured 2026-10-10, 1440×900, live dev server)

| screen | leaf text | buttons | icons | inputs | timestamp strings | copy >8 words | switches |
|---|---|---|---|---|---|---|---|
| chat, empty | **136** | **105** | 90 | 4 | 1 | 4 | 0 |
| settings · general | 89 | 34 | 34 | 4 | 0 | 10 | 4 |
| settings · appearance | 94 | 55 | 38 | **37** | 0 | 7 | 0 |
| settings · providers | 31 | 25 | 26 | 1 | 0 | 1 | 0 |
| settings · memory | 52 | 33 | 27 | 2 | 0 | 8 | 5 |
| settings · skills | 67 | 43 | 32 | **12** | 0 | 8 | 0 |
| automations | 130 | 98 | 79 | 2 | 1 | 3 | 0 |
| board | 152 | 99 | 82 | 6 | 1 | 5 | 0 |
| **runs** | **633** | 162 | 257 | 2 | **32** | 3 | 0 |
| history | 324 | 175 | 157 | 3 | 1 | 3 | 0 |
| learning | 141 | 105 | 83 | 3 | 1 | 5 | 0 |
| live | 132 | 102 | 82 | 2 | 1 | 2 | 0 |
| **unique visible strings, product-wide** | | | | | | | **432** |

Reading the table: the secondary routes (automations/board/learning/live) each carry
**~100 buttons and ~80 icons** for a page whose actual controls number in the dozens.
`/runs` is the outlier at 633 leaf nodes and 32 timestamps. The chat empty state
carries 105 buttons, most of which are the sidebar and the composer toolbar.
`/settings/appearance` carries **37 inputs** — the embedded UI Designer (§4.2).

### 1.3 Source-verified structural counts

| Surface | Count | Citation |
|---|---|---|
| Left sidebar elements at rest | **23** | `components/shell/SessionSidebar.tsx:26`, `components/sidebar/SessionListNav.tsx`, `SessionList.tsx`, `FolderTree.tsx` |
| Nav destinations defined | **11** (8 `SECTION_ROUTES`, 2 settings, 1 dev) | `routes.ts:196-200` |
| Nav destinations surfaced in the sidebar | **1** (Artifacts) | `components/sidebar/SessionListNav.tsx:106-122` |
| Nav destinations surfaced only in ⌘K | **6 of 7** | `components/overlays/CommandPalette.tsx:410-429` |
| Composer controls | **50** (14 essential / 24 on-demand / 12 noise) | `sections/chat/ChatThreadComposer.tsx`, `composer/ComposerToolbar.tsx:246-504` |
| Composer popovers | **13** | `sections/chat/composer/useComposerPopovers.ts:93-95`, `:111` |
| Right-drawer section ids | **13**, of which **12 gesture-reachable** | `components/shell/RightDrawerState.ts:7-20`; `terminal` reachable only via the LLM ui-action allowlist `ChatLayout.tsx:179-186` |
| Settings sections registered | **43** (17 `basic` / 26 `hidden`) | `settings/settings-registry.ts` (ids after :158) |
| Settings sections with a component | **43** (implemented == registered) | `sections/settings/SettingsPage.tsx:345-396` |
| Rail rows rendered | **17** | `components/workspace/WorkspaceShell.tsx:278` |
| UI Designer colour controls | **18** | `lib/ui-customization.ts` `UI_TOKEN_DEFS` |
| UI Designer theme presets | **6**, of which **5 dark-only** | `lib/ui-customization.ts:185+` |
| Per-surface font-size controls | **1** (global 4-step) | `sections/settings/GeneralSection.tsx` |
| Status / footer bar | **none exists** | `ChatLayout.tsx:562-674` renders exactly three regions; a grep for `StatusBar\|statusbar\|august-status` returns zero shell hits |

---

## 2. Scope framing — what the phases actually contain

This is **not** a repaint. Tagged by kind:

| Category | What belongs |
|---|---|
| **Visual repaint** | §3 (tokens/spacing/density are already sound — only additive), §5 empty state |
| **Unlocks existing capability** | the **workspace switcher** (`store/workspaces.ts` is a full persisted registry with `addWorkspace`/`setCurrentWorkspace` and **zero sidebar exposure** — its only reader is `composer/ComposerWorkspaceChips.tsx:39`); the **TERMINAL tab** (`BottomTerminalDock.tsx:296-416` exists and works, but the sidebar has no tab for it); the **Artifacts right panel** (13 drawer sections exist, 12 reachable, but the sidebar shows one text row); **6 of 7 nav destinations** (real routes, reachable only by ⌘K) |
| **New frontend capability** | a **status bar** (does not exist anywhere); **per-surface font sizes** (1 global control today, the reference wants 4); **named theme swatches** (do not exist); a **merged model+effort chip**; a **Skills card grid** |
| **Bug fix** | 5 confirmed defects, §7 |
| **Performance** | `/runs` at 633 leaf nodes; the drawer's 1 s elapsed ticker re-rendering a whole section (`RightDrawerSubagentsSection.tsx`), not just the labels |

**Not in scope** (separate agreement first): backend/harness behaviour, the
`memoryAutoInject` BM25 arm, the mobile companion beyond a class-coupling check, any
change to `dump_openai_upstream_body` / `dump_anthropic_upstream_body`, the two
install/update data guards, and any relaxation of `wipeStaleTree`.

---

## 3. Design tokens, type, motion, icons

**Verdict: the system is better than the brief assumes — keep it.** `tokens.css`
already has three sanctioned contrast tiers (measured 16.4/8.5/5.1 light, 16.8/11.5/7.9
dark, all exceeding AA), a four-rung elevation ladder shared between `--elev-*` and
`shadow-elev-*` by construction (`tokens.css:137-154`, `tailwind.config.cjs:111-135`),
a rem type scale that honours `data-text-size`, and `check-design.mjs` ratcheting six
drift habits at zero new violations. Inter Variable + JetBrains Mono are bundled and
CSP-enforced local-only.

**Additive changes only:**

| # | Action | Why | Risk |
|---|---|---|---|
| T1 | `--shell-inset-x` token (Hermes `PAGE_INSET_X` clamp pattern) replacing the `px-6`/`px-8` literals in the shell | the references all clamp page insets; a literal breaks at the 960px window minimum | Low |
| T2 | Composer input floor **16px** (Claude's documented `--cds-font-size-text-entry-floor`; the mobile shell already forces it — `frontend/mobile/App.tsx`) | today the textarea is `text-sm` (`ChatThreadComposer.tsx:506`) | Low |
| T3 | Add **per-surface font-size** CSS vars (`--font-ui`, `--font-chat`, `--font-input`, `--font-code`) defaulting to today's values, driven by the new §4.3 controls | enables the reference's 4-row control without touching every call site | Med |
| T4 | Motion ladder: formalise 60/120/200/300/450 in `lib/motion.ts`; today `t` is 120/180/240 (`lib/motion.ts:41-49`) and two hand-rolled springs live outside it | one scale, ban new springs | Low |
| T5 | Ban `size={N}` props in favour of class-only sizing (24 raw uses remain; the odd values 10/13/15/17/60/72 are the offenders) | the icon standard already exists in the Oct 3 spec §2 — finish it | Low |
| T6 | `title=` → `aria-label` pass (422 uses remain) | tooltips on menu triggers are banned in the reference contract | Low |

**Explicitly not doing:** no rebrand to any reference palette. August's
`#fbfbfa` / `#0F0F0F` warm-neutral grounds stay — they are one step from Claude's
`#fcfcfb` / `#151515`. No new radii rungs. No `corner-shape` squircle without a
visual review. Syntax-highlighting palettes stay hardcoded per language — they are
**not** theme tokens and must not be converted.

---

## 4. Settings & personalization

### 4.1 Information architecture

Today: a 240px rail with 4 category headers (Setup / Agent / Data / App) + 17 section
rows + a standalone Onboard entry (`WorkspaceShell.tsx:278`, `:311`) + a pinned
profile footer. 26 hidden sections are deep-linkable and search-matchable but carry no
rail row — which is correct and intentional (`settings-registry.ts:149` documents the
tier rule).

The reference ChatGPT shape is: **narrow icon rail → secondary Customize sidebar →
titled content pane**. The reference Haze shape is: **left tab column of 6 → content
pane**.

| # | Action | Citation | Kind |
|---|---|---|---|
| S1 | Keep the rail's tier gate exactly as is. **Do not surface hidden sections.** A 43-row rail is the opposite of minimal. | `WorkspaceShell.tsx:278` | repaint |
| S2 | Move the 4 category headers out of the rail into a **content-pane breadcrumb** or drop them; a rail of 17 rows + 4 group headers reads as 21 rows | `WorkspaceShell.tsx:276-286` | repaint |
| S3 | Add a **per-page content header**: page title + one-line subtitle, matching ChatGPT's Skills pane. Several sections already render their own `<h1>`, which is why `account` renders its title twice (it is in `HEADERLESS_SECTION_IDS` *and* renders its own heading — the set name is inverted: it means "this component has no header, so add one") | `sections/settings/SettingsPage.tsx:226`, `sections/settings/AccountSection.tsx:129` | bug fix |
| S4 | Add the ChatGPT toolbar to the content pane: **search field + Refresh + gear + a primary action button** (the action differs per section: "Add provider", "New skill", …) | new | new capability |
| S5 | Fix the "N of M" denominator — M is 43 but the rail shows 17, so the counter is unreconcilable | `WorkspaceShell.tsx:194-198` | bug fix |
| S6 | `model-families` lands in the Agent group despite its own `category: 'capabilities'` arithmetic comment; make the grouping explicit rather than incidental | `settings-registry.ts` + `WorkspaceShell.tsx` | repaint |

### 4.2 Appearance — the biggest single win

Today Appearance renders a 3-up Light/Dark/System grid and then embeds the entire UI
Designer **18 colour controls + 6 presets** inside a basic-tier page — **37 inputs on
one settings screen** (census §1.2), against the reference's 5 swatches + one
segmented control.

| # | Action | Citation | Kind |
|---|---|---|---|
| A1 | Replace the 3-up grid with a **System / Light / Dark segmented control** | `sections/settings/AppearanceSection.tsx` | repaint |
| A2 | Add **5 named theme swatches** (name + a split light/dark thumbnail + selected ring), the Haze pattern. These are *appearance themes* — a distinct concept from `THEME_PRESETS`, which are colour-override maps inside the Designer. Give them a real home so the two stop being confused | new + `lib/ui-customization.ts:185+` | new capability |
| A3 | **Collapse the UI Designer behind one "Colour designer" disclosure.** It stays fully functional; it stops being 37 inputs on a basic page. (`ui-designer` is already `tier:'hidden'` in the registry — the disclosure is what makes that tier honest.) | `AppearanceSection.tsx:65` → `UiDesignerSection.tsx` | repaint |
| A4 | Give the 5 dark-only presets light counterparts, or hide them in light mode (today `visiblePresets` filters to `default` unless `resolvedDark`) | `lib/ui-customization.ts` `visiblePresets` | bug fix |
| A5 | One draft indicator, not two ("unsaved draft" + "previewing/in sync" render the same fact twice) | `UiDesignerSection.tsx:109,275` | repaint |

### 4.3 Per-surface font sizes — 1 control today, the reference wants 4

`lib/theme.ts:9` has a single `TextSize` (compact 0.92 / default 1.00 / comfortable
1.08 / spacious 1.18) applied as `data-text-size` on `<html>`, scaling every rem.
The reference has four independent rows: Interface / Chat messages / Chat input /
Code.

| # | Action | Citation | Kind |
|---|---|---|---|
| F1 | Add a per-surface size store beside `textSize` (keep the global preset as the default for all four, so nothing changes for an existing user) | `lib/theme.ts` | new capability |
| F2 | Render four rows in Appearance, each with a pill value button, each writing its own CSS var (§3 T3) | new | new capability |
| F3 | Composer input stays at a 16px floor regardless of the other three | §3 T2 | repaint |

### 4.4 Settings modal a11y (unchanged from the Oct 3 spec — still open)

`WorkspaceShell` is a full-screen route, not a dialog. It has no focus trap, no
`role="dialog"`, no background inert, and **one Escape in a nested confirm also exits
Settings** (the document handler double-fires). These were Phase 9 of the previous
spec and did not ship. Keep them here as a phase, unmodified.

---

## 5. App shell

### 5.1 Left sidebar — 23 elements today, the references run 8–15

The inventory is verified in the shell audit artifact. The decisive finding:

> **6 of 7 nav destinations are reachable only by ⌘K.** The sidebar carries exactly
> one nav row (Artifacts), and a test actively guards that shape —
> `components/sidebar/__tests__/SessionListNav.test.tsx:63-64` asserts the nav items
> exist *and* that the sidebar stays conversation-only.

| # | Action | Citation | Kind |
|---|---|---|---|
| L1 | **Add the workspace switcher as the second sidebar element** — name + chevron + "+", the Haze pattern. The registry already exists and is fully persisted; only the UI is missing. This is the highest-value unlock in the whole spec. | `store/workspaces.ts:88-111`, `:130`; reader `composer/ComposerWorkspaceChips.tsx:39` | **unlocks existing** |
| L2 | **Surface 3–5 nav destinations as rows** (recommend: Automations, Board, Learning — or a "More" overflow that opens a small popover of the rest). Not 7 rows; not 1. Update `SessionListNav.test.tsx:63-64`, which encodes the current shape. | `routes.ts:202-206`, `SessionListNav.tsx:106-122` | **unlocks existing** |
| L3 | **Add a TERMINAL tab** to the Sessions\|Bots strip, making it the KiloCode 3-tab shape. The dock already exists and works. | `SessionList.tsx:651-694`, `BottomTerminalDock.tsx:296-416` | **unlocks existing** |
| L4 | **Per-row token delta** (+N / −N, green/red) beside the timestamp — the Haze row signature. Needs the session-usage read that already exists for the composer. | `components/sidebar/SessionRow.tsx:545-553` | new capability |
| L5 | **Coloured status dot per project folder**, the KiloCode pattern | `components/sidebar/FolderTree.tsx:133-153` | repaint |
| L6 | Fold the sort toggle into the "Chats and tasks" header instead of a floating text button | `SessionList.tsx:695-709` | repaint |
| L7 | Delete the three inline tutorial blocks (search-empty, empty-folder, empty-tasks) — no reference has prose inside its sidebar list | `SessionList.tsx:742-754`, `:892-899`, `:963-970` | repaint |
| L8 | Move the update-check button into the account row's dropdown (an "update" action already exists there) | `SessionList.tsx:1060-1073`, `:230-232` | repaint |
| L9 | **Do not** reduce history to "5 recent + more" or move it to a popover — ChatGPT shipped both and reverted | — | invariant |
| L10 | Keep: brand bar, hide toggle, New chat, Pinned, search, session rows, View all, account row, resize handle, date headers, needs-attention lane | §7 of the shell audit | keep |

**Artifacts:** one entry point, not two. Today the sidebar row
(`SessionListNav.tsx:106-122`) and the titlebar button (`ChatTitlebar.tsx:261-269`)
both open the same drawer section. Keep the **right panel** as the home and drop the
sidebar row — Claude keeps artifacts out of the left nav entirely.

### 5.2 Right drawer

Verified: 13 section ids, Zed-style tab strip, `MAX_SECTIONS = 4` with silent
oldest-drop, keyboard-resizable, Escape-close, a hidden/parked rail that keeps a pane
mounted while suspending its poller. The architecture is sound.

| # | Action | Citation | Kind |
|---|---|---|---|
| D1 | Make overflow honest: toast "Replaced oldest section: X" instead of silently dropping | `RightDrawerState.ts:41` | bug fix |
| D2 | Prune the subagent tab strip to live + latest-N (it accumulates every persisted delegation) | `RightDrawer.tsx` | repaint |
| D3 | Scope the 1 s elapsed ticker to the elapsed labels; today it re-renders the whole section including the selected timeline every second | `RightDrawerSubagentsSection.tsx` | performance |
| D4 | Tab strip becomes a real `role="tablist"` with arrow roving (plain divs today) | `RightDrawer.tsx:369` | a11y |
| D5 | Add a Claude-style **Artifacts presence**: the drawer already has the section; give the sidebar/session a quiet badge so a produced file is discoverable | `RightDrawerArtifactsSection.tsx` | new capability |

### 5.3 Status bar — does not exist, the references all have one

`ChatLayout.tsx:562-674` renders three regions: sidebar, main column (titlebar →
content → conditional dock), confirm dialog. There is **no fourth region and no
persistent bottom strip**. The nearest analogues are the account row pinned in the
sidebar and the conditional terminal dock.

| # | Action | Kind |
|---|---|---|
| B1 | Add a slim status bar below the main column carrying, left→right: workspace basename · branch (quiet label) · model+effort · **token delta (+N / −N)** · context percentage ring. Collapsible, persisted per session (the Haze "centred ridge hides the whole stack" pattern) | **new capability** |
| B2 | The bar must be quiet: 1px hairline top, no fill, muted foreground, no icons except the branch glyph. It replaces chrome, it does not add to it. | repaint |
| B3 | It is where the composer's context ring and the composer's branch chip move *out* to — which is what makes the composer simpler in §6. | repaint |

### 5.4 Responsiveness & native

- The single `@media (max-width: 900px)` is unreachable in the packaged window
  (`tauri.conf.json` `minWidth: 960`) but is **not dead code** — the mobile
  companion is a WebView that loads this same SPA at phone width
  (`frontend/mobile/App.tsx:150`), where it fires. Replace with container queries
  (≥1100 all docked · 760–1100 drawer overlays · <760 sidebar overlays), because the
  drawer closes independently of window width.
- `decorations: false` stays; the custom titlebar is mandatory. CSP stays (no remote
  assets). Any renamed shell class gets checked against `frontend/mobile/App.tsx` —
  the coupling is real though mostly dead.
- Window controls render only when `isTauri` (they are no-ops in the mobile WebView
  today).

---

## 6. Chat surface

### 6.1 Composer — 50 controls, the reference runs 4

Full census in the composer artifact. The bottom bar is a **6-control island**, not a
toolbar: `ComposerToolbar.tsx:246-504` permanently renders `+` actions, Artifacts,
agent-mode chip, model chip, effort chip, context ring, and send/steer/stop/spinner.

| # | Action | Citation | Kind |
|---|---|---|---|
| C1 | **Merge the model chip and the effort chip into one** — "Sonnet 5.5 High" is one button in every reference. The effort panel folds into the model panel's second tab. | `ModelEffortMenu.tsx:494` + `:521` | new capability |
| C2 | **Move the context ring to the status bar** (§5.3 B3) | `ComposerToolbar.tsx:481` | repaint |
| C3 | **Move the agent-mode chip to a quiet label** in the status bar, keeping its menu reachable | `ComposerToolbar.tsx:398` | repaint |
| C4 | **Delete the streaming spinner slot and the "Steer" text button.** While streaming there are three simultaneous run controls (spinner, Steer, Stop) and the send arrow already routes to steer (`ChatThreadComposer.tsx:534`) | `ComposerToolbar.tsx:315`, `:326` | repaint |
| C5 | **Remove the Artifacts button from the toolbar** — one entry point (§5.1) | `ComposerToolbar.tsx:406` | repaint |
| C6 | **Delete the branch chip inside the composer** — it mounts the same `WorkspaceBranchChip` the titlebar shows; the file's own comment says so | `ComposerWorkspaceChips.tsx:212` | repaint |
| C7 | **Queue pills keep cancel only**; grip / promote / edit move behind the pill's own menu | `QueuePills.tsx:164`, `:227`, `:238` | repaint |
| C8 | Give the slash-command dropdown a **visible trigger** — it is the only popover of 13 a mouse-only user cannot open | `useComposerPopovers.ts:95` | a11y |
| C9 | Keep permanently: textarea, send, stop, model+effort (merged), `+`, attachment remove, voice stop, queue cancel. **8 controls.** | census §F | keep |
| C10 | The project-rules badge moves out of the `+` menu into settings/context; the cost-ceiling chip stays in the menu | `ComposerToolbar.tsx:277-289` | repaint |
| C11 | Disclaimer line: **pending your ruling** — Claude ships the same line, so it may be policy rather than UI | `ChatThreadComposer.tsx:589` | decision |

**Result: 50 → 14 visible controls, of which 8 are permanent.** That matches the
reference density.

### 6.2 Empty state

Today: hero glow ellipse, orchestrator badge, Plan→Dispatch→Review stepper, example
cards, Dispatch button, brand lockup, title, subtitle, "in ⟨project⟩" line —
**136 leaf nodes** on the screen.

| # | Action | Citation | Kind |
|---|---|---|---|
| E1 | Delete the hero glow ellipse and the stepper (they restate the headline) | `ChatEmptyState.tsx:49`, `:82` | repaint |
| E2 | Delete the "in ⟨project⟩" line — the folder chip one row below says it | `ChatEmptyState.tsx:142` | repaint |
| E3 | Keep the brand lockup, title, and example cards — this shape *is* the reference | `ChatEmptyState.tsx:122`, `:133`, `:91` | keep |
| E4 | The orchestrator badge and stepper: keep the badge, drop the stepper | `:71`, `:82` | repaint |

### 6.3 Transcript (from the Oct 3 spec — still open, keep as a phase)

One thinking-disclosure primitive with `variant="rail" | "plain"` (three collapse
machines exist today: the `expandOverrides` map, `ActivitySummary`'s own open state,
and `ThinkingDisclosure`). Fold `ToolStepRow` into a `ToolCallItem` variant and delete
`hideProgress`. History-load failure and the `agentsQuery` failure render nothing
today — add inline error states with retry. Reasoning streams append-only, never
smooth-reveal. Verify row visuals at 39/40 messages, where virtualization flips DOM
structure.

---

## 7. Defects to fix (no design taste involved — do these first)

| # | Defect | Citation |
|---|---|---|
| G1 | Room member count renders the literal string "3b" | `BotsRail.tsx:656` |
| G2 | Live tool rail maps `error` to `CheckCircle2` — failures render with a tick | `LiveToolRail.tsx:8-12` |
| G3 | Live Continuous/Push-to-talk toggle is wired to a no-op handler while `continuousMode={false}` is hard-coded — it advertises a gesture that does not exist | `LiveControls.tsx:35-47`, `LiveSurface.tsx:172,190` |
| G4 | Titlebar "Share" copies `window.location.href` — a localhost URL | `ChatTitlebar.tsx:271-284` |
| G5 | Shortcuts modal says "Ctrl = ⌘ on macOS" on Windows | `ShortcutsModal.tsx:143` |
| G6 | ⌘K "Settings tabs" lists all 43 sections, defeating the only visibility gate the registry has (the rail filters `tier !== 'hidden'`; the palette does not) | `routes.ts:149-154` → `CommandPalette.tsx:394` |
| G7 | `SETTINGS_TABS`'s own comment claims sidebar, routes and palette "all stay in sync" — they are in sync on membership and out of sync on visibility | `routes.ts:146-148` |
| G8 | Subagent tab "Remove view" × removes nothing | `RightDrawerSubagentsSection.tsx:519-527` |
| G9 | `model-families` renders an untitled page (not in `HEADERLESS_SECTION_IDS` and the component has no `<h1>`) | `SettingsPage.tsx:226`, `ModelFamiliesSection.tsx:154` |

---

## 8. Component inventory

**Keep** (audited sound, fixes only): `ChatTitlebar` (minus Artifacts/Share),
`SessionSidebar`, `SessionList`/`SessionRow`/`FolderTree`, `RightDrawer` + all 13
sections, `BottomTerminalDock`, `ChatThread`/`ChatThreadMessagePane`/
`VirtualizedMessageList`, `ToolCallItem` + `ToolCallItemBody`, `ClarifyTool`,
`ChangesCard`, `ContextRing` (moving to the status bar), `ModelEffortMenu` (merging),
`SettingsPage`/`settings-registry`, `WorkspaceShell`, `CommandPalette`, the shadcn
`ui/*` set, `tokens.css` + `tailwind.config.cjs`, `check-design.mjs`.

**Rewrite:** `ComposerToolbar` (8 controls), `ModelEffortMenu` (one merged chip),
`AppearanceSection` (segmented control + swatches + 4 font rows), `SessionListNav`
(workspace switcher + nav rows), `WorkspaceShell` (dialog contract + content header
+ toolbar), `ChatEmptyState` (drop the decoration).

**New:** status bar, per-surface font-size store + controls, named theme swatches,
workspace switcher UI, Skills card grid (for the ChatGPT collection pattern, applied
to Skills and the plugin roster).

**Delete:** the three inline sidebar tutorial blocks, the hero glow ellipse, the
composer branch chip, the streaming spinner slot, the "Steer" text button, the second
Artifacts entry point.

---

## 9. Phased migration plan

Each phase ends with the app working: `tsc -b`, `npm run test -w frontend/desktop`,
`npm run check:design`, `npm run check:docs`, `npm run check:version`, then a real
`npm run dev:desktop` visual pass over every changed screen. Backend tests are
untouched by phases 1–9; phase 10 touches none either.

| Phase | Work | Kind | Risk | Verify after |
|---|---|---|---|---|
| **0. Defects** | §7, 9 items, no taste involved | bug fix | **Low** | G6: ⌘K shows 17 not 43; G2: a failed tool shows a cross; G3: the toggle is gone or works |
| **1. Status bar** | §5.3 B1–B3 | **new capability** | Med | workspace · branch · model · token delta · context % all read correctly at rest and mid-stream |
| **2. Sidebar** | §5.1 L1–L10, incl. workspace switcher + nav rows + TERMINAL tab | **unlocks existing** + repaint | Med | switch workspace from the sidebar; every nav row navigates; Terminal tab opens the dock; update `SessionListNav.test.tsx` |
| **3. Composer** | §6.1 C1–C11 | new capability + repaint | Med | send, stop, steer, attach, switch model, switch effort, queue, voice — all still work; count the visible controls and confirm 8 permanent |
| **4. Settings IA** | §4.1 S1–S6 | repaint + bug fix | Low | rail renders 17 rows and no group headers; every page has a title; the N-of-M counter is honest |
| **5. Appearance** | §4.2 A1–A5 + §4.3 F1–F3 | **new capability** | Med | segmented control switches theme; 5 swatches apply; 4 font-size rows each scale only their surface; Designer behind a disclosure still applies |
| **6. Empty state + transcript** | §6.2 E1–E4, §6.3 | repaint | Low | empty chat reads as the reference; a 40-message thread renders identically at the virtualization boundary |
| **7. Drawer** | §5.2 D1–D5 | bug fix + performance | Med | overflow toasts; 5+ subagents; the elapsed ticker no longer re-renders the timeline |
| **8. Tokens & motion finish** | §3 T1–T6 | repaint | Low | `check-design` still zero-new-drift after `--update`; light and dark both pass on every changed screen |
| **9. Collection surfaces** | Skills card grid + plugin roster, ChatGPT pattern | **new capability** | Low | search filters the grid; a card's checkmark reflects enablement |
| **10. Census re-run** | Re-measure §1.2 and publish the delta | — | — | every row improved or explained |

**After each phase**, re-run the DOM census and confirm the reduction is measured
rather than asserted, and confirm by clicking: **send, stop, switch model, attach a
file, approve a tool call, answer a clarification, see an error.** Approvals,
clarifications and destructive confirmations are essential by definition and are never
moved behind a toggle.

---

## 10. Decisions I need from you (none block phases 0–4)

1. **Nav destinations** — which 3–5 become sidebar rows? (Recommend Automations,
   Board, Learning; the rest stay in ⌘K.)
2. **Status bar content** — is a token delta appropriate, or telemetry you would
   rather not see? (Recommend: yes, it is what Haze ships and it is the single most
   useful quiet readout.)
3. **Composer disclaimer** — keep it (policy) or drop it (Claude ships the same line,
   so it is probably policy)?
4. **TERMINAL tab** — add it to the Sessions|Bots strip (KiloCode parity) or leave
   the dock reachable from the titlebar only?
5. **Named theme swatches** — 5 new *appearance themes* on top of the 6 existing
   UI-Designer colour presets, or unify the two concepts into one?
6. **Artifacts** — right panel only (drop the sidebar row and the titlebar button),
   or keep two entry points?
7. **`/runs` density** — 633 leaf nodes is the worst screen measured. Trim to a
   summary + list, or leave it (it is a data surface, not a chrome surface)?
8. **Phase 9 collection surfaces** — adopt the ChatGPT card grid for Skills and the
   plugin roster, or leave both as lists?

**Stage 2 will not begin until you approve this spec (with answers to §10).**
