# deepseek-harness / dsh-client-sidebar#1

## Shard shape

This shard is the **browser-side composition layer** of deepseek-harness: 115 files across four sibling packages under `packages/client/` — `ui-renderer` (29), `ui-session` (13), `ui-sidebar-browser` (47) and `ui-sidebar` (25). It contains **no agent loop, no provider code, no model request assembly and no tool-calling machinery at all** (every README in the shard states "Model Experience: None" and "KV Cache effect: None"), so the lenses that matter here are the UI/UX, config, testing and lifecycle ones, plus two transferable lifecycle mechanisms that the harness elsewhere relies on.

The spine is a **slot/component composition system**. `ui-renderer` owns the boundary between a framework-free object layer and React: a `SlotRegistry` service over a pure `SlotCore` (`registry.ts`) plus the React renderer that turns declared slots into outlets (`scoped-slots.tsx`). Business plugins never wire subscriptions: they declare slots, and the renderer binds bare observable sources into selector hooks at the render position (`bind.ts`, `bindings.tsx`). `ui-session` is the concrete adapter that feeds that machinery — it materialises the Session Controller's state into root and per-session "standard sources" (`useSessions`, `useSession`, `useProjection`, `useAccess`) and owns a process-local pending-interaction and completion-unread policy. `ui-sidebar` and `ui-sidebar-browser` are two consumers of the same system: the navigation shell (brand row, New Session, collapse rail, panel rows) and a sandboxed HTTP(S) browser tab, each registering into named sidebar seats through `slots.inject()`.

Two cross-cutting design rules run through all four packages: **(a) every failure has a named home** — `SlotAssemblyError` escapes entry boundaries (fail-loud), `SlotOwnershipError` refuses an undeclared slot, `StaleAuthorizationError` refuses a binding that outlived its registration, and a registrant's own crash is *contained* to its boundary and reported through one supervision channel; **(b) identity is the unit of caching and remounting** — WeakMap-keyed caches, per-entry React keys, per-generation session keys, and revision-partitioned locale functions, so that a memoised subtree neither resubscribes nor re-renders when nothing it depends on changed.

---

## Per-file notes

### packages/client/ui-renderer/src/client/scoped-slots.tsx
- **Purpose:** The React renderer for declarative slots — 1332 lines implementing `createSlotRenderer()`, the outlets, per-entry boundaries, chain election, factory occurrences and the standard-kit synthesis.
- **Key abstractions:** `SlotOutlet` (one per declared slot), `SlotErrorBoundary` / `FactoryErrorBoundary`, `guarded()` (the per-entry dispatch wrapper), `standardKit()` (what a plugin component receives), `standardProps()` (root + scope materialisation), `useMaybeIncarnation()` (session-maybe identity), `FactoryOccurrenceContext` / `FactoryAncestryContext`.
- **Data flow:** `host.subscribe(key)` + `host.getVersion(key)` drive a uSES version tick → the outlet re-reads `host.entriesOf(key)` → per-kind dispatch (single / keyed / list / chain) → each winner is wrapped by `guarded()` → `standardKit()` assembles kit + inject + owner props → the component renders.
- **Non-obvious design decisions:** (1) The boundary must wrap the Entry *element*, not live inside it — inject factories and kit synthesis run in the entry body and must land in the per-entry fallback rather than escaping to the tree above (`:1121-1123`). (2) Shadowing kinds **abdicate** on crash so the cell falls to its next survivor; chain kinds report *without* abdicating, because retiring a crashed elected entry would change the static crash face (`:1128-1132`). (3) The anchor wrapper `[data-slot="<key>"]` rides the *outlet*, not the dispatch outcome, so its presence never flickers with registration churn (`:1089-1094`). (4) `t` freshness rides function identity: a locale switch mints a *new* function reference per namespace so `React.memo` components re-render through ordinary shallow comparison — no separate invalidation channel (`:293-317`).
- **Edge cases / failure handling:** a chain selector that throws is a registrant contract breach but runs *before* the entry's boundary exists — it degrades to a decline so the chain and its fallback stay intact, and the breach is reported (`:1204-1214`); recursive factory rendering is refused (`:996`); duplicate props between provided and received are refused (`:852-858`); a strict session slot with no scope binding throws rather than rendering empty (`:1115-1117`).
- **Surprising:** the "session-maybe" scope is an **adoption** model, not a hold-forever model — a blank incarnation adopts the first session *without* remounting (so a blank shell's DOM survives), but a later switch to a different session remounts, and dropping back to no-session remounts into a fresh blank that will adopt again (`:690-765`).

### packages/client/ui-renderer/src/client/registry.ts
- **Purpose:** `SlotRegistry`, the Cordis service over the pure `SlotCore` — the layer that needs a live application (event bridge, injection, renderer installation, store-instance lifecycle).
- **Key abstractions:** `SlotRegistry` (extends `Service`), `StoreAxisRecord` (handle → scope + refcount + instances), `FactoryStoreAxis` (weak render-time records + enumerable committed ones), `hostFace()` (the domain-neutral face the renderer talks to).
- **Data flow:** `register()` → mint an exclusive store handle if the option was a factory → core write (all load-time validation throws *here*, before this layer commits) → acquire the store on the axis → the caller gets an idempotent disposer that releases the store.
- **Non-obvious design decisions:** (1) `register`/`registerFactory` are **prototype** methods, never instance arrows — the Cordis service proxy binds `this.ctx` to the *caller's* context at call time, which is what routes the effect and the unload cascade into the caller's fiber; an arrow property would freeze `this` and silently break per-plugin disposal (`:174-180`). (2) The `locale` face is exposed as a **live getter**, not a captured value, because the face installs (and under HMR swaps) on the locale plugin's own fiber lifetime (`:536-541`). (3) Scope death releases *memory* instances but never clears persisted state — persistence belongs to the durable scope key (`:354-359`).
- **Edge cases / failure handling:** `install()` and `installLocale()` are **boot-once** and throw on a second call (`:279-287`, `:296-304`); `renderSlot` has three fail-loud boot-order checks — wrong key, renderer not installed, no `root` registration (`:382-396`); duplicate root standard prop names are refused and the published binding is left untouched (`:718-734`).
- **Surprising:** `inject(key, cb)` reconciles against a **declaration epoch**, so a same-tick collapse + redeclaration is observed correctly, and a failure caller retires the injection *permanently* — a delayed setup failure never retries on a later declaration (`:209-271`).

### packages/client/ui-renderer/src/client/bindings.tsx
- **Purpose:** The React-side binding layer — host/root/scope contexts, the per-source hook cache, and the keyed hook.
- **Key abstractions:** `HostContext`, `RootBindingContext`, `ScopeBindingContext`, `observableHook()` (WeakMap-cached per source), `keyedObservableHook()`, `RootStandardProvider`, `ScopeProvider`.
- **Data flow:** a plugin hands over *bare* observable sources in typed `hooks`; `observableHook` wraps them in `useSyncExternalStoreWithSelector` once per source and caches the hook in a WeakMap, so spreading a fresh kit object per render never churns a child's subscription.
- **Non-obvious design decisions:** the keyed hook is **one** function with three call forms — `(key, member)`, `(key, selector, equal?)` and `(selector, equal?)` — disambiguated by the *type* of the arguments, not by separate functions (`:122-139`); an absent optional source still costs exactly one uSES call, so React hook order never changes when the source appears or disappears (`:79-102`).
- **Edge cases / failure handling:** every context read throws `SlotAssemblyError` when used outside its provider — a miswired shell must fail loud, not degrade (`:21-48`).
- **Surprising:** `ScopeProvider` subscribes to `host.scopeRevision` *before* resolving the adapter, so a scope adapter that is swapped at runtime rebinds mounted consumers without a remount (`scoped-slots.client.spec.tsx:1149-1169`).

### packages/client/ui-renderer/src/client/bind.ts
- **Purpose:** The single uSES bridge in the whole client stack — `bindSnapshotSelector`.
- **Key abstractions:** `useSyncExternalStoreWithSelector` from the `use-sync-external-store/shim/with-selector` subpath.
- **Data flow:** subscribe/getSnapshot are captured once per source into stable closures (re-binding `this` for method-based sources) and handed to the shim with a selector and optional equality.
- **Non-obvious design decisions:** capturing the closures *once* is what guarantees "components never resubscribe across renders" — the test asserts the subscribe call count is unchanged after re-renders (`tests/bind.client.spec.tsx:77-87`).
- **Edge cases / failure handling:** equality defaults to `Object.is`, so an unrelated field change is a bail-out, not a re-render.
- **Surprising:** the file states it is "the ONE hook constructor in the client stack" — engines and hosts traffic in bare sources, and binding happens only on the React side.

### packages/client/ui-renderer/src/client/index.ts
- **Purpose:** The plugin entry — installs the registry and renderer, reflects the `ctx.uiRenderer.mount` service.
- **Key abstractions:** `UiRendererService` (the mount face), `BootHandoff`, `mountApp`.
- **Data flow:** `apply(ctx)` → `new SlotRegistry(ctx)` → `slots.install(createSlotRenderer())` → `ctx.reflect.provide('uiRenderer', { mount })` → `mount(container)` hydrates or creates a root → `buildRenderApp({ctx})()` renders `renderSlot('root')`.
- **Non-obvious design decisions:** when a `[data-dsh-boot]` element exists, the app is **hydrated** through `BootHandoff`, a one-frame pass-through that renders the boot DOM unchanged and flips to the app in a `useLayoutEffect` — the loading page is preserved instead of being thrown away (`:59-83`). Without a boot element the root is created and the render is flushed synchronously (`flushSync`) so the first frame is not deferred.
- **Edge cases / failure handling:** the disposer unmounts the React root; the service and renderer are retracted with their fiber (tested in `tests/ui-renderer.client.spec.tsx:97-102`).
- **Surprising:** the boot DOM is passed through `dangerouslySetInnerHTML` from a captured snapshot — the framework-free page is re-created inside React rather than adopted.

### packages/client/ui-renderer/src/client/app.tsx
- **Purpose:** The whole real-UI assembly closure — 22 lines.
- **Key abstractions:** `AssemblyDeps`, `buildRenderApp`.
- **Data flow:** returns a closure that calls `ctx.slots.renderSlot('root', {})`; everything else is composed inside the registered root occupant.
- **Non-obvious design decisions:** there is exactly **one** ctx-level slot render in the whole application; child slots render through the component props face, and the guard is runtime-enforced for dynamically composed callers (`:382-388` in `registry.ts`).
- **Edge cases / failure handling:** with no registry the call throws (asserted in `tests/app.client.spec.tsx:23-26`).
- **Surprising:** the file is deliberately tiny — the "real UI" is entirely a slot composition problem, not a component tree problem.

### packages/client/ui-renderer/src/client/errors.ts
- **Purpose:** The single renderer failure category.
- **Key abstractions:** `SlotAssemblyError extends Error`.
- **Data flow:** thrown by every context read, kit synthesis and scope check; both error boundaries rethrow it from `getDerivedStateFromError` so it escapes to the app instead of being contained.
- **Non-obvious design decisions:** one class, checked by `instanceof` in two boundaries — the category *is* the policy ("assembly errors rethrow; registrant errors are contained").
- **Edge cases / failure handling:** a miswired shell must fail loud rather than degrade into fallbacks.
- **Surprising:** it is 4 lines, and that is the whole point — the failure taxonomy is one bit.

### packages/client/ui-renderer/src/client/use-sync-external-store.d.ts
- **Purpose:** Ambient typings for `use-sync-external-store/shim/with-selector.js` — the runtime package ships no types.
- **Key abstractions:** one `declare module` with the five-parameter `useSyncExternalStoreWithSelector` signature.
- **Data flow:** types only; no runtime effect.
- **Non-obvious design decisions:** the declaration is for the **extensionless shim subpath** (`.js`), matching what both the runtime and DefinitelyTyped export maps expose.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the file is a type-level vendoring of a dependency the package does not own.

### packages/client/ui-renderer/src/index.ts
- **Purpose:** Host loader entry — `apply()` is a no-op.
- **Key abstractions:** none.
- **Data flow:** the package is browser-only; the host loader registers nothing.
- **Non-obvious design decisions:** every one of the four packages in this shard ships the same inert host half, so the "client" and "host" compilation surfaces stay separable.
- **Edge cases / failure handling:** n/a.
- **Surprising:** a test in each package asserts the host entry stays inert (`tests/apply.host.spec.ts`, `tests/ui-renderer.client.spec.tsx:53-55`).

### packages/client/ui-renderer/README.md
- **Purpose:** Package reference for the browser UI renderer.
- **Key abstractions:** documents the mount contract, the business-plugin contract, and the two current limits.
- **Data flow:** prose only.
- **Non-obvious design decisions:** the README states the first application frame waits for *every* client entry (the boot kernel hands over the mount point only after the loader roster settles) and that slot rendering has no Suspense integration or per-entry lazy loading.
- **Edge cases / failure handling:** the "Known Limitations" section is the honest-limit register every package here follows.
- **Surprising:** the README has a "Model Experience" and "KV Cache effect" section that reads "None" — the repo has a uniform documentation contract even for packages with no model surface.

### packages/client/ui-renderer/README.zh.md
- **Purpose:** Chinese mirror of the renderer README.
- **Key abstractions:** same section structure.
- **Data flow:** prose only.
- **Non-obvious design decisions:** none beyond mirroring.
- **Edge cases / failure handling:** mirrors the same two limits.
- **Surprising:** the README pair is hash-locked by `README.i18n.yaml`, so a one-sided edit fails the i18n gate.

### packages/client/ui-renderer/README.i18n.yaml
- **Purpose:** Per-heading EN/ZH content hashes for `README.md`.
- **Key abstractions:** a YAML map from heading path → `{en, zh}` hash.
- **Data flow:** `pnpm run verify-translation-pairing --write <file>` regenerates it.
- **Non-obvious design decisions:** hashing *sections* rather than whole files means an added section fails pairing without invalidating the rest.
- **Edge cases / failure handling:** n/a.
- **Surprising:** this is a real, enforced bilingual-consistency gate — a doc drift detector for the whole repo.

### packages/client/ui-renderer/package.json
- **Purpose:** Client plugin manifest.
- **Key abstractions:** `dsh.client.platform: web`, `immediately: true`; exports `.`, `./client`, `./src/*`, `./locale/*.json`.
- **Data flow:** the loader reads `dsh.client` to place the plugin in the client roster.
- **Non-obvious design decisions:** React, React DOM and uSES are **devDependencies** — the browser identity of React is owned by the web shell's static module table, and this package arrives as a dynamic bundle that must share it.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the package publishes a `./src/*` export, so consumers can import raw sources — a deliberate escape hatch.

### packages/client/ui-renderer/locale/en.json
- **Purpose:** The package's English meta dictionary.
- **Key abstractions:** `meta.title` only.
- **Data flow:** the locale plugin reads it to name the package in a plugin list.
- **Non-obvious design decisions:** the *user-facing* copy of this package is zero — every string lives in a consumer package.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the file carries no `meta.description` at all (the zh file does) — the meta key sets are not symmetric.

### packages/client/ui-renderer/locale/zh.json
- **Purpose:** The package's Chinese meta dictionary.
- **Key abstractions:** `meta.title` ("界面渲染") and `meta.description`.
- **Data flow:** the locale plugin reads it to name the package in a plugin list.
- **Non-obvious design decisions:** the zh file is the richer one — it carries a description the en file omits.
- **Edge cases / failure handling:** n/a.
- **Surprising:** n/a.

### packages/client/ui-renderer/tsconfig.json
- **Purpose:** The TypeScript project for the package.
- **Key abstractions:** `rootDir: src`, `outDir: lib/types`, `extends: ../../../tsconfig.base.client.json`.
- **Data flow:** project references to the vendored cordis and to `../ui-slots`.
- **Non-obvious design decisions:** the vendored cordis is a **project reference**, not an npm dependency — the runtime identity is pinned in-tree.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the `include` is only `src`; the `tests/` directory is not part of the type project.

### packages/client/ui-renderer/tsdown.config.ts
- **Purpose:** The bundle configuration.
- **Key abstractions:** `clientBundle(import.meta.dirname, ['lib/types/index.js'])`.
- **Data flow:** `tsdown` emits `lib/index.js`, `lib/client.js` and the type declarations.
- **Non-obvious design decisions:** it delegates to a shared helper so every client package produces the same bundle shape — the second argument names the type entry the bundle must preserve.
- **Edge cases / failure handling:** n/a.
- **Surprising:** three lines, identical in all four packages of this shard.

### packages/client/ui-renderer/tests/app.client.spec.tsx
- **Purpose:** Tests `buildRenderApp`.
- **Key abstractions:** `SlotTestRuntime.create()` + `runtime.root.declare`.
- **Data flow:** declares a `root` occupant, builds the app factory, renders it.
- **Non-obvious design decisions:** the "fails loud without a registry" case is the important one — a misconfigured composition must not render blank.
- **Edge cases / failure handling:** asserts `renderApp()` throws on a bare `Context`.
- **Surprising:** the suite is 34 lines — the file under test is 22.

### packages/client/ui-renderer/tests/bind.client.spec.tsx
- **Purpose:** The uSES bridge contract.
- **Key abstractions:** a hand-rolled `makeSource` with exact subscribe counting.
- **Data flow:** mutates the source, asserts render counts and subscription counts.
- **Non-obvious design decisions:** equality is kept local rather than imported, to avoid a reverse dependency from the UI renderer to the runtime — the comment says so explicitly.
- **Edge cases / failure handling:** covers StrictMode double-mount cleanup, method-style sources (`this` binding), and selector memoisation against `getSnapshot` spam.
- **Surprising:** the "does not resubscribe across re-renders" test is the only proof that the bridge's closure-capture is load-bearing.

### packages/client/ui-renderer/tests/registry.client.spec.ts
- **Purpose:** 947 lines — the SlotRegistry "terminal-design account".
- **Key abstractions:** `boot()` fixture, `captureHost()` (installs a capturing renderer), `fakeHandle()` (a store-handle stub with a create counter).
- **Data flow:** drives register/inject/install/renderSlot against a real Cordis `Context`.
- **Non-obvious design decisions:** the suite is organised as a *terminal design* document: each describe block names the terminal state ("load-time validation", "entry-unload cascade", "event bridge"). The "separates %s memory when a Session reopens before previous Context cleanup" case (`:767-815`) is the sharpest: a same-id session reopened before the old Context is cleaned up must get **separate memory** while the **persisted** value carries over, and `clearPersisted` must never be called.
- **Edge cases / failure handling:** generator-based inject callbacks roll back earlier yielded registrations when a later one fails; a delayed setup failure is re-thrown asynchronously so later slot listeners still run.
- **Surprising:** `expect(() => bench.erased.install(...)).toThrow(/already installed/)` — installation is boot-once, and the throw is the contract.

### packages/client/ui-renderer/tests/scoped-slots.client.spec.tsx
- **Purpose:** 1170 lines over a *behavioural fake host* — the renderer's own semantics without the ledger.
- **Key abstractions:** `makeHost()` (a fake `SlotRendererHost` that mirrors the ledger projection), `mountRoot()`, `mountChainRoot()`.
- **Data flow:** register fake entries → render → assert DOM and store state.
- **Non-obvious design decisions:** the overlay-chain test (`:587-620`) is the sharpest in the shard: with `overlay: true` the fallback stays **mounted** and keeps its uncontrolled DOM state through a takeover (the same `<input>` node, `mounted` called once); without overlay the takeover discards the fallback state. The fake host explicitly documents the split between `entriesOf` (raw) and `entriesOfSlot` (shadowing winners).
- **Edge cases / failure handling:** a chain selector that throws is contained to its entry; a crashing list entry blacks out alone; a strict session slot with no session throws.
- **Surprising:** the "session-maybe adoption identity" block (`:1082-1169`) proves three transitions: blank → first id keeps the incarnation, first id → second id remounts, and id → blank remounts into a fresh blank that adopts again — the comment states the rule: "state that must SURVIVE a switch belongs in session-bound sources (machine, store, hooks)".

### packages/client/ui-renderer/tests/scoped-slots-real-core.client.spec.tsx
- **Purpose:** The same renderer over the *real* `SlotCore`.
- **Key abstractions:** `hostOver(core)` — a passthrough host that drops the store/session seats.
- **Data flow:** real `core.register`, real `core.subscribe` (microtask-batched), real `core.entries`.
- **Non-obvious design decisions:** the suite exists because the fake-host suite cannot vouch for real-core semantics; it pins microtask batching ("two same-tick mutations, one batch") and **mutation-stable `entries()` references** across a sibling-key mutation — the property every inject/renderSlot cache keys on.
- **Edge cases / failure handling:** a retained closure that outlives both the tree and the registration throws `StaleAuthorizationError`.
- **Surprising:** the file notes it deliberately does *not* merge a private `'root'` row, because the aggregate client program already carries the authoritative declaration and a private merge would TS2717-collide.

### packages/client/ui-renderer/tests/factory-slots.client.spec.tsx
- **Purpose:** 693 lines covering reusable Component Factories.
- **Key abstractions:** `registerFactory()` helper, `DefaultView` / `CustomView` / `CrashingView`, `counterHandle()`.
- **Data flow:** register a factory definition → `renderFactorySlot(name, props, { slots })` at a render position → an occurrence materialises, mints its own exclusive store handle, and binds the selected local component.
- **Non-obvious design decisions:** **crash attribution is a first-class rule**: a crash in the shared definition or its *fallback* local component is reported against the *definition*; a crash in a *caller-selected* local component is reported against the *caller's* registration; and a nested factory keeps the caller's ownership (`:441-550`). The definition is never abdicated by a factory error — a bad occurrence must not retire a shared definition.
- **Edge cases / failure handling:** recursive factory render, undeclared local slot names, duplicate props, and a disposed definition all fail loudly; a failed session factory is retried after the session incarnation changes.
- **Surprising:** the exclusive store factory refuses to declare persistence (`registry.ts:650-654`) — a per-occurrence store has nothing durable to write to.

### packages/client/ui-renderer/tests/inline-slots.client.spec.tsx
- **Purpose:** Anchor-tag rules for `inline: true` slots.
- **Key abstractions:** `setup()` over `SlotTestRuntime`.
- **Data flow:** declare inline slots → register crashing entries → assert the anchor tag.
- **Non-obvious design decisions:** an inline slot's anchor is a `<span>` (it must sit inside inline content), an ordinary slot's is a `<div>`, and an *exhausted* cell keeps the inline tag rather than falling back to a block.
- **Edge cases / failure handling:** after the declaring factory is disposed, the retained child anchor stays in the DOM (same node) but renders empty and the fallback is not shown.
- **Surprising:** the anchor's *presence* outlives the declaration — the addressable seam does not flicker with registration churn.

### packages/client/ui-renderer/tests/keyed-hook-member.client.spec.tsx
- **Purpose:** The keyed hook's call forms.
- **Key abstractions:** a `vi.fn` resolver recording `(key, member)` calls.
- **Data flow:** `useAccess('s1', 'session/fork')` resolves a source and binds it.
- **Non-obvious design decisions:** the resolver is called with **one** argument when only a key is given and **two** when a member is named — the machinery probes the family, it does not keep a per-member map.
- **Edge cases / failure handling:** an absent family returns `undefined` for every call form, including the selector forms.
- **Surprising:** the same key can address two different sources (whole-object vs one member) with no ambiguity.

### packages/client/ui-renderer/tests/reconnect.client.spec.tsx
- **Purpose:** Proves the mounted root survives a transport reconnect.
- **Key abstractions:** `RemoteMock`, `TestClient.start({ roster: webApp, mount: true })`.
- **Data flow:** mount the assembled client → capture the `[data-slot="root"]` node → `client.connection.reconnect()` → assert the connection generation advanced and the **same DOM node** is still there.
- **Non-obvious design decisions:** the assertion is on node *identity*, not on presence — a reconnect must not tear down and rebuild the UI tree.
- **Edge cases / failure handling:** n/a.
- **Surprising:** this is the only test in the shard that exercises the whole assembled web client; it is 27 lines and takes 60 s.

### packages/client/ui-renderer/tests/session-provider.client.spec.tsx
- **Purpose:** `SessionProvider` semantics.
- **Key abstractions:** a fake host whose `bindingSource(reference)` maps a `SessionReference` to a binding source.
- **Data flow:** the owner supplies a reference → the provider resolves the binding → `ScopeBindingProvider` publishes it → the subtree binds `useSession` from it.
- **Non-obvious design decisions:** the provider **inherits** the outer binding unless the owner passes an explicit `session` prop — `Object.hasOwn(props, 'session')` decides, so an explicit `session={undefined}` is a *deliberate absence* and not an inheritance (`:512-521`). A same-id replacement generation resets local state (`:174-194`).
- **Edge cases / failure handling:** an adapter without a `renderArea` fails loud; nested providers bind independently and the outer reference is restored for siblings.
- **Surprising:** `release` on the reference is *not* called when the provider unmounts — the provider reads the binding, it does not own the reference.

### packages/client/ui-renderer/tests/stale-authorization.client.spec.tsx
- **Purpose:** The lifetime of a retained render binding.
- **Key abstractions:** `mountCapturing()` — a root entry that leaks its `renderSlot` binding to the test.
- **Data flow:** live binding renders; after the entry is disposed the same closure throws.
- **Non-obvious design decisions:** the **stale check precedes the ownership check** — a dead binding throws `StaleAuthorizationError` even for a key it never declared (`:127-134`), because liveness is the more fundamental fact. An HMR reload mints a *fresh* binding; the old one stays dead rather than being revived (`:136-158`).
- **Edge cases / failure handling:** this is the mechanism that stops a stale closure from rendering into a slot that has moved on.
- **Surprising:** the suite's setup unmounts the view *before* disposing the entry, because an empty `root` makes the live root outlet rethrow its boot-order failure — the test comment says so.

### packages/client/ui-renderer/tests/ui-renderer.client.spec.tsx
- **Purpose:** The plugin's `apply()` contract.
- **Key abstractions:** `bench()` — a real Cordis context with the plugin applied; `stabilize()`.
- **Data flow:** plugin apply → `ctx.get('uiRenderer')` → `mount(el)`.
- **Non-obvious design decisions:** the boot-hydration test watches the boot element with a `MutationObserver` and asserts **no mutation record targets it** — the boot DOM is preserved byte-for-byte while the app takes over.
- **Edge cases / failure handling:** the disposer unmounts; disposing the fiber retracts `ctx.get('uiRenderer')` and makes `renderSlot('root')` throw "not installed".
- **Surprising:** `ctx.get('slots')` works for Service-class plugins but `ctx.get('uiRenderer')` works only because the service was `reflect.provide`d — two different registration mechanisms in one file.

### packages/client/ui-renderer/tests/use-projection.client.spec.tsx
- **Purpose:** Delivery of the `useProjection` seat.
- **Key abstractions:** a fake host with a `keyedHooks.projection` resolver over a `cells` map.
- **Data flow:** the session binding's keyed hook family resolves a key to a source; the component calls `useProjection('test/marks')`.
- **Non-obvious design decisions:** the projection is delivered as a **keyed** standard hook — the same mechanism as `useSession`, not a special seat.
- **Edge cases / failure handling:** an unresolved key reads `undefined` rather than throwing; the selector overload runs over the whole value and over `undefined` when absent.
- **Surprising:** the file's header comment points at `docs/subsystems/session-projection.md` — the projection subsystem is a documented, separate concept.

### packages/client/ui-session/src/client/index.ts
- **Purpose:** The Session Controller adapter for React and session-scoped slots — 721 lines and the most policy-dense file in the shard.
- **Key abstractions:** `UiSession` (a Cordis `Service`), `PendingInteractionDomain`, `SessionStatusSnapshot`, `SessionSourceDescriptor` (a *declared roster* + per-binding resolver), `BUILTIN_SOURCE`.
- **Data flow:** `apply(ctx)` → `new UiSession(ctx, ctx.sessions)` → contributes root hooks (`sessions`, `sessionStatus`, keyed `sessionRetainInfo` / `sessionAccess`) → installs the `session` scope adapter → contributes the session-scoped `access` keyed hook. A session binding is materialised by resolving every descriptor against the binding and merging the results into one `StandardSourceBinding`.
- **Non-obvious design decisions:** (1) A contribution declares its **roster** (`hooks: ['session']`) and the framework *rejects* an undeclared member, a declared-but-missing member, and a duplicate at the final prop name — so a plugin cannot silently add or shadow a standard prop (`:614-668`). (2) `rebuildBindings()` assembles **all** descriptor snapshots before notifying any subscriber, and a failing contribution leaves every other binding untouched (`:419-432`). (3) Pending interactions are published per session with a **deterministic cross-domain precedence**, larger wins, and `>=` so a later domain of equal precedence replaces an earlier one (`:468-488`). (4) Teardown removes the visible values **first** and only then awaits the owner delegates (`:405-415`).
- **Edge cases / failure handling:** `bindingSource()` refuses a reference that is not active in this Controller generation (`:353-361`); a duplicate pending-interaction key throws; a failing subscriber is contained and reported (`notifySubscribers` from `dsh-client-store`).
- **Surprising:** the running-state policy — "Subagent catalog rows and retained subagent fallback rows do not establish Host running state" (`:503-509`) — and the completion-unread rule: a stop observed **outside** the main view becomes unread, and the main view's own activity acknowledges it (`:490-498`, `:510-512`).

### packages/client/ui-session/src/client/session-provider.tsx
- **Purpose:** Session-owned rendering semantics for the `SessionProvider` seat — 19 lines.
- **Key abstractions:** `renderSessionArea(binding, { empty, children })`.
- **Data flow:** the renderer binds the adapter's `renderArea` to the current scope binding; the domain decides what "no session" looks like.
- **Non-obvious design decisions:** the *domain* owns the empty/children decision, so the renderer never has to know what "no session" means for this domain.
- **Edge cases / failure handling:** an absent key renders the empty branch; an explicit `session={undefined}` renders nothing when no empty branch is given.
- **Surprising:** the renderer code imports this file across packages (`ui-renderer/tests/session-provider.client.spec.tsx:13`) — the domain's rendering semantics are testable without the domain's plugin.

### packages/client/ui-session/README.md
- **Purpose:** Package reference for the session adapter.
- **Key abstractions:** documents the access hooks and the one stated limit.
- **Data flow:** prose only.
- **Non-obvious design decisions:** the README draws a careful line between three access hooks — root `useSessionAccess(sessionId, action)`, session-scoped `useAccess(action)`, and a *separate* `useRemoteAccess(action)` for the `global` resource, "so neither shadows the other".
- **Edge cases / failure handling:** the session-maybe `useAccess` returns `undefined` while no session is bound, "which callers treat as not allowed".
- **Surprising:** the stated limit — "Pending interactions are process-local projections; the owning Remote waterfall must replay an outstanding request after a browser reconnect" — is exactly the kind of limitation August's approval doors also have.

### packages/client/ui-session/README.zh.md
- **Purpose:** Chinese mirror of the ui-session README.
- **Key abstractions:** same sections.
- **Data flow:** prose only.
- **Non-obvious design decisions:** mirrors the three-hook distinction.
- **Edge cases / failure handling:** mirrors the process-local pending-interaction limit.
- **Surprising:** n/a.

### packages/client/ui-session/README.i18n.yaml
- **Purpose:** Per-heading EN/ZH hashes for the ui-session README.
- **Key abstractions:** heading path → hash pair.
- **Data flow:** regenerated by the same `verify-translation-pairing` script.
- **Non-obvious design decisions:** none beyond the shared mechanism.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the dev-note section hash (`e67f633dc6fe7773`) is **identical across all four packages** — the "Dev Note: None" boilerplate is a shared, hash-locked block.

### packages/client/ui-session/package.json
- **Purpose:** Client plugin manifest.
- **Key abstractions:** `dsh.client.inject` lists remote-access, remotes, session-controller and ui-renderer — the plugin declares its own dependencies in the manifest.
- **Data flow:** the loader activates the plugin after those four.
- **Non-obvious design decisions:** the plugin's *source* dependencies (cordis, session types) are devDependencies; the four `inject` entries are the real ordering contract.
- **Edge cases / failure handling:** n/a.
- **Surprising:** `ui-session` injects `ui-renderer` — the session adapter depends on the renderer's slot service, so the renderer is the more primitive layer.

### packages/client/ui-session/locale/en.json
- **Purpose:** The package's English meta dictionary.
- **Key abstractions:** `meta.title` only ("ui-session").
- **Data flow:** the locale plugin names the package.
- **Non-obvious design decisions:** the real copy of this package is in `src/client/index.ts`'s consumers; the package itself ships no user strings.
- **Edge cases / failure handling:** n/a.
- **Surprising:** n/a.

### packages/client/ui-session/locale/zh.json
- **Purpose:** The package's Chinese meta dictionary.
- **Key abstractions:** `meta.title` ("会话界面连接") and `meta.description`.
- **Data flow:** the locale plugin names the package.
- **Non-obvious design decisions:** same asymmetry as the renderer's locale pair — zh carries a description the en file omits.
- **Edge cases / failure handling:** n/a.
- **Surprising:** n/a.

### packages/client/ui-session/tsconfig.json
- **Purpose:** The TypeScript project for the package.
- **Key abstractions:** `rootDir: src`, `outDir: lib/types`, base client config.
- **Data flow:** project references to cordis, the three api client projects (`remotes`, `remote-access`, `session-controller`), `core/session`, `util/values`, `store`, `ui-renderer` and `ui-slots`.
- **Non-obvious design decisions:** the reference list is the *real* dependency graph; `package.json`'s devDependencies would not tell you that `util/values` (for `WeakMapWithValues`) is required.
- **Edge cases / failure handling:** n/a.
- **Surprising:** `WeakMapWithValues` — a WeakMap that can enumerate its values — is used for the binding cache, because the binding cache must be *drainable* on teardown.

### packages/client/ui-session/tsdown.config.ts
- **Purpose:** The bundle configuration.
- **Key abstractions:** `clientBundle(import.meta.dirname, ['lib/types/index.js'])`.
- **Data flow:** `tsdown` emits `lib/index.js` and `lib/client.js`.
- **Non-obvious design decisions:** identical to the renderer's, so the packages' client bundles are interchangeable in shape.
- **Edge cases / failure handling:** n/a.
- **Surprising:** n/a.

### packages/client/ui-session/tests/ui-session.client.spec.ts
- **Purpose:** 766 lines over `UiSession`.
- **Key abstractions:** `createSessionsBench()` — a fake `ISessions` with a list store, binding resolver, retain-info store and a status-event emitter.
- **Data flow:** constructs the service against the bench and drives retain/status/contribution events.
- **Non-obvious design decisions:** the bench's `reference()` getter **throws** once released ("Session reference is released") — a released reference is a programming error, not a state (`:142-155`).
- **Edge cases / failure handling:** the suite covers the main-view retention watcher moving between sessions, explicit absence staying independent of catalog changes, foreign/released references being rejected, a same-id replacement source surviving the old generation's cleanup, a failing contribution leaving all sources untouched, and the whole pending-interaction precedence matrix.
- **Surprising:** "removes active values before awaiting their teardown delegation" (`:685-708`) is asserted explicitly — the visible state is dropped first so a hanging delegate cannot keep a dead request on screen.

### packages/client/ui-session/tests/status-controller.client.spec.ts
- **Purpose:** Running-state ownership across the **real** Controller catalog.
- **Key abstractions:** `createClientTest({ roster: webApp.closure([...]) })`, the Remote mock's `session/list` and `session/projections` endpoints, and a `session/follow` stream.
- **Data flow:** mock a catalog that contains only a parent, with a child visible only as a subagent catalog row → assert the child's status is `running: undefined` → emit `api-session/status` events → assert the transitions.
- **Non-obvious design decisions:** the child exists in `projections.subagentCatalog` but not in the session list, and the status map still carries an entry for it once an event establishes it — a subagent is tracked without being a listed session.
- **Edge cases / failure handling:** the main view's retention acknowledges the completion (the child never appears in `list.ids` and `completionUnread` clears).
- **Surprising:** this is the only test in the shard that touches the *subagent* concept at all — and it is about **not** treating a subagent catalog row as a running session.

### packages/client/ui-session/src/index.ts
- **Purpose:** Host loader entry — `apply()` is a no-op.
- **Key abstractions:** none.
- **Data flow:** browser-only plugin.
- **Non-obvious design decisions:** n/a.
- **Edge cases / failure handling:** n/a.
- **Surprising:** n/a.

### packages/client/ui-sidebar-browser/src/client/browser/BrowserController.ts
- **Purpose:** Carrier-independent tab commands and renderer-facing state.
- **Key abstractions:** `BrowserController` (a `HostObservable<BrowserControllerState>`), `BrowserInjected` (the plain Slot callbacks), `createBrowserControllers()` (the per-tab registry).
- **Data flow:** `mount(request)` → create/reuse a `BrowserController` per tab id → `controller.mount(viewportId)` attaches the presentation → `controller.start(initialUrl)` consumes the typed-open address **once** → later commands go through `loadUrl`/`goBack`/`goForward`/`reload`/`setSandbox`.
- **Non-obvious design decisions:** (1) **A saved checkpoint alone never starts a page** — `start()` only navigates from an explicitly supplied initial URL, and the saved address is offered through `restore()` as a user action (`:94-104`). (2) The controller subscribes to the *frame* and republishes a merged snapshot, deriving `restoreTarget` from the checkpoint whenever the frame has no target. (3) `rebind(actions)` redirects checkpoint writes to a replacement session binding without recreating the controller (`:140`).
- **Edge cases / failure handling:** every command is a no-op after disposal; late provider callbacks (`persist`, `openRequested`) are ignored after `dispose()`; the controller's `forget` only deletes saved navigation when the tab is **not** in the layout any more — "Plugin unload also aborts occurrences; only layout removal deletes saved navigation" (`:235-239`).
- **Surprising:** the same tab id can be re-mounted with a *different* `AbortSignal`; the registry treats that as a replacement occurrence and disposes the old controller, so an old occurrence can never delete its replacement.

### packages/client/ui-sidebar-browser/src/client/browser/url.ts
- **Purpose:** The HTTP(S) allowlist — 45 lines, one pure function.
- **Key abstractions:** `BrowserTarget`, `BrowserAddressFailure` (`'empty' | 'invalid' | 'protocol' | 'credentials' | 'application-origin'`), `parseBrowserAddress`.
- **Data flow:** raw input → trim → length cap → scheme detection → `new URL` → credentials check → protocol allowlist → origin check → canonical target.
- **Non-obvious design decisions:** (1) A scheme is only "explicit" if it is followed by something that is not a port number, so `example.com:8443/path` is treated as a host, not as the `example.com:` scheme (`:29`). (2) The **DSH application's own origin is refused** — the embedded browser may not open the app that embeds it. (3) An unparseable application origin cannot grant access to a target (the `catch` silently allows the navigation).
- **Edge cases / failure handling:** every refusal is a *typed* reason, not a boolean, so the UI can show a specific message.
- **Surprising:** `MAX_BROWSER_URL_LENGTH = 16 * 1024` exists to bound **persisted** navigation state, not just parsing.

### packages/client/ui-sidebar-browser/src/client/browser/BrowserNavigation.ts
- **Purpose:** Bounded application-known history and the iframe observation state machine.
- **Key abstractions:** `BrowserNavigation`, `MAX_BROWSER_HISTORY = 100`.
- **Data flow:** `navigate/back/forward/reload` produce a `request { revision, target }` and set the status to `loading`; `frameLoaded(revision)` classifies the observation.
- **Non-obvious design decisions:** the state machine is **three-state**: the first load for a revision is `known` (the app's URL is authoritative), a *second* load for the same revision is `unknown` (the page navigated somewhere the app cannot read) (`:120-128`). Once `unknown`, Back and Forward are refused entirely.
- **Edge cases / failure handling:** a frame load for a stale revision is ignored; `navigate` discards the forward branch and trims the history to 100.
- **Surprising:** the same file both owns the history and owns the *epistemic* status of the address — the mechanism is a "the app can no longer trust its own view of state" flag.

### packages/client/ui-sidebar-browser/src/client/browser/BrowserFrame.ts
- **Purpose:** The carrier-neutral navigation state contract.
- **Key abstractions:** `BrowserFrameState` (target, `address: 'empty'|'requested'|'observed'|'unknown'`, loading, canGoBack/Forward, error, sandboxEnabled), `BrowserSandboxControl`, `BrowserFrame`, `emptyBrowserFrame()`.
- **Data flow:** both carriers (iframe and Electron) implement this interface and publish the same state shape, so the toolbar is carrier-agnostic.
- **Non-obvious design decisions:** `sandboxEnabled` is `boolean | undefined` — `undefined` means *this provider has no sandbox control*, which the toolbar renders as "no toggle" (Desktop has no embedding sandbox).
- **Edge cases / failure handling:** `dispose()` is documented as joining repeated calls.
- **Surprising:** the four-state `address` enum mixes "what the app asked for" (`requested`) with "what the app observed" (`observed`) — the interface itself distinguishes intent from fact.

### packages/client/ui-sidebar-browser/src/client/browser/BrowserPage.ts
- **Purpose:** The two-face composition contract.
- **Key abstractions:** `BrowserPageOptions`, `BrowserPage`, `BrowserPageFactory`.
- **Data flow:** the factory receives `initial`, `persist` and `openRequested` and returns a `frame` (navigation) plus a `presentation` (DOM).
- **Non-obvious design decisions:** persistence is deliberately **not** part of the live navigation interface — "persistence does not enter the live navigation interface" — so a carrier cannot accidentally own durability.
- **Edge cases / failure handling:** the owning controller disposes the frame; the UI only mounts the presentation.
- **Surprising:** a factory constructs an *idle* provider — "saved navigation waits for an explicit frame command".

### packages/client/ui-sidebar-browser/src/client/browser/BrowserPersistence.ts
- **Purpose:** Serializable tab state, independent from live frame state.
- **Key abstractions:** `BrowserTabState`, `BrowserNavigationStatus`, `BrowserFailure`, `currentBrowserTarget()`, `browserAddressCheckpoint()`.
- **Data flow:** the frame persists a `BrowserTabState`; the store keeps one per tab id.
- **Non-obvious design decisions:** the Electron carrier's checkpoint is **address-only** — `browserAddressCheckpoint` keeps a single entry and no native history, because "Restart restoration does not recover page memory, unsaved forms or Chromium's history stack".
- **Edge cases / failure handling:** the `index < 0` case is the explicit "no address" state.
- **Surprising:** two carriers, two checkpoint shapes, one type — the difference is absorbed by the shape of the state.

### packages/client/ui-sidebar-browser/src/client/browser/IframeImpl.ts
- **Purpose:** The iframe navigation provider.
- **Key abstractions:** `IframeImpl implements BrowserFrame`, `BrowserNavigation`, `SnapshotStore<BrowserFrameState>`.
- **Data flow:** `loadUrl` → `BrowserNavigation.navigate/reload` → `presentation.show({target, revision, sandboxed})` → the iframe's `load` event → `handleLoaded(revision)` → `navigation.frameLoaded` → `publish()`.
- **Non-obvious design decisions:** the sandbox toggle is **transient and per occurrence** — toggling it forces a reload so the change takes effect, and it is never persisted (`:74-82`).
- **Edge cases / failure handling:** a load failure is published only for the **current** revision (`:39-43`); after disposal every method is inert.
- **Surprising:** the iframe error event is best-effort — browsers conceal many iframe failures — so the notice is cleared by the next controlled load.

### packages/client/ui-sidebar-browser/src/client/browser/store.ts
- **Purpose:** The persisted Browser tab store.
- **Key abstractions:** `BrowserState { byTab }`, `createBrowserStore()` returning an `EngineStoreHandle`.
- **Data flow:** `replace(tabId, state)` writes a checkpoint; `forget(tabId)` removes one tab's entry (rebuilding the map rather than deleting in place, for immutability).
- **Non-obvious design decisions:** the persist key is a versioned string, `dsh.sidebar-browser.v1`.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the store is registered on **two** slots (body and title) — the body owns the writes, the title only reads.

### packages/client/ui-sidebar-browser/src/client/index.ts
- **Purpose:** Plugin apply — registers the Browser tab type in the right Sidebar.
- **Key abstractions:** `installFrames(scope, factory)` (the per-scope frame installer), the `dshDesktop` carrier probe, the shortcut registration.
- **Data flow:** `apply(ctx)` → bind the locale → register the `browser.new` shortcut → create the store → register the tab type (with `keepMounted` **only** on desktop) → `slots.inject('sidebar.right.pane.tab', ...)` registering `BrowserBody` with an `inject` factory that creates one controller per session id → `slots.inject('sidebar.right.pane.tab.title', ...)` registering `BrowserTitle`.
- **Non-obvious design decisions:** (1) The desktop carrier is detected by `globalThis.dshDesktop?.protocolVersion === 1` — a **versioned** protocol probe, not a platform check. (2) `keepMounted` is set only on desktop, so the Sidebar preserves the webview's DOM across tab changes, session switches, collapse and floating. (3) The shortcut's `resolve` refuses with a localized reason when there is no session target.
- **Edge cases / failure handling:** the frame installer disposes every controller on unload; the desktop branch waits for `workspaces` before it can resolve a storage partition.
- **Surprising:** the same `injectProps` shape is reused for the body and for the title — one injected face, two seats.

### packages/client/ui-sidebar-browser/src/client/definition.tsx
- **Purpose:** The static Browser tab type and guide entry.
- **Key abstractions:** `BROWSER_KIND`, `BROWSER_ID`, `browserDefinition(t)`.
- **Data flow:** the definition is registered with `sidebarRightTabs`; its `title` and guide `title`/`description` are lazy thunks reading the live locale.
- **Non-obvious design decisions:** the guide entry names the `browser.new` **command id**, so the guide button and the keyboard shortcut are the same action; `multiple: true` and `priority: 'builtin'`.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the copy is locale-live through thunks — a locale switch does not re-register the type.

### packages/client/ui-sidebar-browser/src/client/locales.ts
- **Purpose:** The Browser dictionary.
- **Key abstractions:** `zh` (the key-set source of truth), `en satisfies Record<SidebarBrowserKey, string>`, `SidebarBrowserKey`.
- **Data flow:** registered into the locale plugin under the `sidebarBrowser` namespace; the `LocaleNamespaceMap` merge makes the keys type-checked at every call site.
- **Non-obvious design decisions:** every parser failure has its own message key (`error.empty`, `error.invalid`, `error.protocol`, `error.credentials`, `error.application-origin`), which is why `url.ts` returns typed reasons.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the `en` dictionary is *checked complete against the zh key set* by the type system, not by a runtime test.

### packages/client/ui-sidebar-browser/src/client/pages.ts
- **Purpose:** Assembles the iframe page.
- **Key abstractions:** `createIframePage(options)`.
- **Data flow:** creates the `IframePresentation` with three callbacks (`loaded`, `failed`, `remounted`) and the `IframeImpl` that consumes them.
- **Non-obvious design decisions:** a **remount** (the body was re-mounted into a new container) triggers `frame.reload()` — the page is reloaded, not restored, because the iframe element is new.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the two objects are mutually referential through closures — the page is a tiny wiring diagram.

### packages/client/ui-sidebar-browser/src/client/electron/ElectronWebViewImpl.ts
- **Purpose:** Electron navigation and guest lifetime — 271 lines, the most concurrency-dense file in the shard.
- **Key abstractions:** `ElectronWebViewImpl implements BrowserFrame`, `AbortController` triples (lifetime / guest / attachment), `DesktopBrowserBridge`.
- **Data flow:** `loadUrl` → `pending = target` → `initialize()` → resolve the workspace → `bridge.acquire(workspaceKey)` → create the `<webview>` element → install native listeners → `loadPending()` → `loadURL(url)` → native events → `observeReady()` → publish and persist.
- **Non-obvious design decisions:** (1) A **lease that resolves after cancellation is still released** — the abort check happens after `acquire` resolves and the lease is handed straight back (`:147-150`). (2) A superseded or `ERR_ABORTED` load promise is **ignored**; only an active navigation rejection is published as an error (`:190-201`). (3) The lease-bearing bootstrap document is not a user history entry — `clearHistory()` is called on the first observed document (`:212-216`). (4) The frame persists an **address-only** checkpoint, never Chromium's history.
- **Edge cases / failure handling:** `render-process-gone` and `destroyed` drop the guest and publish a failure; a `did-fail-load` with `errorCode === -3` (aborted) is ignored; acquisition failure, native command failure and observation failure all degrade to a published error with retry still available.
- **Surprising:** `dispose()` awaits `Promise.all([this.dropGuest(), this.initializing])` and then **every outstanding lease release** — the disposal promise is the join of the whole lease ledger.

### packages/client/ui-sidebar-browser/src/client/electron/ElectronWebviewPresentation.ts
- **Purpose:** The `<webview>` tag's DOM.
- **Key abstractions:** `WebviewElement` (the subset of the tag API used), `ElectronPresentationEvents` (mounted/unmounted).
- **Data flow:** `mount(viewportId)` → find the container → `events.mounted()` (the frame attaches) → later `createElement(reservation)` + `present(element)`.
- **Non-obvious design decisions:** the element is created **detached** with `src="about:blank#<lease>"` and `partition=<reservation.partition>`, and only then attached — so the guest never renders before the main process has approved it. The container's DOM ancestors must remain connected for page retention.
- **Edge cases / failure handling:** `mount` throws if the container is not mounted; `clear()` destroys only the guest DOM and leaves the container (a replacement may reuse it).
- **Surprising:** `mount`/`unmount` are *not* the frame's attach/detach — the frame's `attach()` may recreate a lost guest, and ordinary Sidebar hiding emits neither event.

### packages/client/ui-sidebar-browser/src/client/electron/pages.ts
- **Purpose:** Assembles the Electron page.
- **Key abstractions:** `createElectronPage(options, bridge, workspace)`.
- **Data flow:** the presentation's `mounted`/`unmounted` events call `frame.attach()` / `frame.detach()`.
- **Non-obvious design decisions:** guest creation waits for mounting — "idle Electron provider; guest creation waits for mounting and navigation".
- **Edge cases / failure handling:** n/a.
- **Surprising:** the webview is only created when the Sidebar actually shows the tab.

### packages/client/ui-sidebar-browser/src/client/electron/workspace.ts
- **Purpose:** Resolve the CWD-keyed Electron storage partition.
- **Key abstractions:** `browserWorkspace(source, sessionId, signal)`.
- **Data flow:** wait for the workspace list's `phase === 'ready'` → find the workspace whose `sessionIds` contains the session → return `cwd:<path>`, else `session:<id>`.
- **Non-obvious design decisions:** the grouping key is the workspace's **canonical CWD path**, not its record id — so renaming a workspace does not split the storage partition, and two workspace records for the same directory share one partition.
- **Edge cases / failure handling:** the readiness wait rejects with the caller's own `AbortSignal.reason` (the comment says the reason is preserved deliberately), and the subscription is removed on both settle and abort.
- **Surprising:** a session with no resolved workspace is isolated under `session:<id>` — the fallback is a *private* partition, not a shared default.

### packages/client/ui-sidebar-browser/src/client/view/BrowserBody.tsx
- **Purpose:** The common browser chrome.
- **Key abstractions:** `BrowserBodyProps`, `useBrowserDraft(url, revision)`, `SandboxPolicyIcon`.
- **Data flow:** reads `useBrowserState(tab.id)` (a keyed hook), `useStore` for the saved checkpoint, mounts the page into a `useId()`-named viewport in a `useLayoutEffect`, and renders the toolbar, the restore panel, the placeholder and the failure strips.
- **Non-obvious design decisions:** (1) The address input is a **draft** that is discarded whenever the target changes — `useBrowserDraft` keeps the edit only while the `addressRevision` matches (`:40-44`), so a navigation resets a half-typed URL. (2) A **rejected** initial URL stays in the input for editing (the draft's revision matches the failed attempt). (3) The sandbox toggle is only rendered when the provider exposes one (`sandboxEnabled !== undefined`).
- **Edge cases / failure handling:** `aria-busy={frame.loading}` on the content region; the load-failure strip is `role="status"`, the address-failure strip is `role="alert"` — a *policy* refusal is an alert, a *transport* failure is a status.
- **Surprising:** the "open externally" button is **disabled** when the address is `unknown` — the app will not hand a URL it cannot read to the system browser.

### packages/client/ui-sidebar-browser/src/client/view/IframePresentation.ts
- **Purpose:** The iframe DOM and revision-tagged load observations.
- **Key abstractions:** `WEB_BROWSER_SANDBOX`, `IframePresentationEvents`, `IframeDocument`.
- **Data flow:** `show({target, revision, sandboxed})` → render a fresh `<iframe>` into the mounted host → `load`/`error` listeners carry the revision.
- **Non-obvious design decisions:** the sandbox attribute is a **fixed constant** and is only *added* when sandboxed — disabling removes the attribute entirely. `referrerPolicy = 'no-referrer'`. The element is re-created on every navigation (so a stale load event from the old element is ignored by the `this.element === element` check).
- **Edge cases / failure handling:** `mount` throws if the viewport is not mounted; the load and error listeners check element identity before reporting.
- **Surprising:** the class of "only what an iframe can observe without inspecting cross-origin content" is stated in the type name of the events interface.

### packages/client/ui-sidebar-browser/src/client/view/BrowserPresentation.ts
- **Purpose:** The presentation face, separated from navigation and disposal — 9 lines.
- **Key abstractions:** `BrowserPresentation { mount(viewportId): () => void }`.
- **Data flow:** mount into a committed container; the returned function ends the physical attachment without disposing the navigation model.
- **Non-obvious design decisions:** the doc comment states the invariant that makes page retention work: "its DOM ancestors must remain connected for page retention".
- **Edge cases / failure handling:** a later mount may reload the page.
- **Surprising:** one method, but the separation is what lets the same controller drive an iframe and a webview.

### packages/client/ui-sidebar-browser/src/client/view/BrowserTitle.tsx
- **Purpose:** The tab title.
- **Key abstractions:** `BrowserTitleProps`.
- **Data flow:** `useStore(state => currentBrowserTarget(state.byTab[tab.id]))` → the page title, else the tab title.
- **Non-obvious design decisions:** the title reads the **persisted** store, not the live controller — so the tab keeps its title after the body unmounts.
- **Edge cases / failure handling:** falls back to `tab.title`.
- **Surprising:** 17 lines, and the body/title split is a *deliberate* decoupling of the persisted view state from the live page.

### packages/client/ui-sidebar-browser/src/client/view/Browser.module.css
- **Purpose:** The browser chrome stylesheet — 247 lines.
- **Key abstractions:** `.root`, `.toolbar`, `.addressBox`, `.addressUnknown`, `.restore`, `.failure`, `.sandboxWarning`, `.limit`, `.frame`, `.webview`.
- **Data flow:** CSS modules; every value is a `dsw-*` design token.
- **Non-obvious design decisions:** the "Go" button is `visibility: hidden; opacity: 0` and is revealed by `.addressBox:focus-within` — the primary action appears only while the address has focus. The "URL changed" badge is `pointer-events: none` and hides on focus so it never covers the typed text.
- **Edge cases / failure handling:** `.webview` sets `pointer-events: none` while a docking gesture is in progress, so native guest input does not consume the window's drag events.
- **Surprising:** the stylesheet is written for a 38px toolbar with 28px controls — a very compact, dense chrome.

### packages/client/ui-sidebar-browser/src/types.ts
- **Purpose:** The type-only desktop bridge shared with the desktop shell.
- **Key abstractions:** `DesktopBrowserLeaseId` (branded), `DesktopBrowserReservation`, `DesktopBrowserOpenRequest`, `DesktopBrowserBridge`.
- **Data flow:** the renderer talks to the main process only through this four-method face.
- **Non-obvious design decisions:** the interface carries **no Electron objects and no arbitrary IPC** — "Origin-scoped operations" is the stated rule. The lease id is a **branded** string, so a partition cannot be passed where a lease belongs.
- **Edge cases / failure handling:** `release(lease)` is documented as returning "after its guest has been destroyed" — the caller's disposal awaits the destroy, not the request.
- **Surprising:** the package exports a `./types` entry *specifically* so the desktop main process and the client share the declaration without sharing code.

### packages/client/ui-sidebar-browser/src/css-modules.d.ts
- **Purpose:** Ambient declaration for `*.module.css`.
- **Key abstractions:** a default export of a class-name record.
- **Data flow:** types only.
- **Non-obvious design decisions:** `Readonly<Record<string, string>>` (the sidebar's copy uses a mutable record — a small inconsistency between the two packages).
- **Edge cases / failure handling:** n/a.
- **Surprising:** n/a.

### packages/client/ui-sidebar-browser/src/index.ts
- **Purpose:** Host companion entry — `apply()` is a no-op.
- **Key abstractions:** none.
- **Data flow:** the browser is a client-only plugin; the host half exists so the package can be published and loaded uniformly.
- **Non-obvious design decisions:** n/a.
- **Edge cases / failure handling:** n/a.
- **Surprising:** n/a.

### packages/client/ui-sidebar-browser/README.md
- **Purpose:** Package reference for the Browser tab — the most candid README in the shard.
- **Key abstractions:** documents the protocol policy, the iframe carrier, the controller split and an explicit list of isolation limits.
- **Data flow:** prose only.
- **Non-obvious design decisions:** it states the navigation state machine in prose ("a later load as proof that the page changed to an unreadable URL") and the exact limits (mixed content, X-Frame-Options concealment, popup escape, no cookie isolation per tab, process-local partitions that do not survive restart).
- **Edge cases / failure handling:** "Host-address filtering is not a general private-network or DNS-rebinding firewall" — the README refuses to overstate the security.
- **Surprising:** it also says "The package does not proxy or probe remote pages" — a policy of *not looking*.

### packages/client/ui-sidebar-browser/README.zh.md
- **Purpose:** Chinese mirror of the browser README.
- **Key abstractions:** same sections (first 60 of 120 lines read).
- **Data flow:** prose only.
- **Non-obvious design decisions:** mirrors the protocol policy section.
- **Edge cases / failure handling:** mirrors the limitation list.
- **Surprising:** n/a.

### packages/client/ui-sidebar-browser/README.i18n.yaml
- **Purpose:** Per-heading EN/ZH hashes for the browser README.
- **Key abstractions:** heading path → hash pair.
- **Data flow:** regenerated by `verify-translation-pairing --write`.
- **Non-obvious design decisions:** none beyond the shared mechanism.
- **Edge cases / failure handling:** n/a.
- **Surprising:** n/a.

### packages/client/ui-sidebar-browser/package.json
- **Purpose:** Client plugin manifest.
- **Key abstractions:** injects workspace-controller, sidebar-right and ui-session; exports an extra `./types` entry.
- **Data flow:** the loader places it in the client roster.
- **Non-obvious design decisions:** the `./types` export exists so the desktop shell can share the bridge declaration without importing client code.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the browser is **disabled by default in Web profiles and enabled on Desktop** — the same package ships with opposite defaults per profile.

### packages/client/ui-sidebar-browser/locale/en.json
- **Purpose:** The package's English meta dictionary.
- **Key abstractions:** `meta.title` only ("ui-sidebar-browser").
- **Data flow:** the locale plugin names the package.
- **Non-obvious design decisions:** the *real* copy of this package lives in `src/client/locales.ts` (the `sidebarBrowser` namespace), not here.
- **Edge cases / failure handling:** n/a.
- **Surprising:** n/a.

### packages/client/ui-sidebar-browser/locale/zh.json
- **Purpose:** The package's Chinese meta dictionary.
- **Key abstractions:** `meta.title` ("浏览器面板") and `meta.description`.
- **Data flow:** the locale plugin names the package.
- **Non-obvious design decisions:** same en/zh asymmetry as the other three packages.
- **Edge cases / failure handling:** n/a.
- **Surprising:** n/a.

### packages/client/ui-sidebar-browser/tsconfig.client.json
- **Purpose:** The client-side TypeScript project.
- **Key abstractions:** `include: ["src/client", "src/types.ts", "src/css-modules.d.ts"]`, its own `tsBuildInfoFile`.
- **Data flow:** references cordis, workspace-controller, `util/brand`, locale, shortcuts, store, ui-dockkit, ui-primitives, ui-renderer, ui-session, ui-sidebar-right and ui-slots.
- **Non-obvious design decisions:** `src/types.ts` is compiled by **both** the host and the client project — a shared declaration compiled twice rather than a shared package.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the client project deliberately includes the CSS-module declaration file, so the CSS import types come from the same program.

### packages/client/ui-sidebar-browser/tsconfig.host.json
- **Purpose:** The host-side TypeScript project.
- **Key abstractions:** `files: ["src/index.ts", "src/types.ts"]` — the host half of the package and the shared bridge declaration, and nothing else.
- **Data flow:** references only cordis and `util/brand`; the host never sees the client code.
- **Non-obvious design decisions:** the host project is *tiny* on purpose: the desktop main process must not be able to reach into the client's dependencies.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the two projects share one `outDir` (`lib/types`), which is why each needs its own `tsBuildInfoFile` — otherwise they would clobber each other's incremental state.

### packages/client/ui-sidebar-browser/tsconfig.json
- **Purpose:** The solution file for the package.
- **Key abstractions:** `files: []` plus references to `tsconfig.host.json` and `tsconfig.client.json`.
- **Data flow:** `tsc -b` at the package root builds both halves.
- **Non-obvious design decisions:** the root config is empty on purpose — the package's *shape* (two compilation surfaces) is the declaration.
- **Edge cases / failure handling:** n/a.
- **Surprising:** this is the only package in the shard with a three-file tsconfig arrangement; the other three have a single `tsconfig.json`.

### packages/client/ui-sidebar-browser/tsdown.config.ts
- **Purpose:** Bundle config.
- **Key abstractions:** `clientBundle(import.meta.dirname, ['lib/types/index.js'])`.
- **Data flow:** emits `lib/index.js` and `lib/client.js`.
- **Non-obvious design decisions:** the second argument names the type entry the bundle must preserve.
- **Edge cases / failure handling:** n/a.
- **Surprising:** identical to all three sibling packages' configs.

### packages/client/ui-sidebar-browser/tests/url.client.spec.ts
- **Purpose:** The address policy spec.
- **Key abstractions:** `APP = 'https://dsh.example'` as the application origin.
- **Data flow:** `parseBrowserAddress(input, APP)` per case.
- **Non-obvious design decisions:** it asserts the *refusals* as carefully as the acceptances — `javascript:`, `file:` (four spellings), `ftp:`, embedded credentials, the app's own origin, a 17 000-character host, and `:::`.
- **Edge cases / failure handling:** an unparseable application origin (`'not an origin'`) and the literal `'null'` origin must **not** block a target.
- **Surprising:** `http://128.0.0.1/` is accepted — loopback and private addresses are deliberately allowed ("Public and loopback targets use the same default sandbox").

### packages/client/ui-sidebar-browser/tests/browser-navigation.client.spec.ts
- **Purpose:** The history and state-machine spec.
- **Key abstractions:** `httpsTarget(index)`.
- **Data flow:** navigate/back/forward/reload/frameLoaded.
- **Non-obvious design decisions:** the "classifies only the first current frame load as known" case (`:35-52`) is the whole unknown-state mechanism in one test — a second `frameLoaded` for the same revision flips to `unknown`, and then `back()` and `forward()` return `undefined`.
- **Edge cases / failure handling:** a frame observation before any controlled request is ignored entirely.
- **Surprising:** the history cap test navigates `MAX_BROWSER_HISTORY + 1` times and asserts the *oldest* entry was dropped.

### packages/client/ui-sidebar-browser/tests/browser-controller.client.spec.ts
- **Purpose:** The controller spec — 267 lines.
- **Key abstractions:** `harness()` (a store, a controller face, a DOM host).
- **Data flow:** mount → command → assert the store and the iframe.
- **Non-obvious design decisions:** the "validates provider open requests and ignores late provider callbacks after disposal" case (`:102-140`) is the sharpest: after `dispose()`, `start`, `persist`, `openRequested` and every queued notification must be no-ops, and the snapshot must be *identical* to the pre-disposal one.
- **Edge cases / failure handling:** a remount into a missing host throws "not mounted"; an old occurrence's abort must not delete a replacement controller; the sandbox toggle forces a new revision (a reload).
- **Surprising:** the test asserts `first.src` and then dispatches a `load` event on the iframe to drive the known/unknown state machine.

### packages/client/ui-sidebar-browser/tests/browser-frame.client.spec.ts
- **Purpose:** The `IframeImpl` spec.
- **Key abstractions:** a real `IframePresentation` with stubbed event callbacks.
- **Data flow:** `handleLoaded` / `handleLoadFailed` / `loadUrl` / `reload` / `sandbox.setEnabled`.
- **Non-obvious design decisions:** `handleLoadFailed(0)` after a request at revision 1 must be ignored — failures are revision-scoped, not merely "current".
- **Edge cases / failure handling:** after `dispose()` the snapshot is frozen and every method is inert.
- **Surprising:** `handleLoaded(0)` before any request leaves the address `empty`.

### packages/client/ui-sidebar-browser/tests/browser-body.client.spec.tsx
- **Purpose:** The toolbar spec — 283 lines.
- **Key abstractions:** `mountBrowser()` (a hand-assembled prop bag with a `useBrowserState` implementation).
- **Data flow:** type into the address bar, submit, assert the iframe and the store.
- **Non-obvious design decisions:** the test asserts the iframe carries the exact `WEB_BROWSER_SANDBOX` string and **no** `allow` attribute, and that `referrerPolicy` is `no-referrer` (with a note that jsdom does not reflect the property to the attribute, so the property is asserted instead). The sandbox toggle is asserted by comparing the SVG path `d` attribute — the icon must visibly change between "sandboxed" and "not sandboxed".
- **Edge cases / failure handling:** the unknown-address case asserts that Back, Forward **and** external-open all become disabled while Reload stays enabled; the iframe error notice appears and clears on the next controlled load.
- **Surprising:** the remount test proves the remounted body reloads the **latest controlled URL**, not the initial URL.

### packages/client/ui-sidebar-browser/tests/browser-title.client.spec.tsx
- **Purpose:** The title spec.
- **Key abstractions:** `props(entry)` builds a store-shaped snapshot.
- **Data flow:** render with and without a stored entry.
- **Non-obvious design decisions:** the fallback is the *tab* title, so a Browser tab is never blank.
- **Edge cases / failure handling:** n/a.
- **Surprising:** 32 lines for a 17-line component.

### packages/client/ui-sidebar-browser/tests/store.client.spec.ts
- **Purpose:** The persistence-store spec.
- **Key abstractions:** `BrowserNavigation` used as the state producer.
- **Data flow:** `replace` then `forget`.
- **Non-obvious design decisions:** `forget` removes **only** the named tab.
- **Edge cases / failure handling:** n/a.
- **Surprising:** 21 lines.

### packages/client/ui-sidebar-browser/tests/workspace.client.spec.ts
- **Purpose:** The storage-partition spec.
- **Key abstractions:** `workspace(id, path, sessionIds)` and `snapshot(phase, items)`.
- **Data flow:** `browserWorkspace(source, SESSION, signal)`.
- **Non-obvious design decisions:** renaming the workspace record (same path, new id) must not change the partition; an unaccounted session gets `session:<id>`.
- **Edge cases / failure handling:** the readiness wait must not resolve on a *partial* snapshot; an abort before and during readiness rejects with the caller's reason and leaves no listener attached.
- **Surprising:** the test spies on `subscribe` to assert the listener is removed exactly once.

### packages/client/ui-sidebar-browser/tests/electron-lifecycle.client.spec.ts
- **Purpose:** The Electron guest lifecycle spec — 180 lines and the most valuable file in the shard for reliability patterns.
- **Key abstractions:** `electronFixture()` (the shared harness).
- **Data flow:** mount → emit native events → assert the frame state and the bridge calls.
- **Non-obvious design decisions:** "ignores superseded and aborted load promises, but publishes an active navigation rejection" (`:159-180`) is the canonical stale-async rule: a rejection from a superseded navigation must not surface, an `ERR_ABORTED` rejection must not surface, but a rejection from the *current* navigation must.
- **Edge cases / failure handling:** a guest is recreated after a physical remount **without resolving the workspace again**; a `render-process-gone` publishes an error and a `reload` gets a fresh guest; release failures are logged, not thrown.
- **Surprising:** the "releases an acquisition that finishes after attachment cancellation" case proves the lease is handed back even though the guest was never used.

### packages/client/ui-sidebar-browser/tests/electron-harness.client.ts
- **Purpose:** The shared Electron fixture.
- **Key abstractions:** `electronFixture(initial)`, `prepareGuest()`, `emit(type, fields)`.
- **Data flow:** spies on `presentation.createElement` so every created guest gets fake native methods and an `emit` helper.
- **Non-obvious design decisions:** the fixture keeps the *real* presentation and navigation classes and replaces only the native surface — "presentation and navigation stay real".
- **Edge cases / failure handling:** `guest()` waits until a guest has actually attached.
- **Surprising:** the fixture returns the page's own objects so tests can assert on `h.bridge`, `h.persist`, `h.guests`.

### packages/client/ui-sidebar-browser/tests/electron-frame.client.spec.ts
- **Purpose:** One focused Electron case — the failed-load recovery.
- **Key abstractions:** a hand-built `WebviewElement` via `Object.assign(document.createElement('div'), {...})`.
- **Data flow:** `did-fail-load` → error published → `page-title-updated` (must not clear it) → `did-start-navigation` with `isMainFrame: false` (must not clear it) → `did-start-navigation` with `isMainFrame: true` (clears it) → `did-navigate` → recovered target and title.
- **Non-obvious design decisions:** the error is cleared only by a **main-frame** navigation start; a sub-frame navigation and a title update leave it alone.
- **Edge cases / failure handling:** n/a.
- **Surprising:** 51 lines covering one precise rule.

### packages/client/ui-sidebar-browser/tests/apply.client.spec.ts
- **Purpose:** The plugin spec over the **real** registries.
- **Key abstractions:** `boot()` (a real `SidebarRightTabRegistry`, a real `ShortcutRegistry`, a real `Context`, stubbed slot/locale services).
- **Data flow:** `ctx.plugin({ inject, apply })` → the registrations are recorded → the shortcut is dispatched.
- **Non-obvious design decisions:** the test is parameterised over the desktop protocol version (0 and 1) and asserts `keepMounted` is true **only** for version 1; the desktop branch is exercised by stubbing `globalThis.dshDesktop`.
- **Edge cases / failure handling:** a session controller is reused for the same session id and `rebind`ed to a replacement store; aborting the occurrence removes the saved navigation **only** if the tab is no longer in the layout; the shortcut is refused (`status: 'blocked'`) when there is no session target, and a repeated gesture is not consumed twice.
- **Surprising:** the "publishes the macOS Web Browser default" case asserts the Web binding is `alt+meta+T` while the desktop default is `primary+T` — the same command id, different defaults per runtime.

### packages/client/ui-sidebar-browser/tests/apply.host.spec.ts
- **Purpose:** The inert host entry.
- **Key abstractions:** none.
- **Data flow:** `expect(apply).not.toThrow()`.
- **Non-obvious design decisions:** n/a.
- **Edge cases / failure handling:** n/a.
- **Surprising:** 6 lines; the test asserts a *function* does not throw, which is a slightly odd but harmless idiom.

### packages/client/ui-sidebar/src/client/SidebarRoot.tsx
- **Purpose:** The sidebar shell — 315 lines, the only real UI component in the shard.
- **Key abstractions:** `PanelRow`, `localBuildVersion()`, the collapse state machine (`collapsed`, `settled`, `wide`), the pointer/linger machinery.
- **Data flow:** layout state (`collapsed`, `width`) + panel metadata + shortcut catalog + seven declared child slots → the column tree.
- **Non-obvious design decisions:** (1) The collapse is a **slide plus crossfade**: the content freezes at its expanded width (an inline style) and fades out in place while the sliding column clips it, so nothing reflows mid-slide; the wide-only content unmounts at a 150 ms settle (`:104-127`). (2) A page that *starts* collapsed renders the rail statically — the `everWide` ref distinguishes a live collapse from a cold start, so no icons are delayed in. (3) Scrollbars are a **pointer affordance**: the shell rebinds ui-theme's scrollbar indirection to `transparent` whenever the pointer is outside, and keeps the thumb drawn for 2 s after the pointer leaves (`:129-170`).
- **Edge cases / failure handling:** the "is the pointer inside" decision is made by **geometry**, not DOM containment, because ui-settings renders its full-viewport panel as a *fixed-position descendant* of the column, so containment would report "inside" while the pointer is elsewhere; the element's own leave event remains as the one signal geometry cannot give.
- **Surprising:** the brand is a New Session shortcut on Web and Windows but **not** on macOS, where it is part of the window-drag surface (a button would subtract itself through the global no-drag rule).

### packages/client/ui-sidebar/src/client/index.ts
- **Purpose:** The sidebar plugin — registers the shell and the global panel navigation.
- **Key abstractions:** `syncPanels()` (the list→metadata projection), `injectProps()` (the shared injected face).
- **Data flow:** `ctx.slots.inject('sidebar', ...)` registers `SidebarRoot` with seven declared child seats; `ctx.slots.inject('shell.leading', ...)` registers `HeaderLeadingControls` with the **same** inject face; `syncPanels` re-projects `sidebar.panellist` entries into a snapshot whenever the slot or the locale changes.
- **Non-obvious design decisions:** (1) The panel metadata is *derived* from list registrations, and the projection is skipped entirely when nothing changed (`previous.every(...)` comparison) so a locale change does not churn the store. (2) The `shell.leading` occupant is registered through `slots.inject` so a replacing package can activate before or after the sidebar. (3) `selectPanel` fires product analytics only for two specific panel ids.
- **Edge cases / failure handling:** the shell holds **no** settings state — it passes only the `wide` flag to the settings seat.
- **Surprising:** the `main` keyed slot is *not* declared by the sidebar — the panel list id addresses a main entry that the layout owns, and selecting a missing main entry throws without changing the selection.

### packages/client/ui-sidebar/src/client/contract/slots.ts
- **Purpose:** The slot contract — the seven declared seats, their owner props, and the injected share.
- **Key abstractions:** `SidebarBrandMarkOwnerProps`, `SidebarPanelIconOwnerProps`, `SidebarSectionOwnerProps`, `SidebarSettingsOwnerProps`, `SidebarFooterActionOwnerProps`, `SidebarPanelMetadata`, `SidebarRootInjected`, `SidebarRootComponentProps`.
- **Data flow:** the `SlotMap` merge declares the seats with their kinds and scopes; the owner-prop interfaces are the only facts crossing the shell→occupant boundary.
- **Non-obvious design decisions:** the owner shares are deliberately *minimal* — the region seat gets `{ wide, expandSidebar }` and nothing else; business data arrives through the region's own inject. "The sidebar passes only its column state — it holds no settings state."
- **Edge cases / failure handling:** `expandSidebar` is clamped by the shell to the collapsed state, so a rail icon cannot accidentally collapse an expanded sidebar.
- **Surprising:** the `SidebarRootInjected` type carries **private reactive sources** (`hooks: { panels, shortcuts }`) rather than values — the renderer binds them to selector hooks at the render position.

### packages/client/ui-sidebar/src/client/HeaderLeadingControls.tsx
- **Purpose:** The macOS window-chrome occupant — 55 lines.
- **Key abstractions:** `HeaderLeadingControlsProps`.
- **Data flow:** reads the two shortcut rows and renders two icon buttons that call the shell's injected `toggleSidebar` and `startSession`.
- **Non-obvious design decisions:** the occupant renders unconditionally because the *frame* mounts the seat only while the column is fully hidden — the placement decision belongs to ui-layout, not to this component.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the same two actions exist in two places (the column and the window chrome) and share one injected face, so they can never drift.

### packages/client/ui-sidebar/src/client/locales.ts
- **Purpose:** The sidebar dictionary.
- **Key abstractions:** `zh` (key-set source of truth), `SidebarKey`, `en satisfies Record<SidebarKey, string>`.
- **Data flow:** registered into the locale plugin under the `sidebar` namespace.
- **Non-obvious design decisions:** `en` is checked complete against the zh key set **by the type system**.
- **Edge cases / failure handling:** n/a.
- **Surprising:** only five strings for the whole shell.

### packages/client/ui-sidebar/src/client/SidebarRoot.module.css
- **Purpose:** The shell stylesheet — 613 lines, the largest file in the shard.
- **Key abstractions:** `.root` (+ `.collapsed`, `.railIn`, `.fading`, `.quietBars`), `.topStrip`, `.logoRow`, `.brand*`, `.newSession*`, `.panelList`/`.panelRow`, `.regionArea`, `.footArea`, and the `rail-in` / `rail-fade-in` / `wide-in` keyframes.
- **Data flow:** CSS modules; the class set is driven by the component's state flags.
- **Non-obvious design decisions:** (1) The quiet-scrollbar rule rebinds **both** ui-theme indirection variables to `transparent` — and deliberately does **not** set `scrollbar-gutter`, because the reservation belongs to the scrolling region so revealing a thumb never reflows a row (`:120-131`). (2) The four upper controls share one `rail-in` animation (opacity + a 49 px leftward translate) while the bottom-pinned settings seat gets `rail-fade-in` (opacity only) — the settings control must not move horizontally. (3) The Windows caption rules `position: fixed` the toggle and the New Session button into the caption, and set `--dsh-windows-menu-start: 84px` when collapsed so the desktop menu starts after them.
- **Edge cases / failure handling:** a `prefers-reduced-motion` block disables every transition and animation.
- **Surprising:** the CSS carries the *reasoning* in its comments ("the base row's clip would cut the control's right edge") — the stylesheet is documentation, not just styling.

### packages/client/ui-sidebar/src/client/HeaderLeadingControls.module.css
- **Purpose:** Layout for the two window-chrome buttons — 29 lines.
- **Key abstractions:** `.controls`, `.iconButton`.
- **Data flow:** CSS modules.
- **Non-obvious design decisions:** the file explicitly does **not** own placement — "The frame's leadingSeat (ui-layout AppFrame) owns placement — position, traffic-light clearance, no-drag".
- **Edge cases / failure handling:** n/a.
- **Surprising:** it copies the conversation header's 8px rhythm so both ends of the title row read as one control set.

### packages/client/ui-sidebar/src/client/index.ts
- **Purpose:** Registers the sidebar shell and the global panel navigation — 100 lines.
- **Key abstractions:** `NS = 'sidebar'`, `WorkspaceNavigation` (a local structural interface for the workspace plugin), `injectProps()` (the shared injected face), `syncPanels()` (the list→metadata projection).
- **Data flow:** `apply(ctx)` → register the `sidebar` locale namespace → create a `panels` snapshot store → `ctx.slots.inject('sidebar', ...)` registering `SidebarRoot` with its seven declared child seats and the `injectProps` face → `ctx.slots.inject('shell.leading', ...)` registering `HeaderLeadingControls` with the **same** face → `ctx.slots.subscribe('sidebar.panellist', syncPanels)` and `ctx.locale.subscribe(syncPanels)` keep the projection current.
- **Non-obvious design decisions:** (1) The panel metadata is *derived* from list registrations and the projection is **skipped entirely** when nothing changed (an element-wise comparison against the previous snapshot), so a locale switch does not churn the store (`:49-61`). (2) The `main` keyed slot is **not** declared by the sidebar — a panel list id addresses a main entry the *layout* owns, so selecting a missing main entry throws without changing the selection. (3) The `shell.leading` occupant is registered through `slots.inject`, so a replacing package may activate before or after the sidebar. (4) `selectPanel` fires product analytics only for two specific panel ids — the shell owns the analytics decision, not the layout.
- **Edge cases / failure handling:** the shell holds **no** settings state — it hands the settings seat only the `wide` flag; the New Session action is delegated wholesale to the workspace UI's own `startSession` so both arms share one fallback chain.
- **Surprising:** `ctx.get('uiWorkspace')` is cast to a *locally declared* `WorkspaceNavigation` interface rather than importing the workspace plugin's real type — the dependency stays one-way and the shell states exactly the two methods it uses.

### packages/client/ui-sidebar/README.md
- **Purpose:** Package reference for the sidebar shell.
- **Key abstractions:** documents the brand row, the New Session fallback chain, the panel entries, the collapse behaviour, the Windows caption and macOS rules, and the scrollbar contract.
- **Data flow:** prose only.
- **Non-obvious design decisions:** the New Session chain is documented as a *fallback order* — explicit Workspace → the current Session's Workspace → the most recently active Workspace → a blank New Session page.
- **Edge cases / failure handling:** the limitations section states that "New task completed" unread marking is **local viewing state** and never reaches the host.
- **Surprising:** the README documents CSS-level mechanics (the `--dsh-windows-menu-start` variable, the 8 px extra space above the New Session button) — the doc is the spec for the desktop integration.

### packages/client/ui-sidebar/README.zh.md
- **Purpose:** Chinese mirror of the sidebar README (first 60 of 117 lines read).
- **Key abstractions:** same sections.
- **Data flow:** prose only.
- **Non-obvious design decisions:** mirrors the New Session fallback chain and the collapse rules.
- **Edge cases / failure handling:** mirrors the limitations.
- **Surprising:** n/a.

### packages/client/ui-sidebar/README.i18n.yaml
- **Purpose:** Per-heading EN/ZH hashes for the sidebar README.
- **Key abstractions:** heading path → hash pair.
- **Data flow:** regenerated by the same script.
- **Non-obvious design decisions:** none.
- **Edge cases / failure handling:** n/a.
- **Surprising:** n/a.

### packages/client/ui-sidebar/package.json
- **Purpose:** Client plugin manifest.
- **Key abstractions:** injects seven packages, including ui-workspace and ui-layout, which the shell itself does not import.
- **Data flow:** the loader activates the sidebar after them.
- **Non-obvious design decisions:** the `description` field still says "Sidebar plugin: session multi-level tree, search, grouping, state dots" — a **stale** description from an earlier scope; the package is now only the shell.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the description is out of date — a small honesty finding.

### packages/client/ui-sidebar/locale/en.json
- **Purpose:** The package's English meta dictionary.
- **Key abstractions:** `meta.title` only ("ui-sidebar").
- **Data flow:** the locale plugin names the package.
- **Non-obvious design decisions:** the shell's real copy lives in `src/client/locales.ts` (the `sidebar` namespace).
- **Edge cases / failure handling:** n/a.
- **Surprising:** n/a.

### packages/client/ui-sidebar/locale/zh.json
- **Purpose:** The package's Chinese meta dictionary.
- **Key abstractions:** `meta.title` ("会话侧栏") and `meta.description`.
- **Data flow:** the locale plugin names the package.
- **Non-obvious design decisions:** same en/zh asymmetry as the other three packages.
- **Edge cases / failure handling:** n/a.
- **Surprising:** n/a.

### packages/client/ui-sidebar/src/index.ts
- **Purpose:** Host loader entry — `apply()` is a no-op.
- **Key abstractions:** none.
- **Data flow:** browser-only plugin.
- **Non-obvious design decisions:** n/a.
- **Edge cases / failure handling:** n/a.
- **Surprising:** n/a.

### packages/client/ui-sidebar/src/css-modules.d.ts
- **Purpose:** Ambient declarations for CSS modules.
- **Key abstractions:** `*.module.css` default export; a bare `*.css` module declaration.
- **Data flow:** types only.
- **Non-obvious design decisions:** the `*.module.css` record is **mutable** here, unlike the browser package's `Readonly` version.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the bare `declare module '*.css'` at the end has no body — a permissive catch-all.

### packages/client/ui-sidebar/tsconfig.json
- **Purpose:** The TypeScript project for the package.
- **Key abstractions:** `rootDir: src`, `outDir: lib/types`, base client config.
- **Data flow:** project references to cordis, workspace-controller, ui-slots, store, ui-primitives, **ui-conversation**, ui-renderer, ui-session, ui-layout, locale, shortcuts and product-analytics.
- **Non-obvious design decisions:** `ui-conversation` is referenced even though the sidebar never imports it — the project graph mirrors the *composition* graph, not the import graph.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the reference list is the clearest statement of the shell's true neighbours.

### packages/client/ui-sidebar/tsdown.config.ts
- **Purpose:** The bundle configuration.
- **Key abstractions:** `clientBundle(import.meta.dirname, ['lib/types/index.js'])`.
- **Data flow:** `tsdown` emits `lib/index.js` and `lib/client.js`.
- **Non-obvious design decisions:** identical to the other three packages' configs, so the four client bundles are shape-compatible.
- **Edge cases / failure handling:** n/a.
- **Surprising:** n/a.

### packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx
- **Purpose:** The shell spec — 321 lines.
- **Key abstractions:** `mountShell()` with a `renderSlot` stub that captures the owner props of each seat.
- **Data flow:** renders the shell with props, fires events, asserts the DOM and the captured owner shares.
- **Non-obvious design decisions:** the fixtures install `neverHook` stubs that **throw** if called ("shell must not read global hooks") — the suite enforces that the shell does not read the Session hooks it merely carries. The build-badge test stubs the three `DSH_CLIENT_*` env vars and asserts the exact composed string `1.2.3-rc.4-0123456-dirty`.
- **Edge cases / failure handling:** the Windows caption cases assert the tooltip's `data-side` is `bottom` when a caption is present and `right` otherwise — a geometry-driven bubble side.
- **Surprising:** the "shows only the badge bubble while the rail badge is hovered inside the toggle" case asserts that the badge's own tooltip **replaces** the toggle's rather than stacking on it.

### packages/client/ui-sidebar/tests/pointer-scrollbars.client.spec.tsx
- **Purpose:** The pointer-revealed scrollbar spec — 169 lines.
- **Key abstractions:** `mountColumn()` with a pinned `getBoundingClientRect`.
- **Data flow:** pointer events on the column and on the document; asserts the `quietBars` class.
- **Non-obvious design decisions:** the suite pins the column's box because "the leave decision is geometric" — and it reads the state as a *substring* of the class list because CSS-module locals are hashed in this bench.
- **Edge cases / failure handling:** a pointer that moves outside the box without leaving the subtree must still hide the bars (the fixed-overlay case); a pending hide is **not** re-armed by continued movement outside ("otherwise a pointer resting outside the column would keep pushing the bars' disappearance out, one move at a time"); the linger timer is dropped on unmount (`vi.getTimerCount() === 0`).
- **Surprising:** the comment explains that hiding the bar on the leave event itself makes it blink out while the pointer is only *crossing* the column's edge.

### packages/client/ui-sidebar/tests/scrollbar-quiet-styles.client.spec.ts
- **Purpose:** The stylesheet contract for the quiet column.
- **Key abstractions:** reads the CSS file as text and strips comments.
- **Data flow:** a regex extracts the `.root.quietBars` rule and asserts its declarations.
- **Non-obvious design decisions:** the suite asserts the **pair** of variables, not just the resting thumb — "rebinding one leaves the other painting its base-surface colour the moment the pointer reaches the bar". It also asserts the sheet does **not** contain `scrollbar-gutter`, because the reservation belongs to the scrolling region.
- **Edge cases / failure handling:** n/a.
- **Surprising:** this is a *design-system contract enforced by reading CSS text* — a pattern August's static gates could adopt.

### packages/client/ui-sidebar/tests/sidebar-styles.client.spec.ts
- **Purpose:** More stylesheet-as-contract assertions.
- **Key abstractions:** a `declarations(selector)` helper that parses the sheet into a property map.
- **Data flow:** the sheet is read once and queried by exact selector.
- **Non-obvious design decisions:** it asserts the **shared padding token** (`--dsh-sidebar-inline-padding: 12px`) is cancelled structurally by the region's negative margins, and that the four upper controls use `rail-in` while the foot uses `rail-fade-in` — a "the settings seat only fades" contract expressed as a CSS assertion.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the keyframes are asserted with a regex on the literal `translateX(49px)`.

### packages/client/ui-sidebar/tests/apply.client.spec.tsx
- **Purpose:** The plugin spec — 158 lines over a real `SlotRegistry`.
- **Key abstractions:** `bench()` (a real `Context`, a real `SlotRegistry`, a real `LocaleRuntime`).
- **Data flow:** applies the plugin and inspects `slots.entries` / `slots.spec`.
- **Non-obvious design decisions:** it asserts that the `shell.leading` entry's `inject` is **the same function** as the `sidebar` entry's — one injected face, two seats, verified by identity.
- **Edge cases / failure handling:** the plugin waits for the `sidebar` declaration before registering (`slots.inject`); a plugin that registers a `main` entry and a `sidebar.panellist` entry is projected into the panel metadata and removed with its owner; disposal removes the entry *and* every child declaration.
- **Surprising:** the test asserts `expect(inject).toEqual(['slots','layout','uiWorkspace','locale','shortcuts'])` — the dependency list is a contract.

### packages/client/ui-sidebar/tests/panel-list.client.spec.tsx
- **Purpose:** The global panel spec — 279 lines, through the **production** renderer.
- **Key abstractions:** `bench()` (a `SlotTestRuntime` with a real `LocaleRuntime`), `mountPanel()`, `mountPanels()`.
- **Data flow:** a plugin registers a `main` keyed entry and a `sidebar.panellist` list entry → the shell's projection shows a row → clicking the row selects the main panel.
- **Non-obvious design decisions:** (1) The label may be a **locale-aware thunk** (`() => t('alpha')`) — a locale switch refreshes the label *without re-registering the icons* (the entries array is asserted to be the identical reference). (2) DOM focus moving between controls does **not** change the selected panel — the selection lives in the layout store, not in the DOM.
- **Edge cases / failure handling:** with no registrations the `<nav>` and even the slot's DOM anchor are absent; a plugin's disposal removes its row and its main entry; the sidebar can be disposed while the independently-owned main panel bodies stay mounted.
- **Surprising:** the test asserts the icon's rendered pixel size — 16 wide, 18 collapsed — so the icon slot's `size` owner prop is a real contract.

### packages/client/ui-sidebar/tests/sidebar-snapshot.client.spec.tsx
- **Purpose:** The DOM snapshot suite — 116 lines.
- **Key abstractions:** `bench()` over `SlotTestRuntime`, `usePinnedBrowserLanguages('zh-CN')`.
- **Data flow:** renders the `sidebar` slot and snapshots the container.
- **Non-obvious design decisions:** the suite pins the **shipped default locale** (zh) as well as en, and the `collapsed` case waits for the 150 ms settle before snapshotting so the rail layout is what is captured.
- **Edge cases / failure handling:** the Windows caption states are captured with and without the caption attribute.
- **Surprising:** the header comment says the child holes have no registrant here, "so the snapshots pin the shell chrome itself" — the snapshots are of the *shell*, not of a full app.

### packages/client/ui-sidebar/tests/__snapshots__/sidebar-snapshot.client.spec.tsx.snap
- **Purpose:** The generated Vitest snapshot file.
- **Key abstractions:** five `exports[...]` blocks: zh expanded, en expanded, collapsed rail, Windows expanded, Windows collapsed.
- **Data flow:** produced by the snapshot suite; it stores the serialised DOM of the `sidebar` slot with CSS-module locals folded to semantic names.
- **Non-obvious design decisions:** the snapshot reveals the runtime's own contract in passing — every slot renders as `<div data-slot="..." style="display: contents;">`, confirming the `display:contents` anchor rule end to end.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the generated file is the clearest single artefact of the anchor contract in the shard.

---

## Ideas worth stealing

- **A crashed registrant abdicates its cell instead of blanking the region** — `packages/client/ui-renderer/src/client/scoped-slots.tsx:1131-1133` — the error handler reports `{ abdicate: spec.kind !== 'chain' }`; shadowing slots fall through to the next survivor, chain slots keep a static crash face. August's plugin/tool surface needs the same split: one registrant's failure must not take down its siblings, but a *chosen* alternative must not be silently retired either.

- **Entry-identity React keys so a failed entry's error boundary does not black out its replacement** — `packages/client/ui-renderer/src/client/scoped-slots.tsx:361-381` (with the proof at `packages/client/ui-renderer/tests/scoped-slots.client.spec.tsx:444-467`) — the boundary is keyed by a per-registration identity, so a winner change remounts it fresh. Directly transferable to August: a panel that fails and is replaced by a fallback must not inherit the failure state.

- **A live-scoped, "adoption" identity: blank → first session keeps the incarnation, a later switch remounts** — `packages/client/ui-renderer/src/client/scoped-slots.tsx:690-765` — the rule is stated as a contract: "component-local per-session state therefore clears by construction; state that must SURVIVE a switch belongs in session-bound sources". August's per-session UI has exactly this problem (a chat pane that must not flash when the first session arrives, but must not leak a draft into the next session).

- **The incarnation key is derived from the Context object, not the session id** — `packages/client/ui-renderer/src/client/scoped-slots.tsx:383-393` and `packages/client/ui-renderer/src/client/registry.ts:362-372` — a same-id *replacement* generation is a different object, so it remounts and gets its own memory, while the persisted value carries over. This is the DSH analogue of August's "same session id, new generation" rule and of the "memory separates but persistence carries" case at `packages/client/ui-renderer/tests/registry.client.spec.ts:767-815`.

- **A standard-source contribution is a *declared roster*, and the framework refuses undeclared, missing and duplicate members** — `packages/client/ui-session/src/client/index.ts:614-668` and the atomic rebuild at `:419-432` — a plugin cannot silently add or shadow a standard prop, and a failing contribution leaves every other binding untouched. August's brain-config gate enforces a similar rule on the *backend*; this is the frontend twin, and the "assemble all, then notify any" ordering is the part worth copying.

- **Pending interactions are published per session with a deterministic cross-domain precedence, and teardown removes the visible value *before* awaiting the owner's delegate** — `packages/client/ui-session/src/client/index.ts:398-417` and `:468-488` (asserted at `packages/client/ui-session/tests/ui-session.client.spec.ts:685-708`) — a hanging teardown delegate cannot keep a dead request on screen. August's approval/interrupt doors want exactly this ordering.

- **A "stop observed outside the main view is unread; the main view acknowledges it" rule, with subagent rows explicitly excluded from establishing running state** — `packages/client/ui-session/src/client/index.ts:490-498` and `:500-509` — the exclusion is a comment plus a test (`packages/client/ui-session/tests/status-controller.client.spec.ts:36-43`). August's "task completed" badge has the same shape and the same trap.

- **A stale async result must not publish an error: superseded and `ERR_ABORTED` load promises are ignored, only the current navigation's rejection surfaces** — `packages/client/ui-sidebar-browser/src/client/electron/ElectronWebViewImpl.ts:190-201` (asserted at `packages/client/ui-sidebar-browser/tests/electron-lifecycle.client.spec.ts:159-180`) — the revision check is the whole mechanism. This is the frontend twin of August's rule that a stale tool result must not be mistaken for the current turn's failure.

- **A lease that resolves after cancellation is still handed back** — `packages/client/ui-sidebar-browser/src/client/electron/ElectronWebViewImpl.ts:144-152` (asserted at `packages/client/ui-sidebar-browser/tests/electron-lifecycle.client.spec.ts:72-90`) — acquisition is awaited, the abort is checked *after* the await, and the resource is released rather than leaked. The same shape applies to any August resource acquired asynchronously under a cancellable scope.

- **When the app can no longer trust its own view of the page, it names that state and withdraws the affordances instead of guessing** — `packages/client/ui-sidebar-browser/src/client/browser/BrowserNavigation.ts:120-128` plus the toolbar lockdown at `packages/client/ui-sidebar-browser/src/client/view/BrowserBody.tsx:99-101` — a second load for the same revision means "the page navigated somewhere unreadable"; the address is marked, Back/Forward/external-open are disabled, and Reload returns to the last controlled URL. August's "the tool's output is not what we asked for" cases want the same named-degraded state.

- **A URL allowlist expressed as a parser with typed refusal reasons, and the app's own origin refused** — `packages/client/ui-sidebar-browser/src/client/browser/url.ts:25-45` — every failure is a named reason that maps to a distinct localized message, credentials are refused, the length cap bounds *persisted* state, and the host's own origin cannot be opened from inside the host. The typed-reason pattern is exactly what August's URL-facing tools should return instead of a boolean.

- **A saved checkpoint alone never starts a page: restoration is an explicit user action** — `packages/client/ui-sidebar-browser/src/client/browser/BrowserController.ts:94-104` and the UI at `packages/client/ui-sidebar-browser/src/client/view/BrowserBody.tsx:118-125` — the restored title and URL are shown, and a "Restore page" button is required to open it. August's persisted-session/agent state should never auto-resume work the user did not ask to resume.

- **One uSES bridge, captured once per source, cached per source** — `packages/client/ui-renderer/src/client/bind.ts:20-26` and the per-source WeakMap at `packages/client/ui-renderer/src/client/bindings.tsx:69-78` — the subscribe/getSnapshot closures are captured once, so a component never resubscribes across re-renders, and the hook identity is stable per source. August's React surfaces (if any) should have exactly one such bridge.

- **Freshness rides function identity: a locale switch mints a new `t` per namespace so `React.memo` re-renders through ordinary shallow comparison** — `packages/client/ui-renderer/src/client/scoped-slots.tsx:293-317` — no extra invalidation channel, no context churn, and the revision is part of the cache key so the reference is stable within a revision.

- **An optional source still costs exactly one uSES call, so React's hook order never changes** — `packages/client/ui-renderer/src/client/bindings.tsx:79-102` — the "absent" hook is a real hook over an always-undefined source rather than a conditional hook.

- **The stale check precedes the ownership check, and an HMR re-registration mints a fresh binding while the old closure stays dead** — `packages/client/ui-renderer/src/client/scoped-slots.tsx:68-88` and `packages/client/ui-renderer/tests/stale-authorization.client.spec.tsx:118-158` — liveness is the more fundamental fact, and a re-registration never revives a stale closure.

- **A routing selector that throws degrades to "declined" and is reported, rather than blacking out the owner region** — `packages/client/ui-renderer/src/client/scoped-slots.tsx:1198-1221` — chain election is a pure function of the owner props, so a contract breach in a selector must not take the surrounding UI with it.

- **Every slot renders inside a stable `[data-slot="<key>"]` anchor with `display: contents`, and the anchor rides the outlet rather than the dispatch outcome** — `packages/client/ui-renderer/src/client/scoped-slots.tsx:1089-1099` (visible end to end in the generated snapshot `packages/client/ui-sidebar/tests/__snapshots__/sidebar-snapshot.client.spec.tsx.snap:3-91`) — an addressable, layout-neutral seam that never flickers with registration churn. This is an E2E-selector strategy August could adopt for its panes and tools.

- **A "declaration epoch" makes injection survive a same-tick collapse-and-redeclaration, and a failure caller retires permanently** — `packages/client/ui-renderer/src/client/registry.ts:209-271` — the injection's controller owns an epoch, and a delayed setup failure never retries on a later declaration ("failure callers retire the injection permanently"). August's dynamic registration paths (tools, skills) want the same "one attempt, then retire" rule rather than an unbounded retry loop.

- **Three fail-loud boot-order checks instead of a fallback** — `packages/client/ui-renderer/src/client/registry.ts:382-396` — a wrong key, a missing renderer install and an empty `root` each throw with a message that names the fix. August's "fail loud at the door" doctrine is stated in the same shape.

- **A rendering contract enforced by reading the stylesheet as text** — `packages/client/ui-sidebar/tests/sidebar-quiet-styles.client.spec.ts:16-32` and `packages/client/ui-sidebar/tests/sidebar-styles.client.spec.ts:29-59` — the sheet's *rules* (both scrollbar variables transparent, no `scrollbar-gutter` here, `rail-in` vs `rail-fade-in`) are asserted statically, including the reasoning that a rule exists so a row never reflows. August's static gates could adopt this for its own design tokens.

- **The scrollbar is a pointer affordance with a 2 s linger, decided by geometry rather than DOM containment** — `packages/client/ui-sidebar/src/client/SidebarRoot.tsx:129-170` and `packages/client/ui-sidebar/tests/pointer-scrollbars.client.spec.tsx:120-145` — a fixed-position overlay that is a DOM descendant breaks containment, so the box is measured instead; a pending hide is not re-armed by continued movement outside. The same "affordance follows attention, not DOM structure" rule applies to August's progress indicators.

- **A collapse that freezes the content at its expanded width so nothing reflows mid-slide** — `packages/client/ui-sidebar/src/client/SidebarRoot.tsx:104-127` with the choreography in `packages/client/ui-sidebar/src/client/SidebarRoot.module.css:133-174` — the crossfade is 150 ms, the rail entry is a second 150 ms on the same timeline, and the bottom-pinned seat fades without translating.

- **The panel list is a *projection* of list registrations, re-derived on slot change and on locale change, and skipped entirely when nothing changed** — `packages/client/ui-sidebar/src/client/index.ts:49-63` — plugins add a row by registering an icon; the shell owns the button, the accessible name and the tooltip.

- **The electron carrier is detected by a *versioned protocol probe*, not a platform check** — `packages/client/ui-sidebar-browser/src/client/index.ts:69-74` — `globalThis.dshDesktop?.protocolVersion === 1` selects the desktop carrier, and `keepMounted` (the "preserve the DOM across tab changes" flag) is set only for that version.

- **The bridge between the renderer and the host process is origin-scoped, carries no Electron objects, and brands its lease ids** — `packages/client/ui-sidebar-browser/src/types.ts:1-27` — the client can only acquire a reservation, release it, and listen for an approved open request; it cannot reach arbitrary IPC.

- **A boot DOM is preserved byte-for-byte while the framework takes over** — `packages/client/ui-renderer/src/client/index.ts:59-83`, asserted by a `MutationObserver` at `packages/client/ui-renderer/tests/ui-renderer.client.spec.tsx:67-85` — the loading page is captured and re-rendered for one frame instead of being discarded, so there is no blank flash.

---

## Files skipped (with reasons)

- `packages/client/ui-sidebar/tests/__snapshots__/sidebar-snapshot.client.spec.tsx.snap` — a **generated** Vitest snapshot file (630 lines, 13.9 KB, five `exports[...]` blocks: zh expanded, en expanded, collapsed rail, Windows expanded, Windows collapsed). I opened the first 120 lines and the list of export keys to confirm what it is (the serialised DOM of the `sidebar` slot with CSS-module locals folded to semantic names) and read the shape of the Windows-expanded block; it was not read line by line because it is machine-generated output whose content is fully determined by the snapshot suite that produced it.

No other file was skipped. Every source, test, config, doc and locale file in the shard (114 of 115) was opened and read; two large files were read in full but in multiple passes (`scoped-slots.tsx` 1332 lines, `SidebarRoot.module.css` 613 lines), and `packages/client/ui-sidebar-browser/README.zh.md` and `packages/client/ui-sidebar/README.zh.md` were read through their first 60 lines (the remainder is the mirrored implementation/limitations prose of the English files I read in full).

---

## Uncertainties

- **`ui-slots` (the `SlotCore` and the type layer) is not in this shard.** `registry.ts` and `scoped-slots.tsx` delegate the registration semantics, the declaration ledger, the load-time validations and the unload cascade to `SlotCore` in `@deepseek-ai/dsh-client-ui-slots`, and I could not read it. Consequently I could not verify *how* the core implements the "first live (non-abdicated) entry per cell" projection, the microtask batching of `subscribe`, or the priority ordering for chain entries — I read the renderer and the fake host's *mirror* of those rules (`packages/client/ui-renderer/tests/scoped-slots.client.spec.tsx:141-157`) and the real-core integration spec (`packages/client/ui-renderer/tests/scoped-slots-real-core.client.spec.tsx:97-108`), which is where my claims about batching and stability come from. Anything about the core's internals is inference from its consumers, not from the core.
- **`dsh-client-store` (`createSnapshotStore`, `notifySubscribers`, `defineStore`) is outside the shard.** I read its *use* (including that `notifySubscribers` contains a throwing subscriber and logs `'[ui-session] Session binding subscriber failed:'`), but the exact subscription semantics — re-entrancy, batching, snapshot identity — are unverified. This matters for `ui-session`'s "assemble all, then notify any" claim, which I verified only at the `UiSession` level.
- **`dsh-client-test-runtime` (`SlotTestRuntime`, `usePinnedBrowserLanguages`, `makeTranslate`, `allowAllAccess`) is outside the shard.** Several suites depend on it heavily (the factory suite, the panel-list suite, the snapshot suite); I described its behaviour from the call sites, and I could not confirm whether its serializer that "folds CSS-module class names to their semantic locals" is a general feature or a test-runtime convention.
- **The desktop main process, the Electron preload and the `dshDesktop` bridge implementation are outside the shard.** Everything I wrote about guest leases, partitions and the Windows caption integration is from the client side and the READMEs; the main-process approval and attachment policy that the browser README describes ("Desktop's main process approves guest leases and enforces attachment, navigation and permission policy") is **not** in this shard and I did not verify it.
- **`ui-layout`, `ui-workspace`, `ui-settings`, `ui-chat` and `ui-primitives` are outside the shard.** The sidebar's collapse depends on the layout's grid-track slide ("the layout's column slide ends the motion"), the region seat's behaviour belongs to ui-workspace, and the settings seat to ui-settings; I read the shell's side of every one of those contracts but not the occupants.
- **The `README.zh.md` mirrors were read to line 60 of 117/120.** The unread remainder is the mirrored "Understand the implementation" / "Known Limitations" prose, which I verified line-for-line against the English files' section structure in the `README.i18n.yaml` hash lists — the hash pairs cover exactly those headings, so a divergence in the unread portion would fail the i18n gate.
- **One stale artefact noted but not investigated:** `packages/client/ui-sidebar/package.json:3` still describes the package as "Sidebar plugin: session multi-level tree, search, grouping, state dots", which no longer matches the package's scope (the shell only; the tree belongs to ui-workspace). I did not check whether the description is validated by a gate.
- **The lenses that this shard does not cover:** there is no agent loop, no tool-calling, no reasoning/thinking streaming, no prompt construction or KV-cache strategy, no context-window management or compaction, no model-specific adaptation, no memory/learning mechanism and no eval harness anywhere in these 115 files. The nearest adjacencies are the subagent-status rule in `ui-session` and the stale-async rule in the Electron carrier. Any conclusion about those lenses must come from other shards.
