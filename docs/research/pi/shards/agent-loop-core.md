# pi / agent-loop-core

## Shard shape

This shard holds two packages that only loosely belong together, and the split matters. `packages/agent`
(`@earendil-works/pi-agent-core`, 20 files, ~250 KB) is **the agent loop**: a provider-agnostic turn engine whose
entire surface is one `Agent` class, one low-level `agentLoop()`, a type module, and a proxy stream function. It owns
the turn lifecycle (`agent_start` → `turn_start` → message/tool events → `turn_end` → `agent_end`), the tool
definition/execution/validation pipeline, the steering and follow-up queues, and the hooks that let a host inject
compaction (`prepareNextTurn`), canonical context (`prepareRequest`) and turn-finalisation policy (`finishTurn`) into
the loop without the loop knowing about any of them. Notably it does **not** own sessions, storage, compaction, skills
or prompts — `packages/agent/CHANGELOG.md:37` records that the whole experimental harness (sessions, session storage,
durable runtime, pico3, harness tools, compaction, skills, prompt templates, system-prompt helpers, telemetry schemas)
was *removed* from this package in 1.0.0, leaving "only `Agent`, the agent loop, the proxy stream, and their types".

`packages/chord` (`@earendil-works/chord`, 109 files, ~1.34 MB) is a completely different subsystem: a **distributed
object runtime** for building applications out of stateful objects that live in several processes and can be hot
reloaded. It contributes the pieces a harness would need underneath the agent: a contract system with versioned
compatibility checking (`contract.ts`, `schema.ts`), a transactional immutable-JSON revision tracker with
copy-on-write drafts and exact operation batches (`src/delta/`), a replicated-state layer with a bounded delivery
queue (`state.ts`), a typed wire protocol with flow control over memory/IPC/WebSocket links (`wire.ts`, `link.ts`,
`connection.ts`), a host/principal model with a two-version hot-reload protocol (`host.ts`, `reload.ts`, `cluster.ts`),
bounded output buffering and paced progress (`output.ts`), and portable SQLite/telemetry adapters. The `delta/`
sub-package is the part that most directly answers "session storage / branching": it is a CRDT-ish tracker that turns
a mutable draft into an immutable revision plus an exact op batch, so two replicas of a transcript converge.

The two packages are connected only by the `Delta` vocabulary that the agent's `AgentMessage`/tool-result shapes
resemble. Nothing in `packages/agent` imports `packages/chord`.

---

## Per-file notes

### packages/agent/src/agent-loop.ts
- **Purpose:** The turn engine. 959 lines, no dependencies beyond `@earendil-works/pi-ai` and `typebox`.
- **Key abstractions:** `runLoop()` (the outer/inner two-level loop), `prepareToolCall()` (prepare → validate → hook →
  execute → finalize), `declareToolChanges()`, `streamAssistantResponse()`, `failToolCallsFromTruncatedMessage()`.
- **Data flow:** `AgentContext.messages` + `AgentContext.tools` → `transformContext` → `convertToLlm` →
  `normalizeContext` → `streamFn` → partial assistant message → tool calls → tool results → next turn.
- **Non-obvious design decisions:**
  - `agent-loop.ts:210-215` — after a long-running `prepareNextTurn` (compaction), steering is re-polled **only if the earlier poll returned nothing**; otherwise one-at-a-time mode would deliver two messages in one turn.
  - `agent-loop.ts:274-279` — a `stopReason: "length"` message executes **no** tool call at all. The comment says it plainly: streamed tool-call arguments are finalized with a best-effort JSON salvage parser, so a truncated message yields calls whose arguments *parse and validate but are silently incomplete*.
  - `agent-loop.ts:342-372` — `declareToolChanges()` diffs the *executable* tool set against the tools the transcript *declares* and announces the difference in a system message before the next request. The transcript owns the declaration; the runtime owns execution.
  - `agent-loop.ts:700-702` — `shouldTerminateToolBatch()` requires **every** finalized result in the batch to set `terminate === true` before the follow-up request is skipped. A mixed batch continues.
  - `agent-loop.ts:526-531` — one tool with `executionMode: "sequential"` forces the **whole batch** sequential, even when the global mode is `parallel`.
  - `agent-loop.ts:656-670` — in parallel mode `tool_execution_end` is emitted in **completion order**, but tool-result *messages* are emitted in **assistant source order**. The UI sees reality; the transcript stays deterministic.
  - `agent-loop.ts:894-906` — `afterToolCall` replacing `content` without replacing `structuredContent` **drops** the structured content, because the two may no longer match.
  - `agent-loop.ts:836-866` — the tool's `onUpdate` callback is scoped to the invocation: after the promise settles, `acceptingUpdates` is false and late calls are dropped (no unhandled rejection).
  - `agent-loop.ts:838-839` — `durationMs` uses `performance.now()` (monotonic) and measures **only** `execute()`, excluding the hooks.
- **Edge cases / failure handling:** `stopReason === "error" | "aborted"` is a hard exit that runs `finishTurn` but ignores its decision, then emits `turn_end` and `agent_end` (`:254-265`). Unknown tool / schema-validation failure / blocked call / thrown error all become `isError: true` tool results, never a throw (`:718-787`).
- **Surprising:** `runToolCall()` (`:800-829`) is a *public* entry point that runs one tool call through the identical pipeline — prepare, validate, `beforeToolCall`, execute, `afterToolCall` — and emits no events. It exists so that a tool which calls other tools (codemode, subagents) still goes through the permission hooks. Its docstring says so: "Tools that call other tools use this so the hooks (for example permission checks) apply to those calls too."

### packages/agent/src/types.ts
- **Purpose:** Every type in the agent package: config, events, tools, results, state.
- **Key abstractions:** `AgentLoopConfig` (the whole extension surface), `AgentEvent` (the 10-event lifecycle vocabulary), `AgentTool`, `AgentToolResult`, `AgentState`, `AgentMessage` (open via declaration merging).
- **Data flow:** types only; `AgentMessage` → `Message` at the `convertToLlm` boundary.
- **Non-obvious design decisions:**
  - `types.ts:33-37` — the `StreamFn` contract is written as a *prohibition*: "Must not throw or return a rejected promise for request/model/runtime failures. Failures must be encoded in the returned stream via protocol events and a final AssistantMessage with stopReason 'error' or 'aborted'."
  - `types.ts:49-55` — `QueueMode` is `"all" | "one-at-a-time"`, a property of the *queue*, not of the loop.
  - `types.ts:146-158` — `FinishTurn` returns `{action:"continue"} | {action:"end"} | undefined`; "Returning undefined preserves normal scheduling."
  - `types.ts:509-514` — `agent_end` is the last event, but awaited subscribers for it are still part of run settlement; the agent becomes idle only after they finish.
  - `types.ts:365-374` — `CustomAgentMessages` is an empty interface apps extend by declaration merging, so app-specific message roles stay type-safe.
- **Edge cases / failure handling:** `AfterToolCallResult` merge semantics are spelled out field by field (`:76-104`) with "no deep merge".
- **Surprising:** `AgentTool.replay?: "never" | "safe"` (`:489-490`) — a per-tool declaration of "recovery policy for an effect whose durable intent exists but whose outcome is unknown." It is declared but never consulted anywhere in this shard.

### packages/agent/src/agent.ts
- **Purpose:** The stateful wrapper: owns the transcript, the two queues, the event listeners and the abort controller.
- **Key abstractions:** `Agent`, `PendingMessageQueue` (`:149-180`), `ActiveRun`.
- **Data flow:** `prompt()`/`continue()` → `runWithLifecycle` → `runAgentLoop`/`runAgentLoopContinue` → `processEvents` → listeners (awaited in registration order).
- **Non-obvious design decisions:**
  - `agent.ts:149-180` — `PendingMessageQueue` implements both queue modes with a `peek()`/`drain()` pair; `drain()` removes exactly what `peek()` returned.
  - `agent.ts:255-256` — steering and follow-up default to `"one-at-a-time"`.
  - `agent.ts:364-377` — `reset()` **throws** if a run is active ("Agent is already processing. Wait for completion before resetting."), restoring the baseline system message only.
  - `agent.ts:542-558` — a thrown run failure is turned into a *complete synthetic event sequence* (`message_start`, `message_end`, `turn_end`, `agent_end`) with a synthetic assistant message carrying `stopReason: "error" | "aborted"`. The UI always sees a well-formed run.
  - `agent.ts:575-622` — `processEvents` reduces the event into state **before** awaiting listeners, and every listener is awaited in subscription order, so a slow subscriber is a real barrier.
  - `agent.ts:476-515` — `createLoopConfig()` wires `getSteeringMessages` with a `skipInitialSteeringPoll` flag used exactly once, by `continue()`'s assistant-tail fallback.
- **Edge cases / failure handling:** `prompt()` while streaming rejects with "Use steer() or followUp() to queue messages, or wait for completion."; `abort()` is safe with no active run; `waitForIdle()` resolves immediately when idle.
- **Surprising:** `state.tools` and `state.messages` are accessor properties that **copy the top-level array on assignment** — the getter returns the live array, so `state.messages.push(x)` mutates state, but `state.messages = [...]` does not alias.

### packages/agent/src/proxy.ts
- **Purpose:** A `StreamFn` that talks to a server instead of a provider: `streamProxy()`.
- **Key abstractions:** `ProxyAssistantMessageEvent` (a reduced-bandwidth event vocabulary — the server strips the `partial` field), `processProxyEvent()` (client-side reconstruction of the partial message).
- **Data flow:** `fetch` → SSE `data: ` lines → `processProxyEvent` mutates a local `partial` and re-emits a full pi-ai event.
- **Non-obvious design decisions:**
  - `proxy.ts:219-230` — a clean EOF **without** a terminal `done`/`error` event is surfaced as an error ("Connection closed by proxy server before the response completed") instead of leaving the consumer waiting forever.
  - `proxy.ts:212-217` — the final event may not be newline-terminated, so the decoder is flushed and the remaining buffer processed.
  - `proxy.ts:339-350` — tool-call arguments are re-parsed on every delta with `parseStreamingJson`, and the content block is *replaced* (`{...content}`) to trigger reactivity.
  - `proxy.ts:355-367` — `toolcall_end` does `Object.assign(content, proxyEvent.toolCall)`, so metadata that only arrives at the end (e.g. OpenAI Responses namespaces) is preserved.
- **Edge cases / failure handling:** non-2xx responses try to parse `{error}` from the body; a `text_delta` for non-text content throws (protocol violation); the abort listener cancels the reader.
- **Surprising:** the server may deflate the payload and the client only inflates it if it actually uses the value — a relaying host forwards the deflated bytes unread (`link.ts` does the same trick).

### packages/agent/src/stream-fn.ts
- **Purpose:** A 20-line indirection holding the fallback `StreamFn` when a caller omits it.
- **Key abstractions:** `setDefaultStreamFn` / `getDefaultStreamFn`.
- **Data flow:** `getDefaultStreamFn()` throws if nothing was installed.
- **Non-obvious design decisions:** the comment at `:6-9` states the reason: "Hosts that provide a default model runtime can install its stream function here without making pi-agent-core depend on a provider catalog or compatibility layer." This is the package's dependency-hygiene seam.
- **Edge cases / failure handling:** a missing default throws a message that names both escapes ("Pass streamFn explicitly or call setDefaultStreamFn()").
- **Surprising:** the *constructor* tolerates a missing `streamFn` (`agent.ts:240`, "Older compiled consumers may omit options or streamFn even though the current API requires them"), so the throw is deferred to the first request.

### packages/agent/src/index.ts
- **Purpose:** The package barrel: 5 re-export lines over `agent.ts`, `agent-loop.ts`, `proxy.ts`, `stream-fn.ts`, `types.ts`. Note it exports only `setDefaultStreamFn` from `stream-fn.ts`, not `getDefaultStreamFn`.

### packages/agent/README.md
- **Purpose:** 569 lines of user documentation; the canonical description of the event sequence, the tool lifecycle, the two queues and the four hooks.
- **Key abstractions:** the event-sequence ASCII diagrams (`:65-107`), the per-turn lifecycle (`:157-167`).
- **Data flow:** documents `AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM` (`:53-56`).
- **Non-obvious design decisions:** `:565` — "These low-level streams are observational. They preserve event order, but they do not wait for your async event handling to settle before later producer phases continue. If you need message processing to act as a barrier before tool preflight, use the `Agent` class instead."
- **Edge cases / failure handling:** `:495-507` — "Throw an error when a tool fails. Do not return error messages as content."
- **Surprising:** `:509` — the `terminate` hint is "runtime-only; emitted `toolResult` transcript messages remain standard LLM tool results." The hint never reaches the model.

### packages/agent/CHANGELOG.md
- **Purpose:** 790 lines of release history; the record of *why* the API is shaped as it is.
- **Key abstractions:** none; prose + code snippets.
- **Data flow:** n/a.
- **Non-obvious design decisions:** `:37` — the 1.0.0 removal of the whole harness (sessions, storage, compaction, skills) from this package, leaving the loop bare. `:56-70` — the `shouldStopAfterTurn` → `finishTurn` migration, with the exact guard that preserves the old "normal-response-only" invocation.
- **Edge cases / failure handling:** `:19` — `durationMs` is "measured with a monotonic clock and excluding hooks. Calls that did not run have none."
- **Surprising:** `:187` — "Restored the `Agent` `streamFn` option and host-configurable fallback for omitted agent-loop stream functions without reintroducing a `pi-ai/compat` dependency."

### packages/agent/package.json
- **Purpose:** Package manifest: name `@earendil-works/pi-agent-core`, v1.4.0, two runtime deps (`@earendil-works/pi-ai`, `typebox`), Node ≥ 22.19.0. The description mentions "transport abstraction, state management, and attachment support" — the last two are aspirational; there is no attachment code in this shard.

### packages/agent/tsconfig.build.json
- **Purpose:** 13-line build config: `rootDir: ./src`, `include: src/**/*.ts`, with `paths` mapping `@earendil-works/pi-ai` to the sibling package's `dist`. Tests and examples are excluded from the build by construction.

### packages/agent/vitest.config.ts
- **Purpose:** 27-line vitest config: `testTimeout: 30000`, `silent: "passed-only"`, and `resolve.alias` mapping `@earendil-works/pi-ai`, `pi-ai/compat`, `pi-agent-core` and `pi-telemetry` to **source** files so tests run against source, not `dist`. `ssr.resolve.conditions: ["source"]`.

### packages/agent/test/agent-loop.test.ts
- **Purpose:** 2234 lines — the behavioural spec of the loop. The single most valuable test file in the shard.
- **Key abstractions:** hand-rolled `streamFn` doubles that push a `done`/`error` event on a `queueMicrotask`; `createAssistantMessage` with a chosen `stopReason`.
- **Data flow:** the test drives the real `agentLoop()` and asserts on the **event sequence**, not just the result.
- **Non-obvious design decisions the test pins:**
  - `:456-526` — a `length`-truncated message executes nothing and the loop continues so the model can re-issue.
  - `:668-760` — the completion-order / source-order split of tool results.
  - `:1108-1160` — `finishTurn` runs after the tool-result messages and *before* `turn_end` (order asserted with `ordering.slice(-3)`).
  - `:1162-1215` — `finishTurn` runs for `error` and `aborted` too, but the hard exit ignores its decision: 1 provider call, 1 steering poll, 0 follow-up polls.
  - `:1217-1271` — `action:"end"` skips queue polling and `prepareNextTurn` entirely.
  - `:1273-1305` / `:1307-1345` / `:1347-1402` — a `{action:"continue"}` produces **exactly one** extra request, and a natural tool-result / steering / follow-up request **satisfies** the continuation so no extra request is made.
  - `:1580-1631` — steering queued *during* `prepareNextTurn` is picked up before the next request.
  - `:1732-1781` / `:1841-1897` — the unanimity rule for `terminate`.
  - `:2133-2233` — `runToolCall` pins the hook order: "Validation failures and unknown tools never reach the hooks; blocked calls skip afterToolCall."
- **Edge cases / failure handling:** `:402-454` — `durationMs` must be ≥25 ms and <100 ms for a 30 ms tool behind a 100 ms hook, proving hooks are excluded; a blocked call must have **no** `durationMs` property at all.
- **Surprising:** `:160-197` — the provider context must have exactly one key, `messages`; there is no top-level `systemPrompt` and no `tools` field on the request.

### packages/agent/test/agent.test.ts
- **Purpose:** 1229 lines — the behavioural spec of the `Agent` wrapper.
- **Key abstractions:** `createDeferred()` barrier helper; `Reflect.construct(Agent, [{}])` to test the legacy-caller path.
- **Data flow:** drives `agent.prompt()` and asserts on `agent.state` and the event list.
- **Non-obvious design decisions:**
  - `:144-210` — the tool-loadout announcement: three prompts produce `["+first","-"]`, `["+first","-","+second","-first"]`, and then a **repeat** of the same delta (the change is announced once).
  - `:247-280` — a pending system message that *claims* a tool change is rewritten to match the executable set: "the executable set wins."
  - `:331-360` — a thrown provider error still produces the full event sequence ending in `agent_end`.
  - `:362-433` — `prompt()` and `waitForIdle()` do not settle until awaited `agent_end` listeners do.
  - `:473-536` — a tool's `onUpdate` called after the tool settled is ignored, with no unhandled rejection.
  - `:1071-1107` / `:1109-1134` — on an `error`/`aborted` response, and on `finishTurn` → `end`, **the queues are preserved** (the queued steering message is still peekable).
- **Edge cases / failure handling:** `:676-708` — `reset()` during a run throws and does not corrupt the transcript; `:710-748` — a second `prompt()` while streaming rejects.
- **Surprising:** `:1136-1153` — `peekQueuedMessages()` returns the *steering* head, and falls back to the *follow-up* head only when the steering queue is empty.

### packages/agent/test/e2e.test.ts
- **Purpose:** 416 lines — the only end-to-end test, running the real `streamSimple` against the **faux provider** (`registerFauxProvider`).
- **Key abstractions:** `fauxAssistantMessage`, `fauxToolCall`, `fauxThinking`; a faux registration per test, unregistered in `afterEach`.
- **Data flow:** faux provider → `Agent` → real `pi-ai` stream → tool execution → transcript.
- **Non-obvious design decisions:** `:74-100` — `pendingToolCalls` is asserted at the exact moments of `tool_execution_start` (`["calc-1"]`) and `tool_execution_end` (`[]`).
- **Edge cases / failure handling:** `:103-129` — abort during streaming leaves an assistant message with `stopReason: "aborted"` and a defined `errorMessage`, and `state.errorMessage` mirrors it.
- **Surprising:** `:243-265` — thinking content blocks are preserved *in order* in the final message: `[{type:"thinking"},{type:"text"}]`.

### packages/agent/test/proxy.test.ts
- **Purpose:** 118 lines — three regression tests for `streamProxy`.
- **Key abstractions:** `vi.stubGlobal("fetch", …)` returning a `Response` with a hand-written SSE body.
- **Data flow:** SSE text → `streamProxy` → pi-ai events.
- **Non-obvious design decisions:** `:33-75` — metadata that arrives only on `toolcall_end` (an OpenAI Responses `namespace`) must survive into the final result; `:78-97` — a terminal event that is not newline-terminated must still be processed.
- **Edge cases / failure handling:** `:99-117` — a stream that ends without a terminal event becomes `stopReason: "error"` with "Connection closed by proxy server" in the message, not a hang.
- **Surprising:** the test imports from `@earendil-works/pi-ai/compat` — the compatibility layer — while the source imports from `@earendil-works/pi-ai`.

### packages/agent/test/utils/calculate.ts
- **Purpose:** A test tool `calculate` that evaluates an arithmetic expression via `new Function`, plus `createCalculateToolWithUsage(usage)` to attach a `Usage` to a result.

### packages/agent/test/utils/get-current-time.ts
- **Purpose:** A test tool `get_current_time` with an optional IANA timezone; an invalid timezone throws a message that still gives the current UTC time.

### packages/agent/test/utils/wait-for-tick.ts
- **Purpose:** A 3-line helper: `waitForTick()` = `new Promise(r => setTimeout(r, 0))`, used to let queued microtasks/turns settle in tests.

### packages/agent/examples/mcp-codemode/main.ts
- **Purpose:** 50-line example: an `Agent` whose tools are (a) one `AgentTool` per MCP server tool and (b) a `codemode` tool that calls them from model-written JavaScript. Run as `node main.ts <mcp server command>`.

### packages/agent/examples/mcp-codemode/tools.ts
- **Purpose:** 172 lines — the two adapters. `createMcpTools()` maps MCP tools to `AgentTool`s; `createNestedToolRunner()` is the bridge that makes a *tool* calling a *tool* still go through the agent's hooks.
- **Key abstractions:** `createNestedToolRunner(agent)` returns a function that calls `runToolCall({type:"toolCall", id:"nested-N", …}, {tools, assistantMessage, context, beforeToolCall, afterToolCall, signal})`.
- **Data flow:** model → `codemode` tool → sandbox → `tools.<name>(args)` → `runToolCall` → the real tool → result text/structured content back to the script.
- **Non-obvious design decisions:** `:23-26` — provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`, so `toToolName()` sanitises and truncates. `:48-52` — "Providers require an object schema, and some reject one without `properties`", so the MCP input schema is forced to `{type:"object", properties: …}`. `:112-137` — "Nested results stay out of the model context; only the script's output and return value come back." `:127` — a tool without an `outputSchema` is presented to the script as `{type:"string"}`.
- **Edge cases / failure handling:** `:63-65` — an MCP tool that fails with no content gets a synthetic "MCP tool X failed" line; `:134` — a failed nested call is re-thrown inside the sandbox so the script sees an exception.
- **Surprising:** `:154` — the sandbox has a 120 s timeout, and `:167-169` the sandbox is closed in a `finally`, so a script that leaks a timer still cannot hold the process.

### packages/chord/src/delta/index.ts
- **Purpose:** The delta module's public surface: the `Op`/`WireOp` vocabularies, path safety, the appliers and the wire codec. 738 lines, depends on nothing but `../json.ts`.
- **Key abstractions:** `Op` (7 tuple verbs: `r s d a t p m`), `WireOp` (the same plus the `#` path-interning verb and arity-omitted short forms), `encoder()`/`decoder()`, `apply()`/`applyImmutable()`/`applyImmutableBatches()`, `assertValidOp`/`assertValidWireOp`.
- **Data flow:** `Op[]` → (encoder) → `WireOp[]` → JSON → (decoder) → `Op[]` → (applier) → a new value.
- **Non-obvious design decisions:**
  - `:87-110` — `overlap()` finds the longest suffix/prefix overlap with **bounded candidates**; giving up returns 0, "which emits a set: larger, never wrong." A hand-written KMP was rejected as "asymptotically equivalent and much slower in practice."
  - `:120-131` — `RESERVED_SEGMENTS = {__proto__, constructor, prototype}`: "Ops arrive from a facet, a plugin compartment, or a tool whose details may echo model output, so none of it is trusted input."
  - `:152-191` vs `:211-277` — **two separate validators**, one per vocabulary: "Validating `Op` against the wire grammar would be laxer than the type." Both end with the same line: "Silently skipping an unknown verb is how a newer producer's op vanishes."
  - `:289-306` — `assertIndexInRange()` refuses an index past the end because "a sparse array does not survive a JSON round trip" — and because `["s", ["xs", 4294967290], 1]` would allocate a 4.29-billion-entry array from one op.
  - `:375-379` — writes use `Object.defineProperty`, "rather than assignment: a setter inherited from the prototype chain would otherwise run on write."
  - `:419-441` — `applyImmutableBatches` shares **one** copy-on-write scope across the whole call, so no intermediate revision is exposed or safe to retain.
  - `:566-659` — the encoder interns a path on its **second** use ("A definition costs more than the path it replaces"), and an `r` (base) op **clears both dictionaries** because "A base batch is a RECOVERY POINT: a reader replays from the last one with a fresh decoder."
  - `:575-578` — arity omission is scoped to a batch: letting it span batches would make a batch's first op depend on the previous batch's last one.
- **Edge cases / failure handling:** `PathError` for an unresolvable path; `UnsafePathError` for a reserved segment or a non-integer index; `assertPermutation` checks bijection with a `Uint8Array` seen-set.
- **Surprising:** `apply()` **adopts** the `r` payload rather than copying it ("the consumer owns the batch it was handed") — fanning one batch out to several in-process consumers therefore aliases their replicas.

### packages/chord/src/delta/tracker.ts
- **Purpose:** 2239 lines — the transactional tracker: a Proxy-based mutable overlay over an immutable root, producing an immutable candidate plus an exact op batch.
- **Key abstractions:** `Tracker`/`Change`/`Prepared`; `OverlayContext` (per change) and `OverlayNode` (per container); the piece-tree (`PieceNode`, `BasePiece`, `InsertPiece`) that models array edits; `ArrayPlan` (removeRuns / permutation / insertRuns).
- **Data flow:** `track(root)` → `beginChange()` → a Proxy draft → `prepare()` (emit ops + materialise the candidate) → `adopt()` (an infallible pointer swap that bumps `revision`).
- **Non-obvious design decisions:**
  - `:254-277` — `adopt()` is a **pointer swap**: "Adoption is an infallible pointer swap so storage failure can discard the candidate without touching authority." It validates ownership (`owner !== this.#owner` → throw), status (`consumed`/`aborted`/`stale`), and `baseRevision`, and it stales every competing open or prepared context.
  - `:301-313` — `#invalidate()` drops a loser's overlay references in **O(1)** rather than walking its nodes.
  - `:382-428` — the Proxy handler refuses `defineProperty`, `preventExtensions` and `setPrototypeOf` outright, and returns `undefined` for `then` on a settled context (so an `await` on a revoked draft does not hang).
  - `:1602-1674` — `emitOperations()` buckets dirty nodes by depth so parents are emitted before children, and folds to a **root replacement** when the op count exceeds `MAX_DELTA_OPERATIONS = 4096`.
  - `:1676-1711` — a fast path for the common case (few dirty nodes, no arrays, no reserved keys) that emits a plain sorted list of `s`/`d` ops and materialises the candidate directly.
  - `:1899-1917` — `orderedArrayPlan()` computes removals and inserts **from the pieces alone**, so "appending to a long array costs no walk over its elements."
  - `:1920-1950` — `elementArrayPlan()` is the fallback for pieces that moved base elements; it computes a permutation.
  - `:2146-2156` — `ensureOperations()` turns a replacement into `[["r", value]]` unless the value is deeply equal, in which case the ops are empty.
- **Edge cases / failure handling:** `Change.state` throws `"Cannot use a settled overlay"` after `prepare()`/`abort()`; a prepared change from another tracker, an aborted one, or a stale one is rejected by `adopt()`.
- **Surprising:** the tracker tracks `{v: value}`-style boxes when it needs a container (see `cell.ts`), and the *proxy* is a `Proxy` over a real target object, so `Object.keys`, `JSON.stringify`, `Map` iteration and native array mutators all have to be re-implemented faithfully — the test file `delta-tracker/tracker.test.ts` asserts each of those behaviours individually (`:351-402` "supports native reads, descriptors, keys, iteration, map, and JSON").

### packages/chord/src/delta/diff.ts
- **Purpose:** Structural diff between two immutable JSON revisions → an op batch. 523 lines.
- **Key abstractions:** `diffRevisions()`, `diffValue`/`diffObject`/`diffArray`, `emitString`, `lcsMatches`, `identityAnchors`, `permutation`.
- **Data flow:** two JSON values → `Op[]`.
- **Non-obvious design decisions:**
  - `:5-15` — `MAX_DELTA_OPERATIONS = 4096`; on overflow the batch is replaced by a single `r`.
  - `:63-76` — string diffs prefer an append; otherwise an overlap-based front-truncate + append.
  - `:91-122` — an LCS is computed only when `before.length * after.length <= MAX_SEMANTIC_CELLS (65536)`.
  - `:183-251` — `identityAnchors()` is a patience-sort style LIS over value identity, with a `MAX_IDENTITY_CANDIDATES = 200_000` fallback to a greedy anchor.
  - `:313-335` — when the two arrays have equal length, a *positional* match is tried first (the common "one row changed" case).
  - `:460-510` — `jsonCost`/`pathCost`/`operationCost` estimate the **encoded** size of the batch.
  - `:513-523` — the final decision is economic: if the delta costs ≥ 65 536 bytes, compare it against the cost of a whole snapshot and emit whichever is smaller.
- **Edge cases / failure handling:** `diffObject` refuses to emit per-key ops when a reserved segment is present and falls back to a whole-object `s` (`:428-431`).
- **Surprising:** `permutation()` (`:45-61`) matches by **value identity** using a `Map<JsonValue, …>` — it works for primitives and for distinct object references, but two structurally-equal-but-distinct objects will not match, which is why the test at `delta-diff.test.ts:63` asserts a reordered pair of deeply-equal objects normalises to a **no-op**.

### packages/chord/src/delta/apply-immutable-trusted.ts
- **Purpose:** A fast applier for **self-produced** ops: 128 lines, no validation, one copy per touched container.
- **Key abstractions:** `applyImmutableTrusted(target, operations)`, `copyPath`, `spliceTrusted`, `permuteTrusted`.
- **Data flow:** base value + trusted `Op[]` → new value.
- **Non-obvious design decisions:** `:7-12` — a single shared mutable `DATA_DESCRIPTOR` object, with its `value` field swapped between uses (a micro-optimisation that also guarantees every write is an enumerable data property).
- **Edge cases / failure handling:** `:48` — "Trusted append target is not a string" is a `TypeError`, not a `PathError`; the trusted path assumes the ops are well-formed.
- **Surprising:** `materializeOperations` in `tracker.ts:343-349` picks `applyImmutable` (the checked one) for `p`/`m` ops and the trusted one otherwise, with the comment "Native splice/permutation remains faster for large structural batches."

### packages/chord/src/delta/revision-validator.ts
- **Purpose:** 75 lines — `JsonRevisionValidator`, which validates that a revision is strict JSON (dense arrays, plain objects, enumerable data properties, no cycles, no symbols) while **skipping containers already validated in an earlier revision** via a `WeakSet`.
- **Key abstractions:** `JsonRevisionValidator.validate(value)`.
- **Data flow:** a candidate revision → validated in place (it returns the same object).
- **Non-obvious design decisions:** `:9` — the `#validated` `WeakSet` is what makes re-validating a structurally-shared revision cheap.
- **Edge cases / failure handling:** `:27` symbols rejected; `:29-31` accessors and non-enumerable properties rejected; `:58-60` sparse or extra-keyed arrays rejected.
- **Surprising:** `:16` — an already-validated container is returned without re-walking, so a revision that shares 99 % of its containers with the previous one costs almost nothing to validate.

### packages/chord/src/delta/draft.ts
- **Purpose:** 10 lines — the `Draft<T>` type: a deeply-mutable view of a JSON value, with recursion capped at depth 8 (`Depth["length"] extends 8 ? T : …`).
- **Key abstractions:** `Draft<T, Depth>`.
- **Data flow:** type only.
- **Non-obvious design decisions:** the depth cap exists so that deeply nested types terminate in the type system.
- **Surprising:** primitives, functions and `null` pass through unchanged — a function placed in a draft is *not* a JSON value, which the runtime rejects at placement time.

### packages/chord/src/delta/README.md
- **Purpose:** 193 lines — the delta module's specification: a mutation-rights table, the lifecycle, the op vocabulary, and a "limits and footguns" section.
- **Key abstractions:** the mutation-rights table (`:30-40`) is the contract.
- **Data flow:** n/a (docs).
- **Non-obvious design decisions:** `:6-7` — "Immutability is an ownership contract. Nothing is frozen or defensively copied, so an illegal mutation is not detected. It silently corrupts state." `:96-104` — "Full roots are trusted… take ownership in O(1) and never walk the tree."
- **Edge cases / failure handling:** `:115-122` — `undefined` rules differ by position: `obj.key = undefined` deletes, `arr[i] = undefined` throws, and `undefined` nested inside a placed object throws (it is *not* dropped like `JSON.stringify` does).
- **Surprising:** `:189-190` — the measured cost of the design: "Placement validation costs time and memory on bulk inserts. In a benchmark unshifting 100k three-field objects, it added about 19 ms and 20 MiB of transient heap", and "20,000 hot nested reads took about 9 ms through the tracker versus 0.08 ms on raw objects."

### packages/chord/src/state.ts
- **Purpose:** 423 lines — `replicatedState()`: either an authoritative mutable state or a publication-only view attached to an external revision source.
- **Key abstractions:** `ReplicatedState`, `MutableReplicatedState`, `ReplicatedStateSource`/`Attachment`/`Frame`, `StateSubscriber`, `ReplicatedStatePublisher`.
- **Data flow:** `change(ctx, draft)` → a tracker change → `prepare()` → `adopt()` → `publisher.publish(value, ctx)` → per-subscriber serialised delivery.
- **Non-obvious design decisions:**
  - `:115-124` — each subscription keeps **at most 100 pending deliveries**; on overflow only the newest pending value survives — "Thus public delivery sequences may skip." The not-yet-started initial hydration is explicitly preserved.
  - `:126-148` — a subscriber's callbacks are serialised: an async listener is awaited before the next delivery, and a synchronous one runs synchronously.
  - `:255-278` — `change()` is atomic: a throwing callback leaves "the original value and sequence unchanged", and the draft is revoked. Re-entrancy is refused outright ("Replicated state cannot be changed reentrantly from a change callback").
  - `:263-266` — an async change callback is **rejected**, not awaited: "Replicated state change callbacks must be synchronous".
  - `:326-339` — an attached source's frames must arrive with a **contiguous cursor**; a gap fails the attachment.
  - `:394-398` — with no `onError` handler, a subscriber failure is rethrown in a microtask (so it surfaces as an unhandled rejection rather than being swallowed).
- **Edge cases / failure handling:** `:341-351` — a failure disposes the attachment and, if the dispose also fails, reports an `AggregateError` of both.
- **Surprising:** `:395` — the error is thrown in a `queueMicrotask`, i.e. *after* the failing call has already returned, so the caller sees a successful call and an asynchronous crash.

### packages/chord/src/cell.ts
- **Purpose:** 402 lines — the object-owned state source: `Cell` (a mutable cell with a schema) and `Derived` (a synchronous projection), plus the `Fanout` that delivers to subscribers.
- **Key abstractions:** `Source`, `Cell<T>`, `Derived<T>`, `HYDRATION`/`Hydration`, `unhydrated()`.
- **Data flow:** `cell.change(ctx, draft)` → tracker change → ops → `holdPublications(() => { adopt; fanout.emit; derived.install })`.
- **Non-obvious design decisions:**
  - `:44-51` — `Fanout.emit()` **queues** delivery through the process-wide publication queue and re-checks membership at delivery time: "A listener that subscribes later already got this revision in its snapshot; one that unsubscribes before delivery is skipped."
  - `:122-147` — the tracker tracks `{v: value}` because "the tracker tracks containers", and `unbox()` strips the box from the published ops.
  - `:198-219` — `change()` publishes **only the mutated paths**; a returned value replaces the whole value and is always validated.
  - `:228-235` — `replace()` publishes a *structural diff* when the new value shares a container with the old one (i.e. it is a new revision of the same state), and a single `r` otherwise.
  - `:286-305` — `computeDependents()` recomputes every transitive derivation **in dependency order** (by `seq`) against candidate values, and validates them — before anything is published.
  - `:266-271` — the whole publish is wrapped in `holdPublications()`, so no observer can see a half-applied multi-source change.
  - `:340-348` — a `Derived` over a not-yet-hydrated source exposes `HYDRATION`, so an object that forwards or derives from a remote member waits for the snapshot before going live.
- **Edge cases / failure handling:** `:208` — an async `change` callback throws `"cell.change callbacks must be synchronous"`; `:190` — reading an uninitialised cell throws `not_ready`; `:202` — the write guard runs first, so a write from inside a factory is `read_only`.
- **Surprising:** `:276-283` — `sharesStructure()` is how `replace()` decides between a diff and a whole replacement: it looks for *one* shared container at the same key. A value that shares nothing is a replacement even if it is deeply equal.

### packages/chord/src/publish.ts
- **Purpose:** 39 lines — one process-wide FIFO queue for every observer notification.
- **Key abstractions:** `enqueue(task)`, `holdPublications(fn)`.
- **Data flow:** a write enqueues its notifications; `drain()` runs them in order.
- **Non-obvious design decisions:** the header comment states the whole reason: "notifying observers synchronously from inside a write lets a re-entrant write overtake the write being published. Example: subscriber A reacts to n = 1 by writing n = 2; subscriber B then sees 2 before 1." The fix: "a publication first adopts every revision it makes (cells and derivations), then enqueues its notifications."
- **Edge cases / failure handling:** `drain()` sets a `draining` flag so a re-entrant `enqueue` does not recurse; a task that throws propagates out of `drain()` and aborts the remaining queue.
- **Surprising:** `docs/spec.md:262` lists the cost honestly — "The publication queue is process-wide and synchronous. A slow observer delays every later notification in the process, including those of other hosts in the same process."

### packages/chord/src/contract.ts
- **Purpose:** 440 lines — the contract system: `remote()`/`local()`/`method()`/`opaque()`, placement resolution, the description/fingerprint, and the `coverage()`/`bind()` compatibility checks.
- **Key abstractions:** `RemoteContract`/`LocalContract`, `Description` (the wire token), `Placement` (`hostNamed` / `hostFamily`), `Adapter`/`Accepts`.
- **Data flow:** a contract definition → a `Description` (JSON-safe) → a `fingerprint` (`hash64(canonicalJson(description))`) → travels in a `hold` frame.
- **Non-obvious design decisions:**
  - `:178-190` — `RESERVED_MEMBERS` forbids a member named `variant`, `status`, `ready`, `shape`, `error`, `onShape`, `onStatus`, `release`, `then`, `contract`.
  - `:288-314` — `coverage()` is a **structural** check, not an equality check: additive changes (extra optional fields, extra result fields) are covered; a required field added, a type changed or a method's arity changed is not.
  - `:326-351` — `bind()` refuses to bridge two *placements* with an adapter: "A moved type is another type for its consumers: no adapter reaches across hosts."
  - `:100-101` — the placement is rendered for an error message; the fingerprint itself is `hash64(canonicalJson(description))` (`packages/chord/src/schema.ts:12-19` and `:22-31`), so key order never changes a contract's identity.
  - `packages/chord/docs/spec.md:54-58` — the canonical identity of an input omits fields equal to their schema default, so "Changing defaults or normalization requires a new type name."
- **Edge cases / failure handling:** `invalid/placement` when a `hostFamily` input's key field is missing or empty; `contract_mismatch` with a *reason* string ("variant X missing", "kind.name arguments", …) that names the exact incompatibility.
- **Surprising:** `:39-42` — `opaque()` ids must match `name@version` exactly, and a remote contract may not expose an opaque member at all.

### packages/chord/src/declare.ts
- **Purpose:** 38 lines — the shapes a factory declares *besides* state cells: `ResourceDeclaration`, `Resource`, `ListenerDecl`, `Subscribable`, and the `ValueOf`/`EventOf` type helpers.
- **Key abstractions:** `ResourceDeclaration<T>` (`version`, optional `deps`, optional `exclusive`, `open(options)`, optional `close(value)`).
- **Data flow:** the factory calls `self.resource(name, declaration)`; the runtime opens it at prepare (or at the gate when exclusive) and closes it at disposal.
- **Non-obvious design decisions:** `:10-18` — `version` is **required**: "Bump to replace the resource at the next reload (a native value has no schema to detect a change)." `deps` are "References or resources that must be live/open first. A change replaces the resource." `exclusive` means "Exclusive resources are replaced at the gate: old closed before new opened."
- **Edge cases / failure handling:** `:22-25` — `Resource.value` "Throws not_ready until opened."
- **Surprising:** `:35-36` — a cell has a `key` and a `value` too, "so sources are matched before resources" in a listener declaration; `ValueOf`/`EventOf` are conditional types that resolve a listener's payload from either a `Subscribable` or a `Resource`.

### packages/chord/src/schema.ts
- **Purpose:** 219 lines — canonical JSON, a 64-bit hash, TypeBox validation/normalisation, and `fits()`: a conservative structural subtyping check.
- **Key abstractions:** `canonicalJson`, `hash64`, `assertValid`, `normalize`, `canonicalIdentity`, `fits`.
- **Data flow:** a value → `normalize` (defaults + strip unknown) → `assertValid` → `canonicalIdentity` → the object's address.
- **Non-obvious design decisions:**
  - `:21-31` — `hash64` is two FNV-1a lanes, non-cryptographic, because "Contracts are trusted, so collisions are not an attack surface."
  - `:74-123` — `fits()` models a fixed list of keywords (`CONSTRAINTS` + structure) and treats **any other keyword in the provider's schema as forcing exact equality**. Annotations (`title`, `description`, `default`, …) are stripped first.
  - `:134-160` — the subtyping rules: a function accepting fewer parameters is fine; each shared parameter is contravariant; `integer` fits `number`.
  - `:176-179` — `additionalProperties: false` in the *sup* schema requires the sub-schema to also forbid extras and to have no extra properties.
  - `:46-50` — `normalize()` = `Value.Clean(Value.Default(Value.Clone(value ?? {})))`: apply defaults, strip unknown fields, validate, return a fresh value.
- **Edge cases / failure handling:** `assertValid` reports the first three TypeBox errors with their instance paths.
- **Surprising:** `:180-199` — the `patternProperties` rule is deliberately asymmetric: a consumer that allows arbitrary extra names cannot fit a provider with a pattern, "it would then allow any value under a matching one."

### packages/chord/src/types.ts
- **Purpose:** 89 lines — the shared vocabulary: `Ctx`, `GetOptions`, `Readable`, `StateEvent`, `RefBase`, `Shape`, `RefStatus`.
- **Key abstractions:** `Ctx<P>` (the explicit call context: `signal`, `rootId`, `codeVersion`, `principal`, `get`), `StateEvent<T>` (`snap` | `ops` | `reset`), `Readable<T>` (`value`, `subscribe`, `events`).
- **Non-obvious design decisions:** `:28-33` — `ctx.get` "Resolves once it is ready: live, with every state member of its variant (unless `state: false`)" and "rejects with the activation error, `aborted` when the ctx is aborted or the call settles first, or `unavailable/ready_timeout` after the host's `readyTimeout`; the reference is released then."
- **Surprising:** `:64` — `RefStatus` includes `"loading"` as a distinct state, and a reference *re-enters* `loading` when a link reconnects.

### packages/chord/src/errors.ts
- **Purpose:** 76 lines — the error model: a fixed code vocabulary, a finer `reason`, and a `retryable` flag.
- **Key abstractions:** `ChordError`, `CHORD_ERROR_CODES` (12 codes), `isChordError`, `forbidden`, `invalid`, `asChordError`, `runAll`.
- **Data flow:** a thrown error → `asChordError` → a `ChordError` → `toWireError`/`fromWireError` on the wire.
- **Non-obvious design decisions:**
  - `:24` — **only two codes are retryable**: `superseded` and `upgrade_conflict`. Everything else is terminal.
  - `:36` — the message format is `code[/reason]: message`, so the reason survives a log line.
  - `:56-62` — `asChordError` keeps a `ChordError`'s code and turns anything else into `unavailable` with the original as `cause`.
  - `:64-76` — `runAll()` runs every step, then throws the single error or an `AggregateError` of all of them.
- **Edge cases / failure handling:** a refused or aborted reload keeps the code of its cause (`:1`).
- **Surprising:** `runAll` exists because disposal must not stop at the first failure — a resource that fails to close must not prevent the others from closing.

### packages/chord/src/object.ts
- **Purpose:** 1932 lines — the object runtime: `Self` (the declaration surface), `ObjectImpl` (the live object), `ResourceImpl`, `Decls`, `CtxImpl`, `RefImpl`.
- **Key abstractions:** `Service` (contract + factory + options + facet), `Self.state/get/resource/on/task/derive/register/expose`, `Lifetime` (`"referenced" | "host"`), `StateOptions` (`version` + `migrate`).
- **Data flow:** a factory runs synchronously and *declares*; activation then opens resources, waits for references, runs `init`s, attaches derivations and starts listeners/tasks.
- **Non-obvious design decisions:**
  - `:48-75` — `ServeOptions` is a **union**; `lifetime: "host"` compiles only for a local type whose input accepts `{}` (`ServeOptionsFor`), and is refused at runtime too (`:112-130`).
  - `:134-143` — a cell's `version` and `migrate(old, from)` are per-cell; "The cell may be several versions behind."
  - `:145-153` — `init` runs "after the object's resources are open and its references are live, before the object goes live, so no call, listener or subscriber sees a value that is not from the source."
  - `:156-203` — `Self`'s doc comments state the reload survival rules for every declaration kind (state survives, resources survive unless `version`/`deps`/`exclusive` change, listeners are kept while their source and `select` are unchanged, derivations and tasks are new every reload).
  - `:213-285` — `ResourceImpl.open()` closes the value it produced if the signal aborted while it was opening: "nobody owns it any more."
  - `:287-309` — `ResourceFacade` makes `resource.value` throw `not_ready` **while any factory runs**, so a reload's prepare dry-run cannot touch the native resource the old code uses.
  - `:362-402` — `HostCore` is the narrow interface the runtime pieces use, so `object.ts` does not depend on `host.ts`.
- **Edge cases / failure handling:** `ResourceImpl.value` throws `unavailable` for a resource that could not be restored after a failed rollback, and `not_ready` for one that is not open.
- **Surprising:** `object.ts` is 74 KB but has no tests of its own — the behaviour is pinned through `host.test.ts`, `reload.test.ts` and `state.test.ts`.

### packages/chord/src/host.ts
- **Purpose:** 1300+ lines — the host: `createHost()`, `HostImpl`, facets, registries, principals, roots, code versions, `connect`/`accept`/`route`, and the readiness API.
- **Key abstractions:** `HostOptions` (with `self` and `principalKey` **required**), `FacetApi` (`serve`, `name`, `root`, `registry`, `signal`), `Registry`/`RegistryView`, `CodeVersionState` (current + previous).
- **Data flow:** `host.load(facets)` → `facet.setup(api)` → `host.serve(type, factory)` → `HostImpl.objects` keyed by address → activation → `ObjectImpl`.
- **Non-obvious design decisions:**
  - `:96-101` — `defineFacet` wraps a setup function; the facet's `signal` "aborts once this run of the facet is no longer installed".
  - `:114-152` — `HostOptions` requires `self` (the host's own principal) and `principalKey` (which "maps principal to a key that includes connection provenance and grant revision"). The host's own principal is recognised **by key**, not by object identity.
  - `:238-247` — a host keeps exactly **two** code versions: `current` and `previous`.
  - `:1249-1272` — `disposeHoldersFirst()` disposes in waves, "referrers before what they reference, so a resource's `close` can still use its object's references."
  - `:1280-1284` — `matchesPattern()` implements the principal-pattern revocation match.
- **Edge cases / failure handling:** `host.close()` closes links *after* the objects; `invalidatePrincipal` force-disposes matching objects and propagates over links.
- **Surprising:** the `CHANGELOG` records a fix where "References kept every code version's services, and with them the factory code of every reload, reachable for as long as they lived" — i.e. a hot-reload leak of whole code generations.

### packages/chord/src/connection.ts
- **Purpose:** 1327 lines — one link's protocol: the frame dispatcher, the relay, the flow-control window, the per-hold state slots, and the call/result machinery.
- **Key abstractions:** `Connection`, `RelayRef`/`RelayCall`, `Slot` (a `unit` slot or a `state` slot), `Feed` (per-connection, per-member subscription + encoder), `ServedLocal` vs a relay.
- **Data flow:** frames in → `isFrame()` validation → dispatch → `hold`/`call`/`state` handling → frames out.
- **Non-obvious design decisions:**
  - `:12-32` — `LinkOptions`: `pingInterval` 15 s, `pingTimeout` 45 s, `window` 256 KiB, `pendingCap` 4 windows, and `onProtocolMismatch`.
  - `:17-19` — "Only applies when both ends acknowledge frames and the link reports sizes; `Infinity` never holds state back." A link that cannot report sizes (IPC) is **not windowed**.
  - `:44-62` — a state slot keeps a base frame plus the ops to apply after it; once the slot is `lazy` it holds only "the promise of a reset built at flush".
  - `:51-62` — a unit slot is **lazy**: the shape and the snapshots are built from the current values at send time, not at enqueue time.
  - `:64-81` — `AcceptOptions.maxCalls` answers calls beyond the limit at once with `unavailable/too_many_calls` and keeps the link open.
  - `:129-200` — `RelayRef` owns everything done through a relayed hold: queued calls, downstream twins, and `close` undoes all of it exactly once.
- **Edge cases / failure handling:** a frame for a closed link is dropped; a malformed frame closes the link as a protocol error.
- **Surprising:** the spec is explicit that the ordering guarantee is weaker than it looks: "a result may arrive before state changes made before it. Frames of one subscription stay in order" (`docs/spec.md:287`).

### packages/chord/src/remote.ts
- **Purpose:** 658 lines — the consumer side of a remote object: `RemoteBinding` (one hold per host+key, shared by every reference) and `RemoteRef`/`ViewReadable`.
- **Key abstractions:** `RemoteBinding`, `RemoteChannel` (what a binding needs from a link), `RemoteHost` (what it needs from its host), `MemberState` (a value plus its stream's decoder).
- **Data flow:** `shaped()` → `state()` frames → `applyImmutable(value, ops)` → the member's value → `ViewReadable` deliveries.
- **Non-obvious design decisions:**
  - `:245-255` — a shape is applied only once **all** of its snapshots are present, and a *newer* shape arriving before an older one's snapshots waits for both: "relays may reorder them."
  - `:258-288` — a state frame before the first hydration that carries an error ends the binding ("Before the first hydration nobody could read anything: the binding fails instead of waiting forever"); after hydration it is only reported.
  - `:304-314` — `detached()` keeps the last values readable while the binding re-holds after a link loss (status goes back to `loading`).
  - `:334-356` — `call()` waits for the binding to be live, and sends only "what the consumer's own schema knows" (`Value.Clean(description.args, …)`).
  - `:364-383` — `#apply()` drops members that left the variant and announces new ones with a `reset`.
- **Edge cases / failure handling:** `read()` throws `not_ready` before hydration and `not_in_variant` outside the variant; `terminalError()` falls back to `released`.
- **Surprising:** the binding is **shared**: N references to one object cost **one** hold, one snapshot per member, one frame per change and one release (`test/bindings.test.ts:89`).

### packages/chord/src/link.ts
- **Purpose:** 415 lines — the transports: `MemoryLink`/`memoryLinkPair`, `IpcLink`/`ipcLink`, `WebSocketLink`/`webSocketLink`, plus the payload packing layer.
- **Key abstractions:** `Link` (FIFO bidirectional frame channel), `BaseLink` (shared plumbing), `Packed` (a deflated payload kept as received), `PACK_THRESHOLD = 64 KiB`.
- **Data flow:** `send(frame)` → `transmit` → transport; `receive(handler)` → a queue until the handler is set.
- **Non-obvious design decisions:**
  - `:36-39` — `send()` returns the **encoded frame size** "when the transport knows it"; frames without one count as zero, "so a link that never reports sizes is not windowed."
  - `:62-79` — `deliverLater()` chains a frame that is still being decoded behind the ones already decoding, so browser-side inflation preserves order.
  - `:105-111` — packing is a transport optimisation "invisible above the links": a relaying host forwards the deflated bytes unread; only the host that uses the payload inflates it.
  - `:186-202` — a packed WebSocket message is `[envelope length: u32 BE][envelope JSON][deflated payload]`; the payload's JSON is spliced in, not encoded twice.
  - `:181-185` — the object-transport form is `z: [field, base64]`.
  - `:247-251` — `MemoryLink.sever()` simulates a dead network: frames are dropped silently in both directions and **no close is signalled**.
- **Edge cases / failure handling:** `:212-213` — a `bye` frame ends the link with the peer's reason; `:238-247` — a `MemoryLink` does a JSON round trip, which detaches the frame and "rejects what JSON would mangle silently, e.g. bigint."
- **Surprising:** `link.ts:115-117` obtains zlib through `process.getBuiltinModule("node:zlib")` rather than a static import, so the module stays browser-safe.

### packages/chord/src/wire.ts
- **Purpose:** 181 lines — the wire protocol: one TypeBox schema per frame type, `isFrame()`, and the error conversion.
- **Key abstractions:** `Frame` (derived from `FrameSchema`), `PROTOCOL_VERSION = 4`, `toWireError`/`fromWireError`.
- **Data flow:** a frame object → `Value.Check(FrameSchema, …)` → dispatch.
- **Non-obvious design decisions:**
  - `:6-18` — "every frame type has one direction, so ids never collide"; the comment enumerates the directions frame by frame.
  - `:16-17` — "Payloads (hold inputs, call args, results, snapshots) stay `unknown`: they are validated where they are used, against the contract. State ops are checked op by op by the delta decoder."
  - `:19-24` — the protocol version is announced in `hello`; peers of different versions do not talk, and the side that notices closes the link with reason `protocol-version <its version>` so the other side learns too.
  - `:30` — `List` is `Type.Immutable(Type.Array(item))` because "Arrays a sender may pass as readonly."
  - `:181` — `fromWireError` strips the `code[/reason]: ` prefix from the message, because the code travels in its own field.
- **Edge cases / failure handling:** every received frame is validated against the schema; a malformed frame is a protocol violation and closes the link.
- **Surprising:** the `hold` frame carries a **normalised** input ("Normalized with the consumer's contract") and a `token` that is the consumer's contract description — the provider checks that its own contract covers it.

### packages/chord/src/cluster.ts
- **Purpose:** 251 lines — the cross-host reload protocol: the server coordinates prepare/vote/commit across its child hosts; the child side is `ChildReloads`.
- **Key abstractions:** `runClusterReload()`, `reconcileChild()`, `ChildReloads`.
- **Data flow:** server → `prepare` frames → child votes → server `commit` (or `abort` everywhere).
- **Non-obvious design decisions:**
  - `:7-13` (header) — the ordering guarantee: "Links are FIFO, so a child commits before it can receive any frame of a root started in the new code version."
  - `:53-57` — the server **retires first**, because "its `retire` frames reach every child before `prepare` (FIFO), so a child never retires a code version this host still runs roots of."
  - `:89-97` — one failed vote sends `abort` to every participant and rolls back the local prepare.
  - `:123-158` — `reconcileChild()` brings a late-connecting child up to the parent's code version; it re-checks after the vote, because "This host moved on meanwhile."
  - `:160-171` — the child registers the operation **before its first await**, "so an abort or disconnect is never lost."
- **Edge cases / failure handling:** a missed vote deadline rejects with `aborted/vote_deadline`; an abort while the child is still preparing rolls back and the child can reload again.
- **Surprising:** `docs/spec.md:258` — "One level of reload participants. Only the coordinator's direct child hosts take part; a child does not forward `prepare` to its own children."

### packages/chord/src/reload.ts
- **Purpose:** 723 lines — the hot-reload protocol for one host: `Reload` (prepare → gate → commit → retire) and `runReload`.
- **Key abstractions:** `Reload`, `Candidate` (the prepared replacement of one object), `ReloadOptions`/`ReloadReport`, `dryRun()`.
- **Data flow:** `beginReload` → `load()` (new services) → `checkProviders()` → `prepareAll()` → `gate()` → `commit()`; any failure → `rollback()`.
- **Non-obvious design decisions:**
  - `:76-92` — `dryRun()` computes the new derivations over the *candidate* values and validates every prospective value against every schema that will apply after the commit, "so a failure fails prepare; the commit then installs without re-checking."
  - `:204-224` — `prepare()` order: retirement → load → provider check → prepare all → **set `host.gating`** → wait for in-flight activations → check references → build tables → gate → stage listeners. The comment at `:211-213` explains the gating flag: "From here new objects of changed types are rejected (upgrade_conflict, retryable) until commit or abort, so the candidate set is final once the activations already in flight have been prepared."
  - `:245-257` — `#stage()` subscribes every listener **now**, buffering its events, "so a failing source fails prepare instead of leaving a half-installed code version."
  - `:259-276` — `waitForRetirement()`: past the deadline the old code version is retired anyway, but its remaining roots are **aborted first** and get a 1 s grace, "so they see cancellation before the resources only that code version used are closed."
  - `:321-345` — `checkProviders()`: a *same-version* contract must still cover the old description — a forgotten bump is refused with the exact reason ("changed incompatibly without a version bump (input)").
- **Edge cases / failure handling:** every failure path calls `rollback()` and rethrows `reloadError(error)`, which keeps the cause's code and prefixes the message with "reload aborted: ".
- **Surprising:** `docs/spec.md:257` — "The commit decision is not persisted… A server crash between its own commit and a child's commit leaves that child on the old code version until it reconnects and is reconciled." An honest, documented hole.

- **Purpose:** `manager.ts` (443 lines) — the Node host manager: `forkDriver`, `createHostManager`, `childControl`, `processLock`.
- **Key abstractions:** `Driver`/`Instance`/`HostManager`/`Liveness`/`ControlMessage`.
- **Data flow:** `manager.start()` → `driver.spawn()` → a control handshake (`ready`) → a keep-alive poll on `liveness`.
- **Non-obvious design decisions:**
  - `:73-123` — `processLock()` uses a **kernel-owned** lock: an abstract socket on Linux/Android, a named pipe on Windows, a probed socket file elsewhere. "…vanishes with its process, so there is no stale state to take over and no race between two would-be owners."
  - `:126-144` — `sun_path` holds 104 bytes on macOS, so a too-deep TMPDIR falls back to `/tmp/chord2-<uid>` with `0o700` and an ownership check.
  - `:164-229` — the child is **detached** so it leads a process group and the whole tree can be killed; the group is killed on *every* exit path.
  - `:196-201` — "However the leader ended (graceful, crash, kill), nothing it spawned outlives it."
  - `:278-300` — `doStop()` sends `shutdown`, waits `grace` (5 s), then kills the tree.
  - `:350-352` — the idle clock starts at the busy→idle **transition**, not at the last busy report.
- **Edge cases / failure handling:** a write to an exited child fails with `EPIPE`; the manager treats the exit as the fact, not the error.
- **Surprising:** `manager.ts:167-171` — a lock this process inherited is *deleted* from the child's env, so a child that forks its own children does not make them fail with `locked`.

### packages/chord/src/context/index.ts
- **Purpose:** 161 lines — the explicit `Context`: typed values, cancellation and telemetry, with no `AsyncLocalStorage` dependency.
- **Key abstractions:** `Context`, `ContextKey<T>`, `withContextValue`, `withTelemetry`, `traceIn`, `withAbortSignal`, `withoutAbortSignal`, `withCancel`, `awaitWithContext`, `BACKGROUND_CONTEXT`/`TODO_CONTEXT`.
- **Data flow:** a parent context → a derived context → a child context; every derivation is a new immutable object.
- **Non-obvious design decisions:**
  - `:56-76` — `ContextValue` chains to its parent, so a derivation never mutates anything.
  - `:107-115` — `withAbortSignal` combines with `AbortSignal.any([parent, signal])` so a child is cancelled by either.
  - `:117-120` — `withoutAbortSignal` "retaining all values except caller cancellation. Intended for mandatory cleanup only" — a cancellation mask for teardown.
  - `:138-156` — `awaitWithContext` "Cancellation rejects only this waiter; it does not cancel the underlying promise."
  - `:158-161` — an abort reason that is not an `Error` becomes a `DOMException("The operation was aborted", "AbortError")`.
- **Edge cases / failure handling:** an already-aborted signal rejects immediately.
- **Surprising:** `telemetry` is a **required** member of `Context` (the 1.4.0 breaking change) — the no-op span is the default, so there is no optional-telemetry branch anywhere.

### packages/chord/src/loader.ts
- **Purpose:** 67 lines — the Node facet module loader: `nodeLoader`, a `node:module` resolve hook, and a cache-busting query.
- **Key abstractions:** `FacetLoader` (implemented here), the `chord2-reload` query parameter.
- **Data flow:** `host.load([moduleUrl])` → register the hook → `import(url?chord2-reload=N)` → the facet's default export.
- **Non-obvious design decisions:** `:3-5` — the file's own TODO states the gap: "replace with an isolating, evicting loader. Every reload imports fresh module copies under a new query and the old copies are never evicted (they leak until the process exits). TUI plugins need isolation, which this loader does not provide." `:22-36` — the resolve hook carries the reload query from a re-imported parent to its children inside a facet's directory, but only inside a registered root, so "Modules outside (Chord itself, shared code) stay single instances." `:53-54` — every root is registered **before** any import, so load order cannot produce duplicate module copies.
- **Edge cases / failure handling:** a module whose default export is not a facet throws `TypeError: <name>: default export must be a facet (defineFacet)`.
- **Surprising:** the dynamic `import()` is an explicitly owner-approved exception to the repo's no-dynamic-import rule (`:58`).

### packages/chord/src/registry.ts
- **Purpose:** 30 lines — the registry abstraction: `defineRegistry(name, {conflict})`, `RegistryView` (a per-code-version table with a subscriber).
- **Key abstractions:** `Registry<V>`, `RegistryTable<V>` (`ReadonlyMap<string, V>`), `RegistryView<V>`.
- **Non-obvious design decisions:** `:10-14` — `conflict: "error"` (default) rejects two objects registering one key; `"last"` keeps the later registration. `:19-20` — the table is "of `ctx.codeVersion`, or of the current code version without ctx" — a registry snapshot is per code version.
- **Surprising:** only objects of `lifetime: "host"` may register (enforced in `object.ts` with reason `invalid/not_host_lifetime`), so a registry is a host-level singleton table rather than per-object state.

### packages/chord/src/websocket.ts
- **Purpose:** 35 lines — `acceptWebSockets()`: accept every connection of a `ws`-like server as a client link, stamped with the authenticated principal.
- **Key abstractions:** `WebSocketServerLike` (structural — Chord does not depend on `ws`), `WebSocketAcceptOptions`.
- **Non-obvious design decisions:** `:24-26` — "Wrap at once so frames sent while authenticating are queued, not lost. Large payloads go out deflated; clients may not send packed frames (a small message could inflate to anything)." → `webSocketLink(socket, {compress: true, acceptPacked: false})`.
- **Edge cases / failure handling:** an unauthenticated connection is closed with `"unauthorized"`; a failing authenticator closes with `"authentication failed"`.
- **Surprising:** WebSocket peers are **always** clients — "no roots, no code versions, no reload votes, not addressable" (`:10`).

### packages/chord/src/output.ts
- **Purpose:** 406 lines — bounded output streams and paced progress commits.
- **Key abstractions:** `OutputBuffer` (a head/tail window over a stream), `boundOutput`, `sanitizeOutput`, `utf8ByteLength`, `Progress` (adaptive commit pacing), `ProgressClock`.
- **Data flow:** `push(chunk, skipped?)` → a bounded store → `snapshot()` → `{text, droppedBytes, droppedLines}`.
- **Non-obvious design decisions:**
  - `:39-42` — `sanitizeOutput` removes control characters that "break display and transcripts" but keeps tabs and newlines.
  - `:36-37` — the decoder is `ignoreBOM: true` and the BOM is dropped only at the very start, "never a U+FEFF later in it."
  - `:158-171` — `push()` accepts a `skipped` marker (bytes/newlines omitted upstream); it is only legal with `tail` retention, because with `head` retention the omitted text could still be inside the window.
  - `:200-215` — head retention stops storing once the window is full ("Nothing past a full window is ever needed"); tail retention drops leading chunks but keeps one extra byte/line "so the window's line start can still be found."
  - `:220-240` — `snapshot()` reports the dropped totals for the **whole stream**, not just the stored window.
  - `:302-303` — `PROGRESS_BYTES_PER_SECOND = 100 KiB`; `:320-324` — "the first change after an idle period commits at once; each commit then delays the next by at least `minIntervalMs` and by its written size at 100 KiB/s. At most one commit is in flight; changes made meanwhile coalesce into the next one."
- **Edge cases / failure handling:** `:184-187` — `end()` flushes an incomplete trailing character as U+FFFD.
- **Surprising:** `output-skip.test.ts` runs 3000 seeded random streams and asserts the skipping buffer's snapshot equals the full stream's snapshot **for every legal skip pattern** — a property test, not an example test.

### packages/chord/src/json.ts
- **Purpose:** 135 lines — `JsonValue`, `JsonRepresentation<T>`, `copyJson()`, `isJsonValue()`.
- **Key abstractions:** `copyJson(value, {omitUndefinedProperties})` — copies into an alias-free strict-JSON tree.
- **Data flow:** an arbitrary value → a validated strict-JSON copy.
- **Non-obvious design decisions:** `:35-80` — the copy walk *is* the validator: it rejects cycles, non-plain prototypes, accessors, symbol keys, sparse arrays, non-finite numbers, and `undefined` (unless `omitUndefinedProperties` is set, and even then only for object properties — "without normalizing arrays").
- **Edge cases / failure handling:** `omitUndefinedProperties` drops an `undefined` object property but `copyJson([undefined], {omitUndefinedProperties: true})` still throws.
- **Surprising:** `:62-64` — a null-prototype object is preserved (`Object.create(prototype)`), and an own `__proto__` data property survives the copy (the test pins this at `test/json.test.ts`).

*(Already described above.)*

### packages/chord/src/index.ts
- **Purpose:** The 82-line package barrel. Re-exports the contract API, `createHost`/`defineFacet`, the delta `Draft` type, the error helpers, `copyJson`/`isJsonValue`, the link builders, the `replicatedState` family, `acceptWebSockets`, and `PROTOCOL_VERSION`.

### packages/chord/src/node.ts
- **Purpose:** A 16-line Node-only barrel: `nodeLoader` plus the host-manager surface (`createHostManager`, `forkDriver`, `childControl`, `processLock`).

### packages/chord/src/sqlite/index.ts
- **Purpose:** A 3-line barrel: `SqliteDatabase`/`SqliteExecutor`/`SqliteValue`, `applySqliteMigrations`, `validateSqliteSchemaPrefix`.

### packages/chord/src/sqlite/database.ts
- **Purpose:** 38 lines — the portable SQLite facade: `SqliteExecutor` (`exec`/`run`/`get`/`all`) and `SqliteDatabase` (`transaction`/`close`).
- **Non-obvious design decisions:** `:23-33` — the transaction contract is spelled out in the interface: "All work in the transaction must use that handle; the handle is invalid after the callback settles. Adapters must queue unrelated operations and other transactions until the transaction finishes." and "When the callback rejects, the adapter must roll the transaction back before rejecting with that same error. If rollback fails, it must reject with a different error (for example an `AggregateError`) so callers cannot mistake the callback error for a guaranteed rollback."
- **Surprising:** `:27-28` — "Calling the database itself (including `transaction` or `close`) from inside a callback therefore waits for that transaction and never settles." A footgun documented in the type.

### packages/chord/src/sqlite/migrations.ts
- **Purpose:** 43 lines — `applySqliteMigrations(database, migrations, {table})`: applies all pending migrations atomically, tracking the version in a metadata table.
- **Non-obvious design decisions:** `:19-23` — migration versions must be contiguous and start at 1, checked **before** the database is touched. `:34-36` — a stored version newer than the supported one is refused ("A copy on a newer schema is refused" is the August analogue).
- **Edge cases / failure handling:** the whole thing is one transaction; the metadata table is `STRICT` with a singleton check.

### packages/chord/src/sqlite/schema.ts
- **Purpose:** 9 lines — `validateSqliteSchemaPrefix(prefix)`: the prefix must be a valid identifier and must not start with `sqlite_` (reserved).

### packages/chord/src/sqlite/node.ts
- **Purpose:** 201 lines — the Node adapter: `NodeSqliteDatabase`, `openNodeSqliteDatabase`, and a `SerialOperationQueue`.
- **Key abstractions:** `SerialOperationQueue` (`:26-69`) — operations run in call order; an async operation holds the queue until it settles.
- **Non-obvious design decisions:** `:42-44` — "Publish the barrier before the operation starts, so calls it makes synchronously wait behind it." `:139-158` — `transaction()` uses `BEGIN IMMEDIATE` and, on failure, rolls back and throws an `AggregateError` of [callback error, rollback error] rather than the callback error alone. `:160-171` — `close()` checkpoints the WAL (`PRAGMA wal_checkpoint(TRUNCATE)`) before closing.
- **Edge cases / failure handling:** a transaction handle used after the callback settled throws "SQLite transaction handle is no longer active" (`:125`).
- **Surprising:** the defaults differ from SQLite's: `busyTimeoutMs` 5 000 (SQLite: 0) and `walAutoCheckpointPages` 1 000 (`:15-16`).

### packages/chord/src/sqlite/cloudflare.ts
- **Purpose:** 5.8 KB — the Cloudflare Durable Object adapter: `DurableObjectSqliteDatabase` over a `DurableObjectSqliteStorage` binding.
- **Key abstractions:** `DurableObjectSqliteStorage` (a structural binding type).
- **Non-obvious design decisions:** it is a *structural* adapter, so the package does not depend on the Workers runtime; the test suite uses a stand-in over `node:sqlite` (`test/sqlite/helpers.ts`).
- **Edge cases / failure handling:** a bigint binding outside the safe-integer range is refused with a `RangeError` (pinned in `test/sqlite/cloudflare.test.ts`).
- **Surprising:** `get()` reads only the cursor's first row (`next()`, not `toArray()`), so a `get` never materialises the whole result set.

### packages/chord/src/telemetry-sqlite/index.ts
- **Purpose:** 12 KB — `createSqliteTelemetry(db, {retentionMs, maxQueuedSpans})`: a buffered, portable telemetry recorder over any `SqliteDatabase`.
- **Key abstractions:** the `TelemetryStore` queries (`findTraces`, `getTrace`, `findMetrics`).
- **Non-obvious design decisions:** the recording path performs no SQL; a one-second timer flushes settled spans and completed ten-second metric intervals in one transaction, including retention cleanup. Metrics retain count/sum/min/max per series — "not raw samples, buckets, or exemplars."
- **Edge cases / failure handling:** "A write failure stops recording permanently: `flush()` and `close()` reject with the original error without retrying." `maxQueuedSpans` defaults to 10 000 and counts settled spans awaiting commit, including an in-flight batch; overflow increments `droppedSpans`.
- **Surprising:** `close()` "stops recording and drains partial metric intervals without waiting for business callbacks or closing the database" — the database is the caller's to close.

### packages/chord/src/telemetry-sqlite/store.ts
- **Purpose:** 171 lines — the read side: `getTrace`, `findTraces` (with cursor pagination), `findMetrics`.
- **Non-obvious design decisions:** `:48-64` — `attributesSql()` builds a JSON-equality filter that "must distinguish boolean true from numeric 1" by checking `json_each`'s `entry.type`.
- **Edge cases / failure handling:** the cursor is a JSON `[started_ms, trace_id]` pair; the query is `(started_ms < ? OR (started_ms = ? AND trace_id > ?))` for a stable total order.
- **Surprising:** the whole `findTraces` runs inside one transaction so the head set and the span set are consistent.

### packages/chord/src/manager.ts
- **Purpose:** 443 lines — the Node host manager: `forkDriver`, `createHostManager`, `childControl`, `processLock`.
- **Key abstractions:** `Driver`/`Instance`/`HostManager`/`Liveness`/`ControlMessage`.
- **Data flow:** `manager.start()` → `driver.spawn()` → a control handshake (`ready`) → a keep-alive poll on `liveness`.
- **Non-obvious design decisions:** `:73-123` — `processLock()` uses a **kernel-owned** lock: an abstract socket on Linux/Android, a named pipe on Windows, a probed socket file elsewhere. "…vanishes with its process, so there is no stale state to take over and no race between two would-be owners." `:126-144` — `sun_path` holds 104 bytes on macOS, so a too-deep TMPDIR falls back to `/tmp/chord2-<uid>` with `0o700` and an ownership check. `:164-229` — the child is **detached** so it leads a process group and the whole tree can be killed; the group is killed on *every* exit path. `:196-201` — "However the leader ended (graceful, crash, kill), nothing it spawned outlives it." `:278-300` — `doStop()` sends `shutdown`, waits `grace` (5 s), then kills the tree. `:350-352` — the idle clock starts at the busy→idle **transition**, not at the last busy report.
- **Edge cases / failure handling:** a write to an exited child fails with `EPIPE`; the manager treats the exit as the fact, not the error.
- **Surprising:** `:167-171` — a lock this process inherited is *deleted* from the child's env, so a child that forks its own children does not make them fail with `locked`.

### packages/chord/docs/spec.md
- **Purpose:** 288 lines — the *specification*: concepts, contracts, the compatibility rule, factory/declaration semantics, activation, lifetime, roots and code versions, reload, registries, hosts/links, the host manager, test coverage, and a "known limitations and decisions" section.
- **Key abstractions:** the concept table (`:12-23`), the compatibility rule (`:60-74`), the reload steps (`:201-219`), the decisions list (`:269-288`).
- **Non-obvious design decisions:** `:3` — "Where it and the code disagree, the disagreement is a bug." `:196` — "Explicit; no AsyncLocalStorage dependency (may be used in dev to warn)." `:288` — "The state API stays. Objects keep named cells and unnamed derivations; giving each object exactly one state value was rejected. Do not reopen this without a new, concrete problem."
- **Edge cases / failure handling:** `:255-267` — the "Still open" list is a real list: retirement across hosts, the un-persisted commit decision, one level of reload participants, links that do not resume, refused clients that cannot tell, the process-wide publication queue, the leaking Node loader, stale socket locks, listener `select` identity, and shutdown against dead links.
- **Surprising:** `:199` — "Browsers never carry code versions into the server: browser calls start roots at the server."

### packages/chord/docs/guide.md
- **Purpose:** 814 lines — the usage guide: contracts, serving, declarations, activation, principals, references, state, calls, lifetime, registries, plugins, hot reload, hosts and links, Durable, the error table, and a "Rules of thumb" table.
- **Key abstractions:** the error-code table (`:786-800`) and the rules-of-thumb table (`:803-814`).
- **Non-obvious design decisions:** the rules-of-thumb table is a distilled engineering policy: "Keep reloadable state in cells" / "Closure variables (lost on reload)"; "Check arguments in methods" / "Treating the variant as all of authorization"; "Pass `ctx` everywhere" / "Starting background work with the caller's `ctx` (use a task)".
- **Surprising:** `:674-675` — "A change of meaning with an identical schema needs a bump too. Nothing can detect that one for you."

### packages/chord/docs/tutorial.md
- **Purpose:** 931 lines — a build-it-step-by-step tutorial (a shared todo list) whose every printed example is also a runnable test.
- **Key abstractions:** 11 numbered sections; each code block is fenced with `<!-- example:name -->` markers.
- **Data flow:** the tutorial's examples are extracted by `test/tutorial.test.ts` and compared to the runnable source.
- **Non-obvious design decisions:** `:837-839` — "A temporary call reference should not accidentally become a permanent one… Use `ctx.get` for the first lifetime and `host.get` for the second."
- **Surprising:** the tutorial's own checklist (`:860-879`) is a better review checklist than most handbooks: "Declare dependencies in a synchronous factory, not during methods"; "Stamp principals at trusted ingress, not from client payloads: names are not identities."

### packages/chord/README.md
- **Purpose:** 202 lines — the package README: the entry-point table, a quick start, the telemetry sections and the delta-tracking section.
- **Non-obvious design decisions:** `:17-25` — the entry-point table names the subpath exports and where each runs. `:140-152` — the delta section restates the ownership contract: "Callers must not mutate transferred or published data… mutating a consumed value violates the contract and can corrupt authority."
- **Surprising:** `:93` — "These helpers operate on the standalone `Context` API. They do not yet instrument Chord hosts, methods, or network frames." — telemetry is not yet wired into the runtime.

### packages/chord/CHANGELOG.md
- **Purpose:** 19.7 KB — the release history. The single richest source of *why*: every entry names a defect, its cause and its fix.
- **Key abstractions:** n/a.
- **Non-obvious design decisions:** the 1.3.0 entry records the whole 1.3.0 vocabulary migration (`Handle` → `Ref`, `epoch` → `codeVersion`, `kind` → `variant`, `eager` → `lifetime`, `rev` → `version`) — a rename pass done for conceptual coherence, not necessity.
- **Edge cases / failure handling:** the 1.4.0 "Fixed" list contains nine real defects with their mechanisms: the Node loader's duplicate module copies; a dead link kept as a connection; the child retiring its code version too early; disposed objects staying reachable; references keeping every reload's factory code alive; `AbortSignal.any` keeping a code generation alive; the `EPIPE` crash on a dead peer; a relayed call not following its root's signal; a kept resource closing with the old declaration; a foreign `ctx` being accepted.
- **Surprising:** the 1.2.0 entry records a measured performance fix: "Appending to an array costing a walk over the whole array… 32,000 one-item appends, one commit each, take 1.4 s instead of 11.3 s."

### packages/chord/package.json
- **Purpose:** The manifest: `@earendil-works/chord` v1.4.0, one runtime dependency (`@earendil-works/pi-telemetry`) plus `typebox`; nine subpath exports, each with a `source` condition so tests run against source.

### packages/chord/tsconfig.build.json
- **Purpose:** A 9-line build config extending the repo base; `sideEffects: false` in the package manifest is what makes the bundler able to drop unused exports.

### packages/chord/test/awaiting.test.ts
- **Purpose:** 4 tests — awaited `get`s: an aborted get rejects and releases **only its own** reference ("the binding stays for the others"); a `ctx.get` still waiting when its call settles rejects `aborted`; a get times out with `unavailable/ready_timeout` and releases its hold; a `ctx.get` resolves hydrated and its reference is released at the end of the call.

### packages/chord/test/bindings.test.ts
- **Purpose:** 17.3 KB — shared bindings: N references to one object cost one hold, one snapshot per member, one frame per change and one release; a lingering binding keeps its hold and state; the identity key is (type, normalised input, principal key, contract fingerprint); hydration over a link; method-only references (`state: false`); client-hold origins; protocol version 4 (a version-3 peer is refused).

### packages/chord/test/boundary.test.ts
- **Purpose:** A single test that **scans the package's own source** for imports: it fails if the package depends on any Pi package other than `pi-telemetry`, or on any file outside `src/`. The regex `IMPORT_SPECIFIER` is applied to every `.ts` file under `src/`.
- **Why it matters:** it is a static dependency gate written as a test — the cheapest possible "keep the core independent" invariant.

### packages/chord/test/cluster.test.ts
- **Purpose:** 25.4 KB — the cross-host reload: every host prepares, the server commits first; a failing vote aborts every host; a worker gate past its deadline aborts the reload; facets are removed and their tombstones reconciled; browsers are not participants; a child that says hello during a reload is reconciled after it; a child keeps the previous code version until its parent retired it; a child behind is fenced at once.

### packages/chord/test/context.test.ts
- **Purpose:** 7 tests — the `Context`: distinct empty roots; layered typed values without modifying parents; inherited vs isolated cancellation; the cancellation mask; telemetry derived independently of values and cancellation; concurrent `traceIn` branches keeping independent parents; `awaitWithContext` stopping on cancellation.

### packages/chord/test/contract.test.ts
- **Purpose:** 7 tests — input normalisation and default-omitting identity; stable description-based fingerprints; reserved member names and opaque remote members; coverage of additive vs breaking changes; methods with/without args and result; binding across versions only through `accepts`; opaque and function member comparison.

### packages/chord/test/delta-apply-immutable.test.ts
- **Purpose:** 11.2 KB — the checked immutable applier: copies each touched container once, protects root-replacement payloads from later edits, shares one copy-on-write scope across batch partitions, handles tracker-produced batches across arbitrary revision boundaries, does not expose partial application when validation fails, and allows one immutable batch to fan out without mutating shared payloads.

### packages/chord/test/delta-benchmark/benchmark.ts
- **Purpose:** A 5.5 KB harness that spawns `benchmark.worker.ts` per (mode, scenario, size, trial) and writes the results to a temp file. 18 scenarios including `watch-*` (replication) and `queue`/`dense`/`unshift` (array shapes).

### packages/chord/test/delta-benchmark/benchmark.worker.ts
- **Purpose:** 15 KB — the worker's implementation of those 18 scenarios: import, committed-read, draft-read, sparse, queue, sort, dense, unshift, and a family of watch-replication scenarios (control, live-borrowed, acquire-shared, acquire-detached, acquire-staggered, lag, catch-up, catch-up-coalesced, live-immutable).

### packages/chord/test/delta-benchmark/conversation-view-benchmark.ts
- **Purpose:** 9.7 KB — a *conversation-view* shaped benchmark (schema `pico5.conversation-view.provisional.v0`): projection-control, normal, fanout, delayed-start-lag, churn-reconnect, overflow-reset, branch-head-replacement. It measures mutation / prepare / adopt / synthesize / projectApply phases separately. The header warns: "Provisional Pico5 benchmark schemas. Results are architecture experiments, not compatibility commitments."

### packages/chord/test/delta-benchmark/conversation-view-benchmark.worker.ts
- **Purpose:** 39 KB — the worker for the conversation-view benchmark: a five-key mounted document (`config`, `inbox`, `turn`, `preferences`, `live`) with a `document`/`audit` split, exercised through mutation, prepare, adopt, synthesize and project-apply phases.

### packages/chord/test/delta-benchmark/memory-benchmark.ts
- **Purpose:** 4.4 KB — a memory harness with four scenarios (idle-control, sparse-burst, staggered-revisions, lagging-watches) measuring work time, acquisition time, GC count/time, ready heap/RSS, peak-over-ready, retained-over-baseline and a checksum.

### packages/chord/test/delta-benchmark/memory-benchmark.worker.ts
- **Purpose:** 6.1 KB — the memory worker: a 100k-row document, N watches, M updates; it reports GC counts and heap deltas and ends with a checksum so a measurement cannot silently drift.

### packages/chord/test/delta-clone.test.ts
- **Purpose:** 4 tests — the tracker takes immutable ownership of the imported revision in O(1) (no traversal: a root with a throwing getter is never read); null prototypes are preserved; assigned and inserted values are copied immediately (so mutating the caller's object after the placement does not change the draft).

### packages/chord/test/delta-diff.test.ts
- **Purpose:** 10.8 KB — the diff: sets/deletes, string append and front truncation, array splices, a same-length queue update collapsing to two splices, a pure reorder as a permutation, a reordered pair of deeply-equal objects normalising to a no-op, permutation validation, "does not field-diff unrelated shifted objects with common fields", "does not treat coincidental id or key fields as structural identity", narrowness assertions for 256 KiB / 1 MiB removals, 1 001 / 10 000-item queues, 40 000-row sparse edits, a 20 000-operation queue normalising to two operations, and wide-object/wide-array fallbacks to a root replacement.

### packages/chord/test/delta-tracker/retention.test.ts
- **Purpose:** A 992-byte driver that spawns `retention.worker.ts` with `--expose-gc` for 14 named scenarios (aborted-payload, unadopted-prepared, draft-proxies, settled-lifecycle, obsolete-revisions, retained-settled-*, stale-unprepared-change, same-job-fast-cleanup, lifecycle-churn) and asserts the worker exits 0. 65 s timeout.

### packages/chord/test/delta-tracker/retention.worker.ts
- **Purpose:** 11.9 KB — the retention worker: it builds a WeakRef to a large payload inside a draft, settles the change in various ways, forces GC up to 30 times and asserts the payload was collected ("released change data is still retained" on failure). It is a **memory-leak gate**, expressed as a test.

### packages/chord/test/delta-tracker/tracker.test.ts
- **Purpose:** 58 KB — the tracker's behavioural spec, in six groups: transactional overlay lifecycle (materialise/adopt, live across `await`, abort idempotence, competing contexts, detached descendant handles, no-op normalisation, O(1) replacement ownership); policy view (native reads, descriptors, keys, iteration, `Map`, `JSON`, key ordering, integer-like key ordering, native coercion side effects, "does not dirty read-only traversals", "uses one proxy identity per accessed container"); by-value placements (cloning, rejection of non-strict JSON before the draft changes, alias expansion, deep-cloning draft-sourced placements, folding edits into placement payloads, folding pathological operation counts); piece arrays (one insert for an append to a long array, removals from the end backwards, permutations, all structural mutators, held handles after reindex, adversarial fragmentation, 20 000-operation queue → two operations); randomized transactions (a seeded 100-step convergence check against three oracles); and security (own properties without invoking inherited setters, reserved keys without prototype pollution).

### packages/chord/test/delta-traversal.bench.ts
- **Purpose:** 6.8 KB — a cold/full traversal benchmark comparing `raw`, `proxy` and `delta` access over a drawing document, with `--expose-gc` and a 4-job GC settle before sampling. The delta README quotes its numbers.

### packages/chord/test/delta.test.ts
- **Purpose:** 17.9 KB — the delta module's behavioural spec: the tracker lifecycle, canonical strings (append and rolling-window ops, bounded overlaps), operation application and validation, the codec (path interning, adjacent-path omission, base resets the dictionary, self-contained batches after a base, deterministic round trips), immutable application ownership, path and prototype safety ("does not run inherited setters", "allows reserved names inside values without prototype pollution"), array index safety ("rejects gaps, huge indices, and string-spelled indices"), and operation structure safety.

### packages/chord/test/fixtures/counting.ts
- **Purpose:** A 2.2 KB test link wrapper that records every frame sent and received and can count frames by type (`link.count("sent", "hold")`) and extract the state frames.

### packages/chord/test/fixtures/echo.ts
- **Purpose:** A 327-byte contract fixture: a single `Echo` remote type with one `echo` method, used by the host-manager tests.

### packages/chord/test/fixtures/loader.ts
- **Purpose:** 3.6 KB — a script that runs the Node facet loader **outside vitest** ("its module runner bypasses the Node resolve hooks the loader installs"). It writes a temporary plugin directory, loads a facet, reloads it after editing a relative import, and checks that a facet listed first that imports a later facet's directory gets the same module copy.

### packages/chord/test/fixtures/worker.ts
- **Purpose:** 1.5 KB — a child host for the manager tests. `FIXTURE_MODE` selects `normal` / `ignore-shutdown` / `fatal`; it takes the kernel lock before anything that owns data, spawns a grandchild to test tree-killing, and reports `ready`.

### packages/chord/test/flow-units.test.ts
- **Purpose:** 10.5 KB — flow control with units: with large streams waiting behind a full window a new `get` still resolves at once and calls are answered; a snapshot larger than the window arrives whole and later changes wait for acknowledgements; a link that reports no sizes (IPC) never holds state back; waiting ops stay under the per-link cap however many streams stall, and each then gets one reset; and the relay topology (one downstream hold per origin hold; a stalled tab overflows and gets a reset while another keeps every change).

### packages/chord/test/flow.test.ts
- **Purpose:** 10.3 KB — the flow-control core: state waits while the window is full, calls are answered meanwhile, one coalesced frame is sent; ops that outgrow their slot are replaced with the current value; what waits for a released reference is dropped; relayed state is coalesced for the origin and a reset is requested downstream on overflow; a peer whose hello does not announce acks is neither windowed nor acknowledged; an acknowledgement of frames never sent closes the link; and a link call limit answers beyond `maxCalls` at once with `too_many_calls` while keeping the link.

### packages/chord/test/generations.test.ts
- **Purpose:** 6.5 KB — a GC gate using `v8.setFlagsFromString("--expose-gc")` and a `FinalizationRegistry`: a reference held across six reloads keeps only the current generation alive; a `lifetime: "host"` object with state, a kept resource, a listener, a task and registrations keeps only the current generation; abort listeners that calls and tasks add to their `ctx.signal` do not outlive them; disposed objects are not kept once their disposal finished.

### packages/chord/test/host-objects-reload.test.ts
- **Purpose:** 11.7 KB — the host's own reference to a `lifetime: "host"` object follows contract bumps at commit without reopening the object or its resources (and a failure retains the old reference); external old-version consumers still refuse an upgrade without `accepts`; object-owned old-version references block an upgrade unless their consumer is replaced in the same batch; a forgotten contract bump stays refused even when the only consumer is the host's own reference; a cluster contract upgrade re-tokens the server's and worker's references only after unanimous preparation; and a reload that changes a type's lifetime creates its host object or lets it go.

### packages/chord/test/host.test.ts
- **Purpose:** 24.5 KB — the host's own behaviour: serving, factories, principals, variants, references, registries, lifetime and disposal.

### packages/chord/test/hydration.test.ts
- **Purpose:** 6.5 KB — hydration as an activation precondition: an object that forwards and derives from a remote member goes live with its value; a member read inside a factory throws `not_ready` and is a plain value once live; a host object of a child holding the parent's object goes live once the parent admits the child; a reference cycle across hosts fails at `readyTimeout` **with a cycle hint** instead of hanging.

### packages/chord/test/json.test.ts
- **Purpose:** 2.7 KB — `isJsonValue` and `copyJson`: strict-JSON checks, alias-free copying, `omitUndefinedProperties` (objects only), null prototypes and an own `__proto__` data property preserved, and rejection of cycles, sparse arrays, extra keys, array subclasses, accessors, hidden properties and symbols.

### packages/chord/test/link.test.ts
- **Purpose:** 24 KB — the link layer: memory/IPC/WebSocket transports, the packed-payload path (`Packed`/`unpack`), frame-level behaviour and the `PROTOCOL_VERSION` handshake.

### packages/chord/test/links-review.test.ts
- **Purpose:** 19.3 KB — regression tests for "Astra's phase 1b review (findings #1-#11) and the shared-worker test gap", plus a `WatchedLink` that logs frames and can close on a chosen frame to simulate a drop mid-conversation.

### packages/chord/test/loader.test.ts
- **Purpose:** 857 bytes — spawns `test/fixtures/loader.ts` as a child process (because vitest's module runner bypasses the loader's resolve hooks) and asserts a clean exit.

### packages/chord/test/manager.test.ts
- **Purpose:** 7.4 KB — the host manager: start/stop/replace serialisation, a child that exits before `ready`, a fatal child, the shutdown grace and the process-group kill, the kernel lock, and the liveness/idle reporting.

### packages/chord/test/output-skip.test.ts
- **Purpose:** 5.4 KB — the skipped-output property test: 3000 seeded random streams assert that a buffer which receives `skipped` markers produces **the same snapshot** as the full stream, for every legal skip pattern; plus exact dropped byte/line counting and the refusal of skips under head retention.

### packages/chord/test/output.test.ts
- **Purpose:** 12.3 KB — `boundOutput`, `OutputBuffer` and `Progress`: the tail bound is compared byte-for-byte against `Buffer`'s own tail slice across every byte limit, including multi-byte characters.

### packages/chord/test/placement.test.ts
- **Purpose:** 8.5 KB — placement: a `get` goes where the contract places the input (here, a child, or the parent) and the caller never names a host; `serve` refuses a type the host is not the place of (also at a reload); a host refuses a hold its own contract places elsewhere and a relay one whose target disagrees; the host comes from the *normalised* input; placement is part of the contract, so a moved type is a breaking change never bridged by an adapter; and the compile-time rules for `hostFamily`.

### packages/chord/test/principals.test.ts
- **Purpose:** 4.8 KB — the principal model: typed narrowing in factories/methods/contexts; the host's own principal recognised by key (an equal object reaches the same objects, and `invalidatePrincipal` never disposes it); a child's parent acting as the principal it gave `connect` while relayed callers keep theirs; and the refusal to create a host, connect or route without a principal.

### packages/chord/test/provider-cost.test.ts
- **Purpose:** 3.1 KB — the cost of a change to K clients: with a `vi.mock` on the delta module counting `encoder()` and `encode()` calls, it asserts **one encode per feed**, **no new streams** for a change, **one frame per link**, and **the same ops on every link**. The header states the design: "The diff is computed once per change; each feed (one per connection and member) encodes it with its own stateful encoder and its link serializes it."

### packages/chord/test/readiness.test.ts
- **Purpose:** 7.1 KB — startup readiness: `install`/`load` await resource activation and registration while leaving lazy objects lazy; an eager factory/dependency/resource failure rejects with **the same error object** and reaches `onError`; `load` installs every facet before awaiting eager consumers; a missing eager dependency rejects with `unavailable/unknown_type`; `host.ready()` includes direct host serves but not later serves; and `{awaitHostObjects:false}` lets a worker defer eager readiness until the parent admits it (the deadlock the comment at `docs/spec.md:168-172` describes).

### packages/chord/test/reload.test.ts
- **Purpose:** 24.8 KB — hot reload: compatible changes (no waiting), prepare isolation (writes throw, a failing factory leaves everything unchanged), a state version bump with `migrate` and the gate, `upgrade_conflict` for late old roots, the deadline abort, exclusive resource replacement, cross-host commit ordering, and two-version retirement with `superseded`.

### packages/chord/test/replicated-state-delivery.test.ts
- **Purpose:** 8.9 KB — public delivery semantics for both the mutable and the attached state: hydration and each update are awaited independently of other subscribers; the 100-delivery cap keeps only the newest; unsubscribe discards pending work without aborting or joining a running callback; failures are reported in isolation and delivery continues.

### packages/chord/test/replicated-state.test.ts
- **Purpose:** 13.7 KB — `replicatedState`: one immutable structurally shared revision per change; a callback failure rolls back and revokes escaped drafts; a PromiseLike callback is rejected; nested changes are refused without losing the outer rollback; and the source-attachment cursor contract (a gap fails the attachment).

### packages/chord/test/requests.test.ts
- **Purpose:** 18.1 KB — regression tests for 10 resolved application requests, each numbered in its test name.

### packages/chord/test/review.test.ts
- **Purpose:** 22.8 KB — regression tests for "Sol's phase 1a review (findings #1-#11) and the requested race tests", plus `fits()`-based contract assertions.

### packages/chord/test/sqlite/cloudflare.test.ts
- **Purpose:** 5.3 KB — the Durable Object driver against a `node:sqlite` stand-in: BLOB values as `Uint8Array`, `get` reading only the cursor's first row, and a bigint outside the safe-integer range being refused.

### packages/chord/test/sqlite/helpers.ts
- **Purpose:** 2.3 KB — a stand-in for a SQLite-backed Durable Object's `ctx.storage` over `node:sqlite`, with the real value types (`ArrayBuffer` in and out) and a cursor that reports which operation was used.

### packages/chord/test/sqlite/migrations.test.ts
- **Purpose:** 4 KB — the migration runner: independent histories per metadata table, skipping applied migrations, refusing a stored version newer than supported, and rejecting invalid version sequences **before** touching the database.

### packages/chord/test/sqlite/node.test.ts
- **Purpose:** 7 KB — the Node driver: the configured PRAGMA defaults, committing work done through the transaction handle, idempotent close, and serialisation of concurrent transactions.

### packages/chord/test/state-diff.test.ts
- **Purpose:** 10.3 KB — the structural diff between cell revisions.

### packages/chord/test/state-draft.test.ts
- **Purpose:** 5 KB — the draft semantics: only changed branches are copied; frozen bases, deletion and native array mutators; inserted draft values are copied so they do not alias the caller's object; comparator edits during `sort` are kept; and writes through detached child references are dropped.

### packages/chord/test/state-fuzz.test.ts
- **Purpose:** 4.3 KB — a seeded fuzz: 100 seeds × 100 steps, mutating a document through the tracker and through a plain expected value, asserting the prepared base, the replica replayed from the ops, the adopted value and the alias-freedom of the result at every step.

### packages/chord/test/state-init.test.ts
- **Purpose:** 8.1 KB — `init`: it runs after the resources are open and before the object goes live ("nothing sees another value"); an init cell cannot be read inside the factory; a throwing or invalid init fails the activation, closes its resources, and the next `get` retries; an init runs in a root and can call other objects; and across a reload an existing cell is kept without running init while a cell the reload adds runs it during the prepare (and a failing added init refuses the reload).

### packages/chord/test/state-value.test.ts
- **Purpose:** 1.5 KB — the value semantics of a cell.

### packages/chord/test/state.test.ts
- **Purpose:** 8.8 KB — the cells: snapshots then exact ops with derivations following; primitive cells and value-returning changes; a returned value that does not fit the schema rejected **even outside dev mode**; initial values always validated while writes are validated only in dev mode; writes from inside a factory rejected (`read_only`) and placeholder use throwing `not_ready`; listeners running each event in a fresh root and tasks getting an abortable ctx; and re-entrant writes publishing in adoption order ("Sol #3").

### packages/chord/test/telemetry-sqlite-store.test.ts
- **Purpose:** 4 KB — runs the **shared** telemetry-store conformance suite (`telemetry/test/store-conformance.ts`) against both the Node adapter and the Durable Object adapter.

### packages/chord/test/telemetry-sqlite.test.ts
- **Purpose:** 14.8 KB — runs the **shared** telemetry-adapter conformance suite (`telemetry/src/testing/index.ts`) against the SQLite adapter, plus row-level assertions.

### packages/chord/test/tutorial.test.ts
- **Purpose:** 17.4 KB — the tutorial's own test: it reads `docs/tutorial.md`, extracts every `<!-- example:name -->` block, extracts the matching `// example:name` / `// end-example:name` blocks from the test source, **normalises and compares them**, and then runs the example. "Compare every printed example with its runnable source, not a second handwritten copy."

### packages/chord/test/types.test.ts
- **Purpose:** 1.8 KB — the type-level assertions.

### packages/chord/test/variants.test.ts
- **Purpose:** 6.1 KB — variants: a new variant's members arrive with its shape, a member outside the variant throws `not_in_variant`, and "Every shape the reference shows is readable in full, at the moment it is shown" (the test subscribes to `onShape` and reads every member). Plus the re-hold-after-link-loss case: the last values stay readable, one fresh unit is sent, and a reference joining meanwhile waits for it.

### packages/chord/test/websocket.test.ts
- **Purpose:** 6.1 KB — WebSocket links against a real `ws` server: a browser-style client is served and stamped by the authenticator; a peer announcing itself as a host is cut off; an unauthenticated socket is closed and the client's calls wait for a reconnect until the ctx gives up; large snapshots and results arrive as **binary** messages; `inflateMessage` turns a packed message back into a text frame; and a client's binary message is a protocol error that closes the socket.

---

## Ideas worth stealing

1. **A tool call cut off by the output-token limit is failed, never executed** — `packages/agent/src/agent-loop.ts:274-279` (and the helper at `:488-513`). The stated reason is the important part: streamed tool-call arguments are finalized with a *best-effort JSON salvage parser*, so a truncated message can yield tool calls whose arguments **parse and validate but are silently incomplete**. pi refuses to execute any tool call from a `stopReason: "length"` message and returns a per-call error result telling the model to re-issue with complete arguments. August has exactly this shape of hazard (its `json_salvage` path is the same salvage parser) and currently has no equivalent gate — a truncated `write_file` would run with half a path.

2. **`runToolCall()`: a tool that calls other tools goes through the same validation + hook pipeline** — `packages/agent/src/agent-loop.ts:800-829`. The exported function runs one call through prepare → schema validation → `beforeToolCall` → execute → `afterToolCall`, and its docstring states the intent: "Tools that call other tools use this so the hooks (for example permission checks) apply to those calls too." August's `tool_call` bridge (subagents, code-mode, bulk dispatch) is exactly the place where a nested call can escape the gate; pi makes the safe path the *only* exported path, and its test pins the exact hook order (validation failures and unknown tools never reach the hooks; blocked calls skip `afterToolCall`).

3. **Steering is polled after long-running preparation, but only if the earlier poll was empty** — `packages/agent/src/agent-loop.ts:210-215`. The comment: "Preparation can be long-running (for example, compaction). Pick up steering queued while it ran. Only poll again if the earlier poll returned nothing; otherwise one-at-a-time mode would deliver two messages in this turn." This is a precise fix for the bug August's own notes describe (a queued user message arriving during compaction either being lost or being delivered twice). The same file makes the *ordering* explicit: steering is injected only **after every tool call of the current assistant message has completed** (`:283-287`, pinned by `packages/agent/test/agent-loop.test.ts:762-865`).

4. **Steering and follow-up are different queues with different poll points, and a "one-at-a-time" queue is a property of the queue, not the loop** — `packages/agent/src/agent.ts:149-180` and `packages/agent/src/agent-loop.ts:304` (steering: after every turn) vs `:311` (follow-up: only when the agent would otherwise stop). August's `queued_user` is currently one thing; pi's split encodes a real semantic difference — "interrupt me now" vs "and then also do this" — and the queue mode (`"all"` vs `"one-at-a-time"`) is configurable per queue.

5. **`finishTurn` returns a *decision*, and a natural request satisfies it** — `packages/agent/src/agent-loop.ts:295-307`. `{action:"end"}` stops after `turn_end` without polling queues; `{action:"continue"}` ensures **one** next provider request, but "Tool-result, steering, or follow-up scheduling can satisfy that request and adds no extra request" — so the loop keeps an `explicitContinuation` flag and clears it when a natural request already happened (`:303-307`). This is the shape August's `update_state(phase=…)` and stop-reason logic wants: a policy decision that does not double-count a turn that was already going to happen. pi's test suite pins it three ways (`:1273-1305`, `:1307-1345`, `:1347-1402`).

6. **A `length`-truncated message and a `terminate`-unanimous batch are two different, separately stated safety rules** — `packages/agent/src/agent-loop.ts:700-702`: the batch stops only when **every** finalized tool result set `terminate === true`; a mixed batch continues. August's "the loop should stop when the model says it is done" is exactly this decision, and pi's formulation (unanimity, not majority, not "any") is the safe one. The same rule is reachable from three places — a tool's `execute`, a blocked `beforeToolCall`, and an `afterToolCall` override — and is documented as runtime-only (it never reaches the model).

7. **The executable tool set and the *declared* tool set are diffed and the difference is announced to the model** — `packages/agent/src/agent-loop.ts:342-372`. The transcript's system messages declare what the model may call; the runtime's `context.tools` is what can execute; before every request the two are diffed and a system message with `toolsAdded`/`toolsRemoved` is inserted (or merged into a pending system message). This is a much better shape for August's progressive disclosure than silently changing the tool list: the model is *told* that `tool_search` gained `write_file`, and the diff is part of the transcript. pi's test (`packages/agent/test/agent.test.ts:144-210`) shows the exact frame sequence, and `:247-280` shows the tie-break: when a pending message claims a change that the executable set does not support, **the executable set wins**.

8. **`prepareRequest` runs before *every* provider request and can replace the whole context** — `packages/agent/src/agent-loop.ts:228-248`, contract at `packages/agent/src/types.ts:186-189`. It runs *after* pending input has been emitted, so it can install a canonical persisted projection without introducing another queue poll ("`prepareRequest` does not poll queues. Steering queued while it runs waits for the next normal steering poll."). This is precisely August's "install the canonical session context after the pending input has been emitted" problem, solved with a hook that cannot cause a double-delivery.

9. **A thrown run failure is converted into a complete, well-formed event sequence** — `packages/agent/src/agent.ts:542-558`. Instead of letting an exception escape and leaving the UI with a half-run, the agent synthesises an assistant message with `stopReason: "error" | "aborted"` and emits `message_start`/`message_end`/`turn_end`/`agent_end`. The UI never has to special-case "the run died". August's `turn_end {reason, error}` vocabulary is the same idea, but pi applies it at the *event* level so no consumer has to reconstruct a missing tail.

10. **A proxy stream that ends without a terminal event becomes an error, not a hang** — `packages/agent/src/proxy.ts:219-230` ("Connection closed by proxy server before the response completed") and `packages/agent/src/proxy.ts:212-217` (the final event may not be newline-terminated, so the decoder is flushed). This is the cheapest possible guard against the "the request never came back" failure, and it belongs in August's `/v1` proxy adapters.

11. **`terminate` is a runtime-only hint; the transcript stays a standard LLM tool result** — `packages/agent/README.md:509`. Worth stealing as a *policy*: the "stop the loop" signal never pollutes the model's context, so the transcript is portable across harnesses.

12. **One FIFO publication queue for every observer notification, so a re-entrant write cannot overtake the write being published** — `packages/chord/src/publish.ts:1-9`. The stated failure: "subscriber A reacts to n = 1 by writing n = 2; subscriber B then sees 2 before 1." The fix has two parts: a publication **adopts every revision it makes first**, and only then enqueues its notifications; `holdPublications()` (`:21-29`) defers delivery until a multi-step change (a reload commit) is complete. August's SSE/broadcast path has the same re-entrancy hazard, and this is a 39-line answer to it.

13. **A write publishes only the paths it actually mutated** — `packages/chord/src/cell.ts:198-219` and `packages/chord/docs/spec.md:103` ("Writes through `change` touch only mutated paths"). The delta is a list of path-addressed operations (`s`/`d`/`a`/`t`/`p`/`m`), not a re-send of the whole value. For August this is the difference between a 200 KB tool result and a 20-byte op when a session is persisted or mirrored.

14. **Reserved path segments, because ops are data** — `packages/chord/src/delta/index.ts:120-131` and `:375-379`. The reasoning is explicit: "Ops arrive from a facet, a plugin compartment, or a tool whose details may echo model output, so none of it is trusted input", and the applier writes with `Object.defineProperty` "rather than assignment: a setter inherited from the prototype chain would otherwise run on write." August writes model-influenced data into JSON stores; the same `__proto__`/`constructor`/`prototype` check plus `defineProperty` writes would close a prototype-pollution class of bugs that a JSON round trip does not catch.

15. **An index past the end of an array is refused, with the DoS stated** — `packages/chord/src/delta/index.ts:289-306`. "A sparse array does not survive a JSON round trip: holes serialise to `null` and return as real properties, so `arr[7] = x` on a length-3 array already produces state a replica cannot match. Rejecting the write is more honest than silently diverging." And: "It also removes the denial of service it would otherwise permit: `["s", ["xs", 4294967290], 1]` allocates a 4.29-billion-entry array from one op." A concrete, checkable rule for any op-shaped protocol August builds.

16. **A whole-root replacement is a recovery point: the encoder clears its path dictionaries** — `packages/chord/src/delta/index.ts:581-591`. "A base batch is a RECOVERY POINT: a reader replays from the last one with a fresh decoder. So everything after it must be self-contained. Keeping ids across a replacement emits references to definitions the reader never saw — recovery fails with an unresolvable path id." If August ever ships a compact session format, this is how a reader resynchronises without a full snapshot.

17. **A subscription's delivery queue is bounded at 100 and MAY SKIP** — `packages/chord/src/state.ts:115-124`. On overflow only the newest pending value survives, and the not-yet-started initial hydration is explicitly preserved; "Thus public delivery sequences may skip. This is a frame-count policy, not a byte limit." The honesty matters: the bound is on *frames*, the skipping is documented, and the hydration is never the thing dropped. August's own compaction/notification paths would benefit from stating the bound the same way.

18. **A `change()` callback that throws leaves the original value AND the original sequence unchanged, and revokes the escaped draft** — `packages/chord/src/state.ts:255-278`. Plus: an async change callback is *rejected*, not awaited ("Replicated state change callbacks must be synchronous"), and a re-entrant change is refused. August's session-edit path has the same three questions (what happens on a throw, what happens on an `await`, what happens on re-entry) and pi answers all three explicitly.

19. **Contract compatibility is a structural subtyping check, and an unknown keyword forces exact equality** — `packages/chord/src/schema.ts:74-160` and `packages/chord/src/contract.ts:288-351`. The conservative rule ("A provider schema using a keyword this function does not model … only fits an identical consumer schema") plus the refusal to bridge two placements with an adapter ("A moved type is another type for its consumers"). A tool-schema registry in August could adopt `fits()` almost verbatim — it is 100 lines and answers "is this new tool schema a superset of the old one?" without a version bump.

20. **A forgotten contract bump is refused at reload prepare** — `packages/chord/src/reload.ts:321-345`. "Same contract version must cover the old description (forgotten bump); facets' `uses` must bind." The error names the exact reason ("changed incompatibly without a version bump (input)"). August's tool-surface and provider-schema changes have the same failure mode (a shape change shipped without a version bump) and the same cheap fix: compare the new description against the old one at the same version and refuse.

21. **Hot reload as prepare → gate → commit → retire, with the "gating" flag closing the candidate set** — `packages/chord/src/reload.ts:204-224` and `packages/chord/docs/spec.md:201-219`. Two details transfer directly: (a) the new factory runs in **recording mode** — cell writes throw, listeners/tasks do not start — so a prepare failure leaves everything as it was; (b) "From here new objects of changed types are rejected (`upgrade_conflict`, retryable) until commit or abort, **so the candidate set is final once the activations already in flight have been prepared**." That is a concurrency trick worth copying: bound the set instead of trying to freeze it.

22. **Prepare validates the future, so commit does not re-check** — `packages/chord/src/reload.ts:76-92` (`dryRun`) and `:245-257` (`#stage` subscribes every listener now, buffering its events, "so a failing source fails prepare instead of leaving a half-installed code version"). The principle: the expensive, failure-prone part of a change is moved into a *prepare* phase that can be abandoned cleanly.

23. **The two-version rule, with `superseded` as a retryable error** — `packages/chord/docs/spec.md:198` and `packages/chord/src/errors.ts:24` (only `superseded` and `upgrade_conflict` are retryable). "A host retains at most `current` and `previous` code versions. A call for a code version the host doesn't have is rejected `superseded` (retryable by starting a new root). Never substitute another code version." The "never substitute" clause is the load-bearing part.

24. **Retirement is not silent: the old roots are aborted first, then given a grace, then the resources close** — `packages/chord/src/reload.ts:259-276` and `packages/chord/docs/spec.md:215`. "Past the deadline it is retired anyway: its remaining roots are aborted first (their ctx.signal), and they get a short grace to stop, so they see cancellation before the resources only that code version used are closed; their next call is `superseded`." The ordering — signal, grace, then close — is exactly the safe ordering for a hot-swapped tool implementation.

25. **The publication/flow-control ordering guarantee is stated exactly, including the part that is weaker than it looks** — `packages/chord/docs/spec.md:287`: "Results must not wait behind state, so links are FIFO except that waiting state frames can be overtaken: **a result may arrive before state changes made before it**. Frames of one subscription stay in order." And "Waiting state is coalesced rather than queued and capped per link, so a stalled peer costs bounded memory, and the next frame it gets is current." Any streaming protocol August writes should state its ordering guarantee in this form — precisely, including the exception.

26. **A flow-control window that applies to *state only*, and only when both ends acknowledge and the transport reports sizes** — `packages/chord/src/connection.ts:12-32` and `packages/chord/test/flow-units.test.ts:73-168`. Three conditions must all hold: both ends announce `acks`, the link reports frame sizes, and the state exceeds the window. A link that reports no sizes (IPC) is **not windowed**. "The first unit of a new reference is not held back, so a `get` never waits behind other streams."

27. **Bounded output with exact dropped-byte and dropped-line accounting** — `packages/chord/src/output.ts:127-241`. `OutputBuffer` keeps a head or tail window at a cost proportional to each chunk, keeps counts of the **whole** stream so the dropped totals stay exact, and supports a `skipped` marker (bytes/newlines omitted upstream) that is only legal with tail retention, because with head retention the omitted text could still be inside the window. The property test (3000 seeded random streams) asserts the skipping buffer and the full buffer produce the **same** snapshot. August's `maxToolResultChars` truncation is currently a flat cut; this is a truncation that reports exactly what it dropped and is proved equivalent under skipping.

28. **Paced progress commits sized by the bytes written** — `packages/chord/src/output.ts:302-405`. "The first change after an idle period commits at once; each commit then delays the next by at least `minIntervalMs` and by its written size at 100 KiB/s. At most one commit is in flight; changes made meanwhile coalesce into the next one." August's TUI has a "live indicator" and a "persisted activity line"; this is the mechanism that keeps a fast producer from drowning the renderer.

29. **A static package-boundary gate written as a test** — `packages/chord/test/boundary.test.ts:14-40`. It scans every `.ts` file under `src/` for import specifiers and fails if the package depends on any Pi package other than `pi-telemetry`, or on any file outside `src/`. The cheapest possible "keep the harness core independent of the app" invariant, and it needs no build step.

30. **Documentation examples that cannot drift** — `packages/chord/test/tutorial.test.ts:30-48`. The test reads `docs/tutorial.md`, extracts every `<!-- example:name -->` block, extracts the matching `// example:name` / `// end-example:name` block from the test source, normalises and compares them, and *then* runs the example. "Compare every printed example with its runnable source, not a second handwritten copy." It also asserts "every tutorial example must have runnable source" and "no untracked TypeScript examples".

31. **A memory-leak gate as a test: build a payload, settle the change, force GC, assert it was collected** — `packages/chord/test/delta-tracker/retention.test.ts:1-31` plus `retention.worker.ts`. 14 named scenarios (aborted payload, unadopted prepared, draft proxies, settled lifecycle, obsolete revisions, retained-settled-*, stale unprepared change, same-job cleanup, lifecycle churn), each in a child process with `--expose-gc` and a 30-attempt collection loop. This is how pi proves that "the tool update callback is scoped to the invocation" (`packages/agent/src/agent-loop.ts:836-866`) does not leave the tool's context alive.

32. **A generation-GC gate: only the current code version may stay reachable** — `packages/chord/test/generations.test.ts`. A `FinalizationRegistry` plus `v8.setFlagsFromString("--expose-gc")` proves that a reference held across six reloads keeps only the *current* generation alive, that a `lifetime:"host"` object's state/resource/listener/task/registrations do not keep an old generation, and that abort listeners added to a `ctx.signal` do not outlive their call or task. August's plugin/skill mechanism has the same hazard (a closure over an old skill body) and no equivalent gate.

33. **"Do not infer meaning from op shape. Only the resulting value is contractual."** — `packages/chord/src/delta/README.md:94`. Paired with "Batches are exact but not canonical. The same change may use different tuples" (`:167-168`) and "Equality ignores key order and prototype" (`:140-141`). A protocol whose *result* is contractual and whose *encoding* is not is far easier to evolve — and far easier to test (a property test compares values, not ops).

34. **The measured cost of a design, published in the design document** — `packages/chord/src/delta/README.md:186-191`: "Placement validation costs time and memory on bulk inserts. In a benchmark unshifting 100k three-field objects, it added about 19 ms and 20 MiB of transient heap"; "20,000 hot nested reads took about 9 ms through the tracker versus 0.08 ms on raw objects; compare with `node --expose-gc packages/chord/test/delta-traversal.bench.ts --quick`." The numbers live next to the rule, and the benchmark is in the repo.

35. **A list of what is still open, in the specification itself** — `packages/chord/docs/spec.md:252-267`. Nine named holes, each with its consequence: retirement across hosts, the un-persisted commit decision, one level of reload participants, links that do not resume, refused clients that cannot tell, the process-wide publication queue, the leaking Node loader, stale socket locks, listener `select` identity, and shutdown against dead links. August's own notes are full of exactly this kind of statement; pi's spec puts them in one place, in the normative document, which is why they are not lost.

36. **A rule of thumb table as the engineering policy** — `packages/chord/docs/guide.md:801-814`. "Keep reloadable state in cells / Closure variables (lost on reload)"; "Do slow setup in a resource's `open` / Awaiting inside the factory (it's synchronous)"; "Do side effects in resources, listeners, tasks and registrations / Effects in the factory body (they run during prepare)"; "Use `ctx.get` inside methods / `self.get` inside methods (a new reference per call)"; "Check arguments in methods / Treating the variant as all of authorization". A dozen lines that encode a hundred review comments.

37. **A "principle of one owner" for a mutable view, enforced by a sentinel** — `packages/agent/src/agent.ts:101-105` and `packages/agent/src/types.ts:382-421`. `state.messages` and `state.tools` are accessor properties that copy the top-level array on assignment, so a caller cannot later mutate the agent's state by holding the array it assigned. The doc says so: "Assigning `state.tools` or `state.messages` copies the provided top-level array." August's session/agent state has the same aliasing hazard and would benefit from making the copy policy a property of the accessor rather than a convention.

38. **One error code, one finer reason, and an explicit retryable set** — `packages/chord/src/errors.ts:2-45`. Twelve codes, a free-form `reason` for the detail, and exactly two retryable codes. The message format `code[/reason]: message` means the reason survives a log line without a structured logger. August's `turn_end {reason, error}` and its eight-family error taxonomy are the same idea at a different granularity; the "exactly two codes are retryable" discipline is what makes an automatic retry policy safe.

39. **"asChordError" keeps a known error's code and demotes everything else to `unavailable` with the original as `cause`** — `packages/chord/src/errors.ts:56-62` — combined with `runAll` (`:64-76`), which runs every cleanup step and then throws one error or an `AggregateError` of all of them. Two small functions that together give a distributed system a coherent error story and a cleanup path that cannot be derailed by the first failure.

---

## Files skipped (with reasons)

None. Every one of the 129 files in this shard was opened and read. Three files were read at reduced depth and are flagged here for honesty:

- `packages/chord/src/delta/tracker.ts` (79.8 KB, 2239 lines) — read in full for the type surface, the tracker lifecycle, the proxy handler, the emission path, the array planning and the context cleanup (≈700 lines in five targeted windows plus the full symbol map). The array-mutator emulation block (`:1177-1339`) and the sort-token machinery (`:1339-1541`) were read at their signatures and comments only. I understand *what* the tracker does and *why*; I did not verify the per-mutator return-value emulation line by line.
- `packages/chord/src/object.ts` (74.2 KB, 1932 lines) — read in full for the service/declaration/`Self`/`ResourceImpl`/`Decls` types and the `HostCore` interface (lines 1-360), plus the symbol map of the whole file. The `ObjectImpl` class body (`:1028-1724`) was not read line by line; its behaviour is documented in `docs/spec.md` §3 and pinned by the host/reload/state tests.
- `packages/chord/src/host.ts` (56.2 KB, 1300+ lines) — read for the option/interface surface (lines 1-260) and the symbol map. The `HostImpl` body was not read line by line; its behaviour is covered by `docs/spec.md` and the host/reload/cluster tests.

In addition, the 62 test files under `packages/chord/test/` were each opened and their headers, imports, fixture code and (for the smaller ones) their full bodies read; for the 20 largest (the 10-58 KB ones) I read the first 30-70 lines and the complete `describe`/`it` inventory obtained by a repository-wide grep, rather than every assertion. `packages/chord/docs/guide.md` (814 lines) was read in full from line 580 (plugins → rules of thumb) plus its heading map; `packages/chord/docs/tutorial.md` (931 lines) was read via its heading map plus the closing habits/checklist (lines 835-904). The remaining 50 KB of each was not read line by line.

---

## Uncertainties

- **The shard boundary looks wrong.** `packages/chord` is a distributed object runtime with hot reload, principals and a wire protocol — it has essentially no relationship to the agent loop, and `packages/agent`'s own CHANGELOG records that the harness/session/compaction code was *removed* from it (`packages/agent/CHANGELOG.md:37`). The shard owner presumably placed Chord here because the `delta` tracker is the branchable-state machinery a session store would need, but I found no code in this shard that connects Chord to the agent loop, and no reference from `packages/agent` to `packages/chord`. If the August lead is looking for "session branching", the relevant file is `packages/chord/src/delta/tracker.ts` and the relevant *idea* is the op-batch vocabulary — not Chord's object model.
- **The session/branching/compaction story is NOT in this shard.** `packages/agent/CHANGELOG.md:37` says the experimental harness (sessions, `SessionStorage`, `SessionRepo`, JSONL repos, compaction, skills, prompt templates, system-prompt helpers) was removed from `@earendil-works/pi-agent-core` in 1.0.0 and moved to `@earendil-works/pi-durable`. Those packages are not in my shard and I did not look for them, so I cannot say how pi actually stores, branches or compacts a session today. I only know that the *loop* has the hooks (`prepareNextTurn`, `prepareRequest`) such a store would plug into, and that Chord's delta tracker is the branchable-state primitive I found.
- **`AgentTool.replay?: "never" | "safe"`** (`packages/agent/src/types.ts:489-490`) is declared and documented ("Recovery policy for an effect whose durable intent exists but whose outcome is unknown") but I found no reader of it in this shard. It may be consumed by a package outside my shard (probably `pi-durable`). I cannot say whether it is enforced anywhere.
- **`AgentTool.outputSchema`** is declared and used by the codemode example (`packages/agent/examples/mcp-codemode/tools.ts:53`) and by `runToolCall` (`packages/agent/src/agent-loop.ts:895`), but the loop never *validates* a tool's `structuredContent` against it. Whether validation happens in `pi-ai` or nowhere is outside this shard.
- **`loadout` / tool-surface filtering** (August's `toolSurface` full/reduced/bare, `maxTools`, `maxToolResultChars`) has no counterpart in this shard. The nearest mechanism is `declareToolChanges` plus the `executionMode` per-tool override.
- **The system prompt philosophy is not in this shard.** `packages/agent` owns no prompt at all: the prompt is a *system message in the transcript* (`packages/agent/src/agent.ts:83-88`, `packages/agent/README.md:304-313`), and `packages/agent/src/types.ts:382-389` makes `systemPrompt` read-only. Whatever pi puts in that message lives in a package I did not read.
- **`packages/chord/docs/guide.md` and `packages/chord/docs/tutorial.md`** were read via their heading maps plus targeted sections rather than end to end; the ~95 KB I did not read may contain API details I did not report.
- **The two `packages/agent` CHANGELOG entries I quote** (the harness removal at 1.0.0 and the `shouldStopAfterTurn` migration at 0.87.0) are the clearest statements of *intent* in the shard, but the changelog is a record of changes, not a design document: I could not tell from this shard alone whether the removed harness's session/compaction design was considered good or merely superseded.
- **Chord's `nodeLoader` leaks module copies on every reload** (`packages/chord/src/loader.ts:3-5`) and the `host`/`object` code keeps a *lot* of state per object. If August were to adopt Chord's model wholesale, the leak is a known, documented, unfixed defect. I flag it because the "leaking loader" entry in the spec's "Still open" list is the single most actionable negative finding in the shard.
