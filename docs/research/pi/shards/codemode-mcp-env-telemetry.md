# pi / codemode-mcp-env-telemetry

## Shard shape

This shard is four sibling packages of the `pi` monorepo that never import each other but together form pi's
"outside the model" layer. **`packages/codemode`** runs model-written JavaScript in a QuickJS/wasm VM whose only
capability is calling injected tools; the shape is *one host-side `Execution` state machine* (`runtime/execution.ts`)
shared by three launchers (a Node worker thread, an in-thread inline VM, and a remote isolate over RPC), with a
JavaScript prelude (`runtime/prelude-source.ts`) that builds the script-visible `tools`/`ALL_TOOLS`/`text`/`image`/
`store` surface and a JSON Schema→TypeScript renderer (`declarations.ts`) that produces the model's tool
declarations. **`packages/env`** moves the execution environment to another machine: a Rust daemon speaking a
length-prefixed framed protocol over stdin/stdout, a TypeScript `RemoteExecutionEnv` that reproduces Node's
`NodeExecutionEnv` semantics exactly over that wire, and an SSH bootstrap that detects the remote OS, deploys a
content-addressed daemon binary, and manages host keys. **`packages/mcp`** is a dependency-free MCP client:
a transport-neutral `McpClient` (JSON-RPC correlation, cancellation, progress, pagination) over stdio and Streamable
HTTP transports, plus a full OAuth 2.1 subset (discovery, PKCE, dynamic registration, refresh, step-up) adapted from
the MCP TypeScript SDK. **`packages/telemetry`** is the observability contract: a callback-based span API with no
ambient context, a no-op implementation, an in-memory reference adapter, a backend-neutral `TelemetryStore` query
interface, and a reusable adapter-conformance suite. The four connect to August's harness through four different
seams — nested tool execution (codemode), sandboxed remote work (env), third-party tool servers (mcp), and
diagnostics (telemetry) — and each one is a candidate source of a mechanism worth stealing.

---

## Per-file notes

### packages/codemode/CHANGELOG.md
- Purpose: release history of `@earendil-works/pi-codemode` from 0.99.0 (2026-09-29) to 1.4.0 (2026-10-21).
- Key abstractions: none (prose).
- Data flow: n/a.
- Non-obvious design decisions: the 1.3.0 entry records the *breaking* change that "worker-backed results and
  `close()` now settle after requesting shutdown, not after worker exit" — the package decided a settled result
  must not wait for process teardown.
- Edge cases / failure handling: documents `#10444` (a script patching `Array.prototype.toJSON` crashed the host and
  left `execute()` unsettled), `#10283` (a print loop grew host memory until crash), `#10748` (Bun's pending
  `terminate()`), `#10707` (schema constraint tags), `#10631` (a `@options:` line that was not first was silently
  ignored), `#10725` (Node `--watch` leaking `watch:import` onto the worker channel).
- Surprising: 1.0.4/1.0.2 record the *same* class of bug twice — a malformed worker payload — first as a freeze, then
  as a "bridge broken" error. The fix was to treat the bridge as untrusted input.

### packages/codemode/examples/cloudflare/agent/src/index.ts
- Purpose: example Cloudflare Worker whose Durable Object `Session` owns the tools and runs scripts through
  `RemoteCodemodeSandbox` against a separately deployed sandbox Worker.
- Key abstractions: `CodemodeTool` (one `count` tool), `RemoteCodemodeSandbox`, `DurableObjectNamespace`.
- Data flow: `fetch` → `env.SESSION.getByName("demo").runCodemode(code)` → `sandbox.execute(code)` → RPC to
  `env.CODEMODE_SANDBOX.getByName(this.ctx.id.toString())` → tool calls come back to the session → result JSON.
- Non-obvious design decisions: the comment at line 6 says the *portable* entry is imported because "the portable
  entry has no QuickJS module: the WebAssembly lives only in the sandbox Worker" — bundling `/cloudflare` here would
  ship a 640 KB wasm into the agent Worker.
- Edge cases / failure handling: `finally { await sandbox.close() }` on every execution.
- Surprising: one sandbox instance per session id, so a session's scripts interleave on one thread.

### packages/codemode/examples/cloudflare/agent/wrangler.jsonc
- Purpose: Wrangler config binding the `Session` class and the remote `CodemodeSandbox` class.
- Key abstractions: `durable_objects.bindings` with `script_name`.
- Data flow: n/a (config).
- Non-obvious design decisions: the inline comment at lines 9-10 — "`script_name` is what puts scripts in a different
  isolate; binding a class exported from this Worker would run them on the session's thread" — is the whole point of
  the two-Worker design.
- Edge cases / failure handling: n/a.
- Surprising: nothing.

### packages/codemode/examples/cloudflare/README.md
- Purpose: 31-line pointer explaining the two-Worker example and the local `wrangler dev` invocation.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: the deploy order note — "Deploy the sandbox first, because the agent's binding refers
  to it by name".
- Edge cases / failure handling: n/a.
- Surprising: nothing.

### packages/codemode/examples/cloudflare/sandbox/src/index.ts
- Purpose: the entire sandbox Worker — one re-export of `CodemodeSandboxDurableObject` and a 404 for HTTP.
- Key abstractions: `CodemodeSandboxDurableObject`.
- Data flow: only Durable Object bindings can reach the class; HTTP gets 404.
- Non-obvious design decisions: the class is re-exported *under a different name* (`CodemodeSandbox`) so the Wrangler
  binding and the migration tag match.
- Edge cases / failure handling: n/a.
- Surprising: seven lines carry the whole remote sandbox.

### packages/codemode/examples/cloudflare/sandbox/wrangler.jsonc
- Purpose: Wrangler config for the sandbox Worker, including `cpu_ms: 60000`.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: the comment at lines 10-12 — "Keep it above the time the interrupt budget allows, so
  scripts fail with a timeout instead of resetting the object" — states the *ordering constraint* between the
  platform CPU limit and the in-script interrupt budget.
- Edge cases / failure handling: `workers_dev: false`, `preview_urls: false` (reachable only by binding).
- Surprising: hitting the CPU limit *resets* the Durable Object, which is why the budget must be lower.

### packages/codemode/package.json
- Purpose: package manifest — five subpath exports (`.`, `./declarations`, `./source`, `./portable`, `./cloudflare`,
  `./worker`) each with a `source` condition pointing at the raw `.ts`.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: the `source` export condition is how the monorepo's own tests import `.ts` directly
  (`vitest.config.ts` sets `resolve.conditions: ["source"]`), so the published `dist/` and the tested source are the
  same code.
- Edge cases / failure handling: n/a.
- Surprising: `quickjs-wasi` is pinned to an exact version `3.6.2`.

### packages/codemode/README.md
- Purpose: 374-line package manual covering the script environment, store, source format, the three sandboxes, the
  Cloudflare deployment, declarations for the model, the `pi-agent-core` integration recipe, deterministic runs, the
  result/error table and "How it works".
- Key abstractions: `CodemodeSandbox` (worker thread), `RemoteCodemodeSandbox` (another isolate), `InlineCodemodeSandbox`
  (calling thread); `MAX_OUTPUT_CHARS` 16 Mi / `MAX_OUTPUT_ITEMS` 100 000; `MAX_STORE_VALUE_CHARS` 256 Ki /
  `MAX_STORE_TOTAL_CHARS` 1 Mi; `DEFAULT_INTERRUPT_BUDGET` 100 000.
- Data flow: the README's "How it works" section is the only prose account of the whole pipeline: worker → wasm
  QuickJS instance → WASI shim (clock/random/stdout-discard) + one host-call entry point → prelude → script.
- Non-obvious design decisions: "Nested tool calls never enter the LLM context; only the script's output and return
  value do" (line 3) — the whole point of codemode. And line 62: stopping "does not guarantee computation has
  stopped", because on Bun a non-interruptible built-in keeps the worker alive.
- Edge cases / failure handling: a dedicated table of the four `result.error.kind` values (`script`, `timeout`,
  `aborted`, `sandbox`).
- Surprising: "QuickJS is an interpreter. Glue code and filtering tool results are fast enough; heavy computation is
  slower than in V8" (line 374) — the package does not pretend the VM is fast.

### packages/codemode/src/cloudflare-modules.d.ts
- Purpose: ambient declarations for `cloudflare:workers` and `*/quickjs.wasm` so the repo type-checks without a
  Workers types dependency.
- Key abstractions: `DurableObject<Env>`, a wildcard wasm module declaration.
- Data flow: n/a.
- Non-obvious design decisions: the header says these are "not published" and exist only to keep the repo's type
  check free of a Workers dependency.
- Edge cases / failure handling: n/a.
- Surprising: `declare module "*/quickjs.wasm"` is a *pattern*, not a specifier, deliberately, so `coding-agent` can
  declare the exact path for Bun without conflicting.

### packages/codemode/src/cloudflare.ts
- Purpose: the Cloudflare entry: re-exports `./portable.ts`, exposes the Wrangler-compiled QuickJS module, and
  provides `CodemodeSandboxDurableObject`.
- Key abstractions: `CodemodeSandboxDurableObject<Env>` with `protected maxInterruptBudget` and
  `protected maxMemoryLimitBytes`; `createInlineCodemodeSandbox()`.
- Data flow: `RemoteCodemodeSandbox` → RPC `execute(request, exchange)` → `serveCodemodeRemote(...)` → the VM runs
  in the Durable Object's thread; each tool call comes back over the `exchange` callback.
- Non-obvious design decisions: the Durable Object "keeps no state between executions and never touches storage"
  (lines 50-53), and the docstring warns that a class in the *same* Worker can share an isolate — and therefore a
  thread — with the objects that call it, which is why the sandbox must be a separate Worker.
- Edge cases / failure handling: `DEFAULT_REMOTE_MEMORY_LIMIT_BYTES = 32 MiB` because "Isolates have 128 MB in total";
  the remote *caps* every request at its own limits whatever the client asks for.
- Surprising: "Executions that reach the same instance share its thread: they interleave while they wait on tools, and
  a script that computes delays the others."

### packages/codemode/src/declarations.ts
- Purpose: render the model-facing TypeScript declarations for the script-visible API: `renderDeclarations`,
  `renderToolSignature`, `renderToolSample`, `renderToolOutputType`, `schemaToType`.
- Key abstractions: `CodemodeJsonSchema` (any JSON Schema), `RenderDeclarationsOptions`, `SchemaContext` (root,
  `resolving` set for recursion, `expansions` counter, `tags` flag).
- Data flow: tool `inputSchema`/`outputSchema` → `schemaToType` → TS type expression; tool `description` → doc
  comment; property descriptions and constraints → `//` comment lines above the property.
- Non-obvious design decisions: two-stage size control — `DEFAULT_INPUT_SCHEMA_MAX_CHARS = 16_000`; over budget, the
  type is re-rendered *without* the constraint tags, and only if it is still too long does it become `unknown`
  (lines 139-145). Constraint tags are `@integer @minimum 1 @default 20` style, derived from the JSON Schema
  keywords the type cannot express. `MAX_REF_EXPANSIONS = 32` bounds `$ref` expansion so shared `$defs` cannot blow
  up the output.
- Edge cases / failure handling: recursive and remote `$ref` render as `unknown` (lines 176-188); draft-04 boolean
  `exclusiveMinimum`/`exclusiveMaximum` are translated to numeric exclusive bounds (lines 268-274); a nullable
  `anyOf` field's constraints are read from the *non-null branch* (lines 256-266); tags longer than 80 chars are
  dropped and line terminators (including U+2028/U+2029) are escaped (lines 297-300).
- Surprising: the renderer's output is *the prompt*. `schemaToType` is a prompt-size budgeting algorithm, not a type
  printer.

### packages/codemode/src/identifier.ts
- Purpose: 12-line mapping from a tool name to the JavaScript identifier the script uses.
- Key abstractions: `toCodemodeIdentifier(name)`.
- Data flow: tool name → identifier; `mcp__docs__search` stays, `my-tool` → `my_tool`.
- Non-obvious design decisions: the first character must match `[A-Za-z_$]` (a leading digit is not a valid
  identifier start) and is replaced by `_`; an empty name becomes `_`.
- Edge cases / failure handling: two different tool names can normalize to the same identifier — the prelude
  resolves that with a "first tool wins" rule.
- Surprising: `mcp__docs__search` is deliberately left alone, so MCP tool names survive into scripts unchanged.

### packages/codemode/src/index.ts
- Purpose: the package's public surface — 65 lines of re-exports from `declarations`, `identifier`, `runtime/*`,
  `source`, `types`, `wasm`.
- Key abstractions: n/a (barrel).
- Data flow: n/a.
- Non-obvious design decisions: the constants `MAX_OUTPUT_CHARS`, `MAX_OUTPUT_ITEMS`, `MAX_STORE_TOTAL_CHARS`,
  `MAX_STORE_VALUE_CHARS` are re-exported from `runtime/prelude-source.ts` so a host can size its own buffers
  without importing the prelude.
- Edge cases / failure handling: n/a.
- Surprising: nothing.

### packages/codemode/src/portable.ts
- Purpose: the "no Node built-ins" entry: `InlineCodemodeSandbox` and `RemoteCodemodeSandbox` plus the shared base,
  for Cloudflare Workers, Durable Objects and browsers.
- Key abstractions: `CodemodeSandboxBase`, `InlineCodemodeSandbox`, `RemoteCodemodeSandbox`, `serveCodemodeRemote`.
- Data flow: n/a.
- Non-obvious design decisions: the header states the constraint precisely — "Neither imports `node:*` modules, so
  this entry works in Cloudflare Workers, Durable Objects, and browsers. `CodemodeSandbox`, which uses worker threads,
  stays in the main entry." The split is enforced by the file list, not by a runtime check.
- Edge cases / failure handling: n/a.
- Surprising: `portable.ts` does *not* export `loadQuickJSWasm` (it is Node-only); it exports only the `CodemodeWasmModule`
  *type*.

### packages/codemode/src/runtime/execution.ts
- Purpose: the host side of every execution — the tool table, the call records, the output list, the deadline, the
  abort signal, and the decoding of what the VM reports. 573 lines and the most important file in the package.
- Key abstractions: `CodemodeSandboxBase` (tool registry + defaults + in-flight set), `Execution` (one script run),
  `VmLauncher` (a function that starts a VM and returns a `VmChannel`), `VmEvents`, `VmChannel`, `Control`
  (the host-controlled run's callbacks), `BridgeError`.
- Data flow: constructor arms the deadline and the abort listener → asks the launcher for a channel → VM messages
  arrive on `VmEvents.message` → tool calls run on the host and their results go back via `VmChannel.post` → the first
  terminal event wins (`done`, `crash`, launcher failure, deadline, abort) → `finish()` aborts pending tool calls,
  asks the channel to stop, and resolves the result once that request completes.
- Non-obvious design decisions: (1) the launcher is the *only* difference between sandboxes — "The two sides only
  exchange the messages in `protocol.ts`, so the launchers differ in transport and termination, not in behavior"
  (lines 8-9). (2) Replies produced before the launcher returns its channel are queued in `unsent` and flushed on
  arrival (lines 192-193, 245-253). (3) The prelude runs in the *same* VM as the script, so a script that patches
  `Array.prototype.toJSON` can make it send malformed data — every payload is therefore parsed through
  `parseBridgeJson` and a decode failure becomes a `sandbox` error, not an unhandled throw (lines 97-110, 315-328).
  (4) `deliver()` serializes the outcome *before* recording anything, so a value JSON cannot hold leaves the call
  waiting for another answer (comment at line 275).
- Edge cases / failure handling: `checkGlobals` rejects reserved names, non-identifier names, `a.b.c`, duplicates and
  namespace/global conflicts (lines 151-167). A duplicate VM call id is a `BridgeError`. Pending tool calls are
  aborted with their own `AbortController` on `finish()` (lines 421-426) so a hanging tool cannot hold the result
  open. `close()` aborts in-flight executions and rejects new ones.
- Surprising: `finish()` resolves the result only *after* `channel.stop()` resolves — a worker that takes a long time
  to die delays the result, which is why the worker launcher stops *requesting* termination without awaiting it
  (`host.ts:59-66`).

### packages/codemode/src/runtime/host.ts
- Purpose: the Node/Bun launcher: one worker thread per execution, each with its own QuickJS VM.
- Key abstractions: `workerLauncher(options)`, `CodemodeSandbox`.
- Data flow: `new Worker(workerUrl, { workerData: { ...data, wasm, interrupt } })` → stdout messages → `events.message` →
  results posted back → `stop()` sets the shared interrupt flag and calls `terminate()`.
- Non-obvious design decisions: (1) a *fresh worker per execution* "keeps termination simple: a runaway script,
  including one that only spins the microtask queue, is killed with `terminate()` and cannot poison a later run"
  (lines 12-16). (2) Before terminating, the host sets a `SharedArrayBuffer` interrupt flag the VM polls, because
  "Bun's `terminate()` cannot stop a thread that is spinning in wasm" (lines 28-29). (3) `stop()` does *not* await
  the exit: `void worker.terminate()` then `worker.unref()`, with the comment "Do not hold up the result while that
  worker exits" (lines 59-66). (4) Node 24/26 `--watch` leaks `watch:import`/`watch:require` onto the worker channel
  and those messages are filtered out (lines 40-46).
- Edge cases / failure handling: a missing worker file, a failing wasm module, and a worker that exits early all
  become `kind: "sandbox"` errors. `acquireWorker()` is called *after* wasm loading and *before* the `Worker`
  constructor, and its release callback is invoked on worker exit or constructor failure (lines 30-38).
- Surprising: `onWorkerStarted(exited)` gives the host a promise that resolves when the worker *actually* exits, which
  may be after the result and after `close()` settle — the only way to keep a concurrency slot honest (types.ts:157-162).

### packages/codemode/src/runtime/inline.ts
- Purpose: run the VM on the calling thread, for runtimes without worker threads and for the remote server's side.
- Key abstractions: `inlineLauncher(wasm, interruptBudget)`, `InlineCodemodeSandbox`, `DEFAULT_INTERRUPT_BUDGET =
  100_000`, `INLINE_MAX_STACK_SIZE = 256 KiB`.
- Data flow: `startVm({ data, wasm, maxStackSize, interruptBudget, shouldInterrupt, post })` → the VM's interrupt
  handler is polled by QuickJS → the launcher counts polls → past the budget it reports `kind: "timeout"`.
- Non-obvious design decisions: **the interrupt budget is a CPU bound that works without a clock.** The header
  explains it: "QuickJS runs synchronously. While a script computes, the host's event loop does not run, so neither the
  deadline timer nor an abort signal can fire. On Workers even `Date.now()` is frozen during synchronous execution,
  so the VM cannot check a clock either." The measured numbers are given (≈50 000 polls/s on an M-series laptop,
  ≈10 000/s on Cloudflare Durable Objects) and the rule is stated: "keep it well below the platform's own CPU limit,
  because hitting that limit resets a Durable Object instead of failing one script." Reentrancy is handled by
  delivering VM messages in a microtask so host code never runs inside a VM callback (lines 30-32, 88-99).
- Edge cases / failure handling: once the VM reports `done` or `crash` the result is decided, so the VM is interrupted
  at the next poll instead of running on (lines 23-25, 84-87). A script that computes past the budget is reported as
  `kind: "timeout"`, not as a crash. The stack guard is reduced to 256 KiB because the host's main-thread stack is
  ~1 MB.
- Surprising: `shouldInterrupt` also returns `true` once `stopped || settled || exhausted` — a settled VM is
  interrupted, which is what stops a post-`done` print loop from burning the rest of the budget.

### packages/codemode/src/runtime/prelude-source.ts
- Purpose: the JavaScript evaluated inside the VM before the script runs — 522 lines that build the entire
  script-visible environment.
- Key abstractions: `PRELUDE_SOURCE` (a `(bridge, toolsJson, globalsJson, storeJson) => { settle, run, stalled }`
  factory), `MAX_STORE_VALUE_CHARS = 256 KiB`, `MAX_STORE_TOTAL_CHARS = 1 MiB`, `MAX_OUTPUT_CHARS = 16 MiB`,
  `MAX_OUTPUT_ITEMS = 100 000`.
- Data flow: the host passes the bridge function and three JSON strings; the prelude parses them, builds
  `tools`/`ALL_TOOLS`/namespaces/`store`/`load`/`text`/`image`/`exit`/`console`, and returns `settle`/`run`/`stalled`.
  The script body is compiled as `(async (tools, console) => { ... })` so `return` and top-level `await` work.
- Non-obvious design decisions: (1) **the bridge lives in a closure** so the script cannot call it directly, and the
  prelude captures `JSON.stringify`, `JSON.parse`, `Promise.prototype.then` and the error constructors *before* the
  script runs, so patching built-ins cannot corrupt what the prelude reports (lines 140-145). (2) The built-ins are
  **frozen** with a deliberate carve-out: "Freezing alone breaks ordinary code through the 'override mistake': a data
  property that is read-only on a prototype cannot be assigned on an instance either, so `this.name = "MyError"` in an
  Error subclass would throw." The fix is an accessor whose setter *defines an own property on the instance* — so
  `constructor`, `name`, `message`, `toString`, `toLocaleString`, `valueOf`, `toJSON` and every `Object.prototype`
  member stay overridable (lines 58-139, `OVERRIDABLE` at line 59). (3) `tools` is a `Proxy` whose `get` throws a
  `TypeError` naming close matches — "Reading a member that does not exist throws an error that names the close
  matches, instead of a later 'not a function'" (lines 227-247). (4) Output limits are enforced *inside* the script
  and the error is **not catchable**: `done(false, describeError(error))` is called *before* the `throw`, so the host
  already has the failure even if the script swallows the exception (lines 340-353). (5) `image()` refuses remote
  URLs, requires valid base64, and derives the MIME type from the *signature* rather than the declared type, because
  "Providers reject the whole request on a bad image, and a persisted image block would be resent on every later turn"
  (lines 396-429). (6) `stalled()` detects a script waiting on a promise nothing can settle: no tool call pending and
  no timers in the VM (lines 509-520).
- Edge cases / failure handling: `store()` enforces per-value and total size with actionable messages that name the
  alternative ("Show images with `image()`, keep large data in variables, or write it to a file with a tool") and
  throws a `RangeError` (lines 286-320). `load()` returns a *copy* (parsed fresh from JSON), so mutating it cannot
  change the store. Non-serializable store values throw a `TypeError` naming the key. `errorText()` formats stacks
  like V8 (`Name: message` then frames) and drops the prelude's own frames (lines 164-171). `describeError()` coerces
  a non-string `name`/`message` and survives a value whose coercion throws.
- Surprising: the whole built-in lockdown is *inside the script's own VM*, so the script pays for it at every start;
  the payoff is that a script cannot poison the host bridge.

### packages/codemode/src/runtime/protocol.ts
- Purpose: the message vocabulary between host and worker — `VmStartData`, `WorkerData`, `WorkerToHostMessage`,
  `HostToWorkerMessage`, and the two `is…Message` guards.
- Key abstractions: `VmStartData` (plain data, so it crosses a `postMessage` or a Workers RPC call unchanged),
  `WorkerData` (adds the compiled wasm and the 4-byte shared interrupt buffer).
- Data flow: host → worker: `result { id, ok, payload, seq?, now?, properties? }`; worker → host: `call`, `output`,
  `done`, `crash`, `started`, `idle`.
- Non-obvious design decisions: "Tool arguments, results, and values cross as JSON strings: the worker passes them into
  and out of the QuickJS VM as strings and never builds structured values itself" (lines 5-8). The deterministic-mode
  fields `seq` and `now` are optional so the same message type serves both modes.
- Edge cases / failure handling: `isWorkerToHostMessage` accepts only the six known `type` values; anything else is
  rejected and becomes a "broken bridge" sandbox error.
- Surprising: `properties` on a rejection is how a host returns structured data to the script's `catch` block
  (types.ts:192-198).

### packages/codemode/src/runtime/remote.ts
- Purpose: run the VM in another isolate (a Cloudflare Durable Object) while the tools keep running in the caller.
- Key abstractions: `CodemodeRemote` (anything with `execute(request, exchange)`), `CodemodeRemoteExchange`,
  `CodemodeRemoteRequest/Message/Reply`, `serveCodemodeRemote`, `RemoteCodemodeSandbox`, `CodemodeServeOptions`.
- Data flow: one RPC call per execution. The remote buffers output and sends it with the next call or the terminal
  message; each `exchange` carries at most one call, so concurrent tool calls are concurrent RPCs, and calls on one
  stub are delivered in order, which keeps output ordered before the call or result that follows.
- Non-obvious design decisions: the header states the measured motivation: "a script that computed for 10 seconds
  delayed the session's other requests by 10 seconds when it ran in the session object or in a Dynamic Worker, but by
  about 50 ms when it ran in a Durable Object of a separately deployed Worker." The **host keeps the host role** (tools,
  call records, deadline, abort) and the remote keeps only the VM. Output is batched: `FLUSH_ITEMS = 1_000`,
  `FLUSH_CHARS = 1 MiB` (lines 88-89) so a print loop does not make one RPC per line.
- Edge cases / failure handling: the client cannot interrupt a remote VM that is computing — when the client finishes
  first it answers every pending and later `exchange` with `{ type: "stop" }` and the remote stops at that point; a
  script that computes without calling a tool runs until its interrupt budget is used up, reported as the same
  `kind: "timeout"`. A rejecting RPC call or a return without a terminal message is `kind: "sandbox"`. The remote
  **caps** the client's requested budget and memory: `Math.min(requested, max)` (lines 109-118).
- Surprising: `exchange` registers the waiter *before* delivering the messages, "because the host may answer a call
  synchronously, for example when the tool throws before returning a promise" (lines 211-214).

### packages/codemode/src/runtime/vm.ts
- Purpose: drive one QuickJS VM through one script, independent of the transport — the single place the
  prelude↔host bridge exists.
- Key abstractions: `VmSession` (`deliver`, `dispose`), `StartVmOptions`, `VirtualClock`, `deterministicWasi`,
  `discardOutput`, `prng` (mulberry32), `fnv1a`, `DETERMINISTIC_VERSION = 1`.
- Data flow: `startVm` → `QuickJS.create({ wasm, memoryLimit, maxStackSize, interruptHandler, wasi })` → evaluate
  `PRELUDE_SOURCE` with the bridge → compile the script as an async function → `run` → `drain()` the promise job
  queue → the bridge posts `call`/`output`/`done` messages to the host.
- Non-obvious design decisions: (1) **the deterministic mode** fixes time, randomness, timezone, GC and delivery
  order so a host can replay a script after a restart: every WASI clock reads virtual time, `random_get` draws from a
  PRNG over the seed, the timezone is UTC, `WeakRef`/`FinalizationRegistry` are removed from the intrinsics, and
  results are applied strictly in `seq` order with early ones buffered (lines 22-36, 189-227). (2) The clock has a
  `creating` phase: while the context is being created the realtime clock reads a *seed-derived* value, because
  "QuickJS seeds `Math.random()` from the first clock read, and which read comes first is the engine's business"
  (lines 94-112). (3) The promise-job drain runs **one job at a time** through the internal exports and polls
  `shouldInterrupt` every `JOBS_PER_POLL = 50` jobs — because "a script such as `while (true) await null`: every
  iteration is a separate job that executes only a few opcodes, so QuickJS's own polling, which counts opcodes, would
  let it run for a long time between polls" (lines 153-154, 241-250). (4) The **fingerprint** is the identity of the
  VM: engine versions, prelude hash, deterministic version, stack size, heap limit and budget — so a replay can
  refuse a different VM (lines 317-321). (5) QuickJS's stdout/stderr writes are *discarded* because that output
  belongs to the host application (a TUI), not the script (lines 127-145).
- Edge cases / failure handling: `maxStackSize` is set so deep recursion becomes a catchable `RangeError` instead of a
  wasm trap (lines 173-175). The clock never goes backwards: `clock.now = Math.max(clock.now, next.now)` because "a
  resumed host's clock may be behind the one that started the run" (line 218). A malformed result sequence throws and
  becomes a `crash` message.
- Surprising: `vm._getExports()` is used to run promise jobs one at a time — an internal API, safe only because
  `quickjs-wasi` is pinned to an exact version (line 238-240).

### packages/codemode/src/runtime/worker.ts
- Purpose: the worker-thread entry point — 39 lines that start the VM and relay messages.
- Key abstractions: `WorkerData`, `startVm`.
- Data flow: `workerData` → `startVm({ data, wasm, post, shouldInterrupt: () => Atomics.load(interrupt, 0) !== 0 })`
  → `parentPort.on("message")` → `session.deliver(message)`.
- Non-obvious design decisions: "The VM lives until the host terminates the worker, so the session is never disposed"
  (line 23) — disposal is the host's decision. The interrupt flag is read with `Atomics.load` on a
  `SharedArrayBuffer`, so the stop request crosses the thread boundary without a message.
- Edge cases / failure handling: a startup failure is posted as a `crash` message.
- Surprising: nothing.

### packages/codemode/src/source.ts
- Purpose: parse the model-facing source format — JavaScript optionally preceded by one `// @options: {...}` line.
- Key abstractions: `CODEMODE_OPTIONS_PREFIX`, `CODEMODE_SOURCE_GRAMMAR` (a Lark grammar for providers with
  grammar-constrained tool input), `CodemodeSourceOptions`, `ParsedCodemodeSource`, `CodemodeSourceError`.
- Data flow: input → optional first-line options JSON → `{ code, options }`.
- Non-obvious design decisions: the options line is replaced by an **empty line**, not removed, "so line numbers are
  unchanged" (line 40) — a stack trace still points at the line the model wrote. Only `max_output_tokens` and
  `timeout_ms` are supported and an unknown field is an error naming the supported set. The Lark grammar exists so a
  provider with grammar-constrained tool input can be given the *shape* of the options line.
- Edge cases / failure handling: an options line that is not the first line is **rejected**, not ignored — that was
  bug `#10631`, where the timeout silently never applied. `timeout_ms` must be a positive integer ≤ 2 147 483 647
  (`setTimeout`'s maximum). `max_output_tokens` must be a non-negative safe integer. An options line with no
  following code is an error.
- Surprising: the package parses the options but *does not act on them* — "The sandbox does not act on them; the
  caller decides" (README line 104).

### packages/codemode/src/types.ts
- Purpose: the public type surface of the package — tool, result, run, sandbox and option types with their
  contracts written out in doc comments.
- Key abstractions: `CodemodeTool`, `CodemodeResult` (a discriminated union on `ok`), `CodemodeErrorKind`
  (`script | timeout | aborted | sandbox`), `CodemodeCall`/`CodemodeCallStatus` (`ok | error | cancelled`),
  `CodemodeSandboxBaseOptions`, `CodemodeSandboxOptions`, `CodemodeRun`/`CodemodeRunOptions`, `CodemodeOutcome`.
- Data flow: n/a (types).
- Non-obvious design decisions: `CodemodeToolContext.signal` is documented as "Aborted when the script finishes
  (including unawaited calls), the execution times out, the caller aborts, or the sandbox is closed" — i.e. a tool
  learns about the script's death through the *same* signal mechanism. `CodemodeDeclaredTool.jsName` exists so a
  host replaying a run can pass the *identifier the run started with*, "so a changed mapping cannot rename a tool
  under a resumed script" (lines 179-182). `CodemodeRun.deliver(seq, now, id, outcome)` documents the strict
  `seq` ordering the VM enforces.
- Edge cases / failure handling: `output` is kept for failed executions too, up to the failure; `storeWrites` is
  reported only for successful executions.
- Surprising: `CodemodeCall.status` includes `"cancelled"` — a call still running when the script returns is
  aborted through the tool's signal and recorded as cancelled, not as an error.

### packages/codemode/src/wasm.ts
- Purpose: load and compile `quickjs-wasi/quickjs.wasm` once per path.
- Key abstractions: `CodemodeWasmModule` (opaque `object` — "Typed opaquely because the Node type definitions do not
  declare the WebAssembly globals"), `loadQuickJSWasm(path?)`.
- Data flow: `createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")` → `readFile` →
  `WebAssembly.compile`.
- Non-obvious design decisions: a **failed load is retried on the next call** — the promise is deleted from the map
  on rejection (lines 28-31), so a transient failure does not poison the process.
- Edge cases / failure handling: the `path` argument exists for Bun compiled executables, where the wasm is embedded.
- Surprising: the cache is keyed by *path*, so two paths to the same wasm compile twice.

### packages/codemode/test/declarations.test.ts
- Purpose: 328 lines of exact-output tests for the schema→TypeScript renderer.
- Key abstractions: n/a (tests).
- Data flow: JSON Schema → `schemaToType` → exact expected string.
- Non-obvious design decisions: the tests pin the *exact* rendering, including the order of `@tag` values and the
  sort order of object properties — a change in the renderer's output is a change in the model's prompt, so it must be
  a deliberate diff. The file cites upstream issue `#10707` for the constraint-tag feature.
- Edge cases / failure handling: covers draft-04 boolean exclusive bounds, optional-field constraints read from the
  non-null branch, long tags being dropped, U+2028/U+2029 escaping, and the two-stage budget (`maxChars: 20` → no
  tags, `maxChars: 10` → `unknown`).
- Surprising: `schemaToType({ $ref: "#/defs/x" })` is `unknown` — only `#/$defs/` and `#/definitions/` resolve.

### packages/codemode/test/deterministic.test.ts
- Purpose: 410 lines pinning the deterministic-run contract across **two** backends (worker and remote) — the same
  test body runs for both, and the remote transport clones every message as Workers RPC would.
- Key abstractions: `BACKENDS`, `start()` helper, `waitFor()`.
- Data flow: `sandbox.start(code, { startedAt, seed, tools, onStarted, onCall, onIdle })` → the test answers calls
  with `run.deliver(seq, now, id, outcome)` → the result is compared.
- Non-obvious design decisions: the test **pins the actual random numbers** (`PINNED_SEED_ZERO = [0.6711372530266764,
  0.7258461452833667]`, `PINNED_FIRST_RANDOM = 0.34227450605335275`) with the comment "Pinned: a change here changes
  what replayed scripts see, so it must change the fingerprint too." The clock is asserted to read `STARTED_AT` then
  the time of the result being processed, and `performance.now()` counts from `startedAt`. The host's timezone is
  deliberately changed to `Asia/Kolkata` to prove the VM is UTC.
- Edge cases / failure handling: results applied in `seq` order whatever order they arrive in; the clock never goes
  backwards; a value JSON cannot hold leaves the call *waiting* for another answer; an abort ends the run with an
  error the script cannot catch; a `deliver` for an unknown call or a reused `seq` throws.
- Surprising: `execute()` is asserted to be **non-deterministic** in a separate `describe` block — the deterministic
  mode is opt-in, not a property of the sandbox.

### packages/codemode/test/fixtures/raw-worker.ts
- Purpose: an 8-line stand-in worker that posts a JSON message (or array of messages) taken from the script source.
- Key abstractions: n/a.
- Data flow: `JSON.parse(workerData.code)` → `parentPort.postMessage(message)` for each.
- Non-obvious design decisions: it lets the host tests send payloads "the real prelude never produces" — the
  malformed-bridge cases are tested this way.
- Edge cases / failure handling: n/a.
- Surprising: the fixture is what makes `#10444` (a broken bridge) testable at all.

### packages/codemode/test/fixtures/worker-process-exit.ts
- Purpose: a fixture that runs a real `CodemodeSandbox` in a **separate process** and reports how long the process
  took to exit after an abort/timeout/close.
- Key abstractions: `CodemodeSandbox`, `onWorkerStarted`.
- Data flow: `process.on("exit")` prints `{ type: "exit", elapsedMs }`; the sandbox prints `{ type: "result", kind,
  elapsedMs, workerExited }`.
- Non-obvious design decisions: the script body is deliberately CPU-heavy (`'a'.repeat(300000).indexOf(...)`) so the
  worker is inside a non-interruptible built-in when the stop arrives — the Bun case. The fixture measures the
  *process* exit separately from the *result*, because the gap between them is the whole bug (`#10748`).
- Edge cases / failure handling: `finally { clearTimeout(timer); await sandbox.close(); }`.
- Surprising: on Bun 1.4.0 a pending `terminate()` keeps the process alive even after `unref()` — independently of
  codemode — which is why the test's assertion differs per runtime (worker-lifetime.test.ts:210-228).

### packages/codemode/test/portable.test.ts
- Purpose: 159 lines covering the two non-worker sandboxes: the inline interrupt budget and the remote protocol.
- Key abstractions: `recordingRemote()` — an in-process remote that records how many messages crossed the boundary.
- Data flow: `serveCodemodeRemote(structuredClone(request), wrapped, { wasm, maxInterruptBudget })`.
- Non-obvious design decisions: the exchange is wrapped in `structuredClone` on both sides so the test exercises the
  same value-copying the real Workers RPC does. The 5 000-line print test asserts `exchanges.length <= 6`, which is
  the batching contract stated as a number.
- Edge cases / failure handling: the budget counts across waits on tools (a script that awaits a tool still burns
  budget); the remote caps the budget and the memory; an abort tells the remote to stop; a failing, vanishing or
  unreachable remote is `kind: "sandbox"` with three distinct messages.
- Surprising: the remote's memory cap is tested by *allocating* — the error message must contain "out of memory".

### packages/codemode/test/sandbox.test.ts
- Purpose: 869 lines — the behavioural core of the package, run against **all three backends** via
  `describe.each(Object.keys(BACKENDS))`.
- Key abstractions: `BACKENDS` (worker / inline / remote), `newSandbox`, `createSandbox`.
- Data flow: every test body runs three times, once per launcher.
- Non-obvious design decisions: the in-thread backends get `INTERRUPT_BUDGET = 20_000` "so runaway scripts end
  quickly". The prelude is separately checked to parse as JavaScript by Node's own `vm.Script` (lines 67-71) — the
  prelude is a *source file*, so it gets a syntax gate.
- Edge cases / failure handling: covers output limits (including the "even if it catches the error" case and the
  empty-string print loop that hits the *item* limit), the stall detector, unawaited calls being aborted, deep
  recursion becoming a catchable `RangeError`, parallel executions not sharing state, the absence of `process`/
  `require`/`setTimeout`/`fetch`/`WebAssembly`, `eval`/`Function` staying inside the VM, dynamic import failing, and
  built-in patches having no effect.
- Surprising: "still lets instances override properties of frozen prototypes" is a *separate* test from "ignores
  patches to built-ins" — the lockdown must not break ordinary JavaScript.

### packages/codemode/test/source.test.ts
- Purpose: 78 lines pinning the `@options:` line parser.
- Key abstractions: `parseCodemodeSource`, `CodemodeSourceError`.
- Data flow: n/a.
- Non-obvious design decisions: the options line is replaced by an empty line, so `{ code: "\nconst a = 1;\ntext(a)" }`
  — the test asserts the leading newline survives (lines 13-25). A CRLF options line is accepted.
- Edge cases / failure handling: a *misplaced* options line is rejected with the line number (bug `#10631`); an
  options line inside a string literal is not mistaken for one; `// @optionsx` is not the prefix.
- Surprising: the four "misplaced" cases include `'\n  // @options: {...}'` — a *leading blank line* also makes the
  options line not-first, and is rejected.

### packages/codemode/test/worker-lifetime.test.ts
- Purpose: 229 lines pinning the worker lifetime and capacity-accounting contract (`#10748`).
- Key abstractions: `acquireWorker`, `onWorkerStarted`, `Worker.prototype.terminate` spies.
- Data flow: `sandbox.execute(...)` → the fake `terminate()` never resolves → the test asserts the *result* settles
  without waiting for the worker to exit.
- Non-obvious design decisions: the fake `terminate` calls `this.ref()` to reproduce the real Node/Bun behaviour
  ("terminate() refs the worker internally") and the test asserts `unref` was called *after* `ref` by comparing
  `mock.invocationCallOrder` (lines 139-141). The test also asserts `didExit === false` at the moment the result
  settles — the exact distinction the API promises.
- Edge cases / failure handling: admission denied → no worker started and `onWorkerStarted` not called; worker
  constructor failure → the reserved capacity is released; wasm load failure → no capacity was reserved at all; a
  throwing `onWorkerStarted` → the worker is terminated and the execution fails.
- Surprising: the second half of the file spawns a **real** Node and Bun process to check that the process itself
  exits promptly, with a different assertion per runtime because Bun's `terminate()` cannot be forced.

### packages/codemode/tsconfig.build.json
- Purpose: the build config for the package.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: `files: ["src/cloudflare-modules.d.ts"]` is listed *in addition to* `include`, with
  the comment "Ambient declarations the build needs; `exclude` below does not apply to `files`" — a TypeScript
  subtlety that would otherwise drop the Cloudflare declarations from the build.
- Edge cases / failure handling: n/a.
- Surprising: nothing.

### packages/codemode/vitest.config.ts
- Purpose: 11 lines of Vitest config.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: `resolve.conditions: ["source"]` and `ssr.resolve.conditions: ["source"]` — the tests
  import the raw `.ts` sources through the package's `source` export condition, so no build step is needed to test.
- Edge cases / failure handling: the GitHub Actions reporter is selected by an env var.
- Surprising: nothing.

---

### packages/env/CHANGELOG.md
- Purpose: release history of `@earendil-works/pi-env` from 1.0.0 (2026-10-05) to 1.4.0.
- Key abstractions: n/a (prose).
- Data flow: n/a.
- Non-obvious design decisions: the 1.0.4 entry states the whole product thesis in one sentence: "Results match
  `NodeExecutionEnv` on that machine on Linux, macOS, Android and Windows. The daemon watches files natively (polling
  on Windows and network file systems), honors output windows so dropped command output is not transferred, and keeps
  control replies ahead of bulk output."
- Edge cases / failure handling: records the SSH hardening ("without forwarding, shared connections or configured
  commands") and the host-key policy ("a changed key is never accepted without removing the old one").
- Surprising: 1.2.0 adds PTYs and says "Unix only; Windows answers `ENOTSUP`".

### packages/env/daemon/build.rs
- Purpose: expose the npm package version to the Rust build as `PI_ENV_VERSION`.
- Key abstractions: n/a.
- Data flow: reads `../package.json` → `cargo:rustc-env=PI_ENV_VERSION=<version>` → `main.rs` uses
  `env!("PI_ENV_VERSION")` in the `hello` reply.
- Non-obvious design decisions: the version is *parsed by string splitting* on `"version"` rather than by a JSON
  parser — a deliberate avoidance of a serde_json build dependency in `build.rs`.
- Edge cases / failure handling: `expect` on both the read and the parse, so a malformed `package.json` fails the
  build loudly.
- Surprising: `cargo:rerun-if-changed=../package.json` means bumping the npm version rebuilds the daemon.

### packages/env/daemon/Cargo.lock
- Purpose: the Cargo dependency lockfile for the daemon.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: it pins `ignore`, `notify`, `encoding_rs`, `serde_json`, `libc` and `windows-sys` to
  exact versions (the `Cargo.toml` uses `=` requirements).
- Edge cases / failure handling: n/a.
- Surprising: nothing.

### packages/env/daemon/Cargo.toml
- Purpose: the Rust package manifest — `pi-env` v0.1.0, edition 2024, `publish = false`.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: every dependency is pinned with `=` (`encoding_rs = "=0.8.42"`,
  `ignore = "=0.4.33"`, `notify = "=8.2.0"`, `serde_json = "=1.0.151"`, `libc = "=0.2.190"`,
  `windows-sys = "=0.61.2"`). The `windows-sys` feature list is explicit and minimal.
- Edge cases / failure handling: n/a.
- Surprising: the release profile uses `lto = true`, `codegen-units = 1`, `strip = true` — the daemon is shipped as a
  binary to remote machines, so size and startup matter.

### packages/env/daemon/rust-toolchain.toml
- Purpose: pin the Rust toolchain to 1.96.0 with `rustfmt` and `clippy`.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: a pinned channel so the daemon builds identically on every machine that deploys it.
- Edge cases / failure handling: n/a.
- Surprising: nothing.

### packages/env/daemon/src/decode.rs
- Purpose: WHATWG UTF-8 decoding that matches Node's `new TextDecoder().decode(bytes)` when the input arrives in
  pieces.
- Key abstractions: `StreamDecoder`, `range_decoder()`, `decode_into()`, `starts_with_bom()`.
- Data flow: raw bytes → `encoding_rs::Decoder` → `String`, holding back an incomplete character between chunks.
- Non-obvious design decisions: `UTF_8.new_decoder_with_bom_removal()` is used for a *stream* (it removes a UTF-8 BOM
  only) while `new_decoder_without_bom_handling()` is used for a *range* — "a decoder for a byte range that does not
  start at the beginning of its input: no BOM handling at all" (lines 26-29). The comment at line 14 spells out why:
  "plain `new_decoder()` would also sniff UTF-16 BOMs and switch encodings."
- Edge cases / failure handling: invalid sequences become U+FFFD by the maximal-subpart rule; only a byte-order mark
  at the *very* start is dropped. Three unit tests pin the edge cases, including a U+FEFF that is not at the start.
- Surprising: the decoder is the reason the daemon's command output matches Node's byte for byte.

### packages/env/daemon/src/errors.rs
- Purpose: errors shaped the way Node reports them — a code plus a diagnostic message.
- Key abstractions: `Failure { code, message, details }`, `Details { syscall, path, extra }`, `describe(code)`.
- Data flow: an `io::Error` → `Failure::io(error, syscall, path)` → `to_json()` → the error frame.
- Non-obvious design decisions: the `describe()` table is **libuv's `uv_strerror` text**, reproduced so the message
  reads identically on every system (lines 96-126). `io_between` produces Node's two-path message shape
  `CODE: description, syscall 'from' -> 'to'`. When the code is unknown to libuv's table, the OS text is used with
  Rust's " (os error N)" suffix stripped and lowercased.
- Edge cases / failure handling: `Failure::extra(json!({...}))` attaches client-facing fields such as `spillPath`
  to the error JSON.
- Surprising: the *code* is the contract; the message is explicitly "diagnostic only" (protocol.md line 39).

### packages/env/daemon/src/exec.rs
- Purpose: `exec` — Durable's `NodeExecutionEnv.exec` semantics, with output streamed as events.
- Key abstractions: `Groups` (the pids the daemon started), `Control` (per-request cancellation), `ExecRequest`,
  `Message` (Data/Eof/Exit/WaitFailed/Cancel/Kill), `Spill`.
- Data flow: `control.attach(sender)` → spawn the command → two reader threads (stdout, stderr) → a waiter thread
  for the exit status → one `mpsc` channel → the main loop decodes, spills, windows and emits.
- Non-obvious design decisions: (1) `Control` is registered *before* the request runs so "a cancel that arrives first
  is not lost" (line 39). (2) The abort and the kill are **different outcomes**: an abort settles as `aborted`, while
  `cleanup()`'s kill "settles with the killed process's status" (i.e. exit code 137) — matching Node's
  `child_process` semantics (lines 33-36). (3) The timeout stays armed until the command settles, "including the grace
  period after exit" (line 374). (4) After the process exits, output is still collected for `EXIT_STDIO_GRACE = 100 ms`
  "until both pipes end, or 100 ms pass without output", and the pipes are closed when the command settles "even if a
  descendant keeps them open" (lines 438-442). (5) `Spill` keeps a *prefix* in memory until the threshold is crossed
  and then writes the whole raw output to `pi-output-<uuid>.log` in a fresh `tmp-` directory.
- Edge cases / failure handling: a missing working directory is `spawn_error`; a shell that cannot be found is
  `shell_unavailable`; a spill failure is `unknown`; a process killed by a signal reports `128 + signal`.
- Surprising: the reader threads use `output.wait_for_room(&stop)` when there is no output window — "Output of a
  command without an output window waits while more than 4 MiB of output is unsent, which slows the command as a full
  pipe would" (protocol.md lines 59-60). The back-pressure is real, not simulated.

### packages/env/daemon/src/frame.rs
- Purpose: the length-prefixed frame codec — `u32 length | u8 type | u32 id | u32 jsonLength | json | payload`.
- Key abstractions: `Frame`, `read_frame`, `write_frame`, `MAX_FRAME = 16 MiB`, `MAX_PAYLOAD = MAX_FRAME - 64 KiB`.
- Data flow: stdin bytes → `read_frame` → `Frame` → dispatch; `Frame` → `write_frame` → stdout.
- Non-obvious design decisions: "Unparseable JSON leaves the framing intact: the frame arrives with `Value::Null` and
  gets an error reply" (lines 69-74) — a malformed request must not desynchronize the stream. The length check
  `!(9..=MAX_FRAME).contains(&length)` is the framing guard; a bad length ends the connection.
- Edge cases / failure handling: a clean EOF is `Ok(None)`; a truncated frame is an `io::Error`. One unit test
  round-trips a frame with a binary payload.
- Surprising: `MAX_PAYLOAD` leaves 64 KiB of headroom so a reply's JSON always fits inside the frame limit.

### packages/env/daemon/src/fs.rs
- Purpose: file operations with Node's semantics where the Rust standard library differs.
- Key abstractions: `info(path, metadata)`, `lstat`, `realpath`, `mkdir_recursive`, `write`, `truncate`, `fsync`,
  `rename`, `rm`, `mkdtemp`, `open_reader`, `pread`, `read`, `dir_entry`.
- Data flow: JSON `path` → the syscall → a `Value` (`{ name, kind, size, mtimeSec, mtimeNsec, dev, ino }`).
- Non-obvious design decisions: (1) `mkdir_recursive` reimplements Node's recursive `mkdir`: an existing *directory* is
  fine, an existing *file* is `EEXIST`, and a file in the way of a parent is `ENOTDIR` — the latter produced with
  `sys::synthetic("ENOTDIR")` because the OS reports `AlreadyExists` (lines 54-93). (2) `fsync` checks for a directory
  *first*, because "POSIX refuses to open a directory for writing; check first so Windows reports the same" (lines
  140-147). (3) `rm` distinguishes Node's `ERR_FS_EISDIR` from the OS code and honours `force` for a missing path
  (lines 160-182). (4) `dir_entry` lstats the *decoded* name, so a name that is not valid UTF-8 reports `ENOENT`
  exactly as Node does, and carries the original bytes in `raw` for byte-order sorting (lines 242-257).
- Edge cases / failure handling: `open_reader` returns `EISDIR` for a directory and `NOT_REGULAR` for a FIFO/device;
  `pread` retries on `Interrupted` and returns fewer bytes only at EOF; `read` makes exactly one `read` call, "as
  Node's `readFile` makes for files of unknown size (FIFOs, devices)".
- Surprising: `write` creates missing parents like Node's recursive `mkdir` and then opens with `writeFile` (`w`) or
  `appendFile` (`a`) semantics, returning the open file so the client can keep appending chunks.

### packages/env/daemon/src/list.rs
- Purpose: the `listFiles` operation — a bounded, cancellable, gitignore-aware tree listing.
- Key abstractions: `Options` (hidden, gitignore, exclude, max_entries, max_bytes, timeout), `Listing`, `list()`,
  `run()`.
- Data flow: JSON options → `ignore::WalkBuilder` → a payload of `kind byte | path | NUL` records → `{ count, truncated }`.
- Non-obvious design decisions: the walker uses the **`ignore` crate — the same one `fd` and `ripgrep` use** — with
  `.require_git(true)` so gitignore rules apply only inside a real work tree, `.follow_links(false)`, and
  `.current_dir(root_path)` so "the global excludes file is found relative to the listed directory, not the daemon's"
  (line 106). The record format is a kind byte + the relative path + a NUL, which makes a path with a newline
  unambiguous.
- Edge cases / failure handling: a missing root is `ENOENT`, a file root is `ENOTDIR`; an abort mid-walk is
  `aborted`; the walk stops with `truncated: true` at `max_entries` (default 50 000), `max_bytes` (default 4 MiB,
  clamped to `MAX_PAYLOAD`) or `timeoutMs` (default 10 000); entries that cannot be read are skipped; names that are
  not UTF-8 get replacement characters.
- Surprising: the tests build a real tree and assert the *exact* listing order — depth first, siblings in byte order
  of their names — and that a symbolic link to a directory is listed as a link and never followed (including a
  symlink loop).

### packages/env/daemon/src/main.rs
- Purpose: the daemon's entry point — the frame loop, the request registry, the worker pool and the process groups.
- Key abstractions: `Server` (handles, controls, groups, terminals), `FileHandle` (with a `failed` flag and a `Serial`
  queue), `DirHandle`, `Control`, `Groups`.
- Data flow: `serve(token)` → print `PI-ENV <token>\n` → start the output writer thread → `serve_frames` reads frames
  → dispatch to a worker thread (exec/watch/pty) or the 16-thread pool (file operations) → `respond` writes the reply.
- Non-obvious design decisions: (1) **a request's `Control` is registered before the request runs**, "so a cancel right
  behind it is not lost" (lines 428-431). (2) File operations run on a fixed pool of 16 workers, but `exec`, `watch` and
  `pty` get their own thread with a 16 MiB stack ("watchers recurse through trees"). (3) `ptyWrite`, `ptyResize` and
  `ptyForeground` are answered *inline, in arrival order*, because "through the worker pool, two writes could swap"
  (lines 407-426) — a keystroke-order guarantee. (4) Chunk writes to one handle are serialised through
  `run_in_order`, and a failed chunk **poisons** the handle so later chunks fail with `EBADF` and the file has no
  gaps (lines 172-182). (5) `respond` routes the reply: an `exec`/`pty` result or a reply with a payload over 64 KiB
  goes to the *bulk* queue, everything else to the *control* queue, "so a slow link delays bulk data, not replies"
  (lines 362-375). (6) The daemon kills every process group it started and exits after 30 s of silence, "a client that
  went silent (a phone that lost its network) leaves nothing running" (lines 499-510). (7) `Seen<R>` wraps stdin so a
  large frame arriving slowly still counts as a live client.
- Edge cases / failure handling: `MAX_HANDLES = 4096` open handles per connection (`EMFILE` beyond); a frame with a
  JSON that does not parse gets `EINVAL`; `writeChunk` after a failed chunk is `EBADF`; the daemon exits with code 1
  and a message on stderr if `serve` fails.
- Surprising: `main` always ends with `std::process::exit(0)` after `serve` returns, because "Request threads may still
  be blocked (a FIFO open); nothing is left to answer them" (lines 542-543).

### packages/env/daemon/src/output.rs
- Purpose: the single writer of stdout, with two queues.
- Key abstractions: `Output` (control queue, bulk queue, `bulk_bytes`, two condvars), `Queues`.
- Data flow: `control(frame)` / `bulk(frame, unsent)` → the `run(writer)` thread → `frame::write_frame`.
- Non-obvious design decisions: **control frames always go before bulk output** — "a slow link delays output but never
  a cancel's result or a ping" (lines 1-4). The writer pops control first, then bulk. `wait_for_room(stop)` blocks a
  reader while more than `BULK_LIMIT = 4 MiB` of bulk output is unsent, which is how a command is slowed by a full
  pipe.
- Edge cases / failure handling: a write failure closes the queues and ends the writer; `close()` wakes every waiter;
  `wait_for_room` wakes every 100 ms so a `stop` flag is noticed.
- Surprising: the `unsent` counter is per-sender and lets the exec loop know when a previous frame has been written
  (used by the output window's pacing).

### packages/env/daemon/src/pty.rs
- Purpose: run a program in a pseudo-terminal — raw output, input, resize, foreground job, exit code.
- Key abstractions: `Terminal`, `Terminals` (a map from the `pty` request id to the terminal), `PtyRequest`, and a
  `unix` submodule with `openpty`, `TIOCSWINSZ`, `tcgetpgrp`, `poll` and `process_name`.
- Data flow: `pty` request → `openpty` → the program runs in a new session with the pty as its controlling terminal →
  a reader thread polls the master fd → raw bytes are posted as `output` events → `ptyWrite`/`ptyResize`/
  `ptyForeground` address the terminal by the `pty` request id.
- Non-obvious design decisions: (1) the program is a **session leader** with the pty as its controlling terminal, so
  job control and SIGHUP work; signal dispositions are reset to default and the signal mask emptied, "as for `exec`"
   (lines 452-472). (2) Without `argv`, the daemon runs `$SHELL` (or `/bin/sh`) as a *login* shell — `arg0` is set to
  `-<name>` (lines 393-416). (3) The master fd is `O_NONBLOCK` and read with `poll`, so a write to a program that is not
  reading waits rather than deadlocking. (4) `foreground()` returns `null` when the program's own group is in front
   (a shell at its prompt) and otherwise the group's pid plus the leader's name, read from `proc_name` on macOS and
  `/proc/<pid>/comm` on Linux. (5) On Windows the whole `run` is `ENOTSUP`.
- Edge cases / failure handling: `MAX_CELLS = 4096`; a missing working directory is `spawn_error`; a missing terminal
  is `EBADF`; after the program exits, output is still collected for `EXIT_GRACE = 100 ms`; a background job holding
  the terminal open does not block the exit.
- Surprising: the `write_all` helper returns `false` once the terminal is gone, so the writer thread ends quietly
  instead of raising.

### packages/env/daemon/src/scan.rs
- Purpose: a port of Durable's `LineScanner` — locate lines `[start_line, end_line)` of a file fed in order and measure
  their *decoded* UTF-8 size.
- Key abstractions: `LineScanner` (position, newline count, selection and first-line decoders, BOM head buffer).
- Data flow: 64 KiB chunks → `push(chunk)` → the scanner finds newlines and feeds byte ranges into two
  `encoding_rs` decoders → `finish()` returns `{ newlines, start, end, firstLineEnd, lastLineStart, selectedBytes,
  firstLineBytes }`.
- Non-obvious design decisions: the size of a line range is measured as it would be if the *whole* file were decoded,
  so a multi-byte character split across a chunk boundary counts correctly. The first three bytes are held back to
  detect a leading BOM, and the BOM is excluded from the selection's byte count. The selection and the first line use
  `range_decoder()` (no BOM handling) because they are ranges, not the whole input.
- Edge cases / failure handling: the unit test feeds the same file in chunk sizes 1..5 and asserts the same result for
  all of them — a chunk-boundary property test.
- Surprising: the scanner counts *decoded* bytes, so `selectedBytes` for a file with invalid sequences is the length
  of the replacement characters, not the raw bytes.

### packages/env/daemon/src/sys/mod.rs
- Purpose: the OS-abstraction seam — error names, positional reads, temp directories, opening readers, starting and
  killing commands.
- Key abstractions: `ShellConfig`, `OpenMode` (`Read | Write | Append | ReadWrite`), `Synthetic` (a libuv error code
  the system did not report), `error_name`, `path_exists`, `random_bytes`, `cwd`.
- Data flow: n/a.
- Non-obvious design decisions: `Synthetic` exists because "An error code libuv reports where the system call itself
  reported another one, such as `ENOTDIR` from a recursive `mkdir` through a file, or `EISDIR` when Windows creates a
  file where a directory exists" (lines 32-35) — the daemon reports libuv's vocabulary, not the OS's. `random_bytes`
  is explicitly "for temporary names (not for secrets)".
- Edge cases / failure handling: `error_name` unwraps the `Synthetic` downcast before falling back to the platform
  translation.
- Surprising: the comment on `random_bytes` says outright that it must not be used for secrets.

### packages/env/daemon/src/sys/unix.rs
- Purpose: the Unix half of the OS seam (Linux, macOS, Android).
- Key abstractions: `os_error_name`, `read_at`, `mtime`, `identity`, `tmpdir`, `home`, `mkdtemp`, `open_reader`,
  `open`, `realpath`, `rename`, `remove_file`, `Pipe` trait, `read_pipe`, `resolve_program`, `shell_config`,
  `configure`, `after_spawn`, `kill_tree`, `exit_code`, `raw_name`, `drive_cwds`, `read_dir`, `path_identity`.
- Data flow: n/a.
- Non-obvious design decisions: (1) `open_reader` uses `O_NONBLOCK` so opening a FIFO does not block, and adds
  `O_NOFOLLOW` when asked, mapping `ELOOP`/`EMLINK` to the libuv code `SYMLINK` (lines 110-126). (2) `shell_config`
  reproduces Node's resolution exactly: a configured shell must exist (else `shell_unavailable`), then `/bin/bash`,
  then `which bash`, then `sh` (lines 228-248). (3) `configure` does the `pre_exec` work: `setsid()`, default signal
  dispositions for 1..32 except SIGKILL/SIGSTOP, and an empty signal mask — "as libuv sets" (lines 266-281). (4)
  `kill_tree` kills the whole process *group* (`kill(-pid, SIGKILL)`) and falls back to the pid. (5) `exit_code`
  reports `128 + signal` for a signalled process.
- Edge cases / failure handling: `read_pipe` sets the fd non-blocking and polls with a 100 ms timeout so the reader
  notices the `stop` flag; `Interrupted` is retried. `tmpdir` follows `TMPDIR`, `TMP`, `TEMP`, then `/tmp` (Termux:
  `$PREFIX/tmp`) and strips a trailing slash.
- Surprising: `raw_name` returns the *raw bytes* of a file name on Unix, which is what libuv sorts by — the Windows
  implementation returns `None` because Windows listings keep the file system's order.

### packages/env/daemon/src/sys/windows.rs
- Purpose: the Windows half of the OS seam, following libuv's `src/win/error.c`, `process.c` and `fs.c`.
- Key abstractions: the same surface as `unix.rs`, plus `child_environment`, `quote_argument`, `job()`, `path_identity`.
- Data flow: n/a.
- Non-obvious design decisions: (1) `os_error_name` is a hand-written translation of Windows error codes into libuv
  names, with comments giving the Windows code each maps from (lines 38-65) — including `267` (ERROR_DIRECTORY) → ENOENT
  and `126` (ERROR_MOD_NOT_FOUND) → ENOENT. (2) `open` uses `CreateFileW` with `FILE_FLAG_BACKUP_SEMANTICS` so a
  directory opens and later calls on it fail as in Node, and `ERROR_FILE_EXISTS` while creating becomes the synthetic
  `EISDIR` (lines 176-212). (3) `quote_argument` reimplements libuv's `uv_fs_quote_cmd_arg`, walking the string
  *backwards* to double the backslashes before a quote (lines 418-447). (4) `child_environment` sorts the child
  environment by UTF-16 code units, keeps the first of names differing only in case, and then adds libuv's eleven
  `REQUIRED_VARIABLES` (lines 449-499). (5) Every child is assigned to a **Windows Job Object** with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so the daemon's exit kills its whole tree (lines 518-551). (6) `kill_tree` is
  `taskkill /F /T /PID`, not waited for.
- Edge cases / failure handling: `open_reader` has no `O_NOFOLLOW` on Windows, so it checks the path first — "not
  race-free", and the comment says so. `remove_file` removes a symlink-to-directory as a directory entry and retries a
  read-only file after making it writable. `path_identity` opens a handle to get the volume serial number and file
  index, because "the creation time is not enough, because NTFS gives a file created under a recently removed name
  the old one's creation time ('tunneling')" (lines 606-608).
- Surprising: `realpath` strips the `\\?\` prefix and re-expands `\\?\UNC\` to `\\`, matching libuv's `uv_fs_realpath`.

### packages/env/daemon/src/watch.rs
- Purpose: Durable's `NodeFileWatcher` running *next to the files*, so a scan costs no round trips.
- Key abstractions: `Target`, `Entry` (kind, dev, ino, size, mtime, optional hash), `Snapshot`, `Mode`
  (`Native | Polling`), `ScanError`, `Scan`, `Installed`, `FileWatcher`.
- Data flow: `watch` request → an initial `sync(false)` → a `ready` event → then either native events (debounced 50 ms)
  or a 2 s poll → each flush re-scans and diffs the snapshots → a `change` event with the changed paths.
- Non-obvious design decisions: (1) **native events only trigger a debounced rescan**; the reported change set is the
  *difference between two snapshots* plus the event paths (lines 1-3). (2) A file system that accepts watches but does
  not report remote changes (NFS, SMB, CIFS, FUSE, 9P, Lustre, GPFS, Ceph, OpenAFS, kAFS, sdcardfs) is detected by
  `statfs` magic number and forces polling (lines 33-48, 186-208). (3) Windows always polls, because "Windows refuses
  to rename a directory while a directory below it is open, and native watchers keep watched directories open"
  (lines 707-708). (4) In polling mode, recently modified small files are *also* compared by content hash, because
  mtime alone misses same-second writes (lines 258-281, `HASH_MAX_BYTES = 256 KiB`, `HASH_RECENT = 5 s`). (5) A
  watcher follows the *directory it was installed on*, not the path: a stale watcher is one whose `dev`/`ino` changed
  (lines 493-510). (6) A directory's own timestamps are ignored in the diff — "an ancestor's own timestamps change with
  every unrelated sibling" (line 367). (7) `sort_like_javascript` sorts by UTF-16 code units, matching JavaScript's
  default sort.
- Edge cases / failure handling: `max_directories` (default 10 000) is a budget that fails the open with `EINVAL`; a
  watched directory that is unreadable fails the request while unreadable subdirectories are skipped; a missing target
  is watched for its creation; running out of native watchers switches to polling **and reports `overflow`** so the
  client knows coverage was uncertain; macOS gets a 500 ms settle window because "FSEvents streams go live after
  `watch` returns".
- Surprising: `in_scope` re-derives the exclusion rules for *event* paths, so an event about an excluded name or an
  unrelated sibling is ignored (lines 586-605).

### packages/env/daemon/src/window.rs
- Purpose: Durable's output window — undelivered command output is held and coalesced, and text that provably fell
  out of the window is replaced by counts.
- Key abstractions: `Window` (max_bytes, max_lines, min_interval, bytes_per_second), `Skipped`, `Event`, `Pending`.
- Data flow: decoded output → `Pending::push(stream, text)` → (occasionally) `trim()` → `Pending::take()` → one or more
  output events, the first carrying the `skipped` counts.
- Non-obvious design decisions: (1) the window is a *tail* guarantee: "text followed by more than the window (by a
  byte or a line) can never be in the caller's tail and is replaced by counts" (lines 1-3). (2) `trim()` removes the
  longest prefix whose *remainder still proves* exclusion by counts — it only cuts a prefix if what stays is still
  larger than the window (lines 97-100). (3) The cut is made at a **character boundary**, walking the byte index back
  until `is_char_boundary` (lines 126-132). (4) Trimming is done "once a few windows have accumulated" rather than on
  every push, to amortise the pass over the held text (lines 89-94). (5) The delivery pace is `max(min_interval,
  delivered_bytes / bytes_per_second)`, so the caller sets the commit pace.
- Edge cases / failure handling: when anything was skipped, the delivery is **one** event carrying the counts plus all
  the text after it; otherwise it is one event per stream segment, preserving stream order. A unit test feeds 500
  mixed-stream lines and asserts that every byte is either delivered or counted and that the text after the last skip
  is a suffix of the full output.
- Surprising: the skipped counts include `endsWithNewline`, so the caller can tell whether the cut landed on a line
  boundary.

### packages/env/docs/protocol.md
- Purpose: the wire protocol specification — frames, types, cancellation, scheduling, liveness and every operation.
- Key abstractions: the six frame types (request/result/error/event/cancel/ping), the operation table, the `hello`
  reply shape.
- Data flow: the doc is the normative text the TS client and the Rust daemon are both written against.
- Non-obvious design decisions: (1) The **sync marker**: "Shell startup files may print to stdout before the daemon
  runs. The daemon's first output is the line `PI-ENV <token>\n`… The client discards everything before that line"
  (lines 6-10) — the protocol has an explicit handshake because the transport is a login shell. (2) Errors carry
  `{ code, message, syscall?, path? }` and "Messages are diagnostic; only codes are part of the contract". (3) The
  scheduling section is the daemon's fairness contract: "Results, errors, pings and `watch` events are sent before
  queued command output, and results with payloads above 64 KiB queue behind output too, so a slow link delays bulk
  data, not replies." (4) Handles are per-connection: "handles belong to the daemon that opened them, so requests on
  them fail instead of reaching the new one."
- Edge cases / failure handling: a request whose JSON does not parse gets `EINVAL`; framing errors end the connection;
  a cancel names one request and is never lost; `scanLines` stops between chunks and `listFiles` between entries.
- Surprising: `hello.features` is the **capability negotiation**: "Operations added to protocol 1 after its first
  release (`listFiles`); older daemons omit the field and refuse those operations as unknown, so clients check it
  first." Version 1 of the protocol is extensible without a version bump.

### packages/env/docs/semantics.md
- Purpose: the normative statement of which side of the boundary does what, and the rules the standard libraries do
  not follow.
- Key abstractions: the "Split of work" table (path resolution and abort checkpoints and error mapping on the
  *client*; system calls, processes, spill files and line scans on the *daemon*; watching next to the files).
- Data flow: n/a (spec).
- Non-obvious design decisions: the reference is *Durable's `NodeExecutionEnv` on the remote machine*, not "what the
  OS does" — every rule is checked by the conformance suite and the differential test. The "Rules the standard
  libraries do not follow" section lists the exact deviations: recursive `mkdir` semantics, `rm`'s `ERR_FS_EISDIR`,
  `mkdtemp`'s POSIX `path.join` of the prefix, the `tmpdir` fallback order, `listDir`'s byte order and its "fails if
  any entry cannot be lstat'ed" rule, `openBinaryReader`'s `O_NOFOLLOW`, and the platform differences (Windows
  libuv error codes, symlink-to-directory removal, negative mtimes before 1970).
- Edge cases / failure handling: documents the abort settles as `aborted` while `cleanup()` kills without aborting so
  the command settles with exit code 137; a process killed by a signal reports `128 + signal`.
- Surprising: `listFiles` has *no* `NodeExecutionEnv` counterpart — it exists so that the local and the remote
  environment list files with the same code, and the daemon implements it for both.

### packages/env/package.json
- Purpose: the package manifest for `@earendil-works/pi-env` v1.4.0.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: `files` includes `bin` and `docs` — the **daemon binaries are published with the npm
  package**, which is what makes the SSH deploy work with no build step on the remote machine. The
  `build:daemon` script is `cargo build --manifest-path daemon/Cargo.toml --locked`.
- Edge cases / failure handling: n/a.
- Surprising: the package depends on `@earendil-works/pi-durable` and `@earendil-works/chord` — the env package is a
  *durable* concern, not a standalone tool.

### packages/env/README.md
- Purpose: 66 lines on the remote execution environment: the daemon, the client, the SSH bootstrap, `listFiles`, the
  terminal, the supported platforms and the development workflow.
- Key abstractions: `RemoteExecutionEnv`, `Connection`, `acceptHostKey`, `connectSsh`, `sshConnection`,
  `LocalExecutionEnv`, `openTerminal`, `localDaemon`, `nodePlatform`.
- Data flow: n/a.
- Non-obvious design decisions: the SSH hardening is stated as a *property of the product*: "`ssh` runs with
  `BatchMode`, strict host-key checking against the application's own known-hosts file under a fixed alias, no
  forwarding of any kind, no shared connections or configured commands, and without forwarding the local locale."
- Edge cases / failure handling: "A daemon released before it reports `not_supported` (`hello.features` lacks
  `listFiles`), and callers fall back to their own walk." On Windows, detection and deployment go through PowerShell
  and the daemon starts through the server's default shell (cmd.exe or PowerShell).
- Surprising: "Terminals are not supported on Windows yet", and on Windows *string* commands run through Git Bash
  "as `NodeExecutionEnv` runs them there; argv commands run directly."

### packages/env/src/connection.ts
- Purpose: the framed-protocol client — spawn the daemon, handshake, correlate requests, decode frames, keep it alive.
- Key abstractions: `Connection`, `Session`, `RemoteError`, `RemoteInfo`, `Reply`, `RequestOptions`, `nodePlatform`,
  `isConnectionLost`.
- Data flow: `request(op, json, options)` → a frame → the daemon → a result/error frame → the pending promise; events
  go to `options.onEvent`.
- Non-obvious design decisions: (1) **the sync marker**: until the daemon's `PI-ENV <token>\n` line is seen, stdout is
  scanned for that marker and anything before it is treated as shell-startup noise (up to 1 MiB) and passed to
  `onLog` (lines 340-355). (2) The frame parser is defensive: a length outside `[9, MAX_FRAME]` or a JSON that does
  not parse **tears the connection down** rather than trying to resynchronise (lines 356-377). (3) The payload is a
  *plain* `Uint8Array` copy, "like `NodeExecutionEnv`'s reader results, not a view of the receive buffer" (line 378).
  (4) A failed start is **not remembered**: "A failed start is not remembered: the next request tries again"
  (lines 229-237) — a transient network failure does not poison the connection. (5) The daemon is started with a
  random 16-byte token, and the token is also the sync marker. (6) The client pings every 5 s and tears the connection
  down after 30 s of silence.
- Edge cases / failure handling: `options.session` binds a request to the session that opened the handle — after a
  reconnect, such a request fails with `lost` rather than reaching a daemon that never opened the handle (lines
  203-213). `options.signal` sends a `cancel` frame but "the request still settles with the daemon's result or error".
  `kill(id, session)` kills one `exec` without aborting it.
- Surprising: `nodePlatform` maps the daemon's Rust names to Node's (`windows`→`win32`, `macos`→`darwin`,
  `x86_64`→`x64`, `aarch64`→`arm64`) so the two sides can compare `process.platform` directly.

### packages/env/src/errors.ts
- Purpose: map the daemon's error codes onto Durable's `FileError` codes, exactly as `NodeExecutionEnv` does.
- Key abstractions: `toFileError(error, fallbackPath)`, `abortResult(signal, path)`.
- Data flow: a `RemoteError` (or any thrown value) → a `FileError` with a Durable code.
- Non-obvious design decisions: the mapping table is literal — `ENOENT`→`not_found`, `EACCES`/`EPERM`→
  `permission_denied`, `ENOTDIR`→`not_directory`, `EISDIR`→`is_directory`, `EINVAL`/`SYMLINK`/`NOT_REGULAR`→`invalid`,
  `aborted`→`aborted`, everything else→`unknown`.
- Edge cases / failure handling: a non-`RemoteError` becomes `FileError("unknown", cause.message, fallbackPath, cause)`
  with the cause attached; the path falls back to the error's own path.
- Surprising: `abortResult` returns `undefined` rather than a Result when the signal is not aborted, so call sites can
  write `const aborted = abortResult(...); if (aborted) return aborted;`.

### packages/env/src/index.ts
- Purpose: the package's public surface — 32 lines of re-exports.
- Key abstractions: n/a (barrel).
- Data flow: n/a.
- Non-obvious design decisions: `deployDaemon`, `detectPlatform`, `sshArguments`, `packagedDaemon` and
  `localDaemon` are exported from the *root* entry, so an application can drive the bootstrap itself.
- Edge cases / failure handling: n/a.
- Surprising: nothing.

### packages/env/src/list-files.ts
- Purpose: `listFiles` over the daemon, and `LocalExecutionEnv` — `NodeExecutionEnv` plus a daemon-backed `listFiles`.
- Key abstractions: `listFilesOver(connection, path, options, context)`, `LocalExecutionEnv`.
- Data flow: `listFiles` request → a binary payload of `kind byte | path | NUL` records → `FileListEntry[]`.
- Non-obvious design decisions: the **capability check before the request**: `if (!(await connection.info()).features?.includes("listFiles")) return err(new FileError("not_supported", ...))` — "A daemon released before it reports `not_supported`… so callers fall back to their own walk" (lines 39-41). The payload format is decoded with a NUL scan, so a path with a newline survives. Fields left `undefined` are not sent, so the daemon applies its own defaults.
- Edge cases / failure handling: `maxEntries`/`maxBytes`/`timeoutMs` are validated as non-negative safe integers
  *before* the request; the abort is checked both before and after the request; a record with an unknown kind byte is
  skipped rather than failing the whole listing.
- Surprising: `LocalExecutionEnv` exists so that a *local* session and a *remote* session list files with the same
  code — the daemon runs on the same machine.

### packages/env/src/remote-env.ts
- Purpose: the `ExecutionEnv` implementation for another machine — 957 lines reproducing `NodeExecutionEnv` over the
  wire.
- Key abstractions: `RemoteExecutionEnv`, `Handle` (a daemon handle valid only in the session that opened it),
  `RemoteBinaryReader`, `RemoteDirReader`, `RemoteTextLineReader`, `readRange`, `remotePath`.
- Data flow: every method resolves the path, checks the abort, issues one or more framed requests, and maps the
  daemon's errors back to `FileError`.
- Non-obvious design decisions: (1) **the client owns Node's semantics, the daemon owns the syscalls** — the client
  does the path resolution (including Windows drive-relative paths against the remote's `=C:` variables), the abort
  checkpoints, the error mapping, the read chunking and the decoding (semantics.md's "Split of work"). (2) `readRange`
  keeps up to `READ_DEPTH = 8` reads in flight with `READ_CHUNK = 256 KiB`, and a short read "continues from where it
  ended, as sequential reads would" (lines 94-131). (3) `writeFile` writes 512 KiB chunks with an abort check before
  each; `appendFile` does not check (Node's `appendFile` is one write) — the two paths are explicitly different
  (lines 586-629). (4) `listDir` sorts by *raw bytes* on POSIX, "libuv sorts names by their bytes on POSIX; on Windows
  it keeps the file system's order" (lines 704-710). (5) `exec` distinguishes the failure kinds: `timeout`, `aborted`,
  `shell_unavailable`/`spawn_error`, else `unknown`; and an `onOutput` callback that throws becomes
  `ExecutionError("callback_error", …)` and aborts the command (lines 907-921). (6) `cleanup()` kills without aborting,
  "so the commands settle with their killed status, as `NodeExecutionEnv` does" (lines 950-954).
- Edge cases / failure handling: a directory entry that vanished between enumeration and `lstat` is *skipped* in
  `openDirReader` but *fails* in `listDir` — matching Node's two different code paths. A file larger than 2 GiB is
  refused with a clear message. A read of a file of unknown size (a FIFO) loops until EOF.
- Surprising: `#resolve` implements Node's Windows drive-relative resolution against the *remote's* per-drive working
  directories, reported by the daemon as `driveCwds` (lines 391-400) — a detail most remote-execution layers skip.

### packages/env/src/ssh.ts
- Purpose: the SSH bootstrap — argument construction, host-key management, platform detection and daemon deployment.
- Key abstractions: `SshTarget`, `RemotePlatform`, `sshArguments`, `scanHostKey`, `acceptHostKey`, `forgetHostKey`,
  `detectPlatform`, `packagedDaemon`, `localDaemon`, `deployDaemon`, `sshConnection`, `connectSsh`, `runSsh`.
- Data flow: `connectSsh` → `detectPlatform` (a `sh -c` probe, or PowerShell on Windows) → `deployDaemon` (upload,
  SHA-256 verify, rename into place) → a `Connection` whose command is `ssh <args> <daemon path>`.
- Non-obvious design decisions: (1) `sshArguments` is a **fixed, explicit list**: `BatchMode=yes`,
  `ClearAllForwardings=yes`, `ForwardAgent=no`, `ForwardX11=no`, `ControlMaster=no`, `ControlPath=none`,
  `RemoteCommand=none`, `PermitLocalCommand=no`, `SendEnv=-*` (no locale forwarding),
  `ServerAliveInterval=15`, strict host-key checking, `GlobalKnownHostsFile=none`, `HashKnownHosts=no`, and `--`
  before the host (lines 77-120). Every field is validated first: no leading `-` (it would be read as an option) and
  no whitespace or control characters. (2) The daemon binary is **named by its SHA-256** and lives at
  `~/.pi/mobile/tools/pi-env-<sha256[0..32]>`, so versions never collide; the upload goes to a temp file and is
  renamed into place only after the hash matches, and daemons of other contents are removed (lines 378-461). (3)
  `acceptHostKey` **never replaces a trusted key**: a key that differs from a trusted key of the same type is refused
  with `HostKeyChangedError` and `forgetHostKey` must be called first; only plain lines for the target's alias are
  accepted, and marker/hashed lines are rejected (lines 209-279). (4) The known-hosts file is rewritten **one change
  at a time, atomically** (a temp file plus `rename`), with a per-file promise chain so two concurrent accepts cannot
  interleave (lines 224-251). (5) `sshConnection` is lazy: nothing happens until the first request, and a failure is
  that request's error; the next request tries again.
- Edge cases / failure handling: a POSIX host without `sha256sum`, `shasum` or `openssl` is refused outright
  ("has no sha256sum, shasum or openssl to verify pi-env") rather than deployed unverified. On Windows the upload
  travels as base64 lines with an end marker, because "PowerShell reads redirected stdin itself, as text lines for
  `$input`, so the binary comes as base64 lines up to an end marker: Windows' sshd may never pass on the end of
  stdin" (lines 425-430). The PowerShell upload retries the final `Move-Item` 20 times, because "a running daemon or a
  virus scanner can hold the old file for a moment".
- Surprising: `detectPlatform` falls back from the POSIX probe to a PowerShell probe when the remote shell is cmd.exe
  or PowerShell, and falls back again when the POSIX probe reports MINGW/MSYS/CYGWIN (Git Bash) — "ask PowerShell for
  Windows' own architecture and home spelling" (lines 329-353). Termux gets explicit warnings about `TMPDIR` and
  `termux-exec`.

### packages/env/src/terminal.ts
- Purpose: the client side of a remote pseudo-terminal.
- Key abstractions: `RemoteTerminal`, `TerminalOptions`, `TerminalForeground`, `openTerminal`.
- Data flow: `pty` request → a `started` event with the pid → `output` events → `ptyWrite`/`ptyResize`/
  `ptyForeground` requests addressed by the `pty` request id → a final `{ exitCode }`.
- Non-obvious design decisions: (1) `openTerminal` resolves from the `started` event, not from the request's
  completion: the `pty` request *is* the terminal's lifetime, so it only settles when the program exits (lines 92-127).
  (2) A failure *before* the terminal started rejects the open; a failure afterwards is carried by `exited`. (3) Input
  is chunked at 1 MiB because "frames are at most 16 MiB" (lines 3-4, 56-61). (4) `write`/`resize` swallow their
  errors: "A terminal that ended or a lost connection: `exited` reports it."
- Edge cases / failure handling: `close()` aborts the request, which kills the process group; the daemon answers
  `ptyForeground` with `EBADF` once the terminal has ended.
- Surprising: `foreground()` exists to tell "what a shell runs, such as an editor" from the prompt — the mechanism
  behind a TUI that can show the running job.

### packages/env/src/watch.ts
- Purpose: the client side of a remote file watcher, with reconnection.
- Key abstractions: `RemoteWatcher`, `RemoteWatchOptions`.
- Data flow: a `watch` request → a `ready` event → `change` events → on connection loss, an exponential-backoff
  reconnect and an `overflow` report.
- Non-obvious design decisions: (1) The watcher **reconnects** when the connection is lost: it retries with a
  1 s→30 s backoff and, on success, reports `{ overflow: true }` because "Changes while disconnected were not seen"
  (lines 133-157). (2) A throwing `onChange` callback must not stop the watcher (lines 70-77). (3) The daemon's mode
  (`native` or `polling`) is surfaced on the watcher, and a `polling` mode change is reported.
- Edge cases / failure handling: an error event from the daemon ends the watcher; an abort during the open closes the
  watcher it just created.
- Surprising: the watcher is the one place in the package where a *loss* is explicitly reported as data loss
  (`overflow`) rather than as an error.

### packages/env/test/conformance.test.ts
- Purpose: runs Durable's shared `registerEnvConformance` suite against both `RemoteExecutionEnv` and
  `LocalExecutionEnv`.
- Key abstractions: `registerEnvConformance({ describe, expect, it }, name, factory, options)`.
- Data flow: the suite creates an env in a temp dir and exercises it.
- Non-obvious design decisions: the same suite runs against the *remote* env and the *local* env, which is what
  proves the two are interchangeable. On Windows the suite is told to use Git Bash and that symlinks are unavailable
  ("Git Bash's `ln -s` copies instead of linking unless native symlinks are enabled"), and the temp dir is removed
  with `maxRetries: 50, retryDelay: 100` "because a killed command's processes can hold the directory for a moment".
- Edge cases / failure handling: the cleanup retry is itself a Windows accommodation.
- Surprising: the conformance suite lives in *another package* (`@earendil-works/pi-durable/testing`) and is
  parameterised by the test framework object — the suite is framework-agnostic.

### packages/env/test/daemon.ts
- Purpose: locate the daemon binary the tests run.
- Key abstractions: `daemon`.
- Data flow: `PI_ENV_DAEMON` (CI points it at a release build) else `daemon/target/debug/pi-env`.
- Non-obvious design decisions: the file *throws at import time* if the binary is missing, with the instruction
  "Build the daemon first: npm run build:daemon in packages/env" — the failure is a clear message, not a 126.
- Edge cases / failure handling: n/a.
- Surprising: the CI tests the *release* binaries, so the shipped artifacts are what is verified.

### packages/env/test/differential.test.ts
- Purpose: a **differential test** — the same random operation sequences are run against `NodeExecutionEnv` and
  `RemoteExecutionEnv` on the same machine, and the results must be identical.
- Key abstractions: `pair()` (a local and a remote env over the same daemon), `random(seed)` (mulberry32),
  `randomOperation(next)`, `normalize(value, root)`.
- Data flow: 60 seeds × 25 steps; for each step the operation runs locally and remotely and the two normalized results
  are compared.
- Non-obvious design decisions: (1) the **normalizer** erases the root path and keeps only the *error code* of
  failures, because "only the error code of failures" is the contract (lines 46-61). (2) the content corpus
  deliberately includes a BOM, an invalid UTF-8 sequence, a 70 000-byte string and 300 001 `é`s — "Crosses write
  chunks, read chunks and multi-byte characters split between them" (lines 64-72). (3) The tool-level test runs
  Durable's own `createReadTool` and `createBashTool` through both environments, and asserts that a bash case returns
  a *result* rather than throwing, "because a throw on both sides would compare equal" (lines 360-366).
- Edge cases / failure handling: platform-specific tests are skipped where they cannot run (FIFOs and devices on
  non-POSIX; non-UTF-8 file names on macOS, whose file systems refuse them).
- Surprising: this is the single strongest idea in the shard for August's harness — see the ideas section.

### packages/env/test/old-daemon.ts
- Purpose: a stand-in for a daemon released before `hello.features`, used to test the `not_supported` path.
- Key abstractions: a 48-line Node script that speaks the wire protocol by hand.
- Data flow: reads frames from stdin, answers `hello` without `features`, and refuses every other operation with
  `EINVAL`.
- Non-obvious design decisions: the fixture is written in **plain Node with no dependency on the package under test**,
  so it cannot accidentally agree with a bug in the client.
- Edge cases / failure handling: n/a.
- Surprising: it is a *versioned protocol* test — the client's capability check is what keeps an old daemon usable.

### packages/env/test/remote.test.ts
- Purpose: 176 lines covering the remote environment's specific behaviours: output windows, aborts, platform names,
  the old-daemon path, cancellation, timeouts, connection loss and chunked transfers.
- Key abstractions: `environment()` (a fresh temp dir + connection).
- Data flow: n/a.
- Non-obvious design decisions: the output-window test asserts the *exact* arithmetic: `delivered + skipped === total`,
  `delivered < total/10`, and that the tail after the last skip is a suffix of the full output (lines 28-57). The
  lost-connection test kills the daemon with `SIGKILL` and then asserts that a handle from the old daemon fails while a
  new handle works — proving the session binding.
- Edge cases / failure handling: 20 abort attempts in a row (half immediate, half delayed) must all settle as
  `aborted` within 10 s. A cancel that is sent *before* the request still reaches the daemon, because "The cancel
  follows the request at once, bypassing the client's own abort check, so the daemon stops the walk".
- Surprising: the 10 100-file listing test creates 100 × 100 files to check the `maxEntries` bound exactly.

### packages/env/test/ssh-external.test.ts
- Purpose: the conformance suite over a *real* SSH server, configured by CI through `PI_ENV_SSH_HOST` and friends.
- Key abstractions: `connect()` (memoised so one connection is used), `registerEnvConformance`.
- Data flow: scan host key → accept → detect platform → deploy → connect → `hello`.
- Non-obvious design decisions: every stage is logged with a timestamp, "so a hang in CI shows where it is" (line 41).
- Edge cases / failure handling: on Windows the test asserts the detected shell is the server's default
  (`PI_ENV_SSH_SHELL ?? "cmd"`).
- Surprising: the test is skipped entirely when `PI_ENV_SSH_HOST` is unset, so it is a CI-only gate.

### packages/env/test/ssh.test.ts
- Purpose: 299 lines driving a **disposable real `sshd`** on localhost: host-key trust, deployment, verification,
  replacement of a tampered daemon, listing over SSH, the login shell, lazy connection and the host-key change policy.
- Key abstractions: a `beforeAll` that generates host and client keys with `ssh-keygen` and starts `sshd -D`.
- Data flow: `connectSsh` → `scanHostKey` → `acceptHostKey` → deploy → `RemoteExecutionEnv` over SSH.
- Non-obvious design decisions: (1) the test asserts the **daemon's file name is its SHA-256** and that a daemon of
  other contents is removed. (2) it asserts a *tampered* daemon is replaced and that a tampered daemon is re-verified
  after a lost connection ("The next start redeploys the verified binary instead of running whatever is there").
  (3) `acceptHostKey` is asserted to reject a line for another alias and a `@cert-authority` marker line, and to
  reject a *second* key of the same type with `HostKeyChangedError`.
- Edge cases / failure handling: the whole suite is skipped when `sshd` is not on the machine.
- Surprising: the test file asserts `expect(readFileSync(deployed).equals(readFileSync(daemon))).toBe(true)` — the
  *bytes* on the remote are the bytes of the local build.

### packages/env/test/terminal.test.ts
- Purpose: 162 lines covering the remote terminal: input, resize, exit code, foreground job detection, raw bytes,
  ordering, kill-on-close and the error paths.
- Key abstractions: `collector()` (a byte sink with a `waitFor(text)` helper).
- Data flow: `openTerminal` → `terminal.write(...)` → `output.onData` → `terminal.exited`.
- Non-obvious design decisions: the "raw bytes, not decoded text" test asserts `[0x61, 0xff, 0x62]` — the `0xff` is
  invalid UTF-8 and must survive. The foreground test polls up to 100 times at 20 ms because "The shell forks before it
  execs: wait until the foreground job is the command itself, not the forked shell" (line 90). The ordering test
  writes 4 000 numbered lines and compares the file to the exact concatenation.
- Edge cases / failure handling: `close()` must kill the program and the `exited` promise must reject with
  `code: "aborted"`; `foreground()` after the end must reject with `EBADF`; a missing directory must reject the open.
- Surprising: the whole suite is skipped on Windows (`describe.skipIf(process.platform === "win32")`).

### packages/env/tsconfig.build.json
- Purpose: the build config, with `paths` mapping the workspace packages to their built `dist` types.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: `@earendil-works/chord`, `@earendil-works/chord/context` and
  `@earendil-works/pi-durable/env` are mapped to `../<pkg>/dist/index.d.ts` — the env package compiles against the
  *published* shape of its siblings, not their sources.
- Edge cases / failure handling: n/a.
- Surprising: nothing.

### packages/env/vitest.config.ts
- Purpose: 11 lines of Vitest config.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: the `source` resolve condition again, so the tests run the `.ts` sources.
- Edge cases / failure handling: n/a.
- Surprising: unlike codemode and mcp, this config does **not** set `globals: true` — the tests import `describe`/
  `expect` explicitly.

---

### packages/mcp/CHANGELOG.md
- Purpose: release history of `@earendil-works/pi-mcp` from 0.99.0 to 1.4.0.
- Key abstractions: n/a (prose).
- Data flow: n/a.
- Non-obvious design decisions: the 1.2.0 entry records the transport-level fix: "`McpTransport.send()` now takes an
  optional `signal`, which `McpClient` aborts once a request settles" — the mechanism that stops a cancelled request
  from being re-dispatched after an auth refresh.
- Edge cases / failure handling: `#10416` (structured content that is not an object), `#10565` (an aborted refresh
  must not fall back to a new authorization; `close()` must not call `AuthProvider.token()`), `#10266` (empty/null
  optional fields in OAuth responses), `#10172` (a configured authorization-server metadata document), `#10302`
  (a redirect URI on another path), `#10493` (`application_type` for loopback redirect URIs), `#10188` (Cloudflare's
  `Illegal invocation` on `fetch`).
- Surprising: the 1.0.1 entry records a *breaking* rename of `clientMetadataUrl` → `clientMetadataDocument(metadata)`
  with the reason "the document is no longer stored as client information".

### packages/mcp/LICENSES/modelcontextprotocol-typescript-sdk.txt
- Purpose: the MIT licence of the Anthropic MCP TypeScript SDK, included because three files in `src/oauth/` are
  adapted from it.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: the licence is shipped *in the published package* (`files` includes `LICENSES`) so
  the adaptation is legally covered for consumers.
- Edge cases / failure handling: n/a.
- Surprising: the package deliberately re-implements the SDK's OAuth subset rather than depending on it, and ships
  the licence to say so.

### packages/mcp/package.json
- Purpose: the package manifest for `@earendil-works/pi-mcp` v1.4.0.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: the only runtime dependency is `cross-spawn` — everything else is hand-written
  (JSON-RPC, SSE, OAuth). The package has three entries: `.`, `./oauth` and `./testing`.
- Edge cases / failure handling: n/a.
- Surprising: `cross-spawn` is needed for one thing: on Windows, `npx`/`uvx` are `.cmd` shims that need `cmd.exe`.

### packages/mcp/README.md
- Purpose: 136 lines: usage, the LLM-tool wrapper recipe, the OAuth recipe, the supported protocol surface, and the
  testing entry.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: the architectural rule is stated in one line — "**An MCP transport owns framing and
  I/O. It delivers individual JSON-RPC messages to `McpClient`; the client owns request correlation, initialization,
  timeouts, cancellation, server requests, and protocol-level helpers.**" (line 114). The tool-wrapping recipe encodes
  two provider limits: names are truncated to 64 characters of `[A-Za-z0-9_-]`, and the schema is forced to an object
  with a `properties` key, "because some reject one without `properties`".
- Edge cases / failure handling: "MCP reports tool failures in the result instead of as a protocol error" — so
  `isError: result.isError === true` is the failure signal, not a thrown error.
- Surprising: the README lists what is explicitly *out* of scope: "Batch JSON-RPC messages, legacy HTTP+SSE,
  servers, sampling, and tasks are outside the initial core."

### packages/mcp/src/auth-provider.ts
- Purpose: the token-provider contract for the HTTP transport.
- Key abstractions: `AuthProvider` (`token()`, optional `onUnauthorized(context)`), `UnauthorizedContext`, `McpFetch`.
- Data flow: the transport calls `token()` before each request; on a 401 it calls `onUnauthorized` and retries.
- Non-obvious design decisions: the doc for `token()` says "May refresh it over the network first, so the transport
  calls it only before requests whose answer it waits for. Closing a session reuses the token of the last request."
  — the *closing* carve-out is in the contract, not an implementation detail. `UnauthorizedContext.token` carries the
  *rejected* token, "A different current token means another request already refreshed it".
- Edge cases / failure handling: n/a.
- Surprising: the interface is deliberately tiny — three members — so an application can implement it in five lines.

### packages/mcp/src/client.ts
- Purpose: the transport-neutral MCP client — 621 lines owning the JSON-RPC lifecycle.
- Key abstractions: `McpClient`, `McpClientOptions`, `McpRequestOptions`, `PendingRequest`, `ClientState`
  (`idle | connecting | connected | closed`).
- Data flow: `connect(transport)` → `initialize` → validate → `notifications/initialized` → `connected`; then
  `request`/`notify`/`callTool`/`listTools`; incoming messages are dispatched to responses, server requests and
  notifications.
- Non-obvious design decisions: (1) **every result is validated before it is returned**: `validateInitializeResult`,
  `validateListPage` (which checks *every* item of a page), `validateReadResourceResult`, `validateCallToolResult`
  (lines 74-153). (2) `listAll` follows `nextCursor` through every page with a **duplicate-cursor guard** and a
  1 000-page ceiling (lines 356-376). (3) **Progress renews the request timeout** — `armTimeout` is called again on
  every `notifications/progress` (lines 536-547), so a long streaming tool does not time out. (4) `initialize` is
  **not cancellable** — "The spec forbids cancelling `initialize`" — so a timed-out initialize does not send
  `notifications/cancelled` (lines 424-432, and the test at client.test.ts:293-302). (5) Each request carries a
  `sendController` that is aborted when the request settles, so "the transport does not dispatch (or retry) it
  afterwards" (lines 67-68, 577-583). (6) A `null` or `""` cursor is treated as "no more pages" because "Some servers
  end pagination with `null` or `""` instead of omitting the cursor" (line 106). (7) A resource with no `name` falls
  back to its URI.
- Edge cases / failure handling: transport errors are *reported* (`onError`) but do not fail pending requests — those
  fail when the transport closes. A response for an unknown request id is an error event, not a crash. `markClosed` is
  idempotent and aborts the server requests the client is serving. `close()` rejects in-flight requests with
  `McpConnectionClosedError` before closing the transport.
- Surprising: `requestInternal` supports an `allowConnecting` flag used only by `initialize`, so the client cannot send
  anything before the handshake.

### packages/mcp/src/index.ts
- Purpose: the package's public surface — 72 lines of re-exports from `auth-provider`, `client`, `protocol/*` and
  `transports/*`.
- Key abstractions: n/a (barrel).
- Data flow: n/a.
- Non-obvious design decisions: `InMemoryTransport` is deliberately **not** exported from the root — it lives in the
  `./testing` entry, so a production bundle cannot accidentally depend on it.
- Edge cases / failure handling: n/a.
- Surprising: nothing.

### packages/mcp/src/oauth/callback.ts
- Purpose: a loopback HTTP server that receives the OAuth redirect.
- Key abstractions: `OAuthCallbackServer`, `OAuthCallback`, `OAuthCallbackPage`, `OAuthCallbackServerOptions`.
- Data flow: `listen()` → a `http.Server` on `127.0.0.1:0` → `waitForCallback(state)` → the browser hits
  `/callback?code=…&state=…` → the pending promise resolves with `{ code, state, iss? }`.
- Non-obvious design decisions: (1) `waitForCallback(state, path?)` can pin the **path**: "With `path`, a response on
  another path fails, so a server-specific redirect URI can tell authorization servers apart (RFC 9700 section
  4.4.2.2)" (lines 89-102). (2) The `iss` parameter (RFC 9207) is captured and returned, because the flow needs it to
  verify the issuer. (3) The reply is a plain-text (or custom-rendered) page with `cache-control: no-store`, so the
  user's browser shows "You may close this window."
- Edge cases / failure handling: an unknown path is 404; an unknown or expired state is 400; an `error=` parameter
  rejects the promise with the server's description; a missing `code` is an error. A 5-minute default timeout.
- Surprising: `extraPaths` allows several registered redirect URIs to be served by one server, and the *state* is the
  matching key.

### packages/mcp/src/oauth/discovery.ts
- Purpose: OAuth metadata discovery — the protected-resource document, the authorization-server document, and the
  `WWW-Authenticate` challenge parser.
- Key abstractions: `parseWwwAuthenticate`, `discoverProtectedResourceMetadata`,
  `buildAuthorizationServerDiscoveryUrls`, `discoverAuthorizationServerMetadata`, `discoverOAuthServerInfo`,
  `selectResource`, `resourceUrlFromServerUrl`.
- Data flow: server URL → `/.well-known/oauth-protected-resource/<path>` → `authorization_servers[0]` →
  `/.well-known/oauth-authorization-server/<path>` (then the OpenID variants) → the metadata.
- Non-obvious design decisions: (1) **the issuer is validated against the discovered URL** unless explicitly skipped:
  "URL parsing adds a trailing slash to bare origins, so compare without one on either side" (lines 137-142). (2) A
  4xx or 502 is a *miss* and the next candidate URL is tried; other statuses are errors (lines 23-26, 131-135).
  (3) `selectResource` refuses a protected resource whose origin differs from the MCP server's, or whose path does not
  contain the server's path (lines 202-215). (4) An empty challenge value counts as absent: "An empty value
  (`scope=""`) carries no information, so it counts as absent" (lines 33-37).
- Edge cases / failure handling: invalid protected-resource metadata is *swallowed* by `discoverOAuthServerInfo` so
  discovery can fall back to the server's origin — "Invalid resource metadata falls back to the server origin instead
  of failing discovery" (oauth.test.ts:286). A `TypeError` (network failure) is re-thrown.
- Surprising: the discovery URLs include the OIDC variants *and* a path-suffixed OIDC URL — three candidates, tried in
  order.

### packages/mcp/src/oauth/errors.ts
- Purpose: the five OAuth error types.
- Key abstractions: `OAuthError` (code + errorUri), `OAuthIssuerMismatchError` (expected/received), 
  `OAuthInsecureEndpointError`, `OAuthRegistrationError`, `McpOAuthAuthorizationRequiredError`.
- Data flow: n/a.
- Non-obvious design decisions: `OAuthIssuerMismatchError` distinguishes "expected: none" (no metadata was discovered)
  from "received: none" (the server omitted `iss`) — because those are different failures.
- Edge cases / failure handling: `OAuthError`'s message falls back to the code when the message is empty.
- Surprising: `McpOAuthAuthorizationRequiredError` is the *only* signal that the user must interact; the transport turns
  a `REDIRECT` outcome into this error.

### packages/mcp/src/oauth/flow.ts
- Purpose: the OAuth flow — discovery, client registration, PKCE authorization, code exchange, refresh, step-up — plus
  the `AuthProvider` adapter.
- Key abstractions: `OAuthClientProvider` (the application's storage/UI seam), `OAuthFlowOptions`, `OAuthFlowResult`
  (`AUTHORIZED | REDIRECT`), `OAuthClientMetadataDocument`, `stepUpScope`, `adaptOAuthProvider`.
- Data flow: `authorizeMcp(provider, options)` → discover → register (or use a metadata document) → refresh if a
  refresh token exists → otherwise `startAuthorization` and `redirectToAuthorization`; with an `authorizationCode`,
  exchange it after the issuer check.
- Non-obvious design decisions: (1) **the RFC 9207 issuer check fails closed**: "Without metadata there is no issuer
  to compare with, so any `iss` is rejected" — and if the server *promised* the parameter, a missing `iss` is also a
  mismatch (lines 383-389). (2) `stepUpScope` unions the challenged scopes with the scopes granted so far, "since a
  challenge may list only the missing scopes and a token with just those would lose access the old one had
  (SEP-2350)" (lines 309-318). (3) **`adaptOAuthProvider` shares one refresh between concurrent 401s** and, crucially,
  detects the case where another request already refreshed: "a request whose token was already replaced is just
  retried: with rotating refresh tokens, a second refresh with the old refresh token would fail and discard the new
  grant" (lines 446-451, 459-462). (4) The scope is chosen with `||`, not `??`: "an empty scope (for example from
  `scopes_supported: []`) falls through to the next source" (line 352). (5) The token endpoint must be HTTPS unless it
  is a loopback host (`secureEndpoint`). (6) `application_type` is derived from the redirect URIs for OpenID Connect
  servers (lines 109-120).
- Edge cases / failure handling: an OAuth error in the *body* is checked before the status, because "Servers may
  report OAuth errors with any status" (lines 234-241). A refresh failure falls through to a new authorization — except
  when the flow was aborted or the endpoint was insecure, which are re-thrown (lines 411-414). `authorizeMcp` catches
  `invalid_client`/`unauthorized_client` and invalidates *all* credentials and retries; `invalid_grant` invalidates the
  tokens and retries.
- Surprising: the `iss` check is applied to the code exchange but *not* to a refresh — a refresh is bound to the
  authorization server by the refresh token itself.

### packages/mcp/src/oauth/index.ts
- Purpose: the `./oauth` entry's re-exports.
- Key abstractions: n/a (barrel).
- Data flow: n/a.
- Non-obvious design decisions: the whole OAuth subset is a *separate entry point*, so a consumer that only wants the
  client never pulls the OAuth code.
- Edge cases / failure handling: n/a.
- Surprising: nothing.

### packages/mcp/src/oauth/provider.ts
- Purpose: the default stateful OAuth provider for one exact MCP server URL.
- Key abstractions: `McpOAuthProvider`, `McpOAuthState`, `McpOAuthStateStore`, `MemoryOAuthStateStore`.
- Data flow: the provider reads and writes a `McpOAuthState` record through an injected store.
- Non-obvious design decisions: (1) **credentials are bound to the exact server URL**: "Stored state for another server
  URL is ignored so credentials never leak across servers" (lines 164-167) — a shared store serving two servers
  cannot mix them up. (2) Writes are serialised through a promise chain (`this.writes = this.writes.then(...)`) so
  concurrent `saveTokens`/`saveCodeVerifier` cannot lose an update. (3) `tokensExpireAt` is recorded from `expires_in`
  at save time. (4) `invalidateCredentials(kind)` takes a *granularity* (`all | client | tokens | verifier |
  discovery`) so the flow can invalidate exactly what it must.
- Edge cases / failure handling: `codeVerifier()` throws "No OAuth PKCE code verifier is stored" if it is missing —
  the flow's way of saying the resume path was not taken.
- Surprising: `MemoryOAuthStateStore` uses `structuredClone` on both save and load, so a stored state can never be
  mutated by a caller.

### packages/mcp/src/oauth/types.ts
- Purpose: the OAuth data types and their **dependency-free structural validators**.
- Key abstractions: `parseProtectedResourceMetadata`, `parseAuthorizationServerMetadata`, `parseOAuthTokens`,
  `parseClientInformation`, plus `compact`, `absent`, `safeUrl`.
- Data flow: raw JSON → a validated, compacted object.
- Non-obvious design decisions: (1) `compact()` drops `undefined` values, "so optional fields are absent rather than
  present-but-undefined". (2) `absent()` treats `null` and `""` as absent, because "servers send them for fields they
  have no value for, like `scope: \"\"`" — this was bug `#10266`. (3) `safeUrl` rejects the `javascript:`, `data:` and
  `vbscript:` schemes, and uses `URL.canParse` because "URL parsing throws a `TypeError`, which discovery reserves for
  network failures" (lines 126-133). (4) `parseOAuthTokens` guards `expires_in` with `absent()` because
  "`Number(null)` is 0, which would mark the token as expired at once" (lines 185-187).
- Edge cases / failure handling: a missing `response_types_supported` is an error (it is required); a non-array
  `scopes_supported` is an error; an unknown `expires_in` is an error.
- Surprising: this file is the *whole* replacement for the SDK's Zod schemas, and the header says so.

### packages/mcp/src/protocol/content.ts
- Purpose: the MCP content types and `toLlmContent`, the conversion to the model-facing content shape.
- Key abstractions: `ContentBlock` (text/image/audio/resource_link/resource), `CallToolResult`, `LlmContent`.
- Data flow: a `CallToolResult` → `toLlmContent` → text and image blocks a model can consume.
- Non-obvious design decisions: audio, resource links and binary resources become **short text placeholders** rather
  than being dropped, so the model knows something was there (lines 85-102). An embedded image resource becomes an
  image block; an embedded text resource becomes text. A result with no content blocks but a `structuredContent`
  becomes the JSON of that content, "since servers should, but do not always, mirror structured results as text"
  (lines 105-117).
- Edge cases / failure handling: `structuredContent` may be *any* JSON value (array, `null`, a number) per MCP
  2026-07-28 — the type is `unknown`, not `Record<string, unknown>`.
- Surprising: the fallback to JSON is exactly the case where a strict schema-driven client would silently lose the
  tool's result.

### packages/mcp/src/protocol/jsonrpc.ts
- Purpose: the JSON-RPC 2.0 types, the error codes, the four error classes and the message guards.
- Key abstractions: `JsonRpcRequest/Notification/Response/Message`, `JSON_RPC_ERROR_CODES`, `McpError`,
  `McpConnectionClosedError`, `McpTimeoutError`, `McpAbortError`, `isJsonRpc*`, `parseJsonRpcMessage`.
- Data flow: n/a.
- Non-obvious design decisions: `McpAbortError`'s `name` is set to `"AbortError"` (not `"McpAbortError"`) so it
  matches the platform convention for aborts (line 78). `isJsonRpcResponse` requires *either* `result` or a
  well-formed `error` object, and rejects a message that has both. `parseJsonRpcMessage` throws
  `McpError(invalidRequest, …)` for anything unrecognised.
- Edge cases / failure handling: `isJsonRpcId` accepts a finite number or a string — `NaN` is not an id.
- Surprising: `McpError` carries the JSON-RPC `data` field, so a server's structured error survives to the caller.

### packages/mcp/src/protocol/types.ts
- Purpose: the MCP protocol types and the version negotiation constants.
- Key abstractions: `LATEST_PROTOCOL_VERSION = "2025-11-25"`, `SUPPORTED_PROTOCOL_VERSIONS` (four versions),
  `Tool`, `ToolAnnotations`, `ToolExecution`, `Resource`, `ResourceTemplate`, `InitializeResult`, `ProgressNotification`.
- Data flow: n/a.
- Non-obvious design decisions: the accepted versions list is ordered newest-first and includes three older ones
  because "Servers that do not support the requested version answer with their own latest one, so older versions stay
  accepted for servers built on older SDKs" (lines 5-9). `ToolAnnotations` carries the four behavioural hints
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) — the standard's own safety vocabulary.
- Edge cases / failure handling: n/a.
- Surprising: `ToolExecution.taskSupport` (`forbidden | optional | required`) is modelled, so a server can say a tool
  must not be run as a background task.

### packages/mcp/src/testing/index.ts
- Purpose: the `./testing` entry — one line re-exporting the in-memory transport.
- Key abstractions: `createInMemoryTransportPair`, `InMemoryTransport`.
- Data flow: n/a.
- Non-obvious design decisions: the testing helper is a separate entry point so it is not pulled into production
  bundles.
- Edge cases / failure handling: n/a.
- Surprising: nothing.

### packages/mcp/src/transports/in-memory.ts
- Purpose: an in-memory transport pair for tests.
- Key abstractions: `InMemoryTransport`, `createInMemoryTransportPair`.
- Data flow: `send` → `structuredClone(message)` → `queueMicrotask(() => peer.deliver(copy))`.
- Non-obvious design decisions: the message is **cloned and delivered in a microtask**, so the two peers behave like
  two processes and a test cannot accidentally observe a synchronous re-entry.
- Edge cases / failure handling: sending before `start()` or after `close()` throws `McpConnectionClosedError`;
  `emitError` is exposed publicly "so tests can simulate transport-level failures".
- Surprising: the clone is what makes the in-memory transport a faithful stand-in for a real IPC transport.

### packages/mcp/src/transports/stdio.ts
- Purpose: the stdio transport — spawn the server, speak newline-delimited JSON-RPC, shut it down per the spec.
- Key abstractions: `StdioTransport`, `StdioTransportOptions`, `liveProcessGroups`, `killProcessTree`.
- Data flow: `crossSpawn(command, args, { detached: true })` → stdout lines → `parseJsonRpcMessage` → `emitMessage`;
  `send` writes `JSON.stringify(message) + "\n"`.
- Non-obvious design decisions: (1) the child is spawned **detached** so it owns a process group and closing the
  transport can kill the server's children too (lines 99-102). (2) Shutdown follows the spec exactly: close stdin,
  wait 500 ms, then SIGTERM, then SIGKILL after `closeTimeoutMs` (lines 164-178). (3) A `process.on("exit")` hook
  kills every live process group, so a host that dies without closing does not leave servers behind (lines 43-53).
  (4) On Windows, `taskkill /F /T` is used, because "cross-spawn runs `.cmd` shims through cmd.exe; killing only that
  would leave the server running". (5) stderr is captured with a 64 KiB ring ("the last N bytes") and a close with a
  truncated message is reported as an error.
- Edge cases / failure handling: an over-long message is an error and the buffer is dropped; a server that closes with
  an incomplete JSON-RPC message produces "MCP stdio server closed with an incomplete JSON-RPC message"; a spawn
  error rejects `start()`.
- Surprising: `cross-spawn` is the only dependency, and it exists for the Windows `.cmd` shim problem.

### packages/mcp/src/transports/streamable-http.ts
- Purpose: the Streamable HTTP transport — POST with JSON or SSE replies, a server-to-client GET stream, session
  headers, resumption with `Last-Event-ID`, and OAuth-aware retry.
- Key abstractions: `StreamableHttpTransport`, `consumeSseStream`, `SseEvent`, `McpHttpError`,
  `McpAuthRequiredError`, `McpSessionExpiredError`, `StreamCursor`, `needsAuthorization`, `isTransientStatus`.
- Data flow: `send(message)` → `authorizedFetch("POST", …)` → a JSON body (one or many messages) or an SSE stream;
  the GET stream is opened after `notifications/initialized`.
- Non-obvious design decisions: (1) **the SSE parser bounds an unterminated event**: "Bytes of the pending event's
  data, including the "\n" joins, so events streamed as many short `data:` lines without a terminating blank line
  cannot grow without bound" (lines 48-51, 79-81). (2) `fetch` is called **without a receiver** — "Call fetch without
  a receiver. `this.fetch(...)` and `context.fetch(...)` would pass the transport or the auth context as `this`, which
  Cloudflare Workers reject for the platform fetch ('Illegal invocation')" (lines 211-215). (3) `authorizedFetch`
  hands a 401 (or a 403 with an `insufficient_scope` challenge) to the auth provider **once** and retries; the
  `signal` is checked *after* obtaining the token, so "a request its sender gave up on in the meantime must not reach
  the server" (lines 287-317). (4) `close()` sends the session DELETE with the **last request's token** and a 1 s
  timeout, and never asks the auth provider (which may refresh over the network) — lines 268-285. (5) The response
  stream is **resumed** with `Last-Event-ID` when the server assigns event ids and the stream ends before the reply;
  the attempt counter resets when the stream had already delivered something (lines 382-420). (6) The GET stream
  reconnects with exponential backoff, and a stream that stayed up for a while counts as healthy even if idle.
- Edge cases / failure handling: a 202/204 for a request is an error ("accepted request without a response"); a 404
  *with* an established session is `McpSessionExpiredError`; an unsupported content type is an error; a 405 on the
  GET means the server has no GET stream and the transport stops trying; the retry predicate is
  "network failures and transient statuses are retried; auth, session, and protocol errors are not" (lines 478-487).
- Surprising: the transport reports a failed response stream by **emitting a JSON-RPC error message** rather than
  throwing, so the client's pending request is rejected through the normal path (lines 413-419).

### packages/mcp/src/transports/transport.ts
- Purpose: the transport interface and the shared listener bookkeeping.
- Key abstractions: `McpTransport`, `McpTransportSendOptions`, `TransportEvents`, `DEFAULT_MAX_MESSAGE_BYTES = 16 MiB`.
- Data flow: n/a.
- Non-obvious design decisions: the `signal` on `send()` is documented precisely: "Aborted once the sender no longer
  waits for a reply (the request was cancelled, timed out, answered, or the client closed). A transport must not
  dispatch the message after that, for example when retrying it after an authorization refresh. It does not undo a
  message already dispatched." (lines 9-16) `emitClose` fires at most once per transport.
- Edge cases / failure handling: `setProtocolVersion?` is optional — only the HTTP transport needs it.
- Surprising: this 64-line file is the whole contract between the client and any transport, and it is the reason the
  client could be tested against an in-memory transport.

### packages/mcp/test/client.test.ts
- Purpose: 339 lines of client behaviour over the in-memory transport, with a hand-written test server.
- Key abstractions: `createServer()` (a `TestServer` with `setHandler`), `connect()`.
- Data flow: the test server answers `initialize`, `tools/list`, `resources/list`, `tools/call` and `roots/list`.
- Non-obvious design decisions: the test asserts the *exact* handshake — the two messages `initialize` and
  `notifications/initialized`, in that order, with the exact params (lines 78-90). The timeout/progress test uses
  fake timers and advances them by hand.
- Edge cases / failure handling: covers pagination with an empty `nextCursor`, a resource with no name, a malformed
  result, a structured content that is not an object, a timed-out `initialize` (which must *not* send
  `notifications/cancelled`), a transport error that must not fail a pending request, an old protocol version that is
  accepted, an unsupported one that is rejected, and `onClose` firing exactly once.
- Surprising: the transport-error test asserts the *pending request still succeeds* while the error is reported
  separately — the two channels are deliberately independent.

### packages/mcp/test/content.test.ts
- Purpose: 39 lines pinning `toLlmContent`.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: the expected output lists every block type including the two placeholders
  ("[audio audio/wav omitted]", "[binary resource file:///d.bin (unknown type) omitted]").
- Edge cases / failure handling: `structuredContent` of `[1,2]`, `null` and `{n:1}` all become JSON text.
- Surprising: the structured fallback only applies when there are **no** content blocks.

### packages/mcp/test/fixtures/stdio-server.mjs
- Purpose: a 27-line newline-delimited MCP server fixture.
- Key abstractions: n/a.
- Data flow: reads lines from stdin, answers `initialize` / `tools/list` / `tools/call` / `ping`.
- Non-obvious design decisions: it answers with the *older* protocol version `2025-06-18`, so the client's
  version-acceptance path is exercised by the stdio fixture too.
- Edge cases / failure handling: an unknown method returns a JSON-RPC error.
- Surprising: it prints "stdio fixture ready" to stderr, which the transport captures.

### packages/mcp/test/fixtures/stubborn-server.mjs
- Purpose: a fixture that answers `initialize`, spawns a grandchild, and ignores stdin EOF *and* SIGTERM.
- Key abstractions: n/a.
- Data flow: prints its grandchild's pid on stderr so the test can find it.
- Non-obvious design decisions: the grandchild also ignores SIGTERM, so the test can prove the *whole process group*
  is killed.
- Edge cases / failure handling: n/a.
- Surprising: it exists to make the shutdown contract testable, and it is skipped on Windows.

### packages/mcp/test/helpers.ts
- Purpose: 40 lines of HTTP test-server helpers.
- Key abstractions: `listen(handler)`, `closeServers()`, `readBody(request)`.
- Data flow: n/a.
- Non-obvious design decisions: `closeAllConnections()` is called before `close()`, because a keep-alive SSE connection
  would otherwise keep the server open.
- Edge cases / failure handling: a handler that throws produces a 500 with the error text.
- Surprising: nothing.

### packages/mcp/test/oauth.test.ts
- Purpose: 639 lines covering the whole OAuth surface against a loopback HTTP server.
- Key abstractions: `TestOAuthProvider` (an in-memory `OAuthClientProvider`), a `listen()` server that implements
  discovery, registration, authorize and token endpoints.
- Data flow: `authorizeMcp` → discovery → registration → authorize (302 to the callback) → the callback server →
  code exchange → refresh on 401.
- Non-obvious design decisions: (1) the token endpoint **verifies the PKCE challenge** by hashing the verifier, so
  the test proves the S256 flow end to end. (2) the "shares one refresh between concurrent 401s" test uses a rotating
  refresh token (`r1`→`r2`) and asserts the second refresh is refused — so a duplicate refresh would fail the test.
  (3) the "binds persisted credentials to the exact MCP server URL" test uses *one store* and two providers for two
  different URLs, and the second must see no tokens. (4) the `iss` test matrix covers four cases, including "Without
  metadata there is no issuer to compare with, so a server cannot skip the check by hiding it."
- Edge cases / failure handling: an empty `scope` in the challenge falls through to the resource metadata's
  `scopes_supported`; `expires_in: null` must not mark the token expired; an aborted flow must not fall back to a
  redirect.
- Surprising: the callback-server tests assert the *browser-visible* behaviour: the content type, the exact text, and
  the 400 for a response on the wrong path.

### packages/mcp/test/stdio.test.ts
- Purpose: 64 lines proving the stdio transport works and that a stubborn server's *grandchild* is killed.
- Key abstractions: the two fixtures.
- Data flow: `new StdioTransport({ command: process.execPath, args: [fixture] })` → the client connects.
- Non-obvious design decisions: the grandchild's pid is scraped from the transport's captured stderr with a regex and
  a 100 × 10 ms poll.
- Edge cases / failure handling: the test asserts `close()` completes in under 5 s and that the grandchild is *dead*
  (`process.kill(pid, 0)` throws) within 2 s.
- Surprising: the whole second test is skipped on Windows.

### packages/mcp/test/streamable-http.test.ts
- Purpose: 486 lines over a loopback HTTP server: JSON and SSE replies, session headers, auth classification, stream
  resumption, GET-stream reconnection, and the cancelled-during-refresh case.
- Key abstractions: `startServer(handler)`, `protocolHandler`.
- Data flow: the fixture answers `initialize` with a session id, `tools/list` as JSON, and `tools/call` as SSE.
- Non-obvious design decisions: (1) the "does not retry requests that were cancelled while authorization was
  recovering" test is the sharpest one: three requests share one refresh, two of them are cancelled/timed out while
  waiting, and the test asserts `executed === ["kept"]` and `refreshes === 1` — i.e. the two abandoned requests never
  reached the server. (2) the "closes the session with the last request's token" test asserts the auth provider is
  *not* called during `close()`. (3) the "calls fetch without a receiver" test installs a strict `fetch` that throws
  `Illegal invocation` when `this` is not `globalThis`.
- Edge cases / failure handling: a broken SSE stream fails only that request; a stream that ends without an answer
  fails with "stream ended without a response"; a 202 for a request is an error; the error body is included in the
  message; an expired session is classified separately.
- Surprising: the SSE-oversize test asserts `sent < 100` chunks, proving the limit trips long before the buffer grows.

### packages/mcp/tsconfig.build.json
- Purpose: the build config.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: nothing beyond `outDir`/`rootDir`.
- Edge cases / failure handling: n/a.
- Surprising: nothing.

### packages/mcp/vitest.config.ts
- Purpose: 11 lines of Vitest config.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: `globals: true` and the `source` resolve condition, matching codemode's config.
- Edge cases / failure handling: n/a.
- Surprising: nothing.

---

### packages/telemetry/CHANGELOG.md
- Purpose: release history of `@earendil-works/pi-telemetry`, from 0.84.0 (2026-08-06) to 1.4.0.
- Key abstractions: n/a (prose).
- Data flow: n/a.
- Non-obvious design decisions: the 1.4.0 entry records the whole 1.4 contract in three "breaking changes":
  adapters trust typed inputs; adapters must implement `addLink()`; adapters with optional capabilities must carry
  them through `TelemetryContext.metrics` and `TelemetryContext.propagation` on roots, spans *and* extracted parents.
- Edge cases / failure handling: "Carrier extraction checks required string identities, without validating their
  format" — an explicit *relaxation* recorded as a breaking change, because the format is the adapter's own.
- Surprising: the changelog's 0.84.x entries are numerous and mostly empty — the package was released often.

### packages/telemetry/package.json
- Purpose: the package manifest for `@earendil-works/pi-telemetry` v1.4.0.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: the root entry has **no `source` condition** (unlike the other packages) — the
  telemetry package is published from `dist` only; `./render` and `./testing` are separate entries so the renderer and
  the Node-assertion-based testing suite stay out of the root graph.
- Edge cases / failure handling: n/a.
- Surprising: `sideEffects` is not set to `false` here, unlike the other packages.

### packages/telemetry/README.md
- Purpose: 610 lines — the normative description of the telemetry contract, the adapter rules, propagation, metrics,
  the no-op context, the in-memory adapter, the store interface, the conformance suite, the typed schemas and the
  security guidance.
- Key abstractions: `TelemetryContext`, `TelemetrySpan`, `TelemetryCarrier`, `TelemetryPropagation`,
  `TelemetryMetrics`, `TelemetryStore`, `StoredSpan`/`StoredTrace`/`StoredMetric`, `TraceQuery`/`MetricQuery`.
- Data flow: n/a (spec).
- Non-obvious design decisions: (1) **there is no public `end()` method**: "`startSpan()` owns settlement and keeps
  the span open until the callback's value or promise settles" (line 108) — the callback *is* the scope. (2) The
  adapter contract is written as a bulleted list of observable behaviours (lines 127-137) and is then *checked* by the
  conformance suite. (3) "The package does not use `AsyncLocalStorage` or another runtime-specific ambient context
  API" (line 519) — the parent is always an explicit argument. (4) "Trace metadata is diagnostics, never
  authorization" (line 167). (5) Only low-cardinality attributes are sanctioned. (6) The root entry deliberately has no
  exporter, no global current-span state and no backend dependency.
- Edge cases / failure handling: "ignore calls made after settlement"; "make repeated `setStatus()` calls
  last-write-wins"; "merge `setAttributes()` calls, with later defined values replacing earlier values and `undefined`
  ignored". The security section: "Do not persist a `TelemetryContext`, `TelemetrySpan`, or backend-native trace
  object in records, messages, snapshots, or deferred handles."
- Surprising: the "Pi Package Integration" section documents the *split of ownership* between packages — telemetry owns
  the contract, `pi-ai` and `pi-durable` own their own schemas — so no package has to depend on a backend.

### packages/telemetry/src/index.ts
- Purpose: the vendor-neutral contract and the type-level schema machinery — 465 lines, over half of them types.
- Key abstractions: `TelemetryContext`, `TelemetrySpan`, `SpanOptions`, `SpanLink`, `SpanStatus`, `TelemetryCarrier`,
  `TelemetryPropagation`, `TelemetryStore`, `StoredSpan`/`StoredTrace`/`StoredMetric`, `TraceQuery`/`MetricQuery`,
  `defineTelemetrySchema`, `createTypedSpanStarter`, and the inference types.
- Data flow: a schema object → `createTypedSpanStarter(context, schemas)` → a typed `startSpan(name, attributes,
  callback)` → the underlying `context.startSpan`.
- Non-obvious design decisions: (1) the schema is *data*, not a validator: "`defineTelemetrySchema()` is a typed
  identity function. It returns ordinary JSON-serializable data and performs no runtime validation or parent-rule
  enforcement." (2) the type machinery is genuinely strict: `ExactTelemetryAttributes` rejects *any* key outside the
  expected set, `AttributeDefinitionValue` narrows a closed `values` set to a literal union, and
  `EventArguments` makes the attributes argument **required** when the event has a required attribute and optional
  otherwise. (3) `UniqueTelemetrySchemas` makes duplicate span names across schemas a **compile-time** error. (4) The
  child starter is bound to the parent span: the callback receives `(span, startChildSpan)` and the child starter is
  the same vocabulary bound to that span.
- Edge cases / failure handling: a union-valued span name must be narrowed before the call, "preserving the
  relationship between each runtime name and its attribute schema" — the type system refuses to correlate a name
  with the wrong attribute set.
- Surprising: the type-level strictness is the package's main product. The runtime is a thin adapter; the *schema
  types* are what make a typo in a span name a build error.

### packages/telemetry/src/memory.ts
- Purpose: the in-memory reference adapter — 463 lines implementing `TelemetryContext`, `TelemetryPropagation`,
  `TelemetryMetrics` and `TelemetryStore` at once.
- Key abstractions: `InMemoryTelemetryContext`, `RecordedTelemetrySpan`/`Event`/`Link`/`Measurement`,
  `MutableRecordedTelemetrySpan`, `InMemoryParent`, `contextCarriers` (a `WeakMap` from context to carrier).
- Data flow: `startSpan` → `createSpan` (allocating an id, a carrier and a trace id) → the callback → settlement;
  `inject`/`extract` move a carrier across a JSON boundary; `findTraces`/`getTrace`/`findMetrics` answer queries.
- Non-obvious design decisions: (1) **the carrier's identity survives settlement without exposing backend ids on the
  generic context contract**: "Identity survives settlement without exposing backend IDs on the generic context
  contract" (line 97) — a `WeakMap<TelemetryContext, TelemetryCarrier>` holds the mapping. (2) The carrier is
  `{ scope, span, trace }` where the scope is a per-recorder UUID, the span is a deterministic counter, and the trace
  id is inherited from the parent — so a trace id is `<recorder UUID>:<counter>` and a *remote* parent is recognised
  by a different scope. (3) A **settled** parent makes a child span *inert* — `startInertSpan` records nothing but
  still runs the callback and still carries the metrics and propagation capabilities (lines 164-180, 188). (4) An
  explicit `setStatus` wins over the automatic error status: the catch block only sets the error status "if
  `!recordedSpan.explicitStatus`" (lines 234-240). (5) `endedMs` is computed from a *monotonic* clock
  (`performance.now()`) added to the wall-clock start, so a wall-clock adjustment mid-span cannot produce a negative
  duration. (6) `endSequence` is a deterministic global counter, so "settled order" is observable without timestamps.
  (7) `findTraces` groups spans by trace id and filters on the **earliest stored span**'s name and start, but
  "All equalities must match one span; that span may be anywhere in the trace" — the attribute filter is an AND over
  one span, not over the trace.
- Edge cases / failure handling: an unknown or malformed carrier falls back to the recorder's root (lines 307-323);
  a recognised carrier with *external* identifiers is treated as an opaque remote parent with `localId: null`.
  `findTraces` paginates with a `[startedMs, traceId]` cursor so equal starts page without duplicates.
- Surprising: `getMetrics()` and `getSpans()` return *detached* snapshots — the arrays are copied, the attributes are
  copied, the carriers are copied — so a caller cannot mutate the recorder's state through a returned snapshot.

### packages/telemetry/src/metrics.ts
- Purpose: the metric instrument contract and the typed metric schemas.
- Key abstractions: `TelemetryCounter`, `TelemetryUpDownCounter`, `TelemetryHistogram`, `TelemetryMetrics`,
  `InstrumentOptions`, `HistogramOptions`, `TelemetryMetricDefinition`, `createTypedMetrics`.
- Data flow: n/a (types plus a binder).
- Non-obvious design decisions: (1) the *runtime* difference between the typed span starter and the typed metrics
  helper: "Unlike the typed span starter, the metric helper reads and retains schema instrument metadata at runtime.
  It performs no runtime attribute validation." (README line 236) — the span starter is pure types, the metric binder
  needs the metadata to pass `description`/`unit`/`boundaries` to the adapter. (2) Metric attributes **reject
  `cardinality: "high"`** at the type level — the low-cardinality policy is enforced by the compiler, not by a
  review. (3) `MeasurementArguments` makes the attributes argument optional only when the schema has no required
  attribute.
- Edge cases / failure handling: `TelemetryMetricDefinition` is a union: `{ kind: "counter" | "upDownCounter";
  boundaries?: never } | { kind: "histogram"; boundaries?: readonly number[] }` — only histograms may declare buckets.
- Surprising: the same schema machinery serves spans and metrics, but the metric binder is the only part that touches
  the runtime.

### packages/telemetry/src/noop.ts
- Purpose: the shared no-op telemetry context, metrics and propagation.
- Key abstractions: `NOOP_TELEMETRY_CONTEXT`, `NOOP_TELEMETRY_METRICS`, `NOOP_TELEMETRY_PROPAGATION`.
- Data flow: `startSpan` → the callback is invoked *synchronously* with the one shared inert span.
- Non-obvious design decisions: (1) the no-op context is typed as `TelemetrySpan` (not `TelemetryContext`), "matching the
  shared inert span it provides" (CHANGELOG 1.4.0). (2) the callback is invoked **synchronously** and its return value
  is preserved; a synchronous throw becomes a rejected promise with the *same* value (lines 4-6). (3) the shared
  instruments are frozen and are the *same object* for every name, so `counter("bytes") === counter("other")` — a
  test asserts this. (4) `NOOP_TELEMETRY_PROPAGATION.inject` returns `undefined` and `extract` returns the no-op
  context.
- Edge cases / failure handling: the no-op "does not inspect or retain names, attributes, events, or statuses" — the
  test passes a `setStatus({ status: "error" })` and asserts the result is still 42.
- Surprising: a nested span returns *the same* span object — the test asserts `child === span`.

### packages/telemetry/src/render.ts
- Purpose: render stored spans as a plain-text chronological forest.
- Key abstractions: `renderTrace(spans)`, `formatAttributes`.
- Data flow: `StoredSpan[]` → a parent/child map → a stack-based walk → lines.
- Non-obvious design decisions: (1) **the walk is iterative, not recursive** — a 2 000-deep tree renders without a stack
  overflow (the test at render.test.ts:135-142 builds 2 000 nested spans). (2) a span whose parent is absent is a
  *root*, so a partial trace still renders. (3) spans are **deduplicated by id**, so traces merged from several stores
  render once. (4) links are printed but **never followed** — "It never follows links or queries a store" — so a
  cross-trace cycle cannot loop. (5) the input is not mutated.
- Edge cases / failure handling: an empty input renders as an empty string; equal start times keep the input order.
- Surprising: the attribute format is `key=JSON.stringify(value)`, so a string containing a newline is escaped rather
  than breaking the line format.

### packages/telemetry/src/testing/conformance.ts
- Purpose: a runner-independent conformance suite any telemetry adapter can be checked against — 386 lines of cases.
- Key abstractions: `createTelemetryAdapterConformance(factory)`, `TelemetryAdapterFixture`,
  `TelemetryAdapterConformanceCase`, `createCase`, `findSpan`, `rejectsWithSameValue`.
- Data flow: the factory produces a fresh fixture per case; each case exercises the adapter and reads back normalized
  snapshots.
- Non-obvious design decisions: (1) the suite is **runner-independent** — it returns `{ group, name, run() }` cases
  and the consumer registers them with vitest, jest or anything else. (2) each case gets a *fresh* fixture via
  `await using fixture = await factory()` — the `AsyncDisposable` protocol gives per-case isolation. (3) the cases
  check the *observable* semantics only: capability identity on roots/spans/extracted parents/inert spans, synchronous
  single admission, result and rejection identity, explicit vs automatic status, attribute merging, event ordering,
  inert post-settlement calls, nested and concurrent parentage, links, and (optionally) metrics and propagation.
  (4) the "makes calls after settlement inert" case asserts that a child started from a settled span still *runs* the
  callback and returns its value, but records nothing.
- Edge cases / failure handling: the rejection-identity case checks a synchronous throw, an async rejection, and
  `Promise.reject(undefined)` — all three must reject with the *same value*.
- Surprising: this is the pattern August could reuse for any pluggable subsystem — a conformance suite expressed as
  data, not as a test file.

### packages/telemetry/src/testing/types.ts
- Purpose: the three types the conformance suite is written against.
- Key abstractions: `TelemetryAdapterFixture` (an `AsyncDisposable` with `context`, optional `propagation`/`metrics`,
  `getMetrics?`, `getSpans()`), `TelemetryAdapterFixtureFactory`, `TelemetryAdapterConformanceCase`.
- Data flow: n/a.
- Non-obvious design decisions: the fixture's `getSpans()` returns the *normalized* snapshot shape, so the suite does
  not care how the adapter stores anything. `getMetrics` is optional — a tracing-only adapter is still valid.
- Edge cases / failure handling: n/a.
- Surprising: 21 lines carry the whole extension point.

### packages/telemetry/src/testing/index.ts
- Purpose: the `./testing` entry's re-exports.
- Key abstractions: n/a (barrel).
- Data flow: n/a.
- Non-obvious design decisions: the testing entry is separate from the root, and the README notes "The testing
  subpath uses Node's assertion APIs; the root telemetry package remains runtime-neutral" (line 341).
- Edge cases / failure handling: n/a.
- Surprising: nothing.

### packages/telemetry/test/conformance.test.ts
- Purpose: registers the conformance suite against `InMemoryTelemetryContext` and adds one extra test about detached
  snapshots.
- Key abstractions: the `conformance` array, grouped by `group`.
- Data flow: n/a.
- Non-obvious design decisions: the suite is registered by iterating `new Set(conformance.map((c) => c.group))` and
  then filtering by group — the grouping is data, not file structure.
- Edge cases / failure handling: the extra test asserts that an *open* span reports `settled: false` and no
  `endSequence`, and that mutating a returned snapshot does not change the recorder.
- Surprising: the in-memory adapter is held to the same contract as a hypothetical OpenTelemetry adapter.

### packages/telemetry/test/metrics.test.ts
- Purpose: 165 lines pinning the typed metric binding and the no-op instruments.
- Key abstractions: `traffic` and `latency` schemas, `createTypedMetrics`.
- Data flow: `metrics.counter("network.bytes").add(128, { direction: "out" })` → the adapter's measurements.
- Non-obvious design decisions: the `@ts-expect-error` block is the real assertion — it pins that a counter name
  cannot be used as a histogram, that an unknown name is rejected, that a required attribute cannot be omitted, that a
  closed-set value is exact, that a *variable* containing an unknown attribute is rejected, that an empty attribute
  schema rejects everything, that duplicate metric names are rejected, and that `cardinality: "high"` is not allowed
  on a metric.
- Edge cases / failure handling: the "requires histogram attributes" test pins that the optional exemplar context does
  not replace required attributes.
- Surprising: the "shares frozen no-op instruments" test asserts `counter("bytes") === counter("other")` — the no-op
  adapter returns one shared instrument per kind.

### packages/telemetry/test/propagation-worker.ts
- Purpose: a 6-line child process that extracts a carrier and starts a span, then prints its recorded spans.
- Key abstractions: `InMemoryTelemetryContext`.
- Data flow: `JSON.parse(process.argv[2])` → `telemetry.extract(carrier).startSpan(...)` → `JSON.stringify(getSpans())`
  on stdout.
- Non-obvious design decisions: it exists to prove that a parent can be continued **in another process with no shared
  registry** — the carrier is the only thing that crosses.
- Edge cases / failure handling: n/a.
- Surprising: the whole cross-process mechanism is six lines.

### packages/telemetry/test/propagation.test.ts
- Purpose: 139 lines pinning propagation, links and detachment.
- Key abstractions: `InMemoryTelemetryContext`, `execFileSync` for the cross-process case.
- Data flow: `inject(span)` → JSON → another process → `extract(carrier)`.
- Non-obvious design decisions: (1) the cross-process test asserts the child's `parentContext` equals the carrier and
  its `parentId` is `null` — "a remote parent has `parentId: null` but a non-null `parentContext`" — so the two
  notions are deliberately separate. (2) the "isolates crossed concurrent remote parents" test runs two concurrent
  flows and asserts each remote child points at *its own* caller, and that the shared root is linked from both.
  (3) the detachment test mutates the returned carrier, the link attributes and the span's own context and asserts
  the recorder is unaffected.
- Edge cases / failure handling: a carrier with a missing or non-string key falls back to the root; a carrier with
  *external* identifiers is treated as an opaque remote parent, and the test asserts the identifiers are not
  reformatted.
- Surprising: "recognized carrier identifiers are opaque strings" — the adapter does not impose an ID format on
  another adapter's carrier.

### packages/telemetry/test/render.test.ts
- Purpose: 147 lines pinning `renderTrace`'s exact output.
- Key abstractions: a `span(id, overrides)` factory.
- Data flow: `StoredSpan[]` → the rendered string.
- Non-obvious design decisions: the tests freeze the input array and `structuredClone` it to assert the renderer does
  not mutate its input. The 2 000-deep test exists to pin the iterative walk. The cross-trace-link test uses two spans
  that link to *each other* and asserts the renderer does not follow the cycle.
- Edge cases / failure handling: a missing parent is a root; duplicated spans are deduplicated; a string attribute
  containing a newline is escaped.
- Surprising: "preserves input order for equal start times" — the sort is stable by design.

### packages/telemetry/test/store-conformance.ts
- Purpose: a shared read-store conformance suite, exported for any `TelemetryStore` implementation.
- Key abstractions: `telemetryStoreConformance(name, factory)`, `StoreFixture`.
- Data flow: the suite writes spans through a context, calls `flush()`, then queries the store.
- Non-obvious design decisions: (1) the suite asserts the **id format**: `expect(root.id).toMatch(/^[0-9a-f-]{36}:[1-9][0-9]*$/)`
  — a UUID scope and a counter. (2) the pagination test creates 25 traces that all start at the *same* millisecond and
  asserts the pages contain no duplicates and no omissions — the tie-break is by trace id. (3) the remote-inheritance
  test deletes each carrier key in turn and replaces it with a number, and asserts that each malformed carrier produces
  a *root* fallback (2 × the number of keys fallbacks). (4) the metric test asserts the interval bounds are
  **inclusive interval-start times** and that the rows are detached.
- Edge cases / failure handling: only *settled* traces are returned; a store that has not flushed returns nothing.
- Surprising: this is a *second* conformance suite in the shard, independent of the adapter one — the store contract
  and the recording contract are separate.

### packages/telemetry/test/store.test.ts
- Purpose: 82 lines: the in-memory store runs the shared store conformance, plus three specific tests.
- Key abstractions: `telemetryStoreConformance("in-memory telemetry store conformance", …)`.
- Data flow: n/a.
- Non-obvious design decisions: the specific tests pin that `getSpans()` does **not** expose timestamps while
  `getTrace()` does — "records wall-clock boundaries and relative event times without changing normalized event
  snapshots" (line 13) — the two views are deliberately different.
- Edge cases / failure handling: the metric rows are count-one rows per raw measurement, "without exposing private
  timing in `getMetrics`".
- Surprising: the same `InMemoryTelemetryContext` is both the recorder and the store, and both conformance suites
  accept it.

### packages/telemetry/test/telemetry.test.ts
- Purpose: 186 lines pinning the schema type machinery and the no-op context.
- Key abstractions: `defineTelemetrySchema`, `createTypedSpanStarter`.
- Data flow: a schema → a typed starter → a span tree.
- Non-obvious design decisions: the `@ts-expect-error` block is the assertion (required event attributes cannot be
  omitted; closed-set values are exact; undeclared events are rejected; an empty end schema rejects every attribute;
  a union-valued name must be narrowed; attributes are selected from the schema that owns the span; duplicate span
  names across schemas are rejected).
- Edge cases / failure handling: the no-op section asserts the synchronous admission, the frozen shared span, the
  identity of the shared metrics/propagation objects, and the preservation of sync and async rejection values.
- Surprising: `expect(schema).toBe(definition)` — `defineTelemetrySchema` is an identity function and the test
  asserts it.

### packages/telemetry/tsconfig.build.json
- Purpose: the build config for the package.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: nothing beyond `outDir`/`rootDir`; unlike the other packages, telemetry has no
  `paths` mapping because it depends on no sibling package.
- Edge cases / failure handling: n/a.
- Surprising: nothing.

---

## Ideas worth stealing

- **A portable CPU bound for synchronous sandboxes, separate from the wall-clock deadline** —
  `packages/codemode/src/runtime/inline.ts:77` — QuickJS polls an interrupt handler; the launcher counts the polls
  and fails the run with `kind: "timeout"` past a budget. This is the only way to bound a script that computes without
  awaiting, because the host's timer and `Date.now()` are both frozen during synchronous execution. August's code-mode
  runner has exactly this problem (`code_runner.py` runs a fenced Python block): an interrupt/poll budget is the
  portable equivalent of "kill the process group", and it degrades to a timeout instead of a hard crash.

- **The output budget is enforced *inside* the sandbox and the failure is not catchable** —
  `packages/codemode/src/runtime/prelude-source.ts:342` — `output()` calls `done(false, describeError(error))` *before*
  it throws, so the host has already decided the run failed even if the script swallows the exception. August's
  `MAX_OUTPUT_CHARS`-style limits are enforced in the host today; moving the *decision* into the sandbox means a
  runaway printer cannot grow the host's memory between the check and the abort.

- **Deterministic, replayable sandbox runs with a VM fingerprint** —
  `packages/codemode/src/runtime/vm.ts:103` (virtual clock + seeded PRNG + UTC + no `WeakRef`) and
  `packages/codemode/src/runtime/vm.ts:317` (the fingerprint: engine versions, prelude hash, stack size, heap limit,
  budget) — the same script, start time, seed, tools and results make the same calls on any VM with the same
  fingerprint, so a host can replay a run after a restart and *refuse* a different VM. August's session resume and
  `_stuckRequestEscape` ladder both need "the same run, again" — this is a complete answer to that.

- **Result ordering by number, not by arrival, with early results buffered** —
  `packages/codemode/src/runtime/vm.ts:211` — the host answers calls with `seq` 1, 2, 3… and the VM applies them
  strictly in that order, buffering early ones, because "a transport (RPC replies) may deliver them in another order
  than the host sent them". August's `_stuckRequestEscape` ladder and the tool-result ordering in the transcript would
  both benefit from an explicit result number rather than an arrival-order assumption.

- **Worker lifetime is accounted separately from the result** —
  `packages/codemode/src/runtime/host.ts:68` and `packages/codemode/src/types.ts:157` — `onWorkerStarted(exited)`
  resolves when the worker *actually* exits, which may be after the result and after `close()`; `acquireWorker()`
  reserves capacity synchronously before the worker is created and releases it on real exit. August's "no test suite"
  and "one unmissed door" rules make this worth copying: a concurrency slot that is released when the *result* settles
  is released too early, and a slot that is never released leaks.

- **The "did you mean" proxy on a tool namespace** —
  `packages/codemode/src/runtime/prelude-source.ts:230` — reading a missing member of `tools` throws a `TypeError`
  naming the close matches, the full list when it is short, and the `ALL_TOOLS` hint. August's tool-surface errors are
  currently generic; this converts a typo into a self-correcting model behaviour at zero cost.

- **Freeze the built-ins without breaking the "override mistake"** —
  `packages/codemode/src/runtime/prelude-source.ts:58` — the lockdown walks every object reachable from the globals
  and freezes it, but `constructor`, `name`, `message`, `toString`, `toLocaleString`, `valueOf`, `toJSON` and
  `Object.prototype` members are re-installed as accessors whose setter *defines an own property on the instance*.
  August's `code_runner.py` and the JS sandbox in `workbench/code_runner.py` have the same need and the same trap: a
  naive `Object.freeze` breaks `class MyError extends Error { this.name = "MyError" }`.

- **The prompt-size budget for tool declarations, with a two-stage degradation** —
  `packages/codemode/src/declarations.ts:139` — a rendered type over 16 000 characters is re-rendered *without* the
  constraint tags, and only if it is still too long becomes `unknown`. The tags are the cheap part and the type is the
  expensive part, so the degradation order is chosen deliberately. August's per-model `maxTools` /
  `maxToolResultChars` budgets are the same kind of decision and could use the same two-stage rule.

- **Constraint tags for what a type cannot express** —
  `packages/codemode/src/declarations.ts:253` — `// @integer @minimum 1 @default 20` on the property's comment line,
  with the nullable-`anyOf` branch's constraints read from the *non-null* branch and draft-04 boolean exclusive bounds
  translated. August's JSON-Schema tool definitions carry the same information, and the model is more likely to obey a
  bound it can see.

- **The transport owns framing, the client owns correlation** —
  `packages/mcp/README.md:114` and `packages/mcp/src/transports/transport.ts:18` — a six-method transport interface
  whose only unusual member is `send(message, { signal })`. The `signal`'s doc is the whole reason the interface
  exists: "A transport must not dispatch the message after that, for example when retrying it after an authorization
  refresh" (`transport.ts:13`). August's MCP door would get the same guarantee for free.

- **A cancelled request must never be re-dispatched after a shared authorization refresh** —
  `packages/mcp/src/transports/streamable-http.ts:303` — the abort is checked *after* the token is obtained and
  *before* the fetch, so a request the caller gave up on does not reach the server. The test
  (`packages/mcp/test/streamable-http.test.ts:346`) asserts three requests share one refresh, two are cancelled while
  waiting, and only the third reaches the server. This is precisely August's "a request the provider refused is
  repaired, not replayed" concern, on the MCP side.

- **One refresh shared by concurrent 401s, with a rotating-refresh-token guard** —
  `packages/mcp/src/oauth/flow.ts:459` — before refreshing, the flow checks whether the *current* token already differs
  from the rejected one; if it does, another request already refreshed, so it retries with the new grant instead of
  burning the old refresh token. August's provider-key and gateway-error paths have the same shape.

- **The RFC 9207 issuer check that fails closed** —
  `packages/mcp/src/oauth/flow.ts:386` — a code is exchanged only when the `iss` parameter names the flow's
  authorization server; if the server promised the parameter and did not send it, the exchange is refused; and with no
  metadata at all, *any* `iss` is refused, because "a server cannot skip the check by hiding it". The test matrix
  (`packages/mcp/test/oauth.test.ts:503`) covers all four cases.

- **The step-up scope is the union of the challenged scopes and the granted ones** —
  `packages/mcp/src/oauth/flow.ts:314` — "a challenge may list only the missing scopes and a token with just those
  would lose access the old one had (SEP-2350)". August's scope/token handling would otherwise silently narrow
  permissions on a step-up.

- **Control frames always precede bulk output** —
  `packages/env/daemon/src/output.rs:34` and `packages/env/daemon/src/main.rs:369` — the daemon has two queues and
  the writer always pops the control queue first, so "a slow link delays bulk data, not replies". A cancel's result, a
  ping and a small reply are never stuck behind a megabyte of command output. August's SSE transport has the same
  hazard.

- **The output window proves exclusion by counts, and keeps the tail** —
  `packages/env/daemon/src/window.rs:103` — a prefix is dropped only when the *remainder* still exceeds the window,
  the cut is made at a character boundary, and the skip is reported as `{ bytes, newlines, endsWithNewline }` while
  *everything after the cut* is still delivered. The guarantee ("text followed by more than the window can never be
  in the caller's tail") is what makes the transfer safe to skip.

- **Back-pressure is real, not simulated** —
  `packages/env/daemon/src/exec.rs:222` and `packages/env/daemon/src/output.rs:52` — a command without an output window
  *waits* while more than 4 MiB of output is unsent, which slows the command exactly as a full pipe would. A harness
  that merely drops output is lying to the model about what the command printed.

- **A daemon binary named by its SHA-256, verified before every start** —
  `packages/env/src/ssh.ts:378` and `packages/env/src/ssh.ts:405` — the remote path is `pi-env-<sha256[0..32]>`, the
  upload is verified before it is renamed into place, daemons of other contents are removed, and a host without any
  SHA-256 tool is refused rather than trusted. August's "install the agent" and "the daemon must be verified" rules
  would transfer directly.

- **A changed host key is never accepted automatically** —
  `packages/env/src/ssh.ts:258` — a key that differs from a trusted key of the same type is refused with
  `HostKeyChangedError`; only plain lines for the target's alias are accepted, and marker/hashed lines are rejected.
  The known-hosts file is rewritten one change at a time, atomically.

- **Capability negotiation in `hello`, so an old daemon degrades instead of failing** —
  `packages/env/src/list-files.ts:39` — the client checks `hello.features` *before* issuing the request and answers
  `not_supported` itself, so the caller falls back to its own walk. Protocol version 1 is extensible without a version
  bump. August's backend-feature discovery has the same shape.

- **Handles are bound to the session that opened them** —
  `packages/env/src/connection.ts:203` and `packages/env/src/remote-env.ts:134` — a request that names a session is
  refused if the connection was lost and restarted, so a stale handle fails instead of reaching a *different* daemon
  that happens to reuse the id. This is the same class of bug as August's "a request the provider refused" ladder.

- **The differential test: the same random operation sequences against a local and a remote implementation** —
  `packages/env/test/differential.test.ts:227` — 60 seeds × 25 steps, comparing `NodeExecutionEnv` with
  `RemoteExecutionEnv` on the same machine, normalising away the root path and keeping only the error *code*. The
  content corpus deliberately includes a BOM, an invalid UTF-8 sequence and 300 001 multi-byte characters, to cross
  chunk boundaries. August has no test suite; this is the cheapest possible substitute — a differential harness, not
  assertions.

- **The callback is the scope: no public `end()`** —
  `packages/telemetry/src/index.ts:102` — `startSpan(options, callback)` owns settlement; the span is open until the
  callback's value or promise settles, and a throw sets the error status *unless* an explicit status was set. August's
  turn/span bookkeeping currently has to remember to close things; a callback makes the scope structural.

- **A conformance suite expressed as data, not as a test file** —
  `packages/telemetry/src/testing/conformance.ts:44` — `createTelemetryAdapterConformance(factory)` returns
  `{ group, name, run() }` cases that any runner can register, each with a *fresh* fixture via `await using`. August
  has pluggable subsystems (the terminal door, the MCP door, the memory backend); a suite that a backend can run
  against *itself* is the replacement for a test suite that nobody writes.

- **An opaque carrier, and extraction that falls back to a root** —
  `packages/telemetry/src/memory.ts:308` — the carrier is a JSON-safe string map the adapter owns; extraction checks
  only that the required keys are strings and treats the identifiers as opaque, so one adapter can continue another
  adapter's trace. August's cross-process continuation (the Durable worker) needs exactly this.

- **A schema that is data, with the type system enforcing the vocabulary** —
  `packages/telemetry/src/index.ts:175` and `packages/telemetry/src/index.ts:396` — `defineTelemetrySchema` is an
  identity function over serialisable data, and `createTypedSpanStarter` makes duplicate span names, wrong attribute
  sets and undeclared events *compile-time* errors. August's tool names, event names and receipt vocabulary are all
  closed sets that nothing currently checks.

---

## Files skipped (with reasons)

- `packages/env/daemon/Cargo.lock` — a Cargo-generated lockfile (479 lines). I read the header and the first ~35
  packages to confirm it is exactly what it claims: an auto-generated dependency lock with `version = 4`, one
  `[[package]]` block per crate with a registry source and a checksum, and `pi-env` pinned to the exact `=` versions
  from `Cargo.toml`. I did not read it line by line because it is generated data with no mechanism in it; the
  dependency set it pins is fully described by `Cargo.toml`, which I did read.

No other file was skipped. Every one of the 129 files in the shard was opened and read. (The one file that carries no
mechanism — `packages/mcp/LICENSES/modelcontextprotocol-typescript-sdk.txt`, a verbatim copy of the MIT licence text —
was read in full and is marked `read` in the ledger, because it is 21 lines and I did open it; the three files that
need it, `src/oauth/flow.ts`, `src/oauth/discovery.ts` and `src/oauth/types.ts`, each carry the attribution header
themselves.)

---

## Uncertainties

- **The `packages/env` daemon's Windows path is verified by inspection only.** I read `sys/windows.rs` and
  `pty.rs` in full and they look correct against libuv's documented behaviour, but I could not confirm any of it
  empirically — the clone is read-only and I ran nothing. The Windows-specific claims I make in the notes (the
  `ERROR_DIRECTORY`→`ENOENT` mapping, the `CreateFileW` dispositions, the `child_environment` sort order) are
  cross-read against libuv's source comments cited in the file itself, not against a running daemon.
- **`packages/env/daemon/src/watch.rs` is a *port* of Durable's `NodeFileWatcher`, whose original I did not read** —
  it lives in `packages/durable`, which is another shard. The port looks faithful (snapshot diffing, the polling
  fallback, the `overflow` report), but I cannot confirm that the original and the port agree on every rule; the
  conformance suite in `packages/env/test/conformance.test.ts` is what pins it, and I did not run it.
- **I did not read `packages/durable/src/env/node.ts`**, the reference implementation the whole `env` package claims
  to match. The `docs/semantics.md` table is the authoritative statement of the split, and I read it, but where it
  summarises rather than quotes I could not verify the claim against the reference.
- **The `pi` repo's agent loop, session storage, compaction, extension/skill mechanisms, provider abstraction and
  TUI rendering are all outside this shard.** I found no files in my 129 that touch the turn loop, the transcript
  store, the compaction path or the skill system, so the lenses "agent loop and turn lifecycle", "session storage /
  branching / compaction" and "extension / plugin / skill mechanisms" are covered here only at the level the four
  packages reach them (codemode's `Execution` lifecycle, the MCP client's request lifecycle, the telemetry span
  lifecycle). The claims I make about those lenses are limited to what these files contain.
- **`packages/codemode/src/runtime/vm.ts` uses an internal QuickJS API** (`vm._getExports()`) to run promise jobs one
  at a time. The file says this is safe "because quickjs-wasi is pinned to an exact version" (3.6.2). I could not
  check the upstream library's changelog from the clone, so I am relying on the package's own statement; if
  `quickjs-wasi` ever moves off the exact pin, that call site is the first thing to break.
- **The OAuth code is adapted from the MCP TypeScript SDK v1.29.0** and the package ships the SDK's licence. I read
  the adapted files and the licence, but I could not diff them against the upstream SDK from this clone, so I cannot say
  how much of the upstream behaviour was deliberately changed beyond what the file headers and the changelog state
  ("Modified to remove SDK/Zod dependencies and use WebCrypto for PKCE", "enforce authorization-server issuer
  validation", "use dependency-free structural validation").
- **I did not read the repository's root `AGENTS.md`, `CONTRIBUTING.md` or CI configuration**, because none of them
  are in my shard. The consequence is that I could not check the packages' test suites against the repo's own
  conventions (for example whether `npm test` is the expected entry point — the packages each define
  `"test": "vitest --run"`).
