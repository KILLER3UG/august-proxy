# August Trading — UI/UX & App-Flow Deep Dive (2026-10-15)

**Scope:** the desktop product (`frontend/desktop/` + bundled `backend-py/`), audited against the
minimalist/modern bar set by the Claude desktop references supplied with the request.

**Method:** seven parallel read-only audits, one per slice (turn experience, navigation/IA, design
language, settings/onboarding, composer, artifacts/drawer, cross-surface flow), each citing
`path:line`. **No source file was modified.** Every headline claim that this document asks someone to
act on is marked **[verified]** when I re-checked it directly in the working tree, or **[reported]**
when it rests on a sub-audit's own measurement.

**Bottom line:** August's *engineering* is consistently ahead of its *interface*. The app already
computes why a turn stopped, when an answer was rescued, what a model actually costs, and what it
learned — and then shows almost none of it on the surface the user is looking at. The largest wins
in this report are not new capability; they are spending state the app already has, plus a small set
of token-level corrections that make the whole shell read as one design instead of five.

---

## 1. Executive summary — the ten moves that matter

| # | Move | Slice | Impact | Effort |
|---|------|-------|--------|--------|
| 1 | **Consume the `recovery` frame.** Six rescue kinds (incl. the new `stuck-request` ladder) carry `degraded: true` and render nowhere, live or after reload. | Flow | High | S |
| 2 | **Fix the elevation ladder.** `shadow-elev-*` emits no CSS, so the `Surface` primitive has never drawn a shadow. **[verified]** | Design | High | S |
| 3 | **Restore the 197 dead alpha classes.** `text-sidebar-foreground/60`, `border-destructive/30`, `hover:bg-accent/50` … emit nothing, which is why the sidebar has no text hierarchy and danger states have no red edge. **[verified]** | Design | High | S |
| 4 | **One navigation shell.** Five product surfaces (Runs, Live, History, Learning, Board) exist only behind ⌘K. | IA | High | L |
| 5 | **Collapse the two live status surfaces** and put elapsed time on the working line (`··· <line> · 25s`), as the component's own comment already describes. | Turn | High | M |
| 6 | **A download button in the document viewer** — the single largest reference-parity gap; the handler already exists. | Artifacts | High | S |
| 7 | **Run the review pass switch where the job is shown** (`memoryReview` is off by default and its switch lives in a different panel from its ledger row). | Flow | High | S |
| 8 | **Make the model picker answer "which wire format will this use?"** — the exact question `docs/TROUBLESHOOTING.md` sends users to check, currently unanswerable from the composer. | Composer | High | S |
| 9 | **One first-run state machine.** Three overlays (backend gate, tour, provider modal) order themselves by proxies and can contend. | Flow | High | L |
| 10 | **Lazy-import mammoth + xlsx-js-style.** ~1.4 MB modulepreloaded on every boot, to render spreadsheets as CSV text. | Perf | High | S |

---

## 2. Where August already beats the reference (do not regress)

These are load-bearing strengths. Every recommendation below is written so it does not trade them away.

- **Turn-stop vocabulary with remedies.** `turnEndPhrase` + a plain-word remedy + a *reason-specific*
  action set, including the `continue` vs `retry` distinction that preserves partial work.
  The reference has only "Try again".
- **Mid-run steering.** Queue → inline edit → cancel → **promote to direction** → steer, with the
  placeholder changing to say so.
- **Supervisory surface for delegated work.** Per-worker tabs with titles and elapsed, progress
  popovers, steer-while-running, stop-all with confirm, unseen-finish flags, and full replay after reload.
- **`ExploreGroup` / `×N` read consolidation** and phase-grouped plan nodes — the transcript already
  reduces noise better than a flat tool list.
- **Permission card that fails closed.** `canGrantAlways` refuses rather than silently degrading, and
  destructive/network approvals are deliberately non-durable — with the refusal explained in the card.
- **Honest failure accounting.** `[400] …` status survives to the UI; bulk download reports
  `Copied 20 of 21 · 1 skipped (name already taken)`; artifact counts and truncation are always labelled.
- **Sandboxed artifact rendering with a real CSP** (`_ARTIFACT_CSP`) and a two-tier `sandbox=` policy.
- **Search that reaches hidden settings and names the matched control**, with `?field=` deep-linking.
- **Destructive dialogs that quantify the blast radius** ("Erase 214 memory entries — facts,
  heuristics, proposals, timeline …").
- **Perf discipline:** message-level memo comparators, per-string extractor memoisation, an
  idle-stopping timestamp ticker, and a correctly lazy-loaded `pdfjs-dist` (absent from
  `web-dist/index.html` modulepreloads — **[reported]**, consistent with the dynamic imports).
- **One shortcuts registry that dispatches**, `MotionConfig reducedMotion="user"`, `data-text-size`
  scaling, and an escape-one-layer contract pinned by test.

---

## 3. Design language

### 3.1 Two structural defects that explain most visual inconsistency

**(a) The elevation ladder has never rendered. [verified]**
`tailwind.config.cjs` declares `theme.extend.boxShadow.elev = { flat, ring, raised, overlay }`.
Tailwind's `boxShadow` namespace is flat — only `colors`/`spacing` flatten nested keys — so
`shadow-elev-flat|ring|raised|overlay` emit no CSS. Nine call sites use them, including the `Surface`
primitive itself, which maps `elev → shadow-elev-*`. Result: `shadow-2xl` (≈50 uses **[reported]**)
is the de-facto "lifted" style, and adjacent surfaces at the same depth do not read as the same depth.

*Fix:* flatten to `boxShadow: { 'elev-flat': …, 'elev-ring': …, 'elev-raised': …, 'elev-overlay': … }`,
give `.dark` real shadow alphas (on `#0F0F0F`, `rgb(0 0 0 / 0.06)` lifts nothing), and migrate the
`shadow-2xl` sites to `shadow-elev-overlay`.

**(b) 197 alpha classes emit nothing. [verified]**
~197 occurrences of `{text,bg,border,ring}-{sidebar-foreground,sidebar-border,sidebar-accent,destructive,accent,secondary,ring}/NN`
resolve against colours registered as plain hex/rgb vars with no `<alpha-value>` slot — unlike
`success/warning/danger/info`, which *are* registered as `-rgb` triplets. Consequences the audit
could see: the sidebar has no text hierarchy (44 half-strength labels all render full-strength), danger
affordances lose their red borders and fills, several hover states vanish, and `Button`'s
`destructive` variant has no hover state at all.

*Fix:* register the `*-rgb` triplets for `destructive`, `accent`, `secondary`, `ring`, `sidebar-*`
and point the tokens at them. Note `base.css`'s 235 hand-written `color-mix` rules are load-bearing
today — do not delete them until a build diff proves every emitted class still emits.

### 3.2 Typography

- **The text-size setting does not scale text.** `--font-ui: 15px` / `--font-chat: 16px` are `px`,
  while `data-text-size` scales the root `rem`. So "Comfortable" grows paddings and metadata but
  leaves the two sizes it is named after fixed. **[reported, config confirmed]** Make both `rem`.
- **`h3` (16px) equals chat body; `h4` (15px) is smaller than it.** Headings are not larger than body.
- **Two empty states, two hero sizes:** orchestrator uses `text-[1.625rem]` (26px), chat uses a
  `clamp()` capped at 20px — and the clamp's band is ~2px wide at any real window width, so it is a
  fixed 20px wearing a fluid costume. Against a ~15.7px prose size that is a 1.28× hero; the reference
  is ~2×.
- **~31 distinct type sizes** across the app (24 numeric px values + named steps + clamps), including
  three sizes below the file's own stated contrast-tier floors (`tier-3 ≥ 13px`).
- **The transcript column is 928px, not the 768px the code claims** — `chat.css` applies
  `max-width: 58rem !important` to the message list, composer slot and empty state, overriding the
  `max-w-3xl` in the TSX. At ~15.7px prose that is ~118 characters per line; the reference is ~96.

*Target:* one fixed ramp (display 28–36 / h1 22 / h2 18 / h3 16 / chat 16 / ui 15 / sm 13 / xs 12 /
code 14), one fluid step only (the empty-state hero), `--font-ui`+`--font-chat` in `rem`, and the
transcript column at 48rem.

### 3.3 Colour

- **Dark is right, light is muddy.** Dark surfaces are pure greys (`#0F0F0F`, `#262626`, `#141414`)
  matching the reference verbatim; light surfaces are warm (hue 60). But the light *text* ramp is
  blue-grey (hue 240): `--dt-fg-1 #1c1c1e`, `--dt-fg-2 #4a4a52`, `--dt-fg-3 #6b6b70`. Warm paper with
  cool ink is the single biggest reason light mode reads worse than dark.
- **One blue outlier in dark:** `--dt-fg-2: #c8c8cc` between two pure greys.
- **`--dt-secondary` is a byte-copy of `--dt-accent`** and both are an icy blue (`#eef3ff`), so
  **sidebar hover rows are blue**, not a neutral fill. The reference's selection language is a lighter
  fill of the same neutral.
- **Light `--dt-primary #2f6df6` measures 4.37:1 on `#fbfbfa`** — below AA for text, and it is the
  colour of `.text-primary` links and the focus ring.
- **The user bubble is invisible:** `--dt-user-bubble` = `--dt-muted` at 35% → **1.017:1** light /
  **1.040:1** dark against the page. **[reported]** The reference's bubble is subtle but present.

### 3.4 Radius, motion, icons, focus

- **Radius:** ~16 steps in use, including `0.45rem`/`0.55rem` and four arbitrary px classes. The same
  role gets three radii: modals use `rounded-2xl` (20), `rounded-xl` (16) and `rounded-lg` (12) across
  different dialogs. Composer debt: it declares `rounded-2xl border-border/70 shadow-md` and all three
  are overridden by `!important` in `chat.css` — the class list lies about what renders.
  *Target:* 6 / 10 / 14 / 20 + full, mapped by role (inner control / control & row / card & panel /
  outer container).
- **Motion:** no `--dur-*`/`--ease-*` tokens; 18 CSS durations and 8 framer durations. The architecture
  for reduced motion is right (`MotionConfig`, `data-reduce-motion`, a settings toggle) but
  `motion.css` has **no `@media (prefers-reduced-motion: reduce)` block**, and `preferences.ts` never
  reads `matchMedia` — so an OS-level user who never opens the toggle gets no protection. ~50 CSS
  animations (`animate-spin`, `animate-pulse`, shimmers) are unguarded.
  *Also:* three shimmers animate `background-position` on `background-clip: text` on the busiest
  streaming path — a full-line repaint per frame while the transcript is already growing. And the
  activity-summary header sets `user-select: none`, so tool summaries can't be copied.
- **Icons:** `size-3` (12px) is used **773** times **[reported]** against lucide's 24px/2 design grid,
  with only 9 `strokeWidth` overrides in the repo — so the chrome renders at a 1:6 stroke ratio where
  lucide is drawn 1:12. That is why the UI reads heavier than the reference. File/tool icons are bare
  solid-fill brand glyphs, not the reference's rounded-square colour tiles.
- **Focus:** 10 CSS rules draw focus with `outline: 2px solid var(--dt-border)` — five of them measure
  **1.14:1 light / 1.27:1 dark**, invisible (WCAG 2.2 SC 1.4.11 wants 3:1). Twelve
  `focus-visible:ring-ring/NN` sites emit no CSS and fall back to Tailwind's hardcoded blue, bypassing
  the token. `::selection` is unstyled anywhere — so Chromium's blue is the loudest colour in a
  `#0F0F0F` UI.
- **Spacing is not the problem it looks like:** there are essentially zero arbitrary `p-[13px]` values.
  The real issue is a 2px grid — `gap-1.5`/`py-1.5`/`px-2.5` all live alongside `gap-1`/`py-1`, so
  near-neighbouring panels cannot agree.

### 3.5 Proposed token diff (paste-ready core)

```css
/* type: rem so data-text-size scales the text it names; one fluid step only */
--font-ui: 0.9375rem; --font-chat: 1rem; --font-sm: 0.8125rem; --font-xs: 0.75rem;
--font-code: 0.875rem;
--font-display: clamp(1.75rem, 1.5rem + 0.9vw, 2.25rem);
--lh-ui: 1.55; --lh-chat: 1.6;

/* neutrals: keep flat greys in dark, make the light TEXT ramp warm too */
--dt-fg-1: #1a1a18; --dt-fg-2: #4d4d48; --dt-fg-3: #6e6e68;      /* light */
/* .dark */ --dt-fg-1: #f0f0f0; --dt-fg-2: #b8b8b6; --dt-fg-3: #8f8f8d;

/* one accent that clears AA on paper (4.37 -> 5.97:1) */
--dt-primary: #2456d8; --dt-ring: #2456d8;                        /* light */
/* .dark */ --dt-primary: #7aa2ff; --dt-ring: #7aa2ff;

/* selection is a NEUTRAL fill, not a second blue */
--dt-accent: color-mix(in srgb, var(--dt-foreground) 7%, transparent);
--dt-secondary: var(--dt-muted);
--dt-sidebar-accent: var(--dt-accent);

/* alpha-capable channels: revives the 197 dead /NN call sites */
--dt-destructive-rgb: 210 80 63;  --dt-ring-rgb: 36 86 216;
--dt-secondary-rgb: 242 242 240;  --dt-sidebar-accent-rgb: 26 26 24;
--dt-sidebar-foreground-rgb: 26 26 24;

/* the user bubble currently measures 1.017:1 — stop blending, use a solid */
--dt-user-bubble: #f4f4f2;   /* .dark: #1c1c1c */

/* radius + motion had no tokens at all */
--r-sm: 6px; --r-md: 10px; --r-lg: 14px; --r-xl: 20px;
--dur-fast: 120ms; --dur-base: 200ms;
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);

/* dark needs real shadow alphas or cards separate by fill only */
/* .dark */ --elev-raised: 0 1px 2px rgb(0 0 0/.35), 0 4px 12px -4px rgb(0 0 0/.55);
/* .dark */ --elev-overlay: 0 16px 40px -12px rgb(0 0 0/.70);

::selection { background: color-mix(in srgb, var(--dt-primary) 30%, transparent); }
```

Paired config change (required for the elevation fix):
`boxShadow: { 'elev-flat': …, 'elev-ring': …, 'elev-raised': …, 'elev-overlay': … }` +
register the new `*-rgb` colours in `theme.extend.colors`.

**Do not change:** the dark surface ramp (`#0F0F0F`/`#141414`/`#171717`/`#262626`/`#f0f0f0`); the
composer's `--elev-ring` hairline instead of a shadow; the active-session-row lighter-fill language;
the tool/output mono well; `tabular-nums`; the brand hex palettes in `lib/tool-icon.ts` /`lib/file-icon.ts`;
`base.css`'s status ramp until the `-rgb` registration is proven; and the transcript's no-avatar,
flat-assistant / right-aligned-user grammar.

---

## 4. Conversation & turn flow

**The gap is transparency, not rendering.** The transcript already consolidates well; what a user
cannot see is *what the harness did to their turn*.

1. **`recovery` is dispatched and never handled. [verified]** The type and the dispatcher exist
   (`streamEvents.ts:244`, `types/workbench.ts:451`); the only other matches repo-wide are its own test.
   Six kinds carry `degraded: true` — `budget`, `runaway`, `context-reduction`, `stuck-request`
   (the ladder added 2026-10-15), and `length-continuation:exhausted`. So a turn that was compacted,
   truncated, or rescued into a flattened tool surface reads exactly like a clean one.
   Note `scripts/check-sse-parity.mjs` passes: its check requires a *dispatcher case*, and the drop
   moved one level down the call chain. **The gate written to prevent this now certifies it.**
2. **Retry detail is discarded.** `onRetrying`/`onUpstreamRetry` set `Reconnecting N/M` and drop the
   `delayMs` and `reason` the event carries. The reference shows `rate limited — resets in ~3m,
   retrying in 177s (attempt 1/3)`; August shows three animated dots.
3. **No elapsed time where the user is looking.** `WorkingIndicator` — the surface stared at while
   waiting — has a phase pill and a todo counter but no seconds, despite its own comment naming
   `··· <title> <elapsed> ⌄` as the target form. The transcript's only elapsed label sums *tool*
   durations, so thinking and generation time are excluded.
4. **Two live status surfaces** render the same progress at different granularity (in-transcript
   activity header + above-composer working indicator).
5. **No `Thought for Ns` in the main transcript.** The duration-bearing `thoughtCollapsedTitle` exists
   and is wired only into the sub-agent panel's variant.
6. **Interruption has three homes and none is the message.** The reconnect banner is composer-anchored;
   the `interrupted` turn-end badge is post-hoc; the reference puts an amber "response was interrupted"
   row with `Edit prompt` / `Try again` directly on the message — and `editPrompt` is currently hidden
   while streaming.
7. **Message actions are hover-only** (`opacity-0`, with `focus-within` helping only *after* focus is
   inside the row), and there is no per-message token/cost readout and no feedback control.
8. **A 40-tool turn is one un-virtualized row.** `VIRTUALIZE_AFTER = 40` counts *messages*, and one
   assistant message is one virtual row with a 140px estimate.
9. **Disclosure nests four deep** inside a single tool call with no level budget, and
   `CommandOutputPane` re-implements the disclosure its parent `Section` already owns.
10. **The collapsed done-form is the weaker of the two summaries.** `completion` mode renders a count
    phrase ("1 file, 1 search, and 1 command") while the verb form ("Ran 4 commands, read a file ›")
    is used only when *no* tools ran.

**Quick wins:** `onRecovery` → one inline row (amber when `degraded`) + add `recovery` to the durable
render set so a reload doesn't erase it · consume `delayMs`/`reason` for a real retry line · mount
`useElapsed` in `WorkingIndicator` · pass duration into the rail `ThoughtStep` · `opacity-60` instead of
`opacity-0` on actions · `{verbSummary || countSummary}` in `completion` mode · inline interruption row
with the two actions `turn-end.ts` already specifies.

---

## 5. Navigation & information architecture

**Well built at the row level, thin at the navigation level.**

- **Five product surfaces are command-palette-only** — Runs, Live, History, Learning, Board carry
  `nav: true` in the route table but are absent from the sidebar, whose only destination row is
  Automations.
- **One-way door (latent):** `railTab` is read from `localStorage['august-sidebar-tab']` with **no
  setter anywhere in the repo [verified]** — the tab strip that owned it was removed and `BotsRail` is
  reachable only through that value. Nothing writes the key today, so this only strands installs that
  persisted it under an older build; either give it a setter or delete the branch.
- **"Last updated" is really "last started."** `Session` has no `updatedAt` at all; the comparator
  sorts on `startedAt`, so a chat you replied to this morning can file under three days ago. The sort
  control doesn't say "started".
- **Four different searches with four behaviours** (sidebar title/id only; cross-session content via a
  modal that has *no default keybinding*; in-thread find wired outside the shortcut registry, which is
  why `Ctrl+F` is documented but not dispatched by `APP_SHORTCUTS`; settings token search).
- **`View all` doesn't list all** — it opens the content-search modal, and it is the only escape from
  the 60-row-per-group cap, whose `60/90` caption is passive.
- **No completion signal for background work.** A session that finishes while you're elsewhere changes
  a dot; `NotificationsPanel` is app-update/changelog only. Gateway health is polled every 5s and shown
  nowhere persistent (the status bar was deleted).
- **The settings rail draws 18 of 44 sections, header-less.** Data & Privacy, System Status and the UI
  Designer are `tier: 'hidden'` — search-only — which is the whole "App" group except About.

**Reference-parity moves:** a Sessions/Bots (or surface) toggle at the rail top; a `finished` state
that surfaces; a real all-sessions view merging sidebar search with content search; group headers in
the settings rail; and one visible home for the surfaces currently behind ⌘K.

---

## 6. Composer

**Not over-crowded — under-disclosed.** Five controls and *zero* posture read-outs at rest: everything
describing how the turn will run (guard mode, tool reach, harness mode, sandbox, cost) is nested in the
`+` menu, while the reference puts the mode on the strip and the model+effort as muted text.

- **Model picker:** the composer uses `ModelEffortMenu`, a weaker fork of the richer
  `ModelPickerDropdown` used only in settings. It has search, grouping and keyboard nav — but **no
  price, no `free` marker, and no effective `apiFormat`**, which is precisely the fact
  `docs/TROUBLESHOOTING.md` tells users to check when a model 400s. Zero API metadata on the model rows.
- **Effort:** four levels (`low/medium/high/max`) vs the reference's seven; `max` is flattened to
  `high` on the OpenAI path, so the top of the ladder is not the top of the provider's. `thinkingEnabled`
  appears at rest only in a `title` attribute; the default is named two ways ("Medium" /
  "Medium (Default)").
- **Cost** is modelled correctly (`estimated` is first-class, `0.0` is a price) but lives one level deep
  in the `+` menu, so at rest the user sees no number and no estimate marker. Token deltas render in the
  sidebar, one surface away.
- **Voice** is browser `SpeechRecognition` with a hardcoded `en-US`; in a Tauri WebView this is very
  likely the unsupported branch. Shipping an affordance that cannot work is worse than not shipping it.
- **Real bug:** the composer's own window keydown listener has no typing-target guard, so
  `Ctrl+Shift+Space` steals focus from the terminal dock or a settings field.
- **Real bug (settings side):** the model-edit modal sets `aria-modal="true"` with no focus trap, so
  `aria-modal` is a false statement — Tab walks out into the provider list behind it.

**Attachments are the strongest area of the strip** — 100k-char extraction with a truncation badge, PDF
page extraction, Tauri drag-drop, long-paste-to-`.txt`, per-state chips with real error text. The one
asymmetry is that an unsupported file is a quiet chip while an upload failure is a toast.

---

## 7. Artifacts, documents and the right drawer

- **Four producing tools leave no visible output.** `render_chart`, `render_video`, `render_pages` and
  `draw_circuit` write files but are absent from the name-based admission rule in `produced-files.ts`,
  so charts, videos and pages never appear in the transcript *or* the Artifacts gallery.
- **Read-only tools create phantom artifacts.** The loose `^pptx_` rule admits `pptx_list_elements` and
  `pptx_comment` because they carry a `path`, inflating the transcript's file rows and the titlebar count.
- **The titlebar count includes `kind: 'link'`** — prose URLs count as artifacts.
- **No download button in the document viewer.** The viewer's control set has truncation badge, preview
  toggle, copy, zoom, expand, close — and no save. The only download path is the Artifacts drawer. (The
  handler already exists elsewhere.)
- **A transcript button labelled `Download` opens the drawer**; its tooltip says "Open file in side panel".
- **`+N more` is inert text** — with 20 artifacts, twelve are unreachable from the transcript, and there
  is no inline `Download all` under the completed turn.
- **The PDF viewer is strictly paged, one canvas, one page**, with a *footer* control strip rather than
  the reference's floating `Page 1 / 6` chip — so the indicator scrolls out of view, and there is no
  continuous-scroll mode. Zoom is a CSS transform on the wrapper, so it magnifies the raster rather than
  re-rendering at higher DPI.
- **The "theme-resolved paper" comment contradicts the code:** the canvas hardcodes `bg-white` and the
  "resolved" computed style therefore reads back white in every theme.
- **Two palette entries silently do nothing. [verified]** `ChatLayout`'s `set_drawer_section` allow-list
  names six of thirteen sections, so "Open notepad" and "Artifacts" are dropped with no fallback — the
  gallery and the notepad are reachable only via the `+` chooser.
- **The good news:** bulk download is genuinely well engineered (Rust-side copy, no bytes through the
  webview, collision reporting, cancel handling), artifacts survive restart by re-deriving from the
  transcript, and pdfjs is correctly lazy — while **mammoth + xlsx-js-style are statically imported and
  modulepreloaded on every boot** (~1.4 MB, for text extraction).
- **Size guards are inconsistent:** 100k chars for text, 8 MB inline, 10 MB for images — *but the image
  path still reads the whole file and only sets a badge*, and the Tauri `read_file_base64` path has no
  size check at all.
- **Doc/staged behaviour:** `RightDrawerDiffSection` discloses "Commits staged + unstaged changes"
  rather than offering a choice — honest, but there is no way to see or commit only what is staged.

---

## 8. Settings, customization, memory, onboarding

**Memory is the strongest area of the product** — the reference's structure is substantially already
there (You / Topics / Notes / Rules grouping, `Updated <Mon D>`, hover pencil/trash, a detail view with
Summary + Details, a pinned natural-language add bar, lane/source/confidence filters, export).

What is missing:

- **No "what will actually be injected next turn" preview** — `GET /api/brain/memory/preview` exists,
  is documented, and is called by nothing in `frontend/desktop/src`. Given `memoryAutoInject` defaults
  off while profile facts are always-in, this is the one control that makes the feature legible.
- **`GET /api/brain/memory/metrics`** is likewise unrendered, and `resetBrainConfig()` has **no caller**
  anywhere — so there is no UI route back to default brain behaviour.
- **Skills:** strong detail (usage chip, measured effect, lineage, trigger, source, inline body) but no
  category tabs, no tile grid, no `Add` pill, and the usage chip vanishes at 0 uses so an unused skill
  looks like a skill missing a feature.
- **Status codes reach the UI and are then thrown away:** the test endpoint returns `{success, latencyMs,
  error, content}` with the `[400]`/`[401]` prefix inside the string, and the UI renders it verbatim —
  so a bad key, a wrong base URL, a quota error and an unsupported field look identical. No typed error,
  no hint, no docs link.
- **First run is three overlays and three localStorage keys** with no shared state machine: the backend
  gate can be auto-restarting while the tour claims the screen, and the tour-vs-provider decision is a
  `sessionCount` proxy. A user who skips one can still be shown the other, and there is no "start over".
- **Small defects:** `window.alert` in Turn Limits where neighbours toast; the same model-test failure
  announced twice (role="alert" + toast).

**What August does better here:** settings search that finds hidden sections *and the matching control*
with `?field=` deep-linking and an honest "N of 44 sections · 17 in the rail" count; destructive dialogs
that quantify what is lost; a measured-effect/skill-usage story the reference lacks; and a candid
tooltip admitting the onboarding tour won't replay once you have conversations.

---

## 9. Cross-surface flow

**Five journeys traced; the recurring shape is "the backend knows, the UI doesn't say."**

- **J1 first run:** backend gate → tour → provider modal → composer no-model rail are four orderings of
  one problem, none of them a state machine. The orchestrator empty state is demonstrably better than
  the chat one (three runnable goal templates vs a lockup).
- **J2 long turn:** the transcript badge is excellent; every *rescue* behind it is invisible, `turn_end`
  never reaches Runs or the sidebar, and `awaiting-input` — the one reason that needs the human — ships
  an empty action set.
- **J3 background work:** automations self-disable after 10 consecutive failures with a human-readable
  reason that exists only inside the Automations page; there is no ambient "your automation stopped"
  signal anywhere, despite the sidebar having a destination row and an attention store to reuse.
- **J4 learning:** a proposal that needs a human is ≥2 navigations from the conversation that produced
  it; the inbox count badges three rails and never appears in chat; and the review pass is off by default
  with its switch in Memory while its ledger row and run-now button live in the Learning scheduler tab.
- **J5 continuity:** reload-mid-turn replay, terminal reconnect, OS notifications on hidden-tab
  completion and settings-over-live-chat are all solid. Breaks: `recovery` isn't in the durable render
  set (so the rescue notice is the one thing never replayed); the terminal tab `×` only *deselects* and
  reconnect is unbounded behind a permanent "Connecting to shell…" overlay; and a turn that stopped on
  `cap`/`budget` looks identical to one that `finished` everywhere outside the message.

**Which surfaces deserve first-class status, and which should collapse:**

- **First-class:** Chat · **Runs** (the only durable record of autonomous work) · **Automations** (with
  an ambient stopped indicator) · **Learning ▸ Inbox** (with its count in chat) · the drawer's
  Subagents/Jobs tabs.
- **Collapse into something that exists:** `recovery` → an inline row persisted like
  `CompactionNoticeCard`; `/board` → a view over Runs (it has no independent data model); `/live` → a
  composer mode (the composer already has a voice affordance); `/history` → a filter on the sidebar
  archive, which renders the same store; **Notifications** → the home for "automation stopped", "worker
  waiting on you", absorbing the attention dots instead of sitting two clicks inside Settings.

---

## 10. Reference-parity scorecard

| Dimension | Reference | August | Verdict |
|---|---|---|---|
| Turn transparency | interruption + retry detail inline | stop reasons excellent; rescues/retries invisible | **partial — high-value gap** |
| Transcript density | activity line + collapsed step list | stronger consolidation, 4-deep nesting, no level budget | **good, needs a ceiling** |
| Navigation | icon rail + sidebar + settings rail | sidebar + settings rail, 5 surfaces palette-only | **gap** |
| Composer | mode pills + model/effort on strip | everything stateful inside `+` | **gap** |
| Model picker | search + provider groups + per-model chips + footer actions | search + groups + keyboard, no metadata | **partial** |
| Documents | paper cards, floating page chip, continuous scroll, viewer download | paged canvas, footer strip, no viewer download | **gap** |
| Artifacts panel | grouped cards + `Download all` + thumbnails | rows + search + filter + honest bulk copy | **parity or better** |
| Memory settings | topic table, detail, natural-language box | richer data model, missing injection preview | **parity or better** |
| Skills | 2-col icon grid, category pills, `Add` | deeper detail, weaker grid | **partial** |
| Settings search | filter | finds controls, deep-links, honest counts | **better** |
| Background/autonomous work | minimal | rich surfaces, poor ambient signalling | **better capability, worse legibility** |
| Accessibility of focus | — | 5 invisible outlines, 12 token-bypassing rings | **gap** |

---

## 11. Sequenced plan

**Wave 1 — one-day fixes that unblock perception (all S)**
1. Flatten `boxShadow.elev`; add dark shadow alphas; migrate `shadow-2xl` → `shadow-elev-overlay`.
2. Register the `*-rgb` alpha channels (`destructive`, `accent`, `secondary`, `ring`, `sidebar-*`).
3. Replace the five `var(--dt-border)` focus outlines with `var(--dt-ring)`; re-point the dead
   `ring-ring/NN` sites; add `::selection`.
4. `--font-ui`/`--font-chat` → `rem`; add `@media (prefers-reduced-motion: reduce)` to `motion.css`;
   default `reduceMotion` from `matchMedia`.
5. Transcript column `58rem !important` → `48rem`; delete the composer's `rounded-2xl border-border/70
   shadow-md` and the `!important` that overrides them.
6. `onRecovery` → inline row + durable render set; consume `delayMs`/`reason` for the retry line.
7. `WorkingIndicator` elapsed seconds; `Thought for Ns` in the rail; `opacity-60` actions.
8. Download button in the document viewer; fix the `Download`-labelled open button; make `+N more`
   interactive.
9. Add `artifacts` + `notes` to the drawer dispatch allow-list; add the composer's missing
   typing-target guard.
10. Lazy-import mammoth + xlsx-js-style; add a size guard to `read_file_base64`.
11. Map `[4xx]` to human causes in the model test error; add `useFocusTrap` to the model modal.
12. Move the `memoryReview` switch onto the scheduler's review row; wire the memory-injection preview.

**Wave 2 — structural, one slice at a time (M)**
13. Collapse the two live status surfaces into one and make elapsed a turn-level fact.
14. Virtualize assistant-message *segments*, not whole messages; enforce a disclosure depth ceiling.
15. Model picker: show price/`free`/effective `apiFormat`; move `model + effort` onto the strip with the
    mode posture (a documented veto in `ComposerToolbar.tsx` must be consciously overturned).
16. Artifacts: one shared row component for transcript + drawer; admit all producing tools; exclude
    read-only ones; persisted artifact records.
17. Surface consolidation: Runs first-class; `/board` → a Runs view; attention spine reusing
    `needs-handoff-store` + the existing OS-notification path.

**Wave 3 — structural (L)**
18. One first-run → first-answer state machine over a single storage key.
19. One turn record fanning out to Runs, sidebar, badge and Learning chips.
20. Navigation shell with a rail (or promoted sidebar rows) for the six non-chat destinations.
21. Continuous-scroll paper-card PDF viewer with a pinned page chip and a hoisted header.
22. `updatedAt` on `Session` (+ migration) so "Last updated" becomes true.

**Suggested verification per wave:** `cd backend-py && uv run ruff check . && uv run mypy app/ && uv run pytest -q -n auto`
for any backend touch; `npm run test:frontend` for UI; `npm run check:docs` when a guarded number moves;
and a fresh `.ui-review` capture pass to confirm the tokens landed visually.

---

## Appendix — verification log

Checked directly in the working tree by me (not delegated), because these carry the report:

| Claim | How | Result |
|---|---|---|
| `shadow-elev-*` never renders | read `tailwind.config.cjs` → `theme.extend.boxShadow.elev` is a nested object; confirmed 9 call sites incl. `Surface`'s `ELEV_CLASS` map | confirmed dead |
| `onRecovery` has no consumer | repo-wide grep: test + dispatcher + type only | confirmed |
| ~197 alpha classes emit nothing | grep count of `/NN` on `sidebar-*`/`destructive`/`accent`/`secondary`/`ring`; config registers them as plain vars while status colours are `-rgb` | confirmed (197, vs 205 in the sub-audit's wider pattern) |
| Drawer palette entries are dropped | read `ChatLayout.tsx` allow-list: six of thirteen section ids | confirmed |
| `railTab` has no setter | repo-wide grep for `railTab`/`august-sidebar-tab` | confirmed (and nothing writes the key either — latent, not live) |

Everything else is reported from the seven sub-audits with their own `path:line` citations; where a
number is quoted from one (e.g. 773 `size-3` uses, ~50 `shadow-2xl` sites, ~31 type sizes), it is that
audit's measurement rather than mine.
