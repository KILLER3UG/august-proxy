# deepseek-harness / dsh-client-chat#1

## Shard shape

This shard is the entire `packages/client/ui-chat/` package of the deepseek-harness monorepo: the **browser Chat target** — the transcript surface that renders a recorded Session's conversation. It is a *presentation-only* package: the README states "Model Experience: None" and "KV Cache effect: None" because it never assembles or mutates a provider request (`packages/client/ui-chat/README.md:178`). The package has four cooperating layers. (1) **`conversation-nodes/`** turns durable Session events into typed Chat *Nodes* — one `ConversationNodeDefinition` per kind (`assistant-step`, `tool-call`, `command`, `compaction`, `model-retry`, `turn-error`, `turn-max-tokens`, `turn-process`, `turn-tail`, `system-prompt`, `input-message`, `turn-trigger`) plus an unknown-surface fallback; `chat-snapshot-builder.ts` is the incremental `ConversationViewBuilder` that keeps a keyed, identity-stable node store and publishes only dirty keys. (2) **`contract/`** holds the type surface: the `ChatGroupTree` position vocabulary, the `ChatSnapshot`/keyed-source contract, the Slot/Factory declarations, and the exact token-usage types. (3) **`chat/`** is the React surface — seats, process groups, reasoning rows, the scroll viewport, the fold-motion coordinator, the turn rail, and the composer stat pills — plus the 18 CSS-module sheets that carry the geometry (the sheet set is where the *design* decisions live: the `overflow-y: clip` transcript root, the sticky compaction band, the wide-table breakout). (4) **`apply.ts`** wires the plugin into Cordis: it registers the Definitions, the `conversation.view` / `conversation.chat.flow` / `conversation.chat.node` Slots, three Settings rows, the frame-wide quota-notice host, and the two composer stat pills. Two long prose documents (`README.md` and `conversation-nodes/README.md`, 331 lines of executable business rules) are the package's real specification — the code is a transcription of them. The rest of the shard is the package's *proof*: 57 test files that pin the business rules rather than the implementation, six static-CSS suites that assert the stylesheets as text, a two-project TypeScript split (Host `files` whitelist vs browser `include` + `exclude`) that keeps the desktop bundle and the Node plugin apart, and one binary asset (an APNG used as a CSS mask).

---

**Citation convention.** Two forms are used below. A bare `:NN` or `:NN-MM` inside a per-file section means **line NN of the file named in that section's `###` heading**; anything carrying a path (`packages/client/ui-chat/...:NN`) is repo-relative and resolves from the repository root. Every citation in this report was machine-checked against the clone (90 absolute references, 833 per-section relative references, all in range), and every "N-line" claim was checked against the file's actual line count.

## Per-file notes

### packages/client/ui-chat/README.md
- **Purpose:** the package reference: reference previews, hidden rows, command/failure rows, turn token usage, completed-turn footer, Turn Process Folding, grouped rendering, scroll ownership, known limitations.
- **Key abstractions:** the four "work-details" modes (Compact/Standard/Detailed/Verbose) and the independent collapse-timing preference; the `conversation.chat.flow` / `conversation.chat.node` / `conversation.chat.reasoning.body` Slot vocabulary.
- **Data flow:** Chat renders *recorded* Session events; local transcript and steering submissions appear immediately in their own surface and "disappear atomically when authoritative Session records arrive"; queued submissions stay outside Chat (`:13`).
- **Non-obvious design decisions:** the package deliberately renders no model-facing surface ("Model Experience: None", `:178`); "KV Cache effect: None" — Chat presentation does not assemble or mutate provider requests, so it cannot perturb a provider prefix cache (`:180-182`). The quota notice lives in `shell.overlay`, i.e. *outside* the Chat panel, so it outlives the panel that reported it (`:60`).
- **Edge cases / failure handling:** a quota failure's inline row uses neutral `message.failure.quota` copy instead of the provider message; a native Platform page covering the document still lets the fallback Toast's timer elapse unseen, so only the persistent failure row remains (`:60`).
- **Surprising:** a run of tool calls is *one* grouped row here, not N — grouping is a render-time arrangement, not a new persisted block kind.

### packages/client/ui-chat/README.zh.md
Chinese mirror of `README.md` with identical anchors and section structure; verified against `README.i18n.yaml`'s per-heading hashes. Read the first 45 lines and confirmed section-for-section parity.

### packages/client/ui-chat/README.i18n.yaml
- **Purpose:** the bilingual-pairing consistency record for `README.md`.
- **Key abstractions:** one hash per heading section (`en:`/`zh:`), computed over blocks outside code fences.
- **Data flow:** `pnpm run verify-translation-pairing --write packages/client/ui-chat/README.md` regenerates it after an edit to either side.
- **Non-obvious design decisions:** the *document* is gated, not just the code — a doc that drifts from its translation fails a static check (`:1-4`).
- **Edge cases / failure handling:** generated regions and code blocks are excluded from the hash so fenced content cannot cause a false mismatch.
- **Surprising:** the doc layer has its own CI-like gate inside a frontend package.

### packages/client/ui-chat/src/client/conversation-nodes/README.md
- **Purpose:** the 331-line executable business-rule spec for Turn folding, display modes, collapse timing, process grouping, and activity summaries.
- **Key abstractions:** *grouping* (which rows belong together), *counts* (what a group did), *display mode* (how much detail), *whole-Turn folding* (whether process is visible at all) — the doc insists these answer four different questions (`:26`).
- **Data flow:** the whole-Turn control covers process content across several groups and intermediate replies; only the final answer is protected from folding (`:41`). An input after the first process evidence makes the Turn ineligible for whole-Turn collapse (`:90`).
- **Non-obvious design decisions:** "A group's `closed` flag means its content segment has ended, not that its UI disclosure is collapsed" (`:199`); the answer exemption comes from the Turn's process spec (`answerAnchorSeq`/`answerStep`), **not** from a group-tree position — the rule text says "The final answer is the latest Step's settled Assistant reply, provided it has visible reply content and no tool-call block" (`:97`), so the exemption moves as later steps arrive.
- **Edge cases / failure handling:** the end may be loaded while the start is not — the rules then apply to loaded content and show no elapsed duration, and specifically forbid using the first loaded tool/message time as the start (`:93`).
- **Surprising:** tool-name classification is *exact*: `functions.read`, `mcp.read` and `Read` all fall into `tools`, and `browser_inspect` falls into `search` (`:288`); the suffix `_inspect` is checked *before* the `subagent_` prefix so `subagent_inspect` is a search (`:280`).

### packages/client/ui-chat/src/client/conversation-nodes/README.zh.md
Chinese mirror of the business rules above; same anchors, same tables, translated prose. Confirmed by reading the first 30 lines.

### packages/client/ui-chat/src/client/conversation-nodes/README.i18n.yaml
Per-heading EN/ZH hash record for `conversation-nodes/README.md` (61 lines, 19 heading sections), regenerated by the same `verify-translation-pairing` script.

### packages/client/ui-chat/src/client/contract/group-tree.ts
- **Purpose:** the four-level position vocabulary a Chat node declares to place itself in the disclosure hierarchy.
- **Key abstractions:** `ChatGroupTree = 'exchange' | 'input' | 'turn' | 'process'` with `DEPTH = { exchange: 0, input: 1, turn: 2, process: 3 }` and `isAtOrOutside(node, position)` (`:25-37`).
- **Data flow:** a node's position selects whole-Turn folding, secondary-group membership, and Turn-input detection; an external Definition places its rows by declaring one position (`packages/client/ui-chat/README.md:106`).
- **Non-obvious design decisions:** "A Node at a position also has the effect of every inner position" (`:5-6`) — hence `isAtOrOutside` rather than equality. An `assistant-step` node places its two rows *without* a position: its reasoning row joins the step run and its reply row stands outside it (`:17-18`).
- **Edge cases / failure handling:** absence means "joins the surrounding step run", so a node that forgets to declare a position lands in the default place rather than being dropped.
- **Surprising:** one string replaces what would normally be a nest of `kind === 'turn-error' || kind === 'compaction' || …` checks across grouping, folding and answer detection.

### packages/client/ui-chat/src/client/contract/chat-visibility.ts
- **Purpose:** the Chat-only row filter (`:10-16`).
- **Key abstractions:** `isVisibleChatNode(node)` = visibility flag AND not a system prompt AND (not ordinary context OR the context carries tool additions/removals) AND not a `permission` command.
- **Data flow:** operates on the projected node; it changes neither recorded Session events nor Trajectory inspection (`packages/client/ui-chat/README.md:53`).
- **Non-obvious design decisions:** "Context containing tool additions or removals remains visible" — the tool registry changed, and that is user-relevant, while ordinary context is noise.
- **Edge cases / failure handling:** a `permission` command is hidden in every mode even though ordinary command rows remain.
- **Surprising:** a *hidden* node is still in the Node store, just not in Chat's visible order — hiding is presentation, not deletion.

### packages/client/ui-chat/src/client/contract/chat-nodes.ts
- **Purpose:** the Chat node type contract (135 lines).
- **Key abstractions:** `ChatConversationViewNode` (key, kind, `anchorSeq`, `location`, `visibility`, optional `groupTree`); the **merge-extensible** `ChatNodeDataMap` so another plugin can contribute a renderer payload; `ChatNode<Kind>` as a distributive union; `TurnTokenUsage` with optional buckets.
- **Data flow:** `ChatNodeDataMap` is declared empty here and augmented by each `conversation-nodes/*.ts` file via `declare module`, so adding a node kind is a one-file change (`packages/client/ui-chat/src/client/conversation-nodes/tool.ts:12-16`).
- **Non-obvious design decisions:** the optional usage buckets are "Present only when every attempt reported the bucket" (`:82-89`) — a partial report renders a partial row rather than a wrong total.
- **Edge cases / failure handling:** `isSettledTool`/`isRunningTool` discriminate on the presence of the `kind` discriminant rather than on a separate flag, so a malformed block cannot be both.
- **Surprising:** `ToolChatData` holds only the *root* — "the root lifecycle owns all recursive subcalls" (`:54`), so nested calls never need their own node.

### packages/client/ui-chat/src/client/contract/slots.ts
- **Purpose:** the 451-line declaration of every Slot, Factory, Hook and injected face in the Chat target.
- **Key abstractions:** keyed vs single vs list vs chain slots; `ChatNodeHookContext` (turn data, disclosure reset, group action); `ChatViewInjected` (presentation hook + four keyed hooks + open/link/load/fork/image/scroll actions).
- **Data flow:** `ChatFlowHookContext` carries the viewport's `motion` once, per rendered flow, so the fold coordinator is viewport-local and never broadcasts (`:182-193`).
- **Non-obvious design decisions:** the quota notice is a **chain** slot (`shell.quota-notice`, `:449`) whose first entry claiming the code takes over the surface and whose all-decline case renders the host's generic Toast — so a billing surface can replace the Toast without importing Chat. `conversation.chat.reasoning.body` is a *single* slot whose official entry registers at priority 100 and whose replacement must "preserve access to the original text" (`:425-429`).
- **Edge cases / failure handling:** `keepOpen()` returns "a release the caller owns and must run on unmount"; "A release drops only its own hold, so one that runs after a dismissal or a newer hold leaves that newer hold intact" (`:100-107`).
- **Surprising:** `conversation.chat.reasoning.content` is `scope: 'root'` — a Factory that needs no Session, so a reasoning renderer can be unit-tested without a Session provider.

### packages/client/ui-chat/src/client/contract/snapshot.ts
- **Purpose:** the `ChatSnapshot` contract and its keyed-source interfaces (170 lines).
- **Key abstractions:** `ChatNodeSource` (getSnapshot/subscribe per key), `ChatNodeStore` (`get`, `source`, `bottomSource`, `turnDataSource`, `processSource`, `values`), `ChatTurnNavigationIndex`, `ChatLocationNodeIndex`, `LegacyConversationSlice`.
- **Data flow:** `turnDataSource(turn, kind)` "includes hidden Nodes, and exposes their business data in anchor order" — "Membership updates incrementally; only observed collections materialize ordered arrays, and unrelated Turns or kinds do not notify them" (`packages/client/ui-chat/README.md:80`).
- **Non-obvious design decisions:** the `legacy` slice exists only to back the composer stats pills and the legacy top-level fields (`:100`), with an explicit comment that it is a *compatibility* projection.
- **Edge cases / failure handling:** `EMPTY_CHAT_SNAPSHOT` is a complete no-op snapshot used before a view builder is registered (`:145-169`), with identity-stable empty sources so a selector does not thrash.
- **Surprising:** `navigation.items()` is a method returning an array whose *identity* changes exactly when a Turn enters, leaves or changes preview — the array is itself the change signal (`:69-77`).

### packages/client/ui-chat/src/client/contract/store.ts
17-line per-Session store contract: `TurnProcessViewEntry { turn, answerStep, collapsed? }` and `ChatStoreState { turnProcesses }`. The `answerStep` field is what makes a manual disclosure apply to *one answer generation* rather than to a Turn forever.

### packages/client/ui-chat/src/client/contract/process-groups.ts
25-line contract for the group data: the 13-member `ProcessActivity` union, `ProcessActivitySummary { counts, running, runningDetail, preparing? }` and `ProcessGroupData`, merged into the conversation package's `ConversationGroupDataMap` under the `chat` key.

### packages/client/ui-chat/src/client/contract/turn-process.ts
- **Purpose:** the Turn-process specification and the rules around it.
- **Key abstractions:** `TurnProcessSpec { turn, controlAnchorSeq, processStartSeq, answerAnchorSeq, answerStep, inlineReasoning, messageCount, toolCallCount, subagentCount }`; `sameTurnProcessSpec` for structural equality (`:26-36`).
- **Data flow:** `isSubagentDelegationTool(name)` recognises `subagent` and `subagent_*`; the control tools (`send_message`, `list_agents`, `list_subagent_models`) are deliberately *not* counted as delegations (`:40-46`).
- **Non-obvious design decisions:** `turnProcessAlwaysOpen` keeps live, stopped (`aborted`) and failed (`error`/`interrupted`) Turns open — "Stopped or failed | Keep process content open; whole-Turn collapse is unavailable" (`packages/client/ui-chat/src/client/conversation-nodes/README.md:89`).
- **Edge cases / failure handling:** a node outside a turn/step location is not always-open (`:55`).
- **Surprising:** the spec carries *counts* (`messageCount`, `toolCallCount`, `subagentCount`) that exist only so the transcript can render "N tool calls" in the Turn header.

### packages/client/ui-chat/src/client/contract/turn-metrics.ts
43-line derivation of per-step latency facts: `assistantStepReading(node)` returns `{ ttftMs, decodeMs, outputTokens }` where `null` marks an unrecorded part (never zero). `ttftMs` needs *both* `stepStartTime` and `firstTokenTime`; negative spans clamp to 0; a non-finite or negative usage count is rejected.

### packages/client/ui-chat/src/client/contract/assistant-content.ts
15-line predicate `hasAssistantReplyContent(blocks)`: reasoning and tool-call protocol blocks never count as a reply; whitespace-only text does not; an image or an unknown block does. This one predicate decides the answer boundary (`packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts:117-122`) and the "ends with a response" test for the action footer.

### packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts
- **Purpose:** the 1244-line incremental `ConversationViewBuilder` for the `chat` target — the heart of the shard.
- **Key abstractions:** `MutableChatSource<Value>` (identity-stable per-key observable, `:44-68`); `TurnKindNodes` (membership indexed on write, ordered array materialized only for observed collections, `:72-105`); `MutableChatNodeStore` (`:107`); `MutableChatLocationIndex` (`:264`); `MutableTurnNavigationIndex` (`:367`); `ReferenceLabelProjector` (`:572`); `SkillNameProjector` (`:695`); `LegacySliceBuilder` (`:928`).
- **Data flow:** `replace()` runs the skill-name and reference-label projectors over the whole node set, rebuilds the location index and the process presentations, settles the bottom exchange, and rebuilds the navigation index. `apply()` classifies each upsert as *structural* (kind/anchor/visibility/groupTree/location changed) or *content-only*; only a structural change re-orders the nodes and rebuilds the location index (`:1144-1176`).
- **Non-obvious design decisions:** "an assistant streaming frame costs nothing here (the append hot path never scans the Chat Nodes)" — `SkillNameProjector.apply` re-reads only the boundary-free runs around the changed seq (`:689-693`). The rail's preview bounds are mirrored from the host's `turnOutline` projection because "the wire boundary forbids sharing code with the host package" (`packages/client/ui-chat/src/client/conversation-nodes/turn-navigation.ts:16-18`). `processPresentationInputChanged` treats a turn-status change or a step change as a process-presentation change even when the node is content-only (`:423-436`).
- **Edge cases / failure handling:** `isActive: snapshot => snapshot.order.some(key => snapshot.nodes.get(key)?.kind !== 'command')` — a Session holding only command rows is not an active Chat target (`:1235`).
- **Surprising:** `orderedVisibleChatNodes` sorts by `(anchor, rank, originalAnchor, key)` where `rank` exists only to place the synthetic process *control* row between the opening input and the process content, without disturbing the relative order of existing rows (`:522-535`).

### packages/client/ui-chat/src/client/conversation-nodes/process-groups.ts
- **Purpose:** the Definition-owned process grouping (303 lines) — segmentation plus incremental per-group summaries.
- **Key abstractions:** `ProcessGroup` (members + cached summary, `:58`); `TurnGroups` (one Turn's groups, membership map, root references, `:83`); `ProcessState` (the registered `ConversationGroupDefinition`'s state, `:200`).
- **Data flow:** `accept(input)` handles a `replace` (full rebuild per Turn) or an `apply` (incremental). For an apply, a node whose kind/turn/visibility/groupTree/reasoning/reply changed marks its Turn for *regrouping*; everything else is a *refresh* of the owning group only (`:230-277`).
- **Non-obvious design decisions:** `extendedGroup` reuses a group's identity across a history prepend "only while the complete old group remains between newly visible members" (`:173-190`) — a prepend that splits a group mints a new identity instead of reusing one for two groups. `structureChanged` ignores visibility churn between two hidden nodes (`:42-49`). The assistant node contributes *two* roots from one node: its reasoning joins the step run, its reply stands outside it (`:156-163`).
- **Edge cases / failure handling:** a group's `closed` flag is set when the Turn's status is `closed` *or* the segment ends at a reply/separator; "Any other or unavailable Turn status alone does not close that trailing group" (`packages/client/ui-chat/src/client/conversation-nodes/README.md:229`).
- **Surprising:** "resegments only the changed Turn without notifying historical Node or Group sources" — the whole point of the incremental path is that a streaming assistant frame touches exactly one group.

### packages/client/ui-chat/src/client/conversation-nodes/process-activity.ts
- **Purpose:** the tool-category classifier, distinct-call counter, and live-detail extractor (167 lines).
- **Key abstractions:** `activity(name)` maps an exact tool name to one of 13 categories (`:8-22`); `LIVE_TOOL_DETAIL_KEYS` is a 23-field priority list shared by every tool (`:27-30`); `processActivity(nodes)` walks the tool tree (`:134`).
- **Data flow:** the walk visits the root, then `tool.subCalls` recursively, deduplicating by `callId` — a repeated `callId` counts once and its subtree is skipped; a parent and a child with different call ids each count (`:141-156`). Counts sort descending, ties keep first-occurrence order.
- **Non-obvious design decisions:** the live category is chosen by the greatest call *start* time, not by the latest output time — "Live selection uses call start `time`, not the latest output/progress time" (`packages/client/ui-chat/src/client/conversation-nodes/README.md:300`). The live detail is read from a **lazy** argument view (`args.textPrefix`) so a still-streaming argument is read as it arrives (`:62-83`).
- **Edge cases / failure handling:** `argumentTextDetail` handles a surrogate pair split across two deltas: it re-reads with `limit + 1`, and if the next unit is a low surrogate it extends the prefix, otherwise it drops the dangling high surrogate rather than emitting half a character (`:66-78`). The prefix doubles until the truncated result is stable, and each pass reads at most 161 grapheme clusters (`:80-82`).
- **Surprising:** the detail field list is *global*, not per category — `description` can override `command` on a shell call and `title` can override a file path (`packages/client/ui-chat/src/client/conversation-nodes/README.md:313`).

### packages/client/ui-chat/src/client/conversation-nodes/tool.ts
- **Purpose:** the Tool-call Definition: preparing → dispatched → result, plus recursively nested PTC sub-calls (371 lines).
- **Key abstractions:** `ToolState { root, children, parents }`; `projectedBlocks` a `WeakMap` cache of projected blocks (`:35`); `acceptsEdge` (cycle + depth guard, `:173-196`); `projectBlock` (`:226`).
- **Data flow:** every `tool-call-delta` is a *start candidate* — the earliest opens the Context and later ones fold as updates (`:295-303`). The Assistant node keeps tool *identity and timing* but does **not** accumulate argument deltas; the Tool node retains the streamed argument fragments in a `PartialArguments` view (`:41-50`).
- **Non-obvious design decisions:** "Root replacement belongs to publication, after all pending fragments can be observed together" (`:58-60`) — a delta never mutates the root, only the publication does, so a reader can never see a half-replaced argument. `publication: match => match.event.type === 'assistant/live-chunk' ? 'animation-frame' : 'immediate'` — live deltas are frame-batched, durable calls publish immediately (`:331`).
- **Edge cases / failure handling:** a step or turn that closes while a call is still running produces a synthetic interrupted tool-result with `error: { name: 'Interrupted', code: 'interrupted' }` at a synthetic seq (`:248-264`). A preparation that never dispatched and whose Step closed is *hidden*, not shown as a failed call (`:346`). `fallbackState` rebuilds the whole state from the durable matches when the engine holds no incremental state (`:282-289`).
- **Surprising:** `MAX_DEPTH = 256` is enforced by *both* the ancestor walk and the descendant-subtree walk, so an edge is refused unless every recursive consumer can traverse it safely.

### packages/client/ui-chat/src/client/conversation-nodes/assistant.ts
- **Purpose:** the Assistant-step Definition (373 lines) — streaming, settled and interrupted states.
- **Key abstractions:** `AssistantState` (blocks, visibleBlocks, firstVisibleSeq/Time, firstTokenTime, final, usage); `updateChunk` (`:89-162`); `finalNode` (`:190`); `resetForRetry` (`:82`).
- **Data flow:** chunks accumulate into `blocks[index]`; `visibleBlocks` counts blocks that would render (`:65-69`), and `firstVisibleSeq` is captured the moment the count first exceeds zero — so the node's anchor is *where the reader first saw content*, not where the request started (`:155-157`). `publication` returns `'none'` for `step/start` and for `usage`/`finish` chunks and `'animation-frame'` for the rest (`:321-326`).
- **Non-obvious design decisions:** `resetForRetry` clears the accumulated blocks but **keeps `firstTokenTime`** (`:82-87`) — the turn's TTFT is a fact about the request, not about one attempt. The tool-call protocol block records only identity and name while streaming: `argsRaw` stays `''` (`:129-134`).
- **Edge cases / failure handling:** an Assistant that retires without a visible message keeps its key as a *hidden* node, so a retry in the same Step reuses the key when content returns (`packages/client/ui-chat/README.md:55`). An interrupted turn materializes an assistant node from the closed boundary at a synthetic seq, but only if there is interruption evidence (`:214-227`).
- **Surprising:** the `anchorSeq` of a settled assistant is the *first visible* seq, not the message seq — this is why an assistant's row does not jump when text arrives late.

### packages/client/ui-chat/src/client/conversation-nodes/message.ts
- **Purpose:** the user / steering / context / developer message Definition (154 lines).
- **Key abstractions:** `messageDefinition` (kind `input-message`) and `developerMessageDefinition` (kind `developer-message`, sharing the context presentation).
- **Data flow:** a `user/message` whose source is not `user` is a *context* injection; whether it *wakes* the Turn is decided from the inbox claim state read via `reader.previous('inbox-next-turn'/'inbox-next-step')` (`:76-91`).
- **Non-obvious design decisions:** the `idleSteer` predicate is deliberately narrow — Step 1, a next-step claim after the Turn start, **no** next-turn claim in this Turn, and no human in the same next-step batch (`:83-86`). "A human in that same next-step claim owns the opening instead of its notices."
- **Edge cases / failure handling:** a `user/message` that is a compaction checkpoint is excluded from the message Definition entirely (`isCompactionCheckpoint`, `:39-43`) so the compaction Definition owns it.
- **Surprising:** the group-tree position is assigned here and only here: `opensExchange ? 'exchange' : (human || waking) ? 'input' : undefined` (`:128`) — human input claimed for Step 1 opens an exchange; notice-woken Turns and later steering stay in the current exchange, "so they never fold earlier Turns".

### packages/client/ui-chat/src/client/conversation-nodes/inbox.ts
- **Purpose:** replay of the durable agent Inbox so Chat can tell steering from ordinary user input (143 lines).
- **Key abstractions:** `InboxState { pending, currentClaimed, claimSeq, claimedHuman }`; `materializePending` walks the splice chain (`:46-58`).
- **Data flow:** an `agent/inbox/spliced` event with `removedCount > 0` and a non-canceled outcome *claims* the removed messages; a canceled splice claims nothing and only records the insertion (`:87-112`).
- **Non-obvious design decisions:** the pending state is kept as a **splice chain** rather than a materialized array, so a long-lived inbox does not re-copy its whole list per event (`:102-108`).
- **Edge cases / failure handling:** "An entered claim logs its complete message batch before another claim; a rejected claim logs no messages, so only the current claim can classify a later `user/message`" (`:73-78`).
- **Surprising:** `withoutInserted` copies the claimed set lazily — `next ??= new Set(claimed)` — so the common no-change path allocates nothing.

### packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts
- **Purpose:** the Turn-scoped process range and the answer boundary (324 lines).
- **Key abstractions:** `processSpec(state, turn)` (`:124`); `updateProcessState` (`:170`); `visibleChunk` / `visibleAssistantEvent` (`:48-72`).
- **Data flow:** the spec's `processStartSeq` is the Turn start when known, else the earliest process evidence; `answerAnchorSeq`/`answerStep` come from the latest step's finalized assistant (`:158-167`). The answer is only established when a streamed answer *finalizes* — the spec keeps `answerAnchorSeq: null` while it is still running (`:137-147`).
- **Non-obvious design decisions:** "The final answer is the latest Step's settled Assistant reply, provided it has visible reply content and no tool-call block" (`packages/client/ui-chat/src/client/conversation-nodes/README.md:97`). The message count excludes the answer's own step when an answer exists (`:129-133`).
- **Edge cases / failure handling:** the view node is *not* re-published while the Turn and its latest step are both open and the counts are unchanged (`:284-293`) — a streaming frame must not churn the node key.
- **Surprising:** `visibleChunk` treats a `block-start` of type `text`/`reasoning`/`tool-call` as *not* visible evidence, so a tool-call head does not start the process range.

### packages/client/ui-chat/src/client/conversation-nodes/turn-tail.ts
- **Purpose:** the completed-turn footer Definition (164 lines).
- **Key abstractions:** `tailData(context)` (`:63`); `deriveTurnTokenUsage` from `@deepseek-ai/dsh-token-meter/client` (`:90-92`).
- **Data flow:** `closing` is the last finalized assistant that carries non-blank text, sorted by final-node seq (`:73-76`). `branchUnavailable` is true when later non-rendered evidence (a tool call, a tool result, a turn error, a retry) exists past the closing message (`:77-89`).
- **Non-obvious design decisions:** the closing assistant is found by `findLast(hasText)` rather than "the last assistant" — an assistant that finalized with no text does not become the closing reply.
- **Edge cases / failure handling:** `tokenUsage` is only derived when the context's start event is a `turn/start`, so a partial window cannot report a misleading total (`:90-92`).
- **Surprising:** the footer publishes `turn/end` immediately but every other event as `'none'` — the footer appears exactly once, when the Turn ends.

### packages/client/ui-chat/src/client/conversation-nodes/turn-process-presentation.ts
- **Purpose:** cross-node process layout facts per Turn (145 lines).
- **Key abstractions:** `derivePresentation(turn, locations, nodes)` (`:27`); `ChatTurnProcessProjector` with `replace`/`update`/`get` (`:80`).
- **Data flow:** it finds the Turn's `turn-process` control node, then classifies every visible node of the Turn into "interleaved input" (an input after the opening human anchor), "external process" (a process node that is not the answer step), and "compact answer" (whether the answer can be compacted away).
- **Non-obvious design decisions:** the presentation is keyed by Turn and *recomputed only for the Turns an update touched* (`:126-136`) — the whole point is that a streaming assistant frame does not re-derive every Turn.
- **Edge cases / failure handling:** `hasInterleavedInput` disables whole-Turn collapse, because an input in the middle of a Turn's process means the process cannot be hidden as one unit (`packages/client/ui-chat/src/client/conversation-nodes/README.md:90`).
- **Surprising:** the projector holds the spec by reference, so `samePresentation` compares `left.spec === right.spec` — identity, not field-by-field.

### packages/client/ui-chat/src/client/conversation-nodes/turn-navigation.ts
- **Purpose:** derive one rail item per loaded Turn (97 lines).
- **Key abstractions:** `PROMPT_PREVIEW_LIMIT = 50`, `RESPONSE_PREVIEW_LIMIT = 120` (`:12-13`); `preview(parts, limit)` (`:19`); `turnNavigationItem(turn, locations, nodes)` (`:79`).
- **Data flow:** the anchor is the Turn's first `user` node, else its first visible node; the response preview is the last visible assistant with text (`:84-96`).
- **Non-obvious design decisions:** the preview is **per-part bounded**: "this runs on every structural rail update, so one huge text block must not be concatenated (and regex-normalized) whole for a preview this short" (`:27-31`).
- **Edge cases / failure handling:** a Turn whose window starts mid-Turn has an empty prompt preview — the empty string, not a guess.
- **Surprising:** the budgets are "sized to the rail card's clamps … and mirrored by the turnOutline projection so a turn shows the same words before and after its events load" — the client deliberately duplicates the host's number because the wire boundary forbids sharing code.

### packages/client/ui-chat/src/client/conversation-nodes/group-tree-segments.ts
- **Purpose:** splits the loaded Turns into consecutive *exchange* segments (91 lines).
- **Key abstractions:** `GroupTreeSegments(position)` with an `openings` map and `latestOpening` / `latestStart` (`:15-24`).
- **Data flow:** `track(previous, next)` adjusts the per-Turn opening count; `settle(turnOrder)` computes the latest segment's start and returns only the Turns that entered or left it (`:56-70`).
- **Non-obvious design decisions:** "Node changes update per-Turn counts without scanning the loaded Nodes" — the segment is derived from counts, not from a full re-scan (`:8-13`).
- **Edge cases / failure handling:** when the last opening Turn's count drops to zero, `latestOpening` falls back to the last *remaining* opening Turn (`:33-35`, `:76-82`).
- **Surprising:** the segment start falls back to `turnOrder[0]` when no opening Node is loaded at all — the whole loaded window is then one exchange.

### packages/client/ui-chat/src/client/conversation-nodes/command.ts
- **Purpose:** the slash-command Definition with manual-compaction correlation (227 lines).
- **Key abstractions:** `compactSource(event)` (`:78`); `compactSummary(match, checkpoint)` (`:101`); `updateCompactionState(state, match)` (`:164`, shared with the automatic compaction Definition).
- **Data flow:** a compaction checkpoint is a *replacement-surface* `user/message` whose source carries `kind: 'compact-checkpoint'` and a `compactionId`; a manual `/compact` additionally carries `sourceCommandId`, which is what correlates the command row with the compaction marker (`:82-92`).
- **Non-obvious design decisions:** the compaction summary's `shadowedItemCount` / `shadowedTokenCount` are only set when the recorded arrays/numbers are *structurally valid* — otherwise `null`, which the UI renders as "unavailable" rather than as zero (`:113-120`).
- **Edge cases / failure handling:** `fallbackState` reconstructs a `compact` command node from the checkpoint alone when the command event is not in the window (`:140-155`).
- **Surprising:** `compactSource`/`compactSummary` are re-exported at the bottom of this file (`:227`) precisely so the automatic-compaction Definition can share them — one implementation, two lifetimes.

### packages/client/ui-chat/src/client/conversation-nodes/compaction.ts
65-line Definition for *automatic* compaction: it renders the landed checkpoint marker and explicitly declines any compaction that carries a `sourceCommandId` (that one belongs to the command Definition) — `:42`. `buildViewNode` returns `null` until a checkpoint is present, so the marker appears only once the compaction actually landed.

### packages/client/ui-chat/src/client/conversation-nodes/retry.ts
- **Purpose:** the model-retry chain Definition (97 lines).
- **Key abstractions:** `RetryState { turn, step, attempts }`; `ModelRetryNode` with `retryState: 'scheduled' | 'started' | 'cancelled'`.
- **Data flow:** every `llm/retry` with the same `retryId` is an attempt on one chain; `llm/retry-started` flips that attempt to `started` (`:66-72`).
- **Non-obvious design decisions:** the chain is identified by the *producer's* `retryId`, not by turn/step — a chain may span a Step boundary.
- **Edge cases / failure handling:** "A scheduled attempt is cancelled once either owning boundary closes" (`:34-38`) — the last attempt is rewritten to `cancelled` at build time rather than needing an event.
- **Surprising:** the node sits at the `process` group-tree position, so a retry separates two secondary groups without ending the whole-Turn fold.

### packages/client/ui-chat/src/client/conversation-nodes/turn-error.ts
- **Purpose:** the terminal turn-failure Definition (120 lines).
- **Key abstractions:** `endFailure(reason)` maps a `TurnEndReason` to a message and a stable code (`:36-51`).
- **Data flow:** `error` → the provider's failure; `aborted` with a `deepseek-account/signed-out` hook → `ACCOUNT_SIGNED_OUT`; `interrupted` → `INTERRUPTED` with "The DSH process exited before this turn finished."
- **Non-obvious design decisions:** "User and parent cancellations show only the stopped turn summary" — a plain `aborted` produces **no** failure row (`:41-43`). Completed, blocked, max-tokens, forked and plugin-merged endings also produce none (`:47-49`).
- **Edge cases / failure handling:** "Retries run inside the failing turn, so the turn's `llm/retry` history never suppresses this terminal row" (`:75-77`).
- **Surprising:** the `INTERRUPTED` code means *the DSH process died*, not that the model stopped — the message says so explicitly.

### packages/client/ui-chat/src/client/conversation-nodes/turn-max-tokens.ts
82-line Definition for a turn the provider ended at its output-token cap. The interesting part is `noticeAnchor` (`:32-39`): the notice is anchored at `closing.finalNode.seq + 0.05` so it sits **between** the closing assistant and the turn tail, keeping the tail the turn's last node with its branch action enabled.

### packages/client/ui-chat/src/client/conversation-nodes/request-prompt.ts
- **Purpose:** the system-prompt surface node and the request-header prompt card (163 lines).
- **Key abstractions:** `systemMessageDefinition(inspect)` and `requestPromptDefinition(inspect)` — both take their interpretation from the uiConversation service, because "a client bundle cannot value-import it" (`:87-89`).
- **Data flow:** the request-prompt Definition reads the *previous* request-prompt state and the *system* state through `reader.previous(...)`, and decides `showsPrompt` from the inspection's change kind (`:99-132`).
- **Non-obvious design decisions:** "Initial cards precede their step's input; in-history updates stay at their own positions" (`:55-58`), and "Positional replacements advance the effective prompt without changing historical cards" (`:58-59`).
- **Edge cases / failure handling:** `stableRequestPromptAnchor` keeps an already-rendered prompt at its page-lifetime presentation anchor, so paging does not move the card (`:39-49`). A same-step header must not repeat a prompt already shown by an appended system message (`:111-117`).
- **Surprising:** the system-message Definition "owns every `system/message` event on the Chat target so the unknown-surface fallback never renders the prompt as a transcript row" (`:54-56`).

### packages/client/ui-chat/src/client/conversation-nodes/event-projection.ts
- **Purpose:** conversion from durable Session events to Chat view data (179 lines).
- **Key abstractions:** `contextForm(source)` (`:47`); `contextProducer(source)` (`:60`); `sessionRecallLabels` / `skillInvocationName` (`:83`, `:94`); `toAssistantBlock(s)` (`:105`, `:114`); `displayFailure(failure)` (`:149`); `isTokenDelta(chunk)` (`:167`).
- **Data flow:** every reader narrows `unknown` with `asRecord` first; a source that is not a readable record degrades rather than throwing. The answer exemption comes from the Turn's process spec (`answerAnchorSeq`/`answerStep`) rather than from a group-tree position, because *which step* answers changes as later steps arrive — `latestAnswer` re-reads the Turn's last step every time (`packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts:117-122`).
- **Non-obvious design decisions:** `displayFailure` **drops the message of an `AUTH` failure**: "Provider AUTH messages may echo a masked or partially preserved credential. Keep the raw diagnostic in the Session log, but never retain it in UI state." (`:153-157`). The block union is merge-extensible, so an unknown block is preserved as `{ kind: 'other', block }` rather than dropped (`:120`).
- **Edge cases / failure handling:** `KNOWN_FORMS` is an explicit allow-list; an unrecognized form returns `null` and renders as the opaque body.
- **Surprising:** the file opens with `/* jscpd:ignore-start */` — the duplication detector is deliberately suppressed here because "Chat and Trajectory own independent event-to-view projections" (`:8`).

### packages/client/ui-chat/src/client/conversation-nodes/fallback.ts
41-line unknown-surface fallback Definition: any append-surface event no other Definition claims still becomes a JSON row (`:19-20`), keyed by its seq. Registered with `registerFallback` so it is the *last* resort, not a competing Definition.

### packages/client/ui-chat/src/client/conversation-nodes/common.ts
- **Purpose:** shared constants and helpers for the Definitions (83 lines).
- **Key abstractions:** `CHAT_SYNTHETIC_SEQ_OFFSETS = { interruptedAssistant: -0.9, interruptedFollowup: -0.8, processControl: -0.1, maxTokensNotice: 0.05, finalizedFollowup: 0.1 }` (`:15-21`).
- **Data flow:** a node's `anchorSeq` is the durable event seq plus, for UI-only rows, a fractional offset — so a synthetic row sorts *between* two durable events without the event log ever containing it.
- **Non-obvious design decisions:** the comment explains each offset's purpose: the max-tokens notice sits at `+0.05` "so the tail stays the turn's last node and keeps its branch action enabled" (`:9-14`).
- **Edge cases / failure handling:** `coordinate(value)` accepts only a safe non-negative integer — a malformed coordinate is `undefined`, not a negative number.
- **Surprising:** fractional seq offsets are how a UI inserts a *control* row into an event-ordered list without rewriting the log.

### packages/client/ui-chat/src/client/conversation-nodes/register.ts
38-line registration entry point: fourteen node Definitions, the Chat view builder, and the process-group definition, in a fixed order (inbox → messages → request-prompt → assistant → turn-process → tool → command → compaction → retry → turn-error → turn-max-tokens → turn-tail → fallback → view → groups).

### packages/client/ui-chat/src/client/chat/flow-motion.ts
- **Purpose:** the fold-transition coordinator (532 lines) — the mechanism behind "the work collapses without the transcript jumping".
- **Key abstractions:** `FlowMotionRows` (collapse/reveal/cancelMotion, `:19-26`); `InputFoldBox` (`:29`); `InputFoldDriver` (begin/prepare/frame/finish, `:37-65`); `OwnedBox` (`:114-133`).
- **Data flow:** `collapse(element, done)` measures the box, marks `data-chat-motion="collapse"`, and schedules a batch via `queueMicrotask` so *all* of a commit's collapses and reveals start before any box changes size (`:314-320`). `runBatch` then drives every closing and revealing box on **one** `requestAnimationFrame` clock and calls `driver.prepare/frame/finish` with the same eased progress (`:170-287`).
- **Non-obvious design decisions:** "Every batch containing a closing row moves its boxes and the scrollport on one frame clock; a batch that only reveals rows … uses CSS transitions" (`:1-6`). A travelling (scrolling) box stays **opaque** while it shrinks, because "A travelling box clips its content as it shrinks, so nested closing rows keep their size until it ends" (`:209-223`). A box that changes while a batch runs is *held* — it keeps its size until the next batch drives it (`:126-128`). Motion is opt-in via a `[data-chat-motion]` scope and disabled under `prefers-reduced-motion` (`:88-91`).
- **Edge cases / failure handling:** `clearMotion` restores every inline style it wrote (`height`, `marginTop`, `opacity`, `overflow`, `transition`, `translate`) and deletes the dataset flag, so an unmounted row leaves no residue (`:344-361`). A row with zero height collapses synchronously with no timer and no reservation (`:371-375`).
- **Surprising:** `revealedShare` continues a reveal from *the share its own transition already reached* (`:108-111`), so taking over a half-finished CSS transition does not restart it.

### packages/client/ui-chat/src/client/chat/use-chat-viewport.ts
- **Purpose:** the 800-line DOM owner of one Chat scrollport.
- **Key abstractions:** `ChatViewport` (`:60`); `ViewportScroll` / `ViewportLanding` (`:10-20`); `FoldReader` (`:41-48`); `PagingPosition` (`:50-54`).
- **Data flow:** `attach()` finds the shared `[data-conversation-scroll]` scroller (or the list itself), binds `scroll` / `scrollend` / five reading-intent events, and observes the column, the scroller and the composer with one `ResizeObserver` (`:85-107`).
- **Non-obvious design decisions:** `readingReference()` binary-searches the *direct* Node/Group boxes to find the first visible top-level row that holds no batch box — O(log n) and no hit testing (`:383-406`). `readVisibleTurn` is explicitly *approximate*: "Gaps retain the last visited Turn candidate, not necessarily the immediate predecessor" and it "neither hit-tests the document nor searches Group members" (`:529-535`). `preserve()` compensates the inner group's own scroll first and gives the remainder to the outer scrollport, cancelling the group's follow animation so the reader's anchor wins (`:663-700`).
- **Edge cases / failure handling:** paging anchor selection "skips hidden and empty markers without reading their geometry"; the anchor is re-resolved by *semantic key* if segmentation remounted the row (`:667-676`). `reclaimBelow` refuses to trim the scroll range before sampling, "because trimming the range before sampling could misclassify a reader's move as a layout clamp" (`:424-425`).
- **Surprising:** the transcript root uses `overflow-y: clip` (not `auto`) so sticky Markdown banners keep the *conversation* scrollport as their reference (`packages/client/ui-chat/README.md:137`); the viewport compensates for that by finding the scroller with `closest('[data-conversation-scroll]')`.

### packages/client/ui-chat/src/client/chat/use-chat-reading.ts
- **Purpose:** follow-tail ownership, sampled reader movement, semantic scroll memory (282 lines).
- **Key abstractions:** `ChatReading` (`:27`); `ReadingSample` (`:18`); `FOLLOW_THRESHOLD = 24`, `SCROLL_SAMPLE_INTERVAL_MS = 500` (`:7-8`).
- **Data flow:** `onScroll` distinguishes *pinned* deliveries (not reader-moved, or reader-moved and within 1px of the floor) — those update follow **immediately** — from ordinary movement, which stays pending until the sample interval or `scrollend` (`:158-168`). `flushSample` then decides follow and captures a semantic position (`:242-258`).
- **Non-obvious design decisions:** "Pinned scroll deliveries without reader movement, and reader input that reaches the floor within subpixel rounding, update follow ownership immediately, before subsequent layout changes can invalidate their floor. Other reader movement remains pending until the sampling interval or `scrollend`, even inside the follow threshold, so layout growth cannot erase small scroll gestures." (`packages/client/ui-chat/README.md:133`).
- **Edge cases / failure handling:** a native follow animation in progress is not reader movement (`if (this.follow.animating) return`, `:160`); only the *outer* scroller's `scrollend` may settle it, because a process body's `scrollend` must not end the outer animation (`:174-189`).
- **Surprising:** `commit()` saves `null` to the scroll store when following the tail and a semantic position otherwise — the store's "no saved position" *means* "follow the tail" (`:210-216`, `:271-275`).

### packages/client/ui-chat/src/client/chat/use-chat-scroll.ts
- **Purpose:** composes viewport + reading + navigation into the Chat's scroll behaviour (181 lines).
- **Key abstractions:** `ChatScrollInput` (`:12`); `processContent` (`:63`).
- **Data flow:** each commit compares the current input against the previous one to compute `ownInput` — a new last user key, a changed steering id, or a changed submission id that is not the other one (`:67-71`). `ownInput` supersedes pending reader sampling; otherwise a pending sample blocks the update entirely.
- **Non-obvious design decisions:** "If this client sent the message, or the reader was following the tail, the transcript lands on the new message; otherwise, such as a message from another tab or a queued message delivered after the previous Turn, the content the reader is looking at stays still." (`packages/client/ui-chat/README.md:141`). Under the deferred-folding mode the fold *owns* the tail movement (`reading.followInputFold()`, `:82`), so there is no separate scroll animation.
- **Edge cases / failure handling:** a work-details mode change cancels the pending follow, interrupts the native animation, and defers the scroll-range reset to `motion.onFoldIdle` so it never lands mid-fold (`:157-167`).
- **Surprising:** `deferCollapse` is computed *outside* the scroll hook (`packages/client/ui-chat/src/client/chat/ChatView.tsx:177-178`): a pending transcript submission ends the "keep the last exchange open" exemption, but a *queued* submission does not.

### packages/client/ui-chat/src/client/chat/use-scroll-follow.ts
- **Purpose:** the bottom-follow intent plus native smooth scrolling (182 lines).
- **Key abstractions:** `ScrollFollow` (`:22`); `scrollMetrics(element)` (`:16`).
- **Data flow:** `sample(metrics, movedByReader)` updates intent only for *attributed* reader movement (`:90-95`); `settle(metrics)` clears the outstanding target and decides whether the animation actually reached it (`:102-107`); `toBottom(...)` follows the measured floor (`:138-158`).
- **Non-obvious design decisions:** an outstanding native target is **retargeted** on growth rather than restarted: "Content grew under an outstanding animation: retarget it instead of cutting to the floor" (`:141-147`). A fractional no-op that cannot move is positioned immediately, "so a fractional no-op cannot leave a pending smooth target" (`packages/client/ui-chat/README.md:163`).
- **Edge cases / failure handling:** `interrupt(element, metrics)` stops the animation *where it is* and records that position as the sampled one, "only subsequent actual movement changes follow intent" (`:165-170`). Reduced motion downgrades to `jump`.
- **Surprising:** the controller is registered in a static `WeakMap` by element (`ScrollFollow.owners`, `:23`) so a compensation write can find the controller that owns a scrollport without threading it through props.

### packages/client/ui-chat/src/client/chat/use-chat-navigation.ts
- **Purpose:** turn jumps and history paging (206 lines).
- **Key abstractions:** `ChatNavigation` (`:26`); `TurnJump { turn, seq, phase, landing, repageHead }` (`:17-23`).
- **Data flow:** a *loaded* Turn scrolls directly; an *unloaded* one starts `loadThrough(seq)`, retains the current reading position, pauses follow, and retries a frame later when the page settles (`:69-91`, `:170-183`).
- **Non-obvious design decisions:** a reader gesture during a landed jump marks the jump `interrupted` (`:105-108`); a repage is issued when the window still does not cover the target seq, and `repageHead` prevents re-requesting the same head (`:140-146`).
- **Edge cases / failure handling:** `cancel()` releases the jump, the paging anchor and the busy indicator *without* cancelling shared history I/O — the host's page request is not this object's to cancel (`:53-57`).
- **Surprising:** the fallback path `scrollToTurnAtOrAfter` finds the nearest mounted row at or after the requested turn rather than failing, so a jump into an unloaded region still lands somewhere useful (`:147-149`).

### packages/client/ui-chat/src/client/chat/use-process-scroll.ts
88-line hook for a capped process group: its **own** follow controller, edge fades, and interruption on wheel / touchstart / any pointerdown / an unprevented scroll key (`:57-65`). A group opened manually starts at the bottom and follows growth; a closed group opened manually starts at the top with following disabled (`packages/client/ui-chat/src/client/conversation-nodes/README.md:186`).

### packages/client/ui-chat/src/client/chat/use-disclosure.ts
- **Purpose:** independent disclosure state bound to a reset generation (35 lines).
- **Key abstractions:** `useDisclosure(version = 0)` (`:11`); `bindDisclosure(reset)` (`:28`).
- **Data flow:** `expanded` is `expandedVersion === version`; a reset bumps the version, which closes every disclosure bound to that source at once, while each invocation keeps its own state.
- **Non-obvious design decisions:** the subscription is created *inside* the returned Hook, so "a Hook without subscribing until a component calls it" (`:24-27`) — a seat that never opens a disclosure never subscribes.
- **Edge cases / failure handling:** a mode change does not bump the version, so "Display-mode changes preserve their open state" (`packages/client/ui-chat/README.md:122`).
- **Surprising:** the reset is a *number*, not a boolean — a monotonic counter is what makes "reset all consumers of the same source" expressible.

### packages/client/ui-chat/src/client/chat/searchable-hidden.ts
45-line hook: hides with `hidden="until-found"` (not `display:none`) so the browser's find can still reach the content, refuses to hide a subtree that contains the focused element, and listens for `beforematch` to reveal.

### packages/client/ui-chat/src/client/chat/ChatView.tsx
- **Purpose:** the Chat view component (290 lines).
- **Key abstractions:** `observedInputs(order, nodes)` (`:33`); the `visibleSubmissions` reconciliation (`:155-161`); the `pendingInputs` merge (`:162-176`).
- **Data flow:** a local submission echo is suppressed once a durable node with the same `rpcId` appears in the visible order; an Inbox steering item is replaced by the local submission that owns the same `rpcId` (`:167-175`).
- **Non-obvious design decisions:** the echo reconciliation is driven by the `order` array identity: "durable user material always arrives as an append, and every append replaces the order array" (`:152-154`). The file-open error dialog uses a monotonic request counter so "a cancelled in-flight refusal" cannot reopen the dialog after a newer gesture (`:114-139`).
- **Edge cases / failure handling:** the file-open dialog offers retry of the *same* path, and a failure surfaces the Host's refusal message with a locale fallback (`:23-26`).
- **Surprising:** "No pending placeholders: questions (ui-user-questions) and approvals (ApprovalPanel) both take over the composer, so a flow card would double-render the same wait." (`:232-234`).

### packages/client/ui-chat/src/client/chat/ChatFlow.tsx
61-line flow renderer: maps the mixed `node`/`group` entries to `ChatNodeSeat` / `ChatGroupSeat`, appends the pending echo rows and the running status, and splices one local transcript echo *before* an empty opening Turn control so "the control and echoes share one keyed list, so arrival of the control preserves the echo's mounted identity" (`:55-60`).

### packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx
- **Purpose:** the per-node seat (163 lines).
- **Key abstractions:** `processMember` / `processAnswer` / `ownsDisclosure` (`:87-105`); `turnProcess` owner props (`:106-121`).
- **Data flow:** the seat subscribes one key (`useChatNode(nodeKey)`), derives the process membership from the Turn-process spec plus the presentation, and applies `useGroupAction(processHidden, revealProcess)` for the viewport-bound hiding.
- **Non-obvious design decisions:** `processWindowReady` accepts a Turn whose *end* is loaded but whose *start* is not — "A loaded end makes a partial historical Turn eligible without its start" (`:72-77`). When the enclosing Turn hides the node, the seat bumps its `disclosureReset` counter, which closes the inner reasoning/tool disclosures *without* replacing component keys (`:120-124`).
- **Edge cases / failure handling:** a split node's flow key is `JSON.stringify([key, groupPart])` for the reasoning part but the plain key for the response part, so Turn navigation addresses the original node key and lands on its first visible part (`:145`, `packages/client/ui-chat/README.md:104`).
- **Surprising:** the renderer is dispatched with the node *inside* the owner object, because "TypeScript does not distribute an object containing a union into a union of objects itself" (`:141-144`).

### packages/client/ui-chat/src/client/chat/ChatGroupSeat.tsx
- **Purpose:** the process-group seat (163 lines).
- **Key abstractions:** `useStableLiveProcessTitle` (`:65`); `ProcessGroupHeader` (`:100`).
- **Data flow:** the header subscribes the group's own data (`useChatGroup(groupKey, group => group?.data)`) so "group headers subscribe to data separately from member arrays" (`packages/client/ui-chat/README.md:102`).
- **Non-obvious design decisions:** a live title is held for at least 150 ms and only the newest pending title is retained (`:149` in the business rules). The height cap applies only to a group the reader opened: "a body that is closing keeps its flat height so the transition starts from what is on screen instead of snapping to the cap first" (`:180-181`). A group whose whole Turn is folding never shows a header in the frame it starts closing (`:162-163`).
- **Edge cases / failure handling:** a group that starts at the bottom when manually opened while still running, and at the top when opened after it closed (`:175-178`).
- **Surprising:** the group's disclosure state is *local* to the seat (`useDisclosure()`), not to the store — "Each group owns local `useDisclosure` state that survives mode changes while its component stays mounted." (`packages/client/ui-chat/README.md:118`).

### packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx
- **Purpose:** renders the assistant's blocks (150 lines).
- **Key abstractions:** `localPathMediaUrl(base, value)` (`:25`); the `ProcessReasoning` wrapper (`:139`).
- **Data flow:** text → `MarkdownText` with file mentions and a `pathImages` resolver; reasoning → a `ReasoningRow` per non-blank block; images → consecutive image blocks merged into **one** gallery keyed by the group's *first* block index, "so a streaming append that extends the group then only grows `images` instead of remounting the gallery under a shifted key" (`:108-127`).
- **Non-obvious design decisions:** the Markdown `labels` object is memoized on the locale seat's identity ("a fresh object per render would rebuild MarkdownText's component table every chunk", `:60-62`).
- **Edge cases / failure handling:** a node that contains only tool-call heads renders nothing at all, "a node that is only those heads (or empty) would paint an empty root between tool groups" (`:68-74`).
- **Surprising:** `localPathMediaUrl` decodes URL escapes exactly once and returns `undefined` for malformed escapes, because "Malformed URL escapes cannot identify a file" (`:29-31`).

### packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx
51-line keyed renderer: computes the turn-tail ownership (only when the Turn is closed and this assistant *is* the tail's closing node), resolves the file-mention vocabulary for that closing turn, and marks the answer's reasoning as hidden when the Turn process is folded.

### packages/client/ui-chat/src/client/chat/ReasoningRow.tsx
- **Purpose:** the reasoning disclosure (102 lines).
- **Key abstractions:** `firstLine(text)` (`:11`); `latestCompletedParagraphFirstLine(text)` (`:16`).
- **Data flow:** the collapsed summary is the running block's latest *completed* paragraph first line, or the settled block's first line; `**` markers are stripped (`:56-57`).
- **Non-obvious design decisions:** "A blank streaming tail produces no row and does not transfer its running state to an earlier block" — the running flag is `streaming && i === last` on the *block* index (`packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx:103`). The preview is rendered only when `!expanded && summary !== '' && (running || policy.settledReasoningPreview)` — so Compact shows no settled preview but still shows the running one (`:58-59`).
- **Edge cases / failure handling:** the expanded body is mounted lazily through the replaceable Body Slot and only when expanded (`:70-74`).
- **Surprising:** the summary keeps heading syntax (it is truncated at the first newline, not stripped of Markdown), while the expanded body renders compact Markdown headings.

### packages/client/ui-chat/src/client/chat/ReasoningContent.tsx
26-line official reasoning Content Factory (root-scoped, so no Session is needed) plus the default Body adapter that calls the same Factory — "so a replacement sees one seam" rather than two.

### packages/client/ui-chat/src/client/chat/MessageItem.tsx
- **Purpose:** the keyed renderers for the non-assistant node kinds (370 lines).
- **Key abstractions:** `UserStyleBubble` (`:164`); `PendingSubmissionBubble` (`:251`); `PendingSteeringBubble` (`:220`); `ModelRetryItem` (`:63`); `failureMessage` (`:51`).
- **Data flow:** a user message's content blocks are split into text / attachments / rest; the text and attachments go to the `conversation.chat.user.content` Factory, which owns the visual language; the row owns keys, pending/echo markers, timestamps and actions (`:185-211`).
- **Non-obvious design decisions:** the retry countdown's deadline is "anchored to this browser's first render of the retry node. Host event time and Date.now() may belong to different clocks" (`:68-70`) — the delay is measured from *when the user saw it*. Failure codes map to localized copy, with `QUOTA`/`ACCOUNT_QUOTA` deliberately rendering the neutral "Request quota exhausted." instead of the provider's message (`:51-61`).
- **Edge cases / failure handling:** the copy action writes with `writeClipboard` and never claims success when the host rejects the write; a pending echo renders exactly like its durable replacement, differing only by an invisible `data-submission-echo` marker (`:174-175`).
- **Surprising:** the same `UserStyleBubble` renders the durable row, the Host-pending steering row and the local echo — one visual language for three lifetimes.

### packages/client/ui-chat/src/client/chat/ContextInjectionRow.tsx
94-line context disclosure. The title names the producer (a plugin id, a skill name, the reconciled instruction files, or the recalled sessions) and the collapsed content adds a tool-change summary. A single tool addition/removal is named inline; multiple show counts and expand to comma-separated lists.

### packages/client/ui-chat/src/client/chat/ContextBody.tsx
- **Purpose:** the per-form expanded bodies of a context row (592 lines).
- **Key abstractions:** `contentRuns(content)` (`:42`); `OpaqueBody` (`:168`); `InstructionsBody` / `CatalogBody` / `SnapshotBody` / `NoticeBody` / `RelayBody` / `RecallBody`; `contextBody(form, props)` (`:551`).
- **Data flow:** `contextBody` *resolves* the form — it returns the form the body actually rendered as, not the declared one, so the caller can "label the row with what it really shows" (`:541-546`).
- **Non-obvious design decisions:** adjacent text blocks join with **no separator**, "matching how provider adapters flatten them — inserting a line break would show the reader a line the model never saw" (`:34-40`). Every form's parser is **all-or-nothing**: `instructionChanges` returns `null` if *any* entry is unreadable, because "silently dropping one unreadable entry would show a confident, incomplete file list for a log this version cannot fully read" (`:190-195`). The catalog caps at 200 entries and says how many it withheld, because "a provider may publish any number of skills" and "the scrollport bounds height, not node count" (`:320-322`).
- **Edge cases / failure handling:** the opaque fallback keeps the `form` declaration, "because that is the one place a form this version cannot present would otherwise disappear from the UI entirely" (`:84-87`). The model's `<system-reminder>` framing is kept verbatim because "the framing is part of what the model read" (`:241-245`). A `notice` without a recorded account falls back to opaque, because a notice whose whole point is to be readable without expanding cannot be unreadable.
- **Surprising:** the `default` arm of `contextBody` **throws** rather than degrading — the compiler rejects a new form, so a new `KnownContextForm` cannot silently become opaque (`:585-590`).

### packages/client/ui-chat/src/client/chat/GenericCommandCard.tsx
75-line command disclosure: the title is the bare command name, the collapsed content carries the settlement text (or the failure state), and the multiline body mounts only while open.

### packages/client/ui-chat/src/client/chat/CompactionItem.tsx
76-line compaction marker: shows the shadowed item/token counts, is expandable only when the cited summary event is inside the loaded window, and keeps the full transcript — "A compaction marker does not replace shadowed transcript rows" (`:1-2`).

### packages/client/ui-chat/src/client/chat/CompactionCommandCard.tsx
26-line manual-compaction card: a structured checkpoint renders as the compaction marker, every other outcome keeps the command's own settlement text.

### packages/client/ui-chat/src/client/chat/CommandNodeView.tsx
40-line command renderer dispatching to the keyed `conversation.chat.commandview` slot by command name, with the generic card as the fallback.

### packages/client/ui-chat/src/client/chat/SystemPromptRow.tsx
50-line system-prompt disclosure whose expanded body is the same opaque context chrome as an injected context row; an in-history update is titled as an update of the same row.

### packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx
62-line Turn-process control: the settled duration, the failed/stopped label, and the collapse chevron. The duration is shown only for a turn that neither stopped nor failed (`:23-26`), and the control is `disabled` when the Turn cannot be collapsed.

### packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx
- **Purpose:** the completed-turn footer (63 lines).
- **Key abstractions:** `lastContent(snapshot, turn, skipWarning)` (`:18`); `endsWithResponse` selector (`:41-49`).
- **Data flow:** the branch action is offered only when the Turn's final visible content is a reply *and* this is the latest Turn; `data-actions-reveal="always"|"hover"` switches the CSS (`:71-74`).
- **Non-obvious design decisions:** `branchUnavailable` is true when the closing message is not the Turn's last content — including a max-tokens notice (`:34-35`). The branch action "owns boundary resolution: it sends the real turn/end seq it already has, and the Host cuts exactly there" (`:68-69`).
- **Edge cases / failure handling:** an interruption-frozen partial has no `messageId`, "so they address no durable message and contribute no per-message actions" (`:51-56`).
- **Surprising:** the actions row is revealed on hover for *historical* turns and always for the latest — "Devices without hover keep actions visible" (`packages/client/ui-chat/README.md:82`).

### packages/client/ui-chat/src/client/chat/TurnTriggerNodeView.tsx
50-line notice for a non-human Turn trigger: an independently expandable bordered card with the source-family icon, the recorded time and the recorded body. Opening it "does not imply successful execution" (`packages/client/ui-chat/src/client/conversation-nodes/README.md:84`).

### packages/client/ui-chat/src/client/chat/TurnUsagePanel.tsx
110-line per-turn usage pill and portaled dialog. The cache-hit percentage is computed against `totalTokens - outputTokens` (the prompt side), and every optional bucket is omitted when absent rather than shown as zero.

### packages/client/ui-chat/src/client/chat/StatsPills.tsx
- **Purpose:** the two composer-dock statistics pills (316 lines).
- **Key abstractions:** `deriveStats(nodes)` (`:57`); `cacheHitPercent(usage)` / `billedInputTokens(usage)` (`:104`, `:113`); `useSessionStats` (`:166`).
- **Data flow:** every displayed figure prefers the durable `sessionStats` / `tokenUsage` projections; the window-scoped `deriveStats` fold is the fallback for assemblies without them, and its field names "deliberately mirror the projection's so the two swap wholesale" (`:44-50`).
- **Non-obvious design decisions:** the usage pill is gated on actual billing: "a session whose steps all settled without billing (e.g. every request failed) shows no usage pill" (`:285-287`). The activity pill degrades to a plain reading when there are no dialog rows to show (`:246-248`).
- **Edge cases / failure handling:** a projection of defined zeros counts as empty rather than as a fallback to the window fold (`:163`).
- **Surprising:** the fold is documented as answering "what is on screen" only — "Every displayed figure rides that durable whole-log projection … because the window is paged and compaction rewrites it" (`:43-50`).

### packages/client/ui-chat/src/client/chat/stat-dialog.ts
76-line dialog seat: `useAnchoredPosition` clamps the panel inside the viewport, Escape closes, and a **capture-phase** document click closes the dialog so a sibling pill's keyboard activation swaps dialogs instead of stacking them (`:64-74`).

### packages/client/ui-chat/src/client/chat/TurnNavigator.tsx
- **Purpose:** the fixed-pitch virtual turn rail (302 lines).
- **Key abstractions:** `TurnNavigatorHandle { activateTurn, scrollToTurn }` (`:24`); `useVirtualizer` with `TURN_SPACING_PX = 10` and `RAIL_INSET_PX = 6` (`:33-36`); the `rangeExtractor` that also mounts the focused mark's neighbours (`:195-206`).
- **Data flow:** the rail's initial placement waits for the body's restored active Turn *and* the rail's first usable viewport size; placement happens inside the `ResizeObserver` callback, "without scroll commands" (`tests/turn-navigator.client.spec.tsx`).
- **Non-obvious design decisions:** a pointer inside the rail suppresses auto-follow, "While the pointer works the rail, follow must not move it under the hand" (`:106`). Previews follow pointer movement or focus, not scrolling under a stationary pointer (`:283`).
- **Edge cases / failure handling:** the active mark centers only after it leaves the fade-free band; while it is inside, the rail stays still.
- **Surprising:** `getItemKey` is the *turn number*, so a re-order of the rail does not remount a mark, and `estimateSize`/`measureSize` are constants — the rail never reads the DOM scroll extent.

### packages/client/ui-chat/src/client/chat/MessageIconActions.tsx
115-line shared copy/branch/clock row. The copy action is epoch-guarded: `copyEpoch.current += 1` on unmount and a stale write is discarded (`:59-77`), so "user copy never claims success when the host rejects the write". The branch button uses `aria-disabled` rather than `disabled`, "because native disabled buttons do not deliver the hover/focus events Tooltip needs" (`:100-102`).

### packages/client/ui-chat/src/client/chat/message-chrome.ts
100-line formatting helpers: `formatRunDuration` (hours from 60 minutes, minutes from 60 seconds, no leading zero, negatives clamped), `formatTokensPerSecond` (whole from ten up), `formatMessageClock` (same day → `HH:mm`, earlier this year → `clock.md`, other years → `clock.ymd`), and the local-midnight helpers.

### packages/client/ui-chat/src/client/chat/token-format.ts
- **Purpose:** token count and cache-hit percentage formatting (108 lines).
- **Key abstractions:** `formatTokens` (`:10`); `formatExactTokens` (`:27`); `formatCacheHitPercent` (`:67`).
- **Data flow:** `formatCacheHitPercent` binary-searches the threshold units rather than dividing, so the result is exact at the chosen precision.
- **Non-obvious design decisions:** "Display-ready cache-hit share without rounding a partial hit to 100%" (`:62-65`): when the ordinary rounding *would* reach 100 but the hit is partial, the function adds decimal places until the value is distinguishable (`:80-97`), producing values like `99.95`.
- **Edge cases / failure handling:** no prompt tokens → `null` (no percentage at all); a full hit → exactly `"100"`.
- **Surprising:** this is the exact August problem "a partial hit must not read as a full hit" — solved by choosing the *precision*, not by lying about the number.

### packages/client/ui-chat/src/client/chat/step-process.ts
28-line title composition for a closed group: the top three ranked categories, joined with "and" / commas, and "etc." beyond three. Chinese removes the second leading `已` only when both labels share it (`:19-22`).

### packages/client/ui-chat/src/client/chat/turn-assistant.ts
10-line helper: concatenates the visible text blocks of an assistant lifecycle.

### packages/client/ui-chat/src/client/chat/turn-rail-items.ts
- **Purpose:** the view-layer union of the host turn outline and the loaded rail items (77 lines).
- **Key abstractions:** `TurnRailItem` with `anchor: { kind: 'loaded', key } | { kind: 'unloaded', seq }` (`:21-27`); `outlineEntry(value)` (`:38`).
- **Data flow:** the outline supplies every Turn of the session; the loaded window supplies anchors and richer previews; the merge prefers the loaded side and fills an empty preview from the outline.
- **Non-obvious design decisions:** the outline is treated as **wire data** and structurally narrowed: "their damage drops the entry; the previews are decorative, so a malformed one degrades to `''` and the turn stays navigable by number" (`:28-34`).
- **Edge cases / failure handling:** `Object.is(entry.seq, -0)` is rejected — `-0` would break the seq comparison.
- **Surprising:** "the conversation snapshot never carries projection values, so this merge is the one place the rail's two sources meet" (`:4-9`).

### packages/client/ui-chat/src/client/chat/turn-trigger.ts
71-line mapping from a recorded trigger source to a localized title key and an icon family; an unknown source keeps the generic execution-request title rather than attributing unrecorded identity or success (`:66-68`).

### packages/client/ui-chat/src/client/chat/use-calendar-day.ts
25-line hook that advances at each local midnight so a memoized row's clock stays date-correct without a framework-level tick.

### packages/client/ui-chat/src/client/chat/use-turn-data.ts
23-line hook: `useTurnDataValue(data, key)` subscribes to one value of a Turn's keyed Location-data store through `useSyncExternalStore`.

### packages/client/ui-chat/src/client/chat/QuotaNoticeHost.tsx
27-line frame-wide host: it holds the one live notice for the whole app and offers it to the `shell.quota-notice` chain, falling back to a warning Toast. The `key` on the fragment restarts the transient display for an unretained later notice (`:21`).

### packages/client/ui-chat/src/client/chat/ApprovalCommand.tsx
40-line approval detail: resolves the correlated Tool call's `command` from its raw JSON arguments, returning `undefined` for absent, malformed or unrelated arguments (`:16-24`).

### packages/client/ui-chat/src/client/chat/register-node-renderers.ts
90-line registration of every keyed renderer plus the reasoning content Factory and the default reasoning body entry at priority 100. The `assistant-step` entry declares its two child slots; the `turn-tail` entry injects the performance-usage preference and declares the tail and assistant-actions list slots.

### packages/client/ui-chat/src/client/chat/render-entry.ts
16-line helper producing a collision-free React key per render entry: `JSON.stringify(['node', key, groupPart ?? null])` or `JSON.stringify(['group', key])`.

### packages/client/ui-chat/src/client/chat/UserContent.tsx
60-line user-content Factory: text, ordered attachments (images through the user-image Slot, files as cards), extra blocks as JSON, and the reference summary. "The caller owns row identity, pending/echo state, time, and message actions." (`:9-10`).

### packages/client/ui-chat/src/client/chat/RunningStatus.tsx
41-line running indicator with a 1s clock, isolated from the transcript's render cycle; the duration label is `Deep diving for 1m 18s ···`.

### packages/client/ui-chat/src/client/chat/RunningWhaleTail.tsx
19-line decorative glyph: a CSS-mask seat plus an inline static SVG (a hard-coded 16×16 path) for reduced motion and forced colors.

### packages/client/ui-chat/src/client/chat/running-whale@2x.png
- **Purpose:** the running whale's animated mask, inlined into the CSS bundle by `tsdown.config.ts` as a base64 data URL.
- **Key abstractions:** none — it is a 28×28 APNG (PNG signature; `IHDR` 28×28, `pHYs`, an `acTL` animation-control chunk and 43 `fcTL`/`fdAT` frame pairs) used as an alpha mask so the glyph inherits the text colour.
- **Data flow:** the CSS rule `.runningWhaleAnimated` masks with the image; the build plugin rewrites the URL to a data URL so React never carries image data through DOM styles.
- **Non-obvious design decisions:** the build embeds the asset rather than shipping a URL, so there is no second network request and no cache key to manage.
- **Edge cases / failure handling:** a static inline SVG fallback (`RunningWhaleTail.tsx`) is selected by CSS under reduced motion, forced colors, or when alpha masks are unsupported.
- **Surprising:** a browser image cache owns the animation clock, so remounting the row does not guarantee playback restarts at the first frame (`packages/client/ui-chat/README.md:188`).

### packages/client/ui-chat/src/client/chat/accessibility.module.css
- **Purpose:** the 8-line `.visuallyHidden` clip-path utility used for screen-reader-only text (the running status announcement, the `row.running` label).
- **Key abstractions:** one class, four properties: `position: absolute`, `width/height: 1px`, `overflow: hidden`, `clip: rect(0 0 0 0)`, `white-space: nowrap`.
- **Data flow:** none — a pure CSS utility consumed by `ReasoningRow.tsx` and the running-status row.
- **Non-obvious design decisions:** it uses the legacy `clip` form rather than `clip-path: inset(50%)` because the legacy form is the one every screen reader and every engine in the support matrix honours.
- **Edge cases / failure handling:** the element is *visually* removed but still in the accessibility tree, so the announcement is read once, not announced by every screen reader that happens to scan it.
- **Surprising:** `packages/client/ui-chat/src/client/chat/MessageIconActions.module.css:105-112` re-declares the *same* utility inline instead of importing this file — a duplicated 8-line rule that means the shared sheet is not actually shared.

### packages/client/ui-chat/src/client/chat/AssistantMarkdown.module.css
- **Purpose:** the assistant-flow skin: body typography, the wide-markdown-table breakout, the interrupted-turn tag, and the action-row offset (78 lines).
- **Key abstractions:** `.root` (the body column), `.body` (the block stack), `.actions` (the IconActions offset), `.stopped` (the terminal tag).
- **Data flow:** `font-size: var(--dsh-content-font-size, 14px)` and `line-height: calc(24px + var(--dsh-content-font-delta, 0px))` — the Settings font-size preference rides a *published axis*, and the leading is a px delta on top of a fixed line box.
- **Non-obvious design decisions:** the `.md-table-wide` rule (`:33-43`) computes `--dsh-table-spare` from `100cqw` (the ChatView scroll container's inline size) so a ≥4-column table spans the *transcript* width instead of clipping at the 748px message column, while the table's content still starts at its normal x via a compensating `padding-left`; `--dsh-table-spare` clamps to zero on a narrow viewport, so narrow panes keep the plain in-column scroll. The z-index rule (`:48-51`) lifts only the *painted* table above Conversation's width handle, leaving the transparent alignment padding below it.
- **Edge cases / failure handling:** `.body > [data-turn-process-inline][hidden] { margin-bottom: -16px }` cancels the one flex gap that a `hidden="until-found"` zero-height reasoning box would otherwise leave before the visible reply.
- **Surprising:** the comment names the exact figma figures ("figma 16/28 scaled 0.875 → 14/24") and separates the body gap from the action offset, so the footer spacing stays fixed when the body is a single block.

### packages/client/ui-chat/src/client/chat/ChatGroupSeat.module.css
- **Purpose:** the process-group seat skin: the disclosure header, the capped body, the edge fades and the member spacing (150 lines).
- **Key abstractions:** `.title` (the button), `.leading` (the icon box), `.body` (the capped scroller), `.fadeTop`/`.fadeBottom` (mask gradients), `.content` (the member stack).
- **Data flow:** `--dsh-chat-flow-gap: 6px` on `.body` is the group's own member gap; the collapsed row's icon box is `calc(16px + var(--dsh-content-font-delta, 0px))` so the glyph keeps its optical share of the row at every Settings size.
- **Non-obvious design decisions:** the body is capped at `min(400px, 50vh)` and owns `overflow-y: auto` with `overscroll-behavior-y: auto` — a *group* scrolls inside the transcript rather than growing it. The activity icon and the chevron are absolutely stacked in the same box and cross-fade on hover/focus and on `aria-expanded="true"` (`:66-80`), so the header never reflows when it changes state.
- **Edge cases / failure handling:** `.fadeTop`/`.fadeBottom` are `mask-image` gradients with a 24px fade, and the two combined compose a symmetric 24px-at-each-end mask; a `prefers-reduced-motion` block removes the transitions.
- **Surprising:** `:global([data-chat-motion]) .content > :not([data-chat-motion])` gives the *member spacing* the same 160ms timing as the closing body — the group's inner rows slide with the group's own collapse instead of snapping.

### packages/client/ui-chat/src/client/chat/ChatView.module.css
- **Purpose:** the Chat frame skin — the frame, the clipped root, the scrollport, the message column, the flow gaps, the running indicator, and the floating "to bottom" control (304 lines, the largest sheet in the package).
- **Key abstractions:** `.frame` (the flex column + `container-type: inline-size`), `.root` (the *clipped* transcript), `.scroll` (the actual scroller), `.column` (the centred message column), `.flowItem` (one row), `.turnSpacer` (the fold room).
- **Data flow:** `.scroll` is the `container-type: inline-size` box whose `100cqw` the wide-table rule in `AssistantMarkdown.module.css` measures against; `.column` is capped at `var(--dsh-chat-content-width)` and centred, while `.scroll` stays full-bleed.
- **Non-obvious design decisions:** `.root` uses `overflow-y: clip` (not `auto`) so it does **not** become a scroll container — the sticky Markdown banners and the pinned compaction headers therefore keep the *real* conversation scroller as their containing block. The flow-gap rules are written twice — once for `.column > …` and once for the `conversation.chat.flow` slot anchor — because a slot's `display: contents` preserves layout but not selector ancestry. The per-part gap is a CSS variable: `.flowItem[data-chat-group-part="response"] { --dsh-chat-flow-gap: 12px }` and the turn-process rows ask for 16px, so "an Assistant response is separated from its neighbours by 12px" is data in the stylesheet rather than a JS branch.
- **Edge cases / failure handling:** `.flowItem:is(:empty, :has(> [data-chat-flow-kind="turn-process"]:empty))` collapses to `height: 0` so an *empty seat* preserves Turn lookup without contributing height or a sibling gap; the `:nth-last-child(2 of :not([hidden])…)` selector computes "the last visible row before the status" so a hidden or empty seat cannot separate a user message from the running indicator.
- **Surprising:** the running whale is a CSS mask (`mask: url('./running-whale@2x.png')`) enabled only under `@supports (mask-mode: alpha)` **and** `prefers-reduced-motion: no-preference` **and** `forced-colors: none`; outside that envelope the static SVG seat is used. The floating control sits at `z-index: 8` so it stays clickable above the sticky composer at 7, with the documented exception that an open @/slash menu lifts the seat to 9.

### packages/client/ui-chat/src/client/chat/ContextBody.module.css
- **Purpose:** the expanded-context body skin — one shared code-block surface for every context form (161 lines).
- **Key abstractions:** `.text`, `.fields`/`.field`/`.fieldKey`/`.fieldValue` (the source-field block), `.files`/`.file` (the instructions file list), `.entries`/`.entry` (the catalog), `.sections`/`.section` (the snapshot form), `.relaySender`, `.recalls`/`.recall`.
- **Data flow:** every form's body inherits the same geometry so "the disclosure keeps the Figma 10:2482 geometry whichever form renders inside".
- **Non-obvious design decisions:** the field key column is `min-width: 96px` and fixed (`flex: none`) so the value column's left edge is stable across rows; source fields are *dimmer* than the content they describe (`.fieldKey` uses `label-caption`, the value `label-tertiary`).
- **Edge cases / failure handling:** `.entryDescription` truncates with `text-overflow: ellipsis` while `.entryName` does not — the name is load-bearing, the description is decorative.
- **Surprising:** the catalog's entry rows are `flex` with a fixed name and a shrinking description, so a long skill name pushes the description out rather than wrapping the row.

### packages/client/ui-chat/src/client/chat/ContextInjectionRow.module.css
- **Purpose:** the context-disclosure skin — the 24px header, the producer separator, the one-line summary and the 141px body cap (68 lines).
- **Key abstractions:** `.root`, `.sep` (the 2px separator dot), `.source` (the producer name), `.summary` (the one-line account), `.body` (the code-block surface).
- **Data flow:** the header is a flex row of *leading icon + title + separator + producer + summary*; the body indents to `calc(22px + var(--dsh-content-font-delta, 0px))` so the code block stays under the shifted title start.
- **Non-obvious design decisions:** the body cap is exactly `141px` with `overflow: auto` — a context body is *capped and scrollable* rather than unbounded, so a huge injected prompt cannot take over the transcript.
- **Edge cases / failure handling:** the producer name and the summary both use `text-overflow: ellipsis` with `white-space: nowrap` and `overflow: hidden`; a very long plugin id degrades to a clipped name rather than wrapping the header.
- **Surprising:** `SystemPromptRow` deliberately reuses this sheet (the header comment says so), so the system-prompt row and the context row share one body geometry.

### packages/client/ui-chat/src/client/chat/GenericCommandCard.module.css
- **Purpose:** the generic slash-command disclosure skin (49 lines).
- **Key abstractions:** `.title` (the bare command name), `.separator` (the 2px dot), `.summary` (the settlement text), `.body` (the multiline body).
- **Data flow:** the summary is the secondary tier and the body is the code-block surface at `max-height: 260px` with `overflow: auto`.
- **Non-obvious design decisions:** `[data-error]` on either the summary or the body flips the colour to `state-error-primary` — the failure state is a *data attribute* on the same element, not a second component.
- **Edge cases / failure handling:** the body is `white-space: pre-wrap` with `overflow: auto`, so a long command output keeps its line breaks and scrolls rather than being clipped.
- **Surprising:** the title is `font-weight: 400` — a command row is deliberately *not* emphasised, because the command's own output is the content.

### packages/client/ui-chat/src/client/chat/MessageIconActions.module.css
- **Purpose:** the shared copy/branch/clock row skin for user and assistant rows (112 lines).
- **Key abstractions:** `.actions` (the row), `.timeStart`/`.timeEnd` (the two clock tiers), `.endInfo` (the assistant-tail metadata), `.action` (the 28px hit target).
- **Data flow:** the row's height is `calc(28px + var(--dsh-content-font-delta, 0px))` and the action buttons are `calc(28px + delta)` squares with `calc(15px + delta)` glyphs — the glyph scales with the text it serves.
- **Non-obvious design decisions:** the visibility rule is `@media (hover: hover)`-gated: only on a hover-capable device do the actions fade to `opacity: 0` and return on `:hover`/`:focus-within`, so "devices without hover keep every row visible" by construction rather than by a JS check. The selector uses `:has(~ …)` so only the *latest* user-authored row in a run reveals its actions.
- **Edge cases / failure handling:** `.action[data-unavailable]` keeps `cursor: default` and `opacity: 0.4` but stays focusable, so a Tooltip can still explain why the action is unavailable.
- **Surprising:** this sheet re-declares `.visuallyHidden` verbatim rather than importing `accessibility.module.css` — the same 8-line utility exists twice in the package.

### packages/client/ui-chat/src/client/chat/MessageItem.module.css
- **Purpose:** the user bubble, the attachment card, the compaction row, the retry disclosure and the turn-error row (364 lines).
- **Key abstractions:** `.userRow`/`.userStack`/`.bubble` (the user side), `.compactionRow`/`.compactionButton`/`.compactionBody` (the compaction marker), `.retryRow`/`.retrySummary` (the retry disclosure), `.turnErrorRow` (the failure row), `.fileCard` (an attachment).
- **Data flow:** the bubble's width cap is held as a *share of the width axis*: `max-width: min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)` — the figma 525px cap on a 748px column expressed as a ratio, so the bubble widens with a user-dragged column instead of being pinned to 525px.
- **Non-obvious design decisions:** the compaction toggle becomes `position: sticky; top: 0; z-index: 7` **only while it has a body** (`.compactionRow:has(.compactionBody) .compactionButton`) — an open summary's body flows uncapped with the page, so the toggle is pinned to the scrollport top and its background masks the prose scrolling under it. The pinned toggle needs square corners, because "rounded corners would leave that prose visible in the corners". Its hover fill switches to the *solid* token, since the default translucent hover would let the prose show through the moment the pointer lands on it.
- **Edge cases / failure handling:** the summary body's own code-block banner is pushed *below* the pinned toggle band with `top: var(--dsh-compaction-header-height)` (`:101-103`), and the comment names the reason it wins: specificity (0,2,0) against CodeBlock's (0,1,0), "not by declaration order: the two sheets load in their own packages". The retry disclosure uses a `<details>`-style marker with `::-webkit-details-marker { display: none }` and a CSS-drawn chevron.
- **Surprising:** the retry chevron rotates from a `border-right`+`border-bottom` L-shape (`transform: rotate(-45deg)` → `rotate(45deg)` when open) — no icon asset at all.

### packages/client/ui-chat/src/client/chat/ReasoningRow.module.css
- **Purpose:** the "Think" reasoning disclosure skin (77 lines).
- **Key abstractions:** `.root` (the collapsed/expanded container), `.row`, `.summary`/`.summaryText` (the collapsed preview), `.thinkBody` (the expanded body), `.leading`/`.separator`/`.title`.
- **Data flow:** `.root:not([data-expanded])` is `contain: size layout` with a fixed `height: calc(24px + var(--dsh-content-font-delta, 0px))` — the collapsed row's size is *declared*, so the layout cost of a collapsed reasoning row does not depend on its content.
- **Non-obvious design decisions:** the summary uses a right-edge mask gradient (`mask-image: linear-gradient(to right, black calc(100% - 48px), transparent)`) while `data-streaming` is set, so the *streaming* preview fades out instead of being hard-clipped by `text-overflow`.
- **Edge cases / failure handling:** the expanded body's disclosure header is `position: sticky; top: 0; z-index: 1` with an opaque background, so the "Think" toggle stays reachable while the uncapped body scrolls with the conversation.
- **Surprising:** `.root:not([data-preview]) .separator, .root:not([data-preview]) .summary { display: none }` — the *separator and summary* are hidden rather than the row, so the collapsed row keeps exactly its leading icon and title when there is no preview to show.

### packages/client/ui-chat/src/client/chat/stat-dialog.module.css
- **Purpose:** the shared stat-dialog surface skin used by both the per-turn usage pill and the composer statistics pills (95 lines).
- **Key abstractions:** `.panel` (the portaled surface), `.title`/`.titleRule`/`.titleValue`/`.titleLabel` (the heading row), `.details` (a `dt`/`dd` grid).
- **Data flow:** `.panel` is `position: fixed; z-index: 1100` with `width: max-content` and both a `min-width` and a `max-width` expressed as `min(…, calc(100vw - 24px))` — "Both bounds yield to a viewport narrower than themselves (12px margins), so a fixed floor cannot push the panel past the placement clamp."
- **Non-obvious design decisions:** the panel is *portaled* and positioned by an inline `left`/`top` from the anchored-position clamp, rather than anchored in flow, "so the panel keeps its 12px viewport margin instead of hanging off the trigger and clipping at the window edge". The `z-index: 1100` deliberately layers above the modal overlays at 1000.
- **Edge cases / failure handling:** the `dd` column is right-aligned with `font-variant-numeric: tabular-nums`, and `.route` uses `overflow-wrap: anywhere` so a long provider/model route wraps instead of pushing the panel wide.
- **Surprising:** the same sheet serves two different surfaces (a per-turn pill and a whole-session pill) purely by content — the placement code is shared in `stat-dialog.ts`, so the two dialogs cannot drift apart.

### packages/client/ui-chat/src/client/chat/StatsPills.module.css
- **Purpose:** the composer-dock statistics pill skin (57 lines).
- **Key abstractions:** `.anchor` (the entry root, so the clamp measures the pill), `.pill` (the button/span), `.label`, `.sep`.
- **Data flow:** `.anchor` is `inline-flex` and shrink-wraps its pill, so the anchored-position clamp in `stat-dialog.ts` measures the *pill* and not a full-width row.
- **Non-obvious design decisions:** only `button.pill` gets `cursor: pointer` and a hover background — "the static span form keeps the resting tertiary reading", so a pill that opens nothing does not look clickable.
- **Edge cases / failure handling:** the label truncates with `text-overflow: ellipsis` while the glyph (`14px`, `flex: none`) never shrinks, so the icon stays legible however narrow the dock gets.
- **Surprising:** the pill's font size is one pixel *below* the secondary tier (`calc(var(--dsh-content-font-size-secondary, 13px) - 1px)`) — the statistics are deliberately quieter than the text they sit beside.

### packages/client/ui-chat/src/client/chat/TurnNavigator.module.css
- **Purpose:** the fixed-pitch turn-rail skin — the slot, the frame, the marks and the preview card (223 lines).
- **Key abstractions:** `.slot` (the rail's placement box), `.frame` (the visible band), `.scroller` (the inner scroller), `.mark` (one turn tick), `.preview` (the hover card).
- **Data flow:** the frame's band is `--turn-rail-band: calc(var(--dsh-conversation-viewport-height, 100dvh) - var(--dsh-composer-height, 152px))` — the scrollport minus the sticky composer stack, with fallbacks for the first paint before the observer fires.
- **Non-obvious design decisions:** the rail is a *sibling* of the clipped transcript (`position: absolute` over it), never a descendant, and it sits at `z-index: 7` "above transcript CodeBlock banners (z-index 6)". Its marks are **fixed-pitch** — a 10px-tall absolutely-positioned tick per turn with a 20×2px bar scaled on the X axis — so the rail's height never depends on the transcript and its marks never compress; a ladder taller than the band scrolls inside `.frame` (`max-height: min(max(0px, band - 64px), 420px)`) with `overscroll-behavior: contain`.
- **Edge cases / failure handling:** the preview is positioned with `top: clamp(0px, center - height/2, 100% - height)` so it never leaves the frame; the scroller's scrollbar is hidden and the ends carry 24px mask fades. A `@container (max-width: 900px)` rule removes the frame entirely on a narrow container. `prefers-reduced-motion` removes every transition and animation.
- **Surprising:** `:focus-visible` gets a *brand* colour the rail never uses elsewhere plus a 1px outline with `outline-offset: -1px` — the outline is *inset* because "the scroller clips the right edge; keep the marker's ring inside it".

### packages/client/ui-chat/src/client/chat/TurnProcessNodeView.module.css
- **Purpose:** the Turn-process control row skin (60 lines).
- **Key abstractions:** `.root` (the button), `.chevron` (the collapse affordance), `.label`, `.durationNumber`.
- **Data flow:** the row's height is `calc(33px + var(--dsh-content-font-delta, 0px))` with `padding: 0 0 8px` and a `0.5px` bottom border — the control reads as a rule, not as a card.
- **Non-obvious design decisions:** the chevron rotates 180° on `[data-open]`, and `.root:disabled` drops the pointer cursor — a Turn that cannot be collapsed must not look actionable.
- **Edge cases / failure handling:** the duration uses `font-family: var(--ds-font-family-code)` with `font-variant-numeric: tabular-nums`, so the elapsed figure does not jitter as it counts.
- **Surprising:** the label and the duration are separated only by `min-width: 0` + ellipsis, so the *duration* keeps its width while the label is what gets clipped.

### packages/client/ui-chat/src/client/chat/TurnTailNodeView.module.css
- **Purpose:** the completed-turn footer's two rules (12 lines — the smallest sheet in the package).
- **Key abstractions:** `.root` (the footer column), `.actions` (the action row).
- **Data flow:** `.root` has `gap: 16px` between the tail content and the actions row; `.actions` adds `margin-top: 4px` and `margin-left: -6px`.
- **Non-obvious design decisions:** the comment states the arithmetic explicitly: "With tail content, this adds to the root gap; without it, the Chat flow's preceding-item offset supplies the other 16px" — so the footer has exactly one 16px separation whether or not it carries content.
- **Edge cases / failure handling:** the negative `margin-left: -6px` optically aligns the action row with the message column, cancelling the icon hit-target's inset.
- **Surprising:** `tests/turn-tail-spacing.client.spec.ts` asserts this arithmetic *by reading the stylesheet text* — the 12-line sheet is load-bearing and is pinned by a static check.

### packages/client/ui-chat/src/client/chat/TurnTriggerNodeView.module.css
- **Purpose:** the non-human turn-trigger notice card skin (35 lines).
- **Key abstractions:** `.root` (the bordered card), `.header` (the trigger row), `.body` (the recorded body), `.content` (the scrollable text).
- **Data flow:** the header is `icon + title + time (margin-left: auto) + chevron`, so the recorded time is pushed to the far edge.
- **Non-obvious design decisions:** the card uses `--dsw-alias-turn-trigger-bg` with a fallback to the markdown code-block background, and the body is capped at `max-height: 240px` with `overflow: auto` — a trigger's recorded body is bounded like every other expandable body.
- **Edge cases / failure handling:** `.body` indents to `padding: 0 16px 12px 40px` so the recorded body stays under the title text, not under the icon.
- **Surprising:** the card has a *hover* background change but the trigger's own chevron is a separate `.chevron`/`.openChevron` pair that swaps by `transform: rotate(180deg)` rather than by opacity — the two chevrons occupy the same space.

### packages/client/ui-chat/src/client/chat/TurnUsagePanel.module.css
- **Purpose:** the per-turn usage pill skin (73 lines).
- **Key abstractions:** `.root` (the pill cluster), `.trigger` (the button), `.label`.
- **Data flow:** the trigger is `calc(28px + var(--dsh-content-font-delta, 0px))` tall with `calc(15px + delta)` glyphs — the same geometry as the sibling action buttons, so the pill does not read as a different kind of control.
- **Non-obvious design decisions:** adjacent pills rebate part of their internal padding: `.root + .root { margin-left: -6px }` — "so the pair reads as one cluster inside the row's 8px flex gap, while keeping 2px clear between their hover backgrounds".
- **Edge cases / failure handling:** at `max-width: 480px` the pills collapse to bare 28px circles and the label is `display: none`; the padding rebate is dropped at the same breakpoint so the pair keeps the row's plain 8px rhythm. "The dialogs keep the words."
- **Surprising:** the label is one pixel below the secondary tier and the figures use `tabular-nums`, so a live-updating token count does not shift the pill's width.

### packages/client/ui-chat/src/client/settings/PreferenceRow.module.css
- **Purpose:** the Chat settings-row skin — label, description and the selector pill (56 lines).
- **Key abstractions:** `.row` (the two-column row), `.rowText` (the title + description stack), `.selector` (the trigger), `.chevron`.
- **Data flow:** `.rowText` is `flex: 1` with `padding-right: 48px` so the description cannot run under the selector pill.
- **Non-obvious design decisions:** the selector is a 36px-high `bg-module-platform` pill rather than a native `<select>`, because the whole Settings surface uses these custom triggers.
- **Edge cases / failure handling:** the row carries a `0.5px` bottom border, so consecutive preference rows read as a list without a card per row.
- **Surprising:** this sheet lives under `settings/` while every other sheet in the package lives under `chat/` — the one place the package's own directory layout reflects the *Settings* surface rather than the Chat surface.

### packages/client/ui-chat/src/client/apply.ts
- **Purpose:** the plugin's `apply()` — the whole wiring (330 lines).
- **Key abstractions:** `CHAT_FLOW_INJECT` / `CHAT_NODE_INJECT` (the Hook factories the Slot framework binds) (`:50-73`); the `inject` service list (`:75`).
- **Data flow:** `chatSource(binding)` wraps the uiConversation binding's `chat` target in an `ObservableSnapshot` and subscribes to the binding's event source to detect quota failures (`:88-135`). Only `append` changes publish a notice: "history replacement or paging never does, because an old failure scrolling back into view is not news" (`:97-99`).
- **Non-obvious design decisions:** each quota hold is its own `Symbol`, "so a release can only drop the hold it was issued for: one arriving after a dismissal or a later acquisition leaves that newer hold alone" (`:88-90`). Files open in the right Sidebar under a **session-scoped address** (`dsh-resource://file/session/<id>/<path>`), and a line travels as a navigation parameter rather than as part of the address (`:246-253`). The link destination is process-local when the settings write fails: "The local choice remains usable when persistence is unavailable" (`:158-163`).
- **Edge cases / failure handling:** a fork or child-title failure "leaves the source view unchanged" (`:292-294`); a Chat view inject that resolves no Session **throws loudly** (`:239-240`).
- **Surprising:** the quota-notice host is registered in `shell.overlay` — outside the Chat panel — "so a notice survives switching or closing the panel that reported it" (`packages/client/ui-chat/src/client/contract/slots.ts:446-447`).

### packages/client/ui-chat/src/client/stores.ts
62-line Chat store. `turnProcessOpen(state, spec, defaultOpen)` (`:36`) is the resolution rule: a stored choice for the **current** answer generation wins; otherwise the default applies — "the latest completed Turn stays open until the next input, and older Turns fold" (`:26-28`).

### packages/client/ui-chat/src/client/presentation-policy.ts
- **Purpose:** the mode → capability policy table (105 lines).
- **Key abstractions:** `ChatPresentationPolicy { mode, collapseTiming, foldCompletedTurns, stepGrouping, liveProcessDetail, settledReasoningPreview }` (`:7-18`); `POLICIES` (`:23`).
- **Data flow:** `presentationPolicyFor(mode, timing)` returns *the same object* for the same pair, so the policy's identity is stable — "the same policy object for the same pair of choices" (`:78-83`).
- **Non-obvious design decisions:** the four modes are expressed as four capability rows, not as four code paths; the renderer asks for the capability it needs (`policy.settledReasoningPreview`), so a mode change re-renders only the components whose *selected* value changed.
- **Edge cases / failure handling:** `derivePresentationPolicy` subscribes to both preferences and removes both subscriptions on disposal.
- **Surprising:** `stepGrouping` has three values (`collapsed` / `history` / `none`) while the mode has four — Detailed's "running Turns flat, historical Turns grouped" is a *mode × timing* property, not a fifth mode.

### packages/client/ui-chat/src/client/transcript-view.ts
67-line `TranscriptViewPolicy`: adopts the accepted Host mode and timing, maps the legacy `normal`/`expanded` values to `detailed` **without writing back**, and never writes a default for an absent preference (`:57-66`).

### packages/client/ui-chat/src/client/performance-usage.ts
34-line `PerformanceUsagePolicy`: publishes the choice immediately and queues the Host write, so a refused or pending write keeps the selected mode until the Host answers.

### packages/client/ui-chat/src/client/markdown-labels.ts
16-line adapter building the complete Markdown chrome copy (code-fence copy/wrap labels and the footnotes line) for one locale revision.

### packages/client/ui-chat/src/client/locale.ts
397-line locale module: `NS = 'chat'`, the Simplified Chinese dictionary as the **key-set source of truth** (`export type ChatKey = keyof typeof zh`, `:202`), and the English dictionary beside it. The two dictionaries are checked against each other by `satisfies Record<ChatKey, string>` on the English side, so a missing Chinese key is a compile error.

### packages/client/ui-chat/src/client/settings/PreferenceRow.tsx
59-line localized two-column selector. The selection restores focus to the trigger **before** publishing the new value, and with `preventScroll: true` so the menu closing does not scroll the page (`:20-24`).

### packages/client/ui-chat/src/client/settings/TranscriptViewRow.tsx
72-line Settings row exposing two independent preferences: the work-details mode (four values) and the collapse timing (two values), each through its own `PreferenceRow`.

### packages/client/ui-chat/src/client/settings/LinkOpeningRow.tsx
47-line Settings row for where Chat HTTP(S) links open; it renders nothing at all when the Sidebar Browser is not registered (`:33-35`).

### packages/client/ui-chat/src/client/settings/PerformanceUsageRow.tsx
46-line Settings row for the statistics detail level.

### packages/client/ui-chat/src/client/model/tool-call-tree.ts
- **Purpose:** PTC dispatch pairing projected into the recursive tool-call contract (231 lines).
- **Key abstractions:** `MAX_TOOL_CALL_TREE_DEPTH = 256` (`:15`); `acceptEdge(parent, sub)` (`:170`); `wouldCreateCycle` (`:190`); the projection caches (`:31-40`).
- **Data flow:** `apply(event)` folds a `tool/ptc-dispatch-start` / `tool/ptc-dispatch` into a parent→children index and bumps a revision; `projectNodes` / `projectRunningCalls` rebuild the recursive `subCalls` tree, returning the *original* array when nothing changed (`:120-141`).
- **Non-obvious design decisions:** "Host-minted ids exclude cycles and current bindings emit one level; a malformed wire/history edge is consumed without hiding the rest of the session" (`:169-172`) — a rejected edge is still *consumed* (the event is swallowed) so the stream stays in sync.
- **Edge cases / failure handling:** the cycle check walks the *descendants* of the new child to see whether the parent is reachable from it (`:190-203`), which catches a cycle that closes several levels down, not just a self-parent.
- **Surprising:** the depth limit is checked on both the ancestor chain and the descendant subtree, so an edge is refused unless *every* recursive consumer can traverse it safely.

### packages/client/ui-chat/src/client/model/steering-history.ts
64-line reconstruction of durable steering identity from `agent/inbox/spliced` events: a message is steering only if it was claimed from `next-step` and its source is `user`.

### packages/client/ui-chat/src/client/model/conversation-context.ts
24-line type for one immutable model-context generation, with the origin kind (`compaction` / `rewind` / `rewrite`) that explains why a replacement happened.

### packages/client/ui-chat/src/client/index.ts
67-line public client entry: re-exports the contracts, opens `ChatNodeDataMap` for other plugins to contribute renderer payloads, and exports the runtime predicates `isRunningTool` / `isSettledTool`.

### packages/client/ui-chat/src/chat-settings.ts
83-line durable settings schema: the `ui-chat` namespace, the four fields, the legacy mode aliases that are "read as `detailed`; never offered as a choice and never written back" (`:26-29`), and the schemastery field table (`:68-75`).

### packages/client/ui-chat/src/index.ts
42-line Host-side entry: projects the four preferences to the browser as `Volatile` config and registers the settings namespace (`auto: false`, so the package's own instance stays off the generated Settings pages).

### packages/client/ui-chat/src/css-modules.d.ts
6-line ambient declaration for `*.module.css` / `*.css`.

### packages/client/ui-chat/package.json
Manifest: `"platform": "web"`, the eleven client `inject` packages, the exports map, the two tsdown scripts, and the dependency set (including `@tanstack/react-virtual` pinned to `3.14.10`).

### packages/client/ui-chat/tsconfig.json
- **Purpose:** the 11-line *solution* project — it has no files of its own, only two project references.
- **Key abstractions:** `{"files": [], "references": [tsconfig.host.json, tsconfig.client.json]}`.
- **Data flow:** `tsc -b` at the package root builds the host project and the client project.
- **Non-obvious design decisions:** the package ships **two** TypeScript projects because it has **two** runtimes: a Cordis *Host* plugin (`src/index.ts` + `src/chat-settings.ts`, which must run in Node without React) and a *browser client* bundle (the whole `src/client/**` tree, which needs React and 36 workspace packages).
- **Edge cases / failure handling:** a `files: []` root with only references is what lets the two projects have *different* `extends` bases and *different* dependency graphs without either one inheriting the other's.
- **Surprising:** the split is invisible in the source tree — both halves live under `src/`, and only this file tells a reader which half is Host and which is browser.

### packages/client/ui-chat/tsconfig.client.json
- **Purpose:** the browser-bundle TypeScript project (124 lines).
- **Key abstractions:** `extends: ../../../tsconfig.base.client.json`; `rootDir: src`, `outDir: lib/types`, `tsBuildInfoFile: lib/tsconfig.client.tsbuildinfo`; `include: ["src"]`.
- **Data flow:** 36 project references pull in the workspace packages the browser bundle needs — `core/agent`, `core/session`, `core/tools`, `llm/llm`, `llm/llm-retry`, `llm/token-meter`, `compaction/compaction`, `subagent/subagent`, `interaction/commands`, `api/session-controller`, `ui-conversation`, `ui-slots`, `ui-primitives`, `ui-renderer`, `ui-session`, `ui-settings`, `ui-sidebar-browser`, `ui-sidebar-right`, `ui-sidebar-documentpreview`, `ui-input-trigger`, `ui-layout`, `ui-workspace`, `ui-approval`, `session/session-stats`, `session/session-turn-outline`, `attachment/attachment`, `product-analytics`, plus the vendored `cordis` and `schemastery`.
- **Non-obvious design decisions:** `"exclude": ["src/index.ts"]` — the Host entry is compiled by the *host* project, so the browser project never type-checks it against the browser base config. That single exclude is what makes the two-project split sound.
- **Edge cases / failure handling:** the `outDir`/`tsBuildInfoFile` names keep the two projects' build info in *separate* files, so an incremental browser build cannot reuse the Host project's state (and vice versa).
- **Surprising:** the client project depends on `llm/token-meter` — the *server-side* token accounting package is imported by the browser bundle (`turn-tail.ts` derives turn token usage from it), so the token-meter's types must be browser-safe.

### packages/client/ui-chat/tsconfig.host.json
- **Purpose:** the Host-side TypeScript project (23 lines).
- **Key abstractions:** `extends: ../../../tsconfig.base.json` (the non-client base); `files: ["src/chat-settings.ts", "src/index.ts"]`.
- **Data flow:** exactly two entry points compile against the base config, with three project references: the vendored `cordis`, the vendored `schemastery`, and `../../settings/settings`.
- **Non-obvious design decisions:** the project uses `files` rather than `include` — the Host build compiles *named files*, so a new file under `src/` is not silently added to the Host bundle. The Host side is deliberately tiny: it registers the settings namespace and projects four preferences to the browser.
- **Edge cases / failure handling:** because the Host project pulls in `settings/settings` but not `ui-conversation` or `ui-slots`, the Host build can never accidentally import a browser dependency.
- **Surprising:** the *same* `src/` directory is split across two projects by an `exclude` on one side and a `files` whitelist on the other — the split is expressed twice, from both directions, so neither half can leak into the other.

### packages/client/ui-chat/tsdown.config.ts
22-line build config: wraps the shared `clientBundle` and adds a plugin that inlines `running-whale@2x.png` as a base64 data URL **into the CSS bundle** and adds it to the watch list — "The build embeds the image in the plugin stylesheet; React does not pass image data through DOM styles" (`packages/client/ui-chat/README.md:114`).

### packages/client/ui-chat/locale/en.json
- **Purpose:** the package-locale *metadata* file for English — 5 lines containing only `{"meta": {"title": "ui-chat"}}`.
- **Key abstractions:** none beyond the `meta.title` key; the package-locale schema is shared across the monorepo.
- **Data flow:** the build reads it to name the package's locale namespace; it carries **no** Chat strings.
- **Non-obvious design decisions:** the English file has *no* `description` while the Chinese one has both `title` and `description` — the schema treats the description as optional, and the English one omits it rather than duplicating the title.
- **Edge cases / failure handling:** because this file is metadata-only, a missing key here degrades to a missing package name in a UI, not to a missing translation.
- **Surprising:** the actual Chat copy lives in `src/client/locale.ts` (397 lines, a hand-written EN/ZH dictionary pair) — a reader who opens `locale/` expecting the Chat strings finds four lines of metadata and nothing else.

### packages/client/ui-chat/locale/zh.json
- **Purpose:** the package-locale *metadata* file for Chinese — 6 lines: `{"meta": {"title": "聊天内容展示", "description": "渲染聊天消息、工具内容和相关详情。"}}`.
- **Key abstractions:** `meta.title` and `meta.description` — the two-field shape the package-locale schema accepts.
- **Data flow:** the build reads it for the Chinese package name and description; no Chat string lives here.
- **Non-obvious design decisions:** the description is written as a *capability* sentence ("renders chat messages, tool content and related details"), not a restatement of the title — it is the text a Settings/plugin list shows beside the name.
- **Edge cases / failure handling:** the Chinese metadata is complete while the English one is not (no `description`); the schema tolerates the asymmetry, which means a missing description in one language is invisible to the type checker.
- **Surprising:** the Chinese locale string is *not* a translation of the English title — the English title is the raw package id `ui-chat` while the Chinese title is a human-facing name. The package id is not user-facing text in every language.

### packages/client/ui-chat/tests/apply-inject.client.spec.tsx
- **Purpose:** the 466-line integration suite for the plugin's **inject faces** — the things `apply.ts` hands to the host (settings projection, group sources, history paging, forking, file opening, link opening, image loading, scroll memory).
- **Key abstractions:** the suite mounts the real plugin against a `SlotTestRuntime` and drives it through its public inject surface rather than through internals.
- **Data flow:** 16 `it` cases cover the whole injected API: independent Settings choices, keyed Group sources across registration/activation/removal, older-history loading and forking through the Session Controller, session-scoped file addressing, HTTP(S) link opening in the Sidebar Browser or the system browser, link-destination changes without a remount, the optional tab registry appearing and leaving, local link choices surviving a failed settings write, skill-preview injection staying with its owner, relative-vs-absolute path addressing, a loud failure when a Chat View inject resolves no Session, and the ownership of image loading, scroll memory and closing-file mentions.
- **Non-obvious design decisions:** the case "keeps Chat available while the optional tab registry appears and leaves" (`:347`) asserts *availability*, not behaviour — an optional dependency that is absent at mount time must not make the package fail to load.
- **Edge cases / failure handling:** "keeps local link choices usable when settings cannot persist" (`:366`) pins the same rule `apply.ts` states: a refused write leaves the process-local choice in force.
- **Surprising:** "fails loud when a Chat View inject resolves no Session" (`:420`) — the package *throws* rather than rendering an empty Chat, because an empty chat panel is indistinguishable from a hung one.

### packages/client/ui-chat/tests/approval-command.client.spec.tsx
- **Purpose:** the 59-line unit suite for the approval detail renderer.
- **Key abstractions:** two describes — `commandOf` (`:20`) and `ApprovalCommand` (`:30`).
- **Data flow:** `commandOf` accepts only a *string* `command` from valid JSON arguments (`:21`); the component test renders the running correlated Tool command (`:31`) and omits absent, uncorrelated, preparing and settled Tool calls (`:41`).
- **Non-obvious design decisions:** the test builds a fake `useChat` as `((selector) => selector(snapshot))` — a one-line stand-in for the whole Chat store — because the renderer's only need from the store is a snapshot lookup.
- **Edge cases / failure handling:** "preparing" and "settled" Tool calls are *omitted*, not rendered differently: the approval detail shows only what is actually pending.
- **Surprising:** the fixture imports `PartialArguments` from `@deepseek-ai/dsh-util-values` — the *lazy* argument view is the production type, so the test exercises the real partial-JSON path rather than a plain object.

### packages/client/ui-chat/tests/assistant-markdown-path-images.client.spec.tsx
- **Purpose:** the 100-line suite for the local-path image resolver and its Markdown integration.
- **Key abstractions:** two describes — `localPathMediaUrl` (`:23`) and `AssistantMarkdown local-path images` (`:58`).
- **Data flow:** six cases map an absolute POSIX path to the document's file route (root or mount), keep unsupported application transports inert, keep destinations that cannot be Host-served local files inert, encode the full path including spaces, keep non-absolute destinations inert, and decode Markdown URL escapes **once** before encoding the file query (`:93`).
- **Non-obvious design decisions:** the "unsupported transport" and "not Host-served" cases assert *inertness* (no URL produced) rather than an error — an image the host cannot serve simply does not render.
- **Edge cases / failure handling:** the decode-once rule is the whole point of the last case: a doubly-decoded path would name a different file.
- **Surprising:** the resolver handles POSIX absolute paths only; a Windows path is inert, which is a deliberate narrowing rather than an omission.

### packages/client/ui-chat/tests/chat-apply.client.spec.tsx
- **Purpose:** the 498-line suite for `apply.ts` — what the plugin registers, what it owns, and what it removes on unload.
- **Key abstractions:** 12 `it` cases under `Chat apply wiring` (`:97`).
- **Data flow:** the suite asserts that the presentation-policy helpers stay out of the public browser entry (`:98`), that the frame-wide quota notice host is registered while the failure row stays injection-free (`:108`), that the Chat View, node renderers and stats are contributed (`:131`), that node dispatch lives in the shared flow and image Slots in their own domain renderers (`:145`), and that another registrant can replace one composer stats pill by id (`:178`).
- **Non-obvious design decisions:** "removes only Chat contributions when Chat unloads" (`:284`) is a *scope* assertion: the plugin must not tear down the shared Conversation machinery it merely borrowed.
- **Edge cases / failure handling:** "keeps the Chat standard source total while its target enters and leaves" (`:295`) and "binds process hiding to each render context without sharing viewport motion" (`:369`) both assert that two Chat instances do not share per-viewport state.
- **Surprising:** "binds Turn data directly to its keyed Location source" (`:321`) pins that the Turn data is read from the *Location* source rather than from a copy — one source of truth, no cache to invalidate.

### packages/client/ui-chat/tests/chat-branch-tails.client.spec.tsx
- **Purpose:** the 1136-line component suite for the user row, the context row and the small tails (the 50 `it` cases under `MessageItem arms` (`:99`), `formatMessageClock` (`:1010`), `useCalendarDay boundary refresh` (`:1032`), `small branch tails` (`:1060`) and `user file attachments` (`:1108`)).
- **Key abstractions:** a legacy-node fixture adapter that wraps a `ConversationNode` into a `ChatConversationViewNode` (`:54`), plus the real `MessageItem` renderers and the real `AssistantMarkdown`.
- **Data flow:** the suite is the executable form of the context-body rules: every context *form* (instructions, catalog, snapshot, notice, relay, recall, opaque) is rendered and its fallback asserted — "a partially unreadable catalog falls back whole rather than showing a short list" (`:497`), "an unreadable instruction list falls back to the opaque body with its fields" (`:523`), "each form falls back to the opaque body when its required facts are unreadable" (`:735`).
- **Non-obvious design decisions:** the copy path has its own trio of cases — `execCommand` fallback when `clipboard.writeText` is unavailable (`:201`), "user copy never claims success when the host rejects the write" (`:223`), and "copy swaps to the check success chrome, gates re-clicks, and reverts after a second" (`:245`) — the *feedback chrome* is treated as state that must be released on unmount (`:277`).
- **Edge cases / failure handling:** "a notice without its account falls back to the opaque body" (`:720`), "a compaction marker discloses its summary and never shows the framed checkpoint" (`:827`), and "a marker whose cited summary event fell outside the window is not expandable" (`:867`) — the last one is the compaction marker's own window rule.
- **Surprising:** "joins adjacent text blocks the way a provider adapter flattens them" (`:541`) and "bounds an oversized source field, not only the model-facing text" (`:559`) — the *display* of a context body is held to the same shape the model actually read, which is an unusual and very transferable discipline.

### packages/client/ui-chat/tests/chat-font-axis-styles.client.spec.ts
- **Purpose:** the 176-line **static-CSS** suite that asserts the Settings font-size axis is actually honoured by the stylesheets.
- **Key abstractions:** 12 `it` cases under `chat flow font-size axis` (`:21`), each reading a stylesheet as *text* and matching a regex.
- **Data flow:** the cases check the secondary tier for Think text (`:22`), the shared row line for command and context summaries (`:35`), the clock and the action glyphs scaling with the text they serve (`:49`), the compaction rows following the axis (`:65`), the expanded bodies' 22px+delta indent (`:79`), the usage-details trigger (`:91`), the usage pill's glyph and hit height (`:99`), narrow-viewport pill collapse (`:122`), the hover-reveal of non-latest turn tails (`:136`), the flow sibling selector that reveals only the latest user-authored row (`:150`), empty outer Seats contributing no height (`:158`), and the interrupted-turn tag staying fixed (`:168`).
- **Non-obvious design decisions:** the suite asserts *stylesheets*, not rendered output — a font-axis regression that only shows at one font size is otherwise invisible to a unit test, so the rule is pinned statically.
- **Edge cases / failure handling:** "keeps empty outer Seats in flow without adding height or sibling gaps" (`:158`) is the static twin of the runtime `flowItem:is(:empty, …)` rule in `ChatView.module.css`.
- **Surprising:** the same idea appears three times — the axis, the *delta* variable and the hit-target size — so the pin covers the interaction of three variables rather than one declaration.

### packages/client/ui-chat/tests/chat-node-bottom.client.spec.ts
- **Purpose:** the 183-line suite for the *bottom exchange* membership — which Turns are in the latest exchange.
- **Key abstractions:** five `it` cases under `assembler-owned Chat bottom membership` (`:30`).
- **Data flow:** the suite drives the `ChatSnapshotBuilder` and the `GroupTreeSegments` projector over synthetic Node sets and asserts the *notification* set, not just the final membership: "notifies only the Turns leaving or entering the latest exchange among 4,000 observed historical Nodes" (`:31`).
- **Non-obvious design decisions:** "keeps a bare Turn boundary and continuation Turns in the latest exchange until an opening Node arrives" (`:69`) — a Turn with no loaded opening node is *in* the exchange, not out of it; the fallback is deliberate so history paging does not make the rail jump.
- **Edge cases / failure handling:** "updates same-key Turn moves without changing root order and excludes unplaced or hidden Nodes" (`:162`) — a hidden Node must not move a Turn, and a same-key move must not reorder the root.
- **Surprising:** the 4,000-node case is about *notification volume*, not about correctness at scale — the assertion is that exactly one listener fires.

### packages/client/ui-chat/tests/chat-node-source.client.spec.ts
- **Purpose:** the 90-line suite for the keyed Node sources the seats subscribe to.
- **Key abstractions:** two `it` cases under `Chat Node keyed sources` (`:30`).
- **Data flow:** the first case (`:31`) drives the builder through a `replace` and an `apply` and asserts the *grouping input* the builder hands out: `order` identity, `readNode`, `readPosition`, `readTurn`, `changedTurns`, `changedTurnOrders`, and the `changes` list carrying `{previous, current}` pairs.
- **Non-obvious design decisions:** "notifies only the updated key among 4,000 mounted sources" (`:67`) mounts 4,000 sources, mutates one node, and asserts that *exactly one* listener fires and that the source *object identity* for the changed key survives the rebuild (`next.nodes.source(changed.key)` is the same object as before) — identity stability is what stops a seat from remounting.
- **Edge cases / failure handling:** `readPosition` returns `undefined` for a key that is not a position (`'missing'`), and `readTurn(7)` returns `[]` for a Turn with no nodes.
- **Surprising:** the test asserts `initial.order` **is** `snapshot.order` — the same array *object*, not an equal one — so a consumer can compare by identity to know nothing changed.

### packages/client/ui-chat/tests/chat-scroll.client.spec.tsx
- **Purpose:** the 585-line suite for the scroll composition — viewport + reading owner + fold lifecycle, exercised through the real hooks.
- **Key abstractions:** a `ScrollHarness` component (`:22`) that mounts `useChatScroll` with a stubbed `ResizeObserver` and a fake scrollport (`:37`).
- **Data flow:** ~16 `it` cases cover: consuming a prior legal fold deficit instead of accumulating whole steps on the next input (`:237`), retaining the reader position without clamping after an interrupted input fold (`:252`), keeping one active fold when the local echo becomes its durable input (`:304`), and a `Chat scroll collapse timing` describe (`:320`) with a measured set — one viewport's submitted input not being deferred behind another viewport's fold (`:344`), coalescing submitted inputs into one frame-owned fold (`:368`), keeping only the visible deficit (`:384`), clearing a fold reservation on an idle mode change (`:418`), keeping the latest mode reset when preferences change mid-fold (`:432`), combining the remaining input distance with the smaller fold (`:445`), keeping intent cancellation through a resize (`:500`), not letting a process-body `scrollend` settle an outer native follow (`:512`), cancelling the queued follow on unmount (`:535`), not reviving a cancelled follow when timing is re-enabled (`:547`), returning to bottom immediately (`:562`) and interrupting an active smooth follow (`:574`).
- **Non-obvious design decisions:** every case asserts the *timer count* is zero in `afterEach` — a leaked timer is a defect in this subsystem, so the teardown asserts it (`:14`).
- **Edge cases / failure handling:** "does not let process-body scrollend settle an outer native follow" (`:512`) is the nested-scroller rule: only the *outer* scroller's `scrollend` may settle the outer animation.
- **Surprising:** the suite is the only place the *deferred* (completion-timing) fold is measured end to end; the individual hooks are unit-tested elsewhere.

### packages/client/ui-chat/tests/chat-snapshot-fixture.client.ts
- **Purpose:** the 574-line **fixture** that builds a complete, consistent `ChatSnapshot` for the view tests.
- **Key abstractions:** `chatSnapshotFixture(input)` (`:304`) plus the helpers `sameValues` (`:27`), `cachedSource` (`:31`), `sameFixtureLocation` (`:44`) and `nodeSource` (`:64`).
- **Data flow:** the fixture builds nodes, the Location index, the Turn navigation index, the process presentation and the legacy slice from one input, and it *derives* the derived parts using the production functions (`turnNavigationItem`, `orderedVisibleChatNodes`, `ChatTurnProcessProjector`, `hasAssistantReplyContent`, `sameTurnProcessSpec`, `isAtOrOutside`) rather than hard-coding them.
- **Non-obvious design decisions:** `sameFixtureLocation` (`:44`) compares a Turn/Step location by *identity of its bound data source* (`location.turn.data`), so a fixture location is "the same" exactly when the host's location object is the same — which is what makes the derived process presentation stable across a rebuild.
- **Edge cases / failure handling:** `cachedSource` (`:31`) keeps a per-key source cache so the fixture's keyed sources are *identity-stable* across calls — without it every fixture rebuild would remount every seat in the view tests.
- **Surprising:** the fixture imports production code from `../src/client/conversation-nodes/*` and from `../../ui-conversation/src/...` directly — the test tree reaches *into* other packages' sources, so the fixture is a cross-package contract as much as a test helper.

### packages/client/ui-chat/tests/chat-stats.client.spec.tsx
- **Purpose:** the 508-line suite for the composer statistics — the fold, the formatters and the two pills.
- **Key abstractions:** three describes — `deriveStats` (`:60`), `formatters` (`:127`) and `composer stats pills` (`:141`).
- **Data flow:** the fold counts Turns and steps and "never folds node usage into accounting" (`:61`); it ignores tool results with no call time (`:79`), sums LLM wall time from assistant timing and tool wall time from call/result pairs (`:90`), and sums ttft per recorded step (`:109`). The pill cases cover the compact mode, the reading pill, the usage pill, the dialogs, and the projection-vs-window rule: "renders whole-session counts from the sessionStats projection over the paged window" (`:398`), "treats a defined zero-count projection as empty, not as fallback" (`:409`), "hides the usage pill when steps closed without any billed activity" (`:420`).
- **Non-obvious design decisions:** "renders ZERO times during streaming chunk frames (RFC hard acceptance)" (`:494`) — during streaming the figure is literally zero, and that is *required*, not a missing measurement.
- **Edge cases / failure handling:** "keeps at most one dialog open: a sibling pill click swaps, never stacks" (`:326`) and "swaps dialogs on keyboard activation of a sibling pill, which fires click without pointerdown" (`:343`) — the second case exists because a keyboard `click` has no preceding `pointerdown`, and the dialog's outside-close handler is capture-phase.
- **Surprising:** "includes cache writes in the total and the cache-hit denominator" (`:478`) — a cache *write* counts against the hit rate, so the percentage is honest about what was reused rather than about what was sent.

### packages/client/ui-chat/tests/chat-store.client.spec.ts
- **Purpose:** the 47-line unit suite for the Chat store's turn-process disclosure resolution.
- **Key abstractions:** two `it` cases under `createChatStore` (`:4`).
- **Data flow:** the first case (`:5`) stores a manual expansion and a collapse *for the current answer generation*; the second (`:19`) closes only the requested Turn-process entry and resolves `turnProcessOpen(store.store.getSnapshot(), spec, defaultOpen)` (`:37`).
- **Non-obvious design decisions:** the store key is `(turn, answerStep)`, not `turn` — so a manual collapse survives the *next* answer generation in the same Turn.
- **Edge cases / failure handling:** a stored choice applies only to the *current* answer generation; otherwise the caller's default wins.
- **Surprising:** the store's public surface is three functions (`createChatStore`, `storedTurnProcessEntry`, `turnProcessOpen`) and 40 lines — the whole "which groups are open" policy is a pure function of `(state, spec, default)`.

### packages/client/ui-chat/tests/chat-view.client.spec.tsx
- **Purpose:** the 4407-line, ~120-case **view-level** suite — the largest file in the shard and the package's real acceptance test.
- **Key abstractions:** one `describe('Chat node rendering')` (`:670`) covering the file-mention and duration helpers, and one `describe('ChatView')` (`:737`) covering the view itself. The suite mounts the *real* `ChatView` + `ChatFlow` against a `ChatSnapshotBuilder`, a `ProcessState`, a `ConversationGroupStore` and a `chatSnapshotFixture`.
- **Data flow:** the cases walk the whole product: rendering only referenced nodes without deleting unreferenced data (`:738`), keeping grouped node instances mounted across presentation modes (`:756`), expanding only the *running* Turn's groups on a mode switch (`:815`), the turn rail (`:1244`-`:1449`), the echo handoff (`:1919`-`:2314`), the failure and max-tokens rows (`:2358`, `:2379`), the whole-Turn folding rules (`:2426`-`:3039`), the assistant footer and usage (`:3161`-`:3335`), the fork action's preconditions (`:3344`-`:3399`), the streaming tail (`:3410`-`:3504`), the running clock (`:3551`, `:3597`), the Host open refusal dialog (`:3642`-`:3711`), the scroll/follow behaviour (`:3731`-`:4269`), the command rows (`:4290`-`:4367`) and the running status (`:4390`).
- **Non-obvious design decisions:** three cases pin the *scroll* rules that the rest of the package depends on: "keeps following when a stream-finalization shrink clamp delivers its scroll" (`:3801`), "lets small reader movements accumulate past the follow threshold during growth" (`:3882`), and "settles pinned deliveries before observer growth without reading row geometry" (`:3844`) — a ResizeObserver-driven follow that must not read the DOM to find the last row.
- **Edge cases / failure handling:** the file-open refusal dialog has four separate cases for its race: a refusal that settles after dismissal (`:3690`), an open that *succeeds* after dismissal (`:3711`), a non-Error refusal (`:3663`) and a refusal with no text (`:3678`) — the "ignore a stale settle" rule is pinned in both directions.
- **Surprising:** "one ResizeObserver owns pinned dynamic-height follow and ignores growth while away" (`:4048`) — a single observer serves both directions, and the *away* case deliberately ignores growth; the two behaviours are one mechanism, not two.

### packages/client/ui-chat/tests/chat-viewport.client.spec.ts
- **Purpose:** the 562-line suite for the DOM-owning viewport: geometry reading, paging anchors and scroll compensation.
- **Key abstractions:** 17 top-level `it` cases (no outer `describe`).
- **Data flow:** the cases cover outer-group geometry and gap handling (`:83`), reading only the supplied column (`:122`), skipping hidden and empty paging markers "without reading their geometry" (`:170`), not measuring the viewport when no marker exists (`:190`), keeping a collapsed header stationary (`:197`), capturing a grouped member and preserving its position after history grows above it (`:215`), anchoring an open group to its old content even when the pointer ray hits its header (`:232`), navigating by node identity (`:278`), excluding empty rows and transparent group shells from fallback sampling (`:294`), retaining a semantic paging row when segmentation remounts its DOM (`:329`), measuring only the selected member when paging starts (`:416`), giving paging compensation priority over an active inner follow animation (`:443`), not compensating twice when native anchoring already held the row (`:525`), and releasing a removed paging row (`:554`).
- **Non-obvious design decisions:** "anchors an open group to its old content even when the pointer ray hits its header" (`:232`) — the *pointer* is explicitly ignored when the target is an open group, because the group's content is the anchor, not the box under the cursor.
- **Edge cases / failure handling:** "does not compensate twice when native inner anchoring already held the old row" (`:525`) is the double-correction guard — the two mechanisms (native scroll anchoring and the manual compensation) can both fire.
- **Surprising:** "skips hidden and empty paging markers without reading their geometry" (`:170`) — the anchor search is *structural*, so it costs no layout reads, which is what keeps the paging path cheap enough to run on every commit.

### packages/client/ui-chat/tests/config.host.spec.ts
- **Purpose:** the 59-line suite for the **Host** half of the package — the settings namespace.
- **Key abstractions:** four `it` cases under `ui-chat Host settings` (`:11`), driven through a real Cordis `Context` and the shared `liveConfig`/`omitsGeneratedPage` helpers from the settings package.
- **Data flow:** the cases register, validate and dispose the transcript-view namespace (`:12`), validate the collapse timing and restore its saved config independently of the work-details mode (`:38`), load the plugin without a settings provider at all (`:53`), and keep the package's own instance off the generated Settings pages (`:59`).
- **Non-obvious design decisions:** "loads without a settings provider" (`:53`) is a *host* test in a *client* package's tree — the Host plugin must not require the browser half to be present, and vice versa.
- **Edge cases / failure handling:** the two preferences are validated independently, so a corrupt `collapseTiming` cannot take the work-details mode down with it.
- **Surprising:** the package registers its settings namespace with `auto: false` and *omits itself* from the generated pages — a package can supply a settings schema without appearing in the global Settings list.

### packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts
- **Purpose:** the 2882-line, ~66-case suite for the **Definitions** — the layer that turns durable Session events into Chat nodes.
- **Key abstractions:** a `DEFINITIONS` array listing all fifteen node Definitions in registration order (`:38`), plus `TestEventDefinitions` / `TestViewDefinitions` adapters (`:56`, `:66`) that feed the shared `ConversationNodeAssembler`.
- **Data flow:** the cases replay synthetic `SessionLiveEventEntry` sequences and assert the assembled node set: the request-prompt start rejects an unrelated event (`:275`), the system-message Definition's unreachable edges are pinned (`:287`), a command-only history stays inactive (`:300`), the rail projection stays current when one chunk updates a node in place (`:319`), rail previews are bounded at the card budget (`:349`), reply content is classified separately from reasoning and Tool protocol blocks (`:361`), one reversible process window is projected before the finalized answer (`:407`), per-Turn counts are right (`:507`), exchanges open only for human input claimed for Step 1 (`:662`), inbox splice chains replay and steering is scoped to the current claim (`:718`), the answer boundary is established only when a streamed answer finalizes (`:881`), one keyed assistant node survives streaming → settlement (`:1004`), and the retry/compaction/max-tokens/turn-error chains are owned separately (`:2446`-`:2877`).
- **Non-obvious design decisions:** "omits first-token metrics after live settlement and after reopening the same history" (`:1234`) and "uses live Assistant deltas without replaying settled embedded streams" (`:1282`) — a *replayed* history must not double-count a metric or double-apply a stream.
- **Edge cases / failure handling:** "withholds reversed unknown replacement endpoints and resolves them after prepend" (`:2017`), "keeps a paged input between its surrounding replies before its inbox insertion loads" (`:1742`), "renders a historical compaction when its start remains outside the loaded window" (`:2586`), and "keeps the max-tokens notice when the window starts after the owning turn/start" (`:2770`) — every one of them is a *partial window* case.
- **Surprising:** "ignores legacy retry and PTC dispatch events without correlation ids" (`:2628`) and "ignores legacy compaction transactions without correlation ids" (`:2608`) — the suite pins that an event *without* a correlation id is inert, so a legacy event cannot create a spurious node.

### packages/client/ui-chat/tests/conversation.client.spec.ts
- **Purpose:** the 59-line unit suite for the event→view projection helpers.
- **Key abstractions:** four `it` cases under `toAssistantBlock` (`:11`).
- **Data flow:** the cases classify the four block shapes (`:12`), create empty streamed block projections (`:37`), "redact auth failures and present the remaining durable values" (`:44`), and recognise only non-empty token deltas (`:52`).
- **Non-obvious design decisions:** the redaction case is the *only* place the auth-message rule is pinned, and it asserts the raw diagnostic stays in the log while the UI state does not carry it.
- **Edge cases / failure handling:** an empty token delta is not a delta — a zero-length delta would otherwise churn the streaming accumulator.
- **Surprising:** the suite imports the block projection from the *client* entry (`@deepseek-ai/dsh-client-ui-chat/client`) rather than the internal module, so it also pins the export surface.

### packages/client/ui-chat/tests/coverage-tails.client.spec.tsx
- **Purpose:** the 70-line suite for the assistant markdown *tails* — the two shapes the larger view suite does not cover.
- **Key abstractions:** two `it` cases under `tails` (`:18`).
- **Data flow:** "AssistantMarkdown renders reasoning as a Think row and unknown blocks as JSON fallback" (`:19`) and "AssistantMarkdown skips the root shell when only tool-call heads remain" (`:49`).
- **Non-obvious design decisions:** the second case is the one that matters visually: a node containing only tool-call heads must render *nothing*, "a node that is only those heads (or empty) would paint an empty root between tool groups" (`AssistantMarkdown.tsx`).
- **Edge cases / failure handling:** an unknown block is not dropped — it is preserved as a JSON row, so a newer block kind still shows something.
- **Surprising:** the file is named `coverage-tails` rather than after the component: it exists to cover the two *edges* the big suite leaves, and it reuses the shared fixtures (`useDetailedPresentation`, `unusedImageLoader`) so it stays short.

### packages/client/ui-chat/tests/event-projection.client.spec.ts
- **Purpose:** the 110-line unit suite for the durable-source→context projection.
- **Key abstractions:** three describes — `contextProducer` (`:11`), `contextForm` (`:74`) and `sessionRecallLabels` (`:98`).
- **Data flow:** eight cases name a plugin producer by its logged plugin id (`:12`), an explicitly invoked skill (`:17`), workspace instructions by the files they reconciled, deduplicated in first-seen order (`:22`), a cross-session snapshot as recall (`:34`), an unknown producer by its own durable kind (`:42`), a fallback to the source kind (`:47`), an unnamed injection for an unreadable source (`:63`), a declared form (`:75`), an opaque fallback for a form this version cannot present (`:85`), and the distinct labels of a session-reference source (`:99`).
- **Non-obvious design decisions:** "identifies a producer this UI version does not know by its own durable kind" (`:42`) — an unrecognised producer is still *named*, using the durable kind rather than being flattened into "unknown".
- **Edge cases / failure handling:** "degrades to an unnamed injection for a source that carries no readable kind" (`:63`) — the *last* resort is an honest "unnamed", not a guess.
- **Surprising:** the dedup is "first-seen order", not alphabetical — the order the files were reconciled in is the informative order.

### packages/client/ui-chat/tests/flow-motion-scope.client.spec.tsx
- **Purpose:** the 58-line suite that the fold coordinator's *scope* is viewport-local.
- **Key abstractions:** two top-level `it` cases (`:28`, `:50`).
- **Data flow:** "isolates fold anchoring and batch room between viewports" (`:28`) mounts two viewports and asserts one fold does not move the other; "keeps ordinary searchable hiding immediate inside a motion-enabled parent" (`:50`) asserts a `hidden="until-found"` hide inside a motion scope is *not* deferred into the batch.
- **Non-obvious design decisions:** the second case is the boundary between two features that look related but must not interfere: searchable hiding is instant, fold motion is batched.
- **Edge cases / failure handling:** a viewport with no driver keeps its CSS transitions — motion is an *opt-in* capability, not a global behaviour.
- **Surprising:** the file tests the *isolation* property rather than any animation, which is the property that actually breaks when a second Chat instance mounts.

### packages/client/ui-chat/tests/flow-motion.client.spec.tsx
- **Purpose:** the 635-line, ~30-case suite for the fold coordinator — the mechanism behind "the work collapses without the transcript jumping".
- **Key abstractions:** `createFlowMotion(driver, changed)` with a *mocked* `InputFoldDriver` (`begin`/`prepare`/`frame`/`finish`, `:25`), so the coordinator's own logic is tested without a real viewport.
- **Data flow:** the cases cover the scope and reduced-motion gate (`:101`), a zero-size collapse finishing synchronously (`:111`), the hidden state committing *before* the idle notification (`:123`), a collapse finishing when no transition event arrives (`:152`), one active interval across overlapping folds (`:163`), an idle callback running immediately without a second invocation (`:184`), cancelling before the batch starts (`:195`), driving non-nested boxes in document order on one batch (`:212`), leaving a reveal-only commit to its CSS transition (`:232`), landing a batch on its frame clock (`:242`), a travelling box staying opaque (`:263`), freezing a box that starts travelling mid-batch (`:280`), input-ownership reporting (`:301`), a batch whose rows all close inside an ancestor that closes on its own (`:318`), holding a row that closes during a batch (`:332`), taking over a closing row at its current size (`:376`), counting only the remaining growth of a taken-over reveal (`:397`), reporting reader cancellation to the driver (`:433`), finishing synchronously under reduced motion (`:451`), not rewriting a reopened row after cancellation (`:462`), cancelling a running batch with its owner (`:479`), keeping a reveal active through opacity and descendant height transitions (`:520`), retaining initially hidden content through a StrictMode effect replay (`:566`), applying initial visibility without animating (`:580`), cancelling an unfinished collapse on unmount (`:602`), and cancelling a stale hide when the same row becomes visible again (`:620`).
- **Non-obvious design decisions:** the `afterEach` asserts `motion.foldActive() === false` **and** `vi.getTimerCount() === 0` (`:47-48`) — a leaked timer or a stuck fold is a defect, so the teardown enforces it on every case.
- **Edge cases / failure handling:** "retains initially hidden content through StrictMode effect replay without starting motion" (`:566`) — React's double-invoked effects must not start a fold or lose the content.
- **Surprising:** "reports a batch as input-owned while it is scheduled or running, not for reveals alone" (`:301`) — the coordinator publishes an *ownership* signal, and a reveal-only batch does not claim ownership. That flag is what lets the scroll layer decide where the fold lands.

### packages/client/ui-chat/tests/fold-follow.client.spec.ts
- **Purpose:** the 245-line suite for the interaction between a fold and the reader's follow intent.
- **Key abstractions:** eight top-level `it` cases (`:131`-`:239`) over a real viewport and a real fold driver.
- **Data flow:** the cases land a following reader at the tail and let content growth consume the room it keeps (`:131`), add the reader's own scrolling during the fold to the position it keeps still (`:154`), keep the reader landing while reader movement awaits sampling (`:165`), land a tail batch on the committed content when it reaches past the estimate (`:177`), keep a reader below folding rows on the same content (`:188`), keep manual off-bottom ownership and reclaim only space below the reader (`:197`), land immediately under reduced motion (`:213`), and not measure geometry to interrupt an idle follow controller (`:239`).
- **Non-obvious design decisions:** "keeps a reader below folding rows on the same content without room or follow" (`:188`) and "keeps manual off-bottom ownership and reclaim only space below the reader" (`:197`) — the *manual* off-bottom state is a separate ownership mode from "following".
- **Edge cases / failure handling:** the last case (`:239`) asserts that interrupting an idle follow controller must not require a geometry measurement — a measurement here would cost a layout flush on every fold.
- **Surprising:** "adds a reader's own scrolling during the fold to the position it keeps still" (`:154`) — the reader's movement *during* the fold is composed with the fold's own compensation, which is the hard case the whole scroll subsystem exists for.

### packages/client/ui-chat/tests/gate-branch-tails.client.spec.tsx
- **Purpose:** the 81-line suite for the two *gates* on the assistant tail — the running-vs-settled reasoning state and the composer statistics fallback.
- **Key abstractions:** three `it` cases (`:25`, `:39`, `:68`).
- **Data flow:** the reasoning row is in the `ok` state when it is not the streaming tail (`:25`), the composer stats fall back to window-node counts and drop the usage pill without projections (`:39`), and the reasoning row as the streaming tail renders the running ring (`:68`).
- **Non-obvious design decisions:** the third case pins the *reverse* of the first — the same component in the running state — so the two states cannot be confused.
- **Edge cases / failure handling:** without the durable projections the usage pill disappears rather than showing a partial number.
- **Surprising:** the file is named for "gates" because it pins the two conditions under which a *row* changes its rendering — the gate, not the component.

### packages/client/ui-chat/tests/group-tree-segments.client.spec.ts
- **Purpose:** the 116-line suite for the exchange segmentation.
- **Key abstractions:** six `it` cases under `Chat group tree` (`:26`).
- **Data flow:** the positions order from the outermost exchange inward (`:27`), the latest segment starts at the last opening Turn and reports only the Turns that moved (`:37`), every opening Node of a Turn is counted and the fallback applies as openings leave (`:59`), the latest remaining opening Turn wins whatever order the openings arrived in (`:82`), segments open at Nodes of the configured position *or an outer one* (`:97`), and the latest segment clears when no Turn is loaded (`:108`).
- **Non-obvious design decisions:** "opens segments at Nodes of the configured position or an outer one" (`:97`) — the `isAtOrOutside` transitivity means an *outer* position also opens a segment.
- **Edge cases / failure handling:** the fallback to "the latest remaining opening Turn" is order-independent, which is what keeps the rail stable while history pages in.
- **Surprising:** the suite asserts the *notification* set ("reports only the Turns that moved"), so the segment computation is incremental by contract, not merely by implementation.

### packages/client/ui-chat/tests/image-labels.client.spec.tsx
- **Purpose:** the 138-line suite for the assistant image gallery and the user-image Slot handoff.
- **Key abstractions:** four `it` cases under `assistant image slot handoff` (`:60`).
- **Data flow:** the cases pass one image group and its message alignment to the renderer (`:61`), update one message loader without changing its sibling or remounting either gallery (`:71`), merge consecutive image blocks into one group and split groups at text (`:111`), and keep the renderer output at the image block position between text blocks (`:125`).
- **Non-obvious design decisions:** the second case (`:71`) is the anti-remount rule: streaming into one image must not remount the *other* image's gallery — which is exactly why `AssistantMarkdown.tsx` keys the gallery on the group's *first* block index.
- **Edge cases / failure handling:** a group boundary is a *text* block — images on either side are two galleries, not one.
- **Surprising:** the same mechanism covers the assistant gallery and the user message's attachments; the tests for both live in different files but assert the same "grows rather than remounts" rule.

### packages/client/ui-chat/tests/performance-usage.client.spec.ts
- **Purpose:** the 38-line unit suite for the statistics-detail preference.
- **Key abstractions:** two `it` cases under `PerformanceUsagePolicy` (`:7`) plus one top-level case (`:32`).
- **Data flow:** "keeps an explicit choice live while the Host write is pending or refused" (`:8`) uses a `stubConfigForm` and asserts the policy keeps showing the chosen mode even after the host publishes `writable: false`; "adopts accepted Host settings at construction and after updates" (`:22`) asserts the opposite direction.
- **Non-obvious design decisions:** a *refused* write must not silently revert the selection — "a refused or pending write keeps the selected mode until the Host answers".
- **Edge cases / failure handling:** "releases its subscription when the consuming plugin unloads" (`:32`) asserts the listener count goes 1 → 0 — a leak here is a plugin that never releases its config subscription.
- **Surprising:** the suite checks the *policy object* (`policy.mode.getSnapshot()`), not a rendered component — the preference's truth is a store value, and the renderer is downstream.

### packages/client/ui-chat/tests/presentation-fixture.client.ts
- **Purpose:** the 10-line fixture that pins one display policy for isolated component tests.
- **Key abstractions:** `useDetailedPresentation` (`:10`) — a `UsePresentation` that always selects `presentationPolicyFor('detailed')`.
- **Data flow:** the fixture imports the production `presentationPolicyFor`, so the component under test sees the *real* Detailed policy rather than a hand-made stub.
- **Non-obvious design decisions:** the fixture lives in the *tests* tree but imports production code — a policy stub that hand-copies the table would drift the moment `POLICIES` changes.
- **Edge cases / failure handling:** it is a *fixed* policy with no subscription and no disposal, so a component that unsubscribes on unmount still behaves.
- **Surprising:** 9 lines decide the reasoning-preview behaviour of every component test in the package — the smallest file here has the widest blast radius.

### packages/client/ui-chat/tests/presentation-policy.client.spec.tsx
- **Purpose:** the 91-line suite for the mode→capability policy table.
- **Key abstractions:** three `it` cases under `Chat presentation policy` (`:11`).
- **Data flow:** "keeps all eight mode and timing policies distinct and stable" (`:28`) asserts that the eight combinations (four modes × two timings) are *distinct objects* and that asking twice returns the *same* object; "forwards both preferences and removes both subscriptions on disposal" (`:38`); "renders only consumers whose selected field changes" (`:59`).
- **Non-obvious design decisions:** the third case (`:59`) is the important one — a mode change must re-render only the components whose *selected capability* changed, which is the whole reason the policy is a table of capabilities rather than a mode enum.
- **Edge cases / failure handling:** stability of the policy object identity is asserted explicitly, because an unstable identity would re-render every consumer on every read.
- **Surprising:** eight policies from two inputs is asserted by a single test — the table is exhaustive, so a new mode cannot be added without a policy for it.

### packages/client/ui-chat/tests/process-groups.client.spec.ts
- **Purpose:** the 549-line, ~19-case suite for the Definition-owned process grouping.
- **Key abstractions:** a `harness()` helper (`:55`) that wires `ChatSnapshotBuilder` → `ProcessState` → `ConversationGroupStore` and commits, exactly as the production wiring does.
- **Data flow:** the cases cover the bounded grapheme prefix (`:91`, `:143`), clearing preparation from a closed group while retaining its recorded activity (`:180`), regrouping when a node changes position without changing kind (`:241`), the Turn control as an independent root (`:250`, `:264`), retaining a group through repeated prepends (`:283`), splitting an extended group without reusing one identity for two groups (`:322`), resegmenting only the changed Turn without notifying historical sources (`:335`), closing only the ended Turn (`:367`), splitting and rejoining one Turn when a separator enters and leaves (`:391`), moving a group head between Turns in one atomic update (`:408`), re-reading only the changed group on a content update (`:419`), rebuilding ranges while retaining unchanged groups (`:442`), restoring live detail when a replacement removes a closing separator (`:462`), splitting reasoning from replies (`:477`), updating live detail without replacing roots (`:490`), keeping a no-Turn row between groups (`:514`), and closing an active group on a lifecycle-only update (`:536`).
- **Non-obvious design decisions:** "resegments only the changed Turn without notifying historical Node or Group sources" (`:335`) is the incrementality contract, asserted by *notification*, not by output.
- **Edge cases / failure handling:** "does not create preparing rows from stored Assistant streams in history or older pages" lives in `packages/client/ui-chat/tests/tool-preparation.client.spec.ts:334` — the same rule seen from the Tool side.
- **Surprising:** the harness commits through the *real* group store rather than inspecting the state object, so every case exercises the publish path too.

### packages/client/ui-chat/tests/quota-notice.client.spec.tsx
- **Purpose:** the 236-line suite for the frame-wide quota notice — the notice's lifetime and its hold tokens.
- **Key abstractions:** seven `it` cases under `frame-wide quota notices` (`:108`).
- **Data flow:** one notice is published per live append and the latest is republished (`:109`); nothing is published for history replacement, paging or a non-quota failure (`:123`); the notice stays on screen after the viewed Session goes away (`:142`); it is retained until the takeover releases its hold (`:161`); acquiring a hold with no live notice suppresses nothing (`:182`); a stale release that arrives after a dismissal or a newer hold is ignored (`:196`); and the subscription is detached when the plugin unloads with a retained binding (`:223`).
- **Non-obvious design decisions:** the "stale release" case (`:196`) is the whole point of the `Set<symbol>` hold design — "a release drops only its own hold, so one that runs after a dismissal or a newer hold leaves that newer hold intact".
- **Edge cases / failure handling:** "keeps the notice on screen after the viewed Session goes away" (`:142`) pins that the notice outlives the panel that reported it — the reason the host is registered in `shell.overlay`.
- **Surprising:** "never publishes for history replacement or paging" (`:123`) — an old failure scrolling back into view is not news.

### packages/client/ui-chat/tests/reasoning-component-fixture.tsx
- **Purpose:** the 33-line fixture that renders the *production* reasoning component without a registry.
- **Key abstractions:** `unusedImageLoader` (`:14`), a `content()` helper (`:18`), `renderReasoningSlot` (`:24`) and `renderReasoningFactory` (`:30`).
- **Data flow:** both seats accept exactly one key — `conversation.chat.reasoning.body` and `conversation.chat.reasoning.content` — and throw on anything else, so a component test cannot silently mount the wrong renderer.
- **Non-obvious design decisions:** the fixture supplies the *real* `ReasoningContent` component at the Factory seam, rather than a stub — so a component test that exercises the reasoning body is exercising the shipped body.
- **Edge cases / failure handling:** `unusedImageLoader` throws on any attachment load, so a test that accidentally renders an image fails loudly instead of hanging on a promise.
- **Surprising:** the fixture is documented as "Child-renderer stubs for component units; registry behavior uses the real runtime fixture" — there are two fixture families and they are explicitly not interchangeable.

### packages/client/ui-chat/tests/reasoning-content.client.spec.tsx
- **Purpose:** the 91-line suite for the replaceable reasoning Content Factory.
- **Key abstractions:** four `it` cases under `reasoning Content Factory` (`:30`).
- **Data flow:** the Factory renders without a Session Provider and uses the current Chat labels by default (`:31`); it uses complete caller labels unchanged and returns to the defaults when they are omitted (`:40`); it keeps code-wrapping state independent between two Factory occurrences (`:53`); and it restores the registered default after a wrapping plugin unloads, removing the Factory with its owner (`:68`).
- **Non-obvious design decisions:** the first case (`:31`) is why the slot is declared `scope: 'root'` — a reasoning renderer that needed a Session could not be unit-tested at all.
- **Edge cases / failure handling:** the last case (`:68`) is the *unload* path: a replacement Factory must remove itself with its owner and the default must come back, not leave a hole.
- **Surprising:** "keeps code wrapping state independent between two Factory occurrences" (`:53`) — two reasonings on screen must not share a wrap toggle, which is a per-instance state question the slot scope decides.

### packages/client/ui-chat/tests/reasoning-render-fixture.tsx
- **Purpose:** the 65-line fixture that mounts the **real** Slot and Factory runtime for reasoning tests.
- **Key abstractions:** `createReasoningRenderFixture(language = 'zh')` (`:24`) — it creates a `SlotTestRuntime`, installs a `LocaleRuntime` with both the `common` and the `chat` namespaces, declares the `conversation.chat.reasoning.body` slot, and mounts the production `registerChatNodeRenderers` (`:42`).
- **Data flow:** the fixture returns `{ runtime, owner, locale, render, renderSlot, renderFactorySlot }` so a test can mount the shipped default, replace it, unload it and observe the lifecycle.
- **Non-obvious design decisions:** the fixture mounts the *real* `registerChatNodeRenderers` rather than a reduced registration — so the reasoning body it exercises is the one the package ships, including its priority-100 default entry.
- **Edge cases / failure handling:** `onTestFinished(() => runtime.dispose())` disposes the runtime even when an assertion throws, so a failed test cannot leak a mounted plugin into the next one.
- **Surprising:** it retains a real `Session` (`runtime.sessions.add` + `retainFor`) even though the reasoning Factory is root-scoped — because the *slot* is session-scoped, so the seam above it still needs one.

### packages/client/ui-chat/tests/reasoning-row.client.spec.tsx
- **Purpose:** the 448-line, ~12-case suite for the reasoning disclosure and its interaction with the assistant markdown.
- **Key abstractions:** two describes — `AssistantMarkdown reasoning blocks` (`:23`) and `ReasoningRow` (`:136`).
- **Data flow:** the cases cover retaining an expanded earlier row when a blank streaming tail receives text (`:58`), keeping non-blank rows and their expanded bodies across modes (`:107`), offering only text and streaming state to the standard Body Slot after expansion (`:137`), retaining summaries and expanded Markdown across a mode change (`:175`), keeping a running preview enabled in Compact and hiding it on settlement (`:205`), advancing on completed-paragraph first lines (`:247`), expanding from either the Think row or the reasoning summary (`:303`), keeping heading syntax in the collapsed summary (`:353`), keeping completed reasoning blocks mounted while the open streaming tail grows (`:380`), dropping the inline summary in an expanded Think (`:409`), and anchoring the sticky-header selector (`:426`).
- **Non-obvious design decisions:** "retains an expanded earlier row when a blank streaming tail receives text" (`:58`) is the blank-tail rule the source comment names: "A blank streaming tail produces no row and does not transfer its running state to an earlier block".
- **Edge cases / failure handling:** "offers only text and streaming state to the standard Body Slot after expansion" (`:137`) — the Body receives exactly two facts, so a replacement cannot read anything else.
- **Surprising:** "keeps heading syntax in the collapsed summary and renders compact headings when expanded" (`:353`) — the collapsed summary is *truncated at the first newline*, not rendered as Markdown, so the summary keeps the `#` the model wrote.

### packages/client/ui-chat/tests/running-status.client.spec.tsx
- **Purpose:** the 69-line suite for the "Deep diving" running indicator.
- **Key abstractions:** three `it` cases under `RunningStatus` (`:24`).
- **Data flow:** the indicator "waits for an open Turn start before allocating its clock" (`:25`), "keeps the indicator mounted while a continuous run moves to the next Turn" (`:38`), and "keeps the duration nonnegative when the start is ahead of the local clock" (`:60`).
- **Non-obvious design decisions:** the clock starts when the *Turn* starts, not when the component mounts — a component that mounted late must not report a shorter run.
- **Edge cases / failure handling:** the third case (`:60`) covers a host clock ahead of the local one: the duration clamps at zero rather than rendering a negative.
- **Surprising:** "keeps the indicator mounted while a continuous run moves to the next Turn" (`:38`) — the indicator must not blink out and back between two turns of the same run.

### packages/client/ui-chat/tests/running-whale-tail.client.spec.tsx
- **Purpose:** the 63-line suite for the decorative running glyph.
- **Key abstractions:** two `it` cases under `RunningWhaleTail` (`:11`).
- **Data flow:** the component renders "a decorative mask seat and static SVG without inline styles" (`:12`), and the asset check asserts the package "ships a 28px alpha APNG with sixty 50ms frames and infinite playback" (`:30`).
- **Non-obvious design decisions:** the "without inline styles" assertion means the glyph is *styled by the stylesheet*, not by React inline attributes — so it can be swapped by CSS (reduced motion, forced colors, no alpha-mask support) with no JS branch.
- **Edge cases / failure handling:** the asset check reads the PNG's chunk table directly from disk, so the frame count and the frame delay are part of the *contract*, not an implementation detail.
- **Surprising:** the test's "sixty 50ms frames" claim and the previous pass's own chunk scan disagree (43 `fcTL`/`fdAT` pairs were counted by hand); I did not decode the `acTL` payload, so I record the discrepancy rather than settle it.

### packages/client/ui-chat/tests/scroll-follow.client.spec.ts
- **Purpose:** the 227-line suite for the bottom-follow intent and the native smooth-scrolling controller.
- **Key abstractions:** 12 `it` cases under `ScrollFollow` (`:21`).
- **Data flow:** the cases cover not awaiting native events for a fractional floor that cannot move (`:22`), releasing only its own scrollport binding (`:47`), keeping independent thresholds and adopting only attributed reader movement (`:60`), finishing native motion before following the latest grown floor (`:74`), finishing native motion when shrinking content clamps its target (`:104`), retargeting growth during native motion without jumping (`:115`), cancelling a retargeted animation before accepting subsequent reader movement (`:137`), cancelling native motion before input without treating the cancellation as scrolling away (`:166`), positioning opening and external landings immediately (`:185`), and the reduced-motion paths (`:197`, `:206`).
- **Non-obvious design decisions:** "cancels native motion before input without treating the cancellation itself as scrolling away" (`:166`) — the cancellation must not be *attributed* to the reader, or the follow intent would flip off exactly when the user submitted something.
- **Edge cases / failure handling:** "finishes native motion when shrinking content clamps its target" (`:104`) — a clamp is a real endpoint, not a failure.
- **Surprising:** "releases only its own scrollport binding" (`:47`) is the `WeakMap`-by-element design's safety property: two scrollports cannot release each other's controller.

### packages/client/ui-chat/tests/skill-name-projector.client.spec.ts
- **Purpose:** the 103-line suite for the incremental skill-name decoration.
- **Key abstractions:** five `it` cases under `SkillNameProjector` (`:51`), with a `storeOf` helper that *counts* `values()` calls (`:31`).
- **Data flow:** a replace attaches a batch's injected skill names and leaves other nodes untouched (`:52`); a late injection updates only the direct messages of its batch (`:71`); a re-emitted direct message is re-decorated (`:81`); and a boundary arriving inside a batch splits it and drops the names past it (`:94`).
- **Non-obvious design decisions:** "an assistant-only apply neither scans the store nor re-emits message Nodes" (`:61`) asserts `store.valuesCalls === 0` — the count is the assertion, so a future implementation that scans the store on every streaming frame fails here rather than in a perf review.
- **Edge cases / failure handling:** "a boundary arriving inside a batch splits it and drops the names past it" (`:94`) — the *later* message in the same step does not inherit the earlier one's skill names.
- **Surprising:** "re-decorates a direct message the assembler re-emits without names" (`:81`) — a rebuilt node carries Definition state only, so the projector must re-apply its decoration from the store it already holds.

### packages/client/ui-chat/tests/sticky-header-styles.client.spec.ts
- **Purpose:** the 70-line **static-CSS** suite for the pinned disclosure headers.
- **Key abstractions:** four `it` cases under `pinned collapsible headers` (`:21`).
- **Data flow:** the cases assert that an open Think header is pinned to the scrollport top and masks the prose under it (`:22`), that the pinned compaction header ranks above the code-block banner (`:33`), that a summary code banner is held below the pinned header band "on the toggle's own measurement" (`:49`), and that the pinned compaction header stays opaque under hover (`:65`).
- **Non-obvious design decisions:** the third case (`:49`) pins the *shared measurement*: the banner's offset is the toggle's own height variable, so the two cannot drift apart.
- **Edge cases / failure handling:** the fourth case (`:65`) is the "translucent hover would let the scrolling prose show through" rule — a hover fill that is not opaque is a visible defect.
- **Surprising:** these are CSS-text assertions, so a specificity change in another package's stylesheet (which the comment in `MessageItem.module.css` explicitly warns about) is caught here.

### packages/client/ui-chat/tests/system-prompt-row.client.spec.tsx
- **Purpose:** the 62-line suite for the system-prompt disclosure row.
- **Key abstractions:** two `it` cases under `SystemPromptNodeView` (`:11`).
- **Data flow:** the row "mounts the opaque context body only while its row is expanded" (`:12`) and "titles an in-history prompt update as an update of the same row" (`:45`).
- **Non-obvious design decisions:** the *lazy mount* is the assertion — the body must not be in the DOM while collapsed, so the expanded body cannot cost a render per row.
- **Edge cases / failure handling:** the second case pins the distinction between "the prompt in force" and "a prompt that was in force" — an in-history update is titled as an *update*, not as a new prompt.
- **Surprising:** the system prompt reuses the context body's opaque chrome, so the same row shape serves a system message and an injected context.

### packages/client/ui-chat/tests/tool-call-tree.client.spec.ts
- **Purpose:** the 90-line unit suite for the recursive tool-call tree.
- **Key abstractions:** four `it` cases under `ToolCallTree` (`:28`), with `at`/`start`/`settle` event builders (`:9`, `:12`, `:17`).
- **Data flow:** the suite rejects a self-parenting dispatch edge (`:29`), rejects a settling edge that would close a multi-call cycle (`:37`), accepts an acyclic graph with a shared descendant (`:52`), and rejects an edge beyond the recursive depth safety limit (`:69`).
- **Non-obvious design decisions:** the third case (`:52`) is the one that stops the guard from being too strict: a *shared descendant* (a diamond) is legal, only a *cycle* is not.
- **Edge cases / failure handling:** the depth limit is asserted at the boundary, so the number `256` is a contract rather than a constant.
- **Surprising:** the cycle case is a *multi-call* cycle (`A→B→C→A`), not a self-parent — the trivial case would pass even with a naive ancestor-only check.

### packages/client/ui-chat/tests/tool-preparation.client.spec.ts
- **Purpose:** the 381-line, 12-case suite for the Tool node's preparing→dispatched→result lifecycle and its durable replay.
- **Key abstractions:** 12 `it` cases under `Tool preparation and durable replay` (`:103`).
- **Data flow:** the cases cover: Assistant state staying unchanged for parameter-only deltas while the Tool reader advances (`:104`); accepting a complete tool block before `tool/call` when no deltas were observed (`:119`); retaining the argument reader across matching block-end, call and result (`:127`); accepting deltas after a closing brace until block-end (`:164`); batching repeated named deltas and retaining the unchanged Tool node (`:200`); publishing a reread argument change (`:217`); two independent live preparations under the same key (`:248`); five command preparations below the Assistant message through dispatch and Step end (`:276`); hiding undispatched preparations when a settled Step ends (`:318`); not creating preparing rows from stored Assistant streams in history (`:334`); retaining a dispatched call when its earlier transient start is withdrawn (`:351`); and abandoning one attempt so a later live attempt creates its own preparation (`:367`).
- **Non-obvious design decisions:** "accepts deltas after a closing brace until block-end without checking closed()" (`:164`) — the tool's *own* parser must not be stricter than the wire, or a valid argument containing `}` would be truncated.
- **Edge cases / failure handling:** "hides undispatched preparations when a settled Step ends before every call starts" (`:318`) — a preparation that never dispatched is *hidden*, not shown as a failed call, and "does not create preparing rows from stored Assistant streams in history or older pages" (`:334`) keeps a replayed page clean.
- **Surprising:** "retains a dispatched call when its earlier transient start is withdrawn" (`:351`) — the *dispatch* is the fact, and the earlier transient preparation may be retracted without losing the call.

### packages/client/ui-chat/tests/tool-updates.client.spec.tsx
- **Purpose:** the 51-line suite for the tool-change summary inside the context row.
- **Key abstractions:** one `it` case (`:17`).
- **Data flow:** "shows counts collapsed and compact name lists when expanded" (`:17`) — a single tool addition/removal is named inline, multiple show counts and expand to comma-separated lists.
- **Non-obvious design decisions:** the collapsed form is a *count* and the expanded form is a *list*; the disclosure is the only way to see which tools changed, which keeps the collapsed context row quiet.
- **Edge cases / failure handling:** the expanded list is `white-space: nowrap` in the stylesheet, so the names read as one run rather than as a wrapped paragraph.
- **Surprising:** the test imports the Chat locale in *both* languages (`en` and `zh`) and asserts the copy in both — the suite is bilingual by construction.

### packages/client/ui-chat/tests/transcript-view-policy.client.spec.ts
- **Purpose:** the 171-line suite for the two transcript preferences.
- **Key abstractions:** five `it` cases under `TranscriptViewPolicy` (`:9`).
- **Data flow:** the policy "defaults to completion and persists explicit timing without reading or writing browser storage" (`:10`), "restores both saved preferences in each new instance" (`:49`), "adopts independent Host mode and timing updates without writing them back" (`:71`), "defaults to Detailed and publishes explicit choices before persistence settles" (`:91`), and "releases its subscription when the consuming plugin unloads" (`:165`).
- **Non-obvious design decisions:** the first case (`:10`) explicitly asserts *no browser storage* — the preferences live in the Host's config, and the client never keeps a second copy in `localStorage`.
- **Edge cases / failure handling:** the third case (`:71`) pins that a Host update is adopted in *both* directions but never written back — the client is a mirror of the Host's truth, not a second source of truth.
- **Surprising:** the same policy object handles two independent preferences (mode and timing) and the suite asserts they are restored *independently* — a corrupt one cannot take the other down.

### packages/client/ui-chat/tests/transcript-view-row.client.spec.tsx
- **Purpose:** the 251-line suite for the three Settings rows.
- **Key abstractions:** three describes — `TranscriptViewRow` (`:61`), `LinkOpeningRow` (`:189`) and `PerformanceUsageRow` (`:234`).
- **Data flow:** the cases explain the preference and show Standard by default (`:62`), follow timing changes and close the menu without changing either preference (`:94`), "return focus before publishing a timing change" (`:105`), show all four work-detail values in Chinese (`:147`), "return focus before publishing a mode change without refocusing after the menu closes" (`:163`), follow browser availability without clearing the saved destination (`:190`), and select compact statistics independently of conversation display (`:235`).
- **Non-obvious design decisions:** the focus order is pinned twice and in opposite forms: focus is restored to the trigger *before* the value is published (`:105`), and it is *not* re-focused after the menu closes (`:163`) — restoring focus twice would fight the menu's own teardown.
- **Edge cases / failure handling:** "follows browser availability without clearing the saved destination" (`:190`) — a temporarily-unavailable browser must not erase the user's choice.
- **Surprising:** the Chinese case (`:147`) exists because the four mode values are *user-facing labels*; a missing translation is a visible defect, so it is pinned in a locale test.

### packages/client/ui-chat/tests/turn-metrics.client.spec.ts
- **Purpose:** the 76-line unit suite for the per-step latency facts and the footer figures.
- **Key abstractions:** two describes — `assistantStepReading` (`:25`) and `footer figure formatters` (`:65`).
- **Data flow:** the reading derives ttft, decode time and output tokens from a fully recorded step (`:26`), returns nulls when timing is absent (`:35`), "needs both boundaries for ttft and clamps negative spans to zero" (`:40`), and "rejects non-object, missing, and non-finite usage token counts" (`:55`). The formatter cases omit a redundant decimal zero in cache-hit percentages (`:66`) and format throughput with whole tokens from ten up (`:70`).
- **Non-obvious design decisions:** `null` marks an *unrecorded* part and never zero — a zero decode time is a different claim from "not measured".
- **Edge cases / failure handling:** a negative span clamps to 0 (`:40`), and a `NaN` or negative token count is rejected outright (`:55`).
- **Surprising:** the suite mixes a *contract* module (`contract/turn-metrics.ts`) with a *formatting* module (`chat/message-chrome.ts`) in one file — both produce the footer's numbers, and both are read together.

### packages/client/ui-chat/tests/turn-navigator-fixture.ts
- **Purpose:** the 60-line fixture that supplies the viewport sizes jsdom does not have.
- **Key abstractions:** `installTurnNavigatorObserver(initialHeight = 300)` (`:9`) — a fake `ResizeObserver` plus an element-local `scrollTo` that dispatches a `scroll` event inside `act()`.
- **Data flow:** the fake observer only observes elements whose parent is a `NAV` (`:17`), so a stray observer registration is ignored; `resize(nextHeight)` re-delivers the height to every registered rail.
- **Non-obvious design decisions:** the fake `scrollTo` compares against `element.scrollTop` and does nothing when the target is the current position — jsdom does not fire a scroll event for a no-op, and emulating that is what makes the "fractional no-op" case testable.
- **Edge cases / failure handling:** the delivery is guarded by `rails.get(element) === this`, so an observer that was disconnected does not deliver into a replaced one.
- **Surprising:** the fixture *stubs a global* (`vi.stubGlobal('ResizeObserver', Observer)`) rather than injecting one — the component reads the global, so the test has to replace the global.

### packages/client/ui-chat/tests/turn-navigator.client.spec.tsx
- **Purpose:** the 155-line suite for the fixed-pitch turn rail.
- **Key abstractions:** five `it` cases under `TurnNavigator` (`:27`), built on the `installTurnNavigatorObserver` fixture.
- **Data flow:** the cases cover placing the latest committed active turn on its first viewport size "without scroll commands" (`:28`), exposing separate activation and fixed-height scrolling controls "without querying the scroll extent" (`:50`), keeping keyboard focus mounted while scrolling to another virtual range (`:70`), keeping active marks inside the safe band still (`:91`), and not letting a scroll-induced pointer entry replace a hover or focused preview (`:123`).
- **Non-obvious design decisions:** "without querying the scroll extent" (`:50`) — the rail's `estimateSize`/`measureSize` are constants, so the rail never reads the DOM's scroll extent; a virtualizer that measures would be correct but would force layout on every render.
- **Edge cases / failure handling:** "keeps keyboard focus mounted while scrolling to another virtual range" (`:70`) — the range extractor mounts the focused mark's neighbours so a keyboard user does not lose focus by scrolling.
- **Surprising:** "does not let scroll-induced pointer entry replace a hover or focused preview" (`:123`) — a preview is chosen by *intent* (pointer moved there, or focus), not by "the pointer happens to be over it now".

### packages/client/ui-chat/tests/turn-process-tail.client.spec.ts
- **Purpose:** the 136-line suite for Turn nodes inside a *partial* window.
- **Key abstractions:** one `it` case under `Turn nodes in partial windows` (`:58`).
- **Data flow:** the case "retains Step Locations and first-token timing through message settlement, replay, and prepend" (`:59`) — a window that starts mid-Turn must keep the Step boundaries and the first-token time, so the metrics and the answer boundary survive.
- **Non-obvious design decisions:** the test is about *retention*, not about rendering: the projection must keep facts it saw, even when the window's start event is not loaded.
- **Edge cases / failure handling:** "prepend" is the hard direction — prepending older history re-slices the window, and the Step locations must not be lost.
- **Surprising:** a single 136-line file covers the whole partial-window rule for the Turn process — the business rule is one sentence, and the test is long because the setup is long.

### packages/client/ui-chat/tests/turn-rail-items.client.spec.ts
- **Purpose:** the 77-line unit suite for the rail's two-source merge.
- **Key abstractions:** five `it` cases under `mergeTurnRailItems` (`:11`).
- **Data flow:** the merge returns a stable empty array when both sides are empty (`:12`), maps outline-only turns to unloaded marks (`:16`), prefers the loaded side on overlap but fills empty previews from the outline (`:27`), passes loaded turns through when the outline is absent or lagging (`:48`), and "drops entries with damaged navigation fields but degrades malformed previews to empty" (`:58`).
- **Non-obvious design decisions:** the load-bearing distinction is stated in the test's own comment: "turn/seq are load-bearing (drop); previews are decorative (degrade)" (`:71`) — a damaged *turn number* makes the mark un-navigable and the entry is dropped; a damaged *preview* only costs a preview.
- **Edge cases / failure handling:** the last case rejects a negative turn, a fractional seq, `-0`, an unsafe integer and a `null` entry, while keeping the entry whose preview is a number (degraded to `''`).
- **Surprising:** `Object.is(entry.seq, -0)` is rejected specifically because `-0` would break the seq comparison — a case that only a value-identity check catches.

### packages/client/ui-chat/tests/turn-tail-spacing.client.spec.ts
- **Purpose:** the 16-line **static-CSS** suite for the completed-turn footer's spacing.
- **Key abstractions:** one `it` case under `completed-turn spacing` (`:9`).
- **Data flow:** the case reads `ChatView.module.css` and asserts the flow-gap variable, then reads `TurnTailNodeView.module.css` and asserts the footer's `gap: 16px` and the action row's `margin-top: 4px` (`:11-14`).
- **Non-obvious design decisions:** the check is a *regex over the stylesheet text*, so it asserts the arithmetic rather than a rendered pixel — "combines the flow and footer offsets around turn-tail content" is a design rule, and it is cheap to keep.
- **Edge cases / failure handling:** the `s` flag on the regex makes `.root { … }` match across newlines, so a reformatted stylesheet does not silently stop matching.
- **Surprising:** 16 lines of test guard two numbers that together decide whether the completed-turn footer is separated from the message above it by 16px or by 20px.

### packages/client/ui-chat/tests/turn-trigger.client.spec.tsx
- **Purpose:** the 99-line suite for the non-human turn-trigger notice.
- **Key abstractions:** one `it` case under `Turn trigger notices` (`:26`).
- **Data flow:** the case "opens the recorded notice body and closes it independently of the Turn" (`:75`).
- **Non-obvious design decisions:** the disclosure state is the *notice's own*, not the Turn's — closing it must not close the Turn, and the Turn ending must not close it.
- **Edge cases / failure handling:** the recorded body is shown verbatim; the notice says nothing about whether the work succeeded ("it does not imply successful execution").
- **Surprising:** a schedule, a plugin update and a webhook all render as the *same* notice shape with different icons and titles — one component, many sources.

### packages/client/ui-chat/tests/turn-usage-panel.client.spec.tsx
- **Purpose:** the 107-line suite for the per-turn usage pill and its dialog.
- **Key abstractions:** four `it` cases under `TurnUsagePanel` (`:15`).
- **Data flow:** the pill shows an icon-and-total and opens the usage dialog on click (`:16`); unavailable optional facts are omitted rather than invented (`:53`); a partial cache hit stays below 100 in the dialog and the dialog closes on Escape or an outside pointerdown (`:71`); and it closes on an outside *click* without pointerdown, "as keyboard activation elsewhere fires" (`:99`).
- **Non-obvious design decisions:** the fourth case (`:99`) is why the dialog's outside-close handler is capture-phase: a keyboard `click` on a sibling pill has no `pointerdown`, so a pointerdown-only handler would let two dialogs stack.
- **Edge cases / failure handling:** "omits unavailable optional facts instead of inventing values" (`:53`) — a missing cache bucket is absent, not zero.
- **Surprising:** the same file that renders the pill asserts the *cache-hit honesty* rule — the dialog must not round a partial hit to 100.

### packages/client/ui-chat/tests/use-disclosure.client.spec.tsx
- **Purpose:** the 99-line suite for the injected disclosure state.
- **Key abstractions:** three `it` cases under `injected disclosure state` (`:20`).
- **Data flow:** the hook supports "local explicit reveal and collapse without a reset source" (`:21`), "subscribes only where the forwarded Hook is called and releases those subscriptions" (`:40`), and "keeps each disclosure independent while resetting all consumers of the same source" (`:68`).
- **Non-obvious design decisions:** the second case (`:40`) is the lazy-subscription rule: a seat that never opens a disclosure never subscribes, so a transcript with a thousand closed rows has no thousand subscriptions.
- **Edge cases / failure handling:** the third case (`:68`) pins both halves at once — independent instances, and a shared reset source that closes all of its consumers at once.
- **Surprising:** the reset is a *counter*, not a boolean, so "reset all consumers of the same source" is expressible without a shared mutable object.

### packages/client/ui-chat/tests/user-content-component-fixture.tsx
- **Purpose:** the 27-line fixture that binds the *production* user content for component tests.
- **Key abstractions:** `createUserContentFixture(actions?)` (`:14`), which delegates the text parsing to `createUserTextFixture` from the ui-conversation package.
- **Data flow:** the returned renderer accepts `(input, renderSlot, t)` and supplies a `renderFactorySlot` that accepts exactly `conversation.user.text` and throws on any other factory name (`:22`).
- **Non-obvious design decisions:** the fixture reuses the *other* package's own user-text fixture rather than reimplementing text parsing — so a change to file mentions or session mentions shows up in this package's tests.
- **Edge cases / failure handling:** the unknown-factory throw means a component test cannot accidentally render a *different* factory's output and call it a pass.
- **Surprising:** the fixture's doc comment states the division explicitly: "Production user content for component units; registry integration uses SlotTestRuntime" — two fixture families, one for components, one for the registry.

### packages/client/ui-chat/tests/user-content.client.spec.tsx
- **Purpose:** the 279-line, 8-case suite for the user-content Factory.
- **Key abstractions:** eight `it` cases under `user Content Factory` (`:124`).
- **Data flow:** the Factory renders prepared text directly without a row, admission markers, time or copy controls (`:125`); it keeps mixed files, durable images and local previews in their prepared order through the user-image Slot (`:142`); it reuses one prepared value in unrelated parents while nested images inherit each Session (`:178`); it binds live Chat locale labels for reference summaries and opaque extra blocks (`:200`); it opens file and skill references through their own injectors only in interactive content (`:219`); an empty prepared value stays empty (`:240`); live content is removed on owner disposal and rendered again after registration (`:252`); and it requires a Session binding even when the prepared value has no images (`:263`).
- **Non-obvious design decisions:** the last case (`:263`) is the strict one: the Factory declares a Session scope, so a missing binding is an error even when the content needs nothing from the Session.
- **Edge cases / failure handling:** "removes live content on owner disposal and renders it again after registration" (`:252`) is the unload/reload lifecycle, pinned so a disposed owner's content cannot linger in the DOM.
- **Surprising:** "renders prepared text directly without a row, admission markers, time, or copy controls" (`:125`) — the Factory owns the *content*, and the row owns the chrome; the two are separate owners and the split is asserted.

### packages/client/ui-chat/tests/views-type-chain.client.spec.tsx
- **Purpose:** the 30-line **type-level** suite for the Chat view's prop chain.
- **Key abstractions:** one `it` case under `Chat View type chain` (`:6`).
- **Data flow:** the case uses `@ts-expect-error` on five negative assertions (`:14-25`): `openFile` does not belong to the target-neutral base; `openFile` accepts a path on the Chat inject face; the Chat View renders only its flow child; output images belong to the Assistant node entry; the flow owner's data cannot override the flow's render authority; and node renderers receive the bound hook, not the viewport controller.
- **Non-obvious design decisions:** the assertions are `@ts-expect-error`, so the *compiler* is the test — the case passes only if each of those calls is genuinely a type error, and fails at `tsc` time if any of them becomes legal.
- **Edge cases / failure handling:** the negative list is exactly the set of capabilities that must *not* leak into the shared base, because a leak would let a neutral target depend on Chat's specifics.
- **Surprising:** the test body is a function that is never called (`expect(negatives).toBeTypeOf('function')` at `:28`) — the whole assertion is the type-checking of the function's body.

---

## Ideas worth stealing

- **Declare a node's *structural position* once, and let every consumer read that one declaration** — `packages/client/ui-chat/src/client/contract/group-tree.ts:25` — `ChatGroupTree = 'exchange' | 'input' | 'turn' | 'process'` plus `isAtOrOutside(node, position)`. In August this is the mechanism that would replace every "is this a turn error / a compaction / a retry" special case: grouping, whole-Turn folding, Turn-input detection and answer detection all read the *position*, so adding a node kind cannot silently escape one of them. The rule "a Node at a position also has the effect of every inner position" is the part worth copying — one declaration, transitive containment.

- **Insert UI-only rows into an event-ordered list with fractional sequence offsets instead of rewriting the log** — `packages/client/ui-chat/src/client/conversation-nodes/common.ts:15` — `CHAT_SYNTHETIC_SEQ_OFFSETS = { interruptedAssistant: -0.9, interruptedFollowup: -0.8, processControl: -0.1, maxTokensNotice: 0.05, finalizedFollowup: 0.1 }`. A "Turn took 4m 12s" control, a max-tokens warning or an interrupted-assistant marker can then sit *exactly* between two durable events while the durable log stays append-only. August's `turn_end`/compaction rows need the same treatment: today they are a separate persisted kind, and this is a way to keep them a *presentation* of the log.

- **One frame clock for the collapsing rows AND the scrollport** — `packages/client/ui-chat/src/client/chat/flow-motion.ts:170` (the batch) with `packages/client/ui-chat/src/client/chat/use-chat-viewport.ts:200` (the driver). The driver exposes `begin / prepare / frame / finish`, and the fold coordinator calls all four with the *same* eased progress, so the content's height change and the viewport's scroll change are literally the same animation. August's "the transcript collapses when a turn ends" behaviour would otherwise be two independent CSS transitions that visibly disagree. The transferable part is the **driver interface**, not the easing.

- **The fold lands at the tail only if this client sent the message or the reader was following; otherwise the reader's content stays still** — `packages/client/ui-chat/src/client/chat/use-chat-scroll.ts:67` (the `ownInput` computation) and `packages/client/ui-chat/src/client/chat/use-chat-viewport.ts:248` (`tail = this.tailRequested || (follow.active && !reader.pending())`). This is exactly the rule August's AGENTS.md states for the transcript, expressed as a mechanism: the fold *chooses* its landing from state (who sent it, is the reader following, is a reader sample pending), never from a model or a timer. Worth stealing verbatim for August's own fold/collapse path.

- **Semantic scroll anchors with a retained paging anchor, compensated inner-group-first** — `packages/client/ui-chat/src/client/chat/use-chat-viewport.ts:663` (`preserve()`) and `packages/client/ui-chat/src/client/chat/use-chat-viewport.ts:485` (`capturePosition()`). The reader's position is stored as a *semantic key + offset*, not a pixel offset, so it survives a history prepend, a remount and a re-grouping; the compensation gives the inner group's own scrollport the first correction and the outer transcript the remainder, inside each one's real range. The failure mode it names is worth copying: "If the available scroll range is insufficient, compensation stops at the actual limit without adding bottom space."

- **A pinned scroll or a sub-pixel floor arrival updates follow ownership immediately; anything else waits for a sample** — `packages/client/ui-chat/src/client/chat/use-chat-reading.ts:158`. The rule: "Other reader movement remains pending until the sampling interval or `scrollend`, even inside the follow threshold, so layout growth cannot erase small scroll gestures." August's chat has the same hazard (a content-growth pass can swallow a 3-pixel scroll); the fix is to treat *pinned* deliveries as immediate and everything else as pending.

- **All-or-nothing parsing of a durable structure: fall back to the whole thing rather than show a confident partial list** — `packages/client/ui-chat/src/client/chat/ContextBody.tsx:197` (`instructionChanges` returns `null` on *any* unreadable entry) and `packages/client/ui-chat/src/client/chat/ContextBody.tsx:284` (`catalogEntries`). "Silently dropping one unreadable entry would show a confident, incomplete file list for a log this version cannot fully read." August reads durable rows from its own database and from other tools' output; the same rule should govern every read of a structured artifact — either you can say the whole thing or you say nothing.

- **Redact a credential-shaped message at the projection boundary, keeping the raw value in the log** — `packages/client/ui-chat/src/client/conversation-nodes/event-projection.ts:149` (`displayFailure`): "Provider AUTH messages may echo a masked or partially preserved credential. Keep the raw diagnostic in the Session log, but never retain it in UI state." August has exactly this class of leak (a provider's auth error echoing part of a key into a transcript row); the fix is one function at the point where the durable value becomes UI state.

- **Cache-hit percentage that refuses to round a partial hit to 100%** — `packages/client/ui-chat/src/client/chat/token-format.ts:67` (`formatCacheHitPercent`). When the ordinary rounding would reach 100 but the hit is partial, it *adds decimal places* until the value is distinguishable and prints e.g. `99.95`. August displays cache-hit percentages too; a partial hit that reads as "100% cached" is a false claim about prompt reuse, and this is a cheap, exact fix.

- **A notice that outlives the panel that raised it, with per-holder release tokens** — `packages/client/ui-chat/src/client/apply.ts:90` (`const quotaNoticeHolds = new Set<symbol>()`) with the release contract at `packages/client/ui-chat/src/client/contract/slots.ts:106`. Each holder gets its own `Symbol`, so "a release drops only its own hold, so one that runs after a dismissal or a newer hold leaves that newer hold intact". August's quota/auth notices have the same lifetime problem (the chat panel closes, the notice should not), and the `Set<symbol>` identity trick is the whole solution.

- **A tool-call tree that refuses a cyclic or over-deep edge but still *consumes* the event** — `packages/client/ui-chat/src/client/model/tool-call-tree.ts:190` (`wouldCreateCycle`) and `packages/client/ui-chat/src/client/model/tool-call-tree.ts:15` (`MAX_TOOL_CALL_TREE_DEPTH = 256`). The reasoning is the transferable part: "a malformed wire/history edge is consumed without hiding the rest of the session" — the event is swallowed so the stream stays in sync, but the edge is not applied. August's tool-call rendering walks a tree built from model output; a cycle there is a stack overflow, and this is a cheap guard that fails *closed* without dropping data.

- **Retain streamed tool arguments in the tool node, not in the assistant block** — `packages/client/ui-chat/src/client/conversation-nodes/tool.ts:62` (`applyDelta`) and `packages/client/ui-chat/src/client/conversation-nodes/assistant.ts:128` ("Tool Nodes own streamed arguments; Assistant protocol blocks retain identity until full settlement"). The assistant keeps *identity and timing*; the tool node keeps the *fragments*. Root replacement happens at publication, "after all pending fragments can be observed together" (`packages/client/ui-chat/src/client/conversation-nodes/tool.ts:58-60`), so a reader can never observe a half-replaced argument. August's streaming tool arguments have exactly this hazard (a partial JSON string read mid-flight).

- **Truncate a streaming preview at a grapheme boundary when the surrogate pair is split across two deltas** — `packages/client/ui-chat/src/client/conversation-nodes/process-activity.ts:62` (`argumentTextDetail`). It re-reads with `limit + 1`, checks whether the next unit is a low surrogate, and either extends the prefix or drops the dangling high surrogate. It also doubles the read limit until the truncated result is stable, and bounds each pass at 161 clusters. August truncates streaming tool arguments and file previews for exactly the same reason, and the naive `slice(0, 160)` is the bug this prevents.

- **Count distinct calls by `callId`, and count a parent and a child separately when their ids differ** — `packages/client/ui-chat/src/client/conversation-nodes/process-activity.ts:141` (the `seen` set and the recursive `visit`). The rule ("Repeated `callId` | Count only the first occurrence, including when it appears both as a root and as a nested call") is what makes a summary honest when the same call is both dispatched and echoed. August's tool-count surfaces need the same dedupe rule or a retried call is counted twice.

- **Group identity survives a history prepend, but only while the complete old group remains between newly visible members** — `packages/client/ui-chat/src/client/conversation-nodes/process-groups.ts:173` (`extendedGroup`). A prepend that *splits* a group mints a new identity instead of reusing one for two groups. August's activity grouping has the same requirement (loading more history must not make an open group flicker), and this is the precise condition under which identity may be reused.

- **Regroup only the Turn that changed; refresh only the group whose content changed** — `packages/client/ui-chat/src/client/conversation-nodes/process-groups.ts:98` (`TurnGroups.refresh`) and `packages/client/ui-chat/src/client/conversation-nodes/process-groups.ts:230` (the regroup set). The consequence is that a streaming assistant frame touches exactly one group and notifies no historical Node or Group source. August's activity panel should be structured the same way, or every token will re-derive the whole session's grouping.

- **A reset *counter* (not a boolean) drives disclosure resets, so a mode change preserves open state** — `packages/client/ui-chat/src/client/chat/use-disclosure.ts:11` (`useDisclosure(version)`) with `packages/client/ui-chat/src/client/chat/use-disclosure.ts:28` (`bindDisclosure`). `expanded` is `expandedVersion === version`; the version only advances when an *enclosing Turn actually hides* the content. This is the mechanism behind "Display-mode changes preserve their open state" and it costs nothing to implement.

- **Policy as a pure table with a stable object identity** — `packages/client/ui-chat/src/client/presentation-policy.ts:23` (`POLICIES`) and `packages/client/ui-chat/src/client/presentation-policy.ts:74` (`presentationPolicyFor` returns the same object for the same pair). The mode-to-capability mapping is data, so a renderer asks for the capability it needs (`policy.settledReasoningPreview`) and a mode change re-renders only the components whose *selected* value changed. August's work-details settings would map one-to-one onto this.

- **The scope of a snapshot is a *stable key*, not an index** — `packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts:44` (`MutableChatSource`) and `packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts:107` (`MutableChatNodeStore`). Each node key owns an identity-stable observable; `publish()` notifies only the dirty keys, and `TurnKindNodes` materializes an ordered array only for the collections someone is actually observing (`packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts:72-105`). August's activity view subscribes to a whole session snapshot today; this is the shape that makes per-turn subscriptions possible.

- **A rail preview that is bounded per part, not per turn** — `packages/client/ui-chat/src/client/conversation-nodes/turn-navigation.ts:19` (`preview`). "this runs on every structural rail update, so one huge text block must not be concatenated (and regex-normalized) whole for a preview this short." The clip is applied to each part *before* joining, and the total is capped separately. August's session-list previews have the same hazard with a 200 KB tool output.

- **An unknown event still renders as a row** — `packages/client/ui-chat/src/client/conversation-nodes/fallback.ts:16`. Any append-surface event no Definition claims becomes a JSON row rather than vanishing. A silent drop is the worst possible failure for a transcript; this is the cheapest possible insurance.

- **A retry resets the accumulated output but keeps the request's first-token time** — `packages/client/ui-chat/src/client/conversation-nodes/assistant.ts:82` (`resetForRetry`). The TTFT is a fact about the *request*, not about one attempt; the accumulated blocks are a fact about the attempt. August's TTFT readout would otherwise be wrong on every retried turn.

- **A system prompt is a *card* whose anchor is the step's input, while an in-history update stays at its own position** — `packages/client/ui-chat/src/client/conversation-nodes/request-prompt.ts:24` (`requestPromptAnchor`) and `packages/client/ui-chat/src/client/conversation-nodes/request-prompt.ts:39` (`stableRequestPromptAnchor`). The card's anchor is pinned to the page-lifetime position so paging does not move it, while a *replacement* prompt advances the effective prompt without rewriting the historical card. August's prompt-inspection surface needs exactly this distinction between "the prompt in force" and "a prompt that was in force".

- **The bilingual doc pair is gated by per-heading hashes** — `packages/client/ui-chat/README.i18n.yaml:6` (and `packages/client/ui-chat/src/client/conversation-nodes/README.i18n.yaml:6`). Each heading section carries an `en` and a `zh` hash, regenerated by one script; the doc layer therefore has a static gate like the code layer. August's docs are extensive and bilingual-adjacent; this is a cheap way to keep them from silently diverging.

- **Pin the *design* rules as static CSS assertions, not only as rendered behaviour** — `packages/client/ui-chat/tests/chat-font-axis-styles.client.spec.ts:22` (12 cases that read the stylesheets as text and match regexes) and `packages/client/ui-chat/tests/sticky-header-styles.client.spec.ts:22` (4 more, including the specificity relation between two packages' sheets). A font-axis or z-index regression that only shows at one font size or under one stacking context is invisible to a unit test, so the rule is pinned by *reading the stylesheet*. August already does this once (`check:truncate` reads the source with the TypeScript compiler API); this is the same idea applied to design tokens and stacking relations, and it costs a few dozen lines of regex.

- **Pin a *negative* type contract with `@ts-expect-error`** — `packages/client/ui-chat/tests/views-type-chain.client.spec.tsx:14`. Six `@ts-expect-error` assertions pin exactly what must **not** leak into the shared, target-neutral base: the Chat-specific `openFile`, the flow's render authority, the node renderer's viewport access. The test body is a function that is never called; the assertion is the *compiler's* verdict, so the test fails at `tsc` time the moment one of those six becomes legal. August's host/browser split has exactly the same failure mode (a browser-only capability becoming reachable from a shared base), and this is the cheapest possible gate for it.

- **Make "one listener fires" a contract, not a hope** — `packages/client/ui-chat/tests/chat-node-source.client.spec.ts:67` mounts 4,000 keyed sources, mutates one node, and asserts that exactly one listener was called *and* that the changed key's source object kept its identity. `packages/client/ui-chat/tests/chat-node-bottom.client.spec.ts:31` does the same for the Turn-membership index. This is the test that keeps "the activity view subscribes to a whole session snapshot" from becoming the normal case: it turns the per-key subscription design into something a regression cannot silently undo.

- **Decide a cross-package stacking relation by specificity, never by load order** — `packages/client/ui-chat/src/client/chat/MessageItem.module.css:96-103`. The compaction toggle's band is pushed *below* the summary's code-block banner using `top: var(--dsh-compaction-header-height)` — the toggle's own measurement — and the comment explains why the rule wins: "This rule beats CodeBlock's `.bannerWrap { top: 0 }` by specificity (0,2,0) against (0,1,0), not by declaration order: the two sheets load in their own packages." August's frontend is multi-package in the same way, and the same rule (a shared measurement variable + a specificity choice + a written-down reason) is the transferable part.

- **Split the two runtimes with `files` on one side and `exclude` on the other** — `packages/client/ui-chat/tsconfig.host.json:8` (a `files` whitelist of two entries) and `packages/client/ui-chat/tsconfig.client.json:121-123` (an `exclude` of the Host entry). The split is expressed from *both* directions, so neither half can leak into the other, and the browser project never type-checks the Host entry against the browser base config. August's desktop app bundles a backend alongside the UI; this is the TypeScript-level way to keep the two builds honest.

- **Count a cache *write* against the cache-hit denominator** — `packages/client/ui-chat/tests/chat-stats.client.spec.tsx:478`. The hit rate is computed against everything that was billed on the prompt side, not only against what was reused, so a turn that wrote a lot of cache reads as a low hit rate rather than as a flattering one. August's cache-readout has the same decision to make and the same temptation to make it the flattering one.

- **Pin the stale-settle race in *both* directions** — `packages/client/ui-chat/tests/chat-view.client.spec.tsx:3690` (a Host refusal that settles after the dialog was dismissed must be ignored) and `packages/client/ui-chat/tests/chat-view.client.spec.tsx:3711` (a Host open that *succeeds* after the dialog was dismissed must also be ignored). Asserting only the failure direction would leave the success path open, and the success path is the one that opens a file the user no longer asked for.

---

## Files skipped (with reasons)

- `packages/client/ui-chat/src/client/chat/running-whale@2x.png` — a **binary** 21,631-byte PNG. I opened it and parsed its chunk table: PNG signature `89 50 4E 47 0D 0A 1A 0A`, `IHDR` 28×28, `pHYs`, an `acTL` animation-control chunk and **43 `fcTL`/`fdAT` frame pairs** before `IEND` — i.e. an animated PNG (APNG) used as the CSS mask for the running whale, inlined into the CSS bundle as a base64 data URL by `packages/client/ui-chat/tsdown.config.ts:9-19`. It was not read line by line because it is a binary image with no line structure; the CSS rule that consumes it is in `ChatView.module.css` and the static SVG fallback is in `RunningWhaleTail.tsx`. A test (`tests/running-whale-tail.client.spec.tsx`) asserts the asset's frame count and 50 ms frame delay.

No other file was skipped. All 186 remaining files in the shard were opened and read, and every one of them has its own `### <path>` section above.

**Citation convention.** Two forms are used, and both were machine-checked against the clone before this report was written (75 absolute references and 833 per-section relative references, all in range):
- A bare `:NN` or `:NN-MM` inside a per-file section means **line NN of the file named in that section's heading**.
- Anything with a path in it (`packages/client/ui-chat/...:NN`) is repo-relative and resolves from the repository root.

**How the 57 test files were read.** Every test file was opened and its complete `describe`/`it` structure extracted (all titles, in order). The 40 files at or under 162 lines were read in full. The 17 larger files were read at the head (imports, fixtures and the harness) plus the assertion bodies of the mechanism-bearing cases. The four largest were read at the head and by title only: `chat-view.client.spec.tsx` (4142 lines), `conversation-node-definitions.client.spec.ts` (2692), `chat-branch-tails.client.spec.tsx` (1072) and `chat-snapshot-fixture.client.ts` (539).

---

## Uncertainties

- **How much of the two largest test files I read line-by-line.** `packages/client/ui-chat/tests/chat-view.client.spec.tsx` (4142 lines) and `packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts` (2692 lines) were read for their first ~90 lines and their complete `describe`/`it` titles; the remainder was characterised by title rather than by reading every assertion. My per-file notes for those two are therefore reliable about *what is covered* and less reliable about *how* each assertion is constructed. The line counts in the previous pass's text (4407, 2882, 1136, 585, 591, 574) were its own counts and did not match the clone; the numbers above are what `Get-Content` returns on the clone as read.
- **The behaviour of the `ui-conversation`, `ui-slots`, `dsh-session` and `dsh-token-meter` packages** is outside this shard. Several mechanisms here depend on contracts I could only see through their call sites (e.g. `ConversationNodeAssembler`, `ConversationGroupStore`, `PartialArguments`, `deriveTurnTokenUsage`, `useAnchoredPosition`). I have described what this shard *passes* to them, not their internals.
- **`ChatStore` / `defineStore` semantics** — `packages/client/ui-chat/src/client/stores.ts` uses `defineStore` from `@deepseek-ai/dsh-client-store`, whose draft-mutation and subscription model I inferred from the `setTurnProcessOpen(draft, …)` signature rather than from its implementation.
- **The "no pending placeholders" claim** in `packages/client/ui-chat/src/client/chat/ChatView.tsx:232-234` asserts that `ui-user-questions` and `ApprovalPanel` both take over the composer. Those components live in other packages; I verified the comment, not the behaviour.
- **The i18n hash format** — `packages/client/ui-chat/README.i18n.yaml` records 16-hex-digit values per heading section; I did not run `verify-translation-pairing` (the clone is read-only and running repo scripts is forbidden), so I could not confirm the hashes are currently in sync. I verified parity *structurally* by reading the Chinese documents' headings.
- **The `turnOutline` projection** is a host-side value whose preview budget the client mirrors (`packages/client/ui-chat/src/client/conversation-nodes/turn-navigation.ts:12-13`). I confirmed the mirroring comment and the constants; I could not confirm that the host's implementation has not drifted.
- **`running-whale@2x.png` frame timing** — the test at `packages/client/ui-chat/tests/running-whale-tail.client.spec.tsx:30` asserts "sixty 50ms frames" but my chunk scan counted 43 `fcTL`/`fdAT` pairs; the discrepancy is likely the test counting frames differently (or the APNG's `num_frames` in `acTL` being larger than the pairs I counted), and I did not decode the `acTL` payload to settle it.
- **Two claims in the previous pass were not reproducible and have been rewritten.** (1) The phrase "because which step answers changes as later steps arrive" does not occur anywhere in the package; the *mechanism* it described is real — `packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts:117-122` re-reads the Turn's last step on every evaluation — but the quote was a paraphrase, and the note now cites the rule text instead. (2) `packages/client/ui-chat/src/client/conversation-nodes/tool.ts:128` does not contain the "Tool Nodes own streamed arguments" sentence; that sentence is at `packages/client/ui-chat/src/client/conversation-nodes/assistant.ts:128`, and the citation has been moved.
- **The manifest was not modified.** `C:/Dev/august-harness/docs/research/deepseek-harness/manifest.tsv` was read only. The shard list was taken from its 4th column (`owner-shard`) exactly as written; the 187 rows it assigns to `dsh-client-chat#1` all live under `packages/client/ui-chat/`, and the other two `dsh-client-chat#N` shards cover the sibling `packages/client/ui-conversation/` and `packages/client/ui-slots/` trees. I did not check the manifest's `status` or `note` columns for correctness and made no attempt to reconcile them.

