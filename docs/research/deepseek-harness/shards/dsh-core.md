# deepseek-harness / dsh-core

## Shard shape

This shard is the **product API spine** of `deepseek-harness`: the eight packages under `packages/core/` that every composition depends on, and nothing else. `scope/` is the isolation primitive (a tagged Cordis sub-context plus an event-routing carrier); `session/` is the append-only, event-sourced log every conversation is derived from; `system-prompt/` assembles the ordered prompt from registered sections, variables and tool schemas; `tools/` is the registry and the six-stage execution pipeline; `agent/` owns the public `Agent` handle, its registry and the `agent/*` event vocabulary; `agent-loop/` is the one concrete driver that turns those contracts into a running turn/step machine; `agent-default-model/` and `agent-tool-presentation/` are two small deployment-level selectors. They fit together in one direction: **every model-visible fact is a session event, and every request is a pure function of the session log** — the loop reads the log, appends to it, and derives the next request from it; the tools registry and prompt assembler are inputs the log records as headers. The shard is 175 files, 2.36 MB, of which ~70 % is test code; 12 of the 175 are English/Chinese README pairs whose consistency is pinned by hash.

## Per-file notes

### packages/core/README.md
- Purpose: Group map for the eight core packages, listing each package's role and its `ctx` key.
- Key abstractions: `ctx.sessions`, `ctx.systemPrompt`, `ctx.tools`, `ctx.agents`, `ctx.agentLoop`, `ctx.agentDefaultModel`; `scope` is library-only.
- Data flow: Declares that `agent` owns the public contract while `agent-loop` is the swappable default implementation, so extension plugins depend on `agent` only.
- Non-obvious design decisions: The package group explicitly refuses to contain runnable compositions — those live in `packages/bundle`.
- Edge cases / failure handling: n/a (docs).
- Surprising: The "spine vs bundle" split is stated as a rule, not a convenience.

### packages/core/README.zh.md
- Purpose: Chinese translation of the core group map.
- Key abstractions: Same package/ctx-key table, translated.
- Data flow: n/a.
- Non-obvious design decisions: Paired by hash with the English file (see `packages/core/README.i18n.yaml`).
- Edge cases / failure handling: n/a.
- Surprising: The whole repo ships a bilingual README set with a per-heading hash record.

### packages/core/README.i18n.yaml
- Purpose: Per-heading-section hash record of the English and Chinese README blocks.
- Key abstractions: `en:`/`zh:` hash pairs keyed by heading path (`/packages-core/summary`).
- Data flow: `pnpm run verify-translation-pairing --write <file>` regenerates it; a mismatch means one side was edited alone.
- Non-obvious design decisions: Hashes are taken *outside code blocks and generated regions*, so a code sample may legitimately drift.
- Edge cases / failure handling: The gate is what makes a missing translation a hard error.
- Surprising: Translation drift is a *static, testable* property in this repo.

### packages/core/session/README.md
- Purpose: Package reference for the event-sourced session log.
- Key abstractions: `Session`, `SessionStore`, the *surface* (the ordered model-visible projection of the log), `surfaceOp` (`append` / `replace`), `EpochHeader`, `SessionFormatVersion = 4`.
- Data flow: `append()` → frozen event → `SurfaceManager` folds it into the ordered surface → `deriveMessages()` projects surface nodes into `Message[]`; `request/header` events fold into the current `EpochHeader`; `tool/result` + `developer/message` fold into `ToolHistory`.
- Non-obvious design decisions: The **surface is the sole source of derived history** — an event without a `surfaceOp` marker is deliberately absent from the model's view, and a `replace` operation *shadows* nodes from derived history without deleting their log records. The system prompt is surface node 0, and node 0 is protected: only a `system/message` over exactly that node may rewrite it.
- Edge cases / failure handling: Append rejects non-lossless-JSON payloads, sparse arrays, exotic prototypes, `-0`, cycles; a `replace` must cite every shadowed node in `sourceEventSeqs`; unknown event types require the `ignorable` marker or the reader refuses the log.
- Surprising: The README's "Model Experience" section states the KV-cache consequence explicitly — an append preserves the reusable prefix, a `replace` invalidates reuse from the first shadowed message.

### packages/core/session/README.zh.md
- Purpose: Chinese translation of the session package reference.
- Key abstractions: Same surface/header vocabulary, translated.
- Data flow: n/a.
- Non-obvious design decisions: Hash-paired with the English file.
- Edge cases / failure handling: n/a.
- Surprising: The translation preserves the technical vocabulary verbatim (`surfaceOp`, `sourceEventSeqs`).

### packages/core/session/README.i18n.yaml
- Purpose: Heading-section hash record for the session README pair.
- Key abstractions: One hash pair per heading path.
- Data flow: Regenerated by `verify-translation-pairing --write`.
- Non-obvious design decisions: The `/deepseek-ai-dsh-session/model-experience/kv-cache-effect` entry exists — cache effects are treated as a first-class documented section.
- Edge cases / failure handling: n/a.
- Surprising: Every package README has a `Model Experience` section with "What the model sees / Token effect / KV Cache effect" — a template that makes prompt/token/cache cost a reviewable artifact.

### packages/core/session/locale/en.json
- Purpose: English UI locale string for the session package.
- Key abstractions: `meta.title`.
- Data flow: n/a.
- Non-obvious design decisions: Two keys only — `title` and an optional `description`.
- Edge cases / failure handling: n/a.
- Surprising: `scope` has no locale directory at all, so locales are not uniform across packages.

### packages/core/session/locale/zh.json
- Purpose: Chinese UI locale for the session package.
- Key abstractions: `meta.title = "会话记录"`, `meta.description`.
- Data flow: n/a.
- Non-obvious design decisions: The English file omits `description`, the Chinese one has it — the schema allows an absent field.
- Edge cases / failure handling: n/a.
- Surprising: Locale files are per-package, not centralised.

### packages/core/session/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-session` v0.2.1-rc.2.
- Key abstractions: Four subpath exports — `.`, `./types`, `./fork`, `./surface` (plus `./src/*` for in-repo imports and `./locale/*.json`).
- Data flow: `peerDependencies` on `dsh-scope` and `cordis`; runtime `dependencies` on `dsh-llm`, `dsh-brand`, `dsh-util-values`.
- Non-obvious design decisions: The `"./surface"` export exists because **web clients consume the surface subpath and it must stay free of `node:` imports** — a browser-safety constraint expressed as a package export boundary.
- Edge cases / failure handling: `types` is `lib/types/types.d.ts` while the runtime entry is `lib/index.js` — the type build is separate from the bundle.
- Surprising: `exports` includes `"./src/*": "./src/*"`, so tests can import source directly.

### packages/core/session/tsconfig.json
- Purpose: TypeScript project config for the session package.
- Key abstractions: `rootDir: src`, `outDir: lib/types`, project references.
- Data flow: References `dsh-brand`, `dsh-util-values`, `dsh-llm`, `dsh-scope`, `dsh-typert-protocol`.
- Non-obvious design decisions: The package emits **types only** (`lib/types`), and the runtime bundle is produced separately by `tsdown`.
- Edge cases / failure handling: `include: ["src"]` — tests are not type-checked through this project.
- Surprising: Two build systems (tsc for declarations, tsdown for the ESM bundle) for one package.

### packages/core/session/tsdown.config.ts
- Purpose: Bundler config for the session package.
- Key abstractions: One entry (`lib/types/index.js` → `lib`), `format: esm`, `target: es2024`.
- Data flow: Bundles the tsc-emitted JS into a self-contained ESM file.
- Non-obvious design decisions: `dts: false` and `clean: false` — declarations come from tsc and the bundler must not wipe them.
- Edge cases / failure handling: n/a.
- Surprising: Byte-identical to the same file in the agent, agent-loop, scope and agent-default-model packages.

### packages/core/session/src/index.ts
- Purpose: The `Session` class and the `SessionStore` service — the append-only log plus its in-memory registry.
- Key abstractions: `Session` (plain class, not a Service), `SessionStore extends Service`, `SessionEvent` discriminated union, `SessionId`/`SessionSeq`/`SessionLogOffset` branded numbers, `PluginRecordMap`.
- Data flow: `append(type, data, opts)` → `snapshotJsonValue` → `deepFreeze` → `validateSessionEventData` → `SurfaceManager.validateNext` → `commit` (push to log, then notify `session/event` observers with per-listener containment). `deriveMessages()` projects the surface incrementally, cached by `contentGeneration`.
- Non-obvious design decisions: The store's publication is split into `prepare()` / `enter()` / `announce()` so a throwing `session/created` listener rolls the attach back instead of leaking it; the `session/event` feed is *post-commit and fire-and-forget* (observer failures are logged, never veto), while `session/created` is *vetoing*; `session/flush` is the single awaited durability barrier. `eventAt`/`snapshotEvents`/`ownEvents` are marked `@deprecated` with new production calls prohibited.
- Edge cases / failure handling: A reentrant append during publication throws ("session append cannot reenter while another append is being published"); a detach requested mid-dispatch is deferred until the dispatch unwinds; `enter()` re-checks the id so a stale prepared session cannot overwrite a live same-id entry.
- Surprising: `Session.append` requires a `surfaceOp` marker **at compile time** via a conditional rest parameter, with a runtime guard for the union-widening loophole.

### packages/core/session/src/types.ts
- Purpose: The durable event vocabulary: `SessionEventMap`, `SessionHeader`, `SurfaceOp`, `TurnEndReasonMap`.
- Key abstractions: `SESSION_FORMAT_VERSION = 4`; `SessionEventMap` with `turn/start|end`, `step/start|end`, `user|developer|system|assistant/message`, `assistant/attempt`, `tool/call`, `tool/result`, `request/header`, `request/context`, `session/end-seed`.
- Data flow: Every event type carries its payload; `assistant/message` embeds the exact timed `stream` plus optional `usage`; `tool/result` carries optional `error` identity and opaque `meta`.
- Non-obvious design decisions: The version is a **single monotonic integer with no major/minor split**, bumped only when an existing discriminator cannot prevent unsafe interpretation — a structural difference alone is insufficient. `SessionEvent.ignorable` defaults to *required*: a forgotten marker over-refuses (an inconvenience) rather than silently resuming a gutted session. `origin` may only be `'subagent'`.
- Edge cases / failure handling: `delegationDepth` is persisted "so a recursion budget survives restart and resume — a runtime-only depth would reset a resumed child to top-level".
- Surprising: `assistant/attempt` exists as a *separate* event type precisely so a failed/retried/cancelled attempt can be preserved without fabricating model-visible history.

### packages/core/session/src/surface.ts
- Purpose: The ordered surface layer — the model-visible projection of the log.
- Key abstractions: `SurfaceManager`, `SurfaceOp`, `SurfaceFoldResult`, `SessionMessageProjection`, `foldSurface()`.
- Data flow: `planSurfaceEvent` validates one candidate against the current fold state and returns a *plan*; `applySurfacePlan` commits it atomically. `SurfaceManager` keeps a delta cursor so a per-step read costs O(new events) and only rebuilds on a replacement or a plugin projection.
- Non-obvious design decisions: Planning before mutation is explicit: "The candidate is planned before it enters `log`, so a failure cannot partially mutate the surface." A replacement must cite *every* shadowed node in `sourceEventSeqs`; a `tool/result` replacement may change **only** content (compared with a structural JSON deep-equal that blanks `content`); node 0 is protected by `assertSystemHeadRewrite`. `isAppendSurfaceEvent` vs `isReplacementSurfaceEvent` exist because "the model-visible surface deliberately shadows replaced ranges, so it is the wrong source for a human transcript".
- Edge cases / failure handling: Unknown *ignorable* events keep opaque metadata and never change the surface; a missing message projection rejects the append; a projection removed after use invalidates cached reads ("was removed or replaced; restore the session with its owning plugin").
- Surprising: The file is explicitly **browser-safe** — it replaces `node:util`'s `isDeepStrictEqual` with a hand-written JSON deep-equal specifically to keep `node:` imports out of the vite bundle.

### packages/core/session/src/repair.ts
- Purpose: Shared tool-result recovery for failed live steps, interrupted logs and fork seeds.
- Key abstractions: `ToolCallRecovery`, `openTurnClosers(events, cause)`, `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`, `OpenTurnCloseCause = 'interrupted' | 'forked'`.
- Data flow: `observe()` tracks unanswered assistant tool requests from committed events; `results()` emits synthetic `tool/result` events in assistant order, citing the `tool/call` seq when there was one; `openTurnClosers` then appends `step/end` and a cause-specific `turn/end`.
- Non-obvious design decisions: The two codes state *the same fact about the call's recorded lifecycle* regardless of cause, but the **wording differs by cause** — a fork result tells the model "the parent session may have completed it after the fork point". The interrupted wording is deliberately cautious: "retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly."
- Edge cases / failure handling: A closed step discards pending requests; a `tool/result` only clears a pending call when the surface op was `append` and turn/step match; timestamps reuse the last real event so no "future" time is invented.
- Surprising: This is the single place where the *model* is told to distrust a side effect — the harness refuses to guess and hands the uncertainty to the model with instructions.

### packages/core/session/src/fork.ts
- Purpose: Fork-seed construction over an exact source-event prefix.
- Key abstractions: `buildForkSeed(events, boundary)`.
- Data flow: copies `events[0..boundary]`, pushes a `session/end-seed { inherited: true }` marker, then concatenates `openTurnClosers(prefix, { kind: 'forked' })`.
- Non-obvious design decisions: The synthetic closers are **outside the inherited prefix** — `inheritedEventCount` counts only copied source events, so the child's own closers are visibly child-owned.
- Edge cases / failure handling: Closed steps and turns are preserved unchanged, including historical missing results.
- Surprising: The fork's synthetic `turn/end` uses a dedicated reason kind (`forked`) that the live loop never emits.

### packages/core/session/src/request-header.ts
- Purpose: Request-header canonicalisation, equality and folding.
- Key abstractions: `canonicalHeader`, `headerEquals`, `foldRequestHeader(events, from?)`, `EpochHeader`.
- Data flow: `request/header` events carry a full canonical snapshot; the fold takes the latest; the loop uses `headerEquals` to decide whether to log a new one.
- Non-obvious design decisions: Canonical form **omits** empty optional fields (`tools: []`, `adapterDefaults: {}`) so one representation serves logging, folding and comparison; `system` is typed `never` because the prompt lives in a `system/message` surface node, not in the header.
- Edge cases / failure handling: Tool schemas compare in order (a reordered tool list is a changed header).
- Surprising: "Logging causes no invalidation, and exact reconstruction preserves request-prefix identity" — the header is stored full, not as a diff, at the cost of growth per message series.

### packages/core/session/src/tool-history.ts
- Purpose: Capability-independent fold of historical tool definitions for request projection.
- Key abstractions: `ToolHistoryProjection`, `ToolHistory { tools, updates }`.
- Data flow: `request/header` events index their tool schemas by seq; `developer/message` events with a `headerSeq` resolve their `tool-addition` blocks against that historical header and append to `updates`.
- Non-obvious design decisions: "A retained name cannot acquire a different definition without losing prefix reuse" — a *redeclaration* of a name with a changed definition restarts the declaration series, while an unchanged restoration continues it and the recorded addition re-offers the tool.
- Edge cases / failure handling: If the active header does not match the folded availability set (a session written before tool-update emission), the projection falls back to the complete active declarations.
- Surprising: Tool *removal* is preserved in the update list rather than deleted, so a replay reconstructs the exact sequence of add/remove events.

### packages/core/session/src/seq-ranges.ts
- Purpose: Lossless range encoding for `sourceEventSeqs` arrays in JSONL.
- Key abstractions: `encodeSeqRanges`, `decodeSeqRanges`, `EncodedSeq = number | [number, number]`.
- Data flow: runs of three or more consecutive seqs become an inclusive pair; decoding expands them back.
- Non-obvious design decisions: Only *profitable* runs are encoded (a pair must span ≥3 values), and a non-increasing input is passed through unchanged rather than being normalised — the encoder never reorders what the caller asserted.
- Edge cases / failure handling: `decodeSeqRanges` rejects malformed pairs, `start > end`, and mixed range/scalar forms that are not strictly increasing; `maxEntries` bounds expansion so a hostile storage value cannot allocate unboundedly.
- Surprising: The `maxEntries` default is `MAX_SAFE_INTEGER` — the persistence-only length limit was deliberately removed.

### packages/core/session/src/known-event-types.ts
- Purpose: **Generated** set of every `SessionEventMap` member declared in the repository.
- Key abstractions: `KNOWN_SESSION_EVENT_TYPES` (64 entries), `MESSAGE_PROJECTION_EVENT_TYPES` (currently only `image/offload`).
- Data flow: Written by `scripts/gen-persistence-catalog.ts`; the persistence read path refuses a log containing a type outside this set unless the event carries `ignorable`.
- Non-obvious design decisions: "Event-name registration was rejected because it does not classify omission safety and would make reads composition-dependent" — the per-event `ignorable` marker is the compatibility mechanism instead.
- Edge cases / failure handling: The header names the exact regeneration command and the `verify-persistence-catalog` gate that proves freshness.
- Surprising: The set includes plugin-owned types (`team/*`, `subagent/*`, `compaction/*`) because the catalog is a *repository* census, not a core-owned list.

### packages/core/session/src/preparation.ts
- Purpose: Ownership of one unpublished `Session` before registry publication.
- Key abstractions: `SessionPreparation` (sync, idempotent `[Symbol.dispose]`).
- Data flow: `SessionPreparation.create(session, { release? })` → `using` scope → the provider's release callback runs on disposal, possibly a no-op if publication consumed the state.
- Non-obvious design decisions: Disposal is **synchronous and idempotent**, and "publication may consume that state before disposal, making the callback a no-op" — the preparation owns the unpublished window only.
- Edge cases / failure handling: n/a.
- Surprising: A 49-line file that exists purely so the agent factory can `using`-scope an unpublished session.

### packages/core/session/tests/session.spec.ts
- Purpose: The core `Session` + `SessionStore` contract suite (1820 lines).
- Key abstractions: Exercises derivation, seed validation, header validation, append snapshots, the store lifecycle and the event-feed containment rules.
- Data flow: Each `it` builds a session, appends, and asserts on `deriveMessages()` / `snapshotEvents()`.
- Non-obvious design decisions: A dedicated test asserts that a **stateful getter** cannot supply one value to validation and another to storage (each seed/append entry is read exactly once).
- Edge cases / failure handling: Covers sparse arrays, `-0`, cycles, exotic prototypes, negative-zero seqs, reentrant appends, deferred detach during dispatch, and an `internal/dispatch` veto leaving the log unchanged.
- Surprising: The suite asserts that `Reflect.set(session, 'onAppend', undefined)` succeeds — the store-owned publication hooks are module-private, so a JavaScript caller cannot suppress the durable event feed.

### packages/core/session/tests/surface.spec.ts
- Purpose: The surface fold / `SurfaceManager` contract (1030 lines).
- Key abstractions: `foldSurface` vs the incremental `SurfaceManager` are compared for identical verdicts.
- Data flow: Builds events with explicit `surfaceOp` markers and folds them.
- Non-obvious design decisions: The suite pins that the incremental manager and the offline fold **reject the same invalid replacements** — the two paths must not drift.
- Edge cases / failure handling: Replacement coverage, tool-result rewrite shape, protected system head, negative-zero endpoints, and a candidate whose validation fails leaving the incremental state unchanged.
- Surprising: A `compact-checkpoint` message source is used as the fixture for a compaction-shaped replacement.

### packages/core/session/tests/fork.spec.ts
- Purpose: Fork semantics, boundaries and the synthetic closers.
- Key abstractions: `SessionForkError` codes `SESSION_NOT_FOUND | SESSION_NOT_LIVE | SESSION_ALREADY_EXISTS | INVALID_BOUNDARY`.
- Data flow: Builds a source session, forks at various boundaries, inspects the child's inherited prefix and derived messages.
- Non-obvious design decisions: Forking *inside an open turn* closes it with a `forked` reason and synthesises error results only for the open step; a *closed* step with an unanswered call is preserved unchanged.
- Edge cases / failure handling: A corrupted source whose array index no longer matches the event seq is rejected; a detached `Session` object that is not the live store instance is rejected with `SESSION_NOT_LIVE`.
- Surprising: An unmatched plugin bracket (e.g. `compaction/start`) inherited from a still-running parent is left open on purpose — "log-only locks belong to their owner".

### packages/core/session/tests/repair.spec.ts
- Purpose: `ToolCallRecovery` and `openTurnClosers` wording.
- Key abstractions: The two error codes and the two cause wordings.
- Data flow: Feeds synthetic event sequences and asserts the produced `tool/result` events.
- Non-obvious design decisions: A `tool/call` with no matching assistant entry is handled gracefully rather than throwing.
- Edge cases / failure handling: A pending call survives a *closed* step (it is not repaired) but is repaired when the turn is still open; multiple unanswered calls are answered in log order.
- Surprising: The suite pins the exact model-visible strings — the wording is a contract, not prose.

### packages/core/session/tests/canonical-envelopes.spec.ts
- Purpose: Acceptance/rejection matrix for canonical event payloads and surface metadata.
- Key abstractions: `adoptSessionEvent` vs `snapshotSessionEvent` (adopt in place, snapshot detaches).
- Data flow: Adopts seeded/restored events and asserts the throw/no-throw outcome per rule.
- Non-obvious design decisions: Known *log-only* types are rejected even when marked `ignorable` — the marker only helps for types nobody recognises.
- Edge cases / failure handling: `header.system` is refused even when its value is `undefined` ("any own header.system"); restored request configs must be objects.
- Surprising: A rejected append or seed changes neither the log, the derived state, nor the event feed.

### packages/core/session/tests/derived-cache.spec.ts
- Purpose: The derived-message cache contract against a from-scratch replay oracle.
- Key abstractions: `deriveMessages()` vs a scratch `Session.create(id, events).deriveMessages()`.
- Data flow: Grows the log, replaces surface nodes, and compares the two derivations at each step.
- Non-obvious design decisions: The cache must stay **deep-equal to a from-scratch replay** — a cheap invariant that catches stale-cache bugs.
- Edge cases / failure handling: A replace rebuilds the cache; a returned array is a fresh snapshot while the `Message` objects are shared and frozen.
- Surprising: The suite reuses the same `checkpointSource` fixture as the surface suite — a compaction-shaped replacement.

### packages/core/session/tests/developer-header.spec.ts
- Purpose: Tool additions bound to one historical `request/header`.
- Key abstractions: `headerSeq` on `developer/message`.
- Data flow: Registers a header, then a developer message referencing it, then replaces/forks/restores.
- Non-obvious design decisions: The binding survives a *later* header change, a surface replacement, a restore and a fork — the addition resolves against the header it names, not the current one.
- Edge cases / failure handling: A reference to a non-header or a later header is refused; a missing or ambiguous tool name is refused; a tool-less header is refused; an incomplete referenced definition is refused; inline definitions are refused.
- Surprising: The same check is applied to imported events and to a full-log surface fold.

### packages/core/session/tests/request-header.spec.ts
- Purpose: Header canonicalisation, equality and folding, plus `Session.requestContext()`.
- Key abstractions: `canonicalHeader`, `headerEquals`, `foldRequestHeader`, `RequestContext`.
- Data flow: Folds `request/header` and `request/context` events.
- Non-obvious design decisions: Absent and empty tool arrays are *equivalent* canonical absence; the folded context record is deep-frozen so a reader cannot desync later comparisons.
- Edge cases / failure handling: A batch appended between two reads folds correctly (the watermark starts at 0 with the seed already in the log).
- Surprising: `request/context` (provider/model/contextWindow/systemPromptUpdate) is deliberately separate from the header and does not participate in request reconstruction.

### packages/core/session/tests/tool-history.spec.ts
- Purpose: `Session.toolHistory()` — the capability-independent tool-declaration fold.
- Key abstractions: `ToolHistoryProjection.apply(event)`.
- Data flow: Header + developer-message events in, `{ tools, updates }` out.
- Non-obvious design decisions: A `series` header or `startsSeries` restarts declarations; a *changed* definition for a retained name also restarts them; an unchanged restoration continues the series and the recorded addition re-offers the tool.
- Edge cases / failure handling: An addition whose referenced header lacks the definition throws; a session written before tool-update emission falls back to complete active declarations.
- Surprising: The suite also exercises `projectToolUpdates` to prove the deferred-loading baseline is activated through the folded history on both `addition-only` and `in-history` routes.

### packages/core/session/tests/message-projections.spec.ts
- Purpose: Plugin-owned message projections.
- Key abstractions: `SessionMessageProjection` — a pure interpreter for an event type that changes existing message content.
- Data flow: A projection is registered on the store, applied to a candidate event, and its immutable message updates cached.
- Non-obvious design decisions: The decision is applied **atomically** — a projection that throws leaves the derived state untouched; unloading a used definition blocks cached reads as well as new appends.
- Edge cases / failure handling: A candidate that never committed does not retain its interpreter.
- Surprising: `MESSAGE_PROJECTION_EVENT_TYPES` is a *generated* set — an event in it with no registered definition is rejected at append, restore and fold.

### packages/core/session/tests/plugin-records.spec.ts
- Purpose: The experimental `plugin:` record namespace.
- Key abstractions: `appendPluginRecord(session, type, data)`, `pluginRecordOf(event)`, the `plugin:<owner>/<record>` grammar.
- Data flow: A record is an `ignorable` event outside the model-visible surface; it survives snapshot restore, storage reopen and fork.
- Non-obvious design decisions: Records carry `ignorable: true`, so a build that does not recognise one retains and skips it on read.
- Edge cases / failure handling: The type grammar is enforced at runtime (`plugin:` + lowercase slash-separated segments); non-lossless data is rejected without changing the log; a reentrant record during a `session/event` notification is contained.
- Surprising: `pluginRecordOf` refuses a *known* event even when it is marked `ignorable` — only unknown types can be records.

### packages/core/session/tests/plugin-records.type-test.ts
- Purpose: Compile-time checks for the plugin-record writer.
- Key abstractions: `PluginRecordMap` declaration merging.
- Data flow: Declares five record names with typed payloads and calls `appendPluginRecord` with `@ts-expect-error` for an undeclared name and a mismatched payload.
- Non-obvious design decisions: The record `data` stays `unknown` even for a declared name — "a stored record carries whatever JSON an earlier build of its owner wrote".
- Edge cases / failure handling: The file is excluded from production declarations and is type-checked only.
- Surprising: The type test is itself the schema: a `plugin:` name maps to exactly one payload type.

### packages/core/session/tests/properties.spec.ts
- Purpose: Property-based invariants of the event log.
- Key abstractions: fast-check arbitraries for message and non-message events.
- Data flow: Generates arbitrary logs, appends them, and asserts derivation determinism, replay equality and strict seq monotonicity.
- Non-obvious design decisions: The arbitraries carry their own `surfaceOp` intent, because "the property would fail to exercise malformed fixture choices" otherwise.
- Edge cases / failure handling: Non-message events (turn/step boundaries, `assistant/attempt`) must never affect derived history.
- Surprising: The property is stated as "replay-from-seed reproduces it" — the same invariant the whole design rests on.

### packages/core/session/tests/json.spec.ts
- Purpose: The shared `snapshotJsonValue` / `isJsonValue` lossless-JSON contract.
- Key abstractions: JSON scalar vocabulary, detached snapshots, realm-crossing acceptance.
- Data flow: Snapshots nested values and asserts detachment and deep equality.
- Non-obvious design decisions: A cross-realm `Object`/`Array` is accepted by *intrinsic* checks (`Object.prototype.toString` shape) rather than `instanceof`; a **forged** intrinsic prototype is rejected.
- Edge cases / failure handling: `-0`, `NaN`, `Infinity`, `BigInt`, functions, symbols, `undefined` all return `undefined` (rejected); each object value and array slot is read exactly once.
- Surprising: The suite mocks `Function.prototype.toString` to reproduce the WebKit native-code formatting, so the "intrinsic" test is not accidentally a `toString` test.

### packages/core/session/tests/gen-persistence-catalog.spec.ts
- Purpose: Negative-path tests for the persistence-catalog generator.
- Key abstractions: `collectLogEvents`, `annotateSurface`, `renderKnownEventTypes`.
- Data flow: Builds fixture package trees in a temp dir and runs the generator over them.
- Non-obvious design decisions: The generator hard-errors when a top-level `SessionEventMap` is declared outside the owning package, when it is not exported, or when it is exported from two files ("the owning vocabulary has exactly one home").
- Edge cases / failure handling: A plugin may not declare both a surface role and a message projection.
- Surprising: The generator is imported directly from `scripts/` — the test is the script's contract.

### packages/core/session/tests/scoped.spec.ts
- Purpose: Scope-filtered dispatch of session events plus `flush()`.
- Key abstractions: `scopeTarget`, `scopeOf`, the `session/created|disposed|event|flush` carriers.
- Data flow: Mints scopes, enters sessions through a scoped context, and observes which listeners hear what.
- Non-obvious design decisions: A session entered through a scoped context dispatches in *that* scope; a bare session dispatches subject-less and scoped listeners never hear it.
- Edge cases / failure handling: `flush()` resolves `false` with no listeners and `true` when at least one durability listener participated.
- Surprising: The disposal notification reuses the **owner** carrier captured at `enter`, not the dispatching context.

### packages/core/session/tests/sequence-types.spec.ts
- Purpose: The two branded numeric roles in session log positions.
- Key abstractions: `SessionSeq` (an existing event), `SessionLogOffset` (a gap/prefix length), `SessionSeqCursor` (`-1` = none yet), `OptionalSessionSeq` (`null` = absence is data).
- Data flow: Type-level assertions plus runtime constructor rejection.
- Non-obvious design decisions: The brands disappear at runtime, so durable JSON and wire values stay ordinary numbers; the two roles are kept distinct at the type level to stop a boundary offset being used as an event position.
- Edge cases / failure handling: `-0`, fractions and `MAX_SAFE_INTEGER + 1` are rejected by both constructors.
- Surprising: `isSeeded` is a logical header boolean and `inheritedEventCount` is the positional integer — the physical `seedLength` field is explicitly rejected.

### packages/core/session/tests/seq-ranges.spec.ts
- Purpose: Round-trip and rejection rules for the range encoding.
- Key abstractions: `encodeSeqRanges` / `decodeSeqRanges`.
- Data flow: Encodes and decodes arbitrary increasing and non-increasing lists.
- Non-obvious design decisions: "Does not impose a persistence-only source-event length limit" — a million-element list encodes to a single pair.
- Edge cases / failure handling: Malformed pairs, reversed ranges and mixed non-increasing forms are rejected; `maxEntries` overflow is rejected.
- Surprising: A one-million-element list is a *feature* test, not a stress test.

### packages/core/session/tests/typert.spec.ts
- Purpose: The Typert lookup registration for live sessions.
- Key abstractions: `ctx.typert.lookups.register('session', …)` with `parameter: 'session'`, `wire: 'sessionId'`.
- Data flow: The store registers a lookup resolving a `SessionId` to the live `Session`.
- Non-obvious design decisions: The registration happens in an `inject(['typert'])` block so the service works in either load order.
- Edge cases / failure handling: Disposing the session fiber removes the lookup.
- Surprising: The wire field is `sessionId` while the host type is `@deepseek-ai/dsh-session#Session` — the wire carries the id, the host carries the object.

### packages/core/agent-loop/README.md
- Purpose: The default agent driver — turn/step machine, creation transaction, tool scheduling.
- Key abstractions: `AgentLoop` service + `ReactLoopAgent` driver, `maxParallelToolCalls`, `agent/pre-step`, `agent/request`, `agent/request-error`, `agent/turn-stopping`.
- Data flow: A turn claims inbox input, assembles the prompt, runs `agent/pre-step`, opens `step/start`, resolves the route through `agent/request` + `prepareCall()`, reconciles the prompt against the surviving `system/message` nodes, admits the user batch, logs the header/context, then streams through the bound prepared call and executes the tool calls.
- Non-obvious design decisions: The request carries **no `system` field** — it is `header.config` + `deriveMessages()` + `header.tools` only, so the prompt is a surface node, not request state. Retries reuse the same rendered assembly without repeating assembly, `agent/pre-step` or user admission. The whole "Turn and step flow" paragraph on line 120 of this clone is truncated mid-sentence (see Uncertainties).
- Edge cases / failure handling: A rejected decision or an empty first batch opens no step; cancellation during the async phases commits neither prompt nor users; `max-tokens` is sticky for the turn; a cancelled stream finalises the delivered prefix.
- Surprising: The README carries a "Model Experience" section that states the KV-cache consequence of every path, and the "Known Limitations" section explicitly says **"No built-in turn budget"** — a turn bound must come from a plugin at `agent/turn-stopping`.

### packages/core/agent-loop/README.zh.md
- Purpose: Chinese translation of the agent-loop reference.
- Key abstractions: Same turn/step vocabulary, translated.
- Data flow: n/a.
- Non-obvious design decisions: Hash-paired with the English file.
- Edge cases / failure handling: n/a.
- Surprising: It preserves `maxParallelToolCalls` and the event names verbatim.

### packages/core/agent-loop/README.i18n.yaml
- Purpose: Heading-section hash record for the agent-loop README pair.
- Key abstractions: One hash pair per heading path.
- Data flow: Regenerated by `verify-translation-pairing --write`.
- Non-obvious design decisions: The `Model Experience` and `Known Limitations` sections are hashed separately, so a doc change in either is a visible drift.
- Edge cases / failure handling: n/a.
- Surprising: The hash list is the de-facto index of the README's structure.

### packages/core/agent-loop/locale/en.json
- Purpose: English UI locale for the agent-loop package.
- Key abstractions: `meta.title = "agent-loop"`.
- Data flow: n/a.
- Non-obvious design decisions: Minimal by design.
- Edge cases / failure handling: n/a.
- Surprising: The title is the package name, untranslated.

### packages/core/agent-loop/locale/zh.json
- Purpose: Chinese UI locale for the agent-loop package.
- Key abstractions: `meta.title = "智能体运行循环"`, `meta.description`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: The description names the model/tool/step triple, which is the package's whole job.

### packages/core/agent-loop/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-agent-loop` v0.2.1-rc.2.
- Key abstractions: Only two exports (`.` and `./locale/*.json`) — the loop is not subpath-importable.
- Data flow: `peerDependencies` on `dsh-agent`, `dsh-llm`, `dsh-scope`, `dsh-session`, `dsh-session-persistence`, `dsh-session-projection`, `dsh-system-prompt`, `dsh-tools`.
- Non-obvious design decisions: The package is a *consumer* of `dsh-agent` (the public contract) and registers itself as the `AgentFactory`, so no consumer ever imports it.
- Edge cases / failure handling: n/a.
- Surprising: `zod` is a *direct dependency* here (4.4.3) while `dsh-agent` uses schemastery — the config schemas differ by package.

### packages/core/agent-loop/tsconfig.json
- Purpose: TypeScript project config for the agent-loop package.
- Key abstractions: `rootDir: src`, `outDir: lib/types`, 11 project references.
- Data flow: References session, system-prompt, tools, agent, scope, session-persistence, session-projection, llm.
- Non-obvious design decisions: The reference graph makes the dependency direction explicit and machine-checked.
- Edge cases / failure handling: n/a.
- Surprising: `dsh-session-persistence` is a *peer* dependency, so the loop compiles against a persistence contract it does not implement.

### packages/core/agent-loop/tsdown.config.ts
- Purpose: Bundler config for the agent-loop package.
- Key abstractions: One ESM entry, `target: es2024`, `dts: false`, `clean: false`.
- Data flow: Bundles `lib/types/index.js` into `lib/index.js`.
- Non-obvious design decisions: Identical to the other core packages' configs (byte-identical SHA-256).
- Edge cases / failure handling: n/a.
- Surprising: Five core packages share one hash for this file — a deliberate uniformity, not copy-paste drift.

### packages/core/agent-loop/src/agent.ts
- Purpose: `ReactLoopAgent` — the concrete turn/step machine.
- Key abstractions: `Phase = idle | maintenance | running`, `PreparedStep = reject | enter`, the `StepEndReason` subset, `requestProposal`, `abortedCancelCause`.
- Data flow: `kick()` loops `turn()`; `turn()` opens `turn/start`, calls `preStep()` (claim + assemble + `agent/pre-step` waterfall), opens `step/start`, runs `step()`, closes `step/end`, and finally `turn/end`. `step()` prepares the call, reconciles the prompt, admits the user batch, builds and freezes the request, streams, and on tool calls calls `executeToolCalls`.
- Non-obvious design decisions: The cancellation cause is **copied** out of the live `AbortSignal.reason` because Node's `fetch` assigns a `stack` onto the reason, which `Session.append` would reject as non-JSON data. The `max-tokens` turn reason is sticky — a later completed step must not downgrade it. The prompt is reconciled against the *surviving* `system/message` nodes using the **prepared call's** capability, not the earlier `request/context` snapshot.
- Edge cases / failure handling: A step failure records recovery results for unanswered tool calls and, if that recording also fails, raises an `AggregateError` carrying both; a `turn/end` append failure is reported but the turn is still closed.
- Surprising: The driver "deep-freezes each derived message identity on its first request and reuses that proof only within the same agent" via a `WeakSet<Message>` — the same message object is frozen once and then shared, which is what keeps the provider prefix byte-identical.

### packages/core/agent-loop/src/index.ts
- Purpose: The `AgentLoop` service: config, declarative agent startup, and the rollback-covered creation transaction.
- Key abstractions: `AgentLoop extends Service implements AgentFactory`, `FactoryOwnership`, `PreparedAgent`, `turnBoundaryProjectionDefinition`, `CONFIGURED_AGENT_IDENTITIES_KEY`.
- Data flow: The constructor registers the turn-boundary and inbox projections, sets itself as the factory, registers the `provider`/`model` prompt variables, and starts each configured agent (restore-or-create, or resume). `create`/`createAgent`/`resume` all funnel through `prepare()` → `publish()` → `dispose()`.
- Non-obvious design decisions: The teardown is **memoized** so every racing owner awaits one quiescence; the disposer is a *capability* held only by the creator; the abort signal fuses three owners (caller cancellation, owner-fiber unload, factory teardown) and is registered *before any resource exists* over mutable slots, so an unload during scope minting finds a working disposer instead of a leak. `semantic crash repair is the agent layer's job, not a storage entry point` — resume reads the physically valid log and appends `interruptedTurnClosers` as an ordinary batch.
- Edge cases / failure handling: A create that fails leaves no stored residue so the same id can be created again; a `sessionId`/`resumeSessionId` conflict and duplicate exact identities are rejected before any agent starts; a configured-start failure emits `agent-loop/config-start-failed` so identity-bound consumers do not wait forever.
- Surprising: `applyLauncherIdentities` lets a *launcher* own the session identity while the `cordis.yml` row keeps the model route as ordinary patchable config — "only it knows whether the session already exists".

### packages/core/agent-loop/src/tool-calls.ts
- Purpose: The tool-call scheduler for one assistant step.
- Key abstractions: `executeToolCalls(ctx, turn, step, toolCalls, signal, acceptContext)`, `PlannedCall`, `Slot`, `GroupOutcome`.
- Data flow: Calls are classified by `ctx.tools.executionMode(...)`; a parallel group runs in a bounded rolling pool (`fillPool`), an exclusive call runs alone as a barrier. Results commit in **model order** (`commitReady`) regardless of settlement order; each `tool/result` cites the `tool/call` seq.
- Non-obvious design decisions: A pending call is **reclassified before it starts**, so a registry change mid-step can turn a parallel sibling into a barrier. Only dispatch/body overlap; ordered pre-execute awaits do not. A scheduler failure stops new dispatches, drains started ones, and rejects — the owning step then records recovery results.
- Edge cases / failure handling: On abort, started calls settle and their contexts are accepted, and every *remaining* model call gets an ordered synthetic `ABORTED_BEFORE_DISPATCH` result so replay stays valid.
- Surprising: `parseArguments` keeps invalid JSON as the raw *string* rather than throwing — the tool receives the model's text and decides.

### packages/core/agent-loop/src/inbox.ts
- Purpose: The durable, driver-owned inbox projection and command facade.
- Key abstractions: `ReactLoopInbox`, `inboxProjectionDefinition` (`key: 'inbox'`, `stateVersion: 1`), the `agent/inbox/spliced` event.
- Data flow: Every mutation appends one normalised `agent/inbox/spliced` event; the projection registry folds it synchronously so the live projection is correct the moment `Session.append()` returns. `claim(target, turn)` removes next-step input plus one queued turn and emits `agent/inbox/claimed`.
- Non-obvious design decisions: Claims are **pure deletions with no outcome**, while ordinary removals carry `outcome: 'canceled'` and emit `agent/inbox/discarded` — the two are distinguishable in the log. The projection rejects an out-of-range splice or a duplicate `MessageId` across both lists and reports the offending event seq.
- Edge cases / failure handling: `clear()` removes next-step before next-turn so the order is deterministic.
- Surprising: The inbox state is *reconstructed from the durable log*, so a cold read before any Agent exists works (the projection is registered for the service lifetime, not per agent).

### packages/core/agent-loop/src/runtime-context.ts
- Purpose: The two loop-owned surface messages: the system prompt and the dynamic runtime-context snapshot.
- Key abstractions: `SystemPromptProjection.project(rendered, input)`, `RuntimeContextProjection.project(current, sections)`, `SystemPromptCommit`, `SystemPromptDecisionInput`.
- Data flow: `SystemPromptProjection` lists the surviving `system/message` nodes and returns ordered per-node commits (append for a first prompt, per-node *empty replacements* for later active nodes, a head rewrite when needed). `RuntimeContextProjection` tracks the last retained owned snapshot and emits a new one only when the text differs.
- Non-obvious design decisions: The decision depends on the *prepared route's* `systemPromptUpdate` capability: an incapable route or a new series **consolidates at the head** (empty-replace the later nodes, then rewrite the head), while a continuing `in-history` series **appends** the changed prompt after the cached history. An empty rendering clears *every* active system node. "Dormant empty tails need no replacement and do not determine the effective text."
- Edge cases / failure handling: A multi-block or non-text system node is *not* treated as dormant — it is cleared, because a node the projection cannot read is a node the model would keep seeing.
- Surprising: The runtime-context snapshot is a **user-role** message, not a system message — it lands in derived history as context, and its `source` carries the contributing section names.

### packages/core/agent-loop/src/assistant-stream.ts
- Purpose: Process-local assistant attempt framing plus durable stream accumulation.
- Key abstractions: `AssistantStreamAttempt` — `start()`, `push(chunk)`, `settle(eventType, append)`, `abandon()`, `blocks()`, `interruptedBlocks()`, `usage`, `finish`, `replayState`.
- Data flow: Each chunk is timestamped once, fed to the durable accumulator and the block assembler, and published as a transient `chunk` frame. `settle()` appends the durable event and *then* emits the `end` frame with the committed seq.
- Non-obvious design decisions: The live `chunk` frames are presentation only — the durable `assistant/message`/`assistant/attempt` event is the replay source, and the `end` frame is emitted only after that event commits. `interruptedBlocks()` gives the *safe visible prefix* when cancellation interrupts the attempt.
- Edge cases / failure handling: A rejected durable append turns the attempt into `abandoned` rather than a false `committed` end frame.
- Surprising: The attempt id is `${sessionId}:${attempt}` and is "embedded only in the Agent-lifecycle-local attempt id" — it is not a durable identity.

### packages/core/agent-loop/src/constants.ts
- Purpose: The scheduler default.
- Key abstractions: `DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10`.
- Data flow: Used as the schemastery default for `maxParallelToolCalls`.
- Non-obvious design decisions: `1` is serial, so the cap is a continuum rather than a boolean.
- Edge cases / failure handling: n/a.
- Surprising: A whole file for one constant — but it is the one number that changes concurrency behaviour.

### packages/core/agent-loop/tests/loop.spec.ts
- Purpose: The end-to-end agent-loop behaviour suite (1982 lines, 68 cases).
- Key abstractions: A `harness()` that mounts llm/session/projections/system-prompt/tools/agents/loop and registers a `MockAdapter`.
- Data flow: Each case sends a message, waits on the `agent/status` transition to idle, and asserts the log and the adapter's captured requests.
- Non-obvious design decisions: The suite drives the loop through the *public* status event rather than sleeps, so a failure is a finding rather than timing noise.
- Edge cases / failure handling: Covers max-tokens stickiness, steering between steps, `inject()` deferral during a tool batch, a throwing `agent/pre-step`, cancellation mid-stream, disposal mid-turn, and a failed `step/end` observer.
- Surprising: One case asserts the `assistant/chunk` event type is *absent* from the log — raw chunks are never persisted as events, only inside the embedded stream.

### packages/core/agent-loop/tests/contract-regressions.spec.ts
- Purpose: 54 named regression cases (64 KB) over the loop's public contract.
- Key abstractions: Focuses on plugin exceptions being contained, aborted tool batches, turn numbering across seeded sessions, forked tool history, and turn/step boundary recovery.
- Data flow: Each case builds a scenario and asserts the log and the turn outcome.
- Non-obvious design decisions: "A pre-commit turn/start rejection leaves no durable turn state" and "a pre-commit step/start validation failure does not invent a step boundary" — the boundary markers are all-or-nothing.
- Edge cases / failure handling: A throwing `agent/error` listener during a step-error path still balances the turn; disposal during a running turn ends it `disposed`; a `finish {kind:'error'}` stream chunk ends the turn as *error*, not completed.
- Surprising: "A turn that stops before its first step leaves a `turn/end` shaped exactly like the balanced no-op turns" — which is why `consumed-work.ts` exists.

### packages/core/agent-loop/tests/cancel.spec.ts
- Purpose: 37 cases pinning the cancellation contract (50 KB).
- Key abstractions: `cancel(cause, { keepInbox })`, wake latching, abort-to-idle windows.
- Data flow: Cancels at many precise points (mid-stream, during pre-step, from a `step/start` observer, from an `agent/status(running)` listener) and asserts the resulting turn reason and inbox state.
- Non-obvious design decisions: A wake that lands during an aborted activity is **latched** and replayed at convergence, unless the cause is `disposed`; `keepInbox: true` parks queued work but a *claimed* work item is not restored.
- Edge cases / failure handling: The first typed cause wins for an active turn; a cancelled turn's steering is cleared, not re-enqueued as a fresh turn; a cancel before any visible content finalises nothing.
- Surprising: Cancelling from a *synchronous* `session/event` listener for `step/start` drops the step — the abort lands before the request is even built.

### packages/core/agent-loop/tests/scope-lifecycle.spec.ts
- Purpose: 41 cases on the agent scope's creation and teardown ordering (50 KB).
- Key abstractions: `prepare` / `enter` / `announce` / `dispose` and the scope's `rawDispose` vs `dispose`.
- Data flow: Creates agents through `ctx.agents.create()` and asserts which registries and scopes are live at each point.
- Non-obvious design decisions: "Setup runs in the guaranteed slot: scoped world complete before `agent/created` and the first assembly"; the teardown order is *documented and asserted* — unregistration AFTER the drain, before detach.
- Edge cases / failure handling: A throwing `session/created` listener disposes the scope; an aborted creation signal publishes nothing; a reentrant `agent/created` teardown keeps both entries and the scope live.
- Surprising: The ids become reusable only after the *private* scope finishes quiescing — a stale disposer cannot remove a later same-id replacement.

### packages/core/agent-loop/tests/resume.spec.ts
- Purpose: 48 cases on persistence-backed create/resume (67 KB).
- Key abstractions: `persistence.open(id, 'write')`, `handle.read()`, `handle.append()`, `handle.close()`.
- Data flow: Creates, resumes, injects failures into the backend, and asserts what reached durable storage.
- Non-obvious design decisions: Write ownership is taken **first**, which excludes a concurrent resume of the same id; a *resume* over a torn physical tail continues from the committed prefix; crash repair is appended as an ordinary batch so it is durable.
- Edge cases / failure handling: A rejecting final writer close releases the registries and *then* rejects disposal; a combined machine-teardown + close failure becomes one `AggregateError`; rollback swallows a rejecting handle close because the setup failure is primary.
- Surprising: "resume cannot crash-repair a turn owned by a live agent" — a live agent's turn must not be closed by a second reader.

### packages/core/agent-loop/tests/request-reconstruction.spec.ts
- Purpose: 31 cases on request stability, adapter defaults and series boundaries (44 KB).
- Key abstractions: The request-series concept (`initial` / `resume` / `change` / `series`), `adapterDefaults`.
- Data flow: Drives turns and compares successive requests, headers and series markers.
- Non-obvious design decisions: A step request *append-extends* the previous one; a new series starts only when the admitted step explicitly asks, when the surface changed, or when the tool schemas changed on a route without tool-update support. Adapter-resolved defaults are stripped before the next proposal so the route re-resolves them, while explicit settings persist.
- Edge cases / failure handling: A compaction replace rewrites the resend; a system-prompt change replaces surface node 0 and starts a new series; an in-history route appends instead; a mutating listener cannot mutate the seed.
- Surprising: The final case is titled **"THEOREM: every request rebuilds byte-equal from the session log alone"** — the design's central invariant, asserted as a test.

### packages/core/agent-loop/tests/request-cache.e2e.ts
- Purpose: A key-gated real-provider cache-hit proof.
- Key abstractions: `cacheReadTokens` (the adapter's mapping of the provider's `prompt_cache_hit_tokens`).
- Data flow: Runs a multi-step tool turn plus a follow-up turn against the live DeepSeek API and reads the per-step `usage` recorded on `assistant/message` events.
- Non-obvious design decisions: "Mocks establish append-extension; this key-gated test establishes a real provider cache hit" — the unit tests prove the property, the e2e proves the provider agrees.
- Edge cases / failure handling: `describe.skipIf(!process.env.DEEPSEEK_API_KEY)`; the test additionally asserts the tool's value reached the final answer, so the conversation is verified, not just the cache counters.
- Surprising: The system prompt is deliberately padded to exceed the provider's 64-token cache-block granularity "from the very first request".

### packages/core/agent-loop/tests/request-freeze.spec.ts
- Purpose: Request immutability through the real loop, including adopted restore graphs.
- Key abstractions: The `WeakSet<Message>` freeze-once rule and `markAgentLoopRequest`.
- Data flow: Restores a session, runs turns, and asserts the request object is deeply frozen at dispatch.
- Non-obvious design decisions: Restored messages keep their identity but their *containing event wrappers* stay mutable; the frozen request is per-dispatch, while the frozen message identity is per-agent-lifetime.
- Edge cases / failure handling: A failed freeze traversal is retried on the next request; a replacement produces a new message object with the same id.
- Surprising: The test spies on `deepFreeze` to assert each identity is frozen exactly once — over-freezing would break the restore path.

### packages/core/agent-loop/tests/interception.spec.ts
- Purpose: 28 cases on the `agent/pre-step`, `agent/created` and `tools/pre-execute` seams (35 KB).
- Key abstractions: `PreStepDecision` (`reject` / `enter`), the additional-context FIFO.
- Data flow: Mounts listeners on the seams and asserts what enters the turn.
- Non-obvious design decisions: A rejected step closes the claimed prompt turn **without a step or a model call**; input staged after the claim stays pending for a later boundary; a blocked prompt preserves adjacent queued prompts.
- Edge cases / failure handling: A durable append failure leaves the inbox state unchanged; a throwing pre-step listener reports the driver error and retains adjacent work.
- Surprising: The final describe is a worked example — "a native hook plugin is just a cordis plugin on the seams" — with all four seams firing for one real allowed turn.

### packages/core/agent-loop/tests/tool-calls.spec.ts
- Purpose: 29 cases on the scheduler (43 KB).
- Key abstractions: Barriers, the rolling pool, model-order commits, the ordered middleware.
- Data flow: Registers tools with `isConcurrencySafe` classifiers and asserts starts, settlements and result order.
- Non-obvious design decisions: A result observer can make the *next* call exclusive; `maxParallelToolCalls: 1` is fully serial; a per-call failure in `execution-mode`, `prepare` or `finalize` pairs the outstanding requests and preserves the committed results.
- Edge cases / failure handling: Abort before a parallel group starts no calls; a scheduler failure stops new dispatches and drains started bodies before surfacing the first failure; pending requests are isolated from child agents and other sessions in the same scope.
- Surprising: The last describe covers PTC mode: a model-direct native-tool call under PTC mode is denied with `UNKNOWN_TOOL` and the tool body never runs.

### packages/core/agent-loop/tests/agent.spec.ts
- Purpose: The `Agent` handle's inbox semantics and status transitions.
- Key abstractions: `followup` / `steer` / `inject`, `agent/status`.
- Data flow: Sends messages through the handle and asserts the durable splices and the emitted notifications.
- Non-obvious design decisions: `inject()` while idle stages context durably **without opening a turn** and without waking the driver; `steer()` while idle becomes a woken prompt turn.
- Edge cases / failure handling: Invalid (non-JSON) input is rejected *before* enqueue; a throwing `agent/status` listener is contained on both transitions.
- Surprising: The lifecycle order asserted is `['turn/start', 'agent/inbox/claimed']` — the claim is announced *inside* the turn.

### packages/core/agent-loop/tests/agent-initiator.spec.ts
- Purpose: The initiator scope's identity guarantees across overlapping drivers.
- Key abstractions: `ctx.agents.requireInitiator()` inside a transport.
- Data flow: A `OverlapAdapter` reads `requireInitiator()` before and after an await to prove the chain is stable.
- Non-obvious design decisions: The initiator is **process-local attribution only**; explicit identity stays authoritative at worker/process/persistence/wire boundaries.
- Edge cases / failure handling: A driver reload cancels the active turn; the initiator is re-checked after every await.
- Surprising: The test transport materialises the session id from the ambient initiator at the request boundary — a deliberate "ambient identity materialised at a real boundary" pattern.

### packages/core/agent-loop/tests/config-session-id.spec.ts
- Purpose: Launcher-owned configured-agent identities (25 KB).
- Key abstractions: `CONFIGURED_AGENT_IDENTITIES_KEY`, `sessionId` vs `resumeSessionId`.
- Data flow: Provides identities, mounts the loop with config agents, and reads the resulting registry.
- Non-obvious design decisions: The two identity keys are mutually exclusive and a duplicate exact identity across two configured agents is rejected before anything starts.
- Edge cases / failure handling: An empty exact id is rejected at config load; a failing exact-id restore over an existing artifact stays loud (only a genuinely absent session falls back to creation).
- Surprising: "an overlay repointing the row's model route cannot drop them" — the launcher owns identity because only it knows whether the session already exists.

### packages/core/agent-loop/tests/coverage-edges.spec.ts
- Purpose: Edge cases for argument parsing, thrown-value propagation and error rendering (21 KB).
- Key abstractions: `parseArguments` in the scheduler, `LlmError`, `errorChain`.
- Data flow: Feeds malformed arguments and non-Error throws through the loop.
- Non-obvious design decisions: A non-Error throw from a pre-commit dispatch validation is preserved *as itself*, not wrapped.
- Edge cases / failure handling: A rejected `turn/end` append is contained (warn + `agent/error`, no retry); a render failure drops the message rather than sending a broken one.
- Surprising: "rejects a direct turn invocation without a driver reservation" — the machine refuses to be driven from outside.

### packages/core/agent-loop/tests/inbox.spec.ts
- Purpose: `ReactLoopInbox` against the shared projection (11 KB).
- Key abstractions: The `inbox` projection definition and the structural `Inbox` contract.
- Data flow: Drives the inbox directly and reconstructs it from a persisted log.
- Non-obvious design decisions: The inbox reads the *shared* projection and does not own its registration; a cold read of a persisted inbox whose splice history is invalid throws with the offending event seq.
- Edge cases / failure handling: An unregistered projection makes the inbox refuse to read its state rather than silently reporting an empty inbox.
- Surprising: The test builds a `stubAgent` whose `steer` returns a rejected outcome — the contract's shape is pinned even for stubs.

### packages/core/agent-loop/tests/request-error.spec.ts
- Purpose: The `agent/request-error` recovery seam (5.7 KB).
- Key abstractions: `RequestErrorAction = { kind: 'retry' } | undefined`, `retryPolicy`.
- Data flow: Fails a request, lets a listener return `{ kind: 'retry' }`, and asserts the next attempt.
- Non-obvious design decisions: Middleware failures are **not** offered to request recovery — only final adapter selection/dispatch/iteration failures are; a cancellation beats a retry action.
- Edge cases / failure handling: A recovery listener that throws leaves the turn terminal with reason `error`; the turn is *not* re-entered, and only one `turn/start` is logged.
- Surprising: The header log shows `['initial']` only — a retry reuses the same header and does not log a new one.

### packages/core/agent-loop/tests/resource-lifecycle.spec.ts
- Purpose: Resource retention across failed teardowns (8 KB).
- Key abstractions: `runMaintenance`, scope disposal ordering, projection lifetime.
- Data flow: Fails a teardown, unloads the loop, and asserts the scope and the projections outlived the work.
- Non-obvious design decisions: The scope is not disposed before the work exits, and the inbox/turn-boundary projections are still present when the work finishes.
- Edge cases / failure handling: A cancel that throws still leaves the scope disposed; a scope failure combines with the cancel failure into one `AggregateError`.
- Surprising: The test asserts `abortHandled` is exactly 1 — a double `controller.abort()` must not double-fire the listener.

### packages/core/agent-loop/tests/system-prompt-admission.spec.ts
- Purpose: 14 cases on prompt admission against prepared-route capability (21 KB).
- Key abstractions: `systemPromptUpdate: 'in-history'` vs a plain route, `startsRequestSeries`.
- Data flow: Assembles, admits and inspects the surviving `system/message` nodes.
- Non-obvious design decisions: A capable route *appends* a changed prompt after the cached history; an incapable route *consolidates* at the head, even when the text is unchanged.
- Edge cases / failure handling: A compaction during a retry is reconciled without replaying admission; a cancellation during `agent/request` or `prepareCall` leaves a balanced empty step.
- Surprising: "normalizes surviving prompt versions with unchanged text at a series start" — consolidation can happen with no text change, purely to restore the series shape.

### packages/core/agent-loop/tests/system-prompt-projection.spec.ts
- Purpose: `SystemPromptProjection` unit behaviour (11 KB).
- Key abstractions: `SystemPromptDecisionInput { inHistory, startsSeries }`.
- Data flow: Projects a rendered prompt against a session's system nodes and commits the result.
- Non-obvious design decisions: A multi-block or non-text system node is cleared rather than treated as dormant; the first prompt is always appended, even an empty one, to reserve node 0.
- Edge cases / failure handling: An unchanged rendering on a replacing route still replaces the head.
- Surprising: "an empty head with no active later system node means no prompt" — the empty prompt is a recorded state, not an absence.

### packages/core/agent-loop/tests/runtime-context.spec.ts
- Purpose: `RuntimeContextProjection` restore semantics (2 KB).
- Key abstractions: The `runtime-context` message source and the `compact-checkpoint` fixture.
- Data flow: Builds a session with two owned snapshots, shadows one with a replacement, and projects.
- Non-obvious design decisions: The projection restores the latest *visible* owned snapshot by scanning events newest-first and stopping at the first match that is still on the surface.
- Edge cases / failure handling: Another session's owned snapshot is ignored.
- Surprising: A shadowed snapshot is invisible, so the projection correctly re-emits the current one.

### packages/core/agent-loop/tests/serial-listener-review.spec.ts
- Purpose: Integration of real plugins with the serial `agent/created` listeners (7.7 KB).
- Key abstractions: `mountAgentLoopTestDependencies`, real subagent/file-reference plugins.
- Data flow: Mounts production plugins and asserts creation rollback and ordering.
- Non-obvious design decisions: A due-work producer's delivery is *not* started until every creation listener finishes — "Delivery ordering is an Agent-loop property, so its producer is a local fixture".
- Edge cases / failure handling: A prompt-section collision or a tool-name collision during setup rolls the creation back and leaves no agent or session registered.
- Surprising: The fixture asserts `turns === 0` while the first `agent/created` listener is still blocked — the agent exists but has not run.

### packages/core/agent-loop/tests/settings.spec.ts
- Purpose: The `agent-loop` settings section over the composition entry (1.6 KB).
- Key abstractions: `liveConfig(ctx, AgentLoop, {...})`.
- Data flow: Updates `maxParallelToolCalls` through the live-config entry and reads the service.
- Non-obvious design decisions: The update changes the *future* scheduler budget while preserving the composed agents and the running loop — `maxParallelToolCalls` is a `Volatile` field.
- Edge cases / failure handling: An invalid value (`0`) is rejected and the previous value survives.
- Surprising: The test asserts `live.entry.fiber` is unchanged — a settings update does not remount the plugin.

### packages/core/agent-loop/tests/shutdown-drain.spec.ts
- Purpose: Root-fiber shutdown drains buffered session events durably (3.1 KB).
- Key abstractions: `JsonlSessionPersistence` and `ctx.fiber.dispose()`.
- Data flow: Runs one turn, disposes the root without an explicit flush, and re-reads the log.
- Non-obvious design decisions: The test is parameterised over **both mount orders** (backend-first and loop-first) — the drain must not depend on which service loaded first.
- Edge cases / failure handling: Without an explicit flush and without an agent dispose, the final `turn/end` must still be on disk.
- Surprising: This directly addresses the agent-loop README's known limitation "Root shutdown persistence".

### packages/core/agent-loop/tests/tool-order.spec.ts
- Purpose: Loop-level canonical tool order (5.6 KB).
- Key abstractions: `foldRequestHeader`, `TOOL_ORDER_REST`, the system-prompt `toolOrder` config.
- Data flow: Registers named tools in a chosen order, runs one text-only turn, and reads the logged header and the dispatched request.
- Non-obvious design decisions: The dispatched request is built *from* the logged header, whose tools the assembly already canonicalised — so the header and the wire agree by construction. Registration order is "a concurrent loading artifact and must not leak downstream".
- Edge cases / failure handling: A `toolOrder` naming an unregistered tool closes a no-step turn: no request is sent, no header is logged, and the turn still opens and closes.
- Surprising: The test asserts `Object.isFrozen(adapter.requests[0])` — the request the adapter receives is frozen, and it carries the session id.

### packages/core/agent-loop/tests/tool-updates.spec.ts
- Purpose: Tool-change emission and the per-request tool history (5.5 KB).
- Key abstractions: The `developer/message` `tool-addition` / `tool-removal` blocks, `Session.toolHistory()`.
- Data flow: Registers and unregisters tools between turns and asserts the emitted developer messages and each request's `toolHistory`.
- Non-obvious design decisions: An *addition* is bound to the new header's seq; a *removal* names the tool without a header reference. Both are emitted "independently of model capability".
- Edge cases / failure handling: On an `in-history` route the deferred declaration is sent alongside the baseline and the update blocks are carried in the request; the header itself keeps only the baseline tools.
- Surprising: The suite pins the per-request `toolHistory.updates.length` sequence `[0, 1, 2, 2]` — a removal does not add a new update entry.

### packages/core/agent-loop/tests/properties.spec.ts
- Purpose: Property-based invariants of inbox/turn scheduling (8.2 KB).
- Key abstractions: fast-check over send sequences; an `EchoAdapter` that never exhausts.
- Data flow: Sends 1–6 messages in various timings and asserts the log.
- Non-obvious design decisions: "Deterministic by construction: schedules are driven through the `agent/status` settle signal (no wall-clock sleeps), so a flake is a finding, not timing noise."
- Edge cases / failure handling: A synchronous burst of six messages still yields six strictly increasing turns, one message each.
- Surprising: The status trace must be `['running', 'idle']` — exactly one transition pair for a whole burst.

### packages/core/agent-loop/tests/fixtures/serial-created.mjs
- Purpose: A plain-JS fixture plugin with ordered `agent/created` listeners.
- Key abstractions: `name`, `inject`, `apply(ctx)`.
- Data flow: The first listener awaits a macrotask then injects a message; the second throws if it ran too early.
- Non-obvious design decisions: It is a `.mjs` file so the *Python* SDK snapshot can load the same fixture — the ordering contract is shared across languages.
- Edge cases / failure handling: A non-Error throw from the second listener fails the fixture loudly.
- Surprising: The fixture asserts listener *ordering*, not just that listeners ran.

### packages/core/agent-loop/tests/mock-adapter.ts
- Purpose: The scripted model adapter used by nearly every loop test.
- Key abstractions: `MockAdapter`, `textResponse`, `maxTokensResponse`, `toolCallResponse`, the `'hang'` / `'hang-slow'` / `HangAfter` script entries.
- Data flow: Each model call consumes the next script entry and records its request.
- Non-obvious design decisions: `'hang-slow'` takes 50 ms to notice an abort — "a stand-in for slow real-world teardown (LLM stream cancellation, tool unwinding)".
- Edge cases / failure handling: An exhausted script throws; a chunk yield checks `signal.aborted` before every chunk.
- Surprising: The adapter also carries `systemPromptUpdate` and `toolUpdate` declarations, so a test can flip the *route's capabilities* and watch the loop's prompt-admission behaviour change.

### packages/core/agent/README.md
- Purpose: The public `Agent` contract, its registry and the `agent/*` vocabulary.
- Key abstractions: `Agent`, `AgentHandle`, `AgentFactory`, `AgentStatus`, `PreStepDecision`, `Inbox`, `AgentEventDispatch`.
- Data flow: `ctx.agents.create()` / `.resume()` delegate to the registered factory and return a handle; the handle's `dispose()` is the only capability that can tear that agent down.
- Non-obvious design decisions: The package is deliberately *inert* until a driver registers a factory, so the driver stays swappable. "Initiator attribution is process-local and must be carried explicitly across workers, processes, durable queues, and restarts." The `AgentHandle` disposer is a capability; the factory provider is a *structural* co-owner.
- Edge cases / failure handling: "Creation listeners share the initialization lifetime" — an `agent/created` listener must not await `agent.whenIdle()`; `cancel()` clears the inbox unless `keepInbox`; each `UserMessage` carries exactly one `MessageSource`.
- Surprising: The Dev Note names the open directions (inter-agent channels beyond delegation; the reserved `'clear'`/`'compact'` start sources with no emitter yet).

### packages/core/agent/README.zh.md
- Purpose: Chinese translation of the agent package reference.
- Key abstractions: Same vocabulary, translated.
- Data flow: n/a.
- Non-obvious design decisions: Hash-paired with the English file.
- Edge cases / failure handling: n/a.
- Surprising: It keeps `guardMode`/`keepInbox` untranslated where they are code identifiers.

### packages/core/agent/README.i18n.yaml
- Purpose: Heading-section hash record for the agent README pair.
- Key abstractions: One hash pair per heading path.
- Data flow: Regenerated by `verify-translation-pairing --write`.
- Non-obvious design decisions: The Dev Note section is hashed separately because it is explicitly non-authoritative prose.
- Edge cases / failure handling: n/a.
- Surprising: The file doubles as a table of contents for the README.

### packages/core/agent/locale/en.json
- Purpose: English UI locale for the agent package.
- Key abstractions: `meta.title = "agent"`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: Minimal like the other packages' English locales.

### packages/core/agent/locale/zh.json
- Purpose: Chinese UI locale for the agent package.
- Key abstractions: `meta.title = "智能体管理"`, `meta.description`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/agent/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-agent` v0.2.1-rc.2.
- Key abstractions: No runtime `dependencies` at all — everything is a peer.
- Data flow: Peers: `dsh-llm`, `dsh-scope`, `dsh-session`, `dsh-session-projection`, `dsh-system-prompt`, `dsh-typert-protocol`, `dsh-util-values`, `dsh-workspace`, `cordis`.
- Non-obvious design decisions: The package depends on `dsh-workspace` (for the archive-admission family map) but not on `dsh-agent-loop` — the dependency direction is inverted on purpose so consumers never import the driver.
- Edge cases / failure handling: n/a.
- Surprising: A package with zero direct dependencies and nine peers — the contract is deliberately dependency-free.

### packages/core/agent/tsconfig.json
- Purpose: TypeScript project config for the agent package.
- Key abstractions: `rootDir: src`, `outDir: lib/types`.
- Data flow: References scope, llm, session, session-projection, system-prompt, typert, workspace.
- Non-obvious design decisions: `dsh-workspace` is referenced because the `turn` activity kind is *merged into* the workspace's map from this package.
- Edge cases / failure handling: n/a.
- Surprising: The type dependency on workspace runs in the opposite direction of the runtime one.

### packages/core/agent/tsdown.config.ts
- Purpose: Bundler config for the agent package.
- Key abstractions: One ESM entry, `dts: false`, `clean: false`.
- Data flow: Bundles `lib/types/index.js` into `lib/index.js`.
- Non-obvious design decisions: Byte-identical to four other core packages' configs.
- Edge cases / failure handling: n/a.
- Surprising: The uniformity is a deliberate "one build recipe" convention.

### packages/core/agent/src/index.ts
- Purpose: `AgentRegistry` — the live agent registry, the factory slot, and the process-local initiator scope.
- Key abstractions: `AgentRegistry extends Service`, `AgentEntry`, `InitiatorRun`, `AgentFactory`, `AgentHandle`, `CreateAgentOptions` / `ResumeAgentOptions`.
- Data flow: `create()` / `resume()` re-trace the registered factory through the *caller's* context (`getTraceable`) so ownership follows the caller; `withInitiator(agent, op)` installs an `AsyncLocalStorage` boundary; `enter()` / `announce()` split insertion from announcement.
- Non-obvious design decisions: The initiator scope is tracked with a **counted run chain** so teardown can "exclude the boundary chain that initiated this teardown from its own drain" (otherwise a service disposal inside a boundary would self-deadlock). The same `enter`/`announce` split as the session store, with the same "detach requested during creation waits for every awaited listener to settle" rule.
- Edge cases / failure handling: An agent whose id differs from its session id is rejected; a reentrant `announce` throws; a `Promise` with a failing `@@species` still releases its run (the observer is attached with `Promise.prototype.then.call` to avoid the overridable `then`).
- Surprising: `roots()` filters on *runtime* ownership, so a resumed fork may still be a root — durable lineage and runtime ownership are independent relations.

### packages/core/agent/src/runtime-types.ts
- Purpose: The public `Agent` surface and every `agent/*` event declaration.
- Key abstractions: `AgentOptions`, `CancelOptions`, `Inbox`, `AgentStatus`, `PreStepDecision`, `RequestErrorAction`, `SessionStartSource`, `AssistantStreamFrame`.
- Data flow: Declares the events `agent/created` (serial), `agent/disposed`, `agent/status`, `agent/inbox/inserted|claimed|discarded`, `agent/pre-step` (waterfall), `agent/request` (waterfall), `agent/request-error` (waterfall), `agent/assistant-stream` (emit), `agent/turn-stopping` (serial), `agent/error` (emit).
- Key abstractions (dispatch modes): Each declaration names its mode explicitly (`@mode serial|waterfall|emit|parallel`), which is the repo's discipline for event contracts.
- Non-obvious design decisions: `agent/turn-stopping` is "Data decides, so listener order cannot change the outcome" — a listener objects by *steering*, and the machine re-reads its inbox; the inverse control (stop a tool loop early) is also data, via a tool result carrying `concludesTurn`.
- Edge cases / failure handling: `agent/request` "cannot mutate messages" — model-visible content must use logged channels; `agent/created` listeners must not await `agent.whenIdle()`.
- Surprising: `AssistantStreamFrame` types are declared as a *process-local* union with a `revision` counter that is "Monotone within one attached Agent lifecycle; replacement restarts at 1".

### packages/core/agent/src/types.ts
- Purpose: The durable agent vocabulary shared with type-only consumers.
- Key abstractions: `Agent` (the public minimal shape), `InboxTarget`, `InboxState`, `InboxWireState`, `TurnBoundaryProjection`, the `agent/inbox/spliced` event declaration.
- Data flow: Merges `SessionEventMap` with `agent/inbox/spliced` and merges `SessionActivityKindMap` with `turn`.
- Non-obvious design decisions: `InboxWireState` exists because the full `UserMessage` type "cannot cross a typert Remote boundary (its source union carries an `unknown` replay field)" — a JSON-safe projection table entry is kept alongside the typed state.
- Edge cases / failure handling: The `turnBoundary` key is registered by `dsh-agent-loop`; its absence is "capability absence, not a corrupt state".
- Surprising: The `Agent` interface is *augmented* from `runtime-types.ts` via module declaration merging — the public shape is split across two files.

### packages/core/agent/src/dispatch.ts
- Purpose: The fused agent-scoped dispatcher and the prompt-assembly context builder.
- Key abstractions: `agentEvents(ctx, agent, carrier?)`, `agentCarrier`, `emitAgentEvent`, `assembleContextFor`, `AgentSubjectEvent` (the type-level set of agent-subject events).
- Data flow: `emit` resolves the callback set itself and contains both sync throws and async rejections; `serial` and `waterfall` forward to Cordis with the scope carrier as `thisArg`.
- Non-obvious design decisions: The subject is *injected* by the dispatcher (the spread comes first, so a payload that happens to carry an `agent` field cannot override it) so the scope key and the payload's subject can never diverge. The `AgentSubjectEvent` type requires both a payload carrying `agent` **and** a `Scoped<Agent>` `this`, which excludes accidental events.
- Edge cases / failure handling: Cordis's own `emit` uses `Array.map`, where one synchronous throw starves later listeners — so the dispatcher resolves and contains the callback set itself.
- Surprising: The loop builds the dispatcher **once** in the agent's constructor so hot-path dispatches never allocate.

### packages/core/agent/src/consumed-work.ts
- Purpose: Folding one agent log into an account of the work it consumed.
- Key abstractions: `ConsumedWork { end?, droppedUnrun }`, `foldConsumedWork(events)`.
- Data flow: Walks `turn/start`, `step/start`, `agent/inbox/spliced` and `turn/end`; a turn counts when it entered a step, or when it *claimed* inbox input and then ended in a way that accounts for it.
- Non-obvious design decisions: "A turn that stops before its first step leaves a `turn/end` shaped exactly like the balanced no-op turns" — so the inbox's own record (`removedCount` + `outcome: 'canceled'`) is the missing fact. Only `completed` does **not** account for a claim: a completed turn had nothing left to run once its claim was rewritten away.
- Edge cases / failure handling: A replacement splice keeps the work pending under a new identity, so only a cancellation that leaves nothing behind drops it. An unnameable `TurnEndReason` variant "must not read as success" — the default arm returns `true` (accounts for it).
- Surprising: "no caller has to sample live state before cancelling, so a cancellation issued by anyone reads the same" — the fold works on the log alone.

### packages/core/agent/src/model-selection.ts
- Purpose: Coupling one mutable model selection to prompt assembly and request routing.
- Key abstractions: `ModelSelection`, `ModelSelectionRef { current, assembled }`, `installModelSelection(agentCtx, selection)`.
- Data flow: A `system-prompt/assemble` listener snapshots the selection *before* delegating and injects `provider`/`model` variables; an `agent/request` listener replaces the route and strips any inherited effort; an `agent/pre-step` listener (prepended) appends a model-switch notice when the route differs from the logged header.
- Non-obvious design decisions: The selection is captured at *assembly* and applied to the *same* step's request, so "a concurrent switch takes effect on a later step instead of splitting the two surfaces". An absent effort *clears* an inherited one, restoring the selected model's provider default.
- Edge cases / failure handling: Effort-only changes add no notice; a failure before header persistence repeats the notice on the next request.
- Surprising: The notice text is `[model changed: assistant turns above this point were generated by <previous>; the session continues with <next>]` — the model is told, in the transcript, that its own earlier turns came from a different model.

### packages/core/agent/src/archive-admission.ts
- Purpose: The `turn` family of the Workspace registry's archive admission.
- Key abstractions: `installTurnArchiveAdmission(ctx, lookup)`.
- Data flow: Answers `workspace/session-activity` with `{ kind: 'turn' }` when the session's agent is `running`; answers `workspace/session-stop` with `agent.cancel({ kind: 'user' })`.
- Non-obvious design decisions: The stop deliberately omits the stop button's `keepInbox`, "so queued input is discarded with a logged inbox splice instead of waking the archived Session later".
- Edge cases / failure handling: A session without a live agent has no turn that could run; nothing is awaited to settlement.
- Surprising: 38 lines that give the workspace UI a live "this session is busy" signal for *every* agent the registry publishes.

### packages/core/agent/src/projection.ts
- Purpose: A type-only module that declares the `turnBoundary` projection state.
- Key abstractions: `SessionProjectionStateMap.turnBoundary: TurnBoundaryProjection`.
- Data flow: The key is registered by `dsh-agent-loop`; this file only merges the type.
- Non-obvious design decisions: The declaration lives in `dsh-agent` while the *definition* lives in `dsh-agent-loop` — the contract is here, the implementation there.
- Edge cases / failure handling: n/a.
- Surprising: An 11-line file whose only content is a module augmentation plus `export {}`.

### packages/core/agent/tests/agent.spec.ts
- Purpose: The `AgentRegistry` contract (16 KB, 382 lines).
- Key abstractions: `register`, `enter`, `announce`, `get`, `list`, `roots`, `isOwnedBy`.
- Data flow: Registers stub agents and observes the lifecycle events.
- Non-obvious design decisions: Runtime creator ownership is tracked *separately* from registry order; the Typert lookup and context provider are registered under `inject(['typert'])`.
- Edge cases / failure handling: A duplicate id is rejected; disposal of the registering fiber unregisters the agent and emits `agent/disposed`.
- Surprising: `expectTypeOf` assertions confirm the public `Agent` shape is exactly what consumers see.

### packages/core/agent/tests/agent-initiator.spec.ts
- Purpose: The initiator scope's semantics (9.7 KB).
- Key abstractions: `withInitiator`, `withoutInitiator`, `currentInitiator`, `requireInitiator`.
- Data flow: Nested boundaries, thrown operations, and disposal.
- Non-obvious design decisions: "Teardown rejects new boundaries, lets returned-Promise boundaries drain, then disables the underlying storage" — a three-state machine (`active` / `closing` / `disposed`).
- Edge cases / failure handling: A branded Promise whose `@@species` blocks observer construction is still released; a boundary that returns service disposal does not self-deadlock.
- Surprising: The drain excludes the *owning* boundary chain from its own wait — otherwise disposal inside a boundary would wait for itself.

### packages/core/agent/tests/consumed-work.spec.ts
- Purpose: `foldConsumedWork` cases (7 KB).
- Key abstractions: The claim / cancel / step event shapes the fold reads.
- Data flow: Builds logs with `accept`, `claim`, `cancelPending` and `steppedTurn` helpers.
- Non-obvious design decisions: The helpers mirror the inbox's own splices exactly, so the fold is tested against the real wire format.
- Edge cases / failure handling: A turn that claimed its input and then failed before any step is reported as the accounting turn.
- Surprising: The comment "the step boundary runs the durability checkpoint and prompt assembly, so a turn can take its input and then fail without entering a step" explains the `claimed` path.

### packages/core/agent/tests/model-selection.spec.ts
- Purpose: `installModelSelection` cases (7 KB).
- Key abstractions: The three scoped listeners the installer registers.
- Data flow: Changes the selection and observes the prompt variables, the request route and the notice message.
- Non-obvious design decisions: The installer returns a single disposer for all three listeners.
- Edge cases / failure handling: No notice for an initial selection, a same-route change, an effort-only change, a rejected step, an aborted step or a disposed step; an empty tool continuation *is* announced.
- Surprising: The "no-call decisions" carve-out exists because the loop skips an empty first step.

### packages/core/agent/tests/archive-admission.spec.ts
- Purpose: The `turn` activity family and stop behaviour (3.7 KB).
- Key abstractions: `workspace/session-activity` (waterfall) and `workspace/session-stop` (parallel).
- Data flow: Asks the waterfall for the activity list and fires the stop.
- Non-obvious design decisions: The family is *prepended* so it is ahead of later providers; a second family (`probe`) is merged in the test to observe ordering.
- Edge cases / failure handling: An idle agent and an unknown session produce no `turn` family; after the registry fiber is disposed the listeners stop answering.
- Surprising: The test's own comment states the design: "The registry knows only its own family; this suite merges a second one to observe ordering."

### packages/core/agent/tests/verify-export-jsdoc.spec.ts
- Purpose: Negative-path tests for the exported-API JSDoc gate (20 KB, 561 lines).
- Key abstractions: `collectExportJsdocViolations(root)`.
- Data flow: Writes fixture `packages/group/fix/src/*.ts` trees and scans them.
- Non-obvious design decisions: The gate only scans declarations *reachable from the package entrypoints* — a package without `src/*` exports is limited to its public surface.
- Edge cases / failure handling: A documented API passes; a missing `@param`/`@returns` fails; `void` needs no `@returns`.
- Surprising: This is the mechanism that keeps the "every exported function documents its contract" discipline enforceable.

### packages/core/agent-default-model/README.md
- Purpose: The deployment-level default model selection service.
- Key abstractions: `ctx.agentDefaultModel`, `currentSelection()`, `saveSelection()`.
- Data flow: `currentSelection()` samples the live Volatile Config references; `saveSelection()` writes through the config editor to the owning profile entry.
- Non-obvious design decisions: "The service does not validate catalog membership; the consumer opening a model request owns availability diagnostics." Saves are serialised in submission order and a rejected write does not block later saves.
- Edge cases / failure handling: Without a config editor `saveSelection()` is a no-op; a deployment without a settings service still reads the live references.
- Surprising: The KV-cache section notes that changing the default affects only *subsequently* resolved agents — an existing session keeps its logged selection.

### packages/core/agent-default-model/README.zh.md
- Purpose: Chinese translation of the default-model reference.
- Key abstractions: Same API names, translated.
- Data flow: n/a.
- Non-obvious design decisions: Hash-paired with the English file.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/agent-default-model/README.i18n.yaml
- Purpose: Heading-section hash record for the default-model README pair.
- Key abstractions: One hash pair per heading path.
- Data flow: Regenerated by `verify-translation-pairing --write`.
- Non-obvious design decisions: The `kv-cache-effect` heading is a separate hashed section.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/agent-default-model/locale/en.json
- Purpose: English UI locale for the default-model package.
- Key abstractions: `meta.title = "agent-default-model"`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/agent-default-model/locale/zh.json
- Purpose: Chinese UI locale for the default-model package.
- Key abstractions: `meta.title = "默认模型"`, `meta.description`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/agent-default-model/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-agent-default-model` v0.2.1-rc.2.
- Key abstractions: `deps: schemastery, dsh-config-editor`; peers: `dsh-agent`, `dsh-llm`, `cordis`.
- Data flow: The package merges the `ModelSelection` shape from `dsh-agent` into its own read model.
- Non-obvious design decisions: `dsh-config-editor` is a *hard* dependency even though the README says the service works without one — the import is needed for the type.
- Edge cases / failure handling: n/a.
- Surprising: A 97-line package with a full README, a locale pair and an i18n hash record.

### packages/core/agent-default-model/src/index.ts
- Purpose: `AgentDefaultModelConfig` — the live default selection and its profile-backed persistence.
- Key abstractions: `Config { provider, model, reasoningEffort }` all `Volatile`, `currentSelection()`, `saveSelection(next)`.
- Data flow: The constructor injects `settings` and configures it with `{ auto: false }`; `saveSelection` serialises writes through `this.saves = saved.catch(() => {})`.
- Non-obvious design decisions: Saves commit in submission order and each caller observes its own failure; `currentSelection()` returns a *detached* value so a captured selection stays stable while the config moves.
- Edge cases / failure handling: No `configEditor` → no-op; no fiber entry → no-op.
- Surprising: `reasoningEffort` is `Volatile<string | undefined>` so a saved selection *without* it removes the field from the profile's complete config override.

### packages/core/agent-default-model/tests/agent-default-model.spec.ts
- Purpose: The default-model service's read/write contract (3.7 KB).
- Key abstractions: `liveConfig`, `configurationFixture`.
- Data flow: Updates the live config, reads `currentSelection()`, and saves through the config editor.
- Non-obvious design decisions: "Default model references remain live without a settings service" — the first test's title states the guarantee.
- Edge cases / failure handling: A rejected write rejects *its* caller and a later save still succeeds; a standalone context without a profile keeps its composition entry.
- Surprising: The test asserts that a rejected write does not change `currentSelection()` — a failed save leaves no partial state.

### packages/core/agent-default-model/tsconfig.json
- Purpose: TypeScript project config for the default-model package.
- Key abstractions: `rootDir: src`, `outDir: lib/types`.
- Data flow: References cordis, schemastery, agent, llm, config-editor, settings.
- Non-obvious design decisions: The `dsh-settings` and `dsh-config-editor` references make the optional-dependency contract explicit at the type level.
- Edge cases / failure handling: n/a.
- Surprising: `include: ["src"]` again — tests are not part of the type project.

### packages/core/agent-default-model/tsdown.config.ts
- Purpose: Bundler config for the default-model package.
- Key abstractions: One ESM entry, `dts: false`, `clean: false`.
- Data flow: Bundles `lib/types/index.js` into `lib/index.js`.
- Non-obvious design decisions: Byte-identical to the agent/agent-loop/scope/session configs.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/agent-tool-presentation/README.md
- Purpose: The agent-plane tool-presentation selector row (6 KB).
- Key abstractions: `mode: 'native' | 'ptc'`, `ctx.tools.presentAs(mode)`.
- Data flow: `apply()` declares the mode for the *mounting scope*; a `ptc` row waits for `ctx.ptcRuntime` before declaring.
- Non-obvious design decisions: "One presentation per agent" — a second declaration is refused rather than merged, "two answers to 'which form does the model see' is a contradiction, not an override". The mode is *required* rather than defaulted, because a preset without the row already inherits the deployment default.
- Edge cases / failure handling: A `ptc` preset against a deployment with no PTC runtime "refuses to mount, naming this row, so the failure lands where the operator can act instead of at the session's first request".
- Surprising: The registry stays on the host plane; only the *presentation* can be preset-owned.

### packages/core/agent-tool-presentation/README.zh.md
- Purpose: Chinese translation of the presentation-selector reference.
- Key abstractions: Same `mode` vocabulary, translated.
- Data flow: n/a.
- Non-obvious design decisions: Hash-paired with the English file.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/agent-tool-presentation/README.i18n.yaml
- Purpose: Heading-section hash record for the presentation-selector README pair.
- Key abstractions: One hash pair per heading path.
- Data flow: Regenerated by `verify-translation-pairing --write`.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/agent-tool-presentation/locale/en.json
- Purpose: English UI locale for the presentation-selector package.
- Key abstractions: `meta.title = "agent-tool-presentation"`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/agent-tool-presentation/locale/zh.json
- Purpose: Chinese UI locale for the presentation-selector package.
- Key abstractions: `meta.title = "工具调用方式"`, `meta.description`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: The Chinese description names both native and PTC explicitly.

### packages/core/agent-tool-presentation/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-agent-tool-presentation` v0.2.1-rc.2.
- Key abstractions: `deps: schemastery`; peers: `dsh-tools`, `cordis`.
- Data flow: Only `dsh-tools` is needed — the row is a thin wrapper over `presentAs`.
- Non-obvious design decisions: No `dsh-ptc-runtime` peer: "a `native` row must mount in a deployment that composes no runtime, and the mode-dependent wait is declared inside `apply`".
- Edge cases / failure handling: n/a.
- Surprising: The optional runtime is expressed as a nested `ctx.inject` rather than a peer dependency.

### packages/core/agent-tool-presentation/src/index.ts
- Purpose: The presentation row plugin.
- Key abstractions: `name = 'tool-presentation'`, `inject = ['tools']`, `Config`, `apply(ctx, config)`.
- Data flow: `native` calls `ctx.tools.presentAs('native')` directly; `ptc` defers to a `ctx.inject(['ptcRuntime'])` block that calls `presentAs('ptc')` in the runtime's context.
- Non-obvious design decisions: "`presentAs` is itself the effect — it registers through the calling context and hands back that exact disposer — so the declaration unwinds with this row without a second wrapper owning it."
- Edge cases / failure handling: A `ptc` row against a deployment with no runtime fails at mount, where a preset's activation audit can name it.
- Surprising: The file's header comment is a design essay: the tool registry *cannot* move into a preset because the loop's scheduler and the API proxy's presenters are its consumers.

### packages/core/agent-tool-presentation/tests/agent-tool-presentation.spec.ts
- Purpose: The presentation row's scope behaviour (5.5 KB).
- Key abstractions: A `StubRuntime` that never runs anything, and a `mount(ctx, config, id)` helper that mounts the row inside a `createScope(host, agent)` context.
- Data flow: Mounts the row under one agent's scope and asserts the mode reaches that agent only.
- Non-obvious design decisions: The file's header states the contract: "the choice reaches THIS agent and no other, it unwinds with the agent, and a code mode composed against a deployment with no PTC runtime stops at mount".
- Edge cases / failure handling: A second declaration for the same agent is refused; an unscoped declaration is refused.
- Surprising: The `StubRuntime` exists so presentation can be tested without ever executing a program.

### packages/core/agent-tool-presentation/tsconfig.json
- Purpose: TypeScript project config for the presentation-selector package.
- Key abstractions: `rootDir: src`, `outDir: lib/types`.
- Data flow: References cordis, cosmokit, schemastery and `dsh-tools` only.
- Non-obvious design decisions: The reference list is the smallest in the repo — the row is deliberately a leaf.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/scope/README.md
- Purpose: The scoped-registration library reference (6.3 KB).
- Key abstractions: `createScope`, `scopeOf`, `scopeTarget`, `bindScopeParent` / `scopeParentOf` / `scopeChainOf`, `ScopedLayers`, `NamedEntries`, `AnonymousEntries`.
- Data flow: A scope mints a Cordis sub-context tagged with an opaque key; registrations through it are scope-visible and scope-owned; `scopeTarget` builds the routing carrier for a scope-filtered event.
- Non-obvious design decisions: One relation powers both directions: registration views inherit **down** the chain, event admission extends **up** it. Binding is once — a key that already has a parent throws and only the returned binding may re-link it; every link rejects a cycle. "The primitive routes trusted same-process plugins; it is not a sandbox or an authority boundary."
- Edge cases / failure handling: `scopeTarget` composes the base's existing Cordis filter with the scope predicate; `key === undefined` admits untagged listeners only; `{ global: true }` listeners bypass filtering.
- Surprising: "Handing out a scoped context also hands out the minting plugin's service-resolution API (resolution walks the minting fiber's dependency chain), so a scope is minted from the plugin whose dependencies the scoped registrations need."

### packages/core/scope/README.zh.md
- Purpose: Chinese translation of the scope library reference.
- Key abstractions: Same API names, translated.
- Data flow: n/a.
- Non-obvious design decisions: Hash-paired with the English file.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/scope/README.i18n.yaml
- Purpose: Heading-section hash record for the scope README pair.
- Key abstractions: One hash pair per heading path.
- Data flow: Regenerated by `verify-translation-pairing --write`.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/scope/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-scope` v0.2.1-rc.2.
- Key abstractions: Zero dependencies, one peer (`cordis`).
- Data flow: n/a.
- Non-obvious design decisions: "Use this dependency-free library when per-agent or per-group isolation must work without depending on the agent loop or presets."
- Edge cases / failure handling: n/a.
- Surprising: The only package in the core group with no `dsh-*` dependency at all.

### packages/core/scope/src/index.ts
- Purpose: The scoped-context primitive and the event carrier.
- Key abstractions: `ScopeKey` (an opaque object), `Scoped<T>` (a branded carrier), `ScopeParentBinding`, `Scope`.
- Data flow: `createScope(ctx, key, { parent? })` mints a Cordis fiber, extends its context with the scope tag, and returns `{ ctx, rawDispose, dispose }` where `dispose` is a shared quiescent promise and `rawDispose` is the exact Cordis disposer.
- Non-obvious design decisions: The carrier is a *routing-only* object: it does not expose the subject's properties, and the real subject travels in the event arguments. `quiesceFiber` follows `fiber.inertia` so a scope's teardown completes even if its raw disposer was already claimed.
- Edge cases / failure handling: `bindScopeParent` refuses a second parent and refuses a cycle; `scopeTarget` preserves the base's filter; `isScopeCarrier` / `carrierKeyOf` distinguish a carrier from a plain object.
- Surprising: The `Scoped<T>` brand makes the carrier a *compile-time* requirement of a scope-filtered event — "dispatching with a bare subject is a compile error".

### packages/core/scope/src/store.ts
- Purpose: Insertion-ordered storage and effect ownership for scope-aware registries.
- Key abstractions: `NamedEntries`, `AnonymousEntries`, `ScopedLayers`, `ScopeLayer`.
- Data flow: `ScopedLayers.effect(ctx, action, { label, notify })` derives both visibility and ownership from the *same* context, collects the undo before notifying, and reclaims a scoped layer only when its whole aggregate is empty.
- Key abstractions (lifecycle): `merge(scope, pick)` materialises global entries followed by scope-chain shadows, farthest ancestor first, so the nearest scope wins a name. `peek(scope)` is deliberately chain-blind.
- Non-obvious design decisions: Reads never create a scoped layer; a failed action on a newly created empty layer removes it again.
- Edge cases / failure handling: Each successful insertion returns an idempotent undo for that exact entry; a drained table starts a fresh iterator generation.
- Surprising: `AnonymousEntries` gives equal values independent registration identity (a `Symbol` key per append) — two identical tool providers are two registrations, not one.

### packages/core/scope/tests/scope.spec.ts
- Purpose: `createScope` and `scopeTarget` behaviour (8.6 KB).
- Key abstractions: The scope tag, the carrier filter, the parent chain.
- Data flow: Mints scopes, dispatches events, and observes which listeners hear them.
- Non-obvious design decisions: The scope is usable *synchronously* before the backing fiber activates; repeat `dispose()` and `rawDispose()`-first calls share one quiescence.
- Edge cases / failure handling: A cycle is rejected; re-linking requires the binding held by the original binder; an ancestor-tagged listener is admitted for a descendant dispatch, never the reverse.
- Surprising: The carrier's key is tracked separately from the carrier object, so the branded type and the runtime lookup are two different mechanisms.

### packages/core/scope/tests/store.spec.ts
- Purpose: The scope-aware storage primitives (9.4 KB).
- Key abstractions: `NamedEntries`, `AnonymousEntries`, `ScopedLayers`.
- Data flow: Inserts, iterates, undoes and merges.
- Non-obvious design decisions: The scoped layer is created lazily but reclaimed only when its *aggregate* is empty; the context effect disposer is returned with exact identity so a composite yield nests the teardown in order.
- Edge cases / failure handling: A throwing notification rolls the insertion back; a failed factory or failed action does not discard an existing layer.
- Surprising: "Runs action, notification, undo, and disposal notification in order" — the ordering is asserted, not assumed.

### packages/core/scope/tsconfig.json
- Purpose: TypeScript project config for the scope library.
- Key abstractions: `rootDir: src`, `outDir: lib/types`.
- Data flow: References only cosmokit and cordis.
- Non-obvious design decisions: The reference list proves the package is a leaf.
- Edge cases / failure handling: n/a.
- Surprising: The only core package whose tsconfig references no `dsh-*` project.

### packages/core/scope/tsdown.config.ts
- Purpose: Bundler config for the scope library.
- Key abstractions: One ESM entry, `dts: false`, `clean: false`.
- Data flow: Bundles `lib/types/index.js` into `lib/index.js`.
- Non-obvious design decisions: Byte-identical to the other core configs.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/system-prompt/README.md
- Purpose: The prompt-assembly package reference (13.7 KB).
- Key abstractions: `ctx.systemPrompt`, `PromptSection`, `PromptContext`, `PromptAssembly`, `toolOrder`, `complete` sections.
- Data flow: `assemble()` merges global and scoped layers, detaches tool parameters, canonicalises section order (number, then code-unit name), runs the scope-filtered `system-prompt/assemble` waterfall, restores an effective complete section, and applies any runtime-context suppressor. `renderPrompt()` interpolates `{{variable}}` references, drops empty sections and joins with blank lines.
- Non-obvious design decisions: Sections and dynamic contexts are *separate inputs* — sections become prompt text, contexts become sourced user-role snapshots in history. `toolOrder` canonicalises the collected tools **before** the waterfall because "registration order is a plugin-load artifact". "a malformed prompt is worse than a loud failure" — an unknown, valueless or malformed variable reference throws.
- Edge cases / failure handling: More than one effective complete section fails assembly; a `toolOrder` entry naming an unregistered tool rejects every `assemble()`; `refreshContext` restores missing *required* contexts in registry order.
- Surprising: The KV-cache section spells out the whole prompt-update decision rule — a head rewrite loses prefix reuse from its first changed token, while an in-history append keeps the prefix through the cached history reusable.

### packages/core/system-prompt/README.zh.md
- Purpose: Chinese translation of the system-prompt reference.
- Key abstractions: Same vocabulary, translated.
- Data flow: n/a.
- Non-obvious design decisions: Hash-paired with the English file.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/system-prompt/README.i18n.yaml
- Purpose: Heading-section hash record for the system-prompt README pair.
- Key abstractions: One hash pair per heading path.
- Data flow: Regenerated by `verify-translation-pairing --write`.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/system-prompt/locale/en.json
- Purpose: English UI locale for the system-prompt package.
- Key abstractions: `meta.title = "system-prompt"`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/system-prompt/locale/zh.json
- Purpose: Chinese UI locale for the system-prompt package.
- Key abstractions: `meta.title = "系统提示词组装"`, `meta.description`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/system-prompt/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-system-prompt` v0.2.1-rc.2.
- Key abstractions: `deps: schemastery`; peers: `dsh-llm`, `dsh-scope`, `cordis`.
- Data flow: The package is a registry over the scope library; it does not depend on tools (the tool provider is injected by `ToolRuntime`).
- Non-obvious design decisions: No `dsh-tools` dependency — the tool-schema provider is a *callback*, so the prompt package never learns the tool API.
- Edge cases / failure handling: n/a.
- Surprising: The package that renders the tool schemas does not know what a tool is.

### packages/core/system-prompt/src/index.ts
- Purpose: The `SystemPrompt` service — the registry and the assembly pipeline.
- Key abstractions: `PromptLayer`, `ScopedLayers`, `PromptSection` / `PromptContext` / `AssembledSection` / `AssembledContext`, `PromptAssembly`, `renderPrompt`, `renderContextSections`, `joinContextSections`, `renderContextSnapshot`, `SECTION_ORDERS` / `CONTEXT_ORDERS`, `TOOL_ORDER_REST`.
- Data flow: `assemble(context)` → global variables, then scope-chain variables farthest-first so the nearest scope wins → merged sections and contexts → tool providers evaluated and their parameters detached → sections sorted by (order, name) → the `system-prompt/assemble` waterfall → complete-section restoration and context suppression. `refreshContext(assembly, context)` re-reads only the context providers.
- Non-obvious design decisions: `interpolate` uses a strict `{{name}}` grammar: a lone `{{` with no later `}}` is literal prose, but a malformed group throws; substituted values are **not** re-scanned; `Object.hasOwn` is used so `{{constructor}}` is unknown. `renderContextSections` returns the *named* contributions so a consumer can attribute each part without re-splitting the joined prose, and `joinContextSections` prefixes the snapshot with a supersession notice.
- Edge cases / failure handling: Two effective complete sections fail assembly; a duplicate section name throws (a double-loaded plugin must fail, not double its text); a non-finite order is rejected; a `system-prompt/change` listener that throws rolls the registration back.
- Surprising: `refreshContext` explicitly does **not** re-run the waterfall or the providers — "Sections, tools, and interpolation variables retain the accepted assembly; their providers and waterfall do not rerun."

### packages/core/system-prompt/tests/system-prompt.spec.ts
- Purpose: The prompt assembly contract (38 KB, 56 cases).
- Key abstractions: `assemble`, `refreshContext`, `renderPrompt`, the variable registry.
- Data flow: Registers sections, contexts, variables and tool providers; asserts the rendered prompt and the assembly shape.
- Non-obvious design decisions: "keeps repository section placements unique, integral, and at least ten apart" — a *test* enforces a global order-spacing discipline for first-party sections. "keeps reusable instructions identical across local environments" — the reusable block must not vary by machine.
- Edge cases / failure handling: Unknown, valueless and malformed variable references all throw, with the contributor named; `{{constructor}}` is rejected while a *registered* prototype-named variable works.
- Surprising: "never re-scans substituted values (a value containing `{{sneaky}}` stays literal)" — a deliberate one-pass interpolation.

### packages/core/system-prompt/tests/scoped.spec.ts
- Purpose: Scoped prompt contributions (11.7 KB).
- Key abstractions: Scope-chain shadowing for sections, variables, contexts and tool providers.
- Data flow: Registers through `agent.ctx` and asserts the shadowing and the cleanup.
- Non-obvious design decisions: A scoped persona shadows `deployment:persona-prefix` for that scope only, in either registration order; a scoped section shadows a global *before* either text provider is evaluated.
- Edge cases / failure handling: Duplicate names throw per layer; a scoped tool provider is consulted only for its scope; a `toolOrder` entry restricted away for a scope is a normal absence while a typo still throws.
- Surprising: "a toolOrder entry restricted away for a scope is a normal absence, while a typo still throws" — the two look identical to a naive reader but must behave differently.

### packages/core/system-prompt/tests/tool-order.spec.ts
- Purpose: The canonical model-facing tool order (5.7 KB).
- Key abstractions: `TOOL_ORDER_REST = '<unlisted-tools>'`.
- Data flow: Registers tool providers and reads the assembled order.
- Non-obvious design decisions: "the ONE place the public constant's value is pinned; everything else (tests and deployment configs alike) references `TOOL_ORDER_REST`" — the string value is asserted in exactly one test so it can change without a shotgun edit.
- Edge cases / failure handling: The rest entry sorts lexicographically among the unlisted tools; a list without exactly one rest entry or with duplicates fails at load.
- Surprising: Two providers registering the same tools in opposite orders produce the same assembled order — registration order is invisible downstream.

### packages/core/system-prompt/tsconfig.json
- Purpose: TypeScript project config for the system-prompt package.
- Key abstractions: `rootDir: src`, `outDir: lib/types`.
- Data flow: References cordis, cosmokit, schemastery, llm and scope.
- Non-obvious design decisions: `dsh-llm` is referenced for the `ToolSchema` type only.
- Edge cases / failure handling: n/a.
- Surprising: No `dsh-tools` reference — the tool boundary really is a callback.

### packages/core/tools/README.md
- Purpose: The tool registry and execution pipeline reference (20.5 KB).
- Key abstractions: `defineTool`, `ctx.tools`, the `mode: native | ptc` config, `ctx.tools.restrict`, `ctx.tools.guard`, the five pipeline events.
- Data flow: `tools/pre-execute` (extensible allow/deny/ask) → registered monotonic guards → `tools/execute` (around-dispatch) → `tools/post-execute` (inspect/replace, attach context) → definition-owned `finalizeContent` → the observe-only `tools/result` event.
- Non-obvious design decisions: "Only the `tools/execute` view may replace the required signal, and the registry re-fuses the caller signal before the body." A `ptc`-mode collapse denies a model-direct native-tool call *before* the policy pipeline, so "pre-execute listeners, approval `ask`, and guards must never observe — or worse, approve — a call that can only fail". The canonical value belongs to execution; the Session records rendered content and optional presentation metadata instead.
- Edge cases / failure handling: Cancellation before the body is `ABORTED_BEFORE_DISPATCH`; after invocation it replaces only a *successful* outcome with `ABORTED`; denials, wrapper failures, tool failures, post-policy failures and `TOOL_TIMEOUT` stay more specific. Unknown and throwing tools become structured errors (`UNKNOWN_TOOL`) so a call fails without ending the turn.
- Surprising: The README's Model Experience section reproduces the *entire* generated PTC SDK instructions inline — the prompt text is a reviewable artifact with a stated token cost.

### packages/core/tools/README.zh.md
- Purpose: Chinese translation of the tools reference.
- Key abstractions: Same vocabulary, translated.
- Data flow: n/a.
- Non-obvious design decisions: Hash-paired with the English file.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/tools/README.i18n.yaml
- Purpose: Heading-section hash record for the tools README pair.
- Key abstractions: One hash pair per heading path.
- Data flow: Regenerated by `verify-translation-pairing --write`.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/tools/locale/en.json
- Purpose: English UI locale for the tools package.
- Key abstractions: `meta.title = "tools"`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/tools/locale/zh.json
- Purpose: Chinese UI locale for the tools package.
- Key abstractions: `meta.title = "工具注册与执行"`, `meta.description`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/core/tools/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-tools` v0.2.1-rc.2.
- Key abstractions: Nine peers: cordis, dsh-agent, dsh-ptc-runtime, dsh-llm, dsh-scope, dsh-session, dsh-system-prompt, dsh-user-approval, dsh-sandbox, dsh-sandbox-policy, dsh-working-directory.
- Data flow: Deps are `dsh-brand`, `dsh-util-values`, `schemastery`.
- Non-obvious design decisions: `dsh-sandbox-policy` and `dsh-user-approval` are peers, so the tool registry can *ask* for approval and *observe* a sandbox mode without owning either.
- Edge cases / failure handling: n/a.
- Surprising: The tools package declares more peers than any other core package — it is the integration point.

### packages/core/tools/tsconfig.json
- Purpose: TypeScript project config for the tools package.
- Key abstractions: `rootDir: src`, `outDir: lib/types`.
- Data flow: References session, ptc-runtime, cordis, cosmokit, schemastery, llm, system-prompt, agent, scope, user-approval, sandbox, sandbox-policy, working-directory.
- Non-obvious design decisions: The reference list is the widest in the repo and matches the peer list exactly.
- Edge cases / failure handling: n/a.
- Surprising: The tools package references *itself* through `../../core/tools`? No — it references `../../core/agent` and `../../core/scope`; the self-reference is absent, which is the correct shape.

### packages/core/tools/src/index.ts
- Purpose: `ToolRuntime` — the registry and the five-stage execution pipeline (1993 lines).
- Key abstractions: `ToolDefinition`, `ToolExecutionInput` / `ToolExecution` / `ToolRunContext`, `ToolExecutionResult`, `ToolExecutionMode`, `ToolRestriction`, `ToolGuard`, `TOOL_RUNTIME_SCHEDULER`, `TOOL_ABORTED`, `TOOL_ABORTED_BEFORE_DISPATCH`, `ToolNotFoundError`, `ToolOutputError`.
- Data flow: `execute(exec)` → `createExecution` (mint a token, snapshot the arguments, capture the finalizer) → `prepareExecution` (caller-cancel check, `tools/pre-execute` waterfall, `ask` resolution, monotonic guards) → `dispatchScheduledExecution` (`tools/execute` waterfall around the body, signal re-fusion) → `finalizeScheduledExecution` (`projectContent`, `tools/post-execute`) → `finishScheduledExecution` (materialize, `finalizeContent`, `tools/result`).
- Non-obvious design decisions: The `finalizeContent` callback is captured **before** argument materialization, because an arguments getter can replace or clear the registered callback during the snapshot. A `ptc`-collapsed call is denied *before* policy and its denial names the route the model must take ("only `run_code` is callable directly"). A denial cannot be reversed: `denialReason = decision.kind === 'allow' ? this.guardReason(exec) : decision.reason`. Only the `tools/execute` view may replace the signal and the registry re-fuses the caller signal before the body.
- Edge cases / failure handling: Every failure mode becomes a frozen, structured `isError` result (`Error: <message>` content plus a structured `error`), never an exception escaping the pipeline; a throwing tool is normalised to `isError` *before* a `tools/execute` listener sees `next()`. `schemas()` projects only `name`, `description`, `parameters` and `deferLoading` — `output`, `execute`, `finalizeContent`, `timeoutMs` and presentation callbacks never reach the model.
- Surprising: `executionMode` is **fail-closed**: only an exact `true` from the tool's own classifier makes a call parallel-safe; unknown, hidden, undeclared, invalid, throwing or truthy-non-boolean all mean *exclusive*.

### packages/core/tools/src/types.ts
- Purpose: The durable PTC dispatch event vocabulary.
- Key abstractions: `PtcDispatchStartEventData`, `PtcDispatchEventData`, the `tool/ptc-dispatch-start` and `tool/ptc-dispatch` session events.
- Data flow: A started sub-dispatch records the pairing ids, the tool name and the JSON-normalised arguments; the settle event carries the sub-call's complete outcome in `tool/result`'s own vocabulary.
- Non-obvious design decisions: The start event is appended when the scheduler *actually starts* the call, not at submission — "a call abandoned in the queue logs nothing". Both events are log-only: `deriveMessages()` ignores them, so sub-calls never re-enter model context.
- Edge cases / failure handling: Every started sub-call settles with exactly one of these, abort included (the aborted pipeline result is an `isError` outcome).
- Surprising: The new sub-call id is `<parent>:ptc:<n>`, numbered in submission order; consumers treat these ids as opaque and correlate by exact equality.

### packages/core/tools/src/schema.ts
- Purpose: The author-facing schema DSL and the typed `defineTool` helper (632 lines).
- Key abstractions: `ValueSchemaSpec` (string/number/integer/boolean/null/array/object/json/oneOf), `ParameterSchemaSpec`, `InferValue`, `InferArgs`, `defineTool`, `parameterSchemaSpecToJsonSchema`, `validateArgs`.
- Data flow: The author DSL is compiled to a JSON Schema, which is both the wire schema and the runtime validator's source of truth.
- Non-obvious design decisions: "Openness is mandatory so a nested or output object never acquires an accidental JSON Schema default"; `json` is author-only and never reaches the wire; `InferValue` preserves exact types through 16 container levels before widening to `JsonValue`.
- Edge cases / failure handling: Runtime-forged author forms are rejected rather than compiled lossily; cyclic author schemas are rejected; deep unions are compiled without the JavaScript call stack.
- Surprising: A property literally named `__proto__` is preserved as schema data.

### packages/core/tools/src/json-schema.ts
- Purpose: The enforced raw JSON Schema subset shared by tool outputs, PTC types, subagents and workflows (656 lines).
- Key abstractions: `JsonSchemaNode`, `ObjectJsonSchema`, `assertSupportedJsonSchema`, `validateJsonSchemaValue`, `assertObjectJsonSchema`.
- Data flow: Every raw schema is validated at the boundary and then used to validate a value.
- Non-obvious design decisions: "Unsupported or misplaced keywords reject rather than being accepted without enforcement" — the subset is a *closed* vocabulary. Object-rootedness is a *consumer* concern, applied by `assertObjectJsonSchema`, not baked into the schema.
- Edge cases / failure handling: Every independent violation is reported, not just the first; hostile getters produce a violation rather than a throw; deep unions are validated without the JavaScript call stack; own-property semantics are used for `required`.
- Surprising: `assertNever` is kept as a *forged-schema* backstop, so a schema that slips past the checks still fails loudly.

### packages/core/tools/src/presentation.ts
- Purpose: The provider-neutral tool render-intent vocabulary (389 lines).
- Key abstractions: `ToolCallKind`, `FileLocation`, `FileDiff`, `ToolCallView` (`generic` / `terminal` / `diff`), `ToolResultView`.
- Data flow: A tool declares `presentCall()` / `presentResult()`; a UI bridge maps the intent without special-casing tool names.
- Non-obvious design decisions: "The built-in Web Client does not consume those values. It selects a renderer through `tool.call.toolview` and derives card props from raw call arguments, result content, failure state, and persisted metadata." A call-time presenter has no access to a file's prior content, so an overwrite uses `oldText: null`.
- Edge cases / failure handling: A malformed argument set makes the presenter return `undefined`, never throw — "display runs on replay".
- Surprising: The tagged `card` union is deliberately small so a new UI can render an unknown card generically.

### packages/core/tools/src/ptc.ts
- Purpose: The PTC-mode `run_code` transport (792 lines).
- Key abstractions: `RUN_CODE_NAME = 'run_code'`, `RunCodeFlavor`, the `run_code` schema per language, the sub-dispatch bridge.
- Data flow: A program calls `await tools.name(args)`; each call is bridged through the native scheduler, logged as a `tool/ptc-dispatch-start` / `tool/ptc-dispatch` pair, and only the outer curated result enters model history.
- Non-obvious design decisions: "The emitted flavor MUST match the semantics the same language's SDK instructions promise, so the model never receives a TypeScript schema beside a Python SDK (or vice versa)." The tool-call rules live in this package while the runtime owns evaluation syntax and state retention. A wider `sandbox_permissions` mode requires a non-empty `justification` and approval before the program starts, and the grant applies to that complete execution.
- Edge cases / failure handling: "Programs are never replayed automatically: inspect earlier effects before explicitly retrying a denied program." A successful image-bearing subcall result becomes deferred user-message context with `source.kind = 'ptc-mode'`; other additional contexts keep their producing tool's attribution.
- Surprising: Under `ptc` alone, a model-direct call naming any other visible tool resolves to `UNKNOWN_TOOL` *before* policy — "the announced surface and the callable surface stay the same".

### packages/core/tools/src/ptc-calls.ts
- Purpose: Cancellation and settlement of complete PTC calls, including nested tools (64 lines).
- Key abstractions: `PtcCalls`, the per-session `Map<SessionId, Set<Call>>`.
- Data flow: `run(sessionId, signal, mode, run)` waits for any *canceled* predecessor to finish, then admits the new call under the current standing mode. A `sandbox/mode` session event cancels every call whose recorded mode differs.
- Non-obvious design decisions: "Keeps calls under a changed policy from overlapping their canceled predecessors" — the new call waits for the old one to fully clean up before the new mode is read.
- Edge cases / failure handling: Caller cancellation while waiting rejects; disposal aborts every call and refuses late admission.
- Surprising: The mode is captured *after* the predecessor's cleanup, so a call never runs under a mode that was already superseded.

### packages/core/tools/src/py-types.ts
- Purpose: The Python flavour of the PTC SDK codegen (817 lines).
- Key abstractions: `jsonSchemaToPy`, `renderToolsSdkPy`, the XID-based identifier predicate.
- Data flow: Registered tool schemas → a Python module with one `TypedDict` per tool and per nested object.
- Non-obvious design decisions: The identifier predicate is stricter than `str.isidentifier()`: it additionally requires **NFKC stability**, because CPython normalises identifiers at compile time while JSON keys are compared as written — `ﬁeld` would be declared and reachable as `field`, so the SDK would advertise a key under a spelling the harness never accepts.
- Edge cases / failure handling: An object whose field name is not a legal Python attribute degrades to `dict[str, Any]`; a `__token` field name-mangles and degrades; a `__debug__` field is refused by CPython and degrades. Every underscore-leading tool name routes to subscript access.
- Surprising: The degradation is *total* — "unsupported or hostile constructs degrade to `Any`, never throw".

### packages/core/tools/src/ts-types.ts
- Purpose: The TypeScript flavour of the PTC SDK codegen (334 lines).
- Key abstractions: `ToolSdkSchema`, `jsonSchemaToTs`, `renderToolsSdk`.
- Data flow: Registered tool schemas → a `declare const tools` API with per-property JSDoc.
- Non-obvious design decisions: "Collapse prose to stable one-line docs and escape comment closers so a schema description cannot terminate generated JSDoc." An object without `additionalProperties: false` renders as `Record<string, JsonValue>`; a closed one as `Record<string, never>`.
- Edge cases / failure handling: A name that is not a bare identifier is quoted rather than aliased — "every name stays reachable, no aliasing".
- Surprising: This file and `py-types.ts` are "two projections of the same registry store", exactly as `schemas()` is a third.

### packages/core/tools/src/testing.ts
- Purpose: Canonical tool-definition fixtures for repository tests (42 lines).
- Key abstractions: `defineContentToolFixture`, `ContentToolFixtureOptions`.
- Data flow: Builds a `ToolDefinition` whose canonical JSON value *is* its content-block array.
- Non-obvious design decisions: "Product tools must declare domain-owned DTOs instead" — the fixture deliberately breaks the production rule so tests can express tools tersely.
- Edge cases / failure handling: n/a.
- Surprising: The fixture is exported from the package's public surface (`src/testing.ts`), so every core test uses the same shorthand.

### packages/core/tools/tests/tools.spec.ts
- Purpose: The tool registry and pipeline contract (112 KB, 146 cases).
- Key abstractions: The five pipeline events, the canonical-value contract, the approval routing.
- Data flow: Registers tools with `defineContentToolFixture` and asserts the materialised results, the frozen outcomes and the error identities.
- Non-obvious design decisions: "freezes core dispatch outcomes before around and post listeners can observe them"; a cached canonical result returned from a *different* dispatch is revalidated; an `ask` decision degrades to `deny` when no approval seam is mounted.
- Edge cases / failure handling: Cancellation is checked at every await boundary — "skips dispatch when caller cancellation arrives while pre-execute awaits", "rechecks caller cancellation after an async around-dispatch wrapper delegates", "waits for an uncooperative started body before returning `ABORTED`". A pre-execute denial short-circuits before `tools/execute` runs at all.
- Surprising: "let argument materialization failure win over a pre-aborted signal" — the more specific failure is reported.

### packages/core/tools/tests/ptc.spec.ts
- Purpose: PTC mode end to end (117 KB, 116 cases).
- Key abstractions: The mode-aware wire contribution, the sub-dispatch scheduler, the `run_code` bridge, per-agent presentation, sandbox outcomes, state ownership.
- Data flow: Mounts a runtime, registers tools, runs programs, and asserts the SDK text, the dispatch events and the durable content.
- Non-obvious design decisions: "renders byte-identical SDK text across consecutive assemblies of an unchanged tool set" — the codegen must be deterministic or the prefix cache breaks. "never exposes `run_code` to programs (no recursive dispatch path)". A model-direct native-tool call under PTC mode is denied with `UNKNOWN_TOOL` before policy.
- Edge cases / failure handling: A program-side call that fails rejects with the tool error text; an uncaught pre-execute deny fails the program "without changing the inner error identity"; a `__proto__` tool name is exposed as an ordinary own binding.
- Surprising: The per-agent presentation section proves a PTC-mode agent and a native agent can coexist in one process.

### packages/core/tools/tests/py-types.spec.ts
- Purpose: The Python SDK codegen contract (61 KB, 55 cases).
- Key abstractions: `jsonSchemaToPy`, `renderToolsSdkPy`.
- Data flow: Feeds schemas and asserts the emitted Python source.
- Non-obvious design decisions: "is deterministic: byte-identical output regardless of input order or duplication" and "renders a deeply nested oneOf chain in linear time (no per-level re-materialization)".
- Edge cases / failure handling: Class-name length is capped so a deep single-field chain stays linear; a surrogate half is dropped rather than cutting a pair; an unpaired surrogate is escaped so the source stays encodable.
- Surprising: Two tools that CamelCase to the same class base get a counter suffix, and a sibling that already occupies the counter is skipped.

### packages/core/tools/tests/scoped.spec.ts
- Purpose: Scoped registration, restriction and guard behaviour (28.6 KB, 30 cases).
- Key abstractions: `restrict`, `guard`, `ScopedLayers` interplay.
- Data flow: Registers tools and filters in scope layers and asserts the visible set per scope.
- Non-obvious design decisions: Restrictions compose by **intersection** and lift independently; a scoped restriction filters the tools the child *inherits* from an ancestor, not only global ones; the child's own registrations stay outside its own filter. Guards compose monotonically: one abstaining and a later one denying means denied, and a guard registered by an earlier guard is live-iterated.
- Edge cases / failure handling: An unscoped call, an empty filter and a name the scope does not inherit all fail loud; a stateful arguments accessor is read once before policy, dispatch and result observation.
- Surprising: "keeps final-result observers synchronous" — `tools/result` is observe-only and never a waterfall.

### packages/core/tools/tests/json-schema.spec.ts
- Purpose: The enforced JSON Schema subset (22 KB, 27 cases).
- Key abstractions: `assertSupportedJsonSchema`, `validateJsonSchemaValue`.
- Data flow: Validates schemas and values.
- Non-obvious design decisions: "rejects unknown and misplaced keywords without accepted-then-ignored behavior"; a container with a hostile getter produces a *violation*, not a throw.
- Edge cases / failure handling: Present-but-`undefined` counts as missing for `required`; exact-one `oneOf` semantics include overlap; deep unions avoid the JavaScript call stack.
- Surprising: "keeps `assertNever` as a forged-schema backstop" — the exhaustiveness guard is also a runtime safety net.

### packages/core/tools/tests/schema.spec.ts
- Purpose: The unified author schema DSL (9.3 KB, 11 cases).
- Key abstractions: `ParameterSchemaSpec` → JSON Schema compilation, `InferArgs`.
- Data flow: Compiles author forms and asserts the emitted JSON Schema and the inferred types.
- Non-obvious design decisions: The implicit parameter root stays *open* while an explicit object keeps its declared openness; inference is bounded for deeply nested author schemas.
- Edge cases / failure handling: Runtime-forged author forms are rejected; cyclic author schemas are rejected; a property literally named `__proto__` is preserved.
- Surprising: "makes invalid author forms compile-time errors" — the DSL's misuse is a type error, not a runtime surprise.

### packages/core/tools/tests/properties.spec.ts
- Purpose: Property-based tests of the schema DSL and its runtime validator (8.3 KB).
- Key abstractions: fast-check arbitraries for parameter properties.
- Data flow: Generates schemas and arguments, then checks `parameterSchemaSpecToJsonSchema` and `validateArgs` agree.
- Non-obvious design decisions: "This closes the validator/InferArgs drift risk noted in the arg-validation Agent Note" — the *type-level* inference and the *runtime* validator are held to the same property.
- Edge cases / failure handling: Targeted corruptions of a generated argument set must be rejected.
- Surprising: A property-based test is used to keep a TypeScript type and a runtime validator in lockstep.

### packages/core/tools/tests/ts-types.spec.ts
- Purpose: The TypeScript SDK codegen contract (10.6 KB, 243 lines).
- Key abstractions: `jsonSchemaToTs`, `renderToolsSdk`.
- Data flow: Feeds schemas and asserts the emitted TypeScript.
- Non-obvious design decisions: An unconstrained schema renders as `JsonValue`; a closed empty object renders as `Record<string, never>`.
- Edge cases / failure handling: An `integer` renders as `number` but a `const: 2` keeps the literal.
- Surprising: The same schema maps to different literal unions depending on `enum` + `const` together (`const` wins).

### packages/core/tools/tests/ptc-calls.spec.ts
- Purpose: `PtcCalls` policy-change and cancellation behaviour (4.2 KB).
- Key abstractions: `PtcCalls.run(sessionId, signal, mode, run)`.
- Data flow: Changes the sandbox mode on a session and asserts the in-flight call is cancelled and the next call waits.
- Non-obvious design decisions: "commits policy immediately, cancels existing calls, and waits for their complete cleanup before reading the latest mode".
- Edge cases / failure handling: A failed call is released and does not block the next one; caller cancellation while waiting rejects; after disposal the registry refuses late admission.
- Surprising: The next call's `mode()` is read *after* the predecessor's cleanup, so the two never overlap under different policies.

### packages/core/tools/tests/execution-mode.spec.ts
- Purpose: The fail-closed concurrency classifier (5.3 KB).
- Key abstractions: `ToolRuntime.executionMode`.
- Data flow: Registers tools with and without `isConcurrencySafe` and reads the mode.
- Non-obvious design decisions: Only an exact `true` is parallel; invalid fixture arguments (which fail validation) also classify as exclusive, because the classifier received arguments the tool would refuse.
- Edge cases / failure handling: A throwing classifier and a truthy non-boolean result are both exclusive.
- Surprising: `isConcurrencySafe` never reaches the model-facing `schemas()` projection — the keys are exactly `description`, `name`, `parameters`.

### packages/core/tools/tests/execution-signal-types.spec.ts
- Purpose: The compile-time signal contract (4.1 KB).
- Key abstractions: `ToolExecutionInput` / `ToolExecution` / `ToolRunContext` and their readonly `signal`.
- Data flow: `@ts-expect-error` assertions in a never-called function.
- Non-obvious design decisions: Every typed invocation must supply a caller-owned signal; observers and tool bodies cannot assign, delete or undefine it.
- Edge cases / failure handling: n/a (compile-time).
- Surprising: The `tools/execute` view may *replace* the signal (runtime) but the `tools/pre-execute` and `tools/post-execute` views may not — the type encodes the pipeline's trust boundary.

### packages/core/tools/tests/gen-tool-catalog.spec.ts
- Purpose: The tool-catalog generator's guarantee tests (7.7 KB).
- Key abstractions: `collectToolCatalog`, `assertToolsHarvested`, `assertManifestComplete`, `render`.
- Data flow: Boots every shipped tool package and harvests its model-facing schemas.
- Key abstractions (catalog): The expected tool-name list is asserted literally — 74 names across the whole product.
- Non-obvious design decisions: The generator *boots* the packages rather than parsing them, so the catalog cannot drift from the real registrations.
- Edge cases / failure handling: Every tool must carry a JSON-Schema `parameters` object.
- Surprising: The list contains duplicates (`bash` twice, `pwsh` twice) — several tools are legitimately registered by more than one package.

### packages/core/tools/tests/fixtures/literal-sdk.ts
- Purpose: A tool whose description contains literal `{{…}}` template syntax (20 lines).
- Key abstractions: `name = 'literal-sdk'`, `inject = ['tools']`, `apply(ctx)`.
- Data flow: Registers a `template_echo` tool whose description contains `{{item}}`, `{{model}}` and `{{ item }}`.
- Non-obvious design decisions: The fixture exists so the `interpolate: false` behaviour of the `tools:sdk` prompt section is exercised against a real schema.
- Edge cases / failure handling: n/a.
- Surprising: A *tool description* containing braces would otherwise be interpolated as a prompt variable — this fixture pins that it is not.

## Ideas worth stealing

- **Derive model history from an append-only log, and make "compaction" a logged replacement rather than a delete** — `packages/core/session/src/surface.ts:594` (`foldSurface`) and `packages/core/session/src/types.ts:463` (`SurfaceOp`). Every message-producing event carries a `surfaceOp` marker; the ordered surface is folded from those markers, and a compaction is a `{ op: 'replace', startSeq, endSeq }` that *shadows* nodes from the derivation while leaving the raw events in the log. August can then have a transcript, a compaction and a replay that never disagree, because there is exactly one source of truth and the "current" view is a fold over it. The marker requirement is enforced at compile time via a conditional rest parameter on `Session.append` (`packages/core/session/src/index.ts:798`).

- **Give the model a *conservative* synthetic tool result when a call's outcome is unknown, and say what it may safely retry** — `packages/core/session/src/repair.ts:32` (the `CLOSER_TEXT` table). The two codes (`TOOL_NOT_STARTED`, `TOOL_OUTCOME_UNKNOWN`) state a fact about the call's *recorded* lifecycle, and the wording tells the model "retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly." August's compaction and crash-recovery paths could copy this: refuse to guess whether a side-effecting tool ran, and hand the uncertainty to the model with instructions instead of a generic error.

- **A bounded parallel tool pool that commits results in *model* order and reclassifies pending calls before they start** — `packages/core/agent-loop/src/tool-calls.ts:199` (`fillPool`) and `:147` (`commitReady`). The scheduler reads each pending call's concurrency mode again just before starting it, so a registry change mid-step can turn a parallel sibling into a barrier; results are committed strictly in model order even when they settle out of order, and a call skipped by cancellation gets an ordered synthetic `ABORTED_BEFORE_DISPATCH` result so the replay stays valid. August's parallel tool execution would inherit determinism and replayability for free.

- **Classify tool concurrency fail-closed: only an exact `true` from the tool's own classifier means "parallel-safe"** — `packages/core/tools/src/index.ts:1311` (`executionMode`). Unknown, hidden, undeclared, invalid-argument, throwing, and truthy-non-boolean results all mean *exclusive*. The README also states the limit: "Classification is unary — calls whose safety depends on comparing siblings or resources must remain exclusive." August can adopt the same default so a new tool is serial until it explicitly opts in.

- **Make a policy denial unreversible, and place the monotonic guard *after* the extensible waterfall** — `packages/core/tools/src/index.ts:1527` (`denialReason = decision.kind === 'allow' ? this.guardReason(exec) : decision.reason`). `tools/pre-execute` may allow/deny/ask; registered guards then run afterwards and only a guard can turn an *allow* into a deny. A later listener cannot turn a denial back into permission. August's sandbox/permission layer would get the same "no un-denial" property with one line of ordering.

- **Turn every tool failure into a structured, frozen `isError` result instead of an exception that ends the turn** — `packages/core/tools/src/index.ts:1917` (`toolErrorResult`). The content is exactly `Error: <message>`; the structured name/code live beside it, never in the model-visible text. Unknown tools, throwing tools, hostile thrown values, wrapper failures, post-policy failures and timeouts all resolve to an `isError` result. The pinned suite for this is `packages/core/tools/tests/tools.spec.ts:690`.

- **Distinguish "not attempted" from "attempted and interrupted" in cancellation outcomes** — `packages/core/tools/src/index.ts:1966` (`toolAbortedResult`) and `:1980` (`toolAbortedBeforeDispatchResult`). Whether the tool *body* started selects the code, and a started body is always drained to quiescence before the outcome is reported. August's tool layer currently conflates these; the split is what lets the model reason about side effects.

- **Admit a changed system prompt according to the *prepared route's* capability, so a KV-cache-friendly route appends and an incapable route consolidates** — `packages/core/agent-loop/src/runtime-context.ts:88` (`SystemPromptProjection.project`) driven by `packages/core/agent-loop/src/agent.ts:416`. With `systemPromptUpdate: 'in-history'` a changed prompt is **appended after the cached history**, so the prefix through that history stays reusable; on an incapable route or a new series the prompt is consolidated at node 0 through logged per-node empty replacements, and an empty rendering clears *every* active system node. August, which has no `in-history` route today, could adopt the "consolidate at the head" half plus the "clear every active node" rule, and keep the door open for the appending half.

- **Log the request header as a full canonical snapshot and only when it changed — then reconstruct the request from the log alone** — `packages/core/agent-loop/src/agent.ts:616` (`buildRequest`) and `packages/core/session/src/request-header.ts:63` (`foldRequestHeader`). The header carries call config, adapter defaults and tool schemas, but *not* the prompt (the prompt is a surface node). The loop logs a header on first use, on change, on an explicit series start and on resume; unchanged steps inherit the latest snapshot, so no tokens are duplicated. The repo then asserts the central invariant as a test: "THEOREM: every request rebuilds byte-equal from the session log alone" (`packages/core/agent-loop/tests/request-reconstruction.spec.ts:856`). August could use the same shape to make every model request auditable and re-issuable.

- **Prove prefix stability against the *real* provider, not only in mocks** — `packages/core/agent-loop/tests/request-cache.e2e.ts:74`. The test is gated on `DEEPSEEK_API_KEY`, runs a multi-step tool turn plus a follow-up turn against the live API, and asserts `cacheReadTokens > 0` on **every** request after the first, using the per-step `usage` recorded on the durable `assistant/message` event as the observable. It also verifies the conversation itself (the tool's value reached the final answer), so a green run proves the cache and the turn. August has no such end-to-end cache check.

- **Freeze each derived message identity once, then reuse it** — `packages/core/agent-loop/src/agent.ts:688` (`buildRequest` + the `frozenMessages` `WeakSet`). The loop deep-freezes a message the first time it is sent and reuses that frozen object for every later request; the request array itself is fresh per dispatch, but the *messages* are shared and frozen. This is what keeps the provider prefix byte-identical across steps, and it is why a later surface replacement can produce a new object with the same message id. August's context assembly could adopt the same "freeze the identity once" rule.

- **Canonicalise the model-facing tool order so registration order cannot leak downstream** — `packages/core/system-prompt/src/index.ts:674` (`orderTools`) with `TOOL_ORDER_REST`. Tools are ordered by an explicit `toolOrder` list (with one `'<unlisted-tools>'` rest entry) or lexicographically, and the loop builds its request header from that canonical list. The pinned behaviour is in `packages/core/agent-loop/tests/tool-order.spec.ts:70`: registering `zulu, alpha, mike` in any order produces the same header and the same dispatched request. Registration order is a concurrent-loading artifact and must not reach the provider.

- **Fail loud on an unresolved prompt variable rather than sending a malformed prompt** — `packages/core/system-prompt/src/index.ts:340` (`interpolate`). A `{{name}}` that is unregistered, registered-but-valueless, or malformed throws and names the contributing section; a lone `{{` with no later `}}` stays literal prose; substituted values are not re-scanned; and the lookup uses `Object.hasOwn`, so `{{constructor}}` is unknown. August's prompt templating currently risks sending a half-substituted prompt.

- **One relation, two directions: registration views inherit *down* the scope chain, event admission extends *up* it** — `packages/core/scope/src/index.ts:170` (`scopeTarget`) and `:98` (`scopeChainOf`). A child scope sees its ancestors' registered contributions (nearest wins); an ancestor-tagged listener receives a descendant's events; a descendant-tagged listener never receives an ancestor's. The parent link is set once and only its holder may re-link it, and every link rejects a cycle. August's per-agent isolation and its orchestrator-wide observation both fall out of this one primitive.

- **Attribute work causally with an `AsyncLocalStorage` initiator scope — and say plainly that it is process-local** — `packages/core/agent/src/index.ts:625` (`runWithInitiator`) and `:344` (`withoutInitiator`). The driver's whole lifetime runs inside the boundary so helpers below it can attribute their work without threading the agent through every call; `withoutInitiator()` hides it for shared timers and pumps. The teardown counts live boundaries, drains them, and *excludes the boundary that initiated the teardown from its own drain* — otherwise disposing a service inside a boundary self-deadlocks. The README states the limit: "Ambient presence is neither liveness proof nor authorization; explicit identity stays authoritative at worker, process, persistence, and wire boundaries."

- **Keep a fused dispatcher so the event's subject and its scope key cannot diverge** — `packages/core/agent/src/dispatch.ts:107` (`agentEvents`). The dispatcher injects the agent into the payload (the spread comes first, so a payload that happens to carry an `agent` field cannot override it) and passes the scope carrier as the `thisArg`; the type-level `AgentSubjectEvent` requires both a payload carrying `agent` and a `Scoped<Agent>` `this`, which excludes accidental events. The dispatcher also resolves the callback set *itself*, because Cordis's `emit` uses `Array.map` and one synchronous throw there starves later listeners. August's per-agent event surface would get subject/key consistency and non-vetoing notifications from one object.

- **A "consumed work" fold that a turn cannot fake** — `packages/core/agent/src/consumed-work.ts:69` (`foldConsumedWork`). A turn that stops before its first step leaves a `turn/end` shaped exactly like a balanced no-op turn, so reading turns in isolation either credits cut-short work as finished or convicts every no-op. The fix is to read the *inbox's* own record: a splice with `removedCount` and `outcome: 'canceled'` separates "claimed and ran" from "dropped unrun". August's turn accounting (the `turn_outcomes` ledger) has the same ambiguity and could use the same log-derived shape.

- **Tell the model when its own earlier turns came from a different model** — `packages/core/agent/src/model-selection.ts:113` (the `agent/pre-step` listener). The selection is captured at *assembly* and applied to the *same* step's request, so a concurrent switch takes effect on a later step rather than splitting the two surfaces; and a route change appends a durable user-role notice, `[model changed: assistant turns above this point were generated by <previous>; the session continues with <next>]`. August's model-routing work could adopt the notice — it costs one short message and removes a whole class of model confusion.

- **Trade N tool schemas for one generated SDK (PTC mode) and make the generated text byte-deterministic** — `packages/core/tools/src/ptc.ts:32` (`RUN_CODE_NAME`) with `packages/core/tools/src/ts-types.ts` and `py-types.ts`. The model programs against `await tools.name(args)` inside a single `run_code` call, and the SDK text is generated from the same registry store that `schemas()` projects. The pinned requirement is "renders byte-identical SDK text across consecutive assemblies of an unchanged tool set" (`packages/core/tools/tests/ptc.spec.ts:434`) — non-determinism there would silently break the prefix cache. August's "progressive disclosure" of tools could adopt the same generated-SDK shape, and the same determinism requirement.

- **A "no tool policy in the model-facing schema" projection** — `packages/core/tools/src/index.ts:1290` (`schemaOf`). `schemas()` emits only `name`, `description`, `parameters` and `deferLoading`; `output`, `execute`, `finalizeContent`, `timeoutMs`, `isConcurrencySafe` and the presentation callbacks never reach the model. The pinned test asserts the exact key set (`packages/core/tools/tests/execution-mode.spec.ts:124`). August's tool schema projection should have the same "one projection, deliberately narrow" property.

## Files skipped (with reasons)

None. Every one of the 175 files in the shard was opened and read (the largest test files were read in a first chunk plus a complete `describe`/`it` inventory via grep rather than in one pass, but no file was skipped, and no file was left unopened).

Two files are **generated** and are marked as such in their own headers rather than being skipped:
- `packages/core/session/src/known-event-types.ts` — generated by `scripts/gen-persistence-catalog.ts`; read in full because its content (the event vocabulary census) is the shard's compatibility contract, not boilerplate.
- `packages/core/tools/src/testing.ts` — a test-fixture helper, not generated; read in full (42 lines).

No binary, vendored or huge-data files exist in this shard.

## Uncertainties

- **`packages/core/agent-loop/README.md:120` is truncated on disk in this clone.** The paragraph describing the turn-and-step flow ends mid-sentence at `policy, durable results... (line truncated to 2000 chars)`. I confirmed this is in the file, not in my reader: `Get-Content` reports the line as 2502 characters long and the tail of that line literally contains the text `… (line truncated to 2000 chars)`. A repo-wide grep for `line truncated to \d+ chars` finds only two legitimate hits in `packages/fs/tool-fs/tests/*` plus this one. I could not recover the missing tail: the clone is read-only and I did not look for the upstream copy. Everything I report about the turn/step flow is therefore taken from `packages/core/agent-loop/src/agent.ts` (which I read in full) and from the *other* README paragraphs, not from the end of line 120. The gap is roughly 300–500 characters of prose about policy and durable-result handling inside the step.

- **`packages/core/tools/src/index.ts` is 1993 lines; I read lines 1–500 by structure grep, 1290–1993 in full, and 800–1290 only partially.** The parts I did not read line by line are the registry/service constructor and the `register` / `restrict` / `guard` / `get` / `schemas` bodies (roughly lines 500–1290). I know their contracts from the README, the `schemaOf` implementation and the scoped test suite, but I did not verify them line by line. In particular, the exact composition of `ToolRestriction` (allow/deny semantics, `guardReason`) was read through its call site and tests, not through the class body.

- **The `tools` package's PTC internals (`src/ptc.ts`, 792 lines) were read for the first 60 lines plus the README's PTC section and the 116-case `ptc.spec.ts` inventory.** The sub-dispatch bridge's internals (the `run_code` execution, escalation approval, the per-program pool) are understood from the README and the test titles, not from a full read of the implementation.

- **The compaction *policy* is not in this shard.** The `session` package owns the compaction *mechanism* (the `replace` surface operation, the protected system head, the landmark-free shadowed-node rules), but the component that decides *when* to compact and *what* to summarise lives in another shard. Similarly, **memory / learning, the brain store, the subagent runtime, MCP and the UI layers are all outside this shard** — the only subagent-related facts here are `delegationDepth`, `origin: 'subagent'` and `isOwnedBy`.

- **`packages/core/tools/src/py-types.ts` (817 lines) and `packages/core/tools/src/schema.ts` (632 lines) were read for their first ~80 lines plus the test inventories.** The NFKC-stability rationale and the degradation rules are quoted from those headers and from the 55-case `py-types.spec.ts` inventory; the full implementations of the class-name derivation and the inference bound were not read line by line.

- **`packages/core/system-prompt/src/index.ts` (691 lines) was read for lines 282–401 and 575–691 in full, with a structural grep over the rest.** The `PromptLayer` class body, `orderTools`, the `SECTION_ORDERS` / `CONTEXT_ORDERS` tables and the `SystemPrompt` constructor were not read line by line; the section-order numbers quoted here come from the README and the `system-prompt.spec.ts` assertions.

- **The Python and Chinese README bodies were not read in full** — I read the first ~14 lines of each `README.zh.md` (front matter, title, summary) and the hash records, and confirmed they are translations of the English files. I did not verify the Chinese prose section by section; the hash records are the repo's own mechanism for that, and I did not run the gate.
