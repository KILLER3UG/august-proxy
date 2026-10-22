# deepseek-harness / dsh-client-primitives#3

## Shard shape

This shard is the browser-side UI floor of `deepseek-harness`, and it holds three
independent packages that never talk to a model: **`ui-shortcuts`** (a searchable,
editable keyboard-shortcut reference — 22 files), **`ui-slots`** (the typed
composition core every other client plugin is written against — 12 files), and
**`ui-theme`** (the `--dsw-*` design-token system, the light/dark/system theme
service, and the Appearance/font settings rows — 60 files). They fit together in
one direction: `ui-slots` defines *how* a plugin may extend a region and *what
props* its component receives; `ui-theme` and `ui-shortcuts` are two concrete
plugins that use that contract to register into a parent's slot
(`settings.general.item` and `shell.overlay`). `ui-theme` additionally owns the
whole visual system — the palette, the focus-ring rule, the scrollbar skin, the
Markdown font ladder — and the eight global stylesheets are mounted as
plugin-owned `<style>` tags so unload and HMR take them with the plugin.

A structural fact worth stating up front, because the brief asks about it:
**all three packages declare themselves model-facing-inert in their own READMEs**
("Model Experience: None, as the package is a browser-side UI plugin layer that
registers nothing model-facing" / "KV Cache effect: None; this package neither
assembles nor sends a provider request" — `packages/client/ui-shortcuts/README.md:66`,
`packages/client/ui-shortcuts/README.md:70`, `packages/client/ui-slots/README.md:87`,
`packages/client/ui-theme/README.md:118`). There is no agent loop, no prompt
assembly, no reasoning-content streaming, no context compaction, no memory
retrieval and no subagent machinery anywhere in this shard. What *is* here are
the mechanism families those concerns need underneath them: a **registry with
load-time validation and one lifecycle axis**, a **revision-guarded optimistic
concurrency protocol** between a UI and a durable store, a **crash-supervision
channel that retires a broken actor without killing the system**, a **token
override stack**, and — most unusually — **a set of cross-package CSS contract
tests that read every stylesheet in the repository and assert design invariants**
that no unit test in a single package could catch.

---

## Per-file notes

### packages/client/ui-shortcuts/locale/en.json
- Purpose: Package locale metadata for the shortcuts plugin; carries only `meta.title: "ui-shortcuts"`.
- Key abstractions: none — the real dictionary lives in `src/client/locales.ts`; this file is the package-card metadata the locale service renders in a plugin list.
- Data flow: read by the locale service when it lists registered packages.
- Non-obvious design decisions: The package ships *two* locale surfaces: `locale/*.json` (package metadata, per-locale) and `src/client/locales.ts` (the in-app copy, one module with both languages). The metadata is per-file because the build copies `locale/*.json` verbatim; the in-app copy is code because the key set is type-checked (`Record<keyof typeof zh, string>`).
- Edge cases / failure handling: n/a — a metadata stub with no behaviour.
- Surprising: The Chinese file has a `meta.description` and the English one does not, so the two metadata files are not symmetric.

### packages/client/ui-shortcuts/locale/zh.json
- Purpose: Chinese package metadata: `meta.title: "快捷键设置界面"`, `meta.description: "查看、录入和修改键盘快捷键。"`.
- Key abstractions: same metadata shape as the English file.
- Data flow: consumed by the locale service for the package card.
- Non-obvious design decisions: The title is a *feature* title ("shortcut settings UI"), not the package name, while the English title is the bare package id — an asymmetry that looks accidental but survives the bilingual-pairing gate because the gate hashes per heading section of the README, not these files.
- Edge cases / failure handling: n/a.
- Surprising: `locale/*.json` files are in `package.json` `files`, so they ship to consumers even though the in-app copy is compiled into the bundle.

### packages/client/ui-shortcuts/package.json
- Purpose: Manifest for `@deepseek-ai/dsh-client-ui-shortcuts` — "Keyboard shortcut reference, recording, and local preference editing".
- Key abstractions: `dsh.client.inject` lists the four services this plugin requires (`shortcuts`, `locale`, `ui-layout`, `ui-settings`); `dsh.client.platform: "web"`; exports map `.`, `./client`, `./src/*`, `./locale/*.json`.
- Data flow: the client loader reads `dsh.client.inject` to order plugin activation; `exports["./src/*"]` lets sibling packages import source directly in tests.
- Non-obvious design decisions: `"./src/*": "./src/*"` is exported — the monorepo's own test suite imports sibling *source* (`import { ShortcutRegistry } from '../../shortcuts/src/client/registry.ts'`), so type-level and behavioural contracts are checked against the real code, not a stale build.
- Edge cases / failure handling: `publishConfig.access: "public"`; `files` lists only `lib/index.js`, `lib/client.js`, `lib/types/**` and `locale/*.json` — the CSS module is compiled into the JS bundle, not shipped separately.
- Surprising: `@deepseek-ai/dsh-client-ui-slots` is a *dev* dependency, not a peer — the plugin's public type surface is derived from it but the runtime does not re-export it.

### packages/client/ui-shortcuts/README.i18n.yaml
- Purpose: Bilingual-pair consistency record: one hash per heading section for the English and Chinese README blocks.
- Key abstractions: YAML path → `{en: <hash>, zh: <hash>}`; the hash covers the section text outside code blocks and generated regions.
- Data flow: written by `pnpm run verify-translation-pairing --write packages/client/ui-shortcuts/README.md`; a CI gate fails when one side changes without the other.
- Non-obvious design decisions: The record is *per heading section*, not per file, so a section can be translated at a different time than its neighbour and the gate still catches a half-translated edit.
- Edge cases / failure handling: The comment at the top states the exact regeneration command, so the file is self-maintaining.
- Surprising: This is a *documentation* enforcement mechanism that could equally guard any bilingual pair (e.g. a zh/en prompt template) — worth stealing directly.

### packages/client/ui-shortcuts/README.md
- Purpose: The English behavioural specification for the shortcut reference — the single densest statement of the feature in the shard.
- Key abstractions: Described in terms of four "framework shares" and observable behaviours (search semantics, focus restoration, recording model, reset-all confirmation, error copy).
- Data flow: Describes rather than implements; it is the contract the three spec files in `tests/` assert against.
- Non-obvious design decisions: Line 28 states the search contract precisely — "Search matches an ordered subsequence within one label, English alias, or key combination, ignoring case. Each matching command appears once. Search relevance takes precedence; equal matches retain the display order." Line 36 states the recording model: "Windows and macOS Desktop record one or two overlapping non-modifier keys with optional modifiers; a third key rejects the draft. Releasing the first key saves the current combination, so sequential A then B records only A."
- Edge cases / failure handling: "Read failures disable editing and identify the active bindings and affected document in a system toast: Web uses the current origin's localStorage entry `dsh.keybindings.v1`; Desktop uses `userData/keybindings.json`." and "A stale revision closes the confirmation and requires another confirmation against the latest configuration; a failed write retains the accepted bindings and allows retry."
- Surprising: The README's "Model Experience: None" section is a *deliberate, structured* statement that every package in this repo makes — the repo treats "this package touches no model surface" as a property to assert in prose, which is a cheap and effective way to keep UI-layer packages from leaking into the request path.

### packages/client/ui-shortcuts/README.zh.md
- Purpose: Chinese mirror of the shortcut README — same 16 sections, one hash per section in `README.i18n.yaml`.
- Key abstractions: identical section anchors; line 28 and line 36 carry the same two key contracts (search subsequence matching; two-overlapping-key recording with release-to-save) in Chinese.
- Data flow: paired with `README.md` by the translation-pairing gate.
- Non-obvious design decisions: The Chinese version preserves the *reasoning* rather than just the label — e.g. "释放第一个键即保存当前组合，因此先后按 A、B 只录入 A" keeps the "therefore A then B records only A" causal chain.
- Edge cases / failure handling: "配置版本过期时关闭确认框，需要针对最新配置重新确认；写入失败保留已接受的绑定，允许重试。" — the stale-revision and failed-write paths are specified in prose before they are implemented.
- Surprising: The behaviour spec is written at a level a designer could read (it is a `package-reference` kind with a `description` frontmatter), so the README doubles as the UX spec.

### packages/client/ui-shortcuts/src/client/Editor.tsx
- Purpose: The inline key recorder — the mechanism that turns physical key presses into a saved binding.
- Key abstractions: `ShortcutBinding` / `ShortcutEdit` / `ShortcutRevision` from the shortcuts protocol; `desktopChords` (runtime `desktop` + macOS/Windows) selects between a two-key chord model and the single-key Web model; `revision` vs `config.revision` is the optimistic-concurrency pair.
- Data flow: `recording(true)` asks the host to protect native recording; document-level `keydown`/`keyup` listeners build a `pending` binding; on release, `capture()` validates it (issue → conflict → stale → config-not-ready) and only then `save({type:'set', id, binding})` goes out with the reviewed revision.
- Non-obvious design decisions: The whole file is a catalogue of *refusals to guess*. Line 96-99 handles a macOS Web quirk explicitly: `event.key === 'Dead'` is ignored **unless** it is exactly `Option+Command+N` (a real, reported dead key). Line 121 catches a throw from `describeBinding` and reports "unsupported-key" rather than executing a half-formed binding. Line 129-130 handles macOS omitting the character keyup while Command is held: "macOS can omit the character keyup while Command is held." Lines 143-152 remove the listeners on unmount and swallow the `recording(false)` rejection ("The owning window may already be closed.").
- Edge cases / failure handling: `writing.current` is a re-entrancy latch (line 41, 49-50) so a second action cannot fire while a write is in flight; `mounted.current` guards every post-`await` state write (line 40, 53). On failure the draft is kept: `setRetry(operation.type === 'set' ? operation.binding : null)` (line 57) plus a visible "Retry save" button (line 178-179). On a stale revision the editor shows a "review" affordance and refuses to write (line 69, 159-162).
- Surprising: The key model is *physical* (`event.code`) and US-layout, and the recorder deliberately never records a key while the browser reports a composition (`composition.guards(event)`), because an IME would otherwise eat the user's shortcut.

### packages/client/ui-shortcuts/src/client/feedback.ts
- Purpose: Two functions that turn a failed shortcut read/write into a localized, actionable sentence.
- Key abstractions: `shortcutReadFailure(config, runtime, t)` and `shortcutFailure(result, catalog, t, runtime)`.
- Data flow: Called from `Reference.tsx` (read failure) and `Editor.tsx` (write failure) and from the reset-all path.
- Non-obvious design decisions: The failure text names the *storage owner* ("this site's localStorage entry dsh.keybindings.v1" vs "userData/keybindings.json") and the *recovery action* ("reload the page" vs "restart Harness") — the message is written for the person who has to fix it, not for a log. The trailing clause distinguishes "Default bindings are active." from "The last successfully read bindings remain active." (line 16) — i.e. the user is told which state they are actually in.
- Edge cases / failure handling: `config.error` is a code (`read` | `invalid` | `future`) and `config.usingDefaults` is a boolean; the function selects between two different "currently using" sentences. A `future` error (a document written by a newer version) gets its own message and does not overwrite the stored document.
- Surprising: `shortcutFailure` degrades a *conflict* into command *labels* by looking the ids up in the catalog and falling back to the raw id when the command has been unloaded (line 30) — a graceful, honest fallback rather than an empty message.

### packages/client/ui-shortcuts/src/client/fixed.ts
- Purpose: The three read-only menu reservations this package contributes: move (↑/↓), select (Enter), dismiss (Esc).
- Key abstractions: `ShortcutFixedCommand` — a fixed command has display `keys` plus the physical `bindings` it occupies, and a `group` (`menus`).
- Data flow: `fixedCommands(t)` is called once in `src/client/index.ts:37` and each result is registered with the shortcuts service via `ctx.shortcuts.registerFixed`.
- Non-obvious design decisions: The rows are exposed to the *editor* as occupied combinations, so a user cannot bind a command to Enter (line 14) even though Enter is not a command — the reservation list is the conflict oracle, shared by display and validation.
- Edge cases / failure handling: Fixed rows are read-only in the UI by construction: the reference renders them with `fixedKeyBadge` and never renders an edit button (see `Reference.tsx:192-199`).
- Surprising: The ids are namespaced `fixed.move` / `fixed.select` / `fixed.dismiss` at construction (line 16) even though the source rows use bare ids — this keeps the fixed-id space separate from the command-id space so a plugin cannot shadow them.

### packages/client/ui-shortcuts/src/client/Icons.tsx
- Purpose: Three inline SVG glyphs — an edit pencil, an error ring, a success ring — sized 12px (edit) or 16px (status).
- Key abstractions: a single `artwork` object keyed by `kind`; `ShortcutIcon` picks the size and renders `aria-hidden="true"`.
- Data flow: Imported by `Reference.tsx` (row hover icon, toast icon).
- Non-obvious design decisions: The icons are *supplied artwork* rather than icon-library lookups, because the reference is a plugin that must not depend on another package's icon set at runtime.
- Edge cases / failure handling: `aria-hidden` keeps the decorative glyph out of the accessible tree; the meaning lives in the button's `aria-label`.
- Surprising: `kind: keyof typeof artwork` is used for the prop type, so adding a glyph is a compile error until the union is updated.

### packages/client/ui-shortcuts/src/client/index.ts
- Purpose: The plugin's `apply(ctx)` — registers everything the feature owns: three fixed commands, one settings row, one shell overlay, and one `Mod+/` command.
- Key abstractions: `inject = ['shortcuts', 'locale', 'slots']` (line 22); the store is created **once** at plugin scope and shared: `const instance = handle.create(); const store = typeof handle = { ...handle, create: () => instance }` (lines 31-33).
- Data flow: `ctx.locale.register('shortcuts', {zh, en})`; `ctx.slots.inject('settings.general.item', …)` and `ctx.slots.inject('shell.overlay', …)`; each `inject` callback registers only once the parent has declared the slot.
- Non-obvious design decisions: **One instance for all occurrences.** The store's `create()` is replaced with a constant so the settings row and the shell overlay read and write the *same* state — opening the dialog from the settings row and opening it with `Mod+/` are the same dialog. Second: the `Mod+/` command declares `modals: ['settings', 'shortcuts']` and its `resolve` returns `{status:'blocked', reason:'modal'}` for any other modal (line 59) — the "which modal is in front" decision is data, not a global.
- Edge cases / failure handling: The disposer returned by `ctx.slots.inject('shell.overlay', …)` disposes both the command and the slot registration (line 70) — one lifecycle axis, so an unload leaves no orphan command.
- Surprising: `ctx.slots.inject` (as opposed to `ctx.slots.register`) is the *declaration-aware* registration: the entry appears only when the parent declares the slot, so plugin load order does not matter.

### packages/client/ui-shortcuts/src/client/locales.ts
- Purpose: The `shortcuts` namespace dictionary — 44 keys covering recording help, conflict copy, read/write failure copy and every group title.
- Key abstractions: `zh` is the key-set source of truth; `en` is typed `Record<keyof typeof zh, string>` so a missing English key is a compile error.
- Data flow: `ctx.locale.bind('shortcuts')` produces the `t` function the components receive through the standard locale seat.
- Non-obvious design decisions: The help text is **per-runtime and per-platform** (`web-help`, `macos-web-help`, `windows-web-help`, `record-help`) because the *available combinations differ by environment* — the copy is the contract, not a generic string. The `reserved` message ("This combination is reserved for system or text editing actions.") is distinct from `conflict` ("Already used by “{commands}”"), because a reserved key is not the app's fault and a conflict is.
- Edge cases / failure handling: `not-ready` ("Shortcuts are not ready. Please try again.") covers the window between plugin load and the config read landing.
- Surprising: The Chinese dictionary carries a `macos-web-help` that enumerates the exact accepted combinations ("Command+/、Command+,、Command+反斜杠、Control+反引号、Command+Option+按键或 Command+Shift+按键"), i.e. the help text is a specification of the allowlist.

### packages/client/ui-shortcuts/src/client/Reference.module.css
- Purpose: The reference dialog's and settings row's styles.
- Key abstractions: CSS-module classes; the sheet is a token consumer only (`var(--dsw-alias-*)`), never a literal colour.
- Data flow: Imported as `css` by `Reference.tsx`.
- Non-obvious design decisions: The edit affordance is a **transparent absolutely-positioned button covering the whole row** (`.rowButton { position: absolute; inset: 0; … }`, line 193) so "clicking anywhere on the row starts its inline recorder" works without making the label a button. The hover-revealed edit icon uses `opacity` and is re-revealed by `.row:has(:focus-visible)` (line 191) — a keyboard user gets the same affordance. The badge blocks are 26px tall and share `border-radius: 10px` (line 198) so the recorder "keeps the same height as key badges".
- Edge cases / failure handling: `.binding { pointer-events: none }` with `.binding:has(.inlineEditor) { pointer-events: auto }` (lines 183-184) — the badge is not clickable but the inline editor inside it is. `@media (hover: none) { .rowActions { opacity: 1 } }` (line 212) makes the icon always visible on touch.
- Surprising: The sheet deliberately uses `min-height: 42px` on `.row` (line 177) with the comment's sibling rule that fixed-action rows keep the same height — a *layout stability* contract: opening an editor must not reflow the list.

### packages/client/ui-shortcuts/src/client/Reference.tsx
- Purpose: The reference dialog and its General-Settings entry — the feature's main surface.
- Key abstractions: `coreActionOrder` (a `Map<string, number>` of 20 fixed command ids → display index); `entries` (application rows + fixed rows merged and sorted); `rankByName` (the subsequence search); `config.document.profiles[`${runtime}:${platform}`]` (the override count).
- Data flow: `useCatalog` / `useConfig` / `useFixedCatalog` are injected observable hooks; `useStore` gives `open`/`query`/`focusRequest`; `edit` is the injected service callback.
- Non-obvious design decisions: **Three that matter.** (1) Line 26-47: the product order is a hard-coded map, so "Core actions follow a fixed product order, independent of plugin registration, unloading, or remounting" — the display order is product truth, not registry order. (2) Line 89-94, the toast coalescer: `if (error && previous?.error && previous.text === text) return previous` — the *same* error keeps the *same* toast (and therefore its dismissal timer) instead of restarting it, while a different error or a success replaces it immediately. (3) Line 143-145, the sort: `response.stop` is forced last, then core order, then command-id order, so extension commands always follow the core ones in a stable order.
- Edge cases / failure handling: `busy` blocks close during a write (line 105, 164); `mounted` guards post-`await` work (line 85, 122); an unreadable config raises a toast naming the document and disables editing (line 95-97, 188, 207); the reset confirmation binds the revision it was opened against (line 82, 121) so a concurrent change is detected.
- Surprising: The search is a *subsequence* match over a set of names per row — the label, the English aliases, the key combination rendered three ways (`⌘+/`, `⌘/`, `Meta+/`, `Meta+`→`Cmd+`) (line 139) — so "cmd+/" finds the row on macOS and "control+/" finds it on Windows, without a per-platform index.

### packages/client/ui-shortcuts/src/client/store.ts
- Purpose: The shared visibility/search state of the reference dialog.
- Key abstractions: `State = { open: boolean; query: string; focusRequest: number }`; three actions.
- Data flow: The same store instance backs both the settings row and the overlay (see `index.ts:31-33`).
- Non-obvious design decisions: `focusRequest` is a **monotonic counter**, not a boolean (line 15): `open` increments it, and the dialog's `useLayoutEffect` on `[open, focusRequest]` refocuses the search field. A boolean would not re-fire when the dialog is re-opened while already open.
- Edge cases / failure handling: `close` clears `query` (line 16) so a reopened dialog never shows the previous query — the spec's "clears its query on close".
- Surprising: `defineStore` lives in the runtime package; this package only *declares* the state and actions, which is what makes the row component's props fully typed without the component knowing the store implementation.

### packages/client/ui-shortcuts/src/css-modules.d.ts
- Purpose: Ambient declarations for `*.module.css` (a `Record<string, string>` default export) and `*.css` (any).
- Key abstractions: none.
- Data flow: TypeScript module resolution for `import css from './Reference.module.css'`.
- Non-obvious design decisions: The declaration types CSS modules as a plain string map, so `css.foo` is `string` and a typo is *not* a compile error — the class names are not checked.
- Edge cases / failure handling: n/a.
- Surprising: `ui-theme` extends this with `declare module '*.css?inline' { const css: string; export default css }` — the `?inline` suffix is the Vite convention for "give me the CSS as a string"; the two packages have to declare it separately because each has its own tsconfig.

### packages/client/ui-shortcuts/src/index.ts
- Purpose: The host-side loader entry — a deliberate no-op.
- Key abstractions: `export function apply(): void {}`.
- Data flow: none; the browser half is `src/client/index.ts`.
- Non-obvious design decisions: The comment says it: "Host Loader entry; keyboard commands execute in the browser half." A host build that eagerly imported the client half would drag React and the DOM into the Node process.
- Edge cases / failure handling: n/a.
- Surprising: The file is 4 lines and says exactly why it is empty — a model for "a package can legitimately be half a package".

### packages/client/ui-shortcuts/tests/commands.client.spec.ts
- Purpose: Assembly-level spec: the plugin in a real client roster, with real owner plugins, checking what registers and what unloads.
- Key abstractions: `createClientTest({ roster: webApp })`; the test drives the *desktop* keyboard bridge (`window.dshDesktop.keyboard`) with synthetic frames.
- Data flow: Loads the client, reads `ctx.shortcuts.catalog` / `ctx.shortcuts.fixedCatalog`, then unloads plugins one by one and re-reads the catalogs.
- Non-obvious design decisions: The spec asserts a *negative* about platform separation: "keeps desktop defaults out of Web" — only `shortcuts.open` has keys in the Web roster (line 38). And it asserts owner-unload behaviour (line 44-51): unloading `ui-shortcuts` removes `fixed.move` but leaves the conversation plugin's fixed rows; unloading `ui-conversation` removes those too. This is a lifecycle test, not a rendering test.
- Edge cases / failure handling: The modal-ordering test (line 54-155) drives the real `Modal` components and asserts that a `role="dialog"` element already in the DOM blocks both `Mod+,` and `Mod+/`, that a held-key repeat is ignored, and that the Settings command cannot close Settings while the shortcut dialog is in front.
- Surprising: The spec manipulates `document.documentElement.dataset.platform` and `window.dshDesktop` directly and restores them in `onTestFinished` — the platform is a *data attribute*, so a test can move the app to macOS without a macOS machine.

### packages/client/ui-shortcuts/tests/editor.client.spec.tsx
- Purpose: The recorder's behavioural spec — 563 lines, roughly 30 cases, each one a distinct refusal or acceptance rule.
- Key abstractions: The `mount()` helper builds a real `ShortcutRegistry` + `ShortcutPersistence` over an in-memory storage (line 76-115) — no mocks of the protocol layer.
- Data flow: `fireEvent.keyDown/keyUp` on the recorder → the editor's document listeners → `persistence.edit(...)` → the in-memory storage → the registry catalog.
- Non-obvious design decisions: The tests encode the *policy*, not just the code: "records only the first released key for sequential %s presses" (line 435), "accepts a new %s combination after all keys of a rejected three-key draft are released" (line 448), "retries a %s command conflict while continuing to hold the modifier" (line 462), "waits for the remaining %s chord keys before accepting a retry" (line 482).
- Edge cases / failure handling: "keeps recorder focus during a write and accepts another combination after failure" (line 519-541) asserts that during a pending write the recorder has `aria-disabled="true"` but **not** the `disabled` attribute (so it keeps focus), and that a *different* combination typed during the failed write is accepted. The stale-revision test (line 230-259) proves the write is refused until "I have reviewed the latest configuration" is clicked, and that the same refusal fires when the *command catalog* changes mid-recording.
- Surprising: `it.each` over `[runtime, platform]` quadruples the matrix — the same behavioural rule is proven for web/desktop × macos/windows, which is how a two-implementation recorder stays honest.

### packages/client/ui-shortcuts/tests/reference.client.spec.tsx
- Purpose: The dialog's behavioural spec — 588 lines.
- Key abstractions: `referenceFixture()` builds the component over `createSnapshotStore` snapshots; the ordering test drives the catalog and fixed catalog directly.
- Data flow: Same as the editor spec, one level up.
- Non-obvious design decisions: The ordering test (line 175-234) feeds the catalog **reversed** and asserts the rendered order is *identical* — the product order map is proven independent of registration order, and the test also re-labels every row to Chinese and re-searches to prove the ordering is by id, not by label text.
- Edge cases / failure handling: The toast-coalescing test (line 346-380) uses fake timers to prove that eight identical errors keep **the same DOM node** (`expect(screen.getByRole('alert')).toBe(firstError)`) and therefore the same dismissal deadline, while a *different* error replaces it. The unreadable-config test (line 252-269) is parameterised over runtime × error kind × locale and asserts the message names the right document and the right recovery instruction in the right language.
- Surprising: The test at line 410-442 pins a subtle product rule: the override count includes bindings for commands that are **not currently mounted** and bindings that were **removed** ("counts current-profile overrides even when hidden by search or an unloaded command") — the count is of the stored document, not of the visible rows.

### packages/client/ui-shortcuts/tsconfig.json
- Purpose: Project references for the browser half.
- Key abstractions: `extends ../../../tsconfig.base.client.json`; `rootDir: src`, `outDir: lib/types`.
- Data flow: tsc project graph — nine referenced projects, including the sibling `shortcuts` protocol project and `ui-slots`.
- Non-obvious design decisions: The package's type surface depends on `../ui-slots` and `../shortcuts/tsconfig.client.json` as *separate* project references, so a change in either forces a rebuild of this package's declarations.
- Edge cases / failure handling: n/a.
- Surprising: `../../util/brand` is referenced even though the package imports nothing from it — the reference exists to keep the brand tokens' declarations in the graph.

### packages/client/ui-shortcuts/tsdown.config.ts
- Purpose: The bundler config.
- Key abstractions: `clientBundle(import.meta.dirname, ['lib/types/index.js'])` — the shared helper from `../tsdown.client.ts`.
- Data flow: tsdown emits `lib/index.js` (host) and `lib/client.js` (browser) plus `lib/types/**`.
- Non-obvious design decisions: `['lib/types/index.js']` is the *externals* list — the built package does not inline its workspace dependencies.
- Edge cases / failure handling: n/a.
- Surprising: The same helper with a different second argument produces two visibly different packages (`clientBundle` vs `staticLinked` in `ui-slots`), which is how a package can be "linked into the shell" vs "bundled standalone".

### packages/client/ui-slots/package.json
- Purpose: Manifest for `@deepseek-ai/dsh-client-ui-slots` — "Slot registry pure core".
- Key abstractions: One export (`.`); `./src/*` for source imports; `peerDependencies: { cordis }`.
- Data flow: The renderer package and every client plugin depend on it.
- Non-obvious design decisions: `devDependencies` lists only `dsh-client-store`, `react` and `cordis` — the package has *no* runtime dependency on a renderer, which is what lets it stay React-free at runtime (React appears only as a *type* import).
- Edge cases / failure handling: `files: ["lib/index.js", "lib/types/**/*.d.ts"]` — no client split, because this package has no browser half.
- Surprising: `peerDependencies` on cordis means the host can have exactly one cordis instance; a second copy would break the `declare module` augmentation that the whole type model depends on.

### packages/client/ui-slots/README.i18n.yaml
- Purpose: Per-heading EN/ZH hash record for the ui-slots README (14 sections).
- Key abstractions: Same YAML shape as the other packages.
- Data flow: consumed by the translation-pairing gate.
- Non-obvious design decisions: The hash map is nested by heading *path* (`/deepseek-ai-dsh-client-ui-slots/use-this-package/reusable-component-factories`), so adding a section adds an entry.
- Edge cases / failure handling: n/a.
- Surprising: The mechanism is per-package boilerplate (three copies in this shard) — a shared generator would be the obvious refactor.

### packages/client/ui-slots/README.md
- Purpose: The English specification of the composition model.
- Key abstractions: Ordinary Slots vs Component Factories; the five framework props shares; store seats; declaration discipline.
- Data flow: Describes the contract that `src/index.ts` implements and `src/renderer.ts` consumes.
- Non-obvious design decisions: Line 48 is the whole philosophy in one sentence: "Declaring a slot is claiming it: the registering entry becomes the only entry allowed to render that key, and registering into an undeclared slot, declaring an already-declared child, mounting one shared handle under two scopes, or registering a chain without `select` throws at load." Line 66 states a boundary that is easy to get wrong: "Engine products and the renderer host contract carry bare snapshot sources (`getSnapshot`/`subscribe`), never React hooks — hook binding belongs to the render machinery."
- Edge cases / failure handling: The "Known Limitations" section names two accepted costs: `isLive` scans all records linearly (fine at "tens" of registrations) and the `__renders` phantom anchor is visible on `PropsRenderSlots`.
- Surprising: Line 34 records a hard rule about Factory stores: "A Store factory stays lazy until an occurrence first materializes, then creates one handle for that render position and rejects a persistent Store spec whose key would collide across occurrences."

### packages/client/ui-slots/README.zh.md
- Purpose: Chinese mirror of the ui-slots README.
- Key abstractions: same as the English file.
- Data flow: paired by the translation gate.
- Non-obvious design decisions: Line 34 keeps the "lazy until first materializes" and "persistence key collision" clauses, which are the two rules a caller is most likely to violate.
- Edge cases / failure handling: n/a.
- Surprising: Line 66 keeps the "never React hooks at the engine boundary" rule verbatim in the Chinese text, so the boundary survives translation.

### packages/client/ui-slots/src/index.ts
- Purpose: The slot registry core **and** the entire type surface of the client composition model — 1673 lines, the largest file in this shard.
- Key abstractions: `SlotMap` / `SlotFactoryMap` / `LocaleNamespaceMap` / `SessionStandardProps` / `GlobalStandardProps` are **empty interfaces** extended by declaration merging (lines 26, 29, 39, 221, 236); `ComposedProps` (line 605) intersects the five shares; `SlotCore` (line 991) is the runtime registry.
- Data flow: A parent registers with a `children` table; each declared child becomes a renderable key; entries are contributed by other plugins; `entriesOfSlot` projects the winners; the renderer reads through `SlotRendererHost`.
- Non-obvious design decisions: Six, all load-bearing. (1) **One table** — "declaration = render authorization = runtime spec" (line 110-114): declaring a child slot in the `children` map simultaneously authorises the parent to render it and pins its kind/scope, so the three can never disagree. (2) **Load-time validation, hot path re-checks nothing** (line 1130-1136): registering into an undeclared slot, declaring an already-declared child, mounting one shared store handle under two scopes, or a chain without `select` all throw at registration. (3) **Shadowing by priority** (line 1216-1244): a second registration at an occupied cell's *exact* priority throws, but a different priority shadows — the lowest priority entry of a cell renders. (4) **Version bumped synchronously, notification batched per microtask** (line 1650-1658): `markDirty` increments `rec.version` and fires `onMutate` synchronously, but the `subscribe` listeners are flushed once per microtask. The comment at line 1508-1512 states why: "bumped synchronously per mutation so a uSES getSnapshot read is never stale when its batched notification lands." (5) **One lifecycle axis** (line 1590-1614): a disposer removes the contribution *and* recursively collapses every child slot it declared, clearing specs, emptying contributions and releasing store mounts; stale disposers become no-ops. (6) **Abdicating crash reports** (line 1545-1553): a crashed shadowing entry is retired from its cell *one-shot*, so the next survivor renders; a chain entry does not abdicate ("election alternatives resolve at select time"); the registration itself stays on the ledger so its disposer keeps working.
- Edge cases / failure handling: `isLive` (line 1325) is the stale-authorization probe — a retained `renderSlot` binding whose entry left the ledger must not render; `StaleAuthorizationError` / `SlotOwnershipError` (in `renderer.ts`) are the thrown forms. The store-scope ledger (line 996, 1253-1263) pins a shared handle to one scope and tracks a mount count, so the pin is released only when the last mount goes. `releaseChildren` clears `spec` and bumps `declarationEpoch` (line 1608) so the renderer can distinguish "the parent died" from "an entry changed".
- Surprising: Two type-level tricks that carry real weight. (a) `RendersCheck` (line 806-812) makes "children declared but the component consumes no `renderSlot`" a **compile error**, which enforces the README's "declaring is claiming" at the call site. (b) The `__renders` phantom marker (line 387) is a contravariant anchor: "generic method signatures compare loosely across key unions, so the contravariant marker is what actually enforces 'component key set ⊆ children declaration'". Without it, a component could declare more `renderSlot` keys than the parent authorised.

### packages/client/ui-slots/src/renderer.ts
- Purpose: The React-free installation contract between the slot host and whatever renderer is installed.
- Key abstractions: `SlotRendererHost` (the host API the renderer reads), `SlotRenderer` (the single entry, `renderRoot`), `StandardSourceBinding` (framework-neutral source material), `LocaleFace`, `KeyedStandardSource`.
- Data flow: The renderer subscribes to a key, reads `entriesOfSlot` and `specOf`, resolves the store instance through `storeOf` / `factoryStoreOf`, and renders.
- Non-obvious design decisions: Every host method is documented with *why* it exists, and the docs encode the failure modes: `entriesOfSlot` "Builds a fresh array per call — a render body read, not a uSES getSnapshot source" (line 156-159), while `entriesOf` (line 154) returns a stable reference "safe as a uSES getSnapshot source". `retainFactoryOccurrence` (line 216-222) is explicitly idempotent: "Repeated setup and cleanup preserve the occurrence's Store identity."
- Edge cases / failure handling: `StaleAuthorizationError` and `SlotOwnershipError` (line 279-286) are the two typed failures; the second's doc says it is a "plain-JS backstop; typed callers are narrowed statically". `LocaleFace`'s doc (line 18-21) states a hard ordering requirement: "Install before the first render that needs the seat: outlets bind their revision subscription at mount, and a face appearing later has no channel to notify already-mounted outlets."
- Surprising: `standardHookPropName` (line 42-44) is a one-liner that converts a source name to a Hook prop name (`use` + capitalised) — the naming convention is *code*, so a source named `sessions` becomes `useSessions` by rule rather than by hand-written mapping.

### packages/client/ui-slots/src/store.ts
- Purpose: Re-exports of the React-free store contracts so slot consumers need only this package.
- Key abstractions: `DefineStore`, `StoreHandle`, `StoreDecl`, `PropsStore`, `BoundActions`, `SnapshotSelectorHook` and nine more.
- Data flow: `export * from './store.ts'` in `src/index.ts` makes them part of the slots package's public surface.
- Non-obvious design decisions: The file is deliberately a *facade* — the store's **implementation** lives in the runtime package and only the *contract* is exported here, so the type layer stays zero-dependency.
- Edge cases / failure handling: n/a.
- Surprising: The re-export list is 14 names and excludes the runtime's `defineStore` implementation; the README says "the engine implementation of `defineStore` lives in the runtime package and satisfies the `DefineStore` contract exported here".

### packages/client/ui-slots/tests/core.client.spec.ts
- Purpose: The runtime spec of `SlotCore` — 404 lines over six describe blocks.
- Key abstractions: `mountFrame(core)` declares five child slots from `root`; the fixtures use `Comp as never` to erase the type constraint.
- Data flow: Direct calls on a `SlotCore` instance; no React.
- Non-obvious design decisions: The spec is organised by *behaviour family* rather than by method: the declaration gate, the lifecycle cascade, kind semantics, store scope pinning, the subscription API. The comments explain why the fixtures erase types — "Type-level renderSlot presence is proven by the type-chain spec; erasing here keeps runtime fixtures terse" (line 40-41) — i.e. the type tests and the runtime tests deliberately do not overlap.
- Edge cases / failure handling: "commits sibling declarations before notifying declaration subscribers" (line 319-340) is the subtle one: a declaration listener that tries to redeclare a sibling must see the sibling *already* declared, so the error is "already declared" rather than a silent double-claim. "a mutation from inside a flush re-schedules instead of being lost" (line 360-378) proves the flush is re-entrant-safe.
- Surprising: "bumps version synchronously but batches notifications per microtask" (line 278-293) asserts `getVersion` is already `+2` *before* the microtask runs, while the listener has been called zero times — the exact contract a `useSyncExternalStore` consumer needs.

### packages/client/ui-slots/tests/dynamic-keys.client.spec.ts
- Purpose: The escape hatches: `specDynamic` for string keys, `spec` for statically-known keys, and the untouched-key behaviour.
- Key abstractions: A second, differently-named `SlotMap` merge (`dynamic.a`, `dynamic.b`, `surface.injected`).
- Data flow: Registers a frame and reads the specs back.
- Non-obvious design decisions: The file exists because `SlotCore` is used from two worlds — the typed renderer and a generic dispatcher that only holds strings. The spec proves both: `specDynamic('dynamic.a')` returns the wide spec; `spec('dynamic.b')` returns `undefined` while undeclared.
- Edge cases / failure handling: "entries/getVersion on an untouched key return the frozen empty array and 0" (line 42-47) — the empty array is *the same object* every time (`toBe`), so it is safe to use as a `useSyncExternalStore` snapshot. `isLive` is false for an entry the core never held (line 49-52).
- Surprising: The comment at line 5-6 of `core.client.spec.ts` notes that `'root'` is deliberately *not* merged into `SlotMap` in these tests — "ui-renderer owns the built-in row, and the client aggregate program would see both merges collide." A test-suite-level concern about declaration merging leaking into the aggregate build.

### packages/client/ui-slots/tests/type-chain.client.spec.tsx
- Purpose: The compile-time contract suite — a single `it()` whose body is ~250 lines of registrations, roughly 25 of them marked `@ts-expect-error`.
- Key abstractions: `SlotMap` / `LocaleNamespaceMap` / `SlotFactoryMap` merges declared inline (line 18-65); `DefineStore` is declared, not imported.
- Data flow: None at runtime — the test asserts `expect(samples).toBeTypeOf('function')`; the *real* assertion is that `tsc` fails on each `@ts-expect-error` site.
- Non-obvious design decisions: The negatives are chosen to be *silent* mistakes, not obvious ones: "children spec must match the SlotMap entry" (a scope mismatch), "renderSlot key set ⊄ children declaration", "children declared but component consumes no renderSlot", "store share mismatch", "inject face incomplete", "root-scope inject has no sessionId parameter", "component matched prop drifts from the select return" (NoInfer pins `M` to the select return so the component position cannot widen it), "select may not return undefined (find() must be coalesced)", and the three Factory collision families.
- Edge cases / failure handling: The file's header states the design: "Bodies with @ts-expect-error sites never run." The negatives are grouped and commented by family so a failure names the rule that broke.
- Surprising: **This is a type-level test suite with no runtime assertions** — the "test" is that the compiler rejects the wrong programs. That is a genuinely reusable pattern: any API whose whole value is a type contract can be pinned this way, with no test-runner cost and no runtime cost.

### packages/client/ui-slots/tsconfig.json
- Purpose: Project references for the slots package.
- Key abstractions: `extends ../../../tsconfig.base.client.json`; references `vendor/cordis` and `../store`.
- Data flow: tsc project graph.
- Non-obvious design decisions: Only two references, because the package's type surface depends on exactly two other projects — everything else is expressed through declaration merging by *consumers*, not by this package.
- Edge cases / failure handling: n/a.
- Surprising: The package's own tests merge `SlotMap` keys, so the package's type-checking is only meaningful in the aggregate program; the reference to `../store` is what keeps `StoreDecl` resolvable.

### packages/client/ui-slots/tsdown.config.ts
- Purpose: The bundler config.
- Key abstractions: `staticLinked(import.meta.dirname, ['lib/types/index.js'])` — a different helper from `clientBundle`.
- Data flow: tsdown emits `lib/index.js` + declarations.
- Non-obvious design decisions: `staticLinked` vs `clientBundle` is the difference between "linked into the shell" and "bundled with its own entry"; the slots core is statically linked because every client plugin shares one instance of it — a second copy would break `instanceof` checks and the augmentation identity.
- Edge cases / failure handling: n/a.
- Surprising: The choice of bundler helper is a *runtime identity* decision, not a packaging one, and it is invisible in the file until you compare it with `ui-theme`'s `clientBundle`.

### packages/client/ui-theme/locale/en.json
- Purpose: Package metadata for the theme plugin; `meta.title: "ui-theme"`.
- Key abstractions: none.
- Data flow: the locale service's package list.
- Non-obvious design decisions: The in-app copy lives in `src/client/locales.ts` under the `settings.theme` namespace; this file is only the package card.
- Edge cases / failure handling: n/a.
- Surprising: n/a — but note the package's *own* namespace name (`settings.theme`) differs from the package id (`ui-theme`), and the `THEME_SETTINGS_NAMESPACE` (the durable Host namespace) is a *third* name: `ui-theme`.

### packages/client/ui-theme/locale/zh.json
- Purpose: Chinese package metadata: `meta.title: "界面主题"`, `meta.description: "提供浅色、深色和跟随系统的主题设置。"`.
- Key abstractions: same metadata shape.
- Data flow: the locale service's package list.
- Non-obvious design decisions: Three names coexist for one feature — the package id `ui-theme`, the in-app dictionary namespace `settings.theme`, and the durable Host settings namespace `ui-theme` — and each is chosen for a different consumer.
- Edge cases / failure handling: n/a.
- Surprising: The durable namespace equals the package id, which is what lets the Host settings service find the section without a mapping table.

### packages/client/ui-theme/package.json
- Purpose: Manifest for `@deepseek-ai/dsh-client-ui-theme`.
- Key abstractions: `exports` includes `"./brand-font.css": "./lib/styles/brand-font.css"` — a *CSS* export, unusual in a TS package; `dsh.client.immediately: true` marks the plugin as immediately-tier infrastructure.
- Data flow: The loader mounts it early because the locale/shortcut/renderer services it depends on must be present before first paint.
- Non-obvious design decisions: `files` includes `lib/styles` (line 69) so the WOFF2 files and the OFL license ship to consumers — the font is bundled, not fetched from Google at runtime.
- Edge cases / failure handling: `dependencies: { "@deepseek-ai/schemastery": "workspace:~" }` — the only package in this shard with a real runtime dependency, because the Host half validates the durable namespace with a zod-style schema.
- Surprising: `dsh.client.immediately: true` is the same "install before the first render" requirement that `LocaleFace`'s doc states in prose.

### packages/client/ui-theme/README.i18n.yaml
- Purpose: Per-heading EN/ZH hash record for the ui-theme README (18 sections).
- Key abstractions: same YAML shape.
- Data flow: the translation-pairing gate.
- Non-obvious design decisions: The ui-theme README has the *most* sections of the three (18 vs 16 vs 14) because it owns the most documented invariants.
- Edge cases / failure handling: n/a.
- Surprising: The `Summary` hash `d9832b31c4cb3ca9` differs from the ui-slots and ui-shortcuts `Summary` hashes, i.e. the summary is hashed per package.

### packages/client/ui-theme/README.md
- Purpose: The English specification of the theme, the token sheets and the preference-persistence policy.
- Key abstractions: The eight sheets and what each owns; the `--dsw-*` alias layer; the "Pre-plugin palette" section.
- Data flow: Describes the Host → index-injection → boot script → `ThemeRuntime` → ui-layout presenter chain.
- Non-obvious design decisions: Line 46 states the pre-plugin mechanism: "Head CSS selects the document canvas color scheme before any script runs, including a `prefers-color-scheme` query for the `system` preference. A body script then sets `body[data-ds-dark-theme]`, `--dsh-content-font-size`, `--dsh-code-font-size`, `--dsh-terminal-font-size`, and each non-empty `--dsh-font-family-<role>` list before the loading page and application scripts, so the first paint uses the selected palette and text and code sizes, and `ThemeRuntime` starts from the saved sizes and fonts instead of rendering the defaults first." Line 96 states the persistence policy: "While its own writes are pending, the service ignores refetched sections, so an echo of an earlier write cannot revert a later change; it adopts the durable section once the writes settle."
- Edge cases / failure handling: The "Known Limitations" section states the colour authority: "The token sheets are the sole color authority — values absent from the design system are deliberately not appended; the nearest semantic token wins, and design-owner-approved additions enter as a static step plus a semantic alias in the same change." And that third-party themes are "an extension point, not a product" — "no validation exists that an override set is complete."
- Surprising: Line 34 documents that the Desktop font-size shortcut "change[s] the text, code, and terminal font sizes together by 1 px, each within its own range" and that "Each physical key press saves the changed fields in one settings mutation" — a single keypress is a single durable write.

### packages/client/ui-theme/README.zh.md
- Purpose: Chinese mirror of the ui-theme README.
- Key abstractions: same as the English file.
- Data flow: paired by the translation gate.
- Non-obvious design decisions: Line 84 keeps the *technical reason* for the per-element elevation declaration ("继承传下来的是在 body 上已替换完 var() 的值…逐元素声明让每个元素按自己看到的描边色重新替换"), which is exactly the sentence a future maintainer needs.
- Edge cases / failure handling: n/a (the English file carries them).
- Surprising: The Chinese README is the *only* place in the shard where the CSS custom-property inheritance subtlety is written out in full, and it does so inside a font-ladder paragraph.

### packages/client/ui-theme/src/boot-theme.ts
- Purpose: Builds the two rows that make the theme apply before the client code runs.
- Key abstractions: `bootThemeStyle(preference)` → a `<style>` row; `bootThemeBodyScript(preference, fontSizes, fontFamilies)` → a `<script placement="body">` row; `bootThemeInjections()` returns both in execution order.
- Data flow: `src/index.ts:54-64` pushes these rows into every `webserver/index-inject` table; the browser receives them inside the index HTML.
- Non-obvious design decisions: The head CSS is *not* a variable dump but a two-branch literal (`LIGHT_BACKGROUND = '#fff'`, `DARK_BACKGROUND = '#151517'`), and for `system` it emits **both** branches with a `@media(prefers-color-scheme:dark)` wrapper (line 24) — so the canvas colour is decided by CSS, with no script involvement. The body script then only installs the *attribute* and the *variables* (line 35-43), and it uses `JSON.stringify` for every interpolated value — a font name containing `</script>` cannot break out of the script tag.
- Edge cases / failure handling: `matchMedia` is feature-detected (`typeof matchMedia !== 'undefined'`, line 38) so a non-browser run degrades to light. `document.body.toggleAttribute('data-ds-dark-theme', dark)` (line 42) is an *idempotent* set — re-running the script with a different preference removes the attribute rather than leaving it.
- Surprising: `document.documentElement.dataset.dsThemeSource = preference` records the *source* of the current theme on the element, which is what lets the client distinguish "the user chose dark" from "the OS is dark" after the fact.

### packages/client/ui-theme/src/client/AppearanceRow.module.css
- Purpose: Styles for the Appearance row: a title and three preference cubes.
- Key abstractions: `.group`, `.title`, `.cubeRow`, `.themeCube`, `.selected`.
- Data flow: Imported by `AppearanceRow.tsx` as a CSS module.
- Non-obvious design decisions: The cubes are `flex: 1 1 180px` with `flex-wrap: wrap` (line 30-32) — "flexed down from the figma width so all three sit on one row in the 800 panel, wrapping when narrower". The comment on `.selected` (line 52-53) records *why* a static token is used: "the bluish-400 step has no alias-layer name" — i.e. the design system's alias layer is incomplete and the sheet says so rather than silently inventing a token.
- Edge cases / failure handling: `.themeCube:hover:not(.selected)` excludes the selected cube from the hover fill.
- Surprising: A CSS comment that records a *known gap in the token layer* — a future designer can see that `--dsw-static-neutral-bluish-400` was used because no alias exists, and can add the alias.

### packages/client/ui-theme/src/client/AppearanceRow.tsx
- Purpose: The Light / Dark / System cube row.
- Key abstractions: `CUBES` — a literal array of `{id, labelKey, Icon}` (line 31-35); `AppearanceRowInjected` carries only `setTheme`.
- Data flow: `useStore(s => s.preference)` reads the mirrored preference; `setTheme(id)` is the injected write.
- Non-obvious design decisions: The header comment (line 5-6) states the invariant: "Selection follows the persisted preference, never the resolved active theme." So under `system` with an OS-dark screen, the **System** cube stays selected, not Dark.
- Edge cases / failure handling: `aria-pressed={preference === id}` on each cube, so the state is in the accessibility tree and not only in the CSS.
- Surprising: The component declares `PropsRuntime<'settings.general.item'>` — it inherits the *whole* global standard kit (session list, panel info, resources, workspaces) even though it uses none of it. That is the cost of a single composed-props model, and the tests compensate by stubbing all of it (see `appearance-row.client.spec.tsx`).

### packages/client/ui-theme/src/client/FontFamilyRow.module.css
- Purpose: One rule for the font-family field.
- Key abstractions: `.field { flex: 0 1 240px; min-width: 0; }`.
- Data flow: Imported by `FontFamilyRow.tsx`.
- Non-obvious design decisions: The field reuses the *font-size row's* cell (`rowCss.row`, `rowCss.rowText`, …) and only overrides the field's own sizing, so the three font rows align to one basis — "the fields share one basis so the three rows align, and shrink with the row."
- Edge cases / failure handling: `min-width: 0` is what lets the field shrink inside a flex row instead of forcing the row wide.
- Surprising: `flex: 0 1 240px` (no grow) is deliberate: the field must not steal width from the title column.

### packages/client/ui-theme/src/client/FontSettingsGroup.module.css
- Purpose: One rule for the font settings group's separators.
- Key abstractions: `.group:last-child > :last-child` and `.group:last-child > :last-child > :last-child`.
- Data flow: Imported by `FontSettingsGroup.tsx` as `css`.
- Non-obvious design decisions: The header comment states the ownership rule: "the expanded rows follow the text font-size row with the same full-width separators, so the group adds none of its own. When the group ends the General column, its last visible row drops the separator." The selector needs *two* levels (`:last-child` and `:last-child > :last-child`) because the group renders the text size row and then a wrapper `<div id={regionId}>` holding the expanded rows — when collapsed the wrapper is absent, when expanded the innermost row is the one that must drop the rule.
- Edge cases / failure handling: The rule is scoped to `:last-child`, so a group that is *not* last in the General column keeps its separator — the section column owns that decision.
- Surprising: The group contributes no separator of its own; it reuses the font-size row's `border-bottom` and only removes the trailing one. A group's visual rhythm is therefore inherited, not declared.

### packages/client/ui-theme/src/client/FontSettingsGroup.tsx
- Purpose: The text font-size row plus its disclosure region holding the three font rows and the two extra size rows.
- Key abstractions: `FontSizeRowExpander` — a controlled `{open, controls, onToggle}` bundle passed down rather than a callback plus a boolean.
- Data flow: `useState(false)` for the disclosure, `useId()` for the controlled region's id; each row's write is bound to its role by the closures at line 37-42.
- Non-obvious design decisions: The region is *unmounted* when closed (`{open && (<div id={regionId}>…)}`, line 46) rather than hidden — so the collapsed state carries no DOM and no stale input state. The README (line 32) specifies "collapsed on every settings open", which follows from the component being re-mounted when Settings opens.
- Edge cases / failure handling: `aria-controls={regionId}` and `aria-expanded={open}` live on the expander button, and the region carries the matching `id` — the wiring the font-settings-group spec asserts.
- Surprising: The group is registered as **two** slots (`appearance` order 10 and `font-size` order 11) but renders a *single* component, and the group's own store is shared with the appearance row's sibling — two entries, one font store.

### packages/client/ui-theme/src/client/FontSizeRow.module.css
- Purpose: Styles for the font-size stepper pill.
- Key abstractions: `.row`, `.rowText`, `.title`, `.desc`, `.control`, `.stepper`, `.value`, `.unit`, `.arrows`, `.arrow`, `.expander`.
- Data flow: Imported by `FontSizeRow.tsx`; also imported by `FontFamilyRow.tsx` as `rowCss` for the shared cell.
- Non-obvious design decisions: The arrow column is `position: absolute; right: 8px` with `opacity: 0` (line 73-80) and revealed by `.stepper:hover .arrows, .stepper:focus-within .arrows` (line 82-85). The comment explains both halves: "anchored right so the value stays pill-centered whether or not the arrows are showing" and "Hidden with opacity, not visibility: the buttons stay in tab order and in the accessibility tree, so keyboard focus itself triggers the reveal." The value uses `font-variant-numeric: tabular-nums` (line 59) so the number does not jitter while stepping.
- Edge cases / failure handling: `.arrow:disabled` switches the colour to `--dsw-alias-label-caption` and `cursor: default`; `.expander[aria-expanded='true'] svg` rotates 180° — the rotation is driven by the *ARIA state*, not by a React state variable, so it cannot desynchronise.
- Surprising: The arrow buttons are 17×12px chips with a `color-mix` wash of the layer-1 surface — a deliberately tiny hit target, which is a good thing to know before copying this pattern.

### packages/client/ui-theme/src/client/FontSizeRow.tsx
- Purpose: The font-size stepper row for one role.
- Key abstractions: `FontSizeRowInjected` carries `role` and `setFontSize(px)`; the optional `expander` prop carries the disclosure affordance.
- Data flow: `useStore(s => s.fontSizes[role])` reads the mirrored size; `FONT_SIZE_SPECS[role]` supplies the bounds.
- Non-obvious design decisions: The header comment (line 6-7) states the invariant: "The displayed value follows the persisted setting, never the click echo." So clicking "+" does not change the number until the durable write lands — which is why the spec asserts the display is unchanged immediately after the click.
- Edge cases / failure handling: Each arrow is independently disabled at its own bound (`fontSize >= max`, `fontSize <= min`, lines 66, 75) — the bound is per role, so the code role (10–16) and the terminal role (10–20) have different limits from the text role (10–22).
- Surprising: The row is the *only* place the `expander` prop is honoured, so the disclosure button is an optional capability injected by the parent rather than a feature of the row — a clean way to make a component reusable in two layouts.

### packages/client/ui-theme/src/client/FontFamilyRow.tsx
- Purpose: The font-family field for one role.
- Key abstractions: `FontFamilyRowInjected` carries `role` and `setFontFamily(value)`.
- Data flow: `useStore(s => s.fontFamilies[role])` gives the persisted list; `commit()` normalises the DOM value in place and hands it to the service.
- Non-obvious design decisions: The field is keyed by the persisted value (`key={value}`, line 48) with `defaultValue` — so when the durable list changes, React **remounts** the input and the new value is shown, rather than the component fighting the user's typing. The Enter handler is IME-aware (line 58-59): "Some IMEs report composition only through keyCode 229", so both `isComposing` and `keyCode === 229` suppress the commit. `maxLength={200}` bounds the input.
- Edge cases / failure handling: The commit path normalises *before* sending, so the DOM shows the normalised string immediately — the user sees exactly what was stored, including the added quotes.
- Surprising: `commit()` mutates `input.value` directly rather than keeping local state; combined with the `key` remount, the input is fully controlled by the store, and the spec proves it ("commits on Enter and follows later store changes", including a *stale* sync being ignored).

### packages/client/ui-theme/src/client/index.ts
- Purpose: The browser half — the `ThemeRuntime` service, the two settings rows, the desktop font-size shortcuts and the style installation.
- Key abstractions: `ThemeSnapshot` (immutable, with a monotonic `revision`); `ThemeDefinition` / `ThemeTokens` / `ThemeTokenOverrides` (the per-mode token layer); `ThemeTokenInspection` (a JSON-safe token directory).
- Data flow: The Host settings scope (`ctx.configForms.get('ui-theme')`) → `ThemeRuntime` → `theme/change` event → the row stores (mirrors) → the components. The DOM is never touched by the service.
- Non-obvious design decisions: **Eight, each load-bearing.** (1) *The service never touches the DOM* (line 140-141: "it never touches the DOM — ui-layout's presenter consumes the resolved snapshot") — the spec asserts `document.body.hasAttribute('data-ds-dark-theme')` is false after `setTheme` (`theme.client.spec.ts:140`). (2) *The pending-write guard* (line 305-311 and 313-326): `write()` increments `pendingWrites`; `adopt()` returns early while `pendingWrites > 0`, so a Host echo of an earlier write cannot revert a later local change; the durable section is adopted once the writes settle. The comment at line 173-174 says exactly that. (3) *One mutation for a three-role step* (line 272-287): `adjustFontSizes` computes each role's clamped value, collects only the **changed** fields, and issues a single `host.mutate(ops)` plus a single `theme/change`. (4) *Boot-script read-back* (line 430-438, 441-450): the first snapshot is seeded from the CSS variables the boot script wrote, so the client does not flash the schema defaults. (5) *Token override layers* (line 369-378): a layer per source, stacked by a monotonic `seq`, later layers winning per-token, and the disposer identity-checked (`if (this.overrides.get(source) !== layer) return`) so a stale disposer cannot tear down a newer layer. (6) *A teaching error for a bare-string override* (line 466-486): a single value would go illegible when the user switches colour scheme, so the message says so and shows the fix. (7) *Disposing the active theme resets the preference* (line 343-350) so the UI never keeps tokens of an unregistered theme. (8) *The desktop font-size shortcut* (line 499-529): it registers the fixed command (so the shortcut reference shows it) and observes fixed input, refusing to act while composing, default-prevented, repeating, or inside the terminal region.
- Edge cases / failure handling: `setFontSize` throws for out-of-range or fractional values (line 260); `setTheme` throws for an unregistered id (line 243-245); `register` throws for a duplicate id and for the reserved id `system` (line 337-340); `prefers-color-scheme` is absent in a non-browser run (line 191) and the OS flip only republishes while the preference is `system` (line 195-198).
- Surprising: `validateOverrides` returns a *defensive per-token copy* so a later mutation of the caller's object cannot reach the stored layer — and the spec proves it by mutating the object after the call (`theme.client.spec.ts:228`).

### packages/client/ui-theme/src/client/locales.ts
- Purpose: The `settings.theme` dictionary (24 keys).
- Key abstractions: `zh` is the source of truth; `en` is `satisfies Record<ThemeKey, string>`.
- Data flow: `ctx.locale.register(SETTINGS_NS, { zh, en })`; the components receive `t` through the standard locale seat.
- Non-obvious design decisions: The keys are *namespaced by role* (`fontSize.text.title`, `fontSize.code.title`, `fontSize.terminal.title`) so the same `FontSizeRow` component can render any role with `t(\`fontSize.${role}.title\`)` — one component, three rows, no props threading of copy.
- Edge cases / failure handling: The `en` dictionary is typed against `ThemeKey`, so a missing key is a compile error rather than a runtime fallback to the key string.
- Surprising: The key `fontSize.unit` is `"px"` in both languages — a *value* disguised as copy, which is the right place for it (a locale could use a different unit).

### packages/client/ui-theme/src/client/settings-store.ts
- Purpose: The two slot stores that mirror the theme snapshot for the settings rows.
- Key abstractions: `AppearanceRowState {preference, revision}` and `FontRowState {fontSizes, fontFamilies, revision}`; each store has a single `sync` action.
- Data flow: The plugin's `theme/change` listener calls `bound.sync(...)`; the components read via `useStore`.
- Non-obvious design decisions: **`revision: -1` in `init`** (line 28, 60) with the comment "Service revision; -1 until first sync so revision 0 lands as a change" — without it the first sync at revision 0 would be dropped by the `revision <= d.revision` guard (line 31, 63). The guard is what makes the mirror *monotonic*: a stale or duplicate sync is ignored, so an out-of-order event cannot move the UI backwards.
- Edge cases / failure handling: The mirror only ever moves forward; a `sync` with an equal or lower revision is a no-op, which the spec asserts explicitly.
- Surprising: The store holds a *mirror*, not the authority. The authority is the service; the store exists only so the component has a typed selector hook. That distinction is what lets the component's displayed value "follow the persisted setting, never the click echo".

### packages/client/ui-theme/src/client/styles.ts
- Purpose: Mounts the eight global token sheets for exactly the owning plugin's lifetime.
- Key abstractions: `STYLES` — an ordered `[name, css]` tuple array; `installThemeStyles(ctx)`.
- Data flow: `import … from '../styles/base.css?inline'` (Vite's inline convention) → a `<style data-plugin="…" data-plugin-css="…">` per sheet → `document.head`.
- Non-obvious design decisions: The sheets are mounted through `ctx.effect`, so they are removed on plugin dispose *and* on HMR reload (line 37: `return () => { tag.remove() }`). Each tag carries `data-plugin` and `data-plugin-css` so a tool (or the spec) can identify which sheet is which.
- Edge cases / failure handling: `if (typeof document === 'undefined') return` (line 29) — a Node-side boot of the client tree does not crash on `document`.
- Surprising: The order of `STYLES` is the *cascade* order and is load-bearing: `scrollbar.css` must come after `design-platform.css`, which declares the tokens it consumes.

### packages/client/ui-theme/src/css-modules.d.ts
- Purpose: Ambient declarations for `*.module.css`, `*.css` and `*.css?inline`.
- Key abstractions: `declare module '*.css?inline' { const css: string; export default css }` (line 8-11) is the one that matters here.
- Data flow: Makes `import base from '../styles/base.css?inline'` type-check.
- Non-obvious design decisions: The `?inline` module shape is declared *here* rather than in a shared package because each package has its own tsconfig and its own `types` include.
- Edge cases / failure handling: n/a.
- Surprising: A TypeScript ambient declaration is what makes a Vite-specific import suffix legal — the same trick applies to `?raw`, `?url`, `?worker`.

### packages/client/ui-theme/src/index.ts
- Purpose: The host half — the durable preference schema and the index-injection wiring.
- Key abstractions: `Config` — a zod object with every field `.volatile()` (line 39-45); `Config` as a *type* interface and as a *value* schema (the same name, a common cordis idiom).
- Data flow: `ctx.inject(['settings'], …)` disables the settings auto-configure for this fiber; `ctx.on('webserver/index-inject', table => table.push(...bootThemeInjections(...)), { prepend: true })`.
- Non-obvious design decisions: `prepend: true` (line 64) puts the theme rows **first** in the injection table, so the canvas colour and the font variables are set before any other injected script. Every field is `.volatile()` so the Host does not try to serialise live values. The Host half reads the *current* values at injection time (line 55-63) rather than caching them, so a preference change is reflected on the next index render.
- Edge cases / failure handling: The `ctx.inject(['settings'])` guard (line 53) makes the plugin's settings integration optional at the host level — `child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))` disables auto-generation for this namespace.
- Surprising: The host half is 65 lines and contains **no** theme logic — all of it lives in `theme-settings.ts` and `boot-theme.ts`, which are shared with the browser half. The split is Host (durability) vs Browser (presentation), and the two halves share only pure data.

### packages/client/ui-theme/src/styles/base.css
- Purpose: The shared radius scale, the built-in font stacks, the settings-card material aliases, and the automatic-focus outline suppression.
- Key abstractions: `--dsw-radius-xs|sm|md|lg|xl|panel` (4/8/12/16/20/28px); `--dsh-font-family-text-default` / `--dsh-font-family-code-default`.
- Data flow: The `:root` block defines the defaults; the `body` block composes the user list ahead of the built-in stack.
- Non-obvious design decisions: The code font stack "deliberately omits a bare `monospace` tail (Windows CJK falls back to SimSun otherwise)" (line 4-5) — a Windows-specific typography bug encoded in a comment. The user-list composition repeats the built-in stack after the user list ("An unset list falls back to the built-in stack itself; the repeated families are inert", line 28-29) — the repeat is harmless to font matching and makes the fallback automatic.
- Edge cases / failure handling: The outline suppression is scoped to exactly one attribute and both focus states: `[data-dsh-automatic-focus]:focus, [data-dsh-automatic-focus]:focus:focus-visible { outline: none; }` (line 36-39) — "ordinary keyboard focus styling, borders, shadows, and error states remain intact."
- Surprising: The suppression is written as `[data-dsh-automatic-focus]:focus` **and** `:focus:focus-visible` (the doubled selector) — the second is redundant but survives a class-attribute rewrite during the focus-without-ring helper, which is exactly what `focus-styles.client.spec.ts` proves.

### packages/client/ui-theme/src/styles/brand-font.css
- Purpose: Three `@font-face` rules for the bundled Montserrat faces.
- Key abstractions: `font-family: 'Montserrat'`, `font-style: normal`, weights 300/400/500, `font-display: swap`.
- Data flow: Referenced by `--dsw-font-family-brand` in `base.css:10`.
- Non-obvious design decisions: `font-display: swap` on all three, so the brand text paints in the fallback and re-paints when the font arrives. The weights are 300/400/500 only — the design system uses no other Montserrat weight.
- Edge cases / failure handling: The faces are local `url(./montserrat-*.woff2)`, so the app works offline; the spec asserts the CSS contains no `url(https?:`.
- Surprising: The file is exported from the package as `"./brand-font.css"` so a consumer (the Web app) can import it and get the font asset emitted by Vite.

### packages/client/ui-theme/src/styles/corner-shape.css
- Purpose: Smooths every rounded corner in the app to a superellipse, inside a support guard.
- Key abstractions: `--dsw-corner-shape: superellipse(1.5)`; applied to `*`, `*::before`, `*::after`.
- Data flow: The universal rule inside `@supports (corner-shape: superellipse(1.5))`.
- Non-obvious design decisions: The whole sheet lives **inside** the guard, so engines without `corner-shape` keep plain circular corners (line 16-26). The header comment explains the three traps: (1) `corner-shape` does not inherit, hence the universal selector with the two pseudo-elements; (2) "other pseudo-elements (for example the `::-webkit-scrollbar` parts) stay circular" — deliberately not covered; (3) full-round shapes must opt out, "a superellipse deforms a circle into a squircle and squares off capsule ends", and "every effectively uncapped radius (50%, 100%, or a pill radius far above the box size) pairs `corner-shape: round` with its `border-radius` in the owning component sheet."
- Edge cases / failure handling: The pairing is not left to discipline — the corner-shape spec enforces it across *every* package stylesheet (see `tests/corner-shape-styles.client.spec.ts`).
- Surprising: The escape hatch is `corner-shape: round` declared in the *owning* component sheet, which is why the spec can check "every full-round border-radius under packages/ pairs `corner-shape: round` in the same rule".

### packages/client/ui-theme/src/styles/design-platform.css
- Purpose: The colour authority — ~90 static palette steps, the full `--dsw-alias-*` semantic layer for light and dark, and the platform-specific menu fill.
- Key abstractions: `--dsw-static-*` (raw steps) → `--dsw-alias-*` (semantic names) → `--dsw-specific-*` (feature-specific); the light block on `body`, the dark block on `body[data-ds-dark-theme]`.
- Data flow: Every component sheet reads only the alias layer.
- Non-obvious design decisions: (1) The static steps are declared **twice** — once under `body` and once under `body[data-ds-dark-theme]` — even where the values are identical (the amber/neutral/red steps are copied verbatim), because the dark block must be self-contained. (2) The alias layer is huge and *entirely* semantic: `--dsw-alias-bg-layer-1/2/3`, `--dsw-alias-border-l1..l4`, `--dsw-alias-state-*`, `--dsw-alias-markdown-*`, `--dsw-alias-interactive-*`. (3) Two entries carry a *reason* in a comment: `--dsw-static-deepseek-400` was "Brightened from the platform rgb(103, 158, 254) at the designer's request: legibility on the dark toast surface", and the file header notes that Figma's `font-weight 510` always renders as 500 "because non-variable webfonts snap intermediate weights unpredictably across platforms".
- Edge cases / failure handling: The macOS overrides (line 402-408) are separate `html[data-platform='darwin'] body` blocks, because "Overlays without MenuSurface's opaque backing cannot blur page content over native vibrancy reliably, so their fill stays nearly opaque on macOS."
- Surprising: The dark palette deliberately keeps a *lower* alpha on some surfaces (e.g. `--dsw-alias-bg-mask-1: rgba(0,0,0,0.5)` dark vs `0.24` light) — the dark palette uses the same token names with different semantics, which is exactly why a third-party theme must supply *both* modes.

### packages/client/ui-theme/src/styles/focus.css
- Purpose: The one global focus-ring fallback plus the pointer-modality suppression.
- Key abstractions: `--dsw-focus-ring-width: 2px`; `--dsw-focus-ring-color` (the per-surface override point).
- Data flow: `:focus-visible { outline-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-width: var(--dsw-focus-ring-width); }`.
- Non-obvious design decisions: The comment (line 6-9) is the whole design in two sentences: "The fallback names the colour and the standard width, never the style: a control that disables its outline keeps `none` and paints nothing. Without the width, Chromium's unnamed ring stayed at `auto 1px` while every declared ring used the standard geometry." So the sheet sets colour and width but **not** `outline-style` — a control's own `outline: none` still wins, and a control with no ring gets the standard geometry rather than the UA default.
- Edge cases / failure handling: The pointer-modality rule (line 18-21) sets `--dsw-focus-ring-color: transparent` **and** `outline-color: transparent` for `:focus-visible:not(:read-write)` under `html[data-input-modality='pointer']` — "the rule does not clear `box-shadow`, so elevation and selected-state borders remain independent of ring visibility", and editable controls keep their own focus feedback on click.
- Surprising: The rule sets the *token* as well as the property, so a descendant that declares its own ring shadow through `var(--dsw-focus-ring-color)` inherits the suppression — and the spec asserts that no focus rule may use `box-shadow` to fake a ring.

### packages/client/ui-theme/src/styles/gradient-shadow-text.css
- Purpose: The Markdown font ladder derived from the two size settings, the shadow scale, and the elevation tokens.
- Key abstractions: `--dsh-content-font-delta`, `--dsh-content-font-size-secondary`, `--dsh-content-font-delta-secondary`, `--dsh-code-font-delta`; `--dsw-shadow-lv1..3`; `--dsw-elevation-stroke`, `--dsw-elevation-panel|prominent|soft`.
- Data flow: The Host boot script and the presenter write `--dsh-content-font-size` / `--dsh-code-font-size` on `body`; every ladder entry is `calc(base + var(--dsh-content-font-delta))`.
- Non-obvious design decisions: (1) The secondary tier is a *piecewise* function of the setting, written in CSS: `min(calc(var(--dsh-content-font-size) - 1px), max(13px, calc(var(--dsh-content-font-size) - 2px)))` — "setting − 1 through 14px, then setting − 2: 10→9, 14→13, 15→13, 22→20. `max(13px, …)` selects the delta, not a font-size floor" (line 52-55). (2) The code ladder is *separate*: inline code is `--dsh-code-font-delta` above the code size while the code block is the size itself (line 163-183). (3) The elevation tokens are declared **per element** (`body, body *`, line 31-40) with the reason spelled out at line 27-30: "继承传下来的是在 body 上已替换完 var() 的值…逐元素声明让每个元素按自己看到的描边色重新替换" — a custom property computes with `var()` already substituted, and descendants inherit that *computed* value, so a surface-level rebind of `--dsw-elevation-stroke-color` would never reach the box carrying the shadow if the derived token were declared only on `body`.
- Edge cases / failure handling: The elevation stroke is a 0.5px hairline drawn *inside* the shadow (`0 0 0 0.5px var(--dsw-elevation-stroke-color)`), so an elevated surface sets `border: 0` and consumes no layout. The dark menu rebinds the stroke to `border-l3` while light keeps `border-l1` (line 23-25).
- Surprising: The file mixes Chinese and English comments because it was exported from a Figma plugin and then hand-amended; the "手工补充（非插件导出）" marker at line 177 distinguishes a hand-written token from an exported one — the stylesheet carries its own provenance.

### packages/client/ui-theme/src/styles/montserrat-light.woff2
- Purpose: The Montserrat Light (weight 300) face used by `--dsw-font-family-brand`.
- Key abstractions: binary WOFF2.
- Data flow: Loaded by `brand-font.css`'s `@font-face`; copied to `lib/styles` by the tsdown copy step.
- Non-obvious design decisions: The file is bundled rather than fetched, so the app renders the brand face offline.
- Edge cases / failure handling: The redistribution license travels with it (`Montserrat-OFL.txt`).
- Surprising: n/a — see "Files skipped".

### packages/client/ui-theme/src/styles/montserrat-medium.woff2
- Purpose: The Montserrat Medium (weight 500) face.
- Key abstractions: binary WOFF2.
- Data flow: as above.
- Non-obvious design decisions: as above.
- Edge cases / failure handling: as above.
- Surprising: n/a — see "Files skipped".

### packages/client/ui-theme/src/styles/montserrat-regular.woff2
- Purpose: The Montserrat Regular (weight 400) face — the default brand weight.
- Key abstractions: binary WOFF2.
- Data flow: as above.
- Non-obvious design decisions: as above.
- Edge cases / failure handling: as above.
- Surprising: n/a — see "Files skipped".

### packages/client/ui-theme/src/styles/Montserrat-OFL.txt
- Purpose: The SIL Open Font License 1.1 for the Montserrat family, shipped beside the font files.
- Key abstractions: legal text, 93 lines.
- Data flow: copied into `lib/styles` by the tsdown copy step and published in `files`.
- Non-obvious design decisions: The license is a *build artefact of the package* (copied, not authored) — the spec asserts the package ships it.
- Edge cases / failure handling: n/a.
- Surprising: The copyright line is "Copyright 2024 The Montserrat.Git Project Authors (https://github.com/JulietaUla/Montserrat.git)" while the README says "The source is Google Fonts' Montserrat distribution" — two upstream claims, both harmless, both recorded.

### packages/client/ui-theme/src/styles/onboarding.css
- Purpose: The onboarding accent, three named gradient stop sets, and the light/dark card, checkbox and secondary-action colours.
- Key abstractions: `--dsw-gradient-onboarding-{violet,blue,cyan}-stops`; `--dsw-alias-onboarding-*`.
- Data flow: Consumed by the onboarding feature's own component sheets.
- Non-obvious design decisions: The gradients are declared as *multi-stop percentage lists with a repeated first colour* (e.g. `#2a2fb6 33.102%, #8b76f6 50.954%, #c5c0ff 85.326%, #2a2fb6`) so the sweep has no hard edge. The header comment states the boundary: "card geometry and animation belong to the feature."
- Edge cases / failure handling: The dark overrides (line 12-16) only rebind the card fill, secondary fill and checkbox border; the accent and the gradients are palette-invariant.
- Surprising: The card fill is a `color-mix` of a static step at 80% rather than a dedicated step — the design system's own rule about "a static step plus a semantic alias in the same change" is bent here by a mix.

### packages/client/ui-theme/src/styles/scrollbar.css
- Purpose: The scrollbar skin, and the rebinding contract that lets an elevated surface change its bar.
- Key abstractions: `--dsh-scrollbar-thumb`, `--dsh-scrollbar-thumb-hover`, `--dsh-scrollbar-thumb-border`, `--dsh-scrollbar-track-margin`, `--dsh-scrollbar-width`.
- Data flow: The `body` block binds the l1 pair; an elevated surface rebinds the pair on its own container; both the Firefox path (`scrollbar-color`) and the WebKit path (the pseudo-elements) read the *same* variables.
- Non-obvious design decisions: **Three, each with a hard-won reason in the comment.** (1) The rules sit on `body`, not `html` (line 5-9): "design-platform.css declares the `--dsw-alias-*` tokens on `body` … and custom properties only inherit downward, so an `html` rule resolves them to the guaranteed-invalid value and `scrollbar-color` falls back to `auto`." (2) The two rendering paths are **mutually exclusive by construction** (line 28-44): "A non-`auto` `scrollbar-width` or `scrollbar-color` makes Chromium and Safari drop every `::-webkit-scrollbar*` rule for that element, including `::-webkit-scrollbar-thumb:hover` — measured in chromium … Declaring both unconditionally therefore leaves the hover tokens with no rendering at all, because the engines that implement the hover pseudo-element are exactly the ones the standard properties silence, and Firefox has no hover pseudo-element to fall back on." The split is `@supports not selector(::-webkit-scrollbar)`. (3) The properties are re-declared **per element** (`body, body *`, line 56-60): "Inheriting would pass down the COLOUR already substituted at `body`, so a descendant rebinding `--dsh-scrollbar-thumb` could not change it; re-declaring makes each element substitute the variable as it sees it."
- Edge cases / failure handling: The `::-webkit-scrollbar-corner` is forced transparent (line 93-95) because the UA's opaque corner would mismatch the transparent track. `corner-shape: round` is paired with the thumb's `border-radius: 999px` (line 81-82) to survive the universal superellipse rule.
- Surprising: The comment at line 43-44 explains the *fallback direction* of the guard: "An engine too old for the `selector()` function makes the condition invalid, which evaluates false and selects the pseudo-element path — the correct side for the pre-16.4 Safari that is the realistic case."

### packages/client/ui-theme/src/styles/shiki.css
- Purpose: The syntax-highlight palette for shiki's `css-variables` theme.
- Key abstractions: `--shiki-token-*` for nine token classes, in light and dark.
- Data flow: The `ui-primitives` CodeBlock emits `--shiki-*` custom properties; this sheet supplies their values.
- Non-obvious design decisions: The background and foreground are *aliased to the markdown code-block tokens* (line 8-9: "Background/foreground deliberately alias the markdown code-block tokens so highlighted and plain blocks agree") rather than given their own colours — one source of truth for "what a code block looks like".
- Edge cases / failure handling: n/a.
- Surprising: The `--shiki-*` namespace is a *third-party* contract (shiki's), living inside this repo's own token sheet — the sheet is the adapter between a vendor's variable names and the app's palette.

### packages/client/ui-theme/src/theme-settings.ts
- Purpose: The durable theme schema — the three font roles with their ranges, the settings envelope, and the font-family normaliser.
- Key abstractions: `FONT_SIZE_SPECS` (per role: field, variable, min, max, default); `ThemeSettings`; `ThemeSettingsSchema`; `normalizeFontFamily`; `isFontSize`; `isThemePreference`.
- Data flow: Imported by the Host half (the zod schema), the browser half (the runtime) and the settings rows (the bounds).
- Non-obvious design decisions: (1) **One table carries the whole font contract** (line 57-61): each role names its settings field, its CSS variable, its range and its default. A new role is one row, and every consumer (the runtime, the row component, the boot script, the schema) reads it. (2) `normalizeFontFamily` (line 163-169) drops quotes, backslashes, angle brackets and control characters, collapses whitespace, drops empty names, and double-quotes every name that is not a CSS generic family. The doc says why: "so the result is always a valid list safe to embed in inline CSS and boot scripts. Normalizing a result returns it unchanged." The 15-entry `GENERIC_FAMILIES` set (line 150-153) is what keeps `monospace` and `ui-monospace` unquoted.
- Edge cases / failure handling: `fontSizeSchema` (line 114-116) is `z.number().step(1).min(min).max(max).default(default)` — integers only, range-bounded, with a default; `isFontSize` (line 133-136) repeats the check for the runtime path, so a caller bypassing the schema is still rejected.
- Surprising: The *durable* schema and the *live* schema are two different objects with the same fields — `ThemeSettingsSchema` (line 139-147, not volatile, used at the Host/wire boundary) and `Config` in `src/index.ts` (line 38-46, all volatile, used at the runtime boundary). The browser scope validates against the same envelope.

### packages/client/ui-theme/tests/app-region-styles.client.spec.ts
- Purpose: Window drag-region ownership, asserted against the CSS and the TSX markup on disk.
- Key abstractions: `CHROME_ROWS` — a manifest of nine chrome rows, each naming its stylesheet, its class selector, its markup file, and its pinned geometry.
- Data flow: The spec scans every package stylesheet for `-webkit-app-region: drag` and every package `.tsx` file for the `data-window-drag` attribute.
- Non-obvious design decisions: The spec's premise (line 13-14) is a real platform constraint: "Electron composes app-regions from window geometry in DOM order, ignoring stacking: a drag rule on a content container overrides the no-drag of any overlay mounted earlier, so its text and labels drag the window instead of receiving clicks." The design response is that exactly one sheet may declare the drag rule — the shell's `html[data-platform='darwin'] [data-window-drag]` — and each chrome row marks *itself*. The spec proves both halves: "declares the window drag surface in exactly two places" (the shell rule plus the Windows caption row) and "finds the drag mark on exactly the chrome rows the manifest names".
- Edge cases / failure handling: The TSX scanner is a hand-written tag parser (`openingTags`, line 165-196) that tracks brace depth and quoted strings so a `>` inside a prop expression does not end the tag — because the alternative (a regex) would mis-parse JSX. The `DRAG_MARK_PATTERN` uses a negative lookahead so `data-window-drag-something` does not match.
- Surprising: The spec also *pins geometry* — "declares every pinned chrome row at the height the manifest pins" — so a sidebar's `.topStrip` must stay 52px and the conversation header's `.header` must stay at `min-height: 76px`, because the drag region is computed from the row's own box.

### packages/client/ui-theme/tests/appearance-row.client.spec.tsx
- Purpose: The Appearance row's behaviour.
- Key abstractions: A fixture that stubs the *entire* global standard kit (`useSessions`, `useSessionStatus`, `usePanelInfo`, `useSessionRetainInfo`, `useResource`, `useWorkspaces`) plus `allowAllAccess`.
- Data flow: A real `createAppearanceRowStore().create()` instance; `store.actions.sync(preference, 0)` seeds it.
- Non-obvious design decisions: The spec's second test (line 75-84) asserts the *deferred* semantics explicitly: after a click, "No store write yet: selection is unchanged" — the cube flips only when the store mirror is synced. The component is a pure function of the store.
- Edge cases / failure handling: The comment at line 14-15 ("Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps") is the tax of the composed-props model: a component that uses one hook must still be handed the whole kit.
- Surprising: `allowAllAccess` from the test runtime fills the access-control props, so the component's prop type is a *complete* surface that the test must satisfy in full.

### packages/client/ui-theme/tests/apply.client.spec.ts
- Purpose: The plugin's wiring — service provision, dictionaries, slot registration, snapshot projection, shortcut installation, and teardown.
- Key abstractions: `bench()` builds a real `Context` with `SlotRegistry`, `LocaleRuntime` and a `TestRemote`; `fontKeyboard()` stands in for the keyboard service while keeping the real registry.
- Data flow: The spec drives the *service* boundary, not the components.
- Non-obvious design decisions: (1) The spec registers the slot **both before and after** the plugin's apply (line 301-323) and asserts the rows land either way — that is the point of `ctx.slots.inject`. (2) "recovers after an HMR collapse of the declaring entry (stale disposer must not block)" (line 442-457) — the declarer is disposed, the cascade removes the rows, the declarer re-declares, and the plugin's rows come back even though the plugin's apply closure still holds stale disposers. (3) "teardown removes the rows and the dictionaries" (line 459-476) and asserts the translation falls back to the bare key afterwards.
- Edge cases / failure handling: "activates before a slow settings refresh and converges when it settles" (line 414-430) — the mirror keeps serving the last good answer, so activation never blocks on the settings transport. "ignores an invalid preference crossing the settings wire" (line 432-440) — `preference: 'sepia'` from the Host leaves the runtime on `system`.
- Surprising: The spec asserts the exact mutation payload of a font-size step (line 142-146): `[{op:'set',path:['fontSize'],value:15},{op:'set',path:['codeFontSize'],value:12},{op:'set',path:['terminalFontSize'],value:14}]` — one call, one durable write, three fields.

### packages/client/ui-theme/tests/boot-theme.client.spec.ts
- Purpose: The bootstrap rows and their effect on the document.
- Key abstractions: `executeBootstrap()` runs the script row in a `node:vm` context with `{ document, matchMedia }` — a real execution of the generated code.
- Data flow: `bootThemeInjections(preference, fontSizes)` → head style row + body script row → executed against the jsdom document.
- Non-obvious design decisions: The spec compares the head CSS *textually* (line 36: `':root{color-scheme:dark}body{background-color:#151517;--dsh-boot-bg:#151517}'`), so the exact generated string is part of the contract. The `system` case asserts the media query is present in the head CSS (line 64-71) — the canvas colour is decided by CSS, not by script.
- Edge cases / failure handling: "writes normalized durable font lists and leaves empty lists unset" (line 91-100) passes a font list containing `</script>` and asserts the generated script text does **not** contain `<`, and that the resulting value is `"MesloLGS NF/script", monospace` — the angle brackets are stripped by the normaliser and the script cannot be broken out of.
- Surprising: The spec also asserts that a stale `data-ds-dark-theme` attribute is *cleared* when the durable preference is light (line 44-52) — the boot script must be idempotent, not additive.

### packages/client/ui-theme/tests/brand-font.client.spec.ts
- Purpose: That the brand font is genuinely offline and legally shipped.
- Key abstractions: none — a file-content spec.
- Data flow: `readFileSync` on the CSS, the three woff2 files, the license and `package.json`.
- Non-obvious design decisions: The spec checks the WOFF2 magic bytes (`expect(font.readUInt32BE(0)).toBe(0x774f4632)` — `wOF2`) rather than just the extension, so a renamed non-font file fails. It also asserts `expect(css).not.toMatch(/url\(https?:/)` — no remote font reference anywhere.
- Edge cases / failure handling: It asserts the *package manifest* side too: `manifest.files` contains `lib/styles` and `exports['./brand-font.css']` is `./lib/styles/brand-font.css`. A font that works in the repo but is not published is caught here.
- Surprising: The spec reads `package.json` from the package root — a test that checks the *packaging contract*, not the code.

### packages/client/ui-theme/tests/client-styles.client.spec.ts
- Purpose: That the eight global sheets mount in dependency order and are removed on dispose.
- Key abstractions: `style[data-plugin="@deepseek-ai/dsh-client-ui-theme"]` and its `data-plugin-css` attribute.
- Data flow: `installThemeStyles(scope)` on a fresh `Context`; the spec reads `document.head`.
- Non-obvious design decisions: The spec asserts the *exact ordered list* of `data-plugin-css` values (line 22-31) — the cascade order is a contract, not an implementation detail.
- Edge cases / failure handling: After `fiber.dispose()` the head contains zero of the plugin's tags — the disposal path is proven, not assumed.
- Surprising: The whole spec is 35 lines and covers a behaviour that is invisible in the UI — yet the order it pins is what makes `scrollbar.css` work.

### packages/client/ui-theme/tests/config.host.spec.ts
- Purpose: The host half: the durable namespace's validation, disposal, and the index-injection table.
- Key abstractions: `liveConfig(ctx, { Config, apply })` and `plainConfig(...)` from the settings package's own test helpers.
- Data flow: `ctx.emit('webserver/index-inject', table)` collects the rows exactly as an index render would.
- Non-obvious design decisions: The spec asserts the *ordering* of the injection table: the theme's style row and body script row come **before** another plugin's head script (line 51-54) — the theme's pre-plugin guarantee is a table-order guarantee, and the spec pins it. It also asserts the plugin's own rows are **gone** after `fiber.dispose()` while the other plugin's row remains (line 66).
- Edge cases / failure handling: "registers, validates, and disposes the durable theme namespace with its fiber" (line 26-41) rejects `preference: 'sepia'`, `fontSize: 9`, `fontSize: 23`, `codeFontSize: 17` and `terminalFontSize: 9` — every range boundary is pinned at the *durable* boundary, not only in the UI.
- Surprising: The file ends with a bare `it(...)` outside the `describe` block (line 78) — "keeps its own instance off the generated Settings pages" — asserting the Host plugin does not produce a generated settings page of its own.

### packages/client/ui-theme/tests/corner-shape-styles.client.spec.ts
- Purpose: The corner-shape contract, asserted against the CSS text on disk.
- Key abstractions: `atRuleBlock(css, prelude)` locates an at-rule's brace span; `isFullRound(value)` is a lexical check for `50%`/`100%`/≥99px.
- Data flow: Reads `src/styles/corner-shape.css` and every package stylesheet.
- Non-obvious design decisions: The spec asserts the sheet contains **nothing** outside the guard (line 44-47: `before.trim()` and `after.trim()` must both be `''`) — not "the token is inside the guard" but "the whole file is inside the guard". The rationale (line 40-42): "Outside the guard the declarations would be dropped as invalid anyway, but only on engines without corner-shape; keeping everything inside the guard states that unsupporting engines keep plain circular corners."
- Edge cases / failure handling: The cross-package check (line 83-90) is the one that matters: "The universal superellipse reaches every element, so each circle and pill states its own arc back; a new one without the pairing regresses silently on supporting engines only, which no jsdom test renders."
- Surprising: The spec's own reasoning — a defect that is invisible on every engine the test suite can run — is the reason the check exists at all. That is a generalisable argument for static contract gates.

### packages/client/ui-theme/tests/elevation-styles.client.spec.ts
- Purpose: The elevation contract — the hairline stroke, the menu material, and the border discipline.
- Key abstractions: `STROKE_COLOR`, `ELEVATED_SHADOW`, `NEUTRAL_BORDER`; the four detectors (`translucentMenusWithoutBackdrop`, `neutralBordersBesideElevation`, `wideNeutralBorders`, `wideFilledDividers`).
- Data flow: Parses `gradient-shadow-text.css` and `design-platform.css` plus every package stylesheet.
- Non-obvious design decisions: The spec distinguishes `body`-only declarations from `body *` declarations and asserts the *asymmetry*: the stroke colour is default on `body` alone (so a surface's rebind inherits down), while the *derived* tokens are declared per element (so the rebind actually re-substitutes). The comments (line 37-51) state the CSS reason: "A custom property computes with var() already substituted, and descendants inherit that computed value: derived tokens declared only on body would bake in body's stroke color, making every `--dsw-elevation-stroke-color` rebind a no-op."
- Edge cases / failure handling: "never pairs an lv/elevation shadow with a neutral border token under packages/" — "A 1px border beside the elevation stroke double-draws the outline and shifts layout by the border width; the hairline belongs to the shadow." State-coloured borders (the warn approval panels) are explicitly out of scope.
- Surprising: The spec also pins four *named* menu surfaces (line 122-141) — `MenuSurface.module.css`, `GoalBar.module.css`, `QueueDock.module.css`, `CordisPanel.module.css` — and asserts the container has **no** `backdrop-filter` while its background layer does, because a fixed-position descendant breaks background filtering.

### packages/client/ui-theme/tests/expected/radius-exceptions.expected.json
- Purpose: The exact allowlist of component stylesheets permitted to use local radii.
- Key abstractions: A map of `stylesheets → ["<selector>: <property>: <value>", …]`.
- Data flow: Read by `radius-styles.client.spec.ts` and compared for *equality* with the computed failures.
- Non-obvious design decisions: The allowlist is compared with `toEqual`, not `toContain` — so the file is an *exact* statement of every currently-allowed local radius, and adding a new one fails the test until the file is updated. That makes the exception list a reviewable artifact rather than a suppression file.
- Edge cases / failure handling: The list includes the *shortcuts* package's own `Reference.module.css` (line 57-64) — six radii — so the shard's own package is subject to the rule it hosts.
- Surprising: The list is 12 packages and 33 entries; a rule with 33 exceptions is a rule in need of the list.

### packages/client/ui-theme/tests/focus-ring-styles.client.spec.ts
- Purpose: The ring contract: which tokens a focus rule may use, and that pointer suppression is paired with the modality publisher.
- Key abstractions: `ACCENT`, `COLOR`, `WIDTH`, `FALLBACK`; `ringColorViolations(source)`.
- Data flow: Parses `focus.css` and every client package stylesheet.
- Non-obvious design decisions: The detector has three parts: a focus rule may not reference a token outside the allowed three; a ring must either name a colour or be explicitly colourless (`none|transparent|currentcolor|inherit`); and a `:focus-visible` rule that names the accent directly "bypasses `--dsw-focus-ring-color`" — which would defeat the pointer-modality suppression. That last check is the interesting one: it makes the suppression mechanism *unbypassable* rather than advisory.
- Edge cases / failure handling: The spec also asserts the pointer rule's exact declarations (line 50-51) and that **no** focus rule clears `box-shadow` (line 52) — "the rule does not clear `box-shadow`, so elevation and selected-state borders remain independent of ring visibility".
- Surprising: The spec imports `INPUT_MODALITY` and `INPUT_MODALITY_ATTRIBUTE` from `../../ui-primitives/src/input-modality.ts` — the publisher of the attribute — so the sheet and the publisher cannot drift apart silently.

### packages/client/ui-theme/tests/focus-styles.client.spec.ts
- Purpose: The *behavioural* side of the automatic-focus outline suppression, in jsdom.
- Key abstractions: `focusWithoutRing` from `ui-primitives`; a stylesheet with `button:focus { outline: 2px solid rgb(200, 100, 0); border: 1px solid red; box-shadow: 0 0 4px black; }` plus `base.css`.
- Data flow: Real focus, real class mutation, real `getComputedStyle`.
- Non-obvious design decisions: The suppression is implemented by *class update*, not by removing focus: the spec asserts `document.activeElement` is still the button (line 31) while `outline` becomes `none` and `border`/`boxShadow` are unchanged. And the recovery is asserted to be non-destructive: "restores navigation outlines after repeated automatic focus without consuming input" (line 37-47) checks that the keydown event's `defaultPrevented` stays `false` for Tab/Shift-Tab/ArrowDown/Home.
- Edge cases / failure handling: "keeps typing, modifier shortcuts and input-method navigation free of automatic outlines" (line 49-60) — after an automatic focus, a subsequent *keyboard* event must not re-arm the suppression, but a click-focus must.
- Surprising: "does not suppress later keyboard focus when an automatic target cannot receive focus" (line 62-70) — a disabled button that cannot take focus must not leave the app in a permanently ring-less state.

### packages/client/ui-theme/tests/font-family-row.client.spec.tsx
- Purpose: The font row's behaviour, plus the normaliser's rules.
- Key abstractions: The same full standard-kit fixture as the other row specs.
- Data flow: A real `createFontRowStore()` instance; `fireEvent.change` + `fireEvent.blur` / `keyDown`.
- Non-obvious design decisions: The normaliser's spec (line 72-76) is written as a *security* rule: "removes characters that could escape the string or the boot script" — the test input is `Fira\\"Code</style>\u0007, Sarasa  Mono SC` and the expected output is `'"FiraCode/style", "Sarasa Mono SC"'`, and the spec then asserts the normaliser is **idempotent** on its own output.
- Edge cases / failure handling: "ignores Enter while an input method is composing" (line 95-102) covers both `isComposing` and the `keyCode === 229` convention. The last test (line 104-116) asserts that a *stale* store sync does not overwrite the field — the revision guard reaches all the way to the DOM.
- Surprising: The field's `key={value}` remount is what makes the stale-sync case work; the test exercises a mechanism documented only in a one-line comment in the component.

### packages/client/ui-theme/tests/font-settings-group.client.spec.tsx
- Purpose: The disclosure group's behaviour.
- Key abstractions: The `aria-controls`/`aria-expanded` pair; the three font fields.
- Data flow: A real font store; clicks on the disclosure button.
- Non-obvious design decisions: The spec asserts the *unmount* semantics: `expect(screen.queryByRole('textbox')).toBeNull()` when collapsed (line 74) — the region is not merely hidden, it is not in the DOM. And `expect(document.getElementById(g.header.getAttribute('aria-controls')!)).not.toBeNull()` (line 77) — the `aria-controls` id actually resolves.
- Edge cases / failure handling: "routes each row write to its role" (line 84-95) checks the closure binding: the terminal font row calls `setFontFamily('terminal', '"Hack"')` and the code size stepper calls `setFontSize('code', 12)`.
- Surprising: The spec is 96 lines for a component that renders three sub-components — the value is in the assertions about *identity* (the id resolves, the region is absent, each row keeps its role).

### packages/client/ui-theme/tests/font-size-row.client.spec.tsx
- Purpose: The stepper's behaviour.
- Key abstractions: The same full standard-kit fixture.
- Data flow: A real font store; arrow clicks.
- Non-obvious design decisions: The bounds are tested per role: mounting at 21 and stepping to 22 disables the up arrow, mounting at 11 and stepping to 10 disables the down arrow (line 94-110) — the *terminal* role is mounted at 20 and its up arrow is already disabled (line 113-118), proving the ranges are role-specific rather than global.
- Edge cases / failure handling: As in the appearance row, the display is asserted to be *unchanged* immediately after a click (line 86-88) — the row is a pure function of the store mirror.
- Surprising: The fixture's `store.actions.sync({ text: 14, code: 11, terminal: 13, [role]: fontSize }, …)` (line 51) uses a computed key to override one role — a compact way to parameterise a three-role component.

### packages/client/ui-theme/tests/menu-surfaces.client.spec.ts
- Purpose: Menu material ownership — every menu renderer must use the shared `MenuSurface`.
- Key abstractions: A TypeScript-compiler-API AST walk (`ts.createSourceFile(..., ts.ScriptKind.TSX)`) that finds `role="menu"` / `role="listbox"` JSX attributes not inside a `<MenuSurface>`.
- Data flow: Walks every `packages/*/*/src/**/*.tsx` and every package stylesheet.
- Non-obvious design decisions: The check is done on the **AST**, not on text: "a `>` inside a prop expression or an attribute value does not end the tag" is handled by the compiler API for free, and the "inside a MenuSurface" test tracks the ancestor chain. The allowed exceptions are named explicitly (line 67-70): `ui-schedule/ClockPicker.tsx: listbox` and `ui-schedule/TaskMenu.tsx: menu` — the expected list *is* the assertion, so a new violation and a removed exception are both failures.
- Edge cases / failure handling: A second check (line 82-104) reads the `className` prop of each `<MenuSurface>` usage, resolves the imported stylesheet, and asserts the consumer's own sheet never declares `background`, `background-color`, `backdrop-filter` or `anchor-name` for those classes — so a consumer cannot quietly replace the shared material.
- Surprising: The last test (line 106-113) enforces *token ownership*: `--dsw-specific-menu` and `--dsw-menu-surface-fill` may only be declared in `ui-theme/src/styles/design-platform.css`, and `--dsw-menu-backdrop-filter` only in `gradient-shadow-text.css`. A cross-package rule enforced by a file-path allowlist.

### packages/client/ui-theme/tests/radius-styles.client.spec.ts
- Purpose: The radius contract — component radii must come from the shared scale.
- Key abstractions: `unscaledRadii(css)` — a detector for a finite px radius between 4 and 99, or a reference to a radius token that `base.css` does not define.
- Data flow: Reads `base.css` for the token set, then every client package stylesheet outside `src/styles/`.
- Key abstraction detail: The token set is *read from the sheet*, not hard-coded, so a new radius token is in scope the moment it exists. A misspelled token (`var(--dsw-radius-missing)`) is also caught (line 35).
- Edge cases / failure handling: `2px`, `50%` and `999px` are all accepted (line 37) — small drawing details and full-round shapes are exempt; two named drawings (`TurnNavigator.module.css .mark` and `TrajectoryToolbar.module.css .controlTrack`) are exempt by suffix.
- Surprising: The two exemptions are *in the test file*, not in a shared list, and the second half of the test compares the computed failures with `radius-exceptions.expected.json` for **equality** — so the exception file is a complete, reviewable statement of every deviation in the repository.

### packages/client/ui-theme/tests/scrollbar-styles.client.spec.ts
- Purpose: The scrollbar contract, and the palette-derived elevated-surface check.
- Key abstractions: `tokensRendered(rules)` (a transitive walk of custom-property definitions), `elevatedRungs()` (resolves the palette's dark layer ladder), `SheetSurfaces` (per-file: elevated tokens, scrolls?, rebindsElevation?).
- Data flow: Parses `design-platform.css` and `scrollbar.css` and every package stylesheet.
- Non-obvious design decisions: **The important idea is in `elevatedRungs` (line 153-185)**: the set of "elevated surfaces" is derived **from the palette** (the dark values of `--dsw-alias-bg-layer-2` and `bg-layer-3`), not from the sheets that happen to rebind. The comment (line 482-489) states the failure this closes: "The set has to come from the palette, not from the sheets that happen to rebind: derived from rebinds it can only confirm what someone already remembered, and a surface nobody has rebound yet — the case the check exists for — would define itself as unelevated. `--dsw-specific-tip` is the regression that proved the point: it resolves to the same dark rung as the input surface, and the Todo panel scrolled on it unrebound while a rebind-derived set stayed green." The translucent menu is added explicitly because its alpha colour has no rung.
- Edge cases / failure handling: The surface-level check (line 501-520) is deliberately surface-level, not element-level, because "the elevated card and the descendant that actually scrolls are separate rules in the same sheet, and CSS text does not say which contains which" — over-reporting is prevented by the *token family* rule (`--dsw-alias-bg-*` and `--dsw-specific-*` name surfaces; `--dsw-alias-button-*` and `--dsw-alias-markdown-*` do not). And the gate check (line 380-397) asserts, by byte offset, that every occurrence of `scrollbar-width`/`scrollbar-color` lies *inside* the `@supports not selector(::-webkit-scrollbar)` block.
- Surprising: The spec also asserts the *token-consumption* direction (line 241-254): every scrollbar token `design-platform.css` defines must be referenced by some stylesheet, and every referenced token must be defined — "A dangling var() renders the UA default instead of failing loudly, so a rename has to move the reference and the definition together."

### packages/client/ui-theme/tests/settings-store.client.spec.ts
- Purpose: The two row stores' init shape, sync semantics and revision guard.
- Key abstractions: `createAppearanceRowStore()` / `createFontRowStore()` and their `sync` actions.
- Data flow: Direct store calls; no React.
- Non-obvious design decisions: The init shape is asserted exactly (line 8, 33) — `{ preference: 'system', revision: -1 }` and `{ fontSizes: {text:14,code:11,terminal:13}, fontFamilies: {text:'',code:'',terminal:''}, revision: -1 }` — so the *default* is part of the contract.
- Edge cases / failure handling: "revision guard drops stale and duplicate writes" (line 20-27): a sync at revision 3 then revision 2 then revision 3 leaves the state at revision 3 — the guard is `revision <= d.revision`, so an equal revision is also dropped.
- Surprising: 47 lines pin the entire mirror protocol; without this the row components would have to defend against out-of-order events themselves.

### packages/client/ui-theme/tests/stylesheet-scan.ts
- Purpose: Shared helpers for the stylesheet-contract specs.
- Key abstractions: `CssRule {selectors, declarations}`; `parseRules(css)`; `atRuleBlock(css, prelude)`; `varReferences(value)`; `packageFiles(accepts)` / `packageStylesheets()`.
- Data flow: Reads the CSS text off disk with `node:fs` and walks `packages/` with `readdirSync`.
- Non-obvious design decisions: The parser is a deliberate **regex-based flattener**, not a CSS parser, and the doc says why: "Whitespace, declaration order, and trailing semicolons are normalized away; nesting is not handled, which no sheet under test uses, and at-rule preludes surface as selector-less rule boundaries." `packageFiles` excludes `node_modules`, `lib` and `dist` and normalises path separators to `/` — the comment in the scrollbar spec records that this matters: "match them with the same separator or the exclusion silently stops applying on Windows."
- Edge cases / failure handling: `atRuleBlock` tracks brace depth and throws "unbalanced braces after <prelude>" rather than returning a partial span.
- Surprising: The helper is a *shared* module used by six spec files across the shard, and it is the reason the cross-package checks are cheap enough to run on every change.

### packages/client/ui-theme/tests/theme.client.spec.ts
- Purpose: The `ThemeRuntime` service's behaviour.
- Key abstractions: `make()` builds a `Context`, a `ThemeRuntime` over a stubbed config form, and an event log; `stubMedia` stubs `matchMedia` with a controllable `flip()`.
- Data flow: Service calls in, `theme/change` events out; the host scope is a mock.
- Non-obvious design decisions: (1) The spec asserts the service **never touches the DOM** (line 140: `expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)`). (2) It asserts the boot-script read-back: `--dsh-content-font-size: 22px` is honoured, `23px` is rejected as junk and falls back to 14 (line 36-47). (3) It asserts the pending-write convergence (line 157-170): a Host echo during a pending write must not revert the local change, and once the write settles the durable section is adopted.
- Edge cases / failure handling: "rejects out-of-range and fractional font sizes" (line 60-67) includes `Number.NaN` — and asserts that *no* event and *no* write happened, not merely that it threw. The override validator is exercised with five malformed shapes (line 295-304), each expected to throw a specific message.
- Surprising: The media-query tests stub `matchMedia` **globally** with `vi.stubGlobal` and restore it in `afterEach`, and the "OS flips do not republish while a concrete preference is set" case (line 343-351) proves the service does not churn on irrelevant environment events.

### packages/client/ui-theme/tsconfig.client.json
- Purpose: The browser half's project config.
- Key abstractions: `extends ../../../tsconfig.base.client.json`; `exclude: ["src/index.ts"]`.
- Data flow: tsc project graph — nine references including `../ui-slots`, `../shortcuts`, `../ui-settings`, `../store` and the host webserver project.
- Non-obvious design decisions: The host half is *excluded* from the client project, so the two halves cannot accidentally import each other's modules; the shared `theme-settings.ts` is compiled by both.
- Edge cases / failure handling: n/a.
- Surprising: `../../host/webserver` is referenced from a *client* project — because the boot-theme types (`IndexInjection`) cross the boundary.

### packages/client/ui-theme/tsconfig.host.json
- Purpose: The host half's project config.
- Key abstractions: `files: ["src/boot-theme.ts", "src/index.ts", "src/theme-settings.ts"]` — an explicit file list, not an `include` glob.
- Data flow: tsc project graph — `vendor/cordis`, `vendor/schemastery`, `../../host/webserver`, `../../settings/settings`.
- Non-obvious design decisions: The explicit `files` list means the host half *cannot* accidentally grow a dependency on the browser half: any new host file must be added to this list.
- Edge cases / failure handling: n/a.
- Surprising: `src/theme-settings.ts` is compiled by **both** projects — the shared contract is the one file both halves own.

### packages/client/ui-theme/tsconfig.json
- Purpose: The solution file.
- Key abstractions: `files: []` with two project references.
- Data flow: the tsc build graph root.
- Non-obvious design decisions: A solution file with no files of its own is the pattern that lets one package have two independent compilation units with different `extends` bases.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/client/ui-theme/tsdown.config.ts
- Purpose: The bundler config, including the font copy step.
- Key abstractions: `clientBundle(import.meta.dirname, ['lib/types/index.js'], { lib: { copy: [{ from: 'src/styles/{brand-font.css,montserrat-*.woff2,Montserrat-OFL.txt}', to: 'lib/styles' }] } })`.
- Data flow: tsdown emits `lib/index.js`, `lib/client.js` and copies the font assets into `lib/styles`.
- Non-obvious design decisions: The copy step is part of the *bundler* config, not a separate script — the font is a build output of the package, and `package.json`'s `files` and `exports` then publish it.
- Edge cases / failure handling: The glob `montserrat-*.woff2` and the explicit `Montserrat-OFL.txt` are listed separately because the license's capitalisation does not match the lowercase glob.
- Surprising: `clientBundle` (not `staticLinked`) is used here — the theme's client half is a separate bundle from the shell, because the Host half must be loadable in Node.

---

## Ideas worth stealing

- **Server-render the user's preference into the first HTML frame, then have the client read it back instead of re-deriving it** — `packages/client/ui-theme/src/boot-theme.ts:19` (head CSS), `packages/client/ui-theme/src/boot-theme.ts:28` (body script), `packages/client/ui-theme/src/client/index.ts:430` (`bootstrapFontSizes` reads the variable the boot script wrote). The mechanism: the Host embeds a `<style>` that decides the canvas colour *before any script runs* (including a `prefers-color-scheme` media query for the `system` preference), and a body script that sets `data-ds-dark-theme` plus the font-size variables. The browser service then **reads those variables back** to seed its first snapshot, so it never renders the defaults first. *Why it transfers to August*: the same shape applies to any August surface whose first paint is wrong before hydration — read the boot-time value the server already wrote instead of re-fetching and re-deriving it.

- **A pending-write counter that makes a settings echo unable to revert a newer local change** — `packages/client/ui-theme/src/client/index.ts:305` (`write`) and `packages/client/ui-theme/src/client/index.ts:314` (`adopt`). The mechanism: every durable write increments `pendingWrites`; `adopt()` — the function that reads the authoritative section — returns early while `pendingWrites > 0`. When the last write settles, the durable section is adopted. *Why it transfers*: August's own settings/config writes race the same way (a pushed change or a reconnect refetching a namespace can arrive while a write is in flight and clobber it). One counter and one early-return removes the whole class of "my change reverted itself".

- **One durable write for a multi-field change, and only the fields that actually changed** — `packages/client/ui-theme/src/client/index.ts:272` (`adjustFontSizes`) and `packages/client/ui-theme/tests/apply.client.spec.ts:142` (the exact payload assertion). A single keypress that changes three font sizes issues one `host.mutate([...])` with three `set` ops and produces one `theme/change`. *Why it transfers*: August's turn-level config edits have the same shape — a batch is one write, and the partial-batch case (one role already at its limit) is covered by "skip the unchanged field" rather than by a second write.

- **A token override layer with a mandatory per-scheme pair, and a *teaching* error instead of a coercion** — `packages/client/ui-theme/src/client/index.ts:466` (`validateOverrides`) and `packages/client/ui-theme/src/client/index.ts:369` (`overrideTokens`). A bare-string override throws with the reason ("a single value goes illegible when the user switches color scheme") and the fix spelled out. The layer is per-source, stacked by a monotonic sequence, later layers winning per token, and the disposer is identity-checked so a stale disposer cannot tear down a newer layer. *Why it transfers*: this is exactly the shape of August's per-package capability/permission overlays and theme-like configuration; the identity-checked disposer and the defensive per-token copy are the two details that prevent a "dispose the old thing" bug.

- **A slot registry where declaring a slot *is* claiming it, validated at load, with one lifecycle axis** — `packages/client/ui-slots/src/index.ts:110` (the `SlotEntryDef` doc), `packages/client/ui-slots/src/index.ts:1209` (the undeclared-slot throw), `packages/client/ui-slots/src/index.ts:1590` (`releaseEntry`) and `packages/client/ui-slots/src/index.ts:1598` (`releaseChildren`). One table carries declaration = render authorisation = runtime spec; a disposer removes the contribution *and* recursively collapses every child slot, clearing specs and contributions so stale disposers become no-ops. *Why it transfers*: August's plugin/tool surface has the same need — an extension point that is claimed by exactly one registrant, whose removal takes its whole subtree with it, and whose misconfiguration fails at load rather than at first use.

- **Crash supervision that retires the broken actor without killing the system** — `packages/client/ui-slots/src/index.ts:1545` (`reportEntryError`). A crashed shadowing entry is retired from its cell *one-shot* so the next survivor renders; a chain entry does not abdicate because "election alternatives resolve at select time"; the registration stays on the ledger so its disposer keeps working. *Why it transfers*: this is the shape August's harness needs for a plugin/tool that throws — isolate the failure, keep the rest of the composition alive, and do not let the crashed party's own cleanup become a second failure.

- **Version bumped synchronously, notification batched per microtask** — `packages/client/ui-slots/src/index.ts:1650` (`markDirty`) and the rationale at `packages/client/ui-slots/src/index.ts:1508`. `rec.version += 1` and the mutation callback fire immediately; the `subscribe` listeners are flushed once per microtask. The comment states the reason exactly: "bumped synchronously per mutation so a uSES getSnapshot read is never stale when its batched notification lands." *Why it transfers*: any `useSyncExternalStore` source in a React client has this exact hazard, and the fix is one line that is easy to get wrong (batching the version bump instead of the notification makes the snapshot read stale).

- **A declaration epoch distinct from an entry version** — `packages/client/ui-slots/src/index.ts:1474` (`declarationEpoch`) and `packages/client/ui-slots/src/index.ts:1608` (the collapse bumps it). Entry additions and removals do not change the epoch; declaration creation and collapse each advance it. *Why it transfers*: it is the difference between "the content changed" and "the container was replaced" — the same distinction August needs when a plugin is reloaded under HMR versus when its state changes.

- **Optimistic concurrency as a UI protocol, not a lock** — `packages/client/ui-shortcuts/src/client/Editor.tsx:46` (`stale = revision !== config.revision`), `packages/client/ui-shortcuts/src/client/Editor.tsx:69` (the write is refused with a "stale" diagnosis) and `packages/client/ui-shortcuts/src/client/Editor.tsx:159` (the "I have reviewed the latest configuration" affordance). A write carries the revision the user was shown; if the configuration moved, the write is refused, the draft is *kept*, and the user is asked to re-review. *Why it transfers*: August's config writes and the harness's "the user must re-approve after the plan changed" flows are the same protocol, and the "keep the draft, ask for a re-review" UX is strictly better than a silent discard.

- **Repeated identical errors must not restart the toast timer** — `packages/client/ui-shortcuts/src/client/Reference.tsx:89` (`notify`) and its proof at `packages/client/ui-shortcuts/tests/reference.client.spec.tsx:346`. `if (error && previous?.error && previous.text === text) return previous` — the same error keeps the *same* toast element (and therefore its dismissal deadline), while a different error or a success replaces it immediately. *Why it transfers*: any August UI that surfaces transient failures (a tool refusal, a rate-limit notice) should not make a repeating problem look like a stream of new events; the audit-trail distinction between "still the same failure" and "a new failure" is worth carrying.

- **Product order that is data, not registration order** — `packages/client/ui-shortcuts/src/client/Reference.tsx:26` (`coreActionOrder`) and the proof at `packages/client/ui-shortcuts/tests/reference.client.spec.tsx:175` (the catalog is fed **reversed** and the rendered order is identical, in Chinese labels too). *Why it transfers*: a harness that shows a list of capabilities (tools, skills, sessions) needs a stable product order that survives plugin load order, unload and remount — and a test that proves it by reversing the input.

- **A subsequence search that finds a command by label, alias, or key, on any platform** — `packages/client/ui-shortcuts/src/client/Reference.tsx:139` (the name list per row) and `packages/client/ui-shortcuts/src/client/Reference.tsx:146` (`rankByName` + de-duplication). Each row contributes its label, its English aliases, and the key combination rendered several ways (`⌘+/`, `⌘/`, `Meta+/`, and `Meta+`→`Cmd+`), so "cmd+/" finds the row on macOS and "control+/" finds it on Windows, with no per-platform index. *Why it transfers*: a harness's tool-search palette wants exactly this — one query finds a tool by any of its names, and each tool appears once.

- **A cross-package CSS contract gate that reads every stylesheet in the repository** — the shared helper `packages/client/ui-theme/tests/stylesheet-scan.ts:25` (`parseRules`) and the four gates built on it: `packages/client/ui-theme/tests/scrollbar-styles.client.spec.ts:501` (every sheet that scrolls on an elevated surface must rebind), `packages/client/ui-theme/tests/elevation-styles.client.spec.ts:168` (no neutral border beside an elevation shadow), `packages/client/ui-theme/tests/radius-styles.client.spec.ts:40` (local radii rejected against an exact exception list), `packages/client/ui-theme/tests/corner-shape-styles.client.spec.ts:83` (every full-round radius pairs `corner-shape: round`). *Why it transfers*: this is the "design system as an executable contract" pattern, and it is exactly the shape of August's `check:truncate` / `check:sse` static gates — a rule that no unit test can see, enforced by scanning the tree.

- **Derive the check's scope from the *authority*, not from the current state** — `packages/client/ui-theme/tests/scrollbar-styles.client.spec.ts:160` (`elevatedRungs`). The set of "elevated surfaces" is computed from the palette's own dark layer ladder (`bg-layer-2`, `bg-layer-3`), not from the stylesheets that happen to rebind. The comment names the exact regression: a set derived from rebinds "can only confirm what someone already remembered, and a surface nobody has rebound yet — the case the check exists for — would define itself as unelevated." *Why it transfers*: any August static gate that enumerates "the things that must be X" should enumerate them from the authority (the schema, the manifest, the palette), not from the current conformers — otherwise the gate is green precisely when it should be red.

- **A type-level test suite with no runtime assertions** — `packages/client/ui-slots/tests/type-chain.client.spec.tsx:234` (the negatives) and the header at line 1-4 ("Bodies with @ts-expect-error sites never run"). ~25 `@ts-expect-error` sites pin the composed-props contract: children spec vs SlotMap, `renderSlot` key set ⊆ children declaration, "children declared but the component consumes no renderSlot", store share mismatch, inject face completeness, root-scope inject taking no `sessionId`, and the `matched` prop drifting from the selector's return. *Why it transfers*: any August API whose value is a *type* contract can be pinned this way at zero runtime cost, and the negative cases can be chosen to be the silent mistakes (a scope mismatch, a widened `matched`) rather than the obvious ones.

- **A contravariant phantom anchor to make a real constraint enforceable** — `packages/client/ui-slots/src/index.ts:387` (`readonly __renders?: ((key: S) => void) | undefined`) with the explanation at line 371-375: "generic method signatures compare loosely across key unions, so this contravariant marker is what actually enforces 'component key set ⊆ children declaration' at the register call site." *Why it transfers*: a named, documented phantom field is a legitimate way to turn an unenforceable structural check into a compile error — and the doc comment makes the trick discoverable.

- **A boot script that cannot be broken out of, and a normaliser that makes that true** — `packages/client/ui-theme/src/theme-settings.ts:163` (`normalizeFontFamily`) with the proof at `packages/client/ui-theme/tests/boot-theme.client.spec.ts:91` (a font list containing `</script>` produces a script with no `<` in it) and `packages/client/ui-theme/src/boot-theme.ts:35` (every interpolated value goes through `JSON.stringify`). *Why it transfers*: any August surface that interpolates user-supplied text into a script tag or inline style needs exactly this — a normaliser at the boundary plus `JSON.stringify` at the emission site.

- **The service never touches the DOM; the presenter applies the snapshot** — `packages/client/ui-theme/src/client/index.ts:154` (the class doc: "it never touches the DOM — ui-layout's presenter consumes the resolved snapshot") and the assertion at `packages/client/ui-theme/tests/theme.client.spec.ts:140` (`document.body.hasAttribute('data-ds-dark-theme')` is `false` after `setTheme`). *Why it transfers*: a direct application of separation of state and presentation — the theme service is unit-testable with no DOM at all, and the DOM-touching layer is a separate, thin presenter.

- **A focus ring that names the colour and the width but never the style** — `packages/client/ui-theme/src/styles/focus.css:10` with the reason at line 6-9: a control that disables its outline keeps `none` and paints nothing, and a control that declares no ring keeps the standard geometry instead of Chromium's `auto 1px`. The companion rule (line 18) suppresses the ring in pointer modality *without* clearing `box-shadow`, and the gate at `packages/client/ui-theme/tests/focus-ring-styles.client.spec.ts:28` makes the suppression unbypassable by rejecting any `:focus-visible` rule that names the accent directly instead of the ring token. *Why it transfers*: August's desktop/web UI will have the same focus-ring problem, and the "declare a token, not a colour" rule is what makes a global modality switch possible at all.

- **Focus suppression that survives a class rewrite and restores itself on the next keyboard event** — `packages/client/ui-theme/src/styles/base.css:36` (`[data-dsh-automatic-focus]:focus, [data-dsh-automatic-focus]:focus:focus-visible { outline: none; }`) with the behavioural proof at `packages/client/ui-theme/tests/focus-styles.client.spec.ts:24` and the non-consumption proof at line 37. *Why it transfers*: the same "move focus without painting a ring" need exists wherever a harness focuses a control programmatically (a search field, a toast, the first input of a form) — and the two traps (a class update re-arming the outline; the suppression eating the user's keystrokes) are both covered by tests.

- **An exact exception list as a reviewable artifact, compared with equality** — `packages/client/ui-theme/tests/expected/radius-exceptions.expected.json` and the comparison at `packages/client/ui-theme/tests/radius-styles.client.spec.ts:50` (`expect(failures).toEqual(exceptions)`). The file is not a suppression list; it is a complete statement of every deviation in the tree, and adding a new deviation fails until the file is updated. *Why it transfers*: this is the right shape for August's "known exceptions" files — a diffable, reviewable, complete list rather than a set of `skip` markers.

- **A token-consumption check in both directions** — `packages/client/ui-theme/tests/scrollbar-styles.client.spec.ts:241` (every defined token is referenced by some stylesheet) and line 248 (every referenced token is defined). The comment on the second is the reason to have it: "A dangling `var()` renders the UA default instead of failing loudly, so a rename has to move the reference and the definition together." *Why it transfers*: August has the same dangling-reference hazard in its CSS and in its configuration keys; a bidirectional check turns a silent visual regression into a red build.

- **A bilingual README gate that hashes per heading section** — `packages/client/ui-shortcuts/README.i18n.yaml:5` (the record) and the regeneration command in its header. *Why it transfers*: any August artefact that must exist in two languages (a prompt template, a settings description, an error message catalogue) can be pinned by a per-section hash record so a one-sided edit fails a gate.

- **A shared, per-package *injected observable* face that becomes a typed Hook by naming convention** — `packages/client/ui-slots/src/renderer.ts:42` (`standardHookPropName`) and `packages/client/ui-slots/src/index.ts:561` (`PropsSlotHooks`: each source named `name` becomes `use${Capitalize<name>}`). A plugin declares `hooks: { catalog, config, fixedCatalog }` and the component receives `useCatalog`, `useConfig`, `useFixedCatalog` — no boilerplate, no manual binding, and the name mapping is code rather than a convention. *Why it transfers*: the August web/desktop client (and any plugin API) can hand a plugin a typed set of reactive sources for free with this exact pattern.

---

## Files skipped (with reasons)

- `packages/client/ui-theme/src/styles/montserrat-light.woff2` — a binary WOFF2 webfont (61,548 bytes). I read its first four bytes and confirmed the WOFF2 signature `0x774f4632` ("wOF2"), and `brand-font.css:13-17` shows it is the `font-weight: 300` face of the Montserrat family referenced by `--dsw-font-family-brand`. It is a compressed font binary with no line structure, so it was not read line by line.
- `packages/client/ui-theme/src/styles/montserrat-medium.woff2` — the same, for `font-weight: 500` (`brand-font.css:18-24`); 62,148 bytes, WOFF2 magic confirmed.
- `packages/client/ui-theme/src/styles/montserrat-regular.woff2` — the same, for `font-weight: 400` (`brand-font.css:2-9`); 62,008 bytes, WOFF2 magic confirmed.

No other file in the shard was skipped. All 91 other files were opened and read.

---

## Uncertainties

- **The clone's own build/test state is unknown.** I read and grepped only; I did not run anything, so every behavioural claim in this report comes from the source, the comments and the specs, not from an execution. Where a spec asserts something, I report it as "the spec asserts", not as "it does".
- **I could not see `dsh-client-shortcuts` (the service behind `ui-shortcuts`) or `dsh-client-ui-renderer` (the React implementation of `ui-slots`), because they are other shards' files.** Several mechanisms in this shard are only half-visible from here: the `ShortcutBinding` normalisation and the `overlappingBindings` conflict rule live in `dsh-client-shortcuts/protocol`; the `renderSlot` / `renderSlotChain` implementation, the `ctx.slots.inject` choreography and the `useStore` binding live in `dsh-client-ui-renderer`. I read the *contract* in `packages/client/ui-slots/src/renderer.ts` and the *call sites* in this shard's specs, and quoted the contract's own documentation, but I did not read the implementation and make no claim about it.
- **`ui-layout`'s `ThemePresenter` is the DOM-writing half of the theme system and is not in this shard.** The README states that ui-layout applies each snapshot to the document; the presenter itself is elsewhere. The claim "the service never touches the DOM" is therefore true for `ThemeRuntime` (asserted in `theme.client.spec.ts:140`) but I have not read the presenter.
- **`--dsw-focus-ring-color` is never *defined* anywhere under `packages/client` — only read.** I grepped every client package for `4176E6|7AAAFF|dsw-focus-ring-color` and got 111 hits, of which the two hex values appear *only* in the two READMEs (`packages/client/ui-theme/README.md:66` and `README.zh.md:66`); every stylesheet hit is a *read* of `var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))`, and `focus.css:19` is the only place that ever *sets* it (to `transparent`, for pointer modality). So the token is a **reserved override point that no package currently sets**, and the ring colour that actually renders is the fallback `--dsw-alias-state-business-primary` — which `design-platform.css:240` binds to `--dsw-static-deepseek-500` = `rgb(65, 118, 230)` = `#4176E6` in light and `design-platform.css:358` binds to `--dsw-static-deepseek-400` = `rgb(122, 170, 255)` = `#7AAAFF` in dark. The README's two numbers are therefore exactly the fallback's resolved values, not a separate binding. I state this because the README reads as if a separate binding exists.
- **The `elevation-styles` and `scrollbar-styles` specs assert facts about other packages' stylesheets** (e.g. `ui-primitives/MenuSurface.module.css`, `ui-conversation/.../ConversationRoot.module.css`, `ui-sidebar`). Those files are not in this shard; I read only the *specifications* of them, not the sheets themselves, so I can report what the gate demands but not whether each named consumer currently complies (the spec asserts it does, and the gate is presumably green, but I did not verify).
- **`ui-theme/tests/apply.client.spec.ts` imports from `../../shortcuts/src/client/registry.ts`** — a cross-package source import into a package that does not declare it as a dependency. I read the import and the usage; I did not read the registry, so I cannot say whether that cross-boundary import is intentional or a leak. The same file imports `SlotRegistry` from `@deepseek-ai/dsh-client-ui-renderer/client`, which *is* a declared devDependency, so the `shortcuts` import is the odd one out.
