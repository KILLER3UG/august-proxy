# UI reference — captured from the screenshots the user supplied

**This file exists so the reference survives context compaction.** The reference
images were supplied as chat attachments; image bytes cannot be written back to
disk from inside the session, so what is preserved here is the *measured
description* of each one — the concrete, checkable details that the UI work is
judged against. Anything stated as a number was read off the screenshot.

Date captured: 2026-10-11. References: **Claude desktop** (chat, memory
settings modal), **ChatGPT Skills**, **KiloCode**, **Haze**. All are dark-mode.

---

## 5. Claude desktop — the Memory settings modal (2nd capture, 2026-10-10)

This is the reference for **every settings surface**, not just Memory. It is the
single most load-bearing settings reference in the set.

### Shell
- A **centred modal** on a dimmed chat behind it. At a 1920-wide viewport it is
  ~1600 px wide, inset ~60 px from each edge, radius ~16 px, hairline border,
  `#1a1a1a` fill, soft shadow. It is NOT full-bleed and NOT a full-page route.
- `✕` alone in the **top-right corner** of the modal. No Save, no Cancel, no
  footer bar.
- The left nav column is ~236 px, separated from the content by a hairline.

### Left nav
- A **pill-shaped search input** pinned at the top of the nav ("Search"),
  full nav width, radius = full height, hairline border.
- Below it, **grouped into labelled sections**. The group labels are small,
  muted, sentence case — NOT uppercase:
  - `Settings` → General, Account, Privacy, Billing, Capabilities, **Memory**,
    Reflect, Time and focus, Claude Code
  - `This computer` → System, Extensions, Developer
  - `Customize` → Skills, Connectors, Plugins
  - `Platform` → API keys (with a `↗` external-link glyph)
- Every nav row: a **monochrome icon + label**, borderless, no background.
- Selected row (`Memory`): **lighter rounded-rect fill, radius ~8 px, full nav
  width. No left accent bar, no underline.**
- There is no numeric badge on the row; the one `2`-style count in the set
  (KiloCode's `Bots`) is on a rail tab, not a nav row.

### List view (e.g. Memory → topics)
- **No page `<h1>`.** The content column starts straight into section headers.
- Section headers — `You`, `Topics`, `Areas` — are **bold**, ~15 px, with a
  **hairline rule running the full content width** beneath them and generous
  space above.
- Each row is a 3-column grid: **label (left, regular weight)** ·
  **summary (middle, muted, single line, ellipsis)** · **timestamp (right,
  muted, tabular — `Updated Aug 21` / `Updated 4 days ago`)**.
- Rows are borderless; separated by a full-width hairline at ~8% white.
- **Hover**: the row fills lighter, and a **pencil + trash icon pair appears at
  the far right**, replacing the timestamp. The icons are borderless.
- Rows are ~46 px tall — noticeably taller than the 34 px chat rows.

### Detail view (one memory opened)
- Top row: `← Memory` back link (arrow + label, borderless) at the left, and a
  **`Delete` pill button** at the right — a bordered/lighter rounded rect, not
  a red text button.
- Then the **title** as a bold ~20 px heading.
- Then **label / value pairs**, each a small muted label above its value:
  - `Last updated` → `Aug 21, 2026`
  - `Summary` → one line of prose
  - `Details` → a **bulleted list**, indented, no bullets styling beyond dots
- Content scrolls under a **sticky composer**.

### The modal's composer — a key finding
- A **full-width rounded card pinned to the bottom of the modal**, inside the
  content column, with placeholder `Tell Claude what to change`.
- The right-hand control is a **circular button, ~32 px, containing an
  up-arrow glyph** — a circle, not the blue rounded square August uses.
- This is a *second* composer, inside settings, separate from the chat one.
- The right-hand content column has its own **thin scrollbar** inset from the
  card's right edge.

### What this implies for August
August's settings are **20 full-page routes**, each rendering its own `<h1>`.
The reference is a **single modal with a persistent left nav**, so the nav is
never re-navigated and the chat stays visible behind. That is a structural
difference, not a styling one, and it is the largest single divergence between
August and the reference set.

## The single most important thing

Every one of the four references is **dark-first and near-black**. The base
surfaces sit at roughly `#0d0d0d`–`#111`; the elevated surfaces (user bubble,
selected row, input field) sit at roughly `#2a2a2a`–`#333`. Borders are
hairlines at ~10–15% white. There is no mid-grey body background, no coloured
chrome, and no gradient. If August's chat pane reads as a *different value* than
the reference's chat pane, nothing else matters until that is fixed — every
other decision inherits its contrast from it.

---

## 1. Claude desktop — the chat layout reference

This is the primary reference for the transcript, the activity block and the
composer.

### Left rail
- Width ~360 px, separated by a single hairline.
- Top row of icons: hamburger, panel toggle, back arrow, forward arrow, then
  **right-aligned**: a search pill and a `</>` code pill. Both are small rounded
  rectangles with a hairline border, not borderless icon buttons.
- Nav rows, each an icon + label, **no background, no border**: `+ New`,
  `Projects`, `Artifacts`, `Customize`.
- Section headers — `Pinned`, `Chats and tasks` — are small, muted, sentence
  case, with generous space above.
- `Chats and tasks` carries its actions **on the same line, right-aligned**: a
  magnifier and a sort/filter glyph.
- Chat rows: a **small hollow circle bullet**, then the title. The selected row
  gets a **lighter filled rounded-rect** roughly 8 px tall, full row width.
- Titles truncate with an ellipsis at the rail edge, no fade.
- Footer on a hairline top border: `$ Sheesh · Free ⌄` left, a settings glyph
  right.

### Top bar (main pane)
- Title left-aligned near the rail, regular weight, with a small chevron.
- Everything else in the top-right of these captures is a **dev overlay**
  (FPS/GPU/CPU/LAT) — not part of the product. Do not copy it.

### Transcript
- **User message**: a rounded rect, right-aligned, ~`#2b2b2b`, radius ~14 px,
  max-width ~640 px, generous padding (~20 px vertical). Text is left-aligned
  *inside* the bubble.
- **Assistant activity block** — the single most important component:
  - A **header row** on the page background (no border): a 3-dot glyph, the
    activity title in muted grey, a duration (`25s`), and a chevron. The whole
    row is clickable to collapse.
  - Below it, a **single rounded container with a 1 px hairline border**
    (`rounded-xl`, ~#1c1c1c fill) that holds **all** the steps.
  - Inside, each step is a **full-width row separated by hairlines**, not
    separate cards: `Read PDF skill before working with the PDF ›`,
    `Ran a command ⌄`, `Loaded pdf skill`.
  - A step's own output is an **inset** block — darker, its own rounded corners,
    and **its own scrollbar** when the output is long (the `total 1344 / drwxr-xr-x…`
    block). The scrollbar is visible and inset from the container edge.
  - The block is **collapsed by default** to its header. Expanding reveals the
    step rows.
- Running/working state: the same header row with the dot glyph animating.
- An **interruption notice** is a bordered rounded row inside the message:
  an icon, `Claude's response was interrupted.`, and two buttons on the right —
  `Edit prompt` (outlined) and `Try again` (filled light).
- **Message actions** appear under a completed message as a row of small
  borderless icon buttons (copy, read-aloud, share, thumbs-up, retry) followed
  by a muted timestamp `5 minutes ago`. They are dim until hover.

### Composer
- A **rounded-rect card**, radius ~16 px, hairline border, ~`#1a1a1a` fill,
  max-width ~960 px, centred.
- Inside: a `+` glyph at the left, placeholder `Write a message…` at ~`#8a8a8a`,
  and at the right a voice glyph and a small chevron. When generating, the
  right-hand control becomes a **filled light circle with a dark rounded
  square inside** (the stop button).
- **One line below the card**, not inside it:
  - left, muted: `Claude is AI and can make mistakes. Please double-check responses.`
  - right: `Sonnet 5.5` in normal weight followed by `High` in **muted**, both
    in the same type size. The model name is NOT a pill/border.
- No model chip, no segmented control, no border around the model name.

---

## 2. ChatGPT Skills — the reference for the skills/settings list page

### Chrome
- A macOS menu bar across the top: `File  Edit  View  Help`.
- Left rail: a **narrow icon-only strip** (home, plugins, clock, books, …) then
  a `…` at the bottom. Roughly 64 px wide. An avatar circle sits at the very
  bottom-left.
- Next to it a ~360 px panel: `Customize` heading with a search glyph on the
  right; nav rows `Plugins`, `Skills`; then an `Installed` section with `GitHub`.
  The selected row is a **lighter rounded-rect fill**, no border.

### Page header
- `Skills` as a large bold heading (~28–30 px).
- Subtitle in muted: `Extend ChatGPT with task-specific skills`.
- Right-aligned on the header line: a **pill-shaped search field** (`Search skills`,
  radius = full height), a refresh glyph, a gear glyph, and an `Add` button that
  is a **filled light pill**.

### Installed list
- Section label `Installed` with a **hairline rule** running to the right edge.
- **Two-column grid**. Each cell is borderless — spacing does the work:
  - a **rounded-square icon tile** ~56 px, radius ~14 px, with a small glyph;
  - to its right, a **bold** title line and a **muted** description that
    truncates with an ellipsis;
  - at the far right, a **check glyph** (installed state), borderless, muted.
- A **segmented control** below the list: the active pill has a lighter fill,
  the inactive label is bare text. Not an underline tab.
- Cards repeat the same row height with generous vertical gap.

---

## 3. KiloCode — the reference for model/effort popovers and the status bar

### Popover anatomy (both the model list and the effort list)
- A floating rounded panel, radius ~12 px, hairline border, ~`#1a1a1a`, and a
  soft drop shadow. Width ~320 px.
- Top: a **search input** inset inside the panel with its own hairline.
- A small uppercase muted group label (`KILOCODE`).
- Rows: a star glyph, the model name, optional **small uppercase tag chips**
  (`MED`, `FLASH`, `ULTRA`), and a chevron at the right. Rows are borderless,
  separated by hairlines, hover = lighter fill.
- A footer group below a hairline: `Refresh models`, `+ Add custom model…`,
  `Edit models…`.
- The **effort popover** is the same panel: `OPTIONS` group with a `Thinking`
  toggle, then `EFFORT` group listing `Minimal / Low / Medium / High / Extra
  High / Max / Ultra` as plain rows with the current one check-marked.
- The selected model row is highlighted with a **lighter fill**, and the check
  glyph sits at the far right of the row.

### Sidebar
- Top: tabs `SESSIONS | BOTS | TERMINAL`, active underlined.
- Nav rows with icons: New session, Capabilities, Messaging, Artifacts,
  Scheduled jobs; a `⌘N` hint chip on New session.
- `Search sessions…` as a **borderless** input with a magnifier.
- `PINNED` and `PROJECTS` as uppercase muted group labels; projects are rows
  with a **coloured dot** and a count chip on the right; `...  Show all sessions`
  to expand.

### Bottom bar (composer)
- Left: `+` glyph, then the model chip — a **bordered rounded pill** with a
  lightning glyph and the model name + effort in muted.
- Right: effort pill `Ultra→Max ⌄`, a mic glyph, and the **stop button** — a
  filled light circle with a dark rounded square inside.
- Above the bar: a branch selector `main ⌄` on its own hairline row.
- Far below, a **status bar**: `Gateway ready`, `Agentic-Trading` on the left;
  `Smart`, `# v0.21.5+7240 (+2071)` on the right.

---

## 4. Haze — the reference for the settings panel and the font-size pills

### Left rail
- ~330 px. Header row: `Personal ⌄` and a `+` in a bordered circle button.
- Nav rows with icons: New, Automations, Review. No backgrounds.
- `Recent ⌄` with search and filter glyphs right-aligned on the same line.
- Chat rows: title, then a second muted line `Just now ⚡` with **token deltas
  right-aligned** — `+4,574` in green and `-808` in red, tabular.
- `Settings` + gear pinned to the bottom-left.

### Composer
- Rounded-rect card, radius ~16 px, hairline, ~`#1a1a1a`.
- Placeholder `Send follow-up`.
- Right: a **filled light circle with a dark rounded square** (stop), large.
- Below the card, a single row: `+`, then a **bordered model pill** with a
  lightning glyph and `GPT 6 Sol High`; then `Bypass permissions` in **red**;
  then a laptop glyph + `Local`; and **right-aligned a context percentage** `3%`.

### Settings panel — the reference for the pill control
- A **centred modal**, ~860 px wide, radius ~16 px, hairline border, `#1a1a1a`
  fill, soft shadow. The chat is dimmed behind it.
- Header row inside the panel: `Settings` **bold, top-left**, and a bare `✕` at
  the **top-right**. No footer, no Save/Cancel.
- Two columns:
  - **Left nav**, ~150 px: `Account`, `Appearance`, `Providers`, `Team`,
    `Shortcuts`, `About`. The selected item is a **lighter rounded-rect fill**,
    no border, no left accent bar.
  - **Right content**, ~470 px: section label (`Theme`, `Mode`, `Font size`) in
    muted, then the controls.
- **Theme**: five **rounded-square swatches** (~56 px, radius ~14 px) with a
  diagonal two-tone fill, each with its **name captioned underneath**. The
  selected swatch has a **lighter ring around it**.
- **Mode**: a segmented control `System | Light | Dark` — active segment has a
  lighter fill, rounded ~8 px.
- **Toggle rows**: label on the left, a pill toggle on the right. A switch with
  a longer explanation has the description **under the label**, muted.
- **Font size**: the label `Font size`, then four rows — `Interface`,
  `Chat messages`, `Chat input`, `Code` — each with a **right-aligned pill**
  reading `13 px` / `15 px` / `14 px`. The pill is a bordered rounded rect, not a
  native `<select>`.

> This `13 px` pill is the source of August's `ValuePill`. It is a
> **bordered rounded pill showing the current value**, and there is **no visible
> chevron** on it in this reference.

---

## Cross-reference rules distilled

1. **Dark-first, near-black.** Base `#0d0d0d`, elevated `#2a2a2a`, hairlines at
   ~10–15% white.
2. **Borders are hairlines, never boxes.** Where something needs containment it
   is one rounded container with hairline children, not N bordered cards.
3. **The user bubble is the only elevated chat surface.** Everything else in the
   transcript sits on the page background.
4. **Icons are borderless** unless they are a *search* or *action* pill.
5. **Selection is a lighter fill, never a left bar or an underline** — except
   KiloCode's top tabs and ChatGPT's segmented control.
6. **Text volume is low.** Section labels are muted and small. Metadata
   (durations, timestamps, token deltas) is muted and de-emphasised.
7. **Model + effort sit on one line below the composer**, name in normal weight,
   effort in muted — never a chip, never a segmented control, never a row of
   its own inside the card.
8. **Settings is a centred modal with a left nav**, not a full-page route.
9. **Search is a pill-shaped input with a border**, not a bare icon that hides
   one on click.

## Corrections found by re-reading the pixels at 2.4–2.6× zoom

The first pass of this file was written from a full-frame view. Cropping and
zooming the actual pixels overturned two claims in it. Both were my errors, and
both are recorded here so they are not repeated.

### 1. The model line under the composer IS in the reference — and I removed it

Zoomed on the composer's bottom-right corner (2.6×), the line under the card
reads, verbatim:

```
Sonnet 5.5  High
```

- `Sonnet 5.5` in **normal/white weight**.
- `High` in **muted grey**, same type size, ~1 space of gap.
- **No chip. No border. No pill. No background. No chevron.**

The `⌄` in that screenshot belongs to the composer **card**, sitting beside the
microphone — it is not a model-picker affordance.

August's model row was a collapsible/expandable bordered row with its own menu.
Removing that was correct. **Removing the line entirely was wrong** — the
reference has it, and deleting it left the composer unable to say which model
was about to run. It is now restored as bare text beside the disclaimer:
`qwen3.8-flash` in normal weight, `medium` in muted. No affordance.

### 2. Claude's session rows have NO second line and NO token delta

Zoomed on the sidebar (2.4×), a chat row is:

```
○  Fixing chart and collision rendering issu…
```

- A **hollow circle bullet**, then the title, on **one line**.
- **No timestamp. No `+29.0k / −386`. No second line at all.**

The section header above them reads `Chats and tasks` — sentence case, muted,
with **no count**, and two icons right-aligned (magnifier, sort).

August rendered `CHATS AND TASKS 39` containing a nested `Tasks 39` — the same
total twice — plus a second row line carrying the relative time and the input/
output delta. That row line was labelled in the code as "the Haze row signature".
**Haze does carry a delta; Claude does not.** The two references disagree, and
the Claude layout is the one being matched here, so the second line is gone.

### What this changes about the earlier description of the Haze row

The Haze reference genuinely shows a second line (`Just now ⚡` plus
`+4,574 / −808`). That is a real feature of *that* product and it is not wrong
— but it is Haze, not Claude, and adopting it wholesale put a second line under
every row of a layout that otherwise has none. It has been removed; the batched
usage read it depended on (`useSessionTokenDelta`) survives for the hover
preview.

- No light-mode reference. Every capture is dark.
- No reference for a circuit/electrical view.
- No reference for a transcript with >50 messages, so nothing here says how a
  long thread should paginate.