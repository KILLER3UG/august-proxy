# deepseek-harness / dsh-client-sidebar#2

## Shard shape

This shard is two browser-side plugin packages of the DeepSeek Harness web/desktop client, and nothing else: `packages/client/ui-sidebar-documentpreview` (the right-Sidebar "document preview" tab type, 182 files) and `packages/client/ui-sidebar-files` (the right-Sidebar workspace file-tree tab type, 39 files). Neither package touches the agent loop, the model, or any model-facing surface — both READMEs say so explicitly ("Model Experience: None… registers no tool, prompt section, or session event", `packages/client/ui-sidebar-documentpreview/README.md:131`). The value of the shard is therefore **not** in agent-loop machinery but in the surrounding engineering discipline a harness needs anyway: a plugin-extension contract (a registry of renderers + a keyed slot for their bodies), an async-lifecycle discipline (every read carries an `AbortSignal`, a monotonic generation counter, and a store that outlives the component), a trust boundary for rendering untrusted bytes (sanitized HTML in an opaque iframe, a disposable parsing Worker, an in-memory copy of an OOXML package), a bounded cache with a correct cancellation story, and a fuzz campaign that validates a parser against *independently written* files.

The two packages are structurally identical, which is itself the design: each is `definition` (what the tab type IS) → `store` (what it keeps) → `face` (its async half, bound to a Remote) → a body component (what it draws) → `locales` (what it says) → `index.ts` (wiring). The preview package adds a per-format renderer subtree (`code`, `text`, `markdown`, `html`, `image`, `pdf`, `office`, `excel`, `zoom`) under a shared `document/` contract; the files package adds a watch-driven directory tree (`directory-node.ts`) on top of the same store/face split.

---

## Per-file notes

### packages/client/ui-sidebar-documentpreview/package.json
- Purpose: package manifest for `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` v0.2.1-rc.2.
- Key abstractions: the `dsh.client.inject` list (8 sibling plugins the preview depends on at runtime) and `dsh.client.platform: "web"`.
- Data flow: `exports` maps `.`, `./client`, `./src/*` and `./locale/*.json`; `files` ships only `lib/*.js` + `lib/types`.
- Non-obvious design decisions: the heavyweight parsers (ExcelJS, SheetJS CE, PapaParse, fflate, PDF.js, FortuneSheet) are **devDependencies, not dependencies** — they are bundled, not imported at runtime by a consumer. `xlsx` is pinned to a CDN tarball URL (`https://cdn.sheetjs.com/xlsx-0.20.3/…`), not the npm registry, because SheetJS CE is not published there.
- Edge cases / failure handling: n/a (manifest).
- Surprising: `@fortune-sheet/core` and `@fortune-sheet/react` are pinned to the exact `1.0.4` with a linked patch rationale elsewhere in the repo — the preview is hostage to a third-party spreadsheet engine's quirks.

### packages/client/ui-sidebar-documentpreview/README.md
- Purpose: the package's contract document: what the type registers, how it reads, the Excel and Office preview behaviour, navigation, and the stated limitations.
- Key abstractions: the two-stage registration (type into `ctx.sidebarRightTabs`, body into the keyed `sidebar.right.pane.tab` seat) and the three loading modes (`text-pages`, `bytes-complete`, `renderer`).
- Data flow: a description of the whole package, end to end.
- Non-obvious design decisions: the doc is unusually honest about its own limits — "A failed PDF chunk load requires a page reload" (React caches a rejected lazy import for the page lifetime), "Scroll writes are unthrottled", "Byte-view scroll state is not restored".
- Edge cases / failure handling: the "Known Limitations and Deferred Work" section is the load-bearing part; it names every place the preview silently degrades.
- Surprising: the file is 157 lines but ~30 KB — the line count hides that each "line" is a multi-hundred-word paragraph.

### packages/client/ui-sidebar-documentpreview/README.zh.md
- Purpose: the Chinese translation of the same package contract, section-for-section.
- Key abstractions: identical to the English file.
- Data flow: n/a (docs).
- Non-obvious design decisions: the Chinese text preserves the *reasoning* rather than translating only the nouns — e.g. the background/foreground cache reservation is stated as "后台请求为前台工作保留最后一个在途请求槽和读者槽".
- Edge cases / failure handling: same limitations section, translated.
- Surprising: `README.i18n.yaml` next to it records a per-heading hash of the English and Chinese blocks, so a one-sided edit is detectable — a bilingual-pair gate I have not seen in the August repo.

### packages/client/ui-sidebar-documentpreview/README.i18n.yaml
- Purpose: per-section hash record pinning the English and Chinese README blocks to each other.
- Key abstractions: a flat map of heading path → `{en, zh}` hex hash.
- Data flow: produced by `pnpm run verify-translation-pairing --write <file>` and checked by CI.
- Non-obvious design decisions: the hash covers "blocks outside code blocks and generated regions", so a code sample can differ without failing the pair.
- Edge cases / failure handling: the file itself states the command to re-record after editing either side.
- Surprising: this is a *content* gate, not a link gate — it catches a Chinese section that was never translated.

### packages/client/ui-sidebar-documentpreview/locale/en.json
- Purpose: package-level locale metadata for the extension marketplace listing.
- Key abstractions: `{ "meta": { "title": "ui-sidebar-documentpreview" } }`.
- Data flow: n/a.
- Non-obvious design decisions: the English title is the raw package id while the Chinese one is human prose ("文档预览面板") — a deliberate asymmetry.
- Edge cases / failure handling: n/a.
- Surprising: trivial file, but it proves the repo treats *package metadata* as localizable.

### packages/client/ui-sidebar-documentpreview/locale/zh.json
- Purpose: the Chinese counterpart of the marketplace metadata; adds a `description` the English one lacks.
- Key abstractions: `meta.title`, `meta.description`.
- Data flow: n/a.
- Non-obvious design decisions: the two dictionaries are not symmetric in shape, so a consumer must treat `description` as optional.
- Edge cases / failure handling: n/a.
- Surprising: the same asymmetry means a UI that renders `meta.description` shows nothing on the English side.

### packages/client/ui-sidebar-documentpreview/licenses/FortuneSheet.txt
- Purpose: the FortuneSheet MIT licence text, bundled because FortuneSheet omits its repository licence from the npm payload.
- Key abstractions: n/a.
- Data flow: read by `tsdown.config.ts:excelLicenseBanner()` and injected as a `//`-prefixed banner into the published `client.excel.js` chunk.
- Non-obvious design decisions: the licence is re-emitted *inside the artefact* rather than shipped as a separate file, and a test asserts it is present in the packed tarball.
- Edge cases / failure handling: n/a.
- Surprising: a whole source file exists in the repo solely so the bundler can paste a licence into a JavaScript chunk.

### packages/client/ui-sidebar-documentpreview/src/index.ts
- Purpose: the **host** half — injects validated preview settings into every served browser page.
- Key abstractions: `Config` re-export; the `webserver/index-inject` hook.
- Data flow: `Config(...)` → `ctx.on('webserver/index-inject', table => table.push({ kind: 'global', name: '__DSH_DOCUMENT_PREVIEW_CONFIG__', value: config }))` → the client reads `globalThis.__DSH_DOCUMENT_PREVIEW_CONFIG__`.
- Non-obvious design decisions: configuration reaches the browser through a *global injected into the HTML page*, not through a per-session Remote call — one page-wide config for the whole connection.
- Edge cases / failure handling: `?? {}` defaults when the global is absent, so the client can boot without the host plugin.
- Surprising: the client reads its own config from a global that the *host* wrote, and `src/client/index.ts:89` is the only consumer — a deliberate, if unusual, seam.

### packages/client/ui-sidebar-documentpreview/src/config.ts
- Purpose: the schemastery schema for the two limit families (Office cache reuse, Excel parser).
- Key abstractions: `Config` interface + `Config` schema, with `office.{maxCachedEntries=8, maxCachedBytes=64 MiB, maxPending=8, maxReaders=32}` and `excel.{maxBytes=16 MiB, maxCells=250000, timeoutMs=15000}`.
- Data flow: Host parses YAML → validated object → injected global → client `Config(...)` re-validated in `src/client/index.ts:89`.
- Non-obvious design decisions: every field is `z.natural().min(1)` — a **zero is rejected**, not treated as "unlimited", because every one of these limits is a resource bound.
- Edge cases / failure handling: `timeoutMs` is capped at `2_147_483_647`; the other fields at `Number.MAX_SAFE_INTEGER`.
- Surprising: the config is validated *twice* — once by the host schema and once in the browser — so a hand-edited injected global still cannot produce a zero limit.

### packages/client/ui-sidebar-documentpreview/src/css-modules.d.ts
- Purpose: ambient declarations for `*.module.css` and `*.css` imports.
- Key abstractions: `declare module '*.module.css' { const classes: Record<string, string>; export default classes }`.
- Data flow: gives the CSS-module class names a `string` type so `clsx(css.a, css.b)` type-checks.
- Non-obvious design decisions: the module map is typed as `Record<string, string>` rather than generated per file, so a typo in a class name is not a compile error.
- Edge cases / failure handling: n/a.
- Surprising: the class name is a plain `string`, so `css.foo` on a class that does not exist type-checks and silently renders `undefined` into the DOM.

### packages/client/ui-sidebar-documentpreview/src/client/index.ts
- Purpose: the browser half — registers the `text` tab type, the dictionaries, the body seat, the chip title, and all eight builtin renderers.
- Key abstractions: `ctx.documentPreviews` (the renderer registry, provided via `ctx.reflect.provide`), the keyed `sidebar.right.pane.tab` seat with four child slots, and `ctx.slots.inject` (a renderer waits for the child seat to exist before registering its body).
- Data flow: `apply(ctx)` → reads `__DSH_DOCUMENT_PREVIEW_CONFIG__` → builds `DocumentPreviewRegistry` → `ctx.effect(() => ctx.sidebarRightTabs.register(textDefinition()))` → `ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({...}, TextPreview)))` → then `registerText/registerMarkdown/registerHtml/registerImage/registerPdf/registerOffice/registerExcel/registerCode(ctx)`.
- Non-obvious design decisions: **every import from another client plugin is a type-only import** (lines 13–21) — the preview depends on other plugins only through their *declared* surfaces, so a load-order problem is impossible. The registry is provided through `ctx.reflect.provide` (line 91) so other plugins can inject their own renderers.
- Edge cases / failure handling: the whole plugin is disposed as a unit — `ctx.effect(() => disposePreviews)` ties the registry's lifetime to the plugin's.
- Surprising: `registerOffice` and `registerExcel` are the only two that take a config argument; every other renderer is configuration-free.

### packages/client/ui-sidebar-documentpreview/src/client/definition.ts
- Purpose: what the `text` tab type IS.
- Key abstractions: `TEXTPREVIEW_KIND = 'text'`, `TEXTPREVIEW_ID`, `textDefinition()`, `basenameOf()`.
- Data flow: `patterns: ['dsh-resource://file/[\\s\\S]+']` matches every file address; `canOpen` requires `parseFileAddress(address)?.scope === 'session'`; `priority: 'fallback'`.
- Non-obvious design decisions: the pattern uses a **character-class repetition** (`[\s\S]+`) rather than a globstar, because "a character-class repetition includes literal dot segments that globstar excludes" (line 49) — the address must keep `.` and `..` verbatim so the Host resolves them, and the content identity must stay byte-identical.
- Edge cases / failure handling: `basenameOf` decodes the last segment with `decodeURIComponent` inside a `try`; a malformed percent sequence returns the raw name rather than refusing the address ("showing it raw beats refusing the address").
- Surprising: `title` is a *function of the address*, so the registry computes the chip title itself — the body never names the file.

### packages/client/ui-sidebar-documentpreview/src/client/face.ts
- Purpose: the preview's async half — performing paged reads, whole-file byte reads, and renderer-owned loads, and writing every outcome through the store's own actions.
- Key abstractions: `TextInjected` (the face the body receives), `TabReads` (per-tab bookkeeping: `group`, `generation`, `version`, `mode`, `rendererId`, `controller`), `modeOf()`.
- Data flow: `loadPage(tabId, file, offset, signal, observedVersion)` → `remote.workspaceFiles.read(...)` → on settle, generation check → `actions.page(...)` or `actions.failed(...)`; `loadAll` → `readBytes` → `actions.complete(...)`.
- Non-obvious design decisions: **a monotonic `generation` counter per tab replaces every "is this still current?" check** (lines 133–145). Mode or renderer change aborts the in-flight controller, bumps the generation, clears the version and calls `actions.reset`. A page of a *newer* file version arriving past line 1 restarts the whole walk from line 1 rather than mixing versions (lines 159–162).
- Edge cases / failure handling: the abort listener is armed **once per tab** by the first read and forgets the bucket, the group, and the bookkeeping in one place (lines 125–130) — "however often its body mounts". A byte read that *rejects* (rather than returning a failure) is wrapped into a synthetic `RemoteError` with code `gateway/internal` (lines 186–192).
- Surprising: the read runs under the session named **by the file's address**, not the session the face was injected for ("the address is the read's whole authority", lines 7–8).

### packages/client/ui-sidebar-documentpreview/src/client/store.ts
- Purpose: the preview's own state — the pages it has read and how the reader is viewing them.
- Key abstractions: `TextTabState` (per-tab bucket), `TextState` (`byTab`), `TextActions` (the write set), `createTextStore()`.
- Data flow: `defineStore({ init, actions })`; every action names the tab it writes; the bucket is minted on first write via `bucket()`.
- Non-obvious design decisions: the store **outlives the body** so a tab switched away and back returns to the same scroll offset without re-reading (file header comment, lines 6–9). `observedVersion` is a *baseline*: the metadata version seen at the start of the current read generation, so a change that happened *during* a read is not announced as a change (lines 144–152). `page()` drops the pages of an older version when a newer one arrives, so "the body never shows two versions at once" (lines 185–193).
- Edge cases / failure handling: `failed()` records the failure *beside* the pages already held and the next page clears it (lines 200–204). `reset()` drops content but keeps the view (scroll, wrap, navigation revision) and increments `loadRevision`.
- Surprising: `forget()` is implemented by rebuilding the `byTab` object rather than `delete` — a comment explains why ("Keys were written from tab ids; reading them back as ids is exact", line 257).

### packages/client/ui-sidebar-documentpreview/src/client/rpc.ts
- Purpose: the address→read translation and the shape of the two read calls.
- Key abstractions: `ReadWorkspaceFilePage`, `SessionFile`, `hostFileOf()`, `createReadPage()`, `ReadDocumentBytes`, `DocumentFileBytes`.
- Data flow: `hostFileOf('dsh-resource://file/session/<id>/<path>')` → `{ sessionId, path }`; `createReadPage(remote)` → `(sessionId, path, offset, signal) => remote.workspaceFiles.read(sessionId, path, { offset }, signal)`.
- Non-obvious design decisions: the page length is deliberately **not** sent — "the Host's configured cap applies when `limit` is absent" (line 76). `hostFileOf` throws for a non-session address, on the grounds that the registry routes only session-scoped addresses, so reaching the throw is a programming error, not a runtime condition.
- Edge cases / failure handling: a `Remote` call does not reject; the result carries the failure (documented at line 38).
- Surprising: `DocumentFileBytes` is `WorkspaceFileBytes<Uint8Array<ArrayBuffer>>` with a comment "copy before transferring to a Worker" — the type itself records the ownership rule.

### packages/client/ui-sidebar-documentpreview/src/client/TextPreview.tsx
- Purpose: the body — the file's content, or the reason it is not showing.
- Key abstractions: `TextPreviewProps` (composed slot props), `TextPreviewInjected` (the face + the renderer-definition hook), the four child slots it renders.
- Data flow: `useResource<'file'>(tab.contentId)` supplies metadata; `useStore(s => s.byTab[tab.id])` supplies content; the body issues `loadPage/loadAll/prepareRenderer` and renders the chosen implementation through `renderSlot('sidebar.right.tab.document', …)`.
- Non-obvious design decisions: the **renderer is selected, not hard-coded** — `candidates` is built from the registry and a manual `state.rendererId` wins (lines 69–76). The body owns *only* presentation; every byte comes from the store. A known binary suffix with no renderer never reads at all (lines 199–216): the unsupported empty state renders the path, a file-type icon and the message, with no read issued.
- Edge cases / failure handling: a metadata failure *outranks* the "file changed" notice and keeps the loaded pages (lines 234–251); a failure with no content names its own recourse — `open` (hand to the host), `retry`, or nothing — decided by `emptyFailureRecourse` (lines 353–390). The navigation effect loads *until* the asked line is held, then scrolls once and records the revision (lines 138–160).
- Surprising: the auto-refresh toggle is rendered inside a `<span hidden>` (lines 302–310) — the capability, state, labels and logic are all retained, but the control is deliberately not shown. The README explains the same for the Files tab.

### packages/client/ui-sidebar-documentpreview/src/client/TextTitle.tsx
- Purpose: the chip title — the file-type sheet before the tab's title.
- Key abstractions: `PropsRuntime<'sidebar.right.pane.tab.title'>`.
- Data flow: `useTabInfo().tab.title` → `classifyFileType(tab.title)` → a 16px `FileTypeIcon`.
- Non-obvious design decisions: the type is chosen from the *title text* (which is the basename), not from the address, so the icon matches what the user sees.
- Edge cases / failure handling: n/a.
- Surprising: the sheet is chosen from a string, not from the file's MIME type — there is no MIME lookup anywhere in this package.

### packages/client/ui-sidebar-documentpreview/src/client/LoadingIndicator.tsx
- Purpose: one shared indeterminate loading affordance for reads, page appends, and rendering.
- Key abstractions: `LoadingIndicator({ label, inline })`.
- Data flow: renders a `StateDot` with `state="ongoing"`, size 28 (centred) or 14 (inline), inside `role="status" aria-label={label}`.
- Non-obvious design decisions: the inline variant keeps the *accessible name* but drops the visible text (`{!inline && <span>{label}</span>}`) — the label stays available to a screen reader while the compact spinner shows nothing.
- Edge cases / failure handling: n/a.
- Surprising: `data-document-loading` is the single hook every test uses to assert "the body is waiting".

### packages/client/ui-sidebar-documentpreview/src/client/failure-line.ts
- Purpose: map one Remote failure code to one sentence, and one empty-state recourse.
- Key abstractions: `failureLine(t, failure)`, `emptyFailureRecourse(failure)` → `'open' | 'retry' | 'none'`, `humanBytes()`.
- Data flow: `workspace-file/not-found` → `error.notFound`; `too-large` → `error.tooLarge` with a human byte limit; `not-text` → `error.notText`; `not-regular-file` → `error.notRegularFile`; anything else → `error.unavailable` carrying the transport's own message.
- Non-obvious design decisions: the mapping is deliberately *narrow*. "Carrier and unclassified host failures reach the reader as themselves: this panel knows nothing useful to add to a transport-level message" (lines 31–32). The recourse mapping is a separate function because a code can mean two different things: `not-text`/`too-large` → **open it elsewhere** (a readable file this preview cannot render), `not-found`/`not-regular-file` → **nothing** (no point offering a Retry), everything else → **retry**.
- Edge cases / failure handling: `humanBytes` rounds to whole MB/KB because "a byte count the way a person reads one".
- Surprising: the recourse function is the *only* place in the package that decides whether a Retry button is honest.

### packages/client/ui-sidebar-documentpreview/src/client/locales.ts
- Purpose: the `sidebarDocumentPreview` dictionary (zh is the key source; en is checked against it).
- Key abstractions: `SidebarDocumentPreviewKey = keyof typeof zh`.
- Data flow: `ctx.locale.register('sidebarDocumentPreview', { zh, en })`.
- Non-obvious design decisions: the file's own comment says the failure lines are the point — "a preview that cannot show a page has to say which of several different things went wrong, and each one suggests a different next step".
- Edge cases / failure handling: the `en` dictionary is typed `Record<SidebarDocumentPreviewKey, string>`, so a missing or extra English key is a compile error.
- Surprising: `loading` is "Rendering document..." for *every* format, including plain text — one string covers a page read, a byte read, an Office conversion and a spreadsheet parse.

### packages/client/ui-sidebar-documentpreview/src/client/TextPreview.module.css
- Purpose: the body's layout and every surface it draws.
- Key abstractions: `.preview` (definite height so the header stays put), `.header` (a 38px row), `.body` (the scroller), `.empty` / `.status` / `.statusLine` / `.changed` / `.more` / `.tool` / `.action` / `.retry`.
- Data flow: CSS modules only; no logic.
- Non-obvious design decisions: the header row height and rule position are *matched to the conversation header* by hand ("With the strip's 38px above, its rule lies where the conversation header's does… so the two lines meet at the column edge", lines 12–18). The `.body` uses `white-space: pre` and the `.empty` state explicitly undoes it ("The body's monospace `pre` setting is undone here").
- Edge cases / failure handling: `.body:has([data-code-preview])` and `.body:has([data-pdf-preview])` swap the scroller for a flex column / document background — the two renderers that own their own scrollport.
- Surprising: the file carries an explicit TODO to move the shared header row into `ui-primitives` once the slot surfaces settle — duplication acknowledged in the source.

### packages/client/ui-sidebar-documentpreview/src/client/LoadingIndicator.module.css
- Purpose: the centred loading column and its compact inline variant.
- Key abstractions: `.loading`, `.inline`.
- Data flow: n/a.
- Non-obvious design decisions: `.loading` is `width/height: 100%` with `min-height: 0` so it centres inside the body's content box, and the inline variant resets width/height/padding to `auto`.
- Edge cases / failure handling: n/a.
- Surprising: `color: var(--dsw-alias-label-secondary)` — the loading text is deliberately quiet.

### packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts
- Purpose: the *renderer* contract — what a document body receives and what the owner guarantees.
- Key abstractions: `DocumentContent` (`kind: 'text' | 'bytes' | 'renderer'`), `DocumentBodyOwner`, `DocumentPreviewProps`, and the four slot declarations.
- Data flow: the owner renders `sidebar.right.tab.document` with `{ resourceAddress, content, wrap, scrollportRef, addResource, setResources }`; the renderer reports back through `content.loaded(version)`, `content.failed()`, `content.reload()`.
- Non-obvious design decisions: the `renderer` variant of `DocumentContent` is a **handshake**, not a value: it carries a `revision`, a `loaded(version)` callback, a `failed()` callback and a `reload()`. "Changes on reload or implementation replacement; retained contents belong to one revision" (line 24). That is what lets a renderer own its own async load without the owner knowing what it is loading.
- Edge cases / failure handling: "Byte arrays are transient UI input, never persisted layout or Session data" (line 15). The two handoff slots (`…actions`, `…unpreviewable`) take an `absolutePath` owner prop, with the note "native actions must verify a Host mapping".
- Surprising: `documentTabInfoFactory` is a one-line adapter that forwards the enclosing tab's reader to the selected body — "without another subscription adapter" (lines 106–107).

### packages/client/ui-sidebar-documentpreview/src/client/document/registry.ts
- Purpose: the observable registry of renderer implementations.
- Key abstractions: `DocumentPreviewDefinition`, `DocumentLoadMode`, `DocumentPreviewRegistry`, `matchingDocumentPreviews()`, `binaryDocumentPath()`.
- Data flow: `ctx.documentPreviews.register(definition)` → `publish()` → `notifySubscribers` → the body's `useDocumentPreviews` hook re-renders with a new snapshot.
- Non-obvious design decisions: the registry keeps **all** matching implementations, ranked, rather than picking one: external (`extension` band) first, then longest suffix, then registration order (lines 36–49). A binary suffix declared by any implementation removes the plain-text fallback for that path. A `binaryExtensions` entry outside `extensions` is **rejected at registration** (line 101) — the declaration cannot lie.
- Edge cases / failure handling: duplicate ids throw and do not replace the existing registration. `register` returns an idempotent disposer.
- Surprising: the ranking is by *suffix length*, not by pattern specificity — `tar.gz` beats `gz` — which is what makes compound suffixes work.

### packages/client/ui-sidebar-documentpreview/src/client/document/suffix.ts
- Purpose: the one suffix-matching implementation shared by the registry and the unviewable list.
- Key abstractions: `normalizeSuffix()`, `documentFileName()`, `matchedSuffixLength()`.
- Data flow: `matchedSuffixLength(name, extensions)` → the length of the longest declared suffix ending the filename, or 0.
- Non-obvious design decisions: the filename is taken by `replaceAll('\\','/')` so a Windows path and a POSIX path match identically, and matching is on `endsWith('.' + extension)` so a *directory* named `work.md` is not a match (the dot must be present).
- Edge cases / failure handling: `Math.max(0, ...)` on an empty extension list returns 0 rather than `-Infinity`.
- Surprising: the function returns a *length* rather than the suffix, because the registry needs to rank by specificity and the unviewable list only needs a boolean.

### packages/client/ui-sidebar-documentpreview/src/client/document/unviewable.ts
- Purpose: the list of known binary container suffixes with no registered renderer.
- Key abstractions: `UNVIEWABLE_BINARY_EXTENSIONS`, `unviewableBinaryPath()`.
- Data flow: `TextPreview.tsx:68` consults it; if a suffix matches and no renderer claims the file, the body shows the unsupported state **without reading**.
- Non-obvious design decisions: the list is a *conservative* list — "A suffix belongs here only when its bytes are never readable text — an uncertain suffix stays out and keeps the plain-text fallback" (lines 6–8). `key` is deliberately excluded with a stated reason: "it collides with key/credential files that are readable text, and the uncertain suffix keeps the plain-text fallback" (line 18).
- Edge cases / failure handling: any renderer registration for a suffix takes precedence, because the owner consults this list only when no implementation matches.
- Surprising: `private.key` is explicitly *not* in the list — a deliberate decision to show a private key as text rather than refuse it.

### packages/client/ui-sidebar-documentpreview/src/client/document/resource-group.ts
- Purpose: file-resource membership and invalidation for one document preview (its CSS/JS dependencies).
- Key abstractions: `ResourceGroup` — `add(address)`, `set(addresses)`, `close()`.
- Data flow: `resources.source(address).subscribe(observe)` → on a version change → `changed()` → `actions.resourceChanged(tabId)` → the body reloads.
- Non-obvious design decisions: the **first metadata frame is a baseline, not a change** ("Subscribe once; initial metadata establishes the baseline for later changes", lines 13–14). The comparison key is `live:<version>` or `failed:<code>`, so a failure and its recovery are both changes but a repeated identical failure is not.
- Edge cases / failure handling: `set()` releases members absent from the next document; `close()` releases everything.
- Surprising: `add()` is idempotent per address — adding the same dependency twice does not double-subscribe.

### packages/client/ui-sidebar-documentpreview/src/client/document/tab-lifetime.ts
- Purpose: release a renderer's retained view state when the tab closes or the plugin is disposed.
- Key abstractions: `retainDocumentTabs(ctx)` → `(tabId, signal, forget) => void`.
- Data flow: a renderer calls `retainTab(tab.id, tab.signal)`; the helper arms one `abort` listener per signal; on abort it calls the store's `forget`.
- Non-obvious design decisions: the map is keyed by the **AbortSignal**, not the tab id, so "repeated holds share one listener" — mounting and unmounting the body repeatedly must not register repeated listeners or forget the state early.
- Edge cases / failure handling: an already-aborted signal forgets immediately and registers nothing.
- Surprising: `ctx.effect(() => () => { for (const forget of retained.values()) forget() })` — plugin disposal releases every retained tab's state even for tabs that are still open.

### packages/client/ui-sidebar-documentpreview/src/client/text/index.ts
- Purpose: the plain-text fallback implementation and its keyed body.
- Key abstractions: `PLAIN_BODY_ID`, `textBodyDefinition(title)`, `apply(ctx)`.
- Data flow: registers `{ id: PLAIN_BODY_ID, extensions: [], priority: 'builtin', loading: 'text-pages', wrap: true }` and a `sidebar.right.tab.document` body keyed by that id.
- Non-obvious design decisions: the fallback declares **no extensions** — it is offered by the *owner*, not by suffix matching. It is `priority: 'builtin'`, so a dedicated implementation always outranks it.
- Edge cases / failure handling: the plain-text option is removed for a path whose suffix some implementation declared binary.
- Surprising: `extensions: []` in the registry means "matches everything" via the owner's fallback list, not "matches nothing" via the suffix matcher — the two mechanisms coexist because the owner appends the fallback explicitly.

### packages/client/ui-sidebar-documentpreview/src/client/text/TextBody.tsx
- Purpose: the plain source display.
- Key abstractions: `TextBody` — one `<pre>` per page, one `<div>` per line.
- Data flow: `content.pages` → `linesOf(page)` → a `<div data-textpreview-line={n}>` per line; the navigation target line gets `css.lineTarget` and `data-textpreview-target`.
- Non-obvious design decisions: line numbers are computed from the page's *offset* (`page.offset + index`), so a line's identity is its position in the file, not in the page. The target line is marked in the DOM, not just scrolled to.
- Edge cases / failure handling: `content.kind !== 'text'` returns `null` — the body renders nothing for a byte or renderer delivery.
- Surprising: the navigation target is read from `tab.navigation.params` directly by the body, not from a prop, so the plain renderer and the code renderer can each read the same params shape.

### packages/client/ui-sidebar-documentpreview/src/client/text/lines.ts
- Purpose: the page arithmetic shared by the plain renderer and the document scroller.
- Key abstractions: `linesOf()`, `loadedPages()`, `lastLineLoaded()`, `scrollToLine()`.
- Data flow: `loadedPages(store.pages)` → ordered `LoadedPage[]` → `lastLineLoaded()` → the next offset.
- Non-obvious design decisions: `linesOf` distinguishes "a page holding one empty line" (`lines: 1`, text `''`) from "a page past the file's last line" (`lines: 0`) — `page.lines === 0 ? [] : page.text.split('\n')`. `scrollToLine` handles two renderer shapes: a plain `[data-textpreview-line]` row, or a code block's `pre .line` (index `line - 1`).
- Edge cases / failure handling: `scrollToLine` returns `false` when the renderer exposes no such line, which is how the body knows a navigation is still pending.
- Surprising: `scrollToLine` returns a boolean that the navigation effect uses to decide whether to record the revision — "a navigation remains pending while its selected renderer has no anchor".

### packages/client/ui-sidebar-documentpreview/src/client/code/index.ts
- Purpose: the code renderer's metadata and keyed body registration.
- Key abstractions: `ID`, `NS = 'sidebarCodePreview'`, `apply(ctx)`.
- Data flow: registers `{ extensions: CODE_HIGHLIGHT_EXTENSIONS, priority: 'builtin', loading: 'text-pages', wrap: true }` plus a `sidebar.right.tab.document` body.
- Non-obvious design decisions: the code renderer claims *every* suffix the shared highlighter knows, at the `builtin` band, so a dedicated implementation (Markdown, HTML) registered at the same band but earlier keeps the suffix.
- Edge cases / failure handling: n/a (the registry enforces the collision rules).
- Surprising: the code renderer is the *fallback* for a large suffix list, and `apply.client.spec.ts` asserts that a later body may not collide on a suffix the code renderer already owns.

### packages/client/ui-sidebar-documentpreview/src/client/code/CodeBody.tsx
- Purpose: the incrementally highlighted source view.
- Key abstractions: `CodeBodyProps = DocumentPreviewProps & PropsLocale<'sidebarCodePreview'>`.
- Data flow: `content.text` (the accumulated prefix) → `CodeBlock` with `streaming={!content.eof}`, `wrap`, `lineNumbers`, and a `scrollportRef` on the inner content element.
- Non-obvious design decisions: the whole accumulated document is one `CodeBlock` — pages are not rendered as separate documents, so a partially-downloaded file highlights as a growing single block. The language comes from the *decoded* path via `languageForPath(file.path)`.
- Edge cases / failure handling: a non-file address throws ("not a file address") rather than rendering unhighlighted; a byte delivery renders nothing.
- Surprising: `streaming={!content.eof}` — the highlighter is told it is still streaming, so an unterminated block comment spanning a page boundary is coloured correctly (the test asserts the continuation line is a comment token).

### packages/client/ui-sidebar-documentpreview/src/client/code/locales.ts
- Purpose: the code renderer's four-key dictionary.
- Key abstractions: `title`, `copy`, `copied`.
- Data flow: `ctx.locale.register('sidebarCodePreview', { zh, en })`.
- Non-obvious design decisions: the dictionary is deliberately tiny — the copy/copied labels are the renderer's own, while the CodeBlock's own toolbar labels are also translated here (`codeBlock.title/wrap/unwrap` are passed through by `CodeBody`).
- Edge cases / failure handling: n/a.
- Surprising: `CodeBody` passes `toolbarLabels` for the *shared* CodeBlock primitive from its own namespace, so the primitive stays untranslated and each consumer localises it.

### packages/client/ui-sidebar-documentpreview/src/client/code/CodeBody.module.css
- Purpose: the code renderer's layout.
- Key abstractions: `.renderer`, `.code`, plus the `[data-code-block-content]` scrollport rules.
- Data flow: n/a.
- Non-obvious design decisions: the code sits on the **pane's own background** rather than the chat card's fill (an explicit override of the shared CodeBlock default), and the banner is the scrollport's *sibling* so "the source scrollbar starts below it".
- Edge cases / failure handling: `[data-wrap='true']` switches `white-space` to `pre-wrap` with `overflow-wrap: anywhere`.
- Surprising: the CSS reads the shared primitive's custom properties (`--dsl-code-block-line-white-space`) and overrides them from the consumer side — the primitive is themeable without being forked.

### packages/client/ui-sidebar-documentpreview/src/client/markdown/index.ts
- Purpose: the Markdown implementation's metadata and body.
- Key abstractions: `MARKDOWN_BODY_ID`, `markdownDefinition(title)`, `apply(ctx)`.
- Data flow: registers `{ extensions: ['md','markdown'], priority: 'builtin', loading: 'text-pages', wrap: false }`.
- Non-obvious design decisions: Markdown declares `wrap: false` — the document *does not consume* the wrap preference, because the Markdown primitive has its own layout.
- Edge cases / failure handling: n/a.
- Surprising: the locale namespace here is `documentMarkdown`, not `sidebar*Preview` — a naming inconsistency across sibling renderers.

### packages/client/ui-sidebar-documentpreview/src/client/markdown/MarkdownBody.tsx
- Purpose: the accumulated Markdown renderer, plus the frontmatter field list.
- Key abstractions: `MarkdownBodyProps`, `FrontmatterBox`, and a `lazy()` import of the frontmatter chunk.
- Data flow: `content.text` → `splitFrontmatter(text)` → `<MarkdownText text={body} streaming={!content.eof} labels pathImages>`; images resolve through `markdownImageUrl(document.baseURI, absolutePath, value)`.
- Non-obvious design decisions: the **YAML parser is lazily loaded only when a document has frontmatter**, and the lazy import carries a rejection handler that substitutes the verbatim source ("The failed chunk only removes the field layout; the body and verbatim metadata stay usable", lines 20–21). The `Suspense` fallback is the *verbatim* frontmatter, so the reader never sees an empty box.
- Edge cases / failure handling: `absolutePath` comes from `useResource` and may be undefined, in which case relative images simply do not resolve.
- Surprising: the frontmatter is split by a *regex*, not a YAML parse, before the YAML parser is even loaded — the split is cheap and the parse is the expensive, lazy part.

### packages/client/ui-sidebar-documentpreview/src/client/markdown/frontmatter.ts
- Purpose: split a leading YAML frontmatter block from Markdown.
- Key abstractions: `FrontmatterSplit`, `splitFrontmatter()`, the `FRONTMATTER` regex.
- Data flow: `text` → `{ source, body }` or `undefined`.
- Non-obvious design decisions: the regex is anchored at the start of the string (with an optional BOM) and the closing delimiter is `---` or `...`; the `??` makes the body group optional so an *empty* block still matches. "Only an opening `---` on the first line (after an optional BOM) counts" (line 9).
- Edge cases / failure handling: an unterminated block is not frontmatter and stays Markdown.
- Surprising: `...` is accepted as a closing delimiter — the YAML spec's alternative end marker, which most hand-rolled frontmatter splitters miss.

### packages/client/ui-sidebar-documentpreview/src/client/markdown/frontmatter-fields.tsx
- Purpose: render the frontmatter as a key/value list.
- Key abstractions: `FrontmatterField` (`key`, `value`, `block`), `parseFields()`, `nodeText()`, `FrontmatterFieldsProps`.
- Data flow: `parseDocument(source)` → `parsed.contents.items` → `<dl><div><dt/><dd/></div></dl>`.
- Non-obvious design decisions: strings show their *resolved* value (so a folded/multi-line scalar reads as prose) while every other node shows its *authored source text* (so `1.0` stays `1.0` and an alias stays unexpanded) — lines 42–43. The authored text is recovered from the node's `range` and de-indented with a computed regex (line 50).
- Edge cases / failure handling: invalid YAML or a non-mapping document returns `undefined` and the caller shows the verbatim fallback; an empty document returns `[]` and renders nothing.
- Surprising: `isScalar(node) && typeof node.value === 'string'` is the *only* node kind that is resolved; everything else is source text — a deliberate "do not reformat the author's YAML" rule.

### packages/client/ui-sidebar-documentpreview/src/client/markdown/frontmatter-fields.module.css
- Purpose: the key/value grid.
- Key abstractions: `.fields` (`grid-template-columns: max-content minmax(0,1fr)`), `.field` (`display: contents`), `.key`, `.value`, `.block`.
- Data flow: n/a.
- Non-obvious design decisions: `.field { display: contents }` makes each key/value pair a grid row without an extra box.
- Edge cases / failure handling: n/a.
- Surprising: the key column is `max-content` so the grid does not stretch it.

### packages/client/ui-sidebar-documentpreview/src/client/markdown/MarkdownBody.module.css
- Purpose: the Markdown document container and the frontmatter box.
- Key abstractions: `.document`, `.frontmatter`, `.frontmatter:empty`, `.frontmatterSource`.
- Data flow: n/a.
- Non-obvious design decisions: "The owner supplies scrolling; Markdown uses prose whitespace inside its source-oriented container" — `white-space: normal` on `.document` while the shared body is `pre`. `.frontmatter:empty { display: none }` makes an empty block collapse.
- Edge cases / failure handling: `overflow-wrap: anywhere` on the frontmatter so a long scalar cannot overflow the pane.
- Surprising: the frontmatter is drawn as a *metadata box*, never as heading text — a deliberate visual distinction from the Markdown body.

### packages/client/ui-sidebar-documentpreview/src/client/markdown/path-images.ts
- Purpose: turn a Markdown image destination into a URL the authenticated file route can serve.
- Key abstractions: `markdownImageUrl(base, documentPath, destination)`.
- Data flow: destination → strip `?`/`#` → `decodeURIComponent` → resolve relative against the document's directory → `fileMediaUrl(base, path)`.
- Non-obvious design decisions: a Windows drive path (`C:\…`) is accepted, but any *other* scheme (`https:`, `data:`, `javascript:`) returns `undefined` so the authored URL is left alone. A malformed percent escape returns `undefined` ("Malformed percent escapes do not identify a local file").
- Edge cases / failure handling: a relative destination with no known `documentPath` returns `undefined` (the image cannot be resolved yet) — it waits for the Host's absolute path.
- Surprising: the query/fragment is stripped from the *file name* but the fragment is also removed from the resulting URL ("`url.hash` is `''`" in the test) — the fragment is a page anchor, not a file selector.

### packages/client/ui-sidebar-documentpreview/src/client/markdown/locales.ts
- Purpose: the Markdown dictionary.
- Key abstractions: `viewer.label`, `code.copy`, `code.copied`, `footnotes`.
- Data flow: `ctx.locale.register('documentMarkdown', { zh, en })`.
- Non-obvious design decisions: the dictionary carries the *primitive's* labels (code copy, footnotes) because the primitive is shared and untranslated.
- Edge cases / failure handling: n/a.
- Surprising: the namespace is `documentMarkdown` while the sibling renderers use `sidebarCodePreview` / `sidebarImage` / `sidebarPdf` — a genuinely inconsistent convention across the package.

### packages/client/ui-sidebar-documentpreview/src/client/html/index.ts
- Purpose: the HTML renderer's metadata, keyed body, and injected face.
- Key abstractions: `HTML_BODY_ID`, `htmlBodyDefinition(title)`, `apply(ctx)`.
- Data flow: `inject` provides `hooks.interactivePreview` (from `ctx.configForms.developerTools.enabled`) and `readRelated(address, relativePath, signal)` → `ctx.remote.workspaceFiles.readBytes(sessionId, relativePath, { baseFile: file.path }, signal)`.
- Non-obvious design decisions: the *interactive* HTML mode is gated on a developer-tools preference, not on a security setting — the product ships with it off and it is a deliberate developer affordance. The related-file read passes `baseFile` so the **Host** resolves the relative path ("the Host resolves file and related paths through the Session filesystem, whose backend controls read authority").
- Edge cases / failure handling: `hostFileOf(address)` throws for a non-session address, so the *address*, not the slot's session, is the read's authority.
- Surprising: the `readRelated` callback is injected per-session by the slot runtime, so the renderer never sees a session id.

### packages/client/ui-sidebar-documentpreview/src/client/html/HtmlBody.tsx
- Purpose: render complete HTML in an opaque iframe, in one of two modes.
- Key abstractions: `HtmlBodyInjected` (`hooks.interactivePreview`, `readRelated`), `HtmlFrame` (scripted), `BasicHtmlFrame` (static).
- Data flow: static mode → `createBasicHtmlDocument(data)` → `<iframe sandbox="" srcdoc>`; scripted mode → `packHtml(data, readRelative, signal)` → `createHtmlDocument(bundle)` → `URL.createObjectURL` → `<iframe sandbox="allow-scripts" src={blob}>`.
- Non-obvious design decisions: the scripted iframe is **`sandbox="allow-scripts"` with no `allow-same-origin`** — "scripts cannot access the parent application's origin or file reader" (README). The static mode mounts a *separate browsing context* so a mode change "retires running scripts". The Blob URL is revoked on replace and unmount. The frame name is `dsh-sidebar-html-<tab-id>` for desktop shortcut routing.
- Edge cases / failure handling: a packing failure renders the localized "could not be previewed" alert rather than a partial frame; a byte delivery that is not UTF-8 throws inside `createBasicHtmlDocument` and is caught.
- Surprising: `key={frame.url}` on the iframe — the browsing context is *replaced* when the URL changes, so an old scripted document cannot keep running.

### packages/client/ui-sidebar-documentpreview/src/client/html/basic-document.ts
- Purpose: build the inert static HTML document.
- Key abstractions: `createBasicHtmlDocument(data)`.
- Data flow: bytes → `decodeText` → `DOMPurify.sanitize(..., WHOLE_DOCUMENT, FORBID_TAGS, FORBID_ATTR)` → `DOMParser` → a CSP `<meta>` is *prepended* → the serialised document.
- Non-obvious design decisions: the sanitiser runs **before** the policy is applied ("Inert parsing precedes the restrictive policy so source markup cannot navigate or load frames"), and the CSP meta is the *first* element in `<head>` so no earlier policy can be overridden. `FORBID_ATTR: ['href','xlink:href']` removes every link, and the forbidden tag list includes `base`, `link`, `meta`, `iframe`, `object`, `embed` and the SVG animation elements.
- Edge cases / failure handling: the parser-mutation attack (a MathML/mglyph/style sequence that re-parses into an `<a href>`) is why the result is *re-parsed* by `DOMParser` after sanitising and the caller re-checks it — the test asserts no `href` survives.
- Surprising: `style-src 'unsafe-inline'` is allowed — inline styles survive, but nothing else loads.

### packages/client/ui-sidebar-documentpreview/src/client/html/bootstrap.ts
- Purpose: the fixed bootstrap that runs *inside* the opaque iframe.
- Key abstractions: `HtmlAsset`, `HtmlBundle`, `createHtmlDocument(bundle)`.
- Data flow: the bundle is base64-encoded into a script literal; the script decodes it, rewrites `script[src]` / `link[rel~="stylesheet"]` to Blob URLs **created inside the frame**, and `document.write`s the HTML.
- Non-obvious design decisions: "Its resource URLs are created inside the sandbox, because that opaque origin cannot load resource URLs created by the parent" (lines 20–21) — the asset URLs must be minted in the frame's own origin. The payload is base64 so that a `</script>` inside the HTML cannot break out of the script literal.
- Edge cases / failure handling: `decodeText` is `fatal: true`, so invalid UTF-8 in the root or an asset throws *before* the iframe navigates.
- Surprising: the bootstrap is a string template with a hand-inlined base64 decoder — no module system, because an opaque-origin module import is not available.

### packages/client/ui-sidebar-documentpreview/src/client/html/bytes.ts
- Purpose: fatal UTF-8 decoding and chunked base64 encoding.
- Key abstractions: `decodeText(data)`, `encodeText(text)`, `BASE64_CHUNK_BYTES = 0x8000`.
- Data flow: bytes → `TextDecoder('utf-8', { fatal: true })`; text → bytes → 32 KiB chunks → `String.fromCharCode(...)` → `btoa`.
- Non-obvious design decisions: the chunking exists because `String.fromCharCode(...bytes)` blows the argument limit on a large file — the payload is split into 32 KiB pieces.
- Edge cases / failure handling: `fatal: true` makes invalid UTF-8 an exception rather than U+FFFD replacement — "invalid UTF-8 throws".
- Surprising: base64 is used *only* to embed the bootstrap payload in script text; the README states this explicitly.

### packages/client/ui-sidebar-documentpreview/src/client/html/pack.ts
- Purpose: collect the finite set of local static dependencies an HTML document declares.
- Key abstractions: `ReadHtmlRelative`, `packHtml(data, readRelative, signal)`, `MAX_ASSET_BYTES = 4 MiB`, `MAX_TOTAL_BYTES = 32 MiB`, `MAX_ASSETS = 64`.
- Data flow: the document is parsed into a `<template>` (so nothing mounts in the parent page) → each `script[src]` / `link[href]` is classified → the reader fetches it under the *source document's* authority → the assets are returned with the original reference.
- Non-obvious design decisions: the allow-list is explicit — only classic scripts (`type` empty / `text/javascript` / `application/javascript`) and `rel~=stylesheet` links, and only `.js` / `.css` paths. A `<base href>` element makes the whole pack empty ("A base element leaves URL resolution to the browser"). CSS `url()`/`@import`, modules and dynamic `fetch` are explicitly unsupported.
- Edge cases / failure handling: exceeding the asset-count limit, the per-asset byte limit or the total byte limit **rejects the whole package** ("Read failures, invalid UTF-8, or exceeded limits fail the preview rather than publishing a partial asset package"). The signal is checked before and after every read.
- Surprising: the reference is kept as the *original HTML attribute* and the URL rewrite happens later in the frame — so the packing step never has to guess a resolved path.

### packages/client/ui-sidebar-documentpreview/src/client/html/read-relative.ts
- Purpose: adapt a relative workspace read without changing its Session or Host path authority.
- Key abstractions: `ReadHtmlRelated`, `createReadHtmlRelative(readRelated, address, lifetime, addResource)`.
- Data flow: reference → strip `?`/`#` → `decodeURIComponent` → reject non-relative → `readRelated(address, path, combined)` → on success `addResource(sessionFileAddress(sessionId, value.absolutePath))`.
- Non-obvious design decisions: the dependency that is *observed* is the **Host-resolved absolute path**, not the authored spelling — "observes the Host-resolved dependency instead of a symlink and parent-segment spelling" (the test). On failure, the Host's own `error.details.path` is observed; when there is none, the client does not guess one ("without a Host path, the Client does not guess one").
- Edge cases / failure handling: absolute paths, `file://`, backslashes, NUL and malformed escapes are refused before the read is attempted; the tab lifetime and the packing signal are combined with `AbortSignal.any`.
- Surprising: `path.includes('\\')` is refused even though a Windows relative path could legitimately contain a backslash — the rule is deliberately conservative.

### packages/client/ui-sidebar-documentpreview/src/client/html/locales.ts
- Purpose: the HTML renderer's four-key dictionary.
- Key abstractions: `title`, `frame`, `loading`, `failed`.
- Data flow: `ctx.locale.register('documentHtml', { zh, en })`.
- Non-obvious design decisions: `frame` is the iframe's *accessible name* ("HTML document preview"), so a screen reader announces what the frame contains.
- Edge cases / failure handling: n/a.
- Surprising: `title` is literally "HTML" in both languages — no translation needed.

### packages/client/ui-sidebar-documentpreview/src/client/html/HtmlBody.module.css
- Purpose: the iframe and the status line.
- Key abstractions: `.frame` (100%×100%, `min-height: 240px`, no border), `.status`.
- Data flow: n/a.
- Non-obvious design decisions: the frame is `display: block` and borderless so it reads as a document, not an embedded control.
- Edge cases / failure handling: n/a.
- Surprising: `min-height: 240px` is the only floor on the preview height.

### packages/client/ui-sidebar-documentpreview/src/client/image/index.ts
- Purpose: the image renderer's metadata, body, and zoom store.
- Key abstractions: `IMAGE_BODY_ID`, `IMAGE_EXTENSIONS`, `BINARY_IMAGE_EXTENSIONS`, `imageBodyDefinition(title)`, `apply(ctx)`.
- Data flow: registers a `bytes-complete`, `wrap: false` renderer with its own `createZoomStore()` and a `retainTab` injection.
- Non-obvious design decisions: **SVG is deliberately excluded from the binary list** — "SVG stays out because its XML source is worth reading" (line 18), so `.svg` keeps the plain-text fallback in the viewer picker. Every other raster format is binary.
- Edge cases / failure handling: n/a.
- Surprising: the image renderer is the only one with its *own* store, because zoom is per-tab view state that must survive a body remount.

### packages/client/ui-sidebar-documentpreview/src/client/image/ImageBody.tsx
- Purpose: render complete image bytes in the shared zoom viewport.
- Key abstractions: `IMAGE_MEDIA_TYPES`, `imageMediaType(path)`, `ImageBodyProps`, `LoadedImage`.
- Data flow: bytes → `URL.createObjectURL(new Blob([data], { type: mediaType }))` → `<img src=blobUrl>` → `onLoad` reports `naturalWidth` → `ZoomViewport` fits it.
- Non-obvious design decisions: the Blob URL is revoked when the bytes are replaced or the body unmounts. The `<img>` is `draggable={false}` and `referrerPolicy="no-referrer"`. The image is only revealed after `onLoad` (`hidden={state !== 'ready'}`), so a broken image never leaves a half-drawn box.
- Edge cases / failure handling: a Blob-creation failure and a decode failure both render the localized "could not be displayed" alert; an unregistered suffix renders "unsupported" **without creating a Blob**.
- Surprising: zoom changes retain the same `<img>` element and the same Blob URL, so an animated GIF keeps playing across a zoom.

### packages/client/ui-sidebar-documentpreview/src/client/image/locales.ts
- Purpose: the image renderer's dictionary, spread from the shared zoom dictionary.
- Key abstractions: `...zoomZh`, `title`, `preview` (`Image preview: {name}`), `loading`, `failed`, `unsupported`.
- Data flow: `ctx.locale.register('sidebarImage', { zh, en })`.
- Non-obvious design decisions: the zoom copy is *spread in* rather than referenced, so the image dictionary is self-contained and can be registered without the zoom package's namespace.
- Edge cases / failure handling: n/a.
- Surprising: the `preview` key is the image's `alt` text, so it is the accessible name of the preview.

### packages/client/ui-sidebar-documentpreview/src/client/image/ImageBody.module.css
- Purpose: the image frame and surface.
- Key abstractions: `.frame`, `.surface`, `.image`, `.status`.
- Data flow: n/a.
- Non-obvious design decisions: the frame's width follows the scroller so the image's percentage maximum resolves against the *pane* and never scrolls horizontally; a taller image grows the frame and scrolls vertically. `margin: auto` centres it whether it was shrunk or not.
- Edge cases / failure handling: `.frame:has([data-document-loading]) { height: 100% }` keeps the loading state centred.
- Surprising: `user-select: none` on the image — a preview is not a text selection target.

### packages/client/ui-sidebar-documentpreview/src/client/zoom/types.ts
- Purpose: the zoom preference vocabulary and its numeric bounds.
- Key abstractions: `ZoomPreference` (`fit-width` | `fixed` with a `scale`), `FIT_WIDTH`, `MIN_FIXED_ZOOM = 0.25`, `MAX_FIXED_ZOOM = 4`, `ZOOM_STEP = 0.25`, `ZOOM_OPTIONS`, `ZoomLabels`.
- Data flow: n/a (pure data).
- Non-obvious design decisions: the preference is a *discriminated union*, not a number — "fit" is a distinct state from "scale 1", because fit-width must keep tracking the pane while a fixed 100% must not.
- Edge cases / failure handling: n/a.
- Surprising: `ZOOM_OPTIONS` (the menu presets) and `MIN/MAX_FIXED_ZOOM` (the incremental bounds) are separate constants — the menu offers 25–200% while the stepper can reach 400%.

### packages/client/ui-sidebar-documentpreview/src/client/zoom/store.ts
- Purpose: the tab-local zoom store.
- Key abstractions: `ZoomState`, `ZoomActions`, `createZoomStore()`, `DEFAULT_ZOOM`, `ZoomInjected`.
- Data flow: `actions.zoom(tabId, preference)` / `actions.forget(tabId)`.
- Non-obvious design decisions: the store is a *factory* declared on the registration so the framework mints one instance per session; the preference is keyed by tab id so two tabs of the same file zoom independently.
- Edge cases / failure handling: `forget` uses object rest to drop one key.
- Surprising: `ZoomInjected.retainTab` is the store's own lifetime channel — the store cannot be forgotten without being told the tab ended.

### packages/client/ui-sidebar-documentpreview/src/client/zoom/ZoomViewport.tsx
- Purpose: the shared zoom viewport, gesture handling, anchoring and fit-width measurement.
- Key abstractions: `fitWidthZoom(viewportWidth, intrinsicWidth, horizontalInset)`, `ZoomViewportProps`, `pointerAnchor()`.
- Data flow: `ResizeObserver` → `viewportWidth` → `fitZoom` → `--document-zoom` CSS variable on the frame; Ctrl+wheel → `showZoom()` → the scale is written to a CSS variable and the scroll offsets are corrected so the point under the pointer stays put.
- Non-obvious design decisions: `fitWidthZoom` **never upscales**: `Math.min(1, Math.max(1, viewport - inset) / intrinsic)` — "an actual-size scale that only shrinks content wider than the viewport". The anchor is computed with `document.elementFromPoint` found through `Reflect.get`/`Reflect.apply` (so a hostile `elementFromPoint` cannot be called with a wrong `this`).
- Edge cases / failure handling: the Ctrl+wheel handler is registered with `{ passive: false }` and is removed on unmount; a pending pinch is cancelled when the tab's signal aborts. The gesture commits to a fixed scale only after a 120 ms settle delay, so a live pinch does not thrash the store.
- Surprising: the zoom is applied by writing a CSS custom property, not by scaling the DOM — the content is re-laid out, so text stays crisp.

### packages/client/ui-sidebar-documentpreview/src/client/zoom/ZoomControls.tsx
- Purpose: the floating zoom toolbar.
- Key abstractions: `ZoomControlsHandle.showZoom(zoom)`, `steppedZoom(zoom, direction)`.
- Data flow: the parent owns the resolved zoom; the control keeps a *display* copy that the gesture can update live via the imperative handle.
- Non-obvious design decisions: `showZoom` is an imperative handle so the percentage updates during a pinch *without* re-rendering the document tree ("Live percentage display updated independently from the document tree", line 13). The stepper rounds to the step grid (`Math.ceil`/`Math.floor`) rather than multiplying, so repeated clicks land on 25/50/75/100% rather than drifting.
- Edge cases / failure handling: the buttons are disabled at `MIN_FIXED_ZOOM` / `MAX_FIXED_ZOOM`; `onMouseDown` calls `preventDefault` so the menu does not steal focus before the click.
- Surprising: the control reports "active" to the parent when it is open, hovered *or focused*, which is what keeps it visible during keyboard use.

### packages/client/ui-sidebar-documentpreview/src/client/zoom/locales.ts
- Purpose: the shared zoom copy, exported as two spreadable fragments.
- Key abstractions: `zoomZh`, `zoomEn`, `ZoomLocaleKey`.
- Data flow: spread into the image and PDF dictionaries.
- Non-obvious design decisions: the namespace is not registered with `ctx.locale` — it is *embedded* into two other dictionaries, so there is exactly one copy of the six strings.
- Edge cases / failure handling: n/a.
- Surprising: `zoomValue` is a template with `{percent}` — the percent is a parameter, not a formatted number, so each locale controls the separator.

### packages/client/ui-sidebar-documentpreview/src/client/zoom/ZoomControls.module.css
- Purpose: the floating control's appearance and reveal animation.
- Key abstractions: `.panel`, `.visible`, `.controlAnchor`, `.zoomButton`, `.percent`, `.zoomMenu`.
- Data flow: n/a.
- Non-obvious design decisions: `@media (hover: none), (pointer: coarse)` forces the panel permanently visible — "devices without hover keep it visible continuously". `prefers-reduced-motion` collapses the transition to 0.01 ms.
- Edge cases / failure handling: `pointer-events: none` while hidden so the invisible panel cannot eat clicks.
- Surprising: the percentage uses `font-variant-numeric: tabular-nums` so the number does not jitter while a pinch is running.

### packages/client/ui-sidebar-documentpreview/src/client/zoom/ZoomViewport.module.css
- Purpose: the frame, the scrollport, the reveal zone and the two surface sizing modes.
- Key abstractions: `.frame`, `.scrollport`, `.surface`, `.revealZone`.
- Data flow: n/a — the sizes come from the CSS variables `--document-zoom`, `--document-zoom-width` and `--document-zoom-reveal-height`.
- Non-obvious design decisions: the two modes are *CSS*, not JS: `fit-width` uses `width: min(var(--document-zoom-width), 100%)` and `fixed` uses `width: calc(var(--document-zoom-width) * var(--document-zoom))`.
- Edge cases / failure handling: the reveal zone is `pointer-events: none` so it never blocks the document.
- Surprising: `--document-zoom-reveal-height` is written from JS so the CSS and the 72px constant cannot drift apart.

### packages/client/ui-sidebar-documentpreview/src/client/pdf/index.ts
- Purpose: the PDF renderer's registration, and the reusable registration used by the Office preview.
- Key abstractions: `PDF_BODY_ID`, `pdfBodyDefinition(title)`, `pdfBodyRegistration(ctx)`.
- Data flow: registers a `bytes-complete`, `wrap: false` renderer; `pdfBodyRegistration` returns the store and the inject (which supplies `retainTab`, `ZoomViewport` and `zoomSurfaceClass`).
- Non-obvious design decisions: the Office preview **reuses the PDF body** through a nested keyed slot (`sidebar.right.tab.document.office.pdf`) rather than duplicating the PDF rendering code — the Office body declares a child slot and hands it converted bytes.
- Edge cases / failure handling: the `ZoomViewport` and `zoomSurfaceClass` are passed *through the injection* rather than imported, so the lazy PDF chunk does not pull the main-bundle zoom module into itself.
- Surprising: `pdfBodyDefinition` declares `binaryExtensions: ['pdf']` — the plain-text fallback is removed for PDFs.

### packages/client/ui-sidebar-documentpreview/src/client/pdf/pdf.tsx
- Purpose: the PDF reader — page canvases, a selectable text layer, and lazy rendering.
- Key abstractions: `PdfBodyInjected`, `PdfBodyProps`, `PdfPage`, `failureText()`.
- Data flow: bytes → `openPdf(data, signal, reportFailure)` → a `PdfDocument` → one `PdfPage` per page → `renderPdfPage(document, page, buffer, signal, dpr*zoom, textRenderer)`.
- Non-obvious design decisions: pages render **lazily** via an `IntersectionObserver` with `rootMargin: '100% 0px'`, and an unrendered page holds its place as a 3:4 skeleton block. Renders are *serialised* through a `pendingRender` promise chain, because "PDF.js shares a page proxy across renders; its cancelled task must finish cleanup before another render starts" — the displayed bitmap stays intact throughout. The canvas is drawn from an off-screen buffer and the buffer is zeroed in a `finally`.
- Edge cases / failure handling: a failed page shows a localized message and a Retry that bumps a per-page `attempt` counter; a `PasswordException` gets its own message; a `PdfWorkerFailure` gets its own message. A cancelled render is caught and ignored, and a late render after unmount is ignored.
- Surprising: the text layer is created by PDF.js's *official* `TextLayerBuilder`, so selection boundaries and copy normalisation are the library's, not a re-implementation.

### packages/client/ui-sidebar-documentpreview/src/client/pdf/runtime.ts
- Purpose: open a PDF with an explicitly owned, version-matched Worker.
- Key abstractions: `openPdf(data, signal, reportFailure)` → `{ document, dispose }`.
- Data flow: the worker source is inlined and a ready-marker is appended → a Blob URL → `new Worker(url, { type: 'module', name: 'dsh-pdf' })` → wait for the `dsh-pdf-worker-ready` message → `PDFWorker.create({ port })` → `getDocument({ data: bytes, worker: bridge, BinaryDataFactory, cMapPacked: true, useWorkerFetch: false, enableXfa: false, stopAtErrors: true })`.
- Non-obvious design decisions: "Startup failure never falls back to main-thread PDF parsing" — there is deliberately no degraded path. The bytes are **copied** (`data.slice()`) because the Worker transfers them. `useWorkerFetch: false` and the inlined `BinaryDataFactory` mean the PDF viewer never touches the network.
- Edge cases / failure handling: `dispose()` awaits `loading.destroy()` before terminating the Worker, so PDF.js can tear down cleanly; a fatal worker error terminates the native Worker and revokes the source URL immediately. A failure callback that *throws* is caught and logged rather than escaping into the event loop.
- Surprising: the ready handshake is a message the *app* appends to the worker source, so "the worker is alive and is the version we inlined" is proven before PDF.js is asked to do anything.

### packages/client/ui-sidebar-documentpreview/src/client/pdf/document.ts
- Purpose: canvas rendering with cancellation and page cleanup.
- Key abstractions: `PdfDocument`, `PdfSession`, `PdfPageSize`, `RenderPdfText`, `renderPdfPage(...)`.
- Data flow: `document.getPage(n)` → `page.getViewport({ scale: 96/72 })` → a size-bounded canvas → `page.render({ canvas, viewport, transform })` → the text layer in parallel.
- Non-obvious design decisions: the raster allocation is capped at **16,777,216 pixels** by lowering the *ratio*, not the display size: `ratio = Math.min(pixelRatio, Math.sqrt(16_777_216 / (w*h)))` while the CSS size stays `viewport.width` — "Limit raster allocation without changing the document's display dimensions" (line 55). A transform is used instead of rescaling the viewport, so the text layer's scale stays correct.
- Edge cases / failure handling: cancellation cannot write dimensions after a delayed `getPage` (the signal is re-checked); the canvas and the text task are cancelled together; `page.cleanup()` runs in a `finally` after the render settles.
- Surprising: the text renderer's `promise` and `cancel` are awaited *together* (`Promise.all`), so the text layer's cleanup is part of the page's cleanup barrier.

### packages/client/ui-sidebar-documentpreview/src/client/pdf/text.ts
- Purpose: the selectable text overlay.
- Key abstractions: `pdfTextRenderer(host)` → `{ promise, cancel }`.
- Data flow: `new TextLayerBuilder({ pdfPage })` → `container.style.setProperty('--total-scale-factor', …)` → append → `layer.render({ viewport })` → a `ResizeObserver` keeps the scale matched to the host width.
- Non-obvious design decisions: the import is `pdfjs-dist/web/pdf_viewer.mjs` — the *viewer's* builder, so selection and copy normalisation are the library's. The scale uses `viewport.scale * viewport.userUnit` because "Width fitting must compose with the viewer's page rotation and translation".
- Edge cases / failure handling: `cancel()` disconnects the observer, cancels the layer and removes the DOM — "cancel() releases the builder's shared selection listener after the last page leaves".
- Surprising: the comment notes "PDF.js 6 declares images as required, but its viewer also renders text-only layers without it" — the type is cast rather than the call faked.

### packages/client/ui-sidebar-documentpreview/src/client/pdf/assets.ts
- Purpose: the build-owned, same-version PDF.js binary resources.
- Key abstractions: `PdfAssetKind`, `PdfAssetMap`, `PdfBinaryDataFactory`, `createPdfBinaryDataFactory(assets)`.
- Data flow: the build inlines `__DSH_PDFJS_ASSETS__` (base64 of cmaps, standard fonts, wasm) → the factory decodes one file per request and returns a *fresh* `Uint8Array`.
- Non-obvious design decisions: "Capture this build's binary assets without network fallbacks" — a missing file **throws** rather than falling back to a URL, and the lookup is `Object.hasOwn` so a prototype key cannot be served.
- Edge cases / failure handling: the returned buffer is a new array each time because PDF.js may transfer it away; the test proves the source survives a `structuredClone(…, { transfer })`.
- Surprising: the worker source is imported with `?raw` — a build plugin turns the `.mjs` file into a string at bundle time.

### packages/client/ui-sidebar-documentpreview/src/client/pdf/errors.ts
- Purpose: one structured error class for Worker failures.
- Key abstractions: `PdfWorkerFailure` with `kind = 'worker'`.
- Data flow: `new PdfWorkerFailure(event)` → the body's `failureText()` maps it to the `workerFailed` locale key.
- Non-obvious design decisions: the native `Event` is kept as the `cause` for diagnostics but never shown to the user — the renderer owns the visible explanation.
- Edge cases / failure handling: the class exists so a Worker crash is distinguishable from a parse error in the UI.
- Surprising: `super(undefined, { cause })` — the message is empty on purpose.

### packages/client/ui-sidebar-documentpreview/src/client/pdf/store.ts
- Purpose: the restorable PDF viewing preferences.
- Key abstractions: `PdfView` (`page`, optional `zoom`), `PdfState`, `createPdfStore()`.
- Data flow: `actions.page(tabId, page)`, `actions.zoom(tabId, zoom)`, `actions.forget(tabId)`.
- Non-obvious design decisions: the store holds only the *page number* and the *zoom preference* — "document objects and canvases remain component-local" (file header).
- Edge cases / failure handling: `zoom` preserves the current page when it writes (`page: draft.byTab[tabId]?.page ?? 1`).
- Surprising: `page` is written when a page becomes *visible*, not when it is opened — it is "the last visible page", i.e. a restore point.

### packages/client/ui-sidebar-documentpreview/src/client/pdf/LazyPdfBody.tsx
- Purpose: load the PDF renderer only when a PDF body mounts.
- Key abstractions: `const LoadedPdfBody = lazy(async () => ({ default: (await import('./pdf.tsx')).PdfBody }))`.
- Data flow: `Suspense` with the shared `LoadingIndicator` as the fallback.
- Non-obvious design decisions: PDF.js, the worker source and the embedded cmaps stay out of the startup `client.js` chunk; the published artefact proves it (`client.pdf.js` is a separate chunk).
- Edge cases / failure handling: the README states the cost — "A failed PDF chunk load requires a page reload" because React caches a rejected lazy import for the page lifetime.
- Surprising: the `loading` element is created in the *main* bundle and passed down as a prop, so the fallback does not require the lazy module.

### packages/client/ui-sidebar-documentpreview/src/client/pdf/locales.ts
- Purpose: the PDF dictionary, spread from the shared zoom copy.
- Key abstractions: `title`, `pageImage`, `loading`, `rendering`, `failed`, `password`, `workerFailed`, `unsupported`, `retry`.
- Data flow: `ctx.locale.register('sidebarPdf', { zh, en })`.
- Non-obvious design decisions: `workerFailed` and `password` are *distinct* keys, because a password-protected PDF and a dead worker are different problems with different next steps.
- Edge cases / failure handling: n/a.
- Surprising: `pageImage` is the canvas's `aria-label` ("PDF page 3"), so the page count is announced per page.

### packages/client/ui-sidebar-documentpreview/src/client/pdf/PdfBody.module.css
- Purpose: the PDF page sequence, the canvas, the text layer, and the selection styling.
- Key abstractions: `.body`, `.page`, `.placeholder`, `.canvas`, `.surface`, `.text`, `.status`.
- Data flow: n/a.
- Non-obvious design decisions: the text-layer CSS is a *port* of `pdfjs-dist/web/pdf_viewer.css` — the rotation transforms (`[data-main-rotation="90"|"180"|"270"]`), the `--text-scale-factor` maths and the `::selection` colour are reproduced so the overlay aligns exactly with the canvas.
- Edge cases / failure handling: `.placeholder { aspect-ratio: 3/4 }` is "the loading feedback, so no spinner competes with the centred open wait".
- Surprising: `[data-document-zoom-mode="fixed"] .body { width: max-content }` — a fixed zoom makes the page sequence wider than the pane, which is what produces horizontal scrolling.

### packages/client/ui-sidebar-documentpreview/src/client/office/index.ts
- Purpose: the Office preview registration, the conversion wiring, and the cache lifecycle.
- Key abstractions: `apply(ctx, config)`, `conversionErrorKey(code)`, the `OfficePreviewCache` construction, the `connection/reset` handler.
- Data flow: `ctx.inject(['remote','remote.officeToPdf','remote.workspaceFiles'], scope => …)` → `convert(file, signal, priority)` → `scope.remote.officeToPdf.render(sessionId, path, priority, signal)`; the cache's `stat` is a *two-step* probe: a 1-byte `readBytes` (authorisation) plus a `stat` (metadata) whose `absolutePath`/`version` must match, else the read is refused with "the file changed while being read".
- Non-obvious design decisions: the registration exists **even when the Host renderer is missing** — `read` starts as an `unavailable` function that rejects with a localized message, so the tab still claims `.doc`/`.pptx` and shows configuration guidance rather than falling back to plain text. The `connection/reset` event replaces the whole cache and disposes the old one in the background.
- Edge cases / failure handling: `document-render/failed` is translated through `conversionErrorKey` (input-too-large / invalid-document / timeout / unavailable / busy / source-changed). `gateway/invocation-unavailable` and `gateway/service-unavailable` become the "unavailable" guidance.
- Surprising: the *authorisation probe* reads one byte (`{ range: { offset: 0, length: 1 } }`) — enough to prove the read is permitted without paying for the file.

### packages/client/ui-sidebar-documentpreview/src/client/office/cache.ts
- Purpose: the version-checked, bounded cache of converted Office PDFs.
- Key abstractions: `OfficeFileBytes`, `ReadOfficeDocument`, `ReadOfficeBytes`, `OfficePreviewCache` (`read`, `lookup`, `lookupGeneration`, `retain`, `dispose`).
- Data flow: `read(file, signal, priority)` → generation query → `stat(file)` → cache key = `JSON.stringify([generation, sessionId, absolutePath, version])` → LRU hit, or a shared pending conversion → `retain(key, result)`.
- Non-obvious design decisions: **four things are in the cache identity**: the Host renderer's *generation*, the Session, the absolute source path, and the source version. A renderer replacement therefore invalidates every cached PDF automatically. Each read *re-authorises* before reuse, so the cache is not a permission bypass. One reader cancelling does not cancel the shared conversion — the pending entry is refcounted and the controller aborts only when the last user leaves (lines 143–168).
- Edge cases / failure handling: a background read gets `maxReaders - 1` and `maxPending - 1`, so a speculative prewarm can never take the last slot an interactive read needs. A generation that changes mid-flight aborts the pending conversions and is retried exactly once; a second supersession reports the localized "busy" error. A conversion whose source changed during conversion is not retained.
- Surprising: `retain()` evicts by *insertion order* of a `Map` (an LRU by re-insertion on hit) and skips a PDF larger than the byte budget entirely rather than evicting everything for it.

### packages/client/ui-sidebar-documentpreview/src/client/office/face.ts
- Purpose: bind the Office conversion read to the store actions.
- Key abstractions: `OfficeLoadInjected.load(tabId, revision, file, signal, loaded, failed)`, `officeFace(read, describeFailure)`.
- Data flow: `load(...)` → `actions.loading(tabId, revision)` → `read(file, signal)` → `actions.complete(tabId, revision, result.value)` + `loaded(version)`, or `actions.failed(tabId, revision, { code, message })` + `failed()`.
- Non-obvious design decisions: the face writes to the store and *also* calls the owner's `loaded`/`failed` callbacks, so the owner and the store never disagree. The failure message is produced by a `describeFailure` callback supplied by the registration, so the Office namespace owns the wording and the document namespace owns the shared codes.
- Edge cases / failure handling: an already-aborted signal does nothing at all — no read, no store write. A rejected read (rather than a failure result) is normalised into a `gateway/internal` failure.
- Surprising: the injected session id is deliberately unused — the file's address carries the authority.

### packages/client/ui-sidebar-documentpreview/src/client/office/store.ts
- Purpose: the loaded Office preview, retained across body remounts.
- Key abstractions: `OfficeView` (`revision`, `file?`, `failure?`), `OfficeState`, `createOfficeStore()`.
- Data flow: `loading` / `complete` / `failed` / `forget`, all keyed by tab id and stamped with the content revision.
- Non-obvious design decisions: every write is *stamped with a revision*, so a settlement from a superseded revision cannot overwrite a newer one (the body checks `held?.revision === revision` before using it).
- Edge cases / failure handling: a failure keeps only `{ revision, failure }` — the previous successful file is dropped, so a stale PDF is never shown next to a fresh error.
- Surprising: the store holds the *converted PDF bytes*, i.e. the expensive artefact survives a tab switch.

### packages/client/ui-sidebar-documentpreview/src/client/office/OfficeBody.tsx
- Purpose: present the retained conversion and delegate the PDF rendering.
- Key abstractions: `OfficeBodyInjected`, `OfficeBodyProps`, the nested `sidebar.right.tab.document.office.pdf` slot.
- Data flow: `content` (kind `renderer`) → `load(tabId, revision, hostFileOf(resourceAddress), signal, request.loaded, request.failed)` → the store → `{ kind: 'bytes', data: file.data }` → the nested PDF slot.
- Non-obvious design decisions: the load effect depends on `[revision, resourceAddress, tab.id, tab.signal, load, settled]` — the comment says "Metadata may replace callbacks without advancing the content revision", so a new `load` function identity alone must not restart the conversion. The body renders the PDF through a *child slot* rather than importing the PDF body, which is what keeps the PDF chunk lazy.
- Edge cases / failure handling: a failure renders the file-type icon, the localized message and a Retry that calls `request.reload()`. A body that receives ordinary shared content renders nothing.
- Surprising: the Office body's `useEffect` calls `retainTab` on every render — the tab lifetime, not the body lifetime, owns the retained conversion.

### packages/client/ui-sidebar-documentpreview/src/client/office/OfficeFontAction.tsx
- Purpose: the toolbar's missing-font warning.
- Key abstractions: `OfficeFontActionProps`, `OfficeFontAction`.
- Data flow: the toolbar's `content` (kind `renderer`) → its `revision` → the Office store's held view → `held.file.missingFonts` → `<FontNotice fonts={…}>`.
- Non-obvious design decisions: the warning is rendered **only for the revision currently displayed** (`held?.revision !== content.revision` → null), so a stale font list can never be shown next to a new document.
- Edge cases / failure handling: the component is keyed by `content.revision`, so a reload remounts the notice and closes its open details.
- Surprising: it lives in the `sidebar.right.tab.document.action` slot — renderer-specific controls go *before* the reload button, in the document toolbar.

### packages/client/ui-sidebar-documentpreview/src/client/office/FontNotice.tsx
- Purpose: the anchored, non-modal missing-fonts panel.
- Key abstractions: `FontNoticeProps`, `FontNotice`.
- Data flow: `fonts` → a warning button in the toolbar → a portal-rendered `role="dialog"` with the list.
- Non-obvious design decisions: the dialog is **portaled to `document.body`** and positioned by `useAnchoredPosition`, and it is `visibility: hidden` until the position is known (so it never flashes at 0,0). Focus moves into the panel when it opens and returns to the trigger on close. Escape closes it and stops propagation.
- Edge cases / failure handling: focus leaving the panel *and* the trigger closes it; an outside pointer press closes it. Nothing is retained: "Viewed and dismissed states are not retained".
- Surprising: the tooltip is `disabled` while the panel is open so the two do not fight over the hover.

### packages/client/ui-sidebar-documentpreview/src/client/office/FontNotice.module.css
- Purpose: the warning button and the font panel.
- Key abstractions: `.anchor`, `.warning`, `.panel`, `.panelHeader`, `.description`, `.count`, `.fonts`.
- Data flow: n/a.
- Non-obvious design decisions: the panel is `position: fixed` with `z-index: 100`, `width: min(340px, calc(100vw - 24px))` and `max-height: calc(100dvh - 24px)` — it is a floating panel, not a dropdown, so it can be taller than its anchor.
- Edge cases / failure handling: `overflow-wrap: anywhere` on the font names so a long family name cannot widen the panel.
- Surprising: the warning uses the theme's `--dsw-alias-state-warn-label` / `-tertiary` tokens rather than a bespoke yellow.

### packages/client/ui-sidebar-documentpreview/src/client/office/OfficeBody.module.css
- Purpose: the Office body's flex column.
- Key abstractions: `.body`.
- Data flow: n/a.
- Non-obvious design decisions: `height: 100%; min-height: 0` so the nested PDF scrollport gets a definite height.
- Edge cases / failure handling: n/a.
- Surprising: 86 bytes — the smallest stylesheet in the package, and the honest answer for a wrapper.

### packages/client/ui-sidebar-documentpreview/src/client/office/locales.ts
- Purpose: the Office dictionary, including the missing-font copy and the configuration guidance.
- Key abstractions: `OfficePreviewKey`; keys `title`, `loading`, `retry`, `viewMissingFonts`, `missingFontsTitle/Description/Count`, `closeDetails`, `unavailable`, `invalid`, `tooLarge`, `failed`, `timeout`, `busy`, `changed`.
- Data flow: `ctx.locale.register('sidebarOffice', { zh, en })`.
- Non-obvious design decisions: `unavailable` names the remedy ("Enable the document preview service on the computer running DeepSeek Harness") rather than the symptom.
- Edge cases / failure handling: the copy distinguishes nine distinct failure modes, each with a different next step.
- Surprising: the namespace is `sidebarOffice` and the key set is exported so `conversionErrorKey` can be typed against it.

### packages/client/ui-sidebar-documentpreview/src/client/excel/index.ts
- Purpose: the spreadsheet renderer's registration.
- Key abstractions: `apply(ctx, limits)`.
- Data flow: registers `{ extensions: ['xlsx','xls','csv','tsv'], binaryExtensions: ['xlsx','xls'], priority: 'builtin', loading: 'bytes-complete', wrap: false }` and a keyed body whose `inject` supplies `{ limits }`.
- Non-obvious design decisions: the Excel renderer is registered **independently of the Office conversion service** — "Excel previews use ordinary authorized file bytes without Office conversion" (file header). `.csv`/`.tsv` are *not* binary, so they keep the plain-text fallback.
- Edge cases / failure handling: n/a.
- Surprising: `.csv` and `.tsv` are claimed by the spreadsheet renderer *and* by the shared code highlighter — the registry's ranking keeps both, and the picker offers both.

### packages/client/ui-sidebar-documentpreview/src/client/excel/excel.tsx
- Purpose: the read-only spreadsheet surface.
- Key abstractions: `State` (data + format + value|error), `ExcelBody`.
- Data flow: bytes → `parseExcel(data, format, limits, signal)` → `state.value.sheets` → `<Workbook data=… allowEdit={false} showToolbar={false} showFormulaBar showSheetTabs forceCalculation={false} cellContextMenu={['copy']} />`.
- Non-obvious design decisions: FortuneSheet's stylesheet is injected as a **scoped** stylesheet: `@scope ([data-excel-preview]) { … }` — the third-party CSS cannot leak into the app. A `ResizeObserver` dispatches a synthetic `window resize` because "FortuneSheet measures its canvas on window resize, but pane resizing does not emit that event". Editing, recalculation, the toolbar, and every context menu except copy are switched off.
- Edge cases / failure handling: the parse is cancellable and a retired result is ignored (`state?.data !== data` guards the render). An error is mapped to one of four locale keys.
- Surprising: `forceCalculation={false}` plus a separate *formula warning* — the viewer shows the *saved* results and says so.

### packages/client/ui-sidebar-documentpreview/src/client/excel/LazyExcelBody.tsx
- Purpose: defer the spreadsheet renderer (and its four parsers) until a workbook is opened.
- Key abstractions: `ExcelBodyProps`, `LoadedExcelBodyProps`, `LazyExcelBody`.
- Data flow: `hostFileOf(resourceAddress).path` → `excelFormat(path)` → `Suspense` → `LoadedExcelBody` with the format.
- Non-obvious design decisions: the *format selection* is kept outside the heavy chunk (`format.ts` is imported by the main bundle) so a `.xlsm` is rejected without downloading the parsers.
- Edge cases / failure handling: an unsupported suffix throws an `ExcelPreviewError('invalid')` at the point of selection.
- Surprising: the lazy chunk bundles FortuneSheet, ExcelJS, SheetJS CE and PapaParse — four parsers — and it is one chunk for all four formats.

### packages/client/ui-sidebar-documentpreview/src/client/excel/parse.ts
- Purpose: run the parser in a disposable Worker with a deadline.
- Key abstractions: `parseExcel(bytes, format, limits, signal)`, `validPreview(value)`.
- Data flow: bytes → a Blob URL of the worker source → `new Worker(url, { name: 'dsh-excel' })` → `postMessage({ bytes: copy, format, limits }, [copy.buffer])` → a validated message → resolve.
- Non-obvious design decisions: the retained preview buffer is **copied** before it is transferred ("each parse owns a disposable Worker and transfers a copy of retained file bytes"). Every exit path terminates the Worker, revokes the URL and clears the timer. The Worker message is treated as **untrusted input**: `validPreview` checks the shape, that `missingResults` is a non-negative safe integer, that `unsupportedFeatures` contains only known features, and that every sheet has a name and a `celldata` array.
- Edge cases / failure handling: `onerror` and `onmessageerror` both reject with `invalid`; a Worker-construction failure revokes the URL; a `postMessage` failure terminates the Worker; a `timeoutMs` deadline rejects with `timeout`.
- Surprising: the size check happens *before* the Worker is created, so an oversized file costs nothing.

### packages/client/ui-sidebar-documentpreview/src/client/excel/worker.ts
- Purpose: the Worker entry — one workbook per Worker.
- Key abstractions: `globalThis.onmessage`.
- Data flow: `{ bytes, format, limits }` → `convertExcel(...)` → `{ ok: true, value }` or `{ ok: false, code }`.
- Non-obvious design decisions: the Worker owns a **private response protocol** — `{ ok, value | code }` — so the main thread never has to interpret an arbitrary error object, and an unexpected exception is reported as `invalid`.
- Edge cases / failure handling: "formulas and external links are never executed" (file header) — the Worker only parses.
- Surprising: 12 lines, and it is the whole trust boundary between the browser and four third-party parsers.

### packages/client/ui-sidebar-documentpreview/src/client/excel/convert.ts
- Purpose: dispatch to the format-specific parser.
- Key abstractions: `convertExcel(bytes, format, limits)`.
- Data flow: byte check → `convertXlsx` / `convertXls` / `convertDelimited`.
- Non-obvious design decisions: the byte limit is re-checked here as well as in `parse.ts` — the Worker is the untrusted side, so the limit is enforced on both sides of the boundary.
- Edge cases / failure handling: a format-specific failure propagates as an `ExcelPreviewError`.
- Surprising: this file is the single seam where a new spreadsheet format would be added.

### packages/client/ui-sidebar-documentpreview/src/client/excel/xlsx.ts
- Purpose: XLSX → FortuneSheet cells, without React or file-service dependencies.
- Key abstractions: `convertXlsx(bytes, limits)`, `convertCell()`, `themeColors()`, `colorOf()`, `BORDER_STYLES`, `THEME_ORDER`.
- Data flow: bytes → `XlsxPreviewArchive.withoutDrawings()` → `workbook.xlsx.load(input, { ignoreNodes: ['drawing'] })` → per-sheet `celldata`, `config` (merge/rowlen/columnlen/rowhidden/colhidden/borderInfo), `frozen`, `showGridLines`.
- Non-obvious design decisions: the **area limit is enforced incrementally** — `include(r, c)` grows the bounding rectangle and throws `tooLarge` as soon as `row * column` exceeds `maxCells`, so a sparse sheet with a cell at `XFD1000` is rejected before a dense matrix is allocated. The theme colour table is parsed from `xl/theme/theme1.xml` with `fast-xml-parser` because ExcelJS's types omit it. `colorOf` re-implements the OOXML *tint* algorithm (which ExcelJS keeps but does not declare).
- Edge cases / failure handling: a workbook with no visible sheet is `invalid`; a formula with no cached result increments `missingResults` and renders blank. ExcelJS's `cell.result` is used rather than `cell.value` for formulas because "ExcelJS omits falsy caches from cell.value, while cell.result retains 0 and false".
- Surprising: the 1900 date system conversion is `getTime() / 86_400_000 + 25569` — the Excel serial epoch, computed here because FortuneSheet expects it.

### packages/client/ui-sidebar-documentpreview/src/client/excel/xlsx-archive.ts
- Purpose: the in-memory copy of an XLSX with DrawingML removed.
- Key abstractions: `XlsxPreviewArchive` (`unsupportedFeatures`, `withoutDrawings()`), `partKey()`, `decodeXml()`, `resolvePart()`.
- Data flow: bytes → `unzipSync` → an index of parts by ASCII-lowercased name → each `.rels` is parsed with `fast-xml-parser` → the referenced parts are inspected for `chart`/`pic`/`sp`/`conditionalFormatting` → the drawing parts and their rels are omitted → the retained entries are re-zipped (`level: 0`).
- Non-obvious design decisions: the **source bytes are never modified** — if nothing was omitted the original buffer is returned unchanged (`preview.byteOffset === 0 && …` check in `xlsx.ts:28`). The `drawing` relationship type is matched after normalising the *Strict* OOXML URI alias (`purl.oclc.org` → `schemas.openxmlformats.org`). `resolvePart` refuses a target that escapes the package root.
- Edge cases / failure handling: two ZIP entries whose names differ only in ASCII case are **ambiguous** and throw ("Ambiguous XLSX part"), because OPC compares part names case-insensitively. A missing referenced part throws. A relationship with no `Target` throws. `decodeXml` handles UTF-8 and both UTF-16 byte orders by sniffing the first two bytes.
- Surprising: the comment "OPC compares part names using ASCII case equivalence, leaving ZIP names intact" — and the test that a *non-ASCII* name (`Ä.xml` vs `ä.xml`) stays distinct, so the lowercasing is ASCII-only on purpose.

### packages/client/ui-sidebar-documentpreview/src/client/excel/xls.ts
- Purpose: legacy BIFF workbooks → FortuneSheet.
- Key abstractions: `convertXls(bytes, limits)`, `mapXlsWorkbook(workbook, limits)`.
- Data flow: bytes → a magic check (compound-file `D0 CF 11 E0…` or a BIFF version byte) → SheetJS `read(bytes, { type:'array', cellNF, cellStyles, cellFormula, sheetStubs })` → cells, merges, row/column metadata.
- Non-obvious design decisions: the magic check refuses a renamed text or HTML file *before* handing it to SheetJS ("without accepting renamed text or HTML files", line 14). The 1904-epoch adjustment is `+ 1462` and is applied only when the cell is a date format. A BIFF8 `CellParsedFormula` token array is read as a formula.
- Edge cases / failure handling: a workbook with no visible sheet is `invalid`; the area limit is enforced per sheet and cumulatively; a sparse sheet (`!ref` `A1:Z1000` with one cell) is rejected by the area limit.
- Surprising: `set_cptable(codepages)` is called at module scope to enable the legacy code pages.

### packages/client/ui-sidebar-documentpreview/src/client/excel/delimited.ts
- Purpose: CSV/TSV → one literal sheet.
- Key abstractions: `convertDelimited(bytes, format, limits)`.
- Data flow: BOM sniff → `TextDecoder(encoding, { fatal: true })` → `Papa.parse` with `dynamicTyping: false, header: false, skipEmptyLines: false` → cells.
- Non-obvious design decisions: **every value stays a literal string** — "Values remain literal strings, including leading zeros, dates, booleans, and formula-looking text". `dynamicTyping: false` plus the `'@'` number format in `formatCell` are the two halves of that promise. A malformed quoted field **fails the table** rather than silently dropping data.
- Edge cases / failure handling: invalid UTF-8/UTF-16 rejects with the `encoding` code and the UI offers "save the file as UTF-8 or UTF-16 with a BOM"; the area limit is checked per row.
- Surprising: the first row is data, not a header.

### packages/client/ui-sidebar-documentpreview/src/client/excel/model.ts
- Purpose: the shared display model, the limits, and the failure categories.
- Key abstractions: `ExcelLimits`, `EXCEL_UNSUPPORTED_FEATURES`, `ExcelUnsupportedFeature`, `ExcelPreview`, `initialSelection(config)`, `formatCell(cell, numberFormat)`.
- Data flow: `formatCell` applies the number format through FortuneSheet's `update()` and sets `cell.m` (the displayed text) plus the cell type.
- Non-obvious design decisions: the unsupported-feature list is a **closed, ordered tuple** (`['charts','images','shapes','conditionalFormatting']`) so the notice is deterministic. `formatCell` never evaluates a formula — it only formats a saved value.
- Edge cases / failure handling: `initialSelection` selects `A1` *including an A1 merge*, so activating a sheet does not land in the middle of a merged cell.
- Surprising: the alignment default is derived from the *value type* (`number` → 2, `boolean` → 0, else 1) — FortuneSheet's numeric codes, not CSS.

### packages/client/ui-sidebar-documentpreview/src/client/excel/format.ts
- Purpose: filename → parser selection, kept out of the heavy chunk.
- Key abstractions: `ExcelFormat`, `excelFormat(path)`.
- Data flow: the file's suffix → one of `xlsx | xls | csv | tsv`.
- Non-obvious design decisions: an unsupported suffix throws `ExcelPreviewError('invalid')` rather than returning `undefined`, so the caller has one error path.
- Edge cases / failure handling: the lookup is case-insensitive.
- Surprising: it is 16 lines and it is the reason a `.xlsm` does not download 3 MB of parsers.

### packages/client/ui-sidebar-documentpreview/src/client/excel/error.ts
- Purpose: the locale-independent failure categories.
- Key abstractions: `ExcelPreviewError` with `code: 'invalid' | 'tooLarge' | 'timeout' | 'encoding'`.
- Data flow: thrown by the parsers, mapped to a locale key by the body.
- Non-obvious design decisions: the category set is exactly the set the UI can say something useful about — there is no "unknown error" category.
- Edge cases / failure handling: `ErrorOptions` is passed through so the cause survives.
- Surprising: 8 lines, and the code path `ExcelPreviewError.code` is validated against a list in `parse.ts:49`.

### packages/client/ui-sidebar-documentpreview/src/client/excel/ExcelBody.module.css
- Purpose: the spreadsheet surface's layout, the scoped third-party overrides, and the notices.
- Key abstractions: `.body`, `.workbook`, `.notice`, `.formulaWarning`, `.withFormulaWarning`, `.status`.
- Data flow: n/a.
- Non-obvious design decisions: `color-scheme: light; color: CanvasText` on the workbook — "FortuneSheet's white controls need light-scheme text even in a dark app". The editing handles and the freeze drag handles are hidden with `:global(...)` selectors.
- Edge cases / failure handling: the sheet-tab strip gets `overflow-x: auto` and `scrollbar-width: none` so the tabs scroll with a trackpad but show no bar.
- Surprising: the formula warning is positioned at a hard-coded `left: 142px` to clear the formula bar.

### packages/client/ui-sidebar-documentpreview/src/client/excel/locales.ts
- Purpose: the spreadsheet dictionary, including the per-feature notice names.
- Key abstractions: `title`, `language`, `loading`, `invalid`, `tooLarge`, `timeout`, `encoding`, `formulaWarning`, `unsupportedNotice`, `charts`, `images`, `shapes`, `conditionalFormatting`, `featureSeparator`, `retry`.
- Data flow: `ctx.locale.register('sidebarExcel', { zh, en })`.
- Non-obvious design decisions: `language` is the locale handed to FortuneSheet (`'zh'`/`'en'`) so the third-party grid's own UI is localised. `featureSeparator` is a dictionary entry so the notice reads correctly in both languages.
- Edge cases / failure handling: four distinct parse failures each get their own message and their own advice.
- Surprising: `title` is "Spreadsheet" / "表格" — the *tab* name, not "Excel".

### packages/client/ui-sidebar-documentpreview/src/client/excel/asset-imports.d.ts
- Purpose: the ambient declarations for the two build-time imports the Excel chunk uses.
- Key abstractions: `*.ts?raw` and `@fortune-sheet/react/dist/index.css?inline`.
- Data flow: the worker source and the third-party stylesheet are inlined at build time.
- Non-obvious design decisions: the third-party CSS is imported as a *string* so it can be `@scope`d rather than injected globally.
- Edge cases / failure handling: n/a.
- Surprising: the worker is bundled as source text and re-bundled by a Rolldown sub-build (see `tsdown.config.ts`).

### packages/client/ui-sidebar-documentpreview/src/client/pdf/asset-imports.d.ts
- Purpose: the ambient declaration for the PDF.js worker source import.
- Key abstractions: `declare module 'pdfjs-dist/build/pdf.worker.min.mjs?raw'`.
- Data flow: the `.mjs` becomes a string that `runtime.ts` concatenates a ready-marker onto.
- Non-obvious design decisions: the import is typed by hand because the bundler plugin (`tsdown.config.ts`) is what actually resolves it.
- Edge cases / failure handling: n/a.
- Surprising: 8 lines standing in for a whole custom resolver.

### packages/client/ui-sidebar-documentpreview/tsdown.config.ts
- Purpose: the package's build configuration, including the three custom bundler plugins.
- Key abstractions: `clientBundle(...)`, `pdfWorker`, `excelWorker`, `pdfAssets()`, `excelLicenseBanner()`, `pdfLicenseBanner()`, `pdfLicenseFiles()`.
- Data flow: the client config gets (1) a resolver that turns `pdfjs-dist/.../pdf.worker.min.mjs?raw` into a string module, (2) a resolver that **re-bundles** `src/client/excel/worker.ts` with Rolldown into an IIFE string, and (3) `define: { __DSH_PDFJS_ASSETS__: pdfAssets() }`.
- Non-obvious design decisions: the Excel worker is bundled by a *nested* Rolldown build so the parser has no loader-module dependency in the browser; the nested build also reports its own modules to the outer build so "the outer build's license analysis must also see imports embedded in Worker text". The PDF.js assets (cmaps, standard fonts, wasm) are inlined as base64 into the artefact — the viewer never fetches them.
- Edge cases / failure handling: `addWatchFile` is called for the worker source and every module of the nested build so a change triggers a rebuild.
- Surprising: the licence banners are generated by *reading the installed dependencies' licence files* at build time — the repo's answer to "the published chunk must carry its third-party notices".

### packages/client/ui-sidebar-documentpreview/tsconfig.json
- Purpose: the composite project root.
- Key abstractions: two project references — `tsconfig.host.json` and `tsconfig.client.json`.
- Data flow: n/a (build wiring).
- Non-obvious design decisions: the host and the client are *separate* TypeScript projects so the host half can never import browser code.
- Edge cases / failure handling: n/a.
- Surprising: 8 lines and it is the reason `src/index.ts` (host) and `src/client/*` cannot be mixed.

### packages/client/ui-sidebar-documentpreview/tsconfig.host.json
- Purpose: the host project's compiler options and references.
- Key abstractions: `files: ['src/index.ts', 'src/config.ts']`.
- Data flow: n/a.
- Non-obvious design decisions: `files` (not `include`) — the host project compiles *only* those two files, so a stray browser module cannot be pulled in.
- Edge cases / failure handling: n/a.
- Surprising: it references `../../host/webserver` and `../../../vendor/schemastery` — the schema validator is vendored in-tree.

### packages/client/ui-sidebar-documentpreview/tsconfig.client.json
- Purpose: the client project's compiler options and 20 project references.
- Key abstractions: `include: ['src/client', 'src/config.ts', 'src/css-modules.d.ts']`.
- Data flow: n/a.
- Non-obvious design decisions: the reference list is the package's *real* dependency graph, written out — every sibling package it types against.
- Edge cases / failure handling: n/a.
- Surprising: `src/config.ts` is compiled into *both* projects, so the schema is checked once for the host and once for the browser.

### packages/client/ui-sidebar-documentpreview/tests/fixtures.client.ts
- Purpose: the shared harness for the body specs — a real store, a real face over a scripted read, a scripted `useResource`, and the owner props.
- Key abstractions: `harness(script, tabId)`, `page()`, `failure()`, `byteResult()`, `documentSlots()`, `settle()`, `createResources()`.
- Data flow: `harness()` builds the store instance, the scripted read, the face and the props builder; the specs script an offset's result and re-render.
- Non-obvious design decisions: the framework's standard kit is replaced by "the few members these components read, behind one documented cast" — the specs exercise the components, not the slot runtime. `settle()` is two microtask ticks inside `act`, because the face registers its store write *synchronously* before the read settles.
- Edge cases / failure handling: an unscripted offset resolves with `workspace-file/not-found`, so a spec that reads the wrong page fails loudly.
- Surprising: `createResources()` builds a real `ResourceRegistry` from another package's source (`../../resources/src/client/resources.ts`) — the dependency test uses the real thing.

### packages/client/ui-sidebar-documentpreview/tests/apply.client.spec.ts
- Purpose: the plugin's registrations and their removal on dispose.
- Key abstractions: `boot()` — a real `SidebarRightTabRegistry` with recorder slots, locale and Remote.
- Data flow: `ctx.plugin({ inject, apply })` → assert the registered seats → `fiber.dispose()` → assert everything is gone.
- Non-obvious design decisions: the test asserts the *exact* ordered list of 12 seats, including their components, so a new renderer cannot be added without an explicit decision. It also asserts that the seat key is the *implementation id*, not the kind ("an extension may take the kind over, and the seat must still find this body").
- Edge cases / failure handling: a duplicate-suffix check walks every registered extension and asserts the winner, so the code highlighter cannot silently steal a suffix.
- Surprising: the "keeps specialized previews first" test computes the expected owner of every extension from the registry itself — a self-consistency check rather than a hard-coded list.

### packages/client/ui-sidebar-documentpreview/tests/definition.client.spec.ts
- Purpose: what the `text` type claims and how it yields.
- Key abstractions: the real `SidebarRightTabRegistry`.
- Data flow: `tabs.claim(address)` → the claimed kind, content id and title.
- Non-obvious design decisions: the spec asserts the *unresolved* path is preserved byte-for-byte: `'../AGENTS.md'`, `'dir/../AGENTS.md'`, `'%252e%252e/AGENTS.md'` all claim with their authored content id. It also asserts that a narrower type at the `extension` band takes the address but the text type stays in `candidates` ("Still listed for the picture: a caller naming the kind may open it as text").
- Edge cases / failure handling: seven malformed addresses are checked to keep the Session parser's veto, and the `claim` error messages are asserted verbatim.
- Surprising: the fallback band's ranking is by *literal pattern length*, not by the size of the accepted address set — the spec pins that.

### packages/client/ui-sidebar-documentpreview/tests/face.client.spec.ts
- Purpose: the face's contract with the store.
- Key abstractions: `bench()` (a real store with a counted `forget`), `readQueue()` (deferred results).
- Data flow: `face.loadPage(...)` → settle → assert the store.
- Non-obvious design decisions: the specs settle settlements in **both orders** (retired-first and current-first) for success and failure, because the interesting bug is "a stale result landing after a fresh one". The `forget` action is wrapped in a spy so "the record's end must forget a tab exactly once" is measurable.
- Edge cases / failure handling: mode switches (`text-pages` ↔ `bytes-complete`) are exercised in both directions with four settlement orders each; a byte read that *rejects* is asserted to become a `gateway/internal` failure.
- Surprising: the test explicitly proves the read runs under the *address's* session, not the injected one, by injecting a different session id.

### packages/client/ui-sidebar-documentpreview/tests/store.client.spec.ts
- Purpose: the store's write set.
- Key abstractions: a real store instance.
- Data flow: actions → snapshot assertions.
- Non-obvious design decisions: the "read observation baseline" test pins the exact rule: the *first* observation is retained across overlapping reads, and only a `reset` (a new generation) clears it.
- Edge cases / failure handling: `forget` on an unknown tab is a no-op, not a fault ("the abort listener may fire for a tab that never wrote anything").
- Surprising: `reset` keeps `scrollTop`, `wrap` and `revision` but clears the pages — a reload is not a fresh tab.

### packages/client/ui-sidebar-documentpreview/tests/rpc.client.spec.ts
- Purpose: the address→read translation.
- Key abstractions: `hostFileOf`, `createReadPage`.
- Data flow: address → `{ sessionId, path }`.
- Non-obvious design decisions: the spec asserts the address's path is decoded **once** (`'a%20b%23c.md'` → `'a b#c.md'`) and that the *absolute* path is preserved verbatim for the Host.
- Edge cases / failure handling: six non-session address shapes must throw.
- Surprising: `hostFileOf` decodes the session id too (`'s%2F1'` → `'s/1'`), because the id segment is itself percent-encoded.

### packages/client/ui-sidebar-documentpreview/tests/resource-group.client.spec.ts
- Purpose: dependency membership and invalidation.
- Key abstractions: a harness with a real `createSnapshotStore`.
- Data flow: `group.add(address)` → the source's version changes → `changed()`.
- Non-obvious design decisions: the first metadata frame is a baseline; a *repeated identical failure* is not a change, but a failure and its recovery are.
- Edge cases / failure handling: `set()` releases members absent from the next document; `close()` is idempotent in effect (each member released once).
- Surprising: the test asserts `source` was called exactly once for two `add()`s of the same address.

### packages/client/ui-sidebar-documentpreview/tests/document-registry.client.spec.ts
- Purpose: the registry's ranking, snapshot stability, and rejection rules.
- Key abstractions: `DocumentPreviewRegistry`.
- Data flow: register → `candidates(path)` → dispose.
- Non-obvious design decisions: the snapshot is *stable* between changes (`getSnapshot()` returns the same array identity) and the listener sees exactly two publications for one register+dispose. A binary suffix outside `extensions` throws **and leaves the registry empty** ("rejects a binary suffix outside the declared extensions without registering").
- Edge cases / failure handling: a duplicate id throws and keeps the original; the disposer is idempotent.
- Surprising: `.TAR.GZ` and `tar.gz` and `gz` are all registered in one test and the expected order is by *suffix length*.

### packages/client/ui-sidebar-documentpreview/tests/document-unviewable.client.spec.ts
- Purpose: the unviewable binary list.
- Key abstractions: `unviewableBinaryPath`.
- Data flow: path → boolean.
- Non-obvious design decisions: the spec asserts `private.key` is **not** unviewable, and that a directory named `work.md` is not a match.
- Edge cases / failure handling: case, separators and depth are all exercised.
- Surprising: the "uncertain suffix keeps the plain-text fallback" rule is pinned by a list of twelve non-matches.

### packages/client/ui-sidebar-documentpreview/tests/failure-line.client.spec.ts
- Purpose: one sentence per code, and the transport's own words for anything else.
- Key abstractions: `failureLine`, `emptyFailureRecourse`.
- Data flow: a `RemoteFailure` → a locale key with its parameters.
- Non-obvious design decisions: the byte limit is asserted in three units (`512 B`, `4 KB`, `3 MB`).
- Edge cases / failure handling: `workspace-file/not-text` and `too-large` → `open`; `not-found` and `not-regular-file` → `none`; everything else → `retry`.
- Surprising: an *unknown* code retries — the conservative default is "try again", not "give up".

### packages/client/ui-sidebar-documentpreview/tests/lines.client.spec.ts
- Purpose: the page arithmetic.
- Key abstractions: `linesOf`, `loadedPages`, `lastLineLoaded`.
- Data flow: a page table → ordered pages → the last loaded line.
- Non-obvious design decisions: the spec pins that a trailing newline produces a final *empty* line, matching the Host's own count, and that `lines: 0` and `lines: 1, text: ''` are different things.
- Edge cases / failure handling: n/a.
- Surprising: `lastLineLoaded` is `offset + lines - 1`, so a page of 0 lines does not advance the end.

### packages/client/ui-sidebar-documentpreview/tests/loading-indicator.client.spec.tsx
- Purpose: the loading affordance.
- Key abstractions: `LoadingIndicator`.
- Data flow: n/a.
- Non-obvious design decisions: the inline variant keeps `aria-label` but has no text content; the centred variant is 28px and the inline 14px.
- Edge cases / failure handling: n/a.
- Surprising: 18 lines of source, 30 of test — the affordance is tiny and the test is not.

### packages/client/ui-sidebar-documentpreview/tests/text-title.client.spec.tsx
- Purpose: the chip title.
- Key abstractions: `TextTitle`.
- Data flow: n/a.
- Non-obvious design decisions: the spec asserts the icon is 16px and `aria-hidden`, and that the Markdown and PDF sheets differ.
- Edge cases / failure handling: n/a.
- Surprising: the icon is chosen from the *title string*, so the test can only distinguish it by comparing two SVGs.

### packages/client/ui-sidebar-documentpreview/tests/text-preview.client.spec.tsx
- Purpose: the body's page, metadata, navigation and header behaviour.
- Key abstractions: `harness()`, `PendingIntersectionObserver`, the `offsetTop`/`scrollTop` stubs.
- Data flow: the spec drives the real body with a real store and a real face.
- Non-obvious design decisions: jsdom lays nothing out, so the spec *supplies* the two geometry facts the body depends on — "a line's offset is its number times one line height, and `scrollTop` holds what it is set to" — and says so, rather than mocking the component. The spec pins the "remount reads nothing" rule (the store outlives the body) and the "navigation is answered once" rule (the revision is recorded).
- Edge cases / failure handling: the metadata-failure vs change-notice precedence is pinned, and the "one failure is said once" rule is pinned (with nothing read, the body's own failure is the whole story).
- Surprising: the spec asserts that a scroll to the end loads the next page (`offset: 3` after `offset: 1`) — the body requests the next page from the *scroll event*, not from a button alone.

### packages/client/ui-sidebar-documentpreview/tests/document-toolbar.client.spec.tsx
- Purpose: the toolbar's controls and the viewer picker.
- Key abstractions: `codeProps()`, the real `CodeBody` behind a `documentSlots` shim.
- Data flow: definitions → the picker → the selected body.
- Non-obvious design decisions: the spec drives the whole toolbar through the real body, including the `changed` / `reloadNow` bar and the `Load more` button, and asserts that the *same* `CodeBody` element survives pagination ("retaining code during pagination") — a re-render that replaced the DOM would reset the highlighter.
- Edge cases / failure handling: the plain-text option is offered for `.svg` and `.html` but **not** for `.png` or `.pdf` — the binary-suffix rule, pinned per format.
- Surprising: the spec asserts that when nothing has been read, the *first* read's status occupies the body and the "Load more" button does not exist yet.

### packages/client/ui-sidebar-documentpreview/tests/document-seat.client.spec.tsx
- Purpose: extension registration and dispatch through the *production* Sidebar and Slot renderer.
- Key abstractions: `SlotTestRuntime`, a real `SidebarRightTabRegistry`, a real `ResourceRegistry`.
- Data flow: `sidebarRight.openResource(address)` → the real claim path → the real body → the real Remote.
- Non-obvious design decisions: the spec asserts the body receives a resource snapshot with **no** `operations` field and no `ctx` — the extension point is narrow by construction, not by convention.
- Edge cases / failure handling: an absolute (session-less) address is rejected by `candidates` before any reader is mounted.
- Surprising: switching the selected implementation does **not** change the tab — the tab id is asserted to be the same before and after.

### packages/client/ui-sidebar-documentpreview/tests/renderer-loading.client.spec.tsx
- Purpose: renderer-owned loads — retention, retirement, and failure handling.
- Key abstractions: a custom `CustomBody` that owns its own read, and the real `OfficeBody` + `officeFace`.
- Data flow: `content.kind === 'renderer'` → the body's own load → `loaded(version)` / `failed()` → the store.
- Non-obvious design decisions: the spec proves the "late version report" rule from both sides — a superseded load's `loaded('v1')` after `v2` has landed must not move the version. It also proves that a *failure* is retried automatically only after another file change, and that a declared failure and an exception are treated the same.
- Edge cases / failure handling: the three retirement transitions (`replace`, `close`, `hide`) are each checked to abort the pending conversion and ignore a late rejection.
- Surprising: the missing-font details are asserted to be *cleared* on reload and to show only the current revision's fonts.

### packages/client/ui-sidebar-documentpreview/tests/basic-html.client.spec.ts
- Purpose: the inert static HTML document.
- Key abstractions: `createBasicHtmlDocument` under jsdom.
- Data flow: markup → sanitised document → re-parsed and inspected.
- Non-obvious design decisions: the spec includes two **parser-mutation** payloads (a MathML `href`, and a `mglyph`/`style` sequence that re-parses into an `<a href>`), and asserts the *re-parsed* document has no `href` and exactly one `meta[http-equiv]`.
- Edge cases / failure handling: nested `<template shadowrootmode="open">` content and SVG animation elements are asserted to be stripped.
- Surprising: the spec asserts the CSP meta is the *first* element in `<head>` — a policy that appears later can be preceded by another policy.

### packages/client/ui-sidebar-documentpreview/tests/html-apply.client.spec.ts
- Purpose: the HTML registration and its injected reader.
- Key abstractions: `apply`, `htmlBodyDefinition`.
- Data flow: the injected `readRelated` → `remote.workspaceFiles.readBytes(sessionId, path, { baseFile }, signal)`.
- Non-obvious design decisions: the spec asserts the read uses the session **from the address**, with the `baseFile` set to the addressed document's path, and that an absolute (session-less) address throws.
- Edge cases / failure handling: the disposal removes the registry, the body and the dictionary.
- Surprising: the spec runs the registration with no Session or Tab services mounted at all — "the global callback must use its file address".

### packages/client/ui-sidebar-documentpreview/tests/html-bootstrap.client.spec.ts
- Purpose: the in-frame bootstrap, executed for real.
- Key abstractions: `runInNewContext` with a fake `document`/`URL`/`Blob`.
- Data flow: `createHtmlDocument(bundle)` → the extracted script is *executed* → `document.write` is captured.
- Non-obvious design decisions: the payload is asserted to contain exactly **one** `</script>` even when the source HTML contains one, and the non-ASCII text is asserted to be absent from the outer HTML — the base64 payload is opaque. The script order and the `defer`/`async` attributes are asserted to survive the rewrite.
- Edge cases / failure handling: invalid UTF-8 in the root or in an asset throws before the document is built; a 256 KiB payload survives the chunked base64 encode.
- Surprising: the test runs the bootstrap in a `node:vm` context with a *fake* `document` — the same code that runs in the browser, asserted without a browser.

### packages/client/ui-sidebar-documentpreview/tests/html-pack.client.spec.ts
- Purpose: the finite dependency packer.
- Key abstractions: `packHtml` with an injected reader.
- Data flow: HTML → the asset list → the reader's calls.
- Non-obvious design decisions: the spec enumerates every *unsupported* form — HTTPS, protocol-relative, `type="module"`, `application/ld+json`, `file:`, root-relative, `data:`, an inline `fetch`, a `rel="icon"` link, a commented-out script — and asserts **no read** happens for any of them. Three separate limit failures are exercised: the total byte limit, the per-asset byte limit and the asset-count limit.
- Edge cases / failure handling: a read that rejects propagates; an asset that is not valid UTF-8 rejects ("rather than returning a partial package"); a read that settles after cancellation is discarded.
- Surprising: the base64-encoded `&` in an HTML attribute is decoded once (`'main.css?v=1&amp;x=2'` → `'main.css?v=1&x=2'`).

### packages/client/ui-sidebar-documentpreview/tests/html-read-relative.client.spec.ts
- Purpose: the relative reader's decoding and refusal rules.
- Key abstractions: `createReadHtmlRelative`.
- Data flow: a reference → the Host read → the observed dependency address.
- Non-obvious design decisions: the spec asserts the *observed* dependency is the Host-resolved absolute path, never the authored `linked/../style.css` spelling — and on failure, the Host's `error.details.path`, with **no** observation when the failure carries no path.
- Edge cases / failure handling: eight refused reference shapes, including `%2Fx.js` and `%ZZ.js`.
- Surprising: the tab's lifetime aborts the read's signal, but the *packing* signal is a separate one — both are combined.

### packages/client/ui-sidebar-documentpreview/tests/html-body.client.spec.tsx
- Purpose: the iframe's ownership.
- Key abstractions: `props()`, a real `TextPreview` driving a real `HtmlBody`.
- Data flow: bytes → the frame → the Blob URL.
- Non-obvious design decisions: the spec drives the *whole* preview (not the body in isolation) so the dependency-watch → reload path is exercised: a change to a `.css`/`.js` dependency re-reads the root **and** the dependency and replaces the frame, while the root's own version stays `root-v1`.
- Edge cases / failure handling: switching to the static mode releases the CSS/JS subscriptions and stops re-reading, but the root file stays watched. Invalid bytes and a Blob-creation failure leave no previous frame running.
- Surprising: the spec asserts the frame is *retained* across unrelated prop changes (`wrap`) — "keeping it mounted for unrelated props".

### packages/client/ui-sidebar-documentpreview/tests/image-body.client.spec.tsx
- Purpose: the image Blob's ownership and the zoom behaviour.
- Key abstractions: `props()` with a real zoom store.
- Data flow: bytes → a Blob URL → an `<img>` → `onLoad` → the zoom controls.
- Non-obvious design decisions: the spec asserts the Blob URL is revoked on unmount and on replacement, and that a zoom change **does not** recreate the Blob or the `<img>` ("retains image zoom without recreating the image or Blob URL") — an animated image must keep playing.
- Edge cases / failure handling: a decode failure, a Blob-creation failure, a text delivery and an unregistered suffix are each asserted to produce the right message; the last two create no Blob at all.
- Surprising: the SVG case is asserted to produce the *same* `image/svg+xml` Blob type as a raster image, and the file is not treated as binary.

### packages/client/ui-sidebar-documentpreview/tests/image-registration.client.spec.ts
- Purpose: the image registration and disposal.
- Key abstractions: a recorder slot.
- Data flow: `ctx.plugin({ apply })` → the registry, the dictionary, the keyed body.
- Non-obvious design decisions: the spec asserts `title` is **not** called at registration time (it is a function, evaluated when the toolbar renders) and that the store's `forget` is wired to the tab's abort.
- Edge cases / failure handling: every contribution is removed on dispose.
- Surprising: the test asserts `retainTab` twice with the same signal and then the abort — the tab's state is forgotten exactly once.

### packages/client/ui-sidebar-documentpreview/tests/markdown-registration.client.spec.tsx
- Purpose: the Markdown registration through the real Slot runtime.
- Key abstractions: `SlotTestRuntime`, a real `LocaleRuntime`, a real `ResourceRegistry`.
- Data flow: the document slot is declared by the *owner*; the renderer waits for it.
- Non-obvious design decisions: the spec asserts the body renders **without** calling `useTabInfo` at all — a renderer that does not need the tab must not depend on it. It also asserts the locale *function identity* survives a locale change (`expect(locale.bind('documentMarkdown')).toBe(t)`) so a language switch does not remount the body.
- Edge cases / failure handling: after disposal the slot is empty and the fallback marker is rendered; a re-mount restores the body.
- Surprising: the image URL is asserted to resolve to the *Host's* absolute path (`/work/guide/images/a.png`), i.e. relative image resolution waits for the metadata.

### packages/client/ui-sidebar-documentpreview/tests/markdown-body.client.spec.tsx
- Purpose: the accumulated Markdown renderer.
- Key abstractions: `content(pageTexts, eof)`.
- Data flow: pages → one accumulated text → `MarkdownText`.
- Non-obvious design decisions: the spec asserts the *same* heading element and the *same* `pre.shiki` element survive page growth and settlement — the primitive is retained, not re-created. It also asserts that cross-page reference definitions and KaTeX only resolve **at EOF** (the primitive's contract).
- Edge cases / failure handling: the frontmatter field list is asserted for ten keys including a folded scalar, a list, an alias, a null value and a numeric key; invalid YAML, a scalar document and a sequence document all fall back to the verbatim block. An *unterminated* `---` stays Markdown, and a `---` after a leading blank line does too.
- Surprising: the spec asserts that a frontmatter block with a comment only (`---\n# comment\n---`) renders as an **empty** box, not the comment.

### packages/client/ui-sidebar-documentpreview/tests/markdown-frontmatter-fallback.client.spec.tsx
- Purpose: a failed frontmatter chunk.
- Key abstractions: `vi.mock` that *throws* on import.
- Data flow: the lazy import rejects → the `Suspense` fallback is the verbatim block.
- Non-obvious design decisions: the spec asserts the body still renders its heading — "The failed chunk only removes the field layout; the body and verbatim metadata stay usable".
- Edge cases / failure handling: the verbatim text must still be present after the rejection settles.
- Surprising: the rejection handler is the *second* argument of the `lazy()` call, so the fallback component is chosen at import time, not at render time.

### packages/client/ui-sidebar-documentpreview/tests/markdown-path-images.client.spec.ts
- Purpose: the image URL builder.
- Key abstractions: `markdownImageUrl`.
- Data flow: destination → a `/api/file?path=…` URL.
- Non-obvious design decisions: the spec asserts the deployment prefix survives when the base includes an HTML filename (`index.html`), and that the *hash* is dropped from the result. Fourteen unsupported destinations are enumerated, including `javascript:`, `data:`, `file:` and `C:a.png`.
- Edge cases / failure handling: a relative image with no document path returns `undefined`; an absolute one does not need it.
- Surprising: the Desktop scheme `dsh-app://app/` is asserted to work — the same builder serves both the web and the desktop base URLs.

### packages/client/ui-sidebar-documentpreview/tests/code-registration.client.spec.tsx
- Purpose: the code renderer's registration lifetimes.
- Key abstractions: `SlotTestRuntime`.
- Data flow: mount → the registry snapshot → the slot entries.
- Non-obvious design decisions: the spec asserts the metadata is published **before** the document slot exists ("publishes builtin metadata before the document slot exists and waits to register its body") — the two registrations are deliberately not atomic.
- Edge cases / failure handling: a disposed feature removes the metadata, the body and the dictionary; a re-declared slot re-mounts the body.
- Surprising: the spec asserts the dedicated HTML/Markdown builtins stay *ahead* of the shared code highlighter — the code renderer is a fallback, not a competitor.

### packages/client/ui-sidebar-documentpreview/tests/code-body.client.spec.tsx
- Purpose: the streaming highlighter.
- Key abstractions: `installStyles()` — the two stylesheets are read from disk and injected with Vite's module names.
- Data flow: pages → one `CodeBlock` → Shiki tokens.
- Non-obvious design decisions: the spec asserts that a **multiline grammar state** survives a page boundary (an unterminated block comment continues as a comment token on the next page) and that the *token stream* of a settled document equals the token stream of the same text delivered at once — the streaming path and the final path agree.
- Edge cases / failure handling: a malformed address throws; HTML and Markdown are rendered as *source*, not as markup.
- Surprising: the spec compares the rendered CSS to assert that the wrap toggle changes `white-space` without remounting the highlighter or the scrollport.

### packages/client/ui-sidebar-documentpreview/tests/config.host.spec.ts
- Purpose: the Host configuration surface.
- Key abstractions: `Config`, the `webserver/index-inject` event.
- Data flow: `ctx.plugin(host, config)` → the inject table.
- Non-obvious design decisions: the spec asserts the *exact* default object (all eight limits) and that a **zero** limit throws for every key, plus that `timeoutMs` above 2^31−1 throws.
- Edge cases / failure handling: disposal withdraws the injection.
- Surprising: the test is the reason "0 means unlimited" can never be introduced here by accident.

### packages/client/ui-sidebar-documentpreview/tests/document-preview-license-bundle.client.spec.ts
- Purpose: the published chunks keep their third-party licence notices and their chunk boundaries.
- Key abstractions: `pnpm pack` → a tarball → `tar -xOf` on the packed files; `runInNewContext` to boot the lazy chunks.
- Data flow: the package is packed into a temp directory and its chunks are extracted and inspected.
- Non-obvious design decisions: the spec asserts the **exact** `require.async` list in `client.js` (`['./client.frontmatter-fields.js','./client.pdf.js','./client.excel.js']`) and that no chunk statically requires another — a chunk-boundary gate. It then boots the frontmatter and Excel chunks in a `node:vm` context with a fake `window.__ModuleLoader__` and asserts they initialise with *only* React as an external dependency.
- Edge cases / failure handling: the test is `skipIf(!existsSync(bundlePath))` — it silently skips when the package has not been built, which is an honest limitation of a packaging gate.
- Surprising: it asserts the Excel chunk contains the SheetJS and PapaParse licence texts *verbatim*, line by line.

### packages/client/ui-sidebar-documentpreview/tests/office-cache.client.spec.ts
- Purpose: the Office cache's sharing, freshness and bounded reuse.
- Key abstractions: `harness(entries, bytes, pending, readers)` with controlled completions.
- Data flow: `cache.read(file, signal, priority)` → the stat probe → the conversion → the retained entry.
- Non-obvious design decisions: the spec pins the **whole** sharing contract: a cancelled reader leaves the shared conversion running; a late-cancelled conversion is discarded; a source that changed during conversion is not retained; a *different* canonical source with a matching version token is not reused; the borrowed buffer is reused **without copying** (the identity of the `Uint8Array` is asserted).
- Edge cases / failure handling: the generation-change path is tested three ways (a stale query, a newer generation accepted mid-flight, a re-authorised stat that completes after the generation changed) and the repeated-supersession path reports the localized "busy".
- Surprising: the spec asserts the *background* priority reserves capacity: a background read is refused when `maxPending`/`maxReaders` is 1, and the final slot is kept for a foreground promotion.

### packages/client/ui-sidebar-documentpreview/tests/office-registration.client.spec.ts
- Purpose: the Office registration end to end.
- Key abstractions: `harness(config, missing)` — the Remote can be missing entirely, or the render namespace, or the files namespace.
- Data flow: the registration → the cache → the Host Remote.
- Non-obvious design decisions: the spec asserts the **registration survives a missing Host renderer** and the read rejects with the localized "unavailable" guidance — the tab still claims `.doc`/`.pptx`. It also asserts the *authorisation probe* is a 1-byte read and that a probe failure refuses the cached bytes.
- Edge cases / failure handling: ten Host conversion reasons are each mapped to their locale key; a `connection/reset` replaces the cache; disposal cancels the Host request and waits for it.
- Surprising: a source replaced between the probe and the stat is refused with "the file changed while being read" — and the conversion is never requested.

### packages/client/ui-sidebar-documentpreview/tests/office-font-notice.client.spec.tsx
- Purpose: the missing-font panel.
- Key abstractions: `FontNotice`.
- Data flow: fonts → a warning → a portal dialog.
- Non-obvious design decisions: the spec asserts focus moves *into* the dialog on open and returns to the trigger on close or Escape, that a blur into the panel's own close button does **not** close it, and that nothing is retained between mounts.
- Edge cases / failure handling: an empty font list renders nothing at all.
- Surprising: the spec asserts the dialog is a `role="dialog"` with an accessible name — it is a non-modal dialog, but it is announced as one.

### packages/client/ui-sidebar-documentpreview/tests/pdf-registration.client.spec.ts
- Purpose: the PDF registration and the view-state lifetime.
- Key abstractions: a mocked `openPdf` and a mocked `pdf.tsx`.
- Data flow: `ctx.plugin({ apply })` → the registry, the dictionary, the keyed body.
- Non-obvious design decisions: the spec asserts the lazy body's `Suspense` fallback is the shared loading indicator with the right accessible name, and that `retainTab` twice with the same signal still results in exactly one forget.
- Edge cases / failure handling: an aborted tab's state is forgotten; a plugin disposal forgets every retained tab.
- Surprising: the spec pins that the *body* registered for the PDF is `LazyPdfBody`, not `PdfBody` — the chunk boundary is part of the contract.

### packages/client/ui-sidebar-documentpreview/tests/pdf-store.client.spec.ts
- Purpose: the PDF view store.
- Key abstractions: `createPdfStore`.
- Data flow: actions → snapshot.
- Non-obvious design decisions: two store *instances* are independent even for the same tab id — the factory is per-session.
- Edge cases / failure handling: `forget` drops one tab.
- Surprising: 25 lines of test for a 52-line store — the invariants are few and sharp.

### packages/client/ui-sidebar-documentpreview/tests/pdf-assets.client.spec.ts
- Purpose: the binary asset factory.
- Key abstractions: `createPdfBinaryDataFactory`.
- Data flow: a `{ kind, filename }` request → decoded bytes.
- Non-obvious design decisions: the spec asserts the factory **never** falls back to the network — `fetch` is stubbed and asserted not to have been called for an unbundled file. The prototype-key case (`'toString'`) is asserted to throw, proving the `Object.hasOwn` guard.
- Edge cases / failure handling: the returned buffer is independent — a `structuredClone(…, { transfer })` empties it and the next fetch still returns the bytes.
- Surprising: the ambient `__DSH_PDFJS_ASSETS__` global is read only when the factory is *created*, not at module load.

### packages/client/ui-sidebar-documentpreview/tests/pdf-text.client.spec.ts
- Purpose: the text overlay's lifecycle.
- Key abstractions: `pdfTextRenderer` with a mocked `TextLayerBuilder`.
- Data flow: a page + a viewport → a scaled overlay.
- Non-obvious design decisions: the spec asserts the overlay's `scale` is recomputed on resize (0.5 → 0.25) and that `cancel()` disconnects the observer, cancels the layer and removes the DOM.
- Edge cases / failure handling: n/a.
- Surprising: the spec supplies a `ReadableStream` as `streamTextContent` — the layer is never really rendered, and the test is about the *geometry and cleanup*, not the text.

### packages/client/ui-sidebar-documentpreview/tests/pdf-document.client.spec.ts
- Purpose: page rendering cancellation.
- Key abstractions: controlled `pdfjs` promises.
- Data flow: `renderPdfPage(...)` → canvas + text.
- Non-obvious design decisions: the spec drives cancellation with *controlled promises* rather than scheduler delays ("not scheduler delays", file header). It asserts that `page.cleanup()` runs only **after** the render promise settles, and that a `getPage` that settles after cancellation never touches the canvas (the canvas's width is still the jsdom default).
- Edge cases / failure handling: the abort that happens *inside* `page.render()` — before the abort listener is attached — is still honoured.
- Surprising: the raster-cap test asserts `canvas.width * canvas.height === 16_777_216` exactly while the CSS size stays `8192px`.

### packages/client/ui-sidebar-documentpreview/tests/pdf-runtime.client.spec.ts
- Purpose: the PDF Worker's ownership, handshake and teardown.
- Key abstractions: a `ControlledWorker` and a mocked `pdfjs-dist`.
- Data flow: `openPdf(data, signal, reportFailure)` → the handshake → `getDocument`.
- Non-obvious design decisions: the spec asserts the module-worker options exactly (`{ type: 'module', name: 'dsh-pdf' }`), that `getDocument` is **not** called before the handshake, and that the bytes handed to PDF.js are a *copy* (transferring them away leaves the caller's buffer intact). It also asserts the option set (`useWorkerFetch: false, enableXfa: false, cMapPacked: true, isEvalSupported: false`) and the comment that `isEvalSupported` is a compatibility field PDF.js 6 does not read.
- Edge cases / failure handling: a worker crash *after* loading is reported and the document destroyed; a failure callback that throws is caught and logged; a Worker blocked by policy (a `SecurityError`) still revokes the source URL; unrelated wire messages are ignored until the ready acknowledgement.
- Surprising: the disposal awaits `loading.destroy()` **before** terminating the Worker, and the spec asserts the Worker is *not* terminated until the destruction settles.

### packages/client/ui-sidebar-documentpreview/tests/pdf-body.client.spec.tsx
- Purpose: the PDF body's controls and stale-completion guards.
- Key abstractions: a mocked `openPdf`/`renderPdfPage`, an `IntersectionObserverStub`.
- Data flow: bytes → the document → the pages.
- Non-obvious design decisions: the spec asserts the *displayed bitmap is retained* while a new zoom render is in flight and that the previous canvas is still in the DOM — "The previous bitmap and selectable text stay visible until the replacement bitmap is ready". It also asserts the Ctrl+wheel gesture does **not** write to the store until it settles (120 ms) but does update the display immediately.
- Edge cases / failure handling: a late document from a replaced load is ignored; a `PasswordException` and a `PdfWorkerFailure` get their own messages; a failed canvas context is retried and the previous bitmap survives.
- Surprising: the spec asserts that only pages *near* the viewport are rendered and re-rendered — the render call sequence is `['1','2','1']` for a zoom change, then `'1','2','1','2'` as pages return.

### packages/client/ui-sidebar-documentpreview/tests/pdf-smoke.client.spec.ts
- Purpose: a real-library smoke test.
- Key abstractions: a Node `worker_threads` carrier for the real PDF.js worker.
- Data flow: the fixture → the real PDF.js → `renderPdfPage` → the centre pixel of each page.
- Non-obvious design decisions: the adapter carries browser-style `MessageEvent`s across a real Node worker thread, and the test asserts the *colour* of the centre pixel of each page (red-ish, then blue-ish) — the rendering is real, not mocked.
- Edge cases / failure handling: n/a.
- Surprising: this is the only test in the shard that exercises the real third-party library end to end.

### packages/client/ui-sidebar-documentpreview/tests/pdf-fixture.ts
- Purpose: deterministic PDF bytes.
- Key abstractions: `pdfFixture(userUnit, rotation)`, `selectionPdfFixture()`, `pdfObjects()`.
- Data flow: hand-written PDF objects → an explicit xref table → bytes.
- Non-obvious design decisions: the fixture writes its own xref table so the bytes are byte-stable and contain no clock or external font. `selectionPdfFixture` produces a journal-like page with table cells and blank regions "for drag selection".
- Edge cases / failure handling: `userUnit` and `Rotate` are parameters so page-unit and rotation handling can be exercised.
- Surprising: a hand-written PDF generator in the test tree is the only way to test a PDF viewer without a fixture file.

### packages/client/ui-sidebar-documentpreview/tests/pdf-worker.fixture.mjs
- Purpose: the Node worker-thread carrier for the real PDF.js worker.
- Key abstractions: a `port` shim over `parentPort`.
- Data flow: `WorkerMessageHandler.initializeFromPort(port)`.
- Non-obvious design decisions: the shim translates `postMessage`/`addEventListener`/`removeEventListener` into the Node worker's API, so PDF.js's browser-shaped worker API is satisfied without a browser.
- Edge cases / failure handling: n/a.
- Surprising: 749 bytes, and it is what makes the real-library smoke test possible.

### packages/client/ui-sidebar-documentpreview/tests/zoom-store.client.spec.ts
- Purpose: the zoom store's isolation.
- Key abstractions: `createZoomStore`.
- Data flow: actions → snapshot.
- Non-obvious design decisions: the fixed and fit-width preferences are stored as *values*, not as a mode flag plus a number.
- Edge cases / failure handling: `forget` drops one tab.
- Surprising: `DEFAULT_ZOOM` is `FIT_WIDTH` — the constant is exported from the store module, so the type module does not depend on the store.

### packages/client/ui-sidebar-documentpreview/tests/zoom-viewport.client.spec.tsx
- Purpose: the zoom fitting and the controls' visibility.
- Key abstractions: `fitWidthZoom`, `ZoomViewport`.
- Data flow: a viewport width → a scale → the CSS variable.
- Non-obvious design decisions: the spec asserts the *pointer-anchored* zoom keeps a centred surface point under the pointer when crossing into overflow, computing the expected scroll offsets by hand. It also asserts the controls' reveal behaviour: the bottom 72px zone, the 420 ms delay, and that hover, focus and an open menu each keep the control visible.
- Edge cases / failure handling: `ResizeObserver` being absent must not break the initial fit; the timers are cleared on unmount (`vi.getTimerCount() === 0`).
- Surprising: the spec stubs `document.elementFromPoint` to `null` for the ordinary cases and to the surface for the anchoring case — the anchor is optional and the code handles both.

### packages/client/ui-sidebar-documentpreview/tests/excel-registration.client.spec.ts
- Purpose: the spreadsheet registration.
- Key abstractions: `apply(scope, limits)`.
- Data flow: the registry snapshot → the keyed body.
- Non-obvious design decisions: the spec asserts the Excel registration is **independent of the Office service** — it never touches `remote.officeToPdf` — and that the injected value is exactly `{ limits }`.
- Edge cases / failure handling: `.csv`/`.tsv` are not binary; `.xlsx`/`.xls` are.
- Surprising: the assertion `binaryDocumentPath(…)` is `/\.(xlsx|xls)$/iu.test(path)` — the test derives the expectation from the path rather than hard-coding a list.

### packages/client/ui-sidebar-documentpreview/tests/excel-worker.client.spec.ts
- Purpose: the Worker's response protocol.
- Key abstractions: `globalThis.onmessage` with a stubbed `postMessage`.
- Data flow: a message → `{ ok: true, value }` or `{ ok: false, code }`.
- Non-obvious design decisions: the spec asserts an *unexpected* parser failure is reported as `invalid` — the Worker's protocol has no "unknown" category.
- Edge cases / failure handling: `maxCells: 1` produces `tooLarge`.
- Surprising: the test imports the worker module *after* stubbing the globals, because the module installs `globalThis.onmessage` at import time.

### packages/client/ui-sidebar-documentpreview/tests/excel-parse.client.spec.ts
- Purpose: the parser Worker's allocation, cancellation, timeout and message validation.
- Key abstractions: a fake `ParserWorker` class.
- Data flow: `parseExcel(...)` → `postMessage` → a message.
- Non-obvious design decisions: the spec asserts the transferred buffer is a **copy** (`expect(message.bytes).not.toBe(input)`) and that the retained input survives the transfer. Thirteen malformed Worker messages are enumerated and each must reject with `invalid` — the Worker is untrusted.
- Edge cases / failure handling: an aborted or oversized input allocates **no Worker at all**; a `postMessage` failure terminates the Worker; every path leaves zero timers pending.
- Surprising: the spec asserts `vi.getTimerCount() === 0` after each scenario — a leaked timeout in a preview tab would keep a Worker alive forever.

### packages/client/ui-sidebar-documentpreview/tests/excel-convert.client.spec.ts
- Purpose: the XLSX conversion's fidelity.
- Key abstractions: `convertExcel`.
- Data flow: a workbook → sheets.
- Non-obvious design decisions: the spec asserts a *cached formula result of `0` or `false`* is preserved (`{ formula: '=1-1', result: 0 }` → `v: 0`) — the bug ExcelJS's `cell.value` would hide. It also asserts a cell with **no** cached result renders as `m: ''` and increments `missingResults`.
- Edge cases / failure handling: a workbook with only a hidden sheet is `invalid`; a sparse sheet or a styled cell at `XFD1000` is `tooLarge`; a theme-less workbook is fine.
- Surprising: the theme *tint* algorithm is asserted numerically (`#a7c0de` from a theme colour with tint 0.5) — the tint maths is reimplemented in the adapter and therefore pinned.

### packages/client/ui-sidebar-documentpreview/tests/excel-body.client.spec.tsx
- Purpose: the spreadsheet surface's lifecycle.
- Key abstractions: a mocked `parseExcel` and a mocked `Workbook`.
- Data flow: bytes → the parse → the workbook.
- Non-obvious design decisions: the spec asserts the FortuneSheet options exactly — `allowEdit: false, forceCalculation: false, showToolbar: false, showSheetTabs: true, cellContextMenu: ['copy']` — i.e. the *absence* of features is pinned as carefully as the presence. It also asserts the `ResizeObserver` dispatches a synthetic `window` `resize` event.
- Edge cases / failure handling: five distinct parse failures map to their locale keys and each offers a Retry; a retired parse result is ignored; a non-Error rejection falls back to the generic message.
- Surprising: the spec asserts the file-replacement path creates a *second* observer and disconnects the first.

### packages/client/ui-sidebar-documentpreview/tests/excel-formats.client.spec.ts
- Purpose: the XLS, CSV and TSV paths.
- Key abstractions: `convertExcel`, `mapXlsWorkbook`, `excelFormat`.
- Data flow: bytes → a sheet.
- Non-obvious design decisions: the spec asserts the 1904-epoch adjustment (a date serial shifts by 1462) and that a CSV value of `'00123'` stays the *string* `'00123'` with the `'@'` number format, that `'=SUM(1,2)'` stays literal text with **no** formula property, and that `'TRUE'` is the string `'TRUE'`.
- Edge cases / failure handling: a damaged, renamed-text, hidden-only and oversized legacy workbook are each rejected; broken quoting fails the CSV rather than dropping data; invalid encoding is its own category.
- Surprising: the spec reads an *independently generated* Office `.xls` from another package's fixture tree (`apps/web/tests/fixtures/office/preview.xls`).

### packages/client/ui-sidebar-documentpreview/tests/excel-drawings.client.spec.ts
- Purpose: the DrawingML omission and the feature notices.
- Key abstractions: `XlsxPreviewArchive`, `convertExcel`.
- Data flow: a charted workbook → the same cells as the uncharted one, plus a notice.
- Non-obvious design decisions: the spec asserts the charted workbook produces **exactly the same sheets** as the baseline — the omission is invisible to the cell data — and that the source bytes are unchanged (`expect(source).toEqual(before)`).
- Edge cases / failure handling: three DrawingML namespace prefix shapes are exercised; images with and without a background are both reported; a comment VML is retained and is **not** reported as a chart or an image.
- Surprising: `unzipSync(archive.withoutDrawings())` is asserted to be *idempotent* — running the omission twice yields the same archive.

### packages/client/ui-sidebar-documentpreview/tests/excel-opc.client.spec.ts
- Purpose: OPC part resolution against independent-writer workbooks.
- Key abstractions: `excelOpcCases`, the Node *and* browser-bundle ExcelJS entries.
- Data flow: a fixture → `withoutDrawings()` → `workbook.xlsx.load(...)`.
- Non-obvious design decisions: the spec runs every case against **both** ExcelJS entry points ("Node ExcelJS entry" and "browser bundle") — the patched browser bundle must behave like the Node source. It also asserts that a *namespace-prefixed* worksheet produces an identical preview.
- Edge cases / failure handling: a missing worksheet part, a missing relationship, a `..` escape and an external target each fail the preview instead of dropping the sheet; missing comments/tables/VML each fail too.
- Surprising: the spec reverses the relationship order *and* the ZIP entry order and asserts the comment still binds — the parser must not depend on either.

### packages/client/ui-sidebar-documentpreview/tests/excel-xml.client.spec.ts
- Purpose: XML encoding and OPC discovery.
- Key abstractions: `excelXmlCases`, both ExcelJS entries.
- Data flow: a fixture → the archive → the preview.
- Non-obvious design decisions: the spec asserts that a UTF-16 encoding *with* and *without* a BOM produces a preview **identical** to the UTF-8 one, and that the retained parts are byte-identical to the source parts.
- Edge cases / failure handling: a missing core part fails; a malformed UTF-16 fails rather than replacing invalid code units; an unrelated binary part (`xl/vbaProject.bin`) is ignored rather than decoded as XML; text split across an escaped run and a CDATA section survives.
- Surprising: the spec asserts that a drawing owned by a part at the *package root* is still found and removed.

### packages/client/ui-sidebar-documentpreview/tests/excel-opening.client.spec.ts
- Purpose: URI aliases, part-name case variants and orphan drawings.
- Key abstractions: `excelOpeningCases`, both ExcelJS entries.
- Data flow: a mutated fixture → the preview.
- Non-obvious design decisions: the spec asserts that an **ambiguous** ASCII case-equivalent ZIP entry is rejected *before* the filtering can hide either entry, and that a non-ASCII name (`Ä.xml` vs `ä.xml`) stays distinct — the lowercasing is ASCII-only.
- Edge cases / failure handling: the orphan drawing is omitted along with its rels while the comment VML survives; the preview of the mutated workbook equals the preview of the combined one.
- Surprising: the Strict-URI variant rewrites *both* the SpreadsheetML and the relationships namespaces and must still open.

### packages/client/ui-sidebar-documentpreview/tests/excel-opc-fixture.ts
- Purpose: the loader for the independent-writer OPC fixtures.
- Key abstractions: `excelOpcCases` (`comments`, `table`, `prefix`, `part-name`, `relative`, `combined`), `excelOpcFixture(name)`.
- Data flow: `readFile(new URL('./fixtures/excel-opc/<name>.xlsx', import.meta.url))`.
- Non-obvious design decisions: "Read an Openpyxl or XlsxWriter fixture without regenerating it with the parser under test" — the fixture bytes are committed, never produced by the code under test.
- Edge cases / failure handling: n/a.
- Surprising: the case list is the *regression index*: five isolated failures and one combined workbook.

### packages/client/ui-sidebar-documentpreview/tests/excel-xml-fixture.ts
- Purpose: the loader for the XML-encoding fixtures.
- Key abstractions: `excelXmlCases` (eight names), `excelXmlFixture(name)`.
- Data flow: `readFile(...)`.
- Non-obvious design decisions: same principle as the OPC fixtures.
- Edge cases / failure handling: n/a.
- Surprising: the eight names *are* the encoding matrix (rich, utf16-sheet, utf16-metadata, workbook-path, styles-path, strings-path, cdata, parts-path).

### packages/client/ui-sidebar-documentpreview/tests/excel-opening-fixture.ts
- Purpose: the derived opening regressions.
- Key abstractions: `excelOpeningCases` (`strict`, `case-root`, `case-parts`, `orphan-drawing`), `excelOpeningFixture(name)`.
- Data flow: unzip the combined fixture → mutate exactly one thing → re-zip.
- Non-obvious design decisions: "Change only the package property under test in an independent-writer workbook" — each case perturbs one axis so a failure names the axis.
- Edge cases / failure handling: the `orphan-drawing` case strips the drawing relationships and the worksheet's `<drawing>` element.
- Surprising: the `case-parts` case upper-cases every part name *except* `docProps/` and `xl/theme/` and lower-cases the relationship targets — a deliberately asymmetric case.

### packages/client/ui-sidebar-documentpreview/tests/excel-fixture.ts
- Purpose: the generated workbooks.
- Key abstractions: `excelFixture()`, `excelHtmlFixture()`, `meetingMinutesFixture()`, `excelFreezeFixture()`, `excelHtmlText`.
- Data flow: ExcelJS → `workbook.xlsx.writeBuffer()` → bytes.
- Non-obvious design decisions: the fixtures are deliberately *large* in feature terms — a merged, styled, frozen, multi-sheet workbook with a rich-text cell, a hyperlink, a shared formula, an error cell, a boolean, a hidden row, a hidden column and a hidden sheet. `meetingMinutesFixture` has 27 formulas with **no** cached results, which is what exercises the "missing results" count.
- Edge cases / failure handling: `excelHtmlText` embeds markup that must stay literal in the preview *and* the clipboard.
- Surprising: the fixture is Chinese-language and uses a real budget workbook — the preview's fidelity claims are tested against a document a person would actually open.

### packages/client/ui-sidebar-documentpreview/tests/excel-drawing-fixture.ts
- Purpose: a charted workbook.
- Key abstractions: `excelDrawingFixture(prefix)`.
- Data flow: unzip the styled fixture → add a drawing, a chart, the rels and the content types → re-zip.
- Non-obvious design decisions: the fixture can emit the DrawingML namespace with or without a prefix, so the parser is tested against both.
- Edge cases / failure handling: it also injects a `conditionalFormatting` rule so the notice list is exercised.
- Surprising: the chart part is written by hand as a minimal `c:chartSpace` with a literal `c:strLit` / `c:numLit` cache.

### packages/client/ui-sidebar-documentpreview/tests/xls-fixture.ts
- Purpose: the legacy BIFF fixture.
- Key abstractions: `legacyWorkbook(date1904)`, `xlsFixture(workbook)`.
- Data flow: SheetJS `utils.book_new()` → cells → `write(workbook, { type: 'array', bookType: 'biff8' })`.
- Non-obvious design decisions: the BIFF `CellParsedFormula` token bytes (`[7,0,0x1e,1,0,0x1e,2,0,0x03]`) are written by hand "seven token bytes encode the expression 1+2" — the formula is a *real* BIFF token stream, not a string.
- Edge cases / failure handling: the workbook carries a hidden sheet, a merged range, hidden rows/columns and the 1904 flag.
- Surprising: the fixture writes BIFF8 (a compound file) so the magic-number check in `xls.ts` is exercised against the real container format.

### packages/client/ui-sidebar-documentpreview/tests/excel-readonly-panning.client.spec.ts
- Purpose: the read-only trackpad panning of the third-party grid.
- Key abstractions: `defaultContext`, `handleGlobalWheel` from `@fortune-sheet/core`.
- Data flow: a wheel event → the scrollbar offsets → the workbook context.
- Non-obvious design decisions: the spec builds a **clamping** scroll container, because "jsdom stores out-of-range offsets verbatim, while a browser clamps them to the scrollable range that starts at zero" — the model of the browser is supplied, not mocked away.
- Edge cases / failure handling: a reversed gesture after the leading edge must retain the next gesture's movement.
- Surprising: this test imports the *third-party* library's internals and asserts the workaround's correctness — the fix is in the patched dependency, and the test proves the patched behaviour.

### packages/client/ui-sidebar-documentpreview/tests/fixtures/office-cache.patch.yml
- Purpose: a two-line configuration override used by an Office-cache scenario.
- Key abstractions: `{ id: 'ui-sidebar-documentpreview', config: { office: { maxCachedEntries: 2 } } }`.
- Data flow: injected into the package's configuration for a test run.
- Non-obvious design decisions: the override drops the cache to two entries so the eviction path is exercised in a real deployment-shaped run.
- Edge cases / failure handling: n/a.
- Surprising: 81 bytes — a whole test scenario expressed as configuration.

### packages/client/ui-sidebar-documentpreview/tests/fuzz/generate.py
- Purpose: the corpus generator.
- Key abstractions: `FEATURES`, `ERRORS`, `fixed_zip()`, `unpack()`, `validate()`, `workbook_bytes()`, `mutate()`, `main()`.
- Data flow: a seed → a corpus of `.xlsx` files plus a `manifest.json` of oracle cells and expected notices.
- Non-obvious design decisions: **the oracle is independent of the parser under test** — the generator re-reads every expected cell with Openpyxl and refuses to emit a workbook whose cells it cannot verify. The ZIP metadata is fixed (a fixed timestamp, a sorted entry order) so the same seed yields byte-identical files, and Openpyxl's `modified` time is rewritten to a constant.
- Edge cases / failure handling: 128 byte-level mutations are emitted separately and classified as valid or invalid by the same validator. Eight *structural* mutations (zip-store, sheet-prefix, sheet-filename, relationship-dot, relationship-absolute, two drawing-namespace shapes, and a reversed archive) change the encoding without changing the cell semantics.
- Surprising: the generator writes 300 *random* cases per writer on top of the directed ones, and the manifest records the writer versions — reproducibility depends on the writer version, which the report states.

### packages/client/ui-sidebar-documentpreview/tests/fuzz/run.client.ts
- Purpose: the campaign runner.
- Key abstractions: `parse(bytes)`, `inspect(test, reply)`, the outcome taxonomy.
- Data flow: a corpus → a per-input Worker → an outcome → a JSON report and a `repros/` directory.
- Non-obvious design decisions: each input gets a **terminatable** Worker with a 10-second deadline and a 256 MB heap cap, because "Source conversion is the subject; a dedicated worker can be terminated even during synchronous ZIP/XML work". The input bytes are **transferred** to the worker, and the worker reports `inputUnchanged` by comparing a copy — the parser must not mutate its input.
- Edge cases / failure handling: the outcomes are separated into `pass`, `rejected-valid`, `accepted-corrupt`, `value-mismatch`, `notice-mismatch`, `mutated-source` and `unclassified-error` — three genuinely different defects. Only `pass` and `accepted-corrupt` are non-fatal; everything else sets a non-zero exit.
- Surprising: `--baseline-ref` extracts an *older* `xlsx.ts` from Git into a temp directory and runs it side by side, and the temp directory is deleted with a path-escape check.

### packages/client/ui-sidebar-documentpreview/tests/fuzz/excel-worker.client.ts
- Purpose: the fuzz Worker's isolation.
- Key abstractions: `parentPort`, the `baseline` import.
- Data flow: bytes → `convertExcel` (or the baseline module) → `{ ok, preview, inputUnchanged }` or `{ ok: false, causes }`.
- Non-obvious design decisions: the failure causes are collected by walking the `cause` chain (up to eight levels) and formatted as `Name: message` — the report can show *why* a parse failed, not just that it did.
- Edge cases / failure handling: the input-immutability check is done inside the Worker, where the bytes still exist.
- Surprising: the Worker's own limits (`maxBytes: 20_000_000, maxCells: 1_000_000`) are *not* the shipped config — the fuzz campaign deliberately runs with a larger budget.

### packages/client/ui-sidebar-documentpreview/tests/fuzz/README.md
- Purpose: the campaign's operating manual.
- Key abstractions: the run commands, the retained-regression catalogue, the report semantics.
- Data flow: documents the generate → run → replay → compare-an-older-adapter loop.
- Non-obvious design decisions: the doc is explicit that the campaign is **not** part of the default unit suite, that it "retains failures and exits nonzero", and that the `repros/` files are "representative failures with fewer feature combinations, not a claim of globally minimal inputs".
- Edge cases / failure handling: it states the known remaining diagnostic failures (1904 offsets, empty-string formula-cache differences) rather than hiding them.
- Surprising: it also records the *process* — "Maintain the ExcelJS patch with `pnpm patch`… Installed dependency trees contain generated launchers that must not enter the patch."

### packages/client/ui-sidebar-documentpreview/tests/fuzz/README.zh.md
- Purpose: the Chinese translation of the campaign manual.
- Key abstractions: identical section structure.
- Data flow: n/a (docs).
- Non-obvious design decisions: it preserves the caveats in the same place — the same "not part of the default unit suite" and "not a claim of globally minimal inputs" qualifications.
- Edge cases / failure handling: n/a.
- Surprising: the bilingual pair is hash-pinned by the sibling `README.i18n.yaml`.

### packages/client/ui-sidebar-documentpreview/tests/fuzz/README.i18n.yaml
- Purpose: the bilingual hash record for the campaign manual.
- Key abstractions: four heading paths with `en`/`zh` hashes.
- Data flow: n/a.
- Non-obvious design decisions: same mechanism as the package README's pair record.
- Edge cases / failure handling: n/a.
- Surprising: the fuzz directory is subject to the same translation gate as the package docs.

### packages/client/ui-sidebar-files/package.json
- Purpose: the manifest for `@deepseek-ai/dsh-client-ui-sidebar-files`.
- Key abstractions: `dsh.client.inject` (slots, locale, sidebarRightTabs, sidebarRight, remote, remote.workspaceFiles) and the `peerDependencies` on `@deepseek-ai/cordis`.
- Data flow: `exports` maps `.` and `./client`.
- Non-obvious design decisions: the package has **no runtime dependencies** at all — everything it uses (store, slots, primitives, path utils) is a devDependency, because it is a browser plugin consumed as source.
- Edge cases / failure handling: n/a.
- Surprising: compared with the preview package, this one is dependency-free — the whole file tree is ~600 lines of source.

### packages/client/ui-sidebar-files/README.md
- Purpose: the file tree's contract.
- Key abstractions: the type, the body, the chip title, and the tree's data model.
- Data flow: the root comes from `useSessions().byId[sessionId].cwd`; every level is keyed by absolute path.
- Non-obvious design decisions: the tab **claims no address** — "The type is a page, not a viewer" — and files are opened by `tabActions.openResource(fileAddressFor(...))` for the preview type to claim. A file row's address is *relative to the tree's root*, so the same file under a different root is a different address.
- Edge cases / failure handling: the three failure codes each get their own line; the endpoint's entry cap ends a level with a marker; a session with no working directory shows one line instead of a tree.
- Surprising: the doc's own note that the `files` tab's scrollbar is inset 2px from the pane edge while the preview is deliberately edge-to-edge — the two panes disagree on purpose.

### packages/client/ui-sidebar-files/README.zh.md
- Purpose: the Chinese translation of the same contract.
- Key abstractions: identical.
- Data flow: n/a.
- Non-obvious design decisions: the Chinese text keeps the load-bearing sentence about the relative address ("每一行都在树的根之下，所以它的地址是相对于根的路径").
- Edge cases / failure handling: n/a.
- Surprising: the Chinese version is *shorter* than the English (77 lines each) and packs the same content.

### packages/client/ui-sidebar-files/README.i18n.yaml
- Purpose: the bilingual hash record.
- Key abstractions: nine heading paths with `en`/`zh` hashes.
- Data flow: n/a.
- Non-obvious design decisions: same mechanism.
- Edge cases / failure handling: n/a.
- Surprising: the hashes differ from the preview package's, so the two documents are independently pinned.

### packages/client/ui-sidebar-files/locale/en.json
- Purpose: the marketplace metadata.
- Key abstractions: `meta.title`.
- Data flow: n/a.
- Non-obvious design decisions: as in the preview package, the English title is the raw id.
- Edge cases / failure handling: n/a.
- Surprising: identical shape to the sibling package's file.

### packages/client/ui-sidebar-files/locale/zh.json
- Purpose: the Chinese marketplace metadata.
- Key abstractions: `meta.title`, `meta.description`.
- Data flow: n/a.
- Non-obvious design decisions: as in the sibling package.
- Edge cases / failure handling: n/a.
- Surprising: the description explicitly mentions the right-Sidebar preview ("并在右侧面板中打开文件"), i.e. the two packages advertise each other.

### packages/client/ui-sidebar-files/tsconfig.json
- Purpose: the client project's compiler options and 13 references.
- Key abstractions: `include: ['src']`.
- Data flow: n/a.
- Non-obvious design decisions: unlike the preview package, this one has a *single* project — the host half (`src/index.ts`) is a no-op and shares the client project.
- Edge cases / failure handling: n/a.
- Surprising: `src/index.ts` is a host half that does nothing, yet it still exists so the package can be mounted on the host.

### packages/client/ui-sidebar-files/tsdown.config.ts
- Purpose: the build configuration.
- Key abstractions: `clientBundle(import.meta.dirname, ['lib/types/index.js'])`.
- Data flow: n/a.
- Non-obvious design decisions: this package has **no custom bundler plugins** — no worker, no inlined assets, no licence banners.
- Edge cases / failure handling: n/a.
- Surprising: a 3-line config next to the preview package's 120-line one — the complexity is entirely in what the package embeds.

### packages/client/ui-sidebar-files/src/index.ts
- Purpose: the host half.
- Key abstractions: `apply(): void {}`.
- Data flow: nothing.
- Non-obvious design decisions: the file exists so the package can be mounted on the Host without contributing anything; the comment says "the whole tab type lives in the browser export".
- Edge cases / failure handling: n/a.
- Surprising: an intentionally empty module, and the test asserts it does not throw.

### packages/client/ui-sidebar-files/src/css-modules.d.ts
- Purpose: the ambient CSS-module declarations.
- Key abstractions: identical to the sibling package's.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: two packages in the same repo ship a byte-identical copy of this file.

### packages/client/ui-sidebar-files/src/client/index.ts
- Purpose: the browser half — the type, the dictionaries, the body, the title, and the shortcut.
- Key abstractions: `apply(ctx)`, `inject`, the `sidebar.right.tab.files.actions` slot declaration.
- Data flow: `ctx.inject(['shortcuts'], …)` registers the `workspace.files` command with per-platform defaults; `ctx.effect(() => ctx.sidebarRightTabs.register(filesDefinition(t)))`; the slot registration carries the store and the face.
- Non-obvious design decisions: the shortcut's `resolve` returns `{ status: 'blocked', reason: t('shortcut.noSession') }` when there is no session — a command that can *explain its own refusal* in the user's language. The platform defaults differ: desktop is Mod+P, web is Mod+Alt+P, and **Linux Web is left unbound**.
- Edge cases / failure handling: the shortcut's `regions: ['page','editable','terminal']` and `modals: []` declare where the command may fire.
- Surprising: the body and the title are registered under `FILES_ID` (the implementation id), not under the kind — the same rule the preview package follows.

### packages/client/ui-sidebar-files/src/client/definition.tsx
- Purpose: what the `files` tab type IS.
- Key abstractions: `FILES_KIND`, `FILES_ID`, `filesDefinition(t)`.
- Data flow: `ctx.sidebarRightTabs.register(filesDefinition(t))`.
- Non-obvious design decisions: the definition has **no `patterns`** — it claims no address at all. The guide entry carries `commandId`, `order: 10`, a localised title/description and the `GuideArtworkFiles` glyph.
- Edge cases / failure handling: n/a.
- Surprising: `title` is `() => t('type.label')` — a function, so a locale change re-renders the chip without re-registering the type.

### packages/client/ui-sidebar-files/src/client/store.ts
- Purpose: the tree's view state.
- Key abstractions: `DirLevel`, `LevelState` (`loading` | `ready` | `failed`), `FilesTabState`, `FilesState`, `FilesActions`, `createFilesStore()`.
- Data flow: `start` → `loading` → `loaded` / `failed`; `toggled` → the expanded set; `scrolled`; `reset`; `forget`.
- Non-obvious design decisions: `loaded()` prunes the cache when a directory that was a directory becomes a *file* or disappears — the removed path's expansion entries and its whole subtree of levels are dropped (lines 124–138). A `failed()` on an already-`ready` level keeps the level and attaches the failure, so a refresh failure does not blank the tree.
- Edge cases / failure handling: `bucket()` **throws** for a tab that was never started ("no tree for tab"), which is how a write-after-forget is caught rather than silently creating a phantom tree.
- Surprising: `reset` is "the reload gesture's first half: the expanded set says which levels to fetch again" — the tree is not cleared, so the reader keeps their rows.

### packages/client/ui-sidebar-files/src/client/face.ts
- Purpose: the tree's async half — listing directories and observing them.
- Key abstractions: `WatchWorkspaceDirectory`, `createWatch(remote)`, `ListWorkspaceDirectory`, `createList(remote)`, `childPath(parent, name)`, `FilesInjected`, `filesFace(list, watch)`.
- Data flow: `start(tabId, root, signal)` → `new DirectoryNode(root, load, watch, failed, signal).open()`; the node asks the face to list; a settlement writes through the store's actions.
- Non-obvious design decisions: `createWatch` uses the Remote's **stream supervisor** (`remote.$stream`) with an `ended` handler, so a dropped watch is a *recoverable* condition, not a silent hang. `createList` drops the endpoint's workspace-relative path and keeps only the entries and the truncation flag. The face keeps a **per-tab, per-path generation counter** so the latest listing of a level wins whichever settles first.
- Edge cases / failure handling: a watch failure is recorded as a `gateway/internal` failure on the level, without the "Error:" prefix — the message is the cause's own text. A watch that ends before `ready` triggers an initial list; a watch that ends after `ready` is reported.
- Surprising: `childPath` joins with `/` "whatever the parent's separators" — the Host resolves mixed separators, and the tree only needs a stable key.

### packages/client/ui-sidebar-files/src/client/directory-node.ts
- Purpose: the ownership of one open directory: its watch, its reads, and its descendants.
- Key abstractions: `DirectoryNode` — `open()`, `find()`, `expand()`, `collapse()`, `refresh()`, `refreshTree()`, `close()`, `setExpanded()`, `setAutomatic()`.
- Data flow: `open()` → `follow()` (the watch loop) → `refresh()` → `read()` → `load(path, signal)` → the store.
- Non-obvious design decisions: the node **waits for the watch's `ready` before its first list** — `if (!this.initialized || this.automatic) void this.refresh()`. The read loop is a `do…while (readAgain())` so a change that arrives *during* a read is coalesced into one more read rather than a storm. The `dirty` flag is the whole coalescing mechanism.
- Edge cases / failure handling: `workspace-file/watch-unsupported` is **not** a failure — the node lists once and stays usable, with manual refresh available. A watch error before `ready` still triggers the initial list and is then reported. A child that disappears (or becomes a file) has its whole subtree collapsed and its watches aborted.
- Surprising: `collapse()` prunes the *pending restoration preferences* for the path and everything under it, so a restored ancestor does not resurrect a subtree the user closed.

### packages/client/ui-sidebar-files/src/client/FilesBody.tsx
- Purpose: the tree's body.
- Key abstractions: `FilesBodyProps`, `orderEntries(entries)`, `failureLine(t, failure)`, `Entry`, `Level`, `TreeContext`.
- Data flow: `useSessions(s => s.byId[sessionId]?.cwd)` → `start(tabId, cwd, signal)` → the store's levels → the rows.
- Non-obvious design decisions: the scroll offset is written to the store **once, on unmount**, not per scroll event ("Scrolling only moves the ref; the store hears about it once, on unmount, so a scroll neither re-renders the tree nor writes after the owner's abort has forgotten the bucket"). The rows are ordered directories-first, then by an `Intl.Collator` with `numeric: true` — so `file2` precedes `file10`. An `other` entry is shown greyed with **no button at all**, so the directory is reported whole.
- Edge cases / failure handling: a level that is cut by the endpoint's cap ends with a marker; an empty level says so; a session with no workspace shows one line. The auto-refresh toggle is again rendered inside a `<span hidden>`.
- Surprising: a file row opens the address built *relative to the tree's root*, so the same file is a different address under a different root.

### packages/client/ui-sidebar-files/src/client/FilesTitle.tsx
- Purpose: the chip title — the folder sheet before the type's label.
- Key abstractions: `PropsRuntime<'sidebar.right.pane.tab.title'>`.
- Data flow: `useTabInfo().tab.title` → a 16px `FileTypeIcon kind="folder"`.
- Non-obvious design decisions: the tree's own rows draw their own folder glyphs and never this one.
- Edge cases / failure handling: n/a.
- Surprising: 24 lines, and the file explicitly says the chip would show the bare label without it.

### packages/client/ui-sidebar-files/src/client/locales.ts
- Purpose: the `sidebarFiles` dictionary.
- Key abstractions: `SidebarFilesKey`; keys for the shortcut refusal, the type label, the guide entry, the row states, the four failure lines, and the auto-refresh control.
- Data flow: `ctx.locale.register('sidebarFiles', { zh, en })`.
- Non-obvious design decisions: the namespace declaration lives *with the key set* "so that any module naming `TranslateNS<'sidebarFiles'>` … needs only this file, whichever entry a program loads first".
- Edge cases / failure handling: four failure lines, each naming a different next step.
- Surprising: `entry.other` is a sentence, not a word — "Not a file or a directory, so it cannot be opened."

### packages/client/ui-sidebar-files/src/client/FilesBody.module.css
- Purpose: the tree's layout.
- Key abstractions: `.root`, `.header`, `.path`, `.body`, `.level`, `.item`, `.row`, `.icon`, `.fileIcon`, `.name`, `.other`, `.note`, `.status`, `.tool`, `.titleIcon`.
- Data flow: n/a.
- Non-obvious design decisions: the body's 2px right margin and `scrollbar-gutter: stable` reproduce the workspace list's inset so the rows keep their inset whether or not the tree overflows. Rows *abut* — "the tree's air is this inset, not a gap between rows".
- Edge cases / failure handling: `.other` is `cursor: default` and its hover is transparent, so a greyed row does not invite a click.
- Surprising: the header comment pins the 38px row height to the conversation header's rule position, with the reasoning written out.

### packages/client/ui-sidebar-files/tests/apply.client.spec.ts
- Purpose: the plugin's registrations and their removal.
- Key abstractions: a real `SidebarRightTabRegistry` with recorder slots.
- Data flow: `ctx.plugin({ inject, apply })` → the command, the type, the seats.
- Non-obvious design decisions: the spec asserts the shortcut's *blocked* path returns the localized reason when there is no session, and the *handled* path opens the tab for the command target.
- Edge cases / failure handling: disposal removes the command, the type, the seats and the dictionary.
- Surprising: the host half is asserted to be inert ("keeps the host Loader entry inert").

### packages/client/ui-sidebar-files/tests/definition.client.spec.ts
- Purpose: the type as the registry sees it.
- Key abstractions: a real registry and a real `makeTranslate(zh)`.
- Data flow: `registry.register(filesDefinition(t))` → `registry.guide()`.
- Non-obvious design decisions: the spec asserts the type **claims no address** (`candidates(sessionFileAddress(...))` is empty) and that the guide icon renders at 26px.
- Edge cases / failure handling: n/a.
- Surprising: the definition has no `patterns` at all, and the test asserts `patterns` is `undefined` — the "no patterns" choice is pinned.

### packages/client/ui-sidebar-files/tests/files-title.client.spec.tsx
- Purpose: the chip title.
- Key abstractions: `FilesTitle`.
- Data flow: n/a.
- Non-obvious design decisions: the icon is 16px and `aria-hidden`.
- Edge cases / failure handling: n/a.
- Surprising: this is the shard's only `.tsx` spec among eleven `.ts` siblings — it contains JSX (`render(<FilesTitle … />)`), so the extension is correct.

### packages/client/ui-sidebar-files/tests/store.client.spec.ts
- Purpose: the tree store's write set.
- Key abstractions: a real store instance.
- Data flow: actions → snapshot.
- Non-obvious design decisions: the spec pins the **pruning** rule in two shapes — a directory that was removed, and one that became a file — and asserts the sibling's cache survives. It also pins that a `failed` on a `ready` level keeps the level and attaches the failure.
- Edge cases / failure handling: writing a level for a tab that was never started **throws**.
- Surprising: `reset` keeps the expansion, the scroll and the auto-refresh setting — a reload is a re-read, not a reset.

### packages/client/ui-sidebar-files/tests/face.client.spec.ts
- Purpose: the face's subscriptions and settlements.
- Key abstractions: `mount()` with the scripted list and watch.
- Data flow: `face.start` → a watch → `ready` → a list → a settlement.
- Non-obvious design decisions: the spec pins that the root is **subscribed before it is listed**, and that the listing waits for `ready`. It also pins the "latest listing of a level wins, whichever settles first" rule with both settlement orders.
- Edge cases / failure handling: an abort before `ready` closes the subscription *without* listing; a watch failure is recorded without an "Error:" prefix; a tab that closes during the fallback list publishes no failure.
- Surprising: the spec exercises four different root spellings (`/`, `C:/`, `C:\`, `/work/app/`) to pin `childPath`'s joining.

### packages/client/ui-sidebar-files/tests/directory-node.client.spec.ts
- Purpose: the node's lifecycle.
- Key abstractions: `mount(path, restore)`, `watchedRead()`, `listReady()`.
- Data flow: a watch event → a refresh → a listing → a store write.
- Non-obvious design decisions: the spec pins the **coalescing** rule: two `change` events delivered during one list produce exactly two lists, not three. It also pins the "manual refresh consumes pending changes without enabling automatic refresh" rule.
- Edge cases / failure handling: `watch-unsupported` lists and stays usable; a stream error whose release completes *after* node cancellation is not reported; a child collapsed while its parent is still listing is not restored.
- Surprising: the spec asserts that collapsing a subtree **awaits every watch release** before the collapse resolves — the tree does not drop a subscription on the floor.

### packages/client/ui-sidebar-files/tests/files-body.client.spec.tsx
- Purpose: the tree's presentation.
- Key abstractions: `mountBody(cwd, refreshShortcut)`, `names(root)`.
- Data flow: the scripted watch/list → the rows.
- Non-obvious design decisions: the spec drives the *real* body over a *real* store and a *real* face, and asserts the "scroll is committed once, on unmount" rule explicitly (the store's `scrollTop` is still 0 while the user scrolls). It also pins the `PathLabel` behaviour: the path is split at the last segment, and the "clipped" flag is toggled by a `ResizeObserver`.
- Edge cases / failure handling: a session with no workspace asks for nothing; a truncated level is marked; a failed level shows its code; a refresh failure appears *beside* the existing rows and does not clear them.
- Surprising: the spec asserts the row order is `src`, `.env`, `pipe`, `README.md` — directories first, then a natural, case-insensitive name order, with dotfiles treated like any other entry.

### packages/client/ui-sidebar-files/tests/mount.client.tsx
- Purpose: the body harness.
- Key abstractions: `mountBody(cwd, refreshShortcut)`, `Mounted`.
- Data flow: a real store + a real face over the scripted list/watch → a rendered body.
- Non-obvious design decisions: the same "one documented cast" philosophy as the preview package's harness: "the rest of the standard kit is framework-injected and never touched here".
- Edge cases / failure handling: `remount()` renders a *fresh* body over the same store and face, which is how the "tab switch" case is simulated.
- Surprising: the harness's `tab.contentId` is `'files'` — "A page tab's address is the shell's to mint; the body never reads it."

### packages/client/ui-sidebar-files/tests/scripted-list.client.ts
- Purpose: the deferred directory reader.
- Key abstractions: `scriptedList()` → `ScriptedList` (`settle`, `settleLatest`, `outstanding`, `waitForList`, `dispose`).
- Data flow: a call → a pending promise → the spec settles it.
- Non-obvious design decisions: the harness distinguishes the *oldest* pending call from the *newest* (`settle` vs `settleLatest`) so the "latest wins" rule can be tested in both orders.
- Edge cases / failure handling: `dispose()` resolves every outstanding call with a failure so no promise is left dangling.
- Surprising: `waitForList(index)` resolves by *invocation* index, not by path — a spec can wait for the third call even if the first two are still pending.

### packages/client/ui-sidebar-files/tests/scripted-watch.client.ts
- Purpose: the scripted watch streams.
- Key abstractions: `DirectoryWatch` (an `AsyncIterable` with `deliver`, `fail`, `holdRelease`, `stop`), `DirectoryWatches` (`opened`, `forPath`, `ready`, `dispose`).
- Data flow: `deliver('ready' | 'change')` → the consumer's next pull → the event.
- Non-obvious design decisions: the delivery is a **two-phase handshake**: `deliver` resolves only after the consumer has taken the frame ("delivering an event waits for the consumer's next pull"). `holdRelease()` is a gate that lets a spec hold a subscription's teardown open and assert that the close is still pending.
- Edge cases / failure handling: `stop()` aborts and releases the gate; the `finally` block always resolves `released`.
- Surprising: `DirectoryWatches.forPath(path, occurrence)` distinguishes a *reopened* directory from the first one — the "reopen lists again" rule needs two streams on the same path.

### packages/client/ui-sidebar-files/tests/watch.client.spec.ts
- Purpose: the watch adapter over the real Remote stream supervisor.
- Key abstractions: a `FakeRemote` from the workspace-files package's own test tree.
- Data flow: `createWatch(remote)(session, path, signal)` → `remote.$stream` → `workspaceFiles.changes`.
- Non-obvious design decisions: the spec asserts the stream is *named* (`directory ${path}`) and that the `ended` callback is invoked exactly once with the readiness flag — the supervisor's contract is used deliberately.
- Edge cases / failure handling: an already-cancelled node creates **no** stream; a frame delivered after cancellation is not yielded; a consumer `return()` awaits the disposal and the node's abort does not dispose it twice.
- Surprising: the spec reaches into `packages/api/workspace-files/tests/fake-remote.client.ts` — the two packages share a test double across package boundaries.

---

## Ideas worth stealing

- **A monotonic generation counter is the cheapest stale-result guard there is** — `packages/client/ui-sidebar-documentpreview/src/client/face.ts:133` — `modeOf()` bumps `reads.generation` whenever the loading mode or the selected renderer changes, and every settlement compares its captured generation against the current one (`face.ts:152`). Why it matters for August: one integer replaces the "is this still the request I care about?" checks that every async surface otherwise accumulates, and it composes with the abort signal — the signal handles *cancellation*, the generation handles *supersession*, and the two failure modes are otherwise indistinguishable.

- **Version coherence: pages of two file versions must never meet on screen** — `packages/client/ui-sidebar-documentpreview/src/client/face.ts:159` and `packages/client/ui-sidebar-documentpreview/src/client/store.ts:187` — a page whose version differs from the pages already held, arriving past the first line, restarts the walk from line 1; and the store independently drops the older pages when a newer one arrives. Why it matters: a transcript that silently mixes two versions of a file is worse than a restart, and the rule has to live in **both** the reader and the writer or one of them will be bypassed.

- **The observed-version baseline: a change that happened *during* a read is not a change to report** — `packages/client/ui-sidebar-documentpreview/src/client/store.ts:146` (`if (state.version === undefined && !state.loading) state.observedVersion = observedVersion`) and `packages/client/ui-sidebar-documentpreview/src/client/TextPreview.tsx:166` — the banner "the file has changed" is driven by `observedVersion !== current.version && observedVersion !== current.observedVersion`. Why it matters: without the baseline, every read that races a metadata update raises a false "file changed" banner, and users learn to ignore the banner. The same idea transfers directly to August's "the model re-read a file under you" notice.

- **A cache identity that includes the *producer's* generation, not just the key** — `packages/client/ui-sidebar-documentpreview/src/client/office/cache.ts:110` — `JSON.stringify([generation.value, file.sessionId, metadata.value.absolutePath, metadata.value.version])` — plus a re-authorisation (a 1-byte read + a stat) before *every* reuse (`office/index.ts:81`). Why it matters: when August caches anything derived from a tool, a model, or a provider, the cache key must carry the identity of whatever *produced* it (the renderer generation, the model id, the tool version), or a replacement of that producer will serve stale bytes. The re-authorisation before reuse also means the cache is never a permission bypass.

- **Shared in-flight work with correct, per-caller cancellation** — `packages/client/ui-sidebar-documentpreview/src/client/office/cache.ts:143` — a pending conversion is refcounted; one reader aborting removes only *its* listener, and the shared controller aborts when the last user leaves (lines 152–155). Why it matters: this is the exact shape August needs for "two tool calls want the same expensive thing" — coalescing without letting one caller's cancellation kill the other's work. The same pattern appears in the face's `AbortSignal.any([signal, controller.signal])` composition.

- **Background work must not be able to consume the last capacity slot** — `packages/client/ui-sidebar-documentpreview/src/client/office/cache.ts:74` — `const readerLimit = priority === 'background' ? this.maxReaders - 1 : this.maxReaders` and the matching `maxPending - 1` at line 121. Why it matters: any August feature that speculates (a prefetch, a warm-up, a background summary) can starve the interactive path unless the reservation is *structural* rather than a priority queue that happens to work out.

- **Treat a Worker's message as untrusted input** — `packages/client/ui-sidebar-documentpreview/src/client/excel/parse.ts:43` and `validPreview` at `parse.ts:62` — the shape, the number types and the *closed* feature vocabulary are all validated before the value is used, and anything unexpected becomes `invalid`. Why it matters: a Worker, a subprocess, or a plugin boundary is an untrusted channel; a closed vocabulary (`EXCEL_UNSUPPORTED_FEATURES`) is what makes the validation total.

- **A parser that runs in a disposable Worker with a deadline, and a copy of the input** — `packages/client/ui-sidebar-documentpreview/src/client/excel/parse.ts:20` — the bytes are copied (`bytes.slice()`) and transferred, the Worker is terminated on *every* exit path (success, failure, timeout, abort, unmount), and the URL is revoked with it. Why it matters: August runs untrusted-ish parsing (tool output, model-written code, file content); a Worker that can be *killed* is the only way to bound a parser that might hang or blow the heap. The `vi.getTimerCount() === 0` assertion in the test (`tests/excel-parse.client.spec.ts:38`) is the discipline that keeps the kill path honest.

- **Fail a document preview *without reading it* when the format is known-binary and unrenderable** — `packages/client/ui-sidebar-documentpreview/src/client/document/unviewable.ts:10` and `packages/client/ui-sidebar-documentpreview/src/client/TextPreview.tsx:199` — the owner checks the suffix list before any read is issued. Why it matters: the cheap, correct behaviour for an unrenderable file is to say so; spending a read (and a UTF-8 decode) to discover the bytes are not text is the avoidable part. The companion rule — the plain-text fallback is *removed* for a suffix some renderer declared binary (`src/client/TextPreview.tsx:69`) — is the same idea applied to the *offered* actions.

- **The recourse, not the error, is what the user needs** — `packages/client/ui-sidebar-documentpreview/src/client/failure-line.ts:47` — `emptyFailureRecourse()` maps a failure code to `open` (hand the file to something that can render it), `retry`, or `none`. Why it matters: August's failure surfaces tend to show a Retry button on everything. A "not-text" file will never succeed on retry; offering the right next action per code is a small table and a large UX difference.

- **Untrusted HTML in an opaque iframe, with a static mode that has no permissions at all** — `packages/client/ui-sidebar-documentpreview/src/client/html/basic-document.ts:10` (DOMPurify + a CSP `<meta>` *prepended* to `<head>` + `sandbox=""`) and `packages/client/ui-sidebar-documentpreview/src/client/html/HtmlBody.tsx:68` (`sandbox="allow-scripts"`, no `allow-same-origin`) — and the bootstrap creates its asset Blob URLs *inside* the frame, because an opaque origin cannot load a parent-created URL (`src/client/html/bootstrap.ts:20`). Why it matters: this is the whole "render an untrusted artefact" problem solved in four files, and the two details people get wrong — the CSP must be the *first* element and the asset URLs must be minted in the frame — are both explicitly reasoned in the source.

- **Bound the raster, not the display size** — `packages/client/ui-sidebar-documentpreview/src/client/pdf/document.ts:56` — `ratio = Math.min(pixelRatio, Math.sqrt(16_777_216 / (viewport.width * viewport.height)))`, with the CSS size left at the viewport's. Why it matters: August renders arbitrary user documents; capping the *pixels* while keeping the *layout* correct gives a degraded-but-usable preview instead of an allocation failure, and the test asserts the cap is hit exactly (`tests/pdf-document.client.spec.ts:66`).

- **Prove a parser against files it did not write** — `packages/client/ui-sidebar-documentpreview/tests/fuzz/generate.py:58` (`validate()` re-reads every expected cell with Openpyxl) and `packages/client/ui-sidebar-documentpreview/tests/fuzz/README.md` (the retained regression catalogue) — the corpus is generated by Openpyxl and XlsxWriter, the oracle is recorded by the *generator*, and the parser is compared against it. Why it matters: this is the transferable discipline for August's evals — a test whose fixtures are produced by the code under test proves only that the code agrees with itself. The same repo also pins the *host* and *browser* entry points of the same library against each other (`tests/excel-opc.client.spec.ts:22`).

- **Separate the three different ways a fuzz case can fail** — `packages/client/ui-sidebar-documentpreview/tests/fuzz/run.client.ts:96` (`inspect()`) — `rejected-valid` (a good file the parser refused), `value-mismatch` (it opened but got a value wrong), `accepted-corrupt` (it opened a file the independent reader rejected) and `mutated-source` (it changed its input). Why it matters: a fuzz run that reports "N failures" without this taxonomy is nearly useless for triage, and August's eval harness has the same problem — "the model did not produce the expected answer" and "the expected answer is wrong" must be different buckets.

- **A state store that outlives the component, with one abort listener armed by the first read** — `packages/client/ui-sidebar-documentpreview/src/client/face.ts:125` — one listener, `{ once: true }`, that forgets the bucket, the dependency group and the bookkeeping; and `packages/client/ui-sidebar-files/src/client/FilesBody.tsx:165` — the scroll offset is written **once, on unmount**, not per scroll event. Why it matters: August's chat and agent surfaces have the same "the view is unmounted but the work continues" shape; the pattern here is that *the view state* lives in a tab-keyed store and the *async work* is tied to a record lifetime, and the two are not the same thing.

- **A watch that ends is a recoverable condition, and "watch unsupported" is not a failure** — `packages/client/ui-sidebar-files/src/client/directory-node.ts:127` and `packages/client/ui-sidebar-files/src/client/face.ts:51` (the stream supervisor's `ended` handler) — the tree lists once, stays usable, and keeps manual refresh. Why it matters: a degraded-but-working mode is usually better than an error state, and the code has to *decide* which degradations are errors (a watch failure after `ready` is reported; before `ready` it is not).

- **A "detected and not shown" notice instead of a generic "some features were lost"** — `packages/client/ui-sidebar-documentpreview/src/client/excel/model.ts:15` (a closed, ordered feature vocabulary) and `src/client/excel/excel.tsx:53` — the notice names the charts, images, shapes and conditional formatting that were actually detected. Why it matters: capability reporting that names what is missing is actionable ("open it in a system application"); a generic warning is not. The same package separately warns that *cached formula results may be missing or inaccurate* (`excel.tsx:50`) — a specific, different warning for a specific, different risk.

- **The lazy-chunk boundary is a contract, and it is tested** — `packages/client/ui-sidebar-documentpreview/tests/document-preview-license-bundle.client.spec.ts` — the packed tarball's `client.js` must contain exactly `require.async("./client.frontmatter-fields.js")`, `("./client.pdf.js")`, `("./client.excel.js")` and no static cross-chunk require, and the lazy chunks are booted in a `node:vm` context to prove they initialise with React alone. Why it matters: "keep the startup bundle small" is a wish; a test that names the exact chunk list is a rule. The same test also asserts the third-party licence texts are present in the published artefact, which is a shipping requirement, not a nicety.

- **A bilingual-pair hash gate** — `packages/client/ui-sidebar-documentpreview/README.i18n.yaml:1` — a per-heading hash of the English and Chinese blocks, re-recorded by `pnpm run verify-translation-pairing --write`. Why it matters: if August keeps a Chinese UI (or any second locale), this is a cheap way to make "one side was edited and the other was not" a *failing check* rather than a review comment.

---

## Files skipped (with reasons)

- `packages/client/ui-sidebar-documentpreview/tests/fixtures/excel-opc/combined.xlsx` — binary OOXML package (8,781 bytes, ZIP magic `50 4B 03 04`); I confirmed the container and listed its 17 entries (`[Content_Types].xml`, `xl/worksheets/budget.xml`, `xl/charts/chart1.xml`, `xl/comments/comment1.xml`, `xl/tables/table1.xml`, `xl/drawings/commentsDrawing1.vml`, …). Not read line by line because it is a compressed binary archive; its purpose (the combined independent-writer workbook) is established by `tests/excel-opc.client.spec.ts` and `tests/fuzz/README.md`.
- `packages/client/ui-sidebar-documentpreview/tests/fixtures/excel-opc/comments.xlsx` — binary OOXML package (6,261 bytes, ZIP magic confirmed); the isolated *comments* case from the Openpyxl corpus. Not read line by line (binary ZIP); purpose established by `tests/excel-opc-fixture.ts` and `tests/excel-opc.client.spec.ts`.
- `packages/client/ui-sidebar-documentpreview/tests/fixtures/excel-opc/table.xlsx` — binary OOXML package (5,575 bytes, ZIP magic confirmed); the isolated *Table* case. Not read line by line (binary ZIP); purpose established by the OPC spec.
- `packages/client/ui-sidebar-documentpreview/tests/fixtures/excel-opc/prefix.xlsx` — binary OOXML package (4,907 bytes, ZIP magic confirmed); the isolated *namespace-prefix* case. Not read line by line (binary ZIP); purpose established by the OPC spec.
- `packages/client/ui-sidebar-documentpreview/tests/fixtures/excel-opc/part-name.xlsx` — binary OOXML package (4,898 bytes, ZIP magic confirmed); the isolated *part-name* case. Not read line by line (binary ZIP); purpose established by the OPC spec.
- `packages/client/ui-sidebar-documentpreview/tests/fixtures/excel-opc/relative.xlsx` — binary OOXML package (5,325 bytes, ZIP magic confirmed); the isolated *relative relationship target* case, produced by XlsxWriter 3.2.9. Not read line by line (binary ZIP); purpose established by the OPC spec and the fuzz README.
- `packages/client/ui-sidebar-documentpreview/tests/fixtures/excel-xml/cdata.xlsx` — binary OOXML package (11,224 bytes, ZIP magic confirmed); the CDATA-text variant. Not read line by line (binary ZIP); purpose established by `tests/excel-xml-fixture.ts` and `tests/excel-xml.client.spec.ts`.
- `packages/client/ui-sidebar-documentpreview/tests/fixtures/excel-xml/parts-path.xlsx` — binary OOXML package (11,332 bytes, ZIP magic confirmed); the relocated-parts variant. Not read line by line (binary ZIP); purpose established by the XML spec.
- `packages/client/ui-sidebar-documentpreview/tests/fixtures/excel-xml/rich.xlsx` — binary OOXML package (11,184 bytes, ZIP magic confirmed); the *baseline* XlsxWriter workbook — 21 entries including `xl/media/image1.png`, `xl/drawings/vmlDrawing1.vml` and `xl/charts/chart1.xml`. Not read line by line (binary ZIP); purpose established by the XML spec, which compares every other variant against this one's preview.
- `packages/client/ui-sidebar-documentpreview/tests/fixtures/excel-xml/strings-path.xlsx` — binary OOXML package (11,183 bytes, ZIP magic confirmed); the relocated `sharedStrings.xml` variant. Not read line by line (binary ZIP); purpose established by the XML spec.
- `packages/client/ui-sidebar-documentpreview/tests/fixtures/excel-xml/styles-path.xlsx` — binary OOXML package (11,196 bytes, ZIP magic confirmed); the relocated `styles.xml` variant. Not read line by line (binary ZIP); purpose established by the XML spec.
- `packages/client/ui-sidebar-documentpreview/tests/fixtures/excel-xml/utf16-metadata.xlsx` — binary OOXML package (11,456 bytes, ZIP magic confirmed); the UTF-16 *metadata* encoding variant. Not read line by line (binary ZIP); purpose established by the XML spec, which asserts the preview is identical to the UTF-8 baseline.
- `packages/client/ui-sidebar-documentpreview/tests/fixtures/excel-xml/utf16-sheet.xlsx` — binary OOXML package (11,552 bytes, ZIP magic confirmed); the UTF-16 *worksheet* encoding variant. Not read line by line (binary ZIP); purpose established by the XML spec.
- `packages/client/ui-sidebar-documentpreview/tests/fixtures/excel-xml/workbook-path.xlsx` — binary OOXML package (11,172 bytes, ZIP magic confirmed); the relocated `workbook.xml` variant. Not read line by line (binary ZIP); purpose established by the XML spec.

(All fourteen skipped files are the only binaries in the shard. Every other file in the shard was opened and read. The two largest *text* files — `tests/fuzz/generate.py` (351 lines) and `tests/pdf-body.client.spec.tsx` (458 lines) — were read in full.)

---

## Uncertainties

- **One naming asymmetry, resolved.** `packages/client/ui-sidebar-files/tests/files-title.client.spec.tsx` is the shard's only `.tsx` spec among eleven `.ts` siblings; it contains JSX and imports `@testing-library/react`, so the extension is correct and the manifest path matches the clone. I initially misread the manifest row as `.ts` and had to correct my own ledger; the shipped ledger uses the manifest's `.tsx` path, verified row-for-row against the manifest.
- **The ExcelJS patch is outside my shard.** `packages/client/ui-sidebar-documentpreview/README.md:91` attributes the OPC/namespace behaviour to a pinned patch at `patches/exceljs@4.4.0.patch`, which is not in this shard. I read the *observable* consequences in `src/client/excel/xlsx-archive.ts` and the OPC/XML/opening specs, but I could not read the patch itself and therefore cannot say whether the Strict-URI normalisation and the case-equivalence rejection live in the patch, in the adapter, or in both. The adapter's `partKey()` (ASCII-only lowercasing) and the "Ambiguous XLSX part" throw are definitely in the adapter; the underlying ExcelJS side is not in my shard.
- **The `interactivePreview` HTML mode's ownership is split across packages.** `src/client/html/index.ts:35` reads `ctx.configForms.developerTools.enabled` and the README says "Coding Tools selects the HTML preview policy in both Web and desktop", but the *policy* lives in a package outside this shard, so I could not establish who turns it on or whether there is a host-side allow-list for it.
- **The `office` cache's `background` priority has no visible producer in this shard.** `src/client/office/cache.ts` accepts `'background' | 'foreground'` and reserves capacity for foreground work, but every call site inside this shard passes the default (`'foreground'`). The producer of background reads (a speculative prewarm) is not in my shard, so the reservation is a contract I can read but not trace to its caller.
- **I did not verify the tests actually pass.** Per the assignment I ran nothing from the clone — no `vitest`, no `tsdown`, no `pnpm`. Every behavioural claim above is read from the source and from the assertions in the specs, not from an execution. Where a spec asserts a behaviour, I described the assertion; I did not observe it.
- **`packages/client/ui-sidebar-documentpreview/tests/excel-formats.client.spec.ts:39` reads a fixture outside both packages** — `apps/web/tests/fixtures/office/preview.xls` — to test the XLS path against an *independently generated* file. That file is not in my shard and I did not open it; I only read the test that consumes it.
- **The `FortuneSheet` read-only panning fix lives in the patched dependency, not in this package.** `tests/excel-readonly-panning.client.spec.ts` imports `handleGlobalWheel` from `@fortune-sheet/core` and asserts the patched behaviour, but the patch itself (`patches/`) is outside the shard, so I can confirm the *expectation* and not the implementation.
- **Two package-level READMEs in the sibling `ui-sidebar-files` package describe a `workspace.files` shortcut bound to Mod+P on desktop and Mod+Alt+P on web, with Linux Web left unbound.** I could not verify the platform-default mechanism itself (it lives in `packages/client/shortcuts`, outside the shard); I read only the registration in `src/client/index.ts:60`.
