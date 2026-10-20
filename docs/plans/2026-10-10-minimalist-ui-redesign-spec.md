> **Open items are tracked in `docs/ROADMAP.md`. This document is a record of the
> measurements and the design, not a task list** — the open items live in the
> roadmap; the reasoning that produced them lives here.
>
> **Corrected 2026-10-20 against the tree at `5cdae644`.** Three claims in this
> document are false and each one has had live code written to match it:
>
> - **The status bar never existed.** §1.3 and §9 phase 1 claim
>   "Status / footer bar | **1** (was 0) | `components/shell/StatusBar.tsx`,
>   mounted by `ChatLayout`" and "done — `StatusBar.tsx`". **The file does not
>   exist and nothing references it.** `c5748da0` (2026-10-12) added it and
>   `96fc04aa` (2026-10-12) deleted it — the same day, in the same week. It was
>   **never rendered**: `git log --all -S '<StatusBar'` over `ChatLayout.tsx`
>   returns **no commit at all**, and the file's own comment said so —
>   "`StatusBar` itself is left on disk but no longer rendered here." It has
>   never been in the app.
> - **The settings modal does NOT leave the app at full brightness.** §11.6
>   records the reference as "none — app stays at full brightness", and
>   `WorkspaceShell.tsx` was written to match that sentence — the backdrop
>   carried no tint and its comment repeated the claim. **The repo's own
>   capture says the opposite, twice**:
>   `docs/plans/2026-10-11-ui-reference-capture.md:20` — "A **centred modal**
>   on a dimmed chat behind it" — and `:252` — "The chat is dimmed behind it".
>   **The code has since been corrected** — the backdrop carries `bg-scrim`
>   again and the comment now cites the capture — so the false measurement
>   below is the record of what the code was built to match, not the state of
>   the tree.
> - **There IS model UI, and the model editor IS reachable.** §11.9 says "there
>   is NO UI left" for effort and that "the `ModelVisibilityModal` … is
>   unreachable. The editor and its Refresh button are gone from the product".
>   Both are false now: the composer footer renders `ModelEffortMenu` with
>   `onEffortChange` and `onEditModels`
>   (`frontend/desktop/src/sections/chat/ChatThreadComposer.tsx:593-601`), and
>   the modal is mounted at `frontend/desktop/src/sections/chat/ChatThread.tsx:1639`
>   with its opener at `:1386`. §11.9 also says `ContextRing` is "untouched and
>   still exported" — it was **deleted** in `9c014058`.
>
> **The whole test suite was deleted on 2026-10-17**, so every test count in
> this document (1678 vitest, 5143 pytest) is historical. The live gates are
> the static ones listed in §11.1.

# August Desktop UI Redesign Spec — minimalist, clean, still powerful

**Status: Approved by the user; implementation applied.** Core shell, composer,
navigation, Appearance, Skills/Plugins, and drawer changes are in the working
tree, plus the per-session token delta (L4), the transcript fixups, and the
settings IA/a11y corrections. Green at the time: `tsc -b`, **1678/1678 vitest**,
**5143 backend pytest**, ruff, mypy, `check:design`, `check:docs`, `check:version`,
`check:api`. **The two test counts are HISTORICAL — the whole suite was deleted
on 2026-10-17**; the live gates are the static ones listed in §11.1.
**Still open: the packaged-Tauri pixel pass** (screenshots need a
visible desktop window this environment does not have — §11.3 says what was
verified instead, and what that does not cover) and one settings accessibility
sweep that needs the user's ruling (§4.1).

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

### 1.2b Census re-measured (2026-10-10, 1000x700 dev-server render, after the redesign)

Re-measured with ONE script applied identically to every screen, so these rows are
comparable to each other. They are **not** directly comparable to the §1.2 table
above, which used a different definition of "leaf text"; where the method differs,
the §1.2 number is quoted and the delta marked *not comparable* rather than
quietly restated. Method: an element is visible when it has a non-zero box and is
not `display:none` / `visibility:hidden` / `opacity:0` — the shell parks a lot of
mounted-but-hidden drawer chrome that would otherwise dominate every count.

| screen | leaf text | buttons | icons | inputs | long prose | h1 |
|---|---|---|---|---|---|---|
| chat, empty | 193 | 109 | 75 | 2 | 2 | **1** |
| settings · general | 83 | 32 | 32 | 4 | 10 | 1 |
| settings · appearance | **40** | **30** | 31 | **5** | 2 | 1 |
| settings · providers | 21 | 21 | 22 | 1 | 1 | 1 |
| settings · memory | 46 | 31 | 25 | 2 | 8 | 1 |
| settings · skills | 57 | 35 | 30 | 12 | 0 | 1 |
| automations | 191 | 104 | 66 | 1 | 2 | 1 |
| board | 203 | 105 | 69 | 5 | 3 | 1 |
| runs | 596 | 168 | 244 | 1 | 41 | 1 |
| history | 185 | 102 | 63 | 1 | 1 | 1 |
| learning | 185 | 102 | 63 | 1 | 1 | 1 |
| live | 192 | 107 | 68 | 1 | 0 | 1 |

**The one unambiguous, method-independent win is Appearance: 37 inputs -> 5.** That
is §4.2 A3 (the Colour designer behind a disclosure) landing as specified, and it is
the number the whole Appearance argument rested on. Everything else moved by less
than the brief hoped, and two rows deserve honesty rather than a victory lap:

- **Runs is still 596 leaf nodes / 41 prose blocks.** §9 decision 7 explicitly kept
  `/runs` out of this pass, so it was expected to stay. It did.
- **Settings did not lose buttons the way the brief wanted.** The proposed ChatGPT
  toolbar (§4.1 S4) was NOT added: a survey of all 43 section components found 12
  that already own a search field, 11 that own a refresh, and 14 that own a primary
  action. A global toolbar would have duplicated ten of them and added chrome to
  the ~30 that have nothing to filter. See §4.1.

The sidebar numbers moved the other way, and the reason is data, not design: this
profile has 41 sessions and 18 of them have recorded usage, so the sidebar now
carries 18 more text nodes and 18 more rows than the profile the §1.2 baseline was
taken on. The per-row delta is `+input / -output`, keyed on the workbench id,
fetched for every VISIBLE row in ONE grouped query (`GET /api/usage/sessions`) and
absent for a chat with no recorded usage rather than rendered as `+0 -0`.
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
| Nav destinations surfaced in the sidebar | **0** nav rows + 3 workspace destinations (Artifacts moved to the right drawer) | `components/sidebar/SessionListNav.tsx` |
| Nav destinations surfaced only in ⌘K | **6 of 7** | `components/overlays/CommandPalette.tsx:410-429` |
| Composer controls | **50** (14 essential / 24 on-demand / 12 noise) | `sections/chat/ChatThreadComposer.tsx`, `composer/ComposerToolbar.tsx:246-504` |
| Composer popovers | **13** | `sections/chat/composer/useComposerPopovers.ts:93-95`, `:111` |
| Right-drawer section ids | **13**, of which **12 gesture-reachable** | `components/shell/RightDrawerState.ts:7-20`; `terminal` reachable only via the LLM ui-action allowlist `ChatLayout.tsx:179-186` |
| Settings sections registered | **43** (17 `basic` / 26 `hidden`) | `settings/settings-registry.ts` (ids after :158) |
| Settings sections with a component | **43** (implemented == registered) | `sections/settings/SettingsPage.tsx:345-396` |
| Rail rows rendered | **17** | `components/workspace/WorkspaceShell.tsx:278` |
| UI Designer colour controls | **18** | `lib/ui-customization.ts` `UI_TOKEN_DEFS` |
| UI Designer theme presets | **6**, of which **5 dark-only** | `lib/ui-customization.ts:185+` |
| Per-surface font-size controls | **4** (was 1) | `sections/settings/AppearanceSection.tsx` F2 |
| Status / footer bar | **0** | **The "1 (was 0)" was WRONG — there has never been a status bar in the app.** `components/shell/StatusBar.tsx` **does not exist**: `c5748da0` (2026-10-12) added it and `96fc04aa` (2026-10-12) deleted it, the same day, in the same week — and it was **never rendered** (`git log --all -S '<StatusBar'` over `ChatLayout.tsx` returns no commit; the file's own comment said "`StatusBar` itself is left on disk but no longer rendered here"). The only trace left is the comment where it used to be: `components/shell/ChatLayout.tsx:714-720` — "The full-width status bar … is removed … The dead `StatusBar` component was deleted with this comment." |

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

| # | Action | Citation | Kind | Status |
|---|---|---|---|---|
| S1 | Keep the rail's tier gate exactly as is. **Do not surface hidden sections.** A 43-row rail is the opposite of minimal. | `WorkspaceShell.tsx` | repaint | **done** |
| S2 | Move the 4 category headers out of the rail into a **content-pane breadcrumb** or drop them; a rail of 17 rows + 4 group headers reads as 21 rows | `WorkspaceShell.tsx` | repaint | **done** — the resting rail is a flat 17-row list; `SETTINGS_CATEGORIES` now only groups SEARCH results |
| S3 | Add a **per-page content header**: page title + one-line subtitle, matching ChatGPT's Skills pane | `sections/settings/SettingsPage.tsx` `SectionHeader` | bug fix | **partial, and the spec's diagnosis was wrong.** `account` does NOT double-render — it is not in `HEADERLESS_SECTION_IDS` (that set means "this component has NO heading, so inject one", which is why the name reads backwards) and renders a single `<h2>`. The injected header now covers 9 ids. Extending it to all 43 means deleting ~30 components' own headings, which is a different change than this row describes. |
| S4 | Add the ChatGPT toolbar to the content pane: **search field + Refresh + gear + a primary action button** | new | new capability | **assessed and declined — do not build.** Surveyed all 43 section components: 12 already own a search field (Skills, Memory, Integrations, AllModels, Inspector, AuditTimeline, LogsSubtab…), 11 own a refresh (Harness, ExternalAccess, BrainBackups, Memory, Update, …), 14 own a primary action (Integrations "Add", AISetup "Refresh model list", ToolGrants "Revoke", …). One shared toolbar would duplicate ~10 pages and put chrome on the ~30 with nothing to filter. `SettingsSectionShell` exists with `actions`/`toolbar` slots and exactly one consumer, neither slot passed — the extension point is there if a section ever wants it. |
| S5 | Fix the "N of M" denominator — M is 43 but the rail shows 17, so the counter is unreconcilable | `WorkspaceShell.tsx` | bug fix | **done** — now reads `2 of 43 sections · 17 in the rail`. Both numbers are true and they are different questions (searchable vs. drawn); naming only one of them is what made it look broken. Also `role="status"`, because filtering a rail was otherwise silent. |
| S6 | `model-families` lands in the Agent group despite its own `category: 'capabilities'` arithmetic comment; make the grouping explicit rather than incidental | `src/settings/settings-registry.ts` | repaint | **done** — the field is the grouping mechanism for both rail and search, so the entry's array position is inert; a comment now says so where the entry sits in the Data block. |

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

**F2 shipped 2026-10-10, and the control is a pill, not a `<select>`.** Each row renders
one outlined pill showing the current value (`Interface [15 px]`), opening a Radix
dropdown — the reference shape. It was previously a native `<select>`, which drew the
platform’s own dropdown affordance and ignored the theme, on the page that is supposed to
be four quiet rows. Measured on the live render: native `<select>` elements on the page
**4 → 0**; the four pills read `15 px / 16 px / 16 px / 14 px`. The pill lives in
`components/ui/ValuePill.tsx` and is generic, so the next per-surface control reuses it.

**The global 4-step "Text size" picker was deleted from General, not migrated.** It had
already been marked `inert` — a visible control that could not be pressed — while these
four rows became the working replacement, so the most-visited settings page was showing a
dead duplicate. 55 lines removed. `data-text-size` itself is untouched and still scales the
root rem for surfaces with no per-surface override, so an existing user who had picked
"spacious" keeps it; only the dead UI went.

### 4.4 Settings modal a11y — **the first half shipped; the Escape claim is false**

Measured 2026-10-10 against the source, and the row above is wrong about all three
of its claims:

- `WorkspaceShell` **is** `role="dialog" aria-modal="true"` with `aria-label="Settings"`.
- It **does** have a focus trap (`useFocusTrap(true)`, Tab and Shift+Tab cycle, focus
  restored on unmount).
- The nested-confirm double-fire **is already handled**: the document Escape handler
  scans `[role="dialog"]` for any dialog other than itself and bails if one is open.

What is genuinely still open, in the dialog contract and the rail:

| # | Finding | Where |
|---|---|---|
| a | **`aria-modal` is claimed without `inert`.** The focus trap contains Tab, not the accessibility tree — a screen-reader virtual cursor can still reach the chat behind the scrim. | `WorkspaceShell.tsx` |
| b | **`<nav>` and `<aside>` in the rail have no accessible name.** Two navigations are on screen (this one and the app sidebar); neither is distinguishable by name. | **fixed** — `aria-label="Settings"` / `aria-label="Settings sections"` |
| c | **Rail rows are `<button>`, not links.** `aria-current="page"` is legal on them, but navigation semantics are lost: no `href`, no open-in-new-tab. | `WorkspaceNavLink.tsx` |
| d | **Icon-only buttons with no accessible name.** `ComputerUseSection.tsx:82` (Health-Checks refresh) had neither `aria-label` nor `title`; `MemorySection.tsx:990` had `title` only. | **fixed** — both carry `aria-label` |
| e | **`role="tablist"` without `aria-controls`, roving `tabIndex`, or arrow keys.** `SettingsTabs.tsx` (vertical + horizontal) and `HarnessImprovementsSection.tsx`. Every tab is in the Tab order and `aria-selected` is set without pointing at a panel. | `SettingsTabs.tsx` |
| f | **The search-result counter is not announced** — filtering the rail gave a screen reader no feedback. | **fixed** — `role="status"` |
| g | **Heading duplication, product-wide.** `ChatTitlebar` renders the route title as the screen's `<h1>` on every route, and ~20 page components render their own `<h1>` too. | see below |

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
| L4 | **Per-row token delta** (+input / −output) beside the timestamp — the Haze row signature. | `components/sidebar/SessionRow.tsx`, `session-usage.ts` | new capability |
| L5 | **Coloured status dot per project folder**, the KiloCode pattern | `components/sidebar/FolderTree.tsx:133-153` | repaint |
| L6 | Fold the sort toggle into the "Chats and tasks" header instead of a floating text button | `SessionList.tsx:695-709` | repaint |
| L7 | Delete the three inline tutorial blocks (search-empty, empty-folder, empty-tasks) — no reference has prose inside its sidebar list | `SessionList.tsx:742-754`, `:892-899`, `:963-970` | repaint |
| L8 | Move the update-check button into the account row's dropdown (an "update" action already exists there) | `SessionList.tsx:1060-1073`, `:230-232` | repaint |
| L9 | **Do not** reduce history to "5 recent + more" or move it to a popover — ChatGPT shipped both and reverted | — | invariant |
| L10 | Keep: brand bar, hide toggle, New chat, Pinned, search, session rows, View all, account row, resize handle, date headers, needs-attention lane | §7 of the shell audit | keep |

**L4 shipped, and the "just call the existing read" plan would have been wrong.** The
existing read is `GET /api/usage/session?id=…`, which per call fetches up to 500
per-event rows AND sweeps the pricing table once per session to price them. Rendering
that per row turns a sidebar list into N round trips, each dragging back a transcript
the row never reads — a list render fanning out over the network. So:

- `memory_store.get_usage_batch(sessionIds)` — one `GROUP BY session_id`, keyed by the
  id the caller asked for, capped at `MAX_USAGE_BATCH_IDS = 250` (well under SQLite's
  bound-parameter ceiling). A session with no usage rows is ABSENT, not zero: the row
  renders no delta rather than claiming `+0 −0`.
- `GET /api/usage/sessions?ids=…` — the router door; `memory_store` export,
  `usageApi.sessions()`, the OpenAPI schema and the generated TS types all updated
  (`npm run gen:openapi && npm run gen:api`, and `check:api` confirms no drift).
- `SessionList` asks for exactly the ids it is about to MOUNT — pinned, each unfolded
  folder's capped pool, the Tasks pool — so a 2,000-chat history still sends a bounded
  list, and one query is published through `SessionUsageProvider` so `SessionRow` stays
  a pure `memo` component instead of taking a prop through four render pools.
- Keyed on `workbenchSessionId || id`, the same form `record_usage` writes and the same
  key the status bar and composer chip read, so all three agree on one chat's numbers.

A backend test asserts the batch is ONE `usage_events` statement regardless of how many
sessions are asked for — that is the property the endpoint exists for, and it is the
one a future "optimisation" would break.
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

### 6.3 Transcript — audited item by item; two were already true, two were fixed

Each row below was checked against the source, not assumed from this document. Three
of the six claims in the original text did not survive contact with the code.

| # | Claim | Verdict |
|---|---|---|
| error states | "History-load failure and the `agentsQuery` failure render nothing today" | **Already implemented, and untested.** History: `ChatThread` selectors -> a named failure + a "Try again" that calls `retrySessionHistory`. Roster: a `role="status"` note. Both existed before this pass. |
| error states | … | **Improved + now tested.** Both blocks moved out of the 1,700-line `ChatThread` into `TranscriptErrorStates.tsx`, which is what made them testable at all, and the roster note gained a real **Retry** button — it previously said "retrying" while offering nothing to press, leaving the user waiting out the 10s poll. 4 new tests. |
| reasoning | "Reasoning streams append-only, never smooth-reveal" | **Already true.** `useSmoothReveal` is applied in exactly one place, on the final answer (`AssistantBlockTimeline` `renderFinal`), never on reasoning. `ThoughtStep` renders `<Markdown live>` directly. No change made. |
| `hideProgress` | "delete `hideProgress`" | **Already gone.** The prop does not exist; `ToolCallItemBody` is the single owner of progress entries. Two stale comments still named it — deleted. |
| 39/40 | "verify row visuals at 39/40 messages" | **Now a real test** (`VirtualizedMessageList.test.tsx`). See the correction below. |
| collapse machines | "one disclosure primitive" | **NOT done — and the three machines are not the defect.** See below. |
| ToolStepRow | "fold into `ToolCallItem`" | **NOT done — declined.** See below. |

**The 39/40 correction.** This spec has always implied the virtualized branch double-
pads: the container carries `px-4` and so does each row. It does not. An absolutely
positioned child lays out against the containing block's PADDING box, so it ignores
the parent's `px-4` and needs its own to land in the same place. Removing that `px-4`
— which reads exactly like a duplicate — would move every row 16px left the moment a
thread crossed 40 messages. The new test pins both halves of that pair, because the
bug it prevents is invisible until someone tidies the "duplicate" away. It also pins
`space-y-5` (20px) against the virtualizer's `gap: 20`, and asserts that search
navigation is NOT handed a disabled virtualizer below the threshold.

The measurement caveat is real and is in the test: **jsdom has no layout engine**, so
every `getBoundingClientRect()` is 0 and a pixel comparison would pass for the wrong
reason. The test asserts the class contract instead, and says so.

**Why the collapse consolidation is still open.** The three machines are real
(`expandOverrides`, `ActivitySummary`'s own open state, `ThinkingDisclosure`) plus two
the spec never mentioned (`ExploreGroup`, `SubagentDelegateRow`, both uncontrolled).
But the concrete defect underneath is narrower and IS now fixed: `ActivitySummary` took
two independent collapse triggers — `collapseWhen` and the falling edge of `live` — and
`AssistantBlockTimeline` stacks both on every turn, so each turn ran two closes. They
are one predicate now. Merging the three machines into a shared primitive is still a
real change, and it is blocked by a source-regex guard (`thinking-persistence.test.tsx`
asserts `setExpandOverrides` appears in `AssistantBlockTimeline` in a specific shape, so
renaming or moving it fails the test) plus a 582-line `ToolStepRow` suite and per-file
element-count pins in `design-baseline.json`. That is a phase, not a cleanup.

**Why `ToolStepRow` was not folded in.** The two components are not two renderings of
the same row: they differ on five behaviours (parent-owned vs. self-owned open state,
`denial` error tone, read-duration format, a 120s stall warning, a minimal-output lock,
and the command pill). A merge would produce one component with five boolean branches
and two unrelated callers — `ToolCallItem` renders inside `SubagentTimeline`,
`ToolStepRow` inside the process rail and `ToolCallCard`. Left separate.

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
`ChangesCard`, `ModelEffortMenu` (merging),
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

| Phase | Work | Kind | Risk | Verify after | Status |
|---|---|---|---|---|---|
| **0. Defects** | §7, 9 items, no taste involved | bug fix | **Low** | G6: ⌘K shows 17 not 43; G2: a failed tool shows a cross; G3: the toggle is gone or works | done |
| **1. Status bar** | §5.3 B1–B3 | **new capability** | Med | workspace · branch · model · token delta · context % all read correctly at rest and mid-stream | **NOT DONE — and never was.** `StatusBar.tsx` was added by `c5748da0` (2026-10-12) and deleted by `96fc04aa` (2026-10-12), never mounted in any commit. The reference-fidelity pass put the model name on the composer footer instead (`ChatThreadComposer.tsx:589-602`) and left the token delta on the sidebar rows. **Do not report this phase as done.**
| **2. Sidebar** | §5.1 L1–L10, incl. workspace switcher + nav rows + TERMINAL tab | **unlocks existing** + repaint | Med | switch workspace from the sidebar; every nav row navigates; Terminal tab opens the dock; update `SessionListNav.test.tsx` | done, L4 included this pass |
| **3. Composer** | §6.1 C1–C11 | new capability + repaint | Med | send, stop, steer, attach, switch model, switch effort, queue, voice — all still work; count the visible controls and confirm 8 permanent | done; C11 (disclaimer) kept per decision 3 |
| **4. Settings IA** | §4.1 S1–S6 | repaint + bug fix | Low | rail renders 17 rows and no group headers; every page has a title; the N-of-M counter is honest | S1–S3, S5, S6 done; **S4 assessed and declined** — see §4.1 |
| **5. Appearance** | §4.2 A1–A5 + §4.3 F1–F3 | **new capability** | Med | segmented control switches theme; 5 swatches apply; 4 font-size rows each scale only their surface; Designer behind a disclosure still applies | done — **37 inputs → 5**, measured (§1.2b) |
| **6. Empty state + transcript** | §6.2 E1–E4, §6.3 | repaint | Low | empty chat reads as the reference; a 40-message thread renders identically at the virtualization boundary | E1–E4 + §6.3 error states + the 39/40 test done; **disclosure consolidation open** — §6.3 |
| **7. Drawer** | §5.2 D1–D5 | bug fix + performance | Med | overflow toasts; 5+ subagents; the elapsed ticker no longer re-renders the timeline | done |
| **8. Tokens & motion finish** | §3 T1–T6 | repaint | Low | `check-design` still zero-new-drift after `--update`; light and dark both pass on every changed screen | T2 verified (16px, both modes); zero new drift |
| **9. Collection surfaces** | Skills card grid + plugin roster, ChatGPT pattern | **new capability** | Low | search filters the grid; a card's checkmark reflects enablement | done |
| **10. Census re-run** | Re-measure §1.2 and publish the delta | — | — | every row improved or explained | **done — §1.2b**, method stated, and the rows that did not improve explained rather than hidden |

**After each phase**, re-run the DOM census and confirm the reduction is measured
rather than asserted, and confirm by clicking: **send, stop, switch model, attach a
file, approve a tool call, answer a clarification, see an error.** Approvals,
clarifications and destructive confirmations are essential by definition and are never
moved behind a toggle.

---

## 10. Decisions resolved from the user's approval

1. Sidebar destinations: Automations, Board, and Learning; other routes remain
   available through the command palette.
2. Keep the quiet session usage readout in the status bar.
3. Preserve the composer disclaimer.
4. Add the TERMINAL tab to Sessions and Bots.
5. Keep named appearance themes distinct from the Colour designer.
6. Keep Artifacts in the right panel as the single entry point.
7. Preserve `/runs` as a data surface; its density was not part of this shell pass.
8. Use the collection card grid for Skills and Plugins.

The user asked to proceed with the redesign.
---

## 11. Verification state (2026-10-10)

### 11.1 Gates

| Gate | Result |
|---|---|
| `npm run typecheck -w frontend/desktop` | pass |
| `npm run test:frontend` | **1678 / 1678** across 219 files — **HISTORICAL: the suite was deleted 2026-10-17** |
| `pytest -q -n auto` (`backend-py`) | **5143 passed**, 4 skipped, 0 failed — **HISTORICAL: the suite was deleted 2026-10-17** |
| `ruff check .` / `mypy app/` | pass / pass (338 files) |
| `npm run check:design` | pass — 497 baselined, **0 new** |
| `npm run check:docs` / `check:version` / `check:api` | pass / pass / no schema drift |

> **The two test rows are the record of what this was verified with, not a gate
> that exists.** The whole test suite was deleted on 2026-10-17. **The live
> gates now are:** `npm run check:docs`, `check:design`, `check:naming`,
> `check:api`, `check:api-index`, `check:sse`, `check:version`, `check:doc-links`,
> `check:minisign`, `check:truncate`, `check:brain-config`, `lint:ratchet`;
> `npm run e2e:smoke`; `cd backend-py && uv run ruff check . && uv run mypy app/`;
> and `npm run check -w frontend/desktop` (tsc + eslint).

The handoff reported all test execution as environmentally blocked (`uv` missing, a
Python launcher failure before collection, `EPERM` resolving `vitest/dist/spy.js` and
`frontend/desktop/index.html`). Those blocks are gone — `node_modules/vitest/dist/spy.js`
resolves, and `backend-py/.venv/Scripts/python.exe` carries pytest 9.1.1 and the full
dependency set. `uv` itself is still absent, so the suite ran through that venv instead
of `uv run pytest`; the commands are otherwise identical, `-n auto` included.

Four tests were red on arrival for reasons that had nothing to do with the environment,
and all four are fixed rather than skipped:

| Test | Why it was red | Fix |
|---|---|---|
| `ComposerWorkspaceChips.test.tsx` | asserted "shows the bound folder name **and its branch**" — the branch chip was deleted on purpose (§6.1 C6) and the component no longer imports `@/api/git`. The test was guarding removed behaviour. | Rewritten to assert the folder chip AND the absence of a branch chip, so the "one home for the branch" rule is pinned instead of silently lost. |
| `QueuePills.receipt.test.tsx` | asserted an inline "Edit queued message" button — §6.1 C7 moved edit/promote/move behind the pill's overflow menu. | Asserts the permanent control set (cancel + overflow). It deliberately does NOT open the Radix menu: that needs `PointerEvent` plus a capture/release pair jsdom lacks, and every attempt tested the environment rather than the component. |
| `ChatMarkdown.perf.test.tsx` | a load-sensitive ratio gate, as its own long comment predicts. Min-of-3 rounds was not enough on a machine running 219 files in parallel — the React side waits on scheduling while the parse side does not, so contention slows them unequally. | The measurement re-runs until it clears the gate (bounded at 3 attempts) and reports the best ratio. A real regression — the live path slower than legacy, a ratio near 1 — cannot clear it in any attempt. |
| `test_tranche2_regressions.py::test_no_module_referenced_the_removed_names` | shelled out to GNU `grep -rn --include=*.py -E`, which does not exist on Windows, so on every dev machine there it raised `FileNotFoundError` instead of reporting a dangling reference. | The equivalent scan, in Python. Same question, runs everywhere. |

### 11.2 What the visual pass found

The desktop app was run and driven for real (Vite dev server + the SPA at 1000×700).
The census in §1.2b is measured output, not an estimate. Three defects surfaced that no
test or guard was watching for, and all three are fixed:

| Finding | Fix |
|---|---|
| **The chat screen rendered two `<h1>`s** — the titlebar's chat title and the empty state's "What should we work on?", both on screen at once. A screen with two page titles has no page title, as far as heading navigation is concerned. | Empty-state title is a `<p>` now; the titlebar owns the one `<h1>`. |
| **The same duplication on `/runs`, `/board`, `/history` and `settings/memory`** — the titlebar renders the route title as `<h1>` on every route, and these pages render a second one. | All four demoted to `<h2>`; visual classes unchanged. |
| **The new token delta sat at ~2.4:1 contrast** — `text-success/75` on the sidebar ground. Measured, not eyeballed. | Full-opacity `text-success` / `text-danger`: **3.18:1 / 3.98:1 light, 8.04:1 / 6.58:1 dark.** Still under AA for normal text in light mode — deliberately, matching the sidebar's own quiet tier at 2.29:1 — with the exact figures on hover. Raising it further would make 60 rows a wall of green and red, which is the opposite of the reference. |

### 11.3 What the visual pass does NOT cover

**No pixel-level screenshot pass happened.** `browser.screenshot` refuses a tab whose
window is not visible, and this environment reports `document.hidden: true` with no
desktop surface to show. Verified instead, in both `data-theme` modes, by computed style:

- the composer textarea resolves to **16px** in light and dark (§3 T2 holds);
- the status bar resolves a mode-appropriate muted foreground over a transparent fill
  and a hairline top border (§5.3 B2);
- the per-row delta resolves distinct success/danger colours per mode;
- the sidebar renders the three tabs `Sessions | Terminal | Bots` and 18 usage deltas
  against a live 41-session profile;
- the settings rail renders 17 rows.

That is not a substitute for looking at it. **Still owed: a pass in the packaged Tauri
app, light and dark, across the changed surfaces** — settings pages, sidebar, composer,
drawer, transcript. Three things only pixels will settle: whether the delta row reads as
too loud beside the timestamp, whether the status bar's 32px strip is right at 100%
scale, and whether Appearance still reads as five swatches and two segmented controls
now that the Colour designer sits behind its disclosure.

### 11.4 Open, and deliberately so

1. **Settings heading sweep — needs a ruling.** 20 settings/page components render an
   `<h1>` under a titlebar that already renders one. The rule is unambiguous (the
   titlebar owns the h1; pages own an h2), and fixing all 20 is one tag each, but it
   rewrites the document outline of every settings page and one test asserts `level: 1`
   (`ObservabilitySection.test.tsx`). The four measured duplicates were fixed; the rest
   are reported, not silently swept.
2. **Transcript disclosure consolidation** — the actual mechanism is fixed, the shared
   primitive is not. §6.3 says why it is blocked rather than merely undone.
3. **Settings `aria-modal` without `inert`**, and `role="tablist"` without
   `aria-controls` or roving focus. Both real, both in §4.4.
4. **The packaged-Tauri pixel pass**, above.

### 11.6 Settings panel geometry — the panel covered the app instead of floating over it

Reported as two symptoms: the reference arranges settings differently, and opening settings
in August changes the background. Both were measured against the reference render rather than
argued from taste, and both were structural, not cosmetic.

| | August (measured) | Reference (measured) |
|---|---|---|
| Panel height | **92%** of the viewport, at any window size | ~57% (680px in a 1200px window) |
| Panel width | up to 1180px | ~880px |
| Backdrop | `rgb(0 0 0 / 0.55)` in dark mode | **none** — app stays at full brightness — **WRONG. The repo's own capture says the opposite, twice:** `docs/plans/2026-10-11-ui-reference-capture.md:20` — "A **centred modal** on a dimmed chat behind it" — and `:252` — "The chat is dimmed behind it". The reference DOES dim the app behind the modal. **The code was corrected to match the capture: the backdrop carries `bg-scrim` again.** |
| Reading column | **361px** | ~640px |
| Rail | 240px, correct | ~180px |

**Height.** The dialog was `h-full max-h-full` inside a `fixed inset-0` flex box, which pins
it to the full viewport height minus padding. That is why it read as "the background changed":
a near-full-window panel. Now `max-h-[min(680px,calc(100vh-4rem))]` — the reference’s exact
measured height, with `min()` so a short window scrolls internally rather than overflowing.

**Backdrop.** `bg-scrim` resolved to `--dt-overlay-scrim`, which is **55% black** in dark mode and
32% in light. ~~The reference leaves the sidebar, transcript and composer completely untouched.~~
**That is FALSE, and the code below was written to match it.** The repo's own reference capture
says the opposite, in two places: `docs/plans/2026-10-11-ui-reference-capture.md:20` — "A
**centred modal** on a dimmed chat behind it" — and `:252` — "The chat is dimmed behind it". The
reference DOES dim the app behind the modal.

The tint was therefore removed outright (`rgba(0, 0, 0, 0)` measured) on the strength of a
sentence the repo's own capture contradicts, and `components/workspace/WorkspaceShell.tsx` carried
the same wrong claim in a code comment: *"The backdrop carries NO tint. The reference settings
modal floats over a completely unchanged app — sidebar, transcript and composer all stay at full
brightness."* **That comment was the bug, and the capture was already in the repo to refute it** —
`docs/plans/2026-10-11-ui-reference-capture.md:20` and `:252`, the same file the §11.6 "Reference
(measured)" column was built from.

**The code has since been corrected to match the capture**: the backdrop carries `bg-scrim` again
(`--dt-overlay-scrim` — 32% over the light ground, 55% over the dark one, the same veil the
responsive sidebar and drawer overlays already use), and the comment in its place cites the capture
by line. **So the false statement in this section is the record of what the code was built to
match — not the state of the tree.** Do not "fix" the backdrop back to transparent on the strength
of the old text.

What is still true in this paragraph: modality was never enforced by the tint — it is enforced by
`aria-modal="true"` and the focus trap, neither of which is visual — and the backdrop element
stays a `fixed inset-0` hit target, so click-outside-to-close and Escape are unaffected either
way. The height and column-width findings below are unaffected by the tint question.

**Column width — the one that had a test pinning it.** The region carried `pr-60`, mirroring the
rail’s 240px on the right to centre the column on the *window* rather than in the space the rail
leaves. Measured cost: **361px of usable column inside an 848px panel**. And the centring it
bought is not a reference behaviour: in the reference the dialog spans 520..1400 (centre 960, the
window centre) while the content pane spans 731..1372 — centre 1051, **91px right** of window
centre, because the rail sits inside the modal. A left rail in a centred dialog pushes its
content right by construction. So `pr-60` bought nothing and cost 240px.

`workspace-shell-tier-filter.test.tsx` asserted `pr-60` was load-bearing. That test was pinning
the wrong claim as though it were a requirement, so it is rewritten rather than deleted: it now
asserts the region carries **no** rail-width pad and that the column cap stays tied to the rail’s
own width, which is the invariant that actually matters.

**Two defects found while fixing the first one, both caught by measuring after the change:**

1. Adding `flex-col` to the dialog while capping its height collapsed the content region to
   **h=0** and let the rail overflow the panel. The dialog is a **row** — rail left, content
   right. Caught by measuring, not by a test: jsdom has no layout engine.
2. With the height now content-driven, the rail’s `h-full` resolved against an indefinite parent
   and fell back to its own content height: **670px inside a 636px panel**, with the profile
   footer clipped by the panel’s `overflow-hidden`. Fixed by dropping `h-full` and letting
   `align-items: stretch` + `min-h-0` size it to the panel.

Final measured: panel 848x680 centred, rail 240x678 fitting inside it, **reading column 601px**
against the previous 361, backdrop fully transparent. The Appearance pane now matches the
reference’s structure exactly — Theme (5 swatches), Mode (segmented), Font size (4 rows, one
pill each, right-aligned) — in a column wide enough to hold it.
### 11.7 All-14-reference pass — right drawer, chat text volume, resize

All fourteen screenshots re-read in one pass and every surface re-measured. Four changes.

**Right drawer (Claude).** Measured August's at 420px, which is right in absolute terms
(~22% of a 1920 window). The gap was the card, not the width. Claude runs **one full-width
row per artifact**; August ran a `grid-cols-2`, which gave each card ~200px inside a 420px
drawer — an icon tile and a filename truncated to about a dozen characters. The name is the
thing you scan for. Three differences closed: 2-column grid → single-column rows; the
`timeAgo · jump` metadata line under each card removed (two pieces of text per artifact that
nobody asked for, with the timestamp moved to the row's tooltip and `jump` kept as a button);
and the folder/download actions made permanently visible rather than hover-only, because on
that row the folder button is the primary action, not a secret. `Download all` was already
correct — it is conditional on `downloadable.length > 0`, so it is correctly absent at zero
artifacts.

**Not verified live.** This profile has **0 artifacts**, so the populated row was checked by
source and by the existing RightDrawer tests (96 passing across those suites) but never
rendered. That is the one change in this section without a measurement behind it, and it is
called out rather than presented as done.

**Chat text volume.** Three findings, measured in the rendered chat column:

1. **Two timestamps per exchange, in two different cases.** The user bubble rendered its
   `MessageTimestamp` with `bubble-footer-text`, which sets `text-transform: uppercase`, so
   the same exchange showed **`9M AGO`** on the user message and **`9m ago`** on the
   assistant's — the same component, twenty pixels apart, disagreeing about the same moment.
   The reference draws **no timestamp on a user message at all**; its only time marker is one
   `5 minutes ago` at the end of the assistant action row. Removed from the user bubble; the
   assistant still carries it, so the fact is stated once, in one case, where the reference
   puts it. Verified: `23m ago` now appears once, sentence case.
2. **`A U G U S T |` wordmark on the status line.** Six separately-animated letters plus a
   caret, 18px tall, spelling a name already in the sidebar header and again in the status bar
   at the foot of the window. Claude's activity line is `···  <title>  <elapsed>  ⌄` and the
   word "Claude" appears nowhere in it. Removed; the progressive sentence stack below is that
   same line and is the part worth the pixels. Verified: `aug-letter`/`aug-caret` spans = 0.
3. **The composer disclaimer is NOT excess.** It was measured at 74 characters and is the
   single largest text item under the composer — but it is the reference's sentence nearly
   verbatim ("Claude is AI and can make mistakes. Please double-check responses."). Kept.

A suspected bug was checked and **did not exist**: `innerText` reported the wordmark as
`A\nU\nG\nU\nS\nT` because each letter is a `display:block` span inside a flex row, which
`innerText` breaks per block. Measured boxes put all six at y≈655, x=555..619 — one horizontal
row, not a vertical stack.

**Resize.** No resize API exists in this environment, so the panel was measured by forcing
widths and reading the real boxes. Two defects, both in settings, both real:

| Panel width | Before | After |
|---|---|---|
| 560px | column 313px, `Dark` outside the Mode control | column 377px, **nothing overflows** |
| 420px | column 173px, System/Light/Dark + all 4 pills overflow | column 237px, **nothing overflows** |
| 340px | column 93px, **horizontal scrollbar** | column 157px, no scrollbar |

The rail was `w-60` (240px) at every width and never yielded. It is now `w-44 sm:w-60`. The
`sm:` breakpoint is viewport-keyed, which is correct here and worth stating why: the dialog is
`w-full` inside the viewport, so a narrow dialog implies a narrow viewport, and the two move
together. (Forcing the dialog narrow *at a wide viewport* — the first thing tried — decouples
them and is not a state the app can reach; the first "fix" appeared to do nothing for exactly
that reason.)

The Mode control and the font rows then each overflowed on their own: both sat in a
`justify-between` row beside a control that could not shrink, so `flex-wrap` could never
engage. `shrink-0` removed from the segmented group and `flex-wrap` added to it and to the
font rows. Below ~480px of column the control wraps to two and then three rows rather than
poking outside.

**Known floor, stated rather than hidden:** at a 280px panel (a 256px window) the content column
is 97px and content still overflows with a horizontal scrollbar. That is below any realistic
window and is left as-is.
### 11.8 Memory — the page was showing nothing about memory

Reported as "the way we show content of the memory is still meaningless". Two separate causes,
and the second one is not a layout problem at all.

#### What August actually has stored (read-only probe of `data/august_brain.sqlite`)

```
facts: 13 rows, ALL kind=profile, category=general, scope=global
  description: populated on 0 of 13
  value shape: {"fact": "..."} on 13 of 13
  sample:  profile:n0  -> {"fact": "Profile detail 0 describing the person reading this right now."}
           profile:leak -> {"fact": "A profile fact from a neighbouring test file."}
  no `memory` or `heuristics` table exists in this database at all
```

**These are test fixtures, not memory.** Every value is synthetic text, and one row is named
`profile:leak` and says so outright. So the page was not *rendering* real memory badly — there
was no real memory to render, and any layout would have looked thin.

**They are stale, not actively being written.** `tests/conftest.py` has an autouse
`isolatedData` fixture that redirects `AUGUST_DATA_DIR` and `AUGUST_BRAIN_SQLITE_FILE` to a
per-test `tmp_path`, so the suite cannot reach the live store. Re-ran
`tests/test_profile_memory_lane.py` (the file that mints these exact rows) and re-probed: still
**13 rows, same `updated_at`**. The residue predates that fixture. It is safe to clear and is
**left in place** — deleting rows out of a user’s memory database is not a change to make
unasked, and it needs the user’s decision, not this document’s.

#### The display problems, which are real regardless

1. **The browse was not on the page.** The Memory section opened with ~1,600 characters of
   toggle prose — five switches, each with a paragraph — and **zero** stored memories. The list
   was one click deep behind an "All global memories" row. The reference makes the list the
   page. The 306-line browse group now renders **above** `Memory behavior`; the toggles stay on
   the page, so the 2026-10-03 ruling that the gates render in every pane is kept. They are one
   scroll below the content they govern instead of above it.
2. **A 56px kind chip on every row.** The reference has no per-row kind marker — it groups
   (You / Topics / Areas) and lets the group label the row. August already had the axis:
   `kind` is a closed vocabulary on the write door (`_FACT_KINDS` = fact, lesson, preference,
   skill-note, profile), so the groups are the kinds the store already enforces, not invented
   buckets. `profile` is the always-in "who the user is" lane, which is exactly the
   reference’s "You". Chip removed; kind is a group header when a kind filter is active, and
   `data-kind` on the row remains the stable contract.
3. **Literal quotation marks around every title.** `“{entry.title}”` made each memory read as
   a verbatim blob lifted out of a transcript — which is what a machine key looks like, not
   what something you asked August to remember looks like. Removed.
4. **Long facts were truncated into a tooltip.** `title` and `summary` are the same string for
   a short fact (both derive from the body), so a second column would print the same words
   twice. But the backend caps the derived title at 60 chars (`derive_fact_title`), so for any
   fact longer than that the two genuinely differ — and that difference was only reachable via
   the row’s `title` attribute. The second column now renders **only when it says something
   the name does not**.
5. **The detail pane had no labels.** It showed an unlabelled markdown block followed by
   `source: … · confidence: … · created: … · updated: …` — four facts of equal importance in
   one undifferentiated sentence. Now the reference’s three labelled fields: **Last updated /
   Summary / Details**, with `updated` promoted out of the provenance run-on. `Summary` is
   omitted when it is identical to the title, because printing it twice is an echo — an existing
   test (`MemorySection.layout.test.tsx`) already pinned that and caught a first attempt that
   reintroduced it.

#### Data-model gap worth naming

The reference’s memory is organised into **named topics**: a name (`Hardware`), a one-line
summary, and details. August’s `facts` table has `fact_key` (a machine key like
`profile:n0`), `title` (auto-derived from the body, ≤60 chars) and `fact_value`. There is no
separate human-chosen topic name, which is why every row reads as a sentence rather than as
something you would recognise. The row work above extracts what the data can already support;
a real topic name would need a new field and a write-door change, which is a product decision
rather than a repaint, and is not taken here.
### 11.9 Four reported visual bugs — root causes and fixes

Every item below was independently verified by a subagent before being called done.
The first verification round REJECTED the original duplicate-render fix; that rejection is
recorded here because it changed the answer.

#### 1. Duplicate tool rows in the transcript

**Root cause.** Two representations of the same tool call both rendered. Since migration 047 a turn’s
tool activity lives in the ASSISTANT message’s `blocks`, which `AssistantBlockTimeline` renders
collapsed under "Task completed · N steps". The transcript still also carries the pre-047 shape: one
standalone `role:'tool'` row per result. The bubbles read as identical because an Anthropic
`tool_result` carries `tool_use_id` but **no `name`** (the name lives on the parent assistant’s
`tool_use`), so `transcript_blocks.py` wrote an empty name and every row fell through
`getToolLabel`’s `formatFallbackLabel` to the single literal string **"Executing Tool"**.

Measured on `wb_20260905_022058_f49228` (live API, 43 messages):

```
assistant toolCall blocks : 30   status "running", result EMPTY on 30/30
standalone tool rows      : 30   status "done",    result on 30/30
                                       26,195 characters of tool output
clientMessageId present   :  0
```

### Three attempts. The first two were wrong.

**Attempt 1 — drop the rows. REJECTED.** Removing the standalone rows removed the duplicate but
destroyed data: the assistant blocks carry the NAME and an empty result, the rows carry the OUTCOME.
It left 30 tools at `status:'running'`, which `ToolStepRow` renders as an expanded, permanently
spinning, empty row — and the duplicate bubble had been the only place the output was still visible.
The backend states the contract itself: `_tool_use_block` in
`memory_store/transcript_blocks.py` documents that "status stays 'running' until a tool-result
message fills the result in (same by-id merge the live reducer does)". The live reducer does that
merge; the restore path did not.

**Attempt 2 — merge then drop, server side only. REJECTED.** `mapRemoteMessages` merged each row’s
outcome into its assistant block and dropped the row. Correct — and it changed nothing on screen,
because a warm reload never fetches: `hydrate` marks history `status:'ready'` whenever a cache
exists and `ensureSessionHistory` returns early on `'ready'`. The 141 KB `chat_messages_<session>`
cache was served straight from localStorage with all 30 rows still in it.

**Attempt 3 — the cache cannot be repaired, so stop reading it. SHIPPED.** A v1 cache is
unmatchable, not merely un-repaired: its tool row has no `toolUseId` (the field did not exist) and no
id inside `tool`, while the block is keyed `call_…`, so there is no join key at all. And
`persistMessagesDebounced` rewrites the poisoned cache on every transcript change, so it never
self-heals.

* `toolUseId` is now a declared field on `ChatMessage` **and** listed in `STRUCTURED_FIELDS`, so the
  restore carries it and `persistMessages` writes it. That is the join key a v2 cache is matched on.
* `loadMessagesForSession` runs `dropDuplicatedToolRows` — the same merge+drop — over the cache,
  now that the key exists. It indexes the rows in a **Map**: the first version called `messages.find`
  inside a `.map`, i.e. O(blocks × messages) on session open (measured 109 ms at 4,000 messages,
  1.34 s at 8,000/6,000).
* The cache key is now `chat_messages_v2_`. Every v1 cache reads as absent exactly once, so each
  session refetches, merges by id, and repersists correctly.
* Five production sites hardcoded `chat_messages_` (`store/sessions.ts` ×4,
  `store/sessions/helpers.ts` ×1) and were routed through `messagesStorageKey` /
  `legacyMessagesStorageKey`, so the rename cannot desync them and a session delete still clears
  both. Routing them through the helper is also strictly better than duplicating the literal.
* `name` fallbacks are `||`, not `??`: an Anthropic row’s name is `'', which `??` does not catch, so
  the merged block would still have rendered "Executing Tool".

### The lesson, recorded because it bit twice

The first attempt had a green test suite and lost 26 KB. The second had a green test suite and did
nothing observable. **There was no test for `message-storage.ts` at all** — the module had two
`vi.mock` stubs and no direct test — so the path that decides what an affected user sees was
uncovered. A test that calls the pure function with a hand-written fixture is necessary but not
sufficient: attempt 2’s tests all passed while the function was unreachable in production. The
check that mattered was running the REAL payload from the REAL endpoint through the REAL modules.

Measured live afterwards: `Executing Tool` **10 → 0**, spinning indicators **0**, activity headers
render ("4 steps", "1 command", "3 steps", "2 steps"), and the cache is written under
`chat_messages_v2_*`.
#### 2. Context indicator removed

The 16 px `ContextRing` + percentage in `StatusBar.tsx`, plus the entire pipeline that only existed
to feed it: `liveContext` (a live zustand subscription whose value was discarded — the status bar
re-rendered on every context-pressure SSE frame and threw it away), and in `ChatThread.tsx` the whole
occupancy estimation — `maxContext`, `estTokens`, `pct`, `contextBreakdown`, a 10-input `useMemo`,
`coreMemoryBytes`, `skillsByName`, three `workbenchTool*` state hooks, and a per-session
`listWorkbenchCapabilities()` fetch whose only consumer was that memo.

`ContextRing` and `estimateContextBreakdown` are **untouched and still exported** from
`@/sections/chat/ChatComposer` with their tests passing — the request was to remove the indicator,
not to delete a working component. — **WRONG about `ContextRing`, and it was deleted.** The file
`frontend/desktop/src/sections/chat/ContextRing.tsx` (265 lines) and its test (273 lines) were
removed in `9c014058`, whose own commit message is "fix(chat): delete the context gauge that was
never mounted"; neither exists in the tree today. `estimateContextBreakdown` IS still exported
(`frontend/desktop/src/sections/chat/ChatComposer.tsx:10`, re-exported from
`frontend/desktop/src/sections/chat/context-breakdown.ts:37`) — but nothing consumes it for the
composer any more.

#### 3. Model selector below the composer removed

Deleted `ComposerModelRow.tsx`; the footer is the disclaimer alone; `modelMenuSignal`,
`modelMenuOpenSignal`, the dead `ModelEffortMenu` import, the palette "Switch model…" item and
`open_model_picker` all removed; the toolbar’s unreachable "Preparing handoff…" branch removed
with `handoffPreparing`, whose only setter caller was the deleted row.

### The dead-code sweep needed three passes, and ESLint could not see it

Pass 1 removed the row and its props. Pass 2 removed ~25 locals ESLint flagged. Pass 3 removed nine
props that **ESLint structurally cannot report**: `models`, `modelsLoading`, `setSelectedModel`,
`userSelectedRef`, `onEditModels`, `effort`, `setEffort`, `thinkingEnabled`, `setThinkingEnabled` were
still declared on `ChatThreadComposerProps` and still passed by `ChatThread`, while the component no
longer destructured them. An interface member is not an unused local, so the lint pass came back
green over a prop list that was three-quarters dead. The whole context-estimation pipeline went
with them, including a per-session `listWorkbenchCapabilities()` fetch whose only consumer was a
memo that rendered nothing.

### Capability consequences, stated rather than hidden

`ModelEffortMenu` had exactly two entry points — this row and the palette command — so both went
together. Leaving the palette item would have produced a command dispatching an action nothing
listens for, which is exactly the dead code the request asked to remove.

* **Model**: switching survives only as a per-message "answer with a different model" action, which
  regenerates that turn and cannot pick a model for a new message. `useChatModels.selectModel` — the
  one function that persisted a choice to both `localStorage` and the session — now has no callers.
  — **RESTORED.** The composer footer renders `ModelEffortMenu`
  (`frontend/desktop/src/sections/chat/ChatThreadComposer.tsx:593-602`) with
  `onSelect={onSelectModel}`, so the model **is** selectable for a new message again. The live
  comment in the file records the restoration and its reason: *"It was left unrendered when the
  composer model row was removed, which removed the LAST way to change the model … Restoring only
  the *text* made it worse — it rendered `qwen3.8-flash medium` as inert copy, so the model was
  both visible and unchangeable."* (§11.5 describes the same change from the visual side.)
* **Effort**: there is NO UI left. `setEffort` was deleted rather than left wired to nothing, so effort
  is seeded from `august_last_effort` and is otherwise immutable. A user who set an effort before the
  removal keeps it; nobody can change it after. **This is a real capability loss and the user’s call,
  not an oversight** — restoring a control is a product decision.
  — **RESTORED, and the user's call was made: the control came back.**
  `ModelEffortMenu` is rendered with `onEffortChange={onEffortChange}`
  (`ChatThreadComposer.tsx:599`), and `ChatThread.tsx:1385` passes `onEffortChange={setEffort}`.
  Effort is changeable in the product.
* **Extended thinking**: `setThinkingEnabled` was likewise only ever called with `true`, so it is
  always on and cannot be turned off. — **RESTORED as a control:** `ModelEffortMenu` is rendered
  with `thinkingEnabled` / `onThinkingChange` (`ChatThreadComposer.tsx:600-601`), and
  `ChatThread.tsx:1387-1388` wires them to `thinkingEnabled` / `setThinkingEnabled`.
* **Model visibility**: the `ModelVisibilityModal` had exactly one opener, `onEditModels`, which went
  with the row, so the modal is unreachable. The editor and its Refresh button are gone from the
  product. — **WRONG NOW: the modal is REACHABLE.** `onEditModels` is passed again
  (`ChatThreadComposer.tsx:597`), its opener is back
  (`frontend/desktop/src/sections/chat/ChatThread.tsx:1386`,
  `onEditModels={() => setShowModelVisibility(true)}`), and the modal is mounted at
  `ChatThread.tsx:1639`. The editor and its Refresh button are **in** the product.

Two code comments claiming Settings could still set the session model were wrong and have been
corrected — Settings edits the model *catalog*, not `selectedModel`.

### A dead end this looked like it created, and did not

There appears to be a trap: `selectedModel` is seeded from `modelFromSession(activeSession) ||
loadLastModel()`, both sync effects in `useChatModels` bail when it is null, `canSend` requires
`!!selectedModel`, and the tooltip read "Select a model first — open the model picker above", naming
a control that no longer exists. `ChatThread.tsx` already owns a fallback for exactly this
(`if (!targetId) return models[0]`), and it fires when the catalog arrives.

The **tooltip** was a real defect and is fixed — it now names a control that exists: "No model
available — check Settings → AI Setup".

The **fallback** was not missing. An attempt to add one in `useChatModels` was reverted after
verification: it picked `visibleModels[0]` (ranked, hidden-filtered) while the existing one picks
`models[0]` (raw order), so which model a user got would have depended on hook registration order,
and it called raw `setSelectedModel` so the default was never persisted. Two competing fallbacks
are worse than the one that was already correct.

If this ever does bite, the fix belongs in `ChatThread`'s existing fallback — make it choose
`visibleModels[0]` and persist through `selectModel` — not in a second one beside it.

Removing the picker exposed a latent dead end. `selectedModel` is seeded from
`modelFromSession(activeSession) || loadLastModel()`, and BOTH existing effects bail when it is null
(`if (!activeSession?.model) return`, `if (!selectedId) return`). A user with no session model and no
`august_last_model` therefore kept `selectedModel === null` **forever**; `canSend` requires
`!!selectedModel`, so Send stayed permanently disabled, and the tooltip read "Select a model first
— open the model picker above", pointing at a control that no longer existed. The only other
writer, `handleReanswerWithModel`, needs a completed send first, so there was no in-chat way out.
Reachable by anyone who provisions providers through Settings → Models & Providers, a hand-placed
`providers.json`, or a cleared `localStorage` — i.e. everyone the AI Setup wizard does not catch.

#### 4. Circuit current direction, polarity, live path

The schematic graph is **topology only** (components, wires, node names, `grounded`) — no node
voltages — so all three additions are derived, not read.

1. **Directional current arrows.** The flow markers were anonymous `<circle>` dots, which have no
   orientation, so the direction of conventional current was visible nowhere. They are now `<path>`
   arrowheads rotated to the wire tangent. A zero-length segment returns angle 0 rather than feeding
   `atan2` a zero vector.
2. **Source polarity.** `+`/`−` placed from `nodes.indexOf('0')`, because `V1 in 0 5` puts node 0 on the
   SECOND pin — assuming "left is positive" is wrong for the common case.
3. **Live-path highlighting.** Nets the source reaches render wider and in the accent tint; a dead
   branch stays base grey. Every wire was previously the same grey, so a live loop and a dead branch
   drew identically. Arrowheads are gated on this, so current never animates along a wire the same
   renderer just declared unpowered.

### Three bugs the verification rounds caught, all since fixed

**Polarity X placement was algebraically wrong.** `(dx / len) * off * Math.sign(dx)` — but
`dx / Math.hypot(dx, 0)` is *already* `sign(dx)`, so the extra sign squared it and the offset was
always `+off`. Every mark landed 15px to the RIGHT of its own pin; with pins at (0,0)/(40,0) the `+`
sat at x=15, inside the r=11 circle, and swapping the pins still put `+` at 55. Replaced with a single
unit vector from the symbol centre to the pin.

**Polarity was double-rotated.** The component `<g>` already applied `rotate(rot % 2 ? 90 : 0)` and
the polarity `<g>` applied the same rotation again, so an odd `rot` doubled to 180° and put `+` on
the wrong terminal. The polarity group carries no transform of its own now.

**`poweredNodes` could not run against real backend data.** This was the worst of the three, and
the most instructive: it built adjacency from `w.nodes` as if a wire carried a `[from, to]` pair.
It does not. `backend-py/app/services/tools/schematic.py` constructs `Wire(points=...,
nodes=[node])` — a SINGLE net name, being the net that wire is drawn on; the backend’s own test
asserts `w.nodes == ['out']`. So `const [a, b] = w.nodes` yielded `b === undefined`, the link guard
was never true, `adj` was always empty, and the flood degenerated to "the source’s own two net names".
Not merely dead — **inverted**: for `V1 in 0 5 / R1 in out 1k`, net `in` and `0` rendered live
while `out`, the net the source actually drives through R1, rendered grey.

It passed its tests because the fixtures **invented a two-node wire shape the backend never emits**.
Every wire fixture in that test file is now single-node, and adjacency comes from COMPONENT node
lists instead — a component is what joins two nets, so it is the correct edge to traverse (the
source drives `out` *through* R1). This is reachability, not a solved DC operating point: a
capacitor in steady state carries no current and topology cannot know that.

Also fixed: the polarity nudge was `+/−5` on **y** unconditionally, which only lifts the glyph off
a horizontal wire — for a vertical source it moved the glyph *along* the wire it was meant to
clear. It is now perpendicular to the pin axis.

#### Four rounds of review, and what each one cost

Every item in this section went through independent subagent review four times. Each round found
real defects; none of the rounds came back clean. That is the honest summary of the method: a
green suite here has repeatedly meant "the untested path is untested", not "it works".

**Round 1** rejected the first duplicate-render fix outright: it dropped rows without merging,
losing 26 KB of tool output and leaving 30 tools permanently spinning.

**Round 2** found the server-side merge changed nothing on screen (a warm reload never fetches),
plus a quadratic scan in the cache path.

**Round 3** found the cache path itself was dead code AND then shipped a severe data-loss bug in
the replacement: it collected block ids from every message, but `derive_blocks` gives each
standalone tool row its OWN `toolCall` block, so pre-047 rows were deleted unmerged — and
re-persisted, so no refetch repaired it. Also found quota eviction could no longer reclaim v1
data, and `sessionIsEmpty` read sessions as empty, letting "New chat" hijack a real conversation.

**Round 4** found four more, all fixed below, plus the ones recorded as not-delivered.

#### Additional defects found in round 4 and fixed

* **R1 — data loss, both paths.** `Map.set` keeps only the LAST row for an id, but the filter
  dropped *every* row with that id. Two rows sharing a `toolUseId` lost the earlier row’s output
  with nothing left to render it. Both implementations now track the CONSUMED ROW OBJECT and
  drop by identity, so at most the one row actually merged disappears.
* **R2 — drop key ≠ merge key.** `mapRemoteMessages` merged on `tool.id ?? toolUseId` but dropped on
  `toolUseId` alone. A row whose id lived only inside `tool.id`, or that carried only snake_case
  `tool_use_id`, was dropped with no merge at all. Now both derive from the same `consumedRows`
  set, which the merge populates itself — so they cannot disagree by construction.
* **R4 — eviction deleted the good copy first.** The sort was `localeCompare` on the whole key on
  the comment "key embeds date/time — oldest first". The rename broke that: `chat_messages_v2_x`
  sorts before `chat_messages_wb_x`, so readable merged v2 transcripts were evicted while the
  unreadable v1 copies they replaced survived. Pre-v2 keys are now evicted first.
* **R7 — the v1 fallback was short-circuited.** `getItem(v2) ?? getItem(v1)` never reaches v1 once
  a v2 key exists, even when that key holds `"[]"` — which is what `persistMessages` writes for an
  empty transcript. The "New chat" hijack re-enabled itself on the first empty fetch. Now every
  candidate is examined for real content.
* **R3/R8 — coverage holes.** Removing the D1 gate `&& renderedByAssistant.has(id)` left all 16
  tests green while deleting an orphan row, because the one legacy-shape test has an assistant with
  NO blocks and so returned before reaching the gate. Three `it()`s also sat outside the `describe`,
  so `beforeEach(localStorage.clear())` never covered them.
* **Model selector: `setMessages` survived the sweep.** Declared in `ComposerToolbar`, forwarded
  through `ChatThreadComposer`, passed by `ChatThread`, consumed nowhere — the same
  interface-member blind spot as the 13 props.
* **Four stale toasts.** `useChatSend` still said "Select a model first" and "pick it again from the
  model list". Enter-to-send bypasses `canSend` entirely, so those were the only message a user
  got — and both named a UI that no longer exists.
* **The Send dead end I created and then mis-diagnosed.** Removing the picker left
  `selectedModel` null on a WARM remount: `ChatThread` guards its fallback with
  `models === prevModelsRef.current`, and `prevModelsRef` is seeded with `models` at mount, so a
  warm first render is swallowed — and react-query’s `replaceEqualDeep` preserves identity for
  deep-equal data, so the polls never re-trigger it. Permanent, not transient. Fixed by moving
  defaulting out of the identity-guarded effect entirely: it now fires whenever nothing is
  selected, picks `visibleModels[0]` (ranked, hidden-filtered) and persists via `selectModel`.

#### Circuit: three more defects, and one feature that does not do what was asked

* **Polarity was still rotated out of its pin frame for odd `rot`.** `Component.pins()` ALREADY
  applies the 90° turn, and the component group applied it again. Removing the child’s own
  transform did not fix it — the PARENT was doubled. For a source at (0,0) `rot:1`, `+` belonged
  to the top pin and landed to the right, `−` to the left, both at the same height ~40px from
  their pins. Polarity is now emitted in absolute user coordinates, outside the rotating group.
* **Polarity ignored the source value’s sign.** `V1 in 0 -5` marked `+` on `in`, which is the
  −5 V terminal. The sign is read from `c.value` now.
* **A latent bug my own new test caught:** the loop iterated `[index, glyph]` pairs, so pin 1 was
  hard-coded `−` and `negIndex` could subtract a `+` but never promote it back. Any source with
  ground on pin 0 (`V1 0 in 5`) rendered `−` on BOTH terminals. Now the glyph is derived from
  `i === negIndex` alone.
* **Three circuit mutants previously SURVIVED the suite** (both nudge reverts, and the
  both-terminals loop). The nudge assertions compared only the SIGN of a coordinate, which the
  buggy code also satisfied for these symmetric fixtures. They now assert exact geometry, and all
  four mutants are killed.

**NOT DELIVERED — "visible path highlighting".** What shipped highlights nets REACHABLE from a
source. Because `build_graph` only emits a wire for a net with ≥2 pins, every wire that exists is
by construction in the adjacency graph, so on six real decks measured — divider, series, BJT,
MOSFET, coupled, two-source — the result was 100% live wires. That is electrically true for a
single loop, but it means the feature is visually inert: it recolours the whole circuit blue. A
real path needs a solved DC operating point, which topology cannot give you — ngspice is already in
the stack via `circuit_tools`, so the route exists, but it is a solver, not a renderer change.
### 11.5 Reference-fidelity pass #2 — composer, model control, settings, skills

Driven against the same screenshots, element by element. Four shipped changes:

| Surface | Before | After |
|---|---|---|
| Composer footer | model + effort on a centred row of its own, disclaimer stacked below — two bands | **one line**: disclaimer left, model + effort right, the reference’s exact arrangement |
| Model control | a segmented `bg-muted/30` plate with a hover panel per half — the loudest of the three reference treatments, matching none of them | plain text: model at full weight, effort muted, single chevron each |
| Appearance fonts | 4 native `<select>`s | 4 value pills (§4.3) |
| Skills card | an outlined "On" button on **every** card — 6 bordered pills on one screen, saying nothing | icon-only ghost toggle: a check when enabled, a power glyph when not |

The model control keeps **two** triggers rather than consolidating to the reference’s single
chip. KiloCode — also in the reference set — uses exactly two pills, and ~12 tests in
`ModelEffortMenu.test.tsx` address the two chips independently. Merging would have traded a
reference shape for a capability regression, so only the surface changed.

**A claim in the previous status was wrong, and the correction matters.** I reported that the
Skills list "computes `display: block` — a single-column list, not a grid." It is a grid.
Re-measured: `grid-template-columns: 184.4px 184.4px`, from `grid gap-3 sm:grid-cols-2`
(`SkillsSection.tsx:684`). What I had actually measured was `data-testid="skills-grid"`, which
is the **`overflow-y-auto` scroll wrapper** one level up, not the card grid. The one-column
reading was an artefact of measuring the wrong element — the same failure mode as the DOM
census in §1.2b, where a correct count was read off the wrong node.

**The first attempt at the Skills card was reverted, not shipped.** Matching ChatGPT meant
dropping the outlined button for a bare checkmark. Two tests failed immediately:
`getByRole('button', { name: 'Disable circuit-helper' })`. Disabling a skill from the grid
without opening the detail pane is a real capability, and the reference’s checkmark is
ChatGPT’s affordance, not a mandate to delete August’s. The control stayed in both states;
only its weight changed (`variant="outline" size="sm"` → `variant="ghost" size="icon-sm"`),
which is what the numbers in the table above measure: **6 bordered toggles → 0**, with every
`data-testid` and accessible name byte-identical. The disabled state still carries the amber
"Disabled" pill above, so the state is never encoded by an icon alone.

This is the same call as S4 in §4.1: a shared toolbar and a deleted control both score better
against the screenshots and both cost a capability. Both were declined on the same grounds.