# deepseek-harness / dsh-client-rest#3

## Shard shape

This shard is five browser-side packages of the deepseek-harness monorepo — `packages/client/ui-plugin-market`, `ui-reference`, `ui-secret-mask`, `ui-skill`, and `packages/client/web` — 106 files in total. None of them touch the model: every README in the shard states "Model Experience: None" and "KV Cache effect: None", except `ui-skill`, whose one model-visible effect is the host-side skill body injection it documents but does not implement. What the shard does hold is the *client half* of the harness's plugin architecture and three mechanisms that generalise well beyond their packages: (1) a declarative credential-format table with a derived, non-backtracking scanner and a differential test oracle that proves it equivalent to the regex implementation it replaced (`ui-secret-mask`); (2) a "keep the query your results answer" listing state machine with a document-identity guard and retry ladder (`ui-plugin-market`); (3) a two-stage boot kernel with a strict activation audit and a framework-free failure page (`client/web`). The four UI packages share one spine: a Cordis service mesh (`ctx.effect`, `ctx.slots`, `ctx.locale`), a `UserText` rule registry that turns sent user text into typed nodes, and a per-session Remote RPC discipline in which every candidate fetch must retain the Client Session, wait for its initial history open, and then talk to the Host.

## Per-file notes

### packages/client/ui-plugin-market/package.json
- Purpose: manifest of the Discover tab package `@deepseek-ai/dsh-client-ui-plugin-market` v0.2.1-rc.2.
- Key abstractions: `exports["./client"]` for the browser half, `exports["."]` for the (empty) Host half; `dsh.client.inject` names the packages the browser half needs (`dsh-api-remotes`, `dsh-client-locale`, `dsh-client-ui-plugin-manager`).
- Data flow: the loader discovers this package through the `dsh.client` declaration and injects the three listed packages.
- Non-obvious design decisions: `peerDependencies` holds only `@deepseek-ai/cordis`; every other workspace dependency is a devDependency, so the published bundle keeps its externals.
- Edge cases / failure handling: n/a.
- Surprising: `publishConfig.access: public` — this is a published npm package, not an internal app folder.

### packages/client/ui-plugin-market/README.i18n.yaml
- Purpose: bilingual-pair consistency record for `README.md`.
- Key abstractions: one hash per heading section per language.
- Data flow: `pnpm run verify-translation-pairing --write packages/client/ui-plugin-market/README.md` re-records the hashes.
- Non-obvious design decisions: hashes cover the English and Chinese blocks *outside* code blocks and generated regions, so a fenced example may differ freely.
- Edge cases / failure handling: n/a.
- Surprising: the same 16-hex digest shape as a content hash; the file is a machine-checked translation ledger, not documentation.

### packages/client/ui-plugin-market/README.md
- Purpose: package reference for the Discover tab (Plugins page → Discover): browse configured plugin market indexes, read an entry, install a version.
- Key abstractions: Discover is presentation only; the Host `pluginMarket` service "fetches and validates indexes; this package only presents them".
- Data flow: `pluginMarket.search` matches/filters/orders/pages; the tab sends the search text 250 ms after typing stops; 50 entries per page.
- Non-obvious design decisions: "Install" opens a confirmation dialog, then hands the *exact spec and registry* to the page's install dialog — "there is no spec form, and a refusal offers Retry"; the registry an entry names applies to that install only.
- Edge cases / failure handling: a failed read keeps the market's last listing and shows the Host's reason under the source in Index sources.
- Surprising: the "Provided by DSH" installation status — a bundle DSH ships itself cannot be replaced by the market.

### packages/client/ui-plugin-market/README.zh.md
- Purpose: Chinese mirror of the Discover package reference; content is the same narrative with the Chinese vocabulary (e.g. 插件市场索引 / 索引源).
- Key abstractions: same section anchors, same tables of contents.
- Data flow: n/a (doc).
- Non-obvious design decisions: it is the file the i18n pairing hash is computed against, so the two must be edited together.
- Edge cases / failure handling: n/a.
- Surprising: the Chinese doc uses a different term for "market" (插件市场) than the English "plugin market index" (插件市场索引) — vocabulary drift is a maintenance cost of this bilingual scheme.

### packages/client/ui-plugin-market/src/client/DiscoverSection.module.css
- Purpose: styles for the Discover toolbar, card list, entry page, and the two dialogs.
- Key abstractions: CSS-module classes (`.card`, `.cardOpen`, `.detail`, `.facts`, `.skeletonFill`).
- Data flow: class names are consumed by `DiscoverSection.tsx` via `import css from './DiscoverSection.module.css'`.
- Non-obvious design decisions: `.cardOpen::after { position: absolute; inset: 0 }` makes the *title button* cover the whole card so the card opens the entry, while `.cardEnd { position: relative; z-index: 1 }` keeps the Install action above it — one comment states the invariant.
- Edge cases / failure handling: `.description` uses `-webkit-line-clamp: 1` for a one-line description; `.skeletonFill` animation is disabled under `prefers-reduced-motion`.
- Surprising: `.marketName` truncates with `text-overflow: ellipsis` on a `flex` item with `min-width: 0` — the exact pattern August's `check:truncate` gate polices.

### packages/client/ui-plugin-market/src/client/DiscoverSection.tsx
- Purpose: the whole Discover tab UI — toolbar (market menu, search, labels menu, sort menu, refresh), card list, entry detail page, source dialog, install confirmation.
- Key abstractions: `EntryAction` (the one action an entry offers), `EntryCard`, `VersionRow`, `EntryDetail`, `SourcesDialog`, `ConfirmDialog`, `ListSkeleton`, `Browser`.
- Data flow: `props.useDiscover(snapshot => snapshot)` reads the controller's snapshot store; `props.useLocale(snapshot => snapshot.active)` reads the active language for collation and dates.
- Non-obvious design decisions: (a) the search box is **uncontrolled** — `const [text, setText] = useState(query.text)` with a 250 ms debounce effect, so typing never fights the store; (b) the *unsent* text, the open entry and the confirmation are component state, everything else lives in the controller; (c) `MarketIcon` remembers the `src` that failed (`useState<string>()` holding the URL, not a boolean) so a *different* icon URL that also fails still gets a chance.
- Edge cases / failure handling: an incompatible version renders a disabled Install with `aria-disabled` and a tooltip naming the running runtime; an entry with no compatible version offers no install at all; a failed listing keeps the previous results on screen beside the error and a Retry button.
- Surprising: `formatDate` uses `Intl.DateTimeFormat(language, { dateStyle })` with `timestamp * 1000` — the Host sends seconds.

### packages/client/ui-plugin-market/src/client/index.ts
- Purpose: the browser-half plugin body for Discover.
- Key abstractions: `apply(ctx)` registers the dictionary, the controller, three Host invalidation listeners, and the `plugins.tab` slot entry.
- Data flow: `ctx.slots.inject('plugins.tab', () => ctx.slots.register({ name: 'plugins.tab', id: 'discover', ... }, DiscoverSection))`.
- Non-obvious design decisions: the three invalidation sources are exactly `plugin-market/changed` (sources changed), `plugin-manager/changed` (installation status changed) and `connection/reset` (everything may differ); the source object is captured at registration so the plugin never reads services off a per-call argument.
- Edge cases / failure handling: `ctx.effect(() => () => { controller.dispose() }, 'ui-plugin-market: controller')` — the controller's teardown boundary drops late settlements.
- Surprising: the file declares `LocaleNamespaceMap['pluginMarket']` by module augmentation, so the dictionary key union is checked at compile time.

### packages/client/ui-plugin-market/src/client/locales.ts
- Purpose: the Discover dictionary, 84 keys, Chinese as the key-set source of truth and English checked with `satisfies Record<PluginMarketLocaleKey, string>`.
- Key abstractions: `zh` (const object) → `PluginMarketLocaleKey = keyof typeof zh`.
- Data flow: `ctx.locale.register('pluginMarket', { zh, en })`; `ctx.locale.bind(NS)` gives `t`.
- Non-obvious design decisions: `en` is typed against `zh` rather than the reverse, so adding a Chinese key without an English one is a compile error.
- Edge cases / failure handling: n/a.
- Surprising: the failure vocabulary is user-facing prose per failure kind (`readFailed` / `readInvalid` / `readChanged`) rather than raw error codes — the Host code is mapped to a kind in the controller first.

### packages/client/ui-plugin-market/src/client/market-store.ts
- Purpose: `DiscoverController` — the React-free owner of index-source reads, source edits, and the selected index's query and loaded pages, published through a snapshot store.
- Key abstractions: `DiscoverState` (status/indexes/selected/listing/editing/draft/saving/sourceFailure), `ListingState` (url/query/status/value/answered/failure), `DiscoverFace` (the injected actions), `ListingFailure` ('fetch' | 'invalid' | 'changed').
- Data flow: `ctx.remote.pluginMarket.listIndexes()` / `.search(url, query)` / `.setIndexes(urls)` → snapshot store → `useDiscover` in the component.
- Non-obvious design decisions: (a) the listing keeps **two** queries — `query` (what is being asked) and `answered` (what `value` answers) — so the empty-state wording follows the *shown* results while a new query is loading or after it failed (`market-store.ts:33`, `:529`); (b) a **document identity** guard: each page carries `fetchedAt`, and if the Host answers from a replaced document the list restarts *once*, and a second replacement fails with `failure: 'changed'` (`market-store.ts:221-229`); (c) late settlements are dropped by a monotonically increasing read counter (`indexRead`, `listingRead`) plus a `disposed` flag.
- Edge cases / failure handling: `failed` holds a closure that re-runs *the read that failed* — the first pages of a query or the next page — so Retry repeats the failing operation rather than a generic reload; `bundlesChanged` reloads every already-loaded page (page size = max(loaded, PAGE_SIZE)) to refresh installation status; a filter or sort key the answering index no longer declares is dropped and the query re-run (`declaredQuery`).
- Surprising: `load()` pages internally up to `MAX_PAGE = 100` per RPC while the *user-visible* page size is 50 — the client can ask for 100 so a "reload everything" needs one round trip.

### packages/client/ui-plugin-market/src/client/presentation.ts
- Purpose: pure helpers over market search results — query order, undeclared-id pruning, declaration ordering, source facts, index labels.
- Key abstractions: `DiscoverQuery`, `INITIAL_QUERY`, `withText`, `declaredQuery`, `displayDeclarations`, `presentedVersion`, `sourceFacts`, `indexLabel`.
- Data flow: pure functions over `MarketSearchResult.metadata` and the entries.
- Non-obvious design decisions: (a) `withText` flips `sort` between `index` and `relevance` *only* when the text becomes non-blank/blank and the sort was the automatic one — "an order chosen while text is present stays" (`presentation.ts:24-30`); (b) `declaredQuery` returns the *same object identity* when nothing was dropped, which lets the controller compare `declared !== query` to decide whether to re-issue the read (`presentation.ts:42`); (c) `displayDeclarations` uses `Intl.Collator(language)` and falls back to id code points, so Chinese and Latin titles order by the UI language.
- Edge cases / failure handling: `indexLabel` uses `URL.canParse` and falls back to the raw URL when the browser cannot parse it; `presentedVersion` falls back to `versions[0]` when the named default is absent.
- Surprising: `declaredQuery` returning identity rather than a fresh object is load-bearing for the "re-read once" behaviour — a structural clone would cause an infinite reload loop.

### packages/client/ui-plugin-market/src/css-modules.d.ts
- Purpose: ambient declaration that `*.module.css` default-exports a `Record<string, string>` of class names.
- Key abstractions: two `declare module` blocks, one for `*.module.css` and one bare `*.css`.
- Data flow: gives the CSS-module import a type without a bundler plugin.
- Non-obvious design decisions: the class map is untyped (`Record<string, string>`), so a typo in `css.foo` is not a compile error.
- Edge cases / failure handling: n/a.
- Surprising: this identical 6-line file is duplicated in three packages of this shard (`ui-plugin-market`, `ui-secret-mask`, `ui-skill`) and in `client/web`.

### packages/client/ui-plugin-market/src/index.ts
- Purpose: the Host half of the Discover package — an empty `apply()`.
- Key abstractions: none.
- Data flow: n/a.
- Non-obvious design decisions: the empty body exists only so the plugin appears in the host `cordis.yml`/Loader; the comment says so.
- Edge cases / failure handling: n/a.
- Surprising: a package with a 598-line browser half ships a 4-line Host half — the split is deliberate and every UI package in this shard does it.

### packages/client/ui-plugin-market/tests/browser-plugin.client.spec.ts
- Purpose: the plugin-registration spec: Discover contributes to `plugins.tab`, follows Host changes, and withdraws with its fiber.
- Key abstractions: a real `Context`, `SlotRegistry`, `LocaleRuntime` and `TestRemote` — no mocks of the framework.
- Data flow: `ctx.plugin({ inject: [...inject], apply })` then `remote.emit('plugin-market/changed')` / `ctx.emit('connection/reset')`.
- Non-obvious design decisions: the spec asserts `market.listIndexes` is **not** called before the tab's injected face runs `ensure()` — "reacts to Host changes only after the first render" is a deliberate laziness contract, not an accident.
- Edge cases / failure handling: after `fiber.dispose()` the slot list is empty.
- Surprising: the spec drives the real `SlotRegistry` and real locale runtime rather than a stub, so a rename of the slot id fails here.

### packages/client/ui-plugin-market/tests/discover.client.spec.tsx
- Purpose: the Discover UI spec — 15 cases over cards, filters, sorts, menus, the entry page, versions, dialogs and failure states.
- Key abstractions: `renderTab(state, dictionary)` builds a store-backed props object with `bindSnapshotSelector`; `answer(query, value)` republishes a listing the way the Controller does.
- Data flow: fire events on the rendered component and assert on the injected action mocks.
- Non-obvious design decisions: (a) the fake translator is a hand-rolled `{name}` substitution so the spec asserts *English copy* without a locale service (`discover.client.spec.tsx:15`); (b) the spec reproduces the Controller's `query`/`answered` split when publishing a listing — the component contract depends on two queries and the spec has to model it.
- Edge cases / failure handling: incompatible vs exempted versions, a failed read beside a kept listing, a disabled Refresh while loading, a "no matches" vs "empty index" wording distinction, Chinese copy and Chinese date format (`2026年9月`).
- Surprising: `expect(actions.search).toHaveBeenCalledExactlyOnceWith(typed)` — the debounce is asserted with fake timers at exactly 249 ms (no call) and 250 ms (call).

### packages/client/ui-plugin-market/tests/market-store.client.spec.ts
- Purpose: the controller spec — 15 cases over source reads, source edits, pagination, document replacement, retries, disposal and invalidation.
- Key abstractions: `catalog(count, fetchedAt)` builds a fake Host that answers pages of any query; `Promise.withResolvers` is used to hold a read open.
- Data flow: `face.ensure()` / `face.search(query)` / `face.more()` / `face.retry()` / `controller.bundlesChanged()` against the mocked `pluginMarket` remote.
- Non-obvious design decisions: the spec asserts the *exact* RPC shape (`FIRST_PAGE = { sort: { kind: 'index' }, offset: 0, limit: PAGE_SIZE }`) and the exact page sequence for a reload after a document swap (`[[0,100,undefined],[100,50,2],[0,100,undefined],[100,50,3]]`), which is how the "restart once, fail on a second replacement" rule is pinned.
- Edge cases / failure handling: a listing superseded by a newer read is ignored; a listing and a save that finish after `dispose()` are dropped; a failed source read leaves `status: 'error'` and `reload()` re-reads.
- Surprising: `expect(published.filter(status => status === 'ready')).toHaveLength(1)` — the "drop undeclared ids and read again" path must publish exactly one `ready`, i.e. no double-publish flicker.

### packages/client/ui-plugin-market/tests/node-plugin.client.spec.ts
- Purpose: six-line spec asserting the Host half's empty `apply()` does not throw.
- Key abstractions: none.
- Data flow: n/a.
- Non-obvious design decisions: the Host half exists only to appear in the Loader, so the only thing worth asserting is that it is callable.
- Edge cases / failure handling: n/a.
- Surprising: a spec whose entire content is `expect(() => { apply() }).not.toThrow()` — an explicit statement that the node half is a placeholder, not an omission.

### packages/client/ui-plugin-market/tests/presentation.client.spec.ts
- Purpose: unit spec for the pure helpers — collation order, relevance flipping, undeclared-id pruning, presented version, source facts, index label.
- Key abstractions: `resolveText` picks `zh` then `en`.
- Data flow: direct calls, no React, no store.
- Non-obvious design decisions: `expect(displayDeclarations({...}).map(...)).toEqual([...])` pins that equal titles break by **id code points**, and that `withText` preserves a chosen order while the text changes.
- Edge cases / failure handling: `indexLabel` on the unparseable URL `https://[` returns it verbatim.
- Surprising: the spec asserts `declaredQuery` returns the *identical object* (`expect(declaredQuery(declared, metadata)).toBe(declared)`), pinning the identity optimisation the controller depends on.

### packages/client/ui-plugin-market/tsconfig.json
- Purpose: project references for the Discover package.
- Key abstractions: `extends ../../../tsconfig.base.client.json`, `rootDir: src`, `outDir: lib/types`.
- Data flow: 13 project references (cordis vendor, remotes, plugin-manager, plugin-market, typert, package-manifest, plugin-market-index, locale, store, ui-plugin-manager, ui-primitives, ui-renderer, ui-slots).
- Non-obvious design decisions: every workspace package the client half touches is a TS project reference, so type-checking is per-package rather than one big program.
- Edge cases / failure handling: n/a.
- Surprising: the reference list is the de-facto dependency manifest — `package.json` lists only three runtime injections, but 13 packages are type-coupled.

### packages/client/ui-plugin-market/tsdown.config.ts
- Purpose: bundler config — `clientBundle(import.meta.dirname, ['lib/types/index.js'])`.
- Key abstractions: the shared `clientBundle` helper from `../tsdown.client.ts`.
- Data flow: produces `lib/index.js`, `lib/client.js`, `lib/types/**`.
- Non-obvious design decisions: the same three-line file in four client packages of this shard.
- Edge cases / failure handling: n/a.
- Surprising: `tsdown.config.ts` is a `.ts` file in every package, so bundler config is type-checked with the package.

### packages/client/ui-reference/locale/en.json
- Purpose: package metadata title for the plugin catalogue: `{"meta": {"title": "ui-reference"}}`.
- Key abstractions: `meta.title` / `meta.description`.
- Data flow: consumed by the plugin list UI, not by the UI dictionaries (those live in `src/client/locales.ts`).
- Non-obvious design decisions: two different "locale" notions coexist — package metadata JSON versus runtime dictionaries.
- Edge cases / failure handling: n/a.
- Surprising: `en.json` carries only a title while `zh.json` also carries a description — the two files are not symmetric.

### packages/client/ui-reference/locale/zh.json
- Purpose: Chinese package metadata — title "文件与会话引用界面" and a description of the `@` referencing.
- Key abstractions: same `meta` shape.
- Data flow: as above.
- Non-obvious design decisions: the catalogue shows the Chinese description, the UI shows the runtime dictionary.
- Edge cases / failure handling: n/a.
- Surprising: the runtime dictionary namespace is `reference` while the package title says ui-reference — three names for one thing.

### packages/client/ui-reference/package.json
- Purpose: manifest for `@deepseek-ai/dsh-client-ui-reference` v0.2.1-rc.2.
- Key abstractions: `dsh.client.inject` lists eight packages including `dsh-client-ui-input-trigger` and `dsh-api-session-controller`.
- Data flow: the loader injects them before the browser half loads.
- Non-obvious design decisions: `exports` also publishes `./locale/*.json`, so the plugin catalogue can read a plugin's metadata out of the installed package.
- Edge cases / failure handling: n/a.
- Surprising: `exports["./src/*"]` publishes raw source, so a plugin can be loaded unbundled.

### packages/client/ui-reference/README.i18n.yaml
- Purpose: bilingual pairing hashes for the ui-reference README (18 sections).
- Key abstractions: same `/section: {en, zh}` shape as the other packages.
- Data flow: regenerated by `verify-translation-pairing --write`.
- Non-obvious design decisions: hashes are per *heading section*, so a change in one section does not invalidate the others.
- Edge cases / failure handling: n/a.
- Surprising: the Dev Note section's hash pair `e67f633dc6fe7773` / `3bb0c20c93f16f98` is identical in four packages of this shard — every README ends with the same "Dev Note: None" boilerplate.

### packages/client/ui-reference/README.md
- Purpose: package reference for the unified `@file` / `@session` completion source.
- Key abstractions: the source is a `InputTriggerSource`; the plugin also owns the `file`/`folder` UserText matchers and their node renderers.
- Data flow: `fileReferences/list` and `sessionReferenceResolver/candidates` run in parallel; picks insert atomic references with a stable clipboard form.
- Non-obvious design decisions: (a) a **directory row carries two verbs** — the settling pick resolves the folder as an atomic reference, while the drill action (Tab / chevron / a header crumb) keeps plain editable path text so the user can descend (`README.md:32`); (b) a session is dated from the **Host session list's** `updatedAt`, not from the candidate's creation time, "so the `@` menu and the session list never disagree about its age"; (c) "Candidate failure is intentionally quiet" — one unavailable domain yields no rows for that domain while the other still lists.
- Edge cases / failure handling: an unretained Session or a failed history open prevents *both* RPCs; session search is metadata-only (id, cwd, latest log-backed title) — message bodies are not searched.
- Surprising: the KV-cache section states the exact boundary: "A selected file or session changes only the new user-message suffix and any Host-prepared session-reference context that follows that message; earlier target history remains unchanged."

### packages/client/ui-reference/README.zh.md
- Purpose: Chinese mirror of the ui-reference package reference.
- Key abstractions: same five sections and anchors.
- Data flow: n/a (doc).
- Non-obvious design decisions: it spells out the two-verb directory rule and the "candidate failure is intentionally quiet" limitation in the same order as the English, which is what the pairing hash enforces.
- Edge cases / failure handling: n/a.
- Surprising: the Chinese text preserves the English term "slot" and "UserText" untranslated — the hash forces structural parity, not terminological parity.

### packages/client/ui-reference/src/client/FileReference.tsx
- Purpose: the inline file chip and its local navigation-failure dialog; plus the non-interactive folder chip.
- Key abstractions: `FileReferenceInjected` (a Session-authorized `openFile`), `FileReference`, `FolderReference`.
- Data flow: `openFile(path)` is injected per Session; a throw is caught locally.
- Non-obvious design decisions: (a) the failure is caught **inside the chip** and rendered as a per-reference dialog, so "navigation failures keep the reference visible and offer a local retry/close dialog" — the chip never disappears and the error never surfaces at page level; (b) `FolderReference` ignores the injected action entirely, so a directory is a label even when file navigation is permitted.
- Edge cases / failure handling: `try { openFile(path) } catch { setFailedPath(path) }` — the dialog names the exact path.
- Surprising: `FolderReference` deliberately takes fewer props than `FileReference` (`{ node, raw }` only), so the type system prevents a folder from being wired to navigation.

### packages/client/ui-reference/src/client/index.ts
- Purpose: the browser half of the unified `@` reference source — candidates, ordering, labels, pick projections, and the file/folder node renderers.
- Key abstractions: `InputTriggerSource` with `candidates` / `header` / `onPick` / `openReference` / `codec`; `crumbsFor` builds the drilled breadcrumb.
- Data flow: `sessions.using(sessionId, { source: 'referenceCandidates', signal }, fn)` retains the Client Session across the two Remote calls and waits for the session's `openState === 'open'` before contacting the Host (`index.ts:81-98`).
- Non-obvious design decisions: (a) rows carry **only what distinguishes them** — a file names its parent directory (nothing at the workspace root), a directory names none because the breadcrumb already does, and a session names its workspace only when it is not the current one (`index.ts:8-13`); (b) the two lookups run in parallel and each degrades independently to an empty list; (c) `crumbsFor` refuses to publish a breadcrumb when any step cannot be written back as mention text — "a trail whose steps cannot all be written back as mention text would send the user somewhere they did not click"; (d) the source keeps candidate encoding internal to the registration effect; the `/client` export is `apply`/`inject` only.
- Edge cases / failure handling: `signal.aborted` after the await returns `[]`; a quoted path (`@"`) suppresses the session lookup entirely; `parseCandidate` returns undefined for a foreign candidate and `onPick` then returns undefined.
- Surprising: `onPick` for a directory has two different outputs — `{ insert: {...} }` for a pick and `{ text: value.mention, continue: true }` for a drill — one source, two verbs.

### packages/client/ui-reference/src/client/locales.ts
- Purpose: the `reference` dictionary (16 keys) for menu groups and the file-open dialog.
- Key abstractions: `NS = 'reference'`, `ReferenceKey = keyof typeof zh`, module augmentation of `LocaleNamespaceMap`.
- Data flow: `ctx.locale.register(NS, { zh, en })`; `t = ctx.locale.bind(NS)`.
- Non-obvious design decisions: the `time.*` bucket words are a **namespace-local copy** of the session-row vocabulary — "locale-owned copy keeps the words per plugin, while the bucketing they name is the one shared `relativeTime` in ui-primitives".
- Edge cases / failure handling: n/a.
- Surprising: duplicating the words per plugin is a deliberate trade (plugins can be dropped independently) that duplicates seven strings.

### packages/client/ui-reference/src/client/user-text-rules.ts
- Purpose: the `file` and `folder` UserText matchers that recognise `@path` in original sent text.
- Key abstractions: `nextPath(text, from, folder)`; `fileReferenceRule` and `folderReferenceRule`.
- Data flow: `match(text, from)` scans forward from an offset and returns `{ id, start, end, data }`.
- Non-obvious design decisions: (a) the token regex is `(?<!\S)(@"[^"\n]+"|@[^\s]+)` — the lookbehind requires an original whitespace boundary, so `mail@host` and `prefix@a.ts` are not references; (b) trailing sentence punctuation is stripped from an *unquoted* token (`.,;:!?，。；：！？`) but never from a quoted one, so `@"a!.md"` keeps its `!`; (c) the two rules are distinguished purely by whether the path ends in `/`.
- Edge cases / failure handling: the root path `@"/"` and `@/` are both recognised as folders with a fallback label; a token of length ≤ 1 is skipped.
- Surprising: the rules read **no Facts**, so a Facts change never re-runs them — the spec asserts the whole result object is *identical* across a Facts update.

### packages/client/ui-reference/src/index.ts
- Purpose: the empty Host half of the reference plugin.
- Key abstractions: none.
- Data flow: n/a.
- Non-obvious design decisions: the comment explains the whole dual-architecture convention in nine lines.
- Edge cases / failure handling: n/a.
- Surprising: "the empty apply exists so the plugin appears in the host cordis.yml / Loader" — a declaration, not an implementation.

### packages/client/ui-reference/tests/browser-plugin.client.spec.ts
- Purpose: 706-line spec for the reference source — service declaration, session retention, history-open gating, cancellation, ordering, labels, drill breadcrumbs, pick projections, codec, preview binding.
- Key abstractions: a `bench()` fixture that provides `sidebarRight`, `inputTriggers`, a fake `remote` service with `$host`, `remote.fileReferences`, `remote.sessionReferenceResolver`, `locale`, and a `TestSessions` store; `request(query, {quoted, signal})` builds a candidate request.
- Data flow: `source.candidates(session, request(...))` → rows; `source.onPick(...)` → insert/drill outcome.
- Non-obvious design decisions: the spec drives the real `UiConversation` and `UserTextRegistry`; fake timers freeze `Date` so the relative-time bucket is deterministic; the session's age is read from the Host session list's `updatedAt`, and the spec pins the fallback to `createdAt` for a session the list does not carry.
- Edge cases / failure handling: an unretained session rejects with "require a retained session"; a failed history open rejects with the reported error and sends **no** RPC; an aborted query returns `[]` without starting either lookup; a Remote failure in one domain yields no rows for that domain only.
- Surprising: `expect(source.candidates(session, request(''))).resolves.toEqual([])` for a *path that cannot be mentioned* (`bad\nname`) — the candidate is dropped because `formatFileMention` refuses it.

### packages/client/ui-reference/tests/file-reference.client.spec.tsx
- Purpose: the chip spec — opening the decoded path, non-interactive rendering, and the local retry/close dialog.
- Key abstractions: `props(openFile)` builds the component props; `makeTranslate(en)` from the test runtime.
- Data flow: `fireEvent.click` on the chip → `openFile('docs/a b.md')`.
- Non-obvious design decisions: the spec asserts the raw text is preserved in the `title` attribute (`@"docs/a b.md"`) so the user can see the exact source text even when the chip is not interactive.
- Edge cases / failure handling: four scripted `openFile` implementations — throw, throw, succeed, throw — prove the dialog survives a second failure and closes on the first success.
- Surprising: `expect(view.getByRole('button', { name: 'a b.md' }))` — the accessible name of the chip is the *label*, not the path.

### packages/client/ui-reference/tests/user-text-rules.client.spec.ts
- Purpose: spec for the file/folder matchers through the production UserText evaluator.
- Key abstractions: `UserTextRegistry` from ui-conversation's source tree, used directly.
- Data flow: `evaluate({ text, facts })` → nodes; the spec slices the original text back out with `text.slice(node.start, node.end)`.
- Non-obvious design decisions: the spec asserts the *result object identity* is preserved across a Facts update (`expect(evaluate(...)).toBe(before)`) — the evaluator's cache is proven, not assumed; it also asserts the node array is JSON round-trippable.
- Edge cases / failure handling: trailing punctuation stripped only for unquoted tokens; `prefix@a.ts` and `mail@host` are not references; `@"/"` and `@/` are folders.
- Surprising: `expect(file.mock.calls.map(([, from]) => from)).toEqual([0, text.indexOf(' ')])` — the matcher is called with forward-only offsets, which is what makes the evaluator linear.

### packages/client/ui-reference/tsconfig.json
- Purpose: project references for ui-reference (15 references).
- Key abstractions: `extends ../../../tsconfig.base.client.json`.
- Data flow: references `context/file-reference`, `context/session-reference`, `core/session`-adjacent packages, `ui-input-trigger`, `ui-conversation`, `ui-sidebar-right`.
- Non-obvious design decisions: the reference to `../../context/session-reference` is what makes the `SessionReferenceMentionCandidate` type available.
- Edge cases / failure handling: n/a.
- Surprising: the tsconfig lists 15 project references while `package.json` lists 20 devDependencies — the two are not in one-to-one correspondence.

### packages/client/ui-reference/tsdown.config.ts
- Purpose: bundler config — `clientBundle(import.meta.dirname, ['lib/types/index.js'])`.
- Key abstractions: shared `clientBundle` helper.
- Data flow: emits `lib/index.js` and `lib/client.js`.
- Non-obvious design decisions: identical to the other three client packages.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/ui-secret-mask/locale/en.json
- Purpose: package metadata — title `ui-secret-mask`, description "Masks recognized keys, tokens, and passwords in sent messages."
- Key abstractions: `meta.title` / `meta.description`.
- Data flow: plugin catalogue.
- Non-obvious design decisions: the description states the *scope* ("recognized"), not "all secrets" — the catalogue does not over-claim.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/ui-secret-mask/locale/zh.json
- Purpose: Chinese package metadata — "凭据遮挡" / "遮挡已发送消息中可识别的密钥、令牌与密码。"
- Key abstractions: same shape.
- Data flow: plugin catalogue.
- Non-obvious design decisions: same deliberate "可识别的" (recognized) qualifier.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/ui-secret-mask/package.json
- Purpose: manifest for `@deepseek-ai/dsh-client-ui-secret-mask` v0.2.1-rc.2.
- Key abstractions: `dsh.client.inject` = locale, ui-conversation, ui-renderer — three services, the smallest set in the shard.
- Data flow: the loader injects them; the plugin registers one UserText rule and one keyed node renderer.
- Non-obvious design decisions: no dependency on a crypto or redaction library — the whole scanner is hand-written against the shared `ui-conversation` contract.
- Edge cases / failure handling: n/a.
- Surprising: a 16 KB dependency-free credential scanner ships with three devDependencies.

### packages/client/ui-secret-mask/README.i18n.yaml
- Purpose: bilingual pairing hashes for the ui-secret-mask README (12 sections).
- Key abstractions: same `/section: {en, zh}` shape.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: the README has a distinct "what-is-masked" table section, which gets its own hash.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/ui-secret-mask/README.md
- Purpose: package reference for credential display masking in sent user text.
- Key abstractions: the mask is a *display* transform only — "the message text, the copy action, and the model input keep the original characters".
- Data flow: one UserText matcher `secret` → a keyed `conversation.user.text.node` renderer.
- Non-obvious design decisions: recognition requires a **published format**; free-form passwords and `name=value` assignments have no format and stay plain — "Named assignments stay plain because the same names also label ordinary values, such as token usage."
- Edge cases / failure handling: only UserText callers mask (session titles, turn previews, tool cards, assistant replies and the unsent composer draw credentials as written); a credential inside an earlier-starting reference is drawn by that reference.
- Surprising: the README names the perf gates it lives under — a user-text benchmark and a rationale note — and the equivalence oracle is kept in the repo as the proof that the linear matcher replaced the regex one.

### packages/client/ui-secret-mask/README.zh.md
- Purpose: Chinese mirror of the secret-mask package reference.
- Key abstractions: same sections including the "遮挡范围" (what is masked) table.
- Data flow: n/a (doc).
- Non-obvious design decisions: it states the same three stated limits (format-only recognition, only UserText callers mask, earlier reference owns its text).
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/ui-secret-mask/src/client/credential-formats.ts
- Purpose: the **data** definition of every credential format: the literal it starts with, its kind, the shape of the run after the literal, and the ASCII character classes the checks use.
- Key abstractions: class bits (`KEY`, `ALNUM`, `WORD`, `ALNUM_DASH`, `UPPER_ALNUM`, `LABEL`, `SCHEME`, `LOWER`, `USER`, `PASSWORD`), literal kinds (`KEY_BLOCK`, `ADDRESS`, `PREFIXED`), shapes (`RUN`, `BOUNDED`, `SK`, `GOOGLE`, `JWT`), and `CREDENTIAL_FORMATS` (29 entries).
- Data flow: `format-tables.ts` derives lookup tables from this list; `credential-scanner.ts` consumes the tables.
- Non-obvious design decisions: (a) the class bits are **packed into a `Uint16Array` of ASCII code points** so a character test is one array read plus a mask; (b) the `SK` shape requires a digit within the first 256 characters of the run, because "model services: `sk-` keys carry a digit, which hyphenated identifiers rarely do" — that is what stops `sk-button-primary-large-rounded` from matching; (c) the comment at the top of the kind list says "Same-start candidates resolve by ascending kind, so a token used as an address password is masked completely."
- Edge cases / failure handling: every format's `min` is above the 8 characters the mask leaves readable, so a masked range is always longer than its visible prefix.
- Surprising: `ADDRESS` is a *literal* (`://`), so the address-password format is found by the same prefix scan as the provider keys — one mechanism, not two.

### packages/client/ui-secret-mask/src/client/credential-masks.ts
- Purpose: builds the display form of a credential range — one `*` per code point, line breaks preserved, the `BEGIN`/`END` lines of a key block preserved.
- Key abstractions: `CredentialMasks` with `masked()`, `marks()`, `marksThen()`, `keyBlock()`, `range()`, `lines()`.
- Data flow: called by the scanner with `(text, kind, plain, start, end)`.
- Non-obvious design decisions: (a) a **shared 4096-character mark string** is sliced rather than repeated, so a one-line mask is one slice (`marksOnly.slice(0, count)`) — the allocation cost of masking is proportional to the *visible* result, not the secret; (b) `plain` selects between `marks()` and `range()`: a range that is entirely ASCII without line breaks can be masked by a slice, anything else needs a per-character pass; (c) the `range` loop steps over surrogate pairs so an emoji is one mark.
- Edge cases / failure handling: a lone surrogate counts as one character; a key block with no `END` line masks to the end of the text; a one-line key block is masked whole; CRLF line endings are preserved (`marksLf` / `marksCr`).
- Surprising: `keyBlock` keeps the `BEGIN` line and the `END` line **in the mask** — the user still sees the key type, which is what makes a masked private key still actionable.

### packages/client/ui-secret-mask/src/client/credential-scanner.ts
- Purpose: the prefix-pruned, linear credential scanner — "allocates nothing until it returns a node".
- Key abstractions: `CredentialScanner` with `match(text, from)`, plus private helpers `literalEndingAt`, `keyRunEnd`, `memoRunEnd`, `nextDigit`, `labelEnd`, `keyBlockEnd`, `schemeBefore`, `addressPassword`, `addressBefore`, `prefixedEnd`.
- Data flow: `match` runs the literal-only alternation, then per literal validates the candidate with bounded character comparisons and sticky `[class]*` runs, then `CredentialMasks.masked` produces the display string.
- Non-obvious design decisions: (a) **memoization in a flat `Int32Array(27)`** — run ends, the next digit, and the next key-block `END` line are each measured once per text, so all queries of one text cost linear time *together*; the memo is reset when the queried text changes; (b) the alternation contains **only literals**, no quantifier, so the regex engine cannot backtrack — the scan finds candidate *starts*, never candidates; (c) where a literal's suffix can begin another literal the scan **resumes inside** it (`literalOverlap`), so a key block whose first dash ends `sk-` is still seen; (d) an address password whose `://` precedes the query offset is found by walking back over the user name, but only when `:`, a password and `@` follow the offset, so "a query from anywhere inside an address finds the same password"; (e) overlapping candidates of any format join the earliest one and take its mask, "so no credential is drawn half masked".
- Edge cases / failure handling: a document with no `PRIVATE KEY-----` header yields `-1`; `labelEnd` reads at most 52 characters; `schemeBefore` reads at most 17 characters back; `addressPassword` caps the user name at 256 characters.
- Surprising: the class tables, literal tables, ending tables and the alternation source are all **derived once** from the declarative format list, so adding a credential format is a one-line data change and nothing else.

### packages/client/ui-secret-mask/src/client/format-tables.ts
- Purpose: derives the scanner's lookup tables from `CREDENTIAL_FORMATS`, once, on first use.
- Key abstractions: `FormatTables` (classes, literals, per-literal length/kind/shape/run/min/max, `literalOverlap`, `prefixSource`, `ending`, `sharedEndings`), `formatTables()`.
- Data flow: `credential-scanner.ts` constructor takes `formatTables()`.
- Non-obvious design decisions: (a) `alternation()` groups literals by their **first character** and factors only shared leading characters — "groups only factor literals and add no quantifier", preserving the no-backtracking property; (b) `ending` is a 128×128 table mapping a literal's last two code units to the literal index (+1, or -1 when several share the ending) so the scanner can identify the matched literal in O(1) from the regex's `lastIndex`; (c) `literalOverlap` is the length of the longest proper suffix of a literal that begins another literal.
- Edge cases / failure handling: `literalEndingAt` disambiguates a shared ending by comparing the tail text.
- Surprising: `tables` is a module-level `let` — a lazily built, shared, read-only singleton. The scanner holds typed-array views into it.

### packages/client/ui-secret-mask/src/client/index.ts
- Purpose: the browser half of the mask plugin — registers the dictionary, the `secret` UserText rule, and the keyed `secret` node renderer.
- Key abstractions: `inject = ['locale', 'slots', 'uiConversation']`.
- Data flow: `ctx.uiConversation.userText.register(createSecretRule())` then `ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({ key: 'secret', ... }, SecretText))`.
- Non-obvious design decisions: the module doc states the contract in one sentence — "Masking changes only the drawn text; the message text, copy actions, and model input keep the original characters."
- Edge cases / failure handling: n/a.
- Surprising: one `UserText` rule covers every caller (message bubbles, steering messages, pending echoes, queued messages, `/goal` bubbles) — one registration, six surfaces.

### packages/client/ui-secret-mask/src/client/locales.ts
- Purpose: the `secretMask` dictionary — exactly two keys, `secret.reveal` and `secret.hide`.
- Key abstractions: `NS = 'secretMask'`, `SecretMaskKey`, module augmentation.
- Data flow: `ctx.locale.register(NS, { zh, en })`; `t('secret.reveal')`.
- Non-obvious design decisions: the dictionary is scoped to the *control*, not to the masking — the masking is silent by design, so there is nothing to translate for it.
- Edge cases / failure handling: n/a.
- Surprising: a whole package's runtime dictionary is two strings.

### packages/client/ui-secret-mask/src/client/secret-rule.ts
- Purpose: the `secret` UserText rule — the entry point from the rule registry into the scanner.
- Key abstractions: `createSecretRule()` returns a `UserTextRule<'secret'>` owning one `CredentialScanner`.
- Data flow: `match: (text, from) => scanner.match(text, from)`.
- Non-obvious design decisions: (a) `order: 0` — "Same-start ties with other rules draw the credential masked", i.e. the secret rule wins a same-start contest; (b) the rule reads **no Facts**, "so Facts changes never invalidate its queries"; (c) each rule instance owns its own scanner, and the scanner's memo holds the last queried text "until a query for another text".
- Edge cases / failure handling: n/a.
- Surprising: the rule is a *factory* rather than a singleton, so each consumer of the registry gets an independent memo.

### packages/client/ui-secret-mask/src/client/SecretText.module.css
- Purpose: styles for the masked credential run and its reveal control.
- Key abstractions: `.secret` (inline-flex monospace box), `.value`, `.mask`, `.toggle`, `.icon`.
- Data flow: class names consumed by `SecretText.tsx`.
- Non-obvious design decisions: (a) the mask is drawn as an **SVG background tile** (`-webkit-mask: url(data:image/svg+xml…) left center / 1ch 100% repeat-x`) with `-webkit-text-fill-color: transparent` — the `*` characters stay in the DOM for copying and assistive tech but are not painted, and the tile is a centred asterisk glyph rather than the font's own asterisk "which sits near the cap height"; (b) the tile is sized `1ch` so "each mask character keeps its original character's advance, so revealing never reflows the line".
- Edge cases / failure handling: `.mask` and `.toggle` are shifted `-0.125em` because "the line-box center sits below the middle of the surrounding CJK and Latin glyphs" — the shift keeps the marks visually centred without moving layout.
- Surprising: this is a rare CSS technique — masking the *text* while keeping it selectable — done to get both pixel-centred marks and copyable text.

### packages/client/ui-secret-mask/src/client/SecretText.tsx
- Purpose: renders one credential masked, with a per-value reveal control in interactive text.
- Key abstractions: `MaskedText` (splits the mask into kept text and mask runs), `SecretText`.
- Data flow: `node.data.masked` is drawn; the reveal control swaps to `raw`.
- Non-obvious design decisions: (a) the component holds the **revealed original value**, not a boolean — "Holding the revealed value instead of a flag re-masks a different credential that reuses this element"; (b) `MaskedText` splits on `(\*+)` so kept text and mask runs are separate spans, and the mask run keeps its characters for copying and assistive technology but draws centred marks.
- Edge cases / failure handling: non-interactive text draws the masked value with **no** control at all.
- Surprising: the eye glyph is inline SVG drawn by hand (`EYE_CONTOUR` + a struck-through variant that drops the pupil so it stays distinct at text size) rather than an icon font.

### packages/client/ui-secret-mask/src/css-modules.d.ts
- Purpose: ambient CSS-module typing.
- Key abstractions: `declare module '*.module.css'` → `Record<string, string>`.
- Data flow: n/a.
- Non-obvious design decisions: duplicated verbatim in three packages of this shard.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/ui-secret-mask/src/index.ts
- Purpose: the empty Host half of the mask plugin.
- Key abstractions: none.
- Data flow: n/a.
- Non-obvious design decisions: same convention as the other UI packages.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/ui-secret-mask/tests/browser-plugin.client.spec.ts
- Purpose: the plugin-registration spec — services declared, matcher and renderer registered, and both released on fiber disposal.
- Key abstractions: real `Context`, `LocaleRuntime`, `SlotRegistry`, `TestSessions`, `UiConversation`.
- Data flow: `ctx.plugin({ inject: [...inject], apply })`.
- Non-obvious design decisions: the spec asserts the exact `inject` array `['locale', 'slots', 'uiConversation']` — the service list is a contract, pinned literally.
- Edge cases / failure handling: after disposal the rule registry and the slot registry are both empty.
- Surprising: it also asserts the node half's `apply()` does not throw, so the placeholder is covered too.

### packages/client/ui-secret-mask/tests/regex-oracle.client.ts
- Purpose: **the backtracking regex matcher this package replaced**, kept as a test-only equivalence oracle.
- Key abstractions: `PREFIXED` (17 global regexes), `FORMATS` (key block, address password via lookbehind, plus the prefixed set), `regexSecretRule`.
- Data flow: `regexSecretRule.match(text, from)` finds the nearest credential at or after `from` and joins overlapping matches.
- Non-obvious design decisions: the address-password pattern uses a **lookbehind** (`(?<=\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@?#]{0,256}:)`) so the match *starts* at the password and a query from inside the address finds the same candidate — this is the semantics the linear scanner had to reproduce.
- Edge cases / failure handling: `scan.hit = find(scan.regex, text, scan.hit.start + 1)` re-searches from one character in, so a key that starts inside another is joined and masked whole.
- Surprising: the header says "Not product code" — keeping the old implementation alive as an oracle is an explicit, unusual practice.

### packages/client/ui-secret-mask/tests/secret-rule-equivalence.client.spec.ts
- Purpose: the differential test proving the prefix-pruned matcher produces the same nodes as the regex oracle.
- Key abstractions: `FRAGMENTS` (49 fragments that begin, continue, break or end each format), a deterministic `generator(seed)` (mulberry32), `generated(count, seed, maxFragments)`, and a `FIXED` corpus of 22 hand-written adversarial strings.
- Data flow: both rules are registered in a `UserTextRegistry` alongside the whitespace rules, and both evaluators are compared with `toEqual` on every text × two Facts sets; the second case compares `rule.match(text, from)` for **every** offset from 0 to `text.length`.
- Non-obvious design decisions: (a) the generator is seeded and deterministic so "every run checks the same inputs"; (b) short fragments are repeated 1–40 times "so length thresholds are crossed on both sides"; (c) the FIXED corpus includes 2000-character repetitions of each prefix and of `a://u:` to pin the linear behaviour on the pathological inputs.
- Edge cases / failure handling: the equivalence is checked under `{ collapseWhitespace: true, trimWhitespace: true }` as well as no Facts, so the whitespace rules cannot break the credential boundaries.
- Surprising: 5,000 generated strings × 2 Facts sets × 2 evaluators, plus every-offset matching — this is the single strongest artefact in the shard.

### packages/client/ui-secret-mask/tests/secret-rule.client.spec.ts
- Purpose: the behavioural spec of the secret rule — 17 recognised formats, 6 near-miss negatives, and the masking forms.
- Key abstractions: samples are **assembled at run time** (`join('sk', '-', hex(32))`) "so the repository holds no literal in a credential format".
- Data flow: through the production `UserTextRegistry` evaluator.
- Non-obvious design decisions: the test file itself refuses to contain a real-looking credential — the same care applies to the `hex`/`mixed`/`stars` helpers, which build strings from character classes rather than literals.
- Edge cases / failure handling: `sk-button-primary-large-rounded` (hyphenated identifier without digits), `sk-12345` (too short), `task-…` (prefix inside a longer word), a commit hash, a UUID, `password=hunter2`, and addresses without a password are all left alone; an emoji in a password is one mark; a private key block cut off before its `END` line still masks; a block written on one line masks whole.
- Surprising: `expect(masks('postgres://u:p\u{1F642}\ud83dx@db')).toEqual([stars(4)])` — a surrogate pair and a lone surrogate each count as one mark.

### packages/client/ui-secret-mask/tests/secret-text.client.spec.tsx
- Purpose: the renderer spec — masked display without a control, reveal/hide with accessible names, and re-masking when a different credential reuses the element.
- Key abstractions: `props(raw, interactive, dictionary)`.
- Data flow: `fireEvent.click(reveal)` toggles `revealedRaw`.
- Non-obvious design decisions: the spec uses the **Chinese** dictionary by default so the accessible name is `显示密钥` — proving the locale seat is wired, not hard-coded English.
- Edge cases / failure handling: after `rerender` with a different `raw`, the value is masked again and `aria-pressed` is back to `false`.
- Surprising: the reveal control is `aria-pressed` rather than a `aria-label`-only button — the state is in the accessibility tree.

### packages/client/ui-secret-mask/tsconfig.json
- Purpose: project references for ui-secret-mask (5).
- Key abstractions: `extends ../../../tsconfig.base.client.json`.
- Data flow: references cordis vendor, locale, ui-conversation, ui-renderer, ui-slots.
- Non-obvious design decisions: the smallest reference set in the shard, matching the three-service `inject` list.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/ui-secret-mask/tsdown.config.ts
- Purpose: bundler config — `clientBundle(import.meta.dirname, ['lib/types/index.js'])`.
- Key abstractions: shared helper.
- Data flow: emits the two bundles and the type tree.
- Non-obvious design decisions: identical to the sibling packages.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/ui-skill/locale/en.json
- Purpose: package metadata — title `ui-skill`.
- Key abstractions: `meta.title`.
- Data flow: plugin catalogue.
- Non-obvious design decisions: only a title; no description, unlike the other packages' `en.json`.
- Edge cases / failure handling: n/a.
- Surprising: this is one of two packages in the shard whose `en.json` has no description.

### packages/client/ui-skill/locale/zh.json
- Purpose: Chinese package metadata — "技能引用与展示" / "在会话中提供技能引用和技能调用展示。"
- Key abstractions: same shape.
- Data flow: plugin catalogue.
- Non-obvious design decisions: the description mentions both halves (references and the call card) because the package owns two surfaces.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/ui-skill/package.json
- Purpose: manifest for `@deepseek-ai/dsh-client-ui-skill` v0.2.1-rc.2.
- Key abstractions: `dsh.client.inject` lists eight packages (remotes, session-controller, locale, ui-conversation, ui-renderer, ui-tool, ui-input-trigger, sidebar-right).
- Data flow: the loader injects them.
- Non-obvious design decisions: it depends on `@deepseek-ai/dsh-client-ui-tool` — this package owns a *tool call row*, not just a composer affordance.
- Edge cases / failure handling: n/a.
- Surprising: `@deepseek-ai/dsh-plugin-manager` is a devDependency even though the client listens to a `plugin-manager/changed` *event* — the event's type comes from the plugin-manager package's type declarations only.

### packages/client/ui-skill/README.i18n.yaml
- Purpose: bilingual pairing hashes for the ui-skill README (19 sections).
- Key abstractions: same shape.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: the README's "Model Experience" section has three sub-sections (what the model sees, token effect, KV cache effect), each hashed separately.
- Edge cases / failure handling: n/a.
- Surprising: this is the only package in the shard whose Model Experience section is not "None".

### packages/client/ui-skill/README.md
- Purpose: package reference for the `/` skill source and the dedicated skill tool row.
- Key abstractions: the `InputTriggerSource` for `/`, the `skill` keyed toolview, and the `skill` UserText rule + node renderer.
- Data flow: `skills/list` (addressed by `sessionId`) → candidates; the pick lands literal `/name ` text; the host's pre-step boundary (`dsh-tool-skill`) recognises the leading `/name` and injects the rendered body.
- Non-obvious design decisions: (a) **text is the truth** — "a hand-typed identical token is the same reference, and the host gesture boundary judges the sent text, not the menu interaction"; the source implements no adjudication hooks and no reference codec; (b) the tool row derives its name, lifecycle and body **only from the frozen call/result slice**, never from the current catalog, "so replay stays stable when installed skills or their descriptions change"; (c) a `modelInvocable: false` skill wears a "user-only" marker as a *description prefix* — the menu's only secondary text — rather than a badge.
- Edge cases / failure handling: catalog changes with no forwarded event keep the cached catalog (an on-disk `SKILL.md` edit forwards nothing) — stated as a known limit; result-only history pages fall back to the generic row because keyed dispatch needs the paired call in the runtime window.
- Surprising: the KV-cache section is precise: "Append-only: the injected message lands after the reusable history prefix. This package never edits earlier request tokens." And the token effect: the skill body is paid **unconditionally** rather than at the model's discretion.

### packages/client/ui-skill/README.zh.md
- Purpose: Chinese mirror of the ui-skill package reference.
- Key abstractions: same sections; the Chinese text keeps the English identifiers `pre-step`, `dsh-tool-skill`, `lexicon`.
- Data flow: n/a (doc).
- Non-obvious design decisions: it preserves the same five stated limitations, including the catalog-without-forwarded-event limit.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/ui-skill/src/client/index.ts
- Purpose: the browser half of the skill plugin — the `/` source, the per-session catalog cache, the `skill` tool row registration, and the `skill` UserText rule.
- Key abstractions: `CatalogFetch` (a shared promise + its own abort handle + the settled snapshot), `fetches: Map<SessionId, CatalogFetch>`, `lexiconListeners: Map<SessionId, Set<() => void>>`.
- Data flow: `fetchCatalog(sessionId)` → `sessions.using(sessionId, { source: 'skillCatalog', signal }, …)` → wait for `openState === 'open'` → `skills.list({ sessionId }, signal)`; candidates are ranked with `rankByName` and the per-keystroke filter runs **locally** over the settled snapshot.
- Non-obvious design decisions: (a) the in-flight fetch **deliberately outlives any single menu interaction** — "closing the menu must not kill the prewarm other consumers will hit, so it carries its own abort (fired only on invalidation/teardown) while a candidates caller with an aborted signal just returns early"; (b) **a failed fetch does not poison the key** — the failure handler deletes the entry so the next consumer retries; (c) invalidation is graded: `agent-preset/selected` drops **one** session's entry (the catalog belongs to the preset), `plugin-manager/changed` and `connection/reset` drop **everything**; (d) lexicon listeners are notified inside a `try/catch` per listener, because "settlement notifies from an ignored promise chain (a throw would surface as an unhandled rejection) and one faulty consumer must not starve the others"; (e) addressed subagent sessions resolve no candidates at all, "because the existing skill RPC requires an attached session; viewing their persisted history must not activate them".
- Edge cases / failure handling: an unretained session rejects with "skill catalog requires a retained session"; a failed history open rejects with the reported error and sends no RPC; a failed `skills/list` rejects with `skills/list failed: <code>: <message>`.
- Surprising: the cache is keyed by **session**, not by user or workspace, so one session's catalog is one RPC — "the per-keystroke candidates re-poll filters a settled snapshot locally, so one session costs one RPC."

### packages/client/ui-skill/src/client/SkillRow.module.css
- Purpose: styles for the skill tool row and its bounded Instructions disclosure.
- Key abstractions: `.card`, `.row`, `.leading`, `.chevron`, `.iconIdle`, `.chevronHover`, `.title`, `.separator`, `.summary`, `.errorSummary`, `.stoppedSummary`, `.bodyWrap`, `.instructionsCard`, `.instructions`, `.inspectButton`, `.visuallyHidden`.
- Data flow: class names consumed by `SkillRow.tsx`.
- Non-obvious design decisions: (a) every metric is expressed as `calc(24px + var(--dsh-content-font-delta, 0px))` so the row scales with the global content-font size — "on the same secondary font-size axis, line height, row height, and glyph scaling as ordinary Tool rows"; (b) the skill glyph cross-fades to a chevron on hover via two stacked elements (`.iconIdle` opacity 1 → 0, `.chevronHover` opacity 0 → 1); (c) `.inspectButton` is `opacity: 0` until `.card:hover` or `:focus-visible` — an affordance that appears on demand but stays keyboard-reachable.
- Edge cases / failure handling: `prefers-reduced-motion` removes the transitions; `.instructions` is `max-height: 260px` with `overflow: auto` so a huge skill body cannot push the transcript.
- Surprising: the `.visuallyHidden` class implements the screen-reader-only pattern locally (1×1, `clip`) rather than relying on a utility.

### packages/client/ui-skill/src/client/SkillRow.tsx
- Purpose: the dedicated `skill` tool-call row — a compact summary line plus an expandable Instructions card.
- Key abstractions: `SkillRowState` ('running' | 'ok' | 'error' | 'stopped'), `SkillRowModel` (name/output/errorSummary/state), `skillRowModel(block)`, `skillName(argsRaw, callId)`, `resultText(block)`.
- Data flow: props `block` (a `StartedToolCallViewProps['block']`) → `skillRowModel` → the rendered row; `block.call.argsRaw` for a settled call, `block.argsRaw` for a running one.
- Non-obvious design decisions: (a) `skillName` tolerates a **truncated JSON args prefix** from streaming — "Streaming can expose a truncated JSON prefix; its first line is still more useful than replacing the call with an unrelated catalog lookup" — and falls back to the raw args then to the `callId`; (b) the `preparing` phase renders a completely different, minimal row (icon + title only) and consults nothing — "preparation does not consult the installed catalog"; (c) the colour-only running sweep and the error tone are mirrored by visually hidden status text; (d) `resultText` flattens durable result blocks, stringifying non-text content, and the file notes "Keep aligned with ui-tool's models/tool-call-model.ts `resultText`".
- Edge cases / failure handling: `block.error?.code === 'interrupted'` maps to `stopped` (which keeps an explicit status string) rather than `error`; a failed call replaces the skill name with the first error line in the summary but the full error is available in the expanded card.
- Surprising: the row derives everything from the **durable call slice** — no catalog lookup, no live state — which is exactly what makes a replayed transcript stable.

### packages/client/ui-skill/src/client/SkillReference.tsx
- Purpose: the inline skill chip.
- Key abstractions: `SkillReferenceInjected` (a Session-bound `openSkill`).
- Data flow: `openSkill(node.data.name)` → the source's `openReference`.
- Non-obvious design decisions: the chip is interactive only when `interactive` is true; previews omit activation even when the entry has an injected action.
- Edge cases / failure handling: the injected action is the one that owns the failure — this component has no error state at all.
- Surprising: the label is rendered as `` `/${node.data.name}` `` — the slash is part of the visible label.

### packages/client/ui-skill/src/client/locales.ts
- Purpose: the `skill` dictionary — 9 keys for the tool row and the "user-only" menu marker.
- Key abstractions: `NS = 'skill'`, `SkillKey`, module augmentation.
- Data flow: `ctx.locale.register(NS, { zh, en })`.
- Non-obvious design decisions: `en` is checked against `zh` with `satisfies Record<SkillKey, string>`.
- Edge cases / failure handling: n/a.
- Surprising: `menu.userOnly` lives in the same namespace as the row copy even though it is menu copy — the namespace is the plugin, not the surface.

### packages/client/ui-skill/src/client/user-text-rules.ts
- Purpose: the `skill` UserText matcher — recognises `/name` in sent text, but only for names the caller confirmed.
- Key abstractions: `UserTextDataMap['skill'] = { name }` and `UserTextFacts['skillNames']`, both declared by module augmentation.
- Data flow: `match(text, from, context)` scans `/(?<!\S)\/([\w-]+)(?!\S)/gu` forward from the offset and reads `context.read('skillNames')`.
- Non-obvious design decisions: (a) the fact is read **lazily and only once a slash-token candidate exists** — so text with no `/token` never touches the facts at all and is never invalidated by a Facts change; (b) absence of the fact means "no skill references", so a message without a confirmed name is plain text; (c) the token requires whitespace boundaries on both sides, so `/x.md`, `/x/path` and `(/x)` are not skill references.
- Edge cases / failure handling: a name in the list that does not appear in the text simply produces no node.
- Surprising: the rule is the only one in the shard that reads a Fact, and it reads it exactly once per evaluation — the spec pins the read count.

### packages/client/ui-skill/src/css-modules.d.ts
- Purpose: ambient CSS-module typing.
- Key abstractions: `declare module '*.module.css'`.
- Data flow: n/a.
- Non-obvious design decisions: duplicated in three packages.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/ui-skill/src/index.ts
- Purpose: the empty Host half of the skill plugin.
- Key abstractions: none.
- Data flow: n/a.
- Non-obvious design decisions: same convention.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/ui-skill/tests/browser-plugin.client.spec.ts
- Purpose: the 594-line plugin spec — registration, HMR-safe disposal, the session-keyed catalog cache, the lexicon, the plain-text pick, user-only marking and reference previews.
- Key abstractions: a `bench(list, addressed, opening)` fixture with a fake `inputTriggers.registerSource` that captures the source, a `TestSessions` store with `retainFor`, and a `providePresentation` helper that captures slot registrations and dictionary registrations.
- Data flow: the spec drives the **captured source directly** ("Direct driving is deliberate: this spec owns only the source's own contract") rather than through the input-trigger menu.
- Non-obvious design decisions: (a) it asserts the exact RPC payload `[{ sessionId: 's1' }]` — "Exact payload: session address only — no agent or transport vocabulary"; (b) it pins the invalidation grading precisely: `agent-preset/selected` re-fetches only the named session, while `connection/reset` and `plugin-manager/changed` re-fetch both; (c) `it.each(['reset','preset','plugin','dispose'])` proves a pending preview is cancelled under all four invalidations even when the RPC completes late, and that `openResource` is never called.
- Edge cases / failure handling: an aborted caller yields `[]` but leaves the shared fetch warm; a failed fetch does not poison the key; an unretained session rejects; an addressed subagent session fetches nothing.
- Surprising: the HMR test asserts that a second `registerSource` for the same `('/','skill')` seat throws "already registered" while the live one holds it, and that disposing the fiber frees the name.

### packages/client/ui-skill/tests/skill-row-styles.client.spec.ts
- Purpose: a CSS **contract** spec — it reads `SkillRow.module.css` from disk and parses the declarations.
- Key abstractions: `declarations(selector)` extracts one rule's declarations with a regex over comment-stripped CSS.
- Data flow: `readFileSync` → regex → assertions on the exact declaration strings.
- Non-obvious design decisions: it asserts the row uses the *shared* ToolCall font axis by exact string (`font-size: var(--dsh-content-font-size-secondary, 13px)`, `line-height: calc(24px + var(--dsh-content-font-delta, 0px))`) and that the row, the leading box and the SVG all scale with the same delta.
- Edge cases / failure handling: a missing selector throws with a message naming it, so the failure is legible.
- Surprising: this is a static gate on a stylesheet — the same idea as August's `check:truncate`, but implemented as a vitest spec against the raw CSS text rather than the TypeScript AST.

### packages/client/ui-skill/tests/skill-row.client.spec.tsx
- Purpose: the tool-row spec — preparation, the compact summary, keyboard operation, running state, failure summary, stopped/structured outcomes, and the argument fallbacks.
- Key abstractions: `settled(over)` and `running(argsRaw)` build durable blocks; `props(block, inspect)` builds the owner props including a stub `useDisclosure`.
- Data flow: renders `SkillRow` and asserts on roles, `data-state`, and the `pre` content.
- Non-obvious design decisions: the spec asserts the *accessible name* of the collapsed row is the concatenation "加载技能dsh-manage-issues" (title + name) — the accessible name is the contract; it asserts the raw args JSON never appears in the collapsed row ("expect(view.container.textContent).not.toContain('{"name":"dsh-manage-issues"}')").
- Edge cases / failure handling: a truncated JSON args prefix, a scalar args string, an empty name and a null call each fall back differently (raw args → callId) and a null call renders **no** disclosure at all.
- Surprising: the spec covers `content: [{ type: 'reasoning', text: '…' }]` — a structured (non-text) result block is stringified into the disclosure as JSON.

### packages/client/ui-skill/tests/user-text-rules.client.spec.ts
- Purpose: the skill-reference matcher spec through the production evaluator.
- Key abstractions: `UserTextRegistry` from ui-conversation's source tree.
- Data flow: `evaluate({ text, facts })` → nodes.
- Non-obvious design decisions: (a) the spec pins the **call count** of `match` — `[0, 0, 11, 0, 11]` across three evaluations — proving the matcher is forward-only and that adding an unrelated name does not re-run it; (b) it asserts node *identity* is preserved when an unrelated name is added (`after.find(...)` `toBe` `before.find(...)`).
- Edge cases / failure handling: `/x.md`, `/x/path`, `(/x)`, `/x。` and `prefix/x` are all rejected; `\t/x` and a trailing `\n/x` are accepted because the boundary rule is whitespace, not punctuation.
- Surprising: the spec freezes `facts` and `text` with `Object.freeze` to prove the evaluator does not mutate its input.

### packages/client/ui-skill/tsconfig.json
- Purpose: project references for ui-skill (13).
- Key abstractions: `extends ../../../tsconfig.base.client.json`.
- Data flow: references remotes, session-controller, plugin-manager, core/session, cordis, locale, ui-renderer, ui-conversation, ui-tool, ui-primitives, ui-input-trigger, ui-slots, ui-sidebar-right, workspace-path.
- Non-obvious design decisions: `../../core/session` is referenced for the `SessionId` type.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/ui-skill/tsdown.config.ts
- Purpose: bundler config — `clientBundle(import.meta.dirname, ['lib/types/index.js'])`.
- Key abstractions: shared helper.
- Data flow: emits the bundles.
- Non-obvious design decisions: identical to its siblings.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/web/package.json
- Purpose: manifest for `@deepseek-ai/dsh-client-web` v0.2.1-rc.2 — the web boot kernel.
- Key abstractions: `exports["./injections"]` publishes `applyIndexInjections` on its own, because the static page owner and the WebWorker both need the injection interpreter.
- Data flow: `apps/web`'s Vite entry imports `AppWebEntry` from this package.
- Non-obvious design decisions: the package pins `zod` and `@tanstack/react-virtual` to **exact** versions (`4.4.3`, `3.14.10`) while everything else uses `workspace:*` — these are the shared module instances every dynamic bundle resolves against, so their versions are the shell's contract.
- Edge cases / failure handling: n/a.
- Surprising: `files` ships `lib/**/*.css` — the shell's CSS is part of the published artifact.

### packages/client/web/README.i18n.yaml
- Purpose: bilingual pairing hashes for the web package README (17 sections).
- Key abstractions: same shape.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: the README's "Source map" table section has its own hash, so editing the file-role table invalidates only that section.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/web/README.md
- Purpose: the boot kernel's package reference — two-stage boot, the framework-free boot page, and the shared module table.
- Key abstractions: `AppWebEntry`, `bootClient`, `mountClient`, `PLATFORM_MODULES`, `PRELOADED_CLIENT_EXTERNALS`.
- Data flow: `window.__ModuleLoader__.create({ boot, staticModules, … })` → prefetch the `immediately` tier → `bootClient` → `mountClient`.
- Non-obvious design decisions: (a) **the application waits for the full roster** — "one failed entry keeps the framework-free boot page visible with a per-entry report; partial UI availability is not supported"; (b) the kernel owns exactly three things — the module system, the Cordis Loader and the boot page; the Host owns the graph, the batch preload and the loader facade, so `AppWebEntry` "never knows the bootstrap package id or parses the wire format"; (c) a pre-injected page transport (`globalThis.__DSH_TRANSPORT__`) is adopted as the bundle transport, but explicit `seams` still win; (d) the initial activation audit is strict, but later page-local failures appear in Settings → Plugins → Plugin list.
- Edge cases / failure handling: `run(onFailure)` lets a carrier own the fatal presentation while the loading page stays visible — the desktop uses this to request native recovery.
- Surprising: the module table does **not** negotiate versions per plugin: "The shell supplies the dependency versions declared in this package's `package.json`".

### packages/client/web/README.zh.md
- Purpose: Chinese mirror of the boot kernel reference.
- Key abstractions: same sections, including the same nine-row source-map table.
- Data flow: n/a (doc).
- Non-obvious design decisions: it names the same limitation (no partial UI availability) in the same place.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/web/src/apply-injections.ts
- Purpose: the page-side interpreter for the Host's structured index-injection table.
- Key abstractions: `applyIndexInjections(rows, loadScript)`; row kinds `global`, `script`, `script-src`, `script-preload`, `style`, `html`.
- Data flow: the served `index.html` renders the same rows as text; a static worker page has no served HTML, so it executes the table directly.
- Non-obvious design decisions: (a) **rows execute strictly in table order**, "so a global row lands before the scripts that read it"; (b) `script-preload` is a documented no-op — "Some transports cannot preload without executing; loadScript owns the actual request"; (c) `assertNever(row)` makes an unknown row kind a runtime error rather than a silent skip.
- Edge cases / failure handling: `html` placement is `head` or `body` with `insertAdjacentHTML('beforeend', …)`.
- Surprising: `script` rows are injected as **inline** `<script>` elements with `textContent` (not `src`), so a served page and a worker page end up with the same execution semantics.

### packages/client/web/src/base.css
- Purpose: the shell's own stylesheet — mount defaults, the font stack, the darwin window-drag surface, and the text-autospace rules.
- Key abstractions: `html[data-platform='darwin']` scoped rules; the `[data-window-drag]` / `[data-window-drag-recall]` attributes; one `:is(…)` interactive subtraction rule.
- Data flow: loaded by `boot.ts` via `import './base.css'`; the platform attribute comes from the Electron preload.
- Non-obvious design decisions: (a) the darwin rule set is *one* drag declaration on the mark, so "no fixed band has to match any row's height"; (b) overlays portal to `document.body` beside `#root`, which puts them after every drag row in document order, and one rule subtracts them all (`body > :not(#root)`); (c) `text-autospace: normal` on the body with `no-autospace` on code/pre/diff/read/search/terminal containers, so literal payloads keep their column alignment.
- Edge cases / failure handling: the sheet imports **no** theme package — theme tokens arrive with the `ui-theme` client plugin, so the shell does not depend on the dynamic bundle.
- Surprising: the comment explains the whole app-region model in prose: "Electron composes app-regions from geometry in document order, so a drag rule must sit on a chrome row that precedes the overlays covering it — never on a content container."

### packages/client/web/src/boot-client.ts
- Purpose: the production client composition without the page — mount the Loader, create every manifest row, wait for quiescence, audit activation.
- Key abstractions: `bootClient(options)`, `assertEntriesActive(ctx, modules)`, `EntryStateLabel`.
- Data flow: `ctx.plugin(Loader)` → `loader.internal = modules` → `modules.entries.start(loader, manifest)` → `loader.await()` → `assertEntriesActive`.
- Non-obvious design decisions: (a) the audit **aggregates** every failure into one error naming each entry and *why* — "import failed: <message>", "pending (waiting for service: a, b)", "failed" — rather than failing on the first; (b) the missing-service list is computed from `entry.fiber.inject` against `ctx.get(service)`; (c) `onEntryState` is reported from the `internal/status` event so the boot page tracks fiber state, not a separate progress channel.
- Edge cases / failure handling: an entry with no fiber but a recorded `modules.importError(name)` reports the real error text; one with no record says "see console for the import error".
- Surprising: the singular/plural is handled in the message ("1 entry did not activate" vs "N entries did not activate") — a tiny detail that the spec pins.

### packages/client/web/src/boot-page.module.css
- Purpose: styles for the framework-free boot page.
- Key abstractions: `.boot`, `.card`, `.wordmark`, `.hint`, `.spinner`, `.failed`, `.failedTitle`, `.failedItem`.
- Data flow: the spinner reads `--dsh-boot-arc` (a CSS custom property) set by `BootPage`.
- Non-obvious design decisions: (a) the sheet carries its **own** fallback tokens (`--dsh-boot-label-primary` etc.) because "The framework-free boot page cannot depend on theme delivery succeeding"; (b) the progress arc is a conic-gradient masked by a radial-gradient ring — the arc degree is a CSS variable, so JS only sets one number.
- Edge cases / failure handling: a `:global(body[data-ds-dark-theme])` override provides the dark palette.
- Surprising: the progress indicator is a *conic gradient arc* whose sweep grows with the number of activated plugin entries — a boot progress bar that costs one custom-property write per entry.

### packages/client/web/src/boot-page.ts
- Purpose: the framework-free boot page and failure report.
- Key abstractions: `BootPage` with `setTotal`, `setState`, `fail`, `dispose`.
- Data flow: `internal/status` events → `setState(name, state)` → spinner arc + (on failure) a per-entry list.
- Non-obvious design decisions: (a) it is plain DOM + local CSS, "so bundle and plugin-activation failures remain visible" — React arrives only with the UI renderer, so a React-free page is the only thing that can report a React-free failure; (b) the spinner node is **reused** across renders (`this.spinner.parentElement !== this.card` check) so its animation phase is not restarted; (c) `updateProgress` computes a monotonic arc from `72deg` to `288deg` as entries activate.
- Edge cases / failure handling: `fail(message)` renders the thrown reason beneath the failed-entry list; the wordmark stays visible in both states.
- Surprising: the page is attached to the *container* the application will later mount into, and `dispose()` removes it — the boot DOM lives where the app DOM will be.

### packages/client/web/src/boot.ts
- Purpose: the web boot kernel — `AppWebEntry`, the class the browser entry runs.
- Key abstractions: `AppWebEntry` (`run(onFailure?)`, `dispose()`, `prefetchImmediateTier()`), `BootSeams`.
- Data flow: `await globalThis.__DSH_BOOT_READY__?.promise` → `window.__ModuleLoader__.create({ boot: window.__DSH_BOOT__, staticModules, … })` → prefetch → `bootClient` → `installWindowDragRecall` → `mountClient`.
- Non-obvious design decisions: (a) the **boot-readiness gate** — the boot page is drawn immediately and `run()` waits on a deferred the page owner resolves after it has applied the Host injection rows, so "an asynchronous bootstrap resolves it after its last row, or rejects it into the failure rendering below"; (b) the transport precedence is `__DSH_TRANSPORT__.loadBundle` as default, explicit `seams` winning; (c) the window-drag watcher is installed **before** the first mount, "so the surface the renderer draws is the one the first frame measures"; (d) `prefetchImmediateTier` swallows prefetch errors because "Prefetch only starts transport early; the Loader import retries and reports this bundle failure".
- Edge cases / failure handling: every failure path ends in either the carrier's `onFailure` or `this.page.fail(...)`; a missing `__ModuleLoader__` throws a named error.
- Surprising: the whole file is 123 lines and owns the entire boot sequence — but it deliberately owns *no* wire-format knowledge.

### packages/client/web/src/css-modules.d.ts
- Purpose: ambient CSS-module typing for the shell.
- Key abstractions: `declare module '*.module.css'`.
- Data flow: n/a.
- Non-obvious design decisions: duplicated in four packages of this shard.
- Edge cases / failure handling: n/a.
- Surprising: none.

### packages/client/web/src/index.ts
- Purpose: the shell library entry.
- Key abstractions: exports `AppWebEntry`, `BootSeams`, `getStaticModules`, `PLATFORM_MODULES`, `PRELOADED_CLIENT_EXTERNALS`, `applyIndexInjections`.
- Data flow: `apps/web` imports from here; the page owner imports `applyIndexInjections` from `./injections`.
- Non-obvious design decisions: the doc says "The shell's product is `AppWebEntry`" — the rest are the build-time contract.
- Edge cases / failure handling: n/a.
- Surprising: 12 lines, but it is the whole public surface of the boot kernel.

### packages/client/web/src/loader-status.ts
- Purpose: the fiber-state projection vocabulary for the boot page.
- Key abstractions: `FIBER_STATE` (a mirror of cordis's `FiberState` const enum), `LoaderEntryState`, `STATE_LABELS`.
- Data flow: `STATE_LABELS[entry.fiber.state]` → the boot page's per-entry label.
- Non-obvious design decisions: (a) the const enum is **mirrored as a value object** because "a const enum has no runtime object to import (and esbuild-based pipelines cannot inline it across modules)"; (b) `STATE_LABELS` is keyed by `FiberState` with no reverse mapping, "inlining-safe".
- Edge cases / failure handling: the mirror must be kept in step with the vendored cordis definition — the comment names the same rationale as `dsh-tool-cordis`'s mirror.
- Surprising: `STATE_LABELS` is `Record<FiberState, LoaderEntryState>` — a compile error if a new fiber state appears, which is the point.

### packages/client/web/src/mount.ts
- Purpose: the application mount handoff.
- Key abstractions: `mountClient(ctx, container)`.
- Data flow: `ctx.inject(['uiRenderer'], scope => scope.effect(() => scope.uiRenderer.mount(container), 'web boot: application mount'))`.
- Non-obvious design decisions: the mount runs through a **dependency fiber** on `uiRenderer`, "so replacing `uiRenderer` remounts the application" — the mount effect is reinstalled whenever the service is replaced, and the old mount's disposer runs first.
- Edge cases / failure handling: if `uiRenderer` is never provided the fiber simply never installs — no error.
- Surprising: the effect name `'web boot: application mount'` is a named effect, so it appears in the fiber tree by name during debugging.

### packages/client/web/src/platform.ts
- Purpose: the shared browser platform module list — the implicit external baseline every dynamic bundle resolves against.
- Key abstractions: `PLATFORM_MODULES` (11 specifiers), `PRELOADED_CLIENT_EXTERNALS` (currently empty), `PlatformModule`.
- Data flow: consumed by `seed.ts` (the static table) and by the bundler externals configuration.
- Non-obvious design decisions: the list is `as const` and is the **single source of truth** with the tsdown client externals; `PRELOADED_CLIENT_EXTERNALS` is an empty array rather than absent, so the shape is stable.
- Edge cases / failure handling: n/a.
- Surprising: `dsh.client.external` in a plugin adds only *exact non-baseline* requests — the baseline is implicit.

### packages/client/web/src/seed.ts
- Purpose: the static module table handed to the loader at boot.
- Key abstractions: `getStaticModules()` returning `Record<string, unknown>`.
- Data flow: the loader resolves a dynamic bundle's externals against exactly this set.
- Non-obvious design decisions: (a) values stay **shell-static imports** "so every bundle sees the same instance" — built-in and installed plugins in the same page share one React, one Cordis, one slot registry; (b) the return is `satisfies Record<PlatformModule, unknown>`, so "a word added to `PLATFORM_MODULES` without a static import here (or vice versa) fails to compile instead of drifting into a runtime require miss".
- Edge cases / failure handling: n/a.
- Surprising: the type-level projection is the mechanism that keeps the bundler config and the runtime table from drifting — a compile error instead of a runtime `require` miss.

### packages/client/web/src/window-drag/recall.ts
- Purpose: the shell's **one** window-drag watcher for the macOS desktop shell.
- Key abstractions: `installWindowDragRecall(options)` with two seams (`scheduleFrame`, `watchBox`); `movesRows`, `touchesRows`, `readBox`, `defaultScheduleFrame`, `defaultWatchBox`.
- Data flow: `MutationObserver` on `body` + `ResizeObserver` per row + transition/animation events → `arm()` → a per-frame `measure()` that compares each marked row's `getBoundingClientRect()` and pulses `RECALL_MARK` on `body`.
- Non-obvious design decisions: (a) the pulse is **clear-then-set** in the same frame — "the clear must be flushed before the measurement below reads it: one style pass between the two writes is what makes Electron observe a computed app-region value that changed back. Reordering these two statements silently drops the pulse"; (b) a **grace window** of two quiet frames exists because "a CSS transition's first frame still reports the box's from-value, so a report that arrives before the surface starts moving must not end the loop on its first unchanged sample"; (c) the watcher installs nothing outside `data-platform="darwin"`; (d) `touchesRows` ignores the watcher's *own* mark write, "or the watcher would re-arm from its own output every frame".
- Edge cases / failure handling: a child-list change in a container **without** a marked row is deliberately ignored ("a row whose box grows because its content did is a resize, which the box watcher reports"); a plain sibling inserted beside a marked row *does* re-arm, because only a container change can move a row without resizing it; a disposed watcher never measures from a frame its canceller could not cancel.
- Surprising: the whole file is a workaround for one Electron bug (electron#32341) generalised into a reusable "force a re-collection by perturbing a computed style" mechanism.

### packages/client/web/src/window-drag/regions.ts
- Purpose: the **executable statement** of the window drag-region composition rule.
- Key abstractions: `RegionRect`, `DRAG_MARK` ('data-window-drag'), `RECALL_MARK` ('data-window-drag-recall'), `INTERACTIVE_SELECTOR`, `containsPoint`, `isDraggableAt`.
- Data flow: `base.css` declares the same rules; the spec and the browser coverage scenario decide points through this module "so a claim about coverage has one meaning".
- Non-obvious design decisions: (a) the model is "the **last** matching box decides" — Electron composes app-regions by geometry in DOM order, ignoring stacking; (b) edges belong to the box (half-open rectangles) so adjacent boxes never both claim a point; (c) `INTERACTIVE_SELECTOR` is a comma-joined **string** (not an `:is()`) so the CSS can splice it into its own rule and the spec can compare it literally.
- Edge cases / failure handling: a point outside every box is undraggable; a later `drag` box re-adds what an earlier `no-drag` box removed.
- Surprising: the constant is the single source both the stylesheet and the composition model use, and a spec asserts they are byte-identical.

### packages/client/web/tests/base-styles.client.spec.ts
- Purpose: the shell stylesheet contract spec.
- Key abstractions: `importOrder(css)` extracts `@import` specifiers; `normalizedCss` strips comments and collapses whitespace.
- Data flow: `readFileSync` of `src/base.css` → assertions.
- Non-obvious design decisions: (a) it asserts the sheet imports **nothing** and never names the theme package — "leaves theme styles to the dynamic ui-theme client entry"; (b) it extracts the darwin `:is(…)` rule with a regex and asserts the selector list is **exactly** `INTERACTIVE_SELECTOR` — "a new interactive role is added in one place and a drift between the sheet and the composition model fails here"; (c) it asserts the exact drag rule text, including the whitespace normalisation.
- Edge cases / failure handling: the rule regex must match or the assertion says "base.css declares no darwin interactive no-drag rule".
- Surprising: the spec compares a **stylesheet** against a **TypeScript constant** — a cross-language contract check implemented by parsing the CSS text.

### packages/client/web/tests/boot-client.client.spec.ts
- Purpose: the composition and activation-audit spec.
- Key abstractions: `graphOf(ids)`, `modulesOf(graph, staticModules)`, `stateSink()`, and a `FakeEntry` loader double for `assertEntriesActive`.
- Data flow: `bootClient({ ctx, modules, manifest, onEntryState })`.
- Non-obvious design decisions: the spec asserts the *state sequence* per entry — `['loading', 'failed']` for a ghost row, and `loading` → `active` for a good one; it asserts that activating a seeded graph touches the bundle transport **not at all** (`expect(loaded).toEqual([])`).
- Edge cases / failure handling: a row waiting on a service the roster never provides reports "orphan: pending (waiting for service: nothing)"; a row with no fiber and no record reports "import failed (see console for the import error)"; the singular form is asserted separately.
- Surprising: `auditCtx` is a hand-built `{ loader: { *entries() {...} }, get }` object cast to `Context` — a tiny duck-typed double instead of a real Context, used to script exact fiber states.

### packages/client/web/tests/boot-page.client.spec.ts
- Purpose: the boot page spec — skeleton, progress arc, failed list, failure report, disposal.
- Key abstractions: `mount()` returns the element and the page.
- Data flow: `page.setTotal(2)`, `page.setState(id, state)`, `page.fail(report)`.
- Non-obvious design decisions: the spec asserts the exact arc angles (`72deg` → `180deg` → `288deg`) — the progress indicator's numeric contract is pinned, not just "it changed".
- Edge cases / failure handling: while entries are active or loading the word "Loading plugins…" stays and the failure report does not appear; a failure report replaces the spinner entirely; the spinner node is **the same element** across state changes.
- Surprising: `expect(el.querySelector('[data-dsh-boot-spinner]')).toBe(spinner)` — node identity is asserted, because preserving the node preserves the animation phase.

### packages/client/web/tests/boot.client.spec.ts
- Purpose: the whole-boot spec — failure rendering, carrier-owned fatal presentation, prefetch through the injected transport, out-of-order entry creation, and the boot-readiness gate.
- Key abstractions: `installFacade()` builds the stable `window.__ModuleLoader__` facade; `expectBootFailure(setup, message)` asserts the rendered failure.
- Data flow: `new AppWebEntry(container, { loadBundle }).run()`.
- Non-obvious design decisions: (a) the spec installs a **real** module system through `createClientModuleSystem` with a fake bundle transport; (b) it asserts the exact prefetch sequence — `expect(loaded).toEqual([applicationUrl])`, i.e. the immediate tier resolves through the one shared application batch URL; (c) the boot-readiness test proves the boot page is drawn *before* the Host injections are applied and that the same DOM node survives the transition ("expect(container.querySelector('[data-dsh-boot]')).toBe(page)").
- Edge cases / failure handling: a missing facade, a facade that throws on create, a missing boot manifest, and a duplicate graph entry each render a specific message; with a carrier-provided `onFailure` the loading page **stays** and the failure is not rendered on the page.
- Surprising: the "modules-dependent row created before the modules row" case proves the loader tolerates a forward reference (`expect(ctx.modules).toBeDefined()` inside the consumer's apply).

### packages/client/web/tests/mount.client.spec.ts
- Purpose: the mount spec — mount, unmount on disposal, remount on renderer replacement.
- Key abstractions: `provideRenderer(ctx, mount)` provides `uiRenderer` from its own plugin fiber so it can be replaced.
- Data flow: `mountClient(ctx, container)`.
- Non-obvious design decisions: the replacement test proves the *disposer runs before the new mount* — `first.unmount` is called when the first renderer fiber is disposed and `second.mount` afterwards.
- Edge cases / failure handling: with no `uiRenderer` provided, `mountClient` resolves and nothing is mounted.
- Surprising: `await ctx.fiber.dispose()` is what triggers `unmount` — the app's teardown is owned by the cordis tree, not by the renderer.

### packages/client/web/tests/window-drag-recall.client.spec.ts
- Purpose: the drag-watcher spec, driven entirely through the two scheduling seams.
- Key abstractions: a `harness()` that owns the frame queue and the per-row box watchers; `place(row, box)` overrides `getBoundingClientRect`; `settle(seams)` runs frames until idle.
- Data flow: `installWindowDragRecall({ document, scheduleFrame, watchBox })`.
- Non-obvious design decisions: (a) the spec owns the frame queue so "every pulse is decided by the test rather than by wall-clock timing"; (b) `settle` runs up to eight frames because every report opens a grace window; (c) the "keeps measuring after a report whose box has not moved yet" case reproduces the transition from-value trap explicitly.
- Edge cases / failure handling: a frame that arrives after disposal must not measure, mark or re-arm (the seam's canceller deliberately drops the frame on the floor); a disposed watcher ignores the DOM it used to watch; the platform guard installs nothing outside darwin; a document with no `ResizeObserver` watches no boxes.
- Surprising: the spec asserts the steady state precisely — "the mark is gone and the watcher is idle", `expect(seams.frames()).toBe(0)`.

### packages/client/web/tests/window-drag-regions.client.spec.ts
- Purpose: the composition-rule spec (node environment, no DOM).
- Key abstractions: `box(x, y, w, h, draggable)` builds a `RegionRect`.
- Data flow: `isDraggableAt(regions, x, y)`.
- Non-obvious design decisions: the spec pins the **direction** of the order — a later `no-drag` subtracts an earlier `drag`, a later `drag` re-adds — and that the decision is by document order "not by box size or direction".
- Edge cases / failure handling: edges are half-open; a point outside every box is undraggable; an empty region list is undraggable.
- Surprising: the last case asserts `INTERACTIVE_SELECTOR` does **not** contain `:is(` — the constant is a plain comma list so the stylesheet can splice it verbatim.

### packages/client/web/tsconfig.json
- Purpose: project references for the web shell.
- Key abstractions: `extends ../../../tsconfig.base.client.json`, `rootDir: src`, `outDir: lib/types`.
- Data flow: references store, cordis vendor, loader vendor, modules, ui-slots, ui-primitives, ui-dockkit, ui-renderer, host/webserver.
- Non-obvious design decisions: it **excludes** `**/*.legacy.*` — a deliberate carve-out for legacy files kept out of the type-check.
- Edge cases / failure handling: n/a.
- Surprising: the shell type-checks against `host/webserver` — the browser half imports the Host's injection-table type.

### packages/client/web/tsdown.config.ts
- Purpose: bundler config — `staticLinked(import.meta.dirname, ['lib/types/index.js', 'lib/types/apply-injections.js'])`.
- Key abstractions: the shared `staticLinked` helper (different from `clientBundle` used by the four UI packages).
- Data flow: emits `lib/index.js`, `lib/apply-injections.js`, the CSS and the type tree.
- Non-obvious design decisions: `apply-injections` is built as its **own** entry because the page owner imports it under a separate `./injections` export condition.
- Edge cases / failure handling: n/a.
- Surprising: the shell uses `staticLinked` while every UI package uses `clientBundle` — the shell links statically because it is the thing that *provides* the shared module instances.

## Ideas worth stealing

- **Keep the old implementation as a differential oracle and prove the rewrite equivalent** — `packages/client/ui-secret-mask/tests/regex-oracle.client.ts:88` keeps the backtracking regex matcher alive purely as a test oracle, and `packages/client/ui-secret-mask/tests/secret-rule-equivalence.client.spec.ts:84` compares the new linear matcher against it on 22 fixed adversarial strings plus 5,000 deterministically generated ones, under two Facts sets, and then again from **every** query offset (`secret-rule-equivalence.client.spec.ts:94`). For August: when replacing a hot path (the outbound scrub, the tool-argument parser, the receipt classifier), keep the previous implementation as an oracle file and gate the replacement on a generated differential test — the generator is seeded (`secret-rule-equivalence.client.spec.ts:33`) so the corpus is reproducible in CI.

- **A declarative format table + derived lookup tables, so a security rule is a data change** — `packages/client/ui-secret-mask/src/client/credential-formats.ts:67` declares 29 credential formats as data (literal, kind, shape, run class, min/max), and `packages/client/ui-secret-mask/src/client/format-tables.ts:41` derives the character-class table, the per-literal tables, the overlap table and the regex source from it, once (`format-tables.ts:36`). Adding a provider key is a one-line edit, not a code change. August's `secret_guard` / outbound scrub should have the same shape: one table of (pattern, kind, minimum length, digit requirement), one derivation step, one matcher.

- **A prefix-pruned matcher that cannot backtrack** — `packages/client/ui-secret-mask/src/client/credential-scanner.ts:123` drives a **literal-only** alternation (no quantifiers, so no backtracking) and validates each candidate with bounded character comparisons and sticky `[class]*` runs that "leave nothing to backtrack into"; the memo (`credential-scanner.ts:74`) measures each run end, the next digit and the next key-block `END` line **once per text** so all queries of one text cost linear time together. August runs a scrub over every outbound body; this is the shape that makes that affordable.

- **One mask string, sliced — masking must not cost more than the visible result** — `packages/client/ui-secret-mask/src/client/credential-masks.ts:15` keeps a shared 4096-character `'*'` string and slices it (`credential-masks.ts:41`), so masking a 64 KB secret allocates one 56 KB slice rather than 64 KB of `*` characters, and the range scanner steps over surrogate pairs so an emoji is one mark.

- **Keep the query your results answer, separately from the query being asked** — `packages/client/ui-plugin-market/src/client/market-store.ts:33` (`answered` beside `query`) lets the UI keep showing the previous results *and* the previous empty-state wording while a new query loads or after it fails (`market-store.ts:529`). August's turn loop has the same problem (a failed turn leaves the last assistant message on screen while the next one streams); the "what is being asked" vs "what is displayed" split is worth copying verbatim.

- **A document-identity guard for paged reads, with exactly one restart** — `packages/client/ui-plugin-market/src/client/market-store.ts:221` compares the `fetchedAt` of each page with the first page's; if the Host answered from a replaced document the list restarts **once**, and a second replacement fails with `failure: 'changed'` instead of looping (`market-store.ts:224`). August's re-read of persisted history after a shape repair has exactly this hazard.

- **Retry the operation that failed, not a generic reload** — `packages/client/ui-plugin-market/src/client/market-store.ts:206` stores a closure `failed = () => void this.load(url, query, count, refresh)` at the point of failure, so the Retry button repeats the *first pages of a query* or the *next page* as appropriate. August's error surface should carry the repair closure, not just a message.

- **An aggregated startup audit that names every failing entry and why** — `packages/client/web/src/boot-client.ts:66` collects `import failed: <message>`, `pending (waiting for service: a, b)` and `failed` for every non-active entry and throws one error listing them all (`boot-client.ts:87`). August's `e2e:smoke` is the analogue; this is the shape of its report.

- **A framework-free failure page that survives the failure it reports** — `packages/client/web/src/boot-page.ts:18` builds the boot page from plain DOM and local CSS precisely because "React arrives only with the UI renderer"; the spinner node is **reused** across renders so the animation phase is never restarted (`boot-page.ts:86`), and the page carries its own fallback colour tokens (`boot-page.module.css:3`) because theme delivery may be what failed.

- **Clear-then-set to force a re-collection, with a grace window for transitions** — `packages/client/web/src/window-drag/recall.ts:85` clears the mark attribute, measures, then re-sets it, and the comment states exactly why the order matters ("one style pass between the two writes is what makes Electron observe a computed app-region value that changed back. Reordering these two statements silently drops the pulse"); `recall.ts:32` adds a two-frame grace because "a CSS transition's first frame still reports the box's from-value". This is a generalisable trick for forcing a browser to re-measure or re-render a region.

- **Compare a stylesheet against a TypeScript constant by parsing the CSS text** — `packages/client/web/tests/base-styles.client.spec.ts:46` extracts the `:is(…)` selector list from `base.css` and asserts it is byte-identical to `INTERACTIVE_SELECTOR` (`packages/client/web/src/window-drag/regions.ts:56`), so a new interactive role is added in one place and drift fails the test. August's `check:truncate` / `check:design` gates are the same idea; the transferable piece is that the *model* should live in code and the stylesheet should be asserted against it, not the other way round.

- **A CSS contract spec that asserts exact declaration strings** — `packages/client/ui-skill/tests/skill-row-styles.client.spec.ts:18` asserts the row uses the shared ToolCall font axis by exact string (`font-size: var(--dsh-content-font-size-secondary, 13px)`), so a renamed token fails the spec instead of silently changing the row's typography.

- **A single-flight, session-keyed cache that a failed fetch does not poison** — `packages/client/ui-skill/src/client/index.ts:115` keeps one `CatalogFetch` per session (promise + its own abort + the settled snapshot); the failure handler deletes the entry so the next consumer retries (`ui-skill/src/client/index.ts:143`); the in-flight fetch deliberately outlives a single menu interaction because "closing the menu must not kill the prewarm other consumers will hit". August's provider/config caches want exactly this: per-scope key, single flight, failure not sticky.

- **Graded invalidation: one scope drops one key, a global event drops all** — `packages/client/ui-skill/src/client/index.ts:251` drops the recomposed session's entry on `agent-preset/selected`, while `plugin-manager/changed` and `connection/reset` drop everything (`ui-skill/src/client/index.ts:255`). The reasoning is recorded inline: "the catalog is the preset's, and a blank session may switch after the warm". August's plugin-manager and provider invalidations need the same grading.

- **Contain listener failures inside the notification loop** — `packages/client/ui-skill/src/client/index.ts:102` wraps each listener in a `try/catch` because "settlement notifies from an ignored promise chain (a throw would surface as an unhandled rejection) and one faulty consumer must not starve the others". August's event buses and progress callbacks have the same hazard.

- **Wait for the session's initial history open before contacting the Host, and retain the session across the call** — `packages/client/ui-reference/src/client/index.ts:81` and `packages/client/ui-skill/src/client/index.ts:123` both use `sessions.using(sessionId, { source, signal }, fn)`, which holds the Client Session for the duration and refuses to send the RPC when the session is not retained or its history open failed. August's browser-client ↔ Host boundary should have one such door rather than per-call-site checks.

- **A rule that reads no Facts is never invalidated by a Facts change** — `packages/client/ui-skill/src/client/user-text-rules.ts:26` reads `skillNames` lazily and only once a slash-token candidate exists, and `packages/client/ui-secret-mask/src/client/secret-rule.ts:33` reads no Facts at all; both are proven by asserting the evaluator returns the **identical** result object across a Facts update (`packages/client/ui-reference/tests/user-text-rules.client.spec.ts:28`). August's prompt-construction cache can use the same rule: a component that reads no volatile input must not be re-evaluated.

- **Derive a tool row from the durable call slice, never from live state** — `packages/client/ui-skill/src/client/SkillRow.tsx:58` derives the row's name, lifecycle and body from the frozen call/result block only, "so replay stays stable when installed skills or their descriptions change"; the row's own README states the rule. August's tool-call cards should have the same single source.

- **Tolerate a truncated JSON args prefix from streaming** — `packages/client/ui-skill/src/client/SkillRow.tsx:29` catches a JSON parse failure and falls back to the first line of the raw args, because "Streaming can expose a truncated JSON prefix; its first line is still more useful than replacing the call with an unrelated catalog lookup". August's malformed-tool-argument path has the identical input; this is the rendering-side twin of `json_salvage`.

- **Hold the revealed value, not a boolean, so a different secret re-masks** — `packages/client/ui-secret-mask/src/client/SecretText.tsx:50` stores `revealedRaw` and compares it with `raw`, so a different credential reusing the element starts masked. A small, correct pattern for any "reveal" affordance in August.

- **Rows carry only what distinguishes them** — `packages/client/ui-reference/src/client/index.ts:8` states the rule and the code obeys it: a file names its parent directory, a directory names none (the breadcrumb already does), and a session names its workspace only when it differs from the current one. August's transcript and picker rows should obey the same economy.

- **A plain-text pick so the host adjudicates, not the client** — `packages/client/ui-skill/src/client/index.ts:232` returns `{ text: '/name ' }` and implements no codec and no adjudication hooks, so "determinism lives host-side" and a hand-typed token is the same reference as a menu pick. August's slash/command pipeline can take the same decision: keep the client dumb, judge the text in one host-side place.

- **A "keeps the whole conversation, drops the difference" repair ladder** — not in this shard, but the shape of `market-store.ts:221` (one restart, then an honest failure) is the same ladder August's `_stuckRequestEscape` uses.

## Files skipped (with reasons)

None. All 106 files in the shard were opened and read; nothing was generated, vendored, binary, or too large to read.

## Uncertainties

- **The Host halves of these packages are not in this shard.** `packages/client/ui-plugin-market/src/index.ts`, `ui-reference/src/index.ts`, `ui-secret-mask/src/index.ts` and `ui-skill/src/index.ts` are all empty `apply()` bodies, and the packages that actually do the work (`packages/boot/plugin-market`, `packages/boot/plugin-manager`, `packages/context/file-reference`, `packages/context/session-reference`, `packages/skill/tool-skill`, `packages/client/ui-conversation`, `packages/client/ui-input-trigger`, `packages/client/ui-tool`, `packages/client/ui-primitives`, `packages/client/locale`, `packages/client/store`, `packages/client/modules`) belong to other shards. I read the client halves and their READMEs; where a statement about the Host appears (for example "the host's pre-step boundary (`dsh-tool-skill`) recognises a leading `/name` and injects the rendered body"), I verified it only as **documentation in this shard** — `packages/client/ui-skill/README.md:87` — and did not check the host implementation.
- **`rankByName` (the shared fuzzy ranker used by the skill source) is in `ui-primitives`, outside this shard.** `packages/client/ui-skill/src/client/index.ts:178` calls it; the spec at `packages/client/ui-skill/tests/browser-plugin.client.spec.ts:251` pins its observable behaviour (case-insensitive ordered subsequence, prefix hits first, ties keep host order), so I can state the contract but not the implementation.
- **`UserTextRegistry`, the `UserText` evaluator and the `InputTriggerService` are in `ui-conversation` / `ui-input-trigger`, outside this shard.** I inferred the forward-only evaluation and the Facts-driven re-evaluation from the specs in this shard (which assert the exact `match` call offsets and the identical-result-object property), not from the evaluator's source.
- **The Electron `app-region` behaviour** (that the last matching box in DOM order wins) is stated in the repo's own comments and modelled in `packages/client/web/src/window-drag/regions.ts:1`; I did not verify it against Electron's source, only against this shard's model and its spec.
- **`dsh-client-modules` (`ClientModuleSystem`, `parseBootManifest`, `ClientModuleLoaderTarget`) is outside this shard.** I read how `packages/client/web/src/boot.ts` and `boot-client.ts` consume it but not its implementation, so the boot-graph wire format is described only as this shard's README describes it.
- **Two `README.i18n.yaml` hash pairs are shared across four packages** (`e67f633dc6fe7773` / `3bb0c20c93f16f98` for the "Dev Note" section). I confirmed this by reading each file; I did not check whether the pairing tool would consider that a collision or an intended reuse of the same boilerplate.
- **The `benchmarks/user-text/user-text.bench.client.ts` and `.agents/notes/implemented/testing/2026-10-11-user-text-credential-matching.md`** referenced by `packages/client/ui-secret-mask/README.md:55` are outside this shard; the performance claims (linear time, allocation gates) are therefore reported here as the README's claims, not as measurements I made.
