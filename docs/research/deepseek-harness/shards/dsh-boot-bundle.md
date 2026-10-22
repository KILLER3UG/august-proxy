# deepseek-harness / dsh-boot-bundle

## Shard shape

This shard is the **boot and composition layer** of the DeepSeek Harness — everything between "a user types a command" and "the agent loop is running with a settled tool roster". It holds seven packages under `packages/boot/` (`app-boot`, `cmdline`, `config-editor`, `hmr`, `plugin-manager`, `plugin-market`) plus the six profile **bundles** under `packages/bundle/` (`base`, `web-app`, `headless`, `acp-app`, `sdk-app`, `sdk-minimal`).

The shape is: **a profile is a directory; a bundle is a YAML patch layer; the composition is the ordered stack of those layers over an empty root.** `app-boot` owns the machinery (profile discovery, patch composition, module resolution interception, boot sequence, startup audit, config-schema generation). `cmdline` gives the app its own flags. `hmr` serializes every reload — module replacement, Include refresh, profile recomposition — through one queue. `plugin-manager` and `plugin-market` make the plugin set manageable from the Web UI and from an agent tool. The bundles are the shipped compositions: `base` is the shared core (~100 rows), `web-app`/`headless`/`acp-app`/`sdk-app` layer a surface over it, and `sdk-minimal` is a complete standalone tree with no base at all.

The vocabulary that recurs everywhere and matters most for August: **rows** (plugin entries with an `id`, a module `name`, a `config`, and an `inject` list), **layers** (ordered patch lists), **the composition** (the flattened row list), **the surface** (one of web/headless/acp/sdk), and **the profile** (one directory holding a `package.json` + `cordis.patch.yml`). A patch replaces a row's whole `config` rather than merging, and row order carries no load semantics — activation is service-availability driven.

The interesting content is not the agent loop itself (that lives in `packages/core/*`, outside this shard) but the **safety and reliability scaffolding around it**: what happens when a plugin fails to activate, when a plugin's declared requirements the running runtime does not meet, when a config file changes on disk mid-turn, when a package install half-fails, when a regex cannot be faithfully expressed in JSON Schema, and when a user tries to point the installer at a relative path.

## Per-file notes

### packages/boot/app-boot/package.json
- Purpose: manifest for the shared boot glue.
- Key abstractions: exports `.` plus a separate `./worker/profile-resolution-bootstrap` entry so a Worker can install the inherited runtime resolution without pulling the whole library in.
- Data flow: none (metadata).
- Non-obvious design decisions: `ajv`, `@eslint-community/regexpp`, `semver` and `js-yaml` are runtime deps because the config-schema generator and the compatibility checker need them; the cordis plugins are peers, not deps, so the app host binds one Loader.
- Edge cases / failure handling: n/a.
- Surprising: the worker bootstrap is published as its own export path rather than being re-exported.

### packages/boot/app-boot/README.i18n.yaml
- Per-heading en/zh content hashes for the bilingual-pairing check on `README.md`; 22 heading sections. Re-recorded with `pnpm run verify-translation-pairing --write packages/boot/app-boot/README.md`.

### packages/boot/app-boot/README.md
- Purpose: the package contract.
- Key abstractions: the two-call entry point (`installFailLoud('dsh')` then `boot('dsh', resolveConfigPath(argv[2], process.env.DSH_SNAPSHOT))`); the global required-plugin list (`agent-loop`, `webserver`, `web-runtime`, `modules`, `connection`, `headless-runner`, `acp`, `sdk-jsonrpc-server`).
- Data flow: config path → env layers → profile layers → patch composition → Loader boot → required/optional audit.
- Non-obvious design decisions: a failed **required** entry disposes the whole app and exits nonzero; a failed optional entry produces exactly one labelled warning and leaves successful siblings running. Required ids *absent* from the tree and *disabled* required entries are ignored. A **throwing `disabled` expression is an entry failure, not a disabled entry**.
- Edge cases / failure handling: `installFailLoud` writes one labelled `util.inspect` diagnostic, awaits the surface's release hook under a fixed timeout, exits 1 — "control never returns to the failed operation, because only the throw site knows which state is intact".
- Surprising: replay mode (`DSH_SNAPSHOT`) boots the sibling `cordis.snapshot.yml` instead of `cordis.yml`, so a recorded session reproduces identically.

### packages/boot/app-boot/README.zh.md
- Chinese mirror of `README.md`. I read the English in full and this file's first 60 lines; the boot sequence, the required-plugin list and the exemption rules are the same content in Chinese.

### packages/boot/app-boot/src/compatibility-preflight.ts
- Purpose: refuse to import a plugin whose declared dsh requirements the running runtime does not satisfy.
- Key abstractions: `prepareProfileEntries` (row list) and `prepareProfilePatches` (patch list); both act only when `ctx.get('profileContext')` exists.
- Data flow: manifest → `evaluatePluginCompatibility` → denied rows are rewritten in the launcher's own copy of the composition.
- Non-obvious design decisions: **only a compatibility conflict denies a row**; a row whose manifest cannot be resolved keeps the Loader's own import failure ("A row this profile cannot resolve is the Loader's import failure to report, not a compatibility decision"). A denied ordinary row gains `disabled: true`; a **native `Include` that reaches a denied plugin is denied as a whole, because its file is never rewritten**. The user's profile patch, dependency manifest and bundle list are never modified.
- Edge cases / failure handling: `manifestOf` falls back to Node's own `require.resolve.paths` when the package service is absent, and swallows `ENOENT`/`ENOTDIR`/`EISDIR` as "unresolvable".
- Surprising: the check runs at *composition* time so a denied plugin's module is never imported at all — not merely disabled after import.

### packages/boot/app-boot/src/config-schema/collect.ts
- Purpose: discover declared plugin `Config` schemas without mounting plugins.
- Key abstractions: `collectConfigSchemas(profile, entries, resolution, diagnostics)`; walks the entry list *and* Include descendants.
- Data flow: parsed entry rows → `ModuleLoader` import (trusted plugin code runs) → native schema graph → collected entries.
- Non-obvious design decisions: imports, `Config` getters and lazy schema builders **do** execute trusted plugin code; native validators and transform callbacks do not. Calls must not overlap another profile-resolution interception; collection releases its interception on success *or* rejection, while Node retains imported modules.
- Edge cases / failure handling: a malformed row becomes a *positioned* diagnostic without losing its siblings; `entryList` rejects a non-array ("config expressions are not evaluated").
- Surprising: `isJsExpr` is used to refuse an `!!js` include patch rather than evaluating it.

### packages/boot/app-boot/src/config-schema/document.ts
- Purpose: compose the final JSON Schema document.
- Key abstractions: `$defs` for `loaderExpression`, `entryMetadata`, `entryList`, `patchList`, `unknownConfig`, `includeConfig`; `x-cordis` carries `profile`, `complete`, `entries`, `diagnostics`, `patchSchema`.
- Data flow: collected entries + patch targets → one 2020-12 document.
- Non-obvious design decisions: `complete` is false for any error diagnostic, any `partial`/`unsupported`/`error` entry, or an ambiguous plugin name — but **includes disabled declarations**. Unknown plugin names stay open (`unknownConfig` is a `$comment`, not a prohibition).
- Edge cases / failure handling: a malformed row with no literal plugin name omits `name` rather than inventing one.
- Surprising: `patchSchema` points at `#/$defs/patchList`, and patch ids describe the *current* index, not ids introduced by earlier patches.

### packages/boot/app-boot/src/config-schema/index.ts
- Purpose: public `generateConfigSchema(profile, layers, installAnchor)`.
- Key abstractions: skipped bundles become `error` diagnostics; `composeEntries` supplies composition warnings.
- Data flow: profile + layers + install anchor → diagnostics + composed entries + runtime resolution → collected schema.
- Non-obvious design decisions: the function never mounts plugins and never evaluates config expressions — "Imports, Config getters, and lazy builders execute trusted code. Native validators and transform callbacks are not executed."
- Edge cases / failure handling: throws when composition or runtime resolution cannot be prepared.

### packages/boot/app-boot/src/config-schema/native.ts
- Purpose: recognize the native Schemastery graph without invoking a validator.
- Key abstractions: `isNativeConfigSchema` requires `Symbol.for('schemastery') === true`, a string `type`, and an object `meta`.
- Non-obvious design decisions: functions are accepted as well as objects, because a Schema export may be a callable wrapper.
- Edge cases / failure handling: null and primitives are rejected.

### packages/boot/app-boot/src/config-schema/pattern.ts
- Purpose: decide whether a native RegExp can be emitted as a JSON Schema `pattern` without changing what it accepts.
- Key abstractions: `createPatternCheck()` returns `(source, flags) => boolean`; `bmpOnly` / `broadSet` / `portableAlternative` walk the regexpp AST.
- Data flow: pattern source → parse with `{unicode: true}` and `{unicode: false}` → compare the two AST signatures → accept only if identical and every alternative is portable.
- Non-obvious design decisions: a flagless pattern is only portable when it is **BMP-only** and never lets a broad set observe a surrogate pair's midpoint; a lone unanchored broad set (`\S`) is allowed because it only asks whether *a* matching character exists; a negated broad set (`[^x]`) is **not**. The `u` flag is accepted outright. Any flag other than `''` or `'u'` is refused.
- Edge cases / failure handling: a `SyntaxError` from the parser means "cannot be emitted as a standard pattern constraint" (false); any *other* parser failure is rethrown rather than swallowed.
- Surprising: `signature()` strips incidental AST fields so the two parses are compared structurally, not textually.

### packages/boot/app-boot/src/config-schema/projector.ts
- Purpose: project native Config input constraints into JSON Schema without executing validators or transform callbacks.
- Key abstractions: `ConfigProjection { schema, definitions, acceptsMissing: boolean | 'unknown', limitations: string[] }`; per-node `NodeProjection` carrying `exact`, `recursive`, `effectful`, `mutating`.
- Data flow: native schema graph → visited/defined maps → JSON Schema with `$defs` and `$ref` for recursive nodes.
- Non-obvious design decisions: `acceptsMissing` is a **three-state** value (`true`/`false`/`'unknown'`) — "unknown omission behavior is explicit rather than an invented default"; a node with metadata effects (transform, loose, effectful children) becomes `anyOf: [schema, {}]` and `acceptsMissing: 'unknown'`. Unions are projected as **`anyOf`, never `oneOf`**, to preserve overlapping acceptance. `mutating` marks a node whose native resolution may write adapted values into the input before a later union branch reads it.
- Edge cases / failure handling: non-JSON defaults and non-plain objects are refused rather than silently converted; cyclic annotations throw; a `description` that is not a string is dropped with an explicit "annotation omitted" limitation.
- Surprising: `jsonValue` treats "omitted" and "null" alike for native constant equality ("Native constant equality treats omitted and null-valued object members alike").

### packages/boot/app-boot/src/config-schema/types.ts
- Purpose: the JSON Schema output and native-graph input types.
- Key abstractions: `ConfigJsonSchema`, `ConfigSchemaDiagnostic { level, path?, message }`, `ConfigSchemaEntry { path, id?, name?, status, configRef?, tree? }`, `ConfigSchemaDump`, `NativeConfigSchema`, `CollectedConfigEntry`.
- Non-obvious design decisions: entry `status` is a closed set — `schema | partial | absent | unsupported | error` — so "we could not read this schema" is a first-class answer rather than an empty schema. `tree` marks the native Loader carrier (`group`/`include`), whose config is not interpolated as an ordinary plugin config.

### packages/boot/app-boot/src/index.ts
- Purpose: the boot library core — env layering, fail-loud guards, snapshot-aware config path resolution, patch composition, Loader boot sequence, startup audit.
- Key abstractions: `boot`, `auditStartupEntries`, `installFailLoud`, `loadEnv`/`loadLayeredEnv`, `loadOptionalPatches`/`loadOverlayPatches`, `resolveConfigPath`, `renderConfigDump`, `reconcileProfilePatches`; the `app-boot/config-reload` event.
- Data flow: `.env` → profile layers → patch composition → `Include` mount → Loader settle → startup audit → running context.
- Non-obvious design decisions: **the global required list is a fixed id set** shared by every app bin; inactive required entries reject startup, everything else warns once. `failureDetail` walks nested `cause` chains (with a `seen` set, so a circular cause cannot hang) and an `AggregateError`'s members, because "a wrapper can carry an activation error whose original stack names the failed plugin". Startup diagnostics print stack frames; **reload diagnostics do not** ("people read through the Web UI and agents, so it carries error messages without stack frames").
- Edge cases / failure handling: a `disabled` expression that throws is an entry failure, not a disabled entry; pending entries report the *missing services* by name; the bootstrap `Include` must activate so unreadable root config is fatal.
- Surprising: `resolveConfigPath` swaps only a `cordis.yml`/`cordis.yaml` basename for `cordis.snapshot.yml` in replay mode and leaves any other name alone.

### packages/boot/app-boot/src/official-bundle-packages.ts
- Purpose: the two on-demand installable bundles, as one shared constant.
- Key abstractions: `ON_DEMAND_BUNDLES: readonly string[]`.
- Non-obvious design decisions: the list is shared by *both* the offline catalog generator and the release ordering, so the two cannot drift.

### packages/boot/app-boot/src/official-bundles.generated.ts
- Purpose: generated offline metadata (localized title/description + a base64 SVG icon) for each official bundle.
- Non-obvious design decisions: generated by `pnpm gen-official-bundle-catalog`; header says "do not edit". Icons are embedded data URIs so the catalog needs no provider code or network.

### packages/boot/app-boot/src/official-bundles.ts
- Purpose: the `OfficialBundleCatalogEntry` shape and the catalog re-export.
- Non-obvious design decisions: "installation state and the requested version belong to the running host" — the catalog is deliberately version-free.

### packages/boot/app-boot/src/package-meta.ts
- Purpose: read plugin display text and icons without evaluating plugin code.
- Key abstractions: `readPluginMeta`, `resolvePluginResource`; `ICON_MEDIA_TYPES`; `MAX_ICON_BYTES = 256 KiB`.
- Data flow: specifier → Node ESM resolver → exported resource → manifest/locale dictionaries → localized text + data-URI icon.
- Non-obvious design decisions: an icon declared in the manifest must be a **relative** path that stays inside the manifest directory; an exported icon must stay inside the *owning package's* directory, verified by walking up to a `package.json` whose `name` matches. Diagnostics name the file the author edits. Only SVG/PNG/JPEG/WebP are admitted.
- Edge cases / failure handling: a bad icon returns `{ ...text, error }` rather than throwing, so a metadata problem never blocks a listing.
- Surprising: `assertPackageOwned` requires an *ancestor* manifest naming the package — a file merely inside a directory with a package.json is not enough.

### packages/boot/app-boot/src/plugin-compatibility.ts
- Purpose: evaluate a plugin's dsh requirements against the running runtime, without importing plugin code.
- Key abstractions: `PluginCompatibility { name, version, runtimeVersion, requirements, exempted }`; `getDshRuntimeVersion`; `pluginCompatibilityWarning`.
- Data flow: plugin manifest → `engines.dsh` or `peerDependencies` → unmet requirements → exemption lookup.
- Non-obvious design decisions: **`engines.dsh` decides alone when present and peerDependencies are ignored entirely**; otherwise every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer must match. Prereleases participate in ranges. For peers only, `workspace:^`/`workspace:~`/`workspace:*` mean the current runtime; an empty or invalid range is **unmet** (fail closed), and a `workspace:` value in `engines.dsh` is invalid. The runtime version is read from this package's own `package.json` via a **string** path (`fileURLToPath`), because "The executable's virtual filesystem intercepts string paths, not URL arguments".
- Edge cases / failure handling: a malformed `engines`/`peerDependencies` shape throws (it is a malformed manifest, not an incompatibility); a mismatch with no usable name/version throws too.
- Surprising: the warning text names the exact remedy command (`dsh plugin allow-version`) and states the exact-version exemption status inline.

### packages/boot/app-boot/src/profile-compatibility.ts
- Purpose: profile-local version exemptions, readable before any plugin loads.
- Key abstractions: `compatibility.json`; `ProfileCompatibility { exemptions, warnings, rewritable }`.
- Data flow: file → strict JSON + canonical-version validation → accepted records + per-record warnings.
- Non-obvious design decisions: **a missing file authorizes nothing**; an unreadable or unparsable file authorizes nothing and is *reported* rather than fatal ("a bad file can never make the profile unusable"). Accepted records still apply while rejected ones are skipped, but the file becomes **read-only** (`rewritable: false`) so a grant cannot silently discard the user's content. Exemptions are keyed `name@version` → exact runtime versions, so neither a plugin upgrade nor a DSH upgrade inherits a grant.
- Edge cases / failure handling: `isExactPluginVersion` rejects ranges, prefixes, whitespace and non-canonical spellings by re-serializing the parsed semver and comparing to the input.
- Surprising: the file is written with mode `0600` and a file lock.

### packages/boot/app-boot/src/profile-context.ts
- Purpose: the launcher-owned profile facts and the composition input order.
- Key abstractions: `ProfileContext` (name, dir, patchPath, installAnchor, cwd, home, startedBundles, overlays, telemetryDisabledEnv, optional `packageManager`); `ProfilePnpmInvocation`.
- Data flow: `readProfilePatches` = bundle patches → profile patch file → home patch file → CLI overlays → telemetry patch.
- Non-obvious design decisions: **ANY non-empty `DSH_TELEMETRY_DISABLED` value disables telemetry, including `'0'` and `'false'`** — "a privacy switch prefers off-by-mistake over on-by-mistake". A composition with no telemetry row exports nothing, so the switch is trivially satisfied.
- Edge cases / failure handling: the telemetry patch is only generated when the composed rows actually carry the telemetry id.

### packages/boot/app-boot/src/profile-plugins.ts
- Purpose: installed profile dependencies and bundle activation after package operations.
- Key abstractions: `ProfilePluginInventory`, `ProfilePluginDependency { name, version, bundle, enabled }`, `ProfilePluginReconciliation`.
- Data flow: profile `package.json` + `node_modules` + installation → inventory → reconcile → rewritten manifest.
- Non-obvious design decisions: the dependency key (npm alias) is the identity, not the installed package's own name. Missing or unreadable installed metadata leaves the dependency **visible for repair or removal** rather than hiding it. Template bundle entries keep their order and duplicates.
- Edge cases / failure handling: `optionalManifest` swallows a malformed installed manifest so listing never breaks.

### packages/boot/app-boot/src/profile-resolution/legacy-links.ts
- Purpose: canonicalize module paths through the active carrier's filesystem.
- Key abstractions: `realModuleDirectory`, `realModuleFile`; `isPackagedExecutable`.
- Non-obvious design decisions: inside a packaged executable, `realpathSync` (not `.native`) is used because the virtual filesystem intercepts it; `realModuleFile` preserves a symlink's physical alias, because "SEA archive files are symlink-free and support stat and reads, while their containing directories support realpath".

### packages/boot/app-boot/src/profile-resolution/resolver.ts
- Purpose: in-memory package routing for Node's default ESM and CommonJS loaders.
- Key abstractions: `ResolutionRoute` (four kinds: `interception`, `native-after-interception`, `native`, plus a package dir), `LayerPositions`, `CommonJsLookup`, `installRuntimeInterception`, `registerWorkerResolution`, `ResolutionRestartRequired`.
- Data flow: resolution table → interception layer → Node's own resolver chain → resolved file.
- Non-obvious design decisions: the interception layer answers an entry's own requests **from the entry's declaring manifest**, and resumes Node's chain from the parent for a name without an entry. Each position on the importer's ancestor chain is a *layer position*: paths below the layer are answered by physical content, the layer itself by the declaring manifest, and above it by Node. CommonJS routing never attaches the routed anchor to the importing module.
- Edge cases / failure handling: a routed CommonJS failure reports the **native require stack** and does not leak the installation anchor into the message; the interception restores the original `_resolveFilename` on dispose.
- Surprising: `replace()` can publish a *successor generation* of the resolution into a running process without unloading modules — the mechanism behind live package installation.

### packages/boot/app-boot/src/profile-resolution/service.ts
- Purpose: the `pluginPackages` service — deterministic package lookup for configured specifiers.
- Key abstractions: `PluginPackages extends Service`; `PluginPackage { name, version, dir, manifestPath, manifest }`; `replace()` and `refresh()`.
- Data flow: specifier + parent URL → interception → package dir → parsed manifest (cached per `{dir, name}`).
- Non-obvious design decisions: `refresh()` recomputes the resolution from the files *only* when the installed resolution is a `ProfileRuntimeResolution`; otherwise it throws. `replace()` does not unload modules or clear Node caches — "Publication does not unload modules or clear Node caches."
- Edge cases / failure handling: `packageOf` returns `undefined` for a non-package request rather than throwing.

### packages/boot/app-boot/src/profile-resolution/worker-bootstrap.ts
- Purpose: install the inherited runtime resolution in one Harness-owned Worker.
- Key abstractions: reads `getEnvironmentData('@deepseek-ai/dsh-app-boot/profile-resolution')`.
- Non-obvious design decisions: the key is a string constant shared with `registerWorkerResolution`; the bootstrap is a *side-effect module* with no exports.

### packages/boot/app-boot/src/profile-sanitize.ts
- Purpose: filesystem recovery for a profile whose patch is broken.
- Key abstractions: `sanitizeProfile(binName, profileDir, bundles)` → backup path or `undefined`.
- Data flow: rename `cordis.patch.yml` → `cordis.patch.yml.bak-<unix ms>` (with an `-N` collision ordinal) → rewrite only the bundle list.
- Non-obvious design decisions: the caller must stop the profile and exclude concurrent writes; the patch is **never parsed** (a broken patch is exactly why this path exists). Installed packages and other manifest fields are preserved.
- Edge cases / failure handling: a missing patch yields `undefined`; a rename failure propagates *before* any activation change.

### packages/boot/app-boot/src/profile.ts
- Purpose: profile discovery, init, manifest round-trips, two-anchor bundle resolution, patch-layer composition.
- Key abstractions: `Profile`, `ProfileManifest`, `PROFILE_PATCH_FILENAME = 'cordis.patch.yml'`, `PROFILES_DIR`, `PROFILE_TEMPLATES`, `bundlePatchFiles`/`bundlePatchPaths`, `resolveBundleDir`, `composeEntries`, `createRuntimeResolution`, `ProfileRuntimeResolution`.
- Data flow: profile dir → manifest + patch file + bundle layers → composed entry list → runtime resolution table.
- Non-obvious design decisions: **module resolution is two-anchor by construction** — a bundle name resolves first from the dsh installation, then from the profile directory, and pnpm-managed entries in the profile's `node_modules` resolve first. `composeEntries` calls the **same `applyEntryPatches` over an empty root** that the boot include makes, so "flag derivation and config dumps see exactly what mounts". A patch **replaces** the targeted row's whole `config` rather than deep-merging; a truthy `name` in a patch *asserts* the existing plugin name rather than renaming it.
- Edge cases / failure handling: a bundle whose manifest, patch or patch load fails is **skipped**, not fatal — it is listed in `skippedBundles` and reported once per launch. A skipped bundle does not guarantee the remaining composition provides the services it would have.
- Surprising: `bundlePatchFiles` accepts either a single file or an ordered list, so one bundle can contribute several layers.

### packages/boot/app-boot/tests/app-boot.spec.ts
- Purpose: tests for config-path resolution, `.env` loading, fail-loud, and the startup audit.
- Key abstractions: a fake `Context` with a `loader.entries()` stub and synthetic fibers in each `FiberState`.
- Non-obvious design decisions: the audit is tested with `disabled` entries whose getter *throws*, proving that a throwing disabled expression is a failure and not a disabled entry. Nested `AggregateError` causes and a circular `cause` chain are both pinned.
- Edge cases / failure handling: an absent `.env` is silent (the ambient environment wins); a present-but-unreadable `.env` produces exactly one labelled warning.

### packages/boot/app-boot/tests/compatibility-preflight.spec.ts
- Purpose: prove that an incompatible plugin is blocked before its module is imported.
- Key abstractions: fixture plugins append `import:<name>` / `apply:<name>` to a file, so the test can assert the denied plugin's module was never evaluated.
- Non-obvious design decisions: the exemption is keyed on the *actual alias manifest*, and a denied native `Include` is omitted as a whole.
- Edge cases / failure handling: a row whose plugin cannot be resolved keeps the Loader's own import failure.

### packages/boot/app-boot/tests/config-dump.spec.ts
- Purpose: the offline config dump equals what `boot()` mounts.
- Key abstractions: `renderConfigDump(name, base, layers, warn)`; the dump is parsed back with `entryListSchema`.
- Non-obvious design decisions: `!!js` expressions print **verbatim** as YAML scalars and round-trip as `{ __jsExpr: ... }`; source separators name the origin file and every layer that changed the row, and an inserted row carries the inserting layer as its origin; the whole dump stays **one loadable YAML document**.
- Edge cases / failure handling: a patch whose target is absent is **warned and skipped**, mirroring the Loader's boot-time warning, rather than failing the dump.

### packages/boot/app-boot/tests/config-pattern.spec.ts
- Purpose: table-driven expectations for regex portability.
- Key abstractions: 24 `(source, flags, expected)` rows.
- Non-obvious design decisions: `a.*\B` is **not** portable (a `\B` assertion can observe a surrogate pair's midpoint) while `a.*` is; `[^x]` is not, `\S` is.

### packages/boot/app-boot/tests/config-reload.spec.ts
- Purpose: Include refresh against an invalid or empty file, and overlay re-application.
- Key abstractions: `include.refresh()` on the booted tree.
- Non-obvious design decisions: an empty file parses to `undefined` **without a YAML error** and must be treated exactly like a parse failure — it must not crash the entry walk. The last good tree is kept rather than thrown.

### packages/boot/app-boot/tests/config-schema.spec.ts
- Purpose: the generated document end to end with a real Schemastery schema and Ajv 2020.
- Key abstractions: `buildConfigSchemaDocument`, `collectConfigSchemas`; `ModuleLoader.fromInternal` is mocked so no plugin code runs.
- Non-obvious design decisions: the interception is released even when the Node module loader is unavailable (asserted via a spy), and diagnostics are copied rather than aliased.

### packages/boot/app-boot/tests/hooks-thread-stack.ts
- Purpose: rethrow Node resolver errors with a writable `stack` property.
- Non-obvious design decisions: Node serializes an error on its hooks thread, so the main thread receives the stack accessor as a read-only configurable data property — the helper re-defines it to match the async `module.register()` chain.

### packages/boot/app-boot/tests/linked-resolution-matrix.spec.ts
- Purpose: a differential matrix proving the profile's routing matches native Node lookup.
- Key abstractions: 3 layouts × 7 methods (`esm-resolve`, `esm-meta-resolve`, `esm-import`, `cjs-resolve`, `cjs-require`, `cjs-paths`, `metadata`) × 4 importer positions × 6 package sources × 3 manifest states × 3 node_modules states.
- Non-obvious design decisions: explicit paths are exempt from the policy and use the pristine native filesystem, so `cjs-paths` is compared natively. Every observation must be non-`external`, and the projected run must equal the reference run case for case.
- Edge cases / failure handling: unresolved and local rows are left to startup.

### packages/boot/app-boot/tests/loader-shape.compat.spec.ts
- Purpose: detect the running Node loader's internal shape.
- Key abstractions: `ctx.loader.internal.version === 'v2'`.
- Non-obvious design decisions: "A tag taken from the Node major instead of the loader's own API rejects every call on 24.0-24.11.1, which report major 24 while carrying the v1 loader: v2 arrived only in 24.12.0."

### packages/boot/app-boot/tests/official-bundles.spec.ts
- Purpose: the offline catalog holds exactly two entries, both languages, no version.
- Edge cases / failure handling: the icon must be a base64 SVG data URI.

### packages/boot/app-boot/tests/package-meta.spec.ts
- Purpose: plugin locale metadata resolves without executing the plugin.
- Key abstractions: a fixture plugin whose `index.js` throws on import — metadata must never trigger it.
- Non-obvious design decisions: eleven Windows and POSIX *file address* spellings must all be refused without even calling the resolver.

### packages/boot/app-boot/tests/plugin-compatibility.spec.ts
- Purpose: table-driven tests for the compatibility rules.
- Non-obvious design decisions: `getDshRuntimeVersion` must read with a **string** path (`fileURLToPath(new URL('../package.json', import.meta.url))`), pinned by a spy on `fs.readFileSync`.

### packages/boot/app-boot/tests/profile-compatibility.spec.ts
- Purpose: exact identities, informed grants, malformed data.
- Non-obvious design decisions: an empty permission list is a *valid* record authorizing nothing (`rewritable: true`); a rejected record makes the file non-rewritable, and a grant then refuses with "must be repaired" — but a **revocation** of an accepted grant is also refused while another record is rejected, and the test pins that.

### packages/boot/app-boot/tests/profile-plugins.spec.ts
- Purpose: the dependency inventory and the bundle reconciliation.
- Edge cases / failure handling: malformed installed metadata stays visible and removable with enablement unavailable.

### packages/boot/app-boot/tests/profile-resolution-service.spec.ts
- Purpose: the service refreshes from the profile and installation, and republishes to Workers.
- Non-obvious design decisions: the Worker environment data is restored to the *previous* value on dispose.

### packages/boot/app-boot/tests/profile-resolution-worker-bootstrap.spec.ts
- Purpose: the Worker bootstrap installs only the inherited resolution.
- Non-obvious design decisions: `vi.hoisted` + module mocks rather than a real Worker, so the assertion is about the contract not the transport.

### packages/boot/app-boot/tests/profile-sanitize.spec.ts
- Purpose: profile recovery preserves user files.
- Non-obvious design decisions: repeated recoveries get `-1`, `-2` ordinals rather than overwriting an earlier backup; an invalid profile JSON leaves the patch **untouched** (no backup created).

### packages/boot/app-boot/tests/profile.spec.ts
- Purpose: profile directory resolution and init, manifest round-trips, two-anchor bundle resolution, patch layers, empty-root composition, runtime resolution.
- Non-obvious design decisions: the profile directory is `realpathSync.native`-resolved, because pnpm resolves workspace roots through native realpath including Windows 8.3 aliases.

### packages/boot/app-boot/tests/profile-resolution.spec.ts
- Purpose: differential tests for the runtime resolution over ESM and CommonJS.
- Key abstractions: `resolveFrom` / `importFrom` reach into `internal/modules/esm/loader` via the `node-addon-require-builtin` addon.
- Non-obvious design decisions: a package whose `exports` is `null` is treated as legacy CommonJS package resolution; a missing local CommonJS subpath falls through to the installation; a null-prototype package `imports` map is not inherited across `node_modules`; explicit CommonJS conditions are passed to the resolution target; a routed CommonJS failure reports the native require stack and does not leak the install anchor.
- Edge cases / failure handling: `dispose()` restores native CommonJS resolution.

### packages/boot/app-boot/tests/schemastery-json-schema.spec.ts
- Purpose: the JSON Schema projection against Ajv.
- Non-obvious design decisions: required-ness is derived from **fallback validation**, not only `meta.required`; a union is projected as `anyOf` and the test asserts the schema contains `first-success` and does **not** contain `oneOf`; a transform callback is never called during projection.

### packages/boot/app-boot/tests/user-patches.spec.ts
- Purpose: the optional patch-list loader and `boot()` applying the user layer.
- Non-obvious design decisions: `!!js` expressions survive as loader expression nodes; an absolute plugin path in a patch file is converted to a **file URL** (a Windows path cannot stand in for a URL — `C:` reads as a scheme).

### packages/boot/app-boot/tsconfig.json
- TypeScript project: `src` → `lib/types`, referencing the vendored cordis/loader/include/group and the launch-environment, home-paths, package-manifest and atomic-write utilities.

### packages/boot/app-boot/tsdown.config.ts
- Build config: bundles `cordis-plugin-include` but keeps Loader external, "so the built include tree and app host bind to one Loader peer". The Worker bootstrap bundles `resolve.exports` instead.

### packages/boot/cmdline/package.json
- Manifest: commander is a **devDependency only** — the package ships no parser, so an app brings its own.

### packages/boot/cmdline/README.i18n.yaml
- 20 per-heading en/zh hashes.

### packages/boot/cmdline/README.md
- Purpose: the immutable launcher-to-app handoff.
- Key abstractions: `ctx.cmdlineArgs` (an immutable snapshot; reading never consumes), `ctx.appExit` (bounded exit request), `ctx.appReady` (successful-startup signal).
- Non-obvious design decisions: the launcher parses only *its own* flags and hands everything after them through verbatim, so an app owns its flag family, `--help` text and parse errors. The value written beside a `!!js` expression is the **fallback**: `port: !!js ctx.webStartup.port ?? 3080` — "Resolution happens once at startup, after your parser ran, so a flag is never silently reset by a later config reload."
- Edge cases / failure handling: an app launched with no arguments sees an empty list — "that is the honest answer, not a missing value". `exitOnStdinEnd` never reads or resumes stdin, so a protocol transport receives bytes buffered before it mounts.
- Surprising: an approval leaves the session permission mode unchanged (that is plugin-manager, but the same principle).

### packages/boot/cmdline/README.zh.md
- Chinese mirror; English read in full, first 30 lines of this read.

### packages/boot/cmdline/src/index.ts
- Purpose: provide `cmdlineArgs`/`appExit`/`appReady` and adapt commander to the launcher.
- Key abstractions: `provideCmdline(ctx, host)`, `parseCmdline(ctx, program)`, `exitOnStdinEnd(ctx, label)`, `internals` (substitutable stdout/stderr/stdin).
- Non-obvious design decisions: `isCommanderError` detects commander's control-flow error **structurally** (a `code` string starting `commander.` plus a numeric `exitCode`), not with `instanceof` — "an out-of-tree plugin brings its own commander copy, whose `CommanderError` class is a different identity from this package's, and an identity check there would rethrow a printed help as a fatal load failure".
- Edge cases / failure handling: `exitOnStdinEnd` fails loud without `ctx.appExit` and `ctx.appReady`.

### packages/boot/cmdline/tests/cmdline.spec.ts
- Purpose: the handoff over a **real Loader tree**.
- Non-obvious design decisions: "Loader holds each row until its injections are active, then resolves that row's config against its injection-ready context" — the fixture boots that way, so the test proves the real ordering rather than a mock's.

### packages/boot/cmdline/tsconfig.json
- TypeScript project referencing the vendored cordis, include and loader projects.

### packages/boot/config-editor/locale/en.json
- English locale stub: `meta.title` only.

### packages/boot/config-editor/locale/zh.json
- Chinese locale: title plus a one-line description.

### packages/boot/config-editor/package.json
- Manifest: `dsh-hmr` is an **optional** peer — the editor works without HMR (it then runs its own reconciliation).

### packages/boot/config-editor/README.i18n.yaml
- 13 per-heading en/zh hashes.

### packages/boot/config-editor/README.md
- Purpose: save the active profile's plugin configuration and apply it immediately.
- Non-obvious design decisions: writes **validate the complete candidate before touching disk** and serialize with profile changes and HMR; invalid values and higher-layer overrides leave the file unchanged. A complete config override "preserves ordinary fields but pins their current raw values at the profile layer". Only uniquely addressed entries owned by the profile's root Include are editable.
- Edge cases / failure handling: a failed reconciliation restores the prior document *and* reloads the prior patches.

### packages/boot/config-editor/README.zh.md
- Chinese mirror; English read in full, first 25 lines of this read.

### packages/boot/config-editor/src/index.ts
- Purpose: persist plugin configuration through the profile patch.
- Key abstractions: `ConfigEditor extends Service` with `static inject = ['loader', 'profileContext']`; `entries()`, `configuration()`, `edit()`.
- Data flow: compose inherited + override layers → build the candidate YAML → atomic write → `reconcileProfilePatches` → rollback on failure.
- Non-obvious design decisions: an own config key can replace inherited config **even when its value is undefined** (hence `Object.hasOwn(patch, 'config')`). Composition reads are **not cached** between reads. The edit runs under `hmr.runExclusive` when HMR is present, otherwise directly.
- Edge cases / failure handling: the YAML document is edited with the `yaml` package's CST so comments and `!!js` expressions outside replaced values survive; on a failed reconciliation the previous bytes are written back and the previous patches reloaded.

### packages/boot/config-editor/tsconfig.json
- TypeScript project referencing cordis, loader, hmr, app-boot, atomic-write and the vendored include.

### packages/boot/hmr/LICENSE
- MIT license text, copyright Shigma.

### packages/boot/hmr/locale/en.json
- English locale stub: `meta.title` only.

### packages/boot/hmr/locale/zh.json
- Chinese locale: title and a one-line description.

### packages/boot/hmr/package.json
- Manifest: `chokidar 5.0.0`, `@babel/code-frame`, `picomatch`; peers the cordis timer/loader/include plus app-boot and cmdline.

### packages/boot/hmr/README.i18n.yaml
- 20 per-heading en/zh hashes, including a KV-cache subsection.

### packages/boot/hmr/README.md
- Purpose: coordinated reload.
- Key abstractions: one queue for module replacements, Include refreshes and profile configuration changes; package installation runs **outside** that queue.
- Non-obvious design decisions: `awaitWriteFinish: true` by default for config watches because "edits wait for Chokidar's 2-second write-stability window, avoiding its lossy change-event throttle". Profile recompositions also replace plugins whose *installed* files changed on disk, so source watching through `root` is not required. "A replacement that fails to load stops the previous plugin and is reported as `failed` with its load error instead of as a restart, which would load the same files."
- Edge cases / failure handling: documented limits — package invalidation is not retained across HMR disposal; an instance without a Loader entry cannot be assigned to a replacement's callbacks (ambiguity error → rollback); on darwin, libuv starts FSEvents after Chokidar's `ready`, so a write within milliseconds of registration is missed.
- Surprising: the base bundle enables HMR with `root: []` — profile configuration reloads by default, module roots are opt-in.

### packages/boot/hmr/README.zh.md
- Chinese mirror; English read in full, first 30 lines of this read.

### packages/boot/hmr/src/error.ts
- Purpose: format build failures with code frames.
- Non-obvious design decisions: `isBuildFailure` checks the *shape* (`errors` array of `{ text: string }`), not an esbuild type, so an unrelated error is never mis-formatted.

### packages/boot/hmr/src/index.ts
- Purpose: the reload engine.
- Key abstractions: `Hmr extends Service`; `HmrConfig { base, root, debounce, ignored }` plus Chokidar options; the `hmr/change` and `hmr/reload` events.
- Data flow: file event → debounce → analyze changes (accepted/declined dependency sets) → `partialReload` (evict, re-import, re-apply) → emit.
- Non-obvious design decisions: a plugin's **entry file is an atomic reload unit**; the accepted/declined propagation walks the dependency graph and stops at a module that is both accepted and declined. `loadDependencies` skips `node_modules` unless asked. On replacement, the old runtime is stopped and the new fibers carry the old entry's config forward.
- Edge cases / failure handling: a runtime removed during dependency traversal is not reactivated (pinned by a test); the reported failure is the *original* replacement error even when restoring the old plugin also fails; "Re-export roots of a replaced runtime must not retain bindings to its old modules."
- Surprising: `canonicalPath` uses `realpathSync` (not `.native`) because "Node's ESM resolver uses the JS realpath implementation; native realpath expands Windows short names differently and would miss its cache keys".

### packages/boot/hmr/src/module-files.ts
- Purpose: find loaded modules whose files changed after loading.
- Key abstractions: `ModuleFiles` with `records`, `observedAt`; `now()`, `compare()`, `observe()`, `refresh()`.
- Data flow: `file:` module URLs → `statSync` → identity key `ino:size:mtimeMs` → stale set.
- Non-obvious design decisions: **change time is deliberately not recorded** — "creating a hard link to a file, as pnpm does when it imports from its store, changes it without changing content". The comparison clock is read from a **freshly written marker file's mtime**, not `Date.now()`, because "the system clock and file timestamps can differ by a clock tick in either direction". A module first loaded after the last observation is stale when its file was modified at or after that observation, less a 2 s resolution allowance (FAT granularity).
- Edge cases / failure handling: an unwritable temp directory falls back to the system clock; a removed file is stale.

### packages/boot/hmr/src/package-manifest.ts
- Purpose: expire Node's cached package configuration for changed manifests.
- Key abstractions: `PackageManifests`; patches `binding.readPackageJSON`, `binding.getPackageScopeConfig`, `binding.getPackageType` and `reader.getNearestParentPackageJSON`.
- Data flow: manifest change → invalidated binding entries → Node's resolver re-reads the file.
- Non-obvious design decisions: `createReplaceHelper` restores a method **only while its replacement is still installed**, so a later installer is not clobbered. `requireInternal` tries `--expose-internals` first, then the builtin addon, and treats a missing internal as "the caller reports the missing interface".
- Edge cases / failure handling: the manifest's `exports`/`imports` are normalized to strings for Node's native representation.

### packages/boot/hmr/src/watch-config.ts
- Purpose: watch one patch file, not its directory.
- Key abstractions: `watchConfig(ctx, filename, options, refresh, inTransaction)` → disposer.
- Data flow: nearest existing ancestor → chokidar root with a depth limit → `ignored` predicate excluding every sibling path → serialized refresh loop.
- Non-obvious design decisions: the `ignored` predicate computes `relative(resolve(path), target.filename)` and rejects anything that is not the target, so **sibling files — including temporary writer locks — are excluded before native watcher creation**. The refresh loop is a self-rescheduling `while (state.dirty)` so a change during a refresh is not lost. `awaitWriteFinish: true` bypasses Chokidar's lossy 50 ms throttle.
- Edge cases / failure handling: on dispose the error listener is **re-attached across `close()`**, because "its straggler stats a file this teardown is deleting, which Windows reports as EPERM, and an 'error' emission with no listener is rethrown as an uncaught exception".

### packages/boot/hmr/tests/coordination.spec.ts
- Purpose: the exclusive queue.
- Non-obvious design decisions: nesting `runExclusive` inside `runExclusive` is **refused** ("cannot be nested"), and the queue stays usable after a failure. Configuration handlers wait behind configuration mutations. A provider reconfiguration rebinds its watchers.

### packages/boot/hmr/tests/error.spec.ts
- Purpose: diagnostics preserve compiler locations and unknown loader failures.
- Non-obvious design decisions: an unrecognized error is forwarded *unchanged* (`expect(warn).toHaveBeenCalledWith(error)`), never swallowed into a generic message.

### packages/boot/hmr/tests/fixtures/package-root-scope.mjs
- Purpose: a standalone script that invalidates the filesystem-root `package.json` and asserts Node's scope and nearest-manifest lookups are unchanged.
- Non-obvious design decisions: "Isolate root-scope traversal; the filesystem root is read but never modified."

### packages/boot/hmr/tests/module-files.spec.ts
- Purpose: the file clock.
- Edge cases / failure handling: the marker directory is removed; an unwritable temp dir falls back to `Date.now()`.

### packages/boot/hmr/tests/modules.spec.ts
- Purpose: module graph replacement over a controlled loader.
- Non-obvious design decisions: the fixture supplies only the loader operations HMR exercises, and ModuleJob's execution methods belong to Node.

### packages/boot/hmr/tests/package-manifest-dispatch.spec.ts
- Purpose: a package.json change dispatches a replacement through a real Loader.
- Non-obvious design decisions: when the replacement resolves to the *same* module namespace, the plugin is not restarted twice — the trace shows two starts of the new code and two stops of the old, with no warning.

### packages/boot/hmr/tests/package-manifest.spec.ts
- Purpose: an invalidated manifest is re-read by Node's resolver.
- Edge cases / failure handling: filename-based resolve hooks and `node:`-prefixed builtins survive invalidation; `dispose()` restores only the methods it replaced.

### packages/boot/hmr/tests/package-reload.spec.ts
- Purpose: profile reconciliation replaces plugins whose installed files changed.
- Key abstractions: `reconcileProfilePatches`; the result carries `warnings` and `pending`.
- Non-obvious design decisions: a plugin that cannot be replaced (an unmanaged plugin outside a Loader entry) is reported as `pending: [{ url, reason: 'unmanaged-plugin' }]` while the *other* changed plugins are still replaced. A module whose evaluation has not finished is cached with `loaded: false` and is left alone. A module first loaded *during* a recomposition whose file changed before it settled is replaced on the next recomposition.
- Edge cases / failure handling: a replaced entry whose package entry point now fails to import is reported as "did not activate"; a plugin its new bundle patch disables is not started.

### packages/boot/hmr/tests/profile.spec.ts
- Purpose: profile watches share HMR's queue and readiness barrier.
- Non-obvious design decisions: the watcher's first refresh waits for **application readiness** (`appReady`), so a patch edited during boot is applied only after startup commits — and a patch edited after boot parsing but before watcher registration is still applied.

### packages/boot/hmr/tests/reconciliation.spec.ts
- Purpose: Include recomposition after each delivered file event.
- Non-obvious design decisions: a failed candidate is **reported** but the tree keeps the failed config (`{ fail: true }` is visible), an invalid `!!js` disabled expression is reported with its SyntaxError, a parse failure leaves the previous `disabled` value in place, and a later valid edit recovers.

### packages/boot/hmr/tests/watch-config.spec.ts
- Purpose: exact-path watching.
- Non-obvious design decisions: `ensureNativeWatchLive` opens and closes a directory handle to force darwin's per-process FSEvents stream to arm — "Closing any directory handle runs `uv__fsevents_close`, whose `uv_sem_wait` returns only after `uv__fsevents_reschedule` has rebuilt and started the stream". The comment is explicit that a future libuv release would lose this.

### packages/boot/hmr/tsconfig.json
- TypeScript project referencing the vendored cordis, loader, include, timer and schemastery plus app-boot and cmdline.

### packages/boot/plugin-manager/locale/en.json
- English locale stub: `meta.title` only.

### packages/boot/plugin-manager/locale/tools/en.json
- English locale stub for the tools entry: `meta.title` only.

### packages/boot/plugin-manager/locale/tools/zh.json
- Chinese locale for the tools entry: `meta.title` only.

### packages/boot/plugin-manager/locale/zh.json
- Chinese locale: title and a one-line description.

### packages/boot/plugin-manager/package.json
- Manifest exporting `./types`, `./registry`, `./tools`, `./typert`, `./remote`, `./operations`; `dsh-hmr` and `dsh-user-approval` are **optional** peers.

### packages/boot/plugin-manager/README.i18n.yaml
- 21 per-heading en/zh hashes.

### packages/boot/plugin-manager/README.md
- Purpose: manage the current profile's plugins without editing configuration by hand.
- Non-obvious design decisions: a toggle "updates only `disabled` in the last matching override in the profile's `cordis.patch.yml`, or appends an override when none matches"; an override holding only `id` and `disabled` is **removed** when the bundle layers already give the requested state, "so the profile patch records only departures from the bundles". Home and invocation patches are left out of that comparison. A selected bundle that cannot load remains in `listBundles` with an `error`; `enabled` records the saved selection, not successful loading.
- Edge cases / failure handling: the failure table is explicit — a failed install restores `package.json` and `pnpm-lock.yaml` as snapshotted before pnpm ran (files pnpm downloaded may remain); a failed enable keeps the installed dependency and the saved selection; "pnpm's zero exit code does not mean publication succeeded"; a failed removal preserves completed changes and does not re-enable the bundle. `pnpm remove` runs with the registry the manager last installed from, because pnpm verifies lockfile tarball URLs against its default registry.
- Surprising: the tool requires `danger-full-access` or per-call approval; under `never`/rejection/unavailable approval the action is prevented, and "An approval leaves the session permission mode unchanged."

### packages/boot/plugin-manager/README.zh.md
- Chinese mirror; English read in full, first 20 lines of this read.

### packages/boot/plugin-manager/src/build-approval.ts
- Purpose: approve pnpm's pending dependency scripts in the profile's workspace settings.
- Key abstractions: `recordPendingBuilds(dir, output)`, `approveBuilds(dir, names)`, `ignoredBuildNames(output)`.
- Data flow: the failed run's output → the `Ignored build scripts:` line → `pnpm-workspace.yaml` `allowBuilds` entries → explicit `true`.
- Non-obvious design decisions: pnpm writes those policy entries itself **only when it can prompt**, and the manager always runs it non-interactively — "so the run's own report is the record that survives". The pending value is pnpm's own placeholder string `set this to true or false`, so pnpm and the manager agree. Wildcard names are excluded from the pending list.
- Edge cases / failure handling: an approval naming a package that is no longer pending fails with `stale-approval` and **writes nothing**. YAML anchors and aliases inside `allowBuilds` are refused, because a shared node would let one approval change another package's permission.

### packages/boot/plugin-manager/src/failure.ts
- Purpose: localizable rejections.
- Key abstractions: `ManagementFailure extends Error` with a `code` and an optional `incompatible` list.
- Non-obvious design decisions: presentation belongs to the caller's locale; the error carries only a code, never English prose.

### packages/boot/plugin-manager/src/github-connection.ts
- Purpose: a bounded GitHub reachability check before pnpm starts.
- Key abstractions: `checkGithubConnection(spec, dir, options)` → `PackageResult | undefined`.
- Data flow: git spec → `git -c credential.helper= ls-remote -- <repo> HEAD` → bounded log tail.
- Non-obvious design decisions: credential helpers are disabled, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS`/`SSH_ASKPASS` cleared, and the log is written to a `0600` file under the profile's `.plugin-manager/logs`. The timeout terminates descendants with `SIGKILL`.
- Edge cases / failure handling: only github.com hosts are checked (other hosts are left to the installer); a missing repository is refused with the classified kind.

### packages/boot/plugin-manager/src/index.ts
- Purpose: the manager service.
- Key abstractions: `listPlugins`, `listBundles`, `setPluginEnabled`, `setBundleEnabled`, `installBundle`, `removeBundle`, `inspect`, `listVersionExemptions`, `setVersionExemption`; the `plugin-manager/changed`, `plugin-manager/install-log` and `plugin-manager/install-state` events.
- Data flow: a remote call → a profile file lock → a pnpm run → bundle reconciliation → HMR reload → a runtime resolution publication → a `ChangeResult`.
- Non-obvious design decisions: `diskState()` fingerprints `package.json`, `cordis.patch.yml`, `pnpm-workspace.yaml` and `compatibility.json` to decide whether a change actually landed. The install path asks registries **in plan order** and, on a failure another registry could change, restores the files between attempts. An install is refused *before* pnpm runs when the package is already installed under any spelling (name, version, local directory, tarball).
- Edge cases / failure handling: an installation whose bundle metadata is invalid restores the manifest rather than cleaning it through another pnpm run; a bundle that activates but fails to load stays installed and removable.

### packages/boot/plugin-manager/src/install-failure.ts
- Purpose: classify a failed pnpm run.
- Key abstractions: `InstallFailureFacts { log, cause?, timedOut? }`; the ordered `LOG_KINDS` table.
- Data flow: how the run ended → then the most specific code in its output.
- Non-obvious design decisions: the table is **ordered** so a specific code precedes the generic network family (`build-blocked` before `network`). `timeout` and `pnpm-missing` are decided from the *facts*, not the log. A `401`/`403`/`404` git response is deliberately `unknown`, not `network` — "Git HTTP 401/403/404 responses are left out of connection recovery".
- Edge cases / failure handling: an offline cache miss (`ERR_PNPM_NO_OFFLINE_META`) is `unknown`, because no registry would change it.

### packages/boot/plugin-manager/src/install-spec.ts
- Purpose: read an install spec before pnpm sees it.
- Key abstractions: `ParsedInstallSpec` (registry / path / tarball / git), `InvalidInstallSpecError`, `parseInstallSpec`, `dependencySpec`.
- Data flow: typed spec → form + name + range + host.
- Non-obvious design decisions: **a local path must be absolute** — "the Host's working directory means nothing to the person typing into a browser, and a relative path resolved against the profile would point inside it." A git or tarball spec carries the **host** it is fetched from, "which no registry stands in for". A package name must match npm's rules and be ≤ 214 chars.
- Edge cases / failure handling: a URL that is neither a git repository nor a tarball is refused with that reason.

### packages/boot/plugin-manager/src/official-install-target.ts
- Purpose: choose the install target for an official bundle.
- Key abstractions: `officialBundleInstallTarget(name, installAnchor, version)` → `{ spec, version }`.
- Data flow: the installation manifest → source-checkout detection → workspace glob → the matching package → a `link:` or a published version.
- Non-obvious design decisions: a source installation is identified by the real CLI manifest **and** its unpacked workspace dependencies. An incomplete checkout is an **error, never a registry fallback** — "An incomplete checkout is an error, never a registry fallback." The workspace package must be found by manifest name (not by directory convention), must be unique, must be public, must declare a bundle, and must have a built runtime and its bundle patch present.
- Edge cases / failure handling: each missing precondition has its own message naming the repair command.

### packages/boot/plugin-manager/src/operations.ts
- Purpose: the shared profile package operations.
- Key abstractions: `runProfilePnpm`, `runPluginCommand`, `viewProfilePackage`, `readProfileRegistry`, `bundleManifest`, `anchorPathSpec`; `PackageOperationOptions`.
- Data flow: a pnpm invocation → scrubbed environment → captured output → a bounded log file → bundle reconciliation → installed-package compatibility check.
- Non-obvious design decisions: the **service** execution mode scrubs the parent environment and captures output; the **cli** mode inherits authentication and terminal descriptors. An `idleTimeoutMs` bound ends a run that stops progressing — "without a bound, a child that stops progressing without exiting holds its caller forever. A run with inherited descriptors captures nothing and is never bound." The process tree is waited on before the profile is unlocked.
- Edge cases / failure handling: `pnpm view` is run with `--config.fetch-retries=0` and a timeout; the pre-install lookup is separate from the install.

### packages/boot/plugin-manager/src/patch.ts
- Purpose: comment-preserving enablement edits.
- Key abstractions: `flatten(rows)`, `writePluginEnabled(profile, id, name, enabled)`.
- Data flow: the patch file → a YAML CST → find the last matching override → set or remove `disabled` → atomic write.
- Non-obvious design decisions: an override is matched by entry id **and** an optional module-name assertion (a truthy `name` asserts rather than renames). An override holding only `id` and `disabled` is **removed** when the bundle layers and remaining profile patches already imply the requested state — and the comment above a removed override is moved to the next item, to the document header, or to the document footer, "The comment above the removed override can be the file header". A removed override that carries an **anchor** other entries reference is kept.
- Edge cases / failure handling: the comparison uses the entry's own **literal** `disabled`; "a `!!js` value never matches, so its override is kept". A malformed document is refused without overwriting.

### packages/boot/plugin-manager/src/registry.ts
- Purpose: which registries one operation asks, in order, and what a failed attempt could not reach.
- Key abstractions: `registryPlan(requested, configured)`, `attributeFailure(kind, log, spec)`, `normalizeRegistry`, `OFFICIAL_NPM_REGISTRY`, `NPMMIRROR_REGISTRY`.
- Data flow: requested registry + configured set + what pnpm's own configuration names → an ordered plan → per-attempt outcome.
- Non-obvious design decisions: **a private registry never falls through to a public one.** pnpm's own registry (`null`) belongs to the set only when what it names is known to be public; while it names anything else, or is unknown, it is asked alone, and a public registry asked instead never falls back into it. A registry outside the configured set is also asked alone. A registry pnpm's own configuration already names is asked once.
- Edge cases / failure handling: `attributeFailure` reads the spec host **off error lines only** — "The log's host is read only off error lines, not off a warning that links to it", so a deprecation warning linking to GitHub does not misattribute a registry failure.

### packages/boot/plugin-manager/src/run-tree.ts
- Purpose: wait for a terminated run's whole process tree to disappear.
- Key abstractions: `RunTree { pid, grouped }`, `leadsOwnGroup`, `treeAlive`, `awaitTreeGone`, `RunTreeInternals`.
- Data flow: terminate → poll the group/process → return when gone or the 5 s bound elapses.
- Non-obvious design decisions: a run that **captures output** is spawned as its own group leader (POSIX), so its tree is terminated as a unit; a run that inherits the caller's descriptors keeps the caller's group, "so an interrupt still reaches it". The liveness probe is `process.kill(target, 0)` with `-pid` for a group.
- Edge cases / failure handling: a vanished process throws ESRCH and is reported as gone; the wait is bounded.

### packages/boot/plugin-manager/src/tools.ts
- Purpose: the agent-facing `plugin_manager` tool.
- Key abstractions: `ERROR_STEPS` (one sentence per refusal code), `FAILURE_STEPS` (one per package failure kind), `RESTART_STEPS` (one per restart reason).
- Data flow: a tool call → the manager → a JSON result with a `nextStep`.
- Non-obvious design decisions: the guidance table is the interesting part: each refusal names the *next action* ("Call `list_plugins` and retry with an exact entryId"; "This profile runs without HMR; tell the user to stop DSH and run `dsh plugin --profile <profile> remove <bundle>`"). A **refusal code is more specific than a package-manager failure kind** and wins when both are present.
- Edge cases / failure handling: every management action requires `danger-full-access` or approval; under lower modes the call is denied **before the manager is touched**.

### packages/boot/plugin-manager/src/types.ts
- Purpose: the public records.
- Key abstractions: `ReadOnlyReason`, `ManagementError['code']`, `RestartReason`, `PluginInfo`, `BundleInfo`, `BundleRowInfo`, `PluginChange`, `PluginInstallProgress`.
- Non-obvious design decisions: `PluginInfo` is a **discriminated union** — either it carries a `patchId` (writable) or a `readOnlyReason` (not), never both and never neither. `RestartReason` names five distinct causes of "wait for the next start", so the UI can say *why* rather than "restart".

### packages/boot/plugin-manager/tests/build-approval.spec.ts
- Purpose: pending script permissions survive a cleanup.
- Non-obvious design decisions: an unlisted approval is rejected **atomically** (the file is byte-identical afterwards); pnpm file-dependency selectors (`@scope/addon@file:../local addon`) are preserved verbatim as keys.

### packages/boot/plugin-manager/tests/git-environment.ts
- Purpose: keep the host's Git command-line configuration out of the spawned children.
- Non-obvious design decisions: the shared subprocess scrub removes credential-shaped names, so a child that inherits the *counter* without its key fails before reading any configuration file (`error: missing config key GIT_CONFIG_KEY_0`). The helper therefore strips the whole `GIT_CONFIG_*` group.

### packages/boot/plugin-manager/tests/github-connection.spec.ts
- Purpose: real Git transport deadlines, process cleanup and bounded diagnostics.
- Non-obvious design decisions: a local TCP proxy stands in for github.com, so the test proves the timeout and the descendant kill without touching the network. A credential helper is installed and the assertion is that it is **never** invoked.

### packages/boot/plugin-manager/tests/install-spec.spec.ts
- Purpose: every accepted spec form and every refusal reason, plus the failure classification.
- Edge cases / failure handling: `pkg@` (empty version), `.hidden`, `has space` and a 215-char name are all refused with their own reason.

### packages/boot/plugin-manager/tests/manager.spec.ts
- Purpose: the manager's behavioural suite over a real profile Include and Loader.
- Non-obvious design decisions: the install path emits `plugin-manager/install-state` **once per registry** with the attempt's registry and position, and `plugin-manager/install-log` chunks; a failed attempt's partial lockfile is **gone before the next registry is asked**. The version exemption is matched against the *actual alias manifest*, not the requested name.

### packages/boot/plugin-manager/tests/official-install-target.spec.ts
- Purpose: source-checkout detection and refusal.
- Edge cases / failure handling: a missing, duplicated, private, version-mismatched, unbuilt or patch-less workspace package each has its own message; a symlinked Desktop runtime path is followed.

### packages/boot/plugin-manager/tests/operation-logs.spec.ts
- Purpose: the pnpm log file descriptor is released on the failure path.
- Non-obvious design decisions: the test asserts `fstatSync(fd)` throws `EBADF` after a manifest parse failure — a leaked descriptor would keep the file open.

### packages/boot/plugin-manager/tests/operations-process.spec.ts
- Purpose: the bounded drain and the tree stop against real child processes.
- Non-obvious design decisions: a child that exits immediately while its descendant inherits both pipes defeats execa's promise, so only the bounded drain saves the caller; a stalled child is ended by the silence bound.

### packages/boot/plugin-manager/tests/operations.spec.ts
- Purpose: the CLI and manager share package reconciliation, path anchoring and diagnostics.
- Non-obvious design decisions: a frozen-lockfile repair run is a *separate* invocation; the pre-install `pnpm view` lookup is its own invocation; the installed-package compatibility check covers `dependencies`, `devDependencies` and `optionalDependencies`, and a nested bundle's own scoped component is checked too.

### packages/boot/plugin-manager/tests/package-reload.spec.ts
- Purpose: GUI package operations around activation and disposal.
- Non-obvious design decisions: a shared dependency **survives** the removal of its first declaring bundle (the declarer changes, the package stays); a removal publishes the resolution **twice** — once when its plugins stopped, once after pnpm removed the package; a reinstallation that cannot compare loaded module files reports `restart-required` with reason `module-comparison`.

### packages/boot/plugin-manager/tests/patch.spec.ts
- Purpose: the enablement edits preserve user-authored syntax and are idempotent.
- Edge cases / failure handling: a switch whose anchor or alias other entries reference is kept; an override that asserts a different module name is not matched.

### packages/boot/plugin-manager/tests/registry.spec.ts
- Purpose: the registry plan and failure attribution, purely table-driven.
- Non-obvious design decisions: "A public mirror picked over a private default is asked alone: the private registry is not a fallback for it."

### packages/boot/plugin-manager/tests/run-tree.spec.ts
- Purpose: group leadership per execution mode and platform.
- Edge cases / failure handling: the wait bound is an **input** so the test needs no fake timers ("fake timers leak into the suites sharing the worker").

### packages/boot/plugin-manager/tests/tools.spec.ts
- Purpose: the agent tool's denial and guidance.
- Non-obvious design decisions: in `read-only` and `workspace-write` modes every action is denied **and the manager is never called** (`expect(method).not.toHaveBeenCalled()`).

### packages/boot/plugin-manager/tsconfig.json
- TypeScript project referencing 19 sibling projects.

### packages/boot/plugin-market/package.json
- Manifest: exports `./types`, `./tools`, `./typert`, `./remote`; the `dsh-settings` peer is **optional** (the service mounts without it, and `setIndexes` then fails with `plugin-market/settings-unavailable`).

### packages/boot/plugin-market/README.i18n.yaml
- 18 per-heading en/zh hashes.

### packages/boot/plugin-market/README.md
- Purpose: read the market indexes the user configures.
- Non-obvious design decisions: **no index source is configured by default, so the Host sends no market request until a user adds one**; `search` accepts only a configured URL, "so the service never fetches an arbitrary address"; the `indexes` field is **volatile** so Discover, Settings and `setIndexes` change it without remounting the service or plugin-manager.
- Edge cases / failure handling: measured limits are stated — a synthetic 20,000-plugin index costs ~0.8 s of build and ~130 MiB of heap, and receiving the validated index still blocks the Host event loop for ~35 ms (7.6 MiB) to ~190 ms (38 MiB) during the structured clone, "Larger markets need a server-side query protocol." Redirects are refused; pages can change after another read replaces the document.

### packages/boot/plugin-market/README.zh.md
- Chinese mirror; English read in full, first 20 lines of this read.

### packages/boot/plugin-market/src/index-url.ts
- Purpose: validate and normalize one index source URL.
- Non-obvious design decisions: the refusal carries a machine-readable `reason` (`not-absolute`, `scheme`, `credentials-or-fragment`).

### packages/boot/plugin-market/src/index.ts
- Purpose: the market service.
- Key abstractions: `Config { indexes: Volatile<string[]>, fetchTimeoutMs, maxBytes, cacheTtlMs }`; the Remote methods `listIndexes`, `setIndexes`, `search`; the `plugin-market/changed` event.
- Data flow: configured URL → fetch (deadline + byte cap) → parse in a Worker → cache → search/annotate.
- Non-obvious design decisions: `causeChainOf` walks up to **4** causes ("a Node `fetch` failure is a bare `fetch failed` whose reason is its cause") and cuts a deeper or cyclic chain there. The cache stores a successful document with its `fetchedAt`; a later page can be answered from the *pinned* document even after the TTL, until another read replaces it. `compatibilityOf` reuses the app-boot compatibility evaluator so the market and the installer cannot disagree.
- Edge cases / failure handling: `maxBytes` defaults to 128 MiB; the service never fetches an unconfigured URL.

### packages/boot/plugin-market/src/parse-thread.ts
- Purpose: run the index parse in a fresh Worker Thread.
- Key abstractions: `parseIndexInWorker(body, url, signal)`; `workerSpawn()` chooses the bundled `worker.cjs` or a tsx bootstrap data URL.
- Data flow: body buffer → transferred `workerData` → structured-cloned result.
- Non-obvious design decisions: the body buffer is **transferred**, so it is unusable afterwards. The settle helper ignores a termination failure ("The outcome stands whether or not termination succeeds"), and the first message wins over a later exit.
- Edge cases / failure handling: an unexpected message shape is refused ("index parser reported an unexpected value"); an exit without a result reports the exit code.

### packages/boot/plugin-market/src/parse.ts
- Purpose: decode, parse and validate one index body.
- Key abstractions: `IndexParseResult` (`ok: true` with the index, or `ok: false` with path/reason/message).
- Non-obvious design decisions: the decoder is **fatal** UTF-8, and `$` covers both the UTF-8 and JSON errors, so the caller has one path to report.

### packages/boot/plugin-market/src/search.ts
- Purpose: filter, fuzzy-match and order one index's plugins.
- Key abstractions: `MarketSearch`; `searchTerms`; `SearchDocument`.
- Data flow: query → MiniSearch → positions → filters → order.
- Non-obvious design decisions: text is NFKC-normalized and split into CJK **overlapping character pairs** plus the run's last character, "so a query matches without word segmentation and every character of the run starts some term". Fuzzy distance is one fifth of the term length rounded, capped at 2, and disabled for terms shorter than 4. `combineWith: 'AND'` — every word must match. The index is built in chunks of 500 plugins so the event loop yields.
- Edge cases / failure handling: a sort key a plugin does not declare sorts after all others in either direction.

### packages/boot/plugin-market/src/tools.ts
- Purpose: the read-only `plugin_market` agent tool.
- Key abstractions: `pageOf` (offset ≥ 0, limit 1..100), `paged`, `english`, `untilAborted`.
- Non-obvious design decisions: market-supplied text is capped at **300 UTF-16 code units** with an ellipsis, "so one entry cannot dominate the result"; only the English variant is returned to the model. The tool is registered only while the `pluginMarket` service is mounted, so a preset can keep the row without the tool appearing.

### packages/boot/plugin-market/src/types.ts
- Purpose: the JSON-safe records and the `RemoteErrorDetailsMap` extension.
- Non-obvious design decisions: every market error has a **machine-readable reason** in its details (`url`, `path`, `field`, `reason`), so the client does not have to parse prose.

### packages/boot/plugin-market/src/worker.ts
- Purpose: the Worker entry.
- Non-obvious design decisions: the request shape is validated before parsing ("index parser request is malformed"), so a malformed `workerData` is a clean error rather than a confusing parse failure.

### packages/boot/plugin-market/tests/built-worker.e2e.ts
- Purpose: a built-artifact guard.
- Non-obvious design decisions: it runs the published `lib/index.js` under **plain node** with `NODE_PATH` and `NODE_OPTIONS` cleared, "and the Worker bundle alone parses bodies outside any `node_modules`" — it is skipped until a build produces both artifacts.

### packages/boot/plugin-market/tests/configuration.spec.ts
- Purpose: index sources persist through the profile and Settings.
- Non-obvious design decisions: the service is **not remounted** (the same entry fiber survives a `setIndexes`), the `plugin-market/changed` event fires once, and the list is restored at restart.

### packages/boot/plugin-market/tests/fixtures/market.patch.yml
- A fixture patch inserting the config-editor, settings, plugin-manager and plugin-market rows with one configured index URL.

### packages/boot/plugin-market/tests/market-parse-failure.spec.ts
- Purpose: a parse Worker crash surfaces as `plugin-market/fetch-failed`.
- Non-obvious design decisions: the crash reason is carried in the details, not flattened to "invalid index".

### packages/boot/plugin-market/tests/market.spec.ts
- Purpose: the market service's behaviour.
- Non-obvious design decisions: a page pinned by `fetchedAt` is answered from the cached document even after the TTL; a new document within the same millisecond gets a **new** `fetchedAt` (1000 → 1001), so a pinned reader can tell the documents apart.

### packages/boot/plugin-market/tests/parse-thread.spec.ts
- Purpose: the Worker lifecycle with a scripted Worker.
- Edge cases / failure handling: a termination failure still settles the promise.

### packages/boot/plugin-market/tests/parse-worker.spec.ts
- Purpose: the source-mode Worker end to end.
- Non-obvious design decisions: the test asserts the transferred body is now zero-length, proving the transfer happened.

### packages/boot/plugin-market/tests/parse.spec.ts
- Purpose: the body parser.
- Non-obvious design decisions: relative icons resolve against the index URL.

### packages/boot/plugin-market/tests/tools.spec.ts
- Purpose: the listing tool over the same service the Discover page uses.
- Non-obvious design decisions: the tool appears and disappears with the service (`vi.waitFor` on `ctx.tools.get('plugin_market')`).

### packages/boot/plugin-market/tsconfig.json
- TypeScript project referencing cordis, loader, schemastery, app-boot, plugin-manager, the market-index utility, package-manifest, timeout, values, settings, the typert protocol and core/tools.

### packages/boot/plugin-market/tsdown.config.ts
- Build config: the service as ESM, the parse Worker as a **separate CJS bundle carrying its whole closure**, "The Worker starts without the parent's profile resolver".

### packages/boot/README.i18n.yaml
- 7 per-heading en/zh hashes.

### packages/boot/README.md
- Group doc mapping the six boot packages to their ctx keys: `cmdlineArgs`/`appExit`, `hmr`, `configEditor`, `pluginManager`, `pluginMarket`.

### packages/boot/README.zh.md
- Chinese mirror; English read in full, first 30 lines of this read.

### packages/bundle/acp-app/cordis.patch.yml
- The ACP patch: persona, `session-title-llm` disabled, HMR disabled, and the startup provider + ACP row. The ACP row `inject: [acpAppStartup]`, so "help starts no transport".

### packages/bundle/acp-app/package.json
- Manifest declaring `dsh.bundle.patch: ./cordis.patch.yml` and depending on `dsh-acp`, `dsh-cmdline` and commander.

### packages/bundle/acp-app/README.i18n.yaml
- 19 per-heading en/zh hashes.

### packages/bundle/acp-app/README.md
- Doc for the ACP surface: stdout belongs to ACP; the bridge starts only after the startup provider accepts the invocation; session titles are disabled because ACP exposes no title surface; configuration changes require a restart because the bundle disables HMR in YAML "so one stdio connection never observes a replacement bridge or Agent dependency".

### packages/bundle/acp-app/README.zh.md
- Chinese mirror; English read in full, first 15 lines of this read.

### packages/bundle/acp-app/src/index.ts
- Purpose: the ACP startup provider.
- Key abstractions: `ACP_APP_STARTUP_SERVICE = 'acpAppStartup'`; `inject = ['cmdlineArgs']`.
- Data flow: parse → action → bind stdin EOF → publish `{ accepted: true }` → the ACP row activates.
- Non-obvious design decisions: the provider publishes readiness **inside the commander action**, so a `--help` (which never runs the action) starts no transport and publishes nothing.

### packages/bundle/acp-app/tests/acp-app.spec.ts
- Tests the declared patch: HMR and session titles disabled, the ACP row injecting `acpAppStartup` with the shipped provider and model.

### packages/bundle/acp-app/tests/startup.spec.ts
- Tests readiness + bounded exit on EOF, and that `--help` prints help without publishing readiness or binding stdin.

### packages/bundle/acp-app/tsconfig.json
- TypeScript project referencing cordis and the cmdline package.

### packages/bundle/base/cordis.patch.yml
- Purpose: the shared core — one insert over the empty profile root, ~100 rows.
- Key abstractions: rows by id (`llm`, `session`, `agent`, `agent-loop`, `tools`, `sandbox-policy`, `fs-sandbox`, `compaction-basic`, `tool-subagent`, `llm-deepseek`, `agent-default-model`, `session-telemetry-otel`, …).
- Data flow: the launcher composes this layer first; every later bundle and the user's patch address rows by id.
- Non-obvious design decisions: **"A patch replaces the targeted row's whole `config` rather than merging into it, so a row whose value differs by mode does NOT live here: it belongs to each mode bundle, keeping any single row down to one bundle layer plus the user's."** Row order carries no load semantics — "activation is service-availability driven". `hmr` is enabled with `root: []` — profile configuration reloads by default, module roots are opt-in. `plugin-manager` and `hmr` are gated on `!!js "!ctx.get('profileContext')"`. The DeepSeek adapter row inlines **no** key or endpoint: both resolve per request from the `llm-deepseek:` settings section.
- Edge cases / failure handling: the telemetry row's mode defaults to `FEEDBACK_ONLY` through a `!!js` expression, so it is a deployment choice, not a build-time constant.
- Surprising: `agent-default-model` names `deepseek-official` / `deepseek-flash` as the transport-independent default, and the `tools` row carries `personaPrefix` semantics through the preset layer instead.

### packages/bundle/base/package.json
- Manifest: ~100 workspace dependencies **are** the shipped core plugin set; `dsh.bundle.patch: ./cordis.patch.yml`.

### packages/bundle/base/README.i18n.yaml
- 21 per-heading en/zh hashes.

### packages/bundle/base/README.md
- Doc for the shared core.
- Non-obvious design decisions: OTel session upload defaults to `FEEDBACK_ONLY` for all users — "new text feedback, message ratings, edits, and withdrawals release the complete canonical prefix through that event, including context. Later records wait for the next explicit feedback; sending an authorized batch needs no further interaction or model call." The `subagent`/`subagent_fork` tools "create managed children and return a child id immediately". A default that differs between the web GUI and headless mode lives in that surface's bundle, not in the shared core. Adding the plain filesystem provider on top of the sandboxed one fails the profile — the two register the same service.
- Edge cases / failure handling: `workspace-write` confines writes to the workspace plus the session's own temp subdirectory (`<temp>\dsh-<hash>`, TMP/TEMP rewritten for confined children); `read-only` grants nothing.

### packages/bundle/base/README.zh.md
- Chinese mirror; English read in full, first 15 lines of this read.

### packages/bundle/base/src/index.ts
- Nine lines, no runtime API. "The package's substance is `cordis.patch.yml`".

### packages/bundle/base/tests/base.spec.ts
- Purpose: the base patch is the substance of the bundle.
- Non-obvious design decisions: the platform gating test evaluates each row's `!!js` disabled expression under a **platform-scoped `with` scope** that shadows the global `process`, "so both outcomes pin on every host" — the bash and pwsh twins carry the same platform fact inverted, so exactly one shell stack mounts per host. The test also asserts no separate `windows.cordis.patch.yml` ships.

### packages/bundle/base/tests/fixtures/root.cordis.yml
- One line: an empty root entry list.

### packages/bundle/base/tsconfig.json
- TypeScript project referencing cordis, the config-editor and settings projects.

### packages/bundle/headless/cordis.patch.yml
- The one-shot patch: persona, the `DSH_TOOLS_MODE` PTC env seam, the startup provider and runner rows (`task: !!js ctx.headlessStartup.task`), HMR disabled, and the managed credential store, authorization and DeepSeek account rows **disabled** ("One-shot jobs use launch-time credentials instead of the interactive store").

### packages/bundle/headless/package.json
- Manifest declaring the bundle patch and a `./startup` export; `dsh-subagent` is an optional peer.

### packages/bundle/headless/README.i18n.yaml
- 26 per-heading en/zh hashes.

### packages/bundle/headless/README.md
- Doc for one-shot mode.
- Non-obvious design decisions: exit code 0 means the task completed, 1 means it aborted or errored. The credential chain is launch env → `<invocation cwd>/.env` → `$DSH_HOME/.env`, and "an exported empty value shadows that fallback". Adoption of `--session-id` is **cwd-, ownership- and preset-scoped**: it refuses a Session recorded in another working directory, one that recorded no working directory, one that is a subagent or forked session, or one whose preset record is malformed — and it refuses an identity already live in the process, "because the runner cannot own an exclusive run interval over it".
- Edge cases / failure handling: the JSON stream caps every string except the terminal `final` at 8 KiB and omits unmodelled events, "so it is not a lossless copy of the Session log".

### packages/bundle/headless/README.zh.md
- Chinese mirror; English read in full, first 15 lines of this read.

### packages/bundle/headless/src/index.ts
- Purpose: the one-shot direct Agent driver.
- Key abstractions: `name = 'headless-runner'`, `inject = ['agentDefaultModel', 'agents', 'sessions']`; `Config { task?, sessionId?, json? }`.
- Data flow: create or adopt an Agent → drive it to quiescence → summarize the owned interval from the durable Session → print the final text (or project the JSON stream) → exit.
- Non-obvious design decisions: the summary is read from the **durable Session** (`session.eventAt`), not from live state, so the printed answer is what the log holds. Reasoning deltas stream to stderr under a `dsh: reasoning:` heading. `appExit` is read through `ctx.get('appExit')` — "the global service store, not the property proxy: appExit is an optional host value, never an injected dependency" — and the runner **fails loud** without it.
- Edge cases / failure handling: an event below the captured Session length that cannot be read is a hard failure with a diagnostic naming the seq and the captured length; a turn that ends in error prints `dsh: <code>: <message>` and exits 1.

### packages/bundle/headless/src/json-stream.ts
- Purpose: the `--json` run projection.
- Key abstractions: `projectJsonRun(ctx, agent, sink, options)` → `{ finish, dispose }`; `boundJsonLine`; `MAX_STRING_BYTES = 8 KiB`, `MAX_EVENT_BYTES = 32 KiB`, `MAX_DEPTH = 64`.
- Data flow: `session/event` → a projected line → stdout.
- Non-obvious design decisions: **"Every projected event is a commit point: text and reasoning come from committed `assistant/message` content, never from a live attempt that may still be retried or discarded, so the stream never carries content the durable log does not contain."** The depth cap exists because "A legal but pathologically deep argument would otherwise recurse until the stack overflows, and the isolated listener would silently drop the event". A null prototype is used when building payload objects so a literal `__proto__` key cannot pollute. The terminal `final` is explicitly **not** truncated: "The answer is the lossless terminal contract".
- Edge cases / failure handling: events from another Session are ignored; after `dispose()` nothing is written.

### packages/bundle/headless/src/runner-internals.ts
- Process streams the runner reads and writes, kept out of the package entry "so substituting them in tests adds no public package API".

### packages/bundle/headless/src/startup-internals.ts
- Process facts the startup provider reads, likewise out of the public entry.

### packages/bundle/headless/src/startup.ts
- Purpose: the one-shot command-line provider.
- Key abstractions: `HEADLESS_STARTUP_SERVICE = 'headlessStartup'`; `HeadlessStartupValues { task?, sessionId?, json }`.
- Data flow: parse → action → publish → the runner row's `!!js` config reads it.
- Non-obvious design decisions: `jsonRequested(argv)` scans the **raw** arguments and stops at `--`, skipping a `--session-id` value, "so a literal `--json` used as an option value or a positional never installs the JSON error override". In JSON mode `program.error` is overridden to emit a bounded `{"type":"error"}` line to stdout and then throw the same `CommanderError` — "a `--json` caller still owes the error event", and commander's own print of the message is suppressed so stderr keeps only `dsh:` diagnostics. A SessionId is opaque: emptiness is checked on the trimmed value but the **exact** string is handed to the runner.
- Edge cases / failure handling: a missing task on an interactive stdin is a usage error, so on rejection (and on `--help`) nothing is provided.

### packages/bundle/headless/tests/fixtures/provider-cwd.ts
- A read-only POSIX filesystem fixture provider whose execution coordinates differ from the host's, so host and provider paths never coincide.

### packages/bundle/headless/tests/headless.spec.ts
- Purpose: the one-shot driver's behaviour.
- Non-obvious design decisions: the assistant-stream frame protocol (`start`/`chunk` with `attemptId`, `revision`, `index`) is exercised, so the projection's commit-point rule is tested against real frames. A terminal model failure is separated from an **unterminated reasoning prefix** — stderr shows `dsh: reasoning:\ntrying recovery` and then `dsh: SERVER: provider unavailable`.

### packages/bundle/headless/tests/json-stream.spec.ts
- Purpose: commit-point emission, ordering, bounding and disposal.
- Non-obvious design decisions: a discarded attempt's usage sample is never emitted (the projection reads committed content only).

### packages/bundle/headless/tests/startup.spec.ts
- Purpose: the one-shot command provider over a real Loader tree.
- Non-obvious design decisions: the fixture writes a `startup.mjs` that delegates to the source-plane plugin already imported by the test, because Node imports the fixture row outside Vite's source resolver.

### packages/bundle/headless/tests/terminal-failures.spec.ts
- Purpose: exit status after parent summaries fail outside a durable terminal.
- Non-obvious design decisions: exactly **one** `agent/error` is reported and the run exits 1; in JSON mode the last event is the error and there is **no** `final`; a failure that later recovers is accepted with exit 0.

### packages/bundle/headless/tsconfig.json
- TypeScript project referencing cordis, loader, schemastery, agent, agent-default-model, llm, session, cmdline, session-query, fs and subagent.

### packages/bundle/README.i18n.yaml
- 7 per-heading en/zh hashes.

### packages/bundle/README.md
- Group doc: `web`, `headless`, `acp` and `sdk` build on `dsh-base`; `sdk-minimal` supplies its complete tree in one bundle. "In-box bundles resolve from the dsh installation; out-of-tree bundles install into a profile through `dsh plugin --profile <name> add <package>`."

### packages/bundle/README.zh.md
- Chinese mirror; English read in full, first 15 lines of this read.

### packages/bundle/sdk-app/cordis.patch.yml
- The SDK patch: persona, session titles and HMR disabled, the startup provider and JSON-RPC server rows, and the `workspace-dependencies` / `skill-office` rows gated on `DSH_PRIMARY_RUNTIME ?? DSH_BUNDLED_PRIMARY_RUNTIME` (an empty-string opt-out).
- Non-obvious design decisions: `maxTokensAsSuccess` is itself a `!!js` expression over an env var, so a deployment can flip the SDK's mapping of a token-limited subagent completion between "accepted" and "error" without a rebuild.

### packages/bundle/sdk-app/package.json
- Manifest declaring the bundle patch; depends on the SDK server, cmdline, schemastery, commander, the Office skill and the workspace-dependency tool.

### packages/bundle/sdk-app/README.i18n.yaml
- 15 per-heading en/zh hashes.

### packages/bundle/sdk-app/README.md
- Doc for the SDK profile.
- Non-obvious design decisions: stdout is reserved for newline-delimited JSON-RPC frames; the SDK uses the base `read`/`write`/`edit` defaults and **omits** `str_replace_editor`; the bundled Office skills and authoring resources are gated on the packaged primary runtime, and each row can be patched independently.

### packages/bundle/sdk-app/README.zh.md
- Chinese mirror; English read in full, first 15 lines of this read.

### packages/bundle/sdk-app/src/index.ts
- The SDK startup provider, with a `Config { profile?: string }` (default `sdk`) rendered into the help grammar.

### packages/bundle/sdk-app/tests/sdk-app.spec.ts
- Tests the declared patch, including that the JSON-RPC row injects both `sdkAppStartup` and `loader`.

### packages/bundle/sdk-app/tests/startup.spec.ts
- Tests readiness + bounded exit, help that starts no transport, and the selected profile name in help.

### packages/bundle/sdk-app/tsconfig.json
- TypeScript project referencing cordis, schemastery and the cmdline package.

### packages/bundle/sdk-minimal/cordis.patch.yml
- The standalone minimal profile's **complete** tree in one insert (35 rows, no base bundle).
- Non-obvious design decisions: the file tools are reduced to `readImage` only (`read: false, write: false, edit: false`); the system prompt drops the harness identity and the runtime context (`includeHarnessIdentity: false, includeRuntimeContext: false`); the sandbox policy is `danger-full-access` with `workspaceRoot: process.cwd()`; exactly one persistent shell stack is mounted, the other platform's rows disabled; sessions persist as **uncompressed** JSONL (`compression: none`); `llm-deepseek` sets `defaultContextWindow` from `DSH_CONTEXT_WINDOW` and a two-day `streamIdleTimeoutMs`.
- Edge cases / failure handling: the comment says "Keep the minimal agent kernel explicit: unlike dsh-base, this profile owns each service row and omits every optional producer it does not use."

### packages/bundle/sdk-minimal/package.json
- Manifest: its dependencies are exactly the packages its rows name (a test enforces the equality).

### packages/bundle/sdk-minimal/README.i18n.yaml
- 18 per-heading en/zh hashes.

### packages/bundle/sdk-minimal/README.md
- Doc for the standalone minimal profile.
- Non-obvious design decisions: it excludes base, Web, settings, managed credentials, telemetry, text file tools, workspace instructions, skills, jobs and subagents; "Its danger-full-access policy lets the shell modify any path available to the process, so use it only with an isolated workspace." Image reading requires an image-capable model — text-only routes return a tool error.

### packages/bundle/sdk-minimal/README.zh.md
- Chinese mirror; English read in full, first 15 lines of this read.

### packages/bundle/sdk-minimal/src/index.ts
- Nine lines, no runtime interface.

### packages/bundle/sdk-minimal/tests/sdk-minimal.spec.ts
- Purpose: the exact ordered row list and the environment-backed defaults.
- Non-obvious design decisions: the test asserts `Object.keys(manifest.dependencies).sort()` equals the set of packages the rows name — so a dependency the tree does not use, or a row whose package is not a dependency, is a failure.

### packages/bundle/sdk-minimal/tsconfig.json
- TypeScript project referencing only the vendored cordis project.

### packages/bundle/web-app/cordis.patch.yml
- The browser-surface patch (589 lines).
- Non-obvious design decisions: `session-query-sqlite` is overridden to `path: ':memory:'` with `openAt: never` — "This restatement keeps the Web values on one ephemeral in-memory index; a deployment enabling content search overrides `openAt` to `first-search` in a later patch layer, which defers the node:sqlite import and in-memory handle to the first search so Node 22 startup stays quiet." The base's per-agent tool rows are **disabled** in the web patch ("the agent plane moves behind presets"), and the four delegation tools are denied in the presets "so a delegated child's scope never lists them". The preset registry row names `standard` as the default. Telemetry and product-analytics rows are disabled unless the profile is `desktop`.
- Edge cases / failure handling: the `DSH_TOOLS_MODE` env seam is marked TEMPORARY and is to be removed "once the web UI owns the choice per session".

### packages/bundle/web-app/locale/en.json
- English locale stub: `meta.title` only.

### packages/bundle/web-app/locale/startup/en.json
- English locale stub for the `web-app/startup` entry: `meta.title` only.

### packages/bundle/web-app/locale/startup/zh.json
- Chinese locale for the `web-app/startup` entry: `meta.title` only.

### packages/bundle/web-app/locale/zh.json
- Chinese locale: title and a one-line description.

### packages/bundle/web-app/package.json
- Manifest: `dsh.bundle.patch` lists **five** files — the web patch and the four preset patches, in order — and the dependencies are the whole browser roster (~130 packages).

### packages/bundle/web-app/presets/cordis.patch.yml
- The `cordis` preset: an ordered plugin list with a plan-mode group and a compaction group.
- Non-obvious design decisions: the plan-mode prompt says **"The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged."** — the tool list is deliberately *not* reduced in plan mode.

### packages/bundle/web-app/presets/minimal.patch.yml
- The `minimal` preset: fixed persona, `read_image` only, a compaction group and a platform-selected persistent shell group with per-tool descriptions.

### packages/bundle/web-app/presets/ptc.patch.yml
- The `ptc` preset: the standard roster plus the PTC tool-presentation row (`mode: ptc`), with the workflow rows disabled.

### packages/bundle/web-app/presets/standard.patch.yml
- The `standard` preset (order 1, the shipped default).
- Non-obvious design decisions: the compaction group carries `isolate: { compaction: true, toolResultPruner: true }` and the pruner's `thresholdChars: 8192, headChars: 4096, tailChars: 1024`; the delegation group carries `isolate: { workflowEngine: true }`.

### packages/bundle/web-app/README.i18n.yaml
- 28 per-heading en/zh hashes.

### packages/bundle/web-app/README.md
- Doc for the browser surface.
- Non-obvious design decisions: **a wildcard `--host` is rejected** ("binding every interface would expose remote code execution to the network; bind one concrete IPv4 or IPv6 address instead"). The advertised `--public-url` "grants no trust": the browser-visible authority must also be named with `--trusted-host`. An IPv6 zone id cannot appear in a URL, so a redundant loopback zone is dropped while a non-loopback zone requires an explicit `--public-url`. The launch token appears in the printed/opened URL but "never appears in the model context or in `DSH_WEB_URL`". "The URL line and browser handoff are readiness signals" — both run only after the Loader tree settles, the required-startup audit passes and Connection authentication is available; optional plugin failures do not suppress readiness, but a required startup failure or a tree disposed mid-boot announces nothing.
- Edge cases / failure handling: a browser that cannot be opened prints a credential-free diagnostic to stderr and the server keeps running; `BROWSER` overrides only come from the inherited environment, "a discovered `.env` cannot set `BROWSER`".

### packages/bundle/web-app/README.zh.md
- Chinese mirror; English read in full, first 15 lines of this read (the desktop-analytics policy).

### packages/bundle/web-app/src/index.ts
- Purpose: the browser-surface glue plugin.
- Key abstractions: `webApp.getAdvertisedUrl()`; `Config { openBrowser, printUrl, surfaceContext, publicUrl? }`; the `web-app` plugin name.
- Data flow: dist resolution → static fallback owner → the `DSH_WEB_URL` bash variable → the URL line → the browser handoff → the `webApp` service.
- Non-obvious design decisions: the URL line and browser handoff wait for the Loader tree to settle **and** for the startup audit to pass; the tree can be disposed mid-boot, in which case "a URL line or browser tab for a dead server would only mislead, and reading torn-down services would turn a clean shutdown into a crash" — so readiness is not announced. An SSH launch suppresses the browser handoff (the remote host cannot reach the user's screen). The advertised URL carries the launch token; the agent-facing context and the bash variable do not.
- Edge cases / failure handling: a non-loopback plain-HTTP bind emits an exposure warning.

### packages/bundle/web-app/src/public-url.ts
- Purpose: parse the advertised public root.
- Non-obvious design decisions: it rejects hazards WHATWG URL parsing accepts on its own — whitespace/control characters, a query or fragment, an empty authority (`https://` / `https:///ui`), and credentials — and normalizes the path to end in `/`.

### packages/bundle/web-app/src/startup.ts
- Purpose: the web command-line provider.
- Key abstractions: `WEB_STARTUP_SERVICE = 'webStartup'`; `WebStartupValues { openBrowser, host?, port?, publicUrl?, trustedHosts, tls? }`.
- Data flow: parse → validate → publish → the webserver / web-runtime / connection rows read it through `!!js` config.
- Non-obvious design decisions: a wildcard host is refused with the RCE rationale; `--port` must be digits; `--tls-cert` and `--tls-key` must be supplied **together**; the flags are validated *before* the service is provided, so no consumer row activates on a bad invocation.

### packages/bundle/web-app/tests/browser-defaults.spec.ts
- Purpose: the Browser sidebar row's availability.
- Non-obvious design decisions: the Browser row is enabled only in the `desktop` profile; an explicit patch override always wins, and the row is mounted as a source-plane builtin so no native package resolution is needed.

### packages/bundle/web-app/tests/browser-open.spec.ts
- Purpose: the default-browser handoff over a real Loader tree and a listening server.
- Non-obvious design decisions: the browser is opened only after the page is **actually reachable** (the test fetches the URL and asserts HTTP 200), and the opened URL carries the fixture token.

### packages/bundle/web-app/tests/document-conversion.e2e.ts
- Purpose: one shared office-to-pdf row converts bytes without presentation plugins.
- Non-obvious design decisions: the cached PDF bytes are **caller-owned** — the test fills one result with zeros and mutates the other result's `missingFonts` array, and the cache still returns the pristine copy. After disposal the provider refuses with `code: 'unavailable'`.

### packages/bundle/web-app/tests/document-preview.spec.ts
- Purpose: the Office provider and the Document Preview client keep independent configuration.
- Non-obvious design decisions: a symlinked source is refused with `workspace-file/not-regular-file`; the PDF output stays session-authorized.

### packages/bundle/web-app/tests/fixtures/document-conversion.docx
- **Skipped** — see the "Files skipped" section.

### packages/bundle/web-app/tests/product-analytics.spec.ts
- Purpose: Desktop-only collection and bounded shutdown.
- Non-obvious design decisions: the policy switch flips without remounting either fiber (`entry.fiber === telemetryFiber`), and the collector's own timeouts are pinned (`scheduledDelayMillis: 30000, timeoutMillis: 15000, exportTimeoutMillis: 20000, shutdownTimeoutMillis: 2000`).

### packages/bundle/web-app/tests/public-url.spec.ts
- Purpose: the advertised-root contract.
- Non-obvious design decisions: one row per rejection branch, and the comment records the order ("the whitespace check precedes the scheme check").

### packages/bundle/web-app/tests/startup.spec.ts
- Purpose: the web command provider over a real Loader tree.
- Non-obvious design decisions: the consumer's config reads `ctx.webStartup` directly, so the injection ordering is exercised for real; an invalid flag leaves the consumer unstarted and exits 1.

### packages/bundle/web-app/tests/web-app.spec.ts
- Purpose: URL publication, exposure warnings, readiness and the browser handoff.
- Non-obvious design decisions: `::127.0.0.1` is **not** loopback (it names the IPv6 address `::7f00:1`), so it gets the exposure warning; a non-loopback bind carrying an interface zone id refuses its own activation unless an explicit `--public-url` is declared; readiness is published **once** even when Connection reloads.

### packages/bundle/web-app/tsconfig.json
- TypeScript project referencing cordis, schemastery, loader, app-boot, cmdline, the connection, frontend-static, webserver, launch-environment, shell-env and subprocess projects.

## Ideas worth stealing

- **Project a config schema to JSON Schema without executing the validators, and make the uncertainty explicit** - `packages/boot/app-boot/src/config-schema/projector.ts:14` - `ConfigProjection` carries `acceptsMissing: boolean | 'unknown'` plus a `limitations: string[]`, and every node tracks `effectful` (a transform/loose callback may change validation) and `mutating` (native resolution may write adapted values into the input before a later union branch reads it). August's settings panel and API already derive fields from schemas; a projection that says "unknown" instead of inventing a default is what stops the panel from offering a value the backend refuses. Unions become `anyOf`, never `oneOf`, because Schemastery unions select the *first successful branch* and overlapping branches are legal.

- **Refuse to emit a regex constraint you cannot faithfully express, rather than emit a wrong one** - `packages/boot/app-boot/src/config-schema/pattern.ts:46` - `createPatternCheck` parses the pattern twice (Unicode and non-Unicode) with regexpp and only accepts it when the two ASTs are structurally identical *and* every alternative is BMP-only and free of broad sets that could observe a surrogate pair's midpoint. A negated broad set (`[^x]`) is rejected while a positive one (`\S`) is allowed, because the latter only asks whether *a* matching character exists. Transferable directly: August's tool schemas carry regex validators, and a naive copy into a JSON Schema silently changes what the model is allowed to send.

- **Refuse a plugin by rewriting the launcher's own composition, never the user's files** - `packages/boot/app-boot/src/compatibility-preflight.ts:74` - a denied ordinary row gains `disabled: true` in the launcher's copy of the tree; a native `Include` that reaches a denied plugin is dropped as a whole, "because its file is never rewritten"; the profile patch, dependency manifest and bundle list are untouched. August's plugin/skill loading could adopt this so a version-incompatible plugin is never imported, without the user's configuration being mutated by the refusal.

- **Make the exemption file separate from every file it would otherwise touch** - `packages/boot/app-boot/src/profile-compatibility.ts:10` - exact `package-name@version` → exact-runtime-version grants live in the profile's own `compatibility.json`, so granting one never touches the dependency manifest, the bundle list or the patch file; neither a plugin upgrade nor a DSH upgrade inherits a grant; and a file the reader could not fully parse becomes **read-only** rather than being silently overwritten. The "read-only rather than discard the user's content" rule is the part worth stealing.

- **Distinguish "cannot express" from "must not express"** - `packages/boot/app-boot/src/plugin-compatibility.ts:55` - `engines.dsh` decides alone when present (peers ignored); otherwise every `@deepseek-ai/dsh*` peer must match. Prereleases participate in ranges; `workspace:^` peers mean the current runtime; **empty and invalid ranges are unmet** (fail closed) while a `workspace:` value in `engines.dsh` is invalid. This is the shape August needs for "which agent/extension protocol versions can this install talk to".

- **One queue for every reload, and nesting is an error** - `packages/boot/hmr/src/index.ts:268` (the `runExclusive` method) and `packages/boot/hmr/tests/coordination.spec.ts:37` - module replacement, Include refresh, profile recomposition and config edits all go through one `runExclusive` queue; a nested `runExclusive` is refused with "cannot be nested"; the queue stays usable after a failure; **package installation runs outside the queue**. August's HMR/agent-reload path would benefit from the same single-queue discipline: a config edit that races a module replacement is the classic source of a half-applied tree.

- **Every projected event is a commit point** - `packages/bundle/headless/src/json-stream.ts:1` - text and reasoning come from *committed* `assistant/message` content, "never from a live attempt that may still be retried or discarded, so the stream never carries content the durable log does not contain." Alongside it: a per-string 8 KiB cap, a **depth cap of 64** ("a legal but pathologically deep argument would otherwise recurse until the stack overflows, and the isolated listener would silently drop the event"), a null-prototype payload so a literal `__proto__` key cannot pollute, and an explicitly untruncated terminal `final` ("the answer is the lossless terminal contract"). This is a directly reusable recipe for any streaming JSON surface August exposes.

- **Detect a changed file by identity, not by mtime alone, and read the clock from the filesystem** - `packages/boot/hmr/src/module-files.ts:11` and `:50` - identity is `ino:size:mtimeMs`; change time is deliberately excluded because "creating a hard link to a file, as pnpm does when it imports from its store, changes it without changing content"; and the comparison clock is the mtime of a freshly written marker file, because "the system clock and file timestamps can differ by a clock tick in either direction". A 2 s allowance covers FAT's timestamp granularity. Transferable to any watcher in August that must decide "did this file really change?".

- **Watch exactly one file, not its directory** - `packages/boot/hmr/src/watch-config.ts:38` - the watcher resolves the nearest existing ancestor, watches that root with a depth limit, and filters with `relative(resolve(path), target.filename)`, "so sibling files — including temporary writer locks — are excluded **before** native watcher creation". Plus `awaitWriteFinish: true` by default because Chokidar's 50 ms change-event throttle is lossy, and the error listener re-attached across `close()` so a Windows EPERM on a deleted file cannot become an uncaught exception. August watches user config files in several places; the writer-lock exclusion alone removes a whole class of spurious reloads.

- **Never leak a private registry to a public one** - `packages/boot/plugin-manager/src/registry.ts:54` - pnpm's own registry joins the fallback set only when what it names is known to be public; while it names anything else, or is unknown, it is asked **alone**, and a public registry asked instead never falls back into it. A registry outside the configured set is also asked alone. And `attributeFailure` reads the spec's host **off error lines only**, so a deprecation warning that merely links to GitHub cannot misattribute a registry failure. Transferable to August's provider/model-fetch failover.

- **Classify failures by stable codes, and order the table so a specific code beats a generic family** - `packages/boot/plugin-manager/src/install-failure.ts:21` - `timeout` and "pnpm missing" are decided from *how the run ended*; the output table is ordered (`build-blocked` before `network`); a Git 401/403/404 is `unknown`, not `network`; an offline cache miss is `unknown` because no registry would change it. The pattern — *facts about the run's end first, then the most specific code in its output* — is directly reusable for classifying provider errors in August.

- **Turn the error taxonomy into a per-code "what the model does next"** - `packages/boot/plugin-manager/src/tools.ts:13` - each refusal code and each package failure kind maps to exactly one sentence naming the next action ("Call `list_plugins` and retry with an exact entryId"; "This profile runs without HMR; tell the user to stop DSH and run `dsh plugin --profile <profile> remove <bundle>`"), and a **refusal code beats a failure kind** when both are present. August already has a refusal vocabulary; giving each code a single actionable sentence is the cheap half of turning refusals into progress.

- **Write only `disabled` into the profile, and remove the override entirely when the base already implies it** - `packages/boot/plugin-manager/src/patch.ts:25` - the last matching override is edited in place, an override holding only `id`+`disabled` is **removed** when the bundle layers already give the requested state ("so the profile patch records only departures from the bundles"), and the comment above a removed override is moved to the next item or the document header. The comparison uses the entry's own **literal** `disabled` — "a `!!js` value never matches, so its override is kept" — and an override carrying an anchor other entries reference is never removed. This is the mechanism that keeps a hand-edited config file readable after the app has toggled things in it.

- **Keep the tool catalog stable across modes; change the prompt instead** - `packages/bundle/web-app/presets/standard.patch.yml:59` - "The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; **those tools remain listed** to keep the tool catalog unchanged." Plan mode is a prompt section inside an `isolate`d group, not a smaller tool list. For August this is the cheapest available KV-cache lever: changing behaviour by changing prompt text keeps the request prefix byte-identical, whereas swapping the tool list invalidates the whole prefix.

- **A refusal that would expose remote code execution is stated as such** - `packages/bundle/web-app/src/startup.ts:96` - a wildcard `--host` is refused with the reason spelled out: "binding every interface would expose remote code execution to the network; bind one concrete IPv4 or IPv6 address instead." August's local servers (terminal, MCP, the API) have the same hazard and would be easier to trust if the refusal carried the reason rather than a generic message.

- **Structural type checks for cross-package errors, not `instanceof`** - `packages/boot/cmdline/src/index.ts:234` - `isCommanderError` matches on a `code` string starting `commander.` plus a numeric `exitCode`, because "an out-of-tree plugin brings its own commander copy, whose `CommanderError` class is a different identity from this package's, and an identity check there would rethrow a printed help as a fatal load failure." Any August boundary where two copies of a library can meet (a vendored and a pip-installed one, an app and an extension) needs this.

- **A derived file must not be allowed to lose the user's content** - `packages/boot/app-boot/src/profile-compatibility.ts:62` and `packages/boot/plugin-manager/src/build-approval.ts:26` - a reader that cannot fully parse a permission file marks it non-rewritable and a write then **refuses** rather than discarding what it could not read; and the build-approval writer refuses YAML anchors/aliases in `allowBuilds`, "because a shared node would let one approval change another package's permission". Both are the same rule: an approval that changes a shared object must fail closed.

- **A resolved-and-reported failure is still a failure** - `packages/boot/plugin-manager/README.md:157` - "Resolution publication after a successful package operation fails: keep completed disk changes and the previous runtime table. Report `application: 'failed'` with the publication diagnostic; **pnpm's zero exit code does not mean publication succeeded**." The same doc distinguishes "installation finishes after pnpm and bundle validation succeed; subsequent publication or enablement failure does not undo installation." August's install/upgrade paths need this separation of "the operation ran" from "the operation took effect".

- **Say explicitly when a change must wait for a restart, and name the cause** - `packages/boot/plugin-manager/src/types.ts:35` - `RestartReason` is a closed set of five (`no-hmr`, `package-moved`, `host-module`, `unmanaged-plugin`, `module-comparison`), so the UI can say *why* rather than "restart". The `module-comparison` case is the good one: when the loader cannot compare the running modules with their files, the honest answer is "restart", not a silent no-op.

- **A delegated child must not see the delegation tools** - `packages/bundle/web-app/README.md:60` - "The `tool-subagent` and `tool-subagent-fork` rows in those presets deny the four tools, so a delegated child's scope never lists them." Denying at the *advertisement* level (the tool is not in the list at all) rather than at call time is what keeps a child's schema small and its scope unambiguous.

- **A profile patch replaces a row's whole config, so a mode-specific row belongs to one layer** - `packages/bundle/base/cordis.patch.yml:6` - "A patch replaces the targeted row's whole `config` rather than merging into it, so a row whose value differs by mode does NOT live here: it belongs to each mode bundle, keeping any single row down to one bundle layer plus the user's." This is the rule that keeps a layered config system from becoming an unmergeable matrix, and it is worth adopting verbatim before August's settings layer starts merging into patch files.

- **The composition must be the same computation the config dump shows** - `packages/boot/app-boot/src/profile.ts:816` - `composeEntries` calls the *same* `applyEntryPatches` over an empty root that the boot include makes, so "flag derivation and config dumps see exactly what mounts", and the dump stays one loadable YAML document with `!!js` printed verbatim. A preview that is computed differently from the thing it previews is worse than no preview.

## Files skipped (with reasons)

- `packages/bundle/web-app/tests/fixtures/document-conversion.docx` - a binary 869-byte OOXML `.docx` fixture. I confirmed its structure by reading its bytes: ZIP magic `50 4B 03 04`, containing exactly `[Content_Types].xml`, `_rels/.rels` and `word/document.xml`. It is a test *input* for the office-to-pdf conversion tests (`packages/bundle/web-app/tests/document-conversion.e2e.ts:46` reads it and feeds the bytes to the converter), not code, so it was not read line by line — a text reader cannot open it at all.

## Uncertainties

- **The `README.zh.md` files (14 of them) were opened but not read end to end.** For each I read the frontmatter and the first 15–60 lines and the corresponding English `README.md` **in full**; the Chinese files are section-for-section translations of those, and the `README.i18n.yaml` hash records confirm the pairing is machine-checked. I did not read their later sections verbatim. If a detail matters that appears only in a Chinese section, I would be quoting the English original instead.
- **`packages/boot/app-boot/src/index.ts` (1,266 lines) and `packages/boot/app-boot/src/profile.ts` (823 lines) and `packages/boot/app-boot/src/profile-resolution/resolver.ts` (1,072 lines) were read in two passes with the middle of each output truncated by the tool.** I read the head and the tail of each in full plus the returned middle fragments; I did not see every single line of `resolver.ts`'s routing tables, so the fine details of one or two of its resolution routes are reconstructed from the surrounding code and the tests rather than from the source text.
- **The `config-schema/projector.ts` middle (roughly lines 90–430) was partially truncated.** I have the type surface, the `jsonValue`/`constant` helpers, the visitation/recursion machinery and the return shape, and the `schemastery-json-schema.spec.ts` suite pins the observable behaviour, but I did not read every branch of the visitor.
- **`packages/boot/plugin-manager/src/operations.ts` (641 lines) and `src/index.ts` (939 lines) and `packages/boot/hmr/src/index.ts` (1,131 lines) were read with the tool truncating the middle.** The tests pin the observable behaviour in each case; where I describe a mechanism in the report I have seen the code for it, but I have not verified every line of those three files.
- **I did not run any test, build, or script from the clone** (per the read-only rule), so every statement about behaviour is read from source or from a test's assertions, never observed at runtime. The `base` bundle's `cordis.patch.yml` in particular is a 529-line YAML file whose full row list I did not enumerate row by row; I described the rows the README and the tests name.
- **The `linked-resolution-matrix.spec.ts` and `profile-resolution.spec.ts` suites reach into Node internals** (`internal/modules/esm/loader`, `internal/modules/cjs/loader`, `internal/bootstrap/realm`) via the `node-addon-require-builtin` addon. I read them but did not run them, so I cannot confirm which Node version this checkout's CI pins; the `loader-shape.compat.spec.ts` comment implies the range 24.0–24.11.1 (v1 loader) through 24.12.0+ (v2 loader) is supported.
- **`packages/boot/plugin-market/src/index.ts` (356 lines) was read with the middle truncated.** The fetch/cache/annotation flow and the compatibility helper are from the source; the exact fetch body-size enforcement is from the README's stated limits rather than from the byte counter in the code.
