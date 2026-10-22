# deepseek-harness / dsh-remote-ptc

## Shard shape

This shard is the **remote/hosted execution capability family** of deepseek-harness, in two halves that share one design vocabulary.

The first half is the **PTC execution seam** (`packages/ptc-runtime/`): an abstract service `ctx.ptcRuntime` (Service Definition, `ptc-runtime/`) plus the shipped Node backend (`ptc-runtime-node/`) that runs a *model-written program* against *host-provided async bindings* inside a sandboxed child process. The seam owns a request/spec/result vocabulary, an orthogonal failure taxonomy and a set of portable-identifier exclusion sets; the Node provider owns the process, the JSON wire, the output ledger, the sandbox policy and an opt-in retained-REPL mode.

The second half is the **POSIX SSH provider family** (`packages/ssh/`): one OpenSSH connection (`ssh/`) that carries a private administrative RPC to an installed remote helper, plus three providers that re-implement `ctx.fs`, `ctx.subprocess` and `ctx.sandbox` against that helper (`fs-ssh/`, `subprocess-ssh/`, `sandbox-ssh/`), and a packaging package (`ssh-helper-runtime/`) that ships the helper as a self-contained executable with an embedded Node.

The two halves fit together through one idea repeated on both sides: **the host owns policy, deadlines, identity and cleanup; the program or the remote side is an untrusted peer whose traffic is validated, bounded and never replayed.** The PTC host validates every control frame the model-written program writes to the inherited descriptor; the SSH client validates every frame the remote helper returns, and the helper validates every frame the client sends. Both halves have a "facts reported separately from the outcome" channel (PTC's `result.sandbox`, SSH's `sandbox` facts / `collected` snapshots), and both refuse to claim a rollback they cannot observe.

## Per-file notes

### packages/ptc-runtime/README.md
- Purpose: Package-group map for the PTC capability family: which of the three packages owns what.
- Key abstractions: `ctx.ptcRuntime` is the ctx key of the seam; `ptc-runtime-node` registers it, `experimental/ptc-runtime-python` owns an fd-3 wire and is not in this shard.
- Data flow: none — a routing document.
- Non-obvious design decisions: The group README states the two execution modes in one sentence: default fresh process per call, opt-in `executionMode: persistent-in-memory` keeps "a separate confined REPL for each explicit state owner; memory ends with the process or owner."
- Edge cases / failure handling: "Failures return as results for callers to diagnose or present to the model" — stated as the family's contract, not a per-provider accident.
- Surprising: It says the Python backend is "experimental" and *private* (not published), so the portable-identifier sets are written for a backend that does not exist publicly yet.

### packages/ptc-runtime/README.i18n.yaml
- Purpose: Per-heading bilingual consistency record (en/zh hashes) for `packages/ptc-runtime/README.md`.
- Key abstractions: Each heading section gets a hash of its English and Chinese blocks outside code fences.
- Data flow: `pnpm run verify-translation-pairing --write <file>` regenerates it.
- Non-obvious design decisions: A translation drift is a *machine-checkable* defect, not a review item.
- Edge cases / failure handling: n/a.
- Surprising: The doc set is bilingual-first — every package carries a `.zh.md` and a hash record, so the Chinese README is a first-class artifact, not a translation afterthought.

### packages/ptc-runtime/README.zh.md
- Purpose: Chinese mirror of the PTC package-group map; content is structurally identical (same 52 lines).
- Key abstractions: Same package table with Chinese role descriptions.
- Data flow: n/a.
- Non-obvious design decisions: The Chinese text keeps the English identifiers (`executionMode: persistent-in-memory`) verbatim so config keys are copy-pasteable across the two documents.
- Edge cases / failure handling: n/a.
- Surprising: The zh file is *not* a literal translation — it says "无沙盒的 REPL" where the English says "a separate confined REPL", i.e. the two sides can drift in meaning even while the section hashes match.

### packages/ptc-runtime/ptc-runtime/README.md
- Purpose: Package reference for the abstract PTC seam: what a caller hands the runtime and what it gets back.
- Key abstractions: `PtcRuntime extends Service` (Service Definition), `PtcRunRequest` → `resolve()` → `PtcRunSpec` → `run()` → `PtcRunResult`.
- Data flow: `resolve` validates cwd/timeout/sandbox choices and applies provider defaults; `run` executes and resolves program outcomes **after cleanup**.
- Non-obvious design decisions: `resolve` and `run` are split so *validation and defaulting happen before a process is started* — `run` "does not fill missing values" and rejects unresolved inputs as caller misuse. `timeout: null` is a first-class choice (no elapsed deadline) distinct from "omitted" (provider default); the model-facing tool only accepts positive numeric overrides, but the workflow adapter requests `null`.
- Edge cases / failure handling: Eight orthogonal failure kinds, documented as *orthogonal* — "a budget expiry is not an exception, an abort is not a timeout, and a substrate death is neither." A failed program is a **field** on a resolved result, never a rejection of `run()`.
- Surprising: "Language and isolation descriptors identify syntax and execution substrate, **not security guarantees**" — `isolation: 'process'` is documentation, not a claim.

### packages/ptc-runtime/ptc-runtime/README.i18n.yaml
- Purpose: Heading-hash record for the seam's package README (18 heading sections hashed en+zh).
- Key abstractions: Section paths are the README's anchor slugs (e.g. `/deepseek-ai-dsh-ptc-runtime/known-limitations-and-deferred-work/dev-note`).
- Data flow: Regenerated by the `verify-translation-pairing` script.
- Non-obvious design decisions: The Dev Note is inside `<details>` and is explicitly "non-authoritative — shipped behavior and limits live in the sections above and the package code", which is why it is hashed separately from the contract.
- Edge cases / failure handling: n/a.
- Surprising: The "Known Limitations" section is a *contract*, not a backlog: "These limits define what the seam cannot do; they are current package constraints, not a task backlog."

### packages/ptc-runtime/ptc-runtime/README.zh.md
- Purpose: Chinese mirror of the seam README; same 150 lines, same anchors.
- Key abstractions: Same request/spec/result vocabulary, same eight failure kinds.
- Data flow: n/a.
- Non-obvious design decisions: The zh text preserves the English "Known Limitations" framing ("当前包约束，不是任务积压"), i.e. a limitation is a promise, not a TODO.
- Edge cases / failure handling: n/a.
- Surprising: The zh README explains the *reason* for `RESERVED_ERROR_MEMBERS` more explicitly than the English does (Python's `args`/`with_traceback`/`add_note` are "Python 异常协议成员").

### packages/ptc-runtime/ptc-runtime/src/index.ts
- Purpose: The Service Definition: an abstract `PtcRuntime` service plus the four portable-identifier exclusion sets every backend enforces.
- Key abstractions: `PtcRuntime extends Service` registered as `ctx.ptcRuntime`; `RESERVED_BINDING_GLOBALS`, `RESERVED_ERROR_MEMBERS`, `DUNDER_MEMBER`, `PORTABLE_RESERVED_WORDS`.
- Data flow: A provider subclasses, implements `resolve`/`run`, and registers; consumers call `ctx.ptcRuntime`.
- Non-obvious design decisions: **One shared set rather than per-backend checks.** The comment is explicit: "a namespace list valid on one backend is valid on all, so a caller cannot pick a name that works on Node and collides on Python (or vice versa)." Each exclusion carries its reason — `__debug__` is listed not for a collision but because "CPython compiles a bare `__debug__` reference to the constant `True` and rejects any assignment to the name at COMPILE time, so an injected global under that name is unreachable from the program."
- Edge cases / failure handling: `release(owner)` is part of the seam contract; `timeout`, `sandboxMode`, `programFormat`, `executionInstructions` are all optional descriptors with documented defaults.
- Surprising: `language` and `isolation` are declared `abstract readonly` but documented as "Informational, not gating — a descriptor so deployments and diagnostics can tell backends apart, not a security claim."

### packages/ptc-runtime/ptc-runtime/src/types.ts
- Purpose: The seam's whole vocabulary: request, spec, bindings, result, failure, sandbox facts.
- Key abstractions: `PtcRunRequest`, `PtcRunSpec`, `PtcBindingNamespace`, `PtcBindingErrorClass`, `PtcRunResult`, `PtcRunFailure`, `PtcRunSandbox`, `PtcJsonValue`.
- Data flow: Caller → `resolve` → `run` → result; bindings bridge host async functions into the program as globals.
- Non-obvious design decisions: The failure taxonomy is deliberately **orthogonal** ("per docs/defensive-patterns/general.md") with eight mutually exclusive kinds; `PtcRunResult.error` is a field, "never a rejection of `run()` — reporting a failed program is the caller's job, not an exception path." `PtcRunSandbox` is a *separate* channel from `error`: "File confinement applied to a program, **independently of its terminal outcome**."
- Edge cases / failure handling: `signal` aborts the program "hard, even mid-loop" and resolves `kind: 'abort'`; "In-flight binding calls are the CALLER's to settle — the runtime only stops asking." `denied` is explicitly "not enforcement proof or an exhaustive denial record."
- Surprising: `PtcBindingNamespace.functions` must treat `__proto__`/`constructor` as ordinary own properties — "null-prototype construction, never as prototype collisions."

### packages/ptc-runtime/ptc-runtime/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-ptc-runtime`, version `0.2.1-rc.2`, public.
- Key abstractions: exports `.` → `lib/index.js` + `lib/types/index.d.ts`, plus `./src/*` (source escape hatch for workspace consumers).
- Data flow: peer-depends on `cordis` and `dsh-sandbox`; ships only `lib/index.js` and the `.d.ts` tree.
- Non-obvious design decisions: `types` points at `lib/types/index.d.ts` while `main` points at `lib/index.js` — a two-output build (tsc for declarations, tsdown for JS).
- Edge cases / failure handling: n/a.
- Surprising: The package has **no** runtime dependencies — the seam is dependency-light on purpose ("a lossless JSON value transferable through the dependency-light Service Definition").

### packages/ptc-runtime/ptc-runtime/tsconfig.json
- Purpose: Project reference for the seam: `rootDir: src`, `outDir: lib/types` (declarations only).
- Key abstractions: References `vendor/cosmokit`, `vendor/cordis`, `packages/sandbox/sandbox`.
- Data flow: n/a.
- Non-obvious design decisions: The seam references the sandbox *types* but no runtime dependency on the sandbox implementation, keeping the Service Definition free of a provider.
- Edge cases / failure handling: n/a.
- Surprising: n/a — configuration only.

### packages/ptc-runtime/ptc-runtime/tests/reserved.spec.ts
- Purpose: Pins the four shared exclusion sets' membership so backends cannot re-declare them locally.
- Key abstractions: `RESERVED_BINDING_GLOBALS`, `RESERVED_ERROR_MEMBERS`, `DUNDER_MEMBER`, `PORTABLE_RESERVED_WORDS`.
- Data flow: n/a.
- Non-obvious design decisions: The test asserts the *reason* for each edge case: `__` and `____` are NOT dunder forms (empty middle), `__x__` is the shortest real one; `lambda`/`nonlocal` are refused so the list stays portable even though the Python backend is unpublished.
- Edge cases / failure handling: n/a.
- Surprising: `RESERVED_ERROR_MEMBERS.has('code')` is asserted `false` — the set is a *union across languages*, and `code` is not an error-protocol member in either.

### packages/ptc-runtime/ptc-runtime/tests/service.spec.ts
- Purpose: Exercises the abstract seam through a minimal `StubRuntime` subclass (the package ships no provider).
- Key abstractions: `ctx.ptcRuntime` registration, `Service.init`/dispose, duplicate-service rejection.
- Data flow: `ctx.plugin(StubRuntime)` → `ctx.ptcRuntime`.
- Non-obvious design decisions: The stub "executes" by invoking every binding once in declaration order, so the *ordering* guarantee of the namespace list is itself under test.
- Edge cases / failure handling: Asserts a failed run is an `error` field on a resolved result (not a rejection); a pre-aborted signal yields `kind: 'abort'`.
- Surprising: Two HMR-safety assertions: the service is removed from the context when its fiber disposes, and a **second implementation in the same context is rejected** ("registered" error) — the service is a singleton by construction.

### packages/ptc-runtime/ptc-runtime-node/README.md
- Purpose: Package reference for the Node backend: configuration table, execution modes, deadlines, failure mapping.
- Key abstractions: `executionMode: per-call | persistent-in-memory`; `programFormat` flips to `'repl'` in the latter.
- Data flow: `resolve(request)` defaults cwd to the sandbox policy workspace root and clamps the deadline; `run(spec)` executes.
- Non-obvious design decisions: The in-memory mode is **opt-in by config patch** ("Enable it deliberately with a profile patch"), and "Changing the configuration reloads the provider and releases its execution resources." A one-time approved escalation "uses a separate environment and awaits its cleanup before returning; it cannot read the standing environment's variables or retain new declarations."
- Edge cases / failure handling: "Raw stdout/stderr have **no evaluation identity**: bytes received during an evaluation share its output budget, even when written by an earlier child process; idle stdout is discarded and idle stderr retains only the bounded diagnostic tail." "Permission-setting success does not mean old processes have finished stopping."
- Surprising: The README says the timeout "is not a CPU meter", and that "The timer stops when an outcome is selected, **before cleanup**, so the returned call can take longer than its execution deadline while cleanup settles."

### packages/ptc-runtime/ptc-runtime-node/README.i18n.yaml
- Purpose: Heading-hash record for the Node backend README (14 sections).
- Key abstractions: Section paths mirror the README's anchors, e.g. `/deepseek-ai-dsh-ptc-runtime-node/in-memory-mode`.
- Data flow: Regenerated by `verify-translation-pairing`.
- Non-obvious design decisions: The "in-memory mode" section is its own hashed unit because it is the mode with the most behavioural rules.
- Edge cases / failure handling: n/a.
- Surprising: n/a — generated record.

### packages/ptc-runtime/ptc-runtime-node/README.zh.md
- Purpose: Chinese mirror of the Node backend README (181 lines).
- Key abstractions: Same config table; same `executionMode` semantics.
- Data flow: n/a.
- Non-obvious design decisions: Keeps "内存按尽力保留处理，不保存到磁盘" (best-effort, never on disk) and the idle-stdout rule verbatim in meaning.
- Edge cases / failure handling: n/a.
- Surprising: The zh version of the source map table lists 10 files while the English lists 11 — the English table includes `src/output-ledger.ts` ("Host accounting for the outer result"), the zh one omits it.

### packages/ptc-runtime/ptc-runtime-node/src/index.ts
- Purpose: The Node provider: mode selection, resolution, sandbox policy, and the whole host-side execution loop.
- Key abstractions: `NodePtcRuntime extends PtcRuntime`; `static inject = ['fs','subprocess','sandbox','sandboxPolicy']`; `PolicyProcesses`; `OutputLedger`; `JsonChannel`.
- Data flow: resolve → validate bindings → strip TS types → resolve executable → `ctx.sandbox.confine(argv)` → `ctx.subprocess.spawn` with `stdio.control: 'pipe'` → handshake (`ready`/`boot`) → dispatch `call` frames to host bindings → `done` frame → `finish()` → terminate+drain → result.
- Non-obvious design decisions: **Cancellation is re-checked after every await that could race it** — the code has four explicit `if (settled) return await result.promise` checks with `oxlint-disable-next-line typescript/no-unnecessary-condition` comments explaining that an abort callback can settle execution during an awaited operation. The child's environment is scrubbed to only `PATH/PATHEXT/SYSTEMROOT/WINDIR/TEMP/TMP` (plus `ELECTRON_RUN_AS_NODE` for the child startup only, removed by the bootstrap before model code runs), and the *program-visible* `process.env` is replaced with an empty dictionary. The heap cap is applied as `--max-old-space-size` argv for a normal Node, but as a provider-built `NODE_OPTIONS` for a packaged executable, and "ambient loader and inspector flags are discarded."
- Edge cases / failure handling: `finish()` is idempotent and selects the failure kind: timeout vs abort (by `timedOut`), `protocol` for any invalid control frame, `sandbox-unavailable` when the *runner* evidence says the sandbox failed (`classifyRunnerFailure(exitCode, stderr, confined.runnerFailureRules)`), `worker-exit` otherwise, `invalid-output` for a non-lossless completion, `output-limit` when the combined budget is crossed. A late binding reply is never published after the program settled (`if (!settled) await transport.send(reply)`).
- Surprising: `sandbox.denied` is computed by *string-matching the failure message against the confinement's own denial signatures* (case-insensitively) — a heuristic on top of the backend, deliberately reported as "not enforcement proof".

### packages/ptc-runtime/ptc-runtime-node/src/bindings.ts
- Purpose: Validates the binding namespaces a program will see, and encodes a host binding's result back onto the wire.
- Key abstractions: `validateBindings(request)` → `Map<string, PtcBindingNamespace>`; `replyToBinding(id, binding, args)`.
- Data flow: Host → `validateBindings` → boot payload namespace declarations → child materialises them; child `call` frame → host `replyToBinding` → `reply` frame.
- Non-obvious design decisions: Validation happens **before a process is started**, and the four separate rejection messages distinguish "not a usable identifier" / "reserved binding global" / "duplicate binding global" / "duplicate injected global" / "binding error member property is not usable". The comment re-states *why* the shared `RESERVED_BINDING_GLOBALS` is applied here even though `console` is this backend's slot: "refused here too so the namespace list stays portable across backends."
- Edge cases / failure handling: A binding that no longer exists in the current evaluation rejects with `'binding is unavailable in this evaluation; reacquire the current tool'` — an actionable message, not "undefined function". A binding resolution that is not lossless JSON rejects with `'binding resolution must be lossless JSON'`.
- Surprising: The error-class *name* is checked against `RESERVED_BINDING_GLOBALS` as well as the namespace globals, so a namespace named `tools` and an error class named `tools` collide — and both are caught by a separate "duplicate injected global" check.

### packages/ptc-runtime/ptc-runtime-node/src/bootstrap.ts
- Purpose: The child-side evaluator: runs one program, captures its output, and bridges host bindings.
- Key abstractions: `LogBuffer`, `makeConsoleShim`, `captureStreamWrites`, `prepareCompletion`, `prepareException`, `makeBindingErrorClass(es)`, `makeNamespaces`, `wireReplies`, `runProgram`.
- Data flow: `boot` payload → build namespace objects and error constructors → evaluate the program as an `AsyncFunction` with the namespaces and the console shim injected as parameters → `done` frame with the completion value or a bounded exception.
- Non-obvious design decisions: The program is evaluated as a **strict-mode async function body** whose parameters are the binding globals and the error classes: `new AsyncFunction(...data.namespaces.map(n => n.global), ...errorClassParameters, 'console', "'use strict';\n" + data.code)`. The `AsyncFunction` constructor is reached through an instance because `AsyncFunction` is not a global. Module-level `CapturedError`/`capturedObjectCreate`/`capturedObjectDefineProperty` are captured so a program that mutates `Error` or `Object.defineProperty` cannot corrupt the child's own error construction. The console shim has exactly **five** methods (`log/info/warn/error/debug`) and renders non-strings `util.inspect`-style with bounded options (depth 4, maxArrayLength 100, maxStringLength 10 000).
- Edge cases / failure handling: `LogBuffer` charges the JSON-serialised cost of each log line (including the array syntax and escaping) and, when exhausted, emits **one** code-point-aligned fitting prefix and reports the limit once. `captureStreamWrites` patches `process.stdout.write`/`stderr.write` so raw writes land in the same buffer in emission order, and still fires Node's optional write callback asynchronously *even when the write is dropped by the budget*. `prepareException` catches an unrenderable thrown value and substitutes `'program threw an unrenderable value'`.
- Surprising: The namespace objects are `Object.create(null)` with each function defined via `Object.defineProperty(..., {enumerable: true, value})` — so `__proto__`, `constructor` and `toString` are ordinary own properties and can never be prototype collisions.

### packages/ptc-runtime/ptc-runtime-node/src/persistent.ts
- Purpose: The opt-in retained-REPL mode: one confined Node process per `stateOwner`, with evaluation deadlines and cleanup.
- Key abstractions: `Kernel` (one managed process) and `InMemoryExecution` (the owner→kernel map); `owners: WeakMap<object, Kernel>`.
- Data flow: `run(spec)` → `kernel.assertIdle()` → policy-change check → `stripTypeScriptTypes` → `kernel.run` → `evaluate` → `dispatch({type:'run', id, cwd, data})` → child evaluates → `done` frame → `finish()`.
- Non-obvious design decisions: **Owner identity is an object reference**, so "Different object identities never share an environment." The provider refuses to reuse a kernel whose mode/workspace/session changed: "release the retained environment before changing its sandbox policy." Concurrency is refused per owner (`'persistent PTC does not accept concurrent runs for one state owner'`) while distinct owners run concurrently. `cleanupPending` is a *third* state distinct from idle and running: while it is set, new runs are refused with `'cleanup is incomplete; release the owner before running another program'` and the error is retryable.
- Edge cases / failure handling: Every failure message in persistent mode ends with `"; retained variables were cleared"` — the mode's contract is that an abort/timeout/output-limit/parse-failure **destroys the environment**, and the message says so. `stop()` resets `cleanupPending` only after the drain resolves; a failed cleanup leaves the owner blocked and the release retryable.
- Surprising: The retained environment's `executionInstructions` is a single long model-facing string that states the *failure semantics* explicitly ("failed evaluations can leave earlier mutations in memory", "Redeclaring an existing let, const, or class name fails", "background callbacks cannot call tools after their evaluation ends") — the provider tells the model the rules rather than letting it discover them.

### packages/ptc-runtime/ptc-runtime-node/src/persistent-process.ts
- Purpose: The child-side Node REPL that serves sequential evaluations for one retained environment.
- Key abstractions: `runPersistentMain(stream, maxMessageBytes, processState)`; `PersistentProcess` (env/stdout/stderr/chdir); `AsyncLocalStorage<Evaluation>` for attribution.
- Data flow: host `run` frame → `repl.eval(program, repl.context, 'ptc-repl', cb)` → `done` frame back; binding calls post to the port with the evaluation's id.
- Non-obvious design decisions: `AsyncLocalStorage` is what makes output attribution possible: the sink reads `context.getStore()` so a log belongs to the evaluation that produced it, and a `port.postMessage` from a completed evaluation throws `'PTC evaluation has ended; call this function from a new run_code evaluation'`. The REPL's interactive result setters `_` and `_error` are **redefined as ordinary writable globals** so they do not print notices. A leading `{` is prefixed with `;` because "Node's REPL treats a leading brace as an object expression before transforming await." `process` inside the REPL is a **replaced** `processState` object, not the real `process`, so the program sees the scrubbed environment.
- Edge cases / failure handling: Pending binding calls are rejected when an evaluation ends (`'PTC evaluation ended before the binding completed'`). The `Writable` used as the REPL output turns any REPL-level error text into a bounded `exception` for the *active* evaluation. `repl.eval` errors become the evaluation's `error` field.
- Surprising: The REPL is started with `useGlobal: false` and `ignoreUndefined: true`, and the program text is evaluated in a `repl.context` where the binding globals are `Object.defineProperty`'d fresh on every evaluation so a *changed* binding set takes effect on the next call.

### packages/ptc-runtime/ptc-runtime-node/src/channel.ts
- Purpose: The length-framed JSON transport shared by host and child.
- Key abstractions: `JsonChannel(stream, maxBytes, receive, failure)`; 4-byte big-endian header + UTF-8 JSON body.
- Data flow: `send(message)` → measure → cork/write header+body → write receipt; `onData` → reassemble → `TextDecoder('utf-8', {fatal: true})` → `JSON.parse` → `receive(raw, bytes)`.
- Non-obvious design decisions: `send` measures the frame with the *same* `jsonValueBytesUpTo` the output ledger uses, and bounds the **queued** bytes separately from the per-frame size ("control output exceeds N queued bytes"). Writes are corked so header+body go out together, with the comment "Writable preserves frame order; a Promise queue would delay logs behind a model hot loop." The failure callback is told whether the fault was `'io'` or `'protocol'` so the caller can distinguish "the pipe broke" from "the peer sent garbage".
- Edge cases / failure handling: A declared frame length of 0 or `> maxBytes` is refused *before* the body is allocated. Invalid UTF-8 is a protocol failure (the decoder is `fatal: true`). The receive callback may synchronously close the channel, so the read loop re-checks `this.closed` on every iteration.
- Surprising: `close()` destroys the stream and rejects pending write receipts, but `drain()` exists so the *child* can wait for its terminal frame to be flushed before the host closes the channel.

### packages/ptc-runtime/ptc-runtime-node/src/json-wire.ts
- Purpose: The lossless-JSON boundary: snapshot, encode and decode of every value that crosses the process channel.
- Key abstractions: `snapshotPtcJsonValue`, `encodePtcJsonWire` (flat token array), `decodePtcJsonWire`; `PtcJsonToken`.
- Data flow: program value → `snapshotPtcJsonValue` (validate+detach) → `encodePtcJsonWire` (flatten) → JSON frame → `decodePtcJsonWire` (rebuild) → host value.
- Non-obvious design decisions: **Every JavaScript intrinsic the module uses is captured at load time** (`intrinsicObjectCreate`, `intrinsicReflectApply`, `intrinsicArrayIsArray`, `intrinsicReflectOwnKeys`, `intrinsicObjectKeys`, …) because the program shares the realm and can reassign `Array.prototype.push` or `Object.keys`. The traversal is **iterative** (an explicit task stack), so it adds no JavaScript call-stack depth: a 5 000-deep array round-trips. The wire is a **flat pre-order token array** — container markers and scalar leaves share one array — precisely so `JSON.stringify` does not recurse through the value's own nesting.
- Edge cases / failure handling: Rejects exotic containers, array subclasses, sparse arrays (including "compensated" ones with an extra own property), symbol keys, hidden own properties, cycles, `-0`, `NaN`, `Infinity`, `undefined` children, and a getter that mutates the array's validated length. Plain-prototype checks accept a **foreign realm's** intrinsic `Object.prototype`/`Array.prototype` (verified against `constructor.name` and `Function.prototype.toString` === `function X() { [native code] }`), and reject a *spoofed* one. A throwing getter propagates and **releases the recursion guard** so the next call is not poisoned.
- Surprising: `enumerableStringKeys` reads each accepted slot **once** — a getter is invoked exactly one time per snapshot, so a model cannot get a second, different value by racing the validator.

### packages/ptc-runtime/ptc-runtime-node/src/output-json.ts
- Purpose: Exact JSON byte accounting for the outer-output ledger, without materialising the escaped form.
- Key abstractions: `jsonStringBytesUpTo(text, maxBytes)`, `jsonValueBytesUpTo(value, maxBytes)`, `truncateJsonStringBytes(text, maxBytes)`.
- Data flow: Log text / completion value → measured against the remaining budget → admitted or refused.
- Non-obvious design decisions: The string measurer walks **code points** (not UTF-16 units) and charges the exact serialised cost of each: 2 bytes for `"` and `\`, 4 for a BMP character > 0x7FFF, 6 for a surrogate pair, 6 for a control character (2 for `\b\t\n\f\r`), otherwise the UTF-8 byte length. It returns `undefined` *as soon as* the cap is crossed, so a hostile 10 000-quote string never gets escaped at all.
- Edge cases / failure handling: `truncateJsonStringBytes` returns the longest **code-point-aligned** prefix whose JSON encoding (including the quotes) fits — it never splits a surrogate pair. The value measurer is iterative, so a 5 000-deep array is metered without stack growth.
- Surprising: Like `json-wire.ts`, this module captures its intrinsics — `String.prototype.charCodeAt`, `codePointAt`, `slice`, `Buffer.byteLength`, `Object.keys` — at load time, and the test proves it by mutating eight of them and asserting the measurement is unchanged.

### packages/ptc-runtime/ptc-runtime-node/src/output-ledger.ts
- Purpose: The host's combined byte accounting for one run's outer result.
- Key abstractions: `OutputLedger(maxBytes, overflowMessage?)` with `admit`, `success`, `failure`, `limit`.
- Data flow: stdout/stderr text and `log` frames → `admit(text, logs)` → on overflow → `limit(logs)` → `{logs: retained, error: {kind:'output-limit'}}`.
- Non-obvious design decisions: The ledger starts at **2 bytes** — "JSON serialization of the empty logs array: `[]`" — and adds a 1-byte separator per additional entry, so the cap is on the *serialised* result, not on a sum of string lengths. `limit()` reserves room for the fixed ASCII diagnostic first and then retains the longest fitting prefix of the logs, so the overflow message is never itself truncated away.
- Edge cases / failure handling: `failure()` lets `output-limit` take precedence when the diagnostic alone would exceed the cap. Binding values never enter this ledger ("binding values never enter it").
- Surprising: The `overflowMessage` constructor argument exists so the persistent mode can use a *different* text ("retained variables were cleared; outer output exceeded N bytes") without the ledger knowing about retention.

### packages/ptc-runtime/ptc-runtime-node/src/output-stream.ts
- Purpose: Bounded drainage of raw process output after managed execution ends.
- Key abstractions: `drainOutput(stream, graceMs)`, `terminateProcess(handle, graceMs)`.
- Data flow: `terminate()` → `stdout.resume()`/`stderr.resume()` → await `handle.done` and `handle.waitForExit()` → drain both pipes → destroy them.
- Non-obvious design decisions: `drainOutput` returns **false** for an already-destroyed stream and **true** for an already-ended one; a stream retained by an inherited descriptor cannot hold the run forever, so the grace timer bounds it.
- Edge cases / failure handling: `terminateProcess` resumes the streams *before* awaiting exit so a full pipe cannot deadlock the child, and destroys them in a `finally`.
- Surprising: The return value is a *drain* verdict, not an exit verdict — the caller (`index.ts`) turns a false drain into `worker-exit: 'Node process output did not close cleanly'`, i.e. a successful program whose output never closed is still a substrate failure.

### packages/ptc-runtime/ptc-runtime-node/src/policy-processes.ts
- Purpose: Invalidates and cleans up Node processes after a committed Session file-policy change.
- Key abstractions: `PolicyProcesses` with `register(policy, release)`, `wait(sessionId)`, and a `session/event` listener for `sandbox/mode`.
- Data flow: `session/event {type:'sandbox/mode'}` → for each registered process whose session and mode differ → mark `invalidated` → `release()` (async, not awaited) → the next `run` calls `wait(sessionId)` before admitting.
- Non-obvious design decisions: The class "Owns asynchronous process cleanup **without delaying permission setters**" — the mode change returns immediately and the cleanup runs in the background, but the *next* program blocks on `wait()`. Cleanup failures are logged as warnings and stay **registered**, so the next admission retries them rather than proceeding with a stale process.
- Edge cases / failure handling: A process registered without a `sessionId` is a no-op (`register` returns a no-op unregister) — only Session-scoped processes are tracked. `release()` is idempotent: the cleanup promise is cached on the record and cleared on failure so it can be retried.
- Surprising: The mode compared is the *Session's standing* mode resolved from the store, not the policy the call was admitted under — so a one-shot wider escalation does not count as the standing mode and is not invalidated by a later change of the standing mode.

### packages/ptc-runtime/ptc-runtime-node/src/environment.ts
- Purpose: The list of OS environment variables the child is allowed to keep, and the scrubber that empties the program-visible environment.
- Key abstractions: `STARTUP_ENVIRONMENT_NAMES` = `{PATH, PATHEXT, SYSTEMROOT, WINDIR, TEMP, TMP}`; `clearProgramEnvironment(state)`.
- Data flow: n/a (leaf module).
- Non-obvious design decisions: The retained set is exactly "native executable search, Windows system paths, and sandbox temporary paths" — enough for nested process creation and native temp-file APIs, nothing else. `clearProgramEnvironment` deletes everything else *and* replaces `state.env` with a **null-prototype** object, so the program cannot reach `process.env.constructor`.
- Edge cases / failure handling: The comparison is case-insensitive (`key.toUpperCase()`), which matters on Windows.
- Surprising: This is a *file*, and it is imported by three different modules (host, per-call child, persistent child) so the "allowed environment" list has exactly one home.

### packages/ptc-runtime/ptc-runtime-node/src/config.ts
- Purpose: The deployment configuration schema and its validation.
- Key abstractions: `Config`, `ResolvedConfig`, `NodeConfig` (schemastery), `validateConfig(config)`.
- Data flow: Loader defaults → `validateConfig` → `ResolvedConfig` used by the provider.
- Non-obvious design decisions: `launch` is a **discriminated union** with no default in the schema — `resolveLaunch` picks the local carrier at construction, so the schema never guesses. `maxMessageBytes` is capped at `0xffff_ffff` because the frame length is a 32-bit header field; `maxOutputBytes` must be at least 4.
- Edge cases / failure handling: Every numeric field must be positive and finite, and `timeoutMs`/`maxTimeoutMs`/`graceMs` must fit `MAX_TIMER_DELAY_MS` (a Node timer ceiling). The error messages name the offending key, so a bad deployment config is diagnosable from the message alone.
- Surprising: The same `validateConfig` is the gate that rejects `timeoutMs: 0` — a zero timeout is not "no timeout" (that is `null`), it is an invalid deployment.

### packages/ptc-runtime/ptc-runtime-node/src/launch.ts
- Purpose: Chooses the worker's executable and bootstrap asset in the *execution world* (which may be a remote host).
- Key abstractions: `LaunchConfig` = `{kind:'node-script', executable, bootstrapPath?}` | `{kind:'embedded', executable}`; `resolveLaunch`, `bootstrapArgs`.
- Data flow: config → `resolveLaunch` → `bootstrapArgs(fs, launch, maxMessageBytes, persistent)` → argv passed to `ctx.subprocess.spawn`.
- Non-obvious design decisions: **A host path is never assumed to name the same remote file**: the source bootstrap is mapped through `fs.processPathFromHostPath(path)` and the mapping *failing* is a hard error ("PTC runtime bootstrap is unavailable in the subprocess execution world"). In source mode the bootstrap is loaded via `--input-type=module --eval` with a generated import of the sibling `process.ts`/`persistent-process.ts` and the subprocess `control.ts` helper, so the unbuilt tree needs no sibling built exports.
- Edge cases / failure handling: `bootstrapPath` must be absolute; the executable must be non-empty; `embedded` + persistent is refused ("Persistent PTC requires a node-script launch").
- Surprising: `resolveLaunch()` picks `'embedded'` when `process.pkg` exists and `'node-script'` otherwise — the packaged-single-executable case is detected from the runtime, not configured.

### packages/ptc-runtime/ptc-runtime-node/src/process.ts
- Purpose: The per-call child entry: handshake, program execution, and channel shutdown.
- Key abstractions: `runNodeMain(stream, maxMessageBytes, processState)`; `ProgramProcess`.
- Data flow: child sends `ready` → host sends `boot` → `runProgram` → child sends `done` → child keeps the channel open until the host closes it.
- Non-obvious design decisions: "Host binding replies can race the terminal frame; **the host owns channel shutdown**" — the child waits for `hostClosed` after flushing its terminal frame, so a reply that arrives late is not lost to a premature close. `terminalSent` is a latch: after the terminal frame the child sends no further program control messages.
- Edge cases / failure handling: A transport failure before the boot frame rejects the boot promise and sets `exitCode = 1`; a malformed first frame rejects with `'expected program boot frame'`.
- Surprising: `processState.exitCode` is left `undefined` on success — the child's exit code is the *host's* observation, and the host's `SubprocessOutcome` is authoritative.

### packages/ptc-runtime/ptc-runtime-node/src/process-entry.ts
- Purpose: The built per-call child entry point.
- Key abstractions: `openInheritedControlChannel()` (from `dsh-subprocess/control`) → `runNodeMain(..., Number(process.argv[2]), process)`.
- Data flow: argv[2] carries the validated control-message limit.
- Non-obvious design decisions: The file is 4 lines and exists only so the published `lib/process.js` bundle has an importable entry; the logic lives in `process.ts`.
- Edge cases / failure handling: n/a — the limit is validated inside `runNodeMain`.
- Surprising: The limit travels as an **argv string** rather than an env var, so it cannot be inherited by a grandchild.

### packages/ptc-runtime/ptc-runtime-node/src/persistent-process-entry.ts
- Purpose: The built retained-REPL child entry point (the `persistent-process.js` sibling bundle).
- Key abstractions: `openInheritedControlChannel()` → `runPersistentMain(..., Number(process.argv[2]), process)`.
- Data flow: Same shape as the per-call entry but selects the REPL implementation.
- Non-obvious design decisions: Deliberately mirrors `process-entry.ts` so the two built bundles differ by exactly one import.
- Edge cases / failure handling: n/a.
- Surprising: n/a — 4-line entry module.

### packages/ptc-runtime/ptc-runtime-node/src/protocol.ts
- Purpose: The JSON message vocabulary carried by the bounded process channel.
- Key abstractions: `ProgramBootData`, `CallMessage`, `LogMessage`, `OutputLimitMessage`, `DoneMessage`, `ReplyMessage`, `ProgramToHost`.
- Data flow: program → host: `call` / `log` / `output-limit` / `done`; host → program: `reply`.
- Non-obvious design decisions: The file's own doc says "The host validates every message because **model code can write directly to the inherited descriptor**" — the protocol is a trust boundary, not an internal API. Logs are **not** carried in the `done` frame: they were "streamed eagerly so output survives a mid-run termination (timeout, abort, OOM)". The `done` frame carries only the completion value or a program-side failure.
- Edge cases / failure handling: The `done` frame may only carry `exception | invalid-output | output-limit` — budget expiry, abort and substrate death are observed **host-side** and are therefore not representable in the frame.
- Surprising: `CallMessage.args` is a *flat* `PtcJsonWire` (the token array), not a nested JSON value — the same bounded-depth trick as the completion value.

### packages/ptc-runtime/ptc-runtime-node/tests/bindings.spec.ts
- Purpose: Pins the binding-namespace validation rules.
- Key abstractions: `validateBindings` from `../src/bindings.ts`.
- Data flow: n/a.
- Non-obvious design decisions: The test asserts that a *null-prototype* functions object with an own `__proto__` member is accepted and preserved by identity — the validator must not normalise the caller's object.
- Edge cases / failure handling: Covers unusable globals (`$name`, empty, `while`, `lambda`, `console`), duplicate globals, invalid error-class names, invalid member names (`''`, `name`, `__member__`) and two injected constructors with the same name.
- Surprising: `functions` is returned by reference (`.get('tools')?.functions` is the same object), not copied — the provider trusts the host's own declaration.

### packages/ptc-runtime/ptc-runtime-node/tests/bootstrap.spec.ts
- Purpose: Exercises the child-side evaluator in-process, with the test playing the *host* side.
- Key abstractions: `FakePort` (a stand-in for the worker `parentPort`), `LogBuffer`, `makeNamespaces`, `prepareCompletion`, `prepareException`, `runProgram`.
- Data flow: The test feeds `boot` data in and reads the `log`/`call`/`done` frames the child posts.
- Non-obvious design decisions: The header comment explains the strategy: "every line of worker-side logic runs under coverage **without spawning an isolate** (real-worker behavior is pinned by runtime.spec.ts)".
- Edge cases / failure handling: Pins the lossy-completion set exactly (`function`, `-0`, `Infinity`, sparse array, cycle, class instance), a getter that throws, a 1 000 000-character thrown string (which becomes `output-limit`, not a giant diagnostic), a host failure reply surfacing as a catchable `ToolCallError`, a materialised consumer-declared error class, a stray reply for an unknown id being ignored, and a `postMessage` clone failure not leaking the pending entry.
- Surprising: `LogBuffer`'s exact-fit case is pinned: a 6-byte budget accepts `'12'` and then *drops* `'no-prefix-fits'` entirely rather than emitting a partial word.

### packages/ptc-runtime/ptc-runtime-node/tests/built-lib.e2e.ts
- Purpose: A keyless built-artifact smoke test — plain Node imports the package by name through its exports map.
- Key abstractions: `describe.skipIf(!built)` — the whole suite is skipped when `lib/` is absent, and CI runs it after the build.
- Data flow: A generated script boots a Context with the local providers and runs one program with a binding.
- Non-obvious design decisions: "Unit tests use `src/process.ts`; this pins the **downstream `lib/index.js` path**" — the built artifact is a separate delivery surface with its own test.
- Edge cases / failure handling: The script asserts a typed binding rejection (`error instanceof ToolCallError`, `error.toolName === 'fail'`) survives the built path.
- Surprising: The package is imported **by name** (`@deepseek-ai/dsh-ptc-runtime-node`) rather than by relative path, so the test also exercises the `exports` map.

### packages/ptc-runtime/ptc-runtime-node/tests/channel.spec.ts
- Purpose: Pins the framing, bounding and failure classification of the process channel.
- Key abstractions: `JsonChannel` over a `duplexPair`-style PassThrough pair.
- Data flow: Byte-at-a-time writes are reassembled into a frame.
- Non-obvious design decisions: The test writes a frame **one byte at a time** to prove the header and payload reassembly across distinct stream deliveries; and it checks that a receiver which throws a *non-Error* value still produces a single structured failure.
- Edge cases / failure handling: Declared length 0 and 65 (over the 64-byte cap) are refused before the body is accepted; malformed JSON, invalid UTF-8 and a throwing receiver are all contained; a write larger than the cap is refused before it reaches the transport; a blocked write is settled by `error` and by `close`.
- Surprising: One test closes the channel from a `prependOnceListener` *during* an emission and asserts the failure callback is never invoked — the channel must not report a failure for a close it caused itself.

### packages/ptc-runtime/ptc-runtime-node/tests/execution-mode.spec.ts
- Purpose: Pins the `per-call` vs `persistent-in-memory` switch, including the state consequences.
- Key abstractions: `runtime.programFormat` (`'function-body'` vs `'repl'`), `NodeRuntime.Config` (schemastery).
- Data flow: Config → provider → `resolve`/`run`.
- Non-obvious design decisions: "clears retained state when a provider is **reloaded** with another execution mode" — the test mounts persistent, runs, disposes the fiber, mounts per-call, and asserts `typeof retained === 'undefined'`, then remounts persistent and asserts the state is *still* gone. A mode change is a provider reload, and the reload visibly drops the state.
- Edge cases / failure handling: Unsupported mode strings (`in-memory`, `durable`, `fresh-process`, `persistent-repl`) are rejected at *configuration parsing*, so a typo never reaches the provider.
- Surprising: The test also pins that an omitted `cwd` resolves to the configured workspace root in **both** modes.

### packages/ptc-runtime/ptc-runtime-node/tests/host-failures.spec.ts
- Purpose: The largest host-failure matrix: config rejection, sandbox classification, protocol failures, cancellation races, output limits, environment scrubbing.
- Key abstractions: A `Duplex` pair standing in for the control channel, a mocked `ctx.subprocess.spawn`, and `JsonChannel` as the peer.
- Data flow: The test drives the real `NodePtcRuntime` and plays the child over the wire.
- Non-obvious design decisions: The test is written as a *counterexample ledger*: each `it` names a specific way the host must fail (config, sandbox unavailable, denial dialect, fatal sandbox output, unmappable bootstrap, missing control pipe, missing executable, pre-aborted run, null deadline, cancellation racing lookup, cancellation racing confinement, early EOF, transport loss, invalid UTF-8, pre-readiness traffic, nine malformed frames, repeated call id, pending-call overflow, untransferable completion, late reply after settle, failed cleanup, undersized frame budget, oversized reply, retained logs, incomplete output, fragmented UTF-8, overflow prefix, broken pipe, retained stderr, runner-evidence classification, environment scrubbing, embedded launch).
- Edge cases / failure handling: The **denial dialect** test is precise: `'EACCES: blocked'` counts as a denial, `'EPERM: unrelated dialect'` does not — the signature list is per-backend and the test pins that only the selected dialect matches. A spawn failure is attributed to the sandbox **only with runner evidence** (`code: 'ENOENT'`, `path` equal to the runner) — otherwise it is `worker-exit`.
- Surprising: The environment test asserts `DSH_TEST_RUNTIME_SECRET` is **present as a key with value `undefined`** rather than absent — the child inherits the key so the native loader does not misbehave, but the program-visible value is empty.

### packages/ptc-runtime/ptc-runtime-node/tests/json-wire.spec.ts
- Purpose: Pins the lossless-JSON boundary against the canonical `snapshotJsonValue` and against an adversarial container zoo.
- Key abstractions: `snapshotPtcJsonValue`, `encodePtcJsonWire`, `decodePtcJsonWire`; `runInNewContext` for the foreign-realm case.
- Data flow: value → snapshot → wire → value.
- Non-obvious design decisions: The wire's *own* nesting is bounded, so the test asserts `wire` has length 5 001 for a 5 000-deep array (one token per level) and then walks it back. The test also asserts the boundary **matches the canonical one** (`snapshotJsonValue`) for every supported and unsupported value, so the dependency-free copy cannot drift from the workspace implementation.
- Edge cases / failure handling: The adversarial list includes `Map`, array subclass, `Array(1)` hole, compensated-sparse, symbol-decorated, hidden own property, custom prototype, forged array prototype, spoofed `Object` prototype, **revoked** proxy prototype, spoofed `Array` prototype, cycle, `[undefined]`, `{value: undefined}`. A getter that mutates the validated length is rejected; a throwing getter propagates and releases the recursion guard.
- Surprising: A literal `__proto__` own key survives the round trip as an own property (`Object.hasOwn(decoded, '__proto__')` is true) instead of being reinterpreted as the prototype.

### packages/ptc-runtime/ptc-runtime-node/tests/launch.spec.ts
- Purpose: Pins launch selection and bootstrap mapping, including the remote cases.
- Key abstractions: `resolveLaunch`, `bootstrapArgs`; a `fs` double whose `processPathFromHostPath` returns `undefined` or throws.
- Data flow: config → argv.
- Non-obvious design decisions: "uses an explicit installed bootstrap **without pretending it maps the host file**" — an explicit `bootstrapPath` is used verbatim and the mapping is never consulted. The `noMapping` double *throws* to prove the mapping is not called at all in that path.
- Edge cases / failure handling: The unmapped source bootstrap throws `'unavailable in the subprocess execution world'`; `embedded` + persistent throws `'requires a node-script launch'`.
- Surprising: The test flips `process.pkg` to prove `resolveLaunch()` returns `embedded` in a packaged host and `node-script` otherwise, and that an *explicit* remote script choice survives the packaged host unchanged.

### packages/ptc-runtime/ptc-runtime-node/tests/output-json.spec.ts
- Purpose: Pins the exact byte accounting against `JSON.stringify`'s own byte length.
- Key abstractions: `jsonStringBytesUpTo`, `jsonValueBytesUpTo`, `truncateJsonStringBytes`.
- Data flow: n/a (pure functions).
- Non-obvious design decisions: The test **mocks `JSON.stringify` to throw** to prove the measurer never materialises the escaped form. It then mutates eight intrinsics (`Array.isArray`, `Array.prototype.pop`, `Array.prototype.push`, `Buffer.byteLength`, `Object.keys`, `String.prototype.charCodeAt`, `codePointAt`, `slice`) and asserts the measurement is unchanged.
- Edge cases / failure handling: The escape set is pinned exactly (`"`, `\`, `\b\t\n\f\r`, `\u0000`, an astral emoji, a lone surrogate, `€`).
- Surprising: The mutation test is the one that justifies the whole captured-intrinsic design: without it, a model-written program in the same realm could make the *harness's* output accounting lie.

### packages/ptc-runtime/ptc-runtime-node/tests/output-ledger.spec.ts
- Purpose: Pins the combined output ledger's accounting and its overflow behaviour.
- Key abstractions: `OutputLedger`.
- Data flow: n/a.
- Non-obvious design decisions: The overflow test asserts the *total* of `JSON.stringify(logs)` + `JSON.stringify(error.message)` is within the cap, at four different budgets — i.e. the budget is on the serialised result, not on the sum of parts.
- Edge cases / failure handling: A 100-character failure message in an 80-byte ledger becomes `output-limit` rather than being truncated into a misleading diagnostic.
- Surprising: A failing diagnostic that does not fit is *replaced* by the overflow message — the specific reason is dropped rather than mangled.

### packages/ptc-runtime/ptc-runtime-node/tests/output-stream.spec.ts
- Purpose: Pins the bounded drain semantics.
- Key abstractions: `drainOutput(stream, graceMs)`.
- Data flow: n/a.
- Non-obvious design decisions: A stream that is already ended returns `true` immediately; a destroyed stream returns `false` — the two are distinguished even though both are "not draining".
- Edge cases / failure handling: A retained descriptor is bounded by the grace timer and reported as incomplete; `close` and `error` both report incomplete.
- Surprising: The test uses fake timers to advance past the grace window, so the bound is proven rather than assumed.

### packages/ptc-runtime/ptc-runtime-node/tests/persistent-built.e2e.ts
- Purpose: The built-artifact smoke test for the retained mode.
- Key abstractions: `describe.skipIf(!built)` over `lib/index.js` + `lib/persistent-process.js`.
- Data flow: A generated script boots the provider in `persistent-in-memory` mode and runs two evaluations plus a release.
- Non-obvious design decisions: The test asserts the **release** semantics end-to-end: after `release(stateOwner)`, `typeof count` is `'undefined'` — the built path drops the state exactly like the source path.
- Edge cases / failure handling: The execa call asserts `timedOut === false`, `signal === undefined` and `exitCode === 0`, so a hang is distinguished from a failure.
- Surprising: The retained program uses `await import("node:path")` and then a *later* evaluation calls `path.basename(...)` — the import survives across evaluations in the built path too.

### packages/ptc-runtime/ptc-runtime-node/tests/persistent-host.spec.ts
- Purpose: The host-side failure matrix for the retained mode: policy changes, protocol violations, cleanup barriers, idle crashes.
- Key abstractions: A `Duplex` pair as the control channel, `mountRuntime` in `persistent-in-memory` mode, a mocked `spawn`.
- Data flow: The test plays the child over the wire using `frame(payload, id)` envelopes.
- Non-obvious design decisions: Three policy-change cases are pinned separately: (a) a mode change **before process launch cancels admission** (both modes), (b) an approved *wider* one-shot policy is **kept** when the standing mode is unchanged, (c) a mode change back during earlier cleanup still cancels — "Restoring the previous mode does not revive a canceled call."
- Edge cases / failure handling: The cleanup barrier is the interesting one: after an idle crash the owner cannot be reused (`'cleanup is incomplete'`), and `release(owner)` is *blocked* until the observation succeeds — the disposal is joined, not abandoned. A failed cleanup is retried on the next release.
- Surprising: A `done` frame that overflows the ledger produces `output-limit` **and** the message says "retained variables were cleared" — the ledger overflow destroys the environment rather than merely truncating the result.

### packages/ptc-runtime/ptc-runtime-node/tests/persistent-process.spec.ts
- Purpose: Exercises the child-side REPL over an in-memory channel.
- Key abstractions: `runPersistentMain(child, limit, state)`; `PersistentProcess` with a fake `chdir` and fake streams.
- Data flow: The test sends `run` frames and reads the child's `log`/`call`/`done` payloads.
- Non-obvious design decisions: A test asserts the injected `process` is **local to the REPL**: `globalThis.process` is the host's own process before, during and after the run, and `Object.keys(process.env)` inside the REPL is `[]` — the real global is never touched.
- Edge cases / failure handling: A `chdir` that throws is contained as an `exception` in the active evaluation; output overflow is reported as `output-limit`; an invalid control limit (0, 1.5, 2^32) is rejected up front; a completed evaluation's tool call is refused with `'evaluation has ended'`.
- Surprising: The leading-brace test pins the `;`-prefix hack: `{ const local = await ...; count += local; }` runs twice and `count` accumulates to 4, while `typeof local` outside the block is `'undefined'`.

### packages/ptc-runtime/ptc-runtime-node/tests/persistent-sandbox.spec.ts
- Purpose: Pins the retained mode's file-policy behaviour against a real local sandbox.
- Key abstractions: `mountRuntime` with a real `dsh-sandbox-local` provider; `setSandboxMode(session, mode)`.
- Data flow: Session policy → `PolicyProcesses` invalidation → the retained kernel is disposed → the next evaluation runs under the new mode.
- Non-obvious design decisions: The one-shot escalation test is the clearest statement of the isolation model: an approved `danger-full-access` run sees **no** retained variables (`typeof retained === 'undefined'`) and its own declarations do not survive, while the standing environment keeps `retained === 7` and stays `read-only`.
- Edge cases / failure handling: Confinement that is unavailable fails **closed** — `sandbox-unavailable` and *no* Node process is spawned. A policy change during a pending confinement cancels the run before spawn.
- Surprising: After `setSandboxMode(session, 'read-only')` the *retained* variables are gone (`typeof retained === 'undefined'`) — a mode change destroys the environment, not just the authority.

### packages/ptc-runtime/ptc-runtime-node/tests/persistent.spec.ts
- Purpose: The behavioural spec of the retained REPL: what survives, what does not, and what errors.
- Key abstractions: `runtime.release(owner)`, `stateOwner` object identity, per-evaluation `bindings`.
- Data flow: Evaluation → `run` frame → child REPL → `done` frame.
- Non-obvious design decisions: The retained-mode contract is pinned in full: declarations, closures, **object identity** (`box === alias`) and imported modules survive; an implicit global (`implicitValue = 7`) survives; a *saved tool method* (`const saved = tools.value`) calls the **current** evaluation's binding (`'old'` then `'new'`); a completed evaluation's callback exception is not attributed to a later evaluation; a callback that calls a tool after its evaluation ended is refused with `'evaluation has ended'`.
- Edge cases / failure handling: Mutations before an exception are **kept** (`count` is 1 after `count++; throw`); a syntax error and an invalid-output error do not destroy the environment; a timeout **does** (`typeof retained === 'undefined'`); `process.exit(7)` yields `worker-exit` and the next run starts a *fresh* process.
- Surprising: Redeclaring an existing `let`/`const`/`class` is a Node REPL rule the provider inherits rather than suppresses — the README documents it as a model-facing constraint.

### packages/ptc-runtime/ptc-runtime-node/tests/policy-processes.spec.ts
- Purpose: Pins the policy-invalidation bookkeeping in isolation.
- Key abstractions: `PolicyProcesses.register` / `wait`; `session/event` with `sandbox/mode`.
- Data flow: `setSandboxMode` → session event → invalidation → `wait`.
- Non-obvious design decisions: "starts cleanup **without another execution**" — the mode change alone triggers the release, and the *next* `wait()` is what blocks. A failed cleanup rejects the `wait` and is **retried** on the next call, and the committed policy is not reverted.
- Edge cases / failure handling: A process registered under a *temporary wider* policy is not invalidated by a change of the standing mode ("uses the standing policy for a temporary escalation"); a detached registration is ignored.
- Surprising: `wait(undefined)` is a legal call that waits for nothing — the session id is optional and an undefined one matches no session-scoped process.

### packages/ptc-runtime/ptc-runtime-node/tests/process-main.spec.ts
- Purpose: Pins the per-call child's handshake, environment clearing and shutdown.
- Key abstractions: `runNodeMain(child, limit, processState)`.
- Data flow: `ready` → `boot` → program → `done` → the child waits for the host to close.
- Non-obvious design decisions: The child **keeps the control pipe open after the terminal frame** so a late binding reply is not lost; the test asserts `child.destroyed === false` and that a late reply produces no additional frames.
- Edge cases / failure handling: The child's `env` becomes `{}` with a **null prototype**, and the *native* environment object is left untouched (`SystemRoot`, `PATH`, `TMP`, `TEMP` still present) — the scrub replaces the program-visible view, it does not mutate the process's own environment table.
- Surprising: A malformed host frame *after* the terminal frame still sets `exitCode = 1`, even though the program succeeded — a corrupt channel is a failure of the run, not of the program.

### packages/ptc-runtime/ptc-runtime-node/tests/process.spec.ts
- Purpose: Boots the **unbuilt source closure** outside the workspace and exchanges a real tool reply over a real inherited descriptor.
- Key abstractions: Copies `process.ts`, `bootstrap.ts`, `channel.ts`, `json-wire.ts`, `output-json.ts`, `protocol.ts`, `environment.ts` into a temp dir and runs them with `--input-type=module --eval`.
- Data flow: A `Socket({fd: 7})` is the control channel; the test's `JsonChannel` plays the host.
- Non-obvious design decisions: The file list is the *exact* dependency closure of the source bootstrap — this test is what proves the bootstrap has no sibling built exports. The child is spawned with `stdio[7] = 'overlapped'` (the Windows inherited-descriptor mode).
- Edge cases / failure handling: The child's env is `PLACEHOLDER_SECRET: 'fixture-only'` and the program asserts `process.env` is `{}` inside.
- Surprising: The source closure is executed *outside the workspace* precisely so the test cannot accidentally pick up a built `lib/` sibling.

### packages/ptc-runtime/ptc-runtime-node/tests/runtime.spec.ts
- Purpose: End-to-end behaviour of the per-call mode against a real Node process and a real local sandbox.
- Key abstractions: `mountRuntime`; a `sandboxUsable` probe run once at module load so an unavailable backend skips only the enforcement tests.
- Data flow: Real spawn → real child → real control channel.
- Non-obvious design decisions: The sandbox probe is done **independently** of the runtime ("so Node-runtime launch failures cannot skip enforcement tests") — a probe failure must not be able to hide a confinement regression.
- Edge cases / failure handling: Pinned: erasable TypeScript runs with an empty `process.env`; a nested `spawnSync(process.execPath)` still works and sees only the six native paths; a program failure and a TypeScript `enum` both yield `exception`; lossy output yields `invalid-output`; the combined output cap holds; the deadline ends `for(;;){}` and `await new Promise(()=>{})`; console output emitted *immediately before* a non-yielding loop is retained; the deadline is **not** paused while a binding is pending; a still-running descendant is closed before the result returns; the V8 heap ceiling is exactly honoured (`heap_size_limit` differs by 32 MiB); a disposed provider aborts the active program and rejects later calls; hostile control traffic written to fd 7 is a `protocol` failure.
- Surprising: On Windows the test asserts the sandbox's *private* temp directory (`<temp>\dsh-…`) is used by the native child while the *parent's* `TEMP`/`TMP` are used only for the shared ACL grant lock — a two-temperature scheme that makes a native grant-lock file work under a per-run ACL.

### packages/ptc-runtime/ptc-runtime-node/tests/setup.ts
- Purpose: The shared test harness: mounts the local providers and the Node PTC runtime into a fresh Context.
- Key abstractions: `mountRuntime(ctx, config, policy)`.
- Data flow: `SessionStore`, `fs-local`, `subprocess-local`, `sandbox-local`, `session-projection`, `sandbox-policy`, then `NodeRuntime`.
- Non-obvious design decisions: Each service is mounted only `if (!ctx.get(...))` so a test can pre-mount a spy. The default policy mode is `danger-full-access` — confinement tests opt in explicitly.
- Edge cases / failure handling: `onTestFinished` disposes the fiber.
- Surprising: The harness mounts the *real* local sandbox, so the sandbox tests are genuine end-to-end tests rather than mocks.

### packages/ptc-runtime/ptc-runtime-node/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-ptc-runtime-node`.
- Key abstractions: exports `.` and `./process` (the built child bundle) plus `./locale/*.json`.
- Data flow: peer-depends on `cordis`, `dsh-ptc-runtime`, `dsh-session`, `dsh-timeout`, `dsh-fs`, `dsh-subprocess`, `dsh-sandbox`, `dsh-sandbox-policy`.
- Non-obvious design decisions: `files` ships `lib/index.js`, `lib/process.js`, `lib/persistent-process.js` and the `.d.ts` tree — the two child bundles are *published artifacts* because a remote host must be able to run them.
- Edge cases / failure handling: n/a.
- Surprising: `dsh-sandbox-policy` is a **peer** dependency, so the provider cannot bring its own policy — the deployment owns the file-effect mode.

### packages/ptc-runtime/ptc-runtime-node/tsconfig.json
- Purpose: Project reference for the Node backend; `rootDir: src`, `outDir: lib/types`.
- Key abstractions: References the session, timeout, fs, subprocess, sandbox, sandbox-policy and ptc-runtime projects.
- Data flow: n/a.
- Non-obvious design decisions: `dsh-session` and `dsh-sandbox-policy` are referenced so the provider's `SessionId` / `SandboxPolicy` types stay in step with their owners.
- Edge cases / failure handling: n/a.
- Surprising: n/a — configuration only.

### packages/ptc-runtime/ptc-runtime-node/tsdown.config.ts
- Purpose: The bundle configuration: three separate tsdown entries.
- Key abstractions: `index` (the provider), `process` (the per-call child), `persistent-process` (the REPL child).
- Data flow: `lib/types/*.js` → `lib/*.js`, ESM, node platform, es2024 target, `dts: false`.
- Non-obvious design decisions: The two child bundles carry `noExternal: ['@deepseek-ai/dsh-subprocess/control']` — the inherited-control-channel helper must be **inlined** into the child, because a remote host cannot resolve a workspace package.
- Edge cases / failure handling: `clean: false` so the three bundles can be produced independently.
- Surprising: `dts: false` — the declarations come from `tsc` (`lib/types`), and tsdown only produces the JavaScript.

### packages/ptc-runtime/ptc-runtime-node/locale/en.json
- Purpose: English locale entry for the package's UI metadata.
- Key abstractions: `meta.title = "ptc-runtime-node"`.
- Data flow: Loaded by the package's locale loader via the `./locale/*.json` export.
- Non-obvious design decisions: The English file has **no** `description` key while the Chinese one does — the English description lives in the README frontmatter.
- Edge cases / failure handling: n/a.
- Surprising: A 5-line JSON file is a real published artifact (it is in `files`).

### packages/ptc-runtime/ptc-runtime-node/locale/zh.json
- Purpose: Chinese locale entry.
- Key abstractions: `meta.title`, `meta.description`.
- Data flow: Same loader.
- Non-obvious design decisions: The Chinese title is the translated name (`Node PTC 运行时`), not the package identifier.
- Edge cases / failure handling: n/a.
- Surprising: The zh file has a `description` the en file lacks — a small asymmetry between the two locale files.

### packages/ssh/README.md
- Purpose: Package-group map for the POSIX SSH provider family.
- Key abstractions: `ctx.ssh`, `ctx.fs`, `ctx.subprocess`, `ctx.sandbox` — four services, five packages.
- Data flow: The connection is shared; the other three providers ride it.
- Non-obvious design decisions: The Dev Note's rule is the family's invariant: "**Local path access must never be inferred from a remote path string.**" The family is explicitly POSIX-only ("This family runs files, ordinary processes, terminals and sandbox enforcement on one POSIX SSH host while the Harness stays local").
- Edge cases / failure handling: n/a.
- Surprising: `ssh-helper-runtime` is listed with "Service: —" because it is a *packaging* package, not a service.

### packages/ssh/README.i18n.yaml
- Purpose: Heading-hash record for the SSH group README (5 sections).
- Key abstractions: Section paths mirror the README anchors.
- Data flow: Regenerated by `verify-translation-pairing`.
- Non-obvious design decisions: The Dev Note's invariant is hashed as its own section, so a change to "never infer local path access" is a detectable edit.
- Edge cases / failure handling: n/a.
- Surprising: n/a — generated record.

### packages/ssh/README.zh.md
- Purpose: Chinese mirror of the SSH group README.
- Key abstractions: Same service table.
- Data flow: n/a.
- Non-obvious design decisions: The invariant is stated even more sharply: "绝不能从远端路径字符串推断本地路径访问能力."
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/ssh/fs-ssh/src/index.ts
- Purpose: `ctx.fs` over the SSH helper: remote file identity, reads and guarded atomic mutations.
- Key abstractions: `SshFileSystem extends FileSystem`; `static inject = ['ssh','sandboxPolicy']`; every operation is one `ctx.ssh.request(method, params, schema, signal)`.
- Data flow: local call → `ssh.request` → remote helper → `fs-local` + `fs-sandbox` on the remote host → typed observation.
- Non-obvious design decisions: `processPathFromHostPath` is **not** overridden, so it returns `undefined` — "consumers requiring an installed executable or bootstrap must supply a remote artifact explicitly." `contains()` is implemented with `posix.relative` so a sibling prefix (`/remote/work-other`) is not "inside" `/remote/work`. `processPath()` is the remote canonical path and `fileUrl()` percent-encodes literally.
- Edge cases / failure handling: The error mapping is a whitelist: a remote `FsErrorCode` is preserved; anything else becomes `FS_IO_ERROR`, or `FS_ABORTED` when the caller's signal is aborted. A lost transport is an I/O failure and "a mutation may already have committed and is not retried automatically."
- Surprising: `watch()` is deliberately **not** overridden, so the base class's `FS_IO_ERROR` applies — the README states this rather than emulating a watcher.

### packages/ssh/fs-ssh/README.md
- Purpose: Package reference for the remote filesystem provider.
- Key abstractions: The same `ctx.fs` interface, backed by the remote helper's `fs-local` + `fs-sandbox`.
- Data flow: File tools read and mutate the same files remote Bash, terminals, language servers and Node programs see.
- Non-obvious design decisions: The provider has **no configuration fields** — connection identity belongs to `dsh-ssh` and file-effect mode to `sandboxPolicy`. `processPathFromHostPath()` returning `undefined` is documented as a *feature*: it forces a consumer that needs a remote executable to name one.
- Edge cases / failure handling: Whole-text reads and single byte windows are capped at 8 MiB by the helper; larger reads must use streaming. "Remote file URLs are execution coordinates, not host filesystem handles or Web download links."
- Surprising: The provider contributes **nothing** to the request prefix ("KV Cache effect: This provider contributes no request-prefix content") — an explicit statement that a remote provider is invisible to the model's cache.

### packages/ssh/fs-ssh/README.i18n.yaml
- Purpose: Heading-hash record for the fs-ssh README (9 sections).
- Key abstractions: Section paths mirror the anchors.
- Data flow: Regenerated by the pairing script.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a — generated record.

### packages/ssh/fs-ssh/README.zh.md
- Purpose: Chinese mirror of the fs-ssh README.
- Key abstractions: Same provider contract.
- Data flow: n/a.
- Non-obvious design decisions: The zh text keeps "传输丢失报告 I/O 失败；修改可能已经提交，不会自动重试" — the no-auto-retry rule is stated as a *semantic guarantee*, not a limitation.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/ssh/fs-ssh/tests/provider.spec.ts
- Purpose: Pins the remote filesystem provider against a fake `ctx.ssh`.
- Key abstractions: A `WireConnection` service double that `result.parse`s the dispatch result.
- Data flow: A local call → a `dispatch(method, params, signal)` mock.
- Non-obvious design decisions: The fake connection **parses the response with the real schema**, so a malformed remote observation is caught as a `zod` error before the provider can use it.
- Edge cases / failure handling: Pinned: `watch()` rejects with `FS_IO_ERROR` **without sending a remote request**; literal `%`, `\` and newline in a filename survive `fileUrl()`; a relative path is sent as relative and the *remote* canonical path comes back; `contains()` rejects a sibling prefix; remote `FS_STALE_VERSION` / `FS_SANDBOX_DENIED` / `FS_NOT_OBSERVED` are preserved; an **unrecognised** remote code becomes `FS_IO_ERROR`; a cancelled request becomes `FS_ABORTED` and is **not retried**; a primitive abort reason is preserved as the message.
- Surprising: The streaming test asserts the remote iterator is closed on an early consumer stop, on an abort between pulls, and even on a **malformed pull response** — three different exits, one guarantee.

### packages/ssh/fs-ssh/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-fs-ssh`.
- Key abstractions: peer-depends on `dsh-ssh`, `dsh-fs`, `dsh-sandbox`, `dsh-sandbox-policy`.
- Data flow: `dependencies` on `zod` (pinned `4.4.3`) and `schemastery`.
- Non-obvious design decisions: The zod version is **pinned exactly** (`"zod": "4.4.3"`) rather than a range — the remote wire schemas are a compatibility surface.
- Edge cases / failure handling: n/a.
- Surprising: The package exports `./src/*`, so a workspace consumer can import the source directly.

### packages/ssh/fs-ssh/tsconfig.json
- Purpose: Project reference for fs-ssh; `rootDir: src`, `outDir: lib/types`.
- Key abstractions: References cordis, schemastery, `../ssh`, fs, sandbox, sandbox-policy.
- Data flow: n/a.
- Non-obvious design decisions: The reference on `../ssh` is what types `ctx.ssh` for `ctx.provide`/inject.
- Edge cases / failure handling: n/a.
- Surprising: n/a — configuration only.

### packages/ssh/sandbox-ssh/src/index.ts
- Purpose: `ctx.sandbox` over the SSH helper: resolve a confinement argv on the *remote* host.
- Key abstractions: `SshSandboxProvider extends SandboxProvider`; `static inject = ['ssh']`; a strict `factsSchema` for the remote answer.
- Data flow: `confine(argv, policy, signal)` → `ssh.request('sandbox', {argv, policy}, factsSchema, signal)` → the helper canonicalises the policy root and asks *its own* sandbox provider → the enforcing argv comes back.
- Non-obvious design decisions: Any failure becomes a `SandboxUnavailableError(policy.mode, message)` — "Cancellation or an unavailable backend rejects before the caller receives a command to launch." The schema is `.strict()` and requires a non-empty argv, an `enforcement` of `full|partial`, and structured `runnerFailureRules`.
- Edge cases / failure handling: `signal.throwIfAborted()` is checked both before and after the request, so a cancellation that lands during the remote round trip is not swallowed by the error wrapper.
- Surprising: The provider does **not** implement a local/remote policy flag — the connection "does not invent an additional local/remote policy flag", so the policy that reaches the wire is exactly the policy the caller resolved.

### packages/ssh/sandbox-ssh/README.md
- Purpose: Package reference for the remote sandbox provider.
- Key abstractions: `ctx.sandbox`; the remote host selects its own installed backend.
- Data flow: The remote answer's argv is executed by the SSH subprocess provider; fd 7 transport and the managed process lifetime stay with that provider.
- Non-obvious design decisions: "Bash and Node receive the same backend's enforcement level, denial signatures and runner-failure classification" — the *facts* travel with the argv so the host can classify a failure the same way it would locally.
- Edge cases / failure handling: "File-effect modes do not restrict network access or process visibility. A remote `partial` backend remains partial." And the threat model is stated: "The SSH host and installed helper are **trusted infrastructure**."
- Surprising: The provider contributes nothing to the request prefix — the same explicit statement the whole SSH family makes.

### packages/ssh/sandbox-ssh/README.i18n.yaml
- Purpose: Heading-hash record for the sandbox-ssh README (9 sections).
- Key abstractions: Section paths mirror the anchors.
- Data flow: Regenerated by the pairing script.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a — generated record.

### packages/ssh/sandbox-ssh/README.zh.md
- Purpose: Chinese mirror of the sandbox-ssh README.
- Key abstractions: Same provider contract.
- Data flow: n/a.
- Non-obvious design decisions: The zh "已知限制" section keeps the trusted-infrastructure caveat verbatim in meaning ("属于可信基础设施").
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/ssh/sandbox-ssh/tests/provider.spec.ts
- Purpose: Pins the remote confinement provider.
- Key abstractions: A `Connection` service double; the strict `factsSchema`.
- Data flow: `confine` → `dispatch('sandbox', {argv, policy}, signal)`.
- Non-obvious design decisions: The test asserts the provider **awaits** the remote resolution (the promise is not settled until the remote answers) — the local provider must not synthesise an argv.
- Edge cases / failure handling: Malformed backend observations (null, empty argv, unknown `enforcement`, a non-string `fatalSignatures`) all become `SandboxUnavailableError` **before** any argv is exposed. A remote disconnect (Error or string) is reported as unavailable "without fallback or replay" and is sent exactly once. An already-cancelled request is **not sent at all**; a cancellation during a pending resolution propagates the caller's own reason.
- Surprising: The test checks `dispatch` was called exactly once on every failure path — "without fallback or replay" is asserted by call count, not by prose.

### packages/ssh/sandbox-ssh/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-sandbox-ssh`.
- Key abstractions: peer-depends on `dsh-ssh` and `dsh-sandbox` only.
- Data flow: `dependencies` on `zod` (pinned) and `schemastery`.
- Non-obvious design decisions: It does **not** peer-depend on `dsh-sandbox-policy` — the policy is passed in per call, so the provider does not need the policy service.
- Edge cases / failure handling: n/a.
- Surprising: n/a — a small, single-purpose package.

### packages/ssh/sandbox-ssh/tsconfig.json
- Purpose: Project reference for sandbox-ssh; `rootDir: src`, `outDir: lib/types`.
- Key abstractions: References cordis, schemastery, `../ssh`, sandbox.
- Data flow: n/a.
- Non-obvious design decisions: It references one *fewer* project than fs-ssh (no sandbox-policy) — the reference graph mirrors the runtime dependencies exactly.
- Edge cases / failure handling: n/a.
- Surprising: n/a — configuration only.

### packages/ssh/ssh-helper-runtime/README.md
- Purpose: How to build, verify, install and publish the self-contained SSH helper executable.
- Key abstractions: Four native targets (`node24-linux-x64/arm64`, `node24-macos-x64/arm64`); a `manifest.json` recording commit, dirty flag, embedded Node version, protocol and every payload file's digest and permissions.
- Data flow: `pnpm exec tsx scripts/build-exe-for-ssh-helper.ts` → `dist-exe/ssh-helper/dsh-ssh-helper-<version>-<platform>-<arch>.tar.gz` + `.sha256` → install → configure `dsh-ssh` with `launch: {kind:'executable'}`, the absolute helper path and its SHA-256.
- Non-obvious design decisions: The installation may be **read-only** ("the helper user needs a writable temporary/cache location") and must live outside a backend's replaced temporary tree (bwrap's private `/tmp`) — a concrete deployment trap the README names. The client obtains the embedded PTC invocation through `ctx.ssh.ptcLaunch`, so the *provider* discovers the worker's identity rather than the deployment configuring it.
- Edge cases / failure handling: "Digest verification detects an unexpected installed artifact after helper startup; it does not make writable deployment files safe to execute or authenticate a malicious SSH host." Windows and musl Linux are not build targets.
- Surprising: The release workflow defaults to `publish=false` and, when publishing, requires the matching `dsh-v<version>` tag and "validates complete same-commit evidence from clean builds".

### packages/ssh/ssh-helper-runtime/README.i18n.yaml
- Purpose: Heading-hash record for the helper-runtime README (10 sections).
- Key abstractions: Section paths mirror the anchors.
- Data flow: Regenerated by the pairing script.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a — generated record.

### packages/ssh/ssh-helper-runtime/README.zh.md
- Purpose: Chinese mirror of the helper-runtime README.
- Key abstractions: Same build/verify/publish story.
- Data flow: n/a.
- Non-obvious design decisions: The zh version keeps the same four-target table with the same glibc 2.28 baseline.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/ssh/ssh-helper-runtime/src/index.ts
- Purpose: The single-file dispatcher for the packaged (SEA) helper executable.
- Key abstractions: `runSshHelperRuntime()`; `node:sea`'s `isSea()`; `node:module`'s `registerHooks`.
- Data flow: `DSH_PTC_RUNTIME_NODE === '1'` → `@deepseek-ai/dsh-ptc-runtime-node/process`; else `DSH_SUBPROCESS_RUNNER` → the local subprocess runner; else `@deepseek-ai/dsh-ssh/helper`.
- Non-obvious design decisions: A **module-resolution hook** redirects the platform-specific native package to the co-shipped `native/system/package.json` on disk, because "The operating system executes Landlock outside the SEA virtual filesystem." Both selector env vars are **deleted** before the selected module is imported, so the child cannot re-read them.
- Edge cases / failure handling: `isSea()` false throws ('SSH helper runtime must run from its packaged executable'); `statSync(nativeManifest)` proves the native resources are really present before anything is dispatched.
- Surprising: One binary serves three roles (SSH helper, managed subprocess runner, PTC worker), selected by an env var — the packaged executable is a *multi-call* binary.

### packages/ssh/ssh-helper-runtime/tests/fixtures/driver.ts
- Purpose: The artifact-verification driver: a Loader composition that exercises files, processes, PTY, native flock and PTC through the SSH providers.
- Key abstractions: `boot('ssh-helper-artifact', configPath)`; `ctx.ssh.ready`, `ctx.fs`, `ctx.subprocess`, `ctx.ptcRuntime`.
- Data flow: Files → guarded writes and streams → ordinary processes → cancellation → PTY → PTC → native flock → deadline → optional sandbox lane.
- Non-obvious design decisions: Each check pushes a **named label** onto a `checks` array that is written to a JSON report — the verifier reads a list of check names, not a boolean. The driver asserts that *Loader or provider cleanup reported no errors* in a `finally`, so a clean teardown is itself a checked property.
- Edge cases / failure handling: The `DSH_VERIFY_NO_NODE=1` lane asserts the target host has **no** Node (`command -v node` must fail and `/usr/bin/node` must not exist) — the helper must work without a Node installation. The `required` sandbox lane asserts a *denied* write is reported with `sandbox.denied === true`; the `unavailable` lane asserts confinement is refused.
- Surprising: The native-flock check imports `@deepseek-ai/node-addon-system/flock` **inside the PTC program** — the packaged native addon is exercised through the model's own program, not through the harness.

### packages/ssh/ssh-helper-runtime/tests/fixtures/direct-helper.ts
- Purpose: A Loader-mounted fixture that talks to a **real** helper executable over local sockets instead of over SSH.
- Key abstractions: `DirectHelper extends Service` registered as `ctx.ssh`; `SshRpcPeer` over the child's stdout/stdin.
- Data flow: `spawn(executable)` → `rpc.request('hello', ...)` → `connectStream(endpoint)` → `authenticateStream`.
- Non-obvious design decisions: Only the *administrative transport* differs from `SshConnection` — the fixture reuses the production `SshRpcPeer`, the production `helloSchema` and the production `authenticateStream`, so it tests the helper without needing an SSH server. The child's env carries `DSH_ARTIFACT_SECRET: 'must-not-reach-program'` as a canary.
- Edge cases / failure handling: A 90-second watchdog `SIGKILL`s the child; the handshake asserts `hello.hash === config.helperHash` and `hello.executable === config.executable`; a non-zero exit rejects with the bounded stderr tail.
- Surprising: `ptcLaunch` returns `{kind:'embedded', executable}` — the fixture publishes the same PTC launch contract the real connection does, so the driver does not branch.

### packages/ssh/ssh-helper-runtime/tests/fixtures/sshd/Dockerfile
- Purpose: A glibc-2.28 SSH server image with no Node and no checkout, for the portability lane.
- Key abstractions: `FROM almallinux:8.10` (AlmaLinux 8.10 is glibc 2.28).
- Data flow: Installs `openssh-server`, creates the `dsh` user, removes the pre-generated host keys, copies `sshd_config` and `start.sh`.
- Non-obvious design decisions: The image comment states the point: "glibc 2.28 target without Node or a checkout; only the release payload is mounted at runtime." The host keys are deleted so `start.sh` generates fresh ones per run.
- Edge cases / failure handling: n/a.
- Surprising: The portability lane is built on **AlmaLinux 8.10** precisely because it is the oldest glibc the helper claims to support.

### packages/ssh/ssh-helper-runtime/tests/fixtures/sshd/sshd_config
- Purpose: The SSH server configuration for the portability lane.
- Key abstractions: `Port 22`, `AuthenticationMethods publickey`, `AllowUsers dsh`.
- Data flow: Read by `sshd -f /etc/ssh/sshd_config`.
- Non-obvious design decisions: `PasswordAuthentication no` + `KbdInteractiveAuthentication no` + `PermitRootLogin no` + `UsePAM no` — a key-only, PAM-free server, so the lane tests the *real* connection with no interactive escape hatch. `AllowStreamLocalForwarding yes` is what makes the forwarded Unix sockets possible.
- Edge cases / failure handling: `LogLevel VERBOSE` so a connection failure is diagnosable from the server log.
- Surprising: `AllowTcpForwarding yes` and `AllowStreamLocalForwarding yes` are both required — the design forwards Unix sockets, not TCP, but the TCP flag is needed for the SSH master control channel.

### packages/ssh/ssh-helper-runtime/tests/fixtures/sshd/start.sh
- Purpose: The container entrypoint: generate a host key, install the disposable public key, start `sshd` in the foreground.
- Key abstractions: `ssh-keygen -q -t ed25519 -N ''`, `install -m 600 -o dsh -g dsh /fixture-key.pub …/authorized_keys`.
- Data flow: Executed as the container's `ENTRYPOINT` (`/bin/sh /start.sh`).
- Non-obvious design decisions: The host key is generated **inside** the container per run, and the authorised key is the single mounted `/fixture-key.pub` — "Test identities, host keys, ports and workspaces are private to the run."
- Edge cases / failure handling: `set -eu` makes any failure abort the container; `exec /usr/sbin/sshd -D -e` runs it in the foreground so the container's lifetime *is* the server's lifetime.
- Surprising: The workspace directory (`/home/dsh/workspace`) is created with mode 700 and owned by `dsh` — the remote workspace is prepared by the server image, not by the test.

### packages/ssh/ssh-helper-runtime/tsconfig.json
- Purpose: Project reference for the helper-runtime package; `rootDir: src`, `outDir: lib/types`.
- Key abstractions: References cordis, `../ssh`, `subprocess-local`, `ptc-runtime-node`.
- Data flow: n/a.
- Non-obvious design decisions: The references are exactly the four modules the SEA dispatcher can import.
- Edge cases / failure handling: n/a.
- Surprising: n/a — configuration only.

### packages/ssh/ssh-helper-runtime/package.json
- Purpose: The **private** npm manifest for the helper runtime (`"private": true`).
- Key abstractions: `dependencies` list every workspace package the SEA binary embeds (~30 entries, from `dsh-agent` to `dsh-win32-process`).
- Data flow: The dependency list *is* the embedded payload spec — `pkg --sea` bundles exactly these.
- Non-obvious design decisions: The package is private and not published, but its `dependencies` are the authoritative list of what the remote helper contains. `@deepseek-ai/node-addon-system` is a `workspace:~` dependency, which the SEA resolver hook redirects to the co-shipped native directory.
- Edge cases / failure handling: n/a.
- Surprising: The dependency list includes `dsh-agent`, `dsh-llm`, `dsh-system-prompt` and `dsh-skill` — the helper binary embeds far more than the helper needs, because `pkg --sea` bundles the closed dependency set of the whole harness.

### packages/ssh/ssh/src/index.ts
- Purpose: The OpenSSH connection owner: launch the remote helper, verify its identity, carry the administrative RPC, and forward streams.
- Key abstractions: `SshConnection extends Service` registered as `ctx.ssh`; `Config` (host, launch, helper, helperHash, workspace, limits); `HelperLaunch`.
- Data flow: `mkdtemp('/tmp/dsh-ssh-')` → `spawn('ssh', [-T -M -S <control> … host, command])` → `SshRpcPeer` over the child's stdout/stdin → `hello` handshake → digest/kind/bootstrap checks → heartbeat interval → per-stream `ssh -O forward` + local socket + TLS-PSK.
- Non-obvious design decisions: The SSH argv is a **hardened, non-interactive** profile: `BatchMode=yes`, `StrictHostKeyChecking=yes`, `ForwardAgent=no`, `ClearAllForwardings=yes`, `ControlPersist=no`, `ServerAliveInterval=10`, `ServerAliveCountMax=3`. Remote paths are shell-quoted with a `'`-escaping helper, so a helper path containing a quote is safe. The helper's digest, its *runtime kind* and the PTC bootstrap digest are all checked **before readiness**; `Service.init` awaits `ready`, so the plugin is not usable until the identity is verified. A remote stream path must start with the helper's own root and contain no `:\r\n\0`.
- Edge cases / failure handling: The heartbeat runs at `leaseMs/3` with a `leaseMs/2` timeout and a single in-flight guard; a failed heartbeat fails the whole connection. Disposal joins the forwarding and cancellation subprocesses, the partially established streams and the local directory before removing it. `controlCommand` escalates to `SIGKILL` if the `ssh -O` command outlives its cancellation. `child.stderr.resume()` with the comment "SSH diagnostics can contain configured paths; operation errors remain structured."
- Surprising: The connection **disables the helper's SIGUSR1 debugger activation** — `--disable-sigusr1` for a script launch, `NODE_OPTIONS='--disable-sigusr1'` for an executable — because a same-user process could otherwise attach a Node inspector to the helper.

### packages/ssh/ssh/src/protocol.ts
- Purpose: The bounded, versioned request/response protocol between the SSH client and the remote helper.
- Key abstractions: `SshRpcPeer` (an `EventEmitter` owning pending calls); `SSH_PROTOCOL_VERSION = 2`; `SSH_MAX_PROCESS_HANDLES = 128`; `SSH_MAX_TEXT_STREAMS = 128`; `RemoteOperationError`.
- Data flow: `request(method, params, schema, signal)` → a framed `request` → the peer dispatches to a handler → `result`/`error` frame → `schema.parse` before the caller sees it.
- Non-obvious design decisions: **Request classes with reserved capacity**: `heartbeat: 1`, `close: 1`, `process.terminate: 128`, `fs.streamClose: 128` are counted against their own budgets, separate from `maxPending` ordinary requests — so ordinary load can never starve health checks or cleanup. Cancellation **keeps the capacity credit** until the remote handler replies ("cancellation does not mean its resource cleanup has finished"), while the caller's promise rejects immediately. The rejection text is `'SSH operation cancelled; a completed remote mutation is not rolled back'`. A late reply for an unknown id is ignored (it may have been cancelled).
- Edge cases / failure handling: Frames are length-prefixed and bounded on both sides; an incoming length of 0 or `> maxFrameBytes` throws before the payload is allocated. A mid-frame disconnect is reported distinctly ("disconnected **during** a frame; outcome is unknown"). An inbound request that is unexpected, duplicated or above quota throws. A non-string native error `code` is dropped rather than sent.
- Surprising: The peer is **symmetric** — the same class is the client and the server, and the helper uses it with a handler to serve requests. That is why `RemoteProcesses` can use a second `SshRpcPeer` over a *data* stream to push output snapshots.

### packages/ssh/ssh/src/helper.ts
- Purpose: The remote helper: serves the administrative RPC by delegating to the *local* providers installed beside it.
- Key abstractions: `runSshHelper(transport)`; `HelperTransport` (input, output, entryPath, kind, signal); a private `Context` mounting `SessionProjectionRegistry`, `SandboxPolicyService`, `SandboxedFileSystem`, `LocalSubprocessRuntime`, `LocalSandboxProvider`.
- Data flow: RPC method → the corresponding local provider call → a typed observation back over the wire.
- Non-obvious design decisions: The helper reuses the **local** filesystem, sandbox and subprocess providers rather than reimplementing them, so remote semantics are identical to local ones ("Remote canonicalization, version guards and atomic mutations use the local filesystem implementations installed beside the helper"). A **lease** is touched on every request and expires the connection if the client goes silent. `hello` is a one-shot: a second handshake throws ('SSH helper handshake already completed'). The workspace is canonicalised on the *remote* side (`ctx.fs.resolve(input.workspace)`) and the canonical path is what the client is told.
- Edge cases / failure handling: After the handshake, "SSH helper is not accepting operations" is returned for every method while closing. Whole-text reads are capped at 8 MiB and fail with `FS_TOO_LARGE` pointing at streaming. Text iterators are bounded (`SSH_MAX_TEXT_STREAMS`) and the limit is checked **twice** — before and after the allocation — so an overlapping pair cannot both slip in.
- Surprising: The helper's own root is a fresh `mkdtemp('/tmp/dsh-ssh-')` and every socket directory lives under it; the client is told the root so it can validate the paths the helper hands back.

### packages/ssh/ssh/src/helper-processes.ts
- Purpose: Remote process ownership: reservations, authenticated stream endpoints, native launch, terminal control, and cleanup.
- Key abstractions: `RemoteProcesses`; `ProcessRecord` (request, directory, endpoints, controller, expiry); `Endpoint` (TLS server, capability, connected promise); `CollectedOutputForwarder`.
- Data flow: `prepare` → per-channel TLS endpoints (0600 sockets in a 0700 directory) → the client connects and authenticates → `start` → spawn the local provider → pipe stdout/stderr/stdin/control → `done` → `rememberCompleted` → the directory is removed.
- Non-obvious design decisions: **Prepare-then-start**: no target code executes until every data channel is authenticated (`await Promise.all(Object.values(record.endpoints).map(e => e.connected))`). Each endpoint gets a random 32-byte capability used as a TLS-PSK; the listener accepts exactly one client (`if (endpoint.socket !== undefined) { socket.destroy(); return }`) and closes after it. An unused reservation **expires** on a timer (`preparationMs`) so a client that prepared and vanished does not hold a slot. The completed-result map keeps the *original rejection* for late `done` reads and is bounded at `limit * 4`.
- Edge cases / failure handling: A launch failure records the failure as the completion and then releases the reservation, so a later `done` returns the same error. A native cleanup failure throws an `AggregateError('SSH remote process cleanup failed')`. `terminate()` is idempotent and returns early for an already-completed id. The control channel is bidirectional (`socket.pipe(channel).pipe(socket)`) and either side's error destroys the other.
- Surprising: `CollectedOutputForwarder` **coalesces** live tail updates: the collector keeps capturing while a snapshot request is outstanding, and the final snapshot is published with whole-stream byte coordinates so transport lag cannot change the completed observation.

### packages/ssh/ssh/src/stream-security.ts
- Purpose: TLS-PSK authentication for the forwarded streams.
- Key abstractions: `SSH_STREAM_TLS_OPTIONS`; `authenticateStream(socket, capability, timeoutMs, signal)`.
- Data flow: raw socket → `tls.connect({socket, pskCallback})` → `secureConnect` → a **paused** TLSSocket.
- Non-obvious design decisions: The cipher is pinned to `PSK-AES256-GCM-SHA384` with `TLSv1.2` min **and** max — "no unauthenticated cipher fallback." `checkServerIdentity` is a no-op because "PSK proves peer identity without an X.509 certificate or hostname." The key is used as the PSK and is **never transmitted as data**.
- Edge cases / failure handling: The handshake has its own deadline ("SSH stream authentication timed out") and destroys the socket on failure. Cancellation destroys the TLS stream (and through it the underlying socket) — the test proves the raw socket is destroyed too.
- Surprising: The returned socket is **paused** ("attach a consumer before resuming it"), so a caller cannot lose bytes by attaching a reader late.

### packages/ssh/ssh/src/schemas.ts
- Purpose: The strict zod schemas for every SSH request and remote observation.
- Key abstractions: `processIdSchema` / `textStreamIdSchema` (branded UUIDs); `remotePath`; `policySchema`; `spawnSchema`; `helloSchema`; `outputSnapshotSchema`; `doneSchema`; `terminalActivitySchema`.
- Key abstractions (2): `outputSnapshotFrameLimit(maxBytes)` derives the private snapshot frame cap from the collector's byte budget.
- Data flow: Both sides parse with the same schema, so a schema change is a protocol change.
- Non-obvious design decisions: `remotePath` is "a remote POSIX absolute path; **spelling is preserved until remote canonicalization**" — the client does not normalise, the host does. `spawnSchema.refine` enforces "select ordinary or terminal execution" (exactly one of `stdio` / `terminal`). `environmentSchema` maps `string | null`, where **null is an environment tombstone** (remove the variable) rather than an empty string.
- Edge cases / failure handling: `helloSchema` requires the protocol literal, a 64-hex digest, `platform: 'linux'|'darwin'` and absolute paths; `runnerFailureRules` entries are `.strict()`.
- Surprising: `SshProcessId` and `SshTextStreamId` are *branded* types over the same UUID wire value, and the type-level test asserts they are not interchangeable even though the runtime values are identical.

### packages/ssh/ssh/src/helper-entry.ts
- Purpose: The OpenSSH-side process entry for the helper.
- Key abstractions: `main()`; `isSea()` to decide `kind: 'executable' | 'node-script'`.
- Data flow: `runSshHelper({input: process.stdin, output: process.stdout, entryPath, kind, signal})`.
- Non-obvious design decisions: The helper "accepts **no command arguments**" (`process.argv.length !== 2` throws) — the remote side cannot be asked to do anything else. `SIGTERM`, `SIGHUP` and `SIGINT` all abort the transport, which is what starts the helper's cleanup.
- Edge cases / failure handling: Every failure is written to stderr with the prefix `dsh-ssh-sandbox:` and `exitCode = 127`.
- Surprising: The stderr *prefix* names the sandbox even though the helper is not only a sandbox — a small naming inconsistency that a reader will notice.

### packages/ssh/ssh/README.md
- Purpose: Package reference for the SSH connection: deployment prerequisites, the config table, and the transport design.
- Key abstractions: `Config` (host, launch, helper, helperHash, workspace, requestTimeoutMs, maxFrameBytes, maxPending, leaseMs); `ctx.ssh.ptcLaunch`.
- Data flow: `ctx.ssh.ptcLaunch` is passed straight into `NodePtcRuntime`'s `launch` config — the connection tells the code runtime where the remote worker is.
- Non-obvious design decisions: "Each program stream uses a separate forwarded Unix socket and an **independent SSH channel**. Program stdout cannot forge administrative replies or occupy the control stream's channel window." The stream secret is a random 256-bit TLS PSK carried **only** by the administrative RPC; the socket directory is 0700 and the socket 0600, so "Replacing a writable socket path cannot impersonate an endpoint or reveal the stream key."
- Edge cases / failure handling: "A disconnected client cannot confirm the remote outcome; operations are **never reconnected or replayed automatically**." The deployment must place the runtime outside a backend's replaced temporary tree (bwrap's private `/tmp`) while the workspace may still be under `/tmp`.
- Surprising: The README states the residual risk plainly: "Digest verification detects an unexpected installed artifact after helper startup; it does not make writable deployment files safe to execute or authenticate a malicious SSH host", and "TLS stream keys do not protect against remote OS process-memory inspection or debugging."

### packages/ssh/ssh/README.i18n.yaml
- Purpose: Heading-hash record for the SSH package README (8 sections).
- Key abstractions: Section paths mirror the anchors.
- Data flow: Regenerated by the pairing script.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a — generated record.

### packages/ssh/ssh/README.zh.md
- Purpose: Chinese mirror of the SSH package README.
- Key abstractions: Same config table and transport design.
- Data flow: n/a.
- Non-obvious design decisions: The zh "理解实现" section keeps the SIGUSR1 sentence ("连接会禁用 helper 的 SIGUSR1 调试器激活") as its own paragraph — the hardening is a documented design decision, not a footnote.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/ssh/ssh/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-ssh`.
- Key abstractions: exports `.`, `./helper` (the remote entry), `./protocol`, `./schemas` — the last two are **public** so the sibling providers can import the wire types without reaching into `src`.
- Data flow: peer-depends on the whole local provider set (fs, fs-local, fs-sandbox, subprocess, subprocess-local, sandbox, sandbox-local, sandbox-policy, session-projection).
- Non-obvious design decisions: `files` ships `lib/protocol-*.js` and `lib/stream-security-*.js` (chunked builds) alongside `lib/protocol.js`.
- Edge cases / failure handling: n/a.
- Surprising: The package publishes the *protocol* as a first-class export — the remote helper and the client share it, and so can any other provider.

### packages/ssh/ssh/tsconfig.json
- Purpose: Project reference for the SSH package; `rootDir: src`, `outDir: lib/types`.
- Key abstractions: References cordis, schemastery, fs, fs-local, fs-sandbox, subprocess, subprocess-local, sandbox, sandbox-local, sandbox-policy, session-projection, brand, util/values.
- Data flow: n/a.
- Non-obvious design decisions: The reference list is exactly the set of providers the helper mounts in its private Context.
- Edge cases / failure handling: n/a.
- Surprising: n/a — configuration only.

### packages/ssh/ssh/tsdown.config.ts
- Purpose: The bundle configuration: four entries in one tsdown pass.
- Key abstractions: `index`, `protocol`, `schemas`, `helper` → `lib/*.js`.
- Data flow: `lib/types/*.js` → `lib/*.js`, ESM, node, es2024, `dts: false`, `clean: false`.
- Non-obvious design decisions: `helper` is bundled separately from `index` because the remote host runs it as a *script* with no workspace to resolve imports from.
- Edge cases / failure handling: n/a.
- Surprising: n/a — configuration only.

### packages/ssh/ssh/tests/collection.spec.ts
- Purpose: Pins the collected-output contract across a paused reader and a disconnect.
- Key abstractions: `doneSchema`, `preparedSchema`; `SshSubprocessRuntime` over the helper harness.
- Data flow: A 72 000-byte payload with `stdout: {maxBytes: 16, spill: {maxBytes: 100000}}` → a paused snapshot reader → `process.done` → the spill file.
- Non-obvious design decisions: The tail is the **last 16 bytes** of the stream while `totalBytes` is the full length — the bounded tail and the true size are reported separately. The spill file survives the helper's shutdown, and the test verifies it by digest after `helper.close()`.
- Edge cases / failure handling: The client-side test asserts the raw byte offsets: `readFrom(0)` returns `'\ufffdefg'` with `nextOffset: 8, lossy: true` and `readFrom(7)` returns `'g'` with `nextOffset: 8, lossy: false` — offsets are absolute stream coordinates, not offsets into the tail.
- Surprising: The lossy flag is `true` when the requested range started before the retained window, so a consumer can tell "I was given a partial answer" from "this was the whole answer".

### packages/ssh/ssh/tests/connection-disposal.spec.ts
- Purpose: Pins the disposal ordering of the client: pending requests, heartbeats, control commands and half-established streams.
- Key abstractions: `SshConnection` with `node:child_process`, `node:net` and `node:tls` mocked; `fs/promises` mocked to a virtual directory.
- Data flow: `connectStream` → `ssh -O forward` → socket connect → TLS.
- Non-obvious design decisions: The test is explicit that it "owns no filesystem or native process; cleanup settles in microtasks so it cannot hide an unjoined control command" — the mock design exists to make an unjoined cleanup *observable*.
- Edge cases / failure handling: Pinned: requests are refused *without being sent* once disposal begins; a heartbeat is still admitted when ordinary capacity is full and its reply is delayed; a control command that outlives cancellation is force-killed with `SIGKILL`; a pending `forward`/`cancel` command is **joined** after its cancellation callback fires; a close-only socket is rejected with a matching message; the socket's listeners are all removed (the test asserts `listenerCount` is 0 for `connect`/`data`/`end`/`secureConnect`).
- Surprising: The "keeps one heartbeat outstanding" test pins the reserved-capacity property from the client side: with `maxPending: 1` and an ordinary call in flight, the heartbeat still goes out and the ordinary call stays pending.

### packages/ssh/ssh/tests/fixtures/helper.ts
- Purpose: The shared harness: a *real* helper served over an in-memory administrative transport, with real authenticated stream endpoints.
- Key abstractions: `createHelperHarness(handshake, leaseMs, kind)`; returns `client`, `hello`, `close`, `serving`, `facts`, `connection`.
- Data flow: `runSshHelper` over two `PassThrough`s; `SshRpcPeer(output, input, …)` as the client.
- Non-obvious design decisions: The root is `realpath`'d (not just `mkdtemp`'d) so the helper's canonical path equals the client's view of it — the tests compare `hello.workspace` to `test.root` directly. The returned `connection` object is shaped like `SshConnection` (`ready`, `request`, `connectStream`, `dispose`) so providers can be mounted against it unchanged.
- Edge cases / failure handling: `close()` destroys the sockets, closes the peer, aborts the controller, awaits `serving` and removes the root — the ordering means a failed `serving` still propagates.
- Surprising: The harness reuses the **production** `SshRpcPeer` and `authenticateStream`, so a change to either is exercised by every helper test.

### packages/ssh/ssh/tests/helper-boundaries.spec.ts
- Purpose: Pins the helper's lease, stream capacity, transfer bounds and lifecycle over the wire.
- Key abstractions: `createHelperHarness`; `LocalFileSystem.prototype.streamText` spied to create an allocation race.
- Data flow: RPC calls over the in-memory transport.
- Non-obvious design decisions: The **overlapping allocation** test is the interesting one: two concurrent `fs.stream` requests are held inside `streamText`, and the test asserts exactly one is admitted and the other is refused with `'SSH text stream limit reached'` — the helper checks the limit *again after* the allocation, so a race cannot overshoot.
- Edge cases / failure handling: Pinned: an unsupported host is refused; cancellation during service mounting is joined; an invalid handshake field is refused; an executable helper refuses an external bootstrap; a lease expiry closes the connection, removes the root and the socket path, and subsequent requests fail with 'connection lost'; an 8 MiB + 1 whole-text read is `FS_TOO_LARGE`; a byte range over the cap is refused; a failed iterator is removed and a second read reports 'Unknown SSH text stream'; a cancelled pending read closes the iterator *before* another read is accepted; a cleanup failure surfaces through the serving lifetime.
- Surprising: The test that a lease expiry removes the *socket path* is how the helper's cleanup is proven to reach the filesystem, not just the in-memory maps.

### packages/ssh/ssh/tests/helper-cleanup-join.spec.ts
- Purpose: Proves helper shutdown **joins** a completed process's directory removal rather than racing it.
- Key abstractions: `RemoteProcesses`; `rm` mocked to block on the target directory.
- Data flow: `prepare` → connect → `start` → `done` → blocked `rm` → `owner.close()`.
- Non-obvious design decisions: The test's mock blocks the *specific* directory's removal and then asserts `owner.close()` has **not** completed — a cleanup barrier, not a best-effort sweep.
- Edge cases / failure handling: The same test runs for a success and for a failure (a missing executable) and asserts the *late* `done` returns the identical outcome, including the identical error object.
- Surprising: The failure case proves the bounded completion cache preserves the *original rejection* for later result reads, not a re-derived one.

### packages/ssh/ssh/tests/helper-failure-settlement.spec.ts
- Purpose: Proves a failed native launch releases remote capacity while preserving the original error.
- Key abstractions: `RemoteProcesses` with a limit of **one** process.
- Data flow: Three sequential attempts against a missing executable.
- Non-obvious design decisions: With `limit: 1`, the capacity must be released between attempts or the second `prepare` would fail — so the test is a capacity-reclamation test as well as an error test.
- Edge cases / failure handling: Each attempt asserts the error carries `code: 'ENOENT'`, that `waitForExit` returns true, that the root directory is emptied, and that a later `done` **rejects with the same error object** (`toBe(failure)`).
- Surprising: The identity assertion (`toBe`) rather than a shape match is what pins "the original rejection, not a re-derived one".

### packages/ssh/ssh/tests/helper-finalization.spec.ts
- Purpose: Pins the competition between an authenticated transport fault and native-range finalisation.
- Key abstractions: `node:tls`'s `createServer` mocked so the test can find the listener by path.
- Data flow: A prepared process with a control channel; the TLS transport is destroyed while the native process is alive.
- Non-obvious design decisions: The test locates the helper's TLS listener by `result.value.address() === endpoint.path` — it reaches into the provider's own listener to destroy the *authenticated* side, which is the only way to simulate a mid-stream TLS fault.
- Edge cases / failure handling: A TLS failure destroys the native control endpoint (so the other side does not hang); completion is not republished after a release; and a release that is *still observing* the native range keeps ownership — the `close()` is joined and the completion is not published early.
- Surprising: The third test asserts `waitForExit` is called **twice**: once by the release and once by the close, i.e. the finalization path deliberately re-observes the range rather than trusting the first observation.

### packages/ssh/ssh/tests/helper-lifecycle.spec.ts
- Purpose: Pins reservation ownership across asynchronous preparation and cancellation.
- Key abstractions: `RemoteProcesses.prepare` / `start` / `terminate`.
- Data flow: `prepare` → connect → `start` with a blocked `fs.resolve` → `terminate`.
- Non-obvious design decisions: Capacity is reserved **before** the asynchronous listener allocation ("reserves capacity before asynchronous listener allocation"), so two concurrent `prepare` calls cannot both succeed. A `close()` during a pending `prepare` rejects it with 'closed' and still empties the root.
- Edge cases / failure handling: A `terminate` that interrupts cwd resolution means the process is **never published** — `spawn` is not called at all.
- Surprising: The cancellation test asserts `spawn` was never called, i.e. the reservation is not merely killed but never turned into a process.

### packages/ssh/ssh/tests/helper-processes.spec.ts
- Purpose: The remote process settlement matrix: reservations, terminal operations, native cleanup ownership and the bounded completed-result cache.
- Key abstractions: `RemoteProcesses` driven directly (no RPC peer); a `harness()` that provides `ctx.fs.resolve` and `ctx.subprocess.spawn`/`spawnTerminal` doubles and connects real TLS endpoints.
- Data flow: `prepare` → connect each endpoint → `start` → the native handle settles → `done`/`wait`/`terminate` → the reservation directory is removed.
- Non-obvious design decisions: The harness uses a **limit of one** process, so every test is also a capacity test. The bounded completed-result cache is exercised by reading `done(id)` *after* the record is gone and expecting the identical value; a fifth completed terminal is evicted from the cache, so the sixth read raises 'Unknown or expired SSH process handle'.
- Edge cases / failure handling: Pinned: terminal operations are forwarded and the terminal's pid is returned; a start requested twice is refused ('already requested'); a terminal allocated *after* its start was cancelled is still terminated; a missing native fd-7 control descriptor is refused ('did not establish fd 7') and the process is still reaped; a listener that cannot be chmod'ed closes and leaves no residue; a socket path longer than the OS limit is rolled back; the collector keeps capturing while a live snapshot waits for acknowledgement; a final capture survives the loss of the live snapshot transport; a native cleanup failure is reported rather than claimed as quiescence; an unused reservation expires; a terminal whose driver rejects completion is reaped; a failed terminal whose native owner cannot confirm cleanup retains its capacity.
- Surprising: The **opted-in** terminal (`shellActivity: true`) is a deliberate exception: after the root process exits the reservation is **kept** (`child.terminate` is *not* called) and the terminal stays addressable for `terminal.activity` until the owner terminates it explicitly.

### packages/ssh/ssh/tests/helper-runtime.spec.ts
- Purpose: The helper's real behaviour over the wire: filesystem, sandbox, executables and text streams.
- Key abstractions: `createHelperHarness`; `LocalSandboxProvider.prototype.confine` and `LocalSubprocessRuntime.prototype.resolveExecutable` spied.
- Data flow: RPC calls over the in-memory transport.
- Non-obvious design decisions: The test asserts the helper **does not chdir**: `process.cwd()` is unchanged before and after a relative `fs.resolve` — the workspace is a *parameter*, not a process state.
- Edge cases / failure handling: Pinned: a request before the handshake is 'not accepting'; a second handshake is 'already completed'; an unknown method is refused; a request after `close` is 'not accepting'; guarded writes preserve `FS_STALE_VERSION` and `FS_SANDBOX_DENIED`; a symlink resolves to its physical target while `lstat` still reports `symlink`; a text iterator is closed after completion and after an explicit close; an unconfined sandbox request is refused ('does not need'); an absent executable is `SUBPROCESS_EXECUTABLE_NOT_FOUND`.
- Surprising: The test pins that the error code mapping is **name-based, not class-based**: a locally-constructed object with `name: 'SubprocessExecutableNotFoundError'` that is *not* an instance of the class is still mapped to the remote code — because the helper runs in a different realm.

### packages/ssh/ssh/tests/identifiers.spec.ts
- Purpose: Pins the branded identity types.
- Key abstractions: `processIdSchema`, `textStreamIdSchema`, `preparedSchema`.
- Data flow: n/a.
- Non-obvious design decisions: The test asserts at the **type level** that `SshProcessId` and `SshTextStreamId` are not assignable to each other and that neither is assignable *from* `string` — a runtime value cannot be passed where a process id is expected.
- Edge cases / failure handling: `safeParse('invalid')` fails for both.
- Surprising: `JSON.stringify({process, stream})` equals the stringify of the raw wire value — the brand is erased at the boundary, as it must be.

### packages/ssh/ssh/tests/inspector-signal.spec.ts
- Purpose: Proves that a same-user sandboxed process cannot attach a Node inspector to the helper.
- Key abstractions: `node:inspector`'s `url()` as the probe; `--inspect-port=0`; `--disable-sigusr1`.
- Data flow: A sandboxed process sends `SIGUSR1` to the target pid; the target either starts an Inspector or does not.
- Non-obvious design decisions: The fixture is **deliberately vulnerable** ("This fixture has no credentials, application state, or descendants. Port zero keeps the deliberately vulnerable control away from existing inspectors"), and the test runs it twice — with and without `--disable-sigusr1` — so the *difference* is the evidence, not the absolute result.
- Edge cases / failure handling: The assertion is `{active: !disabled}`: without the flag the debugger **is** active, with it it is not, and stderr contains no 'Debugger listening on'.
- Surprising: The test is macOS-only (`skipIf(process.platform !== 'darwin')`) — on Linux the `SIGUSR1` semantics differ enough that the probe is not meaningful.

### packages/ssh/ssh/tests/live.e2e.ts
- Purpose: Opt-in acceptance against a real, explicitly configured, disposable POSIX SSH workspace.
- Key abstractions: `DSH_SSH_TEST_CONFIG` / `DSH_SSH_TEST_BOOTSTRAP` / `DSH_SSH_TEST_LSP` env gates; `describe.skipIf(!enabled)`.
- Data flow: A real `SshConnection` + `SshFileSystem` + `SshSubprocessRuntime` + `SshSandboxProvider`, plus `NodePtcRuntime` launched with `ctx.ssh.ptcLaunch`.
- Non-obvious design decisions: Each test uses a unique `ssh-test-<uuid>` directory under the negotiated workspace and removes it in a `finally` by spawning a remote `rmSync` — the cleanup is itself a remote process. The **same-user attacker** test is the crown jewel: a sandboxed same-user process tries to TLS-connect to the control socket with a wrong PSK; the assertion is `{connected: true, secure: false}` — the TCP connection succeeds (the path is known) but the TLS handshake does not, and the legitimate client still works afterwards.
- Edge cases / failure handling: Pinned: guarded mutations and stale versions; a symlink escape; binary fd 7 preserved through native ownership (128 KiB round trip) with a read-only denial (`EROFS|EPERM|EACCES`) and a Linux cgroup scope named `dsh-subprocess-….scope`; **control traffic keeps moving while stdout is paused**; a terminal round trip with `stty size`; and a disconnect case where a detached grandchild's cgroup scope **disappears** (the remote cleanup ran) while the launch file still says `'one\n'` (no replay).
- Surprising: The disconnect test uses a *second* connection ("observer") to watch the victim's cgroup scope from outside — the remote cleanup is verified by an independent observer rather than by the victim that lost its connection.

### packages/ssh/ssh/tests/management-capacity.spec.ts
- Purpose: Proves each request class has its own capacity so health and cleanup stay available.
- Key abstractions: `managementLimits` (heartbeat 1, close 1, process.terminate 128, fs.streamClose 128); `atCapacity`.
- Data flow: A `SshRpcPeer` pair with gated handlers.
- Non-obvious design decisions: The test holds **every** management class at its quota simultaneously (1 + 128 + 128 = 257 admitted entries) and then asserts `heartbeat` and `close` still succeed while `process.done`, `process.terminate` and `fs.streamClose` are refused.
- Edge cases / failure handling: A cancelled request keeps its credit until the remote handler replies — the test asserts the quota is *still full* after the abort and only frees after the handler settles. The receive side is checked separately: a raw frame that bypasses the sender's limits is still refused at the receiver's own quota and the channel closes.
- Surprising: The credit rule is the opposite of the intuitive one: cancelling does **not** free a slot, because the remote resource may still be alive. Releasing it early would let the helper oversubscribe.

### packages/ssh/ssh/tests/protocol-boundaries.spec.ts
- Purpose: Pins the protocol's framing, queueing and inbound-admission rules.
- Key abstractions: `SshRpcPeer`; a `Writable` with `highWaterMark: 1` to force backpressure.
- Data flow: Frames written by hand; responses read by hand.
- Non-obvious design decisions: The test asserts the *rejection before transmission*: an already-aborted call writes **zero bytes**; an oversized frame writes zero bytes; a queued-bytes overflow is refused while the first frame is backpressured. It also pins that a **reentrant** `connection.close()` inside the transport's own `write` settles the request before a drain listener is attached (`output.listenerCount('drain') === 0`).
- Edge cases / failure handling: An inbound payload length of 0 or `maxFrameBytes + 1` closes the channel before allocating; malformed JSON fields, invalid JSON bytes and a frame split across EOF are each distinguished; fragmented `Uint8Array` chunks and more than one frame per chunk are accepted; an unexpected, duplicate or excessive inbound request closes the channel; late replies and unknown cancel ids are ignored; a primitive abort reason becomes a remote error; a non-string native `code` is omitted.
- Surprising: The test asserts `input.destroyed` is **false** after late replies — ignoring a stale reply must not tear down the connection.

### packages/ssh/ssh/tests/protocol-disposal.spec.ts
- Purpose: Proves queued requests settle after a peer close, an output close or an input EOF — **without** a drain event.
- Key abstractions: `SshRpcPeer` with a backpressured `Writable`.
- Data flow: Two requests queued behind a blocked write, then the transport dies.
- Non-obvious design decisions: The test asserts `output.listenerCount('drain') === 0` and `peer.listenerCount('closed') === 0` after the failure — a disposal path that leaves a listener behind is a leak the next test would trip over.
- Edge cases / failure handling: All three causes (peer close, output close, input EOF) produce the same 'unknown|disconnected' rejection.
- Surprising: The absence of a `drain` event is the *hard* case: a write blocked forever would otherwise never settle, so the close path must settle it directly.

### packages/ssh/ssh/tests/protocol.spec.ts
- Purpose: The small, high-level protocol spec.
- Key abstractions: `SshRpcPeer` as both client and server.
- Data flow: A request/response pair over two `PassThrough`s.
- Non-obvious design decisions: The cancellation test asserts `calls === 1` — the operation is cancelled, **not replayed**.
- Edge cases / failure handling: A typed remote error keeps its code (`FS_STALE_VERSION`); a response that fails the caller's schema rejects; an excessive declared length closes the channel before the payload; a connection that disappears after admission reports an *unknown* outcome.
- Surprising: The protocol handles a payload containing a NUL byte and a Chinese string unchanged ("a\0b\n中文") — the framing is length-based, not delimiter-based.

### packages/ssh/ssh/tests/startup-behavior.spec.ts
- Purpose: The client startup matrix: configuration validation, identity verification, stream establishment and disposal.
- Key abstractions: `SshConnection` with `node:child_process`/`node:net`/`node:tls`/`node:fs/promises` mocked; a `Stream` double whose `destroy` can be held.
- Data flow: `setup()` → `new SshConnection(ctx, config)` → mocked `ssh` spawn → the real `SshRpcPeer` handshake.
- Non-obvious design decisions: The `Stream` double supports **holding the destroy callback**, which is how the test proves disposal *joins* a socket whose native close callback is delayed. The SSH argv is asserted element-wise, including the quoted remote command `"'/remote/node' '--disable-sigusr1' '/remote/helper'\''s file.js'"` — a path containing a quote is escaped correctly.
- Edge cases / failure handling: Pinned: eleven invalid configurations are rejected before `ssh` is spawned; a non-POSIX client is refused; the digest, bootstrap digest, protocol version and launch kind are each checked before readiness; a disposal before the directory exists never spawns; the first SSH error is preserved; a null deadline is honoured past the numeric ceiling until cancellation; a cancellation racing executable lookup and a cancellation racing confinement both prevent the spawn; a stream path outside the helper root is refused; a failed forwarding reservation is cancelled; a directory-creation failure spawns nothing; a failed heartbeat invalidates the connection; a helper that ignores SIGTERM is force-killed; a failed local path removal does not block disposal.
- Surprising: The test that a *widened* one-shot policy is kept while the standing mode is unchanged is in the persistent file, but its analogue here is that `request(..., wait = true)` may **outlive the administrative deadline** — a process observation is allowed to take longer than a normal request.

### packages/ssh/ssh/tests/stream-capability.spec.ts
- Purpose: Pins the per-stream capability's authentication and exclusivity.
- Key abstractions: `authenticateStream`, `SSH_STREAM_TLS_OPTIONS`; `RemoteProcesses.prepare` with a terminal or a control channel.
- Data flow: Raw socket → TLS with a given PSK/identity.
- Non-obvious design decisions: The "wrong identity" test uses a **known-good PSK with a wrong identity string** — the server's `pskCallback` compares the identity, so the handshake fails while the legitimate client still connects afterwards ("refuses an unknown TLS identity **without consuming a legitimate reservation**").
- Edge cases / failure handling: Two already-connected clients for one reservation: exactly one is published, the other is destroyed. A different endpoint's capability is refused. And the "administrative-looking bytes" test writes a **forged `{"type":"request",…}` JSON frame** into a *data* stream and asserts it is treated as opaque bytes (the connection closes) rather than as a helper request.
- Surprising: The forged-frame test is the direct statement of the README's claim that program stdout cannot forge administrative replies.

### packages/ssh/ssh/tests/stream-lifetime.spec.ts
- Purpose: Pins who owns cancellation once TLS has taken over the underlying socket.
- Key abstractions: `authenticateStream(socket, capability, timeoutMs, signal)`.
- Data flow: Abort → the TLS stream is destroyed → the raw socket is destroyed with it.
- Non-obvious design decisions: The test asserts **both** the TLS stream and the raw socket are closed — cancellation must not leave the underlying socket open, because the helper's listener holds it.
- Edge cases / failure handling: An already-aborted signal rejects with the caller's *primitive* reason (`'caller stopped'`, not an Error) and destroys the raw socket; an abort during authentication rejects with an Error carrying the same message.
- Surprising: The primitive-reason case is pinned as `rejects.toBe('caller stopped')` — the caller's abort reason is propagated verbatim, not wrapped.

### packages/ssh/ssh/tests/stream-rebind.spec.ts
- Purpose: Proves that a confined process which replaces a writable socket path still cannot read the authenticated stream.
- Key abstractions: `LocalSandboxProvider.confine` + `LocalSubprocessRuntime.spawn` + `RemoteProcesses`; a `relay` script that renames the socket and rebinds a proxy to it.
- Data flow: The relay captures both directions of the TLS bytes to a file; the legitimate client then sends a secret over the control stream.
- Non-obvious design decisions: The attack is realistic: the process renames the listener's path and re-listens on it, so the *client connects to the attacker's proxy* and the attacker sees the raw TLS records.
- Edge cases / failure handling: The assertion is negative and strong: the captured bytes are **longer** than the secret (so the relay really ran) but contain **neither** the secret **nor** the capability key (in hex or as text). The test skips itself when no local confinement backend is available.
- Surprising: The attacker gets the ciphertext and the length, but not the plaintext — TLS-PSK is what makes a rebind attack useless, and the test proves it end to end.

### packages/ssh/ssh/tests/stream-timeout.spec.ts
- Purpose: Pins the TLS authentication deadline.
- Key abstractions: `authenticateStream(raw, capability, 25)`.
- Data flow: A peer that accepts the TCP connection and never completes the handshake.
- Non-obvious design decisions: The peer is a plain TCP server (`socket.resume()`) that reads and discards — exactly the "accepted but silent" case a timeout exists for.
- Edge cases / failure handling: The authentication rejects with 'authentication timed out' and the raw socket is destroyed.
- Surprising: The timeout is 25 ms in the test — the deadline is a real liveness property, not a formality.

### packages/ssh/subprocess-ssh/src/index.ts
- Purpose: `ctx.subprocess` over the SSH helper: ordinary processes, fd 7 control, terminals, and executable lookup.
- Key abstractions: `SshSubprocessRuntime extends SubprocessRuntime`; the private `RemoteProcess implements SubprocessHandle`; `RemoteCleanupError`.
- Data flow: `spawn(spec)` → `process.prepare` → `connectStream` per channel → `process.start` → `process.done` → `process.wait`; terminals use `terminal.write/resize/inspect/activity/signal`.
- Non-obvious design decisions: The collected-output client **re-bases absolute offsets**: it tracks `base = snapshot.totalBytes - bytes.length` and `total`, and `readFrom(offset)` maps the caller's absolute offset into the retained window, rejecting a snapshot that is longer than the cap, shorter than its own bytes, or that **rewinds** (`'SSH helper rewound collected output'`). `terminate()` on a connection that cannot confirm termination **disposes the whole SSH connection** ("A connection unable to confirm termination must release its helper lease"). A terminal allocation failure that also fails its cleanup raises a `RemoteCleanupError` carrying *both* errors, so the provider disposal can report them.
- Edge cases / failure handling: `waitForExit(signal)` is bounded by the caller's signal and returns `false` on cancellation "without stopping the process"; a genuine observation failure rejects rather than returning false. `done` is separate from `waitForExit`: "A direct exit reported by `done` does not prove managed-range quiescence." The environment maps `undefined` to `null` — a **tombstone** meaning "remove this variable", distinct from setting it empty.
- Surprising: The provider's disposal aborts the lifetime signal, terminates every live handle, waits for exit, closes the streams, and then raises `AggregateError('SSH process cleanup could not be confirmed')` if any of that fails — a disposal that cannot confirm cleanup is an *error*, not a warning.

### packages/ssh/subprocess-ssh/README.md
- Purpose: Package reference for the remote subprocess provider.
- Key abstractions: `ctx.subprocess`; ordinary processes and terminals; the `waitForExit` vs `done` distinction.
- Data flow: Remote execution delegates to `subprocess-local`, so native process ownership has the same meaning as local execution on the remote OS.
- Non-obvious design decisions: "Ordinary spawn returns a handle **while remote allocation proceeds**" — the handle is usable (stdin and the duplex control endpoint accept writes) before the remote process exists. "SSH carries requests and observations; it does not itself confine the payload."
- Edge cases / failure handling: "A direct exit reported by `done` does not prove managed-range quiescence; `waitForExit()` observes that separately." "Connection loss rejects unconfirmed work, and **automatic replay never follows an ambiguous launch or mutation**." Spill files survive connection disposal.
- Surprising: "Callers must consume or close raw output streams. Destroying public stdout or stderr closes its matching transport, **including when destruction precedes remote allocation**" — the client remembers a stream closed before the socket existed.

### packages/ssh/subprocess-ssh/README.i18n.yaml
- Purpose: Heading-hash record for the subprocess-ssh README (9 sections).
- Key abstractions: Section paths mirror the anchors.
- Data flow: Regenerated by the pairing script.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a — generated record.

### packages/ssh/subprocess-ssh/README.zh.md
- Purpose: Chinese mirror of the subprocess-ssh README.
- Key abstractions: Same provider contract.
- Data flow: n/a.
- Non-obvious design decisions: The zh text keeps the "done 与 waitForExit 不同" distinction as its own paragraph.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/ssh/subprocess-ssh/tests/lifecycle.spec.ts
- Purpose: Proves the provider joins an *unpublished* terminal allocation before disposal completes.
- Key abstractions: `SshSubprocessRuntime` with a fake `ctx.ssh`.
- Data flow: `spawnTerminal` → `process.prepare` → `connectStream` → `process.start` → `process.done`.
- Non-obvious design decisions: The test pauses at `prepare`, `connect` or `start` and asserts the provider's disposal does **not** complete until the allocation is joined and terminated.
- Edge cases / failure handling: After disposal, a further `spawnTerminal` is refused ('disposed') and no further RPC is sent.
- Surprising: For the `prepare` stage the socket is never connected, yet `process.terminate` is still sent — a reservation that was published to the helper must be released even if no stream was ever opened.

### packages/ssh/subprocess-ssh/tests/process-behavior.spec.ts
- Purpose: The ordinary-process contract through the public provider.
- Key abstractions: A fake `ctx.ssh` whose `connectStream` returns a `duplexPair`; `SshRpcPeer` used to push output snapshots.
- Data flow: `spawn(spec)` → prepare → connect → start → done → wait.
- Non-obvious design decisions: The `inherit` mode test asserts the host's own `process.stdout` is *written to but not ended* (`writableEnded === false`) — inherited output must not close the harness's streams. The collected-output test proves the **absolute** offsets survive a stale snapshot: after a later snapshot arrives, `readFrom(8)` still returns the right bytes and the final `spillPath` is attached.
- Edge cases / failure handling: Pinned: output draining is bounded even when the output peer stays open; output transports that closed *before* the start acknowledgement are still observed; stdin/stdout/stderr/control are independent; a remote snapshot that is too long, too short or that rewinds is rejected; a final output-mode mismatch rejects and terminates the remote process; cancellation during prepare/connect/start sends **at most one** termination; a preparation failure means neither `process.start` nor `process.terminate` is sent; an unconfirmed cleanup closes the SSH connection; a non-Error transport rejection is normalised for stream consumers; new work is refused after disposal.
- Surprising: The cancellation test's assertion `process.terminate` count is exactly **1** even though `terminate()` is called twice — the handle is idempotent.

### packages/ssh/subprocess-ssh/tests/shell-discovery.spec.ts
- Purpose: Pins the remote shell facts and the distinction between a lookup miss and a transport failure.
- Key abstractions: `resolveExecutable`, `terminalEnvironment`; `RemoteOperationError` with `code: 'SUBPROCESS_EXECUTABLE_NOT_FOUND'`.
- Data flow: `ctx.ssh.request('terminal.environment' | 'executable', …)`.
- Non-obvious design decisions: The error mapping is **code-based**, not class-based: only the remote code `SUBPROCESS_EXECUTABLE_NOT_FOUND` becomes a `SubprocessExecutableNotFoundError`; every other remote error is re-thrown unchanged, so a transport failure stays a transport failure.
- Edge cases / failure handling: An unknown `platform` in the shell facts is a `ZodError`; an absolute path lookup miss is a `SubprocessExecutableNotFoundError`; an `EACCES` remote error is passed through; a plain `Error('SSH disconnected')` is passed through.
- Surprising: The second test drives the **real** helper (via the shared harness) and resizes a live PTY, asserting the remote shell reports the new size (`40 120`) — a resize that replaced the process would not.

### packages/ssh/subprocess-ssh/tests/stream-wait-lifecycle.spec.ts
- Purpose: Pins caller-owned stream closure and the bounded range observation.
- Key abstractions: `waitForExit(signal)`; the stage-gated fake connection.
- Data flow: `spawn` → prepare → connect → start → done/wait/terminate.
- Non-obvious design decisions: The test asserts the caller's abort listener is **removed** after the observation (`getEventListeners(controller.signal, 'abort')` is empty) — a leaked listener on a long-lived signal is a leak. The observation is bounded across *every* stage (prepare, connect, start, wait, terminate) and returns `false` without stopping the process.
- Edge cases / failure handling: Destroying stdout closes only the stdout transport (stderr is untouched) and sends **no** `process.terminate`; a stream destroyed *before* allocation finishes is still closed when the socket arrives. A pre-aborted observation returns `false`; a confirmed-empty range returns `true` even with the same (aborted) signal; a real observation failure rejects and still detaches the listener.
- Surprising: The "bounds termination after failed startup while retaining real termination failure" test shows the two truths coexisting: the *bounded* observation returns `false` on cancellation, and the *unbounded* one later rejects with the real cleanup error.

### packages/ssh/subprocess-ssh/tests/terminal-behavior.spec.ts
- Purpose: The terminal contract: operations, cleanup failures, and provider disposal.
- Key abstractions: `spawnTerminal`, `terminal.write/resize/inspectForeground/signalForeground/terminate`.
- Data flow: `process.prepare` → `connectStream` → `process.start` → `process.done` → `process.terminate`.
- Non-obvious design decisions: `terminate()` is memoised (`closing ??= …`) so two concurrent calls send exactly one `process.terminate`; on failure the memo is **cleared** so the caller can retry ("retries termination after a remote cleanup failure without discarding the live handle"). The terminal's `process.terminate` is sent with the `longRunning` flag so it may outlive the administrative deadline.
- Edge cases / failure handling: Pinned: a terminal whose `done` observation fails is still terminable; an abort terminates a published terminal; an abort that cannot confirm termination **releases the SSH connection**; a reservation without its required stream is a `ZodError` and is still terminated; an allocation failure *plus* a cleanup failure is reported as an `AggregateError` carrying both; admission is refused after cancellation or disposal; provider disposal terminates a published terminal.
- Surprising: The `terminate()` failure path keeps the handle's output stream **alive** (`expect(handle.output.destroyed).toBe(false)`) — a failed cleanup must not look like a successful teardown.

### packages/ssh/subprocess-ssh/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-subprocess-ssh`.
- Key abstractions: peer-depends on `dsh-ssh`, `dsh-subprocess`, `dsh-subprocess-local`.
- Data flow: `dependencies` on `zod` (pinned) and `schemastery`.
- Non-obvious design decisions: It peer-depends on `dsh-subprocess-local` because the *client* imports `OutputCollector` from that package's `/output` subpath — the remote client reimplements the same collection semantics locally.
- Edge cases / failure handling: n/a.
- Surprising: The client-side collector is the same class as the remote one, which is what makes the byte offsets comparable across the wire.

### packages/ssh/subprocess-ssh/tsconfig.json
- Purpose: Project reference for subprocess-ssh; `rootDir: src`, `outDir: lib/types`.
- Key abstractions: References cordis, schemastery, `../ssh`, subprocess, subprocess-local.
- Data flow: n/a.
- Non-obvious design decisions: The `subprocess-local` reference exists for the `OutputCollector` import, not for local execution.
- Edge cases / failure handling: n/a.
- Surprising: n/a — configuration only.

## Ideas worth stealing

- **A failed run is a resolved result with an orthogonal failure kind, not a rejection** - `packages/ptc-runtime/ptc-runtime/src/types.ts:139` - August's `turn_end {reason}` vocabulary is right, but the PTC seam shows how to make it airtight one level down: `exception | timeout | abort | worker-exit | invalid-output | output-limit | protocol | sandbox-unavailable` are *mutually exclusive* ("a budget expiry is not an exception, an abort is not a timeout, and a substrate death is neither"), and `run()` RESOLVES on failure so a failed program never lands in an exception path a caller might swallow. Only *caller misuse* (unresolved input, invalid binding name, call after disposal) rejects.

- **One shared exclusion set for every backend, with a stated reason per entry** - `packages/ptc-runtime/ptc-runtime/src/index.ts:42` - August has several code-execution surfaces (code mode, the `run_code`-style tool, the shell). `RESERVED_BINDING_GLOBALS` / `PORTABLE_RESERVED_WORDS` / `DUNDER_MEMBER` / `RESERVED_ERROR_MEMBERS` are owned by the *seam*, not by a provider, because "a namespace list valid on one backend is valid on all" — a name that works in August's Python lane but breaks in its Node lane is a latent 400. The `__debug__` entry is the template: exclude with a reason ("CPython compiles a bare `__debug__` reference to the constant `True` and rejects any assignment at COMPILE time") and state that extending the set is a breaking review.

- **Measure JSON output in exact serialized bytes, without materialising the escaped form** - `packages/ptc-runtime/ptc-runtime-node/src/output-json.ts:81` - August's `maxToolResultChars` is a character count, which is a lie for non-ASCII and for JSON-escaped content. `jsonStringBytesUpTo` walks code points and charges the exact serialised cost of each (2 for `"`/`\`, 6 for a surrogate pair, 6 for a control char, otherwise the UTF-8 length) and returns `undefined` the moment the cap is crossed, so a hostile 10 000-quote string is never escaped at all. `truncateJsonStringBytes` (same file, line 166) then returns the longest code-point-aligned prefix that fits — it never splits a surrogate pair.

- **Capture the JavaScript intrinsics your own accounting depends on** - `packages/ptc-runtime/ptc-runtime-node/src/json-wire.ts:11` - The wire module captures `Object.create`, `Reflect.apply`, `Array.isArray`, `Object.keys`, `Reflect.ownKeys` at load time and uses ONLY those, because the program shares the realm and can reassign `Array.prototype.push`. The proving test is `packages/ptc-runtime/ptc-runtime-node/tests/output-json.spec.ts:72`: it mutates eight intrinsics and asserts the measurement is unchanged. August's harness process is not the model's realm, but the same hazard exists wherever the harness and untrusted code share a runtime — and the cost of the defence is one block of `const intrinsicX = X` at the top of the file.

- **A flat bounded-depth wire for values that cross a process boundary** - `packages/ptc-runtime/ptc-runtime-node/src/json-wire.ts:259` - `encodePtcJsonWire` flattens a validated JSON value into a pre-order token array (container markers and scalar leaves share one flat array) so `JSON.stringify` never recurses through the value's own nesting; a 5 000-deep array round-trips and the wire is 5 001 tokens. August's tool arguments and results cross a JSON boundary too, and a deeply nested model-authored object can blow a recursive serialiser or a receiver's parser.

- **A policy change cancels admission AND blocks the next program until the cleanup is observed** - `packages/ptc-runtime/ptc-runtime-node/src/policy-processes.ts:43` - `register(policy, release)` tracks each admitted call; a `sandbox/mode` session event invalidates the matching processes; `wait(sessionId)` makes the *next* program block on the previous cleanup; a failed cleanup stays registered and is retried. The stated rule is the transferable part: "Permission setting success does not mean old processes have finished stopping." August's per-session sandbox-mode setter needs exactly this two-phase barrier — signal the change synchronously, observe the cleanup asynchronously, block admission on the observation.

- **"Cleanup incomplete" is a state that blocks new work, and it is retryable** - `packages/ptc-runtime/ptc-runtime-node/src/persistent.ts:68` - `assertIdle()` refuses with `'cleanup is incomplete; release the owner before running another program'` while `cleanupPending` is set, and `stop()` clears it only after the drain resolves. August's subagent and Bot paths have the same shape: a turn aborted mid-tool must not be able to re-enter until its process is confirmed dead, and the release must be retryable rather than a one-shot.

- **Distinguish "the sandbox refused to start" from "the program crashed" — and require runner evidence** - `packages/ptc-runtime/ptc-runtime-node/src/index.ts:272` - `classifyRunnerFailure(exitCode, stderr, confined.runnerFailureRules)` decides whether an early exit is `sandbox-unavailable` or `worker-exit`, and it needs the runner's own fatal signatures or allowed exit codes, not a guess. The test at `packages/ptc-runtime/ptc-runtime-node/tests/host-failures.spec.ts:475` proves the discipline: a spawn failure is attributed to the sandbox *only* when the error's `path` equals the runner.

- **Report the sandbox facts on a separate channel from the program outcome** - `packages/ptc-runtime/ptc-runtime-node/src/index.ts:294` - `sandbox.denied` is computed by matching the failure message against the confinement's own denial signatures, and `sandbox.enforcement` says whether the backend was `full` or `partial`; both sit next to `error` on the result rather than inside it. August's tool results should carry "was this refused by policy, and how complete was the enforcement" as a *separate* field from "what did the command say" — the denial dialect test at `packages/ptc-runtime/ptc-runtime-node/tests/host-failures.spec.ts:156` shows why ("EPERM: unrelated dialect" is not a denial).

- **Stream program output eagerly so it survives a mid-run kill** - `packages/ptc-runtime/ptc-runtime-node/src/protocol.ts:36` - Logs are separate `log` frames delivered as each line lands, "so output survives a mid-run termination (timeout, abort, OOM)"; the host meters the *same* combined budget across the streamed logs and the final value. August's tool-output spill has the identical failure mode (a killed command's output vanishes) and the identical fix — stream it, and account it against one budget.

- **An actionable error message beats a correct one** - `packages/ptc-runtime/ptc-runtime-node/src/bindings.ts:65` - When a host binding is gone from the current evaluation, the rejection is `'binding is unavailable in this evaluation; reacquire the current tool'` — the message names the *action* the model must take. August's tool errors are already aimed at a self-correcting model; this is the template for phrasing them ("do X", not "undefined").

- **Give each forwarded stream its own socket and a per-stream secret, so program output cannot forge the control channel** - `packages/ssh/ssh/src/helper-processes.ts:423` - Each stream reservation gets a random 32-byte capability, a 0600 Unix socket in a 0700 directory, and a TLS-PSK handshake with a pinned cipher (`packages/ssh/ssh/src/stream-security.ts:6`); the key is never sent as data. The property is stated in `packages/ssh/ssh/README.md:58`: "Program stdout cannot forge administrative replies or occupy the control stream's channel window." August's Tauri IPC has the same class of problem, and `packages/ssh/ssh/tests/stream-rebind.spec.ts:17` is the proof-of-work: an attacker renames the socket and relays the bytes, and still learns neither the plaintext nor the key.

- **Reserve request capacity for health checks and cleanup so ordinary load cannot starve them** - `packages/ssh/ssh/src/protocol.ts:17` - `managementLimits` gives `heartbeat` 1, `close` 1, `process.terminate` 128 and `fs.streamClose` 128 their own budgets, separate from the ordinary `maxPending`; `atCapacity` counts per class. The test at `packages/ssh/ssh/tests/management-capacity.spec.ts:103` holds every class at its quota and still gets `heartbeat` and `close` through. August's backend needs the same: a per-session "abort this turn" must not queue behind 128 in-flight tool calls.

- **Cancellation keeps the capacity credit until the far side replies** - `packages/ssh/ssh/src/protocol.ts:100` - The comment is the whole idea: "Keep the credit until the remote handler replies; cancellation does not mean its resource cleanup has finished." The caller's promise rejects immediately, but the slot is only released when the remote handler actually answers. Freeing it at abort time would let the harness over-admit while the aborted work is still running — the exact bug August's `MAX_MANAGED_TOOL_ROUNDS` / `_roundCapFinalFired` machinery fights.

- **Never replay an ambiguous remote mutation, and say so in the error** - `packages/ssh/ssh/src/protocol.ts:103` - The rejection text is literally 'SSH operation cancelled; **a completed remote mutation is not rolled back**', and `packages/ssh/ssh/README.md:62` adds "operations are never reconnected or replayed automatically." August's stuck-request ladder applies the same rule to history repair; the transferable addition is that the *error text* says the mutation may have landed, so a consumer that retries on error knows not to.

- **Disable SIGUSR1 in any Node child that shares a host with model-spawned processes** - `packages/ssh/ssh/src/index.ts:289` - The script launch uses `--disable-sigusr1` and the executable launch sets `NODE_OPTIONS='--disable-sigusr1'`. `packages/ssh/ssh/tests/inspector-signal.spec.ts:19` runs the same probe with and without the flag and shows that *without* it a same-user sandboxed process can SIGUSR1 the helper and obtain a live Node Inspector (`{active: true}`) — i.e. arbitrary code execution in the helper. August's backend runs on the same machine as model-written scripts; if August's own Node process can be SIGUSR1'd, a model-written program can attach a debugger to the harness. This is the single highest-value security idea in the shard.

- **A lease whose expiry starts remote cleanup** - `packages/ssh/ssh/src/helper.ts:84` - `touchLease()` resets a timer on every request; when it fires, the helper closes the peer and tears down its managed processes. The client heartbeats at `leaseMs/3` with a `leaseMs/2` timeout. A client that disappears (crash, partition) therefore does not leave orphans on the remote host. August's unattended Bot path needs the same: a heartbeat whose *absence* starts cleanup.

- **Whole-stream byte offsets so transport lag cannot change the completed observation** - `packages/ssh/ssh/src/helper-processes.ts:53` - The helper publishes a bounded tail together with `totalBytes` in whole-stream coordinates, and the client refuses a snapshot that is longer than the cap, shorter than its own bytes, or that **rewinds** (`packages/ssh/subprocess-ssh/src/index.ts:63`, 'SSH helper rewound collected output'), re-basing `readFrom(offset)` onto the absolute coordinate. August's `read_file` offset reads and its spill/length accounting have the same hazard: a tail is not a stream.

- **Separate channels let control traffic progress while stdout is paused** - `packages/ssh/ssh/tests/live.e2e.ts:165` - stdout backpressure does not block the fd-7 control channel because they are separate SSH channels; the test writes 'control-progress' on the control channel while stdout is paused and asserts it arrives. August's own tool-result spill and streaming design should assume the same: a saturated output channel must not stall cancellation or a heartbeat.

- **A one-shot flag flips the execution model, and the reload visibly drops the state** - `packages/ptc-runtime/ptc-runtime-node/tests/execution-mode.spec.ts:24` - `programFormat` changes from `'function-body'` to `'repl'`, and reloading the provider with the other mode discards the retained state (the test asserts `typeof retained === 'undefined'` after the swap *and* after swapping back). A state-shape change is a provider reload, and the reload must visibly drop the state rather than silently reinterpret it.

- **Provider-owned usage guidance, consumer-owned presentation** - `packages/ptc-runtime/ptc-runtime-node/src/index.ts:46` - `executionInstructions` is a provider-owned string that the consumer appends to the model-visible schema, and the consumer must not infer persistence from `programFormat`. August's per-model `toolSurface` profiles and the `run_code` schema should take the mode's rules from the provider, not restate them, so the rules cannot drift from the implementation.

- **One helper, three roles, selected by an env var that is deleted before dispatch** - `packages/ssh/ssh-helper-runtime/src/index.ts:28` - The packaged executable is a multi-call binary: `DSH_PTC_RUNTIME_NODE=1` → the PTC worker, `DSH_SUBPROCESS_RUNNER` → the managed subprocess runner, otherwise the SSH helper. Both selectors are removed from the environment before the chosen module is imported, so the child cannot re-read them, and a module-resolution hook redirects the native package to the co-shipped directory because "The operating system executes Landlock outside the SEA virtual filesystem." August's installer (a Tauri sidecar, a Python SDK) has the same multi-role problem.

- **An artifact verifier that runs the real product, not a mock** - `packages/ssh/ssh-helper-runtime/tests/fixtures/driver.ts:115` - The driver boots a real Loader composition and pushes a *named* check label for each property (files, processes, cancellation, native PTY, embedded PTC, native flock, deadline, sandbox enforcement), then asserts that Loader and provider cleanup reported no errors in a `finally`. August's `e2e:smoke` is the same idea at a smaller scale; the transferable part is the *named check list* in the report, which turns "the suite passed" into an auditable list of properties.

## Lens coverage

- **Agent loop and tool-calling flow** — the whole PTC seam *is* a tool-calling flow one level down: a program calls host bindings across a control channel, the host dispatches them to real functions, and the result crosses back as a typed reply (`packages/ptc-runtime/ptc-runtime-node/src/bindings.ts:63`). The reply is a *promise of a value*, never a promise of a future effect, and a rejection names the failing member (`toolName`) so the model can branch on it.
- **Reasoning / thinking content** — **not present in this shard.** No provider here carries reasoning deltas; the PTC program is a program, and the SSH family carries bytes. The closest analogue is the console shim's five methods, which is output capture, not thinking capture.
- **Prompt construction and caching** — only obliquely: every package README in this shard carries an explicit "KV Cache effect" section, and the answer is the same everywhere — "No direct invalidation; the named consumer owns any request-prefix changes" (e.g. `packages/ptc-runtime/ptc-runtime-node/README.md:154`). No prefix-stability or cache-hit machinery is implemented here; it is explicitly delegated to the consumer.
- **Context window management and compaction** — not present, but the **output ledger** is the transferable analogue: `packages/ptc-runtime/ptc-runtime-node/src/output-ledger.ts:13` meters one run's whole outer result against a single byte cap and, on overflow, retains the longest fitting prefix rather than truncating blindly. That is the same shape as August's tool-result spill.
- **Model-specific adaptations and fallbacks** — not *model*-specific here, but *mode*-specific, and the mechanism is the one August's per-model `toolSurface` profiles would use: the provider owns the rules (`executionInstructions`, `packages/ptc-runtime/ptc-runtime-node/src/index.ts:46`) and the consumer appends them to the model-visible schema without inferring anything from a descriptor.
- **Memory / learning** — the shard's memory is *process* memory: the retained REPL (`packages/ptc-runtime/ptc-runtime-node/src/persistent.ts:283`), which is explicitly **not durable** ("Restart, Agent disposal, provider unload, cancellation, timeout, protocol failure, output overflow, or process exit clears it"). No durable learning mechanism appears here.
- **Subagent / parallel execution** — the owner model is a per-object environment: `owners: WeakMap<object, Kernel>` (`packages/ptc-runtime/ptc-runtime-node/src/persistent.ts:291`). Distinct owners run concurrently; one owner cannot (the run is refused with 'concurrent runs for one state owner'), and different object identities never share an environment. That is the isolation/parallelism contract a subagent pool needs.
- **Tool-call reliability** — dense here: strict frame validation on both sides, an orthogonal failure taxonomy, no replay of ambiguous mutations, a capacity class reserved for cleanup, a credit held until the far side acknowledges cleanup, an actionable error text, and a bounded-output rule that retains a prefix instead of truncating mid-word.
- **UI / UX patterns** — minimal but real: a five-method console shim (`packages/ptc-runtime/ptc-runtime-node/src/bootstrap.ts:110`) chosen so the model recognises its own output; provider-owned `executionInstructions` written in the second person; and failure messages written as instructions ("reacquire the current tool", "retained variables were cleared").
- **Config** — `packages/ptc-runtime/ptc-runtime-node/src/config.ts:31` is the model: a schemastery schema with defaults, a discriminated `launch` union, and a `validateConfig` that names the offending key. `packages/ssh/ssh/src/index.ts:91` adds a second zod validation layer with absolute-path and digest-format requirements before anything is spawned.
- **Evals / testing** — the shard's testing culture is the strongest signal: every failure mode has a named test; the built artifact has its own e2e path (`tests/built-lib.e2e.ts`); the SSH family has a real-host acceptance lane (`tests/live.e2e.ts`) and an adversarial *attacker* test (`tests/stream-rebind.spec.ts`); and the artifact verifier runs the real product and reports a named check list.

## Files skipped (with reasons)

None. All 133 files in the shard were opened and read in full, including every test, README, locale file, `package.json`, `tsconfig.json` and Docker/sshd fixture. The largest file is `packages/ptc-runtime/ptc-runtime-node/tests/persistent-host.spec.ts` (570 lines); the whole shard is 14 393 lines. Nothing was skipped for size, and nothing is generated, vendored or binary.

## Uncertainties

- **`packages/ptc-runtime/ptc-runtime-node/src/bindings.ts` was read late.** My first pass over the manifest listed the shard as 133 files and I mis-scanned the leading `src/bindings.ts` row as belonging to another shard; I caught it when cross-checking my read list against the manifest and read it. It is now covered (see its per-file note), and it is the source of two of the ideas above — but the *first* pass of the shard shape was written before that file was read.
- **The PTC consumer is outside this shard.** `dsh-tools`' PTC mode, `dsh-workflow-ptc`, the `run_code` tool registration and the `docs/subsystems/ptc-runtime.md` reference are all outside `dsh-remote-ptc`. I could therefore verify the *seam's* contract but not the consumer's use of it: how `run_code` renders `executionInstructions`, how the model-visible schema is assembled, and whether the model-facing `timeout` override is really restricted to positive numbers (the README asserts it; I could not check the code).
- **`experimental/ptc-runtime-python` is not in this shard**, so the Python backend's fd-3 protocol and its actual enforcement of the portable-identifier sets are asserted only by the *commentary* in `packages/ptc-runtime/ptc-runtime/src/index.ts`. The set contents are pinned by `tests/reserved.spec.ts`, but the Python backend's own validation was not read.
- **`packages/ssh/ssh/tests/live.e2e.ts` is an opt-in acceptance suite** gated on `DSH_SSH_TEST_CONFIG` / `DSH_SSH_TEST_BOOTSTRAP` / `DSH_SSH_TEST_LSP`. I read it but could not run it (nothing in the clone was executed), so the claims it makes about real SSH hosts, real cgroup scopes and a real remote LSP are *test intentions*, not observations I made.
- **The SSH "same-user attacker" result is a test assertion, not a measurement I made.** `tests/stream-rebind.spec.ts` and `tests/inspector-signal.spec.ts` both assert a negative security property; I verified that the tests exist and assert it, not that the property holds on this machine.
- **`dsh-sandbox-local`'s `classifyRunnerFailure` / `isRunnerSpawnFailure` semantics are outside this shard.** I read how the PTC provider *uses* them (`packages/ptc-runtime/ptc-runtime-node/src/index.ts:272`, `:337`) and the failure rules they consume (`runnerFailureRules` with `allowedExitCodes` / `fatalSignatures` / `informationalLines`), but the classifier itself lives in `packages/sandbox/sandbox`, which I did not read.
- **`SubprocessHandle` / `OutputCollector` / `prepareManagedProcessBinding` come from `dsh-subprocess` and `dsh-subprocess-local`**, outside this shard. I read their *use* here (the collector's `maxBytes`/`spill` contract, `waitForExit` semantics, `readFrom(offset)` returning `{text, nextOffset, lossy}`), but the implementations are elsewhere.
- **`dsh-timeout`'s `clampTimeout` and `MAX_TIMER_DELAY_MS` are outside this shard.** I read the *call shape* (`clampTimeout(request.timeoutMs, default, max, label)` at `packages/ptc-runtime/ptc-runtime-node/src/index.ts:94`) and that the label appears in the thrown message, but not the clamping rule itself.
- **`dsh-util-values`'s `snapshotJsonValue`** is the canonical JSON boundary that `packages/ptc-runtime/ptc-runtime-node/src/bindings.ts:66` and the `json-wire.spec.ts` differential test both defer to. I read the differential test's assertions but not the canonical implementation, so I can say the two agree *as the test asserts it*, not why.
- **I could not find any thinking/reasoning, prompt-construction, KV-cache, or compaction code in this shard.** I grepped the shard's own sources for those concerns and found only the per-README "KV Cache effect" disclaimers. If August needs those lenses from deepseek-harness, they live in `dsh-llm`, `dsh-compaction` or `dsh-core` — not in `dsh-remote-ptc`.
