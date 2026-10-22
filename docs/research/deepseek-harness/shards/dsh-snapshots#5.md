# deepseek-harness / dsh-snapshots#5

## Shard shape

This shard is **entirely recorded-session fixture data** — 258 files, 1.58 MB, all under `snapshots/session/`. There is no production code here: the unit of work is a *scenario*, and each scenario directory carries a closed `snapshot.yml` manifest, a `cordis.yml` (live composition) and `cordis.snapshot.yml` (keyless replay composition) profile patch, one or more recorded session transcripts (`session.vN.jsonl`, up to three generations v2/v3/v4), the expected system-prompt and tool-schema sidecars it owns, and small workspace seed/expected oracles. The three headline families are: (a) **the session-log format itself**, pinned by parallel v2→v3→v4 generations of the same run so the migration is visible line by line; (b) **PTC ("program tool call") mode**, where the whole tool surface collapses to a single `run_code` wire tool and the entire tool catalogue is re-published to the model as a generated TypeScript (or Python) SDK inside the system prompt — this is the most valuable material in the shard; and (c) **snapshot/attachment plumbing** — tool-result spilling, durable image attachments, session references, and a `{{fromRequest:<regex>}}` template that lets a recorded model turn reference a path that only exists at replay time. Together they describe the harness's *agent loop, tool-calling flow, prompt assembly, tool-surface management, subagent dispatch and tool-call reliability* far more concretely than the source packages do, because a snapshot records the assembled request and the persisted log side by side.

## Per-file notes

### snapshots/session/parallel-tool-calls/snapshot.yml
Manifest: `version: 1`, headless profile, `fs` composition, `recording: authored`, header class `fs` pinned. `systemPromptSource`/`toolSchemasSource` both point at `text-turn`, so this scenario owns no prompt/schema sidecar.

### snapshots/session/parallel-tool-calls/cordis.yml
Live overlay that changes *only* the local tool-result spill storage — `spill-local.root` from `DSH_SNAPSHOT_SPILL_ROOT` (default `./.spill`), `spill-policy.maxInlineTokens` 200 under a snapshot vs 12500 otherwise — and inserts `scripts/snapshot-spill-locators.ts`. The sandboxed filesystem stack already lives in `dsh-base`, so the patch is deliberately minimal.

### snapshots/session/parallel-tool-calls/cordis.snapshot.yml
The keyless replay composition: disables the DeepSeek API-key LLM, re-pins the model to `deepseek-v4-flash`, forces `session-persistence-jsonl` with `compression: none` (the harvest path cannot read compressed logs), caps `agent-instructions` at 65536 bytes, sets a persona prefix that tells the model a `[sandbox: file access denied …]` result is policy and not a command bug, inserts `dsh-llm-replay` with flash + pro, and pins `spill-policy.maxInlineTokens` to 200.

### snapshots/session/parallel-tool-calls/session.v2.jsonl
- Purpose: the oldest retained generation of the "two tool calls in one assistant message" run.
- Key abstractions: `session`/`permission/preset`/`sandbox/mode`/`approval/policy` preamble, `agent/inbox/spliced` (the user turn is spliced in and then removed), `turn/start`, `step/start|end`, `user/message`, `session/title`, `request/header`, `request/context`, `assistant/message` (with a `stream` array), `tool/call`, `tool/result`, `turn/end`.
- Data flow: the ask is spliced in as a user message, the model answers with **two `tool-call` blocks in one assistant message** (a.txt and b.txt), each is executed and logged as its own `tool/call` + `tool/result` pair, and a second step returns the text `DONE`.
- Non-obvious design decisions: in v2 a tool result is a **`role:"user"` message whose content is a `tool-result` block**, and the system prompt is carried **inline in `request/header.system`** rather than as its own event — both changed in v3/v4.
- Edge cases / failure handling: `sourceEventSeqs` on each `tool/result` records which physical events produced it (`[13]`, `[14]`), which is how the log stays reconstructible after normalization.
- Surprising: the two reads run in **parallel inside one assistant message**, but the results are still logged in submission order, each with its own `meta.path/offset/lines/totalLines`.

### snapshots/session/parallel-tool-calls/session.v3.jsonl
Same run, next generation. Adds the standalone `system/message` event (source `plugin`) and drops `system` from `request/header`; message sources become `{kind:"plugin", plugin:"@deepseek-ai/dsh-system-prompt"}`; tool results are still `role:"user"` + `tool-result` block.

### snapshots/session/parallel-tool-calls/session.v4.jsonl
- Purpose: the current-format generation of the same parallel-tool-call run.
- Key abstractions: as v2/v3, plus `role:"tool"` results that carry `toolCallId` and `isError` directly on the message, and a `runtime-context` user message with **named `sections`** (`working-directory:current`, `sandbox:policy`, `approval:policy`).
- Data flow: `system/message` (surface node 0) is logged **before** the first `request/header`; the runtime-context block is a *user* message with `source.kind:"runtime-context"` and `form:"snapshot"`; then the request header, the context, the title, and the assistant message with its two tool calls.
- Non-obvious design decisions: the system prompt text is replaced by the token `{{system}}` in the log while the full text lives in the sidecar — the log stays a *shape* oracle, the sidecar a *content* oracle.
- Edge cases / failure handling: `surfaceOp:"append"` on every message event tells the surface layer how to apply the event; `isError:false` is explicit rather than implied by absence.
- Surprising: `request/header` carries **only** `{config, tools}` — the system prompt is no longer part of the request header, it is a first-class surface node.

### snapshots/session/parallel-tool-calls/workspace/a.txt
Seed file containing exactly the line `alpha`; the content returned by the first of the two parallel `read` calls.

### snapshots/session/parallel-tool-calls/workspace/b.txt
Seed file containing exactly the line `beta`; the content returned by the second parallel `read` call.

### snapshots/session/partial-landlock-child-failure/snapshot.yml
Manifest: `platform: posix`, `permission: read-only`, header class `sandbox` pinned, prompt and schema sidecars owned by `text-turn`.

### snapshots/session/partial-landlock-child-failure/cordis.yml
Live counterpart of the runner-classification scenario: disables `@deepseek-ai/dsh-sandbox-local` and inserts `packages/test-support/session-snapshot/tests/fixtures/partial-landlock-sandbox.ts` — a deterministic process-launch stand-in.

### snapshots/session/partial-landlock-child-failure/cordis.snapshot.yml
The same substitution plus the DeepSeek→replay swap: disables the API-key LLM and the shipping sandbox provider, inserts the partial-landlock fixture, and inserts `dsh-llm-replay` for flash + pro.

### snapshots/session/partial-landlock-child-failure/session.v2.jsonl
V2 generation: the model calls `bash` with `command: "false"`; the result is a `role:"user"` tool-result block; the prompt is inline in the request header. Permission preset `read-only`, approval policy `ask`.

### snapshots/session/partial-landlock-child-failure/session.v3.jsonl
V3 generation of the same run: standalone `system/message`, plugin-sourced runtime-context message, result still a `role:"user"` block.

### snapshots/session/partial-landlock-child-failure/session.v4.jsonl
- Purpose: proves that a **child process's exit code survives partial Landlock enforcement**.
- Key abstractions: `job/registered` and `job/settled` bracket the `bash` call; the settled record carries `status:"completed"`, `cause:"producer"`, `producerReported:true` and `detail:"exit code: 1"`.
- Data flow: model calls `bash false` → a job is registered and settled → the `tool/result` text is `[stderr]\nlandlock-run: partial enforcement (older Landlock ABI)\n[exit code: 1]`.
- Non-obvious design decisions: the model is asked to reply with **exactly** `CHILD_EXIT_PRESERVED` — the assertion is on the *model's* claim, which is only meaningful because the fixture's stderr is deterministic. The recorded model answer is `CHILD_EXIT_PRESERVED`.
- Edge cases / failure handling: `isError` stays **false** even though the child exited 1 — a non-zero exit is a *result*, not a tool failure, and the `producerReported` flag distinguishes "the process reported this" from "the harness inferred it".
- Surprising: `meta` on the result carries only `cwd` — no `exitCode` field at all; the exit code lives in the human-readable text.

### snapshots/session/persistence-provider-unload/snapshot.yml
Manifest: `composition: default`, `recording: authored`, header class `default` with **no** prompt/schema pin — this scenario is about the persistence lifecycle, not the surface.

### snapshots/session/persistence-provider-unload/runtime.cordis.yml
Three-line runtime patch: `- insert: [{id: persistence-provider-unload, name: './provider-unload.ts'}]`.

### snapshots/session/persistence-provider-unload/provider-unload.ts
- Purpose: a real Cordis plugin that proves **the persistence provider must await its consumer's cleanup when it unloads**.
- Key abstractions: `ctx.plugin({name, inject:['sessionPersistence'], apply(consumer){ consumer.effect(() => async () => {...}) }})` to register a consumer; `ctx.loader.entries()` to find the provider fiber by plugin id; `ctx.on('session/flush', …)` to hook the flush; `Promise.withResolvers()` for a two-way gate.
- Data flow: on a flush that contains a `turn/end`, the plugin finds the `session-persistence-jsonl` provider, calls `ctx.sessions.flush(session)` to finish the checkpoint, then disposes the provider fiber **while** the consumer's cleanup effect is still blocked on `release.promise`.
- Non-obvious design decisions: the plugin asserts the *ordering* in both directions — it throws `'Persistence unloaded before its consumer cleanup'` if the unload wins the race, and `'Persistence did not await its consumer cleanup'` if the provider finished without awaiting the consumer (checked at line 50, after a `scheduler.yield()`).
- Edge cases / failure handling: the `finally` block always resolves `release` and awaits the in-flight unload, so a failed assertion cannot deadlock the process; the consumer's cleanup then appends a `todo/write` event so the *final* event is one the consumer produced.
- Surprising: the assertion is expressed as a plugin at all — the same lifecycle rule could have been asserted in a unit test, but only the plugin form can observe a real provider fiber's dispose behaviour.

### snapshots/session/persistence-provider-unload/session.v4.jsonl
The expected log: the turn completes (`turn/end` at line 17) and **then** a `todo/write` event lands at line 18 as the last persisted line. The event is the consumer's cleanup write — proof that it was not swallowed by the provider's unload.

### snapshots/session/persistent-pwsh-padded-completion/snapshot.yml
Manifest: composition `persistent-pwsh-padded-completion`, header class of the same name pinned, prompt and schema sidecars owned by `persistent-pwsh-tool-turn`.

### snapshots/session/persistent-pwsh-padded-completion/cordis.yml
Live composition: `pwsh-sandbox` in `danger-full-access` rooted at `process.cwd()`, `dsh-subprocess-local`, the terminal service, the local `pwsh-snapshot-backend.mjs`, `dsh-tool-pwsh-persistent`, and a long list of **disabled** plugins (tool-jobs, goal, goal-round-driver, command-goal, tool-goal, skill, skill-filesystem, tool-skill, tool-bash) so that only the persistent pwsh tool is offered.

### snapshots/session/persistent-pwsh-padded-completion/cordis.snapshot.yml
The keyless twin of the above: same plugin set, but `llm-deepseek` disabled and `dsh-llm-replay` inserted, and `session-persistence-jsonl.compression` pinned to `none`.

### snapshots/session/persistent-pwsh-padded-completion/pwsh-snapshot-backend.mjs
- Purpose: a scripted terminal backend that drives the **real** persistent PowerShell tool and the real Session log.
- Key abstractions: `class SnapshotSession` implementing the terminal backend contract (`startSend`, `read`, `signal`, `status`, `close`); `ctx.terminals.registerBackend({type:'shell', spawn})`; the plugin exports `name` / `inject:['terminals']` / `apply(ctx)`.
- Data flow: `startSend` looks up a canned response by call index and **asserts the request really is the expected command** — it requires `request.text` to contain `[Console]::Out.Write('  PWSH_OK  ')` *and* the real `__DSH_PERSISTENT_PWSH_START_<uuid>__` / `__DSH_PERSISTENT_PWSH_END_<uuid>:` markers; it then synthesises a viewport containing the padded output, the exit code and the prompt.
- Non-obvious design decisions: the fixture refuses to be faked — if the harness stopped emitting the real command markers, the fixture throws `'padded-completion snapshot requires the actual command markers'` rather than returning a canned string.
- Edge cases / failure handling: `readOutput` is one-shot (`consumed` flag) so a re-read returns an empty delta, matching the real backend's contract; `close()` flips the status to `{kind:'exited', exitCode:0}`.
- Surprising: the *padding* (`  PWSH_OK  `) is part of the assertion, because the scenario exists to prove the terminal reader strips the marker padding and keeps the exit code.

### snapshots/session/persistent-pwsh-padded-completion/session.v4.jsonl
Two `pwsh` calls in two steps. The first result text is exactly `  PWSH_OK  ` (padding preserved verbatim), the second is `  PWSH_FAIL  \n[exit code: 7]`. Both results are `role:"tool"` with `isError:false` — the non-zero exit is reported inside the text, not as an error flag.

### snapshots/session/persistent-pwsh-tool-turn/snapshot.yml
Manifest: `platform: pwsh`, `recording: live`, header class `persistent-pwsh` pinned with **no** `systemPromptSource`/`toolSchemasSource`, so this scenario owns its own sidecars.

### snapshots/session/persistent-pwsh-tool-turn/cordis.yml
Live composition: real API-key LLM for `deepseek-v4-pro`, `sandbox-policy` in `danger-full-access` rooted at `process.cwd()`, `dsh-subprocess-local`, the terminal service, `dsh-terminal-bash` with `shellDialect: pwsh` and `timeoutMs: 30000`, `dsh-tool-pwsh-persistent`, and the goal/skill/bash plugins disabled.

### snapshots/session/persistent-pwsh-tool-turn/cordis.snapshot.yml
Keyless replay counterpart: `llm-deepseek` disabled and `dsh-llm-replay` inserted; the rest of the plugin set is identical. Session persistence is `compression: none` so the harvest can read it.

### snapshots/session/persistent-pwsh-tool-turn/session.v2.jsonl
V2 generation: the assistant message carries a `REASONING` block *and* a `tool-call` block; the result is a `role:"user"` tool-result block; the prompt is inline in the request header.

### snapshots/session/persistent-pwsh-tool-turn/session.v3.jsonl
V3 generation: adds the standalone `system/message`; the reasoning block is still a first-class content block with its own `reasoning-chunks` stream entries.

### snapshots/session/persistent-pwsh-tool-turn/session.v4.jsonl
Current generation: the `pwsh` result is a `role:"tool"` message with `toolCallId call_00_e0MSVSocL0o4UWjOdG4c2072`, `isError:false`, text `PWSH_OK`. The assistant message keeps reasoning and text as **separate blocks in the same message** — reasoning is never merged into the visible answer.

### snapshots/session/persistent-pwsh-tool-turn/system-prompt.expected.md
- Purpose: the **expected assembled system prompt** for a minimal composition.
- Key abstractions: a fixed banner ("You are an AI agent powered by DeepSeek Harness."), the persona prefix from the profile patch, then **one guidance paragraph per offered tool**.
- Data flow: the profile's `personaPrefix` is the first paragraph; each tool contributes a paragraph rendered from its own description/guidance text.
- Non-obvious design decisions: the prompt contains **no bash paragraph** even though bash exists elsewhere in the product — because the bash plugin is disabled for this composition. The prompt is a function of the *tool surface*, not of the product.
- Edge cases / failure handling: the external-data paragraphs (`web_search`, `web_fetch`) and the delegation paragraphs (`workflow`, `subagent`/`subagent_fork`) are present verbatim, so a change to those rules breaks the fixture.
- Surprising: 21 lines total for a 21-tool surface — the prompt is not a fixed preamble, it is assembled from the live registry.

### snapshots/session/persistent-pwsh-tool-turn/tool-schemas.expected.json
- Purpose: the expected **wire tool catalog** for the same composition.
- Key abstractions: `{ "initial": [ <tool schema>… ], "changes": [] }` — a list of OpenAI-style function schemas, each `{name, description, parameters{type,properties,required}}`.
- Data flow: the harness assembles the request header's `tools` from this list; the log stores the token `{{tools}}` and the sidecar holds the full catalog.
- Non-obvious design decisions: `changes` is a first-class field, not a diff — a scenario that changes its tool surface mid-run records the **complete new catalog** under `changes[n]`, so a consumer never has to apply a delta.
- Edge cases / failure handling: `write` and `edit` both carry `sandbox_permissions` (enum `workspace-write` | `danger-full-access`) and a `justification` — the escalation vocabulary is part of the *schema*, so a model cannot request a wider mode that the backend does not offer.
- Surprising: the catalog contains `exit_plan_mode` and `interrupt_agent` even in a 21-tool minimal surface — plan-mode and subagent control are always offered.

### snapshots/session/pi-ai-conversation-updates/snapshot.yml
Manifest: header class `pi-ai-conversation-updates` pinned, `toolSchemasSource: dynamic-tool-updates` (another scenario owns the catalog), `changes: 2`, `promptChanges: 1`.

### snapshots/session/pi-ai-conversation-updates/cordis.yml
Live overlay: disables `llm-deepseek`, configures `llm-pi-ai` for the `moonshotai` provider with `apiKeyEnv: MOONSHOT_API_KEY`, and inserts `dynamic-tool-prompt-updates.ts`.

### snapshots/session/pi-ai-conversation-updates/cordis.snapshot.yml
The keyless twin — but the comment says something important: *"Keep pi-ai model preparation; only the recorded response stream is substituted."* The pi-ai provider is left configured and `dsh-llm-replay` is inserted alongside it, so the *model preparation* path (not just the transport) is exercised.

### snapshots/session/pi-ai-conversation-updates/session.v4.jsonl
- Purpose: the dynamic-tool-registry case — a tool appears and disappears **inside one turn**.
- Key abstractions: `request/header` with `reason:"initial"` vs `reason:"change"`; `developer/message` with `source.kind:"tool-registry"` carrying `tool-addition` / `tool-removal` content blocks; a second `system/message` event in the same turn.
- Data flow: step 1 requests 22 tools and the model reads `task.txt`; step 2 re-issues a header with the added `snapshot_ping`, logs a `developer/message` announcing the addition, and the model calls `snapshot_ping` (result `pong`); step 3 re-issues a header **without** `snapshot_ping`, logs a `developer/message` announcing the removal, and the model answers `DONE`.
- Non-obvious design decisions: the tool set is communicated to the model as a **`developer` message**, not as text inside the system prompt — a separate, typed channel for "your surface changed".
- Edge cases / failure handling: the header is re-sent on every change with the **full** tool list, so a provider that does not diff headers still sees a consistent request.
- Surprising: the `developer/message` for the addition carries a `headerSeq: 19` field — it points at the header event it belongs to, so the log is joinable.

### snapshots/session/pi-ai-conversation-updates/system-prompt.expected.md
- Purpose: the expected prompt **for a prompt that changes mid-run**.
- Key abstractions: the file is a *sequence* of prompt versions, separated by an HTML comment marker `<!-- system/message change N -->`.
- Data flow: the first 30 lines are the base kimi-k3 prompt; the marker at line 32 introduces version 2, which re-states the whole prompt with one new paragraph inserted ("Dynamic tool guidance: call snapshot_ping once, then reply with the single word DONE.").
- Non-obvious design decisions: the change is expressed as a **full replacement of surface node 0**, and the sidecar keeps both versions, so a reviewer can see exactly what the model saw before and after.
- Edge cases / failure handling: because the whole prompt is restated, the diff between versions is a real diff — a change to a shared paragraph would show up in both copies.
- Surprising: the prompt is re-sent in full rather than patched, which is the provider-cache-hostile choice; the harness does it anyway and accepts the cost, then asserts it in a fixture.

### snapshots/session/pi-ai-conversation-updates/workspace/task.txt
Seed file: "Reply with the single word DONE after reading this file." — the content the model's first `read` call returns.

### snapshots/session/pi-ai-replay-metadata/snapshot.yml
Manifest: `composition: default`, header class `default`, no pin — the scenario exists to exercise replay metadata, not the surface.

### snapshots/session/pi-ai-replay-metadata/session.v2.jsonl
V2 generation of a trivial PONG turn: one assistant message with a text block and **no usage block**, no tool calls, prompt inline in the request header.

### snapshots/session/pi-ai-replay-metadata/session.v3.jsonl
V3 generation of the same turn: adds the standalone `system/message`; the assistant message still carries no usage counters.

### snapshots/session/pi-ai-replay-metadata/session.v4.jsonl
V4 generation: system message sourced `system-prompt`, runtime context as a `runtime-context` user message. The point of the scenario is that the *metadata* (sources, ids, seq) replays identically even for a one-line answer.

### snapshots/session/plugin-manager/snapshot.yml
Manifest: `recording: live`, `permission: danger-full-access`, header class `plugin-manager` pinned.

### snapshots/session/plugin-manager/cordis.yml
Live overlay: one row, `- id: tool-plugin-manager / disabled: false`.

### snapshots/session/plugin-manager/cordis.snapshot.yml
Keyless replay: disables the DeepSeek LLM, the plugin package inventory and the **title LLM**; forces JSONL persistence; and replaces the sandbox runner with a `passthrough-runner` (`while [ "$1" != "--" ]; do shift; done; shift; exec "$@"`) plus a matching `runnerFailureSignatures: ['passthrough-runner: profile rejected']` so a runner failure is recognisable.

### snapshots/session/plugin-manager/session.v3.jsonl
V3 generation: two `plugin_manager` calls in two steps, each preceded by a `REASONING` block; results are `role:"user"` tool-result blocks.

### snapshots/session/plugin-manager/session.v4.jsonl
- Purpose: the runtime effect of enabling/disabling a plugin.
- Key abstractions: the `plugin_manager` tool result is a **structured JSON body**: `{stage, target, enabled, changed, application, restartReason, warnings[], nextStep}`.
- Data flow: the model calls `plugin_manager {action:'set_plugin', target:'include:tool-todo', enabled:false}` → the result says `application:"restart-required"`, `restartReason:"no-hmr"`, and a `nextStep` instructing the agent to *tell the user to restart DSH*; the model then calls it again with `enabled:true` and gets the mirrored result.
- Non-obvious design decisions: the tool returns an **actionable next step in prose** (`nextStep`) rather than a boolean, so the agent can relay it without a second lookup.
- Edge cases / failure handling: `changed` distinguishes a no-op from a real change, and `warnings[]` is a list rather than a string, so a partial failure can be reported without losing the other warnings.
- Surprising: the fixture records `application:"restart-required"` for `include:tool-todo` but `application:"applied"` in the MCP scenario — the difference is that the MCP composition enables the `hmr` plugin with an empty root. Same tool, two application paths.

### snapshots/session/plugin-manager/system-prompt.expected.md
Expected prompt for this composition: the standard flash prompt with the bash/glob/grep/job/web/workflow paragraphs and **no plugin-specific text** — the plugin's own effect is in the tool result, not the prompt.

### snapshots/session/plugin-manager/tool-schemas.expected.json
Expected catalog: 26 tools — the standard surface plus `plugin_manager`, present from the first request. `changes` is empty.

### snapshots/session/plugin-manager-mcp/snapshot.yml
Manifest: header class `plugin-manager-mcp` pinned, `changes: 1`, `promptChanges: 1` — one mid-run header change and one mid-run prompt change.

### snapshots/session/plugin-manager-mcp/cordis.yml
Live overlay: enables `tool-plugin-manager` **and** the `hmr` plugin with `root: []`.

### snapshots/session/plugin-manager-mcp/cordis.snapshot.yml
Keyless replay: disables the DeepSeek LLM and the plugin inventory, forces JSONL persistence, installs the passthrough sandbox runner, inserts `dsh-llm-replay` with **two** provider ids (`deepseek-official` and `deepseek-messages`) whose models declare `contextWindow: 1000000`, `defaultMaxTokens: 256000`, `reasoningEfforts: ['off','low','high','max']` and `defaultReasoningEffort: max`, and enables `hmr` with an empty root.

### snapshots/session/plugin-manager-mcp/profile.patch.yml
A 9-line profile patch registering a **disabled** MCP entry named `demo` (streamable-http transport, `url` from `DSH_MCP_DEMO_URL`, `failOnStartupError: true`) — the entry the scenario enables at runtime.

### snapshots/session/plugin-manager-mcp/session.v3.jsonl
V3 generation: the `plugin_manager` call returns a `role:"user"` block, and the **second** `request/header` already carries `reason:"change"` with a new `system/message` — so the header-change mechanism predates v4.

### snapshots/session/plugin-manager-mcp/session.v4.jsonl
- Purpose: enabling an MCP plugin at runtime and then using a tool that was not in the first request.
- Key abstractions: `request/header` with `reason:"change"`; a `developer/message` with **three** `tool-addition` blocks; the MCP tool names are namespaced `mcp__<server>__<tool>`.
- Data flow: step 1 calls `plugin_manager {action:'set_plugin', target:'include:demo', enabled:true}` → result `{stage:'enable', application:'applied', changed:true, warnings:[]}`; step 2 re-issues the header with 30 tools (26 + `list_mcp_resource_templates`, `list_mcp_resources`, `mcp__demo__ping`, `read_mcp_resource`), logs the `developer/message`, and the model calls `mcp__demo__ping` → `pong`.
- Non-obvious design decisions: the four MCP tools are added as a **set** — resource listing, resource templates, resource read and the server's own tool — so a newly enabled server is fully addressable, not just callable.
- Edge cases / failure handling: the `developer/message` enumerates the additions individually, so the model can be told exactly which names are new rather than being handed a diff it must infer.
- Surprising: the model's own reasoning in step 2 notes "the tool was already listed in my tools before enabling" — the recorded run shows the *pre-existing* listing was stale, which is exactly the kind of drift the header-change mechanism exists to fix.

### snapshots/session/plugin-manager-mcp/system-prompt.expected.md
Two prompt versions separated by `<!-- system/message change 1 -->` (line 32). Version 2 appends an `## MCP resource servers` section naming the available servers: `["demo"]` — the prompt is extended, not regenerated.

### snapshots/session/plugin-manager-mcp/tool-schemas.expected.json
- Purpose: the expected catalog including a **mid-run header change**.
- Key abstractions: `initial` is the 26-tool first header; `changes[0]` is the **complete 30-tool header** after the plugin is enabled, not a delta.
- Data flow: a consumer reads `initial`, then each entry of `changes` in order, and gets the full catalog per header.
- Non-obvious design decisions: recording the full catalog per change costs bytes but removes an entire class of drift bug — there is no "apply the delta" code path to get wrong.
- Edge cases / failure handling: the four added names are exactly `list_mcp_resource_templates`, `list_mcp_resources`, `mcp__demo__ping`, `read_mcp_resource`; the server-namespaced name `mcp__demo__ping` shows the namespace is part of the tool identity.
- Surprising: `plugin_manager` is in *both* the initial and the changed catalog, and the `bash` description is byte-identical between them — the change really only adds names.

### snapshots/session/product-subagent-both/snapshot.yml
Manifest: composition `product-subagent-both`, header class of the same name pinned.

### snapshots/session/product-subagent-both/cordis.yml
Live composition: two Codex providers (`codex-primary`, `codex-secondary`), two Claude Code providers (`claude-primary`, `claude-secondary`) and four independent one-shot tool rows (`subagent_codex_primary`, `subagent_codex_secondary`, `subagent_claude_primary`, `subagent_claude_secondary`) each with `maxDepth: provider-managed`. The comment notes that loading the composition starts neither product.

### snapshots/session/product-subagent-both/cordis.snapshot.yml
Keyless twin: disables the DeepSeek LLM, inserts `dsh-llm-replay`, and keeps **all four** providers and all four tool rows unchanged — the only thing swapped is the external model adapter.

### snapshots/session/product-subagent-both/session.v2.jsonl
V2 generation: a PONG reply whose assistant message carries a `REASONING` block and usage 3091/23; the prompt is inline in the request header.

### snapshots/session/product-subagent-both/session.v3.jsonl
V3 generation of the same turn: standalone `system/message` added.

### snapshots/session/product-subagent-both/session.v4.jsonl
V4 generation: system message sourced `system-prompt`, runtime context as a `runtime-context` user message. The turn itself is a single PONG — the scenario's content is the *surface*, not the conversation.

### snapshots/session/product-subagent-both/system-prompt.expected.md
- Purpose: the expected prompt for a session with **five** distinct delegation tools.
- Key abstractions: the final paragraph enumerates them: "Start independent delegations with `subagent` or `subagent_claude_primary` or `subagent_claude_secondary` or `subagent_codex_primary` or `subagent_codex_secondary` or `subagent_fork`".
- Data flow: the paragraph is rendered from the live registry — the product-specific tool names are spliced into a fixed sentence.
- Non-obvious design decisions: the guidance text is **generic** ("Start independent delegations with …") and only the tool list is dynamic, so a new provider tool appears in the prompt without a prompt change.
- Edge cases / failure handling: because the names are generated, a typo in a provider's `toolName` would surface here immediately as a changed expected file.
- Surprising: the same sentence in `product-subagent-codex` lists only `subagent_codex_primary`/`subagent_codex_secondary` and in `product-subagent-result-diagnostic` only `subagent_codex` — one sentence, three shapes, all generated.

### snapshots/session/product-subagent-both/tool-schemas.expected.json
Expected catalog of 29 tools: the standard surface plus `subagent_claude_primary`, `subagent_claude_secondary`, `subagent_codex_primary`, `subagent_codex_secondary`. `changes` empty.

### snapshots/session/product-subagent-codex/snapshot.yml
Manifest: composition `product-subagent-codex`, header class of the same name pinned.

### snapshots/session/product-subagent-codex/cordis.yml
Live composition: two Codex providers and their two preset-shaped one-shot tools with `maxDepth: provider-managed`. The comment states the model is told *not* to call them and the scenario only pins the assembled schemas.

### snapshots/session/product-subagent-codex/cordis.snapshot.yml
Keyless twin: disables the DeepSeek LLM, inserts `dsh-llm-replay`, keeps the two providers and tools, disables the plugin inventory.

### snapshots/session/product-subagent-codex/session.v2.jsonl
V2 generation of the PONG turn, prompt inline in the request header.

### snapshots/session/product-subagent-codex/session.v3.jsonl
V3 generation of the PONG turn with a standalone `system/message`.

### snapshots/session/product-subagent-codex/session.v4.jsonl
V4 generation of the PONG turn with system-prompt and runtime-context sourced messages.

### snapshots/session/product-subagent-codex/system-prompt.expected.md
Expected prompt whose delegation paragraph lists `subagent`, `subagent_codex_primary`, `subagent_codex_secondary`, `subagent_fork` — the same sentence with two fewer product tools.

### snapshots/session/product-subagent-codex/tool-schemas.expected.json
Expected catalog of 27 tools: the standard surface plus `subagent_codex_primary` and `subagent_codex_secondary`. `changes` empty.

### snapshots/session/product-subagent-result-diagnostic/snapshot.yml
Manifest: composition `product-subagent-result-diagnostic`, header class pinned, and `replay: override: true` — the committed `replay.override.json` replaces the model stream recorded in the session.

### snapshots/session/product-subagent-result-diagnostic/cordis.yml
Live composition: mounts the deterministic `subagent-result-diagnostic.ts` fixture behind the **same one-shot tool schema** as the public Codex example (`toolName: subagent_codex`, `maxDepth: provider-managed`).

### snapshots/session/product-subagent-result-diagnostic/cordis.snapshot.yml
Keyless twin: keeps the deterministic provider and tool, disables the DeepSeek LLM, inserts `dsh-llm-replay`.

### snapshots/session/product-subagent-result-diagnostic/replay.override.json
Six recorded chunk groups: five `subagent_codex` calls (`call_claude_foreground`, `call_claude_background`, `call_codex_foreground`, `call_codex_background`, `call_cleanup_failure`) and two text replies — the last two both emit `PARENT_OBSERVED_DIAGNOSTICS` with different usage (2 out vs 4 out), because one is the recorded answer and the other a later re-answer.

### snapshots/session/product-subagent-result-diagnostic/session.v2.jsonl
The older diagnostic shape: foreground and background `subagent_codex` calls, a **plugin-sourced** user message "background job subagent-1 (subagent: Observe Claude background diagnostic) finished [status: failed, error; diagnostic: Product subagent failure (product: Claude)…]", and a `job_output {job_id:'subagent-1', wait:true}` call to collect the failure.

### snapshots/session/product-subagent-result-diagnostic/session.v3.jsonl
V3 generation of the same run: the `system/message` event is standalone and the background-job failure notice is still a plugin-sourced user message.

### snapshots/session/product-subagent-result-diagnostic/session.v4.jsonl
- Purpose: the **current** shape of a failing subagent, and the parent observing it.
- Key abstractions: `subagent/catalog` (version 2, `childId`, `childCreatedAt`, `mode:"external"`, `label`) records the child session; the child's settlement arrives as a `user/message` with `source.kind:"subagent-settled"`.
- Data flow: each `subagent_codex` call emits a `subagent/catalog` row, then a `tool/result` "started subagent {{id:N}}", then the settlement message; the parent then answers `PARENT_OBSERVED_DIAGNOSTICS`.
- Non-obvious design decisions: the settlement is delivered as a **user message with a typed source kind**, not as a tool result — the child is a peer conversation, not a return value. Four different failure texts are distinguished: "failed before it finished." (×4) and "finished. It cannot receive follow-up messages." (the cleanup-failure case).
- Edge cases / failure handling: the "cannot receive follow-up messages" text tells the parent that a completed-but-dirty child is not continuable — the failure is reported as a *capability* loss, not just an error.
- Surprising: the v2/v3 generations used a *different* mechanism entirely (a `background job … finished` plugin message plus `job_output` polling); v4 replaced it with a typed `subagent-settled` message. The old mechanism is still visible in the older generations, which is what makes the migration legible.

### snapshots/session/product-subagent-result-diagnostic/system-prompt.expected.md
Expected prompt whose delegation paragraph lists `subagent`, `subagent_codex`, `subagent_fork` — the single-tool variant.

### snapshots/session/product-subagent-result-diagnostic/tool-schemas.expected.json
Expected catalog of 26 tools: the standard surface plus a single `subagent_codex`. `changes` empty.

### snapshots/session/provider-cwd/snapshot.yml
Manifest: `platform: posix`, `permission: read-only`, header class `provider-cwd` pinned, and an `environment:` block setting `DSH_SNAPSHOT_PROVIDER_CWD: /recorded-provider/workspace` — the only scenario in the shard that declares an environment variable, and it declares it because the fixture needs a cwd that is not the session's.

### snapshots/session/provider-cwd/cordis.yml
Live overlay: disables `fs-sandbox` and inserts `packages/bundle/headless/tests/fixtures/provider-cwd.ts` with `root: process.env.DSH_SNAPSHOT_PROVIDER_CWD` — the comment says the fixture "supplies execution coordinates without a remote service".

### snapshots/session/provider-cwd/cordis.snapshot.yml
Keyless replay: the standard swaps plus the same `fs-sandbox` → `provider-cwd` fixture substitution.

### snapshots/session/provider-cwd/session.v3.jsonl
V3 generation of a PONG reply under read-only/ask permission, prompt inline in the request header.

### snapshots/session/provider-cwd/session.v4.jsonl
V4 generation of the same reply. The scenario's real subject is the provider cwd, not the conversation.

### snapshots/session/provider-cwd/system-prompt.expected.md
Expected flash system prompt: the standard paragraph set with no provider-cwd-specific text.

### snapshots/session/provider-cwd/tool-schemas.expected.json
Expected catalog of 25 tools — the standard surface **minus the `skill` tool**; `changes` empty.

### snapshots/session/ptc-node-read-only/snapshot.yml
Manifest: `platform: posix`, `permission: read-only`, `replay: override: true`, header class pinned, and `workspace: {final: true, parent: outside-temp}` — the generated cwd is moved outside the platform temp directory because the temp grants are themselves under test.

### snapshots/session/ptc-node-read-only/cordis.yml
Live PTC overlay: inserts the `literal-sdk` fixture, pins `deepseek-v4-pro`, forces JSONL persistence, caps `agent-instructions` at 65536, and switches the tools registry to `mode: ptc`. The comment states the consequence plainly: PTC mode "changes the registry to one wire tool, `run_code`, plus its generated TypeScript SDK prompt".

### snapshots/session/ptc-node-read-only/cordis.snapshot.yml
The keyless PTC overlay: the same plus disabling the DeepSeek LLM and inserting `dsh-llm-replay` for flash + pro.

### snapshots/session/ptc-node-read-only/replay.override.json
Two chunk groups: one `run_code` call (`call_node_policy`) whose program writes `ptc-denied.txt` and expects `EPERM`/`EACCES`/`EROFS`, checks `Object.keys(process.env).length === 0`, and compares `process.cwd()` with the bash `pwd`; then the text "Node policy and execution context verified."

### snapshots/session/ptc-node-read-only/session.v3.jsonl
V3 generation: the nested bash call is logged as `tool/ptc-dispatch-start` + `tool/ptc-dispatch` with `subCallId: call_node_policy:ptc:1`; the result is a `role:"user"` block.

### snapshots/session/ptc-node-read-only/session.v4.jsonl
- Purpose: prove the PTC program's **runtime isolation** and **sandbox policy**.
- Key abstractions: `tool/ptc-dispatch-start` / `tool/ptc-dispatch` events for every nested tool call, each with `rootCallId`, `parentCallId` and a `subCallId` of the form `<root>:ptc:<n>`; `job/registered` + `job/settled` for the nested bash.
- Data flow: `run_code` → one nested `bash {command:'pwd'}` dispatch → job settled with exit code 0 → the program's return value becomes the `role:"tool"` result `{denied:true, emptyEnvironment:true, sameWorkspace:true}`.
- Non-obvious design decisions: the nested dispatch is logged as a **first-class event with its own call id**, so a nested tool call is visible in the transcript exactly like a top-level one; the sub-call id encodes the parent chain.
- Edge cases / failure handling: the program asserts the *denial* rather than the success, so the fixture proves the sandbox actually denied the write and that the host environment variable did not leak in.
- Surprising: `process.env` starts **empty** inside the program runtime — a deliberate hardening property, asserted here.

### snapshots/session/ptc-node-read-only/system-prompt.expected.md
Expected prompt: **byte-identical to ptc-turn's** 550-line prompt (verified by a line-level `Compare-Object` against the ptc-turn baseline — zero differences).

### snapshots/session/ptc-node-read-only/tool-schemas.expected.json
Expected catalog with exactly **one** tool, `run_code` (`code`, `description` required; optional `timeoutMs`, `sandbox_permissions`, `justification`). `changes` empty. This is the whole point of PTC mode: the wire surface is one tool.

### snapshots/session/ptc-node-read-only/workspace.expected/.empty
Zero-byte marker meaning the expected workspace result is empty — the read-only run must not leave `ptc-denied.txt` behind.

### snapshots/session/ptc-node-workspace/snapshot.yml
Manifest: `platform: posix`, `permission: workspace-write`, `replay: override: true`, `environment: {ELECTRON_RUN_AS_NODE: '1'}`, header class pinned, `workspace: {final: true, parent: outside-temp}`.

### snapshots/session/ptc-node-workspace/cordis.yml
Live PTC overlay, identical to ptc-node-read-only's live patch.

### snapshots/session/ptc-node-workspace/cordis.snapshot.yml
Keyless PTC overlay, identical to ptc-node-read-only's replay patch.

### snapshots/session/ptc-node-workspace/replay.override.json
One `run_code` call whose program **writes** `ptc-created.txt`, verifies the content, checks the empty environment and the working directory; final text "Node policy and execution context verified."

### snapshots/session/ptc-node-workspace/session.v3.jsonl
V3 generation: the nested bash appears as a `tool/ptc-dispatch-start` + `tool/ptc-dispatch` pair.

### snapshots/session/ptc-node-workspace/session.v4.jsonl
V4 generation: the nested bash carries its own `job/registered` + `job/settled` pair, and the `role:"tool"` result is `{written:true, emptyEnvironment:true, sameWorkspace:true}`.

### snapshots/session/ptc-node-workspace/system-prompt.expected.md
Expected prompt: byte-identical to ptc-turn's (verified by `Compare-Object`).

### snapshots/session/ptc-node-workspace/tool-schemas.expected.json
Expected catalog with exactly one tool, `run_code`; `changes` empty.

### snapshots/session/ptc-node-workspace/workspace.expected/ptc-created.txt
Expected workspace result: the single line `created by sandboxed Node` — the file the sandboxed Node program must be able to write under `workspace-write`.

### snapshots/session/ptc-persistent/snapshot.yml
Manifest: `permission: workspace-write`, `replay: override: true`, `workspace: final: true` — the workspace is the durable memory across the loop.

### snapshots/session/ptc-persistent/cordis.yml
Live PTC overlay plus `ptc-runtime.executionMode: persistent-in-memory` — the program state survives between `run_code` calls.

### snapshots/session/ptc-persistent/cordis.snapshot.yml
Keyless PTC overlay plus the same `executionMode: persistent-in-memory`.

### snapshots/session/ptc-persistent/replay.override.json
Five recorded steps: retain a counter/alias/function plus the `tools.bash` reference; reuse them and write `persistent-count.txt`; `process.exit(7)` to kill the worker; recreate the variables and append `recreated`; a closing text that names both facts.

### snapshots/session/ptc-persistent/session.v4.jsonl
- Purpose: prove the **persistent** program runtime, and prove that its state is *lost* exactly when the worker dies.
- Key abstractions: the same `run_code` tool; the error taxonomy `code run failed (worker-exit)` vs `code run failed (abort)`.
- Data flow: step 1 declares `let counter = {value:1}`, an alias and an `increment()` function and captures `const report = tools.bash`; step 2 reuses them (`value: 2`, `alias === counter`) and writes `persistent-count.txt`; step 3 calls `process.exit(7)`; step 4 finds `counter` undefined (`missing: true`) and recreates it.
- Non-obvious design decisions: the error message states the consequence explicitly — *"Node process exited (7, signal null); retained variables were cleared"* — so the failure tells the model what was lost, not just that something failed.
- Edge cases / failure handling: the `process.exit(7)` path is the interesting one; the harness reports a **worker exit** as a distinct error class from an abort, and the model's recovery is the fixture's assertion.
- Surprising: a captured *tool method* (`const report = tools.bash`) survives between calls — the runtime keeps the binding, not just the data.

### snapshots/session/ptc-persistent/system-prompt.expected.md
Expected prompt: the same 550-line PTC shape but the `run_code` section is reworded for the persistent runtime — `code` is "the program to execute" (not "the body of an async TypeScript function") and the output rule is "Only values emitted as program output enter the conversation" (no `return`). The same prompt surface, a different runtime contract.

### snapshots/session/ptc-persistent/tool-schemas.expected.json
Expected catalog with one tool, `run_code`, whose description is **2179 characters** against ptc-turn's 1422 — the extra length is the persistent-process semantics the model must know.

### snapshots/session/ptc-persistent/workspace.expected/persistent-count.txt
Expected workspace result: two lines, `2` and `recreated` — the counter value written before the worker exit plus the recovery marker appended afterwards. The file is the loop's durable memory.

### snapshots/session/ptc-policy-change/snapshot.yml
Manifest: `permission: workspace-write`, `replay: override: true`, `workspace: final: true`.

### snapshots/session/ptc-policy-change/cordis.yml
Live PTC overlay that additionally inserts the `ptc-mode-change.ts` fixture and sets `ptc-runtime.executionMode: per-call`.

### snapshots/session/ptc-policy-change/cordis.snapshot.yml
Keyless PTC overlay with the same fixture and `executionMode: per-call`.

### snapshots/session/ptc-policy-change/replay.override.json
Three chunk groups: a `run_code` that awaits `tools.wait_for_mode_change({})` and then blocks forever, a second `run_code` that verifies the new policy denies writes, and the closing text "The file policy changed and canceled the active program. The next program could not write a file."

### snapshots/session/ptc-policy-change/session.v4.jsonl
- Purpose: a **live policy change must abort the running program**, not just affect the next one.
- Key abstractions: a second `sandbox/mode` event (`{"mode":"read-only"}`) appears at line 18, *inside* the turn; the aborted dispatch carries `{name:"AbortError", code:"ABORTED"}`.
- Data flow: step 1 blocks in `wait_for_mode_change`; the mode flips; the dispatch fails with an AbortError; the `run_code` result is `Error: code run failed (abort): sandbox mode changed`; step 2 re-runs and the program observes the write is now denied (`{"denied":true}`).
- Non-obvious design decisions: the policy change is a **logged session event**, not a silent config mutation — the log shows the mode twice, so the timeline is reconstructible.
- Edge cases / failure handling: the abort is a *distinct* error class (`abort`) from a worker exit (`worker-exit`); the two are separately nameable, which is what lets the model reason about "the world changed" versus "the program crashed".
- Surprising: the follow-up user message is a `runtime-context` message — the harness tells the model the policy changed in the same channel it uses for cwd and approval policy.

### snapshots/session/ptc-policy-change/system-prompt.expected.md
Expected prompt: the standard PTC TypeScript SDK prompt with the test-only `template_echo` binding **replaced** by `wait_for_mode_change` (548 lines, two lines shorter than ptc-turn's). The scenario's tool surface is a function of the composition, right down to the SDK block.

### snapshots/session/ptc-policy-change/tool-schemas.expected.json
Expected catalog with one tool, `run_code` and the same 1422-character description as ptc-turn's; `changes` empty.

### snapshots/session/ptc-policy-change/workspace.expected/.empty
Zero-byte marker: the aborted program must not leave `denied.txt` behind.

### snapshots/session/ptc-python-read-only/snapshot.yml
Manifest: `platform: posix`, `permission: read-only`, `environment: {DSH_PYTHON_PTC_HOST_SECRET: host-only-sentinel}`, `workspace: {final: true, parent: outside-temp}` — the sentinel is a host secret the sandbox must not expose to the program.

### snapshots/session/ptc-python-read-only/session.v4.jsonl
The Python PTC policy probe: the program tries `Path('ptc-denied.txt').write_text('forbidden')` and expects `EPERM`/`EACCES`/`EROFS`, checks `DSH_PYTHON_PTC_HOST_SECRET not in os.environ`, and compares `os.getcwd()` with the bash `pwd`; the nested bash is a `ptc` dispatch with its own job pair. The result is `{"denied": true, "environmentScrubbed": true, "sameWorkspace": true}`.

### snapshots/session/ptc-python-read-only/workspace.expected/.empty
Zero-byte marker: the denied write must leave no `ptc-denied.txt`.

### snapshots/session/ptc-python-turn/snapshot.yml
Manifest: composition `ptc-python`, `platform: posix`, header class `ptc-python` pinned — **shared** with ptc-python-read-only, so both scenarios own one prompt/schema pair.

### snapshots/session/ptc-python-turn/cordis.yml
Live Python PTC overlay: `agent-default-model` pinned to pro, JSONL persistence, `agent-instructions` 65536, `tools.mode: ptc`, the **Node** `ptc-runtime` disabled, `workflow-ptc` and `tool-workflow` disabled, and `@deepseek-ai/dsh-experimental-ptc-runtime-python` inserted — the runtime provider is swapped through the real Loader.

### snapshots/session/ptc-python-turn/cordis.snapshot.yml
Keyless Python PTC overlay: the same swap plus disabling the DeepSeek LLM and inserting `dsh-llm-replay`.

### snapshots/session/ptc-python-turn/session.v2.jsonl
V2 generation: the Python program body is the `run_code` argument, and the nested bash calls are logged as `tool/code-dispatch-start` + `tool/code-dispatch` (the v2 spelling of what became `ptc-dispatch`).

### snapshots/session/ptc-python-turn/session.v3.jsonl
V3 generation: the nested calls are already renamed `tool/ptc-dispatch-start` + `tool/ptc-dispatch` with `subCallId …:ptc:1` and `…:ptc:2`.

### snapshots/session/ptc-python-turn/session.v4.jsonl
V4 generation: both nested bash dispatches carry their own `job/registered` + `job/settled` pairs, and the `role:"tool"` result is `captured output / CODE_ONE+CODE_TWO` — the program's `print` output and its return value, both surfaced.

### snapshots/session/ptc-python-turn/system-prompt.expected.md
- Purpose: the **Python sibling of the PTC prompt** (564 lines).
- Key abstractions: a ````python` block declaring `TypedDict` arg/output classes, a `ToolCallError(Exception)` with a `toolName` attribute, and a `Tools(Protocol)` with one `async def` per tool, plus a module-level `tools: Tools`.
- Data flow: the model writes Python that `await`s `tools.bash({...})`; the prompt documents the exact output shape of every tool in Python types.
- Non-obvious design decisions: the concurrency and error idioms are **translated, not copied** — "Independent read-only calls MAY overlap under `asyncio.gather`" replaces `Promise.all`, and "a FAILED tool call raises `ToolCallError` … wrap in `try/except`" replaces `try/catch`.
- Edge cases / failure handling: the prompt says "At run time exactly two of the names declared below are bound" — the declaration list is the *full catalogue* but only `tools` and the wire tool are actually bound, so the model is told not to expect the rest.
- Surprising: the `workflow` tool is absent from the Python SDK, and `NotRequired[...]`/`Literal[...]` are used to carry optionality and unions that TypeScript expressed as `?` and `|`.

### snapshots/session/ptc-python-turn/tool-schemas.expected.json
Expected catalog with one tool, `run_code`, and a shorter 1238-character description tailored to the Python runtime.

### snapshots/session/ptc-read-image-attachment-path/snapshot.yml
Manifest: composition `ptc-image`, `replay: override: true`, `platform: posix`, header class `ptc-image` (not pinned — it shares the class with ptc-read-image).

### snapshots/session/ptc-read-image-attachment-path/replay.override.json
Two `run_code` calls; the second's argument is built with the template `{{fromRequest:<path>(.+)/red\.png</path>}}` — the path captured from an **earlier request** is spliced into the next tool call, because the attachment object's path does not exist until the first call has run.

### snapshots/session/ptc-read-image-attachment-path/session.v2.jsonl
V2 generation: the second `read_image` call targets the extension-less normalized attachment path; the nested calls are `tool/code-dispatch` pairs.

### snapshots/session/ptc-read-image-attachment-path/session.v3.jsonl
V3 generation of the same two-step image read, with `tool/ptc-dispatch` pairs.

### snapshots/session/ptc-read-image-attachment-path/session.v4.jsonl
- Purpose: the **durable attachment store** round-trip.
- Key abstractions: the tool result carries `{path, image:{attachmentId, mediaType, bytes, width, height}}`; the durable object lives at `{{cwd}}/.dsh/attachments/v1/objects/<b1>/<sha256>`.
- Data flow: the first `run_code` reads `red.png` and gets an `attachmentId` of `sha256:b1ff9c8e…`; the image itself is delivered to the model in the **next** turn as a `ptc-mode` user message; the second `run_code` reads the *normalized* object path (no extension) and gets the same attachment id back.
- Non-obvious design decisions: the attachment is content-addressed by SHA-256, so the same bytes read twice produce the same id and the same durable object.
- Edge cases / failure handling: the model-visible path is the extension-less `.dsh/attachments/v1/objects/...` path, which the `read_image` gate still accepts — the extension-less form is a first-class input, not an accident.
- Surprising: the *image* is not in the tool result — it is delivered as a separate user message in the next step, so the model sees the picture without it having to fit in the tool-result text.

### snapshots/session/ptc-read-image-attachment-path/workspace/red.png
Binary fixture: a 69-byte 1×1 red PNG. Opened at byte level (PNG magic `89 50 4E 47 0D 0A 1A 0A`, IHDR 1×1 8-bit RGB, SHA-256 `b1ff9c8ea3a780ba…`) and confirmed byte-identical to the other red.png seeds.

### snapshots/session/ptc-read-image/snapshot.yml
Manifest: composition `ptc-image`, header class `ptc-image` pinned, `toolSchemasSource: ptc-turn` (the catalog is owned by another scenario), `platform: posix`, `workspace: final: true`.

### snapshots/session/ptc-read-image/cordis.yml
Live PTC image overlay: pins the vision model `deepseek-v4-flash-vision-exp`, sets `tools.mode: ptc`, and mounts `dsh-attachment-local` so a nested `read_image` result can cross the generic rich-result bridge.

### snapshots/session/ptc-read-image/cordis.snapshot.yml
Keyless replay: the same plus per-model `inputModalities` in the replay catalog — flash and pro are `[text]`, `deepseek-v4-flash-vision-exp` is `[text, image]`.

### snapshots/session/ptc-read-image/session.v2.jsonl
V2 generation: one `run_code` program writes a one-pixel PNG with Node and calls `read_image` on it; the nested calls are `tool/code-dispatch` pairs and the image is delivered later as a user message.

### snapshots/session/ptc-read-image/session.v3.jsonl
V3 generation of the same generated-image run, with `tool/ptc-dispatch` pairs.

### snapshots/session/ptc-read-image/session.v4.jsonl
- Purpose: an image produced *inside* the program and read back through the nested tool bridge.
- Key abstractions: the `run_code` result is a bare path string `{{cwd}}/red.png`; the image arrives in the **next** turn as a `ptc-mode` user message.
- Data flow: the program writes the PNG bytes with Node and calls `read_image`; the nested dispatch returns the path; the harness then splices a `ptc-mode` user message carrying `<path>…</path> <type>image</type> image/png image, 1x1 px, 69 bytes` into the next step.
- Non-obvious design decisions: the image is delivered via a **dedicated message kind** (`ptc-mode`) rather than being inlined into the tool result — the same channel family as `agent-instructions` and `runtime-context`.
- Edge cases / failure handling: the message is *spliced* into the next step via `agent/inbox/spliced` (inserted then removed), so the ordering is explicit rather than implied by the tool result.
- Surprising: the tool result itself contains only the path — the model must be told the image exists through a separate message.

### snapshots/session/ptc-read-image/system-prompt.expected.md
Expected prompt: the PTC prompt with the model line changed to `deepseek-v4-flash-vision-exp` and the test-only `template_echo` binding removed (545 lines).

### snapshots/session/ptc-read-image/workspace.expected/red.png
Binary fixture: a 69-byte 1×1 red PNG (PNG magic, SHA-256 `b1ff9c8ea3a780ba…`) — the image the program must regenerate and the reader must see.

### snapshots/session/ptc-turn/snapshot.yml
Manifest: composition `ptc`, `recording: live`, header class `ptc` pinned — the owner of the shared PTC prompt and schema sidecars.

### snapshots/session/ptc-turn/cordis.yml
Live PTC overlay: `literal-sdk` fixture, model `deepseek-v4-pro`, JSONL persistence, `agent-instructions` 65536, `tools.mode: ptc`, and the persona prefix "You are a coding assistant powered by the {{model}} model. Verify your work by running the code or tests."

### snapshots/session/ptc-turn/cordis.snapshot.yml
Keyless PTC overlay: the canonical replay patch reused by every ptc-* sibling — `literal-sdk` + disabled DeepSeek LLM + `tools.mode: ptc` + `dsh-llm-replay` for flash and pro.

### snapshots/session/ptc-turn/session.v2.jsonl
V2 generation: ONE `run_code` program that calls the bash tool twice (`echo CODE_ONE`, `echo CODE_TWO`), with the nested calls logged as `tool/code-dispatch-start` + `tool/code-dispatch` pairs and the program result as a `role:"user"` block.

### snapshots/session/ptc-turn/session.v3.jsonl
V3 generation of the same program, with the nested calls renamed `tool/ptc-dispatch-start` + `tool/ptc-dispatch`.

### snapshots/session/ptc-turn/session.v4.jsonl
- Purpose: the canonical PTC shape — one wire tool, many nested calls.
- Key abstractions: `tool/ptc-dispatch-start` / `tool/ptc-dispatch` with `rootCallId`, `parentCallId`, `subCallId: <root>:ptc:<n>`; each nested call carries its own `job/registered` + `job/settled` pair.
- Data flow: the model calls `run_code` once; the program calls `tools.bash` twice; both nested calls are logged as dispatches with job lifecycles; the program's return value and `console.log` output both become the `role:"tool"` text `captured output / CODE_ONE+CODE_TWO`.
- Non-obvious design decisions: the *nested* calls are first-class events with their own job lifecycle — a `run_code` that spawns three shell commands produces three job records, so the job list and the transcript agree.
- Edge cases / failure handling: `surfaceOp:"append"` and `sourceEventSeqs` keep the nested ordering reconstructible even though the events are interleaved with the parent's.
- Surprising: the model's reasoning in step 1 is *its own* text and is preserved verbatim in the fixture — the snapshot keeps the model's internal narration as a content block, which is unusual for a transcript oracle.

### snapshots/session/ptc-turn/system-prompt.expected.md
- Purpose: **the single most informative prompt in the shard** — what a code-mode agent is told.
- Key abstractions: (1) the harness banner; (2) the persona prefix; (3) a one-line statement of the tool-surface rule; (4) the exit-code rule; (5) one guidance paragraph per *offered* tool; (6) a `## Writing code for run_code` section; (7) a generated TypeScript SDK block.
- Data flow: the model is told "`run_code` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program." The SDK block then declares every tool's argument and output types.
- Non-obvious design decisions: the concurrency contract is stated as a **safety rule, not a capability** — "Independent read-only calls MAY overlap under `Promise.all` (safe calls run concurrently; mutating calls run alone, in submission order)". The output contract is stated as a *budget* rule — "Only what you print or return is program output … every other intermediate result stays out of the conversation, so extract just what you need."
- Edge cases / failure handling: `ToolCallError` is declared with a `toolName` field, so a failed nested call is catchable and self-identifying; `timeoutMs` is documented as including "nested tool and approval waits" — the program budget covers everything it triggers.
- Surprising: the SDK block is **generated from the tool registry**, not hand-written — the same `ToolArgsMap`/`ToolOutputMap` shape also appears in the JSON schema sidecar, so the prompt and the wire schema are two renderings of one source of truth. The `template_echo` binding appears in the SDK but never in the wire surface, which is how "declared ≠ callable" is made visible.

### snapshots/session/ptc-turn/tool-schemas.expected.json
- Purpose: the expected wire catalog for PTC mode — **one** tool.
- Key abstractions: `{initial:[{name:"run_code", description, parameters{properties:{code,description,timeoutMs,sandbox_permissions,justification}, required:["code","description"]}}], changes:[]}`.
- Data flow: the `run_code` schema is what the provider receives; every other tool reaches the model only through the prompt's SDK.
- Non-obvious design decisions: the tool description is a **paragraph of contract, not a label** — it states the fresh-process-per-call model, that `process.env` starts empty, that relative paths use the supplied working directory, that a sandbox escalation approves "this complete program for one execution only", that "Earlier effects may already have completed: inspect them before explicitly retrying", and that "Programs are never replayed automatically". The `timeoutMs` description reads "Default 120000; capped at 600000. Zero does not disable the deadline."
- Edge cases / failure handling: `sandbox_permissions` + `justification` are declared on `run_code` as a pair, so a program-level escalation is a first-class, reviewable request — and "Request wider access only after evidence of a denial" forbids reflexive escalation.
- Surprising: `justification`'s wording ("Use the language of the user's current request") and `description`'s wording ("Clear, concise description … shown in the UI") are *the same strings* the top-level tools use — one vocabulary, reused at two levels.

### snapshots/session/ptc-workspace-context/snapshot.yml
Manifest: header class `ptc-workspace-context` pinned with `systemPromptSource: ptc-turn` and `toolSchemasSource: ptc-turn` (the prompt and catalog are owned elsewhere), plus `replay: override: true`.

### snapshots/session/ptc-workspace-context/cordis.yml
Live overlay: PTC mode plus a 64 KB `agent-instructions` cap. The comment states the mechanism: "The default filesystem tools trigger nested instruction discovery after a read."

### snapshots/session/ptc-workspace-context/cordis.snapshot.yml
Keyless counterpart: PTC mode added to the default filesystem suite, plus `dsh-llm-replay`.

### snapshots/session/ptc-workspace-context/replay.override.json
Two chunk groups: one `run_code` call reading `nested/task.txt` through `tools.read`, then the text "**Code Mode workspace handshake:** `CODE_MODE_CONTEXT_OK`".

### snapshots/session/ptc-workspace-context/session.v2.jsonl
V2 generation: the program calls `tools.read` on `nested/task.txt`; a user message with `source.kind:"agent-instructions"` arrives as a `<system-reminder>` block; the prompt is inline in the request header.

### snapshots/session/ptc-workspace-context/session.v3.jsonl
V3 generation: same, with a standalone `system/message` event and a second `agent-instructions` message naming `nested/AGENTS.md`.

### snapshots/session/ptc-workspace-context/session.v4.jsonl
- Purpose: **workspace-scoped instruction discovery, delivered mid-turn**.
- Key abstractions: `user/message` with `source.kind:"agent-instructions"`, arriving as a `<system-reminder>` block; `agent/inbox/spliced` with `target:"next-step"` inserting it *after* the step that triggered it.
- Data flow: step 1's program calls `tools.read` on `nested/task.txt` and gets the read tool's JSON back; the harness then discovers `nested/AGENTS.md` and splices an `agent-instructions` user message into step 2; the model answers the handshake.
- Non-obvious design decisions: the nested instruction is delivered **after** the read that revealed it, and only for the step that needs it — it is not hoisted into the system prompt, so the prefix stays cache-stable and the instruction is delivered exactly once.
- Edge cases / failure handling: the message is spliced in and then removed (`removedCount: 1`), so it is not repeated into later turns.
- Surprising: the instruction content is the *only* thing that changes between the two steps — the request header is unchanged, so the model receives new information without a header change.

### snapshots/session/ptc-workspace-context/workspace/AGENTS.md
Workspace root instruction seed: "Workspace snapshot root instruction."

### snapshots/session/ptc-workspace-context/workspace/nested/AGENTS.md
Nested instruction seed: "When asked for the Code Mode workspace handshake, answer exactly `CODE_MODE_CONTEXT_OK` and nothing else." — the file the harness must discover *after* the read.

### snapshots/session/ptc-workspace-context/workspace/nested/task.txt
Seed file the program reads: "Touch this file to discover the nested workspace instruction."

### snapshots/session/pty-tools-sandbox-backend/snapshot.yml
Manifest: composition `pty-sandbox-backend`, header class of the same name pinned.

### snapshots/session/pty-tools-sandbox-backend/cordis.yml
Live PTY composition: `dsh-terminal` + `dsh-terminal-bash` with tight, explicit timings — `pollIntervalMs: 10`, `exactProbeAfterMs: 20`, `idleSilenceMs: 250`, `handoffGraceMs: 250`, `timeoutMs: 2000`, `disposeGraceMs: 500` — plus `dsh-tool-terminal`.

### snapshots/session/pty-tools-sandbox-backend/cordis.snapshot.yml
Keyless replay: disables the DeepSeek LLM, inserts the `pty-snapshot-backend` and `dsh-llm-replay`, and mounts `dsh-tool-terminal` with `maxResultBytes: 64` — deliberately small so the read window is exercised.

### snapshots/session/pty-tools-sandbox-backend/pty-snapshot-backend.mjs
- Purpose: a deterministic in-memory PTY backend.
- Key abstractions: `class SnapshotSession` with `motd`, `statusValue`, `scrollback` and the four backend methods `startSend`, `read`, `signal`, `status`, `close`; `ctx.terminals.registerBackend({type:'shell', spawn})`.
- Data flow: `startSend` appends `request.text + "\nPTY_OK\ndsh> "` to the scrollback and returns a viewport plus a `waitReason: 'stdin_read'`; `read({offset,count})` pages the scrollback and reports `totalLines`, `lineBegin`, `lineEnd`.
- Non-obvious design decisions: the backend implements the **real** contract — `readOutput` is one-shot, `read` pages from the end, `close` reports `{kind:'exited', exitCode:0, signal:null}` — so the real tool's pagination and teardown paths are exercised, not mocked away.
- Edge cases / failure handling: `signal()` always reports `delivered: true, targetPgid: 1`; the missing-session case is handled by the *tool*, not the backend (see the session note).
- Surprising: `close()` reports exit code 0 — the backend has no process, so the exit status is synthetic and must match what the tool expects.

### snapshots/session/pty-tools-sandbox-backend/session.v2.jsonl
V2 generation of the five PTY tool calls (open, read, signal on a missing session, close, list) with results as `role:"user"` blocks.

### snapshots/session/pty-tools-sandbox-backend/session.v3.jsonl
V3 generation of the same five calls with a standalone `system/message` event.

### snapshots/session/pty-tools-sandbox-backend/session.v4.jsonl
- Purpose: the five PTY tools end to end, **including one error path**.
- Key abstractions: `terminal_open`, `terminal_read`, `terminal_signal`, `terminal_close`, `terminal_list` — one tool per step, each with its own `tool/call` + `tool/result` pair.
- Data flow: open → "started terminal session pty-1 (main) [type: shell] / dsh>"; read → "dsh> / [lines: 0-1 of 1]"; signal on `pty-missing` → **isError true** "Error: unknown PTY session pty-missing"; close → "closed terminal session pty-1"; list → "(no terminal sessions)".
- Non-obvious design decisions: the missing-session error is a **tool error** (`isError: true`) while the rest are successes — the tool surface distinguishes "your call was wrong" from "it worked".
- Edge cases / failure handling: the read result carries an explicit window marker `[lines: 0-1 of 1]`, so the pagination arithmetic is visible in the transcript.
- Surprising: the model is asked to exercise "six PTY tools" but the transcript has five calls — `terminal_send` is present in the *schema* (see the sidecar) yet unused here.

### snapshots/session/pty-tools-sandbox-backend/system-prompt.expected.md
Expected prompt with the terminal-specific paragraph: "Use a terminal session only when work needs persistent terminal state or interactive stdin; prefer shell/read/write/edit for bounded one-shot operations. Track every terminal session id and close sessions that no longer matter. An inferred_idle or timeout result does not prove the foreground command exited." — a **negative** instruction about interpreting a timeout.

### snapshots/session/pty-tools-sandbox-backend/tool-schemas.expected.json
Expected catalog of 31 tools: the standard surface plus the six PTY tools `terminal_open`, `terminal_read`, `terminal_send`, `terminal_signal`, `terminal_close`, `terminal_list`. `changes` empty.

### snapshots/session/pwsh-tool-turn/snapshot.yml
Manifest: composition `pwsh`, `recording: live`, `platform: pwsh`, header class `pwsh` pinned.

### snapshots/session/pwsh-tool-turn/cordis.yml
Live pwsh composition: the real API-key LLM for `deepseek-v4-pro`, `bash-sandbox` **disabled**, `pwsh-sandbox` enabled, `dsh-shell-env` mounted, and the goal/skill/bash tool plugins disabled.

### snapshots/session/pwsh-tool-turn/cordis.snapshot.yml
Keyless twin: `llm-deepseek` disabled and `dsh-llm-replay` inserted; the rest of the plugin set is identical.

### snapshots/session/pwsh-tool-turn/session.v2.jsonl
V2 generation of the pwsh turn: a `REASONING` block plus the tool call, result as a `role:"user"` block, prompt inline in the request header.

### snapshots/session/pwsh-tool-turn/session.v3.jsonl
V3 generation of the same turn with a standalone `system/message` event.

### snapshots/session/pwsh-tool-turn/session.v4.jsonl
- Purpose: a plain one-shot pwsh call.
- Key abstractions: `job/registered` + `job/settled` bracket the tool call (status `completed`, cause `producer`); the result is a `role:"tool"` message with `meta.cwd`.
- Data flow: the model reasons, calls `pwsh` with `[Console]::Out.Write('PWSH_OK')`, the job is registered and settles with exit code 0, the result text is `PWSH_OK`, and the model answers `DONE`.
- Non-obvious design decisions: the result's `meta` carries `cwd` — the *execution* directory — so the transcript records where the command ran even though the command was relative.
- Edge cases / failure handling: the model reasons in prose ("The command executed successfully and printed \"PWSH_OK\". Now I need to reply with \"DONE\" and stop.") and the fixture keeps it, so a regression that drops the exit code would be visible in the reasoning too.
- Surprising: the pwsh tool is used *without* a `description` argument in the persistent-pwsh-tool-turn fixture but *with* one here — the schema is `command` only, so the extra key is tolerated and simply ignored.

### snapshots/session/pwsh-tool-turn/system-prompt.expected.md
Expected 13-line prompt for the minimal pwsh surface: the harness banner, the persona prefix "You are a concise snapshot agent.", and only the guidance paragraphs for the tools that are actually offered.

### snapshots/session/pwsh-tool-turn/tool-schemas.expected.json
Expected catalog of 21 tools: the standard surface with `pwsh` in place of `bash`, and **no** `skill`, `create_goal`, `get_goal` or `update_goal` tools. `changes` empty.

### snapshots/session/ralph-loop/snapshot.yml
Manifest: composition `ralph`, header class `ralph` pinned, `childSystemPrompts: [1, 2]` and `childToolSchemas: [1, 2]` (the two child roles own their own sidecars), `replay: override: true`.

### snapshots/session/ralph-loop/cordis.yml
Live composition: one insert of `dsh-tool-ralph` with `subagentProvider: spawn` and `maxRounds: 64`.

### snapshots/session/ralph-loop/cordis.snapshot.yml
Keyless replay: the comment explains *why* the file restates the swaps — "The shared replay patch in `text-turn/cordis.snapshot.yml` applies only to the `default` composition, so a sibling composition restates those swaps and adds its own rows."

### snapshots/session/ralph-loop/replay.override.json
Two chunk groups for the parent: one `ralph` call (`call_ralph`) with `{objective, maxRounds:2}` and the closing text `RALPH SNAPSHOT COMPLETE`.

### snapshots/session/ralph-loop/session.v2.jsonl
V2 generation of the parent: one `ralph` tool call, results as `role:"user"` blocks, prompt inline in the request header.

### snapshots/session/ralph-loop/session.v3.jsonl
V3 generation of the parent: two `subagent/catalog` rows (version 0, `mode:"one-shot"`) are logged for the two child sessions.

### snapshots/session/ralph-loop/session.v4.jsonl
- Purpose: the Ralph loop — a **fresh child per round**, with the workspace as the only memory carried between rounds.
- Key abstractions: the `ralph` tool; `subagent/catalog` rows (version 0, `childId`, `childCreatedAt`, `mode`) registering each round's child session.
- Data flow: the parent calls `ralph {objective, maxRounds:2}` → two `subagent/catalog` rows are written → the tool result is "Ralph worker reported completion after 2 rounds. / Final report: {status: complete, summary, evidence…}" → the parent answers `RALPH SNAPSHOT COMPLETE`.
- Non-obvious design decisions: the parent does **not** see the children's transcripts — only a final report object. The round is a black box with a typed result.
- Edge cases / failure handling: the `subagent/catalog` rows carry `childCreatedAt` so each round's child is independently identifiable in the log.
- Surprising: v3 and v4 disagree about the child's `mode` — `one-shot` in v3, `continuable` in v4 — and the fixtures keep both, so the semantic change is visible in the data rather than in a changelog.

### snapshots/session/ralph-loop/session.1.v2.jsonl
V2 generation of Ralph child 1: `depth: 1`, a `subagent/descriptor` (version 3, `mode:"one-shot"`, `provider:"spawn"`), and a single `structured_output` tool call reporting `status:"continue"`, `summary:"ROUND_ONE_HANDOFF"`, evidence and nextSteps.

### snapshots/session/ralph-loop/session.1.v3.jsonl
V3 generation of child 1: the descriptor is still `one-shot`; the child has its own `system/message` and runtime-context messages.

### snapshots/session/ralph-loop/session.1.v4.jsonl
- Purpose: a Ralph worker's **structured handoff**.
- Key abstractions: `subagent/descriptor` version 3 with `mode:"continuable"`, `provider:"spawn"`, `agentProvider` and `agentModel`; the `structured_output` tool with `{status, summary, evidence[], nextSteps[], blocker}`.
- Data flow: the child, seeded with no parent conversation, calls `structured_output {status:'continue', summary:'ROUND_ONE_HANDOFF', evidence:['Round one inspected the workspace.'], nextSteps:['Finish the snapshot objective.'], blocker:''}` and the result is "Structured output recorded."
- Non-obvious design decisions: the child is a **continuable** session in v4 — it can be messaged later — but the Ralph loop itself still starts each round fresh, so the capability exists without being used.
- Edge cases / failure handling: the schema has an explicit `blocker` field and a `status` enum — a worker can report *blocked* rather than inventing a completion.
- Surprising: the child's `sandbox/mode` and `approval/policy` events carry `"source":"delegation"`, so the transcript distinguishes an inherited policy from a top-level one.

### snapshots/session/ralph-loop/session.2.v2.jsonl
V2 generation of Ralph child 2: `depth: 1`, one-shot descriptor, `structured_output` with `status:"complete"`.

### snapshots/session/ralph-loop/session.2.v3.jsonl
V3 generation of child 2: the same one-shot descriptor and the complete structured report.

### snapshots/session/ralph-loop/session.2.v4.jsonl
V4 generation of child 2: continuable descriptor and a `structured_output` report with `status:"complete"`, `summary:"The Ralph snapshot objective is complete."`, `evidence:["Two fresh rounds completed through the shipped app."]`, empty `nextSteps` and an empty `blocker`.

### snapshots/session/ralph-loop/system-prompt.expected.md
- Purpose: the expected **parent** prompt for a composition that owns a `ralph` tool.
- Key abstractions: the standard prompt plus one tool-specific paragraph, inserted in the same slot every other tool's paragraph occupies.
- Data flow: the paragraph tells the model when *not* to use the tool and what the loop's semantics are.
- Non-obvious design decisions: the paragraph is an explicit **misuse guard** — "Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution" — and it states the epistemic limit of the result: "Completion and blockers are worker reports, **not independent evaluation**." It also points at the alternatives: "Use same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out."
- Edge cases / failure handling: by declaring the loop's output as an *unverified report*, the prompt stops the parent from treating a worker's "done" as proof.
- Surprising: the tool's own description is not what constrains its use here — the **system prompt** does. The tool schema only says what the parameters are.

### snapshots/session/ralph-loop/system-prompt.1.expected.md
- Purpose: the expected prompt for a Ralph **child**.
- Key abstractions: the parent's prompt plus the ralph paragraph plus one extra closing line.
- Data flow: the child is told, at the very end, "When you have your final answer, you MUST report it by calling the `structured_output` tool with arguments matching its parameter schema exactly. Do not finish with a plain text answer: only the tool call counts as your result."
- Non-obvious design decisions: the child's obligation is stated as a **hard rule about the shape of the answer**, not as a description of the tool — the harness wants a parseable result, and says so.
- Edge cases / failure handling: "arguments matching its parameter schema exactly" pushes the failure mode from a malformed report to a schema error, which the harness can detect.
- Surprising: the child prompt is otherwise *identical* to the parent's except for that line — a child in a loop does not get a different persona, only a different output contract.

### snapshots/session/ralph-loop/system-prompt.2.expected.md
Expected prompt for Ralph child 2: identical to child 1's (both children carry the same prompt and the same `structured_output` obligation).

### snapshots/session/ralph-loop/tool-schemas.expected.json
Expected parent catalog: 26 tools — the standard surface plus `ralph`. `changes` empty.

### snapshots/session/ralph-loop/tool-schemas.1.expected.json
Expected child-1 catalog: 27 tools — the parent's 26 plus `structured_output`.

### snapshots/session/ralph-loop/tool-schemas.2.expected.json
Expected child-2 catalog: 27 tools, the same set as child 1.

### snapshots/session/read-image/snapshot.yml
Manifest: composition `image`, header class `image` pinned, `toolSchemasSource: text-turn`.

### snapshots/session/read-image/cordis.yml
Live image overlay: pins `deepseek-v4-flash-vision-exp`, forces JSONL persistence, caps `agent-instructions` at 65536, sets a sandbox-aware persona prefix, and mounts `dsh-attachment-local`. The comment notes the attachment store resolves its root from `$DSH_HOME` (which the harness scopes per run), so the patch carries no attachment path.

### snapshots/session/read-image/cordis.snapshot.yml
Keyless replay: the standard swaps plus **per-model `inputModalities`** — flash `[text]`, pro `[text]`, `deepseek-v4-flash-vision-exp` `[text, image]`. The comment states the consequence: "The replay catalog declares image input, so the strict read_image gate accepts the route and the tool result carries the durable image block."

### snapshots/session/read-image/session.v2.jsonl
V2 generation: one `read_image` call on `red.png` with the result as a `role:"user"` block and the prompt inline in the request header.

### snapshots/session/read-image/session.v3.jsonl
V3 generation of the same call with a standalone `system/message` event.

### snapshots/session/read-image/session.v4.jsonl
- Purpose: the **durable image block** in a tool result.
- Key abstractions: the `role:"tool"` result whose content is a text block describing the image (`<path>…</path>`, `<type>image</type>`, `image/png image, 1x1 px, 69 bytes`) plus the image payload itself; `meta.path` on the result.
- Data flow: `read_image {"file_path":"red.png"}` → the result carries the path token `{{cwd}}/red.png`, the media type, the pixel dimensions and the byte count, and the image is attached to the message.
- Non-obvious design decisions: the human-readable descriptor is **in the result text as well as in the image payload** — a model on a text-only route, or a transcript reader, can still tell what the image was.
- Edge cases / failure handling: the byte size (69) and dimensions (1×1) are recorded, so a change in the encoder would be caught by the fixture.
- Surprising: the recorded byte count (69) equals the *source file* size — the 1×1 PNG is not re-encoded on this path, unlike the gif and gradient cases.

### snapshots/session/read-image/system-prompt.expected.md
Expected vision prompt: the standard flash prompt with the model line changed to `deepseek-v4-flash-vision-exp`.

### snapshots/session/read-image/workspace/red.png
Binary fixture, **skipped**: a 69-byte 1×1 red PNG. Opened at byte level (PNG magic + IHDR 1×1 8-bit RGB, SHA-256 `b1ff9c8ea3a780ba…` — the same hash as the `attachmentId` recorded in the transcripts); not read line by line because it is binary.

### snapshots/session/read-image-attachment-path/snapshot.yml
Manifest: composition `image`, `replay: override: true`, header class `image` (shared with the other read-image scenarios).

### snapshots/session/read-image-attachment-path/replay.override.json
Two `read_image` calls; the second argument is built from `{{fromRequest:<path>(.+)/red\.png</path>}}` — a template that copies the path captured from the **first** request into the second call.

### snapshots/session/read-image-attachment-path/session.v2.jsonl
V2 generation: the second `read_image` call targets the extension-less attachment object path; results are `role:"user"` blocks.

### snapshots/session/read-image-attachment-path/session.v3.jsonl
V3 generation of the same two-step image read with a standalone `system/message` event.

### snapshots/session/read-image-attachment-path/session.v4.jsonl
V4 generation: both `read_image` results are `role:"tool"` messages whose text is the `<path>… <type>image</type> image/png image, 1x1 px, 69 bytes` block, the second on the normalized `.dsh/attachments/v1/objects/b1/…` path.

### snapshots/session/read-image-attachment-path/workspace/red.png
Binary fixture: a 69-byte 1×1 red PNG. Opened at byte level and matched against the other red.png seeds by SHA-256.

### snapshots/session/read-image-dimension/snapshot.yml
Manifest: composition `image`, authored recording, header class `image`, **no pin** — the scenario needs no prompt/schema sidecar of its own.

### snapshots/session/read-image-dimension/session.v2.jsonl
V2 generation: one `read_image` call on `wide.png` with the result as a `role:"user"` block.

### snapshots/session/read-image-dimension/session.v3.jsonl
V3 generation of the same call with a standalone `system/message` event.

### snapshots/session/read-image-dimension/session.v4.jsonl
V4 generation: the result reports "image/png image, 2001x1 px, 133 bytes" — the dimension of the very wide fixture — and the model answers `WIDE`. The scenario asserts that the *reported* dimensions survive the read.

### snapshots/session/read-image-dimension/workspace/wide.png
Binary fixture: a 133-byte 2001×1 PNG. Opened at byte level (PNG magic + IHDR 2001×1) and identified as the wide image the scenario reads.

### snapshots/session/read-image-gif/snapshot.yml
Manifest: composition `image`, authored recording, header class `image`, no pin.

### snapshots/session/read-image-gif/session.v2.jsonl
V2 generation: one `read_image` call on `red.gif` with the result as a `role:"user"` block.

### snapshots/session/read-image-gif/session.v3.jsonl
V3 generation of the same call with a standalone `system/message` event.

### snapshots/session/read-image-gif/session.v4.jsonl
V4 generation: the result reports "image/webp image, 1x1 px, 72 bytes" — the GIF was **re-encoded to WebP** on the way through the attachment store, and the byte count changed from 42 to 72.

### snapshots/session/read-image-gif/workspace/red.gif
Binary fixture: a 42-byte `GIF89a` 1×1 image. Opened at byte level (GIF89a magic, 1×1 logical screen, SHA-256 `ef1955ae757c8b96…`) and identified as the animated-format source the reader must transcode.

### snapshots/session/read-image-reencode/snapshot.yml
Manifest: composition `image`, authored recording, header class `image`, no pin.

### snapshots/session/read-image-reencode/session.v2.jsonl
V2 generation: one `read_image` call on `gradient.png` with the result as a `role:"user"` block.

### snapshots/session/read-image-reencode/session.v3.jsonl
V3 generation of the same call with a standalone `system/message` event.

### snapshots/session/read-image-reencode/session.v4.jsonl
V4 generation: the result reports "image/jpeg image, 840x840 px, 10162 bytes" although the source is a 22 565-byte PNG — the reader downscales and re-encodes to JPEG. The scenario's name is the assertion: the re-encode must be visible in the transcript, not silent.

### snapshots/session/read-image-reencode/workspace/gradient.png
Binary fixture, but opened and understood: a 22 565-byte PNG (PNG magic, SHA-256 `a49d687a…`) rendering as a green-to-magenta vertical gradient. The reader normalizes it to an 840×840 image/jpeg of 10 162 bytes, and the tool reports the **source** dimensions, format and byte size separately from the normalized copy.

### snapshots/session/read-image-text-route/snapshot.yml
Manifest: composition `image-text-route`, header class of the same name pinned, prompt and schema sidecars owned by `text-turn`.

### snapshots/session/read-image-text-route/cordis.yml
Text-route overlay: pins the **text-only** `deepseek-v4-flash` model, mounts the attachment store, and the comment states the intent — "the strict execution gate refuses on a route that does not declare image input, so a text-only deployment keeps its durable history text-clean."

### snapshots/session/read-image-text-route/cordis.snapshot.yml
Keyless replay for the refusal case: identical to the image overlay except the replay catalog leaves flash text-only (`inputModalities: [text]`), so the gate refuses and no image ever enters the durable log.

### snapshots/session/read-image-text-route/session.v2.jsonl
V2 generation: the `read_image` call is made and the result is a `role:"user"` block.

### snapshots/session/read-image-text-route/session.v3.jsonl
V3 generation of the same call with a standalone `system/message` event.

### snapshots/session/read-image-text-route/session.v4.jsonl
- Purpose: the **capability gate** on a tool, expressed as a refusal.
- Key abstractions: the model declares `inputModalities`; the tool checks it before reading.
- Data flow: the model calls `read_image {"file_path":"red.png"}` on a text-only model → the result is `isError: true` with the text `Error: cannot read "red.png" as an image: model "deepseek-v4-flash" does not declare image input; switch to an image-capable model to read images` → the model answers `UNAVAILABLE`.
- Non-obvious design decisions: the refusal names the **model** and the **remedy** ("switch to an image-capable model"), so the model can recover by choosing a different route rather than guessing.
- Edge cases / failure handling: the refusal is a tool error with `isError: true` — the model is told, not silently given an empty result, and nothing enters the durable log.
- Surprising: the *same* tool and the *same* file are a success in `read-image` and a refusal here; the only difference is one line of the replay catalog (`inputModalities`).

### snapshots/session/read-image-text-route/workspace/red.png
Binary fixture: a 69-byte 1×1 red PNG. Opened at byte level and identified by SHA-256 (`b1ff9c8ea3a780ba…`) as the same image the other scenarios seed.

### snapshots/session/repeat-tool-reminder/snapshot.yml
Manifest: `composition: default`, authored recording, header class `default`, no pin.

### snapshots/session/repeat-tool-reminder/session.v2.jsonl
V2 generation of the loop-guard case: three identical `todo_write` calls, each followed by a `todo/write` event, and a plugin-sourced reminder "You are repeating the exact same tool call with identical arguments" spliced into the **next** step.

### snapshots/session/repeat-tool-reminder/session.v3.jsonl
V3 generation: the reminder arrives as a user message with `source.kind:"plugin"` before the fourth identical call.

### snapshots/session/repeat-tool-reminder/session.v4.jsonl
- Purpose: the **repeat-tool guard** — a nudge, not a stop.
- Key abstractions: a user message with `source.kind:"repeat-tool-reminder"`, delivered via `agent/inbox/spliced` with `target:"next-step"`.
- Data flow: the model calls `todo_write` with byte-identical arguments four times in a row; after the third, the harness splices "You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before repeating it." into the next step; the model calls it a **fourth** time anyway; the turn then ends with the text `DONE.`
- Non-obvious design decisions: the reminder arrives as a **user message with its own source kind**, not as an error and not as a tool result — it is advisory, and the harness does not pretend otherwise. The fixture records the model *ignoring* it, which is the honest expected behaviour of a nudge.
- Edge cases / failure handling: the guard fires on *identical* arguments (the same call), and each `todo_write` still emits its own `todo/write` event, so the todo state is consistent even though the agent is looping.
- Surprising: the tool still **executes** on the fourth call. The harness chooses a reminder over a hard stop, and the fixture pins that choice — a policy decision made visible in a transcript.

### snapshots/session/session-query-spill/snapshot.yml
Manifest: composition `session-query`, header class `session-query` pinned, `replay: override: true`, `platform: posix`.

### snapshots/session/session-query-spill/cordis.yml
Live overlay: `spill-local` rooted at `DSH_SNAPSHOT_SPILL_ROOT`, `spill-policy.maxInlineTokens` 200 under a snapshot (12500 otherwise), the `dsh-tool-session-query` tool, the `dsh-tool-call-timeout-policy`, the `snapshot-spill-locators` plugin, and the `query-spill-verification-path` fixture.

### snapshots/session/session-query-spill/cordis.snapshot.yml
Keyless session-query patch: the same rows plus the DeepSeek→replay swap and the model re-pinned to `deepseek-v4-flash`.

### snapshots/session/session-query-spill/replay.override.json
Three chunk groups: a `session_event_read {seq:10}` call; a `bash` verification command whose file path is spliced from the **previous** request by the template `{{fromRequest:Full formatted result stored at: (.+-session_event_read[.]txt)[.] Use read}}`; and the text `DONE`. The template is the mechanism that lets a recorded turn depend on a path produced by an earlier turn.

### snapshots/session/session-query-spill/resolve-spill-command.d.mts
Typed declaration file for the fixture: `export const name`, `export const inject`, `export function apply(ctx: Context): void` — so the hand-written `.mjs` runtime module still type-checks against the Cordis plugin contract.

### snapshots/session/session-query-spill/resolve-spill-command.mjs
- Purpose: keep the **model-visible locator** and the **physical path** apart.
- Key abstractions: a Cordis plugin (`name: 'query-spill-verification-path'`, `inject: ['shell','fs']`) that monkey-patches `shell.execute` inside a `ctx.effect` and restores it on teardown.
- Data flow: the recorded command is `file="<locator>"; grep -Fq request/header "$file" && …`. The plugin matches the command with the regex `^file="([^"]+)"` **and** requires the rest to be byte-identical to the expected suffix; it then resolves the locator through `fs.processPathFromHostPath(match[1])`, single-quotes the physical path safely (`replaceAll("'", "'\"'\"'")`), and re-executes with the physical path.
- Non-obvious design decisions: the interception is **exact-match**: `if (match === null || spec.command !== match[0] + suffix) return execute.call(shell, spec)` — any other command passes through untouched, so the plugin cannot silently rewrite an unrelated command.
- Edge cases / failure handling: if the locator cannot be resolved it throws `'snapshot spill path is not readable by the shell'` rather than running a command against a literal placeholder; the shell-quoting of the physical path is done explicitly, so a path with a quote in it still works.
- Surprising: the model's transcript keeps the *locator*, and the tool log/approval also keep the locator — only the process that actually runs sees the host path. The fixture's docstring says exactly that: "Translate the physical command only; tool logging and approval keep the model-visible locator."

### snapshots/session/session-query-spill/session.v2.jsonl
V2 generation: `session_event_read {seq:10}` then a bash command that **finds** the spill file by globbing `/tmp/dsh-acp-snap-…` (the pre-locator spelling).

### snapshots/session/session-query-spill/session.v3.jsonl
V3 generation of the same case: the bash command now names the spill file directly rather than globbing for it.

### snapshots/session/session-query-spill/session.v4.jsonl
- Purpose: prove that a **spilled** tool result is complete on disk and retrievable.
- Key abstractions: `session_event_read {seq}`; the spill locator; the `job/registered` + `job/settled` pair around the verification `bash`.
- Data flow: `session_event_read {"seq":10}` returns a fenced JSON block of the target event; the follow-up `bash` greps the spilled file for `request/header` and `session_event_search` and prints `SPILL_CANONICAL_OK`; the model answers `DONE`.
- Non-obvious design decisions: the verification is done **by the model with a shell command**, not by the harness. The transcript is the evidence that the spill file really contains the whole event, and the harness cannot fake it.
- Edge cases / failure handling: the grep looks for two distinct markers, so a spill that captured only part of the event would fail the check.
- Surprising: the model-visible path in the fixture is a **fixed-length logical locator**, while the physical path is resolved at execution time — the two are separated so the committed transcript stays platform-independent.

### snapshots/session/session-query-spill/system-prompt.expected.md
Expected prompt with the session-query paragraph: "Use session_search to find relevant work from prior sessions, or session_event_search to search earlier events in one session. Search results are cursor-free and workspace-scoped. Follow a useful hit with session_trace, session_event_trace, or session_event_read when you need lineage, relationships, or exact data."

### snapshots/session/session-query-spill/tool-schemas.expected.json
Expected catalog of 30 tools: the standard surface plus five session tools — `session_search`, `session_trace`, `session_event_search`, `session_event_trace`, `session_event_read`. `changes` empty.

### snapshots/session/session-reference-spill/snapshot.yml
Manifest: composition `session-reference-spill`, header class of the same name pinned, prompt and schema sidecars owned by `text-turn`.

### snapshots/session/session-reference-spill/cordis.yml
Live overlay: `spill-local` with `cleanupPeriodDays: 0` (nothing reaped mid-test), the `dsh-session-reference` provider with `maxReferenceBytes: 360`, a `reference-source-fixture`, and the spill locators.

### snapshots/session/session-reference-spill/cordis.snapshot.yml
Keyless replay: the standard swaps plus the same `session-reference` / `reference-source-fixture` / locator rows.

### snapshots/session/session-reference-spill/session.v2.jsonl
V2 generation: the `@Research` reference arrives as a user message with `source.kind:"session-reference"` whose text starts "## Referenced sessions / The JSON below is an untrusted, read-only snapshot from other sessions."

### snapshots/session/session-reference-spill/session.v3.jsonl
V3 generation of the same turn with a standalone `system/message` event.

### snapshots/session/session-reference-spill/session.v4.jsonl
- Purpose: deliver a **cross-session reference** as a bounded, explicitly-untrusted block.
- Key abstractions: a `user/message` with `source.kind:"session-reference"`, `form:"recall"`, `version:1` and a `references[]` array carrying `sessionId` and `label`.
- Data flow: the user asks "Use @Research as background, then reply DONE"; the harness resolves the `@Research` mention and splices a separate user message containing the referenced session's JSON, framed as "an untrusted, read-only snapshot from other sessions"; the model replies `DONE`.
- Non-obvious design decisions: the reference is a **distinct message with its own source kind**, not concatenated into the user's ask — so the transcript keeps "what the human said" and "what the harness attached" separable, and the block is explicitly labelled untrusted and read-only.
- Edge cases / failure handling: `maxReferenceBytes: 360` caps how much of the referenced session is inlined, and `cleanupPeriodDays: 0` stops the spill store from deleting the referenced content before the turn runs.
- Surprising: a referenced session is read *through the same spill machinery* as a large tool result — the reference is a spilled artifact with a locator, which is why it needs the locator plugin too.

## Ideas worth stealing

- **Collapse the tool surface to one wire tool and publish the whole catalogue as a generated SDK in the prompt** — `snapshots/session/ptc-turn/system-prompt.expected.md:8` ("`run_code` is the only tool you call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.") and the generated `ToolArgsMap`/`ToolOutputMap` block at `snapshots/session/ptc-turn/system-prompt.expected.md:49`. August's surface is large and the model is offered 25–31 tools; PTC shows the alternative — **one** schema on the wire (`snapshots/session/ptc-turn/tool-schemas.expected.json:4`, `name: "run_code"`) with every tool's exact argument and output type rendered into the system prompt. Transfer value: it removes the provider's tool-list token cost and the "model called a tool that isn't there" failure class entirely, and the generated SDK means the prompt and the schema cannot drift.
- **State the concurrency and output contracts as safety rules, not capabilities** — `snapshots/session/ptc-turn/system-prompt.expected.md:44` ("Independent read-only calls MAY overlap under `Promise.all` (safe calls run concurrently; mutating calls run alone, in submission order)") and `:45` ("Only what you print or return is program output … every other intermediate result stays out of the conversation, so extract just what you need."). August's tool results go into the transcript one by one; the PTC rule is how you keep a multi-tool turn from flooding the context. Transfer value: it is a *model-facing* contract that also bounds the context window, and the Python sibling shows it translates cleanly (`snapshots/session/ptc-python-turn/system-prompt.expected.md:34`).
- **Make the tool surface change mid-run a first-class, typed event instead of a silent prompt edit** — `snapshots/session/pi-ai-conversation-updates/session.v4.jsonl:22` (a `developer/message` with `source.kind:"tool-registry"` and a `tool-addition` content block) and `:29` (the matching `tool-removal`), with the re-issued request header at `:21` carrying `reason:"change"`. August's `tool_search`/`tool_call` and the `create_goal`/`update_goal` split imply a surface that can change under the model; DSH shows how to *tell* it: a dedicated message kind, the full re-issued header, and the additions enumerated one by one.
- **Record the complete tool catalog per header, not a delta** — `snapshots/session/plugin-manager-mcp/tool-schemas.expected.json` (`changes[0]` holds the whole 30-tool header, 26 + the four MCP tools `list_mcp_resource_templates`, `list_mcp_resources`, `mcp__demo__ping`, `read_mcp_resource`). Transfer value: a consumer of the log can read header N without applying any patch, so a "tool added at step 2" fact cannot be lost or half-applied — and the *diff* between two consecutive catalogs is then a derived, reviewable artefact.
- **Give a tool a capability gate that names the remedy** — `snapshots/session/read-image-text-route/session.v4.jsonl:17` (`Error: cannot read "red.png" as an image: model "deepseek-v4-flash" does not declare image input; switch to an image-capable model to read images`) and the matching catalogue declaration at `snapshots/session/read-image/cordis.snapshot.yml:43`-`:47` (`inputModalities`). Transfer value: August's per-model capability profiles (vision, reasoning effort, context window) can be enforced the same way — the tool *refuses with the alternative named*, instead of degrading silently or failing with a stack trace.
- **A tool-result surface that separates the human-readable descriptor from the payload, and re-encodes deliberately** — `snapshots/session/read-image/session.v4.jsonl:17` (the result text carries `image/png image, 1x1 px, 69 bytes` *and* the image) versus `snapshots/session/read-image-gif/session.v4.jsonl:17` (GIF in → `image/webp` out, 42 → 72 bytes) and `snapshots/session/read-image-reencode/session.v4.jsonl:17` (22 565-byte PNG → `image/jpeg` 840×840, 10 162 bytes). Transfer value: August's image/document handling has to decide *once* what the durable representation is; the fixture proves the choice is observable in the transcript rather than a private detail.
- **Deliver discovered context as a typed message in the step that needs it, not as a prompt rewrite** — `snapshots/session/ptc-workspace-context/session.v4.jsonl:25` (a `user/message` with `source.kind:"agent-instructions"`, "Additional instructions from: nested/AGENTS.md", spliced in with `target:"next-step"`). August loads `AGENTS.md` into the system prompt today; this shows the alternative that keeps the prompt prefix cache-stable — inject the discovered instruction as its own message kind, once, in the step where it became relevant.
- **Make the tool-call guard a nudge with its own message kind, and record that the model ignored it** — `snapshots/session/repeat-tool-reminder/session.v4.jsonl:35` (a `user/message` with `source.kind:"repeat-tool-reminder"`), with the fourth identical call still executing at `:36`-`:39`. Transfer value: August's repeat-guard / stall counter work the same way, but DSH shows the *fixture* that pins "the reminder is advisory" — that is the kind of expectation a review cannot infer from code.
- **Make a tool that starts a subagent report through a typed channel, and say what the report is worth** — `snapshots/session/ralph-loop/system-prompt.expected.md:30` ("Completion and blockers are worker reports, **not independent evaluation**") and the child's hard output rule at `snapshots/session/ralph-loop/system-prompt.1.expected.md:34` ("only the tool call counts as your result"), with the child's `subagent/descriptor` at `snapshots/session/ralph-loop/session.1.v4.jsonl:2` carrying `mode:"continuable"`. Transfer value: August's `subagent`/`subagent_fork` already distinguish activation from result; DSH adds the *epistemic* framing — a child's "done" is a claim, and the prompt should say so — plus a `blocker` field so a stuck child reports blockage instead of inventing completion.
- **Log a child's settlement as a message the parent can reason about, with the child's identity** — `snapshots/session/product-subagent-result-diagnostic/session.v4.jsonl:17` (a `subagent/catalog` row with `childId`, `childCreatedAt`, `mode:"external"`, `label`) and `:23` (a `user/message` with `source.kind:"subagent-settled"`, "Background subagent {{id:1}} failed before it finished."), and the continuable case at `:59` ("finished. It cannot receive follow-up messages."). Transfer value: August's delegated Bot DM and room sessions need the same three facts — which child, did it fail or finish, and can it still be messaged — as a typed, joinable record rather than free text.
- **Translate the model-visible locator to the physical path at the execution boundary, and only there** — `snapshots/session/session-query-spill/resolve-spill-command.mjs:12` (the `shell.execute` override) and `:15` (`fs.processPathFromHostPath(match[1])`), with the exact-match guard that leaves every other command alone. Transfer value: August's spill files live under a data dir the model should not learn; this is a small, exact, auditable translation point, and the fixture records the model-visible form so the transcript stays platform-independent.
- **Let a recorded model turn depend on a value that only exists at replay time** — `snapshots/session/read-image-attachment-path/replay.override.json:15` and `snapshots/session/session-query-spill/replay.override.json:16` (the `{{fromRequest:<regex>}}` template, e.g. `{{fromRequest:Full formatted result stored at: (.+-session_event_read[.]txt)[.] Use read}}`). Transfer value: this is the piece that makes a *keyless* replay of a multi-step tool chain possible at all — a recorded turn can name a path produced by an earlier turn, so the fixture is a real causal chain rather than a transcript of literals.
- **Pin the tool surface and the system prompt as reviewable artefacts, and let scenarios share one owner** — `snapshots/session/ptc-read-image/snapshot.yml:9` (`toolSchemasSource: ptc-turn`), `snapshots/session/ptc-workspace-context/snapshot.yml:9`-`:10` (both prompt and schema owned by `ptc-turn`), and the two-version prompt file with its `<!-- system/message change 1 -->` marker at `snapshots/session/pi-ai-conversation-updates/system-prompt.expected.md:32`. Transfer value: August's tool surface changes constantly; a snapshot layer that *commits the assembled prompt and the assembled tool catalogue*, once per distinct version, turns "what did the model actually see" from an archaeology exercise into a diff.
- **Assert lifecycle ordering with a plugin, not a unit test** — `snapshots/session/persistence-provider-unload/provider-unload.ts:50` (`throw new Error('Persistence did not await its consumer cleanup')`) with the surviving final event at `snapshots/session/persistence-provider-unload/session.v4.jsonl:18`. Transfer value: August's session flush / compaction / archive ordering is exactly this kind of invariant — a plugin that hooks the real flush and asserts the ordering is far stronger than a mock-based test.
- **Make a mid-run policy change abort the running work and tell the model in the same channel as the policy** — `snapshots/session/ptc-policy-change/session.v4.jsonl:18` (a second `sandbox/mode` event inside the turn) and `:20` (`Error: code run failed (abort): sandbox mode changed`), with the follow-up `runtime-context` message carrying the new policy. Transfer value: August changes its sandbox/permission mode under the agent; DSH shows the three pieces — abort the in-flight work, log the change as a session event, and re-state the policy to the model.

## Files skipped (with reasons)

- `snapshots/session/ptc-read-image-attachment-path/workspace/red.png` — binary fixture: a 69-byte 1×1 red PNG. Opened at byte level (PNG magic `89 50 4E 47 0D 0A 1A 0A`, IHDR 1×1 8-bit RGB, SHA-256 `b1ff9c8ea3a780ba…`) and confirmed identical to the other red.png seeds; a line-by-line read of a binary file has no meaning.
- `snapshots/session/ptc-read-image/workspace.expected/red.png` — binary fixture: a 69-byte 1×1 red PNG, identified at byte level by magic + IHDR + SHA-256 `b1ff9c8ea3a780ba…`; not read line by line because it is binary.
- `snapshots/session/read-image-attachment-path/workspace/red.png` — binary fixture: a 69-byte 1×1 red PNG, identified at byte level and matched to the other seeds by SHA-256; not read line by line because it is binary.
- `snapshots/session/read-image-dimension/workspace/wide.png` — binary fixture: a 133-byte 2001×1 PNG, identified at byte level (PNG magic + IHDR 2001×1); not read line by line because it is binary.
- `snapshots/session/read-image-gif/workspace/red.gif` — binary fixture: a 42-byte `GIF89a` 1×1 image, identified at byte level (GIF89a magic, 1×1 logical screen, SHA-256 `ef1955ae757c8b96…`); not read line by line because it is binary.
- `snapshots/session/read-image-text-route/workspace/red.png` — binary fixture: a 69-byte 1×1 red PNG, identified at byte level and by SHA-256; not read line by line because it is binary.
- `snapshots/session/read-image/workspace/red.png` — binary fixture: a 69-byte 1×1 red PNG, identified at byte level (the SHA-256 equals the `attachmentId` recorded in the transcripts); not read line by line because it is binary.

`read-image-reencode/workspace/gradient.png` is binary too, but it is **not** in the skipped list: I opened it with the image reader, saw the green→magenta vertical gradient, and the reader's own report gives the source (22 565-byte PNG) and the normalized form (840×840 image/jpeg, 10 162 bytes), so it is recorded as `read` in the ledger.

## Uncertainties

- **How the 90 session transcripts are actually consumed.** I read every JSONL line and can describe the event vocabulary, the v2→v3→v4 field changes and the exact recorded model turns, but the *driver* that replays them (`packages/test-support/session-snapshot/src/{suite,harness,normalize}.ts`, `snapshots/session/headless.snapshot.ts`) is outside this shard. I therefore know **what** the fixtures assert, not **how** the harness normalizes them before comparing. Where I describe a mechanism (e.g. "`{{system}}` replaces the prompt text in the log") I read the token in the fixture and the README's statement of it, not the normalizer that performs the substitution.
- **The `changes` array shape in `tool-schemas.expected.json` is inferred from data, not from a schema.** I observed that `changes[0]` is an *array of tool schemas* (a complete 30-tool header), not a delta object with `added`/`removed` fields. I could not find a type declaration for it inside this shard, so my description of "one entry per header change, each holding the full catalog" is an observation of the one example that exists (plugin-manager-mcp) plus the package README's wording — I did not verify it against a schema.
- **`system-prompt.expected.md` prompt changes and `expectedPromptChanges`.** The marker `<!-- system/message change N -->` is observed in two files (pi-ai-conversation-updates, plugin-manager-mcp) and the manifest field `promptChanges: 1` matches the one marker in each. Whether the sidecar format supports *appending* to a cached history (as the package README describes for the "in-history" route) I could not confirm from this shard, because no in-shard fixture exercises it.
- **The `{{fromRequest:<regex>}}` template's exact semantics.** I saw it used in two `replay.override.json` files with two different regex forms (one extracting a path from a tool result, one extracting a path from a prompt-shaped line), and one `{{fromRequest:<path>(.+)/red\.png</path>}}` form that reads the *previous request*. The resolver itself lives outside this shard, so I can state that the template captures from an earlier request and substitutes into a later tool argument, but not the full grammar (e.g. whether capture groups beyond group 1 are supported).
- **The `agent/inbox/spliced` semantics are inferred.** I observed `target:"next-turn"` and `target:"next-step"`, and `removedCount`, and that a spliced message is subsequently removed. I did not read the implementation, so the exact difference between `next-turn` and `next-step` (and the `start` offset) is my reading of the fixture data, not a verified contract.
- **`subagent/descriptor` version 3 and `subagent/catalog` version 0/2.** Three different `version` values appear across the fixtures for closely related records. I did not read the catalogue schema, so I can say the records are versioned and that the values differ between generations, but not what each version denotes.
- **The `ptc-read-image` scenario's missing `workspace/` seed and `tool-schemas` sidecar.** The manifest lists neither `ptc-read-image/workspace/red.png` nor `ptc-read-image/tool-schemas.expected.json`; I confirmed by enumerating the directory and by `git ls-files` that the scenario contains only `workspace.expected/red.png`, and its `snapshot.yml` points `toolSchemasSource: ptc-turn`. The program generates the image itself, which is consistent with the absence of a seed. I mention it because an early reading of my own notes could suggest otherwise.
- **Whether the `ptc-persistent` "retained variables were cleared" message is a contractual string.** I read it verbatim in the fixture (`snapshots/session/ptc-persistent/session.v4.jsonl:31`) but could not check the code that emits it, so I cannot say whether the wording is guaranteed or merely current.
