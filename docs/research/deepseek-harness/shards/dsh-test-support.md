# deepseek-harness / dsh-test-support

## Shard shape

This shard is the whole `packages/test-support/` group (213 files across 7 packages plus the group map) — the repository's *keyless* test infrastructure. It does not contain product code; it contains the harnesses that let the rest of the repo exercise the real agent loop, the real Loader composition, the real browser client and the real provider wire **without a provider key and without a hosted Host**. The seven packages form a chain:

- `llm-mock-server` — a scriptable **fault** server speaking the Anthropic-style Messages SSE wire; one accepted request consumes exactly one named behaviour (reset, disconnect, stall, truncation, malformed JSON, 429/5xx, context overflow, quota, reasoning, tool call, `max_tokens`, …), seeded and reproducible.
- `llm-replay` — the **success** counterpart: it derives one model-call script per recorded Session JSONL and serves it through the real `LlmRuntime` waterfall, so a snapshot test runs the *real* agent against a fixed transcript; an override sidecar expresses the failure modes a durable settlement cannot reconstruct (throw-before-chunk, cancel/hang).
- `session-snapshot` — the **eval tier**: an ACP-protocol adapter that launches the real CLI as a subprocess, drives a deterministic input script, harvests the persisted Session JSONL, and compares *normalised* stdout + logs + workspace state against committed fixtures, in three modes (replay / record / refresh).
- `loader-smoke` — a subprocess + direct-agent harness for booting a Loader-composed application from a real bin and `cordis.yml`, in `src` (tsx) or `lib` (plain Node) mode.
- `agent-loop-testkit` — the shared prerequisite spine for tests that drive the concrete `AgentLoop` (six services mounted in a fixed order, stopping before the loop so callers own load order), plus two Inbox doubles.
- `remote-mock` — an endpoint-named mock of the Typert Remote traffic: unary answers, stream scripts, live stream control (`push`/`end`/`fail`), a seq-ordered log and a Connection carrier face.
- `client-runtime` — two browser tiers: a jsdom *slot* bench that mounts the production `SlotRegistry`/renderer/`ui-session` adapter over test-owned Session/Workspace doubles, and a *whole-client* tier that boots the real web roster (`dsh-base` + `dsh-web-app`, read from the bundles' own patch files) through the production `bootClient` over an in-process module table, with a `RemoteMock` bound to that client's Connection.

Everything here is deliberately *support tier*: each README repeats "Model Experience: None" and "KV Cache effect: None" because none of it assembles or sends a provider request.

---

## Per-file notes

### packages/test-support/README.md
Group map listing the seven packages and their one-line roles; a package "moves out of this group when it gains a product contract and product consumers."

### packages/test-support/README.zh.md
Chinese mirror of the group map (same table, same anchors).

### packages/test-support/README.i18n.yaml
Per-heading-section en/zh digests recording the bilingual-pair consistency of the group map, plus the `pnpm run verify-translation-pairing --write` command that re-records them.

### packages/test-support/agent-loop-testkit/src/index.ts
- **Purpose:** the mounting API for agent-loop tests.
- **Key abstractions:** `AgentLoopTestHarness` (create + a narrow `claim` driver), `AgentLoopTestDependenciesOptions`.
- **Data flow:** `mountAgentLoopTestDependencies` mounts LlmRuntime → SessionStore → SessionProjectionRegistry → SystemPrompt → (optional FsLocal+WorkingDirectory) → ToolRuntime → AgentRegistry, deliberately **stopping before `AgentLoop`** so the caller controls loop load order; `mountAgentLoopTestHarness` then mounts the production `AgentLoop` and returns a driver that creates real Agents and calls the loop's own `claim(target, turn)`.
- **Non-obvious design decisions:** the loop's concrete Inbox class and projection definition are *not* exported — the driver exposes only `create` and `claim`. A plugin-load failure rejects the helper call, but services already activated remain context-owned and unwind with the context.
- **Edge cases:** `options.workingDirectory` only mounts `FsLocal` when `ctx.get('fs')` is undefined, so an existing filesystem is kept.
- **Surprising:** the harness registers **no LLM adapter** — a test that starts the loop must register the route it exercises.

### packages/test-support/agent-loop-testkit/src/inbox.ts
- **Purpose:** two Inbox doubles for consumer-only tests.
- **Key abstractions:** `createInboxStub()` (two process-local arrays, `locate()` scans both targets) and `unsupportedInbox()` (every mutation throws).
- **Data flow:** `append`/`prepend` push; `replace`/`remove` splice in place after locating the message id across both targets; `splice` delegates to the array.
- **Non-obvious design decisions:** the stub "never writes to a Session" — durability, projection validation and live notifications must use a real Agent; the unsupported variant exists so a test can assert *that* pending input is never touched, by making the first unexpected mutation throw at the call site.
- **Edge cases:** `replace`/`remove` return `false` for an unknown id rather than throwing.
- **Surprising:** `clear()` empties `next-step` **before** `next-turn`.

### packages/test-support/agent-loop-testkit/src/working-directory-fixture.ts
`provideWorkingDirectoryFixture(ctx, defaultDirectory)` provides a `workingDirectory` service whose `get`/`ensure` read `session.header.cwd ?? defaultDirectory` and resolve — no path validation, no `chdir`, no event recording.

### packages/test-support/agent-loop-testkit/tests/agent-loop-testkit.spec.ts
Spec proving: the unsupported Inbox throws with its message; the configurable spine reaches the *real* renderer (`renderPrompt(await ctx.systemPrompt.assemble())` contains the persona prefix); an existing `FsLocal` survives the working-directory mount; the mutable stub's queue semantics; and — the important part — a production Agent's durable Inbox behaviour: `agent/inbox/inserted` events, duplicate insertion rejected with `message "<id>" is already pending`, a malformed persisted splice rejected by the projection with `invalid persisted inbox splice`, and `claim(agent,'next-turn',3)` returning `[step, turn]` in claim order with the matching `agent/inbox/claimed` events.

### packages/test-support/agent-loop-testkit/README.md
English doc: when to use the dependency helper vs the structural stub, the "harness mounts no LLM adapter" warning, the four known limits (only the mandatory spine is shared; no adapter default; the stub is process-local; the unsupported Inbox accepts no mutations), and "Model Experience: None / KV Cache effect: None".

### packages/test-support/agent-loop-testkit/README.zh.md
Chinese mirror of the same doc (same four known limits).

### packages/test-support/agent-loop-testkit/README.i18n.yaml
Per-section en/zh digests for the testkit README (11 sections).

### packages/test-support/agent-loop-testkit/package.json
Manifest: ESM, zero runtime deps, ten workspace peer/dev deps (cordis, agent, agent-loop, llm, session, session-projection, system-prompt, tools, working-directory, fs-local), publishes `lib/index.js` + `lib/types`.

### packages/test-support/agent-loop-testkit/tsconfig.json
tsconfig extending `tsconfig.base.json` with `rootDir: src` / `outDir: lib/types` and ten project references (including the vendored `cosmokit` and `cordis`).

### packages/test-support/llm-mock-server/src/index.ts
- **Purpose:** the scriptable Messages HTTP/SSE fault server.
- **Key abstractions:** `MOCK_LLM_BEHAVIORS` (24 names), `MockLlmRequestOutcome` (`completed|reset|stalled|client_closed|server_error`), `MockLlmServerEvent` (a `request` and a `result` event per accepted request), `MockLlmRequestRecord`.
- **Data flow:** `startMockLlmServer` → `resolveOptions` (every option bounded and validated) → a FIFO `cursor` → per request: validate method/path/API key/JSON **first**, then `selectBehavior()` advances the cursor, then `runBehavior` writes the wire result, then the record is settled and a `result` event is emitted.
- **Non-obvious design decisions:** (a) *the server never retries or interprets harness policy* — it is a script, not a policy engine; (b) **validation happens before the cursor advances**, so a misconfigured client burns its retries without advancing the sequence (documented as "Invalid requests do not consume the script"); (c) `random` resolves at request time through a seeded mulberry32 PRNG, so a mixed-failure run is reproducible from the printed seed; (d) the telemetry observer's exceptions are swallowed — "test telemetry is observational; a broken observer cannot change provider wire behavior".
- **Edge cases:** `pause()` cancels its delay when the response closes, so a client that walks away does not pin a timer; the response `close` handler marks an unfinished request `client_closed`; `retry-after` is `Math.ceil(retryAfterMs/1000)` (rounds up to whole seconds); `context_overflow` is a **400** with code `context_length_exceeded`, not a 413; `quota_exceeded` is a 429 with `insufficient_quota`; `wrong_content_type` sends a valid SSE body under `application/json`.
- **Surprising:** `tool_call_success` splits the tool arguments **at their midpoint** into two `input_json_delta` events (`llm-mock-server/src/index.ts:457`), so a client that concatenates partial JSON is exercised; `empty` sends a valid *content-less* stop plus `[DONE]`, which is a different failure from `stream_eof`.

### packages/test-support/llm-mock-server/src/cli.ts
- **Purpose:** dependency-free CLI parsing (no process, no listener).
- **Key abstractions:** `MockLlmCliConfig` (server options + `listenDelayMs` + `startsUnavailable`), `MockLlmCliParseResult` (`help` | `run`).
- **Data flow:** `node:util` `parseArgs` (strict, no positionals) does the tokenizing; numeric coercion, bounds and cross-option constraints are manual on top.
- **Non-obvious design decisions:** `connection_refused` is a **CLI-only lifecycle phase** (the listener simply is not bound yet), which is why it is stripped from the server sequence before the options are built; the default unavailable interval is 750 ms, but `--listen-delay-ms` is only legal when `connection_refused` is first.
- **Edge cases:** `--seed`/`--random-weights` are rejected unless `random` is in the sequence; `--random-weights` requires a *concrete* behaviour, rejects duplicates, and needs at least one positive weight; `connection_refused` requires an explicit nonzero `--port`.
- **Surprising:** the CLI's own comment distinguishes tokenizer-level failures (`Unknown option '--wat'`) from bounds probes (`--listen-delay-ms=-1`), because `=` syntax and space syntax are different failure classes.

### packages/test-support/llm-mock-server/src/bin.ts
Thin process wrapper: prints a JSONL `unavailable` record and delays the bind for `connection_refused`, prints a `ready` record with the `/v1` base URL and the random seed, tees every request/result event as JSONL to stdout, and exits 130 (SIGINT) / 143 (SIGTERM) after an idempotent `close()`.

### packages/test-support/llm-mock-server/tests/server.spec.ts
Spec for the wire: the success transcript and its `request`/`result` telemetry; gateway prefixes (`/anthropic/v1/messages`) work; an observer that throws is ignored; five truncation/malformation behaviours asserted by exact `chunksSent`; the three transport-boundary behaviours (`connection_reset` destroys the socket before headers, the other two after); `stall` holds until abort and `close()` is idempotent; a client that closes mid-stream is recorded `client_closed`; UTF-8 split across request chunks is preserved; an IPv6 listener formats as `http://[::1]:port`; the structured HTTP errors carry `x-request-id` and a rounded `retry-after`; script exhaustion is a 500 and `--repeat-last` reuses the last behaviour; seeded random is reproducible across two servers; and invalid method/route/key/JSON get 405/404/401/400 **without consuming the script**.

### packages/test-support/llm-mock-server/tests/cli.spec.ts
Spec for the parser: help without a sequence, every option parsed into the right shape, standalone defaults (port 8000), the default 750 ms unavailable interval, a reproducible weighted random profile, and 23 rejected-argv cases.

### packages/test-support/llm-mock-server/README.md
English doc: the full behaviour table, the random-mode recipe, the timing/content controls, "What can go wrong" (script exhaustion; weights without a positive concrete behaviour are rejected; invalid requests do not consume the script), and the design rule that the server never retries or interprets harness policy.

### packages/test-support/llm-mock-server/README.zh.md
Chinese mirror; same behaviour table and the same "random weights model test pressure, not production incidence" limitation.

### packages/test-support/llm-mock-server/README.i18n.yaml
Per-section en/zh digests for the mock-server README (17 sections).

### packages/test-support/llm-mock-server/package.json
Manifest: zero runtime dependencies, only cordis as a peer/dev dep, publishes `lib/index.js`.

### packages/test-support/llm-mock-server/tsconfig.json
Minimal tsconfig extending `tsconfig.base.json` with no project references.

### packages/test-support/llm-mock-server/tsdown.config.ts
tsdown config building one self-contained ESM node file from `lib/types/index.js`, code splitting off.

### packages/test-support/llm-replay/src/index.ts
- **Purpose:** the keyless replay plugin — a real agent with a fixed model transcript.
- **Key abstractions:** `ReplayEntry` (`chunks` | `throw` | `hang`), `ReplayOverrideDoc` (bare array = replace; `{ patches }` = augment), `SessionScript` (recordedId, createdAt, entries, primary), `ReplayHandle` (`dispose` + `assertConsumed`), `ReplayConfig`.
- **Data flow:** `parseSessionFixture` completes a *projected* fixture (projected rows get dense seqs and zero times; complete rows keep theirs; mixing the two is refused), validates and migrates the whole artifact through the build-static `sessionFormatCatalog`, and returns the current header + inherited cut + events. `deriveReplayScript` then expands each `assistant/message` / `assistant/attempt` stream into one `chunks` entry, and a `compaction/summary` marked `llmStreamCall: true` becomes one canonical successful stream at that event's position. `installLlmReplay` binds each *live* session to the next unclaimed script by first-call order, advances that session's own cursor synchronously at invocation time, and yields the recorded chunks.
- **Non-obvious design decisions:** (a) **a non-empty stream without a `finish` chunk is the fingerprint of a thrown `stream()`** — derivation refuses it and the scenario must supply an override sidecar, because a durable settlement cannot carry the exception; (b) the override sidecar has two shapes so "turn N errors, everything else replays as recorded" is expressible without re-deriving the whole script; (c) `{{fromRequest:<regex>}}` placeholders resolve against the live request's string leaves, **last match wins**, first capture group substituted — the only way a fixture can echo back an id it could not know; (d) a `throw` entry with prefix chunks replays those chunks *then* throws, so the loop sees the same partial output it saw live; (e) `paceMs` is explicitly "a realism knob only — correctness must never depend on it".
- **Edge cases:** more distinct live sessions than recorded scripts fails loud with "re-record it"; an exhausted script fails loud with the call index; `{{session:N}}` used before that recorded session bound fails loud; an unterminated `{{fromRequest:` placeholder fails loud; a `hang` entry may name a `readyFile` that replay writes *before* waiting for cancellation, so an external driver can cancel deterministically.
- **Surprising:** `installLlmReplay` **defers** the "unrecorded session" throw into the returned generator (the waterfall listener must return an `AsyncIterable`, not throw); and when the provider is `deepseek-official` it prepares and *accepts* the DeepSeek request extensions after selecting a valid entry and before the first chunk, mirroring the live adapter's post-2xx commit point — with a synthetic `{ messages: [] }` body, because it proves the acceptance side effect, not the prepared bytes.

### packages/test-support/llm-replay/tests/llm-replay.spec.ts
2344-line spec driving the plugin through the **real** `LlmRuntime` waterfall (not a hand-rolled stub): the derive/parse/load helpers, v0→v1→v2→v3 fixture migration and the refusals for retired fields, `prepareSessionSnapshotFixtureForComparison` (arbitrary future request-header fields stay observable; a retired `header.system` is refused; no trailing newline is invented), the sidecar's `throw`/`hang`/`chunks` kinds and their validation, the "script exhausted" and "unrecorded session" errors, HMR-safe listener disposal (a fall-through adapter proves the listener is gone), the DeepSeek request-extension acceptance, and the per-session binding/cursor behaviour.

### packages/test-support/llm-replay/tests/session-format-corpus.spec.ts
Restores **every** committed versioned `session*.jsonl` under `snapshots/`, `packages/` and `scripts/snapshots/python-sdk-single-exe/` through the real catalog *without changing source bytes* (the file is re-read and compared), and pins each deliberate historical refusal by its exact reason. A separate block tests the refusal classifier itself (an unlisted refusal, a refusal that starts restoring successfully, a changed reason, corruption masquerading as a refusal, a mismatched source generation, and a current-generation fixture).

### packages/test-support/llm-replay/tests/session-format-corpus-inventory.ts
The exact inventory: a map of fixture path → `{ sourceVersion, reason }` for every historical conversion refusal, plus the set of headerless snapshot-harness protocol fixtures that are exempt from migration.

### packages/test-support/llm-replay/README.md
English doc: the config table, how the projected fixture is parsed/migrated, the nested-agent binding rule, the two failure modes that need a sidecar, "What can go wrong" (fixture not fully consumed; an unrecorded session makes a call; a placeholder matches nothing), and the two known limits (first-call-order binding assumes sequential delegation; only ordinary loop chunks and marked local compaction outputs are derivable).

### packages/test-support/llm-replay/README.zh.md
Chinese mirror; same rules and same two known limits.

### packages/test-support/llm-replay/README.i18n.yaml
Per-section en/zh digests for the llm-replay README (15 sections).

### packages/test-support/llm-replay/package.json
Manifest: depends on `dsh-session-format-catalog` and `dsh-util-values`; peers on cordis, compaction, llm, session and (optionally) `dsh-deepseek-llm-api-extensions`.

### packages/test-support/llm-replay/tsconfig.json
tsconfig with references to cosmokit, cordis, compaction, llm, deepseek-llm-api-extensions, session and session-format-catalog.

### packages/test-support/loader-smoke/src/index.ts
- **Purpose:** the shared subprocess harness and the mode-aware launch resolver.
- **Key abstractions:** `ExampleMode` (`'src' | 'lib'`), `ExampleLaunchOptions`, `ExampleLaunch`, `LoaderSmokeOptions`.
- **Data flow:** `resolveExampleMode` reads `$DSH_EXAMPLE_MODE` (absent/empty/`src` → `src`; `lib` → `lib`; anything else **throws**); `resolveExampleLaunch` builds the spawn — `src` mode runs the TS bin under `tsx` with `TSX_TSCONFIG_PATH` so workspace imports resolve through the tsconfig `paths` map, `lib` mode runs the derived `lib/bin.js` under plain Node so bare packages resolve through real `exports`; `runLoaderSmoke` creates an isolated temp cwd, layers `DSH_HOME`/`DSH_AGENTS_HOME` under it, closes stdin, and awaits a clean exit within a deadline.
- **Non-obvious design decisions:** the mode comes from the **environment** so CI can select `lib` and dev stays zero-build; an unknown mode value fails loud rather than silently falling back ("a typo in a gate's env fails loud"); `lib` mode derives the bin by rewriting only the **last** `/src/` segment (and the spec pins the Windows spelling); the lib path is derived from the src path so a fixture may point `libBin` at a Node-type-strippable TS file.
- **Edge cases:** `expectedExitCode` lets a scenario pin a designed failure surface, and a run that exits *any other way* (including succeeding) still fails the smoke; a caller-provided `cwd` is left in place, only a cwd the harness created is removed; the timeout kills only the direct child.
- **Surprising:** `LOADER_SMOKE_TEST_TIMEOUT_MS` is the subprocess timeout **plus 15 s**, so the Vitest deadline never fires before the harness's own diagnostic timeout.

### packages/test-support/loader-smoke/src/agent-turn.ts
- **Purpose:** `runFixtureTurn` — drive one task through exactly one configured root agent.
- **Key abstractions:** `FixtureTurnOptions` (task + optional canonical-event observer), `FixtureTurnResult` (`type: 'result'`, sessionId, output, usage?).
- **Data flow:** `onlyRootAgent` waits for the first `agent/created` publication (configured agents publish *asynchronously*, so a settled Loader does not imply a registered agent); the turn then sends a user message, listens on `session/event` **only for its own session**, and ignores every event until the durable `agent/inbox/spliced` carrying the message id arrives (that receipt is the start of the observed interval); `assistant/message` and `assistant/attempt` events contribute the final text and a per-`turn/step` usage entry; finally `agent.whenIdle()`, `ctx.sessions.flush(...)`, and the usage map is reduced.
- **Non-obvious design decisions:** the observer is deliberately **narrow** — it forwards only events *after* the inbox receipt, so a test cannot accidentally assert on pre-prompt noise; usage is keyed by `turn/step` so a retried step does not double-count; the `addUsage` reducer only materialises a field when either side has it.
- **Edge cases:** zero roots or more than one root throw `fixture turn requires exactly one top-level agent, found N` — **and the count is re-checked after the wait**; a failed turn still disposes its listener (and does not flush).

### packages/test-support/loader-smoke/tests/loader-smoke.spec.ts
Spec for `runLoaderSmoke`: process isolation with stdin closed, captured stdout/stderr, the temp cwd removed, a caller-provided cwd left in place, arbitrary bin argv plus `prepare`/`inspect` hooks (inspection happens *before* cleanup), the non-zero-exit diagnostic with both streams, a declared `expectedExitCode` that a clean run still fails, and the deadline kill reporting the captured output.

### packages/test-support/loader-smoke/tests/example-launch.spec.ts
Spec for the mode resolver and launch resolver: `src` mode's `--import tsx` + `TSX_TSCONFIG_PATH`, the missing-tsconfig refusal, the app-specific `tsx/esm` hook, `lib` mode's derived bin with no tsx and no paths env, an explicit `libBin`, the Windows path derivation, the "no `/src/` segment" refusal, and the environment default.

### packages/test-support/loader-smoke/tests/agent-turn.spec.ts
Spec for `runFixtureTurn` against a hand-built Context double: zero and multiple roots are rejected with the count, the agent/created wait is exercised (and the count re-checked after it), only the owned interval is observed, usage is deduplicated, a turn with no model step returns no usage, and the listener is removed even when the turn fails.

### packages/test-support/loader-smoke/tests/fixtures/production-profile.ts
`bootProductionProfile`: loads a shipped profile's bundle layers through `loadProfile`, layers the test's `*.patch.yml` overlays above them, synthesises package layers for overlay-only packages, computes the runtime resolution, and boots through production `boot()` with a `profileContext` carrying the launcher's own profile facts — so profile-backed services activate exactly as in production.

### packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts
Snapshot-only Loader driver: boots the shipped `headless` profile over a test overlay, optionally asserts a required Loader entry reached `FiberState.ACTIVE`, runs one fixture turn and streams every canonical session event as JSONL to stdout.

### packages/test-support/loader-smoke/tests/fixtures/cli-mock-llm.ts
A keyless `LlmAdapter`: the first request emits a reasoning block plus a `pwsh`/`bash` tool call; once a tool result is present it emits a text answer. It also proves a per-model reasoning-effort override by changing `reasoningEffort` to `off` at step 2 through an `agent/request` interceptor.

### packages/test-support/loader-smoke/tests/fixtures/success.ts
Subprocess fixture echoing argv, execArgv, cwd, `DSH_HOME`, `DSH_AGENTS_HOME`, an env marker and the consumed stdin as one JSON line, then writing `fixture stderr`.

### packages/test-support/loader-smoke/tests/fixtures/fail.ts
Three-line subprocess fixture: writes `fixture failed` to stderr and exits 7.

### packages/test-support/loader-smoke/tests/fixtures/hang.ts
Subprocess fixture that prints and then holds the event loop open with a 1 s interval, for the deadline-kill case.

### packages/test-support/loader-smoke/README.md
English doc: `runLoaderSmoke`'s ownership (isolated cwd, DSH homes, diagnostics, deadline, termination, EOF, cleanup of a cwd it created), the shipped-profile helper, `runFixtureTurn`, the src-vs-lib modes, "What can go wrong" (the process never exits; built mode needs a prior build; captured output is bounded by execa's 100 MB `maxBuffer`), and the design separation "the smoke runs in a child process under an isolated world, and the test process only observes and asserts".

### packages/test-support/loader-smoke/README.zh.md
Chinese mirror; same ownership statement and the same three known limits.

### packages/test-support/loader-smoke/README.i18n.yaml
Per-section en/zh digests for the loader-smoke README (12 sections).

### packages/test-support/loader-smoke/package.json
Manifest: `execa` and `tsx` as runtime deps; peers on cordis, agent, llm, session and http-proxy; dev-dep on app-boot.

### packages/test-support/loader-smoke/tsconfig.json
tsconfig with references to cordis, agent, llm, session and http-proxy.

### packages/test-support/remote-mock/src/remote-mock.ts
- **Purpose:** the endpoint-named Remote mock.
- **Key abstractions:** `RemoteTable` (unary / stream / streams), `OpenStreams` (`push`/`end`/`fail`/`opened`/`drained`), `StreamFilter`, `UnaryRuleFn`, `RemoteMock`.
- **Data flow:** `dispatch(endpoint, args)` calls the endpoint's **native mock** (so `mockResolvedValueOnce`, `mockImplementation` and `.mock.calls` all work), logs the call as soon as the rule is selected and settles it to `answered`/`failed` with the value or the thrown error; `open(endpoint, args, signal, uplink)` does the same for a stream script; `mock.rpc` is the Connection carrier face over the same core (`call` → `dispatch`, `open` → `open`) with `{ args }` payloads and abort-aware settling.
- **Non-obvious design decisions:** (a) the *same* native mock answers a direct call and real Connection traffic, so a return override and a call assertion observe the function the client actually invoked; (b) a missing default is an **unmatched request**, not a selected rule that failed — a distinct `MissingUnaryRule` error class, and `unmatched()` lists it; (c) `modeOf()` is the *only* declaration the whole-client proxies need — an endpoint that is neither declared nor ruled is dispatched as a unary call; (d) `$events` is built in: a ready frame per generation, which is what makes an assembled client reach `connected`.
- **Edge cases:** an abort before the rule settles rejects the caller with the abort reason (or a generic "call aborted" for a non-Error reason) while the rule stays `pending` in the log; `settleOrAbort` keeps a handler on the underlying promise so the rule's own outcome is never an unhandled rejection; the carrier's uplink is attached only for the duration of the `open` call.
- **Surprising:** `endpoints()` includes *accessed proxy methods* as well as registered endpoints, so an assembly can see what the client asked for.

### packages/test-support/remote-mock/src/streams.ts
- **Purpose:** the scriptable stream machinery.
- **Key abstractions:** `StreamHandle` (`push`/`end`/`fail`/`signal`/`uplink`), `StreamScript`, `MockStream`, `MockClientStream`, `streamHandle`/`streamMethod`.
- **Data flow:** `MockStream` owns a queue and at most one pending read; `push` resolves a waiting reader or enqueues; `end`/`fail`/consumer-cancel settle it (first one wins) and the log entry moves to `ended`/`failed`/`cancelled`; `drained()` resolves when the consumer has pulled everything pushed so far.
- **Non-obvious design decisions:** `drained()`'s contract is stated precisely — "pulled means taken from the queue: a consumer that processes items asynchronously after pulling them may still be working on the last one" — and a stream nobody reads never drains; a **second concurrent read rejects** with `stream has one consumer`, because the Gateway reads streams sequentially and a second reader means test-side misuse; `streamMethod` lifts an async generator into the generated method's own signature so `vi.fn<M>()` keeps the types.
- **Edge cases:** `MockClientStream.send` rejects a non-lossless-JSON item (the real handle's check) and a send after the uplink was closed throws `uplink was ended`; a consumer that leaves early closes the owned uplink and wakes a script blocked on it.
- **Surprising:** `dispose()` is cancellation, not `end()` — it cancels the stream and drops what the consumer left.

### packages/test-support/remote-mock/src/log.ts
The `MockLogStore`: one shared `seq` counter across calls and stream opens, so `calls()` and `streams()` interleave truthfully; call entries carry `state: pending|answered|failed` and the value or the thrown error; `requests()` lists the first positional arg of every call and open in seq order and **excludes the Gateway's own `$`-prefixed endpoints** when no endpoint is named.

### packages/test-support/remote-mock/src/remote-proxy.ts
`createRemoteProxy`: a two-level `Proxy` that lazily caches namespace and method identities (so `mock.remote.settings.describe` is the *same* function every time) and returns `undefined` for `then` and for symbol probes — the mock stays inert under `await` and under `Object.keys`.

### packages/test-support/remote-mock/src/index.ts
Public barrel: `RemoteMock`/`ok`, the `OpenStreams`/`RemoteTable`/`StreamFilter`/`UnaryRuleFn` types, the `frames`/`openStream`/`streamHandle`/`streamMethod` script helpers, `MockClientStream`, the log types and `MockedRemote`. Browser-safe by construction (no DOM, React or Node imports).

### packages/test-support/remote-mock/tests/proxy.client.spec.ts
Spec for the native namespace mocks: identity caching, inert thenable/symbol probes, FIFO consumption of queued one-shot answers across direct and carrier calls, positional-argument recording (the carrier keeps its `AbortSignal` out of the args), and a failed stream rejecting the reader while `push` afterwards returns 0.

### packages/test-support/remote-mock/tests/streams.client.spec.ts
Spec for stream scripts and live control: `frames()` then end, `openStream()` plus filtered `push`/`end`/`fail` with delivery counts, the single-consumer rule, settling twice as a no-op, cancellation recorded as `cancelled`, the `$events` ready frame per generation, and `opened(endpoint, n)` waiting for N opens.

### packages/test-support/remote-mock/tests/rpc.client.spec.ts
Spec for the carrier face: the two payload shapes (whole-client proxies send an array, the Gateway's own endpoints send one object), the uplink handed to the script and kept out of the logged args, the uplink closed when the stream ends or the consumer exits early, malformed payload and unmatched-endpoint rejection with the miss logged, and the abort semantics (immediately when already aborted, with the reason while pending).

### packages/test-support/remote-mock/tests/unary.client.spec.ts
Spec for unary answers: a fixed value logged with a global seq, default replacement and an explicit `undefined` answer, positional handlers, raw vs handler answers, the pending/answered/failed log states, and `requests()` ordering with the `$`-prefix exclusion.

### packages/test-support/remote-mock/tests/proxy-types.client.spec.ts
Type-level spec that compiles a synthetic Remote namespace map with the TypeScript compiler API (virtual module host) to prove `MockedRemote` keeps namespace/method names, parameters and return types, and that the runtime proxy adds no runtime import of the protocol or the spy package.

### packages/test-support/remote-mock/README.md
English doc: the native-mock proxy surface and its `mockResolvedValue`/`mockResolvedValueOnce`/`mockImplementation` semantics (including that `mockClear()` preserves responses and `mockReset()` restores the initial implementation), the default-response table, driving streams, connecting a client via `mock.rpc`, the observation API, and the known limits (in-process carrier only; values pass by reference and are not validated; no payload matching; a native stream override owns its iterable and bypasses the scripted-stream controls).

### packages/test-support/remote-mock/README.zh.md
Chinese mirror; same five known limits.

### packages/test-support/remote-mock/README.i18n.yaml
Per-section en/zh digests for the remote-mock README (13 sections).

### packages/test-support/remote-mock/package.json
Manifest: `@vitest/spy` is the only runtime dependency (so the mock works in a browser page without the Vitest runner); peers on cordis and dsh-typert-protocol; dev-deps on the API settings controller, client-connection, typert-protocol and typescript.

### packages/test-support/remote-mock/tsconfig.json
Client tsconfig extending `tsconfig.base.client.json` with references to typert/protocol, cordis and client/connection.

### packages/test-support/remote-mock/tsdown.config.ts
tsdown config reusing the shared `clientLibrary()` helper.

### packages/test-support/client-runtime/src/index.ts
- **Purpose:** the jsdom slot test runtime.
- **Key abstractions:** `SlotTestRuntime`, `TestRoot`, `OwnerPropsCell`, `SlotView`, `FeatureHandle`, `TestFileUpload`, `Stabilizer`.
- **Data flow:** `create()` builds a fresh Cordis `Context`, mounts the **production** `SlotRegistry`, the production `createSlotRenderer` and the production `ui-session` adapter, and provides the test-owned Session/Workspace doubles plus a fail-loud file-upload stub. `declare(children, Frame?)` registers an auto frame whose per-key `<div data-slot>` wrappers become snapshot roots. `renderSlot(key, owner, opts?)` returns a slot-local view (the renderer's own anchor as the container, Testing Library queries scoped inside it) whose `update(owner)` re-renders in place through the `OwnerPropsCell`'s external store (`useSyncExternalStore` pairing).
- **Non-obvious design decisions:** the bench **copies no production logic** — it mounts the production registry, renderer and adapter; every public mutator is act-wrapped through one `Stabilizer`, so "tests never handle SlotCore microtask batching or React `act` themselves"; `dispose()` tears down along **one axis** — React trees first, then feature fibers, then the root registration and standard sources, then minted session scopes, then persisted test state — and is idempotent.
- **Edge cases:** `mount` pre-checks required services and fails loud with the missing names instead of suspending forever; `renderSlot` before `declare` fails loud; `storeOf` guards against a missing live Session binding and against a released one.
- **Surprising:** the auto frame's owner props live in an external store so a spec drives React through the **standard `useSyncExternalStore` boundary**, not by poking props.

### packages/test-support/client-runtime/src/sessions.ts
- **Purpose:** the test-owned Session Controller faces.
- **Key abstractions:** `FixtureSession` (implements `SessionFace`), `TestSessions`, `SessionRecord`, `SessionGeneration`.
- **Data flow:** `FixtureSession` reads its snapshot from a `SnapshotStore`, exposes a `MutableSessionEventSource` for Conversation assembly, and provides identity-stable per-key projection faces (`faceOf(key)` returns the same object for the same key; `set(key, value)` notifies). `TestSessions` keeps catalog `SessionRecord`s that outlive references, and mints **real-tagged** scopes lazily through the production `scopeOf` when a reference is retained; a `SessionGeneration` owns an `AbortController` whose abort is the scope's lifetime.
- **Non-obvious design decisions:** the runtime **never fakes a method a test did not supply** — every unstubbed verb (`prompt`, `cancel`, `rename`, `loadOlder`, `loadThrough`, `updateQueue`, `readAttachment`, `command`) throws a message naming itself and the fixture, so a missing stub surfaces at the call site rather than silently passing; a catalog entry can be added without retaining it, and only a *retained* reference owns a scope; a same-id replacement is kept when stale generation cleanup arrives late.
- **Edge cases:** releasing a reference aborts the generation and disposes its fiber, and a disposal failure is logged as a warning rather than thrown; a removed session's scope survives until an explicitly retained reference releases it.
- **Surprising:** `beginSubmission()` mints a client-only echo identity and deliberately does **not** touch the fixture snapshot (submissions are presentation state).

### packages/test-support/client-runtime/src/workspaces.ts
`TestWorkspaces` implements the production `IWorkspaces` face so a Controller change breaks the double at compile time; every action is recorded into `calls`, defaults are inert echoes (e.g. `create` derives a view from the path), `stub(method, impl)` replaces one action's behaviour while the record is still appended, and `update(mutate)` goes through the runtime's act wrapper.

### packages/test-support/client-runtime/src/fixtures.ts
Plain fixture builders: `sessionSnapshot` (a complete quiescent Session Controller snapshot), `conversationSnapshot`, `chatSnapshot`, `workspaceSnapshot`, and the `SessionBehaviorOverrides` type — `Partial<ISession> & Record<string, unknown>`, typed against the production `ISession` so a face change surfaces at compile time, with the open `Record` tail documented as the one place a misnamed EXTRA member is not caught.

### packages/test-support/client-runtime/src/access.ts
`allowAllAccess` (hand-built component props) and `allowAllAccessPlugin`, which provides an always-true `remoteAccess` service plus a root `keyedHooks.remoteAccess`, so ui-session and ui-workspace publish allow-everything access Hooks.

### packages/test-support/client-runtime/src/remote.ts
`TestRemote`: the `ctx.remote` double. It registers itself plus one service per scripted namespace (so a plugin injecting `remote.<name>` unparks), drives `$on` subscriptions from an explicit `emit()`, exposes `$host` as a plain mutable field, and **refuses** `$mount` ("needs the real Client Remote service") because a spec needing a real generated contribution has outgrown the double. It also refuses a scripted namespace whose name would shadow one of the double's own members — accepting it would replace the very refusal the case pins.

### packages/test-support/client-runtime/src/snapshot.ts
`domSnapshotSerializer`: folds CSS-module scoped class names (`_frame_334d2d` → `frame`) so CSS edits do not churn `.snap` files, and collapses `<svg>` internals to a `data-content` FNV-1a fingerprint so path geometry stops being print noise while an actual artwork change still flips the snapshot. Both transformations happen on a **clone**, so the live DOM keeps its class and tag queries.

### packages/test-support/client-runtime/src/translate.ts
`makeTranslate(...dicts)`: a translate stub over plain dictionaries mirroring LocaleRuntime's resolution order (first dictionary owning the key wins, else the key stays visible) and its `{name}` interpolation.

### packages/test-support/client-runtime/src/locale-env.ts
`usePinnedBrowserLanguages(primary, ...rest)`: a beforeEach/afterEach pair pinning `navigator.languages`/`navigator.language`, restoring the environment's own accessors afterwards (by deleting the own properties, since `Navigator` declares both readonly). A spec asserting Chinese copy states the browser it assumes instead of inheriting the runner's `en-US`.

### packages/test-support/client-runtime/src/config-form.ts
`stubConfigForm<T>()`: an in-memory settings scope that starts in the `loading` state, records writes in `vi.fn` spies, exposes `listenerCount()` for disposal assertions, and `publish(next)` mimics a Host acceptance by merging the snapshot and notifying subscribers.

### packages/test-support/client-runtime/src/assembly/roster.ts
- **Purpose:** the ordered package-name rows a whole-client test boots.
- **Key abstractions:** `ClientRosterRow` (name, `inject`, `immediately`), `ClientRoster`, `AssemblyPlan` (roster + `provide` replacements), `ClientPluginModule`.
- **Data flow:** `ClientRoster.of(rows)` freezes a copy and refuses duplicate names; `pick`/`closure`/`without` keep roster order regardless of the requested order; `closure(names)` walks the `inject` edges transitively and stops at the shell's platform seed modules; `graphFromRoster(rows)` synthesizes a one-batch `WebBootGraph` with placeholder `plugins/<name>/client.js` references.
- **Non-obvious design decisions:** validation stays with the **production** `parseBootManifest` inside the module system (duplicate names and an empty roster are rejected there, not here); every module is seeded in process, so the URL is a placeholder that is never fetched; `closure` **throws** when a row injects a package outside the roster, because the bundle itself would not boot.
- **Edge cases:** unknown names in `pick`/`closure`/`without` throw with the roster listed; `provide` keys outside the roster are rejected by `assertPlan`.
- **Surprising:** `immediately` is a *stage-one prefetch mark* from the package's own `dsh.client` declaration, not a test decision.

### packages/test-support/client-runtime/src/assembly/bundle-roster.ts
- **Purpose:** read the browser roster of a `dsh --profile` **out of the bundles themselves**.
- **Key abstractions:** `WEB_PROFILE_BUNDLES` (`dsh-base` then `dsh-web-app`), `BundleLayer`, `webApp`.
- **Data flow:** each bundle's `dsh.bundle.patch` file list is parsed with the include plugin's own `entryListSchema` and composed by its `applyEntryPatches`; every enabled row whose package declares `dsh.client.platform === 'web'` becomes a roster row carrying that declaration's `inject` and `immediately`; rows nested in Loader groups count like the Loader counts them, and a disabled group disables every row beneath it.
- **Non-obvious design decisions:** **nothing is copied from the bundles** — a bundle change is visible at the next import; a patch that matches nothing **throws here where the launcher only warns** (the test must not silently boot a smaller roster); a browser row with an unevaluated `disabled` expression is refused unless the caller supplies a Loader evaluation scope (`webApp` supplies the `web` profile scope).
- **Edge cases:** bundle dependencies resolve from their **real package directories**, and a dependency next to any bundle takes precedence over one inherited from an ancestor directory.
- **Surprising:** this is the one place in the whole-client tier that reads the repository — the tier otherwise runs entirely in process.

### packages/test-support/client-runtime/src/assembly/modules.ts
Imports each roster row's `/client` namespace (or the plan's `provide` replacement) and registers it as a **pre-arrived factory** on a production `ClientModuleSystem`, so neither the Loader's `internal.import` nor a stage-one `prefetch` ever fetches a bundle. A missing import is prefixed with the package name; the bootstrap row (`@deepseek-ai/dsh-client-modules`) is the statically imported namespace and cannot be provided; a row with no loaded module rejects loudly ("in-process modules never load bundles (...)") instead of falling back to a fetch.

### packages/test-support/client-runtime/src/assembly/test-client.ts
- **Purpose:** the whole-client carrier.
- **Key abstractions:** `TestClient`, `TestClientOptions` (`mount`, `awaitConnected`, `connectTimeoutMs`), `SharedJsdomShims`.
- **Data flow:** `TestClient.start(plan, mock, options)` loads the roster modules, binds `{ rpc: mock.rpc }` to that client's Connection row, holds the shared jsdom shims, boots through the production `bootClient` over the synthesised graph, optionally mounts `uiRenderer`, and waits for `ctx.connection.state === 'connected'`.
- **Non-obvious design decisions:** (a) the `dsh-api-remotes` and `dsh-api-remote-access` rows are **dropped** (their generated clients exist only in built `lib/`) and replaced by `remote.<ns>` proxies and allow-all access Hooks — and a `provide` entry for either row is refused; (b) the jsdom shims are **refcounted**: the first holder installs `EventSource`/`ResizeObserver`/`document.fonts` only where the global is absent, and the last release removes **exactly those**, so a pre-existing global is left alone; (c) on teardown, unmatched Remote calls are reported **even when the plugin tree also failed to dispose**, with both failures in one message.
- **Edge cases:** mounting without a DOM fails loud ("mount requires a DOM"); a roster with no `connection` service fails loud; a `connectTimeoutMs` expiry reports the connection state, the unmatched requests and the stream states; `dispose()` is idempotent and a concurrent second dispose waits for the first teardown.
- **Surprising:** the `api-remotes` row is dropped **and** the proxies are provided — the tier trades the generated clients' validation for the ability to boot without a build.

### packages/test-support/client-runtime/src/assembly/remote-proxies.ts
`remoteNamespacesOf` (every `remote.<ns>` a roster module injects, in both inject forms, plus the namespaces of the mock's endpoints) and `remoteProxiesPlugin`, which provides one Proxy per namespace. A call becomes endpoint `<ns>/<method>` over the roster's own Connection; a stream when the mock registered a stream script for it, a unary call otherwise; a unary rejection is folded with the Gateway client's own `carrierFailure` / `cancelledFailure`, so product code that never awaits a rejection sees none. `then` is explicitly undefined so awaiting the namespace object does not call a method.

### packages/test-support/client-runtime/src/assembly/remote-default-responses.ts
The default answers for every Remote endpoint the web assembly calls **while booting and rendering** with no sessions, no workspaces and default settings — each row commented with the plugin that calls it (`session/list` ← api-session-controller's `handleConnected`, `settings/describe` ← ui-settings' `mirror.ensure`, `session/modelCatalog` ← the ModelDirectoryResolver, …). Endpoints a boot never touches stay **absent** so a new call fails loud; the roster's later-opened streams are declared separately so a spec that forgets the script gets a *stream* miss rather than a unary one.

### packages/test-support/client-runtime/src/assembly/vitest.ts
`createClientTest(plan, options)`: a Vitest `test.extend` providing a fresh `mock` (preloaded with `remoteDefaultResponses`), a `remote` proxy that is the *same* object as `mock.remote`, and a lazy `start()` that shares one promise. Cleanup waits for startup but does not rethrow its rejection, and `mock.assertNoUnmatched()` still fails a test that never started a client.

### packages/test-support/client-runtime/src/assembly/index.ts
Deep-import-only barrel for the whole-client tier, deliberately kept out of the package root so slot-tier specs never load the assembly machinery.

### packages/test-support/client-runtime/tests/runtime.client.spec.tsx
48-case spec for `SlotTestRuntime` against the production `SlotRegistry` + `createSlotRenderer`: root declaration and rendering (fallback → live registration → unload), rendering with no root declaration failing loud, the SessionProvider/reference lifecycle (explicit references, live snapshot updates, repeated references, release on a rejected registration, cancellation and generation-disposal races, a same-id replacement surviving stale cleanup), the fail-loud session face naming the missing verb, per-session store identity/isolation and action-driven re-render, the `storeOf` guards, the workspace feed and action face, feature mount/dispose cascade, slot-local views with sibling isolation, and the snapshot serializer's class folding + svg fingerprint.

### packages/test-support/client-runtime/tests/helpers.client.spec.tsx
Spec for the fixture helpers: the allow-all access Hooks, the always-true `remoteAccess` service whose sources never change, the retraction of default root sources **without** removing their live replacements (a duplicate root hook is refused), the pane/workspace behaviour, and scope borrowing/disposal.

### packages/test-support/client-runtime/tests/remote.client.spec.ts
Spec for `TestRemote`'s own contract: subscription and disposal, an inert `emit` for an unsubscribed name (the wire carries whatever the Host allowlist selected), the `$mount` refusal, a scripted namespace reachable both as `ctx.remote.<name>` and as its own service, and the refusal of a namespace that would shadow a double member.

### packages/test-support/client-runtime/tests/assembly-test-client.client.spec.ts
jsdom spec for `TestClient`: boots the whole web-app roster, connects, mounts and disposes with nothing unmatched; leaves a pre-existing global alone and removes only its own shims; and reports the mock log when the connection never becomes ready.

### packages/test-support/client-runtime/tests/assembly-test-client-node.client.spec.ts
Node-environment spec: boots and connects without a DOM, closes the client even when the plugin tree fails to dispose (and still rethrows the original failure), rethrows a row that fails to apply, refuses to provide the generated-Remote rows, drops the remote-access row and answers every access question with true, reports unmatched requests alongside a failed teardown, lets a concurrent second dispose wait for the first, refuses to mount without a DOM, and fails loud when the roster provides no `connection`.

### packages/test-support/client-runtime/tests/assembly-vitest.client.spec.ts
Spec that the fixture's cleanup stays active after an assertion failure and without a started client, that concurrent starts share one promise, that a saved `start` after the fixture closed is refused, and that a rejected startup is kept with its caller and releases the page transport.

### packages/test-support/client-runtime/tests/assembly-roster.client.spec.ts
Spec for `ClientRoster` and `graphFromRoster`: a frozen copy, duplicate refusal listing each duplicate once, order-preserving `pick`/`without`/`closure`, the platform-seed exception, unknown-name errors, the "injects X which is outside the roster" refusal, and that the synthesised graph passes the **production** `parseBootManifest` validator.

### packages/test-support/client-runtime/tests/assembly-modules.client.spec.ts
Spec for in-process module arrival: dynamic `/client` imports resolve through the repository path aliases, a provided row replaces one, the bootstrap row is pinned and cannot be provided, a missing import is prefixed with the package name, `prefetch`/`import` are served from the registered factories with `loadBundle` never called, a graph row with no module rejects loudly, the graph is exposed as the production-parsed manifest, and the vendored Loader boots over the in-process table with every entry active.

### packages/test-support/client-runtime/tests/assembly-bundle-roster.client.spec.ts
Spec for reading the roster from the real bundles: `dsh-base` then `dsh-web-app` compose, names are unique, there are no dangling inject edges, browser rows carry their declarations and Host-only rows are dropped, and a scratch installation resolves bundle dependencies from real package directories (including a linked bundle and an uneven `node_modules` search path exhausting before the "cannot resolve plugin package" error).

### packages/test-support/client-runtime/tests/assembly-remote-proxies.client.spec.ts
Spec for the proxies: namespace discovery from both inject forms plus mock endpoints, routing a call through the mock with the positional args logged, dropping the api-remotes row, folding a ruleless call into `gateway/internal` (leaving the miss in the log so `dispose()` reports it), folding an aborted call into `gateway/cancelled`, and passing stream items and failures through unchanged.

### packages/test-support/client-runtime/tests/assembly-dependencies.client.spec.ts
Spec that a **real** bundle dependency closure activates its requested client plugins with no extra roster rows: HMR boots with its module provider and no Connection, and the Session Controller boots with its file-upload provider and reaches the ready phase with the expected `session/list` call and `session/control` stream.

### packages/test-support/client-runtime/tests/assembly-plan.client.spec.ts
Unit spec for `assertPlan`: a bare roster and roster-owned `provide` keys are accepted; a key outside the roster is rejected with the roster listed.

### packages/test-support/client-runtime/tests/__snapshots__/runtime.client.spec.tsx.snap
The two DOM snapshots: one showing the folded class names (`frame plain`), the `data-content="2bfa09dc"` svg fingerprint and the `data-slot="trt.panel"` wrapper, and one showing a **childless** svg left untouched next to a scoped class.

### packages/test-support/client-runtime/README.md
English doc for the two tiers: the slot bench (`declare`/`mount`/`renderSlot`/`storeOf`/`dispose`), the snapshot serializer, scripting Remote answers and failures **by code and never by class**, the whole-client tier and its `createClientTest` fixtures, the roster and startup behaviour (including `reload(name)` rebuilding one Loader entry), and the known limits (the whole-client tier does not run the generated Remote clients; proxied calls bypass the Gateway client's `invoke`/`invokeStream`; an undeclared endpoint is dispatched as a unary call; the client compile program adds the `node` ambient types; Session/Conversation/Chat fixtures stay separate).

### packages/test-support/client-runtime/README.zh.md
Chinese mirror; same five known limits.

### packages/test-support/client-runtime/README.i18n.yaml
Per-section en/zh digests for the client-runtime README (20 sections).

### packages/test-support/client-runtime/package.json
Manifest: `@testing-library/dom`, `@testing-library/react`, `js-yaml` and `vitest` as runtime deps; the whole client stack plus `dsh-remote-mock` as peers; dev-only consumption.

### packages/test-support/client-runtime/tsconfig.json
Client tsconfig with the `client-build-environment` and `node` ambient types and 22 project references.

### packages/test-support/client-runtime/tsdown.config.ts
tsdown config reusing the shared `clientLibrary()` helper.

### packages/test-support/session-snapshot/src/suite.ts
- **Purpose:** the keyless ACP snapshot suite factory.
- **Key abstractions:** `Scenario` (name, env, `hasModelTurn`, `recorded`, `pinsHeader`, `headerClass`, `expectedHeaderChanges`, `expectedPromptChanges`, `systemPromptSource`, `toolSchemasSource`, `pinsChildToolSchemas`, `pinsChildSystemPrompts`, `comparesLog`, `prepareWorkspace`, `workspaceParent`, `platform` flags), `SnapshotSuiteOptions`, `SharedSnapshotClaim`, `FixtureReplacement`.
- **Data flow:** `defineAcpSnapshotSuite` validates the scenario table (duplicate names; a header class with no pinning scenario; two scenarios pinning one class; sidecar sources that are unknown, non-pinning, or redirecting the same artifact; shared sidecars with mismatched change counts), then registers a `describe` tree: replay scenarios run under `describe.concurrent` (each subprocess owns a unique temp cwd and reads only committed fixtures) while record/refresh stay serial because they write. Each scenario reads its `snapshot.yml` + `input.json`, runs the scenario through `runScenario`, and compares the normalised stdout, the comparable Session logs and the optional `workspace.expected/` tree.
- **Non-obvious design decisions:** (a) **exactly one scenario per header class pins the tokenized request-header sequence and the tokenized `system/message` sequence** — every live header and system prompt is checked against the composed pin, so session-dependent composition must declare a *separate class* instead of escaping coverage; (b) a sidecar may be **shared** by another pin only when the complete sequence is identical *and* the two declare the same change count (the sidecar's size is `1 + changes`); (c) `claimSharedSnapshot` makes a later claimant generate **identical bytes**, so record/refresh output does not depend on scenario order; (d) `assertUniqueSnapshotContents` rejects byte-identical committed snapshots under different paths — one source, reused; (e) the refresh path reuses the *committed* volatile values where the normalised fresh value equals the normalised existing value, so a refresh does not churn ids, times or paths.
- **Edge cases:** a retained historical generation (`sessionFormat.version` in the manifest) is immutable — record and refresh never write it and the comparison uses a separate `writer.expected.jsonl` oracle; a child sidecar must be canonical (end in a newline) and must **differ from its class pin**; a shared child sidecar must name a real child index.
- **Surprising:** the storage guard requires that **every `request/header` is preceded by a `system/message`** — prompt-before-request is a fixture invariant, not a convention.

### packages/test-support/session-snapshot/src/normalize.ts
- **Purpose:** every pure normalizer the snapshot tier compares with.
- **Key abstractions:** `NormalizeContext` (`sessionIds`, `cwd`, `cwdAliases`), `CwdPathMode` (`canonical` | `native`), `NormalizeOptions` (`identityMode: legacy | preserve`), `SessionSnapshotComparisonOptions`.
- **Data flow:** `scrubString` replaces every known spelling of the generated cwd (longest-first, plus the macOS `/private` aliases) with `{{cwd}}`, converts separators **only inside cwd-rooted paths** (a global rewrite would corrupt regexes, commands and model-authored text), collapses spill paths to `{{spillLocator:<name>}}`, and scrubs embedded event times **only inside a fenced event-read target region** so neighbour text stays regression-visible. `normalizeStdout` renumbers JSON-RPC ids to a first-seen sequence (so id churn does not perturb the golden) and throws on a non-JSON line — doubling as a protocol-stdout purity check. `normalizeSessionLog` zeroes every clock the writer owns (header `createdAt`, event `time`, packed `time0`/`dt` gaps, embedded stream member times, `hook/result.durationMs`, goal/job/feedback/subagent-catalog clocks) and expands `sourceEventSeqs` ranges. `scrubSystemPrompts`/`scrubToolSchemas`/`scrubModelRequestBulk` replace the prompt text and the header schemas with `{{system}}`/`{{tools}}` while keeping field presence.
- **Non-obvious design decisions:** (a) **field presence is behaviour** — an absent `tools` field stays absent and an empty system prompt stays empty; (b) the `path` key and `cwd`-rooted paths get canonical separators while every other string keeps its own; (c) `usage_update.used` is replaced by `{{usedTokens}}` but the **capacity** (`size`) is kept — "stabilizes path-dependent context occupancy without hiding capacity"; (d) the tool scrubber keeps ordered tool **names** when the log contains developer messages, so historical tool-addition references stay verifiable; (e) every scrubber is idempotent.
- **Edge cases:** a cwd without a basename throws; a log that does not start with a session header throws; a body that mixes projected and complete envelopes is refused by the replay parser; macOS `/private` residue around an existing `{{cwd}}` token is collapsed.
- **Surprising:** the identity redaction runs **after** format restoration and runs with `identityMode: 'preserve'`, so typed tokens survive while stray UUIDs do not.

### packages/test-support/session-snapshot/src/harness.ts
- **Purpose:** the scripted scenario driver over the real ACP protocol.
- **Key abstractions:** `InputStep` (a union of `initialize`, `newSession`, `prompt`, `promptAndCancel`, `promptExpectError`, `promptAndWaitForAgentMessage`, `newSessionExpectError`, `cancel`, `waitForTurnStart`, `waitForTurnEnd`, `waitForSubagentTurnEnd`, `waitForGoalPhase`, `waitForInboxMessage`, `waitForTitleAfterTurnEnd`, `waitForEventAfterTurnEnd`, `waitForFile`), `InputScript`, `PermissionAnswer`, `HarvestedLog`, `RunResult`.
- **Data flow:** `runScenario` boots the agent through the launcher, drives the ACP JSON-RPC stdio client with the script, tees raw stdout, and (in record mode) harvests the persisted Session JSONL after a graceful shutdown flush. Each `waitFor*` step polls the **durable** log for a specific boundary rather than waiting on presentation output.
- **Non-obvious design decisions:** the wait steps are deliberately **state-based**: `waitForTurnStart` waits for an open durable turn (optionally at or beyond a turn number), `waitForTurnEnd` waits for the latest *complete raw-JSONL* turn boundary to be `turn/end`, `waitForInboxMessage` waits for an inserted inbox message containing a scenario marker, `waitForSubagentTurnEnd` waits for one background child to have persisted a closed model-work turn (child progress has no ACP update to wait on), `waitForEventAfterTurnEnd` waits for a typed post-boundary record. `promptAndCancel` arms a waiter, then cancels and awaits completion — the app is held open through the cancellation rather than through a timer.
- **Edge cases:** a wait timeout names the session or child **and** the deadline, even when the first log harvest exceeds that deadline, and retains the underlying failure as the error cause; `waitForTurnStart` rejects malformed turn records immediately; an unhandled permission request fails closed as `cancelled`; a scripted permission kind the agent never offered **fails the run** (a callback throw would only reach the agent as a JSON-RPC error, letting a tolerant agent carry on and the scenario pass).
- **Surprising:** `newSession` captures the server-issued random session id into a `{{sessionId}}` variable, because a committed file cannot know the id in advance.

### packages/test-support/session-snapshot/src/launcher.ts
- **Purpose:** the ACP subprocess/client launcher.
- **Key abstractions:** `AgentUnderTest` (absolute `binScript`, optional `libBinScript`, `configPath`, `profile`, `tsconfigPath`), `AcpTestLaunchOptions`, `AcpTestClient`, `LaunchedAcpTestAgent`.
- **Data flow:** the launcher resolves the source-or-built artifact, builds the profile argv, materialises the profile patch (rebasing authored relative module names and linking profile packages into the temp cwd), spawns the bin, tees raw stdout into an ACP SDK client app, collects Session updates and stderr, answers permission requests (fail-closed when none is configured), and owns shutdown.
- **Non-obvious design decisions:** the launcher is the **single owner** of the process boundary — e2e and snapshot suites do not each reconstruct it; shutdown checks **both** OS termination markers (`exitCode` and `signalCode`) and gives an accepted Windows termination request a bounded grace window to publish its exit marker, so a race between a requested signal and a fallback termination cannot lose the child's error.
- **Edge cases:** a launch-resolution error (no child process yet) is preserved as-is rather than being masked by a termination failure; a child error survives the fallback path (accepted termination, refused fallback, late exit marker).
- **Surprising:** the launcher uses the ACP SDK's own protocol types rather than a hand-rolled JSON-RPC client.

### packages/test-support/session-snapshot/src/manifest.ts
- **Purpose:** the closed `snapshot.yml` manifest.
- **Key abstractions:** `SnapshotProfile` (`headless|sdk|sdk-minimal|acp|web`), `SnapshotRecording` (`live|authored`), `SnapshotHeaderManifest`, `SnapshotReplayManifest`, `SnapshotPlatform`, `SnapshotPermission`, `SnapshotWorkspaceManifest`, `SnapshotInputManifest`, `SnapshotSessionReference`, `SnapshotSessionFormatManifest` + `SnapshotSessionFormatCoverage`.
- **Data flow:** `parseSnapshotManifest(source, path)` parses the YAML and validates every field with `exactKeys` (unknown keys are refused) and labelled messages, then returns a closed `SnapshotManifest`; `writesCurrentSessionFixtures(manifest, mode)` decides whether this scenario may write the current generation (an owning manifest may in record and refresh; a borrowed (`session.source`) or a retained (`sessionFormat.version`) one may not, and replay never writes).
- **Non-obvious design decisions:** the manifest declares only the facts the **completed Session cannot reconstruct** — the replay override, the platform, the permission preset, the environment, the workspace setup and the input bytes; everything else is read back from the log; the `sessionFormat` block is only valid when the scenario **owns** its fixtures.
- **Edge cases:** `session.source` must be a relative POSIX path (an absolute path or a backslash is refused); coverage names must be a non-empty array of unique supported names; an invalid YAML document is reported as "invalid YAML".
- **Surprising:** the manifest is a *closed* schema — an unknown key is a hard failure, so adding a field is a deliberate, reviewed change.

### packages/test-support/session-snapshot/src/session-files.ts
The canonical Session filename grammar: `sessionFixtureName(index, version)` (`session.jsonl`, `session.1.jsonl`, `session.v3.jsonl`, `session.1.v3.jsonl` — v0 omits `.v0`), `writerSnapshotName(index)` (the native-writer oracle, deliberately outside replay selection), `parseSessionFixtureName` (a `session*.jsonl` lookalike is **rejected**, not ignored), `sessionFixtureFiles`/`sessionFixtureNames` (the numerically highest generation per contiguous role; a gapped child set is refused), `persistedSessionFilename`/`parsePersistedSessionFilename`/`latestPersistedSessionPaths`, and `assertSessionFixtureVersion`/`assertPersistedSessionVersion` (the filename's declared generation must equal the header's).

### packages/test-support/session-snapshot/src/identity.ts
- **Purpose:** relationship-preserving identity redaction for committed snapshots.
- **Key abstractions:** `IdentityKind` (`session|message|approval|workflow|command|rpc|retry|id`), the candidate regexes (a UUID fragment, a short job id, the legacy `{{sessionId}}`/`{{messageId}}` tokens and the canonical `{{kind:n}}` tokens).
- **Data flow:** the session header id is always claimed; then every record is walked, claiming ids by **key** (`commandId` → command, `rpcId` → rpc, `retryId` → retry, `runId` → workflow, an `id`/`…Id`/`…Ids` key → id; an `approval/asked`/`approval/decided` record's `id` → approval) and by **shape** (a message-shaped record's `id` → message; the text `as message <uuid>` and `Anonymous user: <uuid>`); finally every claimed value is replaced by its token, longest source first.
- **Non-obvious design decisions:** the redaction is a **fixed point** — re-running it changes nothing — because the canonical tokens are recognised and their ordinals are carried forward (`{{message:7}}` keeps its 7, so the next new message becomes `{{message:8}}`); a generic `id` key that first *sees* a canonical token does not steal its kind; a UUID that is merely **prose** (not a message id, not after `as message`) is left alone.
- **Edge cases:** the replacement is longest-source-first so a short id cannot corrupt a longer one; the trailing newline of the input is preserved exactly.
- **Surprising:** the redaction runs across a parent **and** its children as one corpus, so a child's `parentSession` still points at the parent's token — the relationship survives the redaction.

### packages/test-support/session-snapshot/src/workspace.ts
`captureWorkspaceSnapshot(root, { ignoredRootEntries })` walks the tree without resolving links and without depending on host path separators, emitting `text` (UTF-8 round-trip checked), `binary` (base64), `symlink` (target text, unresolved) and `empty-directory` entries sorted by path; `captureExpectedWorkspaceSnapshot` additionally omits the `.empty` Git-only marker.

### packages/test-support/session-snapshot/src/index.ts
The package barrel re-exporting the four layers (identity, harness, launcher, normalizers, manifest, session filenames, suite helpers, workspace capture) and stating the support-tier constraint that the entry imports vitest and is therefore importable only inside a vitest run.

### packages/test-support/session-snapshot/tests/harness.spec.ts
56-case spec driving `runScenario` through the **real** spawn path against the scripted fake ACP bin: boot/close and an asynchronous child spawn failure surfacing through startup, profile argv and patch rebasing in live and replay mode, inherited stdio after the parent exits, four termination-refusal / exit-marker races, in-flight client callbacks after the ACP stream closes, stderr included when the connection closes during startup, a full turn (initialize → session → prompt → permission stub → harvest), a structured prompt-content step that is not flattened, override/child fixture paths forwarded into the child env, workspace seeding and `prepareWorkspace`, concurrent runs getting private spill roots, every `waitFor*` step (including its timeout diagnostics), `promptExpectError` / `newSessionExpectError` semantics, scenario-and-cleanup failure reporting together, log harvesting (primary first, children by `createdAt` then id, filesystem noise skipped), and permission answering from a scripted queue.

### packages/test-support/session-snapshot/tests/suite.spec.ts
115-case spec for the suite factory and its helpers: the registration contract (a class with no pin, two pins for one class, duplicate names, unknown/non-pinning sidecar sources, a redirecting source, mismatched change counts), shared-snapshot claim and uniqueness, the filename helpers, `scenarioSkipped` (authored scenarios skip only while recording; a retained generation skips while recording but replays and refreshes; `posixOnly`/`pwshOnly`), `fixtureContext` (and its impossible sentinel cwd), the normalised header/prompt/schema extractors, `systemPromptPrecedesRequests`, the sidecar formats, `unknownToolCallIds`, `stabilizeFixtureMessageIds` (one committed UUID reused across parent and child), `refreshFixtureReplacements` and `stabilizeRefreshLog` (packed member times preserved, volatile fields reused, fresh semantic fields accepted, correlated ids kept consistent), and `reconcileCatalogCreationTimes`.

### packages/test-support/session-snapshot/tests/normalize.spec.ts
89-case spec for the pure normalizers: JSON-RPC id sequencing, cwd scrubbing at every boundary (file URI, chained punctuation, `path` fields), every filesystem spelling longest-first, canonical vs native separators, spill-path scrubbing (local, macOS `/private`, snapshot, Windows drive), the "stabilize occupancy without hiding capacity" rule, the purity check on a non-JSON stdout line, every clock the writer owns, packed-row projection and re-packing, the migration/identity ordering, and the idempotence of every scrubber.

### packages/test-support/session-snapshot/tests/manifest.spec.ts
Spec for the manifest parser: an owning scenario, the `sdk-minimal` profile, a retained generation with coverage names, `writesCurrentSessionFixtures` for current vs borrowed vs retained manifests, a read-only session reference, the full composition/recording/header/replay/platform/permission/environment/workspace/input document, and 20 rejected-metadata cases.

### packages/test-support/session-snapshot/tests/identity.spec.ts
Spec for the redaction: feedback versions and target relationships preserved while unrelated prose UUIDs survive, typed relationships preserved across parent and child logs, `commandId`/`rpcId`/`retryId` classified, a readable `requestId` left alone, no trailing newline invented, and a canonical token first seen through a generic id key keeping its number.

### packages/test-support/session-snapshot/tests/storage-policy.spec.ts
Spec for `assertSessionFixtureStorage`: only the **highest** generation of each role is checked; a selected historical child is preserved rather than forced to current storage rules; and an unredacted identity, a `request/header` with no preceding `system/message`, an unscrubbed system prompt, unscrubbed tool schemas, an `UNKNOWN_TOOL` result and a non-canonical macOS cwd token are all rejected by name.

### packages/test-support/session-snapshot/tests/workspace.spec.ts
Spec for the workspace capture: text/binary/link/empty-directory entries in path order, ignored runtime roots and the `.empty` marker, and NUL-bearing UTF-8 treated as binary.

### packages/test-support/session-snapshot/tests/fixtures/fake-acp-agent.ts
The scripted fake ACP agent bin: every behaviour (boot failure, session/new rejection, extra-directory rejection, prompt respond/error/hang-until-cancel, log persistence, permission probe, env echo, workspace echo, stderr note, stray files, a deleted sessions root, late inherited output) comes from a `behavior.json` **beside the fixture**, so a whole subprocess run is scripted from data; it echoes observable facts into `session/update` text chunks for the spec to read off `rawStdout`, and it exits 0 on stdin EOF after writing the scripted logs.

### packages/test-support/session-snapshot/tests/fixtures/dynamic-tool-updates.ts
Loader fixture registering a tool *after* a read and removing it after use, asserting through `llm/stream` that `projectToolUpdates` marks the new declaration `deferLoading: true` until its chronological activation, that the `in-history` mode records a `tool-addition` then a `tool-removal`, and that the `addition-only` mode routes unavailable declarations and their activations away entirely.

### packages/test-support/session-snapshot/tests/fixtures/dynamic-tool-prompt-updates.ts
Loader fixture layering the dynamic-tool fixture with a `systemPrompt.section` that gains guidance after the first read, asserting that the second request's history is a prefix of the first request's and that it carries exactly two system messages.

### packages/test-support/session-snapshot/tests/fixtures/in-history-prompt-update.ts
Loader fixture adding a system-prompt section after the first successful `read`, so the next step renders a changed system prompt — the in-history prompt-update scenario.

### packages/test-support/session-snapshot/tests/fixtures/working-directory-admission.ts
Loader fixture selecting a subdirectory at the first pre-step and asserting that the first admitted request carries the new "Current working directory" runtime-context and no longer the previous one.

### packages/test-support/session-snapshot/tests/fixtures/compaction-working-directory.ts
Loader fixture appending a `working-directory/change` event to `/tmp` on agent creation, giving a fixed POSIX directory context for synthetic compaction recordings.

### packages/test-support/session-snapshot/tests/fixtures/workspace-context-compaction.ts
Loader fixture replacing the visible workspace baseline with a compaction summary after the first read: it appends `compaction/start`, `compaction/summary` (shadowing the baseline seq) and a checkpoint `user/message` with a `replace` surface op, then `compaction/end`.

### packages/test-support/session-snapshot/tests/fixtures/workspace-context-global-failure.ts
Loader fixture that makes the shared `.agents/AGENTS.md` duplicate temporarily unavailable while the harness-home `.dsh/AGENTS.md` changes, then restores observation — user-global instruction reconciliation during a provider metadata outage.

### packages/test-support/session-snapshot/tests/fixtures/parent-agent-preset.ts
Loader fixture selecting the `parent` agent preset on every root Session at creation, before the `agent/created` publication checks.

### packages/test-support/session-snapshot/tests/fixtures/parent-sandbox-override.ts
Loader fixture switching every root session to `read-only` at creation — the UI "Access" switch equivalent — so a continuable background child provably inherits the parent's explicit override as a `source: 'delegation'` event instead of the deployment default.

### packages/test-support/session-snapshot/tests/fixtures/partial-landlock-sandbox.ts
Snapshot-only `SandboxProvider` whose default launch reproduces an older-ABI **partial** Landlock (exit 125 plus an informational line), and whose env-flagged variant points at a missing runner under the valid workspace cwd to exercise runner-failure classification; the comment names the production table it must stay aligned with.

### packages/test-support/session-snapshot/tests/fixtures/ptc-mode-change.ts
Loader fixture changing the session file policy to `read-only` from outside the active tool call, while a nested tool awaits cancellation.

### packages/test-support/session-snapshot/tests/fixtures/child-question-tripwire.ts
Loader fixture that throws on any `user-questions/request`, so a scenario proves a delegated question never reaches the UI answerer.

### packages/test-support/session-snapshot/tests/fixtures/subagent-durability-failure.ts
Loader fixture that remaps an authored placeholder child id to the live child, **fences** the unknown-child persistence stat behind both accepted follow-ups (real async I/O must not reorder the log), forces a fixed durability-checkpoint failure on the child's final continuation turn, and can fail a published child's follow-up and its disposal independently so the parent observes both failures.

### packages/test-support/session-snapshot/tests/fixtures/subagent-settlement-barrier.ts
Loader fixture awaiting `ctx.subagents.waitForChildren` after any subagent tool call, holding the tool response until activation settlement has queued its notice.

### packages/test-support/session-snapshot/tests/fixtures/subagent-send-message-fence.ts
Loader fixture holding the child until the parent's spawn turn ends and then parking the parent until the child's settlement notice has been inserted, so replay scheduling cannot fold settlement into the parent's first turn or start a second parent request in between.

### packages/test-support/session-snapshot/tests/fixtures/subagent-activation-limit.ts
Loader fixture holding child execution until the parent's turn has closed, then updating the subagent Loader entry's config to `maxActiveSubagents: 1` — ordering parent admission and child completion without any elapsed-time assumption.

### packages/test-support/session-snapshot/tests/fixtures/subagent-structured-parent.ts
Loader fixture registering a `subagent_structured` tool with a fixed output schema, sending a correction to the child through `subagents.sendMessage` before the child submits its structured answer, then awaiting the activation result.

### packages/test-support/session-snapshot/tests/fixtures/subagent-result-diagnostic.ts
Loader fixture registering a `SubagentProvider` that returns four fixed product-failure diagnostics (with and without partial output) and then a fifth start whose result **succeeds** while its disposal throws — proving the parent sees the answer and the cleanup failure as two independent facts.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-pin/behavior.json
Behaviour script for the record pin scenario: a respond prompt plus one scripted v3 session log with a system message and an initial request/header carrying tool `t1`.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-pin/input.json
Input script for the record pin scenario: initialize, newSession, prompt.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-pin/session.jsonl
Historical v0 parent fixture of the record pin scenario: a session header with a real (untokenized) cwd plus one request/header.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-pin/session.1.jsonl
Historical v0 fixture of the record pin scenario: a session header plus one request/header.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-pin/session.v3.jsonl
Current-generation parent fixture of the record pin scenario: a v3 header, turn/step events, a system/message and a request/header, with typed tokens and `{{cwd}}`.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-pin/snapshot.yml
Two-line closed manifest (`version: 1`, `profile: acp`) for the record pin scenario.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-pin/stdout.expected.jsonl
Expected stdout of the record pin scenario: four NDJSON frames (initialize result, session/new, one chunk, end_turn).

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-pin/system-prompt.expected.md
Readable system-prompt sidecar holding the literal text `SYS PROMPT`.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-pin/tool-schemas.expected.json
Tool-schema sidecar: one initial schema (`t1`) and no changes.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-child/behavior.json
Behaviour script for the record child scenario: a respond prompt plus two scripted v3 session logs (a parent and a child sharing the same system message id and the same inherited user message).

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-child/input.json
Input script for the record child scenario: initialize, newSession, prompt.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-child/session.jsonl
Historical v0 parent fixture of the record child scenario: a session header plus the initial request/header and the user message.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-child/session.1.jsonl
Historical v0 child fixture: a parent-linked session header with a request/header carrying `{{system}}`/`{{tools}}` and the inherited user message.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-child/session.v3.jsonl
Current-generation parent fixture of the record child scenario: v3 header, turn/step events, a system/message, a request/header and the user message.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-child/session.1.v3.jsonl
Historical v3 child fixture: turn/step events, a system/message, a request/header and the inherited user message, with typed tokens and `{{cwd}}`.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-child/snapshot.yml
Two-line closed manifest for the record child scenario.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-child/stdout.expected.jsonl
Expected stdout of the record child scenario: initialize result, session/new result with `{{sessionId}}`, one agent_message_chunk and the end_turn response.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-child/tool-schemas.1.expected.json
Child tool-schema sidecar: one initial schema (`t1`) and no changes.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-skip/behavior.json
Empty behaviour object for the skip scenario (no prompt, no logs).

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-skip/input.json
Input script for the skip scenario: initialize only.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-skip/replay.override.json
Override sidecar with a single `hang` entry, forcing the replayed model call to stall until cancelled.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-skip/session.jsonl
One-line header-only session fixture for the skip scenario.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-skip/snapshot.yml
Two-line closed manifest for the skip scenario.

### packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-skip/stdout.expected.jsonl
Expected stdout of the skip scenario: only the initialize result frame.

### packages/test-support/session-snapshot/tests/fixtures/suite/pin-turn/behavior.json
Behaviour script for the pin-turn scenario: a scripted v3 log with an initial request/header, an in-history system/message replacement, and two further request headers (a series and a change adding tool `t2`).

### packages/test-support/session-snapshot/tests/fixtures/suite/pin-turn/input.json
Input script for the pin-turn scenario: initialize, newSession, prompt.

### packages/test-support/session-snapshot/tests/fixtures/suite/pin-turn/session.jsonl
Historical v0 pin-turn fixture: a session header, three request/headers (initial, change, series) and a turn/start.

### packages/test-support/session-snapshot/tests/fixtures/suite/pin-turn/session.v2.jsonl
Historical v2 pin-turn fixture: a session header, a turn/start and three request/headers.

### packages/test-support/session-snapshot/tests/fixtures/suite/pin-turn/session.v3.jsonl
Current-generation pin-turn fixture: v3 header, two steps, two system/messages (the second replacing the first), and the three request/headers.

### packages/test-support/session-snapshot/tests/fixtures/suite/pin-turn/snapshot.yml
Two-line closed manifest for the pin-turn scenario.

### packages/test-support/session-snapshot/tests/fixtures/suite/pin-turn/stdout.expected.jsonl
Expected stdout of the pin-turn scenario: initialize, session/new, one chunk, end_turn.

### packages/test-support/session-snapshot/tests/fixtures/suite/pin-turn/system-prompt.expected.md
Readable system-prompt sidecar: the initial `SYS PROMPT` plus a `<!-- system/message change 1 -->` section holding the replacement text.

### packages/test-support/session-snapshot/tests/fixtures/suite/pin-turn/tool-schemas.expected.json
Tool-schema sidecar: the initial schema `t1` and one change adding `t2`.

### packages/test-support/session-snapshot/tests/fixtures/suite/shared-pin/behavior.json
Behaviour script for the shared-pin scenario: a scripted v3 log whose system/message replaces the first one and whose second request/header adds tool `t2`.

### packages/test-support/session-snapshot/tests/fixtures/suite/shared-pin/input.json
Input script for the shared-pin scenario: initialize, newSession, prompt.

### packages/test-support/session-snapshot/tests/fixtures/suite/shared-pin/session.jsonl
Historical v0 shared-pin fixture: a session header, two request/headers and a turn/start.

### packages/test-support/session-snapshot/tests/fixtures/suite/shared-pin/session.v2.jsonl
Historical v2 shared-pin fixture: a session header, a turn/start and two request/headers.

### packages/test-support/session-snapshot/tests/fixtures/suite/shared-pin/session.v3.jsonl
Current-generation shared-pin fixture: v3 header, turn/step events, two system/messages (the second replacing the first) and two request/headers.

### packages/test-support/session-snapshot/tests/fixtures/suite/shared-pin/snapshot.yml
Two-line closed manifest for the shared-pin scenario.

### packages/test-support/session-snapshot/tests/fixtures/suite/shared-pin/stdout.expected.jsonl
Expected stdout of the shared-pin scenario: four frames ending in end_turn.

### packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/behavior.json
Behaviour script for the plain-turn scenario: a respond prompt that echoes the workspace, plus scripted parent and child v3 logs (the child with a distinct system prompt and its own tool).

### packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/input.json
Input script for the plain-turn scenario: initialize, newSession, prompt.

### packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/session.jsonl
Historical v0 parent fixture of the plain-turn scenario with an `assistant/chunk` event.

### packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/session.v2.jsonl
Historical v2 parent fixture: a session header, a turn/start, a request/header, a step/start and an `assistant/attempt` packed row.

### packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/session.v3.jsonl
Current-generation parent fixture: v3 header, turn/step events, a system/message, a request/header and a packed `assistant/attempt` row.

### packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/session.1.jsonl
Historical v0 child fixture: a parent-linked session header plus one request/header.

### packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/session.1.v2.jsonl
Historical v2 child fixture: a session header, a turn/start and one request/header.

### packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/session.1.v3.jsonl
Current-generation child fixture: a v3 parent-linked header, turn/step events, a system/message and a request/header.

### packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/snapshot.yml
Manifest for the plain-turn scenario: `version: 1`, `profile: acp` and `workspace.final: true` (the committed expected tree owns the final world state).

### packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/stdout.expected.jsonl
Expected stdout of the plain-turn scenario: five frames, including the workspace echo chunk listing `seed.txt`.

### packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/system-prompt.1.expected.md
Child system-prompt sidecar: `SYS PROMPT` plus `CHILD GUIDANCE` — the child's distinct prompt.

### packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/tool-schemas.1.expected.json
Child tool-schema sidecar: one initial schema (`child-only`) and no changes.

### packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/workspace/seed.txt
Seeded input workspace file (`seeded`) copied into the generated cwd before the run.

### packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/workspace.expected/seed.txt
Expected committed workspace state: one file `prepared at runtime` — the state the run must leave behind.

### packages/test-support/session-snapshot/tests/fixtures/suite/authored-error/behavior.json
Behaviour script for the authored-error scenario: a prompt that errors, plus a scripted v3 log whose turn/end carries the error reason.

### packages/test-support/session-snapshot/tests/fixtures/suite/authored-error/input.json
Input script for the authored-error scenario: initialize, newSession, promptExpectError.

### packages/test-support/session-snapshot/tests/fixtures/suite/authored-error/replay.override.json
Override sidecar with a zero-chunk `throw` entry carrying message `model exploded` and code `PROVIDER`.

### packages/test-support/session-snapshot/tests/fixtures/suite/authored-error/session.jsonl
Historical v0 authored-error fixture: a session header plus a bare turn/end with an error string.

### packages/test-support/session-snapshot/tests/fixtures/suite/authored-error/session.v2.jsonl
Historical v2 authored-error fixture: a session header, a turn/start and a turn/end carrying the structured error reason.

### packages/test-support/session-snapshot/tests/fixtures/suite/authored-error/snapshot.yml
Two-line closed manifest for the authored-error scenario.

### packages/test-support/session-snapshot/tests/fixtures/suite/authored-error/stdout.expected.jsonl
Expected stdout of the authored-error scenario: initialize, session/new, one chunk, then a JSON-RPC error frame with message `model exploded`.

### packages/test-support/session-snapshot/tests/fixtures/suite/blocked-log/behavior.json
Behaviour script for the blocked-log scenario: an erroring prompt plus a scripted v3 log containing a `hook/result` with decision `block` and a duration.

### packages/test-support/session-snapshot/tests/fixtures/suite/blocked-log/input.json
Input script for the blocked-log scenario: initialize, newSession, promptExpectError.

### packages/test-support/session-snapshot/tests/fixtures/suite/blocked-log/session.jsonl
Historical v0 blocked-log fixture: a session header plus a `hook/result` with decision `block`.

### packages/test-support/session-snapshot/tests/fixtures/suite/blocked-log/session.v2.jsonl
Historical v2 blocked-log fixture: a session header plus a full `hook/result` record (turn, point, handlerId, decision, durationMs).

### packages/test-support/session-snapshot/tests/fixtures/suite/blocked-log/snapshot.yml
Two-line closed manifest for the blocked-log scenario.

### packages/test-support/session-snapshot/tests/fixtures/suite/blocked-log/stdout.expected.jsonl
Expected stdout of the blocked-log scenario: four frames ending in a JSON-RPC error frame, identical in shape to the authored-error golden.

### packages/test-support/session-snapshot/tests/fixtures/suite/no-model/behavior.json
Empty behaviour object for the no-model scenario.

### packages/test-support/session-snapshot/tests/fixtures/suite/no-model/input.json
Input script for the no-model scenario: initialize only.

### packages/test-support/session-snapshot/tests/fixtures/suite/no-model/session.jsonl
One-line header-only session fixture for the no-model scenario.

### packages/test-support/session-snapshot/tests/fixtures/suite/no-model/snapshot.yml
Two-line closed manifest for the no-model scenario.

### packages/test-support/session-snapshot/tests/fixtures/suite/no-model/stdout.expected.jsonl
Expected stdout of the no-model scenario: only the initialize result frame.

### packages/test-support/session-snapshot/README.md
English doc for the keyless snapshot tier: the scenario-table-plus-one-factory-call shape, the closed `snapshot.yml` manifest and the canonical parent/child generation grammar, the record/replay/refresh modes and what each may write, the header-class pinning rule and its sidecars (including `expectedHeaderChanges`/`expectedPromptChanges` and the `<!-- system/message change N -->` sections), the platform/composition variants (`posixOnly`, `pwshOnly`, `workspaceParent`, `workspace.parent: outside-temp`), the writer-oracle rule for retained generations, and "What can go wrong" (a durable wait times out; a fixture guard rejects the committed files; the harvest needs raw JSONL mode; built mode needs current artifacts).

### packages/test-support/session-snapshot/README.zh.md
Chinese mirror; same manifest, pinning and mode rules.

### packages/test-support/session-snapshot/README.i18n.yaml
Per-section en/zh digests for the session-snapshot README (11 sections).

### packages/test-support/session-snapshot/package.json
Manifest: `@agentclientprotocol/sdk`, `cordis-plugin-include`, `dsh-llm-replay`, `dsh-loader-smoke`, `dsh-session-format`, `js-yaml` and `vitest` as runtime deps; peers on cordis, dsh-session and dsh-http-proxy.

### packages/test-support/session-snapshot/tsconfig.json
tsconfig with references to vendor/include, loader-smoke, llm-replay, core/session, session/session-format and util/http-proxy.

---

## Ideas worth stealing

- **A scriptable provider-fault server whose FIFO cursor advances only after the request validates** — `packages/test-support/llm-mock-server/src/index.ts:691` — the cursor moves at `selectBehavior()`, which is reached only after the method/path/API-key/JSON checks at lines 668-689. This is the single mechanism worth copying into August: it lets August script *transport-level* provider failures (socket reset before headers, reset after headers, stall, clean EOF without `[DONE]`, malformed SSE JSON, malformed chunk shape, wrong content type, 429/500/503/401/400, context overflow, quota) against the **real** adapter, and — critically — a misconfigured August client burns its retries without silently advancing the scenario.
- **Reasoning/thinking is a first-class wire behaviour, not a side effect** — `packages/test-support/llm-mock-server/src/index.ts:576` — `reasoning_success` emits a `thinking` content block with `thinking_delta` chunks *before* the text block, so a client that renders reasoning separately, or that counts reasoning tokens, is exercised end to end. August's provider adapters need the same named behaviour, because reasoning shape is where adapters diverge.
- **A thrown stream is detectable from the durable record** — `packages/test-support/llm-replay/src/index.ts:466` — a non-empty assistant stream with no `finish` chunk is the *fingerprint* of a `stream()` that threw. August can use the same fingerprint to classify a recorded run as "the provider failed mid-stream" without any extra marker, and to know that it needs an explicit override rather than a derived script.
- **Replay failure modes live in a sidecar with two shapes** — `packages/test-support/llm-replay/src/index.ts:524` — a bare `ReplayEntry[]` replaces the whole script; `{ patches: [{ at, entry }] }` swaps *named 0-based call indexes* and keeps every derived call, with `at === length` appending. That is exactly the shape August needs for "turn N's provider call 401s, everything else replays as recorded" without re-recording the scenario.
- **A `throw` entry replays its prefix chunks before throwing** — `packages/test-support/llm-replay/src/index.ts:977` — the loop sees the same partial output it saw live, then the recorded error. August's recovery tests currently have to reproduce partial output by hand; this makes the "partial output then failure" path a one-line fixture.
- **A scenario-sidecar placeholder resolved against the live request** — `packages/test-support/llm-replay/src/index.ts:555` — `{{fromRequest:<regex>}}` resolves against every string leaf of the live request, last match wins, first capture group substituted. August's fixtures need this whenever the model must echo back an id the fixture cannot know (a minted session id, a generated goal id, a tool-call id).
- **Turn a silent fixture underrun into a loud teardown diagnostic** — `packages/test-support/llm-replay/src/index.ts:1107` — `assertConsumed()` throws unless every recorded script bound to a live session *and* every bound cursor drained. August's snapshot tier should adopt it: a scenario that silently drove fewer model calls than recorded is currently a green test that proves nothing.
- **Bind recorded scripts to live sessions by first-call order, and say so when it breaks** — `packages/test-support/llm-replay/src/index.ts:1044` with the honest `XXX(concurrent-subagents)` marker at line 848 — "concurrent children need an explicit first-call ordinal". The mechanism is portable (a per-session cursor + a claim order); the *refusal to pretend it is deterministic* is the part to copy.
- **Exactly one scenario per header class pins the request-header and system-prompt sequences** — `packages/test-support/session-snapshot/src/suite.ts:1250` and `:1269` — every live header and system prompt is checked against the composed pin, so a session-dependent composition must declare a **separate class** instead of escaping coverage; a sidecar may only be shared when the complete sequence is identical *and* the two declare the same change count. This is August's missing **prefix-stability / cache-hit** guard, expressed as data rather than as a diff.
- **The prompt and the tool schemas are compared as tokens plus readable sidecars, and field presence is behaviour** — `packages/test-support/session-snapshot/src/normalize.ts:549` and `:565` — the fixture stores `"text":"{{system}}"` and `"tools":"{{tools}}"` while a sidecar keeps the full text and the full schema catalog; an absent `tools` field stays absent and an empty prompt stays empty. August can snapshot its own request prefix this way and still keep a human-readable record of what the prompt actually said.
- **Prompt-before-request is a fixture invariant, not a convention** — `packages/test-support/session-snapshot/src/suite.ts:1192` — `assertSessionFixtureStorage` refuses a `request/header` with no preceding `system/message`, refuses an unscrubbed prompt or tool schemas, and refuses an unredacted identity (the redaction must be a fixed point). This is a cheap static check that catches exactly the "the prompt changed and nothing noticed" class of bug.
- **A relationship-preserving identity redaction that is a fixed point** — `packages/test-support/session-snapshot/src/identity.ts:48` — typed tokens (`{{session:1}}`, `{{message:1}}`, `{{approval:1}}`, `{{workflow:1}}`, `{{command:1}}`, `{{rpc:1}}`, `{{retry:1}}`, `{{id:1}}`) preserve equality across a parent and its children, a canonical token keeps its ordinal, and prose UUIDs are left alone. August's transcript goldens need exactly this: stable *relationships*, not stable *strings*.
- **Reuse the committed volatile values on a refresh** — `packages/test-support/session-snapshot/src/suite.ts:923` (`preserveNormalizedVolatiles`) — a fresh value replaces the committed one only when their *normalised* forms differ; otherwise the committed id/time/path is reused. August's "re-record" flow can therefore refresh the semantic content of a transcript without churning every identifier in it.
- **A "nothing was consumed" guard on a fixture** — `packages/test-support/session-snapshot/tests/storage-policy.spec.ts:49` — the guard is asserted against a *temp copy* of the fixture directory, so the check is proven read-only. August should be able to say the same about its own fixture guards.
- **Wait on durable state, never on presentation output** — `packages/test-support/session-snapshot/src/harness.ts:63` — the input script's wait steps (`waitForTurnStart`, `waitForTurnEnd`, `waitForInboxMessage`, `waitForGoalPhase`, `waitForSubagentTurnEnd`, `waitForTitleAfterTurnEnd`, `waitForEventAfterTurnEnd`) all poll the **persisted log** for a boundary, and a timeout names the session/child *and* the deadline (`:75`). August's cancellation and compaction tests should wait on the durable event, not on a UI frame.
- **A scripted permission kind the agent never offered must fail the run** — `packages/test-support/session-snapshot/src/harness.ts` / `packages/test-support/session-snapshot/tests/harness.spec.ts:1434` — the agent is answered `cancelled` (it must not be able to absorb the scenario bug as an error-means-denial) *and* the run fails, because a callback throw would only reach the agent as a JSON-RPC error response and a tolerant agent would carry on and the scenario would pass.
- **Deterministic ordering by fencing real I/O, not by sleeping** — `packages/test-support/session-snapshot/tests/fixtures/subagent-durability-failure.ts:64` — the unknown-child persistence `stat` is made to await a promise that resolves only after both follow-ups are accepted, so runner speed cannot reorder the transcript. This is the anti-flake pattern August needs for its parallel/subagent work.
- **A stream has exactly one consumer** — `packages/test-support/remote-mock/src/streams.ts:192` — a second concurrent read rejects with `stream has one consumer`. August's SSE/WebSocket layer needs this rule explicitly: a silent second reader is a leak that only shows up as a hang.
- **"Drained" means pulled, and the doc says so** — `packages/test-support/remote-mock/src/remote-mock.ts:60` — `drained(endpoint)` resolves when the consumer has *taken* every pushed item, and the contract states that a consumer processing asynchronously after pulling may still be working on the last one. August's progress indicators need that distinction stated rather than assumed.
- **The mock's log is one global sequence across calls and stream opens** — `packages/test-support/remote-mock/src/log.ts:87` — `requests()` lists the first positional arg of every call and open in seq order and excludes the Gateway's own `$`-prefixed endpoints. A single ordered request log is what makes an August UI test able to assert *ordering*, not just membership.
- **Report unmatched Host calls at teardown, even when teardown itself failed** — `packages/test-support/client-runtime/src/assembly/test-client.ts:344` — the unmatched-request failure and the plugin-tree failure are reported together instead of one masking the other. August's own teardown should never lose the "you forgot to stub an endpoint" signal.
- **Unstubbed calls fail loud and name themselves** — `packages/test-support/client-runtime/src/sessions.ts:104` — `prompt is not stubbed — supply it on the fixture's session face`. August's harness doubles should refuse to half-work.
- **Refcounted environment shims: install only what is absent, remove exactly what you installed** — `packages/test-support/client-runtime/src/assembly/test-client.ts:50` and `:96` — the first holder installs `EventSource`/`ResizeObserver`/`document.fonts` where missing, the last holder removes precisely those, and a pre-existing global is left alone. This is the pattern for August's jsdom/headless environment.
- **Fold a proxy's rejection the way the generated client folds it** — `packages/test-support/client-runtime/src/assembly/remote-proxies.ts:82` — a unary rejection becomes `gateway/internal` (or `gateway/cancelled` once the signal aborted) using the *Gateway client's own* exported helpers, so product code that never awaits a rejection sees none. August's test-only adapters must not introduce a rejection shape production does not have.
- **Read the roster from the real bundles, never from a copy** — `packages/test-support/client-runtime/src/assembly/bundle-roster.ts:10` — the browser roster is composed from the bundles' own patch files with the include plugin's own schema, and **nothing is copied**, so a bundle change is visible at the next import; a patch that matches nothing throws where the launcher only warns.
- **Synthesise a boot graph with placeholder URLs when every module is seeded in process** — `packages/test-support/client-runtime/src/assembly/roster.ts:28` — `graphFromRoster` produces one `application` batch with `plugins/<name>/client.js` placeholders, and the production validator still owns duplicate/empty rejection (`:29`). August can run its whole browser app in a test without a bundler.
- **Snapshot hygiene: fold CSS-module hashes, fingerprint svg internals, work on a clone** — `packages/test-support/client-runtime/src/snapshot.ts:64` — the serializer normalises a *clone* so the live DOM keeps its class and tag queries, and the svg fingerprint still flips when the artwork actually changes.
- **Pin the browser language instead of inheriting the runner's** — `packages/test-support/client-runtime/src/locale-env.ts:17` — a spec asserting localized copy states the browser it assumes (`navigator.languages`/`navigator.language`), and the environment's own accessors are restored afterwards.
- **A whole subprocess run scripted from a data file** — `packages/test-support/session-snapshot/tests/fixtures/fake-acp-agent.ts:39` — every behaviour (boot failure, session rejection, prompt respond/error/hang, log persistence, permission probe, env echo, stray files, a deleted sessions root) comes from a `behavior.json` beside the fixture. August can script an entire agent subprocess run from data instead of from a stubbed server.
- **Choose the launch artifact by mode, and fail loud on an unknown mode** — `packages/test-support/loader-smoke/src/index.ts:44` — `DSH_EXAMPLE_MODE` selects `src` (tsx + `TSX_TSCONFIG_PATH`, zero-build) or `lib` (plain Node, real `exports`); anything else throws, because "a typo in a gate's env fails loud". The same env-switch pattern lets August run one smoke against both the dev path and the shipped path.
- **The observation window starts at the durable inbox receipt** — `packages/test-support/loader-smoke/src/agent-turn.ts:80` — the listener ignores every event until the `agent/inbox/spliced` carrying the message id arrives, and the count of root agents is re-checked *after* the publication wait. August's turn-level assertions should start at the durable boundary too.
- **Exercising mid-conversation tool additions with two projection modes** — `packages/test-support/session-snapshot/tests/fixtures/dynamic-tool-updates.ts:37` — `projectToolUpdates(messages, tools, mode, history)` is called with both `in-history` and `addition-only`, and the fixture asserts that a new declaration is `deferLoading: true` until its chronological activation and that `addition-only` routes unavailable declarations away. This is the reference for how August should assert a tool added mid-turn.
- **Model-specific `systemPromptUpdate` / `toolUpdate` capabilities are declared and validated at load** — `packages/test-support/llm-replay/src/index.ts:1174` — a replay route declares `systemPromptUpdate: 'in-history'` and `toolUpdate: 'in-history' | 'addition-only'`, and an invalid value fails at load time, so a keyless scenario can exercise a capability-gated prompt update.
- **Occupancy is normalised but capacity is not** — `packages/test-support/session-snapshot/src/normalize.ts:229` — a `usage_update` frame's `used` becomes `{{usedTokens}}` while `size` (the model's window) is kept. Context-pressure assertions should hide the noisy number and keep the denominator.

---

## Files skipped (with reasons)

None. All 213 files in this shard are text sources, docs, configs or small data fixtures; every one was opened and read. There are no generated bundles, vendored trees, binaries or huge data files in `packages/test-support/`.

---

## Uncertainties

- **Read-tool truncation on long files.** The `read` tool prunes the middle of outputs beyond roughly 200 lines. Every file in the shard was opened, and for the ~20 largest files I closed the gaps by reading the truncated ranges again in smaller windows and by taking a structural index (`grep` over every `export`/`function`/`describe`/`it`) so no mechanism was missed. The files where I did **not** read every single line are: `session-snapshot/src/suite.ts` (1760 lines — I read 1-900 and 900-1760, re-read 262-376 and 1226-1340, and indexed all 38 exports and all 8 guard tests), `session-snapshot/tests/suite.spec.ts` (1618 — read in two passes, re-read 820-900, indexed all 115 test cases), `session-snapshot/tests/harness.spec.ts` (1446 — read in two passes, indexed all 56 cases), `session-snapshot/tests/normalize.spec.ts` (1323 — read in two passes, indexed all 89 cases), `session-snapshot/src/harness.ts` (838 — head, tail, and the export/wait-step index), `session-snapshot/src/launcher.ts` (465 — head, tail, export index), `session-snapshot/src/manifest.ts` (432 — head, tail, export index), `session-snapshot/src/session-files.ts` (253 — head, tail, export index), `client-runtime/src/sessions.ts` (836 — head, 85-199, tail; the middle 200-812 was indexed only by its exports), `client-runtime/src/index.ts` (486 — head, 65-179, tail), `client-runtime/src/assembly/test-client.ts` (366 — head, 95-209, tail), `client-runtime/tests/runtime.client.spec.tsx` (942 — read in two passes, indexed all 48 cases), `remote-mock/src/remote-mock.ts` (413 — read 1-314 and the tail), `remote-mock/src/streams.ts` (339 — read 1-206 and the tail), `llm-replay/tests/llm-replay.spec.ts` (2344 — read in three passes; the truncated middles were **not** re-read), `loader-smoke/src/index.ts` (259 — head and tail), and the mid-sections of `client-runtime/tests/helpers.client.spec.tsx`, `client-runtime/tests/assembly-test-client.client.spec.ts`, `client-runtime/tests/assembly-bundle-roster.client.spec.ts`, `remote-mock/tests/proxy.client.spec.ts`, `remote-mock/tests/streams.client.spec.ts`, `loader-smoke/tests/agent-turn.spec.ts`.
- **What I checked to compensate:** for each of the above I ran a `grep` over the file for `export function|export const|export class|export interface|export type|describe(|it(|test(` and read the resulting index, so the *set* of mechanisms and the *set* of asserted behaviours in each file is accounted for; what I may have missed is the exact prose of individual assertions in the un-read windows.
- **The Chinese README mirrors.** Each package ships `README.md` + `README.zh.md` + a `README.i18n.yaml` holding a per-heading en/zh digest. I read the English README of every package in full (their middles were re-read after truncation) and the Chinese mirrors in full except for `client-runtime/README.zh.md` (I read the English original in full and the Chinese mirror's head and tail), whose content I therefore know only through the English original plus the digest file's structure. The i18n digest files themselves record that the two sides are hash-pinned to each other, so a content difference between them would fail the repo's own `verify-translation-pairing` gate.
- **Lens coverage gap — memory/learning.** This shard contains **no** memory or learning mechanism: no durable fact store, no skill distiller, no BM25 recall. The only adjacent material is the session-log *identity* redaction (`session-snapshot/src/identity.ts`) and the session-snapshot *catalog* clock reconciliation — both about transcripts, not about learning. Any August memory design must be sourced from a different shard.
- **Lens coverage gap — the agent loop itself.** The loop's *runtime* is not in this shard; only the test-side harness for it is (`agent-loop-testkit`). The prompt-caching/prefix-stability material here is the *guard* (the header-class pin), not the cache itself.
- **A mechanism I could not fully attribute.** `session-snapshot/src/suite.ts` exports `scenarioSkipped`, `stdoutExpectedVariants`, `headerChangeCount`, `systemPromptPrecedesRequests`, `assertUniqueSnapshotContents`, `unknownToolCallIds`, `stabilizeFixtureMessageIds`, `refreshFixtureReplacements`, `reconcileCatalogCreationTimes` and `stabilizeRefreshLog`; I read their signatures, their doc comments and their test coverage, but the bodies of `stabilizeFixtureMessageIds`, `refreshFixtureReplacements`, `reconcileCatalogCreationTimes` and `stabilizeRefreshLog` were only partially read (their helper `preserveNormalizedVolatiles` and `preservePackedMemberTimes` were read in full), so the exact merge rule for a "fingerprint connected to an id that also identifies different content" is inferred from the test names rather than read from the code.
- **Where the shard points outside itself.** `packages/test-support/session-snapshot` depends on `dsh-session-format-catalog`, `dsh-session-format`, `dsh-compaction`, `dsh-subagent`, `dsh-sandbox-policy` and `dsh-http-proxy`; `client-runtime` depends on the whole client stack; `llm-replay` depends on `dsh-session`'s format catalog. The *mechanisms* those packages hold (the loop, the prompt registry, the tool registry, compaction, the subagent manager, the sandbox policy) are **not** in this shard and must be read there.
