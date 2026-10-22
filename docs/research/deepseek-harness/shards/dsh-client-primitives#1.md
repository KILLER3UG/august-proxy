# deepseek-harness / dsh-client-primitives#1

## Shard shape

This shard is the browser-side **UI primitive layer** of the deepseek-harness Web GUI: three adjacent client packages that together own the composer's command surface, the docking layout engine, and the window shell. `packages/client/ui-commands` is the `/` command surface — a session-keyed host-command directory, a client contribution/decorations registry, and a headless `popupSelect` shell that business packages register against without ever seeing the shell component. `packages/client/ui-dockkit` is a docking layout kit with a hard two-layer split: a **pure** engine (a normalized split tree, invertible operations, pure planners, a linear history) and a React layer that renders a snapshot and reports **one settled intent per gesture, never a drag frame**. `packages/client/ui-layout` is the three-column `AppFrame` shell: the grid solve, the drag handles, the `ctx.layout` panel/geometry service, and a DOM-only theme presenter. They fit together the way the repo's own layering works: `ui-layout` owns the shell and declares the frame's child slots, `ui-dockkit` fills the `rightbar` column, and `ui-commands` fills the composer's input overlay — all three are pure browser-side packages that deliberately never touch a provider request (each README carries an explicit "KV Cache effect: None" section).

**What this shard is NOT**: none of the agent-loop, reasoning-stream, prompt-construction, context-compaction, memory, subagent, or model-adaptation lenses are covered here. Those live in other shards. The one lens this shard genuinely touches is **tool-call reliability at the UI boundary** (refusal instead of silent degradation; admission vs. outcome separation), plus **UI/UX patterns** (which it covers deeply), **config** (theme tokens, geometry constants), and **evals/testing** (22 test files, split between pure-engine specs and jsdom component specs).

## Per-file notes

### packages/client/ui-commands/locale/en.json
- Purpose: Package locale metadata only (`{"meta":{"title":"ui-commands"}}`); no runtime copy.
- Key abstractions: none.
- Data flow: consumed by the plugin marketplace's package listing, not by the app.
- Non-obvious design decisions: The English file omits `description` where zh has one — the meta block is not a parity-required pair.
- Edge cases / failure handling: n/a.
- Surprising: The real dictionary is `src/client/locales.ts`, not this file; two different i18n mechanisms coexist (per-package `locale/*.json` for package metadata, per-plugin in-source dictionaries for runtime copy).

### packages/client/ui-commands/locale/zh.json
- Purpose: Chinese package metadata (title "命令选择界面", one-line description).
- Key abstractions: none.
- Data flow: package catalogue.
- Non-obvious design decisions: The description names the user-visible capability ("provides a slash-command menu in the input box"), not the implementation.
- Edge cases / failure handling: n/a.
- Surprising: Same mechanism split as above — the runtime dictionary is `src/client/locales.ts`.

### packages/client/ui-commands/package.json
- Purpose: Manifest for `@deepseek-ai/dsh-client-ui-commands` (v0.2.1-rc.2).
- Key abstractions: `dsh.client.inject` lists the four browser plugins this one needs (`api-remotes`, `locale`, `ui-input-trigger`, `ui-conversation`); `exports` splits `.` (node half) from `./client` (browser half).
- Data flow: the loader reads `dsh.client` to place the browser half and inject its dependencies.
- Non-obvious design decisions: `"./src/*": "./src/*"` is exported so consumers (and other shards' tests) can import source directly.
- Edge cases / failure handling: n/a.
- Surprising: `devDependencies` lists `dsh-commands`, `dsh-session`, `dsh-util-values` and `dsh-api-session-controller` — the package's real contract reaches well past its own folder.

### packages/client/ui-commands/README.i18n.yaml
- Purpose: Per-heading hash record pinning the EN/ZH README pair.
- Key abstractions: a heading-path → hash map.
- Data flow: `pnpm run verify-translation-pairing --write <file>` regenerates it; a CI check compares.
- Non-obvious design decisions: The hash is per *heading section*, not per file, so one edited section invalidates only that section's hash.
- Edge cases / failure handling: n/a.
- Surprising: The repo enforces bilingual doc parity with a generated lockfile-like artifact — an unusually strong i18n contract for a client package.

### packages/client/ui-commands/README.md
- Purpose: Package reference for the command surface.
- Key abstractions: documents the three dispatch kinds (popupSelect / action / leadingInput) and the contribution-vs-decoration distinction.
- Data flow: n/a (documentation).
- Non-obvious design decisions: "a command line is never silently downgraded to a plain prompt" is stated as the summary's contract; the KV Cache section says "None directly; this package neither assembles nor sends a provider request" but notes a command handler that flips plan mode changes what the *owning* host package contributes to the next system prompt, invalidating the provider prefix from that point.
- Edge cases / failure handling: documents the known limit — detached-result notices fall back to the console once the session is torn down.
- Surprising: The README documents its own "Model Experience" and "KV Cache effect" sections per package — a repo-wide convention that every client package must state its model/prefix impact.

### packages/client/ui-commands/README.zh.md
- Purpose: Chinese mirror of the English README.
- Key abstractions: same section structure; the `README.i18n.yaml` hashes prove the pairing.
- Data flow: n/a.
- Non-obvious design decisions: The Chinese version is not a literal translation in tone — it keeps the technical nouns (popupSelect, action, leadingInput) in English.
- Edge cases / failure handling: n/a.
- Surprising: Section anchors are kept in English (`#use-this-package`) so cross-links from either side work.

### packages/client/ui-commands/src/client/contract.ts
- Purpose: The **frozen contract** of the client command surface — types only, no runtime.
- Key abstractions: `CommandContribution` (a client-owned slash command), `CommandDecoration` (a UI hung on an existing *host* command), `CommandUiSpec = PopupSelectSpec | ActionSpec`, `SelectOption`, `SelectConfirmation`, and the `CommandUiContract` face (`register` / `decorate` / `dismiss` / `popupFor`).
- Data flow: Business packages call `ctx.commandUi.register(...)`; the runtime consumes the contribution and never exposes the shell component to them.
- Non-obvious design decisions: `SelectOption.active` is documented as "the row the shell's highlight parks on when the panel opens, so an accept gesture made without looking confirms the value in use" — and explicitly warns that a business package marking a row `active` *for presentation alone* would silently make it the default pick. A decoration "never manufactures a row": a name with no host catalog entry simply never reaches it.
- Edge cases / failure handling: Duplicate names throw at registration; a host/contribution name collision "fails loud at candidate synthesis, never shadows".
- Surprising: `CommandContribution.label()`/`description()` are *functions*, not strings, so "Row copy is read on every candidate pass, so a locale change reaches the next menu open without re-registration."

### packages/client/ui-commands/src/client/directory.ts
- Purpose: The session-keyed command catalog cache (one entry per session).
- Key abstractions: `DirectoryStatus = cold | pending | ready | failed`; an `Entry` cell holding the snapshot, an epoch counter, the last error and the waiter list.
- Data flow: `refresh()` pulls through an injected `FetchCommands`; `ensureReady()` strong-waits; `resolve()` is a synchronous lookup used by the hot-key path.
- Non-obvious design decisions: **The epoch guard** (`const epoch = ++entry.epoch` at line 109) means only the latest pull may publish its outcome — a superseded pull's *success* cannot overwrite a newer snapshot and its *failure* cannot demote a newer success. Soft invalidation (`invalidateAll`) repulls in the background while ready snapshots keep serving. `resetConnected` is hard (the agent world may have changed shape across a connection generation) and `resetSession` is hard for one session (a preset switch changes which commands that session's agent resolves).
- Edge cases / failure handling: `ensureReady` **rejects** on a failed pull ("no silent downgrade") and on abort; the abort listener removes its own waiter so no leak survives.
- Surprising: The status enum's `ready` explicitly survives a soft-invalidate repull in flight — the cache is designed so a transient network failure never blanks a working menu.

### packages/client/ui-commands/src/client/index.ts
- Purpose: The browser plugin body: registers the locale namespace, mounts `CommandUiRuntime`, and injects the popupSelect shell into the `conversation.input.overlay` slot.
- Key abstractions: `declare module` augmentations for `ctx.commandUi` and the `command` locale namespace.
- Data flow: `ctx.inject(['slots','commandUi','sessions'], …)` resolves a per-session scope and hands `command.popupFor(actx)` to the overlay entry's `inject(sessionId)`.
- Non-obvious design decisions: The overlay is registered with `order: 1` and `id: 'command-popup'`; the slot's `inject` **throws** on an unknown session id ("resolved no scope") rather than returning a stub.
- Edge cases / failure handling: `ctx.locale` absence throws at construction; the whole plugin folds up on fiber disposal (HMR safety).
- Surprising: The type-only imports (`import type {} from '…/client'`) pull the *declaration* of a slot map into the program without creating a runtime edge — a deliberate way to avoid a circular dependency on ui-conversation.

### packages/client/ui-commands/src/client/locales.ts
- Purpose: The `command` namespace dictionary pair.
- Key abstractions: `zh` is the **key-set source of truth**; `en` is `satisfies Record<CommandKey, string>` so a missing key is a compile error.
- Data flow: `ctx.locale.register('command', { zh, en })`.
- Non-obvious design decisions: The dictionary holds both *display* copy (`label.*`, `description.*`) and *input spellings* (`token.*`) — the claim token is a separate string from the label so a locale can title a command "Goal" while still typing it as `goal`.
- Edge cases / failure handling: n/a.
- Surprising: `token.export` is `导出` (Export) while `label.export` is `下载日志` (Download log) — the input spelling and the display title are deliberately different words.

### packages/client/ui-commands/src/client/option-groups.ts
- Purpose: Shared grouping helper used by both filtering and rendering.
- Key abstractions: `groupOptions(options)` → groups in **first-occurrence order**, ungrouped rows in one headingless block at their first occurrence.
- Data flow: `filterOptions` calls it to order rows; `PopupSelectView` calls it again to build headings.
- Non-obvious design decisions: Groups are *not* sorted and rows are *not* sorted inside a group — the caller's order is the order.
- Edge cases / failure handling: n/a.
- Surprising: The same function serves the filter and the renderer, so "the order you see" and "the order you select from" cannot drift — and the test asserts the displayed order equals the ranked order.

### packages/client/ui-commands/src/client/popup.ts
- Purpose: The **headless** popupSelect shell state — one controller per session, owned by the runtime's per-session map.
- Key abstractions: `PopupState` (open/command/status/options/search/searchLabels/searchMode/active/submitting/confirming/acknowledged/error); `PopupSpec<TCtx>`; `PopupSelectDeps` (injected `consume` + `focusComposer`); `TokenSegment`.
- Data flow: `open()` publishes pending state and fetches options **once**; `setSearch` filters locally; `select()` settles through the open-time context and then consumes the token segment.
- Non-obvious design decisions:
  - **Binding-identity revocation** (line 294 / 300): every late settlement checks `this.binding !== binding`. A dismiss, reopen or dispose swaps the binding, so a settling options fetch or `onSelect` that no longer matches *writes nothing and consumes nothing*. The code says so explicitly: "a dismiss racing a succeeding onSelect revokes it: no consume, no focus".
  - **The highlight parks on the current value** (`currentIndex`, line 127): the row marked `active` is where Enter lands, so accepting without looking confirms the value in use.
  - **Search never re-queries** (line 211): "pure local filter — the provider is never re-queried". Options are loaded exactly once per open.
  - **A consume CAS miss is benign**: `consume()` returning false is never retried; the shell still closes and refocuses.
- Edge cases / failure handling: options load failure keeps the shell **open** with the search text retained and a `retry()` button; a failed `onSelect` keeps search/highlight/token intact and re-arms `select` as the retry; `dispose()` aborts in-flight work and clears state with no focus side effect.
- Surprising: The shell is explicitly "a transient layer (never in the input state machine)" — it holds no draft state and only ever asks the input side to consume a token it snapshotted at open time.

### packages/client/ui-commands/src/client/PopupSelectView.module.css
- Purpose: Styles for the popupSelect card.
- Key abstractions: `.card`, `.viewport`, `.row`, `.labelText`, `.detail`, `.badge`, `.check`, `.status`, `.search`, `.error`, `.retry`.
- Data flow: class names consumed by `PopupSelectView.tsx` through the CSS-module map.
- Non-obvious design decisions: The card is `position: absolute; bottom: calc(100% + 4px)` because the overlay anchor is a zero-height strip on the composer card's top edge and "entries float themselves above it". `max-width: 100%` so long rows truncate rather than pushing the card past the composer's edge. The search field is fully transparent (border + background) in both palettes.
- Edge cases / failure handling: The 320px design cap is clamped at runtime by `useAnchoredMaxHeight`.
- Surprising: `--dsh-scrollbar-thumb` is rebound locally to the l2 tokens because this sheet draws elevated surfaces — a base-surface thumb on an elevated ground "reads as a smudge".

### packages/client/ui-commands/src/client/PopupSelectView.tsx
- Purpose: The official popupSelect shell view, rendered into `conversation.input.overlay`.
- Key abstractions: `PopupSelectInjected` (the session's controller) + `PropsLocale<'command'>`.
- Data flow: `useSyncExternalStore` over the controller's snapshot store; the controller owns the state, the view owns only the DOM.
- Non-obvious design decisions:
  - **This shell HOLDS focus while open** (unlike the slash menu, which keeps the textarea focused): typing filters, ↑↓ walk, Enter/Tab accept, Escape/Shift+Tab dismiss back to the composer, and ←→ fall through to the input's native caret.
  - **Tab stays the browser's while nothing is settleable** (loading / failed / empty result) — that is how the error strip's retry button remains reachable.
  - **Outside pointerdown dismisses in the capture phase**, so the shell closes before the click's own handlers run, and the click's target takes focus naturally (no `focusComposer`).
  - The highlighted row is scrolled into view manually (`scrollIntoView({block:'nearest'})`) because the search input keeps focus, so the browser never scrolls the active row itself.
- Edge cases / failure handling: `readOnly` on the search input while `submitting`; the risk gate renders as a `RiskConfirmation` modal that replaces the card.
- Surprising: The view renders **null** when closed but the overlay slot stays mounted — the shell is not mounted/unmounted per open.

### packages/client/ui-commands/src/client/presentation.ts
- Purpose: The localized *face* of built-in host commands and the empty-query section order.
- Key abstractions: `MenuSection = 'add' | 'commands'`; `SECTION_ROWS` (Add: file, goal, plan, feedback; Commands: compact, permission, model, export); `HOST_FACES` mapping each built-in to a dictionary label/description and a glyph.
- Data flow: `builtinRowFace(descriptor, t)` is called per candidate pass; `sectionRows(rows, t)` groups the empty-query menu.
- Non-obvious design decisions: The face is selected by **definition identity**, not by name, so a same-name override keeps its own copy. The section order is a *usage order* list; rows not in either list close the Commands section in catalog order.
- Edge cases / failure handling: A non-first-party row keeps its catalog description and gets no glyph.
- Surprising: The `file` entry is a *client contribution* (registered by the composer) while `goal`/`plan`/`feedback`/`compact`/`permission`/`export` are host commands — the menu section mixes both kinds and the section order is by usage, not by origin.

### packages/client/ui-commands/src/client/resolution.ts
- Purpose: Command identity and localized input spelling.
- Key abstractions: `BUILTINS` (name → first-party `definitionId`), `BuiltinCommandName`, `TOKEN_ALIASES` (built from both locales' `token.*` strings).
- Data flow: `resolveCommand(token, descriptors)` is the directory's lookup; `claimToken(descriptor, t)` is the menu-pick spelling.
- Non-obvious design decisions: Resolution is **exact name first**, then a localized alias resolved *by definitionId* — so "an alias never selects an unrelated scoped override". A same-name override without the matching identity gets no first-party alias at all.
- Edge cases / failure handling: n/a.
- Surprising: `/计划` typed in a Chinese locale resolves to the `plan` descriptor and executes as `/plan` — the *draft* keeps the typed spelling while the *submission* carries the catalog name.

### packages/client/ui-commands/src/client/service.ts
- Purpose: `CommandUiRuntime` (`ctx.commandUi`) — the `/` source over the session-keyed directory, the contribution registry, and the per-session popup controllers.
- Key abstractions: the trigger-source hooks (`candidates`, `onPick`, `matchSpace`, `matchClaim`, `matchEnter`, `warm`); `LiveState` (contributions, decorations, popups keyed by `SessionBinding`).
- Data flow: catalog RPCs go through `sessions.using(sessionId, { source: 'commandCatalog' }, …)` so the session is retained until the fetch settles; `commands/change` invalidates the cache, `agent-preset/selected` resets one session, `connection/reset` hard-resets all.
- Non-obvious design decisions:
  - **A catalog fetch requires a retained session and waits for its initial history open** (line 97): "An unretained Session or a failed open rejects without sending the RPC, so background catalog refreshes do not reopen closed Sessions."
  - **Admission vs. outcome are separate** (line 407 onward): an unmatched line reports an error outcome (immediate composer feedback), but an admitted command reports plain success *regardless of its handler outcome*, because the host executor durably logged the lifecycle and the outcome renders as a persistent flow node. Attachments are consumed only after handler success; an error outcome keeps the draft and attachments.
  - **The envelope policy refuses attachments at the door** (line 332): only a command declaring `input.attachments` proceeds; every other route throws the localized refusal so the machine surfaces one composer notice and the draft stays in place — "nothing executes and nothing is dropped".
  - **Contained observers** (line 436): `command/executed` is dispatched manually and a failing listener (sync throw or rejected promise) is logged, never allowed to change an admitted result.
  - **The claim keeps the typed spelling, the submission sends the catalog name** (line 395).
- Edge cases / failure handling: A contribution that is unavailable falls through to the host catalog; a name the directory no longer serves returns `undefined` ("snapshot swapped between menu and pick"); a decoration with no host row never fires; a decoration with `available()` false falls through to the host bare path.
- Surprising: `matchSpace` is **synchronous and hot** (reads the ready cache, no RPC) while `matchEnter` **strong-waits** for the same directory — two different latencies for the same lookup, because Space must feel instant and Enter is a commit.

### packages/client/ui-commands/src/css-modules.d.ts
- Purpose: Ambient declaration for `*.module.css` class maps.
- Key abstractions: `declare module '*.module.css' { const classes: Record<string, string>; export default classes }`.
- Data flow: type-only; enables `import css from './X.module.css'`.
- Non-obvious design decisions: The class map is `Record<string, string>` — permissive, so a typo'd class name is not a compile error.
- Edge cases / failure handling: n/a.
- Surprising: Identical file duplicated in all three packages of this shard (and presumably repo-wide) rather than hoisted into a shared types package.

### packages/client/ui-commands/src/index.ts
- Purpose: Host (node) half of the plugin.
- Key abstractions: `apply(): void {}`.
- Data flow: the host loader/Loader sees the plugin exist; the browser half ships via `exports["./client"]`.
- Non-obvious design decisions: A deliberate empty apply so the plugin appears in `cordis.yml` / the Loader without a host-side behaviour.
- Edge cases / failure handling: n/a.
- Surprising: The same "empty node half" pattern appears in `ui-layout/src/index.ts`.

### packages/client/ui-commands/tests/browser-plugin.client.spec.ts
- Purpose: Plugin-level spec on a real cordis `Context`.
- Key abstractions: a `bench()` that provides fake `inputTriggers`/`remote`/`sessions` faces and a real `SlotRegistry`.
- Data flow: mount the plugin, assert the source and slot registrations, dispose the fibre, assert both are gone.
- Non-obvious design decisions: The fake `remote` face needs `$on` even though this spec dispatches no events, because "the service subscribes its cache-invalidation events on construction" — a real coupling the test had to honour.
- Edge cases / failure handling: asserts the overlay inject throws for an unknown session id.
- Surprising: The spec asserts the *frozen contract* conformance at runtime (`typeof contract.register === 'function'`) even though the compile-time assignment already checks it.

### packages/client/ui-commands/tests/directory.client.spec.ts
- Purpose: Unit specs for the session-keyed cache.
- Key abstractions: a `bench()` over per-key queues of hand-settled deferreds.
- Data flow: drives `refresh`, `invalidateAll`, `resetConnected`, `resetSession`, `warm`, `ensureReady`.
- Non-obvious design decisions: The epoch guard is tested in both directions — "a superseded pull cannot overwrite the newer one" and "a superseded failure cannot demote the newer success" — and separately that epochs are per key.
- Edge cases / failure handling: `ensureReady` rejects on a failed pull, retries from `failed`, rejects on abort, rejects immediately on an already-aborted signal, and keeps waiting across a superseded pull until the winner lands.
- Surprising: The bilingual alias resolution is tested here too (`resolve(S1, '目标')` finds the goal descriptor by `definitionId`).

### packages/client/ui-commands/tests/popup-view.client.spec.tsx
- Purpose: jsdom interaction spec for the shell view.
- Key abstractions: `mountOpen()` renders the view over a real controller and returns the search input by accessible name.
- Data flow: fires real DOM events against the controller.
- Non-obvious design decisions: The test stubs `Element.prototype.scrollIntoView` because jsdom has none, and asserts the *called* instance is the highlighted row.
- Edge cases / failure handling: covers the loading, failed-with-retry, submitting (locked, `readOnly`) and gated-modal states; asserts the card height is 320px when the composer sits low enough and 188px when clamped.
- Surprising: `fireEvent.keyDown` returning `true`/`false` is used as the assertion for "was this keystroke swallowed" — a neat, cheap way to test key consumption.

### packages/client/ui-commands/tests/popup.client.spec.ts
- Purpose: Controller specs (no DOM).
- Key abstractions: `makeDeps()` fake wiring whose `consume` answer is settable per test.
- Data flow: drives `open`, `setSearch`, `move`, `highlight`, `select`, `acknowledge`, `confirm`, `cancelConfirmation`, `dismiss`, `dispose`.
- Non-obvious design decisions: The suite asserts the *observable* consequences rather than internal calls: "a consume CAS miss is benign: no retry, still closes and refocuses"; "a dismiss racing a succeeding onSelect revokes it"; "a reopen racing a succeeding onSelect keeps the new shell: no consume of the old segment".
- Edge cases / failure handling: options-load failure keeps search; retry re-parks the highlight *inside the retained search text*.
- Surprising: `filterOptions` is exported and tested directly, including the fuzzy-label mode ranking labels *within each group* while preserving group order.

### packages/client/ui-commands/tests/service.client.spec.ts
- Purpose: The largest spec — the runtime's decision tables on a real cordis Context.
- Key abstractions: `bench()` with scripted `commands`/`execute` responses, a deterministic key-echo translator, fake `conversation` face collecting `notify`/`focus`.
- Data flow: exercises candidate synthesis, `onPick`, `matchSpace`, `matchClaim`, `matchEnter`, `execute`, `popupFor` and the invalidation events.
- Non-obvious design decisions: `carried()` folds a programmed failure into the Remote's `ok:false` branch rather than throwing at the caller — the test honours the transport's error-carrying shape. The suite has a `describe('menu presentation (design doc for #3567)')` block that pins the exact section order and the localized face of every shipped command.
- Edge cases / failure handling: A refused history open never sends the RPC; a released session never gets reopened; an addressed child session never fetches Agent-bound commands; a torn-down scope drops the failure notice; removing the `conversation` consumer drops notices.
- Surprising: The "same-name override" case asserts that a same-name command which *copies* the first-party description still gets **no** first-party alias — identity beats text.

### packages/client/ui-commands/tsconfig.json
- Purpose: Project references and root/out dirs.
- Key abstractions: 14 project references (remotes, session-controller, cordis, locale, store, ui-conversation, ui-primitives, ui-renderer, ui-session, ui-input-trigger, ui-slots, interaction/commands, core/session, util/values).
- Data flow: the TypeScript build graph.
- Non-obvious design decisions: `outDir: lib/types` — the declaration output lives beside the JS bundle.
- Edge cases / failure handling: n/a.
- Surprising: The reference list is the real dependency surface; it names `interaction/commands` and `core/session`, which is where the host-side command registry lives.

### packages/client/ui-commands/tsdown.config.ts
- Purpose: Bundle config.
- Key abstractions: `clientBundle(import.meta.dirname, ['lib/types/index.js'])`.
- Data flow: tsdown emits `lib/index.js` + `lib/client.js` + types.
- Non-obvious design decisions: The shared helper handles the dual node/browser output split.
- Edge cases / failure handling: n/a.
- Surprising: Only three lines — the whole build convention is centralised in `packages/client/tsdown.client.ts`.

### packages/client/ui-dockkit/package.json
- Purpose: Manifest for `@deepseek-ai/dsh-client-ui-dockkit`.
- Key abstractions: "split-tree engine with invertible operations, and the React components that render and drive it (zero cordis)".
- Data flow: `files` ships `lib/index.js`, `lib/**/*.css` and the types — the stylesheet is part of the published artifact.
- Non-obvious design decisions: "zero cordis" is called out in the description: the kit is a plain library with no plugin runtime.
- Edge cases / failure handling: n/a.
- Surprising: `cordis` is only a *peer* dependency; the kit never touches it.

### packages/client/ui-dockkit/README.i18n.yaml
- Purpose: Per-heading EN/ZH hash record.
- Key abstractions: heading-path → hash.
- Data flow: the translation-pairing check.
- Non-obvious design decisions: Same mechanism as ui-commands/ui-layout.
- Edge cases / failure handling: n/a.
- Surprising: The README's most valuable content (the seven interaction rules) is in a section that also carries an anchor, so the pairing check covers it.

### packages/client/ui-dockkit/README.md
- Purpose: Package reference for the docking kit.
- Key abstractions: the two-layer split; the three outward contracts (`DockLabels`, `TabRenderer`, `DockIntents`).
- Data flow: n/a (documentation).
- Non-obvious design decisions: The README explicitly labels the package "**Internal engine**" — published because the Sidebar links it statically, not as a stable API; "none of them appears in a service interface (`ctx.sidebarRight` exposes operations, never layout snapshots or operation logs)". It also states that the kit "keeps **one** stylesheet" because "a consumer de-duplicates injected sheets by file name and a collision would drop one silently".
- Edge cases / failure handling: Declares the limits — fractional weights only (no snap/priority/preferred size), touch untuned, accessibility incomplete (no `separator` role on dividers, no keyboard route to split/move/float), and no published stylesheet contract (consumers get hashed class names).
- Surprising: The interaction-rules section opens with "These are not stylistic; each one fixes a defect found in a real browser" — and then names the specific defects (pointer capture, chips-giving-way, the room rule, focus-on-click, nested controls, accent tokens). This is a rare example of a UI README that records *why* each pixel rule exists.

### packages/client/ui-dockkit/README.zh.md
- Purpose: Chinese mirror of the dockkit README.
- Key abstractions: same seven rules.
- Data flow: n/a.
- Non-obvious design decisions: The Chinese version preserves the numeric pixel arithmetic verbatim (80px, 24px, 100px, 34px, 48px) because the rules are arithmetic.
- Edge cases / failure handling: n/a.
- Surprising: The Chinese version expands a couple of English sentences (e.g. the room rule) rather than compressing them — the pairing check hashes blocks, so expansion is allowed as long as both sides are updated.

### packages/client/ui-dockkit/src/components/dockkit.module.css
- Purpose: The kit's single stylesheet.
- Key abstractions: token-only colours (`--dsw-alias-*`); the two layer variables `--dsh-dockkit-dock-layer` / `--dsh-dockkit-float-layer`.
- Data flow: class names consumed by the components through the CSS-module map.
- Non-obvious design decisions:
  - **One sheet, on purpose** (lines 1–15): a consumer de-duplicates injected stylesheets by file name; a second sheet with a colliding name would be dropped silently.
  - **The divider takes no layout room**: its hairline is painted over the seam with a 0.5px pseudo-element, so a body's own rule runs unbroken past it; `::after` widens the hit target to 8px.
  - **The chip box is the strip's one shrinking part** (`flex: 0 1 auto; min-width: 0; overflow-x: auto`); every control after it is `flex: none`. Edge fades are `mask-image` gradients driven by the `data-dockkit-strip-scroll` attribute.
  - **A chip's title is never ellipsized** — it fades over its last 16px under a mask.
  - **Emphasis takes the platform accent token** `--dsw-alias-brand-primary-new-colorprimary-new-color`, never `--dsw-alias-brand-primary`, because on this platform `brand-primary` is the near-black/near-white foreground.
  - **macOS app-region subtraction** is scoped to `:global(html[data-platform='darwin'])` and lists `.stripTabs`, `.stripChrome`, `.paneBody`, `.float` and `.divider` — the divider must be named because it is a plain div that base.css's interactive-element rule never matches.
- Edge cases / failure handling: `prefers-reduced-motion` and `prefers-reduced-transparency` media queries; the Windows caption clearance is published as `--dsh-dockkit-float-top`.
- Surprising: The chip's close control is `opacity: 0; pointer-events: none` until hover/focus/active — "Hidden means untouchable too: without this a touch press on the chip's trailing 20px would close the tab instead of activating it."

### packages/client/ui-dockkit/src/components/DockSurface.tsx
- Purpose: The docked surface: the split tree plus the tab and divider gestures.
- Key abstractions: `DockSurfaceProps`; `Preview` (dragging tab, drop target, live sizes); `DividerDrag`.
- Data flow: a gesture previews in local `useState` while its facts stay in the gesture's closure; on release the net result leaves through exactly one `DockIntents` call.
- Non-obvious design decisions:
  - **A release clear of the surface floats the tab; a release inside it but on no pane is not a move at all** — the distinction is `containsPoint(rootRect, x, y)`.
  - **An edge zone is only offered where the split it would make is allowed**: within the pane budget *and* with room for two halves; otherwise the release is not a move.
  - **A divider release that left the fractions where they were reports nothing** (`if (sameSizes(sizes, drag.sizes)) return`, line 272) — a click, a drag returned to its start, or one pushed further into the clamp is not a resize.
  - The room rule is re-measured on every commit and on surface resize; a reading that changed nothing renders nothing (`sameFits`).
- Edge cases / failure handling: `dropZones="horizontal"` offers two half-pane hints; once budget or width forbids another split the whole body accepts a move.
- Surprising: The measured `fits` map is fed to `onRoom` so an embedder splitting *programmatically* can honour the same rule the split control does — the measurement is published, not private.

### packages/client/ui-dockkit/src/components/FloatLayer.tsx
- Purpose: The floating overlay layer — one panel per floating pane, bottom-to-top.
- Key abstractions: `FloatLayerProps`; `useFloatGestures(state, intents)` returning `{ preview, raise, drag }`; `FloatHeader`.
- Data flow: panels are positioned in viewport coordinates from `state.floats`; the layer owns its own gestures and may be mounted anywhere, including a portal.
- Non-obvious design decisions:
  - **Pressing a panel's body raises it; the grip and corner report through their gesture instead** — a press released in place is a click that raises the panel; a drag records only the move or resize, and *that operation* raises the panel. One gesture, one intent.
  - **Raising a panel that is already active and on top changes nothing and reports nothing.**
  - The Windows caption clearance is applied at gesture start (the drag starts at the *displayed* position, not the stored one), so a panel restored under the caption cannot be dragged into it.
- Edge cases / failure handling: The float's minimum size is enforced by `resizedRect` with `FLOAT_MIN_SIZE`; `canCloseTab` is honoured per tab.
- Surprising: The grip/corner press calls `event.stopPropagation()` so the panel's own press-to-focus does not record a *second*, redundant focus entry before the drag's.

### packages/client/ui-dockkit/src/components/measure.ts
- Purpose: The DOM side of the room rule.
- Key abstractions: `paneElements(root)` (pane ids paired with elements, restoring the brand from the DOM attribute), `measurePaneFits(root, splitHiddenWhenBlocked)`, `fitOf`, `sameFits`.
- Data flow: reads rectangles and computed styles, hands them to `halvesFit` in the engine.
- Non-obvious design decisions:
  - **The chip minimum is read from a rendered chip's computed style**, and the box-sizing is respected: a content-box chip's footprint is `min-width + padding + border`, a border-box chip's is `min-width`. The stylesheet figure (100px) is the fallback.
  - **`splitControlWidth` is only included when the embedder hides blocked split controls** — otherwise the control's own footprint would be counted twice.
- Edge cases / failure handling: An unmeasured pane (no layout, as under jsdom) reads as **fitting**: "the rule only blocks on a positive reading."
- Surprising: `paneElements` is the *only* place the `PaneId` brand is restored from a DOM string — "the brand is restored here and nowhere else."

### packages/client/ui-dockkit/src/components/PaneTree.tsx
- Purpose: Recursive renderer for the docked split tree.
- Key abstractions: `SizePreview`; `PaneTreeProps`.
- Data flow: reads `getNode(state, nodeId)` and recurses; sizes become `flexGrow` on each cell.
- Non-obvious design decisions: **A live divider drag renders from the preview fractions instead of the recorded ones** — the gesture only settles one intent when it ends.
- Edge cases / failure handling: n/a.
- Surprising: The divider element carries `data-dockkit-divider="${splitId}:${index-1}"` — a composite id that lets a spec address one divider in a nested tree.

### packages/client/ui-dockkit/src/components/pointer.ts
- Purpose: Shared pointer ownership for the surface and the float layer.
- Key abstractions: `PointerFollowers`; `GestureFollowers`; `BeginGesture`; `useGesture(reset)`.
- Data flow: `followPointer` captures the pointer, then installs three window listeners filtered by `pointerId`.
- Non-obvious design decisions:
  - **Capture is hardening, not the mechanism**: "the window listeners carry the gesture either way. Capture is what stops a scroll container the pointer crosses from claiming it, which Chromium reports as a cancelled pointer and an abandoned drag. Environments without the API (jsdom) simply go unhardened."
  - **Only that pointer's events count**: a second finger or a pen beside the mouse neither moves nor ends the gesture.
  - **One gesture at a time per component**: a new press supersedes the previous one, and `reset` runs at each end so the component clears its preview.
- Edge cases / failure handling: Unmounting mid-gesture removes the listeners without resetting anything; the listeners remove themselves before `up`/`cancel` runs; the `data-dockkit-pointer` marker is cleaned up on abort.
- Surprising: `useGesture`'s `reset` callback is invoked *before* the `up` follower runs — "The gesture has already ended, and its preview reset, when this runs", so the settlement code never sees a stale preview.

### packages/client/ui-dockkit/src/components/render.ts
- Purpose: The internal prop share the kit's components pass among themselves.
- Key abstractions: `PaneCallbacks` (settled callbacks, gesture starters, live preview, policy callbacks, labels, renderers, chrome).
- Data flow: `DockSurface` builds one `PaneCallbacks` and hands it down the tree.
- Non-obvious design decisions: The outward contracts live in `contract/adapter.ts`; this file is explicitly "internal to the package".
- Edge cases / failure handling: `SplitBlock = 'budget' | 'width'` names *why* a split is disabled, so the UI can pick the right localized reason.
- Surprising: `canAddTab`/`canCloseTab` are **policy callbacks**, not gestures — they are called per pane/per chip on every render and they withhold a control without moving anything else.

### packages/client/ui-dockkit/src/components/TabLayout.tsx
- Purpose: The Sidebar-style layout: stable tab containers across selection, pane moves and floating.
- Key abstractions: `TabRetention` (`keepMounted(tab)`, `active`); `TabHost`; `focusRequest` ref.
- Data flow: every tab is rendered as a Grid cell; `state.tabs` is **sorted by id** so React never moves a connected webview's ancestor.
- Non-obvious design decisions:
  - **`keepMounted(tab)` retains visited bodies; `active` controls Session visibility without reparenting content.** An invisible host gets `inert` and its focused child is blurred.
  - **Focus handoff is guarded**: the newly selected strip's chip receives focus only if nothing else deliberately took it ("Preserve deliberate focus taken by another control or the newly shown body").
  - **A body that raises focus raises its floating panel** — Electron emits a non-bubbling focus event on the webview element, so the listener is registered in the capture phase.
- Edge cases / failure handling: A selected tab that becomes floating in the same update must not require a docked strip to exist.
- Surprising: `gridColumn`/`gridRow` place cells explicitly and `order` only changes painting — "raising a float never moves a connected DOM ancestor."

### packages/client/ui-dockkit/src/components/TabMenu.tsx
- Purpose: The per-tab context menu (secondary press on the chip).
- Key abstractions: `TabMenuProps`; `placeMenu(anchor, menu)`.
- Data flow: rendered in a **portal** to `document.body`, positioned after a measurement pass.
- Non-obvious design decisions:
  - **The portal is necessary because the chip box clips its overflow on purpose** — a menu drawn inside the strip would be clipped with it.
  - **React bubbles the portal's synthetic events through the strip**, so both halves of a press must `stopPropagation()` — otherwise the press starts a tab drag, captures the pointer, retargets the release and swallows the item's click.
  - **A menu that would hold no item never paints**: the CSS hides it when it contains no `role=menuitem*`, and the component returns null when there is no close and no extras.
  - Escape is only honoured when unmodified, not composing, and not a key repeat; a foreground modal gets it first (`modalSelector`).
- Edge cases / failure handling: A press dispatched to the window itself (no element target) counts as outside; focus returns to the tab without a ring (`focusWithoutRing`).
- Surprising: The kit's own item (close) is rendered **first** so it is in the same place in every menu — "a reader looks for it in the same place every time."

### packages/client/ui-dockkit/src/components/TabPanel.tsx
- Purpose: One pane: the tab strip and the active tab's body with the drop-preview overlay.
- Key abstractions: `TabStrip`; `PaneDropHints`; `TabPanel`; `chipToFocus`; `hiddenSides`; `useStripScrollFades`; `useActiveChipInView`.
- Data flow: the strip reads `pane.tabs` and `pane.activeTabId`; gestures go out through `PaneCallbacks`.
- Non-obvious design decisions:
  - **Focus lands on click, not on press** (line 279): "a state change between `pointerdown` and the first `pointermove` rebuilds the pressed subtree, and Chromium cancels the pointer when the pressed element is replaced — which would abandon every drag. A drag that ends elsewhere fires no click, and its own operation carries focus."
  - **A secondary press is the menu, never a drag.**
  - **A nested control stops its own press** — otherwise the press starts a drag, captures the pointer, and the nested control's click never lands.
  - **The scroll fades are written to the DOM directly**, not through state, because a reading never changes what renders — only how the stylesheet paints it.
  - **A pane's lone unclosable chip draws quiet** — no capsule, no hover fill — "since there is nothing to select against and nothing to do to it."
- Edge cases / failure handling: The chip box scrolls so the active chip clears the 24px fade band; a chip already in view moves nothing. The known gap is stated in the code: a content-width change that alters neither the tabs nor the box's outer size keeps the fade at its last reading.
- Surprising: The window drag claim (`data-window-drag`) is **withdrawn while any pane floats**, because a floating pane can sort before this row in the document, where the row's drag box would override the float's own subtraction.

### packages/client/ui-dockkit/src/components/TabTitle.tsx
- Purpose: A chip's title: one line, clipped at the chip's inset, never ellipsized.
- Key abstractions: `markClipped(element)`.
- Data flow: sets/clears `data-dockkit-tab-clipped` on the span; the stylesheet fades the text with a mask.
- Non-obvious design decisions: **Written to the DOM directly rather than through state** — "a reading changes nothing that renders, only how the stylesheet paints it." Re-read after every commit and on resize via a `ResizeObserver`.
- Edge cases / failure handling: Sub-pixel widths: the text counts as clipped past one whole pixel.
- Surprising: A mask rather than a painted gradient, because the chip's fill is bare, translucent hover, or the active tag colour — "a mask matches every one without naming it."

### packages/client/ui-dockkit/src/contract/adapter.ts
- Purpose: The kit's outward contracts: state in, intents out.
- Key abstractions: `DockLabels`; `TabRenderer`; `TabMenuExtras`; `DockIntents`.
- Data flow: the embedder supplies all strings and all tab bodies; the kit holds no copy, no icon set, and no knowledge of `tab.kind`.
- Non-obvious design decisions:
  - **`DockIntents` is one call per settled gesture — never a drag frame**, "so an embedder recording them produces one operation per gesture."
  - `TabMenuExtras` items must carry `role="menuitem"`, because the kit probes for that role to dismiss a menu that would paint empty; an item that acts MUST call `dismiss`.
  - `duplicateTab` exists in the vocabulary but **has no kit control** — it is the embedder's API.
- Edge cases / failure handling: `canSplit`/`canAddTab`/`canCloseTab` are the three control-policy props; omitting one keeps the permissive default.
- Surprising: `DockLabels` includes accessible names for controls with no visible text, because "the kit must not invent it."

### packages/client/ui-dockkit/src/contract/types.ts
- Purpose: The layout model and operation vocabulary — types only.
- Key abstractions: branded `PaneId`/`SplitId`/`TabId`; `SplitNode`/`PaneNode`; `LayoutState`; `PaneAttachment`; the closed `LayoutOp` union; `ApplyResult`.
- Data flow: the whole engine speaks these types.
- Non-obvious design decisions:
  - **Ids are branded**, so a pane, a split and a tab never stand in for one another or for a bare string; only a mint (or the kit's own DOM round trip) produces one.
  - **A floating panel is not a second concept** — it is a pane whose `host` is `'float'`, capacity one tab, drawn without a tab strip.
  - **Every operation carries the ids it creates**, so `replay(initial, ops)` reproduces the same tree without any minting during apply.
  - `insertPane`, `insertTab` and `restoreFocus` exist *only* to express inverses exactly.
- Edge cases / failure handling: `activeTabId` is `undefined` exactly when `tabs` is empty; `rect` is set exactly when `host === 'float'`.
- Surprising: `DockMode` (`push`/`fullscreen`) lives in the model even though the kit does not implement either — "switching is a recorded operation the user can step back through."

### packages/client/ui-dockkit/src/css-modules.d.ts
- Purpose: Ambient CSS-module declaration.
- Key abstractions: same two lines as the sibling packages.
- Data flow: type-only.
- Non-obvious design decisions: none beyond the permissive `Record<string, string>`.
- Edge cases / failure handling: n/a.
- Surprising: Duplicated verbatim in three packages in this shard.

### packages/client/ui-dockkit/src/engine/constraints.ts
- Purpose: Interaction limits and dock geometry — pure, assertable without a browser.
- Key abstractions: `MAX_DOCK_PANES = 4`; `MIN_PANE_FRACTION = 0.12`; `FLOAT_DEFAULT_SIZE`; `FLOAT_MIN_SIZE`; `DOCK_EDGE_FRACTION = 0.25`; `zoneAt`; `zoneSplit`; `clampSizes`.
- Data flow: `canSplit(state)` gates the split planner and the UI's split control; `clampSizes` guards both the preview and the committed resize.
- Non-obvious design decisions: **The model itself is unbounded; these are V1 rules the interaction layer enforces before dispatch.** Floating panes do not count toward the pane cap.
- Edge cases / failure handling: `clampSizes` pins every share under the floor at the floor and hands the remainder to the others in proportion, re-pinning on each pass until the floor holds exactly; an all-zero input is shared equally; `floor` is capped at `1/sizes.length` so a ten-pane split does not starve everyone.
- Surprising: `zoneAt` picks the **closest** edge in a corner, not a fixed priority — so a pointer in the top-left corner reads as `left` or `top` depending on which edge it is nearer.

### packages/client/ui-dockkit/src/engine/controller.ts
- Purpose: `DockController` — the stateful embedding of the intent layer, and itself the observable source.
- Key abstractions: `DockSnapshot` (state, canUndo, canRedo, canSplit, opCount, cursor); `DockControllerOptions` (`makeInitialTab`, `makePaneTab`, `mode`).
- Data flow: every method is a planner call → `sequencer.dispatchAll(ops)` → one notification.
- Non-obvious design decisions:
  - **A planner returning no operations records nothing and notifies nobody** — `run()` returns `false` early on an empty plan.
  - **The snapshot reference only changes when the layout does** (`getSnapshot` returns the same object between changes), which is what makes it safe to use as a `useSyncExternalStore` snapshot.
- Edge cases / failure handling: `splitPane` returns false at the pane cap; `addTab` returns false without a factory; `placeTab` returns false when the placement changes nothing.
- Surprising: The controller **satisfies `DockIntents` as written**, so an embedder can pass it straight to `DockLayout`/`DockSurface` — or route through its own store and implement the same method names.

### packages/client/ui-dockkit/src/engine/geometry.ts
- Purpose: Pure geometry for the drag interaction — point tests, zone resolution, strip slots, the room rule.
- Key abstractions: `Rect`; `DropTarget` (`strip` or `zone`); `PaneMeasure`; `SplitMinimums`; `HalvesFit`.
- Data flow: the component layer measures rectangles and calls in; the engine's planners never see pixels.
- Non-obvious design decisions:
  - **The room rule** (`halvesFit`, line 127): after an equal split each half must hold what cannot shrink — horizontally the strip's *fixed* part (padding, gaps, every control that half would still draw) plus one chip at its minimum; vertically the strip plus a minimum body. The border delta between the pane's box and the strip's is subtracted from the half.
  - **`splitControlWidth` exists to keep the reading stable** (lines 74–83): when the embedder hides blocked split controls, the control's own footprint is left out of the fixed part, because "the control hiding sheds the same footprint from the strip, and a reading that counted it would flip with the control's visibility and re-render forever."
  - `SPLIT_MINIMUMS` mirrors the stylesheet by hand: divider 0 (its hairline paints over the seam without taking layout room), chip 100 (80px content-box + 10+10 padding), body 48 (one 13px secondary line at 1.6 line-height inside 12px of insets).
- Edge cases / failure handling: An unmeasured pane (no layout) fits — the rule only blocks on a positive reading; `zoneInRect` on a collapsed rectangle reads `center`.
- Surprising: `dividerSizes` moves the whole change between the two neighbours only; a boundary with no pair leaves the fractions alone.

### packages/client/ui-dockkit/src/engine/initial.ts
- Purpose: Initial state and the identity mint.
- Key abstractions: `IdMinter`; `TabFactory`; `createIdMinter(seed)`; `createInitialState(minter, makeInitialTab, mode)`.
- Data flow: the minter produces every id in the surface's lifetime.
- Non-obvious design decisions:
  - **Ids are minted outside `applyOp`** so a recorded sequence replays to the exact same tree.
  - **The first tab belongs to the initial state rather than to an operation**, so expanding and collapsing never accumulates copies of it.
- Edge cases / failure handling: `makeInitialTab` omitted → an empty pane.
- Surprising: The minter is a plain counter (`pane1`, `tab2`, …) with the prefix naming the kind — deterministic ids make test assertions readable.

### packages/client/ui-dockkit/src/engine/operations.ts
- Purpose: The operation engine — one pure `applyOp` that returns the next state **and the operations that undo it**.
- Key abstractions: `applyOp(state, op): ApplyResult`; `replay(state, ops)`.
- Data flow: `applyOp` never mutates; every writer returns a new state with untouched nodes at their old identity.
- Non-obvious design decisions:
  - **Inverses are captured when an operation runs, because by undo time the pre-operation state is gone.** Each op's inverse is a *list* (a split's inverse is `merge` + `resize`).
  - **`insertPane`/`insertTab`/`restoreFocus` exist purely to express inverses**, and are applied like any other operation.
  - `applySplit` joins an existing split of the same axis instead of nesting, halving the reference pane's share.
  - `applyCloseTab` moves focus to the *previous* neighbour (`neighbourTabId`), and a floating host pane goes with its only tab.
- Edge cases / failure handling: Every reader throws on a dangling id ("the operation vocabulary is closed, so a miss is a caller defect"); operations refuse invalid targets with specific messages (`use unfloat`, `use reorderTab`, `docked pane`, `already exists`).
- Surprising: `applyMoveFloat`/`applyResizeFloat` **focus and raise** the pane as part of the same operation — one gesture, one operation, one undo step.

### packages/client/ui-dockkit/src/engine/planner.ts
- Purpose: Intent planning — each interaction as a pure function from state to operations.
- Key abstractions: `Mint` (the one place a string becomes an id); `OpenContentInput`; `PlannedTab`; `plan*` functions.
- Data flow: planners mint the ids their operations create and enforce the interaction limits, but hold no state and apply nothing.
- Non-obvious design decisions:
  - **"A planner returning no operations means the intent changes nothing; the caller records nothing and notifies nobody."** (line 13)
  - **The same intent vocabulary serves two embeddings** — a `DockController` that keeps the state, and a host store that keeps it and only needs the operations — "without either one reimplementing `openContent`'s identity lookup, `dropTab`'s region resolution, or the floating cascade."
  - **`planPlaceTab`'s caret arithmetic**: the slot is counted over the strip *as drawn*, the dragged chip included, and `reorderTab` indexes the strip *without* it — so a caret past the chip counts one slot the chip itself vacates.
  - **`planDropTab`'s backfill**: a pane's only tab released on its own edge splits and the factory's tab backfills the pane the drag would otherwise empty; the backfill is seated **before** the move so the moved tab ends focused. Without a factory that release changes nothing.
  - **`planSettle`** merges away panes an intent emptied, innermost first, and reseeds an emptied root pane through the factory — the rule is opt-in.
- Edge cases / failure handling: Planning nothing into a floating pane (no split, no seeded tab, no drop); `planOpenContent` de-duplicates on the `(kind, contentId)` pair unless told `revealIfOpened: false`.
- Surprising: `planSettle` calls `applyOp` internally to compute the merge cascade, then returns the operations — so the caller records one combined entry.

### packages/client/ui-dockkit/src/engine/sequence.ts
- Purpose: Linear operation history over `applyOp`.
- Key abstractions: `HistoryEntry`; `History` (plain data, safe to store); `record`/`stepBack`/`stepForward` (pure); `Sequencer` (mutable wrapper).
- Data flow: `record` applies each op and **prepends** its inverse, so undo runs the inverses in reverse operation order.
- Non-obvious design decisions:
  - **Recording is total** — every operation lands in the sequence, focus moves included — but **stepping is coarser across focus**: a run of consecutive focus-only entries undoes and redoes as one step.
  - **A new entry after an undo drops the redo branch.**
  - **Two shapes, one implementation**: the pure functions serve an embedder holding its layout in an external store; `Sequencer` is a thin mutable wrapper for one that would rather hold the state here.
- Edge cases / failure handling: An invalid operation leaves the sequence untouched (the docstring says so and the spec asserts it).
- Surprising: `History` is plain data — "safe to store" — so a host can persist it and rebuild the layout by replaying it.

### packages/client/ui-dockkit/src/engine/tree.ts
- Purpose: Pure tree helpers over `LayoutState`.
- Key abstractions: `getNode`/`getPane`/`getSplit`/`getTab`; `findParent`; `findTabPane`; `dockPaneIds`; `normalizeSizes`; `withNodes`/`withTabs`; `insertAt`/`removeAt`; `neighbourTabId`; `replaceInParent`; `firstDockPaneId`; `topRightPaneId`.
- Data flow: read by the engine and the components.
- Non-obvious design decisions:
  - **Every reader throws on a dangling id** — the vocabulary is closed, so a miss is a caller defect.
  - **Every writer preserves identity for untouched nodes** (`withNodes`, line 193) so consumers can compare by reference.
  - `topRightPaneId` descends taking the *last* child of every row split and the *first* of every column split — "its tab strip is where an embedder's surface-wide controls sit, so they read as the surface's own top-right corner however the tree is divided."
  - `normalizeSizes` copies an already-normalised list unchanged, "so restoring recorded sizes never drifts."
- Edge cases / failure handling: `floatRect`/`floatIndex`/`onlyTabId` refuse a docked pane; `replaceInParent` refuses an id that is neither rooted nor parented.
- Surprising: `findParent` and `findTabPane` are O(n) scans over `Object.values(state.nodes)` — simple, but a size limit on the tree (4 panes) is what keeps them honest.

### packages/client/ui-dockkit/src/index.ts
- Purpose: The public surface of the kit.
- Key abstractions: re-exports grouped as "Model and operations", "Interaction limits and geometry", "Intent planning", "The intent layer's stateful embedding", "Outward contracts", "React surface".
- Data flow: the Sidebar imports from here.
- Non-obvious design decisions: The module docstring states the boundary is the point of the package.
- Edge cases / failure handling: n/a.
- Surprising: `TabLayout` is exported from `DockSurface.tsx` (not from a file of its own) — the two share the `Surface` shell.

### packages/client/ui-dockkit/tests/app-region-styles.client.spec.ts
- Purpose: Asserts the stylesheet **on disk** (read with `node:fs`) — the macOS app-region ownership and the Windows caption clearance.
- Key abstractions: a tiny regex parser that strips comments and extracts `[selector, body]` pairs containing `-webkit-app-region`.
- Data flow: reads `../src/components/dockkit.module.css` directly.
- Non-obvious design decisions: The spec asserts there is **exactly one** app-region rule — "a sheet that declares it here would drag the same box twice and hide the row from the ownership gate."
- Edge cases / failure handling: asserts the subtraction is scoped to `html[data-platform='darwin']` so the strip's drag never reaches a non-macOS host.
- Surprising: A CSS file is asserted by a *test*, not just by a stylesheet linter — the macOS divider exclusion is invisible to any other kind of check.

### packages/client/ui-dockkit/tests/apply.client.spec.ts
- Purpose: Operation-engine specs.
- Key abstractions: `expectRoundTrip(state, op)` — apply, then apply the inverse, and require the *exact* original state back.
- Data flow: drives every op type against a seeded fixture.
- Non-obvious design decisions: The round-trip helper is the spine of the suite: "what each operation does to the tree, and that applying its inverse returns the exact state it started from."
- Edge cases / failure handling: A dedicated `describe('operations refuse')` block enumerates each invalid combination (float source for `moveTab`, a docked pane for `unfloat`, a taken node id, mismatched insertPane records, a docked pane listed as floating in `restoreFocus`).
- Surprising: `expectRoundTrip` is used for the *plain* operations too, so a normal split is proved to be reversible by the same helper.

### packages/client/ui-dockkit/tests/components.client.spec.tsx
- Purpose: The kit's component-level spec, driven by props alone (no cordis, no slot registry).
- Key abstractions: `spyIntents()` (every intent as a spy), `layOut(panes, paneWidth)` (a fake `getBoundingClientRect` that lays the surface out), `twoPanes()`.
- Data flow: fires real pointer events and asserts *which settled intent fired*.
- Non-obvious design decisions: jsdom lays nothing out, so the specs hand the surface a layout: "panes of one width side by side, each 600px tall with a 36px strip and 100px chips." The "room reading must not flip with the hidden control's own footprint" case is annotated with the failure it prevents: "a reading that counted the control would fit again, show it, and re-render forever (React's update-depth limit, which crashed the surface)."
- Edge cases / failure handling: Covers the pointer cancel, a superseding press, unmounting mid-gesture, a foreign pointer id, a secondary press, a press under the drag threshold, an unmeasured split extent, and the "click on the divider reports nothing" case.
- Surprising: The suite binds the *real* stylesheet's `.menu` selector to the generated class at runtime (vitest stubs CSS modules) to assert that an empty menu really is `display: none` — a stylesheet behaviour tested through the DOM.

### packages/client/ui-dockkit/tests/constraints.client.spec.ts
- Purpose: Specs for the interaction limits.
- Key abstractions: a `grid(count)` helper that splits until the docked grid holds N panes.
- Data flow: pure functions only.
- Non-obvious design decisions: the "pins a share that drops under the minimum only after the first pin takes its 0.11 from everyone" case encodes the multi-pass algorithm's exact arithmetic.
- Edge cases / failure handling: floating panes are excluded from the count; an all-zero input is shared equally; ten panes never starve.
- Surprising: The cap is asserted as a literal (`expect(MAX_DOCK_PANES).toBe(4)`) so a change to the constant has to be deliberate.

### packages/client/ui-dockkit/tests/controller.client.spec.ts
- Purpose: Controller specs for the interaction vocabulary.
- Key abstractions: `expanded()` (a controller expanded once, with its first pane id).
- Data flow: calls the controller's methods and inspects `getSnapshot()` / `ops`.
- Non-obvious design decisions: "steps one compound command as one entry, however many operations it recorded" — a split plus its seeded tab is two operations but one undo step.
- Edge cases / failure handling: a redundant `setExpanded(true)` records nothing; a split at the cap returns false and records nothing; `placeTab` to the current slot returns false; a floating pane as a destination is refused.
- Surprising: The floating cascade is asserted by *position* ("the second panel's x is greater than the first's"), not by a magic number.

### packages/client/ui-dockkit/tests/fixtures.client.ts
- Purpose: Shared spec fixtures.
- Key abstractions: `seedTab`, `fileTab`, `seededController`, `seededState`, `TEST_LABELS`, `asPane`/`asSplit`/`asTab`.
- Data flow: imported by the other suites.
- Non-obvious design decisions: "The kit has no notion of a guide or a preview tab, so the suites supply their own content families — exactly as an embedder does." The `as*` helpers brand a literal a spec spells out.
- Edge cases / failure handling: `firstTab`/`childAt` throw rather than return undefined.
- Surprising: `TEST_LABELS` is a complete `DockLabels`, which doubles as a compile-time proof that the label contract is satisfiable.

### packages/client/ui-dockkit/tests/geometry.client.spec.ts
- Purpose: Drag-geometry specs.
- Key abstractions: a `measure(width, height, fixed)` helper producing a `PaneMeasure`.
- Data flow: pure functions.
- Non-obvious design decisions: The room-rule cases use exact pixel boundaries: "520px: halves of 258px inside the borders, against 104 + 100" fits; "208px: halves of 102px, short of 204" does not; "the boundary is inclusive: 2 * (204 + 2 borders) = 412".
- Edge cases / failure handling: A collapsed rectangle reads as all-centre; an empty strip places at index 0; a boundary with no pair leaves the fractions alone.
- Surprising: The spec asserts `SPLIT_MINIMUMS` as a literal object, so the stylesheet-derived constants cannot drift silently.

### packages/client/ui-dockkit/tests/measure.client.spec.ts
- Purpose: jsdom specs for the measurement side.
- Key abstractions: `lay(element, rect)` (a hand-built pane tree with fake rectangles).
- Data flow: builds `data-dockkit-pane` / `-strip` / `-strip-tabs` / `-strip-fill` elements and measures them.
- Non-obvious design decisions: The chip-minimum case toggles `boxSizing` between `content-box` and `border-box` on the same element to show the two footprint rules.
- Edge cases / failure handling: an unlaid pane reads as fitting; a divider without layout falls back to the stylesheet figure.
- Surprising: `sameFits` is spec'd separately — "a re-measure that changed nothing re-renders nothing" is a first-class behaviour, not an optimisation.

### packages/client/ui-dockkit/tests/planner.client.spec.ts
- Purpose: The two properties the intent layer must not lose in refactoring: **determinism** and **one undo behaviour**.
- Key abstractions: `frozen(state)` (a JSON snapshot to prove a planner left its input alone); `applyAll`; `driveByHand` vs `driveByController`.
- Data flow: runs the same script through the pure history functions and through the stateful controller and compares.
- Non-obvious design decisions: The spec says outright: "Nothing here may reach a clock or a random source." The cross-embedding comparison proves the two shapes cannot drift.
- Edge cases / failure handling: an intent that changes nothing plans `[]`; the pane budget refuses further plans; a floating pane refuses every plan.
- Surprising: `planPlaceTab`'s caret arithmetic is tested against a three-tab strip with the exact expected orders, because an off-by-one here is invisible in the UI.

### packages/client/ui-dockkit/tests/sequence.client.spec.ts
- Purpose: History specs.
- Key abstractions: a `fixture()` returning the initial state, the sequencer and the minter.
- Data flow: dispatches operations and inspects the cursor and the state.
- Non-obvious design decisions: "keeps the applied prefix replayable at any cursor" — `replay(initial, ops.slice(0, cursor))` must equal the current state at every cursor.
- Edge cases / failure handling: an invalid operation leaves the sequence untouched; a whole session can be undone back to the initial state.
- Surprising: The float-drag case shows one undo step restoring the rectangle, the z order **and** the focus — because the operation carried all three.

### packages/client/ui-dockkit/tests/tab-layout.client.spec.tsx
- Purpose: jsdom specs for the stable tab cells.
- Key abstractions: `mounted(controller, options)` with a `redraw` helper.
- Data flow: renders `TabLayout` over a controller's state.
- Non-obvious design decisions: The "transfers tab focus without overriding a new owner" case is parameterised over four focus outcomes (`new-control`, `origin-control`, `document`, `no-focus`) — the guard is "only take focus if nobody else deliberately took it".
- Edge cases / failure handling: unretained bodies are unmounted; an `active: false` frame marks its host `inert`; a selected tab that becomes floating in the same update must not need a docked strip.
- Surprising: The last case checks that a *superseding* gesture's `data-dockkit-pointer` marker survives an older follower's detach — a real bug class (the older abort handler deleting the newer marker).

### packages/client/ui-dockkit/tsconfig.json
- Purpose: Project references (util/brand, ui-primitives) over the client base config.
- Key abstractions: `rootDir: src`, `outDir: lib/types`.
- Data flow: the TypeScript build graph.
- Non-obvious design decisions: only two references — the kit's dependency surface is deliberately tiny.
- Edge cases / failure handling: n/a.
- Surprising: The kit depends on `dsh-brand` (for `Branded`) and `ui-primitives` (icons/tooltips) and nothing else.

### packages/client/ui-dockkit/tsdown.config.ts
- Purpose: The static-linked bundle preset.
- Key abstractions: `staticLinked(import.meta.dirname, ['lib/types/index.js'])`.
- Data flow: emits one browser ESM bundle at `lib/index.js` and ships the stylesheet under `lib/` at its `src`-relative path.
- Non-obvious design decisions: "every bare specifier stays an import, sourcemaps chain to the sources" and the Web shell bundles the artifact itself, "so vite stays the only owner of class hashing."
- Edge cases / failure handling: n/a.
- Surprising: `staticLinked` is a different preset from the `clientBundle` used by ui-commands/ui-layout — the dockkit must not be bundled into the shell, because a consumer de-duplicates injected sheets by file name.

### packages/client/ui-layout/locale/en.json
- Purpose: Package locale metadata only (title "ui-layout").
- Key abstractions: none.
- Data flow: package catalogue.
- Non-obvious design decisions: same as ui-commands — meta is not a parity-required pair.
- Edge cases / failure handling: n/a.
- Surprising: The runtime copy for the layout shortcut lives in `src/client/shortcut-locales.ts`, again a second mechanism.

### packages/client/ui-layout/locale/zh.json
- Purpose: Chinese package metadata (title "应用布局", one-line description naming the drag-to-resize capability).
- Key abstractions: none.
- Data flow: package catalogue.
- Non-obvious design decisions: The description names the user capability, not the component.
- Edge cases / failure handling: n/a.
- Surprising: Same split as the other two packages.

### packages/client/ui-layout/package.json
- Purpose: Manifest for `@deepseek-ai/dsh-client-ui-layout`.
- Key abstractions: "three-column AppFrame with drag handles, ctx.layout viewing-state service (navigation + panels)".
- Data flow: `dsh.client.inject` lists locale, ui-renderer, ui-session, ui-theme and shortcuts; `exports` splits node from `./client`.
- Non-obvious design decisions: `platform: "web"`.
- Edge cases / failure handling: n/a.
- Surprising: The package depends on `dsh-client-shortcuts` — the layout owns the Mod+B sidebar toggle as a *shortcut command*.

### packages/client/ui-layout/README.i18n.yaml
- Purpose: Per-heading EN/ZH hash record.
- Key abstractions: heading-path → hash.
- Data flow: the translation-pairing check.
- Non-obvious design decisions: same mechanism as the sibling packages.
- Edge cases / failure handling: n/a.
- Surprising: The `/deepseek-ai-dsh-client-ui-layout/table-of-contents` hash is identical to the ui-commands one — the ToC block is the same text in both packages.

### packages/client/ui-layout/README.md
- Purpose: Package reference for the shell layout.
- Key abstractions: the three-column `AppFrame`, `ctx.layout`, the theme presenter.
- Data flow: n/a (documentation).
- Non-obvious design decisions:
  - **The right column is a track, not a box**: the occupant draws its panel anchored to the frame's right edge at the resolved normal width, and the track only decides whether the centre makes room.
  - **The frame declares no darwin drag of its own** — every chrome row marks itself `data-window-drag` and ui-web base.css turns that mark into the one darwin drag rule, so "a row's blank runs drag while its controls stay clickable."
  - The frame publishes CSS variables as its contract: `--dsh-frame-leading-clearance`, `--dsh-frame-top-clearance`, `--dsh-frame-overlay-top`, `--dsh-frame-chrome-top`, `--dsh-windows-content-radius`, `--dsh-windows-sidebar-width`.
- Edge cases / failure handling: Declares the limits — panel geometry is transient (a reload restores the defaults), extremely narrow windows can still leave the centre under 400px, and there is no scroll anchoring during squeeze reflow.
- Surprising: "Desktop Mod+B toggles the left sidebar through the same layout action used by its controls. The shortcut command is unavailable behind modal dialogs and yields to terminal input."

### packages/client/ui-layout/README.zh.md
- Purpose: Chinese mirror of the layout README.
- Key abstractions: same sections (use-this-package, window-chrome seat, theme presentation, implementation internals).
- Data flow: n/a.
- Non-obvious design decisions: the Chinese version expands the window-chrome-seat section, naming `html[data-platform='darwin']` as desktop-preload-only.
- Edge cases / failure handling: n/a.
- Surprising: The "known limitations" bullets are translated almost verbatim, including the "no scroll anchoring during squeeze reflow" limit.

### packages/client/ui-layout/src/client/AppFrame.module.css
- Purpose: The frame's stylesheet.
- Key abstractions: `.frame`, `.sidebarCol`, `.centerCol`, `.rightbarCol`, `.bottomRow`, `.overlayLayer`, `.leadingSeat`, `.handle`.
- Data flow: class names consumed by `AppFrame.tsx`.
- Non-obvious design decisions:
  - **Only a discrete collapse/expand toggle eases the tracks** (`.frame[data-animating]`); steady-state viewport updates must land instantly, "an eased track chases the live window edge and the centre column visibly rubber-bands while the user resizes the window." Drags are transition-free (`[data-dragging]`).
  - **The right column never clips** (`overflow: visible`) — its occupant anchors a fixed-width panel to the column's right edge and lets the track decide whether the centre makes room.
  - **The overlay layer is click-through** (`pointer-events: none` on the layer, `auto` on entries) so an occupant never blocks the app underneath.
  - The clearance variables are declared on the *root* element (`html[data-platform='darwin']`) so portalled overlays inherit them.
  - macOS vibrancy: the frame is transparent, the centre paints its own opaque background, and `prefers-reduced-transparency` replaces the thin tint with a 90%-opaque fill.
- Edge cases / failure handling: `prefers-reduced-motion` disables both the track and handle transitions; native fullscreen drops `--dsh-frame-overlay-top` to 20px and `--dsh-frame-chrome-top` to 0.
- Surprising: The darwin closed sidebar has **no rail** — the centre reaches the window edge, "where a separator would draw a seam against nothing."

### packages/client/ui-layout/src/client/AppFrame.tsx
- Purpose: The three-column shell frame.
- Key abstractions: `AppFrameProps` (runtime + render-slots + store + locale shares); `DragHandle`; `MainPanel`; `RightbarColumn`; `CenterColumn`.
- Data flow: the frame measures its own box (not the window) with a rAF-throttled `ResizeObserver`, writes `setViewportWidth`, and solves the columns.
- Non-obvious design decisions:
  - **The rendered grid template delegates the squeeze to CSS** (line 234): "the centre declares its protected minimum and the right column bids up to the clamped preference, so a window resize lands in the same layout pass as the frame edge. The JS solve lags the viewport by a ResizeObserver + rAF frame; when it priced the squeeze itself, the centre column absorbed each width change whole and was corrected two frames later — visible jitter."
  - **The right column is a track, not a box** (line 46): "Zero-width unless the occupant asked for a track; the occupant's panel is positioned against the column's right edge, which never moves, so it can hang over the centre when there is no track."
  - **The drag base is frozen at drag start** — "grabbing a concession-clamped panel must not jump back to the stored preference" — and dx deltas do not compound.
  - **Easing is scoped to a discrete toggle**: `data-animating` goes up when the collapse state or the rightbar track flips and comes down at transition end (with a 600 ms timeout as the reduced-motion/covered-frame fallback). A toggle arriving *with* a viewport change is not eased, "that is the responsive auto-collapse firing mid window-resize, where easing would chase the live window edge."
  - **The shell.leading seat mounts only when the darwin collapse hides the column entirely**; the Windows zero-width collapse keeps its controls in the caption row instead.
- Edge cases / failure handling: `endDrag` runs on unmount, `pointercancel` and `lostpointercapture`; a second pointer is ignored (`capture.current?.id !== e.pointerId`); a secondary button never starts a drag.
- Surprising: The `MainPanel` subscribes to the main key through `usePanelInfo` *alone*, "without subscribing the column frame to each panel id."

### packages/client/ui-layout/src/client/columns.ts
- Purpose: The pure column solve.
- Key abstractions: `Columns`; `CENTER_MIN = 400`; `SIDEBAR_MIN/MAX/DEFAULT/COLLAPSED`; `SIDEBAR_AUTO_COLLAPSE = 1024`; `RIGHTBAR_MIN = 300`; `RIGHTBAR_MAX_RATIO = 0.7`; `RIGHTBAR_DEFAULT_RATIO = 0.45`.
- Data flow: `computeColumns(viewport, sidebar, rightbar, collapsedWidth)` feeds the grid template and the rightbar owner's reported width.
- Non-obvious design decisions: **The right column shrinks, then loses its track, before the center drops below its minimum** (lines 2–4). The sidebar never concedes here — AppFrame supplies its effective preference after responsive collapse.
- Edge cases / failure handling: the right panel is dropped entirely when `available < RIGHTBAR_MIN`; the centre may then fall to zero; the closed sidebar keeps a 56px rail by default (0 on macOS).
- Surprising: `clampWidth` rounds, so every stored width is an integer pixel.

### packages/client/ui-layout/src/client/DocumentTitle.tsx
- Purpose: The browser title projection.
- Key abstractions: `DocumentTitleProps`; the `usePanelInfo` + `useSessions` selector pair.
- Data flow: `document.title` is set from the selected session's title when the Conversation is the active main panel, otherwise the product title.
- Non-obvious design decisions: **The component does not subscribe the frame** — it subscribes to the panel key and the session list independently, so a panel change does not re-render the frame.
- Edge cases / failure handling: the session is found by `retainedBy.mainView > 0`; the title is restored to the product title on unmount.
- Surprising: When a global panel is active the session title is *not* shown, but the session's retention is untouched — "global panels keep the current Session intact."

### packages/client/ui-layout/src/client/index.ts
- Purpose: The browser plugin body.
- Key abstractions: the `SlotMap` declaration for the six frame child slots; the `OwnerShare` contracts `SidebarOwnerProps` and `RightbarOwnerProps`.
- Data flow: one `ctx.effect` creates the store, mounts `LayoutController`, registers AppFrame into `root` with the child-slot declarations, and registers the Mod+B shortcut; a second effect seats the `ThemePresenter`.
- Non-obvious design decisions:
  - **One store instance is shared three ways**: the service's actions, the root registration's store, and the `panelInfo` hook. `handle.create` is replaced by a function returning that single instance.
  - **`selectPanel` checks the live `main` registry** through a closure over `ctx.slots.entries('main')`, so a panel that unregistered itself is refused even though the store still remembers it.
  - **The shortcut's `resolve` returns `{ status: 'handled', run: … }`** so the command is unavailable behind modal dialogs and yields to terminal input by the shortcuts service's own policy.
  - `retainMainPanels` re-runs on every `main` slot change and resets the selection to null when the selected panel's registration disappears.
- Edge cases / failure handling: `provide()`'s disposer settles asynchronously, so teardown is "synchronous fire-and-forget" (`void disposeService()`); the effect's own disposer unwinds the shortcut, the controller, the panel subscription, the registration and the panelInfo hook.
- Surprising: The slot declarations carry long explanatory docstrings (the `sidebar` and `rightbar` entries explain in prose that registering replaces the column outright) — the slot map is the package's real API documentation.

### packages/client/ui-layout/src/client/service.ts
- Purpose: `LayoutController` — the `ctx.layout` face.
- Key abstractions: `MainPanelId` (branded); `PanelInfo`; `ILayout`; `PanelActions`.
- Data flow: the controller holds the store's bound actions plus a `hasMainPanel` predicate and the shared `panelInfo` observable.
- Non-obvious design decisions:
  - **`selectPanel` checks the live registry and throws** (line 73): "an absent key throws and leaves the current panel intact."
  - **`beginNavigation()` returns an abort signal** (line 81) that is aborted by the next navigation, by any valid panel selection (including a repeated one), or by disposal — "but it does not cancel the underlying Session creation"; consumers check the signal *before* committing navigation or moving drafts.
  - **A refused selection does not cancel a pending navigation** (the throw happens before `this.navigation.abort()`).
- Edge cases / failure handling: `dispose()` aborts the pending navigation; the controller is safe to dispose twice.
- Surprising: The navigation signal lives on the controller, not in the store — a UI-navigation concern kept out of the persisted layout state.

### packages/client/ui-layout/src/client/shortcut-locales.ts
- Purpose: The layout command labels.
- Key abstractions: `zh` (source of truth) and `en` typed as `Record<keyof typeof zh, string>`.
- Data flow: `ctx.locale.register('shortcuts.layout', { zh, en })`.
- Non-obvious design decisions: one key (`toggle`) — the layout owns exactly one command.
- Edge cases / failure handling: n/a.
- Surprising: The zh string "展开／收起左侧栏" uses a fullwidth slash to express "expand/collapse" as one label.

### packages/client/ui-layout/src/client/stores.ts
- Purpose: The root-owned frame measurement, panel preferences and presentation reports.
- Key abstractions: `LayoutState` = `{ panelInfo, layoutInfo }`; `LayoutInfo`; `LayoutActions`.
- Data flow: `defineStore` with `init` + `actions`; the plugin binds the instance to `ctx.layout`.
- Non-obvious design decisions:
  - **`panelInfo` and `layoutInfo` are separate objects** so selecting a panel preserves the layout object's identity and vice versa (the specs assert this with `toBe`).
  - **Responsive concessions never rewrite widths**; the right panel's expanded state belongs to its occupant and is only *reported* here.
  - **`rightbarInstant`** (line 128) is a transition marker: a fullscreen exit installs the destination geometry without a transition, and the marker is cleared by the next ordinary geometry action.
  - **`narrowExpanded` is an override, not a preference**: crossing 1024px in either direction drops it, and opening the right panel clears it — so re-widening restores the pre-squeeze layout.
  - The right panel's first-open width is 45% of the frame and is kept across resizes and close (`??=`), while the sidebar's preference *is* its width — so closing the sidebar forgets its drag width.
- Edge cases / failure handling: `retainMainPanels` resets the selection to null only when the selected panel disappears; an identical report returns the identical snapshot (`toBe`).
- Surprising: `setViewportWidth` ignores an unchanged width entirely, so it cannot reset the fullscreen-exit marker ("does not let an unchanged frame measurement reset the fullscreen-exit marker").

### packages/client/ui-layout/src/client/theme-presenter.ts
- Purpose: The global theme DOM applier.
- Key abstractions: `ThemePresenter`; the exported attribute/variable names (`DARK_ATTRIBUTE`, `THEME_SOURCE_ATTRIBUTE`, `CONTENT_FONT_SIZE_VARIABLE`).
- Data flow: `apply(snapshot)` writes to `document.documentElement`, `document.body` and one owned `<meta name="theme-color">`.
- Non-obvious design decisions:
  - **The presenter only ever retracts what it wrote itself** — it keeps an `appliedTokens` list (lines 85–86) and removes exactly those, so "foreign attributes, metadata, and inline styles survive."
  - **The rendered background is the single colour authority**: the theme-color meta is set from `getComputedStyle(body).backgroundColor` *after* the token writes, so the browser chrome matches what the user actually sees.
  - `colorScheme` is used, never the theme id — `system` is resolved upstream.
  - The font-family variables are removed (not set to empty) when the list returns to the built-in stack, so the stylesheet's fallback applies.
- Edge cases / failure handling: `dispose()` removes color-scheme, the theme-source attribute, the dark attribute, the font sizes, the font lists, every applied token and the metadata node.
- Surprising: The presenter is **pure DOM with no React path** — "initial state through the getter once, then event-driven only".

### packages/client/ui-layout/src/css-modules.d.ts
- Purpose: Ambient CSS-module declaration.
- Key abstractions: same two lines as the sibling packages.
- Data flow: type-only.
- Non-obvious design decisions: none beyond the permissive class map.
- Edge cases / failure handling: n/a.
- Surprising: Duplicated verbatim across the three packages.

### packages/client/ui-layout/src/index.ts
- Purpose: Host (node) half of the layout plugin.
- Key abstractions: `apply(): void {}`.
- Data flow: the loader sees the plugin; the browser half ships via `exports["./client"]`.
- Non-obvious design decisions: the same deliberate empty node half as ui-commands.
- Edge cases / failure handling: n/a.
- Surprising: A spec asserts calling it does not throw — "node apply is an intentional no-op (loader-managed lifecycle only)".

### packages/client/ui-layout/tests/app-frame.client.spec.tsx
- Purpose: Frame interactions with a real store and explicitly driven browser measurements.
- Key abstractions: `ResizeObserverStub`; a manual `requestAnimationFrame` queue with `flushFrames()`; `tracks(frame)` (a regex over the grid template); `pointer`/`drag` helpers.
- Data flow: mounts `AppFrame` with a fake slot renderer and drives pointer events.
- Non-obvious design decisions: **The grid template is asserted by regex**, because "jsdom does no layout, so specs read the specified tracks"; the helper also asserts that the centre's protected minimum accompanies an open right track.
- Edge cases / failure handling: Covers the width concessions (shrink to 300px, drop the track, then squeeze the centre), the narrow breakpoint, fullscreen track retention, the animating/instant markers, the drag freeze, uncaptured motion, secondary buttons, a second pointer, `pointercancel`/`lostpointercapture`, and the measurement lifecycle (coalescing, retaining the last positive measurement while hidden, and preventing late reports after unmount).
- Surprising: The "cancels a pending drag on fullscreen/close/unmount" case asserts that after the change the flushed frame produces **no** state change — the queued drag is dropped, not applied.

### packages/client/ui-layout/tests/apply.client.spec.ts
- Purpose: Plugin-level spec on a real cordis Context.
- Key abstractions: `bench()` mounting the real SlotRegistry, LocaleRuntime, ShortcutsService and ui-theme plugin; a root render host.
- Data flow: mounts the plugin, inspects the slot registry and `ctx.layout`, then disposes the fibre.
- Non-obvious design decisions: The spec asserts the *shared instance* property directly — `handle.create()` returns the same instance the service and the root registration use.
- Edge cases / failure handling: A panel that deregisters itself resets the selection and makes a later `selectPanel` throw; disposing the fibre aborts a pending navigation; teardown removes the service, the root registration and all six child declarations, while the built-in `root` declaration survives ("renderer-owned").
- Surprising: The theme-presenter case asserts that after disposal further theme changes **do not reach the document** — the listener is gone, not merely the writes.

### packages/client/ui-layout/tests/columns.client.spec.ts
- Purpose: Specs for the column solve.
- Key abstractions: a nine-case `it.each` table of frame/sidebar/right/centre outcomes.
- Data flow: pure functions.
- Non-obvious design decisions: "does not reduce the wide sidebar to keep a normal right panel open" is pinned explicitly; "leaves a closed right track closed when the frame widens" pins the no-auto-reopen rule.
- Edge cases / failure handling: the 20px frame solves to a zero centre; a 455px frame leaves the centre under 400px after the right panel closed.
- Surprising: `clampWidth` is asserted to round (250.4 → 250).

### packages/client/ui-layout/tests/document-title.client.spec.tsx
- Purpose: Specs for the title projection.
- Key abstractions: `titleSources()` building two snapshot stores and their bound selectors.
- Data flow: mutates the session store and the panel store, asserts `document.title`.
- Non-obvious design decisions: The global-panel case asserts the session's **retention is untouched** (`retainedBy.mainView` is still 1) while the title falls back to the product name — and that returning to the Conversation restores the *latest* session title.
- Edge cases / failure handling: a missing session row falls back to the product title; unmount restores it.
- Surprising: The test's fixture sets `displayTitle: 'Test'` and `title` separately — the projection reads `title`, not `displayTitle`.

### packages/client/ui-layout/tests/layout-store.client.spec.ts
- Purpose: Store specs.
- Key abstractions: `createLayoutStore().create()` → `{ store, actions }`.
- Data flow: drives the actions and asserts the snapshot.
- Non-obvious design decisions: **Identity is part of the contract**: `expect(store.getSnapshot().panelInfo).toBe(previous.panelInfo)` and `expect(store.getSnapshot().layoutInfo).not.toBe(previous.layoutInfo)` — the two halves change independently, and a repeated identical report returns the *identical* snapshot object.
- Edge cases / failure handling: "creates independent instances without browser persistence" spies on `Storage.prototype.setItem` and asserts it was never called — layout geometry is deliberately not persisted.
- Surprising: The `rightbarInstant` suite is a full state machine (close from fullscreen, restore from fullscreen, an ordinary close animating, and each of four actions clearing the marker).

### packages/client/ui-layout/tests/service.client.spec.ts
- Purpose: Controller specs.
- Key abstractions: `fakePanels()` — every action as a spy.
- Data flow: calls the controller and asserts the forwarded calls.
- Non-obvious design decisions: "rejects an absent main entry without changing selection or cancelling pending navigation" — the refusal happens *before* the abort, so a failed selection does not tear down an in-flight navigation.
- Edge cases / failure handling: abort-on-supersede is checked across `beginNavigation`, `selectPanel` (including a repeated selection) and `dispose`; `dispose()` is idempotent.
- Surprising: "keeps separately constructed controllers bound to their own instances" — two controllers never share state.

### packages/client/ui-layout/tests/theme-presenter.client.spec.ts
- Purpose: jsdom specs for the presenter.
- Key abstractions: a `snapshot()` builder that keeps `id` and `colorScheme` deliberately distinct ("the presenter must key off colorScheme, not the id").
- Data flow: applies snapshots and asserts the DOM.
- Non-obvious design decisions: The stylesheet stub sets the body background per scheme so the theme-color meta can be asserted against a real computed style.
- Edge cases / failure handling: switching themes **replaces** the token set rather than merging it; the meta node is reused (one node, updated content); a font list that returns to the built-in stack removes the variable; `dispose` spares a foreign `--foreign` inline style.
- Surprising: The "system" preference publishes `system` while a fixed preference publishes its resolved scheme — two different values for the same attribute.

### packages/client/ui-layout/tsconfig.json
- Purpose: Project references over the client base config.
- Key abstractions: ten references (brand, cordis, locale, ui-slots, ui-theme, ui-primitives, store, ui-renderer, ui-session, shortcuts).
- Data flow: the TypeScript build graph.
- Non-obvious design decisions: `outDir: lib/types`.
- Edge cases / failure handling: n/a.
- Surprising: The reference list names `ui-theme` — the layout *consumes* the theme snapshots but does not own them.

### packages/client/ui-layout/tsdown.config.ts
- Purpose: Bundle config.
- Key abstractions: `clientBundle(import.meta.dirname, ['lib/types/index.js'])`.
- Data flow: tsdown emits `lib/index.js` + `lib/client.js` + types.
- Non-obvious design decisions: same helper as ui-commands; unlike the dockkit, this package is bundled into the shell.
- Edge cases / failure handling: n/a.
- Surprising: three lines; the whole build convention is centralised.

## Ideas worth stealing

- **A late async settlement is revoked by binding identity, not by a flag** — `packages/client/ui-commands/src/client/popup.ts:294` — the controller swaps its `binding` object on dismiss/reopen/dispose, and every late write checks `this.binding !== binding` and returns. A settling `onSelect` that lands after a dismissal writes nothing, consumes nothing and focuses nothing (`:300`). *Why it transfers*: August's UI fires async results all the time (a permission prompt, a model switch, a plan-mode confirmation). The generalisable rule is "the settlement carries the identity of the thing it was opened for; if that identity is no longer current, the settlement has no rights." Cheaper and safer than a boolean `cancelled` flag, because it cannot be forgotten.

- **Admission and outcome are different channels** — `packages/client/ui-commands/src/client/service.ts:409` — "An unmatched line reports an error outcome (the composer's immediate admission feedback); an admitted command reports plain success regardless of its handler outcome, because the host executor durably logged the lifecycle and the outcome renders as a persistent flow node — the composer never echoes it." *Why it transfers*: August's harness has exactly this split — a tool call can be *admitted* (it reached the executor) and still *fail* (the handler threw). If the submit path returned the handler's failure text, the composer would echo an outcome that the durable event log is already rendering, and the user would see it twice. The admission channel should be an immediate, short-lived "did it get in?" signal; the outcome channel is the durable event.

- **Refuse loudly at the door, preserve the user's work** — `packages/client/ui-commands/src/client/service.ts:332` — a submission carrying attachments proceeds only if the command declares `input.attachments`; every other route throws the localized refusal so the machine surfaces *one* notice and "the draft and attachments stay in place; nothing executes and nothing is dropped." *Why it transfers*: August's harness has several places where a route could silently drop the user's payload (an image on a text-only command, a file on a tool that cannot read it). The rule is: refuse at the boundary with a specific, localized reason, and never destroy the draft as a side effect of the refusal.

- **An epoch guard on a per-session cache** — `packages/client/ui-commands/src/client/directory.ts:109` — `const epoch = ++entry.epoch`; only the pull whose epoch is still current may publish its outcome. A superseded pull's success cannot overwrite a newer snapshot, and its failure cannot demote a newer success. *Why it transfers*: August has per-session caches too (model catalog, agent roster, permission presets). Without the guard, two in-flight refreshes for the same session can land out of order and the cache can end up holding the *older* catalog — or be marked failed by a stale rejection. The guard is three lines and the spec covers both directions.

- **A planner that returns nothing means nothing happened** — `packages/client/ui-dockkit/src/engine/planner.ts:13` — "A planner returning no operations means the intent changes nothing; the caller records nothing and notifies nobody." The planner is a pure function from state to operations; the controller is a thin "plan → record → notify" wrapper (`:115` in `controller.ts`). *Why it transfers*: August's turn loop has the same shape available — a pure "what would this intent do" function that returns an empty plan, with the recorder and the notifier downstream. It gives August a testable "no-op intent" concept, and it means a planner can be exercised with no DOM, no clock and no random source (which the planner spec asserts explicitly).

- **Capture the inverse at execution time, because the pre-state is gone by undo time** — `packages/client/ui-dockkit/src/engine/operations.ts:3` — `applyOp(state, op)` returns the next state *and* the operations that undo it; the inverses are prepended in reverse order when they are collected (`packages/client/ui-dockkit/src/engine/sequence.ts:105`). *Why it transfers*: any August feature that needs undo/redo (a plan-mode edit, a subagent re-launch, a tool-argument correction) should capture the inverse when the operation runs, not reconstruct it later by diffing. The dockkit's `insertPane`/`insertTab`/`restoreFocus` operations exist *only* to express inverses exactly — a good precedent for adding inverse-only operation kinds.

- **Collapse a run of focus-only history entries into one undo step** — `packages/client/ui-dockkit/src/engine/sequence.ts:126` — `stepBack` walks back over a consecutive run of entries whose operations are all focus-only, so the user undoes "I looked at three tabs" as one step, not three. *Why it transfers*: August's transcript has the same noise — a run of focus/selection/scroll events between two substantive steps. If August ever offers an undo or a "step back" affordance over agent activity, focus-only entries must coalesce or the undo is useless.

- **A measurement that would flip with the UI's own visibility must exclude that visibility's footprint** — `packages/client/ui-dockkit/src/engine/geometry.ts:79` — the room rule reads the strip's fixed part; when the embedder hides a blocked split control, that control's own footprint is left out, because "a reading that counted it would flip with the control's visibility and re-render forever". The regression is recorded in the spec: `packages/client/ui-dockkit/tests/components.client.spec.tsx:427` — "re-render forever (React's update-depth limit, which crashed the surface)". *Why it transfers*: this is a general August bug class — any guard that measures the UI it is about to change creates a feedback loop. The fix is a design rule: *the measurement must not depend on the thing it decides.*

- **The right column is a track, not a box** — `packages/client/ui-layout/src/client/AppFrame.tsx:46` — "Zero-width unless the occupant asked for a track; the occupant's panel is positioned against the column's right edge, which never moves, so it can hang over the centre when there is no track." *Why it transfers*: August's UI will have a side panel (a task inspector, a diff view, a subagent trace). If the frame owns the panel's box, every overlay mode needs a second layout path. Making the *track* the negotiable thing and the *edge* the anchor lets one layout serve both "docked" and "floating" without a second code path.

- **Let CSS solve the squeeze; JS only makes discrete decisions** — `packages/client/ui-layout/src/client/AppFrame.tsx:234` — "The rendered template lets the grid solve the squeeze natively: the centre declares its protected minimum and the right column bids up to the clamped preference… The JS solve lags the viewport by a ResizeObserver + rAF frame; when it priced the squeeze itself, the centre column absorbed each width change whole and was corrected two frames later — visible jitter." *Why it transfers*: any responsive August UI that computes a layout in JS and then writes the result will visibly lag the window edge. Declaring the *constraint* (a minimum, a maximum, a ratio) in the template and letting the engine resolve it removes a whole class of jitter.

- **A presenter that retracts only what it wrote** — `packages/client/ui-layout/src/client/theme-presenter.ts:85` — the presenter keeps the list of token names it applied and removes exactly those on dispose, so "foreign attributes, metadata, and inline styles survive". *Why it transfers*: August writes global CSS variables (theme tokens, font sizes) and clears them on teardown or on theme change. A blanket "remove all inline styles" wipes whatever another component wrote; a retraction set does not.

- **A picker opens with the highlight on the value in use, not the top row** — `packages/client/ui-commands/src/client/popup.ts:127` — `currentIndex` parks the highlight on the option marked `active`; the contract file states the reason: "so an accept gesture made without looking confirms the value in use." *Why it transfers*: August has model pickers, mode pickers and permission pickers. Opening a picker on the current value means the cheapest gesture (Enter) is the safe one; opening on the top row means the cheapest gesture is the *dangerous* one.

- **Search filters locally; the provider is never re-queried per keystroke** — `packages/client/ui-commands/src/client/popup.ts:211` — options are loaded once per open and the search text filters them in the view; the spec asserts `options` was called exactly once. *Why it transfers*: a picker over a large catalogue (models, agents, skills) should fetch once and filter locally. It removes a round trip per keystroke and makes the picker feel instant; the cost is that the option set must be loaded up front, which the caller's `options()` contract makes explicit.

- **Focus lands on click, not on press** — `packages/client/ui-dockkit/src/components/TabPanel.tsx:279` — "a state change between `pointerdown` and the first `pointermove` rebuilds the pressed subtree, and Chromium cancels the pointer when the pressed element is replaced — which would abandon every drag." *Why it transfers*: any August UI that both drags something and reacts to a press must not mutate the pressed subtree during the gesture. It is the difference between a drag that works and a drag that silently dies.

- **A menu that would hold no item never paints** — `packages/client/ui-dockkit/src/components/TabMenu.tsx:99` and `packages/client/ui-dockkit/src/components/dockkit.module.css:557` — the component returns null when there is no close item and no extras, and the stylesheet hides a menu with no `role=menuitem*` descendant (the kit *probes* for that role to decide the menu is empty). *Why it transfers*: an August context menu that opens and shows nothing is a dead control; the contract "an item must carry `role=menuitem`, because the kit probes for that role to dismiss a menu that would paint empty" makes the emptiness rule enforceable rather than advisory.

- **One stylesheet per package, because consumers de-duplicate injected sheets by file name** — `packages/client/ui-dockkit/src/components/dockkit.module.css:1` — "a consumer de-duplicates injected stylesheets by `<pluginId>/<basename>`, so a second sheet whose file name matches one in the embedding package would be dropped silently. Keeping a single `dockkit.module.css` makes that collision impossible." *Why it transfers*: if August ships CSS modules to the browser, a name collision is a *silent* style loss. One sheet per package removes the class of bug by construction.

- **An identity, not a name, selects a first-party face** — `packages/client/ui-commands/src/client/resolution.ts:23` — `builtinCommandName` matches on `descriptor.definitionId`, not on the command's name, so a same-name override keeps its own copy and gets no first-party alias; and `resolveCommand` (`:50`) resolves a bilingual alias by definitionId, "so an alias never selects an unrelated scoped override". *Why it transfers*: August's agent/tool registry will have scoped overrides of built-in tools. Selecting a built-in's *special behaviour* (the goal command, the plan command, the compact command) by name is a privilege-escalation shape: any package registering `plan` would inherit the first-party semantics. Selecting by a stable definition identity closes it.

- **The claim keeps the typed spelling; the submission sends the canonical name** — `packages/client/ui-commands/src/client/service.ts:395` — the `CommandClaim` carries the token the user sees (`/计划 `) while `submit` sends the catalog name (`/plan ship it`). *Why it transfers*: August's slash/command surface (and any localized UI) needs exactly this split, and the alternative — rewriting the user's typed text — breaks their expectation of what they typed.

- **A superseded navigation is aborted, but the underlying work is not cancelled** — `packages/client/ui-layout/src/client/service.ts:81` — `beginNavigation()` returns an `AbortSignal` that the next navigation, any valid panel selection, or disposal aborts; the docstring is explicit that this does **not** cancel the underlying Session creation, and consumers check the signal *before* committing UI state. *Why it transfers*: August's UI starts asynchronous navigation (open a session, switch a panel, spawn a subagent). A per-navigation abort signal lets the UI drop a stale result without tearing down work that is still wanted — and the check belongs *before* the commit, not after.

- **An edit that changes nothing must not be recorded** — `packages/client/ui-dockkit/src/components/DockSurface.tsx:272` — `if (sameSizes(sizes, drag.sizes)) return`: "A release that left the fractions where they were — a click on the divider, a drag returned to its start, or one pushed further into the clamp — is not a resize and reports nothing." *Why it transfers*: August's activity log / transcript should record *changes*, not gestures. A user who clicks a divider or a button that does nothing should not produce an entry, or the history becomes noise. The comparison is a tolerance-based equality (`SIZE_TOLERANCE = 1e-9`), which is what makes it cheap and exact.

- **A re-measure that changed nothing re-renders nothing** — `packages/client/ui-dockkit/src/components/measure.ts:122` — `sameFits` compares two measurement maps so an unchanged reading returns the *same* state object. *Why it transfers*: any measurement-driven guard (a "does the pane fit" check, a "is the panel too narrow" check) should return the previous value when nothing changed, so React (or August's own diffing) can skip the update. This is the same principle as the previous idea, applied to measurements instead of intents.

- **A gesture is one intent, and the preview is local** — `packages/client/ui-dockkit/src/components/DockSurface.tsx:218` — the drag previews in local component state while the gesture's own facts stay in its closure; on release "the net result leaves through one `DockIntents` call — a strip release reports the caret slot as drawn, the dragged chip counted, and `planPlaceTab` turns that into the reorder or the move." *Why it transfers*: August's agent loop records *tool calls*, not token deltas. The same discipline — preview locally, commit one net intent at the end — is what keeps a long drag from producing hundreds of history entries.

- **Only the owning pointer counts, and capture is hardening, not the mechanism** — `packages/client/ui-dockkit/src/components/pointer.ts:5` and `:47` — the window listeners carry the gesture whether or not capture succeeded, and every listener filters on `event.pointerId === pointerId`. *Why it transfers*: a second finger or a trackpad palm must not end a drag; and the gesture must survive an environment without pointer capture (jsdom, some embedded webviews).

- **A nested control stops its own press** — `packages/client/ui-dockkit/src/components/TabPanel.tsx:325` — `onPointerDown={event => event.stopPropagation()}` on the chip's close button: "otherwise the press starts a drag, captures the pointer, and the nested control's click never lands." *Why it transfers*: August's chat UI will have buttons inside draggable rows (a copy button on a message, a retry button on a tool card). Without this, those buttons are dead.

## Files skipped (with reasons)

None. Every one of the 92 files in the shard was opened and read. The two largest files were read end-to-end rather than sampled:

- `packages/client/ui-dockkit/tests/components.client.spec.tsx` (81,773 bytes, 1,633 lines) — read in three passes covering all 1,633 lines.
- `packages/client/ui-dockkit/src/components/dockkit.module.css` (23,906 bytes, 838 lines) — read in two passes covering all 838 lines.
- `packages/client/ui-commands/tests/service.client.spec.ts` (59,066 bytes, 1,201 lines) — read in three passes covering all 1,201 lines.
- `packages/client/ui-layout/tests/app-frame.client.spec.tsx` (30,564 bytes, 681 lines) — read in two passes covering all 681 lines.

Two files are long *single lines* rather than long documents: `packages/client/ui-dockkit/src/components/TabPanel.tsx:39` (a 2,000+ character SVG path constant for the panel frame glyph) and `packages/client/ui-dockkit/README.md:75` (a 2,034-character bullet). Both were read in full via a read-only shell read of the specific line; the SVG constant is decorative path data and the README bullet is prose that repeats the mechanism documented in `geometry.ts`.

## Uncertainties

- **The clone was read but not executed.** Nothing in the shard was run, installed or built; every claim here comes from reading source, comments, tests and READMEs. Where a test asserts a behaviour I did not re-run, I have reported the test's claim as the test's claim.

- **Line 39 of `packages/client/ui-dockkit/src/components/TabPanel.tsx` was truncated by the reader at 2,000 characters.** The visible portion is an SVG path (`PANEL_FRAME`, an even-odd ring of two rounded rectangles). I read the remainder via a line read; it is path data for the same glyph. I did not verify the path renders correctly — that is a rendering question outside a static read.

- **`packages/client/ui-dockkit/README.md:75` was truncated at 2,000 characters** by the reader; I read the remainder (the final sentence about a user-narrowed pane keeping its size) via a line read. The rest of the README was read in full.

- **The three Chinese READMEs are mirrors of their English counterparts.** I read all of them in full. I did not verify the *translation quality* or that the bilingual-pairing hashes currently match — that is the job of `pnpm run verify-translation-pairing`, which I did not run.

- **What "rankByName" actually does is out of this shard.** `packages/client/ui-commands/src/client/service.ts:26` imports it from `@deepseek-ai/dsh-client-ui-primitives` and the README describes it as "prefixes first, then alignment score, then original row order", but the implementation lives in another package. I report the described behaviour, not a verified one.

- **How the host `command.execute` RPC behaves is out of this shard.** `packages/client/ui-commands/src/client/service.ts:423` calls `ctx.remote.commands.execute(sessionId, line, attachments)`; the host-side handler, the command registry, and the `CommandDescriptor`/`CommandResult` types live in `packages/interaction/commands` and `packages/core/session`, which this shard does not contain. I read the *client* contract (`definitionId`, `input.hint`, `input.attachments`, `result.kind`) and the client's handling of it.

- **Whether the `conversation.input.overlay` slot's owner contract is honoured elsewhere is out of this shard.** `packages/client/ui-commands/src/client/index.ts:64` registers into it; the slot registry and the composer that hosts it live in `ui-conversation` / `ui-renderer`.

- **Lens coverage.** This shard contains **no** agent-loop, reasoning-stream, prompt-construction, cache-prefix, context-compaction, model-adaptation, memory/learning or subagent code. The only model-facing statements are the three READMEs' "Model Experience: None / KV Cache effect: None" sections and the note in `packages/client/ui-commands/README.md:86` that a command handler flipping plan mode changes what the *owning* host package contributes to the next system prompt (a prefix invalidation owned elsewhere). If the lead needs those lenses, they are in other shards.

- **No evals or benchmarks are in this shard.** The 22 test files are unit/integration specs (vitest), not behavioural evals of a model. I found no `benchmarks/` or `evals/` path among the 92 rows.
