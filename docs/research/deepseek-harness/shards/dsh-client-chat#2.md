# deepseek-harness / dsh-client-chat#2

## Shard shape

This shard is the entire **browser-side conversation and tool-presentation layer** of `deepseek-harness`, and it is two packages, not one. `packages/client/ui-conversation` is the *target-neutral* Conversation engine and shell. It consumes the Session Controller's `SessionEventLikeEntry` window and incrementally assembles it into per-target view snapshots through a registry of business "Definitions" (`match`/`start`/`update`), a Location index that resolves every event to a Turn/Step coordinate, an optional grouping layer, and a per-Session image-URL cache. On top of that engine it owns the shared composer: a Lexical-based draft editor with atomic reference/command chips, a pure submit-plane state machine, the command-mention pipeline, the queue dock, the todo dock, the context meter, the settings row and the whole slot/UI contract. `packages/client/ui-tool` is the downstream *consumer*: it renders every tool call in the transcript, dispatching each atomic call through one keyed slot (`tool.call.toolview`) and owning the pure card models (terminal, diff, read, search, web, image, details) that turn raw tool call/result JSON into cards. The two fit together through one seam — `ui-conversation` dispatches an ordered `tool-call` Conversation Node, `ui-tool` renders it and dispatches each atomic call to a keyed view, with a generic fallback that the framework owns.

**This shard contains no model-loop, tool-execution, context-compaction, memory, or subagent code at all.** Both packages' READMEs say so explicitly (`packages/client/ui-conversation/README.md:170-176` — "Model Experience: None… KV Cache effect: None"), and the code bears that out: the client only *renders* what the Host already decided and holds no provider-side prompt state. The one place the client touches model-visible state is the *inspection* surface — `inspectRequestPrompt` and `inspectSystemPrompt` reconstruct what the model actually saw from the durable `request/header` and `system/message` events, and the compaction node carries the summary the Host wrote. 71 of the 230 files are tests, so the shard is also this repo's densest body of client-side acceptance coverage.

---

## Per-file notes

### packages/client/ui-conversation/locale/en.json
One-key locale manifest: `meta.title: "ui-conversation"`. The real dictionary lives in `src/client/locales.ts`; this file only names the package in the plugin catalogue.

### packages/client/ui-conversation/locale/zh.json
Chinese manifest: `meta.title` is "会话界面框架" and it adds a `description` the English manifest lacks.

### packages/client/ui-conversation/package.json
v0.2.1-rc.2. `dsh.client.inject` names eight browser services (session-controller, file-upload, locale, ui-layout, ui-renderer, ui-session, ui-settings, ui-workspace), `platform: "web"`. Lexical 0.49 + React 18 are dev/peer deps; the export map exposes `.`, `./client` and raw `./src/*`.

### packages/client/ui-conversation/README.i18n.yaml
Per-heading bilingual hash record for `README.md`; the regeneration command is `pnpm run verify-translation-pairing --write packages/client/ui-conversation/README.md` (line 4).

### packages/client/ui-conversation/README.md
The package's normative contract: assembly rules, sent-user-text semantics, shell/standard props, temporary composer entries, and the explicit "Model Experience: None / KV Cache effect: None" section (lines 170-176). Read in full.

### packages/client/ui-conversation/README.zh.md
The Chinese counterpart of the same reference, kept in step by the hash file. I read its first 60 lines (overview, assembly, sent-user-text); the remaining sections are the translation of the English file I read in full.

### packages/client/ui-conversation/src/client/apply.ts
- Purpose: the plugin entry — registers the assembly service, the user-text factory, the Enter-behaviour Settings row, five fixed keyboard commands, the File action, the input hub and every shell slot.
- Key abstractions: `slots.inject` / `ctx.slots.register` with `children` slot declarations; `ctx.inject(['shortcuts'], …)` for the fixed-command table; the `ConversationController` service plugin.
- Data flow: `apply(ctx)` → assembly service (`UiConversation`), `ConversationController` (scope-addressed send/cancel/queue/history), the `todoDockEntry` and `queueDockEntry` plugins, and the slot tree (`main` → `main.conversation` → `conversation.session` / `conversation.header` / `conversation.composer.bar`).
- Non-obvious design decisions: the fixed keyboard table is **five** entries, not three — `fixed.send`, `fixed.newline`, `fixed.complementary` (Ctrl **or** Meta Enter), `fixed.slash`, `fixed.mention` (`packages/client/ui-conversation/src/client/apply.ts:265-278`); the complementary binding is registered twice so both `control` and `meta` work. Workspace navigation **transfers the draft and its attachment ids** from the old session shell to the new one (`packages/client/ui-conversation/src/client/apply.ts:358-378`) — the draft text moves only after the attachments were accepted by the target shell, and the source shell's draft is cleared last so a failed transfer leaves the original intact.
- Edge cases / failure handling: a workspace switch to a session with no binding throws `ui-conversation: session "…" resolved no binding` (`packages/client/ui-conversation/src/client/apply.ts:366`); the stop operation swallows its rejection because the failure is published through the Session's `promptError` (`packages/client/ui-conversation/src/client/apply.ts:259-261`).
- Surprising: the composer's five fixed commands are registered as *shortcut-service* entries, so they are rebindable/inspectable by the product, not hard-coded DOM listeners.

### packages/client/ui-conversation/src/client/context-occupancy.ts
- Purpose: derive the bounded context-occupancy triple (percent, usedTokens, contextWindow) the composer meter renders.
- Key abstractions: `ContextOccupancy`; `contextOccupancy(pressure)`.
- Data flow: reads the token-meter's `ContextPressureProjection`; prefers `projectedTokens` over `pressureTokens`.
- Non-obvious design decisions: the function returns **null** until *both* a numerator and a capacity exist (`packages/client/ui-conversation/src/client/context-occupancy.ts:19`). The stated reason is that the meter's whole contract is "render nothing until a provider reports both pressure and a route capacity" — a half-known occupancy would show a percentage against a guessed window.
- Edge cases / failure handling: a missing `contextWindow` yields `null`, not a partial row; `percent` is clamped to 100 (`packages/client/ui-conversation/src/client/context-occupancy.ts:21`), so an over-budget projection reads as "full" rather than as an impossible number.
- Surprising: `projectedTokens` wins over `pressureTokens` — the projection is the post-compaction estimate, so the meter shows the number the model will actually see.

### packages/client/ui-conversation/src/client/contract/composer-blocks.ts
- Purpose: the type contract for the per-session composer block — the one way another plugin makes a session's input inert.
- Key abstractions: `ComposerBlock { reason }`; `ComposerBlocks { set, storeFor, forget }`.
- Data flow: a plugin calls `ctx.conversation.blocks.set(sessionId, block)`; the composer bar reads `composerBlocks.storeFor(sessionId)`.
- Non-obvious design decisions: a block carries **only a localized reason**, because the plugin that raised it owns that copy (`packages/client/ui-conversation/src/client/contract/composer-blocks.ts:6-8`); the composer cannot import the plugins that would know, so the dependency runs one way only (`ui-model-selection → ui-conversation`, never back).
- Edge cases / failure handling: `forget(sessionId)` drops the store when the session is released, so a stale block cannot outlive its session.
- Surprising: the block is an *affordance, not enforcement* — the Host refuses an unroutable prompt regardless of what any client disables (stated in `input/blocks.ts:11-12`).

### packages/client/ui-conversation/src/client/contract/composer-submission.ts
- Purpose: the submission vocabulary shared by the input machine and the Settings domain.
- Key abstractions: `InputSubmitMode` (= `BusyEnterBehavior`), `ComposerSubmitGesture` (`'enter' | 'accelerated'`), `MessageSubmission`, `MessageSubmissionState`.
- Data flow: `MessageSubmission` is minted at submit time and carries a frozen snapshot of session id, model provider/name/effort, run mode and running flag.
- Non-obvious design decisions: the snapshot is taken **before asynchronous command arbitration** (`packages/client/ui-conversation/src/client/contract/composer-submission.ts:13-19`). The stated reason is that arbitration is async, so reading the model or run-mode *after* it would report the state the user did not submit against.
- Edge cases / failure handling: the state fields are all optional, so a submission made with no session/model still type-checks; `submission-analytics.ts` ignores a submission with no state.
- Surprising: `runMode` carries `'default' | 'plan' | 'goal'` — the composer's submission is aware of the goal/plan run modes, not just chat.

### packages/client/ui-conversation/src/client/contract/context-producer.ts
- Purpose: the vocabulary for non-user messages injected into the transcript by producers.
- Key abstractions: `ContextRole = 'inject' | 'recall'`; `ContextProducerView`; `KnownContextForm`.
- Data flow: the durable source carries a producer name; the target projection maps it onto a role and a label.
- Non-obvious design decisions: `recall` is separated from `inject` because recall is material **lifted out of another session's log** while inject is everything else (`packages/client/ui-conversation/src/client/contract/context-producer.ts:5-11`). Mid-turn steering is a *third* role, but it has its own event and node kind and deliberately never reaches this contract.
- Edge cases / failure handling: unknown or foreign producer forms map to an **opaque** presentation so a log written by an older, newer or foreign producer stays visible rather than disappearing.
- Surprising: `KnownContextForm` is explicitly versioned as "what *this UI version* knows how to present", so adding a form is a UI-version concern, not a data concern.

### packages/client/ui-conversation/src/client/contract/conversation.ts
- Purpose: the frozen type surface of the Conversation engine — the Definition/Builder contract every target implements.
- Key abstractions: `ConversationMatchResult` (`id`, `role`, optional `exclusive`), `ConversationNodeDefinition`, `ConversationViewDefinition`, `ConversationViewBuilder`, `ConversationLocation`, `ConversationLocationDataStore`, `ConversationTurnDataMap`/`ConversationStepDataMap` (declaration-merged business data), `conversationContextKey`.
- Data flow: a target registers a Definition; the assembler calls `match()` per event, `start()` once, `update()` per later match, and `buildViewNode()` to materialise a node into the target's builder.
- Non-obvious design decisions: `conversationContextKey(kind, id)` returns `` `${kind.length}:${kind}${id}` `` (`packages/client/ui-conversation/src/client/contract/conversation.ts:341-343`) — a **length-prefixed** key, so `('ab','c')` and `('a','bc')` cannot collide. The `exclusive` claim (`packages/client/ui-conversation/src/client/contract/conversation.ts:7-21`) is resolved *before* any acceptance, so two claims on one target or a claim from a target-less Definition **throw** during dispatch.
- Edge cases / failure handling: `ConversationLocationDataStore.set` refuses to overwrite another owner's key, so two plugins cannot fight over one business key.
- Surprising: the `LocationDataMap` interfaces are empty and *declaration-merged* by target packages — the engine never enumerates business keys, it only carries them.

### packages/client/ui-conversation/src/client/contract/draft-editor.ts
- Purpose: the editor-facing contract — ranges, reference projections and the composer keyboard interface.
- Key abstractions: `TokenSpan` (`start`, `end`, `draftRev`), `ReferenceInsert`, `DraftReference`/`DraftSnapshot`/`DraftInput`, `DraftCommand`, `ComposerKeyboard`, `Occurrence`.
- Data flow: the editor projects its document into `detectText` (trigger coordinates), `clipboardText` (persistence + submit) and chip occurrences; a `TokenSpan` addresses a range in *detect* coordinates.
- Non-obvious design decisions: `TokenSpan` carries a **revision** (`packages/client/ui-conversation/src/client/contract/draft-editor.ts:7-11`) so a range captured before an edit can be refused. `Occurrence.identity` is `occurrenceId`, a stable per-shell assignment keyed by the chip's `NodeKey`, so same-named references stay independently addressable and survive undo (`packages/client/ui-conversation/src/client/contract/draft-editor.ts:106-112`); `label`/`appearance`/`clipboardText` are *insert-time caches* on the node, and invalidation flips a bit rather than dropping the occurrence.
- Edge cases / failure handling: `DraftCommand` persists only the **token** — the claim's submit closure has no JSON form, so a restored draft rebuilds its claim through the trigger pipeline (`packages/client/ui-conversation/src/client/contract/draft-editor.ts:25-33`).
- Surprising: the reference chip's `clipboardText` is "the clipboard / persistence projection, e.g. `/name` (insert-time cache, **never the model form**)" — the model-facing form is a different serialization entirely.

### packages/client/ui-conversation/src/client/contract/groups.ts
- Purpose: the grouping contract — Definition-owned grouping over a target's already-materialised nodes.
- Key abstractions: `NodeKey`/`GroupKey` (branded), `NodeReference`/`GroupReference`/`RenderEntry`, `GroupSnapshot`, `GroupUpdate` (`replace` vs `apply`), `ConversationGroupDefinition`, `ConversationGroupedView`.
- Data flow: after the target's builder installs nodes, the group's `update()` consumes *node changes* (not raw Session events) and `buildGroups()` materialises root entries plus group snapshots.
- Non-obvious design decisions: two update kinds — `replace` requires a complete root sequence and complete group set, `apply` may omit `entries` to preserve the root list (`packages/client/ui-conversation/src/client/contract/groups.ts:35-50`). Group removal never deletes source nodes. The group input carries `changedTurnOrders` (`packages/client/ui-conversation/src/client/contract/groups.ts:83`) because a turn's *neighbours* can change even when its own keys do not.
- Edge cases / failure handling: `readNode`/`readTurn`/`readPosition` readers are valid **only during the synchronous update call** (`packages/client/ui-conversation/src/client/contract/groups.ts:69-73`) — the contract is explicit that a group must not retain them.
- Surprising: `buildGroups` may return `null` for an apply input to say "nothing changed", which is how the store avoids republishing.

### packages/client/ui-conversation/src/client/contract/input.ts
- Purpose: the frozen input-machine contract — the submit plane's types, with no React, DOM or cordis.
- Key abstractions: `InputState` (phase, claim, draft, occurrences, queue), `InputEvent`/`InputEffect` unions, `CommandClaim`, `PickOutcome`, the scoped verbs (`BeginCommandRequest`, `InsertReferenceRequest`, `ConsumeTokenRequest`, `InsertTextRequest`), `SubmitAttempt`, `InputTriggerController`.
- Data flow: the editor emits events into the machine; the machine returns ordered effects the shell executes (`adjudicate`, `begin-submit`, `default-sink`, `commit-draft`, `notice`).
- Non-obvious design decisions: the contract declares **three tiers of visibility** (`packages/client/ui-conversation/src/client/contract/input.ts:1-8`): business packages see `InputState` through the InputZone currency, scoped input events carry the mutation verbs, and the conversation wiring layer alone sees the full `SessionInput`. The `commit-draft` effect takes a *string* snapshot rather than a boolean (`packages/client/ui-conversation/src/client/contract/input.ts:361-368`): a string snapshot keeps a pure suffix typed during the Host round-trip, while interleaved edits cannot be separated and clear the whole; `null` clears unconditionally (an attachment-only send has no draft to retain).
- Edge cases / failure handling: `SubmitAttempt` carries an `AbortSignal` and a `seq`, which is what makes a *stale* settle droppable (the machine compares `flight.attempt.seq`).
- Surprising: `SubmitAttachment` is a discriminated union of `image` (base64, four allowed media types) and `file` (a `receiptId`) — the two attachments travel by different roads because the file is already uploaded to the Host.

### packages/client/ui-conversation/src/client/contract/records.ts
- Purpose: every finalized transcript node type the client can render.
- Key abstractions: `AssistantBlock` (`text` | `reasoning` | `image` | `tool-call` | `other`), `UserMessageNode`, `AssistantMessageNode`, `AssistantTiming`, `SteeringMessageNode`, `ContextMessageNode`, `ModelRetryNode`, `TurnErrorNode`, `TurnMaxTokensNode`, `ToolResultNode`, `CompactionSummaryNode`, `CommandNode`, `UnknownSurfaceNode`, `ToolArgs`.
- Data flow: the assembler produces these nodes; the target builder materialises them; the Tool layer reads `ToolResultNode`.
- Non-obvious design decisions: the file's header (`packages/client/ui-conversation/src/client/contract/records.ts:1-3`) states the publication rule — "Each publication replaces the top-level snapshot while preserving unchanged substructure references. Stable node and location stores make old snapshots **live readers** rather than time-point views." That is what lets a React tree keep reading an older snapshot without tearing.
- Edge cases / failure handling: `AssistantMessageNode.interrupted` is a *prefix* of an aborted turn, and a chunk-only fallback uses a **fractional seq** derived from the closing boundary so it stays ordered inside the flow (`packages/client/ui-conversation/src/client/contract/records.ts:81-84`). `ToolResultNode.call` is `null` when window truncation left the call outside — the card head then shows the callId instead of a name.
- Surprising: `AssistantBlock` has a first-class `reasoning` kind and `AssistantTiming` distinguishes `stepStartTime`, `firstTokenTime` and `completedTime` — the client measures model latency and throughput, it does not merely display text.

### packages/client/ui-conversation/src/client/contract/request-inspection.ts
- Purpose: the *inspection* surface — reconstruct what the model actually saw for one provider request.
- Key abstractions: `ConversationPromptSnapshot` (config + system + tools), `SystemPromptNode`, `RequestPromptChange` (`initial` | `system` | `tools` | `system-and-tools`), `RequestPromptInspection`, `RequestPromptInspector`, `AssistantRequestView`/`CompactionRequestView`/`RequestView`.
- Data flow: `inspectRequestPrompt(previous, requestHeaderEvent, systemNode)` canonicalises the header against the system node in force and classifies the model-visible change.
- Non-obvious design decisions: the change is **anchored at the event that introduced it**, not at the header (`packages/client/ui-conversation/src/client/contract/request-inspection.ts:50-63`): a `system/message` node that introduced, replaced or updated the prompt is the anchor; otherwise the `request/header` is. The `system` field is the *rendered text of the surface node in force*, and the tools list is the **complete catalogue sent with the request, including tools that were never called** (`packages/client/ui-conversation/src/client/contract/request-inspection.ts:25-26`).
- Edge cases / failure handling: an empty system text records "no system prompt" and an *undefined* system means "unavailable" — the two are distinct, so a card can say "unknown" rather than "empty".
- Surprising: a compaction request is a **first-class request view** (`purpose: 'compaction'`, `step: 0` — "Direct compaction requests do not consume an agent-loop step"), carrying both the safe summary projection and the complete provider output. This is the client's only view of the compaction path.

### packages/client/ui-conversation/src/client/contract/slots.ts
- Purpose: the slot declarations and composed prop types for every surface this package owns.
- Key abstractions: the `SlotMap` declaration-merge for `conversation.*` keys; `ComposerBarOwnerProps`, `ConversationSessionSlotProps`, `InputZone`, `ComposerChainProps`, `MessageImageLoader`, `ConversationStore`.
- Data flow: `conversation.composer` is a **chain** (`packages/client/ui-conversation/src/client/contract/slots.ts:260`) so a plugin can replace the resident composer for one session; `conversation.input.dock` / `conversation.composer.dock` / `conversation.input.left` / `conversation.input.right` are lists; `conversation.composer.bar` is `session-maybe` (`packages/client/ui-conversation/src/client/contract/slots.ts:282`) so the bar stays mounted with no session.
- Non-obvious design decisions: every slot carries an explicit `scope` (`root` | `session` | `session-maybe`), which is the mechanism that lets one registration serve both the blank and the live state without a remount.
- Edge cases / failure handling: `ComposerAttachment` splits browser-owned images (base64, preview URL, asynchronously probed intrinsic size) from browser-owned files (uploaded to the Host **as soon as they are picked**, not at send) — the upload lifecycle is per-draft, not per-send.
- Surprising: the composer bar is `session-maybe` *by design* — the whole "no remount on session change" guarantee is a scope decision, not a React trick.

### packages/client/ui-conversation/src/client/contract/snapshot.ts
- Purpose: the target-neutral Conversation state and the shell phase derived from it.
- Key abstractions: `ConversationSnapshot { views, activeTargets }`; `EMPTY_CONVERSATION_SNAPSHOT`; `ConversationPhase = 'blank' | 'engaging' | 'active'`; `conversationPhase(session, conversation)`.
- Data flow: `conversationPhase` combines the Session lifecycle snapshot with the Conversation snapshot to produce the phase the header, View ring and composer layout read.
- Non-obvious design decisions: the phase is computed from **two** sources — the Conversation's own active targets *and* the Session's lifecycle (`packages/client/ui-conversation/src/client/contract/snapshot.ts:26-33`). The reason, stated in the doc comment, is that "Conversation data" must not be added to the Session snapshot: the Session lifecycle stays the Session's own business.
- Edge cases / failure handling: `promptAttempted` is what distinguishes `'engaging'` (the user has typed but no turn has run) from `'blank'`.
- Surprising: `activeTargets` is a *monotonic* set for the Session's lifetime — subscribing to a target activates it and unsubscribing does not deactivate it.

### packages/client/ui-conversation/src/client/contract/system-prompt.ts
- Purpose: interpret the loaded `system/message` surface into an immutable system-prompt state.
- Key abstractions: `SystemPromptState { firstSeq, uncertain, nodes, replacements, effective, introduced }`; `SystemPromptInspector`; `inspectSystemPrompt(previous, event)`.
- Data flow: successive `system/message` events and positional `surfaceOp` replacements fold into the state; `effective` is the last surviving **non-empty** node in surface order.
- Non-obvious design decisions: the function **withholds** the prompt rather than guessing. If a replacement references an endpoint older than the loaded window and that endpoint is not already in the replacements map, the state becomes `uncertain` with `effective: undefined` (`packages/client/ui-conversation/src/client/contract/system-prompt.ts:43-48`). The stated reason: "Missing endpoint order makes the prompt unavailable until prepend replay supplies it" — a prompt reconstructed from an unknown order is a lie.
- Edge cases / failure handling: replacement positions **inherit their start endpoint, not their chronological seq** (`packages/client/ui-conversation/src/client/contract/system-prompt.ts:50-52`), and shadowed replacement endpoints are dropped without mutating the historical prefix — the earlier cards stay valid.
- Surprising: an in-history system update is marked `update: true` and is presented *where it was committed* rather than by the next request header (`packages/client/ui-conversation/src/client/contract/system-prompt.ts:43-46` in `request-inspection.ts`) — the model read it at that position, so the card must say so.

### packages/client/ui-conversation/src/client/contract/user-text.ts
- Purpose: the contract for the inline projection of sent user text.
- Key abstractions: `UserTextRule { id, order, match(text, from, context) }`, `UserTextNode`, `UserTextDocumentInput`, `UserTextTransformContext` (a Facts reader), `UserTextEvaluator`.
- Data flow: a rule is asked for the *nearest* candidate at or after `from`; the evaluator picks the earliest start, breaking same-start ties by `order` then by a stable ID comparison — never by plugin load order (`packages/client/ui-conversation/src/client/contract/user-text.ts:39-54`).
- Non-obvious design decisions: `context.read(key)` records a **field dependency, including an absent value**, and the reader "is valid only during its owning synchronous query; never retain it" (`packages/client/ui-conversation/src/client/contract/user-text.ts:29-37`). A `text` candidate preserves the exact source substring and may supply a display override; business candidates carry JSON data.
- Edge cases / failure handling: reentrant evaluation throws, and a failure "carries ruleId and cause without publishing partial output" (`packages/client/ui-conversation/src/client/contract/user-text.ts:56-62`).
- Surprising: the *search* uses original lexical boundaries, not the beginning of a sliced suffix — so a rule that would match inside a slice cannot fire there.

### packages/client/ui-conversation/src/client/contract/views.ts
- Purpose: the view-tab contract and the per-session shell state.
- Key abstractions: `ViewTab { id, label }`; `ConversationViewRequest { view, focus }`; `ConversationStoreState { draft, view, viewRequest }`.
- Data flow: the shell store holds the persisted draft, the preferred view id and a one-shot focus request; `openView` sets both, `completeViewRequest` clears the request.
- Non-obvious design decisions: the draft is `DraftInput` (string **or** a structured `DraftSnapshot`) and is "persisted; survives session switches and reloads" (`packages/client/ui-conversation/src/client/contract/views.ts:19-26`).
- Edge cases / failure handling: `viewRequest` is one-shot — it exists to address a specific View, is consumed, and is acknowledged by the View itself.
- Surprising: the preferred view id may be `null`, which resolves to Chat when registered — the shell never invents a fallback beyond the registered `chat` preference.

### packages/client/ui-conversation/src/client/conversation/assembler.ts
- Purpose: the heart of the engine — turns a window of Session events into per-target node snapshots.
- Key abstractions: `ConversationNodeAssembler`; `InternalContext` (per Definition+id: startSeq, start, matches, state, revision, current nodes, location data, dependencies); `Dependency { kind, key, revision, windowGap }`; `PUBLICATION_RANK`.
- Data flow: `append`/`prepend`/`replaceWindow` feed entries; each entry is offered to the matching Definitions; a match updates the context's State; `flush` materialises nodes into the target builder and publishes.
- Non-obvious design decisions: **claims are resolved before any acceptance**, so the outcome does not depend on registration order (`packages/client/ui-conversation/src/client/conversation/assembler.ts:519`); a claim from a Definition without a target throws (`packages/client/ui-conversation/src/client/conversation/assembler.ts:526`) and two claims on one target throw (`packages/client/ui-conversation/src/client/conversation/assembler.ts:530`). The `exclusive` claim suppresses the target's own fallback (`packages/client/ui-conversation/src/client/conversation/assembler.ts:551-559`). A Context that receives an update before its start throws, and a non-appended match throws (`packages/client/ui-conversation/src/client/conversation/assembler.ts:598-603`).
- Edge cases / failure handling: `requireState` throws when a Definition's `start`/`update` returns `undefined` (`packages/client/ui-conversation/src/client/conversation/assembler.ts:1093-1101`) — a Definition that forgets to return its state fails loudly rather than publishing an empty node. `PUBLICATION_RANK` lets a Definition choose `none` / `animation-frame` / `immediate` (`packages/client/ui-conversation/src/client/conversation/assembler.ts:66-70`), and the assembler takes the **maximum** over all matching Definitions, so one demanding Definition wins.
- Surprising: the assembler keeps a **dependency map** per context (`readerFor`, `packages/client/ui-conversation/src/client/conversation/assembler.ts:782-794`) recording the predecessor kind, key, revision and a `windowGap` flag; `replayDependencies` (`packages/client/ui-conversation/src/client/conversation/assembler.ts:853`) then re-derives affected contexts when older history arrives, so a prepend repairs earlier cards instead of orphaning them.

### packages/client/ui-conversation/src/client/conversation/assembly.ts
- Purpose: the per-Session service that binds an event source to the assembler and publishes the observable faces.
- Key abstractions: `ConversationBinding { snapshot, openTurn, activate, target }`; `BoundConversation`; `UiConversation`; `WeakMapWithValues` for the binding table.
- Data flow: `UiConversation.binding(bindingOrSessionId)` returns one identity-stable binding per Session Controller binding; it **does not open another event source** (the README states this explicitly). The binding subscribes to the feed and calls `accept()` on every snapshot.
- Non-obvious design decisions: `openTurn` is a separate identity-stable source that publishes **synchronously** even when no View is active (`packages/client/ui-conversation/src/client/conversation/assembly.ts:36-38`) — the fixed stop input needs the turn number without subscribing to a transcript. The first subscriber to a target **activates** it and the assembler then does a one-time replace for it (`packages/client/ui-conversation/src/client/conversation/assembly.ts:49-51`).
- Edge cases / failure handling: `drop(record, releaseScope)` only drops when the table still holds *that* record, so a replacement binding is not dropped by a stale disposer (`packages/client/ui-conversation/src/client/conversation/assembly.ts:328-333`).
- Surprising: the assembly service exposes `inspectRequestPrompt` as a **value seam** (`packages/client/ui-conversation/src/client/conversation/assembly.ts:320-326`) because "a client bundle cannot value-import another plugin's module" — the inspection function is passed in rather than imported.

### packages/client/ui-conversation/src/client/conversation/definition-registry.ts
- Purpose: the shared lifecycle and stable-entry storage for every Conversation registry.
- Key abstractions: `ConversationDefinitionRegistry<Definition>`; `entries()`; `subscribe()`; `registerDefinition()`.
- Data flow: `registerDefinition` wraps the registration in a Cordis **effect** owned by the caller's context, so a plugin's definition disappears with its fiber.
- Non-obvious design decisions: `entries()` returns a **cached** array that is replaced (not mutated) on refresh, so a consumer can hold it as a stable snapshot (`packages/client/ui-conversation/src/client/conversation/definition-registry.ts:21-23`). Duplicate keys throw at registration (`packages/client/ui-conversation/src/client/conversation/definition-registry.ts:49`).
- Edge cases / failure handling: the disposer is idempotent and checks identity (`if (this.definitions.get(key) !== definition) return`) so a stale disposer cannot remove a replacement contribution.
- Surprising: `notifySubscribers(this.listeners, '[ui-conversation] definition registry')` passes a diagnostic label to the store's notify — the harness's store takes a source label, and every registry supplies one.

### packages/client/ui-conversation/src/client/conversation/event-registry.ts
- Purpose: the runtime registry of business Definitions and the unmatched-event fallback.
- Key abstractions: `ConversationEventRegistry`; `ConversationEventRoute`; the `match` function-or-table input form.
- Data flow: `forEvent(type)` returns a precomputed ordered set of candidate routes; the assembler offers each event to them in registration order.
- Non-obvious design decisions: `refresh()` **precomputes** the per-type route sets (`packages/client/ui-conversation/src/client/conversation/event-registry.ts:85-108`) so dispatch is a map lookup, not a scan. A table-form Definition is resolved to a function at registration (`packages/client/ui-conversation/src/client/conversation/event-registry.ts:74-83`), so the assembler only ever sees callables. The fallback must declare a target, and only one fallback may exist (`packages/client/ui-conversation/src/client/conversation/event-registry.ts:39-55`).
- Edge cases / failure handling: `assertDefinitionTarget` throws when `target` and `buildViewNode` are not declared together (`packages/client/ui-conversation/src/client/conversation/event-registry.ts:111-117`) — a Definition that can match but cannot build a node is a configuration error, caught at load.
- Surprising: the table form means "read table handlers at registration" — a table whose values are getters is evaluated once, at registration, so a mutable table does not change dispatch mid-session. The routing spec asserts this explicitly.

### packages/client/ui-conversation/src/client/conversation/group-registry.ts
- Purpose: the target-indexed registry of grouping Definitions.
- Key abstractions: `ConversationGroupRegistry`; `register()`; `forTarget(target)`.
- Data flow: one Group Definition per target; it is consulted after the target's builder has installed nodes.
- Non-obvious design decisions: registering a group for a target that is **not registered** throws at registration time (`packages/client/ui-conversation/src/client/conversation/group-registry.ts:29-31`) — "registration never instantiates its Builder", so the error is the only place it can be caught.
- Edge cases / failure handling: when a registered View Definition is removed, its grouping computation pauses and clears its published results but **keeps** the Group Definition, so re-registering the View rebuilds from the current loaded timeline.
- Surprising: the registry keys groups by *target*, not by kind — a target has at most one grouping rule, which is what makes the group store's root-list validation possible.

### packages/client/ui-conversation/src/client/conversation/group-store.ts
- Purpose: keyed group publication with incremental validation of rendering positions.
- Key abstractions: `ConversationGroupStore<Data>`; `GroupSource`; `GroupChanges`; `reuseReferences`.
- Data flow: `prepareAndInstall(update, readNode)` validates the whole batch, then `publish()` notifies only the changed group sources.
- Non-obvious design decisions: the batch is **validated before anything is installed** (`packages/client/ui-conversation/src/client/conversation/group-store.ts:76-103`). A mismatch between the number of groups and the number of root-group references throws; a group whose members name a node that does not exist throws; a duplicate removal, a removal of an absent group, and an upsert-and-remove of the same key all throw — and in every case the store is left **untouched** (the spec asserts the root array and the source snapshot are identical after the throw).
- Edge cases / failure handling: `reuseReferences` (`packages/client/ui-conversation/src/client/conversation/group-store.ts:30-39`) returns the *previous* array when the new one is element-wise equivalent, so an unchanged root list keeps its identity and does not republish.
- Surprising: `groupSource(key)` is **identity-stable** — subscribing twice to the same group yields the same object, and the value is absent after removal rather than throwing.

### packages/client/ui-conversation/src/client/conversation/historical-images.ts
- Purpose: the Session-scoped durable image URL cache shared by every Conversation target.
- Key abstractions: `HistoricalImageCache`; `ImageUrlEntry { binding, current, pending }`; `resolve` / `peek` / `seed`.
- Data flow: `resolve(sessionId, attachment)` → session-authorized `readAttachment` → a browser object URL cached per attachment id, scoped to the Session binding.
- Non-obvious design decisions: `seed()` lets a submission **preview** be shown synchronously before the canonical bytes arrive, and the canonical read then replaces *and revokes* the preview (`packages/client/ui-conversation/src/client/conversation/historical-images.ts:75-100`). The stated reason is responsiveness: the user sees the image they just attached without waiting for the Host round-trip.
- Edge cases / failure handling: a pending load whose Session binding is released **rejects** with "scope was released before loading completed" rather than resolving with a dead URL. An unknown session is refused. Only `blob:` URLs are revoked (`packages/client/ui-conversation/src/client/conversation/historical-images.ts:179-181`), so a server URL is never revoked.
- Surprising: `peek()` returns the *current* URL synchronously with no read started — the render path can draw a cached image without touching the network at all.

### packages/client/ui-conversation/src/client/conversation/location-index.ts
- Purpose: index every event to a Turn/Step Location and own the timeline.
- Key abstractions: `ConversationLocationIndex`; `ConversationLocationDataStore`/`MutableLocationDataStore`; `TurnLocation`/`StepLocation`; `SESSION_LOCATION`/`UNRESOLVED_LOCATION`.
- Data flow: boundary events (`turn/start|end`, `step/start|end`) build the timeline; every event's seq maps to a Location; `resolve(seq)` (`packages/client/ui-conversation/src/client/conversation/location-index.ts:637-645`) answers `{kind:'turn'|'step'}`.
- Non-obvious design decisions: Step lookup is **indexed by number** so a non-boundary append does not scan a turn's step array. The timeline object is **reused** when the turn map and order are unchanged (`packages/client/ui-conversation/src/client/conversation/location-index.ts:410-412`), so a consumer holding the old timeline still sees a live value. `MutableLocationDataStore.set` throws when a key is already owned by another owner (`packages/client/ui-conversation/src/client/conversation/location-index.ts:78-87`) — two plugins cannot fight over one business key.
- Edge cases / failure handling: `resolve` returns `SESSION_LOCATION` when the seq has no turn coordinates and `UNRESOLVED_LOCATION` when the turn is unknown — two distinct "we do not know" answers, so a card can say "not in a turn" versus "not yet known".
- Surprising: `appendBoundary` throws when handed a non-boundary event (`packages/client/ui-conversation/src/client/conversation/location-index.ts:444-448`) — the boundary door is typed, and a mis-wired feed fails immediately.

### packages/client/ui-conversation/src/client/conversation/user-text-document.ts
- Purpose: the data layer of the user-text projection — candidate reconciliation, query coverage, tracked Facts and JSON identity reuse.
- Key abstractions: `UserTextDocument`; `Matcher { definition, reads, queries }`; `Query { from, node, error }`; `Traversal`.
- Data flow: `evaluate(input, rules)` prepares (which matchers are stale), reconciles (each rule offers candidates from a moving cursor), and aligns the result with the previous output so equivalent results keep their identities.
- Non-obvious design decisions: a matcher is rebuilt when its **definition object** changes *or* when any Facts field it actually read changed (`packages/client/ui-conversation/src/client/conversation/user-text-document.ts:79`) — so a rule that never reads a Fact is never invalidated by it. A failed query "retries when their offset, definition, original text, or read Facts change" (`packages/client/ui-conversation/src/client/conversation/user-text-document.ts:58-59`), and a failure publishes **no partial output**.
- Edge cases / failure handling: reentrancy throws (`packages/client/ui-conversation/src/client/conversation/user-text-document.ts:52`); `equalJson` (`packages/client/ui-conversation/src/client/conversation/user-text-document.ts:236-244`) compares nested payloads key-wise so two equal-but-differently-ordered payloads reuse the same node identity.
- Surprising: the *initial* document is one `text` node covering the whole string, so the "no rule matched" answer is a single node — the projection always covers the text completely.

### packages/client/ui-conversation/src/client/conversation/user-text-registry.ts
- Purpose: the effect-owned registry of user-text rules and their revision.
- Key abstractions: `UserTextRegistry`; `register(rule)`; `createEvaluator()`; `getSnapshot()` (a monotonic revision).
- Data flow: a business package registers a rule; the shell subscribes to the revision and rebuilds its evaluator; `createEvaluator()` returns a callback owning **its own** document cache.
- Non-obvious design decisions: the registry keeps **no documents and no document subscriptions** (`packages/client/ui-conversation/src/client/conversation/user-text-registry.ts:6`): each evaluator caller owns its cache, so a rule change cannot invalidate a document the registry does not own. Rules are sorted by ascending `order` and then by a stable ID comparison (`packages/client/ui-conversation/src/client/conversation/user-text-registry.ts:46-47`) — never by plugin load order.
- Edge cases / failure handling: an empty ID, the reserved `text` ID, a non-finite `order` and a duplicate ID all throw **before publication**, so the revision does not move.
- Surprising: `refresh()` increments the revision on *every* registration and disposal, including a no-op dispose — the revision is a change counter, not a version of the rule set.

### packages/client/ui-conversation/src/client/conversation/view-registry.ts
- Purpose: the runtime registry of per-target snapshot builders.
- Key abstractions: `ConversationViewRegistry`; `register(definition)`; `entries()`.
- Data flow: a target registers a View Definition; the assembler instantiates its builder lazily when the target is first activated.
- Non-obvious design decisions: the registry is keyed by `definition.target` (`packages/client/ui-conversation/src/client/conversation/view-registry.ts:16`), so two views for one target collide at load with a loud message rather than racing at render.
- Edge cases / failure handling: the disposer is idempotent and identity-checked, as in the shared base class.
- Surprising: this file is 20 lines and exists only because the base class's `registerDefinition` needs a target-keyed message — a deliberate one-line file rather than a generic base.

### packages/client/ui-conversation/src/client/draft.ts
- Purpose: the semantic draft snapshot shared by storage, programmatic input and editor restoration.
- Key abstractions: `resolveDraftInput`; `parseStoredDraft`; `snapshotDraft`; a zod `snapshotSchema`.
- Data flow: the editor's `text` + `Occurrence[]` become a `DraftSnapshot` (editor-independent); the snapshot is JSON-parsed on restore and validated by zod.
- Non-obvious design decisions: the zod `refine` (`packages/client/ui-conversation/src/client/draft.ts:24-34`) enforces that a draft's command token is a `/name` spelling that the text starts with, and that every reference is an **ordered, non-overlapping** span whose `length` equals `clipboardText.length` and whose text matches the source exactly. The reason stated in the refine message: "Draft references must identify ordered, non-overlapping text spans after the leading command token" — a reference that does not match the source would be a chip pointing at the wrong characters.
- Edge cases / failure handling: `parseStoredDraft` accepts the **earlier plain-string representation** (`packages/client/ui-conversation/src/client/draft.ts:55-58`) so an old persisted draft still restores, and returns `undefined` for anything invalid rather than throwing.
- Surprising: `snapshotDraft` deliberately drops the editor-local `occurrenceId` — the persisted form is semantic, so the same draft restored in a different shell keeps its meaning but not its runtime identity.

### packages/client/ui-conversation/src/client/image-labels.ts
- Purpose: the attachment rejection and limit copy owned by the conversation input flow.
- Key abstractions: `imageSizeText(bytes)`; `attachmentErrorText(t, reason, limits?)`.
- Data flow: the Host's `session/attachment-invalid` / `subagent/attachment-invalid` `details.reason` code is mapped to localized copy; `ImageAttachmentLimits` are interpolated when the Host projects them.
- Non-obvious design decisions: the split is **user-solvable vs not**: reasons the user can act on name the limit and the way out, while reasons the user *cannot* act on "fold into one send-failed line carrying the reason code for a bug report" (`packages/client/ui-conversation/src/client/image-labels.ts:19-22`). `FILE_NOT_STAGED` is treated as solvable ("solvable by re-adding the file", `packages/client/ui-conversation/src/client/image-labels.ts:35-37`).
- Edge cases / failure handling: a limit reason *without* projected limits falls through to the generic send-failed line rather than inventing a number.
- Surprising: `imageSizeText` renders `10MB` for an exact 10 MiB and `2.5MB` otherwise — the fraction is only shown when it exists.

### packages/client/ui-conversation/src/client/index.ts
- Purpose: the package's public surface.
- Key abstractions: the re-exported types; the `UserTextDataMap`/`UserTextFacts` declaration-merge seams; the `cordis` `Context` merge adding `conversation` and `uiConversation`.
- Data flow: consumers import from `@deepseek-ai/dsh-client-ui-conversation/client`.
- Non-obvious design decisions: the `UserTextFacts` interface is declared **here** with only two boolean flags, and other packages extend it by declaration merge — the flags are "absent means disabled" so a caller that supplies no facts gets plain text.
- Edge cases / failure handling: `UserTextDataMap` has a reserved `text` member (the document-owned id), so a business rule cannot claim it.
- Surprising: `UserTextDataMap.text.data.display` is optional and an **empty string hides** the segment, while absence renders the original substring.

### packages/client/ui-conversation/src/client/input/blocks.ts
- Purpose: the per-session composer-block registry — the one way another plugin stops a session's input.
- Key abstractions: `ComposerBlockRegistry implements ComposerBlocks`.
- Data flow: `set(sessionId, block)` writes into a per-session `SnapshotStore`; the composer bar reads it.
- Non-obvious design decisions: the header (`packages/client/ui-conversation/src/client/input/blocks.ts:1-13`) states the whole reason this exists: "the composer cannot read the plugins that would know — the dependency runs ui-model-selection → ui-conversation, never back — so a blocker pushes here and the bar reads its own session's store". The block carries the localized reason because the raiser owns that copy.
- Edge cases / failure handling: `set` compares the reason and **does not republish** when the copy is unchanged (`packages/client/ui-conversation/src/client/input/blocks.ts:27`) — a model-selection plugin that re-raises the same reason every tick would otherwise churn the store.
- Surprising: the file is explicit that this is "an affordance, not enforcement: the Host refuses a prompt it cannot route regardless of what any client disables."

### packages/client/ui-conversation/src/client/input/decorations.ts
- Purpose: the plain-text reference scan — how `/name` and `@name` tokens are found in a draft.
- Key abstractions: `TextRefRange`; `scanTextRefs(draft, lexicon)`.
- Data flow: the scan is a pure derivation over the draft text and the hot per-trigger lexicon; the editor's text-ref entity transform consumes the ranges.
- Non-obvious design decisions: three word-boundary rules, each with a stated reason. The trigger must sit at the draft start or after whitespace, so `'x/name'` never matches (`packages/client/ui-conversation/src/client/input/decorations.ts:36-38`). The name must be an **exact lexicon member**. And a `/name` token must end at whitespace or the draft end — "the boundary the host skill gesture (`dsh-tool-skill`) requires, so `/nfs-hg/xxx`, `/plan.md`, and `/plan。` are prose, never a reference" (`packages/client/ui-conversation/src/client/input/decorations.ts:26-31`).
- Edge cases / failure handling: a missing catalogue matches no named tokens; a folder token that overlaps an already-matched range is not added twice (`packages/client/ui-conversation/src/client/input/decorations.ts:65-67`).
- Surprising: the whole mechanism is **editable**: editing the text out of match shape simply drops the range on the next scan, so a reference is a live derivation, not a stored object.

### packages/client/ui-conversation/src/client/input/editor/chip-node.tsx
- Purpose: the reference chip as one atomic Lexical decorator node.
- Key abstractions: `ReferenceChipNode extends DecoratorNode`; `SerializedReferenceChipNode`; `$createReferenceChipNode`; `$isReferenceChipNode`.
- Data flow: the node carries the owner's insert-time projections; `getTextContent()` answers the clipboard/persistence projection so native copy and the draft mirror stay correct without expansion code (`packages/client/ui-conversation/src/client/input/editor/chip-node.tsx:1-9`).
- Non-obvious design decisions: `isKeyboardSelectable()` returns **false** (`packages/client/ui-conversation/src/client/input/editor/chip-node.tsx:143-145`) — the stated reason is that a NodeSelection between the keystroke and the caret is "a state the plain-text binding's handlers all ignore, deadlocking arrows, typing, and deletion at the chip edge". Arrows step across the chip in one move and Backspace/Delete remove it whole.
- Edge cases / failure handling: `setInvalid` flips the owner-resolution failure bit; the chip renders the failure treatment and "serialization must fail".
- Surprising: `createDOM` writes `contenteditable="false"` on the host span, so the browser's own editing cannot enter the chip.

### packages/client/ui-conversation/src/client/input/editor/command-chip-node.tsx
- Purpose: the claimed slash command as one atomic Lexical decorator on the document's leading seat.
- Key abstractions: `CommandChipNode`; `$createCommandChipNode`; `registerCommandChipSeat(editor)`.
- Data flow: the node carries the `CommandClaim` it was inserted for, so a history restore of the node restores the claim with it (`packages/client/ui-conversation/src/client/input/editor/command-chip-node.tsx:1-8`).
- Non-obvious design decisions: `importJSON` returns a **plain text node** holding the token (`packages/client/ui-conversation/src/client/input/editor/command-chip-node.tsx:46-48`), because JSON cannot carry the claim's submit closure. The seat transform (`packages/client/ui-conversation/src/client/input/editor/command-chip-node.tsx:147-157`) releases the claim whenever the chip stops being the first child of the first block: a chip anywhere else "becomes its literal token, which releases the claim".
- Edge cases / failure handling: the transform fires on a sibling inserted before the chip *or* on a block inserted before the chip's block — each marks only the affected block dirty.
- Surprising: `getTextContent()` answers the token **without** its argument separator, and the separator is an ordinary text node after the chip.

### packages/client/ui-conversation/src/client/input/editor/command-chip-selection.ts
- Purpose: two-step deletion of the command chip — the first deletion selects it, the second removes it.
- Key abstractions: `registerCommandChipSelection(editor)`; `PASSIVE_KEYS`; `$commandChipBesieCaret`; `$decide`.
- Data flow: deletions arrive either as the character-deletion command (Backspace, Delete, platform shortcuts) or as a deletion **input event** (which some platforms apply without the command) — both doors are handled (`packages/client/ui-conversation/src/client/input/editor/command-chip-selection.ts:4-8`).
- Non-obvious design decisions: the selected state is **presentation on the chip's host and the root element**; the editor selection stays a collapsed range beside the chip, "so typing and arrows keep their plain-text behavior" (`packages/client/ui-conversation/src/client/input/editor/command-chip-selection.ts:9-12`). A keydown that produced no character deletion clears the selection via a microtask (`packages/client/ui-conversation/src/client/input/editor/command-chip-selection.ts:87-98`), because key bindings dispatch their deletion synchronously inside the keydown.
- Edge cases / failure handling: a click, blur, a passive key, a key that produces no deletion, or a caret that no longer touches the chip all clear the selection.
- Surprising: an update listener re-paints the mark when a restore remounts the chip's host element, so the selection survives an undo (`packages/client/ui-conversation/src/client/input/editor/command-chip-selection.ts:101-107`).

### packages/client/ui-conversation/src/client/input/editor/CommandChip.tsx
- Purpose: the visual body of the claimed command chip.
- Key abstractions: `CommandChipProps { token }`.
- Data flow: `CommandChipNode.decorate()` renders it.
- Non-obvious design decisions: it reuses the **reference chip's** treatment (`referenceCss.reference` plus `css.chip`) — the display is shared, the lifecycle is not.
- Edge cases / failure handling: none; the component is pure display, as its header states.
- Surprising: the token is rendered *without* the argument separator, so the chip and the argument text are visually separate.

### packages/client/ui-conversation/src/client/input/editor/composer-editor.module.css
Shared inline-reference treatment: `.reference` (business-blue, `box-decoration-break: clone` so a wrapped chip keeps its pill), `.openable` (pointer cursor) and `.textRef`. Line 22-24 adds the rule that a command chip selected by its first deletion keystroke keeps the hover tint until the next deletion removes it — the selection is a *CSS* state, not a class swap in React.

### packages/client/ui-conversation/src/client/input/editor/ComposerContentEditable.tsx
- Purpose: the composer's contenteditable host, binding one shell-owned Lexical editor to a resident div.
- Key abstractions: `ComposerContentEditableProps`; `useLayoutEffect` root binding.
- Data flow: `editor.setRootElement(el)` on mount, `editor.setEditable(editable)` on change, `setRootElement(null)` on unmount.
- Non-obvious design decisions: the component is **session-maybe by design** — a null editor renders the *same* div inert, "so switching between the two never swaps the element tree" (`packages/client/ui-conversation/src/client/input/editor/ComposerContentEditable.tsx:1-7`). Editability has **one writer**: this component reflects the `editable` prop; nothing else calls `setEditable`.
- Edge cases / failure handling: `contentEditable` is bound by React (`contentEditable={editor !== null && editable}`) because "Lexical's setRootElement never touches contenteditable".
- Surprising: `role="textbox"` and `aria-multiline` are set explicitly so the div announces like the textarea it replaced.

### packages/client/ui-conversation/src/client/input/editor/DecoratorPortals.tsx
- Purpose: the decorator render loop — portal every decorator node's React face into its host element.
- Key abstractions: `DecoratorPortalsProps`; `DecoratorPortals`.
- Data flow: `editor.registerDecoratorListener` pushes a new decorator map into React state; each entry is `createPortal(jsx, el, key)`-ed into the element the editor owns.
- Non-obvious design decisions: this is a *reimplementation* of what `@lexical/react` does internally, scoped to this composer's needs (`packages/client/ui-conversation/src/client/input/editor/DecoratorPortals.tsx:1-6`). The portal key is the `NodeKey`, so "chip DOM identity rides the NodeKey — text edits around a chip never remount its portal".
- Edge cases / failure handling: a null editor renders nothing; a decorator whose host element is gone is skipped (`el === null ? null : …`).
- Surprising: the whole React tree for a chip is portal-ed out of the editor's DOM subtree, so React reconciliation for the chip is independent of the editor's own reconciliation.

### packages/client/ui-conversation/src/client/input/editor/DraftEditor.tsx
- Purpose: the stateless text-area presentation over the InputBar's borrowed editor.
- Key abstractions: `DraftEditorProps`; `DraftEditor`.
- Data flow: renders the scrollport, the `ComposerContentEditable`, the placeholder and the `DecoratorPortals`.
- Non-obvious design decisions: the component owns **no hooks** (`packages/client/ui-conversation/src/client/input/editor/DraftEditor.tsx:28`) — it is a pure function of props, and the InputBar holds the state. The placeholder was the textarea's accessible name; "a div's data attribute is not, so the label restores it" (`packages/client/ui-conversation/src/client/input/editor/DraftEditor.tsx:45-47`).
- Edge cases / failure handling: `editorDisabled` renders a dimmed, non-editable surface; the workspace-picker trigger state renders the same div with `editor={null}`.
- Surprising: the `data-placeholder` attribute carries the placeholder text for the CSS layer, while `aria-label` carries it for assistive technology — two channels for one string.

### packages/client/ui-conversation/src/client/input/editor/keymap.ts
- Purpose: the composer keymap over the Lexical command layer.
- Key abstractions: `ComposerKeymapHandlers`; `registerComposerKeymap(editor, handlers)`; `isComposingEvent`.
- Data flow: `KEY_ENTER_COMMAND`, `KEY_ESCAPE_COMMAND`, `KEY_SPACE_COMMAND`, `KEY_TAB_COMMAND`, `KEY_ARROW_*`, `PASTE_COMMAND` are intercepted at `COMMAND_PRIORITY_CRITICAL`; a handler returning `false` falls through to `@lexical/plain-text`'s defaults.
- Non-obvious design decisions: the IME guard (`packages/client/ui-conversation/src/client/input/editor/keymap.ts:9-16`) covers three cases: `KeyboardEvent.isComposing` covers most engines; **Safari delivers the closing keydown AFTER `compositionend`**, so a root-element composition watch holds the guard for 10 ms more; `keyCode === 229` is the legacy signal engines emit without `isComposing`. A composition-closing Enter/Space must not submit or adjudicate.
- Edge cases / failure handling: paste reads `clipboardData.items` for files and `webkitGetAsEntry().isDirectory` for directory metadata (`packages/client/ui-conversation/src/client/input/editor/keymap.ts:164-186`); a paste with only files and no text is consumed without inserting text.
- Surprising: the root's `data-composer-composing` attribute suppresses the placeholder until both the native composition *and* the editor's final text reconciliation finish.

### packages/client/ui-conversation/src/client/input/editor/projection.ts
- Purpose: three pure text views over one Lexical `EditorState`.
- Key abstractions: `ATOMIC_CHAR` (U+FFFC); `ComposerSegment`; `ComposerLayout`; `$composerLayout()`; `$projectComposer()`.
- Data flow: `detectText` feeds trigger detection and `TokenSpan` coordinates (every chip counts as **one** U+FFFC — "the opaque-reference invariant"); `clipboardText` feeds persistence, the `InputState` draft and submit-plane decisions (chips expand to their clipboard projection); the model form is not a text view here — submit serializes chip nodes through their owner codec (`packages/client/ui-conversation/src/client/input/editor/projection.ts:1-8`).
- Non-obvious design decisions: a single walk (`$composerLayout`) produces every segment, so the two projections can never disagree about offsets. A block gap (the newline between paragraphs) is a **segment kind** of its own, with `gapBetween` naming the two blocks it separates.
- Edge cases / failure handling: a chip is atomic in both projections — `detectLength` is 1 and `clipboardLength` is the chip's `clipboardText` length, so a multi-character chip shifts the two planes by different amounts and the layout carries both offsets explicitly.
- Surprising: `$projectComposer` returns the selection as a detect-coordinate range and the caret separately (`range.start === range.end`), so a collapsed selection is distinguishable from a selection at the document end.

### packages/client/ui-conversation/src/client/input/editor/reference-activation.ts
- Purpose: route composer clicks through the live reference owner without editing the draft.
- Key abstractions: `registerReferenceActivation(editor, open)`.
- Data flow: a click on a `ReferenceChipNode` calls `open(source, { ref, appearance })`; a click on a `TextRefNode` calls `open(undefined, { ref: text })`.
- Non-obvious design decisions: the handler refuses a **double click** (`event.detail > 1`, `packages/client/ui-conversation/src/client/input/editor/reference-activation.ts:22`) so a text selection is not stolen by the owner, and it refuses a non-collapsed selection. An invalid chip is not opened (`packages/client/ui-conversation/src/client/input/editor/reference-activation.ts:27`).
- Edge cases / failure handling: the command is registered at `COMMAND_PRIORITY_LOW`, so the editor's own handling wins whenever it wants it.
- Surprising: the editable text-ref token is opened with `source: undefined` — the owner resolves it from the ref text alone, which is why a plain `/name` in a draft is still navigable.

### packages/client/ui-conversation/src/client/input/editor/ReferenceChip.module.css
Atomic chip metrics: `max-width: 240px`, `user-select: none`, an ellipsised label, and the `.invalid` treatment (error colour, line-through, 0.7 opacity). The stylesheet is the only place the invalid state is expressed — the node carries the bit, the CSS renders it.

### packages/client/ui-conversation/src/client/input/editor/ReferenceChip.tsx
- Purpose: the visual body of one inline reference chip.
- Key abstractions: `ReferenceChipProps { label, appearance?, invalid }`.
- Data flow: `ReferenceChipNode.decorate()` renders it.
- Non-obvious design decisions: an absent `appearance` renders a bare `@` marker rather than an icon (`packages/client/ui-conversation/src/client/input/editor/ReferenceChip.tsx:30-32`), so an un-typed reference still reads as a trigger.
- Edge cases / failure handling: the `openable` class is applied only for a `file` appearance and only when the chip is valid — a broken file reference is not clickable.
- Surprising: the label is also the `title` attribute, so the full text is available on hover even when the visible label is truncated.

### packages/client/ui-conversation/src/client/input/editor/runtime.ts
- Purpose: the Composer's private Lexical editor, projections and node operations.
- Key abstractions: `DraftEditorRuntime`; `DraftEditorRuntimeDeps`; `REFERENCE_PLACEHOLDER_RE`; `HISTORY_MERGE_DELAY_MS`.
- Data flow: `register()` installs plain-text, history, the keymap, the chip transforms and the reference activation; `refreshProjection()` re-derives the three text views after each update.
- Non-obvious design decisions: `applyEdit` (`packages/client/ui-conversation/src/client/input/editor/runtime.ts:123-132`) has exactly one writer path — a nested application joins the enclosing update (the `PASTE_COMMAND` dispatch always lands there) and the tag attaches to that update, otherwise a discrete update is opened. The placeholder strip (`packages/client/ui-conversation/src/client/input/editor/runtime.ts:34-40`) removes any literal U+E100–U+E11D or U+FFFC from *external* text entering the document, because "a chip is the only legitimate source of U+FFFC in the detect projection, so a literal one in text would forge chip positions".
- Edge cases / failure handling: `onError: (error) => { throw error }` — a Lexical error is rethrown rather than swallowed.
- Surprising: occurrence ids are assigned **per chip `NodeKey`** in a `Map`, and "undo restores keys, so ids survive it too" (`packages/client/ui-conversation/src/client/input/editor/runtime.ts:53-54`).

### packages/client/ui-conversation/src/client/input/editor/span-map.ts
- Purpose: the one place that maps a `TokenSpan`'s numeric `[start, end)` back onto Lexical points and applies an edit there.
- Key abstractions: `DetectSpan`; `resolvePoint`; `selectSpan`; `$selectDetectSpan`; `$replaceDetectSpanWithText`; `$replaceDetectSpanWithNodes`.
- Data flow: every slash/input-* event (begin-command, insert-reference, insert-text, consume-token) lands through here; the revision CAS stays with the caller (`packages/client/ui-conversation/src/client/input/editor/span-map.ts:1-8`).
- Non-obvious design decisions: the ownership rule for point resolution (`packages/client/ui-conversation/src/client/input/editor/span-map.ts:27-36`) is stated precisely: the first segment whose half-open range contains the offset resolves it; atomic segments (chip, linebreak) resolve to **element points beside them**, "so a span can only ever address a chip as a whole"; a gap offset is the end of the block before it; the document end falls to the last block.
- Edge cases / failure handling: `selectSpan` returns `null` when either endpoint fails to map or the span is out of bounds, and the replace helpers return `false` rather than editing.
- Surprising: a chip therefore cannot be partially selected — the atomic-segment rule makes "select half a chip" unrepresentable.

### packages/client/ui-conversation/src/client/input/editor/text-ref.ts
- Purpose: editable reference tokens that share the chip's hover styling while keeping ordinary text semantics.
- Key abstractions: `TextRefNode extends TextNode`; `registerTextRefDecoration(editor, lexiconOf)`; `rescanTextRefs(editor)`.
- Data flow: `registerLexicalTextEntity` installs an entity transform that re-evaluates the match shape after every edit; the scan itself lives in `input/decorations.ts`.
- Non-obvious design decisions: `isTextEntity()` returns `true` and `canInsertTextBefore()` returns `true` (`packages/client/ui-conversation/src/client/input/editor/text-ref.ts:62-69`) — "Entity nodes never merge with plain siblings (the transform owns their bounds)", but editing continues inside, and the transform re-evaluates match shape per edit. The class name is `composer-text-ref`, distinct from a chip's `reference-chip`.
- Edge cases / failure handling: `rescanTextRefs` marks every text node dirty because "transforms only visit dirty nodes; a lexicon roll change dirties nothing on its own". It is queued rather than discrete, because the caller may sit inside an update listener.
- Surprising: a text-ref is a *styled text node*, not a decorator — so the browser's own caret, selection and IME all work inside it with no special handling.

### packages/client/ui-conversation/src/client/input/editor/view-binding.ts
- Purpose: the DOM and keymap bindings installed by the InputBar's effects.
- Key abstractions: `DraftViewGate`; `revealDraftSelection`; `focusDraftEditor`; `installDraftWheel`; `installDraftFilePicker`; `installDraftKeymap`; `keepDraftFocus`.
- Data flow: `installDraftKeymap` maps the editor's gestures onto the Session's `ComposerKeyboard` face, reading live view values through a `MutableRefObject` gate.
- Non-obvious design decisions: the **empty-draft accelerated Enter** gesture steers every still-pending queued message into the running turn instead of submitting an empty draft, "because the machine rejects empty drafts" (`packages/client/ui-conversation/src/client/input/editor/view-binding.ts:120-127`). `focusDraftEditor` calls `editor.getRootElement()?.focus({ preventScroll: true })` *before* `editor.focus(...)` — "Lexical's `focus()` restores the editor selection but never calls the DOM focus itself".
- Edge cases / failure handling: `installDraftWheel` forwards wheel movement at the draft's edge to the conversation scrollport only when the draft is at its top/bottom, so the composer never steals a scroll the transcript needed. `keepDraftFocus` prevents a toolbar press from moving focus away from the draft.
- Surprising: a collapsed caret at an empty line reports a zero rect in some engines, so `revealDraftSelection` falls back to the anchor's element box (`packages/client/ui-conversation/src/client/input/editor/view-binding.ts:34-42`).

### packages/client/ui-conversation/src/client/input/facade.ts
- Purpose: the `SessionInput` shell — owns the per-session Lexical editor and the pure `SubmitMachine`, and choreographs everything between them.
- Key abstractions: `SessionInputDeps`; `SessionInputShell`; `EditorProjection`.
- Data flow: the hub constructs one shell per retained Session binding; the shell wires the scoped input-trigger listeners, publishes `InputState`, and executes the machine's effects.
- Non-obvious design decisions: the **revision CAS** is the shell's core safety property: `if (span.draftRev !== this.rev) return false` (`packages/client/ui-conversation/src/client/input/facade.ts:514`) refuses an edit whose range was captured before a later draft change. `applyClaim` additionally enforces the leading-trigger contract — "only whitespace may precede the span; the whitespace prefix is dropped so the chip takes the leading seat" (`packages/client/ui-conversation/src/client/input/facade.ts:515-519`).
- Edge cases / failure handling: `dead(attempt)` drops a settle for a superseded attempt or a disposed facade (`packages/client/ui-conversation/src/client/input/facade.ts:920-922`); the `commit-draft` effect's string-snapshot semantics preserve a pure suffix typed during the Host round-trip while an interleaved edit clears the whole.
- Surprising: reference serialization is awaited **outside** the machine (`packages/client/ui-conversation/src/client/input/facade.ts:751`) so a slow owner codec cannot stall the submit plane; and `compose()` (`packages/client/ui-conversation/src/client/input/facade.ts:924-935`) overlays the Agent Inbox's next-turn list onto `InputState.queue`, so the composer's queue is the Host's inbox, not a local copy.

### packages/client/ui-conversation/src/client/input/hub.ts
- Purpose: the Session-bound input registry and the default-send routing.
- Key abstractions: `InputHub implements SessionInputResolver`; `InputTriggerServiceFace`; `ConversationAttachmentFace`.
- Data flow: `for(actx)` resolves the resident shell for a session scope; the hub installs the **four scoped slash-event listeners** (`packages/client/ui-conversation/src/client/input/hub.ts:146-155`) on each shell, wires the catalog subscription, and provides the default sink.
- Non-obvious design decisions: the hub resolves services **lazily per call** ("boot order stays free", `packages/client/ui-conversation/src/client/input/hub.ts:59-60`) and resolves the attachment face lazily "to keep hub/service construction acyclic" (`packages/client/ui-conversation/src/client/input/hub.ts:41`). Saved drafts enter the model **before the first lookup returns** (`packages/client/ui-conversation/src/client/input/hub.ts:1-6`).
- Edge cases / failure handling: `for(actx)` throws "conversation.input.for requires a retained Session scope" when the scope does not resolve to a live binding (`packages/client/ui-conversation/src/client/input/hub.ts:76-78`); a missing `sessions` or `conversation` service throws rather than returning a half-built face.
- Surprising: the hub keeps a `WeakMap<SessionBinding, SessionInputShell>` — the shell's lifetime is the *binding's* lifetime, so releasing a reference releases the editor.

### packages/client/ui-conversation/src/client/input/machine.ts
- Purpose: the pure per-session submit-plane state machine — events in, effects out, zero React / DOM / cordis.
- Key abstractions: `SubmitMachine`; `SubmitSnapshot`; the `phase` (`plain` | `claimed` | `adjudicating` | `submitting`).
- Data flow: `dispatch(event)` returns an ordered effect list; the shell executes them.
- Non-obvious design decisions: **ordinary sends detach at Enter** — `detachedEffects` (`packages/client/ui-conversation/src/client/input/machine.ts:130-135`) returns the sink effect and the commit effect together, so the editor can clear immediately and accept another message while earlier admissions remain in flight. The `detached` map (`packages/client/ui-conversation/src/client/input/machine.ts:46`) holds their `AbortController`s so a release can abort them. A claimed command occupies the frozen in-flight slot instead (`packages/client/ui-conversation/src/client/input/machine.ts:137-143`).
- Edge cases / failure handling: a stale settle is dropped by comparing the flight's attempt seq (`packages/client/ui-conversation/src/client/input/machine.ts:159`); an empty or whitespace-only draft produces no effect at all (`packages/client/ui-conversation/src/client/input/machine.ts:144-145`); a leading `/` after trimming enters `adjudicating` with a minted attempt, while a non-whitespace prefix before `/` is ordinary text and falls to the default sink (`packages/client/ui-conversation/src/client/input/machine.ts:146-151`).
- Surprising: `onRelease` aborts both the in-flight attempt and every detached send — leaving a session cancels work the user may not know is running.

### packages/client/ui-conversation/src/client/input/submission-analytics.ts
- Purpose: map ordinary message occurrences to Desktop product events.
- Key abstractions: `reportMessageSubmission(ctx, submission)`.
- Data flow: tracks `send_button_click` with `session_id`, `model_name` (`provider/name`), `thinking_effort`, `run_mode` and `msg_type`.
- Non-obvious design decisions: the event is reported with the **original** occurrence's timestamp and state, "without reading newer Session facts" (`packages/client/ui-conversation/src/client/input/submission-analytics.ts:7-8`) — the analytics must describe the submission the user made, not the state the app later reached.
- Edge cases / failure handling: a submission with no state is ignored entirely; optional fields are spread in conditionally so absent model/effort do not become `undefined` keys.
- Surprising: `msg_type` is the *delivery mode* when the agent was running (`'queue'` or `'steer'`) and the literal `'default'` otherwise — so the busy-Enter preference is directly measurable.

### packages/client/ui-conversation/src/client/input/submission-policy.ts
- Purpose: the live busy-Enter preference and the gesture → delivery-mode resolution.
- Key abstractions: `resolveSubmitMode(preferred, running, gesture, steeringAvailable)`; `ComposerSubmissionPolicy`.
- Data flow: the Settings row and the composer bar both read `policy.busyEnter`; the durable value lives in the Host user-settings document.
- Non-obvious design decisions: the accelerated chord is **the opposite** of the plain-Enter preference (`packages/client/ui-conversation/src/client/input/submission-policy.ts:38`) — "Plain Enter and the primary Send button share the `enter` gesture, so the button delivers exactly what Enter would", and the complementary gesture gives the other behaviour. `setBusyEnter` publishes the live value **before** the durable write starts (`packages/client/ui-conversation/src/client/input/submission-policy.ts:71-75`), so the UI never waits on the Host.
- Edge cases / failure handling: outside a steer-capable busy state the mode is always `'queue'`; a `steer` submission is "intentionally best-effort: AgentLoop turns a closed-window submission into the next waking Queue item" (`packages/client/ui-conversation/src/client/input/submission-policy.ts:20-23`).
- Surprising: `adopt()` (`packages/client/ui-conversation/src/client/input/submission-policy.ts:81-85`) writes back nothing — a Host-accepted value is adopted silently, and an identical write is a no-op, so the panel cannot ping-pong the setting.

### packages/client/ui-conversation/src/client/locales.ts
The `conversation` namespace dictionary: 767 lines, the key-set source of truth, with `zh` declared first and `en` mirroring it under `satisfies Record<ConversationKey, string>` at line 767. Covers shortcuts, placeholders, attachment and image copy, the context meter, Settings, the hero, todo status and diff vocabulary, and the whole tool-card vocabulary (terminal, diff, read, search, web, details). I read the first 120 lines and the last 67; the middle is the paired English/Chinese body, same shape as the two ends.

### packages/client/ui-conversation/src/client/queue/QueueDock.module.css
The queue panel's geometry: a wrapper that cancels the stack gap and tucks 3px under the input card "reading as one attached surface", a panel with a `::before` menu surface and a `::after` hairline whose bottom border is dropped (the card's own top border closes the shape), a 36px header, and 36px rows separated by an inset hairline. The attachment strip is capped at 55% of the row so the preview text always keeps room.

### packages/client/ui-conversation/src/client/queue/QueueDock.tsx
- Purpose: the queue dock — the durable rows waiting to become turns.
- Key abstractions: `QueueDockInjected { updateQueue, notify, loadImage }`; `queueAttachments`; `QueueFile`; `QueueThumb`.
- Data flow: the Agent Inbox's `next-turn` rows are the authority; each row may be edited, removed or steered through `conversation.updateQueue`.
- Non-obvious design decisions: the row's content is **wire data despite its typed face**, so an image block without a reference is *skipped* rather than trusted (`packages/client/ui-conversation/src/client/queue/QueueDock.tsx:37-42`). The dock's scope inject (`packages/client/ui-conversation/src/client/queue/QueueDock.tsx:399-409`) resolves the conversation service through the Session scope and throws when the scope or the service is missing, so a mis-scoped dock fails at mount rather than at click.
- Edge cases / failure handling: the injected `loadImage` routes through `ctx.uiConversation.imageUrl(sessionId, attachment)`, so the dock never manages an attachment URL itself. `notify` routes through the session's own input notice channel.
- Surprising: the dock registers at `order: 20` in `conversation.input.dock` while the todo dock is at `order: 0` — the queue sits below the plan strip.

### packages/client/ui-conversation/src/client/service.ts
- Purpose: the scope-addressed conversation send, cancel and history orchestration — the outward `ctx.conversation` face.
- Key abstractions: `IConversation { input, blocks, send, updateQueue, cancel, loadOlder }`; `ConversationController`.
- Data flow: `ctx.conversation.send(text)` → the Session Controller's `prompt`, with attachments and a delivery mode; `cancel()` → the session's cancel; `updateQueue(itemId, action)` → the session's queue operation.
- Non-obvious design decisions: scope addressing rides the Cordis `Service` tracker: "property access through `ctx.conversation` rebinds `this.ctx` to the caller's context, so methods read the session tag with `scopeOf`. Mutable state must remain reachable through one property read; assignment through the tracker proxy and `#` private fields bypass that rebinding" (`packages/client/ui-conversation/src/client/service.ts:3-8`). The file **imports no values from other plugins** — scope resolution goes through the sessions service because "a plugin-to-plugin value import is a bundle purity error" (`packages/client/ui-conversation/src/client/service.ts:13-15`).
- Edge cases / failure handling: `nextPaint()` (`packages/client/ui-conversation/src/client/service.ts:101-122`) gives a submission echo "one paint opportunity without letting a throttled frame clock block admission" and falls back to `setTimeout` when the document is hidden. `pumpFileUploads()` (`packages/client/ui-conversation/src/client/service.ts:403-415`) starts upload workers until the configured concurrency is occupied. `isImageMediaType` refuses any media type outside the four raster types.
- Surprising: a browser draft attachment is only an *id* in the input state; the bytes and the preview URL live in the controller, so the composer never holds a `File` it might leak into a snapshot.

### packages/client/ui-conversation/src/client/settings/EnterBehaviorRow.module.css
A 56-line Settings row: title/description on the left, a 36px selector pill on the right, separated by a 0.5px bottom rule. Pure presentation; the behaviour lives in `submission-policy.ts`.

### packages/client/ui-conversation/src/client/settings/EnterBehaviorRow.tsx
- Purpose: the General Settings row for the Composer's busy-state Enter preference.
- Key abstractions: `EnterBehaviorRowInjected { hooks: { busyEnter }, setBusyEnter }`; `EnterBehaviorRowProps`; `OPTIONS`.
- Data flow: the row reads `useBusyEnter` and calls `setBusyEnter`; the injected face is bound by the composer-bar entry's inject.
- Non-obvious design decisions: only two options are offered — `queue` and `steer` (`packages/client/ui-conversation/src/client/settings/EnterBehaviorRow.tsx:26-32`) — and the row's description explicitly says the preference covers **both** Enter and the Send button, with Cmd/Ctrl+Enter using the other behaviour.
- Edge cases / failure handling: the selector is a `Menu` with `align="end"` and `portal`, so it is not clipped by the panel.
- Surprising: the row is registered as a `settings.general.item` list entry with the id `composer-enter`, so the Settings panel owns the row and this package only owns its copy.

### packages/client/ui-conversation/src/client/skeleton/ContextMeter.module.css
The meter's visual language: a transparent trigger that fills on hover, an SVG ring (2px stroke), a fixed-position panel (`z-index: 1100`, `min(264px, 100vw - 24px)`) with the menu surface and prominent elevation, a 4px bar of `min-width: 2px` segments, and one tint per composition row (system / tools / messages). The purple tools tint is a literal `rgb(167, 139, 250)` because "the design platform ships no purple static token" (`packages/client/ui-conversation/src/client/skeleton/ContextMeter.module.css:126-127`).

### packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx
- Purpose: the composer's context-occupancy meter — a ring and percentage below the card, with a click-open panel of the heuristic `contextBreakdown`.
- Key abstractions: `ContextMeterProps`; `terminalBlockLabels`-style label builders; `formatTokens`.
- Data flow: `useProjection('contextPressure')` and `useProjection('contextBreakdown')` feed `contextOccupancy` and the three breakdown rows.
- Non-obvious design decisions: the localized occupancy sentence is split on a **marker** (`READING_SLOT = '\u0000'`, `packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx:26`) "so the panel headline keeps the reading in its own tone while each locale still owns the word order (`45% of context used` / `上下文已用 45%`)". The panel is portalled to `document.body` and positioned with `useAnchoredPosition`.
- Edge cases / failure handling: a model switch can temporarily remove capacity while the component stays mounted, so the now-unavailable panel is **closed** rather than preserved (`packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx:74-78`); Escape and an outside pointerdown close it, a pointerdown inside does not.
- Surprising: the meter renders *nothing* until a provider reports both pressure and a route capacity — a context percentage without a known window is withheld entirely.

### packages/client/ui-conversation/src/client/skeleton/control-row-layout.ts
- Purpose: content-sized model collapse for the composer's two control groups.
- Key abstractions: `observeControlRow(row)`.
- Data flow: a `ResizeObserver` on the row and its children, a `MutationObserver` on the subtree, and a `document.fonts` `loadingdone` listener all re-measure.
- Non-obvious design decisions: the measurement **always measures the expanded demand**, including text changed while collapsed — `row.removeAttribute('data-model-compact')` first (`packages/client/ui-conversation/src/client/skeleton/control-row-layout.ts:13`) — because a collapsed row's own width is no longer the demand. The available width subtracts the row's padding, and the needed width adds the column gap between children.
- Edge cases / failure handling: children with zero width (hidden groups) are excluded from the demand, so a hidden group reserves no space. The disposer disconnects both observers and removes the font listener.
- Surprising: the model text collapses only when the *expanded* controls cannot share a line, and wrapping remains available when even the icon cannot fit — an overflow-driven degradation with no breakpoint.

### packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx
- Purpose: the shared Conversation body and its occurrence-selected local Components.
- Key abstractions: `ConversationContentProps`; `ConversationViewsProps`; the `views` and `widthControls` factory slots.
- Data flow: the session snapshot, the input state, the workspaces list and the composer block are read; the views slot is rendered inside the scroll body and the composer seat is measured by a `ResizeObserver`.
- Non-obvious design decisions: the seat measurement publishes **two** CSS variables — `--dsh-composer-height` so floating controls clear the composer as it grows, and `--dsh-conversation-viewport-height` so a control can sit in the band the seat leaves visible (`packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx:45-51`). It uses a **callback ref, not an effect**, "stable identity prevents observer churn while the first blank session fills the resident body outlet".
- Edge cases / failure handling: the composer's `Workspace` trigger state renders the same DOM inert as the live composer, so switching between the two never swaps the element tree.
- Surprising: the composer seat is a **sibling** of the views inside the scroll body, and the sticky-position comment explains why: sticky on the fallback alone would leave a business-owned takeover at the content end off-screen when the user is not pinned to the floor.

### packages/client/ui-conversation/src/client/skeleton/ConversationHeader.tsx
- Purpose: the resident conversation navigation and Session-specific header content.
- Key abstractions: `ConversationHeaderProps`.
- Data flow: the session and conversation snapshots decide "blank"; the header renders the `conversation.header.leading` slot and, with a session, the `conversation.session.header` slot.
- Non-obvious design decisions: global navigation stays available **before a Session exists** (`packages/client/ui-conversation/src/client/skeleton/ConversationHeader.tsx:8-10`) — the header renders with `hideChrome` on a blank session rather than disappearing.
- Edge cases / failure handling: `data-window-drag` marks the row the macOS hiddenInset titlebar drags over; the CSS in `ConversationRoot.module.css` subtracts the title-row clusters from it.
- Surprising: `sessionId === undefined` renders an empty `titleRow` rather than the session header slot — the header's geometry does not change with the session's presence.

### packages/client/ui-conversation/src/client/skeleton/ConversationMainPanel.tsx
- Purpose: the main Conversation frame around the extracted content.
- Key abstractions: `ConversationSlotProps`; `CONTENT_SLOTS`.
- Data flow: the session and conversation snapshots produce the shell phase; the phase becomes the root's `data-phase` and drives the hero/active/settling choice.
- Non-obvious design decisions: the **`settling`** phase (`packages/client/ui-conversation/src/client/skeleton/ConversationMainPanel.tsx:37-43`) exists so a session that is still replaying renders the composer *hidden* instead of flashing the centred hero and snapping to the docked bar. The exemption is deliberate and stated: a session the list summary already proves blank can only land on the hero, so hiding it would blank the column for the whole history round-trip. A restored continuable subagent waits for a Host summary to establish parent availability.
- Edge cases / failure handling: the exemption is "deliberately open-state-wide, not loading-only" — a summary-blank session is the hero before its open starts (`cold`) and after one fails (`error`).
- Surprising: the `settling` phase is a *third* phase alongside hero and active, and it is a layout decision rather than a data state.

### packages/client/ui-conversation/src/client/skeleton/ConversationPanel.tsx
Twelve lines: the root-scoped main occupant renders `main.conversation` and nothing else. "Session binding belongs to its Conversation child" — the panel deliberately holds no session state.

### packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css
The shell's layout sheet (559 lines). Load-bearing details: the header is exactly 76px with its rule so it meets the Sidebar's tab strip at the column edge (`packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css:10-14`); the title row is an **anonymous inline-size container** so its occupants shed text at row-width breakpoints (`packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css:64-81`); the macOS titlebar rule gives the header its own drag geometry and marks the four clusters `no-drag` (`packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css:50-62`); the width handles are absolute in `.body` — *not* the scrollport (an absolute strip there would extend the scrollable range) and *not* `.root` (a strip from the column top would paint through the header's transparent background) (`packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css:247-258`); and the `settling` phase hides the composer seat with `visibility: hidden` (`packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css:554-559`).

### packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx
Thirteen lines: the resident conversation skeleton. Its header comment states the invariant — "Hero chrome, composer positioning, the chain, AND the composer bar (session-maybe slot) stay mounted across no-session/session transitions — the bar renders inert via owner props." The component is a pure delegation to `ConversationMainPanel`.

### packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx
- Purpose: the strict per-session header and body content.
- Key abstractions: `ConversationSessionHeaderProps`; `Breadcrumb`; `deriveAncestry`; `equalBreadcrumbs`.
- Data flow: the session list yields the ancestry chain; the view ledger yields the tab strip; the store yields the selected view.
- Non-obvious design decisions: `deriveAncestry` (`packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx:25-43`) walks `parentId` **only while the session's `origin` is `subagent`**, with a `seen` set that breaks a cycle. The current crumb is rendered as plain text, not a disabled button: "on darwin desktop a button would subtract itself from the header's drag row and leave the title inert for dragging too" (`packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx:76-80`).
- Edge cases / failure handling: `equalBreadcrumbs` is a custom equality so the ancestry selector does not re-render on an unrelated list update.
- Surprising: the lineage slot is offered for subagent crumbs as well as the current one, with a `fallback` of the plain title.

### packages/client/ui-conversation/src/client/skeleton/ConversationWidthControls.tsx
- Purpose: the draggable transcript-width handles.
- Key abstractions: `WidthHandle`; `readWidthPreference`; `resolveContentWidth`; `wheelDeltaY`.
- Data flow: pointer capture on the handle updates `--dsh-chat-user-width` on the container; the committed value is persisted to `localStorage` under `dsh.conversation.contentWidth`.
- Non-obvious design decisions: the width is clamped by `resolveContentWidth` (`packages/client/ui-conversation/src/client/skeleton/ConversationWidthControls.tsx:24-28`) to a 640px floor and to `columnWidth - 176`; the default is `max(680, min(columnWidth * 0.64, 920))` — overflow-driven, no breakpoint. Wheel deltas are converted by `deltaMode` because the scrollport's line height is not the browser's default.
- Edge cases / failure handling: a corrupt persisted preference is ignored (`Number.isFinite(value) && value > 0`).
- Surprising: the handle's width is computed from the *available margin* (`calc((100% - var(--dsh-chat-content-width)) / 2 - 24px - 24px)`) so the hit target collapses to zero on a narrow column rather than producing a mispositioned hit area.

### packages/client/ui-conversation/src/client/skeleton/DefaultConversationViews.tsx
- Purpose: render the active Session view inside the resident scrollport and keep the draft persisted while the blank Hero chrome is visible.
- Key abstractions: `ConversationSessionSlotProps`.
- Data flow: the view ledger, the store's selected view and the conversation phase decide what renders; `renderSlot('conversation.view', …, { only: viewId })` renders one tab.
- Non-obvious design decisions: the draft persistence mirror is bound in an effect keyed on `inputActions` alone (`packages/client/ui-conversation/src/client/skeleton/DefaultConversationViews.tsx:25-30`) — "The Session input owns content before this persistence writer is attached."
- Edge cases / failure handling: a blank session in the blank phase renders `null` — the view area is not mounted at all.
- Surprising: `view` (the prop) overrides the store's selection, so a caller can force a view without writing the preference.

### packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx
- Purpose: the new-session hero chrome — the fish mark, the headline and the workspace chip.
- Key abstractions: `workspaceLabel(cwd)`; `WorkspaceChip`; `HeroShellProps`; `HERO_SWIM_UP_PATH`.
- Data flow: the workspace list supplies the chip's label; the hero slot supplies the brand mark.
- Non-obvious design decisions: the hover swim morph is **generated programmatically** — the comment at `packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx:74-83` spells out the deformation model: parse the path's absolute M/C/L/Z commands, displace points with smoothstep falloff weights and emit the same command structure so SMIL can interpolate `d` between them. The eye subpaths carry zero weight and stay fixed.
- Edge cases / failure handling: the workspace chip is always interactive before the first message — "picking another one moves the New Session flow to that workspace's blank session" — and renders a closed-folder placeholder state when it has no label.
- Surprising: the animation only runs under `(hover: hover) and (prefers-reduced-motion: no-preference)` and is gated on the same media query in the component, so a touch device never sees it.

### packages/client/ui-conversation/src/client/skeleton/HeroShell.module.css
The hero's geometry (232 lines): the stack's 12px gaps and the composer card's max width, the headline's overflow-driven wrap (the fish takes its own line when squeezed), the preview badge as a mono superscript pill, and the `hero-fish-swim` keyframes (a slow sway about the body centre with a counter-tilt at 70%). The `.fish` rule sets `overflow: visible` because "the swim morph's curves poke slightly past the viewBox edges, so clipping would slice the tail mid-wag".

### packages/client/ui-conversation/src/client/skeleton/InputBar.module.css
The composer's card (423 lines). Load-bearing: `.scroll` is "the draft's scrollport, and the ONLY scrolling box in the composer" and carries the 14-line cap (`packages/client/ui-conversation/src/client/skeleton/InputBar.module.css:125-134`); the card's side pad rides the shared `--dsh-composer-side-clearance`; the WebKit scrollbar track gets an 8px top margin "so it never pokes outside the capsule"; the placeholder is an absolutely positioned one-line ellipsis; the hint is injected as `content: var(--dsh-composer-hint)` on the last paragraph so the claim's ghost hint rides the text.

### packages/client/ui-conversation/src/client/skeleton/InputBar.tsx
- Purpose: the default composer body — the `conversation.composer.bar` slot entry.
- Key abstractions: `InputBarProps`; `ComposerBarProps`; the `useNotices`/`useLexicon`/`useMenuLauncher`/`useStopShortcut` hook seats.
- Data flow: the machine state arrives through the standard provide channel (`useInput` + `inputActions`); the keyboard/DOM command face and the stop arrive through the entry's own inject; the session facts (running, removed, promptError, subagent) are self-selected via `useSession`.
- Non-obvious design decisions: the primary seat's **label names the delivery mode** (`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:327-333`) — "排队发送" vs "插话发送" — so the user can see which of the two the button will do without reading the setting. The activity indicator replaces the context meter while something is running (`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:524`).
- Edge cases / failure handling: the file-upload toast blocks the submit when an upload is still pending (in `view-binding.ts`); the composer block from another plugin renders as an inert placeholder with that plugin's reason.
- Surprising: `void useLexicon` — the lexicon hook seat stays bound by the inject compartment even though the text-ref decoration rides the shell's editor transforms instead, so the bar keeps the subscription contract without using the value.

### packages/client/ui-conversation/src/client/skeleton/safari.ts
- Purpose: Safari-specific textarea layout recovery for the conversation composer.
- Key abstractions: `BrowserIdentity`; `isSafariBrowser(identity)`; `repairSafariTextareaLayout(input)`.
- Data flow: the browser's user agent and vendor are matched; a stale native layout is invalidated by a one-pixel height bump plus a forced reflow.
- Non-obvious design decisions: the UA match requires the Apple vendor **and** the `Version/… Safari/…` form **and** excludes known alternate iOS browsers (`packages/client/ui-conversation/src/client/skeleton/safari.ts:9-19`) — Chrome on iOS, Edge on iOS, Opera on iOS and DuckDuckGo all carry Safari tokens, so a naive UA test would misfire on all of them.
- Edge cases / failure handling: the recovery does nothing when the input owns no scrollable overflow, nothing outside the composer scrollport, and nothing at all for a null input during teardown.
- Surprising: the repair is a *height-bump-and-reflow* trick: set the height to `clientHeight + 1`, read `offsetHeight`, restore — twice, for the input and then for the scrollport, because the scrollport's auto height can be contaminated by the input's stale layout.

### packages/client/ui-conversation/src/client/skeleton/TodoPanel.module.css
The plan strip's geometry: a menu-surface panel inset by the shared dock inset from the composer card, a 180px scrolling list, and single-line items that ellipsize with no inline expand ("Figma strip is single-line").

### packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx
- Purpose: the plan strip — the session's current todo list, collapsed by default.
- Key abstractions: `TodoPanelProps`; `TodoDockProps`; `todoDockEntry`; `statusDotState`; `statusLabel`; `progressLabel`.
- Data flow: the `todos` projection supplies the list; the panel renders a header with per-status counts and an expandable list.
- Non-obvious design decisions: `progressLabel` (`packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx:52-63`) omits zero-count segments as noise "a non-empty list keeps at least one", and joins with U+2002 (en space) because "HTML collapses runs of ASCII spaces, so widening the separator breathing room needs a literal wide space".
- Edge cases / failure handling: an empty list renders nothing at all (`packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx:67`); the panel starts collapsed and the chevron direction reflects that.
- Surprising: the package's own `assertNever` backstop exists because "client packages do not depend on `dsh-llm`" — the closed-union exhaustiveness check is re-implemented locally rather than imported.

### packages/client/ui-conversation/src/client/stop-sequence.ts
- Purpose: two independent Escape presses addressed to one Conversation occurrence and live turn.
- Key abstractions: `StopTarget { sessionId, turn, generation, region, cancel }`; `StopSequence`.
- Data flow: `press(target)` returns whether the press requested cancellation; the caller supplies a freshly resolved target each time.
- Non-obvious design decisions: the first press is **cleared before an accepted cancellation runs** (`packages/client/ui-conversation/src/client/stop-sequence.ts:39-47`), so a third press cannot re-fire. The target's `generation` (the materialised Session binding identity) invalidates an earlier press when the binding is replaced.
- Edge cases / failure handling: two presses only combine if the session, turn, generation *and* focused region all match (`packages/client/ui-conversation/src/client/stop-sequence.ts:41-44`); the expiry timer runs at `intervalMs + 1` so the inclusive endpoint still counts.
- Surprising: the sequence requires the *same DOM region* — a first press in the composer and a second press in the transcript are two different stops, not a double-Escape.

### packages/client/ui-conversation/src/client/stop-shortcut.ts
- Purpose: fixed Escape routing into the current Conversation turn's scoped cancellation.
- Key abstractions: `installStopShortcut(shortcuts, sessions, openTurn, uiSession, cancel)`.
- Data flow: the shortcut service's `observeFixedInput` yields a gesture plus a context (modal, region, target); the handler resolves the conversation occurrence from `data-conversation-session` and the region from `data-conversation-region`.
- Non-obvious design decisions: the handler refuses a *lot* of contexts — a repeat, a composing event, an already-prevented event, any modifier, an open modal, the terminal region, or a null target — and it refuses a press whose region is not inside the occurrence's session (`packages/client/ui-conversation/src/client/stop-shortcut.ts:34-41`). It also refuses presses inside `[data-approval-key], iframe, .xterm, [inert]`, because an approval dialog or a terminal owns its own Escape.
- Edge cases / failure handling: the current turn is resolved *freshly* each time and is undefined when the session is not running, was removed, is a subagent whose address is not `continuable`, or has a pending interaction (`packages/client/ui-conversation/src/client/stop-shortcut.ts:46-52`). After the first press, subscriptions watch the turn source, the session and the session status and reset the sequence if any of them changes (`packages/client/ui-conversation/src/client/stop-shortcut.ts:58-62`).
- Surprising: the stop button and the Escape key go through *the same* scoped `cancel()` operation, and a stop failure is published through the Session's `promptError` rather than a local notice.

### packages/client/ui-conversation/src/client/stores.ts
- Purpose: the per-session Conversation store shared by the shell body and the header.
- Key abstractions: `createConversationStore()`; `readConversationDraft(sessionId)`; `readConversationViewPreference(sessionId)`.
- Data flow: the store persists under the key `dsh.conversation` (scoped per session id) in `localStorage`.
- Non-obvious design decisions: the two readers exist because the draft and the view preference must be read **before the Slot store is materialised** (`packages/client/ui-conversation/src/client/stores.ts:38-41`, `packages/client/ui-conversation/src/client/stores.ts:58-61`) — the shell needs them at first render.
- Edge cases / failure handling: a malformed JSON record, a missing `draft` member, a non-object record, absent `localStorage`, and a `SecurityError` from a denied storage read **all** degrade to an empty draft and a `null` view, and the stored record is left untouched (`packages/client/ui-conversation/src/client/stores.ts:52-55`, `packages/client/ui-conversation/src/client/stores.ts:71-73`).
- Surprising: `readConversationDraft` and `readConversationViewPreference` are independent — an unusable draft does not cost the user their view preference, and vice versa.

### packages/client/ui-conversation/src/client/user-text/session-reference-rule.ts
- Purpose: the Session-reference matcher — original-text candidates with explicit wire spelling and longest known labels.
- Key abstractions: `sessionReferenceRule` (id `'session'`, order 10); the `session` entry in `UserTextDataMap`; the `sessionLabels` fact.
- Data flow: the rule scans forward from `from` for `@`; at each position it first tries the explicit wire form `@[label](dsh-session:id)`, then the supplied labels.
- Non-obvious design decisions: the wire form is matched with a **sticky, anchored** regex (`/…/uy`) at each `@` position, so a wire reference inside a path is not mis-read. Among overlapping supplied labels the **longest** wins (`packages/client/ui-conversation/src/client/user-text/session-reference-rule.ts:31-37`).
- Edge cases / failure handling: the labels fact is read **once** per match call and only when needed (`readLabels` guard), so a document with no `@` never touches the fact.
- Surprising: the rule returns the *whole wire form* as the node's range but only the bracketed label as its data — the original text is preserved verbatim while the UI shows the friendly name.

### packages/client/ui-conversation/src/client/user-text/UserText.module.css
Twelve lines: `.root` is `display: contents` so the projection adds no block container to the inline flow, and `.ellipsis` is a block with a one-line ellipsis. The CSS is the whole reason the projection can decorate sent user text without changing layout.

### packages/client/ui-conversation/src/client/user-text/UserText.tsx
- Purpose: the presentation half of the user-text projection.
- Key abstractions: `UserText`; `PlainUserText`; `SessionReference`.
- Data flow: `useUserTextRevision` re-renders on a rule change; `createUserTextEvaluator` produces the nodes; each node is dispatched to the `conversation.user.text.node` slot with `entryKey: node.id`.
- Non-obvious design decisions: a **failed** parse retains the entire original text and reports the rule error (`packages/client/ui-conversation/src/client/user-text/UserText.tsx:12-14`) — the user never loses their words because a matcher failed. The fallback for a node with no registered renderer is the raw text slice (`packages/client/ui-conversation/src/client/user-text/UserText.tsx:41`).
- Edge cases / failure handling: the error is reported **once** per failure, in an effect keyed on the failure identity, so a re-render does not re-report.
- Surprising: the node id *is* the renderer key, so registering a renderer for `session` is what makes a Session chip appear — the framework never hard-codes a renderer per business type.

### packages/client/ui-conversation/src/client/user-text/whitespace-rules.ts
- Purpose: whitespace as ordinary Text-producing matching, on the same scheduler as every other rule.
- Key abstractions: `collapseWhitespaceRule` (order 1010); `trimWhitespaceRule` (order 1000).
- Data flow: each rule reads a boolean fact (`collapseWhitespace` / `trimWhitespace`) and, when set, offers a Text candidate carrying the *original* substring plus a display override.
- Non-obvious design decisions: trim's order (1000) is **below** collapse's (1010), so trim wins a same-start collision at the document's edges (`packages/client/ui-conversation/src/client/user-text/whitespace-rules.ts:25-26`). The collapse rule skips a search cursor that falls inside an already-matched run — "A search cursor inside an already matched run does not create a new original run" (`packages/client/ui-conversation/src/client/user-text/whitespace-rules.ts:17-18`).
- Edge cases / failure handling: the display override is a *display* string only; `data.text` is always the exact source substring, so the original coordinates and text survive the transform.
- Surprising: an empty display string *hides* the segment while an absent `display` renders the original — the difference between "remove this whitespace" and "show it as it is".

### packages/client/ui-conversation/src/client/view-selection.ts
- Purpose: resolve the preferred View, then Chat, and nothing else.
- Key abstractions: `DEFAULT_VIEW_ID = 'chat'`; `TRAJECTORY_VIEW_ID = 'trajectory'`; `resolveActiveView(tabs, selectedId)`.
- Data flow: the view ledger supplies the registered tabs; the store supplies the preference.
- Non-obvious design decisions: the function will **not** choose an arbitrary registered View — if Chat is not registered it returns `undefined` (`packages/client/ui-conversation/src/client/view-selection.ts:9-21`). The reason is in the README: "Only registered targets can render — the shell deliberately has no implicit fallback target beyond the registered `chat` preference."
- Edge cases / failure handling: a stored preference naming a View that is no longer registered falls back to Chat.
- Surprising: the Trajectory View's id is exported as a constant, which is how the developer-tools toggle can hide exactly that tab.

### packages/client/ui-conversation/src/css-modules.d.ts
Six lines: the ambient declaration for `*.module.css` (a `Record<string, string>`) and `*.css`. Boilerplate.

### packages/client/ui-conversation/src/index.ts
- Purpose: the **host** entry for the browser conversation preferences.
- Key abstractions: `Config` (a zod schema with a `volatile()` busy-Enter field); `apply(ctx)`.
- Data flow: `ctx.inject(['settings'], …)` calls `child.settings.configure({ auto: false }, ctx.fiber)` — the section is **not** auto-generated onto the Settings pages, because the Settings panel writes it through the composer bar's own row.
- Non-obvious design decisions: the field is `Volatile<BusyEnterBehavior>` — volatile means the durable value is projected to the browser but the browser's copy is not authoritative.
- Edge cases / failure handling: the host build covers only this file and `src/submission-settings.ts`, so the browser bundle never pulls the Host entry in.
- Surprising: `auto: false` is what keeps the key out of the generated Settings pages; the panel and the backend must agree on it manually.

### packages/client/ui-conversation/src/submission-settings.ts
- Purpose: the busy-Enter preference's durable schema.
- Key abstractions: `CONVERSATION_SETTINGS_NAMESPACE = 'ui-conversation'`; `BUSY_ENTER_FIELD = 'busyEnter'`; `BUSY_ENTER_BEHAVIORS`; `DEFAULT_BUSY_ENTER_BEHAVIOR = 'queue'`; `ConversationSettingsFields`/`Schema`.
- Data flow: the Host settings document stores the field; the browser scope validates against the same schema.
- Non-obvious design decisions: the default "preserves Enter-as-Queue for running conversations" (`packages/client/ui-conversation/src/submission-settings.ts:17-18`) — the conservative choice, since steering an unattended turn is a bigger surprise than queueing.
- Edge cases / failure handling: the schema is a `z.union` of the two behaviours with a default, so an absent field is valid and an unknown one is not.
- Surprising: the file is imported by *both* builds — the Host entry and the browser entry — so the two can never disagree about the field name or the accepted values.

### packages/client/ui-conversation/tests/apply-inject.client.spec.tsx
The largest apply-level spec (611 lines): it mounts the real plugin through `SlotTestRuntime`, stubs the file-upload service, the workspace service and the config forms, and then drives the injected session/header/resident faces. I read the first 130 lines (the bench, the fakes and the fixture wiring); the rest are the cases.

### packages/client/ui-conversation/tests/apply-wiring.client.spec.tsx
The apply-wiring contract: the Trajectory tab is hidden while developer tools are off, the plugin **waits for the layout-owned `main.conversation` declaration** before registering its subtree, both services are provided without installing Chat, the shell slots and the shared Conversation store are wired correctly, the View roster is cached and locale-aware, and disposing the fiber removes the services, entries and declarations.

### packages/client/ui-conversation/tests/assembly-surfaces.client.spec.tsx
Conversation assembly acceptance independent of Tool presentation: the real Slot runtime, a jsdom `Range` geometry stub, a `ResizeObserver` stub, the workspace-navigation service, and the check that a rejected prompt keeps the draft ("`prompt rejected before acceptance (session/agent-busy)`") and that one summary update re-labels the session crumb.

### packages/client/ui-conversation/tests/async-insertion.client.spec.ts
The late-insertion contract: an insertion beside an existing reference preserves the occurrences and undo ownership, and a result captured before a user edit (or after disposal) is refused — `expect(input.actions.insertText('late voice', span)).toBe(false)`.

### packages/client/ui-conversation/tests/composer-blocks.client.spec.ts
The block registry's publication rule: an identical reason republishes nothing, clearing removes the block, and `forget` drops the store.

### packages/client/ui-conversation/tests/config.host.spec.ts
The host entry's contract: the durable busy-Enter preference registers, validates (an invalid value rejects) and disposes, and the plugin keeps its own instance off the generated Settings pages.

### packages/client/ui-conversation/tests/context-meter.client.spec.tsx
The meter's contract: occupancy is computed only when numerator *and* capacity are known; nothing renders until both exist; the ring and the breakdown panel open and close on click; each locale owns the headline word order around the reading; and the panel closes on an outside pointerdown and on Escape — but not on an inside click.

### packages/client/ui-conversation/tests/control-row-dom.ts
Twelve lines: a jsdom `document.fonts` stub, because jsdom emits no font-loading events and the layout test drives its own measurements.

### packages/client/ui-conversation/tests/control-row-layout.client.spec.ts
The control row's measurement contract: it collapses on expanded demand and stays stable across repeated resize deliveries, it remeasures changed text while collapsed without a row resize, it accounts for inserted controls and hidden groups, and it remeasures after font loading and disconnects all notifications on dispose.

### packages/client/ui-conversation/tests/conversation-assembler.client.spec.ts
The largest spec in the shard (2,018 lines): the assembler's whole contract over synthetic Session events — matching, start/update ordering, dependency replay, exclusive claims, publication ranks, Location data, incremental append/prepend and window replacement. I read the first 120 lines (the fixtures, the test view builder and the tracked-view helper); the cases follow.

### packages/client/ui-conversation/tests/conversation-group-store.client.spec.ts
The group store's contract: a changed group publishes without changing root or member identities; equivalent snapshots are reused and parts are accepted in separate positions; and every malformed batch — absent removal, upsert-and-remove, missing Node — is **rejected atomically**, leaving the root array and the source snapshot untouched.

### packages/client/ui-conversation/tests/conversation-groups.client.spec.ts
Group Definition dispatch: the group's `update` consumes node changes rather than raw events, the builder is driven after the target's nodes are installed, and the group output is validated and installed before publication.

### packages/client/ui-conversation/tests/conversation-registry.client.spec.ts
The registry and binding contract over a real `MutableSessionEventSource`: duplicate keys throw, disposers are idempotent, the binding is identity-stable per Session Controller binding, and the assembly service does not open a second event source.

### packages/client/ui-conversation/tests/conversation-routing.client.spec.ts
Routing: mixed function-form and table-form Definitions are precomputed in registration order; a table's handlers are read **at registration** and only the candidates for the payload are invoked (the spec counts the table reads across 100 events); the fallback runs only when no Definition of its target matched; and a `replaceWindow` + 100 appends does not re-read the tables.

### packages/client/ui-conversation/tests/conversation-store.client.spec.ts
The store's persistence contract: per-session scoping, independent live instances, structured-reference round-trips, the legacy plain-string draft accepted without rewriting the record, and every unusable saved record (`null`, `42`, `"text"`, `[]`, `{}`, `{invalid`) ignored — with the draft and the view preference read **independently** of each other.

### packages/client/ui-conversation/tests/draft-document.client.spec.ts
Structured draft import, persistence and reference restoration through the real input shell (761 lines): the file/folder/session reference shapes, the goal claim, the chip and text-ref readers, and the real `SessionInputShell`. I read the first 100 lines (fixtures and the shell factory).

### packages/client/ui-conversation/tests/draft-hub.client.spec.ts
The hub's draft contract: a saved draft enters the model **before the first lookup returns**, the lexicon subscription follows the Session's own lifecycle (subscriptions and releases are counted), and the shell is released with its Session scope.

### packages/client/ui-conversation/tests/editor-focus.client.spec.ts
The selection-survival contract: the composer keeps its range *and* its caret while another control owns focus, survives a background editor reconciliation and a `SELECTION_CHANGE_COMMAND`, keeps background insertion and undo outside the editor until focus is restored, restores a pending selection when blur and explicit focus share one update batch, and removes the focus-preservation subscriptions on dispose.

### packages/client/ui-conversation/tests/enter-behavior-row.client.spec.tsx
The Settings row's contract: the description explains the busy-only scope over Enter *and* Send, Queue is the default, Steer can be selected, a later preference change is followed, and the menu closes on an outside pointerdown.

### packages/client/ui-conversation/tests/historical-images.client.spec.ts
The image cache's contract: a pending load whose Session binding is released **rejects** rather than resolving with a dead URL; a seeded preview shows synchronously, is replaced by the canonical bytes and both are revoked; a failed canonical read revokes the preview; and an unknown session refuses to seed.

### packages/client/ui-conversation/tests/history-transport.perf.client.ts
An opt-in synthetic benchmark (617 lines) for the v2 embedded Assistant stream history: 416,756 logical items, 416,176 stream members, 116 compact records. It measures the raw-versus-compact wire size, the loopback transfer, the client heap peak, the parse/validate/prepare/fold split, and asserts the compact form folds to the **same digest** as the raw form at the **same heap peak** — i.e. the compaction is lossless. I read lines 1-120 and 420-579.

### packages/client/ui-conversation/tests/image-labels.client.spec.ts
The attachment-rejection copy contract: megabytes render without a trailing fraction, user-solvable reasons name the limit and the way out, and unknown reasons *and* limit reasons without projected limits fold into one send-failed line carrying the reason code.

### packages/client/ui-conversation/tests/input-bar.client.spec.tsx
The largest composer spec (1,915 lines): Enter-send semantics (IME guard, Shift newline, busy-Enter policy, Ctrl/Meta steering, repeat suppression), running semantics, the machine pending lock, chip decorators, error banners, status strips and the focus-keeping mousedown. I read the first 120 lines (the header comment and the bench options).

### packages/client/ui-conversation/tests/input-matrix.client.spec.tsx
The impact matrix: what each phase projects onto the InputBar — enter routing, visuals (command chip, hint, pending), edit freedom, and the published currency's claim seat — over a real `SessionInputShell` and the real `InputBar`.

### packages/client/ui-conversation/tests/input-reference-submit.client.spec.ts
The reference-submit transaction: a chip's canonical text is mirrored so a persisted draft stays resolvable after a remount, and a chip is retained on a Host failure and cleared only after a later accepted retry.

### packages/client/ui-conversation/tests/input-scenarios.client.spec.tsx
Scenario-chain integration over the real per-session `InputTriggerController` pipeline, a real session scope, a real command source implementing the decision table's cells, and the real machine and InputBar. I read the first 100 lines (the scenario's decision-table source).

### packages/client/ui-conversation/tests/keymap-routing.client.spec.tsx
Keymap routing at the DOM boundary: the composition attribute is cleared on root swaps, Enter routes to the submit handler (plain and accelerated), **modified** Enter is left entirely to application commands (not submitted, not arbitrated, not prevented), and Tab is arbitrated with `tab`/`tabBack` where only Shift+Tab is the exit key.

### packages/client/ui-conversation/tests/lexical-editor-core.client.spec.tsx
The composer's pure core over headless editors (536 lines): the reference and command chip node semantics, the three projections and the detect-span application. I read the first 90 lines (the fixtures and the node reader).

### packages/client/ui-conversation/tests/queue-dock.client.spec.tsx
The queue dock's contract (783 lines): authoritative rows, inline editing, collapse state, removal, the Steer action, failure notices and live retirement. I read the first 90 lines (the fixtures and the live session source).

### packages/client/ui-conversation/tests/reference-activation.client.spec.ts
Composer clicks use the owning Lexical node while selection gestures remain editable: a chip and an editable skill reference both open without changing the draft content, a double-click opens once, and selections, invalid chips and ordinary text are left to the editor.

### packages/client/ui-conversation/tests/reference-chip.client.spec.tsx
The chip's visual face: the domain icon per appearance, the `@` marker fallback without one, the label truncation container, and the invalid styling bit.

### packages/client/ui-conversation/tests/request-inspection.client.spec.ts
The inspection contract: the first complete header is the initial prompt anchored at its system node; a header without a system node is anchored at itself; a **resume** header is suppressed when the earlier prompt is outside the loaded window; system, tools and combined changes are classified against the previous prompt; an emptied system prompt is a system change; and an in-history update the model already read is **not** a system change.

### packages/client/ui-conversation/tests/safari.client.spec.ts
Safari detection across seven identities (desktop/mobile Safari true; Chromium, Chrome on iOS, Edge on iOS, Opera on iOS and an Apple web view false), plus the layout recovery: nothing while there is no overflow, the stale layout is invalidated and the owned height restored (with the selection preserved), nothing outside the composer scrollport, and a null textarea during teardown is accepted.

### packages/client/ui-conversation/tests/selection-survival.client.spec.tsx
Conversation persistence through the real SlotRegistry store axis: the session body and header share one instance, sessions are isolated and keep their identity across list projection updates, and a released-and-removed session's persisted state is restored into a *new* instance.

### packages/client/ui-conversation/tests/service-orchestration.client.spec.ts
The `ConversationController` over the runtime's real scope tag (917 lines): a withdrawn generation is not revived when an old input submits before scoped cleanup, operations route through the public Session binding, business failures fold into rejections, and a QueueDock Steer pre-admission race resolves as converged delivery rather than an error. I read the first 120 lines.

### packages/client/ui-conversation/tests/skeleton.client.spec.tsx
The shell's acceptance suite (861 lines): the header, the content, the main panel, the session header, the hero, the InputBar and the phase transitions, over the real components with a `ResizeObserver` stub that records its targets. I read the first 100 lines (the fixtures and the observer harness).

### packages/client/ui-conversation/tests/stop-sequence.client.spec.ts
The double-Escape contract: two independent presses inside the configured interval, the inclusive interval endpoint, expiry, and the four ways a press must not combine — a session, turn, region or generation change.

### packages/client/ui-conversation/tests/stop-shortcut.client.spec.ts
The fixed stop routing: it cancels through the scoped `ConversationController` only after two presses, it refuses while a modal or an approval is open, it refuses a subagent that is not continuable, and it does not arm without a cancellable live turn or after disposal.

### packages/client/ui-conversation/tests/submission-policy.client.spec.ts
The policy contract: the full `resolveSubmitMode` truth table, the Queue default, the live publish that happens **before** the durable write, the Host adoption without a write-back, and an identical write left untouched.

### packages/client/ui-conversation/tests/submit-machine.client.spec.ts
The machine's contract (400 lines): enter routing, adjudication outcomes, the claimed lifecycle that follows the leading command chip, settlement (`commit-draft` and claim re-entry), anti-backwash and per-session isolation. I read the first 100 lines.

### packages/client/ui-conversation/tests/system-prompt.client.spec.ts
The surface-interpretation contract: the prompt is withheld until a missing prefix is loaded, a compaction shadow is restored while historical state stays valid, surface order wins over reversed chronological endpoints, later nonempty nodes stay authoritative over head rewrites, a cross-window replacement does not invent an unloaded head, shadowed endpoints are dropped without mutating the prefix, and an empty initial node is "no prompt".

### packages/client/ui-conversation/tests/todo-panel.client.spec.tsx
The plan strip's display contract: empty renders nothing, the panel starts collapsed with per-status counts, a zero-count segment is omitted, each row shows its status glyph with an accessible label, and a parallel plan (three `in_progress` at once) is handled.

### packages/client/ui-conversation/tests/user-text-component-fixture.client.tsx
A reusable fixture that binds the **production** evaluator and node components (session, skill, file, folder, goal-command, whitespace) without replacing the matching or display behaviour — so component units exercise the real rules.

### packages/client/ui-conversation/tests/user-text-reference-composition.client.spec.ts
Real business matchers composing by original position: an earlier complete file beats a Session label inside its path, an earlier complete file beats a wire Session inside its path, a quoted file is kept while only the outside skill is recognised, a suffix is never turned into a word boundary, and only the Skill matcher is re-queried after its Facts update.

### packages/client/ui-conversation/tests/user-text-registry.client.spec.ts
The registry's contract (311 lines): the tie-break order is start → order → code-unit ID, independent of load order; a Text candidate's raw value must match the original; nodes are readonly without freezing borrowed payloads; equivalent nested JSON is reused despite key order; invalid ranges and non-finite orders are rejected before publication; empty, reserved and duplicate IDs are rejected without changing the revision; and disposing a contributing fiber removes only that fiber's rules.

### packages/client/ui-conversation/tests/user-text-scheduling.client.spec.ts
The scheduler's contract, measured **by calls and query offsets, never clocks** (`packages/client/ui-conversation/tests/user-text-scheduling.client.spec.ts:1`): three rules over a 40-character text, asserting the exact sequence of `from` offsets each matcher is queried at, and that a Facts update re-queries only the matcher that read that Fact.

### packages/client/ui-conversation/tests/user-text-whitespace.client.spec.ts
The whitespace rules' contract: the switches are Facts, not React props; a missing switch is a cached no-match; edge collisions resolve in favour of trim; the raw substring is preserved in every Text candidate; a disabled switch reuses the competing query sequence; reference whitespace stays atomic; emoji and ZW sequences survive; and a long interior whitespace run does not change the source ranges.

### packages/client/ui-conversation/tests/user-text.client.spec.tsx
The inline projection's contract: the complete original text is retained and a cached matching failure is reported **once**, decoration adds no block containers, whitespace is preserved, and wire session forms fold to their label.

### packages/client/ui-conversation/tests/view-selection.client.spec.ts
The view resolution contract: the preferred registered View wins, an unregistered preference falls back to Chat, and the function does not choose an arbitrary registered View.

### packages/client/ui-conversation/tests/views-type-chain.client.spec.tsx
The View ring's type chain: four compile-time negative samples (a list registration needs `id`; `key` belongs to keyed slots; a component cannot demand a prop no share supplies; views receive no `renderSlot`) and the runtime ledger projection (order-sorted entries, a label fallback for a labelless rider, and a duplicate id failing loud at load).

### packages/client/ui-conversation/tests/width-handle-styles.client.spec.ts
A stylesheet-level gate that reads `ConversationRoot.module.css` as text: the gutter hit target stays `min(10px, …)`, the hover indicator is a 2px bar in the resting scrollbar tint (not the hover tint) centred on the captured pointer's Y, and the indicator rises above the composer once a drag begins.

### packages/client/ui-conversation/tsconfig.client.json
The browser build's project: `rootDir: src`, `outDir: lib/types`, **32** project references (schemastery, the three api controllers, attachment, brand, cordis, seven ui-* packages, the core agent/session, commands, llm, llm-retry, workspace, token-meter, plan-mode, goal, tool-todo, locale, ui-settings, crypto, values, workspace-path, settings, file-reference, shortcuts and product-analytics), and `exclude: ["src/index.ts"]` so the Host entry stays out of the browser build.

### packages/client/ui-conversation/tsconfig.host.json
The Host build covers only `src/submission-settings.ts` and `src/index.ts`, and references only cordis, schemastery and the settings package. The two-file surface is what keeps the browser bundle from pulling in the Host entry.

### packages/client/ui-conversation/tsconfig.json
An eleven-line solution file referencing the host and client projects, with no files of its own.

### packages/client/ui-conversation/tsdown.config.ts
Three lines: `clientBundle(import.meta.dirname, ['lib/types/index.js'])` — the shared client bundler plus the type entry as the extra output.

### packages/client/ui-tool/locale/en.json
One-key locale manifest: `meta.title: "ui-tool"`. The tool cards' copy lives in the conversation namespace, not here.

### packages/client/ui-tool/locale/zh.json
Chinese manifest: `meta.title` is "工具调用展示" plus a description naming the nested-call and per-tool result views.

### packages/client/ui-tool/package.json
v0.2.1-rc.2. `dsh.client.inject` names four services (api-workspace-controller, client-connection, client-locale, client-ui-conversation), `platform: "web"`. The dev dependencies are the interesting part: `dsh-tool-jobs`, `dsh-tool-session-query`, `dsh-tool-terminal`, `dsh-ptc-runtime`, `dsh-spill-policy` and `dsh-user-questions` — the *producers* whose rendered output this package parses.

### packages/client/ui-tool/README.i18n.yaml
Per-heading bilingual hash record for the ui-tool README, with the same `pnpm run verify-translation-pairing --write` regeneration command (line 4). The ui-tool record has more headings than ui-conversation's because it has a "Built-in views" section.

### packages/client/ui-tool/README.md
The package reference (149 lines): the rendering contract, how a business package registers a keyed tool view, the built-in views, the "Model Experience" section, and the known limitations. The key architectural statement is in the summary: business UI packages "do not pair Session events, rebuild the transcript, or own root/subcall topology, because the Runtime remains authoritative for call/result pairing, lifecycle, and recursive `subCalls` projection." I read lines 1-120.

### packages/client/ui-tool/README.zh.md
The Chinese counterpart of the same reference. I read its first 60 lines (overview, use, registering a business tool view, built-in views); the rest mirrors the English file.

### packages/client/ui-tool/src/client/apply.ts
- Purpose: register the Tool call tree, the details renderer and the built-in atomic views.
- Key abstractions: `inject = ['slots', 'remote']`; the `toolInject` face carrying `hostInfo`.
- Data flow: `ctx.slots.inject('conversation.chat.node', …)` registers `ToolCallTree` under the key `tool-call` with the child slot `tool.call.toolview`; then nine atomic toolviews are mounted as plugins (`packages/client/ui-tool/src/client/apply.ts:44-52`).
- Non-obvious design decisions: the `hostInfo` face is an `ObservableSnapshot` over `ctx.remote.$host` that re-reads on `connection/reset` (`packages/client/ui-tool/src/client/apply.ts:29-33`) — the Host's home directory is needed for POSIX `~` display, and it must survive a reconnect.
- Edge cases / failure handling: the tree entry declares `children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } }`, so the keyed hole is session-scoped and the tree owns it.
- Surprising: the plugin mounts the *bash* toolview as "the standalone Bash conversation-row sample" — it is a real registered view, not a demo, and it is what makes `bash` a keyed hit rather than a generic row.

### packages/client/ui-tool/src/client/contract/slots.ts
- Purpose: the Tool UI slot declarations and their composed props.
- Key abstractions: the `SlotMap` merge for `tool.call.toolview` (keyed, session-scoped) and `tool.call.images` (single, session-scoped); `ToolCallCommonProps`; `ToolCallPhaseProps`; `ToolCallOwnerProps`; `UserQuestionRecord`; `UserQuestionPanels`; `ToolHostInfoInjected`.
- Data flow: the tree dispatches each atomic call to `tool.call.toolview` with `entryKey: toolName`; the owning view renders durable images through the `tool.call.images` child slot.
- Non-obvious design decisions: the `tool.call.images` slot's doc comment (`packages/client/ui-tool/src/client/contract/slots.ts:32-43`) is the design in prose: "The Tool layer never imports an attachment implementation: a toolview declares this slot as a child and renders it with the image card's references plus the session-authorized loader it received in its owner, and the attachment plugin fills the gallery. Composing no attachment presentation plugin renders nothing, which is why the image card keeps its own envelope text beside the gallery. A child slot is declared by exactly one entry: registering a second toolview that declares the same child **throws at load**."
- Edge cases / failure handling: the host facts are reached through a **hook** rather than injected as values, because "the renderer memoizes an entry's inject result for the registration's lifetime, so facts read there would freeze at whatever the first render saw" (`packages/client/ui-tool/src/client/contract/slots.ts:143-149`).
- Surprising: the phase discriminant is the only way to tell a preparing call from a started one, and `preparing` deliberately has **no** `argsRaw` — the type chain forbids it (pinned by `tests/toolview-type-chain.client.spec.tsx`).

### packages/client/ui-tool/src/client/index.ts
Six lines: the browser Tool plugin's public surface — `apply`/`inject` and the slot type exports. Boilerplate.

### packages/client/ui-tool/src/client/locale.ts
Two lines: `CONVERSATION_NS = 'conversation'` — the Tool package borrows the *conversation's* locale namespace, because the tool cards' copy is the conversation's copy.

### packages/client/ui-tool/src/client/tool/components/AskQuestionCard.module.css
The ask-user transcript card's geometry: a 360px-max scrolling card on the base surface, question text in the tertiary tone and answers in the primary tone, each answer on its own line, and a skipped answer in the tertiary tone.

### packages/client/ui-tool/src/client/tool/components/AskQuestionCard.tsx
- Purpose: render a validated ask-user transcript from plain card data.
- Key abstractions: `AskQuestionCard({ card })`; the `AskQuestionCardModel` union.
- Data flow: the model is already validated and localized; the card renders it.
- Non-obvious design decisions: the two shapes render differently — an **unanswered** card is a paragraph plus a bulleted list, while an **answered** card is a `<dl>` of question/answer pairs (`packages/client/ui-tool/src/client/tool/components/AskQuestionCard.tsx:12-38`). A question with no answers renders the skipped label rather than an empty `<dd>`.
- Edge cases / failure handling: none — the model is pre-validated, so this component cannot fail.
- Surprising: the component is a pure renderer with no props beyond the card; the pairing logic lives in the model layer.

### packages/client/ui-tool/src/client/tool/components/ExitCodeBadge.module.css
Fourteen lines: the capsule's 8px left margin, 5px gap, and a 4px red dot.

### packages/client/ui-tool/src/client/tool/components/ExitCodeBadge.tsx
- Purpose: the inline exit status for a settled command.
- Key abstractions: `ExitCodeBadge({ label })`.
- Data flow: `terminalExitLabel` produces the localized label; the badge renders it in a neutral `Tag` with a red dot.
- Non-obvious design decisions: the badge is **neutral** in tone while the dot is the error colour — the capsule is a fact, not an alarm, and the README says it "displays only the recorded code, signal, or localized missing-code status and stays on the same line".
- Edge cases / failure handling: it is rendered only for a settled foreground failure with a nonzero exit code, a terminating signal, or an explicit missing exit code; running, successful and background calls omit it.
- Surprising: the same badge is used for a *missing* exit code, so "no exit code" is a visible fact rather than a silence.

### packages/client/ui-tool/src/client/tool/components/QuestionToolRow.module.css
The question row's panel button: a floating-fill pill, 22px tall, with the label at one step under the body tier. Hover swaps to the floating-hover token.

### packages/client/ui-tool/src/client/tool/components/QuestionToolRow.tsx
- Purpose: the question-owned summary action and transcript disclosure.
- Key abstractions: `QuestionToolRowProps` (a `Pick` of `ToolRowProps` plus `openPanel` and `panelLabel`).
- Data flow: the row composes the shared `DisclosureRow` chrome but owns its own action button.
- Non-obvious design decisions: the panel button stops propagation on both click and keydown (`packages/client/ui-tool/src/client/tool/components/QuestionToolRow.tsx:39-43`) so pressing it does not also toggle the disclosure. The button's label and behaviour are **question-owned** — "The generic `ToolRow` does not select or dispatch question actions" (per the README).
- Edge cases / failure handling: if the panel provider refuses the action, the click falls back to toggling the row open, so the transcript is still reachable.
- Surprising: the row renders the ask-question card *instead of* the IN/OUT text sections when one exists — the two are mutually exclusive.

### packages/client/ui-tool/src/client/tool/components/ToolDetails.module.css
The compact detail body's geometry (256 lines): a 320px-max scrolling list, a 5.5em/1fr field grid, a 88px right inset reserved for the row's Inspect button, and per-change colours (added green, removed error with a line-through). The `[data-inspect]:not([data-caption])` selectors reserve the Inspect space only when there is no caption, so the caption row does not waste it.

### packages/client/ui-tool/src/client/tool/components/ToolDetails.tsx
- Purpose: the compact, read-only field and list renderer for recorded tool results.
- Key abstractions: `ToolDetailItem`; `ToolDetailsModel { items, summary, expandedSummary, empty, caption, unchanged }`.
- Data flow: the model supplies already-localized items; the component renders them, recursing through `groups` and offering `<details>` disclosures.
- Non-obvious design decisions: an item with a `location` becomes a **button** that opens the file (`packages/client/ui-tool/src/client/tool/components/ToolDetails.tsx:58-62`) — the recorded path is navigable, not merely readable. A `status` item renders a decorative glyph with the accessible label, and a `change` overrides the glyph with `+`/`−` and its own label (`packages/client/ui-tool/src/client/tool/components/ToolDetails.tsx:50-56`).
- Edge cases / failure handling: an empty list renders the model's `empty` label rather than nothing; the `unchanged` bucket is a separate collapsed disclosure below the list.
- Surprising: the model is *fully localized before it reaches the component* — the component contains no locale lookups beyond the shared Markdown/code labels, so the same model renders in any language.

### packages/client/ui-tool/src/client/tool/components/ToolRow.module.css
The tool summary row's type scale (322 lines): a 24px single line of `[16 leading] gap6 [title 13/24] gap8 [2x2 dot] gap8 [summary FILL truncate]`. Load-bearing: `.summarySuffix` is `flex: none` with `white-space: nowrap` and **no** `text-overflow: ellipsis` — "a clipped count reads as a smaller number rather than as missing information" (`packages/client/ui-tool/src/client/tool/components/ToolRow.module.css:45-56`). The diff totals use the code font at 2px under the secondary tier with a half-pixel `translateY` nudge.

### packages/client/ui-tool/src/client/tool/components/ToolRow.tsx
- Purpose: the single-line summary row that every tool card shares.
- Key abstractions: `ToolRowProps`; the seven mutually exclusive card slots (`askQuestion`, `terminal`, `diff`, `read`, `image`, `search`, `web`) plus `details`.
- Data flow: the row derives the collapsed content from the title, summary, suffix and error summary, and the expanded body from the card slot (or the IN/OUT text sections).
- Non-obvious design decisions: the card slots are **mutually exclusive** — the first non-null wins (`packages/client/ui-tool/src/client/tool/components/ToolRow.tsx:173`) — so a row can never show a diff and a terminal at once. The `summarySuffix` renders *outside* the ellipsized summary text "so a narrow row clips the summary before this" (`packages/client/ui-tool/src/client/tool/components/ToolRow.tsx:41-47`). The whole summary row is the expand toggle (`expandOnRowClick`), and `keepContentWhenOpen` keeps the body mounted.
- Edge cases / failure handling: error and stopped rows omit both the suffix and the diff totals; a `visuallyHidden` span carries the run state for assistive technology because "the business icon and animated text treatment do not name the state".
- Surprising: the row is one component for every tool — the *tool* difference lives entirely in the card model, not in the row's structure.

### packages/client/ui-tool/src/client/tool/models/ask-question-card-model.ts
Twenty-five lines: the two shapes of the ask-user transcript card (`answered` with per-question answers and a skipped label, `unanswered` with a verdict). The types are locale-neutral and already validated; the presenter localizes them.

### packages/client/ui-tool/src/client/tool/models/auto-review-denial.ts
- Purpose: the localized copy that replaces ordinary failed-call output for an Auto denial.
- Key abstractions: `AutoReviewDenialPresentation { summary, output }`; `normalizeAutoReviewReason`; `localizeAutoReviewDenial`.
- Data flow: the durable error's `reason` is normalized to a single line and used as the expanded "not executed" line; the collapsed summary is the localized "Rejected by Auto review".
- Non-obvious design decisions: only the **user-visible copy** is normalized; "the durable error keeps the raw reason" (`packages/client/ui-tool/src/client/tool/models/auto-review-denial.ts:11`). The normalization collapses CR/LF/U+2028/U+2029 to a space and trims.
- Edge cases / failure handling: a `null` or blank reason falls back to a localized "Auto review did not authorize this action" line rather than an empty body.
- Surprising: the denial is presented as a *rejection*, not an error — the wording says the tool was not executed rather than that it failed.

### packages/client/ui-tool/src/client/tool/models/control-details-model.ts
- Purpose: entity lists and receipts for the agent, job, terminal and language-server tools.
- Key abstractions: `agentList`; `jobList`; `terminalList`; `receipt`; the per-tool receipt parsers.
- Data flow: the recorded *text* output of a control tool is parsed with a per-tool regular expression into a list of detail items.
- Non-obvious design decisions: each parser is a strict anchored regex (`packages/client/ui-tool/src/client/tool/models/control-details-model.ts:27`, `packages/client/ui-tool/src/client/tool/models/control-details-model.ts:47`, `packages/client/ui-tool/src/client/tool/models/control-details-model.ts:60`) and a line that does not match **declines the whole model** (returns `null`) rather than rendering a partial list — a half-parsed agent table is worse than the generic row. The receipts are matched against **exact** strings (`packages/client/ui-tool/src/client/tool/models/control-details-model.ts:194-195`: `closed terminal session ${target}`).
- Edge cases / failure handling: the literal `(no subagents)`, `(no background jobs)` and `(no terminal sessions)` are recognised as the empty case and produce an empty list with a count of 0.
- Surprising: the parsers are written against the *producers'* own wording — `dsh-tool-jobs`, `dsh-tool-session-query` and `dsh-tool-terminal` all have their own `render` helpers, and this file re-parses their output. That coupling is deliberate (the README says "uses producer wording for agent, job, terminal, and LSP lists") and is a known fragility.

### packages/client/ui-tool/src/client/tool/models/detail-model-shared.ts
- Purpose: the recorded-value formatting shared by entity lists and inspection results.
- Key abstractions: `detailRecord`; `nonempty`; `detailJson`; `detailBadge`; `inspectionItems`; `detailList`.
- Data flow: a tool's result text is JSON-decoded, narrowed and rendered as a list of detail items.
- Non-obvious design decisions: `detailJson` (`packages/client/ui-tool/src/client/tool/models/detail-model-shared.ts:33-39`) decodes "an entire JSON result without accepting a partial prefix" — a trailing-comma or truncated payload yields `undefined` rather than a partial object, and text receipts are left to their tool-specific adapters. `detailBadge` (`packages/client/ui-tool/src/client/tool/models/detail-model-shared.ts:57-64`) maps a recorded status onto a localized label and a **static** semantic colour, with the stated reason: "A badge that does not imply a live subscription."
- Edge cases / failure handling: an unknown status is retained **verbatim** with a neutral tone (`packages/client/ui-tool/src/client/tool/models/detail-model-shared.ts:63`), so a new producer's status is shown rather than hidden.
- Surprising: `STATUS_KEYS` folds synonyms (`error`/`failed`, `complete`/`completed`/`done`) onto one key, so the badge vocabulary does not grow with every producer's spelling.

### packages/client/ui-tool/src/client/tool/models/details-card-model.ts
- Purpose: the recorded todo, goal and schedule values for the compact detail body.
- Key abstractions: `todosDetail`; `goalDetail`; `scheduleItem`; `detailsCardModel`.
- Data flow: a tool's JSON result is validated field by field into a `ToolDetailsModel`.
- Non-obvious design decisions: every field is validated and a single bad field **declines the whole model** (`packages/client/ui-tool/src/client/tool/models/details-card-model.ts:52-54`, `packages/client/ui-tool/src/client/tool/models/details-card-model.ts:62-64`) — a goal with an unknown phase or a malformed blocker is not rendered half-confident. `todosDetail` refuses a **duplicate** todo title (`packages/client/ui-tool/src/client/tool/models/details-card-model.ts:42-43`).
- Edge cases / failure handling: `formatDate` (`packages/client/ui-tool/src/client/tool/models/details-card-model.ts:17-25`) catches an `Intl.DateTimeFormat` failure and falls back to the raw string, so an unusual locale cannot break the card.
- Surprising: the goal card shows the activation state as a *status* — "Awaiting continuation" for an active-but-disarmed goal — because the round budget is a different fact from the goal's phase.

### packages/client/ui-tool/src/client/tool/models/diff-card-model.ts
- Purpose: the diff-card derivation from raw file-mutation calls and result metadata.
- Key abstractions: `CHAT_DIFF_MAX_LINES = 9`; `DiffCardModel`; `intendedDiff`; `appliedDiffs`; `narrowDiffs`; `diffCardModel`.
- Data flow: a running call's diff comes from its **arguments**; a settled call's diff comes from the persisted `meta.diffs`, falling back to the argument-derived whole-file diff.
- Non-obvious design decisions: `intendedDiff` (`packages/client/ui-tool/src/client/tool/models/diff-card-model.ts:45-81`) understands three tools with three different argument shapes — `write` (`content`), `edit` (`old_string`/`new_string`/`replace_all`) and `str_replace_editor` (`create`/`str_replace`). The applied diff's path is **replaced with the authored argument path** when they differ (`packages/client/ui-tool/src/client/tool/models/diff-card-model.ts:112`), so the card shows the label the user typed while the metadata's absolute path stays available for navigation.
- Edge cases / failure handling: a nested call (`parentCallId !== undefined`) returns `null`; an errored call returns `null`; a `str_replace_editor` settled call returns `null` because it has no result view; a `write` with valid empty metadata uses its argument-derived whole-file diff "matching create and identical-overwrite presentation".
- Surprising: `narrowDiffs` validates the whole array before returning any of it — one malformed hunk declines the entire card.

### packages/client/ui-tool/src/client/tool/models/image-card-model.ts
- Purpose: the image-card derivation from raw result content and metadata.
- Key abstractions: `ImageCardModel { path, images, extraText }`; `IMAGE_ENVELOPE`; `IMAGE_MEDIA_TYPES`; `imageCardModel`.
- Data flow: the settled result's content is matched against the `read_image` envelope, the image blocks are collected, and the path comes from the persisted `presentationMeta` (or the call's own `file_path` for a nested call).
- Non-obvious design decisions: the attachment reference deliberately does **not** come from the metadata: "The settled `content` already carries the image block with its complete reference, so reading the reference from `meta` too would keep two copies of one fact — and a `tools/post-execute` hook that legitimately replaces the result content would leave the stale `meta` copy behind, showing an image the result no longer returns" (`packages/client/ui-tool/src/client/tool/models/image-card-model.ts:37-43`). The media-type set is a **hand-written mirror** of `ImageMediaType` "because … feature plugins must not import values from each other" (`packages/client/ui-tool/src/client/tool/models/image-card-model.ts:60-67`).
- Edge cases / failure handling: `fullyRendered(block.content)` (`packages/client/ui-tool/src/client/tool/models/image-card-model.ts:211`) — "The card renders only text and image blocks; a block of any other type must not be silently hidden, so the whole card declines to the generic form." A result without the envelope is not a well-formed image read and declines.
- Surprising: `extraText` collects text blocks *other* than the envelope — for example a post-execute hook's appended text — and the envelope itself is not repeated, because its path and image facts are already the card's.

### packages/client/ui-tool/src/client/tool/models/inspection-details-model.ts
- Purpose: runtime inspection, session queries and workflow reports read from recorded text.
- Key abstractions: `cordisDetails`; `workflowDetails`; `searchDetails`; `eventReadDetails`; `traceDetails`; `inspectionDetails`.
- Data flow: a tool's recorded output is parsed per tool family into a `ToolDetailsModel`.
- Non-obvious design decisions: `inspectionDetails` **declines when the output carries a spill notice** (`packages/client/ui-tool/src/client/tool/models/inspection-details-model.ts:165`) — a truncated result must not be presented as a complete list. The `workflow` parser expects an exact report shape and a `ralph` report expects the `Final report:` separator, with the header's prefix deciding the badge (completion / blocker / limit) — and a header that matches none of the three declines entirely (`packages/client/ui-tool/src/client/tool/models/inspection-details-model.ts:58-64`).
- Edge cases / failure handling: the report's `evidence` and `nextSteps` must be arrays of strings and `blocker` must be a string, or the model declines.
- Surprising: the workflow card embeds the **script source** as a code group when `args.code` is present, so the reader sees the program that produced the report.

### packages/client/ui-tool/src/client/tool/models/primitive-labels.ts
- Purpose: the localized copy adapters for the Cordis-free UI primitives the tool cards compose.
- Key abstractions: `codeToolbarLabels`; `markdownLabels`; `diffBlockLabels`; `readBlockLabels`; `searchBlockLabels`; `webBlockLabels`.
- Data flow: each function maps the conversation locale seat onto a primitive's label interface.
- Non-obvious design decisions: the search labels choose between a truncated and a non-truncated summary *at call time* (`packages/client/ui-tool/src/client/tool/models/primitive-labels.ts:78-85`) so the "showing N of M" form only appears when something was actually dropped.
- Edge cases / failure handling: none; every label is a pure function of the translator.
- Surprising: the primitives live in a different package that has no locale of its own, so this file is the whole i18n seam between them.

### packages/client/ui-tool/src/client/tool/models/raw-tool-call.ts
- Purpose: the shared narrowing for raw tool call and result fields.
- Key abstractions: `ParsedToolCall`; `parsedToolCall(block)`; `singleResultText(block)`.
- Data flow: a tool block's `argsRaw` is JSON-parsed once and cached.
- Non-obvious design decisions: the parse is **memoised per block in a `WeakMap`** (`packages/client/ui-tool/src/client/tool/models/raw-tool-call.ts:11`), so a card that is derived several times parses once. A null or non-object parse caches `null` too, so the failure path is also memoised (`packages/client/ui-tool/src/client/tool/models/raw-tool-call.ts:20-21`).
- Edge cases / failure handling: a preparing call returns `null` without parsing (`packages/client/ui-tool/src/client/tool/models/raw-tool-call.ts:19`); malformed JSON, an array and a non-object all yield `null` rather than a partial argument set. `singleResultText` demands **exactly one** text block — "the exact single text block consumed by first-party card derivations" (`packages/client/ui-tool/src/client/tool/models/raw-tool-call.ts:44-47`).
- Surprising: the memo is a `WeakMap` keyed on the *block*, so a settled block's parse is reused across the summary, the card and the details panel without a shared cache.

### packages/client/ui-tool/src/client/tool/models/read-card-model.ts
- Purpose: the read-card derivation from raw result content and metadata.
- Key abstractions: `CHAT_READ_MAX_LINES = 8`; `ReadCardModel` (a `Pick` of `ReadBlockProps`); `ReadMeta`; `validReadCall`; `readMeta`; `readCallLine`; `readCardModel`.
- Data flow: a settled root `read` call's persisted `meta` (path, offset, windowed lines, total line count, optional language) plus the model-facing read envelope become a `ReadBlock` projection.
- Non-obvious design decisions: the chat row's resident body shows **8** lines before collapsing the middle — "half the primitive's own default, which the details panel keeps. A chat row is a summary surface inside the message flow: the flow must stay scannable across many calls, while the details panel is the single-call reading surface. A design constant of this UI's row geometry, not a deployment choice, so it is fixed here rather than a plugin Config field" (`packages/client/ui-tool/src/client/tool/models/read-card-model.ts:8-16`). The same split draws for terminal output.
- Edge cases / failure handling: `readMeta` validates the whole window before returning any of it — the line numbers must be strictly increasing, at least 1, and within `totalLines` (`packages/client/ui-tool/src/client/tool/models/read-card-model.ts:49-72`). The card declines for a nested call, a running call, an error, an invalid call, invalid metadata, a missing result text, or a result that is not the read envelope (`packages/client/ui-tool/src/client/tool/models/read-card-model.ts:105-112`).
- Surprising: `readCallLine` (`packages/client/ui-tool/src/client/tool/models/read-card-model.ts:85-89`) reads the line the call named from the **arguments**, not the metadata — "Available while the call is still running, unlike the persisted metadata, because the arguments carry it." The arguments are model-produced JSON, so only an integer of at least 1 counts as a line.

### packages/client/ui-tool/src/client/tool/models/recorded-path.ts
Fourteen lines: read one absolute location from opaque persisted result metadata. `recordedAbsolutePath(meta, 'path' | 'cwd')` returns `undefined` for old or malformed metadata and requires `isAbsoluteWorkspacePath` — so a relative path persisted by an older producer is not shown as an absolute one.

### packages/client/ui-tool/src/client/tool/models/search-card-model.ts
- Purpose: the search-card derivation from raw grep/glob result metadata.
- Key abstractions: `CHAT_SEARCH_MAX_LINES = 8`; `SearchCardModel { card, recovery }`; `validSearchCall`; `validInclude`; `searchFiles`; `searchCardModel`.
- Data flow: a settled root grep/glob call's persisted `meta` becomes a matches or paths card.
- Non-obvious design decisions: `validInclude` (`packages/client/ui-tool/src/client/tool/models/search-card-model.ts:38-47`) rejects an `!`-prefixed include and an include with a **top-level comma**, while allowing nested braces — the include grammar is a glob, not a comma list. The `recovery` text (the "full result stored at spill://…" locator) is surfaced **only when the metadata says the card was capped** (`packages/client/ui-tool/src/client/tool/models/search-card-model.ts:91`).
- Edge cases / failure handling: the card declines for a running call, a missing call, an error, malformed args, an unrelated tool, a nested call, and a metadata `shape` that does not match the tool.
- Surprising: an unknown argument (`extension`) is **accepted** — the validator checks the fields it knows and ignores the rest, so a producer can add an argument without breaking the card.

### packages/client/ui-tool/src/client/tool/models/terminal-card-model.ts
- Purpose: the terminal-card derivation from raw tool call and result fields.
- Key abstractions: `terminalBlockLabels(t)`; `TerminalCardModel`; `localizeTerminalCardModel`; `terminalCardModel`; `terminalFailed`; `terminalExitLabel`; `isSpilledShellCall`; `isSettledPersistentShellCall`; `isBackgroundShellCall`; `parseExitStatus`.
- Data flow: a shell or `terminal_send` call's arguments and result text become a `TerminalBlock` projection.
- Non-obvious design decisions: the model is **locale-neutral** and the render site supplies the locale: `localizeTerminalCardModel` resolves the `terminal_send` copy while "preserving Tool-authored shell commands and descriptions verbatim" (`packages/client/ui-tool/src/client/tool/models/terminal-card-model.ts:63-64`). A shell command is never localized; only the Host's own terminal-send copy is.
- Edge cases / failure handling: an errored call, a settled *persistent* shell call, and a **spilled** shell call all return `null` so the row falls back to the generic IN/OUT presentation (`packages/client/ui-tool/src/client/tool/models/terminal-card-model.ts:343`). The reason for the persistent case is in the README: "reset and partial output diagnostics do not necessarily describe a single process's exit status".
- Surprising: `parseExitStatus` reads the exit code out of the *result text* (`\n[exit code: N]`), so a failing command that settled `isError: false` still shows a failure — the card is the error signal, not the tool's own error flag.

### packages/client/ui-tool/src/client/tool/models/todo-diff-model.ts
- Purpose: the todo changes relative to the preceding recorded write.
- Key abstractions: `todoDiffModel(block, baseline, hasMore, t)`.
- Data flow: the current `todo_write` call's args are compared with the recorded predecessor list.
- Non-obvious design decisions: when the baseline is unknown **and** older history may hold one, the model returns the current list with the caption "Previous list unavailable" and **no** summary (`packages/client/ui-tool/src/client/tool/models/todo-diff-model.ts:30-32`) — it does not claim "3 added" against a list it never saw. A reordering is detected by comparing each retained title's *position* (`packages/client/ui-tool/src/client/tool/models/todo-diff-model.ts:35`, `packages/client/ui-tool/src/client/tool/models/todo-diff-model.ts:48`), so an insertion does not read as a reorder.
- Edge cases / failure handling: an errored call returns `null`; a non-`todo_write` call returns `null`; an unchanged list yields the "no changes" summary and an `unchanged` bucket.
- Surprising: a status change and a *move* are both labelled "updated", with different labels for the two cases — the diff reports what the user can act on rather than the internal distinction.

### packages/client/ui-tool/src/client/tool/models/todo-history.ts
- Purpose: the indexed recorded todo predecessors for root and nested tool calls.
- Key abstractions: `TodoBaseline`; `TodoHistory`; `todoWriteDefinition`; `todoCallDefinition`; `todoHistoryView`; `registerTodoHistory(ctx)`.
- Data flow: a `todo/write` event is indexed as one node; a `todo/call` or `tool/ptc-dispatch-start` for `todo_write` becomes a *call* node whose start reads the **previous** write's state; the view publishes a lookup map from call id to baseline.
- Non-obvious design decisions: the predecessor is read through the assembler's dependency mechanism (`reader.previous<readonly TodoItem[]>('tool-todo-write')`), so "Invocation predecessors are repaired by the assembler when older history arrives" (`packages/client/ui-tool/src/client/tool/models/todo-history.ts:38`) — a prepend repairs the diff rather than orphaning it. The view's `apply` copies the map before mutating, so an earlier snapshot stays a valid reader.
- Edge cases / failure handling: `publication: () => 'none'` on the write definition — the write index is not a visible node, it exists only to feed the call index.
- Surprising: a *nested* dispatch (`tool/ptc-dispatch-start`) gets its own baseline, keyed by the sub-call id, so a `run_code` that dispatches `todo_write` still gets a correct diff.

### packages/client/ui-tool/src/client/tool/models/tool-call-model.ts
- Purpose: the pure row-model derivation for tool summary rows.
- Key abstractions: `ToolRowVariant` (`search` | `read` | `bash` | `write` | `edit` | `code` | `others`); `ToolRowState` (`preparing` | `running` | `ok` | `error` | `stopped`); `AutoReviewDenial`; `VARIANT_TITLE_KEYS`; `TOOL_VARIANTS`; `TOOL_TITLE_KEYS`; `classifyTool`; `toolTitleKey`; `formatToolBody`; `resultText`; `toolRowModel`.
- Data flow: the frozen call slice (phase, args, call head, result content, error) becomes a variant, a title key, a one-line summary, an expansion-time body, a flattened output and an error summary.
- Non-obvious design decisions: `cordis_define` is **deliberately absent** from the variant table: "ui-cordis registers a keyed `tool.call.toolview` entry for it, and a keyed hit REPLACES the generic row (this table is only reached through GenericToolCard, the dispatch fallback in ToolCallTree). An entry here would be unreachable, and a second title for the same call would be a second answer to a question the card already owns" (`packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:36-44`). The three Cordis run-control verbs map to `'others'` because "there is no program to show … and no file to open. The id lands in the summary slot, and the titles below name the act."
- Edge cases / failure handling: the empty string is "no text" for both derived result fields — "a settled call with blank content has nothing to expand, and a blank first line would erase the collapsed error row's summary slot" (`packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:322-325`). The path summary is relativised to the session cwd and then abbreviated to `~` for the Host home.
- Surprising: `read_image` is classified as `'read'` on purpose — "Left unclassified it falls to `others`, which titles the row generically and derives no filePath — so the path the row advertises as openable never is" (`packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:51-55`).

### packages/client/ui-tool/src/client/tool/models/web-card-model.ts
- Purpose: the web-card derivation from raw web result metadata.
- Key abstractions: `WebCardModelProps`; `validWebCall`; `webSources`; `webCardModel`; `webFetchHref`.
- Data flow: a settled root `web_search` or `web_fetch` call's metadata becomes a search or fetch card.
- Non-obvious design decisions: `webFetchHref` (`packages/client/ui-tool/src/client/tool/models/web-card-model.ts:89-99`) re-parses the **argument** URL and accepts only `http:` and `https:` — an unparsable URL "stays plain summary text", so a `file:` or `javascript:` argument can never become a clickable link.
- Edge cases / failure handling: the card declines for a running call, an error, a nested call, a missing `truncated` flag, a non-integer `statusCode`, or a source list with a malformed member.
- Surprising: the search card's `answer` is optional but the `sources` list is not — a search with no answer still shows its sources, and a search with a malformed source shows nothing.

### packages/client/ui-tool/src/client/tool/ToolCallTree.module.css
Twelve lines: the call row's radius, and the sub-call nest — a 22px left indent, an 8px padding and a 0.5px left rule, with a 4px gap between children.

### packages/client/ui-tool/src/client/tool/ToolCallTree.tsx
- Purpose: the root/subcall composition with one keyed atomic dispatch path.
- Key abstractions: `ToolCall`; `ToolCallBranch`; `ToolCallTree`; `toolCallPhase`; `callName`.
- Data flow: the tree's `node.data.root` is walked recursively; each atomic call is dispatched to `tool.call.toolview` with `entryKey: toolName` and a `GenericToolCard` fallback.
- Non-obvious design decisions: an **Auto-review denial bypasses the keyed dispatch entirely** (`packages/client/ui-tool/src/client/tool/ToolCallTree.tsx:50-55`) — the row renders the generic card directly, so a denial is never shown as a tool that ran. The stated reason in the README: the denial is a verdict, not a tool result.
- Edge cases / failure handling: a `preparing` call renders no sub-call nest, because there is nothing dispatched yet. The `owner` props are memoised on the call identity so a 100-sibling tree re-dispatches only the parent and the changed child.
- Surprising: `callName` reads the tool name from the *result's* paired call head when settled and from the block's own name when running — so a window-truncated call (no call head) dispatches under the empty name and falls back to the generic card.

### packages/client/ui-tool/src/client/tool/toolviews/ask-question-row.tsx
- Purpose: the `ask_user_question` conversation row.
- Key abstractions: `AnswerPresentation`; `answerEntries`; `queuedAnswerEntries`; `optionEntries`; `AskQuestionRow`; `askQuestionToolview`.
- Data flow: the questions come from the recorded call JSON; the answers come from the result, or from the `userQuestions` projection when a late reply settled the call, or from a pending steer mirrored by the Agent Inbox.
- Non-obvious design decisions: the panel verbs are read **per click, not per render** (`packages/client/ui-tool/src/client/tool/toolviews/ask-question-row.tsx:377-378`): "a composition with no question UI provides no panels, and the row then falls back to its own record." A late reply that is still awaiting admission is matched by its `kind: 'answer_to_pending_question'` and `callId` (`packages/client/ui-tool/src/client/tool/toolviews/ask-question-row.tsx:73`), so a reply to a *different* call is never picked up.
- Edge cases / failure handling: a malformed result yields the generic fallback rather than a half-built card; a call with no answers renders the skipped label; a cancelled or aborted call renders a verdict and invents nothing.
- Surprising: the row is the way back to a still-answerable call — "A timed `ask_user_question` call stays answerable after its result is recorded, and its panel can be closed, so the transcript row is the way back to it."

### packages/client/ui-tool/src/client/tool/toolviews/bash-sample.module.css
The Bash row's own sheet (246 lines) — and a candid TODO: "this bash header duplicates the DisclosureRow structure (and this is the **fourth copy of the glyph rule**, with DisclosureRow, MessageItem `.compactionLeading`, and MessageIconActions); migrating the bash row onto the shared DisclosureRow would collapse them to one" (`packages/client/ui-tool/src/client/tool/toolviews/bash-sample.module.css:124-129`). The sheet also carries the terminal card's 224px output cap and the hover-revealed Inspect pill.

### packages/client/ui-tool/src/client/tool/toolviews/bash-sample.tsx
- Purpose: the Bash/Pwsh conversation row with an expandable terminal card.
- Key abstractions: `BashRow`; `bashToolviewSample`; `stateStatus`.
- Data flow: the row derives the model, resolves the session cwd, builds the terminal model and localizes it, and renders the `TerminalBlock` inside the disclosure.
- Non-obvious design decisions: the row **fails the row on a nonzero exit** even though the call settled `isError: false` (`packages/client/ui-tool/src/client/tool/toolviews/bash-sample.tsx:54-57`): "Exit failures are result data even when the tool call itself succeeds." The generic IN/OUT fallback is retained for "failed or interrupted background launches … other execution failures, persistent results, and spill previews" (`packages/client/ui-tool/src/client/tool/toolviews/bash-sample.tsx:62-65`), so the original command and the full error remain available.
- Edge cases / failure handling: a background launch that failed keeps its raw input and output; the settlement is not dropped.
- Surprising: the row is registered under the key `bash` only, so `pwsh` falls to the generic row — the *model* maps `pwsh` to the bash variant, but the *view* is registered for `bash` alone.

### packages/client/ui-tool/src/client/tool/toolviews/details-row.tsx
- Purpose: the keyed recorded-result rows sharing the compact detail body.
- Key abstractions: `DetailsRow`; `detailIcon`; `LSP_TITLE_KEYS`; `TEAMMATE_TOOLS`; `detailsToolview`.
- Data flow: `detailsCardModel(block, t, locale)` produces the model; the row renders it and falls back to the generic input/output sections.
- Non-obvious design decisions: `detailIcon` (`packages/client/ui-tool/src/client/tool/toolviews/details-row.tsx:29-39`) recognises the **teammate-coordination** tools as a group (`spawn_teammate`, `list_agents`, `send_message`, `interrupt_agent`, `wait_agent`) and gives them one two-person icon. The LSP row's title is chosen from the *operation* argument, so `findReferences` and `hover` get their own titles.
- Edge cases / failure handling: an unregistered tool in this family falls to the generic agent icon; the row is registered for **37** tool names (`packages/client/ui-tool/src/client/tool/toolviews/details-row.tsx:80-117`).
- Surprising: the locale is read from `document.documentElement.lang` rather than from the translator, because the recorded dates are formatted with `Intl.DateTimeFormat` and need a real locale tag.

### packages/client/ui-tool/src/client/tool/toolviews/file-mutation-row.tsx
- Purpose: the write/edit row — the path and the decoded input size through preparation, execution and settlement.
- Key abstractions: `FileMutationRow`; `fileMutationToolview`; `contentKilobytes`; `CONTENT_FIELDS`.
- Data flow: the row derives the model, the diff and the decoded input size, and renders the size as a `summarySuffix`.
- Non-obvious design decisions: `contentKilobytes` (`packages/client/ui-tool/src/client/tool/toolviews/file-mutation-row.tsx:17-27`) measures the **decoded UTF-16 length** of the content fields, summing old and new text for an edit, and rounds *up* in units of 1024. The README is explicit: "N rounds the decoded input's UTF-16 length up in units of 1024 … it is **not file bytes**."
- Edge cases / failure handling: a field still streaming is measured with an offset so the count does not double-count the completed fields; before any content field arrives the size is `null` and the suffix is omitted.
- Surprising: one component is registered under **both** `edit` and `write` (`packages/client/ui-tool/src/client/tool/toolviews/file-mutation-row.tsx:64-67`), and the write/edit rows and the Bash row share their component across phases.

### packages/client/ui-tool/src/client/tool/toolviews/GenericToolCard.tsx
- Purpose: the generic fallback card — the row every unclaimed tool lands on.
- Key abstractions: `GenericToolCardProps`; `VARIANT_ICONS`.
- Data flow: the card derives the row model, the terminal/diff/read/search/web cards and the auto-review denial, and renders them through `ToolRow`.
- Non-obvious design decisions: the card **fails the row** when the terminal card reports a failure even though the model says `ok` (`packages/client/ui-tool/src/client/tool/toolviews/GenericToolCard.tsx:45-47`): "A failing exit status is the terminal card's own error signal (the call itself settles isError:false), surfaced through the row's error summary." Single-file tools never expose an args body — "the path link is the only args interaction" (`packages/client/ui-tool/src/client/tool/toolviews/GenericToolCard.tsx:58-61`).
- Edge cases / failure handling: the auto-review denial replaces both the output and the error summary with its own copy, so the raw error text is not shown as the tool's output.
- Surprising: the card derives *five* specialised models at once and hands them all to `ToolRow`, which picks the first non-null — so adding a new card type is a model change plus one prop, not a new component.

### packages/client/ui-tool/src/client/tool/toolviews/plan-summary.ts
- Purpose: the pure plan derivation for the `todo_write` row's one-line summary.
- Key abstractions: `PlanItemLike`; `PlanSummary { done, total, activeContent, activeExtra }`; `planSummary(todos)`.
- Data flow: the whole list is counted and the first `in_progress` item is named.
- Non-obvious design decisions: the summary is deliberately **not pre-joined** (`packages/client/ui-tool/src/client/tool/toolviews/plan-summary.ts:20-26`): "the row ellipsizes its summary text, and a count concatenated onto the end of the task name is the first thing a narrow row clips — exactly when it carries information." The count is returned separately so the row can render it in a non-shrinking span. Several items may be `in_progress` at once — "parallel work runs concurrent tasks, so a summary built from one active item would silently drop the rest."
- Edge cases / failure handling: `activeContent` is `null` when the first active item's content is missing, mistyped or blank after trimming — "the tool's own rule for usable content, applied here because a rejected call keeps its args verbatim" — and the counts are still shown.
- Surprising: this file deliberately stays inside the toolviews domain rather than moving to `contract/`, which is the inter-domain face.

### packages/client/ui-tool/src/client/tool/toolviews/read-family-row.tsx
- Purpose: the shared assembly for the read-family rows (`read`, `read_image`).
- Key abstractions: `ReadFamilyRowProps`; `ReadImageRowProps`; `ReadFamilyCard`; `readFamilyRow(props, card)`.
- Data flow: the row derives the model and hands the caller's card material to `ToolRow`.
- Non-obvious design decisions: the two rows are "the same single-file card row: the browse icon in the shared ToolRow chrome, the args-derived summary as an openable host path, **no args body** (the path link is the only args interaction), and one result-side card as the collapsed-by-default body. Only which card material they carry differs, so the row assembly lives here once instead of being copied per tool" (`packages/client/ui-tool/src/client/tool/toolviews/read-family-row.tsx:1-7`).
- Edge cases / failure handling: `bodyRaw={null}` is passed explicitly — the args JSON is never the expansion for a read-family row.
- Surprising: the `ReadFamilyCard` type is a `Pick` of `ToolRowProps`, so a new card material is a compile error until the pick is widened.

### packages/client/ui-tool/src/client/tool/toolviews/read-image-row.tsx
- Purpose: the `read_image` row and its keyed registration.
- Key abstractions: `ReadImageRow`; `readImageToolview`.
- Data flow: the row supplies the image card material plus the `tool.call.images` dispatcher and the session-authorized loader.
- Non-obvious design decisions: the header comment (`packages/client/ui-tool/src/client/tool/toolviews/read-image-row.tsx:9-18`) is the contract: "Claiming the `read_image` key suppresses the generic fallback for **every** read_image result, so this component must cover all of the tool's shapes, not only the happy one: a running call (no result yet), a settled image, a refusal (a text-only route, a missing attachment service, an unreadable file), and a cancelled call. Each of those settles without an `image` card, and the row falls back to its text body for them."
- Edge cases / failure handling: the row is result-side only — "a call carries no content until `execute` returns, so a running read_image shows the summary row alone."
- Surprising: this is the only entry in the package that declares a **child slot** (`children: { 'tool.call.images': … }`), and the slot's doc comment says a second declaration of the same child throws at load.

### packages/client/ui-tool/src/client/tool/toolviews/read-row.tsx
Thirty lines: the `read` row. It supplies the read card and the line the call named (`readCallLine(block)`) so opening the path lands where the model looked.

### packages/client/ui-tool/src/client/tool/toolviews/search-row.tsx
- Purpose: the grep/glob row.
- Key abstractions: `SearchRow`; `SEARCH_TITLE_KEYS`; `searchToolview`.
- Data flow: the row derives the model and the search card and renders them through `ToolRow`.
- Non-obvious design decisions: the title is chosen by tool name (`tool.title.grep` / `tool.title.glob`) rather than by the generic variant key, so the row says "Search file contents" and "Find files" instead of one "Search".
- Edge cases / failure handling: the row keeps the generic fallback for errors and legacy results — "ToolRow ignores output when a structured card is present; otherwise it preserves the generic fallback" (`packages/client/ui-tool/src/client/tool/toolviews/search-row.tsx:32-33`).
- Surprising: one component is registered under both `grep` and `glob` (`packages/client/ui-tool/src/client/tool/toolviews/search-row.tsx:48-51`), and the spec pins that both keys claim the conversation locale seat.

### packages/client/ui-tool/src/client/tool/toolviews/todo-row.tsx
- Purpose: the `todo_write` row and its plan summary.
- Key abstractions: `TodoRow`; `todoToolview`; `RowSummary`; `summarize`.
- Data flow: the row reads the recorded todo baseline through the `tool-todo-history` target, derives the diff, and renders the summary, the diff summary and the details.
- Non-obvious design decisions: `summarize` (`packages/client/ui-tool/src/client/tool/toolviews/todo-row.tsx:30-50`) parses the call's own `argsRaw` — not the result — so the row can show the plan **while the call is still running**. Malformed JSON and a valid-JSON-but-invalid-todos shape both fall back to the generic summary.
- Edge cases / failure handling: the active count is rendered *outside* the ellipsized summary text (`packages/client/ui-tool/src/client/tool/toolviews/todo-row.tsx:68-69`), because "a narrow row never clips the one part that says several tasks are running".
- Surprising: the row is the only toolview that injects `uiConversation` and registers two Conversation Definitions and a View to build its own baseline index.

### packages/client/ui-tool/src/client/tool/toolviews/web-row.tsx
- Purpose: the web-search and web-fetch rows.
- Key abstractions: `WebRow`; `WEB_TITLE_KEYS`; `webToolview`.
- Data flow: the row derives the model and the web card, and passes the `href` so a collapsed fetch row links its URL.
- Non-obvious design decisions: the icon differs per tool — a globe for `web_search`, a browse glyph for `web_fetch` (`packages/client/ui-tool/src/client/tool/toolviews/web-row.tsx:21`).
- Edge cases / failure handling: the href is only ever an `http(s)` URL, validated in the model.
- Surprising: one component serves both tools, and the fetch row's link opens in a new browser tab while the search row has no link at all.

### packages/client/ui-tool/src/css-modules.d.ts
Four lines: the ambient declaration for `*.module.css`. Boilerplate.

### packages/client/ui-tool/src/index.ts
Four lines: the Host loader entry for the browser-only Tool UI plugin. `apply()` does nothing — the package provides no host-side behaviour.

### packages/client/ui-tool/tests/ask-question-row.client.spec.tsx
The `ask_user_question` acceptance suite (686 lines): the `waiting` summary while running, the answered count from the result JSON once settled, the same reading for a call a late reply answered, readable lists for `ASK_CANCELLED`/`ASK_ABORTED`, the still-answerable row's reopen action and its closed counterpart, the shared ToolRow state semantics, and generic fallbacks on malformed results. I read the first 90 lines (the fixtures and the row-props builder).

### packages/client/ui-tool/tests/assembly-surfaces.client.spec.tsx
Tool assembly acceptance through the real ui-conversation host: the real `apply` of both packages over a `SlotTestRuntime`, with a `todo_write` result and a bash result, asserting the rows that appear in the transcript.

### packages/client/ui-tool/tests/chat-ptc-subcalls.client.spec.tsx
The sub-call contract over the real chat machinery: a `run_code` parent row with its description and nested sub-rows; the Cordis sub-calls with their lifecycle titles ("without the owned titles all three would read 'Tool call · cordis_run · dyn-2'"); the code row expanding to the shiki-tokenised program body; an `isError` sub-call rendering the same error row state; a file sub-row click opening the file in the Sidebar while a bash sub-row opens nothing; a running parent nesting its so-far dispatches; and an ordinary tool row rendering no sub-call nest.

### packages/client/ui-tool/tests/coverage-tails.client.spec.tsx
The presentation tails: a stopped row keeps the business icon and shows a warning summary; a settled `others`-variant row renders the sparkle icon; the Bash row summarises the description without a row click target; and the Bash row keeps its business icon for failed and stopped states.

### packages/client/ui-tool/tests/details-models.client.spec.ts
The detail adapters' contract (219 lines): the shared narrowers and the localizers, the producer-wording lists for agents, jobs, terminals and LSP locations, and the receipts. I read the first 90 lines.

### packages/client/ui-tool/tests/details-row.client.spec.tsx
The recorded detail cards: the goal's phase and activation including a blocker, the reminder list in all three kinds (every, at, after) and the Host-delivered set beside a recorded session-local result, the in-place update by the reminder it committed, and the rejection of every malformed shape.

### packages/client/ui-tool/tests/diff-card.client.spec.tsx
The diff card's contract (362 lines): the authored file label is retained when the navigation metadata names an absolute target; a running card is derived from the raw edit arguments; an empty `old_string` preserves the Host presenter's whole-file diff; and the `str_replace_editor` create and replace shapes. I read the first 80 lines.

### packages/client/ui-tool/tests/image-card.client.spec.tsx
The image render intent (408 lines): the pure derivation over a settled call's persisted metadata and raw envelope, the chat row that consumes it, the keyed `read_image` registration including its `tool.call.images` child-slot declaration, and the text that stays readable when the attachment slot renders nothing. I read the first 80 lines.

### packages/client/ui-tool/tests/preparing-rows.client.spec.tsx
The preparation contract: a malformed completed path is not exposed as a file link; every tool has a tool-owned prefix without arguments or disclosure; a write/edit row hides content progress without a path; and the file row is retained through streamed arguments, dispatch and result.

### packages/client/ui-tool/tests/read-card.client.spec.tsx
The read card's contract (296 lines): the derivation from settled read metadata and the raw envelope, the `readCallLine` offset, and the `read` row's expansion. I read the first 80 lines.

### packages/client/ui-tool/tests/search-card.client.spec.tsx
The search card's contract (371 lines) — the most complete card spec in the package: the matches and paths derivations, the null cases (running, missing call, error, malformed args, unrelated tool, nested, mismatched metadata shape), the `include` grammar validation, the recovery text surfaced **only** when the card was capped, the collapsed-vs-expanded body, the error fallback to the name/code line, and the registration of one component under both keys.

### packages/client/ui-tool/tests/spill-policy-terminal.client.spec.ts
A producer-to-UI regression: it runs the **real** spill policy over a real shell fixture, at both the root and the nested PTC location, for `bash` and `pwsh`, and asserts that a spilled result stays generic (no terminal card, `isSpilledShellCall` true) for a nonzero exit, a terminating signal and markerless output — while a result that fits keeps its terminal card and exit code.

### packages/client/ui-tool/tests/terminal-card.client.spec.tsx
The terminal card's contract (734 lines): the signed exit code in the localized capsule, the absence of a capsule without a settled foreground failure, the run-state dot, and the raw-output fixture that preserves interior whitespace "exactly what the default whitespace-collapsing matcher would hide". I read the first 80 lines.

### packages/client/ui-tool/tests/todo-history.client.spec.ts
The recorded todo predecessors' contract: a missing predecessor is **repaired on prepend** and earlier cards stay fixed after a later write; a nested dispatch gets its own baseline; the diff shows additions, status transitions, removals and unchanged items separately; the lookup snapshots are immutable; and a relative reorder is distinguished from a position shifted by an insertion.

### packages/client/ui-tool/tests/todo-row.client.spec.tsx
The `todo_write` row and the plan-summary model: the counts and the active item from the call args, the extra active count outside the ellipsized text, the omission of the active clause when nothing is in progress, the counts kept when an active item has unusable content, the non-ok states, the generic fallbacks, the read-only checklist, and the keyed registration.

### packages/client/ui-tool/tests/tool-call-tree.client.spec.tsx
The tree's contract: among 100 sibling calls only the parent and the changed child are dispatched; preparation is dispatched with **no** argument fields; one stable disclosure hook is forwarded to nested calls and a reset closes only their open state; the root marker and the generic fallback for a window-truncated call; a current-id leaf under its historical-id parent; Inspect is omitted when the target view is unavailable; a running call dispatches by its wire name; a POSIX home path is abbreviated to `~`; and an Auto denial renders generically **before** any keyed dispatch.

### packages/client/ui-tool/tests/tool-fixtures.client.ts
The shared Chat-slice and Session-event fixtures: `toolChatSnapshot` builds the canonical Chat snapshot from settled and running calls, and `toolSessionEvents` builds the `turn/start` → `step/start` → `tool/call` → `tool/result` event window that projects them into Chat.

### packages/client/ui-tool/tests/tool-row-styles.client.spec.ts
A stylesheet gate: the terminal command opts into wrapping only (`--dsl-terminal-command-whitespace: pre-wrap`) and never into line whitespace; a tool sheet does not restate the row text colour (so the shared disclosure header owns tertiary-at-rest and secondary-on-hover); the summary suffix is `flex: none` + `nowrap` and never ellipsizes; and the summary texts read the secondary content tier so the Settings font-size preference reaches tool rows.

### packages/client/ui-tool/tests/tool-row.client.spec.tsx
The row model's contract (662 lines): the variant classification of every known tool, the Cordis run-control titles, `cordis_define` left to its own keyed view, the auto-review normalisation, and the row's own rendering. I read the first 80 lines.

### packages/client/ui-tool/tests/toolview-slot.client.spec.tsx
The keyed slot through the real machinery (342 lines): dispatch by entry key, the generic fallback, the Auto denial, the file-open path to the Sidebar and live registration takeover, over the real chat, conversation and tool packages. I read the first 100 lines.

### packages/client/ui-tool/tests/toolview-type-chain.client.spec.tsx
Compile-time negative samples for the toolview slot types: a keyed registration needs `key`, `id`/`order` belong to list slots, an atomic tool view does not receive `loadOlder`, a preparing block has no `argsRaw` and no `content`, and the tool-call union has no pre-parsed args member.

### packages/client/ui-tool/tests/web-card.client.spec.tsx
The web card's contract (274 lines): the search and fetch derivations, the open-root argument validation, the href reader and the WebRow's new-tab link. I read the first 80 lines.

### packages/client/ui-tool/tsconfig.json
The client build: `rootDir: src`, `outDir: lib/types`, **16** project references (spill-policy, attachment, the two api controllers, cordis, connection, locale, ui-chat, ui-conversation, ui-primitives, ui-renderer, ui-session, ui-slots, core/tools, user-questions and util/workspace-path).

### packages/client/ui-tool/tsdown.config.ts
Three lines: `clientBundle(import.meta.dirname, ['lib/types/index.js'])` — the same shared bundler and type entry as ui-conversation.

---

## Ideas worth stealing

- **Compare-and-swap the edit span, not the edit** — `packages/client/ui-conversation/src/client/input/facade.ts:514` — every editor-side edit carries the draft revision it was computed against, and a mismatch refuses the edit. This is the cheapest possible defence against the "my click landed in the wrong place because the text moved underneath it" class of bug, and it transfers directly to August's composer, where a file-@-mention insertion races the user's typing.

- **Three text planes over one document, with chips counted as one opaque character** — `packages/client/ui-conversation/src/client/input/editor/projection.ts:1` — the detect plane (trigger coordinates), the clipboard plane (persistence and submit) and the chip objects are three views of ONE walk, so they can never disagree about offsets. August's composer has the same problem (a reference chip occupies one character to the scanner but N to the model); this is a proven way to keep the two coordinate systems honest.

- **Refuse the ambiguous edit rather than repair it** — `packages/client/ui-conversation/src/client/contract/draft-editor.ts:7` — `TokenSpan` carries `draftRev`, and a zod `refine` additionally proves that every persisted reference is an ordered, non-overlapping span whose text matches the source (`packages/client/ui-conversation/src/client/draft.ts:24`). August's `@`-mention persistence has the same failure mode (a chip whose offset no longer matches the text), and the answer is to validate the invariant at the storage boundary and refuse the record rather than re-derive it.

- **Length-prefix every composite key** — `packages/client/ui-conversation/src/client/contract/conversation.ts:341` — `` `${kind.length}:${kind}${id}` `` is collision-free by construction. Cheap, and it removes an entire class of "two different things got the same key" bug from any registry August builds.

- **Resolve claims before accepting anything, and throw on an ambiguous claim** — `packages/client/ui-conversation/src/client/conversation/assembler.ts:519` — the outcome does not depend on registration order, and two claims on one target (or a claim from a target-less Definition) throws. August's "one tool, one renderer" rule is exactly this: the dispatch must be order-independent and an ambiguous registration must fail loudly at load, not silently at render.

- **Withhold rather than guess when the history is incomplete** — `packages/client/ui-conversation/src/client/contract/system-prompt.ts:44` — a system-prompt replacement whose endpoint predates the loaded window makes the whole prompt *unavailable* (`uncertain: true`, `effective: undefined`) until prepend replay supplies the order. August's August-side "what did the model actually see" surface has the same trap; refusing to answer is correct and the state is explicit rather than a blank string.

- **Anchor a prompt change at the event that introduced it, not at the request** — `packages/client/ui-conversation/src/client/contract/request-inspection.ts:50` — a system-node change is anchored at the `system/message` node and a tool change at the `request/header`, with four explicit change kinds. August's Usage/Inspection page wants exactly this, and the four-kind vocabulary (`initial` | `system` | `tools` | `system-and-tools`) is a good answer to "what changed for the model".

- **Dependency-tracked replay on history prepend** — `packages/client/ui-conversation/src/client/conversation/assembler.ts:782` and `packages/client/ui-conversation/src/client/conversation/assembler.ts:853` — a Definition declares which predecessor it read, and when older history arrives the assembler re-derives exactly the affected contexts. This is the mechanism that makes "load older" repair earlier cards instead of orphaning them, and it is the client-side analogue of August's "the transcript is rebuilt from a window, not a log".

- **Validate the whole group batch before installing any of it** — `packages/client/ui-conversation/src/client/conversation/group-store.ts:88-89` — a mismatch throws and the store is left byte-identical, with the spec asserting the root array and every source snapshot are unchanged after the throw. August groups tool calls into activity runs; a partial install there is exactly the "the transcript is now subtly wrong" failure.

- **Two presses, and the second must match the first on four identities** — `packages/client/ui-conversation/src/client/stop-sequence.ts:38` — session, turn, binding generation and focused DOM region. A press in the composer and a press in the transcript are two different stops. August's "stop generation" affordance should not fire from a different surface, and a replaced session binding must invalidate an earlier press.

- **A denial is not a tool result** — `packages/client/ui-tool/src/client/tool/ToolCallTree.tsx:50` — an Auto-review denial **bypasses the keyed dispatch entirely** and renders the generic card. August removed its verifier gate, but the shape of the decision is worth keeping: a refusal must never be presented as a tool that ran.

- **Let a card decline rather than render half a fact** — `packages/client/ui-tool/src/client/tool/models/image-card-model.ts:211` — if a result carries a block kind the card cannot render, the whole card declines to the generic form; and the attachment reference comes from the *result*, never from a second copy in the metadata (`packages/client/ui-tool/src/client/tool/models/image-card-model.ts:37-43`). August's tool cards face the same temptation to show "most of" a result; declining to the generic row is honest and cheap.

- **A summary that must not be clipped gets its own non-shrinking slot** — `packages/client/ui-tool/src/client/tool/components/ToolRow.module.css:50` — the trailing count is `flex: none; white-space: nowrap` and explicitly **no** `text-overflow: ellipsis`, because "a clipped count reads as a smaller number rather than as missing information". The same rule produced the plan summary's split `activeContent` / `activeExtra` (`packages/client/ui-tool/src/client/tool/toolviews/plan-summary.ts:20-26`). August's todo dock has the identical shape — the parallel-active count is exactly this.

- **Infer "persistent" from the absence of a field** — `packages/client/ui-tool/src/client/tool/models/terminal-card-model.ts:343` — a settled persistent shell call declines the terminal card because "reset and partial output diagnostics do not necessarily describe a single process's exit status". The general rule — *the shape of the data tells you what kind of fact it is* — is a better default than an explicit flag, and it transfers to any tool whose result shape differs by execution mode.

- **Facts-tracked, query-cached matching** — `packages/client/ui-conversation/src/client/conversation/user-text-document.ts:66` — a rule is invalidated only when a Fact it actually *read* changes, and a failed query is retried only when its offset, definition, text or read Facts change. August's "did the model mention this file" recall path pays the same invalidation cost; reading the dependency set rather than the whole input is the trick.

- **The scope of a slot is the mechanism that avoids a remount** — `packages/client/ui-conversation/src/client/contract/slots.ts:282` — `conversation.composer.bar` is `session-maybe`, so the composer stays mounted across the no-session/session transition and renders inert. August's composer has the same transition; the fix is a scope declaration, not a React trick.

- **Two details that read as one** — `packages/client/ui-conversation/src/client/contract/records.ts:34` — `AssistantBlock` has a first-class `reasoning` kind and `AssistantTiming` separates `stepStartTime` from `firstTokenTime` (`packages/client/ui-conversation/src/client/contract/records.ts:52-58`), so "the model thought for 4 s" and "the model produced its first token after 9 s" are different facts. August's Usage page currently reports a single duration; this is the client-side vocabulary for splitting it.

- **An idle-context percentage is withheld, not estimated** — `packages/client/ui-conversation/src/client/context-occupancy.ts:19` — the meter returns `null` until both a numerator and a capacity are known, and the percent is clamped to 100. August's context meter should do the same rather than showing a percentage against a guessed window.

- **The compaction checkpoint is a first-class node, not a log line** — `packages/client/ui-conversation/src/client/contract/records.ts:192` — `CompactionSummaryNode` carries the summary text, the summary event's seq, the number of shadowed surface items and the shadowed token count, each `null` when the window cut left the source outside. August's compaction surface currently shows a marker; this is the shape of a checkpoint that can be explained.

- **A closed loop with a cursor per session, not one global high-water mark** — `packages/client/ui-tool/src/client/tool/models/todo-history.ts:51` — the todo baseline is read through the assembler's `previous()` dependency, so the assembler repairs it when older history arrives, and a *nested* dispatch gets its own baseline keyed by the sub-call id. The transferable lesson is the sub-call baseline: a subagent's todo state must be indexed separately from the parent's.

---

## Files skipped (with reasons)

Nothing in the shard was skipped. Every one of the 230 files exists on disk and was opened. The following were read **partially** (a leading section plus a representative sample of the remainder) rather than line by line, because they are long acceptance suites or long string tables whose structure repeats:

- `packages/client/ui-conversation/README.zh.md` — read lines 1-60 of 194; the remainder is the Chinese translation of the English README read in full.
- `packages/client/ui-tool/README.md` — read lines 1-120 of 149; the remainder is the "Model Experience", limitations and dev-note sections.
- `packages/client/ui-tool/README.zh.md` — read lines 1-60 of 149; the Chinese translation of the same file.
- `packages/client/ui-conversation/src/client/locales.ts` — read lines 1-120 and 700-767 of 767; the middle is the paired zh/en body of the same key set.
- `packages/client/ui-conversation/src/client/conversation/assembler.ts` — read lines 1-560 and 561-1102 of 1102 (complete).
- `packages/client/ui-conversation/src/client/conversation/location-index.ts` — read lines 1-104, 405-416, 440-451 and 635-655 of 655; the unread middle is the index's incremental update machinery, whose contract is exercised by `tests/conversation-assembler.client.spec.ts`.
- `packages/client/ui-conversation/src/client/input/facade.ts` — read lines 1-450 and 451-946 of 946 (complete).
- `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css` — read lines 1-180 and 181-559 of 559 (complete).
- `packages/client/ui-conversation/src/client/skeleton/InputBar.module.css` — read lines 1-150 and 151-423 of 423 (complete).
- `packages/client/ui-conversation/tests/apply-inject.client.spec.tsx` — read lines 1-130 of 611.
- `packages/client/ui-conversation/tests/conversation-assembler.client.spec.ts` — read lines 1-120 of 2018.
- `packages/client/ui-conversation/tests/draft-document.client.spec.ts` — read lines 1-100 of 761.
- `packages/client/ui-conversation/tests/history-transport.perf.client.ts` — read lines 1-120 and 420-579 of 617.
- `packages/client/ui-conversation/tests/input-bar.client.spec.tsx` — read lines 1-120 of 1915.
- `packages/client/ui-conversation/tests/input-scenarios.client.spec.tsx` — read lines 1-100 of 639.
- `packages/client/ui-conversation/tests/lexical-editor-core.client.spec.tsx` — read lines 1-90 of 536.
- `packages/client/ui-conversation/tests/queue-dock.client.spec.tsx` — read lines 1-90 of 783.
- `packages/client/ui-conversation/tests/service-orchestration.client.spec.ts` — read lines 1-120 of 917.
- `packages/client/ui-conversation/tests/skeleton.client.spec.tsx` — read lines 1-100 of 861.
- `packages/client/ui-conversation/tests/submit-machine.client.spec.ts` — read lines 1-100 of 400.
- `packages/client/ui-conversation/tests/user-text-registry.client.spec.ts` — read lines 1-120 of 311.
- `packages/client/ui-conversation/tests/user-text-scheduling.client.spec.ts` — read lines 1-80 of 435.
- `packages/client/ui-conversation/tests/user-text-whitespace.client.spec.ts` — read lines 1-100 of 190.
- `packages/client/ui-conversation/tests/user-text.client.spec.tsx` — read lines 1-80 of 206.
- `packages/client/ui-tool/tests/ask-question-row.client.spec.tsx` — read lines 1-90 of 686.
- `packages/client/ui-tool/tests/details-models.client.spec.ts` — read lines 1-90 of 219.
- `packages/client/ui-tool/tests/details-row.client.spec.tsx` — read lines 1-80 of 144.
- `packages/client/ui-tool/tests/diff-card.client.spec.tsx` — read lines 1-80 of 362.
- `packages/client/ui-tool/tests/image-card.client.spec.tsx` — read lines 1-80 of 408.
- `packages/client/ui-tool/tests/read-card.client.spec.tsx` — read lines 1-80 of 296.
- `packages/client/ui-tool/tests/terminal-card.client.spec.tsx` — read lines 1-80 of 734.
- `packages/client/ui-tool/tests/tool-row.client.spec.tsx` — read lines 1-80 of 662.
- `packages/client/ui-tool/tests/toolview-slot.client.spec.tsx` — read lines 1-100 of 342.

---

## Uncertainties

- **The shard contains no agent loop, no tool execution, no compaction logic, no memory store and no subagent scheduler.** Both packages declare "Model Experience: None" and the code agrees. Every lens in the assignment that points at the *server* side of the harness (agent loop and tool-calling flow, memory/learning, model-specific fallbacks at the provider level) therefore has **no implementation in this shard** — only the *rendering* and *inspection* of what another package decided. I checked: `packages/client/ui-conversation/src/client/contract/records.ts` has no model-loop types, and the only compaction-aware code is the `CompactionSummaryNode` and the `CompactionRequestView` the Host emits. I did not read the Host packages, so I cannot say what the loop does.
- **The "Model Experience: None / KV Cache effect: None" claim is scoped to these two packages.** `packages/client/ui-conversation/README.md:170-176` makes it for `ui-conversation` and `packages/client/ui-tool/README.md` has the same section. I could not verify it for the product as a whole from inside the shard. What the shard *does* contain is the client-side **inspection** surface for prompt construction and for the compaction request, which is the closest this shard comes to the caching lens.
- **I could not determine how the "context-occupancy" percentage is computed.** `packages/client/ui-conversation/src/client/context-occupancy.ts` consumes a `ContextPressureProjection` from `dsh-token-meter` and prefers `projectedTokens` over `pressureTokens`, but the projection's own definition (and whether it accounts for tool schemas, system prompt and compaction) lives in a package outside this shard. The `ContextMeter` panel's three rows (system / tools / messages) are labelled "**heuristic** `contextBreakdown`" in the component's own header comment.
- **The relationship between the `ui-conversation` `conversation.composer` **chain** slot and the `conversation.composer.bar` **single** slot is only partly visible here.** `packages/client/ui-conversation/src/client/contract/slots.ts:260` declares the chain and `packages/client/ui-conversation/src/client/contract/slots.ts:282` the bar, and `packages/client/ui-conversation/src/client/apply.ts:571` registers the bar, but the chain's *consumers* live in other packages. I read the two contract entries and the registration, not the chain's resolution.
- **`packages/client/ui-tool/src/client/tool/models/control-details-model.ts` re-parses the *producers'* own output format.** The regexes (`packages/client/ui-tool/src/client/tool/models/control-details-model.ts:27`, `packages/client/ui-tool/src/client/tool/models/control-details-model.ts:47`, `packages/client/ui-tool/src/client/tool/models/control-details-model.ts:60`) are coupled to `dsh-tool-jobs`, `dsh-tool-session-query` and `dsh-tool-terminal`'s `render` helpers. I read the parsers and the corresponding producer-importing test (`packages/client/ui-tool/tests/details-models.client.spec.ts:9-11`), but I did not read the producers themselves, so I cannot say whether the wording is a stable contract or an accident that happens to match today.
- **The `dsh-tool-bash` / `dsh-tool-pwsh` "persistent shell" inference is stated, not demonstrated.** `packages/client/ui-tool/src/client/tool/toolviews/bash-sample.tsx` and `packages/client/ui-tool/src/client/tool/models/terminal-card-model.ts:343` both rely on the *absence* of a `description` field meaning "persistent shell provider". I could not check the Host tool schemas — they are outside this shard — so I cannot confirm that the absence is unambiguous rather than merely possible.
- **The `history-transport.perf.client.ts` benchmark is opt-in and its numbers are not in the repo.** I read its fixture constants (416,756 logical items, 416,176 stream members, 116 compact records) and its assertions (the compact form folds to the same digest at the same heap peak), but the measured figures are printed to stdout at run time, not committed. I did not run it.
- **I did not run any test, build, type-check or script from the clone**, per the read-only rule. Every claim in this report about behaviour comes from reading the source and the specs' assertions, not from a green run.
- **Two numeric details in the previous pass's ledger were wrong and are corrected here**: `packages/client/ui-conversation/tsconfig.client.json` has **32** project references (not 30), and `packages/client/ui-tool/tsconfig.json` has **16** (not 18). Both verified by parsing the JSON.
- **The manifest was not modified.** I read it read-only and used its `owner-shard` column as the authoritative list; the 230 rows it names for `dsh-client-chat#2` are exactly the 230 files covered here.
