# August Proxy — Settings Surface & Personalisation Audit

Source-verified audit of the desktop Settings surface and its
theming/personalisation controls, mapped against two reference patterns
(ChatGPT desktop "Customize" sidebar + Haze Settings modal).

**Every count in this document was re-measured from source on the audit
date. Two prior documents carry stale numbers and must not be quoted as
current — see §8 Stale claims.**

- Repo: `C:\Dev\august-proxy`
- Frontend source: `frontend/desktop/src/`
- Audit date: 2026-10-10

---

## 1. Method

Counts were derived by script over the registry and shell sources, then
hand-verified against the rendering code that consumes them:

| Measurement | Method |
| --- | --- |
| Section count / tiers | Parsed `SETTINGS_SECTIONS` object literals in `frontend/desktop/src/settings/settings-registry.ts` |
| Rail-visible count | Cross-referenced `tier !== 'hidden'` against the keys of `SECTION_COMPONENTS` in `SettingsPage.tsx`, then against the rail's own filter predicate in `WorkspaceShell.tsx` |
| Hidden-tier count | Same parse, `tier: 'hidden'` |
| Colour controls | `UI_TOKEN_DEFS` entries in `frontend/desktop/src/lib/ui-customization.ts` |
| Theme presets | `THEME_PRESETS` entries in the same file |
| Font-size controls | Occurrences of `setTextSize` / `useThemeStore(...textSize)` UI call sites in `frontend/desktop/src/sections/settings/` |

`isImplementedSettingsSection()` (`SettingsPage.tsx:398-400`) is the gate
that decides whether a registry entry renders at all:

```ts
function isImplementedSettingsSection(id: string): boolean {
  return Object.hasOwn(SECTION_COMPONENTS, id);
}
```

---

## 2. Section inventory (measured)

| Metric | Value | Evidence |
| --- | --- | --- |
| Sections declared in the registry | **43** | `settings-registry.ts:156` — `SETTINGS_SECTIONS` array; 43 object literals between `:156` and `:792` |
| Header groups (categories) | **4** | `settings-registry.ts:119-140` — `SETTINGS_CATEGORIES`: `basics`, `capabilities`, `data`, `app` |
| `tier: 'basic'` | **17** | registry, per-section `tier` fields |
| `tier: 'hidden'` | **26** | registry, per-section `tier` fields |
| Implemented (present in `SECTION_COMPONENTS`) | **43 of 43** | `SettingsPage.tsx:345-396` |
| Shown as rail rows | **17** | `WorkspaceShell.tsx:276-279` filter predicate |
| Hidden-tier but implemented (search / deep-link only) | **26** | registry `tier: 'hidden'` ∩ `SECTION_COMPONENTS` keys |

**The registry's own header comment is wrong.** It claims "3 header groups
… 44 sections" (`settings-registry.ts:5-6`), and the file comment at
`:27-28` in `SettingsPage.tsx` repeats "3 header groups … 38 rows". Both
are stale — the code declares 4 categories and 43 sections.

### 2.1 Category distribution

| Category | Label | Sections |
| --- | --- | --- |
| `basics` | Setup | 7 |
| `app` | App | 4 |
| `capabilities` | Agent | 24 |
| `data` | Data | 8 |
| | **Total** | **43** |

(`settings-registry.ts:119-140` for the labels; `category:` fields counted
across `:156-792`.)

### 2.2 Rail-visible rows (17)

In `WorkspaceShell.tsx:275-308`, each category maps its members through
this filter:

```ts
const items = decorated.filter(
  (s) => s.category === cat.id && s.tier !== 'hidden' && s.id !== 'ai-setup',
);
```

`ai-setup` is deliberately excluded from that loop and re-added as a
standalone row below it (`WorkspaceShell.tsx:309-328`), so the rail shows:

| # | Category | Section | Registry line |
| --- | --- | --- | --- |
| 1 | Setup | General | `settings-registry.ts:159` |
| 2 | Setup | Appearance | `:194` |
| 3 | Setup | Model settings | `:211` |
| 4 | Setup | Browser Use | `:235` |
| 5 | Setup | Computer Use | `:250` |
| 6 | App | About | `:307` |
| 7 | Agent | Memory | `:345` |
| 8 | Agent | Subagents | `:397` |
| 9 | Agent | Turn Limits | `:412` |
| 10 | Agent | Plugins | `:446` |
| 11 | Agent | MCP Servers | `:456` |
| 12 | Agent | Skills | `:487` |
| 13 | Agent | Commands | `:517` |
| 14 | Agent | Model Families | `:757` |
| 15 | Data | Usage stats | `:688` |
| 16 | Data | Review Inbox | `:744` |
| 17 | (standalone) | Onboard | `:333` |

Plus two fixed non-section rows pinned at the bottom of the rail: the
account row (`WorkspaceShell.tsx:403-431`) and the updates status row
(`:434-452`). Those are profile/status affordances, not registry
sections.

### 2.3 Hidden tier (26)

`system-health`, `account`, `privacy`, `ui-designer`, `model-catalog`,
`model-fleet`, `model-reflection`, `model-live`, `model-aliases`,
`model-fallback`, `model-quotas`, `memory-facts`, `recurring-tasks`,
`agents-automation`, `agent-board`, `agent-sandbox`, `tool-grants`,
`python-sandbox`, `computer-access`, `api-access`, `observability`,
`conversations-history`, `conversation-inspector`, `feature-flow`,
`backend-monitor`, `health-simulator`.

All 26 are implemented and reachable via search or deep link — none are
dead registry entries. Search bypasses the tier filter entirely:
`visibleForSearch` is the full decorated list with no tier predicate
(`WorkspaceShell.tsx:115`, and the comment at `:109-114` states hidden
sections "live inside their parent's stacked cards or as tree" and are
search-only).

Note the registry comment at `:149-152` claims an "advanced" tier used to
exist and was removed 2026-10-03; `SettingsTier` is only
`'basic' | 'hidden'` (`settings-registry.ts:72`), and `auditRegistry()`
enforces exactly those two (`:857-861`).

---

## 3. Personalisation & theming controls (measured)

| Metric | Value | Evidence |
| --- | --- | --- |
| UI Designer colour controls | **18** | `frontend/desktop/src/lib/ui-customization.ts:46` — `UI_TOKEN_DEFS` |
| Colour-control groups | **4** | `ui-customization.ts:38-43` (UI Designer) + `group:` fields in the defs |
| Theme presets | **6** | `ui-customization.ts:185-267` — `THEME_PRESETS` |
| Presets visible in light mode | **1** | `UiDesignerSection.tsx:60` |
| Distinct font-size control surfaces in Settings | **1** | `GeneralSection.tsx:234-286` — single "Text size" card |
| Font-size steps | **4** | `GeneralSection.tsx:42-47` — compact / default / comfortable / spacious |
| Theme-mode options | **3** | `AppearanceSection.tsx:56-60` — Light / Dark / System |
| Chat-font options | **3** | `GeneralSection.tsx:49-53` — Default / Serif / Monospace |

### 3.1 UI Designer colour controls (18)

`UI_TOKEN_DEFS` (`ui-customization.ts:46-173`) is the single source of
truth; `UiDesignerSection.tsx:188-263` renders one row per token across
four `SettingsCard` groups. Each row is a colour picker
(`<input type="color">`, `UiDesignerSection.tsx:213-219`) plus a hex text
field (`:236-248`) plus a per-token Clear button (`:249-256`).

| Group | UI Designer label | Tokens | Token ids (registry lines) |
| --- | --- | --- | --- |
| `app` | App & settings | 6 | `background` `:48`, `foreground` `:55`, `card` `:62`, `muted` `:69`, `mutedForeground` `:76`, `border` `:83` |
| `chat` | Chat | 4 | `input` `:90`, `chatBackground` `:97`, `chatInputBackground` `:104`, `userBubble` `:111` |
| `sidebar` | Session sidebar | 4 | `sidebar` `:118`, `sidebarForeground` `:125`, `sidebarAccent` `:132`, `sidebarBorder` `:139` |
| `brand` | Brand & focus | 4 | `primary` `:146`, `primaryForeground` `:153`, `accent` `:160`, `ring` `:167` |
| | | **18** | |

Two derived properties are also written on apply but are not user-editable
tokens: `--dt-sidebar-primary` and `--dt-sidebar-ring`
(`ui-customization.ts:362-369`).

The `UiTokenId` union (`ui-customization.ts:15-33`) and `UI_TOKEN_DEFS`
carry the identical 18 members — verified by set comparison, no orphan
either way. 18 is the renderable count.

### 3.2 Theme presets (6)

`THEME_PRESETS` (`ui-customization.ts:185-267`):

| # | id | Name | Defined at |
| --- | --- | --- | --- |
| 1 | `default` | Default (empty map — theme defaults) | `:186` |
| 2 | `midnight` | Midnight | `:188` |
| 3 | `carbon` | Carbon | `:204` |
| 4 | `rose` | Rosé | `:220` |
| 5 | `solarized` | Solarized | `:236` |
| 6 | `forest` | Forest | `:252` |

**Light-mode gating.** All five coloured presets are dark-tuned, so light
mode shows only the theme-neutral `default`:

```ts
const visiblePresets = resolvedDark ? THEME_PRESETS : THEME_PRESETS.filter((p) => p.id === 'default');
```

(`UiDesignerSection.tsx:59-60`.) A user in light mode sees **1** preset
button; a user in dark mode sees **6**. The preset row is rendered at
`UiDesignerSection.tsx:166-185`.

Presets load into the *draft* only — `useUiCustomizationStore.setState({ draft: { ...preset.map } })`
(`UiDesignerSection.tsx:174`) — and still require an explicit **Apply**
(`:147-150`) before they touch the real UI.

### 3.3 Font-size controls (1)

One control surface, four steps. `GeneralSection.tsx:42-47`:

```ts
const TEXT_SIZE_OPTIONS: { id: TextSize; label: string; scale: string }[] = [
  { id: 'compact',     label: 'Small',      scale: '0.92' },
  { id: 'default',     label: 'Default',    scale: '1.00' },
  { id: 'comfortable', label: 'Large',      scale: '1.08' },
  { id: 'spacious',    label: 'Extra Large', scale: '1.18' },
];
```

Rendered as a 4-up button grid with an "Aa" sample and a live preview
block (`GeneralSection.tsx:246-285`).

The mechanism is a single **global root font-size scale**, not a
per-surface control. `applyTextSize` writes one attribute on `<html>`
(`lib/theme.ts:80`):

```ts
document.documentElement.setAttribute('data-text-size', resolved);
```

and `styles/tokens.css:245-248` maps each value to one root size:

```css
:root[data-text-size="compact"]     { font-size: calc(16px * 0.92); }
:root[data-text-size="default"]     { font-size: calc(16px * 1.00); }
:root[data-text-size="comfortable"] { font-size: calc(16px * 1.08); }
:root[data-text-size="spacious"]    { font-size: calc(16px * 1.18); }
```

Everything sized in `rem` scales together. There is no way to set
interface, chat-message, chat-input, or code text independently.

**A second, non-Settings surface exists.** `pages/DesignRoute.tsx:220-266`
(dev-only design-system page, registered at `routes.ts:44-45` and `:190`)
duplicates the same 4-step size picker plus a theme switcher
(`DesignRoute.tsx:251-262`). It is a design-system showcase, not a
Settings entry, and is excluded from the Settings count.

### 3.4 Theme mode

`AppearanceSection.tsx:56-60` renders Light / Dark / System as a 3-up
button grid; `setThemeMode` (`lib/theme.ts:69-71`) → `applyTheme`
(`:54-67`) toggles the `dark` class on `<html>` and persists to
`august.theme`. `system` resolves via
`window.matchMedia('(prefers-color-scheme: dark)')` (`lib/theme.ts:49-52`)
and live-tracks OS changes (`:108-120`).

### 3.5 Chat font

`GeneralSection.tsx:150-159` — a `<select>` with Default / Serif /
Monospace. It writes `data-chat-font` on `<html>`
(`lib/preferences.ts:98-99`) and only `styles/base.css:295-300` consume
it, scoped to `.chat-message-text`. It changes typeface only — not size,
and only for chat message bodies.

---

## 4. Reference-pattern mapping

### 4.1 Reference A — ChatGPT desktop "Customize" (Skills page)

Reference anatomy: narrow icon rail → secondary "Customize" sidebar
(Plugins / Skills / Installed) → content pane with title + one-line
subtitle, search field, Refresh icon, gear, white "Add" button → 2-column
card grid (icon + name + one-line description + checkmark) → category
filter pills below the grid.

| Reference element | August Proxy equivalent | Verdict |
| --- | --- | --- |
| Narrow icon rail | `WorkspaceShell.tsx:191` — `w-60` (240px) labelled sidebar, not icon-only | **Partial** — same slot, ~3.75x wider, text labels instead of icons |
| Secondary "Customize" sidebar | None. One rail only | **Absent** |
| Page title + one-line subtitle | `SettingsPage.tsx:225-233` `SectionHeader` renders `h1` + description — but only for the 9 ids in `HEADERLESS_SECTION_IDS` (`:213-223`); every other section renders its own `h2` inside its card body | **Partial** — inconsistent; `h1` vs `h2` depends on the section |
| Search field | `SettingsSearch` (`components/settings/SettingsSearch.tsx`) mounted in the rail at `WorkspaceShell.tsx:193`, **not** the content pane | **Present, misplaced** — reference puts it above the content grid |
| Refresh icon | Absent | **Absent** |
| Gear (per-page settings) | Absent | **Absent** |
| "Add" button | Per-section create actions (e.g. `SkillsSection.tsx` "New" button); no shell-level add affordance | **Partial** — action lives inside each section, not the pane header |
| 2-column card grid | `SkillsSection.tsx:684` — `grid gap-3 sm:grid-cols-2` rendering `SkillCard` | **Present** (Skills only; other list sections use tables or hairline rows) |
| Icon + name + one-line description + checkmark per card | `SkillCard` at `SkillsSection.tsx:1094-1140` | **Present** |
| Category filter pills below the grid | `SkillsSection.tsx:647-660` — `SettingsTabs` scope pills, **above** the grid, 5 items ("All" + 4 scopes) | **Present, different semantics** — scope pills (project/agent/bundled/...) not category pills, and placed above the grid |

**Notable divergence:** the Skills list is *not* a flat 2-column grid. The
comment at `SkillsSection.tsx:599-601` records a deliberate reversal —
"the card grid buried the only distinction that matters when a catalogue
grows" — so the outer container is scope-grouped sections (`:672-698`)
and the card grid is per-group.

**Search is rail-resident, not pane-resident.** `SettingsSearch` sits at
`WorkspaceShell.tsx:193` inside the `<aside>`, above the category tree. It
filters the rail itself (`WorkspaceShell.tsx:117-147`), replacing the tree
with flat grouped results (`:208-271`) — the opposite of the reference,
where the content pane is what gets filtered. Two consequences: the search
only matches label / description / keywords / settingHints (`:124-139`),
and it never renders a Refresh or gear control.

### 4.2 Reference B — Haze Settings modal

Reference anatomy: small dialog, left tab column (Account / Appearance /
Providers / Team / Shortcuts / About), right content pane. Appearance shows
5 named theme swatches, a System|Light|Dark segmented control, a "Hide
sidebar in Browser" toggle, and FOUR per-surface font-size rows (Interface
/ Chat messages / Chat input / Code), each with a pill value button.

| Reference element | August Proxy equivalent | Verdict |
| --- | --- | --- |
| Small modal dialog | `WorkspaceShell.tsx:177-189` — `fixed inset-0` scrim + `role="dialog"`, `max-w-[1180px]`, `h-full` | **Present but not small** — a full-viewport panel (only `p-3 sm:p-8` inset), vs Haze's compact dialog |
| Left tab column | `WorkspaceShell.tsx:274-329` — 4 category groups, 17 rows, `w-60` | **Partial** — wider, grouped, and scrolls |
| Right content pane | `WorkspaceShell.tsx:350-361` — `max-w-[680px]` centred column | **Present** |
| 5 named theme swatches | 6 preset *buttons* (`THEME_PRESETS`, `ui-customization.ts:185-267`) — text buttons, not swatches; no colour chip per preset | **Partial** — 6 presets but rendered as text buttons with no swatch preview |
| System\|Light\|Dark segmented control | `AppearanceSection.tsx:56-60` — 3-up `grid-cols-3` button grid (Light / Dark / System) | **Present** — matches the segmented-control intent |
| "Hide sidebar in Browser" toggle | Absent | **Absent** |
| 4 per-surface font-size rows (Interface / Chat messages / Chat input / Code) | **1** global text-size control (`GeneralSection.tsx:234-286`) | **Major gap** — 1 global control vs 4 per-surface controls |
| Pill value button per font-size row | 4-up button grid with "Aa" samples (`GeneralSection.tsx:247-271`), not a value pill | **Partial** — one row, button grid rather than a pill |

**The font-size gap is the single largest divergence from either
reference.** Haze exposes four independently-settable surfaces. August
Proxy exposes one setting that writes `data-text-size` on `<html>`
(`lib/theme.ts:80`) and scales every `rem`-sized element at once
(`styles/tokens.css:245-248`). There is no per-surface font control
anywhere in `frontend/desktop/src` — verified by grepping `fontSize` /
`textSize` / `setTextSize` across the tree; the only UI writers are
`GeneralSection.tsx:253` and the dev-only `DesignRoute.tsx:256`.

---

## 5. Key findings

1. **43 sections, not 45.** The registry declares 43 sections across 4
   categories; 17 are `basic` and shown as rail rows, 26 are `hidden`.
   All 43 are implemented (`SettingsPage.tsx:345-396`), so there are no
   dead registry entries. The registry's own header comment claiming
   "3 header groups ... 44 sections" (`settings-registry.ts:5-6`) is wrong
   on both numbers, as is `SettingsPage.tsx:27-28` ("3 header groups ...
   38 rows").

2. **The rail shows 17 rows, and `ai-setup` is special-cased out of the
   loop.** The category filter at `WorkspaceShell.tsx:276-279` explicitly
   excludes `ai-setup`, which is then re-appended as a standalone row at
   `:309-328`. Any future rail refactor must preserve that two-step or
   Onboard disappears from the rail.

3. **Hidden tier is search-only, and search is rail-resident.** All 26
   hidden sections are reachable, but only through rail search
   (`WorkspaceShell.tsx:115` passes the full decorated list, tier filter
   dropped) or deep links. The search filters the *rail*, not the content
   pane — inverted relative to the ChatGPT reference. It also matches only
   label/description/keywords/settingHints (`:124-139`).

4. **18 colour controls, 6 theme presets, but presets are light-mode
   gated to 1.** `UI_TOKEN_DEFS` has 18 tokens in 4 groups; `THEME_PRESETS`
   has 6 entries of which 5 are dark-tuned, so light mode renders only
   `default` (`UiDesignerSection.tsx:59-60`). Presets also load into the
   draft only and need an explicit Apply (`UiDesignerSection.tsx:167-184`,
   `:147-150`).

5. **One font-size control, not four — the biggest reference gap.** The
   single "Text size" card (`GeneralSection.tsx:234-286`) drives one global
   root scale via `data-text-size` (`lib/theme.ts:80`,
   `styles/tokens.css:245-248`). No per-surface font control exists for
   Interface, Chat messages, Chat input, or Code. Haze's four rows have no
   counterpart.

6. **Chat font is the only other typography control, and it is scoped to
   chat message bodies only.** `GeneralSection.tsx:150-159` writes
   `data-chat-font` (`lib/preferences.ts:98-99`), consumed solely by
   `styles/base.css:295-300` under `.chat-message-text`. It sets typeface,
   not size.

7. **Search-results presentation carries a control-level affordance.**
   A setting-level hit shows the matched control label under the section
   row (`WorkspaceShell.tsx:257-264`) and carries it as `?field=`
   (`:250-254`), so "auto inject" opens Memory *and* scrolls to the
   control. This is a genuinely stronger pattern than either reference and
   should be preserved in any redesign.

8. **`RAIL_PARENT` remaps 8 deep-link ids to a parent.**
   `settings-registry.ts:815-824` collapses `ui-designer` -> `appearance`,
   `tool-grants` and `python-sandbox` -> `agent-sandbox`, etc., so the rail
   highlights one row. `railCanonicalId` (`:828-830`) applies it. Note
   `ui-designer` is *hidden* tier yet renders inside the Appearance page
   (`AppearanceSection.tsx:64-66`) — the deep link scrolls rather than
   switching rails, which is why the section is invisible in the rail but
   fully reachable.

9. **Two rail rows are not registry sections.** The pinned account row
   (`WorkspaceShell.tsx:403-431`) and updates status row (`:434-452`) are
   chrome affordances in the rail footer. Counting them as sections would
   give 19 — they are deliberately excluded here.

10. **`workspace-registry.ts` is a legacy filter, not a second rail.** Its
    `WORKSPACE_VISIBLE_IDS` (`workspace-registry.ts:22-30`) exposes 6
    sections for a chat-side panel, but grep shows no remaining consumer
    outside its own test (`test/workspace-registry.test.ts`) and a stale
    comment reference in `WorkspaceShell.tsx:81`. The `/workspace/*` routes
    were retired (`WorkspaceShell.tsx:3-5`). Treat it as dead
    configuration, not as part of the Settings surface.

---

## 6. Divergence scorecard

| Reference | Elements present | Partial | Absent |
| --- | --- | --- | --- |
| ChatGPT "Customize" (9 elements) | 3 | 5 | 2 (secondary sidebar, Refresh/gear) |
| Haze Settings (8 elements) | 2 | 4 | 2 (hide-sidebar toggle, per-surface font sizes) |

August Proxy has a solid single-rail + content-pane shell and a strong
colour designer (18 tokens, live preview, server-synced apply), but it is
missing both references' structural affordances: no secondary sidebar, no
pane-level search/gear/add header, and critically no per-surface font-size
control.

---

## 7. Stale claims — do not quote

Both prior documents carry numbers that this audit contradicts. They were
not used as inputs; they are listed only so the discrepancy is closed.

| Prior document | Claimed | Measured now | Status |
| --- | --- | --- | --- |
| `docs/plans/2026-10-03-ui-ux-refactor-spec.md` | 45 sections | **43** | Stale |
| `docs/plans/2026-10-03-ui-ux-refactor-spec.md` | 43 implemented | **43** | Coincidentally matches, wrong derivation (45 total claimed) |
| `docs/plans/2026-10-03-ui-ux-refactor-spec.md` | 17 rail rows | **17** | Still correct |
| `docs/plans/2026-10-03-ui-ux-refactor-spec.md` | 304 keywords | **294** | Stale |
| `docs/ui-refactor/minimalism/stage1-inventory.md` | rail-visible count ~714 | **17** | Stale by two orders of magnitude — almost certainly counting rendered DOM nodes or tokens, not sections |
| `settings-registry.ts:5-6` (in-code comment) | 3 header groups / 44 sections | **4 groups / 43 sections** | Stale in-code comment |
| `SettingsPage.tsx:27-28` (in-code comment) | 3 header groups / 38 rows | **4 groups / 17 rail rows** | Stale in-code comment |

The two in-code comments are worth fixing independently of this audit —
they are the first thing a future reader trusts.

---

## 8. Reproducing these counts

```bash
# Section ids and tiers (expect 43 ids, 17 basic, 26 hidden)
node -e "const fs=require('fs');const lines=fs.readFileSync('frontend/desktop/src/settings/settings-registry.ts','utf8').split('\n');let inArr=false,ids=[],tiers={};for(let i=0;i<lines.length;i++){const L=lines[i];if(L.includes('export const SETTINGS_SECTIONS'))inArr=true;if(inArr&&L.trim()==='] as const;')break;if(!inArr)continue;let m;if((m=L.match(/^    id: '([^']+)'/)))ids.push({id:m[1],line:i+1});if((m=L.match(/^    tier: '([^']+)'/)))tiers[m[1]]=(tiers[m[1]]||0)+1;}console.log('IDS',ids.length,'TIERS',JSON.stringify(tiers));"

# Keyword terms across all sections (expect 294)
node -e "const fs=require('fs');const s=fs.readFileSync('frontend/desktop/src/settings/settings-registry.ts','utf8');let kc=0;[...s.matchAll(/keywords: \[([\s\S]*?)\]/g)].forEach(x=>{kc+=(x[1].match(/'/g)||[]).length/2;});console.log('KEYWORD_TERMS',kc);"

# Colour tokens and groups (expect 18 tokens, 4 groups)
node -e "const fs=require('fs');const uc=fs.readFileSync('frontend/desktop/src/lib/ui-customization.ts','utf8');const b=uc.slice(uc.indexOf('export const UI_TOKEN_DEFS'),uc.indexOf('export type UiCustomizationMap'));const g={};[...b.matchAll(/group: '(\w+)'/g)].forEach(m=>g[m[1]]=(g[m[1]]||0)+1);console.log('TOKENS',[...b.matchAll(/^    id: '([^']+)',/gm)].length,'GROUPS',JSON.stringify(g));"

# Theme presets (expect 6)
node -e "const fs=require('fs');const uc=fs.readFileSync('frontend/desktop/src/lib/ui-customization.ts','utf8');const b=uc.slice(uc.indexOf('export const THEME_PRESETS'),uc.indexOf('interface UiCustomizationState'));console.log('PRESETS',[...b.matchAll(/name: '([^']+)'/g)].map(m=>m[1]).join(', '));"
```
