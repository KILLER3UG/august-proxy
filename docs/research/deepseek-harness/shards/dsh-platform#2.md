# deepseek-harness / dsh-platform#2

## Shard shape

This shard is **platform plumbing, not the agent loop**. It holds two package groups: `packages/telemetry` (one package, `otel`, plus its group map) and `packages/typert` (four packages: `generator`, `protocol`, `registry`, `loader`, plus the group map). The Typert group is a **build-time type-reflection → runtime-typed-RPC pipeline**: `generator` reads TypeScript programs and produces a *compiler-independent* model plus generated `lib/typert.<face>.{js,d.ts}` artifacts; `protocol` declares the wire vocabulary (decorators, descriptors, codecs, provider contracts) shared by every party; `registry` is the runtime store for generated reflection, lazy Zod schema factories and invocation descriptors (`ctx.typert`); `loader` is the incremental scanner that discovers a mounted package's `./typert` export and registers it, and withdraws it on unmount. `telemetry/otel` is the OTel reporting service: two independent, caller-owned channels (ordinary count-batched events, byte-bounded Session logs) that never share a queue.

**The repo's own agent-loop lenses (reasoning/thinking content, prompt construction and cache-hit prefix stability, context-window compaction, memory/learning, subagent parallelism, tool-call retry/malformed-output handling, model-specific fallbacks, UI progress feedback) have almost no home in this shard.** Every package README in the shard carries the same three-line "Model Experience: None / KV Cache effect: No direct effect" section — the shard is deliberately *outside* the model request. The lenses that DO land here are the ones about **boundary discipline** and **failure containment**: the boundary between a compiler and a runtime model, between a Host and a Client, between one package and the next, and between a generated artifact and the registry that accepts it. That is where the transferable mechanisms are, and the report's "Ideas worth stealing" section is drawn from them.

---

## Per-file notes

### packages/telemetry/otel/locale/en.json
- Purpose: English UI string table for the `otel` service — a single `meta.title` key.
- Key abstractions: none; a 5-line locale file.
- Data flow: read by the plugin-host locale loader to label the plugin in the UI.
- Non-obvious design decisions: the English table carries only `title`, while the Chinese table carries `title` + `description` (the zh file is a superset) — the English `description` is considered derivable from the package README.
- Edge cases / failure handling: a missing key is a loader concern, not this file's.
- Surprising: the asymmetry (en has 1 key, zh has 2) means the English UI shows a bare title.

### packages/telemetry/otel/locale/zh.json
- Purpose: Chinese UI strings for the `otel` service (`meta.title`, `meta.description`).
- Key abstractions: none.
- Data flow: locale loader → UI label and tooltip.
- Non-obvious design decisions: the description text ("为产品事件和会话日志提供独立的数据上报通道。") names the two-channel split, which is the package's whole point.
- Edge cases / failure handling: none in-file.
- Surprising: it is the only place in the shard where the two-channel design is stated in user-facing copy.

### packages/telemetry/otel/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-otel` v0.2.1-rc.2 — the Cordis service that creates OTel reporting channels.
- Key abstractions: exports map (`.`, `./src/*`, `./package.json`, `./locale/*.json`); `files` ships only `lib/index.js` + `lib/types/**/*.d.ts` + locales.
- Data flow: the peer dependency on `@deepseek-ai/dsh-session` supplies the `SessionId`/`SessionEvent` types the Session channel records; `@deepseek-ai/cordis` is a peer so the host supplies the Context.
- Non-obvious design decisions: the OTel SDK deps are pinned to **exact** versions (`0.222.0` for `api-logs`/`otlp-exporter-base`/`otlp-transformer`/`sdk-logs`, `2.11.0` for `core`/`resources`) while `got` and `@opentelemetry/api` use carets — the README states the SDK versions come from "one coordinated release across this service and its two adapters", so a drift between the service and the adapters is a real hazard.
- Edge cases / failure handling: no `postinstall`, no scripts at all.
- Surprising: `@opentelemetry/api` is the only caret-pinned OTel dep; everything that carries the wire format is exact-pinned.

### packages/telemetry/otel/README.i18n.yaml
- Purpose: per-heading bilingual pairing record for `README.md` — one hash per English and Chinese heading block.
- Key abstractions: a flat map of anchor-path → `{en, zh}` hash.
- Data flow: `pnpm run verify-translation-pairing --write packages/telemetry/otel/README.md` re-records the hashes; a CI check compares them.
- Non-obvious design decisions: hashes are computed over blocks *outside code blocks and generated regions* (stated in the header comment) — so a doc change that only moves code is not a pairing failure.
- Edge cases / failure handling: a stale hash fails the pairing check rather than silently drifting.
- Surprising: the pairing is per heading section, not per file, so a translator can land a partial edit and the check still names the section that drifted.

### packages/telemetry/otel/README.md
- Purpose: the package contract — how to mount the service, what the two channels promise, and what the caller owns.
- Key abstractions: `ctx.otel.createEventReporter(options)` and `ctx.otel.createSessionLogReporter(options)`; the channel is caller-owned.
- Data flow: consumer → channel → OTLP HTTP; the service never collects anything on its own.
- Non-obvious design decisions: the README states the design rule plainly — "Mounting alone creates no transport or identity and sends nothing", and the service "has no deployment defaults or automatic collection policy of its own"; every option (endpoint, scope, resource attributes, queue, diagnostic callback) is supplied by the consumer. It also states that "the service does not add a channel header or inherit ambient authorization headers or TLS identity", and that "Agent factories configure their returned agents, including keepAlive" — a deliberate refusal to share a transport, because a shared one would change event attribution.
- Edge cases / failure handling: documented as best-effort, memory-only delivery — queue overflow, oversized Session events, transport failure and process exit can all lose records; there is no durable outbox.
- Surprising: the "Model Experience: None / KV Cache effect: None" section is a first-class part of the package contract, not an afterthought.

### packages/telemetry/otel/README.zh.md
- Purpose: Chinese translation of the `otel` package README, with the same section anchors.
- Key abstractions: mirrors the English headings (`#use-this-package`, `#understand-the-implementation`, …).
- Data flow: paired with the English file through the `.i18n.yaml` hash record.
- Non-obvious design decisions: the Chinese version preserves the same "no deployment defaults" and "no ambient headers" statements verbatim in meaning — the pairing gate exists to keep that true.
- Edge cases / failure handling: none in-file.
- Surprising: it links `../../session/session-telemetry-otel/README.zh.md` for the Session byte limits, keeping the byte ceiling out of this package's own copy.

### packages/telemetry/otel/src/event-log.ts
- Purpose: the ordinary-event channel — SDK count-based batching over a cancellable HTTP transport.
- Key abstractions: `OTelEventRecord` (eventName / body / timestamp / severityNumber / attributes), `EventLogOptions`, `EventLogReporter`.
- Data flow: `emit(record)` → `logger.emit(...)` → `BatchLogRecordProcessor` → the exporter built in `event-transport.ts` → OTLP collector.
- Non-obvious design decisions: `observedTimestamp` is assigned **at enqueue** (`Date.now()`), not at export, so a record's observation time is the moment the caller asked for it rather than the moment the batch flushed. The `body` field is documented as "never a prompt, response, credential, or file contents" — the redaction rule is written into the *type*, not into a code path. The exporter wrapper converts a non-`SUCCESS` result into `onFailure('Product telemetry export failed', result.error)` rather than swallowing it.
- Edge cases / failure handling: `shutdown(signal)` aborts the channel's `AbortController`, which cancels in-flight requests *and* retry waits; it then awaits `provider.shutdown()` inside a `try` and always awaits `exporter.shutdown()` in a `finally`, with the comment "SDK batch shutdown can reject before it releases the exporter" — so the exporter is released even when the SDK rejects.
- Surprising: `severityText` is derived from `SeverityNumber[severityNumber]` — a reverse lookup into the SDK enum, so the wire always carries a consistent text form.

### packages/telemetry/otel/src/event-transport.ts
- Purpose: the ordinary-event HTTP transport — cancellable `got` requests, gzip, retry, and a response-size ceiling.
- Key abstractions: `createEventLogExporter(options, signal)`.
- Data flow: SDK export callback → `send(data, timeoutMillis)` → `got.post` → collector; the returned object wraps the SDK exporter and adds agent destruction on shutdown.
- Non-obvious design decisions: the request carries `followRedirect: false` and the code explicitly throws on any status ≥ 300 — a redirect is a refusal, because a redirect would forward telemetry to an endpoint the caller did not choose. The retry policy is `limit: 5`, `methods: ['POST']`, `statusCodes: [429, 502, 503, 504]`, `backoffLimit: 5000` — 429 is retried, other 4xx are not. `AbortSignal.any([signal, AbortSignal.timeout(timeoutMillis)])` fuses the caller's cancellation with the per-request timeout into one signal.
- Edge cases / failure handling: a 4 MiB download ceiling is enforced *during* the transfer (`downloadProgress` → `request.cancel()`), so an oversized collector response is cut off rather than buffered. The agent is created lazily and destroyed in the `finally` of `shutdown()`, so a failed export still releases the socket pool.
- Surprising: `shutdown()` is written as `shutdown ??= (async () => {...})()` — a memoised promise so a double shutdown cannot destroy the agent twice.

### packages/telemetry/otel/src/index.ts
- Purpose: the Cordis service entry — `ctx.otel`.
- Key abstractions: `class OTel extends Service`, `createEventReporter`, `createSessionLogReporter`.
- Data flow: composition mounts the plugin; consumers inject `ctx.otel` and create channels.
- Non-obvious design decisions: the service holds **no state** — it is a factory. `super(ctx, 'otel')` and two one-line methods; the doc comment says "Mounting creates no queue, identity, or network connection." The service is therefore cheap to mount and cheap to replace (replacement unloads dependent consumers by Cordis injection semantics).
- Edge cases / failure handling: none — every failure mode lives in the channel, not the service.
- Surprising: the file re-exports `LogExporterOptions` from `transport.ts` even though it is a transport-level type — the public surface deliberately includes the transport options so a consumer can build a channel without importing a private module.

### packages/telemetry/otel/src/session-log.ts
- Purpose: the byte-bounded Session-log channel — the mechanism that guarantees one complete event per record and a hard request ceiling.
- Key abstractions: `SESSION_LOG_MAX_REQUEST_BYTES = 4_000_000`, `SessionLogRecord`, `SessionLogProcessorOptions`, `SessionLogProcessor`, `SessionLogReporter`, `resolveSessionLogLimits`.
- Data flow: `reportSessionLog(record)` → SDK `logger.emit` with `eventName: 'session-log'`, `sessionId` and a JSON-string `content` attribute → `SessionLogProcessor.onEmit` → byte-bounded queue → `drain()` → one transport request per batch → `exporter.forceFlush()`.
- Non-obvious design decisions: the processor **measures each record once** — `JsonLogsSerializer.serializeRequest([record])` per record, never the candidate batch — and the comment in the test file states the reason ("measures each record once instead of serializing the full candidate batch"); a batch of 100 records is 100 single-record serializations, not one 100-record serialization plus 100 measurements. The byte budget is computed conservatively: "Each measured record includes its resource/scope envelope. The shared envelope in this provider's multi-record request cannot exceed their sum." An oversized record is **rejected, never truncated** — the warning literally says "content was not truncated". `resolveSessionLogLimits` refuses `maxRequestBytes` outside `1..4_000_000` and refuses a `maxExportBatchSize` greater than `maxQueueSize`.
- Edge cases / failure handling: the queue is bounded (`maxQueueSize`, default 2048) and a full queue drops the *new* record with a warning rather than the oldest. `send()` arms a watchdog timer that only *warns* — "Session log request exceeded exportTimeoutMillis; waiting for transport settlement" — and deliberately does **not** release the transport slot; `drain()` awaits `exporter.forceFlush()` after every batch because "The export callback precedes removal from the SDK concurrency queue", so a second request would race the SDK's own queue.
- Surprising: `shutdown()` memoises `shutdownPromise ??= this.forceFlush().then(...)`, and `stopPending()` clears the queue and flips `stopped`, but an already-unsettled transport may still complete — the README states this as a limit rather than pretending it is cancelled.

### packages/telemetry/otel/src/transport.ts
- Purpose: the shared OTLP JSON HTTP transport used by the Session channel, plus the shared exporter-metrics recorder.
- Key abstractions: `LogExporterOptions` (endpoint + SDK HTTP settings, **with `selfObsMeterProvider` excluded**), `createLogExporter`, `createLogExporterMetrics`, `logTransportOptions`.
- Data flow: `logTransportOptions` → `createOtlpHttpExportDelegate` → `OTLPExporterBase` → collector.
- Non-obvious design decisions: `LogExporterOptions` is `Omit<OTLPExporterNodeConfigBase, 'selfObsMeterProvider'>` — the upstream option is *removed from the type* because the exporter is always constructed with `undefined` for the meter provider, which keeps the self-observability recorder a no-op. `logTransportOptions` deliberately does **not** inherit ambient headers: it builds `headers` from the caller's own function plus a fixed `Content-Type`, and `getSharedConfigurationFromEnvironment('LOGS')` supplies only timeouts/compression, not credentials. The agent factory is the caller's: `httpAgentFactoryFromOptions({ keepAlive: options.keepAlive ?? true, ...options.httpAgentOptions })` — "An agent factory owns the returned agent, including its keepAlive setting."
- Edge cases / failure handling: `headers` may be a function, so the header set is resolved per request; `userAgent` is only added when supplied.
- Surprising: `createLogExporterMetrics` is exported but constructs a recorder with **no** meter provider — it exists only to satisfy the OTLP delegate's signature, and the README says it "receives no meter provider and records nothing".

### packages/telemetry/otel/tests/event-log.spec.ts
- Purpose: the ordinary-channel behaviour suite, driven against a real local HTTP collector.
- Key abstractions: a `collector()` helper that starts a `node:http` server on an ephemeral port and registers its cleanup; a `reporter()` helper that builds an `EventLogReporter` with a spy `onFailure`.
- Data flow: emit → local collector → assertions on headers, request count and `onFailure` calls.
- Non-obvious design decisions: the tests assert on *resource release*, not on payloads — "releases its dedicated agent after exporting explicit asynchronous headers" spies on `agent.destroy`; "destroys the agent when cancellation rejects a batch already in flight" asserts `destroy` was called exactly once. A separate test proves channel isolation: "discards a queued channel on cancellation without cancelling another channel" expects `requests === 1`, i.e. cancelling one channel must not cancel the other. The redirect test asserts the collector received exactly one request and that the failure message names `HTTP 302`.
- Edge cases / failure handling: covered are TLS failure (agent still destroyed), oversized response (4 MiB + 1 rejected), cancellation *while headers are still resolving* (zero requests sent), and cancellation with a batch already in flight.
- Surprising: `afterEach` reverses the cleanup order (`cleanup.splice(0).reverse()`) so disposals unwind in mount order — a deliberate discipline for socket-holding resources.

### packages/telemetry/otel/tests/session-log.spec.ts
- Purpose: the Session-channel suite — byte ceilings, serialisation, transport settlement, watchdog behaviour and channel independence.
- Key abstractions: a `collector(statuses)` helper that captures decompressed bodies and can return a scripted status sequence; `sessionRecord(text, seq)` building a `SessionLogRecord` with deeply nested data.
- Data flow: report → captured OTLP JSON → assertions on `content` equality, byte counts and `onFailure` calls.
- Non-obvious design decisions: the suite includes a **type-level probe** (`meteringOptionsAreExcluded`) that asserts `selfObsMeterProvider` is *not accepted* on either the exporter or the processor — the exclusion is pinned at the type level, not just at runtime. A test proves the ambient environment cannot leak: it stubs `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer unrelated` and asserts the captured request has **no** `authorization` header and no `x-channel` header. Another test proves the queue bound while a transport request is unsettled (4 records, `maxQueueSize: 2` → exactly one "queue is full" warning). The watchdog test asserts the transport slot is **not** released on timeout (`send` called once) and that records submitted after `stopPending()` are never sent.
- Edge cases / failure handling: an exact-fit byte limit is admitted (twice, with the same byte count), a one-byte-over limit is rejected exactly once; a 400 response is followed by a successful one; serializer failures (throw, string, `undefined`) are each contained.
- Surprising: the test "measures each record once" asserts `serialize.mock.calls.every(([records]) => records.length === 1)` — the measurement discipline is a *tested invariant*, not a comment.

### packages/telemetry/otel/tsconfig.json
- Purpose: the package's TypeScript project config.
- Key abstractions: extends the workspace `tsconfig.base.json`; `rootDir: src`, `outDir: lib/types`.
- Data flow: `tsc -b` produces the declaration tree; project references pull in `vendor/cordis`, `vendor/cosmokit` and `core/session`.
- Non-obvious design decisions: `include` is only `src` — the tests are not part of the emitted project, which keeps the published `.d.ts` surface equal to the runtime surface.
- Edge cases / failure handling: none in-file; the reference to `core/session` is what makes the `SessionId`/`SessionEvent` peer types resolve.
- Surprising: the output directory is `lib/types` (declarations only) while the runtime bundle is produced separately by the bundler — the package ships `lib/index.js` and `lib/types/**`.

### packages/telemetry/README.i18n.yaml
- Purpose: bilingual pairing record for the `telemetry` group map.
- Key abstractions: per-heading `en`/`zh` hashes.
- Data flow: `pnpm run verify-translation-pairing --write packages/telemetry/README.md`.
- Non-obvious design decisions: the anchor paths here are group-scoped (`/telemetry-shared-reporting/packages`) rather than package-scoped, so the group map and the package README are tracked by separate records.
- Edge cases / failure handling: hash mismatch fails the pairing gate.
- Surprising: a 6-heading group map and a 12-heading package README are governed by the same mechanism with no separate tooling.

### packages/telemetry/README.md
- Purpose: the group map for `packages/telemetry` — one package, `otel`, and who owns what.
- Key abstractions: a one-row package table; "business consumers select events, identities, authorization, and redaction; transport plugins own encoding and delivery."
- Data flow: the split is the architectural statement of the whole group.
- Non-obvious design decisions: the split between *what* to report and *how* to report is stated as the group's defining rule — consumers own consent and redaction; the transport owns encoding and delivery. The `otel` row describes it as "Cordis service creating independent ordinary-event and byte-bounded Session-log channels" — "independent" is the load-bearing word.
- Edge cases / failure handling: none in-file.
- Surprising: the group has one package but a full group map, a `kind: "package-group"` front-matter and a `Dev Note` section — the docs tooling treats a one-package group exactly like a many-package one.

### packages/telemetry/README.zh.md
- Purpose: Chinese translation of the `telemetry` group map.
- Key abstractions: same four anchors, same one-row package table.
- Data flow: paired with the English file through `README.i18n.yaml`.
- Non-obvious design decisions: it preserves the "business plugins choose … transport plugins own …" division, which is the only content of the page.
- Edge cases / failure handling: none in-file.
- Surprising: it links the Chinese `docs/subsystems/otel.zh.md`, so the pairing is per-locale all the way down.

### packages/typert/generator/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-typert-generator` v0.2.1-rc.2.
- Key abstractions: exports `.` (public API) and `./tsdown` (the bundler plugin) plus `./src/*`.
- Data flow: `typescript` and `@jridgewell/gen-mapping` are the only runtime dependencies — the generator is a build-time tool with no Cordis runtime dependency (Cordis is a peer).
- Non-obvious design decisions: `typescript` is a **runtime** dependency, not a dev one, because the analyzer is the package's product. `@jridgewell/gen-mapping` is there solely to emit a source map for the generated `typert.remote-client.d.ts`, so "go to definition" in an editor lands on the original method.
- Edge cases / failure handling: no scripts; the package is a library consumed by the workspace build.
- Surprising: `zod` is a *dev* dependency of the generator even though the emitted code imports it — the generator does not ship a zod runtime, it emits code that imports the consumer's.

### packages/typert/generator/README.i18n.yaml
- Purpose: bilingual pairing record for the generator README (67 lines, 18 anchored sections).
- Key abstractions: per-heading hashes, including nested anchors such as `/…/use-this-package/ordinary-remote-metadata`.
- Data flow: the pairing gate; the anchor paths mirror the English heading structure exactly.
- Non-obvious design decisions: the anchor for the "ordinary Remote metadata" section is stable enough to be linked from the protocol and registry READMEs (`../generator/README.md#ordinary-remote-metadata`) — the hash file is a *pairing* record, and the anchors are a *public* URL surface.
- Edge cases / failure handling: hash drift fails the gate.
- Surprising: the anchor naming is machine-derived from the heading text, so a heading rename silently breaks three cross-package links — and only the hash gate, not a link check, would notice the English side.

### packages/typert/generator/README.md
- Purpose: the generator's contract — how a package opts into publication, what the emitted artifacts are, and what the analysis guarantees.
- Key abstractions: the `./typert` / `./client/typert` / `./remote` export trio; `WorkspaceAnalyzer` vs `WorkspaceTypertGenerator` vs `FaceModelEmitter`; `rejectBuildOutputs`.
- Data flow: `package.json` declares the export → the tsdown plugin (or `scripts/generate-typert.ts`) analyzes → `lib/typert.<face>.{js,d.ts}` is written → the loader imports it → the registry stores it.
- Non-obvious design decisions: the package is explicit that "Generation runs only at build time and never in a live agent session", and that a contributing package "never depend[s] on the runtime registry" because the generated declaration file types `TYPERT` as `unknown`. The strict/loose input split is explained as *consumer-owned* policy, not a method annotation: "the analyzer and model carry no per-method input policy" — every parameter spec carries BOTH `codec` and `strictCodec`, and the consumer picks. The `rejectBuildOutputs` switch exists so "a passing generation depends only on workspace source and can run before or beside package compilation" — the result must not depend on whether compilation ran.
- Edge cases / failure handling: "generation rejects declarations, publish lists, Remote exports, or Zod projections that it cannot represent correctly"; unsupported Zod projections "fail with a `TypertEmitError` naming the construct instead of flattening or weakening the source type". The limits section is honest about what is *not* modelled: wildcard export patterns, namespace re-exports across faces, generic schema declarations, computed mapped/conditional schema roots.
- Surprising: `WorkspaceTypertGenerator` "analyzes all contributors of each selected face before filtering emitted packages, so a package subset retains the same declaration merges and output bytes as a complete build" — a subset build is byte-identical to a full build, by design.

### packages/typert/generator/README.zh.md
- Purpose: Chinese translation of the generator README.
- Key abstractions: same anchors and the same table of contents as the English page.
- Data flow: paired through `README.i18n.yaml`.
- Non-obvious design decisions: it keeps the "生成过程只在构建时运行，绝不会进入实时 agent（智能体）会话" statement — the same "never in a live session" boundary the English page states.
- Edge cases / failure handling: none in-file.
- Surprising: it keeps the English `agent` word alongside the Chinese gloss, so the sentence is searchable in both languages.

### packages/typert/generator/src/analyzer.ts
- Purpose: the TypeScript project analyzer — 3,468 lines that turn a workspace of `.ts` files into a compiler-independent `FaceModel` + `TypeGraph`.
- Key abstractions: `WorkspaceCaches` (memo over an immutable workspace snapshot), `WorkspaceAnalyzer` (face programs, discovery, batching, write mode), `FaceAnalyzer` (per-face extraction), and the private helpers `convertType`, `ensureDeclaration`, `remoteBoundary`, `resolvedRemoteCodecType`, `assertRemoteJsonType`.
- Data flow: `tsconfig.host.json` / `tsconfig.client.json` aggregates → `projectReferences` → package registrations → one `ts.Program` per face → `FaceAnalyzer.analyze()` → `PackageModel` per package → merged into `WorkspaceModel` (faces + `crossFaceLinks`).
- Non-obvious design decisions: (a) the **extraction/emission split** — the file's own header says "Programs, symbols, and syntax nodes remain extraction-only implementation details; callers receive only the model declared in `./model.ts`". (b) **Two boundaries per wire type**: `RemoteBoundaryModel` keeps the *authored* type for the consumer declaration and a separate `codecType` for the runtime codec, so a consumer sees the alias it wrote while the codec is the resolved shape. (c) **Optional parameters are widened for the codec only**: `remoteBoundary` computes `resolvedType = optional ? checker.getNullableType(declaredType, Undefined) : declaredType`, because "An optional parameter's authored node carries no `undefined`; the codec still has to accept the omitted wire field the consumer sends." (d) **`assertRemoteJsonType` runs before projection** and refuses `any`/`unknown`, bigint, symbol, class instances, callables, symbol-keyed properties and symbol index signatures — the boundary is validated *before* anything is emitted, not after. (e) **An optional Context key is not a service**: the analyzer skips `X | undefined` and `key?: X` Context members, with the comment that describing one as a service "would answer 'add the plugin that provides it' for a key where no such plugin exists". (f) **`hasSeen()` history** survives withdrawal, so a consumer cannot silently downgrade to a source-mode fallback after a strict definition was withdrawn. (g) The write mode is a **source-editing loop**: `requiredType` prints the inferred type, queues a `SourceEdit`, throws `SourceEditQueued`, and `analyze()` catches it, applies the edit, invalidates the cache and re-analyzes in `check` mode.
- Edge cases / failure handling: every failure is a `TypertAnalysisError` carrying `typert(<face>): <file>:<line>:<col>: <message>`. `rejectBuildOutputLoads` (line 3412) aggregates *both* build-output loads and unresolved workspace imports into one message that tells the reader exactly which `compilerOptions.paths` alias to add. Merged declarations that the model cannot retain losslessly are refused rather than flattened. Cross-face namespace re-exports are refused with "cross-face namespace re-exports are not supported" because `TypeTargetModel` cannot model a module namespace yet.
- Surprising: `isRemoteSegment` is a *duplicated* copy of the protocol's `isTypertRemoteSegment` with the comment "Generation bootstraps workspace artifacts before dsh-typert-protocol is built, so this extraction-only copy must mirror `isTypertRemoteSegment()`" — a deliberate, documented duplication forced by a bootstrap ordering constraint.

### packages/typert/generator/src/artifact-files.ts
- Purpose: the package-local artifact writers shared by the tsdown plugin and bundle-free generation.
- Key abstractions: `writePackageArtifacts(packageDir, artifacts)`, `writeWorkspaceArtifacts(root, artifacts)`, and the `REMOTE_CLIENT_FILES` triple.
- Data flow: emitted `ModelEmitResult`s → `lib/typert.<face>.js`, `lib/typert.<face>.d.ts`, and (when Remote methods exist) `typert.remote-client.{js,d.ts,d.ts.map}`.
- Non-obvious design decisions: "a Host artifact without Remote methods removes any Remote client files left by an earlier pass" — stale Remote artifacts are deleted, not left to rot, and the deletion is guarded by `artifacts.some(artifact => artifact.face === 'host')` so a client-only pass never deletes host files. The writer's own doc says "Files are written one by one, so a failed write can leave this package's outputs partially replaced" — a stated, not hidden, atomicity limit.
- Edge cases / failure handling: `rmSync(..., { force: true })` makes the stale-file removal idempotent; a filesystem error propagates as an exception.
- Surprising: the module exists purely so the plugin path and the `scripts/generate-typert.ts` path "leave the same bytes on disk" — the two entry points are byte-equal by construction, not by convention.

### packages/typert/generator/src/build-output-guard.ts
- Purpose: the guard that makes analysis independent of whether package compilation has run.
- Key abstractions: `findBuildOutputLoads(program, root, host)`, `findUnresolvedWorkspaceImports(program, root, host)`, and the private `BuildOutputClassifier`.
- Data flow: the analysed program → a list of `lib/` files it loaded and the imports that pulled them in → a diagnostic that names the `paths` alias to add.
- Non-obvious design decisions: the classifier works on **real paths** ("because module resolution reports symbolic-link targets and Windows long names while the workspace root may be spelled through a link or an 8.3 short name"), and reported paths are re-spelled under the caller's root so the message is stable. A file counts as a build output only when the nearest ancestor with a `package.json` is a workspace package and the relative path's first segment is `lib` — so a `lib/` inside `node_modules` is external. The unresolved-import finder only reports an import it can *attribute* to a workspace package (it walks up for a `node_modules/<pkg>` link that lands inside the root); without that link it stays quiet, because the comment says "without that link or a `paths` alias the package cannot be identified, and type checking reports the import".
- Edge cases / failure handling: `realpathSync` failures on a not-yet-existing path are swallowed and the resolved spelling is kept, so an unresolved candidate is still classified. The `sourceFor` mapping reconstructs the original `.ts` from `lib/types/**.d.ts` so the error can suggest a source path.
- Surprising: the whole module exists because "an import that reaches `lib/` on a compiled tree resolves to nothing on a clean one, and both are rejected" — a build-order-dependent analysis result is treated as a *bug*, not a nuisance.

### packages/typert/generator/src/cordis-catalog.ts
- Purpose: the Cordis-specific projection over the generic model — the machinery that produces the machine-readable API catalog the model is given, and the generated documentation regions.
- Key abstractions: `CordisCatalogPolicy` (caller-owned type classifications), `CordisCatalogProjector`, `EventEntry`, `ServiceEntry`, `CordisCatalogModel`, `projectCordisCatalog`, `renderPageRegion`, `renderInheritedPage`.
- Data flow: `WorkspaceAnalyzer` → `FaceModel` + `SourceDeclarationModel` → `CordisCatalogProjector.project()` → validated services/events → `renderRuntimeApi` (the `SERVICE_API`/`EVENT_API`/`TYPE_API` arrays the model reads) and `renderPageRegion` (the generated Markdown region).
- Non-obvious design decisions: (a) The **policy is injected, not embedded** — "repository-owned type links, foundation and exemption classifications, and inherited Cordis entries stay in `scripts/gen-cordis-catalog.ts` and are passed in explicitly, so this package contains projection mechanics, not a hidden copy of the repository's documentation taxonomy." (b) **A type-link gate that fails closed**: every type name in a signature must be classified as linked, foundation or exempt, and the violations are *aggregated* into one error (`reportTypeLinkViolations`). (c) **`@mode` is cross-checked against the signature shape**: a trailing `next` parameter with `@mode emit` is an error, and `@mode waterfall` without a `next` is an error. (d) **A key can have two candidates and the class wins** — the doc comment at line 252 states "The CLASS wins — it carries the documentation and is the object a caller meets — and picking before validating is what keeps a discarded candidate's missing JSDoc from failing the gate." (e) The `runtimeDeclarationMaxChars` budget (default 1,500) truncates a long declaration with an explicit `/* …truncated — full shape in source */` marker rather than omitting it. (f) `githubSlug` reimplements GitHub's heading algorithm and emits an explicit `<a id>` before every generated heading so the same fragment resolves on GitHub and on the published site.
- Edge cases / failure handling: JSDoc violations are aggregated (`reportViolations`) rather than failing fast — one run reports every missing `@param` in the whole catalog. Deprecated declarations are silently dropped. A type that appears in two packages is treated as ambiguous and *removed* from the runtime type closure rather than picked arbitrarily.
- Surprising: the page renderer produces **byte-identical** output for the English and Chinese pages (the pairing test asserts it), which is only possible because the renderer takes the *localised* page path as an argument and the content itself is language-neutral.

### packages/typert/generator/src/emitter.ts
- Purpose: the model-driven emitter — turns a `FaceModel` into executable JavaScript and a precise declaration file.
- Key abstractions: `FaceModelEmitter`, `ModelEmitResult`, `RemoteModelEmitResult`, `SchemaEmitter`, `ResultEncoderEmitter`, `invocationSchemas`, `strictCodec`, `containsBytes`.
- Data flow: `FaceModel` → `TypeGraphRenderer` → Zod factories + `TYPERT` manifest (`.js`) and typed declarations (`.d.ts`); the host face with Remote methods additionally emits `typert.remote-client.*`.
- Non-obvious design decisions: (a) **The emitter never sees a TypeScript node** — its header says "It consumes only FaceModel and TypeGraph data; TypeScript compiler nodes are not part of this boundary." (b) **Schemas are cached factories, not values**: `cachedFactory` emits `let X$value\nconst X = () => (X$value ??= …)`, so the Zod schema is built on first use and reused. (c) **`TYPERT` is typed `unknown` in the declaration file** — "Keeping the public declaration unknown prevents every contributing business package from depending on the runtime registry." (d) **Two input policies from one type**: every parameter emits both `codec` and `strictCodec` from the same checker-resolved type, so the strict/loose choice is the *consumer's* at runtime, with no re-generation. (e) **Byte payloads are encoded without copying or freezing**: `ResultEncoderEmitter` walks only the subtrees whose types can contain bytes, and `$resultSnapshot` handles `toJSON` and circular objects with a depth-keyed ancestor map that throws "Remote result contains a circular object". (f) **Tool-schema projection degrades to an error, never to a weaker schema**: `toolProjection` catches `ToolSchemaError` and emits `jsonSchemaError: "<message>"` instead of a lossy schema.
- Edge cases / failure handling: `TypertEmitError` names the construct it cannot represent. `z.freeze` on a union is avoided for byte-bearing members ("Freezing a union may freeze its populated Uint8Array member"). Recursive types are handled with `z.lazy`. Generic declarations become function factories over their type parameters.
- Surprising: the emitted JavaScript imports `zod` **only if** there are schemas, and imports `createTypertRemoteInfo` **only if** there are invocations — the generated file's dependency set is exactly its content's.

### packages/typert/generator/src/index.ts
- Purpose: the generator's public API barrel (17 lines).
- Key abstractions: re-exports `WorkspaceAnalyzer`, `WorkspaceCaches`, `TypertAnalysisError`, `FaceModelEmitter`, `TypertEmitError`, `TypeGraphRenderer`, `TypeGraphRenderError`, `WorkspaceTypertGenerator`, `findWorkspaceRoot`, `writePackageArtifacts`/`writeWorkspaceArtifacts`, and `export * from './cordis-catalog.ts'`.
- Data flow: the workspace build and `scripts/gen-cordis-catalog.ts` import only from here.
- Non-obvious design decisions: the tsdown plugin is deliberately **not** in this barrel — it lives behind the `./tsdown` subpath, "Build wiring lives in the `./tsdown` subpath." The barrel also re-exports `export type * from './model.ts'`, so the model types are part of the public API while the compiler-facing `analyzer.ts` internals are not.
- Edge cases / failure handling: none in-file.
- Surprising: `cordis-catalog.ts` is exported wholesale from the generic generator barrel even though it is Cordis-specific — the Cordis-specificity lives in the injected policy, not in the module boundary.

### packages/typert/generator/src/model.ts
- Purpose: the compiler-independent model — the vocabulary the whole pipeline speaks.
- Key abstractions: `TypeNodeModel` (a 24-variant union of type expressions), `TypeDeclarationModel`, `MemberModel`, `SignatureModel`, `PackageModel`, `FaceModel`, `WorkspaceModel`, `InvocationModel`, `RemoteBoundaryModel`, `TypeGraph`.
- Data flow: analyzer → model → emitter/renderer; nothing in the model mentions TypeScript.
- Non-obvious design decisions: (a) the model **retains source shape rather than resolved shape** — generic parameters keep their pre-evaluation constraint and default, `conditional`/`mapped`/`infer` nodes keep their authored form, and the type target union has a dedicated `cross-face` variant so a face-to-face edge is representable without flattening. (b) `TypeTargetModel` distinguishes `declaration` / `type-parameter` / `cross-face` / `external` / `standard` — the last one is how the standard library is recognised without importing it. (c) `RemoteBoundaryModel` carries **two** type ids: the authored `type` and the `codecType` ("Checker-resolved projection used only to emit the runtime codec"). (d) `childTypeNodeIds` is the single traversal primitive, and it is `assertNever`-exhaustive so an unmodelled node kind fails at build time rather than being silently dropped.
- Edge cases / failure handling: `assertNever` throws `unsupported model variant` for an unknown variant, in both `childTypeNodeIds` and the renderer.
- Surprising: `TypeNodeModel` ends with an `& { readonly json?: true }` intersection rather than a variant — a single flag that marks "canonical lossless JsonValue", which is how the emitter knows to emit `z.json()` without recursing.

### packages/typert/generator/src/renderer.ts
- Purpose: rendering and traversal over the compiler-independent `TypeGraph` — the only way emitters are allowed to see types.
- Key abstractions: `TypeGraphRenderer` (index + render), `TypeGraphRenderError`, and the public `renderType` / `renderMember` / `renderDeclaration` / `declarationClosureForMembers` / `declarationClosureForTypes`.
- Data flow: `TypeGraph` → TypeScript type text (for the generated `.d.ts`) and declaration closures (for the runtime type list).
- Non-obvious design decisions: (a) **Rendering is from retained source structure, not from the compiler** — the renderer walks the model's own `kind` switch, so a generated declaration reads like the authored one. (b) `renderMember(member, sourceModifiers = true)` returns the *retained source text* when `sourceModifiers` is set (which is what the runtime reflection uses) and a *re-rendered* form otherwise (which is what the declaration file uses) — one member, two projections, chosen by a flag. (c) The closure walk tracks a `visiting` set to survive cycles, and `found` is a `Set` so a declaration is emitted once even when reached twice.
- Edge cases / failure handling: every broken edge throws a `TypeGraphRenderError` naming the missing node/declaration/member id; a mapped type with no constraint is an explicit error rather than a guess; an alias with no type node is an error.
- Surprising: `renderDeclaration` reconstructs an `export enum` with its original member initialisers — the enum's *developer-authored* value is preserved in the generated declaration, not the computed one.

### packages/typert/generator/src/tool-schema.ts
- Purpose: projection of a resolved type into the tool-schema subset the harness enforces on tool parameters, tool output and the generated PTC SDK.
- Key abstractions: `projectToolSchema(renderer, type, closedObjects, optional)`, `ToolSchemaError`.
- Data flow: `TypeGraph` → JSON-Schema-shaped object, or a `ToolSchemaError` naming the construct.
- Non-obvious design decisions: (a) the contract is **all-or-nothing**: "A type the subset cannot express without weakening constraints raises `ToolSchemaError`, which callers report as an absent projection rather than a narrower schema" — a partially-weak schema is treated as a bug. (b) `closedObjects` controls whether declared request objects become `additionalProperties: false`; a string-indexed dictionary keeps `additionalProperties: true` and its index value is required to be unconstrained JSON. (c) **Union branches must be provably disjoint**: `disjoint()` requires either different primitive types or two object branches with a required field whose literal values do not overlap, and "selected union branches overlap or have no required discriminator" is a hard failure. (d) A recursive selected type fails loudly ("recursive selected type requires a supported JSON value declaration") rather than emitting a `$ref` the subset forbids.
- Edge cases / failure handling: `bigint` is rejected as non-JSON; a symbol-keyed member is skipped; a dynamic computed member fails.
- Surprising: the `optional` flag exists to *omit* the top-level `undefined` alternative of a union — the same type is projected differently for an optional argument than for a required one, so the JSON Schema never advertises `undefined`.

### packages/typert/generator/src/tsdown-plugin.ts
- Purpose: the bundler plugin face — lowers decorators and emits the artifacts during a tsdown/rolldown build.
- Key abstractions: `typertPlugin(options)` with `mode: 'package' | 'workspace'` and `faces`; `TypertPluginOptions`; `TypertWorkerError`; the internal `GenerationOutcome` union.
- Data flow: `buildStart` → (workspace mode) start a Worker Thread; `transform` → lower decorators; `writeBundle` → await the worker and write artifacts.
- Non-obvious design decisions: (a) The plugin is declared **structurally** — "The subset of the rolldown plugin contract used here (structural; avoids a rolldown type dependency)" — so the package does not take a bundler dependency. (b) **Decorator lowering is gated by a cheap regex pre-filter** (`DECORATOR_SYNTAX`) and the module-id filter is evaluated natively by rolldown, so non-TypeScript modules never cross into the JavaScript hook. (c) The worker is spawned with a `data:` URL bootstrap that registers `tsx/esm/api` when running from source, and a real `./worker.js` when built — one code path, two hosts. (d) **The worker outcome never rejects**: failures are *values*, so an unclaimed generation can never produce an unhandled rejection. (e) `TSC_OWNED_DIAGNOSTICS = { checkDiagnostics: false }` — the plugin explicitly does not repeat the TypeScript diagnostics a full build already owns.
- Edge cases / failure handling: `generateInWorker` distinguishes a malformed response, a reported failure, a crash, an early exit, a deserialization failure and a termination failure, each with its own `TypertWorkerError` message; the worker is terminated before the outcome settles on every path.
- Surprising: in workspace mode the **first** `writeBundle` claims emission and the later ones return immediately — the artifacts are written once for the whole workspace, not once per package, and `emittedWorkspaces` is the claim token.

### packages/typert/generator/src/worker.ts
- Purpose: the Worker Thread entry for workspace-mode generation.
- Key abstractions: `WorkspaceWorkerRequest`, `WorkspaceWorkerResponse` (exactly one of `artifacts` / `failure`), and `parseRequest`.
- Data flow: `workerData` → `WorkspaceTypertGenerator.generateContributors(faces)` → one `postMessage` → exit.
- Non-obvious design decisions: the request is **parsed and validated by hand** (`parseRequest`) rather than trusted, because `workerData` crosses a trust boundary; the response is a discriminated union with an optional stack, so the parent can reconstruct the error's name, message and stack.
- Edge cases / failure handling: a non-`Error` throw is normalised to `{ name: 'Error', message: String(error) }` so the parent always receives a well-formed failure. The module refuses to run outside a Worker Thread (`parentPort === null` throws).
- Surprising: the worker posts **exactly one** message and then the process exits — there is no keep-alive protocol, no progress reporting, and no partial-result channel.

### packages/typert/generator/src/workspace.ts
- Purpose: the workspace-level driver — discovery, analysis, emission, and the publication contract.
- Key abstractions: `WorkspaceTypertGenerator` (`discover`, `generate`, `generateContributors`), `WorkspaceTypertGeneratorOptions`, `WorkspaceEmitResult`, `findWorkspaceRoot`, `hasTypertExport`.
- Data flow: discover → analyze → emit → **validate the manifest** → return artifacts.
- Non-obvious design decisions: (a) `validateExport` is the **publication contract**: the package's `package.json` must export `./typert` (or `./client/typert`) as exactly `{types: './lib/typert.<face>.d.ts', default: './lib/typert.<face>.js'}` and list both files in `files` — otherwise the build fails. (b) The inverse is also checked: a Host artifact with **no** Remote methods must not publish `./remote`, or the file list "publishes Remote artifacts but has no Remote methods". (c) `findWorkspaceRoot` requires **both** `tsconfig.host.json` and `packages/` so "a package's own `tsconfig.host.json` face leaf does not qualify". (d) The generator analyses *all* contributors before filtering the emitted set, so a subset build has the same declaration merges and the same bytes as a full build.
- Edge cases / failure handling: `TypertAnalysisError` names the package, the face and the exact expected export object. `hasTypertExport` accepts the three opt-in subpaths and rejects wildcard patterns.
- Surprising: the `./remote` declaration map is emitted beside the two published files but "never published: it serves editor navigation in the workspace, where the package link resolves its source" — a build artifact deliberately kept out of the npm tarball.

### packages/typert/generator/tests/__snapshots__/type-model.spec.ts.snap
- Purpose: a Vitest snapshot (229 KB, 6,492 lines) of the emitter's generated JavaScript for the `FaceModelEmitter` case.
- Key abstractions: one snapshot entry, `FaceModelEmitter > emits runnable Zod JavaScript, precise declarations, and runtime package metadata 1`.
- Data flow: the emitter's `renderJs` output is compared byte-for-byte against this file.
- Non-obvious design decisions: the snapshot pins the *generated bytes*, including the `let Payload$schema$value / const Payload$schema = () => (Payload$schema$value ??= …)` caching pattern — a change to the emitter's code shape is a snapshot diff, which is exactly the point.
- Edge cases / failure handling: none in-file; Vitest owns the diff.
- Surprising: **not read line by line** — 6,492 lines of generated JavaScript. I opened the header and the first entry to confirm what it is (a Vitest snapshot of the emitter output, not hand-written code) and it is recorded as `skipped` in the ledger for that reason.

### packages/typert/generator/tests/.generated-model-O7FJNT/host.mjs
- Purpose: a **generated** artifact left behind by an earlier test run — a host-face `typert.host.js` for the `@fixture/host` fixture package.
- Key abstractions: none; it is emitter output, not a source.
- Data flow: nothing consumes it; it is debris in the tree.
- Non-obvious design decisions: the visible shape is `schema: Payload` in the `schemas` array, while the current emitter emits `create: Payload` — so this file predates the emitter's `create()` factory change and is **stale**.
- Edge cases / failure handling: none.
- Surprising: the directory name (`.generated-model-O7FJNT`) is a random-suffix scratch directory that was committed. It is exactly the kind of leftover a scratch-file rule would delete; the workspace `AGENTS.md` says "The repo carries no `_*.py` / `*.txt` scratch artifacts on purpose" — and yet this is a scratch artifact. **Not read line by line** (310 lines of generated JavaScript); I opened the first 40 lines to identify it.

### packages/typert/generator/tests/.generated-model-qwn8sk/host.mjs
- Purpose: a second copy of the same generated host-face artifact, from another test run.
- Key abstractions: none; emitter output.
- Data flow: unused debris.
- Non-obvious design decisions: it is byte-identical to the `O7FJNT` copy in its opening lines — the random suffix is the only difference.
- Edge cases / failure handling: none.
- Surprising: two stale copies of the same generated file sit in the tree, and the emitter's schema entry shape (`schema:` vs `create:`) shows both predate the current emitter. **Not read line by line** (310 lines of generated JavaScript); I opened the first 15 lines to confirm it is the same generated artifact.

### packages/typert/generator/tests/cordis-catalog-contract.spec.ts
- Purpose: the model-extraction and negative-path contract suite for the catalog generator.
- Key abstractions: `TEST_POLICY` (a tiny `CordisCatalogPolicy`), `writeProject(root, source)` which materialises a compilable package plus a host aggregate, and `fixtureRoot` / `serviceFixtureRoot` wrappers.
- Data flow: a temp-dir package → `collectEvents` / `collectServices` → assertions on the extracted model or the thrown violation text.
- Non-obvious design decisions: the whole file's negative-path contract is expressed as *exact error-message* assertions ("is missing @param id", "has no JSDoc", "is missing an explicit type annotation", "references unclassified type 'MissingServiceType'"), which pins the diagnostic text as part of the contract.
- Edge cases / failure handling: **both `describe` blocks are `describe.skip`** (lines 127 and 242) — the entire suite is currently disabled. The scenarios it covers (mode/signature contradictions, stale `@param`, binding-pattern parameters, aggregation of multiple violations) are therefore *documented but not enforced*.
- Surprising: the skip is the single most important fact about this file. A reader who only greps the `it(...)` titles would conclude the catalogue's JSDoc gate is covered; it is not. The `describe.skip` is a fact I verified by reading the file, and I flag it in Uncertainties.

### packages/typert/generator/tests/cordis-catalog.spec.ts
- Purpose: the byte-for-byte reproduction test for every committed catalog artifact.
- Key abstractions: a cached `projection()` (analyzing the workspace twice "doubles a multi-minute run"), `clientProjection()`, and `SOURCE_LINK_POLICY`.
- Data flow: `projectCordisCatalog(workspaceRoot, CORDIS_CATALOG_POLICY)` → `renderPageRegion` → compared to the committed `docs/subsystems/*.md` region between the markers.
- Non-obvious design decisions: the test compares the **rendered region** against the committed file *for both language sides*, so the English and Chinese pages are proved to carry identical content; and it compares `renderRuntimeApi(model)` against the committed `packages/extensions/tool-cordis/src/api-catalog.ts` — the file the model actually reads at runtime. The source-link policy is checked separately: subsystem links drop the `:line` suffix while the inherited (vendored) links keep it.
- Edge cases / failure handling: the model-facing catalog is asserted to include framework enums (`FiberState`) that live outside the business packages, and the `slots` service's referenced types are asserted to stay *inside* the display budget (no `truncated` marker).
- Surprising: the test asserts that `ctx.typert` resolves to `TypertRegistry` (the class) and not to the merge-extensible interface, and that optional Context keys (`headlessIo`, `dshHomePath`, `launcherEnvironment`) are **absent** from the catalog — the same rule the analyzer enforces, re-asserted from the consumer side.

### packages/typert/generator/tests/fixtures/remote-model/package.json
- Purpose: the root manifest of the `remote-model` fixture workspace.
- Key abstractions: `@fixture/remote-workspace`, private, ESM.
- Data flow: it is the workspace root the analyzer is pointed at.
- Non-obvious design decisions: the fixture root deliberately has **no `exports`** and no dependencies — the workspace is described entirely by its `tsconfig` `paths` aliases, so the analyzer resolves the fixture packages by path, not by node_modules.
- Edge cases / failure handling: none in-file.
- Surprising: a 5-line manifest is the anchor for a 12-file fixture workspace; the type graph comes from the tsconfig, not from npm resolution.

### packages/typert/generator/tests/fixtures/remote-model/packages/domain/package.json
- Purpose: the manifest of the fixture's *domain* package — the Host-only object that a Remote method takes as a lookup.
- Key abstractions: `@fixture/domain` with two exports: `.` and `./types`.
- Data flow: `GoalService.create(agent: Agent, …)` resolves `Agent` through this package's public export; the analyzer turns it into a `TypertLookup` boundary.
- Non-obvious design decisions: the exports point at **source** (`./src/index.ts`) rather than at `lib/` — the fixture is analyzed without being built, which is exactly the "reads workspace packages only from source" property the build-output guard enforces.
- Edge cases / failure handling: none in-file.
- Surprising: this package is the *only* place the fixture declares `TypertLookupMap`/`TypertContextMap` merges — the protocol's merge-extensible maps are exercised by a fixture package, not by the protocol itself.

### packages/typert/generator/tests/fixtures/remote-model/packages/domain/src/index.ts
- Purpose: the Host-only `Agent` class plus the `TypertLookupMap` / `TypertContextMap` declaration merges.
- Key abstractions: `class Agent { constructor(readonly id: AgentId) }`; `declare module '@deepseek-ai/dsh-typert-protocol' { interface TypertLookupMap { agent: TypertLookup<Agent, AgentId> } interface TypertContextMap { agent: TypertContext<AgentId> } }`.
- Data flow: the analyzer reads the merges to learn that a parameter typed `Agent` is a *lookup*, not JSON — which is why `GoalService.create`'s first parameter crosses the wire as `agentId`.
- Non-obvious design decisions: the *same key* `agent` is declared in **both** maps, which is the precondition for the "direct scoped projection" case — a lookup parameter whose lookup key also names a Context kind, so the method is scoped rather than merely parameterised.
- Edge cases / failure handling: none in-file.
- Surprising: `Agent` is a **class instance**, and the fixture proves the analyzer refuses to treat it as JSON: the analyzer's `assertRemoteJsonType` fails on "class instance" and `isWorkspaceClass` demands a `TypertLookupMap` entry for it.

### packages/typert/generator/tests/fixtures/remote-model/packages/domain/src/types.ts
- Purpose: the wire identity type for the domain package.
- Key abstractions: `export type AgentId = string`.
- Data flow: `AgentId` is the wire representation of the `Agent` lookup and of the `agent` Context.
- Non-obvious design decisions: the wire identity is a **plain string alias**, not a branded type — the fixture proves the generator does not require branding.
- Edge cases / failure handling: none in-file.
- Surprising: 2 lines that carry the entire lookup/context wiring of the fixture.

### packages/typert/generator/tests/fixtures/remote-model/packages/domain/tsconfig.json
- Purpose: the domain package's project config.
- Key abstractions: extends the fixture base; `rootDir: src`, `outDir: lib/types`.
- Data flow: it is the project the host aggregate references.
- Non-obvious design decisions: unlike the type-model fixture, this one sets `noEmit: false`, `declaration: true`, `emitDeclarationOnly: true` — so this fixture **does** produce `lib/types/**.d.ts`, which is what lets the analyzer's `sourcePathForExport` map an export target back to its source and lets the build-output guard have something to detect.
- Edge cases / failure handling: `composite: true` (inherited) is what makes it usable as a project reference.
- Surprising: this fixture deliberately emits declarations, and the type-model fixture deliberately does not — the two fixtures cover both sides of the "is this a build output?" question.

### packages/typert/generator/tests/fixtures/remote-model/packages/remote/package.json
- Purpose: the manifest of the fixture's *remote* package — the one that publishes Typert artifacts.
- Key abstractions: exports `.`, `./types`, `./typert` and `./remote`; `files` lists the four artifact names.
- Data flow: `./typert` and `./remote` are the opt-in subpaths the generator's `hasTypertExport` looks for and `validateExport` checks exactly.
- Non-obvious design decisions: the manifest is written as a *correct* publication contract — the exact `{types, default}` shape `validateExport` demands — so the fixture exercises the happy path; a sibling test mutates it to the wrong shape to exercise the failure path.
- Edge cases / failure handling: the `files` array names `lib/typert.host.js`, `lib/typert.host.d.ts`, `lib/typert.remote-client.js`, `lib/typert.remote-client.d.ts` — the four files `writePackageArtifacts` can produce.
- Surprising: `.` and `./types` point at **source** while `./typert` and `./remote` point at **build output** — the same package is deliberately half-source, half-output, which is exactly the shape the real workspace has.

### packages/typert/generator/tests/fixtures/remote-model/packages/remote/src/index.ts
- Purpose: the fixture's Remote service — the canonical shape of a `@Remote` / `@RemoteScope` / stream method.
- Key abstractions: `class GoalService extends TypertRemoteService` with `create` (unary + `signal: AbortSignal`), `rename` (a `@RemoteScope('agent')` method), and `watch` (a `@Remote({ mode: 'stream' })` async generator).
- Data flow: the analyzer reads the decorators and the Gateway binding (`super(undefined, 'goals')`), and produces three invocation descriptors plus a client-side `./remote` artifact.
- Non-obvious design decisions: the service is described as "Remote-only business Service with no Cordis declaration merge" — it is *not* in the `interface Context` merge, so its only binding is the Gateway one. The `signal: AbortSignal` parameter is **last** and is the cancellation channel, not a JSON argument. The `rename` method takes no `agent` parameter at all — the scoped receiver supplies the identity.
- Edge cases / failure handling: `super(undefined, 'goals')` passes an `undefined` Context, which is legal for the fixture and exercises the "Gateway binding without a live Context" path.
- Surprising: the fixture's `create` takes the *Host object* `Agent` as its first parameter, and the generated wire field becomes `agentId` — the lookup substitution is visible in the fixture itself.

### packages/typert/generator/tests/fixtures/remote-model/packages/remote/src/types.ts
- Purpose: the four request/result interfaces the fixture's Remote methods use.
- Key abstractions: `CreateGoalRequest`, `CreateGoalResult`, `RenameGoalRequest`, `RenameGoalResult` — all plain `readonly` object types.
- Data flow: each becomes a boundary; the results become the client-side return types.
- Non-obvious design decisions: every field is `readonly`, and every interface carries a one-line JSDoc — the fixture doubles as a documentation example, because a missing `@param` in the *method* JSDoc is a build error elsewhere in the repo.
- Edge cases / failure handling: none in-file.
- Surprising: `RenameGoalResult.renamed` is a `boolean` rather than a string, so the result type is not accidentally identical to the request type — the fixture can distinguish "the request round-tripped" from "the method computed something".

### packages/typert/generator/tests/fixtures/remote-model/packages/remote/tsconfig.json
- Purpose: the remote package's project config.
- Key abstractions: extends the fixture base; `rootDir: src`, `outDir: lib/types`; references `../domain`.
- Data flow: the project reference is what makes the analyzer see a **cross-package** type reference (`Agent` from `@fixture/domain`) and check it against that package's public exports.
- Non-obvious design decisions: `noEmit: false` + `declaration: true` + `emitDeclarationOnly: true` (as in the domain package) so the fixture has real `lib/types` output to be checked against.
- Edge cases / failure handling: `composite: true` (inherited) is required for a project reference.
- Surprising: the reference direction (`remote` → `domain`) matches the real dependency direction; the analyzer treats a reference the other way round as a cross-face error.

### packages/typert/generator/tests/fixtures/remote-model/tsconfig.base.json
- Purpose: the shared compiler options for the remote-model fixture workspace.
- Key abstractions: `paths` mapping `@deepseek-ai/dsh-typert-protocol` → `./typert-protocol.d.ts` and the two fixture packages → their sources.
- Data flow: these aliases are how the fixture resolves the *real* protocol package without building it.
- Non-obvious design decisions: the protocol is aliased to a **hand-written declaration stub** in the fixture, not to the real package — so the fixture is hermetic and the analyzer's "is this symbol owned by `@deepseek-ai/dsh-typert-protocol`?" test has a stable answer.
- Edge cases / failure handling: `skipLibCheck: true` and `strict: true`; `composite: true` with `noEmit: true` (overridden per package where output is needed).
- Surprising: `allowImportingTsExtensions` is on, so the fixture's source imports `./types.ts` with the extension — the same style the real workspace uses.

### packages/typert/generator/tests/fixtures/remote-model/tsconfig.host.json
- Purpose: the host aggregate of the remote-model fixture workspace.
- Key abstractions: `files: []` plus two `references` (`./packages/domain`, `./packages/remote`).
- Data flow: the analyzer reads this aggregate to learn which packages are in the host face.
- Non-obvious design decisions: `files: []` with only `references` is the pattern the analyzer relies on — "An aggregate that declares `references` is parsed without expanding its `include` patterns, which affect neither its options nor its references."
- Edge cases / failure handling: the analyzer treats an aggregate with neither `references` nor inputs as an error ("reports an aggregate without references or inputs").
- Surprising: this 8-line file is the entire face definition for the fixture.

### packages/typert/generator/tests/fixtures/remote-model/typert-protocol.d.ts
- Purpose: a hand-written declaration stub of the real `@deepseek-ai/dsh-typert-protocol` surface, used by the fixture.
- Key abstractions: `TypertLookup`, `TypertContext`, the four merge-extensible maps, `InvocationDescriptor`, `TypertRemoteMethod`, `RemoteResult`, `RemoteDecoded`, `RemoteStreamHandle`, `TypertRemoteService`, `bindTypertRemote`, `Remote`, `RemoteScope`.
- Data flow: the analyzer resolves the fixture's `Remote` / `RemoteScope` / `bindTypertRemote` references to *this* declaration, which is how it recognises them as protocol symbols.
- Non-obvious design decisions: the stub is deliberately a *narrowed* copy of the real module (it drops `TYPERT_OWNED_VALUE`, the registry interfaces and the `RemoteError` class) — enough for the analyzer to identify the symbols, small enough to read.
- Edge cases / failure handling: none in-file; the stub is a fixture, not a contract.
- Surprising: `RemoteStream<Out, In>` is declared here with a `uplinkItem?: In` marker instead of the real `STREAM_UPLINK` symbol — the fixture proves the analyzer recognises the *name* plus the owning package, not a unique symbol.

### packages/typert/generator/tests/fixtures/type-model/cordis.d.ts
- Purpose: a 7-line stub of the Cordis module for the type-model fixture.
- Key abstractions: `export class Service`, `export interface Context {}`, `export interface Events {}`.
- Data flow: the fixture's `declare module '@deepseek-ai/cordis'` blocks merge into these.
- Non-obvious design decisions: the stub is deliberately *empty* for Context and Events, so every service/event the fixture declares is a **merge into an empty base** — the minimal shape the analyzer's augmentation walk needs.
- Edge cases / failure handling: none in-file.
- Surprising: the real Cordis `Service` has a protected `__service` marker; the stub reproduces it, which matters because the analyzer resolves a Context member's *type* and then needs it to be a class or interface.

### packages/typert/generator/tests/fixtures/type-model/package.json
- Purpose: the root manifest of the type-model fixture workspace.
- Key abstractions: `@fixture/workspace`, private, ESM.
- Data flow: it is the workspace root.
- Non-obvious design decisions: no `exports` and no dependencies — resolution is entirely through `tsconfig.base.json`'s `paths`.
- Edge cases / failure handling: none in-file.
- Surprising: 5 lines that anchor a 19-file fixture.

### packages/typert/generator/tests/fixtures/type-model/packages/client/package.json
- Purpose: the manifest of the fixture's *client* package — the second face.
- Key abstractions: exports `.` and `./client/typert`; `files` lists the two client artifacts.
- Data flow: the `./client/typert` subpath is what makes the package a **dual-face** package — the analyzer registers it once for host and once for client.
- Non-obvious design decisions: the client package's `exports` contain **only** `./client/...` rows plus `.`, and the analyzer's `clientExportSubpaths` filter is exactly "subpath === './client' or starts with './client/'" — the manifest is written to match the filter precisely.
- Edge cases / failure handling: none in-file.
- Surprising: the client package does **not** reference the host package in its manifest; the cross-face edge is created by the *source* imports plus the `dsh.client` metadata, and the analyzer rejects any other way of making it.

### packages/typert/generator/tests/fixtures/type-model/packages/client/src/index.ts
- Purpose: the fixture's client-face source — every way a Client can reference a Host type.
- Key abstractions: `ClientAgent extends HostAgent<{ready: true}>`, `ClientView` (with an `import('@fixture/host')` type, a namespace import, a default import, and a re-exported alias), and `class ClientBridge extends Service`.
- Data flow: the analyzer walks these references to build the `cross-face` type graph and the `CrossFaceLink` list.
- Non-obvious design decisions: the fixture covers the **four** cross-face reference forms in one file — a named import, a namespace import (`Host.Agent`), a default import (`HostDefault`), and an `import('@fixture/host')` type — plus a re-export alias. It also declares `export type { Box as ReexportedBox } from '@fixture/host'` and `export type { ZodType as ReexportedZodType } from 'zod'`, so an *external* re-export and a *workspace* re-export sit side by side.
- Edge cases / failure handling: none in-file.
- Surprising: `ClientAgent` inherits a *generic* Host type — the cross-face edge preserves the type argument, which is the case a naive "cross-face = external" model would lose.

### packages/typert/generator/tests/fixtures/type-model/packages/client/tsconfig.json
- Purpose: the client package's project config.
- Key abstractions: extends the fixture base; `rootDir: src`, `outDir: lib/types`; references `../host`.
- Data flow: the reference is what puts the client package in the client face while the host package stays in the host face.
- Non-obvious design decisions: it declares `outDir: lib/types` even though the client fixture is analyzed from source — the directory only matters for `sourcePathForExport`'s `lib/types/` mapping.
- Edge cases / failure handling: `composite: true` (inherited) is required for the reference.
- Surprising: the client package references the host package, so both are in the *same* program graph; the face separation comes from the aggregate that references them, not from the reference graph.

### packages/typert/generator/tests/fixtures/type-model/packages/host/package.json
- Purpose: the manifest of the fixture's *host* package.
- Key abstractions: exports `.`, `./models` and `./typert`; `files` lists the two host artifacts.
- Data flow: `./models` is a **non-root** public subpath, which is what lets a Remote boundary type be exported from a subpath rather than the package root.
- Non-obvious design decisions: the package publishes three distinct subpaths so the analyzer's `publicRemoteType` has a choice to make — the analyzer's rule is that a boundary type must be exported "from a public **non-root** type subpath", and the fixture has one.
- Edge cases / failure handling: none in-file.
- Surprising: `"./models"` points at `lib/types/models.d.ts` while `"."` points at `lib/types/index.d.ts` — the same package exposes two declaration surfaces, and the generator must import a *type* from the right one.

### packages/typert/generator/tests/fixtures/type-model/packages/host/src/index.ts
- Purpose: the fixture's host surface — a `@typert object` class, three differently-exported services, a Cordis `Context`/`Events` merge, and a service whose methods exercise the whole type zoo.
- Key abstractions: `class Agent` (with `@typert object`, a static, a protected and a private member, a getter/setter pair, a generic method and a `#private` method), `AliasedService` (exported only under an alias), `DefaultOnlyService` (exported only as the default), `DemoService` (the real API surface), and the `interface Context` / `interface Events` merges.
- Data flow: the analyzer reads the merges to find services and events, the `@typert` tag to pick the object/schema modes, and the exports to build the export map.
- Non-obvious design decisions: the fixture deliberately includes **negative cases** in the Context merge — `ignoredInline: {}`, `ignoredPrimitive: string`, `ignoredExternal: ZodType<string>`, `ignoredMethod(): void` — none of which is a service, plus a second `declare module '@deepseek-ai/cordis'` block that re-declares `demo` and `demo/ready` (a duplicate merge, which must be deduplicated, not duplicated). The Events merge includes a *property-style* event (`'demo/property': (payload: Payload) => void`), a mode-less event, and an anonymous call signature.
- Edge cases / failure handling: the fixture encodes the analyzer's refusals as positive data — a `private`/`protected`/`static` member that must not appear, a private `#` method, a generic service method, a binding-pattern parameter (`destructure({ name }: Payload, [suffix]: [string])`).
- Surprising: `export default DefaultOnlyService` at the bottom — the fixture proves a service reachable **only** through the package default export is still discovered.

### packages/typert/generator/tests/fixtures/type-model/packages/host/src/models.ts
- Purpose: the fixture's type zoo — one declaration per retained type-graph shape.
- Key abstractions: `Box<T>`, `Present<T>` (conditional), `Flags<T>` (mapped), `Entity`, `AgentPhase` (enum), `Payload` (`@typert schema`), `Callable`, `Variance`, `Result<Value>` (infer), `StringResult<Value>` (constrained infer), `Topic`/`Route` (template literals), `PlainMap`/`Remapped`/`Added` (mapped modifiers), `phaseOrder`/`genericFactory` (type queries), `Guards` (predicates + `this`), `AbstractEntity`, `Recursive`, `TagOnly` (deprecated), `Unpunctuated`, and the `SyntaxZoo` interface that reaches every one of them.
- Data flow: `SyntaxZoo` is the single public boundary through which the analyzer can reach every supported node kind; `Payload` is the `@typert schema` root.
- Non-obvious design decisions: each declaration exists to pin **one** retention property — `Present` keeps the conditional instead of its resolved instantiations; `Flags` keeps the mapped form instead of materialised properties; `Remapped` keeps key remapping *and* explicit modifier removal; `Added` keeps explicit modifier addition. `Recursive` proves a declaration edge survives as a declaration target rather than being inlined.
- Edge cases / failure handling: `TagOnly` carries only `@deprecated` and must be dropped; `Unpunctuated` has a description with no terminal punctuation (the `firstSentence` helper must handle it).
- Surprising: `SyntaxZoo` contains a `readonly uniqueToken: unique symbol` and a `['computed']: symbol` member — the two shapes the model must **erase** rather than project.

### packages/typert/generator/tests/fixtures/type-model/packages/host/tsconfig.json
- Purpose: the host package's project config.
- Key abstractions: extends the fixture base; `rootDir: src`, `outDir: lib/types`; `include: ["src"]`.
- Data flow: the analyzer expands this config to find the host package's root files.
- Non-obvious design decisions: `include: ["src"]` means the config *is* expanded (unlike the aggregate) — the analyzer's `parseConfig` only skips expansion for aggregates with `references`.
- Edge cases / failure handling: `composite: true` (inherited) plus `noEmit: true` (inherited) means this project never produces output, which is what makes it a *source* project.
- Surprising: the host package produces no `lib/` at all in this fixture, so the build-output guard has nothing to flag — the clean-tree case.

### packages/typert/generator/tests/fixtures/type-model/packages/write/package.json
- Purpose: the manifest of the fixture's *write-mode* package.
- Key abstractions: exports `.` only; no `files`, no Typert subpath.
- Data flow: the package is analyzed in `write` mode, where the analyzer *edits* its source.
- Non-obvious design decisions: the package deliberately does **not** opt into Typert publication, so it exercises the "contributor without an artifact" path.
- Edge cases / failure handling: none in-file.
- Surprising: the manifest has no `files` array at all, so `validateExport` would reject it if it were ever selected for publication — the fixture keeps it out of the contributor set.

### packages/typert/generator/tests/fixtures/type-model/packages/write/src/index.ts
- Purpose: the fixture's write-mode source — a service whose public members have **no type annotations**.
- Key abstractions: `class WritableService extends Service { value = 1; echo(input = 'value') { return input } }` and the `interface Context { writable: WritableService }` merge.
- Data flow: in `check` mode the analyzer fails on the missing annotations; in `write` mode it prints the inferred types, edits the file and re-analyzes.
- Non-obvious design decisions: the fixture provides exactly the two annotation shapes the writer must place — a property (`value = 1`) and a parameter with a default (`echo(input = 'value')`) — because `annotationPosition` computes a different insertion point for each (`name.end` vs `parameters.end + 1`).
- Edge cases / failure handling: in `check` mode the error is "public property/parameter/return is missing an explicit type annotation"; in `write` mode the analyzer throws `SourceEditQueued` to abort the current pass, applies the edit, invalidates the cached parse and restarts.
- Surprising: the default value `'value'` is the inferred type of the parameter, so the written annotation is `input: string` — the writer has to distinguish an *inferred* type from an *authored* one.

### packages/typert/generator/tests/fixtures/type-model/packages/write/tsconfig.json
- Purpose: the write package's project config.
- Key abstractions: extends the fixture base; `rootDir: src`, `outDir: lib/types`; `include: ["src"]`.
- Data flow: it is the project the `tsconfig.write.json` aggregate references.
- Non-obvious design decisions: identical in shape to the host package's config, so the write-mode test differs only in the aggregate that selects it.
- Edge cases / failure handling: none in-file.
- Surprising: the fixture's three packages share one base config, so the *only* thing that distinguishes host from client from write is which aggregate references them.

### packages/typert/generator/tests/fixtures/type-model/tsconfig.base.json
- Purpose: the shared compiler options for the type-model fixture workspace.
- Key abstractions: `paths` mapping `@deepseek-ai/cordis` → `./cordis.d.ts` and the three fixture packages → their sources.
- Data flow: these aliases are how the fixture resolves the real Cordis and the fixture packages without building.
- Non-obvious design decisions: `baseUrl: "."` plus explicit `paths` is what makes the analyzer's `sourcePathForExport` able to reverse an export target back to a source file.
- Edge cases / failure handling: `skipLibCheck: true`, `strict: true`, `composite: true`, `noEmit: true` — no project in this fixture ever emits, which is the point.
- Surprising: `paths` maps `@fixture/host/*` as well as `@fixture/host`, so a subpath import is resolvable — the fixture covers the subpath case without a second package.

### packages/typert/generator/tests/fixtures/type-model/tsconfig.client.json
- Purpose: the client aggregate of the type-model fixture workspace.
- Key abstractions: `files: []` plus one reference to `./packages/client`.
- Data flow: the analyzer reads it to determine the client face's membership.
- Non-obvious design decisions: the client aggregate references **only** the client package, even though the client package itself references the host package — face membership is decided by the aggregate, not by the reference graph.
- Edge cases / failure handling: none in-file.
- Surprising: a 7-line file whose only content is "which project belongs to which face".

### packages/typert/generator/tests/fixtures/type-model/tsconfig.host.json
- Purpose: the host aggregate of the type-model fixture workspace.
- Key abstractions: `files: []` plus one reference to `./packages/host`.
- Data flow: the analyzer reads it to determine the host face's membership.
- Non-obvious design decisions: the same shape as the client aggregate — the fixture proves the two faces are independent programs, not one program with two views.
- Edge cases / failure handling: none in-file.
- Surprising: it references only the host package, so the *client* package's cross-face references to the host are resolved through a **program reference**, not through the aggregate.

### packages/typert/generator/tests/fixtures/type-model/tsconfig.json
- Purpose: the root config of the type-model fixture workspace.
- Key abstractions: extends the base; `files: ["cordis.d.ts"]`.
- Data flow: it is the config that gives the fixture's `cordis.d.ts` a home.
- Non-obvious design decisions: it has **no `references`** — so the analyzer's `parseConfig` *does* expand it, and it is not one of the face aggregates.
- Edge cases / failure handling: none in-file.
- Surprising: 4 lines whose only job is to place one file.

### packages/typert/generator/tests/fixtures/type-model/tsconfig.write.json
- Purpose: the write-mode aggregate of the type-model fixture workspace.
- Key abstractions: `files: []` plus one reference to `./packages/write`.
- Data flow: the write-mode test points the analyzer at this aggregate.
- Non-obvious design decisions: it is a **third** aggregate, so the analyzer's `hostConfig`/`clientConfig` options can be pointed at a different pair for the write-mode pass.
- Edge cases / failure handling: none in-file.
- Surprising: the fixture ships three aggregates to prove the analyzer's face selection is configuration, not convention.

### packages/typert/generator/tests/remote-metadata.spec.ts
- Purpose: the Remote *metadata* suite — 970 lines covering the emitted descriptors, input policies, documentation and tool-schema projections.
- Key abstractions: `RuntimeValue` / `RuntimeDescriptor` / `RuntimeMethod` (the shape the generated artifact is read back as), `executableRemoteModule` (evaluating the generated JavaScript), and `assertConsumerTypechecks` (writing the generated `.d.ts` and type-checking a consumer against it).
- Data flow: fixture copy → `WorkspaceTypertGenerator` → generated `.js`/`.d.ts` → evaluated as a module → descriptors and parsers asserted; the `.d.ts` is type-checked against a synthetic consumer.
- Non-obvious design decisions: the suite **type-checks the generated declarations** ("typechecks ordinary declarations for named invocation, Context exclusion, uplink, and decoded bytes") — the `.d.ts` is not merely snapshot-compared, it is compiled against a consumer program with `skipLibCheck: false`. It also asserts every emitted schema against the *harness's own* tool-schema validator (`assertSupportedJsonSchema` from `@deepseek-ai/dsh-tools`), so the generator's tool projection is checked by the same code that will enforce it at runtime.
- Edge cases / failure handling: covered are unsupported JSON Schema projections (parsers and docs are kept, the projection is omitted), recursive input parsers, optional named arguments, parameterless methods, overlapping-union inputs, canonical `JsonValue`, JSON dictionaries, tuple inputs, and a nominal brand that must not be treated as an object.
- Surprising: "keeps selected and full-face artifacts identical when another package augments inputs and results" — generating for a *subset* of packages must produce byte-identical artifacts to generating for everything, and the test proves it.

### packages/typert/generator/tests/remote-model.spec.ts
- Purpose: the Remote *model* suite — 1,189 lines covering binary results, recursive decoding, stream models and every Remote refusal.
- Key abstractions: `RuntimeSchema` / `RuntimeDescriptor` / `RuntimeRemoteModule` (the read-back shape) and `RemoteDeclarationMap` (the generated `.d.ts.map` contents).
- Data flow: fixture copy → analyzer/generator → the generated artifact is evaluated and its descriptors and codecs are asserted; the declaration map is inspected separately.
- Non-obvious design decisions: the suite asserts on **bytes**: "projects ordinary unary binary results and metadata without copying or freezing bytes" — the `Uint8Array` in a result must survive generation and decoding without a copy or a freeze. It also decodes "recursive objects, arrays, tuples, unions and root bytes by their field types", which is the real test of the `ResultEncoderEmitter`'s per-field walk.
- Edge cases / failure handling: the refusals are individually pinned — an untransportable alias, a Remote export with no Remote methods left, Remote artifacts on the wrong face, a workspace class parameter without a lookup declaration, a Remote Scope without a Context declaration, a scoped projection whose Context and lookup wire symbols differ, and duplicate endpoints across Remote services.
- Surprising: "evaluates declaration-merged mapped and conditional boundaries for codecs without widening consumer types" — the codec uses the *resolved* type while the consumer's declaration keeps the *authored* one, and the test proves they are not conflated.

### packages/typert/generator/tests/remote-module.ts
- Purpose: a 22-line helper that evaluates generated Remote artifacts **in source**.
- Key abstractions: `executableRemoteModule<Module>(source)`.
- Data flow: it transpiles the *current* `protocol/src/remote-info.ts`, inlines it as a `data:` URL, rewrites the generated module's `zod` and `@deepseek-ai/dsh-typert-protocol/remote-info` imports to point at real resolvable URLs, and `import()`s the result.
- Non-obvious design decisions: the helper deliberately loads the **current source** of the factory, not a previously built library — "Native fixture imports use current factory source, never a previously built protocol artifact" (the same words appear in the loader spec). This removes a whole class of false failures where the test runs against a stale build.
- Edge cases / failure handling: the rewrite is a regex over `from 'zod'` / `from '@deepseek-ai/dsh-typert-protocol/remote-info'`, so a generated module that imported those differently would slip through — the generator's output shape is the contract.
- Surprising: the generated artifact is loaded from a `data:` URL, so it has no filesystem path — which is also why the generated source map's `original` positions are the only way back to the source.

### packages/typert/generator/tests/renderer.spec.ts
- Purpose: the renderer's contract suite — 198 lines covering every type-node kind, optional shapes and every broken edge.
- Key abstractions: hand-built `TypeNodeModel` / `MemberModel` / `TypeDeclarationModel` values; the `childTypeNodeIds` edge enumeration.
- Data flow: a hand-written `TypeGraph` → `TypeGraphRenderer` → rendered TypeScript text.
- Non-obvious design decisions: the suite asserts the *exact* edge list for every one of the 24 node kinds — `childTypeNodeIds` is the traversal primitive the closure walk depends on, so a missing edge would silently truncate a declaration closure. It also asserts the `assertNever` behaviour for a future node kind and a future member kind.
- Edge cases / failure handling: a mapped type with no constraint, an alias with no type node, a missing node/declaration/member id — each throws a `TypeGraphRenderError` with a message naming the missing id.
- Surprising: the render of a tuple is asserted literally as `'[string, string?, ...string[]]'` and an array of a union as `'(string | string)[]'` — the parenthesisation rule is part of the contract.

### packages/typert/generator/tests/schema-emitter.spec.ts
- Purpose: the Zod-emitter's projection matrix — 974 lines split into supported and unsupported node kinds.
- Key abstractions: `ZOD_NODE_SUPPORT` (an exhaustive `Record<TypeNodeModel['kind'], 'supported' | 'unsupported'>` map), and the `supportedCases` / `unsupportedNodeCases` tables.
- Data flow: a hand-built `FaceModel` → `FaceModelEmitter.emit()` → the generated JavaScript is written to a temp module and **imported**, then the resulting Zod schema is exercised with accepted and rejected values.
- Non-obvious design decisions: the support matrix is a *type-level* exhaustive map — adding a new node kind to the model without classifying it here is a **compile error**, so the emitter's supported subset cannot drift from the model's vocabulary. The "unsupported" suite asserts the error message names the kind ("rejects `$kind` nodes explicitly").
- Edge cases / failure handling: unsupported cases are rejected *loudly* — "rejects unbound type parameters, incomplete generic applications, and generic schema exports", "rejects unsupported standard references and enums", "rejects incomplete collection references and invalid tuple rest types", "rejects more than one JSON index signature".
- Surprising: the unique-symbol nominal brand is *erased* rather than rejected ("erases unique-symbol nominal members without naming a branding utility") — a nominal marker must not become a JSON object.

### packages/typert/generator/tests/tools-catalog.spec.ts
- Purpose: the end-to-end proof that the generated `dsh-tools` artifact and the committed model-facing catalog agree.
- Key abstractions: a `WorkspaceAnalyzer` pass over the real workspace restricted to `@deepseek-ai/dsh-tools`, a `FaceModelEmitter`, and a temp-directory import of the generated module.
- Data flow: analyze → emit → write the generated `.js` to a temp file → `import()` it → `ctx.typert.register(generated.TYPERT)` → compare the registry's service/events/types against `SERVICE_API` / `EVENT_API` / `TYPE_API` from the committed `dsh-tool-cordis/src/api-catalog.ts`.
- Non-obvious design decisions: the comparison is against the **committed catalog file**, not against a snapshot — so the test proves the model the harness serves and the model the generator produces cannot diverge. The generated module is imported with a `?test=${Date.now()}` cache-buster so repeated runs do not reuse a stale module.
- Edge cases / failure handling: `afterEach` removes every temp root; the `dispose()` returned by `register` is awaited and the package is confirmed gone afterwards — the registry's withdrawal is part of the contract.
- Surprising: the test's `keys` are compared as a *set of fields* (`key`, `summary`, `methods[].signature`) rather than as whole objects, so the generated artifact is allowed to carry more than the catalog does — the comparison is on the model-facing surface only.

### packages/typert/generator/tests/tsdown-plugin-worker.spec.ts
- Purpose: the worker-mode integration test — 49 lines that run the real plugin against the real fixture.
- Key abstractions: `copyFixture(prefix)` (copies `fixtures/type-model` into a temp dir) and the plugin's `buildStart` / `writeBundle` pair.
- Data flow: `buildStart` → worker → `writeBundle` → the artifacts are compared byte-for-byte with an **in-process** `WorkspaceTypertGenerator` run.
- Non-obvious design decisions: the test asserts equivalence between the two generation routes — "writes the artifacts in-process generation produces" — i.e. the worker path and the direct path must produce identical bytes. The second test corrupts the fixture's `files` list and asserts the **worker's** error text reaches the bundle verbatim ("failed: TypertAnalysisError: typert(host): @fixture/host package files must include lib/typert.host.js").
- Edge cases / failure handling: the failure is an error from the worker *thread*, transported as a value and re-thrown as a `TypertWorkerError` with the original name and stack.
- Surprising: the fixture is copied to a temp dir precisely so the test can *mutate* it — the real fixture tree is never written to.

### packages/typert/generator/tests/tsdown-plugin.spec.ts
- Purpose: the plugin's unit suite with a faked Worker and a faked generator — 407 lines.
- Key abstractions: `FakeWorker` (an `EventEmitter` double), `vi.mock('node:worker_threads')`, `vi.mock('../src/workspace.ts')`, and the `claimedEmission()` helper.
- Data flow: the test drives the plugin's `buildStart` / `transform` / `writeBundle` directly and then emits the worker events by hand.
- Non-obvious design decisions: the whole suite is built around **manual worker event emission** — `worker.emit('message', …)`, `worker.emit('exit', 1)`, `worker.emit('error', crash)`, `worker.emit('messageerror', …)` — so every worker outcome is reachable deterministically. The malformed-response table enumerates nine malformed shapes, each of which must produce "received a malformed worker response". A separate test asserts the *first* `writeBundle` claims the emission and later ones return without waiting (`expect(emitted).toBe(false)`).
- Edge cases / failure handling: the worker failing to terminate is its own error ("could not terminate its worker"), the worker crashing is "crashed: …", an early exit is "exited with code N before reporting artifacts", and a response that cannot be deserialized is "received a worker response that could not be deserialized".
- Surprising: the transform test asserts the id filter matches `a.ts?raw.js` but **not** `a.js?from=a.ts` — a query string on a JavaScript file must not pull it into the TypeScript transform.

### packages/typert/generator/tests/type-model-workspace.ts
- Purpose: an **in-memory file system** for the analyzer — 317 lines that let the analyzer specs run without touching the disk.
- Key abstractions: `memoryFileSystem(real)` (the `node:fs` mock), `useMemoryWorkspaces()` (the spec hooks), `emptyWorkspace(prefix)`, `copyFixture(prefix)`, `pristineFixture()`, and `MEMORY_ROOT`.
- Data flow: `vi.mock('node:fs')` → the analyzer's `existsSync` / `readFileSync` / `writeFileSync` / `realpathSync` calls hit the in-memory maps for paths under `MEMORY_ROOT` and the real file system everywhere else; `ts.sys` is patched in parallel with the same routing.
- Non-obvious design decisions: (a) the module **must not import `node:fs`** — "This module must not import `node:fs`: the mock factory imports it while `node:fs` is being mocked." (b) The TypeScript default libraries are memoised separately because "Every `checkProject` program re-reads the default libraries from the installed typescript package, which is immutable." (c) `pristineFixture()` is **read-only** (`EROFS` on write), so a case that mutates the fixture must copy it first. (d) The `ts.sys` patch reimplements TypeScript's own `matchFiles` for the in-memory `readDirectory` — "TypeScript's include/exclude matcher, the one `ts.sys.readDirectory` applies to real directory listings" — because the real matcher needs a real directory.
- Edge cases / failure handling: `assertWritable` throws a proper `EROFS`; `makeMemoryDirectory` distinguishes `EEXIST` from `ENOENT`; `realpathSync` throws `ENOENT` for a path that does not exist.
- Surprising: the mock is a *full* `node:fs` mock — every other export is the real implementation, so the analyzer cannot accidentally depend on a mocked-only behaviour.

### packages/typert/generator/tests/type-model.spec.ts
- Purpose: the analyzer's main suite — 1,733 lines over the in-memory workspaces.
- Key abstractions: `TYPE_NODE_KINDS`, `TYPE_TARGET_KINDS`, `KEYWORD_TYPE_NAMES`, `TYPE_OPERATOR_NAMES`, `DECLARATION_KINDS`, `MEMBER_KINDS` (six exhaustive `satisfies Record<…>` maps), and the `analyzedFixture()` helper that analyses the pristine fixture once and **deep-freezes** it.
- Data flow: the frozen fixture model → assertions about face models, cross-face links, declaration merges, discovery, aggregation configs, rendering and emission.
- Non-obvious design decisions: (a) the six exhaustive maps are **type-level** completeness checks — a new model variant cannot be added without classifying it, or the spec file stops compiling. (b) `deepFreeze` the shared fixture model "so no case can alter what another reads" — cross-case contamination is prevented by construction. (c) The suite covers the *import-graph* rules exhaustively: relative imports across a face boundary, package subpaths absent from `package.json` exports, cross-face re-exports outside exports, namespace re-exports, star re-exports, and the whole forwarding-module family (named re-export, renamed hop, import re-exported without a specifier, star re-export, namespace import, a forwarding cycle whose only exit crosses a package by relative path).
- Edge cases / failure handling: "rejects TypeScript projects with source diagnostics before modeling them"; "rejects declaration merges without a lossless model"; "rejects merged interfaces with conflicting authored variance"; "produces one model regardless of batch size or package order" — the last is the property that makes `analyzeInBatches` safe.
- Surprising: the forwarding-module tests are the most elaborate part of the suite — following a re-export through several package-local modules, preferring an explicit edge over a star edge that loops back, and refusing a forwarding module that exports a namespace import binding. That is a lot of machinery for what a human would call "re-exports", and it exists because the model must attribute a type to its *declaring* package.

### packages/typert/generator/tsconfig.json
- Purpose: the generator package's TypeScript project config.
- Key abstractions: extends the workspace base; `rootDir: src`, `outDir: lib/types`.
- Data flow: `tsc -b` produces the declaration tree for the published package.
- Non-obvious design decisions: `include` is only `src`; the `tests/` tree (which contains the huge in-memory-workspace harness) is not part of the emitted project.
- Edge cases / failure handling: the project references are `vendor/cosmokit` and `vendor/cordis` only — the generator does **not** reference the protocol package, because the generator's source does not import it (the emitted code does).
- Surprising: the generator has no reference to `packages/typert/protocol` even though it emits imports of `@deepseek-ai/dsh-typert-protocol/remote-info` — the dependency exists only in the *output*, not in the compiler graph.

### packages/typert/loader/locale/en.json
- Purpose: the English UI title for the `typert-loader` plugin.
- Key abstractions: one `meta.title` key.
- Data flow: locale loader → plugin label.
- Non-obvious design decisions: the same one-key shape as the other `otel`/`typert-*` locale files — the convention is that English carries only the title.
- Edge cases / failure handling: none in-file.
- Surprising: identical in shape to four other files in this shard; the localisation convention is uniform across packages.

### packages/typert/loader/locale/zh.json
- Purpose: the Chinese UI title and description for the `typert-loader` plugin.
- Key abstractions: `meta.title`, `meta.description`.
- Data flow: locale loader → plugin label and tooltip.
- Non-obvious design decisions: the description ("加载插件生成的类型信息，供运行时查询和调用。") states the plugin's role in the pipeline.
- Edge cases / failure handling: none in-file.
- Surprising: the English file's missing `description` and the Chinese file's present one is the same asymmetry seen in the `otel` locale pair.

### packages/typert/loader/package.json
- Purpose: the manifest of `@deepseek-ai/dsh-typert-loader` v0.2.1-rc.2.
- Key abstractions: exports `.` only (plus `./src/*` and locales).
- Data flow: the peer dependencies declare the *contract* the plugin needs: `@deepseek-ai/cordis-plugin-loader` (the Loader it observes), `@deepseek-ai/dsh-typert-registry` (the store it feeds), and `@deepseek-ai/cordis`.
- Non-obvious design decisions: `@deepseek-ai/schemastery` is a **runtime** dependency because the plugin's `Config` is a schemastery schema — configuration validation is first-class, not a `zod` afterthought. The plugin has **no** `scripts` and no build entry beyond the default.
- Edge cases / failure handling: the `Config` type is `{ packages?: string[] }` and the schemastery schema defaults it to `[]` — so "no configuration" is still a valid configuration.
- Surprising: `typescript` and `zod` are *dev* dependencies of the loader — the loader's tests compile a native fixture of the protocol factory, but the shipped plugin depends on neither.

### packages/typert/loader/README.i18n.yaml
- Purpose: bilingual pairing record for the loader README (58 lines, 15 anchored sections).
- Key abstractions: per-heading `en`/`zh` hashes.
- Data flow: the pairing gate.
- Non-obvious design decisions: the anchor for the "caching and ownership" section is a first-class anchor — the cache-never-expires rule is a *published* limitation, not an implementation detail.
- Edge cases / failure handling: hash drift fails the gate.
- Surprising: the shared "known-limitations-and-deferred-work/dev-note" section hashes are identical across four package READMEs in this shard — the empty Dev Note is a fixed block, so its hash is constant.

### packages/typert/loader/README.md
- Purpose: the loader's contract — discovery, registration, withdrawal and failure behaviour.
- Key abstractions: `Config.packages` (explicit list for plugins nested behind another Loader entry); the `./typert` export as the discovery key.
- Data flow: a Cordis `internal/plugin` emission → a dirty entry name → a microtask flush → resolve the package → import `./typert` → `ctx.typert.register(manifest)` → withdraw on unmount.
- Non-obvious design decisions: the README states the **plugin lifecycle** explicitly — "Registration follows the entry lifecycle: it is withdrawn when the entry or the plugin unmounts, and an import that settles after either owner is gone is discarded." It also states the two-tier failure policy: "A malformed artifact among already-mounted entries fails activation loudly; a later failure is logged per package without preventing unrelated packages from registering", and the *explicit*-list policy: "An explicit `packages` entry that cannot be resolved from the config tree, or that lacks the export, fails loudly and names the package."
- Edge cases / failure handling: "Resolution verdicts and imported manifests are cached for the process lifetime, so adding a `./typert` export requires a restart" — a stated cache-never-expires limitation. `local.hasSeen()` "prevents downgrading to it after a registered definition is withdrawn."
- Surprising: the loader "does not recover erased constraints, documentation, or schemas from live Services" — source-mode fallback is explicitly a Gateway concern, so the loader is not a second source of truth.

### packages/typert/loader/README.zh.md
- Purpose: Chinese translation of the loader README.
- Key abstractions: the same anchors, including `#what-gets-registered` and `#observable-behavior-and-failures`.
- Data flow: paired through `README.i18n.yaml`.
- Non-obvious design decisions: it preserves the "cached verdicts never expire" limitation, so the operational caveat survives translation.
- Edge cases / failure handling: none in-file.
- Surprising: it keeps the English `Loader` and `package` terms verbatim inside the Chinese prose — the domain vocabulary is not translated.

### packages/typert/loader/src/index.ts
- Purpose: the loader plugin — 507 lines of incremental discovery, manifest validation and registration wiring.
- Key abstractions: `TYPERT_HOST_EXPORT`, `name`, `inject`, `Config`, `validateTypertManifest(pkgName, exported)`, and `apply(ctx, config)`.
- Data flow: `ctx.on('internal/plugin', fiber)` → mark the fiber's entry name dirty → microtask flush → `processOne(entryName)` → `resolveArtifact` → `loadManifest` → `ctx.typert.register(manifest)`.
- Non-obvious design decisions: (a) **The scanner is incremental, not a poll**: "every Cordis `internal/plugin` emission marks the fiber's entry name dirty, and a microtask flush reconciles each dirty name against the live Loader entries" — and the activation pass "seeds the same dirty set with all current entries", so there is exactly one reconciliation path. (b) **A negative verdict is cached as `null` and never expires**, so a loader builtin or a subpath row is tested once per process. (c) **The resolution anchor is the config tree's `baseUrl`**, not the plugin's own URL — "This package's own URL would miss sibling packages under pnpm's isolated `node_modules`" — and the plugin *refuses to start* without it. (d) The two-armed settle at line 451: "Two-armed settle: a bare `.finally()` would mint a second, unhandled rejection." (e) `validateTypertManifest` inspects **supplied data without invoking the factory's cached projection getters** (line 298) — validation must not materialise a schema.
- Edge cases / failure handling: a configured package that cannot be resolved fails with a message naming the fix ("add it to the composition package dependencies or remove it from packages"); a package with no `./typert` export fails the same way. An import that settles after the owner is gone is discarded (`!active || !qualifies(entryName) || registered.has(entryName)`). Steady-state failures are logged per package; the activation pass aggregates them into one `AggregateError`.
- Surprising: `qualifies()` checks `entry.fiber !== undefined && !entry.disabled` — a *disabled* Loader entry is not a contributor, so disabling a plugin also withdraws its Typert registration.

### packages/typert/loader/tests/lazy-info.spec.ts
- Purpose: the 35-line proof that registration never materialises a consumer-owned input view or projection.
- Key abstractions: spies on `method.input`, on the `jsonSchema` getters of the normal and strict views, on `jsonSchemaError`, on `method.result.jsonSchema`, and on the schema factory `create`.
- Data flow: build a `createTypertRemoteInfo` over a fixture spec → call `validateTypertManifest` with the resulting descriptors → assert every spy is untouched.
- Non-obvious design decisions: the test asserts *laziness at the registration boundary*, not at the factory boundary — the manifest may be validated without touching a single parser or projection. It then reads the projections *after* the assertion, proving the spies were not merely never-called-but-also-not-observed.
- Edge cases / failure handling: the `jsonSchemaError` getter is spied separately from `jsonSchema`, because a consumer may read one and not the other.
- Surprising: the spec's own header states the invariant in one line: "Loading a generated contribution must not request consumer-owned input views or projections."

### packages/typert/loader/tests/loader.spec.ts
- Purpose: the loader's integration suite — 814 lines that boot a real Loader over a temp `node_modules`.
- Key abstractions: `writePackage(base, pkgName, options)` (writes a fake installed package), `typertSource(pkgName, entryName)` (writes a valid `TYPERT` manifest), `invocationTypertSource(pkgName, factoryUrl)` (a manifest carrying a real `createTypertRemoteInfo` call), `writeRemoteInfoRuntime(base)` (transpiles the *current* protocol source into a module), and `boot()` (a real Cordis Context with the Loader, the registry and `PluginPackages`).
- Data flow: fake packages in a temp `node_modules` → a real `ctx.loader.create({name})` → the loader plugin → the registry.
- Non-obvious design decisions: (a) `writeRemoteInfoRuntime` transpiles `../../protocol/src/remote-info.ts` and asserts the transpiled module has **zero** import declarations — the factory must be dependency-free — then loads it from a `data:` URL. (b) The suite pins **when** things happen: the unmount reconciliation "rides a queued microtask flush that settles after `loader.await()`", so the test polls with `vi.waitFor` rather than assuming. (c) A test drops an in-flight manifest by mocking `queueMicrotask` to capture the callback, disposing the loader, and *then* running the captured callback — the ordering is exercised deliberately. (d) The "contains steady-state registration failures" test makes `ctx.typert.register` throw a **string** (`'register failed'`), proving the plugin normalises a non-`Error` throw.
- Edge cases / failure handling: an absent configured package, a package with no Typert export, a subpath row, an npm alias whose manifest name differs from the requested one, a malformed manifest, an unimportable declared module, a conditional export shape, a primitive export target, a virtual plugin with no package root, a missing `ctx.baseUrl`, and a steady-state registration failure — all covered.
- Surprising: the whole suite has a 60-second timeout (`LOADER_TEST_TIMEOUT`) because "the default 5s deadline is too tight on slow CI filesystems" — a timeout is treated as a property of the environment, not of the test.

### packages/typert/loader/tsconfig.json
- Purpose: the loader package's TypeScript project config.
- Key abstractions: extends the workspace base; `rootDir: src`, `outDir: lib/types`.
- Data flow: `tsc -b` produces the declarations; the references are `boot/app-boot`, `vendor/cosmokit`, `vendor/cordis`, `vendor/loader` and `vendor/schemastery`, plus `../registry`.
- Non-obvious design decisions: the reference list is the plugin's *whole* dependency contract expressed as project references — the Loader, the schemastery config schema, the app-boot package resolver, and the registry it feeds. The `registry` reference is why the loader's `ctx.typert.register(...)` call type-checks.
- Edge cases / failure handling: `include` is only `src`.
- Surprising: `vendor/loader` is a separate reference from `vendor/cordis` — the Loader plugin is vendored separately from the framework core.

### packages/typert/protocol/package.json
- Purpose: the manifest of `@deepseek-ai/dsh-typert-protocol` v0.2.1-rc.2.
- Key abstractions: **three** public entry points — `.` (decorators + Gateway bindings), `./types` (the pure type module) and `./remote-info` (the pure, Zod-free factory).
- Data flow: `zod` and `@deepseek-ai/dsh-brand` are the runtime dependencies; `@deepseek-ai/cordis` is a peer.
- Non-obvious design decisions: the `./remote-info` subpath exists precisely so the **published** entry can be Zod-free — the built-runtime e2e test asserts that neither `lib/index.js` nor `lib/types/remote-info.js` contains a `zod` import. `@deepseek-ai/dsh-brand` is a dependency for exactly one thing: the branded `PeerId` type.
- Edge cases / failure handling: `files` ships `lib/index.js` and `lib/types/**` — no `lib/index.d.ts` at the root, because the declaration tree lives under `lib/types`.
- Surprising: `zod` is a **runtime** dependency of the protocol package even though the protocol's own code never imports it at runtime — `remote-info.ts` imports `type { z } from 'zod'` only. The dependency exists so the *generated* artifacts can resolve zod through the protocol's dependency tree.

### packages/typert/protocol/README.i18n.yaml
- Purpose: bilingual pairing record for the protocol README (67 lines, 19 anchored sections).
- Key abstractions: per-heading hashes, including the deeply nested `/…/use-this-package/identifying-the-caller-and-admitting-non-owner-callers`.
- Data flow: the pairing gate.
- Non-obvious design decisions: the anchor names are long and semantic — "associating-host-objects-and-contexts-with-wire-identities" — so cross-package links to a *concept* rather than to a line.
- Edge cases / failure handling: hash drift fails the gate.
- Surprising: the table-of-contents hash pair (`d152484eb41ac6b4` / `09388d293f9be9cb`) is **identical** to the generator's and the loader's — the three packages share a byte-identical table of contents block.

### packages/typert/protocol/README.md
- Purpose: the protocol's contract — how a business package exposes a Host method, how a caller is identified, how objects and Contexts get wire identities, and how a failure is reported.
- Key abstractions: `@Remote` / `@RemoteScope`, `bindTypertRemote()` / `TypertRemoteService`, `method.input({strict})`, `TYPERT_REMOTE`, `createTypertRemoteInfo(spec, z)`, `principalOf()`, `TypertLookupMap` / `TypertContextMap` / `TypertResourceMap`, `RemoteError` / `remoteErrorOf`, and `typertOwnedValue()`.
- Data flow: a decorated method → a prototype marker → the build pipeline's strict reflection → a wire endpoint → the Gateway → a typed Client call.
- Non-obvious design decisions: (a) **The decorators carry only minimal markers** — "decorator initializers retain minimal markers in a versioned descriptor on the Service prototype" — and "Full parameter, result, lookup, and schema reflection is the Typert build pipeline's job". (b) **The descriptor uses a stable string property name** so "another installed copy of the protocol package can read the same markers" — the same trick as `Symbol.for` in `owned-value.ts`. (c) **Input policy belongs to the consumer, not the method**: `method.input(options?)` returns a *cached* `TypertRemoteValue<Input>` whose only option is `strict`. (d) **The `resources` readers are per-kind, per-call**, and the README states the consequence with unusual bluntness: "they must name every resource the method accesses, because access control never checks one they omit" — a fail-open shape, called out in the contract. (e) **A discriminated union, never `instanceof`**: "A caller discriminates by `code` — never by `instanceof` — and a `code` branch narrows `details` with no cast".
- Edge cases / failure handling: "Markers require public, non-static instance methods with string names, and conflicting markers on one method are rejected." `remoteErrorOf` reads "a structural marker instead of the prototype chain" so an error thrown in another realm is still recognised. `typertOwnedValue` transfers cleanup "without adding another resource reference count" and its `Symbol.dispose` is idempotent.
- Surprising: the `Model Experience` section says "None, as compiler-independent Remote protocol declarations register nothing model-facing" and the "KV Cache effect" section says "No direct effect" — the same shape as every other README in this shard.

### packages/typert/protocol/README.zh.md
- Purpose: Chinese translation of the protocol README.
- Key abstractions: the same 19 anchors.
- Data flow: paired through `README.i18n.yaml`.
- Non-obvious design decisions: it preserves the "生成的 Client 流方法返回 `RemoteStreamHandle<Out, In>`" contract and the "上行项在 Host 逐项校验，因为它们来自浏览器" (uplink items are validated one by one at the Host because they come from the browser) — the security-relevant sentence survives translation.
- Edge cases / failure handling: none in-file.
- Surprising: it explains the `ctx.invocation` accessor rule in the same detail as the English page, including the "第一个 `bindTypertRemote()` 绑定" bootstrap order.

### packages/typert/protocol/src/index.ts
- Purpose: the protocol's runtime surface — 484 lines of decorators, Gateway bindings and the segment grammar.
- Key abstractions: `Remote`, `RemoteScope`, `bindTypertRemote`, `TypertRemoteService`, `remoteMethods(service)`, `isTypertRemoteSegment(value)`, and the `RemoteMethodMarker` / `RemoteInvocationMarker` types.
- Data flow: a decorator's `addInitializer` → a frozen marker on the class prototype → `remoteMethods(service)` → the Gateway's source-mode discovery.
- Non-obvious design decisions: (a) The marker lives under a **versioned** descriptor key (`'@deepseek-ai/dsh-typert-protocol/remote-methods'`) whose `version` is validated on read — "an unsupported Remote method descriptor version N" is a hard error, so a future format change fails loudly instead of being misread. (b) The decorator is **non-enumerable and non-writable** on the prototype (`configurable: true, enumerable: false, writable: false`) so it does not show up in `Object.keys(prototype)`. (c) `remoteMethods` returns a **detached snapshot** — the caller cannot mutate the stored descriptor. (d) **Conflicting markers are refused**: two different decorators on one method throw "has conflicting invocation markers", and re-applying the *same* decorator is idempotent (identity comparison of the frozen reader record). (e) `provideInvocationAccessor` registers `ctx.invocation` on the **root** of the tree, "where it outlives any one Service" — so a Remote Service leaving does not take the accessor with it. (f) The decorator options are validated **against a closed key set** (`name`, `mode`, `resources`), and `mode` must be exactly `'stream'`.
- Edge cases / failure handling: a decorator on a private, static or symbol-named method throws "Remote decorators require a public instance method with a string name"; a name that is not an endpoint segment throws "must contain only RPC endpoint segment characters"; a `resources` map with no reader throws "Remote resources require at least one reader".
- Surprising: the `resources` readers are *frozen into the marker* at decoration time and validated then — "a misdeclared reader fails at decoration" — but they are **executed only at runtime** by the Gateway, so the build pipeline records nothing about them (the generator's `remoteOptions` even ignores them: "its readers run only at runtime").

### packages/typert/protocol/src/json-value.ts
- Purpose: the lossless-JSON checks every carrier shares.
- Key abstractions: `isRemoteJsonValue(value)`, `isRemoteUplinkItem(value)`.
- Data flow: the Client handle before it queues an uplink item → the Gateway at its wire and codec-less uplink boundaries → the in-process mock.
- Non-obvious design decisions: the checks are **structural and strict**: a number must be finite *and* not `-0` (`!Object.is(value, -0)`), because `JSON.stringify(-0)` is `"0"` and the round trip would change the value. An array must have `Array.prototype` as its prototype *and* exactly `length + 1` own keys — so a sparse array or an array with an extra property is rejected. An object must have `Object.prototype` or `null` as its prototype, every own key must be a string, and every own property must be **enumerable** (a non-enumerable property is a value the wire would drop).
- Edge cases / failure handling: cycles are detected with an ancestor set (a value is removed from the set on the way out, so a *shared* reference is allowed but a cycle is not). Nested `undefined`, `NaN` and infinities are rejected; a **top-level** `undefined` is allowed as one uplink item because the wire carries it as an `item` frame without a `value`.
- Surprising: the ancestor set is added and removed around the recursion (`ancestors.add(value)` … `finally { ancestors.delete(value) }`), which is exactly the "cycle, not aliasing" distinction — a JSON document may repeat a value but may not contain itself.

### packages/typert/protocol/src/owned-value.ts
- Purpose: invocation-owned values returned by synchronous Client Context resolvers.
- Key abstractions: `TYPERT_OWNED_VALUE` (a `Symbol.for` marker), `TypertOwnedValue<Value>`, `typertOwnedValue(value, release)`, `isTypertOwnedValue(value)`.
- Data flow: a Client Context resolver returns an owned value → the Gateway disposes it after the handler and reply settle.
- Non-obvious design decisions: the marker is `Symbol.for('dsh.typert.owned-value')` — a **global** symbol, so "the shared `TYPERT_OWNED_VALUE` symbol and `isTypertOwnedValue` recognizer work across independently bundled providers and Gateway". The wrapper **does not retain a resource**: it holds the value and the release callback, and `Symbol.dispose` calls the release **at most once** (an `active` flag), so a double dispose is safe.
- Edge cases / failure handling: the release is specified as non-throwing and synchronous; the wrapper itself does not add a reference count, which is the stated reason the design exists ("Transfer cleanup ownership without adding another resource reference count").
- Surprising: `TypertOwnedValue` extends `Disposable`, so it works with `using` — and the spec exercises exactly that (`using owned = typertOwnedValue(value, release)`).

### packages/typert/protocol/src/principal.ts
- Purpose: one function — read the non-owner caller of the current Remote call.
- Key abstractions: `principalOf(invocation)`.
- Data flow: `this.ctx.invocation` → `invocation.peer.principal` → the owner, or the caller's identity.
- Non-obvious design decisions: the owner is represented as `undefined` rather than as a distinct principal — "returns the principal of a non-owner caller and `undefined` for the owner and for trusted in-process code outside a Remote call". The caller then "writes the field only when it is defined", so durable output records *who did it* only when someone other than the owner did it.
- Edge cases / failure handling: `invocation === undefined` (outside a Remote call) is the same as the owner case — one `undefined` for both, so there is exactly one "nobody to blame" state.
- Surprising: the principal is "fixed when it creates the Peer; no wire field can set it" — the identity is established in-process, so a hostile client cannot forge it by sending a field.

### packages/typert/protocol/src/remote-access.ts
- Purpose: the *type* vocabulary of Remote access-control resources (38 lines, no runtime code).
- Key abstractions: `RemoteAccessResourceKind`, `RemoteAccessResource`, `RemoteAccessResourceOf<K>`.
- Data flow: a declared resource kind → a resource identity → an access decision in `dsh-api-remote-access`.
- Non-obvious design decisions: the file's header states the invariant that matters — "Resources are independent: access to one resource implies no access to any other." The type is a *mapped* union over `TypertResourceMap`, so a domain that declares a kind gets that kind's identity type automatically.
- Edge cases / failure handling: `global` is the built-in identity-less kind and is never a declared kind; the file carries an `oxlint-disable` with an explanation — the map is empty in this compilation unit, so the rule sees `never` while every domain merges its key in.
- Surprising: `RemoteAccessResource` is expressed as a *distributive mapped type* over the resource map, so a new domain kind becomes a new resource variant with no edit to this file.

### packages/typert/protocol/src/remote-error.ts
- Purpose: the single failure class every Remote participant uses.
- Key abstractions: `RemoteError<Code>` (carrying `code`, `message`, `details`) and `remoteErrorOf(value)`.
- Data flow: an owner throws at the failure point → the Gateway encodes it unchanged → the Client face rebuilds an instance for the `RemoteResult` error branch.
- Non-obvious design decisions: the class carries a **structural marker** (`isDSHRemoteError: true`) precisely so a failure that crossed a module or realm boundary is still recognisable — "an Error thrown in another realm (iframe, VM) fails `instanceof Error` here, so the marker plus the code field is the test." `remoteErrorOf` requires *both* the marker and a string `code`, so an unrelated object that happens to carry one of them is not accepted.
- Edge cases / failure handling: the `code` is a key of the merge-extensible `RemoteErrorDetailsMap`, so `details` is typed by the code and a `code` branch narrows it with no cast. `cause` "survives in-process only" — the standard `ErrorOptions` are used, and the contract says plainly that the cause is not carried on the wire.
- Surprising: the class doc says "so `throw result.error` keeps throw semantics" — the Client can re-throw the failure it received, and it is still an `Error`.

### packages/typert/protocol/src/remote-info.ts
- Purpose: the pure, Zod-free factory that assembles generated Remote definitions lazily.
- Key abstractions: `createTypertRemoteInfo(spec, zod)`, `isTypertRemoteMethod(descriptor)`, and the private `RemoteInfo` / `NamedInput` / `ResultValue` classes.
- Data flow: a generated `TypertRemoteSpec` → the `RemoteInfo` instance → (on first read) a shared descriptor/method index → per-view parsers and projections.
- Non-obvious design decisions: (a) The whole point is **laziness**: "Retain one generated definition per endpoint without constructing parsers or projections. The class instance builds its shared descriptor/method index on first access; input schemas and JSON Schema projections are cached only when requested." (b) `NamedInput.create` builds a `z.strictObject` from the parameter list and caches it in the instance; the *strict* and *loose* views are two separate cached instances (`inputs[strict ? 1 : 0] ??= new NamedInput(...)`). (c) `invoke` re-reads the mounted method on **every call** ("looks up the current mounted method on each call"), so a method withdrawn after mounting fails at the call, not at a stale capture. (d) `isTypertRemoteMethod` requires `result.mode === 'strict'` **and** callable `input`/`invoke` — a source-mode or legacy descriptor is not silently treated as a generated method.
- Edge cases / failure handling: a missing JSON Schema for one parameter produces a `jsonSchemaError` naming that parameter, while the parser remains available; a schema factory that throws is *not* swallowed — "a parser factory that throws" propagates, and the test asserts it throws twice in a row.
- Surprising: `ResultValue` wraps the result spec **only when it has a description** — otherwise the original spec object is used, so the common case adds no allocation and no indirection.

### packages/typert/protocol/src/types.ts
- Purpose: the protocol's type vocabulary — 939 lines that every other package in the shard imports.
- Key abstractions: the merge-extensible maps (`TypertLookupMap`, `TypertContextMap`, `TypertResourceMap`, `PrincipalMap`, `RemoteErrorDetailsMap`, `TypertRemoteMap`, `TypertRemoteScopeMap`, `TypertRemoteEventSelection`), plus `InvocationDescriptor`, `RemoteInvocation`, `PeerScope`, `RemoteResult`, `RemoteStream`, `RemoteStreamHandle`, and the five registry interfaces.
- Data flow: the type system carries the *static* half of the contract; the runtime half lives in `index.ts` and `remote-info.ts`.
- Non-obvious design decisions: (a) The maps are **empty interfaces meant to be merged** — a domain package declares its key by `declare module`, and the protocol learns about it with no change. (b) `RemoteResult<T>` is a discriminated union, not a thrown error — "the Remote face itself folds carrier failures into the error branch, so no consumer wraps a call to recover one; only assembly faults (arity, an unmounted method, a missing Context adapter) still reject." (c) `RemoteInvocation.uplink<In>()` is **single-consumer** ("Available once; a second call throws") and the runtime decodes by the *descriptor*, not by the caller's type argument — "`In` is the caller's assertion: the runtime decodes by the descriptor and does not cross-check it." (d) `PeerScope.principal` is fixed at creation "by in-process Host code; no wire field can set it".
- Edge cases / failure handling: `RemoteInvocation` is `undefined` on a Context no Remote call derived; `ctx.invocation` is declared on the Cordis `Context` so the accessor is part of the framework's type surface.
- Surprising: `TypertForwardableEvent` is derived from the *Cordis `Events` declaration itself* by inspecting the event's arity and return type — "Cordis event names the Remote Event carrier can preserve without a second signature declaration" — so a new Cordis event becomes forwardable automatically if its shape allows it.

### packages/typert/protocol/tests/built-runtime.e2e.ts
- Purpose: the 61-line published-artifact gate — the only test in the shard that inspects `lib/`.
- Key abstractions: a `it.each` over the two published entries, and an inline script executed in a child process.
- Data flow: reads `../lib/index.js` and `../lib/types/remote-info.js` as text and greps them for a `zod` import; then runs a script that mounts a built and a source Cordis `Context` and the built `RemoteAccess` plugin.
- Non-obvious design decisions: the zod check is a **regex over the emitted text**, not an import graph — "keeps the published protocol entry free of Zod runtime imports". The cross-copy test asserts `BuiltContext.is(ctx)` is true for a *source* Context ("recognizes source and built Cordis Contexts in an active built RemoteAccess plugin"), which is the property that lets a mixed source/built composition keep the `invocation` accessor.
- Edge cases / failure handling: the script runs with `--import ts/esm` and a 15-second timeout; the observed values are compared exactly, so a behavioural change in Cordis's `Context.is` fails the gate.
- Surprising: the test asserts `outside: null` and `allowsOutside: true` — outside a Remote call, the access layer *allows* the global resource, while a guest invocation is refused. The default is permissive for the owner path.

### packages/typert/protocol/tests/fixtures/source-launch.ts
- Purpose: a 32-line fixture proving the decorators work under a real TSX source launcher.
- Key abstractions: a `Goals` service with `@Remote` and `@RemoteScope('agent')` methods.
- Data flow: the fixture is launched by `node --import ts/esm`; it prints the JSON of `remoteMethods(new Goals(new Context()))` and throws if it differs from the expected array.
- Non-obvious design decisions: the fixture **throws** on a mismatch instead of printing and letting the parent compare — the child process's exit code is the assertion. It constructs a real `Context` so the `TypertRemoteService` constructor's root-accessor registration is exercised.
- Edge cases / failure handling: none in-file; the parent's `execFileSync` inherits a non-zero exit as a test failure.
- Surprising: this fixture is the *only* place the protocol's decorators are run through a genuine TypeScript transformer — the Vitest source transform is a different path, and the spec runs both.

### packages/typert/protocol/tests/owned-value.spec.ts
- Purpose: the 27-line contract for the invocation-ownership wrapper.
- Key abstractions: `typertOwnedValue`, `isTypertOwnedValue`, `TYPERT_OWNED_VALUE`.
- Data flow: create an owned value → dispose it explicitly and via `using` → assert the release fired once.
- Non-obvious design decisions: the test builds a **sibling bundle** by hand — `{ [Symbol.for('dsh.typert.owned-value')]: true, value: {}, [Symbol.dispose]() {} }` — to prove the recogniser works across independently bundled copies, and it checks the negative cases: `undefined`, `null`, `1`, `{}`, and a value whose marker is `false`.
- Edge cases / failure handling: a double `Symbol.dispose` must call `release` **once**.
- Surprising: the test asserts `TYPERT_OWNED_VALUE` equals `Symbol.for('dsh.typert.owned-value')` literally — the global symbol name is a published contract, not an implementation detail.

### packages/typert/protocol/tests/protocol.spec.ts
- Purpose: the protocol's main suite — 500 lines over the decorators, markers, bindings and the invocation accessor.
- Key abstractions: `methodContext(name, initializers)` (a hand-built `ClassMethodDecoratorContext` so the decorators can be driven without a transformer), and the four test-only `Events` declarations.
- Data flow: decorators → initializers → a marker on a prototype → `remoteMethods(service)`.
- Non-obvious design decisions: (a) The suite drives the decorators **both** ways — through the Vitest source transform (real `@Remote` syntax) and through hand-built decorator contexts (so the decorator's own validation is tested directly). (b) It asserts the **exact shape** of the prototype: `Reflect.ownKeys(Goals.prototype)` is exactly `['constructor', 'create', 'scoped', REMOTE_METHOD_DESCRIPTOR_KEY]` and `Object.keys(...)` is empty — the marker is present but invisible to enumeration. (c) The invocation-accessor test asserts the accessor is registered **once per tree, on the root**: after the first Remote Service is disposed, `child.ctx.invocation` is still `undefined` rather than throwing.
- Edge cases / failure handling: malformed prototype descriptors (null, wrong version, non-array methods) each produce a named error; a prototype-less object returns `[]`; a conflicting decorator pair throws; a `RemoteScope` on two different Context keys conflicts; `RemoteScope` with a `mode` option is rejected.
- Surprising: the test asserts `expect(Reflect.ownKeys(Goals)).toEqual(['length', 'name', 'prototype'])` — the decorators must not add a static property to the class either.

### packages/typert/protocol/tests/remote-access.spec.ts
- Purpose: the access-resource and principal suite — 267 lines.
- Key abstractions: the test-only `PrincipalMap` entry `'test-guest'`, the `TypertResourceMap` entry `'test-room'`, and `markerOf` / `readerOf` helpers that read a reader back off a marker.
- Data flow: a decorated method → its frozen `resources` record → a reader invoked with the method's own arguments.
- Non-obvious design decisions: the suite asserts the **type-level** contract of the readers with `expectTypeOf` — a reader's parameters are inferred from the decorated method (with a lookup parameter mapped to its *wire* identity), a cancellation parameter typed `AbortSignal`, and a reader's return typed as the kind's identity. It also pins the *negative* type cases with `@ts-expect-error`: a reader that names a field the request does not have, a reader with an extra parameter, a reader placed after the signal, a reader that returns a number instead of an identity, and a reader for the undeclared `global` kind.
- Edge cases / failure handling: `resources: {}` throws "Remote resources require at least one reader"; a non-function reader throws "must be a function"; a second declaration with different readers throws "conflicting invocation markers".
- Surprising: `principalOf` is tested with a *lookalike* principal whose `kind` is `"Owner"` (capital O) — it is returned as-is, proving the owner test is an exact `'owner'` comparison and not a case-insensitive one.

### packages/typert/protocol/tests/remote-info.spec.ts
- Purpose: the lazy-info suite — 230 lines over the factory's laziness, the strict/loose views and the `isTypertRemoteMethod` guard.
- Key abstractions: a `definition()` fixture builder and a `text` codec (`z.string()` with a `typeSymbol` and a `jsonSchema`).
- Data flow: `createTypertRemoteInfo(spec, z)` → the `methods` index → `input()` views → parsers and projections.
- Non-obvious design decisions: the first test counts **reads** with getters: the spec's `methods` is a getter, and each codec's `jsonSchema` is a getter, and the test asserts exactly how many times each was read — "defers its index, schemas, and projections independently". It also asserts `info.methods` and `info.descriptors` are **reference-identical** across reads (`toBe`), i.e. the index is cached once.
- Edge cases / failure handling: a declared field whose parser accepts `undefined` is still **required** in the parser ("requires declared fields even when their parser accepts undefined"); a lookup alias (`wire: 'agentId'`) is preserved; a missing wire field fails to parse; an extra field fails in the strict view and is stripped in the normal one; a Context-only descriptor is kept in `descriptors` and **not** in `methods`, and `isTypertRemoteMethod` returns `false` for it.
- Surprising: the test asserts the result codec object is the *same object* as the spec's (`expect(method.result).toBe(codec)` in the registry spec; `method.result.create` is `output.create` here) — the factory does not wrap or copy a codec that does not need wrapping.

### packages/typert/protocol/tsconfig.json
- Purpose: the protocol package's TypeScript project config.
- Key abstractions: extends the workspace base; `rootDir: src`, `outDir: lib/types`.
- Data flow: `tsc -b` produces the published declaration tree.
- Non-obvious design decisions: the references are `vendor/cosmokit`, `vendor/cordis` and `../util/brand` — the brand package is referenced for exactly one type (`Branded<'PeerId'>`), and it is a *project* reference so the brand is inlined into the published declarations rather than being a runtime dependency.
- Edge cases / failure handling: `include` is only `src`.
- Surprising: the protocol package declares `zod` as a **runtime** dependency but does not reference any zod project — the zod types it uses are ambient.

### packages/typert/README.i18n.yaml
- Purpose: bilingual pairing record for the `typert` group map.
- Key abstractions: per-heading hashes under the `/packages-typert/…` prefix.
- Data flow: the pairing gate for `packages/typert/README.md`.
- Non-obvious design decisions: the anchors are group-scoped, matching the `telemetry` group's convention.
- Edge cases / failure handling: hash drift fails the gate.
- Surprising: 6 anchored sections for a 52-line page — the group maps are held to the same standard as the package READMEs.

### packages/typert/README.md
- Purpose: the group map for `packages/typert` — four packages and what each owns.
- Key abstractions: a four-row table with a `ctx key` column (`loader` consumes `ctx.loader` and `ctx.typert`; `registry` provides `ctx.typert`; the other two provide none).
- Data flow: the map is the entry point to the group; each package README owns its own configuration and limits.
- Non-obvious design decisions: the summary states the group's purpose in one sentence — "Client environments can call Host capabilities as typed methods and share generated schemas and reflection without hand-written wire code" — and names the four-stage pipeline: generator → registry → loader → protocol.
- Edge cases / failure handling: none in-file; the page explicitly defers to each package README ("each package README owns its configuration, usage, and limits").
- Surprising: the `ctx key` column is the fastest way to see that the protocol and the generator are **runtime-invisible** — they register no service.

### packages/typert/README.zh.md
- Purpose: Chinese translation of the `typert` group map.
- Key abstractions: the same four-row table with the `ctx key` column.
- Data flow: paired through `README.i18n.yaml`.
- Non-obvious design decisions: it keeps the same "构建时生成器 → 运行时注册表 → Loader 集成 → 共享协议" ordering, so the pipeline reads identically in both languages.
- Edge cases / failure handling: none in-file.
- Surprising: it links the Chinese `docs/subsystems/typert.zh.md` and the Chinese Agent Note, so the whole cross-reference graph is localised.

### packages/typert/registry/locale/en.json
- Purpose: the English UI title for the `typert-registry` plugin.
- Key abstractions: one `meta.title` key.
- Data flow: locale loader → plugin label.
- Non-obvious design decisions: the same one-key English convention as the other packages in this shard.
- Edge cases / failure handling: none in-file.
- Surprising: five separate English locale files in this shard all have exactly one key.

### packages/typert/registry/locale/zh.json
- Purpose: the Chinese UI title and description for the `typert-registry` plugin.
- Key abstractions: `meta.title`, `meta.description`.
- Data flow: locale loader → plugin label and tooltip.
- Non-obvious design decisions: the description names the two things the registry holds ("运行时类型信息和远程调用定义") — runtime type information and remote call definitions.
- Edge cases / failure handling: none in-file.
- Surprising: identical in shape to the loader's and the otel's Chinese locale files.

### packages/typert/registry/package.json
- Purpose: the manifest of `@deepseek-ai/dsh-typert-registry` v0.2.1-rc.2.
- Key abstractions: **two** public faces — `.` (the Host entry) and `./client` (the browser face, with `node` and `browser` conditions).
- Data flow: `dsh` → `client` metadata (`inject: []`, `platform: 'web'`, `immediately: true`) tells the client runtime to install the browser face automatically.
- Non-obvious design decisions: the `./client` export has a `node` condition pointing at `lib/client.node.js` and a `browser` condition at `lib/client.browser.js`, with `default` falling back to the browser bundle — "Node resolves `/client` to the standalone ESM `lib/client.node.js` bundle for programmatic Cordis composition; browsers use the `lib/client.browser.js` loader factory through the logical `/plugins/.../client.js` URL. Both bundles use the same registry implementation, separate from the Host package root." `zod` is pinned to the exact `4.4.3`.
- Edge cases / failure handling: the `dsh.client.immediately: true` flag means the client face is installed without waiting for an explicit mount.
- Surprising: the registry package ships **three** JavaScript bundles (`lib/index.js`, `lib/client.node.js`, `lib/client.browser.js`) from a single source file — the `client/index.ts` entry is 15 lines.

### packages/typert/registry/README.i18n.yaml
- Purpose: bilingual pairing record for the registry README (61 lines, 16 anchored sections).
- Key abstractions: per-heading hashes.
- Data flow: the pairing gate.
- Non-obvious design decisions: the anchor `/…/use-this-package/registering-a-contribution` exists because that section carries the sharpest operational rule in the package (registering *and* mounting the same contribution duplicates it and fails).
- Edge cases / failure handling: hash drift fails the gate.
- Surprising: the `table-of-contents` hash pair is the same constant as the generator's, the loader's and the protocol's.

### packages/typert/registry/README.md
- Purpose: the registry's contract — storing generated reflection and schemas, and resolving providers.
- Key abstractions: `ctx.typert` with five sub-registries (`local`, `remotes`, `lookups`, `contexts`, `resources`), plus `get`/`resolve`/`list`/`getPackage`/`listPackages`/`toJSONSchema`.
- Data flow: a generated contribution → `ctx.typert.register(contribution)` → an atomic, fiber-scoped commit → queries.
- Non-obvious design decisions: (a) "**A contribution is one atomic, fiber-owned commit**" — `register()` validates the package-face identity, schemas and invocation descriptors *first*, then commits everything under a single Cordis effect whose disposer withdraws exactly that contribution. (b) The **schema key omits the face** (`<package>#<name>`), and the README states the consequence: "host and client run in separate contexts, so registering same-named schemas from both faces into one context is rejected as a duplicate." (c) `resolve()` distinguishes three failure modes with three different errors — a malformed key, an absent package, and a registered package that contributes no schema under that name. (d) `toJSONSchema` returns "a fresh JSON Schema document" per call — the projection is deliberately **not** cached, and the README says the consumer owns caching. (e) The **duplicate-registration trap** is called out: "`$mount(contribution)` already performs that registration, so registering and mounting the same contribution in the same registry duplicates it and fails."
- Edge cases / failure handling: a lookup provider whose wire declaration changes during the registry lifetime is refused ("changed its wire declaration during this registry lifetime"); the `global` resource kind is reserved and a second registration of a kind throws.
- Surprising: `ctx.typert.local.hasSeen(endpoint)` reports whether a strict definition has existed *during this Typert Service lifetime*, even if withdrawn — the registry remembers history so a consumer cannot silently fall back to a weaker mode.

### packages/typert/registry/README.zh.md
- Purpose: Chinese translation of the registry README.
- Key abstractions: the same five sub-registries and the same query API.
- Data flow: paired through `README.i18n.yaml`.
- Non-obvious design decisions: it preserves the "注册是原子且按 fiber 作用域的" (registration is atomic and fiber-scoped) rule and the "首次读取会物化一个进程 realm 内的 schema 实例" (the first read materialises one process-realm schema instance) detail.
- Edge cases / failure handling: none in-file.
- Surprising: the Chinese page spells out the three distinct `resolve()` errors exactly as the English page does.

### packages/typert/registry/src/client/index.ts
- Purpose: the browser face of the registry — 15 lines.
- Key abstractions: `inject: string[] = []` and `apply(ctx)`.
- Data flow: the client runtime calls `apply` → `new TypertRegistry(ctx)` → `ctx.typert` is available in the browser.
- Non-obvious design decisions: the browser face installs the **same implementation** as the Host face — "Both bundles use the same registry implementation, separate from the Host package root." The only difference is the entry point, which is why `src/index.ts` re-exports the service and `src/client/index.ts` merely constructs it.
- Edge cases / failure handling: `inject: []` — the registry requires no other service, so it can be installed first in a browser composition.
- Surprising: this 15-line file is the *entire* browser entry; there is no browser-specific logic at all, which is what makes the two bundles provably equivalent.

### packages/typert/registry/src/index.ts
- Purpose: the Host entry — the service export plus the `TypertRegistryContract` augmentation.
- Key abstractions: re-exports `TypertRegistry`, `typertEndpoint`, `typertKey`, `typertPackageKey`; declares the schema/reflection query methods onto `TypertRegistryContract`.
- Data flow: a consumer imports from `@deepseek-ai/dsh-typert-registry` and gets both the class and the contract's type.
- Non-obvious design decisions: the **contract is augmented from the implementation's own package** — the registry declares `register`/`get`/`resolve`/`list`/`getPackage`/`listPackages`/`toJSONSchema` onto the protocol's `TypertRegistryContract` interface, so the protocol stays free of any registry dependency and the registry owns its own methods. `export type * from './types.ts'` publishes the contribution and record types.
- Edge cases / failure handling: none in-file.
- Surprising: `typertKey`, `typertPackageKey` and `typertEndpoint` are exported from the *service* module (where they are defined) rather than from a constants module — the key grammar is public API.

### packages/typert/registry/src/service.ts
- Purpose: the registry implementation — 805 lines of stores, validation and effect wiring.
- Key abstractions: `TypertRegistry` (the service), `DescriptorStore`, `RemoteStore`, `LookupStore`, `ContextStore`, `ResourceStore`, `ChangeSource`, and the key helpers `typertKey` / `typertPackageKey` / `typertEndpoint`.
- Data flow: `register(contribution)` → `validatePackage` → `validateSchemas` → `localStore.validate(invocations)` → **one** `ctx.effect(...)` that commits the package record, the schemas and the descriptors, and whose disposer withdraws exactly those.
- Non-obvious design decisions: (a) **Validation happens before any state changes** — "Duplicate package-face identities, schema keys, invocation ids, or endpoints reject the whole batch before anything is committed." (b) **The withdrawal is owner-checked**: `withdraw` only removes an entry whose `owner` matches, and the ids map is only cleared if it still points at that entry — so a stale disposer cannot withdraw a newer registration. (c) **A change listener that throws is contained**: `ChangeSource.emit` wraps each listener in a `try` and reports the failure through `ctx.logger.warn`, so one bad observer cannot stop the others. (d) `hasSeen` is a **history set**, separate from the live map, so a withdrawn endpoint is still "seen". (e) `validateInvocation` is exhaustive over the descriptor's fields — a lookup parameter may not `acceptsUndefined`, a JSON parameter may not declare a `lookup`, a scope must select its *only* lookup parameter, a Context receiver may not declare a direct scope, and the cancellation parameter must be exactly `'signal'`.
- Edge cases / failure handling: `resolve()` produces three distinct errors for three distinct failures; `toJSONSchema` is uncached by design; `get` returns `undefined` while `resolve` throws — the two are different contracts for the same key.
- Surprising: the `LookupStore.get` method **rebuilds a provider object** when a configured resolver overrides the default, copying the declaration fields and swapping only `resolve` — so the wire declaration stays provider-owned even under a composition override. The same pattern is repeated for the Host Context adapter, and the `resource` kind survives the override.

### packages/typert/registry/src/types.ts
- Purpose: the registry's own types — contribution, record and filter shapes.
- Key abstractions: `TypertFace` (`'host' | 'client'`), `TypertContribution`, `TypertSchemaFactory`, `TypertSchemaRecord`, `TypertPackageRecord`, `TypertPackageModel`, `TypertServiceModel`, `TypertEventModel`, `TypertObjectModel`, `TypertMemberModel`, `TypertTypeModel`, `TypertDocumentation`, `TypertDocTag`, and the two filters.
- Data flow: the generated artifact's shape → the registry's stored shape.
- Non-obvious design decisions: (a) The registry stores **Zod schemas separately from the reflection metadata** — the file's header says so explicitly, and `TypertContribution` carries `schemas`, `model` and `invocations` as three independent lists. (b) `TypertSchemaFactory.create` is a *factory* (`() => z.ZodType`), and the record's `schema` is the materialised instance — so the schema is built on first read, not at registration. (c) The reflection model keeps a `TypertMemberModel` with a `kind` and a *rendered* `signature` string, so a consumer can show a member without re-rendering the type graph.
- Edge cases / failure handling: none in-file; the validation lives in `service.ts`.
- Surprising: `TypertContribution.invocations` is documented as "empty when the package exports no Remote methods" — a package that publishes reflection but no Remote calls still registers cleanly.

### packages/typert/registry/tests/typert.spec.ts
- Purpose: the registry's suite — 740 lines over registration, withdrawal, validation and the five sub-registries.
- Key abstractions: `toolsContribution()` (a fixture contribution with a service, an event and a schema), `invocation()` / `scopedInvocation()` descriptor builders, and the test-only merges for `TypertLookupMap` / `TypertContextMap` / `TypertResourceMap`.
- Data flow: `ctx.typert.register(...)` → the registry's stores → queries and `subscribe` notifications.
- Non-obvious design decisions: (a) The test asserts that the **same descriptor object** is indexed by both `ctx.typert.local` and `ctx.typert.remotes` (`expect(method).toBe(descriptor)`) — no copying, no re-wrapping. (b) It asserts the withdrawal is **exact**: after `owner.dispose()`, both registries are empty *and* `hasSeen` is still `true`. (c) A subscription-disposal test proves that disposing a subscription stops the notifications but does **not** change the registry. (d) The "validates every invocation and provider boundary" case enumerates fifteen malformed descriptors, each with the exact error fragment it must produce.
- Edge cases / failure handling: a throwing change listener is contained and logged ("contains change-listener failures and still notifies later listeners") — the second listener still runs and a warning is recorded. The `global` resource kind is reserved. A lookup's `resource` kind survives a configured resolver.
- Surprising: the test installs the registry through the **Client entry** (`inject: clientRegistryInject, apply: applyClientRegistry`) in a separate case, to prove the browser face does not import the Host entry.

### packages/typert/registry/tsconfig.json
- Purpose: the registry package's TypeScript project config.
- Key abstractions: extends the workspace base; `rootDir: src`, `outDir: lib/types`.
- Data flow: `tsc -b` produces the declarations for both the Host and client entries.
- Non-obvious design decisions: the references are `vendor/cosmokit`, `vendor/cordis` and `../protocol` — the protocol is referenced as a *project* so the merge-extensible interfaces (`TypertLookupMap` etc.) are in the same program, which is what makes the registry's `declare module` augmentations type-check.
- Edge cases / failure handling: `include` is only `src`.
- Surprising: the client entry is inside `src/client/`, so it is part of the same project — the two bundles differ only in the bundler entry, not in the type graph.

### packages/typert/registry/tsdown.config.ts
- Purpose: the registry's bundler config — 3 lines.
- Key abstractions: `clientBundle(import.meta.dirname, ['lib/types/index.js'], { dualClient: true })`.
- Data flow: tsdown builds the Host bundle, the Node client bundle and the browser client bundle from one source tree.
- Non-obvious design decisions: `dualClient: true` is what produces *both* `lib/client.node.js` and `lib/client.browser.js` from the same `src/client/index.ts`; the second argument names the type entry that must be preserved.
- Edge cases / failure handling: none in-file.
- Surprising: the whole browser/Node split is three lines of config plus a 15-line source file — the "same implementation, two hosts" property is structural, not maintained by hand.

---

## Ideas worth stealing

- **Commit a contribution atomically, and let the disposer withdraw exactly that contribution** — `packages/typert/registry/src/service.ts:563` — `register()` validates the package-face identity, the schemas and the invocation descriptors *before* touching any state, then commits all three under a single `ctx.effect(...)` whose disposer removes exactly what it added; the withdrawal is owner-checked so a stale disposer cannot remove a newer registration. **Why it transfers to August:** August's brain-config, skills and provider registries all have the same shape (validate → commit → withdraw), and the failure this prevents — a half-applied batch, or a disposer that removes somebody else's entry — is exactly the "one flag with no writable-set entry" class of bug the workspace AGENTS.md already records. The owner-check on withdrawal is the part worth copying: a disposer that only knows *what* it registered is not enough; it must know *that it* registered it.

- **Make the analysis result independent of whether compilation has already run** — `packages/typert/generator/src/analyzer.ts:3412` — `rejectBuildOutputLoads` detects both a face program that loads a workspace package's `lib/` output and a workspace import that resolves to nothing, then emits one message naming the exact `compilerOptions.paths` alias to add. **Why it transfers to August:** any August feature that reads generated artifacts (tool schemas, provider manifests, the tool catalog) is vulnerable to a build-order-dependent result — the same input yields different bytes depending on whether `tsc -b` ran. The generalisable rule is the one the module's header states: *an import that reaches `lib/` on a compiled tree resolves to nothing on a clean one, and both are rejected*. A build-order-dependent answer is a bug, not a nuisance, and the diagnostic should name the fix.

- **Decide the analysis/emission boundary once, and enforce it with a type the emitter cannot cross** — `packages/typert/generator/src/analyzer.ts:4` — "Programs, symbols, and syntax nodes remain extraction-only implementation details; callers receive only the model declared in `./model.ts`"; the emitter's own header repeats the promise, and the model has an exhaustive `assertNever` for unknown node kinds. **Why it transfers to August:** the same separation is what a *tool-schema projection* needs — whatever produces the tool's JSON Schema must not be the thing that executes the tool, or the schema inherits the executor's bugs. The `assertNever` variant is the part to copy: a new construct added to the model must be classified or the build stops, so the "supported subset" cannot drift.

- **Fail the *whole* operation when one projection is unrepresentable — report the absence, never a weaker schema** — `packages/typert/generator/src/tool-schema.ts:26` — a type the tool-schema subset cannot express without weakening constraints raises `ToolSchemaError`, and the emitter converts that into a `jsonSchemaError` string next to a still-working parser, rather than emitting a schema with the constraint dropped. **Why it transfers to August:** a tool whose JSON Schema silently drops a constraint turns "the model must send `strict: true`" into "the model may send anything" — a security-relevant loosening that no test would notice. The emitter's separate ordinary and *closed* (`additionalProperties: false`) schema sets for the same type are the same idea applied to input strictness: one type, two policies, both generated from one source of truth.

- **Validate a boundary *before* projecting it, not after** — `packages/typert/generator/src/analyzer.ts:1864` — `assertRemoteJsonType` walks the resolved type and refuses `any`/`unknown`, bigint, symbol, class instances, callables, symbol-keyed properties and symbol index signatures before any code is generated. **Why it transfers to August:** the same check is what a tool-argument boundary needs before the argument reaches an executor. The generator's rule — *the boundary is validated first; only then is it projected* — is the one to copy, because the reverse order produces a schema for something that will be rejected at runtime.

- **Make the "you forgot to name it" case impossible to miss** — `packages/typert/protocol/src/index.ts:164` — the `resources` option's own doc says it in one sentence: "they must name every resource the method accesses, because access control never checks one they omit." **Why it transfers to August:** this is the fail-open shape the workspace AGENTS.md keeps rediscovering (a tool-boundary guard that a *named* exemption defeats; a memory gate a model cannot satisfy; a key with a `fieldTable` entry but no writable-set entry). The protocol's design does not pretend to close it — it states the rule in the type's documentation, names the omission as the dangerous case, and pairs it with the Gate's own "access control never checks one they omit" symmetry. August's equivalent is a *closed* default with an explicitly declared exemption, not an open default with an implied one.

- **Identify a failure structurally, never by `instanceof`** — `packages/typert/protocol/src/remote-error.ts:40` — `remoteErrorOf` reads a structural marker plus a string `code`, because "an Error thrown in another realm (iframe, VM) fails `instanceof Error` here". **Why it transfers to August:** the harness runs the model in one realm, the tools in another, and the browser in a third; a failure that crossed a boundary would be invisible to an `instanceof` check and would be swallowed as a generic error. The marker-plus-payload shape (`isDSHRemoteError: true` **and** a string `code`) is the minimum that is both recognisable and hard to fake accidentally.

- **Keep the *published* entry free of the runtime the generated code needs** — `packages/typert/protocol/src/remote-info.ts:41` — the factory's index, parsers and projections are each built and cached on first access, and the published `lib/` is asserted by regex to contain no `zod` import at all. **Why it transfers to August:** August's prompt/tool layer is assembled in one process and consumed in another (renderer, host, worker). A module that pulls its heavy runtime in at import time pays that cost on every consumer, whether or not the consumer needs it; the lazy index plus the "no zod in the published entry" gate is the pattern to copy for anything the renderer must not carry.

- **Settle a background task exactly once, and never let a settlement path mint a second rejection** — `packages/typert/loader/src/index.ts:451` — "Two-armed settle: a bare `.finally()` would mint a second, unhandled rejection", and the whole worker path in `packages/typert/generator/src/tsdown-plugin.ts:150` makes failures *values* so an unclaimed generation can never produce an unhandled rejection. **Why it transfers to August:** August's subagent and background-job paths have exactly this shape (a promise that may settle after its owner is gone). The two rules together — one settlement, and failures carried as values — are what keep a detached task from taking the process down.

- **Measure each record once, and refuse rather than truncate** — `packages/telemetry/otel/src/session-log.ts:102` — the Session queue serialises each record individually to learn its byte cost (never the candidate batch), rejects an oversized record with "content was not truncated", and bounds the request at 4,000,000 uncompressed bytes. **Why it transfers to August:** August's transcript and context payloads have the same two failure modes — a payload that is too big (which must be refused, not silently shortened, because a truncated tool result is a wrong tool result) and a queue that must be bounded. The "measure once, never the batch" rule is also the perf rule: the obvious implementation (serialise the whole candidate batch to size it) is O(n²) in the queue length.

- **Give a watchdog a warning and nothing else** — `packages/telemetry/otel/src/session-log.ts:150` — the export watchdog only *warns* ("waiting for transport settlement") and deliberately does not release the transport slot, and the drain loop waits for the SDK's own concurrency queue to clear after every batch. **Why it transfers to August:** a timeout that releases a slot the operation still holds lets a second operation start on a resource the first still owns. The generator's twin rule is in the same file's neighbourhood: the Session processor's `drain()` awaits `exporter.forceFlush()` "The export callback precedes removal from the SDK concurrency queue" — the ordering is the contract, not an optimisation.

- **Make the byte ceiling a build-time check on the *output*, not a runtime hope** — `packages/typert/generator/src/workspace.ts:132` — `validateExport` refuses to let a package publish an artifact whose `package.json` export or `files` entry does not name the exact generated file, and refuses the inverse (publishing `./remote` with no Remote methods). **Why it transfers to August:** August's own static gates (`check:brain-config`, `check:sse`) work the same way — ask the *other side* what it accepts and fail the build when the two sides disagree. The transferable part is the *inverse* check: verifying that the thing you did not publish is also not published.

- **Aggregate violations instead of failing fast, and make the aggregate a single error** — `packages/typert/generator/src/cordis-catalog.ts:49` — every unclassified type name in every signature is collected and reported as one error listing all of them, and the JSDoc gate does the same. **Why it transfers to August:** a gate that stops at the first violation makes a 400-file fix a 400-run loop. The generator's catalog test then proves the aggregate is complete by re-running the projection and comparing byte-for-byte with the committed artifacts — the gate and the artifact cannot drift.

- **Register the thing a consumer will actually meet, and pick before validating** — `packages/typert/generator/src/cordis-catalog.ts:252` — when a `ctx.<key>` is described by two declarations (a merge-extensible interface in one package and the implementing class in another), the **class** wins, and the pick happens *before* validation "so a discarded candidate's missing JSDoc from failing the gate" cannot fail the gate. **Why it transfers to August:** August's own docs and the AGENTS.md both had to learn this shape (the `ctx.typert` key is described by two packages). The rule generalises: when two sources describe one thing, choose the one the *caller* meets, and choose it before you start complaining about the other.

- **Do not let a key that is not a service be described as one** — `packages/typert/generator/src/analyzer.ts:1018` — an optional Context key (`X | undefined` or `key?: X`) is skipped, because it is "a value the launcher or boot code installs before the tree mounts … which no plugin provides", and describing one as a service "would answer 'add the plugin that provides it' for a key where no such plugin exists." **Why it transfers to August:** this is a *diagnosability* rule. A catalog that lists a key nobody provides sends the reader chasing a plugin that cannot exist. August's agent/tool surfaces have the same hazard (an optional injected dependency presented as an available capability), and the fix is to distinguish "a service a plugin provides" from "a value the host installs".

---

## Files skipped (with reasons)

- `packages/typert/generator/tests/__snapshots__/type-model.spec.ts.snap` — a 229 KB Vitest snapshot (6,492 lines) of the emitter's generated JavaScript for the `FaceModelEmitter` case. I opened the header and the first snapshot entry to confirm exactly what it is (a machine-generated snapshot of emitter output, beginning with the `let Payload$schema$value` caching pattern), and then did not read it line by line: it is generated data whose every line is emitter output already covered by `src/emitter.ts`.
- `packages/typert/generator/tests/.generated-model-O7FJNT/host.mjs` — a 310-line **generated** artifact left behind by an earlier test run (a `@fixture/host` host-face `typert.host.js`). I opened its first 40 lines to identify it and found it *stale* (its `schemas` entry uses `schema:` where the current emitter emits `create:`). It is not read line by line because it is generated output, not source, and nothing in the tree consumes it.
- `packages/typert/generator/tests/.generated-model-qwn8sk/host.mjs` — a second, byte-identical-in-its-opening copy of the same generated artifact from another test run. I opened its first 15 lines to confirm it is the same generated file; not read line by line for the same reason (generated output, and debris in the tree).

No other file in this shard was skipped. The four large generator spec files (`type-model.spec.ts` 1,733 lines, `remote-model.spec.ts` 1,189, `remote-metadata.spec.ts` 970, `schema-emitter.spec.ts` 974) were opened and read in their header, helper and case-title structure, with the full case inventory read via grep; their per-case assertions are summarised in their notes above but were not read line by line.

---

## Uncertainties

- **`packages/typert/generator/tests/cordis-catalog-contract.spec.ts` is entirely disabled.** Both `describe` blocks use `describe.skip` (lines 127 and 242), so the twenty-plus negative-path contracts it documents — the `@mode`/signature contradictions, the missing-`@param` and stale-`@param` checks, the binding-pattern refusal, the multi-violation aggregation — are **not enforced** by the current test run. I verified this by reading the file directly (both `describe.skip` calls are visible in the source); I did not run the suite, so I cannot say whether they pass. This is worth the lead's attention: the catalog's JSDoc gate looks covered by grep but is not.
- **The two `.generated-model-*` directories in `packages/typert/generator/tests/` are stale generated artifacts committed to the tree.** They predate the emitter's `create()`-factory change, and the workspace `AGENTS.md` explicitly says "The repo carries no `_*.py` / `*.txt` scratch artifacts on purpose" — by the same rule, these two directories are debris. I did not check whether anything references them, and I did not remove them (the clone is read-only). I report it rather than acting.
- **The `analyzer.ts` ↔ `protocol` duplication of the endpoint-segment grammar is intentional but fragile.** `packages/typert/generator/src/analyzer.ts` carries its own `isRemoteSegment` with a comment saying it must mirror `isTypertRemoteSegment()` because "Generation bootstraps workspace artifacts before dsh-typert-protocol is built". There is no test in this shard that asserts the two stay in sync — the parity would have to be checked by the two packages' own suites. I did not search the whole repository for such a check.
- **`packages/telemetry/otel` claims "the Session adapter" owns the byte limits, single-record rejection and serial transport settlement, but that adapter (`packages/session/session-telemetry-otel/`) is outside this shard.** The shard's copy of the contract is the `session-log.ts` implementation and its two spec files; I verified the implementation against the README's claims, but I could not verify the *adapter*'s side (the feedback-authorisation gate that decides whether a session is uploaded at all).
- **The `dsh-api-remote-access` and `api/gateway` packages that actually *enforce* the protocol's resource and principal rules are outside this shard.** I read the protocol's own declarations and the `RemoteAccessResource` type, and the `built-runtime.e2e.ts` test exercises the built `RemoteAccess` plugin from a child process — but the decision logic itself (what a `test-guest` may do) is not in this shard, so the resource model's *enforcement* is characterised from the declarations, not observed.
- **The generator's "analysis and emission" boundary is asserted by its own architecture, not by an independent gate.** I verified that `src/emitter.ts` imports only from `./model.ts` and `./renderer.ts` (and never `typescript`), and that `src/renderer.ts` likewise imports only the model — but there is no lint rule in this shard that *prevents* an emitter from importing `typescript` in future. The `assertNever` exhaustiveness checks in `model.ts` and `renderer.ts` are the closest thing to a gate.
- **`packages/typert/generator/tests/remote-metadata.spec.ts` and `remote-model.spec.ts` were read in their headers, helpers and case titles rather than end to end.** The case inventory I read (27 and 24 `it`/`it.each` titles) is complete, but I did not verify each assertion individually; the summaries in their notes are derived from the titles and from the source they exercise, not from a line-by-line read of the assertions.
- **The manifest's `size` column and the line counts disagree for the largest files** (e.g. `analyzer.ts` is 151,688 bytes but 3,468 lines, while the manifest's implied reading differs). I used the `read` tool's own totals, which are authoritative for the files, and the manifest only for the file list and the owner-shard column. I did not modify the manifest.
- **No prior `dsh-platform#2.md` or `dsh-platform#2.rows.tsv` existed when this pass started.** The only artefact for this shard was a helper list (`shards/.dsh-platform2.list`) left by an earlier pass; I read it, confirmed it matched the manifest's `dsh-platform#2` rows exactly, and did not modify it. The stale helper is itself scratch debris in the output directory, and I did not delete it because the instructions restricted me to my two output files.
