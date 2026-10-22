# deepseek-harness / dsh-client-settings#1

## Shard shape

This shard is the **browser-side settings surface of the DeepSeek Harness web/desktop client** — four sibling Cordis plugin packages under `packages/client/`: `ui-settings` (the domain base: one shared mirror of the Host settings document, namespace-scoped config forms with revision-fenced writes, a settings schema service, and the canonical `settings.*` slot-type contract), `ui-settings-general` (the settings shell: sidebar trigger, modal panel, section navigation, connection-recovery indicator, Desktop update indicator, Host-release-change prompt, and the "open configuration file" action), `ui-settings-account` (DeepSeek login state, Platform billing/top-up, the account sidebar menu, the bonus-notice lifecycle, the quota-notice take-over, and the resumable Desktop onboarding flow), and `ui-settings-agent-loop` (the one official plugin page that edits the agent loop's `agent-loop` namespace — the parallel-safe tool-call cap). They fit together as a strict layering: `ui-settings` owns the *contract* (slot types, transport, schema), `ui-settings-general` owns the *shell chrome*, the two feature packages own their *content*, and every cross-package collaboration goes through Cordis services (`ctx.configForms`, `ctx.settingsSchema`) rather than value imports — enforced by a "client bundle purity" gate. None of these packages assembles or sends a provider request: every README in the shard states "Model Experience: None" and "KV Cache effect: None", so this shard is entirely about **configuration correctness, UI/UX polish, and progress feedback**, with the single agent-loop-relevant surface being the parallel tool-call cap.

---

## Per-file notes

### packages/client/ui-settings

#### packages/client/ui-settings/README.md
- Purpose: package reference for the settings domain base plugin.
- Key abstractions: `ctx.configForms` (per-namespace forms + a shared describe face), `ctx.settingsSchema`, the `settings.*` slot family.
- Data flow: a feature calls `ctx.configForms.get(entryId)` → the controller derives from the shared mirror → `set`/`unset`/`mutate` queue one serialized Host write → the write answer folds back into the mirror.
- Non-obvious design decisions: the shell renders **no interface at all** in this package; adding a setting never means editing the shell. Cross-namespace surfaces read the same mirror through `ctx.configForms.describe()` so "any moment in time shows the same document revision".
- Edge cases / failure handling: refused writes trigger a Host re-read; `settings.describe.writable` is the authority on whether a write is accepted.
- Surprising: the package "renders no interface itself" yet is the canonical home of every settings slot type — the contract is owned by the base, the chrome by the shell.

#### packages/client/ui-settings/README.zh.md
- Chinese mirror of the English README; same sections, same normative claims ("未组合所有者的部署看不到该页面的任何痕迹" — a deployment that never composed the owner shows no trace of the page).

#### packages/client/ui-settings/README.i18n.yaml
- Per-heading-section hashes of the English and Chinese README blocks, produced by `pnpm run verify-translation-pairing --write`; a machine-checked bilingual pairing record, not prose.

#### packages/client/ui-settings/package.json
- Manifest for `@deepseek-ai/dsh-client-ui-settings`; `dsh.client.inject: ["@deepseek-ai/dsh-api-remotes"]` and `platform: "web"`; exports `.`, `./client`, `./src/*`, `./package.json`, `./locale/*.json`.

#### packages/client/ui-settings/locale/en.json
- Package-level locale metadata only (`{"meta":{"title":"ui-settings"}}`); the real copy lives in the code dictionaries and in `dsh-client-locale`.

#### packages/client/ui-settings/locale/zh.json
- Chinese package-locale metadata: title "设置界面框架", description "提供设置页面的基础表单和插件扩展位置。".

#### packages/client/ui-settings/tsconfig.json
- Solution file with two project references (`tsconfig.host.json`, `tsconfig.client.json`); `files: []` — no files of its own.

#### packages/client/ui-settings/tsconfig.client.json
- Client project: `include: ["src"]` but `exclude: ["src/index.ts"]`, so the Host half of the package is not compiled into the browser graph.

#### packages/client/ui-settings/tsconfig.host.json
- Host project: only `src/developer-tools-settings.ts` and `src/index.ts` — the two files that may import `schemastery` and the `settings` service.

#### packages/client/ui-settings/tsdown.config.ts
- Three-line bundle config: `clientBundle(import.meta.dirname, ['lib/types/index.js'])`, shared by every client package in the shard.

#### packages/client/ui-settings/src/index.ts
- Host registration of the shared developer-tool preference: `Config = z.object({ enabled: DeveloperToolsSettingsFields['enabled'].volatile() })`, and `apply` calls `child.settings.configure({ auto: false }, ctx.fiber)` so the Host does not auto-generate a settings page for it.
- Non-obvious: `auto: false` is why the browser owns the Settings presentation for this entry.

#### packages/client/ui-settings/src/developer-tools-settings.ts
- The `ui-settings` namespace constant, the `DeveloperToolsSettings` interface (`enabled: boolean`) and its schemastery field (`z.boolean().default(true)`).
- Non-obvious design decision: "New installations and missing values enable the full interface" — the default is ON, so developer features are not opt-in for a fresh install.

#### packages/client/ui-settings/src/css-modules.d.ts
- Ambient declarations for `*.module.css` and `*.css`; six lines, boilerplate.

#### packages/client/ui-settings/src/client/index.ts
- Browser half: creates `SettingsSchemaService`, the one `SettingsDescribeMirror`, and the `ConfigForms` service; subscribes the mirror to `settings/document-updated` and `connection/reset`.
- Data flow: every invalidation triggers `mirror.load()`; `ConfigForms` is the only public face.
- Non-obvious design decisions: a long comment (lines 12-27) explains that the package must import `@deepseek-ai/dsh-api-remotes` **type-only** because api-remotes' Client face imports a Host-tsdown-generated `/remote` artifact and would "deadlock the Host tsc phase". The `inject` list is `['remote', 'remote.settings']` only.
- Edge cases: the comment at line 46-49 admits startup normally costs **two** describes (the eager `ensure` plus the first connection's `connection/reset`) and says the in-flight fold does not merge them — it only guarantees "at most one pending read at a time and that no invalidation arriving mid-read is lost".

#### packages/client/ui-settings/src/client/settings-mirror.ts
- Purpose: the single `settings.describe` reader in the browser; every settings consumer derives from this store.
- Key abstractions: `SettingsDescribeMirror` (implements `SettingsDescribeFace` = `getSnapshot`/`subscribe`/`ensure`/`acceptView`), `SettingsMirrorSnapshot` with `status: 'idle' | 'loading' | 'ready'`.
- Data flow: `load()` → `run()` → `ctx.remote.settings.describe()` → fold into a `SnapshotStore`; `acceptView(view)` folds a **write answer** in without a wire read.
- Non-obvious design decisions (all with stated reasoning):
  - `load()` while a read is in flight sets `rerun = true` and returns the *same* promise (line 112) — "Concurrent load calls fold into the in-flight read plus one rerun, so an invalidation arriving mid-read is never lost and never duplicated."
  - The in-flight slot is taken with `Promise.resolve().then(() => this.run())` (line 116) *before* the loading publication, so a synchronous re-entrant `load()` cannot race a second wire read.
  - `this.rerun = false` is cleared **immediately before** the wire read goes out (line 171): a load marked earlier is covered by that read, one landing after needs the rerun.
  - A `generation` counter fences stale reads (line 183): `if (generation !== this.generation) continue` — "A write answer invalidates a document read before that write committed."
  - The comment at lines 159-162 explains a specific regression: clearing the in-flight slot in a promise `.finally()` runs one microtask later, and a `load()` landing in that gap would "mark a rerun nobody reads, losing the read".
- Edge cases / failure handling: a failed refresh keeps the last good view and records the error (lines 186-194); with **no** prior view it falls back to `idle` so `ensure()` retries. `acceptView` before any answer is a no-op — it refuses to publish a partial document.
- Surprising: `ready` persists across later failed refreshes; the held view keeps serving and only the `error` field reports the miss.

#### packages/client/ui-settings/src/client/config-form.ts
- Purpose: one namespace's derived view over the shared mirror plus that namespace's serialized Host writes.
- Key abstractions: `ConfigFormController<T>` (implements `ConfigForm<T>`), `ConfigForms` (the Cordis service, `ctx.configForms`), `ConfigFormSpec` (namespace + optional narrowing `decode`).
- Data flow: the controller subscribes to the mirror and re-derives on every mirror change; `mutate(ops, expectedRevision?)` → `enqueue` → `ctx.remote.settings.mutate(namespace, ownedOps, revision)` → fold the answer back with `mirror.acceptView`.
- Non-obvious design decisions:
  - `structuredClone(ops)` at line 130 — the operation list is copied when queued, so a caller mutating its array afterwards cannot change a queued write.
  - The revision fence is `expectedRevision ?? this.pendingRevision ?? this.getSnapshot().revision` (line 133) — a staged editor's own earlier revision wins, otherwise the latest known revision.
  - Only the **latest** write publishes (`generation === this.writeGeneration`, line 140); a superseded write instead stores its answer's revision in `pendingRevision` so the queued successor takes its fence from there (line 144).
  - A refused write triggers `recover(generation)` → `mirror.load()`; a *superseded* failure does not recover (line 152).
  - The write queue tail is kept fulfilled: `this.tail = task.then(() => {}, () => {})` (line 177) — "one failed subscriber cannot strand later operations".
  - `decode` refuses non-object sections (line 210) because "schemastery alone would resolve null or an array through object defaults instead of refusing", and treats an unrehydratable schema envelope as vouching for **no** section (lines 213-217).
  - The service keeps the **providing** fiber as `owner` (lines 243-247) because a Cordis `Service` reads `ctx` as its *consumer's* fiber — otherwise every caller would have to declare `remote.settings` in its own `inject`.
- Edge cases / failure handling: `dispose()` stops queued operations, stops deriving, and awaits the in-flight wire call; `enqueue` short-circuits after disposal.
- Surprising: `ConfigForms.get(entryId)` returns the **same** controller for repeated calls, so every editor of a Host entry shares one write queue.

#### packages/client/ui-settings/src/client/config-form-types.ts
- The public shape of a config form: `ConfigFormSnapshot<T>` (`status`, `value`, `base`, `user`, `revision`, `writable`) and `ConfigForm<T>` (`getSnapshot`/`subscribe`/`mutate`/`set`/`unset`).
- Non-obvious design decision, with its reason in the doc comment (lines 22-26): **a field's PRESENCE in the `user` layer is what marks it overridden** — "an override whose value equals the composition default is still an override, and comparing values could not see it."

#### packages/client/ui-settings/src/client/schema.ts
- Purpose: synchronous schema introspection and immutable settings-draft edits, exposed as `ctx.settingsSchema`.
- Key abstractions: `SettingsSchemaService` (a Cordis `Service`) with `rehydrate`, `validate`, `nodeAtPath`, `getPath`, `hasPath`, `setPath`, `deletePath`.
- Data flow: a serialized `schema.toJSON()` envelope → `rehydrate` → a live schemastery node → `validate(schema, draft)` returns failure text or `undefined`.
- Non-obvious design decisions: `cloneSpine` copies only the path spine, so editing a nested value does not mutate the sibling branches of the draft; `hasPath` reports key **existence** rather than value truthiness (`flag: false` is present); both `setPath` and `deletePath` throw on an empty path.
- Edge cases / failure handling: `validate` stringifies a non-`Error` throw; `nodeAtPath` tolerates structural nodes missing their `dict`/`inner` maps and returns `undefined`.

#### packages/client/ui-settings/src/client/developer-tools.ts
- `DeveloperToolsPreference` wraps one `ConfigForm<DeveloperToolsSettings>` and publishes an `ObservableSnapshot<boolean>` that fires only when the boolean actually changes (lines 17-25).
- Non-obvious: `getSnapshot()` is `scope.getSnapshot().value?.enabled ?? false` — a Host-backed client stays disabled until the first **accepted** value arrives, so a missing or failed initial read does not enable developer features.
- `setEnabled` throws `'Developer tools preference was not saved'` when the Host refuses (line 35), which is what the General switch turns into a localized error.

#### packages/client/ui-settings/src/client/contract/slots.ts
- Purpose: the canonical home of every settings slot type, owned by the domain base rather than by the shell.
- Key abstractions: `settings.launcher`, `settings.trigger`, `settings.header`, `settings.action`, `settings.close`, `settings.section`, `settings.plugins.tab`, `settings.onboarding`, `settings.general.item`, plus the owner-prop interfaces.
- Non-obvious design decisions: the shell has "zero copy of its own" — all text arrives from registrants; a `settings.section` label is a **locale-following thunk** so the shell never subscribes to locale state; `settings.general.item` passes **no props at all** — the row owns its copy, its current value and its write path.
- Edge cases: an absent `settings.trigger`/`settings.close` contribution is documented as a "broken-composition state" that degrades to an icon-only button with no accessible name.
- Surprising: `settings.general.item`'s type lives here "because this package is the settings domain's base layer and every registrant already depends on it for `ctx.configForms`", even though the row is rendered by ui-settings-general.

#### packages/client/ui-settings/tests/config-form.client.spec.ts
- The `ConfigFormController`/`ConfigForms` contract: last-good-value retention across invalid/rejected/failed reads, custom decode override, serialized rapid writes, one copied multi-field mutation behind one revision fence, an editor-owned revision fence, write-answer folding visible to a sibling scope, recovery after a revisionless first write, recovery only for the *latest* refused write, queue survival when a subscriber throws or the mirror fold throws, disposal semantics, base/user layer projection, and `unset` restoring inheritance.
- Notable: the test asserts `describeCall` is called **once** for two `get('ui-test')` calls — one shared read for two consumers.

#### packages/client/ui-settings/tests/settings-mirror.client.spec.ts
- The mirror's concurrency contract: pre-wire loads fold into the read, mid-flight loads become exactly one rerun, a failed refresh keeps the last good view, the first-read-failure returns to `idle` so `ensure` retries, `acceptView` folds without a wire read and is a no-op before any answer, and a write folded during an in-flight read forces a re-read.
- Contains a named regression: "never loses a load landing between a run settling and its slot clearing".

#### packages/client/ui-settings/tests/schema.client.spec.ts
- The schema service: rehydration, non-Error throw stringification, nested object/array path reads, presence-by-existence, immutable set/delete with materialised containers, array splices, and object/dict/array schema traversal.

#### packages/client/ui-settings/tests/developer-tools.client.spec.ts
- Developer-tool preference behaviour: a refused Host write rejects after recovering accepted state, a delayed Host read withholds features (the subscriber fires only when the value actually changes), an unavailable namespace keeps them disabled, and one preference instance is shared across consumers.

#### packages/client/ui-settings/tests/plugin.client.spec.ts
- The base plugin's lifecycle: mounts `configForms` and `settingsSchema`, reads eagerly exactly once, refreshes values and revisions on `settings/document-updated` and `connection/reset`, and retires both services and their subscriptions on fiber disposal.

#### packages/client/ui-settings/tests/while-served.client.spec.ts
- The served-namespace watch: a registration lives exactly while the Host serves one of the watched namespaces; a further read changes nothing; the disposer runs when none is served; ending the watch twice is harmless.

#### packages/client/ui-settings/tests/config.host.spec.ts
- The Host half: the developer-tool preference defaults on, persists valid choices, rejects a non-boolean, and keeps its own instance off the generated Settings pages.

---

### packages/client/ui-settings-agent-loop

#### packages/client/ui-settings-agent-loop/README.md
- Package reference for the agent-loop settings page; the Summary states the page exists only while the Host serves the `agent-loop` namespace, stages input and writes only on save, marks an overridden value, and offers a reset to the deployment default.
- Model Experience / KV Cache effect: explicitly **None** — "this package neither assembles nor sends a provider request".

#### packages/client/ui-settings-agent-loop/README.zh.md
- Chinese mirror; same "页面只在 Host 服务 `agent-loop` 命名空间期间存在" claim.

#### packages/client/ui-settings-agent-loop/README.i18n.yaml
- Per-section bilingual pairing hashes for README.md / README.zh.md.

#### packages/client/ui-settings-agent-loop/package.json
- Manifest; `dsh.client.inject: [locale, ui-settings, ui-plugin-manager]`; description names the "parallel tool-call cap of the agent-loop namespace".

#### packages/client/ui-settings-agent-loop/locale/en.json
- Package locale metadata only (`{"meta":{"title":"ui-settings-agent-loop"}}`).

#### packages/client/ui-settings-agent-loop/locale/zh.json
- Chinese package-locale metadata: "智能体运行设置" / "配置同时执行的工具调用数量上限。".

#### packages/client/ui-settings-agent-loop/tsconfig.json
- Client project referencing locale, cordis, store, test-runtime, ui-primitives, ui-renderer, ui-plugin-manager, ui-settings, api/remotes and ui-slots.

#### packages/client/ui-settings-agent-loop/tsdown.config.ts
- `clientBundle(import.meta.dirname, ['lib/types/index.js'])` — identical to the other three client packages.

#### packages/client/ui-settings-agent-loop/src/index.ts
- An **empty** Host `apply()`: "The empty apply exists so the plugin appears in the host cordis.yml / Loader; the browser half owns the page through exports["./client"]."

#### packages/client/ui-settings-agent-loop/src/css-modules.d.ts
- Ambient `*.module.css` declaration; four lines, boilerplate.

#### packages/client/ui-settings-agent-loop/src/client/index.ts
- Browser half: registers the `settings.agentLoop` dictionary, builds the `AgentLoopCardController` over `ctx.configForms.get('agent-loop')`, and registers `AgentLoopCard` into the Plugins page's `plugins.item` slot **inside** `ctx.configForms.whileServed([AGENT_LOOP_NS], …)`.
- Non-obvious: the page is withdrawn automatically when the Host stops serving the namespace.

#### packages/client/ui-settings-agent-loop/src/client/agent-loop-card-controller.ts
- The staged form over the `agent-loop` namespace: `AgentLoopSettings { maxParallelToolCalls?: number }` — "Upper bound on parallel-safe tool calls in flight per step".
- Non-obvious design decision, with the reason in the comment (lines 10-12): the namespace string `'agent-loop'` is **spelled here rather than imported** because "a client package must not depend on a Host package".
- The composed `agents` array is deliberately *not* part of the settings section (it is boot composition, not a user setting).
- Data flow: `SettingsFormModel(scope, [settingsNumberField('maxParallelToolCalls')])` → `bind()` → a `SnapshotStore` projected into `AgentLoopCardState`.

#### packages/client/ui-settings-agent-loop/src/client/AgentLoopCard.tsx
- The page render: a one-liner in `summary` view, otherwise a `SettingsForm` with a single `SettingsValueField` for the parallel cap, carrying the `Overridden` badge, `Reset to default`, and an `invalidNumber` message; the field is disabled when the document is not writable.

#### packages/client/ui-settings-agent-loop/src/client/locales.ts
- The page dictionary: title, description, the parallel cap label and hint, `Overridden`, `Reset to default`, `readOnly`, `unavailable` ("This plugin is not loaded, so it cannot be configured right now"), Save/Saving/Save-failed and `invalidNumber`; plus `formLabels(t)` which pulls the shared form frame's copy out of the same dictionary.

#### packages/client/ui-settings-agent-loop/tests/apply.client.spec.ts
- What the browser half registers and when: the Host `apply` is inert, `inject` is exactly `['slots','locale','configForms']`, the page appears with the locale-resolved title while the namespace is served and **withdraws** when the Host stops serving it, and the page collapses on teardown.

#### packages/client/ui-settings-agent-loop/tests/card.client.spec.tsx
- The card's rendering: the summary view is the one-liner alone; the page stages and saves the only field it owns; a reset is staged; an unavailable namespace says "not loaded" and a read-only document disables the field.

#### packages/client/ui-settings-agent-loop/tests/controller.client.spec.ts
- The controller against a stub Host that accepts writes: the save produces one `mutate([{op:'set',path:['maxParallelToolCalls'],value:4}], undefined)` and the projected field becomes `overridden: true`; a read-only document is reported so the card can disable itself.

---

### packages/client/ui-settings-general

#### packages/client/ui-settings-general/README.md
- Package reference for the settings shell. Specifies the 800 × 800 panel, the sidebar trigger, the **Disconnected / Reconnecting / Connected** indicator with its 800 ms minimum-visible hold and 2 s recovery confirmation, the "Service version changed" dialog, the Desktop update row, the Settings shortcut, the General section, "Open configuration file", and the onboarding ledger.
- Non-obvious: the panel "portals beside `#root` rather than inside it, so a macOS window drag region a chrome row declares later in document order cannot swallow its controls" (line 25).

#### packages/client/ui-settings-general/README.zh.md
- Chinese mirror of the shell reference; same 800 ms / 2 s timings and the same `body` portal rationale.

#### packages/client/ui-settings-general/README.i18n.yaml
- Per-section bilingual pairing hashes for the shell README.

#### packages/client/ui-settings-general/package.json
- Manifest; injects `ui-settings`, `locale`, `connection`, `api-remotes`, `ui-sidebar`, `shortcuts`, `modules`, `ui-layout`; exports an extra `./types` subpath for the Desktop-update types.

#### packages/client/ui-settings-general/locale/en.json
- Package locale metadata only (`{"meta":{"title":"ui-settings-general"}}`).

#### packages/client/ui-settings-general/locale/zh.json
- Chinese package-locale metadata: "通用设置与欢迎提示" / "提供通用设置、设置窗口文案和首次使用提示。".

#### packages/client/ui-settings-general/tsconfig.json
- Solution file referencing the host and client projects.

#### packages/client/ui-settings-general/tsconfig.client.json
- Client project over `src/client`, `src/types.ts` and `src/css-modules.d.ts`; references cordis, schemastery, ui-slots, ui-primitives, ui-renderer, ui-session, store, ui-settings, locale, connection, api/remotes, ui-sidebar, shortcuts, modules and ui-layout.

#### packages/client/ui-settings-general/tsconfig.host.json
- Host project over `src/index.ts` and `src/types.ts` only; references cordis, schemastery and `settings/settings`.

#### packages/client/ui-settings-general/tsdown.config.ts
- `clientBundle(import.meta.dirname, ['lib/types/index.js'])` — same as the other client packages.

#### packages/client/ui-settings-general/src/index.ts
- Host half: declares `welcomeNoticeVersion` as a **volatile** field of the `ui-settings-general` entry and calls `child.settings.configure({ auto: false }, ctx.fiber)`.
- Non-obvious: the shell "remains policy-free" — the welcome step contributed by ui-settings-models reads and writes that field through the public settings boundary.

#### packages/client/ui-settings-general/src/types.ts
- Type-only Desktop-update declarations: `DesktopUpdateFailureKind` (nine classified failure kinds), `DesktopUpdatePresentation` (phase / version / percent / failure), `DesktopUpdateBridge` (status/open/subscribe) and `DesktopUpdateView`.
- Non-obvious: the bridge "cannot select artifacts or authorize installation" (line 23) — browser code cannot choose what is installed.

#### packages/client/ui-settings-general/src/css-modules.d.ts
- Ambient `*.module.css` and `*.css` declarations; boilerplate.

#### packages/client/ui-settings-general/src/client/index.ts
- The shell's browser half: registers the five chrome seats, the two General rows, the `settings` dictionaries, the sidebar toggle badge, the `sidebar.settings` occupant and the `host-release-change` overlay.
- Non-obvious design decisions:
  - The nav-row projection caches on `(ledger version, locale revision)` (lines 135-138) so a locale change re-renders without churning the ledger; `resolveSlotLabel` resolves the locale-following thunk.
  - The `settings.open` shortcut command is registered with per-platform defaults (`Mod+,` on Desktop, `Mod+Alt+,` on Web) and a `resolve` that refuses while another modal is in front (lines 183-200).
  - The `SettingsDocumentStore` is only created when `ctx.remote.$host.isLoopback` (line 106) — remote browsers never register the native document action.
  - The shell injects `connection` directly rather than adding lifecycle controls to `ctx.remote` (README line 76).
- Edge cases: a `settings.general.item` row that is contributed by a feature owns its own copy and write path; the shell only stacks rows.

#### packages/client/ui-settings-general/src/client/SettingsRoot.tsx
- Purpose: the settings trigger row plus the centered modal panel with the section nav rail.
- Key abstractions: `SettingsPanel` (portal + mask + nav + content), the connection-indicator state machine, and the onboarding coordinator.
- Data flow: `useSections`/`useOnboardingSteps` are observables; the panel renders `settings.section` filtered by the active id via `renderSlot('settings.section', { close }, { only: active })`.
- Non-obvious design decisions (all reasoned in code):
  - `CONNECTING_MIN_VISIBLE_MS = 800` (line 29) — "shorter attempts read as flicker"; the hold is implemented by keeping the connecting state alive for the remaining time (lines 179-195).
  - `RECOVERY_CONFIRMATION_MS = 2_000` (line 26) — and the timer "starts when the recovered pill becomes visible, which the connecting minimum-visible hold can delay past the transition" (lines 171-177).
  - The panel is portalled to `document.body` (line 104) because a covering surface mounted inside `#root` would precede the columns' chrome in document order and lose the drag-region subtraction.
  - An onboarding step that appears while the panel is open **closes the panel** (lines 150-158), because the step's overlay marks `#root` inert while the panel lives outside it.
  - The `settingsOpen` false→true edge is one Settings entry, so a launcher acts once per entry rather than on every re-render (README line 63).
  - The connection indicator is suppressed while the Desktop update reports `installing`, because "the expected backend disconnect must not hide update status" (line 235).
- Edge cases / failure handling: if the active nav entry unregisters, the render-time projection falls back to the first row (line 57); with an empty ledger the title takes focus; `Escape` is handled by a document-level listener mounted only while the panel is open.

#### packages/client/ui-settings-general/src/client/shell-contract.ts
- The prop types of the `sidebar.settings` occupant: `SettingsSectionRow`, `SettingsOnboardingStep`, `SettingsRootInjected` (a hooks compartment plus plain callbacks) and `SettingsRootComponentProps`.
- Non-obvious: the contract lives here rather than in ui-settings because it references the sidebar's own slot type — "ui-settings is the settings domain's base layer and must not depend on any `ui-*` presentation package, or the reference graph closes a cycle through ui-sidebar → ui-layout → ui-theme" (lines 1-7).

#### packages/client/ui-settings-general/src/client/shell-store.ts
- The shell's owner store: `{ open, activeId }` with `open`/`close`/`select`/`openSection` actions, created through `defineStore` so the mouse and the command entry points share one state.

#### packages/client/ui-settings-general/src/client/settings-document-store.ts
- Purpose: state owner for the optional "Open configuration file" action.
- Key abstractions: `SettingsDocumentState` (`idle | loading | ready | unavailable`, `opening`, `error`).
- Data flow: `load()` follows the shared mirror and derives availability from `hasDocument`; `open()` calls the pathless, browser-authenticated `remote.settings.openSettingsDocument()`.
- Non-obvious: with no held mirror view but a recorded error the state is `unavailable`; with no error the read is still in flight and `loading` stands (lines 83-92). Concurrent gestures collapse behind the in-flight `opening` flag.

#### packages/client/ui-settings-general/src/client/SettingsDocumentAction.tsx
- The header action: renders nothing until the Host confirms `hasDocument`; shows a localized error on a native-open failure but **keeps the action available**; the button is disabled while a request is in flight.

#### packages/client/ui-settings-general/src/client/chrome.tsx
- The trigger icon + label (label only in the wide column), the panel title text and the close button's visually-hidden label — three tiny content components, one per seat.

#### packages/client/ui-settings-general/src/client/GeneralSection.tsx
- A one-line column that renders `settings.general.item`; the section supplies nothing, so each row owns its label, value and write path.

#### packages/client/ui-settings-general/src/client/DeveloperToolsRow.tsx
- The Coding Tools switch: it disables duplicate input while a write settles (`busy`), shows a localized `role="alert"` on a failed write, and clears the error on the next attempt.

#### packages/client/ui-settings-general/src/client/CurrentVersionRow.tsx
- Renders `process.env.DSH_CLIENT_VERSION` through the localized template; a partial build without version metadata **omits the row entirely** (line 12).

#### packages/client/ui-settings-general/src/client/desktop-update-source.ts
- Purpose: the client-owned observation of the optional Electron preload, shared by both sidebar locations.
- Non-obvious design decisions: the initial `status()` promise only publishes if **no** subscription event arrived first (`this.received` flag, lines 20-24), so a newer event is never overwritten by a slower initial read; `open()` refuses while a phase is already `checking | downloading | verifying | installing`; `dispose()` sets `live = false` so late completions cannot publish.

#### packages/client/ui-settings-general/src/client/DesktopUpdateIndicator.tsx
- The update row and the collapsed-sidebar badge: nine classified failure copy strings, a busy-phase set, and a tooltip that shows only the supplied version (no `v`/`V` prefix).
- Non-obvious: the badge yields to connection feedback except during `installing` (lines 92-93) — the expected backend disconnect must not hide update status.

#### packages/client/ui-settings-general/src/client/HostReleasePrompt.tsx
- The "Service version changed" dialog: two transition lines (Service = the Host's own completed switch, Page = the switch only a reload completes).
- Non-obvious: `transitionText` shows versions when the two versions differ and commits otherwise (line 34); the dialog opens without a user gesture, so initial focus is deliberately on **"Not now"** — "a pending Enter must not reload it" (line 77).

#### packages/client/ui-settings-general/src/client/locales.ts
- The shell dictionary: the Chinese object is the key-set source of truth (`satisfies Record<string, string>`) and the English object is checked complete against it (`satisfies Record<SettingsKey, string>`) — a compile-time bilingual pairing check.

#### packages/client/ui-settings-general/src/client/SettingsRoot.module.css
- The 800 × 800 panel, the 188 px nav rail, the 40 px nav cells, the mask, and the scrollbar-elevation rebinding. Carries a reasoned comment (lines 78-84) that the panel height is taken from the viewport rather than the content, because "a content-sized panel would resize under the pointer on every nav click".

#### packages/client/ui-settings-general/src/client/DesktopUpdateIndicator.module.css
- The 28 px-high brand-blue indicator with a 14 px icon slot and 4 px gap, plus the 6 px collapsed-rail dot and the reduced-motion spinner rule.

#### packages/client/ui-settings-general/src/client/HostReleasePrompt.module.css
- The 4-column transition grid and the two connector styles: a solid green arrow for the completed Host switch, a dashed grey arrow for the page switch that only a reload completes.

#### packages/client/ui-settings-general/src/client/chrome.module.css
- One rule: the trigger label only guards against overflow during the sidebar collapse crossfade.

#### packages/client/ui-settings-general/src/client/GeneralSection.module.css
- One rule: the column strips the trailing separator wherever it ends, using the slot's `data-slot` attribute.

#### packages/client/ui-settings-general/src/client/CurrentVersionRow.module.css
- One rule: the version row's padding, 14/22 type and `overflow-wrap: anywhere`.

#### packages/client/ui-settings-general/src/client/DeveloperToolsRow.module.css
- One rule: the row's 24 px gap, the 0.5 px bottom separator and the 12/18 description type.

#### packages/client/ui-settings-general/src/client/SettingsDocumentAction.module.css
- One rule: the error string is truncated to 180 px with an ellipsis rather than wrapping.

#### packages/client/ui-settings-general/tests/settings-root.client.spec.tsx
- The shell's behaviour under a fake session/slot world: the trigger's accessible name in both locales and both column states, the outage → reconnecting → recovered sequence with the 800 ms hold and the 2 s window, the collapsed rail hiding the indicator, `aria-labelledby` naming the dialog through the header seat, the three close paths and their focus restoration, opening above an existing body modal, nav projection and glyph selection, the onboarding coordinator's ownership transfer, the panel being taken down when a step appears beneath it, and the effective shortcut binding reaching both the tooltip and `aria-keyshortcuts`.

#### packages/client/ui-settings-general/tests/apply.client.spec.ts
- The five seats, the `settings` dictionaries, the locale-following nav label (no ledger churn on a locale change), the loopback-only document action, remote locale consumers after a Host commit and a reconnect, re-registration after a Loader rebuild of the declaring chain, and the Host-release-change overlay.

#### packages/client/ui-settings-general/tests/components.client.spec.tsx
- The individual components: the collapsed update badge yielding to connection feedback, the developer-tools switch disabling duplicate writes and reporting a failed write, the three chrome content components, the General section rendering the item slot, the document action appearing only for a file-backed provider, the localized release label, and the Host-release-change dialog's version-vs-commit rule.

#### packages/client/ui-settings-general/tests/desktop-update.client.spec.tsx
- The update carrier: newest event wins over a slower initial status, connection priority hides the indicator, a busy phase suppresses the action, late events and action rejections after disposal are ignored, and the tooltip shows only the version.

#### packages/client/ui-settings-general/tests/settings-document-store.client.spec.ts
- The document store: metadata load, absent/failed/rejected metadata all unavailable without opening anything, concurrent open gestures collapsing, and availability recovering through a mirror refresh after a failed first read.

#### packages/client/ui-settings-general/tests/shell.client.spec.ts
- The shell inside the assembled web client: one carrier subscription shared by both update locations, the `sidebar.settings` occupation and all seven child slot declarations, the section and onboarding ledger projections with stable snapshot identity, Account appearing first only while signed in, the roster Connection control being projected rather than copied, and survival across a Loader rebuild.

#### packages/client/ui-settings-general/tests/config.host.spec.ts
- The Host half: the welcome-notice preference updates without remounting, and the package keeps its own instance off the generated Settings pages.

---

### packages/client/ui-settings-account

#### packages/client/ui-settings-account/README.md
- Package reference for the account surface: login state, browser authorization and cancellation, Platform sign-out, the Desktop resumable introduction, the bonus notice, the quota notice and the shared Platform view.
- Non-obvious design decisions, all stated: balances use Platform Web currency rules; a granted bonus is a server-authored notice; "The client reads the unnotified bonus when an account becomes active and once per Settings entry; it never polls"; the Platform view's dialog marks every other document child inert; Web sign-in needs a loopback HTTP origin.
- Model Experience: "None, as account credentials affect HTTP authentication and never enter model prompts, Session logs, or tool results."

#### packages/client/ui-settings-account/README.zh.md
- Chinese mirror; the same normative claims, including "客户端仅在账号进入登录态时、以及每次进入设置页时读取一次未通知赠金，不做轮询" (no polling).

#### packages/client/ui-settings-account/README.i18n.yaml
- Per-section bilingual pairing hashes for the account README.

#### packages/client/ui-settings-account/package.json
- Manifest; injects `api-remotes`, `client-locale`, `ui-chat`, `ui-layout`, `ui-settings` and `ui-theme`; declares `big.js` and `@deepseek-ai/schemastery`.

#### packages/client/ui-settings-account/locale/en.json
- Package locale metadata only (`{"meta":{"title":"ui-settings-account"}}`).

#### packages/client/ui-settings-account/locale/zh.json
- Chinese package-locale metadata: "账号设置界面" / "管理 DeepSeek 登录，并打开平台账单页面。".

#### packages/client/ui-settings-account/tsconfig.json
- Client project referencing cordis, api/remotes, locale, store, ui-settings, ui-primitives, ui-renderer, ui-slots, ui-theme, deepseek-account, ui-settings-models, host/webserver, schemastery, ui-chat, ui-layout, settings/settings and product-analytics.

#### packages/client/ui-settings-account/tsdown.config.ts
- `clientBundle(import.meta.dirname, ['lib/types/index.js'])` — same as the other client packages.

#### packages/client/ui-settings-account/src/index.ts
- Host half: the `Config` combines the public `ContactConfig` with the **volatile** onboarding fields (`version`, `step`, `purpose`, `process`, `completion`, `usage`, `developerTools`).
- Data flow: `apply` registers the contact options into the page bootstrap through `webserver/index-inject` as a `kind: 'global'` entry named `__DSH_CONTACT_CONFIG__` — "Publish public questionnaire options before browser plugins activate."

#### packages/client/ui-settings-account/src/contact-config.ts
- The public questionnaire options: `contactFormUrl` (HTTPS-only by schema pattern, with the real Feishu form as the default), `contactSource` (empty until the form supports a Harness option), and the two bonus-acknowledgement retry timings (1 s / 60 s).

#### packages/client/ui-settings-account/src/onboarding-settings.ts
- The `ui-settings-account` namespace: `OnboardingProgress` (`version`, `step`, `purpose`, `process`, `completion`, `usage`, `developerTools`) with the schemastery fields; nullable choices are explicitly nullable so "Host values may omit choices that have never been saved".

#### packages/client/ui-settings-account/src/css-modules.d.ts
- Ambient `*.module.css` / `*.css` declarations; boilerplate.

#### packages/client/ui-settings-account/src/client/index.ts
- The account plugin's browser half: the shared account snapshot, the `remote.$stream` account watcher, the profile/balance refresh with a generation fence, the bonus-notice controller, the shared Platform page channel, the Desktop onboarding controller and every slot registration.
- Non-obvious design decisions:
  - `revision` is bumped on every account frame and on disposal (lines 87, 118, 126), and a read only publishes if `generation === revision` (line 99) — a response that outlived its frame is dropped.
  - The `client()` closure (line 63) re-reads the locale and version **at call time**, "so it carries the language and zone in effect then".
  - The account section is registered only while `snapshot.view?.status === 'credential-stored'` and unregistered on sign-out (lines 313-329).
  - `platformPageOpener(reRead)` narrows the shared channel per surface: only a **top-up** return re-reads the account; a superseded page, a released request, a plugin unload and leaving *usage* all read nothing (lines 169-173).
  - Default-model initialization runs after the sign-in frame is published and accepted, and its failure is logged with `console.error` without marking the account failed (lines 138-145).
- Edge cases / failure handling: a failed profile or balance read publishes `{status:'failed'}` and logs only the **field** name — "Profile and balance reads also report only failures, without account data or raw exceptions" (README line 117).

#### packages/client/ui-settings-account/src/client/AccountSection.tsx
- The Account settings page: identity card, balance rows (recharge funds and granted bonus kept separate), the Usage / Top up links, and the signed-out prompt.
- Non-obvious design decisions: the bonus row is shown "during loading, after a failed wallet read, and when a wallet holds positive bonus credit" but omitted on a successful read with no positive bonus (line 105); a failed wallet read keeps the muted copy but renders it as a **link to Platform**, so the user can inspect the balance the Harness could not load.

#### packages/client/ui-settings-account/src/client/AccountMenu.tsx
- The sidebar account launcher: the avatar or the "More" ellipsis, the Settings / Feedback / Sign out (or Sign in) rows, the bonus-notice stack, and the sign-in and sign-out dialogs.
- Non-obvious: the launcher **outlives the settings panel**, so a `settingsOpen` false→true edge is one Settings entry and re-renders inside one open do not re-read the account (lines 30-34).

#### packages/client/ui-settings-account/src/client/AccountAvatar.tsx
- A decorative avatar that renders the shared picture only when the shared load is `ready`, and otherwise the account icon; a rendered-image failure is reported back into the shared state.

#### packages/client/ui-settings-account/src/client/account-avatar.ts
- Purpose: one account picture load shared by the sidebar and Settings for the plugin's lifetime.
- Key abstractions: `AccountAvatarSnapshot` (`url` + `loading | ready | failed`).
- Non-obvious design decisions: `setUrl` ignores the same URL (line 27); a superseded attempt's callbacks are discarded by the `this.image !== image` guard (line 68); `image.referrerPolicy = 'no-referrer'` (line 66); `failed(snapshot)` only accepts a failure for the **current** snapshot and only from the `ready` state (line 45); `reset()` releases the picture **without** publishing, because the owner publishes an empty avatar with the replacement account frame.

#### packages/client/ui-settings-account/src/client/account-refresh.ts
- `refreshAfterReturn(pending, refresh)`: await the pre-return read (swallowing its failure) and then request a fresh snapshot — "A failed pre-return query must not prevent the user's post-operation refresh."

#### packages/client/ui-settings-account/src/client/bonus-notices.ts
- Purpose: the lifecycle of server-authored bonus notices — one foreground card in a stack, one read in force at a time, one acknowledgement per displayed card.
- Key abstractions: `createBonusNoticeController(options)` → `BonusNoticeController` (`begin`/`end`/`refresh`/`shown`/`dismiss`), the internal `NoticeScope` (account id + pending order queue), and `BonusNoticeTiming`.
- Data flow: `begin()` → `runRead` → `apply` (filter expired, publish) → the card reports a presented frame → `shown(orderId)` → `report` → `runAcks` (one at a time, doubling backoff) → the server's `acknowledge`.
- Non-obvious design decisions (all reasoned in the module header and in-line):
  - A newer read **supersedes** an older one: `if (scope !== scopeAtRead || generation !== readGeneration) return` (line 179) — "so a credential swapped in place is named by a fresh read".
  - An unparsable expiry is **not** evidence of expiry, so the notice still shows (line 95-96).
  - A failed acknowledgement backs off with `ackDelay = Math.min(ackDelay * 2, max)` (line 209) and retries "for the rest of the signed-in lifecycle, which never persists".
  - A protocol-level `false` answer settles the order with **no** retry — "this session cannot make the server accept it" (line 214).
  - A card the user has already seen is **kept** by an empty read; an unseen card is withdrawn (lines 153-157).
  - `reported` is a set, so one mount cannot acknowledge twice, and the set is pruned when an order disappears (lines 122-123).
- Edge cases / failure handling: sign-out or plugin unload discards the card, the queue and the pending retries; a failure that arrives after the lifecycle ended is ignored via the `owns()` check (line 200).

#### packages/client/ui-settings-account/src/client/AccountNotice.tsx
- The visible notice stack: position derived from the anchor's rect, one interactive foreground card, and the display report.
- Non-obvious design decisions: `afterPaint` (lines 28-47) waits for a `requestAnimationFrame` **and then** a `setTimeout(0)` — "The frame callback runs before its paint; the following task runs after it" — so "one presented frame" really means painted; the card measures **no cover**, so a card painted under the translucent Settings overlay reports like any other; the display is reported only while `document.visibilityState === 'visible'`.

#### packages/client/ui-settings-account/src/client/notice-transition.ts
- The card-promotion animation: measure the survivors' rectangles, cancel their running animations, `flushSync(dismiss)`, then animate each survivor from its old rectangle to its new one over 250 ms with `ease-out`.
- Edge case: with no `animate` support or a zero transition duration it just dismisses (reduced-motion path).

#### packages/client/ui-settings-account/src/client/browser-login.ts
- Purpose: browser tab ownership for one UI-initiated authorization attempt.
- Non-obvious design decisions: `begin()` preopens `about:blank` **during the user's click** and nulls `opener` — a blocked popup leaves the copy-link route (lines 31-35); the tab is navigated exactly once, when the attempt's `authorizeUrl` arrives, and is closed on `failed`/`expired`/`cancelled`; a tab that never navigated is closed on success ("the Host finished without it", line 58).

#### packages/client/ui-settings-account/src/client/assets/onboarding-back.svg
- A three-line Figma back-arrow glyph (two stroked paths: the horizontal shaft and the chevron) rendered as a CSS mask on the onboarding Back button, so it inherits the button's current colour.

#### packages/client/ui-settings-account/src/client/assets/onboarding-code.svg
- A 40×40 Figma link/code glyph (three stroked paths forming two chevrons around a slash) in the brand blue `#3B86FF`, used on the development purpose card.

#### packages/client/ui-settings-account/src/client/assets/onboarding-compact.svg
- A 40×40 Figma "exit fullscreen" glyph (two opposed corner brackets) in violet `#8370F1`, used for the compact work-detail option.

#### packages/client/ui-settings-account/src/client/assets/onboarding-detailed.svg
- A 36×36 Figma "browse outline" glyph (a rounded document frame with two rules) in cyan `#00A4C9`, used for the detailed work-detail option.

#### packages/client/ui-settings-account/src/client/assets/onboarding-office.svg
- A 40×40 Figma document glyph (a folded page outline with two rules) in violet `#8370F1`, used on the office purpose card.

#### packages/client/ui-settings-account/src/client/assets/onboarding-standard.svg
- A 36×36 Figma "checklist outline" glyph (two dots with rules) in blue `#3B86FF`, used for the standard work-detail option.

#### packages/client/ui-settings-account/src/client/assets/onboarding-welcome.webp
- A ~415 KB binary WebP illustration (RIFF/WEBP container confirmed) — the English light-theme welcome artwork. Not read line by line: the file is binary image data; I read its container header, exact byte size and the importing component (`OnboardingWelcomeStep.tsx`) to establish what it is.

#### packages/client/ui-settings-account/src/client/assets/onboarding-welcome-dark.webp
- A ~408 KB binary WebP — the English dark-theme welcome artwork, selected by the `body[data-ds-dark-theme]` CSS rule. Not read line by line: binary image payload.

#### packages/client/ui-settings-account/src/client/assets/onboarding-welcome-zh.webp
- A ~393 KB binary WebP — the Chinese light-theme welcome artwork. Not read line by line: binary image payload.

#### packages/client/ui-settings-account/src/client/assets/onboarding-welcome-zh-dark.webp
- A ~390 KB binary WebP — the Chinese dark-theme welcome artwork. Not read line by line: binary image payload.

#### packages/client/ui-settings-account/src/client/assets/onboarding-recharge.webp
- A ~182 KB binary WebP — the English light-theme recharge artwork. Not read line by line: binary image payload.

#### packages/client/ui-settings-account/src/client/assets/onboarding-recharge-dark.webp
- A ~207 KB binary WebP — the English dark-theme recharge artwork. Not read line by line: binary image payload.

#### packages/client/ui-settings-account/src/client/assets/onboarding-recharge-zh.webp
- A ~180 KB binary WebP — the Chinese light-theme recharge artwork. Not read line by line: binary image payload.

#### packages/client/ui-settings-account/src/client/assets/onboarding-recharge-zh-dark.webp
- A ~225 KB binary WebP — the Chinese dark-theme recharge artwork. Not read line by line: binary image payload.

#### packages/client/ui-settings-account/src/client/authorize-url.ts
- Appends `theme=light|dark` to an authorization URL **without dropping any parameter the Host already put on it** (uses `searchParams.set` on a parsed URL).

#### packages/client/ui-settings-account/src/client/client-metadata.ts
- Builds the per-call client identity: build version, UI language and the UTC offset **in seconds east** (`-new Date().getTimezoneOffset() * 60`).
- Edge case: a build with no `DSH_CLIENT_VERSION` throws rather than reporting an empty one.

#### packages/client/ui-settings-account/src/client/contact-url.ts
- Builds the external questionnaire URL: sets `hide_<field>=1` and `prefill_<field>` for uid / source / harness_version / device_info, and **deletes** stale prefill and hide parameters for the six unsupported fields (`os_version`, `device_brand`, `app_locale`, `screen_resolution`, `app_version`, `device_model`).
- Non-obvious: the screen resolution is the physical one (`screen.width × devicePixelRatio`, rounded) and is folded into `device_info` rather than sent as its own field.

#### packages/client/ui-settings-account/src/client/formatBalance.ts
- Platform Web currency formatting on `big.js`: two decimals with digit grouping, positive amounts truncated to cents, positive sub-cent amounts shown as `<¥0.01`, negative amounts rounded with a minimum displayed magnitude of 0.01, and exponent notation parsed natively.

#### packages/client/ui-settings-account/src/client/onboarding-balance.ts
- `hasOnboardingCredit(balance)` — purchased **and** granted wallets both count, and a pending query is **not** treated as zero.

#### packages/client/ui-settings-account/src/client/onboarding-credentials.ts
- Reads API-key presence through the boolean-only `dshOnboarding.hasApiKey()` Desktop bridge; a missing bridge or a failed read rejects rather than reporting "absent".

#### packages/client/ui-settings-account/src/client/onboarding-contract.ts
- The pure view inputs of the Desktop onboarding flow: `DesktopOnboardingState`, `OnboardingChange` and `DesktopOnboardingProps`.

#### packages/client/ui-settings-account/src/client/onboarding-state.ts
- Purpose: the resumable Desktop onboarding controller and the preference application over Host settings.
- Key abstractions: `DesktopOnboardingController` with `state` (a `SnapshotStore`), `update`, `complete`, `retry`, `invalidateCredentials`.
- Data flow: `update` previews a draft and serializes its persistence through a `Promise` chain; `complete` → `finish` → `save` applies the Chat preferences (`transcriptView` + `performanceUsage` in **one** atomic mutation), then the developer-tools preference, then the progress write; `derive()` recomputes the published state.
- Non-obvious design decisions (all reasoned in the code):
  - `save` **verifies** the saved value, not just the acceptance flag: `if (!accepted || saved?.transcriptView !== mode || saved.performanceUsage !== next.usage) throw` (line 171), and the same for the progress fields (lines 181-183).
  - The account status is captured before the writes and re-checked after each one (lines 172, 175) so a sign-out mid-write cancels completion.
  - `creditFunded` is computed **once**, at first credit-page entry, and is never persisted (lines 205-208) — a late balance result cannot change the buttons the user already saw.
  - The API-key path applies `standard` process, `detailed` usage and `developerTools: true` (line 230) and is discarded entirely if the user later signs in.
  - A failed write is remembered as `failedWrite = { next, applyPreferences }` so `retry()` re-issues exactly the failed step (lines 190, 137-141).
- Edge cases / failure handling: read-only settings (`!host.writable`) make the flow invisible but do not block the workspace; a failed initial settings read exposes a Retry that re-issues the shared read; a delayed credential query after disposal or invalidation is contained by a `credentialGeneration` counter.

#### packages/client/ui-settings-account/src/client/DesktopOnboarding.tsx
- The onboarding flow coordinator: the four pages, the step transition animation, the analytics events, the shared recharge request and the skip/credit confirmations.
- Non-obvious: the transition is a 40 ms fade whose `finished` promise may reject when a newer step or an unmount cancels it (lines 49-53); `reduced-motion` skips the animation entirely; the page and popup analytics events are recorded **once** per page/popup via a `shownPage`/`shownPopup` ref (lines 58-74).

#### packages/client/ui-settings-account/src/client/DesktopOnboardingEntry.tsx
- The framework-hook projection into the pure onboarding view.
- Non-obvious: on successful completion the last page is **retained** for a 180 ms exit animation (lines 38-55) and only then released; a failed completion keeps the page and the workspace hidden; `prefers-reduced-motion` removes the page immediately with no timer.

#### packages/client/ui-settings-account/src/client/OnboardingSurface.tsx
- The body-portaled onboarding stage: it makes `#root` inert and transparent for the overlay's lifetime, and restores the previous opacity on unmount.
- Non-obvious: it stores and restores the **previous** inline opacity, so an earlier overlay's state is not clobbered (lines 22-28).

#### packages/client/ui-settings-account/src/client/OnboardingWelcomeStep.tsx
- The welcome page: a required explicit "Get started", the English/Chinese and light/dark illustration pair.

#### packages/client/ui-settings-account/src/client/OnboardingCreditStep.tsx
- The credit page; the action ordering chosen on first entry is fixed (`funded ? onContinue : onRecharge` and `funded ? onRecharge : onLater`), and both buttons are disabled in the impossible states.

#### packages/client/ui-settings-account/src/client/OnboardingPurposeStep.tsx
- The work-purpose selection: two independently selectable cards that combine into a `both` value; the descriptions stay unchanged when a card is selected or deselected.

#### packages/client/ui-settings-account/src/client/OnboardingProcessStep.tsx
- The work-detail radio group with **roving focus**: arrow keys move the selection and the focus together, wrapping around, and the Enter action only appears once a choice exists.

#### packages/client/ui-settings-account/src/client/OnboardingConfirmation.tsx
- The two confirmations ("skip adding credits?" and "skip setup?"), each a focus-contained `Modal` with `backdropBlur={false}`.

#### packages/client/ui-settings-account/src/client/OnboardingIllustration.tsx
- Renders the light and dark artwork as two images; the theme selector in CSS decides which is visible.

#### packages/client/ui-settings-account/src/client/AccountOnboarding.tsx
- The credential-onboarding step: it claims the onboarding flag while mounted and completes itself as soon as the account reports `credential-stored`.

#### packages/client/ui-settings-account/src/client/SignInDialog.tsx
- The authorization dialog: sign in / add API key, the waiting state with a copyable link, the timeout and failure states, and the retry path.
- Non-obvious: the copy-link result restores its label after 2 s (lines 26-30); a clipboard failure shows "Copy failed" **without interrupting sign-in**; the network-troubleshooting copy appears **only** for the `no-response` error code (lines 37-38) and is not reused for a subsequent local failure; a `committing` attempt cannot be dismissed by Escape or the close button (line 48).

#### packages/client/ui-settings-account/src/client/SignOutDialog.tsx
- The sign-out confirmation with three impact variants (idle, running tasks, unknown) and a failure that keeps the dialog open for retry.

#### packages/client/ui-settings-account/src/client/AccountQuotaNotice.tsx
- The account's take-over of the frame-wide quota notice.
- Non-obvious design decisions: the entry **waits for the first account snapshot** rather than rendering a Toast its own timer could discard (line 61); it renders nothing while a native Platform page is showing, because the opaque view covers this document (line 68); the notice's own "Top up" calls `keepOpen()` **before** requesting the page, so a later failure cannot remount the entry and drop the page (lines 76-78); the entry releases both the hold and the page request when it unmounts, so a later failure publishes again.

#### packages/client/ui-settings-account/src/client/AccountPlatformHost.tsx
- The single `shell.overlay` entry that renders the account feature's one native Platform page; it only closes the page and notifies the owner with the reason.

#### packages/client/ui-settings-account/src/client/platform-pages.ts
- Purpose: the shared request channel between the account surfaces and their one native host.
- Key abstractions: `PlatformPage` (`'usage' | 'top-up'`), `PlatformPageExit` (`'returned' | 'superseded'`), `createPlatformPages()`.
- Non-obvious design decisions: a newer request **installs itself first** and only then retires the previous owner (`previous?.('superseded')`, line 72), so the retired owner's release cannot clear the replacement; the release is identity-safe via a token (`if (token !== own) return`, line 74) — "a stale owner can never close a page it no longer owns"; `dispose()` drops the request **without** running the owner's `onClose`, because unmounting the host closes the native view anyway.

#### packages/client/ui-settings-account/src/client/PlatformOverlay.tsx
- The Desktop native Platform viewport: the 48 px return bar, the viewport rectangle fed to the native child through a `ResizeObserver`, the loading/failure/retry states.
- Non-obvious: inertness and focus are restored in the **layout** cleanup (not the passive one) so a Modal mounted by the same commit records the restored focus before it takes its own (lines 36-45); the native `close()` failure is swallowed because "Window teardown may remove the desktop IPC receiver before React unmounts" (lines 64-66).

#### packages/client/ui-settings-account/src/client/overlay-inert.ts
- Purpose: shared inert ownership for overlapping account overlays.
- Non-obvious: a `WeakMap` ref-counts the owners per element and restores the **previous** `inert` value only when the last owner releases; the release is idempotent, so releasing twice cannot release a different active overlay.

#### packages/client/ui-settings-account/src/client/LogoutIcon.tsx
- The Figma `IcDsLogOutOutline16` glyph stored inline as SVG paths for theme-aware rendering; decorative (`aria-hidden`).

#### packages/client/ui-settings-account/src/client/locales.ts
- The account dictionary: the English object is the key source and the Chinese one is typed `Record<AccountKey, string>`, so a missing Chinese key is a compile error.

#### packages/client/ui-settings-account/src/client/locales/onboarding.ts
- The onboarding copy split into its own module; the English object is typed `Record<keyof typeof onboardingCopy, string>` against the Chinese one — a compile-time bilingual pairing check.

#### packages/client/ui-settings-account/src/client/assets.d.ts
- Ambient `*.webp` and `*.svg` module declarations (the illustrations are embedded in the account client bundle).

#### packages/client/ui-settings-account/src/client/AccountAvatar.module.css
- One rule: a round, cropped avatar image filling its box.

#### packages/client/ui-settings-account/src/client/AccountMenu.module.css
- The launcher geometry (24 px avatar, 44 px row, 36 × 36 collapsed trigger) and the wider signed-out menu rows.

#### packages/client/ui-settings-account/src/client/AccountNotice.module.css
- The stack geometry: each deeper card is centred 4 px above the preceding one and narrows by the design's 272/280 ratio; the foreground alone determines the stack height; a reduced-motion media query removes the transition.

#### packages/client/ui-settings-account/src/client/AccountSection.module.css
- The account card material (0.5 px settings-card stroke, `--dsw-radius-xl`), the balance rows, the "View on Platform" link treatment, and the signed-out prompt layout.

#### packages/client/ui-settings-account/src/client/DesktopOnboarding.module.css
- The whole onboarding visual system: the Figma-positioned welcome artwork, the 594/400 credit grid, the 2- and 3-column card grids, the animated conic-gradient selection border (a registered `--dsh-onboarding-border-angle` custom property), the brand font weights, the macOS drag-band clearance, and four responsive breakpoints.

#### packages/client/ui-settings-account/src/client/OnboardingSurface.module.css
- The overlay surface, the 180 ms exit animation, the darwin transparency, and the `-webkit-app-region` rules that clear the inherited no-drag and keep an 8 px native resize margin.

#### packages/client/ui-settings-account/src/client/PlatformOverlay.module.css
- The full-window native overlay, the Windows caption clearance (`--dsh-windows-titlebar-height`), the darwin traffic-light spacer, the return bar, and an embedded base64 loading spinner.

#### packages/client/ui-settings-account/src/client/SignInDialog.module.css
- The headless dialog geometry, the right-aligned action row, the underline link treatment and the reduced-motion spinner.

#### packages/client/ui-settings-account/tests/apply.client.spec.ts
- The account plugin in the shipped composition: browser vs Desktop sign-in carriers, the quota-notice claim, shared operations across three seats, the questionnaire prefill rules, the shared avatar load, silent successful reads vs failure-only logs, coalesced refreshes and stale-response rejection, the shared Platform page ownership, the top-up return read policy (top-up re-reads, usage does not, onboarding's return reads profile+balance but never the bonus), the bonus read/ack lifecycle, the "no polling" property, the stream-failure vs disposal distinction, and the API-key default application.

#### packages/client/ui-settings-account/tests/account.client.spec.tsx
- The account UI: no invented profile or balance data, the sign-in / cancel states, the sign-out impact matrix, the settings keycaps in the menu, the themed authorization link, the balance formatting, the bonus row's presence rules, the Platform open / retry / return-focus behaviour, the "one Settings entry = one read" rule, and the bonus notice painting under an open Settings panel and reporting its display once.

#### packages/client/ui-settings-account/tests/bonus-notices.client.spec.ts
- The bonus lifecycle in full: read only on activation and on explicit refresh (never on a timer), acknowledgement only after a presented frame, doubling backoff, survival across a re-entered session, an abandoned in-flight read not being adopted by the next account, copy refresh in place, withdrawal of an unseen card, one queued acknowledgement per order, the "no new account" credential-swap case, sign-out dropping the pending acknowledgement, and expired-award suppression.

#### packages/client/ui-settings-account/tests/onboarding-state.client.spec.ts
- The onboarding controller: bonus-only credit counting, a stable published snapshot, refusal handling, the frozen `creditFunded` decision, resumption after a controller restart, the API-key defaults applied once, the "leaves preferences changed after completion untouched" rule, write serialisation and preview, per-namespace retry ordering, and the disposal/sign-out cancellation cases.

#### packages/client/ui-settings-account/tests/desktop-onboarding.client.spec.tsx
- The flow's pages: welcome is mandatory, the credit page always offers recharge and only confirms a **known** absence of credit, the purpose cards combine, the process radiogroup's arrow keys, the "action stays mounted without native disabled dimming while a choice saves" rule (`aria-disabled` rather than `disabled`), the skip confirmations, the page-transition settlement under complete/cancel/reduced motion, and the analytics event de-duplication.

#### packages/client/ui-settings-account/tests/desktop-onboarding-entry.client.spec.tsx
- The entry: the 180 ms exit, the workspace staying inert until unmount, the loading overlay, the withholding of notices through loading and exit, and immediate removal on sign-out.

#### packages/client/ui-settings-account/tests/onboarding-surface.client.spec.tsx
- The primitive: body portaling, `#root` inert for exactly its own lifetime, restoring an earlier overlay's root state, rendering without an `#root`, revealing the root during the exit while keeping it inert, and the double-release safety of the ref-counted inert.

#### packages/client/ui-settings-account/tests/onboarding.client.spec.tsx
- The credential step: it claims onboarding while mounted, offers the API-key fallback, completes after login, and releases the claim on unmount.

#### packages/client/ui-settings-account/tests/quota-notice.client.spec.tsx
- The notice's own contract: `keepOpen()` is called **before** the page request (asserted by `invocationCallOrder`), the Modal is deferred while a Platform page is showing, the first snapshot is awaited beyond the Toast lifetime, a failed stream falls back to the Toast, and the hold is released on sign-out or on an unmount the notice never asked for.

#### packages/client/ui-settings-account/tests/quota-notice-hold.client.spec.tsx
- The composition bench: the Chat-owned quota host plus the account's shared Platform host plus the account page, all in one runtime. Covers deferring the notice behind a Settings-opened page, handing focus to the revealed Modal, deferring behind the onboarding recharge page, the newest-failure replacement rule, and the hold's release on unmount and on sign-out.

#### packages/client/ui-settings-account/tests/notice.client.spec.tsx
- The card's display signal: server copy without moving focus, the report only after a presented frame, deferral while the document is hidden, dismissal counting as seen, nothing reported when unmounted before the frame, an expired award not rendering at all, the no-frame-clock fallback, and the back cards staying mounted but inaccessible until promotion.

#### packages/client/ui-settings-account/tests/sign-in-dialog.client.spec.tsx
- The login dialog: the two choices, the timeout requiring an explicit retry, cancelling before dismissing, the `committing` attempt resisting Escape, the 2 s copy-label restore, the copy failure not interrupting sign-in, the retry path cancelling the active attempt first, and the `no-response`-only network copy.

#### packages/client/ui-settings-account/tests/sign-out-dialog.client.spec.tsx
- The sign-out impact copy matrix, the three dismissal routes, and a failure that keeps the dialog open for retry with dismissal blocked while the sign-out is in flight.

#### packages/client/ui-settings-account/tests/account-avatar.client.spec.ts
- The shared image load: successful and pending loads are shared, each failed load is retried only on request, replaced and disposed callbacks are discarded (including the same URL after sign-out), a report from a superseded attempt is ignored, and `reset()` publishes no intermediate snapshot.

#### packages/client/ui-settings-account/tests/account-refresh.client.spec.ts
- The post-return ordering: the new query starts after the pre-return one settles, a failed pre-return query does not prevent the refresh, and a failure in the new query is preserved.

#### packages/client/ui-settings-account/tests/browser-login.client.spec.ts
- Tab ownership: one navigation, closing on failure/expiry/cancellation, the blocked-popup route, a waiting frame that arrived before the initial response, the destination mapping, and a blank tab closed when the Host finishes before navigating.

#### packages/client/ui-settings-account/tests/client-metadata.client.spec.ts
- The client identity: the UTC offset as seconds east, re-sampled on every call, and a build with no version refused.

#### packages/client/ui-settings-account/tests/config.client.spec.ts
- The Host half: the contact options injected into the page bootstrap and the listener released on disposal, and the settings scope configured with `auto: false`.

#### packages/client/ui-settings-account/tests/contact-url.client.spec.ts
- The questionnaire URL: the hide/prefill pairs, percent-encoding of delimiter-bearing values, the omission of unavailable context, the HTTPS-only schema, the six unsupported fields' parameters being dropped, and the physical screen resolution rounding.

#### packages/client/ui-settings-account/tests/formatBalance.client.spec.ts
- A table of Platform currency rules including exponent notation (`0E-16`, `5e0`, `1E-8`).

#### packages/client/ui-settings-account/tests/initialization.client.spec.ts
- Default-model initialization outcomes (accepted / refused / disconnected / pending): the account stream keeps reading and the failure is logged without marking the account failed.

#### packages/client/ui-settings-account/tests/notice-transition.client.spec.ts
- The promotion animation: no animation when unavailable or under reduced motion, and the exact transform the survivor receives from its old rectangle.

#### packages/client/ui-settings-account/tests/onboarding-credentials.client.spec.ts
- The API-key presence bridge: present/absent, a preserved read failure, and a rejected missing bridge.

#### packages/client/ui-settings-account/tests/platform-pages.client.spec.ts
- The shared channel: an idle close is ignored, the owner is retired exactly once, a stale release cannot clear the replacement, a release clears without retiring, teardown drops without retiring, and a throwing subscriber does not stop the others.

#### packages/client/ui-settings-account/tests/platform-overlay-caption.client.spec.ts
- A CSS-text test: jsdom has no layout, so the spec reads `PlatformOverlay.module.css` as text and asserts the Windows caption clearance declaration — the Desktop's Application/Edit menu must not cover the return bar.

#### packages/client/ui-settings-account/tests/expected/account-en.txt
- File snapshot of the signed-in account card's rendered text in English: "Signed in to DeepSeek · Loading… · More account information · Topped-up balance · Loading… · Granted balance · Loading… · More · View usage · Top up".

#### packages/client/ui-settings-account/tests/expected/account-signed-out-en.txt
- File snapshot of the signed-out account card in English: the title, the description and the Sign in button, with no balance or Platform links present.

#### packages/client/ui-settings-account/tests/expected/account-signed-out-zh.txt
- File snapshot of the signed-out account card in Chinese: 当前未登录 DeepSeek Harness 账号 / 登录 DeepSeek Harness 账号获取专属 API Key / 登录.

#### packages/client/ui-settings-account/tests/expected/account-zh.txt
- File snapshot of the signed-in account card's rendered text in Chinese: 已登录 DeepSeek · 加载中… · 更多账号信息 · 充值余额 · 加载中… · 赠金余额 · 加载中… · 更多 · 查询用量 · 充值.

#### packages/client/ui-settings-account/tests/expected/avatar-retry.txt
- File snapshot of the six published avatar states across the retry sequence: loading, failed, loading, failed, loading, ready — pinning that a retry starts a fresh load rather than reusing the failed one.

#### packages/client/ui-settings-account/tests/expected/bonus-en.txt
- File snapshot of the account card with both wallet groups in English: ¥209.00 + $20.07 recharge and ¥5.00 + <$0.01 granted credit.

#### packages/client/ui-settings-account/tests/expected/bonus-zh.txt
- File snapshot of the account card with both wallet groups in Chinese: ¥209.00 + $20.07 充值余额 and ¥5.00 + <$0.01 赠金余额.

#### packages/client/ui-settings-account/tests/expected/details-en.txt
- File snapshot of the account card with a masked profile in English: "Harness Mock (TEST ONLY) · 138****0000 · Topped-up balance ¥1,234.56 · <$0.01".

#### packages/client/ui-settings-account/tests/expected/details-zh.txt
- File snapshot of the account card with a masked profile in Chinese: Harness Mock (TEST ONLY) · 138****0000 · 充值余额 ¥1,234.56 · <$0.01.

#### packages/client/ui-settings-account/tests/expected/expired-en.txt
- File snapshot of the credential-expiry toast in English: "You have signed out of your account, please log in again."

#### packages/client/ui-settings-account/tests/expected/expired-zh.txt
- File snapshot of the credential-expiry toast in Chinese: 登录信息已失效，请重新登录.

#### packages/client/ui-settings-account/tests/expected/login-active-error-en.txt
- File snapshot of the login dialog's error state during an active attempt in English: "Could not sign in · Could not complete the operation. Try again. · Cancel · Sign in again".

#### packages/client/ui-settings-account/tests/expected/login-active-error-zh.txt
- File snapshot of the login dialog's error state during an active attempt in Chinese: 登录失败 · 操作未完成，请重试。 · 取消 · 重新登录.

#### packages/client/ui-settings-account/tests/expected/login-copy-failed-en.txt
- File snapshot of the clipboard-failure copy inside the waiting login dialog, English: "Waiting for sign in · Page did not open automatically? Copy failed, then open it in your browser to finish signing in. · Cancel".

#### packages/client/ui-settings-account/tests/expected/login-copy-failed-zh.txt
- File snapshot of the clipboard-failure copy inside the waiting login dialog, Chinese: 等待登录 · 没有自动打开新页面？复制失败，手动打开登录页完成登录。 · 取消.

#### packages/client/ui-settings-account/tests/expected/login-en.txt
- File snapshot of the idle login dialog in English: the Get started title, the sign-in-or-API-key description and the Add API Key / Sign in actions.

#### packages/client/ui-settings-account/tests/expected/login-failed-en.txt
- File snapshot of the failed login dialog in English: "More · Could not sign in · Could not complete the operation. Try again. · Add API Key · Sign in again".

#### packages/client/ui-settings-account/tests/expected/login-no-response-en.txt
- File snapshot of the network-troubleshooting login copy in English: "Could not sign in · Something went wrong. Please check your network connection and try again. · Add API Key · Sign in again".

#### packages/client/ui-settings-account/tests/expected/login-no-response-zh.txt
- File snapshot of the network-troubleshooting login copy in Chinese: 登录失败 · 操作未完成，可能是网络异常，请检查你的网络状况后重试 · 添加 API Key · 重新登录.

#### packages/client/ui-settings-account/tests/expected/login-timeout-en.txt
- File snapshot of the timed-out login dialog in English: "Sign in timed out · Sign in again to continue. · Add API Key · Sign in again".

#### packages/client/ui-settings-account/tests/expected/login-timeout-zh.txt
- File snapshot of the timed-out login dialog in Chinese: 登录已超时 · 请重新登录后继续操作。 · 添加 API Key · 重新登录.

#### packages/client/ui-settings-account/tests/expected/login-waiting-en.txt
- File snapshot of the waiting-for-sign-in dialog in English, with the copyable link button: "Waiting for sign in · Page did not open automatically? Copy sign-in link, then open it in your browser to finish signing in. · Cancel".

#### packages/client/ui-settings-account/tests/expected/login-waiting-zh.txt
- File snapshot of the waiting-for-sign-in dialog in Chinese: 等待登录 · 没有自动打开新页面？复制登录链接，手动打开登录页完成登录。 · 取消.

#### packages/client/ui-settings-account/tests/expected/login-zh.txt
- File snapshot of the idle login dialog in Chinese: 开始使用 · 登录 DeepSeek 账号，或添加 API Key，即可开始使用。你的项目和文件保存在本地。 · 添加 API Key · 登录.

#### packages/client/ui-settings-account/tests/expected/menu-en.txt
- File snapshot of the signed-in account menu's three items in English: Settings, Feedback, Sign out.

#### packages/client/ui-settings-account/tests/expected/menu-signed-out-en.txt
- File snapshot of the signed-out account menu's three items in English: Settings, Feedback, Sign in.

#### packages/client/ui-settings-account/tests/expected/menu-signed-out-zh.txt
- File snapshot of the signed-out account menu's three items in Chinese: 设置, 意见反馈, 登录.

#### packages/client/ui-settings-account/tests/expected/menu-zh.txt
- File snapshot of the signed-in account menu's three items in Chinese: 设置, 意见反馈, 退出登录.

#### packages/client/ui-settings-account/tests/expected/notice.txt
- File snapshot of the bonus notice card's text: "Bonus creditedServer copy 5.00" — pinning that the server's message renders verbatim after the localized title.

#### packages/client/ui-settings-account/tests/expected/onboarding-credit-en.txt
- File snapshot of the English onboarding credit page: the Add credits heading, the token-billing description, and the Add credits / Next / Back / Skip actions.

#### packages/client/ui-settings-account/tests/expected/onboarding-credit.txt
- File snapshot of the Chinese onboarding credit page: 准备可用额度 and its description, with 去充值 / 下一步 / 上一步 / 跳过.

#### packages/client/ui-settings-account/tests/expected/onboarding-preferences.json
- File snapshot of the whole purpose × process matrix (9 cases) of applied preferences: office always maps to transcriptView compact, usage compact and Coding Tools off, while development and both map usage to detailed and Coding Tools on.

#### packages/client/ui-settings-account/tests/expected/onboarding-process-en.txt
- File snapshot of the English onboarding work-detail page: the heading, the "this only changes how progress is shown" note and the three option descriptions.

#### packages/client/ui-settings-account/tests/expected/onboarding-process.txt
- File snapshot of the Chinese onboarding work-detail page: 你希望看到多少工作过程？ and the 聚焦结果 / 关键细节 / 完整过程 option descriptions.

#### packages/client/ui-settings-account/tests/expected/onboarding-purpose-en.txt
- File snapshot of the English onboarding purpose page: the split heading "What would you like DeepSeek Harness to help with?" and the two card titles and descriptions.

#### packages/client/ui-settings-account/tests/expected/onboarding-purpose.txt
- File snapshot of the Chinese onboarding purpose page: 你希望 DeepSeek Harness 帮你做什么？ and the 办公与创作 / 代码与开发 card descriptions.

#### packages/client/ui-settings-account/tests/expected/onboarding-welcome-en.txt
- File snapshot of the English onboarding welcome page: the "Welcome to DeepSeek Harness" heading, the local-folder description and the Get started action.

#### packages/client/ui-settings-account/tests/expected/onboarding-welcome.txt
- File snapshot of the Chinese onboarding welcome page: 欢迎使用 DeepSeek Harness, the local-folder description and the 开始设置 action.

#### packages/client/ui-settings-account/tests/expected/platform-error-en.txt
- File snapshot of the native Platform load-failure surface in English: "Back to DeepSeek Harness · Could not complete the operation. Try again. · Retry".

#### packages/client/ui-settings-account/tests/expected/platform-error-zh.txt
- File snapshot of the native Platform load-failure surface in Chinese: 返回 DeepSeek Harness · 操作未完成，请重试 · 重试.

#### packages/client/ui-settings-account/tests/expected/platform-header-en.txt
- File snapshot of the native Platform return bar in English: the single "Back to DeepSeek Harness" label.

#### packages/client/ui-settings-account/tests/expected/platform-header-zh.txt
- File snapshot of the native Platform return bar in Chinese: 返回 DeepSeek Harness.

#### packages/client/ui-settings-account/tests/expected/profile-before-balance.txt
- File snapshot of the account card with the profile ready and the balance still loading: two separate pending balance rows (recharge and granted credit) and no zero balance shown.

#### packages/client/ui-settings-account/tests/expected/sign-out-idle-en.txt
- File snapshot of the sign-out confirmation with no running tasks in English: "Signing out will not delete any data. You can sign in to this account again."

#### packages/client/ui-settings-account/tests/expected/sign-out-idle-zh.txt
- File snapshot of the sign-out confirmation with no running tasks in Chinese: 退出登录不会丢失任何数据，你仍可以登录此账号。

#### packages/client/ui-settings-account/tests/expected/sign-out-running-en.txt
- File snapshot of the sign-out confirmation with running tasks in English: "Tasks are currently running. Signing out will interrupt them. Sign out now?"

#### packages/client/ui-settings-account/tests/expected/sign-out-running-zh.txt
- File snapshot of the sign-out confirmation with running tasks in Chinese: 当前有进程正在执行中，点击"退出登录"，将会打断进程，是否即刻退出登录？

#### packages/client/ui-settings-account/tests/expected/sign-out-unknown-en.txt
- File snapshot of the sign-out confirmation with an undeterminable task state in English: "Could not check running tasks. Signing out may interrupt tasks using this account. Sign out now?"

#### packages/client/ui-settings-account/tests/expected/sign-out-unknown-zh.txt
- File snapshot of the sign-out confirmation with an undeterminable task state in Chinese: 暂时无法确认任务状态。退出登录可能会中断使用此账号的任务，是否继续？

---

## Ideas worth stealing

- **A write that lands invalidates the read that was already on the wire** — `packages/client/ui-settings/src/client/settings-mirror.ts:183` (`if (generation !== this.generation) continue`) and `packages/client/ui-settings/src/client/settings-mirror.ts:141` (`acceptView` marks a rerun). The mirror keeps a monotonic `generation`; a read whose generation is stale is discarded rather than published, and the write that superseded it schedules a re-read. *Why it matters for August*: the August Settings panel writes several namespaces, and a describe that resolves after a commit would otherwise resurrect a stale document. This is the general "last writer's answer invalidates in-flight readers" fence, expressed in about ten lines.

- **The in-flight slot is cleared in the same synchronous segment that observes the rerun flag** — `packages/client/ui-settings/src/client/settings-mirror.ts:158-171`. The comment names the exact bug: clearing the slot in a promise `.finally()` leaves a one-microtask gap in which a `load()` marks a rerun nobody reads, and the refresh never reaches the wire. *Why it matters*: August's own snapshot stores (brain facts, session lists) have the same "invalidate while in flight" shape, and this is the microtask-level detail that decides whether a refresh is lost.

- **A refused write re-reads the Host; a superseded refusal does not** — `packages/client/ui-settings/src/client/config-form.ts:151-155`. `recover(generation)` returns early unless the refusal is the latest write. *Why it matters*: August's brain-config panel writes keys from several surfaces; a stale rejection triggering a re-read would fight the current writer.

- **Only the latest settlement publishes; a superseded write's revision is handed forward** — `packages/client/ui-settings/src/client/config-form.ts:140-145`. The superseded write stores `pendingRevision = response.value.revision` so the queued successor takes its fence from it rather than from a stale mirror. *Why it matters*: this is the "optimistic concurrency with a write queue" pattern August would need for any panel that saves several fields from one form.

- **A staged editor keeps its own revision, so a conflict preserves the draft** — `packages/client/ui-settings/src/client/config-form.ts:129` and `packages/client/ui-settings/src/client/config-form-types.ts:48-52`. `mutate(ops, expectedRevision?)` lets an editor pass the revision it read *before* editing, so a concurrent Host change is detected rather than silently overwritten. *Why it matters*: the August Settings panel should refuse to clobber a value the user did not see, and should say so.

- **"Presence in the user layer" is what marks an override — comparing values cannot** — `packages/client/ui-settings/src/client/config-form-types.ts:22-26`. The snapshot carries `base` (the composition layer), `user` (the raw stored layer) and `value` (resolved); a field whose value equals the default is still an override if the user layer holds it. *Why it matters*: August's brain-config panel wants an "Overridden" badge plus a "Reset to default" button; presence, not equality, is the only correct test.

- **A schema envelope the client cannot rehydrate vouches for no section** — `packages/client/ui-settings/src/client/config-form.ts:210-217`. The decoder refuses non-object sections and treats an unrehydratable envelope exactly like a schema-invalid value, so an invalid wire value never replaces an accepted one. *Why it matters*: fail-closed on a malformed schema is the right default for any August setting that gates a capability.

- **A page exists only while the Host serves its namespace** — `packages/client/ui-settings/src/client/config-form.ts:308-327` (`whileServed`). A deployment that never composed the owner shows no trace of the page, and a namespace the Host stops serving withdraws it. *Why it matters*: August's settings surface should show a preference row only when the feature is actually loaded — a cheap, declarative "the UI mirrors the deployment" rule.

- **A failed refresh keeps the last good value standing** — `packages/client/ui-settings/src/client/settings-mirror.ts:186-194`. With a held view the status stays `ready` and only the `error` field reports the miss; with no view the status falls back to `idle` so `ensure()` retries. *Why it matters*: a transient Host hiccup must not blank the August settings UI, and the two cases (never-read vs read-once) need opposite retry behaviour.

- **"Acknowledged" means "the user actually saw a painted frame"** — `packages/client/ui-settings-account/src/client/AccountNotice.tsx:28-47` and `packages/client/ui-settings-account/src/client/AccountNotice.tsx:102-121`. The signal is a `requestAnimationFrame` followed by a `setTimeout(0)` (the frame callback runs before its paint; the following task runs after it), plus a visible document. The card measures no cover, so a card painted under a translucent overlay counts. *Why it matters*: this is the mechanism August needs for any "mark as read" side effect — a durable flag set on click is wrong, and a durable flag set on a timeout is also wrong.

- **An acknowledgement retry doubles with a ceiling and never outlives the session** — `packages/client/ui-settings-account/src/client/bonus-notices.ts:207-210`. A protocol-level `false` settles the order with no retry; a transport failure backs off `delay → min(delay*2, max)` for the rest of the signed-in lifecycle. *Why it matters*: a persisted "shown" flag would suppress a notice the user never saw after a crash; a session-scoped retry queue is the honest version.

- **A newer read supersedes an older one, so a credential swapped in place is named by a fresh read** — `packages/client/ui-settings-account/src/client/bonus-notices.ts:169-182` and `packages/client/ui-settings-account/src/client/bonus-notices.ts:143-151`. The scope object identity plus a `readGeneration` counter drop an in-flight answer that a newer frame has overtaken; an answer naming a different account clears the previous account's card and queue. *Why it matters*: August's account/tenant switching has the same shape — a stale profile read must not repaint the previous tenant's data.

- **Identity-safe release for a single-owner native surface** — `packages/client/ui-settings-account/src/client/platform-pages.ts:64-79`. A newer request installs itself *before* retiring the previous owner, and the release is guarded by a per-request token, so a stale owner can never close a page it no longer owns. *Why it matters*: August's desktop shell owns one native webview; a panel that unmounts late must not close the panel that replaced it.

- **Ref-counted `inert` ownership across overlapping overlays** — `packages/client/ui-settings-account/src/client/overlay-inert.ts:9-22`. A `WeakMap` of `{count, previous}` restores the element's *original* `inert` value only when the last owner releases, and the release is idempotent. *Why it matters*: two August overlays (an onboarding step and a native view) can overlap; whichever unmounts first must not unlock the background.

- **Progress feedback that does not flicker: a minimum-visible hold, and a confirmation window measured from visibility** — `packages/client/ui-settings-general/src/client/SettingsRoot.tsx:29` and `packages/client/ui-settings-general/src/client/SettingsRoot.tsx:179-195` (the 800 ms connecting hold), with `packages/client/ui-settings-general/src/client/SettingsRoot.tsx:171-177` (the 2 s recovery window started when the recovered pill becomes *visible*, not when the state changes). *Why it matters*: this is the whole "minimalist but reassuring" recipe in two timers — a state that resolves instantly still shows its pill, and the confirmation is not cut short by the hold that preceded it.

- **A reveal is a transition, not a jump** — `packages/client/ui-settings-account/src/client/DesktopOnboardingEntry.tsx:38-55`. The last page is retained for 180 ms while the workspace fades in, and `prefers-reduced-motion` removes it immediately with no timer. *Why it matters*: the August workspace reveal after first-run setup deserves the same treatment.

- **One browser image load shared by every surface, with superseded attempts ignored** — `packages/client/ui-settings-account/src/client/account-avatar.ts:62-77` and `packages/client/ui-settings-account/src/client/account-avatar.ts:44-48`. The `this.image !== image` guard drops a replaced attempt's callbacks, `referrerPolicy = 'no-referrer'` is set on the load, and a rendered-image failure is reported back into the shared state so both surfaces fall back together. *Why it matters*: an August avatar rendered in two places should be one network request with one state machine, not two `<img>` tags that can disagree.

- **Cache a projection on (ledger version, locale revision), not on identity** — `packages/client/ui-settings-general/src/client/index.ts:133-149`. The nav rows are recomputed only when the slot ledger version or the locale revision moves, and the resulting array keeps a stable identity so a memoized list does not re-render on every locale tick. *Why it matters*: the August sidebar/settings navigation is the same shape; stable snapshot identity is what makes `useSyncExternalStore` cheap.

- **A client package spells a Host namespace literally, and says why** — `packages/client/ui-settings-agent-loop/src/client/agent-loop-card-controller.ts:10-13` ("a client package must not depend on a Host package") and `packages/client/ui-settings-agent-loop/src/client/index.ts:12-14` (cross-plugin collaboration goes through the service, never a value import). *Why it matters*: the August frontend has the same build-graph hazard; the comment is the enforcement mechanism.

- **One honest knob for a loop's parallelism** — `packages/client/ui-settings-agent-loop/src/client/agent-loop-card-controller.ts:19-22` and `packages/client/ui-settings-agent-loop/src/client/AgentLoopCard.tsx:26-38`. The whole `agent-loop` user-facing surface is one number — the parallel-safe tool-call cap per step — with an "Overridden" badge, a reset, and a numeric field that blocks the save on non-numeric text. *Why it matters*: if August ever exposes a parallel-tool-call cap, this is the minimal shape: one field, staged until Save, with the deployment default and the user's override both visible.

- **A pure-CSS invariant can still be pinned by a test** — `packages/client/ui-settings-account/tests/platform-overlay-caption.client.spec.ts:11-23`. jsdom has no layout, so the spec reads the CSS file as text and asserts the declaration that keeps the Desktop caption menu from covering the return bar. *Why it matters*: a small, honest trick for the class of "the geometry is right" defects that no DOM assertion can see.

- **A whole behaviour matrix captured as a file snapshot** — `packages/client/ui-settings-account/tests/onboarding-state.client.spec.ts:298-308` writing `expected/onboarding-preferences.json`. The nine-cell purpose × process matrix of applied preferences is stored as data, so a behaviour change is a reviewable diff rather than a prose claim. *Why it matters*: August's brain-config key→default→range matrix has exactly this shape and would benefit from the same snapshot.

---

## Files skipped (with reasons)

- `packages/client/ui-settings-account/src/client/assets/onboarding-welcome.webp` — binary WebP illustration (~415 KB). I read its container header (`52 49 46 46 … 57 45 42 50` = RIFF/WEBP) and its exact byte size; the pixel payload cannot be read line by line and the README documents it as a bundled Figma illustration layer.
- `packages/client/ui-settings-account/src/client/assets/onboarding-welcome-dark.webp` — same, ~408 KB, the dark-theme variant of the welcome illustration.
- `packages/client/ui-settings-account/src/client/assets/onboarding-welcome-zh.webp` — same, ~393 KB, the Chinese welcome illustration.
- `packages/client/ui-settings-account/src/client/assets/onboarding-welcome-zh-dark.webp` — same, ~390 KB, the Chinese dark welcome illustration.
- `packages/client/ui-settings-account/src/client/assets/onboarding-recharge.webp` — same, ~182 KB, the recharge illustration.
- `packages/client/ui-settings-account/src/client/assets/onboarding-recharge-dark.webp` — same, ~207 KB, the dark recharge illustration.
- `packages/client/ui-settings-account/src/client/assets/onboarding-recharge-zh.webp` — same, ~180 KB, the Chinese recharge illustration.
- `packages/client/ui-settings-account/src/client/assets/onboarding-recharge-zh-dark.webp` — same, ~225 KB, the Chinese dark recharge illustration.

(All eight were opened enough to establish what they are — RIFF/WEBP container, byte length, and the importing component — but binary image data was not decoded line by line.)

---

## Uncertainties

- **`@deepseek-ai/dsh-client-ui-primitives` is outside this shard.** The `SettingsFormModel`, `SettingsForm`, `SettingsValueField` and `settingsNumberField` that the agent-loop page uses are defined there. I could see only their *use*: the staged form's `edit`/`resetField`/`save`/`discard` actions, the `overridden` flag, the `invalid` flag, the `writable`/`available`/`dirty`/`saving`/`failed` shell fields, and the "invalid number blocks the save" rule (from `packages/client/ui-settings-agent-loop/src/client/AgentLoopCard.tsx:36` and `packages/client/ui-settings-agent-loop/tests/card.client.spec.tsx:57-65`). I could not verify how the primitives implement the "empty field saves as a reset" and "leaving the page drops the draft" behaviours the README claims; those are asserted in the primitives' own tests, not here.
- **The Host side of the settings transport is outside this shard.** `@deepseek-ai/dsh-settings` (the `settings` service, `settings.describe`, `settings.mutate`, the `settings/document-updated` event) and `@deepseek-ai/dsh-api-remotes` (the wire types) are not in this shard. I inferred the wire contract from the type usage here: `SettingsNamespaceView` carries `ns`, `schema`, `value`, `base`, `user`, `applies`, `secrets` and `revision`; `SettingsPathOpView` is `{op:'set'|'unset', path:string[], value?}`; `settings.mutate(namespace, ops, revision)` returns `{ok, value}` where `value` is a namespace view.
- **The `agent-loop` Host package is outside this shard.** I could not confirm the default value or the accepted range of `maxParallelToolCalls`, nor whether the Host validates it. The client side only shows it as an optional number with a per-namespace schema.
- **The Desktop preload bridges are declared here but implemented elsewhere.** `dshDesktop.protocolVersion`/`updates`, `dshDesktop.deviceInfo`, `dshPlatform`, `dshOnboarding.hasApiKey`/`setActive` and `__DSH_TRANSPORT__.streamBaseUrl` are all consumed in this shard but defined in `apps/desktop`, which is not in it. I verified the *client* contract (optional-global presence checks, `protocolVersion === 1` gating, the boolean-only credential reader) but not the native implementations.
- **`DSH_CLIENT_VERSION` injection is outside this shard.** I verified it is read at runtime from `process.env` (`packages/client/ui-settings-general/src/client/CurrentVersionRow.tsx:11`) and that a build without it omits the version row, but the bundler substitution that fills it lives elsewhere.
- **The eight WebP illustrations were not decoded.** I confirmed their container type and size and read the CSS that selects the light/dark variant (`packages/client/ui-settings-account/src/client/DesktopOnboarding.module.css:100-102`), but I did not verify the artwork's content, transparency or the "3× lossless" claim in the README.
- **The `dsh-client-store` `SnapshotStore` semantics** (stable snapshot identity, subscriber isolation, the `[client-store] subscriber failed:` log) are used throughout this shard but the store itself is not in it. I read the *contract* it provides from the call sites and the test assertions (`packages/client/ui-settings/tests/config-form.client.spec.ts:306-351`), not its implementation.
- **`settings/general.item` is declared at runtime by ui-settings-general but typed in ui-settings** (`packages/client/ui-settings/src/client/contract/slots.ts:88-92`); I did not find a `SlotMap` entry for it in `contract/slots.ts`, so the type is declared but the slot map entry itself is contributed at runtime — I could not confirm whether the type or the runtime map is the authority, and the general package's `apply.client.spec.ts:105` asserts only the runtime spec `{ kind: 'list', scope: 'root' }`.
