# deepseek-harness / dsh-snapshots#1

## Shard shape

This shard is the **entire ACP (Agent Client Protocol) recorded-session corpus** of `deepseek-harness`, plus the one policy document that governs the whole `snapshots/` tree. It holds nine scenarios (`handshake`, `reject-extra-dirs`, `cancel`, `cancel-tool-calls`, `escalation-approved`, `escalation-rejected`, `fs-escalation-approved`, `fs-same-mode`, `image-compaction`), each a self-contained directory with five kinds of artifact: a `snapshot.yml` ownership manifest, an `input.json` controller script, one to three generations of recorded `session.vN.jsonl` session logs, a `stdout.expected.jsonl` JSON-RPC transcript oracle, and occasionally a `cordis.yml` / `cordis.snapshot.yml` composition patch pair plus a `workspace.expected/` external-effect oracle. `acp.snapshot.ts` is the suite entry point: it reads each `snapshot.yml`, maps it onto a `Scenario` descriptor, and hands the whole table to `defineAcpSnapshotSuite` in `@deepseek-ai/dsh-session-snapshot`, which boots the shipped `dsh --profile acp` CLI as a subprocess and drives it over ACP JSON-RPC. The pieces fit together as a **three-oracle test**: the session JSONL says what the agent persisted, the stdout JSONL says what the protocol surfaced to the client, and `workspace.expected/` says what actually happened on disk. The shard's real subject is therefore not the agent but the *harness contract* — permission escalation, cancellation, compaction, and the session-format migrations V2→V3→V4 that this corpus keeps alive side by side.

## Per-file notes

### snapshots/AGENTS.md
- Purpose: The normative policy for the whole `snapshots/` tree — what may live here, how fixtures are named, when a scenario may be re-recorded, and what a committed session JSONL is allowed to contain.
- Key abstractions: "recorded-session snapshot" (a test whose committed session JSONL is *both* replay input and expected persisted output); `header class` (scenarios booting the same config compose the same request header and are compared byte-for-byte); `workspace.expected/` as an *independent oracle*.
- Data flow: a scenario directory → `snapshot.yml` (ownership) → `session[.vN].jsonl` (replay input + expected output) → `stdout.expected.jsonl` / `*.expected.md` / `*.expected.json` sidecars → `workspace.expected/` (final on-disk state).
- Non-obvious design decisions:
  - *"Committed sessions are normalization fixed points. Replace volatile identities with typed relationship-preserving tokens, replace request system prompts and tool schemas with tokens, and keep exactly one readable sidecar owner per header class. Never redact arbitrary user or tool text merely because it resembles an identifier."* — the token discipline is why `{{sessionId}}`, `{{message:1}}`, `{{system}}`, `{{tools}}` appear in the fixtures and why real user prose survives verbatim.
  - *"Record and refresh write version-named outputs without renaming or deleting a committed generation; reviewed source-tree curation is separate."* — generations accumulate rather than being replaced; this is why V2, V3 and V4 all sit in one directory.
  - *"Model prose and tool-result text do not prove the external effect."* — the workspace oracle is deliberately independent of what the agent claims it did.
  - *"An owner that must keep a historical generation or retired-tool recording declares its exact `sessionFormat.version` and closed migration `coverage` names"* — retention is declared, not inferred.
- Edge cases / failure handling: "Record and refresh do not rewrite this independent oracle"; the fixture guard "requires the sidecar exactly when this is set" so a stray `replay.override.json` cannot silently alter a scenario's script.
- Surprising: *"do not add another application entrypoint, hidden CLI mode, or executable scenario driver"* — the corpus is forbidden from growing its own harness; scenarios must be driven through the shipped `dsh` CLI's public interface.

### snapshots/acp/acp.snapshot.ts
- Purpose: The ACP snapshot suite's entry point — the table of nine scenarios and the agent-under-test description handed to `defineAcpSnapshotSuite`.
- Key abstractions: `controllerCases` (a readonly table of `{name, hasModelTurn, configPath?}`); `Scenario` (the framework's per-scenario descriptor, mapped from the manifest); `snapshotMode()` (maps `$DSH_SNAPSHOT` → `replay` | `record` | `refresh`).
- Data flow: `snapshots/acp/<case>/snapshot.yml` → `parseSnapshotManifest()` → a `Scenario` object → `defineAcpSnapshotSuite({agent: {binScript: apps/cli/src/bin.ts, configPath: escalation-approved/cordis.yml, profile: 'acp', tsconfigPath: tsconfig.json}, snapshotsDir, scenarios, mode})`.
- Non-obvious design decisions:
  - The suite's default composition is `escalation-approved/cordis.yml` (line 85) and only `image-compaction` overrides it with its own `configPath` (line 42) — the "alternate config" case exists because a scenario that boots a different config composes a *different request header*, so it carries its own `header.class` (`image-compaction` vs `acp-default`).
  - `localScenarioSource()` (line 46) only accepts a sidecar source that contains no `/`. A source naming another scenario (`session/text-turn`) is therefore *not* treated as a local sidecar and is instead passed through as `systemPromptSource` / `toolSchemasSource` — a path-like source would otherwise be mistaken for a local file.
  - `manifest.recording === 'live'` → `recorded: true` (line 60). `authored` scenarios are never re-recorded by `test:snapshot:record`.
  - `manifest.replay?.override === true` → `overridden: true` (line 62): the framework *requires* a `replay.override.json` to exist exactly when this flag is set, so an unregistered stray sidecar cannot silently change a scenario's script.
  - The `env` block is built conditionally (lines 71-78): `DSH_PERMISSION_MODE` is injected from `manifest.permission`, and `manifest.environment` is merged under it. A scenario with neither gets no env override at all.
- Edge cases / failure handling: `parseSnapshotManifest` throws if the manifest lacks `recording` or `header` (line 53) — the suite refuses to run an unowned scenario. `snapshotMode()` throws on an unknown `$DSH_SNAPSHOT` value rather than defaulting.
- Surprising: the manifest's `header.pin` / `header.changes` / `header.systemPromptSource` are surfaced *separately* (`pinsHeader`, `expectedHeaderChanges`, `systemPromptSource`) rather than as one blob, because the framework needs to know which scenario is the class's *sole* tokenized-header owner.

### snapshots/acp/cancel/snapshot.yml
- Purpose: Ownership manifest for the mid-stream cancellation scenario.
- Key abstractions: `composition: acp-default` (shares the `acp-default` request-header class with seven other scenarios); `recording: authored` (never re-recorded live — a cancel cannot be coaxed deterministically out of a live model); `replay.override: true`.
- Data flow: manifest → `acp.snapshot.ts` `controllerCases` → a `Scenario` with `overridden: true` (the replay script comes from `replay.override.json`, not from the fixture's chunk events).
- Non-obvious design decisions: `recording: authored` is a first-class statement that this fixture is hand-harvested. The framework docs say such scenarios are "NEVER re-recorded" — authoring is a permanent property, not a temporary expedient.
- Edge cases / failure handling: no `permission:` key, so the scenario inherits the suite default; no `platform:`, so it runs on Windows too.
- Surprising: this scenario is `platform: posix`-free while its sibling `cancel-tool-calls` *is* `platform: posix` — the difference is that the cancelled tool call is `bash` (POSIX-only).

### snapshots/acp/cancel/input.json
- Purpose: The deterministic controller script for the cancellation scenario — the sequence of ACP calls the harness makes.
- Key abstractions: `InputStep` union (`initialize`, `newSession`, `prompt`, `promptAndCancel`, `waitForTurnEnd`, …).
- Data flow: `initialize` → `newSession` → `promptAndCancel{text, waitForFile:{path:'.dsh-snapshot-stream-ready'}}` → `waitForTurnEnd`.
- Non-obvious design decisions: the cancel is gated on a **real filesystem marker**, not a timer — the harness waits for `.dsh-snapshot-stream-ready` to appear in the cwd before it issues `session/cancel`, which is what makes the interleaving deterministic.
- Edge cases / failure handling: `waitForTurnEnd` holds the subprocess open until the session's latest durable turn boundary is `turn/end` — without it the run could exit before the abort propagated.
- Surprising: the task text ("Start a long task; this turn will be cancelled mid-stream") is the *only* place the user intent exists — `AGENTS.md` forbids duplicating it elsewhere, so the script and the session fixture must agree by construction.

### snapshots/acp/cancel/replay.override.json
- Purpose: The hand-written replay script that replaces the model output derived from the session fixture.
- Key abstractions: `ReplayOverrideDoc` — a list of overrides; here one `{kind: 'hang', readyFile: '.dsh-snapshot-stream-ready'}`.
- Data flow: the replay adapter reads this file, and on reaching the hang it writes the named marker file and blocks — which is exactly the signal `input.json` waits on.
- Non-obvious design decisions: the "hang" is expressed as *the model adapter pretending to stream forever*, and the readiness signal is a file the harness itself polls. The scenario therefore has no wall-clock dependency at all.
- Edge cases / failure handling: the fixture guard requires this sidecar to exist exactly because `snapshot.yml` declares `replay.override: true`; a missing file is a loud failure, not a silent fallback to the fixture script.
- Surprising: this is a one-element JSON array whose entire content is `{kind, readyFile}` — the smallest possible override, yet it is what makes mid-stream cancellation reproducible at all.

### snapshots/acp/cancel/session.v2.jsonl
- Purpose: The generation-2 recording of the cancellation scenario (16 events), kept as migration coverage.
- Key abstractions: the V2 event vocabulary — the system prompt lives inside `request/header` as `"system":"{{system}}"`, and there is no `system/message` event at all.
- Data flow: `session` header → `permission/preset` → `sandbox/mode` → `approval/policy` → `agent/inbox/spliced` (insert) → `turn/start` → `agent/inbox/spliced` (drain) → `step/start` → `user/message` ×2 → `session/title` → `request/header` → `request/context` → `assistant/message` (interrupted) → `step/end` → `turn/end`.
- Non-obvious design decisions: the abort reason is a nested discriminated union: `{"kind":"aborted","reason":{"kind":"user"}}` — "aborted" is *how* the turn ended, "user" is *who* caused it.
- Edge cases / failure handling: the assistant message carries `"interrupted": true` alongside a `stream` array holding the partial text chunk — the partial output is kept, not discarded.
- Surprising: `request/header` in V2 carries `system`, `tools` and `config` together; by V3 the system prompt has been *promoted out of the header into a real message node*.

### snapshots/acp/cancel/session.v3.jsonl
- Purpose: The generation-3 recording of the same cancellation (17 events), kept as migration coverage.
- Key abstractions: V3 adds a `system/message` event whose `source` is `{kind:'plugin', plugin:'@deepseek-ai/dsh-system-prompt'}`.
- Data flow: identical to V2 except the system prompt is now a first-class message (`{{message:2}}`) and the runtime-context user message carries a `sections` array (`sandbox:policy`, `approval:policy`).
- Non-obvious design decisions: the runtime-context message names its sections structurally, so a UI can render/collapse them individually rather than parsing prose.
- Edge cases / failure handling: message ids shift by one when the system message is introduced (`{{message:1}}` user, `{{message:2}}` system, `{{message:3}}` runtime context) — the fixture normalizer handles this by fingerprint, not by index.
- Surprising: in V3 the *runtime-context* message is still attributed to the system-prompt plugin (`"plugin":"@deepseek-ai/dsh-system-prompt"`), which is a slightly misleading provenance — V4 fixes exactly this.

### snapshots/acp/cancel/session.v4.jsonl
- Purpose: The current-generation recording of the cancellation scenario (17 events) — the fixture the replay actually uses.
- Key abstractions: V4 message provenance — `{kind:'system-prompt'}`, `{kind:'runtime-context'}`, `{kind:'user'}` — replacing V3's `{kind:'plugin', plugin:'…'}`.
- Data flow: the aborted turn emits exactly one `assistant/message` with `"interrupted":true` and a `stream` array holding a `block-start` chunk and a `text-chunks` row (`dt:[]`, `texts:["partial"]`); the turn then ends `{"kind":"aborted","reason":{"kind":"user"}}`.
- Non-obvious design decisions:
  - The `stream` array is a *compressed* chunk log: instead of one event per token, a `text-chunks` row carries `time0`, `dt[]` (per-token delays) and `texts[]` (the token strings). The `dt` array is mostly zeros with a single 1 — the wall-clock shape of a real stream, preserved in a form that is cheap to diff.
  - `request/header` now carries only `{config, tools}` — the system prompt is a message, so the header is purely the request envelope.
- Edge cases / failure handling: `turn/end` reason `aborted`/`user` is distinct from `completed`; the ACP layer maps it to `stopReason: "cancelled"` (`stdout.expected.jsonl:4`).
- Surprising: V4 also adds the `working-directory:current` section to the runtime-context message — the working directory became part of the model's ambient context, not just a local variable.

### snapshots/acp/cancel/stdout.expected.jsonl
- Purpose: The protocol oracle — the exact JSON-RPC frames the ACP client must receive.
- Key abstractions: JSON-RPC 2.0 envelopes; `session/update` notifications; `{{sessionId}}` / `{{messageId}}` normalization tokens.
- Data flow: `initialize` → `result{protocolVersion:1, agentInfo, agentCapabilities, authMethods}`; `session/new` → `result{sessionId, configOptions}`; `session/prompt` → one `session/update` with `sessionUpdate:'agent_message_chunk'` carrying `"partial"`; `session/cancel` → `result{stopReason:'cancelled'}`.
- Non-obvious design decisions: `configOptions` advertises the model as a *select* with a grouped option list (`group: 'deepseek-official'`), and the current value is encoded as a JSON string `["deepseek-official","deepseek-v4-flash"]` — the routing identity is a pair, not a bare model name.
- Edge cases / failure handling: `promptCapabilities` here is `{"image":false,"audio":false,"embeddedContext":false}` — the capability set is derived from the *routed model*, and the image-compaction sibling flips `image` to `true`.
- Surprising: the cancelled turn still emits an `agent_message_chunk` with the partial text before the cancel result — a cancelled turn is not silent.

### snapshots/acp/cancel-tool-calls/snapshot.yml
- Purpose: Ownership manifest for the "cancel a turn with two queued tool calls" scenario.
- Key abstractions: `platform: posix` (the scenario's tool is `bash`, whose semantics Windows cannot reproduce); `workspace: final: true` (this scenario owns a complete final-workspace oracle).
- Data flow: manifest → `Scenario{posixOnly: true, overridden: true}` → the scenario's run test is skipped on Windows while its fixtures stay guarded on every platform.
- Non-obvious design decisions: `workspace.final: true` means `workspace.expected/` holds the *complete* final world state, not a diff — the harness compares the whole tree.
- Edge cases / failure handling: `AGENTS.md` allows only the ignored `.empty` marker for an empty expected result; here `started.txt` is committed, and `skipped.txt` is deliberately absent (its absence is the point).
- Surprising: the scenario is POSIX-only even though the cancellation *mechanism* is platform-neutral — the restriction is about the tool it exercises, not the logic under test.

### snapshots/acp/cancel-tool-calls/input.json
- Purpose: The controller script for the cancel-with-queued-tool-calls scenario.
- Key abstractions: `promptAndCancel{text, waitForFile:{path:'started.txt'}}`.
- Data flow: `initialize` → `newSession` → `promptAndCancel` (waits for the tool to actually write `started.txt`) → `waitForTurnEnd`.
- Non-obvious design decisions: the readiness marker is `started.txt`, the file the *tool itself* writes — so the harness knows the first bash call is genuinely running (not merely queued) before cancelling.
- Edge cases / failure handling: the second tool call (`printf skipped > skipped.txt`) is queued behind the first; the cancel must abort it *before dispatch*, which is a different failure mode from aborting a running call.
- Surprising: the user prompt asks for two specific commands ("wait for cancellation, then write skipped.txt"), so the tool-call sequence being exercised is fully determined by the prompt text, not by an injected script.

### snapshots/acp/cancel-tool-calls/replay.override.json
- Purpose: The hand-written model script for this scenario: two `bash` tool calls, a usage chunk and a `finish`.
- Key abstractions: `chunks` override — a list of `block-start` / `tool-call-delta` / `block-end` / `usage` / `finish` chunk kinds.
- Data flow: block 0 = `call_wait` (a long-running node process that writes `started.tmp`, renames it to `started.txt`, then `setInterval(()=>{},1000)`); block 1 = `call_skipped` (`printf skipped > skipped.txt`); then `usage{inputTokens:10,outputTokens:10}` and `finish{reason:{kind:'tool-calls'}}`.
- Non-obvious design decisions:
  - The first tool's command is written to `started.tmp` and then **renamed** to `started.txt`. A rename is atomic: the harness's file-wait can never observe a partially written `started.txt`, so the readiness signal is exact.
  - The arguments are supplied *both* as a `tool-call-delta` (`argumentsDelta`) and as the completed `block-end.block.arguments` — the delta path exercises the incremental assembler, the block path exercises the already-complete path.
- Edge cases / failure handling: the `finish` reason is `tool-calls`, so the harness genuinely believes two tool calls are pending; the cancel then decides what happens to each.
- Surprising: the scenario fabricates a *second* tool call that must never run, and the absence of `skipped.txt` in `workspace.expected/` is how the test proves the harness did not dispatch it.

### snapshots/acp/cancel-tool-calls/session.v2.jsonl
- Purpose: Generation-2 recording of the cancel-with-two-tool-calls scenario (20 events).
- Key abstractions: V2 tool-result shape — a `role:'user'` message whose content is a nested `{type:'tool-result', toolCallId, content, isError}` block.
- Data flow: two `tool/call` events, each followed by a `tool/result` whose `error` is `{name:'AbortError', code:'ABORTED'}` / `{name:'AbortError', code:'ABORTED_BEFORE_DISPATCH'}`.
- Non-obvious design decisions: **two distinct abort codes** — `ABORTED` (the call was running and was killed) versus `ABORTED_BEFORE_DISPATCH` (the call never started). The loop can therefore tell "we killed it" from "we never let it begin", which is the difference between a side effect that happened and one that did not.
- Edge cases / failure handling: `sourceEventSeqs` back-references the event sequence the result was derived from, so a consumer can reconstruct causality without guessing.
- Surprising: V2/V3 carry no `job/registered`/`job/settled` events at all — there is no durable record of the *process* that was killed, only of the tool call. V4 adds it.

### snapshots/acp/cancel-tool-calls/session.v3.jsonl
- Purpose: Generation-3 recording of the same scenario (21 events), the V3 baseline the corpus policy requires for direct upgrade coverage.
- Key abstractions: V3 adds the `system/message` event; the tool-result nesting is unchanged from V2.
- Data flow: identical shape to V2 plus the system message; the tool results remain `role:'user'` messages containing a `tool-result` content block.
- Non-obvious design decisions: the two abort codes are preserved verbatim across the generation boundary, so a migration cannot quietly collapse "killed" into "never dispatched".
- Edge cases / failure handling: the second tool call's `sourceEventSeqs` is `[16]` (V3) vs `[13]` (V2) because the system message shifted the sequence by one — the back-references are *recomputed*, not copied.
- Surprising: even in V3 there is no durable record of the killed OS process; the "it was killed" fact exists only inside the error payload.

### snapshots/acp/cancel-tool-calls/session.v4.jsonl
- Purpose: The current-generation recording (23 events) of the cancel-with-two-tool-calls scenario.
- Key abstractions: V4 adds `job/registered` and `job/settled` events — a durable **job registry** for tool executions; and V4 promotes tool results to `role:'tool'` messages carrying `toolCallId`.
- Data flow: `tool/call` → `job/registered{jobId, owner, kind:'bash', label, startedAt, toolCall:{callId, rootCallId}}` → `job/settled{finishedAt, status:'killed', cause:'kill', producerReported:true, detail:'signal: SIGTERM; tool call aborted'}` → `tool/result{role:'tool', isError:true, error:{name:'AbortError', code:'ABORTED'}}`; then the second call goes straight to `tool/result{code:'ABORTED_BEFORE_DISPATCH'}` with **no** job events at all.
- Non-obvious design decisions:
  - `job/settled` separates `status` (`killed`) from `cause` (`kill`) from `producerReported` (the child process itself reported the signal, rather than the harness guessing). `detail` carries the verbatim OS fact: `signal: SIGTERM`.
  - `toolCall.rootCallId` is a separate field from `callId` — a call may be a *child* of another call (e.g. a subagent's tool), and the job is owned by the root.
  - The second call produced no job because it was never dispatched. The absence of the event is the evidence.
- Edge cases / failure handling: `producerReported:true` distinguishes "the child told us it died" from "we killed it and did not hear back" — the two imply different reliability.
- Surprising: the V4 tool-result message is `role:'tool'` with a top-level `toolCallId`, where V2/V3 used `role:'user'` with a nested `tool-result` block. The session format itself had to change to stop mis-typing tool results as user speech.

### snapshots/acp/cancel-tool-calls/stdout.expected.jsonl
- Purpose: The ACP transcript oracle for the cancel-with-tool-calls scenario.
- Key abstractions: `tool_call` (with `status:'in_progress'`, `rawInput`) followed by `tool_call_update` (with `status:'completed'|'failed'` and content).
- Data flow: for `call_wait`: `tool_call{status:'in_progress'}` → `tool_call_update{status:'failed', content:[{type:'content',content:{type:'text',text:'Error: tool call aborted'}}]}`; for `call_skipped`: `tool_call{status:'in_progress'}` → `tool_call_update{status:'failed', text:'Error: tool call aborted before dispatch'}`; then `result{stopReason:'cancelled'}`.
- Non-obvious design decisions: **both** calls are surfaced to the client as `in_progress` before being failed. The client is told a tool started, then told it failed — the UI can show a tool row that visibly turns red, rather than one that never appears.
- Edge cases / failure handling: the two failure texts differ ("aborted" vs "aborted before dispatch"), so the client can tell the user *why* the second command never ran.
- Surprising: `rawInput` carries the *parsed* command object, and the failed call's error text is a plain `text` content block — the same shape a successful result uses, so a client needs no special case for failures.

### snapshots/acp/cancel-tool-calls/workspace.expected/started.txt
- Purpose: The external-effect oracle for the cancel scenario — the file the cancelled tool actually created.
- Key abstractions: `workspace.final: true` means this directory is the *complete* final state.
- Data flow: the replayed `bash` tool really writes `started.txt`; the harness diffs the workspace against this committed tree.
- Non-obvious design decisions: `skipped.txt` is deliberately **not** present. The oracle is the pair (file present, file absent); a harness that wrongly dispatched the second call would fail on the missing file rather than on anything the model said.
- Edge cases / failure handling: AGENTS.md allows only the ignored `.empty` marker for an empty expected result, so a scenario with no effect must commit `.empty` rather than an empty directory.
- Surprising: the content is the single word `started` — the file's *existence* is the assertion, not its bytes.

### snapshots/acp/escalation-approved/snapshot.yml
- Purpose: Ownership manifest for the "user approves a sandbox escalation" scenario.
- Key abstractions: `recording: live` (a real recorded run against the live API — reproducible enough to re-record); `header.pin: true` (this scenario is the *sole* tokenized-header owner of the `acp-default` class); `systemPromptSource: session/text-turn` / `toolSchemasSource: session/text-turn` (it borrows the readable sidecars from another scenario).
- Data flow: manifest → `Scenario{pinsHeader: true, systemPromptSource:'session/text-turn', toolSchemasSource:'session/text-turn'}` → the framework compares every other `acp-default` scenario against *this* one's reconstructed header.
- Non-obvious design decisions: the header class is shared by eight scenarios, but only one may `pin` it; the rest are checked for equality against the pin. The readable system prompt and tool schema live in the `text-turn` scenario's sidecars, and this scenario reaches them through a **git symlink** (`system-prompt.expected.md` → `../../session/text-turn/system-prompt.expected.md`).
- Edge cases / failure handling: `permission: workspace-write` sets the deployment preset; `acp.snapshot.ts` turns it into `DSH_PERMISSION_MODE=workspace-write`, and `cordis.yml` reads that env var to pick both the sandbox mode and the approval policy.
- Surprising: `header.pin: true` does not mean "this scenario's prompt is special" — it means "this scenario is the reference copy for its class", which is why the *prompts* can live in a different scenario entirely.

### snapshots/acp/escalation-approved/cordis.yml
- Purpose: The **live** profile patch over the shipped `acp` profile — the composition that actually ran during recording.
- Key abstractions: a Cordis plugin list (`llm-deepseek`, `sandbox-policy`, `approval`, `session-persistence-jsonl`, `acp`, `system-prompt`, `agent-instructions`, `tool-subagent`, `tool-subagent-fork`, `fs-sandbox`) plus an `insert:` block for the hooks plugins.
- Data flow: the `dsh` launcher loads this patch over the shipped profile → the plugin stack composes the request header → the model is called through `@deepseek-ai/dsh-llm-deepseek-api-key` with `provider: deepseek-official, model: deepseek-v4-flash`.
- Non-obvious design decisions:
  - The sandbox mode is `!!js "process.env.DSH_PERMISSION_MODE ?? (process.env.DSH_SNAPSHOT === undefined ? 'workspace-write' : 'danger-full-access')"` — a YAML JavaScript tag, so the *same* patch file serves the live run and the replay run, and the replay gets a wider sandbox than the recording did. The permission level is a property of the run, not of the file.
  - The approval policy is derived from the same expression: `danger-full-access` ⇒ `never`, otherwise `ask`. Approval is a consequence of confinement, not a separate setting.
  - The system prompt's `personaPrefix` explicitly tells the model that *"[sandbox: file access denied …] result is policy, not a command bug"* — the prompt is written to prevent the model from treating a denial as a bug and trying to work around it.
  - `session-persistence-jsonl` uses `compression: 'zstd'` for live runs and `'none'` under `DSH_SNAPSHOT` — a compressed live log cannot be diffed against a fixture.
  - `tool-subagent` (provider `spawn`) and `tool-subagent-fork` (provider `fork`) are both mounted with `maxDepth: 1`, and the comment says "Fork preserves the parent model route and inherited conversation."
- Edge cases / failure handling: the header comment states "The dsh launcher owns environment loading, plugin resolution, and process shutdown; stdout remains reserved for ACP JSON-RPC." — stdout purity is a hard constraint, because the protocol transcript is the oracle.
- Surprising: `session-log-deepseek` is explicitly disabled (`enabled: false`) so the recording does not write a second, parallel log that would diverge from the session JSONL.

### snapshots/acp/escalation-approved/cordis.snapshot.yml
- Purpose: The **replay-only** patch layered on top of `cordis.yml` — it swaps the model transport for recorded JSONL and keeps everything else real.
- Key abstractions: `disabled: true` on the live LLM adapter; an `insert:` of `@deepseek-ai/dsh-llm-replay` declaring the same `provider`/`models` ids; an `insert:` of `../../../scripts/snapshot-shell-path.ts` for the one path the fixture touches.
- Data flow: live adapter disabled → replay adapter serves the recorded model turns under the identical `deepseek-official` / `deepseek-v4-flash` ids → the shell plugin rewrites the exact recorded command `/tmp/dsh-escalated.txt` to a per-run spill path → the sandbox's `passthrough-runner` executes it for real.
- Non-obvious design decisions:
  - The replay patch **layers over** the live patch rather than replacing it. The composition under test is the live one; only the transport is faked. The comment says exactly this: "replace the network adapter with recorded JSONL, pin the recorded top-level model, and keep persistence raw for fixture harvesting."
  - The replay catalog declares `deepseek-v4-flash` and `deepseek-v4-pro` but **not** the vision model — the recorded run never used one.
  - The shell plugin is configured with the exact `command` string; `snapshot-shell-path.ts` matches on string equality and rewrites only the recorded path, so a different command runs untouched.
  - `runnerCommand` is a `bash -c 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"' passthrough-runner` shim, and `runnerFailureSignatures` names its own failure text — the sandbox is still real, only its launcher is rewritten.
- Edge cases / failure handling: `compression: none` is set explicitly (not inherited) so a replayed run's session log is readable JSONL; the live path's `zstd` would otherwise apply.
- Surprising: the scenario inserts `subagent-settlement-marker` even though the escalation scenario never spawns a subagent — see the Uncertainties section.

### snapshots/acp/escalation-approved/input.json
- Purpose: The controller script for the approved-escalation scenario.
- Key abstractions: `InputStep.prompt{text}` plus `permissionAnswers: [{kind:'allow_once'}]`.
- Data flow: `initialize` → `newSession` → `prompt` (one long instruction) → the harness answers the ACP `session/request_permission` round-trip with `allow_once`.
- Non-obvious design decisions:
  - The prompt is written as a *directive to a model*, not as a task description: it dictates the exact single bash call, the exact `sandbox_permissions` value, the exact justification string, and forbids running it without escalation first. That makes the recorded turn deterministic enough to re-record.
  - It ends with "reply with the single word DONE and stop" — the model must produce a *fixed* answer so the transcript is byte-comparable.
  - `permissionAnswers` selects by option **kind**, not by option id, because the ACP option ids are agent-issued randoms a committed script cannot know.
- Edge cases / failure handling: a request beyond the answer queue (or with no queue) is answered `cancelled`; a scripted kind the request does not offer *rejects the run* rather than silently choosing something else.
- Surprising: the prompt contains the literal `/tmp/dsh-escalated.txt` path — and it is exactly the path the shell plugin rewrites at replay time. The prompt is a fixture, and the environment adapts to it.

### snapshots/acp/escalation-approved/session.v2.jsonl
- Purpose: Generation-2 recording of the approved-escalation scenario (23 events).
- Key abstractions: V2 shape — system prompt inside `request/header`, tool result as a `role:'user'` message with a nested `tool-result` block.
- Data flow: `approval/asked{reason:'escalate sandbox to danger-full-access: the user asked to write a file outside the workspace'}` → `approval/decided{outcome:'allowed-once'}` → `tool/result{isError:false, content:'escalated\n'}` → second step emits `DONE`.
- Non-obvious design decisions: the approval *reason* string is persisted in the session log, not just sent to the client — the transcript records why the user was asked, so a later reader can audit the escalation.
- Edge cases / failure handling: `approval/decided.outcome` is `allowed-once` (the singular, scoped grant) rather than `allowed-always`; the grant is per-call by construction.
- Surprising: `usage` on the first step is `{inputTokens:1501, outputTokens:174, cacheReadTokens:0, reasoningTokens:28}` and on the second `{inputTokens:27, outputTokens:42, cacheReadTokens:1664, reasoningTokens:39}` — the second request read 1664 tokens from cache. The prompt prefix was reused, and the fixture pins that fact.

### snapshots/acp/escalation-approved/session.v3.jsonl
- Purpose: Generation-3 recording of the approved-escalation scenario (24 events) — the V3 baseline the corpus policy requires.
- Key abstractions: V3 introduces the `system/message` node; the request header loses its `system` field.
- Data flow: the same event order as V2 plus the system message at sequence 9.
- Non-obvious design decisions: the tool-result content block is unchanged from V2 (`role:'user'` + nested `tool-result`), so this generation isolates *one* format change (the system message) from the others.
- Edge cases / failure handling: `cacheReadTokens: 1664` on step 2 vs `0` on step 1 is preserved exactly — the prompt-cache hit is part of the recorded contract, not incidental.
- Surprising: the reasoning block is `{"type":"reasoning","text":"…"}` *inside* the assistant message content, and it is streamed as its own `reasoning-chunks` row with per-token `dt` — reasoning is a first-class content block, not a text prefix.

### snapshots/acp/escalation-approved/session.v4.jsonl
- Purpose: The current-generation recording (26 events) of the approved-escalation scenario.
- Key abstractions: V4 message provenance (`system-prompt`, `runtime-context`), `role:'tool'` tool results, and the `job/registered` / `job/settled` pair.
- Data flow: `tool/call` → `approval/asked` → `approval/decided{allowed-once}` → `job/registered` → `job/settled{status:'completed', cause:'producer', detail:'exit code: 0'}` → `tool/result{role:'tool', meta:{cwd}}` → step 2 → `assistant/message` with reasoning + `DONE` → `turn/end{completed}`.
- Non-obvious design decisions:
  - `job/settled` distinguishes `cause:'producer'` (the process exited normally and said so) from `cause:'kill'` (the harness killed it) — the two failure shapes seen in `cancel-tool-calls`.
  - `job/settled.detail` is `'exit code: 0'` — the *exit code is a recorded fact*, not just a status enum. August's `run_command` surfaces exit codes for the same reason.
  - The tool result carries `meta:{cwd:'{{cwd}}'}` in V4 where V2/V3 carried no meta at all — the result now says where it ran.
  - `approval/asked` carries a `reason` phrased as `"escalate sandbox to danger-full-access: <the model's own justification>"` — the user's justification is quoted back in the prompt.
- Edge cases / failure handling: the approval is requested *before* the job is registered — nothing is dispatched until the user has answered.
- Surprising: the second step's `usage` shows `inputTokens: 27` but `cacheReadTokens: 1664`. The incremental cost of the follow-up is 27 tokens because the whole prefix was a cache hit; a harness that only tracks `inputTokens` would report a 60× overstatement of the prompt cost.

### snapshots/acp/escalation-approved/stdout.expected.jsonl
- Purpose: The ACP protocol oracle for the approved-escalation scenario.
- Key abstractions: `session/request_permission` (a *server→client request*, id `1`, with `options: [{optionId:'allow-once', kind:'allow_once'}, {optionId:'reject-once', kind:'reject_once'}]`); `tool_call` / `tool_call_update`.
- Data flow: `agent_thought_chunk` (the reasoning) → `tool_call{status:'in_progress', rawInput:{command, description, sandbox_permissions, justification}}` → `session/request_permission` → `tool_call_update{status:'completed', content:'escalated\n'}` → `agent_thought_chunk` → `agent_message_chunk` "DONE" → `result{stopReason:'end_turn'}`.
- Non-obvious design decisions:
  - The request-permission frame uses `"id":1` — the *same* id space as the client's requests, but on the server-initiated channel. The result at the end is `id:3`, so the client's request ids 1 (initialize) and 2 (newSession) and 3 (prompt) are counted separately from the server's id 1.
  - `rawInput` shows the model the full argument object, *including* `sandbox_permissions` and `justification` — the client can render why the agent wants what it wants.
  - The tool result content is the raw stdout `escalated\n`, not a synthesized message.
- Edge cases / failure handling: the permission request carries `toolCall:{toolCallId}` so the client can attribute the prompt to a specific tool call rather than to the turn.
- Surprising: the reasoning text is delivered as `agent_thought_chunk`, a *separate* update kind from `agent_message_chunk` — a client can show thinking differently from the answer without parsing markdown.

### snapshots/acp/escalation-approved/subagent-settlement-marker.ts
- Purpose: A scenario-local Cordis plugin that writes a marker file when the subagent lifecycle ends.
- Key abstractions: `export const name` + `export function apply(ctx: Context)` — the plugin shape Cordis loads by path (`name: './subagent-settlement-marker.ts'` in `cordis.snapshot.yml:44`).
- Data flow: `ctx.on('subagent/end', …)` → `writeFileSync(join(process.cwd(), '.dsh-snapshot-subagent-settled'), '')`.
- Non-obvious design decisions: the marker is a **filesystem** signal rather than a protocol frame, because "child progress has no ACP update to wait on" — a subagent's inner life is not visible over ACP, so the only way for a controller to observe settlement is out-of-band.
- Edge cases / failure handling: it writes an empty file, so the assertion is existence; the write is synchronous and unguarded (a fixture plugin, not production code).
- Surprising: this plugin is registered in the escalation-approved composition, but that scenario never spawns a subagent — so the marker is never written there. It looks like a leftover from a shared composition; see Uncertainties.

### snapshots/acp/escalation-approved/system-prompt.expected.md
- Purpose: A git **symlink** (mode `120000`) to `../../session/text-turn/system-prompt.expected.md`.
- Key abstractions: the "adapter-local symlink" that `snapshots/AGENTS.md` allows "only when `snapshot.yml` names that source".
- Data flow: `snapshot.yml`'s `header.systemPromptSource: session/text-turn` → the corpus gate resolves the link and checks the declared target → the readable prompt body lives in exactly one place in the repo.
- Non-obvious design decisions: "keep exactly one readable sidecar owner per header class" — the symlink gives this scenario a readable prompt *view* without a second copy that could drift.
- Edge cases / failure handling: on this Windows checkout the symlink was materialised as a plain file whose content is the link target text (`../../session/text-turn/system-prompt.expected.md`); the required alias lane runs on macOS and Linux.
- Surprising: `AGENTS.md` says "the corpus gate resolves the link and checks the declared target" — a broken or undeclared symlink fails the gate rather than the test.

### snapshots/acp/escalation-approved/tool-schemas.expected.json
- Purpose: A git **symlink** (mode `120000`) to `../../session/text-turn/tool-schemas.expected.json`.
- Key abstractions: same sidecar-borrowing mechanism as the system prompt, but for the tool-schema set that appears in `request/header` as the `{{tools}}` token.
- Data flow: `header.toolSchemasSource: session/text-turn` → the gate resolves the link → the framework reconstructs the request header from this schema set and compares it against the tokenized header in every fixture of the `acp-default` class.
- Non-obvious design decisions: the tool schemas are *not* stored in the ACP scenario at all — the request header is stored tokenized (`"tools":"{{tools}}"`), and the schema set is the readable sidecar that the token stands for.
- Edge cases / failure handling: because the schema set is shared, a change to the tool registry breaks *every* `acp-default` scenario at once — which is the point of a class pin.
- Surprising: the file is 50 bytes on disk here (a symlink stub), yet it names a ~27 KB JSON sidecar elsewhere in the repo — a header class's real contract lives outside the class's own directory.

### snapshots/acp/escalation-rejected/snapshot.yml
- Purpose: Ownership manifest for the "user rejects a sandbox escalation" scenario.
- Key abstractions: `recording: live`; `header.class: acp-default` with **no** `pin` — this scenario is a *member* of the class, checked against the escalation-approved pin.
- Data flow: manifest → `Scenario{recorded: true}` with no `pinsHeader`, so the framework compares this scenario's reconstructed header against the class pin.
- Non-obvious design decisions: the difference between the two escalation scenarios is one manifest line (`pin: true` vs absent) plus the answer in `input.json` — everything else, including the model, the tools and the prompt shape, is the same class.
- Edge cases / failure handling: `permission: workspace-write` again, so the sandbox genuinely denies the `/tmp` write first.
- Surprising: `header.class: acp-default` is shared by eight scenarios including ones with *different* permission presets (`workspace-write` vs `danger-full-access`) — the header class is about the *request envelope*, not the deployment policy.

### snapshots/acp/escalation-rejected/input.json
- Purpose: The controller script for the rejected-escalation scenario — the exact twin of the approved one with the answer flipped.
- Key abstractions: `permissionAnswers: [{kind:'reject_once'}]`.
- Data flow: `initialize` → `newSession` → `prompt` → the harness answers the permission request with `reject_once`.
- Non-obvious design decisions: the prompt adds an explicit behavioural instruction the approved variant lacks — *"I will reject the permission prompt; after the rejection, do not retry and do not work around it — explain in one short sentence and stop."* The scenario scripts the model's *post-denial* behaviour, not just the denial.
- Edge cases / failure handling: the answer kind `reject_once` is scoped, matching the granted side's `allow_once`.
- Surprising: the two scenarios are the A/B pair that pins the *whole* escalation contract: the request shape, the answer kinds, the denial text, and the model's response to each.

### snapshots/acp/escalation-rejected/session.v2.jsonl
- Purpose: Generation-2 recording of the rejected-escalation scenario (23 events).
- Key abstractions: V2 shape; `approval/decided{outcome:'rejected'}`.
- Data flow: `tool/call` → `approval/asked` → `approval/decided{rejected}` → `tool/result{isError:true, text:'Error: the user rejected escalating this command to "danger-full-access"'}` → step 2 → one sentence of explanation → `turn/end{completed}`.
- Non-obvious design decisions: the denial arrives as a **tool result**, not as an exception — the model is *told* what happened in the same channel it reads every other tool outcome from, and the turn then continues normally.
- Edge cases / failure handling: `isError: true` on the result marks it as a failure for the loop's purposes while still being a normal conversational turn.
- Surprising: the denial text ends at the quoted mode name in V2 — it does not yet tell the model what to do next. V4 extends it (see below).

### snapshots/acp/escalation-rejected/session.v3.jsonl
- Purpose: Generation-3 recording of the rejected-escalation scenario (24 events).
- Key abstractions: V3 adds the `system/message` node; everything else matches V2.
- Data flow: identical event order to V2 plus the system message; the denial text is byte-identical to V2's.
- Non-obvious design decisions: the `usage` on step 2 is `{inputTokens:69, outputTokens:45, cacheReadTokens:1664, reasoningTokens:30}` — the same 1664-token cache read as the approved scenario, because the prefix is the same size.
- Edge cases / failure handling: the second step's `reasoning` explicitly says *"I will not retry and will not work around it"* — the model's compliance with the denial is recorded, not assumed.
- Surprising: `cacheReadTokens` being identical (1664) across two different scenarios is a fixture-level proof that the request prefix was byte-stable enough for the provider to cache it — a cache assertion hidden in a usage counter.

### snapshots/acp/escalation-rejected/session.v4.jsonl
- Purpose: The current-generation recording (24 events) of the rejected-escalation scenario.
- Key abstractions: V4 provenance kinds and `role:'tool'` tool results.
- Data flow: identical to V3 except the denial text is longer and the tool result is a `role:'tool'` message with a top-level `toolCallId`.
- Non-obvious design decisions: the V4 denial text is *"Error: the user rejected escalating this command to \"danger-full-access\"; it stays denied, so stop and explain instead of working around it"* — the refusal now carries an **instruction to the model** about how to behave, not just a statement of fact. V2/V3 said what happened; V4 says what to do about it.
- Edge cases / failure handling: there are **no** `job/registered`/`job/settled` events, because a rejected approval means the tool was never dispatched — the job registry is only touched by work that actually started.
- Surprising: this is the clearest example in the shard of a *refusal string* being treated as part of the harness contract: changing the wording changes the model's behaviour, so the wording is pinned by a fixture.

### snapshots/acp/escalation-rejected/stdout.expected.jsonl
- Purpose: The ACP protocol oracle for the rejected-escalation scenario.
- Key abstractions: identical permission-request frame to the approved scenario, but the following `tool_call_update` has `status:'failed'`.
- Data flow: `agent_thought_chunk` → `tool_call{in_progress}` → `session/request_permission` → `tool_call_update{status:'failed', text:'Error: the user rejected escalating this command to "danger-full-access"; it stays denied, so stop and explain instead of working around it'}` → `agent_thought_chunk` → `agent_message_chunk` → `result{stopReason:'end_turn'}`.
- Non-obvious design decisions: the failure text in the *protocol* transcript carries the same guidance clause as the persisted tool result — the two channels agree byte-for-byte, so a client rendering only the protocol sees the instruction too.
- Edge cases / failure handling: `stopReason` is `end_turn`, **not** an error — a denied escalation is a completed turn with a failed tool call, not a failed turn.
- Surprising: the client's own text explaining the rejection ("The user rejected the permission escalation, so this command cannot be run.") is in the transcript, so the protocol oracle pins the model's *wording*, not just the tool's status.

### snapshots/acp/fs-escalation-approved/snapshot.yml
- Purpose: Ownership manifest for the filesystem-tool escalation scenario (the `write` tool, not `bash`).
- Key abstractions: `permission: workspace-write`; `workspace: final: true` (the scenario owns a complete final-workspace oracle); `recording: live`.
- Data flow: manifest → `Scenario` with `DSH_PERMISSION_MODE=workspace-write` → the `write` tool is fenced by the fs sandbox.
- Non-obvious design decisions: this scenario exists precisely to prove the escalation path is **shared between tool families**: the `bash` escalation (escalation-approved) and the `write` escalation (this one) must behave identically, so the class pin compares their headers and the framework keeps the escalation vocabulary in one package (`dsh-sandbox/escalation`).
- Edge cases / failure handling: `workspace.final: true` means the harness diffs the *whole* workspace tree against `workspace.expected/`, so an extra file fails the test.
- Surprising: the escalation request in the ACP transcript carries `toolName: 'write'` and the same `reason` phrasing (`escalate sandbox to danger-full-access: …`) as the bash case — one vocabulary for both families.

### snapshots/acp/fs-escalation-approved/input.json
- Purpose: The controller script for the fs-escalation scenario.
- Key abstractions: `prompt{text}` + `permissionAnswers:[{kind:'allow_once'}]`.
- Data flow: `initialize` → `newSession` → `prompt` → answer the permission request with `allow_once`.
- Non-obvious design decisions: the prompt explicitly says *"Use the write tool (NOT bash)"* and *"An equivalent write was denied earlier"* — it forces the fs path specifically, because the point of the scenario is that the *fs sandbox* fences, not the shell sandbox.
- Edge cases / failure handling: the scenario pins the exact file name (`escalated.md`) and its exact content (the single line `escalated`), so the workspace oracle can be a byte comparison.
- Surprising: the prompt ends "reply with exactly the single word DONE" — same fixed-answer convention as the bash scenario, so both transcripts end identically and the class comparison stays trivial.

### snapshots/acp/fs-escalation-approved/session.v2.jsonl
- Purpose: Generation-2 recording of the fs-escalation scenario (23 events).
- Key abstractions: V2 tool-result shape; the write result carries `meta:{diffs:[]}`.
- Data flow: `tool/call{name:'write'}` → `approval/asked{toolName:'write'}` → `approval/decided{allowed-once}` → `tool/result{content:'<path>{{cwd}}/escalated.md</path>…'}` → step 2 → `DONE`.
- Non-obvious design decisions: `meta.diffs` is an empty array — the write tool reports a structured diff alongside the prose result, so a UI can render a real diff rather than the model's summary of one.
- Edge cases / failure handling: `meta.diffs` is `[]` for a *create* (nothing to diff against), not a diff of the created content.
- Surprising: in V2 the write result has no `operation` field and no `path` field — V3 adds `operation:'create'`, V4 adds `path`. The tool result's structured metadata grew across three generations while the human-readable text stayed identical.

### snapshots/acp/fs-escalation-approved/session.v3.jsonl
- Purpose: Generation-3 recording of the fs-escalation scenario (24 events) — the V3 baseline.
- Key abstractions: V3 adds the system message; the tool result gains `meta.operation:'create'`.
- Data flow: the same event order as V2 plus the system message; `meta` is now `{operation:'create', diffs:[]}`.
- Non-obvious design decisions: `operation:'create'` (not `'write'` or `'modify'`) is a closed vocabulary the UI can switch on to pick an icon or a diff renderer.
- Edge cases / failure handling: the write is to a *relative* path (`escalated.md`), resolved against the session cwd — the transcript stores the resolved absolute path with a `{{cwd}}` token instead.
- Surprising: the assistant message's `usage` is `{inputTokens:3871, outputTokens:132, cacheReadTokens:0, reasoningTokens:23}` — nearly 3× the bash scenario's 1501, because the fs tool set is much larger than the shell tool set. The cost of a tool surface is visible in the fixtures.

### snapshots/acp/fs-escalation-approved/session.v4.jsonl
- Purpose: The current-generation recording (24 events) of the fs-escalation scenario.
- Key abstractions: V4 provenance kinds, `role:'tool'` results, and `meta:{operation, path, diffs}`.
- Data flow: identical event order to V3; the tool result's `meta` now carries `path:'{{cwd}}/escalated.md'`.
- Non-obvious design decisions: `meta.path` is the *resolved* path with a `{{cwd}}` token, so a consumer can show "created X in the workspace" without re-resolving a relative path against a cwd it does not know.
- Edge cases / failure handling: the fs tool result is `isError:false` with the same `<path>…</path><type>file</type><content>Created file</content>` text as V3 — the *text* is stable across generations while the metadata grows.
- Surprising: `cacheReadTokens` on step 2 is 3968, which is `3871 + 97` — the whole 3871-token first prompt plus 97 more became a cache hit. The provider-side cache reuse is exactly the quantity a harness that only records `inputTokens` would hide.

### snapshots/acp/fs-escalation-approved/stdout.expected.jsonl
- Purpose: The ACP protocol oracle for the fs-escalation scenario.
- Key abstractions: same frame vocabulary as the bash scenario, with `tool_call{title:'write', rawInput:{file_path, content, sandbox_permissions, justification}}`.
- Data flow: `agent_thought_chunk` → `tool_call{in_progress}` → `session/request_permission` → `tool_call_update{status:'completed', content:'<path>{{cwd}}/escalated.md</path>…'}` → `agent_thought_chunk` → `agent_message_chunk` "DONE" → `result{stopReason:'end_turn'}`.
- Non-obvious design decisions: the `{{cwd}}` token inside the tool result means the *same* expected file serves a POSIX run and a Windows run even though the cwd separator differs — the normalizer has a `cwdPathMode: 'canonical'` for exactly this.
- Edge cases / failure handling: the permission frame's `options` are byte-identical to the bash scenario's — one approval vocabulary for every tool family.
- Surprising: the tool result the client sees is a path/`type`/`content` triple, not the file's contents. The client learns *that* a file was created and *where*, but not what is in it — the workspace oracle and the file itself carry that.

### snapshots/acp/fs-escalation-approved/workspace.expected/escalated.md
- Purpose: The independent external-effect oracle for the fs-escalation scenario.
- Key abstractions: `workspace.final: true` — this directory is the complete final state of the scenario's workspace.
- Data flow: the replayed `write` tool really creates `escalated.md`; the harness compares the workspace tree to this committed directory.
- Non-obvious design decisions: the file content is the single line `escalated` — matching the prompt's instruction exactly, so the test distinguishes "wrote what was asked" from "wrote something".
- Edge cases / failure handling: `AGENTS.md` notes that record/refresh never rewrite this oracle, so a change in tool behaviour cannot silently update the expectation.
- Surprising: the file is identical to `snapshots/acp/fs-same-mode/workspace.expected/escalated.md` (same blob hash `3957fd2…`) — two different escalation paths are required to produce byte-identical output.

### snapshots/acp/fs-same-mode/snapshot.yml
- Purpose: Ownership manifest for the "escalation request that matches the current mode" scenario.
- Key abstractions: `permission: danger-full-access` (the session is already unrestricted); `recording: authored` (never re-recorded live — the live model would have no reason to ask for a mode it already has); `workspace: final: true`.
- Data flow: manifest → `DSH_PERMISSION_MODE=danger-full-access` → the `approval` plugin's policy expression yields `never` → no approval prompt is possible.
- Non-obvious design decisions: the scenario pins a *negative*: the model asks for `danger-full-access` while already holding it, and the harness must not ask the user anything.
- Edge cases / failure handling: with `approval.policy: never` a request would fail closed — so the only way this scenario can pass is if the redundant request is *dropped before* the approval door.
- Surprising: this is the only scenario in the shard with `recording: authored` *and* `permission: danger-full-access` — the "same mode" case needs a live model to ask a pointless question, which is exactly the thing live recording will not reproduce.

### snapshots/acp/fs-same-mode/input.json
- Purpose: The controller script for the same-mode scenario — deliberately minimal.
- Key abstractions: `prompt{text}` only. **No `permissionAnswers`** — because no permission request should ever be issued.
- Data flow: `initialize` → `newSession` → `prompt` → (no permission frame) → tool runs → `DONE`.
- Non-obvious design decisions: the prompt says *"Set sandbox_permissions to danger-full-access and justification to 'use the current permissions'. The session already uses danger-full-access."* — it tells the model to make a redundant request on purpose.
- Edge cases / failure handling: the absence of `permissionAnswers` is itself part of the contract: the harness's documented default for an unanswered request is `cancelled`, so if the harness *did* ask, the tool would fail and the transcript would differ.
- Surprising: the input script is 14 lines and contains no permission answers — the shape of the file tells you what the scenario is testing before you read a word of the transcript.

### snapshots/acp/fs-same-mode/session.v3.jsonl
- Purpose: Generation-3 recording of the same-mode scenario (22 events) — this scenario has no V2 fixture.
- Key abstractions: V3 shape; the tool result is a `role:'user'` message with a nested `tool-result` block.
- Data flow: `tool/call{name:'write', arguments include sandbox_permissions:'danger-full-access'}` → **no `approval/asked`** → `tool/result{isError:false}` → step 2 → `DONE`.
- Non-obvious design decisions: the escalation arguments survive all the way into the persisted `tool/call` event — the harness records what the model *asked for* even when it decides not to honour the request. That is what makes the scenario diagnosable after the fact.
- Edge cases / failure handling: `approval/policy: never` is persisted as an event, so the transcript records the policy under which the redundant request was dropped.
- Surprising: the tool call's `justification` is `'use the current permissions'` — a justification that is not really a justification. It is accepted because the mode is unchanged, so no escalation is happening and no reason is needed.

### snapshots/acp/fs-same-mode/session.v4.jsonl
- Purpose: The current-generation recording (22 events) of the same-mode scenario.
- Key abstractions: V4 provenance kinds and `role:'tool'` tool results; `meta:{operation:'create', path, diffs}`.
- Data flow: identical to V3 apart from the provenance/source shape and the richer `meta`; still **no** `approval/asked` and **no** `approval/decided`.
- Non-obvious design decisions: the absence of any approval event is the whole assertion. There is no "auto-approved" marker, no "skipped" marker — the request simply evaporates, and the tool runs under the mode the session already had.
- Edge cases / failure handling: `permission/preset`, `sandbox/mode` and `approval/policy` are all persisted at the top of the log, so the reader can see that the current mode was `danger-full-access` and the policy was `never` when the redundant request was made.
- Surprising: this is the exact opposite of the `escalation-approved` scenario and the pair together pin the rule: *ask only when the request actually widens*.

### snapshots/acp/fs-same-mode/stdout.expected.jsonl
- Purpose: The ACP protocol oracle for the same-mode scenario.
- Key abstractions: the frame sequence is the escalation transcript **minus** the `session/request_permission` frame.
- Data flow: `agent_thought_chunk` → `tool_call{in_progress, rawInput includes sandbox_permissions}` → `tool_call_update{status:'completed'}` → `agent_thought_chunk` → `agent_message_chunk` "DONE" → `result{stopReason:'end_turn'}`.
- Non-obvious design decisions: the `rawInput` in the transcript *still shows* `sandbox_permissions:'danger-full-access'` and `justification:'use the current permissions'`. The client is told what the model asked for even though no prompt was raised — the transcript does not launder the request away.
- Edge cases / failure handling: no permission frame means a client that renders "waiting for your approval" has nothing to render — the protocol surface stays consistent.
- Surprising: the tool_call id (`call_00_Fnymmavpr4klMDy4Fdej3227`) and the command are byte-identical to the `fs-escalation-approved` scenario's, because both fixtures were harvested from the same model run family. Two scenarios, one recorded model.

### snapshots/acp/fs-same-mode/workspace.expected/escalated.md
- Purpose: The independent external-effect oracle for the same-mode scenario.
- Key abstractions: `workspace.final: true`.
- Data flow: the write really happens (under the session's existing `danger-full-access` mode) and the tree is compared against this directory.
- Non-obvious design decisions: the content is the same single line `escalated`, and the blob hash is identical to the `fs-escalation-approved` oracle — so a reviewer diffing the two scenarios sees *only* the approval difference.
- Edge cases / failure handling: because the scenario declares `workspace.final: true`, a `skipped.txt` or any other stray artifact would fail the comparison — the "no prompt asked" case must also leave no residue.
- Surprising: two committed files in the tree have the same content and the same hash (`3957fd2…`) — `AGENTS.md` mentions "keep exactly one readable sidecar owner per header class" for sidecars, but these are workspace oracles, a different category, and duplication is allowed there.

### snapshots/acp/handshake/snapshot.yml
- Purpose: Ownership manifest for the pure protocol handshake scenario.
- Key abstractions: the minimal manifest — `version`, `scenario`, `profile`, `composition`, `recording: authored`, `header.class`. No permission, no replay override, no workspace.
- Data flow: manifest → a `Scenario{hasModelTurn: false}` → the suite registers the run test but no JSONL comparison.
- Non-obvious design decisions: `recording: authored` even though there is no model involved at all — "authored" is the safe default for anything not captured from the live API.
- Edge cases / failure handling: the scenario's run test is guarded on every platform; `AGENTS.md` says the fixture guard "requires the sidecar exactly when this is set" — here no sidecar is required.
- Surprising: `hasModelTurn: false` is declared in `acp.snapshot.ts`, not in the manifest — the manifest cannot express it, so the split is: *the manifest owns ownership, the TS table owns execution shape*.

### snapshots/acp/handshake/input.json
- Purpose: The two-step controller script for the handshake scenario.
- Key abstractions: `[{op:'initialize'}, {op:'newSession'}]`.
- Data flow: initialize → new session → the harness compares the two response frames.
- Non-obvious design decisions: there is no prompt step, so the session log contains no user message at all — the session header row is the *entire* persisted log (one line).
- Edge cases / failure handling: `newSession` is where the server issues the random session id; the harness captures it into the `{{sessionId}}` variable for later steps.
- Surprising: a two-op script is enough to prove the whole capability advertisement, because the `initialize` result carries `agentCapabilities` and the `newSession` result carries `configOptions`.

### snapshots/acp/handshake/session.v3.jsonl
- Purpose: The generation-3 recording of the handshake — a **one-line** session log.
- Key abstractions: the session header event — `{type:'session', version, id:'{{session:1}}', createdAt:0, isSeeded:false, delegationDepth:0}`.
- Data flow: header only; no turn, no message, no request.
- Non-obvious design decisions: `createdAt: 0` and `id: '{{session:1}}'` are normalized constants — the fixture asserts the *shape* of the header, not the values.
- Edge cases / failure handling: `delegationDepth: 0` records that this session is a root, not a subagent child — a fact the parent/child ordering logic depends on.
- Surprising: the handshake's V3 fixture is *identical* to the `reject-extra-dirs` V3 fixture (same blob `c5b7253…`) — both scenarios fail before any message is accepted, so the persisted session is the same empty header.

### snapshots/acp/handshake/session.v2.jsonl
- Purpose: The generation-2 recording of the handshake — also a one-line log, differing only in `"version":2`.
- Key abstractions: same header event, older format version.
- Data flow: header only.
- Non-obvious design decisions: V2 and V3 headers differ in exactly one field (`version`), which is what makes "replay selects the retained V3 baseline or the current generation independently for each role" a cheap switch.
- Edge cases / failure handling: no `cwd` field in the handshake fixtures at all — a session that never ran has no working directory. (The `cancel` scenario's V2 header *does* carry `cwd`, because it ran.)
- Surprising: the manifest lists `session.v2.jsonl` and `session.v3.jsonl` but no V4 — the handshake scenario was never re-recorded at the current format, and the corpus policy permits a scenario to keep a retained generation without a current one.

### snapshots/acp/handshake/stdout.expected.jsonl
- Purpose: The ACP protocol oracle for the handshake — the capability advertisement.
- Key abstractions: `result{protocolVersion:1, agentInfo:{name:'deepseek-harness-acp', version:'0.0.1'}, agentCapabilities:{mcpCapabilities:{http:true}, promptCapabilities:{image:false,audio:false,embeddedContext:false}, sessionCapabilities:{close:{},list:{},resume:{}}}, authMethods:[]}`.
- Data flow: the `initialize` result is the first frame; the `newSession` result carries `sessionId` and the `configOptions` model select.
- Non-obvious design decisions: `sessionCapabilities` is a set of *empty objects* (`close:{}`, `list:{}`, `resume:{}`) — the presence of the key declares the capability, the (empty) object carries no parameters. A client checks for the key, not for fields inside it.
- Edge cases / failure handling: `authMethods: []` — the ACP profile advertises no authentication methods at all, so a client knows not to attempt a login.
- Surprising: `agentInfo.version` is `0.0.1` — the ACP *agent* version is independent of the harness version, and the fixture pins it so a version bump is a deliberate diff.

### snapshots/acp/reject-extra-dirs/snapshot.yml
- Purpose: Ownership manifest for the "client asks for extra workspace directories" rejection scenario.
- Key abstractions: the same minimal shape as the handshake manifest; `recording: authored`.
- Data flow: manifest → `Scenario{hasModelTurn: false}` → the suite drives `newSessionExpectError`.
- Non-obvious design decisions: the scenario tests a *protocol-level refusal* — the agent declines to widen the workspace scope, and the refusal is the expected output.
- Edge cases / failure handling: no permission, no replay override; the error frame is the whole assertion.
- Surprising: `AGENTS.md` warns that a shared reference "is used only when another interface intentionally renders the same recorded behavior" — this scenario deliberately has no session reference because the refused session/new never becomes a session.

### snapshots/acp/reject-extra-dirs/input.json
- Purpose: The controller script for the extra-directories rejection scenario.
- Key abstractions: `{op:'newSessionExpectError', additionalDirectories:['/extra-dir']}`.
- Data flow: initialize → attempt `session/new` with `additionalDirectories` → the harness *expects the RPC to be rejected* and swallows the rejection so the error frame lands in the transcript.
- Non-obvious design decisions: the harness asserts both directions: if the call *succeeds* it throws "expected session/new to be rejected but it succeeded"; if it fails, the failure is the expected result.
- Edge cases / failure handling: `mcpServers: []` is still sent — the rejection is specifically about `additionalDirectories`, so the rest of the request is valid.
- Surprising: the rejected `session/new` leaves the harness with **no** session id, yet the transcript still contains the `initialize` frame — the run is a valid, comparable transcript even though the scenario accomplished nothing but a refusal.

### snapshots/acp/reject-extra-dirs/session.v3.jsonl
- Purpose: The generation-3 recording of the rejection scenario — a one-line session log.
- Key abstractions: the session header only, byte-identical to the handshake's V3 fixture.
- Data flow: header only.
- Non-obvious design decisions: the persistence layer recorded a session row even though the protocol call was rejected — which is precisely what lets a later reader see that the refusal happened *after* a session object existed.
- Edge cases / failure handling: `createdAt: 0`, `isSeeded: false`, `delegationDepth: 0` — identical to every other empty session.
- Surprising: the file is byte-identical (`c5b7253…`) to `snapshots/acp/handshake/session.v3.jsonl`. Two scenarios, one empty persisted session — the corpus tolerates duplicate fixture content for *session logs* (the uniqueness guard in the framework applies to snapshot sidecars, not to session logs).

### snapshots/acp/reject-extra-dirs/session.v2.jsonl
- Purpose: The generation-2 recording of the rejection scenario — a one-line log differing only in `version`.
- Key abstractions: the session header event at format V2.
- Data flow: header only.
- Non-obvious design decisions: keeping a V2 generation of a *rejected* scenario is migration coverage: a V2-era reader must be able to load a session that never got past `session/new`.
- Edge cases / failure handling: the V2 header omits `cwd` (as all never-ran sessions do).
- Surprising: byte-identical to `snapshots/acp/handshake/session.v2.jsonl` (`b151255…`) — the two scenarios are indistinguishable at the persistence layer, and only the protocol transcript tells them apart.

### snapshots/acp/reject-extra-dirs/stdout.expected.jsonl
- Purpose: The ACP protocol oracle for the extra-directories rejection.
- Key abstractions: a JSON-RPC **error** frame: `{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"Invalid params: additionalDirectories is not supported"}}`.
- Data flow: `initialize` result → error frame for `session/new`.
- Non-obvious design decisions: the error uses the standard JSON-RPC code `-32602` (Invalid params) and a *human-readable* message naming the offending field. An unsupported-but-valid parameter is an invalid-params error, not a server error.
- Edge cases / failure handling: the error arrives on the `session/new` request id (2), so a client can attribute it correctly; the harness's `newSessionExpectError` step converts the SDK's rejected promise into "the expected protocol result".
- Surprising: the same rejection is *also* enforced in the harness layer, which comments that the bridge "rejects a session/new that widens the workspace scope (non-empty additionalDirectories / mcpServers — unimplemented)". The refusal is deliberate and documented, not an accidental gap.

### snapshots/acp/image-compaction/snapshot.yml
- Purpose: Ownership manifest for the image-driven compaction scenario.
- Key abstractions: `composition: image-compaction` (its own header class, because it boots a different config and a different model); `header.pin: true` with `systemPromptSource: session/read-image` and `toolSchemasSource: escalation-approved` (a *mix* of two other scenarios' sidecars); `input.attachments[]` with a content-addressed id.
- Data flow: manifest → `Scenario{configPath: image-compaction/cordis.yml, pinsHeader: true, systemPromptSource: 'session/read-image', toolSchemasSource: 'escalation-approved'}` → the vision model is selected.
- Non-obvious design decisions:
  - The system prompt comes from `session/read-image` while the tool schemas come from `escalation-approved` — a header class can mix sidecar owners, because the prompt and the tool set are independent axes.
  - The attachment is declared in the manifest, not in `input.json`, because the *persisted session* holds only the attachment id (`sha256:b1ff9c8e…`), `mediaType`, `width`, `height` and `bytes` — the bytes themselves cannot live in the session log, so the manifest carries them and the harness reconstructs the input block from the id.
  - The attachment id is content-addressed (`sha256:` prefix, enforced by the manifest parser), so the same bytes always produce the same id and the fixture stays stable.
- Edge cases / failure handling: `permission: danger-full-access`; the scenario is `recording: authored` because the compaction pressure depends on a deliberately tiny context window that a live run would never reproduce.
- Surprising: the manifest's `input.attachments[0].data` is a 1×1 PNG in base64 — the *smallest possible* image. The scenario is not about image quality; it is about how many image *tokens* six of them cost.

### snapshots/acp/image-compaction/input.json
- Purpose: The controller script for the image-compaction scenario — two turns, the first carrying six images.
- Key abstractions: `promptContent{content: AcpContentBlock[]}` — a content array interleaving `text` and `image` blocks.
- Data flow: `initialize` → `newSession` → `promptContent` (text + six 1×1 PNGs interleaved with " (frame N) " labels, then "Acknowledge receipt briefly; we will discuss them next.") → `promptContent` ("Now reply with exactly the single word DONE.").
- Non-obvious design decisions: the six images are the *same bytes* six times, so the scenario's pressure comes from **count**, not from payload size — which is what a provider's per-image token charge (and the harness's `imageRequestTokens: 384`) actually bills.
- Edge cases / failure handling: the second turn is a separate `promptContent` so the compaction can be triggered *between* two turns, after the first has settled — the shape of a real long session rather than one turn that overflows.
- Surprising: the image blocks carry only `data` + `mimeType`; the attachment id, dimensions and byte count in the persisted session are *derived* (by hashing and by decoding), not passed in — the harness computed them, and the manifest pins the expected hash so a mismatch fails loudly.

### snapshots/acp/image-compaction/session.v4.jsonl
- Purpose: The current-generation recording (31 events) of the image-compaction scenario — the richest fixture in the shard.
- Key abstractions: `compaction/start`, `image/offload`, `compaction/summary` (with `shadowedRange`, `shadowedSeqs`, `shadowedTokenCount`, `maxTokens`, `usage`), `compaction/end`; and `surfaceOp: {op:'replace', startSeq, endSeq}` for the checkpoint message.
- Data flow:
  - Turn 1: the six-image user message → `request/context{provider, model:'deepseek-v4-flash-vision-exp', contextWindow:10022}` → assistant acknowledges.
  - Turn 2 starts → `compaction/start{compactionId}` → `image/offload{targets:[{seq:8, imageIndexes:[0]}]}` → `compaction/summary{summary, rawOutput, llmStreamCall:true, shadowedRange:{start:8,end:8}, shadowedSeqs:[8], shadowedTokenCount:366, maxTokens:8192, usage:{inputTokens:20,outputTokens:16}}` → a `user/message` whose source is `{kind:'compact-checkpoint', compactionId}` and whose `surfaceOp` **replaces** seq 8 → `compaction/end` → the step runs → assistant says `DONE`.
- Non-obvious design decisions:
  - **The checkpoint is a user-role message that replaces the shadowed span in the surface**, not an append. `surfaceOp:{op:'replace',startSeq:8,endSeq:8}` means the six-image message is *gone* from the model's view and replaced by the summary — so the context shrinks rather than grows.
  - The checkpoint text explicitly says: *"Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint."* — the model is told to build on the summary, not to narrate it.
  - The summary is wrapped in a `<compacted-summary>…</compacted-summary>` fence, so the model can tell a checkpoint from a real user message.
  - `shadowedTokenCount: 366` records exactly how many tokens the replaced span was worth; `maxTokens: 8192` is the summary budget; `usage` is the summarizer's own cost, billed separately from the turn.
  - `image/offload` names *which* occurrences were dropped (`seq`, `imageIndexes`) rather than just how many — the decision is auditable and reversible in principle.
  - `llmStreamCall: true` distinguishes a real summarizer call from a heuristic fallback.
- Edge cases / failure handling: `compaction/start` and `compaction/end` bracket the operation, so a crash mid-compaction is visible in the log; `sourceEventSeqs:[19,21,8]` back-references the events the checkpoint was derived from.
- Surprising: the assistant's own usage for both turns is `{inputTokens:3, outputTokens:3}` — a replay-adapter placeholder — while the *compaction* usage (`20/16`) is real. The fixture makes the summarizer's cost visible even when the replayed turns are synthetic.

### snapshots/acp/image-compaction/session.v3.jsonl
- Purpose: Generation-3 recording of the image-compaction scenario (31 events) — the V3 baseline.
- Key abstractions: V3 provenance (`{kind:'plugin', plugin:'compact'}` on the checkpoint; `{kind:'plugin', plugin:'@deepseek-ai/dsh-system-prompt'}` on the system message and runtime context).
- Data flow: the same event order as V4, but `request/context` carries `contextWindow: 11600` instead of 10022, and the checkpoint's source is attributed to the `compact` plugin rather than a `compact-checkpoint` kind.
- Non-obvious design decisions: the `contextWindow` difference (11600 vs 10022) is the replay catalog's pin, not a behaviour change — the fixture records whichever window the pinned catalog declared for that generation.
- Edge cases / failure handling: `image/offload` is already present in V3 (it is absent only in V2) — image offload entered the format at V3.
- Surprising: the checkpoint's V3 provenance (`plugin: 'compact'`) and V4 provenance (`kind: 'compact-checkpoint'`) describe the same event; V4 replaces *plugin names* with *semantic kinds* across the board.

### snapshots/acp/image-compaction/session.v2.jsonl
- Purpose: Generation-2 recording of the image-compaction scenario (29 events) — the oldest retained generation.
- Key abstractions: V2 shape — system prompt inside `request/header`, tool results as `role:'user'`; and **no `image/offload` event at all**.
- Data flow: `compaction/start` → `compaction/summary` → the checkpoint `user/message` (with `surfaceOp:{op:'replace',startSeq:7,endSeq:7}`) → `compaction/end` → assistant `DONE`. The image-offload step is simply missing.
- Non-obvious design decisions: in V2 the compaction summary *summarized the images in prose* ("Six identical 1x1 dashboard reference screenshots were shared and acknowledged.") without an explicit offload decision — the images were shadowed as part of the replaced span rather than individually offloaded.
- Edge cases / failure handling: the checkpoint text, the `<compacted-summary>` fence and the "without acknowledging this checkpoint" instruction are **already present in V2** — that instruction predates the image-offload event by a whole format generation.
- Surprising: reading V2 → V3 → V4 side by side shows the compaction checkpoint contract was designed correctly from the start (a replace, not an append; an explicit do-not-acknowledge instruction) and only the *offload bookkeeping* was added later.

### snapshots/acp/image-compaction/stdout.expected.jsonl
- Purpose: The ACP protocol oracle for the image-compaction scenario.
- Key abstractions: `promptCapabilities.image` is **`true`** here (vs `false` in every other scenario) — the capability is derived from the routed model's `inputModalities`.
- Data flow: initialize → `newSession` whose `configOptions` list **three** models (flash, pro, and `deepseek-v4-flash-vision-exp`) with the vision one current → `agent_message_chunk` ("Received six dashboard frames; ready to discuss.") → `usage_update{used:'{{usedTokens}}', size:10022}` → `result{stopReason:'end_turn'}` → the second turn's `agent_message_chunk` "DONE" → `usage_update` → `result{stopReason:'end_turn'}`.
- Non-obvious design decisions:
  - `usage_update` carries `size: 10022` — the **context window**, not a token count — and `used` is a normalized token (`{{usedTokens}}`) because the real number moves with the environment. The client learns the window from the same fact the compactor uses.
  - The compaction itself produces **no** ACP frame. The client sees the assistant's acknowledgement and a usage update; the checkpoint is invisible at the protocol level. The protocol is a surface, not the transcript.
  - The `usage_update` arrives *before* the turn result, and both turns report the same `size`.
- Edge cases / failure handling: the two turns are distinguished by the `id` (3 and 4) on the prompt requests; the `session/update` notifications carry no id, so the client tracks them by session.
- Surprising: the `newSession` result advertises the vision model as a *third* option in the same grouped select, and `promptCapabilities.image` flips accordingly — the capability advertisement is computed from the route, so one profile can present different capabilities for different models.

### snapshots/acp/image-compaction/cordis.yml
- Purpose: The **live** composition patch for the image-compaction scenario.
- Key abstractions: an alternate `cordis.yml` (its basename must end in `cordis.yml` so the launcher finds the `cordis.snapshot.yml` sibling); the `acp` row selects the vision model; `compaction-basic` with a tight budget; `@deepseek-ai/dsh-attachment-local` for the durable attachment store.
- Data flow: the patch selects `deepseek-v4-flash-vision-exp`, keeps session persistence uncompressed, and mounts a compaction budget of `headroomTokens: 0, maxTokens: 8192, retainTokens: 100`.
- Non-obvious design decisions: the header comment explains the budget's sizing: *"the text-only history stays under the threshold, so a triggered compaction proves the routed model's image pricing drove the pressure decision."* The budget is chosen so that only **image** tokens can trigger it — a text-only heuristic would never fire.
- Edge cases / failure handling: `maxTokens: 8192` is also the summary budget recorded in `compaction/summary.maxTokens`; `retainTokens: 100` keeps the tail tiny so the compaction is forced.
- Surprising: the attachment store's root is resolved from `$DSH_HOME`, which the snapshot harness scopes per run — so the patch itself carries no attachment path, and the same patch works for live and replay.

### snapshots/acp/image-compaction/cordis.snapshot.yml
- Purpose: The **replay** patch for the image-compaction scenario — keyless replay with the model transport swapped.
- Key abstractions: the live adapter is `disabled: true`; `@deepseek-ai/dsh-llm-replay` declares three models, the vision one with `inputModalities: [text, image]`, `contextWindow: 10022` and `imageRequestTokens: 384`.
- Data flow: replay adapter → the pinned vision route → the same `compaction-basic` budget and the same `summary-image-budget.mjs` plugin → the compaction fires exactly as recorded.
- Non-obvious design decisions:
  - `contextWindow: 10022` is set deliberately low, with the comment: *"Route-priced request images at the provider cap; the small context window turns that visual pressure into an automatic compaction the text-only heuristic would not trigger."*
  - `imageRequestTokens: 384` is the per-image price the token meter uses — the compaction pressure is computed from *route-priced visual tokens*, not from a byte count.
  - The replay catalog declares `inputModalities` per model, so the strict `read_image` gate "accepts the route and the tool result carries the durable image block" — the capability declaration is what makes the route legal.
  - The file is a near-duplicate of `cordis.yml` (the composition is re-declared rather than inherited), which keeps the replay patch self-contained.
- Edge cases / failure handling: `compression: none` for readable session logs; the summary-image-budget plugin is inserted in both the live and the replay patch so the summarizer route is the same either way.
- Surprising: the replay catalog pins `contextWindow: 10022` — a deliberately *wrong-looking* number — because the point is to make the recorded compaction reproducible, not to model a real provider's window.

### snapshots/acp/image-compaction/summary-image-budget.mjs
- Purpose: A scenario-local plugin that makes the **compaction summarizer** fail with an image-budget error.
- Key abstractions: `export const name = 'summary-image-budget'`; `export const inject = ['llm']`; a `ctx.on('llm/stream', …)` middleware.
- Data flow: the middleware intercepts only streams whose `options.purpose === 'compaction'`; on the first such stream it yields a single `finish` chunk with `reason.kind === 'error'`, `failure.code === 'IMAGE_OFFLOAD_REQUIRED'`, `failure.offloadImages: 1`; every other stream passes through via `yield* next()`.
- Non-obvious design decisions:
  - The failure is **authored**, not accidental: the plugin exists to make the harness's image-offload recovery path fire on demand, without needing a real provider that refuses images. The `failed` flag makes it fire exactly once.
  - The error is raised *inside* the summarizer's own stream, so the recovery that runs is the compaction-side one (`compaction/summary-error`), not the agent-side one.
  - `offloadImages: 1` is the count the harness must satisfy — the protocol between adapter and harness is "I need N more oldest occurrences dropped", and the harness does the dropping.
- Edge cases / failure handling: `if (options.purpose !== 'compaction' || failed) { yield* next(); return }` — a non-compaction stream is untouched and the plugin fires at most once, so the scenario cannot loop.
- Surprising: this is a *reusable* fault-injection primitive: a 23-line plugin that turns any adapter failure code into a deterministic scenario, with the harness's real recovery path doing the rest.

### snapshots/acp/image-compaction/system-prompt.expected.md
- Purpose: A git **symlink** (mode `120000`) to `../../session/read-image/system-prompt.expected.md`.
- Key abstractions: the same sidecar-borrowing mechanism as the other symlinks, pointing at the scenario whose prompt *class* this one reuses.
- Data flow: `snapshot.yml`'s `header.systemPromptSource: session/read-image` → the corpus gate resolves the link and checks the declared target → the readable prompt body lives in the `read-image` scenario.
- Non-obvious design decisions: the image-compaction scenario borrows the *read-image* prompt (the tool that reads images) while borrowing the *tool schemas* from `escalation-approved` — a scenario's prompt and its tool set are independently sourced.
- Edge cases / failure handling: the declared target must be a lower-kebab-case corpus-relative path (validated by the manifest parser); a path with a leading `/` or a `\` is rejected.
- Surprising: on this Windows checkout the link was materialised as a plain file containing the 50-byte target string `../../session/read-image/system-prompt.expected.md`; the alias lane is required on macOS and Linux.

## Ideas worth stealing

- **A refusal string is a contract, and the refusal must tell the model what to do next.** - `snapshots/acp/escalation-rejected/session.v4.jsonl:19` - the denial text is *"Error: the user rejected escalating this command to \"danger-full-access\"; it stays denied, so stop and explain instead of working around it"* — and V3's shorter version (`snapshots/acp/escalation-rejected/session.v3.jsonl:19`, *"…\"danger-full-access\""*) was deliberately widened. August has exactly this bug class: the `Blocked:` vs `[Blocked]` marker mismatch that made a refusal read as success. The transferable rule is that the *wording* of a refusal is part of the API, is versioned, and is pinned by a fixture — and that it should carry the behavioural instruction ("stop, don't work around it"), not only the fact.

- **Never ask the user for an approval that does not widen anything.** - `snapshots/acp/fs-same-mode/session.v4.jsonl:16` - the tool call carries `sandbox_permissions:'danger-full-access'` while the session is already `danger-full-access`, and the transcript contains **no** `approval/asked` frame at all — the request evaporates. Compare `snapshots/acp/fs-escalation-approved/session.v4.jsonl:17`, where the same fields *do* produce a prompt. August's `needs_approval_in` returns False for `full`, but there is no explicit "requested mode == current mode ⇒ drop the prompt" rule; the bash tool has it at `packages/shell/tool-bash/src/index.ts:83`. The pair of scenarios is the proof that the rule is deliberate.

- **Make the external effect an oracle independent of what the agent claims.** - `snapshots/AGENTS.md:15` - *"Model prose and tool-result text do not prove the external effect."* The scenario commits the whole final workspace (`workspace.expected/`) and the record/refresh path never rewrites it. In `snapshots/acp/cancel-tool-calls/workspace.expected/started.txt` the assertion is the *presence* of a file plus the *absence* of `skipped.txt` — a harness that wrongly dispatched the queued tool fails on a missing file, not on anything the model said. August's `e2e:smoke` is the closest analogue; the discipline of committing a byte-level expected tree per scenario would strengthen it.

- **Compaction must REPLACE the shadowed span in the surface, not append a summary to it.** - `snapshots/acp/image-compaction/session.v4.jsonl:24` - the checkpoint is a user-role message with `surfaceOp:{op:'replace',startSeq:8,endSeq:8}`, so the six-image message is *gone* from the model's view and the context actually shrinks. The checkpoint text also says *"Continue the task directly from the messages that follow, without acknowledging this checkpoint"*, wrapped in a `<compacted-summary>` fence. August's `<<compressed_summary` block and its `surfaceOp` semantics should match this: a compaction that appends is a compaction that grows.

- **Let the provider name what to drop, then repair the surface and retry the same step — outside the provider retry budget.** - `snapshots/acp/image-compaction/session.v4.jsonl:22` - the adapter fails with `IMAGE_OFFLOAD_REQUIRED` + `offloadImages: 1`; the harness records `image/offload{targets:[{seq, imageIndexes}]}`, mutates the durable surface, and re-runs the *same* step. The implementing plugin says it outright (`packages/compaction/compaction-image-offload/src/index.ts:29`): *"A durable surface repair, not a provider retry: it spends no retry budget and logs no retry event."* August's budget ladder has a compaction rung but no "the transport says which N oldest occurrences to drop, the harness drops exactly those" contract.

- **Split the reasoning stream into its own channel and its own content block.** - `snapshots/acp/escalation-approved/session.v4.jsonl:15` - reasoning is `{"type":"reasoning","text":…}` inside the assistant message, streamed as `reasoning-chunks` rows with per-token `dt` timing, and projected to the protocol as a separate `agent_thought_chunk` frame (`snapshots/acp/escalation-approved/stdout.expected.jsonl:3`), distinct from `agent_message_chunk`. `usage.reasoningTokens` is counted separately from `outputTokens`. A UI can render thinking differently from the answer without heuristics — and the per-token `dt` array preserves the *shape* of a real stream (mostly zeros with one 1) in a form that is cheap to diff.

- **Cache-hit evidence belongs in the fixture, not in a dashboard.** - `snapshots/acp/escalation-approved/session.v4.jsonl:15` and `:24` - step 1 records `{inputTokens:1501, cacheReadTokens:0}` and step 2 records `{inputTokens:27, cacheReadTokens:1664}`. The *marginal* cost of the second request is 27 tokens because the whole 1664-token prefix was a cache hit. A harness that reports only `inputTokens` overstates the prompt cost by ~60×. August's "frozen per session to protect the provider prefix cache" rule is the same idea, and it deserves the same fixture-level proof.

- **Rehearse the migration by keeping three generations of the same scenario side by side.** - `snapshots/acp/cancel/session.v2.jsonl`, `snapshots/acp/cancel/session.v3.jsonl`, `snapshots/acp/cancel/session.v4.jsonl` - the same scenario exists at V2, V3 and V4, and the framework picks the numerically highest for replay while the corpus policy requires V3 inputs for direct upgrade coverage. The v2→v4 diff is a readable changelog of the format: the system prompt moved out of `request/header` into a `system/message` node; tool results changed from `role:'user'` + a nested `tool-result` block to `role:'tool'` + a top-level `toolCallId`; `job/registered`/`job/settled` appeared; and message provenance changed from `{kind:'plugin', plugin:'@deepseek-ai/dsh-system-prompt'}` to `{kind:'system-prompt'}`. August's "every test file was deleted" world would have no migration coverage at all.

- **Give message provenance a closed semantic vocabulary instead of a plugin name.** - `snapshots/acp/cancel/session.v4.jsonl:9` vs `snapshots/acp/cancel/session.v3.jsonl:9` - V4 uses `system-prompt`, `runtime-context`, `compact-checkpoint`, `user`, `model`, `tool`, `fallback`; V3 used `{kind:'plugin', plugin:'…'}`, which mis-attributed the runtime-context message to the system-prompt plugin. A UI that switches on provenance then needs no string-matching on package names — and a package rename can no longer break a transcript's meaning.

- **Make the cancel deterministic with a filesystem marker the tool itself writes, and distinguish "killed" from "never dispatched".** - `snapshots/acp/cancel-tool-calls/input.json:8` and `snapshots/acp/cancel-tool-calls/session.v4.jsonl:18`/`:21` - the harness waits for `started.txt` (written by the running bash tool via an atomic write-then-rename) before cancelling, so there is no wall-clock dependency. The log then records `job/settled{status:'killed', cause:'kill', producerReported:true, detail:'signal: SIGTERM'}` for the running call and `ABORTED_BEFORE_DISPATCH` (with *no* job events at all) for the queued one. Two distinct failure codes for two distinct situations — and the absence of the job event is the evidence that nothing ran.

- **Record what the process actually reported, not a status enum.** - `snapshots/acp/escalation-approved/session.v4.jsonl:20` - `job/settled` carries `status:'completed', cause:'producer', producerReported:true, detail:'exit code: 0'`, and the killed case carries `detail:'signal: SIGTERM; tool call aborted'`. The `producerReported` flag separates "the child told us" from "we inferred it". August's `run_command` surfacing exit codes (including zero) is the same instinct: the raw fact belongs in the log.

- **Layer the replay patch over the live patch instead of replacing it.** - `snapshots/acp/escalation-approved/cordis.snapshot.yml:5` - the replay file *disables* the live LLM adapter and *inserts* a replay adapter with the same provider/model ids; every other plugin (sandbox policy, approval, fs-sandbox, system prompt, subagent tools) stays exactly as the live composition declared it. The header comment says it: *"replace the network adapter with recorded JSONL, pin the recorded top-level model, and keep persistence raw for fixture harvesting."* The consequence is that a replay test exercises the **real** plugin stack, the real sandbox and the real approval choreography — only the model's words are recorded. August's tests could adopt this shape: faking the transport, not the harness.

- **The recorded command is translated, the execution is not.** - `snapshots/acp/escalation-approved/cordis.snapshot.yml:47` - `snapshot-shell-path.ts` matches on the *exact* command string and rewrites only the recorded path (`/tmp/dsh-escalated.txt` → a per-run spill path), so the shell really executes and really reports its exit code. A test that mocks the tool would not catch a broken tool; this one does.

- **Turn a "the model asked for something impossible" script into a first-class input step.** - `snapshots/acp/reject-extra-dirs/input.json:4` - `newSessionExpectError{additionalDirectories:['/extra-dir']}` asserts the rejection in both directions (success ⇒ the harness throws; failure ⇒ expected). The same primitive exists for prompts (`promptExpectError`). Refusals are testable outcomes, not accidents.

- **The protocol transcript is a surface, not the truth.** - `snapshots/acp/image-compaction/stdout.expected.jsonl:4` - the compaction produced **no** ACP frame at all; the client sees the assistant's acknowledgement and a `usage_update{used, size}`. Meanwhile the session log holds `compaction/start` → `image/offload` → `compaction/summary` → `compaction/end`. Clients should be told "how full am I", not "what did you do internally" — and August's equivalent rule (a run of tool calls is one transcript line) is the same separation.

## Files skipped (with reasons)

None. Every one of the 67 files in `dsh-snapshots#1` was opened and read. Two honest qualifications:

- **Six `session.vN.jsonl` fixtures contain one line longer than the read tool's 2000-character display window** (`escalation-approved` v2/v3/v4 at 3316 chars, `escalation-rejected` v2/v3/v4 at 3706, `fs-escalation-approved` v2/v3/v4 at 2578, `fs-same-mode` v3/v4 at 2558, `cancel-tool-calls` v2/v3/v4 at 2289). For each I read the first 2000 characters with the read tool and then read the remaining tail with a read-only shell substring of the same line. The truncated tails contain only the remainder of the per-token `dt`/`texts` arrays, the `block-end` chunk, the `usage` chunk (a duplicate of the message-level `usage` field already read) and the `finish` chunk (a duplicate of the turn's reason). No information was lost, but the per-token timing arrays of the *first* tool-call block in those six files were not individually enumerated.
- **Three files are git symlinks (mode `120000`) that the Windows checkout materialised as plain text files** (`snapshots/acp/escalation-approved/system-prompt.expected.md`, `snapshots/acp/escalation-approved/tool-schemas.expected.json`, `snapshots/acp/image-compaction/system-prompt.expected.md`). I read each one and confirmed via `git ls-files -s` that they are symlinks; their *targets* live outside this shard and I did not read them (they belong to `session/text-turn` and `session/read-image`).

## Uncertainties

- **The `subagent-settlement-marker.ts` plugin appears unused in this shard.** It is registered by `snapshots/acp/escalation-approved/cordis.snapshot.yml:43` and writes `.dsh-snapshot-subagent-settled` on `subagent/end`, but no scenario in the ACP corpus spawns a subagent — I grepped the whole repo for `.dsh-snapshot-subagent-settled` and found no consumer besides the writer. The most likely explanation is that it is a leftover from a shared composition (the `session/subagent-acp-diagnostic` scenario has its own `settlement-order.mjs` for the same purpose). I could not confirm whether the ACP suite ever asserted on the marker; I did not read `packages/test-support/session-snapshot/src/suite.ts` in full (I read lines 60-389).
- **Why `fs-same-mode` has no V2 fixture** while every other scenario keeps one. The manifest policy in `packages/test-support/session-snapshot/src/manifest.ts` allows a scenario to declare `sessionFormat` for a retained generation, and `fs-same-mode/snapshot.yml` declares none — so its absence of V2 is a curation choice, not a rule I could derive. I checked the manifest schema (`writesCurrentSessionFixtures`, `sessionFormat.coverage`) and could not find a rule that explains the gap.
- **Whether the `usage_update` `size` field is the model's declared context window or a measured one.** `snapshots/acp/image-compaction/stdout.expected.jsonl:4` shows `size: 10022`, matching the replay catalog's `contextWindow: 10022` in `cordis.snapshot.yml:51` — but `snapshots/acp/image-compaction/session.v3.jsonl:13` shows `contextWindow: 11600` while the stdout oracle still says `10022`. I traced the producer to `packages/acp/acp/src/updates.ts:94` (`session.requestContext()?.contextWindow`), which suggests the frame reports the *live* request context and the fixture's `11600` is the *recorded* one. I could not fully reconcile the two numbers without running the suite, which I did not do.
- **Why the ACP `newSession` result lists three models in the image-compaction scenario but only two elsewhere.** The replay catalog in `cordis.snapshot.yml:41-52` declares flash, pro and the vision model; `escalation-approved/cordis.snapshot.yml:37-41` declares only flash and pro. The stdout oracle matches each. Whether the ACP bridge filters the list by the configured route or simply echoes the catalog, I did not verify.
- **Whether the `usage` numbers in the replayed fixtures are real.** The image-compaction assistant turns record `{inputTokens:3, outputTokens:3}`, which looks like a replay-adapter placeholder rather than a measurement, while the compaction summary's `{inputTokens:20, outputTokens:16}` looks real. I could not establish the rule that distinguishes the two without reading the replay adapter (`@deepseek-ai/dsh-llm-replay`), which is outside this shard.
- **The exact semantics of `sourceEventSeqs`.** The field back-references event sequence numbers (e.g. `snapshots/acp/escalation-approved/session.v4.jsonl:21` has `sourceEventSeqs:[14]`), and I confirmed it is *recomputed* per generation (V2: `[13]`, V3: `[14]`), but I did not establish the precise indexing convention (0- or 1-based) against the framework's normalizer.
- **The `dt` arrays in the compressed chunk rows.** Each `text-chunks` / `reasoning-chunks` / `tool-call-chunks` row carries `dt[]` (per-token millisecond delays). I confirmed the shape and that the values are mostly zeros with a single 1, but I did not read every element of the longest arrays in the six over-long lines noted above, so I cannot say whether a 1 ever appears at more than one position in a row.
