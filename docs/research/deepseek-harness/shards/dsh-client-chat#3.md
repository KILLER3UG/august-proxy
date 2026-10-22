# deepseek-harness / dsh-client-chat#3

## Shard shape

This shard is one package: `packages/client/ui-trajectory` — the browser-side "Trajectory" tab of the DSH web client. It is a **pure consumer**: it declares no service and no Context merge (`src/client/index.ts:41`), and instead registers (a) a set of `ConversationNodeDefinition`s that turn durable Session events into Trajectory-owned records, (b) a `ConversationViewDefinition` whose `TrajectorySnapshotBuilder` assembles those records into a snapshot, and (c) one entry into the `conversation.view` slot ring. The data flow is one-way and read-only with respect to the Chat conversation: durable Session events → per-record Definitions (assistant step, tool call + nested PTC dispatch, message/steering, system-prompt/request-header, compaction, turn-end, session-end) → `TrajectorySnapshot` (event nodes, requests, call schemas, partial, running calls) → a pure layout fold (`layout.ts`) into turn → group → cell rows → two React surfaces: a virtualized `<table>` ledger with a local record inspector (`TrajectoryTable.tsx`, 3 538 lines) and a Chrome-Network-style timing overview (`TrajectoryTimeline.tsx`). A separate `timeline.ts` projection turns the same layout into a three-lane time domain (sequence / recorded duration / wall-clock), and a `TrajectorySearchIndex` provides incremental full-text search over the visible window. The package never assembles or sends a provider request — its README states "Model Experience: None… KV Cache effect: None" — so the *agent loop, prompt construction, compaction policy, memory and model adaptation all live elsewhere*; what lives here is the **observability projection** of them: turn/step boundaries, TTFT and decode split, per-request usage, retry history, interruption, tool-call trees, compaction requests, and prompt/tool-catalog diffs.

## Per-file notes

### packages/client/ui-trajectory/package.json
- Purpose: package manifest for `@deepseek-ai/dsh-client-ui-trajectory` v0.2.1-rc.2.
- Key abstractions: `dsh.client.inject` lists the five required client services; `exports` exposes `.`, `./client`, `./src/*`, `./package.json`, `./locale/*.json`; `files` ships only the built `lib/` and the locale JSON.
- Data flow: build → `tsdown` → `lib/index.js` + `lib/client.js` → the host's module loader.
- Non-obvious design decisions: the description states it is a "pure-consumer plugin registering into the conversation ViewMap (no service)" — the package intentionally has no Context merge; `peerDependencies` is only `cordis`, everything else is a devDependency because the client bundle inlines them.
- Edge cases / failure handling: n/a (manifest).
- Surprising: `dependencies` is absent entirely — this is a leaf package that must not constrain the host's dependency graph.

### packages/client/ui-trajectory/README.md
- Purpose: the package reference (English) — summary, "Use this package", implementation internals, limitations.
- Key abstractions: documents the Trajectory tab as a "turn-aware ledger and interactive timing overview"; the "Understand the implementation" section names the three internal rules (pure projection, steering classifier, virtual rows).
- Data flow: n/a (prose).
- Non-obvious design decisions: explicitly states "Selection, timeline navigation, folding, and search cover the React-visible window. Request numbers and cumulative usage cover the complete resident snapshot" — the split is deliberate and is the invariant the code implements.
- Edge cases / failure handling: documents "A completed model response does not imply that its tools or turn have finished" and "Retry counts and the last attempt error remain available after recovery; they do not change the current request status".
- Surprising: "In-flight Time stays blank — `partial` and `runningCalls` rows show their running state without a fabricated duration, so the Overview renders a start marker rather than inventing a live span."

### packages/client/ui-trajectory/README.zh.md
- Purpose: the Chinese twin of `README.md` (same 116-line structure).
- Key abstractions: n/a (translation).
- Data flow: n/a.
- Non-obvious design decisions: the bilingual pair is kept structurally identical so a per-section hash check can detect drift (see `README.i18n.yaml`).
- Edge cases / failure handling: same content as the English file.
- Surprising: it is not a machine translation — it preserves the same code identifiers and the same "None" statements.

### packages/client/ui-trajectory/README.i18n.yaml
- Purpose: the bilingual-pair consistency record for `README.md`.
- Key abstractions: one entry per heading section, each holding an `en` and a `zh` hash of that section's text outside code blocks.
- Data flow: `pnpm run verify-translation-pairing --write packages/client/ui-trajectory/README.md` regenerates it.
- Non-obvious design decisions: the hash is per-section, not per-file, so a one-sided edit is localised to the section that changed.
- Edge cases / failure handling: n/a.
- Surprising: the file's own header comment is the documentation of the mechanism — the pairing check is described in `docs/i18n/README.md`.

### packages/client/ui-trajectory/locale/en.json
- Purpose: the package's *plugin metadata* locale (not the UI strings, which live in `src/client/locales.ts`).
- Key abstractions: `{"meta": {"title": "ui-trajectory"}}`.
- Data flow: read by the host's locale plugin to label the plugin.
- Non-obvious design decisions: the English file carries only a title, while the Chinese one also carries a description — the loader tolerates the asymmetry.
- Edge cases / failure handling: n/a.
- Surprising: two parallel i18n systems coexist in this package — a JSON metadata file for the plugin registry and a TypeScript dictionary for the UI.

### packages/client/ui-trajectory/locale/zh.json
- Purpose: the Chinese plugin-metadata locale.
- Key abstractions: `meta.title` = 运行轨迹, `meta.description` = a one-line description of the view.
- Data flow: same as the English file.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: the description names the four things the tab shows (messages, tool calls, duration, tokens) — it is the only place a user learns the tab's purpose before opening it.

### packages/client/ui-trajectory/tsconfig.json
- Purpose: the package's TypeScript project configuration.
- Key abstractions: `rootDir: src`, `outDir: lib/types`, extending `tsconfig.base.client.json`.
- Data flow: the `references` array lists the 15 workspace packages this one compiles against (cordis vendor, locale, store, ui-conversation, ui-renderer, ui-session, ui-slots, api/session-controller, core/agent, core/session, core/tools, compaction, llm, attachment, util/values).
- Non-obvious design decisions: project references rather than path aliases — the package's dependency graph is declared to the build system, which is what makes the client-bundle external list auditable.
- Edge cases / failure handling: n/a.
- Surprising: `core/agent` is referenced although nothing in this shard imports it directly — the reference exists to type the `MessageSourceMap` merge that the conversation package exposes.

### packages/client/ui-trajectory/tsdown.config.ts
- Purpose: the bundler configuration.
- Key abstractions: `clientBundle(import.meta.dirname, ['lib/types/index.js'])` — three lines.
- Data flow: `pnpm bundle` → `tsdown` → `lib/index.js` (node entry) + `lib/client.js` (browser entry).
- Non-obvious design decisions: the `['lib/types/index.js']` third argument keeps the type bundle as a separate artifact rather than emitting declarations for the client bundle.
- Edge cases / failure handling: n/a.
- Surprising: three lines, and the whole package's runtime contract is "the browser entry hands off through `window.__ModuleLoader__.load`" — a mechanism the bundle test verifies.

### packages/client/ui-trajectory/src/index.ts
- Purpose: the host loader entry for the browser-only plugin.
- Key abstractions: `export function apply(): void {}` — a deliberate no-op.
- Data flow: none; the host calls `apply` on the node entry.
- Non-obvious design decisions: the doc comment says "Provides no host-side behavior" — the node side exists only so the package can be published and loaded.
- Edge cases / failure handling: n/a.
- Surprising: `views.client.spec.tsx:1597` asserts "node apply is an intentional no-op (loader-managed lifecycle only)" — the emptiness is a pinned contract, not an oversight.

### packages/client/ui-trajectory/src/css-modules.d.ts
- Purpose: ambient declarations for CSS-module imports.
- Key abstractions: `declare module '*.module.css'` (default export = `Record<string,string>`) and `declare module '*.css'`.
- Data flow: n/a.
- Non-obvious design decisions: the `.module.css` shape types every class as `string`, so a renamed class becomes a compile error at the use site.
- Edge cases / failure handling: n/a.
- Surprising: six lines that gate the whole package's styling discipline.

### packages/client/ui-trajectory/src/client/index.ts
- Purpose: the client plugin body — registers the Definitions, the view, and the `conversation.view` slot entry.
- Key abstractions: `apply(ctx)`; `inject = ['slots','sessions','uiSession','uiConversation','locale']`; a `WeakMap<SessionBinding, ObservableSnapshot<TrajectorySnapshot>>` memoising one trajectory source per binding.
- Data flow: `ctx.locale.register(NS, {zh,en})` → the five Definition registrars → `registerTrajectoryConversationView(ctx)` → `ctx.uiSession.provide({hooks:['trajectory'], resolve})` → `ctx.slots.inject('conversation.view', …)` registering the `trajectory` tab with `order: 10`, a `conversation.trajectory.images` child slot, and an `inject(sessionId)` that returns `{hooks:{duration}, jsonStringWrapping, loadOlder, loadImage, setActualDuration}`.
- Non-obvious design decisions: the tab label is `() => t('view.trajectory')` — a thunk, so a locale change re-labels the tab without re-registering (comment at `:63`); `loadOlder` returns whether the trajectory *snapshot* changed, not whether the session page loaded (`return trajectory.getSnapshot() !== before`), so the caller can tell "the page revealed nothing new" from "the page advanced"; `loadImage` is `Object.assign`ed with a `peek` variant so a cached blob URL is not re-fetched.
- Edge cases / failure handling: `ctx.sessions.binding(sessionId)?.session` being undefined throws `ui-trajectory: session "…" is unavailable` rather than rendering an empty tab.
- Surprising: the plugin registers a *provider* into `ctx.uiSession` for the `trajectory` hook, i.e. it publishes a read model of its own target into the session standard-props kit.

### packages/client/ui-trajectory/src/client/locales.ts
- Purpose: the complete UI dictionary for the trajectory surface (Chinese source of truth + typed English).
- Key abstractions: `NS = 'trajectory'`; `zh` (193 keys, `as const`); `TrajectoryKey = keyof typeof zh`; `en: Record<TrajectoryKey, string>`; `TrajectoryTranslate = TranslateNS<'trajectory'>`; a `LocaleNamespaceMap` module augmentation.
- Data flow: `ctx.locale.register(NS, {zh,en})` → the bound `t` is threaded through every layout/presenter function.
- Non-obvious design decisions: **the Chinese dictionary is the key-set source of truth and the English one is typed against it** — a missing English key is a compile error, not a runtime fallback to the key name. The `LocaleNamespaceMap` augmentation is how the host learns the namespace's key union.
- Edge cases / failure handling: plural forms are encoded as separate `.one` / `.other` keys rather than relying on an Intl plural resolver (`summary.toolCalls.one` / `.other`).
- Surprising: the dictionary contains keys the shared locale package also defines (`copy.*`, `collapse`, `expand`, `copied`) — the package re-declares them so its own dictionary is self-contained.

### packages/client/ui-trajectory/src/client/trajectory-contract.ts
- Purpose: the type contract between the Definitions, the snapshot builder and the UI.
- Key abstractions: `TrajectoryContribution` (a discriminated union of 8 kinds), `TrajectoryConversationViewNode` (the Engine-owned target envelope), `TrajectorySnapshot`, `UseTrajectory`, plus two module augmentations (`ConversationViewSnapshotMap.trajectory`, `SlotMap['conversation.trajectory.images']`).
- Data flow: Definitions emit contributions → the builder folds them into a `TrajectorySnapshot` → the view reads it through `useTrajectory`.
- Non-obvious design decisions: the union has a `kind: 'assistant'` variant carrying BOTH `node` (settled), `partial` (in-flight) and `request` (the LLM request record) — so an assistant step is one record at three stages rather than three records. `TrajectoryPartialAssistant` deliberately narrows timing to `stepStartTime | firstTokenTime` only.
- Edge cases / failure handling: `TrajectoryRequestHeaderState.change` is optional — a request header without a prompt change is the normal case.
- Surprising: the `SlotMap` augmentation declares `conversation.trajectory.images` as `{kind:'single'; scope:'session'; owner: MessageImagesOwnerProps}` — the *view* declares the slot so ledger children can render images through the framework's `renderSlot` seat instead of holding its own image state.

### packages/client/ui-trajectory/src/client/trajectory-definition-common.ts
- Purpose: the shared wrapper that turns a contribution into the Engine's target envelope.
- Key abstractions: `trajectoryNode(context, anchorSeq, data)` — 28 lines, the only shared code between the five Definition families.
- Data flow: every `buildViewNode` in the package ends with a call to it.
- Non-obvious design decisions: `anchorSeq` is passed separately from the node's own seq because a record may be anchored at the *step* start (e.g. `state.startSeq`) while its content sits later; `location` falls back to `{kind:'unresolved'}` when the context has no start location.
- Edge cases / failure handling: the unresolved-location fallback keeps a record renderable rather than throwing when the window is partially loaded.
- Surprising: `context.key` (the Engine's identity) becomes the view node's key, so identity is inherited rather than minted.

### packages/client/ui-trajectory/src/client/trajectory-event-projection.ts
- Purpose: Trajectory-owned conversion from durable Session events to ledger view data.
- Key abstractions: `contextForm`, `contextProducer`, `toAssistantBlock(s)`, `emptyAssistantBlock`, `DisplayFailure`, `displayFailure`, `isTokenDelta`.
- Data flow: the Definitions call these to turn `ContentBlock`s into `AssistantBlock`s and to classify message sources.
- Non-obvious design decisions: the whole file is inside a `/* jscpd:ignore-start */` block with the comment "Chat and Trajectory own independent event-to-view projections" — the duplication with Chat is deliberate, because coupling them would make one surface's change break the other. `contextProducer` treats an unknown `kind` as a visible label rather than hiding it, because `MessageSourceMap` is merge-extensible. `KNOWN_FORMS` is an explicit allow-list: an unknown form stays opaque rather than being guessed at.
- Edge cases / failure handling: **`displayFailure` drops the message of an `AUTH` failure entirely** — "Provider AUTH messages may echo a masked or partially preserved credential. Keep the raw diagnostic in the Session log, but never retain it in UI state."
- Surprising: `isTokenDelta` counts a `tool-call-delta` with a `name` as a token even with an empty `argumentsDelta` — a named tool call is visible output and therefore starts the TTFT clock.

### packages/client/ui-trajectory/src/client/trajectory-record.ts
- Purpose: the shared record data shape and formatting contracts for the ledger.
- Key abstractions: `TrajectoryCellKind` (7 kinds), `AssistantMetricDetail`, `TrajectorySourceBlock`, `TrajectoryCellProps` (~30 optional fields), `trajectoryRecordId`, `formatDurationMillis`, `formatElapsedSeconds`.
- Data flow: `layout.ts` produces `TrajectoryCellProps`; the table renders them; the search index and the virtual-row projector key on them.
- Non-obvious design decisions: `previewMarkdown` / `resultPreviewMarkdown` carry the *raw Markdown source* alongside the already-flattened `text` — the consumer decides whether to render Markdown or plain text, so the layout never has to parse Markdown. `timeSeconds` is `number | null` and `null` means "no duration known" (never 0). `startedAt` is epoch ms and optional.
- Edge cases / failure handling: `formatDurationMillis` returns an em dash for `null` **and for `NaN`** — an unusable duration is never rendered as `0 ms`.
- Surprising: `trajectoryRecordId` is the identity ladder — `recordId` → `callId` → `sourceSeq` → `index` — never the array position, because older pages are prepended and positions shift.

### packages/client/ui-trajectory/src/client/trajectory-preview.ts
- Purpose: a bounded Markdown-to-text projection shared by every preview surface.
- Key abstractions: `trajectoryPreviewText(text)`.
- Data flow: used by the search index, the ledger row text and the result preview.
- Non-obvious design decisions: two independent caps — `PREVIEW_SOURCE_CHARACTERS = 2048` in, `PREVIEW_OUTPUT_CHARACTERS = 512` out — and the doc comment says "Build a bounded one-line preview **without parsing the complete Markdown document**": the source is sliced *before* `extractMarkdownPlainText` runs.
- Edge cases / failure handling: a truncation ellipsis is appended when *either* cap bit, so the reader can tell a shortened preview from a complete one.
- Surprising: the retained source (`previewMarkdown`) is uncapped while the preview is capped — the cap is a rendering bound, not a data bound.

### packages/client/ui-trajectory/src/client/trajectory-assistant-definition.ts
- Purpose: the Trajectory-owned Assistant streaming, settlement and request lifecycle.
- Key abstractions: `AssistantState` (turn, step, blocks, visibleBlocks, firstVisibleSeq/Time, firstTokenTime, final, usage, retry, stepEnd), `updateChunk`, `settleTiming`, `settleMessage`, `closedBoundary`, `fallbackState`, `finalNode`, `assistantRequest`, plus the `trajectory-turn-end` Definition.
- Data flow: `step/start` opens the state; `assistant/live-chunk` mutates it; `assistant/attempt` settles timing; `assistant/message` settles content + usage; `llm/retry` rewrites it; `step/end` closes it; `turn/end` produces the error record.
- Non-obvious design decisions: (a) **a retry resets the blocks but keeps `firstTokenTime` and `usage`** — `update`'s retry branch rebuilds from `initialState` and re-injects `firstTokenTime: context.state.firstTokenTime` (`:366-386`), because TTFT must include output produced by an earlier attempt; (b) `publication` returns `'animation-frame'` for content deltas, `'immediate'` for settlement, `'none'` for `usage`/`finish` and for `step/start`/`assistant/attempt` (`:388-393`) — the render cadence is chosen by the event kind; (c) `visibleBlocks` counts only non-empty text/reasoning blocks, and the *first* visible block's seq/time become `firstVisibleSeq/Time`; (d) `fallbackState` replays the matches when the Engine's state is unavailable (a partially loaded window); (e) an assistant whose step closed without a settled message becomes an **interrupted** node at `boundary.seq - 0.9` — a fractional seq so it sorts just before the boundary.
- Edge cases / failure handling: `hasInterruptionEvidence` requires actual text/reasoning before an interrupted node is emitted — an empty step produces no row. `hasInterruptionEvidence` returns true for any non-text block, so a tool-call-only interrupted step is still visible.
- Surprising: the whole file is inside a `jscpd:ignore` block referencing an architecture note (`.agents/notes/implemented/architecture/2026-08-09-client-conversation-node-assembly.md`) — the duplication with the Chat package's Definition is a recorded architectural decision, not debt.

### packages/client/ui-trajectory/src/client/trajectory-tool-definition.ts
- Purpose: the Trajectory-owned root Tool lifecycle, including nested PTC (programmatic tool calling) dispatch.
- Key abstractions: `ToolState` (calls/children/parents maps), `rootCall`, `rootResult`, `childCall`, `childResult`, `acceptsEdge`, `updateDispatch`, `interruption`, `projectCall`, `fallbackState`.
- Data flow: `tool/call` opens the root; `tool/result` settles it; `tool/ptc-dispatch-start` / `tool/ptc-dispatch` add or settle nested sub-calls under `rootCallId`.
- Non-obvious design decisions: `MAX_DEPTH = 256` and `acceptsEdge` refuses (a) a self-edge, (b) an edge to an existing ancestor (a cycle), and (c) an edge where `parentDepth + subtreeDepth` would exceed the cap — the walk is bounded in *both* directions before the edge is accepted. `projectCall` additionally carries a `visited` set and a depth cap, so a corrupt tree renders truncated rather than hanging. A call that never returned, whose step or turn closed, becomes a tool-result with `error: {name:'Interrupted', code:'interrupted'}` at `interruptedAt.seq - 0.8`.
- Edge cases / failure handling: `PartialArguments.fromText` is used for the root's raw arguments so a malformed argument string still yields a partial object rather than throwing. A `tool/ptc-dispatch-start` for a child already known is ignored (`index >= 0` → return state) so a duplicated start cannot corrupt the tree.
- Surprising: the interrupted result's `seq` is `boundary.seq - 0.8` — a fractional sequence number used purely to order a synthesised record just before the boundary that ended it.

### packages/client/ui-trajectory/src/client/trajectory-message-definitions.ts
- Purpose: inbox (steering) classification and the user/context message records.
- Key abstractions: `InboxState` (a persistent splice chain + the current claimed ids), `PendingSnapshot` / `PendingSplice`, `materializePending`, `withoutInserted`, `applySplice`, the `trajectory-inbox-next-step` and `trajectory-input-message` Definitions.
- Data flow: `agent/inbox/spliced` events mutate the pending chain; a later `user/message` is classified as **steering** only if its id is in the *current claim*.
- Non-obvious design decisions: the splice chain is kept as a *chain* and materialized only when a batch is claimed — `materializePending` walks the chain and replays the splices in reverse. The doc comment on `applySplice` states the rule: "An entered claim logs its complete message batch before another claim; a rejected claim logs no messages, so only the current claim can classify a later `user/message`." A developer message becomes a `context` node with its `producer` and `form`; a user message whose source kind is not `'user'` is also a `context` node.
- Edge cases / failure handling: a canceled splice (`outcome === 'canceled'`) removes the claimed ids without materialising the removal — `withoutInserted` drops just the inserted ids from the current claim.
- Surprising: this is a durable-event way to answer "was this message typed mid-turn or did it open a new turn?" — the answer is derived from the *ordering of splice and message events*, not from a heuristic on content or timing.

### packages/client/ui-trajectory/src/client/trajectory-request-header-definition.ts
- Purpose: the system-prompt node Definition and the request-header fact Definition.
- Key abstractions: `TrajectorySystemMessageState` (extends `SystemPromptState` with an optional `header`), `trajectorySystemMessageDefinition(inspect)`, `trajectoryRequestHeaderDefinition(inspect)`.
- Data flow: `system/message` events and `surfaceOp` replacements feed `ctx.uiConversation.inspectSystemPrompt`; `request/header` events feed `ctx.uiConversation.inspectRequestPrompt`; the two Definitions read each other through `reader.previous`.
- Non-obvious design decisions: the prompt interpreters are **injected as functions** rather than imported, with the comment "a client bundle cannot value-import it" — the browser bundle therefore has no value dependency on the conversation package. An *uncertain* surface (a replacement whose order cannot be established) yields a header with `system: ''` — the record is present but does not claim to know the text. A prompt change is anchored at the *replacement's* seq, and the previous prompt is carried on the change.
- Edge cases / failure handling: `state.uncertain` and "the effective node is unchanged" both take the "keep the prior header" path, so a no-op surface operation never invents a prompt change. `buildViewNode` only emits a `request-header` node when `state.header.seq === context.start.event.seq` — exactly one Context owns the header fact.
- Surprising: the `surfaceOp` replace case is matched by `('surfaceOp' in event && event.surfaceOp !== 'append')` — i.e. *any* non-append surface operation, including replacements produced by compaction, is a candidate for a prompt change.

### packages/client/ui-trajectory/src/client/trajectory-compaction-definition.ts
- Purpose: the compaction request lifecycle and the session-end boundary.
- Key abstractions: `CompactionState` (start/summary/end/checkpoint), `checkpointId`, `eventCompactionId`, `requestFromState`, the `trajectory-compaction` and `trajectory-session-end` Definitions.
- Data flow: `compaction/start` → `compaction/summary` → `compaction/end`, correlated by `compactionId`; a `user/message` with `source.kind === 'compact-checkpoint'` joins the same record as the replacement.
- Non-obvious design decisions: the compaction request carries `providerMetadata`, `requestConfig`, `usage`, `rawOutput` and `replacementSeq` — the compaction is shown as a *first-class request* with the same number/usage machinery as an assistant request. A `turn` of `null` means "standalone" (between turns) and is later placed in its own section by the layout.
- Edge cases / failure handling: `start` throws if the matched event is not a `compaction/start` — the Definition refuses to be started by the wrong event. `eventCompactionId` requires a non-empty string, so an id-less compaction event is not matched at all.
- Surprising: the compaction checkpoint arrives as a *user message* with a special source kind — the definition recognises `kind === 'compact-checkpoint'` and folds it into the compaction record instead of showing it as a user message.

### packages/client/ui-trajectory/src/client/trajectory-snapshot-builder.ts
- Purpose: the view builder that assembles contributions into the `TrajectorySnapshot`.
- Key abstractions: `EMPTY_TRAJECTORY_SNAPSHOT`, `StepHeaders`, `headerFor`, `applyHeader`, `captureSchemas`, `indexTools`, `interruptCompactions`, `applyTurnErrors`, `TrajectorySnapshotBuilder` (implements `ConversationViewBuilder`), `trajectoryViewDefinition`.
- Data flow: `replace({nodes})` (full window) and `apply({upserts})` (incremental) → `snapshot()` → `TrajectorySnapshot`.
- Non-obvious design decisions: (a) **`apply` distinguishes a structural change from a content-only change** — a node whose `anchorSeq` changed, or a brand-new node, triggers a full `rebuildContributions()`; a content-only update is a positional write `this.contributions[position] = node` (`:182`), so a streaming delta does not re-sort or rebuild the whole ordered array; (b) a prompt change is **consumed exactly once** — `consumedPromptChanges` ensures the first request that inherits a change carries it and later ones do not (`:246-249`); (c) a request header is inherited forward to requests with no header of their own (`headerFor` falls back to the previous header when it precedes the request's `startSeq`); (d) `interruptCompactions` closes a still-running compaction at the next session boundary with the stable marker `COMPACTION_INTERRUPTED_ERROR`; (e) `applyTurnErrors` attaches a turn's error to that turn's *last* assistant request; (f) tool schemas are captured per `callId` from the header that was in force at the call's anchor seq.
- Edge cases / failure handling: requests are sorted by `startSeq` *after* the sweep, and `interruptCompactions` runs over the sorted list so boundary matching is monotonic.
- Surprising: `captureSchemas` is guarded by `previousHeader.seq < contribution.anchorSeq` — the schema recorded for a call is the one visible *at call time*, not the current one, so a later tool-catalog change does not rewrite history.

### packages/client/ui-trajectory/src/client/layout.ts
- Purpose: the pure fold from a snapshot into turn → group → cell rows.
- Key abstractions: `TrajectoryGroupModel`, `TrajectoryTurnModel`, `TrajectoryLayoutInput`, `deriveTrajectoryLayout`, `appendTrajectoryPartialLayout`, plus the helpers `expandAssistant`, `expandSubCalls`, `withSubCalls`, `summarizeCall`, `summarizeResult`, `detailResult`, `sourceBlock`, `groupDescription`, `enclosingUserTurn`, `steeringPlacement`, `indexFollowingAssistants`, `enclosingPromptTurn`.
- Data flow: `TrajectorySnapshot` → ordered layout entries → buckets by turn → groups by Message/Step → cells with monotonically increasing `index`.
- Non-obvious design decisions: (a) **a user message has no turn on the wire**, so it is enclosed by the *next* assistant turn, else the in-flight partial, else one past the last assistant (`enclosingUserTurn`); (b) `indexFollowingAssistants` is a single backwards pass computing, for every node, the next assistant node — the same map answers both the user-message and the prompt-change turn question; (c) a landed compaction node renders **no cell** but still advances the duration cursor, because Chat already owns the human-facing marker; (d) `groupDescription` computes a wall span plus a tool histogram (`3,000 ms bash×2`) — a tool row contributes both its start and its start+duration so a single tool still spans call→result; (e) `appendTrajectoryPartialLayout` re-derives only the partial and merges it into the finalized layout, sharing the finalized turn objects by reference (`streamed[0] === base[0]`) so unaffected turns do not re-render; (f) `durationSeconds` and `finiteTime` never produce `NaN` — an unusable time yields `null`.
- Edge cases / failure handling: orphan turn-0 cells (tools with no turn) fold into turn 1 rather than creating a phantom turn. `attachToolSchema` writes the schema as pretty JSON only when one is known.
- Surprising: the fold's own cell `index` is a *display* counter that is dense and monotonic across the whole turn — it is the identity the timeline, the virtualizer and the search index all speak, and it is decoupled from the durable event seq.

### packages/client/ui-trajectory/src/client/timeline.ts
- Purpose: the operation-sequence and recorded-time projections for the overview.
- Key abstractions: `TrajectoryTimelineMode` (`'sequence' | 'duration' | 'time' | 'actual'`), `TrajectoryTimeRange`, `TrajectoryTimelineSpan`, `TrajectoryTimelineTurnBoundary`, `TrajectoryTimelineModel`, `deriveTrajectoryTimeline`, `trajectoryTimelineFocusIndexes`, `formatTimelineOffset`, `laneFor`.
- Data flow: turn models → spans in the active domain → the overview component; a selected range → the set of focused record indexes.
- Non-obvious design decisions: four modes are two independent axes — *equal vs recorded width* and *compressed vs complete time* — so `sequence | duration | time | actual` are the four combinations. `duration` compresses every idle gap (the idle time between spans is subtracted from each span's start) while `actual` keeps wall-clock. `laneFor` puts tools in lane 2, messages in lane 1 and everything else in lane 0 — a three-lane semantic layout, not a time layout.
- Edge cases / failure handling: a cell with no `startedAt` produces **no span at all** — an in-flight record cannot be positioned in a time domain, which is why the overview renders a start marker instead.
- Surprising: `trajectoryTimelineFocusIndexes` selects records *overlapping* the inclusive range (`span.start <= range.end && span.end >= range.start`), so a record that straddles the range edge is inside it.

### packages/client/ui-trajectory/src/client/trajectory-search-index.ts
- Purpose: an incremental full-text index over the ledger.
- Key abstractions: `SearchEntry` (sources + lowercased text), `recordSources`, `markdownPreview`, `resultPreview`, `TrajectorySearchIndex` with `update(layouts)` and `search(query)`.
- Data flow: layouts → `update()` → a `Map<recordId, SearchEntry>` → `search(query)` → a `Set<recordId>`.
- Non-obvious design decisions: `update()` returns whether the indexed version changed, and it **reuses the previous entry when the record's `sources` array is unchanged** (`sameSources`) — so the Markdown preview is re-parsed only when one record's source actually changed. The index is keyed by `trajectoryRecordId`, so it survives a prepend. Matching is a plain `includes` over every term (AND semantics), lowercased.
- Edge cases / failure handling: `searchableJson` swallows a `JSON.stringify` failure and contributes an empty string rather than throwing.
- Surprising: the index covers far more than the visible text — the turn label, the group, the kind, the input detail, the output detail, the thinking detail, the tool schema, every source block's type/content/callId/toolName/attachment name, and the JSON of the message source and the prompt snapshots. A tool schema is searchable.

### packages/client/ui-trajectory/src/client/trajectory-virtual-rows.ts
- Purpose: the pure projection from records to measurable virtual ledger rows.
- Key abstractions: `VirtualizableTrajectoryRecord`, `TrajectoryVirtualRowEntry`, `TrajectoryVirtualRow`, `trajectoryVirtualRecordKey`, `groupTrajectoryVirtualRows`.
- Data flow: records (after fold/search/collapse) → virtual rows (each with a height and a key) → the virtualizer's `count` / `estimateSize` / `getItemKey`.
- Non-obvious design decisions: **a zero-height `requestOnly` separator is attached to the next content row** — the virtualizer never owns a zero-height item; the terminal separator is kept as its own 9 px row so its CSS lower-marker clearance survives. `trajectoryVirtualRecordKey` `encodeURIComponent`s the record identity so the key is DOM-safe (it becomes a `data-` attribute and a query selector), and appends a `\u0000summary\u0000<kind>` suffix so a folded summary is distinguishable from the record it summarises.
- Edge cases / failure handling: the row height is 30 px for a content row and 20 px for a collapsed summary — the two heights are constants in this file, duplicated by the CSS.
- Surprising: the row's `key` is derived from the *content* row even when the row carries several entries — so attaching a separator to a row never changes that row's identity.

### packages/client/ui-trajectory/src/client/code-program.ts
- Purpose: reading replayable PTC source and a language hint from recorded tool arguments and schemas.
- Key abstractions: `PTC_TOOL_NAME = 'run_code'`, `CodeProgram`, `recordedLanguage`, `codeProgram(cell)`.
- Data flow: a recorded tool cell's `inputDetail` (raw JSON arguments) + `schemaDetail` (the tool schema visible at call time) → a `CodeProgram`.
- Non-obvious design decisions: the doc comment says "Resolve a PTC program **without guessing its language from source or current runtime settings**" — the language comes only from the recorded parameter description, and only when it is *unambiguous*: `if (typescript === python) return undefined` (a description naming both is treated as no hint).
- Edge cases / failure handling: `parseRecord` catches a JSON parse failure and returns undefined; a `code` that is not a string, or a `description` that is not a string, declines the program entirely rather than half-rendering it. `rawInput` is the *verbatim* argument text (whitespace included).
- Surprising: when the recorded description is absent or blank, the description falls back to the first non-empty source line — a display convenience that never touches the recorded source.

### packages/client/ui-trajectory/src/client/copy-codes.ts
- Purpose: the stable non-display markers for client-synthesized copy.
- Key abstractions: `COMPACTION_INTERRUPTED_ERROR = 'trajectory.compaction-interrupted'`.
- Data flow: the snapshot builder writes it into a request's `error`; the layout and the table recognise it and substitute a localized sentence.
- Non-obvious design decisions: the marker is a **non-localized code**, not user-facing text — "Error marker localized only when the trajectory renders it."
- Edge cases / failure handling: n/a.
- Surprising: four lines carry an internal error identifier across three modules (builder → layout → table) without it ever reaching the user verbatim.

### packages/client/ui-trajectory/src/client/duration-store.ts
- Purpose: the browser-wide trajectory duration preference source.
- Key abstractions: `createTrajectoryDurationStore(): SnapshotStore<boolean>`.
- Data flow: `createSnapshotStore(false, {persist: {name: 'dsh.trajectory.duration'}})` → localStorage → the toolbar's "use actual duration" toggle.
- Non-obvious design decisions: the store is created **once per plugin lifecycle** (in `apply`) and shared by every session's view injection — `views.client.spec.tsx:480` asserts the same store object is handed to two different sessions and that localStorage holds no per-session key.
- Edge cases / failure handling: the default is `false` (equal-width blocks).
- Surprising: the persisted key has no session id in it — the preference is deliberately browser-wide, not per session.

### packages/client/ui-trajectory/src/client/string-wrapping-store.ts
- Purpose: the browser-wide default for expanded JSON strings.
- Key abstractions: `createTrajectoryStringWrappingStore(): SnapshotStore<boolean>`.
- Data flow: same shape as the duration store, persisted at `dsh.trajectory.jsonStringWrapping`.
- Non-obvious design decisions: the doc comment says the preference is "**sampled only when a string is expanded**" — it is a default, not a live binding, so an already-open inspector is not rewritten when the preference changes elsewhere.
- Edge cases / failure handling: the default is `false`.
- Surprising: `string-wrapping-store.client.spec.ts` proves the round trip: a new store instance reads back the persisted value.

### packages/client/ui-trajectory/src/client/TrajectoryCell.tsx
- Purpose: the legacy standalone trajectory cell, retained for direct consumers and specs.
- Key abstractions: `KIND_LABEL_KEY`, `TAG_CLASS`, `TrajectoryCell`.
- Data flow: props → a one-line row: `#index · KIND · text · metrics · time`.
- Non-obvious design decisions: the component **destructures and discards most of its props** (`inputDetail: _inputDetail`, `schemaDetail: _schemaDetail`, …) — the legacy cell renders only the summary, and the file's comment says so. It re-exports `formatElapsedSeconds` and the record types for external consumers.
- Edge cases / failure handling: metrics are shown only for `kind === 'message'`.
- Surprising: `TAG_CLASS` maps `compacted` to the *system* tag class — the legacy cell has no distinct compaction colour.

### packages/client/ui-trajectory/src/client/TrajectoryCell.module.css
- Purpose: the styles for the legacy cell row.
- Key abstractions: `.root`, `.selected`, `.index`, `.tagSlot`, `.tag` + per-kind colour classes, `.text`, `.trailing`, `.metric`, `.time`.
- Data flow: n/a (declarative).
- Non-obvious design decisions: the trailing lane is a **fixed 320 px** (`4×71 + 3×12`), documented in the CSS, and the comment says it matches `TrajectoryTurnHeader`'s column geometry exactly — the header and the cells share one metric grid.
- Edge cases / failure handling: `.root[data-kind='subtool']` adds 8 px of left padding so nested calls read as nested.
- Surprising: the kind tag colours are built from `color-mix()` over design tokens rather than hard-coded values — the tint for "message" is a mix of the brand colour and the error colour.

### packages/client/ui-trajectory/src/client/TrajectoryGroupHeader.tsx
- Purpose: the "Message" / "Step N" row with an optional description.
- Key abstractions: `TrajectoryGroupHeaderProps`, `TrajectoryGroupHeader`.
- Data flow: title + optional description → one 36 px row.
- Non-obvious design decisions: the description element is **omitted entirely** when empty rather than rendered blank — `layout.client.spec.tsx:58` asserts the span count.
- Edge cases / failure handling: n/a.
- Surprising: it is the only component in the package that takes no locale translator — the title is already localized by the layout.

### packages/client/ui-trajectory/src/client/TrajectoryGroupHeader.module.css
- Purpose: the styles for the group title row.
- Key abstractions: `.root`, `.title`, `.description`.
- Data flow: n/a.
- Non-obvious design decisions: the description is ellipsised (`overflow:hidden; text-overflow:ellipsis; white-space:nowrap`) so a long wall-span label cannot break the row.
- Edge cases / failure handling: n/a.
- Surprising: 27 lines; the whole file is three rules.

### packages/client/ui-trajectory/src/client/TrajectoryTurn.tsx
- Purpose: one turn section — a sticky header plus the padded Message/Step body.
- Key abstractions: `TrajectoryTurnProps`, `TrajectoryTurn`.
- Data flow: `turn` + children → a `<section data-turn>`.
- Non-obvious design decisions: the section carries `data-turn={turn}` so the DOM mirrors the model; the header is rendered by the component rather than passed in.
- Edge cases / failure handling: n/a.
- Surprising: this component is **not used by the current ledger** — `TrajectoryTable` renders the turn rail and turn label inline. It survives for direct consumers and specs (see `layout.client.spec.tsx:65`).

### packages/client/ui-trajectory/src/client/TrajectoryTurn.module.css
- Purpose: the styles for one turn block.
- Key abstractions: `.root`, `.body`.
- Data flow: n/a.
- Non-obvious design decisions: the body is capped at **880 px** and centred (`max-width: 880px; margin: 0 auto`) — the ledger reads as a centred document column, not a full-bleed table.
- Edge cases / failure handling: n/a.
- Surprising: the 880 px lane is the same lane the sticky turn header uses (`TrajectoryTurnHeader.module.css`), so the header and body align exactly.

### packages/client/ui-trajectory/src/client/TrajectoryTurnHeader.tsx
- Purpose: the sticky per-turn bar with the Input/Output/Think/Time column labels.
- Key abstractions: `COLUMN_LABEL_KEYS`, `TrajectoryTurnHeaderProps`, `TrajectoryTurnHeader`.
- Data flow: turn + translator → one 44 px sticky bar.
- Non-obvious design decisions: the column labels are `aria-hidden="true"` — the bar is decorative chrome for sighted users, and the numbers are read from the rows themselves.
- Edge cases / failure handling: n/a.
- Surprising: the label row is not a real `<table>` header; it is a visual grid that mirrors the metric columns of the legacy cell.

### packages/client/ui-trajectory/src/client/TrajectoryTurnHeader.module.css
- Purpose: the styles for the sticky turn bar.
- Key abstractions: `.root`, `.inner`, `.title`, `.columns`, `.column`.
- Data flow: n/a.
- Non-obvious design decisions: the bar is full-bleed (`width:100%`) but its *content* lives in the same centred 880 px lane; the columns lane is 320 px with a `margin-right: 8px` so "Time" lines up with the cell's trailing lane.
- Edge cases / failure handling: n/a.
- Surprising: the background is `var(--dsw-alias-button-ghost-active-fill)` — the sticky bar reuses the *button ghost* fill rather than a dedicated surface token.

### packages/client/ui-trajectory/src/client/TrajectoryToolbar.tsx
- Purpose: the sticky toolbar — duration/actual-time toggles, whole-list fold, live search.
- Key abstractions: `TrajectoryToolbarProps` (11 props), `TrajectoryToolbar`.
- Data flow: props → a `role="toolbar"` bar with four buttons and a search input.
- Non-obvious design decisions: the "actual time" switch is **present but `hidden`** — it is a fully wired control whose visibility is switched off, so the affordance can be re-enabled without touching the projection. The duration toggle is an `aria-pressed` toggle button whose `title` flips to the *other* action's label ("Use equal-width operations" / "Use actual duration"). The fold buttons swap a glyph (`⊞`/`⊟`) rather than an icon component.
- Edge cases / failure handling: n/a.
- Surprising: the toolbar is the only component in the package that renders its own `<svg>` clock glyph inline instead of using the shared icon set.

### packages/client/ui-trajectory/src/client/TrajectoryToolbar.module.css
- Purpose: the styles for the toolbar.
- Key abstractions: `.root`, `.inner`, `.actions`, `.toggle`, `.control` (+ `.controlTrack`/`.controlThumb`), `.action`, `.actionIcon`, `.search` (+ `.searchIcon`/`.searchInput`).
- Data flow: n/a.
- Non-obvious design decisions: the toolbar height is a CSS variable `--dsh-trajectory-toolbar-height` (32 px) **declared by the parent** (`views.module.css`), so the table can reserve exactly the right offset. The search field is `flex: 0 1 164px` with `min-width: 84px` — it shrinks before anything else.
- Edge cases / failure handling: `.control[hidden] { display: none }` — an explicit rule, because `display:inline-flex` would otherwise defeat the `hidden` attribute.
- Surprising: the switch track/thumb are hand-built (a 20×10 pill with a 6 px round thumb) using `corner-shape: round` — the only place in the package that rolls its own control chrome.

### packages/client/ui-trajectory/src/client/TrajectoryTimeline.tsx
- Purpose: the fixed overview timeline that focuses the ledger.
- Key abstractions: `TrajectoryTimelineProps`, `assistantTimingDetail`, `timelineRecordDetail`, `timelineKindLabel`, `timelineTooltipLabel`, `LaneLabels`, `EarlierHistoryBoundary`, `TrajectoryTimeline` (memoised).
- Data flow: turn models + mode + selected range → spans positioned by CSS custom properties; pointer gestures → `onRangeChange` / `onRecordSelect` / `onRecordFocus`.
- Non-obvious design decisions: (a) `assistantTimingDetail` splits the assistant bar into **TTFT (`firstToken - stepStart`) and decoding (`completed - firstToken`)**, and refuses to compute either unless all three timestamps are finite and ordered; (b) the whole timeline is rendered as **CSS custom properties on spans** (`--trajectory-span-left/width/gap/lane`, `--trajectory-assistant-ttft`) so the browser does the layout and the JS only computes ratios; (c) the wheel handler is a **non-passive listener with `preventDefault`** so the wheel zooms instead of scrolling the page; the zoom is exponential (`Math.exp(deltaY * 0.0015)`) and anchored at the pointer; (d) the right mouse button pans a zoomed viewport, and a right *click* (under 3 px) clears the selection; (e) a click on a span selects the record and clears the range; a click on whitespace focuses the nearest span; (f) the timeline auto-pans when a selection lands outside the current viewport — but only far enough to reveal it.
- Edge cases / failure handling: `onPointerCancel` clears every gesture state; `Escape` clears the selection; a selection that falls outside the model clears itself via an effect. The `EarlierHistoryBoundary` stops pointer events from propagating so hovering it does not arm the timeline hover line.
- Surprising: the tooltip delay is 500 ms — long enough that a sweep across the timeline does not strobe tooltips.

### packages/client/ui-trajectory/src/client/TrajectoryTimeline.module.css
- Purpose: the styles for the overview timeline.
- Key abstractions: `.root`, `.plot`, `.labels`, `.track`, `.earlierHistory`, `.empty`, `.lanes`, `.turnBoundaries`, `.turnBoundary`, `.span` (+ per-kind / per-state variants), `.selection`, `.selectionEdges`, `.hoverLine`.
- Data flow: n/a — the JS supplies ratios; the CSS positions.
- Non-obvious design decisions: the assistant span is a **two-stop gradient** whose split point is the TTFT fraction, so one bar shows two bottlenecks; the selection is dimmed *outside* the interval with two 100 vw box-shadows rather than a mask. The lane offset is `calc(var(--trajectory-span-lane) * 14px)` — three fixed lanes.
- Edge cases / failure handling: `.span[data-equal-duration='true']` forces a fixed 8 px width for the equal-width mode; `.span[data-search-match='false']` drops the opacity to 0.14.
- Surprising: the whole viewport animation is gated behind `@media (prefers-reduced-motion: no-preference)`.

### packages/client/ui-trajectory/src/client/TrajectoryTable.tsx
- Purpose: the virtualized turn-aware ledger plus the local record inspector (the largest file in the package, 3 538 lines).
- Key abstractions: `TableRecord`, `VirtualRowStructure`, `useStableVirtualRowStructure`, `DetailTab`, `TrajectoryRequestNumber`, `TrajectoryUsage`, `flattenRecords`, `filterRecords`, `collapseTurnRecords`, `collapseAssistantRecords`, `stateOf`, `statusLabel`, `requestErrorMessage`, `TokenRows`, `UsageRows`, `RequestUsagePanel`, `RequestOptions`, `MessageSource`, `detailTabs`, `RecordPresentation`, `SourceBlocks`, `RecordAttachments`, `AssistantToolCalls`, `ToolCatalog`, `SystemPromptDiff`, `RecordPayload`, `RecordSchema`, `InspectorCopyButton`, `ProgramInput`, `ProgramOutput`, `OverviewSection`, and the `TrajectoryTable` component itself.
- Data flow: turn models → records → (search filter | turn fold | assistant fold) → virtual rows → `<table>` rows; a selection opens the `<aside>` inspector with a tab set chosen per record kind.
- Non-obvious design decisions: (a) **`useStableVirtualRowStructure` reuses the previous `{key,height}` array when the row count and every row's key+height are unchanged** — a content-only stream update therefore does not invalidate the virtualizer's measurements; (b) the virtualizer is configured with `anchorTo:'end'`, `followOnAppend:'auto'`, `overscan: 12`, `scrollEndThreshold: 2` and a `scrollMargin` for the history-load row; (c) **tail following is opt-out** — the scroll handler recomputes `followsTableTail` from the distance to the bottom, and the layout effect only writes `scrollTop = scrollHeight` while following; (d) the table is a real `<table>` with `aria-rowcount`, per-row `aria-rowindex`, `aria-selected`, and a per-row `aria-label` composed from the request number, kind and content; (e) the inspector's tab set is **kind-dependent** — a system record gets System Prompt / Tools / Diff, a tool record gets Summary / Payload / Result / Schema / Timing; (f) the recently-used tab is remembered in a `tabHistory` ref so re-selecting a record returns to the tab you last used; (g) `stateOf` derives Pending/Complete/Failed from the *record's own facts* rather than a stored flag; (h) a retry's error is labelled "Last attempt error" while the request is running or complete and only becomes "Error" when the request itself failed; (i) `parseJsonContainer` + `parseToolSchema` degrade a non-JSON payload to plain text rather than an error; (j) `clickSelectsText` prevents a timestamp toggle from eating a text selection.
- Edge cases / failure handling: the cross-view inspect handoff **stays pending** when the target is not found — `onInspectApplied` is only called once the record is resolved, so a history page that arrives later completes the request; the scroll-anchor logic distinguishes the virtualized path (`scrollToIndex`) from the non-virtualized path (`scrollIntoView`); the older-page load preserves the visible anchor by restoring `scrollTop + (scrollHeight - anchor.scrollHeight)`.
- Surprising: the ledger never *filters* on a timeline selection — the focused rows are marked `data-timeline-focus="inside"|"outside"` and dimmed by CSS, so the surrounding context stays visible.

### packages/client/ui-trajectory/src/client/TrajectoryTable.module.css
- Purpose: the styles for the ledger and the inspector (1 989 lines).
- Key abstractions: `.split`, `.tablePane`, `.historyLoading`, `.historyLoadRow`/`.historyLoadButton`, `.table` + `.eventColumn`/`.contentColumn`, `.requestBoundaryControl`, `.turnRail`/`.selectionRail`, `.turnLabel` (+ full/compact variants), `.kindSlot`/`.kindTag`, `.content`/`.resultPreview`, `.details`/`.detailsResizeHandle`/`.detailTabs`/`.detailBody`, `.overview`/`.overviewSections`/`.overviewSection`, `.programPanel`, `.markdownPayload`, `.payload`, `.sourceBlocks`, `.attachments`, `.assistantToolCalls`, `.toolCatalog`, `.resultBlocks`, `.promptDiff*`.
- Data flow: n/a.
- Non-obvious design decisions: a **container query** (`@container trajectory-table (max-width: 620px)`) collapses the event column, swaps the kind tag for its icon and the turn label for its compact `#N` form — the responsive strategy is container-based, not viewport-based, because the ledger lives in a resizable split pane. The `requestBoundaryControl` is a 16 px dot with a `data-label` tooltip that appears on hover. The summary scroll regions keep their scrollbar thumb transparent until hovered (`--dsh-scrollbar-thumb: transparent`) *without* changing the reserved geometry. The `.details` pane becomes an overlay under 760 px.
- Edge cases / failure handling: `tr[data-request-only='true']` has zero height and no border — the separator contributes nothing but its marker; the terminal one keeps 9 px for the lower half of the marker. `tr[data-turn-start='true']` draws a 2 px turn rule with `transform: translateY(-50%)`.
- Surprising: the `.table:not([data-scroll-ready='true']) { visibility: hidden }` rule hides the whole table until the tail has been positioned — the ledger is invisible rather than showing a mis-scrolled first paint.

### packages/client/ui-trajectory/src/client/TrajectoryView.tsx
- Purpose: the view host — history windowing, request numbering, search, timeline focus, and the composition of toolbar + timeline + ledger.
- Key abstractions: `TrajectoryViewInjected`, `requestUsage`, `addUsage`, `partialStructureSignature`, `timelineBlock`, `containsCall`, `lastCellIndex`, and the `TrajectoryView` component.
- Data flow: `useTrajectory` (the target snapshot) + `useSession` (paging state) → a bounded inspection window → the finalized layout + the streaming partial → the toolbar, the timeline and the ledger.
- Non-obvious design decisions: (a) **the history window is anchored at the tail**: `historyTailSeq` fixes the tail, `historyNodeLimit` (50) bounds the visible slice, and `inspection` slices `eventNodes` and filters `requests` by `startSeq`/`resultSeq` against the slice's first seq (`:174-184`); (b) **request numbers and cumulative usage are computed from the COMPLETE resident snapshot**, not the window — so the numbers do not renumber when a page is revealed (`:209-312`); (c) the search index is updated on a **3 s throttle** after the first update, and the layout identity check (`this.layouts === layouts`) makes a no-op update free; (d) the timeline gets a *separate*, text-stripped projection of the partial (`timelineBlock` blanks text/reasoning and keeps only the tool-call identity) so the timeline does not re-render on every streamed character; (e) `partialStructureSignature` is the memo key for that projection — the partial's *structure*, not its content; (f) the view asks the conversation shell to float the composer over the ledger via `data-conversation-composer-overlay`; (g) `loadOlder` first reveals *resident* older nodes before asking the session for another page.
- Edge cases / failure handling: a cross-view `inspectCall` that is outside the window widens the window rather than failing (`:205-208`).
- Surprising: the search index covers the finalized layout *and* a separate partial-only layout, so a streaming assistant's text is searchable before it settles.

### packages/client/ui-trajectory/src/client/views.module.css
- Purpose: the full-bleed fixed-height host for the ledger.
- Key abstractions: `.root`, `.ledger`.
- Data flow: n/a.
- Non-obvious design decisions: the root declares `--dsh-trajectory-toolbar-height: 32px` and the ledger declares `--dsh-trajectory-bottom-clearance: calc(var(--dsh-composer-height, 152px) + 16px)` — the composer publishes its *live* height, and the ledger reserves it so the final rows stay reachable under the floating composer.
- Edge cases / failure handling: the clearance has a fallback of 152 px when the composer height is not published.
- Surprising: the composer-overlay contract is a **CSS custom property published by the host**, not a prop — the trajectory asks for the overlay with a data attribute and reads the height from a variable.

### packages/client/ui-trajectory/tests/locale.client.ts
- Purpose: the test translator factory.
- Key abstractions: `translator(dictionary)`, the exported `t` (English) and `tZh` (Chinese).
- Data flow: merges the shared locale package's dictionary with the trajectory dictionary and interpolates `{name}` placeholders.
- Non-obvious design decisions: the trajectory dictionary is layered **on top of** the common one, which is how the package's own `copy.*` keys override the shared ones.
- Edge cases / failure handling: a missing key falls back to the key name; a non-scalar parameter interpolates as an empty string.
- Surprising: this file is not a spec — it is a shared fixture, and the manifest's `type` column says `tests` for it.

### packages/client/ui-trajectory/tests/string-wrapping-store.client.spec.ts
- Purpose: the persistence contract for the JSON-string-wrapping preference.
- Key abstractions: one test, the `beforeEach`/`afterEach` localStorage save/restore.
- Data flow: create a store → set a value → create another store → read it back.
- Non-obvious design decisions: the test restores the original localStorage value after the case, so it does not pollute other specs.
- Edge cases / failure handling: n/a.
- Surprising: it proves a *browser-wide* preference survives a view being recreated — the scenario a user hits when they close and reopen the session.

### packages/client/ui-trajectory/tests/virtual-rows.client.spec.ts
- Purpose: the measurable virtual-row grouping and durable identity contracts.
- Key abstractions: seven tests covering grouping, terminal clearance, collapsed height, prepend stability and DOM-safe keys.
- Data flow: records → `groupTrajectoryVirtualRows` → rows.
- Non-obvious design decisions: the tests pin the two behaviours that keep a virtualizer honest — **a row's key does not change when an older page is prepended**, and a request boundary joining a row does not change that row's key.
- Edge cases / failure handling: the DOM-safe key test asserts the exact escaped form (`message%00call%00call%20with%20spaces%2Fand%3Fpunctuation`).
- Surprising: the key is `encodeURIComponent`d *including* the `\u0000` separators, so the encoded key is still a legal attribute value and selector.

### packages/client/ui-trajectory/tests/code-program.client.spec.ts
- Purpose: the recorded PTC argument validation and the historical language selection.
- Key abstractions: a table-driven set of cases over malformed arguments and over ambiguous schema descriptions.
- Data flow: a `TrajectoryCellProps` → `codeProgram` → a `CodeProgram` or `undefined`.
- Non-obvious design decisions: the language test uses the *recorded parameter description* as the only source, and includes the ambiguous case (`'A TypeScript or Python program.'` → `undefined`) alongside the missing-schema cases.
- Edge cases / failure handling: `'{"code":42}'` and `'{"code":"x","description":[]}'` both decline; `undefined`, `'{'`, `'[]'`, `'null'`, `'42'` and `'{}'` all decline.
- Surprising: `run_code_extra` is refused — the tool-name match is exact, not a prefix.

### packages/client/ui-trajectory/tests/event-projection.client.spec.ts
- Purpose: the context-source classification, the assistant-block projection, the failure redaction and the token-delta predicate.
- Key abstractions: five tests.
- Data flow: raw event payloads → `contextProducer` / `contextForm` / `toAssistantBlock` / `displayFailure` / `isTokenDelta`.
- Non-obvious design decisions: the tests pin the **redaction** — `displayFailure({code:'AUTH', message:'secret'})` must be `{code:'AUTH', message:''}` — and the extension behaviour — an unknown `kind` stays visible as its own label.
- Edge cases / failure handling: `contextProducer(null)`, `[]` and `{kind:''}` all degrade to `{role:'inject', label:null}`.
- Surprising: `displayFailure({code:'UNKNOWN'})` yields the message `'{"code":"UNKNOWN"}'` — a missing message falls back to the JSON of the whole failure.

### packages/client/ui-trajectory/tests/snapshot-builder.client.spec.ts
- Purpose: the snapshot builder's header inheritance, prompt-change consumption, schema capture and boundary handling.
- Key abstractions: five tests over a hand-built contribution list.
- Data flow: contributions → `TrajectorySnapshotBuilder.replace` → a snapshot.
- Non-obvious design decisions: the tests pin the two hard rules of the prompt model: a header is **inherited** by later requests without repeating its prompt change, and a same-step prompt change **survives** a later "series" header that supplies only the latest snapshot. They also pin that the tool schema captured for a call is the one visible at call time (an "exact" step header wins over a base one).
- Edge cases / failure handling: the boundary test asserts that two running compactions are closed at the *nearest* session boundary — the later one at seq 14, the earlier at seq 16 — so the pairing is by proximity, not by order of declaration.
- Surprising: the test names the rule directly: "indexes exact step headers and the active tool schema **without backward scans**".

### packages/client/ui-trajectory/tests/client-bundle.client.spec.ts
- Purpose: an acceptance test of the real tsdown artifact.
- Key abstractions: `readBundle()`, `loadArtifact()`, the `Handoff` interface.
- Data flow: read `lib/client.js` → `new Function(code)` in the window scope → `window.__ModuleLoader__.load(handoff)` → resolve externals through the injected `require` → call `apply` on a real `Context` with a real `SlotRegistry`.
- Non-obvious design decisions: the artifact is loaded through the *real* module-loader handoff and the externals are resolved from a hand-written map that **throws on an unexpected require** — so an external that escapes the bundle fails the test. The comment on the `new Function` call explains the linter exemption: "the implied-eval ban targets accidental string execution, not this deliberate built-bundle fixture".
- Edge cases / failure handling: every test is `it.skipIf(code === undefined)` — the suite is skipped when `dist/` is not built.
- Surprising: the third test asserts that the bundle **injects its own CSS as plugin-tagged `<style data-plugin=…>` tags during factory execution** — the styling is part of the artifact contract.

### packages/client/ui-trajectory/tests/code-inspector.client.spec.tsx
- Purpose: the PTC inspector — source, output, copying, and the wrapping preference.
- Key abstractions: a `Harness` that mounts `TrajectoryTable` with one tool cell.
- Data flow: a row click → the inspector → the Code / Result tabs → the clipboard.
- Non-obvious design decisions: the test pins the **sampling** semantics of the wrapping preference: toggling the wrap in inspector A does not change inspector B's already-open state, and re-opening A samples the current default again. It also pins that a failing run keeps its captured output visible next to the failure.
- Edge cases / failure handling: a malformed argument string (`'{"code":3}'`) makes the Code tab disappear and the Payload tab appear instead — the inspector degrades to a generic JSON view rather than an empty pane.
- Surprising: the copy assertions check the *exact* strings — the source keeps its trailing newline (`SOURCE.trimEnd()` is compared, so the recorded source is byte-exact) and the raw JSON keeps its recorded whitespace.

### packages/client/ui-trajectory/tests/cell.client.spec.tsx
- Purpose: the legacy cell's presentation and the duration formatters.
- Key abstractions: `formatDurationMillis` / `formatElapsedSeconds` expectations and three cell cases.
- Data flow: props → the legacy row.
- Non-obvious design decisions: the metric-order assertion reads the rendered span order out of the DOM (`texts.indexOf('136') < texts.indexOf('381') < …`) rather than asserting on classes — the column order is the contract.
- Edge cases / failure handling: `formatDurationMillis(NaN)` must be an em dash, not `0 ms`.
- Surprising: the em dash is the single "no data" glyph across the whole package.

### packages/client/ui-trajectory/tests/conversation-definitions.client.spec.ts
- Purpose: the acceptance suite for the five Definitions, driven through the real `ConversationNodeAssembler`.
- Key abstractions: a `DEFINITIONS` array fed by a fake `Context`, `TestEventDefinitions` / `TestViewDefinitions`, `at(seq, type, data, extra)` event builders, and `packedInputs()` which replays live chunks through a real `AssistantStreamAccumulator` to produce the packed `assistant/attempt` form.
- Data flow: raw events → the Definitions → the `trajectory` target snapshot.
- Non-obvious design decisions: the suite compares the **live-chunk** and the **packed-attempt** paths against each other and requires them to agree — the packed path is what a replayed history looks like, so the two must produce the same ledger. The `packedInputs` helper exists precisely to make that comparison possible. It also pins the compaction, the interrupted tool, the steering claim, and the whole prompt-change model (A→B→C comparisons, the compaction-shadowing case, and the three modes — replay / live / partial — where the *partial* mode prepends the missing prefix after the fact and expects the same answer).
- Edge cases / failure handling: an unknown replacement order leaves the prompt empty rather than guessing; a replacement that reaches an unloaded endpoint withholds the inherited prompt; an interrupted root tool keeps the raw error while a sibling that never ran is marked `Interrupted`.
- Surprising: the "withholds unknown replacement order in request headers until prepend" test proves the projection is *order-sensitive* and that it re-derives correctly once the missing prefix arrives — an explicitly uncertain state rather than a wrong answer.

### packages/client/ui-trajectory/tests/layout.client.spec.tsx
- Purpose: the layout fold, the turn chrome components, the sub-dispatch cells and the attachment mapping.
- Key abstractions: five `describe` blocks, plus `deriveTrajectoryLayout` / `appendTrajectoryPartialLayout` wrappers bound to the English translator.
- Data flow: conversation nodes → turn models → cells.
- Non-obvious design decisions: the test pins the **duration cursor** rule: a landed compaction renders no cell but still advances the cursor, so the next assistant's duration is measured from the compaction marker (9.5 s) and not from the earlier context row (9 s). It also pins that appending a streaming partial leaves the finalized turns *referentially identical* (`expect(streamed[0]).toBe(base[0])`).
- Edge cases / failure handling: missing node times produce `timeSeconds: null` rather than `NaN`; an image-only user record is labelled `Images ×1` with no text preview; a wire-shaped block with a `url` instead of an `attachment` is shown as JSON, not as an image.
- Surprising: the same tool-update summary is asserted in English and Chinese with a two-line `inputDetail` — the localised string and the *structure* of the detail are both pinned.

### packages/client/ui-trajectory/tests/table.client.spec.tsx
- Purpose: the ledger's selection, details, status, folding, virtualization and paging behaviour.
- Key abstractions: a `TrajectoryTable` wrapper that infers request numbers from the group titles, an `imageSlotFixture()` built on `SlotTestRuntime` with a real `conversation.trajectory.images` slot registration, and the `TURNS` / `CALL_TURNS` fixtures.
- Data flow: turn models → the ledger → the inspector.
- Non-obvious design decisions: the fixture builds a **real slot registry** so the image gallery is exercised through the framework's `renderSlot` seat rather than a stub. The virtualization tests assert the *observable* consequences: only the visible window is mounted, `aria-rowcount` still reports 500, a bottom spacer row exists, and a content-only streaming update **does not call `scrollTo`**. The request-number tests prove that a selection survives a prepend that renumbers the request (`Request #1` → `Request #2`).
- Edge cases / failure handling: the older-page tests assert the anchor is preserved (`scrollTop === 60`), that the load control stays the first row with `aria-rowindex=1` while pending, that a page started *outside* the ledger is reflected in the same control, and that a failed page load restores the control to idle.
- Surprising: the "distinguishes retry history from the current request status" case runs in both English and Chinese and asserts that a *completed* request with a retained error shows "Last attempt error" and **not** "Error" — and that the retained error text is not styled as an error.

### packages/client/ui-trajectory/tests/views.client.spec.tsx
- Purpose: the full acceptance suite on the real framework stack.
- Key abstractions: a `bench()` that builds a real `SlotTestRuntime`, a real `UiConversation`, a real `SlotRegistry` and the real plugin fiber; a `mount()` that mounts the strict `ConversationSession` / `ConversationSessionHeader` over the ring with outlet-faithful render shares; and a `standaloneProps()` factory for isolated `TrajectoryView` rendering.
- Data flow: the plugin's `apply` → the ring → the view → the ledger and the timeline.
- Non-obvious design decisions: the suite asserts the **plugin lifecycle**: disposal removes the tab and empties the event and view registries, and the tab label re-renders on a locale change without re-registration. It also asserts the *scope* of the duration preference (one store across two sessions, no per-session localStorage key) and that `loadOlder()` returns whether the *trajectory snapshot* changed.
- Edge cases / failure handling: the timeline cases pin the gesture grammar — the right button clears the selection without changing the zoom, a right *drag* pans without changing the selection, the wheel cancels native scrolling, and a zoomed viewport pans only far enough to reveal a newly selected record. The paging tests pin the bounded window (5 000 nodes → 51 rows → 101 rows after one reveal) and that a replaced window stays bounded when its predecessor tail is absent.
- Surprising: the "keeps resident request numbering and cumulative usage outside the layout page" case asserts the cumulative usage of the *11th* request is 11 tok even though the 11th request is outside the visible 50-node window — the numbers are session-wide while the rows are windowed.

## Ideas worth stealing

- **A retry is history, not the current status — keep both, label them apart** — `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:3168` — the inspector shows the retained retry error under the heading "Last attempt error" while the request is running or completed, and only renames it to "Error" when the request itself failed; the request's `status` is computed from the current attempt alone (`trajectory-assistant-definition.ts:294`). For August this is the difference between a ledger that says "the turn failed" and one that says "attempt 2 of 3 failed, attempt 3 is in flight" — the same confusion the August turn-end reason vocabulary already has to distinguish.

- **Reset the streamed content on a retry but keep the first-token time and the usage** — `packages/client/ui-trajectory/src/client/trajectory-assistant-definition.ts:366` — the `llm/retry` branch rebuilds the state from `initialState` (so the abandoned attempt's text is not shown as output) and then re-injects `firstTokenTime` and `usage` from the previous state. August's TTFT and throughput numbers must survive a retry the same way, or a retried turn's metrics will be measured from the wrong origin.

- **Choose the render cadence by event kind** — `packages/client/ui-trajectory/src/client/trajectory-assistant-definition.ts:388` — `publication` returns `'animation-frame'` for content deltas, `'immediate'` for a settled message or a tool result, and `'none'` for `usage`/`finish`/`step/start`. August's streaming transcript can adopt the same three-way knob: coalesce content to a frame, publish structure immediately, drop the bookkeeping frames.

- **Separate a structural change from a content-only change in the view builder** — `packages/client/ui-trajectory/src/client/trajectory-snapshot-builder.ts:176` — `apply` only rebuilds the ordered contribution array when a node is new or its `anchorSeq` moved; a content-only update is a positional write into the existing array (`:182`). This is the mechanism that keeps a streaming transcript from re-sorting and re-rendering its whole history on every delta, and it is worth copying verbatim into August's session-window store.

- **Identity must survive a prepend** — `packages/client/ui-trajectory/src/client/trajectory-record.ts:112` — the identity ladder is `recordId → callId → sourceSeq → index`, never the array position, and the virtual-row key is `encodeURIComponent`d so it is DOM-safe (`trajectory-virtual-rows.ts:35`). August pages older history into a virtualized list; without this ladder the selection, the scroll anchor and the search hits all break on every page load.

- **A virtualizer must never own a zero-height item** — `packages/client/ui-trajectory/src/client/trajectory-virtual-rows.ts:51` — separator-only records are attached to the *next* content row, and only a terminal separator keeps its own 9 px row. Any August transcript that draws a separator or a marker row needs the same rule.

- **Cache the virtual row *structure* so a content-only update cannot invalidate the measurements** — `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:151` — `useStableVirtualRowStructure` reuses the previous `{key,height}` array when the row count and every row's key and height are unchanged. The observable effect is pinned by `tests/table.client.spec.tsx:806` ("does not re-scroll a virtual ledger when streaming only changes row content") — this is the difference between a transcript that stays pinned to the tail and one that jitters on every token.

- **Tail-following is opt-out and computed from the scroll position** — `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:2608` — the scroll handler sets `followsTableTail` from the distance to the bottom (2 px threshold), and only a following ledger writes `scrollTop = scrollHeight`. Scrolling up suspends following so an arriving record does not yank the reader away.

- **Bound the rendered window but keep the numbering session-wide** — `packages/client/ui-trajectory/src/client/TrajectoryView.tsx:159` and `:209` — the React-visible slice is 50 nodes anchored at the tail, while the request numbers and the cumulative usage are computed from the *complete* resident snapshot. August needs the same split: the rows are a window, the numbering is the session.

- **Incremental search that reparses Markdown only when a record actually changed** — `packages/client/ui-trajectory/src/client/trajectory-search-index.ts:97` — `update()` compares each record's `sources` array and reuses the previous entry when unchanged; the whole update is throttled to 3 s after the first (`TrajectoryView.tsx:34`). This is how August can search a live transcript without re-parsing Markdown on every frame.

- **Cap the preview, not the data** — `packages/client/ui-trajectory/src/client/trajectory-preview.ts:5` — 2 048 characters of source in, 512 out, and the Markdown is *not* parsed beyond the slice. A truncated preview is marked with an explicit ellipsis so the reader knows.

- **Redact at the projection boundary, not at the render** — `packages/client/ui-trajectory/src/client/trajectory-event-projection.ts:127` — a failure with `code === 'AUTH'` keeps the code and drops the message, with the reasoning spelled out: "Provider AUTH messages may echo a masked or partially preserved credential. Keep the raw diagnostic in the Session log, but never retain it in UI state." This is the same class of defect August's own notes warn about — a credential that rides into the transcript once is re-sent on every later turn. Keeping the raw in the log and dropping it from the UI state is the right seam.

- **Internal error markers never become user text** — `packages/client/ui-trajectory/src/client/copy-codes.ts:4` — a synthesized condition travels as `trajectory.compaction-interrupted` and is localized at the render site (`layout.ts:361`, `TrajectoryTable.tsx:751`). August's turn_end reason vocabulary should work the same way: a stable code in the log, a sentence in the UI.

- **A call that never returned becomes an explicit interrupted result** — `packages/client/ui-trajectory/src/client/trajectory-tool-definition.ts:198` — a started tool whose step or turn closed without a result is projected to a tool-result with `error: {name:'Interrupted', code:'interrupted'}`, ordered at `boundary.seq - 0.8`. A spinner that never resolves is the alternative; August should name the interruption instead.

- **Bound the tool subtree in both directions** — `packages/client/ui-trajectory/src/client/trajectory-tool-definition.ts:123` — `acceptsEdge` refuses a self-edge, an edge to an ancestor (cycle) and an edge whose combined depth would exceed 256; the render path carries a `visited` set as well. Subagent tool trees can cycle; a naive recursive render hangs.

- **Derive "typed mid-turn" from durable event order, not from a heuristic** — `packages/client/ui-trajectory/src/client/trajectory-message-definitions.ts:84` — a splice chain is materialized only when a batch is claimed, and only the *current* claim can classify a later `user/message` as steering. August can answer "was this a mid-turn injection or a new turn?" from the same event ordering.

- **A prompt change is anchored at the request that carried it and consumed exactly once** — `packages/client/ui-trajectory/src/client/trajectory-snapshot-builder.ts:246` — `consumedPromptChanges` ensures the first inheriting request carries the change and later requests carry only the prompt. A prompt/cache inspector that shows the change on every subsequent request is misleading; this is the rule for showing it once, at the right position.

- **A prompt change can exist without a new request header** — `packages/client/ui-trajectory/src/client/trajectory-request-header-definition.ts:56` — the system-message Definition reads the previous header through `reader.previous` and synthesises the change itself, because an in-history prompt update logs no header. August's prompt-inspector needs the same "the change is a property of the prompt, not of the header" model.

- **An uncertain surface yields an empty claim, not a wrong one** — `packages/client/ui-trajectory/src/client/trajectory-request-header-definition.ts:46` — when the replacement order cannot be established, the header is emitted with `system: ''` and the record stays visible. The same rule is tested in three modes (replay / live / partial) in `tests/conversation-definitions.client.spec.ts:849` and `:885`. "I do not know yet" is a state the projection must be able to represent.

- **Never fabricate a duration for work in flight** — `packages/client/ui-trajectory/src/client/timeline.ts:61` — a cell with no `startedAt` produces no span at all, and the overview renders a start marker rather than a growing bar. August's "working" indicator should show that something started, not a number it did not measure.

- **Split one assistant bar into TTFT and decoding** — `packages/client/ui-trajectory/src/client/TrajectoryTimeline.tsx:51` — the assistant span is drawn as a two-stop gradient whose split is the TTFT fraction (`TrajectoryTimeline.module.css:200`), and both metrics are refused unless all three timestamps are finite and ordered. Two different bottlenecks in one bar is a genuinely better read than one "duration" number.

- **Focus, do not filter** — `packages/client/ui-trajectory/src/client/timeline.ts:194` and `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:2752` — a timeline drag marks the overlapping records `data-timeline-focus="inside"` and dims the rest to 0.24 opacity rather than removing them. A harness that hides the rows outside a focus range loses exactly the context the user was trying to read.

- **Sample a persisted preference when the surface opens, and write it back on change** — `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:2358` and `:2375` — `activateTab`/`selectRecord` read `stringWrapping.getDefault()` into a local state at open, and the toggle calls `setDefault`. Two open inspectors therefore do not fight over one preference (`tests/code-inspector.client.spec.tsx:70`).

- **A preference is browser-wide, not per session** — `packages/client/ui-trajectory/src/client/duration-store.ts:9` — one store is created in `apply` and handed to every session injection; the test asserts the same object identity across two sessions and that no per-session key appears in localStorage (`tests/views.client.spec.tsx:480`).

- **The Chinese dictionary is the key set and the English one is typed against it** — `packages/client/ui-trajectory/src/client/locales.ts:7` and `:217` — `en: Record<TrajectoryKey, string>` makes a missing English key a **compile error**, not a runtime fallback to the key name.

- **Per-section hashes keep a bilingual doc pair honest** — `packages/client/ui-trajectory/README.i18n.yaml:1` — one hash pair per heading section, regenerated by `verify-translation-pairing --write`. A file-level hash would say "something changed"; a section-level hash says where.

- **Load the real built artifact, not a mock** — `packages/client/ui-trajectory/tests/client-bundle.client.spec.ts:23` — the test reads `lib/client.js`, runs it through the real `window.__ModuleLoader__` handoff, resolves externals through a `require` that **throws on an unexpected specifier**, and asserts the manifest id, the inject list, the CSS injection and the ring registration. This is the only test in the shard that can catch a bundler misconfiguration; unit tests cannot see it.

- **A plugin fiber's disposal must remove its tab and its registrations** — `packages/client/ui-trajectory/tests/views.client.spec.tsx:445` — after `fiber.dispose()` the view ring holds only Chat and the event and view registries are empty. Hot-reload safety is a contract worth pinning.

- **Accessibility as a first-class part of the layout** — `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:2630` and `:2721` — the ledger is a real `<table>` with `aria-rowcount` that reports the *whole* ledger (not the mounted window), per-row `aria-rowindex` that survives prepends, `aria-selected`, and a per-row `aria-label` composed from the request number, kind and content. A virtualized table that lies about its row count is a table that screen readers cannot navigate.

- **Fold the whole turn or the assistant's tool calls, but keep the first row** — `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:625` and `:689` — a folded turn keeps its first content row and replaces the rest with a one-line summary (`3 steps · 2 tool calls`); a folded assistant keeps the assistant row and summarises its calls (`2 tool calls · bash`). A fold that hides everything leaves the user with no anchor.

## Files skipped (with reasons)

None. All 60 files in the shard were opened and read, including the three CSS modules (`TrajectoryTable.module.css` 1 989 lines, `TrajectoryTimeline.module.css` 327 lines, `TrajectoryCell.module.css` 138 lines) and the two large test files (`views.client.spec.tsx` 1 601 lines, `table.client.spec.tsx` 1 332 lines) and the largest source file (`TrajectoryTable.tsx` 3 538 lines). There are no generated, vendored, binary or huge-data files in this shard; every file is hand-written source, config, docs or test.

## Uncertainties

- **`PartialArguments` (`@deepseek-ai/dsh-util-values`) is outside this shard.** I read its use sites (`PartialArguments.fromText`, `PartialArguments.fromObject`, `PartialArguments.EMPTY`) and the tests that construct it, but I did not read its implementation, so I can say that a malformed argument string yields a *partial* object rather than throwing (that is the documented behaviour of `fromText` at the call sites and in `tests/code-program.client.spec.ts`), but not *how* it salvages.
- **`assistantStreamFirstTokenTime` (`@deepseek-ai/dsh-llm/assistant-stream`) is outside this shard.** I read its implementation (34 lines, `packages/llm/llm/src/assistant-stream.ts:333`) to establish that the first-token time is reconstructed from the durable stream records and stops at the first qualifying delta, including a name-bearing tool-call run. Its relationship to the Trajectory `isTokenDelta` predicate is *not* one-to-one — the two live in different packages and use different definitions of "token" — and I did not verify whether they can disagree. The Trajectory side uses its own `isTokenDelta` (`trajectory-event-projection.ts:145`), the llm side uses `packages/llm/llm/src/assistant-stream.ts`'s own predicate; I checked that both treat a named tool-call run as a token start, but I did not prove they cannot diverge elsewhere.
- **`ConversationNodeAssembler`, `inspectRequestPrompt` and `inspectSystemPrompt` are in `packages/client/ui-conversation`, outside this shard.** The Definitions' correctness depends on their semantics (what `SystemPromptState.effective`/`uncertain`/`introduced` mean, and what `reader.previous` returns). I read the Definitions' use of them and the acceptance suite that drives them, but not their implementation. In particular, I could not verify from inside the shard exactly when `inspectSystemPrompt` reports `uncertain` — the Tests assert the observable consequences (empty prompt, withheld inheritance) rather than the predicate.
- **The `TrajectoryView`'s `useSession` / `useConversation` / `useInput` props come from the conversation host.** `TrajectoryView` destructures only `useSession`, `useTrajectory` and the injected face; the rest are spread from `ConvViewProps` and are not consumed by this package. I confirmed this from the component and from `tests/views.client.spec.tsx`'s standalone fixture, not from the host's implementation.
- **`ctx.uiConversation.imageUrl` / `peekImageUrl` are host seams.** The one-authorized-read-per-attachment claim in the README is implemented as a `WeakMap`-free per-session closure in `src/client/index.ts:103`; I could not verify the cache behaviour itself, only that the loader is passed to the slot explicitly and a `peek` variant is exposed.
- **The `duration` and `stringWrapping` stores' persistence layer** (`createSnapshotStore`'s `persist` option) lives in `@deepseek-ai/dsh-client-store`, outside the shard. I verified the observable contract through the two store specs and the localStorage assertions in `tests/views.client.spec.tsx:497`.
- **`structuredPatch` (the `diff` package) is used for the prompt diff** (`TrajectoryTable.tsx:1404`); I read the wrapper's output mapping but not the diff library's hunk semantics.
- **Whether the `hidden` "actual time" switch in the toolbar** (`TrajectoryToolbar.tsx:74`) is a deliberately parked feature or a leftover is not stated anywhere in the shard. It is fully wired (`onActualTimeChange` changes `timelineMode` in `TrajectoryView.tsx:348`) but permanently invisible; the README does not mention it. I report it as hidden-and-wired, not as dead code.
