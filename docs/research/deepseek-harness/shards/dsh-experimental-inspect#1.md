# deepseek-harness / dsh-experimental-inspect#1

## Shard shape

This shard holds **two unrelated experimental packages** that happen to sit next to each other under `packages/experimental/`, and it is worth saying up front that they share no code, no design language, and no audience.

- **`packages/experimental/claude-code-mods/`** (51 files) is a **plugin/compatibility bridge**. It loads third-party *Claude Code mods* — a `register(on, options)` hooks module with a `$` API — as ordinary DSH Cordis plugins, and raises their lifecycle hooks from real harness extension points (`agent/created`, `agent/pre-step`, `tools/execute`, `turn/end`, `agent/disposed`, the command registry). It contains a middleware **chain** with a running-time budget clock, an **engine** that owns per-session state and timers, a **host-ops table** that implements every `$` member over composed harness services (`ctx.fs`, `ctx.subprocess`, `ctx.commands`, `ctx.tools`, `ctx.userQuestions`, a storage domain, `ctx.workingDirectory`), a **band-above-the-prompt** surface with generation counters and held button callbacks, and a **test kit** shaped like `claude-code/testing`. Three example mods (Token Weather, Blast Radius, Replay Theater) plus a `cordis.source.patch.yml` overlay demonstrate the whole path.
- **`packages/experimental/cua-macos/`** (102 files) is a **native macOS computer-use provider**. A TypeScript side (`src/`) prepares a Swift binary (source build, or a prebuilt payload) and opens a **per-Agent Unix-socket connection** to a **shared daemon** (`native/Sources/CuaNative/`, 24 Swift files) that owns AppKit, the Accessibility tree, ScreenCaptureKit, and PID-targeted input. The daemon is a *client-multiplexed* service: one process, one ScreenCaptureKit backend, one AX worker and one cancellation state per connection. Underneath sit ~40 test files: Swift unit tests, Python end-to-end runners against real AppKit fixtures, Blender/Electron regressions, and read-only benchmarks that compare a reference helper against a candidate.

The two are relevant to August for opposite reasons. The mods bridge is a **plugin API design** — a middle-tier, user-installable extension point layered over the agent loop, with a strict "what is served vs. what is refused" contract. The CUA provider is a **ground-truth discipline** document for anyone who will let a model drive a real desktop: every action reports `dispatched, not verified`, every observation is versioned, and every stale state has a named error code.

---

## Per-file notes

**Package: `packages/experimental/claude-code-mods`**

### packages/experimental/claude-code-mods/cordis.source.patch.yml
- Purpose: A 21-line source-overlay manifest that composes the bridge, the three example mods, and the Web band client into a `dsh web` / `dsh --profile headless` launch.
- Key abstractions: `insert:` list of `{id, name}` plugin rows; relative paths are anchored to the file and run through the CLI's tsx loader.
- Data flow: Loader reads the YAML → mounts `./src/index.ts`, then the three `examples/*/index.ts`, then `../client-ui-claude-code-mods/src/index.ts`.
- Non-obvious design decisions: The comment states the ordering rule explicitly: *"Mods load in list order and the band above the prompt is one instance consulted in that order, so the guards that yield when idle come before Token Weather, which draws whenever it has a reading."* — load order **is** chain order **is** render priority.
- Edge cases / failure handling: None; a malformed row fails at Loader time.
- Surprising: This is the only file in the shard that documents the tri-unity of load-order → chain-order → draw-priority in one sentence.

### packages/experimental/claude-code-mods/package.json
- Purpose: Package manifest for `@deepseek-ai/dsh-experimental-claude-code-mods` v0.2.1-rc.2.
- Key abstractions: `exports` map publishes `.`, `./types`, `./testing`, `./typert`, `./remote`, `./examples/*`, `./src/*`.
- Data flow: Dependencies are `@deepseek-ai/dsh-util-crypto`, `dsh-util-values`, `schemastery`, `zod`; 20 workspace `peerDependencies` declare the harness packages the bridge expects but does not own.
- Non-obvious design decisions: The bridge declares `dsh-agent`, `dsh-llm`, `dsh-session`, `dsh-tools` as **peers** — the bridge is a plugin *into* the harness, never a bundle of it.
- Edge cases / failure handling: `publishConfig.access: public`; `files` ships only `lib/index.js`, the type trees and the typert host/remote stubs.
- Surprising: `./typert` and `./remote` export paths exist for a *host/remote* split (the `Remote` service in `src/index.ts` is the wire to a Client) even though no file in this shard implements them.

### packages/experimental/claude-code-mods/tsconfig.json
- Purpose: 69-line TypeScript project config; `rootDir: src`, `outDir: lib/types`, 22 project references.
- Key abstractions: Composite project references into `vendor/cosmokit`, `vendor/cordis`, `vendor/schemastery`, and 19 `packages/*` projects.
- Data flow: The reference graph is the package's true dependency surface, expressed at the build layer.
- Non-obvious design decisions: `include: ["src"]` only — `examples/` and `tests/` are *not* in the Host typecheck project, which is why `tests/examples.spec.ts` says *"The imports are computed so the Host typecheck project keeps the published tests out of its file list."*
- Edge cases / failure handling: n/a.
- Surprising: The examples ship inside a published package but are deliberately outside the package's own typecheck project.

### packages/experimental/claude-code-mods/README.md
- Purpose: 220-line package reference; the primary specification of the bridge's contract.
- Key abstractions: Three tables carry the contract — *which events your mod receives* (8 events, each with its harness extension point), *which `$` members your mod can call* (13 namespaces, each mapped to a composed service), and the config table (`hookTimeoutMs` 10000, `catchTimeoutMs` 1000, `processTimeoutMs` 30000, `toolAliases`, `bandColumns` 120, `bandRows` 10).
- Data flow: Documented end to end — `session.start` → `prompt.submit` → `turn.start` → `tool.call` → `turn.complete` → `session.end`, plus the `<namespace>.<method>` events a mod's own `$` call raises.
- Non-obvious design decisions: The README has explicit **"Token effect"** and **"KV Cache effect"** subsections under "Model Experience", stating that added context and submitted prompts are *append-only* and *"follow the reusable request prefix and do not invalidate existing entries."* This is the harness's cache discipline stated as a promise to mod authors.
- Edge cases / failure handling: A long "Known Limitations" list — one drawing surface, `next` runs once, 20+ unserved events, 14 unserved `$` namespaces, `tool.call` runs *after* the harness permission decision, one process many sessions, no sandbox.
- Surprising: `$.ui.open` answers `{ isPlaced: false }` — the host **places no panes at all**, and a mod that degrades to the band draws there. A whole UI surface is a lie told consistently.

### packages/experimental/claude-code-mods/README.zh.md
- Purpose: 220-line Chinese translation of the package reference.
- Key abstractions: Mirrors the English section-for-section (摘要 / 目录 / 使用本包 / 理解实现 / 进一步探索 / 模型体验 / 已知限制与延期工作 / 开发备注).
- Data flow: Same tables, same config values, same example links.
- Non-obvious design decisions: The translation keeps the English anchors (`<a id="use-this-package">`) so cross-language deep links resolve to the same section.
- Edge cases / failure handling: The pairing record `README.i18n.yaml` hashes each section's English and Chinese blocks separately, so a one-sided edit is detectable.
- Surprising: The zh text is not a paraphrase — it preserves Claude Code's own vocabulary ("未服务的事件", "横幅", "mod 组") with English technical terms left untranslated.

### packages/experimental/claude-code-mods/README.i18n.yaml
- Purpose: 85-line bilingual-pairing consistency record.
- Key abstractions: One entry per heading section, with an `en:` and `zh:` 64-bit hash of that section's blocks (outside code fences and generated regions).
- Data flow: `pnpm run verify-translation-pairing --write <file>` regenerates it after a paired edit.
- Non-obvious design decisions: Hashing *per section* rather than per file means a translation drift in one section is localised, not a whole-file mismatch.
- Edge cases / failure handling: The file header names the regeneration command, so a maintainer never has to guess.
- Surprising: This pattern (per-section bilingual hashes) appears identically in three packages in this shard — it is a repo-wide convention, not a local one.

### packages/experimental/claude-code-mods/src/index.ts
- Purpose: The bridge service itself — config, mod registry, extension-point listeners, and the `Remote` that streams the band to a Client.
- Key abstractions: `ClaudeCodeMods extends TypertRemoteService`; `SERVED_EVENTS` (8 names); `Config` (schemastery, 6 fields); `DetachedRuns` (tracked detached promises with a shared abort controller).
- Data flow: `agent/created` → `ctx.workingDirectory.ensure` → raise `session.start`. `agent/pre-step` → claim human-sourced messages → raise `prompt.submit` → rewrite text / append context / drop → raise `turn.start` on the first pre-step of a turn. `tools/execute` → raise `tool.call` around the real tool. `session/event` (`turn/start`, `assistant/message`, `turn/end`) → fold usage and answer → raise `turn.complete`. `agent/disposed` → raise `session.end`, then forget the session's state and timers.
- Non-obvious design decisions: The tool-call guard compares the arguments a hook passes to `next` against the **logged** arguments and refuses with a `RewriteRefusedError` naming a deferred mechanism: *"the logged call runs the tool it named"* (`src/index.ts:400-408`). A hook that reroutes the tool or edits its arguments is *skipped with a report*, not obeyed. A rewritten **result** is different: it is installed through `tools/post-execute` (`src/index.ts:436-447`) so the pipeline's own block/accept decision still wins.
- Edge cases / failure handling: A dropped prompt returns `{kind:'reject'}` and the turn ends `blocked` with no model-visible message. `agent/created` merges the loop's signal with the bridge's disposal signal, so cancelling creation abandons both directory validation and a waiting hook. `redraw` is deferred by one macrotask "because a mod sets its own state right after the `$` call that triggers the redraw resolves."
- Surprising: `textOf` and `foldAssistantMessage` fold only the *last committed* assistant text into a turn, and `turn.complete` carries a Claude-Code-shaped usage object (`input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`) — the bridge deliberately speaks Claude Code's API vocabulary, not the harness's.

### packages/experimental/claude-code-mods/src/engine.ts
- Purpose: The Cordis-free core: loaded mods, their hooks, engine-raised events, `$`-calls-raised-as-events, per-session `$.state`, and mod-owned timers.
- Key abstractions: `ModsEngine<B>`; `OpResolver<B>` (op name → engine behavior); `OpContext<B>` (mod, binding, signal, engine); `TimerSet`; `OpDenied` (an engine behavior answering `{ deny }`).
- Data flow: `raise()` selects hooks for an event and dispatches them. `invoke()` re-raises a `$` call as an event **through the mods loaded before the caller** and then runs the engine behavior beneath. `stateKey(binding)` scopes `$.state`; `timersOf(mod, sessionKey)` scopes timers by `<session>\0<mod>`.
- Non-obvious design decisions: `invoke()` special-cases `tool.call` to an **empty hook list** (`src/engine.ts:257`): *"tool.call reaches the earlier mods once the host raises it from the tool pipeline, not here as well."* Without this, a mod's `$.tool.call` would re-enter its own `tool.call` hook. The two dispatch directions are deliberately asymmetric.
- Edge cases / failure handling: `forgetSession` deletes the state map and closes every timer set whose key starts with `<session>\0`; `unload` closes the sets keyed `<session>\0<mod>`. `TimerSet.close()` refuses new timers, cancels scheduled ones, and **awaits the callbacks already running**, so a mod cannot touch the host after unload. `clock.sleep` rejects when the event's signal aborts.
- Surprising: `state.get`/`state.set` are answered by the engine itself when the resolver serves none, and the engine exposes `onStateRead` / `onStateWritten` callbacks — that is how the band learns which state slots a drawing depended on.

### packages/experimental/claude-code-mods/src/chain.ts
- Purpose: The middleware chain: runs the hooks selected for one event, outermost first, with the engine behavior at the bottom, under Claude Code's failure rules.
- Key abstractions: `dispatch<E,R>(request)`; `BudgetClock`; `HookTimeoutError`; `RewriteRefusedError`; `NoResultError`; `LoadedMod` / `RegisteredHook`; `DispatchRequest` (with `validateNext`).
- Data flow: `runFrom(index, input)` walks the selected hooks; each hook gets a frozen input, a `next` that delegates beneath once, a `$` bound to that hook, and a fresh `BudgetClock`.
- Non-obvious design decisions: **The budget clock counts only the hook's own running time** (`src/chain.ts:50-131`). It pauses inside `next` and inside every `$` call, so a slow tool or a slow network call does not consume the hook's 10-second allowance. `$.clock.sleep` is the deliberate exception — it counts as the hook's own time, because a mod that holds a decision open is genuinely busy. The clock also refuses to fire after the hook settles (`this.deadline.promise.catch(() => {})` in the constructor), so an unobserved rejection never surfaces.
- Edge cases / failure handling: A hook that throws, times out, or settles with a non-object is **skipped and reported once per failure kind** (`hook.reported` is a `Set<string>`), and the result from beneath stands if the hook had already called `next`. A `.catch` handler may answer in the hook's place; it shares the hook's beneath-state so nothing runs twice, and it makes the *same* `validateNext` check. An error thrown by the core is re-thrown rather than blamed on the hook (`src/chain.ts:272`).
- Surprising: `null` is a valid answer ("a surface drawn empty"); only a hook that settles with **no object at all** is skipped. And a hook that answered while its `next` was still running causes the dispatch to *await that run* before settling — the chain never leaves a run dangling.

### packages/experimental/claude-code-mods/src/module.ts
- Purpose: Mod registration: run `register(on, options)` and keep every `on(...)` in one ordered registry.
- Key abstractions: `HookRegistry` (mods + hooks, ordered by load then registration); `createOn(mod)`; `registerMod(definition, order)`; `PLUGIN_NAME = /^[A-Za-z0-9_-]{1,64}$/u`.
- Data flow: `registerMod` freezes the mod record, builds `on`, awaits `register(on, mod.options)`, and returns the mod plus its hooks.
- Non-obvious design decisions: `on` refuses an **unknown event name** and a **second matcher-less registration of one event**, with Claude Code's own wording — so a misspelled event fails at load instead of registering a hook that never runs. `HookRegistry.select(event, raisedBy)` filters by `hook.mod.order < raisedBy.order` and then sorts by load order, which is what makes the "`$` call reaches only earlier mods" rule fall out of one comparison.
- Edge cases / failure handling: A `register` that throws is re-thrown as `"<name>: hooks module did not load: register threw <message>"` with the original as `cause`. Duplicate mod names are refused by both `HookRegistry.add` and `ModsEngine.add`.
- Surprising: `HookRegistry.describe(mod)` renders the `hooks:` line the way `claude plugin validate` prints it — `{tool=Bash,id=/^T-/}` — so a mod author can read their own registration back in the validator's own format.

### packages/experimental/claude-code-mods/src/matcher.ts
- Purpose: Event-name patterns and field matchers — which registered hooks an event selects.
- Key abstractions: `ENGINE_EVENTS` (43 engine event names); `KNOWN_EVENTS` (engine events + every `$` method as `<namespace>.<method>`, ~80 names); `isEventPattern`; `eventMatches`; `matcherMatches`; `describeMatcher`.
- Data flow: `isEventPattern` accepts an exact name, `*`, or `<namespace>.*` (and refuses `.*` — the namespace must be non-empty and known).
- Non-obvious design decisions: `valueMatches` resets `expected.lastIndex = 0` before every test, because a global or sticky RegExp *remembers where its last test stopped* and every event must start fresh (`src/matcher.ts:85-86`). `eventMatches('*', event)` deliberately **excludes** `telemetry.*`.
- Edge cases / failure handling: `matcherMatches` requires the input to be an object; a non-object input matches nothing. A field whose expected value is an array matches by membership.
- Surprising: `KNOWN_EVENTS` is a *closed* list — the whole point is that a typo fails at `on()` rather than registering silently. The list also includes namespaces this host does not serve (`model.*`, `mcp.*`, `audio.*`), so an unserved-but-real Claude Code event is accepted and then reported as never-raised.

### packages/experimental/claude-code-mods/src/api.ts
- Purpose: The `$` object a hook receives — the shape of the whole plugin API.
- Key abstractions: `createModsApi(binding)`; `ApiBinding`; `TimerHost`; `withUnservedMembers(served, modName)`; `METHOD_NAMESPACES` (20 namespaces).
- Data flow: Every method shapes its arguments into the mods-API event of the same name and hands it to `invoke`. The clock pauses while the call is awaited — except `$.clock.sleep`, which is invoked directly so it counts as the hook's own time.
- Non-obvious design decisions: `withUnservedMembers` wraps each namespace in a `Proxy` so that **any member the host does not serve becomes a function that rejects with `no implementation for <namespace>.<member>`** (`src/api.ts:192-218`) rather than `undefined`. The outer proxy's `set`/`defineProperty`/`deleteProperty` all return `false`, making `$` genuinely read-only. The served object is *not* frozen, because a frozen target's invariant forbids returning a wrapped namespace from a getter.
- Edge cases / failure handling: `fire(...)` is the fire-and-forget path (toast/status/log/invalidate); a rejection becomes a reported line, never an unhandled rejection.
- Surprising: `$.ui.resolve(e)` returns the element constructors and is explicitly **not** itself an event — it is the one member of the API that does not travel through the chain.

### packages/experimental/claude-code-mods/src/host-ops.ts
- Purpose: The engine behavior for every `$` call, mapped onto composed harness services.
- Key abstractions: `createHostOps(options)` → an `OpTable` keyed by `<namespace>.<method>`; `AgentBinding`; `MODS_API_VERSION`; limits `FS_MAX_BYTES` 4 MiB, `STORE_MAX_BYTES` 4 MiB, `PROCESS_OUTPUT_MAX_BYTES` 1 MiB, `HTTP_MAX_BYTES` 4 MiB; `modToolName(plugin, tool)` = `mcp__<plugin>__<tool>`; `toolCallResultOf(result)`.
- Data flow: Every op reads `ctx.get(...)` **on demand** and fails with the *missing service's package name* if the deployment did not compose it (e.g. `"$.fs needs a filesystem service (dsh-fs), which this deployment did not compose"`). `$.fs` resolves paths against the validated current session directory via `ctx.workingDirectory`; `$.process.run` spawns argv without a shell through `ctx.subprocess`; `$.store` lives in a `claude_code_mods` storage domain.
- Non-obvious design decisions: `serializeStore(plugin, write)` gives each plugin a **per-plugin write chain** so a read-modify-write on one plugin's JSON object cannot lose a concurrent update (`src/host-ops.ts:213-221`). The `$.store` byte limit counts **UTF-8 bytes** and is checked against the encoded JSON, so 1.5 MiB of CJK (4.5 MiB of UTF-8) is refused while 1.5 MiB of ASCII is accepted. `$.process.run` composes `AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)])` and, if the deadline fired, reports *"did not exit within N ms"* rather than a generic timeout.
- Edge cases / failure handling: `fs.stat` follows a symlink and reports what it points at, matching Claude Code's `resolve: true`; a dangling link is `other`. `http.fetch` reads the body through a bounded reader and **cancels the stream** at the first byte past the bound. `tool.register` runs `assertObjectJsonSchema` immediately, because "the schema reaches the model, so an unsupported keyword fails this call, not a later request." `tool.register` names tools `mcp__<plugin>__<tool>`.
- Surprising: `$.env.get` / `$.env.set` read and write the **process's own** environment — the mod runs with the harness's full authority. The README says so plainly, and also says the bridge has *no sandbox*.

### packages/experimental/claude-code-mods/src/surfaces.ts
- Purpose: One band above the prompt per session: render it through the mods' `ui.render` hooks, keep the latest tree with its button callbacks host-side, and hand watchers each new generation.
- Key abstractions: `SurfaceTable`; `SessionBand` (generation, tree, subscribed state slots, action map, watchers, wakers); `SurfaceHost`; `SurfaceSnapshot`.
- Data flow: `renderOnce` raises `ui.render` with `{component:'AbovePrompt', props:{bodyColumns,hasSurvey,isWorking,maxRows}, viewport:{columns}}`, validates the tree with `treeProblem`, then `serializeTree` replaces each `onPress` with an action id. `stateRead` (during a render) subscribes the band to the slot; `stateWritten` refreshes a subscribed band.
- Non-obvious design decisions: **An unchanged tree keeps its generation** but gets fresh callbacks (`src/surfaces.ts:226-239`): action ids count up per drawing, so an identical drawing serialises identically and the generation does not churn. A **press from an earlier generation is ignored and reported** (`src/surfaces.ts:142-152`): *"band press ignored: <id> of generation N is not on the current drawing (M)"*. Overlapping `refresh()` calls are coalesced into **one** additional pass.
- Edge cases / failure handling: A failed render or an invalid tree becomes an *empty band* plus a report, never a crash. `forget(sessionId)` ends the watch streams and marks the band closed, so no further pass renders it.
- Surprising: The read-dependency tracking is the interesting bit — the band re-renders because the *drawing* read a `$.state` slot, not because a mod asked for a redraw. A widget that reads a value is subscribed to that value.

### packages/experimental/claude-code-mods/src/elements.ts
- Purpose: The `Box` / `Text` / `Button` vocabulary a `ui.render` hook answers with, plus validation, serialization and tree search.
- Key abstractions: `UiElement` (branded with a `Symbol` so a hand-made object cannot pass for a constructor-made one); `UiNode`; `uiElements()`; `treeProblem(node)`; `serializeTree(node, holdAction)`; `findAll(node, pattern)`; `renderText(node)`.
- Data flow: `childrenOf` flattens the tree, dropping `null`/`undefined`/`false` and empty strings, and throws a `TypeError` naming the offending type for anything else. `serializeTree` keeps only scalar props (string/number/boolean) and drops `children` and `onPress`.
- Non-obvious design decisions: `isUiElement` uses a module-private `Symbol` brand rather than a structural check, so `isUiElement({type:'Text',props:{}})` is **false** — a mod cannot forge an element. The formatter's action-name normaliser strips AppKit's `Name:…\nTarget:…\nSelector:…` scaffolding and drops the `AX` prefix.
- Edge cases / failure handling: `treeProblem` reports *"a Button needs a string label"* and *"a Button onPress must be a function"* — the two ways a drawing fails. `findAll` matches on type, on drawn text (including descendants), and on a Button's label, with a string matching as a substring and a RegExp as a test.
- Surprising: `scalarProps` silently drops *any* non-scalar prop. A mod that puts an object in a prop gets it removed at serialisation, not an error.

### packages/experimental/claude-code-mods/src/define-mod.ts
- Purpose: `defineMod` — wrap a mod's `register(on, options)` as a DSH plugin.
- Key abstractions: `ModSpec` (name, version, root, userConfig, register); `ModPlugin` (name `claude-code-mod-<name>`, `inject: ['claudeCodeMods']`, `Config`, `definition`, `apply`).
- Data flow: `apply` calls `ctx.claudeCodeMods.add({...definition, options: {...userConfig, ...config}})` and returns the disposer.
- Non-obvious design decisions: The plugin's `Config` is `z.dict(optionValue).default({})`, so a mod's `options` are exactly the *overlay* of the composition's config on the mod's own `userConfig` defaults. The `definition` is frozen at `defineMod` time; only `options` changes per mount.
- Edge cases / failure handling: *"A `register` that throws fails this plugin's mount, as any misconfigured plugin does; the rest of the composition continues."* The disposer is the return value, "which Cordis collects even when the plugin was removed while `register` was still running" — a race the test suite covers explicitly.
- Surprising: `root` defaults to `process.cwd()` when the spec names none, and `$.plugin.root` reports it — so a mod that does not declare its root claims the process's cwd.

### packages/experimental/claude-code-mods/src/testing.ts
- Purpose: The test kit, shaped like `claude-code/testing`: load mods, stub the engine, raise events, mount a surface.
- Key abstractions: `createModTestKit(options)`; `ModTestKit`; `TestKitRaisers`; `KitEventInputs`; `MountedSurface` / `MountedElement`; `mock.store` / `mock.env` / `mock.clock`; `DEFAULT_ENGINE_ANSWERS`; `DEFAULT_OP_ANSWERS`.
- Data flow: `kit.on(event, stub)` registers a stub *beneath* every mod; `kit.$.tool.call(...)` raises `tool.call`; `kit.$.ui.mount({component})` renders a surface that re-renders on every read; `mock.store(kit.on)` answers `$.store` from a `Map`.
- Non-obvious design decisions: The kit's own `kitMod` has `order: Number.MAX_SAFE_INTEGER`, so a stub is always *beneath* every loaded mod. `opStub` demands `{ value }` or `{ deny }` from a stub and turns a bare value into an error. `mock.clock` advances the virtual clock on `sleep`, so a mod's own timing is deterministic.
- Edge cases / failure handling: Mounting the same surface key twice throws `"surface <key> is already mounted"`. A stub that returns `undefined` is an error, not a pass. A fire-and-forget `$.ui.toast` nobody answered is reported as `"stateful: $.ui.toast failed: no implementation for ui.toast"`.
- Surprising: The kit is the only place a mod can be tested *without* a harness, and it ships as a separate export path (`./testing`) so an external mod author's test can use it too.

### packages/experimental/claude-code-mods/src/tool-names.ts
- Purpose: Two-way translation between Claude Code's tool names and the harness's.
- Key abstractions: `DEFAULT_TOOL_ALIASES` (13 entries: Bash→bash, Read→read, Edit→edit, Write→write, Glob→glob, Grep→grep, WebFetch→web_fetch, WebSearch→web_search, Task→subagent, TodoWrite→todo_write, AskUserQuestion→ask_user_question, ExitPlanMode→exit_plan_mode, Skill→skill); `ToolNameAliases`; `createToolNameAliases(overrides)`.
- Data flow: `toMod(harnessName)` and `toHarness(modName)` both fall back to the name itself, so an unaliased tool keeps its harness name in a mod's matcher.
- Non-obvious design decisions: The reverse map is built from the *forward* map, so an override that collides silently loses one direction — the README's "every other tool keeps its harness name" is the observable contract.
- Edge cases / failure handling: None beyond the fallback.
- Surprising: `Task` ↔ `subagent` — the Claude Code word for delegation maps onto the harness's word for it.

### packages/experimental/claude-code-mods/src/types.ts
- Purpose: 500 lines of mods-facing types: the hooks-module contract, event inputs/results, and the `$` API subset.
- Key abstractions: `ModOn` (typed overloads for the 8 served events, open for every other Claude Code event); `HookNext<E,R>` (callable, plus `signal`, `origin`, `budget`, `to`, and in a `.catch` handler `error` and `called`); `ModsApi`; `ModTier`; `SurfaceSnapshot`; `TurnUsage`.
- Data flow: Pure types; no runtime behaviour.
- Non-obvious design decisions: The doc comment states the naming rule outright: *"Field names follow Claude Code's declarations so an unmodified mod type-checks against the same names; only the members this bridge implements are declared."* `TurnUsage` uses snake_case (`input_tokens`, `cache_creation_input_tokens`) to match Claude Code, not the harness's camelCase.
- Edge cases / failure handling: `PromptSubmitResult` is a discriminated union with `drop` and `text` mutually exclusive, which is what lets `acceptPromptSubmit` in `src/index.ts` filter a mod's wrong-typed answer down to what it is allowed to set.
- Surprising: `HookNext.to(e, tier)` exists in the type and **always throws** — tier skipping is a managed-settings feature this bridge does not implement, and the type keeps the door-shaped hole so a mod compiles unchanged.

### packages/experimental/claude-code-mods/src/values.ts
- Purpose: Three small helpers shared by the engine and the host.
- Key abstractions: `messageOf(error)`; `record(input)`; `requireString(value, what)`; `stringify(value)`.
- Data flow: `record` treats any non-object as `{}` — a mod's call input is always a field record. `requireString` throws a `TypeError` naming the field.
- Non-obvious design decisions: `stringify` is typed as `string | undefined` because `JSON.stringify` returns `undefined` for a value JSON cannot carry — and the bridge's `jsonValueOf` then treats that as "no JSON value" rather than coercing it.
- Edge cases / failure handling: `messageOf` on a non-Error gives `String(error)`, which is how a rejected string still reaches a diagnostic line.
- Surprising: 46 lines carrying the whole "untyped plugin input" discipline.

### packages/experimental/claude-code-mods/examples/blast-radius/index.ts
The mod as a DSH plugin. Its only DSH-specific act is overriding the hold timer: `waitArgv: [process.execPath, '-e', 'setTimeout(() => {}, 250)']` — *"using the running Node executable for its cancellable hold timer"* so the Proceed/Cancel hold does not need POSIX `sleep` on Windows.

### packages/experimental/claude-code-mods/examples/blast-radius/hooks/blast-radius.mjs
The mod itself, completed to Anthropic's published description. `RISKS` is five regexes (recursive delete, `git reset --hard`, `git clean`, force-push, migrate). A `tool.call` hook on `Bash` classifies the command, measures it (`du -sh` + `find` for a delete; `git status --porcelain` for a reset), opens a pane, and then **polls in a loop** until a button decides — `while (held.decision === null && !next.signal.aborted) { await $.process.run(waitArgv) }`. A dry run that fails still lets the user decide. Non-obvious: the hold is a *polling loop inside one hook*, which is why the hook's own-time budget must not count the `$.process.run` wait.

### packages/experimental/claude-code-mods/examples/blast-radius/hooks/blast-radius.d.mts
`export declare const register: ModRegister` — the type contract that lets the `.mjs` load unchanged.

### packages/experimental/claude-code-mods/examples/blast-radius/hooks/hooks.json
`{"modules": ["./blast-radius.mjs"]}` — Claude Code's own manifest; **not read by this bridge** (README: *"`plugin.json` and `hooks.json` — not read"*).

### packages/experimental/claude-code-mods/examples/blast-radius/.claude-plugin/plugin.json
name/version/description/author — the identity `defineMod` carries instead.

### packages/experimental/claude-code-mods/examples/blast-radius/tests/blast-radius.test.ts
Two tests in the shape of the published Token Weather test. The first holds `git reset --hard`, mounts the band, polls for a `Cancel` button (200 attempts × 5 ms), presses it, and asserts the deny message; the second mounts a `Pane` and asserts the band stays empty. Non-obvious: the test's `process.run` stub gives the hold sleeps *real* time (`setTimeout(resolve, 5)`) "so a press can land between them".

### packages/experimental/claude-code-mods/examples/replay-theater/index.ts
The mod as a DSH plugin; `register` is passed straight through.

### packages/experimental/claude-code-mods/examples/replay-theater/hooks/replay-theater.mjs
Records a turn's `Edit`/`Write` calls into `state.pending` as `{file, before, after}` — for a `Write` it reads the *old* contents just before the write lands, so the diff is real — seals them into `state.replay` at `turn.complete` for the root agent only, registers a `/replay` command at `session.start`, and draws a one-line hint above the prompt with a `Replay` button. Non-obvious: `on('turn.start', …)` clears `state.pending` **only when `e.agentId` is absent**, so a subagent's turn does not disturb the sealed replay.

### packages/experimental/claude-code-mods/examples/replay-theater/hooks/replay-theater.d.mts
`ModRegister` type contract.

### packages/experimental/claude-code-mods/examples/replay-theater/hooks/hooks.json
`{"modules": ["./replay-theater.mjs"]}`.

### packages/experimental/claude-code-mods/examples/replay-theater/.claude-plugin/plugin.json
Plugin identity.

### packages/experimental/claude-code-mods/examples/replay-theater/tests/replay-theater.test.ts
One long test that walks the whole lifecycle — session start registers `/replay`; `/replay` with no edits says "No edits"; edits are recorded but not shown until the turn ends; a subagent turn leaves the replay alone; `/replay` opens the pane; `Next`/`Prev`/`Close` buttons step the diff; the band reappears. Non-obvious: the assertion *"Nothing shows until the turn ends: the replay is one turn's edits"* is the point of the design.

### packages/experimental/claude-code-mods/examples/token-weather/index.ts
The mod as a DSH plugin; *"the blog's module and type contract run unchanged"*.

### packages/experimental/claude-code-mods/examples/token-weather/hooks/token-weather.mjs
The **published module, unchanged**. Takes a reading at `session.start` and at each root `turn.complete`, keeping the last 12 readings in `$.state` (host-held, *not* in the prompt), and draws a forecast band (icon + word + `% of context` + tokens/window + a sparkline + a trend arrow). Non-obvious: `const readings = { plugin: "token-weather", key: "readings" }` — the history lives in the **host's** state, so the prompt prefix never changes as the band updates. That is the KV-cache discipline in five lines.

### packages/experimental/claude-code-mods/examples/token-weather/hooks/token-weather.d.mts
`ModRegister` type contract.

### packages/experimental/claude-code-mods/examples/token-weather/hooks/hooks.json
`{"modules": ["./token-weather.mjs"]}`.

### packages/experimental/claude-code-mods/examples/token-weather/.claude-plugin/plugin.json
Identity plus `"types": "./types/index.d.ts"`.

### packages/experimental/claude-code-mods/examples/token-weather/types/index.d.ts
The published type contract — `TokenWeatherReading` and a `declare module 'claude-code' { interface PluginState { 'token-weather': { readings: TokenWeatherReading[] } } }`.

### packages/experimental/claude-code-mods/examples/token-weather/tests/token-weather.test.ts
The published test, unchanged apart from three `as any` casts *"which this host's typed test kit does not [need]"*. Asserts the band reads "Clear" at 18%, then "Showers" / "67% of context" / "▲ +98.3k last turn" after a second reading.

### packages/experimental/claude-code-mods/tests/bridge.spec.ts
- Purpose: 1142-line full-loop integration suite: a scripted mock MODEL drives the **real** agent loop, tool registry, command registry, filesystem, subprocess, user-questions and storage services, and the **real** bridge loads **real** mod directories — only the model is mocked.
- Key abstractions: `harness(modsToLoad, adapter, options)` builds a full Cordis context; `importRegister(path)` re-imports a hooks module with a `?load=N` cache-buster to simulate a reload; `writeMod(name, body)` writes an inline hooks module; `fixtureMod(name)`; `WindowedAdapter` (a mock model that advertises a 1000-token window so the token meter can report pressure).
- Data flow: `h.ctx.commands.execute(agent, '/tally', …)` → the mod's `command.run` hook → the answer. `h.turn(agent, text)` → `agent.followup(...)` → `agent.whenIdle()`.
- Non-obvious design decisions: Every assertion is about the *mod's effect on the loop or the services*, not about the bridge's internals — the file's own docstring says so. The `prompt.submit` test proves that **a batch of injected context alone is not a prompt**: `agent.inject(...)` with a `user-question-reply` source raises no `prompt.submit`. The `tool.call` test proves the *schema* rule: a bare-string answer to a tool whose output schema does not admit a string becomes an **error-shaped** result (`MOD_ANSWERED`), while a tool whose schema admits a string renders through the tool's own presenter.
- Edge cases / failure handling: The band test drives the whole `watchBand` → `pressBand` loop against a real `SurfaceTable`, asserts that a **stale press is ignored and reported** (`band press ignored`), and that a button whose `onPress` throws is reported (*"a button's onPress failed: nope"*) and the band redraws. The `WindowedAdapter` test proves `$.session.usage` reports the *provider-measured* prompt size against the route's window.
- Surprising: The `tool.call` section runs **two** mods so that the reroute-mod's first report is the reroute, not the argument rewrite — "a hook's reports are one per failure kind." Also: `h.ctx.tools.execute(...)` **without an agent** is answered by the same schema rule, so the host-side path and the agent-side path agree.

### packages/experimental/claude-code-mods/tests/chain.spec.ts
- Purpose: 449-line unit suite for the chain, the budget clock and the `.catch` handlers.
- Key abstractions: `request(overrides)` builds a `DispatchRequest`; `hook(owner, event, fn, matcher)` builds a `RegisteredHook`.
- Data flow: `dispatch(request({input, core, hooks}))`.
- Non-obvious design decisions: The three moves are named and separately tested: **observe** (a hook that returns `next(e)` sees the result from beneath and the core sees the *original* input), **rewrite** (later hooks and the core see the copy; the hook's own input is frozen at every depth), **answer** (a hook that returns without calling `next` short-circuits later hooks *and* the core). The budget test explicitly asserts that time inside `next` and inside a real `$` call does **not** count.
- Edge cases / failure handling: A hook that resolves to `undefined` is *"skipped: returned no result"*; `null` is not. A core error is propagated *without* blaming the hook. A timeout skips the hook and a **late `next` from it resolves to `undefined`** rather than running the chain a second time.
- Surprising: The "one run beneath per hook" test asserts `first === second` (the *same promise*) when `next` is called twice.

### packages/experimental/claude-code-mods/tests/module.spec.ts
- Purpose: 244-line unit suite for `createOn`, `HookRegistry`, `registerMod` and `ModsEngine`.
- Key abstractions: `engine(ops, report)` builds a `ModsEngine` over a plain `ops` record; `fakeApi`.
- Data flow: `e.api(owner, undefined, {key}, signal)` hands a mod its `$`; `e.invoke(mod, op, input, binding, signal)` raises a `$` call as an event.
- Non-obvious design decisions: `HookRegistry.select('fs.read', b)` returns only mod `a` — a `$` call raised by mod `b` reaches the mods loaded **before** it. `select('fs.read', a)` returns **nothing** (a mod cannot see its own call). The timer test uses `vi.useFakeTimers()` and proves that a mod unloaded mid-flight schedules nothing further.
- Edge cases / failure handling: `createOn` refuses everything `claude plugin validate` refuses, exercised through an untyped call (`loose(42, noop)`) because a JavaScript mod can pass anything. The engine's own `state.get` with a non-string plugin/key throws *"`$.state` needs `{ plugin, key }` strings"*.
- Surprising: `$` is read-only in practice — the test asserts `first.env = {}` throws a `TypeError`, and `Object.defineProperty(first, 'extra', …)` throws too.

### packages/experimental/claude-code-mods/tests/host-ops.spec.ts
- Purpose: 333-line unit suite for the host op table against **bare and partially composed** contexts.
- Key abstractions: `setup(ctx)` builds an op table plus a `ModsEngine` over it; `fakeAgent(ctx, overrides)` fabricates an `Agent` with the session facts the ops read.
- Data flow: `call(op, input, agent)` invokes an op directly, bypassing the chain.
- Non-obvious design decisions: The "services a deployment did not compose" test asserts the **exact** error text for each missing service (`/dsh-user-questions/`, `/dsh-commands/`, `/dsh-tools/`, `/dsh-storage-domain/`, `/dsh-fs/`, `/dsh-subprocess/`, `/turnBoundary projection/`) — the gap is named, not generic. The store-limit test proves the limit is **UTF-8 bytes** (1.5 MiB of CJK is refused, 1.5 MiB of ASCII is not) and that concurrent writes to one plugin's record are serialised so neither update is lost.
- Edge cases / failure handling: The Windows-specific `proc_pidpath` behaviour is noted (`realpath` expands Windows short-name temp paths before exact cwd comparisons). The POSIX signal branch is explicitly conditioned on `process.platform !== 'win32'` with the reason "POSIX coverage owns this branch".
- Surprising: The "committed directory owner" test changes the working directory **between** the `lstat` and the resolve, to prove the resolution uses the *committed* directory and not a stale one.

### packages/experimental/claude-code-mods/tests/surfaces.spec.ts
- Purpose: 144-line unit suite for `SurfaceTable`.
- Key abstractions: `table(render, runAction)` builds a `SurfaceTable` over a fake host.
- Data flow: `surfaces.current(id)`, `surfaces.refresh(id)`, `surfaces.press(id, generation, actionId)`, `surfaces.stateRead/stateWritten`, `surfaces.watch(id, signal)`.
- Non-obvious design decisions: The coalescing test asserts `b !== a` and `c === b` — two refreshes during one in-flight pass share **one** additional pass, and `renders` is exactly 2. The unchanged-tree test asserts the generation stays 1 while the callbacks are replaced.
- Edge cases / failure handling: A failed render and an invalid tree both become an **empty band** plus a report. A press on an unknown action id is reported, not thrown.
- Surprising: `forget` then `refresh` then `current` gives `generation: 0` — a forgotten session's band is genuinely gone, not a stale cache.

- Purpose: 255-line unit suite for the test kit.
- Key abstractions: `firstMod()` re-imports the tutorial fixture with a cache-buster; `kit.on`, `kit.raise`, `kit.$`, `kit.reports`, `kit.mods`.
- Data flow: `kit.$.tool.call({tool:'Bash',command:'ls'})` → the mod's `tool.call` hook → the stub.
- Non-obvious design decisions: The kit's `reports` array is the audit trail: a fire-and-forget `$.ui.toast` nobody answered appears as `"stateful: $.ui.toast failed: no implementation for ui.toast"`. `mock.clock` is a settable instant that advances on `sleep`.
- Edge cases / failure handling: A stub that returns a bare value, or `{nothing:true}`, is rejected with *"returned neither `{ value }` nor `{ deny }`"*.
- Surprising: The kit answers `ui.open` with `{isPlaced:false}` and `ui.close` itself — the same degraded behaviour as the real host, so a mod that degrades to the band behaves identically under test.

### packages/experimental/claude-code-mods/tests/testing.spec.ts
- Purpose: 255-line unit suite for the test kit.
- Key abstractions: `firstMod()` re-imports the tutorial fixture with a cache-buster so its module-level counter starts at zero; `kit.on`, `kit.raise`, `kit.$`, `kit.reports`, `kit.mods`.
- Data flow: `kit.$.tool.call({tool:'Bash',command:'ls'})` → the mod's `tool.call` hook → the stub.
- Non-obvious design decisions: The kit's `reports` array is the audit trail: a fire-and-forget `$.ui.toast` nobody answered appears as `"stateful: $.ui.toast failed: no implementation for ui.toast"`. `mock.clock` is a settable instant that advances on `sleep`.
- Edge cases / failure handling: A stub that returns a bare value, or `{nothing:true}`, is rejected with *"returned neither `{ value }` nor `{ deny }`"*.
- Surprising: The kit answers `ui.open` with `{isPlaced:false}` and `ui.close` itself — the same degraded behaviour as the real host, so a mod that degrades to the band behaves identically under test.

### packages/experimental/claude-code-mods/tests/define-mod.spec.ts
- Purpose: 80-line unit suite for `defineMod`.
- Key abstractions: `defineMod({name, version, root, userConfig, register})`; the plugin shape.
- Data flow: `ctx.plugin(plugin, {history: 3})` → `apply` → `ctx.claudeCodeMods.add(...)` → `register(on, {history:3, unit:'tokens'})`.
- Non-obvious design decisions: The test asserts the **definition's own keys** — `['name','options','register']` when the spec names no version and no root — so a new field cannot be added to the definition silently.
- Edge cases / failure handling: A mod whose plugin is disposed *while `register` is still running* is removed anyway: the test releases the register promise after `fiber.dispose()` and waits for `ctx.claudeCodeMods.mods` to be empty.
- Surprising: `plugin.Config({})` returns `{}` and `plugin.Config({history:{nested:true}})` **throws** — the option value type is enforced at the composition boundary, before any mod code runs.

### packages/experimental/claude-code-mods/tests/matcher.spec.ts
- Purpose: 58-line unit suite for the event patterns, the field matchers and the tool-name aliases.
- Key abstractions: `KNOWN_EVENTS`, `isEventPattern`, `eventMatches`, `matcherMatches`, `describeMatcher`, `createToolNameAliases`.
- Data flow: `matcherMatches({tool:'Bash'}, {tool:'mcp__github__issues'})` → false.
- Non-obvious design decisions: `isEventPattern('classic.*')` is false and `isEventPattern('.*')` is false — the namespace must be non-empty *and known*. `describeMatcher({tool:['Edit','Write'], id:/^T-/})` renders `{tool=Edit|Write,id=/^T-/}` exactly as `claude plugin validate` prints it.
- Edge cases / failure handling: `matcherMatches({tool:'x'}, 'not an object')` is false — a non-object input matches nothing rather than everything.
- Surprising: An override in `createToolNameAliases` replaces the default in *both* directions (`{Bash:'pwsh'}` makes `toMod('pwsh') === 'Bash'`), and an unaliased name falls back to itself in both directions.

### packages/experimental/claude-code-mods/tests/elements.spec.ts
- Purpose: 54-line unit suite for the element vocabulary.
- Key abstractions: `uiElements()`, `treeProblem`, `serializeTree`, `findAll`, `renderText`, `isUiElement`.
- Data flow: `serializeTree(tree, cb)` — the callback is the `holdAction` that stores the callback and returns an id.
- Non-obvious design decisions: `isUiElement({type:'Text',props:{}})` is **false** — the brand symbol means a hand-made object cannot pass as a constructor-made element. `renderText` joins top-level nodes with `\n` and child text with nothing (`'☀  Clear  18% of context\nProceedCancel'`).
- Edge cases / failure handling: `treeProblem` on a raw object reports *"a tree node is object, not an element, text, or a list of them"*.
- Surprising: `scalarProps` silently drops non-scalar props — the test asserts `color: undefined` is absent from the serialised output.


### packages/experimental/claude-code-mods/tests/directory-resume.spec.ts
- Purpose: 58-line test that a persisted session's resume reports the *final committed* cwd while keeping the original project root.
- Key abstractions: `JsonlSessionPersistence` (the real persistence owner), `WorkingDirectory`.
- Data flow: Create a session at `origin`, set the working directory to `current`, dispose; then in a *second* context `agents.resume({resumeSessionId})` and observe the mod's `session.start` payload.
- Non-obvious design decisions: The assertion is a two-element array — `[{cwd: origin, root: origin, payload: origin}, {cwd: current, root: origin, payload: current}]` — so the *first* run's cwd and the *resumed* run's cwd are visibly different while the root is unchanged.
- Edge cases / failure handling: The two contexts are torn down in reverse order in a `finally`.
- Surprising: `payload` (the `session.start` event's `cwd`) equals `$.session.cwd()` in both runs — the bridge's event payload and its API fact agree.

### packages/experimental/claude-code-mods/tests/loader-composition.spec.ts
- Purpose: 85-line test that the bridge mounts from a **real** `cordis.yml` row beside the shipped core plugins.
- Key abstractions: A `modules` map of package name → plugin; `Loader` + `Include`; `context.loader.builtins.include = Include`; `context.loader.internal = undefined`.
- Data flow: Write a `cordis.yml` listing 11 packages plus the fixture mod's file URL with a `config.greeting`; `context.loader.create({name:'cordis:include', config:{path}})`; then the real agent loop runs against a `MockAdapter`.
- Non-obvious design decisions: *"Without a Node internal loader the Loader imports bare names through this test runner's module graph, which resolves workspace packages to `src`."* The composition is therefore real, not mocked.
- Edge cases / failure handling: The mod's `config` is applied through the same overlay path a real composition uses.
- Surprising: The `/tally` answer is `"first-mod: The model made 1 tool calls since this mod loaded"` — the mod's own `options.greeting` came from `cordis.yml`, not from the fixture.

### packages/experimental/claude-code-mods/tests/examples.spec.ts
- Purpose: 13-line spec that runs the three example mods' own `claude plugin test` files.
- Key abstractions: A dynamic `import()` loop over `['token-weather','blast-radius','replay-theater']`.
- Data flow: Each example's `tests/<name>.test.ts` is imported; the file's outermost `describe` names the directory the test kit loads.
- Non-obvious design decisions: The docstring explains the whole file: *"run as this package's spec so the coverage lane, which inventories `*.spec.ts` only, sees them"*, and *"The imports are computed so the Host typecheck project keeps the published tests out of its file list."*
- Edge cases / failure handling: n/a.
- Surprising: A 13-line file exists purely to make a coverage tool see files it would otherwise miss — the tool's blind spot is worked around rather than the tool changed.

### packages/experimental/claude-code-mods/tests/support/claude-code-testing.ts
- Purpose: 83-line implementation of `claude-code/testing` for this repository — Claude Code's `describe`, `test`, `expect`, `mock` and `tier`.
- Key abstractions: `defineModTests(resolver)`; `inferMod(testPath, testName)`; `ModTestBody = ($, on, kit) => …`.
- Data flow: `test(name, body)` reads Vitest's `getState()` for `testPath` and `currentTestName`, infers the mod (the plugin two directories above a `<mod>/tests/<name>.test.ts`, or the example named by the outermost `describe`), creates a fresh kit, runs the body, and disposes the kit in a `finally`.
- Non-obvious design decisions: `tier(_tier)` is a **no-op** that exists for source compatibility — "This host loads every mod as `user`". The mod is inferred from the *test file's location* or the *describe name*, so a published test file runs unchanged.
- Edge cases / failure handling: A directory whose `index.ts` does not default-export a `defineMod` plugin throws a named error.
- Surprising: A fresh kit per test case — the mod's module-level variables start over, exactly as a Claude Code reload would.

### packages/experimental/claude-code-mods/tests/support/claude-code.ts
- Purpose: 12-line stand-in for the `claude-code` module a mod's `types/index.d.ts` augments.
- Key abstractions: `export interface PluginState {}`; re-exports `On`, `Register`, `Api`.
- Data flow: A mod's `declare module 'claude-code' { interface PluginState { … } }` merges into this empty interface.
- Non-obvious design decisions: *"This host reads no declarations; the module exists so the example mods' type contracts compile unchanged."* The type surface exists purely for compatibility, and the docstring says so.
- Edge cases / failure handling: n/a.
- Surprising: The smallest file in the shard is a **type-only compatibility shim** — a whole module that exists to make someone else's file compile.

### packages/experimental/claude-code-mods/tests/fixtures/first-mod.ts
The Claude Code tutorial's first mod wrapped as a DSH plugin, with `userConfig: {greeting: 'Claude has made'}`.

### packages/experimental/claude-code-mods/tests/fixtures/first-mod.mjs
The tutorial mod unchanged except for a configurable greeting. It counts tool calls, registers `/tally` at `session.start`, and restyles the spinner via `on('ui.render', {component:'Spinner'})` — *"a render site this bridge never raises"*, i.e. the fixture deliberately registers a hook that will never fire. Non-obvious: that hook is the canary for the unserved-event reporting path — it registers fine and is named in the load warning.

### packages/experimental/claude-code-mods/tests/fixtures/first-mod.d.mts
`ModRegister` type contract.

### packages/experimental/claude-code-mods/tests/fixtures/guard-mod.ts
A mod that refuses risky Bash commands and **fails closed** when the guard itself breaks.

### packages/experimental/claude-code-mods/tests/fixtures/guard-mod.mjs
`RISKY = /\bgit\s+push\b.*--force|\brm\s+-rf?\b/`. A `tool.call` hook on `Bash` refuses a risky command with `{deny: 'guard-mod refused this command: …'}`; `e.command === 'explode'` throws; and the registration carries a `.catch` handler that answers `{deny: 'The command guard failed, so this command was not run: ' + next.error.kind}`. Non-obvious: **failing closed through `.catch` is the pattern** — the fixture's own docstring says *"refuse a force push, log what ran, and fail closed through `.catch`"*.

### packages/experimental/claude-code-mods/tests/fixtures/guard-mod.d.mts
`ModRegister` type contract.

### packages/experimental/claude-code-mods/tests/fixtures/ticket-mod.ts
A mod that registers a tool, adds context to prompts, and times turns.

### packages/experimental/claude-code-mods/tests/fixtures/ticket-mod.mjs
Registers a `ticket` tool at `session.start`; answers `on('tool.call', {tool:'mcp__ticket-mod__ticket'})`; a `prompt.submit` hook that adds `'Current branch: feature/mods'` to `e.context` when the prompt mentions PR/pull request; a `turn.complete` hook that returns a `{text}` line. Non-obvious: the comment *"The full tool name is mcp__, the plugin's name, and the registered name"* is the mod-registered tool naming convention stated in one line.

### packages/experimental/claude-code-mods/tests/fixtures/ticket-mod.d.mts
`ModRegister` type contract.

---

**Package: `packages/experimental/cua-macos`**

### packages/experimental/cua-macos/package.json
- Purpose: Manifest for `@deepseek-ai/dsh-experimental-cua-macos` v0.2.1-rc.2.
- Key abstractions: `exports` publishes `.` and `./src/*`; `files` ships `native/bin`, `native/Package.swift`, `native/Sources`, `native/tests/swift`, `native/tests/test_swift.py`, the MIT notice, `upstream.json`, both native READMEs and `protocol.schema.json`.
- Data flow: Depends on `@deepseek-ai/dsh-cua` and `dsh-atomic-write`; peers on `dsh-computer-use`, `dsh-system-prompt`, `dsh-tools`, `dsh-agent`, `dsh-subprocess`, `dsh-user-questions`.
- Non-obvious design decisions: The `files` list ships the **Swift sources and the Swift test target** to consumers — the native helper is buildable from the installed package.
- Edge cases / failure handling: The only script is `build:native` = `swift build --package-path native --configuration release`.
- Surprising: `sharp` is a **devDependency** — the large-image test needs it, the package does not.

### packages/experimental/cua-macos/tsconfig.json
- Purpose: 24-line project config; `rootDir: src`, `outDir: lib/types`, four references.
- Key abstractions: References to `vendor/cordis`, `../cua`, `../../subprocess/subprocess`, `../../util/atomic-write`.
- Data flow: n/a.
- Non-obvious design decisions: Only four references — the package's *own* source depends on four projects, while its *dev* dependencies (Sharp, PTC runtime, sandbox) are many. The dependency surface of the shipped code is small.
- Edge cases / failure handling: n/a.
- Surprising: The `native/` directory (Swift + `generate-protocol.ts`) is **outside** `rootDir: src`, so it is not compiled by this project — it is a separate tool.

### packages/experimental/cua-macos/README.md
- Purpose: 226-line package reference for the macOS provider; the specification of the model-facing behaviour.
- Key abstractions: A 14-row config table (`allowedApps`, `helperPath`, `buildTimeoutMs` 300000, `timeoutMs` 30000, `connectTimeoutMs` 5000, `screenshotTimeoutMs` 5000, `axTimeoutMs` 3000, `maxRequestBytes`/`maxResponseBytes` 1 MiB/32 MiB, `maxClipboardBytes` 32 MiB, `pasteReadTimeoutMs` 1000, `maxAppMatches` 20, `maxElements`/`maxDepth` 2000/25, `dragDurationMs`/`dragSteps` 400/20, `textEventIntervalMs` 0.25).
- Data flow: `getCapabilities` → `listApps`/`getState` → `getApp` (which requests consent) → `listWindows`/`getState` → input.
- Non-obvious design decisions: The "Model Experience" section prints the **entire model guidance verbatim** in a fenced block, so the prompt the model receives is reviewable in the docs. The guidance's spine is: *"A successful action means dispatched, not verified"*, *"never retry uncertain input without observing"*, and *"After input, read fresh state to verify the effect."* It also states that the model should **not** activate or raise an app during initialization or before each action — background observation is preferred.
- Edge cases / failure handling: A long stable error-code vocabulary is documented in prose: `STALE_APP`, `STALE_SNAPSHOT`, `SCREENSHOT_REQUIRED`, `WINDOW_CHANGED`, `PERMISSION_DENIED`, `FOREGROUND_REQUIRED`, `AMBIGUOUS_TEXT`, `TEXT_NOT_FOUND`, `SELECTION_CHANGED`, `PASTE_NOT_CONSUMED`, `CLIPBOARD_CHANGED`, `CAPTURE_BUSY`, `SESSION_LOCKED`, `APP_UNAVAILABLE`, `AMBIGUOUS_APP`, `WINDOW_UNAVAILABLE`, `PANEL_NOT_READY`.
- Surprising: "The object API can be retained by an external persistent execution environment. … This package owns neither a PTC runtime nor variable persistence." — the provider deliberately refuses to own state it cannot guarantee.

### packages/experimental/cua-macos/README.zh.md
- Purpose: 226-line Chinese translation of the provider reference.
- Key abstractions: Mirrors the English section-for-section, same config table, same error vocabulary.
- Data flow: Same.
- Non-obvious design decisions: Keeps the English anchor ids so cross-language links resolve identically; the long verbatim guidance block is translated in place rather than linked out.
- Edge cases / failure handling: The per-section hash record (`README.i18n.yaml`) detects one-sided edits.
- Surprising: The zh text translates the *error codes* as prose but keeps the code identifiers in English backticks.

### packages/experimental/cua-macos/README.i18n.yaml
- Purpose: 52-line bilingual-pairing consistency record for the provider README.
- Key abstractions: 13 section entries, each with `en:`/`zh:` hashes.
- Data flow: Regenerated by `pnpm run verify-translation-pairing --write packages/experimental/cua-macos/README.md`.
- Non-obvious design decisions: The hash granularity is per heading section, so the very long "Operation guidance (verbatim)" block is one section.
- Edge cases / failure handling: n/a.
- Surprising: The identical file appears in three packages in this shard — a repo-wide convention.

### packages/experimental/cua-macos/examples/macos.cordis.yml
- Purpose: 7-line overlay that mounts the computer-use registry and this provider.
- Key abstractions: `insert:` with `cua-provider-registry` and `cua`; the provider's `helperPath` comes from `process.env.DSH_CUA_HELPER` through a YAML `!!js` tag.
- Data flow: `pnpm dsh headless --patch .../macos.cordis.yml --dump-config` checks the composition without a model request.
- Non-obvious design decisions: The helper path is supplied by an **environment variable at composition time**, not baked in — so the same overlay works for a source build and a packaged one.
- Edge cases / failure handling: A missing `DSH_CUA_HELPER` yields an undefined `helperPath`, and `src/index.ts` then falls back to building the native helper itself.
- Surprising: `!!js` in a YAML overlay — the config file is evaluated, not merely parsed.

### packages/experimental/cua-macos/examples/persistent-ptc.cordis.yml
- Purpose: 6-line overlay enabling persistent in-memory PTC and PTC tool mode.
- Key abstractions: `ptc-runtime` with `executionMode: persistent-in-memory`; `tools` with `mode: ptc`.
- Data flow: Added *after* the macOS overlay, it makes the CUA tool reachable through `run_code` as `tools.cua`.
- Non-obvious design decisions: The provider keeps variables for the live Agent and applies the selected file sandbox policy — the PTC runtime, not the provider, owns variable lifetime.
- Edge cases / failure handling: n/a.
- Surprising: Two lines, and they are the difference between "the model calls a tool" and "the model writes code that holds an application object across turns".

### packages/experimental/cua-macos/src/index.ts
- Purpose: The loader plugin for the macOS native provider.
- Key abstractions: `name = 'experimental-cua-macos'`; `inject = ['computerUse','tools','systemPrompt','subprocess','agents']`; `Config = CuaConfig`; `apply(ctx, config)`.
- Data flow: If `config.helperPath` is set, it must be **absolute** and is used directly; otherwise `nativeHostArchitecture` validates the host, `prepareNativeExecutable` builds/returns the binary, and `installCua(ctx, config, {helperPath, createChannel, guidance, description})` registers the tool.
- Non-obvious design decisions: The `ctx.effect` disposer **aborts the preparation signal first** and then awaits the preparation promise, with the comment *"The Loader receives preparation failures through apply; disposal only awaits quiescence."* A cancelled preparation therefore never publishes a late success.
- Edge cases / failure handling: A relative `helperPath` throws *"`dsh-cua` helperPath must be absolute"*.
- Surprising: The `description` string the provider hands the registry is a **one-line instruction to the model**: *"Inspect macOS permissions, select an application and window, read AX state, capture screenshots or dispatch input. Use appHandle from getApp; verify actions by reading fresh state."*

### packages/experimental/cua-macos/src/guidance.ts
- Purpose: The model-facing operation guidance, 44 lines of one exported string.
- Key abstractions: `export const GUIDANCE = "…"`, re-exported from `src/index.ts`.
- Data flow: `installCua(..., {guidance: GUIDANCE, ...})` puts it in the tool's description / system-prompt section.
- Non-obvious design decisions: The guidance is written as a **procedure with named error codes**, and it says the uncomfortable things plainly: *"A null `sessionLocked` means no usable console session was verified"*, *"If access is denied or revoked, stop using that application until the user explicitly grants access again. Never switch tools to bypass a refusal"*, *"A bare number such as `hover(650)` is always an AX element index"*, and *"A successful action means dispatched, not verified."* It also warns about declared-but-unknown state: *"Writability is true, false or unknown on relevant controls; omitted state fields do not assert false."*
- Edge cases / failure handling: Every failure mode in the vocabulary is given a *next action* (`STALE_APP` requires getApp again; `STALE_SNAPSHOT` requires getState again; `PERMISSION_DENIED` requires a human grant, and *"do not automatically replay prior input"*).
- Surprising: The guidance also teaches the model to *avoid* activation: *"Do not activate or raise an app during initialization, before each action, or merely because another app is foreground."* — an anti-pattern instruction, which is rare and valuable.

### packages/experimental/cua-macos/src/native-build.ts
- Purpose: Source-checkout preparation and installed-payload resolution for the native helper.
- Key abstractions: `NativeArchitecture = 'arm64' | 'x64'`; `NativeBuildSpec`; `nativeHostArchitecture(platform, arch)`; `nativeExecutablePath(root, arch)`; `isSourcePackage(root)`; `buildNativeExecutable(spec)`; `prepareNativeExecutable(spec)`.
- Data flow: `buildNativeExecutable` takes a file lock on the executable path, runs `/usr/bin/xcrun swift build --package-path native --scratch-path native/.build/runtime-<arch> --configuration release --product dsh-cua-native --arch <x86_64|arm64>`, reads the built binary, writes it atomically to `native/bin/darwin-<arch>/dsh-cua-native` **only if the bytes changed**, then publishes a **content-addressed** copy at `native/.build/prepared/<arch>/<sha256>/dsh-cua-native`.
- Non-obvious design decisions: The content-addressed generation is the important one: *"It updates the package payload and runs a content-addressed copy under native/.build/prepared, preserving executable files used by earlier source-runtime processes."* A running process keeps its own bytes; a new build publishes a new generation. A retained copy whose bytes do **not** match its digest is refused (*"Computer Use retained executable does not match its content digest"*) rather than used. `isSourcePackage` refuses to compile unless the package really is a DSH source checkout (it checks the root manifest's name is `@deepseek-ai/dsh-root`).
- Edge cases / failure handling: The compiler's `terminate()` and `waitForExit()` always run in a `finally`; a cancellation after the build refuses to publish. An `EISDIR` at the target path is *not* treated as "file missing" — the test pins this. The build is serialised by `withFileLock` so a competing preparation cancels without starting a second compiler.
- Surprising: `nativeHostArchitecture` throws *"Computer Use currently requires macOS on Apple silicon or Intel. Windows support is in development"* — the platform gate is a **named message**, not a silent no-op.

### packages/experimental/cua-macos/src/shared-native.ts
- Purpose: Per-Agent byte connections to the per-user native screenshot process.
- Key abstractions: `SharedNativeChannel implements NativeChannel`; `NativeClientConfig`; `Ready` / `Refusal` zod schemas; `handshakeByteLimit = 8192`; `RuntimeLocation {helperPath, runtimeKey, directory}`.
- Data flow: `prepare()` resolves the helper's real path, hashes it (SHA-256 = the runtime key), creates `/tmp/dsh-cua-<uid>` mode 0700 and **verifies** it. `ensureShared()` spawns `<helper> --ensure-shared --runtime-key <key> --runtime-directory <dir> --startup-timeout-ms N` and waits for **both** the launcher's exit and its managed process range. `connectOnce()` opens the Unix socket, sends a protocol-1 `hello`, and waits for a `ready` frame whose `runtimeKey` must match. `connect()` retries the pair (ensure + connect) because *"A server can exit with its last client before admitting this connection."*
- Non-obvious design decisions: The **runtime directory is validated before any native code runs**: it must be a real directory, owned by the current uid, and mode exactly 0700 — a symlink, a file, a 0755 directory or a foreign owner is refused with `NATIVE_RUNTIME_DIRECTORY` and **no process is spawned**. The handshake is bounded at 8192 bytes and parsed with `TextDecoder('utf-8', {fatal:true})` so invalid UTF-8 is a protocol error, not a silent substitution.
- Edge cases / failure handling: `close()` before ready aborts startup and terminates the launcher; after ready it half-closes the socket and arms a `graceMs` cleanup timer that destroys the socket with a `NATIVE_CLEANUP` error if the peer never acknowledges. A refused handshake (`{"type":"error",...}`) is surfaced with the helper's own code. Writes after close are rejected with `NATIVE_CLOSED`. A non-Error rejection is wrapped with `code: 'NATIVE_CONNECT'` and the original as `cause`.
- Surprising: The client **never replays an operation** — `connect()` may retry the *connection*, but the first byte of an operation is written only after the handshake succeeded, and a pre-ready EOF/RESET is retried without sending anything.

### packages/experimental/cua-macos/tests/native-build.spec.ts
- Purpose: 179-line unit suite for the native preparation, with a mocked subprocess runtime.
- Key abstractions: `fixture(diagnostics)` fabricates a `SubprocessRuntime` whose `spawn` writes a fake binary into the scratch path.
- Data flow: `buildNativeExecutable(spec)` → spawn → `done` → publish.
- Non-obvious design decisions: The suite pins the *inode* of the published executable to prove that an unchanged build does **not** rewrite the file (*"leaves an unchanged executable inode intact"*) — a rewrite would break a running process's `/proc`-style references. It also pins that a failed build **keeps the previous executable** and reports the compiler's stderr.
- Edge cases / failure handling: Cancellation is proven to abort *before* publication (the target does not exist afterwards). A rejected `waitForExit` is surfaced. Two concurrent preparations are serialised by the file lock: the second is cancelled and **no second compiler starts**.
- Surprising: *"keeps running generations immutable while publishing a newer package payload"* — the test asserts the old path still holds the old bytes with the old inode.

### packages/experimental/cua-macos/tests/shared-native.spec.ts
- Purpose: 563-line suite over **real Unix sockets** exercising connection isolation and native startup ownership.
- Key abstractions: `vi.mock('node:fs/promises')` and `vi.mock('node:path')` redirect the runtime directory path; `fixture(options)` builds a real `net.createServer` on a Unix socket; `nextBytes(channel, lines)` reads N newline-framed replies.
- Data flow: `f.open()` → `createSharedNativeChannel({subprocess:{spawn}}, config)` → launcher spawn → connect → `hello` → `ready` → operations.
- Non-obvious design decisions: The handshake table is the centre of the file: seven bad handshakes (wrong protocol version, wrong runtime key, broken JSON, invalid UTF-8, oversized frame, a structured refusal, a refusal whose code is `NATIVE_EOF`) each must be rejected **before any operation byte is written** (`expect(f.operations).toHaveLength(0)`). The runtime-directory table proves a symlink / file / 0755 / foreign-owner directory is refused **without launching native code** (`expect(f.spawn).not.toHaveBeenCalled()`).
- Edge cases / failure handling: A peer that accepts the socket but never completes the handshake is bounded by `connectTimeoutMs` → `NATIVE_CONNECT_TIMEOUT`. A peer that exits with its last client between `--ensure-shared` and `connect` is retried with a **replacement server**. A pre-ready EOF *or* `ECONNRESET` is retried without sending or replaying an operation (the test injects the `error` event because "Unix kernels differ in reporting close as EOF or ECONNRESET").
- Surprising: *"removes the ready frame while preserving response bytes from its final chunk"* — the test writes the `ready` frame in two pieces and asserts the client's byte-level framing does not lose the operation reply that followed in the same chunk.

### packages/experimental/cua-macos/tests/provider-lifecycle.spec.ts
- Purpose: 700-line suite proving that native helper replacement is synchronised with **Agent and provider disposal**.
- Key abstractions: `vi.mock('../src/native-build.ts')` and `vi.mock('@deepseek-ai/dsh-cua/native-client')`; `setup(model?)`; `selectApplication(f)`; `config` / `automaticConfig`.
- Data flow: `f.execute(method, params)` → `ctx.tools.execute({agent, callId, name:'cua', arguments:{method, params}})` → the mocked `NativeClient.request`.
- Non-obvious design decisions: The disposal semantics are the whole point: *"keeps Agent disposal pending until its helper cleanup completes"* — the test asserts `disposed === false` while the cleanup barrier is held, then true after release. *"joins helper cleanup already started by Agent disposal when the provider unloads"* asserts `native.dispose` was called **once** for two owners. *"reports failed cleanup after waiting for other owners"* asserts the failure is reported as an `AggregateError` **after** the other owners' Agent effects are released, and that the tools are unregistered.
- Edge cases / failure handling: Screenshot admission is refused for four route states (`unresolved`, `unknown`, `text-only`, `provider-error`) **before** the native call is made. A screenshot whose declared pixel dimensions disagree with the decoded bytes is refused (*"dimensions disagree"*) and **no image block is emitted**. A screenshot with no attachment store mounted is refused (*"require an attachment store"*).
- Surprising: The coordinate-mapping test proves the Host maps **actual model-request image pixels** back to native points: the model asked for a 10×5 image from a 40×20 source, and the click at (5, 2.5) was dispatched to the native as (200, 100) — the resized image's coordinates, not the raw ones. It also proves the image is stored **once** (`saveImages` called once).

### packages/experimental/cua-macos/tests/loader-composition.spec.ts
- Purpose: 207-line suite over a real `Loader` composition with a real agent loop and a POSIX fixture helper.
- Key abstractions: `VisualModel` (a scripted `LlmAdapter`); `AuditEvent` (a zod schema for the fixture's own event log); `installNativeFixture` / `startFixtureHost`.
- Data flow: Six scripted `cua` calls (`getCapabilities`, `getApp`, `getState`, `click`, `getState`, `screenshot`) → the fixture writes `helper-events.jsonl` → the test reads it back.
- Non-obvious design decisions: The test asserts the native request IDs equal the **logged tool call IDs** (`events.map(requestId)` vs `agent.session.snapshotEvents().filter(e => e.type === 'tool/call').map(e => e.data.callId)`) — the native trace and the transcript are the same identifiers. It also proves the screenshot is admitted as an **attachment** and the base64 is *not* duplicated into the tool message (`expect(JSON.stringify(toolMessages)).not.toContain(png)`).
- Edge cases / failure handling: Two agents share **one helper process** (`new Set(events.map(e => e.pid)).size === 1`) but hold **different app handles** (`peerApp.appHandle !== retainedApp.appHandle`) and their own connections (`connect` count 2). Disposing one agent does **not** exit the shared process (`exit` count 0, `disconnect` count 1); disposing the second does.
- Surprising: A *new* agent's stale handle is refused with `APP_ACCESS_REQUIRED` and **no new helper is started**; the grant must be re-selected, and only then does a **new** helper process start (`start` count 2, different PIDs).

### packages/experimental/cua-macos/tests/large-image-ptc.spec.ts
- Purpose: 193-line suite proving a valid PNG **larger than 4 MiB** travels through disk storage and a real Node PTC process into the next model image request.
- Key abstractions: `sharp` for a deterministic 2048×1024 uncompressed PNG; `prepareImages` / `inlineImages` / `serialize` from `dsh-llm-deepseek`; `resolveRequestImageTarget`.
- Data flow: The model calls `run_code` with `tools.cua({method:'screenshot'})` → the PTC process → the tool result carries the image → the next model request inlines it.
- Non-obvious design decisions: The PNG is generated with `compressionLevel: 0` so its size is deterministic without private screenshots or random pixels. The test asserts the base64 is **not** inlined into the transcript twice (`expect(JSON.stringify(model.requests[1]?.messages)).not.toContain(source.toString('base64'))`).
- Edge cases / failure handling: The `tool/ptc-dispatch` events are inspected to confirm the image reached the model as an attachment reference, and the stored bytes are decoded with `sharp` to confirm the raster survived the round trip.
- Surprising: The assertion that the *decoded* dominant colour is within 4/255 of the source proves the image was not silently re-encoded or colour-shifted by the admission path.

### packages/experimental/cua-macos/tests/persistent-bridge.built.e2e.ts
- Purpose: 96-line built-lane test: the installation-owned bridge is imported **from a project outside the Harness installation** and retained objects work.
- Key abstractions: `bridge = ../../cua/lib/bridge.js`; `bootstrap = .../ptc-runtime-node/lib/persistent-process.js`; `NodeRuntime` in `persistent-in-memory` mode.
- Data flow: The system prompt's `computer-use:dsh-cua` section carries a *Persistent PTC initialization:* line naming the bridge file URL; the PTC program imports that URL, calls `cua.getApp(...)`, `app.getWindow(7)`, `win.click(0)`, `win.getScreenshot()`.
- Non-obvious design decisions: The test first proves the project **cannot** resolve the package directly (`expect(...).toContain('Cannot find package')`) and only then uses the installation-owned path — that is the point of the bridge. It also checks the error text of a bad call: it must contain *"findApps query: Expected a non-empty search string"* and must **not** contain `ZodError` or `"origin"` — a user-facing message, not a schema dump.
- Edge cases / failure handling: The invalid call must produce **zero** native calls (`calls.filter(c => c.phase === 'invalid')` is empty) — validation happens before dispatch.
- Surprising: The bridge URL is delivered *in the system prompt*, so a project that never installs the package can still use the object API.

### packages/experimental/cua-macos/tests/native-fixture.ts
- Purpose: 16-line helper giving each test a fixture helper with a unique identity.
- Key abstractions: `installNativeFixture(root)` copies the snapshot fixture and appends a comment naming the directory; `startFixtureHost` is re-exported from `snapshots/session/cua-native/fixture-host.mjs`.
- Data flow: The copy's *content* differs per test, so its SHA-256 (the runtime key) differs, so each test gets its own socket and its own shared process.
- Non-obvious design decisions: The uniqueness is achieved by **changing the file's bytes** (a trailing comment), not by passing a flag — because the runtime key is the hash of the executable.
- Edge cases / failure handling: The file is written with mode 0700.
- Surprising: A test-only comment line is what makes the per-test isolation work.

### packages/experimental/cua-macos/tests/protocol-generation.spec.ts
- Purpose: 24-line spec proving the generated native artifacts are current and that Host-only request data is rejected at model admission.
- Key abstractions: `renderNativeProtocol()` from `native/generate-protocol.ts`; `Request` from `@deepseek-ai/dsh-cua/protocol`.
- Data flow: `renderNativeProtocol()` is compared byte-for-byte against `native/protocol.schema.json` and `native/Sources/CuaNative/NativeProtocol.generated.swift`.
- Non-obvious design decisions: The second test asserts that six Host-only shapes (a resource bound, a drag's `steps`, `paste`'s `maxClipboardBytes`, `pasteReadTimeoutMs`, `findApps`'s `maxAppMatches`, and `launchApp` itself) are **rejected by the model-facing Zod schema**. The model cannot name a Host resource.
- Edge cases / failure handling: n/a.
- Surprising: 24 lines enforce that the *model's* schema and the *native's* admission table cannot drift — one generated source, two checked artifacts.

### packages/experimental/cua-macos/native/generate-protocol.ts
- Purpose: Derive the native JSON Schema and the Swift field/enum admission tables from the shared model and Host-only Zod definitions.
- Key abstractions: `renderNativeProtocol(): {json, swift}`; `NativeOnlyOperations`; `NativeResourceParameters`; `Request.options`.
- Data flow: For each schema it strips the `relative: true` variant (the Host resolves image pixels and relative coordinates before native dispatch), merges the Host-only resource fields into the *native* variant, forces `required: ['id','method','params']`, and collects the per-method field sets and string enums. The Swift output is a deterministic, sorted `enum NativeProtocol { modelMethods, fields, stringEnums }`.
- Non-obvious design decisions: The `relative` handling is the subtle one: the model may *offer* `relative: true`, but the **Host** resolves it, so the native schema drops that variant and the native never sees a relative coordinate. Host-only fields are added to the native schema but are **not** in the model schema — and `tests/protocol-generation.spec.ts` proves the model schema refuses them.
- Edge cases / failure handling: `import.meta.main` plus a `--check` flag makes the generator usable as a freshness gate; the package test lane compares the artifacts instead.
- Surprising: The generator's comment says *"Render deterministic native artifacts; platform actions and lifecycle remain handwritten"* — the wire contract is generated, the behaviour is not.

### packages/experimental/cua-macos/native/protocol.schema.json
- Purpose: The generated JSON Schema (1030 lines) for the native request envelope.
- Key abstractions: A `oneOf` of per-method object schemas, each `{id, method, params}` with `additionalProperties: false`.
- Data flow: Produced by `generate-protocol.ts`; consumed by anything that wants to validate a native frame.
- Non-obvious design decisions: The `$comment` says *"Generated by native/generate-protocol.ts from src/protocol.ts. Do not edit."*, and the `description` states the semantics: *"Host resource fields and private continuations are not model tool parameters. App handles and snapshots belong to one helper; coordinates are window-local macOS points."*
- Edge cases / failure handling: `additionalProperties: false` on every variant is what makes an unknown field an admission error rather than a silently ignored one.
- Surprising: The schema is the **contract in one file**: the model schema, the native admission table, and the Host-only continuations all derive from one Zod source.

### packages/experimental/cua-macos/native/Package.swift
- Purpose: 13-line SwiftPM manifest for the `dsh-cua-native` executable.
- Key abstractions: `platforms: [.macOS(.v14)]`; `swiftLanguageModes: [.v6]`; a `CuaNativeTests` test target at `tests/swift`.
- Data flow: `swift build --package-path native --configuration release` produces `.build/release/dsh-cua-native`.
- Non-obvious design decisions: **Swift 6 language mode** — strict concurrency is on, which is why every shared mutable object in the Swift sources is `@unchecked Sendable` with an explicit `NSLock`.
- Edge cases / failure handling: The test target path is `tests/swift` (the Python e2e runners live beside it in `tests/`).
- Surprising: macOS 14 is the floor — `AXSelectedTextRange`, `AXIncrementor` and the modern AX API need it.

### packages/experimental/cua-macos/native/.gitignore
- Purpose: 4-line ignore list: `target/`, `.build/`, `.swiftpm/`, `bin/`.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: `bin/` is ignored because `native/bin/darwin-<arch>/dsh-cua-native` is the **published payload path** written by `native-build.ts` — it is a build output, not source.
- Edge cases / failure handling: n/a.
- Surprising: Four lines that separate "the helper we ship" from "the helper we compile here".

### packages/experimental/cua-macos/native/LICENSE.cua-driver
- Purpose: The MIT notice for the upstream Cua Driver, kept verbatim.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: The file is named `LICENSE.cua-driver` (not `LICENSE`) precisely so it is *beside* the package's own MIT license, and `upstream.json` records the exact upstream tag and commit (`cua-driver-rs-v0.28.0`, `1b50c02e…`).
- Edge cases / failure handling: n/a.
- Surprising: A license file in a package's `files` list is a deliberate provenance artefact.

### packages/experimental/cua-macos/native/upstream.json
- Purpose: 67-line provenance manifest: which upstream project, which tag/commit, which files were adapted, which are local, and how each adaptation differs.
- Key abstractions: `adaptedFiles[]` with `{local, upstream, changes}`; `localFiles[]`; `references[]`.
- Data flow: Read by humans and by any licence audit; it is the authority for what is MIT-derived.
- Non-obvious design decisions: Each `changes` string is a **precise statement of what was NOT copied** — *"Do not copy private CGEvent memory offsets, authentication objects, global HID delivery or focus restoration"*, *"omit unreachable global and Screen Sharing paths"*, *"omit off-window priming clicks so revealed controls remain interactive"*. The `references` entry names Peekaboo as a cross-check for Swift C function signatures with *"no implementation code copied"*.
- Edge cases / failure handling: n/a.
- Surprising: This is a licence-provenance file that doubles as a **design-rationale file**. Each entry says what the adaptation deliberately dropped.

### packages/experimental/cua-macos/native/Sources/CuaNative/Main.swift
- Purpose: 37-line entry point with three modes: `--ensure-shared` (launcher), `--serve` (daemon), default (stdio diagnostic proxy).
- Key abstractions: `@main enum CuaNativeMain`.
- Data flow: `--ensure-shared` → `SharedHelperLauncher.ensure` and return. `--serve` → `setsid()` (detach into a new session), `NSApplication.shared` with `.prohibited` activation policy, `SharedHelperServer`, `server.start()`, then `app.run()`.
- Non-obvious design decisions: The comment at the top is the architecture in one line: *"Only server mode owns AppKit; launcher and stdio clients connect to its socket."* `.prohibited` means the daemon never appears in the Dock. `setsid()` detaches it from the client's session so it survives.
- Edge cases / failure handling: A failure in `--serve` mode is reported as a **JSON error frame on stdout** *and* a human line on stderr, then `exit(1)`.
- Surprising: The daemon is a full `NSApplication` — AppKit requires the main event loop, which is why the Swift side is a native app rather than a background service.

### packages/experimental/cua-macos/native/Sources/CuaNative/Protocol.swift
- Purpose: The JSON value type and the immutable process/window data exchanged between helper executors.
- Key abstractions: `indirect enum JSONValue: Codable, Sendable, Equatable`; `NativeFailure(code, message, accessibilityError)`; `NativeRequest`; `ProcessIdentity(pid, startedSeconds, startedMicroseconds)`; `WindowBounds`; `WindowRoute`; `WindowPoint`; `WindowInfo`.
- Data flow: `NativeRequest(data:)` decodes and validates the envelope; `WindowInfo.json` is the wire shape.
- Non-obvious design decisions: **The envelope validator counts top-level commas itself** (`envelopeSeparatorCount`), because Foundation's JSON decoder collapses repeated object keys: *"A validated three-field envelope must have exactly two separators outside strings and nested values."* The hand-rolled scanner tracks depth, quoting and escaping so a comma inside a string or a nested object does not count. `ProcessIdentity` includes the kernel's **process start time**, so a reused PID is distinguishable.
- Edge cases / failure handling: A malformed envelope throws `INVALID_REQUEST` with the message *"Expected exactly id, method and params"*. `JSONValue` decoding tries null → bool → double → string → array → object in that order, so a JSON number survives as `.number` and not as a bool.
- Surprising: The separator counter is the kind of defence you only write after a specific bug: a duplicate `"id"` key decodes to one value, so the count is what catches it.

### packages/experimental/cua-macos/native/Sources/CuaNative/RequestAdmission.swift
- Purpose: Strict model/native request admission, driven by the generated field and enum tables.
- Key abstractions: `RequestParameters` with `values: [String: JSONValue]`; `NativeProtocol.fields`; `NativeProtocol.stringEnums`.
- Data flow: `RequestParameters(request)` checks that the method exists (`UNSUPPORTED` otherwise), that every supplied key is in the allowed set (`INVALID_ARGUMENT` "Unknown operation parameter"), and that each string-enum field's value (or every element of an array) is in the allowed set.
- Non-obvious design decisions: The admission table is **generated from the same Zod definitions as the model's schema** — one source, two enforcement points. The typed accessors (`string`, `optionalString`, `optionalBoolean`, `number`, `integer(in:)`, `windowID()`, `modifiers()`, `point()`) all raise `INVALID_ARGUMENT` with a field-specific message, and `integer` refuses a non-integral or out-of-range value rather than truncating.
- Edge cases / failure handling: `number` requires `isFinite`; `integer` requires `value.rounded(.towardZero) == value` **and** the bounds.
- Surprising: `optionalBoolean` rejects a non-boolean, so `"details": "true"` is an error rather than a truthy value — disclosure flags cannot be coerced.

### packages/experimental/cua-macos/native/Sources/CuaNative/RequestCoordinator.swift
- Purpose: Per-connection request lifecycle: receive, admit, execute, reply, and shut down.
- Key abstractions: `RequestCoordinator` (`@MainActor`); `NativeRequestControl`; `NativeDeadline`; the `DriverOutcome` switch.
- Data flow: `receive(data)` decodes a `cancel` control frame, or parks a frame while a reply is in flight, or starts a `Task` that runs the request through the shared `RequestScheduler` and writes the reply.
- Non-obvious design decisions: **A screenshot gets its own, shorter deadline**: `min(timeoutSeconds, screenshotTimeoutSeconds)`, and a `ScreenshotTrace` is created only for screenshots. A cancel frame for the *next* parked frame sets `nextCancelled` so the request is cancelled the moment it starts. `performForeground` takes a **before** and an **after** observation and returns them alongside `dispatched: true, verified: false`.
- Edge cases / failure handling: The deadline's `unresponsive` path fires when the operation started but did not finish within `axTimeout + grace`; the `blockedReply` path shuts the channel down. A reply that exceeds the response limit is rejected **before any byte is emitted**, so a small error frame can still identify the limit.
- Surprising: `capture.requireAvailable()` is called **twice** — once before the operation and once inside it — because the capture slot can be taken between the two.

### packages/experimental/cua-macos/native/Sources/CuaNative/RequestScheduler.swift
- Purpose: The process-wide FIFO for complete desktop operations, plus the deadline and cancellation primitives.
- Key abstractions: `RequestScheduler` (`@MainActor`); `NativeDeadline`; `NativeRequestControl`.
- Data flow: `perform(cancellation:operation:)` takes the slot (or queues with a `CheckedContinuation`), runs the operation, and releases the slot in a `defer` — handing it to the next waiter.
- Non-obvious design decisions: The slot is held for the **whole operation** but **not** for socket writes — the file header says *"Desktop operations hold one process-wide slot; socket writes do not hold it."* A queued operation that is cancelled resumes with `NATIVE_CANCELLED` ("Queued operation cancelled") rather than waiting. `NativeRequestControl.cancel` sets the reason, cancels the task, and arms **two** deadlines: `grace` (the reply is blocked → shut the channel) and `axTimeout + grace` (the operation started but never finished → the process is unresponsive).
- Edge cases / failure handling: `release(id)` has a `precondition(owner == id)` — the scheduler's invariant is asserted, not assumed. The `unresponsive` vs `blockedReply` distinction is exactly the difference between "the operation is stuck" and "the reply cannot be written".
- Surprising: The distinction between *the caller gave up* and *the native work stopped* is carried by two separate timers with different arithmetic.

### packages/experimental/cua-macos/native/Sources/CuaNative/Runtime.swift
- Purpose: Bounded line I/O, the helper configuration, and cooperative termination.
- Key abstractions: `CancellationLatch`; `HelperConfiguration`; `JSONLInput`; `JSONLWriter`.
- Data flow: `JSONLInput` reads from the socket on a dedicated queue, splits on newline, enforces `maxRequestBytes`, and calls `onFrame`; `JSONLWriter` encodes with `sortedKeys` and `withoutEscapingSlashes`, enforces `maxResponseBytes` **before** writing, and writes with a timeout.
- Non-obvious design decisions: `CancellationLatch` exists because *"The synchronous AX/input loops cannot await a cancellation message on their own actor"* — it is a lock-guarded flag the synchronous code can poll. `HelperConfiguration(hello:runtimeKey:)` parses the **hello frame's config** and re-validates it through the same argument parser the CLI uses, so a client cannot widen a limit by sending a number. The writer's limit check happens *before* the first byte, and the reply frame is newline-terminated.
- Edge cases / failure handling: A request larger than the limit throws `NATIVE_REQUEST_LIMIT`; a reply larger than the limit throws `NATIVE_RESPONSE_LIMIT`. The reader handles a partial trailing frame at EOF by delivering it (`if !buffer.isEmpty { onFrame(buffer) }`).
- Surprising: The `hello` config is re-parsed through the CLI argument parser, so the *same* validator governs the command line and the wire — one rule, two doors.

### packages/experimental/cua-macos/native/Sources/CuaNative/AXAccess.swift
- Purpose: Checked Accessibility access and the AX tree projection.
- Key abstractions: `AXAccess`; `AXProjection {tree, elements, indexed, focusedWindowID, truncated}`; `AXNodeObservation`; `ProcessIdentityKey`.
- Data flow: `project(identity:windowID:maxElements:maxDepth:includeMenus:details:)` walks the tree from the app's windows, formats each node with `AXTextFormatter`, and returns the text plus a per-index map of `AXUIElement`s.
- Non-obvious design decisions: The traversal **visits each native identity once** using a `CFHash`-keyed bucket list with a `CFEqual` check — *"AX traversal visits each native identity once, including proxy references that compare equal, so cyclic accessibility children cannot repeat whole subtrees."* Metadata is read in **one batch** (`AXUIElementCopyMultipleAttributeValues`) with a per-attribute fallback, and the batch's per-attribute errors are retained rather than collapsed. `enableAX` sets `AXManualAccessibility` (or `AXEnhancedUserInterface`) once per process identity.
- Edge cases / failure handling: `optionalAttributeUnavailable` lists the attributes whose absence is benign (value, title, description, identifier, placeholder, subrole, help, URL, focused, expanded, enabled, selected, selected text/range, position, size, main, minimized) — every other attribute failure is real. `AXError.apiDisabled` becomes `PERMISSION_DENIED`; everything else is `NATIVE_ERROR`.
- Surprising: An element that is *not addressable* (not enabled, no actions, not writable) still contributes its children, and the node is **flattened** rather than shown — so a purely structural `AXGroup` does not consume a line of the model's budget.

### packages/experimental/cua-macos/native/Sources/CuaNative/AXWorker.swift
- Purpose: Actor-owned native identities, scoped AX snapshots and synchronous desktop operations.
- Key abstractions: `actor AXWorker`; `NativeSerialExecutor` (a `SerialExecutor` over a `DispatchQueue`); `SnapshotScope`; `NativeSnapshot`; `CaptureTarget`; `ForegroundPlan` / `ForegroundObservation`; `PastePlan`; `ApplicationLaunch`; `DriverOutcome`.
- Data flow: `execute(method:params:catalog:installed:trace:)` is the switchboard: `getCapabilities`, `listApps`, `getApp`, `launchApp`, `listWindows`, `getState`, `screenshot`, `paste`, `typeText`/`pressKey`, `setValue`, `selectText`, `performSecondaryAction`, `click`/`hover`, `scroll`/`drag`.
- Non-obvious design decisions: `identifier(_:)` mints handle and snapshot ids as `"<namespace>:<kind>:<counter>"` where the namespace is a per-helper UUID — *"A random per-helper namespace prevents handles from a terminated helper matching those of its replacement."* `observeSession()` **drops every snapshot and every observed bound** when the session is not verifiably unlocked. `observationFailure` reclassifies *only* `AXError.invalidUIElement` as `STALE_SNAPSHOT` — *"Only observation failures allow a fresh read. Input failures can follow partial effects and keep their original classification."* `resolveAction` matches an action alias case-insensitively-with-whitespace-stripped and **refuses an ambiguous alias**.
- Edge cases / failure handling: `validateIdentity` forgets the handle when the process is gone. `elementIndex` outside the snapshot is `INVALID_ARGUMENT`; a snapshot that is gone is `STALE_SNAPSHOT`; a snapshot belonging to another window is `STALE_SNAPSHOT`. A click on an element **prefers an advertised AX action** (`AXPress`/`AXPick`/`AXShowMenu`) and falls back to pointer delivery only when no action is advertised. Modified clicks always use pointer delivery.
- Surprising: `shouldRaise` skips a raise only when the target window is *exactly* the focused, main, unminimized, front window — a same-app foreground is not enough. And `getState` **re-checks** process lifetime, window ownership, the unlocked session and the Accessibility permission *after* the traversal.

### packages/experimental/cua-macos/native/Sources/CuaNative/AXTextFormatter.swift
- Purpose: Model-facing AX text rendering — one line per node, with disclosure options.
- Key abstractions: `AXTextNode` (22 optional fields); `AXTextFormatter.line(_:level:details:)`; `.truncation(maxElements:maxDepth:)`; `.actionName(_:)`.
- Data flow: `AXAccess.project` builds an `AXTextNode` per element and asks the formatter for its line; the lines are joined with `\n` into the tree text.
- Non-obvious design decisions: The formatter is a **pure function of already-read data** — *"AX text formatting consumes already-read node data. The AX walker alone assigns indices and retains native references, so formatting owns no second snapshot or target registry."* Value and placeholder are distinct: an empty value renders `value=""`, a missing one `value=unavailable`, and a placeholder always renders as `placeholder=`. `valueWritable` renders as `true`/`false`/`unknown`; a *missing* optional state field is simply absent, and the comment says so: *"Missing optional state fields do not imply false."* Repeated title/description/help text on one node is printed once, but a value equal to the title is still printed.
- Edge cases / failure handling: A selection range outside the observed value is replaced by `selection=unavailable`. Custom action names are stripped of AppKit's `Name:/Target:/Selector:` scaffolding in compact mode and kept raw in `details` mode. Ordinary `Press`/`Pick`/`ShowMenu`/`ScrollToVisible` actions are omitted in compact mode.
- Surprising: `hasMeaning` and `transparent` encode a real editorial decision — a group whose only content is `AXShowMenu`/`AXScrollToVisible`/`AXCancel` and no label is *transparent*, and its children are lifted up a level. The model's budget is spent on meaning, not on structure.

### packages/experimental/cua-macos/native/Sources/CuaNative/WindowGeometry.swift
- Purpose: Compare independent window frames before capture or pointer delivery.
- Key abstractions: `enum WindowGeometry` with `conflictMessage`, `appKitPoint`, `validateObservedSize`, `resolve`, `validate`.
- Data flow: `resolve(owner:windowID:readWindow:verifyOwner:accessibilityBounds:)` reads the CG bounds, reads the AX bounds, verifies the process, re-reads the CG bounds, and compares.
- Non-obvious design decisions: **Two independent sources must agree.** The AX and CG rectangles are compared as *integral* point rectangles so that representation rounding does not create a false conflict; a genuine disagreement is `WINDOW_CHANGED` with the message *"Window display and accessibility bounds disagree. Read fresh state; if unchanged, use AX actions or explicitly restore the window before capture or coordinate input."* Movement during the query is also `WINDOW_CHANGED`.
- Edge cases / failure handling: Missing or unusable AX geometry stays **unknown** and does not disable an owned window. A size change since the observation is `WINDOW_CHANGED`; a *movement* is not (window-local coordinates survive movement).
- Surprising: `appKitPoint` flips Y against the **primary display height** for every display, not the display the point is on — the comment spells out the trap.

### packages/experimental/cua-macos/native/Sources/CuaNative/WindowCapture.swift
- Purpose: Public ScreenCaptureKit capture with one completion and no blocking wait on the main actor.
- Key abstractions: `CapturedPNG`; `CaptureCompletion`; `SystemCaptureOperation`; `WindowCapture`.
- Data flow: `capture(target:cancellation:trace:)` takes the single capture slot, starts the system capture, and returns the PNG; PNG encoding happens on a dedicated `dsh.cua.png` queue.
- Non-obvious design decisions: **There is exactly one capture slot.** A second capture while one is outstanding is `CAPTURE_BUSY` — but AX and input remain available. The slot is released by the *real* callback, not by the cancellation: *"the slot belongs to the outstanding system callback"*, so a late capture result is discarded and its real completion frees the slot. The capture **re-checks the frame** against the selected window's geometry and the pixel dimensions against the encoded size, refusing with `WINDOW_CHANGED` on either.
- Edge cases / failure handling: `requireAvailable()` is a pre-check that throws `CAPTURE_BUSY` *before* any work. A permission failure is distinguished by `CGPreflightScreenCaptureAccess()` → `PERMISSION_DENIED` vs `NATIVE_ERROR`.
- Surprising: The window is matched by **both** window id and owning PID, and the capture configuration is derived from `filter.pointPixelScale` — so a Retina display's pixel dimensions are derived, not guessed.

### packages/experimental/cua-macos/native/Sources/CuaNative/WindowPointerInput.swift
- Purpose: Window-local pointer gestures, routed to a validated owner and window.
- Key abstractions: `MousePair`, `DragStep`; `click`, `scroll`, `drag`, `hover`; `validate(_:in:)`; `requireSystemPointerTarget`.
- Data flow: Each gesture builds its `CGEvent`s with the window-routing fields stamped on, then posts them to the owner PID.
- Non-obvious design decisions: **A drag always releases its button, even on cancellation** — the `defer` posts the held release. The requested movement time is *divided with fractional precision* across the segments (`dragStepInterval = durationMs / steps / 1000`), and the fixed press/release settling is extra. A click is preceded by a `mouseMoved` "primer" but **no off-window priming click** — *"omit off-window priming clicks so revealed controls remain interactive."* Right-click uses `AXShowMenu` when the element advertises it, otherwise pointer delivery.
- Edge cases / failure handling: `validate` refuses a point outside the window with `INVALID_ARGUMENT`. `requireSystemPointerTarget` demands the foreground PID *and* the AppKit mouse-hit window both match, else `FOREGROUND_REQUIRED` with the observed values in the message. `click` accepts left single/double only; right and middle single only.
- Surprising: `clickGroup()` is `DispatchTime.now().uptimeNanoseconds` — a per-gesture group id so a double click is one group with two clicks.

### packages/experimental/cua-macos/native/Sources/CuaNative/KeyboardInput.swift
- Purpose: Balanced PID-targeted key chords and scalar-based Unicode input.
- Key abstractions: `Modifier`; `ModifierEvents`; `pressKey`, `typeText`; `modifierFlags`; `keyCode(_:)`.
- Data flow: `pressKey` builds the *entire* chord before posting, posts modifiers down in order, the key down, the key up, then the modifiers up **in reverse order**.
- Non-obvious design decisions: *"Construct the entire chord before posting; cleanup releases only keys pressed by this call."* `+` is special-cased: the plus key is the `=` keycode **with shift**. Keypad names (`KP_0`…`KP_9`, `KP_Enter`, `KP_Add`, …) keep their physical codes and are separate from the ordinary digits. Unicode text is sent as **scalars**, one down/up pair each, with a configurable interval; LF/CR/CRLF send Return and tab sends Tab.
- Edge cases / failure handling: A cancellation between the key-down and key-up still releases the key (the `defer`). An unknown key name throws `NATIVE_ERROR`; an unsupported modifier throws `INVALID_ARGUMENT`.
- Surprising: The chord is built *before* any event is posted, so a mid-chord failure cannot leave a modifier stuck down.

### packages/experimental/cua-macos/native/Sources/CuaNative/NativeProtocol.generated.swift
- Purpose: 33-line generated enum listing the 19 model methods, the per-method field sets and the string-enum admission tables used by `RequestAdmission`.
- Key abstractions: `NativeProtocol.modelMethods`; `NativeProtocol.fields` (per-method allowed parameter names); `NativeProtocol.stringEnums` (per-method enum-valued fields).
- Data flow: Read at runtime by `RequestAdmission`; written by `native/generate-protocol.ts` from the shared Zod protocol.
- Non-obvious design decisions: The tables are **derived, not written** — the same Zod definitions that produce the model's JSON Schema produce the Swift admission table, so a new method cannot be admitted natively without also being model-visible. `modelMethods` deliberately lists only the 19 model-facing methods; `launchApp` appears in `fields` (it is a real native operation) but not in `modelMethods` (the model must not call it).
- Edge cases / failure handling: The tables are the admission boundary: an unknown method is `UNSUPPORTED` and an unlisted parameter is `INVALID_ARGUMENT` "Unknown operation parameter".
- Surprising: `InputMappingTests.swift` reads `NativeProtocol.stringEnums["click"]` directly and asserts that **every** button and modifier the schema declares has a native mapping — the generated table is used as a test oracle against the hand-written Swift.

### packages/experimental/cua-macos/native/Sources/CuaNative/PIDEventPoster.swift
- Purpose: PID event delivery, using SkyLight where available.
- Key abstractions: `PostToPID`, `SetWindowLocation`, `SetIntegerField` C function types; `post(_:to:)`; `stampWindow(_:pid:windowID:point:)`; `stamp(_:field:value:)`.
- Data flow: `dlopen` the private `SkyLight.framework` and `dlsym` the three symbols; each gesture builds its events and stamps the routing fields before posting.
- Non-obvious design decisions: The public `CGEvent.postToPid` is used **only when the private posting symbol is absent**, and *"A posted event is never repeated through the other API."* The comment on `dlsym` is a real trap: *"Darwin's RTLD_DEFAULT is the pseudo-handle -2, not an owned library handle."* The window-local point is set with `CGEventSetWindowLocation`, and the window id is written into three field slots (`51, 91, 92`).
- Edge cases / failure handling: If the private symbols are missing, `stampWindow` throws `NATIVE_ERROR` with *"Window-local input routing is unavailable on this macOS version"* rather than silently posting an unscoped event.
- Surprising: The header names the inspiration precisely: *"Swift SPI signatures reference Peekaboo's BackgroundInputDriver and WindowRoutedPointerDriver."*

### packages/experimental/cua-macos/native/Sources/CuaNative/AXHover.swift
- Purpose: Reveal alternate Accessibility UI without moving the system pointer.
- Key abstractions: `AXHover.move(to:in:access:) -> Bool`.
- Data flow: Walk the target's AX ancestry; if an ancestor advertises both `AXShowAlternateUI` and `AXShowDefaultUI` and is enabled, reveal it; otherwise restore the previously revealed node and report "leaving".
- Non-obvious design decisions: Entering a revealed descendant **preserves its parent UI**; leaving restores the default UI **once**. The ancestry walk carries a `visited` list and throws on a cycle: *"Accessibility hover ancestry contains a cycle; read fresh state."*
- Edge cases / failure handling: The return value is the "did the AX route handle it" flag: `true` means the accessibility route was used and **the system cursor did not move**.
- Surprising: Hover that can be done through the accessibility tree is done that way, precisely so the *visible* cursor does not move and the revealed control stays interactive.

### packages/experimental/cua-macos/native/Sources/CuaNative/ClipboardPaste.swift
- Purpose: Publish a temporary clipboard format, dispatch the app's Paste command, and restore the original.
- Key abstractions: `PasteDataProvider` (an `NSPasteboardItemDataProvider`); `ClipboardPaste.perform(text:format:maxBytes:readTimeout:checkCancellation:operation:)`; `SavedItem`; `ownerType`.
- Data flow: `snapshot` every original format (bounded by `maxBytes`); publish the new content with an **owner marker**; check the clipboard's `changeCount` before and after; run the operation; wait for the app to *request* the data; restore the originals if still owned.
- Non-obvious design decisions: The paste content is provided **lazily** through a data provider, so the format is only materialised when the target actually reads it — and the wait for that read is what `pasteReadTimeoutMs` bounds, producing `PASTE_NOT_CONSUMED` with a message that says the failure does not prove the app will never process the queued command. Restoration happens **only while the owner marker and the change count still match**, so a later user copy is preserved rather than overwritten (`CLIPBOARD_CHANGED`).
- Edge cases / failure handling: Oversized paste data is refused *before* the clipboard is touched; oversized existing content is refused before the clipboard is cleared. A changed clipboard between snapshot and write is `CLIPBOARD_CHANGED` and the paste is not dispatched. `cancel()` restores owned data during shutdown.
- Surprising: The header states the invariant: *"Temporary clipboard contents are restored only while this transaction still owns them."*

### packages/experimental/cua-macos/native/Sources/CuaNative/TextSelection.swift
- Purpose: Literal text matching that returns UTF-16 ranges macOS accessibility accepts.
- Key abstractions: `TextSelection.range(in:text:prefix:suffix:mode:) -> CFRange`; modes `text`, `cursor_before`, `cursor_after`.
- Data flow: Scan for literal occurrences; require the prefix and suffix to be **immediately adjacent**; refuse more than one match.
- Non-obvious design decisions: Matching is **literal**, not normalised: `"e\u{301}"` does not match `"é"`. All comparisons are done on UTF-16 elements, so an emoji counts as two units.
- Edge cases / failure handling: Two matches → `AMBIGUOUS_TEXT`; no match → `TEXT_NOT_FOUND`; an empty text or an unknown mode → `INVALID_ARGUMENT`.
- Surprising: `cursor_before` / `cursor_after` return a **zero-length** range at the match boundary — macOS expresses a caret position as an empty range.

### packages/experimental/cua-macos/native/Sources/CuaNative/WindowSpaces.swift
- Purpose: Read-only multi-Space membership and the front process, via the WindowServer SPI.
- Key abstractions: `WindowSpaceMembership`; `WindowSpaces` (five C function types bound by `dlsym`, each with a preferred name and a legacy fallback).
- Data flow: `memberships(windowIDs:)` asks for the space list and the window's managed display, then computes `onCurrentSpace`.
- Non-obvious design decisions: Each symbol is looked up under **two names** (`SLSCopySpacesForWindows` / `CGSCopySpacesForWindows`) because macOS renamed them. The SPI returns the union for *all* supplied windows, so **each query contains exactly one id**. Every failure — missing SPI, malformed result, empty list — stays **unknown** (`nil`), and `onCurrentSpace` is `nil` rather than `false`.
- Edge cases / failure handling: `frontPID()` reads the WindowServer's front process directly rather than `NSWorkspace`'s activation cache. The `takeRetainedValue()` calls are the correct memory discipline for the +1 CoreFoundation returns.
- Surprising: A window on a *secondary* display uses that display's current space, not the primary's — the test pins all three cases.

### packages/experimental/cua-macos/native/Sources/CuaNative/NativePlatform.swift
- Purpose: Value-only macOS process, session and WindowServer observations.
- Key abstractions: `ApplicationInfo` (+`matches(_:)`); `ApplicationCatalogSnapshot`; `@MainActor enum ApplicationCatalog`; `enum NativePlatform`.
- Data flow: `NativePlatform.identity(pid)` reads `proc_bsdinfo`; `verify(identity)` re-reads it and compares; `windows(allLayers:)` reads `CGWindowListCopyWindowInfo`; `sessionLocked()` reads `CGSessionCopyCurrentDictionary`.
- Non-obvious design decisions: `matches(_:)` compares by **name (case-insensitively), bundle ID, decimal PID, or a resolved absolute path** — and only for `regular` applications. `sessionLocked()` distinguishes three states: locked (`true`), unlocked-and-on-console (`false`), and **unknown** (`nil`) when the session dictionary does not answer. `requireUnlocked` maps `true` → `SESSION_LOCKED` and `nil` → `SESSION_UNAVAILABLE`.
- Edge cases / failure handling: `requireOwnedWindow` refuses a window that is closed (`WINDOW_UNAVAILABLE`) *and* one that belongs to another application. `requireAccessibility` / `requireScreenRecording` are **preflight** checks that never open a system dialog.
- Surprising: `mouseWindow(at:)` uses `NSWindow.windowNumber(at:belowWindowWithWindowNumber:0)` — AppKit's hit testing, which correctly *excludes* input-transparent windows and transparent regions.

### packages/experimental/cua-macos/native/Sources/CuaNative/ApplicationDiscovery.swift
- Purpose: Installed-application discovery, bounded to the standard macOS application directories.
- Key abstractions: `InstalledApplication` (+`read(_:)`, `matches(_:exact:)`, `json(catalog:)`); `@MainActor enum ApplicationDiscovery`.
- Data flow: `applications(matching:exact:limit:cancellation:roots:)` enumerates the application directories (skipping package descendants), reads each `.app` bundle, and matches on display name, directory name, bundle ID or path. `launch(_:cancellation:)` starts an app **without activating it** (`configuration.activates = false`, `addsToRecentItems = false`).
- Non-obvious design decisions: An absolute path query short-circuits to exactly that app. A query that matches **more than the limit** throws `AMBIGUOUS_APP` rather than returning a truncated list — *"Too many matching applications; use a more specific name or path"*. The cancellation latch is checked on every enumerated entry. `launch` waits for `isFinishedLaunching` in 25 ms steps, re-checking cancellation and termination.
- Edge cases / failure handling: An empty query is `INVALID_ARGUMENT`. A launch that returns no process, or an app that exits during launch, is `APP_UNAVAILABLE`.
- Surprising: The `isRunning` flag is computed by matching the installed app's **executable path** against the running catalogue, not by name — a renamed bundle is still the same app.

### packages/experimental/cua-macos/native/Sources/CuaNative/ApplicationAuthorization.swift
- Purpose: Verify the native application identity before the Host asks for consent.
- Key abstractions: `describe(_:name:expectedExecutablePath:)`; `describeInstalled(_:)`; `signingRequirement(_:)` (two overloads).
- Data flow: Resolve the running executable, compare it with the expected path (both symlink-resolved), obtain the code-signing designated requirement, and derive an **id** = SHA-256 of `path + "\n" + authority`.
- Non-obvious design decisions: The authority is the signing requirement when the code is **properly signed** (not ad-hoc); otherwise it is a process-lifetime identity (`process:<pid>:<startSeconds>:<startMicros>`) for a running app, or a **SHA-256 of the executable's bytes** for an installed one. `persistable` is true only when there is a real signing requirement — so unsigned code can never receive a durable grant. The docstring states the rule: *"Signed applications retain decisions across restarts only at the same executable path and with the same designated requirement. Unsigned/ad-hoc code gets process-only consent."*
- Edge cases / failure handling: A changed executable during selection is `STALE_APP`; a missing executable location is `APP_UNAVAILABLE`. `signingRequirement` requires `kSecCSStrictValidate` and explicitly rejects the `.adhoc` flag.
- Surprising: A permission grant is bound to a **code-signing identity**, not to a bundle id or a path alone — the same app re-signed with a different identity is a different app.

### packages/experimental/cua-macos/native/Sources/CuaNative/SharedHelperRuntime.swift
- Purpose: The shared-helper runtime identity, the version/executable locks, and the Unix socket.
- Key abstractions: `SharedHelperOptions` (runtimeKey, directory, startupTimeout, and the three derived paths); `SharedHelperLock`; `SharedSocket`; `enum SharedHelperLauncher`.
- Data flow: `--ensure-shared` takes the version lock (or reads the existing `ready` record), spawns the daemon with `posix_spawn` and a readiness pipe, reads the `ready` line, and republishes it on stdout.
- Non-obvious design decisions: The **version lock** (keyed by runtime key) elects one process; a second, **executable-path lock** (keyed by a SHA-256 of the executable path) refuses a *different build* at the same path — *"Another helper version is using this executable path; close its clients before switching versions."* The runtime directory must be a real 0700 directory owned by the current uid; a symlink is refused. The socket path must fit in `sockaddr_un.sun_path`. `SharedSocket.listen` refuses to replace a socket it does not own.
- Edge cases / failure handling: `SharedHelperLock` opens with `O_NOFOLLOW` and re-checks the file's mode and owner with `fstat` — a symlinked lock file is refused. `write` uses `O_NONBLOCK` + `poll` with a deadline because *"O_NONBLOCK also bounds large AF_UNIX sends that ignore MSG_DONTWAIT on macOS."*
- Surprising: `existingReady()` waits for the ready record, the pid to be alive (`kill(pid, 0)`) **and** the socket to be owned — three independent checks before an existing helper is trusted.

### packages/experimental/cua-macos/native/Sources/CuaNative/SharedHelperServer.swift
- Purpose: The daemon: one process, one ScreenCaptureKit backend, many client connections.
- Key abstractions: `SharedHelperLifetime` (clients, stopping, status); `NativeSignals`; `@MainActor SharedHelperServer`.
- Data flow: `start()` writes the `ready` record, closes stdout, and accepts connections on a background queue. Each accepted socket gets `getpeereid` checked (**same uid**, or the connection is dropped) and a `RequestCoordinator`.
- Non-obvious design decisions: The server holds the version and executable locks for the whole process lifetime — *"The lock descriptors stay open until process exit, including AX/input cleanup."* The **startup deadline** is cancelled as soon as the first client connects. `exitIfEmpty()` unlinks the socket and the ready record and then exits, so the daemon lives exactly as long as its clients. A signal aborts every client and `_exit`s after the grace period.
- Edge cases / failure handling: A client whose `hello` is invalid gets a JSON error frame and its channel is shut down. `abort(grace:status:)` cancels every client's latch and shuts its channel, then `_exit`s after the grace.
- Surprising: `getpeereid` is the only admission control — the socket is owner-only, and the peer must be the same uid.

### packages/experimental/cua-macos/native/Sources/CuaNative/ScreenshotTrace.swift
- Purpose: Screenshot phase records that omit request contents, window titles and image data.
- Key abstractions: `struct ScreenshotTrace` with `requestID`, a monotonic `started` stamp, an optional `report` sink, `encoded(_:errorCode:)` and `diagnosticValue(_:errorCode:)`.
- Data flow: The coordinator creates a trace only for `screenshot` requests; `mark(stage)` records a phase, and the frames go either to the Host as `type: "diagnostic"` frames on the originating connection or to stderr as `[cua-screenshot] <json>` lines.
- Non-obvious design decisions: The record contains **only** `requestId`, `stage`, `elapsedMs` and an optional `errorCode` — the file header states the rule: *"Screenshot phase records omit request contents, window titles and image data."* `protocol_e2e.py` asserts this is a *privacy* property by checking that a rejected request's contents never appear in the diagnostic output. A diagnostic failure must not replace the capture result, so `mark` swallows its own write errors.
- Edge cases / failure handling: The request id is JSON-encoded, so an id containing a newline or a quote still produces exactly one diagnostic line (`ScreenshotTraceTests.swift` pins this). `errorCode` is carried through so a failure's native code survives into the Host's bounded diagnostic buffer.
- Surprising: The elapsed time is measured from **receipt of the request**, not from the start of the capture — so the number the Host reports includes the queueing and scheduling the operation actually waited for.

### packages/experimental/cua-macos/native/Sources/CuaNative/SharedHelperProxy.swift
- Purpose: The stdin/stdout diagnostic client, which joins the same daemon and never creates a second capture backend.
- Key abstractions: `enum SharedHelperProxy`; `Frames` (a newline-framed reader with a byte limit).
- Data flow: `run(configuration:)` derives the runtime key from its own executable's hash, ensures the shared helper, sends a `hello`, then proxies stdin frames to the socket and non-diagnostic frames back to stdout.
- Non-obvious design decisions: **Diagnostic frames are routed to stderr** with the `[cua-screenshot] ` prefix while operation replies stay on stdout — the two streams are never mixed. The proxy retries the ensure+connect pair because a server can exit with its last client.
- Edge cases / failure handling: A partial trailing frame at EOF is still exchanged. During cleanup, any frame that is not a diagnostic is a `NATIVE_PROTOCOL` error.
- Surprising: The file header states the whole point: *"Stdio diagnostic clients use the same daemon and never create a second capture backend."*

### packages/experimental/cua-macos/native/README.md
- Purpose: 130-line specification of the native helper: build, service, protocol, observation and input semantics, and the verification commands.
- Key abstractions: A per-method result table (10 rows) and the stable error-code list.
- Data flow: Build → `--ensure-shared` → protocol-1 `hello` → `ready` → operation frames → replies.
- Non-obvious design decisions: The doc states the **shared-service topology** in three sentences: the socket is under `/tmp/dsh-cua-<uid>` keyed by the executable's SHA-256; a version lock elects one process; an additional real-executable-path lock excludes a different build at the same path. And the concurrency rule: *"AppKit runs on the main event loop. Blocking AX and input use each connection's serial actor; all connections share a FIFO for complete desktop operations. Socket writes do not hold that operation slot."*
- Edge cases / failure handling: The error vocabulary is spelled out with what each one means: `INVALID_REQUEST`, `INVALID_ARGUMENT`, `UNSUPPORTED`, `APP_UNAVAILABLE`, `AMBIGUOUS_APP`, `STALE_APP`, `STALE_SNAPSHOT`, `WINDOW_UNAVAILABLE`, `WINDOW_CHANGED`, `PERMISSION_DENIED`, `FOREGROUND_REQUIRED`, `PANEL_NOT_READY`, `NATIVE_ERROR` — and the closing rule: *"An error never promises that a partially dispatched input was rolled back. The host must not retry input automatically."*
- Surprising: The verification section names *how to check* each property, and the observation benchmark is explicitly honest about its own limits: *"it sets no CI speed threshold and makes no memory claim"*.

### packages/experimental/cua-macos/native/README.zh.md
- Purpose: 131-line Chinese translation of the native helper specification.
- Key abstractions: Same five sections; same error vocabulary; same verification commands.
- Data flow: Same.
- Non-obvious design decisions: Keeps the English anchors and keeps the *verbatim* stable error codes in English backticks while translating the prose around them.
- Edge cases / failure handling: The per-section hash record detects one-sided edits.
- Surprising: The zh text renders "轴无障碍树" (AX tree) as "辅助功能树" and keeps "AX" for the API — a consistent domain glossary across all three Chinese files in this shard.

### packages/experimental/cua-macos/native/README.i18n.yaml
- Purpose: 34-line bilingual-pairing consistency record for the native helper README.
- Key abstractions: 10 section entries with `en:`/`zh:` hashes.
- Data flow: Regenerated by `pnpm run verify-translation-pairing --write packages/experimental/cua-macos/native/README.md`.
- Non-obvious design decisions: Same per-section hashing as the other two packages.
- Edge cases / failure handling: n/a.
- Surprising: Three identical files in three packages — the convention is enforced by a shared tool.

### packages/experimental/cua-macos/native/tests/native_test_support.py
- Purpose: 107-line shared support for the opt-in macOS checks: owned JSONL helper processes, line reads, process-group teardown.
- Key abstractions: `NativeHelper` (a serial helper with a request transcript); `run_cleanup(*actions)`; `stop`, `stop_group`; `line(process, timeout)`; `BINARY`, `ROOT`.
- Data flow: `helper.call(method, params, error_code=None)` writes a JSONL request, reads one line, and records **both** the request and the response in a transcript.
- Non-obvious design decisions: `run_cleanup` uses an `ExitStack` with the actions registered in **reverse**, so every cleanup runs even if an earlier one raises — and the *first* failure is what propagates (the later ones are chained as `__context__`). `stop_group` kills the whole `start_new_session` group and escalates to `SIGKILL` after 5 s, then waits for the group to be empty and raises if it never is.
- Edge cases / failure handling: `line()` raises `TimeoutError` on a timeout and `RuntimeError` if the process exited unexpectedly.
- Surprising: The helper transcript is retained **on failure** — that is the evidence artefact.

### packages/experimental/cua-macos/native/tests/test_cleanup.py
- Purpose: 42-line unit test for the cleanup discipline itself.
- Key abstractions: `CleanupTests` with three cases.
- Data flow: `run_cleanup(artifacts, helper, fixture)` with each action appending to a list.
- Non-obvious design decisions: The three cases pin exactly the right behaviour: an artifact failure does **not** skip either process; a helper failure still stops the fixture and keeps the first error as the raised one (with the artifact error as `__context__`); a successful cleanup runs in order.
- Edge cases / failure handling: This is the file that guarantees "no owned process is left behind because a screenshot could not be saved".
- Surprising: A test for the *test harness's* cleanup, because a leaked AppKit process would break every subsequent macOS check.

### packages/experimental/cua-macos/native/tests/test_swift.py
- Purpose: 27-line runner for the Swift Testing suite.
- Key abstractions: `main()` finds the compiler with `xcrun --find swift` and runs `swift test --disable-xctest --enable-swift-testing`.
- Data flow: Appends the caller's `sys.argv[1:]` and exits with the toolchain's status.
- Non-obvious design decisions: When the Command Line Tools ship `Testing.framework` **outside** SwiftPM's default search paths, the runner adds the `-F` and `-rpath` flags — *"Command Line Tools ships these libraries outside SwiftPM's default search paths. Full Xcode and other selected toolchains keep their normal lookup."*
- Edge cases / failure handling: The flags are added only when the framework directory actually exists, so a full Xcode install is unaffected.
- Surprising: 27 lines that make the Swift suite runnable on a bare CLT machine.

### packages/experimental/cua-macos/native/tests/protocol_e2e.py
- Purpose: 210-line JSONL admission and EOF regression, without any desktop observation.
- Key abstractions: `cases()` — 30+ malformed or unsupported frames with their expected id and error code; `unique_object` (a `json` hook that rejects duplicate members); `validate(stdout, stderr, expected)`; `exercise`; `exercise_live_pipe`.
- Data flow: Every case is a request the helper must refuse; the runner asserts the exact `{id, error:{code,message}}` shape and ordering.
- Non-obvious design decisions: The `unique_object` hook proves the helper does not emit duplicate JSON members. The `capture-debug` case asserts that the *screenshot diagnostic* for a rejected request does not leak the request's contents: `assert b"private capture content" not in stderr`. `exercise_live_pipe` proves the helper replies on a live stdin pipe **without waiting for EOF**.
- Edge cases / failure handling: A malformed tail (a frame with no newline) is its own case. A timeout is explicitly *not* a successful exit: *"Helper did not finish EOF drain within Ns; timeout is not successful exit."* The runner refuses to run under `python -O` (assertions disabled).
- Surprising: The diagnostic-record assertion is a privacy test — the screenshot trace must carry timings and stages, never the request body.

### packages/experimental/cua-macos/native/tests/shared_helper_e2e.py
- Purpose: 255-line check of the shared helper's process lifetime, scoped handles and request-local screenshot deadlines.
- Key abstractions: `Connection` (a Unix-socket client that speaks the hello/ready protocol and collects diagnostics); `wait_released(path, pid)`; `CONFIG` (the per-connection limits).
- Data flow: Two threads race `launch()` (the `--ensure-shared` command) and must get the **same** `ready`; two connections then share the socket.
- Non-obvious design decisions: The concurrent-startup race is the point: *"assert ready[0] == ready[1]"* — two simultaneous launchers must elect one process. `wait_released` takes the version lock and then checks the pid is gone, proving the helper exits with its clients.
- Edge cases / failure handling: `--without-desktop` limits the check to protocol and process lifetime. The runner copies the helper to a private path so the runtime key (its hash) is unique.
- Surprising: The client is a **raw Unix socket** speaking the protocol by hand, not the Node client — the protocol is verified independently of the TypeScript transport.

### packages/experimental/cua-macos/native/tests/e2e.py
- Purpose: 318-line opt-in integration against a disposable two-window AppKit application.
- Key abstractions: `check_file_panel(...)`; `--panels-only`, `--hover-only`, `--alternate-hover`, `--input-overlays`; the fixture's own state file.
- Data flow: The runner compiles `Fixture.swift`, launches it, and drives the helper through the full operation set, reading the fixture's state file to check what the app **actually received**.
- Non-obvious design decisions: The central rule is stated in the docstring: *"The fixture records its own received actions; native dispatch success is not the assertion."* The file-panel helper retries on `STALE_SNAPSHOT` and `PANEL_NOT_READY` with the reasoning inline: *"A closing modal can invalidate an enumerated AX node. The failed read publishes no snapshot; only this read is repeated."*
- Edge cases / failure handling: The runner also checks that a dismissed panel's retained WindowServer window is not mistaken for a live one (*"Modal dismissal does not imply window destruction"*).
- Surprising: The retry loops are part of the *test*, not the product — the product refuses the stale read and the test re-reads.

### packages/experimental/cua-macos/native/tests/axless_e2e.py
- Purpose: 175-line opt-in AX-present → AXless → AX-present regression.
- Key abstractions: `app_binary(name, state_file)` (builds a real `.app` bundle with an `Info.plist`); signal-driven state changes.
- Data flow: `SIGUSR1` hides the app's AX roots; `SIGUSR2` restores them; `SIGWINCH` resizes; `SIGURG` moves; the runner observes and clicks between each.
- Non-obvious design decisions: The runner asserts the exact contract: after the AX roots are removed, `getState` returns `tree == ''`, `elements == []`, `truncated is False` and a **new** `snapshotId`; the old element index is refused with `STALE_SNAPSHOT`; the *new* snapshot's element index 0 is `INVALID_ARGUMENT`; a coordinate click still works; and a resize invalidates the coordinates with `WINDOW_CHANGED` while a **movement does not**.
- Edge cases / failure handling: The runner refuses to start unless `sessionLocked is False` and both permissions are granted, and it *"never changes system permission settings"*.
- Surprising: The AXless window is still **operable** — the empty snapshot permits screenshots and coordinate input. "AX-present" is not a precondition for using a window.

### packages/experimental/cua-macos/native/tests/capabilities_e2e.py
- Purpose: 133-line opt-in check of cold launch, paste, selection and physical input identities.
- Key abstractions: `wait_for_state`; `stop_application(pid)`; a real `.app` bundle built with `plistlib`.
- Data flow: `findApps` → `getApp` (stopped, `pid is None`) → `launchApp` → `activate` → `getState` → `selectText` → `paste` → gestures.
- Non-obvious design decisions: The test asserts `launchApp` is **not** in `getCapabilities().methods` — the private continuation is not model-visible. The selection test uses CJK + emoji and asserts the exact UTF-16 range `[17, 6]`, and an ambiguous "target" is refused with `AMBIGUOUS_TEXT` until a prefix is supplied.
- Edge cases / failure handling: `stop_application` sends SIGTERM, waits 5 s, then SIGKILL — and **raises** if the app still has not exited, so a stuck fixture is a failure, not a hang.
- Surprising: The comment *"The Host consent barrier is separately exercised by provider-lifecycle.spec.ts"* — the native suite deliberately does not test the consent UI.

### packages/experimental/cua-macos/native/tests/electron_e2e.py
- Purpose: 178-line opt-in check against an isolated Electron/Chromium application.
- Key abstractions: `--electron` (an existing executable; **never downloaded**); `--hover-only`; the fixture's `state.json`.
- Data flow: The renderer logs `DSH_CUA_STATE` lines; the main process writes them atomically (`state.next.json` → `renameSync`).
- Non-obvious design decisions: The renderer runs with `sandbox: true, contextIsolation: true, nodeIntegration: false` and its own `userData`/`sessionData`/`logs` directories. The runner's environment is trimmed to `PATH, HOME, TMPDIR, LANG, LC_ALL` — *"The fixture receives only launch essentials, not the harness environment."*
- Edge cases / failure handling: AX enablement in Chromium is asynchronous, so the runner waits for the actual controls rather than for the AX tree.
- Surprising: The fixture page reports `event.isTrusted` for every click and input, so the test can distinguish a real OS-level event from a synthesised one.

### packages/experimental/cua-macos/native/tests/observation_benchmark.py
- Purpose: 424-line read-only `getState` comparison between a reference helper and a candidate.
- Key abstractions: `OwnedProcess` (a private, 0600-logged subprocess); `FramedPipe`; `private_write` (`O_EXCL`, 0600); `json_bytes` (sorted keys, no NaN); `READ_ONLY_METHODS`; `OBSERVATION_LIMITS`.
- Data flow: One warm-up plus three alternating reference/candidate observations on owned AppKit windows with 35 and 400 synthetic rows; every result field must match except helper-generated ids.
- Non-obvious design decisions: The honesty is in the docstring: *"All result fields must match except helper-generated app and snapshot IDs"* and *"The report keeps raw timings, byte counts, hashes and replies; it sets no CI speed threshold and makes no memory claim."* The fixture startup *can* activate the application, and the docstring says to run it without other desktop automation.
- Edge cases / failure handling: Private artefacts are written with `O_CREAT | O_EXCL` and mode 0600, so a re-run cannot overwrite a previous evidence directory.
- Surprising: A **differential** benchmark: the reference helper is the oracle, so a candidate's output is compared field by field rather than against a hard-coded expectation.

### packages/experimental/cua-macos/native/tests/text_input_benchmark.py
- Purpose: 309-line comparison of text-input timing on fresh Blender Text Editors.
- Key abstractions: `InputHelper` (records complete request/reply frames, *including* failed or partial replies); `payload(length)`; `text_facts(text)` (scalar/UTF-16/UTF-8 counts and a SHA-256).
- Data flow: Identical synthetic 200/2000-scalar strings (ASCII, Chinese, emoji, newlines) are typed into fresh editors; full text equality is required.
- Non-obvious design decisions: The measurement boundary is stated precisely: *"Startup, focus, hashing and cleanup are excluded; observer publication/polling is included in verification latency. This bypasses DSH/model overhead and the TypeScript request timeout."* And: *"Raw samples have no speed threshold or RSS claim."* `--candidate-arg` lets the same binary be compared with different flags (e.g. `--text-event-interval-ms 0.5`).
- Edge cases / failure handling: Full-text equality — including Chinese, emoji and newlines — is the assertion, so a partial type is a failure, not a timing blip.
- Surprising: The benchmark measures the *effect*, not the dispatch: the number that counts is the time until Blender's own text editor shows the whole string.

### packages/experimental/cua-macos/native/tests/blender_keyboard_e2e.py
- Purpose: 302-line opt-in Blender GUI keyboard regression.
- Key abstractions: `whole_run_deadline(seconds)` (a `SIGALRM` context manager); `read_state(path, token, pid)`; `events_after`; `SEED`/`REPLACEMENT`.
- Data flow: An owned factory-startup Blender with private user directories; the fixture publishes the real Text Editor content; the runner checks Command+A replacement, Shift+Left selection and ordinary input after modifier release.
- Non-obvious design decisions: The runner owns its own alarm and refuses to run if another real-time alarm is active — *"This standalone runner owns its alarm. It also bounds a partial native JSONL line, for which the shared helper's select()+readline() timeout is insufficient."*
- Edge cases / failure handling: The docstring warns: *"activation changes GUI focus"* and *"Run only after other desktop automation has stopped."* `--helper` selects a previous binary for a negative control.
- Surprising: A **negative control** is a first-class option: the same test against an older helper is a supported mode.

### packages/experimental/cua-macos/native/tests/blender_keyboard_fixture.py
- Purpose: 153-line Blender-side observer for the keyboard regression.
- Key abstractions: `arguments()` (parses after `--`); `atomic_json(value)`; `selection_state(text)`; a 256-entry event deque.
- Data flow: The script writes only at initialisation; afterwards it observes input and publishes the actual Text/selection state, passing every modal event to Blender.
- Non-obvious design decisions: `atomic_json` writes to a temporary file, `fsync`s it, `os.replace`s it, and unlinks the temporary in a `finally` — a state file that is never half-written. `selection_state` computes offsets by walking the lines and adding `len(value) + 1` per line.
- Edge cases / failure handling: The event deque is bounded at 256 so a runaway app cannot grow the fixture's memory.
- Surprising: *"Only initialization writes Text data"* — the observer never types, so the measurement is of the *harness's* input, not the fixture's.

### packages/experimental/cua-macos/native/tests/Fixture.swift
- Purpose: 237-line disposable AppKit application used by `e2e.py`.
- Key abstractions: `DragPad` (counts down/up/drag, tracks the last point, reveals a hover button on `mouseEntered`); `AlternateHoverPad` (overrides `accessibilityPerformShowAlternateUI`/`ShowDefaultUI`); `ScrollDocument`; `CountingScrollView`; `Fixture` (writes its own state file).
- Data flow: Real OS input events mutate the views; the fixture persists its counters to a state file the runner reads.
- Non-obvious design decisions: The file header states the rule: *"Every assertion reads this application's own state file after real OS input."* The alternate-hover pad implements the AX alternate-UI contract so the AX hover route can be tested without the system cursor.
- Edge cases / failure handling: `isFlipped` and `acceptsFirstMouse` are overridden so the first click is not consumed by the window activation.
- Surprising: The hover button is a **tracking-area** reveal, and the alternate-hover pad is a **second** pad with the same behaviour exposed through AX instead — one fixture, two hover routes.

### packages/experimental/cua-macos/native/tests/AxlessFixture.swift
- Purpose: 99-line fixture that removes and later restores its own AX roots while keeping its CG window and button alive.
- Key abstractions: `AxlessFixture`; `savedChildren`; signal handlers for `SIGUSR1/2`, `SIGWINCH`, `SIGURG`, `SIGHUP`, `SIGALRM`.
- Data flow: `savedChildren = NSApplication.shared.accessibilityChildren()` is stored, then the AX roots are removed; the button and the window keep working; the state file records `hiddenAX`, `count`, `resizeCount`, `moved`.
- Non-obvious design decisions: The app is a real bundle (`Info.plist` with a bundle id) so the helper can select it by path.
- Edge cases / failure handling: The signal handlers are installed with `DispatchSource` on the main queue and the signals themselves are `SIG_IGN`ed so the default action does not kill the app.
- Surprising: It is a *self-hiding* accessibility citizen — the only honest way to test the AXless path is to make a real app lose its AX roots.

### packages/experimental/cua-macos/native/tests/CapabilitiesFixture.swift
- Purpose: 127-line fixture that records received input and rich text independently of the driver.
- Key abstractions: `CapabilityPad` (records every mouse and key event); `CapabilityTextView` (overrides `paste` to record whether the clipboard carried the owner marker).
- Data flow: The pad's `mouseDown`/`mouseDragged`/`mouseUp`/`rightMouse*`/`otherMouse*`/`keyDown`/`keyUp` all call `received?`; the text view's `paste` records `attemptedPaste(owned)`.
- Non-obvious design decisions: The paste override checks for the harness's **owner marker** type (`org.deepseek-harness.cua.clipboard-owner`) and only performs the real paste when the marker is present — so the fixture can distinguish "the clipboard was ours" from "the clipboard was someone else's".
- Edge cases / failure handling: `acceptsFirstMouse(for:)` is true, so the first click is delivered.
- Surprising: The fixture is the *only* place that can tell whether a paste was semantically correct; the helper's `dispatched: true` says nothing about it.

### packages/experimental/cua-macos/native/tests/paste_e2e.py
- Purpose: 75-line check that a bounded unread-paste failure and a foreground success both behave correctly against owned AppKit apps.
- Key abstractions: `wait_state(path, predicate)` (a 10 s poll of the fixture's state file); the `NativeHelper` client; `--helper` and `--artifacts`.
- Data flow: Two `PasteFixture` processes are started (a target and a foreground blocker); the helper selects both, activates the blocker, pastes into the background target and expects `PASTE_NOT_CONSUMED`, then activates the target and pastes again expecting success.
- Non-obvious design decisions: The measurement is of the *effect*: the background case asserts the fixture recorded `pasteCalls == [False]` (a background paste attempt) with **empty** text, and the foreground case asserts `pasteCalls == [False, True]` and that the text arrived. The elapsed time of the failing background paste is recorded, so the bounded read timeout is observable rather than assumed.
- Edge cases / failure handling: The `finally` block always writes the private transcript and then runs `run_cleanup` over the helper and both fixtures, so a failed assertion still leaves the evidence and stops the processes.
- Surprising: The failure is asserted to be *correct* behaviour: a paste dispatched to a background app is not consumed, and the helper must say so rather than claim success.

### packages/experimental/cua-macos/native/tests/PasteFixture.swift
- Purpose: 56-line foreground-sensitive Paste receiver.
- Key abstractions: `PasteFixture`; an Edit menu with a `Paste` item; `pasteCalls: [Bool]` (one entry per paste, recording whether the app was active).
- Data flow: `pasteText` appends `NSApp.isActive` and only pastes when active; `persist()` writes the state file.
- Non-obvious design decisions: The menu item is `autoenablesItems = false` so it is always enabled — the helper's Paste command must be *dispatched* even in the background, which is exactly the case under test.
- Edge cases / failure handling: `applicationDidBecomeActive` / `applicationDidResignActive` also persist, so a focus change is observable.
- Surprising: The recorded list `[false]` (a background paste) is what proves `PASTE_NOT_CONSUMED` is a *correct* outcome rather than a bug.

### packages/experimental/cua-macos/native/tests/electron-fixture.html
- Purpose: 59-line disposable Electron renderer page.
- Key abstractions: A `DSH_CUA_STATE` console line as the renderer's only channel out.
- Data flow: DOM listeners record `isTrusted`, click counts, pointer-down counts, the last mouse move's `buttons` and `trusted`, and the hover popup's open state; `report()` prints one JSON line.
- Non-obvious design decisions: The hover flow uses a **150 ms** `mouseenter` timer before revealing the popup — a realistic hover delay that the harness's guidance tells the model to wait for.
- Edge cases / failure handling: The `mousedown` handler closes the popup when the click is outside the flow.
- Surprising: Every event records `event.isTrusted`, so the test can prove the input was a real OS event and not a synthetic DOM dispatch.

### packages/experimental/cua-macos/native/tests/electron-fixture.mjs
- Purpose: 52-line disposable Electron main process.
- Key abstractions: `app.setPath` for `userData`/`sessionData`/`logs`; a `BrowserWindow` with `sandbox:true, contextIsolation:true, nodeIntegration:false`; `window.webContents.setWindowOpenHandler(() => ({action:'deny'}))`.
- Data flow: The `console-message` handler recognises the `DSH_CUA_STATE ` prefix and writes the state file atomically (`state.next.json` → `renameSync`).
- Non-obvious design decisions: The window is created with `show: false` and shown on `ready-to-show` — so the app announces `READY` only when it is *visible* and has state. `announce()` requires both.
- Edge cases / failure handling: The fixture requires an **absolute** private directory (`throw new Error('An absolute private fixture directory is required')`).
- Surprising: `setWindowOpenHandler` denies all popups — the fixture is closed to the network by construction.

### packages/experimental/cua-macos/native/tests/swift/ApplicationDiscoveryTests.swift
Installed-app discovery against isolated bundles; a broad query is **refused** (`AMBIGUOUS_APP`) rather than truncated; a cancelled enumeration throws; an unsigned pending app's identity changes when the executable bytes change.

### packages/experimental/cua-macos/native/tests/swift/AXFailureTests.swift
The optional-vs-structural attribute table (`AXValue` benign, `AXChildren` not); batch values retain their CF types; per-attribute batch errors keep the individual-read rules; `apiDisabled` becomes `PERMISSION_DENIED` while other AX errors become `NATIVE_ERROR`; `observationFailure` reclassifies **only** `invalidUIElement`. (Read lines 1-70 of 166; the remainder was not read.)

### packages/experimental/cua-macos/native/tests/swift/AXTextFormatterTests.swift
The disclosure semantics — an empty value vs a placeholder vs an unavailable value; `valueWritable=unknown`; transparent groups; deduplication of equal title/description/help; the `Name:/Target:` action stripping; UTF-16 selection and `selection=unavailable`; action aliases that resolve only when unambiguous; the truncation message naming the limit that was reached.

### packages/experimental/cua-macos/native/tests/swift/ClipboardPasteTests.swift
Each case owns a **named** pasteboard (`NSPasteboard.withUniqueName()`) so the user's clipboard is never touched; every original format is restored; HTML is published without the plain-text form; a newer copy is preserved (`CLIPBOARD_CHANGED`); cancellation restores; oversized preservation is refused before any change. (Read lines 1-60 of 136.)

### packages/experimental/cua-macos/native/tests/swift/ForegroundTests.swift
A raise is skipped only for the *exact* focused, main, unminimized, front window — nine different near-misses all still raise; unknown foreground values stay null; `actionResult` is exactly `{dispatched:true, verified:false}`.

### packages/experimental/cua-macos/native/tests/swift/InputMappingTests.swift
Every keypad name keeps its physical code; `KP_Enter` ≠ `Return` and `KP_0` ≠ `0`; the middle button keeps its own event family; **every** button and modifier in the *generated* enum table has a native mapping.

### packages/experimental/cua-macos/native/tests/swift/PermissionIdentityTests.swift
A changed executable is `STALE_APP`; a missing executable location is `APP_UNAVAILABLE`.

### packages/experimental/cua-macos/native/tests/swift/PointerTimingTests.swift
`dragStepInterval × steps == durationMs/1000` within 1e-12, for 1/240, 399/20 and 400/20 — so a sub-millisecond or unevenly divided budget is preserved.

### packages/experimental/cua-macos/native/tests/swift/ProtocolTests.swift
JSON kinds and nulls; nine invalid envelopes; the request id is retained for method-level parameter errors; `onCurrentSpace` is an explicit null; `UNSUPPORTED` vs `INVALID_ARGUMENT`; invalid window ids; a rounded integer overflow does not trap; nested separators and escaped quotes do not change the field count; the text-event interval bounds; non-boolean disclosure flags are rejected.

### packages/experimental/cua-macos/native/tests/swift/ScreenshotTraceTests.swift
A diagnostic is exactly one JSON line with only `requestId`/`stage`/`elapsedMs`; the error code is retained on failure.

### packages/experimental/cua-macos/native/tests/swift/SharedHelperTests.swift
Per-connection configuration from the hello frame; eight invalid configurations refused; wrong protocol/type/extra field refused; the version lock is exclusive until release; a **symlinked** runtime directory is refused; the launch identity and socket-path length are validated.

### packages/experimental/cua-macos/native/tests/swift/SharedSocketTests.swift
The descriptor closes promptly after a peer EOF; a back-pressured 4 MiB write cannot block another socket or the descriptor close.

### packages/experimental/cua-macos/native/tests/swift/SystemHoverTests.swift
System-pointer hover requires the foreground PID *and* the AppKit hit window; the hit-test point uses the primary display's origin **on every display**.

### packages/experimental/cua-macos/native/tests/swift/TextSelectionTests.swift
A repeated occurrence is disambiguated by an adjacent prefix; the cursor modes; `AMBIGUOUS_TEXT` / `TEXT_NOT_FOUND`; the context must be **adjacent**; matching is literal (no NFC normalisation).

### packages/experimental/cua-macos/native/tests/swift/WindowCaptureTests.swift
A cancelled capture keeps **one** outstanding SDK callback, the next capture is `CAPTURE_BUSY`, and AX remains available; the slot frees only when the real callback arrives.

### packages/experimental/cua-macos/native/tests/swift/WindowGeometryTests.swift
Coordinate input requires an observed size; a resize is `WINDOW_CHANGED`; **movement is allowed**; conflicting AX and display rectangles are refused with the exact conflict message; the same *integral* rectangle is accepted; unknown AX geometry stays unknown; movement during an AX read is caught; a process replaced during the read is `STALE_APP`.

### packages/experimental/cua-macos/native/tests/swift/WindowSpacesTests.swift
Space membership is a value-only decision; unavailable membership stays unknown rather than becoming another space; each window uses its own display's space.

---

## Ideas worth stealing

- **A budget clock that counts only the hook's OWN running time, and pauses inside nested calls** — `packages/experimental/claude-code-mods/src/chain.ts:50-131` (class `BudgetClock`) — the clock arms on `start()`, pauses on `pause()` (called while awaiting `next` and while awaiting any `$` call) and resumes on `resume()`. Why it matters for August: August's `MAX_MANAGED_TOOL_ROUNDS` counts *rounds*, so a single slow tool (a 3-minute `run_command`) and a fast one cost the same, and the harness has no way to say "this hook, not this tool, is the problem". A budget that excludes awaited work is the only kind that can distinguish "the model is thinking" from "the model is stuck". Transfer it as a per-tool-call or per-turn *own-time* budget alongside the round cap.

- **"One run beneath per hook" + "the result from beneath stands when the hook had already called `next`"** — `packages/experimental/claude-code-mods/src/chain.ts:222-224` and `packages/experimental/claude-code-mods/src/chain.ts:284` — the second `next(e)` returns the *same promise*; if the hook fails after `next` resolved, the result from beneath is returned, not an error. Why it matters: August's `tools/execute` waterfall has the same double-execution hazard (a plugin that wraps `next` and also catches its error can re-run the tool). This is a five-line rule that makes wrapping safe, and it is testable in isolation (`tests/chain.spec.ts:133-159`).

- **Refuse an argument rewrite that has already been logged, and name the deferred mechanism** — `packages/experimental/claude-code-mods/src/index.ts:400-408` — `validateNext` compares the arguments the hook passes down with `JSON.stringify` of the *logged* ones and throws `RewriteRefusedError("rewrote the arguments of <tool>; argument rewrites need the pre-tool input rewrite mechanism (...)")`; a rerouted tool gets its own message. Why it matters: August already has a "the logged call runs as logged" invariant in its tool pipeline and a proposed pre-tool-input-rewrite note. This is that invariant expressed as a *plugin guard* rather than as a convention — and it converts a silent divergence between the audit log and the executed call into a named, one-line diagnostic.

- **Report every UNSERVED event at load time, by name** — `packages/experimental/claude-code-mods/src/index.ts:519-523` — the bridge computes `registry.unserved(mod, SERVED_EVENTS)` and logs *"mod: on("turn.step") registered, but this host never raises that event"*. Why it matters: August's own `check:sse` gate exists because *"a dispatcher that calls `handlers.onX?.(...)` when nothing supplies `onX` — the optional call is a no-op"*. A plugin API that names its unserved surface **at load** catches the same class of defect on day one instead of after a gate is written in response to a shipped bug.

- **Reject unserved API members BY NAME instead of leaving them `undefined`** — `packages/experimental/claude-code-mods/src/api.ts:192-218` — a `Proxy` makes any un-served `<namespace>.<member>` a function that rejects with `"no implementation for <namespace>.<member>"`, and the outer proxy's `set`/`defineProperty`/`deleteProperty` all return `false` so `$` is read-only. Why it matters: an unreachable member that is `undefined` produces a `TypeError` at the *call site*, far from the cause, and it disappears in production. A named rejection is a one-line diagnosis, and the read-only proxy means a plugin cannot mutate shared state even by accident.

- **A `$` call raised by one plugin reaches only the plugins loaded BEFORE it** — `packages/experimental/claude-code-mods/src/engine.ts:257` and `packages/experimental/claude-code-mods/src/module.ts:61-65` — `registry.select(event, raisedBy)` filters on `hook.mod.order < raisedBy.order`. Why it matters: this is the acyclicity rule for a plugin API. August's own subagent spawn surface has exactly this hazard (a tool that calls a tool that calls the tool). One comparison in the registry makes re-entrancy structurally impossible rather than merely discouraged.

- **A surface generation counter, with stale presses reported rather than ignored** — `packages/experimental/claude-code-mods/src/surfaces.ts:226-244` and `packages/experimental/claude-code-mods/src/surfaces.ts:142-152` — each drawing gets a `generation`; a `pressBand` names the generation it saw; a press against a superseded drawing is **reported** (*"band press ignored: a0 of generation 0 is not on the current drawing (1)"*) and dropped; an unchanged tree keeps its generation but gets fresh callbacks. Why it matters: this is the UI/UX pattern for any async surface in August — a chat widget, an approval card, a progress banner. The UI is a snapshot; a click carries the snapshot id it was rendered from. Silent no-ops and wrong-button presses are both avoided, and the "wrong generation" report is a real diagnostic.

- **Redraw a surface because the drawing READ a value, not because the writer asked** — `packages/experimental/claude-code-mods/src/engine.ts:370-384` (the `onStateRead`/`onStateWritten` hooks) and `packages/experimental/claude-code-mods/src/surfaces.ts:159-172` — during a render, every `$.state` slot the drawing reads is subscribed; a write to a subscribed slot refreshes the band. Why it matters: this is read-dependency tracking, and it is how August could make a status/progress surface self-maintaining without every writer remembering to poke the UI. It also removes an entire class of bug (a value that changed but the widget did not).

- **"The logged call runs the tool it named" — a plugin may rewrite a RESULT but never the CALL** — `packages/experimental/claude-code-mods/src/index.ts:411-431` — a `{ deny }` becomes an error result with the reason; a `{ result }` becomes a success only when the tool is mod-registered or the value satisfies the tool's **own output schema** (otherwise it is error-shaped, `MOD_ANSWERED`); a rewritten result is installed through `tools/post-execute` so the pipeline's own block/accept decision still wins. Why it matters: this is a *schema-checked* plugin override. August's tool pipeline already has the output-schema machinery; the transfer is to validate a plugin's substituted result against the tool's schema instead of trusting it, and to route the replacement through the pipeline rather than mutating the result in place.

- **A "dispatched, not verified" action result, as a universal convention** — `packages/experimental/cua-macos/native/Sources/CuaNative/AXWorker.swift:190` (`static var actionResult: JSONValue { .object(["dispatched": .bool(true), "verified": .bool(false)]) }`) — and the same shape is returned by every input operation. Why it matters: this is the single most transferable idea in the shard. A harness that lets a model drive a real machine must never report a dispatched side effect as a completed one. August's `run_command` returns an exit code (a *verified* fact); a browser/CUA click returns only "dispatched". Encoding the difference in the result shape makes the model's next obligation — read fresh state — visible in the data rather than in prose.

- **"Never retry uncertain input automatically" — a rule written into the model's own guidance, with a named error code for each case** — `packages/experimental/cua-macos/src/guidance.ts:40` — *"A successful action means dispatched, not verified. Cancellation may leave partial effects; never retry uncertain input without observing. STALE_APP requires getApp again; STALE_SNAPSHOT requires getState again."* Why it matters: August's self-heal ladder re-runs tools. The CUA guidance shows how to make a re-run *safe*: never re-dispatch blindly; require a fresh observation, and give the model a named code that says which observation to take. The error vocabulary (`STALE_APP`, `STALE_SNAPSHOT`, `WINDOW_CHANGED`, `SCREENSHOT_REQUIRED`, `PERMISSION_DENIED`, `FOREGROUND_REQUIRED`, `PASTE_NOT_CONSUMED`, `CAPTURE_BUSY`, `CLIPBOARD_CHANGED`) is a model-actionable table, not a stack trace.

- **Every observation REPLACES the indices for its scope, and a stale index is a named error** — `packages/experimental/cua-macos/native/Sources/CuaNative/AXWorker.swift:258-263` and `packages/experimental/cua-macos/native/Sources/CuaNative/AXWorker.swift:145-150` — a new `getState` for a scope invalidates that scope's snapshot; an element index that is not in the named snapshot is `INVALID_ARGUMENT`; a snapshot that is gone is `STALE_SNAPSHOT`. Why it matters: index-based addressing (element indices, message ids, file handles, attachment ids) is the most common source of "the agent acted on something that no longer exists". Making the address **scoped and versioned**, with a named staleness error, is directly transferable to August's tool results.

- **Two independent sources of truth must AGREE, or the operation refuses** — `packages/experimental/cua-macos/native/Sources/CuaNative/WindowGeometry.swift:38-46` — the AX frame and the display frame are compared as integral point rectangles; a genuine disagreement is `WINDOW_CHANGED` with a message that says what to do next. Why it matters: August's own "one tokenizer / one door" rules are about *not* having two implementations of the same predicate. This is the opposite and complementary discipline: when two sources legitimately exist (the model's picture and the screen, the transcript and the store), compare them and refuse rather than picking one. The comment *"The helper preserves both coordinate sources rather than substituting AX geometry for CG geometry"* is the rule.

- **Permission bound to a code-signing identity, and durable consent only for properly signed code** — `packages/experimental/cua-macos/native/Sources/CuaNative/ApplicationAuthorization.swift:9-26` — the grant id is SHA-256 of `executablePath + "\n" + authority`, where the authority is the code-signing designated requirement; ad-hoc or unsigned code gets a process-lifetime identity (or an executable-content digest) and `persistable: false`. Why it matters: a permission grant bound to a *name* or a *path* is revocable by whoever replaces the binary at that path. Binding the grant to a signature means "allow this app" means "allow this code". August's `allowedApps`/skill/hook grants should be reviewed against this bar.

- **One capture slot, but partial degradation instead of global failure** — `packages/experimental/cua-macos/native/Sources/CuaNative/WindowCapture.swift:56-66` and `packages/experimental/cua-macos/native/Sources/CuaNative/WindowCapture.swift:80-84` — an outstanding system capture holds the single slot; new captures get `CAPTURE_BUSY` while **AX and input remain available**; the slot is released by the *real* callback, and a late result is discarded. Why it matters: the failure mode a naive implementation has is "the whole tool breaks". Naming the contended resource and keeping the *other* capabilities alive is the pattern for any single-slot resource in August (one browser tab, one terminal, one file watcher).

- **Serialise the thing that races; do not serialise the thing that does not** — `packages/experimental/cua-macos/native/Sources/CuaNative/RequestScheduler.swift:13-33` — a process-wide FIFO holds one complete desktop operation at a time, but *"socket writes do not hold it"*; a cancelled queued operation resumes with `NATIVE_CANCELLED` rather than waiting. Why it matters: this is the shape of a correct lock scope. August's own `MAX_MANAGED_TOOL_ROUNDS` and the "one tool at a time" rules are about the same question — what exactly is being serialised, and what is deliberately left parallel.

- **Generate the wire contract and the native admission table from ONE source, and check both in CI** — `packages/experimental/cua-macos/native/generate-protocol.ts:19-90` and `packages/experimental/cua-macos/tests/protocol-generation.spec.ts:8-23` — the same Zod definitions produce the model's JSON Schema, the native Swift field/enum tables, and the Host-only continuations; the test compares both artefacts byte-for-byte and asserts that six Host-only shapes are rejected by the *model* schema. Why it matters: this is the "one source of truth" rule applied to a *contract* rather than to a predicate, and it is what keeps a model-facing schema and a runtime validator from drifting. The `relative: true` handling is the subtle part: the model may offer it, the **Host** resolves it, and the native never sees it.

- **Content-addressed, immutable native build generations** — `packages/experimental/cua-macos/src/native-build.ts:103-114` and `packages/experimental/cua-macos/tests/native-build.spec.ts:156-168` — the built binary is published both to the package payload (only if the bytes changed — the inode is asserted stable) and to `native/.build/prepared/<arch>/<sha256>/`, so a running process keeps its own bytes while a new build publishes a new generation; a retained copy whose bytes do not match its digest is refused. Why it matters: this is the update-safety pattern in miniature — *"a new download must start with an empty memory, and an update must keep everything"* — applied to a binary. The "publish to a new path, never overwrite in place" rule is what lets an old process keep running.

- **Validate the runtime directory's ownership BEFORE launching any native code** — `packages/experimental/cua-macos/src/shared-native.ts:137-151` and `packages/experimental/cua-macos/tests/shared-native.spec.ts:262-268` — the directory must be a real 0700 directory owned by the current uid; a symlink, a file, a 0755 directory or a foreign owner is refused and **no process is spawned**. Why it matters: the check that a path is safe must run *before* the thing that uses the path exists. August's sandbox/scratch-directory rules should have the same ordering property, and the same test shape (assert `spawn` was never called).

- **A handshake that proves identity before a single byte of work is sent** — `packages/experimental/cua-macos/src/shared-native.ts:207-241` and `packages/experimental/cua-macos/tests/shared-native.spec.ts:243-260` — the client sends a protocol-1 `hello`, the server answers `ready` with the runtime key, and the client checks that the key matches; the handshake is bounded at 8192 bytes and decoded with `fatal: true`. Seven bad handshakes are each asserted to fail **with zero operation bytes written**. Why it matters: the general rule is "prove the peer is who you think before you do work for it", and the specific test assertion (`expect(f.operations).toHaveLength(0)`) is the kind that catches a half-open handshake.

- **An observation that says "unknown" is more useful than one that says "false"** — `packages/experimental/cua-macos/native/Sources/CuaNative/AXTextFormatter.swift:72-98` and `packages/experimental/cua-macos/native/Sources/CuaNative/AXTextFormatter.swift:40-48` — `valueWritable` renders `true`/`false`/`unknown`; an *omitted* optional state field is simply absent and *"omitted state fields do not assert false"*; a value, a placeholder and a URL keep their distinct meanings even when the text is identical; a structurally-empty group is *flattened* so it costs the model no line. Why it matters: this is the "absence is not false" rule applied to what the model sees, and it extends to August: a tool result that cannot determine a field should say so rather than defaulting, and a structural node that carries no meaning should not consume the model's budget.

- **Only OBSERVATION failures are retryable; INPUT failures may have left partial effects** — `packages/experimental/cua-macos/native/Sources/CuaNative/AXWorker.swift:194-199` — `observationFailure` reclassifies *only* `AXError.invalidUIElement` as `STALE_SNAPSHOT`; every other failure keeps its classification, with the comment *"Input failures can follow partial effects and keep their original classification."* Why it matters: this is the classification that makes an automatic retry safe, and it is the exact line August's tool-retry policy needs — retry a *read*, never blindly retry a *write*.

- **Content-addressed per-plugin durable state with a byte budget and a per-plugin write chain** — `packages/experimental/cua-macos`… correction, `packages/experimental/claude-code-mods/src/host-ops.ts:213-221` and `packages/experimental/claude-code-mods/src/host-ops.ts:438-450` — `$.store` is one JSON object per plugin in a storage domain, writes are serialised per plugin so a read-modify-write cannot lose a concurrent update, and the budget is checked against the **UTF-8 encoded** bytes (so 1.5 MiB of CJK is refused while 1.5 MiB of ASCII is not). Why it matters: a per-writer lock plus a byte budget measured in the encoding that will actually be stored is a small, complete answer to "how do plugins persist state without corrupting each other".

- **Host-held state that keeps the prompt prefix stable** — `packages/experimental/claude-code-mods/examples/token-weather/hooks/token-weather.mjs:18` and `:50-51` — the 12-reading history lives in `$.state` (the host's memory), *not* in the prompt; the band redraws because the drawing subscribed to the slot, not because the prompt changed. Why it matters: this is the same move as August's frozen per-session memory index — *"The boot memory index is frozen per session to protect the provider prefix cache"*. The example demonstrates that a live, changing readout can coexist with a byte-identical request prefix, and the mechanism is the read-dependency subscription rather than a prompt edit.

- **An explicit, published contract for what the model sees of a tool result, and what it costs** — `packages/experimental/claude-code-mods/README.md:174-179` and `packages/experimental/claude-code-mods/README.md:187-193` — each tool outcome has a "**What the model sees**", a "**Token effect**" and a "**KV Cache effect**" paragraph. Why it matters: August's harness work repeatedly turns on the interaction between what a tool adds to the transcript and what it does to the provider's prefix cache. Making those three paragraphs a required part of every tool's documentation is a cheap, checkable convention that would have prevented a class of cache regressions.

---

## Files skipped (with reasons)

- `packages/experimental/cua-macos/native/protocol.schema.json` — **generated** (24 KB, 1030 lines): the JSON Schema for the native request envelope, produced by `native/generate-protocol.ts` from `packages/experimental/cua/src/protocol.ts`. I opened the header and the first two method variants and confirmed the shape (`oneOf` of `{id, method, params}` objects with `additionalProperties: false`, with the `$comment` "Generated by native/generate-protocol.ts from src/protocol.ts. Do not edit."). I did **not** read it line by line because it is a machine-produced artefact whose every variant is mechanically derived from the Zod source; `tests/protocol-generation.spec.ts` already asserts it is byte-identical to a fresh render.

No other file in the shard was skipped. Every other file was opened and read; for the largest Python end-to-end runners (`native/tests/e2e.py`, `observation_benchmark.py`, `blender_keyboard_e2e.py`, `text_input_benchmark.py`, `electron_e2e.py`, `capabilities_e2e.py`, `axless_e2e.py`, `shared_helper_e2e.py`), the Swift fixtures (`Fixture.swift`, `AxlessFixture.swift`, `CapabilitiesFixture.swift`) and the two remaining Chinese READMEs, I read the file's head and structure rather than every line — the specific partial extents are recorded in the ledger's note column.

---

## Uncertainties

- **I did not read the whole of seven large Python runners.** `native/tests/e2e.py` (318 lines, read 1-110), `observation_benchmark.py` (424 lines, read 1-90), `blender_keyboard_e2e.py` (302 lines, read 1-60), `text_input_benchmark.py` (309 lines, read 1-60), `electron_e2e.py` (178 lines, read 1-80), `capabilities_e2e.py` (133 lines, read 1-100), `axless_e2e.py` (175 lines, read 1-120), `shared_helper_e2e.py` (255 lines, read 1-130) and `blender_keyboard_fixture.py` (153 lines, read 1-60). What I checked: the module docstring, the argument parser, the imports, and the assertion helpers — enough to state what each file verifies and how. What I did **not** verify: the exact assertion set in the second half of each, and whether any later section contradicts the docstring. I did not run any of them (the clone is read-only and untrusted).
- **Two Chinese READMEs were read partially.** `packages/experimental/cua-macos/README.zh.md` (226 lines, read 1-30) and `packages/experimental/cua-macos/native/README.zh.md` (131 lines, read 1-30). Both are translations of English files I read in full, and both matched the English structure in the portion I read; the remaining sections are presumably the same content in Chinese, but I did not verify them line by line. `packages/experimental/claude-code-mods/README.zh.md` I did read in full (220 lines).
- **I did not read the middle of `native/tests/swift/AXFailureTests.swift` (166 lines, read 1-70) or `native/tests/swift/ClipboardPasteTests.swift` (136 lines, read 1-60)** — both are pure unit suites whose visible half establishes the pattern (optional-attribute table; named-pasteboard isolation) and whose remaining cases I infer follow the same shape.
- **`native/tests/Fixture.swift` (237 lines, read 1-60), `AxlessFixture.swift` (99 lines, read 1-50) and `CapabilitiesFixture.swift` (127 lines, read 1-50)** — I read the class declarations and the input-recording overrides; the state-file serialisation tails were not read.
- **The two CUA packages' host-side implementation lives outside this shard.** `@deepseek-ai/dsh-cua` (`packages/experimental/cua/src/protocol.ts`, `api.ts`, `native-client.ts`, `bridge.ts`) and `@deepseek-ai/dsh-computer-use` are the packages that own the model-facing tool, the object API and the `connectCua` bridge. This shard only shows their *callers*. Specifically, I could not establish from this shard: how the CUA tool's `output` schema is declared, how `createCuaApi` builds the retained objects, how `installCua` registers the tool, or how `NativeClient.request` correlates a call id with a native request — all of those are asserted by the tests here but implemented elsewhere.
- **The `client-ui-claude-code-mods` Web band is in a different shard.** `cordis.source.patch.yml` mounts `../client-ui-claude-code-mods/src/index.ts` and the README describes the band's rendering, but the client is not in this shard, so the *rendering* half of the band (layout, wrapping, the click round-trip) is outside what I read; the *host* half (`surfaces.ts`, `elements.ts`, the Remote methods) is here.
- **Whether the bridge's "unserved" reports would actually fire in a real composition** is asserted by `tests/bridge.spec.ts:889-903` against the bridge directly; I did not trace whether the shipped Web profile mounts a mod that registers an unserved event.
- **The `turn.complete` usage fold is lossy by design and I did not find a compensating source.** `src/index.ts:142-153` folds only the *last* committed assistant message's text into `turnRecord.answer`, and accumulates token counts across `assistant/message` events. I did not find a way to see the full assistant transcript at `turn/end` in this shard, so I cannot say whether a multi-message turn's answer is truncated or whether `answer` is meant to be only the final message. The bridge's own README calls `answer` "the last committed assistant text of the turn" only in the source comment; the user-facing field is documented as the turn's answer.
- **No reasoning/thinking channel exists in either package.** I checked the event vocabulary (`ENGINE_EVENTS` in `src/matcher.ts:11-23`), the `ModEvents` type (`src/types.ts:78-87`) and the CUA operation list (`NativeProtocol.modelMethods`). Neither package carries a thinking/reasoning content type, and the CUA guidance explicitly models reasoning about *actions* rather than about tokens. If August's harness needs to surface thinking blocks to plugins or to the model, neither package is a source for it.
- **I did not run, build, or execute anything in the clone.** The `swift build`, `pnpm dsh`, `pytest` and `swift test` commands in these files are documented in the READMEs; I did not execute them. Every behavioural claim above is read from source, comments, or test assertions — not observed.
