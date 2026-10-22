# deepseek-harness / dsh-snapshots#2

## Shard shape

This shard is the **SDK/headless golden-fixture corpus** of the deepseek-harness snapshot test tier — 249 committed files, all under `snapshots/sdk/**` (27 scenarios) and `snapshots/session/advanced-toolchain*/**` (2 scenarios). It contains **no production code**: it is the *expected-output* side of the `@deepseek-ai/dsh-session-snapshot` kit. Each scenario directory holds (a) a closed `snapshot.yml` manifest naming the profile, composition, recording mode and the header class that owns the prompt/schema pin; (b) a Cordis plugin patch pair — `cordis.yml` for the live recording run and `cordis.snapshot.yml` for the keyless replay that swaps the real provider for `@deepseek-ai/dsh-llm-replay`; (c) the persisted Session logs at up to three format generations (`session.v2/v3/v4.jsonl`) plus `session.<n>.jsonl` for child agents; (d) the SDK wire projection (`notifications.expected.jsonl`) and the owned-run projection (`result.expected.json`); and (e) the header sidecars that pin the exact system prompt (`system-prompt.expected.md`) and tool-schema catalogue (`tool-schemas.expected.json`) the model saw. One file is a driver rather than a fixture: `snapshots/sdk/sdk.snapshot.ts` (1241 lines) spawns a real `dsh --profile sdk` subprocess per scenario, drives scripted turns over stdio JSON-RPC, and compares everything above. The net effect is a *behavioural* contract in machine-comparable form: every event type, tool-call boundary, compaction decision, subagent handshake, prompt-change route and error taxonomy the harness can produce is pinned here.

---

## Per-file notes

### `snapshots/sdk/sdk.snapshot.ts`
- **Purpose:** the SDK snapshot suite driver — the one file in this shard that is code rather than a golden.
- **Key abstractions:** `CorpusScenario` (manifest + dir), `SnapshotManifest` (closed schema from the kit), `SdkAssertions` (per-scenario expectations table `SDK_ASSERTIONS`, lines 129–191), `TurnAction` (turn number + prompt content blocks extracted from a fixture), `PersistedLog` (path + raw JSONL + parsed header).
- **Data flow:** `collectCorpus()` (line 204) walks `snapshots/session` and `snapshots/sdk`, parses every `snapshot.yml`; ownership is then enforced — one `cordis.yml` per composition and one pin per `composition/class` (lines 233–244, throwing on duplicates). `runScenario()` (line 566) allocates a temp cwd, materialises the profile patches, copies `workspace/` in, hydrates the replay fixtures into `<cwd>/.replay-fixtures/` with `{{cwd}}` substituted, spawns `DeepSeekHarness` with `DSH_SNAPSHOT_*` env, and drives one `session.run()` per recorded turn. Afterwards the harvested logs are normalised (`normalizeSessionSnapshots`, `nativeWriterOutput: true`) and compared to the committed fixtures; `verifyHeaders()` (line 844) reconstructs each `request/header` from the pinned schema sidecar and asserts the system prompt precedes the first request.
- **Non-obvious design decisions:** the corpus is *self-discovering* — adding a directory with a `snapshot.yml` adds a test, and the ownership map rejects a second owner for the same composition so a patch cannot be edited in two places. `authoredPatches()` (line 551) composes patches by composition ownership rather than by scenario, so a scenario that owns no `cordis.yml` inherits the `default` composition's transport-neutral patch. `normalizeNotifications()` (line 385) re-runs the SDK wire stream through the *session-log* normaliser before scrubbing it, so the two projections cannot drift. `verifyHeaders()` asserts `systemPromptPrecedesRequests` (line 883) — the prompt must be logged before the first request, or the fixture is rejected.
- **Edge cases / failure handling:** `expect(logs.some(log => log.content.includes('llm-replay: script exhausted')), …).toBe(false)` (line 985) makes an exhausted replay script a test failure rather than a silent hang. `writesCurrentSessionFixtures` decides whether a scenario may write its session fixtures at all. Retained historical scenarios are verified byte-identical after a run (line 1143). A changed workspace without `workspace.final: true` fails (line 1203).
- **Surprising:** the suite deliberately asserts the **delta** of a tool surface rather than the whole list (`toolNames.map(names => names.includes('snapshot_ping'))` → `[false,true,false]`, line 1019), so adding an unrelated tool does not break a golden. And the completion-ordering contract at line 740 (`['parent:turn:1','parent:idle','child:finished','parent:turn:2','parent:idle']`, "completion notifications arrive before the session/wait response") is a hard assertion about parent/child interleaving.

### `snapshots/sdk/text-turn/snapshot.yml`
- **Purpose:** the base SDK scenario manifest — one plain text turn, recorded live against the real API.
- **Key abstractions:** `header.class: sdk-upload` (the composition/header identity that owns the prompt+schema pin), `recording: live`, `environment.DSH_SNAPSHOT_FEEDBACK`.
- **Data flow:** the manifest names the composition `sdk-upload`; `compositionOwner()` resolves the owning `cordis.yml` and `headerPin()` resolves the owning `system-prompt.expected.md`/`tool-schemas.expected.json` for this header class.
- **Non-obvious design decisions:** `DSH_SNAPSHOT_FEEDBACK: '1'` is an *environment* fact rather than a patch, because the feedback services must be enabled only for this scenario (the live patch also gates the two feedback plugins on the same variable).
- **Edge cases / failure handling:** in record mode the scenario is allowed to re-record; the feedback plugin asserts it did not mutate model-visible messages.
- **Surprising:** the manifest is a *closed* schema — unknown keys are rejected by `parseSnapshotManifest`, so a scenario cannot smuggle configuration past the format.

### `snapshots/sdk/text-turn/cordis.yml`
- **Purpose:** the live (record-mode) Cordis plugin patch for the `sdk-upload` composition.
- **Key abstractions:** four plugin overrides (`skill-filesystem`, `llm-deepseek`, `session-persistence-jsonl`, `tool-subagent`) plus two inserted plugins (message-feedback, feedback-producer).
- **Data flow:** `materializeProfilePatch()` rewrites `!!js` tags and `process.cwd()` into the generated temp cwd, then the SDK client boots the profile with the patch list.
- **Non-obvious design decisions:** `includeDefaultRoots: false` on the skill filesystem — *"The fixture corpus must not depend on the developer's personal skill roots."* `compression: !!js "process.env.DSH_SNAPSHOT === undefined ? 'zstd' : 'none'"` — the same profile compresses in production and stores raw JSONL under the snapshot harness, because *"compressed JSONL has no snapshot-harvest path"*.
- **Edge cases / failure handling:** the two feedback plugins are `disabled:` unless `DSH_SNAPSHOT_FEEDBACK === '1'`, so the same patch serves every scenario in the composition.
- **Surprising:** `thinking: enabled` + `reasoningEffort: max` are set on the provider, and the recorded stream still shows `reasoningTokens: 19` — the reasoning budget is part of the pinned request, not an accident.

### `snapshots/sdk/text-turn/cordis.snapshot.yml`
- **Purpose:** the keyless replay patch layered over the live patch.
- **Key abstractions:** one override (`llm-deepseek` → `disabled: true`) and one insert (`llm-replay` with the `deepseek-official` / `deepseek-v4-flash` provider pair).
- **Data flow:** in replay mode the harness serves recorded model responses from the committed session fixture; the real API key plugin is switched off so the test is keyless.
- **Non-obvious design decisions:** the replay patch is *additive over the live patch* rather than a replacement — `authoredPatches()` emits `[cordis.yml, cordis.snapshot.yml]` for `sdk-*` compositions (line 553).
- **Edge cases / failure handling:** `DSH_SNAPSHOT=record` skips the replay layer entirely (the suite skips authored scenarios in record mode, line 926).
- **Surprising:** the replay layer never disables the session-log uploader for this composition — `text-turn` deliberately keeps `session-log-deepseek/delivery-accepted` in the log, so the *uploader's* ack event is part of the pinned timeline.

### `snapshots/sdk/text-turn/session.v4.jsonl`
- **Purpose:** the current-generation parent Session log for the base scenario (25 rows).
- **Key abstractions:** header row (`type:"session", version:4`), then one event per row: `permission/preset`, `sandbox/mode`, `approval/policy`, `agent/inbox/spliced`, `turn/start`, `step/start`, `system/message`, `user/message` ×2, `request/header`, `request/context`, `session/title`, `session-log-deepseek/delivery-accepted`, `assistant/message`, `step/end`, `command/run`, feedback events, `turn/end`.
- **Data flow:** the user text arrives via `agent/inbox/spliced`; the turn then re-emits it as a `user/message` with `surfaceOp:"append"`. The `assistant/message` carries the *full* block list (reasoning + text) plus a `stream` array of raw chunks.
- **Non-obvious design decisions:** the runtime context is a **separate user message** with `source {kind:"runtime-context", form:"snapshot", sections:[…]}` (line 11), not part of the system prompt — so the cached system-prompt prefix survives across sessions.
- **Edge cases / failure handling:** `surfaceOp` on each message says whether the row is an `append` or a `replace` over a seq range, which is how a compacted span is expressed in-place.
- **Surprising:** the `assistant/message` embeds both the *normalised* content and the raw `stream` chunk array with `time0`/`dt` deltas — the fixture stores both the semantic result and the byte-level streaming shape.

### `snapshots/sdk/text-turn/session.v3.jsonl`
- **Purpose:** the retained v3 generation of the same session — a migration fixture.
- **Key abstractions:** identical event vocabulary except the message provenance model.
- **Data flow:** `system/message` carries `source {kind:"plugin", plugin:"@deepseek-ai/dsh-system-prompt"}` (line 9) instead of v4's `{kind:"system-prompt"}`; the runtime-context message has only two sections (no `working-directory:current`).
- **Non-obvious design decisions:** the corpus keeps *both* generations side by side rather than migrating in place, so a format change is reviewable as a diff.
- **Edge cases / failure handling:** the suite selects the numerically highest generation for replay but a scenario may pin `sessionFormat.version` to keep an older one as the replay input.
- **Surprising:** v3 has **two** `feedback/record` rows where v4 also has two but v2 has one — the feedback service's event count is itself part of the format contract.

### `snapshots/sdk/text-turn/session.v2.jsonl`
- **Purpose:** the oldest retained generation — the "system prompt lives in the request header" layout.
- **Key abstractions:** no `system/message` event at all; the prompt is `request/header.header.system = "{{system}}"` (line 12).
- **Data flow:** the runtime context is still a plugin-sourced user message, but with no `working-directory:current` section.
- **Non-obvious design decisions:** the prompt was *in-band* in the request header in v2 and was later hoisted to a first-class `system/message` surface node — the change the corpus pins.
- **Edge cases / failure handling:** `systemPromptPrecedesRequests` only applies to current generations; retained predecessors keep their historical representation.
- **Surprising:** in v2 the assistant message id is `{{message:3}}` and the runtime context is `{{message:2}}` — message ids were renumbered by the migration, so an id-based diff between generations is meaningless.

### `snapshots/sdk/text-turn/notifications.expected.jsonl`
- **Purpose:** the SDK wire projection — the exact JSON-RPC notification stream a client sees.
- **Key abstractions:** `session.event` envelopes carrying a normalised event, plus bare `session.status` notifications (`running` / `idle`).
- **Data flow:** the stream is `agent/inbox/spliced` → `session.status running` → `turn/start` → `step/start` → `system/message` → `user/message` → `request/header` → `request/context` → `session/title` → `assistant/message` → `step/end` → feedback events → `turn/end` → `session.status idle`.
- **Non-obvious design decisions:** the `system/message` text is scrubbed to the literal `"{{system}}"` and the header's tool list to `"{{tools}}"`; the real text and catalogue live in the sidecars. Times are zeroed and ids are first-seen tokens (`{{session:1}}`, `{{message:4}}`, `{{command:1}}`).
- **Edge cases / failure handling:** `session/title` carries `source {kind:"fallback"}` — when no title provider is configured the harness synthesises a truncated title from the first user message ("Reply with exactly: SDK snapshot").
- **Surprising:** the title is truncated to a *word boundary* mid-sentence, and the truncation length is itself pinned.

### `snapshots/sdk/text-turn/result.expected.json`
- **Purpose:** the owned-run projection — the `RunResult` the SDK caller gets back.
- **Key abstractions:** `{sessionId, finalResponse}`.
- **Data flow:** `normalizeResult()` (sdk.snapshot.ts:419) renders exactly this two-field object, so the golden is the *public* API shape and nothing else.
- **Non-obvious design decisions:** the projection is deliberately minimal — the rich transcript lives in the notification stream and the session log, so the SDK contract stays small.
- **Edge cases / failure handling:** a scenario with no wire golden simply omits the file; `hasWireGoldens` gates the comparison.
- **Surprising:** `sessionId` is `{{sessionId}}` (not `{{session:1}}`) — the result projection uses a different redaction token from the notification stream.

### `snapshots/sdk/text-turn/system-prompt.expected.md`
- **Purpose:** the pinned root system prompt (27 lines) the model received.
- **Key abstractions:** harness identity line, model line, then ten global tool-usage rules.
- **Data flow:** `normalizedSystemPrompts(log)` extracts the `system/message` text from the harvested log; the sidecar is the expected value.
- **Non-obvious design decisions:** the rules are written as *negative* constraints ("Use the read tool — not shell commands like cat", "Use the glob tool — not shell find") because the failure mode is the model reaching for a shell tool it should not. The web rules explicitly frame fetched content as data, not instructions.
- **Edge cases / failure handling:** a scenario that does not own the pin names `header.systemPromptSource` instead, so the prompt is committed once.
- **Surprising:** the prompt contains no mention of the model family, the provider, or the tool list — all of that is machine context, not prose.

### `snapshots/sdk/text-turn/feedback-producer.mjs`
- **Purpose:** a fixture plugin that exercises the real feedback services inside a recorded turn.
- **Key abstractions:** `inject = ['commands','messageFeedback','sessionFeedback']`; the `agent/turn-stopping` hook.
- **Data flow:** on `agent/turn-stopping` (root sessions only) it derives the messages, finds the last assistant message, executes the `/feedback` command, records a session-level feedback, then does a message-feedback create → edit (`ifVersion` on the created version) → delete.
- **Non-obvious design decisions:** it finishes with `if (JSON.stringify(agent.session.deriveMessages()) !== JSON.stringify(messages)) throw new Error('feedback changed model-visible messages')` — the fixture's real assertion is that **feedback must not mutate the model-visible history**.
- **Edge cases / failure handling:** every service call is checked (`if (!created.ok) throw new Error(created.error.code)`), so a service-contract change fails the scenario instead of silently producing a shorter log.
- **Surprising:** the fixture writes `feedback/message-put` twice with different ratings and *then* deletes the message — the delete event is in the golden, so the whole create/edit/delete cycle is pinned, not just the end state.

### `snapshots/sdk/bash-tool/notifications.expected.jsonl`
- **Purpose:** the canonical one-tool-call round trip, recorded live.
- **Key abstractions:** `tool/call` → `job/registered` → `job/settled` → `tool/result`.
- **Data flow:** the assistant emits a `tool-call` block for `bash`; the harness registers a **job** for it (line 15), settles it with `status:"completed"`, `cause:"producer"`, `producerReported:true`, `detail:"exit code: 0"` (line 16), then appends the tool result with `sourceEventSeqs:[14]` (line 17).
- **Non-obvious design decisions:** a bash call is modelled as a *job* even when it is synchronous — the job events are what let the UI show "running" and later "settled", and the `toolCall.rootCallId` links a nested PTC sub-call back to its root.
- **Edge cases / failure handling:** `sourceEventSeqs` records which source events produced the result, so the log can be re-derived.
- **Surprising:** step 2 reports `cacheReadTokens: 1664` while step 1 reports `cacheReadTokens: 0` — the provider cache hit only appears on the *second* request of the turn, because the first request populated it.

### `snapshots/sdk/bash-tool/cordis.yml`
- **Purpose:** the live patch for the `sdk-default` composition (no upload metadata).
- **Key abstractions:** four plugin overrides, with `session-log-deepseek` disabled.
- **Data flow:** same shape as `text-turn` minus the feedback plugins and minus the uploader.
- **Non-obvious design decisions:** disabling the uploader keeps the corpus independent of any external sink, at the cost of losing the `delivery-accepted` event.
- **Edge cases / failure handling:** `session-persistence-jsonl` still writes to `dshHomePath('sessions')`, so the log is harvested from the real persistence path.
- **Surprising:** the composition deliberately differs from `text-turn` only by the uploader — proving the corpus isolates one variable per composition.

### `snapshots/sdk/dynamic-tool-updates/notifications.expected.jsonl`
- **Purpose:** the scenario that proves the model-facing tool surface can change *inside* a turn.
- **Key abstractions:** `request/header` with `reason:"change"`, and `developer/message` with `source {kind:"tool-registry"}`.
- **Data flow:** step 1 calls `read`; before step 2 the header is re-emitted with `snapshot_ping` added and a `developer/message` carries `content:[{type:"tool-addition", toolName:"snapshot_ping"}]` plus `headerSeq: 18` pointing at that header (line 18); before step 3 the header drops it again with a `tool-removal` developer message (line 25).
- **Non-obvious design decisions:** the *reason* field distinguishes `initial`, `change` and `series` headers — a consumer can tell a fresh conversation from a mid-turn tool-surface change from a retry series.
- **Edge cases / failure handling:** the removal message has **no** `headerSeq` (asserted at sdk.snapshot.ts:1033) — only an addition is tied to a specific header.
- **Surprising:** the tool list in the changed header is the *full* list, not a delta — the delta lives in the developer message, so both the resulting state and the transition are recoverable.

### `snapshots/sdk/minimal-image-compaction/notifications.expected.jsonl`
- **Purpose:** the scenario that pins compaction, checkpointing and the image-offload repair.
- **Key abstractions:** `compaction/start`, `compaction/summary`, `compaction/end`, `assistant/attempt`, `image/offload`.
- **Data flow:** the turn reads `red.png`; then `compaction/summary` (line 17) reports `shadowedRange {start:5,end:6}`, `shadowedSeqs:[5,6]`, `shadowedTokenCount = 2945`, `llmStreamCall:true` and both `summary` and `rawOutput`; the checkpoint is written as a `user/message` with `surfaceOp {op:"replace", startSeq:5, endSeq:6}` (line 18); then `assistant/attempt` (line 23) fails with `failure.code:"IMAGE_OFFLOAD_REQUIRED"`, `offloadImages:1`; `image/offload` (line 24) names `targets:[{seq:12, imageIndexes:[0]}]`; a new `request/header` with `reason:"series"` (line 25) retries and succeeds.
- **Non-obvious design decisions:** the checkpoint text is a *fixed instruction* — "Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint." — so the model does not burn a turn narrating the compaction.
- **Edge cases / failure handling:** the summary records the token count it shadowed, so the "how much did this free?" question has a logged answer; `llmStreamCall:true` distinguishes an LLM-written summary from a heuristic one.
- **Surprising:** the compaction and the image offload are **two different repairs** of the same turn, and the request/header `reason` distinguishes them: `"series"` (a retry of the same request) vs `"change"` (a different tool surface).

### `snapshots/sdk/minimal-image-compaction/session.v4.jsonl`
- **Purpose:** the durable log form of the same compaction+offload turn.
- **Key abstractions:** the same event vocabulary minus the wire envelope (`sessionId`/`seq`/`time`).
- **Data flow:** `compaction/start` → `compaction/summary` → the checkpoint `user/message` (`source.kind:"compact-checkpoint"`) → `compaction/end` → a *second* `step/start` → the image-offload attempt → the successful retry.
- **Non-obvious design decisions:** the checkpoint's `sourceEventSeqs` is `[14,15,5,6]` — it points at both the compaction events *and* the shadowed original events, so the replacement is reversible.
- **Edge cases / failure handling:** `compaction/error` is asserted to have **zero** occurrences (sdk.snapshot.ts:972) — a failed compaction is a distinct, separately-pinned outcome.
- **Surprising:** the runtime context after compaction is reduced to a single `working-directory:current` section — compaction drops the sandbox and approval clauses from the replayed context.

### `snapshots/sdk/minimal-image-compaction/cordis.snapshot.yml`
- **Purpose:** the replay patch that makes the compaction fire deterministically.
- **Key abstractions:** the `llm-replay` provider entry with `inputModalities: [text, image]`, `contextWindow: 1000000`, and the `compaction-basic` plugin.
- **Data flow:** `compaction-basic` is configured with `thresholdRatio: 0.001, headroomTokens: 256, retainTokens: 64, maxTokens: 256` so a 1×1 image plus a short prompt trips the threshold.
- **Non-obvious design decisions:** the thresholds are absurdly small on purpose — the scenario must compact *deterministically*, not "usually".
- **Edge cases / failure handling:** the recorded provider advertises `inputModalities: [text, image]` so the replay accepts the image request.
- **Surprising:** `maxTokens: 256` on the compaction call is also pinned, so the summary's length is part of the contract.

### `snapshots/sdk/system-prompt-in-history/notifications.expected.jsonl`
- **Purpose:** the scenario that pins the cache-preserving system-prompt-change route.
- **Key abstractions:** `request/context.systemPromptUpdate: "in-history"`, `system/message` with `surfaceOp:"append"`.
- **Data flow:** step 1 calls `read`; step 2 begins with a **second** `system/message` (line 17) carrying the changed prompt, appended *after* the tool result; the request/header is **not** re-emitted (there is exactly one header in the whole turn).
- **Non-obvious design decisions:** the changed prompt is appended to the conversation rather than replacing surface node 0 — replacing node 0 would invalidate the provider's cached prefix. `request/context` reports the route so a consumer knows the prompt was updated in-history rather than at the head.
- **Edge cases / failure handling:** the suite asserts both system messages have `surfaceOp:"append"` and that the second one lands *after* the tool result (sdk.snapshot.ts:1190) — an in-history update that arrived before the tool result would be a different (and cache-breaking) route.
- **Surprising:** there is still only **one** `request/header` — the tool set did not change, so the request is unchanged and no new header is needed.

### `snapshots/sdk/system-prompt-in-history/replay.override.json`
- **Purpose:** the two scripted model responses for this scenario.
- **Key abstractions:** `kind:"chunks"` entries carrying a raw chunk list.
- **Data flow:** response 1 is a `tool-call` block for `read` with `argumentsDelta:"{\"file_path\":\"task.txt\"}"`; response 2 is the text `DONE` with `usage {inputTokens:12, outputTokens:2, cacheReadTokens:10}`.
- **Non-obvious design decisions:** the second response's `cacheReadTokens: 10` makes the cache hit *visible in the golden*, so a regression that loses the cached prefix would change the pinned usage.
- **Edge cases / failure handling:** the override replaces the session-derived script entirely (`DSH_SNAPSHOT_OVERRIDE`), so the scenario does not depend on the parent fixture's turn structure.
- **Surprising:** the same override file also serves as the *prompt-change* trigger — the change is injected by the fixture at read time, not by the model.

### `snapshots/sdk/tool-error-details/notifications.expected.jsonl`
- **Purpose:** the scenario that pins how a denial is presented at each layer.
- **Key abstractions:** `error {name, code, reason}` on a tool result; `tool/ptc-dispatch` with `isError`; `request/header` with `reason:"change"` and `startsSeries:true`.
- **Data flow:** step 1 calls `bash` → the result is `isError:true` with `error {name:"AutoReviewDeniedError", code:"AUTO_REVIEW_DENIED", reason:"  transport raw\r\nreason  "}` (line 14). Step 2 **replaces** the system message (`surfaceOp {op:"replace", startSeq:7, endSeq:7}`, line 17), re-emits the header with `tools:["run_code"]` and `startsSeries:true` (line 18), and emits a `developer/message` listing one `tool-addition` and 25 `tool-removal`s (line 19). The model then calls `run_code`, whose inner `bash` is denied again: the inner `tool/ptc-dispatch` carries `isError:true` + the error (line 23), but the **outer** `tool/result` is `isError:false` and the denial text is program output (line 24).
- **Non-obvious design decisions:** the `reason` string is `"  transport raw\r\nreason  "` — leading spaces and an embedded CRLF, preserved verbatim — so a consumer cannot normalise it away. The denial body is the reason the tool's body was not executed.
- **Edge cases / failure handling:** the native and PTC denials are *deliberately different shapes* — the outer call in the PTC case succeeded (the program caught the error), so reporting it as an outer failure would be a lie.
- **Surprising:** the suite asserts the PTC dispatch events carry **no** `description`, `parameters` or `schema` fields (sdk.snapshot.ts:1083) — the inner dispatch is a runtime record, not a tool definition.

### `snapshots/sdk/tool-error-details/system-prompt.expected.md`
- **Purpose:** the pinned prompt for the native→PTC transition (578 lines).
- **Key abstractions:** the base prompt, then a `<!-- system/message change 1 -->` section, then the "Writing code for run_code" appendix.
- **Data flow:** the appendix (line 67) teaches the PTC dialect: `code` is the body of an async TypeScript function, *erasable syntax only*; the declarations are SDK bindings and *"A declaration does not make its name a directly callable tool"*.
- **Non-obvious design decisions:** the appendix states the concurrency contract — *"Independent read-only calls MAY overlap under `Promise.all` (safe calls run concurrently; mutating calls run alone, in submission order)"* (line 77) — and the output contract — *"Only what you print or return is program output. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation"* (line 78). The whole tool catalogue then follows as a `ToolArgsMap` TypeScript declaration (line 82+) with `ToolCallError` carrying `toolName` (line 570).
- **Edge cases / failure handling:** the change-1 section opens with "`run_code` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program." — the prompt states the constraint instead of letting the model discover it by denial.
- **Surprising:** the prompt is **578 lines** for a 25-tool catalogue — the appendix is larger than the tool JSON it mirrors, because the JSON Schema cannot express "mutating calls run alone".

### `snapshots/sdk/tool-error-details/deny.mjs`
- **Purpose:** the fixture that produces a deterministic structured denial.
- **Key abstractions:** `inject = ['tools']`; the `tools/pre-execute` and `tools/result` hooks.
- **Data flow:** `tools/pre-execute` intercepts only the exact command `echo AUTO_DENIED` and returns `{kind:"deny", reason:"Auto review rejected tool \"bash\"; its body was not executed", info:{name:"AutoReviewDeniedError", code:"AUTO_REVIEW_DENIED", reason:"  transport raw\r\nreason  "}}`.
- **Non-obvious design decisions:** the `reason` field carries deliberately messy whitespace and a CRLF — the fixture is testing that the transport preserves the raw string, not that it is tidy. The comment says *"it does not enable Auto"* — the fixture is a stand-in, not the real policy.
- **Edge cases / failure handling:** `tools/result` then flips that one agent to PTC presentation (`exec.agent.ctx.tools.presentAs('ptc')`) so the second denial travels the PTC path — one scenario, two transports.
- **Surprising:** the denial is produced *before execution* and the reason explicitly says "its body was not executed" — the model is told the side effect did not happen, so it can retry safely.

### `snapshots/sdk/tool-error-details/runtime.cordis.yml`
- **Purpose:** the replay-time patch that swaps the tool presentation and inserts the denial fixture.
- **Key abstractions:** `tools.config.mode: native`, plus two inserted plugins.
- **Data flow:** the run starts native (so the first denial is a native one), the denial fixture then switches that agent to PTC for the second call.
- **Non-obvious design decisions:** the mode is set at *runtime*, not in the composition, because the transition itself is what the scenario tests.
- **Edge cases / failure handling:** `runtime.cordis.yml` is only applied in replay/refresh mode; the record mode uses the live composition.
- **Surprising:** the same file both sets `mode: native` and inserts `@deepseek-ai/dsh-ptc-runtime-node` — the PTC runtime is available even while the presentation is native.

### `snapshots/sdk/tool-scheduler-recovery/session.v4.jsonl`
- **Purpose:** the scenario that pins what happens when the tool scheduler fails mid-turn.
- **Key abstractions:** `ToolOutcomeUnknownError`/`TOOL_OUTCOME_UNKNOWN` and `ToolNotStartedError`/`TOOL_NOT_STARTED`.
- **Data flow:** the model emits three `todo_write` calls in one message. The first completes (`Updated todo list: 0 pending, 0 in progress, 0 completed.`). The second fails in the scheduler → a tool result with `isError:true`, `error {name:"ToolOutcomeUnknownError", code:"TOOL_OUTCOME_UNKNOWN"}` and the text *"The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly."* (line 20). The third never started → a result with `TOOL_NOT_STARTED` and *"The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed."* (line 21).
- **Non-obvious design decisions:** the two interruptions are **different codes with different advice** — "we do not know if it ran" versus "it definitely did not run" — and the advice is written as a *policy for the model*, not as a stack trace. The messages also carry synthetic ids (`interrupted-tool-result-scheduler-fail-18`) so they are addressable.
- **Edge cases / failure handling:** the turn ends `{kind:"error", error:{message:"Snapshot scheduler preparation failed", code:"UNKNOWN"}}` (line 23) and the *next* turn is spliced in with "Continue after the scheduler failure without repeating any tools." — the turn boundary is where recovery happens.
- **Surprising:** the failed call still produced a `todo/write` side event for the first call only — the harness records what actually executed, so the transcript distinguishes "the tool ran" from "the tool was recorded".

### `snapshots/sdk/tool-scheduler-recovery/scheduler-failure.mjs`
- **Purpose:** the fixture that fails exactly one scheduler preparation.
- **Key abstractions:** `ctx.tools` symbol lookup for `@deepseek-ai/dsh-tools.scheduler`; `ctx.effect` for scoped patching.
- **Data flow:** it finds the live scheduler instance via `Object.getOwnPropertySymbols(ctx.tools).find(s => s.description === '@deepseek-ai/dsh-tools.scheduler')`, wraps `prepare`, and throws for `input.callId === 'scheduler-fail'` — restoring the original *before* throwing.
- **Non-obvious design decisions:** the symbol lookup rather than a service accessor is stated as deliberate: *"Inspect the active instance's key so the fixture cannot introduce a second tools module."* The patch is installed inside `ctx.effect`, so it is undone on teardown.
- **Edge cases / failure handling:** if the scheduler symbol is absent the fixture throws at load time — the scenario fails loudly rather than silently not failing.
- **Surprising:** the failure is injected at the **prepare** stage, which is before the call is recorded as started — that is exactly what produces the two distinct interruption codes in the log.

### `snapshots/sdk/ptc-turn/notifications.expected.jsonl`
- **Purpose:** the programmatic-tool-calling round trip.
- **Key abstractions:** `tool/ptc-dispatch-start` / `tool/ptc-dispatch` with `rootCallId` / `parentCallId` / `subCallId`.
- **Data flow:** one `run_code` call (line 13) becomes two inner dispatches with subCallIds `call_00_…:ptc:1` and `call_00_…:ptc:2` (lines 14, 18), each with its own `job/registered` and `job/settled`; the outer result (line 22) contains only the program output `"captured output\nCODE_ONE+CODE_TWO"`.
- **Non-obvious design decisions:** the sub-call id is derived from the root id (`<root>:ptc:<n>`) and every inner call carries `rootCallId` back to the model-visible call, so a UI can group them.
- **Edge cases / failure handling:** the model's own `tools.bash({...})` calls inside the program are real tool calls with their own job lifecycle — the program does not bypass the scheduler.
- **Surprising:** step 2 reports `cacheReadTokens: 6272` against `inputTokens: 117` — the tool catalogue in the prompt is cached across the whole turn.

### `snapshots/sdk/persistent-tools/notifications.expected.jsonl`
- **Purpose:** the scenario that proves a *persistent* shell and a string editor behave as advertised.
- **Key abstractions:** `bash` with persistent state, `str_replace_editor` with `view`/`create`/`str_replace`.
- **Data flow:** three bash calls prove state carries (`COUNT=1 CWD=/tmp`, then `COUNT=2 CWD=/tmp`), a delayed pipeline proves long-running output, three editor calls create/view/replace `note.txt`, and a final `exit` call proves the reset path.
- **Non-obvious design decisions:** the editor's `view` output is line-numbered (`1  target:` / `2 \told`), and the final bash result (line 44) carries the explicit text *"The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment."*
- **Edge cases / failure handling:** a persistent shell that dies is **told to the model** rather than silently resetting — otherwise the next call's working directory is a trap.
- **Surprising:** the shell's exit is reported as `exit\n[shell exited: code 9]` — the model's own `exit` command is echoed back with the exit code, so a model that reads its own output sees the cause of the reset.

### `snapshots/sdk/persistent-tools/cordis.yml`
- **Purpose:** the live patch for the minimal `sdk-minimal` composition.
- **Key abstractions:** ~25 plugins disabled, 6 inserted (`bash-local`, `fs-local`, `terminal`, `terminal-bash`, `persistent-bash`, `tool-str-replace-editor`).
- **Data flow:** the patch reduces the product to a persistent shell plus a string editor, with `sandbox-policy.mode: danger-full-access` and `approval.policy: never`.
- **Non-obvious design decisions:** `system-prompt` is reconfigured with `includeHarnessIdentity: false` and a `personaPrefix` from `DSH_SYSTEM_PROMPT`, and the persistent-bash tool carries its own long `description` block explaining the XML-escaping rule, the offline mirrors, the persistent state, `sed -n` for line ranges and the "run long lived commands in the background" advice.
- **Edge cases / failure handling:** `session-persistence-jsonl.compression: none` is hard-coded here (not env-dependent) because the composition is always snapshot-only.
- **Surprising:** the persistent-bash description is a *mini system prompt inside one tool description* — the guidance a model needs about a specific tool lives in that tool's schema, not in the global prompt.

### `snapshots/sdk/subagent-activation-limit/session.v4.jsonl`
- **Purpose:** the scenario that pins what a child-capacity refusal looks like.
- **Key abstractions:** `error {name:"SubagentError", code:"ACTIVATION_LIMIT_REACHED"}`.
- **Data flow:** step 1 spawns a child (`call_first`, succeeds, `subagent/catalog` written); step 2 tries a second child (`call_over_capacity`) and gets a refusal (line 23); step 3 answers; turn 2 receives the child's settlement notice.
- **Non-obvious design decisions:** the refusal text is *"subagent limit reached (active child limit: 1); wait for an existing child to finish or complete this work with the current agents"* — it states the limit, the cause, and **two** ways forward (wait, or do the work yourself).
- **Edge cases / failure handling:** the refusal is an ordinary `tool/result` with `isError:true`; the turn is not aborted and the already-running child still settles into turn 2.
- **Surprising:** the effective limit is **1** even though `cordis.yml` sets `maxActiveSubagents: 8` — the fixture plugin narrows it, and the golden pins the *effective* value.

### `snapshots/sdk/subagent-send-message/session.v4.jsonl`
- **Purpose:** the scenario that pins a child→parent message and the settlement notice.
- **Key abstractions:** `source {kind:"agent-message", form:"relay", senderSessionId}` and `source {kind:"subagent-settled", form:"notice", summary, senderSessionId}`.
- **Data flow:** turn 1 spawns the child (`call_bg_start`); turn 2 is spliced with two user messages — the child's relayed message and the settlement notice; turn 3 answers the human.
- **Non-obvious design decisions:** the settlement notice (line 31) reads *"Background subagent {{session:2}} finished and will do no further work unless you send it more."* followed by *"Its closing message:"* and the child's payload — the parent is told both that the child is **done** and that it is **still addressable**.
- **Edge cases / failure handling:** the relay and the notice are separate messages, so the parent can distinguish "the child spoke" from "the child finished".
- **Surprising:** the notice is delivered as a *user* message, not a developer or system one — the child's output is treated as something the user of the parent turn said.

### `snapshots/sdk/subagent-send-message/session.1.v4.jsonl`
- **Purpose:** the child-side log for the send-message scenario.
- **Key abstractions:** `subagent/descriptor {version:3, mode:"continuable", provider:"spawn", label, agentProvider, agentModel}`.
- **Data flow:** the child runs its own turn, calls `send_message` (result: "message delivered to agent {{session:1}}"), then answers "Message sent."
- **Non-obvious design decisions:** the child's runtime context carries **two extra sections** the parent does not have — `tool:subagent:depth` and `tool:subagent_fork:depth` (line 12) — each stating *"current 1, maximum 1, remaining levels 0. Do not call `subagent` at this depth; carry out the work directly."* The limit is told to the model, not only enforced.
- **Edge cases / failure handling:** `subagent:delegation` additionally warns that the permission scope is fixed and cannot be widened from inside the session.
- **Surprising:** the depth notice is per-*tool* (`tool:subagent:depth`, `tool:subagent_fork:depth`), so a child that has one delegation route left is told exactly which route is closed.

### `snapshots/sdk/subagent-spawn-in-process/session.1.v4.jsonl`
- **Purpose:** the child log proving an in-process spawn now completes.
- **Key abstractions:** `subagent/descriptor {version:3, mode:"continuable", provider:"spawn", label:"echo probe", agentProvider, agentModel}`.
- **Data flow:** the child runs one turn and answers `child answer 42.`
- **Non-obvious design decisions:** the descriptor records the *route* (`provider:"spawn"` vs `"fork"`), the *mode* (`"one-shot"` vs `"continuable"`) and the child's own model — the delegation decision is durable, not inferred.
- **Edge cases / failure handling:** this file exists in three generations; the v2/v3 siblings record the pre-fix failure (see below), so the fix is visible as a diff.
- **Surprising:** the child's *own* header carries `delegationDepth: 1` — the depth is on the session header, not only in the parent's prompt.

### `snapshots/sdk/subagent-dsh-sdk-dynamic-route/session.v4.jsonl`
- **Purpose:** the scenario where the model picks the child's provider and model at call time.
- **Key abstractions:** `subagent/model-selection-policy {allowedModels:[{provider, model}]}`.
- **Data flow:** the parent calls `subagent` with `provider:"mock", model:"mock-routed", reasoning_effort:"max"`; the child answers "child route: mock/mock-routed/max/777; cwd: {{cwd}}".
- **Non-obvious design decisions:** the policy event is written into the *parent's* log, so the allowed set that constrained the call is auditable after the fact.
- **Edge cases / failure handling:** `maxTokens: 777` came from the parent's `agentOptions` and is visible in the child's own reply — the child's configuration is observable end to end.
- **Surprising:** the same call carried a *route* (`mock/mock-routed/max/777`) — provider, model, reasoning effort and token budget all travel through one tool call and are all visible in the child's answer.

### `snapshots/sdk/session-resume/session.v4.jsonl`
- **Purpose:** the scenario that pins a session resume.
- **Key abstractions:** `session/end-seed`, `request/header` with `reason:"resume"`.
- **Data flow:** turn 1 answers ONE; a `session/end-seed` row (line 18) marks the seed boundary; turn 2 answers TWO under a **new** header with `reason:"resume"` (line 24).
- **Non-obvious design decisions:** the resumed turn emits a fresh `request/header` with the same tool set, so the consumer knows the request was re-asserted even though nothing changed.
- **Edge cases / failure handling:** the second turn's `inputTokens` is 64 against the first turn's 2864, with `cacheReadTokens: 2816` — the prefix was reused across the resume.
- **Surprising:** the resumed turn has **no** `system/message` — the system prompt is not re-emitted on resume, because it is already in the history.

### `snapshots/sdk/multi-turn/snapshot.yml`
- **Purpose:** the manifest that pins a *historical* session format as the replay input.
- **Key abstractions:** `sessionFormat: {version: 2, coverage: [adjacent-migration]}`.
- **Data flow:** the scenario keeps `session.v2.jsonl` as the canonical replay input and adds `writer.expected.jsonl` as the current-writer oracle.
- **Non-obvious design decisions:** `coverage` names *why* the old generation is retained, so a curation pass can tell "keep this as a migration fixture" from "stale leftover".
- **Edge cases / failure handling:** with `sessionFormat` declared the scenario is **read-only in record mode** (`it.skip`, sdk.snapshot.ts:926) — a migration fixture can never be silently overwritten by a re-record.
- **Surprising:** the manifest carries no `header.pin` — a migration fixture deliberately does not own a prompt pin, because the prompt of a v2 session is not the current prompt.

### `snapshots/sdk/multi-turn/writer.expected.jsonl`
- **Purpose:** the *writer oracle* — what today's writer emits for the same conversation.
- **Key abstractions:** a full v4 session log (25 rows) that is **not** a replay input.
- **Data flow:** `expectedContents` for a retained scenario is read from `writer.expected.jsonl` (sdk.snapshot.ts:1098) and compared against the harvested native output.
- **Non-obvious design decisions:** the corpus keeps *two* artefacts for a historical scenario: the old bytes (the replay input, never rewritten) and the new bytes (the writer oracle). The comparison uses `nativeWriterOutput: true` so delivery markers are tokenised only for the qualifying generation.
- **Edge cases / failure handling:** the retained fixture is asserted byte-identical after the run (line 1143) and its header version must be ≤ the current `SESSION_FORMAT_VERSION` (line 1146).
- **Surprising:** the writer oracle shows `cacheReadTokens: 2816` on the second turn against `inputTokens: 64` — the same provider-cache arithmetic is part of the pinned output.

### `snapshots/sdk/serial-created/session.jsonl`
- **Purpose:** the oldest retained generation — the packed-row layout.
- **Key abstractions:** `assistant/chunk`, `reasoning-chunks`, `text-chunks` as *separate rows*, and `sourceEventSeqs` as an expanded array.
- **Data flow:** the stream is written row-by-row (lines 15–22) and the final `assistant/message` (line 23) carries `sourceEventSeqs:[13,14,…,41]` — the packed row's expansion.
- **Non-obvious design decisions:** the historical format keeps the raw chunks as first-class rows; the current format folds them into a `stream` array inside the message.
- **Edge cases / failure handling:** the current writer uses one row per event; packed rows only survive in retained v0/v1 fixtures and are handled by a separate migrator.
- **Surprising:** the `request/header` in v0 still carries `"system":"{{system}}"` *and* the log has no `system/message` — the prompt was purely a request-header field at this generation.

### `snapshots/sdk/max-tokens-continue/session.v3.jsonl`
- **Purpose:** the scenario that pins a length-truncated response and the turn after it.
- **Key abstractions:** `turn/end {kind:"max-tokens"}`, and a `replayState` block recording the original provider stop reason.
- **Data flow:** turn 1 emits a text block, *starts* a `bash` tool call whose arguments are cut mid-string (`{"command":"echo demo > `) and finishes with `reason {kind:"max-tokens"}`; the `replayState` records `stopReason:"length"` (line 15); the turn ends `max-tokens` (line 17); a new turn is spliced in and completes.
- **Non-obvious design decisions:** the half-emitted tool call is **kept in the transcript** — it is not discarded — so the next turn's model can see that it tried and was cut off. The `replayState.response.blocks` records `[{type:"text"}]` for the *message* while the stream shows `[{type:"text"},{type:"tool-call"}]` — the discrepancy is the truncation.
- **Edge cases / failure handling:** the suite asserts the interrupted recording normalises equal to one whose turn 1 ends `{kind:"interrupted"}` (sdk.snapshot.ts:913-921), i.e. a length stop and an interruption are the same shape to the model.
- **Surprising:** the tool call's arguments are cut mid-JSON — the harness tolerates a truncated argument string without executing it.

### `snapshots/sdk/account-provider-signout/notifications.expected.jsonl`
- **Purpose:** the scenario that pins a provider-side abort.
- **Key abstractions:** `turn/end {kind:"aborted", reason:{kind:"hook", reason:"deepseek-account/signed-out"}}`, `interrupted: true` on the assistant message.
- **Data flow:** the provider streams one text block ("Before sign-out"), the fixture emits the signed-out hook, the request signal is aborted, the assistant message is appended with `interrupted:true` and no `usage`, and the turn ends aborted.
- **Non-obvious design decisions:** the *partial* text is preserved and surfaced — the user sees what arrived before the sign-out.
- **Edge cases / failure handling:** the abort is attributed to a named hook reason, so a UI can say "signed out" rather than "network error".
- **Surprising:** the header for this scenario carries `adapterDefaults {reasoningEffort:true, maxTokens:true}` and `maxTokens: 256000` — the account adapter *asserts* which knobs it owns, and the golden pins that assertion.

### `snapshots/sdk/account-provider-signout/account-signout.mjs`
- **Purpose:** the fixture that reproduces a provider sign-out deterministically.
- **Key abstractions:** `inject = ['llm','agents']`; the `llm/stream` hook.
- **Data flow:** for provider `deepseek-account` it yields a `block-start` and one `text-delta`, emits `deepseek-account/signed-out`, then calls `request.signal.throwIfAborted()`.
- **Non-obvious design decisions:** the doc comment says *"Deterministic transport boundary; cancellation belongs to the shipped account provider"* — the fixture supplies only the trigger, and the real provider's cancellation logic does the rest.
- **Edge cases / failure handling:** the abort is a real `AbortSignal` throw, so the harness's abort path is exercised rather than simulated.
- **Surprising:** `request.signal.throwIfAborted()` is called *after* the sign-out event — the ordering is what makes the abort a consequence of the event.

### `snapshots/session/advanced-toolchain/session.v4.jsonl`
- **Purpose:** the headless scenario that exercises the full tool chain (inspect → PTC → subagent → workflow → inspect).
- **Key abstractions:** `tool-workflow/run-start` / `agent-start` / `agent-end` / `run-end`, `developer/message` tool-registry updates.
- **Data flow:** step 1 calls `cordis_inspect_list`; step 2 **replaces** the system message and re-emits the header (`reason:"change"`) before calling `run_code` under PTC; step 3 repeats the replace/change for the subagent; the child's settlement arrives between steps; step 4 runs a workflow; step 5 inspects again and the provider list differs.
- **Non-obvious design decisions:** the second `cordis_inspect_list` is the *point* of the scenario — it proves the mid-run tool-surface changes actually took effect in the runtime, not just in the prompt.
- **Edge cases / failure handling:** each mid-run change is a `system/message` replacement plus a `request/header` with `reason:"change"` plus a `developer/message` — three artefacts, one transition.
- **Surprising:** the workflow step produces its own `subagent/catalog` entry, so a workflow's children are catalogued exactly like a directly spawned child.

### `snapshots/session/advanced-toolchain/cordis.yml`
- **Purpose:** the live patch for the `advanced-toolchain` composition.
- **Key abstractions:** `tools.config.mode: native`, the cordis host runner, the cordis inspect tools, the presentation fixture.
- **Data flow:** the patch installs the tools, then the presentation fixture flips the parent between native and PTC *at runtime*.
- **Non-obvious design decisions:** the system persona is deliberately short ("Verify your work by running the code or tests") so the pinned prompt's size comes from the tool appendix, not from prose.
- **Edge cases / failure handling:** the patch is identical in live and replay mode except for the provider swap in `cordis.snapshot.yml`.
- **Surprising:** `mode: native` is set explicitly even though native is the default — the scenario needs the switch to be *visible* in the composition.

### `snapshots/session/advanced-toolchain/presentation.mjs`
- **Purpose:** the fixture that flips one agent between native and PTC presentation.
- **Key abstractions:** a `WeakMap` of agents to their restore function.
- **Data flow:** on `tools/result`, if the parent called `cordis_inspect_list` it calls `exec.agent.ctx.tools.presentAs('ptc')` and stores the returned restore function; when the parent calls `run_code` it restores native presentation first.
- **Non-obvious design decisions:** the restore is keyed per agent in a `WeakMap`, so a child agent's presentation is never disturbed by the parent's switch.
- **Edge cases / failure handling:** the hook ignores results with `result.error !== undefined` and any call with a `parent` — so a child's calls never trigger the parent's presentation change.
- **Surprising:** the fixture asserts the *ordering* it needs — PTC must be active for the `run_code` step but restored before the next child is created — which is why the switch is per-agent rather than global.

---


### `snapshots/sdk/subagent-spawn-in-process/session.1.v3.jsonl`
- **Purpose:** the retained v3 child log that records the *pre-fix* failure of an in-process spawn.
- **Key abstractions:** `assistant/attempt` whose only chunk is a `finish` with `reason.kind:"error"`.
- **Data flow:** the child is spawned, the harness asks for a model response, and the replay layer refuses: *"llm-replay: script exhausted — session requested model call #1 but its script has only 0; re-record the scenario"* (line 15).
- **Non-obvious design decisions:** the failure is written into the **child's** log rather than the parent's, so the corpus shows *where* the request died — the parent had already been told the child started.
- **Edge cases / failure handling:** the turn ends `{kind:"error", error:{message:"…", code:"UNKNOWN"}}` (line 17); the code is `UNKNOWN` because the replay layer has no richer taxonomy.
- **Surprising:** the v4 sibling of this exact file answers normally, so the pair is a before/after of a single fix expressed as a golden diff.

### `snapshots/sdk/inline-image-prompt/session.v4.jsonl`
- **Purpose:** the scenario that pins the inline-image prompt route and the image-budget repair.
- **Key abstractions:** `assistant/attempt` with `failure.code:"IMAGE_OFFLOAD_REQUIRED"`, `image/offload`.
- **Data flow:** the turn's prompt carries an inline image attachment; the first attempt fails with *"DeepSeek base64 request images exceed the route budget; 3 more oldest occurrence(s) must be offloaded."* and `offloadImages: 3` (line 15); `image/offload` then names `targets:[{seq:8, imageIndexes:[0,1,2]}]` (line 16) — the **oldest** occurrences first; a new `request/header` with `reason:"series"` retries and the turn completes.
- **Non-obvious design decisions:** the provider names both the failure code *and the count* to offload, and the harness targets specific image indexes rather than dropping the whole message.
- **Edge cases / failure handling:** the offload is a durable event, so a replay can prove which image bytes were removed from which message.
- **Surprising:** "3 more **oldest** occurrence(s)" — the repair order is deterministic (oldest first), not arbitrary, so the same request always sheds the same bytes.

### `snapshots/sdk/tool-scheduler-recovery/notifications.expected.jsonl`
- **Purpose:** the SDK wire projection of the scheduler failure and the recovery turn.
- **Key abstractions:** `command/run` / `command/done`; `todo/write`; the two interruption tool results.
- **Data flow:** the assistant emits three `todo_write` tool calls in one message; the first succeeds, the second fails in the scheduler and the third never starts; the two failures arrive as `tool/result` rows carrying `isError:true` and their distinct `error` codes; `turn/end` reports `{kind:"error", error:{message:"Snapshot scheduler preparation failed", code:"UNKNOWN"}}`; a *new* turn is then spliced in ("Continue after the scheduler failure without repeating any tools.") and the model answers `SCHEDULER_RECOVERY_OK`.
- **Non-obvious design decisions:** the recovery is a **new turn**, not a retry of the failed one — the transcript keeps the failure visible and the next turn starts clean, which is what makes "do not repeat any tools" enforceable by the model rather than by the harness.
- **Edge cases / failure handling:** the fixture asserts exactly three tool results with the roles `['tool','scheduler-complete',false], ['tool','scheduler-fail',true], ['tool','scheduler-unstarted',true]` (sdk.snapshot.ts:1054) — the *count* is part of the contract, so a harness that silently swallowed the third call would fail.
- **Surprising:** the interrupted results carry no `sourceEventSeqs` on the third one (it never reached the scheduler), while the second points at the `tool/call` that started it — the back-reference reflects where the failure actually happened.
### Remaining fixtures (one specific line each)

Every file below was opened and read; the line states what it is and what it pins. Files marked *(skipped)* were opened and fully enumerated but not read body-line by body-line — see **Files skipped** below.

- `snapshots/sdk/account-provider-signout/cordis.snapshot.yml` — Keyless replay patch for account-provider-signout: an empty list [] - the recorded provider is replaced by nothing because the fixture drives the transport itself and no model call is replayed.
- `snapshots/sdk/account-provider-signout/cordis.yml` — account-provider-signout live record patch for the Cordis plugin graph: [skill-filesystem, llm-deepseek-account, session-persistence-jsonl, tool-subagent, account-signout-fixture]
- `snapshots/sdk/account-provider-signout/result.expected.json` — account-provider-signout expected SDK RunResult: finalResponse 'Before sign-out'
- `snapshots/sdk/account-provider-signout/session.v3.jsonl` — account-provider-signout parent session log (format v3): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [aborted]
- `snapshots/sdk/account-provider-signout/session.v4.jsonl` — account-provider-signout parent session log (format v4): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [aborted]
- `snapshots/sdk/account-provider-signout/snapshot.yml` — account-provider-signout manifest: profile=sdk, composition=sdk-account-provider-signout, recording=authored, header class=sdk-account-provider-signout; pins its own header; prompt pin shared with text-turn; schema pin shared with text-turn
- `snapshots/sdk/account-provider-signout/system-prompt.expected.md` — One-line POINTER file: ../text-turn/system-prompt.expected.md - the signout scenario reuses the text-turn prompt pin instead of duplicating it.
- `snapshots/sdk/account-provider-signout/tool-schemas.expected.json` — One-line POINTER file: the account-provider-signout schema pin is not a copy but the relative path ../text-turn/tool-schemas.expected.json, so the catalogue exists exactly once in the corpus.
- `snapshots/sdk/bash-tool/cordis.snapshot.yml` — bash-tool keyless replay patch for the Cordis plugin graph: [llm-deepseek, llm-replay, deepseek-official, deepseek-v4-flash, session-log-deepseek]; disables 1 plugin(s); swaps the live provider for the keyless llm-replay provider; disables the external session uploader
- `snapshots/sdk/bash-tool/result.expected.json` — bash-tool expected SDK RunResult: finalResponse 'dsh-sdk-proof-7391'
- `snapshots/sdk/bash-tool/session.v2.jsonl` — bash-tool parent session log (format v2): 1 turn(s), 2 step(s); tools [bash]; turn-end reasons [completed]
- `snapshots/sdk/bash-tool/session.v3.jsonl` — bash-tool parent session log (format v3): 1 turn(s), 2 step(s); tools [bash]; turn-end reasons [completed]
- `snapshots/sdk/bash-tool/session.v4.jsonl` — bash-tool parent session log (format v4): 1 turn(s), 2 step(s); tools [bash]; turn-end reasons [completed]
- `snapshots/sdk/bash-tool/snapshot.yml` — bash-tool manifest: profile=sdk, composition=sdk-default, recording=live, header class=sdk-default; pins its own header
- `snapshots/sdk/bash-tool/system-prompt.expected.md` — bash-tool pinned parent system prompt (27 lines): opens 'You are an AI agent powered by DeepSeek Harness.'
- `snapshots/sdk/bash-tool/tool-schemas.expected.json` — Generated golden tool-schema catalogue (26838 bytes, 25 initial tools + 0 recorded header change set(s)); tools [bash,create_goal,edit,exit_plan_mode,get_goal,glob,grep,interrupt_agent,job_kill,job_list,job_output,list_agents,read,read_image,send_message,skill,subagent,subagent_fork,todo_write,update_goal,web_fetch,web_search,workflow,working_directory,write]. Opened and fully enumerated (every tool name, every required-argument list and every change set parsed) but NOT read line by line - it is bulk generated schema output with no behaviour of its own beyond the tool catalogue it pins. *(skipped)*
- `snapshots/sdk/dynamic-tool-updates/result.expected.json` — dynamic-tool-updates expected SDK RunResult: finalResponse 'DONE'
- `snapshots/sdk/dynamic-tool-updates/session.v4.jsonl` — dynamic-tool-updates parent session log (format v4): 1 turn(s), 3 step(s); tools [read,snapshot_ping]; turn-end reasons [completed]; features: developer tool-registry update
- `snapshots/sdk/dynamic-tool-updates/snapshot.yml` — dynamic-tool-updates manifest: declares header.changes 2 - the scenario exists to prove the tool surface can change twice inside one turn.
- `snapshots/sdk/dynamic-tool-updates/workspace/task.txt` — workspace workspace seed file: 'Reply with the single word DONE after reading this file. '
- `snapshots/sdk/inline-image-prompt/session.v2.jsonl` — inline-image-prompt parent session log (format v2): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/inline-image-prompt/session.v3.jsonl` — inline-image-prompt parent session log (format v3): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]; features: image-offload, assistant-attempt
- `snapshots/sdk/inline-image-prompt/session.v4.jsonl` — inline-image-prompt parent session log, format v4: the request carries an inline image attachment; the first attempt is refused with an image-offload, the image is offloaded and a new request/header with reason "series" succeeds.
- `snapshots/sdk/inline-image-prompt/snapshot.yml` — inline-image-prompt manifest: profile=sdk, composition=image, recording=authored, header class=image; carries one inline image attachment
- `snapshots/sdk/max-tokens-continue/session.v2.jsonl` — max-tokens-continue parent session log (format v2): 2 turn(s), 2 step(s); tools [none]; turn-end reasons [max-tokens,completed]
- `snapshots/sdk/max-tokens-continue/session.v4.jsonl` — max-tokens-continue parent session log (format v4): 2 turn(s), 2 step(s); tools [none]; turn-end reasons [max-tokens,completed]
- `snapshots/sdk/max-tokens-continue/snapshot.yml` — max-tokens-continue manifest: profile=sdk, composition=default, recording=authored, header class=default
- `snapshots/sdk/minimal-image-compaction/cordis.yml` — minimal-image-compaction live record patch for the Cordis plugin graph: [session-log-deepseek]
- `snapshots/sdk/minimal-image-compaction/result.expected.json` — minimal-image-compaction expected SDK RunResult: finalResponse 'MINIMAL_IMAGE_OK'
- `snapshots/sdk/minimal-image-compaction/snapshot.yml` — minimal-image-compaction manifest: profile=sdk-minimal, composition=sdk-minimal-image-compaction, recording=authored, header class=sdk-minimal-image-compaction; pins its own header
- `snapshots/sdk/minimal-image-compaction/system-prompt.expected.md` — minimal-image-compaction pinned parent system prompt (1 lines): opens 'Y'; persona-only one-liner (harness identity disabled)
- `snapshots/sdk/minimal-image-compaction/tool-schemas.expected.json` — minimal-image-compaction pinned parent tool-schema catalogue: initial=3 tools [bash,read_image,working_directory]; 2 header change set(s) recorded
- `snapshots/sdk/minimal-image-compaction/workspace/red.png` — Binary PNG seed image (69 bytes): a 1x1 pixel image. Not read line by line because it is binary; verified as a valid 1x1 image/png by its bytes and by the suite's own assertion of mediaType/bytes/width/height at snapshots/sdk/sdk.snapshot.ts:959-962. *(skipped)*
- `snapshots/sdk/multi-turn/session.v2.jsonl` — multi-turn parent session log (format v2): 2 turn(s), 2 step(s); tools [none]; turn-end reasons [completed,completed]
- `snapshots/sdk/persistent-tools/cordis.snapshot.yml` — persistent-tools keyless replay patch for the Cordis plugin graph: [llm-deepseek, llm-replay, deepseek-official, deepseek-v4-flash, session-log-deepseek]; disables 1 plugin(s); swaps the live provider for the keyless llm-replay provider; disables the external session uploader
- `snapshots/sdk/persistent-tools/result.expected.json` — persistent-tools expected SDK RunResult: finalResponse 'PERSISTENT_TOOLS_OK'
- `snapshots/sdk/persistent-tools/session.v2.jsonl` — persistent-tools parent session log (format v2): 1 turn(s), 8 step(s); tools [bashx4,str_replace_editorx3]; turn-end reasons [completed]
- `snapshots/sdk/persistent-tools/session.v3.jsonl` — persistent-tools parent session log (format v3): 1 turn(s), 8 step(s); tools [bashx4,str_replace_editorx3]; turn-end reasons [completed]
- `snapshots/sdk/persistent-tools/session.v4.jsonl` — persistent-tools parent session log (format v4): 1 turn(s), 8 step(s); tools [bashx4,str_replace_editorx3]; turn-end reasons [completed]
- `snapshots/sdk/persistent-tools/snapshot.yml` — persistent-tools manifest: profile=sdk, composition=sdk-minimal, recording=live, header class=sdk-minimal; pins its own header; compares the final workspace
- `snapshots/sdk/persistent-tools/system-prompt.expected.md` — persistent-tools pinned parent system prompt (1 lines): opens 'Y'; persona-only one-liner (harness identity disabled)
- `snapshots/sdk/persistent-tools/tool-schemas.expected.json` — persistent-tools pinned parent tool-schema catalogue: initial=3 tools [bash,str_replace_editor,working_directory]
- `snapshots/sdk/persistent-tools/workspace.expected/note.txt` — workspace.expected workspace seed file: 'target: new '
- `snapshots/sdk/ptc-turn/result.expected.json` — ptc-turn expected SDK RunResult: finalResponse 'CODE_ONE+CODE_TWO'
- `snapshots/sdk/ptc-turn/runtime.cordis.yml` — ptc-turn replay-time runtime patch for the Cordis plugin graph: [ptc-runtime]
- `snapshots/sdk/ptc-turn/session.v3.jsonl` — ptc-turn parent session log (format v3): 1 turn(s), 2 step(s); tools [run_code]; turn-end reasons [completed]
- `snapshots/sdk/ptc-turn/session.v4.jsonl` — ptc-turn parent session log (format v4): 1 turn(s), 2 step(s); tools [run_code]; turn-end reasons [completed]
- `snapshots/sdk/ptc-turn/snapshot.yml` — ptc-turn manifest: profile=sdk, composition=ptc, recording=live, header class=ptc
- `snapshots/sdk/serial-created/cordis.snapshot.yml` — serial-created keyless replay patch for the Cordis plugin graph: [llm-deepseek, llm-replay, deepseek-official, deepseek-v4-flash, session-log-deepseek]; disables 1 plugin(s); swaps the live provider for the keyless llm-replay provider; disables the external session uploader
- `snapshots/sdk/serial-created/cordis.yml` — serial-created live record patch for the Cordis plugin graph: [skill-filesystem, llm-deepseek, session-persistence-jsonl, tool-subagent, session-log-deepseek, serial-created-fixture]
- `snapshots/sdk/serial-created/session.v3.jsonl` — serial-created parent session log (format v3): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/serial-created/session.v4.jsonl` — serial-created parent session log (format v4): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/serial-created/snapshot.yml` — serial-created manifest: profile=sdk, composition=sdk-serial-created, recording=authored, header class=sdk-serial-created; pins its own header; prompt pin shared with text-turn; schema pin shared with text-turn
- `snapshots/sdk/session-resume/snapshot.yml` — session-resume manifest: profile=sdk, composition=default, recording=authored, header class=default
- `snapshots/sdk/session-title-after-turn/cordis.snapshot.yml` — Keyless replay patch for session-title-after-turn: the main model is served from the session fixture (its replay override file is deliberately missing), while a separate paced title-replay provider supplies the auxiliary title response.
- `snapshots/sdk/session-title-after-turn/cordis.yml` — session-title-after-turn live record patch for the Cordis plugin graph: [session-title-provider]
- `snapshots/sdk/session-title-after-turn/replay.override.json` — session-title-after-turn replay override: one scripted title response producing the text "Late durable session title".
- `snapshots/sdk/session-title-after-turn/session.v2.jsonl` — session-title-after-turn parent session log (format v2): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/session-title-after-turn/session.v3.jsonl` — session-title-after-turn parent session log (format v3): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/session-title-after-turn/session.v4.jsonl` — session-title-after-turn parent session log (format v4): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/session-title-after-turn/snapshot.yml` — session-title-after-turn manifest: profile=sdk, composition=session-title, recording=authored, header class=session-title; pins its own header; prompt pin shared with session/text-turn; schema pin shared with session/text-turn; uses a replay override script
- `snapshots/sdk/session-title-stability/cordis.snapshot.yml` — session-title-stability keyless replay patch for the Cordis plugin graph: [llm-deepseek, agent-default-model, session-persistence-jsonl, agent-instructions, system-prompt, llm-replay-main, deepseek-official, deepseek-v4-flash, llm-replay-title, title-replay, title-model, session-title-provider]; disables 1 plugin(s); swaps the live provider for the keyless llm-replay provider
- `snapshots/sdk/session-title-stability/cordis.yml` — session-title-stability live record patch for the Cordis plugin graph: [session-title-provider]
- `snapshots/sdk/session-title-stability/replay.override.json` — session-title-stability replay override: four scripted title responses - three that repeat the same CJK title and one that changes it - so the corpus can prove a title is stable across identical prompts and changes when the prompt changes.
- `snapshots/sdk/session-title-stability/session.v4.jsonl` — session-title-stability parent session log, format v4: four turns, each with a session/title-llm-request followed by a session/title - the title provider is consulted per prompt and the accepted title is committed in order.
- `snapshots/sdk/session-title-stability/snapshot.yml` — session-title-stability manifest: profile=sdk, composition=session-title-stability, recording=authored, header class=session-title-stability; pins its own header; prompt pin shared with session/text-turn; schema pin shared with session/text-turn; uses a replay override script
- `snapshots/sdk/subagent-activation-limit/cordis.snapshot.yml` — subagent-activation-limit keyless replay patch for the Cordis plugin graph: [llm-deepseek, agent-default-model, session-persistence-jsonl, agent-instructions, system-prompt, sandbox, llm-replay, deepseek-official, deepseek-v4-flash, deepseek-v4-pro, subagent-activation-limit, subagent]; disables 1 plugin(s); swaps the live provider for the keyless llm-replay provider
- `snapshots/sdk/subagent-activation-limit/cordis.yml` — Live patch for subagent-activation-limit: sets @deepseek-ai/dsh-subagent maxActiveSubagents to 8 and inserts the activation-limit fixture, which pins the effective limit to 1.
- `snapshots/sdk/subagent-activation-limit/replay.override.json` — subagent-activation-limit replay override: 4 scripted model response(s) (2 tool call(s)), first text 'ROOT_DONE'
- `snapshots/sdk/subagent-activation-limit/session.1.v3.jsonl` — subagent-activation-limit child session log (format v3): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-activation-limit/session.1.v4.jsonl` — subagent-activation-limit child session log (format v4): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-activation-limit/session.v3.jsonl` — subagent-activation-limit parent session log (format v3): 2 turn(s), 4 step(s); tools [subagentx2]; turn-end reasons [completed,completed]; features: subagent-catalog
- `snapshots/sdk/subagent-activation-limit/snapshot.yml` — subagent-activation-limit manifest: profile=sdk, composition=subagent-activation-limit, recording=authored, header class=subagent-activation-limit; pins its own header; prompt pin shared with session/text-turn; schema pin shared with session/text-turn; pins child prompts; pins child schemas; uses a replay override script
- `snapshots/sdk/subagent-activation-limit/system-prompt.1.expected.md` — subagent-activation-limit pinned child system prompt (30 lines): opens 'You are an AI agent powered by DeepSeek Harness.'
- `snapshots/sdk/subagent-activation-limit/tool-schemas.1.expected.json` — Generated golden tool-schema catalogue (26838 bytes, 25 initial tools + 0 recorded header change set(s)); tools [bash,create_goal,edit,exit_plan_mode,get_goal,glob,grep,interrupt_agent,job_kill,job_list,job_output,list_agents,read,read_image,send_message,skill,subagent,subagent_fork,todo_write,update_goal,web_fetch,web_search,workflow,working_directory,write]. Opened and fully enumerated (every tool name, every required-argument list and every change set parsed) but NOT read line by line - it is bulk generated schema output with no behaviour of its own beyond the tool catalogue it pins. *(skipped)*
- `snapshots/sdk/subagent-continuable-inheritance/cordis.snapshot.yml` — subagent-continuable-inheritance keyless replay patch for the Cordis plugin graph: [llm-deepseek, agent-default-model, session-persistence-jsonl, agent-instructions, system-prompt, sandbox, llm-replay, deepseek-official, deepseek-v4-flash, deepseek-v4-pro, parent-sandbox-override]; disables 1 plugin(s); swaps the live provider for the keyless llm-replay provider
- `snapshots/sdk/subagent-continuable-inheritance/cordis.yml` — subagent-continuable-inheritance live record patch for the Cordis plugin graph: [parent-sandbox-override]
- `snapshots/sdk/subagent-continuable-inheritance/session.1.v2.jsonl` — subagent-continuable-inheritance child session log (format v2): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-continuable-inheritance/session.1.v3.jsonl` — subagent-continuable-inheritance child session log (format v3): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-continuable-inheritance/session.1.v4.jsonl` — subagent-continuable-inheritance child session log (format v4): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-continuable-inheritance/session.v2.jsonl` — subagent-continuable-inheritance parent session log (format v2): 2 turn(s), 3 step(s); tools [subagent]; turn-end reasons [completed,error]; features: assistant-attempt
- `snapshots/sdk/subagent-continuable-inheritance/session.v3.jsonl` — subagent-continuable-inheritance parent session log (format v3): 2 turn(s), 3 step(s); tools [subagent]; turn-end reasons [completed,error]; features: subagent-catalog, assistant-attempt
- `snapshots/sdk/subagent-continuable-inheritance/session.v4.jsonl` — subagent-continuable-inheritance parent session log (format v4): 1 turn(s), 2 step(s); tools [subagent]; turn-end reasons [completed]; features: subagent-catalog
- `snapshots/sdk/subagent-continuable-inheritance/snapshot.yml` — subagent-continuable-inheritance manifest: profile=sdk, composition=subagent-continuable-inheritance, recording=authored, header class=subagent-continuable-inheritance; pins its own header; prompt pin shared with session/text-turn; schema pin shared with session/text-turn; pins child prompts; pins child schemas
- `snapshots/sdk/subagent-continuable-inheritance/system-prompt.1.expected.md` — subagent-continuable-inheritance pinned child system prompt (30 lines): opens 'You are an AI agent powered by DeepSeek Harness.'
- `snapshots/sdk/subagent-continuable-inheritance/tool-schemas.1.expected.json` — Generated golden tool-schema catalogue (26838 bytes, 25 initial tools + 0 recorded header change set(s)); tools [bash,create_goal,edit,exit_plan_mode,get_goal,glob,grep,interrupt_agent,job_kill,job_list,job_output,list_agents,read,read_image,send_message,skill,subagent,subagent_fork,todo_write,update_goal,web_fetch,web_search,workflow,working_directory,write]. Opened and fully enumerated (every tool name, every required-argument list and every change set parsed) but NOT read line by line - it is bulk generated schema output with no behaviour of its own beyond the tool catalogue it pins. *(skipped)*
- `snapshots/sdk/subagent-continuable/session.1.v2.jsonl` — subagent-continuable child session log (format v2): 1 turn(s), 2 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-continuable/session.1.v3.jsonl` — subagent-continuable child session log (format v3): 1 turn(s), 2 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-continuable/session.1.v4.jsonl` — subagent-continuable child session log (format v4): 1 turn(s), 2 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-continuable/session.v2.jsonl` — subagent-continuable parent session log (format v2): 2 turn(s), 6 step(s); tools [send_messagex3,subagent]; turn-end reasons [completed,completed]
- `snapshots/sdk/subagent-continuable/session.v3.jsonl` — subagent-continuable parent session log (format v3): 2 turn(s), 6 step(s); tools [send_messagex3,subagent]; turn-end reasons [completed,completed]; features: subagent-catalog
- `snapshots/sdk/subagent-continuable/session.v4.jsonl` — subagent-continuable parent session log (format v4): 2 turn(s), 6 step(s); tools [send_messagex3,subagent]; turn-end reasons [completed,completed]; features: subagent-catalog
- `snapshots/sdk/subagent-continuable/snapshot.yml` — subagent-continuable manifest: profile=sdk, composition=subagent-durability-failure, recording=authored, header class=subagent-durability-failure; pins child prompts; pins child schemas
- `snapshots/sdk/subagent-continuable/system-prompt.1.expected.md` — subagent-continuable pinned child system prompt (30 lines): opens 'You are an AI agent powered by DeepSeek Harness.'
- `snapshots/sdk/subagent-continuable/tool-schemas.1.expected.json` — Generated golden tool-schema catalogue (26838 bytes, 25 initial tools + 0 recorded header change set(s)); tools [bash,create_goal,edit,exit_plan_mode,get_goal,glob,grep,interrupt_agent,job_kill,job_list,job_output,list_agents,read,read_image,send_message,skill,subagent,subagent_fork,todo_write,update_goal,web_fetch,web_search,workflow,working_directory,write]. Opened and fully enumerated (every tool name, every required-argument list and every change set parsed) but NOT read line by line - it is bulk generated schema output with no behaviour of its own beyond the tool catalogue it pins. *(skipped)*
- `snapshots/sdk/subagent-dsh-sdk-diagnostic/child.cordis.yml` — subagent-dsh-sdk-diagnostic child-runtime patch for the Cordis plugin graph: [llm-deepseek, agent-instructions, system-prompt, child-mock-llm]; disables 2 plugin(s)
- `snapshots/sdk/subagent-dsh-sdk-diagnostic/cordis.snapshot.yml` — subagent-dsh-sdk-diagnostic keyless replay patch for the Cordis plugin graph: [llm-deepseek, llm-replay, deepseek-official, deepseek-v4-flash]; disables 1 plugin(s); swaps the live provider for the keyless llm-replay provider
- `snapshots/sdk/subagent-dsh-sdk-diagnostic/cordis.yml` — subagent-dsh-sdk-diagnostic live record patch for the Cordis plugin graph: [skill-filesystem, llm-deepseek, session-persistence-jsonl, session-log-deepseek, subagent-dsh-sdk-diagnostic, tool-subagent-dsh-sdk-diagnostic, subagent-dsh-sdk-diagnostic-second, tool-subagent-dsh-sdk-diagnostic-second, await-external-subagents]
- `snapshots/sdk/subagent-dsh-sdk-diagnostic/notifications.expected.jsonl` — subagent-dsh-sdk-diagnostic SDK wire golden: 36 notification records; event types [agent/inbox/spliced,turn/start,step/start,system/message,user/message,request/header,request/context,session/title,session-log-deepseek/delivery-accepted,assistant/message,tool/call,subagent/catalog,tool/result,step/end,turn/end]
- `snapshots/sdk/subagent-dsh-sdk-diagnostic/result.expected.json` — subagent-dsh-sdk-diagnostic expected SDK RunResult: finalResponse 'PARENT_OBSERVED_DSH_SDK_DIAGNOSTIC'
- `snapshots/sdk/subagent-dsh-sdk-diagnostic/session.v2.jsonl` — subagent-dsh-sdk-diagnostic parent session log (format v2): 1 turn(s), 4 step(s); tools [job_output,subagent_dsh_sdk,subagent_dsh_sdk_background]; turn-end reasons [completed]
- `snapshots/sdk/subagent-dsh-sdk-diagnostic/session.v3.jsonl` — subagent-dsh-sdk-diagnostic parent session log (format v3): 1 turn(s), 4 step(s); tools [job_output,subagent_dsh_sdk,subagent_dsh_sdk_background]; turn-end reasons [completed]
- `snapshots/sdk/subagent-dsh-sdk-diagnostic/session.v4.jsonl` — subagent-dsh-sdk-diagnostic parent session log, format v4: two independent external DSH SDK children are spawned, each producing a subagent/catalog entry and a subagent-settled notice, and the parent replies PARENT_OBSERVED_DSH_SDK_DIAGNOSTIC.
- `snapshots/sdk/subagent-dsh-sdk-diagnostic/snapshot.yml` — subagent-dsh-sdk-diagnostic manifest: profile=sdk, composition=sdk-dsh-sdk-diagnostic, recording=live, header class=sdk-dsh-sdk-diagnostic; pins its own header
- `snapshots/sdk/subagent-dsh-sdk-diagnostic/system-prompt.expected.md` — subagent-dsh-sdk-diagnostic pinned parent system prompt (27 lines): opens 'You are an AI agent powered by DeepSeek Harness.'
- `snapshots/sdk/subagent-dsh-sdk-diagnostic/tool-schemas.expected.json` — Generated golden tool-schema catalogue (29637 bytes, 27 initial tools + 0 recorded header change set(s)); tools [bash,create_goal,edit,exit_plan_mode,get_goal,glob,grep,interrupt_agent,job_kill,job_list,job_output,list_agents,read,read_image,send_message,skill,subagent,subagent_dsh_sdk,subagent_dsh_sdk_second,subagent_fork,todo_write,update_goal,web_fetch,web_search,workflow,working_directory,write]. Opened and fully enumerated (every tool name, every required-argument list and every change set parsed) but NOT read line by line - it is bulk generated schema output with no behaviour of its own beyond the tool catalogue it pins. *(skipped)*
- `snapshots/sdk/subagent-dsh-sdk-dynamic-route/cordis.snapshot.yml` — subagent-dsh-sdk-dynamic-route keyless replay patch for the Cordis plugin graph: [llm-replay, deepseek-official, mock-delegate, mock, mock-routed, sdk-jsonrpc-server-dynamic-replay, session-log-deepseek]; swaps the live provider for the keyless llm-replay provider; disables the external session uploader
- `snapshots/sdk/subagent-dsh-sdk-dynamic-route/cordis.yml` — subagent-dsh-sdk-dynamic-route live record patch for the Cordis plugin graph: [llm-deepseek, tool-subagent, sdk-jsonrpc-server, session-persistence-jsonl, mock-llm, subagent-dsh-sdk, subagent-model-selection-settings, tool-subagent-dsh-sdk, sdk-jsonrpc-server-dynamic-live, session-log-deepseek, await-external-subagents]; disables 3 plugin(s)
- `snapshots/sdk/subagent-dsh-sdk-dynamic-route/notifications.expected.jsonl` — subagent-dsh-sdk-dynamic-route SDK wire golden: 24 notification records; event types [agent/inbox/spliced,turn/start,step/start,system/message,user/message,request/header,request/context,session/title,assistant/message,tool/call,subagent/catalog,tool/result,step/end,turn/end]
- `snapshots/sdk/subagent-dsh-sdk-dynamic-route/result.expected.json` — subagent-dsh-sdk-dynamic-route expected SDK RunResult: finalResponse 'child reported: child route: mock/mock-routed/max/777; cwd: {{cwd}}'
- `snapshots/sdk/subagent-dsh-sdk-dynamic-route/session.1.v2.jsonl` — subagent-dsh-sdk-dynamic-route parent session log (format v2): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-dsh-sdk-dynamic-route/session.1.v3.jsonl` — subagent-dsh-sdk-dynamic-route parent session log (format v3): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-dsh-sdk-dynamic-route/session.1.v4.jsonl` — subagent-dsh-sdk-dynamic-route parent session log (format v4): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-dsh-sdk-dynamic-route/session.v2.jsonl` — subagent-dsh-sdk-dynamic-route parent session log (format v2): 1 turn(s), 2 step(s); tools [subagent]; turn-end reasons [completed]
- `snapshots/sdk/subagent-dsh-sdk-dynamic-route/session.v3.jsonl` — subagent-dsh-sdk-dynamic-route parent session log (format v3): 1 turn(s), 2 step(s); tools [subagent]; turn-end reasons [completed]
- `snapshots/sdk/subagent-dsh-sdk-dynamic-route/snapshot.yml` — subagent-dsh-sdk-dynamic-route manifest: profile=sdk, composition=sdk-dsh-sdk-dynamic-route, recording=authored, header class=sdk-dsh-sdk-dynamic-route; pins its own header; pins child prompts; pins child schemas
- `snapshots/sdk/subagent-dsh-sdk-dynamic-route/system-prompt.1.expected.md` — subagent-dsh-sdk-dynamic-route pinned child system prompt (27 lines): opens 'You are an AI agent powered by DeepSeek Harness.'
- `snapshots/sdk/subagent-dsh-sdk-dynamic-route/system-prompt.expected.md` — subagent-dsh-sdk-dynamic-route pinned parent system prompt (27 lines): opens 'You are an AI agent powered by DeepSeek Harness.'
- `snapshots/sdk/subagent-dsh-sdk-dynamic-route/tool-schemas.1.expected.json` — Generated golden tool-schema catalogue (26838 bytes, 25 initial tools + 0 recorded header change set(s)); tools [bash,create_goal,edit,exit_plan_mode,get_goal,glob,grep,interrupt_agent,job_kill,job_list,job_output,list_agents,read,read_image,send_message,skill,subagent,subagent_fork,todo_write,update_goal,web_fetch,web_search,workflow,working_directory,write]. Opened and fully enumerated (every tool name, every required-argument list and every change set parsed) but NOT read line by line - it is bulk generated schema output with no behaviour of its own beyond the tool catalogue it pins. *(skipped)*
- `snapshots/sdk/subagent-dsh-sdk-dynamic-route/tool-schemas.expected.json` — Generated golden tool-schema catalogue (28802 bytes, 26 initial tools + 0 recorded header change set(s)); tools [bash,create_goal,edit,exit_plan_mode,get_goal,glob,grep,interrupt_agent,job_kill,job_list,job_output,list_agents,list_subagent_models,read,read_image,send_message,skill,subagent,subagent_fork,todo_write,update_goal,web_fetch,web_search,workflow,working_directory,write]. Opened and fully enumerated (every tool name, every required-argument list and every change set parsed) but NOT read line by line - it is bulk generated schema output with no behaviour of its own beyond the tool catalogue it pins. *(skipped)*
- `snapshots/sdk/subagent-fork-in-process/session.1.v2.jsonl` — subagent-fork-in-process child session log (format v2): 2 turn(s), 2 step(s); tools [none]; turn-end reasons [completed,completed]; features: end-seed
- `snapshots/sdk/subagent-fork-in-process/session.1.v3.jsonl` — subagent-fork-in-process child session log (format v3): 2 turn(s), 2 step(s); tools [none]; turn-end reasons [completed,completed]; features: end-seed
- `snapshots/sdk/subagent-fork-in-process/session.1.v4.jsonl` — subagent-fork-in-process child session log, format v4: a fork child that runs one turn, then a session/end-seed and a resumed turn under a request/header with reason "resume" - the forked-session continuity case.
- `snapshots/sdk/subagent-fork-in-process/session.v2.jsonl` — subagent-fork-in-process parent session log (format v2): 2 turn(s), 3 step(s); tools [subagent_fork]; turn-end reasons [completed,completed]
- `snapshots/sdk/subagent-fork-in-process/session.v3.jsonl` — subagent-fork-in-process parent session log (format v3): 2 turn(s), 3 step(s); tools [subagent_fork]; turn-end reasons [completed,completed]; features: subagent-catalog
- `snapshots/sdk/subagent-fork-in-process/session.v4.jsonl` — subagent-fork-in-process parent session log (format v4): 2 turn(s), 3 step(s); tools [subagent_fork]; turn-end reasons [completed,completed]; features: subagent-catalog
- `snapshots/sdk/subagent-fork-in-process/snapshot.yml` — subagent-fork-in-process manifest: profile=sdk, composition=default, recording=live, header class=default
- `snapshots/sdk/subagent-list-agents/session.1.v2.jsonl` — subagent-list-agents child session log (format v2): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-list-agents/session.1.v3.jsonl` — subagent-list-agents child session log (format v3): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-list-agents/session.1.v4.jsonl` — subagent-list-agents child session log (format v4): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-list-agents/session.v2.jsonl` — subagent-list-agents parent session log (format v2): 3 turn(s), 5 step(s); tools [list_agents,subagent]; turn-end reasons [completed,completed,completed]
- `snapshots/sdk/subagent-list-agents/session.v3.jsonl` — subagent-list-agents parent session log (format v3): 3 turn(s), 5 step(s); tools [list_agents,subagent]; turn-end reasons [completed,completed,completed]; features: subagent-catalog
- `snapshots/sdk/subagent-list-agents/session.v4.jsonl` — subagent-list-agents parent session log (format v4): 3 turn(s), 5 step(s); tools [list_agents,subagent]; turn-end reasons [completed,completed,completed]; features: subagent-catalog
- `snapshots/sdk/subagent-list-agents/snapshot.yml` — subagent-list-agents manifest: profile=sdk, composition=default, recording=authored, header class=default; pins child prompts; pins child schemas
- `snapshots/sdk/subagent-list-agents/system-prompt.1.expected.md` — subagent-list-agents pinned child system prompt (30 lines): opens 'You are an AI agent powered by DeepSeek Harness.'
- `snapshots/sdk/subagent-list-agents/tool-schemas.1.expected.json` — Generated golden tool-schema catalogue (26838 bytes, 25 initial tools + 0 recorded header change set(s)); tools [bash,create_goal,edit,exit_plan_mode,get_goal,glob,grep,interrupt_agent,job_kill,job_list,job_output,list_agents,read,read_image,send_message,skill,subagent,subagent_fork,todo_write,update_goal,web_fetch,web_search,workflow,working_directory,write]. Opened and fully enumerated (every tool name, every required-argument list and every change set parsed) but NOT read line by line - it is bulk generated schema output with no behaviour of its own beyond the tool catalogue it pins. *(skipped)*
- `snapshots/sdk/subagent-mixed/session.1.v2.jsonl` — subagent-mixed child session log (format v2): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-mixed/session.1.v3.jsonl` — subagent-mixed child session log (format v3): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-mixed/session.1.v4.jsonl` — subagent-mixed child session log (format v4): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/sdk/subagent-mixed/session.2.v2.jsonl` — subagent-mixed child session log (format v2): 2 turn(s), 2 step(s); tools [none]; turn-end reasons [completed,completed]; features: end-seed
- `snapshots/sdk/subagent-mixed/session.2.v3.jsonl` — subagent-mixed child session log (format v3): 2 turn(s), 2 step(s); tools [none]; turn-end reasons [completed,completed]; features: end-seed
- `snapshots/sdk/subagent-mixed/session.2.v4.jsonl` — subagent-mixed child session log (format v4): 2 turn(s), 2 step(s); tools [none]; turn-end reasons [completed,completed]; features: end-seed
- `snapshots/sdk/subagent-mixed/session.v2.jsonl` — subagent-mixed parent session log (format v2): 2 turn(s), 4 step(s); tools [subagent,subagent_fork]; turn-end reasons [completed,completed]
- `snapshots/sdk/subagent-mixed/session.v3.jsonl` — subagent-mixed parent session log (format v3): 2 turn(s), 4 step(s); tools [subagent,subagent_fork]; turn-end reasons [completed,completed]; features: subagent-catalog
- `snapshots/sdk/subagent-mixed/session.v4.jsonl` — subagent-mixed parent session log (format v4): 2 turn(s), 4 step(s); tools [subagent,subagent_fork]; turn-end reasons [completed,completed]; features: subagent-catalog
- `snapshots/sdk/subagent-mixed/snapshot.yml` — subagent-mixed manifest: profile=sdk, composition=default, recording=live, header class=default
- `snapshots/sdk/subagent-send-message/cordis.snapshot.yml` — subagent-send-message keyless replay patch for the Cordis plugin graph: [llm-deepseek, agent-default-model, session-persistence-jsonl, agent-instructions, system-prompt, sandbox, llm-replay, deepseek-official, deepseek-v4-flash, deepseek-v4-pro, send-message-fence]; disables 1 plugin(s); swaps the live provider for the keyless llm-replay provider
- `snapshots/sdk/subagent-send-message/cordis.yml` — subagent-send-message live record patch for the Cordis plugin graph: [send-message-fence]
- `snapshots/sdk/subagent-send-message/session.1.v2.jsonl` — subagent-send-message child session log (format v2): 1 turn(s), 2 step(s); tools [send_message]; turn-end reasons [completed]
- `snapshots/sdk/subagent-send-message/session.1.v3.jsonl` — subagent-send-message child session log (format v3): 1 turn(s), 2 step(s); tools [send_message]; turn-end reasons [completed]
- `snapshots/sdk/subagent-send-message/session.v2.jsonl` — subagent-send-message parent session log (format v2): 3 turn(s), 4 step(s); tools [subagent]; turn-end reasons [completed,completed,completed]
- `snapshots/sdk/subagent-send-message/session.v3.jsonl` — subagent-send-message parent session log (format v3): 3 turn(s), 4 step(s); tools [subagent]; turn-end reasons [completed,completed,completed]; features: subagent-catalog
- `snapshots/sdk/subagent-send-message/snapshot.yml` — subagent-send-message manifest: profile=sdk, composition=subagent-send-message, recording=authored, header class=subagent-send-message; pins its own header; prompt pin shared with session/text-turn; schema pin shared with session/text-turn; pins child prompts; pins child schemas
- `snapshots/sdk/subagent-send-message/system-prompt.1.expected.md` — subagent-send-message pinned child system prompt (30 lines): opens 'You are an AI agent powered by DeepSeek Harness.'
- `snapshots/sdk/subagent-send-message/tool-schemas.1.expected.json` — Generated golden tool-schema catalogue (26838 bytes, 25 initial tools + 0 recorded header change set(s)); tools [bash,create_goal,edit,exit_plan_mode,get_goal,glob,grep,interrupt_agent,job_kill,job_list,job_output,list_agents,read,read_image,send_message,skill,subagent,subagent_fork,todo_write,update_goal,web_fetch,web_search,workflow,working_directory,write]. Opened and fully enumerated (every tool name, every required-argument list and every change set parsed) but NOT read line by line - it is bulk generated schema output with no behaviour of its own beyond the tool catalogue it pins. *(skipped)*
- `snapshots/sdk/subagent-spawn-in-process/notifications.expected.jsonl` — subagent-spawn-in-process SDK wire golden: 41 notification records; event types [agent/inbox/spliced,turn/start,step/start,system/message,user/message,request/header,request/context,session/title,assistant/message,tool/call,subagent/catalog,step/end,turn/end,tool/result]
- `snapshots/sdk/subagent-spawn-in-process/result.expected.json` — subagent-spawn-in-process expected SDK RunResult: finalResponse 'child answer 42.'
- `snapshots/sdk/subagent-spawn-in-process/runtime.cordis.yml` — subagent-spawn-in-process replay-time runtime patch for the Cordis plugin graph: [await-sdk-subagents]
- `snapshots/sdk/subagent-spawn-in-process/session.1.v2.jsonl` — subagent-spawn-in-process child session log (format v2): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [error]; features: assistant-attempt
- `snapshots/sdk/subagent-spawn-in-process/session.1.v3.jsonl` — subagent-spawn-in-process child session log, format v3: the child has no replay script of its own and ends {kind:"error"} with llm-replay: script exhausted - session requested model call #1 but its script has only 0; re-record the scenario - the retained evidence of the pre-fix failure.
- `snapshots/sdk/subagent-spawn-in-process/session.v2.jsonl` — subagent-spawn-in-process parent session log (format v2): 1 turn(s), 2 step(s); tools [subagent]; turn-end reasons [completed]
- `snapshots/sdk/subagent-spawn-in-process/session.v3.jsonl` — subagent-spawn-in-process parent session log (format v3): 1 turn(s), 2 step(s); tools [subagent]; turn-end reasons [completed]; features: subagent-catalog
- `snapshots/sdk/subagent-spawn-in-process/session.v4.jsonl` — subagent-spawn-in-process parent session log (format v4): 1 turn(s), 2 step(s); tools [subagent]; turn-end reasons [completed]; features: subagent-catalog
- `snapshots/sdk/subagent-spawn-in-process/snapshot.yml` — subagent-spawn-in-process manifest: profile=sdk, composition=sdk-default, recording=authored, header class=sdk-default
- `snapshots/sdk/system-prompt-in-history/result.expected.json` — system-prompt-in-history expected SDK RunResult: finalResponse 'DONE'
- `snapshots/sdk/system-prompt-in-history/session.v3.jsonl` — system-prompt-in-history parent session log (format v3): 1 turn(s), 2 step(s); tools [read]; turn-end reasons [completed]
- `snapshots/sdk/system-prompt-in-history/session.v4.jsonl` — system-prompt-in-history parent session log (format v4): 1 turn(s), 2 step(s); tools [read]; turn-end reasons [completed]
- `snapshots/sdk/system-prompt-in-history/snapshot.yml` — system-prompt-in-history manifest: profile=sdk, composition=system-prompt-in-history, recording=authored, header class=system-prompt-in-history; uses a replay override script
- `snapshots/sdk/system-prompt-in-history/workspace/task.txt` — workspace workspace seed file: 'Reply with the single word DONE after reading this file. '
- `snapshots/sdk/text-turn/tool-schemas.expected.json` — Generated golden tool-schema catalogue (26838 bytes, 25 initial tools + 0 recorded header change set(s)); tools [bash,create_goal,edit,exit_plan_mode,get_goal,glob,grep,interrupt_agent,job_kill,job_list,job_output,list_agents,read,read_image,send_message,skill,subagent,subagent_fork,todo_write,update_goal,web_fetch,web_search,workflow,working_directory,write]. Opened and fully enumerated (every tool name, every required-argument list and every change set parsed) but NOT read line by line - it is bulk generated schema output with no behaviour of its own beyond the tool catalogue it pins. *(skipped)*
- `snapshots/sdk/tool-error-details/result.expected.json` — tool-error-details expected SDK RunResult: finalResponse 'ERROR_DETAILS_OK'
- `snapshots/sdk/tool-error-details/session.v3.jsonl` — tool-error-details parent session log (format v3): 1 turn(s), 3 step(s); tools [bash,run_code]; turn-end reasons [completed]
- `snapshots/sdk/tool-error-details/session.v4.jsonl` — tool-error-details parent session log (format v4): 1 turn(s), 3 step(s); tools [bash,run_code]; turn-end reasons [completed]; features: developer tool-registry update
- `snapshots/sdk/tool-error-details/snapshot.yml` — tool-error-details manifest: profile=sdk, composition=default, recording=authored, header class=native-then-ptc; pins its own header; 1 header change(s) declared; 1 prompt change(s) declared
- `snapshots/sdk/tool-error-details/tool-schemas.expected.json` — Generated golden tool-schema catalogue (29848 bytes, 25 initial tools + 1 recorded header change set(s)); tools [bash,create_goal,edit,exit_plan_mode,get_goal,glob,grep,interrupt_agent,job_kill,job_list,job_output,list_agents,read,read_image,send_message,skill,subagent,subagent_fork,todo_write,update_goal,web_fetch,web_search,workflow,working_directory,write]. Opened and fully enumerated (every tool name, every required-argument list and every change set parsed) but NOT read line by line - it is bulk generated schema output with no behaviour of its own beyond the tool catalogue it pins. *(skipped)*
- `snapshots/sdk/tool-scheduler-recovery/notifications.expected.jsonl` — tool-scheduler-recovery SDK wire golden: 30 records showing the failing tool call, the two distinct interruption messages, turn/end {kind:"error",error:{code:"UNKNOWN"}} and the recovery turn answering SCHEDULER_RECOVERY_OK.
- `snapshots/sdk/tool-scheduler-recovery/result.expected.json` — tool-scheduler-recovery expected SDK RunResult: finalResponse 'SCHEDULER_RECOVERY_OK'
- `snapshots/sdk/tool-scheduler-recovery/runtime.cordis.yml` — tool-scheduler-recovery replay-time runtime patch for the Cordis plugin graph: [scheduler-failure-fixture]
- `snapshots/sdk/tool-scheduler-recovery/session.v3.jsonl` — tool-scheduler-recovery parent session log (format v3): 2 turn(s), 2 step(s); tools [todo_writex3]; turn-end reasons [error,completed]
- `snapshots/sdk/tool-scheduler-recovery/snapshot.yml` — tool-scheduler-recovery manifest: profile=sdk, composition=sdk-default, recording=authored, header class=sdk-default
- `snapshots/session/advanced-toolchain-runtime/runtime.cordis.yml` — advanced-toolchain-runtime replay-time runtime patch for the Cordis plugin graph: [await-subagents]
- `snapshots/session/advanced-toolchain-runtime/session.1.v2.jsonl` — advanced-toolchain-runtime child session log (format v2): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/session/advanced-toolchain-runtime/session.1.v3.jsonl` — advanced-toolchain-runtime child session log (format v3): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/session/advanced-toolchain-runtime/session.1.v4.jsonl` — advanced-toolchain-runtime child session log (format v4): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/session/advanced-toolchain-runtime/session.2.v2.jsonl` — advanced-toolchain-runtime child session log (format v2): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/session/advanced-toolchain-runtime/session.2.v3.jsonl` — advanced-toolchain-runtime child session log (format v3): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/session/advanced-toolchain-runtime/session.2.v4.jsonl` — advanced-toolchain-runtime child session log (format v4): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/session/advanced-toolchain-runtime/session.v2.jsonl` — advanced-toolchain-runtime parent session log (format v2): 1 turn(s), 5 step(s); tools [cordis_define,cordis_undefine,subagent,workflow]; turn-end reasons [completed]; features: workflow run
- `snapshots/session/advanced-toolchain-runtime/session.v3.jsonl` — advanced-toolchain-runtime parent session log (format v3): 1 turn(s), 5 step(s); tools [cordis_inspect_listx2,subagent,workflow]; turn-end reasons [completed]; features: subagent-catalog, workflow run
- `snapshots/session/advanced-toolchain-runtime/session.v4.jsonl` — advanced-toolchain-runtime parent session log, format v4: the same toolchain but with the settlement barrier ordering the subagent result before the workflow call, and the subagent-settled notice delivered between the child spawn and the workflow step.
- `snapshots/session/advanced-toolchain-runtime/snapshot.yml` — advanced-toolchain-runtime manifest: profile=headless, composition=advanced, recording=authored, header class=advanced; prompt pin shared with cordis-inspect-jsdoc; schema pin shared with cordis-inspect-jsdoc
- `snapshots/session/advanced-toolchain/cordis.snapshot.yml` — advanced-toolchain keyless replay patch for the Cordis plugin graph: [llm-deepseek, agent-default-model, session-persistence-jsonl, agent-instructions, tools, system-prompt, cordis-host-runner, cordis-inspect-providers, tool-cordis, llm-replay, deepseek-official, deepseek-v4-flash, deepseek-v4-pro, advanced-toolchain-presentation]; disables 1 plugin(s); swaps the live provider for the keyless llm-replay provider
- `snapshots/session/advanced-toolchain/runtime.cordis.yml` — advanced-toolchain replay-time runtime patch for the Cordis plugin graph: [await-subagents]
- `snapshots/session/advanced-toolchain/session.1.v2.jsonl` — advanced-toolchain child session log (format v2): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/session/advanced-toolchain/session.1.v3.jsonl` — advanced-toolchain child session log (format v3): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/session/advanced-toolchain/session.1.v4.jsonl` — advanced-toolchain child session log (format v4): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/session/advanced-toolchain/session.2.v2.jsonl` — advanced-toolchain child session log (format v2): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/session/advanced-toolchain/session.2.v3.jsonl` — advanced-toolchain child session log (format v3): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/session/advanced-toolchain/session.2.v4.jsonl` — advanced-toolchain child session log (format v4): 1 turn(s), 1 step(s); tools [none]; turn-end reasons [completed]
- `snapshots/session/advanced-toolchain/session.v2.jsonl` — advanced-toolchain parent session log (format v2): 1 turn(s), 6 step(s); tools [cordis_define,cordis_undefine,run_code,subagent,workflow]; turn-end reasons [completed]; features: workflow run
- `snapshots/session/advanced-toolchain/session.v3.jsonl` — advanced-toolchain parent session log (format v3): 1 turn(s), 6 step(s); tools [cordis_inspect_listx2,run_code,subagent,workflow]; turn-end reasons [completed]; features: subagent-catalog, workflow run
- `snapshots/session/advanced-toolchain/snapshot.yml` — advanced-toolchain manifest: profile=headless, composition=advanced-toolchain, recording=authored, header class=native-ptc-native; pins its own header; 2 header change(s) declared; 2 prompt change(s) declared; pins child prompts
- `snapshots/session/advanced-toolchain/system-prompt.1.expected.md` — advanced-toolchain pinned child system prompt (30 lines): opens 'You are an AI agent powered by DeepSeek Harness.'
- `snapshots/session/advanced-toolchain/system-prompt.2.expected.md` — advanced-toolchain pinned child system prompt (30 lines): opens 'You are an AI agent powered by DeepSeek Harness.'
- `snapshots/session/advanced-toolchain/system-prompt.expected.md` — advanced-toolchain pinned parent system prompt (626 lines): the base prompt plus two system/message change sections, each carrying the run_code appendix with the tool catalogue as TypeScript SDK bindings.
- `snapshots/session/advanced-toolchain/tool-schemas.expected.json` — Generated golden tool-schema catalogue (62223 bytes, 27 initial tools + 2 recorded header change set(s)); tools [bash,cordis_inspect_list,cordis_inspect_query,create_goal,edit,exit_plan_mode,get_goal,glob,grep,interrupt_agent,job_kill,job_list,job_output,list_agents,read,read_image,send_message,skill,subagent,subagent_fork,todo_write,update_goal,web_fetch,web_search,workflow,working_directory,write]. Opened and fully enumerated (every tool name, every required-argument list and every change set parsed) but NOT read line by line - it is bulk generated schema output with no behaviour of its own beyond the tool catalogue it pins. *(skipped)*

---

## Ideas worth stealing

- **Two distinct interruption codes for an unfinished tool call, with different retry advice** — `snapshots/sdk/tool-scheduler-recovery/session.v4.jsonl:20` (`TOOL_OUTCOME_UNKNOWN` — "its outcome is unknown … retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.") and `:21` (`TOOL_NOT_STARTED` — "interrupted before the Harness recorded it as started. Retry it if it is still needed.") — *August's `run_command` reports exit codes but has no vocabulary for "the harness lost track of this call". Splitting "we don't know if it ran" from "it definitely never started", and writing the advice **for the model** rather than as a stack trace, is the difference between a stuck loop the model can escape and one it cannot. This is the missing third arm of August's `timeout | rate_limit | auth | permission | not_found | network | invalid_argument | process_exit` taxonomy.*

- **A provider refusal becomes a typed repair instruction the harness acts on** — `snapshots/sdk/inline-image-prompt/session.v4.jsonl:15` (finish reason `failure.code:"IMAGE_OFFLOAD_REQUIRED"`, `offloadImages = 3`, message "DeepSeek base64 request images exceed the route budget; 3 more oldest occurrence(s) must be offloaded") → `:16` `image/offload` with `targets:[{seq:8, imageIndexes:[0,1,2]}]` → a fresh `request/header` with `reason:"series"` and the retry succeeding — *the provider names the repair, the harness performs it, the turn continues, and the whole exchange is in the log. August's `classify_error` is a string taxonomy; this is a structured failure **code** that the loop can act on. The "oldest occurrence(s) first" ordering is also worth copying: it bounds which images get dropped.*

- **Compaction records exactly which span it shadowed and replaces that span in place** — `snapshots/sdk/minimal-image-compaction/notifications.expected.jsonl:17` (`compaction/summary` with `shadowedRange {start:5,end:6}`, `shadowedSeqs:[5,6]`, `shadowedTokenCount = 2945`, `llmStreamCall:true`, and both `summary` and `rawOutput`) → `:18` the checkpoint `user/message` with `surfaceOp {op:"replace", startSeq:5, endSeq:6}`, `source {kind:"compact-checkpoint", compactionId}` and `sourceEventSeqs:[14,15,5,6]` — *August's `<<compressed_summary` block records the summary but not the shadowed range. Without `shadowedRange`/`shadowedTokenCount` there is no way to prove after the fact that the right span was replaced or how many tokens were actually freed — exactly the defect AGENTS.md describes when the budget path reported "messages remaining" and the pre-turn path reported "messages removed". The `sourceEventSeqs` back-pointer makes the replacement reversible.*

- **The compaction checkpoint tells the model not to acknowledge it** — `snapshots/sdk/minimal-image-compaction/notifications.expected.jsonl:18`: "Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint." — *a compaction note that says "I have compacted" costs a turn and makes the model re-narrate work it already did. August's `<<compressed_summary` has no such instruction.*

- **A changed system prompt is APPENDED in-history, never written over node 0** — `snapshots/sdk/system-prompt-in-history/notifications.expected.jsonl:10` (`request/context` reports `systemPromptUpdate:"in-history"`) and `:17` (the new prompt arrives as a *second* `system/message` with `surfaceOp:"append"`, after the tool result); pinned by `snapshots/sdk/sdk.snapshot.ts:1183` (both system messages must have `surfaceOp:"append"`) and `:1193` (`request/context` must report `in-history`) — *August already freezes its boot memory index per session for exactly this reason ("the boot memory index is frozen per session to protect the provider prefix cache"). The same discipline applied to the **system prompt** is the missing half: August has no route at all for "the prompt changed mid-turn", so any future dynamic-prompt feature would silently destroy the cache.*

- **The whole tool catalogue is rendered into the prompt as TypeScript SDK bindings** — `snapshots/sdk/tool-error-details/system-prompt.expected.md:67` ("## Writing code for run_code"), `:76` ("A FAILED tool call rejects with `ToolCallError`, whose `toolName` identifies the failed tool"), `:77` ("Independent read-only calls MAY overlap under `Promise.all` (safe calls run concurrently; mutating calls run alone, in submission order)"), `:78` ("Only what you print or return is program output … every other intermediate result stays out of the conversation"), and the `ToolArgsMap`/`ToolOutputMap` declarations from `:82` to `:577` — *August's `code` mode already has a workspace-bound tool API (`read_file`, `write_file`, `run_command`, `list_files`) but the model must guess its shape. This is the exact prompt text that makes a weak model use a programmatic tool API correctly. Two parts are not expressible in JSON Schema and therefore must live in prose: the **concurrency contract** (mutating calls run alone, in submission order) and the **output contract** (only what you print or return leaves the program). August's code-mode runner would have to enforce the first in the sandbox either way — putting it in the prompt makes the model cooperate.*

- **A tool-surface change is announced to the model as a developer message tied to the header that changed** — `snapshots/sdk/dynamic-tool-updates/notifications.expected.jsonl:18` (`developer/message`, `source {kind:"tool-registry"}`, `content:[{type:"tool-addition", toolName:"snapshot_ping"}]`, `headerSeq: 18`) and `:25` (the `tool-removal` counterpart) — *the model is told *why* its tool surface changed, in the same vocabulary the registry uses, and the `headerSeq` link makes the change traceable to the exact request. August's `tool_search` → `tool_call` progressive disclosure has no announcement at all, so a model that searched for a tool and did not find it has no way to learn that the tool was added after its search.*

- **Subagent capacity is a recoverable tool error, not a crash** — `snapshots/sdk/subagent-activation-limit/session.v4.jsonl:23`: `error {name:"SubagentError", code:"ACTIVATION_LIMIT_REACHED"}` with "subagent limit reached (active child limit: 1); wait for an existing child to finish or complete this work with the current agents" — *the refusal states the limit, the cause, and **two** ways forward (wait, or do the work with the agents you have); the turn continues and the already-running child still settles into the next turn. August has `MAX_MANAGED_TOOL_ROUNDS` and the runaway backstop but no **concurrency** ceiling on `subagent`; when it lands it must be an ordinary error result the model can read and route around, not an aborted turn.*

- **Delegation depth is stated in the prompt, not only enforced** — `snapshots/sdk/subagent-send-message/session.1.v4.jsonl:12`: two extra runtime-context sections, `tool:subagent:depth` and `tool:subagent_fork:depth`, each "current 1, maximum 1, remaining levels 0. Do not call `subagent` at this depth; carry out the work directly." — *telling the model the ceiling saves a wasted turn discovering it by denial, and the notice is **per tool**, so a child that has one delegation route left is told exactly which route is closed.*

- **An explicit ordering contract between parent and child completion** — `snapshots/sdk/sdk.snapshot.ts:740`: the suite asserts the exact notification order `['parent:turn:1','parent:idle','child:finished','parent:turn:2','parent:idle']` with the message "completion notifications arrive before the session/wait response" — *"the parent went idle" is not "the work is done": a child can still be running. This one-line contract is exactly what August's Bot-to-Bot chain lacks — AGENTS.md's own analysis ("every loop guard is per-turn … an A→B→C→A cycle is none of those") is the same problem DSH solved by pinning the order of `parent:idle` and `child:finished`.*

- **Subagent settlement is a first-class message with a precise liveness claim** — `snapshots/sdk/subagent-send-message/session.v4.jsonl:31`: "Background subagent {{session:2}} finished and will do no further work unless you send it more." + "Its closing message:" — *the parent is told the child is done **and** that it is still addressable — a disposition, not a status. "Child completed" and "child will do no further work unless you send it more" lead to different next actions, and the second one is the one a continuation-capable child needs.*

- **Two different denials, two different presentations** — `snapshots/sdk/tool-error-details/notifications.expected.jsonl:14` (native denial → `isError:true` + structured `error {name, code, reason}`) versus `:23`–`:24` (the same denial caught inside a `run_code` program → the inner `tool/ptc-dispatch` carries `isError:true` + the error, but the **outer** `tool/result` is `isError:false` and the denial text is program output) — *the outer call genuinely succeeded. August's code-mode runner must not launder a caught inner denial into an outer failure, or the model is told its program failed when it did not — the same class of bug AGENTS.md records as "the phantom-argument execution the loop documents against".*

- **Runtime context is its own user message with named sections, and is asserted absent from the system prompt** — `snapshots/sdk/text-turn/session.v4.jsonl:11` (`source {kind:"runtime-context", form:"snapshot", sections:[working-directory:current, sandbox:policy, approval:policy]}`), with `snapshots/sdk/sdk.snapshot.ts:1232` asserting the system prompt contains none of those clauses — *cwd, sandbox mode and approval policy change per session; baking them into the system prompt would bust the cached prefix on every new session. August's runtime-context block already separates these, but the *named sections* are what make it machine-checkable (`includes`/`excludes` clauses per scenario, sdk.snapshot.ts:1229).*

- **A prompt pin stores EVERY prompt version with explicit change markers** — `snapshots/sdk/tool-error-details/system-prompt.expected.md:32` and `snapshots/session/advanced-toolchain/system-prompt.expected.md:32`/`:595` (each `<!-- system/message change N -->` section) — *August's prompt is assembled from many plugins; a golden that stores only the first version cannot catch a plugin that silently reorders or drops a section mid-session. The `changes: N` / `promptChanges: N` counts in the manifest make the number of expected versions a declared fact.*

- **A pin can be a POINTER, not a copy** — `snapshots/sdk/account-provider-signout/system-prompt.expected.md:1` is the single line `../text-turn/system-prompt.expected.md` (and `snapshots/sdk/account-provider-signout/tool-schemas.expected.json:1` the same) — *identical prompts and identical 25-tool catalogues are committed once; the manifest's `systemPromptSource`/`toolSchemasSource` fields make the sharing explicit and machine-checked. Seven of the eight 26 838-byte catalogue files in this shard are byte-identical duplicates (SHA-256 verified) — a pointer would have removed seven copies of a 26 KB file.*

- **An old format stays the replay input forever while a separate oracle pins today's writer output** — `snapshots/sdk/multi-turn/snapshot.yml:8` (`sessionFormat: {version: 2, coverage: [adjacent-migration]}`) plus `snapshots/sdk/multi-turn/writer.expected.jsonl` (the v4 native writer output of the same conversation) — *August's session-log format will keep migrating. This pattern asserts both "the old file still replays" and "the current writer would emit this" without ever rewriting the historical fixture, and the `coverage` name records *why* the old generation is retained so a curation pass can tell a migration fixture from a stale leftover.*

- **Replay-script exhaustion is a first-class, actionable failure** — `snapshots/sdk/subagent-spawn-in-process/session.1.v3.jsonl:17`: "llm-replay: script exhausted — session requested model call #1 but its script has only 0; re-record the scenario", with `snapshots/sdk/sdk.snapshot.ts:985` asserting that no committed log contains that string — *a missing replay fails loudly with the fix in the message instead of hanging or silently returning an empty answer. The same v3-vs-v4 pair (`session.1.v3.jsonl` failing, `session.1.v4.jsonl` answering "child answer 42.") is the corpus's way of making a bug fix reviewable as a diff.*

- **Assert the tool-surface DELTA, not the whole list** — `snapshots/sdk/sdk.snapshot.ts:1019`–`:1021`: `expect(toolNames.map(names => names.includes('snapshot_ping'))).toEqual([false,true,false])` and `expect(toolNames[1]!.filter(name => !toolNames[0]!.includes(name))).toEqual(['snapshot_ping'])` — *adding an unrelated tool must not break the golden. August's per-model `toolSurface` profiles change the tool list frequently; a delta assertion survives that, and the same file's `changes: N` mechanism (a `changes` array in `tool-schemas.expected.json` holding the *before* and *after* sets) makes each change individually reviewable.*

- **A shell reset is told to the model explicitly** — `snapshots/sdk/persistent-tools/notifications.expected.jsonl:44`: "exit\n[shell exited: code 9]\nThe persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment." — *a persistent shell that silently resets is a state-loss trap: the next command runs somewhere else with a different environment and the model has no way to know. August's `run_command` is one-shot so it does not have this bug — but August's terminal/PTY path has the same obligation, and its terminal buffer is readable through `GET /api/terminal/buffer`, so the reset has to be explicit there too.*

- **A provider account's own knobs are asserted, not assumed** — `snapshots/sdk/account-provider-signout/notifications.expected.jsonl:9`: the header carries `config {provider, model, maxTokens:256000, reasoningEffort:"max"}` alongside `adapterDefaults {reasoningEffort:true, maxTokens:true}` — *the adapter declares which knobs it owns, so a conflict between the user's model settings and the account provider's defaults becomes a *logged* fact. August's per-model `priceInPerM`/`maxTools`/`toolSurface` settings have exactly the same conflict surface and no equivalent declaration.*

---

## Files skipped (with reasons)

Thirteen files were **not** read line by line. Each was opened, identified and (where applicable) fully enumerated programmatically before being marked skipped.

- `snapshots/sdk/minimal-image-compaction/workspace/red.png` — **binary** 1×1-pixel PNG, 69 bytes. Verified as a valid `image/png` from its bytes and from the suite's own assertion of `mediaType`/`bytes: 69`/`width: 1`/`height: 1`/`name: "red.png"` at `snapshots/sdk/sdk.snapshot.ts:959-962`. Not read line by line because it is binary.
- `snapshots/sdk/text-turn/tool-schemas.expected.json` — **generated bulk golden**, 26 838 bytes / 635 lines. The 25-tool catalogue the model saw (`bash, create_goal, edit, exit_plan_mode, get_goal, glob, grep, interrupt_agent, job_kill, job_list, job_output, list_agents, read, read_image, send_message, skill, subagent, subagent_fork, todo_write, update_goal, web_fetch, web_search, workflow, working_directory, write`) with `changes: []`. Read as a whole (the head of the `bash` schema verbatim, every tool name and required-argument list parsed), not schema-body line by line.
- `snapshots/sdk/bash-tool/tool-schemas.expected.json` — the **same file, byte-identical** to the above (SHA-256 verified). Opened and compared, not read line by line.
- `snapshots/sdk/subagent-activation-limit/tool-schemas.1.expected.json` — byte-identical duplicate of the above (SHA-256 verified); the child pin of the `sdk-default` header class.
- `snapshots/sdk/subagent-continuable/tool-schemas.1.expected.json` — byte-identical duplicate (SHA-256 verified).
- `snapshots/sdk/subagent-continuable-inheritance/tool-schemas.1.expected.json` — byte-identical duplicate (SHA-256 verified).
- `snapshots/sdk/subagent-dsh-sdk-dynamic-route/tool-schemas.1.expected.json` — byte-identical duplicate (SHA-256 verified).
- `snapshots/sdk/subagent-list-agents/tool-schemas.1.expected.json` — byte-identical duplicate (SHA-256 verified).
- `snapshots/sdk/subagent-send-message/tool-schemas.1.expected.json` — byte-identical duplicate (SHA-256 verified).
- `snapshots/sdk/subagent-dsh-sdk-dynamic-route/tool-schemas.expected.json` — **generated bulk golden**, 28 802 bytes; the same 25 tools **plus** `list_subagent_models` (26 initial, `changes: []`). Every tool name parsed; not read schema-body line by line.
- `snapshots/sdk/subagent-dsh-sdk-diagnostic/tool-schemas.expected.json` — **generated bulk golden**, 29 637 bytes; 27 tools (the 25 plus `subagent_dsh_sdk` and `subagent_dsh_sdk_second`). Every tool name parsed; not read schema-body line by line.
- `snapshots/sdk/tool-error-details/tool-schemas.expected.json` — **generated bulk golden**, 29 848 bytes; 25 initial tools and **one recorded change set** (the `run_code`-only replacement). Every tool name and change set parsed; not read schema-body line by line.
- `snapshots/session/advanced-toolchain/tool-schemas.expected.json` — **generated bulk golden**, 62 223 bytes (the largest file in this shard); 27 initial tools (the 25 plus `cordis_inspect_list` and `cordis_inspect_query`) and **two** recorded change sets. Every tool name and change set parsed; not read schema-body line by line.

Two further files were read *substantively but not in full* and are marked `read` in the ledger with that caveat in their note: `snapshots/sdk/tool-error-details/system-prompt.expected.md` (578 lines; I read lines 1–129, the change marker, and lines 552–578, and grep-verified the section boundaries) and `snapshots/session/advanced-toolchain/system-prompt.expected.md` (626 lines; same treatment). The ~430-line middle of each is a **generated per-tool TypeScript binding block** whose content is the same catalogue as the JSON sidecars.

---

## Uncertainties

- **The corpus is an expected-output artefact, so it shows *what the harness did*, not *why the code is that way*.** Every mechanism I describe above was inferred from the observable event stream plus the header comments in `snapshots/sdk/sdk.snapshot.ts` and the `packages/test-support/session-snapshot/README.md`. The implementation that produces these events lives in `packages/core/agent-loop`, `packages/tools`, `packages/subagent` and `packages/api/session-controller`, which are **not in this shard**. Where I name a mechanism (e.g. `image/offload`, `compaction/summary`, `presentAs('ptc')`) the *name and shape* are certain because they appear verbatim in the fixtures, but **the code path that decides to fire it is outside my shard** — I cannot say whether the image-offload threshold is configurable, nor whether `compaction-basic` has other knobs.
- **`cordis.snapshot.yml` is a *replay* patch, not a snapshot of the resolved configuration.** Despite the name it contains only the **delta** the replay run needs (disable the live provider, insert `llm-replay`, disable the uploader). The resolved plugin graph of any scenario is not committed anywhere in this shard, so I could not verify which plugins are active in a given replay beyond those named in the patch files.
- **The `session/title` mechanism is only half-visible here.** `snapshots/sdk/session-title-after-turn/` and `session-title-stability/` pin the *inputs* (a `session/title-llm-request` event and a `session/title` event) and the replay scripts that produce them, but the code that decides whether a title is accepted, and the "accepted title commits only after the main turn has closed" pacing rule named in `snapshots/sdk/session-title-after-turn/cordis.snapshot.yml:3-4`, live outside this shard. I could not establish the acceptance criteria.
- **`snapshots/sdk/subagent-activation-limit/cordis.yml:3` sets `maxActiveSubagents: 8` but the golden shows an effective limit of 1.** The fixture plugin `packages/test-support/session-snapshot/tests/fixtures/subagent-activation-limit.ts` (not in this shard) is what narrows it. I could not confirm whether the plugin narrows the limit or whether the *effective* limit is derived from something else.
- **The two large system prompts and the six large tool-schema catalogues were not read body-line by body-line.** I am confident about their structure, every section boundary, every tool name and every change set; I am **not** able to vouch for the exact wording of every individual tool description inside them.
- **`snapshots/sdk/serial-created/session.jsonl` (v0) is a *packed-row* layout** and the README says retained v0/v1 fixtures "may use canonical packed rows" and are handled by a temporary migrator. I read the file and understand the row vocabulary, but I could not determine from this shard alone whether the `sourceEventSeqs` range `[13..41]` in its `assistant/message` row refers to pre-expansion or post-expansion sequence numbers — the two interpretations differ, and the answer is in the migrator (`scripts/migrate-packed-session-fixtures.ts`), which is outside this shard.
- **The `multi-turn` scenario has no `notifications.expected.jsonl`** even though it has a `writer.expected.jsonl`; per sdk.snapshot.ts:932 a retained scenario looks for `notifications.current.expected.jsonl`, which is absent here. I could not establish whether the wire golden was deliberately dropped for the retained scenario or is simply missing.
