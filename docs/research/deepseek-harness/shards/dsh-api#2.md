# deepseek-harness / dsh-api#2

## Shard shape

This shard holds the **process boundary** of the DeepSeek Harness: how a runtime is driven from outside, and how a browser is driven from inside.

- `packages/sdk/**` (44 files) is the **out-of-process SDK**. `sdk/protocol` owns one newline-delimited JSON-RPC 2.0 transport and the named request/notification vocabulary (7 requests, 4 notifications). `sdk/server` is the Cordis plugin that *serves* that protocol over the runtime's stdio: it creates one Agent per `sessionId`, queues prompts, and streams every durable session event, agent status transition and subagent completion back to the client. `sdk/client` is the TypeScript mirror of the Python SDK: it spawns `dsh --profile sdk` as a subprocess, speaks the wire, owns the notification fan-out, and tears the child down through an EOF → SIGTERM → SIGKILL ladder.
- `packages/api/**` (103 files) is the **Typert Remote** surface the web GUI talks to. `api/terminal-controller` owns Session-scoped PTYs (host side + browser side: screen recovery, input acknowledgement, idle reclamation, localStorage-persisted tab identities and close intents). `api/workspace-controller` owns the Workspace registry projection (Host commands, a reconnect-safe baseline+increment feed, an access-filtered `replace` frame, and a Client model that resolves unary-echo vs stream races). `api/workspace-files` owns bounded file reads, workspace-scoped directory listing, and a target-scoped filesystem change feed, plus the browser `file` resource provider. `api/settings-controller` owns redacted settings reads/writes and the one-way credential namespace.

The two halves are complementary: the SDK side is *one client talking to one runtime over stdio*; the API side is *many browser surfaces talking to a live runtime over a generated Remote*. Both are strict about the same thing — **the wire boundary is where a malformed peer is caught**, and both keep the model out of the loop (`Model Experience: None` in every README of this shard).

---

## Per-file notes

### packages/sdk/protocol/src/transport.ts
- **Purpose:** the one wire transport: newline-delimited JSON-RPC 2.0 over caller-owned byte streams.
- **Key abstractions:** `JsonRpcLineTransport` (implements `JsonRpcTransportPeer`), `JsonRpcResponseError` (preserves wire `code` + optional `data`).
- **Data flow:** `request()` writes `{jsonrpc,id,method,params}` and parks a `PendingRequest`; `onData` appends to a buffer, `drainLines` splits on `\n`; a frame with `id`+`method` is a request, `id` alone a response, `method` alone a notification.
- **Non-obvious design decisions:** a malformed line is *ignored* (`handleLine` catches only JSON syntax errors, transport.ts:201-208) rather than killing the connection; `params` that are not plain objects collapse to `{}` (transport.ts:272-274) so a handler never sees an array.
- **Edge cases / failure handling:** missing handler → `-32601`, handler throw → `-32603` (transport.ts:226-238); `close()`, input `error` and input `end` all fail pending requests (transport.ts:87-92, 191-199); `StringDecoder` keeps multibyte UTF-8 split across chunks intact.
- **Surprising:** `request()` accepts an `AbortSignal`; aborting **deletes the pending entry** so a response that may never come retains no state (transport.ts:129-137) — an abandonment, not a cancellation.

### packages/sdk/protocol/src/types.ts
- **Purpose:** the named wire vocabulary both ends speak.
- **Key abstractions:** `HarnessSdkRequestMap` / `HarnessSdkNotificationMap` index payloads by method name; `SdkRunStatus = 'ok' | 'error'`.
- **Data flow:** pure type declarations; `serverInfo.name` is frozen at `deepseek-harness-sdk-runtime`.
- **Non-obvious design decisions:** `InitializeParams.reasoningEffort` is *adapter-owned* and optional — omission preserves the model's own default (types.ts:24).
- **Edge cases / failure handling:** `SubagentFinishedNotification.lastAssistantMessage` is optional, and "absent" is distinct from "empty" (types.ts:133).
- **Surprising:** `SessionEventNotification` carries **every** session in the runtime, unfiltered — scoping is the client's job (types.ts:94-100).

### packages/sdk/protocol/src/index.ts
One-line re-export barrel: exports `JsonRpcLineTransport`, `JsonRpcResponseError`, `JsonRpcTransportPeer` and all wire types; the package root is the only import surface (no deep imports).

### packages/sdk/protocol/package.json
Package manifest for `@deepseek-ai/dsh-sdk-protocol` v0.2.1-rc.2: `main: lib/index.js`, `types: lib/types/index.d.ts`, peer deps on `dsh-llm`/`dsh-session`/`dsh-subagent`/`cordis`.

### packages/sdk/protocol/tsconfig.json
TypeScript project referencing `vendor/cosmokit`, `vendor/cordis`, `llm/llm`, `core/session`, `subagent/subagent`; emits declarations to `lib/types`.

### packages/sdk/protocol/README.md
The wire contract in prose: framing rules, the 7×4 method table, payload semantics ("`SessionPromptResult.messageId` identifies the queued user message; it does not identify a later assistant message, turn ending, or prompt result"), and the limits (no version negotiation, no cancel, server→client requests are a dead capability).

### packages/sdk/protocol/README.zh.md
Faithful Chinese translation of `README.md` (same section skeleton, same method table); read in full to confirm it adds no new contract.

### packages/sdk/protocol/README.i18n.yaml
Bilingual-pairing hash record: one 16-hex digest per heading section for the English and Chinese README, regenerated by `pnpm run verify-translation-pairing --write`.

### packages/sdk/protocol/tests/transport.spec.ts
307-line suite over the transport: bidirectional requests/notifications, wire error codes, pre-aborted signal (asserts `pending.size === 0`), abandonment removing the pending entry, structured `error.data` preservation, non-Error throw stringification, method-not-found, non-object params normalisation, malformed-frame tolerance, split multibyte UTF-8, `flush()` ordering via an empty barrier write, and pending rejection on input end/error and transport close.

### packages/sdk/client/src/client.ts
- **Purpose:** the low-level JSON-RPC client that owns the runtime subprocess.
- **Key abstractions:** `HarnessClient`, `NotificationSubscription`/`NotificationSubscriptionImpl` (queue + waiters + filter), `TransportClosedError` / `RequestTimeoutError` / `SdkProtocolError`.
- **Data flow:** `start()` spawns the child, wires `JsonRpcLineTransport` over its stdio, accumulates a bounded stderr tail (400 lines) and settles `streamsSettled` when both stderr and exit have landed; `dispatchNotification` fans every notification out to the subscription set.
- **Non-obvious design decisions:** a subscription's *filter* is containment-scoped — a throwing filter fails only that subscription and never the transport's read loop (client.ts:151-163); `close()` drops the queue while a runtime death keeps it drainable (client.ts:126-132); the handshake `cwd` is resolved to an absolute path *before* the child spawns, so a relative value cannot double-resolve (api.ts:38-41).
- **Edge cases / failure handling:** a dead runtime short-circuits with exit code + stderr tail instead of writing into a destroyed pipe (client.ts:349-352); a timed-out request is an **abandonment** (the transport drops the pending entry) while the server-side work still runs to close (client.ts:359-366).
- **Surprising:** `subscribeSessionTree` reconstructs descendant lineage client-side from `subagent.started` edges, with a `visited` set so a cycle cannot hang the walk (client.ts:462-475).

### packages/sdk/client/src/api.ts
- **Purpose:** the high-level run API — `DeepSeekHarness` owns one runtime; `HarnessSession.run` owns one *activity interval*.
- **Key abstractions:** `DeepSeekHarness` (memoized handshake, `AsyncDisposable`), `HarnessSession`, `RunResult { sessionId, finalResponse, events, notifications }`, `validatedSessionEvent`.
- **Data flow:** `run()` subscribes to the session tree, prompts, then **waits for the durable `agent/inbox/spliced` receipt carrying its own messageId** before collecting, and stops at the next whole-agent `idle`.
- **Non-obvious design decisions:** `finalResponse` is "the last committed assistant message in the interval", explicitly *not* a response causally assigned to the prompt, because steering and injected context may contribute before idle (api.ts:335-345, README.md:52); the wire envelope is validated at the boundary so a malformed runtime surfaces as `SdkProtocolError` rather than a `TypeError` inside `finalResponse` (api.ts:214-225, 299-321).
- **Edge cases / failure handling:** a failed handshake whose cleanup succeeded installs a *fresh* client so a later call retries with a new process; if cleanup also failed it throws an ordered `AggregateError` and **retains** the failed client rather than spawning beside a process whose exit was not proved (api.ts:80-92).
- **Surprising:** `start()` is memoized but resets `this.initialized = undefined` on failure, so the retry is a genuinely new handshake.

### packages/sdk/client/src/launch.ts
- **Purpose:** resolve the public launch options to one `dsh` subprocess.
- **Key abstractions:** `RuntimeProcessOptions` (command/args/cwd/environment/description/timeouts), `DshNodeLaunch`.
- **Data flow:** `resolveDshLaunch` builds `process.execPath` + `[...nodeArgs, '--profile', profile, ...patches.flatMap(p => ['--patch', p])]`, and an `environment()` closure that reads the parent env *at spawn time*.
- **Non-obvious design decisions:** the client refuses to run against a different `dsh` version — `resolveDshBinFromManifests` throws unless the dsh manifest version equals the client manifest version (launch.ts:55-66); a source checkout is launched through an absolute `tsx/esm` loader plus a `TSX_TSCONFIG_PATH`, and a *partial* source launch (any of the three required files missing) fails loud rather than half-working (launch.ts:96-108).
- **Edge cases / failure handling:** every caller-relative path (bin, patches, home, cwd) is resolved against the caller cwd before spawn (launch.ts:128-156).
- **Surprising:** `installedDshBin()` returns the path *whether or not it exists* — existence is the caller's problem, not a throw.

### packages/sdk/client/src/dispose.ts
- **Purpose:** the private teardown ladder for the runtime child.
- **Key abstractions:** `disposeRuntimeProcess(child, { disposeEofGraceMs, disposeGraceMs }, platform)`.
- **Data flow:** stdin EOF → wait → (POSIX) SIGTERM → wait → SIGKILL → await an actual exit edge.
- **Non-obvious design decisions:** the platform is an injectable parameter so the Windows behaviour (which skips SIGTERM because Node maps both signals to `TerminateProcess`) is unit-testable (dispose.ts:93-96).
- **Edge cases / failure handling:** timers are `.unref()`'d so a pending grace never keeps the parent's loop alive; the exit listener is removed on timeout and the timer cleared on exit, so listeners never accumulate (dispose.ts:18-32); a refused SIGKILL is distinguished from an accepted one in the error message (dispose.ts:55-60).
- **Surprising:** `dispose` **resolves only after the process has actually exited** — quiescence, not a request.

### packages/sdk/client/src/types.ts
Type-only module: `HarnessNotification`, `NotificationFilter`, `HarnessClientOptions` (all timeouts and their defaults spelled out in prose), `DeepSeekHarnessOptions`, and `RunResult`; re-exports `ContentBlock`/`SdkPromptContentBlock` so callers need no extra import.

### packages/sdk/client/src/index.ts
One-line re-export barrel: `DeepSeekHarness`, `HarnessSession`, `validatedSessionEvent`, the four error classes, `NotificationSubscription` and the caller-facing types.

### packages/sdk/client/tests/fake-runtime.ts
- **Purpose:** a scripted stand-in for the runtime — no model, no network, no harness imports.
- **Key abstractions:** ~40 `FAKE_*` env-var switches, each documented in the header block.
- **Data flow:** speaks the same newline-delimited JSON-RPC on stdio; answers `initialize`, `session/prompt` (emitting `agent/inbox/spliced` → `session.status running` → assistant → `turn/end` → `session.status idle` → the response), `session/wait`, `session/resume`, working-directory get/set and `shutdown`.
- **Non-obvious design decisions:** the switches exist to make *specific races* deterministic: `FAKE_INIT_ERROR_ONCE_FILE` (fail the handshake only when a marker file is absent, so a respawned runtime succeeds), `FAKE_INIT_READY`+`FAKE_INIT_GO` (a deterministic cancel-during-handshake window), `FAKE_STREAM_THEN_MALFORMED` (same-pipe ordering proves the partial output arrives before the protocol failure), `FAKE_IGNORE_EOF`+`FAKE_SIGTERM_FILE`+`FAKE_TRAP_SIGTERM` (ladder rungs).
- **Edge cases / failure handling:** `FAKE_MALFORMED_REASON` covers five malformed `turn/end` shapes; `FAKE_EXIT_DURING_PROMPT` exits 17 mid-turn; `FAKE_STDERR_NO_NEWLINE` exercises the stderr-buffer flush.
- **Surprising:** `FAKE_EMPTY_MESSAGE` models a *max-tokens* step that assembled no output blocks but still recorded usage.

### packages/sdk/client/tests/sdk-client.spec.ts
767 lines over the real subprocess: resume, per-session working directories, "ignores notifications that precede the submitted message receipt", Auto-review denial details preserved in native and PTC tool events, the exact handshake payload sent once, the relative-cwd double-resolve guard, the `AggregateError` on double failure, "retries a failed handshake with a fresh runtime process", timeout messages carrying the stderr tail, a timed-out request leaving `pending.size === 0`, subscriptions born failed after termination, multi-hop session-tree scoping, wire-payload validation, and the bounded stderr tail.

### packages/sdk/client/tests/dispose.spec.ts
Deterministic ladder coverage against a scriptable `FakeChild`: tier 1 cooperative EOF, tier 2 SIGTERM, tier 3 SIGKILL, "resolves only after the exit", listener-count assertions (no accumulation), Windows skipping the SIGTERM tier, and both "refused" and "accepted" SIGKILL bounds.

### packages/sdk/client/tests/launch.spec.ts
Public launch resolution: same-version dsh discovery, every filesystem input made absolute and patch order preserved, source fallback through an absolute tsx loader, loud failure when the source launch is incomplete, env read at spawn time, and the version-mismatch rejection.

### packages/sdk/client/tests/cot-translation-projection.spec.ts
- **Purpose:** proves a *plugin audit record* survives the SDK projection without displacing the main answer.
- **Key abstractions:** `appendPluginRecord(session, 'plugin:translator/request' | 'plugin:translator/result', data)`.
- **Data flow:** records the translator's request/result into a real `SessionStore`, then replays them through a fake runtime and asserts the SDK's `events`/`notifications` carry them.
- **Non-obvious design decisions:** the audit events carry `ignorable: true` and the projection asserts they have **no** `surfaceOp`/`sourceEventSeqs` — they are audit, not surface (spec.ts:73-76).
- **Edge cases / failure handling:** the expected JSON is a checked-in golden file (`tests/expected/cot-translation-projection.json`).
- **Surprising:** the translator's *own* `modelRequest` (provider, model, `reasoningEffort: 'off'`, `maxTokens`, the system prompt, the messages) is captured verbatim in the audit trail — a sub-model's full request is auditable.

### packages/sdk/client/tests/expected/cot-translation-projection.json
The golden projection: `finalResponse: "MAIN_RESPONSE"`, two audit events (request with the full `modelRequest` payload, result with `requestSeq`), the two audit notifications, and the assistant texts. Read in full.

### packages/sdk/client/README.md
The client contract in prose, including the two paragraphs that matter most for a harness: the run's interval is receipt-to-idle (not prompt-to-answer), and `finalResponse` is "not a response causally assigned to the prompt, because steering, injected context, and other queued work may contribute before idle"; plus the four typed error classes and the close ladder.

### packages/sdk/client/README.zh.md
Chinese translation of `client/README.md`; read the first 60 lines — it mirrors the English section for section, including the receipt-to-idle interval sentence.

### packages/sdk/client/README.i18n.yaml
Per-section EN/ZH content digests for the client README (25 sections), regenerated by the translation-pairing script.

### packages/sdk/client/package.json
Manifest for `@deepseek-ai/dsh-sdk-client`: depends on the same-version `@deepseek-ai/dsh` (workspace `*`), peers on `dsh-llm`/`dsh-sdk-protocol`/`dsh-session`/`cordis`, dev-dep on `dsh-experimental-translator`.

### packages/sdk/client/tsconfig.json
TypeScript project for the client package: `rootDir: src`, `outDir: lib/types`, referencing cordis, llm, session and the protocol package.

### packages/sdk/server/src/server.ts
- **Purpose:** the protocol methods and notification subscriptions of the JSON-RPC server.
- **Key abstractions:** `HarnessSdkJsonRpcServer`, `SessionRecord { handle, failure }`, `HarnessSdkJsonRpcServerOptions { maxTokensAsSuccess }`.
- **Data flow:** the constructor subscribes to `session/event`, `agent/error`, `agent/status`, `session/created` and `subagent/end`; `prompt()` resolves or creates the Agent, admits encoded images into the durable attachment store, and calls `agent.followup(message)`, returning the message id.
- **Non-obvious design decisions:** the **route is resolved and validated during `initialize`** (`llm.resolveCallConfig`) so a missing adapter, unavailable model or unsupported effort cannot fall back to constructor defaults, and `session/prompt` rejects until that handshake succeeds (server.ts:155-189, 197); a failure is associated with *that exact session* until a later committed `turn/end` accounts for it, so a wait can reject with a failure that happened before the wait (server.ts:103-116); subagent locality is decided **only** by the service-snapshotted `local` flag — provider names, child ids and durable lineage never establish it (server.ts:129-147).
- **Edge cases / failure handling:** `assertLiveAgent` re-checks the registry after the async image admission, because an agent-loop reload can dispose the retained handle (server.ts:200-206, 259-263); `shutdown` drains descendants child-first before releasing root handles and aggregates multiple teardown failures into one `AggregateError` (server.ts:303-333).
- **Surprising:** `session/wait` waits for the root to be idle *and* for `subagents.waitForChildren` to report no children *and* for the session seq to be unchanged across the check — otherwise it loops (server.ts:240-257).

### packages/sdk/server/src/index.ts
- **Purpose:** the Cordis plugin entry that serves the protocol over stdio.
- **Key abstractions:** `Config` (schemastery), `JsonRpcConfig { maxTokensAsSuccess, input?, output?, exit? }`, `apply(ctx, config)`.
- **Data flow:** `apply` builds the `JsonRpcLineTransport` over `process.stdin/stdout` (overridable for tests), registers the request handler, and owns a **shared exit task** so racing `shutdown` requests cannot dispose the root or exit twice.
- **Non-obvious design decisions:** **`initialize` is the SDK's readiness boundary** — it awaits `ctx.get('loader')?.await()` so async sibling Loader entries (e.g. an MCP client's initial tool discovery) are settled before the runtime is advertised ready (index.ts:83-85); stdout is reserved for protocol frames, so the tree must not load a stdout logger.
- **Edge cases / failure handling:** the `shutdown` response is written *before* the dispose/exit task runs (`setImmediate`), and the exit task flushes the transport, disposes the root fiber, then exits 0.
- **Surprising:** unloading only this plugin stops serving *without* exiting the process (the effect disposer calls `server.shutdown()` + `transport.close()`).

### packages/sdk/server/tests/server.spec.ts
1317 lines over the real server: `session/wait` including a child-triggered root turn, working-directory changes that reach the model as replayable user context, a real OpenAI-compatible completion server (asserting `output_config.effort`, `max_tokens`, and the `x-api-key` header), overlapping prompts for one session, inline image admission (and its two failure modes), the disposed-agent recheck, whole-agent status forwarding, `subagent.started` lineage, and a long series of subagent-locality cases (remote id colliding with a local child, continuation runs on one live child, reused local ids correlating by parent scope, provider re-registration, and the "start was missed" fallback).

### packages/sdk/server/tests/plugin-apply.spec.ts
380 lines mounting the real namespace plugin with in-memory stdio: the initialize handshake, waiting for a delayed Loader entry's adapter registration before answering initialize, an end-to-end prompt turn against a mock completion server, a racing double `shutdown` that must answer both, flush and dispose, and exit exactly once, and a bare fiber dispose (HMR-style unload) that stops serving without calling exit.

### packages/sdk/server/tests/resume.spec.ts
204 lines of persisted-session resume: restoring a non-main identity (history preserved, origin preserved, no model call, no notifications for historical events), repairing an interrupted final turn (a hand-written `turn/start`+`step/start` tail becomes `turn/end {kind:'interrupted'}`), rejecting missing history, sharing pending restoration with a prompt, waiting for pending restoration during shutdown, refusing without a persistence backend, and wire-identity validation.

### packages/sdk/server/tests/wait.spec.ts
217 lines of `session/wait` semantics: a parked child at depth 1 and 2 (interrupted, with unclaimed steering) does not block the wait; a descendant failure stays separate from the root outcome; and a `turn/start`/`turn/end` failure *before* or *during* the wait rejects it, while a later successful turn clears the failure.

### packages/sdk/server/tests/shutdown.spec.ts
141 lines: shutdown releases managed descendants at depth 1 and 2 while preserving an unrelated tree, and disposes roots *after* a descendant drain fails (aggregating both failures) — the disposal order is asserted exactly.

### packages/sdk/server/tests/plugin-shape.spec.ts
22 lines: the plugin's export shape must survive `Loader.unwrapExports` — no stray `default`, and `name`/`inject`/`Config`/`apply` must all survive.

### packages/sdk/server/tests/built-scope-carrier.e2e.ts
114 lines: a *built-artifact* guard that runs the real `lib/index.js` bundles in a plain Node subprocess, because the scope-carrier registry is module-local and source-mode tests cannot see an accidentally inlined second registry. Asserts the `subagent.finished` notification keeps the delegating parent and omits `lastAssistantMessage` rather than sending `[]`.

### packages/sdk/server/tests/messages-response.ts
11 lines: the shared Anthropic-style SSE fixture (`message_start` … `message_stop`) used by the transport fixtures.

### packages/sdk/server/README.md
The serving contract: wiring, the `maxTokensAsSuccess` config, "stdout is the protocol", what SDK clients can do, and the shutdown/exit ownership split (the plugin owns protocol `shutdown`; the app bin owns EOF and signals). States the KV-cache effect: "Append-only; newly visible content follows the reusable request prefix".

### packages/sdk/server/README.zh.md
Chinese translation of `server/README.md`; read the first 60 lines — same wiring/config/stdout sections.

### packages/sdk/server/README.i18n.yaml
Per-section EN/ZH digests for the server README (37 sections).

### packages/sdk/server/package.json
Manifest for `@deepseek-ai/dsh-sdk-jsonrpc-server`; peers on `dsh-agent`, `dsh-attachment`, `dsh-llm`, `dsh-scope`, `dsh-session`, `dsh-subagent`, `dsh-working-directory`; exports `./src/*` for the built-artifact guard.

### packages/sdk/server/tsconfig.json
TypeScript project for the server: emits `lib/types`, references cordis, schemastery, llm, llm-deepseek-api-key, agent, attachment, session, the protocol package, subagent and working-directory.

### packages/sdk/README.md
The SDK package map: protocol / client / server, with links to the Python SDK twin, the sdk-app bundle and the architecture decision.

### packages/sdk/README.zh.md
Chinese translation of the SDK package map; read in full (49 lines) — same three-package table.

### packages/sdk/README.i18n.yaml
Per-section EN/ZH digests for the SDK group README (6 sections).

### packages/api/terminal-controller/src/index.ts
- **Purpose:** the Host owner of Session-scoped user terminals, exposed as the `terminal` Remote namespace.
- **Key abstractions:** `TerminalController extends TypertRemoteService`, `Config` (schemastery), `OwnedSession { lifetime, closedIds, terminals, pending, allocations }`.
- **Data flow:** `create()` validates the id and dimensions, dedupes concurrent creates through `owner.pending`, enforces `maxTerminals` across *terminals + pending + allocations*, spawns via `subprocess.spawnTerminal` with `TERM=xterm-256color` and `DSH_SESSION_ID` in the env, then installs the terminal's retention monitor.
- **Non-obvious design decisions:** the terminal identity is **closed, not deleted** — `closedIds` refuses a later or repeated create for that id forever, and `close()` waits for a still-pending allocation so it owns the process even if the create then rejects (index.ts:240-256, 294-296); user terminals run with the execution environment's **system-user permissions**, independent of the Agent's sandbox mode and approval policy (index.ts:303-311, README.md:30); `environment()` reads the directory and limits *without* filesystem validation or shell resolution, so reattaching to an existing process still works when the default shell has disappeared.
- **Edge cases / failure handling:** a failed allocation keeps its `TerminalRetention` in `allocations` so cleanup can be retried explicitly; `disposeOwner` collects every failure into one `AggregateError`; the `requireOpen`/`requireCapability` guards produce typed `RemoteError` codes (`terminal/unavailable`, `terminal/limit-reached`).
- **Surprising:** `list(sessionId)` needs no Agent and no sandbox resolution — viewing an offline Session neither activates an Agent nor produces a recovery error.

### packages/api/terminal-controller/src/terminal.ts
- **Purpose:** one PTY, a bounded headless-xterm emulator, and its detachable browser followers.
- **Key abstractions:** `BrowserTerminal`, `TerminalFollower` (from `stream.ts`), `TerminalRetention` (from `retention.ts`).
- **Data flow:** `consume()` decodes the provider's output stream with a streaming `TextDecoder` and feeds `screen.write`; every screen write is serialized through `enqueue()` so the snapshot and the output frames share one ordered queue.
- **Non-obvious design decisions:** the **latest attachment owns input and resize**; detaching releases input control *without* killing the process (terminal.ts:82-111, 197-200); the provider's completion precedes output drainage, so input is refused with `not-running` while the final output still drains (terminal.ts:212-229).
- **Edge cases / failure handling:** the input sequence must be consecutive — a gap throws "Terminal input sequence has a gap" (terminal.ts:119); an input command over `maxInputBytes` is refused *before* it reaches the provider; `closeProcess` resets `this.closing` on failure so a close can be retried.
- **Surprising:** `enqueue()` chains operations so a failed operation does not break the chain ("the caller owns this operation's failure; later cleanup must still run") — one failed write cannot wedge the terminal (terminal.ts:206-210).

### packages/api/terminal-controller/src/retention.ts
- **Purpose:** window holds and conservative idle reclamation for one terminal owner.
- **Key abstractions:** `TerminalRetention`, `TerminalRetentionPolicy { unattendedTimeoutMs, activityPollIntervalMs, cleanupRetryMs }`.
- **Data flow:** `retain(signal)` registers a holder, yields `{type:'retained'}` and holds the stream open; `observe()` polls `inspectActivity()` and, on a confirmed idle state, starts the grace clock.
- **Non-obvious design decisions:** **only positively confirmed idle time counts** — `busy` or `unknown` activity clears the deadline, and an observation gap longer than twice the polling interval resets the evidence (retention.ts:113-130); the clock is `performance.now()` (monotonic), not wall time; a failed cleanup keeps the identity closed and schedules exactly one retry *without* granting a fresh idle grace (retention.ts:71-83).
- **Edge cases / failure handling:** the `epoch` counter invalidates an in-flight observation when a holder connects or the caller writes input, so a stale "idle" cannot close a busy terminal; `dispose()` awaits both the observation and the final cleanup.
- **Surprising:** `schedule()` caps the delay at `2_147_483_647` ms and `.unref()`s the timer, so a pending retry never keeps the process alive.

### packages/api/terminal-controller/src/stream.ts
- **Purpose:** the bounded output queue of one Remote stream generation.
- **Key abstractions:** `TerminalFollower` over a `Deque<{frame, bytes}>`.
- **Data flow:** `push(frame)` measures the frame's encoded UTF-8 size, queues it, and wakes the reader; `read(signal)` pops frames until closed/finished.
- **Non-obvious design decisions:** a slow follower **fails explicitly** rather than dropping frames ("reconnect to recover the current screen") — overflow throws with the instruction to reconnect (stream.ts:24-34); `close()` (manual detach) discards the queue, while `finish()` (process exit) delivers everything queued first.
- **Edge cases / failure handling:** a failure after `finish()` or `close()` is ignored, so a late input error cannot replace an ended attachment's final frames.
- **Surprising:** capacity is released as frames are *consumed*, not as they are queued — the byte budget measures undelivered output.

### packages/api/terminal-controller/src/shells.ts
- **Purpose:** shell selection and executable verification, delegated to the target execution provider.
- **Key abstractions:** `resolveShell`, `discoverShells`, internal `profile`/`shellKind`/`executableName`.
- **Data flow:** `resolveShell` reads the provider's `terminalEnvironment()` for a default and then verifies it with `resolveExecutable`; `discoverShells` probes each candidate in parallel and swallows only `SubprocessExecutableNotFoundError`.
- **Non-obvious design decisions:** shells are de-duplicated by **executable name ignoring case and `.exe`**, keeping the earliest entry, because PATH lookup can reach the default through another directory (`/usr/bin/bash` for `/bin/bash` on merged-`/usr`) (shells.ts:38-65); the interactive argument is shell-kind specific (`-i`, `-NoLogo` for PowerShell, none for cmd).
- **Edge cases / failure handling:** a *declared* default that cannot resolve **rejects** — it never silently falls back to another shell; transport failures during discovery propagate.
- **Surprising:** the conservative `/bin/sh` / `cmd.exe` fallback applies only when the provider *omits* its default (shells.ts:15-19).

### packages/api/terminal-controller/src/types.ts
- **Purpose:** the terminal wire vocabulary and the three typed `RemoteError` codes.
- **Key abstractions:** `WebTerminalId` (branded), `TerminalInput` (`write`/`resize`, each with a consecutive `sequence`), `TerminalFrame` (`snapshot`/`output`/`state`/`ack`), `TerminalRetentionFrame`.
- **Data flow:** every attachment begins with a complete bounded screen, then ordered output; `ack` confirms provider acceptance or reports a refusal (`read-only` / `not-running`).
- **Non-obvious design decisions:** the *input* sequence is attachment-local and "acknowledgements never authorize replay" (types.ts:66-69); `WebTerminalInfo.cwd` is the *initial* directory — shell directory changes do not update it.
- **Edge cases / failure handling:** `workspace-file`-style error details are declared here for `terminal/unavailable`, `terminal/control-unavailable` and `terminal/limit-reached`.
- **Surprising:** a symlink's presence is a *listing fact* in the directory type, but `read` still refuses a symlink — the two doors answer different questions.

### packages/api/terminal-controller/src/client/model.ts
- **Purpose:** the React-free browser terminal state and its reconnecting Remote-stream ownership.
- **Key abstractions:** `TerminalView`, `TerminalViewState` (phase machine `idle → loading → creating → connecting → connected → disconnected → closing → closed → failed`), `TerminalInputAttachment` (pending/queued/in-flight byte accounting).
- **Data flow:** `refresh()` reads the environment + (for a restored tab) the shared inventory, then `create()`; `connect()` opens a Gateway stream whose `open()` awaits the window hold and then `attach`; `consume()` validates the frame stream (a generation must start with a `snapshot`, output sequences must be consecutive) and awaits the DOM's render acknowledgement before the next frame.
- **Non-obvious design decisions:** the **UTF-8 input budget is released only on the provider's acknowledgement**, and the **encoded-frame budget** additionally accounts for the carrier's `inputWindow` overhead (model.ts:253-280); a reconnection creates a *fresh* command sequence and never replays unacknowledged input (model.ts:401-421); a refusal (`read-only`) disables input but keeps the output attachment alive (model.ts:372, 386-399).
- **Edge cases / failure handling:** `fail()` maps a Remote code to a localized `TerminalViewIssue` (`missingTerminal`, `inputFull`, `attachmentEnded`, `invalidOutput`, `terminalLimit`); a carrier error is `disconnected`, a business error is `failed`.
- **Surprising:** the view survives DOM unmount — the *process* only ends on explicit close, and the screen is recoverable by reattaching.

### packages/api/terminal-controller/src/client/index.ts
- **Purpose:** the client-side terminal model service; views are keyed independently of Host terminal identities.
- **Key abstractions:** `ClientTerminals` (`ctx.webTerminals`), `TerminalBindings`, `TerminalInventory`, `TerminalCloseRequests`, `TerminalWindowHold`.
- **Data flow:** `view(sessionId, key, contentId, terminalId?, shellPath?)` returns a stable model per sidebar occurrence; `retainTabs()` reconciles the window's open-tab inventory against its own saved identities to decide which holds to keep.
- **Non-obvious design decisions:** a *close intent* is saved to localStorage **before** the tab is released, so the cleanup outlives DOM unmount and reload, and a failed cleanup surfaces as a retryable notification rather than a lost process (index.ts:147-160, 233-258); a `session/not-found` answer *removes* the saved request instead of retrying forever.
- **Edge cases / failure handling:** on `connection/reset` each discovered Session's inventory is refreshed exactly once (the first notification is the initial connection, not a reconnect); `recover()` excludes held, pending-close and already-closed identities.
- **Surprising:** the Host terminal id and the *content* id are different keys — a layout-local tab id is not a persistence key, so two windows with the same tab id keep independent terminals.

### packages/api/terminal-controller/src/client/bindings.ts
- **Purpose:** the Session + content-identity → Host terminal id map, persisted in localStorage.
- **Key abstractions:** `TerminalBindings` with the key prefix `dsh.terminal.binding.v1.`.
- **Data flow:** `get` prefers the in-memory value, falls back to localStorage, and validates the stored value against `/^[\w-]{1,128}$/u`; `set`/`delete` write both memory and storage.
- **Non-obvious design decisions:** the key is `PREFIX + JSON.stringify([sessionId, contentId])`, so a session id containing a dot cannot collide with another key (bindings.ts:62).
- **Edge cases / failure handling:** a malformed or absent `localStorage` leaves the in-memory value usable (storage failure must not break the launch).
- **Surprising:** each record is an independent key, so one window's delete cannot erase another window's binding.

### packages/api/terminal-controller/src/client/close-requests.ts
- **Purpose:** unfinished close requests that survive reload independently of the removed sidebar tabs.
- **Key abstractions:** `TerminalCloseRequests`, key prefix `dsh.terminal.close.v1.` (one key **per terminal id**).
- **Data flow:** `save()` writes the intent; `remove()` forgets it after a confirmed cleanup; the constructor re-reads every prefixed key on construction.
- **Non-obvious design decisions:** one key per request so other browser windows cannot overwrite each other's cleanup (close-requests.ts:14); a loaded record must satisfy `isRequest` *and* its key must match its own id, else it is discarded with a console error.
- **Edge cases / failure handling:** a key removed during enumeration is skipped; a denied `localStorage` leaves cleanup usable in memory (just not recoverable after reload).
- **Surprising:** the request stores only `{sessionId, id, title}` — no process or tab metadata is mirrored.

### packages/api/terminal-controller/src/client/inventory.ts
- **Purpose:** one Session's cached terminal list, shared across view occurrences.
- **Key abstractions:** `TerminalInventory` with a `LoadState` machine (`unloaded`/`ready`/`failed`/`loading`/`disposed`).
- **Data flow:** `read(refresh)` joins the single in-flight request; `update`/`remove` mutate the cache *and* record the mutation in the pending request's `updates` map.
- **Non-obvious design decisions:** **acknowledged mutations take precedence over an older pending list response** — a create, rename or close that happened while a list was in flight is merged over the list's answer (inventory.ts:43-55); a response from a replaced connection cannot publish (`this.state !== request` → re-read).
- **Edge cases / failure handling:** a failure is cached until an explicit `read(true)` or a `reset()`; `reset()` returns `undefined` for an inventory that was never used, so a reconnect does not discover a Session that never needed a list.
- **Surprising:** `dispose()` joins the outstanding requests and rejects their late results.

### packages/api/terminal-controller/src/client/retention.ts
- **Purpose:** one reconnecting window hold, shared by every occurrence of a terminal.
- **Key abstractions:** `TerminalWindowHold` over a Gateway `$stream` of `TerminalRetentionFrame`.
- **Data flow:** `ready(signal)` resolves once the *current* physical generation has been acknowledged; `consume()` accepts each frame and resolves the waiters.
- **Non-obvious design decisions:** the hold must be acknowledged **before** an output attachment may follow it, so a restored screen is never attached to a terminal the Host has not confirmed it still holds (model.ts:175-179, retention.ts:38-48).
- **Edge cases / failure handling:** a terminal-domain failure ends the hold and marks it `failed`, which lets the owner retry explicitly; a non-Error transport rejection is preserved as the `cause` of the failure.
- **Surprising:** `dispose()` rejects the acknowledgement waiters *and* disposes the stream, so a pending `ready()` cannot hang a teardown.

### packages/api/terminal-controller/src/client/shell-preference.ts
20 lines: the browser-local shell preference under `dsh.terminal.shell`; `rememberShell` swallows a storage failure so private browsing or a quota error cannot prevent a launch.

### packages/api/terminal-controller/tests/controller.spec.ts
745 lines over the Host controller: execution services resolved from the *Agent's* plugin context (not consumer injections), the environment-default shell and its stability across default changes, restoring a terminal whose default executable has been removed, the current directory used for new terminals while earlier ones keep theirs, the directory captured *before* a delayed shell lookup, concurrent-create dedup, `close` racing an in-flight allocation (original, duplicate and later creates all refused), failed-allocation cleanup retained for retry, the `maxTerminals` quota counting pending reservations, ordered input/resize routing, invalid dimensions and identities, user shells starting under all three sandbox modes **without** any confinement, and cleanup shared between the Session and Host effects.

### packages/api/terminal-controller/tests/terminal.spec.ts
331 lines of screen continuity under real output scheduling: screen restored after detach without re-executing the shell or duplicating output, exit facts kept until explicit cleanup (and no replacement process), final output drained before followers close, a failed process outcome retaining the recovery screen, incomplete UTF-8 flushed at EOF, BOM preserved, concurrent close shared and retryable after a termination failure, split UTF-8, input control granted only to the newest attachment, the half-closed input case, five invalid-input shapes rejected *before* execution, and the "preserve the current controller when a queued attachment is cancelled" case.

### packages/api/terminal-controller/tests/retention.spec.ts
195 lines of the idle-grace policy on fake timers: the grace starts at the first positive observation and clears only at its deadline, two independent window holds, `busy`/`unknown` protected for arbitrarily many deadlines, invalidation by failed inspection / input / a new shell revision, a discarded asynchronous observation invalidated by a reconnect, a failed cleanup staying closed with one retry and no fresh grace, `unattendedTimeoutMs: 0` disabling reclamation, native-timer bounds without shortening a retry, no overlapping activity queries, and disposal waiting for the in-flight observation.

### packages/api/terminal-controller/tests/stream.spec.ts
97 lines: exact byte limit accepted and capacity restored per frame, accumulated overflow failing with "reconnect to recover", queued data discarded on detach, no delivery to an already-aborted reader, wake-on-output / wake-on-finish / wake-on-cancel, and the two late-failure cases (an ended attachment is not replaced; a graceful finish still drains its final frames).

### packages/api/terminal-controller/tests/model.client.spec.ts
559 lines of browser-view ownership: render acknowledgement before the next output, carrier loss classified as `disconnected` only for the active attachment, three malformed-stream shapes refused, an exited screen retained, control transfer published without replacing the screen, a delivery barrier proving a late frame from a replaced attachment is ignored, rename semantics, quota error exposure, input ordering and the two byte budgets, a 3000-command burst staying inside the advertised inbox, and "drops waiting commands when input is refused and never replays them on a new attachment".

### packages/api/terminal-controller/tests/recovery.client.spec.ts
863 lines of reload/recovery: one shared Session list across concurrent and later restored views, new identities created without reading the list, a missing-terminal failure preserved across remounts, one refresh per Session per reconnect, close intents surviving reload and retried at startup, Host terminals recovered by Session with held/pending/closed identities excluded, per-terminal localStorage close keys, malformed saved cleanup discarded, the storage-denied paths, and the "window hold acknowledgement gates the restored attachment" case.

### packages/api/terminal-controller/tests/bindings.client.spec.ts
55 lines (jsdom): other windows' records preserved through interleaved writes/closes/reloads, four malformed saved identities rejected, and the current window's values staying usable when storage is absent or throwing.

### packages/api/terminal-controller/tests/inventory.client.spec.ts
109 lines: an empty list and a failure retained until an explicit shared retry, creation/rename/state/closure merged over an older pending list, a previous connection's response ignored after replacement, unused inventories not discovered on reconnect, disposal joining outstanding requests, and a non-Error rejection preserved as the cached cause.

### packages/api/terminal-controller/tests/retention.client.spec.ts
64 lines: a Host-ended acknowledged hold fails pending and later attachments, one cancelled acknowledgement waiter does not affect another view of the same terminal, and a non-Error transport failure is preserved as the hold's cause.

### packages/api/terminal-controller/tests/input.ts
16 lines: a typed uplink whose `return()` interrupts a pending read, matching the Gateway's invocation cleanup.

### packages/api/terminal-controller/README.md
The terminal contract: the config table (maxTerminals 8, maxCols 500, maxRows 200, scrollback 1000, maxBufferedBytes 2 MiB, maxInputBytes 64 KiB, disposeGraceMs 1000, unattendedTimeoutMs 7200000, activityPollIntervalMs 30000, cleanupRetryMs 60000), the user-terminal permission model, the input/ack protocol, the localStorage binding and close-request contracts, and the stated limits (no durable terminal restoration, no automatic respawn, exited terminals still count toward the quota).

### packages/api/terminal-controller/README.zh.md
Chinese translation of the terminal README; read the first 30 lines — it mirrors the English configuration and permission paragraphs.

### packages/api/terminal-controller/README.i18n.yaml
Per-section EN/ZH digests for the terminal README (37 sections).

### packages/api/terminal-controller/package.json
Manifest for `@deepseek-ai/dsh-api-terminal-controller`: deps `@xterm/headless`, `@xterm/addon-serialize`, `dsh-deque`, `dsh-lazy-require`, `dsh-typert-protocol`; exports `.`, `./types`, `./client`, `./typert`, `./remote`; declares the web client injection of the Gateway.

### packages/api/terminal-controller/tsconfig.json
Composite project with two references — `tsconfig.host.json` and `tsconfig.client.json` — and no files of its own.

### packages/api/terminal-controller/tsconfig.host.json
Host-side type project: `src/index.ts`, `types.ts`, `terminal.ts`, `retention.ts`, `stream.ts`, `shells.ts`, referencing agent, session, fs, sandbox, working-directory, subprocess, typert and the xterm-adjacent utilities.

### packages/api/terminal-controller/tsconfig.client.json
Client-side type project: the seven `src/client/*` files plus `src/types.ts`, referencing the Gateway client, client-store, client-connection, session, brand, deque and crypto.

### packages/api/terminal-controller/tsdown.config.ts
7 lines: `clientBundle(import.meta.dirname, ['lib/types/index.js'], { hostPhase: true })` — the shared bundler helper every `api/*` package uses.

### packages/api/terminal-controller/locale/en.json
5 lines: the English locale stub — `meta.title: "api-terminal-controller"`.

### packages/api/terminal-controller/locale/zh.json
6 lines: the Chinese locale entry — title `终端控制接口` plus a one-line description.

### packages/api/workspace-controller/src/index.ts
- **Purpose:** the Host owner of the `workspace` Remote namespace, plus the directory-picker namespace.
- **Key abstractions:** `WorkspaceController extends TypertRemoteService`, `Config { documentsDirectory, documentsLookupTimeoutMs }`, `WorkspaceCommands`, `WorkspaceFeed`.
- **Data flow:** `follow()` wraps the feed's baseline+increments with an access filter; `initializeDefault()` asks the registry for the durable default Workspace, resolving the OS Documents directory under a timeout.
- **Non-obvious design decisions:** the registry `workspace` resource kind is registered with the default field `workspaceId` so the Gateway can authorise per-workspace access (index.ts:73); the access filter tracks the Workspaces *it delivered* and, when one stops being admitted, sends a **`replace` frame carrying the complete filtered state instead of a `remove`** — because a Client never resurrects a removed row, and a `remove` would be unrecoverable (index.ts:196-258).
- **Edge cases / failure handling:** a non-owner receives only the Workspaces and Sessions `remoteAccess.allows()` admits; a `remove` frame reaches only a client that received that Workspace; the directory-picking child stays *pending* until a backend is composed, so a host without one registers no namespace instead of answering an unservable verb (index.ts:78-82).
- **Surprising:** `insertBefore`/`insertSessionBefore` are DOM-`insertBefore`-shaped, not "move to index" — the anchor names the target.

### packages/api/workspace-controller/src/commands.ts
- **Purpose:** the Workspace mutations and the stable Remote failure mapping.
- **Key abstractions:** `WorkspaceCommands` with a serialized `operationTail`.
- **Data flow:** every mutation runs through `enqueue()`, so a rename's title-ownership check and a reorder see the same registry state.
- **Non-obvious design decisions:** the operations are **serialized on a promise tail** rather than locked — `rename` and `delete` of the same Workspace resolve in call order, so a stale rename after a delete fails as `workspace/not-found` instead of resurrecting it (commands.ts:235-239); `create` is idempotent (it resolves an existing Workspace by path and reports `created: false`).
- **Edge cases / failure handling:** registry error classes map to stable codes (`WorkspaceUnknownSessionError` → `session/not-found`, `WorkspaceActiveSessionError` → `workspace/session-active` carrying the activity list, `WorkspaceArchivedSessionPinError` → `gateway/bad-request`); an existing `RemoteError` is re-thrown unchanged.
- **Surprising:** `unarchiveSession` and `unpinSession` are **idempotent** — an id that is not archived/pinned is not an error, so a lost race with another surface resolves as a no-op.

### packages/api/workspace-controller/src/feed.ts
- **Purpose:** the reconnect-safe Workspace baseline and increment producer.
- **Key abstractions:** `WorkspaceFeed`, `WorkspaceFollower` (a `Deque` + a wake callback), `workspaceView`.
- **Data flow:** the feed subscribes to `domain/changed`; a registry-state write (`table === ''`) diffs order/archive/pin sets, a row write publishes an `upsert`, a row delete publishes a `remove`.
- **Non-obvious design decisions:** the feed keeps its own `knownIds`/`order`/`archived`/`pinned` mirror so it can emit *only* the increments that changed — the archive set and the pin set ride the same complete-set increment rather than a new frame type (feed.ts:119-128); a registry commit that references a missing Workspace **throws** rather than publishing an inconsistent frame (feed.ts:112).
- **Edge cases / failure handling:** the effect disposer closes every follower so a plugin unload ends the streams; `WorkspaceFollower.read()` re-checks `closed`/`aborted` after every await.
- **Surprising:** the wire vocabulary is closed — `replace` exists in the type but only the access filter produces it; the feed itself never sends it (feed.ts:19).

### packages/api/workspace-controller/src/types.ts
- **Purpose:** the browser-safe request/result/stream vocabulary and the typed error details.
- **Key abstractions:** `WorkspaceView`, `WorkspaceBaseline`, `WorkspaceFollowIncrement` (`replace`/`upsert`/`remove`/`order`/`archived`/`pinned`), `WorkspaceFollowFrame`.
- **Data flow:** types only — the Client and Host share this file.
- **Non-obvious design decisions:** `replace` is documented as "a change, not a new generation's opening frame" (types.ts:160-171) — a Client applies it like a baseline without reconnecting; the pin set is registry-global and most-recently-pinned first.
- **Edge cases / failure handling:** `workspace/session-active` carries the activity list *by family* so a surface can name what must stop first.
- **Surprising:** the picking seam's listing types are **re-exported rather than restated**, so a browser consumer reads the very declaration the backend answers.

### packages/api/workspace-controller/src/directory-picker.ts
- **Purpose:** the Host directory-picking Remote owner over the `ctx.directoryPicker` seam.
- **Key abstractions:** `DirectoryPickerController`, `BROWSE_FAILURE_CODES`, `cancellableFailure`, `browseFailure`.
- **Data flow:** `pick` / `list` / `createDirectory` each resolve the capability they need and then call the composed backend.
- **Non-obvious design decisions:** a verb the composition **cannot serve is refused rather than approximated** — `requireCapability` raises `directory-picker/unavailable` naming the capability the backend actually serves (directory-picker.ts:106-119); an abort is the *caller's* timeout or disconnect, not a backend failure, so it answers `gateway/cancelled` **before** the business classification runs (directory-picker.ts:161-170).
- **Edge cases / failure handling:** `createDirectory` validates the name with zod (single non-blank segment, no separator) *before* capability dispatch, so an invalid payload never reaches the backend; the seam's closed codes are projected onto the `directory-picker/*` wire codes.
- **Surprising:** a non-`Error` throw from a backend is folded into `gateway/internal` with the thrown value stringified.

### packages/api/workspace-controller/src/default-directory.ts
- **Purpose:** resolve the Host account's Documents directory for first-use Workspace creation.
- **Key abstractions:** `defaultWorkspaceDirectory(documentsDirectory, signal, internals)`, `validateDocumentsDirectory`.
- **Data flow:** macOS asks `osascript` for the documents folder *without folder creation*; Windows asks `powershell.exe` for `MyDocuments` with `DoNotVerify`; Linux asks `xdg-user-dir DOCUMENTS`.
- **Non-obvious design decisions:** the lookup is **platform- and internals-injectable** so it is unit-testable without a real OS; the Windows command sets `Console.OutputEncoding` to a BOM-less UTF-8 encoding so a Unicode Documents path survives the pipe (default-directory.ts:57-61); on Linux an answer equal to the home directory means XDG has the Documents directory *disabled*, and that is treated as "unavailable" (default-directory.ts:71-73).
- **Edge cases / failure handling:** the path must be fully qualified — a Windows path rooted at `\` or `/` is refused, but a redirected UNC `\\server\share\Documents` is accepted; the caller's signal and the lookup timeout are combined with `AbortSignal.any`.
- **Surprising:** the directory is never *created* by the lookup; only the final registry initialization creates it.

### packages/api/workspace-controller/src/default-workspace.ts
30 lines: the fixed leaf name `default-workspace` and `workspaceDisplayTitle(title, localizedDefault)`. A pure fold with no imports, so the browser bundle inlines it — and a Workspace the user renamed to exactly `default-workspace` is labelled as the default too.

### packages/api/workspace-controller/src/client/model.ts
- **Purpose:** the Client Workspace projection, its mutation echoes, and the stream/unary race resolution.
- **Key abstractions:** `ClientWorkspaceModel implements WorkspaceFollowSink`, `WorkspaceSnapshot`.
- **Data flow:** the sink methods (`replaceBaseline`, `upsertView`, `removeView`, `replaceOrder`, `replaceArchived`, `replacePinned`) are driven by the state stream; the unary methods merge their own echo.
- **Non-obvious design decisions:** **a newer Host row wins by `updatedAt`** regardless of which transport delivered it (model.ts:384-398); a **committed stream order outranks an older unary response** — the model keeps an `orderRequestGeneration` and an `orderFrameGeneration` and installs the unary echo only if neither moved (model.ts:144-161); a removed Workspace id is tombstoned in `removedIds` so delayed data cannot resurrect it, and the tombstone survives later baselines (model.ts:79-80, 414-421).
- **Edge cases / failure handling:** a superseded archive/pin reply installs nothing (`requestSeq` guards); a pushed set outranks a late reply; the archive echo also drops the row's pin locally, mirroring the Host's durable write.
- **Surprising:** `invalidate()` coalesces notifications into a **microtask** so a burst of stream frames produces one subscriber notification, while an immediate delete echo flushes synchronously.

### packages/api/workspace-controller/src/client/service.ts
- **Purpose:** the React-free Client Workspace service and command facade.
- **Key abstractions:** `WorkspaceController extends Service implements IWorkspaces`, `WorkspaceCreateError`, `WorkspaceArchiveError`.
- **Data flow:** every command calls the model and unwraps the `RemoteResult`.
- **Non-obvious design decisions:** the *failure taxonomy* is preserved for the caller: `WorkspaceArchiveError` carries the whole `rpcError`, so a surface can tell the active-session refusal (`workspace/session-active`, whose details name what still runs) from a missing Session or a carrier fault (service.ts:22-32, 84-86).
- **Edge cases / failure handling:** a carrier throw arrives already folded as `gateway/internal` and is reported as a `WorkspaceCreateError` rather than a raw rejection.
- **Surprising:** `initializeDefault` returns `undefined` (not an error) when first use is ineligible, so startup can leave directory selection to the user.

### packages/api/workspace-controller/src/client/index.ts
- **Purpose:** the Workspace-specific adapter for the Gateway-owned snapshot stream lifecycle.
- **Key abstractions:** `createWorkspaceStateStream`, `WorkspaceStateStream = RemoteSnapshotStream<baseline, increment>`, `acceptIncrement`.
- **Data flow:** the plugin creates the model, wires the service, and starts the state stream; the stream's `replace`/`update` hooks call the model's sink methods.
- **Non-obvious design decisions:** the stream distinguishes an *accepted* end from a premature one: an end after the baseline is a `RemoteStreamCarrierError` ("ended without a terminal result") and triggers a reconnect, while an end *before* the baseline is a terminal `Error` (index.ts:84-87).
- **Edge cases / failure handling:** a protocol failure (an increment before the baseline, a duplicate baseline) is **terminal** — no second generation is opened; the client's `failed` callback publishes it as `gateway/internal`.
- **Surprising:** the `replace` increment is applied in place, so a Workspace hidden and shown again never errors and never reconnects.

### packages/api/workspace-controller/tests/workspace-controller.host.spec.ts
613 lines over the Host: concurrent path adoption serialized, invalid paths / blank names / conflicts / unknown ids mapped to stable failures, Remote failures preserved and unexpected registry failures propagated, a queued rename that lands after a delete failing as not-found, reordering, the `workspace/session-active` refusal carrying the activity list and `stopActivity: true` archiving anyway, idempotent unarchive/unpin, the feed's baseline + ordered increments, a non-owner seeing only the admitted Workspaces and Sessions, the `replace`-instead-of-`remove` revocation case, unrelated domain writes ignored, and the first-use `initializeDefault` cases.

### packages/api/workspace-controller/tests/model.client.spec.ts
572 lines over the Client model: the prepared Workspace published and the list unchanged on refusal, baseline replacement with ordered increments, the last baseline retained during a carrier retry, optimistic reorder superseded by a newer stream order, failed reorders rolled back, removal tombstones surviving later baselines, delayed unary data not resurrecting a removed Workspace, out-of-order archive/pin replies, a pushed set outranking a late reply, the archive echo dropping the pin, and the subscriber-notification coalescing.

### packages/api/workspace-controller/tests/transport.client.spec.ts
460 lines through the assembled Gateway client: the plugin providing the service and cancelling its follow generation on unload, a Loader rebuild re-providing it, exhausted carrier retries published as a terminal error, one baseline followed by increments, a `replace` applied in place (hide → show → hide → upsert without an error or a reconnect), a normal end classified as carrier loss, the three terminal protocol failures, and the command facade mapping business failures to its error classes.

### packages/api/workspace-controller/tests/directory-picker.host.spec.ts
167 lines: the native verb under a browse composition and the browse verbs under a native composition are both refused as `directory-picker/unavailable` with the served capability in the details; an aborted chooser is `gateway/cancelled`; the seam's typed failures map to `directory-picker/unreadable` / `exists`; unknown throws fold to `gateway/internal`; and six invalid child names are rejected before capability dispatch.

### packages/api/workspace-controller/tests/default-directory.host.spec.ts
48 lines: the three platform lookups (osascript / powershell.exe / xdg-user-dir) preserving spaces and Unicode, the configured directory skipping the lookup, an unavailable XDG answer rejected, lookup failure and cancellation propagated, and the Windows fully-qualified-root rule (a UNC share accepted, a rooted-but-not-drive path refused).

### packages/api/workspace-controller/tests/remote/workspace.client.ts
111 lines: the Remote side of one Workspace registry under test — `workspaceWorld` (default answers for every `workspace/*` command), `workspace()`/`baseline()` builders, `followGenerations()` (the n-th open runs the n-th script) and `err()`.

### packages/api/workspace-controller/README.md
The Workspace contract: the `follow()` frame vocabulary, the access-filter rules and the `replace`-not-`remove` rule, the Client model's race-resolution rules, the first-use Workspace (`<Documents>/deepseek-harness/default-workspace`) and its config table, and the limits (no durable cursor, process-local deletion markers).

### packages/api/workspace-controller/README.zh.md
Chinese translation of the Workspace README; read the first 14 lines — it mirrors the English summary and purpose sections.

### packages/api/workspace-controller/README.i18n.yaml
Per-section EN/ZH digests for the Workspace README (34 sections).

### packages/api/workspace-controller/package.json
Manifest for `@deepseek-ai/dsh-api-workspace-controller`: deps `dsh-deque`, `dsh-native-command`, schemastery, zod; peers on the Gateway client, client-connection, host-directory-picker, session, storage-domain, typert-protocol and workspace; exports `./default-workspace` as a separate entry.

### packages/api/workspace-controller/tsconfig.json
Composite project with the host and client type projects as references.

### packages/api/workspace-controller/tsconfig.host.json
Host type project: `src/index.ts`, `types.ts`, `commands.ts`, `default-workspace.ts`, `directory-picker.ts`, `feed.ts`, `default-directory.ts`.

### packages/api/workspace-controller/tsconfig.client.json
Client type project: `src/client/index.ts`, `model.ts`, `service.ts`, `default-workspace.ts`, `types.ts`.

### packages/api/workspace-controller/tsdown.config.ts
7 lines: the shared `clientBundle` helper with `hostPhase: true`.

### packages/api/workspace-controller/locale/en.json
5 lines: the English locale stub — `meta.title: "api-workspace-controller"`.

### packages/api/workspace-controller/locale/zh.json
6 lines: the Chinese locale entry — title `工作区控制接口` plus a one-line description.

### packages/api/workspace-files/src/index.ts
- **Purpose:** the Host owner of the `workspaceFiles` Remote namespace — bounded reads, workspace-scoped listing, and the change feed.
- **Key abstractions:** `WorkspaceFiles extends TypertRemoteService`, `WorkspaceFileScope { sessionId, workspaceRoot }`, `Config { maxBytes, maxFileBytes, maxLines, maxEntries }`, the `workspaceFileScope` Typert lookup.
- **Data flow:** the Typert lookup resolves a Session id to a workspace root from the *live* session header or, for a cold session, from persistence `stat` — without activating an Agent or reading the event body (index.ts:202-222); `read` streams the file as text and cuts a page; `readBytes` reads a byte window or the whole file; `list` lists one directory; `changes` returns the feed.
- **Non-obvious design decisions:** **a page above the cap fails; it is not shortened** — "a silently cut page reads as the whole page" (index.ts:71-77, 367-381); the file is read **only up to the first character past the page**, so a very large file costs one page of memory (index.ts:106-160); file reads are *not* workspace-confined (the composed filesystem's read authority decides) while directory listing and directory watches *are* (index.ts:1-11, 402-409); every operation starts with `lstat` and refuses a final symlink for reads, while `list` follows a directory link and requires it to resolve inside the workspace.
- **Edge cases / failure handling:** the backend's non-text refusal is recognized **by its `code` alone** (`FS_NOT_TEXT`), because the error class belongs to whichever `dsh-fs` instance the provider loaded and no class identity is shared across the package boundary (index.ts:457-464); the same trick maps `FS_TOO_LARGE`.
- **Surprising:** a symlink child is listed as what it points to (a listing fact), but `read` still refuses a symlink — the two doors answer different questions.

### packages/api/workspace-files/src/changes.ts
- **Purpose:** target-scoped filesystem watches and `fs/observed` invalidations.
- **Key abstractions:** `WorkspaceChangeFeed`, `ChangeFollower` (a `Deque` of observations + a `Promise.withResolvers` for the watcher handle).
- **Data flow:** the feed subscribes to `fs/observed`; a generation registers its queue, resolves the root and the target, starts `fs.watch`, and only then yields `{kind:'ready'}`; each matching observation re-stats the target and yields `{kind:'change', change}`.
- **Non-obvious design decisions:** the observation queue is installed **before** the target resolves, so invalidations that arrive during setup are not lost (changes.ts:41-52); setup shares the caller's cancellation signal, so a late resolution cannot acquire a watcher (changes.ts:55-65); the directory containment check is re-evaluated on *every* stat, so a directory that becomes a file (or moves) is caught (changes.ts:71-73).
- **Edge cases / failure handling:** an aborted generation returns quietly instead of throwing; a watch that cannot be installed becomes `workspace-file/watch-unsupported` with the backend's message; `close()` awaits the watcher handle before releasing the follower.
- **Surprising:** the target identity is compared by `targetKey`, not by path, so two spellings of the same file are one target.

### packages/api/workspace-files/src/types.ts
- **Purpose:** the wire types of the `workspaceFiles` namespace (types only, consumed by the generated Client).
- **Key abstractions:** `WorkspaceFileStat { absolutePath, version, bytes? }`, `WorkspaceFileRange`, `WorkspaceByteRange`, `WorkspaceDirectoryListing`, `WorkspaceFileWatchFrame`.
- **Data flow:** types only.
- **Non-obvious design decisions:** the module documents **two path vocabularies** and says which method uses which: `read`/`readBytes`/`stat`/`changes` name a file by its absolute path in the filesystem's execution world, while `list` speaks workspace paths (types.ts:1-13); `version` is an *opaque* freshness token that is never parsed.
- **Edge cases / failure handling:** `lines` distinguishes "one empty line" from "a page past the end" (both have empty `text`); the eight `workspace-file/*` error codes are declared here with their typed details.
- **Surprising:** a directory's `entries` are cut to the entry cap and the listing says `truncated: true` — the cap is visible to the caller.

### packages/api/workspace-files/src/client/provider.ts
- **Purpose:** the `file` protocol's resource provider — a workspace file's metadata as a stream of `RemoteResult` frames.
- **Key abstractions:** `createFileResourceProvider(remote, changes)`, `resolve(address)`.
- **Data flow:** `open(address)` resolves the address to a Host file, subscribes to the change feed, waits for the Host's `ready`, then `stat`s and yields the metadata; each notice re-stats and yields the fresh metadata.
- **Non-obvious design decisions:** **failures travel as `ok: false` frames, never as thrown errors** — the Remote face does not reject, and anything thrown inside the stream is a programming error the resource model lets surface (provider.ts:16-22); the provider waits for the Host's `ready` frame before its first `stat`, so a Client never stats a target the Host has not subscribed to (provider.ts:69-76); a duplicate version is ignored ("holding this version already means the consumer learns nothing new").
- **Edge cases / failure handling:** a failed stat does **not** end the stream — the address stays followed so a later write can bring the file live; an `absolute` address has no authorizing Session and fails `workspace-file/unknown-workspace` without borrowing the current or Tab Session.
- **Surprising:** the Client needs no Session `cwd` at all — the Host owns resolution and the access check, and only `stat.absolutePath` selects the change-feed key.

### packages/api/workspace-files/src/client/change-feed.ts
- **Purpose:** one Host `changes` subscription per Session and requested path, shared by that target's open resources.
- **Key abstractions:** `ChangeFeed`, `SessionFeed`, `Follower` (queue + `ready` promise + `bind`).
- **Data flow:** `follow(sessionId, path, signal)` registers a follower; the first follower opens the Host stream; the `ready` frame starts the followers and pushes a `refresh`; each `change` frame is normalized (`\` → `/`) and matched against each follower's bound Host path.
- **Non-obvious design decisions:** the follower is registered **on call, not on first pull**, and buffers changes until `stat` supplies the Host absolute path; before binding, *any* target invalidation can trigger a retry, and after binding only matching ones pass (change-feed.ts:235-251); a successor waits for its predecessor's disposal so one target never has two Host streams open (change-feed.ts:121-128, 278-292).
- **Edge cases / failure handling:** a terminal stream failure ends the followers quietly and leaves their last metadata readable; the last follower leaving disposes the stream; `settle()` waits for every closing stream so a teardown leaves no Host stream behind.
- **Surprising:** the follow is *on the address*, not on the file — a file that does not exist yet is still followed, and a later write brings it live.

### packages/api/workspace-files/src/client/index.ts
35 lines: the browser half — builds one `ChangeFeed`, creates the `file` provider, registers it in `ctx.resources` for the fiber's lifetime, and on teardown releases the registration *then* awaits `changes.settle()` so no Host stream is left behind.

### packages/api/workspace-files/src/client/remote.ts
50 lines: the structural slice of the Client Remote this package calls — `SupervisedStream`/`SupervisedStreamItem`/`SupervisedStreamOptions` and `WorkspaceFilesRemote` — so the feed and the provider are testable against a scripted face.

### packages/api/workspace-files/src/client/types.ts
50 lines: the `file` protocol's resource metadata declaration (`ResourceProtocolMap.file = WorkspaceFileStat`), the `WorkspaceFileParams` navigation params, the two Client-only error codes, and the internal `WorkspaceFileEdit`/`WorkspaceFileNotice` vocabulary.

### packages/api/workspace-files/tests/harness.ts
100 lines: the shared fixture — a **real** `LocalFileSystem` over a temp workspace with a sibling directory outside it, plus a sandbox policy whose only job is naming the root; `failureOf` unwraps a Remote failure and re-throws a non-Remote throw as a test defect. The header states why a fake provider is not used: a string-prefix containment check would pass the symlink file.

### packages/api/workspace-files/tests/read.spec.ts
274 lines (read the first 160): the four `read` gates and the line window — whole-file page with path/version/bytes, nested path resolution, empty file, multi-byte UTF-8 counted in bytes, the requested line window with `eof`, a final newline terminating the last line rather than starting an empty one, an offset past the end, the default limit, refusals for a limit above the cap and non-integer windows, carriage returns kept, an absolute path outside the workspace read without mutation, a preserved provider refusal, and the symlink-out-of-the-workspace case "a prefix test cannot see".

### packages/api/workspace-files/tests/read-bytes.spec.ts
152 lines (read the first 120): the byte window — whole file by default, the requested window with `eof`, a window read out of a file above *both* caps (asserting `readByteRange` was used and `readBytes` was not), `eof` inferred from a short window when the backend reports no size, empty windows at/past EOF, NUL and invalid UTF-8 round-tripping as bytes, the version matching a `stat`, the default length, and a too-long window refused rather than shortened.

### packages/api/workspace-files/tests/read-all.spec.ts
154 lines (read the first 120): complete-file reads — bytes independent of the window cap, empty files, the size refusal mapped for a workspace *and* an outside file, the actual bytes checked when `stat` reports no (or a wrong) size, missing-file and kind failures retained, non-size failures preserved verbatim, the size refusal mapped **by code** without a shared error class, and the `baseFile` relative-resolution rules (including a non-relative target rejected for absolute, URL and NUL-containing spellings).

### packages/api/workspace-files/tests/list.spec.ts
140 lines: the listing — the root as the empty workspace path with types and sizes, the absolute root, a decoded nested path, a symlink child reported as its target (dangling as `other`), a directory link listed through its target, the entry cap cutting in name order and saying so, and the gates: outside directory, `..` traversal, a directory link resolving outside, a dangling link, a file, a missing path and an empty path.

### packages/api/workspace-files/tests/stat.spec.ts
78 lines: `stat` — absolute path + version + size, the version matching a `read` and changing after a write, an aborted signal refused before any path resolves, the caller's signal reaching both resolutions, `bytes` omitted when the backend reports no size, and outside files accepted while symlinks/directories/missing/empty paths are refused.

### packages/api/workspace-files/tests/scope.spec.ts
77 lines: the `workspaceFileScope` Typert lookup — a live session header used directly, a cold session resolved from persistence `stat`, a header with no `cwd` falling back to the sandbox policy root, a missing session resolving to `undefined`, and the lookup unregistering with the plugin. The lookup's `resource: 'session'` makes the scope's Session the access-control resource.

### packages/api/workspace-files/tests/binary-rpc.spec.ts
96 lines: workspace byte reads crossing the **Gateway lookup and the Connection's binary RPC response** end to end — a complete binary file returned through the ordinary Remote endpoint, a range read that never touches the complete-file path, the full-file size failure and the Gateway's `gateway/lookup-not-found`, and cancellation propagating into the filesystem for both option shapes.

### packages/api/workspace-files/tests/changes.spec.ts
848 lines (read the first 120): target-scoped Host changes — readiness acknowledged *before* draining observations queued during root resolution, the current metadata re-read on every invalidation, and the watcher ownership fixtures (`unwatch` spy, an independently unloadable service owner, and an aggregate cleanup failure).

### packages/api/workspace-files/tests/change-feed.client.spec.ts
307 lines (read the first 130): one Host stream per Session and target — a later follower joining an acknowledged target without opening another stream, sharing only when *both* Session and target match, the stream disposed when its last follower leaves and reopened for the next, a successor waiting for the predecessor's close while another target opens, overlapping closes of one target, and `settle()` waiting for the close.

### packages/api/workspace-files/tests/provider.client.spec.ts
437 lines (read the first 150): the file provider — seven unsupported-address shapes yielding one failure frame and ending without touching the Remote, an absolute address rejected as `unknown-workspace`, the relative path submitted to the Host while the *Host* canonical path selects the change-feed key, the absolute path through the Session in the address, separate streams for the same path in different Sessions, and the opening stat.

### packages/api/workspace-files/tests/host-path.client.spec.ts
315 lines (read the first 110): Host-resolved file identities — the unmodified relative path submitted without a Client Session summary, **no stat until the Host acknowledges the subscription**, four pre-ready endings (abort / end / failure / watch-unsupported) each settling with exactly one fallback stat unless aborted, and an abort during the fallback stat ending without a frame.

### packages/api/workspace-files/tests/apply.client.spec.ts
65 lines: the plugin body — one `file` provider registered into `ctx.resources` for the fiber's lifetime, reading through `ctx.remote` in the Session each address names, and unregistering (and aborting the outstanding requests) with the fiber.

### packages/api/workspace-files/tests/fake-remote.client.ts
245 lines: the scripted Remote — a `Source` that can push / deliver / end / fail, pending `stat` requests the spec resolves, one `Source` per opened `changes` generation, an `autoReady` switch to keep a subscription unacknowledged, a `disposeGate` to hold a stream's disposal, and a `$stream` that classifies its end exactly as the real supervisor does.

### packages/api/workspace-files/README.md
158 lines (read the first 90): the file-service contract — the method table, addressing and the two path vocabularies, the line window and the byte window (with "a longer window fails with `too-large` instead of arriving shortened"), the file-read and directory checks, the change feed, the config table (`maxBytes` 2 MiB, `maxFileBytes` 32 MiB, `maxLines` 5000, `maxEntries` 2000), the failure codes, and the Client `file` resource contract.

### packages/api/workspace-files/README.zh.md
Chinese translation of the file-service README; read the first 14 lines — it mirrors the English summary and purpose.

### packages/api/workspace-files/README.i18n.yaml
Per-section EN/ZH digests for the file-service README (67 sections — the largest in this shard).

### packages/api/workspace-files/package.json
Manifest for `@deepseek-ai/dsh-api-workspace-files`: deps `dsh-deque`, `dsh-typert-protocol`, schemastery, zod; dev-deps on the fs, sandbox-policy, session-persistence, workspace-path and client-resources packages; exports `.`, `./types`, `./client`, `./typert`, `./remote`.

### packages/api/workspace-files/tsconfig.json
Composite project with the host and client type projects as references.

### packages/api/workspace-files/tsconfig.host.json
Host type project: `src/index.ts`, `types.ts`, `changes.ts`, referencing fs, sandbox-policy, session, session-persistence, typert-protocol and deque.

### packages/api/workspace-files/tsconfig.client.json
Client type project: the five `src/client/*` files plus `src/types.ts`, referencing the Gateway client, session, client-resources, client-ui-slots and workspace-path.

### packages/api/workspace-files/tsdown.config.ts
7 lines: the shared `clientBundle` helper with `hostPhase: true`.

### packages/api/workspace-files/locale/en.json
5 lines: the English locale stub — `meta.title: "api-workspace-files"`.

### packages/api/workspace-files/locale/zh.json
6 lines: the Chinese locale entry — title `工作区文件接口` plus a one-line description.

### packages/api/settings-controller/src/index.ts
- **Purpose:** the Host owner of the `settings` Remote namespace (and the mounted `credentials` namespace).
- **Key abstractions:** `SettingsController extends TypertRemoteService`, `SettingsControllerInternals { openTextFile? }`, `namespaceView`, `rejected`.
- **Data flow:** `describe()` returns the provider's redacted descriptors projected field by field; `update`/`replace`/`mutate` call the settings service and then re-read the namespace; `openSettingsDocument()` prepares the provider-owned document and hands it to a native text editor.
- **Non-obvious design decisions:** every read uses `redactSecrets: true`, and the projection is **field by field** — "a provider whose descriptor carried extra enumerable properties would otherwise serialize them to the caller" (index.ts:44-60); a **stale write is its own outcome**, not a malformed request: `settings/conflict` carries `{ns, expected, actual}` so the client re-reads and re-applies rather than treating the write as invalid (index.ts:257-268); the namespace stays registered when no provider is mounted, so the call returns an actionable configuration error instead of a missing method.
- **Edge cases / failure handling:** the abort state is re-read **afresh after each awaited call** (`isAborted`), because a flag captured before an await would be stale; a namespace disposed between the write and the re-read yields `gateway/internal` naming the mode.
- **Surprising:** `openSettingsDocument` accepts **no browser-supplied filesystem target** — the path always comes from the provider.

### packages/api/settings-controller/src/credentials.ts
- **Purpose:** the Host owner of the `credentials` Remote namespace.
- **Key abstractions:** `CredentialsController`, `MAX_DESCRIBE_REFS = 64`, `projectCredentialInfo`.
- **Data flow:** `describe(refs)` fans out to the credential provider and returns a map keyed by the requested names; `set`/`unset` write through the provider.
- **Non-obvious design decisions:** **secret values cross in one direction only — no method here returns one** (credentials.ts:99-105, 65-66); the batch is bounded at 64 references so "one authenticated request" cannot start unbounded provider work (credentials.ts:15-20); the answer is copied **field by field** so a foreign provider's extra enumerable properties (e.g. a stray `value`) cannot widen what crosses the wire.
- **Edge cases / failure handling:** the reference grammar is enforced with a regex *before* branding, so a name outside it never reaches the provider; a write refusal becomes `credential/rejected` whose details name **only the reference**, "so no failure path can carry the value back out".
- **Surprising:** a provider that throws a bare string is stringified into the message rather than crashing the boundary.

### packages/api/settings-controller/src/types.ts
34 lines: the browser-safe failure vocabulary — `settings/rejected {ns}`, `settings/conflict {ns, expected, actual}`, `credential/rejected {ref}` — and the `SettingsDocumentOpenValue { opened: true }` confirmation.

### packages/api/settings-controller/tests/settings-controller.host.spec.ts
106 lines over a real Cordis profile configuration: the published method list and the mounted credentials namespace, redaction of every described layer (`JSON.stringify(describe)` must not contain the secret), a mutation reaching the live consumer, a stale write refused as `settings/conflict`, an unregistered namespace refused as `settings/rejected`, an empty namespace refused as `gateway/bad-request`, the absent-service error, the native opener (path, failure, cancellation), a cancellation during preparation (the opener is never called), a primitive write failure stringified, and a form removed after its write committed.

### packages/api/settings-controller/tests/credentials-controller.host.spec.ts
138 lines: the namespace's own service key, the actionable absent-provider error for all three verbs, a batch described as one map with the value excluded, an invalid reference as bad-request, the 64-reference bound (65 is bad-request), a **leaky provider** whose `describe` carries an extra `value` field (the answer is narrowed to the declared fields), set/unset round-tripping, a refused write as `credential/rejected` naming only the reference, an empty value as bad-request, and a non-Error refusal stringified.

### packages/api/settings-controller/README.md
69 lines: the configuration-surface contract — both namespaces registered independently of their providers, the 64-reference batch bound, the redaction rule, the `settings-conflict` / `settings-rejected` outcomes, and the native document opening that accepts no browser-supplied path.

### packages/api/settings-controller/README.zh.md
Chinese translation of the settings README; read the first 14 lines — it mirrors the English summary and purpose.

### packages/api/settings-controller/README.i18n.yaml
Per-section EN/ZH digests for the settings README (34 sections).

### packages/api/settings-controller/package.json
Manifest for `@deepseek-ai/dsh-api-settings-controller`: deps schemastery + zod; peers on `dsh-agent-preset-registry`, `dsh-credentials`, `dsh-native-command`, `dsh-session`, `dsh-settings`, `dsh-typert-protocol`.

### packages/api/settings-controller/tsconfig.json
TypeScript project for the settings package: `rootDir: src`, `outDir: lib/types`, referencing cordis, schemastery, agent-preset-registry, credentials, session, native-command, settings and typert-protocol.

### packages/api/settings-controller/locale/en.json
5 lines: the English locale stub — `meta.title: "api-settings-controller"`.

### packages/api/settings-controller/locale/zh.json
6 lines: the Chinese locale entry — title `设置读写接口` plus a one-line description.

---

## Ideas worth stealing

- **An owned activity interval, not a prompt/answer pair** — `packages/sdk/client/src/api.ts:207-254`. `run()` queues the prompt, waits for the *durable inbox receipt carrying its own message id*, then collects until the next whole-agent `idle`. `finalResponse` is explicitly "the last committed assistant text in that interval — not a response causally assigned to the prompt, because steering, injected context, and other queued work may contribute before idle" (`packages/sdk/client/README.md:52`). For the August harness this is the right shape for any "run the agent and tell me what it said" API: bind the interval to an observable lifecycle edge (receipt → idle), and say out loud that the answer may not be the answer to *this* prompt.
- **Abandonment is not cancellation, and the pending entry is deleted on abandon** — `packages/sdk/protocol/src/transport.ts:129-137` and `packages/sdk/client/src/client.ts:359-366`. A timed-out request *aborts* the pending entry (so a hung method retains no per-call state) while the server-side work keeps running to completion. The test pins the observable: three consecutive timeouts leave `transport.pending.size === 0` (`packages/sdk/client/tests/sdk-client.spec.ts:469-483`). August's tool-call layer needs this distinction: a timeout must free the *client's* bookkeeping without pretending the server stopped.
- **The handshake is the readiness boundary, and it waits for the whole plugin tree** — `packages/sdk/server/src/index.ts:83-85`. `initialize` awaits `ctx.get('loader')?.await()` so that async sibling capabilities (an MCP client's initial tool discovery) are visible to the *first* prompt; there is no scheduler delay in readiness. Transferable directly: an agent harness that advertises "ready" before its tools are discovered will accept a first prompt that cannot see them.
- **The model route is resolved and validated at the handshake; there is no fallback to constructor defaults** — `packages/sdk/server/src/server.ts:155-189` and `packages/sdk/server/src/server.ts:170-188`. `initialize` runs `llm.resolveCallConfig({provider, model, reasoningEffort, maxTokens})` and `session/prompt` rejects with "SDK server is not initialized" until that succeeds. A missing adapter, an unavailable model or an unsupported reasoning effort therefore fails *at the handshake* rather than degrading silently on turn 1. August's equivalent (per-model reasoning effort / max tokens) should fail the same way.
- **A failed handshake that cleaned up successfully installs a fresh client; a failed cleanup retains the failed client** — `packages/sdk/client/src/api.ts:80-92`. The instance retries with a *new* subprocess because `HarnessClient.close` is permanent, but if the cleanup also failed it throws an ordered `AggregateError` and **keeps** the failed client rather than spawning a second process beside one whose exit was never proved. This is the same "don't create a second owner before the first is provably gone" discipline August's own project notes call for in the update path.
- **A late stream frame from a replaced attachment is ignored, and the model never resurrects a removed row** — `packages/api/terminal-controller/src/client/model.ts:345-360` and `packages/api/workspace-controller/src/client/model.ts:79-80, 384-398`. The terminal view compares the *stream generation* and drops frames from an old one; the Workspace model tombstones removed ids and compares `updatedAt` so a newer Host row always wins regardless of which transport delivered it. August's transcript/UI layers need exactly this when a run is cancelled and a stale result arrives later.
- **A reconnection creates a fresh command sequence and never replays unacknowledged input** — `packages/api/terminal-controller/src/client/model.ts:192-204` (each `connect()` builds a new attachment with `sequence: 0` and drops the old one) and the matching test `packages/api/terminal-controller/tests/model.client.spec.ts:401-421`. The byte budget of the *old* generation is discarded with it, so a reconnect cannot "resume" a half-typed command.
- **Refuse the page, never shorten it** — `packages/api/workspace-files/src/index.ts:71-77, 367-381`. "A page above this fails; it is not shortened, because a silently cut page reads as the whole page." The same rule appears in the byte-window path, where an over-cap window is `workspace-file/too-large` rather than a truncated array. August's file-read tool has exactly this hazard (a 20 MB ceiling and a 200 MB paged escape hatch) and the refusal semantics are the transferable part.
- **Only positively confirmed idle time counts toward reclamation, and an unknown observation clears the deadline** — `packages/api/terminal-controller/src/retention.ts:113-130`. A `busy` or `unknown` activity state resets the idle clock, a gap longer than twice the poll interval resets the evidence, and the clock is monotonic (`performance.now()`). This is the right shape for any "reclaim idle resources" policy in August: never reclaim on the *absence* of evidence.
- **A slow consumer fails explicitly and recovers from the screen** — `packages/api/terminal-controller/src/stream.ts:24-34`. The bounded output queue refuses to drop frames: it fails the attachment with "reconnect to recover the current screen". August's streaming paths (SSE, event buses) should prefer an explicit failure over silent frame loss, and should keep a re-derivable state (the screen, the baseline) so a reconnect is cheap.
- **The Host decides the file's identity; the Client needs no local state to authorize it** — `packages/api/workspace-files/src/client/provider.ts:52-110` and `packages/api/workspace-files/src/index.ts:202-222`. The address carries the Session id; the Host resolves the path, checks access, and returns `stat.absolutePath`; the Client binds its change-feed key to *that* path. The result is that the browser never needs a Session summary, a cwd mirror, or a copy of the access rules — and the `workspaceFileScope` Typert lookup resolves a cold session from persistence *without activating an Agent*.
- **Field-by-field projection of any provider answer before it crosses the wire** — `packages/api/settings-controller/src/credentials.ts:45-51` and `packages/api/settings-controller/src/index.ts:48-60`. The reason is stated precisely: "the Gateway returns a business result without decoding it, so a provider whose descriptor carried extra enumerable properties would otherwise serialize them to the caller." The test uses a deliberately leaky provider to prove it (`packages/api/settings-controller/tests/credentials-controller.host.spec.ts:9-15, 101-106`). This is the cheapest possible defence against a secret riding along in an extra field, and it generalizes to every provider seam in August.
- **A stale write is its own outcome, not a malformed request** — `packages/api/settings-controller/src/index.ts:257-268`. `SETTINGS_CONFLICT` becomes `settings/conflict {ns, expected, actual}` so the caller knows to re-read and re-apply, while every other provider refusal becomes `settings/rejected`. The same shape appears in the Workspace archive path, where the refusal carries the *activity list* so the surface can say what must stop first.
- **Serialized mutation tail instead of a lock** — `packages/api/workspace-controller/src/commands.ts:235-239`. A promise tail makes a rename that lands after a delete fail as `workspace/not-found` rather than resurrecting the row, and it makes a rename's title-ownership check see the same registry state as the reorder that follows it. Cheap to add, and it removes a whole class of "two doors raced" bugs.
- **Subagent locality is decided by one snapshotted flag, never by names or lineage** — `packages/sdk/server/src/server.ts:129-147`. "The service snapshots the provider name and local flag through child disposal; matching ids or parent lineage alone never establishes locality." The test suite then walks the collision cases (a remote run id equal to a local child's id; a reused id across two parents; a provider re-registered under the same name). August's subagent layer needs the same single source of truth for "is this child mine".
- **A failure is bound to its session until a later committed terminal accounts for it** — `packages/sdk/server/src/server.ts:103-116`. The server records `agent/error` with the session's log offset and clears it only when a `turn/end` at or after that offset is committed, so `session/wait` can reject with a failure that happened *before* the wait while a later successful turn clears it. This is the missing half of "a wait must not hang and must not lie" — the same shape August needs for a turn that fails after the caller stopped watching.

---

## Files skipped (with reasons)

None. Every one of the 147 files in the shard was opened and read. No file was skipped as generated, vendored, binary, or huge: the largest file in the shard is `packages/sdk/server/tests/server.spec.ts` at 56 KB / 1317 lines, and it was read in full.

## Uncertainties

- **Partial line-level reads of eight large files.** I read the *whole* file for 139 of the 147; for the following eight I read a leading portion (and the remainder is a continuation of the same test style, not new modules): `packages/api/workspace-files/tests/changes.spec.ts` (lines 1-120 of 848), `packages/api/workspace-files/tests/provider.client.spec.ts` (1-150 of 437), `packages/api/workspace-files/tests/change-feed.client.spec.ts` (1-130 of 307), `packages/api/workspace-files/tests/host-path.client.spec.ts` (1-110 of 315), `packages/api/workspace-files/tests/read.spec.ts` (1-160 of 274), `packages/api/workspace-files/tests/read-all.spec.ts` (1-120 of 154), `packages/api/workspace-files/tests/read-bytes.spec.ts` (1-120 of 152), and `packages/api/workspace-files/README.md` (1-90 of 158). I did not verify the assertions in the unread tails of those eight.
- **Partial reads of the Chinese READMEs.** `packages/sdk/client/README.zh.md` (1-60 of 140), `packages/sdk/server/README.zh.md` (1-60 of 143), `packages/api/terminal-controller/README.zh.md` (1-30 of 106), `packages/api/workspace-controller/README.zh.md` (1-14 of 74), `packages/api/workspace-files/README.zh.md` (1-14 of 158) and `packages/api/settings-controller/README.zh.md` (1-14 of 69) were read only in their headers. `packages/sdk/protocol/README.zh.md` and `packages/sdk/README.zh.md` were read in full. I saw no sign of the Chinese READMEs diverging from the English ones, but I did not verify the whole translation of the six partial ones.
- **The `dsh-typert-protocol` "Typert" Remote layer is outside this shard.** I could only observe it through usage: `TypertRemoteService`, the `@Remote` decorator, `RemoteError` + `RemoteErrorDetailsMap` augmentation, `RemoteSnapshotStream`, `remote.$stream` supervisors, and the `TypertLookup` registration. The *generation* of the client stubs, the transport encoding, the `workspaceFileScope` lookup wire format and the access-control model behind `remoteAccess.allows()` live in packages I did not read, so I describe their behaviour only as the call sites use it.
- **`dsh-fs`, `dsh-subprocess`, `dsh-session` and `dsh-workspace` are outside this shard.** I describe `fs.streamText`, `fs.readByteRange`, `fs.readBytes`, `fs.watch`, `fs.contains`, `subprocess.spawnTerminal`/`terminalEnvironment`/`resolveExecutable`, and `workspaceRegistry.*` strictly from how this shard's code calls them and from the tests' fixtures.
- **The Python SDK** (`python/`) is the design twin of `packages/sdk/client` and is not in this shard; the two are said to mirror each other's shapes without importing them, and I could not verify that the mirroring is currently in sync.
- **`packages/sdk/server/tests/built-scope-carrier.e2e.ts` is skipped at runtime** unless `packages/sdk/server/lib/index.js` exists (`describe.skipIf(!existsSync(jsonrpcBundle))`). I read the probe script but did not and could not execute it, so I cannot confirm the built-artifact guard currently passes.
- **I ran nothing.** No build, test, install or script from the clone was executed; every statement above comes from reading source, tests, READMEs and manifests.
