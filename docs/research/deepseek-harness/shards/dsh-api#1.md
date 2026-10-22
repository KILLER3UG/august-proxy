# deepseek-harness / dsh-api#1

## Shard shape

This shard is the **plumbing edge** of the harness, not the agent loop itself. It holds two unrelated-looking things that are actually one idea from two angles. First, `packages/acp/` (27 files) is an **automation-only Agent Client Protocol server**: a JSON-RPC stdio server that exposes fresh harness agents to out-of-process clients (subagents, test runners, scripted controllers) over the standard ACP v1 surface, deliberately omitting every DSH-specific presentation feature. Second, `packages/api/` (201 files) is the **Remote API layer**: a typed RPC stack where a browser/desktop Client calls Host business services (`session`, `job`, `account`, `skills`, `fileReferences`) over a shared Connection, with the Gateway owning unary dispatch, multiplexed live streams with Client→Host uplinks, forwarded Host events, and per-Peer access control. The pieces fit together like this: `remotes` decides *which* Host capabilities and forwarded events are exposed and provides the single allowlist; `gateway` carries the calls; `remote-access` decides what a non-owner Peer may call; `session-controller` owns the Session/Agent lifecycle and history; `job-controller` mirrors background-job output; `account-controller` exposes login state without secrets. The ACP server is the same discipline pointed the other way: a *standard* protocol, an automation-only surface, and an explicit list of what is not supported.

The recurring engineering stance across the shard is **"the protocol is a boundary, so the boundary validates"** — a strict descriptor per endpoint, an exact-key wire parser, a JSON-safety assertion, a lossless-canonical base64 check, a `__proto__`-proof env record, a per-method activation policy, an access decision *before* any lookup resolves, and a durable `read`/`skipped` distinction for every file.

## Per-file notes

### packages/acp/README.md
- Purpose: Package-group map for the `acp/` group: one package, an automation-only ACP server over JSON-RPC stdio, plus links to the automation-only design note and the multi-session note.
- Key abstractions: none (prose map).
- Data flow: points at `acp/acp/README.md` for the contract and `subagent/subagent-acp` for the matching client.
- Non-obvious design decisions: the group exists to serve "programs and automation"; the human-facing UI stays in the harness.
- Edge cases / failure handling: n/a.
- Surprising: the group README is a *routing* document, not a contract.

### packages/acp/README.zh.md
- Chinese mirror of the group map; identical package table and related-documentation links (bilingual-pair hashed).

### packages/acp/README.i18n.yaml
- Per-heading EN/ZH content-hash record (7 sections) consumed by `verify-translation-pairing`; a doc-drift gate input.

### packages/acp/acp/README.md
- Purpose: The package contract — the standard ACP v1 surface, the config fields, the known limitations.
- Key abstractions: `provider`, `model`, `sessionListPageSize` (default 100) as the only config.
- Data flow: `pnpm dsh --profile acp` starts the stdio server; a client initializes, creates/resumes a session, mounts MCP servers, selects a model, prompts, consumes semantic updates, closes.
- Non-obvious design decisions: "automation-only protocol" — the server intentionally exposes *only* standard ACP, so a DSH-specific card/plan/terminal never rides the wire.
- Edge cases / failure handling: one primary workspace only; raster prompt images only, and only with a durable attachment store *and* an exact image-capable route; MCP tools only (no resources/prompts); no transcript replay, no deletion, no fork, no `session/load`, no elicitation.
- Surprising: `authenticate` succeeds immediately — the server requires no credentials, and trust is the caller's problem.

### packages/acp/acp/README.zh.md
- Chinese mirror of the ACP package README; same call table and same limitations section.

### packages/acp/acp/README.i18n.yaml
- Per-heading EN/ZH content-hash record (41 sections) for `acp/acp/README.md`.

### packages/acp/acp/package.json
- Manifest for `@deepseek-ai/dsh-acp` v0.2.1-rc.2: exports `./src/*` raw sources plus `lib/index.js`; `@agentclientprotocol/sdk` 1.4.0 is a hard dependency, the ten `@deepseek-ai/dsh-*` packages are peerDeps, and `dsh-token-meter` is marked **optional**.

### packages/acp/acp/tsconfig.json
- `rootDir: src`, `outDir: lib/types`, and project references to cordis/schemastery plus session, agent, attachment, llm, token-meter, mcp-client, session-persistence and user-approval.

### packages/acp/acp/src/codec.ts
- Purpose: Pure translation from the harness turn outcome to ACP's terminal reason.
- Key abstractions: `turnEndToStopReason(reason: TurnEndReason): StopReason`.
- Data flow: `SessionCommandController`/the session's end reason → ACP `stopReason`.
- Non-obvious design decisions: `cancelled` is *reserved* for explicit `session/cancel` and disposal; a turn aborted by a hook or another owner is ordinary quiescence and reports `end_turn` (codec.ts:20-24). Collapsing the two would make "the client stopped it" indistinguishable from "the run died".
- Edge cases / failure handling: unknown/merge-extensible `TurnEndReason` members default to `end_turn` (v8-ignored as unreachable today).
- Surprising: `blocked` and `error` also become `end_turn` — the ACP wire has no error stop reason, so failure is visible only in the message stream.

### packages/acp/acp/src/content.ts
- Purpose: Admission and projection of ACP wire content (text + inline images) in both directions.
- Key abstractions: `AcpContentError` (with a `kind` of `invalid` | `internal` so the protocol handler can pick the right failure class), `CANONICAL_BASE64`, `admitAcpPrompt`, `assistantBlockToAcp`, `supportsAcpImagePrompts`.
- Data flow: inbound ACP image block → strict decode → durable attachment store (`saveImages`) → `ImageAttachmentRef` in the user message; outbound assistant image block → `attachments.readImage` → base64 ACP image.
- Non-obvious design decisions: canonical base64 is checked by **round-trip** (`data.toString('base64') !== block.data` → reject), not by a regex alone (content.ts:52-58) — that rejects URL-safe aliases and whitespace forms that a regex would let through. Image support is advertised only when *every* prerequisite is explicit: an attachment store, a configured exact route, and a model whose `inputModalities` includes `image`.
- Edge cases / failure handling: a missing store or an unresolvable route is `internal`; a bad mime type, non-canonical base64, or a text-only model is `invalid`. `AcpContentError` messages carry no raw binary.
- Surprising: an image whose `mimeType` is legal but whose *bytes* are not a valid image is never checked here — the limit is the byte cap and the route, not decoding.

### packages/acp/acp/src/mcp.ts
- Purpose: Translate ACP MCP server declarations into DSH MCP client configurations.
- Key abstractions: `AcpMcpConfigError`, `mountAcpMcpServers`, `resolveMcpConfigs`, `normalizeServerName`, `entriesToRecord`.
- Data flow: ACP `mcpServers[]` → validated `McpClient.Config` → `agentCtx.plugin(McpClient, config)` on the *unpublished* Agent scope, so the tools exist before the client can see the session.
- Non-obvious design decisions: env/header maps are built with `Object.create(null)` (mcp.ts:84) because `__proto__` is a legal env var and header name and must stay *data*, not invoke `Object.prototype`'s setter. Duplicate detection is case-insensitive for headers and case-sensitive for env (mcp.ts:102). Server names are slugified plus an 8-hex sha256 of the original so two different human names cannot collide.
- Edge cases / failure handling: only `stdio` and `http` transports are supported; a stdio `command` must be absolute; env names may not be empty, contain `=` or NUL; header names/values are validated by `node:http`; a provider schema error is re-thrown as an indexed `mcpServers[i] is invalid`.
- Surprising: `failOnStartupError: true` is forced on every mounted server — an MCP server that cannot start fails the session rather than silently degrading the tool surface.

### packages/acp/acp/src/model-control.ts
- Purpose: Expose the Agent's provider/model/reasoning selection as standard ACP session config options.
- Key abstractions: `AcpModelControl`, `AcpModelConfigError`, `PROVIDER_DEFAULT_REASONING_VALUE` (the empty opaque ACP value).
- Data flow: `llm.listProviders/listModels/resolveCallConfig/resolveModelInfo` → `SessionConfigOption[]`; a `set()` mutates the Agent-scoped `ModelSelectionRef` and returns the complete option state.
- Non-obvious design decisions: the model option's *value* is `JSON.stringify([provider, model])` (model-control.ts:236) — the full route identity, so two providers offering the same model id are distinguishable. The empty string is a disjoint "provider default" reasoning choice because DSH effort ids are non-empty (model-control.ts:10-11). Mutations are serialised through a `tail` promise so two concurrent `set()` calls cannot interleave.
- Edge cases / failure handling: an unadvertised reasoning effort is rejected; a temporarily unavailable provider catalog keeps the currently selected route rather than clearing it.
- Surprising: `pinTurn`/`releaseTurn` let one admitted prompt hold its route for every step of its turn, and `releaseTurn` only clears the *exact* turn's pin (model-control.ts:75-85) — a later turn's pin is never dropped by an earlier turn's release.

### packages/acp/acp/src/updates.ts
- Purpose: Project committed DSH session events onto the standard ACP update vocabulary.
- Key abstractions: `assistantUpdates`, `toolCallUpdate`, `toolResultUpdate`, `usageUpdate`.
- Data flow: `assistant/message` → `agent_thought_chunk` (reasoning) + `agent_message_chunk` (text/image) + optional `usage_update`; `tool/call` → `tool_call`; `tool/result` → `tool_call_update` with `status: failed` when `isError`.
- Non-obvious design decisions: a tool call is projected as the *generic* `kind: 'other'` lifecycle rather than a per-tool shape — the automation surface carries semantics, not DSH presentation. Malformed model JSON is preserved as an opaque `rawInput` string (updates.ts:105-110) rather than dropped, so the client can see what the model actually produced.
- Edge cases / failure handling: a `usage_update` is emitted only when *both* a token meter and a context window are known; without either the frame is omitted rather than guessed.
- Surprising: empty reasoning text is dropped (a `reasoning` block with `text: ''` produces no frame at all), so "the model thought" is never a zero-length chunk.

### packages/acp/acp/src/session.ts
- Purpose: One ACP session's whole lifecycle — Agent composition, model route, prompt admission, update projection, cancellation, teardown.
- Key abstractions: `AcpSession`, `InflightPrompt` (admission promise, turn number, end reason, output vs agent error), `SubagentLifecycle` (a local interface, so the ACP package does not depend on the subagent package), `selectionFor()`.
- Data flow: `session/new` → mount MCP servers → install model selection → create the Agent → publish; `session/prompt` → admit content → pin the model selection for the turn → follow the agent's session events → project updates → settle the prompt promise with an ACP `stopReason`.
- Non-obvious design decisions: the ACP package defines its own `SubagentLifecycle` interface (session.ts:23-28) rather than importing `@deepseek-ai/dsh-subagent` — the dependency is structural, not nominal. On teardown the bridge **drains continuable subagents before releasing its own sessions** (session.ts:461-463), because a continuable activation outlives the turn that started it and the agents whose runtime it depends on must go last. Cancellation races a `waitForChildren` promise against the cancellation signal (session.ts:526) so a cancel never waits forever on a child.
- Edge cases / failure handling: a prompt that arrives while another is in flight is refused; the `InflightPrompt` record keeps `outputError` and `agentError` apart so a projection failure and a turn failure produce different wire errors; the settlement promise is guarded against a late failure with a `catch` that only rejects if the record is still the current one.
- Surprising: `selectionFor()` (session.ts:78-94) restores the *latest logged* route before falling back to deployment config, and drops `reasoningEffort` when the adapter declares it as a default — so a resumed session does not inherit a stale effort it did not choose.

### packages/acp/acp/src/index.ts
- Purpose: The server plugin: JSON-RPC stdio transport, the ACP method table, session new/list/resume/close, prompt, cancel, setConfigOption, and a no-op authenticate.
- Key abstractions: `AcpConfig` (schemastery `Schema<AcpConfig>` with `sessionListPageSize` default 100), `invalidParams`/`internalError` helpers that *preserve* the detail in the wire message.
- Data flow: `ndJsonStream` over stdio → the ACP SDK's `methods.agent.*` → per-session `AcpSession` → notifications back on the same stream.
- Non-obvious design decisions: plain handler errors become a *generic* wire internal error while deliberate failures keep their detail (index.ts:64-72) — a bug in the bridge must not leak internals, but a caller-correctable error must be actionable. `sameDirectory()` compares directories by **physical** identity via `realpath` and falls back to lexical comparison only for unresolvable paths (index.ts:531-539), so a symlinked workspace is not treated as a different one. `additionalDirectories` is refused outright rather than partially supported.
- Edge cases / failure handling: `cwd` must be absolute; a request naming an unknown session is refused; `session/list` pages at `sessionListPageSize`.
- Surprising: stdout carries *only* protocol traffic — the README's "keep logging off it" is a real constraint on the plugin's logging.

### packages/acp/acp/tests/harness.ts
- Purpose: In-memory ACP transport fixture wired over the **real** agent factory and agent loop.
- Key abstractions: `MockAdapter` (a scripted `LlmAdapter` that records requests and can `hang`), `makeBridgeHarness`, `textResponse`/`errorResponse`/`maxTokensResponse`.
- Data flow: a script of `StreamChunk[]` arrays is consumed one per `generate()` call; the harness connects the ACP client and server apps over paired NDJSON streams.
- Non-obvious design decisions: the mock advertises `inputModalities` and reasoning efforts so the image-capability and model-control paths are exercised against *real* code rather than stubs.
- Edge cases / failure handling: `'hang'` yields a partial block then blocks until the abort signal fires — this is how cancellation and disposal are tested.
- Surprising: the harness is the only place that knows how to fake an LLM; every ACP spec imports it rather than rolling its own.

### packages/acp/acp/tests/codec.spec.ts
- Table-driven spec pinning each `TurnEndReason` member to its ACP `StopReason`.

### packages/acp/acp/tests/approval.spec.ts
- Machine permission policy: the two advertised one-shot choices map to `allowed-once` / `rejected`; an unknown option id and a client-thrown error both **fail closed** (`unavailable`); a foreign agent with the same session id is delegated rather than answered, and a request with no protocol tool-call identity is delegated too.

### packages/acp/acp/tests/bridge.spec.ts
- The main bridge spec (1005 lines): capability advertisement carries no private metadata; image prompts are advertised only with a capable route *and* an attachment store; an unsupported protocol version negotiates down; a session create/prompt/close round-trips; resource links render as textual references; an unknown session prompt is refused; `additionalDirectories` is refused.

### packages/acp/acp/tests/content.spec.ts
- Rich-content codec spec: every deployment prerequisite must be explicit before image prompting is advertised; an injected/malformed baseline is refused; an assistant image with no store is an `internal` failure and a missing attachment is "unavailable or corrupt".

### packages/acp/acp/tests/dispose.spec.ts
- Connection ownership: disposal cancels a running prompt and awaits agent teardown; asynchronous assistant-image delivery is *drained* before sessions are released; continuable subagents are drained first; disposing a session-less bridge is idempotent.

### packages/acp/acp/tests/edges.spec.ts
- Output boundary: the exact committed update order (`agent_thought_chunk`, `usage_update`, `tool_call`, `tool_call_update`, `agent_message_chunk`, `usage_update`); events from agents the bridge does not own are ignored; an output-conversion failure is contained and logged instead of escaping; a client that rejects notifications still settles the prompt normally.

### packages/acp/acp/tests/mcp.spec.ts
- ACP MCP declaration mapping: name normalization (`Fancy_server_<8 hex>`), stdio/HTTP field preservation, duplicate and malformed env/header rejection, `__proto__` named entries preserved as data, and provider schema failures mapped to an indexed declaration error.

### packages/acp/acp/tests/model-control.spec.ts
- Model control: an absent route yields no options; an unlisted current route is *synthesized* into the option list; a temporarily unavailable provider catalog keeps the selected route; an unadvertised reasoning effort is rejected; a provider-owned reasoning default is exposed and restorable as the empty value.

### packages/acp/acp/tests/multi-session.spec.ts
- Multi-session isolation: answers demultiplex by session id; cancelling one session does not affect another; each session enforces its own single in-flight prompt; bridge disposal drains every live session.

### packages/acp/acp/tests/turns.spec.ts
- Prompt lifecycle: a max-token turn keeps its committed text; a committed assistant image is delivered as verified base64; cancellation settles; a delegated subagent inside a prompt completes; a pre-step failure rejects the prompt with `turn failed: …`; a removed inbox message settles the prompt as cancelled.

### packages/acp/acp/tests/updates.spec.ts
- Update projection: empty reasoning and unsupported blocks produce no frames; a usage update needs *both* measured tokens and a context window (and the meter is not called when capacity is missing); malformed tool input is preserved as an opaque string and a failed result carries no hidden content.

### packages/api/README.md
- Purpose: Package map for the application's Remote layer.
- Key abstractions: `remotes` (selection), `gateway` (transport), `remote-access` (policy), `job-controller`, `session-controller`, plus the settings/workspace/terminal/workspace-files packages that live in other shards.
- Data flow: Client → Host unary calls over the shared Connection; stream items Host → Client on the Gateway mux; a stream's uplink Client → Host on the same logical stream.
- Non-obvious design decisions: "streaming session data is deliberately outside it" — the shared Connection carries the RPC, not the session stream.
- Edge cases / failure handling: responses that do not fit Remote invocation (streamed downloads) use exact Connection Fetch routes instead.
- Surprising: the Gateway owns transport while every controller package owns *its own* domain, so the session controller never talks to the WebSocket.

### packages/api/README.zh.md
- Chinese mirror of the api/ package map; identical package table and the same note about session streaming.

### packages/api/README.i18n.yaml
- Per-heading EN/ZH content-hash record (6 sections) for `packages/api/README.md`.

### packages/api/gateway/README.md
- Purpose: The full Gateway contract — Host dispatcher, Client projection, streams, forwarded events, error vocabulary.
- Key abstractions: `ctx.typertGateway` (Host), `ctx.remote` (Client), `InvocationDescriptor`, `TypertGatewayError` with `gateway/*` codes.
- Data flow: an inbound RPC resolves the descriptor, validates the exact named arguments, resolves lookup and Context identities, consults access control, and invokes the business method; a `Remote` method marked `{ mode: 'stream' }` returns an `AsyncIterable` carried on the Gateway-owned WebSocket mux.
- Non-obvious design decisions: **every call must name its Peer** — the Gateway never supplies a default (README §Host). Strict mode reads generated descriptors from `ctx.typert.local`; SRC mode is a *development* fallback for endpoints that never had a strict definition, and withdrawing an observed strict definition **fails** rather than weakening validation. The Gateway provides the uplink *window* (inbox capacity and JSON envelope cost) but issues no credits: a Client that sends faster than the method reads fails its stream with `gateway/uplink-overflow`, and no uplink item is replayed across carrier generations.
- Edge cases / failure handling: a resolver that refuses on policy grounds (cold-resume failure, ownership fence) throws its *own* `RemoteError` and its code reaches the caller unchanged; a denied call throws `remote-access/denied` with `{ action, reason }` before any Session is activated.
- Surprising: unclaimed endpoints return 404 unless an exact Fetch route owns them, and a `TypertGatewayError` is a `RemoteError` subclass so business errors and infrastructure errors share one wire shape.

### packages/api/gateway/README.zh.md
- Chinese mirror of the Gateway README; same resource-resolution precedence chain and the same uplink-window caveat.

### packages/api/gateway/README.i18n.yaml
- Per-heading EN/ZH content-hash record (9 sections) for `gateway/README.md`.

### packages/api/gateway/package.json
- Manifest: dual `node`/`browser` `./client` export, a `./stream-protocol` export for native desktop callers, the `dsh.client` block injecting typert-registry and client-connection, and a `tsdown` bundle script.

### packages/api/gateway/tsconfig.json
- Solution tsconfig with no files of its own; references the host and client faces only.

### packages/api/gateway/tsconfig.host.json
- Host face: six host-side source files compiled with the host base config, referencing cmdline, host-webserver, remote-access, util/deque and util/timeout.

### packages/api/gateway/tsconfig.client.json
- Client face: eight client-side source files compiled with the client base config, referencing cordis, client-connection, typert-protocol, util/deque and util/crypto.

### packages/api/gateway/tsdown.config.ts
- Three-line tsdown config using the shared `clientBundle` helper with the `dualClient` flag.

### packages/api/gateway/locale/en.json
- Locale metadata stub: `meta.title = api-gateway`.

### packages/api/gateway/locale/zh.json
- Chinese locale metadata: title 远程调用网关 plus a one-line description.

### packages/api/gateway/src/types.ts
- Purpose: Carrier-independent request, service and error contracts.
- Key abstractions: `InvokeRemoteRequest` (namespace, method, args, optional `uplink`, `uplinkWindow`, required `peer`, optional `signal`), `TypertRemoteEventFrame`/`Invocation`/`Outcome`, `TypertGateway` with `invoke()` and `stream()`.
- Data flow: a carrier decodes its envelope into an `InvokeRemoteRequest`; the Gateway resolves and dispatches; the result is returned carrier-agnostically.
- Non-obvious design decisions: `peer` is a **required** field of every request — the Gateway refuses to invent identity. `uplinkWindow` is optional because carriers without an encoded-frame inbox limit have none.
- Edge cases / failure handling: the types carry no transport assumptions, so a carrier change does not touch dispatch.
- Surprising: `TypertRemoteEventOutcome` has a `next` variant — the Client can *delegate* a forwarded waterfall back to the Host chain rather than answering it.

### packages/api/gateway/src/remote-error-codes.ts
- Purpose: Declare the 21 `gateway/*` failure codes in the shared `RemoteErrorDetailsMap`.
- Key abstractions: `TypertGatewayFaultDetails` (always the endpoint, sometimes the field).
- Data flow: both the Host face and the Client face import this module, so both programs see the same map entries.
- Non-obvious design decisions: the file is explicitly "face-neutral" — a code declared only on one side would let the other side classify an error as unknown.
- Edge cases / failure handling: `gateway/uplink-overflow`, `gateway/protocol` (an uplink item after `end`), and the codec code `gateway/input-invalid` name the three uplink failures specifically.
- Surprising: the list is alphabetically sorted and hand-maintained, which is why it is a declared map rather than a computed union.

### packages/api/gateway/src/access.ts
- Purpose: Resolve the resources one call or one forwarded event touches, from already-validated arguments.
- Key abstractions: `callResources`, `eventResources`, the `ResourceIds` = `readonly unknown[] | 'invalid'` union.
- Data flow: per resource kind the source is, in precedence order: the method's `resources` reader → every lookup parameter whose provider declares the kind → the Context identity of a Context method whose Host adapter declares the kind → the kind's default field registered in `typert.resources` (read from a top-level argument, else from the first object argument).
- Non-obvious design decisions: the resolution happens *before* any lookup or Context resolves, so the access decision is made on wire identities rather than on objects that would have to be materialised first (access.ts:29-38). A later source **replaces** an earlier one for its kind but keeps the kind's position, so the resource order is stable.
- Edge cases / failure handling: a reader that throws or returns an empty list, a default field holding an array, or a non-string resource id makes the whole resolution `undefined` — *not* `global`. A call that names no resource at all touches `global` alone.
- Surprising: for a forwarded *event*, a reader returning `undefined` makes the notification invalid rather than global, because "an event carries every resource it declares" is a stronger promise than a call's.

### packages/api/gateway/src/index.ts
- Purpose: The live Typert Remote dispatcher over Cordis Services and registered providers (1732 lines).
- Key abstractions: `TypertGatewayService` (`ctx.typertGateway`), `GatewayInvocation`, `PreparedInvocation`, `ResolvedBinding`, `TypertGatewayError`.
- Data flow: `invoke()`/`stream()` → descriptor resolution (strict, else SRC) → exact named-argument validation → lookup/Context identity resolution → access decision → business method invocation → result encoding (strict codec `encode()` or SRC recursive byte detection).
- Non-obvious design decisions: **withdrawing an observed strict definition fails** with `gateway/definition-unavailable` and the message "its strict definition was withdrawn and SRC fallback is forbidden" (index.ts:862-869) — a definition that was once strict can never silently degrade to the permissive SRC path. Two active Services exporting the same endpoint is `gateway/ambiguous-endpoint`, not a last-one-wins. The cancellation slot is descriptor *metadata*, not a wire argument: a method declares `signal: AbortSignal` as its last Host parameter and the Gateway injects it after the decoded business arguments. A non-owner call is checked at index.ts:787-804, and an invalid resource resolution is refused with reason `resource-invalid` *before* `decide()` is even asked.
- Edge cases / failure handling: SRC mode requires the cancellation parameter to be the *final* parameter, rejects a parameter matching more than one lookup provider, rejects two parameters using the same wire field, and rejects a Context identity that collides with a wire field — all `gateway/signature-invalid`. JSON-safety is enforced recursively (sparse arrays, symbol keys, non-enumerable properties, accessors and cycles are all rejected) because the value crosses a wire.
- Surprising: `srcDescriptor` (index.ts:902) builds a whole descriptor at runtime from the *method's parameter names* — a deliberate development escape hatch, and the reason the strict-withdrawal rule has to exist at all.

### packages/api/gateway/src/stream-protocol.ts
- Purpose: Wire messages for the Gateway mux and the forwarded-event protocol.
- Key abstractions: `REMOTE_STREAM_MUX_PATH = '/api/remote.mux'`, `REMOTE_EVENT_STREAM_ENDPOINT = '$events'`, `REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'`, and the frame unions (`RemoteEventDownlinkFrame`, `RemoteEventReadyFrame`/`EmitFrame`/`InvocationFrame`/`CancellationFrame`).
- Data flow: client → server frames (`open`/`item`/`end`/`cancel`) and server → client frames (`item`/`end`/`error`), each parsed by a strict parser.
- Non-obvious design decisions: every parser is **exact-key**: one unexpected key is a rejection (the specs assert `extra: true` fails on every message type). The uplink item must be *lossless* JSON — a `-0` or a sparse array is refused.
- Edge cases / failure handling: `parseRemoteEventResult` accepts delegation (`next`), a value (`result`) or a structured `rejected` carrying name/message/optional code/details; a `rejected` outcome must not carry extra keys.
- Surprising: the `$events` and `$events/result` endpoints are *internal* — the event stream is a logical stream the Gateway owns, not a business method.

### packages/api/gateway/src/stream-server.ts
- Purpose: The Host WebSocket owner for multiplexed Remote streams.
- Key abstractions: `RemoteStreamMuxServer`, `RemoteStreamOpener`, `RemoteStreamFailureMapper`, `UplinkInbox`, `rejectRemoteStreamUpgrade`.
- Data flow: an admitted HTTP upgrade → a `ws` socket bound to the Peer admitted at upgrade → per logical stream, an `open` frame creates an opener invocation, `item` frames feed the uplink inbox, `end` closes it, `cancel` aborts the stream's `AbortController`.
- Non-obvious design decisions: **two** missed heartbeats terminate a socket (`MAX_MISSED_HEARTBEATS = 2`, stream-server.ts:42) and a *buffered downlink write counts as liveness* — the same reasoning as a TCP proxy, where a successful write only means the peer accepted the bytes. The uplink inbox is byte-bounded (`streamInboxBytes`); exceeding it fails the stream with `gateway/uplink-overflow` rather than growing memory (stream-server.ts:345-360).
- Edge cases / failure handling: an upgrade can be refused with a raw 401/403/409 written directly to the socket (`rejectRemoteStreamUpgrade`), because at that point the WebSocket server does not own the socket yet. A failure that cannot be serialised closes the socket with code 1011.
- Surprising: the socket closes when the *Peer's* scope is disposed — the Peer owns the connection's lifetime, not the stream.

### packages/api/gateway/src/client/index.ts
- Purpose: The Client projection of generated Typert descriptors.
- Key abstractions: `ClientRemote` (`ctx.remote`), `$stream()`, `$host`, `ScopedProjection`, `InstalledMethod`.
- Data flow: a contribution's descriptors are mounted as traced `remote.<namespace>` services; a call becomes a `ConnectionHandle.rpc.call`; a stream becomes a Gateway mux stream.
- Non-obvious design decisions: **no JavaScript Proxy participates** in method lookup, invocation or type exposure (module doc) — the namespace is a real object with real methods, so a typo is a compile error rather than a runtime `undefined`. `normalizeConnectionStream` (index.ts:881) re-wraps a worker transport's structurally-serialised failure so a `RemoteError` raised in the Host page half arrives in the worker as a real `RemoteError` again, not as a plain `Error`.
- Edge cases / failure handling: withdrawing a pending invocation resolves it as "no longer mounted" instead of hanging; a namespace survives until its *last* method leaves.
- Surprising: `$host` is a plain read with no store, no subscription and no generation counter — the host facts are static per connection, so a reactive surface would be over-engineering.

### packages/api/gateway/src/client/stream-client.ts
- Purpose: The Client owner of the multiplexed Remote stream socket.
- Key abstractions: `RemoteStreamMuxClient`, `RemoteStreamCarrierError`, `StreamInbox`, `UplinkPump`, `SocketWaiter`.
- Data flow: one physical WebSocket shared by many logical streams; a `revision` counter invalidates pending socket waiters on reconnect; each logical stream keeps its own inbox and uplink pump.
- Non-obvious design decisions: `RemoteStreamCarrierError` is a *distinct* class from a business failure so a domain can tell "the carrier died, retry" from "the Host said no" (stream-client.ts:15-24). `waitForReconnect` distinguishes answering Clients (wait for Connection to replace a lost socket) from passive Clients (fail later opens immediately) — the constructor takes the flag (stream-client.ts:68-71).
- Edge cases / failure handling: `reconnect()` cancels the current socket, fails every logical stream with the carrier error and starts a fresh attempt; the socket URL is derived from `document.baseURI` or a shell-supplied `__DSH_TRANSPORT__.streamBaseUrl`, and the scheme is upgraded to `wss:` for `https:`.
- Surprising: the uplink pump is a separate coroutine from the downlink reader, so a slow business method still lets the client *send* (bounded by the inbox) rather than deadlocking on one socket.

### packages/api/gateway/src/client/remote-stream.ts
- Purpose: Reconnecting lifecycle for one single-consumer logical Remote stream.
- Key abstractions: `RemoteStream<Item>`, `RemoteStreamItem<Item>` (`generation`, `value`, `signal`, `accept()`), `RemoteStreamOptions` (`open`, `ended`, `carrierFailed`).
- Data flow: `open(signal)` opens a physical generation; each item is annotated with a monotone generation number; the consumer calls `accept()` after validating the opening baseline or cursor; a generation end is classified by the domain's `ended(accepted)` function.
- Non-obvious design decisions: the **`accept()` handshake** (remote-stream.ts:16) is the core idea — the domain owns its opening item, and only after it accepts does a normal end count as "the generation was healthy" (retryable) rather than "it died before delivering" (terminal). `terminalStreamFailure` (remote-stream.ts:206) turns an unmarked throw into `gateway/internal` so a local bug cannot be mistaken for a business refusal, while marked failures pass through verbatim.
- Edge cases / failure handling: the carrier class never escapes as a terminal outcome — it stays the retry-internal signal fed to `carrierFailed`; a value that arrives after disposal begins is dropped; `dispose()` is idempotent and closes the iterator.
- Surprising: `restart()` interrupts the current generation and immediately requests a replacement *without* waiting for the Host to be available again — a deliberate "give me a new one now" primitive on top of a reconnecting stream.

### packages/api/gateway/src/client/snapshot-stream.ts
- Purpose: Baseline-and-delta protocol layered over a reconnecting Remote stream.
- Key abstractions: `RemoteSnapshotStream<Snapshot, Delta>`, `RemoteSnapshotStreamOptions` (`isSnapshot`, `replace`, `update`, `failed`).
- Data flow: each generation opens with exactly one snapshot, then deltas; the previous domain snapshot **stays published** while the underlying stream retries.
- Non-obvious design decisions: "a replacement becomes accepted only after the domain owner applies it successfully" (module doc) — the domain's `replace()` is the accept point, so a domain that rejects the new snapshot keeps the old one. A second snapshot in one generation, or a delta before the first snapshot, is a protocol violation (snapshot-stream.ts:77-87).
- Edge cases / failure handling: a terminal failure is published through `failed(error)` rather than thrown at the consumer.
- Surprising: the snapshot stream deliberately does *not* re-deliver the baseline on every reconnect — it re-opens the generation and lets the underlying `RemoteStream` carry the accept handshake.

### packages/api/gateway/src/client/journal-stream.ts
- Purpose: Cursor, page and live-tail coordination over a reconnecting Remote stream.
- Key abstractions: `RemoteJournalStream`, `RemoteJournalFrame` (`opened`/`entry`/`notification`), `RemoteJournalChange` (`replace`/`prepend`/`append`/`notification`), `RemoteJournalStreamOptions` (`first`, `last`, `compare`, `follows`, `publish`, `failed`).
- Data flow: a `opened` frame carries the cursor and the first page; `entry` frames append live; the domain's `compare`/`follows` decide whether an arriving entry is contiguous.
- Non-obvious design decisions: **the domain supplies the cursor algebra** (`compare`, `follows`, `first`, `last`) rather than the stream assuming a sequence number — so a journal keyed by a timestamp or a compound cursor works unchanged. A page whose entries are discontinuous is a protocol violation, not a silent gap (journal-stream.ts:558).
- Edge cases / failure handling: an inverted cursor range inside one entry is a violation; a page that does not end at its requested cursor is a violation; a `notification` variant only exists in the type when the domain declares one.
- Surprising: the "repair" path (a gap in the live stream triggers a tail page) is implemented in the *same* class as the normal path, so the repair page and the normal page are the same code path.

### packages/api/gateway/src/client/remote-events.ts
- Purpose: Client owner for forwarded Remote Event subscriptions and deliveries.
- Key abstractions: `ClientRemoteEvents`, `RemoteEventListener`, `PrivateEventContext`, `REMOTE_EVENT_NEXT` (a private symbol that cannot collide with a JSON listener result).
- Data flow: a `subscribe()` registers a listener under a private UUID-prefixed Cordis event key; the `$events` stream delivers `ready`/`emit`/`waterfall` frames; a waterfall is dispatched through Cordis's `waterfall()` and the result is posted back over the `$events/result` HTTP endpoint.
- Non-obvious design decisions: the event key is **private and per-client-instance** (`internal/api-gateway/remote-event/<uuid>/`) so a consumer cannot collide with another client's registration and cannot forge a forwarded event. A listener that returns `REMOTE_EVENT_NEXT` delegates to the next listener in the chain; the symbol is used precisely because a JSON result could be anything.
- Edge cases / failure handling: the client validates every frame's shape before dispatch (`hasExactRemoteEventKeys`, `isPlainObject`); an invalid frame throws rather than dispatching a half-formed event.
- Surprising: the Client mirrors the *Host's* Cordis waterfall semantics on its own side, so a business method that expects `next()` behaves the same locally and remotely.

### packages/api/gateway/tests/peer.ts
- Test helper creating an owner Peer per Context tree and an independent Peer per principal, so every in-process call names its Peer explicitly.

### packages/api/gateway/tests/browser-credentials.ts
- Test helper: an in-memory credential record owner plus a process-token→Cookie exchange via `connection.authorizeIndex`.

### packages/api/gateway/tests/operator-connect-fixture.ts
- Loader-mounted fixture service (`identity`, `hold`, `follow` Remotes plus a `pending()` interaction producer) used by the authenticated-transport specs; it observes the call's Peer and signal and registers a per-call effect.

### packages/api/gateway/tests/echo-stream.host.spec.ts
- One echo stream exercised over both carriers (in-process and WebSocket), proving the two transports serve the same uplink semantics.

### packages/api/gateway/tests/stream-protocol.host.spec.ts
- Wire-parser spec: every client and server message variant accepted, every extra-key or wrong-type variant rejected, and a non-lossless-JSON uplink item refused.

### packages/api/gateway/tests/remote-event-protocol.host.spec.ts
- Event-result protocol spec: delegation/result/rejection shapes accepted and every malformed variant rejected; the removed logical-stream `input` message is refused; the lossless-JSON requirement is pinned with sparse arrays, symbol keys, hidden properties and `undefined` members.

### packages/api/gateway/tests/strict-source.host.spec.ts
- Strict-vs-SRC spec: strict validation runs *before* the Service is invoked (the service's call count proves it); SRC fallback tolerates an extra field; a withdrawn strict definition fails with `gateway/definition-unavailable` and the service is never called.

### packages/api/gateway/tests/gateway-access.host.spec.ts
- Access spec (940 lines): the per-kind resource-resolution precedence chain, readers called with the method's positional arguments, list filtering through `allows()`, and the invalid-resource cases that must not fall back to `global`.

### packages/api/gateway/tests/gateway.host.spec.ts
- Host dispatch spec (1668 lines): strict and SRC validation, the JSON-safety rejections (cyclic, sparse, symbol-keyed, non-enumerable, accessor), `gateway/provider-mismatch` and `gateway/binding-invalid`, unary vs stream mode separation, and the preservation of the original business error.

### packages/api/gateway/tests/gateway-stream.host.spec.ts
- Stream-host spec (1841 lines): uplink iteration, abort-before-iteration, per-stream cancellation over one multiplexed socket, a non-JSON error payload closing the socket with 1011, the bounded uplink inbox, and the configured heartbeat interval.

### packages/api/gateway/tests/gateway.client.spec.ts
- Client spec (3477 lines): descriptor mount validation (a weak codec is refused with "has no strict codec"), invocation arity checks, namespace withdrawal, worker-local failure normalization, WebSocket multiplexing without the RPC caller, and binary results decoded through a strict codec without freezing the native data.

### packages/api/gateway/tests/journal-stream.client.spec.ts
- Journal spec (1118 lines): the `opened` frame, contiguous entry merging, a superseded repair page replaced by the next generation, a tail reread when queued entries advance past the first repair page, entries merging while a replacement page loads, and the lifecycle guards before and after `open`.

### packages/api/gateway/tests/control-retry.client.spec.ts
- Retry spec: generations are annotated and the retry state resets after acceptance; one isolated retry is permitted while the Host is available; a stream disposed before consumption ignores a later `restart`; a value that arrives after disposal begins is dropped.

### packages/api/gateway/tests/stream-server.host.spec.ts
- Mux server spec (734 lines): Ping control frames without application messages, the two-missed-heartbeat terminate rule, inbound frames counting as liveness while Pong is delayed, a buffered downlink write counting as liveness, and the rejection path that writes a raw HTTP response.

### packages/api/gateway/tests/authenticated-node.client.spec.ts
- Non-page Client spec: one credential spans HTTP and WebSocket; a unary call completes while the lifecycle socket is still `CONNECTING`; `interactions=none` refuses `$on` and `$stream` while `answer` accepts them; cancellation is contained until the physical socket closes.

### packages/api/gateway/tests/operator-connect.host.spec.ts
- Connect lifecycle through real Loader, HTTP and WebSocket composition: HTTP admitted before attachment, a second mux refused with 409, slow stream cleanup delaying the Operator release, and a guard that refuses to delete any temp path outside the fixture's own directory.

### packages/api/account-controller/README.md
- Purpose: The account screen contract.
- Key abstractions: `ctx.remote.account` — getState, getProfile/getBalance, getUnnotifiedBonuses, ackBonusNotified, startSignIn, cancelSignIn, signOut, watch.
- Data flow: every operation that reaches Platform takes the calling UI's `AccountClientMetadata` (client version, language, UTC offset in seconds) so the Host reports *the requesting UI*, not the last caller it saw.
- Non-obvious design decisions: `watchExpiry` delivers live credential-expiry notifications **without an initial item or replay** — it is a one-shot toast handoff, not a state stream (README §Use this package).
- Edge cases / failure handling: `getUnnotifiedBonuses` returns null and `ackBonusNotified` returns false while the account is absent or has changed; failures the caller should retry arrive as thrown Remote errors; cancellation names the attempt id so a stale screen cannot cancel a newer login.
- Surprising: the controller maintains **no independent account state** — it forwards to the account service, and `hasRunningAccountTasks` reads the Agents' latest logged request context rather than any account-side registry.

### packages/api/account-controller/README.zh.md
- Chinese mirror; same "no credential payloads" contract and the same limitation that an attempt cannot be resumed after the Host exits.

### packages/api/account-controller/README.i18n.yaml
- Per-heading EN/ZH content-hash record (11 sections).

### packages/api/account-controller/package.json
- Manifest: exports `./types`, `./typert`, `./remote` and `./locale/*.json`; zod dependency; account, typert-protocol and agent as peerDeps.

### packages/api/account-controller/tsconfig.json
- `rootDir: src`, `outDir: lib/types`, referencing cordis, deepseek-account, typert-protocol and core/agent.

### packages/api/account-controller/locale/en.json
- Locale metadata stub: `meta.title = api-account-controller`.

### packages/api/account-controller/locale/zh.json
- Chinese locale metadata: title 账号操作接口.

### packages/api/account-controller/src/index.ts
- Purpose: The `account` Remote namespace.
- Key abstractions: `AccountController extends TypertRemoteService`, namespace `account`.
- Data flow: each `@Remote` method forwards to `ctx.deepseekAccount`; `watch` forwards the subscriber's `AbortSignal`; `watchExpiry` turns a Cordis event into an async generator.
- Non-obvious design decisions: `watchExpiry` is hand-written rather than delegated (index.ts:96-112) because it must deliver **no replay** and must wake on abort — the provider has no such API. A `pending` counter plus a `wake` resolver is the whole mechanism.
- Edge cases / failure handling: the `finally` block removes the abort listener and the Cordis subscription, so a cancelled subscriber leaves nothing behind.
- Surprising: `hasRunningAccountTasks` is a **synchronous** `@Remote` — it answers from the live Agent registry, so a UI can ask "will signing out kill my work?" without a round trip's latency.

### packages/api/account-controller/src/types.ts
- Two-line type-only re-export of the account vocabulary; the module doc states Account Remote values contain no credential payloads.

### packages/api/account-controller/tests/controller.spec.ts
- Delegation spec: every Remote forwards to the provider unchanged (asserted with `toHaveBeenCalledExactlyOnceWith`), a failure propagates as the *same* error object, `watch` receives the subscriber lifetime signal, and `watchExpiry` delivers only to current subscribers and stops on disconnect.

### packages/api/account-controller/tests/signout-impact.spec.ts
- Sign-out impact spec: `hasRunningAccountTasks` reads running agents' latest logged request context, excluding idle agents and API-key (non-account) routes.

### packages/api/job-controller/README.md
- Purpose: The job observation contract.
- Key abstractions: `ctx.jobController` (Host) and `ctx.remote.job` (Client): `job.list`, `job.follow`, `job.kill`.
- Data flow: `job.list` mirrors the session-visible set as whole-set frames; `job.follow` delivers one job's retained output from an absolute byte offset, then a terminal status once the job settled and its ring drained.
- Non-obvious design decisions: both streams are **non-consuming** — the model's `job_output` cursor and notice state never observe them, so a browser watching a job does not steal the model's output. `job.kill` records the reason `cancelled by the user`, and because `dsh-tool-jobs` withholds a notice only for the *model's own* `job_kill`, the owning agent's completion notice still arrives with the reason included.
- Edge cases / failure handling: `job.kill` answers `{ outcome: 'requested' }` or `{ outcome: 'already-finished' }` and rejects an id the session cannot see as `job/not-found`.
- Surprising: the registry's **owner fence is the only access rule** — a child session's own jobs are killable from its list like any other, because the fence is per-session, not per-ownership.

### packages/api/job-controller/README.zh.md
- Chinese mirror; same kill reason and the same stated limitation that the ring is a best-effort live preview, not a terminal transcript.

### packages/api/job-controller/README.i18n.yaml
- Per-heading EN/ZH content-hash record (9 sections).

### packages/api/job-controller/package.json
- Manifest: exports `./types`, `./client`, `./typert`, `./remote`; the `dsh.client` block injects the gateway and client-connection with platform web.

### packages/api/job-controller/tsconfig.json
- Solution tsconfig referencing the host and client faces.

### packages/api/job-controller/tsconfig.host.json
- Host face: five host files, referencing core/agent, core/session, jobs and typert-protocol.

### packages/api/job-controller/tsconfig.client.json
- Client face: four client files, referencing the gateway client face, client-store, core/session, jobs and typert-protocol.

### packages/api/job-controller/tsdown.config.ts
- tsdown config using the shared `clientBundle` helper with the `hostPhase` flag.

### packages/api/job-controller/locale/en.json
- Locale metadata stub: `meta.title = api-job-controller`.

### packages/api/job-controller/locale/zh.json
- Chinese locale metadata: title 后台任务观察接口.

### packages/api/job-controller/src/index.ts
- Purpose: The Host job Remote owner.
- Key abstractions: `JobController extends TypertRemoteService`, namespace `job`; config `observeFlushMs` (default 100) and `observeMaxFrameBytes` (default 65536).
- Data flow: `list` and `follow` are projections of `ctx.jobs`; `kill` is a command.
- Non-obvious design decisions: the kill's **lookup and the kill share one synchronous span** (index.ts:113-125) — nothing can remove the job in between, and a producer-cancel throw propagates per the registry contract instead of masquerading as `job/not-found`. The comment says so explicitly.
- Edge cases / failure handling: "unknown job" and "belongs to another session" are collapsed into one `job/not-found` because the client renders one story.
- Surprising: the config is resolved through the exported schemastery schema, and the constructor asserts the resolution rather than carrying a hidden fallback (index.ts:60-64).

### packages/api/job-controller/src/types.ts
- Purpose: The wire types of the `job` namespace.
- Key abstractions: `JobListRequest`/`JobListFrame`, `JobFollowRequest`/`JobFollowFrame` (`opened`/`output`/`status`), `JobKillRequest`/`JobKillValue`, and the `job/not-found` details declaration.
- Data flow: types only.
- Non-obvious design decisions: the **status rides the same stream as the output** (types.ts:70) so settlement can never race a still-open output channel — a separate status channel would have to solve that ordering problem.
- Edge cases / failure handling: an `output` frame carries `lossy: true` when bytes between the requested offset and the chunks were already evicted.
- Surprising: `JobFollowRequest.sessionId` is optional — an *unowned* job needs no session and any caller may observe it.

### packages/api/job-controller/src/rows.ts
- Purpose: The per-session roster generator.
- Key abstractions: `streamJobRows(registry, request, options, signal)`.
- Data flow: subscribe to the registry's events → yield the visible set → wait for a wake → sleep the flush window → yield the whole set again.
- Non-obvious design decisions: the subscription happens **before the first read** (rows.ts:35-40) so a commit between the read and the wait cannot be missed. Output appends are filtered out of the wake set, because a settled projection already carries the final byte count and a frame per append would be noise.
- Edge cases / failure handling: the roster is a whole-set replacement, so a reconnect's first frame is already the truth; `signal.throwIfAborted()` refuses an already-aborted signal at the top.
- Surprising: the generator has no natural end — the carrier closes it.

### packages/api/job-controller/src/observe.ts
- Purpose: The per-job observation generator.
- Key abstractions: `observeJobOutput`, `outputFrames` (the soft byte-budget splitter).
- Data flow: validate the offset → subscribe → read the anchor → read at the cursor → emit coalesced output frames → read the job → when terminal and drained, emit the terminal status.
- Non-obvious design decisions: the offset is validated as a non-negative safe integer **before** anything else (observe.ts:47-49) — a NaN or negative `from` is a caller error, not a silent "start from zero". A removal announced mid-generation closes the stream with the removed job's terminal projection instead of a failed read, because the owner's teardown already settled it.
- Edge cases / failure handling: one chunk larger than the budget ships whole (the registry's retention cap is the hard bound); the `lossy` flag is carried on the frame that contains the gap and cleared afterwards.
- Surprising: the brand is nominal typing only — the wire boundary stamps `JobId` at the edge rather than value-importing the registry's constructor (observe.ts:51-53).

### packages/api/job-controller/src/wake.ts
- Purpose: Wake bookkeeping shared by both generators.
- Key abstractions: `OutputWaiter` (a wake-flag waiter), `sleep(ms, signal)`.
- Data flow: `wake()` sets `dirty` and releases a pending waiter; `wait(signal)` resolves immediately if `dirty` is already set, otherwise installs one resolver.
- Non-obvious design decisions: "a wake between waits is never lost" — the `dirty` flag is the mechanism; without it a commit that lands between the read and the wait would be lost forever.
- Edge cases / failure handling: an abort resolves the wait immediately and removes the listener; the resolver is cleared only if it is still the installed one.
- Surprising: `sleep` returns at once when the signal is already aborted, so an aborted generation never waits out the flush window.

### packages/api/job-controller/src/client/index.ts
- Purpose: The client half installing `ctx.jobs`.
- Key abstractions: `ClientJobsModel`, `ClientJobs`.
- Data flow: `apply(ctx)` reads `ctx.remote` and `ctx.remote.job` **at apply time** and hands them to `ClientJobs`.
- Non-obvious design decisions: the module doc explains why (client/index.ts:3-7): stream (re)opens run on caller stacks — a React event, a carrier retry — whose dynamic context has not declared `remote.job`, so the faces must be captured while the plugin's own context is current.
- Edge cases / failure handling: the disposer unwinds the namespace after the stream stops.
- Surprising: this is a real Cordis-context trap, solved by capturing references at plugin-apply time rather than resolving them lazily.

### packages/api/job-controller/src/client/service.ts
- Purpose: The reference-counted client job service.
- Key abstractions: `IJobs` (`state`, `watchRows`, `observe`, `kill`), `ClientJobs`, `StreamEntry` (`refs`, `stopped`, `dispose`).
- Data flow: `watchRows(sessionId)` opens one `job.list` stream per session however many viewers hold it; `observe(sessionId, jobId)` opens one `job.follow` stream per job however many viewers expand it.
- Non-obvious design decisions: the observation loop **breaks on the terminal status before the generation end is classified** (service.ts:263-266) — the stream is closed for good, so a `follow` that ends normally is not mistaken for a carrier loss and retried.
- Edge cases / failure handling: a stream failure is recorded on the *view* (`observeFailed`) rather than thrown at the UI; the last reference release disposes the stream and drops the view.
- Surprising: `kill` is a "pure RPC passthrough" — the row state converges through the roster stream, and the caller owns error presentation.

### packages/api/job-controller/src/client/model.ts
- Purpose: React-free client job state.
- Key abstractions: `ClientJobsModel implements JobsSource`, `JobsSnapshot` (`rows`, `observed`), `ObservedJob` (`text`, `gapBefore`, `streaming`, `error`).
- Data flow: `rowsReplaced` replaces a session's roster **whole**; `observeOpened`/`observeOutput`/`observeSettled`/`observeFailed`/`observeStopped` fold the follow frames into the per-job view.
- Non-obvious design decisions: an **empty set is stored as an absent key** (model.ts:93-95) so consumers read absence rather than a sentinel, and a repeated empty set over an absent key changes nothing. The render tail is bounded to 128 KiB of UTF-16 code units and `gapBefore` marks eviction, resume gaps, or the render bound itself.
- Edge cases / failure handling: the snapshot object is identity-stable between changes (a `snapshotDirty` flag rebuilds it lazily), so a React consumer does not re-render on a no-op.
- Surprising: `gapBefore` is one boolean covering three different causes — a consumer that wants to distinguish them cannot, which is a stated limit rather than an accident.

### packages/api/job-controller/tests/host-harness.ts
- Host test harness: a registry with a 64-byte ring (so eviction is cheap to reach), a fake Agent registration, a push-producer job starter whose cancel settles on demand, and frame collectors.

### packages/api/job-controller/tests/rows.host.spec.ts
- Roster spec: the visible set opens the stream; another owner's lifecycle and this job's own output append never wake it; progress, stopping and registration commits do; an owner's rows drop when its lifecycle ends; an aborted signal ends the generator and an already-aborted signal is refused.

### packages/api/job-controller/tests/observe.host.spec.ts
- Observation spec: the anchor, coalesced output and terminal status; a lossy evicted resume; oversized reads split along the frame budget; and the session-visible roster following a settlement.

### packages/api/job-controller/tests/kill.host.spec.ts
- Kill spec: an owned running job is cancelled with `cancelled by the user` and the notice stays due; an already-finished job reports `already-finished`; an unowned job is killable from a session with no live agent; a foreign session's job is `job/not-found`; a producer cancel throw propagates unchanged; a child session's own job is killable.

### packages/api/job-controller/tests/model.client.spec.ts
- Client model spec (578 lines): roster replacement and absence-as-empty, output accumulation and cursor advance, gap marking from lossy frames and from a resume behind the retained head, snapshot identity stability, and reference-counted stream release leaving no residue.

### packages/api/job-controller/tests/client-apply.client.spec.ts
- Client apply spec: the plugin declares `inject = ['remote','remote.job']`, installs `ctx.jobs`, opens one roster and one observe stream, forwards a kill with the row's session, and leaves no state behind after release.

### packages/api/job-controller/tests/built-lib.e2e.ts
- Built-artifact smoke: the generated job codecs accept a producer `kind` this program never compiled (the `JobKindMap` merge is partial) while still rejecting a status outside the lifecycle.

### packages/api/remote-access/README.md
- Purpose: The access-control contract.
- Key abstractions: `RemoteAccessRole` (an action set over one resource kind), `RemoteAccessBinding`, `RemoteAccessPolicy` (`bindings()`, optional `explain()`), `RemoteAccessDecision`.
- Data flow: the Gateway resolves the resources a call touches and asks `decide({ principal, action, resources, args })` before it resolves lookups or decodes arguments; a denied call throws `remote-access/denied` with `{ action, reason }`; a denied *event* is dropped without building an error.
- Non-obvious design decisions: the owner is never checked — every method concerns non-owner principals. A request is allowed only when it is allowed on **every** listed resource. `bindings()` is read on *every* decision and *every* list check, never cached, so a running call sees a binding change from its next check on.
- Edge cases / failure handling: a policy that throws yields `policy-failed` and is logged **once per policy** until the next `invalidate()` (snapshots and lists ask many times per change). `remoteAccess/follow` is always allowed so a Peer can always open its own snapshot.
- Surprising: the snapshot and list-filter decisions carry **no call arguments**, so a condition that refines on `args` can refuse a call the snapshot shows as allowed — a stated limitation.

### packages/api/remote-access/README.zh.md
- Chinese mirror; same limitation list, including that an exact Connection Fetch route bypasses the Gateway and that a non-owner's `$events` stream only receives broadcasts their policy allows.

### packages/api/remote-access/README.i18n.yaml
- Per-heading EN/ZH content-hash record (8 sections).

### packages/api/remote-access/package.json
- Manifest: exports `./types`, `./client`, `./typert`, `./remote`; the `dsh.client` block injects the gateway and the UI renderer.

### packages/api/remote-access/tsconfig.json
- Solution tsconfig referencing the host and client faces.

### packages/api/remote-access/tsconfig.host.json
- Host face: three host files, referencing host-webserver and typert-protocol.

### packages/api/remote-access/tsconfig.client.json
- Client face: five client files, referencing the gateway client face, ui-renderer, ui-slots and typert-protocol.

### packages/api/remote-access/tsdown.config.ts
- tsdown config using the shared `clientBundle` helper with the `hostPhase` flag.

### packages/api/remote-access/src/index.ts
- Purpose: Host method-level access control.
- Key abstractions: `RemoteAccessService` (`ctx.remoteAccess`), `AccessFollower` (one open non-owner snapshot generation, coalescing changes until its reader wakes), `PolicyEntry`, `Evaluation`.
- Data flow: `registerPolicy(kind, policy)` → `invalidate(principal?)` → recompute open snapshots → `decide(request)` / `allows(resource)` / `snapshotFor(principal)` / `follow(signal)`.
- Non-obvious design decisions: a policy's failure is **logged once per policy until the next `invalidate()`** (index.ts:127 and :379) because snapshots and list filters ask many times per change — without the latch, one broken store would flood the log. `allows()` reads the invocation of the Context that accessed the service, so a list method filters item by item with no argument passing.
- Edge cases / failure handling: the owner and `remoteAccess/follow` are always allowed; a principal kind with no policy allows nothing; a policy that throws yields `policy-failed` rather than an allow.
- Surprising: `registerPolicy` is a Cordis effect of the *caller's* fiber, so registration and removal recompute the open snapshots automatically.

### packages/api/remote-access/src/types.ts
- Purpose: The access vocabulary.
- Key abstractions: `RemoteAccessAction` = `` `${string}/${string}` `` | `` `event:${string}` ``, `RemoteAccessRole`, `RemoteAccessCondition`, `RemoteAccessBinding` (a mapped union so the resource type follows the role's kind), `RemoteAccessRequest`, `RemoteAccessPolicy`, `RemoteAccessGrant`, `RemoteAccessFrame`.
- Data flow: types only.
- Non-obvious design decisions: the `RemoteAccessBinding` mapped type makes the resource's *type* follow from the role's kind, so a shelf role cannot be bound to a desk resource.
- Edge cases / failure handling: `args` is absent for events, snapshots and list filtering — the type makes that visible.
- Surprising: `RemoteAccessGrant.actions` is `readonly string[]` rather than a template-literal type "because Typert generates no codec for template literal types" (types.ts:128-131).

### packages/api/remote-access/src/snapshot.ts
- Eight-line constant: the `globalThis` property name `__DSH_REMOTE_ACCESS__` that carries a page's opening access snapshot.

### packages/api/remote-access/src/client/index.ts
- Purpose: The client face of access control.
- Key abstractions: `apply(ctx)`; `parseInjectedBaseline`.
- Data flow: read the injected baseline from the global → mount the namespace → follow the Peer's snapshot stream → publish `useRemoteAccess`.
- Non-obvious design decisions: the answers are **booleans only** — true for the owner, false without a snapshot and after a non-owner stream fails — because the Host enforces every call regardless, so the Client's job is only to hide what the Host would refuse.
- Edge cases / failure handling: a malformed injected baseline throws a `TypeError` rather than being treated as "no baseline".
- Surprising: the client never *asks* the Host whether it may call something; it reads its own snapshot.

### packages/api/remote-access/src/client/mount.ts
- Purpose: Mounting the `remoteAccess` namespace, the snapshot stream and the global-resource Hook.
- Key abstractions: `mountAccess(ctx, contribution, initial)`, `ClientRemoteAccessService`, `createAccessStream`.
- Data flow: `remote.$stream({ open: signal => remote.remoteAccess.follow(signal) })` → a `RemoteSnapshotStream` whose `replace`/`update` feed `ClientAccessState`.
- Non-obvious design decisions: the stream's `ended(accepted)` distinguishes "the carrier died after the baseline" (a `RemoteStreamCarrierError`, retryable) from "it died before the opening snapshot" (a plain `Error`, terminal) (mount.ts:116-118). A terminal failure turns only a **non-owner's** answers false — the owner's stay true, and the log message says so.
- Edge cases / failure handling: the follow is registered inside `ctx.inject(['remote.remoteAccess'], …)` so it is scoped to the namespace's lifetime.
- Surprising: the global-resource Hook is published through the Slot registry's `provideRoot`, not through React — the access answer is available to any renderer.

### packages/api/remote-access/src/client/state.ts
- Purpose: React-free client access state.
- Key abstractions: `ClientAccessState`, the `AccessSnapshot` union (`closed` | `owner` | `granted`), `Baseline`, `parseInjectedBaseline`.
- Data flow: `replace(baseline)` / `update(frame)` / `unavailable()` mutate the snapshot; `global(action)` and `resource(kind,id,action)` return cached identity-stable `HostObservable<boolean>` sources.
- Non-obvious design decisions: sources are cached per `(kind, id, action)` so **Hook bindings keep their identity** across snapshot changes (state.ts:76-77) — a React consumer therefore does not re-subscribe on every grant change. `unavailable()` moves a granted snapshot to `closed` (all false) but leaves an owner snapshot alone.
- Edge cases / failure handling: `parseInjectedBaseline` validates the injected value strictly and throws a `TypeError` on a malformed grant.
- Surprising: `global` is stored under the sentinel key `'\u0000global'` in the same map as real resources, so one code path answers both.

### packages/api/remote-access/tests/remote-access.host.spec.ts
- Host access spec (610 lines): per-kind role grants and conditions, the `policy-failed` denial path with warning de-duplication (one warning per policy until the state changes), `allows()` re-reading the bindings on every check so a running call sees a change from its next check, and the first-snapshot computation for owner and non-owner.

### packages/api/remote-access/tests/client-access.client.spec.ts
- Client access spec (291 lines): false without a baseline, true for the owner, the injected baseline validated with a dozen malformed variants refused, identity-stable sources per resource, and the terminal-failure behaviour that differs between owner and non-owner.

### packages/api/remotes/README.md
- Purpose: The BFF assembly contract.
- Key abstractions: the Host entry (forwarded-event selection + event source) and the Client entry (mounting each generated `/remote` contribution).
- Data flow: `src/remote-events.ts` holds `API_REMOTE_FORWARDED_EVENTS`; the type projection, the consumer key face and the Host forwarding loop all derive from that one array.
- Non-obvious design decisions: the allowlist files are listed in **both** compiler faces on purpose — the forwarded-event allowlist is the single control point over what a consumer can receive, and the Host loop and the Client `ctx.remote.$on` key face must read one declaration rather than two that could drift (README §Build boundary).
- Edge cases / failure handling: the Host rejects a non-JSON ordinary-event argument before enqueueing; a scoped waterfall must carry its routed Agent directly or the Host refuses to forward it; a waterfall's Client result must be lossless JSON.
- Surprising: the Client capability set is **fixed by build-time value imports** — the Client does not discover the Host's active Services at runtime.

### packages/api/remotes/README.zh.md
- Chinese mirror (first 30 lines read); the same build-boundary explanation.

### packages/api/remotes/README.i18n.yaml
- Per-heading EN/ZH content-hash record (9 sections).

### packages/api/remotes/package.json
- Manifest: exports `./client` and `./types`; the `dsh.client` block injects the gateway with platform web and `immediately: true`.

### packages/api/remotes/tsconfig.json
- Solution tsconfig referencing the host and client faces.

### packages/api/remotes/tsconfig.host.json
- Host face: three files, referencing the gateway host face, core/session, typert-protocol and the selected domain hosts.

### packages/api/remotes/tsconfig.client.json
- Client face: three files, referencing the gateway client face and every selected domain's client project.

### packages/api/remotes/tsdown.config.ts
- tsdown config using the shared `clientBundle` helper with the `hostPhase` flag.

### packages/api/remotes/locale/en.json
- Locale metadata stub: `meta.title = api-remotes`.

### packages/api/remotes/locale/zh.json
- Chinese locale metadata: title 客户端 API 汇总.

### packages/api/remotes/src/index.ts
- Purpose: The Host BFF entry and the forwarded-event source.
- Key abstractions: `RemoteEventQueue` (a pull-driven bridge from synchronous Cordis listeners to an `AsyncIterable`), `remoteEventSource`, `forwardWaterfall`, `assertJsonArgs`.
- Data flow: `ctx.typertGateway.registerRemoteEvents(remoteEventSource(ctx), { home: homedir() })` → a `Deque` of dispatch frames → the Gateway's internal `$events` stream.
- Non-obvious design decisions: a waterfall's `request` must carry its routed Agent **directly** (`request.agent === carrierAgent`) or the Host throws a `TypeError` (index.ts:66-69) — the Agent identity is what lets the Client pick the right scoped context, and a mismatched one would forward the prompt to the wrong session. A Client result resolves the waterfall, while `next()` delegates to the following Host listener (index.ts:149-155).
- Edge cases / failure handling: the source ends with a reason — the signal's own reason after cancellation, else an explicit "forwarded Remote event source ended" error — and every buffered waterfall is *rejected* with it, so no approval is left hanging.
- Surprising: `assertJsonArgs` rejects a non-JSON ordinary-event argument at the *Host* boundary, so an unserialisable payload fails loudly at the source instead of corrupting the stream.

### packages/api/remotes/src/remote-events.ts
- Purpose: The one home of the forwarded-Host-event allowlist.
- Key abstractions: `API_REMOTE_FORWARDED_EVENTS` — 28 entries, each `{ event, mode: 'emit' | 'waterfall' }` with optional `resources` readers.
- Data flow: the array feeds the Host dispatch loop and (through the type projection) the legal key set of `ctx.remote.$on`.
- Non-obvious design decisions: the `emit`/`waterfall` mode is **both** the Host dispatch strategy and the legal key set, so the two cannot drift. Five `api-session/*` events declare their Session resource; the rest touch the built-in `global` resource.
- Edge cases / failure handling: a notification names one resource identity or none; collection changes travel on follow streams instead.
- Surprising: two of the 28 entries are waterfalls (`approval/request`, `user-questions/request`) — the *interactive* surface is forwarded through the same mechanism as the notifications.

### packages/api/remotes/src/types.ts
- Type-only projection of the allowlist into `ApiRemoteForwardedEvent` and the `TypertRemoteEventSelection` declaration merge.

### packages/api/remotes/src/client/index.ts
- Purpose: The platform-neutral Client assembly.
- Key abstractions: the list of 26 generated `/remote` contributions, the `Context` augmentation declaring `ctx.remote: ClientRemote`.
- Data flow: `apply(ctx)` mounts every contribution through `ctx.remote.$mount()` in order and unwinds the disposers in reverse.
- Non-obvious design decisions: the mount is **all-or-nothing**: a failure unwinds the already-mounted disposers in reverse before rethrowing (index.ts:199-202), so a half-mounted assembly is never left behind. The unwinding order means a namespace never outlives one mounted after it.
- Edge cases / failure handling: the module re-exports the failure vocabulary as **types only** — a value export would make spec imports load the owner `/remote` artifacts, so specs take `RemoteError` from `dsh-client-test-runtime` instead (index.ts:161-164).
- Surprising: this file is the single front door for the whole client-safe type vocabulary (settings, credentials, llm, plugin manager, cordis runner…), so a feature package imports one specifier instead of reaching into a dozen packages.

### packages/api/remotes/tests/remote-events.host.spec.ts
- Host event-source spec (first 150 of 296 lines read): the Host home is registered and withdrawn with the plugin; each Client stream gets an **independent** allowlisted queue; aborting one Client leaves the other running.

### packages/api/remotes/tests/built-lib.e2e.ts
- Built-artifact smoke (first 80 of 272 lines read): plain Node boots the Host and Browser bundle handoffs and crosses the shared `/api` HTTP route with the real registry, gateway, goal and access services.

### packages/api/session-controller/README.md
- Purpose: The session contract — the densest document in the shard.
- Key abstractions: `ctx.sessionController` and the `session`, `skills` and `fileReferences` Remote namespaces.
- Data flow: one durable `SessionWireEvent` per durable Session event; the Client retains each as a `SessionEventLikeEntry`; Assistant token boundaries stay inside the compact stream on `assistant/message` or `assistant/attempt`; tool arguments, result content, failures and `tool/result.data.meta` pass through unchanged.
- Non-obvious design decisions: **every endpoint states its activation policy.** List reads only stored headers and projection-cache rows and never calls per-session stat or opens a cold Session body. A current-format cache identity may supply every list hint; a *lifecycle-matching predecessor* cache may supply only its version-compatible title, as a stale display fact, never as an authoritative fold seed. Prompt rejects content with neither non-whitespace text nor an attachment *before* resolving the Agent or appending Session events. Prompt retries whose `requestId` is already queued or logged return the original acceptance without inserting another message. Create and fork are the only operations that create a new Agent.
- Edge cases / failure handling: a named Session in another directory fails with `session/conflict` and one owned by subagent routing with `session/agent-busy`, both *before* preset resolution. A resume blocked by an existing write handle returns `session/writer-held` with the Session id; other resume failures keep `gateway/internal`.
- Surprising: the **Web adapter explicitly opts into cursorless Assistant frames**: each opening carries the active attempt's `startedAfterSeq`, `nextIndex` and compact stream, and every stream member becomes a Client-only `assistant/live-chunk` entry ordered between durable cursors — the Host captures a follower-local arrival ordinal and suppresses buffered frames at or before the cut, because a replacement Agent may restart frame revision at one.

### packages/api/session-controller/README.zh.md
- Chinese mirror (first 12 lines read); the same summary and contract headings.

### packages/api/session-controller/README.i18n.yaml
- Per-heading EN/ZH content-hash record (head read).

### packages/api/session-controller/package.json
- Manifest: exports `./types`, `./remote-events`, `./client`, `./typert` and `./remote`; `dsh-session-persistence`, `dsh-session-projection-cache` and `dsh-settings` are **optional** peerDeps, so the controller runs without them (degraded).

### packages/api/session-controller/tsconfig.json
- Solution tsconfig referencing the host and client faces.

### packages/api/session-controller/tsconfig.host.json
- Host face: fifteen host source files, referencing core/agent, session-query, session-projection, session-projection-cache, skill, subagent, typert-protocol, remote-access and workspace.

### packages/api/session-controller/tsconfig.client.json
- Client face: `src/client/**/*.ts`, `src/types.ts` and `src/remote-events.ts`, referencing the gateway client face, client-store, core/session, session-projection, subagent and the native-command util.

### packages/api/session-controller/tsdown.config.ts
- tsdown config using the shared `clientBundle` helper with the `hostPhase` flag.

### packages/api/session-controller/locale/en.json
- Locale metadata stub: `meta.title = api-session-controller`.

### packages/api/session-controller/locale/zh.json
- Chinese locale metadata: title 会话控制接口.

### packages/api/session-controller/src/index.ts
- Purpose: The `session` Remote namespace owner (first 300 of ~700 lines read).
- Key abstractions: `SessionController extends TypertRemoteService`, `Config` (`nativeOpen`, `listWorkSliceMs` default 16), `SessionControllerInternals` (Host integrations replaceable by unit tests).
- Data flow: the constructor registers the `session` resource kind with the default field `sessionId`, installs the model-selection projection, builds the agent/command/control/history/list controllers, and publishes `api-session/*` events from `session/created`, `session/disposed`, `agent/created|disposed|status|error` and `session/event`.
- Non-obvious design decisions: a `request/header` event is the point where the controller *consumes* the selection the Agent actually used (index.ts:206-215) — the durable intent and the request's real route are reconciled rather than assumed. Background promotions are tracked in a `promotions` set and the teardown effect awaits them (index.ts:165-169), registered *before* the history controller so reverse-order teardown closes every follower before waiting for already-admitted promotions. `list` and `search` filter their results through `ctx.remoteAccess.allows()` (index.ts:268-286), so a non-owner sees only the rows it may read.
- Edge cases / failure handling: `inspect()` reads an attached Session from memory and a cold one from persistence *without* repairing, resuming or publishing it.
- Surprising: the controller `inject`s `remoteAccess` and registers the `session` resource kind itself — the access policy for Sessions is owned by the session domain, not by the access package.

### packages/api/session-controller/src/agent.ts
- Purpose: Agent activation, composition and model-selection policy (first 150 of ~700 lines read).
- Key abstractions: `ApiSessionAgentController`, `ApiSessionNotFound`, `ApiSessionSubagentOwnership`, `ApiSessionCwdConflict`, `ApiSessionPresetConflict`, `ApiSessionStartedSinceObserved`, `hasApiSessionSubagentOwner`.
- Data flow: `createSession` → resolve the preset → compose the Agent → publish; `resolveAgent` → attach or resume; `resolveObservedAgent` → activate from a cold observation.
- Non-obvious design decisions: `hasApiSessionSubagentOwner` (agent.ts:117-128) checks both `header.origin === 'subagent'` **and** the live agent's ownership (`ctx.agents.isOwnedBy(agent.id, parent)`) — an identity reserved by subagent routing must not be adopted by generic session routing even if its header does not say so. A blank Session that started a turn *since it was observed* is a distinct failure (`ApiSessionStartedSinceObserved`) from a plain conflict, because the race is with another writer, not with the placement rule.
- Edge cases / failure handling: the failure classes map to stable `session/*` Remote errors (`session/not-found`, `session/agent-busy`, `session/writer-held`, `gateway/internal`).
- Surprising: the error message for a cwd conflict names *both* cwds — "session X belongs to Y, not Z" — because the fix is a placement decision, not a retry.

### packages/api/session-controller/src/commands.ts
- Purpose: The session commands, with an explicit activation policy per method (first 150 of ~700 lines read).
- Key abstractions: `SessionCommandController`, `hasPromptContent`, `latestCompletedPrefixBoundary`, `SessionReadState`.
- Data flow: `create` → `cancel` → `prompt` → `updateQueue` → `rename` → `selectModel` → `fork` → `attach`.
- Non-obvious design decisions: `hasPromptContent` (commands.ts:60-62) accepts a part when it is *not* text or has non-whitespace text — so an attachment-only prompt is legal and a whitespace-only text is not. `latestCompletedPrefixBoundary` (commands.ts:65-77) computes the default fork cut as the last `turn/end` plus the standalone events before the next turn/user message, which is why "omit `atSeq`" means "the latest completed turn *and its tail*", not "the last turn boundary".
- Edge cases / failure handling: `create` refuses both `workspaceId` and `cwd` (`gateway/bad-request`) rather than picking one; a missing Workspace is `workspace/not-found`; a Workspace attach failure after a successful create is `session/workspace-attach-failed` naming both ids.
- Surprising: creation is serialized **in arrival order** including preset resolution, and each response reports the preset *its own request* left the Session running — so a race cannot report another request's preset.

### packages/api/session-controller/src/history.ts
- Purpose: Cold history pagination and the live follow source (first 150 of ~430 lines read).
- Key abstractions: `SessionHistoryController`, `SessionAssistantStreamAccumulator` (per Session), `closeFollowers`, `paginate`, `DEFAULT_MAX_MESSAGES = 50`, `MESSAGE_TYPES`.
- Data flow: `page()` reads a cold source and paginates it; `follow()` subscribes to `session/event` globally, buffers into a `Deque`, and interleaves durable events with Assistant stream frames carrying a follower-local arrival ordinal.
- Non-obvious design decisions: the `session/event` listener is registered with `{ global: true }` and the *buffered* events are filtered by Session id at read time (history.ts:~130) — a follower of one session sees another's events arriving and discards them, rather than the Host maintaining per-session listener sets. The Assistant stream accumulator is per Session and is deleted on `agent/disposed`.
- Edge cases / failure handling: a `throughSeq` past the source cursor is `gateway/bad-request`; a log that does not contain the through seq is `gateway/internal` (a dense zero-based prefix is guaranteed by Session and persistence).
- Surprising: the Assistant baseline is **reused unchanged across follow openings** — the accumulator caches one immutable baseline per accepted revision, so a reconnect does not re-materialise the stream.

### packages/api/session-controller/src/control.ts
- Purpose: The Host-wide Session control stream.
- Key abstractions: `SessionControlController`, `ControlQueue`.
- Data flow: `ctx.sessionProjections.onChanged` broadcasts a `projection` frame to every open generation; each generation opens with a complete `baseline` of every Session's projection values.
- Non-obvious design decisions: the baseline carries `asOfSeq` per Session alongside the values (control.ts:69-77), so a client can tell how fresh each Session's block is. The queue **drains its buffer before closing** (control.ts:~120) so a cancelled generation still delivers the frames it had already accepted.
- Edge cases / failure handling: the controller registers an effect that ends every queue on unload, so no generation outlives the service.
- Surprising: the control stream is Host-wide — one connection carries every Session's projection changes, and the client filters by id.

### packages/api/session-controller/src/list.ts
- Purpose: The cold-safe list and search projection (first 150 of ~400 lines read).
- Key abstractions: `ApiSessionList`, `applySessionListMetadata`, `truncateUnicodeCodePoints`, `SESSION_SEARCH_QUERY_MAX_CHARS = 500`, `SEARCH_PROVIDER_CALL_LIMIT = 100`.
- Data flow: `sessionQuery.listSessions` → attached Sessions become live summaries, cold records are deferred → a bounded search provider is paged inside a call budget.
- Non-obvious design decisions: the work-slice deadline is checked **only between complete rows** (list.ts:147-159), so a row is never torn in half; the deadline is reset after each yield, so the budget is a *slice* and not a total. The `blank` bit is `state.blank && event.type !== 'turn/start'` (list.ts:47) — "conversation not started", not "log empty", so standalone plugin events do not clear it. `truncateUnicodeCodePoints` counts code points, not UTF-16 units, so a snippet never splits an emoji.
- Edge cases / failure handling: cancellation is checked per row, after each yield, and before any cold summary starts; the list promises no cross-Session snapshot — each row is synchronous and the list "does not promise one cross-Session snapshot".
- Surprising: the `imageLimits` projection is registered as a *unit* projection whose value is the attachment service's live limits (list.ts:~96) — the Host publishes a boot-constant as if it were a projection, so the client reads it through the same machinery.

### packages/api/session-controller/src/assistant-stream.ts
- Purpose: The Host-side fold of dense Assistant frames into a reconnect baseline.
- Key abstractions: `SessionAssistantStreamAccumulator`, `MutableAttempt`, `EMPTY_BASELINE`.
- Data flow: `agent/assistant-stream` frames → `accept(frame, durableCursor)` → `snapshot()` returns an immutable baseline `{ revision, activeAttempt? }`.
- Non-obvious design decisions: three independent reset conditions (assistant-stream.ts:39-48): a revision-1 `start` after a prior attempt means the Agent lifecycle restarted, so the accumulator resets to revision 0; a revision that is not `previous + 1` is a **gap**, so the active attempt is dropped and the baseline is marked dirty; a chunk whose index is not the expected dense `nextIndex` also drops the attempt. The attempt records `startedAfterSeq` — the durable cursor when the attempt began — so the Client can order live chunks between durable events.
- Edge cases / failure handling: the baseline is **cached** and only rebuilt when dirty, so repeated `snapshot()` calls are free and identity-stable.
- Surprising: the accumulator survives an Agent replacement *because* the revision-1 start resets it — the Web client is told to rebaseline rather than being handed a corrupt stream.

### packages/api/session-controller/src/model-selection-projection.ts
- Purpose: The durable model-selection intent and request-use projection.
- Key abstractions: `modelSelectionProjection` (key `modelSelection`, `stateVersion: 2`), `applyModelSelectionProjection`, `sameSelection`.
- Data flow: `model/selection` sets `pending`; `request/header` moves the actually-used route into `lastUsed` and clears `pending` when they agree.
- Non-obvious design decisions: the wire view reports `next: pending ?? lastUsed` (model-selection-projection.ts:60) — the UI shows the route that *will* be used, falling back to the last one actually used. `apply` returns the *original* state object when nothing changed, so an unchanged projection does not churn subscribers.
- Edge cases / failure handling: `sameSelection` compares provider, model and reasoning effort, so a re-selection of the same route is not a change.
- Surprising: `stateVersion: 2` records that the state shape changed — a projection version is part of the persisted contract, not an implementation detail.

### packages/api/session-controller/src/archived-session-gate.ts
- Purpose: The admission gate for archived Sessions.
- Key abstractions: `ArchivedSessionGate` (a Cordis plugin), `underArchivedSession(ctx, agent)`.
- Data flow: an `agent/pre-step` listener rejects the step when the Session, or a Session above it in its subagent lineage, is archived; the loop then ends the turn as `blocked` **without a model request**.
- Non-obvious design decisions: the lineage walk follows the durable header's `origin === 'subagent'` and `parentSession` fields only (archived-session-gate.ts:44-60) — a **fork of an archived Session is an independent conversation** and is not blocked. The walk keeps a `visited` set so a damaged, looping lineage terminates instead of hanging.
- Edge cases / failure handling: the gate reports nothing itself — the Agent registry, job registry, Subagent runtime and Schedule plugin stop the work an archived Session still runs, through the Workspace registry's archive-admission events.
- Surprising: blocking at `pre-step` is chosen over cancelling the Agent, so the turn ends *cleanly* as `blocked` and the transcript says why, instead of showing a cancellation.

### packages/api/session-controller/src/skill-catalog.ts
- Purpose: The Session-addressed, cold-readable skill catalog.
- Key abstractions: `SessionSkillCatalog` (`ctx.remote.skills`), `scopeFor`.
- Data flow: observe the Session (projections, not the body) → take the working directory from the projection, the header, or the default → prefer a live Agent's scoped registry → list and filter with `isUserInvocable` → return metadata only.
- Non-obvious design decisions: the catalog **never loads a skill body and never activates a cold Agent** — it returns the winning provider's optional instruction-file `path` so the composer can preview one file. A live Agent's `workingDirectory.ensure()` overrides the recorded cwd, because a live Agent may have been moved.
- Edge cases / failure handling: a missing registry is reported as absent rather than as an empty catalog; an unknown recorded preset falls back to the global registry; an observation without projections is refused.
- Surprising: the standing preset scope is acquired (`presets.acquireScope`) rather than an Agent, so a cold Session can still be answered with *its* preset's skills.

### packages/api/session-controller/src/file-references.ts
- A thin Remote adapter over the composed file-reference provider: the Agent is resolved from the Session identity on the wire, and the query and cancellation signal are forwarded unchanged.

### packages/api/session-controller/src/media-references.ts
- Purpose: The authenticated `GET|HEAD /api/file` route.
- Key abstractions: `SessionMediaReferences` (a plugin), `serveFile`, `BASE_HEADERS`.
- Data flow: `connection.fetch.register({ path: '/api/file' })` → `ctx.fs.resolve` → `ctx.fs.readBytes` (or `fs.stat` for HEAD) → a `Response`.
- Non-obvious design decisions: the response carries `Content-Security-Policy: sandbox; default-src 'none'` (media-references.ts:16) because HTML and SVG served from the authenticated API origin could otherwise execute with that origin's privileges; plus `nosniff` and `private, no-store`. **Range is ignored** and the complete file is returned. The byte cap is `attachments.imageLimits.maxImageBytes` for *all* files, not just images.
- Edge cases / failure handling: a non-absolute path or an embedded NUL is 400; `FsError` codes map to 404/403/413/499/500; HEAD reads metadata only and refuses a non-regular file.
- Surprising: "Neither directory containment nor MIME categories restrict access" — the route is a *display* route behind the authenticated connection, not a sandboxed file browser, and the doc says so plainly.

### packages/api/session-controller/src/remote-events.ts
- Type-only declaration of the five `api-session/*` events this controller offers to a Remote Event assembly.

### packages/api/session-controller/src/types.ts
- Purpose: The browser-safe request/result/lifecycle vocabulary for the session namespace (head read).
- Key abstractions: `SessionAddress` (a Session or a subagent child), `SessionSummary`, `SessionListMetadata`, `SessionProjectionValues`, `SessionRequestId`, `PromptContentPart`, `QueueAction`.
- Data flow: types only.
- Non-obvious design decisions: the module declares the `SessionProjectionStateMap` entries it owns (`sessionListMetadata`, `imageLimits`, `modelSelection`), so the projection registry is typed end to end.
- Edge cases / failure handling: `SessionRequestId` is the correlation identity echoed as the durable user source's `rpcId`.
- Surprising: `SESSION_SEARCH_RESULT_LIMIT` and `SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS` are defined in this *types* module and imported by the Host's `list.ts` — a limit that both sides must agree on lives in the shared vocabulary.

### packages/api/session-controller/src/client/index.ts
- Purpose: The Client Session object layer, Agent scopes and Remote lifecycle wiring (head read).
- Key abstractions: the re-export of `createSessionControlStream`, `SessionEventStream`, `SESSION_SEARCH_RESULT_LIMIT` and the search-snippet limit; `SessionRemotes`.
- Data flow: wires the transport adapters to the `ClientSessions` service and the scoped Remote namespaces.
- Non-obvious design decisions: the client entry is a thin composition root — the search limits are re-exported from the *Host* types so the Client and the Host use one number.
- Edge cases / failure handling: the object layer owns the Remote lifecycle, so a disconnect tears the streams down with it.
- Surprising: the Client entry re-exports a Host-side constant, which is how a "the Host and the Client agree" invariant is expressed in one file.

### packages/api/session-controller/src/client/transport.ts
- Purpose: The Session-specific adapters over the Gateway stream primitives (head read).
- Key abstractions: `SessionEventStream` (a `RemoteJournalStream` bound to one ordinary or direct-subagent address), `createSessionControlStream` (a `RemoteSnapshotStream`), the assistant-notification opt-in.
- Data flow: the journal opens the follow *before* the initial page, publishes only contiguous `replace`/`prepend`/`append`/`settle-assistant` changes, and repairs a reconnect or sequence gap through a tail page.
- Non-obvious design decisions: backwards paging has **two verbs** — `loadOlder()` pulls one Turn-aligned page, and `loadThrough(seq)` loops Turn-aligned pages until the window covers the target seq, lowering a shared target on repeated calls, stopping on a page that makes no progress, and reporting busy through the same `loadingOlder` snapshot bit. An opted-in opening that omits its Assistant baseline is rejected, and a frame that arrives before the baseline is rejected.
- Edge cases / failure handling: a revision gap rebaselines without advancing the durable cursor; a replacement Agent restarting at revision one also rebaselines.
- Surprising: the transport layer rejects an *invalid* opening (missing baseline) rather than tolerating it — the journal's correctness depends on the baseline being the first item.

### packages/api/session-controller/src/client/sessions/session.ts
- Purpose: The resident Client Session object (head read).
- Key abstractions: `SessionFace`, `SubmissionHandle`, `PendingSubmissionRetirement`, `SessionEventStream`, `SessionJournalChange`.
- Data flow: the object opens the follow, installs the tail page, publishes a contiguous window, and owns the local submission echoes.
- Non-obvious design decisions: "Sessions remain resident after creation so their open Remote sources keep running off-screen" (session.ts:1) — a closed tab's Session is not torn down, because tearing down the follow would lose the durable window. `beginSubmission` inserts the echo **synchronously, before the caller serializes and prompts**, so a conversation UI can show the message on the submit click's own frame.
- Edge cases / failure handling: the echo's placement (`transcript`/`queued`/`steering`) is derived from the current running state and the requested delivery mode and then *retained* until the display handoff; identified failures and abandonment retire unadmitted echoes immediately; disposal preserves observed admission and fails the rest; each retirement fires `onRetire` exactly once.
- Surprising: the echo carries the ordered durable attachment references so the composer can release successful cards while preserving failed drafts — the echo knows which attachments the Host actually admitted.

### packages/api/session-controller/src/client/sessions/manager.ts
- Purpose: The Host catalog, durable projection caches and explicitly retained Client instances (head read).
- Key abstractions: `SessionManager`, `SessionListPhase`, `SessionProjectionSnapshot`, `SessionSearchResultItem`, `mergeOrderedBaseline`.
- Data flow: the list baseline is merged with the established client order; host frames update the rows; uninstantiated sessions get control baselines.
- Non-obvious design decisions: the manager uses `mergeOrderedBaseline` so a refresh **never reorders rows the user can already see** — an authoritative baseline is merged, not substituted. `isRemoteFailure` distinguishes a business failure from a transport failure so the right error state is published.
- Edge cases / failure handling: a Session removed from the list is forgotten on drop; a row added during a pull whose baseline omits it is still retained.
- Surprising: a Session that is *running* but unlisted is retained, and an acceptance received before the first list response is retained too — the client's memory of a conversation outlives the Host's list.

### packages/api/session-controller/src/client/sessions/service.ts
- Purpose: The Client catalog and source-labelled ownership of exact Session generations (head read).
- Key abstractions: `ClientSessions`, `SessionBinding`, `SessionListState`, `SessionReference`, `SessionRetainInfo`, `SessionRetainOptions`.
- Data flow: `retain(target, { source })` acquires one exact Client generation and starts the shared initial history opening; `using(target, options, operation)` waits for that settlement and holds the reference until the callback settles.
- Non-obvious design decisions: the initial opening is **shared** across owners while each owner's reference counts separately, and cancelling one waiter does not cancel another owner's opening. `retainInfo(id)` observes stable read-only source counts independently of catalog membership and performs no history I/O.
- Edge cases / failure handling: the reference's `ready` promise resolves to the exact binding when the attempt settles, *including* when the Remote failure is represented as `openState: 'error'`; it rejects when `Session.open()` rejects, its waiter is cancelled, or the reference is released early. Final release withdraws the generation before teardown, so a later acquisition creates a new generation with the same id.
- Surprising: `binding(id)` and `scope(id)` only *borrow* an existing generation — they never create one, which is what makes the reference counting meaningful.

### packages/api/session-controller/src/client/sessions/projection-store.ts
- Purpose: The generic per-session projection value store (push model) (head read).
- Key abstractions: the `sequenced` row `{ value, seq }` and the `cached` row `{ value }`, a per-key observable face, and a watermark read.
- Data flow: a follow opening baseline, a control `projection` frame or a list block seed the store; a history tail page's projections block fills cached rows.
- Non-obvious design decisions: **higher seq wins** among sequenced rows, so a replayed or stale frame drops; a `cached` row carries no comparable seq and always yields to a sequenced write; a baseline discards every cached row before it seeds, regardless of seq (projection-store.ts:85-88) — the connected Session is the truth and a cached value never outranks it.
- Edge cases / failure handling: a key with no value reads `undefined`, which the doc calls *capability absence* rather than a zero; a watermark is exposed only for current Host-sequenced values.
- Surprising: "No client-side domain folding exists: a domain ships projection support with zero client code" — the projection is a *host-computed* value, so adding a projection key to the Host is enough.

### packages/api/session-controller/src/client/sessions/notifier.ts
- Purpose: The Client change notifier (head read).
- Key abstractions: `Notifier` (`markDirty`, `notifyNow`, `ensureFresh`, `subscribe`).
- Data flow: a change calls `markDirty()`; structural changes flush in a **microtask**, stream changes flush by **animation frame**; a flush rebuilds the snapshot and then notifies.
- Non-obvious design decisions: the rebuild is *skipped entirely* when there are no listeners, and `ensureFresh` rebuilds lazily exactly once — a no-listener client pays nothing. `notifyNow` runs listeners synchronously, which the doc calls a "controlled-input contract". A structural microtask publication **supersedes** a pending frame.
- Edge cases / failure handling: a scheduled flush after `notifyNow` is a no-op; unsubscribed listeners stop receiving notifications; the frame path falls back to microtask batching when animation frames are unavailable (SSR, tests).
- Surprising: the choice of microtask vs frame is a *policy* — "structure" vs "stream" — which is how a busy stream does not starve a structural change of its frame.

### packages/api/session-controller/src/client/sessions/assistant-stream.ts
- Purpose: The Web presentation fold joining transient Assistant frames to one durable settlement (head read).
- Key abstractions: `ActiveAttempt` (`attemptId`, `startedAfterSeq`, `turn`, `step`, `nextIndex`), the `expandAssistantStream` helper.
- Data flow: a live chunk is retained as a transient row; the durable `assistant/message` or `assistant/attempt` releases it.
- Non-obvious design decisions: a successful message retains its transient rows **until the owning `step/end`**, so pending tool identities remain available for dispatch; failed or interrupted settlements retire their rows immediately; earlier same-step retries remain visible.
- Edge cases / failure handling: a chunk or terminal index mismatch rebaselines a known attempt; frames from an unknown attempt are ignored and their durable settlement is published normally; an abandoned end publishes a settlement delta *without* a durable entry so its transient rows retire immediately.
- Surprising: the fold is a *presentation* concern living entirely in the Client, while the Host publishes the raw frames and the baseline — the two halves are versioned against each other by the `revision` counter.

### packages/api/session-controller/src/client/sessions/lineage.ts
- Purpose: Flattening session summaries into a list with lineage depth (head read).
- Key abstractions: `flattenLineage`, `TitledSessionSummary`, `SessionListEntry`.
- Data flow: the summaries in → a flat list with a depth per row.
- Non-obvious design decisions: the input order is authoritative — lineage only makes each child adjacent to its parent; an orphaned lineage degrades to root level and a cycle fails soft (every entry is still emitted, with a warning) so the list can never hang.
- Edge cases / failure handling: a self-referencing entry counts as a cycle member.
- Surprising: "fail soft" here means the *list is still complete*; a cycle loses the tree shape but loses no row.

### packages/api/session-controller/src/client/sessions/history-records.ts
- Allocation-free narrowing of aligned wire records to Client event types, plus helpers reading a record's first logical sequence.

### packages/api/session-controller/src/client/sessions/remotes.ts
- The Remote namespaces the Session cluster calls, narrowed to the commands, subagent and session faces it uses.

### packages/api/session-controller/src/client/ordered-baseline.ts
- Purpose: Merge an authoritative baseline without moving identities already visible to the client.
- Key abstractions: `mergeOrderedBaseline<T>(current, baseline, keyOf)`.
- Data flow: the current order + the authoritative rows → baseline-valued rows with the established relative order retained.
- Non-obvious design decisions: a baseline-only identity is inserted **relative to the nearest following known identity** (ordered-baseline.ts:27-38), so a new row appears where the Host put it without disturbing rows the user is looking at; an identity absent from the baseline is removed.
- Edge cases / failure handling: the implementation is pure and O(n²) in the worst case — acceptable for a sidebar-sized list.
- Surprising: the function returns *baseline-valued* rows (the newest data) with the *old* order — value and position are decoupled on purpose.

### packages/api/session-controller/src/client/scope.ts
- Purpose: Client scope generations routing local events independently of Host Agent residency.
- Key abstractions: `createScope(ctx, key)`, `AgentScopeHandle`, `AgentContext`, `kScope` (a private symbol), `scopeOf`, `scopeIdentityOf`.
- Data flow: a scope is a no-op plugin fiber whose context carries a `{ sessionId }` tag **and** a Cordis `Context.filter` that admits untagged listeners globally and tagged ones only for the same generation.
- Non-obvious design decisions: the scope identity is the *generation object*, not the session id (scope.ts:52-57) — two generations of the same Session are different identities, so a stale generation's events cannot reach a live one. The filter is installed on the context, so plain Cordis dispatch with the scoped context as the subject routes correctly without any bespoke bus.
- Edge cases / failure handling: `scopeOf` reads the nearest inherited tag; a root context has none.
- Surprising: this is a local routing mechanism that has nothing to do with the Host's Agent — the Client can have two live generations of one Session and keep their events apart.

### packages/api/session-controller/src/client/session-wire-event.ts
- Purpose: Event-local acceptance for raw journal responses.
- Key abstractions: `assertSessionWireEvent(value): asserts value is SessionWireEvent`.
- Data flow: a follow frame or history page's event → envelope check → `validateSurfaceMetadata` → `validateSessionEventData`.
- Non-obvious design decisions: **invalid records fail without field stripping or normalization** — the validator rejects an unexpected key rather than dropping it, so a schema drift is visible instead of silently dropping data. Range membership and source existence remain durable-log checks on the Host, because the Client cannot verify them.
- Edge cases / failure handling: `seq` must be a non-negative safe integer and not `-0`; `ignorable`, if present, must be `true`.
- Surprising: the allowed key set is an explicit `switch` over seven names — a new field on the wire is a *breaking* change until the validator is updated.

### packages/api/session-controller/src/catalog.ts
- Purpose: The browser model catalog projected from the live LLM registry.
- Key abstractions: `buildModelCatalog`, `modelAvailable`, `hasProviderApiKey`.
- Data flow: `llm.listProviders()` → per provider `listModels` + `resolveModelInfo` → a group of models (with their reasoning efforts and descriptions) or a `failure` entry.
- Non-obvious design decisions: each provider is resolved inside its **own** `try` (catalog.ts:30-58), so one gateway being down becomes a `failure` entry while the other providers still load — the picker degrades instead of emptying. Groups with zero models are dropped, and the deployment default is carried on the catalog itself. `modelAvailable` checks the *exact* provider/model pair against the current advertised catalog, and `hasProviderApiKey` checks **configured credential references independently of model availability** — "am I logged in" and "is this model offered" are two different questions with two different answers, and neither substitutes another model.
- Edge cases / failure handling: a provider whose credential is absent is reported as a provider failure; a provider with a key but no models still counts for `hasProviderApiKey`; the account provider is excluded from the key check because it is not key-configured.
- Surprising: the catalog is built **without a Session** — it is a global, cold-readable projection of the LLM registry, so the model picker works before any conversation exists.

### packages/api/session-controller/src/client/contract/events.ts
- Purpose: The observable contiguous Session event window consumed by domain assemblers (head read).
- Key abstractions: `AssistantLiveChunkEvent` (a Client-only row ordered between durable seqs), `SessionEventLike = SessionEvent | AssistantLiveChunkEvent`, `SessionEventLikeEntry`.
- Data flow: durable events and live chunks become one ordered entry list.
- Non-obvious design decisions: the live chunk carries **its own numeric `seq`** so it can be ordered between durable Session seqs without pretending to be a durable event.
- Edge cases / failure handling: the window is contiguous by construction — `append` does not traverse the complete window.
- Surprising: a transient token chunk and a durable message live in one list type, so a renderer does not need two code paths.

### packages/api/session-controller/src/client/contract/session.ts
- Purpose: The outward session face (head read).
- Key abstractions: `SessionFace`, the snapshot, the submission-echo retirement reason (`observed` with the admitted attachment references, or `failed`).
- Data flow: components read lifecycle state through `useSession`; orchestration code calls the behaviour verbs.
- Non-obvious design decisions: "Widening this interface is the explicit act of widening what features may do to a session (and what every test fixture must stub)" — the interface is the permission boundary, and implementation-internal entry points stay on the class.
- Edge cases / failure handling: the retirement reason carries the ordered durable attachment references so a composer can release successful cards while preserving failed drafts.
- Surprising: the *reason* of a retirement is part of the contract, not a log message.

### packages/api/session-controller/src/client/contract/sessions.ts
- Purpose: The outward `ctx.sessions` face (head read).
- Key abstractions: `ISessions`, `SessionTarget = SessionId | SubagentAddress`, `SessionReference`, `SessionRetainInfo`, `SessionRetainOptions`.
- Data flow: feature packages retain, use, bind and inspect sessions through this face only.
- Non-obvious design decisions: a `SubagentAddress` "owns no lifetime" — retaining one is a *read* of a durable address, not a claim on a runtime object.
- Edge cases / failure handling: the face carries no transport entry points, so a feature package cannot reach the wire directly.
- Surprising: the sessions face is where "reference counting" is expressed as a *public* concept (source counts, `using()`), not an internal detail.

### packages/api/session-controller/src/client/contract/snapshot.ts
- Purpose: Session-owned observable state excluding Conversation target data (head read).
- Key abstractions: `PendingSubmissionImage` (a browser-owned preview URL), the pending-submission attachment branches.
- Data flow: the snapshot is what a UI binds to.
- Non-obvious design decisions: the preview URL's lifecycle belongs to the submitter, never to the snapshot — so the snapshot cannot be the reason an object URL leaks.
- Edge cases / failure handling: the image branch carries an optional name, width and height probed by the submitter.
- Surprising: "Session-owned observable state **excluding** Conversation target data" — the snapshot is deliberately not the whole conversation.

### packages/api/session-controller/src/client/time-zone.ts
- A five-line browser time-zone sampler: `resolvedClientTimeZone()` throws when the runtime cannot provide a non-empty IANA zone.

### packages/api/session-controller/tests/agent.host.spec.ts
- Agent lookup spec (header + 10 test titles read): cwd-conflict descriptions, point-observation mapping to not-found, an explicit inspection signal forwarded, a direct resume from a retained observation, an invalid observed header rejected, cold identities mapped through Typert lookup failures, raced ordinary Agents and ownership failures after a resume throw, and a held Session writer identified *without* classifying other resume failures as contention.

### packages/api/session-controller/tests/archived-session-gate.host.spec.ts
- Gate spec (header + 5 titles): an archived session rejected and others let through; subagent descendants rejected at any depth but forks not; a damaged looping lineage terminating; and the rejection lifted once the plugin fiber is disposed.

### packages/api/session-controller/tests/assistant-stream.client.spec.ts
- Client assistant-stream spec (header + 10 titles): the durable window replaced and only the baseline prefix reconstructed; durable events not owned by the active attempt passed through; a successful message published at stream end with its chunks retired at its step end; retained chunks cleared on replacement; failed and interrupted attempts retired at stream end; duplicate durable settlements rebaselined; an unknown attempt falling back to its durable settlement; chunk or terminal index mismatch rebaselining; and abandonment settling only when no durable settlement remains pending.

### packages/api/session-controller/tests/assistant-stream.host.spec.ts
- Host accumulator spec (header + 1 title): stale lifecycles replaced, frame gaps rejected, each baseline cached.

### packages/api/session-controller/tests/client-apply.client.spec.ts
- Client apply spec (header + 7 titles): `$events` frames routed into the object layer with `handleConnected` run once per generation; `handleConnected` run at apply when the Host is already connected (the reload case); immediate control projections kept when the ready notification follows their baseline; a carrier-loss retry with a second opening snapshot reported as a protocol error; Host-addressed Agent scopes materialized before the list arrives; Agent Context identity projected in both directions with the adapter withdrawn on unload; and the control stream waiting for a Host generation before retrying.

### packages/api/session-controller/tests/client-contract.client.spec.ts
- Contract spec (header + 6 titles): branded Session positions required at internal fixture boundaries while the API wire stays numeric; prompt text and image parts identical to attachment intake; exact replace/prepend/append window changes; an append that does not traverse the complete window; and one exact Assistant settlement delta published after its transient rows retire.

### packages/api/session-controller/tests/commands-create-fork.host.spec.ts
- Create and fork spec (header + 8 titles): creation in the default cwd without a named identity; missing Workspaces and attachment failures mapped; contradictory create targets rejected; a missing cold source with and without persistence; an observation failure mapped to an internal fork error; a Session with no completed turn rejected; lineage lookup and Agent creation failures mapped; and absent cwd/preset metadata omitted before a Workspace attachment failure is reported.

### packages/api/session-controller/tests/commands-queue-attachment.host.spec.ts
- Queue and attachment spec (header + 10 titles): the cold Agent resolver rejection preserved; queue edit/remove/steer with stale occurrences rejected; the selected message removed before Agent steering; one-shot, seed-only, missing and malformed child descriptors kept behind the ownership fence; a malformed inbox entry not authorizing an attachment; unrelated fields of a known message ignored; references found in direct, message, inserted and streamed content; and missing persistence identities and attachment backend failures mapped.

### packages/api/session-controller/tests/commands-upload-file.host.spec.ts
- Upload spec (header + 9 titles): an HTTP route bound to the upload service; one verbatim upload staged with its order preserved against an admitted image; a bounded byte stream with cancellation forwarded to storage; the stream name optional and storage failures mapped to the same vocabulary; a prompt citing a never-staged file rejected; no receipt published when the exact Agent is disposed during storage; a cold ordinary Agent resolved and the resolver registration released; a cold upload rejected with no Agent resolver; and subagent uploads rejected *before* storing bytes.

### packages/api/session-controller/tests/control-queue.host.spec.ts
- Control Inbox projection spec (header + 7 titles): both pending lists projected in baselines and live replacement frames; queue replacements derived from the completed projection regardless of registration order; inbox state projected for live and cold sessions; the prompt `rpcId` projected from a `user-rpc` source and omitted elsewhere; Inbox values published for sessions with no live Agent; broadcasts dropped after cancellation ended the queue; and active streams ended on context disposal after flushing buffered frames.

### packages/api/session-controller/tests/controller.host.spec.ts
- Facade spec (header + 3 titles): the Tools service is not required; Host service methods owned and Agent lifecycle projections published; an admitted background promotion awaited during teardown.

### packages/api/session-controller/tests/event-script.client.ts
- Test helper building tool-call, tool-result and user-message scripts for assembled-client session tests (head read).

### packages/api/session-controller/tests/file-references.host.spec.ts
- `SessionFileReferences` spec (header + 1 title): the resolved Agent, query and cancellation signal delegated unchanged.

### packages/api/session-controller/tests/history-records.client.spec.ts
- History-record projection spec (header + 3 titles): an ordinary event and its point cursor retained; one message with an embedded compact text stream; an attempt stream and optional tool-name absence preserved.

### packages/api/session-controller/tests/inbox-projection.client.spec.ts
- Inbox spec (header + 4 titles): the complete Agent-owned value stored without adding queue state to the Session snapshot; only the highest-seq value received before Session materialization retained; and no mutation of the Inbox projection before the Host publishes its committed value.

### packages/api/session-controller/tests/lineage.client.spec.ts
- Lineage spec (header + 5 titles): established root and sibling order kept while children expand DFS with depth; an orphan degraded to root level without being dropped; a two-node cycle failing soft with every entry emitted and a warning fired; a self-referencing entry handled as a cycle member; and lineage rows kept free of completion presentation state.

### packages/api/session-controller/tests/list-scheduling.host.spec.ts
- List scheduling spec (header + 9 titles): work accumulated across both phases with the deadline reset after waiting; an overridden budget honoured without yielding early; skipped-record classification counted in the budget; default and overridden budgets resolved without changing the native-opening input; an overridden budget routed through the public Session Controller; cold summaries not started after cancellation during the last live row; a pre-aborted request rejected before querying headers; cancellation checked after the header query before any row is summarized; and an empty list returned without invoking a summary.

### packages/api/session-controller/tests/manager.client.spec.ts
- Manager spec (header + 10 titles): acceptance retained while an unlisted Session stays resident and forgotten on drop; running retained for an unlisted child with only a retained address; running retained for a row added during a pull whose baseline omits it; a later blank baseline accepted without an acceptance or running observation; acceptance received before the first list response retained; a rejected first prompt kept blank across refresh and object replacement; running from a list response that predates removal ignored, including after re-addition; running observations retained after re-addition while an older list response is pending; and a late acceptance applied to a re-added row without materialising its Session.

### packages/api/session-controller/tests/media-references.host.spec.ts
- Media-reference spec (header + 8 titles): the inclusive image cap served and larger images refused for GET, HEAD and Range; a sparse 1 GiB image rejected before content I/O; post-stat image growth rejected by the filesystem byte reader; Range ignored and complete bodies returned without advertising ranges; HEAD answered without reading content; malformed paths, absent files and directories rejected; files and symlink targets outside the cwd readable without a workspace registry; opaque remote targets read through `ctx.fs` with provider failures preserved; and an empty file served with an aborted request respected.

### packages/api/session-controller/tests/notifier.client.spec.ts
- Notifier spec (header + 9 titles): N `markDirty` calls collapsed into one flush that rebuilds before notifying; the rebuild skipped with zero listeners and `ensureFresh` rebuilding lazily exactly once; `notifyNow` running listeners synchronously; `notifyNow` with zero listeners staying lazy; a scheduled flush after `notifyNow` a no-op; frame-dirty changes collapsed into one cumulative frame publication; a structural microtask publication superseding a pending frame; a microtask fallback when animation frames are unavailable; and unsubscribed listeners stopping their notifications.

### packages/api/session-controller/tests/projection-discovery.host.spec.ts
- Projection discovery spec (header + 9 titles): V3 migration deferred without reading child bodies or publishing a successor; other cached hints served without inventing a missing catalog; no hints from an unrelated cache identity; a current-format cold catalog read from disk when its cache is absent; read-prepared historical files reported as migration-required until a successor is published; sequenced projections read after write publication replaces the disk format status; unsupported current-format events reported instead of deferring migration; unavailable projections reported from an otherwise readable observation; and the live registry cut served instead of a conflicting cached hint.

### packages/api/session-controller/tests/projection-store.client.spec.ts
- Projection-store spec (header + 9 titles): a watermark exposed only for current Host-sequenced values; `undefined` read until a value lands (capability absence); frames applied last-wins by seq so replays and stale frames drop; a stale baseline neither overwriting nor clearing a newer frame while a fresh one reseeds and clears; cached values filling empty keys only and never displacing a sequenced row; every sequenced write outranking a cached row; faces notified for cached fills and for their discard by a baseline; all generation watermarks cleared without replacing subscribed faces; and the key face notified on change but not on dropped applications.

### packages/api/session-controller/tests/reference-ownership.client.spec.ts
- Reference-ownership spec (header + 9 titles): an unknown identity observed without creating a scope, reference or history request; the shared initial opening with independent source contributions visible before the await; repeated uses of one source counted and the source omitted after the final release; counts kept through catalog refresh/removal and reprojected when the row returns; a synchronous Gateway Context retained before catalog discovery without history I/O; only one waiter cancelled while another owns the shared initial opening; a previously cancelled acquisition rejected without creating a generation or publishing counts; a synchronously cancelled readiness wait released through `using()`; and the old generation withdrawn before an observer retains a same-id replacement.

### packages/api/session-controller/tests/remote-access.host.spec.ts
- Access spec (header + 7 titles): the controller owns the Session resource kind and its `sessionId` default field; page and follow read the Session resource of the *addressed* Session; a global role may call `session/list` while the rows are limited to those a Session role admits; a non-owner receiving only the `session/search` hits their Session role admits; control baselines and projection frames filtered for a non-owner; a non-owner caller recorded on the prompt source with owner sources unchanged; and a non-owner reading projections only in a Session its role names.

### packages/api/session-controller/tests/remote/bench.client.ts
- Test helper: Session objects owned by a client test's explicitly started Gateway assembly (head read) — it keeps a `RemoteMock` and disposes it in `onTestFinished`, so every assembled-client spec gets the same transport lifecycle.

### packages/api/session-controller/tests/remote/history.client.ts
- Test helper: pure history response builders for assembled Session tests (head read) — it stamps `SESSION_FORMAT_VERSION` onto the records it builds, so a spec can produce a *valid* history page without a real persistence layer.

### packages/api/session-controller/tests/remote/session.client.ts
- Test helper: the Remote side of one Session under test (head read) — default answers for every `session/*` and `subagents/*` endpoint a `Session` or its manager calls, so a spec only overrides the endpoint it is about.

### packages/api/session-controller/tests/scope.client.spec.ts
- Scope primitive spec (header + 6 titles): same-id generations routed independently while untagged listeners stay shared; `scopeOf` tagging the context and leaving the root untagged; scoped dispatch reaching same-session and untagged listeners but never a foreign session; `bail` answering the first same-scope listener and skipping filtered foreign ones; a subject-less root dispatch unfiltered; and fiber disposal removing scope-owned listeners.

### packages/api/session-controller/tests/session-cold.host.spec.ts
- Cold-session spec (header + 10 titles): the listed format status preserved and live readiness preferred without extra persistence reads; a predecessor title hint used with zero cold stat or body reads; cold rows served from current cached projections without body access; `updatedAt` tracking only human prompts and ignoring pickup and non-prompt work; the stored interrupted prefix served verbatim without activating the session; and a cold session resumed before mutating a restored queue row.

### packages/api/session-controller/tests/session-fork.host.spec.ts
- Fork spec (header + 9 titles): required migration reported before creating a fork when the caller disallows it; a resident Session forked without consulting disk metadata or requiring a live Agent; a source attached while its historical format stat is pending; a stat failure reported without treating it as required migration or opening the source; the completed manual compaction checkpoint kept when `atSeq` is omitted; an exact cut at a completed turn with lineage and cwd recorded; a subagent fork attached to its nearest workspace-owning ancestor; a persisted subagent forked without resuming its Agent; and the latest completed prefix used only when `atSeq` is omitted.

### packages/api/session-controller/tests/session-history-journal.host.spec.ts
- History-journal spec (header + 10 titles): an empty opted-in Assistant baseline opened before any live attempt exists; foreign and opening-baseline frames buffered during the source observation filtered; an opted-in baseline opened with mixed live FIFO order preserved; revision one forwarded when the attached Agent lifecycle restarts after opening; an empty replacement baseline published after an Agent frame revision gap; the active attempt dropped when an Agent chunk index is not dense; an unchanged Assistant baseline reused across follow openings; an empty baseline opened before the target Agent emits frames; and Assistant frames from another Session filtered out of the target follow.

### packages/api/session-controller/tests/session-list-blank.host.spec.ts
- Blank-bit spec (header + 2 titles): standalone events (command lifecycle, plan/mode, title) keep the session blank, and the first turn clears blank.

### packages/api/session-controller/tests/session-models.host.spec.ts
- Model spec (header + 10 titles): an ordered image batch validated before any member is persisted; an admitted image batch delivered through steer with the same ordered content as queue; a text-only selection allowed while durable or pending images remain available for later models; attachment bytes authorized only when the session event stream references the id; configured key references checked even for empty catalogs and profiles without keys skipped; successful providers grouped with an unlisted current selection left out of the catalog; optional catalog metadata and string provider failures preserved; an unlisted model rejected while available models switch only after the next assembly; and the Agent default read live for a session whose log names no selection.

### packages/api/session-controller/tests/session-open-workspace-path.host.spec.ts
- Workspace-path spec (header + 8 titles): the deployment opener capability reported independently of a Session; availability derived from config, an injected opener or the platform probe; a Client-resolved workspace path handed to the Host opener unchanged; relative and absolute Host-resolvable paths normalised; empty paths rejected before opening anything; native opener failure and cancellation results preserved; opener cancellation and non-Error failures classified; and Host file-manager metadata reported with reveal dispatched separately from default-app open.

### packages/api/session-controller/tests/session-pending-submissions.client.spec.ts
- Submission-echo spec (header + 10 titles): the echo inserted synchronously and the engaging edge flipped before any prompt call; the echo placement derived and captured from the running state and delivery mode; rapid ordinary submissions kept in Chat until the running update arrives; abandonment retiring the echo as failed exactly once; a rejected identified prompt retiring its echo immediately alongside `promptError`; the echo identity sent as the prompt `requestId`; an unidentified prompt failure leaving registered echoes alone; and observed retirement.

### packages/api/session-controller/tests/session-presets.host.spec.ts
- Preset spec (header + 10 titles): the requested preset recorded on the Session header; the roster default recorded when the caller names none; an unknown preset rejected; the header left preset-less when no roster is composed; a blank Session recomposed under the default when none is named and under the named preset otherwise; a blank Session that already runs the requested preset kept; and the requested preset validated before the blank Session is touched.

### packages/api/session-controller/tests/session-projections.host.spec.ts
- Projection spec (header + 9 titles): the v0 numeric seed cut kept on the wire while logical headers expose only lineage; pending and used model selections tracked across repeated request headers; the unit value served on the tail page with `asOfSeq` = last event seq; a cold persisted queue reconstructed without publishing or resuming an Agent; claimed steering removed from the pending Inbox projection immediately; a complete current replacement cut returned on each follow generation; an empty log projected at cursor -1; the attachment `imageLimits` published as a constant unit while both seams are composed; and the `imageLimits` key absent while no attachment service is composed.

### packages/api/session-controller/tests/session-remote-rejection.client.spec.ts
- Rejection spec (header + 2 titles): a rejecting Remote face propagates from prompt and cancel (recording no prompt error) and from a subagent continuation prompt and interrupt.

### packages/api/session-controller/tests/session-rename.host.spec.ts
- Rename spec (header + 4 titles): acceptance through the composed title service with a normalized user-source event and an echoed seq; only an empty-normalizing title mapping to `title-invalid`; a non-validation rename failure (a stale session object) mapping to internal; and internal when the composition mounts no session-title service.

### packages/api/session-controller/tests/session-search.host.spec.ts
- Search spec (header + 10 titles): search rejected when the query service is absent; only list-visible ids and current conversation-message events searched; invalid wire queries rejected before the search provider is invoked; an empty page returned without invoking the index; a snippet whose recorded provider violates the Host filters rejected; the globally ranked stream paged until the 20-item Host boundary is known; a learned provider `maxLimit` of 10 with the 20-item result plus lookahead; a page-limit probe counted inside the 100-call budget; and a stale continuation restarted with its learned limit and original visibility snapshot.

### packages/api/session-controller/tests/session-skills.host.spec.ts
- Skill-catalog spec (header + 7 titles): a moved cold Session's catalog read from its recorded current directory without resuming an Agent; a live Agent addressing a preset-owned registry; the recorded preset standing scope used for a cold Session; a fallback to the global registry when the recorded preset is unavailable; an absent skill registry reported instead of an empty catalog; observations without projections rejected; and a provider listing failure classified.

### packages/api/session-controller/tests/session.client.spec.ts
- Session-object spec (header + 10 titles): a second scope binding refused until the owned scope is unbound; a bare Session kept blank until an authoritative lifecycle signal arrives; a blank list hint rejected when current metadata records a started conversation; the tail page installed cold → loading → open with window and nodes in place; concurrent opens sharing one follow and a reopen being a no-op; an error result landing in `openState: 'error'` with the Remote failure kept; exhausted carrier retries landing as `openState: 'error'` `gateway/internal`; a Gateway-marked stream failure landing in `openState: 'error'`; and live frames landing right behind the opening snapshot with the page overlap dropped.

### packages/api/session-controller/tests/sessions-service.client.spec.ts
- Catalog spec (header + 9 titles): format-status changes published and a newer update preserved over an in-flight list; durable titles projected separately from cwd/id display fallbacks and parent links; a blank session reprojected from the generic agent-preset projection; live increments (host stream via manager) reflected into the store; transient content search delegated without changing the list snapshot; a conversation opened from follow projections without a second projection request; and the final Assistant message published before its transient chunks are retired at step end.

### packages/api/session-controller/tests/subagent-catalog.host.spec.ts
- Subagent-catalog spec (header + 8 titles): complete catalog values pushed through the shared control stream; disk migration status used instead of the normalized header version to defer a cold catalog read; a live parent served from its maintained registry state without folding its log; Agent availability reported through Session summaries independently of projections; a Session not republished when its Agent outlives the Session registration; registered projections read without a subagent provider or catalog key; the parent id validated with not-found kept distinct from cancellation; and a live snapshot failure reported without falling back to stored metadata.

### packages/api/session-controller/tests/test-remote.ts
- A test-only direct Remote face over the Session Controller's internal controllers, built from `SessionControllerInternals` (head read).

### packages/api/session-controller/tests/time-zone.client.spec.ts
- Time-zone spec (header + 1 title): the runtime-resolved zone returned.

### packages/api/session-controller/tests/transport.client.spec.ts
- Transport spec (header + 10 titles): current envelopes and payloads preserved without normalization across every journal path; the assistant opt-in publishing the reconnect baseline plus a live frame; an opted-in opening omitting its baseline rejected; an Assistant frame arriving before the baseline rejected; a rebaseline after a transient assistant revision gap without advancing the durable cursor; a rebaseline when a replacement Agent lifecycle restarts at revision one; one scalar current-event range validated before Client entries are published; an event journal bound to one address publishing replace, append and prepend changes; the retained window replaced from each reconnect snapshot.

### packages/api/session-controller/tests/transport.host.spec.ts
- Transport-host spec (header + 9 titles): the follow opening at the current cursor and following later events; active followers ending when the owning Controller unloads; a reconnect carrying a complete replacement snapshot before later live events; the subscription placed before a cold read with unrelated and replayed buffered events ignored; creation buffered while the opening observation is unresolved; the unpublished end-seed boundary bridged when a cold source attaches; gaps in replayed and live event sequences rejected; an empty source opened at cursor -1; and an empty projection baseline published when the query has no registry.

## Ideas worth stealing

- **A "strict definition withdrawn" must fail, not fall back** — `packages/api/gateway/src/index.ts:862` — The Gateway tracks whether an endpoint *ever* had a strict generated descriptor (`ctx.typert.local.hasSeen(endpoint)`) and, when the definition owner unloads, throws `gateway/definition-unavailable` ("its strict definition was withdrawn and SRC fallback is forbidden") instead of quietly switching to the permissive SRC path. For August: a method that was once strongly typed must never silently degrade to duck-typed dispatch — that is exactly how a "the validation got weaker" regression becomes invisible.

- **A reconnecting stream's opening item needs an explicit accept() handshake** — `packages/api/gateway/src/client/remote-stream.ts:16` — Each item carries a monotone `generation` number and the consumer calls `accept()` only *after* it has validated the opening baseline or cursor. The domain then classifies a generation end with `ended(accepted)`: accepted → retryable carrier loss; not accepted → terminal. For August: this is the missing half of "the model is mid-stream" — a dropped SSE is only fatal if the consumer never got a consistent starting point.

- **One baseline per generation, and the previous baseline stays published while retrying** — `packages/api/gateway/src/client/snapshot-stream.ts:31` — `RemoteSnapshotStream` requires exactly one snapshot per generation, refuses a delta that arrives before it, and keeps the *previous* domain snapshot visible while the carrier reconnects; a replacement becomes accepted only after the domain's `replace()` succeeds. For August's transcript/projection surfaces: a reconnect must never blank the screen, and a half-applied replacement must be all-or-nothing.

- **The journal validates continuity itself, using a domain-supplied cursor algebra** — `packages/api/gateway/src/client/journal-stream.ts:48` — the domain supplies `first`, `last`, `compare` and `follows`; the stream refuses a page whose entries are discontinuous or whose tail is not the requested cursor (journal-stream.ts:558, :574). For August: a compaction or a reconnect can produce a gap; the check belongs in one shared place, parameterised by the domain, not repeated per caller.

- **Every stream carries a byte-bounded inbox and overflow fails the stream, not the process** — `packages/api/gateway/src/stream-server.ts:61` — `streamInboxBytes` bounds the buffered uplink frames; exceeding it fails the logical stream with `gateway/uplink-overflow` (stream-server.ts:360), and the Gateway publishes the *window* but issues no credits. For August: a tool that produces output faster than the model consumes it needs a hard byte ceiling with a named failure, not an unbounded queue.

- **A liveness signal that counts buffered writes, not just pings** — `packages/api/gateway/src/stream-server.ts:114` — two missed heartbeats terminate a socket, but a *buffered downlink write* also counts as liveness, because a successful write only means the peer (or a proxy in front of it) accepted the bytes. For August's web/Tauri bridge: the same asymmetry exists between "the desktop shell wrote to the socket" and "the browser received it".

- **Access control decided from wire identities, before any object is materialised** — `packages/api/gateway/src/access.ts:40` — the resource resolution chain (resources reader → lookup provider → Context adapter → default field) runs on the *already-validated* arguments, so a denied call never resolves a lookup or opens a Session. For August: the permission check belongs before the work, and it should be expressible in terms the caller can see (ids), not internal objects.

- **One policy-failure log line per policy, not per call** — `packages/api/remote-access/src/index.ts:127` — a policy that throws yields `policy-failed` and is logged once until the next `invalidate()`, because snapshots and list filters ask many times per change. For August: a broken policy backend can be asked hundreds of times per frame; the log must not become the denial mechanism.

- **"Never a default" — the caller names the Peer** — `packages/api/gateway/src/types.ts:26` — `InvokeRemoteRequest.peer` is required; the Gateway never supplies a default Peer, and a dispatch from a disposed Peer fails with `gateway/peer-disposed`. For August: an implicit identity (a default user, a default session) is a place where a "who is asking" question gets answered wrongly with no trace.

- **Reasoning effort as a first-class, per-turn-pinned selection** — `packages/acp/acp/src/model-control.ts:75` — `pinTurn(turn, selection)` freezes the route for every step of one admitted prompt and `releaseTurn(turn)` clears only that exact turn's pin; the option's value is `JSON.stringify([provider, model])` so two providers offering the same model id stay distinguishable. For August: changing the model mid-turn is a real hazard; pinning the route per turn makes the choice auditable.

- **Strict canonical base64 checked by round-trip, not by regex** — `packages/acp/acp/src/content.ts:52` — `data.toString('base64') !== block.data` rejects URL-safe aliases, whitespace and padding variants that a regex alone accepts. For August: any "decode this attachment" path should be round-trip checked, because a lenient decoder is a silent corruption path.

- **`__proto__` is a legal env var and a legal header name** — `packages/acp/acp/src/mcp.ts:84` — the env/header map is built with `Object.create(null)` and the comment names the reason: *"a null prototype keeps that entry as data instead of invoking Object.prototype's setter"*. For August: any map built from user- or model-supplied keys needs a null prototype, and the test that proves it (`mcp.spec.ts:80`) is the one worth copying.

- **A freeze-the-route-per-turn plus release-only-the-exact-turn pair** — `packages/acp/acp/src/model-control.ts:83` — release is guarded by `if (this.turnSelection?.turn === turn)`, so a late release of turn 3 cannot clear turn 4's pin. For August: any per-turn resource (a lock, a route, a budget) needs the same "release only what you own" guard, because out-of-order teardown is normal.

- **Drain the children before the parents** — `packages/acp/acp/src/session.ts:461` — the bridge calls `subagents.drainDescendants([this.agent])` *before* releasing its own sessions, because a continuable activation outlives the turn that started it. For August: an orchestrated run's teardown order is a correctness property, and the spec (`dispose.spec.ts:65`) pins it.

- **A cancelled turn is `cancelled`; an aborted one is `end_turn`** — `packages/acp/acp/src/codec.ts:20` — the comment states the rule: *"`cancelled` is reserved for explicit client cancellation and disposal, both settled out of band; a turn aborted by a hook or another owner is ordinary quiescence"*. For August: distinguishing "the user stopped it" from "it died" is what makes a retry decision possible.

- **Every list read is a projection, and the work slice yields only between complete rows** — `packages/api/session-controller/src/list.ts:147` — the deadline is checked between whole rows and reset after each yield, so a row is never torn; cancellation is checked per row and after each yield. For August: a sidebar or a file list that reads 500 sessions must be cancellable and must not hand back half a row.

- **A "blank" bit that means "no turn has run", not "the log is empty"** — `packages/api/session-controller/src/list.ts:47` — `const blank = state.blank && event.type !== 'turn/start'`, so standalone plugin events (a command record, a title change) do not clear it. For August: any "is this conversation empty?" flag will be wrong unless it names the *event* that makes it non-empty, and a plugin that logs must not be able to clear it by accident.

- **"A predecessor cache may supply only its version-compatible title, as a stale display fact, never as an authoritative fold seed"** — `packages/api/session-controller/README.md:44` — a current-format cache identity may supply every list hint, but a lifecycle-mismatched predecessor may supply only a title. For August: a cache from an older schema is a *display* hint; letting it seed a fold is how stale data becomes structural.

- **Prompt rejects empty content before resolving the Agent** — `packages/api/session-controller/src/commands.ts:60` — `hasPromptContent` accepts a non-text part or non-whitespace text, and the check runs *before* the Agent is resolved or a Session event is appended. For August: validation that happens after side effects is validation that can be bypassed by the failure path.

- **A prompt retry with the same `requestId` returns the original acceptance** — `packages/api/session-controller/README.md:34` — a request whose id is already queued or logged returns the original acceptance without inserting another message. For August: an idempotent submit is the cheapest possible defence against a double-click, a retry and a reconnect.

- **The Archived-session gate blocks at `pre-step`, so the turn ends `blocked` rather than cancelled** — `packages/api/session-controller/src/archived-session-gate.ts:30` — an archived Session (or a subagent descendant of one) cannot run a model step; the lineage walk follows durable header fields only, so a **fork** of an archived Session is independent, and a looping lineage terminates on a visited set. For August: "this work must not run any more" is best expressed as a pre-flight gate, not a kill.

- **Higher-seq-wins for projections, and a cached value never outranks a connected Host** — `packages/api/session-controller/src/client/sessions/projection-store.ts:161` — sequenced rows merge under higher seq wins; a `cached` row from a persisted checkpoint has no comparable seq and always yields; a baseline discards every cached row before it seeds. For August: this is the whole "server truth vs local cache" conflict resolved in one store, with no domain code.

- **A baseline merge that keeps the client's established order** — `packages/api/session-controller/src/client/ordered-baseline.ts:11` — baseline-only identities are inserted relative to the nearest *following* known identity and absent identities are removed, so an authoritative baseline updates values without reordering what the user is looking at. For August: a list refresh that reorders under the user's cursor is a UX bug that no test of "the data is right" would catch.

- **The client owns the *shape* of the wire, the server owns the *content*** — `packages/api/session-controller/src/client/session-wire-event.ts:17` — the validator rejects an unexpected key rather than stripping it, and event names and payloads stay merge-extensible; range membership and source existence remain Host-side durable-log checks. For August: a lenient client validator turns a schema drift into silent data loss.

- **Notifications are batched by *kind*: structure in a microtask, stream by animation frame** — `packages/api/session-controller/src/client/sessions/notifier.ts:12` — and the snapshot rebuild is skipped entirely when there are no listeners. For August: token streaming and structural updates have different latency requirements, and one notifier that treats them alike either flickers or lags.

- **A local echo inserted synchronously, before the caller serializes and prompts** — `packages/api/session-controller/src/client/sessions/session.ts:1` — `beginSubmission` inserts the echo *synchronously* so the conversation can show the message on the submit click's own frame; the echo's placement is derived from the running state and then retained until the display handoff; each retirement fires `onRetire` exactly once. For August: an optimistic UI needs a local echo that is inserted at the click, not after the network round trip, and needs a retirement rule that fires exactly once.

- **A 128 KiB render tail with a `gapBefore` flag instead of an unbounded buffer** — `packages/api/job-controller/src/client/model.ts:16` — a bounded tail plus one boolean that says "bytes before this were dropped" is enough for a live preview, and the flag covers eviction, resume gaps and the render bound alike. For August: a live output view needs a bound and an honest "there is a hole here" signal.

- **Non-consuming observation: the browser's read never moves the model's cursor** — `packages/api/job-controller/src/rows.ts:15` — both job streams are projections of the registry; the model's `job_output` cursor and notice state never observe them, so a human watching a job does not steal its output. For August: a human-facing view of the agent's work must not be a *read* of the agent's read cursor.

- **A human's kill is not the model's kill** — `packages/api/job-controller/src/index.ts:125` — the reason is `cancelled by the user`, and because the notice ledger withholds only the *model's own* `job_kill`, the owning agent's completion notice still arrives carrying the reason. For August: a user-initiated stop should still be *reported* to the agent, not silently swallow the completion.

- **The lookup and the kill share one synchronous span** — `packages/api/job-controller/src/index.ts:113` — the comment states the reason: nothing can remove the job in between, and a producer-cancel throw propagates per the registry contract instead of masquerading as `job-not-found`. For August: any "check then act" pair on shared state needs one span, and the failure taxonomy must not collapse "not found" and "the thing threw".

- **Subscribe before the first read, or a commit can be lost forever** — `packages/api/job-controller/src/rows.ts:35` — the comment says it: *"Subscribe before the first read so a commit between the read and the wait cannot be missed."* For August: every read-then-wait loop in the harness needs this, and it is a two-line fix that is easy to lose in a refactor.

- **One forwarded-event allowlist that both faces derive from** — `packages/api/remotes/src/remote-events.ts:26` — the `emit`/`waterfall` mode is simultaneously the Host dispatch strategy and the legal key set of `ctx.remote.$on`; the file is listed in *both* compiler faces on purpose so the two cannot drift. For August: the set of events a UI may receive should be declared once and typed in both directions.

- **A forwarded waterfall must carry its routed Agent directly** — `packages/api/remotes/src/index.ts:67` — `request.agent !== carrierAgent` throws a `TypeError` before forwarding, because the Agent identity is what lets the client pick the right scoped context. For August: an approval or a question routed to the wrong session is worse than one that is not delivered.

- **A non-JSON event argument is rejected at the Host boundary, not at the serialiser** — `packages/api/remotes/src/index.ts:163` — `assertJsonArgs` throws on a non-lossless-JSON argument before the frame is enqueued. For August: fail at the producer, not at the transport, or the stack trace points at the wrong layer.

- **A terminal failure turns a non-owner's access answers false and leaves the owner's true** — `packages/api/remote-access/src/client/mount.ts:125` — the two log messages differ ("owner access answers are unaffected" vs "reload the page to reconnect"). For August: a UI's "can I do this?" must fail *closed* for a restricted user and fail *open* for the owner — and the two cases deserve different messages.

- **A model catalog isolates one failing provider instead of failing the whole list** — `packages/api/session-controller/src/catalog.ts:30` — each provider is resolved inside its own `try`, and a failure becomes a `failure` entry while the other providers still load. For August: a model picker must not lose every provider because one gateway is down.

- **Availability of a *key* is checked independently of availability of a *model*** — `packages/api/session-controller/src/catalog.ts:93` — `hasProviderApiKey` walks the configured credential references, skips the account provider and returns whether *any* provider has a key; it never substitutes another model. For August: "am I logged in" and "is this model available" are two different questions with two different answers.

- **A cold-readable skill catalog that never activates an Agent** — `packages/api/session-controller/src/skill-catalog.ts:44` — the working directory comes from the *projection*, the preset scope is acquired without creating an Agent, and only the winning provider's instruction-file `path` is returned. For August: a command palette must be able to list capabilities without booting a session.

- **`/api/file` served with a sandbox CSP, `nosniff` and `no-store`, Range ignored** — `packages/api/session-controller/src/media-references.ts:12` — the base headers exist because HTML and SVG served from the authenticated API origin could otherwise execute with that origin's privileges. For August: any route that serves user content to a browser needs the same three headers, and Range being *ignored* is a deliberate simplification the doc states.

- **Every endpoint states its activation policy** — `packages/api/session-controller/README.md:34` — list reads only headers and cache rows; search, attachment, history, skill discovery and workspace-path opening may inspect persistence without activating an Agent; cancellation *requires* live state. For August: "does this endpoint wake the agent?" should be a documented, per-endpoint property — it decides latency, cost and side effects.

- **A per-endpoint access declaration with a default field** — `packages/api/session-controller/src/index.ts:152` — the controller registers the `session` resource kind with the default field `sessionId` through `typert.resources`, and `session/page`/`session/follow` declare a `resources` reader that picks `request.address.sessionId` or `request.address.childSessionId`. For August: a permission model needs a *default* (the obvious id) plus a per-method override, or every method re-derives it.

- **A non-owner's prompt records the principal; an owner's source does not** — `packages/api/session-controller/README.md:36` — `principalOf(this.ctx.invocation)` is read and recorded only for a non-owner, so a source without a principal belongs to the owner. For August: provenance in the transcript should be a fact, not an inference, and "absent means owner" is a clean rule.

- **A local submission echo carries the admitted attachment references** — `packages/api/session-controller/src/client/contract/session.ts:19` — an observed retirement includes the ordered durable attachment references so the composer can release successful cards while preserving failed drafts. For August: an optimistic UI needs to know which of its optimistic attachments the server *actually* accepted.

- **Turn-aligned history pages with two minima, and a separate budget for the jump loader** — `packages/api/session-controller/README.md:69` — the initial follow, reconnects and `loadOlder()` request at least 50 append-origin messages *and* cross at least two `turn/start` events; `loadThrough()` uses the same rules with a 200-message minimum per page and the 500-message cap does not limit the whole jump. For August: a page of history is only useful if it contains whole turns.

- **A public `Remote` accessor that never leaks credentials** — `packages/api/account-controller/src/index.ts:26` — every Platform-reaching operation takes the *calling UI's* `AccountClientMetadata` (version, language, UTC offset), so the Host reports the requesting UI rather than the last caller it saw. For August: per-UI metadata (locale, timezone) is what makes a server-rendered message correct.

## Files skipped (with reasons)

None. Every one of the 228 files in this shard was opened. However, the **depth** of the reading varies, and the ledger's note column says so per file:

- Read **in full**: every file under `packages/acp/`, `packages/api/account-controller/`, `packages/api/gateway/`, `packages/api/job-controller/`, `packages/api/remote-access/`, and `packages/api/remotes/` (including the three largest gateway specs, `gateway.client.spec.ts` at 3477 lines, `gateway-stream.host.spec.ts` at 1841 and `gateway.host.spec.ts` at 1668).
- Read **in full at the head** (module doc, imports, class/interface declarations, the leading method bodies) but not every line: `packages/api/session-controller/src/agent.ts` (first 150 of ~700), `commands.ts` (150 of ~700), `history.ts` (150 of ~430), `index.ts` (300 of ~700), `list.ts` (150 of ~400), and the nine `src/client/**` files.
- Read as a **header plus its suite and test titles** (`describe(...)`/`it(...)` lines extracted with a read-only search) rather than line by line: all 41 `packages/api/session-controller/tests/**` files. The file was opened and its intent established; the bodies of the assertions were not read in full.

## Uncertainties

- **The session-controller Host internals are only partly read.** `src/agent.ts`, `src/commands.ts`, `src/history.ts`, `src/index.ts` and `src/list.ts` were read to roughly their first 150-300 lines. I know their module docs, their public method names, their error vocabulary and their first methods, and the `README.md` describes the rest of the contract in detail — but I did **not** verify the implementations of `prompt`, `fork`, `updateQueue`, `selectModel`, `attach`, `cancel` or the follow's gap-repair path line by line. Every claim I make about those comes from the README and the test titles, not from the code. Checked: I read `src/index.ts` lines 1-300 (which contains the constructor and `list`/`search`/`create`), `src/commands.ts` lines 1-150 (constructor, `create`, `hasPromptContent`, `latestCompletedPrefixBoundary`), `src/history.ts` lines 1-150 (`page`, the start of `follow`), `src/list.ts` lines 1-150 (projections, `summaryFor`, the start of `list`).
- **The session-controller Client internals are the least-read files in the shard.** `src/client/sessions/manager.ts` (38 KB), `session.ts` (40 KB) and `service.ts` (28 KB) were read only to their first ~22 lines. The behaviours I attribute to them in the per-file notes come from the package README and from the test titles, not from the implementation. Specifically I did **not** read the actual implementation of `loadThrough`/`loadOlder`, the reference-counting code, the echo-retirement code or the projection-store's merge function body — only its module doc and the surrounding comments.
- **The gateway's `src/index.ts` was read in full, but the middle of the file was rendered truncated to me twice** by the tool's output cap, so roughly the 400-800 and 1000-1700 ranges were seen in fragments rather than as one continuous read. Every specific line number I cite for that file (`362`, `485`, `565`, `616`, `787`, `796-804`, `862-869`, `889`, `902`) was confirmed with a targeted search afterwards.
- **The `remotes` package's `README.zh.md`, `README.md` tail, `tests/built-lib.e2e.ts` and `tests/remote-events.host.spec.ts` were read partially** (head + tail, or the first 80/150 lines). The Chinese README is a translation of the English one, so the information loss is small, but I did not read it end to end.
- **I did not read the ACP `README.zh.md` or the `account-controller`/`job-controller`/`remote-access` Chinese READMEs line by line beyond their content as printed** — in each case the content printed was the full file (they are short), but I read the *English* versions in more analytical depth, so my per-file notes for the Chinese mirrors are correspondingly thinner.
- **The `session-controller` Chinese README was read only to its first 12 lines.** It is a translation of the English README whose content I did read in full, so no mechanism is missing, but I cannot attest to the translation's fidelity.
- **I could not establish which physical carrier the desktop app uses for a given Gateway stream** (`in-process` vs WebSocket) from this shard alone: `packages/api/gateway/src/client/stream-client.ts:502` resolves the URL from `document.baseURI` or a shell-supplied `__DSH_TRANSPORT__.streamBaseUrl`, and the choice of carrier is made by the `Connection` package, which lives in another shard.
- **I did not verify the relationship between the ACP `wireStream.open()` peer argument and the Gateway's `PeerScope`** beyond the README's statement that both are required; the concrete type lives in `dsh-typert-protocol`, outside this shard.
- **The `packages/api/settings-controller`, `terminal-controller`, `workspace-controller` and `workspace-files` packages referenced in `packages/api/README.md` are not in this shard**, so the "one controller package per domain" pattern is asserted from the four I did read (account, job, remote-access, session) plus the table in the api/ README.
