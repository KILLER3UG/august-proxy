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
