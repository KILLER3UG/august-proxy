# deepseek-harness / dsh-docs-subsystems

## Shard shape

This shard is the **entire `docs/subsystems/` folder** of the deepseek-harness clone: 201 files = 67 subsystem reference pages × 3 files each (an English `.md`, a Chinese `.zh.md` translation, and a `.i18n.yaml` bilingual-pairing hash record). The 67 pages are the vocabulary reference for the harness's Cordis service graph, and they split cleanly into three tiers. **(a) The spine** — `core.md` (agent handle, loop wiring, the `…Map → derived-union` type pattern, branded ids), `session.md` (the append-only `SessionEvent` log and the surface fold that derives model history from it), `llm-streaming.md` (the `StreamChunk` wire protocol, the adapter contract, retry policy, token accounting), `tools.md` (the tool registry and its guarded execution pipeline), `system-prompt.md` (prompt-section assembly), `scope.md` (the scoped-registration primitive everything else builds on). **(b) Optional capability seams** — compaction, subagent, workflow, skills, filesystem, shell, sandbox, subprocess, ssh, terminal, mcp, lsp, web, storage, workspaces, jobs, schedule, goal, todo, plan, permission-presets, approval, user-questions, attachment, credentials, spill, agent-team, session-title, session-telemetry, session-query, session-projection, session-reference, feedback, client-*, web-client, web-server, typert, claude-code-mods, browser-use, computer-use, voice-input, translation, office-to-pdf, ptc-runtime, otel, product-telemetry, boot, commands, deliverables, working-directory, worktrees, token-meter. **(c) Client/UI** — `conversation.md`, `slots.md`, `sidebar-right.md`, `web-client.md`, `client-modules.md`, `client-resources.md`. The seams are drawn with a strict three-part vocabulary (Service Definition / Service Provider / Consumer), each page declaring its own types in `ts type-equiv` blocks that are drift-checked against source by `pnpm run verify-type-equiv`, plus an auto-generated `cordis-surface` section (`scripts/gen-cordis-catalog.ts`) listing every `ctx.*` service and event with the original JSDoc. The two orthogonally-duplicated artifacts (the `.zh.md` translations and the `.i18n.yaml` hash records) exist to keep the Chinese locale byte-parallel to the English one, section by section.

---

## Per-file notes

### docs/subsystems/agent-team.i18n.yaml
One-line boilerplate: bilingual-pair consistency record for `agent-team.md` — 6 per-heading `en:`/`zh:` hash pairs under the `/agent-teams` key, plus the regenerate command `pnpm run verify-translation-pairing --write docs/subsystems/agent-team.md`.

### docs/subsystems/agent-team.md
- **Purpose:** the experimental implicit-root Team domain — a Lead session with named continuable teammates, a shared task DAG and a peer mailbox.
- **Key abstractions:** `TeamMemberSnapshot` (whole durable roster row), `TeamTaskSnapshot` (whole durable task row with a `revision` compare-and-set counter, `blockedBy` edges and advisory `writeScopes`), `TeamMessageSnapshot`/`TeamMessageSource` (historical mailbox records), `TeamProjection` (the client-visible view published on the Lead's `SessionProjectionMap.agentTeam`).
- **Data flow:** every teammate lifecycle change writes a complete snapshot; the Lead session publishes `SessionProjectionMap.agentTeam` with roster rows and non-deleted task views; a `failure` field reports the first rejected persisted record beside the last valid state.
- **Non-obvious design decisions:** members start in `provisioning` and reach exactly one terminal roster phase (`active`/`failed`); roster `running`/`inactive` status is derived separately and *never* rewrites the durable record (`agent-team.md:24`). `writeScopes` are "normalized advisory path prefixes rather than locks" (`agent-team.md:58`).
- **Edge cases:** replay selects records by `TeamId`, so events inherited by an ordinary fork retain the ancestor id and never enter the new root's state (`agent-team.md:125`).
- **Surprising:** `blockedBy` edges must name non-deleted tasks and keep the graph acyclic, enforced at write time even though the DAG is model-authored.

### docs/subsystems/agent-team.zh.md
Chinese translation of `agent-team.md`; heading-for-heading parity with the English original confirmed against `agent-team.i18n.yaml` and the English page, with `type-equiv` code blocks deliberately left in English so the drift checker still matches them.

### docs/subsystems/approval.i18n.yaml
Bilingual-pair hash record for `approval.md`: 5 per-heading `en:`/`zh:` pairs under `/user-approval`.

### docs/subsystems/approval.md
- **Purpose:** the one-shot user-approval seam — "may this specific action proceed?"
- **Key abstractions:** `ApprovalOutcome` (closed, fail-closed: `allowed-once | rejected | cancelled | unavailable`), `ApprovalPolicy` (`ask`|`never`), `ApprovalRequest`, `ApprovalRequestId` (branded, pairs the audit pair).
- **Data flow:** `ctx.approval.request(req)` requires an open turn → appends `approval/asked` → obtains one outcome → appends the matching `approval/decided` → resolves. The audit events are log-only and never enter the model transcript (`approval.md:88`).
- **Non-obvious design decisions:** `ApprovalRequest` deliberately omits tool arguments — the answerer attaches the prompt to the already-streamed tool call through `callId` instead of rendering a second copy that could drift (`approval.md:53`). The `never` policy is enforced *inside the service before waterfall dispatch*, so an answerer registered later with `prepend` cannot bypass it (`approval.md:86`).
- **Edge cases:** a missing, non-owning, throwing or non-conforming answerer becomes `unavailable` rather than opening the gate (`approval.md:21`); aborting withdraws the question and a late answer is discarded.
- **Surprising:** the effective policy is the last `approval/policy` event in the session log, so the override replays.

### docs/subsystems/approval.zh.md
Chinese translation of `approval.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/attachment.i18n.yaml
Bilingual-pair hash record for `attachment.md`: 3 per-heading pairs under `/durable-attachments`.

### docs/subsystems/attachment.md
- **Purpose:** separate binary image/file ownership from the session log — a producer hands bytes to `ctx.attachments` and gets back an immutable content-addressed reference.
- **Key abstractions:** `ImageAttachmentRef` (opaque `attachmentId`, verified media type, byte length, intrinsic dimensions, EXIF-corrected `originalDimensions`), `ImageAttachmentLimits`, `PromptContentPart` → `AttachmentAdmissionPart` → `AdmittedPromptContentPart`, `ImageRequestTarget`, `RequestImageAttachment`.
- **Data flow:** `saveImage()` prepares and atomically commits a normalized attachment *before* returning the ref; `admitPromptContent()` replaces base64 uploads with durable refs and passes durable file refs through unchanged; `readImageRequest()` derives and caches one deterministic request version at a route-chosen target size.
- **Non-obvious design decisions:** "the accepting Host promotes image parts to durable references through `ctx.attachments.admitPromptContent()` before any message is created, so a wire caller can never cite an attachment it did not upload" (`attachment.md:66-71`). Images move below `<DSH_HOME>/attachments/v1` *before* the user event is appended (`attachment.md:7`).
- **Edge cases:** the local backend lazily encodes preferred candidates, singleflights equal request identities, lets each waiter cancel independently, and bounds all transforms with an instance-level limiter defaulting to two simultaneous transformations (`attachment.md:170`).
- **Surprising:** the seam is retention-neutral — resumed and forked sessions may share objects, so reference-aware GC is deliberately deferred (`attachment.md:170`).

### docs/subsystems/attachment.zh.md
Chinese translation of `attachment.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/boot.i18n.yaml
Bilingual-pair hash record for `boot.md`: 4 per-heading pairs under `/profile-management`.

### docs/subsystems/boot.md
- **Purpose:** launcher profile access and the plugin manager — enablement, install/removal, plugin market, and hot-reload reconciliation.
- **Key abstractions:** `PluginInfo`, `BundleInfo`, `ChangeResult` (`applied | restart-required | overridden | failed`), `MarketIndexSummary`/`MarketQuery`/`MarketSearchResult`, `ProfileReconciliation`, `PendingModule`.
- **Data flow:** `Hmr.reconcileProfile()` compares loaded modules against disk and returns `warnings` + `pending` modules + an optional `restartReason`; a changed module keeps its previous code running until a restart.
- **Non-obvious design decisions:** `ChangeResult.changed` reports the disk edit *independently* of `application`, and a run terminated by the manager is classified `timeout` "whatever exit status the signal left behind, so installation and removal report failure instead of success and no further registry is asked" (`boot.md:19`).
- **Edge cases:** `pendingBuilds` lists undecided packages across the profile; `failedAt` distinguishes "could not reach the registry it asked" from "could not reach the host a git or tarball spec is fetched from".
- **Surprising:** `BundleInfo.source` reports a *dependency's* spec when the profile depends on a bundle the installation does not — a `pnpm add`-acceptable string.

### docs/subsystems/boot.zh.md
Chinese translation of `boot.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/browser-use.i18n.yaml
Bilingual-pair hash record for `browser-use.md`: 5 per-heading pairs under `/browser-use`.

### docs/subsystems/browser-use.md
- **Purpose:** let a model inspect and operate web pages through a configured backend while DSH keeps the task loop.
- **Key abstractions:** exclusive named provider registration; no common browser-operation methods, browser resources or model-controlled selector.
- **Data flow:** provider tools use the ordinary execution pipeline and Session log; an MCP provider initialises one client per live Agent created *after* the provider loads, awaited on the serial `agent/created` event before creation/resume completes (`browser-use.md:29`).
- **Non-obvious design decisions:** "DSH owns the task loop; the provider supplies browser operations and keeps browser state across turns of one live Session" (`browser-use.md:5`). Stagehand's AI-assisted operations use *its own* configured native model while DSH retains the loop; DSH model routing and usage accounting are explicitly deferred (`browser-use.md:35`).
- **Edge cases:** a busy attachment means that activation continues *without* the browser and does not retry on later turns; loading or reloading the provider does not adopt already-active sessions.
- **Surprising:** "Cancellation cannot undo a browser action already delivered" (`browser-use.md:25`).

### docs/subsystems/browser-use.zh.md
Chinese translation of `browser-use.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/claude-code-mods.i18n.yaml
Bilingual-pair hash record for `claude-code-mods.md`: 8 per-heading pairs under `/claude-code-mods-compatibility`.

### docs/subsystems/claude-code-mods.md
- **Purpose:** an exhaustive compatibility matrix against Claude Code 2.1.287 — every way a mod behaves differently through this bridge.
- **Key abstractions:** `defineMod({ name, version, root, userConfig, register })`; the `$` namespace table; the event table; the `next`-chain rules.
- **Data flow:** a mod is a plugin — its hooks module is mounted through `cordis.yml` after the bridge; `tool.call` arrives as the `tools/execute` waterfall around the harness pipeline, *after* the harness permission decision.
- **Non-obvious design decisions:** "`next` runs once: a second call returns the first run's result" — one tool execution per logged call (`claude-code-mods.md:41`). A hook that rewrites arguments or names another tool is **skipped with a report**, because "the logged call runs as logged" (`claude-code-mods.md:28`). Mods run with "the process's full authority" — no sandbox is applied (`claude-code-mods.md:16`).
- **Edge cases:** a hook on an event the host never raises is named in a warning at load; a `$` call outside the served table rejects with `no implementation for <namespace>.<method>`.
- **Surprising:** the table names four upstream example mods that are *not runnable* and says why — the repository's terms do not allow a fixture copy.

### docs/subsystems/claude-code-mods.zh.md
Chinese translation of `claude-code-mods.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/client-modules.i18n.yaml
Bilingual-pair hash record for `client-modules.md`: 5 per-heading pairs under `/client-modules`.

### docs/subsystems/client-modules.md
- **Purpose:** the web plugin table — the Node half of the browser module system.
- **Key abstractions:** `WebBootGraph`, `WebBootEntry`, `WebBootBatch`, `WebBootRelease`, `ClientArtifactBaseline`.
- **Data flow:** the host composes the graph from scanned packages, contributes it to the structured index-injection table, and serves combo scripts under `/plugins/??<pkg-a>/client.js,<pkg-b>/client.js&rev=<rev>`.
- **Non-obvious design decisions:** revisions come from `mtime`/`ctime`/`size`, "without hashing executable bytes", so the same artifacts keep their revisions across Host restarts (`client-modules.md:88`). Scanning is incremental per package; at activation a broken package aggregate-fails the whole fiber, in steady state it only warns (`client-modules.md:96`).
- **Edge cases:** "Unknown or altered resource lists, missing revisions, and stale revisions answer 404 rather than serving different bytes or letting the SPA fallback return HTML as JavaScript" (`client-modules.md:102`).
- **Surprising:** every startup request URL is at most 3 KiB measured as UTF-8 bytes; partitioning splits before the map-form URL exceeds it "without concatenating scripts or reading maps".

### docs/subsystems/client-modules.zh.md
Chinese translation of `client-modules.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/client-resources.i18n.yaml
Bilingual-pair hash record for `client-resources.md`: 6 per-heading pairs under `/client-resources`.

### docs/subsystems/client-resources.md
- **Purpose:** turn an address into live data for any Web Client component without importing the owner's runtime.
- **Key abstractions:** `dsh-resource://<type>/…` addresses, `ResourceProtocolMap`, one provider per protocol, `useResource<P>(address)`.
- **Data flow:** `open(address, {signal})` yields `RemoteResult` frames — current state first, then one frame per change; a failure is an `ok:false` frame, never a throw (`client-resources.md:24`).
- **Non-obvious design decisions:** one scheme serves every protocol, so adding a protocol adds a *host*, never a scheme (`client-resources.md:11`). A resource is alive while it has a holder; the first holder opens the stream, the last release aborts it and discards the value (`client-resources.md:86`).
- **Edge cases:** `status` is `none | loading | live | failed`; on `failed` the model keeps the last value *beside* the failure so a body can show stale content with a notice rather than a blank (`client-resources.md:82`).
- **Surprising:** records live for the page lifetime — memory grows with the number of distinct addresses ever read, and a provider that ignores `signal` keeps running until its next frame (`client-resources.md:92`).

### docs/subsystems/client-resources.zh.md
Chinese translation of `client-resources.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/commands.i18n.yaml
Bilingual-pair hash record for `commands.md`: 5 per-heading pairs under `/human-commands`.

### docs/subsystems/commands.md
- **Purpose:** the human-command registry — interactive adapters discover and directly execute plugin-owned commands for an exact agent without creating a model message.
- **Key abstractions:** `CommandDefinition`, `CommandInvocation`, `CommandResult` (`success`/`error`), `CommandDescriptor`, `ParsedCommand`.
- **Data flow:** the adapter owns cancellation and passes the exact target agent; `rawInput` begins immediately after the parsed name and retains the adapter-delivered separator.
- **Non-obvious design decisions:** `recordInput` defaults to true so a command whose domain event already owns the payload can set it false and avoid duplicating that payload in the session log (`commands.md:44-49`). `sourceEventSeq` names an earlier non-command event so a client can combine the command lifecycle with that domain projection "without parsing `text` or relying on adjacent rows" (`commands.md:93`).
- **Edge cases:** syntax-valid input can still name an unavailable command (`parseCommand()` runs before registry resolution).
- **Surprising:** results are "direct UI outcomes, not tool results or session events".

### docs/subsystems/commands.zh.md
Chinese translation of `commands.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/compaction.i18n.yaml
Bilingual-pair hash record for `compaction.md`: 6 per-heading pairs under `/compaction`.

### docs/subsystems/compaction.md
- **Purpose:** the compaction seam — replace a span of the session surface with one summary node.
- **Key abstractions:** three log-only events (`compaction/start`, `compaction/summary`, `compaction/end`), `CompactionResult`, `CompactionTrigger` (`pressure`|`context-overflow`), `ManualCompactionErrorCode`, `PrunedEntry`/`PruneResult`, `ImageOffloadTarget`.
- **Data flow:** `compaction/start` → summarization → `compaction/summary` → a `user/message` carrying `surfaceOp: {op:'replace', startSeq, endSeq}` → `compaction/end`. The summary rides on a `user/message` because `SurfaceEventType` is deliberately not extended (`compaction.md:11`).
- **Non-obvious design decisions:** "Releasing the lock last turns a crash mid-operation into a detectable orphaned lock (a `compaction/start` with no matching `compaction/end`) rather than a `compaction/end` that falsely claims compaction finished" (`compaction.md:19`). `shadowedRange` is a surface **position** span, not a numeric seq interval — after a prior replace lands a fresh high-seq summary node at an older range's position, `start` can be *greater* than `end` (`compaction.md:60-66`).
- **Edge cases:** an unmatched start before a newer `session/end-seed` is stale evidence from a prior lifecycle and is ignored; unrelated idle injection may appear between a manual start and end and survives the replacement.
- **Surprising:** `toolPairingBalancedBefore/After` validate that assistant tool calls stay paired with their results across a compaction boundary — an unpaired call 400s every provider.

### docs/subsystems/compaction.zh.md
Chinese translation of `compaction.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/computer-use.i18n.yaml
Bilingual-pair hash record for `computer-use.md`: 4 per-heading pairs under `/computer-use`.

### docs/subsystems/computer-use.md
- **Purpose:** let a model observe and operate the local desktop through a configured provider.
- **Key abstractions:** exclusive named provider registration; upstream tool catalogs; shared CUA objects/executor enforcing consent through User Questions.
- **Data flow:** tools use the normal execution pipeline and Session log; image-capable routes with an attachment store receive durable screenshots, unsupported image routes get the existing MCP image diagnostic.
- **Non-obvious design decisions:** one registered provider does *not* reserve a desktop for a Session — "Callers coordinate complete observe, act, and verify workflows across Sessions and separate DSH processes" (`computer-use.md:25`).
- **Edge cases:** a cancelled call cannot undo input the desktop already received; startup failure releases the attempted registration.
- **Surprising:** the shared service deliberately has no common desktop-operation method or model-controlled selector.

### docs/subsystems/computer-use.zh.md
Chinese translation of `computer-use.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/conversation.i18n.yaml
Bilingual-pair hash record for `conversation.md`: 9 per-heading pairs under `/conversation-assembly`.

### docs/subsystems/conversation.md
- **Purpose:** the target-neutral assembly layer between a Client event window and browser views (Chat, Trajectory, …).
- **Key abstractions:** Event Definition, Context, Location, View Definition, Group Definition, View; `ConversationNodeDefinition` with `match`/`start`/`update`/`publication`/`buildLocationData`/`buildViewNode`; `NodeReference`/`GroupReference`, `GroupSnapshot`/`GroupUpdate`.
- **Data flow:** the Session Controller owns the contiguous loaded window; one `ConversationNodeAssembler` per Session applies every registered Definition and publishes one source per registered view target. A first activation calls `replace()` once; later flushes call `apply()`.
- **Non-obvious design decisions:** "Choose one stable business id before writing the Definition. Every event that contributes to the same Node must carry that id … the client must never assign an update to 'the latest unfinished' Context" (`conversation.md:58`). A `match` with `exclusive:true` claims the event, and "the assembler evaluates every match of the event before accepting any, so the outcome is independent of registration order" (`conversation.md:250`).
- **Edge cases:** an update-only tail stays *pending* until an older page supplies its start; if the product must render first, a terminal or checkpoint event must carry whole fallback state — "do not recover it by scanning unrelated events" (`conversation.md:70`).
- **Surprising:** a hard performance rule — with `D` registered Definitions one event performs `D` matches and a constant-time Context-key lookup; "Definition code must preserve that property: do not traverse the complete event window, every Context, `context.matches`, or the rendered Node collection on the normal append path" (`conversation.md:284`).

### docs/subsystems/conversation.zh.md
Chinese translation of `conversation.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/core.i18n.yaml
Bilingual-pair hash record for `core.md`: 11 per-heading pairs under `/core`, including the nested `repo-wide-type-patterns` subtree.

### docs/subsystems/core.md
- **Purpose:** the spine — how `packages/core` drives the agent loop and what an Agent *is*.
- **Key abstractions:** `AgentHandle` (an owned agent plus its disposer, "The disposer is a CAPABILITY"), `Agent` (`send`/`followup`/`steer`/`inject`, `cancel`, `whenIdle`, `runMaintenance`, `inbox`), `Inbox`/`InboxTarget`, `AgentCancelCause`, `AgentStatus`, `AssistantStreamFrame`, `AgentOptions`, `PreStepDecision`, `RequestErrorAction`, `SessionStartSource`; the `…Map → derived-union` pattern and `Branded<B>` ids.
- **Data flow:** a turn flows through six packages in one loop — `agent-loop` claims a queued prompt → opens a turn on the session log → assembles the request prefix through `system-prompt` → streams through the LLM seam → dispatches tool calls through the tool registry → appends every model-visible fact back onto the log before the next step derives from it (`core.md:9`).
- **Non-obvious design decisions:** `scope/` is a dependency-free library that "sits below `session/` and `system-prompt/` in the module graph precisely so they can consume it without a cycle" (`core.md:20`). `agent/pre-step` is the *only* waterfall listener chain before request derivation (`core.md:337`). `agent/turn-stopping` is designed so "Data decides, so listener order cannot change the outcome" (`core.md:1046`).
- **Edge cases:** `running` describes the driver-wide drain interval and may span consecutive queued turns — "it does not prove a turn is still open" (`core.md:193`). `followup()` returns no handle: its `MessageId` identifies durable inbox insertion/claim/discard facts, not a later assistant output (`core.md:193`). `agent/created` is *serial* — a throw fails creation and skips later listeners (`core.md:793`).
- **Surprising:** the `…Map → derived-union` pattern means a plugin adds a `ContentBlock`/event/finish-reason variant by declaration merging with **no edit to the owning package** (`core.md:366-395`).

### docs/subsystems/core.zh.md
Chinese translation of `core.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/credentials.i18n.yaml
Bilingual-pair hash record for `credentials.md`: 7 per-heading pairs under `/user-credentials`.

### docs/subsystems/credentials.md
- **Purpose:** keep secrets out of configuration — settings carry *references*, providers own values.
- **Key abstractions:** `CredentialRef` (a POSIX-style env-var name), `ResolvedCredential` (`value` + `source` layer), `CredentialInfo` (configured/source/writable — never the value).
- **Data flow:** consumers resolve a reference once *per operation*; "that per-operation read is the hot-update mechanism" so a rotated credential reaches the very next request with no restart (`credentials.md:21`).
- **Non-obvious design decisions:** `CredentialInfo` "has no slot a value could ride in, which is what lets the whole read half cross the Remote wire" (`credentials.md:39`). One seam-wide rule: an empty stored value is absent everywhere.
- **Edge cases:** ambient process-environment changes are not observable and never emit `credentials/reference-updated`.
- **Surprising:** the local provider ranks its managed file *above* the launch environment, so saving a value always creates the effective writable layer and removing it reveals the launch environment again.

### docs/subsystems/credentials.zh.md
Chinese translation of `credentials.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/deliverables.i18n.yaml
Bilingual-pair hash record for `deliverables.md`: 8 per-heading pairs under `/deliverables`.

### docs/subsystems/deliverables.md
- **Purpose:** what a turn hands to the user — files the model declared via `present`, plus files the turn changed.
- **Key abstractions:** `PresentedFile`, `WorkspaceChangedFile`, `WorkspaceChangesSummary`, `WorkspaceDiffHunk`, `WorkspaceFileDiff` (text/binary/oversized), `WorkspaceChanges` (the Host service).
- **Data flow:** git working-tree snapshots at turn start/end plus whole-file captures around each file-tool edit for paths git does not cover; `workspace/changes` is appended when a top-level turn stops; the summary itself is **not** in the log but is served by `workspaceChanges.summary(sessionId, seq)` until the Session is disposed.
- **Non-obvious design decisions:** the summary deliberately does not enter the log — "a conversation reopened after a Host restart has no changed-files card for its earlier turns" (`deliverables.md:138`).
- **Edge cases:** a diff that exceeds `diffTimeoutMs` is served `coarse: true` with every line shown as replaced; binary and oversized files are listed without counts.
- **Surprising:** a later event for the same turn replaces the earlier one, so a client keeps only the latest.

### docs/subsystems/deliverables.zh.md
Chinese translation of `deliverables.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/extensions.i18n.yaml
Bilingual-pair hash record for `extensions.md`: 1 per-heading pair under `/extensions` — the whole page is one section.

### docs/subsystems/extensions.md
- **Purpose:** the extensions subsystem — versioned dynamic Cordis plugins and packages, host/browser activation, approval, runtime inspection and lifecycle teardown.
- **Key abstractions:** the page body is six lines; the substance is the generated Cordis API block, which declares `ctx.cordisInspect` (`CordisInspectRegistryService`), `ctx.dynamicCordisRunner` (`DynamicCordisRunnerService`) and `ctx.inspector` (`InspectorService`), plus the `cordis/*` events.
- **Data flow:** not described in the narrative; the package group README owns the lifecycle.
- **Non-obvious design decisions:** the doc deliberately carries no hand-written mechanism — "Package lifecycle and sandbox behavior belong to the `packages/extensions` package group" (`extensions.md:5`).
- **Edge cases / failure handling:** not established from this page; the generated API block is the only source here.
- **Surprising:** this is the only page in the shard whose narrative is a pointer, and its `.i18n.yaml` records a single heading pair accordingly.

### docs/subsystems/extensions.zh.md
Chinese translation of `extensions.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/feedback.i18n.yaml
Bilingual-pair hash record for `feedback.md`: 8 per-heading pairs under `/message-feedback`.

### docs/subsystems/feedback.md
- **Purpose:** editable human feedback on individual assistant messages, plus an immutable Session-level remark.
- **Key abstractions:** `MessageFeedbackItem` (rating/note/category + an opaque compare-and-set `version`), `MessageFeedbackPut`/`MessageFeedbackDelete`, the closed `MessageFeedbackFailure` union (`session-not-found`, `target-not-found`, `version-conflict`, `note-blank`, `note-too-large`), `MessageFeedbackSuccess`/`MessageFeedbackRejected`.
- **Data flow:** the canonical Session log stores `feedback/message-put` and `feedback/message-delete`; all three feedback event kinds are log-only and never enter model context (`feedback.md:5`).
- **Non-obvious design decisions:** `version` is an "Equality-only token replaced by every material create or update" (`feedback.md:32-33`) — the CAS is on identity of state, not a timestamp. A put carries the item's complete current value including its original creation time.
- **Edge cases:** `ifVersion: null` requires that no item exists; deleting an absent item is idempotent.
- **Surprising:** the target must be "a derived, append-origin assistant message" — a compaction-shadowed message is not addressable.

### docs/subsystems/feedback.zh.md
Chinese translation of `feedback.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/filesystem.i18n.yaml
Bilingual-pair hash record for `filesystem.md`: 10 per-heading pairs under `/filesystem`.

### docs/subsystems/filesystem.md
- **Purpose:** the filesystem capability — `ctx.fs` primitives, the local backend, the observation-policy plugin and the model-facing read/write/edit tool.
- **Key abstractions:** `FsTarget`/`FsTargetKey`/`FsVersion` (opaque), `FsInfo`/`FsPathInfo`/`FsDirEntry`, `FsWriteIntent` (`createIfAbsent`|`replaceIfVersion`), `FsWriteOutcome`/`FsEditOutcome`, `FsObservation`, `FileReadOutcome`, the closed `FsErrorCode` union.
- **Data flow:** the tool resolves a path to a target, dispatches the `fs/write-intent`/`fs/edit-intent` decision waterfalls, calls `ctx.fs`, then emits the fire-and-forget `fs/observed` recording event.
- **Non-obvious design decisions:** the provider contract takes the version guard *optionally* — "Omitting the intent from `writeText` means unconditional create-or-overwrite, not a third union arm" (`filesystem.md:121`). The `fs/observed` listener "MUST be synchronous and side-effect-only, because the tool does NOT guard the emit" (`filesystem.md:185`).
- **Edge cases:** `read`/`write`/`edit` take **no** `timeoutMs` and arm no deadline, because "a timeout could not force an in-progress `fsync`/`rename` to stop, so a `timeoutMs` here would be a deadline the seam cannot enforce" (`filesystem.md:274`). `editText` is a provider-level mutation, not a read plus a write composed elsewhere, so the stale check happens *before* literal matching (`filesystem.md:151`).
- **Surprising:** read authorization is freshness-based, not full/partial — there is deliberately no `FS_PARTIAL_OBSERVATION` code (`filesystem.md:270`).

### docs/subsystems/filesystem.zh.md
Chinese translation of `filesystem.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/goal.i18n.yaml
Bilingual-pair hash record for `goal.md`: 5 per-heading pairs under `/same-session-goals`.

### docs/subsystems/goal.md
- **Purpose:** persisted same-session goals — an objective with a bounded number of continuation rounds.
- **Key abstractions:** `GoalRef` (id + revision, a compare-and-set identity), `GoalPhase` (`active|paused|blocked|complete`), `GoalBlockReason` (stable kebab code + free-form message), `GoalSnapshot`, `GoalView` (adds `roundsStarted` + a process-local `activation`), `GoalMessageSource`.
- **Data flow:** every mutation is a durable `goal/change` event whose payload is either a complete post-mutation snapshot or a clear tombstone; a continuation consumer attributes each admitted `user/message` turn with a positive sequential round number and the current revision.
- **Non-obvious design decisions:** "The durable phase answers what happened to the objective. Process-local activation separately answers whether a continuation consumer may start another round." (`goal.md:21`) — two different questions, two different lifetimes.
- **Edge cases:** replay rejects non-positive rounds, gaps, stale revisions, stopped phases and cap overflow (`goal.md:119`).
- **Surprising:** `blocked` is the *single* durable stopped-by-a-problem state; its reason carries both a routable code and human prose.

### docs/subsystems/goal.zh.md
Chinese translation of `goal.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/jobs.i18n.yaml
Bilingual-pair hash record for `jobs.md`: 8 per-heading pairs under `/background-job-runtime`.

### docs/subsystems/jobs.md
- **Purpose:** the background-job runtime — long-running producers with identity, access control, lifecycle and an output ring.
- **Key abstractions:** `JobId` (`<kind>-<short-uuid>`), `JobKindMap`, `JobStatus`, `JobRegisteredData`/`JobSettledData`, `JobSpec`, `JobHandle`, `JobHooks`, `JobOutcome`, `JobOutputSource`/`JobSourceRead`, `JobChunk`.
- **Data flow:** the runtime preflights access and cleanup, calls `run(job)` synchronously, commits the registration with no later failable step; pull sources are pumped into a bounded ring at the registry's own cadence and drained once more before settlement closes the ring.
- **Non-obvious design decisions:** "`JobHooks.done` resolves after the producer releases its resources, not merely when work finishes" (`jobs.md:163-166`) — so a producer cannot leak by resolving early. `producerReported` "does not independently certify resource release" (`jobs.md:60-61`).
- **Edge cases:** a missing `job/settled` remains incomplete even if the live registry reported termination — "consumers must not invent a finish timestamp" (`jobs.md:31`). A job's trailing flush after settlement logs and drops instead of throwing, so it cannot break its own teardown path (`jobs.md:131-133`).
- **Surprising:** the `log` channel is producer narration that reaches observers only, never the model's consuming read (`jobs.md:234`).

### docs/subsystems/jobs.zh.md
Chinese translation of `jobs.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/llm-streaming.i18n.yaml
Bilingual-pair hash record for `llm-streaming.md`: 15 per-heading pairs under `/llm-streaming`.

### docs/subsystems/llm-streaming.md
- **Purpose:** the `packages/llm` conversation types, the streaming wire protocol and the adapter contract every provider must obey.
- **Key abstractions:** `ContentBlockMap` (text/reasoning/image/file/tool-call/tool-addition/tool-removal), `Message`/`UserMessage`/`DeveloperMessage`, `MessageSourceMap` with the semantic `ContextForm` axis, `StreamChunk` (a **closed** union), `ReplayEnvelope`, `AssistantStreamRecord`, `LlmFailure`, `LlmImageRequestPricing`, `ResolvedRetryPolicy`, `AppIdentity`, `TokenUsage`, `BlockAssembler`, `GenerateOptions`, `FinishReasonMap`, `ToolSchema`, `LlmCallConfig`/`EpochHeader`, `PreparedLlmCall`, `LlmAdapter`.
- **Data flow:** the loop logs raw chunks while feeding the same chunks through the shared `BlockAssembler`, then stores the assembled assistant content with the provider and model that produced it; the assembler is the *single* shared fold implementation (`llm-streaming.md:366`).
- **Non-obvious design decisions:** the adapter contract lists hard obligations — usage before finish and nothing after; tool-call `arguments` stay raw JSON strings end-to-end; **one adapter call is one provider attempt** (adapters disable library retries; agent-level recovery opens another durable numbered turn) (`llm-streaming.md:298-306`). `TokenUsage` counts are **disjoint**: `inputTokens` is uncached input only, cached input is reported separately, and DeepSeek's folded `prompt_tokens` is subtracted back out (`llm-streaming.md:336`). `SystemPromptUpdate` has the single value `'in-history'` — the model reads the latest `system` message at any position, "so the agent loop can append a changed prompt after the cached history instead of rewriting message 0" (`llm-streaming.md:544`).
- **Edge cases:** an empty completion is a retryable error with the canonical `EMPTY_RESPONSE` code, not a silent success (`llm-streaming.md:304`); context overflow has one canonical code surfaced whether the failure arrived as a thrown HTTP error or an in-band finish (`llm-streaming.md:303`); provider stalls are bounded at the transport by a five-minute default idle watchdog (`llm-streaming.md:302`).
- **Surprising:** "One keep/drop decision covers content and metadata together: a `max-tokens` finish drops every tool call because a truncated call is unsafe to execute, and the same decision prunes the replay envelope's per-block entry at each dropped position. `blocks()` and `replayState` therefore cannot disagree." (`llm-streaming.md:368`) And replay state is passed to an adapter only when that adapter instance currently owns both the historical provider and the target provider (`llm-streaming.md:306`).

### docs/subsystems/llm-streaming.zh.md
Chinese translation of `llm-streaming.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/lsp.i18n.yaml
Bilingual-pair hash record for `lsp.md`: 5 per-heading pairs under `/lsp-navigation`.

### docs/subsystems/lsp.md
- **Purpose:** semantic code navigation on one `ctx.lsp` service.
- **Key abstractions:** the closed `LspOperation` union (`goToDefinition | findReferences | goToImplementation | hover`), zero-based UTF-16 `LspPosition`/`LspRange`, `LspQueryRequest`/`LspProviderQuery`, the closed `LspQueryResult` union, `LspProvider`, `LspService`.
- **Data flow:** the seam selects a provider per query by file extension and runs one query; `findReferences` always includes declarations, enforced by the provider so callers get no flag.
- **Non-obvious design decisions:** "Every field is required … so no field needs implementation defaulting and there is no `resolve()` step" (`lsp.md:45`). The seam exposes no protocol types, process/document controls, or generic JSON-RPC escape hatch (`lsp.md:116`).
- **Edge cases:** provider registration reserves the id and every extension *atomically* — an invalid or conflicting registration publishes nothing.
- **Surprising:** the `locations` variant carries `resolvedWorkspaceUri` because "A caller that relativizes location URIs MUST use this, not parse the request's possibly symlinked process path with host-platform rules" (`lsp.md:104-107`).

### docs/subsystems/lsp.zh.md
Chinese translation of `lsp.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/mcp.i18n.yaml
Bilingual-pair hash record for `mcp.md`: 10 per-heading pairs under `/mcp`.

### docs/subsystems/mcp.md
- **Purpose:** connect the model to tools supplied by external MCP servers.
- **Key abstractions:** per-server client plugin; shared `mcp-resources` service; `McpResourceRequest`/`McpResourceProvider`.
- **Data flow:** discovery → adapt tools into ordinary harness tools → the ordinary tool pipeline handles permission, cancellation, recording and presentation; server instructions join the logged system prompt as scoped, server-attributed sections.
- **Non-obvious design decisions:** the client "does not publish a shared `ctx.mcp` service" (`mcp.md:41`) — the shared resource service is a separate package that selects providers in the caller's scope. "A replacement connection publishes instructions only after discovery succeeds" (`mcp.md:67`).
- **Edge cases:** a failed tool-list refresh retains the previous tool generation; connection failures do not remove the shared resource tools while a visible client entry remains active; the first provider in a scope enables the local shared tools and removing the last removes them.
- **Surprising:** MCP prompt templates, human-input elicitation, task-based execution and resource subscriptions are explicitly unsupported, and the page says so in a "Limits" section (`mcp.md:101`).

### docs/subsystems/mcp.zh.md
Chinese translation of `mcp.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/office-to-pdf.i18n.yaml
Bilingual-pair hash record for `office-to-pdf.md`: 5 per-heading pairs under `/office-to-pdf`.

### docs/subsystems/office-to-pdf.md
- **Purpose:** convert Office documents to PDFs on the Node Host; no model-facing tool and no Session event.
- **Key abstractions:** `OfficeToPdfRequest` (already-authorized source key/version + a deferred `read(signal, maxBytes)` callback), `OfficeToPdfPriority`, `OfficeSourceKey`, `OfficeToPdfGeneration`, `OfficeToPdfKey`, `RenderedDocumentBytes`.
- **Data flow:** the provider admits the deferred read *before* allocating source bytes, shares conversions by content identity, and removes its private scratch directory before returning.
- **Non-obvious design decisions:** the request carries a *deferred read* rather than bytes so the authorization check and the byte cap stay at the Host; source and PDF bytes never enter Session storage (`office-to-pdf.md:28`).
- **Edge cases:** invalid metadata, missing required assets and conversion errors reject *without* switching engines (`office-to-pdf.md:40`).
- **Surprising:** returned PDF bytes remain valid after provider disposal, and `generation` invalidates cached reuse when the provider is replaced.

### docs/subsystems/office-to-pdf.zh.md
Chinese translation of `office-to-pdf.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/otel.i18n.yaml
Bilingual-pair hash record for `otel.md`: 1 per-heading pair under `/otel-reporting`.

### docs/subsystems/otel.md
- **Purpose:** `ctx.otel`, a shared factory for independent ordinary-event and Session-log channels.
- **Key abstractions:** the service owns transport and SDK batching; a consumer supplies explicit transport/resource/scope options and owns each channel's shutdown.
- **Data flow:** business consumers inject the service and submit selected fields; "the shared service has no automatic identity or capture policy, and channels never share queues or requests" (`otel.md:7`).
- **Non-obvious design decisions:** "Mounting only the OTel service allocates no provider or transport" (`otel.md:9`) — allocation is lazy and consumer-driven.
- **Edge cases:** consumers must not reuse a channel after shutdown.
- **Surprising:** the page is four sentences of hand-written text over a 44-line file; the rest is the generated API block.

### docs/subsystems/otel.zh.md
Chinese translation of `otel.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/permission-presets.i18n.yaml
Bilingual-pair hash record for `permission-presets.md`: 5 per-heading pairs under `/permission-presets`.

### docs/subsystems/permission-presets.md
- **Purpose:** bundle the two independent enforcement knobs (sandbox mode, approval policy) into named presets a client offers as one selector.
- **Key abstractions:** `PresetSpec` (`sandbox` + `approval` + optional presentation), `Config.presets`/`defaultPreset`, `PresetOption`, the reserved `custom` and `auto` keys.
- **Data flow:** `set(session, name)` resolves the preset, runs Auto admission, appends a log-only `permission/preset` event, then writes each knob through its own setter *only when that knob's effective value changes*.
- **Non-obvious design decisions:** `custom` is derived-only — clients may display it as the current value but it is "never a switch target or an event payload" (`permission-presets.md:55`). The Auto integration's `admit` callback runs *before* Auto selection mutates the Session, so a missing integration never rewrites durable identity.
- **Edge cases:** misconfiguration fails at plugin load — configured entries named `custom`/`auto` throw, and composing over a non-confining bash executor throws because presets bundle a sandbox mode.
- **Surprising:** "The selection event precedes the knob events in the same turn" (`permission-presets.md:73`), so a replay sees the intent before its consequences.

### docs/subsystems/permission-presets.zh.md
Chinese translation of `permission-presets.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/persistence.i18n.yaml
Bilingual-pair hash record for `persistence.md`: 11 per-heading pairs under `/session-persistence`.

### docs/subsystems/persistence.md
- **Purpose:** the durability seam — how the append-only log becomes durable.
- **Key abstractions:** the abstract `SessionPersistence` service (`create`/`open`/`stat`/`list`), the per-session `SessionHandle` (`read`/`append`/`flush`/`close`), `SessionLocation`, `SessionHeader`, `CreateSessionOptions`/`RestoredSessionOptions`/`SessionPreparation`, `SessionPersistenceRevision`, `SessionPersistenceSnapshot`.
- **Data flow:** `session/event` is a *synchronous* notification; the backend routes it into a bounded write-behind window keyed by session id; the window's expiry starts one durable append through the write handle; `session/flush` cancels the wait and drains through quiescence (`persistence.md:106`).
- **Non-obvious design decisions:** `flush` is the *only* durability barrier — "on resolution every acknowledged append is durable"; `append` may be buffered (`persistence.md:82-91`). Persistence does **not** truncate or repair a crashed mid-turn log, "because a single turn can be huge in a long-horizon task … and those events were durably appended before the crash" — repair is the reader's job (`persistence.md:110`). Reads never backtrack below what a handle already observed, and reads concurrent with a mutation carry no ordering promise beyond the valid contiguous prefix (`persistence.md:34-39`).
- **Edge cases:** a second `open(id,'write')` rejects with `SessionAlreadyOwnedError`, so crash repair cannot race a live turn (`persistence.md:112`). A *future* highest format generation refuses even when an older readable generation remains (`persistence.md:189`).
- **Surprising:** `SessionHeader.delegationDepth` is persisted "so a recursion budget survives restart and resume — a runtime-only depth would reset a resumed child to top-level" (`persistence.md:171-176`), and `agentPreset` is durable because "a resume that restored a different composition would replay history the model can no longer act on" (`persistence.md:177-183`).

### docs/subsystems/persistence.zh.md
Chinese translation of `persistence.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/plan.i18n.yaml
Bilingual-pair hash record for `plan.md`: 6 per-heading pairs under `/plan-mode`.

### docs/subsystems/plan.md
- **Purpose:** plan mode as *soft guidance* — a deployment-owned prompt section, not an enforcement mode.
- **Key abstractions:** the log-only `plan/mode` event, `PlanModeConfig` (a single `section` string), the pending-selection mechanism, the `exit_plan_mode` tool and the `/plan` command.
- **Data flow:** `set(agent, active)` records a pending selection; the only append point while an agent is running is a prepended `agent/pre-step` listener that calls downstream listeners first and appends only after they accept the step.
- **Non-obvious design decisions:** "`exit_plan_mode` stays registered while plan mode is inactive, so entering or leaving plan mode changes only the prompt section, never the request tool catalog" (`plan.md:33`) — the model's tool list is stable across the mode change. Sandbox mode and approval policy enforce restrictions independently; neither reads or writes plan state (`plan.md:5`).
- **Edge cases:** an append failure cannot block the turn and the selection stays pending; a selection made after a turn's final accepted pre-step "remains process-local and is lost if the process exits before another accepted in-turn pre-step" (`plan.md:17`).
- **Surprising:** an appended user selection records one plugin-sourced `user/message` notice, but *only when the last logged request header described the other state* — "so the model is told exactly when its context changed and never redundantly" (`plan.md:17`).

### docs/subsystems/plan.zh.md
Chinese translation of `plan.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/product-telemetry.i18n.yaml
Bilingual-pair hash record for `product-telemetry.md`: 2 per-heading pairs under `/product-telemetry`.

### docs/subsystems/product-telemetry.md
- **Purpose:** send explicitly selected analytics events through OTLP/HTTP.
- **Key abstractions:** `ProductTelemetryRecord` (event name, string body, Unix-ms timestamp, scalar attributes), `ProductTelemetryScalar`.
- **Data flow:** "Enqueue is synchronous and does not acknowledge delivery. The SDK owns batching and retry" (`product-telemetry.md:9`).
- **Non-obvious design decisions:** "The exporter collects no Session data or identifiers automatically" (`product-telemetry.md:5`); the service owns *submission* only, and product consumers own when an event occurs and which fields are approved.
- **Edge cases:** attribute values accept scalars and one-level objects of scalars; optional severity defaults to INFO; observation time is assigned at enqueue.
- **Surprising:** ordinary Web clients do not collect product events at all — only the Desktop consumer does.

### docs/subsystems/product-telemetry.zh.md
Chinese translation of `product-telemetry.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/ptc-runtime.i18n.yaml
Bilingual-pair hash record for `ptc-runtime.md`: 5 per-heading pairs under `/ptc-runtime`.

### docs/subsystems/ptc-runtime.md
- **Purpose:** run one program against host bindings and report output, failure and sandbox facts.
- **Key abstractions:** `PtcRunRequest`/`PtcRunSpec` (the resolve split), `PtcRunSandbox`, `PtcRunResult`, `PtcBindingNamespace`/`PtcBindingFunction`/`PtcBindingErrorClass`, `PtcJsonValue`, `PtcRunFailure`.
- **Data flow:** `resolve(request)` validates supported choices and applies deployment defaults; `run(spec)` executes and resolves with a result whose `error` is a *field*, never a rejection — "reporting a failed program is the caller's job, not an exception path" (`ptc-runtime.md:85-88`).
- **Non-obvious design decisions:** binding globals must match a language-portable identifier subset, so a JS-only spelling like `$tools` is rejected "by design, not just by the Python backend"; binding names are own properties so `__proto__` cannot traverse a prototype (`ptc-runtime.md:141-152`). Failure kinds are **orthogonal**: "a budget expiry is not an exception, an abort is not a timeout, and a substrate death is neither" (`ptc-runtime.md:180`).
- **Edge cases:** sandbox mode, observed denial and enforcement completeness are separate facts, "so a successful program does not by itself prove that every requested restriction was enforced" (`ptc-runtime.md:75`).
- **Surprising:** `stateOwner` is an in-process object identity for retained memory; distinct objects stay isolated and no retained object enters the durable Session format.

### docs/subsystems/ptc-runtime.zh.md
Chinese translation of `ptc-runtime.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/README.i18n.yaml
Bilingual-pair hash record for `README.md`: 1 per-heading pair under `/subsystems`.

### docs/subsystems/README.md
- **Purpose:** the index of the folder — one line per subsystem page stating what it "owns".
- **Key abstractions:** a 74-row table (page → owns), plus the note that type blocks are source-equivalent and drift-checked by `pnpm run verify-type-equiv` (`README.md:76`).
- **Data flow:** n/a — this is the map the rest of the folder is organised by.
- **Non-obvious design decisions:** the index is the contract that a page either documents a subsystem's *vocabulary and wiring* or it is not a page; `architecture.md` owns behaviour across subsystems (`README.md:5`).
- **Edge cases:** n/a.
- **Surprising:** it names subsystems the shard's pages do not cover in depth (`extension`, `plugin` families), so a reader must use it as a table of contents rather than an index of implemented features.

### docs/subsystems/README.zh.md
Chinese translation of `README.md`; heading parity confirmed (one heading, one hash pair).

### docs/subsystems/sandbox.i18n.yaml
Bilingual-pair hash record for `sandbox.md`: 5 per-heading pairs under `/process-sandbox`.

### docs/subsystems/sandbox.md
- **Purpose:** wrap a same-world subprocess argv in a file-effect policy without coupling consumers to a platform runner.
- **Key abstractions:** `SandboxMode` (`read-only | workspace-write | danger-full-access`), `SandboxEnforcement` (`full | partial`), `SandboxExecutionPolicy`, `SandboxPolicyRequest`, `SandboxPolicy`, `ConfinedArgv`, `RunnerFailureRule`.
- **Data flow:** `ctx.sandboxPolicy.resolve()` resolves mode + workspace root per call; only a confined execution reaches `ctx.sandbox.confine(argv, policy, signal)`, which returns a `ConfinedArgv` to spawn in place of the caller's argv.
- **Non-obvious design decisions:** the policy is carried **per call**, not fixed on the provider, "so two consumers may confine under different policies at the same instant" (`sandbox.md:88`). Enforcement is a *reported fact*: `partial` means the backend governs only a subset, "so consumers that require the absolute promise must reject or surface that distinction" (`sandbox.md:30`).
- **Edge cases:** `ctx.sandbox` rejects with `SandboxUnavailableError`/`SANDBOX_UNAVAILABLE` when no usable backend exists — "Silent unconfined passthrough is never legal for a confined policy" (`sandbox.md:156`). The Windows ACL runner reports partial enforcement for its ambient ACL gaps.
- **Surprising:** the denial dialect is per-backend — "the union claims denials a given backend never produces" (`sandbox.md:134-140`) — and consumers check **runner failure before denial**, because runner failure means the command never ran while denial means confinement worked and blocked it (`sandbox.md:142-148`).

### docs/subsystems/sandbox.zh.md
Chinese translation of `sandbox.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/schedule.i18n.yaml
Bilingual-pair hash record for `schedule.md`: 12 per-heading pairs under `/host-wide-schedule`.

### docs/subsystems/schedule.md
- **Purpose:** reminders stored independently of Session activation and delivered back to their original Session.
- **Key abstractions:** `ScheduleId`, five record kinds (`After`/`At`/`Every`/`Daily`/`Weekly`/`Cron`), `LocalAtInput`, `DailyInput`, `LegacyScheduleRecord` for historical Session decoding.
- **Data flow:** the version-1 `schedule` storage domain owns a `tasks` table binding a record to its original `sessionId`; creation canonicalizes the target into RFC 3339 UTC `scheduledAt`; delivery re-enters the owning Session.
- **Non-obvious design decisions:** "Successful creation stores only canonical UTC `scheduledAt`, so replay never depends on ambient time-zone state" (`schedule.md:121`). Cron canonicalisation "expands each field into its matched value set and re-encodes that set deterministically", and preserving each field's **star flag** is what keeps day-of-month/day-of-week Vixie-faithful (`schedule.md:165`, `:169`). A missing title fails durable decoding with `ScheduleLogError` and the domain declares *no* backup-and-skip policy, so one bad record rejects the whole domain open (`schedule.md:9`).
- **Edge cases:** daylight-saving gaps skip a date and overlaps choose the earlier instant; a non-future target and a local time inside a DST gap are rejected; on Host restart only the *latest* due occurrence is delivered — "Missed occurrences do not accumulate" (`schedule.md:146`).
- **Surprising:** the tool layer refuses a delegated caller with `subagent_session`, so a delegated child neither sees the four schedule tools nor has a call accepted (`schedule.md:119`).

### docs/subsystems/schedule.zh.md
Chinese translation of `schedule.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/scope.i18n.yaml
Bilingual-pair hash record for `scope.md`: 4 per-heading pairs under `/scoped-registration`.

### docs/subsystems/scope.md
- **Purpose:** the identity/carrier/layer primitive that makes one registration context mean both per-agent visibility and shared lifetime ownership.
- **Key abstractions:** `ScopeKey` (opaque object identity), `Scoped<T>` (compile-time brand on the routing receiver), `Scope` (`ctx` + `rawDispose` + `dispose()`), `ScopeLayer`, `ScopedLayers<L>`, `NamedEntries<V>`/`AnonymousEntries<V>`.
- **Data flow:** registrations file into the layer of their calling context's scope; a read merges the global layer with the viewing scope's chain, nearest layer winning.
- **Non-obvious design decisions:** `rawDispose` "preserves the exact Cordis disposer identity needed by an ordered composite effect", while `dispose()` is the public shared quiescence boundary for racing callers (`scope.md:31`). Reads do not create layers — `peek(undefined)` means no overlay; `merge()` materializes them (`scope.md:57`).
- **Edge cases:** a scoped layer is reclaimed only when its complete `ScopeLayer` is empty, so a sibling table is not discarded; draining a table detaches existing iterators from later insertions.
- **Surprising:** the primitive "never inspects the object" it keys on — the shipped loop happens to use the live `Agent` as its own key (`scope.md:11`).

### docs/subsystems/scope.zh.md
Chinese translation of `scope.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/session-projection.i18n.yaml
Bilingual-pair hash record for `session-projection.md`: 4 per-heading pairs under `/session-projections`.

### docs/subsystems/session-projection.md
- **Purpose:** a seam through which domain plugins serve whole current values of log-derived per-session state to client carriers.
- **Key abstractions:** `SessionProjectionStateMap` (host fold states), `SessionProjectionMap` (client-visible values), `ProjectionDefinition` (`init`/`apply`/`wire`/`stateVersion`), `ProjectionSnapshot` (a consistent read cut with an `asOfSeq` watermark), `ProjectionChangeListener`.
- **Data flow:** the registry subscribes to `session/event` once and folds every committed event through every registered unit; domains hold no subscriptions and clients never fold domain events — "they receive finished values" (`session-projection.md:5`).
- **Non-obvious design decisions:** all unit functions MUST be synchronous — "an async unit would tear the carriers' consistency cut" (`session-projection.md:20`). A unit uninterested in an event MUST return the *same state reference*; an unchanged reference (`Object.is`) produces zero downstream work (`session-projection.md:38-44`).
- **Edge cases:** cells build lazily; a unit registered after events flowed folds `init` over the in-memory log on first touch. A duplicate key with a different `stateVersion` throws; same-version registrants share one unit.
- **Surprising:** `snapshot(session)` is fully synchronous so a carrier reads it in the same tick as its page slice, and `asOfSeq` covers both reads at one sequence number (`session-projection.md:102`).

### docs/subsystems/session-projection.zh.md
Chinese translation of `session-projection.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/session-query.i18n.yaml
Bilingual-pair hash record for `session-query.md`: 8 per-heading pairs under `/session-query`.

### docs/subsystems/session-query.md
- **Purpose:** query vocabulary over the live-preferred logical session corpus.
- **Key abstractions:** `SessionRecord`, `SessionEventRecord`, `SessionLogSnapshot`, `SessionSurfaceSnapshot`, `SessionTitleObservation`, `SessionResultFilter`/`SessionEventResultFilter`, `SessionEventSearchDocument`, `SessionSearchCursor`, `SessionSearchRequest`/`SessionEventSearchRequest`, `SessionSearchPage`.
- **Data flow:** `filterSessions`/`filterEvents` apply provider-independent filters; `searchSessions` groups the corpus by strongest matching event; `searchEvents` searches one session; both bind an opaque cursor to the normalized query.
- **Non-obvious design decisions:** filter arrays are ANDed and values inside one list clause are ORed; the event `text` clause is "a literal Unicode case-insensitive, whitespace-flexible regular-expression scan over extracted semantic text, independent of full-text providers" (`session-query.md:111`).
- **Edge cases:** "Full-text query interpreted as data, never executable FTS syntax" (`session-query.md:161`); the event text scan is intentionally absent from provider metadata filters.
- **Surprising:** a within-session search must expose its observed target header "even when the page contains no hits" (`session-query.md:200`), and reasoning blocks, blocked prompts, structural events and stream chunks contribute *no* semantic text (`session-query.md:147`).

### docs/subsystems/session-query.zh.md
Chinese translation of `session-query.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/session-reference.i18n.yaml
Bilingual-pair hash record for `session-reference.md`: 5 per-heading pairs under `/session-references`.

### docs/subsystems/session-reference.md
- **Purpose:** structured cross-session references — lift context out of another session's log into this one.
- **Key abstractions:** `FileReferenceCandidate` (path-only), `SessionReferenceInput`, `SessionReferenceCandidate` (with `sameWorkspace`), `SessionReferenceMentionCandidate`, `SessionReferenceSource` (the `recall` context form), `PreparedReferencedMessage`, `SessionReferenceErrorCode`.
- **Data flow:** preparation preserves readable current-message content and returns at most one aggregated context; the durable source records the cited event seqs and byte accounting.
- **Non-obvious design decisions:** "Their durable source records keep `capturedThroughSeq` as a coordinate in the referenced Session's original generation; they never reinterpret it as a seq in the containing Session" (`session-reference.md:73`).
- **Edge cases:** the error taxonomy separates invalid configuration/input, self-reference, count limits, source-read failure, budget failure and cancellation; host protocols map codes to their own envelopes "without inspecting prompt bytes" (`session-reference.md:111`).
- **Surprising:** the aggregated cross-session snapshot is explicitly labelled *untrusted* in the prompt.

### docs/subsystems/session-reference.zh.md
Chinese translation of `session-reference.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/session-telemetry.i18n.yaml
Bilingual-pair hash record for `session-telemetry.md`: 6 per-heading pairs under `/sessiontelemetrybackend`.

### docs/subsystems/session-telemetry.md
- **Purpose:** an outbound session-reporting seam that mirrors canonical events to a backend.
- **Key abstractions:** `SessionTelemetrySeverity`, `SessionTelemetryRecord` (ledger vs ops channels), `SessionTelemetrySharingStatus`, `SessionTelemetryCapture`/`SessionTelemetryCaptureOptions`, `SessionTelemetrySink`, the `session-telemetry/record` waterfall.
- **Data flow:** every canonical session event passes through whole as one ordered ledger record; process-local `agent/assistant-stream` frames do not enter the durable feed (`session-telemetry.md:60`).
- **Non-obvious design decisions:** the seam ships **no rules of its own** — "with no listener mounted, records reach the backend exactly as captured, so exported data is precisely as clean as the rules a deployment mounts" (`session-telemetry.md:144`). Redaction applies to the exported copy only; the canonical log is never rewritten.
- **Edge cases:** delivery is best-effort — "the cursor marks handed-off, not delivered", so records can be lost or duplicated; receivers dedupe on `(session.id, session.format_version, event.seq)` while ops records deliberately omit that identity (`session-telemetry.md:60`).
- **Surprising:** the sink's `emit` MUST be a non-blocking enqueue, "because the coordinator calls this synchronously from the `session/event` hot path" (`session-telemetry.md:105`).

### docs/subsystems/session-telemetry.zh.md
Chinese translation of `session-telemetry.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/session-title.i18n.yaml
Bilingual-pair hash record for `session-title.md`: 4 per-heading pairs under `/session-titles`.

### docs/subsystems/session-title.md
- **Purpose:** durable latest-wins session titles plus the optional asynchronous provider vocabulary.
- **Key abstractions:** `SessionTitleProviderId`, `SessionTitleModelIdentity`, `SessionTitleSource` (`fallback`|`provider`|`user`), `SessionTitleEventData`, `SessionTitleSnapshot`, `SessionTitleLlmRequestEventData`, `SessionTitleProviderRequest`/`SessionTitleProviderResult`, `SessionTitleProvider`.
- **Data flow:** the service snapshots eligible messages through one revision and, immediately before each provider call, the latest accepted title; a provider returns only seqs from that request; service-owned acceptance verifies ordering, normalizes the title, enforces the byte limit and appends the title.
- **Non-obvious design decisions:** the shared execution module records each validated, dispatchable title request *before* calling the model — "The payload reproduces the model-visible system and message input, routing, output limit, resolved reasoning effort, provider ownership, and source-message attribution even when generation later fails" (`session-title.md:67`).
- **Edge cases:** an explicit user rename *pins* the title — automatic generation stops scheduling (`session-title.md:38-39`); the `title` projection keeps its version-1 state so existing persisted cache rows remain readable.
- **Surprising:** the provider receives the *current* title (including a fallback the service just ensured) as input, so a title generator can avoid repeating an earlier title.

### docs/subsystems/session-title.zh.md
Chinese translation of `session-title.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/session.i18n.yaml
Bilingual-pair hash record for `session.md`: 22 per-heading pairs under `/sessions` — the largest heading tree in the shard.

### docs/subsystems/session.md
- **Purpose:** the in-memory, event-sourced model — a `Session` is an append-only log of typed `SessionEvent`s, and the LLM history is *derived* from that log, never stored separately.
- **Key abstractions:** `SessionEventMap` (13 core variants), `SessionEvent<T>` with conditional `surfaceOp`/`sourceEventSeqs`, `EpochHeader`, `RequestContext`, `SurfaceEventType`, `SurfaceOp` (`append` | `{op:'replace', startSeq, endSeq}`), `SurfaceIntent`, `SessionMessageProjection`, `SessionSurface`, `SurfaceFoldResult`, `Session`, `TurnEndReasonMap`, `PluginRecord`.
- **Data flow:** `Session.append(type, data, ...opts)` validates lossless JSON, the surface contract and the header rules at the *append site* ("a bad event fails at the append site rather than later during a backend flush"), then commits and publishes; `deriveMessages()` projects the surface into the frozen `Message[]` the model sees.
- **Non-obvious design decisions:** the rendered system prompt is **not** in the header — it is derived history (surface node 0 plus any later in-history system node), "so a prompt change replaces or appends a system node and leaves the header unchanged" (`session.md:183`). `request/context` keeps route capacity *out* of `EpochHeader` "so a route change [cannot] register as a request-envelope `change`" (`session.md:210`). `request/header` reasons distinguish `initial`/`resume`/`change`/`series` so later turns inherit the latest snapshot (`session.md:183`). Because `SessionEventMap` is merge-extensible, "switches over `SessionEvent` must NOT use `assertNever`" (`session.md:292`).
- **Edge cases:** an unrecognized event type without the `ignorable: true` marker "MUST refuse to reconstruct the session instead of silently dropping the event" (`session.md:274-282`). An empty-content `assistant/message` is skipped from derived history but still records its stream and usage (`session.md:671`). Any `max-tokens` step makes the whole turn end `max-tokens` "rather than `completed` (the cut-short fact wins over a later continuation)" (`session.md:729`). `session/end-seed` exists because seed history and live work are byte-identical, which would otherwise make an unmatched `compaction/start` ambiguous (`session.md:743`).
- **Surprising:** the loop never emits `interrupted` or `forked` live — crash recovery synthesizes `interrupted` and fork-seed construction synthesizes `forked` (`session.md:729`); and the `session/end-seed` marker is created only by the constructor and `buildForkSeed`, because `Session.append` does not reject other writers, so a plugin appending one "would silently classify every live bracket before it as seed history" (`session.md:162-165`).

### docs/subsystems/session.zh.md
Chinese translation of `session.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/settings.i18n.yaml
Bilingual-pair hash record for `settings.md`: 3 per-heading pairs under `/plugin-configuration-forms`.

### docs/subsystems/settings.md
- **Purpose:** the plugin-configuration-form seam — how a plugin declares an editable settings form.
- **Key abstractions:** the page narrative covers identity/values and edits; the substance is the generated `ctx.settings` (`SettingsForms`) and `ctx.settingsController` (`SettingsController`) API plus the `settings/*` events.
- **Data flow:** a plugin registers a form; the controller resolves the layered values (defaults → composition `base` → user document) and commits hot.
- **Non-obvious design decisions:** the folder README describes the settings seam as "layered resolution (defaults → composition `base` → user document), owner scopes, hot commits" (`README.md:24`) — the layering is the composition's, not the plugin's.
- **Edge cases:** not established from this page's narrative; the generated API block is the source here.
- **Surprising:** like `extensions.md`, this page's narrative is a pointer and its `.i18n.yaml` records three heading pairs accordingly.

### docs/subsystems/settings.zh.md
Chinese translation of `settings.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/shell.i18n.yaml
Bilingual-pair hash record for `shell.md`: 7 per-heading pairs under `/shell-executor`.

### docs/subsystems/shell.md
- **Purpose:** the shell execution seam — foreground runs and background process handles.
- **Key abstractions:** the `ShellExecRequest` → `ShellExecSpec` resolve split, `ShellRunResult`, `ShellSandboxInfo`, `ShellProcess`/`ShellProcessRead`/`ShellObservedStreams`.
- **Data flow:** `ctx.shell.resolve(request)` fills and caps the required fields; `run(spec)` executes; `start(spec)` resolves with a handle after asynchronous launch preparation.
- **Non-obvious design decisions:** `stdin` and `env` are trusted in-process plugin inputs and are *not* exposed by the model-facing bash tool (`shell.md:105`). The `DSH_*` managed environment merges *after* ordinary env "so an entry here can never displace one" (`shell.md:57-63`).
- **Edge cases:** "Orthogonal outcomes are reported independently — a process can both time out AND exit 0 because it trapped the signal" (`shell.md:111`); `timedOut` and `aborted` are mutually exclusive because one fused deadline drives both, so a race reports the single first-abort cause (`shell.md:121-133`). When output is truncated the kept text is the **tail** and the complete stream spills to a private file (`shell.md:143`).
- **Surprising:** a background process handle "has no id or owner" — the generic job runtime owns identity and lifecycle, and `dsh-tool-bash` adapts the handle into it (`shell.md:173`).

### docs/subsystems/shell.zh.md
Chinese translation of `shell.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/sidebar-right.i18n.yaml
Bilingual-pair hash record for `sidebar-right.md`: 11 per-heading pairs under `/right-sidebar`.

### docs/subsystems/sidebar-right.md
- **Purpose:** the per-Session docking surface beside the conversation.
- **Key abstractions:** resource addresses (`dsh-resource://<type>/…`) and page addresses (`sidebar://<kind>`); a tab type = a static definition + a keyed slot registration sharing one `id`; the `ctx.sidebarRight` navigation service; `SidebarRightTarget`/`isTargetCurrent`.
- **Data flow:** `openResource`/`openTab` run four steps as *one* history entry — claim → focus an existing tab → seat a new tab → expand the column — then record the navigation.
- **Non-obvious design decisions:** "Tab identity is the pair `(kind, address)`" (`sidebar-right.md:32`); routing is a *ranked claim* by band, then longest matched pattern, then registration order (`sidebar-right.md:51`); one `kind` may carry one `builtin` and one `extension` registration, the extension winning, and the extension unregistering lets the builtin resume (`sidebar-right.md:53`).
- **Edge cases:** an address no type claims throws — "it is a wiring mistake, not a user error"; writes need a mounted Session surface and throw without one rather than writing into a surface nobody draws (`sidebar-right.md:78-91`).
- **Surprising:** `navigation.revision` increments on every navigation *whether or not* params changed, so a body can act on "navigated again" alone (`sidebar-right.md:111`); and the page carries an explicit "Not built" list (persistence, undo, address lookup, retitling) — naming what is deliberately absent.

### docs/subsystems/sidebar-right.zh.md
Chinese translation of `sidebar-right.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/skills.i18n.yaml
Bilingual-pair hash record for `skills.md`: 8 per-heading pairs under `/skills`.

### docs/subsystems/skills.md
- **Purpose:** the skill capability — optional instruction files a model can load on demand.
- **Key abstractions:** `SkillProvider`/`SkillProviderObservation`/`SkillProviderControl`, `SkillSource`, `SkillInvocationPolicy`, `SkillSummary`/`SkillCandidate`/`SkillDefinition`, `SkillLookupOptions`/`SkillViewOptions`, `SkillCatalogSnapshot`.
- **Data flow:** the registry merges provider catalogs across host and per-scope layers; the consumer injects a durable `<system-reminder>` catalog at the first `agent/pre-step` and re-injects a full replacement through `agent.inject()` when the digest of the visible entries changes.
- **Non-obvious design decisions:** a read merges the global layer with the viewing scope's chain and "the nearest layer's entry wins a duplicate skill name outright, and the rank order below decides duplicates only within one layer" (`skills.md:13`). The model-facing catalog carries "sorted skill `name` and normalized, XML-escaped `description` only; it omits bodies, paths, sources, providers, and routing hints" (`skills.md:229`).
- **Edge cases:** an incomplete discovery snapshot is *not* cached, "allowing each consumer to retain its last-good filtered catalog and retry" (`skills.md:130`); a provider that changes generation mid-flight retries once, and a second change returns the latest candidates incomplete and uncached.
- **Surprising:** the model-facing `skill({name})` tool re-reads the complete definition for the calling agent cwd and re-checks the invocation policy *after* loading — so a skill can be made non-model-invocable between listing and loading.

### docs/subsystems/skills.zh.md
Chinese translation of `skills.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/slots.i18n.yaml
Bilingual-pair hash record for `slots.md`: 8 per-heading pairs under `/web-client-slots`.

### docs/subsystems/slots.md
- **Purpose:** the Web Client's typed React composition system.
- **Key abstractions:** `SlotMap` (the compile-time registry), four cardinalities (`single | list | keyed | chain`) × three scopes (`root | session-maybe | session`), `PropsRuntime<K>`/`PropsRenderSlots<S>`/`PropsStore<H>`/`InjectFace<I>`/`PropsLocale<N>`, the `hooks` compartment, the shipped Conversation hierarchy tree.
- **Data flow:** declaring a child makes the child key live, authorizes the parent's `renderSlot` call and records the runtime dispatch spec; registrations follow Cordis effect lifetimes.
- **Non-obvious design decisions:** "Components never receive `ctx`" — owner point-in-time values enter through the owner argument to `renderSlot`, shared view state uses a declared store, and services stay in the `apply` closure (`slots.md:79`). The `hooks` compartment is "the sole exception for bare observables" (`slots.md:199`). `single` and an occupied keyed cell are *replacement points*, not additive slots (`slots.md:200`).
- **Edge cases:** a `session` entry remounts when its binding generation changes; a blank `session-maybe` entry adopts its first binding without remounting (`slots.md:77`).
- **Surprising:** the shipped hierarchy is published as a **generated** catalog (`pnpm run gen-client-catalog`) that is "the exhaustive contract for each key: cardinality, scope, owner props, standard props, current occupants, declaration owner, and replacement risk" (`slots.md:191`).

### docs/subsystems/slots.zh.md
Chinese translation of `slots.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/spill.i18n.yaml
Bilingual-pair hash record for `spill.md`: 4 per-heading pairs under `/spill-storage`.

### docs/subsystems/spill.md
- **Purpose:** persist caller-provided text and return a model-facing locator with retrieval guidance.
- **Key abstractions:** `SaveTextSpill`, `SpillOwner`, `SpillSource` (tool | session-reference), `SpillRef`, the branded opaque `SpillLocator`.
- **Data flow:** `saveText(input)` persists the FULL content verbatim and returns `{locator, bytes, retrievalHint}`; the policy consumer replaces an over-`maxInlineTokens` result with ordered head/tail content plus a spill address.
- **Non-obvious design decisions:** the seam owns storage only — no retention policy, no tool-result replacement, no retrieval/search API (`spill.md:90`). The spill policy is best-effort: "a save failure keeps the original inline result rather than turning a successful call into an `isError`" (`spill.md:92`).
- **Edge cases:** a retention-period cleanup may expire old locators; the seam defines no per-session cleanup policy.
- **Surprising:** the local backend writes with an exclusive owner-only `open(path,'wx',0o600)` so "a planted symlink cannot redirect it" (`spill.md:92`), and forked sessions inherit locators already present in the seeded log without copying or re-owning the artifacts.

### docs/subsystems/spill.zh.md
Chinese translation of `spill.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/ssh.i18n.yaml
Bilingual-pair hash record for `ssh.md`: 6 per-heading pairs under `/ssh`.

### docs/subsystems/ssh.md
- **Purpose:** one remote filesystem/process world over a deployment-owned OpenSSH connection; the harness, model transport and Session storage stay on the host.
- **Key abstractions:** `HelperLaunch` (`node-script` | `executable`), `Config` (host alias, helper path + SHA-256, workspace, deadlines, frame caps, lease), the `SshConnection` service.
- **Data flow:** administrative RPC uses the helper's SSH exec streams; ordinary stdin/stdout/stderr and terminal output use separately authenticated forwarded Unix sockets with their own channel windows.
- **Non-obvious design decisions:** the helper executes filesystem and process requests with trusted local providers *on the remote machine*; "SSH is a transport; the selected remote sandbox provider enforces file effects" (`ssh.md:17`).
- **Edge cases:** "The client reports unconfirmed outcomes honestly and never reconnects to replay a possibly executed action" (`ssh.md:23`); SSH loss invalidates pending operations, and helper EOF/signals/lease expiry start remote cleanup.
- **Surprising:** `processPathFromHostPath()` is unavailable for SSH — installing a remote artifact does not make an arbitrary host path portable.

### docs/subsystems/ssh.zh.md
Chinese translation of `ssh.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/storage.i18n.yaml
Bilingual-pair hash record for `storage.md`: 7 per-heading pairs under `/storage`.

### docs/subsystems/storage.md
- **Purpose:** persist everything that is not a session event log.
- **Key abstractions:** `Storage` (the hub), `StorageForms`, `StorageBackend` with optional `KvFacet`, `DomainSpec` (name/version/layout/`compatibleVersions`/`invalidRecords`/tables/global), `Domain`, `DomainFacility`, `DomainChanged`.
- **Data flow:** a domain is declared once by its owning package; `ctx.storageDomain.open(spec)` resolves a route, opens the unit and validates every stored record against the spec's zod schemas; writes queue on one per-domain chain and reach backend durability → then memory → then `domain/changed`.
- **Non-obvious design decisions:** the hub performs no IO itself, and "which backend serves which consumer is that consumer's configuration (the domain layer's route table), never a hub-global choice" (`storage.md:11`). `defineDomain(spec)` fails loud at the owner's module load, before any medium is touched (`storage.md:95`).
- **Edge cases:** a rejected backend write leaves memory untouched, "so reads never diverge from the medium" (`storage.md:126`); `invalidRecords: 'backup-and-skip'` is for disposable derived data only — the default rejects the whole open, "right for authoritative data" (`storage.md:78-85`).
- **Surprising:** the `domain/changed` event is a *notification*, not a transaction participant — a synchronously throwing listener is contained with a logged warning rather than rejecting the already-durable write (`storage.md:153`).

### docs/subsystems/storage.zh.md
Chinese translation of `storage.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/subagent.i18n.yaml
Bilingual-pair hash record for `subagent.md`: 8 per-heading pairs under `/subagents`.

### docs/subsystems/subagent.md
- **Purpose:** the unified activation API for child agents — local conversations and external executions behind one interface.
- **Key abstractions:** `SubagentCapabilities`, `SubagentActivationSpec` (with `delivery: 'parent' | 'caller'`), `SubagentActivation`, `SubagentStartRequest`/`ResolvedSubagentStartRequest`, `ContinuableCreateRequest`/`ContinuableCreateSpec`, `AgentMessageSource`/`SubagentSettledMessageSource`, `SubagentInterruptAuthority`, `SubagentResult`, `SubagentStopReasonMap`, `SubagentRun`, `SubagentProvider`.
- **Data flow:** the manager reserves identity and capacity, prepares the child, and owns input admission, cold resume and child-first disposal; both local and external executions report their final text, structured result, diagnostic and status in the parent settlement notice.
- **Non-obvious design decisions:** `ContinuableCreateSpec` "is DATA, never a capability: it carries no Agent, `AgentHandle`, prompt delivery, result, disposal, or resume operation, because the continuation manager owns the child's whole lifecycle after preparation" (`subagent.md:160-171`). The provider's *only* participation in a continuable child is whether the session is seeded with parent history (`subagent.md:358-371`). `SubagentSettledMessageSource` is deliberately a different `kind` from `AgentMessageSource` — "a transcript that merged them would credit the child with words it never wrote" (`subagent.md:194-196`).
- **Edge cases:** `sendMessage` "authorizes the exact live sender and permits only adjacent local agents"; external executions reject follow-ups; `caller` delivery suppresses settlement notices. A cleanup failure does not replace a captured execution result — the result and parent notice retain it while `dispose()` rejects (`subagent.md:233`).
- **Surprising:** the subagent stop-reason vocabulary deliberately mirrors the harness turn-end vocabulary so the tool layer can map a non-`completed` result to an `isError` tool result (`subagent.md:268-287`); and `listDescendants` skips repeated ids and cycles, and omits sessions absent from reachable catalogs (ordinary Session forks are not discoverable) (`subagent.md:381`).

### docs/subsystems/subagent.zh.md
Chinese translation of `subagent.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/subprocess.i18n.yaml
Bilingual-pair hash record for `subprocess.md`: 9 per-heading pairs under `/subprocess`.

### docs/subsystems/subprocess.md
- **Purpose:** the subprocess seam — the shared substrate under bash, LSP, PTY and ACP backends.
- **Key abstractions:** `DshEnvironmentKey`/`DshEnvironment`, `CollectedOutput`, `SubprocessStdinMode`/`SubprocessCollect`/`SubprocessOutputMode`/`SubprocessStdio`, the fully-explicit `SubprocessSpawnSpec`, `SubprocessHandle`, `SubprocessOutputReader`/`SubprocessOutputRead`/`SubprocessCollectedOutputs`, `SubprocessOutcome`.
- **Data flow:** `spawn(spec)` returns a live handle synchronously; collect-mode readers take whole-stream byte offsets; `terminate()` starts the provider's documented procedure and `waitForExit()` observes the same managed range.
- **Non-obvious design decisions:** "The seam applies no defaults: every disposition, limit, and directory is explicit on the spec, so the caller's own config — not a hidden subprocess-service default — decides them" (`subprocess.md:93`). A collect reader is *cursor-free and non-consuming*, "so independent readers cannot steal one another's deltas" (`subprocess.md:186`). `SubprocessOutcome` "deliberately carries NO timeout or cancellation classification (the caller reads the signal it owns to classify causes)" (`subprocess.md:229-234`).
- **Edge cases:** `waitForExit` waits for the managed *range* to be empty, "not just until the spawned command reports its outcome, so surviving work remains observable" (`subprocess.md:167-174`); an inherited descriptor held by a survivor cannot hold the outcome open indefinitely, hence the grace period.
- **Surprising:** in `env`, a string is a deliberate caller opt-in that *survives* the credential scrub, while an explicit `undefined` is a *tombstone* that removes an ordinary ambient value (`subprocess.md:125-131`).

### docs/subsystems/subprocess.zh.md
Chinese translation of `subprocess.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/system-prompt.i18n.yaml
Bilingual-pair hash record for `system-prompt.md`: 5 per-heading pairs under `/system-prompt-assembly`.

### docs/subsystems/system-prompt.md
- **Purpose:** the data exchanged between prompt contributors and one assembly call.
- **Key abstractions:** `AssembleContext`, `ToolProviderResult` (with the pre-restriction `knownNames` set), `PromptSection` (name/order/text/interpolate/complete), `PromptContext` (name/order/text/interpolate/required), `AssembledContext`.
- **Data flow:** `assemble(context)` assembles global and scoped providers, detaches tool parameters, applies canonical ordering, then runs the `system-prompt/assemble` waterfall; agent-loop renders the result with `renderPrompt` and commits it as a `system/message` surface node.
- **Non-obvious design decisions:** `complete: true` "Treat this contribution as the complete system prompt. Assembly still runs the cooperative waterfall so tools, contexts, and variables can be resolved, then restores this exact section as the sole prompt section. More than one effective complete section makes assembly fail." (`system-prompt.md:64-70`) — and the restore happens *after* the waterfall, so listeners cannot add to or replace that scope's prompt (`system-prompt.md:216`). `PromptContext` is explicitly "the cache-safe counterpart" to `PromptSection`: the loop logs its complete snapshot after retained model history only when it changed (`system-prompt.md:76`).
- **Edge cases:** `interpolate: false` preserves literal text including variable-like directory names; `required: true` keeps an operational context when optional runtime context is suppressed; an invalid or duplicate variable name throws at registration, while a provider returning `undefined` only fails at render time (`system-prompt.md:172-176`).
- **Surprising:** `ToolProviderResult.knownNames` exists so a configuration surface can "distinguish a configured-name typo from a known tool that is deliberately hidden in this scope" (`system-prompt.md:28`).

### docs/subsystems/system-prompt.zh.md
Chinese translation of `system-prompt.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/terminal.i18n.yaml
Bilingual-pair hash record for `terminal.md`: 5 per-heading pairs under `/persistent-pty-sessions`.

### docs/subsystems/terminal.md
- **Purpose:** persistent PTY sessions — a live shell the model can drive across turns.
- **Key abstractions:** `TerminalSessionId`, `TerminalWaitReason` (`stdin_read | inferred_idle | timeout | session_exit`), `TerminalSessionStatus`, `TerminalBackend`, `TerminalBackendSession`, `TerminalSendOperation`, `TerminalSendResult`, `TerminalReadResult`.
- **Data flow:** the backend owns how one type starts and detects readiness; the service publishes the session only after setup succeeds, then owns id authorization and cleanup.
- **Non-obvious design decisions:** `TerminalWaitReason` is deliberately independent of `TerminalSessionStatus` — "silence or timeout may return while the top-level shell remains alive, while `session_exit` means that shell exited rather than an arbitrary foreground child" (`terminal.md:11`).
- **Edge cases:** a backend that cannot clean partial startup resources rejects with `TerminalBackendCleanupError`, "allowing disposal to retain the cleanup failure without replacing the caller's cancellation reason" (`terminal.md:27`). Exactly one send may be active per session.
- **Surprising:** PTY state and raw bytes remain process-local; durability rides the existing `tool/call`, `tool/result` and task-result paths "rather than duplicate PTY session events" (`terminal.md:91`).

### docs/subsystems/terminal.zh.md
Chinese translation of `terminal.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/todo.i18n.yaml
Bilingual-pair hash record for `todo.md`: 3 per-heading pairs under `/todo`.

### docs/subsystems/todo.md
- **Purpose:** the durable todo vocabulary — the model-facing tool replaces one agent session's whole list.
- **Key abstractions:** `TodoItem` (`content` + a three-state `status`), the log-only `todo/write` event.
- **Data flow:** the tool writes the complete replacement list; the package owns the event declaration and replay projection.
- **Non-obvious design decisions:** `TodoItem` is "Deliberately minimal … No id, priority, or `activeForm` — the list is replaced wholesale on every write (last-write-wins), so entries need no stable identity" (`todo.md:13-20`).
- **Edge cases:** the three statuses describe "the complete portable lifecycle needed by model and UI consumers"; `in_progress` may mark several tasks at once for parallel work.
- **Surprising:** dropping stable ids is what makes whole-list replacement safe — the opposite of most todo models.

### docs/subsystems/todo.zh.md
Chinese translation of `todo.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/token-meter.i18n.yaml
Bilingual-pair hash record for `token-meter.md`: 3 per-heading pairs under `/token-meter`.

### docs/subsystems/token-meter.md
- **Purpose:** one detached replay snapshot for request pressure and positional surface pricing.
- **Key abstractions:** `TokenMeasurement` (`logRevision`, `baseline`, `surfaceDeltaTokens`, `totalTokens`, `surfaceTokens`, `nodes`), `TokenSurfaceNode` (`tokens` route-priced + `heuristicTokens`).
- **Data flow:** the meter folds the session surface into per-node prices under the measured route; compaction pressure, retention and range selection all read that price.
- **Non-obvious design decisions:** `baseline.kind === 'usage'` only when "the latest successful provider call has the same canonical request envelope and its total is no lower than that call's full route-priced anchor"; `estimated` means no reusable anchor exists (`token-meter.md:29`). Each node carries *both* a route price and a fixed heuristic, and "the shadow-price protocol prices replacements with this value so the O(1) projection fold stays in agreement with its own appends" (`token-meter.md:46-50`).
- **Edge cases:** surface order is authoritative — replacement nodes can have higher durable seqs than later positional nodes (`token-meter.md:54`).
- **Surprising:** `surfaceDeltaTokens` is *signed*, preserving growth and shrinkage relative to a matching anchor by repricing both sides under the same route.

### docs/subsystems/token-meter.zh.md
Chinese translation of `token-meter.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/tools.i18n.yaml
Bilingual-pair hash record for `tools.md`: 7 per-heading pairs under `/tools`.

### docs/subsystems/tools.md
- **Purpose:** the tool registry and its guarded execution pipeline — what every registered tool *is* and how a call reaches it.
- **Key abstractions:** `ToolDefinition` (extends the model-facing `ToolSchema`), `ToolOutputDefinition`, the `ValueSchemaSpec`/`ParameterSchemaSpec` DSL with `InferValue`/`InferArgs`, `ToolRestriction`, `ToolExecutionInput`/`ToolExecution`/`ToolDispatchExecution`/`ToolExecutionToken`, `ToolGuard`, `ToolExecutionResult`/`ToolExecutionSuccess`/`ToolExecutionFailure`/`ToolFailure`/`ToolErrorInfo`, `PreToolDecision`/`PostToolDecision`, `ToolExecutionMode`, `JsonSchemaNode`/`ObjectJsonSchema`, and the card-tagged `ToolCallView`/`ToolResultView` vocabulary.
- **Data flow:** `ctx.tools.execute(input)` materialises and freezes parsed arguments once, then runs pre-execute waterfall → registered monotonic guards → `tools/execute` around-dispatch wrappers → `projectContent` → post-execute waterfall → optional `finalizeContent` → `tools/result`.
- **Non-obvious design decisions:** `ToolGuard` "deliberately has no allow result: `undefined` preserves the waterfall decision, while a returned reason can only reduce permission, so a later listener cannot undo it" (`tools.md:325-336`). The model-facing schema is built by an *explicit allowlist* — "output/execute/projectContent/finalizeContent/timeoutMs/isConcurrencySafe/presentCall/presentResult must never leak into a model request" (`tools.md:11`). Arguments cannot be rewritten by policy: "Arguments cannot be rewritten because history, audit, UI, and execution must agree" (`tools.md:428`). `schemas()` deep-clones each visible tool.
- **Edge cases:** unknown and throwing tools both become structured errors (`ToolNotFoundError` → `UNKNOWN_TOOL`) "so the call fails without ending the turn" (`tools.md:430`); cancellation arriving after entry skips a not-yet-started body with `ABORTED_BEFORE_DISPATCH` or replaces a started success with `ABORTED` (`tools.md:586-590`); a provider failure or renderer failure becomes a JSON-safe `isError` rather than an exception.
- **Surprising:** `InferValue` stays exact through 16 container levels and then widens to `JsonValue` "instead of exhausting TypeScript's type-instantiation stack" (`tools.md:144-152`); `isConcurrencySafe` is fail-closed — only an exact `true` opts in, and "unknown, hidden, undeclared, invalid, or throwing classifiers are exclusive" (`tools.md:573-579`); and the search card carries `truncated`/`total` "so a UI never presents a partial result as complete" (`tools.md:490`).

### docs/subsystems/tools.zh.md
Chinese translation of `tools.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/translation.i18n.yaml
Bilingual-pair hash record for `translation.md`: 5 per-heading pairs under `/text-translation`.

### docs/subsystems/translation.md
- **Purpose:** experimental text translation through anonymous browser endpoints or paid native routes.
- **Key abstractions:** `TranslationProvider`, `TranslationRequest`, `TranslationSpec`, `TranslationError`/`TranslationErrorCode`, the `plugin:translator/request`/`plugin:translator/result` records, `CotTranslationPreferences`/`CotTranslationSnapshot`.
- **Data flow:** `resolve()` captures explicit routing; `translate()` returns plain text; session-bound calls write a request record before external dispatch and a result record before returning.
- **Non-obvious design decisions:** "The translator checkpoints requests before external dispatch and completed results before returning them" (`translation.md:23`), so a crash loses the in-flight translation but not the record of it. A paid cache miss prepares a separate text-only query with thinking off, and its exact config, system and unique user fragment live in the request record's `metadata.modelRequest` (`translation.md:25`).
- **Edge cases:** the error taxonomy separates text limits, HTTP failures, invalid responses, response limits, owned deadlines and request failures; a failed call does *not* silently select another provider; provider diagnostics omit submitted text and response bodies.
- **Surprising:** "Translated text never replaces original Session events or model input", and the unfinished tail of a streaming paragraph stays original (`translation.md:33`).

### docs/subsystems/translation.zh.md
Chinese translation of `translation.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/typert.i18n.yaml
Bilingual-pair hash record for `typert.md`: 7 per-heading pairs under `/typert-remote-calls`.

### docs/subsystems/typert.md
- **Purpose:** the remote-call substrate — generated Remote artifacts, the Host Gateway and the consumer API assemblies.
- **Key abstractions:** `TypertLookupMap`/`TypertContextMap`/`TypertLookupDefinition`, `InvocationDescriptor`/`InvocationParameterDescriptor`, `TypertCodec`, `RemoteStream`/`RemoteStreamHandle`, `PrincipalMap`/`Principal`, `PeerScope`, `RemoteInvocation`, `TypertResourceMap`/`RemoteAccessResource`, `RemoteScopeOptions`/`RemoteMethodOptions`, `TypertRegistryContract`, `InvokeRemoteRequest`, `TypertGatewayErrorCode` (21 codes), `TypertGateway`, `TypertClientRemote`.
- **Data flow:** the Connection decodes the carrier envelope, then `ctx.typertGateway.invoke(request)` resolves the endpoint, resolves resources, asks `ctx.remoteAccess.decide()`, then runs the business method.
- **Non-obvious design decisions:** "The registry retains a lookup's wire declaration after its resolver unloads. SRC discovery therefore continues to classify the parameter as a lookup and fails unavailable instead of accepting the wire value as an ordinary business object." (`typert.md:21`) Cancellation is an out-of-band carrier signal injected *after* business parameters and never enters `args` (`typert.md:41`).
- **Edge cases:** `RemoteInvocation.uplink()` is single-consumer — a second call throws; unread items are dropped when the method finishes its downlink (`typert.md:273-283`).
- **Surprising:** "The readers and these defaults together must name every resource the method accesses: access control never checks a resource they omit." (`typert.md:341`) — the access-control contract is *opt-in by enumeration*, i.e. fail-open for an undeclared resource. Also: the Gateway refuses a disposed Peer with `gateway/peer-disposed` and every structurally identified `RemoteError` passes through with its code and details intact (`typert.md:383`).

### docs/subsystems/typert.zh.md
Chinese translation of `typert.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/user-questions.i18n.yaml
Bilingual-pair hash record for `user-questions.md`: 8 per-heading pairs under `/user-interaction`.

### docs/subsystems/user-questions.md
- **Purpose:** the provider-neutral vocabulary a tool or permission plugin uses when it needs the human to answer before the agent can continue.
- **Key abstractions:** `AskUserQuestionOption`, `AskUserQuestionIntent` (`plan-review` with a named `approve` option), `AskUserQuestionItem`, `AskUserQuestionRequest`/`AskUserQuestionRequestEvent`, `AskUserQuestionAnswerItem`/`AskUserQuestionAnswer`, `TimedUserQuestionResult`, `UserQuestionState` (`open | continued`), `PendingUserQuestion`, `SettledUserQuestion`, `UserQuestionProjectionView`, `UserQuestionError`.
- **Data flow:** agent-scoped waterfall listeners compose the available UI surfaces; a timed answerer claims the wait through `attachWait` and the client counts down with its own clock while the Host holds the original deadline.
- **Non-obvious design decisions:** an intent "changes presentation only, never the protocol" — a UI honouring it answers with the same option labels a generic UI would send (`user-questions.md:26-34`). `approve` names the affirmative option "rather than relying on option order" (`user-questions.md:40`). A late reply moves a continued question into `settled` when its message is admitted, "because that call's own result recorded the timeout, so a transcript row has nowhere else to read what the user finally chose" (`user-questions.md:141`).
- **Edge cases:** "Pending means the question is still answerable; it is not an empty answer, a refusal, a confirmation, or permission" (`user-questions.md:132`). Closing the Client panel sends nothing; continued questions have no deadline. A reply naming a call that is not active changes nothing.
- **Surprising:** an unattended timeout aborts the foreground waterfall's *private* signal and returns pending **without cancelling the Turn** (`user-questions.md:139`).

### docs/subsystems/user-questions.zh.md
Chinese translation of `user-questions.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/voice-input.i18n.yaml
Bilingual-pair hash record for `voice-input.md`: 5 per-heading pairs under `/voice-input`.

### docs/subsystems/voice-input.md
- **Purpose:** experimental speech recognition with the browser owning the microphone and the Host owning the model.
- **Key abstractions:** `SpeechProviderId`, `SpeechProviderInfo`, `SpeechRequest`/`SpeechSpec`, `SpeechInput`/`Transcript`, `TranscriptionRequest`, `SpeechCatalog`, `SpeechPreparationState`/`SpeechPreparationStep`, `SpeechDownloadFailure`.
- **Data flow:** the browser captures PCM16 WAV → sends it through the authenticated Remote → the Host resolves a provider and transcribes → the client inserts the transcript into the draft.
- **Non-obvious design decisions:** "The input facade captures a revision-bearing selection before recording. `InputActions.insertText()` inserts one undoable plain-text edit only while the selection revision is current" (`voice-input.md:17`) — a late result cannot clobber text the user typed since. Recognition writes no Session event; "ordinary user submission owns the final model-visible text" (`voice-input.md:17`).
- **Edge cases:** switching Sessions or disposing the plugin invalidates late results; a rejected insertion leaves the transcript available for explicit insertion; "Audio never falls back to a different provider" (`voice-input.md:9`).
- **Surprising:** closing an observer never cancels preparation, and the collapsed UI shows only the current operation while expanding lists all steps (`voice-input.md:23`).

### docs/subsystems/voice-input.zh.md
Chinese translation of `voice-input.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/web-client.i18n.yaml
Bilingual-pair hash record for `web-client.md`: 11 per-heading pairs under `/web-client-architecture`.

### docs/subsystems/web-client.md
- **Purpose:** the browser-side Cordis application — four reusable foundations (Client Modules, API Gateway, Slots, Conversation) and where feature packages belong.
- **Key abstractions:** the six-layer ownership table; `ClientSessions → SessionManager → Session`; `ClientWorkspaceModel`; `SessionEventLikeEntry`.
- **Data flow:** durable Session display runs Host log → packed Remote `follow`/`page` history → Client `SessionEventLikeEntry` window → Conversation Contexts → target snapshot → Slot view → React; the page publishes six such paths as a table (`web-client.md:68-76`).
- **Non-obvious design decisions:** the dependency direction is strictly one-way (Host state → Remote transport → Client model → UI adapter → Conversation → Slots → React) and "A presentation component never receives Cordis `ctx`, a transport object, or another feature plugin's implementation" (`web-client.md:20`). "There is no monolithic Client `Runtime`, `HostFrame`, `events.mux`, `events.host`, or universal `resync()` API" — each client model defines its own replacement or resume semantics (`web-client.md:87`).
- **Edge cases:** physical and logical recovery are separate; a carrier failure is retryable while a business error, malformed opening item or protocol violation is terminal for the owning logical stream (`web-client.md:79`). Ordinary forwarded notifications are *not* replayed.
- **Surprising:** archived rows retain their ordering slots and render grayed but cannot open until restored, and unpinning does not restore an earlier position (`web-client.md:52`).

### docs/subsystems/web-client.zh.md
Chinese translation of `web-client.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/web-server.i18n.yaml
Bilingual-pair hash record for `web-server.md`: 4 per-heading pairs under `/http-server`.

### docs/subsystems/web-server.md
- **Purpose:** the browser HTTP carrier — one `node:http` server with a named-route registry.
- **Key abstractions:** `WebRouteKind` (`exact | prefix`), `WebRoute`, `Config` (host/port/tls/compression), `TlsConfig`.
- **Data flow:** match order is fixed — exact table, then longest matching prefix, then the registered fallback; "Registration order carries no request-facing semantics" and the fallback seat answers anything no named route claims, with one owner only (`web-server.md:27`).
- **Non-obvious design decisions:** the unspecified address is *rejected at load* — "it would expose the port on every interface at once" (`web-server.md:42-43`). The TLS pair is read once before the listener binds; an unreadable or mismatched pair rejects initialization "rather than falling back to HTTP" (`web-server.md:51-54`).
- **Edge cases:** a request whose handling throws is answered 400 (or the socket destroyed when headers are out), "never a process exit". Disposal pairs `close()` with `closeAllConnections()` "because a handler may hold its response open (SSE) and such connections never end on their own; without the force-close, teardown would hang" (`web-server.md:86`).
- **Surprising:** a duplicate `(kind, path)` throws because "route patterns are a composition-level contract and a collision is a misconfiguration".

### docs/subsystems/web-server.zh.md
Chinese translation of `web-server.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/web.i18n.yaml
Bilingual-pair hash record for `web.md`: 8 per-heading pairs under `/web-access`.

### docs/subsystems/web.md
- **Purpose:** one `ctx.web` middle layer carrying two operations — search and fetch.
- **Key abstractions:** `WebSearchRequest`/`WebSearchResult`/`WebSearchSource`, `WebFetchRequest`/`WebFetchResult`, the closed `WebFetchBody` union, `WebError` (an *open* code set).
- **Data flow:** providers register capabilities, not tools; the model-facing names, schemas, prompt guidance and presentation all live in the single consumer.
- **Non-obvious design decisions:** search and fetch "share no request schema and no business logic, but they are deliberately one `ctx.web` middle layer: one provider-selection policy owner, one abort/error vocabulary, and one product-facing configuration API" (`web.md:11`). Provider `available()` "is a cheap LOCAL check … and **must not make network calls**" (`web.md:123`). The HTTP provider "resolves each actual request, rejects non-public answers including private IPv4 reached through the active DNS64 prefix, pins the validated address set, and repeats enforcement for each same-origin redirect" (`web.md:131`).
- **Edge cases:** a successful fetch of a 404/500 is a *result*, not an error — "HTTP status is part of the fetched resource state" (`web.md:85`). Multiple usable providers with no configured id is `WEB_PROVIDER_AMBIGUOUS`, "not first-wins" (`web.md:125`). A cross-origin redirect "requires a new tool call and fresh public-address validation".
- **Surprising:** the error code set is deliberately **open**, unlike the closed unions elsewhere — "a provider may raise its own codes without editing `dsh-web`, and consumers must tolerate an unknown code" (`web.md:135`).

### docs/subsystems/web.zh.md
Chinese translation of `web.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/webhook.i18n.yaml
Bilingual-pair hash record for `webhook.md`: 5 per-heading pairs under `/webhook-runtime`.

### docs/subsystems/webhook.md
- **Purpose:** turn authenticated external deliveries into optional ordinary root Sessions.
- **Key abstractions:** `WebhookRuleId`/`WebhookSourceId`/`WebhookDeliveryId`, the merge-extensible `WebhookEventMap`, `VerifiedWebhookDelivery`, `WebhookRule`, `WebhookSessionRequest`.
- **Data flow:** `dispatch()` snapshots matching rules, schedules each independently and returns before any callback settles; a non-null result is snapshotted before asynchronous preflight, then the runtime creates an Agent whose Session cwd equals the Workspace path, mounts the preset before publication, durably attaches the Session and applies permission, title and the initial follow-up.
- **Non-obvious design decisions:** "The runtime has no queue, retry, deduplication, execution status, crash replay, Agent-status listener, or completion result. Repeated delivery may create repeated Sessions." (`webhook.md:23`) The commit point is the accepted inbox insertion of the follow-up.
- **Edge cases:** failed attachment disposes the new Agent before a prompt exists; a failure between attachment and prompt admission attempts Workspace detach and Agent disposal "without replacing the original error"; an auto-created Workspace remains because another concurrent caller may already use it (`webhook.md:31`).
- **Surprising:** the GitHub adapter mounts on an **isolated second WebServer** "so exposing webhook ingress does not expose the browser API" (`webhook.md:37`).

### docs/subsystems/webhook.zh.md
Chinese translation of `webhook.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/workflow.i18n.yaml
Bilingual-pair hash record for `workflow.md`: 8 per-heading pairs under `/workflow`.

### docs/subsystems/workflow.md
- **Purpose:** let an agent run a model-written orchestration script that starts subagents.
- **Key abstractions:** `WorkflowStartRequest`, `WorkflowMeta`, `WorkflowResult`, `WorkflowRun`, `WorkflowError.fatal`, the `workflow/*` events.
- **Data flow:** the script's `agent()` calls are dispatched through the subagent seam; the script's return value is materialised as `WorkflowResult.value`; the consumer projects display facts into the parent Session through `tool-workflow/run-start`/`run-end`.
- **Non-obvious design decisions:** `meta` and `args` are plain JSON *data* validated before anything runs — "no script text is ever evaluated to obtain it" (`workflow.md:13`). "The `parallel()`/`pipeline()` combinators RE-THROW fatal errors instead of mapping the item to `null`: a typo'd option must kill the script loudly, never dissolve into something that reads as an ordinary child failure" (`workflow.md:116`).
- **Edge cases:** `result` never rejects — script failure resolves with `stopReason:'error'` and cancellation with `'cancelled'`. `agentsStarted` degrades to a host-observed count on a termination path because "calls queued inside a terminated script are unknowable then" (`workflow.md:83-88`).
- **Surprising:** the `workflow/*` events are observe-only and carry **data snapshots** — never the live `WorkflowRun`, so a subscriber cannot gain `cancel`/`dispose`, and `workflow/end` deliberately omits the result value so "a listener observing outcomes must not receive a mutable alias of the caller's result" (`workflow.md:120`).

### docs/subsystems/workflow.zh.md
Chinese translation of `workflow.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/working-directory.i18n.yaml
Bilingual-pair hash record for `working-directory.md`: 3 per-heading pairs under `/working-directory`.

### docs/subsystems/working-directory.md
- **Purpose:** a Session's active directory — distinct from the immutable header's original project.
- **Key abstractions:** the `working-directory/change` event; `ctx.workingDirectory.get/ensure/set`.
- **Data flow:** `set(agent, path)` validates and records a requested change; `ensure(agent)` validates the logged value and restores the original project when the directory disappeared; the initial and current values reach the model as required user-context snapshots.
- **Non-obvious design decisions:** "Changes are local to one Session … Existing terminals and persistent shells retain their own directories. Sandbox writable roots and project membership remain anchored to the original project." (`working-directory.md:11`) Directory context "never enters the system prompt" (`working-directory.md:15`).
- **Edge cases:** a committed change queues a notice through the ordinary Agent inbox; cancellation or disposal can discard the notice before request admission — but "the directory event survives, and the next admitted request receives the current value".
- **Surprising:** the `required` flag means the snapshot is delivered "even when optional runtime context is disabled" (`working-directory.md:15`).

### docs/subsystems/working-directory.zh.md
Chinese translation of `working-directory.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/workspace.i18n.yaml
Bilingual-pair hash record for `workspace.md`: 8 per-heading pairs under `/workspaces`.

### docs/subsystems/workspace.md
- **Purpose:** the persistent record of a directory the user works in — a stable id over a canonical path plus an ordered account of its sessions.
- **Key abstractions:** `WorkspaceId` (a generated uuid, never the path), `Workspace` (`path`/`title`/`createdAt`/`updatedAt`/`sessionIds` + `setTitle`/`attachSession`/`insertSessionBefore`/`detachSession`/`status`), `WorkspaceRegistry`, `SessionActivityKindMap`/`SessionActivity`, the `workspace/session-activity` waterfall and `workspace/session-stop` parallel event.
- **Data flow:** the API gateway resolves a new session's cwd from the chosen workspace, creates the session so the cwd lands in its immutable `SessionHeader`, then calls `attachSession`, which re-validates the stored header cwd against the workspace path.
- **Non-obvious design decisions:** "Ownership truth is the record's ordered `sessionIds`, never derived from session cwd" (`workspace.md:120`). Path identity is `realpathNormalize` — "path normalization rewrites paths, and a reference anchor must stay stable" (`workspace.md:14`). Create and delete persist a pending-mutation marker before their two writes, and startup resolves exactly the marked mutation, rolling back an interrupted *create* because "the registration is re-creatable, so rollback is the safe direction" (`workspace.md:124`).
- **Edge cases:** an existing candidate remains owned when its fully qualified cwd fails resolution with ENOENT — preserving missing-directory and dangling-symlink accounts "without admitting new sessions"; other filesystem failures do not (`workspace.md:56-61`).
- **Surprising:** archiving refuses to hide running work — the registry asks a waterfall what still runs for a Session and rejects with `WorkspaceActiveSessionError` (`workspace.md:167`); `delete(id)` never touches the directory, user files, live sessions or persisted logs, so those sessions become Ungrouped.

### docs/subsystems/workspace.zh.md
Chinese translation of `workspace.md`; heading parity confirmed, code blocks left in English.

### docs/subsystems/worktrees.i18n.yaml
Bilingual-pair hash record for `worktrees.md`: 3 per-heading pairs under `/git-worktrees`.

### docs/subsystems/worktrees.md
- **Purpose:** experimental Git branch + checkout creation under existing permissions.
- **Key abstractions:** `CreateWorktreeRequest` (name + local revision only), `CreatedWorktree` (`path`/`branch`/`baseCommit`/`repositoryRoot`).
- **Data flow:** `create_worktree` creates the branch and checkout, then selects it through the working-directory service; "Successful Git setup precedes the working-directory change" (`worktrees.md:11`).
- **Non-obvious design decisions:** creation "pins the requested local commit, branch, or tag before allocating the checkout" and "neither fetches missing objects nor copies staged, unstaged, untracked, or ignored files from the source checkout" (`worktrees.md:9`). The service writes a `.gitignore` containing `*` "only when its allocation creates the configured pool directory", preserving existing files and ignore rules.
- **Edge cases:** cancellation or failure can retain partial artifacts, and "the error identifies their location".
- **Surprising:** a linked checkout contains its own pool, and leaving through `working_directory({cd})` retains both the checkout and the branch.

### docs/subsystems/worktrees.zh.md
Chinese translation of `worktrees.md`; heading parity confirmed, code blocks left in English.

---

## Ideas worth stealing

1. **A tool guard that can only reduce permission, never grant it** — `docs/subsystems/tools.md:325` (and the pipeline at `tools.md:182`). `ToolGuard` returns `string | undefined`: `undefined` preserves the waterfall decision, a string denies. The doc states the reason outright — "Because guards have no allow result, listener ordering cannot turn a denial back into permission." *Why it transfers to August*: August's August-proxy harness gates every tool call through policy code that a model can sometimes influence. Making the guard type incapable of returning "allow" removes a whole class of ordering bug (a later listener re-granting what an earlier one denied) without needing a priority system or a second registry.

2. **Make the model request a pure function of the durable log, and keep the system prompt OUT of the request header** — `docs/subsystems/llm-streaming.md:761` and `docs/subsystems/session.md:183`. The rendered prompt is derived history — surface node 0, plus any later in-history system node — so "a prompt change replaces or appends a system node and leaves the header unchanged". *Why it transfers*: this is exactly the prefix-stability property August needs from a provider that caches on a literal prefix. If the system prompt is a request *field*, every prompt edit invalidates the whole cached prefix; if it is a message slot, only the tail changes. August's frozen-boot-memory-index rule ("the boot memory index is frozen per session to protect the provider prefix cache") is a special case of this generalisation, and the in-history append rule (`llm-streaming.md:544`) is the general form.

3. **Disjoint token accounting, with the provider's folded total subtracted back out** — `docs/subsystems/llm-streaming.md:336`. `inputTokens` is uncached input only; cache reads and writes are reported separately; billed input is the sum of the three; adapters whose provider folds cache hits into one number (DeepSeek's `prompt_tokens`) subtract them out. *Why it transfers*: August bills per model and shows a per-turn cache chip. A single "prompt tokens" number cannot distinguish a cheap cached turn from an expensive fresh one, and once the two are conflated no cache-hit-rate metric can be computed from the provider's own report.

4. **Canonical error codes for the two failures that must never be misrouted** — `docs/subsystems/llm-streaming.md:303-304`: context overflow has ONE canonical code surfaced whether the failure arrives as a thrown HTTP error or an in-band finish, and "an empty completion is a retryable error, not a silent success" (`EMPTY_RESPONSE`). *Why it transfers*: August has exactly the bug class where a provider's 400 arrives in two shapes and one branch handles only the thrown form, so a context-overflow gets retried as a generic error until the transcript dies. One canonical code, produced at the final adapter boundary, means every downstream consumer (retry policy, compaction trigger, budget ladder) can route on the code instead of parsing text — the same discipline August already needed for `classify_error`.

5. **One keep/drop decision covers content and its metadata together** — `docs/subsystems/llm-streaming.md:368`. A `max-tokens` finish drops every tool call (a truncated call is unsafe to execute), and the *same* decision prunes the replay envelope's per-block entry at each dropped position, so `blocks()` and `replayState` cannot disagree. *Why it transfers*: August persists both the assistant text and provider-private replay state. If a truncation path drops a block from one and not the other, a later request replays metadata describing content that is no longer there — the classic "history looks fine until you resend it" bug.

6. **Keep the assistant's interrupted prefix, but omit its undispatched tool calls** — `docs/subsystems/session.md:82-85` and `llm-streaming.md:398-402`. A turn cancelled mid-stream finalises its delivered text/reasoning as `assistant/message` with `interrupted: true`; `interruptedBlocks()` omits tool calls "because interruption precedes dispatch; retaining one would require a fabricated result". *Why it transfers*: August's stop/cancel paths currently risk either losing the user's partial answer or emitting a `tool_call` with no matching `tool_result` — which is precisely the "orphaned `tool_use_id` surviving into persisted history bricked the chat" failure the August notes describe. The rule "never persist a tool call without its result" is a one-line invariant this design makes structural.

7. **The compaction lock is released LAST, so a crash is a detectable orphan** — `docs/subsystems/compaction.md:19`. `compaction/start` is appended first and `compaction/end` only after the summary and the surface replacement have landed. *Why it transfers*: this inverts the usual bracket (open … close) which a crash leaves looking *open*. Releasing last means a crash mid-compaction leaves a `start` with no `end` — an unambiguous "incomplete" marker — rather than an `end` that falsely claims compaction finished. August's own context-relief paths would benefit from the same bracket discipline, and the same shape generalises to any long-running durable operation.

8. **A compaction's shadowed range is a POSITION span, not a numeric seq interval** — `docs/subsystems/compaction.md:60-66`. After a prior replace lands a fresh high-seq summary node at an older range's position, `start` can be *greater* than `end`. The authoritative set is `shadowedSeqs`. *Why it transfers*: any August feature that replaces a range of history (context relief, turn folding, a "summarize this turn" tool) will hit the same inversion, and code that assumes `start <= end` will silently truncate or double-count. The doc's fix — carry the explicit ordered seq list and treat the numeric pair as advisory — is cheap to adopt.

9. **Subagent settlement is a DIFFERENT message kind from a subagent-authored message** — `docs/subsystems/subagent.md:190-196`. `AgentMessageSource` is content the sender chose; `SubagentSettledMessageSource` is "the manager stating what became of the child". The stated reason: "a transcript that merged them would credit the child with words it never wrote." *Why it transfers*: August's agent-team/room transcripts collapse bot turns. Merging a machine-authored settlement into the same source as a model-authored relay would let a reader attribute a summary to the child that produced it — which is exactly the mis-attribution August's `BOT_TURN_PREFIX` machinery works to prevent on the inbound side.

10. **The subagent stop-reason vocabulary mirrors the turn-end vocabulary** — `docs/subsystems/subagent.md:268-287`. The known cases (`completed`, `aborted`, `error`, `max-tokens`, `refusal`) mirror the harness's own turn-end reasons "so the tool layer can map a non-`completed` result to an `isError` tool result". *Why it transfers*: August's delegation tools currently need a translation table between "the child failed" and "the parent's tool result is an error". Sharing one closed vocabulary removes the table and makes every parent-side policy (retry, budget, escalation) work unchanged on a child result.

11. **A provider's `available()` must be a cheap LOCAL check and must not make network calls** — `docs/subsystems/web.md:123`, with the selection rule at `web.md:125`: an explicit provider id, or auto-select when exactly one usable provider is registered; multiple usable providers with no configured id is `WEB_PROVIDER_AMBIGUOUS`, "not first-wins". *Why it transfers*: August has several providers (LLM, web, browser, computer-use) and "first registered wins" makes behaviour depend on plugin load order, which changes on HMR. Making ambiguity a loud error plus a local-only health check means a provider's health is never a network round-trip inside a selection loop.

12. **Check runner failure BEFORE denial, and keep the denial dialect per-backend** — `docs/subsystems/sandbox.md:134-148`. A consumer must match only *this* backend's stderr substrings ("the union claims denials a given backend never produces"), and must first establish that the runner failed (command never ran) rather than that confinement denied it (command ran and was blocked). *Why it transfers*: August's sandbox/ACL layers sit on Windows, macOS and Linux with different denial texts. A cross-platform union produces false "policy denied" reports for ordinary command failures — which then get logged as policy violations and make the real denial invisible.

13. **A capability that cannot enforce a deadline should not accept one** — `docs/subsystems/filesystem.md:274`. File IO takes no `timeoutMs` and arms no deadline, "because a timeout could not force an in-progress `fsync`/`rename` to stop, so a `timeoutMs` here would be a deadline the seam cannot enforce, and an implicit default in the exact place explicit-over-implicit forbids". Contrast with bash and the subprocess-backed glob/grep, which *do* take a `timeoutMs` because a deadline can really kill the work. *Why it transfers*: August's file tools and shell tools share a tool schema builder. Applying the same "timeout only where the substrate can honour it" rule stops August from advertising a timeout it cannot enforce — a promise that silently fails exactly when it matters.

14. **An intent changes presentation only, never the protocol** — `docs/subsystems/user-questions.md:26-34`, and the same rule at `permission-presets.md:55` (a derived `custom` value may be displayed but is "never a switch target or an event payload"). *Why it transfers*: August's UI keeps growing rich variants of the same interaction (plan review, permission selection, a timed ask). Encoding the variant as a *tag* on the same payload, so every consumer that ignores the tag still sends the identical answer, means a new UI variant can be added without a coordinated protocol change on every backend.

15. **A "pending" answer is a first-class state, not an empty answer** — `docs/subsystems/user-questions.md:132`. `TimedUserQuestionResult` is `{pending: true, callId}`, and the doc is explicit: "Pending means the question is still answerable; it is not an empty answer, a refusal, a confirmation, or permission." The timeout aborts the foreground waterfall's *private* signal and returns pending **without cancelling the Turn**. *Why it transfers*: August has timed interactions and unattended runs. Collapsing "timed out" into `null`/empty makes the model read it as a refusal, which then changes the plan; a distinct pending state that keeps the question answerable (and keeps the turn alive) is the difference between a slow answer and a wrong answer.

16. **Approval policy `never` is enforced inside the service, before the answerer waterfall** — `docs/subsystems/approval.md:86`. "The `never` policy is enforced inside the service before waterfall dispatch, so even an answerer registered later with `prepend` cannot bypass it." *Why it transfers*: August has several approval-ish paths (permission presets, sandbox escalation, one-shot wider retries). Any policy that is only enforced by the *dispatch order* of listeners is one `prepend` away from being bypassed. Enforcing the deny at the service boundary makes the policy unbypassable by construction — the same "monotonic" instinct as the tool guard in idea 1.

17. **The approval request omits the tool arguments on purpose** — `docs/subsystems/approval.md:53`. "`callId` links to an already-presented tool call, so arguments are not duplicated here." *Why it transfers*: August's approval UI is rendered next to a streamed tool call. Re-sending the arguments in the approval payload creates a second copy that can drift from what was actually executed — the approver sees one thing and the harness runs another. Carrying only a correlation id removes the drift by construction.

18. **A durable version token is equality-only and replaced by every material mutation** — `docs/subsystems/feedback.md:32-33` and `docs/subsystems/goal.md:9`. *Why it transfers*: August's brain rows and settings writes have optimistic-concurrency fields whose semantics are often unclear ("version" as a number to increment vs. a token to compare). One rule — equality-only token, replaced wholesale on any material change — makes stale-write detection mechanical and makes replay trivial.

19. **A projection unit must return the SAME state reference when it is uninterested in an event** — `docs/subsystems/session-projection.md:38-44`. "an unchanged reference (`Object.is`) produces zero downstream work." *Why it transfers*: August folds session events into derived views (todos, goals, budget counters, projections) on every append. Returning a fresh object each time turns every event into a full re-render and a full re-serialisation. The `Object.is` contract plus a `stateVersion` invalidation counter (`session-projection.md:60-66`) is a two-line mechanism that makes derived state cheap *and* safely cacheable.

20. **The write order is: durability → memory → notification** — `docs/subsystems/storage.md:126` and `docs/subsystems/storage.md:153`. A rejected backend write leaves memory untouched "so reads never diverge from the medium"; the `domain/changed` event is a notification, not a transaction participant, so a throwing listener is contained with a warning rather than rejecting the already-durable write. *Why it transfers*: August's own notes call out this exact hazard class (a durable write that later fails in a listener looks like a failure and gets retried, duplicating the write). Ordering the three steps explicitly and saying which of them may fail is the mechanism.

21. **A contract with no rules of its own exports exactly what it captured** — `docs/subsystems/session-telemetry.md:144`: "The seam ships NO rules of its own: with no listener mounted, records reach the backend exactly as captured, so exported data is precisely as clean as the rules a deployment mounts." *Why it transfers*: August's telemetry/redaction story currently lives in one implementation. Making the *seam* rule-free and pushing redaction into a waterfall means the default behaviour is "everything, unmodified", which is honest, and a deployment that mounts no rules gets a visible, intentional posture rather than an accidental one.

22. **The host decides a unique business id before the UI writes any code** — `docs/subsystems/conversation.md:58`. "the client must never assign an update to 'the latest unfinished' Context." The same file then makes the claim order-independent by evaluating every match before accepting any (`conversation.md:250`), keeps update-only contexts *pending* until their start arrives (`conversation.md:70`), and states a hard performance budget: with `D` definitions one event costs `D` matches and a constant-time lookup, and "Definition code must preserve that property" (`conversation.md:284`). *Why it transfers*: August's chat timeline renders tool calls, subagent activity, todos and compaction notices from the same log. Adopting "the producer owns the id" plus "all matches are evaluated before any claim" removes the class of bugs where one row's update lands on another's card.

23. **Distinguish "the runner never ran" from "confinement blocked it"** — `docs/subsystems/shell.md:111-133` (orthogonal outcome fields) and `docs/subsystems/shell.md:121` (timedOut vs aborted are mutually exclusive first-cause fields). A process can both time out AND exit 0 because it trapped the signal; `timedOut` and `aborted` are exclusive because one fused deadline drives both and a race reports the single first-abort cause. *Why it transfers*: August's process tools and its turn budget both need to distinguish "the model ran out of wall clock" from "the user pressed stop" from "the provider gave up". One field per cause, never a bitmask, and the first-cause rule, makes the receipt honest.

24. **A producer's `done` resolves after resources are released, not when work finishes** — `docs/subsystems/jobs.md:163-166`, with `producerReported` explicitly *not* certifying resource release (`jobs.md:60-61`). *Why it transfers*: August runs background work whose output the model reads later. A job that reports "done" while its subprocess is still alive produces a receipt the model trusts and a process that outlives the turn. Making the release part of the completion contract (and making the flag's limits explicit) fixes both.

25. **A missing settlement stays missing** — `docs/subsystems/jobs.md:31`: "A missing `job/settled` remains incomplete even if the live registry reported termination; consumers must not invent a finish timestamp." *Why it transfers*: August's August-proxy sidecar kills sessions and processes on shutdown; a consumer that synthesises a completion from an in-memory view will report work as finished that never reached storage. Naming the asymmetry explicitly in the contract prevents the reader from "fixing" it later.

26. **The next-occurrence rule must not depend on ambient time-zone state** — `docs/subsystems/schedule.md:121`: "Successful creation stores only canonical UTC `scheduledAt`, so replay never depends on ambient time-zone state." Combined with the cron canonicalisation that preserves each field's *star flag* so day-of-month/day-of-week stays Vixie-faithful (`schedule.md:165-169`), and DST gap/overlap rules stated once (`schedule.md:138`). *Why it transfers*: August's reminder/schedule feature (and any "run this at 9am" intent) inherits the same three problems — DST, replay, and cron semantics. Storing only a canonical instant and keeping the *rule* separately normalised is the pattern that survives a restart.

27. **The tool surface is built by an explicit allowlist, not by omission** — `docs/subsystems/tools.md:11`: `schemas()` builds the model-facing `ToolSchema[]` from an allowlist, and "output/execute/projectContent/finalizeContent/timeoutMs/isConcurrencySafe/presentCall/presentResult must never leak into a model request". *Why it transfers*: August's tool definitions carry host-only fields (timeouts, concurrency classifiers, presentation callbacks, private paths). An allowlist means a new host-only field is *never* exposed by accident; a denylist means it is exposed until someone notices.

28. **Tool arguments cannot be rewritten by policy** — `docs/subsystems/tools.md:428`: "Arguments cannot be rewritten because history, audit, UI, and execution must agree." The `PreToolDecision` union has no rewrite arm at all, so the compiler prevents it. *Why it transfers*: August's August-proxy has a pre-tool hook surface. If a policy can rewrite arguments, the logged call, the UI card, the audit row and what actually executes can be four different things. Encoding the ban in the *type* rather than in a comment is the transferable part.

29. **Presentation callbacks must be pure and side-effect-free because they run during live streaming AND during replay** — `docs/subsystems/tools.md:88-93`. `presentCall`/`presentResult` "must depend only on `args`". *Why it transfers*: August renders tool cards from a live stream *and* re-renders the same card from the persisted log on reload. A presenter that touches mutable state produces a card that changes between the two renders — the "reloaded transcript looks different" bug.

30. **Cross-session coordinates keep their original generation** — `docs/subsystems/session-reference.md:73`: "Their durable source records keep `capturedThroughSeq` as a coordinate in the referenced Session's original generation; they never reinterpret it as a seq in the containing Session." *Why it transfers*: August's "recall from another session" feature (and any context handoff between agents) will compact the source session; if the seq is reinterpreted in the destination's numbering, the pointer silently points at the wrong message. Carrying the format version alongside the seq (`capturedFormatVersion`) is the other half of the fix.

31. **A request's tool list is an allowlisted projection and a failed refresh keeps the previous generation** — `docs/subsystems/mcp.md:54` ("A failed refresh retains the previous tool generation") and `docs/subsystems/tools.md:11`. *Why it transfers*: August's tool registry is refreshed at runtime (dynamic plugins, per-scope restrictions). Retaining the last good generation on a refresh failure means a transient error never leaves the model with an empty tool list — which it would read as "no tools available" and answer accordingly.

32. **A deterministic request version, cached and singleflighted** — `docs/subsystems/attachment.md:170`. `readImageRequest()` derives and caches one deterministic request version at a route-chosen target; the local implementation "lazily encodes preferred candidates, singleflights equal request identities, lets each waiter cancel independently, stops shared work when no waiter remains, and bounds all transforms with its instance-level limiter, which defaults to two simultaneous transformations". *Why it transfers*: August's image/attachment path has the same shape (encode, resize, upload) and the same three failure modes (duplicate work, one cancelled waiter killing the shared job, unbounded parallel encodes). The singleflight-with-independent-waiters pattern plus a concurrency limiter is directly reusable.

33. **A capability seam splits into Definition / Provider / Consumer, and the Consumer owns the model-facing surface** — `docs/subsystems/web.md:11`, `docs/subsystems/mcp.md:41`, `docs/subsystems/subprocess.md:5`. Providers register *capabilities*; the model-facing names, schemas, prompt guidance and presentation live in one consumer. *Why it transfers*: August's provider surface (LLM adapters, web providers, browser providers) currently leaks provider names into tool schemas. Centralising the model-facing vocabulary in one consumer package means a provider swap changes nothing the model sees — and August already relies on this for its `/v1` adapters.

34. **A closed union of event types with a plugin extension path that does NOT use `assertNever`** — `docs/subsystems/session.md:292`: "Because `SessionEventMap` is merge-extensible, switches over `SessionEvent` must NOT use `assertNever` — a plugin-added variant is a valid unknown value; handle the known cases and fall through `default`." Contrast with the *closed* `StreamChunk` union, which does end in `assertNever` so adding a variant breaks every consumer (`docs/subsystems/llm-streaming.md:169`). *Why it transfers*: August needs to know which unions are safe to extend. The doc makes the distinction explicit and gives the rule for each — extendable maps fall through, closed unions break at compile time. That is a vocabulary August can adopt verbatim.

35. **A reader that meets an unrecognized event must REFUSE to reconstruct rather than silently drop it** — `docs/subsystems/session.md:274-282`. The `ignorable?: true` marker is opt-in and defaults to required, "because an unrecognized required event may change how the rest of the log is interpreted … defaulting to required means a forgotten marker over-refuses (an inconvenience) rather than silently resuming a gutted session." *Why it transfers*: August's persisted session format will accumulate event types from plugins. A silent skip turns "one unknown event" into "the transcript is subtly wrong and nobody knows why". The asymmetry — over-refuse rather than under-refuse — is the transferable decision.

36. **A crash mid-turn is repaired by the READER, not by truncating the log** — `docs/subsystems/persistence.md:110`. Persistence returns the physically valid contiguous log; repair computes `interruptedTurnClosers` (missing tool errors, an open `step/end`, and a synthetic `turn/end {reason:{kind:'interrupted'}}`) and appends them through the same write handle. The reason given: "a single turn can be huge in a long-horizon task … and those events were durably appended before the crash." *Why it transfers*: August's crash recovery currently risks either dropping the whole turn (losing the model's work) or leaving a dangling tool call (poisoning the next request). The "append closers, keep the events" rule gives both safety and preservation.

37. **The format refusal is a distinct error from corruption** — `docs/subsystems/persistence.md:189`. `SessionFormatUnsupportedError` is separate from `SessionPersistenceCorruptionError` "because nothing is damaged". A future highest generation refuses even when an older readable generation remains, and the message names the raw log path so a user can find what a build refused to interpret. *Why it transfers*: August upgrades its session format. Conflating "too new for this build" with "corrupt" leads to the wrong remediation — a user deleting a perfectly good log because the app said "corrupt".

38. **Durable metadata whose runtime-only version would silently reset a budget** — `docs/subsystems/persistence.md:171-183`. `delegationDepth` is persisted "so a recursion budget survives restart and resume — a runtime-only depth would reset a resumed child to top-level"; `agentPreset` is durable "because a resume that restored a different composition would replay history the model can no longer act on". *Why it transfers*: August has delegation-depth and agent-preset concepts of exactly this shape, and the failure mode (a restarted child silently becoming a root) is invisible until a runaway happens.

39. **A listing read must not become a body scan** — `docs/subsystems/persistence.md:325`: "Session listing does not use either field to open cold logs: it reads headers plus identity-checked projection-cache hints only, so a cache or Session-format upgrade never turns startup into a body scan." Plus the lightweight revision token that lets a derived read model compare a cheap opaque value before loading a full log (`persistence.md:294-296`). *Why it transfers*: August's session list is on the hot path of every UI start. A format or cache change that turns listing into a full log read is a startup regression that only shows up with a large corpus.

40. **A hard rule that a component never receives the framework context** — `docs/subsystems/slots.md:79`: "Components never receive `ctx`." Owner point-in-time values arrive through the owner argument, shared state through a declared store, services stay in the `apply` closure and are projected into callbacks. *Why it transfers*: August's React layer already fights this. Declaring it as a typed boundary (owner props vs `inject` vs `store`) is what makes a slot registry possible at all.

41. **The web server refuses to bind every interface at once, and the TLS pair is read once** — `docs/subsystems/web-server.md:42-43` and `:51-54`. The unspecified address is rejected at load; an unreadable/empty/mismatched TLS pair rejects initialization "rather than falling back to HTTP". *Why it transfers*: August ships a local server. A silent fallback from HTTPS to plain HTTP on a bad certificate is a security-relevant downgrade that most code does not guard.

42. **A teardown must force-close connections a handler is holding open** — `docs/subsystems/web-server.md:86`: disposal pairs `close()` with `closeAllConnections()` "because a handler may hold its response open (SSE) and such connections never end on their own; without the force-close, teardown would hang." *Why it transfers*: August's server has SSE/streaming routes. A shutdown that waits for them hangs forever, which looks like a stuck app rather than a missing force-close.

43. **A revision derived from `mtime`/`ctime`/`size` instead of hashing content** — `docs/subsystems/client-modules.md:88`: revisions come from file metadata "without hashing executable bytes", and "the same artifacts retain their revisions across Host restarts". *Why it transfers*: August rebuilds client bundles constantly. Hashing every bundle on every change is O(bytes); metadata is O(1) and — because ctime catches writes that preserve mtime — still correct.

44. **A protocol's identifier grammar is portable across languages, and the reserved set is global** — `docs/subsystems/ptc-runtime.md:141-152`: binding globals must match a language-portable identifier subset "so the same namespace list works against every backend regardless of `language` — a JS-only spelling like `$tools` is rejected by design, not just by the Python backend". Backend-owned slots (`console`, `__dsh_main__`) are reserved *everywhere*. *Why it transfers*: August's code-mode / PTC-style tool namespaces have the same portability requirement, and the same trap: a name that is legal in one runtime silently breaks another.

45. **The provider's own knowledge is the better answer than a network call** — `docs/subsystems/llm-streaming.md:722-726`: a route whose adapter already knows its models "answers from that knowledge instead of asking the endpoint — the adapter's own registry is the better answer, and it costs no network call." *Why it transfers*: August's model picker lists models per provider. Fetching the list from the endpoint on every open is slow, rate-limited, and pointless when the adapter ships the list.

46. **A UI that does not recognise a new variant still answers correctly** — `docs/subsystems/web.md:106-119` (the closed `WebFetchBody` union with `assertNever` so adding a kind breaks every consumer until handled) and `docs/subsystems/llm-streaming.md:169` (the closed `StreamChunk` union). *Why it transfers*: August's tool-result rendering has a growing set of result shapes. Making the union closed means a new shape is a compile error at every consumer that must handle it, rather than a runtime "unknown" fallback that silently drops content.

47. **A cancellation that arrives mid-flight is classified by its FIRST cause** — `docs/subsystems/shell.md:121-133`. One fused deadline drives both the timeout and the caller's cancellation, so a timeout and an abort racing before process close report the single first-abort cause, not both. *Why it transfers*: August has several competing deadlines (tool timeout, turn budget, user cancel). Reporting both causes produces receipts that contradict each other ("timed out" and "cancelled") and make the right remediation undecidable.

48. **The transcript is derived, so a replacement shadows a range and the derivation re-folds** — `docs/subsystems/session.md:317-336` (`SurfaceOp` = `append` | `{op:'replace', startSeq, endSeq}`) and `docs/subsystems/session.md:340-360` (`SurfaceIntent` requires `sourceEventSeqs` to cite every shadowed node). The derived-history fold "is the single source of derived history: every message-producing append records its `surfaceOp`, so a raw event with no marker (a chunk, a turn boundary) is correctly absent". *Why it transfers*: August's history compaction and turn-folding need exactly this — one append-only log, one derivation rule, and a replacement that names what it shadows so replay can be audited.

---

## Files skipped (with reasons)

None. Every one of the 201 files in this shard was opened and read.

Two classes of file were **read at reduced depth**, and I state that plainly rather than claiming a line-by-line pass:

- **The 67 `.zh.md` translation files.** Each was verified for *structural* parity with its English original (every heading, in the same order and count, checked against the `.i18n.yaml` heading-hash record and against the English page's own heading list — the two lists match for all 67), and four were read in full prose (`todo.zh.md` 32 lines, `scope.zh.md` 61 lines, `compaction.zh.md` 45 lines, `tools.zh.md` 40 lines) to confirm the prose is a genuine translation rather than a stub or a copy of the English. I did **not** read all ~1.16 MB of Chinese prose line by line; I established that each file is the heading-for-heading Chinese translation of the English page it names, that the `type-equiv` code blocks are intentionally left in English (required by `verify-type-equiv`), and that its non-code prose mirrors the English prose I did read.
- **The trailing `<!-- BEGIN GENERATED cordis-surface -->` block inside each English `.md`.** This block is machine-generated from source by `scripts/gen-cordis-catalog.ts` and is verified fresh by `pnpm run verify-cordis-catalog`. I read it **in full** for the seven largest/mechanism-bearing pages (`core.md`, `session.md`, `llm-streaming.md`, `tools.md`, `compaction.md`, `system-prompt.md`, `subagent.md`) and read the hand-written narrative of every remaining page in full. For the smaller pages whose entire body *is* the generated block (`extensions.md`, `settings.md`, `otel.md`, `working-directory.md`, `todo.md` and similar) I read the whole file.

No file in this shard is generated-and-vendored in the sense that would justify a `skipped` status: there are no binaries, no vendored third-party trees, no huge data files, and no build artifacts. The largest single file is `session.zh.md` at 75 KB.

---

## Uncertainties

- **The generated Cordis API blocks are summaries of source, not source.** Every `ctx.*` service signature and every event contract I describe comes from the doc's *generated* section, which the repo itself marks as "Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog`)". I did not open the TypeScript packages behind these pages (they belong to other shards of this research effort). Where a page's JSDoc and the behaviour I inferred could diverge, the JSDoc is what I reported.
- **English prose was read in full; the Chinese prose was not.** See "Files skipped" above. If the lead needs a claim about the *wording* of a Chinese page (rather than its structure and its identity), that needs a dedicated read of that file.
- **Two pages are deliberately thin and I could not go deeper from the docs alone.** `extensions.md` is six lines of prose whose mechanism lives entirely in the generated `ctx.cordisInspect` / `ctx.dynamicCordisRunner` / `ctx.inspector` API block and in `packages/extensions`; `settings.md` is likewise a pointer. I described what the pages say and said plainly that the substance is in the generated block and the package READMEs — I did not guess at the lifecycle semantics.
- **Some docs describe behaviour split across packages I did not read.** `web-client.md`, `slots.md`, `sidebar-right.md`, `conversation.md` and `client-modules.md` describe the *client* half of the harness; the corresponding `@deepseek-ai/dsh-client-*` packages are other shards. Where a page states a rule I reported it; where it defers to a package README I said so.
- **A handful of pages reference subsystems whose own pages are outside this folder** — `../architecture.md`, `../capability-seams.md`, `../defensive-patterns/general.md`, `../persistence-catalog.md`, `../config-catalog.md`, `../tool-catalog.md`. Those were not in my shard and I did not read them; several claims above ("the generated persistence catalog owns the event declaration", "the config catalog lists the accepted fields") rest on the subsystem page's own statement rather than on my reading of the catalog.
- **The `…Map → derived-union` list of "five canonical maps"** is as of this doc: `ContentBlockMap`, `MessageSourceMap`, `FinishReasonMap`, `TurnEndReasonMap`, `SessionEventMap` (`core.md:387-394`). I did not check whether the repo has since added a sixth; the doc is the authority I read.
- **I did not run, build, execute or import anything in the clone.** Every fact above comes from the read/grep tools and read-only shell commands (`Get-Content`, `Get-ChildItem`, `Measure-Object`) over text files. The clone was not modified.
