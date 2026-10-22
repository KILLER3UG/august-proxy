# deepseek-harness / dsh-shell#2

## Shard shape

This shard is the whole `packages/workflow` group of the deepseek-harness monorepo — 51 files across three packages plus a group map — and it is the harness's **model-authored orchestration** feature: the model writes a JavaScript script that fans work out to subagents and returns one JSON value. The layering is a textbook capability seam with three layers. `packages/workflow/workflow` is the **seam**: an abstract `WorkflowEngine` Cordis service (`ctx.workflowEngine`), the run/result/event vocabulary, and a closed `WorkflowError` taxonomy whose `fatal` flag decides whether a combinator re-throws or nulls an item. `packages/workflow/workflow-ptc` is the **engine**: it executes the model-written script inside a sandboxed Node PTC process under the calling Session's captured file policy, translating it into `ctx.subagents` activations through a JSON binding channel, and shipping the guest as a single self-contained ESM bundle inlined as source. `packages/workflow/tool-workflow` is the **model-facing consumer**: it registers the `workflow` tool, owns the tool schema, the `tool:<name>` system-prompt guidance, the foreground/background execution lifecycle, the durable session records, and the presentation card. The tenth file of the group, `packages/workflow/README.md`, is the map. Roughly half the shard is test code, and the tests are where the real design reasoning is recorded — cancellation races against provider publication, the "one `agent-end` per `agent-start`" pairing invariant, the "a broken provider is not a failed child" distinction, and a recurring insistence that any failure-reporting path be *total* (an error whose `toString` throws must still be reportable).

## Per-file notes

### packages/workflow/README.md
- Purpose: Group map for `packages/workflow` — a three-row table naming each package, its role, and the `ctx` key it registers on.
- Key abstractions: `ctx.workflowEngine` (the seam), `ctx.tools` (the model-facing consumer).
- Data flow: Pure documentation; points at `docs/subsystems/workflow.md`, the generated tool/config catalogs, and the archived "Dynamic workflows" Agent Note.
- Non-obvious design decisions: The map states the ownership split explicitly — "Workflow hooks and child lifecycle remain owned by the workflow engine" while the tool only owns the model-facing surface.
- Edge cases / failure handling: n/a.
- Surprising: The group is named `workflow` but the feature is really *scripted fan-out*; the map says the `workflow` tool "supports scripted fan-out", and points at a sibling `ralph` tool (opt-in, disabled by default) as the fixed-fresh-agent-loop alternative.

### packages/workflow/README.zh.md
- Purpose: Chinese mirror of the group map.
- Key abstractions: Same three-package table, same `ctx` keys.
- Data flow: Links to the `.zh.md` twins of the same subsystem/tool/config catalogs.
- Non-obvious design decisions: Mirrors the English statement that workflow hooks and child lifecycle stay with the engine.
- Edge cases / failure handling: n/a.
- Surprising: The zh version is line-for-line parallel to the English (53 lines each), which the `.i18n.yaml` hash record enforces.

### packages/workflow/README.i18n.yaml
- Purpose: Bilingual-pair consistency record — one 8-hex hash per heading section for the English and Chinese blocks, outside code fences and generated regions.
- Key abstractions: Section paths as YAML keys (`/packages-workflow/summary`).
- Data flow: `pnpm run verify-translation-pairing --write packages/workflow/README.md` regenerates it.
- Non-obvious design decisions: Pairing is *hash-based per section*, not per file, so a translation may lag structurally without being rejected wholesale; the comment names the exact command to re-record.
- Edge cases / failure handling: The header comment says "After editing either side, bring the other along and re-record".
- Surprising: This is a **doc-drift detector as a static gate** — the same idea August applies with `check:docs`.

### packages/workflow/workflow/src/types.ts
- Purpose: The browser-safe durable vocabulary of the workflow seam — run id, meta block, phases, stop reason, result, and the four `workflow/*` event payload shapes.
- Key abstractions: `WorkflowRunId` (branded string + brand factory), `WorkflowMeta`, `WorkflowPhase`, `WorkflowStopReason` (closed union `completed | cancelled | error`), `WorkflowResult`, `WorkflowRunInfo`, `WorkflowAgentInfo`, `WorkflowAgentOutcome`, `WorkflowResultInfo`.
- Data flow: Types only; consumed by the tool, the engine and the session-record projector.
- Non-obvious design decisions: `WorkflowResultInfo` deliberately **omits the result value** — "a listener observing outcomes must not receive a mutable alias of the caller's result value; a consumer that needs the value holds the run and awaits `result`" (types.ts:118-124). And `agentsStarted` is documented as degrading from the script-side count to the host-observed count on a termination path, because "calls queued inside a terminated script are unknowable then" (types.ts:79-86).
- Edge cases / failure handling: The `WorkflowStopReason` union is documented as CLOSED and "engine-owned, consumers may exhaust".
- Surprising: `WorkflowPhase.provider`/`model` are marked **informational only** — phases "impose no execution structure"; they are progress vocabulary for observers/UIs, and `phase()` calls match by exact string.

### packages/workflow/workflow/src/runtime-types.ts
- Purpose: Host-only request and live-run handles, split out so browser-safe Client programs never import Agent or host Cordis declarations.
- Key abstractions: `WorkflowStartRequest` (`script`, `meta`, `args?`, `subagentProvider?`, `maxTotalAgents?`, `parent`, `signal?`), `WorkflowRun` (`id`, `meta`, `result`, `cancel(reason?)`, `dispose()`).
- Data flow: The tool builds a `WorkflowStartRequest`; the engine returns a `WorkflowRun`; the tool awaits `result` and calls `dispose()` on every path.
- Non-obvious design decisions: `parent` is **required** because "every `agent()` spawned by the script is attributed to that live Agent" (runtime-types.ts:16-18). The seam contract states `result` **never rejects** — failures resolve as a `stopReason`, so consumers cannot leak an unhandled rejection.
- Edge cases / failure handling: `dispose()` is documented as idempotent and must be called on every path to await script and child cleanup.
- Surprising: The `script` field is typed `string` but its doc comment reads "top-level await allowed" — the script is JavaScript source, not code-as-data; only `meta` and `args` are plain JSON.

### packages/workflow/workflow/src/index.ts
- Purpose: The service definition for the workflow capability seam: the `ctx.workflowEngine` registration, the six `workflow/*` Cordis event declarations, and the `WorkflowError` taxonomy.
- Key abstractions: `WorkflowEngine` (abstract Cordis `Service`), `WorkflowError` (extends `HarnessError`, carries `fatal`), `isFatalWorkflowError()`, `WorkflowErrorCode` (11 codes), `WorkflowEventName`.
- Data flow: Engines call the protected `emitWorkflowEvent(name, ...args)`; Cordis dispatches to listeners; the tool's recorder and mirror subscribe.
- Non-obvious design decisions: **Listener containment is per-listener and total** (index.ts:175-186): each listener is called inside its own `try`, a rejected thenable is caught via `Promise.resolve(returned).catch(...)`, and the error render itself is wrapped so that even a throwing `String(error)` yields `'[unrenderable thrown value]'` (index.ts:194-201). The `fatal` flag "exists so the distinction is explicit at every catch site rather than implied" — every `WorkflowErrorCode` is fatal today.
- Edge cases / failure handling: `emitWorkflowEvent` never lets a listener failure change execution or starve peers; the comment in the package README notes each listener also receives its own payload clone.
- Surprising: The `WorkflowError` doc says fatality is decided by host `instanceof` and is therefore "unforgeable from a script realm" — the seam uses *type identity* as an authority boundary, not a flag the script could set.

### packages/workflow/workflow/tests/workflow.spec.ts
- Purpose: Interface-level tests for the seam: brand identity, error taxonomy, service registration/unregistration, and the listener-containment contract.
- Key abstractions: A `StubEngine` subclass that exposes the protected `emitWorkflowEvent` to tests.
- Data flow: Builds a bare `Context`, loads `StubEngine`, dispatches events, asserts on a recorded payload array.
- Non-obvious design decisions: The suite contains a **totality test**: a listener throwing an object whose `toString` throws must neither propagate nor starve later listeners, and the warning must read `[unrenderable thrown value]` (spec.ts:108-124). A separate test pins that a *rejected* (async) listener does not starve peers either (spec.ts:72-90).
- Edge cases / failure handling: HMR safety is pinned — the service unregisters when its fiber is disposed (spec.ts:46-52).
- Surprising: The `seen` array in the dispatch test records only `workflow/log` and `workflow/agent-start` — the other three events are dispatched with no listener, which is itself the containment test.

### packages/workflow/workflow/package.json
- Purpose: Manifest for `@deepseek-ai/dsh-workflow` v0.2.1-rc.2 — exports `.` and `./types`, publishes `lib/` only.
- Key abstractions: peer/dev dependency set (`dsh-agent`, `dsh-brand`, `dsh-llm`, `dsh-session`, `cordis`).
- Data flow: n/a.
- Non-obvious design decisions: `"./src/*": "./src/*"` is exported, so consumers can import raw sources — a monorepo convention for tests.
- Edge cases / failure handling: n/a.
- Surprising: The package publishes **types separately** from JS (`lib/types/**`), i.e. it is a types-only seam package: the engine implementations live in other packages.

### packages/workflow/workflow/tsconfig.json
- Purpose: TypeScript project config for the seam package.
- Key abstractions: Project references to `vendor/cosmokit`, `vendor/cordis`, `core/agent`, `core/session`, `util/brand`, `llm/llm`.
- Data flow: `rootDir: src` → `outDir: lib/types`.
- Non-obvious design decisions: The reference list is the package's actual dependency surface, made explicit for the build graph.
- Edge cases / failure handling: n/a.
- Surprising: Emits **types only** (`outDir: lib/types`), matching the types-only seam.

### packages/workflow/workflow/README.md
- Purpose: Package reference for the seam — the contract a consumer programs against.
- Key abstractions: `ctx.workflowEngine.start({script, meta, args?, parent, signal?})`, the five script hooks (`agent`, `parallel`, `pipeline`, `phase`, `log`), the result envelope `{runId, agentsStarted, result}`.
- Data flow: The document is the narrative spec for the whole group; the tool and engine implement it.
- Non-obvious design decisions: The **failure discipline** section (README.md:87-91) states the split precisely: hook misuse "kills the script loudly rather than dissolving into a per-item `null`", while "a child that resolves normally with a non-completed stop reason is not an infrastructure exception: `agent()` returns `null`". Known Limits are stated as *current constraints, not a task backlog*.
- Edge cases / failure handling: Lists "No journaling or resume — scripts, child progress, and intermediate values are not checkpointed, so a process restart cannot continue a run".
- Surprising: The "Model Experience" section for this package is almost empty ("Indirectly, through its consumer") — the seam deliberately owns **no** model-facing surface, and the README says so rather than padding.

### packages/workflow/workflow/README.zh.md
- Purpose: Chinese mirror of the seam's package reference.
- Key abstractions: Same five hooks and start-request shape.
- Data flow: n/a.
- Non-obvious design decisions: Adds one sentence the English has only implicitly: loading a second engine "fails loudly, so swapping engines means changing which engine plugin the composition loads".
- Edge cases / failure handling: n/a.
- Surprising: The zh text is 142 lines against the English 142 lines — the translation is line-parallel, which the hash record enforces.

### packages/workflow/workflow/README.i18n.yaml
- Purpose: Per-section bilingual hash record for the seam's README.
- Key abstractions: 30 heading paths with paired `en`/`zh` hashes.
- Data flow: Regenerated by `pnpm run verify-translation-pairing --write packages/workflow/workflow/README.md`.
- Non-obvious design decisions: The `known-limitations-and-deferred-work/dev-note` path is nested under the limitations section — the hash key mirrors the heading hierarchy exactly.
- Edge cases / failure handling: n/a.
- Surprising: Two of these hash pairs are **identical across three different packages** (`d152484eb41ac6b4`/`09388d293f9be9cb` appears as the table-of-contents hash in both the seam and the PTC engine) — the "Table of Contents" boilerplate is identical across package READMEs.

### packages/workflow/tool-workflow/src/index.ts
- Purpose: The model-facing `workflow` tool: registers the tool with its schema, owns the foreground and background run lifecycles, wires the durable session recorder and the job-ring mirror.
- Key abstractions: `DESCRIPTION` (the script-authoring contract embedded in the tool description), `WorkflowCallArgs`, `presentWorkflowCall`/`presentWorkflowResult`, `stopReasonError`, `jobOutcomeOf`, `renderResult`, `startBackgroundRun`, `createWorkflowRecorder`.
- Data flow: Model calls the tool → `ctx.workflowEngine.start(...)` → await `run.result` → map `stopReason` to an `isError` tool result or the `{kind:'foreground', runId, agentsStarted, result}` envelope → `ctx.tools` renders it via the `output.render` closure.
- Non-obvious design decisions: **(a)** The background branch deliberately gives the run **no tool-step signal** — "the run belongs to the job, so a registry kill or owner teardown is what cancels it" (index.ts:250-252); the foreground branch *does* bridge `exec.signal` → `run.cancel('parent step aborted')` (index.ts:450-451). **(b)** The background run is started **inside** the job starter, so a synchronous engine rejection registers no job at all (index.ts:281-291). **(c)** Usage guidance ships as the tool plugin's own prompt section, never as deployment persona prose (index.ts:324-330). **(d)** A non-`completed` stop reason becomes an `isError` result that reports the *reason*, never partial output.
- Edge cases / failure handling: `exec.agent` missing → "workflow tool requires a calling agent (exec.agent was undefined)" (fail loud rather than guess). `maxResultChars` truncation appends `… [truncated: N more characters]`. `enableRunInBackground: false` both hides the parameter and rejects the call. The output schema is a `oneOf` over `kind: 'background'` / `kind: 'foreground'` with `additionalProperties: false`.
- Surprising: `presentResult` deliberately throws away both its arguments and returns `{card: 'generic'}` — the completed card is a pure function of args, so a reload/replay renders identically.

### packages/workflow/tool-workflow/src/record.ts
- Purpose: Live-progress mirror that streams the engine's `workflow/phase`, `workflow/log` and member lifecycle events into a background run's owning job output ring.
- Key abstractions: `WorkflowRecordMirror` (`start(runId, job)` / `stop(runId)`), `createWorkflowRecordMirror(ctx)`.
- Data flow: Engine event → `ctx.on(...)` → `job.append(line, {channel: 'log'})` and `job.updateProgress(title)`.
- Non-obvious design decisions: **Every line rides the `log` channel**, so the model's `job_output` before settlement sees status only — narration is observer-only (asserted at tool-workflow.spec.ts:497-507). The mirror subscribes **once per plugin** and routes by `run.id`, so a straggling event after settlement finds no tracked run and is dropped.
- Edge cases / failure handling: "Appends against a settled job log and drop inside the registry, so a straggling event after settlement is harmless."
- Surprising: `workflow/phase` does two things at once — it updates the job's *progress line* (the human-visible one-liner) and appends a `▸ title` line to the ring.

### packages/workflow/tool-workflow/src/types.ts
- Purpose: The four log-only durable session events the tool writes into its calling parent Session, plus their `SessionEventMap` declaration.
- Key abstractions: `ToolWorkflowRunStartData`, `ToolWorkflowAgentStartData`, `ToolWorkflowAgentEndData`, `ToolWorkflowRunEndData`.
- Data flow: The recorder appends these into `parent.session`; the Web transcript is derived from them.
- Non-obvious design decisions: The payloads are deliberately **minimal** — `agent-end` carries only `{runId, seq, outcome}`, not the child's text, so the session log stays a lifecycle log rather than a transcript. All four are `readonly`.
- Edge cases / failure handling: n/a (types only).
- Surprising: This is the only place in the group that *augments another package's* event map (`@deepseek-ai/dsh-session/types`) — the tool package owns the durable record vocabulary even though the engine owns the run.

### packages/workflow/tool-workflow/tests/tool-workflow.spec.ts
- Purpose: The tool's full behavioural suite — foreground lifecycle, durable records, abort bridging, truncation, HMR, and the whole `run_in_background` path against a real `LocalJobRegistry` plus `dsh-tool-jobs`.
- Key abstractions: `StubEngine` (a controllable `WorkflowEngine` with `requests`, `cancels`, `disposed`, `disposeBarrier`, `disposeError` and a per-run `settlements` map), `setup()`, `setupBackground()`.
- Data flow: Executes the tool through the real `ctx.tools.execute(...)` with a synthetic `Agent` and a real `Session`.
- Non-obvious design decisions: The suite pins **the exact durable-record sequence** (`run-start`, `agent-start`, `agent-end`, `run-end`) and that `run-end` is written **only after disposal reaches quiescence** (spec.ts:183-199, using a `disposeBarrier`). It also pins the **first-append-failure isolation** per event type: the expected surviving prefix is a hard-coded table, and a failure at `run-end` still leaves `run-start, agent-start, agent-end` (spec.ts:238-277). Two real-engine composition tests run against the sandboxed PTC engine, including one where the script parks forever on a promise and an abort must still release the tool (spec.ts:624-655).
- Edge cases / failure handling: Asserts the tool's own abort bridge (`'parent step aborted'`), the already-aborted-before-dispatch path (`TOOL_ABORTED_BEFORE_DISPATCH`, engine never touched), the missing-`exec.agent` refusal, a `dispose()` that throws (warned, never rejected into the registry), and a nested transport call that records no workflow events but still records job lifecycle.
- Surprising: The background test asserts the ring content byte-for-byte (`'▸ Scan\n3/10 found\nagent #1 scan a.ts started\nagent #1 completed\n'`) — the ring format is treated as a contract.

### packages/workflow/tool-workflow/package.json
- Purpose: Manifest for `@deepseek-ai/dsh-tool-workflow` v0.2.1-rc.2; exports `.`, `./types`, `./src/*`, `./locale/*.json`.
- Key abstractions: peer deps include `dsh-workflow`, `dsh-jobs`, `dsh-system-prompt`; the only runtime dependency is `schemastery`.
- Data flow: n/a.
- Non-obvious design decisions: The dev-dependency list is the *composition* the tests build — `dsh-jobs-local`, `dsh-tool-jobs`, `dsh-subagent`, `dsh-workflow-ptc`, `dsh-session-projection` — i.e. the package declares its own integration environment.
- Edge cases / failure handling: n/a.
- Surprising: `publishConfig.access: public` — this is a published npm package, not an internal-only plugin.

### packages/workflow/tool-workflow/tsconfig.json
- Purpose: TypeScript project config for the tool package.
- Key abstractions: References `vendor/schemastery`, `core/tools`, `core/system-prompt`, `jobs/jobs`, and `../workflow`.
- Data flow: `rootDir: src` → `outDir: lib/types`.
- Non-obvious design decisions: The reference list doubles as the tool's *contract surface* — it depends on the seam, the tools registry, the system-prompt service and the jobs registry, and nothing else.
- Edge cases / failure handling: n/a.
- Surprising: `core/session` is referenced but `core/subagent` is not — the tool never touches subagents directly; it only passes `exec.agent` to the engine.

### packages/workflow/tool-workflow/README.md
- Purpose: Package reference for the model-facing tool — the observable contract (call shape, envelopes, exact rendered strings) plus an implementation section and a Model-Experience section.
- Key abstractions: `{kind:'foreground', runId, agentsStarted, result}` vs `{kind:'background', jobId, runId}`; config `toolName` / `maxResultChars` / `enableRunInBackground`.
- Data flow: Documents the foreground path ("the tool starts the run, awaits its result, and always disposes it") and the background path (the run is registered on `ctx.jobs`; the job's output ring streams `phase()`/`log()`/member lines live; the row's progress line tracks the current phase).
- Non-obvious design decisions: **"The model sees one final outcome, never intermediate child messages; the children's own work stays out of the parent conversation"** (README.md:38) — the fan-out's whole point is that it does not pollute the parent context. The README also states that a background run gets **no tool-step signal** and that "job_kill, the list's stop control, and owner teardown are what cancel it".
- Edge cases / failure handling: Known Limits state "A background run reports no intermediate value to the model", "`args` must be an object and Native result text is bounded", "Durable records are top-level and observational".
- Surprising: The **Model Experience** section is a template applied to three surfaces — system prompt, tool schema, tool-call history — each with "What the model sees / Token effect / KV Cache effect" sub-headings (README.md:112-161). The KV-cache entries are unusually precise: the prompt section is "Prefix-stable while the plugin scope and guidance text are unchanged", the schema is "Prefix-stable while `toolName`, definition, and visibility are unchanged", and the tool-call history is "Append-only; newly visible content follows the reusable request prefix".

### packages/workflow/tool-workflow/README.zh.md
- Purpose: Chinese mirror of the tool's package reference.
- Key abstractions: Same two envelopes and three config fields.
- Data flow: n/a.
- Non-obvious design decisions: Preserves the exact rendered English strings inside the Chinese prose (e.g. the background acceptance message), because the model sees those strings verbatim.
- Edge cases / failure handling: n/a.
- Surprising: The zh text keeps `… [truncated: <omitted> more characters]` in English — the truncation notice is a model-facing artifact, not prose.

### packages/workflow/tool-workflow/README.i18n.yaml
- Purpose: Per-section bilingual hash record for the tool's README (40 heading paths).
- Key abstractions: Section paths including `model-experience/tool-call-history-and-result/kv-cache-effect`.
- Data flow: Regenerated by the pairing verifier.
- Non-obvious design decisions: The hash keys mirror the *Model Experience* subsection hierarchy, so a drift in the KV-cache paragraph alone is caught.
- Edge cases / failure handling: n/a.
- Surprising: `model-experience` for the tool shares its hash with the PTC engine's `model-experience` (`215e7bdb6dfe7779` / `a311da3843709f90`) — the "## Model Experience" heading plus its intro are identical boilerplate across packages.

### packages/workflow/tool-workflow/locale/en.json
- Purpose: English locale strings for the tool package.
- Key abstractions: `meta.title` = `"tool-workflow"`.
- Data flow: n/a.
- Non-obvious design decisions: The English locale carries only a title; the Chinese one also carries a description — an asymmetry, not an omission (see below).
- Edge cases / failure handling: n/a.
- Surprising: Five lines of JSON for a whole package's localisation.

### packages/workflow/tool-workflow/locale/zh.json
- Purpose: Chinese locale strings for the tool package.
- Key abstractions: `meta.title` = `"工作流工具"`, `meta.description` = `"让 AI 编写并运行 JavaScript 脚本，编排多项工具操作。"`
- Data flow: n/a.
- Non-obvious design decisions: The zh description says "AI" where the repo elsewhere says "agent"/"智能体" — this file predates the vocabulary alignment.
- Edge cases / failure handling: n/a.
- Surprising: The zh description is **inaccurate** relative to the current implementation: the script orchestrates *subagents*, not "工具操作" (tool operations). A stale locale string.

### packages/workflow/workflow-ptc/src/index.ts
- Purpose: The PTC-backed workflow engine: config, request validation, run creation, and the `workflow/*` event emission.
- Key abstractions: `PtcWorkflowEngine` (extends the seam's `WorkflowEngine`), `Config` (`provider`, `maxConcurrentAgents`, `maxTotalAgents`, `maxItemsPerCall`, `syncTimeoutMs`), `assertBodyParses`, `resolveSubagentProvider`, `resolveMaxTotalAgents`.
- Data flow: `start(request)` → `validateMeta` → host-side parse → provider/limit resolution → `new PtcWorkflowRun(...)` → `workflow/start` → `run.result.then(...)` → `workflow/end`.
- Non-obvious design decisions: **(a)** `maxConcurrentAgents: 0` auto-resolves to `min(16, max(1, availableParallelism() - 2))` — a machine-derived default rather than a magic number (index.ts:142-144). **(b)** A per-run `maxTotalAgents` may only **lower** the engine ceiling; asking for more is `INVALID_ARGUMENT`, not a silent clamp (index.ts:83-95). **(c)** The engine **captures** `ctx.subagents` and `ctx.ptcRuntime` into local consts at start time so an accepted run survives engine unload (index.ts:156-167). **(d)** `args` is `structuredClone`d at start (index.ts:152).
- Edge cases / failure handling: A body still carrying `export const meta = {...}` gets a pointed message rather than a bare SyntaxError (index.ts:48-58). A non-TypeScript PTC runtime is rejected **at load time** (index.ts:118). `timeoutMs: null` is requested from PTC — "the engine adds no overall elapsed timer".
- Surprising: The host **re-parses the same wrapper the guest compiles** ("Parse only — the script object is discarded, nothing executes", index.ts:60-61) so a syntax error is reported by the engine before a run is ever published.

### packages/workflow/workflow-ptc/src/host.ts
- Purpose: Host side of the PTC engine — the PTC execution, child ownership, progress decoding, settlement and disposal.
- Key abstractions: `PtcWorkflowRun` (implements `WorkflowRun`), `ChildRecord`, the PTC binding set (`begin`, `startChild`, `childResult`, `disposeChild`, `progress`), and the decoders `object`/`text`/`json`/`childRequest`/`agentInfo`/`progress`/`workflowResult`.
- Data flow: Guest calls `host.begin({})` → receives `WorkerInit`; guest calls `host.startChild(request)` → host calls `ctx.subagents.startActivation(...)` → guest calls `host.childResult({callId})` → host awaits `record.run.result`; progress arrives as a **batch** of `WorkflowProgress` events.
- Non-obvious design decisions: **(a)** The PTC guest is loaded as a `data:text/javascript,` URL with the bundle inlined (host.ts:26-27). **(b)** The guest sends progress as **ordered batches**, and the host validates every event in the batch before dispatching (host.ts:90-93). **(c)** A child that publishes *after* cancellation is disposed immediately and the start throws "workflow child started after cancellation" (host.ts:222-228). **(d)** `endAgent` deletes from `liveAgents` before emitting, so **exactly one** `agent-end` fires per observed `agent-start` (host.ts:273-276). **(e)** The `finally` block disposes published children, drains the pending set, then awaits every child's disposal, then synthesises `outcome: 'cancelled'` for any agent still live (host.ts:307-317).
- Edge cases / failure handling: `childResult` races the child's result against the abort signal so a cancelled run stops *waiting* for output. A runtime with no confinement is accepted only for `danger-full-access` — "workflow runtime cannot enforce the ${mode} file policy" (host.ts:287-289). Every inbound value is re-validated on the host side (a malformed `progress` batch, an unknown `callId`, a non-JSON child result) rather than trusted.
- Surprising: The host keeps **pending starts** and **accepted Activations** in different structures, and cancellation aborts pending starts while disposing accepted ones — "a child that becomes ready after cancellation is also disposed". This is the classic "publication race" that most harnesses leak.

### packages/workflow/workflow-ptc/src/runtime.ts
- Purpose: The VM evaluation and the five script hooks — `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()` — with the concurrency slots, caps, option validation and result serialization.
- Key abstractions: `WorkflowExecution`, `ExecutionObserver`, `SUPPORTED_AGENT_OPTIONS` / `DEFERRED_AGENT_OPTIONS`, `outputText`, `defaultLabel`, `contain`.
- Data flow: The constructor compiles `(async () => {\n<body>\n})()` into a `vm.Script` and creates a fresh `vm.createContext({})`; `drive()` runs it with `timeout: syncTimeoutMs`, materializes the return value, and resolves a `WorkflowResult`.
- Non-obvious design decisions: **(a)** The combinators distinguish fatal from ordinary: `if (isFatalWorkflowError(error)) throw error; return null` (runtime.ts:304-305, :336-337), with the comment "Hook failures are WorkflowErrors built OUTSIDE the script's realm; fatality is recognized by `instanceof` against this realm's class — a script-built object can never pass it, so fatality cannot be forged (nor accidentally dissolved)." **(b)** `contain()` attaches a no-op rejection consumer *without changing what the caller receives* (runtime.ts:122-125). **(c)** A child that *failed* resolves `null`, but a child whose result *rejected* is a fatal `AGENT_RESULT` (runtime.ts:194-206). **(d)** Concurrency slots are acquired FIFO from a waiter queue (runtime.ts:143-160).
- Edge cases / failure handling: `agent()` requires a non-empty string prompt; options must be plain JSON; unknown option keys are rejected with the supported set named; `effort`/`isolation`/`agentType` get a *distinct* "deferred and not supported" message; schemas outside the enforced subset become `UNSUPPORTED_SCHEMA`; the total-agent cap becomes `AGENT_CAP`; a per-call item overflow becomes `ITEM_CAP`.
- Surprising: `outputText` filters the child's output blocks to `type === 'text'` only — **reasoning blocks never become the `agent()` result** (runtime.ts:37-43; asserted at guest.spec.ts:247). And `defaultLabel` derives a 48-char label from the prompt's first line, so `agent()` calls are legible in the UI without the script labelling them.

### packages/workflow/workflow-ptc/src/realm.ts
- Purpose: Lossless-JSON materialization across the VM realm boundary, plus a total renderer for thrown values.
- Key abstractions: `MaterializeError` (carries `path` + `reason`), `materializeFromRealm`, `renderThrown`, `hasPlainPrototype`.
- Data flow: A realm value → `materialize()` → a plain host copy; a violation → `MaterializeError` with a path-qualified message (`workflow result.answer[0]: non-finite numbers are not JSON data`).
- Non-obvious design decisions: **(a)** Every rejection is **path-qualified** — the error names where the offending value was. **(b)** `Object.defineProperty` (never assignment) is used for the copy, so a `"__proto__"` key becomes an own data property instead of a prototype mutation (realm.ts:139-144). **(c)** The copy uses `Object.keys` (own enumerable string keys) so it matches `JSON.stringify`'s property selection exactly; non-enumerable props are skipped, non-index array props are **rejected** rather than silently dropped. **(d)** Cycles are rejected but a DAG (the same object reused as a sibling) is accepted — the `seen` set is path-scoped, not global.
- Edge cases / failure handling: Rejects functions, symbols (keys *and* values), bigints, non-finite numbers, nested `undefined`, sparse arrays, exotic prototypes (`Date`/`Map`/class instances) and symbol-keyed properties. Root `undefined` is the one accepted undefined (a valueless script return). A **throwing getter** is wrapped as "reading the value threw: …" rather than escaping as an arbitrary error.
- Surprising: `renderThrown` prefers `stack` over `message` and is **total** — a thrown value whose `stack` getter throws, or whose `Symbol.toPrimitive` throws, renders as `'[unrenderable thrown value]'` (realm.ts:24-36).

### packages/workflow/workflow-ptc/src/guest.ts
- Purpose: The guest adapter that runs one workflow VM inside the mounted PTC runtime's Node process.
- Key abstractions: `runWorkflowGuest(host)`, the local `flush`/`send`/`drain` progress machinery, the `ExecutionObserver` and `ChildPort` adapters.
- Data flow: `host.begin({})` → build the observer + child port → `new WorkflowExecution(...).drive()` → `await drain()` → return the result (or a progress-failure result).
- Non-obvious design decisions: **(a)** Progress is **batched with exactly one batch in flight**: `send()` queues, `flush()` ships a batch only when nothing is in flight, and the rest coalesce into the next batch (guest.ts:18-39). The comment: "The first batch reaches the host before a synchronous script can seize its loop." **(b)** A failed progress delivery **fails the whole run** — `progressError` turns the result into `stopReason: 'error'` (guest.ts:69-74). **(c)** `drain()` is awaited *before* disposing a child and before the terminal result, so the host always sees `agent-start` before `agent-end`.
- Edge cases / failure handling: A dropped `agent()` promise gets a no-op `catch` so a child failure cannot become an unhandled rejection (guest.ts:54). Initialization failure rejects *before* any child or progress call (asserted at guest.spec.ts:174-179).
- Surprising: `dispose()` inside the child-port adapter awaits `drain()` first — "Start observers must receive the child while its host registration is still live" — so the ordering guarantee is enforced on the *disposal* path, not only on the happy path.

### packages/workflow/workflow-ptc/src/guest-types.ts
- Purpose: The JSON callback surface between one workflow guest and its owning host run.
- Key abstractions: `StartedWorkflowChild` (`callId` + `childId`), `WorkflowChildRequest`, `WorkflowProgress` (the four-event union), `WorkflowGuestHost` (`begin`, `startChild`, `childResult`, `disposeChild`, `progress`).
- Data flow: The guest calls these five host functions; the host answers with lossless JSON.
- Non-obvious design decisions: The child is addressed by a **host-allocated `callId`**, not by the child's Session id — the guest never learns a provider identity it could misuse. `progress` takes an **array**, which is what makes batching possible.
- Edge cases / failure handling: The doc comments state the contract precisely — `childResult` "REJECTS only when the host reports an infrastructure fault; a child that failed for its own reasons resolves with a non-`completed` stop reason".
- Surprising: The whole guest↔host protocol is five JSON functions — the guest's only capability is to ask the host to start children and to publish progress.

### packages/workflow/workflow-ptc/src/guest-source.ts
- Purpose: **Generated** artifact — the whole workflow guest bundled as one self-contained ESM source string, transported into the PTC Node process.
- Key abstractions: `WORKFLOW_GUEST_SOURCE` (a single string constant), produced by `scripts/gen-workflow-guest.ts` with rolldown.
- Data flow: `host.ts` embeds it as `data:text/javascript,<encodeURIComponent(src)>`; the PTC runtime imports that URL and calls `runWorkflowGuest(workflowHost)`.
- Non-obvious design decisions: The bundle is asserted to import **only Node builtins** and to be **exactly one chunk** ("the workflow guest must bundle into exactly one JavaScript module"), and a `--check` mode rejects a stale committed copy ("workflow guest source is stale; run pnpm gen-workflow-guest"). The eight inlined regions are `realm.ts`, `util/brand`, `llm/error.ts`, `util/values`, `core/tools/json-schema.ts`, `workflow/index.ts`, `workflow-ptc/runtime.ts`, `workflow-ptc/guest.ts` — i.e. the guest carries a **copy** of the enforced JSON-Schema subset validator and the `WorkflowError` class rather than importing them.
- Edge cases / failure handling: The bundle ends with `//# sourceURL=dsh-workflow-guest.js` so stack frames name the guest instead of leaking the `data:text/javascript` URL (asserted at guest.spec.ts:208-230 by running plain Node, because vitest rewrites stack formatting).
- Surprising: I read this file **in full** (it is a 42 KB single-line string; I decoded the `\n` escapes and read it in three chunks). It is not a mystery blob: it is the type-stripped, bundled twin of `runtime.ts` + `guest.ts` + `realm.ts` plus three vendored helper modules. The duplication is real and is the price of shipping a guest with no workspace imports.

### packages/workflow/workflow-ptc/src/types.ts
- Purpose: The guest's input types and the child callbacks the VM helpers consume.
- Key abstractions: `WorkerLimits`, `WorkerInit`, `ChildStartRequest`, `ChildResult`, `ChildHandle`, `ChildPort`.
- Data flow: `WorkerInit` is what `host.begin({})` returns; `ChildStartRequest` is what the guest sends to `host.startChild`.
- Non-obvious design decisions: `ChildResult.stopReason` degrades to plain `string` on the wire because "the seam's `stopReason` union is merge-extensible, so it degrades to `string` on the wire — the runtime only ever branches on `'completed'`" (types.ts:49-53). `ChildHandle.result` "REJECTS only when the host reports an infrastructure fault".
- Edge cases / failure handling: The doc comment distinguishes *rejection* (infrastructure) from *resolution with a non-completed stop reason* (ordinary child failure) — the distinction the whole error taxonomy rests on.
- Surprising: `ChildHandle` exposes `dispose(): Promise<void>` — the guest owns child disposal, and the host's `disposeChild` is the acknowledgement.

### packages/workflow/workflow-ptc/src/meta.ts
- Purpose: Validation and normalization of the caller-provided `meta` block.
- Key abstractions: `validateMetaShape`, `validateMeta`.
- Data flow: `WorkflowStartRequest.meta` (plain JSON data) → `validateMetaShape` → either a violation list or a normalized `WorkflowMeta`.
- Non-obvious design decisions: **(a)** Unknown fields are **rejected by name**, not ignored ("accepted-then-ignored is banned", meta.spec.ts:58). **(b)** Every violation is collected and reported in one throw, not just the first (meta.ts:13-65; pinned at meta.spec.ts:80-88). **(c)** The returned meta is a **normalized copy** built from the validated fields, "so the engine never aliases the caller's object".
- Edge cases / failure handling: `phases` entries are validated entry by entry with indexed paths (`meta.phases[0].title must be a non-empty string`).
- Surprising: The doc comment notes the meta "matches the Claude Code dynamic-workflows meta block" — the shape is deliberately compatible with another product's convention, and `phase()` calls match phase titles by **exact string**.

### packages/workflow/workflow-ptc/tests/setup.ts
- Purpose: Test composition helpers — mount the real Node PTC execution stack with a private working directory and awaited cleanup.
- Key abstractions: `mountPtcRuntime(ctx, mode, executionMode)`, `mountWorkflowRuntime(ctx, options)`, `fakeParent(ctx)`.
- Data flow: Mounts `SessionStore`, `AgentRegistry`, `SessionProjections`, `FileSystem`, `Subprocess`, `Sandbox`, `SandboxPolicy`, `NodePtcRuntime`, `JsonlSessionPersistence` into a fresh `Context`.
- Non-obvious design decisions: Each mount is guarded by `if (!ctx.get('x'))` so the helper composes with a caller that already mounted the service. The temp root is `mkdtemp(join(homedir(), '.dsh-workflow-test-'))` and is removed in `onTestFinished`.
- Edge cases / failure handling: `onTestFinished` disposes the fiber *and* removes the directory, so a failing test cannot leak a temp tree.
- Surprising: The tests deliberately mount the **real** sandbox/subprocess/fs stack rather than stubs — the confinement behaviour under test is OS-level.

### packages/workflow/workflow-ptc/tests/meta.spec.ts
- Purpose: Unit tests for `validateMeta`.
- Key abstractions: `expectInvalid(value, ...fragments)` — asserts the error is a `WorkflowError` with code `META_INVALID` and that the message contains every fragment.
- Data flow: Pure function tests, no Cordis.
- Non-obvious design decisions: The suite pins the **no-aliasing** property explicitly ("accepts a minimal meta and returns a normalized copy (no aliasing of the input)", meta.spec.ts:21-28) and the **every-violation-at-once** property (meta.spec.ts:80-88).
- Edge cases / failure handling: Covers non-object metas (string, `null`, array), empty/mistyped `name`/`description`/`whenToUse`, non-array `phases`, and every per-phase field.
- Surprising: The helper collects fragments so one assertion can demand four independent violations in a single error message.

### packages/workflow/workflow-ptc/tests/realm.spec.ts
- Purpose: Unit tests for the realm materializer and the thrown-value renderer.
- Key abstractions: `inRealm(expression)` — evaluates an expression in a fresh `vm.runInNewContext`; `rejection(value)` — returns the `MaterializeError` message.
- Data flow: Realm values → `materializeFromRealm` → host plain data.
- Non-obvious design decisions: The suite asserts the *trust premise* explicitly: "invokes getters ordinarily — the getter RESULT is what crosses" (realm.spec.ts:38-46). It also asserts that the host `Object.prototype` was **not** polluted by a `"__proto__"` key.
- Edge cases / failure handling: Covers root-undefined acceptance vs nested-undefined rejection, cycles vs DAGs, sparse arrays, non-index array props, non-enumerable props, `Date`/`Map`/class instances, null-prototype objects, and `Symbol.toPrimitive` traps in `renderThrown`.
- Surprising: The suite checks that the materialized copy round-trips through JSON **byte-identically** ("the whole point", realm.spec.ts:29-30) — losslessness is asserted as a round-trip property, not as a type check.

### packages/workflow/workflow-ptc/tests/egress.spec.ts
- Purpose: Proves the script's program-visible environment is empty.
- Key abstractions: `installProxyFromEnvironment` from `dsh-http-proxy` used to install a proxy with a credential canary.
- Data flow: The script reaches `globalThis.constructor.constructor('return process')().env` — a deliberate escape from the VM's withheld globals — and the result must be `{}`.
- Non-obvious design decisions: The test stubs `HTTP_PROXY`/`HTTPS_PROXY` (with `http://fixture:canary@proxy.example:8080` embedded), `WORKFLOW_ENV_CANARY` and `TSX_TSCONFIG_PATH`, then asserts none of them are visible to the script. The script reaches `process` through the constructor chain — i.e. the test does not assume the VM's sandbox holds.
- Edge cases / failure handling: `vi.unstubAllEnvs()` and `disposeProxy()` in a `finally`.
- Surprising: The test's own comment is the design statement — "does not expose ambient credentials, proxy settings or host loader paths". The `constructor.constructor` trick is the harness's own escape hatch, used here as an *attack* to prove the environment is empty.

### packages/workflow/workflow-ptc/tests/host.spec.ts
- Purpose: Host-callback contract tests — every PTC binding's input validation, the sandbox-policy forwarding, cwd retention, and the settlement/cleanup ordering.
- Key abstractions: `ControlledRuntime` (a `PtcRuntime` subclass whose `execute` is injectable and whose `sandboxMode` can be toggled), `setup(execute, language)`.
- Data flow: The test drives the host bindings directly (`bindings.startChild`, `bindings.progress`, …) rather than through a guest, so each callback's contract is tested in isolation.
- Non-obvious design decisions: A table-driven `it.each` over **twelve** malformed callback payloads, each asserting the exact rejection message (host.spec.ts:128-149). The cwd-retention test asserts `ensure` is called **once** and that both the PTC process and the child keep the *captured* directory after the parent moves (host.spec.ts:96-127). The "collects child results without parent delivery" test asserts the run has **not** settled while a child's disposal is still pending (host.spec.ts:187-227).
- Edge cases / failure handling: Also pins: the run settles `cancelled` (not `error`) when the runtime rejects *during* cancellation; a child published after cancellation is disposed exactly once; a child-result wait rejects with `'workflow settled'` after disposal releases it; a non-TypeScript runtime is rejected at plugin load.
- Surprising: The `ControlledRuntime` exposes `sandboxMode` as a getter that tests flip between `'read-only'` and `undefined` to exercise the "no confinement ⇒ only danger-full-access" rule without touching the real sandbox.

### packages/workflow/workflow-ptc/tests/guest.spec.ts
- Purpose: Guest-side tests — the script API surface, progress batching, child-result semantics, option validation and the caps.
- Key abstractions: `fixture(body, overrides, limits)` builds a fake `WorkflowGuestHost` and records `requests`, `events` and `disposed`.
- Data flow: Drives `runWorkflowGuest(host)` directly with a fake host, so no PTC process is involved.
- Non-obvious design decisions: The **coalescing** test asserts that 200 synchronous `log()` calls produce exactly two batches (1 then 199) with a peak of one in-flight acknowledgement (guest.spec.ts:92-127) — the batching contract is pinned numerically. The test "delivers queued child lifecycle events before disposing the published child" asserts `disposed` is still empty while the first batch is unacknowledged.
- Edge cases / failure handling: A rejected progress batch is reported as a workflow error and stops further dispatch; a dropped `agent()` promise is contained; a `childResult` that rejects is a fatal `AGENT_RESULT`; a VM timeout ends the run with `Script execution timed out` *after* emitting the progress it produced; the generated module is imported from a `data:` URL to prove it is loadable, and its stack frames are checked to name `dsh-workflow-guest.js` and **not** leak the `data:text/javascript` URL (run under plain Node, since vitest rewrites stack formatting).
- Surprising: The "does not expose ambient Node globals" test asserts `typeof process`, `typeof setTimeout`, `typeof fetch` are all `undefined` inside the VM — the VM is a real isolation boundary for *globals*, even though the README says it is not a security boundary.

### packages/workflow/workflow-ptc/tests/integration.spec.ts
- Purpose: End-to-end test over the real in-process stack (agent loop, MockAdapter, in-process spawn subagent, PTC runtime).
- Key abstractions: `setup(script)` mounts `mountAgentLoopTestDependencies` + `mountPtcRuntime` + `AgentLoop` + `SubagentRuntime` + the spawn provider and registers a `MockAdapter`.
- Data flow: A real parent agent runs a two-phase workflow script with a prose child and a schema child; the mock adapter answers with scripted responses.
- Non-obvious design decisions: The test asserts that the parent received **no** `followup` and **no** `steer` — "The workflow records its own members and collects their results without adding them to the parent's subagent catalog or sending child settlement notices to the parent model" (integration.spec.ts:60-61). It also asserts both children are gone from `ctx.agents` afterwards (no live child agents remain).
- Edge cases / failure handling: A child that fails against its schema (nudges exhausted) reaches the script as `null`, and the script's `{got: 'null'}` return proves the null path is a *value*, not an error. A 200-`log()` burst test asserts the logs arrive in exact order and the child still starts.
- Surprising: `workflow/agent-start` is asserted to fire only **after** `subagent/start` — the child's Session must already be published before the workflow announces it.

### packages/workflow/workflow-ptc/tests/workflow-ptc.spec.ts
- Purpose: The engine's largest suite — script execution, provider routing, cap enforcement, the full cancellation/termination matrix, process failure, and the service API.
- Key abstractions: `StubProvider` — a scripted `SubagentProvider` over the **real** `SubagentRuntime` registry with `publish()`, `rejectStart()`, `settle()`, `rejectResult()`, an abort listener and a configurable dispose delay; `setup(options)`; `scripted(body, metaExtra)`; `run(ctx, parent, source, args)`.
- Data flow: The provider is real infrastructure; only the child's settlement is scripted.
- Non-obvious design decisions: The `setup()` helper pins `maxConcurrentAgents: 8` with the comment "the auto-resolved default is machine-derived (cores - 2, floored at 1), so tests that expect N children in flight would wedge on small CI runners" (spec.ts:150-153) — a machine-derived default has to be neutralised in tests. The suite has a **120 s describe-level timeout** with `waitFor` polling at 50 ms for the shared-CI-runner reality.
- Edge cases / failure handling: An extraordinary set of races is pinned: an early child result that settles *before* the provider publishes must not announce a lifecycle pair; a start rejection **dominates** a buffered early child outcome ("ACP-style failure can settle result(error) before its session/publication boundary rejects"); a child whose `dispose()` throws synchronously cannot wedge the script; a dispose rejecting an *unrenderable* value still acks; a non-JSON `structured` value from a misbehaving subagent service becomes a fatal `AGENT_RESULT` rather than wedging the bridge.
- Surprising: The suite proves the **cancellation → cleanup → settle** ordering end to end: cancelling emits exactly one `agent-end` per observed `agent-start`, and `workflow/end` is always last. It also proves a holder-owned run survives the engine unloading underneath it (spec.ts:1006-1030) — the "captured service handles" design at `index.ts:156`.

### packages/workflow/workflow-ptc/tests/source-runtime.compat.spec.ts
- Purpose: The "Node compatibility matrix" smoke — runs the *source* PTC runtime (not a stub) with the default workflow config.
- Key abstractions: `setup(mode, executionMode)` over `mountPtcRuntime`.
- Data flow: `args.left * args.right` → 42, through the real PTC process.
- Non-obvious design decisions: The second test writes files **through the sandbox escape** (`globalThis.constructor.constructor('return process')()` → `getBuiltinModule('node:fs')`) to prove the OS-level file policy is enforced on a script that reaches Node: a write inside the workspace succeeds under `workspace-write`, a write outside it does not change the file — and the whole thing runs in **both** `per-call` and `persistent-in-memory` execution modes.
- Edge cases / failure handling: The escape attempt is wrapped in `try {} catch {}` so a blocked write is a normal outcome, not a test failure.
- Surprising: The test asserts confinement *through the model's own escape hatch* — the strongest possible form of the claim.

### packages/workflow/workflow-ptc/tests/workflow-ptc.e2e.ts
- Purpose: The with-key end-to-end test — two *real* children (one prose, one structured) through the real DeepSeek adapter.
- Key abstractions: `harness()` builds a full context with `LlmDeepSeek`, the in-process spawn provider and the PTC engine.
- Data flow: A real `deepseek-v4-flash` parent runs the two-phase script; the structured child goes through the real schema-forced tool.
- Non-obvious design decisions: `describe.skipIf(!process.env.DEEPSEEK_API_KEY)` — the suite is skipped rather than failed without a key. The assertions are **world checks** ("the prose child really answered (a real completion), and the structured child judged it against the REAL schema-forced tool"), not snapshot checks.
- Edge cases / failure handling: 240 s timeout; every child id is checked to be gone from `ctx.agents` after collection.
- Surprising: `judged === null ? null : judged.containsFour` — the e2e deliberately tolerates a null structured result so the test measures the *plumbing*, not the model's compliance.

### packages/workflow/workflow-ptc/tests/built-runtime.e2e.ts
- Purpose: Proves the **published/built** package works — loads `lib/index.js` from a plain-Node driver script, with no workspace source.
- Key abstractions: `built` — a guard that checks `lib/index.js` and the PTC runtime's `lib/index.js` / `lib/process.js` exist; `describe.skipIf(!built)`.
- Data flow: Writes a `driver.mjs` that imports `@deepseek-ai/dsh-workflow-ptc` by **package name**, registers a provider, starts a workflow with a structured child and a file-escape write attempt, and prints `built-runtime-smoke-ok`.
- Non-obvious design decisions: The driver root is `mkdtemp(join(packageRoot, '.built-runtime-'))` — inside the package — so Node resolves the *published* package by name rather than a relative path. The write attempt (`proc.getBuiltinModule('node:fs').writeFileSync(args.outside, ...)`) is expected to be blocked, and the test asserts the outside file is still `'unchanged'`.
- Edge cases / failure handling: 120 s timeout; the temp driver dir and the home temp dir are both removed in `finally`.
- Surprising: This is the shard's only test that proves the **artifact** rather than the source — it is the counterpart of August's `e2e:smoke` gate.

### packages/workflow/workflow-ptc/package.json
- Purpose: Manifest for `@deepseek-ai/dsh-workflow-ptc` v0.2.1-rc.2.
- Key abstractions: peer deps `dsh-workflow`, `dsh-subagent`, `dsh-tools`, `dsh-ptc-runtime`, `dsh-sandbox`, `dsh-sandbox-policy`, `dsh-working-directory`; runtime deps `dsh-brand`, `dsh-util-values`, `schemastery`.
- Data flow: n/a.
- Non-obvious design decisions: `files` publishes `lib/index.js` and `lib/types/**/*.d.ts` — **the JS bundle and the type declarations, but not the `lib/types/**/*.js`**, unlike the two sibling packages. The dev-dependency list is enormous and mirrors the full stack the tests mount.
- Edge cases / failure handling: n/a.
- Surprising: The package depends on `dsh-util-values` (`snapshotJsonValue`, `assertNever`) and `dsh-brand` as *runtime* deps because the host side needs lossless-JSON snapshotting, not only the guest.

### packages/workflow/workflow-ptc/tsconfig.json
- Purpose: TypeScript project config for the PTC engine.
- Key abstractions: References include `subagent/subagent`, `core/tools`, `util/http-proxy`, `ptc-runtime/ptc-runtime`, `sandbox/sandbox`, `sandbox/sandbox-policy`, `session/working-directory`.
- Data flow: `rootDir: src` → `outDir: lib/types`.
- Non-obvious design decisions: The reference list is the engine's actual dependency surface and doubles as documentation of the confinement chain (sandbox + sandbox-policy + ptc-runtime).
- Edge cases / failure handling: n/a.
- Surprising: `util/http-proxy` is referenced — the egress test needs it, and the reference graph tracks test-only deps.

### packages/workflow/workflow-ptc/tsdown.config.ts
- Purpose: The bundler config for the engine's published output.
- Key abstractions: `entry: ['lib/types/index.js']`, `format: ['esm']`, `platform: 'node'`, `target: 'es2024'`.
- Data flow: Bundles the type-checked output into `lib/`.
- Non-obvious design decisions: `dts: false` and `clean: false` — the declarations come from `tsc` (into `lib/types`) and the bundler must not wipe them.
- Edge cases / failure handling: n/a.
- Surprising: `entry` points at `lib/types/index.js` — the bundle is built *from* the tsc output, so type-checking is a gate on the published bundle.

### packages/workflow/workflow-ptc/README.md
- Purpose: Package reference for the PTC engine — config, results/failures, file policy and cancellation, plus the implementation internals and known limits.
- Key abstractions: Config table (`provider`, `maxConcurrentAgents`, `maxTotalAgents`, `maxItemsPerCall`, `syncTimeoutMs`); the composition snippet (`- name: '@deepseek-ai/dsh-workflow-ptc'`).
- Data flow: Documents the capture of the Session's working directory and file policy, the PTC `timeoutMs: null` request, and the "no overall elapsed deadline" rule.
- Non-obvious design decisions: **(a)** "The engine captures the calling Session's effective working directory and standing file policy **separately**" and both are retained "when the parent later moves" (README.md:59). **(b)** "A runtime without confinement is accepted only for `danger-full-access`; `read-only` and `workspace-write` fail before execution." **(c)** "The VM retains the documented helper API, but it is not a security boundary" — an unusually honest statement. **(d)** "Cross-realm errors fail `instanceof Error` inside scripts — branch on stable fields such as `name` and `code`."
- Edge cases / failure handling: Known Limits are explicit: "Workflow caps are **cooperative** — helper counters limit ordinary scripts; they are not host-enforced security quotas or descendant token budgets"; "No overall elapsed deadline"; "The Node PTC provider's `maxPendingCalls` also limits workflow concurrency … Progress batches use at most one additional slot."
- Surprising: The Model-Experience section states that each child's KV cache is "Independent of the parent request cache and of sibling children. Each child can reuse only a byte-identical prefix under its own provider, model, prompt and schema" — a precise statement of *where* prompt caching pays off in a fan-out.

### packages/workflow/workflow-ptc/README.zh.md
- Purpose: Chinese mirror of the PTC engine's package reference.
- Key abstractions: Same config table and composition snippet.
- Data flow: n/a.
- Non-obvious design decisions: Preserves the technical terms in English (`sandbox`, `PTC`, `subagent`, `Activation`) while translating the prose.
- Edge cases / failure handling: n/a.
- Surprising: Line-for-line parallel with the English (169 lines each), including the "the VM is not a security boundary" limitation.

### packages/workflow/workflow-ptc/README.i18n.yaml
- Purpose: Per-section bilingual hash record for the PTC engine's README (37 heading paths).
- Key abstractions: Section paths down to `model-experience/parent-tool-result-indirectly/kv-cache-effect`.
- Data flow: Regenerated by the pairing verifier.
- Non-obvious design decisions: The nesting goes three levels deep for the Model-Experience subsections — the hash granularity tracks the README's heading tree exactly.
- Edge cases / failure handling: n/a.
- Surprising: The `model-experience` hash pair is **byte-identical** to the tool package's, confirming the Model-Experience section is a shared template across packages.

### packages/workflow/workflow-ptc/locale/en.json
- Purpose: English locale strings for the engine package.
- Key abstractions: `meta.title` = `"workflow-ptc"`.
- Data flow: n/a.
- Non-obvious design decisions: Minimal by convention — the title only.
- Edge cases / failure handling: n/a.
- Surprising: Five lines; the description lives in the README frontmatter, not here.

### packages/workflow/workflow-ptc/locale/zh.json
- Purpose: Chinese locale strings for the engine package.
- Key abstractions: `meta.title` = `"工作流执行引擎"`, `meta.description` = `"使用共享的 PTC 运行时执行工作流编排代码。"`
- Data flow: n/a.
- Non-obvious design decisions: As with the tool package, the zh locale adds a description the English one omits.
- Edge cases / failure handling: n/a.
- Surprising: The zh description says "编排代码" (orchestration *code*) where the English-side title says "执行引擎" (execution engine) — the description is describing the tool rather than the engine.

## Ideas worth stealing

- **One error class with a `fatal` flag, decided by host `instanceof`, so a combinator can be strict about operator error and lenient about child failure** — `packages/workflow/workflow-ptc/src/runtime.ts:296-307` and `:325-339`. The mechanism: every hook misuse (bad arguments, unknown option, unsupported schema, tripped cap) throws a `WorkflowError` built in the *host* realm; `parallel()`/`pipeline()` re-throw it and map only *ordinary* per-item errors to `null`. The stated reason (runtime.ts:300-303) is the transferable part: "Hook failures are WorkflowErrors built OUTSIDE the script's realm; fatality is recognized by `instanceof` against this realm's class — a script-built object can never pass it, so fatality cannot be forged (nor accidentally dissolved)." August's own combinators (parallel tool calls, batch loops) currently blur "the model typo'd the arguments" with "this one item failed"; this splits them, and the authority check is *type identity*, which a model-authored payload cannot forge.

- **Attach a no-op rejection consumer without changing what the caller receives** — `packages/workflow/workflow-ptc/src/runtime.ts:122-125` (and the guest-side twin at `packages/workflow/workflow-ptc/src/guest.ts:52-54`). The mechanism: `promise.catch(() => {})` returns the *same* promise, so a script that awaits it still observes the rejection, while a script that *drops* it cannot produce an unhandled rejection that kills the Node process. The doc comment states the contract exactly: "Attach a no-op rejection consumer WITHOUT changing what the caller receives." August runs model-authored async work in-process; a single dropped promise currently escalates to a process-level unhandled rejection.

- **A total thrown-value renderer: prefer `stack`, fall back to `message`, then `String()`, and never throw** — `packages/workflow/workflow-ptc/src/realm.ts:24-36`. The mechanism: the whole body is inside one `try`, and a value whose `stack` getter or `Symbol.toPrimitive` throws renders as the fixed label `'[unrenderable thrown value]'`. The reason it matters: every failure path in the harness must be *reportable*; August's `is_error` classification reads a rendered string, and a value that cannot be rendered is a blind spot (the same class of bug as the `Blocked:` marker table).

- **Cross-realm lossless-JSON materialization with path-qualified errors and `defineProperty` for `__proto__`** — `packages/workflow/workflow-ptc/src/realm.ts:62-72` and `:126-147`. The mechanism: a whitelist materializer that rejects functions, symbols, bigints, non-finite numbers, nested `undefined`, sparse arrays, non-index array props, exotic prototypes and cycles (while accepting DAGs), and copies with `Object.defineProperty` so a `"__proto__"` key becomes an own data property rather than a prototype mutation. The error message names the path (`workflow result.items[3]: non-finite numbers are not JSON data`). August moves values across a JS/Python boundary and across a tool-call JSON boundary; this is the exact checklist for what must not silently change shape.

- **Ship the sandboxed guest as one self-contained ESM bundle inlined as source and loaded from a `data:` URL, with a `sourceURL` so stacks stay readable** — `packages/workflow/workflow-ptc/src/host.ts:26-27`, with the generation rules in `scripts/gen-workflow-guest.ts` (outside this shard but referenced by the file's own header). The mechanism: rolldown bundles `guest.ts` to **exactly one chunk** whose only imports are Node builtins; the generator *asserts* that (`"the workflow guest must bundle into exactly one JavaScript module"` and the non-builtin-import check), `--check` mode rejects a stale committed copy, and the bundle ends with `//# sourceURL=dsh-workflow-guest.js` so a stack frame names the guest rather than leaking a 40 KB `data:text/javascript` URL. The test at `packages/workflow/workflow-ptc/tests/guest.spec.ts:208-230` runs it under plain Node precisely because vitest rewrites stack formatting. Transferable: August's `run_code` / PTC-style isolation could use the same "bundle, assert, inline, sourceURL" recipe.

- **Batch progress events with exactly one batch in flight, and fail the run if a batch cannot be delivered** — `packages/workflow/workflow-ptc/src/guest.ts:18-42` and `:69-74`. The mechanism: `send()` queues an event; `flush()` ships a batch only when nothing is in flight and the rest coalesce; a rejected batch sets `progressError` and turns the *whole run* into `stopReason: 'error'`. The numeric contract is pinned at `packages/workflow/workflow-ptc/tests/guest.spec.ts:92-127` (200 logs → exactly 2 batches, peak 1 in flight). Why it transfers: August's activity/progress events would otherwise either flood the transport or be dropped silently; here the channel is bounded, ordered, and a broken channel is a *run* failure rather than a silent gap.

- **Drain progress before disposing a child and before publishing the terminal result** — `packages/workflow/workflow-ptc/src/guest.ts:56-64` (the `dispose()` in the child port awaits `drain()` first). The mechanism plus the stated reason: "Start observers must receive the child while its host registration is still live." Combined with the host-side `endAgent` de-duplication (`packages/workflow/workflow-ptc/src/host.ts:273-276`), this yields the invariant **exactly one `agent-start`/`agent-end` pair per child, always in that order, on every termination path** — asserted at `packages/workflow/workflow-ptc/tests/workflow-ptc.spec.ts:861-884`.

- **A child whose result *rejects* is an infrastructure fault; a child that *resolves* with a non-completed stop reason is an ordinary failure** — `packages/workflow/workflow-ptc/src/runtime.ts:194-206`. The mechanism: the rejection is wrapped as a **fatal** `AGENT_RESULT` after pairing the lifecycle, with the stated reason "an ordinary throw would dissolve to a per-item null inside the combinators, and a broken provider must not read as a failed child." Why it transfers: in August, a transport/provider crash that returns `null` is indistinguishable from "the model declined" — and `null` is swallowed by `.filter(Boolean)`. This is a taxonomy that keeps a broken backend from masquerading as a model decision.

- **Capture the working directory and the file policy SEPARATELY at run start, and keep both when the parent later moves** — `packages/workflow/workflow-ptc/src/index.ts:167` (policy) and `packages/workflow/workflow-ptc/src/host.ts:142` (cwd), documented at `packages/workflow/workflow-ptc/README.md:59` and pinned at `packages/workflow/workflow-ptc/tests/host.spec.ts:96-127` (the child and the PTC process both keep the *captured* directory, and `ensure` is called exactly once). Why it transfers: a long-running background agent in August must not follow the user's `cd` mid-run, and the policy must not be re-resolved against a Session that has since changed.

- **Refuse to run without confinement unless the policy is `danger-full-access`** — `packages/workflow/workflow-ptc/src/host.ts:287-289`. The mechanism: `if (this.runtime.sandboxMode === undefined && this.policy.mode !== 'danger-full-access') throw new Error(...)` — checked **before** the PTC process starts, not after. Transferable directly: August's sandbox modes are the same three, and "we could not enforce `read-only`, so we ran anyway" is exactly the failure this prevents.

- **Re-validate every value crossing the process boundary instead of trusting it** — `packages/workflow/workflow-ptc/src/host.ts:29-106`. The mechanism: the host decodes `startChild`, `progress` and the terminal result through strict local validators (`text()`, `object()`, `json()`, `agentInfo()`, `progress()`, `workflowResult()`), each with its own message; a malformed batch, an unknown `callId`, an invalid outcome or a non-lossless-JSON value is an error, not a coerced value. The test table at `packages/workflow/workflow-ptc/tests/host.spec.ts:128-149` pins twelve malformed payloads. Why it transfers: a PTC/remote/worker boundary is exactly where a compromised or buggy peer can inject `{"stopReason": "completed", "agentsStarted": -1}`.

- **Enumerate EVERY validation violation by name instead of failing on the first** — `packages/workflow/workflow-ptc/src/meta.ts:13-65`, with the rule stated in the test at `packages/workflow/workflow-ptc/tests/meta.spec.ts:58` ("accepted-then-ignored is banned") and the all-at-once property at `:80-88`. The mechanism: collect violations into a list, then throw one error containing all of them; also reject *unknown* fields rather than ignoring them. Why it transfers: August's model-facing schema validation currently reports one problem at a time, so a model with three bad parameters needs three round trips; and a silently-ignored field is a knob that does nothing.

- **A per-run override may only LOWER a deployment ceiling; asking for more is an error, not a clamp** — `packages/workflow/workflow-ptc/src/index.ts:83-95`. The mechanism: `resolveMaxTotalAgents` rejects a non-safe-integer, a value below 1, *and* a value above the engine ceiling with `INVALID_ARGUMENT`. The same file resolves `maxConcurrentAgents: 0` to `min(16, max(1, availableParallelism() - 2))` — a machine-derived default rather than a magic number (`:142-144`). Why it transfers: the "0 = auto" convention plus "a caller may lower but never raise" is a config shape that survives contact with a model.

- **The durable session record degrades to a legal prefix instead of corrupting or aborting the run** — `packages/workflow/tool-workflow/src/index.ts:93-151`. The mechanism: the first failed `session.append` disables further recording *for that run* with exactly one warning; the surviving record is either empty or a continuous prefix of the four events; the tool result and the cleanup path are untouched. The expected prefix per failure point is pinned as a table at `packages/workflow/tool-workflow/tests/tool-workflow.spec.ts:238-277`. Why it transfers: August's `turn_outcomes` / transcript writes have the same shape of risk, and "a persistence hiccup degrades the record, never the run" is the right failure direction.

- **Write the run-end record only after disposal reaches quiescence** — `packages/workflow/tool-workflow/src/index.ts:468-482` and `packages/workflow/tool-workflow/tests/tool-workflow.spec.ts:183-199`. The mechanism: `await run.dispose()` happens inside the `finally` *before* `recorder.finish(...)`, so a `run-end` in the log means "the script and its children are actually done", not "the value arrived". Why it transfers: a transcript marker that claims completion before cleanup is how a UI shows a finished run that still holds a live subagent.

- **Start the engine run INSIDE the job starter so a synchronous rejection registers no job** — `packages/workflow/tool-workflow/src/index.ts:281-291`. The mechanism: `jobs.start({ kind: 'workflow', owner: parent.id, toolCall, run: (job) => { run = ctx.workflowEngine.start(...); ... } })` — if `start()` throws, the registry never saw a job; the model sees the violation list as an ordinary tool error. Also: the background run gets **no tool-step signal** — the job owns cancellation (`:250-252`, `:310`), so `job_kill` and owner teardown are the only cancel paths. Why it transfers: this is the "register the job, then start the work" ordering that avoids orphaned job rows.

- **Background progress rides the job's `log` channel so the MODEL sees status only, while the HUMAN sees the narration** — `packages/workflow/tool-workflow/src/record.ts:40-54`, asserted byte-for-byte at `packages/workflow/tool-workflow/tests/tool-workflow.spec.ts:495-507`. The mechanism: every narration line is appended with `{channel: 'log'}` and `job_output` filters to non-log channels, so a background run's intermediate chatter never enters the model's context; the human sees it in the job list and the job's output ring. Why it transfers: August already separates a live indicator from the persisted activity line; this is the same separation applied to *background* work, where the parent's context is the scarce resource.

- **Present the tool as an args-only pure function, and keep the completed card identical to the pending card** — `packages/workflow/tool-workflow/src/index.ts:180-194`. The mechanism: `presentWorkflowCall` returns `{card: 'generic', title: 'workflow: <meta.name>', rawInput: args.script}`; `presentResult` ignores both its arguments and returns `{card: 'generic'}`. The README names the governing note (render-intent Agent Note) and states the rule: "presentation is a pure function of args". Why it transfers: a result card that renders from the *result* would need the result at replay time and would drift between a live run and a reloaded transcript.

- **Ship a heavyweight tool's usage policy as the tool plugin's own system-prompt section, with a configurable order** — `packages/workflow/tool-workflow/src/index.ts:324-330`. The mechanism: `ctx.systemPrompt.section({ name: 'tool:<toolName>', order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'), text: 'Use the <toolName> tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration … For one or two delegations, prefer plain subagent calls.' })`. The test at `packages/workflow/tool-workflow/tests/tool-workflow.spec.ts:393-415` pins that the section is named after the **configured** tool name, rides the same registration, and disappears with the fiber (HMR safety). Why it transfers: an explicit-ask policy for an expensive tool, delivered in the prefix and stable under a rename.

- **Document "What the model sees / Token effect / KV Cache effect" for the prompt, the schema, and the tool-call history** — `packages/workflow/tool-workflow/README.md:112-161` (and the same template in `packages/workflow/workflow-ptc/README.md:117-146`). The mechanism: each model-facing surface gets the same three sub-headings, with a concrete stability claim — "Prefix-stable while the plugin scope and guidance text are unchanged", "Prefix-stable while `toolName`, definition, and visibility are unchanged", "Append-only; newly visible content follows the reusable request prefix". Why it transfers: August's AGENTS.md tracks this informally; making it a per-surface template with an explicit prefix-stability verdict is a cheap, checkable convention.

- **Reject the single most likely authoring slip with a pointed message instead of a bare SyntaxError** — `packages/workflow/workflow-ptc/src/index.ts:48-58`. The mechanism: a regex for `export const meta` in the body throws "workflow meta rides the `meta` request field, not the script: remove the `export const meta = {...}` statement from the body". Why it transfers: the failure mode is a *convention* mismatch (this product's scripts carry meta as data, another product's carry it in the body), and a one-line targeted message saves a whole debugging round trip.

- **Assert that the program-visible environment is empty — using the model's own escape hatch** — `packages/workflow/workflow-ptc/tests/egress.spec.ts:29-38`. The mechanism: the script reaches `globalThis.constructor.constructor('return process')().env` and the result must be `{}`; `HTTP_PROXY`/`HTTPS_PROXY` (with an embedded credential canary), a custom env var and `TSX_TSCONFIG_PATH` are all stubbed in and asserted absent. Why it transfers: August's outbound-credential scrubbing story depends on the same claim, and the strongest form of the test is to attack the boundary the way an attacker would.

- **Prove the artifact, not just the source** — `packages/workflow/workflow-ptc/tests/built-runtime.e2e.ts:19-82`. The mechanism: the test is skipped unless `lib/index.js` and the PTC runtime's built files exist; it then writes a `driver.mjs` that imports the package **by name**, runs a real workflow with a structured child and a blocked file write, and asserts the outside file is unchanged. Why it transfers: this is the closest analogue in the shard to August's `e2e:smoke` gate — a source-level test suite can be entirely green while the published artifact is broken.

- **Prove the whole program environment AND the OS file policy in one test, in both process modes** — `packages/workflow/workflow-ptc/tests/source-runtime.compat.spec.ts:41-63`. The mechanism: the script escapes the VM via the constructor chain, calls `proc.getBuiltinModule('node:fs').writeFileSync(...)`, and the test asserts the inside-workspace write succeeded under `workspace-write` while the outside write did not change the file — run in both `per-call` and `persistent-in-memory` execution modes. Why it transfers: the August code-mode sandbox needs the same matrix (both execution modes × inside/outside write), because a persistent in-memory REPL and a per-call process can enforce differently.

## Files skipped (with reasons)

None. All 51 files in the shard were opened and read. One is a **generated** artifact and is flagged as such in its per-file note rather than skipped:

- `packages/workflow/workflow-ptc/src/guest-source.ts` — generated by `scripts/gen-workflow-guest.ts` (a rolldown bundle of `guest.ts` inlined as a `JSON.stringify`'d string). It is a 42 KB single-line file, so I decoded the `\n` escapes and read the whole thing in three chunks. Its eight `//#region` markers show exactly what is bundled (`realm.ts`, `util/brand`, `llm/error.ts`, `util/values`, `core/tools/json-schema.ts`, `workflow/index.ts`, `workflow-ptc/runtime.ts`, `workflow-ptc/guest.ts`), and I verified region-by-region that it is the type-stripped twin of the hand-written sources. Marked `read`, with the caveat that the *source of truth* for the bundled helpers lives outside this shard.

## Uncertainties

- **The PTC runtime itself is outside this shard.** `packages/ptc-runtime/ptc-runtime-node` is where process launch, OS confinement, framed transport, `maxPendingCalls` and the managed-process cleanup actually live; this shard only consumes its `PtcRuntime` interface. Every statement I make about "the PTC process is aborted on cancellation" or "the program-visible environment is empty" rests on the *engine's* behaviour as asserted by `packages/workflow/workflow-ptc/tests/host.spec.ts` and `egress.spec.ts` — I did not read the runtime implementation.
- **`ctx.subagents`, `ctx.jobs`, `ctx.tools` and `ctx.systemPrompt` are outside this shard.** I read their *interfaces* only as they appear in this shard's imports and calls. The claims about `jobs.start` admission preflight, `job_output` channel filtering and `Session.append` semantics are taken from how this shard uses them and from this shard's own tests, not from those packages' sources.
- **The `ralph` tool is referenced but not present.** `packages/workflow/README.md:38` links a generated catalog entry for a `ralph` tool and `workflow-ptc/README.md:28` says Ralph "remains disabled in shipped defaults"; that package lives under `packages/experimental/` and is outside this shard, so I could not confirm what it does beyond the "fixed fresh-agent loop" description in the group map.
- **`packages/core/tools/src/json-schema.ts` is the source of the enforced JSON-Schema subset** used by `assertObjectJsonSchema` in `runtime.ts:12`. I read the **bundled copy** inside `guest-source.ts` (which is in my shard) but not the source file, so I cannot say whether the source and the bundle are currently in sync — only that `scripts/gen-workflow-guest.ts --check` exists to enforce that.
- **The guest-source bundle's freshness was not verified.** I confirmed that the bundle's content matches the hand-written `realm.ts` / `runtime.ts` / `guest.ts` I read, but I did not run `pnpm verify-workflow-guest` (the clone is read-only and untrusted), so a stale committed bundle would not have been detected by me.
- **`WorkflowStopReason` merge-extensibility.** `packages/workflow/workflow-ptc/src/types.ts:49-53` says the seam's union is "merge-extensible" and degrades to `string` on the wire. I did not find the mechanism that performs that merge (it lives in the seam's own `types.ts` as a closed union), so I can report the contract but not the extension point.
- **The `dsh-jobs` "output ring" retention semantics** (how much is kept, and what `job_output` returns before settlement) are asserted by this shard's tests but implemented elsewhere; I describe the ring format only as far as this shard writes it.
- **Line numbers in `guest-source.ts` are not meaningful as source references** — the whole bundle is line 4. I have cited it only where the bundled content itself is the subject; everywhere else I cite the hand-written source the bundle is derived from.
