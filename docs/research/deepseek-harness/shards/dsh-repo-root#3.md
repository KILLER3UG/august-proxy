# deepseek-harness / dsh-repo-root#3

## Shard shape

This shard is the **infrastructure floor** of `deepseek-harness`: it holds no agent loop, no LLM adapter, no tool implementation, no session store and no chat UI. It holds the three things that everything *else* in the repo stands on.

1. **`vendor/` (79 files)** — the source-vendored Cordis plugin framework and its foundation libraries: `cordis` (core DI/lifecycle), `cosmokit` (utilities + the *volatile config* reference type), `schemastery` (the schema/validator/UI-metadata system), `loader` (the plugin tree: entries, groups, isolation realms, config expressions), `include` (YAML/JSON-backed config tree with patches and durable writes), `group`, `hmr` (hot module replacement over Node's internal module loader), `logger-console`, `timer`. Plus `vendor/README.md`, which is a **24-entry local-modification log** — every divergence from upstream Cordis is written down with its reasoning — and `vendor/cordis-rc11-upgrade-plan.md`, a proposed staged upgrade plan.
2. **Root Vitest configuration (9 files)** — the repo's whole test-lane topology: unit/coverage, e2e (real API), expected-output, snapshot record/replay, browser web, web-stress, web-perf, bench, plus the shared decorator-transform plugin.
3. **`website/` (32 files)** — the documentation-site adapter: a VitePress configuration, a publication manifest (`docs.ts`) that projects canonical Markdown into two locale route trees, a custom theme (shared media viewer for images/diagrams, "copy page as Markdown" actions, code-group radio isolation), a build wrapper that refuses to delete outside its own root, and the site's own test suite with HTML file-snapshot fixtures.

The three parts fit together the same way: **a mechanism, a manifest of what may change, and a gate that refuses to let the two drift.** The loader's `EntryTree` is a plugin registry with dependency-ordered start/stop; the vitest configs are a test registry with platform-conditional membership; the website's `docs.ts` is a route registry that projects one canonical source into many routes. What a reader takes from this shard is mostly *lifecycle discipline* — how to make a long-lived process with reentrant teardown, live-mutable configuration, and cross-copy symbol identity behave.

## Per-file notes

### vendor/README.md
- Purpose: the vendor manifest (package → upstream repo → version → commit) plus the exhaustive **local-modification log** and the upstream sync procedure.
- Key abstractions: `Manifest` table; numbered modification entries `V1..V24`; the `workspace:~` referencing convention; the `@deepseek-ai` rescope mapping table.
- Data flow: a sync copies upstream `src/` over the vendored directory, the modification log is re-applied, the version+commit row is updated, then `pnpm install && pnpm run test && pnpm run build` runs at the repo root.
- Non-obvious design decisions: (6) "locally closes three reentrant disposal gaps" in `fiber.ts`; (19) the Node internal loader is classified by *which API it owns* rather than by version, because v2 landed in 24.12.0 and a major-version test mistags 24.0–24.11.1 — the symptom was `dsh web` serving `__DSH_BOOT__.entries: []`; (22) the volatile-config subsystem across cosmokit/schemastery/cordis/loader, including the `simplify` schema-receiver fix; (11) `applyEntryPatches` is exported so `dsh --dump-config` cannot drift from what boots.
- Edge cases / failure handling: (8) an invalid config file must retain the running tree, but plugin activation failures can leave a partially applied tree — stated as a known limit; (14) a terminal write failure stays on the queue so `Include.stop()` rethrows it rather than silently declaring persistence complete.
- Surprising: entry 15 is a 700-word single paragraph describing lazy Loader config resolution ported from `cordiverse/cordis#41`; the log is the de-facto upstream contribution queue.

### vendor/AGENTS.md
- One line: seven-line policy file — "Do NOT edit `vendor/*/src/` casually; every local divergence from upstream must be logged exhaustively in `vendor/README.md`"; `tsconfig.json` is the sole exception.

### vendor/CLAUDE.md
- One line: a one-word file containing `AGENTS.md` — a pointer so a Claude-style agent finds the same policy.

### vendor/cordis-rc11-upgrade-plan.md
- Purpose: a *proposed*, not-approved plan to move the vendored Cordis stack from rc.7/rc.5 to rc.11/rc.8/1.1.1.
- Key abstractions: PR table with explicit prerequisites; `Vn` labels pointing back at the README's modification log; a **retire / partial / retain / prepare** vocabulary per patch; open-decision tables with an owning PR per decision.
- Data flow: PR 0 records the plan; PRs 1–3 and 4b are independent; 4a → 4c → 4e/4f form the dependency chain; every implementation PR must migrate every caller of the changed Core APIs *in the same PR*.
- Non-obvious design decisions: "a partially synchronized Loader, Include or HMR keeps its old manifest baseline and records the imported upstream slice in the local-modification log" — a half-synced package must never claim a version it does not match; a temporary `commit(change)` adapter lets the old Include implement the new Loader protocol by delegating to its existing `write()`.
- Edge cases / failure handling: "A later PR may not be required to repair an earlier PR's startup, types, persistence or teardown" — an acceptance criterion that makes each PR independently shippable; the risk section admits PR 4a's slice "is based on source inspection, not a completed migration experiment".
- Surprising: it is a *proposal* document that has been kept in the tree with a Status: proposed header and an explicit "PR 0 records this plan only. It does not approve the open runtime decisions."

### vendor/cordis/src/context.ts
- Purpose: the root and child dependency containers; the `Context` class is a `Proxy` whose property reads go through the service resolver.
- Key abstractions: `Context` interface (augmented by plugins via `declare module`); `Context.extend(meta)` prototypal child; `Context.isolate(name, label)` service scope; `Context.intercept(name, config)` per-service config merge; `symbols.isolate` / `symbols.intercept` maps.
- Data flow: `new Context()` builds the isolate/intercept maps, wraps itself in a `ReflectService.handler` proxy, creates the root `Fiber`, then installs `ReflectService`, `RegistryService`, `EventsService`, `LoggerService` and clears the root fiber's disposables.
- Non-obvious design decisions: `Context.is` brands with the **global** symbol `Symbol.for('cordis.is')` "because the brand is keyed by a global symbol rather than by `instanceof`" — it works across realms and across multiple copies of cordis; `Context.is[Symbol.toPrimitive] = () => Symbol.for('cordis.is')` makes a context stringify to its brand.
- Edge cases / failure handling: `extend()` re-creates the shadow layer when a parent shadow exists, so a shadowed service does not leak into the child.
- Surprising: the constructor returns the *proxy* (`return self`) from a class constructor — the object you get back is not `this`.

### vendor/cordis/src/index.ts
- One line: barrel that re-exports `context/events/fiber/logger/registry/service/utils` and re-exports the `Volatile` / `VolatileSnapshot` types from cosmokit.

### vendor/cordis/src/fiber.ts
- Purpose: the plugin lifecycle — one `Fiber` per `ctx.plugin()` call, tracking dependency state, validated config, effects and cleanup.
- Key abstractions: `FiberState` (`PENDING | LOADING | ACTIVE | FAILED | DISPOSED | UNLOADING`); `Effect` (a disposer, a promise of one, or a (async) iterable of them); `EffectMeta` diagnostics tree; `EffectRunner`; `CordisError` with a stable `Code`; `ValidationError`; `resolveConfig(runtime, config)`.
- Data flow: constructor → parent effect that owns the disposer → publish `internal/plugin` → resolve `inject` → `_refresh()` computes an **epoch** string from the resolved dependency implementations → `_setEpoch` transitions → `_reload()` resolves config through the `internal/config` waterfall, validates it, and runs the plugin callback → `_unload()` clears `_disposables` in parallel, each wrapped in `composeError`.
- Non-obvious design decisions: the **effect wrapper is pushed onto the owner's disposable list BEFORE the setup body runs** (`removeWrapper = this._disposables.push(wrapper)` then `task = this._execute(runner)`), so "an unload begun from inside setup awaits setup and every collected cleanup"; a synchronous setup failure removes the wrapper and rolls back the collected cleanup; `effectInertia` (a `WeakMap`) lets a structural owner *join* a cleanup another caller started while the public disposer stays single-shot; effect creation is refused while the owner is `UNLOADING` but allowed while `PENDING`/`LOADING`, because a `PENDING` fiber can already own effects registered by an `internal/plugin` observer; the loader may extend `inject` inside the `internal/plugin` notification, so dependencies are resolved only *after* publication.
- Edge cases / failure handling: `emitPluginDisposed` contains each teardown-notification failure **per observer** ("so one callback cannot starve peers or interrupt ownership cleanup"); `_reload` re-checks the epoch after an `await` so "a disposer queued before this checkpoint may already have invalidated the load" and plugin code is not run for a stale epoch; `await()` loops `while (this.inertia) await this.inertia` and rethrows the startup error; a rejected `inertia` is deliberately allowed to propagate because "process-level crash is the honest outcome"; `validateVolatileSchema`-style `INACTIVE_EFFECT` is thrown for an effect on a disposed fiber.
- Surprising: `Fiber.update()` does *not* restart immediately when the fiber is not `ACTIVE` — it defers the config resolution, because "Config resolution may access injected services, so defer it until the fiber can activate"; and `Fiber.name` walks up to the nearest named ancestor, so a plugin's logger name is its group name.

### vendor/cordis/src/service.ts
- Purpose: the base class for a named service exposed on `ctx` (e.g. `ctx.logger`, `ctx.loader`).
- Key abstractions: the `Service` symbol table (`init`, `check`, `config`, `invoke`, `extend`, `tracker`, `resolveConfig`); `Service[Service.invoke]` making a service callable (`ctx.logger('name')`); `Service[Service.filter]` implementing isolation scoping; `Service[Service.resolveConfig]` merging intercept config.
- Data flow: constructor registers itself via `ctx.reflect.provide(name, self, check)` so it is unregistered automatically when the owning fiber unloads; `resolveConfig` walks the intercept prototype chain from the root down, unshifting ancestor entries (root-first precedence), then prepends `base` and appends `head`.
- Non-obvious design decisions: `Service[Symbol.hasInstance]` is overridden to walk the constructor chain by hand because "constructor may be a proxy" — `instanceof` alone is unreliable for the callable/proxy service objects.
- Edge cases / failure handling: a service with a `Config.merge` uses it, otherwise a shallow `Object.assign`.
- Surprising: services are registered *in the constructor*, so a subclass field initializer that reads `ctx.<this service>` runs before the service exists.

### vendor/cordis/src/events.ts
- Purpose: the event bus mixed into every context (`ctx.on/once/emit/parallel/serial/bail/waterfall`).
- Key abstractions: `DispatchMode` (`emit | parallel | serial | bail | waterfall`); `Hook`; `EventOptions` (`prepend`, `global`); the `Events` interface listing every framework event.
- Data flow: `dispatch(type, args)` shifts the optional `thisArg` and the event name off the args, emits `internal/dispatch` for non-internal events, filters hooks by the context's isolation filter, and returns bound callbacks. `waterfall` pops the innermost `next` and composes the listener chain around it.
- Non-obvious design decisions: `internal/listener` is a **bail** event — a listener that returns a non-null value *replaces* the registration, which is how `internal/update` hooks are captured into `fiber._hooks`; `internal/update` is installed as a `global, prepend` listener so it always runs first; listeners are stored as *effects* on the owning fiber (`ctx.fiber.effect`), so they are removed on unload.
- Edge cases / failure handling: `parallel` uses `Promise.allSettled` and throws an `AggregateError` of the rejections, so one failing listener does not hide the others; `serial` stops at the first *bailed* value (`isBailed` = not null/false/undefined).
- Surprising: `ctx.on` calls `this.ctx.reflect.bind(listener)`, so every listener's `this` and arguments are re-bound to the dispatching context automatically.

### vendor/cordis/src/logger.ts
- Purpose: the built-in logging service — structured messages, pluggable exporters, a bounded in-memory buffer.
- Key abstractions: `Logger` facade (named logger with `error/info/warn/debug`); `Message` (`sn`, `ts`, `name`, `type`, `level`, `args`, `fiber` as a `WeakRef`); `Exporter` (`colors`, `maxLength`, `levels`, `formatters`, `export()`); `Formatter`; `LoggerLevel`; `defaultFormatters` (`s d i f o O c C`).
- Data flow: `ctx.logger(name)` → `_resolveConfig()` merges intercept config → a `Logger` bound to the fiber's name; each call increments `_snMessage`, builds a `Message`, and fans it out to every exporter whose level threshold allows it.
- Non-obvious design decisions: the message carries `fiber: new WeakRef(fiber)` — a *weak* reference so a log record can never keep a plugin alive; `Logger.code(name)` hashes the logger name into a 16/256-colour palette so each subsystem gets a stable colour; `exporter()` registers through `ctx.effect(...)` with the label `ctx.logger.exporter()`, so the exporter dies with the fiber that installed it.
- Edge cases / failure handling: a single `Error` argument is unwrapped to its `cause` or, for an `AggregateError`, to each of its `errors`; `Logger.format` truncates each rendered line at `maxLength` (default 10240) and appends `...`.
- Surprising: the service keeps a **1000-message ring buffer** (`bufferSize = 1000`, trimmed with `slice(-bufferSize)`) of every structured message — a free diagnostic transcript of the last N events, with monotonically increasing sequence numbers.

### vendor/cordis/src/reflect.ts
- Purpose: the reflection/service-resolution layer that powers the context proxy — `ctx.get/set/provide/accessor/mixin`.
- Key abstractions: `Impl` (`name`, `fiber`, `value`, `check`); `Property.Service` / `Property.Accessor`; `ReflectService.handler` (the proxy traps); `symbols.receiver`.
- Data flow: `provide(name, value, check)` registers an `Impl` under the current isolation label and wakes dependents via `notify([name])`; `notify` walks every registered runtime's fibers, re-checks the named injections, calls `_refresh()` on the affected fibers and emits `internal/service`; a service's disposer deletes the impl, notifies, and awaits the dependents' settlement *before* deleting its own entry from `fiber.store` ("ensure self access before dependencies cleanup").
- Non-obvious design decisions: the `get` trap walks the fiber chain — it finds the impl in the current fiber's `store`, refuses if the name is in `inject` but inactive ("cannot get required service in inactive context"), and stops when the isolation label changes; `mixin` is a **generator effect** that yields one accessor per mixed key, so all of them are torn down together.
- Edge cases / failure handling: `set` refuses when the providing fiber is not the current fiber ("cannot set property in multiple fibers"); `provide` throws when the name is already provided in the scope; `check` failures are logged and treated as "not available".
- Surprising: `isSpecialProperty` treats any property starting with `_`, any numeric-string, and `prototype`/`then` as special — `then` is special because a proxy that reports `then` becomes a thenable, which would make `await ctx.plugin(...)` misbehave.

### vendor/cordis/src/registry.ts
- Purpose: the plugin registry — normalises plugin shapes, tracks runtimes, starts fibers.
- Key abstractions: `Plugin` (Function | Constructor | Object with `apply`); `Plugin.Runtime` (`name`, `fibers`, `callback`, `Config`); `Inject` (array form = services without config, object form = service → intercept config); the `@Inject()` decorator for classes and class methods.
- Data flow: `ctx.plugin(plugin, config)` resolves the plugin to its `callback` (the registry identity key), creates or reuses the `Runtime`, and constructs a `Fiber`; the returned object is `Object.create(fiber)` with a `then` wired to `fiber.await()`, so `await ctx.plugin(...)` settles the fiber and rethrows its startup error.
- Non-obvious design decisions: `plugin.name === 'apply'` is treated as "no name" (an object plugin's `apply` is not a display name); the `@Inject()` *method* decorator delays the call until the declared services are available, via an init hook that calls `ctx.inject(...)`; `Inject.resolve` walks the prototype chain when the inject map carries the `checkProto` marker, so a subclass can extend its parent's declared injections.
- Edge cases / failure handling: `resolve()` swallows a throwing `plugin.apply` and reports "invalid plugin"; `delete(plugin)` disposes every live fiber and removes the runtime.
- Surprising: the registry's identity is the *callback function*, so two different plugin objects that resolve to the same function share one `Runtime` and one `Config` schema.

### vendor/cordis/src/utils.ts
- Purpose: shared internals — `DisposableList`, the global symbol table, prototype joining, traceable proxies, and error-stack composition.
- Key abstractions: `DisposableList<T>` (O(1) delete by value via a `WeakMap` index, `clear()` returns values reversed); `Tracker` (`associate`, `property`, `noShadow`); the `symbols` table (all `Symbol.for`, so they cross module copies); `getTraceable` / `createTraceable`; `composeError` / `buildOuterStack`.
- Data flow: `createTraceable(ctx, value, tracker)` returns a proxy whose `get` rewrites `ctx` to the caller's context, and — for `noShadow` services — keeps the *origin* context so identity-aware services (the logger) still resolve the origin fiber.
- Non-obvious design decisions: `composeError` splices the **outer call-site frames** into a thrown async error's stack, so a plugin author's error shows the call site rather than the framework's internals; `handleError` finds the inner frame inside the outer stack and replaces everything after it; `isConstructor` returns false for arrow/async/generator functions (the `func.prototype` check) so a plugin callback is not `new`-ed.
- Edge cases / failure handling: `DisposableList.push` returns a remover closure; `clear()` returns the values *reversed* so callers can dispose in reverse registration order.
- Surprising: every symbol in the table is `Symbol.for(...)` — a deliberate global registry so two copies of cordis in one process still agree on `cordis.effect`, `cordis.shadow` and friends.

### vendor/cordis/src/index.ts
### vendor/cordis/bin.js
- One line: a 16-line CLI that boots a `Context`, sets `baseUrl` from `process.cwd()`, loads the Loader, and asks it to include `./cordis.yml`.

### vendor/cordis/README.md
- One line: upstream Cordis README (install, quick start with a `Counter` service, package table) plus a final "Volatile configuration" paragraph documenting that a schema may return `Volatile<T>` references read through `.get()`, and that Loader commits volatile-only changes into the running references without restarting.

### vendor/cordis/package.json
- One line: `@deepseek-ai/cordis` 4.0.5, ESM-only (`"type": "module"`), publishes `lib/index.js` + `lib/types/**/*.d.ts` **and `src`** — the `src` entry was added so the `"./src/*"` export map does not point at absent files.

### vendor/cordis/tsconfig.json
- One line: extends the repo-root `tsconfig.base.json`, emits to `lib/types`, and relaxes `noImplicitAny`, `noImplicitThis`, `strictFunctionTypes`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` for this vendored package.

### vendor/cordis/LICENSE
- One line: the upstream MIT licence text, copyright Shigma, preserved per the vendor policy.

### vendor/cosmokit/src/volatile.ts
- Purpose: the **volatile config reference** — a stable object whose *value* can be replaced in place, so a consumer keeps a reference and never has to be remounted.
- Key abstractions: `Volatile<T>` (`get(): VolatileSnapshot<T>`); `VolatileSnapshot` (recursively readonly); the internal `write` symbol (`Symbol.for('cosmokit.volatile.write')`).
- Data flow: `createVolatile(value)` takes a **detached immutable copy** (`snapshot()` freezes plain objects/arrays recursively) and returns a frozen `{ get, [write] }`; `updateVolatile(target, source)` transfers a candidate's snapshot into an existing reference; `volatileEntries(value)` enumerates the references and their object-key paths through plain config containers.
- Non-obvious design decisions: `snapshot()` **rejects** functions ("volatile config cannot contain functions"), **rejects cycles** ("volatile config cannot contain cycles") and rejects non-plain objects ("volatile config objects must be plain objects or arrays") — because the value must be safely copyable and comparable; the `write` symbol is `Symbol.for` so a reference is recognised across ESM/CJS copies of cosmokit.
- Edge cases / failure handling: `volatileEntries` stops at snapshots and opaque objects and visits each ordinary cyclic field once per path; `isVolatile` is a duck-type check (`write in value`).
- Surprising: a volatile reference is *frozen* — the only way to change it is the internal `write` symbol, which is what makes "commit a new value into the running reference" a single, auditable operation.

### vendor/cosmokit/src/types.ts
- Purpose: runtime type predicates, binary conversion, deep clone, and `deepEqual`.
- Key abstractions: `is(type, value)` (instanceof with a `Object.prototype.toString` fallback); the `Binary` namespace (`is`, `isSource`, `fromSource`, `toBase64`, `fromBase64`, `toHex`, `fromHex`); `clone(source, refs)`; `deepEqual(a, b, strict?)`.
- Data flow: `clone` preserves prototypes and property descriptors and handles cycles via a `refs` map; `deepEqual` compares arrays slot by slot, `Date` by `valueOf`, `URL` by normalized `href`, `RegExp` by source+flags, `ArrayBuffer`s byte by byte, and other objects key by key.
- Non-obvious design decisions: **`deepEqual` treats two volatile references as equal regardless of their snapshots** (`if (isVolatile(a) || isVolatile(b)) return isVolatile(a) && isVolatile(b)`) — so a config change that only swaps a volatile value does not read as a data change; snapshot-change detection must compare `.get()` separately; in strict mode two *distinct* cyclic structures compare unequal (`ancestors.has(a) → false`).
- Edge cases / failure handling: array holes are treated as `undefined` because every index is visited; opaque objects compare by identity in strict mode.
- Surprising: `is()` falls back to `Object.prototype.toString` so a value from another realm (an iframe, a vm context) still matches its type name.

### vendor/cosmokit/src/misc.ts
- One line: 78 lines of shared types and small helpers — `Dict`, `Get`, `Extract`, `MaybeArray`, `Promisify`, `Awaitable`, `Intersect`, plus `noop`, `isNullable`, `isNonNullable`, `isPlainObject`, `filterKeys`, `mapValues`/`valueMap`, `pick`, `omit` and a `defineProperty` that always creates a **non-enumerable** property.

### vendor/cosmokit/src/array.ts
- One line: 42 lines of array helpers — `contain`, `intersection`, `difference`, `union`, `deduplicate`, `remove` (splices in place, reports whether it was found) and `makeArray` (normalises nullish/scalar/array input to an array).

### vendor/cosmokit/src/string.ts
- One line: 113 lines of string helpers — `capitalize`/`uncapitalize`, `camelCase`, a hand-written `tokenize` powering `paramCase`/`snakeCase` (which handles `HTTPServer` → `http_server` correctly), the `camelize`/`hyphenate` runtime aliases, the type-level `camelize`/`hyphenate`, `formatProperty` (`.foo` vs `["foo-bar"]`), `trimSlash` and `sanitize`.

### vendor/cosmokit/src/time.ts
- One line: 92 lines of time helpers — the `Time` namespace with millisecond→week constants, a settable timezone offset, `getDateNumber`/`fromDateNumber`, a `parseTime` that understands "3d2h"-style strings, `parseDate`, a humanising `format` (ms/s/m/h/d) and `template` for `yyyy-MM-dd hh:mm:ss` patterns.

### vendor/cosmokit/src/index.ts
- One line: barrel re-exporting `array`, `types`, `misc`, `string`, `time` and `volatile`.

### vendor/cosmokit/README.md
- One line: upstream README plus a "Config references" section documenting `createVolatile`/`updateVolatile`/`volatileEntries`, the shared-symbol protocol, and the rule that "Snapshot-change detection must compare `.get()` results separately".

### vendor/cosmokit/package.json
- One line: `@deepseek-ai/cosmokit` 1.8.6, ESM, publishes `lib/index.js`, the type declarations and `src`.

### vendor/cosmokit/tsconfig.json
- One line: extends `tsconfig.base.json`, emits to `lib/types`, relaxes `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`/`noImplicitOverride`/unused-locals; no project references (it is the leaf of the vendored graph).

### vendor/cosmokit/LICENSE
- One line: the upstream MIT licence text (Shigma), preserved.

### vendor/group/src/index.ts
- One line: a three-line re-export — `import { Group } from '@deepseek-ai/cordis-plugin-loader'; export default Group` — so the group plugin can be referenced by its own package name.

### vendor/group/README.md
- One line: upstream README explaining that a group entry is always enabled itself but disabling it stops its children, and that nested entry ids use `:` separators (e.g. `tools:logger`).

### vendor/group/package.json
- One line: `@deepseek-ai/cordis-plugin-group` 1.0.5, ESM, peer-depends on the loader and cordis workspaces.

### vendor/group/tsconfig.json
- One line: extends the root base config, emits to `lib/types`, with project references to `../cordis` and `../loader`.

### vendor/group/LICENSE
- One line: the upstream MIT licence text, preserved.

### vendor/hmr/src/index.ts
- Purpose: hot module replacement for loader-managed plugins — watch files, trace Node's module graph, clear the affected caches and reload only the plugin entries that depend on the changed files.
- Key abstractions: `Hmr` service (`@Inject('loader') @Inject('timer')`); `Hmr.Config` (`base`, `root`, `ignored`, `debounce`); `loadDependencies(job)`; the accepted/declined/stashed sets; `ModuleLoader` (v1/v2) from the loader package.
- Data flow: `realpath` the base dir → collect the **externals** (the CLI worker's dependency tree) *before* opening the watcher → open chokidar with `ignoreInitial: true` → on change: externals ⇒ `loader.exit()` (full reload); in `loadCache` ⇒ stash + debounced `partialReload()`; matches an Include's filename ⇒ `include.refresh()`; otherwise emit `hmr/change` → `partialReload` classifies changes into accepted/declined via the module dependency graph, resolves each plugin name to a URL, backs up and clears both the ESM loadCache and the CJS `require.cache`, re-imports, and swaps the plugin registration.
- Non-obvious design decisions: the externals are collected *before* the watcher opens "so every post-ready change is observed by listeners that already have their classification state"; `Map.prototype.get/delete/set` are called **directly** on the loadCache because in Node 24 `LoadCache.delete()` only sets the type slot to `undefined` instead of removing the entry; the base directory is realpath'd because "Windows supplied an 8.3 alias" and the module cache keys on the canonical path; a `ready` promise gates the service start so a watch error during startup fails the plugin rather than being swallowed.
- Edge cases / failure handling: cache backup + `rollback()` restores the ESM and CJS caches if the re-import or the reload throws; a failed plugin dispose is logged and the loop continues; `handleError` renders a build failure with a code frame.
- Surprising: a changed file that is in the framework's own dependency tree triggers a **process-level restart** (`loader.exit()`), not a plugin reload — a deliberate split between "reload this plugin" and "restart everything".

### vendor/hmr/src/error.ts
- One line: 36 lines that turn an esbuild `BuildFailure` into a readable log — for each error with a `location`, read the source file and render a `@babel/code-frame` frame with the message highlighted.

### vendor/hmr/README.md
- One line: upstream README documenting the watcher, the canonicalisation of the watch base directory, the `--expose-internals` requirement (the plugin throws without it) and the `hmr/change` / `hmr/reload` events.

### vendor/hmr/package.json
- One line: `@deepseek-ai/cordis-plugin-hmr` 1.0.20, ESM; dependencies `chokidar`, `picomatch`, `@babel/code-frame`, schemastery; devDependency `esbuild` exists **only** for the imported `BuildFailure` type.

### vendor/hmr/tsconfig.json
- One line: extends the root base config and declares project references to six vendored packages (`cosmokit`, `cordis`, `loader`, `include`, `timer`, `schemastery`).

### vendor/hmr/LICENSE
- One line: the upstream MIT licence text, preserved.

### vendor/include/src/index.ts
- Purpose: the file-backed loader tree — reads a YAML/JSON entry list, applies runtime patches, writes changes back, and refreshes on demand.
- Key abstractions: `Include` (an `EntryTree` subclass); `Include.Config` (`path`, `initial`, `patches`, `enableLogs`); `PatchOptions`; the exported pure `applyEntryPatches(data, patches, warn)`; the exported `entryListSchema` (a `js-yaml` `JSON_SCHEMA` extended with the `!!js` tag).
- Data flow: `read()` parses the file → rejects anything that is not a top-level array → commits `content`/`data` only on success → `applyPatches` → `root.update(...)` starts/stops/restarts the child entries; `write()` schedules a debounced write onto a serialised `writeQueue`; `refresh()` re-reads and updates, catching any error and keeping the last good tree.
- Non-obvious design decisions: the patch algorithm is **exported as a pure function** so `dsh --dump-config` composes and prints exactly what the include would mount ("config tooling must never reimplement (and drift from) the patch algorithm"); `applyEntryPatches` **never mutates its input** (`structuredClone`) because patching shared entry objects would bake earlier patch values into the cached parse, so a repeated application (hot reload) could never revert a removed patch; **inserted entries are indexed as they are added** so a later patch in the same list can configure or disable a row an earlier patch inserted; `Include` declares `EntryGroup.key` so the Loader's `internal/config` interpolation keeps its config literal (a `!!js` expression inside a nested row belongs to that row's own fiber); `initial` is used **only** after `ENOENT` — an existing-but-invalid file fails loud with its real parse error and is never silently overwritten; the write is atomic (write `.tmp`, then `rename`).
- Edge cases / failure handling: the rename is retried up to 10 times with a linear backoff on `EACCES`/`EBUSY`/`EPERM` (Windows can briefly retain the destination handle after a Loader child disposes); a terminal failure stays on the queue so `Include.stop()` rethrows it rather than silently declaring persistence complete; `refresh()` logs "config reload at %C failed; keeping the running tree" — "a hot-reload of a live app must never take the process down"; the `internal/update` handler **vetoes** the fiber restart (children update in place) but persists the new config itself, because `Fiber.update` only assigns `this.config` behind `next()` and a stale `patches` would make the next `refresh()` re-apply the old overlay.
- Surprising: `read()` compares the raw *content* string, not the parsed data — so an edit that is later reverted to the exact last good content correctly reads as "unchanged".

### vendor/include/README.md
- One line: upstream README describing the file-backed tree, the four config fields and the patch semantics (insert entries, or override fields on entries with a matching `id`).

### vendor/include/package.json
- One line: `@deepseek-ai/cordis-plugin-include` 1.0.10, ESM, peer-depends on the loader and cordis workspaces, depends on `js-yaml`.

### vendor/include/tsconfig.json
- One line: extends the root base config and references `../cosmokit`, `../cordis`, `../loader`.

### vendor/include/LICENSE
- One line: the upstream MIT licence text, preserved.

### vendor/loader/src/index.ts
- Purpose: the `Loader` service — owns an `EntryTree`, imports plugin modules, applies their config and keeps the running graph in sync with entry updates.
- Key abstractions: `Loader extends EntryTree`; `Loader.Config` (`baseUrl`); `Loader.Intercept` (`await`); the loader event vocabulary (`loader/config-update`, `loader/entry-init`, `loader/partial-dispose`, `loader/volatile-update`, `loader/patch-context`); `Loader.builtins` (the `cordis:` builtin namespace).
- Data flow: the constructor installs four global hooks — an `internal/config` waterfall that interpolates `!!js` expressions, an `internal/update` waterfall that writes the simplified config back to the entry and persists the tree, a second `internal/update` that logs "reload", and an `internal/plugin` observer that resolves self-disposal into `entry.options.disabled = true` — then loads the `isolate` plugin.
- Non-obvious design decisions: the `internal/config` waterfall **returns the config literal for tree carriers** (`if (plugin?.[EntryGroup.key]) return config`) so a nested row's expression resolves in that row's own fiber; the config written back on update is produced by `unparse.call(this.runtime!.Config, config)` — the `simplify` call needs its **schema receiver**, so an unbound `this` would throw; the `internal/plugin` observer distinguishes six disposal cases (created / untracked / child plugin / plugin deletion / tree disposal / loader behaviour) and only writes `disabled = true` for the loader-behaviour case.
- Edge cases / failure handling: `Loader[Service.check]` returns false while tasks are pending when `await` is configured, so dependents stay pending instead of starting against a half-loaded tree; `unwrapExports` normalises ESM/CJS/default shapes with the esbuild interop rule (`exports.default ?? exports` twice, guarded by `__esModule`).
- Surprising: `Loader.envData` is read from `process.env.CORDIS_SHARED` — a JSON blob shared between processes — and defaults to `{ startTime: Date.now() }`.

### vendor/loader/src/internal.ts
- Purpose: typed access to Node's **internal** ESM module loader, so the loader and HMR can import and invalidate modules the way Node does.
- Key abstractions: `ModuleLoaderV1` (Node 22/23) and `ModuleLoaderV2` (Node 24+), with their breaking differences documented inline; `ModuleJob`; `ModuleWrap`; `LoadCache`; `ModulePhase`; `ModuleRequest`.
- Data flow: `ModuleLoader.fromInternal()` requires Node ≥ 22, loads `internal/modules/esm/loader` through `createRequire` (preferring `--expose-internals`, falling back to `node-addon-require-builtin`), then classifies the shape.
- Non-obvious design decisions: **the shape is decided by which module-job API the loader owns, never by the Node version** — v2 landed in 24.12.0, so a major-version test mistags every 24.0–24.11.1 loader as v2 and makes consumers call `resolveSync` with reversed parameters; arity cannot discriminate the two shapes because `resolveSync.length === 2` under both. A loader owning neither API is left **unclassified** rather than guessed, so consumers take their documented no-internals path.
- Edge cases / failure handling: the internal module is optional; the `requireInternal` helper swallows both failure paths and returns `undefined`.
- Surprising: the recorded symptom of the mistagging bug was `dsh web` serving an empty client graph (`__DSH_BOOT__.entries: []`) and HMR partial reload resolving no entry URL, "both behind swallowed or warn-level errors" — a version-detect bug presenting as an empty UI.

### vendor/loader/src/config/entry.ts
- Purpose: one configured plugin node in the tree — importing, starting, updating, pausing and disposing it.
- Key abstractions: `Entry`; `EntryOptions` (`id`, `name`, `config`, `group`, `disabled`, `inject`); `Entry.key = Symbol.for('cordis.entry')`; `moduleNamespace` (the raw import result, kept before export normalisation for HMR).
- Data flow: `update(options)` merges the options → if disabled, dispose → otherwise diff the options against the legacy ones → if the only change is `config` and the change is **volatile-only**, commit it into the running references without a remount → otherwise emit `loader/partial-dispose`, patch the context and restart. `init()` imports the module, unwraps the exports, patches the context and starts the plugin through `ctx.registry.plugin(...)`.
- Non-obvious design decisions: `_commitVolatile()` re-parses the raw config through the fiber's own `internal/config` hook and schema, compares the *ordinary* effective values with `deepEqual(..., true)`, and only then commits the volatile references and emits `loader/volatile-update` to the owning fiber — "every value is committed before dispatch"; the volatile-only fast path additionally requires the fiber to be `ACTIVE` **and** the context prototype to be unchanged; `moduleNamespace` is retained *before* plugin export normalisation so HMR can match it against Node's cached module namespace.
- Edge cases / failure handling: an invalid candidate is logged ("volatile config update failed for %C") and leaves the running references unchanged, with the raw config retained for the next activation; a throwing `loader/volatile-update` listener is logged and does not fail the update ("every value is already committed"); `getOuterStack()` builds a synthetic stack of `at <tree baseUrl>#<entry id>` frames so a plugin error points at the config row that loaded it.
- Surprising: the `disabled` field may be a `!!js` expression evaluated against the loader context **at every mount decision**, while the raw node stays in the options so a write-back keeps the `!!js` form.

### vendor/loader/src/config/diff.ts
- Purpose: compare two raw configs while ignoring schema-declared volatile fields — without executing expressions, validators or `internal/config` hooks.
- Key abstractions: `equalExceptVolatile(previous, next, schema)`; the recursive `equal(a, b, schema, ancestors)`; the `isSchemastery` vendor check (`schema['~standard'].vendor === 'schemastery'`).
- Data flow: the recursion walks the schema's `dict`; a node whose `meta.volatile` is set compares equal immediately; a missing or null object node compares against its **declared default**; unknown fields, expressions, opaque values and schema back-edges keep strict raw equality.
- Non-obvious design decisions: the comparison never evaluates anything — a `!!js` expression node is detected (`isJsExpr`) and excluded from the "is this a record" test, so no side effect can fire during a change decision; the `ancestors` set makes a recursive schema fall back to raw comparison instead of recursing forever.
- Edge cases / failure handling: a non-Schemastery schema (or no schema) compares everything raw via `deepEqual(a, b, true)`.
- Surprising: an absent object node compares using its declared default — so "the field is missing" and "the field equals the default" are the *same* config, which is what makes a volatile-only diff possible without re-parsing.

### vendor/loader/src/config/group.ts
- Purpose: a runtime owner for a list of child loader entries (the `Group` plugin and the `Include` tree's root).
- Key abstractions: `EntryGroup` (`static key = Symbol.for('cordis.group')` — the tree-carrier marker); `Group extends EntryGroup` (the plugin); the `data: EntryOptions[]` child list.
- Data flow: `Group[Service.init]` yields a cleanup that calls `stop()`, then `update(this.config)` creates/updates/removes children in parallel with `Promise.all`; each child create replaces the entry options and updates the entry; removals dispose the fiber, unlink the options and emit `loader/partial-dispose`.
- Non-obvious design decisions: `EntryGroup.key` is a `Symbol.for` marker — Include declares the same one — and the Loader's `internal/config` hook uses it to recognise a "tree carrier" whose config holds other rows' configs and must therefore stay literal; `update()` diffs old and new by id and only creates or removes the difference.
- Edge cases / failure handling: a child create failure is logged (`this.ctx.logger.error(error)`) and the remaining children still update.

### vendor/loader/src/config/isolate.ts
- Purpose: per-entry service isolation — let one entry provide a *different* implementation of a service than its siblings see.
- Key abstractions: `Realm` (an abstract symbol namespace); `LocalRealm` (per entry, suffix `#<id>`); `GlobalRealm` (per label, suffix `@<label>`); the `isolate` plugin function.
- Data flow: on `loader/entry-init` each entry gets its own isolate/intercept map; on `loader/patch-context` the plugin computes a new isolate map, diffs the *service implementations* between the old and new realms, swaps the maps, reloads the fiber, transfers the implementation records, notifies the affected fibers and cleans up the delimiter symbols; on `loader/partial-dispose` it garbage-collects a `GlobalRealm` once no entry references it any more.
- Non-obvious design decisions: a per-entry "delim" symbol marks the *owner* of a service implementation so the transfer can be decided by comparing delimiters rather than by object identity; the implementation record is moved only when the delimiters disagree and the target slot is empty — a conservative, non-destructive transfer.
- Edge cases / failure handling: an isolate option naming a service that nothing implements logs "expected service %s to be implemented" and is skipped rather than throwing.
- Surprising: `Realm.access(key, create)` returns a **new** symbol when `create` is false and the key is not in the store — the two branches are identical, so a "read" of an unknown key silently produces a fresh symbol; this is safe only because the store lookup happens through the isolation map.

### vendor/loader/src/config/tree.ts
- Purpose: the mutable tree of loader entries, with persistence delegated to subclasses.
- Key abstractions: `EntryTree` (abstract `write()`); `EntryTree.sep = ':'`; `EntryGroup root`; `store: Dict<Entry>`; `entries()` generator; `getTasks()` / `await()`.
- Data flow: `create(options, parent, position)` splices the options into the group's list, persists, and starts the entry; `update(id, options, parent?, position?)` moves the entry between groups and restarts it; `remove(id)` stops and deletes; `import(name)` resolves a `cordis:` builtin or imports the module through the internal loader (falling back to a plain dynamic `import()`).
- Non-obvious design decisions: `getTasks()` collects *every* pending import or fiber-inertia task across the whole tree, and `await()` loops until it is empty — one "is the system settled?" query for the whole configuration; `resolve(id)` splits on `:` and walks nested subtrees; `ensureId` generates a random 8-hex id and retries on collision.
- Edge cases / failure handling: `import()` wraps the call in `composeError` with an adjusted stack offset so the error names the plugin, not the loader; the loader's own root tree is in-memory, so `Loader.write()` is a no-op.

### vendor/loader/src/config/utils.ts
- One line: 32 lines holding the `!!js` expression dialect — a `new Function('ctx','expr', 'with (ctx) { return eval(expr) }')` evaluator, a recursive `interpolate` that replaces `{__jsExpr}` nodes, and the `isJsExpr` type guard.

### vendor/loader/README.md
- Purpose: upstream README plus a dense "Volatile configuration" section that states the whole volatile contract in one paragraph.
- Key abstractions: the `Entry` API table (`create/update/remove/resolve/resolveGroup/await/locate`, plus `loader.resolve(id).moduleNamespace`); the volatile contract.
- Data flow: `Entry.update` compares raw options strictly; a config-only change on an active fiber in an unchanged context is compared with `equalExceptVolatile`; `_commitVolatile` re-parses through the fiber's `internal/config` hook and commits the new values into the running references, emitting `loader/volatile-update` with the changed paths.
- Non-obvious design decisions: the README documents the *limits* explicitly — "an ordinary field whose transform builds a fresh instance on every parse always takes that remount" because strict comparison treats class instances other than URL/Date/RegExp by identity; "a throwing `loader/volatile-update` listener is logged and does not fail the update".
- Edge cases / failure handling: Group/Include retain child dispatch; programmatic `Fiber.update` preserves saving and `noSave`; `simplify` is called with its schema receiver so saved config contains plain values.

### vendor/loader/package.json
- One line: `@deepseek-ai/cordis-plugin-loader` 1.0.6, ESM, peer-depends on cordis and (optionally) `node-addon-require-builtin@^0.1.9` — the native helper used to reach Node's internal loader without `--expose-internals`.

### vendor/loader/tsconfig.json
- One line: extends the root base config, emits to `lib/types`, and references `../cosmokit`, `../cordis`, `../schemastery`.

### vendor/loader/tsdown.config.ts
- One line: a 16-line build override — a single ESM entry `lib/types/index.js` re-bundled to `lib/` with `codeSplitting: false`, `dts: false` and `clean: false` (it must not wipe the `lib/types` output tsc just produced).

### vendor/loader/LICENSE
- One line: the upstream MIT licence text, preserved.

### vendor/logger-console/src/shared.ts
- Purpose: the shared console exporter — renders a `Message` into a labelled, coloured, timestamped line.
- Key abstractions: `ConsoleExporter` (implements Cordis' `Exporter`); `ConsoleExporter.Config` (`colors`, `maxLength`, `levels`, `showDiff`, `showTime`, `label`); `LabelStyle` (`width`, `margin`, `align`); the `Config` schemastery schema that declares the same fields.
- Data flow: the constructor merges `getDefaults()` with the user config and registers itself with `ctx.logger.exporter(this)`; `render(message)` composes the time stamp, the colour-coded logger name padded to the configured width, the `[E]/[I]/[W]/[D]` prefix and the formatted body, indenting continuation lines, and appends the elapsed time since the previous message when `showDiff` is on.
- Non-obvious design decisions: the **schema is the config contract** — the same fields are declared once in schemastery and once in the interface, so the settings UI can be generated from the schema; `showTime` is a `Time.template` pattern; the per-line truncation is inherited from `Logger.format`.
- Edge cases / failure handling: label alignment is left/right via `padStart`/`padEnd`; the `margin` widens the gap between name and prefix.

### vendor/logger-console/src/index.ts
- One line: the Node entry — re-exports `shared.ts` and overrides the `%o`/`%O` formatters with `node:util.inspect` (`depth: Infinity`, `compact: true`), and derives the default colour level from `supports-color`.

### vendor/logger-console/src/browser.ts
- One line: the browser entry — re-exports `shared.ts` and dispatches to `console.error`/`console.warn`/`console.log` with a `[E] name` prefix, passing the raw args through.

### vendor/logger-console/README.md
- One line: upstream README with the config table and the note that the Node entry uses `node:util.inspect` for `%o`/`%O` while the browser entry passes arguments straight to `console`.

### vendor/logger-console/package.json
- One line: `@deepseek-ai/cordis-plugin-logger-console` 1.0.5 — a two-entry package: `exports['.'].node` → `lib/index.js`, `default` → `lib/browser.js`, with `types` pointing at the shared declaration.

### vendor/logger-console/tsconfig.json
- One line: extends the root base config, emits to `lib/types`, and references `../cosmokit`, `../cordis`, `../schemastery`.

### vendor/logger-console/tsdown.config.ts
- One line: a build override producing **two single-entry passes** (`lib/types/index.js` and `lib/types/browser.js`) so the shared base class is inlined into each instead of being split into a hash-named chunk — matching upstream's published shape.

### vendor/logger-console/LICENSE
- One line: the upstream MIT licence text, preserved.

### vendor/schemastery/src/index.ts
- Purpose: the type-driven schema validator that every plugin's `Config` uses, and the source of the settings-UI metadata.
- Key abstractions: `Schema` (callable and constructible); `Schemastery.Meta` (`default`, `required`, `volatile`, `role`, `description`, `comment`, `link`, `pattern`, `min`/`max`/`step`, `badges`, `hidden`, `loose`, `collapse`, `disabled`, `extra`); `Schemastery.Options` (`autofix`, `ignore`, `path`); `SchemaMode` (`plain | defined | volatile | volatile-defined`); the `resolvers` registry keyed by type; `ValidationError` with a `$`-rooted path.
- Data flow: `Schema.resolve(data, schema, options)` runs the type-specific resolver, which recursively resolves children and returns `[value, adaptedInput]`; the `~standard` property exposes the Standard Schema v1 interface, so any compatible tool can validate a config without depending on Schemastery; `Schema.prototype.simplify(value)` walks the schema backwards to strip values equal to their defaults.
- Non-obvious design decisions: `validateVolatileSchema` **rejects a volatile field that does not have a fixed object path** — "volatile fields require a fixed object path without an enclosing volatile field" — because a volatile reference's path is what the runtime uses to commit a new value; `simplify()` unwraps a volatile reference (`if (isVolatile(value)) value = value.get()`) before comparing to the default, so persistence stores plain data; `Schema.from` infers a schema from a primitive, a constructor or an existing schema; `Schema.lazy` defers a recursive schema's construction until validation or serialisation, and the lazy resolver validates the volatile placement **once**, when it builds.
- Edge cases / failure handling: `options.autofix` deletes an invalid object property instead of throwing; `options.ignore` skips validation for selected values; `loose` schemas return their default instead of throwing; `union` collects every member's error and reports them together; `intersect` merges object outputs; `transform` with `preserve` keeps the adapted input.
- Surprising: `kSchema = Symbol.for('schemastery')` and `kValidationError = Symbol.for('ValidationError')` are **global** symbols, so a schema or an error produced by another copy of the library is still recognised; and `Schema.prototype.toJSON` serialises shared and recursive references through a global `__schemastery_refs__` registry, so a schema graph can be JSON round-tripped.

### vendor/schemastery/README.md
- One line: upstream README (every type, the instance methods, validation options, shorthand syntax, extensibility, serialisability) plus a final "Volatile configuration" section describing `.volatile()`'s semantics and pointing at the configuration guide.

### vendor/schemastery/package.json
- One line: `@deepseek-ai/schemastery` 3.18.5, **dual format** — `main` → `lib/index.cjs`, `module` → `lib/index.mjs`, `exports` selecting `import`/`require` — because without conditional exports a concurrent import under a module-hook host can reach the CJS entry and race its `require` of ESM Cosmokit (`ERR_REQUIRE_ESM_RACE_CONDITION`).

### vendor/schemastery/tsconfig.json
- One line: extends the root base config, emits to `lib/types`, uses `"module": "preserve"`, and references `../cosmokit`.

### vendor/schemastery/tsdown.config.ts
- One line: a build override that produces both formats and **pins the extensions** (`outExtensions: ({format}) => ({js: format === 'es' ? '.mjs' : '.cjs'})`) so the package keeps the `main`/`module` split its manifest declares.

### vendor/schemastery/LICENSE
- One line: the upstream MIT licence text, preserved.

### vendor/timer/src/index.ts
- Purpose: disposal-aware timers — every timer handle is registered on the current fiber and cleared when that fiber unloads.
- Key abstractions: `TimerService extends Service` (registered as `timer`); `ctx.timeout` / `ctx.interval` / `ctx.throttle` / `ctx.debounce`; the deprecated `ctx.setTimeout` / `ctx.setInterval` aliases.
- Data flow: `timeout(callback, delay)` registers a `ctx.effect` whose disposer clears the timer; `timeout(delay)` returns a promise that rejects with "Context has been disposed" if the fiber dies first; `interval(delay)` returns an async iterator that yields on each tick; `_schedule` backs `throttle`/`debounce` with a disposer that also flips an `isDisposed` flag so a pending trailing call is dropped rather than fired after teardown.
- Non-obvious design decisions: the service **mixes** its methods onto `ctx` in its constructor (`ctx.mixin('timer', [...])`), so `ctx.timeout(...)` is the primary spelling; the async-iterator form resolves a pending `next()` on teardown by *rejecting* it with a disposal error rather than leaving it hanging.
- Edge cases / failure handling: `Promise.withResolvers` is used (Node 22+); the `throttle` `noTrailing` flag is threaded through the `isDisposed` argument of `_schedule`.
- Surprising: `throttle`'s `lastCall` starts at `-Infinity`, so the first call always executes immediately.

### vendor/timer/README.md
- One line: upstream README with the API table and the statement that "Timer handles are registered on the current fiber, so they are cleared automatically when the plugin that created them is disposed."

### vendor/timer/package.json
- One line: `@deepseek-ai/cordis-plugin-timer` 1.1.7, ESM, exports `./locale/*.json` and publishes the `locale` directory alongside `lib` and `src`.

### vendor/timer/tsconfig.json
- One line: extends the root base config, emits to `lib/types`, and references `../cosmokit` and `../cordis`.

### vendor/timer/locale/en.json
- One line: 5-line locale file — `{"meta": {"title": "timer"}}`; the English Settings-plugin inventory title.

### vendor/timer/locale/zh.json
- One line: 6-line locale file — `{"meta": {"title": "计时服务", "description": "为其他插件提供延时和周期执行能力。"}}`; the Chinese counterpart.

### vendor/timer/LICENSE
- One line: the upstream MIT licence text, preserved.

### vitest.config.ts
- Purpose: the root unit/coverage lane — the repo's entire test inventory, its platform-conditional membership, and its coverage gate.
- Key abstractions: `testIncludes` (`packages/*/*/tests/**`, `apps/*/tests/**`, `scripts/**`, `website/tests/**`); the `thread-safe` and `process-bound` **projects**; `windowsUnsupportedPackages` / `windowsUnsupportedTests` / `platformUnsupportedTests`; `coverageExemptHeavySuites`; `coveragePartitionMode`; the `uncoveredLocationsReporter`.
- Data flow: a single `vitest` invocation runs both projects; every suite forks (Node 24 has aborted in the CJS lexer from worker threads on all three platforms, so forked workers avoid the shared thread path); coverage is v8 over `packages/*/*/src/**` with a per-file 100% threshold; `COVERAGE_PARTITION_MODE=1` disables the thresholds and the reporter so CI can shard the run.
- Non-obvious design decisions: the Windows exclusion list is an **explicit list, not a `packages/shell/*` glob**, so `packages/shell/shell` keeps running on Windows; the pwsh suites stay *included* because PowerShell ships with Windows; the pwsh **coverage** exemption is decided by *running the suites' own resolution* (`spawnSync(resolvePwshPath(), …)`) so the exemption is active exactly when the suites skip; a set-but-not-`'1'` env value throws rather than silently disabling a gate.
- Edge cases / failure handling: `processBoundTests` (8 suites touching process-global state) run in their own project "for inventory control"; the `testIncludes` glob covers `.tsx` client-component specs through a per-file `@vitest-environment` pragma; every v8 ignore comment must carry a reason.
- Surprising: the coverage `exclude` list is ~120 lines long and every entry carries a prose reason (a browser-grade harness, a generated bundle that only exists in `lib`, a native Electron integration) — the gate is a negotiation with reality, documented in place.

### vitest.shared.ts
- Purpose: the two things every source-mode Vitest config shares.
- Key abstractions: `vitestExecArgv` (`['--no-webstorage']` when the flag is negatable, so process-wide Web Storage does not shadow jsdom's); `standardDecoratorPlugin()` (a `pre` Vite plugin).
- Data flow: the plugin detects a decorator by a regex on the source, transpiles the file with `ts.transpileModule` (ES2024 / ESNext / ReactJSX) and rewrites the emitted `__esDecorate(` calls with a `/* v8 ignore next -- … */` comment.
- Non-obvious design decisions: the plugin exists because Vite's default parser does not understand standard TypeScript decorators; the v8 ignore comment is injected **programmatically** so the compiler-synthetic accessor lines do not break the 100% coverage gate.
- Edge cases / failure handling: the regex test short-circuits files with no decorator, so the transform is a no-op for the vast majority of sources.

### vitest.bench.config.ts
- One line: the CI performance gate — includes `benchmarks/**/*.bench.ts` and `*.bench.client.ts`, runs `fileParallelism: false` with `maxWorkers: 1` so "a measurement never shares the CPU with another benchmark", 600 s test timeout, and a `globalSetup` that clears recorded timings and renders `benchmarks/.dsh-build/report.html`.

### vitest.e2e.config.ts
- Purpose: the real-API end-to-end lane.
- Key abstractions: `e2eMaxWorkers` from `DSH_E2E_MAX_WORKERS` (default 4, must be a positive integer or the config throws); the include list (`packages/*/*/tests/**/*.e2e.ts`, `apps/cli/tests`, `apps/desktop/tests`).
- Data flow: a root `.env` is loaded with `process.loadEnvFile` (Node ≥ 21.7) inside a try/catch; suites self-skip without their provider credential.
- Non-obvious design decisions: `retry: 2` — "retries for transient flakes (the shared internal key hits concurrency quotas)"; `fileParallelism` is derived from the worker count so `DSH_E2E_MAX_WORKERS=1` restores full serial execution; the `*.expected.e2e.ts` files are excluded here and live in their own config.
- Edge cases / failure handling: no coverage — "the unit suites own the coverage gate".

### vitest.expected.config.ts
- One line: the owner-local *assembled expected-output* lane — includes `apps/cli/tests/**/*.expected.e2e.ts` only, 120 s timeout, `maxWorkers: min(5, availableParallelism())`.

### vitest.snapshot.config.ts
- Purpose: the snapshot corpus lane — replay recorded model responses through real subprocess paths and diff the assembled requests, protocol output and persisted logs.
- Key abstractions: `DSH_SNAPSHOT` (`record | refresh | replay`); `DSH_SNAPSHOT_MAX_CONCURRENCY` / `DSH_SNAPSHOT_MAX_WORKERS`; the include list (`scripts/session-snapshot-corpus.corpus.ts`, `snapshots/**/*.snapshot.ts`, and the assembled Web snapshots only when `DSH_EXAMPLE_MODE === 'lib'`).
- Data flow: in `record` mode only, the root `.env` is loaded — a non-ENOENT failure is rethrown rather than silently recording with the wrong environment; each scenario owns its own temp dir and fixture set.
- Non-obvious design decisions: replay runs the snapshot files **in parallel** with separate file-worker and in-file concurrency budgets, but record and refresh stay **serial** — "record spends real API quota per scenario, and refresh write-back harvests volatile values from fixtures already on disk, so concurrent writers would corrupt expected outputs"; the comment also notes that without a file-worker override, in-file concurrency 1 is fully serial.
- Edge cases / failure handling: `positiveIntFromEnv` throws on a non-positive or non-integer value rather than silently falling back.

### vitest.web-stress.config.ts
- One line: an opt-in browser performance lane for `apps/web/stress-tests/**/*.stress.ts` — 600 s timeouts, `fileParallelism: false`; no default Vitest config includes `*.stress.ts`.

### vitest.web.config.ts
- One line: the web browser lane — real host entry points, built-client interaction snapshots and replayed keyless e2e scenarios (`apps/web/tests/**/*.e2e.ts`, `*.snapshot.ts`, plus the inspector's `client-browser.e2e.ts`); 180 s timeout, `fileParallelism: false`.

### vitest.web.perf.config.ts
- One line: a manual high-cardinality diagnostics lane that spreads `vitest.web.config.ts` and adds `--expose-gc` to the worker argv for forced-GC memory baselines; includes `apps/web/tests/**/*.perf.ts` and `packages/client/ui-conversation/tests/**/*.perf.client.ts`.

### website/docs.ts
- Purpose: the **canonical publication manifest** for the documentation site — it maps each canonical Markdown source into matching route trees for both locales.
- Key abstractions: `DocsPage` (`locale`, `contentLocale`, `source`, `route`, `label`, `sidebar`, `section`, `order`, `outline`, `sourceAliases`); `DocsSidebar` (six collections); `mirroredPages` / `pairedPages`; `localeCollections`; `sections`; `sectionSpec`; `orderedPages`; `routeLink`; `landingLink`.
- Data flow: `pairedPages` derives the Chinese source by rewriting `foo.md` → `foo.zh.md` and produces **two** projections (`root` = Chinese, `en` = English) with cross-linked aliases; `orderedPages` sorts by the section's declared position then by `order`; `landingLink` derives a navigation target from the collection's first page rather than hard-coding a route.
- Non-obvious design decisions: when a translation is absent, **both routes project the available source** instead of copying Markdown — "Markdown stays in its owning repository tier"; the `editLink` pattern is derived from the page's `editSource` frontmatter, so the "edit this page" URL always points at the canonical source; the subsystem groups are `collapsed` because "together they outnumber the rest of the reference sidebar; expanded, they push every other group below the fold".
- Edge cases / failure handling: `sectionSpec` **throws** when a sidebar section has no declared placement — "Ranking by list membership alone would sort an undeclared group silently ahead of every declared one"; `landingLink` throws when a collection publishes no page.
- Surprising: the same collection ordering feeds both the navigation bar and the `llms.txt` index, so a new collection lands in both surfaces together.

### website/.vitepress/config.ts
- Purpose: the VitePress site configuration — sidebars, nav, locales, head injection, markdown rendering rules and the build/dev hooks.
- Key abstractions: `sidebar(locale, collection)`; `guideModules` (per-locale module labels and collections); `guideSidebar` / `moduleNav`; `watchCanonicalDocs`; `serveRawMarkdown`; `siteStyle` / `scrollbarScript`; `siteTitle(previewTag)`.
- Data flow: `projectDocs()` runs at import time to project the canonical sources into `.generated/`; `buildEnd` emits the raw-Markdown twins and `llms.txt`; a Vite plugin wires the watcher and the raw-Markdown middleware in dev; the markdown config escapes Vue interpolation in text and inline code, and caches rendered fences in production only.
- Non-obvious design decisions: the wordmark SVG is **inlined** so its `currentColor` fills follow the active theme ("An `<img>` would freeze the mark at the colors the file declares"); the sidebar scrollbar is styled to *hide* until the sidebar scrolls, with a `data-scrolling` attribute set by a capture-phase listener because scroll events do not bubble and Vue rewrites `class` wholesale; the standard `scrollbar-width` properties sit behind `@supports not selector(::-webkit-scrollbar)` because Chrome drops `::-webkit-scrollbar` once `scrollbar-width` is set to anything but `auto`.
- Edge cases / failure handling: the renderer rules for `text`, `code_inline` and `fence` are asserted to exist and throw otherwise; the fence cache is skipped for Mermaid tokens and for snippet (`src`) tokens, and is disabled outside production because "a dev renderer can survive many HMR updates".
- Surprising: the `editLink` pattern function throws if a projected page has no `editSource` frontmatter — a hard failure rather than a broken link.

### website/.vitepress/code-groups.ts
- Purpose: keep native VitePress code-group radio controls from interfering with each other.
- Key abstractions: `codeGroupFallbackHead(mpa)`; `isolateCodeGroupRadios(md)`.
- Data flow: `isolateCodeGroupRadios` wraps the `container_code-group_open` renderer and rewrites `<div class="tabs">` into `<form class="tabs" @submit.prevent>`; `codeGroupFallbackHead` emits an MPA-only stylesheet that shows every block and hides the controls.
- Non-obvious design decisions: **each tab strip gets its own `<form>`** so a search excerpt that copies the markup cannot clear the page's selected platform — the radio `name` is still shared but the *form* boundary is not; the rewrite asserts the expected markup is present and throws when VitePress changes it.
- Edge cases / failure handling: MPA output has no theme client handlers, so the fallback stylesheet exposes all command blocks and hides the tab strip; the `code-group.css` stylesheet separately forces every block visible inside the local search box.

### website/.vitepress/theme/index.ts
- One line: the theme entry — extends the default theme, lazily imports the mermaid/image/media viewers on mount, re-scans them on route/language/theme change, and renders the `PageMarkdownActions` component in the `doc-before` slot keyed by route + language + raw path.

### website/.vitepress/theme/media-viewer.ts
- Purpose: the shared full-screen modal, focus trap and pan/zoom controller used by both images and diagrams.
- Key abstractions: `MediaViewer` (owns **at most one** modal); `MediaContent`; `viewerButton(doc, label, icon)`; `labelButton(element, label)`.
- Data flow: `open()` builds a `<dialog>`, a viewport, a "paper" with an **open shadow root**, mounts Panzoom on the paper with `startScale`/`minScale` from a fit computation, wires zoom/fit/original/wheel/keyboard handlers, and installs a `ResizeObserver` that refits; `cleanup()` aborts the listeners, disconnects the observer, destroys Panzoom, closes and removes the dialog, restores `body.overflow` and returns focus to the trigger.
- Non-obvious design decisions: the shared content lives in a **shadow root** "so Mermaid copies cannot resolve their embedded styles and fragment IDs against the original diagram" — a clone of an SVG with `url(#arrow)` markers would otherwise point at the original page's defs; the Tab key is intercepted to cycle the controls in a fixed order because a native `<dialog>`'s focus behaviour is not enough; the arrow keys pan by `64 / scale` CSS pixels so the movement is constant on screen.
- Edge cases / failure handling: `cleanup()` is idempotent (`closed` flag) and is called from the close button, the `close` event, `cancel` (with `preventDefault`) **and** from the `catch` around `showModal()` — "including setup failure"; the previous body's `overflow` value is captured and restored.
- Surprising: the 100% "original size" control only exists for images (`content.originalSize`), and its label carries the current scale ("Original size (100%), currently 63%").

### website/.vitepress/theme/image-viewer.ts
- Purpose: enhance standalone, loaded content images with a fullscreen trigger — without moving or replacing the source images.
- Key abstractions: `ImageViewer`; `ImageEntry` (`container`, `button`, `events`, `source`).
- Data flow: a `MutationObserver` plus capture-phase `load`/`error` listeners on `#VPContent` drive a scan; each qualifying image gets a sibling button; clicking either opens the shared `MediaViewer` with a detached `<img>` clone at its intrinsic size.
- Non-obvious design decisions: the eligibility predicate is strict — the image must be **complete, loaded (naturalWidth/Height > 0), have non-empty alt text, occupy its own paragraph** (no text siblings, no sibling images), and must not be linked, inline, decorative (`role=presentation|none`), `aria-hidden`, inside a `.mermaid`, or marked `data-no-zoom`; the scan also **removes** an enhancement when the image's `src`/`srcset`/`currentSrc` changes, so a stale modal is closed rather than showing the wrong image.
- Edge cases / failure handling: every listener is registered through an `AbortController` so `dispose()` releases them; the language is re-read on every scan so a locale change relabels the button without remounting; the source image is never moved — the button is *appended* to the paragraph, and the original `<img>` keeps its place.
- Surprising: the "standalone paragraph" check allows only whitespace text nodes as siblings, which is what excludes an inline badge image from being zoomable.

### website/.vitepress/theme/mermaid-viewer.ts
- One line: 98 lines that add a fullscreen trigger to each rendered Mermaid SVG — it waits for an SVG with a usable `viewBox` (a diagram with zero dimensions is not enhanced), clones it into the shared viewer, and removes/re-adds the trigger when the container's SVG is replaced.

### website/.vitepress/theme/page-markdown-actions.ts
- Purpose: per-page "copy this page as Markdown for LLMs" / "view as Markdown" actions.
- Key abstractions: `PageMarkdownActions` (a Vue component); `CopyState` (`idle | copying | copied | requestFailed | clipboardFailed`); the localised message table; the SVG icon set.
- Data flow: `copy()` starts `fetch(path?dsh-raw=1)` **inside the click gesture**, passes the pending promise to `clipboard.write([new ClipboardItem({ 'text/plain': content })])`, and reports the outcome in a `role="status"` region; the response's content type is checked (`text/markdown` or `text/plain` only) before it is treated as Markdown.
- Non-obvious design decisions: the clipboard write is *initiated* during the user gesture (browsers require it) while the data resolves afterwards — the promise is handed to `ClipboardItem` rather than awaited first; the request is **aborted on unmount and on route/locale change**, so a late response cannot report success on a different page; the server-rendered output is a plain link to the raw Markdown (no button), so the feature works before hydration; the copy button is `aria-disabled` + `aria-busy` rather than `disabled`, so focus is not lost mid-copy.
- Edge cases / failure handling: a missing `ClipboardItem` or `navigator.clipboard.write` produces the "Could not copy. … choose View as Markdown to copy it manually." message instead of a failure; a network error, a 404, an HTML response and a body-read rejection all produce the "Could not load Markdown." message and allow a retry; a denied write that never consumes the data aborts the fetch.
- Surprising: the menu is a `role="menu"` with `role="menuitem"` children, but it is **not** a native `<menu>`; `onMousedown` calls `preventDefault()` on the items to keep focus, because "Safari can blur the focused menu item without focusing the pressed control".

### website/.vitepress/theme/css.d.ts
- One line: a 2-line ambient declaration — `declare module '*.css'` so the theme can `import './media-viewer.css'`.

### website/.vitepress/theme/code-group.css
- One line: 10 lines — a focus-visible ring on the code-group radio label, and a rule that forces every code-group block visible inside the local search box ("Search excerpts have no tab controls; every matching command stays visible").

### website/.vitepress/theme/media-viewer.css
- One line: 149 lines of styling for the shared viewer — the diagram container gets `position: relative` and 48 px of top padding when a trigger exists, the toolbar is a floating rounded pill with `font-variant-numeric: tabular-nums` on the scale label, and a 600 px breakpoint shrinks the viewport insets; the image trigger is absolutely positioned at the container's bottom-right.

### website/.vitepress/theme/page-markdown-actions.css
- One line: 144 lines styling the copy button / chevron split control (a 12 px radius with a shared middle corner), the dropdown menu (18 px radius, a 360 px max width clamped to the viewport), the status line, and the pre-hydration static link.

### website/build.ts
- Purpose: the production documentation build, with a project-owned output-preparation step.
- Key abstractions: `cleanDocSiteOutput(siteRoot, outDir)`; `docSiteBuildOptions(siteRoot, mpa)`; `parseMpa(args)`.
- Data flow: `onAfterConfigResolve` removes the resolved output directory *after* VitePress resolves the site configuration and *before* it writes files; the module self-executes only when `process.argv[1]` is this file.
- Non-obvious design decisions: the removal **refuses** an output whose lexical path or whose nearest existing parent escapes the real site root (`realpathSync` of the root and of the parent), and **unlinks a link-shaped output instead of traversing its target** — a symlinked `outDir` would otherwise make `rmSync(recursive)` delete whatever it points at.
- Edge cases / failure handling: `nearestExistingAncestor` walks up to the first existing directory (so a not-yet-created `outDir` still has a checkable parent) and throws when it reaches the filesystem root; `parseMpa` accepts no arguments or exactly `--mpa` and throws otherwise.
- Surprising: `escapesRoot` treats an `isAbsolute(relative(...))` result as an escape, which is the Windows case where two drives have no relative path.

### website/raw-markdown.ts
- One line: 52 lines of dev-server middleware that serve a route's raw Markdown (and `llms.txt`) while leaving Vite's own Markdown module imports alone — it inspects `sec-fetch-dest` so script/style/image requests always fall through to Vite, and an explicit `?dsh-raw=1` fetch of an unpublished route returns 404.

### website/AGENTS.md
- One line: 23 lines stating that `website/` owns only VitePress configuration, presentation assets and the publication manifest, that the projector writes disposable Markdown to the ignored `website/.generated/`, and that a gate rejects additional non-ignored Markdown under `website/`.

### website/package.json
- One line: a private, non-published `@deepseek-ai/website` package — `dev`/`build`/`preview` scripts over VitePress, with `tsx build.ts` as the build (so the project-owned output preparation runs) and pinned dev dependency versions.

### website/public/favicon.svg
- One line: a 3-line, 50×50 SVG logo (a single long `path`) — the site favicon, referenced from the VitePress head with the site's `base` prefix.

### website/public/wordmark.svg
- One line: a 19-line, 143×23 SVG wordmark whose paths all use `fill="currentColor"` — the reason the config inlines it rather than linking it as an image; the logo mark itself is clipped by a `clipPath` named `dsh-wordmark-clip`.

### website/tests/code-groups.spec.ts
- Purpose: prove that a search excerpt cannot clear the page's selected code-group radio.
- Key abstractions: a Markdown source with a two-platform `::: code-group`; `createMarkdownRenderer` from VitePress with the `isolateCodeGroupRadios` config; JSDOM.
- Data flow: the page radios and the excerpt are rendered from the same HTML, so they share the generated radio `name`; the test checks the page selection, then that the excerpt radio has the same `name` but a **different `form`**.
- Non-obvious design decisions: the test asserts on the *form* boundary (`expect(pageRadios[0].form).not.toBe(excerptRadio.form)`) rather than on a CSS class — the invariant that matters is structural; the second test reads VitePress's own `vp-code-group.css` out of `node_modules` and measures `getComputedStyle` before and after injecting the MPA fallback head.
- Edge cases / failure handling: the DOM is closed in a `finally` block; `codeGroupFallbackHead(false)` is asserted to be empty so the MPA styles never leak into the normal build.

### website/tests/image-viewer.spec.ts
- Purpose: the image viewer's contract — loading, accessible controls, and ownership of the shared viewer.
- Key abstractions: a mocked `@panzoom/panzoom`; a `controller(scale)` fake; `imageState(image, complete)` (stubs `complete`, `naturalWidth`, `naturalHeight`, `currentSrc`); a `dialogMethods` map that saves and restores the real `HTMLDialogElement.showModal`/`close` descriptors.
- Data flow: `beforeEach` installs a fake `showModal` that focuses the `[autofocus]` element; each test renders a `<p><img></p>` into `#VPContent`, installs the viewer, and drives it through clicks.
- Non-obvious design decisions: the "leaves linked, decorative, inline, grouped and failed images unchanged" test asserts `root.innerHTML` is **byte-identical** after installation — the enhancement must not restructure the document; the file-snapshot assertion writes the trigger, the dialog and the shadow-root clone to `./expected/image-viewer.<locale>.html`.
- Edge cases / failure handling: the tests cover the load-failure path, a `src`/`srcset` change while the modal is open, a `currentSrc` change after the `srcset` mutation (the modal must stay open until the new source is really current), and release on `refresh`/`dispose`/`remove`/`error` — with the assertion that a zoom button of the *closed* modal no longer does anything.

### website/tests/mermaid-viewer.spec.ts
- Purpose: the Mermaid viewer's ownership and interaction contract.
- Key abstractions: a mocked Panzoom; a `viewBox` getter spy that parses the attribute; a `ResizeObserver` stub that captures the refit callback.
- Data flow: each test renders a `.mermaid` container with an inline SVG, installs the viewer and opens the dialog.
- Non-obvious design decisions: the test asserts that the clone in the shadow root still references `url(#arrow)` while the document contains exactly **one** `#diagram` — proving the shadow root isolates fragment IDs; the fit-scale is recomputed on resize (`0.2` → `0.15` when the viewport narrows), and the `panzoomchange` event drives the scale label.
- Edge cases / failure handling: a zero-height `viewBox` is not enhanced; a replaced diagram closes the open view; a disposed viewer stops enhancing new content; the `cancel` event is treated as a close.

### website/tests/page-markdown-actions.spec.ts
- Purpose: the copy/view actions' feedback and the route-ownership of asynchronous clipboard work.
- Key abstractions: a `deferred<T>()` helper that records pending work so `afterEach` can reject it; a `TestClipboardItem`; mocked `vitepress` `useData`/`useRoute`; a fake `DefaultTheme.Layout` that renders only the `doc-before` slot.
- Data flow: `mount()` creates a Vue app on a host div; the tests then drive the copy button and the menu.
- Non-obvious design decisions: the "starts clipboard.write during the click" test asserts `write` was called **before** the response resolves, and that the second click does not start a second fetch — the pending state is `aria-disabled`/`aria-busy`, not `disabled`; the "cancels old data" test asserts the old `AbortSignal` is aborted and that the old write rejects, so a late completion cannot report success on the new page.
- Edge cases / failure handling: the pre-hydration path is tested with `renderToString` and asserts a working `href`/`target`/`aria-label` and **no** fetch; content types `application/javascript`, `application/octet-stream` and a missing content type are all rejected; a static host serving `text/plain` is accepted.

### website/tests/raw-markdown.spec.ts
- Purpose: prove the dev middleware never replaces Vite's page-module responses.
- Key abstractions: a mocked `rawMarkdownRoute`; a `request(url, destination, method, base)` helper building a fake `IncomingMessage`/`ServerResponse`.
- Data flow: the middleware is invoked directly with the fake request and the assertions read `res.setHeader`/`res.end`/`next`.
- Non-obvious design decisions: the `sec-fetch-dest` table is the whole policy — `script`, `style` and `image` destinations always delegate, and only `document`/`empty` (with `?dsh-raw=1`) may be served raw; a malformed request target (`http://[`) is delegated rather than turned into an error.
- Edge cases / failure handling: an unpublished route returns 404 **only** for an explicit raw fetch; `HEAD` sets the headers and ends with `undefined`; a projection error propagates rather than becoming a "successful" empty response.

### website/tests/expected/page-markdown-actions.en-US.html
- One line: a one-line file-snapshot of the mounted English copy control — the `Copy page` button with `aria-disabled="false" aria-busy="false"`, the `More page actions` toggle bound to `aria-controls="page-markdown-v-0"`, and an empty `role="status"` region.

### website/tests/expected/page-markdown-actions.zh-CN.html
- One line: the Chinese counterpart of that snapshot — identical structure, `复制页面` / `更多页面操作` labels.

### website/tests/expected/page-markdown-menu.en-US.html
- One line: a one-line file-snapshot of the English dropdown in its open state — `aria-expanded="true"`, the `role="menu"` container labelled "Page actions", and the two `role="menuitem"` entries (Copy page with a description, View as Markdown as a link to `/en/guide/quickstart.md`).

### website/tests/expected/page-markdown-menu.zh-CN.html
- One line: the Chinese counterpart of the open-menu snapshot (页面操作; `/guide/quickstart.md`).

### website/tests/expected/page-markdown-static.en-US.html
- One line: a one-line file-snapshot of the **pre-hydration** English output — a single `<a class="page-markdown-static" href="/deepseek-harness/en/guide/quickstart.md" target="_blank" rel="noopener">` with an external-link icon and no buttons at all.

### website/tests/expected/page-markdown-static.zh-CN.html
- One line: the Chinese counterpart of the pre-hydration snapshot, linking `/deepseek-harness/guide/quickstart.md`.

### website/tests/expected/image-viewer.en-US.html
- One line: a three-line file-snapshot of the English image viewer — the trigger button, the full `<dialog class="dsh-media-viewer">` markup (toolbar, scale label "63%", help toggle), and the cloned `<img>` with its absolute centring style.

### website/tests/expected/image-viewer.zh-CN.html
- One line: the Chinese counterpart of the image-viewer snapshot (全屏查看图片 / 缩小 / 放大 / 适应窗口 / 查看器帮助 / 关闭).

## Ideas worth stealing

- **A config change that only touches volatile fields is applied to the RUNNING fiber instead of remounting it** — `vendor/loader/src/config/entry.ts:146`. The decision is made by a pure comparison (`equalExceptVolatile`) plus three guards (the only changed key is `config`, the fiber is `ACTIVE`, the context prototype is unchanged); if it is volatile-only, `_commitVolatile` re-parses the candidate through the fiber's own `internal/config` hook, verifies the *ordinary* effective values are unchanged, commits the new values into the live references and emits `loader/volatile-update` with the changed paths. August's equivalent problem — a settings change that must reach a live agent without destroying its conversation, its tool handles or its provider prefix — has the same shape: decide "is this a value change or a reference change?" *before* tearing anything down, and make the reference update a single auditable commit.

- **Compare two configurations using the schema's metadata, without executing anything** — `vendor/loader/src/config/diff.ts:17`. `equalExceptVolatile` walks the schema's `dict`, treats a `meta.volatile` node as equal, uses a node's **declared default** for a missing/null value, and falls back to strict raw equality for unknown fields, `!!js` expression nodes, opaque values and schema back-edges. The important part is the negative space: no validator, no transform, no `internal/config` waterfall and no expression evaluation runs during a change decision. A change-detection pass that can fire side effects is a change-detection pass that can hang.

- **Register an effect's owner-list wrapper BEFORE running its setup body** — `vendor/cordis/src/fiber.ts:520`. The comment spells out the reason: "Make the effect visible to a reentrant owner unload before execute() runs any plugin code." An unload begun from inside the setup then awaits the setup and every collected cleanup; a synchronous setup failure removes the wrapper and rolls back the collected cleanup; async teardown stays owner-visible until it settles. This is the pattern August needs wherever a disposer can be re-entered (a tool call that disposes the session that owns it).

- **Let a structural owner JOIN a cleanup another caller already started, while the public disposer stays single-shot** — `vendor/cordis/src/fiber.ts:112`. A module-level `WeakMap<Disposable, () => void | Promise<void>>` (`effectInertia`) lets `runDisposable` return the in-flight task instead of starting a second teardown. Public API stays "call the disposer twice and the second call is a no-op"; internal owners can still wait for a teardown they did not start.

- **Contain a teardown-notification failure per observer** — `vendor/cordis/src/fiber.ts:120`. `emitPluginDisposed` dispatches the event, then invokes each callback inside its own try/catch and attaches a `.catch` to any returned promise, logging failures through the logger. The stated reason: "one callback cannot starve peers or interrupt ownership cleanup." In an agent harness, one misbehaving hook must not be able to abort the shutdown of everything else.

- **Detect a runtime's capabilities, never its version** — `vendor/loader/src/internal.ts:138`. `ModuleLoader.fromInternal()` classifies Node's internal loader by *which module-job API it owns* (`getOrCreateModuleJob` → v2, `getModuleJobForImport` → v1), because v2 landed in 24.12.0 and a major-version test mistags every 24.0–24.11.1 loader; arity cannot discriminate the two shapes, and a loader owning neither API is left **unclassified** rather than guessed. The recorded symptom of that bug was a Web UI that served an empty client graph behind a warn-level log. August's per-model `apiFormat` and its provider-family detection should use the same rule: branch on the API you actually observed, and when you cannot tell, take the documented fallback instead of guessing.

- **A bounded, serialized write queue with a retry ladder for transient OS failures** — `vendor/include/src/index.ts:299` and `vendor/include/src/index.ts:318`. Writes go to `<file>.tmp` and are then renamed; a rename that fails with `EACCES`/`EBUSY`/`EPERM` is retried up to 10 times with a linear backoff (Windows can briefly retain the destination handle after a child disposes); a terminal failure stays on the queue so `Include.stop()` rethrows it rather than silently declaring persistence complete. This is the shape August's "write a fact, write a skill, write a session file" paths want: never lose a write to a transient Windows error, and never report success you did not have.

- **Reject a configuration file that is not a top-level list, and commit content only on success** — `vendor/include/src/index.ts:230`. An empty or truncated file (editors and `sed -i` write through temp states) parses to `undefined` rather than raising, so the shape is validated explicitly and one "invalid file" signal is emitted. Because `content` and `data` commit only on success, an edit that is later reverted to the exact last good content correctly reads as "unchanged" — no spurious restart, no spurious rewrite.

- **A hot reload must never take the process down** — `vendor/include/src/index.ts:279`. `refresh()` catches every error, logs "config reload at %C failed; keeping the running tree", and leaves the last good tree in place. The sibling statement in the vendor log is the sharper half: "an existing-but-invalid file must fail loud with its real parse error, never be mislabelled as absent or silently overwritten" — i.e. the *startup* path fails loud, the *reload* path fails soft, and only a missing file (`ENOENT`) may fall back to `initial`.

- **Make the patch algorithm a pure exported function so an offline tool cannot drift from the runtime** — `vendor/include/src/index.ts:57`. `applyEntryPatches(data, patches, warn)` is exported and the class method delegates to it, precisely so `dsh --dump-config` composes and prints exactly what the include would mount: "config tooling must never reimplement (and drift from) the patch algorithm." It also `structuredClone`s its input, because patching shared entry objects would bake earlier patch values into the cached parse and a repeated application could never revert a removed patch. And it indexes each **inserted** entry as it is added, so a later patch in the same list can configure or disable a row an earlier patch inserted.

- **Enforce a *placement* rule for mutable config at validation time** — `vendor/schemastery/src/index.ts:493`. `validateVolatileSchema` throws "volatile fields require a fixed object path without an enclosing volatile field" — a volatile field may not sit inside another volatile field, nor inside an array, dict or tuple, because the runtime commits by *path* and a path is only stable in a fixed object shape. August's brain-config keys have exactly this hazard (a nested "0 = off" key inheriting the wrong range), and the fix is the same shape: validate the placement, not just the type.

- **Strip defaults when persisting, and let the schema be the UI contract** — `vendor/schemastery/src/index.ts:422`. `simplify(value)` walks the schema backwards and removes every value equal to its declared default, so the saved config stays minimal; it unwraps a volatile reference first so a reference is stored as plain data. The same schema object carries `meta.role`, `meta.description`, `meta.min/max/step`, `meta.badges` and `meta.default`, which is why a settings panel can be **generated** from a plugin's `Config` rather than hand-written (see `vendor/hmr/src/index.ts:413` for `z.array(String).role('table')` and `z.natural().role('ms')`).

- **Interpolate configuration in the scope that owns it** — `vendor/loader/src/index.ts:111`. The `internal/config` waterfall evaluates `!!js` expressions against the *entry's* context, and returns the config **literal** for tree carriers (Group, Include) — "their entry and patch lists hold other rows' configs, whose `!!js` expressions belong to those rows' own fibers." Resolution also happens only after the declared injections are active, so a config expression can read a service. The general rule: an expression is evaluated by the component whose data it is, never by the component that happens to hold it.

- **One "is the system settled?" query over the whole configuration tree** — `vendor/loader/src/config/tree.ts:36`. `getTasks()` collects every pending import and every fiber's in-flight `inertia` promise across the tree and its subtrees; `await()` loops until the set is empty. A harness that wants "wait until the world has stopped moving" (a boot gate, a shutdown gate, a test assertion) needs exactly this shape rather than a hand-kept counter.

- **Back up BOTH module caches before invalidating, and roll back on failure** — `vendor/hmr/src/index.ts:317`. HMR copies the ESM `loadCache` entries and the CJS `require.cache` entries into backup maps, then clears them using `Map.prototype.get/delete/set` **called directly** on the loadCache — because in Node 24 `LoadCache.delete()` only sets the type slot to `undefined` instead of removing the entry. If the re-import or the plugin swap throws, `rollback()` restores both caches and re-registers the old plugins. A hot-reload path that mutates global caches must be transactional.

- **An undeclared thing must fail loudly, not sort silently** — `website/docs.ts:535`. `sectionSpec` throws `Sidebar section "X" has no placement in the root locale` instead of ranking the section by list membership, because "Ranking by list membership alone would sort an undeclared group silently ahead of every declared one." The same shape appears in `website/.vitepress/code-groups.ts:29` (the code-group markup must contain the expected tab strip, or the render throws) and in `website/.vitepress/config.ts:360` (the three markdown renderer rules must exist, or the build throws). August's gates are the same idea: a missing hook must be an error, not a no-op.

- **Route-owned asynchronous work, with the request aborted on unmount** — `website/.vitepress/theme/page-markdown-actions.ts:106`. Every fetch is created with an `AbortController` stored on the component, aborted in `onBeforeUnmount`; a route or locale change aborts the old request, so a late response cannot report "Markdown copied." on a page the user has already left. The clipboard write is *started* inside the click gesture (with the pending promise handed to `ClipboardItem`) so the browser's gesture requirement is met while the data resolves afterwards. The status vocabulary distinguishes a **request** failure from a **clipboard** failure, and both point at a manual fallback.

- **Give each UI group its own DOM ownership boundary** — `website/.vitepress/code-groups.ts:25`. The native code-group tab strip is rewritten from `<div class="tabs">` into `<form class="tabs" @submit.prevent>`, so a search excerpt that copies the markup shares the radio `name` but not the `form` — and therefore cannot clear the page's selection. The invariant is asserted structurally (`pageRadios[0].form !== excerptRadio.form`), not by a class-name convention.

- **An observable event bus plus a bounded in-memory transcript** — `vendor/cordis/src/events.ts:165` and `vendor/cordis/src/logger.ts:195`. Every non-internal dispatch emits `internal/dispatch` with the mode, name, args and `thisArg`, so a tool-call log can be assembled without instrumenting every call site; the logger keeps the last 1000 structured messages (each with a monotonic `sn`, a timestamp, the logger name, the level, the args and a **weak** reference to the owning fiber) in a ring buffer. A weak reference means a log record can never keep a plugin alive.

- **A per-file coverage threshold, so a big file cannot subsidise a bare one** — `vitest.config.ts:393`. `thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 }`, with the comment "100% or it doesn't merge" and "Every v8 ignore comment must carry a reason." The exclusion list is ~120 entries and each carries its reason in prose (a browser-grade harness, a generated bundle that only exists in `lib`, a native-only path). A coverage gate that is a negotiation with reality, written down in place, is far more useful than a percentage.

- **An exclusion decided by the suite's own probe** — `vitest.config.ts:121`. The pwsh coverage exemption is enabled only when `spawnSync(resolvePwshPath(), …)` fails, "so the exemption is active exactly when the suites skip — a mismatched narrower probe could exempt the file on hosts whose suites actually run." A waiver that is itself measured is a waiver that cannot quietly widen.

- **A keyless replay lane that never loads credentials** — `vitest.snapshot.config.ts:33`. The `.env` file is loaded **only** in `record` mode, and a non-`ENOENT` load failure is rethrown rather than swallowed ("Surface any other failure rather than silently recording with wrong env"). Replay runs the snapshot files in parallel; record and refresh stay serial because "refresh write-back harvests volatile values from fixtures already on disk, so concurrent writers would corrupt expected outputs." A golden-file suite that can be replayed without an API key is the cheapest possible regression signal for a model-facing harness.

- **A config file's shape is part of its contract, and the parser is exported for reuse** — `vendor/include/src/index.ts:23`. `entryListSchema` is a `js-yaml` `JSON_SCHEMA` extended with a `!!js` scalar type, exported so config tooling parses and prints exactly the dialect the include mounts; the `JsExpr` type carries `predicate`/`represent` so a `!!js` node round-trips through a write.

## Files skipped (with reasons)

- **None.** Every one of the 120 files in this shard was opened and read. Three files are single-line fixtures whose full content is one very long line and which the reader truncated at 2 000 characters per line: `vendor/README.md` (line 59, the 2 521-character modification-22 entry — the tail was retrieved separately and is reflected in the notes above), `website/public/favicon.svg` and `website/public/wordmark.svg` (single `path` attributes). The remainder of each of those files was read in full.
- No file in this shard was generated, vendored-from-a-tarball, binary or large-data enough to justify a skip: the largest file is `vendor/schemastery/src/index.ts` at 962 lines / 36 KB, and it was read end to end.

## Uncertainties

- **`vendor/README.md` modification entry 22** (the volatile-config subsystem) is 2 521 characters on one line; I read the first ~2 000 characters through the file reader and the remaining ~600 characters through a second, character-offset read of the same line. I did not re-read the whole line as one unit, so I have not verified that no character was dropped between the two reads. Every *other* modification entry was read in full.
- **The shard contains no harness agent loop, no LLM adapter, no tool implementation, no session/persistence code, no prompt construction, no context compaction, no reasoning/thinking handling, and no subagent machinery.** I checked the manifest for my shard and read every file it lists; none of those subsystems appear. The lenses "agent loop and tool-calling flow", "reasoning/thinking content", "prompt construction and caching", "context-window management and compaction", "model-specific adaptations and fallbacks", "memory/learning" and "subagent/parallel execution" therefore have **no first-party subject in this shard**. What I report for them are the nearest structural analogues in the Cordis layer (the `Fiber` lifecycle as a start/stop-with-dependencies mechanism, the `Entry` tree as a registry with declarative injections, the volatile config reference as a prefix-stable mutable value, `getTasks()`/`await()` as a settle query, and `ReflectService.notify` as dependency wake-up). I did not inspect the sibling shards to check whether those subsystems live there; the manifest's owner-shard column suggests they do, but I did not verify it.
- **`website/docs.ts` and `website/.vitepress/config.ts` reference `scripts/project-doc-site.ts`**, which is not in this shard (it belongs to a `scripts/*` shard). I could therefore read the *consumers* of the projector (`projectDocs`, `docsSourceFiles`, `emitRawMarkdownPages`, `llmsTxt`, `rawMarkdownRoute`, `rawMarkdownPath`) but not the projector itself; my statements about what the projector does are drawn from the call sites and the two AGENTS.md files, not from its source.
- **`website/tests/expected/*.html`** are file-snapshot fixtures. Two of the eight (`page-markdown-menu.en-US.html`, `page-markdown-menu.zh-CN.html`) are single-line files whose tail was truncated at 2 000 characters by the reader; I read the head of each (the full control bar and the first menu item) and the tests that consume them, so I know their structure and their purpose, but I did not read the final ~1 000 characters of either.
- **`vendor/timer/src/index.ts` uses `Promise.withResolvers`**, which requires Node ≥ 22. I did not check the repo's declared Node engine range to confirm this is intentional for the supported floor; the vendored README mentions the scaffolder requires Node 22+.
- **The `vendor/cordis-rc11-upgrade-plan.md` is a proposal, not an implementation.** I have described it as a plan throughout; I did not verify which of its PRs have actually landed, and the vendored source in this shard is the rc.7/rc.5 baseline it describes.
- **`vendor/loader/src/config/isolate.ts:31-37`** — `Realm.access(key, create)` has two identical branches (`create` true and false both return `this.store[key] ?? Symbol(...)`). I read it as intentional (a read of an unknown key yields a fresh symbol rather than `undefined`) but I could not find a comment confirming that, so I flagged it as "surprising" rather than as a mechanism.
