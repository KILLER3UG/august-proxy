# deepseek-harness / dsh-experimental-inspect#3

## Shard shape

This shard is the whole `packages/experimental/` group as it stands: three sibling packages, 240 files. `session-inspector` is a **client plugin** (66 files) that mounts a "Session Log" sidebar tab and renders the live Session event log and the Chat node/group structure as two virtualized tables with a crosshair element-picker that reaches into the main Chat's DOM. `webworker-runtime` (155 files) is the **browser host**: it runs the whole harness Cordis tree inside one dedicated Web Worker — an in-memory VFS, a CommonJS module loader over that VFS, an acorn transform that lowers ESM to CommonJS and routes every `await` through an async-context protocol, a `node:*` compatibility layer, a shell implemented as JavaScript, and a postMessage tunnel that speaks plain HTTP to the page. `webworker-packer` (19 files) is the **build-time half** of the runtime: it turns a profile's bundle roster into a gzip'd ustar image, prunes it by a reachability sweep, splits lazily-loaded page chunks into their own content-addressed archives, and prepares current-generation Session successors for the preview fixture. The three fit together as `packer → image → runtime`, and the packer and the runtime share one contract file (`image-layout.ts`) and one transform, so a change on either side is caught by the other's manifest gate. Almost none of this touches a model request: the READMEs of all three packages say "Model Experience: None" and "KV Cache effect: None". The value to August is in the *mechanisms* — especially the module lowering, the async-context protocol, the reachability sweep, the lazy-archive VFS, and the session-inspector's two table projections.

## Per-file notes

### packages/experimental/session-inspector/README.md
- Purpose: The package reference for the Session Inspector plugin.
- Key abstractions: Two presentations ("Raw Log" and "Chat Group") over one table, one object-tree detail panel, one crosshair picker.
- Data flow: Session event source → `SessionLogModel` rows; Conversation snapshot → `ChatNodeModel` rows; either table row → raw record → JSON or object tree.
- Non-obvious design decisions: The plugin "requires no debugging argument, accepts no configuration, and changes no Session data" (README.md:27) — it is purely a reader, which is why it can be mounted in a shipped profile without a trust decision.
- Edge cases / failure handling: "Projection controls — Session Log does not display projection control-stream updates"; "Live suggestions — refreshing type candidates resets keyboard selection, even for an unchanged candidate list" (README.md:91,94).
- Surprising: The README documents the *absence* of a feature as a limitation ("Chat DOM dependency … Approximation cannot recover an unrendered message's exact location", README.md:95) — a deliberate contract with the DOM rather than a gap.

### packages/experimental/session-inspector/README.zh.md
- Chinese translation of README.md; same 105 lines, same section anchors, same "Model Experience: none" statement.

### packages/experimental/session-inspector/README.i18n.yaml
- Per-heading bilingual pairing hashes for README.md, with the `pnpm run verify-translation-pairing --write` command that re-records them.

### packages/experimental/session-inspector/package.json
- Plugin manifest: `dsh.client.inject` names the five client packages it needs (locale, ui-conversation, ui-sidebar-right, ui-session, ui-renderer); exports `./client` and `./src/*` so the Developer Tools bundle can mount it from source.

### packages/experimental/session-inspector/locale/en.json
- Marketplace metadata: English title ("Session Log") and description for the sidebar page.

### packages/experimental/session-inspector/locale/zh.json
- The same marketplace metadata in Chinese.

### packages/experimental/session-inspector/src/index.ts
- Inert Host discovery entry: `export function apply(): void {}` — inspection belongs to the Client, so the Host half does nothing.

### packages/experimental/session-inspector/src/client/index.ts
- Browser plugin entry: `inject = ['slots','locale','sessions','uiSession','uiConversation','sidebarRightTabs']`; `apply` registers the locale dictionaries and then the tab.

### packages/experimental/session-inspector/src/client/locales.ts
- `NS = 'session-inspector'`; the zh dictionary is the source of truth for the key set (`SessionInspectorKey = keyof typeof zh`) and the en dictionary is typed as `Record<SessionInspectorKey, string>`, so a missing English string is a type error.

### packages/experimental/session-inspector/src/client/views/index.ts
- Registers the `session-inspector-log` sidebar tab and builds the per-session source bundle. The bundle is cached in a `WeakMap<SessionBinding, SessionInspectorInjected>` so switching sessions does not rebuild the models, and the picker is owned by a single `activePicker` variable so "Each plugin instance permits one active picker" (README.md:53).

### packages/experimental/session-inspector/src/client/views/View.tsx
- The combined panel. `mode` is local state (`'session-log' | 'chat-node'`), and only the selected table subscribes — the source README states "only the selected table subscribes" (README.md:69). Changing presentation resets the picker, the picked row and the filter, and the `<InspectorTable key={mode}>` remount guarantees no stale state crosses presentations.

### packages/experimental/session-inspector/src/client/views/InspectorTable.tsx
- Purpose: The virtualized table shared by both presentations.
- Key abstractions: `InspectorTableLayout` (geometry), `InspectorTableHierarchy` (folding + sticky ancestors), `InspectorTypeFilter` (filtering), `InspectorRecordSource` (per-row value), TanStack Virtualizer.
- Data flow: `allRows` (structure) → filter → hierarchy (folding) → layout (geometry) → virtualizer range extraction → `DataRow` per item → `useRecord(key)` for the row's own value.
- Non-obvious design decisions: The range extractor renders the *anchored* viewport before the layout effect moves the scrollport (InspectorTable.tsx:233), so a manual fold does not flash the wrong rows. `arrivals` records a per-key arrival timestamp and a row is "added" for 700 ms (InspectorTable.tsx:213,318) — that is how the "new row" highlight is decided without a separate event.
- Edge cases / failure handling: `revealRow` clears the filter when the target is excluded by it (InspectorTable.tsx:160-161); a selected record that disappears renders `table.removed` instead of failing; `loadOlder` failures surface as an alert and are retryable.
- Surprising: The flash animation reads its colour from `--dsw-specific-bubble-highlight` via `getComputedStyle` and is cancelled on unmount (InspectorTable.tsx:80-81) — the highlight is a *theme* value, not a hardcoded one.

### packages/experimental/session-inspector/src/client/views/InspectorDetails.tsx
- Resizable raw-data panel. The drag lives in a `DetailDrag` ref keyed by `pointerId`, so a competing pointer is ignored (InspectorDetails.tsx:36); the height is `flexBasis` in percent clamped to 15–80, and the separator is a `role="separator"` with `aria-valuenow`, ArrowUp/Down and Home/End keys.

### packages/experimental/session-inspector/src/client/views/InspectorObjectTree.tsx
- The lazy runtime-object tree. `ObjectBranch` decides, per value, whether it is a reference (a link), a cycle (`ancestors.get(value)` prints the ancestor path), an accessor (labelled, never called), an absent sparse slot, or an expandable collection. Enumeration is paged at 50 entries (`PAGE_SIZE`), and `useMemo` keys the entry list on `revision` — the Conversation publication — so a pure UI re-render does not re-enumerate a Map (the test asserts 51 visits stay 51 across 20 re-renders).

### packages/experimental/session-inspector/src/client/views/TypeFilter.tsx
- The portalled filter editor. Suggestions are asynchronous, so the result is keyed by the draft it was computed for (`const current = result?.query === draft ? result : undefined`, TypeFilter.tsx:65) and the effect sets `current = false` on cleanup so a late response cannot replace a newer one (TypeFilter.tsx:53-64). Enter is ignored while an IME composition is active (`event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229`, TypeFilter.tsx:99) — a real Safari bug class.

### packages/experimental/session-inspector/src/client/views/table-model.ts
- `InspectorRow` (key, parent, depth, disclosure), `InspectorDisclosure` (a user choice *valid only for the lifecycle state in which it was made*), `InspectorTableHierarchy` (depth-first rows with folded descendants omitted, plus `stickyIndexes`), and `InspectorRecordSource` (projects a keyed source into an `InspectorRecord` and re-projects only when the input changed).

### packages/experimental/session-inspector/src/client/views/table-layout.ts
- The geometry. `preservedCollapse` is true when the hierarchy shrank *and* a block moved from `open` to `closed` (table-layout.ts:53-55) — an automatic block closure, not a user fold. `bottomPadding` reserves the blank space *after all data rows* so the visible anchor does not jump; `anchorOffset` re-anchors a surviving row or, failing that, the nearest surviving ancestor header (table-layout.ts:94-109).

### packages/experimental/session-inspector/src/client/views/type-filter.ts
- `InspectorTypeFilter`: case-insensitive containment, `*delta*` == `delta`. `apply` keeps matching rows *and their ancestors*, and re-opens an ancestor that became a branch of a match (type-filter.ts:56-64) so a matching descendant of a closed block is reachable. `suggest` is async but does no work before the first `await` (type-filter.ts:73-75), so the caller can drop a stale answer.

### packages/experimental/session-inspector/src/client/views/objects.ts
- The type contracts: `InspectorChatTarget` (the coordinates — anchorSeq, callId, rootCallId, nodeKey, nodeKind, groupKey, groupPart, turn, step), `InspectorObjectReference` (a named object with a *live* `read()`), and `InspectorObjects` (the lookup face with an `updates` snapshot that invalidates cached fields).

### packages/experimental/session-inspector/src/client/views/object-value.ts
- Shallow runtime-object inspection. `field()` reads the property *descriptor* and never the value when the descriptor is an accessor, so a getter is labelled `[Getter / Setter, not evaluated]` rather than called (object-value.ts:29-33). A typed array's length comes from the *intrinsic* getter, not an own one, so a shadowing getter cannot lie (object-value.ts:19-27). `entries()` yields only the disclosed index prefix and puts non-index/symbol fields behind a synthetic "Other properties" disclosure.

### packages/experimental/session-inspector/src/client/views/raw-json.ts
- `inspectorJson`: a `JSON.stringify` replacer that tracks the ancestor chain and emits `[Circular]` only for *ancestors*, so a shared value is expanded in each branch (raw-json.ts:26-29). Maps and Sets are converted to containers and cached per instance; bigint becomes `"123n"`; a throwing `toJSON` is contained into `{ failed: true }` rather than retiring the view.

### packages/experimental/session-inspector/src/client/views/format.ts
- The horizontal preview. A per-type field table (`tool-call-delta → ['argumentsDelta']`, `reasoning-delta → ['text']`) decides what a delta shows, and the generic path drops `type`, `seq`, `sequence` and top-level `time`. A single remaining field prints its *value* alone, not `field: value` (format.ts:21).

### packages/experimental/session-inspector/src/client/views/chat-node/model.ts
- Purpose: The Chat-structure table model.
- Key abstractions: `ChatNodeModel` (rows), `InspectorRecordSource` per row, `ChatObjectIndex` (references).
- Data flow: Conversation snapshot → grouped entries → group rows + member rows; nodes that are materialized but *not listed* in any group are inserted at their event anchor rather than appended (chat-node/model.ts:159-195).
- Non-obvious design decisions: "the Inspector does not invent group membership" (README.md:35) — an unlisted node is a root row, placed between existing roots by `anchorSeq` (chat-node/model.ts:160-171), and nodes with equal anchors sort by key for determinism. The `refresh()` fast path compares the node store identity, the order array, the grouped view *and* every key+anchor, so a content change does not rebuild the table (chat-node/model.ts:106-119).
- Edge cases / failure handling: Group membership changes are coalesced through a `queueMicrotask` so a burst of group publications produces one rebuild; when the last subscriber leaves, group subscriptions and queued updates are dropped.
- Surprising: `model.row(key)` returns `undefined` for a row that is not loaded rather than an empty source, so a stale reference cannot be read.

### packages/experimental/session-inspector/src/client/views/chat-node/objects.ts
- `ChatObjectIndex` indexes Node, Group, Turn/Step location and Data identities in `WeakMap`s, refreshed once per publication (the `indexed` WeakSet guards re-walking the same node array). Each reference carries a `read()` closure that resolves the *current* value, so a replaced publication does not retain the old snapshot (chat-node/objects.ts:37-45).

### packages/experimental/session-inspector/src/client/views/chat-node/dom.ts
- The DOM surface. `mainChatRoot()` selects `[data-slot="main.conversation"] [data-slot="conversation.view"] [data-chat-flow]` and rejects anything inside the right sidebar or a nested Conversation view (dom.ts:23-26). `findChatTargets` builds one index of every `data-chat-call-id` / `-node-key` / `-group-key` / `-turn` element in a *single* DOM scan and then answers from it (dom.ts:45-87) — the test asserts exactly one `querySelectorAll` call.

### packages/experimental/session-inspector/src/client/views/chat-node/reveal.ts
- Purpose: Reveal a target in the main Chat without touching Chat content.
- Key abstractions: `InspectorChatRevealer`, `visibleChatRect`, `findChatTargets`.
- Data flow: target → candidate elements → `beforematch` on hidden ancestors → `scrollIntoView` → body-level overlay flash.
- Non-obvious design decisions: The highlight is a *body-level* element positioned over the target, never an element added to the Chat (README.md:47) — Chat's own layout is untouched. Unfolding uses the existing `beforematch` event, and the ancestors are revealed innermost-last so the fold opens in order (reveal.ts:43-49).
- Edge cases / failure handling: If no candidate has a rendered box, the *visible Chat column* is highlighted instead (reveal.ts:63). Smooth scrolling waits for every moving ancestor to settle, with a 150 ms quiet fallback for browsers without `scrollend` (reveal.ts:119-137); any wheel/touch/key interrupts and cancels the pending scroll, restoring the previous offsets (reveal.ts:138-146). Under `prefers-reduced-motion` it scrolls instantly and does not flash.
- Surprising: A replaced animation cannot remove the new highlight: `animation.onfinish` checks `this.animation === animation` before disposing (reveal.ts:175).

### packages/experimental/session-inspector/src/client/views/chat-node/reveal-target.ts
- `resolveChatRevealTargets` turns a target into an *ordered* candidate list: the primary (tool identity → exact anchor → node kind → nearest) followed by every visible node ranked by (same step, same turn, session) and then by `|anchorSeq − referenceSeq|` (reveal-target.ts:74-89). Deduplication is by a canonical JSON key, so property insertion order cannot create a duplicate (reveal-target.ts:41-46).

### packages/experimental/session-inspector/src/client/views/chat-node/picker.ts
- The crosshair picker. A transparent mask is placed over the Chat; hit-testing uses `document.elementsFromPoint()` and *skips the mask and the preview overlay* to find what is underneath (picker.ts:112-114). The mask swallows every pointer event so the underlying Chat control never activates. A MutationObserver on the owner and the Chat root cancels the gesture when either is hidden or restyled, and `ResizeObserver` keeps the mask aligned.

### packages/experimental/session-inspector/src/client/views/chat-node/pick-match.ts
- The matching rules, kept in one replaceable file. `matchChatElement` never compares rendered text ("Text similarity is not used", README.md:55); it reads the existing data attributes and prefers call → node → group → turn. `matchChatNodeRow` prefers the exact group part, then the node, then the group, then the step, then the turn.

### packages/experimental/session-inspector/src/client/views/chat-node/highlight.ts
- `visibleChatRect` intersects the target with every scrollport ancestor and clips the composer seat out, so a highlight never covers the composer and never extends outside the visible transcript (highlight.ts:22-25).

### packages/experimental/session-inspector/src/client/views/session-log/model.ts
- Purpose: The raw Session log projection.
- Key abstractions: `SessionLogModel`, `AssistantLogStream`, `SessionLogGroups`.
- Data flow: `SessionEventSource` snapshot → `accept(window)` → roots and chunk rows → `InspectorRow[]`; per-row `SnapshotStore` for the raw value.
- Non-obvious design decisions: The append fast path is `window.revision === this.revision + 1 && window.change.kind === 'append'` (session-log/model.ts:138). On an append, previously published row *objects* are reused verbatim (the test asserts `after.slice(0, before.length).every((row, i) => row === before[i])`), so React sees stable identities and the table does not rebuild. Any other change (pagination, settlement, replacement, a missed revision) rebuilds the hierarchy but *keeps the keyed record sources*.
- Edge cases / failure handling: `settle-assistant` maps a settled event's sequence number back to the *live attempt's* row key, so the live row and the durable row are the same identity (session-log/model.ts:136). `prune` releases record sources and settled identities that fell out of the loaded window (session-log/model.ts:150-151). `pick` prefers a tool call, then an exact anchor, then the owning assistant, then the step, then the turn.
- Surprising: Live chunks live under `attempt:<attemptId>` and a reasoning part's pick resolves to *its first reasoning block* rather than the assistant row (session-log/model.ts:78-85).

### packages/experimental/session-inspector/src/client/views/session-log/groups.ts
- `SessionLogGroups.append` assigns ancestry from the open turn/step range. It never synthesizes a missing start: a record that arrives before its `turn/start` stays a root, and loading an earlier start later re-parents the existing rows (README.md:33). The `turn/end` and `step/end` records stay as the *last children* of their group.

### packages/experimental/session-inspector/src/client/views/session-log/stream.ts
- `AssistantLogStream` indexes chunks by block index so interleaved reasoning and tool-call blocks keep separate subtrees. A `block-end` flips the block header to `closed` (auto-collapse), an unfinished block stays open, and the folded summary is a bounded join of *only that block's* reasoning deltas, capped at `INSPECTOR_PREVIEW_LIMIT` (stream.ts:63-76).

### packages/experimental/session-inspector/src/client/views/session-log/chat-target.ts
- `sessionLogChatTarget` derives the Chat coordinates from a log event alone: the call id for a tool call, a tool result, a nested ptc dispatch (`subCallId` + `rootCallId`), or a tool-call delta, and the reasoning/response group part from the chunk type (chat-target.ts:13-18).

### packages/experimental/session-inspector/src/client/views/inspector.module.css
- The CSS module: 30 px rows matching `INSPECTOR_ROW_HEIGHT`, a sticky-header ladder, the fixed-position pick mask and reveal overlay, and a `prefers-reduced-motion` rule.

### packages/experimental/session-inspector/src/css-modules.d.ts
- Ambient `declare module '*.module.css'` so the bundled CSS-module classes type-check.

### packages/experimental/session-inspector/tsconfig.json
- Client tsconfig with project references to session-controller, ui-chat, ui-primitives, ui-sidebar-right, ui-session, core/session, llm and cordis.

### packages/experimental/session-inspector/tsdown.config.ts
- One line: `clientBundle(import.meta.dirname, ['lib/types/index.js'])`.

### packages/experimental/session-inspector/tests/chat-node-fixture.client.ts
- Builds a Chat node whose Location data source has been materialized, so the raw-JSON writer reaches the real store/source cycle.

### packages/experimental/session-inspector/tests/chat-node.client.spec.ts
- Four cases: group nesting with hidden nodes and stable row identity across content updates; unlisted assistant steps placed by anchor; subscription lifetime and group retirement; an unavailable group source.

### packages/experimental/session-inspector/tests/details.client.spec.tsx
- Pointer-capture drag maths, height retained across a record change, competing-pointer and missing-geometry handling, keyboard resize.

### packages/experimental/session-inspector/tests/format.client.spec.ts
- Preview formatter: delta field selection, single-field collapsing, top-level `time` hidden but nested `time` kept, Chat column omission, array length bound.

### packages/experimental/session-inspector/tests/highlight.client.spec.ts
- `visibleChatRect` clipping against the scrollport, a group body and the composer; the target's own style is never mutated.

### packages/experimental/session-inspector/tests/log-chat-target.client.spec.ts
- Log-to-chat coordinate mapping for a user message, a tool call and its result, assistant chunks of each kind, and a nested ptc dispatch with a root call id.

### packages/experimental/session-inspector/tests/matching.client.spec.ts
- One-pass DOM scan, root-tool/group/turn fallbacks, and row matching that prefers nearby nodes over turn headers.

### packages/experimental/session-inspector/tests/object-tree.client.spec.tsx
- JSON containers all expanded with no links; disclosure state retained across a publication; collection enumeration bounded and not repeated on UI-only renders; cycles; accessors; sparse slots.

### packages/experimental/session-inspector/tests/object-value.client.spec.ts
- Opaque labels for Date/RegExp/WeakMap/WeakSet, buffer byte offsets, null prototypes, symbol fields, a Proxy that loses a key, 100 000-element arrays read one page at a time, and an intrinsic typed-array length that an own getter cannot shadow.

### packages/experimental/session-inspector/tests/objects.client.spec.ts
- The reference index over Node, Turn, Step and Data identities, group and member-part navigation, live `read()` after a replacement, and a stale value from an inactive table rejected.

### packages/experimental/session-inspector/tests/picker.client.spec.ts
- The mask hit-tests *below* itself, the hover preview is reused rather than recreated, non-primary clicks are ignored, the wheel is forwarded to the underlying scrollport with the right unit scaling, and the gesture cancels when the Chat leaves the viewport.

### packages/experimental/session-inspector/tests/presentation.client.spec.tsx
- The whole panel end to end: presentation switch, breadcrumb navigation through a collapsed group, pick-to-row, filter suggestions, and the "no match" notice that keeps picking alive.

### packages/experimental/session-inspector/tests/raw-json.client.spec.ts
- The JSON writer against a real cyclic Chat node, self-referencing maps and sets, a shared value expanded in each branch, bigint, and a throwing `toJSON`.

### packages/experimental/session-inspector/tests/reveal-scroll.client.spec.ts
- The reveal settlement contract: the flash waits for every moving ancestor, reduced motion is instant and silent, a user input cancels, a replaced animation cannot remove the new highlight, and late quiet/interrupt callbacks are contained.

### packages/experimental/session-inspector/tests/reveal-target.client.spec.ts
- Candidate ranking by step, turn and event distance with stable ties and property-order-independent deduplication.

### packages/experimental/session-inspector/tests/reveal.client.spec.ts
- Nested searchable folds open in order, the exact group part is selected, the overlay is the last child of `document.body`, and the Chat row's own DOM is untouched.

### packages/experimental/session-inspector/tests/session-log-groups.client.spec.ts
- Turn/Step nesting, closers at group tails, the sticky-ancestor ladder, filtering with retained context, pagination adding ancestry around existing rows, and a live assistant surviving settlement inside its step.

### packages/experimental/session-inspector/tests/session-log.client.spec.ts
- Published rows reused on append, interleaved blocks and earlier snapshots kept immutable, settlement replacing transient rows with lossless stream children, identities released outside the loaded window, and a settlement whose live frames were never loaded.

### packages/experimental/session-inspector/tests/stream-summary.client.spec.ts
- The folded reasoning summary joins only matching deltas, stays inside the preview bound, keeps the original chunk count, and keeps a finish chunk outside indexed content blocks.

### packages/experimental/session-inspector/tests/table-filter.client.spec.tsx
- The confirmed filter composes with folding, live rows, raw details and picked-row navigation; contextual ancestors are marked and not counted.

### packages/experimental/session-inspector/tests/table-geometry.client.ts
- A jsdom geometry shim: fixed row height, a `scrollHeight` model derived from the table, `scrollTo` clamping, and a row-aware `getBoundingClientRect` — because jsdom has no layout engine.

### packages/experimental/session-inspector/tests/table-hierarchy.client.spec.ts
- Folding, sticky ancestors, the disclosure override reset when a block closes, no sticky header for an ancestor outside the window, and a cleared projection when a row's source is removed.

### packages/experimental/session-inspector/tests/table-layout.client.spec.ts
- Preserved collapse, trailing space reserved *after* all rows, each nested sticky level replaced as the next step arrives, and a manual anchor kept at its measured viewport position.

### packages/experimental/session-inspector/tests/table-scroll.client.spec.tsx
- Bottom following on load, nested sticky header offsets, and an automatic block closure that keeps the visible anchor while the freed space moves below the data.

### packages/experimental/session-inspector/tests/table.client.spec.tsx
- The merged reasoning preview only while folded, preview filtering that does not touch the raw data, virtualization of 1000 rows, the update flash, the identity tooltip outside the table's clipping area, and a pagination retry after a failure.

### packages/experimental/session-inspector/tests/type-filter-editor.client.spec.tsx
- Out-of-order suggestion responses discarded, IME Enter ignored, drafts discarded on dismissal, a failure contained, and focus kept inside the panel.

### packages/experimental/session-inspector/tests/type-filter.client.spec.ts
- Case-insensitive fragments, an inactive query returning the original hierarchy *by identity*, matching descendants revealed under a closed block, and suggestions computed over all loaded rows.

### packages/experimental/session-inspector/tests/views.client.spec.ts
- Plugin lifecycle: the inert Host entry, the tab and its guide entry, waiting for the Sidebar slot and following its redeclaration, per-session source binding, and picker ownership across two plugin instances.

---

### packages/experimental/webworker-packer/README.md
- Purpose: The packer reference.
- Key abstractions: The four pack layers (roster, publish view, reachability sweep, lazy chunks), the config-tree declaration, the preview fixture preparation.
- Data flow: profile → bundle roster → dependency closure → publish view → reachability sweep → tar → gzip → `vfs-image.tar.gz` plus `lazy/<sha256>.tar.gz`.
- Non-obvious design decisions: "No composed configuration is packed: the worker host composes the bundle layers from the packages the roster materializes, as the served launcher does" (README.md:26) — the image ships the *ingredients*, not the composed tree, so the preview exercises the real composition code.
- Edge cases / failure handling: A chunk the package does not publish fails the pack; a rule table is a judgement call pinned by tests, not a scanner change.
- Surprising: "The packer assumes built `lib/` artifacts are current: it never compiles" — the packer is deliberately not a build step, so a stale workspace build packs stale bytes (README.md:61).

### packages/experimental/webworker-packer/README.zh.md
- Chinese translation of the packer README, 74 lines, same limitations list.

### packages/experimental/webworker-packer/README.i18n.yaml
- Per-heading bilingual pairing hashes for the packer README.

### packages/experimental/webworker-packer/package.json
- The `dsh-pack-vfs-image` bin, a publish list that includes `lib/repository-*.js` (the repository adapter ships separately from the library), and the session-format dependencies the preview preparation needs.

### packages/experimental/webworker-packer/bin.js
- A committed bin link target: pnpm only creates a bin link when the target exists at install time, so this file exists and forwards to `lib/bin.js`, printing a build hint when the build product is missing.

### packages/experimental/webworker-packer/src/index.ts
- The library barrel: the transform contract, the pack API (`packVfsImage`, `packVfsOverlay`, `collectModuleNames`) and the repository adapter.

### packages/experimental/webworker-packer/src/rules.ts
- The judgement tables, in one file: `EXCLUDE` (tests, maps, declarations, archives), `EXCLUDE_WORKSPACE` (`src/**`, `dist/**`), `PAGE_ASSETS` (the `lib/client.js` browser bundles that must ship untransformed), and `IMAGE_ENTRY_SEEDS` (the four packages the worker assembly requires by literal name).

### packages/experimental/webworker-packer/src/transform-image.ts
- `WRAPPER_CONTRACT` is bound to the runtime's `LOWERING_VERSION`, so the image records the contract it was lowered against and the worker refuses a mismatch.

### packages/experimental/webworker-packer/src/pack.ts
- Purpose: The packer proper.
- Key abstractions: `materialize` (dependency closure), `publishedFilter` (npm `files` semantics), `sweepImage` (reachability), `lazyChunksOf` (page chunk extraction), `compressImage` (deterministic gzip), `packVfsOverlay` (opaque data trees).
- Data flow: roster → `materialize` → publish view → `sweepImage` (which uses the *runtime's own* `WorkerModuleLoader` to resolve) → executables dropped → lazy chunks split out → manifest written → tar → gzip.
- Non-obvious design decisions: The sweep resolves through the runtime loader rather than a reimplementation, so "pack-time reachability and boot-time resolution cannot drift" (pack.ts:308). Our own unresolvable request *fails the pack*; a third-party one is tolerated and "fails loud at require time" (pack.ts:442-447). Page assets (`lib/client.js`) ship verbatim because the page's own module system evaluates them with a different wrapper (rules.ts:43-52). A shebang marks a "program", so executable scripts are dropped — they are also the one place top-level `await` can appear (pack.ts:505).
- Edge cases / failure handling: The manifest's claim is all-or-nothing: a module the transform cannot express fails the pack rather than downgrading the image. The gzip OS byte is overwritten with 255 so the same tree packs byte-for-byte the same on any platform (pack.ts:657). Overlays may only mount under `home/` and `workspace/` (pack.ts:765-778).
- Surprising: Every JavaScript entry gets a trailing `//# sourceURL=` naming its *repository* path, and a dangling `sourceMappingURL` is stripped first — otherwise the debugger would report one load failure per named script (pack.ts:343).

### packages/experimental/webworker-packer/src/repository.ts
- The repository knowledge, kept out of `pack.ts` so the same library can pack a different tree. It scans `vendor/`, `packages/`, `native/system/packages/` and `apps/` for workspace packages, reads the profile's bundles and optional bundles from app-boot, composes the home patch from `PLATFORM_ENTRY_CONFIG` over each named row's composed config, and reads the internal `dsh.configTrees` declaration (validated, unique mounts).

### packages/experimental/webworker-packer/src/preview.ts
- `packPreviewFixture`: in Node, restores the newest canonical raw Session generation with the session-format catalog, strictly validates it, encodes the *current* successor, verifies it by restoring it again, and packs it beside the byte-identical source files. A malformed, unsupported or future generation refuses the build without falling back (preview.ts:20-26).

### packages/experimental/webworker-packer/src/bin.ts
- The CLI: `--out`, `--profile`, `--root`; refuses an incomplete image ("the image would be incomplete"), writes the lazy archives beside the base image, packs each preview fixture and writes `fixtures.json`.

### packages/experimental/webworker-packer/tsconfig.json
- Node tsconfig referencing include, app-boot, the runtime and the three session-format packages.

### packages/experimental/webworker-packer/tsdown.config.ts
- A tsdown override that adds the `bin` entry to the library build, because the root build only emits `lib/types/index.js`.

### packages/experimental/webworker-packer/tests/entry-seeds.spec.ts
- Reads `worker-host.ts` and asserts its literal `require('…')` list equals `IMAGE_ENTRY_SEEDS` exactly — the seed table cannot drift from the code it seeds.

### packages/experimental/webworker-packer/tests/exports.spec.ts
- A declaration-only export face (`types` only) is not a runtime root, but a runtime *import* of it fails the pack; a missing runtime target beside a types condition fails too.

### packages/experimental/webworker-packer/tests/lazy-chunks.spec.ts
- `require.async("./client.<name>.js")` chunks each become their own `lazy/<sha256>.tar.gz`; an eager `./client` export target stays in the base image; a chunk the package does not publish fails the pack; two packs of the same tree are byte-identical.

### packages/experimental/webworker-packer/tests/image-loadable.spec.ts
- The end-to-end proof: pack, mount and `require` through the *real* loader (which carries no transform), the refusal case that restores an un-lowered body and expects the "still carries module syntax" error, the deterministic gzip header bytes, the debugger naming, and the Landlock and plugin-inventory packages running unchanged.

### packages/experimental/webworker-packer/tests/profile-image.spec.ts
- The profile roster, the home patch composition, the installation manifest entering the image alone, and the refusal of an installation that is also a roster package.

### packages/experimental/webworker-packer/tests/preview.spec.ts
- Preview Session preparation: subagent children cataloged from the same root, the highest generation chosen, an already-current image left byte-identical, and future/corrupt/unknown-required data refused without changing the inputs.

### packages/experimental/webworker-packer/tests/built-lib.e2e.ts
- The installed pair: both packages packed to tarballs, extracted into a temp `node_modules`, and driven from plain Node — pack an image, mount it, apply an overlay, and prepare a preview session.

---

### packages/experimental/webworker-runtime/README.md
- Purpose: The runtime reference.
- Key abstractions: The four artifacts (`lib/index.js` assembly, `lib/worker.js` worker bundle, `lib/client.js` page half, `src/shell/` process layer), the image layout contract, the lazy-archive contract, the module proxy table.
- Data flow: page → `init` frame (image URL + overlay URLs) → worker inflates and mounts the image → module loader → the image's own `dsh-app-boot` boots the tree → tunnel serves the page.
- Non-obvious design decisions: "The Worker commits `appReady` once the tunnel serves, so HMR loads and applies profile changes live; the Worker's ES module cache stays empty and the `process` shim reports no entry script, so HMR compares and replaces no loaded modules" (README.md:30). The image's home patch carries `PLATFORM_ENTRY_CONFIG` so JSONL session logs stay plaintext because the worker has no Zstandard codec.
- Edge cases / failure handling: A lazily supplied file has no synchronous read before its archive arrives (README.md:67). A boot failure refuses the whole request queue with 503.
- Surprising: "Worker confinement is a VFS boundary, not kernel Landlock" — the unchanged `landlock-run` JavaScript and its argv are used, but the *executable* is implemented in the worker, so `full` covers the command table and the mounted VFS only, not kernel isolation (README.md:69).

### packages/experimental/webworker-runtime/README.zh.md
- Chinese translation of the runtime README; read lines 1-40 of 84.

### packages/experimental/webworker-runtime/README.i18n.yaml
- Per-heading bilingual pairing hashes for the runtime README.

### packages/experimental/webworker-runtime/package.json
- Three export entries — the root library, `./worker` (the self-contained browser bundle) and `./client` (the page connector) — plus `acorn` and `@yarnpkg/parsers` as the two non-trivial dependencies.

### packages/experimental/webworker-runtime/tsconfig.json
- Host tsconfig with `DOM` and `WebWorker` libs and references to the gateway, connection, file-upload, webserver, app-boot, client-web and cordis.

### packages/experimental/webworker-runtime/tsdown.config.ts
- One pipeline, three artifacts. The `moduleProxyPlugin` rewrites every `node:*` and replaced-external specifier onto its `./node/` proxy so `lib/worker.js` is one self-contained ES module; `shellParserOnlyPlugin` pins `@yarnpkg/parsers` to `lib/shell.js` to keep ~175 kB of Syml parser and js-yaml out of the bundle.

### packages/experimental/webworker-runtime/src/index.ts
- The public barrel: the ALS runtime, the tunnel frames, the module loader, the module proxy tables, the transform, the storage API, and the image and fixture manifest types.

### packages/experimental/webworker-runtime/src/worker.ts
- The worker entry. The *role* is decided by the first frame: a `shell-start` frame makes this worker a shell process (it mounts no image and boots no tree), an `init` frame makes it the host. Messages before `init` queue locally; tunnel requests are dispatched at the async-context root so a request "cannot inherit whatever ran just before it on this thread" (worker.ts:87-89).

### packages/experimental/webworker-runtime/src/worker-host.ts
- Purpose: The worker assembly.
- Key abstractions: `createWorkerHost` (synchronous), `WorkerHost.start`, `installLogSink`, `prepareProfile`, `deferLazyArchives`.
- Data flow: `createWorkerHost` builds the tunnel and returns immediately; `start` mounts the image and overlays, installs the process shim and module loader, resolves the image's own `dsh-app-boot`, boots the tree with the profile, and hands the tunnel its serving seams.
- Non-obvious design decisions: Construction is split in two on purpose so the worker can accept messages during boot (worker-host.ts:12-16). The tree boots through the *image's own* `boot()` glue, so profile composition, entry mounting, the activation audit and its diagnostics are the same code the Node deployment runs (worker-host.ts:16-23). The `process` shim is installed *before* the image is read, because the tree reads `process.env` while the Loader is constructed.
- Edge cases / failure handling: A missing manifest, a malformed one, or one lowered against another contract is refused at load. An image that registers lazy archives but arrived as bytes is refused — only a URL can locate them (worker-host.ts:399-401). A boot failure refuses the whole queue with 503 and re-throws.
- Surprising: `installLogSink` exists because cordis's `LoggerService` "always exists and always accepts messages, but with no exporter mounted it only fills a ring buffer" — a provider that fails and is skipped then looks identical to one that found nothing, "which is how an empty skill catalog hid a filesystem fault twice" (worker-host.ts:311-316). The exporter's level is set to 2, because cordis's default admits errors and info but silently drops every warning (worker-host.ts:328-333).

### packages/experimental/webworker-runtime/src/image-layout.ts
- The layout contract shared with the packer: the virtual root, the image file name, the manifest path, the lazy directory, the overlay directories, the wrapper parameter list, and `LOWERING_VERSION`. `PLATFORM_ENTRY_CONFIG` is the one place the runtime states a config field it requires (`session-persistence-jsonl → compression: none`).

### packages/experimental/webworker-runtime/src/image-manifest.ts
- `parseImageManifest` validates the fetched manifest and refuses an image whose `lowered` field names another contract, with the message "rebuild the image". It also rejects a repeated archive, a repeated file, a traversal path, and a `defaultFixture` that names no fixture.

### packages/experimental/webworker-runtime/src/fixture-manifest.ts
- The browser-readable `fixtures.json` validator: a version gate, a slug-shaped id that may not be `none` or `webfs`, non-empty label and description, a non-empty overlay list, unique ids, and a `defaultFixture` that must name a fixture.

### packages/experimental/webworker-runtime/src/module-proxies.ts
- The single platform fork: the exact specifier → implementation table. The classification is in the *path*: `implemented/<module>.ts` carries the module's real semantics over a worker data source, `mock/<module>.ts` is a structural placeholder whose calls report the missing capability, and `external_packages/<pkg>.ts` stands in for an npm package.

### packages/experimental/webworker-runtime/src/module-system/module-loader.ts
- Purpose: The CommonJS loader over the VFS.
- Key abstractions: `WorkerModuleLoader`, `Resolution` (static | file), `WorkerRequire` (call + `resolve` + `resolve.paths`).
- Data flow: `resolve(specifier, from)` → static table, `cordis:`/`node:` refusal, file URL, relative, absolute, or bare package (`exports` walk, then `main`, then `index.js`) → `load` → `new Function(...WRAPPER_PARAMS, code)` → cached exports.
- Non-obvious design decisions: The static table is a `Map`, not the record, "so a specifier that names an Object prototype member must miss the table the way any other unregistered name does" (module-loader.ts:144). The loader carries **no transform**: module syntax reaching `compile` is a pack defect and the error names the image (module-loader.ts:407). The `exports` condition order is `browser, require, import, default` with `node` deliberately absent (module-loader.ts:21). A module that throws is removed from the cache so a later require re-runs it.
- Edge cases / failure handling: Failures carry Node's codes (`MODULE_NOT_FOUND`, `ERR_PACKAGE_PATH_NOT_EXPORTED`) and the importer chain. `import.meta.resolve` answers a file URL for a VFS module and the specifier itself for a static module, the way Node echoes `node:*` back.
- Surprising: `requireActiveModuleLoader` throws a message that names the *caller's obligation* ("the worker entry must call setActiveModuleLoader before any createRequire use") rather than a generic null error.

### packages/experimental/webworker-runtime/src/module-system/posix-path.ts
- The VFS's normalizing path helpers, explicitly *not* a `node:path` substitute: "the two forms diverge in 45 [cases], all in dirname/basename/parse" (posix-path.ts:8-13). This is a well-documented case of two similar utilities that must not be merged.

### packages/experimental/webworker-runtime/src/compile/transform.ts
- Purpose: The pack-time module transform.
- Key abstractions: `Transformer` (interval-based edits), `HELPER_SOURCE` (`__dsh$def/default/ns/exportAll/dynImport`), `lowerModuleSource` (the public entry returning `{ code, lowered, moduleRequests, metaResolveRequests }`).
- Data flow: acorn parse → visit (module syntax, suspension points, `new.target` preservation) → sorted interval edits → splice the *original text* → re-parse as a script to prove the result.
- Non-obvious design decisions: Both jobs (ESM→CJS and async-context routing) live in one pass because they are two edits over one tree; "running a lexer first and a parser second meant two scanners, two sets of blind spots, and a second pass reading the first pass's output" (transform.ts:6-8). Editing is interval-based and the original text is sliced, never reprinted, so **line numbers survive** (transform.ts:8-11). Each edit pads with the newlines the original range held *minus* the ones the replacement re-emits (transform.ts:110-120), which is why a desugared loop does not push every later line down.
- Edge cases / failure handling: Top-level `await` and top-level `for await` are refused. A `yield*` that is not the whole statement expression is refused rather than silently dropped (transform.ts:294-300). `yield*` does not forward a consumer's `throw()` into the inner iterator — the limitation is stated in the code. A body that already carries the protocol is refused ("the module is already lowered"), so a mis-wired manifest surfaces at pack time rather than as a silent tax on every load.
- Surprising: `new.target` is rewritten to `__dsh$meta` and *must* survive untouched, because the abstract-seam guards in the roster read `new.target === X` (transform.ts:372-381). The transform also reports the *static* module requests it saw — literal imports, re-exports, dynamic imports, `require('x')`, and module-scope `createRequire(import.meta.url)('pkg')` — which is exactly what the packer's reachability sweep consumes.

### packages/experimental/webworker-runtime/src/node/builtins.ts
- The Node-compatibility table: builtin and external specifier factories, the pi-ai prefix table, and a boot-time check that `REPLACED_EXTERNAL_PACKAGES` and the wired table agree — "a package replaced here must also be kept out of the VFS image, so any divergence fails at worker start rather than at first require" (builtins.ts:122-127).

### packages/experimental/webworker-runtime/src/node/notImplementedFail.ts
- Builds the refusing stub and the `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` error. The refusal is written to the console *before* it propagates, because "callers routinely swallow these errors far from their cause" (notImplementedFail.ts:13-14). The stub is a function expression, not an arrow, so a stub standing in for a class refuses under `new` too.

### packages/experimental/webworker-runtime/src/node/process-table.ts
- The worker's process table: pids are reserved *before* the command starts so a handle can report one synchronously; `processAlive` answers the liveness probe; `SIGKILL` destroys the worker-backed process while every other signal asks it to stop at its next boundary.

### packages/experimental/webworker-runtime/src/node/globals/process.ts
- The `process` global. `versions.node` reports `24.18.0` so `ModuleLoader.fromInternal()` reaches the cascaded loader the way it reaches Node's. `getBuiltinModule` answers the loader's proxy for a builtin id and `undefined` for anything else — "never an image resolution" (process.ts:108-118). `execPath` is `/dsh/bin/node`, a virtual identity: spawning it reports ENOENT because there is no Node binary behind it. `title` is present so third-party packages take the Node branch rather than the DOM-only one.

### packages/experimental/webworker-runtime/src/node/globals/timers.ts
- Node-shaped timer handles: the browser's numeric ids become objects with `ref`/`unref`/`hasRef`, the object converts to its numeric id so any code storing it as a number keeps working, and each handler is bound to the context where the timer was *registered*.

### packages/experimental/webworker-runtime/src/node/globals/crypto.ts
- Fills `crypto.randomUUID` on insecure origins, because "a preview served over plain HTTP on a LAN address is not [a secure context] — while product code reaches the global directly, Node-style" (crypto.ts:4-6). A platform that already has the method is left untouched.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/async_hooks.ts
- Purpose: `AsyncLocalStorage` without any async-context tracking in the browser.
- Key abstractions: `AsyncLocalStorage` with **four** slots — hook overlay, resumed context, boundary ambient, and the folding stack — and the statics `snapshotAll`/`restoreAll` plus `alsCausality`.
- Data flow: `getStore()` reads overlay → resumed → ambient → folding stack, in that order (async_hooks.ts:146-152). The transform's `pause` snapshots through `__snapshotAll` and `resume` publishes through `__restoreAll`.
- Non-obvious design decisions: Every slot is removed **by identity, never blindly** — "boundaries settle and frames resume out of order, so a blind pop would drop somebody else's context" (async_hooks.ts:26-27). `run()` publishes both a folding entry and an ambient overlay, and clears the overlay/resumed slots for its own extent so a boundary opened under a hook-restored callback reads its own store. A snapshot with no stores at all is `undefined`, so the hook layer wraps nothing and a callback registered outside every boundary inherits the enclosing one rather than being masked (async_hooks.ts:34).
- Edge cases / failure handling: The documented structural limit: native `await` resumption in *untransformed* code is invisible, so such a frame falls back to the nesting-ordered folding stack and two overlapping boundaries can attribute to the wrong one — "Nothing crashes … and everything the hook layer or the rewriter covers is exact" (async_hooks.ts:39-44).
- Surprising: `runAtAsyncContextRoot` publishes `undefined` for every instance, and the tunnel uses it to dispatch every request at the root so a queued request never inherits an unrelated boundary.

### packages/experimental/webworker-runtime/src/polyfill/async-context/als-runtime.ts
- The object the transformed modules call. `pause` snapshots **before** suspending and returns a token that *always fulfills* (a rejection travels inside it); `resume` restores **before** returning or rethrowing, so both completion paths are causally exact. The state lives in the `node:async_hooks` proxy; this module only moves it. `iterator` upgrades a sync iterable to async-from-sync.

### packages/experimental/webworker-runtime/src/polyfill/async-context/async-context-hooks.ts
- Patches `Promise.prototype.then`, `queueMicrotask` and `fetch` so a callback runs in the context where it was *registered*. Two properties are kept deliberately: the values stay native promises (a handler is wrapped, never the chain), and an empty handler slot stays empty — "`.then(undefined, onRejected)` must not grow a fulfilled handler, or a rejection would be swallowed" (async-context-hooks.ts:19-21). Node's `catch`/`finally` inherit the patch because they are specified to invoke `then` on the receiver.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/fs.ts
- The `node:fs` bridge: `MemoryVfs` owns paths, bytes and the tree; this module adds the Node-API-shaped parts (Buffer results, `Dirent`, descriptors, `FileHandle`, `mkdtemp`, access checks, watchers, streams, the promise face). `asBuffer` *shares* the VFS bytes rather than copying them. The promise face's `open` and `readFile` await `whenReadable` first, which is how a lazy archive's bytes arrive.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/fs-watch.ts
- Filesystem watching over the VFS. The load-bearing rule: a watcher callback runs in the async context where the **watcher was created**, never the context of the code whose write produced the event — "HMR depends on it" (fs-watch-context.spec.ts:3-5). The mechanism is `captureAsyncContext` at watcher creation and `runWithAsyncContext` at dispatch, with `runAtAsyncContextRoot` for the other stores.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/path.ts
- A literal port of Node's POSIX path implementation, *not* a facade over the normalizing `posixPath` helper: "45 cases diverge between the normalizing helper and Node" (path.ts:4-7). `win32` members throw except `isAbsolute`, which cross-platform callers use to reject Windows absolute paths on any platform.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/child_process.ts
- Purpose: `node:child_process` over the in-worker shell.
- Key abstractions: `WorkerChildProcess` (pid, three pipes, exitCode/signalCode), `WorkerReadable`/`WorkerWritable`, `spawnEnoent`.
- Data flow: `spawn` → a process table entry → a microtask (so a caller that attaches listeners and writes stdin right after `spawn()` is never racing the first output) → a virtual executable check → the shell process → output/exit events.
- Non-obvious design decisions: A missing program fails exactly as Node fails a missing binary — `code`, `errno`, `path` and `syscall` are all set — "so consumers that classify spawn errors by `code`, `path`, and `syscall` keep working" (child_process.ts:179-190). A signalled command reports **no** exit code, which is what makes the subprocess service classify it as killed rather than finished (child_process.ts:246-250). The stream-shaping members (`setEncoding`, `pause`, `resume`) are no-ops rather than omissions, so a caller that configures the pipe before reading it does not die of a TypeError and hide the real `ENOENT` (child_process.ts:45-52).
- Edge cases / failure handling: `execSync`, `execFileSync` and `fork` refuse; `spawnSync` reports a Node-shaped `error` (absent program → `ENOENT`, a program this shell *does* have → "only the asynchronous path can run it").
- Surprising: `spawn` starts the command on a microtask, and a signal that arrived while the process was still starting is delivered once the process exists (child_process.ts:309-314).

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/crypto.ts
- WebCrypto for randomness, `@noble/hashes` for *synchronous* digests (SubtleCrypto is async and every caller here hashes synchronously). `randomUUID` is delegated to the repository's own mint because browsers expose `crypto.randomUUID` only in secure contexts.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/events.ts
- A minimal `EventEmitter`. `once` wraps the listener but records it in a `listener` member, so `removeListener(event, original)` matches through the wrapper — "a caller that registered with `once` can withdraw with the function it wrote" (events.ts:12-14). `off` removes the *last* registration first, as Node does.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/http.ts
- The `node:http` seam. `createServer` retains the request listener; `listen` "succeeds immediately. The callback must run or the webserver fiber stays in LOADING forever" (http.ts:77-87). The captured listener is what the tunnel feeds synthesized requests into, so the *real* route table, its trust fences and every handler run unchanged.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/module.ts
- `createRequire` over the worker loader, plus `builtinModules`/`isBuiltin`. `register` and `stripTypeScriptTypes` refuse.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/os.ts
- Fixed platform facts (`linux`, `x64`, one CPU) and VFS paths. `cpus()` and `networkInterfaces()` are empty — "a worker has no view of the host's network" (os.ts:87-88).

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/stream.ts
- `node:stream` over `readable-stream`: the worker owns only the platform adapters, while stream state, backpressure, async iteration and event ordering stay in the maintained userland implementation. The default high-water mark is raised from readable-stream's Node 18 value (16 KiB) to this repository's Node 22 value (64 KiB).

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/util.ts
- `promisify` follows Node's error-first convention exactly, because zlib-style APIs are wrapped with it at module scope. `isDeepStrictEqual` compares *own enumerable* properties, "preserving Node admission decisions for recorded fields such as `__proto__`" (util.ts:92-100). `inherits` sets `super_` and the prototype chain the way Node does.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/zlib.ts
- The zstd *constants* are kept because the JSONL backend reads them at module scope, but every codec call refuses — the composition writes plaintext logs. `createZstdDecompress` deliberately returns a handle-less object so the backend's private-shape probe declines and it falls back to its public one-shot decoder (zlib.ts:43-51).

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/buffer.ts
- `node:buffer` over the `buffer` npm package, plus the `globalThis.Buffer` install — "Node code treats Buffer as ambient, so the global must exist before any host module evaluates" (buffer.ts:4-5).

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/assert/strict.ts
- Truthiness assertions only. The callable default and `ok` throw `ERR_ASSERTION` with the supplied message, rethrowing a supplied `Error` unchanged.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/abort-error.ts
- Builds the Node-style `AbortError` with `code: 'ABORT_ERR'` and the signal reason as `cause`.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/stream/promises.ts
- `finished` and `pipeline` re-exported from the shared `readable-stream` implementation.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/timers/promises.ts
- `setTimeout`/`setImmediate`/`scheduler`. An already-aborted signal rejects immediately and the timer is never armed — "a signal that has already aborted emits no further `abort` event, so the timer must not be armed at all" (timers/promises.ts:23-27).

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/perf_hooks.ts
- The worker's own `performance` clock; `PerformanceObserver` refuses.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/tty.ts
- `isatty` is always false — the host has no terminal-backed descriptors.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/url.ts
- `fileURLToPath`/`pathToFileURL` with Node's exact escaping, so `@`, `:` and `~` survive and scoped package directories round-trip. The WHATWG `URL`/`URLSearchParams` classes are the browser globals, re-exported as Node does.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/fs/promises.ts
- Named re-export of the promise members of the fs bridge.

### packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/util/types.ts
- The four predicates, re-exported from the util shim so both specifiers share one implementation.

### packages/experimental/webworker-runtime/src/node/builtin_modules/mock/https.ts
- `createServer` refuses rather than serving plaintext for an HTTPS configuration.

### packages/experimental/webworker-runtime/src/node/builtin_modules/mock/net.ts
- Address predicates are real; `createServer` and `connect` refuse; `Socket` is constructible but every write refuses, because the fake HTTP server never emits `upgrade`.

### packages/experimental/webworker-runtime/src/node/builtin_modules/mock/vm.ts
- `Script`, contexts and the run family all refuse — "the self-modification and workflow rows mount and report the gap when they try to compile" (vm.ts:4-5).

### packages/experimental/webworker-runtime/src/node/builtin_modules/mock/worker_threads.ts
- Construction refuses, but `isMainThread`/`threadId` stay truthful: "they say 'this is the main thread', which is what the worker host is from the tree's point of view" (worker_threads.ts:4-5).

### packages/experimental/webworker-runtime/src/node/builtin_modules/mock/sqlite.ts
- `DatabaseSync`, `StatementSync` and `backup` refuse; the web profile configures sqlite with `:memory:` and `openAt: never`, so reaching the constructor means that configuration changed.

### packages/experimental/webworker-runtime/src/node/builtin_modules/mock/dns/promises.ts
- `lookup` refuses, so "reaching public-address preflight must fail loud instead of inventing an address or bypassing the native HTTP provider's SSRF policy" (dns/promises.ts:3-4).

### packages/experimental/webworker-runtime/src/node/external_packages/replaced-externals.ts
- The list of external specifiers served from the worker bundle instead of the VFS image; the packer uses it to keep those packages out of the image.

### packages/experimental/webworker-runtime/src/node/external_packages/execa.ts
- Refuses: the preview cannot run pnpm or install plugins.

### packages/experimental/webworker-runtime/src/node/external_packages/got.ts
- `got.post` refuses: desktop product telemetry is unavailable.

### packages/experimental/webworker-runtime/src/node/external_packages/koffi.ts
- The FFI stub. The type constructors (`pointer`, `struct`, `array`, `opaque`) compute the *x64* sizes and alignments koffi reports, because "the Windows ACL layer compares them against its own header probe at module scope" (koffi.ts:85-86) — the plugin must mount, but nothing may cross into native code.

### packages/experimental/webworker-runtime/src/node/external_packages/libreoffice-kit.ts
- `createConverter` rejects with the kit's `unavailable` code.

### packages/experimental/webworker-runtime/src/node/external_packages/node-addon-require-builtin.ts
- The channel that answers Node's internal module ids for the vendored Loader, app-boot and HMR when `--expose-internals` is absent. It maps five ids to objects with the members those callers read, and refuses every other id with Node's platform code.

### packages/experimental/webworker-runtime/src/node/external_packages/node-addon-system-flock.ts
- The single-process flock replacement: the JSONL backend's in-process write claim already excludes every writer, so the kernel-lock request succeeds without another resource.

### packages/experimental/webworker-runtime/src/node/external_packages/node-pty.ts
- `spawn` and `open` refuse; the terminal plugins mount so their tools stay visible.

### packages/experimental/webworker-runtime/src/node/external_packages/pi-ai.ts
- Every symbol `llm-pi-ai` imports by name is present (a missing CommonJS symbol would degrade to `undefined` at call time). The provider reader returns a fixed list of *valid* pi-ai provider ids with no models, so the adapter can register configuration metadata while every request path stays loud.

### packages/experimental/webworker-runtime/src/node/external_packages/ripgrep.ts
- Exports a plain `rgPath` string so the search plugins' module-scope read succeeds; the loud failure comes later, from the child_process stub.

### packages/experimental/webworker-runtime/src/node/external_packages/sharp.ts
- The default export refuses: native image transcoding has no browser counterpart.

### packages/experimental/webworker-runtime/src/node/external_packages/ws.ts
- `WebSocketServer` must be *constructible* because `WebSocketDownlinks` constructs one in a field initializer; its methods are unreachable because the fake HTTP server never emits `upgrade`.

### packages/experimental/webworker-runtime/src/node/internal_modules/esm-loader.ts
- The cascaded ESM loader with Node v24.18.0's v2 members: `resolveSync` and `import` over the worker loader, an empty `loadCache`, and `getOrCreateModuleJob` refusing. A `MODULE_NOT_FOUND` failure is re-coded to Node's `ERR_MODULE_NOT_FOUND`.

### packages/experimental/webworker-runtime/src/node/internal_modules/module-map.ts
- `ResolveCache` and `LoadCache` following Node v24.18.0, including Node's `serializeKey` format; storing a module job refuses because the Worker creates no ES module jobs.

### packages/experimental/webworker-runtime/src/node/internal_modules/package-surfaces.ts
- `Module`, `packageJsonReader` and the `modules` binding — the members HMR *replaces*. They keep Node's names so a replacement still finds them, and refuse when called.

### packages/experimental/webworker-runtime/src/storage/types.ts
- The filesystem interfaces and the error shape (`code`, `path`, `syscall`). `VfsBigIntStats` is documented as load-bearing: the filesystem service builds its version token from `dev:ino:size:mtimeNs:ctimeNs`, so "a number-valued `mode` here fails the whole read as a type error, and a constant `ino`/`mtimeNs` would make the service's stale-write guard unable to tell two revisions apart" (types.ts:43-50).

### packages/experimental/webworker-runtime/src/storage/memory.ts
- Purpose: The in-memory VFS.
- Key abstractions: `MemoryVfs` (files + directories + deferred registrations), `FileNode` (bytes, mode, identity, path set), `loadVfsImage`, `loadVfsOverlay`.
- Data flow: `seed`/`seedDirectory` at mount → per-path maps; every mutation publishes a `VfsMutation` to the durable sink and to the subscribers; watchers and the durable writer consume that stream.
- Non-obvious design decisions: File identity lives on the `FileNode` so descriptors, renames and hard links keep addressing the same file, while directories hold their identity in a path map. Timestamps are **strictly increasing** per entry: `Math.max(now, previous + 1)` — "the filesystem service's stale-write guard compares timestamps, so an equal one would let a stale overwrite through" (memory.ts:608-611). Permission bits are stored but never enforced ("a single-owner filesystem reads and writes as its owner regardless, like root", memory.ts:72-73).
- Edge cases / failure handling: A file registered for a lazy archive refuses a *synchronous* operation with `ERR_DSH_VFS_DEFERRED` naming the archive (memory.ts:382-394). One archive fetch is shared by every waiting reader; a failed fetch clears the promise so the files stay registered and the next read retries (memory.ts:377). A rename that would move a deferred file refuses *before* the destination changes, so a refused move leaves both trees as they were. An overlay may only populate `home/` and `workspace/`; a path with a traversal segment is refused before normalization, and a file may not replace a directory.
- Surprising: The VFS returns *views* into the stored bytes, and `readFileSync` shares them rather than copying — which is why the tunnel's `toTransferable` slices on the `ArrayBuffer` and not on the view, "a Node-style Buffer overrides `slice()` with view semantics" and `bytes.slice().buffer` would post the *entire image* as the body (tunnel.ts:76).

### packages/experimental/webworker-runtime/src/storage/active.ts
- The process-wide slot holding the mounted filesystem, kept apart from any backend so the `node:fs` proxy depends on the slot and not on which backend is mounted.

### packages/experimental/webworker-runtime/src/storage/paths.ts
- The VFS root constants, kept in one module "so the process shim, the path/os shims, and the VFS image collector cannot drift apart" (paths.ts:1-4).

### packages/experimental/webworker-runtime/src/storage/tar.ts
- A hand-rolled ustar reader and writer, hand-rolled on purpose: "the reader ships inside the worker bundle, where the streaming tar packages would drag Node stream shims back in" (tar.ts:8-10). File bytes are subarray views into the archive, so mounting copies nothing. A name that fits neither the 100-byte name nor the 155-byte prefix field fails loud rather than being truncated.

### packages/experimental/webworker-runtime/src/storage/image-gzip.ts
- The byte envelope. Inflation runs on the *response stream*, so unpacking overlaps the download and the compressed copy is never held whole beside the archive it produces. A body that is not a gzip member is refused by name, in the stream, before the decompressor sees it — "a plain tar, a truncated download, or a proxy's HTML error page would reach `parseTar` and fail as a corrupt header field, which says nothing about what the deployment actually served" (image-gzip.ts:13-16).

### packages/experimental/webworker-runtime/src/transport/frames.ts
- The frame protocol and `parseInboundFrame`, which validates every inbound payload: a usable id, a known frame type, string method and url, a headers object, and a body that is an ArrayBuffer, a Blob or a ReadableStream. Header names are lower-cased.

### packages/experimental/webworker-runtime/src/transport/synthetic-http.ts
- `IncomingMessage`/`ServerResponse` synthesis so the real route table runs unchanged. Only the members the route handlers read are synthesized — "anything else is absent on purpose so a new consumer fails loud instead of silently reading a stub" (synthetic-http.ts:8-9). `res.end()` is the settle point, because the captured listener returns void.

### packages/experimental/webworker-runtime/src/transport/tunnel.ts
- Purpose: The worker end of the tunnel.
- Key abstractions: `TunnelServer`, `TunnelSeams`, `BufferedSink`, `TunnelUplink`, `describeFailure`.
- Data flow: `handleMessage` → parse → (uplink frames feed the stream carrier) / (abort) / (queue until `serve`) → dispatch → route lane or direct lane → frames back to the page.
- Non-obvious design decisions: `GET /__boot__` answers from tunnel glue, never from the host API surface, "because the page needs the boot payload before its Cordis tree exists" (tunnel.ts:5-7). The method set for the privileged lane is *not* restated: a 401 or 403 from the route lane is retried on the direct lane, because "the page owns the worker and needs no network authentication" (tunnel.ts:8-10). The retry decision is made at the *first frame*, before anything reaches the page, and the `BufferedSink` records frames so a refusal's body can be discarded (tunnel.ts:474-492). `describeFailure` expands a nested `AggregateError` of per-entry failures, "each wrapping the plugin's own error as `cause`; only the outermost message names 'loader entries failed to apply', which says nothing about which row broke" (tunnel.ts:35-40).
- Edge cases / failure handling: An abort also releases the 401/403 wait — an aborted exchange stops emitting frames, so `settled` alone would never resolve when the handler had not yet written a head (tunnel.ts:486-492). An abort removes a still-queued request so it cannot run post-boot. A boot failure refuses the whole queue with 503. `toTransferable` slices the `ArrayBuffer`, not the view, so a Buffer view into the whole mounted image cannot post the entire image as a body.
- Surprising: The API trust fence reads `host`, "which the page cannot set itself" — the tunnel rewrites the request's host to `127.0.0.1` (tunnel.ts:411-414).

### packages/experimental/webworker-runtime/src/client/client.ts
- Purpose: The page half of the tunnel.
- Key abstractions: `WorkerTunnel` (fetch-shaped transport), `LogicalStreamInbox`, `UplinkPump`, `TunnelLogicalStreamError`.
- Data flow: `fetch` → one `req` frame → `res` / `res-head`+`res-chunk`+`res-end` / `res-err` → a `Response`; `open` → `stream-open` → `stream-item`/`stream-end`/`stream-error`; `loadBundle` → a Blob script.
- Non-obvious design decisions: The abort signal is checked *before any frame leaves* — "a request the caller already abandoned must not reach the worker, where a write-shaped route would still run" (client.ts:217-219). The signal is then handed to the body phase, because "a streaming response outlives its head" (client.ts:240-242). `localizeSourceMap` turns the tunnel-only source map into a Base64 data URL, and its failure is swallowed — "a source map is diagnostic-only; its transport failure must not prevent the plugin factory from registering" (client.ts:133-136). The refusal warning names the *method and URL* of the request, because "a tunnel failure and a failure inside the host tree look identical from the page" (client.ts:164-172).
- Edge cases / failure handling: A worker `error` event fails every pending unary request, every body stream and every logical stream. A non-Error rejection is still delivered. The `inFlight` map exists so a refusal can name what was refused.
- Surprising: The base64 encoder chunks the input at 32 KiB "without a call-stack-sized spread" (client.ts:113-121) — a real stack-overflow guard for a large source map.

### packages/experimental/webworker-runtime/src/client/index.ts
- The pre-Cordis page glue. The boot barrier (`__DSH_BOOT_READY__`) is installed *before* the first await so a client entry evaluating concurrently in the same document holds at its pre-boot await until every injection row has taken effect. The transport global must exist before any bundle executes; the injection table then reproduces the served boot rows in table order.

### packages/experimental/webworker-runtime/src/client/source-chooser.ts
- The pre-boot chooser. A `preview-fixture` query short-circuits the form; `none` returns an empty overlay list. The WebFS option is *reserved and disabled* rather than absent. The markup is escaped (`escapeMarkup`) because the labels come from a manifest.

### packages/experimental/webworker-runtime/src/client/text-viewer.ts
- The modal viewer. The dialog's `keydown` stops propagation because "the app's modal layers own Escape and Tab through document listeners; keys pressed in this top-layer dialog belong to its native handling" (text-viewer.ts:76-78).

### packages/experimental/webworker-runtime/src/client/apply-injections.ts
- A one-line re-export of `applyIndexInjections` from the client-web package, so the runtime does not duplicate the interpreter.

### packages/experimental/webworker-runtime/src/shell/types.ts
- The shell's contract: `ShellState` (cwd, environment, variables, lastStatus, exitRequested, signal), `ShellIo`, `ShellFileSystem` (asynchronous *by construction* — "a synchronous face would need `SharedArrayBuffer`, which requires cross-origin isolation this deployment cannot have"), `ShellProgram` and `ShellRunOutcome`. The output is text, not streams: "every program is a JavaScript function that returns before the next one starts, so a pipeline is a string handed along" (types.ts:33-38).

### packages/experimental/webworker-runtime/src/shell/ast.ts
- The AST aliases, derived from what `@yarnpkg/parsers` publishes (`CommandChain` is `Command` plus an optional pipeline link, so it is usable wherever a command node is expected).

### packages/experimental/webworker-runtime/src/shell/interpret.ts
- The interpreter: structure (`;` `&` `|` `|&` `&&` `||`, subshells, groups, redirections, prefix assignments) is honored here; what a command *does* belongs to its program. A missing program reports 127 and a syntax error reports 2, as POSIX does. The substitution depth is capped at 16 — "a deeper line is a runaway, not a command" (interpret.ts:27-28). The abort status is 130.

### packages/experimental/webworker-runtime/src/shell/expand.ts
- Word expansion: variables (with `:-` / `:+`), command substitution, arithmetic and globs. Globs are matched against the VFS *segment by segment* and keep the pattern's own spelling, so `ls *.ts` prints what the model typed. Listing failures are absorbed, because a glob may walk paths that do not exist.

### packages/experimental/webworker-runtime/src/shell/fs-access.ts
- The in-host `ShellFileSystem` over the VFS, plus `describeFailure`, which restates a Node error the way a shell utility reports it: `cat: /dsh/none: No such file or directory` rather than a Node error string.

### packages/experimental/webworker-runtime/src/shell/programs/index.ts
- The command table — "this table IS the machine's `/bin`". A name outside it reports `command not found`, exactly as a real shell would for a binary that is not installed. `which` reports a known name as a shell built-in.

### packages/experimental/webworker-runtime/src/shell/programs/options.ts
- The shared argument splitter: bundled and separate short flags, long flags with `=`, `--`, and the operands. A short letter listed as valued consumes the rest of its token (`-n5`) or the next argument (`-n 5`).

### packages/experimental/webworker-runtime/src/shell/programs/builtins.ts
- The state builtins: `cd` (with `OLDPWD` and `$PWD` kept in step), `pwd`, `export`, `unset`, `env`, `printenv`, `exit`, `test`/`[`, `sleep`, `date`, `seq`, `true`, `false`, `:`. `sleep` settles at once when the command is killed — "waiting out the full interval would keep the caller's process handle open long after its signal arrived" (builtins.ts:126-128).

### packages/experimental/webworker-runtime/src/shell/programs/files.ts
- The file utilities. `ls` prints one entry per line because "nothing here is ever a terminal, so the column layout a real `ls` picks for a tty would only be noise in a tool result" (files.ts:4-6). `find` reads its multi-letter predicates itself, because the shared option parser would read `-name` as bundled short flags.

### packages/experimental/webworker-runtime/src/shell/programs/text.ts
- The text utilities; each reads its operands as files and falls back to stdin. `printf` supports only the conversions a shell script realistically uses, and anything else is left verbatim "so the output shows what was not understood" (text.ts:64-65).

### packages/experimental/webworker-runtime/src/shell/process/protocol.ts
- The frames a shell process and its host exchange, and `isShellStartFrame`, which is how the worker entry decides its role. A filesystem failure carries the Node error `code` because "an Error instance does not survive structured cloning with its class" (protocol.ts:59-60).

### packages/experimental/webworker-runtime/src/shell/process/host.ts
- Purpose: Starting and supervising shell processes.
- Key abstractions: `startProcess`, `RunningProcess` (`interrupt` / `destroy`), `serveFilesystemCall`.
- Data flow: `startProcess` → a second `Worker` from the *same bundle URL*, told by its first frame to be a shell process → the child asks the host for filesystem operations over `fs-call`/`fs-reply` → output frames flow back → `shell-exit` settles.
- Non-obvious design decisions: Starting from the host worker's own URL "keeps the deployment free of a second static asset and of the build-order trap a sibling artifact would bring" (host.ts:99-101). The reason the module exists: "a worker dies on command, even mid-loop, so a timeout is enforceable rather than advisory" (host.ts:147-150). Where no `Worker` constructor exists (a Node test host) the same command runs inline, and the difference is *named* rather than hidden: an inline command can only be asked to stop.
- Edge cases / failure handling: An unknown filesystem op fails the call rather than answering `{ value: undefined }`, because "the op crossed a worker postMessage" (host.ts:88-92). A worker error settles the process with status 1 and a diagnostic.

### packages/experimental/webworker-runtime/src/shell/process/child.ts
- The process worker's half: one command, no image, no tree, no plugins — "the only thing it shares with the host worker is the bundle it was started from" (child.ts:4-7). Its filesystem is the host's, reached by message.

### packages/experimental/webworker-runtime/src/shell/process/virtual-executables.ts
- The registry of Worker platform executables and the three-way result (`exit` / `delegate` / `asynchronous`). A virtual executable *prepares* the invocation and hands back a possibly-restricted filesystem, so the command table and the platform executable stay decoupled.

### packages/experimental/webworker-runtime/src/shell/process/landlock.ts
- The Landlock launcher's argv grammar (`--probe`, `--ro`, `--rw`, `--`) parsed literally, plus a per-process filesystem guard that enforces the grants on every shell filesystem request. `/tmp` is mapped into the VFS, `/dev/null` is a virtual file, and a denial uses the `EACCES` dialect `dsh-bash-sandbox` expects. The launcher is *not* kernel Landlock in the browser — it is a logical boundary over the mounted VFS.

### packages/experimental/webworker-runtime/src/shell/process/xdg-open.ts
- The `xdg-open` replacement: it hands one VFS text file to the page's read-only viewer, which is how "Open configuration file" works in the preview. Exit statuses follow xdg-open(1): 1 usage, 2 missing file, 3 no viewer, 4 action failed.

### packages/experimental/webworker-runtime/tests/compile/transform.spec.ts
- The transform's semantic contract: the emitted body for each module form, the suspension rewriting, that line numbers survive, which forms are refused, and that five "trap" module forms stay fixed even though the AST pass makes them impossible.

### packages/experimental/webworker-runtime/tests/compile/transform-corpus-check.ts
- The full-corpus import gate: every built bundle in the workspace must be importable by Node's ESM loader. Baseline exemptions are a *pinned list, not a count*, and a listed file that becomes importable also fails, "so the list cannot rot" (transform-corpus-check.ts:8-11).

### packages/experimental/webworker-runtime/tests/compile/transform-corpus.spec.ts
- Runs the corpus gate in its own launcher, because the oracle is Node's ESM loader: "A gate whose verdict depends on how it was launched is not a gate" (transform-corpus.spec.ts:7-8).

### packages/experimental/webworker-runtime/tests/client/apply-injections.spec.ts
- Preload hints are ignored (the `/plugins` resources resolve only through the tunnel) and script sources execute through the worker loader.

### packages/experimental/webworker-runtime/tests/client/load-bundle.spec.ts
- Bundle loading over a stub worker.

### packages/experimental/webworker-runtime/tests/client/source-chooser.spec.ts
- The chooser: the query shortcut, the manifest fetch, and the escaped fixture labels.

### packages/experimental/webworker-runtime/tests/client/text-viewer.spec.ts
- The modal viewer shows plain text (not HTML), replaces the shown file on reuse, and closes from its button.

### packages/experimental/webworker-runtime/tests/fixture-manifest.spec.ts
- The fixture manifest validator: a unique named fixture with ordered overlays is accepted; invalid entries are rejected.

### packages/experimental/webworker-runtime/tests/log-sink.spec.ts
- The log sink is exercised rather than trusted: "a diagnostic that runs nothing is a diagnostic that silently stops working" (log-sink.spec.ts:8-9).

### packages/experimental/webworker-runtime/tests/node/assert-strict.spec.ts
- Strict assertions through the image loader: truthy accepted, falsy rejected with the assertion fields.

### packages/experimental/webworker-runtime/tests/node/builtins-table.spec.ts
- Module identity: both consumers of the table must land on ONE module instance per specifier, because "class identity is what depends on it: `instanceof EventEmitter` and `Buffer.isBuffer` compare against a specific copy" (builtins-table.spec.ts:6-8).

### packages/experimental/webworker-runtime/tests/node/child-process.spec.ts
- `node:child_process` over the in-worker shell, plus the *real* local subprocess service running unmodified against it — "the bash tool walks this same ladder in the browser" (child-process.spec.ts:3-5).

### packages/experimental/webworker-runtime/tests/node/chokidar.spec.ts
- Upstream Chokidar running unchanged through the shipped worker module loader.

### packages/experimental/webworker-runtime/tests/node/crypto-globals.spec.ts
- The crypto global patch and the shim UUID: RFC 9562 v4 shape, uniqueness, and the platform method left untouched.

### packages/experimental/webworker-runtime/tests/node/events.spec.ts
- The EventEmitter's dispatch semantics: the boolean `emit`, the point at which `once` unregisters, and the listener set an in-flight emit dispatches to.

### packages/experimental/webworker-runtime/tests/node/fs-watch-context.spec.ts
- A watcher callback reads the async context of the *watcher*, never of the writing code. HMR depends on it.

### packages/experimental/webworker-runtime/tests/node/fs-watch-stream.spec.ts
- Node differential checks of the watcher and the file-stream faces.

### packages/experimental/webworker-runtime/tests/node/fs.spec.ts
- The fs bridge over a real `MemoryVfs`: encoding branches, `Dirent`, descriptors, `FileHandle` append/replace semantics and Node's error codes.

### packages/experimental/webworker-runtime/tests/node/http-server.spec.ts
- The `node:http` seam: `listen` reports success and the request listener is captured. Both failure modes look like a hang rather than a fault, which is why they are pinned.

### packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts
- Every replaced symbol must be *present* (a missing CommonJS export degrades to `undefined`) and every symbol the worker cannot honour must refuse *while naming itself*. The member lists are the tables the modules are checked against.

### packages/experimental/webworker-runtime/tests/node/path-diff.spec.ts
- A differential check of the POSIX path shim against Node's `path.posix` — Node itself is the oracle, over ~200 VFS-shaped cases.

### packages/experimental/webworker-runtime/tests/node/process-shim.spec.ts
- The process shim: the layout-derived environment and the `getBuiltinModule` face, which must answer the loader's proxies for builtin ids and undefined for everything else.

### packages/experimental/webworker-runtime/tests/node/require-builtin.spec.ts
- The internal-module channel: the ids the vendored Loader, app-boot and HMR reach, backed by the worker loader, and Node's platform code for the rest.

### packages/experimental/webworker-runtime/tests/node/sandbox-stack.spec.ts
- The unchanged sandbox-local → bash-sandbox → subprocess stack running over the worker Node layer, with `process.kill` redirected to the worker's process table.

### packages/experimental/webworker-runtime/tests/node/shim-diff.spec.ts
- A differential check of the crypto, url and util shims against Node.

### packages/experimental/webworker-runtime/tests/node/timers-promises.spec.ts
- The abort paths: "a wait that only subscribes runs its full delay before answering, which is a cancelled operation that still costs its timeout" — the delays are a minute long on purpose, so a case that waited would fail by timing out rather than pass slowly.

### packages/experimental/webworker-runtime/tests/polyfill/als-runtime.spec.ts
- The ordering contract of the suspension runtime, checked with a recording double: `pause` captures *before* suspending, `resume` restores *before* returning or rethrowing, and both completion paths do it, which is why the token always fulfills.

### packages/experimental/webworker-runtime/tests/polyfill/als-shim.spec.ts
- The three mechanisms that answer `getStore()` picked apart deliberately: the folding stack, the hook layer, and the explicit switch. The explicit switch "is the layer that survives true interleaving, and case 17 is the one that shows the folding stack alone cannot" (als-shim.spec.ts:12-17).

### packages/experimental/webworker-runtime/tests/polyfill/als.spec.ts
- Sync-stack `AsyncLocalStorage` semantics plus the causality faces the loader's `await` rewriting consumes, including the context root the tunnel dispatches at.

### packages/experimental/webworker-runtime/tests/shell/injected-run.spec.ts
- The two injected run options a command in a process worker supplies. No VFS is mounted on purpose: "a program that reached [the process-wide slot] instead of the injected face fails with `no filesystem is mounted` — a suite that mounted a VFS as well would pass either way" (injected-run.spec.ts:10-12).

### packages/experimental/webworker-runtime/tests/shell/shell-process.spec.ts
- The process model with a loopback `Worker` that runs the real child half against the real host half; only the thread boundary is simulated.

### packages/experimental/webworker-runtime/tests/shell/shell.spec.ts
- The in-worker shell: pipelines, chaining, subshells, redirections and expansion, against a real `MemoryVfs`.

### packages/experimental/webworker-runtime/tests/shell/xdg-open.spec.ts
- `xdg-open` hands a VFS file to the page viewer and reports the documented exit statuses.

### packages/experimental/webworker-runtime/tests/storage/image-gzip.spec.ts
- The gzip envelope refuses a non-member body by name, including the case where the two identification bytes arrive one at a time.

### packages/experimental/webworker-runtime/tests/storage/lazy-archive.spec.ts
- Lazy archives: one fetch shared by every waiting reader, synchronous readers refused by name, and a failed fetch that leaves the files registered so a later read retries.

### packages/experimental/webworker-runtime/tests/storage/memory-vfs.spec.ts
- The identity, timestamp, link, mutation and durability-sink guarantees, asserted directly rather than through the fs bridge. The timestamp cases freeze the clock, "because these writes are in memory and two revisions routinely land in the same millisecond — a real-clock test passes whether or not the strict increment exists" (memory-vfs.spec.ts:9-11).

### packages/experimental/webworker-runtime/tests/storage/tar.spec.ts
- A byte-faithful roundtrip through `packTar`/`parseTar` plus the VFS mount of that archive.

### packages/experimental/webworker-runtime/tests/transport/frames.spec.ts
- Inbound frame validation, including the init frame's retained overlay order.

### packages/experimental/webworker-runtime/tests/transport/tunnel-client.spec.ts
- The page half against hand-fed frames. The refusal warnings are the reason the suite exists, and the text is matched verbatim on purpose: "the worker composes it from the expanded cause chain, so both sides hold each other to it" (tunnel-client.spec.ts:9-12).

### packages/experimental/webworker-runtime/tests/transport/tunnel-server.spec.ts
- The worker end: the dispatch lanes, the boot queue and the stream frames.

### packages/experimental/webworker-runtime/tests/vfs-example-fixture.spec.ts
- Acceptance checks of the bundled fixture: session discovery, the schedule rows, the projection cache and the subagent catalog, read through the *production* readers.

### packages/experimental/webworker-runtime/tests/vfs-example-fixture.ts
- The 581-line generator for the deterministic fixture tree: the three Session logs, the schedule and projection stores, and the workspace files. Read lines 1-90.

### packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--/preview-architecture-review/session.v2.jsonl
- The committed Session log in format **v2** for the one-shot subagent (`origin: subagent`, `delegationDepth: 1`, `parentSession: preview-showcase`). Read the header line and the first rows; the rest is the authored 28-turn history.

### packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--/preview-architecture-review/session.v3.jsonl
- The same subagent log in format **v3**; the packer picks this as the newest canonical generation and prepares a v4 successor.

### packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--/preview-follow-up-builder/session.v2.jsonl
- The continuable subagent's log in format v2 (`isSeeded: false`).

### packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--/preview-follow-up-builder/session.v3.jsonl
- The continuable subagent's log in format v3.

### packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--/preview-showcase/session.v2.jsonl
- The root showcase Session's log in format v2.

### packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--/preview-showcase/session.v3.jsonl
- The root showcase Session's log in format v3.

### packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--/preview-showcase/session.v4.jsonl
- The root showcase Session's log in the current format v4 — the generation the packer leaves alone because it is already current.

### packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/storages/schedule.json
- The seeded schedule storage: one daily digest task with a delivery history.

### packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/storages/session_projcache.json
- The seeded projection cache: the showcase session's identity (format version 4) and its title row.

### packages/experimental/webworker-runtime/tests/fixtures/vfs-example/workspace/.agents/skills/preview-tour/SKILL.md
- A skill file with frontmatter, present to prove dot directories survive image packing.

### packages/experimental/webworker-runtime/tests/fixtures/vfs-example/workspace/data/tasks.json
- The workspace checklist mirroring the completed preview tasks.

### packages/experimental/webworker-runtime/tests/fixtures/vfs-example/workspace/PREVIEW.md
- The workspace guide naming the three files the preview tour touches.

### packages/experimental/webworker-runtime/tests/fixtures/vfs-example/workspace/src/preview.ts
- The source file the example write result changes; exports `previewStatus` and `previewFeatures`.

## Ideas worth stealing

- **A pack-time transform that preserves line numbers, and a loader that refuses an untransformed body** — `packages/experimental/webworker-runtime/src/compile/transform.ts:110` and `packages/experimental/webworker-runtime/src/module-system/module-loader.ts:406`. The transform edits the *original text* by interval and pads each edit with the newlines the replaced range held, so a stack frame in the transformed module points at the same line as the built artifact. The loader then carries no compiler at all: module syntax reaching `new Function` produces "still carries module syntax, so the image was not lowered by the packer; rebuild the image". August could use the same shape for any build-time source rewrite: do it once, at build time, and make the runtime refuse anything that was not rewritten. The interval-padding arithmetic (original newlines minus re-emitted newlines) is the part that is easy to get wrong and worth copying verbatim.
- **Async-context continuity across an `await` without any platform support** — `packages/experimental/webworker-runtime/src/compile/transform.ts:242` (the rewrite) and `packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/async_hooks.ts:146` (the slot order). The transform rewrites `await X` into `__als.resume(await __als.pause(X))`, where `pause` snapshots every ambient store *before* suspending into a token that always fulfils, and `resume` restores the snapshot *before* returning or rethrowing. Three fallback slots answer `getStore()` (hook overlay → resumed context → boundary ambient → folding stack) and every slot is removed **by identity**, never by a blind pop, because boundaries settle out of order. August's per-session state (the current turn, the agent, the tool scope) is exactly this shape, and the "removed by identity" rule is the part a hand-rolled implementation gets wrong.
- **A reachability sweep that reuses the runtime's own resolver** — `packages/experimental/webworker-packer/src/pack.ts:378` and `packages/experimental/webworker-packer/src/pack.ts:442`. The packer builds a `WorkerModuleLoader` over the candidate file set and walks it, so "pack-time reachability and boot-time resolution cannot drift". The failure policy is the interesting half: an unresolvable request from *our own* package fails the build, while a third-party one is tolerated and "fails loud at require time". That asymmetry is directly transferable to August: a missing dependency in your own code should fail the build, a missing optional dependency in a vendored library should not.
- **A content-addressed lazy chunk archive with a deferred-filesystem contract** — `packages/experimental/webworker-packer/src/pack.ts:618` and `packages/experimental/webworker-runtime/src/storage/memory.ts:382`. A page chunk that is only reached through `require.async("./client.x.js")` leaves the base image and becomes `lazy/<sha256>.tar.gz`. The manifest registers the path and size; the VFS answers existence, stat and listing immediately, and the first *asynchronous* read fetches and inflates the archive once for every waiting reader. Before that, a synchronous read of a registered file fails with `ERR_DSH_VFS_DEFERRED` naming the archive — an explicit refusal rather than a silent empty file. August could use the same "register the path, fetch the body on first async read, refuse the sync read by name" pattern for any large artifact.
- **Deterministic archives: two header bytes decide whether the same tree packs to the same bytes** — `packages/experimental/webworker-packer/src/pack.ts:655`. zlib writes the operating-system byte from the platform it was built for, which would make the same tree pack differently on Linux and macOS; the byte is overwritten with 255 ("unknown"). The packer also appends a `//# sourceURL=` line naming each entry's *repository* path, after stripping any dangling `sourceMappingURL` — otherwise a named script reports one load failure per file in the debugger. Two bytes and one trailing line, and the artifact stops depending on where it was packed.
- **A diagnostic that runs nothing is a diagnostic that silently stops working** — `packages/experimental/webworker-runtime/src/worker-host.ts:311`. Cordis's logger always accepts messages but, with no exporter mounted, only fills a ring buffer, so a provider that failed and was skipped looked identical to one that found nothing — "which is how an empty skill catalog hid a filesystem fault twice". The fix is a two-line exporter with an explicit level (2, because cordis's default silently drops *warnings*), and the test that exercises it (`tests/log-sink.spec.ts`). August has the same failure mode in every plugin that logs and swallows; the transferable piece is the *exporter level*, which has to be set explicitly.
- **A refusal that names itself, written to the console before it propagates** — `packages/experimental/webworker-runtime/src/node/notImplementedFail.ts:28`. Every structurally-stubbed symbol throws an error carrying Node's `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` code, and the message is printed to the console *first*, because "callers routinely swallow these errors far from their cause". August's stubs (a missing tool, an unavailable provider) should do the same: the code lets a caller distinguish "not on this platform" from "broken", and the console line places the failure in the session.
- **A table row that keeps its identity across a rebuild, and a filter that keeps the ancestors of a match** — `packages/experimental/session-inspector/src/client/views/session-log/model.ts:138` and `packages/experimental/session-inspector/src/client/views/type-filter.ts:48`. The log model reuses the previously published row *objects* when the window change is an append (`revision === previous + 1 && change.kind === 'append'`), so the table does not rebuild; any other change rebuilds the hierarchy but keeps the keyed record sources. The filter retains matching rows *and their ancestors*, and re-opens an ancestor that became a branch of a match, so a matching descendant of a folded block is still reachable. Both are small, general rules for any "live log + filter" table.
- **A reveal that finds the nearest thing rather than failing** — `packages/experimental/session-inspector/src/client/views/chat-node/reveal-target.ts:74` and `packages/experimental/session-inspector/src/client/views/chat-node/reveal.ts:63`. The target is resolved to an *ordered* candidate list — tool identity, exact anchor, node kind, nearest by event distance — and the DOM lookup then tries each in turn, falling back to the visible Chat column when no candidate has a rendered box. The user is never told "not found"; the tool shows the closest thing and the ranking is explicit in the code.
- **A route lane and a direct lane with a 401/403 retry, decided at the first frame** — `packages/experimental/webworker-runtime/src/transport/tunnel.ts:460`. The tunnel sends every unary `/api` call through the *real* route table (keeping its trust fences, byte limits and status semantics) and, if that lane answers 401 or 403, retries on a direct entry — because the page owns the worker and needs no network authentication. The decision is made at the first response frame, before anything reaches the page, using a `BufferedSink` that records frames so a refusal's body can be discarded. The same "keep the fences, then degrade to a privileged lane" shape fits a desktop app that talks to a local service.
- **A bootstrap that is split in two so requests during boot queue instead of being dropped** — `packages/experimental/webworker-runtime/src/worker-host.ts:12` and `packages/experimental/webworker-runtime/src/transport/tunnel.ts:290`. `createWorkerHost` is synchronous and returns a handle whose `handleMessage` is ready immediately; `start` then mounts the image, installs the loader and boots the tree. The tunnel queues every frame until `serve(seams)` and refuses the whole queue with 503 on a boot failure. August's "the app is starting" window has the same race, and this is a complete answer to it.
- **A `node:path` port and a normalizing path helper that must not be merged** — `packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/path.ts:4` and `packages/experimental/webworker-runtime/src/module-system/posix-path.ts:8`. Two path utilities in one package that answer differently on 45 of ~200 cases, because the normalizing one is used for VFS keying and the literal one must match Node for code that reads Node's answers. The comment says so explicitly, and a differential test pins the Node-facing one. August should look for its own accidental duplicate-helper pair and write the divergence down.
- **A strictly-increasing modification time as a stale-write guard** — `packages/experimental/webworker-runtime/src/storage/memory.ts:603`. Two revisions of one in-memory file routinely land in the same millisecond, so the VFS returns `max(now, previous + 1)`. The filesystem service builds its version token from `dev:ino:size:mtimeNs:ctimeNs` and refuses a write whose token moved since it read, so an equal timestamp would let a stale overwrite through. The test freezes the clock, because a real-clock test passes whether or not the increment exists.

## Files skipped (with reasons)

None. Every file in the shard was opened. Seven files were read in part rather than line by line, and each is marked in the ledger: the two READMEs' Chinese counterparts beyond the first 40–46 lines, `src/node/builtin_modules/implemented/fs-watch.ts` (first 90 of 439 lines), `fs.ts` (lines 1–200 and 700–907 of 907), `path.ts` (first 120 of 425), `util.ts` (all 183), `interpret.ts` (first 140 of 389), `expand.ts` (first 90 of 228), `programs/files.ts` (first 80 of 293), `programs/text.ts` (first 70 of 363), `storage/types.ts` (first 120 of 292), `tests/vfs-example-fixture.ts` (first 90 of 581), `tests/compile/transform.spec.ts` (header and imports), and the seven `session.*.jsonl` fixtures (header line and the first two rows of each). The seven JSONL fixtures are committed test data, not generated artifacts: each begins with a `{"type":"session","version":N,...}` header and continues with one JSON event per line, and the sizes (1.8 kB–60 kB) are the authored history, so they were identified by their headers rather than read to the end.

## Uncertainties

- **The `webworker-runtime` READMEs are the only description of the runtime's design that I could not fully read line by line** (README.md was read in full; README.zh.md only to line 40 of 84). I relied on the English README and the source for the Chinese half.
- **`tests/compile/transform.spec.ts` (33 kB) and `tests/vfs-example-fixture.ts` (21 kB) were read to their headers and imports only.** Their file-level docstrings state their purpose and their scope boundary in full, and the individual test names were not enumerated; a specific assertion inside either file may exist that I did not see.
- **The seven `session.*.jsonl` fixtures were read to their headers and first rows.** I know their format version, session id, parent link, `origin` and `delegationDepth` from the header, and I know from `vfs-example-fixture.ts` that they are 28 authored turns of history, but I did not read the event bodies. The claim that `preview-architecture-review` is a one-shot subagent and `preview-follow-up-builder` a continuable one comes from the headers (`isSeeded` true/false) and from the fixture generator's constant names, not from reading the history.
- **`src/node/builtin_modules/implemented/fs-watch.ts`**: I read the first 90 of 439 lines, which cover the options, the missing-stats shape and the async-context rule, but not the polling/watch implementation itself. The `fs-watch-context.spec.ts` and `fs-watch-stream.spec.ts` headers describe the rest.
- **Whether `apps/web/tests/preview-boot.e2e.ts` — the acceptance test the runtime README points at — exists in this form**: it is referenced by `packages/experimental/webworker-runtime/README.md:36` and `packages/experimental/webworker-packer/README.md`, but it is **not** in this shard (it belongs to `apps/web`), so I could not check it.
- **The `inspector` and `inspector-profile` packages** that the session-inspector README names as its mount point ("The Developer Tools bundle mounts this plugin as `session-inspector`") are in `packages/experimental/` but are owned by other shards; I read only the sentence in the README that names the mount, so I could not verify the mount configuration itself.
- **`packages/experimental/webworker-runtime/src/shell/programs/files.ts` and `text.ts`**: I read the first 80 and 70 lines respectively, so the complete list of coreutils the command table offers is taken from `programs/index.ts`'s docstring ("the command table holds coreutils only") and from the partial file, not from an exhaustive read.
- **Nothing was executed.** Every statement about behaviour comes from the code and its comments, not from a run; the repo is untrusted and read-only for this pass.
