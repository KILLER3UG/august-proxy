# deepseek-harness / dsh-client-sidebar#3

## Shard shape

This shard is three sibling browser-plugin packages under `packages/client/`, all of them
**model-facing-free UI surfaces** for the DSH web client: `ui-sidebar-right` (the right
sidebar's docking surface, its tab-type registry, its navigation controller `ctx.sidebarRight`
and its per-tab "Tab domain"), `ui-sidebar-terminal` (an xterm-backed shell tab type that
registers into that sidebar), and `ui-workspace` (the workspace/session browser in the left
sidebar plus the workspace picker in the conversation empty state, with the Session row-action
extension seats and the `ctx.uiWorkspace` navigation service). They fit together as one
composition: `ui-workspace` and `ui-sidebar-terminal` are *consumers* of the extension seams
that `ui-sidebar-right` declares (a keyed tab-body seat, a tab-title seat, a guide chain, a
menu-item list), and `ui-workspace` additionally declares its own row-action lists that other
client plugins extend. The shared architectural vocabulary is the *slot* framework
(`ctx.slots.register` / `ctx.slots.inject`): every surface here is registered into a named
seat with a scope, a key, an `order`, and an `inject` face, and every plugin tears its
contributions down with its own lifetime. There is no agent loop, no provider call, no
compaction and no model memory anywhere in this shard — all three READMEs say so explicitly
under "Model Experience / KV Cache effect: None". The value of the shard is therefore
**client-side harness discipline**: how a UI surface models identity, lifetime, stale-capture,
persistence, ordering, and the seam between shipped behaviour and plugin contribution.

---

## Per-file notes

### packages/client/ui-sidebar-right/package.json
- Purpose: package manifest for the right-sidebar client plugin (`@deepseek-ai/dsh-client-ui-sidebar-right`, v0.2.1-rc.2).
- Key abstractions: `dsh.client.inject` lists the six services the browser half requires — session-controller, resources, ui-conversation, ui-layout, ui-session, shortcuts — and declares `platform: web`.
- Data flow: none; the manifest only advertises the plugin to the host loader.
- Non-obvious design decisions: `exports` publishes a separate `./client` entry so the browser half never reaches the host half; `files` ships `lib/index.js` + `lib/client.js` + type declarations only.
- Edge cases / failure handling: n/a.
- Surprising: `peerDependencies` lists only `cordis`; every real dependency is a devDependency, because the client bundle is composed at the host.

### packages/client/ui-sidebar-right/locale/en.json
- One specific line: 5-line package-locale metadata file (`meta.title: "ui-sidebar-right"`) — it carries no copy, because the copy lives in `src/client/locales.ts`.

### packages/client/ui-sidebar-right/locale/zh.json
- One specific line: same metadata file with the Chinese title "右侧面板" and a one-line description of the package's role.

### packages/client/ui-sidebar-right/README.i18n.yaml
- One specific line: per-heading bilingual-pair hash record (en/zh hex digests for 17 sections) used by `pnpm run verify-translation-pairing --write` to detect an English/Chinese README drift.

### packages/client/ui-sidebar-right/README.md
- Purpose: the package reference — presentations, state, extension seats, `ctx.sidebarRight`, the Tab domain, the guide, copy, and known limitations.
- Key abstractions: the README is the *contract* doc; it states the two-pane budget, the page-uniqueness rule, the "one history entry per intent" rule, and the "title fixed at open time" limit.
- Data flow: describes `openResource`/`openTab` → registry claim → store intent → Tab-domain navigation record → body render.
- Non-obvious design decisions: it documents that `_undo()`/`_redo()` are `@internal` (tests only) and that layout persistence keeps undo in memory only.
- Edge cases / failure handling: documents the "an address outside `dsh-resource://`, one no type claims, or a kind nothing registered throws — that is a wiring mistake, not a user error" rule.
- Surprising: the README's "Model Experience / KV Cache effect" sections are explicitly "None" — a deliberate contract that a UI plugin assembles no provider request.

### packages/client/ui-sidebar-right/README.zh.md
- One specific line: the Chinese counterpart of README.md with the same 17 anchored sections; I read the first 60 lines and confirmed the structure and content parity (presentations, expand button, state).

### packages/client/ui-sidebar-right/src/index.ts
- One specific line: 4-line host half — `apply()` is deliberately empty because "the whole Sidebar lives in the browser export".

### packages/client/ui-sidebar-right/src/css-modules.d.ts
- One specific line: 6-line ambient declaration for `*.module.css` and `*.css` shared by the three packages in this shard (identical file in all three).

### packages/client/ui-sidebar-right/tsconfig.json
- One specific line: extends `tsconfig.base.client.json`, `rootDir: src`, and lists 12 project references (cordis vendor, session-controller, session, resources, store, ui-conversation, ui-dockkit, ui-layout, ui-primitives, ui-renderer, ui-session, ui-slots, shortcuts, brand).

### packages/client/ui-sidebar-right/tsdown.config.ts
- One specific line: 3-line bundler config calling the shared `clientBundle(dir, ['lib/types/index.js'])` helper.

### packages/client/ui-sidebar-right/src/client/contract/params.ts
- Purpose: the typed parameter contract for navigation — what a resource type and a page type may be opened *with*.
- Key abstractions: two declaration-merged maps (`SidebarRightResourceParamsMap` keyed by resource type, `SidebarRightTabParamsMap` keyed by tab kind) plus the derived unions `SidebarRightResourceParams`, `SidebarRightTabParamsFor<K>`, `SidebarRightNavigationParams`.
- Data flow: a caller merges its entry into a map; `openResource(address, { params })` is typed against it and the value rides `navigation.params` to the body.
- Non-obvious design decisions: the unions are spelled as `ValuesOf<{declared: …; none: undefined}>` rather than `A | B`, because in a program where no package has augmented a map, `A | B` resolves to `undefined | undefined` and the type-aware lint reads it as a duplicated constituent. Values are "JSON-shaped by convention; nothing validates them at run time, because caller and body meet at a typed same-process boundary".
- Edge cases / failure handling: none by design — the boundary is type-level, not runtime.
- Surprising: an empty interface is the extension point; the map starts empty on purpose.

### packages/client/ui-sidebar-right/src/client/contract/seed.ts
- Purpose: the guide tab's identity, the page-address scheme, and default-page selection.
- Key abstractions: `SidebarRightSeed { kind, title }`, `GUIDE_KIND = 'guide'`, `pageAddress(kind) → 'sidebar://<kind>'`, and `defaultSeed(tabs)`.
- Data flow: the store asks `defaultSeed(tabs)` whenever it needs to mint a page tab; the registry answers with the definition in force.
- Non-obvious design decisions: the scheme `sidebar://` is "this package's bookkeeping for `openTab`, spelled here and nowhere else; a caller names the kind and never sees or composes the address". The default page depends on the number of registered *guide entries*, not the number of tab types: exactly one entry opens its page directly, zero or multiple open the guide.
- Edge cases / failure handling: `defaultSeed` throws `sidebarRight: default tab kind "guide" is not registered` when the kind is absent — a wiring error, not a user error.
- Surprising: the guide is not special in the machinery; it goes through the same two-stage registration as any external type.

### packages/client/ui-sidebar-right/src/client/contract/slots.ts
- Purpose: declares the right sidebar's four extension seats and the copy namespace.
- Key abstractions: `rightbar.session` (single, session scope, with a `retainTab(tabId, signal)` owner share), `sidebar.right.pane.tab` (keyed by the *type definition's* `id`), `sidebar.right.pane.tab.title` (keyed), `sidebar.right.tab.guide` (chain), `sidebar.right.tab.guide.entry` (keyed), `sidebar.right.tab.menu.item` (list).
- Data flow: a type registers its body under the keyed seat with `entryKey: definition.id`; the seat dispatches with a `hookContext` (`TabHookContext`) carrying `tabId`, `signal`, `actions`, `useStore`, `useTabNavigation`, `shortcuts`, `title`, `fullscreen`, `active`.
- Non-obvious design decisions: "the key domain stays the open string space because a tab type may ship from outside this repository"; the guide is a *chain* because "the replacement decides for itself whether it applies, and the shipped guide is the owner's fallback" — so the shipped body is never outvoted by accident. The types live with their declarer ("TYPE HOME RATIONALE").
- Edge cases / failure handling: a kind with no type in force renders the owner's "nothing can view this" notice rather than an empty pane.
- Surprising: `rightbar.session`'s owner share carries `retainTab` — a *lifetime hold* the body releases, which is how `keepMounted` bodies survive Session switches.

### packages/client/ui-sidebar-right/src/client/tab-registry.ts
- Purpose: stage one of tab-type registration — what a type IS, and which type opens an address.
- Key abstractions: `SidebarRightTabDefinition` (static: `id`, `kind`, `patterns`, `priority`, `canOpen`, `title`, `guide`, `multiple`, `keepMounted`), `SidebarRightTabPriority = 'extension' | 'builtin' | 'fallback'`, `SidebarRightTabClaim`, and the class `SidebarRightTabRegistry`.
- Data flow: `register(def)` compiles each glob into a matcher; `candidates(address)` ranks; `claim(address, kind?)` settles on one type and returns `{kind, contentId: address, title}`.
- Non-obvious design decisions: (1) the resolver follows VS Code's editor resolver — glob narrows, `canOpen` vetoes, survivors rank by band → matched-pattern length → registration order. (2) A pattern containing `:` matches the *whole address*; one without matches the URI path at any depth (`basename: true`), and a non-URI address matches no path pattern. (3) `id` is the implementation identity (a kind is not unique because an extension may take a builtin's over), and the `id` is also the key the body registers under — so the extension and the builtin hold distinct cells. (4) A kind may carry one `builtin` + one `extension`; the extension is in force and the builtin resumes when it leaves; anything else colliding throws. (5) The priority bands are *string literals* so a type shipped from another package needs no runtime import from here. (6) `DEFAULT_BAND = 'extension'` — a type that says nothing is one from outside the product.
- Edge cases / failure handling: duplicate guide-entry ids inside one type throw; a second registration of an `id` throws; a second registration in the same band throws; a `fallback` may not share a kind with anything.
- Surprising: `picomatch/posix` is imported deliberately — "the browser bundle must not reach for node's `path`, and addresses are `/`-separated regardless of the host platform".

### packages/client/ui-sidebar-right/src/client/labels.ts
- Purpose: projects the product dictionary into the docking kit's label contract — "the kit renders no string of its own".
- Key abstractions: `dockLabels(t, split?, close?) → DockLabels` covering empty-pane, split, close-tab, add-tab, dock/float and the five drop-zone strings.
- Data flow: called during render, so a language change reaches the kit with the next render ("the kit caches no copy to invalidate").
- Non-obvious design decisions: the shortcut labels are passed *in* rather than read, so the kit shows the *effective* binding; `t('dock.splitPaneDisabled')` and `t('dock.splitPaneNarrow')` are the kit's own disabled reasons.
- Edge cases / failure handling: n/a.
- Surprising: this is the whole i18n surface of a third-party kit — the kit stays host-agnostic by rendering zero strings.

### packages/client/ui-sidebar-right/src/client/locales.ts
- Purpose: the `sidebarRight` namespace dictionaries.
- Key abstractions: `zh` is the key-set source of truth (`satisfies Record<string, string>`), `SidebarRightKey = keyof typeof zh`, and `en` is checked against it (`satisfies Record<SidebarRightKey, string>`).
- Data flow: `ctx.locale.register(NS, { zh, en })` in `apply`.
- Non-obvious design decisions: the key set includes the *failure reasons* the shortcut resolver returns (`command.budget`, `command.width`, `command.stale`, `command.float`) so a blocked command and a disabled button say the same word.
- Edge cases / failure handling: n/a — copy only.
- Surprising: `command.width` = "Not enough width to split, widen the sidebar" and `dock.splitPaneNarrow` repeat it; the disabled reason and the command refusal share a string.

### packages/client/ui-sidebar-right/src/client/persistence.ts
- Purpose: validated per-Session layout snapshots in `localStorage` under `dsh.sidebar-right.v1.<sessionId>`.
- Key abstractions: a zod schema for the layout (nodes / tabs / rootId / floats / activePaneId / expanded / mode) and `validateReferences()` — a *graph* validation, not just a shape check.
- Data flow: `writeSidebarLayout(sessionId, surface)` on every store commit; `readSidebarLayout(sessionId)` on store creation; `clearSidebarLayout(sessionId)` when the saved data is invalid.
- Non-obvious design decisions: `validateReferences` walks the tree and rejects a layout whose node ids do not match their keys, whose numeric id exceeds the minted counter ("reused future identity"), whose split is not the root / is vertical / has 3 children / has sizes that do not sum to 1, whose floats hold a split, whose tab is referenced twice, or whose `activePaneId` is not a pane. Undo history is deliberately *not* persisted (`history: EMPTY_HISTORY` on restore) — "undo history belongs to the live window".
- Edge cases / failure handling: an invalid save clears only its own Session key and leaves the in-memory surface usable; storage failures are swallowed on read and logged on write.
- Surprising: a whole family of invalid shapes is enumerated in `tests/persistence-validation.client.spec.ts` as a table — the validation is treated as a contract with a fixture list, not as incidental code.

### packages/client/ui-sidebar-right/src/client/stores.ts
- Purpose: the store shell over the docking kit — one `SurfaceState` per session (layout + history + minted counter).
- Key abstractions: `createSidebarRightStore(seed)` returning an `EngineStoreHandle`; the action set (`openContent`, `setExpanded`, `toggleExpanded`, `setMode`, `splitPane`, `duplicateTab`, `closeTab`, `focusTab`, `focusPane`, `placeTab`, `dropTab`, `floatTab`, `unfloatPane`, `moveFloat`, `resizeFloat`, `resizeSplit`, `undo`, `redo`); `canCloseTab(surface, tabId)`; `soleDockedTab`.
- Data flow: every action mints ids → asks a kit planner for ops → replays them onto a scratch copy → runs the settle planner → records ONE history entry → assigns the whole surface back. The store never edits a layout in place.
- Non-obvious design decisions: (1) `advance()` replays the planned ops onto a scratch copy *before* settling, because "the settle planner reads the state the intent produces" — and the settle seed factory is withheld while the column is collapsed, so "an empty collapsed column stays empty until the expansion that would otherwise show it". (2) A focus that changes nothing plans nothing and records nothing (`planFocusTab` returns `[]`). (3) A *page* is unique per pane, not per surface: `arriving()` merges an arriving page into the pane's own page. (4) Carrying the mint counter in the surface is what makes a recorded sequence replayable. (5) Closing the last non-guide docked tab closes the column *and* leaves fullscreen in the same entry, because "the reopened column shows only the reseeded default page, which never earns the whole window".
- Edge cases / failure handling: a tab already gone (racing callback vs user) is left alone rather than handed to the kit, which refuses an unknown tab; splitting an empty pane does nothing and reports no new pane; vertical drops are refused.
- Surprising: the guide standing alone is the only tab that cannot be closed — a programmatic close of it records nothing, and the *programmatic* path (not just the UI) enforces it.

### packages/client/ui-sidebar-right/src/client/tab-domain.ts
- Purpose: "what a tab record carries that the layout does not" — one `TabOccurrence` per open (session, tab id).
- Key abstractions: `TabOccurrence { commands, id, sessionId, tabId, signal, navigation, tabActions }`; `TabDomain` with `sync`, `navigate`, `occurrence`, `dispose`; `PinResource = (address, signal) => void`.
- Data flow: `sync(sessionId, layout)` reconciles the committed layout against the occurrences — a vanished record is aborted and dropped, a new one is created and pinned once with the occurrence's signal. `navigate(sessionId, tabId, {address, params})` records where the tab was opened and steps `revision`.
- Non-obvious design decisions: (1) holding a record *pins its address* in the resource model, so switching tabs unmounts a body without dropping its content. (2) `revision` increments on every navigation "whether or not `params` changed, so a body can act on 'navigated again' alone" — a navigation is therefore a *store update* with no layout commit. (3) An undone close produces a NEW occurrence (new id, new signal, re-pinned) rather than reviving the old one. (4) The occurrence's `place()` helper reads the pane at call time, "because the tab may have been dragged since".
- Edge cases / failure handling: `occurrence()` throws for an uncommitted record and "never creates it during a read"; `dispose()` aborts every occurrence of every session (plugin unload).
- Surprising: `bindCommands` releases only if the *same* commands object is still registered ("a disposer that cannot remove a newer body's registration") — a re-bind-safe lifetime token.

### packages/client/ui-sidebar-right/src/client/service.ts
- Purpose: the outward face `ctx.sidebarRight` — the navigation controller every other plugin calls.
- Key abstractions: `ISidebarRight` (`openResource`, `openTab`, `close`, `active`, `isExpanded`, `toggleExpanded`, `focus`, `split`, `float`, `dock`, `mounted`); `SidebarRightController`; `createSidebarRightController(...)` returning `{controller, adopt, forget, show, measure}`; `SidebarRightHost` (the viewport rule and focus continuity).
- Data flow: `openResource(address, options)` → registry claim → one store intent (`actions.openContent`) → the store settles → the Tab domain records the navigation → the body re-renders. `openTab(kind, options)` composes the address `sidebar://<kind>` (plus a UUID when the type is `multiple`).
- Non-obvious design decisions: (1) The service is *root-scoped* but the surface is *per session*; the plugin adopts each session's store as the runtime mints it, so "the controller reaches any session's store by id and syncs the Tab domain from that store's commits, on screen or not". (2) A tab's own actions aim at *its* session, not the on-screen one, so a callback fired after the user switched sessions still lands where its tab is. (3) `splitBlock(target)` returns a localizable discriminator — `'stale' | 'collapsed' | 'float' | 'empty' | 'budget' | 'width'` — so the button's tooltip and the keyboard refusal say the same word. (4) `isTargetCurrent(target)` re-verifies session, pane, tab, occurrence identity and navigation revision before a captured command runs. (5) `mounted` changes *before* React renders the change that causes it, so "a component rendered in that commit reads the arriving Session". (6) The face exposes operations only: "no layout snapshot, no operation log, no lookup by address".
- Edge cases / failure handling: with no Session on screen, or before the runtime mints its store, every *write* throws `sidebarRight: no session surface is mounted` while reads answer `false`/`undefined`; an unclaimed address or an unregistered kind throws (a wiring mistake, not a user error); a close handler that throws preserves the tab.
- Surprising: `preferNewPane` is a *request*, not a command: it asks the target pane to split under the same two-pane and room rules as the split control and falls back to the target pane when no split is available.

### packages/client/ui-sidebar-right/src/client/focus.ts
- Purpose: live DOM ownership for docked and floating sidebar pages.
- Key abstractions: `SidebarRightTarget { sessionId, paneId, host, tabId, occurrence, navigationRevision }`; `sidebarTargetFromElement(element, sessionId, layout, occurrence)`; `visibleSidebarPane(document, sessionId, paneId)`; `observeSidebarFocus(document)`.
- Data flow: a keyboard gesture or pointer press resolves the focused element into a `SidebarRightTarget` by walking the `data-sidebar-right-session` / `data-dockkit-pane` / `data-dockkit-tab` / `data-sidebar-right-occurrence` marker chain, and the marker must match the *live* occurrence id or the capture is rejected as stale.
- Non-obvious design decisions: (1) Focus and pointer activation are kept separate from persisted layout selection. (2) `observeSidebarFocus` uses a `MutationObserver` to notice that the focused element was *removed* and then restores focus to the pane holding the same occurrence — "preserving text selections". (3) A pointer press on a non-interactive area focuses the pane, but a press on a control leaves the control's own focus alone. (4) Focus restoration is cancelled by an outside pointer, a blur, a Session change, or disposal — "an outside pointer gesture or explicit blur cancels this restoration".
- Edge cases / failure handling: a collapsed dock host, a hidden/aria-hidden ancestor, a moved tab, a reopened record, an intervening navigation and a disconnected element all yield `undefined`.
- Surprising: the pane fallback order is "requested pane → the active pane → the first visible pane", and hidden panes and other Sessions are excluded by construction.

### packages/client/ui-sidebar-right/src/client/shell/close-focus.ts
- Purpose: focus continuity after an open/close replaces a pane's DOM.
- Key abstractions: `openWithPaneFocus(document, sessionId, open)` and `closeWithPaneFocus(document, sessionId, paneId, close)`.
- Data flow: `flushSync` runs the operation so the DOM has committed, then `visibleSidebarPane(...).focus({preventScroll: true})` puts focus on the surviving pane.
- Non-obvious design decisions: the close path only restores focus "while no other element owns focus" — it checks `document.activeElement !== document.body && document.activeElement !== before` and bails otherwise, so it never steals an input the user moved to.
- Edge cases / failure handling: a cleanup that throws propagates and leaves focus where it was; a close whose operation selects no pane leaves focus untouched.
- Surprising: `flushSync` is the mechanism — React's commit must have happened before the DOM query, or the focus lands on the element that is about to be replaced.

### packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx
- Purpose: the sidebar's seat in the frame, and the panel it draws.
- Key abstractions: `RightbarSeat` (session-scoped seat), `SidebarPanel`, `PanelChrome`, `intentsFor(sessionId, actions, openTab, closeTab?, splitPane?)` (the kit's gesture face), `SidebarRightPresentation { shown, track, fullscreen }`, `SidebarRightInjected`.
- Data flow: the seat reads the session's surface from the store, reports the composition to the frame via `ctx.layout.openRightbar(track, fullscreen)` / `closeRightbar()`, and dispatches each tab's body/title through the keyed slot with the occurrence's `hookContext`.
- Non-obvious design decisions: (1) There is no panel header — the two controls (presentation switch, collapse) ride the docking kit's chrome seat at the end of the top-right pane's tab strip, "so the strip is the panel's whole top edge". (2) Docked content stays mounted while collapsed and is translated off the frame's right edge, so open/close is one slide in both presentations. (3) Below 768px fullscreen is *derived* from viewport width without changing the recorded manual mode. (4) The frame is not told about the panel until the fullscreen slide finishes: the effect inspects `getAnimations({subtree: true})` for a live `transform` transition and reports only when the panel has covered the frame, and a cancellation (reduced motion) re-resolves rather than reporting. (5) The room rule the kit measures is reported to the service, which applies it when *it* splits — "a reading never re-renders anything".
- Edge cases / failure handling: a late animation completion after close/push/session-change/unmount is ignored (`disposed` guard); a panel that cannot fit collapses without clearing records; the Tab domain is *not* synced here (the controller does that from store commits).
- Surprising: `canAddTab` is only drawn while a pane holds no guide tab, and the add control asks for a guide *in that pane* "without regard to guides in other panes" — the store settles the open idempotently anyway.

### packages/client/ui-sidebar-right/src/client/shell/RightbarRoot.tsx
- Purpose: the root-scoped controller that keeps independent Session subtrees alive while only one is visible.
- Key abstractions: `RightbarRoot` renders one `SessionView` per retained view; `RightbarRootInjected { hooks: { views }, mountView }`.
- Data flow: `views.source` (a snapshot store of `SidebarSessionViewSnapshot[]`) is rendered; each `SessionView` calls `mountView(reference)` in a layout effect, which is the committed-mount lifetime the view's reference release waits on.
- Non-obvious design decisions: the non-selected subtree is `hidden` rather than unmounted — "other subtrees stay hidden without deleting tab state"; the `SessionProvider` is the *only* thing inside the subtree, so the framework Session binding is the target.
- Edge cases / failure handling: n/a.
- Surprising: the root is where the retention policy lives, and it is entirely in `session-views.ts` — the React file is 38 lines.

### packages/client/ui-sidebar-right/src/client/shell/ExpandButton.tsx
- Purpose: the way back into a hidden panel — one button in the conversation header's corner seat.
- Key abstractions: `ExpandButton` reads `useStore(state => state.bySession[sessionId]?.layout.expanded ?? false)` and returns `null` while expanded.
- Data flow: the button shares the panel's per-session store (the slot runtime allows one handle across two same-scope seats) and calls `actions.setExpanded(sessionId, true)`.
- Non-obvious design decisions: the button lives in the *conversation's* header, not in the frame's right column, "so that a collapsed Sidebar costs the conversation nothing — no rail, no width, and the transcript's scrollbar stays at the column's edge". The glyph is the left sidebar's collapse icon mirrored.
- Edge cases / failure handling: a session with no surface yet is treated as collapsed.
- Surprising: the corner seat is its own place "past the utilities' edge", so showing and hiding it moves nothing else in the row.

### packages/client/ui-sidebar-right/src/client/shell/ExpandButton.module.css
- One specific line: 17-line sheet giving the expand button a 28×28 compact footprint and mirroring the icon with `transform: scaleX(-1)` so the divider moves to the right side.

### packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css
- Purpose: the panel's own chrome sheet (the split tree itself belongs to the docking kit).
- Key abstractions: `.panel` (absolute, right-anchored, `overflow: clip`), `.session` (`display: contents` so a hidden session takes no box), `.iconButton`, `.tabBody`, `.tabTitle` (`display: contents`).
- Data flow: the panel's width is set inline as `100vw` or `${width}px` and the CSS custom property `--dsh-sidebar-width` mirrors it; the dock layer's translate uses that variable so the panel's left edge and the conversation's right edge travel together.
- Non-obvious design decisions: `overflow: clip` rather than `hidden` — "Unclipped, they widen the frame's scrollable overflow, and a caret reveal (PageUp in a text field outside macOS) scrolls the `overflow: hidden` frame sideways"; it also does not clip the fixed floating children. Only the *docked* Grid items translate, so "their common ancestor remains untransformed and without a stacking context, so fixed floating children escape". Platform rules keep fullscreen below the Windows caption controls and widen the first pane's strip inset past the macOS traffic lights (88px vs the ordinary 10px).
- Edge cases / failure handling: `prefers-reduced-motion` removes the slide.
- Surprising: the sheet carries a long comment explaining *why* no `no-drag` is applied (Electron drag regions are window geometry, not stacking).

### packages/client/ui-sidebar-right/src/client/tabs/guide/definition.ts
- One specific line: 27-line stage-one registration for the guide — `id: '@deepseek-ai/dsh-client-ui-sidebar-right/guide'`, `kind: 'guide'`, `priority: 'builtin'`, a thunked `title: () => t('tab.guide.title')` and no `patterns` (a page type recognizes no address).

### packages/client/ui-sidebar-right/src/client/tabs/guide/GuideBody.tsx
- Purpose: the guide tab's body — a chain host plus the shipped guide behind it.
- Key abstractions: `GuideBody` renders `renderSlotChain('sidebar.right.tab.guide', {}, {hookContext, fallback})`; `EntryBox`; `ShippedGuide`; `MAX_DESCRIBED_ENTRIES = 4`.
- Data flow: the registry's guide entries arrive through the `guideEntries` observable; each entry is dispatched to `sidebar.right.tab.guide.entry` keyed by `providerId`, and picking one calls `tab.actions.openTab(selected.kind, { replaceTab: true })`.
- Non-obvious design decisions: (1) The shipped guide is the *owner's fallback*, not a chain entry of its own, "so there is always exactly one body and the shipped one cannot be outvoted by accident". (2) The guide has no words of its own — a muted compass over entry capsules, "as a browser start page shows its doors without a caption". (3) While at most four entries are listed a capsule shows its description; a longer list drops *every* description, "so a type must stand on its title". (4) The entry's React key is `JSON.stringify([providerId, id])` so two entries of one type at the same order stay distinct.
- Edge cases / failure handling: a type that registered no icon falls back to the guide's quieter cube placeholder at the same size.
- Surprising: the capsule is a *button* whose whole area opens the type's page in the guide's place — "the guide is a doorway rather than a page that stays open".

### packages/client/ui-sidebar-right/src/client/tabs/guide/GuideTitle.tsx
- One specific line: 57-line file holding the two guide glyphs (`CompassGlyph` — a ring with a north-east needle; `CubeGlyph` — an isometric box) plus `GuideTitle`, which renders the compass before the tab's title text.

### packages/client/ui-sidebar-right/src/client/tabs/guide/GuideBody.module.css
- One specific line: 123-line sheet for the guide body — a centred 380px capsule column with a 14px gap, a 56px watermark-ink compass, a fixed 26px icon box so every capsule's words start at the same left edge, and a 5%-of-pane lift that gives way before a short guide clips.

### packages/client/ui-sidebar-right/src/client/tab-info.ts
- Purpose: the slot-owned hook that composes a tab's live information for bodies, titles and guide replacements.
- Key abstractions: `TabHookContext` (stable dispatch identity + framework hooks, "never passed as tab component props"), `tabInfoFactory`, `guideTabInfoFactory`.
- Data flow: `useTabInfo()` selects the layout from the store, selects the keyed navigation snapshot, and composes `{ sidebar, panel, tab }`; `tab.visible` is `active && (pane.host === 'float' || (layout.expanded && (title || pane.activeTabId === tabId)))`.
- Non-obvious design decisions: the factory "binds a tab occurrence without subscribing or creating records during factory evaluation"; the memo's dependency list is explicit so the hook identity is stable across navigation-only updates; the guide's factory simply forwards the enclosing hook.
- Edge cases / failure handling: a reader whose committed record or navigation binding disagrees throws `sidebarRight: tab "…" is not committed in session "…"` — loudly, rather than rendering a half-populated body.
- Surprising: `visible` distinguishes bodies from titles: "expanded titles include inactive tabs", so a chip can show a live title for a tab whose body is not drawn.

### packages/client/ui-sidebar-right/src/client/tab-inventory.ts
- Purpose: metadata inventory of saved and adopted layouts *without mounting their content*.
- Key abstractions: `SidebarTabInventory` with `source: ObservableSnapshot<readonly SidebarRightOpenTab[]>`; `SidebarRightOpenTab { sessionId, tabId, kind, contentId }`.
- Data flow: the constructor enumerates `localStorage` keys prefixed `dsh.sidebar-right.v1.` and reads each saved layout; `update(sessionId, tabs)` replaces a session's membership from its adopted store; `remove(sessionId)` forgets a permanently cleared scope.
- Non-obvious design decisions: `publish()` compares the JSON serialisation before setting, so an unchanged membership does not churn subscribers; "Startup discovery reads the layout keys without mounting dormant content, pinning files or activating Agents"; "Other windows' storage writes do not overwrite this window's live membership".
- Edge cases / failure handling: a storage that throws during enumeration is caught and the in-memory layouts still publish; a key removed *during* enumeration yields `null` and is skipped.
- Surprising: the inventory's `contentId` is what a provider uses to restore its own resource lifetime — a provider can recover a terminal without the sidebar ever mounting it.

### packages/client/ui-sidebar-right/src/client/session-view.ts
- Purpose: one Sidebar view's Session reference, retained bodies and committed mount lifetime.
- Key abstractions: `SidebarSessionView` with `reference`, `hasRetainedTabs`, `mount()`, `retainTab(tabId, signal)`, `retire()`, `dispose()`.
- Data flow: the view retains its own `SessionReference` (`sessions.retain(sessionId, {source: 'sidebarView'})`); a body calls `retainTab` with its occurrence's signal and releases on unmount.
- Non-obvious design decisions: (1) `mount()` returns a disposer and the reference is released only when a *retired* view's last committed root unmounts — "a View owns its reference until retirement finishes or the Sidebar plugin shuts down". (2) `retainTab` is reference-counted per tab id and idempotent on release. (3) The `signal` abort is the release trigger, so an occurrence that dies (tab closed) releases the hold automatically.
- Edge cases / failure handling: `retire()` on a view with mounts pending defers the release; `dispose()` is idempotent and releases immediately ("plugin shutdown does not wait for remaining React mounts").
- Surprising: the view's `retainTab` is *stable for the View's lifetime*, "independently of Session injection bindings" — so rebuilding the framework's Session bindings does not release a retained body.

### packages/client/ui-sidebar-right/src/client/session-views.ts
- Purpose: selection and retention policy for independently owned Sidebar Session views.
- Key abstractions: `SidebarSessionViews` with `source` (snapshot store), `select(sessionId)`, `mount(reference)`, `dispose()`, and a private `prune(view)`.
- Data flow: `select` creates a view for a newly selected Session and prunes every view afterwards; `prune` keeps a view when it is selected, has retained tabs, or is no longer the current one for its id.
- Non-obvious design decisions: the order in `prune` matters — "Render targets must be withdrawn before an unmounted view can release its reference", so `publish()` runs *before* `view.retire()`.
- Edge cases / failure handling: `mount(reference)` for a reference the collection no longer owns throws `Sidebar Session view reference is no longer owned`; after `dispose()` a later `select` is a no-op and `mount` returns a no-op disposer.
- Surprising: the published list is sorted by session id, so the render order is stable regardless of the selection order.

### packages/client/ui-sidebar-right/src/client/shortcuts.ts
- Purpose: the sidebar's own keyboard commands, resolved against the *currently mounted page*.
- Key abstractions: `registerSidebarShortcuts(shortcuts, sidebar, t, closeWindow)` registering `sidebar.right.toggle`, `pane.split`, `pane.fullscreen.toggle`, `page.close`, `page.refresh`.
- Data flow: each command's `resolve` captures a target (the focused pane/tab, with its occurrence and navigation revision) and returns `{status, run}`; `run` re-checks `isTargetCurrent(target)` before acting.
- Non-obvious design decisions: (1) The split and fullscreen commands require focus inside a visible dock pane — "conversation focus leaves them unavailable" — and the blocked reason is the same `splitBlock` word the disabled button shows. (2) `page.close` first asks the foreground modal to close; only with no modal does it fall through to closing the sidebar page and then (on desktop only) the native window. (3) `page.refresh` calls the *bound* refresh function captured at resolve time, so a refresh captured before the body was replaced does nothing. (4) A stale sidebar target inside the sidebar's own markup reports `command.stale` ("The page changed; focus it again") rather than pretending there is no focus.
- Edge cases / failure handling: "Stale targets and cleanup failures never fall back to closing a window"; web leaves the browser open.
- Surprising: the desktop `page.close` falls through to the *window* only when no sidebar page owns focus — so the same key closes a page, then a modal, then the window, in that order.

### packages/client/ui-sidebar-right/src/client/index.ts
- Purpose: the browser half — provides `ctx.sidebarRight` and `ctx.sidebarRightTabs`, registers the two seats, the guide, and the shortcuts.
- Key abstractions: `apply(ctx)`; `inject = ['slots','layout','locale','resources','sessions','uiSession','shortcuts']`; the seat registrations (`rightbar` → `rightbar.session` → the keyed tab/title seats + the menu-item list; `conversation.session.header.corner`; `sidebar.right.pane.tab` keyed by `GUIDE_ID`).
- Data flow: the registry and the controller are built at `apply`'s top level (never inside an effect — "doing that from another plugin's apply while the effect is still the active scope stalls browser boot with no error at all"); an effect tracks the current Session and names it on screen; a second effect names the on-screen Session from the selection and `ctx.layout.panelInfo`, and it "changes before React renders the change that causes it".
- Non-obvious design decisions: (1) The `rightbar` and `rightbar.session` seats share one store because the slot runtime only allows a handle within one scope. (2) The guide registers through the *same* public two-stage path as any external type. (3) Teardown order: the faces are provided *first* so they tear down *last* — "the faces outlive every seat and type that reaches for them". (4) The store handle is wrapped so that minting a store instance for a session *adopts* it with the controller.
- Edge cases / failure handling: `ctx.effect` disposal aborts every tab occurrence, which releases every pin; a `reference.ready` rejection is logged, not thrown.
- Surprising: the "host plugin body" of this package contributes nothing to the host tree — the entire feature is a browser plugin.

### packages/client/ui-sidebar-right/tests/apply.client.spec.ts
- Purpose: the plugin's wiring and its removal on dispose.
- Key abstractions: a `boot()` harness with recorder doubles for slots/locale/layout/resources/sessions/shortcuts.
- Data flow: asserts the five registrations (root seat, panel seat, header corner, guide body, guide title), that both seats share one store, that the on-screen Session follows selection and `panelInfo`, and that the room rule gates a split.
- Non-obvious design decisions: the spec asserts the *exact* registration list and order, so a new seat cannot be added silently.
- Edge cases / failure handling: a native-close rejection is caught and logged; a disposed plugin's late tab action changes nothing and both faces disappear.
- Surprising: "the guide draws no product copy of its own, so neither guide seat binds the dictionary" — an assertion about a *negative*.

### packages/client/ui-sidebar-right/tests/close-focus.client.spec.ts
- Purpose: closing pages retains actual focus through layout replacement without stealing another input owner.
- Key abstractions: a `pane(id, floating, ownerSession)` DOM fixture.
- Data flow: asserts that focus stays on the removed input's pane, that a surviving pane takes it, that a hidden pane or another Session is never chosen, that a cleanup throw preserves focus, and that an explicit focus move is respected.
- Non-obvious design decisions: the fixture's owner element carries `data-sidebar-right-session` *and* `data-sidebar-right-open` — the two markers the production code checks.
- Edge cases / failure handling: the "cleanup throws" case asserts both the throw and that focus is unchanged.
- Surprising: this 72-line spec is the whole contract for the focus-continuity rule.

### packages/client/ui-sidebar-right/tests/expand-button.client.spec.tsx
- Purpose: the expand button exists exactly while the panel is collapsed and asks for it to expand.
- Key abstractions: a `mountButton()` harness over a real store instance and a test-local `hookOf` selector.
- Data flow: asserts the advertised `aria-keyshortcuts`, the tooltip text, the click → `layout.expanded === true`, and that the button returns after a collapse.
- Non-obvious design decisions: the spec notes "Copy is the dictionary's contract; the key stands in for the translation" — the copy is not what is under test.
- Edge cases / failure handling: a session with no surface yet still shows the button.
- Surprising: the component renders nothing at all while the panel is shown, so the header layout is unchanged.

### packages/client/ui-sidebar-right/tests/focus.client.spec.ts
- Purpose: focus ownership stays separate from layout selection, and captured lifetimes are validated.
- Key abstractions: a harness with a real controller, a real store and a synthetic DOM (`paneElement`, `tabElement` carrying the occurrence marker).
- Data flow: asserts rejection of collapsed / switched-session / moved / reopened targets; the split-budget and room-rule vocabulary; the pointer-focus rule; the text-selection preservation; and the whole shortcut surface (five commands, per-platform defaults, modal precedence).
- Non-obvious design decisions: the spec drives the *real* `ShortcutRegistry` rather than a stub, so the published `aria` strings and the platform default table are pinned.
- Edge cases / failure handling: it enumerates the six reasons focus is *not* reclaimed (`outside-pointer`, `other-focus`, `blur`, `hidden`, `session-change`, `dispose`) as a table.
- Surprising: "the close binding and native menu to the foreground modal" — a composing keyboard gesture is ignored, and the modal's close action is invoked instead.

### packages/client/ui-sidebar-right/tests/guide-body.client.spec.tsx
- Purpose: the guide body's chain seam and the shipped guide behind it.
- Key abstractions: `mountGuide(entries, custom?, shortcuts?)` with a chain that renders its fallback.
- Data flow: asserts one capsule per entry in registry order, the glyph-size rule (22 bare / 26 described), the placeholder cube, the four-entry description cutoff, the `openTab(kind, {replaceTab: true})` pick, and the keyed dispatch by *active provider id*.
- Non-obvious design decisions: the spec asserts that two boxes of one type at the same order do not produce a React key collision (by watching `console.error`).
- Edge cases / failure handling: an empty guide still renders its container.
- Surprising: "The guide draws no words of its own; every word is a capsule's" is asserted as a textContent equality.

### packages/client/ui-sidebar-right/tests/persistence-validation.client.spec.ts
- Purpose: saved layouts reject invalid structures and references before rendering or inventory publication.
- Key abstractions: a 26-row table of invalid shapes (missing layout, wrong tab fields, mismatched identity, reused future identity, missing root, unreachable node, missing/duplicate tab reference, unreachable tab, missing/invalid selection, selection in empty pane, float in dock tree, rectangle on dock pane, duplicate split child, split cycle, invalid split sum, mismatched split sizes, vertical split, three docked panes, nested split, split as active pane, floating split, float without rectangle, empty floating pane).
- Data flow: each invalid envelope is written to `localStorage` and must be discarded *without affecting another Session*.
- Non-obvious design decisions: the invalid set is a *fixture table*, which is the cheapest way to make a validator's contract reviewable.
- Edge cases / failure handling: also covers corrupt JSON envelopes, inaccessible storage, a failing `removeItem`, and a missing `localStorage` global.
- Surprising: "keeps persisted bytes independent of focus history" — 1000 focus changes must not change one byte of the saved layout.

### packages/client/ui-sidebar-right/tests/persistence.client.spec.ts
- Purpose: per-Session layout recovery precedes resource-body rendering.
- Key abstractions: a stubbed `localStorage` and a real store + controller pair.
- Data flow: asserts that a restored layout equals the saved one with a *fresh* undo history, that a restored record is pinned during adoption *before* the first render or store mutation, and that a corrupt JSON starts from an empty layout while a failing write leaves the in-memory layout usable.
- Non-obvious design decisions: the test asserts the pin happens during `adopt` — "before the first render or store mutation" — which is the ordering the Tab domain's design depends on.
- Edge cases / failure handling: corrupt JSON and a throwing `setItem` are both covered.
- Surprising: a second Session's store is unaffected by the first's `clearPersisted()`.

### packages/client/ui-sidebar-right/tests/seat.client.spec.tsx
- Purpose: sidebar presentation and tab subscriptions through the *production* slot renderer.
- Key abstractions: `mountSeat(viewportWidth, canShow, entryCount, opener, keepMounted)` builds a `SlotTestRuntime`, a frame double, a locale runtime, and a real slot mount; plus a `transition()` helper that models a browser-owned animation.
- Data flow: asserts the whole presentation matrix (narrow fullscreen, manual fullscreen preserved across widths, a panel that cannot fit collapsing without clearing records), the guide-entry-count default rule, the close/float/dock rules, the `useTabInfo` visibility rules, and the guide replacement chain.
- Non-obvious design decisions: the spec installs a "Conversation-column stand-in" that opens a resource as soon as a seat is mounted, to pin the ordering guarantee that `mounted` names the arriving Session *before* the Conversation's effect runs.
- Edge cases / failure handling: a whole describe block covers the fullscreen entry report (transition pending, cancelled, replaced, late completion after close/push/session/unmount, and the breakpoint crossing).
- Surprising: "the body asserts that none of the parallel owner props (`tabInfo`, `tab`, `paneId`, `visible`, `navigation`, `signal`, `tabActions`) leak into the component's props" — the owner share is a hook, not props.

### packages/client/ui-sidebar-right/tests/service.client.spec.ts
- Purpose: what `ctx.sidebarRight` promises other plugins.
- Key abstractions: a harness over a real registry, a real store and a real `TabDomain`, with a `publish()` that puts the Session on screen.
- Data flow: asserts the two opens (resource by claim, page by kind), the placement matrix (`paneId`, `preferNewPane`, `replaceTab`, `revealIfOpened`), the guide's per-pane uniqueness and merge rule, the navigation record with its `params` and `revision`, the layout operations, and the tab's own actions landing in *its* session after a session switch.
- Non-obvious design decisions: the spec asserts that tab ids repeat across sessions ("the seeded guides share one") and that closing one session's guide aborts only that session's occurrence.
- Edge cases / failure handling: an unadopted session's tab actions do nothing; a stale release must not remove a newer adoption; a cleanup handler that throws preserves the tab.
- Surprising: "an unoccupied hole leaves the surface with no add affordance at all" is the workspace package's rule, but the same "no affordance rather than a dead control" principle appears here in the guide's add control.

### packages/client/ui-sidebar-right/tests/session-views.client.spec.ts
- Purpose: one reference per View until the final committed root of a retired View unmounts.
- Key abstractions: a real `SlotTestRuntime` with two sessions.
- Data flow: asserts the mount counting, the reference-counted `retainTab`, the retirement ordering, the rejection of a released reference identity, and that a failed `reference.ready` is logged while the reference is still released exactly once.
- Non-obvious design decisions: "it disposes before the mount" cases are asserted explicitly (`release` not called until the last disposer runs).
- Edge cases / failure handling: the opening-failure path is covered with a rejected `ready` promise.
- Surprising: `view.retainTab(TAB, first.signal)()` after retirement does not resurrect the view.

### packages/client/ui-sidebar-right/tests/stores.client.spec.ts
- Purpose: every action is one settled intent recorded as one history entry — or no entry when it changes nothing.
- Key abstractions: a harness over the real store; the spec covers only the intents the kit's *gestures* reach (float moves, divider drags, the sequence's ends, the seed's timing).
- Data flow: asserts the split-at-edge drop as one reversible intent, the sole tab's own-edge drop backfilling the vacated pane with the default page, the two-pane budget, the 20–80% divider clamp, the guide's close rules, and the "a focus that changes nothing records nothing" rule.
- Non-obvious design decisions: the file's own header says the opens and the merge rule are asserted through `ctx.sidebarRight` in `service.client.spec.ts` — the suite is deliberately split by seam.
- Edge cases / failure handling: closing an already-closed tab throws nothing and records nothing; undo/redo before the first entry is a no-op.
- Surprising: "the docked surface's last tab follows the close rule, whoever asks" — the programmatic path enforces the rule the UI merely mirrors.

### packages/client/ui-sidebar-right/tests/tab-domain.client.spec.ts
- Purpose: what a record carries that the layout does not, and how long.
- Key abstractions: a `DockController`-driven layout plus a `TabDomain` with a stub navigator and pin.
- Data flow: asserts the pin happens once per occurrence, that a vanished record aborts and an undone close builds a *new* occurrence, that another session's occurrences are untouched, and that a tab's own actions open into the pane holding the tab *at call time* (including after it was dragged).
- Non-obvious design decisions: the spec augments `SidebarRightResourceParamsMap` with a test-only `test` scheme so params can be handed through the typed face.
- Edge cases / failure handling: `occurrence()` for an uncommitted record throws and does not create it.
- Surprising: a floating tab opens *unplaced* — "since a floating pane holds one tab".

### packages/client/ui-sidebar-right/tests/tab-info.client.spec.tsx
- Purpose: tab information refuses readers whose committed record and navigation binding disagree.
- Key abstractions: a harness binding a real store, a real `TabDomain` and a keyed navigation source map.
- Data flow: asserts the reader throws before the first layout commit, after the record closes (even while the navigation snapshot is still held), and after the keyed binding is released.
- Non-obvious design decisions: the spec suppresses the expected React error event so the assertion is on the throw, not on console noise.
- Edge cases / failure handling: the "held navigation snapshot" case is the interesting one — a retained reader must still fail once the record is gone.
- Surprising: the factory is a `SlotHookFactory`, and the spec drives it directly to prove the bound relation.

### packages/client/ui-sidebar-right/tests/tab-inventory.client.spec.ts
- Purpose: dormant saved layouts expose only provider metadata, with in-window stores authoritative.
- Key abstractions: a `save()` fixture writing a raw layout envelope.
- Data flow: asserts that collapsed and inactive saved Sessions are inventoried without occurrences or resources, that an invalid layout is rejected *as a whole* without skipping later valid Sessions, and that membership is stable across title and layout changes.
- Non-obvious design decisions: "Other windows' storage writes do not overwrite this window's live membership" is asserted by dispatching a `StorageEvent` and requiring no change.
- Edge cases / failure handling: a storage whose `length` getter throws still publishes in-memory membership; a missing `localStorage` global is tolerated.
- Surprising: the "publish" comparison is by JSON serialisation, so a changed title (not membership) does not churn the snapshot.

### packages/client/ui-sidebar-right/tests/tab-registry.client.spec.ts
- Purpose: stage one of tab-type registration — how the registry decides who opens an address.
- Key abstractions: `typeFor(kind, patterns, extra)` and `ranked(registry, address)`.
- Data flow: asserts each step of the resolver separately: whole-address vs path matching, case-insensitivity, dotfiles not hidden, non-URI addresses matching no path pattern, band ranking, extension-over-builtin takeover and hand-back, the same-band and fallback collisions throwing, id uniqueness, pattern-length specificity, registration-order tiebreak, `canOpen` veto, and the title thunk being read fresh on every call.
- Non-obvious design decisions: "every step is contract: a type shipped from another package relies on each one. So each is asserted, not assumed."
- Edge cases / failure handling: a type registered inside another plugin's effect disappears when that plugin is disposed.
- Surprising: the specificity measure is "the longest pattern that *matched*, not the longest declared" — the spec has a dedicated case for it.

---

### packages/client/ui-sidebar-terminal/package.json
- Purpose: manifest for the terminal sidebar plugin; injects the terminal controller, the right sidebar, remotes, theme and shortcuts.
- Key abstractions: `files` ships `lib/client.*.js` — the extra glob exists because the body is a *separate chunk*.
- Data flow: n/a.
- Non-obvious design decisions: `@xterm/xterm` and `@xterm/addon-fit` are devDependencies, not peer dependencies: the browser bundle must carry them, but only in the deferred chunk.
- Edge cases / failure handling: n/a.
- Surprising: the `files` glob `lib/client.*.js` is the package's own acknowledgement that the terminal body is a lazy chunk.

### packages/client/ui-sidebar-terminal/locale/en.json
- One specific line: 5-line metadata file (`meta.title: "ui-sidebar-terminal"`), no copy.

### packages/client/ui-sidebar-terminal/locale/zh.json
- One specific line: same metadata file with the Chinese title "终端面板" and a one-line description.

### packages/client/ui-sidebar-terminal/README.i18n.yaml
- One specific line: per-heading bilingual hash record for 12 sections of the terminal README.

### packages/client/ui-sidebar-terminal/README.md
- Purpose: the package reference for interactive shell tabs in the right sidebar.
- Key abstractions: the "Use this package" section documents the `terminal.new` command, the shell-picker menu, the rename gesture, takeover, reconnect, and the exit behaviour.
- Data flow: the terminal body is React-free — "the React-free terminal model belongs to `api-terminal-controller`; keyed framework hooks expose its state".
- Non-obvious design decisions: "A temporary disconnect preserves the screen and offers **Reconnect**, without exposing transport diagnostics"; "An exited shell remains visible with its exit code and offers **New terminal**; it never restarts automatically"; "Cleanup failures have no notification or manual retry action; saved unfinished close requests are retried when the Client plugin starts".
- Edge cases / failure handling: "A failed terminal chunk load requires a page reload because React caches a rejected lazy import for the page lifetime."
- Surprising: the documented "Model Experience" is again "None; terminal output travels only between the browser and Host" — and the terminal runs with the *execution environment's system-user permissions, independently of Agent permissions*.

### packages/client/ui-sidebar-terminal/README.zh.md
- One specific line: the Chinese counterpart (234→88 lines) with the same sections; I read the first 40 lines and confirmed parity.

### packages/client/ui-sidebar-terminal/src/index.ts
- One specific line: 4-line host companion — `apply()` is empty; "Mount the browser-only plugin through the Client loader."

### packages/client/ui-sidebar-terminal/src/css-modules.d.ts
- One specific line: the same 6-line CSS-module ambient declaration as the other two packages.

### packages/client/ui-sidebar-terminal/tsconfig.json
- One specific line: extends the client base config with 15 project references including `api/terminal-controller`, `ui-sidebar-right`, `ui-theme` and `ui-layout`.

### packages/client/ui-sidebar-terminal/tsdown.config.ts
- One specific line: 3-line bundler config using the shared `clientBundle` helper.

### packages/client/ui-sidebar-terminal/src/client/face.ts
- Purpose: the injected terminal commands and keyed observable state, plus the terminal's navigation-parameter declaration.
- Key abstractions: `TerminalInjected { view(key), keyedHooks.terminal(key) }`, `TerminalBodyInjected` (adds the theme observable), and a module augmentation of `SidebarRightTabParamsMap` with `terminal: { terminalId } | { shellPath }`.
- Data flow: the body asks `view(tab.id)` for the React-free `TerminalView` and subscribes to its state through the keyed hook.
- Non-obvious design decisions: the params are a *union* — a tab is opened either at an existing Host terminal (`terminalId`) or at a chosen shell (`shellPath`) — so the two routes are type-distinguished at the call site.
- Edge cases / failure handling: n/a.
- Surprising: the terminal package *extends the sidebar's* parameter map by module augmentation, which is how a third-party type keeps its own parameters typed without the sidebar knowing them.

### packages/client/ui-sidebar-terminal/src/client/locales.ts
- Purpose: the `sidebarTerminal` namespace dictionary.
- Key abstractions: `zh` is the key-set source of truth; `en` is checked against it.
- Data flow: `ctx.locale.register('sidebarTerminal', { zh, en })`.
- Non-obvious design decisions: the dictionary includes *transport-level* issues as named strings (`inputFull`, `attachmentEnded`, `invalidOutput`, `terminalLimit`) so the UI can translate a known failure while an unknown one passes through verbatim — "the terminal's own message".
- Edge cases / failure handling: `terminalLimit` explicitly says "Exited terminals also count toward the limit" — a surprising cost rule made visible in the copy.
- Surprising: `missingTerminal` ("This terminal no longer exists. Open a new terminal.") is the only failure that offers a *new terminal* rather than a retry.

### packages/client/ui-sidebar-terminal/src/client/index.ts
- Purpose: registers the terminal type, its observable views, and its background process cleanup.
- Key abstractions: `apply(ctx)`; `inject = ['slots','locale','sidebarRight','sidebarRightTabs','webTerminals','theme','shortcuts']`; three slot registrations (guide entry, tab body, tab title).
- Data flow: an effect syncs `ctx.webTerminals.retainTabs(...)` from the sidebar's `openTabs` inventory (filtered to `kind === 'terminal'`), so dormant Sessions' terminals are held at the *window* level, independent of React mounts.
- Non-obvious design decisions: (1) The window hold exists because the sidebar's inventory already knows about terminals in sessions nobody is looking at — "This window hold remains independent of React mounts and screen subscriptions. Removing the last matching occurrence releases it; collapsing or switching views does not." (2) The close handler is registered through the sidebar's `registerCloseHandler('terminal', …)` so closing a tab *ends the process in the background* and returns synchronously. (3) The type is `multiple: true` — each terminal is an independent instance with its own UUID-suffixed address. (4) The type's `priority: 'builtin'`.
- Edge cases / failure handling: the plugin's recovery and cleanup seats are *commented out* in this build — the components exist but are not registered.
- Surprising: the recovery path is present as dead code (`TerminalRecovery`, `TerminalCleanup` are imported as comments) — the recovery feature was disabled while the components were kept.

### packages/client/ui-sidebar-terminal/src/client/LazyTerminalBody.tsx
- One specific line: 14-line file whose only job is `lazy(async () => ({ default: (await import('./terminal.tsx')).TerminalBody }))` behind a `Suspense fallback={null}` — "Load xterm only after a terminal body is mounted."

### packages/client/ui-sidebar-terminal/src/client/terminal.tsx
- Purpose: the terminal screen and its connection state machine.
- Key abstractions: `TerminalBody` (status/alert surface) and `TerminalScreen` (the xterm instance and its four layout effects).
- Data flow: `state = useTerminal(tab.id)` gives the phase; `model = view(tab.id)` gives the commands; the render frame carries a `revision` and a `frame` (a `snapshot` or an `output`), and the screen acknowledges the revision only after `xterm.write` completes.
- Non-obvious design decisions: (1) The status line is derived from the phase with a strict precedence: `disconnected` suppresses the error text, a known `issue` is translated, an unknown error passes through. (2) A `missingTerminal` issue renders a *different* surface — an empty-state panel with a "New terminal" button — and no retry, because the process is gone and recovery "never creates that replacement automatically". (3) The emulator is created once per `model`; a font change mutates `xterm.options` and refits rather than recreating it, and a `snapshot` frame calls `xterm.reset()` before the resize. (4) `fitScreen` clamps the proposal to the Host's `maxCols`/`maxRows` and refuses a 1-column or 0-row fit.
- Edge cases / failure handling: a read-only attachment shows "Take control"; a disconnected terminal keeps its screen and offers Reconnect; an exited process shows its exit code (`—` when unknown) and offers a new terminal.
- Surprising: `xterm.write(frame, () => model.acknowledge(render.revision))` — the Host only learns the frame was applied when the emulator has actually painted it.

### packages/client/ui-sidebar-terminal/src/client/terminal-cursor.ts
- Purpose: contrast-aware styling for xterm's DOM cursor, independent of its ANSI palette.
- Key abstractions: `observeTerminalCursor(terminal, node, preferredCursor)`; `luminance(color)`; `opaqueColor(color, background)`.
- Data flow: on every xterm render, the cursor marker class is *removed* so the cell's rendered colours (including reverse video) can be read, then re-added; the computed contrast sets three CSS variables (`--terminal-cursor`, `--terminal-cursor-accent`, `--terminal-cursor-cell-background`/`-foreground`).
- Non-obvious design decisions: the cursor is styled through CSS variables rather than xterm's theme, "so they must not update xterm's shared ANSI theme"; the threshold is WCAG's 3:1 for the cursor against its cell, and the accent flips to black/white by the fill's own luminance. Alpha is composited against the scrollable element's background.
- Edge cases / failure handling: a non-URI colour string falls back to the background; the cursor class is restored in a `finally`.
- Surprising: the same mechanism handles a Vim colourscheme, because it reads the *cell* rather than the palette.

### packages/client/ui-sidebar-terminal/src/client/terminal-theme.ts
- Purpose: DSH defaults plus application OSC colour overrides for one xterm screen.
- Key abstractions: the `TerminalTheme` class with `update(background, foreground)`, a `cursor` getter and `dispose()`; OSC handlers for 4 (set palette), 104 (reset palette), 10/11/12 (fg/bg/cursor) and 110/111/112 (reset them).
- Data flow: `apply()` merges the DSH defaults with the program's indexed and special overrides into one `ITheme` and assigns `terminal.options.theme`.
- Non-obvious design decisions: (1) Program overrides live in *separate maps* from the DSH defaults, so a DSH theme change never destroys an application's colours: "Theme changes preserve the running shell, output, and application OSC color overrides." (2) `update()` is a no-op when the resolved background/foreground are unchanged, so the theme object keeps its identity. (3) OSC parsing follows XParseColor semantics — `rgb:` channels scale, `#rgb` has different semantics — and every handler returns `false` so xterm's own query handling is not consumed.
- Edge cases / failure handling: an invalid index, a malformed colour, a dangling pair, or a `?`-style query is ignored without losing the valid pairs in the same command; indices ≥ 16 go to `extendedAnsi`.
- Surprising: the `theme` object identity is stable across a no-op `update`, which the spec asserts (`expect(h.options.theme).toBe(previous)`).

### packages/client/ui-sidebar-terminal/src/client/TerminalGuide.tsx
- Purpose: the shell-launch menu owned by the terminal provider's guide entry.
- Key abstractions: `TerminalGuideInjected { hooks.shortcuts, loadShells(signal), selectShell(path) }`; a `MenuState` of `loading | ready | failed`.
- Data flow: the menu is opened → `loadShells(signal)` runs with an `AbortController` → the choices render; picking one calls `selectShell(path)` and then `tab.actions.openTab('terminal', { replaceTab: true, params: { shellPath: path } })`.
- Non-obvious design decisions: (1) The main button opens the *remembered* shell with no query at all — "Discovery runs when the menu opens and does not allocate a terminal". (2) The shell menu sits *beside* the title inside the guide card, so the card remains one affordance with a secondary selector. (3) The failure state is an in-menu "Retry" item rather than a dialog. (4) The load is cancelled by an `AbortController` tied to the menu's lifetime, and a late resolve is ignored (`lifetime.signal.aborted`).
- Edge cases / failure handling: a failed lookup is reported inside the menu; the selection is remembered *before* the terminal opens.
- Surprising: the guide entry is the *only* place the shell is chosen, and the shortcut text is rendered inline with no duplicate tooltip.

### packages/client/ui-sidebar-terminal/src/client/TerminalTitle.tsx
- Purpose: live terminal names in docked and floating tab chrome, editable in place.
- Key abstractions: `TerminalTitle` reads `useTerminal(tab.id, state => state?.info?.title ?? state?.title) ?? tab.title`.
- Data flow: a native `dblclick` listener on the chip (or the float grip) flips the row into an `<input>`; on blur the trimmed value is sent through `view(tab.id).rename(next)`.
- Non-obvious design decisions: (1) The rename is triggered by a *native* `dblclick` listener on the chip, because "Dockkit captures the pointer on its drag handle, which receives the double-click". (2) The editor stops pointer/click/double-click propagation so the drag handle does not steal the edit, and stops `keydown` propagation so the sidebar's shortcuts do not fire while typing. (3) IME composition is honoured: `keyCode === 229` (some IMEs report composition only there) and `isComposing` both suppress the Enter submit. (4) Escape cancels (a `cancelled` flag) and Enter commits; an unchanged or blank name is not sent.
- Edge cases / failure handling: the listener is removed on unmount (the spec spies on `removeEventListener`).
- Surprising: the title falls back through `info.title` → `state.title` → the layout record's captured title, so a name that predates the live connection still shows.

### packages/client/ui-sidebar-terminal/src/client/TerminalIcon.tsx
- One specific line: 13-line file holding the 16px `>`-and-`_` line glyph for the tab title, drawn on `currentColor` and marked `aria-hidden`.

### packages/client/ui-sidebar-terminal/src/client/TerminalRecovery.tsx
- One specific line: 29-line component that calls the injected `restore()` on mount and renders *only* a retry button when the lookup failed; the plugin that would supply it is commented out in `index.ts`, so this component is currently unregistered.

### packages/client/ui-sidebar-terminal/src/client/TerminalCleanup.tsx
- One specific line: 29-line root-overlay component that renders a fixed stack of `role="alert"` notices for failed background cleanups, each with a Retry button calling `retryClose(failure.id)`; it renders nothing when there are no failures.

### packages/client/ui-sidebar-terminal/src/client/terminal.module.css
- One specific line: 19-line sheet — a flex column with an 8px top pad under the tab strip, a status bar, an error block, an empty state, and the cursor rules that map the four xterm cursor shapes (block/outline/bar/underline) onto the `--terminal-cursor` variables, plus a 1s `step-end` blink that swaps to the *cell* colours.

### packages/client/ui-sidebar-terminal/src/client/TerminalCleanup.module.css
- One specific line: 3-line sheet — a fixed bottom-right stack of 440px-max notices with a shadow and a small inline Retry button.

### packages/client/ui-sidebar-terminal/src/client/TerminalGuide.module.css
- One specific line: 12-line sheet — a guide card that mirrors the shipped capsule geometry but lays the main action as an absolutely-positioned full-card button (`inset: 0`) with the icon, text and shortcut as `pointer-events: none` layers, so the split trigger stays interactive.

### packages/client/ui-sidebar-terminal/src/client/TerminalTitle.module.css
- One specific line: 2-line sheet — the title ellipsizes; the rename input is 120px wide (min 48px) with the app's small radius.

### packages/client/ui-sidebar-terminal/tests/apply.client.spec.ts
- Purpose: terminal views, copy and tab retention follow the plugin lifetime.
- Key abstractions: a `mountPlugin()` harness with a stub `webTerminals` and a recording slot registry; `@xterm/xterm` and the terminal body are mocked out.
- Data flow: asserts the three registrations (guide entry, body, title) with their locale namespaces, the `terminal.new` shortcut's blocked/handled behaviour, the `view(key)` resolution with `terminalId` and `shellPath` params, the close handler's arguments, and the retention of terminal metadata from dormant layouts.
- Non-obvious design decisions: the spec asserts `expect(h.terminals.recover).not.toHaveBeenCalled()` and `expect(h.terminals.retryClose).not.toHaveBeenCalled()` — the recovery and cleanup features are *deliberately absent* in this build.
- Edge cases / failure handling: on dispose, the close handler, the type registration, the three seats and the dictionary all disappear; the inventory subscription is released with `retainTabs([])`.
- Surprising: the guide icon is rendered to static markup to assert its default and explicit sizes (36 and 22).

### packages/client/ui-sidebar-terminal/tests/bundle-split.client.spec.ts
- Purpose: keeps xterm out of the startup bundle.
- Key abstractions: it reads the *built* `lib/client.js` and `lib/client.terminal.js` as text and parses the `require.async("./client….js")` calls.
- Data flow: asserts the entry defers exactly one chunk (`./client.terminal.js`), that the entry has no static `require("./client….js")`, that the chunk has no further chunk requires, and that `/@xterm+xterm@` appears in the chunk and *not* in the entry.
- Non-obvious design decisions: the test is skipped when the bundle is not built (`it.skipIf(!existsSync(entryPath))`), so it is a release-time gate, not a unit test.
- Edge cases / failure handling: n/a.
- Surprising: this is a static gate on a *build artifact* — the cheapest possible proof that a heavy dependency stays out of the startup path.

### packages/client/ui-sidebar-terminal/tests/cleanup.client.spec.tsx
- Purpose: cleanup errors remain reachable after the terminal tab has disappeared.
- Key abstractions: the component rendered with a hand-built `useCloseFailures` selector.
- Data flow: asserts the component renders nothing for ordinary closes, an alert with the terminal's title and message after a failure, and that the retry targets the *selected* terminal.
- Non-obvious design decisions: the two-failure case asserts the notices stay separate and that clicking one retries only that terminal.
- Edge cases / failure handling: clearing the failures removes the stack.
- Surprising: the cleanup surface is deliberately *outside* the sidebar ("without recreating or blocking any sidebar tab").

### packages/client/ui-sidebar-terminal/tests/recovery.client.spec.tsx
- Purpose: recovery hides ordinary work and keeps a failed lookup retryable.
- Key abstractions: a `restore` promise under the component's control.
- Data flow: asserts a successful restore adds no control, a failed one offers a retry button whose title carries the message, and that a *later* Session's failure is not masked by an earlier Session's success.
- Non-obvious design decisions: the "keeps the current Session failure when an earlier Session lookup later succeeds" case is the interesting one — the component's `active` flag prevents a stale promise from clearing a current error.
- Edge cases / failure handling: a non-`Error` rejection is stringified.
- Surprising: the whole component renders nothing at all on the happy path — recovery is invisible when it works.

### packages/client/ui-sidebar-terminal/tests/terminal-body.client.spec.tsx
- Purpose: terminal startup, title editing and xterm's screen lifetime.
- Key abstractions: a `FakeTerminal` class replacing `@xterm/xterm`, a fake `FitAddon`, a stubbed `ResizeObserver`, and a `mount()` harness that can change theme, state and visibility.
- Data flow: asserts automatic startup and the retry/reconnect affordances per phase, one emulator across rename and locale updates, snapshot-then-output application with the duplicate frame ignored, the theme update without recreating the terminal, the font list and refit, the cursor listener's lifecycle, the fit clamping, and the rename editor's Escape/unchanged/IME behaviour on both the docked chip and the float grip.
- Non-obvious design decisions: the spec drives two title surfaces (`docked tab` and `floating grip`) through the same `it.each`, because the title is registered for both seats.
- Edge cases / failure handling: a `missingTerminal` issue disposes the stale emulator and shows no textbox; a temporary disconnect keeps the screen and exposes no transport diagnostics.
- Surprising: the phase list is exercised exhaustively (`idle`, `loading`, `creating`, `connecting`, `connected`, `disconnected`, `failed`, `closing`, `closed`) with the expected status text for each — the phase vocabulary is a contract.

### packages/client/ui-sidebar-terminal/tests/terminal-cursor.client.spec.ts
- Purpose: DOM cursor contrast without writing escape sequences or replacing the palette.
- Key abstractions: a fake `Terminal` exposing only `onRender`.
- Data flow: asserts the computed `--terminal-cursor` value for black-on-white, white-on-black, a transparent preferred colour, a green preferred colour, and a translucent cell background composited over the surface.
- Non-obvious design decisions: the spec asserts the cursor marker class is *restored* after measuring, and that the listener's disposer runs.
- Edge cases / failure handling: a removed cursor element is simply skipped.
- Surprising: the expectations are literal colour strings, so the whole contrast algorithm is pinned numerically.

### packages/client/ui-sidebar-terminal/tests/terminal-guide.client.spec.tsx
- Purpose: guide shell discovery, direct launch and cancellation stay within the entry lifetime.
- Key abstractions: a `mount()` harness with a `loadShells` mock and a catalog entry builder.
- Data flow: asserts the main button opens the remembered shell with no query, the shortcut text stays inline (no tooltip) and rebinds, the menu loads on demand, the selection is remembered *before* the open, the load is cancelled on dismissal, the in-place retry after a failure, the empty-discovery case, and that a late resolve/reject after unmount opens nothing.
- Non-obvious design decisions: the spec asserts `expect(h.loadShells).not.toHaveBeenCalled()` for the main button — the query is strictly on demand.
- Edge cases / failure handling: a late rejection after unmount is consumed by the cancelled entry without publishing.
- Surprising: the shortcut's `aria-keyshortcuts` disappears entirely when the binding is cleared, and the `kbd` labels change with the rebind.

### packages/client/ui-sidebar-terminal/tests/terminal-theme.client.spec.ts
- Purpose: program palette retention and XParseColor reset semantics across application themes.
- Key abstractions: a fake `Terminal` whose `parser.registerOscHandler` records handlers per code.
- Data flow: asserts that indexed, extended and special application colours survive a DSH theme change, that `update()` with the same colours keeps the theme object's identity, that OSC 104 resets selected entries / all indexed colours / all special colours to the DSH defaults, and that the exact xterm interpretation of each colour spelling is preserved.
- Non-obvious design decisions: the spec asserts the number of disposers (8) so a new OSC handler cannot be added without noticing.
- Edge cases / failure handling: an eight-case table of unsupported/query colours must be left to xterm; invalid palette indices are ignored without losing valid pairs in the same command.
- Surprising: the expected values are xterm's own interpretations (`#123456789` → `#124578`), so the implementation must match xterm rather than CSS.

---

### packages/client/ui-workspace/package.json
- Purpose: manifest for the workspace browser + picker plugin.
- Key abstractions: `dsh.client.inject` lists twelve services including `api/workspace-controller`, `api/remote-access` and `client/ui-sidebar`.
- Data flow: n/a.
- Non-obvious design decisions: the devDependency list includes the *providers* of the Session activity families (`dsh-agent`, `dsh-jobs`, `dsh-schedule`, `dsh-subagent`) — they are type-only, so the archive dialog can name the work it will stop.
- Edge cases / failure handling: n/a.
- Surprising: `dsh-typert-protocol` is a dependency of a UI package, which is a good reminder that the workspace surface speaks a protocol-shaped vocabulary.

### packages/client/ui-workspace/locale/en.json
- One specific line: 5-line metadata file (`meta.title: "ui-workspace"`), no copy.

### packages/client/ui-workspace/locale/zh.json
- One specific line: same metadata file with the Chinese title "工作区选择界面" and a one-line description.

### packages/client/ui-workspace/README.i18n.yaml
- One specific line: per-heading bilingual hash record for 21 sections (the largest of the three packages' pairing records).

### packages/client/ui-workspace/README.md
- Purpose: the package reference — the browsing region, view options, reordering, hierarchy, search, session management, pending interactions, and the extension contract.
- Key abstractions: the README documents the *watermark* rule, the *complete account order* rule, the three-way archived filter, the directory-flow hole, and the Session row-action lists.
- Data flow: it documents that `ctx.uiWorkspace.openSession(target)` "synchronously replaces the owned `mainView` reference and returns the main area to Conversation without waiting for `reference.ready`".
- Non-obvious design decisions: (1) "**Last updated** sorts each partition strictly by the latest user prompt or steer time" — pin time does not affect it. (2) "**Manual** uses the relative positions in one complete Session sequence, including hidden archives." (3) A new ordinary fork precedes its source in the complete sequence "without inheriting pin membership". (4) The README contains a complete, copy-pasteable **packaged client plugin** example (a `MenuItemButton` row registered at `order: 500`) and a note on how a dynamically loaded closure must render its own `role="menuitem"` button.
- Edge cases / failure handling: "Renaming a Session that is not open is refused" and the fork's "open the source to complete the migration" path are documented as user-facing outcomes.
- Surprising: the README states that the *view* state is browser-local while the *Workspace group order* is Host-durable — two different durability domains in one sidebar.

### packages/client/ui-workspace/README.zh.md
- One specific line: the Chinese counterpart (234 lines) with the same anchored sections; I read the first 40 lines and confirmed the watermark and reordering rules are stated identically.

### packages/client/ui-workspace/src/index.ts
- One specific line: 9-line host half — "Pure UI plugin: the empty apply exists so the plugin appears in the host cordis.yml / Loader".

### packages/client/ui-workspace/src/css-modules.d.ts
- One specific line: the same 6-line CSS-module ambient declaration as the other two packages.

### packages/client/ui-workspace/tsconfig.json
- One specific line: extends the client base config with 22 project references, including the four providers whose activity families the archive dialog names.

### packages/client/ui-workspace/tsdown.config.ts
- One specific line: 3-line bundler config using the shared `clientBundle` helper.

### packages/client/ui-workspace/src/client/contract/slots.ts
- Purpose: the package's extension contract — two registrations, two directory-flow holes, two Session row action lists, two row decoration seats, and the toast contract.
- Key abstractions: `DirectoryFlowOwnerProps { open, busy, onPicked, onCancel, onError }`; `SessionRowOwnerProps { sessionId, displayTitle }`; `MenuOpenState` + `menuOpenStateFactory`; `RowToast` (a discriminated union of nine notice kinds); `WorkspaceBrowserInjected`; `WorkspacePickerInjected`.
- Data flow: the browser declares five child seats; the row's menu open-state pair is passed as the *render occurrence's* `hookContext` so every entry reads the same setter.
- Non-obvious design decisions: (1) The directory-flow hole is a `single` slot whose **occupancy** is an observable, so the "Add workspace…" entry exists only while a flow package is registered — "an unoccupied hole leaves the surface with no add affordance at all". (2) The owner owns the *trigger and the adoption* (`createWorkspace({path})`, the retryable error dialog, "Choose again") while the occupant owns everything between `open` and the picked path, *including creating a new directory* — that is why adding has a single route. (3) The row decoration seats are **root-scoped, not session-scoped**: "a session-scoped seat would force a Session binding, which would activate and retain every listed Session." (4) The menu-item list carries a documented `order` (100/200/300/400/450) and a documented rule for shadowing ("reusing a shipped id at another `priority` shadows that row").
- Edge cases / failure handling: a menu item that acts MUST dismiss the menu — "a menu floating over content the action may have just replaced".
- Surprising: the contract file contains a full, runnable `@example` of a third-party plugin's row entry, including the `useMenuOpenState` dismissal idiom.

### packages/client/ui-workspace/src/client/contract/toast.ts
- Purpose: the keyed Workspace notice contract and the shared Toast Factory's display data.
- Key abstractions: `ToastKind = RowToastState['kind']`; `ToastDisplay { text, tone, holdMs?, actions? }`; `ToastOccurrence extends ToastDisplay { seq, onDone }`; the `workspace.toast` keyed slot and the `workspace.toast.content` factory slot.
- Data flow: a notice is dispatched by `entryKey: notice.kind`; the keyed registration supplies a pure `display(notice, t, dismiss)` mapping; the shared factory renders it.
- Non-obvious design decisions: "Per-display identity and dismissal; neither changes when localized content updates" — the `seq` keys the toast so a repeated notice restarts its hold without a locale change restarting the timer. Only the archive notices subscribe to the viewing store, "without subscribing unrelated notices".
- Edge cases / failure handling: n/a.
- Surprising: the business payload never reaches the presentation — the notice is data, the display is a pure function of (notice, translate, dismiss).

### packages/client/ui-workspace/src/client/tree.ts
- Purpose: derives the browser tree from caller-projected Workspace and Session order.
- Key abstractions: `deriveGroups`, `deriveFlat`, `deriveSearchResults`, `orderByRecency`, `reconcileManualOrder`, `pinCurrentBlank`, `sessionMemberIds`, `visibleSessionIds`, `owningGroupKey`, `owningParentFolder`, `workspaceLabel`, and the `SessionNode` / `GroupNode` / `SearchResultNode` shapes.
- Data flow: the Host snapshots (session list, workspaces, statuses) plus the browser's view state go in; a fully-projected row list comes out. The renderer never scans.
- Non-obvious design decisions: (1) `reconcileManualOrder` keeps a saved relative order and *supplements* missing members: pins first (in pin-array order), then ordinary members by recency, then archives last; it then places new forks *before* their source, recursively, so a nested fork lands before its parent. (2) Two different membership functions exist on purpose: `sessionMemberIds` (the **complete** account, archives included) and `visibleSessionIds` (what the current filter shows) — "Archive filtering alone changes neither saved positions nor account membership". (3) `sessionVisible` hides `origin: 'subagent'` sessions and every blank except the selected one. (4) Blank sessions are excluded from search entirely — "their canonical title displays localized, so matching it would tie search to one language". (5) `runningChildCount` reads the *parent's loaded subagent catalog*, never summary lineage, and uses the live UI status with the summary as a fallback. (6) `owningParentFolder` normalises separators for comparison but "without interpreting POSIX backslashes as separators", and matching is case-sensitive.
- Edge cases / failure handling: a member without a summary waits for it and keeps its saved position; `assertNever` is the closed-union backstop for the archived filter.
- Surprising: `containsCurrent` is computed in the derivation and handed to the renderer "so the renderer never scans".

### packages/client/ui-workspace/src/client/pin-order.ts
- Purpose: the complete account memberships a pin write reconciles against, derived from the same Host snapshots the browser orders by.
- Key abstractions: `pinOrderSource(workspaces, list, rowState)` and `pinOrderAccounts(workspaces, sessionId)`.
- Data flow: the navigation service calls both after the Host pin succeeds, so the order write "reads the memberships current at completion" — a reorder that landed while the Host call was pending keeps its position.
- Non-obvious design decisions: the source is derived from the *same* snapshots the browser orders by, "so the UiWorkspace service can complete the write without the browser in the loop" — the browser is not a required participant in a pin.
- Edge cases / failure handling: n/a.
- Surprising: the flat list is one of the accounts (`FLAT_SESSION_ORDER_KEY`), so a pin leads the Session in its Workspace group, in Ungrouped *and* in the flat list.

### packages/client/ui-workspace/src/client/stores.ts
- Purpose: the browser's viewing store — grouping mode, ordering mode, expansion, saved orders, archived filter.
- Key abstractions: `createWorkspaceViewStore()` (a factory, not a module-level handle, "a module-level handle would pin the store identity across plugin reloads"), `FLAT_SESSION_ORDER_KEY`, `SessionGroupBy`, `SessionOrderBy`, `WorkspaceViewActions`.
- Data flow: persisted under `dsh.workspace.view.v5`; the browser writes through `actions`, and the navigation service writes `pinSessionOrder` through the *same* instance the renderer hands the browser.
- Non-obvious design decisions: (1) `setSessionOrder` always *snapshots* the complete initial orders when switching into Manual — "entering Manual again freezes the then-current chronological order". (2) `pinSessionOrder` reconciles **every** account, not only the pinned ones, so a pin write also normalises the others. (3) `retainAccountKeys` prunes expansion and order state for Workspaces that no longer exist, and deletes a legacy `sessionUpdatedAtByAccount` field. (4) `syncSessionOrders` is a no-op outside Manual.
- Edge cases / failure handling: the `archivedFilter` is optional in the persisted shape so pre-filter v5 snapshots rehydrate as `default`.
- Surprising: the store's action type is an "annotation twin" of the actions literal — "drift fails assignability at the `defineStore` call".

### packages/client/ui-workspace/src/client/navigation.ts
- Purpose: the `ctx.uiWorkspace` service — the Workspace navigation and directory capability.
- Key abstractions: `UiWorkspaceService` (a cordis `Service`) with `openSession`, `openWorkspace`, `connectWorkspace`, `startSession`, `forkSession`, `archiveSession`, `unarchiveSession`, `pinSession`, `unpinSession`, `pickDirectory`, `listDirectory`, `createDirectory`; `DirectoryBrowseError`; `StartSessionOptions`.
- Data flow: `openSession(target)` retains a `mainView` reference, sets the persisted selection (`dsh.sessions.current`), and returns the main area to Conversation; `openWorkspace` connects a blank, then replaces the main reference, but only while `ctx.layout.beginNavigation()` has not been aborted.
- Non-obvious design decisions: (1) **Supersession** — a Workspace open is `AbortSignal.any([layout.beginNavigation(), lifetime])`; a superseded request may still create a Session but does not open it, and it raises no notice. (2) A preset **fallback ladder** in `restoreBlank`: reload the projections, read the preset the log recorded, and on `agent-preset/not-found` or `agent-preset/invalid` ask again *without* a preset so the draft continues under the Host default. (3) Concurrent `connectBlank` calls for the same Workspace **coalesce** only when they request the *same* preset — "the latest request always reaches the Host". (4) A blank the Host declined is refreshed with `refreshProjections`, "so a stale blank row is corrected". (5) `replaceMain` releases the previous reference and re-checks the abort signal after the optional `beforeOpen` preparation. (6) The `selection` snapshot store is persisted, and a saved *subagent address* restores without needing a parent catalog.
- Edge cases / failure handling: a creation refusal is reported as `code: message` (the stable code stays searchable) unless the request was superseded; a failed startup restoration is console-only; a failed projection reload is a warning, not a failure.
- Surprising: `startSession` inherits the *current* Session's Workspace before falling back to the most recent Workspace — and when a draft is being prepared with no Workspace at all, it raises a localized notice instead of clearing the selection.

### packages/client/ui-workspace/src/client/shortcuts.ts
- Purpose: the six workspace commands and the browser-owned opening requests.
- Key abstractions: `WorkspaceShortcutState { searchRequest, addRequested, directoryBusy, renameTarget }`; `createWorkspaceShortcutControls()`; `installWorkspaceShortcuts(ctx, navigation, controls, archiveSession, reportForkFailure)`.
- Data flow: a command's `resolve` captures the *current* target (the retained main-view Session) and returns a `{status, run}` pair; the run uses the captured id, not the current one.
- Non-obvious design decisions: (1) The rename command requires a non-blank main Conversation with no modal and no global panel — each of those is a separate blocked reason. (2) `add()` is refused while `directoryBusy`, so a second "add workspace" cannot race an in-flight picker. (3) The fork command distinguishes `session/fork-unavailable` (a localized "no completed turn") from any other failure (a warning plus a "could not fork" notice). (4) The commands are registered with `regions: ['page','editable']` and `modals: []` — they work from terminals and behind modals, unlike the sidebar's page commands.
- Edge cases / failure handling: the fork's "unavailable" case is silent (no console warning) while an unexpected failure is logged.
- Surprising: the desktop defaults use the platform's primary modifier, and the Web defaults add `alt` — so `Mod+K` on desktop, `Alt+Mod+K` on web.

### packages/client/ui-workspace/src/client/locales.ts
- Purpose: the `workspace` namespace dictionaries (254 keys).
- Key abstractions: `zh` is the key-set source of truth; `en` is checked against it; `WorkspaceKey` is the exported union.
- Data flow: `ctx.locale.register('workspace', { zh, en })`.
- Non-obvious design decisions: the dictionary carries the *policy* in the copy — the archive confirmation says the stopped work "will not resume on its own", the delete dialog says the folder and session logs are kept, and the archived toast says the session "cannot be opened" until restored. The archive-confirmation family lines are pluralised per family (`subagents.one` / `.other`, `jobs`, `schedules`, `other`).
- Edge cases / failure handling: "Runtime failure messages (wire error strings) pass through untranslated by policy" — the host's own diagnostics are not translated.
- Surprising: `groupBy.workspace` is spelled "WorkSpace" in the English dictionary — a deliberate product-casing choice, and a good example of how a dictionary is the only place a word's spelling is decided.

### packages/client/ui-workspace/src/client/index.ts
- Purpose: the browser half — two registrations, the shipped row actions, the overlay surfaces and the toast registrations.
- Key abstractions: `apply(ctx)`; `inject` (nine services); the `WorkspaceBrowserInjected` and `WorkspacePickerInjected` faces; the five child seats under `sidebar.workspaces`; the two `list` registrations for the menu items and the row buttons; the three `shell.overlay` registrations.
- Data flow: the plugin creates **one** viewing-store instance and hands the same instance to both the browser registration and the `UiWorkspaceService`, "so the browser declares the handle, and the UiWorkspace service writes view order through the same instance the renderer hands the browser".
- Non-obvious design decisions: (1) `ctx.slots.provideRoot` publishes the `useWorkspaces` and `useWorkspaceAccess` hooks. (2) The *fixed Host facts* (`remote.$host`) are reached through a hook rather than injected as values, because "the renderer memoizes an entry's inject result for the registration's lifetime, so facts read there would freeze at whatever the first render saw" — a bug class the package explicitly designed around. (3) The shipped actions are registered exactly the way a third-party plugin would register — same seats, same `order`, same `inject` face — "a client plugin's action lands beside them by `order`". (4) The archive action's Host refusal is classified by *error name* (`WorkspaceArchiveError`) because "client plugin bundles do not share error-class identity".
- Edge cases / failure handling: a pin failure raises a notice instead of moving nothing silently; a fork refusal for a migration requirement offers to open the source and never retries.
- Surprising: `derive(workspaces.list, snapshot => new Set(...))` rebuilds the pinned/archived Sets only when the snapshot's identity changes, so a row's membership read is one Set lookup.

### packages/client/ui-workspace/src/client/WorkspacePicker.tsx
- Purpose: the pick/add flow — the reusable core plus the conversation empty-state registration.
- Key abstractions: `WorkspacePickFlowProps`; `WorkspacePickFlow` (menu + adoption error dialog); `WorkspacePicker` (the slot registration's adapter).
- Data flow: the add entry raises the flow; the occupant reports a picked path through `onPicked`; the owner adopts it with `createWorkspace({path})` and, on success, selects the committed Workspace; on failure the folder-error dialog shows the message and "Choose again" reopens the flow.
- Non-obvious design decisions: (1) **One route to add a workspace** — the occupant's own create-folder affordance already covers creating one, so this package never offers a second. (2) When the add action is the *only* entry, the anchor gesture goes *straight* into the flow: "a one-row popover would cost a click and offer nothing to choose between" — and it waits for the list baseline first, so it never pre-empts workspaces that are about to arrive. (3) `flowBusy` (the flow is open *or* an adoption is settling) disables every menu action, "a late outcome must not race a concurrent selection or adoption". (4) An occupant that unloads mid-interaction leaves nobody to cancel: the flow **withdraws** and the menu actions come back, and the "Choose again" button goes inert.
- Edge cases / failure handling: a non-`Error` rejection is stringified into the alert; the error dialog's retry is disabled when the hole is empty.
- Surprising: "an empty list is only final once the baseline lands — until then the menu stays up with its loading status instead of jumping into a flow the arriving list would have made unnecessary".

### packages/client/ui-workspace/src/client/WorkspacePicker.module.css
- One specific line: 20-line sheet — the adoption error dialog's footer button width (72px min) and the two message styles (`.modalError` in the error state colour, `.menuStatus` in secondary ink).

### packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx
- Purpose: the browsing region — section header, search, the grouped tree or flat list, and the Workspace dialogs.
- Key abstractions: `WorkspaceBrowser` (the root), `SessionTree` (grouped), `FlatList`, `SearchResults`, `ViewOptionsMenu`, `EmptySessions`, plus the watermark and drag helpers (`watermarkRows`, `requiredWatermark`, `raiseWatermarks`, `sessionDragOrder`, `useNativeDragAcceptance`).
- Data flow: the browser reads the session list, the Workspace snapshot, the viewing store and the shortcut state; it derives three ordered membership lists (each Workspace, Ungrouped, the flat list), renders one of three bodies, and raises the rename/delete dialogs and the search request.
- Non-obvious design decisions: (1) **The watermark** — each group shows at most N session rows (base 5); the watermark *rises* to cover the last attention-bearing row (running, running child, awaiting the user, unread completion, or the current Session) within the first 50, and to the revealed session at any position; it never falls on its own, so rows stay visible after a run ends, and a reorder that moves a Session past the watermark hides it. (2) The search query is debounced by 250 ms and each new query *aborts* the previous request; a failed content search leaves the local metadata matches visible with no extra warning. (3) The search input is sanitised to the wire bound (500 UTF-16 code units) without splitting a surrogate pair. (4) The query outlives the tree and the input, "so collapsing does not silently drop an in-progress filter". (5) Archived rows are not openable: a click explains instead of navigating. (6) The rail search arms before the expand request and focuses the input only after the slide (`EXPAND_SLIDE_MS = 300`), because `focus()` forces a synchronous layout and would jank the slide. (7) An outside-click dismissal is suppressed while the rail gesture is in flight, "the listener would dismiss the search that click just opened".
- Edge cases / failure handling: the delete confirmation stays pending until the component has rendered the committed list projection without the deleted id, "closing earlier exposes one stale React frame to the next Create Workspace gesture"; the rename dialog's duplicate check excludes the target *by identity*, not by title.
- Surprising: the Workspace tree nests by **registered canonical paths only** — it does not scan for projects or resolve symlink aliases.

### packages/client/ui-workspace/src/client/rows/Rows.tsx
- Purpose: the presentational row components — the Workspace header row, the session row and the search-result row.
- Key abstractions: `ProjectRowItem`, `SessionNodeItem`, `SearchResultItem`, `useTitleMarquee`, `sessionStatuses`, `SessionStatusDots`, `PinnedIndicator`, `SessionHoverContent`, `WorkspaceHoverContent`, `RowDragProps`.
- Data flow: all data and callbacks arrive via props; the row's action lists are rendered through the browser's `renderSlot` with the menu's open state as the occurrence's hook context.
- Non-obvious design decisions: (1) The **status vocabulary** is a total function: pending interaction outranks running, running outranks the completed reminder, and idle is the floor; each status has a dot state and a screen-reader label, and the trailing cell shows a compact label ("Approval") instead of the time when an interaction is pending. (2) The leading 16px cell renders the status dot *or* the leading seat, never both — "a row that owns a state dot keeps that cell and renders no seat"; an archived row keeps the cell blank and its live status lives on the hover card. (3) The title **marquees** on hover at a constant 0.03 px/ms, but only when the overflow exceeds 8 px ("a barely-clipped title moving a few pixels reads as jitter, not a reveal"), and reduced motion jumps to the far edge. (4) The hover card's date uses the dictionary's template rather than `toLocaleString`, "which would follow the browser language, not the app locale".
- Edge cases / failure handling: the marquee is cancelled on leave and the title returns to its start in one step; the double-click rename is disabled on the blank row.
- Surprising: the hover card is *suppressed* while a menu is open or a drag is active, and the row's own "..." trigger stops propagation so clicking it does not also open the row.

### packages/client/ui-workspace/src/client/rows/AnimatedRows.tsx
- Purpose: React-commit-driven movement and entry/exit fades for the sidebar's keyed rows.
- Key abstractions: the `AnimatedRows` class component with `getSnapshotBeforeUpdate` / `componentDidUpdate`; `ROW_FADE_MS = 100`, `ROW_GLIDE_MS = 200`.
- Data flow: before the update it measures each `[data-row-key]` row's rect and clones the rows that are about to disappear; after the update it re-measures and animates the survivors from their old position, and fades the clones in an absolutely-positioned inert overlay outside the scrolling list.
- Non-obvious design decisions: (1) It uses the class lifecycle's `getSnapshotBeforeUpdate` — the only React hook that gives a *pre-commit* measurement — so no layout observer and no polling is needed. (2) Motion is **armed** only after the first pointer or key event inside the list, so an initial load never animates. (3) Rows outside the viewport are not animated. (4) A view change (`resetKey`) or a not-ready list settles immediately. (5) An interrupted movement is redirected from the *currently displayed* position, not the original one.
- Edge cases / failure handling: `prefers-reduced-motion` and a browser without `Element.animate` both settle instead of animating; the exit clone is `inert` and `aria-hidden`.
- Surprising: the removed row's clone keeps the `--dsh-workspace-indent` custom property so the exit animation lines up with the indent the real row had.

### packages/client/ui-workspace/src/client/rows/Rows.module.css
- One specific line: 421-line sheet for the rows — the 16px status slot, the 32px session row and 34px workspace row, the `data-scrolled`/`data-clipped` mask gradients for the marquee, the drop markers drawn as two 55°/125° chevrons joined to a 2px rule, the archived colour step, and the hover-swap rules that hide the time and the pin marker when the action strip appears.

### packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.module.css
- One specific line: 621-line sheet for the browsing region — the scrollbar arithmetic (`--dsh-session-list-edge-inset` / `-scrollbar-width` / `-scrollbar-offset` with `scrollbar-gutter: stable`), the 180ms header transitions that collapse the section label and the action cluster as the search expands, the skeleton-row pulse, the drop markers, and the macOS rule that *removes* the bottom fade because the sidebar is translucent over window vibrancy.

### packages/client/ui-workspace/src/client/rows/AnimatedRows.module.css
- One specific line: 7-line sheet — the exit overlay is `position: absolute; inset: 0; contain: strict; overflow: clip; pointer-events: none`.

### packages/client/ui-workspace/src/client/session-actions/ArchiveSession.tsx
- Purpose: the archive action — a menu row, a hover button, and the stop-and-archive dialog.
- Key abstractions: `ArchiveSessionMenuItem` (order 400), `ArchiveSessionRowButton` (order 100), `SessionArchiveConfirmDialog`, `ArchiveConfirmForm`, `activityLine`.
- Data flow: the menu row and the hover button both read the archived set through their injected hook and call `archiveSession` / `unarchiveSession`; the dialog consumes the pending `archiveRequest` and calls `stopAndArchiveSession`.
- Non-obvious design decisions: (1) A quiet Session archives **without** a confirmation — the notice offers undo; the *only* case that asks first is a Session with running work, because the Host refuses the plain archive. (2) The dialog names the work by family (`turn`, `subagent`, `job`, `schedule`, and a generic `other`), with each family's count and its items' labels (or ids when a family carries no label) — and an unknown family falls through to the generic line rather than vanishing. (3) The dialog is keyed by the Session id, so a new request starts a fresh draft and the in-flight/error state dies with it.
- Edge cases / failure handling: the dialog cannot be closed while archiving; a failed archive shows the error and keeps the dialog open.
- Surprising: the same component serves both "archive" and "restore" — the icon, the label and the callback all switch on the row's archived membership.

### packages/client/ui-workspace/src/client/session-actions/PinSession.tsx
- Purpose: the pin action — a menu row and a hover button over one injected behavior.
- Key abstractions: `usePinState` (two Set lookups), `PinSessionMenuItem` (order 100), `PinSessionRowButton` (order 200).
- Data flow: both entries read the pinned and archived sets and call `pinSession` / `unpinSession`.
- Non-obvious design decisions: the action **renders nothing on an archived row**, because "Pin and archive are mutually exclusive on the Host". The hover button is order 200 because it is rightmost — "it lands where the rest-state pin marker sits", and the marker is hidden while the strip is shown.
- Edge cases / failure handling: n/a — the injected callback raises the failure notice.
- Surprising: the pin marker is a non-interactive `role="img"`, so the row remains the only action.

### packages/client/ui-workspace/src/client/session-actions/ForkSession.tsx
- One specific line: 31-line menu row (order 300) that returns `null` when `useSessionAccess(sessionId, 'session/fork')` is false — the action's visibility is decided by a *remote-access* permission, not by local state.

### packages/client/ui-workspace/src/client/session-actions/RenameSession.tsx
- Purpose: the rename action and the rename dialog it raises.
- Key abstractions: `RenameSessionMenuItem` (order 200), `SessionRenameDialog`, `RenameForm`.
- Data flow: the menu row raises `requestSessionRename(sessionId, displayTitle)`; the dialog (a `shell.overlay` entry) consumes the request and calls the injected `renameSession`.
- Non-obvious design decisions: (1) The dialog lives in the overlay, not in the row menu, "because the row unmounts with the menu". (2) Unlike a Workspace rename, an *unchanged* title is allowed — it pins the current automatic title against regeneration — and a Session has no client-side name-conflict rule. (3) An unnamed Session starts with an empty draft and requires a name. (4) IME composition is tracked with a ref so an Enter that commits a composition does not submit.
- Edge cases / failure handling: a rejected rename keeps the dialog open with the error in an `role="alert"`.
- Surprising: the dialog is keyed by the Session id, so a second rename request starts a fresh draft rather than editing the previous one.

### packages/client/ui-workspace/src/client/session-actions/SessionId.tsx
- One specific line: 20-line final built-in menu row (order 450) that dismisses the menu and copies the complete Session id — "Copying does not retain the Session, load its history, or call the Host."

### packages/client/ui-workspace/src/client/session-actions/RowActionToast.tsx
- One specific line: 14-line dispatcher that renders the current notice into the keyed `workspace.toast` slot with `entryKey: notice.kind` — "without interpreting its business payload".

### packages/client/ui-workspace/src/client/session-actions/derived.ts
- One specific line: 26-line `derive(source, project)` helper that recomputes a projection only when the source snapshot's *identity* changes, so a consumer that selects from it (a Set lookup per row) never rebuilds it per read.

### packages/client/ui-workspace/src/client/toast/register.ts
- Purpose: registers the notice presentations with their business-owned display data.
- Key abstractions: `registerToasts(ctx, viewStore, actions)`; a keyed registration per notice kind; the shared `workspace.toast.content` factory.
- Data flow: each registration's `inject` returns a pure `display(notice, t, dismiss)`; the archive registrations additionally supply `filterAction`.
- Non-obvious design decisions: the archive notice's "filter archived sessions" action is added *only while archived rows are hidden* (the archive adapter subscribes to the viewing store; the others do not), so a user who already switched the filter is not offered it again. The `createFailed` notice holds for 6000 ms because it carries a host error code worth reading.
- Edge cases / failure handling: n/a.
- Surprising: one shared `Toast` primitive serves all eleven presentations — the business registrations supply only data.

### packages/client/ui-workspace/src/client/toast/Toast.tsx
- Purpose: one presentation Factory and the two keyed adapters.
- Key abstractions: `ToastEntry` (generic over the keyed payload), `ArchiveToastEntry` (subscribes to the archived filter), `WorkspaceToast` (the shared factory component).
- Data flow: `renderFactorySlot('workspace.toast.content', { ...display(...), seq, onDone })`.
- Non-obvious design decisions: the `seq` keys the toast, so a repeated notice restarts its hold "without a locale change restarting the same notice's timer"; the tone maps to the primitive's own `success` variant or a warning icon.
- Edge cases / failure handling: n/a.
- Surprising: the shared factory receives only display data — the business registration never touches the primitive.

### packages/client/ui-workspace/tests/apply.client.spec.ts
- Purpose: the plugin's wiring — the services it declares, the seats it registers, the action shares and the teardown.
- Key abstractions: a `bench()` harness with real services (a fake `ISessions`, a `TestRemote`, a `LocaleRuntime`) and a recording `SlotRegistry`.
- Data flow: asserts the `useWorkspaceAccess` hook over `remoteAccess`, the two registrations appearing whether the declarations arrive before or after `apply`, the five child seats and the shipped actions with their `order`s, the copy-ID path (accepted and refused), the fork-failure notice, the derived pin/archive Sets, the pin write reaching the view store, the archive → notice → undo chain, and the stop-and-archive confirmation.
- Non-obvious design decisions: the spec covers both orderings of declaration (`registers browser and pickers for declarations arriving before or after apply`) because `slots.inject` is the only ordering-safe mechanism.
- Edge cases / failure handling: a Host refusal for a running Session becomes the confirmation; a fork that the Host refuses for migration offers to open the source and never retries; every entry is unregistered on teardown.
- Surprising: the "fork opened read-only subagent history without selecting its child" case pins that forking never navigates.

### packages/client/ui-workspace/tests/animated-rows.client.spec.tsx
- Purpose: the row animator's contract.
- Key abstractions: a stubbed `Element.prototype.animate` that records keyframes, a `getBoundingClientRect` stub that derives a row's position from its index, and a `matchMedia` stub.
- Data flow: asserts initial arrivals settle (no measurement before arming), a pin reorder glides both rows for 200 ms, a membership change fades the leaver for 100 ms as an inert absolute clone, content-only updates and scrolling are not measured, and the four settle modes (loading, view change, reduced motion, unsupported browser) measure nothing.
- Non-obvious design decisions: the spec drives arming with a real `pointerDown` on the tree, mirroring the production trigger.
- Edge cases / failure handling: an interrupted movement is redirected from the displayed position; an exit copy is removed when its row returns; unmount cancels every owned animation.
- Surprising: "does not animate rows that stay outside the list viewport" is its own case — the viewport intersection test is part of the contract.

### packages/client/ui-workspace/tests/browser-styles.client.spec.ts
- Purpose: the spacing contract, asserted against the CSS **text on disk**.
- Key abstractions: `declarationsFrom(source, selector)` — a tiny CSS rule parser that strips comments and normalises whitespace.
- Data flow: asserts that the list is the scrolling region, that the themed 5px scrollbar is counted inside the shell's trailing inset (a whole arithmetic identity over four custom properties), that the gutter is `stable`, the 2px/4px rhythm, the drag markers' exact gradients, the row heights, and the marquee masks.
- Non-obvious design decisions: it asserts a *negative* too — `expect(declarations('.list::-webkit-scrollbar')).toBeUndefined()`, i.e. the scrollbar must stay themed rather than becoming a platform one.
- Edge cases / failure handling: n/a.
- Surprising: this is a **CSS-source contract test** — a whole class of visual regressions caught without a browser.

### packages/client/ui-workspace/tests/host-home-staleness.client.spec.tsx
- Purpose: a Host fact learned after the first render must reach the rendered rows.
- Key abstractions: a `bench()` that mounts the *real* apply against a test-owned `SidebarFrame`.
- Data flow: the first render happens with no `remote.$host`; then `connection/reset` announces the ready frame and the hover card abbreviates the path to `~/Documents/project`.
- Non-obvious design decisions: the spec drives the *assembled renderer*, not `entry.inject()`, "which bypasses that memo" — the whole point is that the renderer memoizes an entry's inject result for the registration's lifetime.
- Edge cases / failure handling: the pre-ready frame shows the absolute path.
- Surprising: this is a regression test for a *specific* memoization trap that the contract file documents.

### packages/client/ui-workspace/tests/rename-assembly.client.spec.tsx
- Purpose: the session-rename assembly chain — row menu → request → overlay dialog → `binding.session.rename` → the row re-labels.
- Key abstractions: a real `SlotTestRuntime` with a test-owned `SidebarFrame` declaring both `sidebar.workspaces` and `shell.overlay`.
- Data flow: asserts plugin-registered menu rows land in declared order after the shipped ones (with one separator), that the keyboard walk (End / ArrowUp) and the focus return to the trigger work, that the copy-ID row copies without opening the Session, that the rename dialog seeds from the current title, trims the draft, and closes on the accepted unary response with no push-frame wait, and that a rejected rename keeps the dialog open with the alert.
- Non-obvious design decisions: the file's header states the coverage split explicitly — the e2e pins the full-app menu, the wire behaviour stays with the Session Controller, the entries' arms with `session-actions.client.spec`, the row rendering with `rows.client.spec` — "the assembled chain lives in rename-assembly.client.spec".
- Edge cases / failure handling: the dialog's error state and the row's unchanged title are both asserted.
- Surprising: the spec asserts the plugin rows' order even when the later registration carries the *lower* shadowing priority, "assigned to dynamic browser packages".

### packages/client/ui-workspace/tests/rows.client.spec.tsx
- Purpose: the row components' own contracts (hover handoff, row rendering, the schedule seats).
- Key abstractions: a `SessionNodeItem` wrapper that defaults `renderSlot` to null, a `stubRect` helper (jsdom rects are zero) and a `dragProps` factory.
- Data flow: three describes — "Workspace and Session hover handoff" (the shared 800 ms dwell across mixed rows and its reset on list exit), "workspace browser rows" (the bulk), and "session row schedule seats" (the leading seat rendering only on an idle row).
- Non-obvious design decisions: the spec builds the row with a *hand-built* node object, so the derivation is not part of these cases.
- Edge cases / failure handling: the archived row's blank leading cell, the suppressed hover card while a menu is open, and the drag half detection are all covered.
- Surprising: it installs an async clipboard double to assert the copy path.

### packages/client/ui-workspace/tests/session-actions.client.spec.tsx
- Purpose: the shipped row actions rendered directly with hand-built props.
- Key abstractions: seven describes — "Session ID action", "pin action", "archive action", "fork and rename rows", "SessionRenameDialog", "SessionArchiveConfirmDialog", "RowActionToast".
- Data flow: each action is rendered with its injected share and asserts only its own behaviour (the callbacks' effects are `apply.client.spec`'s subject).
- Non-obvious design decisions: the file's header states the split explicitly: "Every action reads its own injected hooks and calls its own injected callbacks; what those callbacks do is apply.client.spec's subject."
- Edge cases / failure handling: the pin action's absence on an archived row, the fork action's absence without access permission, the dialogs' in-flight and error states, and the toast's `dismissToast` are all covered.
- Surprising: the archive dialog's activity-line rendering per family is asserted here, with the generic fallback for an unknown kind.

### packages/client/ui-workspace/tests/shortcuts.client.spec.ts
- Purpose: the workspace commands capture their business target before the dispatcher executes them.
- Key abstractions: a `bench()` over a real `ShortcutRegistry` with a fake session list and a fake `layout.panelInfo`.
- Data flow: asserts the six registered commands and their per-platform `aria` strings, the rename preconditions (non-blank main Conversation, no modal, no global panel), the fork's classification of a Host refusal, and the "target captured at resolve time" behaviour when the main Session changes between resolve and run.
- Non-obvious design decisions: the spec asserts the *absence* of a load-older call — "leaves loaded history unchanged when commands mount, Sessions change, or Fork runs".
- Edge cases / failure handling: the `Mod+R` gesture must `pass` (never be consumed) so the browser reload survives; the rename binding is a shared three-key chord.
- Surprising: an unnamed history row's rename draft opens *empty* rather than seeded with the directory label.

### packages/client/ui-workspace/tests/tree.client.spec.ts
- Purpose: the derivation's full contract.
- Key abstractions: fixtures for sessions, workspaces, statuses and a subagent catalog; five describes over `owningGroupKey`, ordering, `deriveGroups`, `deriveFlat`, search filtering, the view store, `workspaceLabel` and parent-folder membership.
- Data flow: 887 lines of table-driven cases, including the exact expected orders after reconciliation.
- Non-obvious design decisions: (1) the fork-placement rule is pinned by three separate cases (fork before source, nested fork before parent, orphan/self-parent appended). (2) `owningParentFolder` is pinned by an 11-row table including Windows drive letters, UNC paths, a POSIX backslash inside a segment, and a case-sensitivity mismatch.
- Edge cases / failure handling: a summary that has not landed yet; a member whose summary is temporarily missing keeps its saved position; equal timestamps use the session id as the tie-break.
- Surprising: the archive filter is asserted to be *outside* complete flat membership — `sessionMemberIds` returns archives even when the view hides them, so filtering never destroys a position.

### packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx
- Purpose: the assembled browsing region — the largest spec in the shard (2657 lines).
- Key abstractions: a `mount(overrides)` harness over the real `WorkspaceBrowser` with the real view store and a real `createWorkspaceShortcutControls`; a `fireDrag` helper (jsdom lacks `DragEvent`).
- Data flow: two describes — "WorkspaceBrowser" and "Workspace tree grouping".
- Non-obvious design decisions: the spec drives the real component with the real store rather than mocking the derivation, so the watermark, the drag ordering and the search debounce are all exercised end to end.
- Edge cases / failure handling: the drag/drop matrix, the watermark raise and reset, the archived filter, the rename/delete dialogs and the search reveal are the bulk of it.
- Surprising: `beforeEach` clears `localStorage` and re-seeds the view store to Manual, so every case starts from a known view state — the store's persistence is part of the fixture.

### packages/client/ui-workspace/tests/workspace-picker.client.spec.tsx
- Purpose: the pick/add flow's contract.
- Key abstractions: a `flowProbe()` occupant that records the owner conversation and renders a marker while the flow is open, plus an `occupancySource()` that can flip the hole's occupancy.
- Data flow: asserts the listing of same-titled Workspaces as separate entries, the adoption of a picked path and the selection of the returned Workspace, the anchor gesture going straight into the flow when add is the only entry, silent cancellation, the non-`Error` failure surface, the busy lock from flow-open through adoption, the flow-reported failure, the menu staying up while the baseline is in flight, the empty popover when nothing can be added, the "Choose again" button going inert when the occupant unloads, and the flow withdrawing on occupant unload.
- Non-obvious design decisions: the occupancy source is flipped *without a re-render*, proving the hook is subscription-driven rather than render-driven.
- Edge cases / failure handling: the list emptying mid-adoption must not raise a second flow.
- Surprising: "the auto-open path obeys the same busy rule as the disabled menu entry: an occupant that re-registers mid-adoption must not raise a second flow".

### packages/client/ui-workspace/tests/workspaces-service.client.spec.ts
- Purpose: the `UiWorkspaceService` — the largest behavioural spec in the shard (1513 lines, 71 cases).
- Key abstractions: a `FakeSessions implements ISessions`, a `MutableSource<T>`, a `persistSelection` helper for the saved selection, and a `workspaceState`/`sessionState` builder.
- Data flow: five areas — startup (default Workspace, blank restoration, preset fallback, projection reload), navigation (open/session/panel/disposal supersession), pin ordering, archive/unarchive, and the directory operations.
- Non-obvious design decisions: (1) Startup is a *state machine* with three phases (`waiting` → `connecting` → `done`) that retries a failed blank acquisition when a new catalog arrives. (2) Supersession is tested from four directions (session, panel, disposal) for both the *directory preparation* and the *failure notice*. (3) A pin write uses the membership *current at completion* — "keeps newer saved orders when a pending pin completes". (4) The preset ladder is tested for `agent-preset/not-found` and `agent-preset/invalid` separately, and "does not retry a saved blank restoration refused for another reason".
- Edge cases / failure handling: an archived current selection is cleared by a catalog update without reconnecting; a persisted subagent address restores without a parent catalog; a failed persisted restoration is reported and retryable.
- Surprising: "does not let a pending startup Workspace replace a manual Session selection" — the startup path yields to the user.

---

## Ideas worth stealing

- **A VS Code-style type resolver for any "who opens this address?" question, with an explicit extension band** — `packages/client/ui-sidebar-right/src/client/tab-registry.ts:350` (and `:379`, `:59`, `:181`). Globs narrow the candidates, a `canOpen` predicate vetoes, and the survivors rank by *band* → *length of the matched pattern* → *registration order*. The three bands (`extension` / `builtin` / `fallback`) are string literals so an out-of-tree type needs no runtime import, and the **default band is `extension`** — "a type that declares nothing is one from outside the product". A kind may carry one builtin and one extension; the extension takes over and the builtin *resumes* when it leaves. This is the whole resolution problem a file-viewer, a tool-chooser, or an agent-subagent-selector needs, and it is 120 lines.

- **Separate the *complete* membership from the *visible* membership, and save the complete one** — `packages/client/ui-workspace/src/client/tree.ts:476` (`sessionMemberIds`) vs `:487` (`visibleSessionIds`), with the rule stated at `packages/client/ui-workspace/src/client/tree.ts:436`. Two functions exist because "Archive filtering alone changes neither saved positions nor account membership": a filter is a *view* concern, and the saved order is a *state* concern. A harness that persists a filtered list will lose positions the first time a filter changes; this package makes that impossible by construction and pins it in `packages/client/ui-workspace/tests/tree.client.spec.ts:200`.

- **Reconcile a persisted order against a churning live set instead of rewriting it** — `packages/client/ui-workspace/src/client/tree.ts:168` (`reconcileManualOrder`). Saved relative positions survive; *missing* members are supplemented (pins first in pin-array order, then by recency, then archives last); new forks are then placed *before* their source, recursively, so a nested fork lands before its parent. The result is idempotent — re-running the reconciliation on its own output is a fixed point. This is exactly the algorithm a harness needs for a persisted "pinned tools" list, a saved agent roster, or a project index whose membership changes under it.

- **One intent = one history entry, computed by replaying onto a scratch copy before settling** — `packages/client/ui-sidebar-right/src/client/stores.ts:189` (`advance`). The action mints ids, asks a *pure planner* for ops, replays them onto a copy, runs the settle planner over the copy, records one history entry, and assigns the whole surface back. The scratch replay is what lets the settle rule ("an intent never leaves an expanded column with an empty pane") be a product rule rather than a kit rule, and it makes every state transition replayable from the mint counter. A harness with an undoable workspace layout should copy this shape.

- **A "focus that changes nothing records nothing" rule, enforced for every intent** — `packages/client/ui-sidebar-right/src/client/stores.ts:154` (`planFocusTab` returns `[]` when the tab is already active in the already-active pane) and the same rule for panes at `:160`. History that records no-ops is history the user has to step through for nothing; the rule is asserted in `packages/client/ui-sidebar-right/tests/stores.client.spec.ts:376`. Cheap to adopt, immediately visible in the UX.

- **Capture-then-verify for every command that targets live state** — `packages/client/ui-sidebar-right/src/client/service.ts:585` (`isTargetCurrent`) with the capture at `:504` (`focusedTarget`) and `:516` (`commandTarget`). A shortcut resolves against the DOM, captures the pane/tab/occurrence/navigation-revision, and the `run` re-verifies all four before acting. The same pattern is used for the *close* command, which refuses to fall back to closing a window when the captured target went stale. A harness that dispatches a tool call minutes after the user pressed a key needs exactly this.

- **Return a localizable *discriminator* for "why is this disabled?" instead of a boolean** — `packages/client/ui-sidebar-right/src/client/service.ts:602` (`splitBlock` returns `'stale' | 'collapsed' | 'float' | 'empty' | 'budget' | 'width'`). The disabled button's tooltip and the keyboard refusal then say the same word, and adding a reason is a new string plus a new union member rather than a new boolean. This is the cheapest possible way to keep a UI and its keyboard layer from drifting apart.

- **A navigation *revision counter* so "navigated again" is observable without a state write** — `packages/client/ui-sidebar-right/src/client/tab-domain.ts:136` (`navigate`) with the increment at `:142`. The revision steps on every navigation "whether or not `params` changed, so a body can act on 'navigated again' alone", and the body re-renders without any layout commit (asserted at `packages/client/ui-sidebar-right/tests/seat.client.spec.tsx:757`). Any harness surface that re-opens the same tab with different parameters needs this: without it, a re-open is indistinguishable from a no-op.

- **Pin the resource for the *record's* lifetime, not the view's** — `packages/client/ui-sidebar-right/src/client/tab-domain.ts:97` (`sync`) and `:110` (the single `pin` call). Holding a record pins its address in the resource model "so switching tabs unmounts a body without dropping its content", and the pin is released exactly when the record disappears. The inventory at `packages/client/ui-sidebar-right/src/client/tab-inventory.ts:23` then lets a provider recover a *dormant* session's resource without the sidebar ever mounting it. A harness that keeps per-session resources (a terminal, a browser, a long-lived subagent) needs this separation between "the model is looking at it" and "it still exists".

- **An occurrence identity that changes when a closed tab is undone** — `packages/client/ui-sidebar-right/src/client/tab-domain.ts:162` (`hold` mints a fresh `randomUUID` occurrence id) with the undo case asserted at `packages/client/ui-workspace/../ui-sidebar-right/tests/tab-domain.client.spec.ts:74`. An undone close is a *new lifetime*, not a resurrection: a fresh id, a fresh abort signal, a fresh pin. Any "restore this thing" feature in a harness should mint a new identity rather than revive the old one.

- **A "hole" seat whose *occupancy* is an observable, so an affordance exists only while the capability does** — `packages/client/ui-workspace/src/client/contract/slots.ts:64` (the owner contract) with the occupancy hook at `packages/client/ui-workspace/src/client/WorkspacePicker.tsx:97` and the withdrawal rule at `:103`. The "Add workspace…" entry is not rendered when no picker is registered — "an empty hole means the composition has no picking affordance" — and a picker that unloads mid-interaction makes the owner *withdraw* the request, because "an occupant that unloads mid-interaction leaves nobody to cancel". A harness that composes optional capabilities (a browser, a terminal, a file viewer) should hide the entry rather than leave a dead button.

- **An attention watermark: a per-list row budget that rises to cover what matters and never falls on its own** — `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx:77` (`requiredWatermark`) and `:97` (`raiseWatermarks`). A group shows 5 session rows; the budget rises to cover the last running / child-running / awaiting-you / unread-completion / currently-open row within the first 50, and to a search-revealed row at any position; it never falls by itself, so a row stays visible after the run that made it interesting ends, and a reorder that pushes a row past the budget hides it. This is a directly transferable pattern for a harness session list, an agent list, or a task list: show the important things without requiring a scroll to the bottom.

- **Ship the shipped actions through the *same* extension seam a third party would use** — `packages/client/ui-workspace/src/client/index.ts:316` (the menu-item registrations with their `order`s) against the seam declaration at `packages/client/ui-workspace/src/client/contract/slots.ts:171`. Pin is order 100, rename 200, fork 300, archive 400, copy-id 450; a plugin's row lands at its own `order` among them, and reusing a shipped `id` at another `priority` shadows that row. Because the shipped rows use the same `inject` face and the same `useMenuOpenState` dismissal hook, a third-party row is not a second-class citizen — and the contract file even carries a runnable example.

- **A row-action entry decides its own visibility from an injected permission** — `packages/client/ui-workspace/src/client/session-actions/ForkSession.tsx:17` (`useSessionAccess(sessionId, 'session/fork')`). The action renders *nothing* when the peer may not perform it, and the access source is published as a root hook at `packages/client/ui-workspace/src/client/index.ts:127`. The same pattern (a capability hook) is what a harness needs for "this agent may not touch this tool".

- **Let the action's *failure* be a notice, and give the notice an undo** — `packages/client/ui-workspace/src/client/index.ts:186` (the pin failure notice) and the archive notice's undo at `packages/client/ui-workspace/src/client/toast/register.ts:86`. The notice channel is shared frame-wide, only the latest notice is visible, and "removing the browsing region does not dismiss it". A harness that performs a destructive operation for the model should be able to say "done — undo" in the same channel, with the undo wired to the same operation.

- **Ask before stopping work, not before archiving** — `packages/client/ui-workspace/src/client/session-actions/ArchiveSession.tsx:159` (`activityLine`) and the dialog at `:82`. A quiet Session archives with no confirmation; the *only* confirmation is the case where the Host refuses because work is still running, and the dialog then names the work by family (the turn in progress, running subagents, background jobs, scheduled reminders) with counts and labels. This is the shape a harness's "stop this session" affordance should take: the friction belongs on the destructive-to-the-work case, not the common case.

- **A "settle" rule that the *product* owns, applied to every intent through one site** — `packages/client/ui-sidebar-right/src/client/stores.ts:199` (the settle planner) with the product rule stated at `packages/client/ui-sidebar-right/src/client/stores.ts:13`. "An intent never leaves an expanded column with an empty pane — emptied side panes merge away, and an empty root pane seeds the default page. A collapsed column may stand empty." A harness that renders panels (a file tree, a terminal, a diff view) needs the same invariant, and the way it is enforced here — one shared site every action routes through — is what stops the five compaction paths in a harness from drifting into five different behaviours.

- **Validate a persisted structure by *walking* it, not by checking its shape** — `packages/client/ui-sidebar-right/src/client/persistence.ts:27` (`validateReferences`). The zod schema proves the fields are well-typed; the walk proves the graph is coherent — node ids match their keys, ids do not exceed the minted counter, a split is the root and horizontal and has exactly two children whose sizes sum to 1, a tab is referenced at most once, `activePaneId` is a pane, a float has a rectangle. The invalid shapes are then pinned as a 26-row fixture table at `packages/client/ui-sidebar-right/tests/persistence-validation.client.spec.ts:21`. A harness that persists a layout should validate references this way and keep the invalid-shape table as a fixture.

- **Restore state into a *fresh* undo history** — `packages/client/ui-sidebar-right/src/client/persistence.ts:74` (`history: EMPTY_HISTORY` on read) and the spec at `packages/client/ui-sidebar-right/tests/persistence-validation.client.spec.ts:73`. The saved layout is the current state; the sequence is the live window's. The spec also asserts that 1000 focus changes do not change one byte of the saved payload — i.e. the *view* is persisted, the *interaction* is not.

- **Focus continuity through DOM replacement, with an explicit "someone else owns focus now" escape** — `packages/client/ui-sidebar-right/src/client/focus.ts:73` (`observeSidebarFocus` re-focuses the pane holding the same occurrence when the focused element is removed) and `packages/client/ui-sidebar-right/src/client/shell/close-focus.ts:26` (`closeWithPaneFocus`). Two rules make it safe: the restore happens only while `document.activeElement` is still the body or the removed element, and `flushSync` guarantees the DOM has committed before the focus query. A harness that re-renders a panel under the user's cursor needs this or the keystrokes go nowhere.

- **A chain seat where the first non-declining entry replaces the body and the shipped body is the *owner's fallback*** — `packages/client/ui-sidebar-right/src/client/tabs/guide/GuideBody.tsx:88` (the chain render) with the rationale at `packages/client/ui-sidebar-right/src/client/tabs/guide/GuideBody.tsx:8`. The shipped guide is deliberately *not* a chain entry of its own, "so there is always exactly one body and the shipped one cannot be outvoted by accident". This is the right shape for a harness's default empty-state or plan view: a product can replace it wholesale, and the replacement decides for itself whether it applies.

- **Progressive disclosure inside a compact list: drop the description when the list gets crowded** — `packages/client/ui-sidebar-right/src/client/tabs/guide/GuideBody.tsx:45` (`MAX_DESCRIBED_ENTRIES = 4`) with the rule at `:16`. At ≤4 entries a capsule shows its description under the title and its glyph grows to 26px; at 5+ every description is dropped and the glyph returns to 22px — "a type must stand on its title". A harness listing many tools/agents should copy this: the *title* is the contract, the description is the luxury.

- **Read a live fact through a hook, never through an injected value** — `packages/client/ui-workspace/src/client/contract/slots.ts:221` (the `hostInfo` comment) with the fix at `packages/client/ui-workspace/src/client/index.ts:151`. "The renderer memoizes an entry's inject result for the registration's lifetime, so facts read there would freeze at whatever the first render saw." The regression test that proves it is `packages/client/ui-workspace/tests/host-home-staleness.client.spec.tsx:70` — it drives the *assembled* renderer, not `entry.inject()`, because a direct call would bypass the memo. Any harness plugin that receives a host fact must reach it through a subscription, not through an inject closure.

- **A derivable projection that is rebuilt only when the source's *identity* changes** — `packages/client/ui-workspace/src/client/session-actions/derived.ts:12` (`derive`). The pinned/archived sets are `Set`s so a row's membership read is one lookup, and the set is rebuilt once per Workspace snapshot rather than once per row.

- **Do the expensive thing in a *separate chunk*, and gate it on the built artifact** — `packages/client/ui-sidebar-terminal/src/client/LazyTerminalBody.tsx:5` (the `lazy` import) with the build-time proof at `packages/client/ui-sidebar-terminal/tests/bundle-split.client.spec.ts:10`. The spec reads the built `lib/client.js` and asserts that `/@xterm+xterm@` appears only in the deferred chunk and that the entry has exactly one `require.async`. A harness that ships a heavy optional dependency should have a gate of this shape — it is a few lines and it cannot be argued with.

- **Theme the app, but keep the *program's* overrides separate from the theme's defaults** — `packages/client/ui-sidebar-terminal/src/client/terminal-theme.ts:9` (the class) with the merge at `:72`. Program colours live in an indexed map and a special map; the app's colours live in `defaults`. A theme change re-applies the merge and the program's colours survive, and an OSC reset removes only the program's entries. A harness that themes its own output panels should keep the same separation.

- **Measure the *cell* behind a cursor, not the theme, to keep contrast** — `packages/client/ui-sidebar-terminal/src/client/terminal-cursor.ts:13`. The cursor marker class is removed so the cell's rendered colours (including reverse video) can be read, the contrast ratio is computed against WCAG's 3:1, and the result is published as CSS variables rather than by mutating xterm's theme. It works under a Vim colourscheme because it never consults the palette.

- **Animate list rows with the React commit lifecycle, not with observers** — `packages/client/ui-workspace/src/client/rows/AnimatedRows.tsx:52` (`getSnapshotBeforeUpdate`). The pre-commit snapshot holds the old rects; the post-commit pass animates the survivors from them and fades the leavers as inert clones in an overlay outside the scroller. The motion is *armed* by the first pointer/key event (`:54`), so a load never animates, and `prefers-reduced-motion` or a browser without `Element.animate` settles instead. A harness that reorders a task list on every model turn can animate it this way with zero layout observers.

- **A control that only exists while it works, and a dialog that stays until the *state* confirms the change** — `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx:1237` (the delete confirmation stays pending until the committed list no longer contains the id) with the reason at `:1256`. "Closing earlier exposes one stale React frame to the next Create Workspace gesture." The same care appears in the terminal package: a rename is only sent when the trimmed value differs from the current title.

- **Give the plugin a *test seam* that is not the plugin's internals** — `packages/client/ui-workspace/src/client/session-actions/derived.ts:12` and `packages/client/ui-workspace/src/client/index.ts:182` (the `pinInjected` factory) are the seam: a row action receives its whole behaviour through an injected face, so a test can exercise the action with a fake face and the wiring with a fake action. The package's own spec files state the split explicitly (`packages/client/ui-workspace/tests/session-actions.client.spec.tsx:3` and `packages/client/ui-workspace/tests/apply.client.spec.ts:1`).

- **A CSS-source contract test** — `packages/client/ui-workspace/tests/browser-styles.client.spec.ts:19` (`declarationsFrom`). A ~20-line rule parser turns the stylesheet text into a property map, and the spec asserts the scrollbar arithmetic, the row heights, the marquee masks and the *absence* of a `::-webkit-scrollbar` rule. This is a cheap, dependency-free gate for visual contracts that no screenshot test can pin as precisely.

---

## Files skipped (with reasons)

None. Every one of the 134 files in this shard was opened and read. Five very large test files
were read at a coarser granularity than the rest, and that is recorded per file below and in the
Uncertainties section — no file was skipped.

---

## Uncertainties

- **Partial reads of five very large spec files.** I read the headers, the fixture scaffolding
  and the full `describe`/`it` inventory of
  `packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx` (2657 lines),
  `packages/client/ui-workspace/tests/workspaces-service.client.spec.ts` (1513 lines),
  `packages/client/ui-workspace/tests/rows.client.spec.tsx` (1238 lines),
  `packages/client/ui-workspace/tests/session-actions.client.spec.tsx` (824 lines) and
  `packages/client/ui-workspace/tests/apply.client.spec.ts` (894 lines) — I did not read every
  assertion line in those five. Their subject matter is fully covered by the source files I read
  in full, and the test names give the behaviour, but a per-assertion audit of those five files
  was not performed.
- **The three Chinese READMEs were read partially** (`ui-sidebar-right/README.zh.md` first 60
  lines, `ui-sidebar-terminal/README.zh.md` first 40, `ui-workspace/README.zh.md` first 40). I
  confirmed the section structure, the anchors and the parity of the rules I could see; I did
  not diff the full Chinese text against the English. The `README.i18n.yaml` hash records are
  the mechanism that guarantees that pairing, and I read those in full.
- **The lens coverage is genuinely uneven across the listed lenses.** This shard contains **no
  agent loop, no tool-calling flow, no reasoning/thinking stream, no prompt construction, no
  provider request, no context-window management or compaction, and no model memory or learning
  mechanism.** All three packages state this in their own READMEs ("Model Experience: None …
  this package neither assembles nor sends a provider request"). I did not look for these
  elsewhere in the repo — that is other shards' work. The nearest *analogues* I could report are
  the attention watermark (context relief for a list), the tab-type priority bands (model-specific
  fallbacks), the `agentPreset` fallback ladder in `packages/client/ui-workspace/src/client/navigation.ts:262`
  (a real "the named variant is gone, fall back to the default" ladder), the terminal's connection
  phase machine (a real retry/reconnect/takeover state machine), and the row's
  `runningSubagentCount` read from the parent's loaded subagent catalog
  (`packages/client/ui-workspace/src/client/tree.ts:390`).
- **The three packages' dependencies were not read** (`@deepseek-ai/dsh-client-ui-dockkit`,
  `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-store`,
  `@deepseek-ai/dsh-api-terminal-controller`, `@deepseek-ai/dsh-api-workspace-controller`,
  `@deepseek-ai/dsh-api-session-controller`). Where the packages describe those contracts in
  prose I have quoted the package's own description; where the packages *use* them I have described
  the use, not the implementation. In particular the docking kit's planners (`planOpenContent`,
  `planSettle`, `record`, `replay`) are only known through the callers in this shard.
- **Two components in the terminal package are currently dead code.** `TerminalRecovery.tsx` and
  `TerminalCleanup.tsx` are implemented and have their own specs, but their registrations in
  `packages/client/ui-sidebar-terminal/src/client/index.ts:17` and `:102` are commented out, so
  neither is reachable in this build. I could not establish from this shard *why* they were
  disabled (the README says "Cleanup failures have no notification or manual retry action; saved
  unfinished close requests are retried when the Client plugin starts", which describes the
  *opposite* arrangement) — that note is the one place in the shard where the code and the prose
  appear to disagree, and I flag it rather than resolve it.
- **`dsh.client.inject` edges are load metadata, not ordering** — stated in
  `packages/client/ui-workspace/src/client/index.ts:95`. I took that at face value; no other shard
  was consulted to confirm it.
