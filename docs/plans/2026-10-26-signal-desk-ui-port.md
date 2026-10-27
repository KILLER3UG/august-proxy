# Signal Desk UI port — whole desktop app

**Source of truth:** `docs/design/signal-desk-complete.html` (desktop, 1440).
The mobile mockup (`docs/design/signal-desk-mobile.html`) is **out of scope**:
this port targets the Tauri desktop app. The same SPA is loaded by the mobile
companion at phone width, so existing responsive tiers must keep working.

**Approved decisions (2026-10-26):**

1. **Every existing surface is restyled**, not just the four surfaces the
   mockup shows. Automations, Runs, Board, Live, History, Learning, Docs and
   Bots stay reachable and adopt the new shell/tokens.
2. **Canvas is a new view** in the existing right drawer, alongside Preview,
   Diff, Tasks, Plan, Browser, Subagents, Artifacts and Notes. It opens when a
   chart or produced artifact exists.
3. **Settings becomes a page**, not a dialog over a live chat. The
   background-location split and inerted shell go away for `/settings`.
4. **Charts is copied from the HTML** (sample content and layout) for this
   port. It is not a new backend store.

**What already exists (verified):** the dark palette, paper-light tokens,
`#6f9bff` accent, Inter + JetBrains Mono, KaTeX math, GFM tables, a grouped
Settings registry (`Setup / Agent / Data / App`), Artifacts derivation,
produced-artifact rendering, a resizable right drawer, and a Claude-shaped
sidebar. This is a refinement port, not a greenfield rewrite.

**What the mockup adds:** editorial serif display type; a 276px sidebar with a
workspace card, New thread, quiet nav, pinned/projects/recent, usage and
profile; a 56px titlebar with breadcrumbs, command search, Canvas toggle,
theme toggle and window controls; a launchpad empty state; a Charts surface; a
persistent Canvas view; a full-page Settings frame; and study figures with
copy/SVG/PNG actions.

**Phases (one commit each, verified in the running app):**

1. **Foundation + shell.** Serif display family and the mockup's paper palette;
   sidebar width/structure; titlebar; nav with the four primary items plus a
   More group for the remaining surfaces; theme toggle; usage/profile footer.
   Keep every current action (session menu, Bots, projects, command palette,
   resize, collapse, Tauri window controls).
2. **Chat + launchpad.** Thread hero, message/assistant presentation, composer,
   empty state as the launchpad, study typography, and the sanitized SVG figure
   block with copy/SVG/PNG actions.
3. **Canvas + Charts.** Canvas as a right-drawer view (chart/data/notes) built
   from the active session's artifacts; Charts page copied from the mockup;
   navigation.
4. **Artifacts.** Mockup grid/filters over the existing artifact derivation.
5. **Settings page.** Convert `/settings` from dialog to page; apply the
   grouped rail and mockup frame; keep every current section.
6. **Memory / Skills library.** Restyle the existing sections to the mockup
   library shape. Coordinate with the in-flight `2026-10-25-memory-skills-gap-
   closure.md` work (U1/U2); do not add a second store or competing UI.
7. **Remaining surfaces.** Automations, Runs, Board, Live, History, Learning,
   Docs, and Bots adopt the shared page frame, typography and tokens.
8. **Polish/verification.** 1440 and 960 layouts, light/dark, keyboard/focus,
   reduced motion, mobile-width tiers, `check`/design/docs/SSE gates, smoke.

**Invariants / regressions to guard:**

- Tauri `minWidth: 960`; the mockup's three-column canvas must collapse or
  overlay below 1240 and never cover the thread (the mockup itself breaks here).
- Settings page must deep-link `/settings/:section` and keep the existing
  registry; hidden sections stay searchable.
- Artifacts/Charts/canvas figures are derived from real session data where the
  mockup's data is illustrative; sample content is clearly a copy of the spec.
- The mobile companion loads the same SPA at phone width; keep the <760 tier.
- No feature is deleted to make the mockup fit.

## Status — 2026-10-26

**Done and verified in the running app:**

Two backend doors the Library needed were wired rather than worked around:
`GET /api/brain/stores/{name}` now forwards `scope` and `status` to
`brain_browse` (the service accepted `scope` and no route passed it), and
`description` joins the facts browse column list (written by the store, read by
recall, patched by the whitelist, and selected by nobody — so the human browse
rendered every fact with an empty description).

- Phase 1 shell: serif editorial type, 276px sidebar with workspace card, New
  thread, search, Threads/Charts/Artifacts/Settings, a More group that keeps
  every existing surface, a 30-day usage card, profile footer, 56px titlebar
  with breadcrumbs, live pill, command search, Canvas toggle and theme toggle.
- Phase 2 chat: the launchpad empty state (hero, action cards, real recent
  outputs), study typography (serif headings, linear tables, callout quotes),
  and sanitized fenced ```svg figures with the reference's copy/SVG/PNG menu.
- Phase 3: Charts (the mockup's sample data by request; real interactions for
  shape switching and recent-chart selection), and a Canvas drawer view backed
  by this session's produced artifacts + the existing per-session notes.
- Phase 4: Artifacts rebuilt as the mockup grid with kind filters, a JSON export
  and a real Add-file seed.
- Phase 5: Settings is a route page, not a dialog; the rail, search, grouping
  and every existing section are preserved; section changes no longer remount
  the page.
- Phase 6 Library (Settings → Memory / Skills): the mockup's `#scaleDoc`
  screen — tabs with counts, four stat cards, search + type chips + scope/sort,
  hairline rows grouped under a sticky scope head, a sticky detail pane, a
  range footer with paging, and a bulk bar. Every number is a server fact and
  every gesture exists; see the file header of
  `frontend/desktop/src/sections/settings/LibrarySection.tsx` for the four
  mockup affordances that were CUT rather than faked (skill "Updates",
  "Open folder", human-initiated Retire, Marketplace sources). The old panels
  are not deleted: `memory-tools` and `skills-tools` are hidden registry doors
  (searchable, deep-linkable) and each Library head carries an "All tools"
  button to them.
- Scroll-away thread intro above the transcript, virtualizer-safe through a
  measured `scrollMargin`.
- Mobile tier (`docs/design/signal-desk-mobile.html`, `<760px`): mobile topbar,
  bottom tabbar (Chat / Charts / Artifacts / Settings), the sessions drawer
  overlaying at 86%, and settings as a section catalog with a pushed section +
  back row. It ships in the SPA the mobile companion's WebView loads, so the
  Expo app needs no change — but the phone sees it only after a desktop
  release, because the WebView loads the packaged web build.
- Composer handoff fix: `api/ui-events.ts` and the composer disagreed on the
  event name and the detail shape, so every seed action (launchpad cards,
  command-palette insert/focus, Charts actions) was silently dead. Fixed and
  verified end-to-end.

**Still open:**

- Interiors of Automations, Runs, Board, Live, History, Learning, Docs (they
  inherit the shell, serif page headers and nav now, but keep their old bodies).
- The paper-light token pass (the mockup's #f4f1e8) and a focused-motion/a11y
  sweep.
- A model-facing instruction telling the model to emit ```svg for diagrams;
  the renderer is ready, but the model has no documented channel yet.
- Packaged-Tauri and mobile-width verification (the SPA's <760 tier).

## Second pass — the mockup's own stylesheet, not an approximation (2026-10-26)

Phases 1–6 shipped a Tailwind APPROXIMATION of the mockup. This pass replaces
that approximation on the surfaces it covers with the mockup's actual CSS and
DOM:

- `frontend/desktop/src/styles/signal-desk.css` is the mockup's stylesheet,
  ported mechanically (postcss): every selector scoped under `.sd-app`, px
  font sizes converted to rem so Settings → Text size still scales. The
  iframe-only blocks (scale overlay, embedded library document) are excluded;
  they style a second document, not the app.
- `.sd-app` aliases the mockup's variable vocabulary (`--bg`, `--panel`,
  `--ink`, `--accent`, `--chart-1..6`, …) onto the app's `--dt-*` tokens, so
  the port themes itself and light/dark stays one source of truth.
- tokens.css gained the mockup's missing roles (`--dt-stage`, `--dt-line`,
  `--dt-line-strong`, `--dt-accent-text`) and the warm paper light palette
  (#f4f1e8 / #fbf9f2) that this plan listed as still open.
- `components/ui/signal-icons.ts` is the mockup's 48-symbol sprite, copied
  verbatim; `SignalIcon`/`SignalSprite` are the typed references. The ported
  chrome does not use lucide.
- Rebuilt to the mockup's DOM: the sidebar head, workspace card, New thread,
  quick search, nav (Threads/Charts/Artifacts/Settings + More), section and
  project heads, one-line thread rows, usage card and profile footer; the
  titlebar (crumbs, live pill, command button, Canvas toggle, theme, window
  controls); the app/main/workspace-body frame; the launchpad; the composer
  surface and its footer; the assistant head and prose rail; the user bubble.
- `Button` gained a `bare` variant: no layout/type/colour, only the focus
  ring, pointer and disabled states — for controls whose whole appearance
  comes from a stylesheet. The design gate requires the primitive, and the
  mockup's classes must stay authoritative.
- The mockup's global `button { border:0; background:none }` reset was NOT
  ported as an element selector: it outranks `.bg-primary` and stripped every
  filled button in the app. It is scoped to the mockup's own classes instead.

**Third pass — the interiors (2026-10-26):**

- **Transcript blocks.** `ThinkingDisclosure` is the mockup's `.thinking-block`
  (header with brain glyph, "Thinking", duration, chevron; numbered body;
  "Show more" clamp). `ToolCallItem` is `.tool-card` (icon tile, mono tool
  name, subtitle, status chip, duration, chevron, body). `SkillReceiptChip` is
  `.skill-receipt`. `SubagentDelegateRow` is `.subagent-row` (branch tile,
  role, task, status, progress sweep).
- **The run ledger.** The app groups a run of thinking + tool calls into ONE
  collapsible row (`ActivitySummary` / `ActivityGroup`) — which is what the
  mockup does too, as `.ledger`. Both are restyled to that container. The
  mockup's `.tool-card` therefore appears where the app does NOT group (a lone
  tool, an error), and the grouped case is the ledger. Forcing every tool into
  a card would have contradicted the mockup's own grouping.
- **Canvas.** `RightDrawerCanvasSection` is the mockup's `.canvas-*` panel:
  segmented Chart/Data/Notes, kicker + serif title + sub, `chart-stage`,
  metrics, readout, and the `.canvas-foot` actions. The drawer still owns the
  tab strip above it.
- **Settings rail.** 204px, no full-height divider, page ground instead of a
  second surface.
- **Charts / Artifacts** share `page-screen` / `page-inner` and the mockup's
  `page-head` (via `SectionHeader`), so their titles are the 32–46px serif
  step.

**Still open:** the interiors of Automations, Runs, Board, Live, History,
Learning and Docs (they inherit the shell, the page head and the palette, but
keep their own bodies), and the paper-light pass for third-party surfaces that
portal outside `.sd-app` (dialogs keep the token palette, not the mockup's
stylesheet).

**Verified:** `tsc -b --force` clean; eslint 0 errors on every touched file;
`check:design`, `check:truncate`, `check:naming`, `check:docs` pass; a
production `vite build` completes (the repo's own `web-dist` empty-out is
refused by this sandbox's bulk-delete guard, not by the build); screenshots at
1440 and 1280 in both themes, no console errors, no horizontal overflow.

**Fourth pass — the two sample pages rebuilt on the mockup's own DOM (2026-10-26).**
The second pass gave Charts and Artifacts the mockup's page head but left
their INTERIORS as Tailwind approximations; compared side-by-side against the
served mockup (`localhost:8791`), the differences were visible: no
`page-eyebrow` kicker, a merged metrics card instead of the two `.side-card`s,
recent-chart cards without their `.gallery-visual` previews, segmented-chip
filters instead of the final layer's underline `.filter-chip`s, and polyline
chart lines where the mockup draws smooth beziers. Rebuilt:

- `SectionHeader` carries an `eyebrow` prop (`.page-eyebrow`): "Output / data"
  on Charts, "Library / everything" on Artifacts, "Workspace / preferences" on
  the Settings page head (which is now the mockup's `page-head` verbatim —
  eyebrow, serif `page-title` h1, `page-sub`).
- Charts: `.dashboard` → `.dashboard-main` (`card-head` + `segmented` +
  `big-chart`) + `.dashboard-side` (Total-tokens `.side-card` with
  `side-delta` and `.side-bars`; By-model `.side-card` with `model-row`s);
  `gallery-head` (title, artifact count, View all) and a `.gallery-grid` of
  `.gallery-card`s whose minis are drawn from each def's real series (line /
  bars / donut). Series lines are Catmull-Rom→bezier (`smoothPath`), the
  primary line carries the mockup's gradient fill and `chart-line` draw
  animation, and the highlight tooltip uses the mockup's panel/line-strong
  box.
- Artifacts: `.filter-row` (`filter-chip` underline tabs — label "Documents"
  per the mockup — plus the borderless `.search-field`), and an
  `.artifact-grid` of `.artifact-card`s: `.gallery-visual` (real preview when
  one exists; otherwise the mockup's `photo` gradient, `doc` folded-corner
  glyph or code-panel glyph), `gallery-name`, a `gallery-kind` line of
  KIND · EXT · AGE, and a `gallery-footer` whose dot colours by origin
  (produced = accent, attached = ink-4, link = chart-2) so the plan's
  origin-visible promise survives the mockup's tighter meta.
- Settings section headings re-scaled: the port had every section's
  `SectionHeader` h2 rendering the 46px serif `page-title`, while the mockup's
  `.settings-panel h2` is a modest sans heading. A `settings-content` marker
  class on the content region scopes an override back to the app's documented
  20px standard; the page's own h1 keeps the serif step.
- Small app-extension block appended to `signal-desk.css` (side-bar peak
  accent moves from the mockup's fixed `nth-child(5)` to the sampled
  `[data-max]`; selected `gallery-card` border; origin dot colours).
  Everything else is the mockup's own rules, already ported.

Verified: tsc clean, eslint 0 errors, `check:design` (2 new baselined
inline-styles — the side-bar heights and the model-row dots, both data-driven
like the existing baseline entries), `check:truncate`, `check:naming`,
production `vite build`; Charts/Artifacts/Settings/Library screenshotted at
1440 in BOTH themes against the served mockup, no error boundary, no
horizontal overflow.

**Fifth pass — the Settings class collision this pass itself caused (2026-10-27).**
The `settings-content` marker class added above for the panel-heading scale
COLLIDED with the mockup's own `.settings-content` rule
(`signal-desk.css:1085`, the mockup's 680px panel-inner clamp) that had been
dormant for exactly that reason. Activating it clamped the whole settings
content region to 680px, which squeezed the Library into the broken render the
owner reported: list panel 262px, four stat cards at 52px with overlapping
labels, the toolbar wrapped into four rows. The marker is renamed
`settings-page-content` (SettingsFrame + the heading rule), the dormant mockup
rule goes back to being inert, and the measured result at 1755 is region 1331 /
list 668 / stat cards 4×154 / one toolbar row. Lesson recorded: a new
classNames marker must be grepped against the ported stylesheet before it
ships — the port's generic names are live CSS even when no element currently
carries them. Also in this pass: `MAX_COMPOSER_H` (360) exceeded the
composer textarea's inline `max-height` (240) — the auto-grow set an inline
height the CSS cap clamped while the overflow test read the raw scrollHeight,
so a draft between 240 and 360px tall clipped silently with no scrollbar.
Aligned at 240. The composer's resting height itself was already the compact
single row (58px card); a stale tall render in a long-open tab is the HMR
stale-measurement class of artifact — reload clears it.

**Sixth pass — the sample data is gone; Charts reads the live usage store
(2026-10-27, owner ruling).** The approved stopgap — Charts carrying the
mockup's deepseek/qwen fixture "until the chart store lands" — is retired by
owner ruling: NOTHING in the app may render sample data. The four surfaces the
owner named were audited: chats, artifacts, tokens and the Library were
already live derivations; Charts was the one fixture, and it now reads the
same endpoints the Usage page and sidebar card read — `usage.stats` (totals,
peak, favorite model, active days), `usage.by-day` (tokens per day, split by
model), `usage.by-model` (shares), `usage.heatmap` (events per day). Three
real chart views — tokens by day, activity by day, model split — replace the
four sample defs; the gallery is those views (selecting one switches the main
chart), the side cards and the peak tooltip are computed from the axis, the
readout is written FROM the stats facts, and a 7d/30d segmented refetches.
Empty ranges render honest zeros with "No usage recorded in this range yet";
the peak marker is suppressed when the range is all zeros, and the tick
ladder floors at 4 so single-digit usage still gets a sane axis. Also: the
effort slider is restyled to the reference picker's fat gradient-fill track
(fixed green→teal→blue gradient clipped at the selected stop via a
`--effort-fill` var from the component — the fill and the knob can no longer
disagree, which they did on the first cut at 100%), and the Skills list rows
gained the mockup's active-row accent (2px inset primary bar), the last
visible delta from the scale-doc rows. Verified: tsc/eslint clean,
`check:design` (one new baselined inline style: the fill var),
`check:truncate`, production build; Charts/effort menu/Skills screenshotted
live.
