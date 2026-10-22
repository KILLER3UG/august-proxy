# pi / coding-agent-examples-docs

## Shard shape

This shard is the **documentation and worked-example surface** of `packages/coding-agent` — the terminal agent product. It holds 184 files in three families: (a) 47 files under `docs/` — 42 Markdown pages, one `docs.json` navigation file and four PNGs — which together are Pi's *normative specification* of the agent loop, session tree, compaction, tool exposure, MCP, providers, extension lifecycle, RPC/JSON protocols, TUI and settings; (b) 119 files under `examples/extensions/`, the runnable TypeScript extension examples that are the de-facto implementation reference for every extension mechanism (the docs say so explicitly: `docs/extensions.md:386` "The checked extension examples … are the implementation reference"); and (c) 18 files under `examples/` proper — 15 SDK examples plus `README.md`, `rpc-client.ts` and `rpc-extension-ui.ts` — showing how a host embeds or drives the whole thing. Nothing in this shard is the agent loop itself — the loop lives in `packages/agent` and `packages/coding-agent/src/core` (other shards) — but the docs state the loop's contract precisely enough that the semantics can be reconstructed from here, and the examples exercise the extension API that sits *on top of* the loop. The three families fit together as: docs describe the mechanism → examples demonstrate the smallest version of it → SDK examples show how a host embeds the whole thing. Ten files are binary or machine-generated build artifacts and are listed under *Files skipped*.

The lens coverage is unusually complete for a docs shard: the agent loop and turn lifecycle are specified in `how-pi-works.md` and `extensions.md`; tool definition/execution/validation in `extensions.md` and `truncated-tool.ts`; steering and queued messages in `rpc-commands.md` and `settings.md`; session storage/branching/compaction in `session-format.md` and `compaction.md`; context management in `compaction.md` + `session-format.md#context-building`; provider/model abstraction in `models-configuration.md`, `custom-provider.md`, `virtual-models.md`; extension/skill mechanisms in `extensions.md` and `skills.md`; system-prompt philosophy and size in `extensions.md`, `prompt-customizer.ts`, `system-prompt-header.ts`; error and abort handling in `extensions.md`, `compaction.md`, `subagent/index.ts`; UI/TUI rendering and streaming in `tui.md`, `json.md`, and the overlay/game examples; config in `settings.md` and `configuration.md`; and testing approach in `custom-provider.md:208-225`, `gitlab-duo/test.ts`, `plan-mode/utils.ts` ("Extracted for testability") and the `overlay-qa-tests.ts` QA-harness example.

## Per-file notes

### packages/coding-agent/docs/how-pi-works.md
- Purpose: The 49-line normative summary of the whole agent — it is the only doc that states the loop, the tree, the context assembly and the extension model in one place.
- Key abstractions: "active branch" (the path from the current leaf to the root) as the source of history; "run" vs "turn"; session as messages + tool calls + results + model changes + compactions.
- Data flow: submitted message → appended to active branch → build request (system prompt + active branch + tools + model settings) → provider stream → record assistant response → execute tool calls → record results → one turn done; repeat only if tool results or queued messages require another request.
- Non-obvious design decisions: "Steering messages enter after the current assistant turn. Follow-up messages enter after the agent has finished its pending work. Aborting stops the current run and returns queued messages to the editor." (`:13`) — three distinct delivery semantics, and abort *returns* queued text rather than dropping it.
- Edge cases / failure handling: "Pi resolves project trust before loading project settings and resources. After the trust decision and project-resource loading, Pi loads context files." (`:48`) — an explicit ordering guarantee for the security boundary.
- Surprising: "Enabled tools use the operating-system permissions of the Pi process." (`:49`) — there is no sandbox; `docs/security.md` says so 50 times more clearly.

### packages/coding-agent/docs/index.md
- Purpose: Top-level doc landing page; the chooser table that routes a reader to the smallest mechanism that fits.
- Key abstractions: resource taxonomy (prompt template → skill → extension → TUI component → custom provider → package).
- Data flow: n/a (navigation).
- Non-obvious design decisions: "Pi's tools and extensions run with the permissions of the Pi process. Project trust controls which project resources Pi loads, but it does not sandbox tool calls." (`:39`) — the security posture stated in the *first* page, not buried.
- Edge cases / failure handling: n/a.
- Surprising: the four CLI integration modes (print / JSON / RPC / SDK) are presented as one list, so an embedder sees the process-boundary choice as a first-class decision.

### packages/coding-agent/docs/quickstart.md
- Purpose: The 136-line install-and-first-task walkthrough, plus the "choose how to customize Pi" ladder.
- Key abstractions: the installation routes (pinned installer, npm, Nix) and the resource ladder `AGENTS.md` → prompt template → skill → extension → TUI component → custom provider → package.
- Data flow: install → `cd` into a folder → `pi` → `/login` → `/model` → type a task (with `@` file mentions) → review the response and the changed files.
- Non-obvious design decisions: "Pi does not require dependency lifecycle scripts for a normal npm installation." (`:21`) — the npm install uses `--ignore-scripts` explicitly (`:18`); the customization table is ordered by *increasing power*, and the security note is attached to the *last* step of the walkthrough rather than the first (`:84`).
- Edge cases / failure handling: "For untrusted or unattended work, use a container or another sandbox." (`:84`); the uninstall section notes that none of the removal methods deletes `~/.pi/agent/` (`:135`).
- Surprising: `pi update` cannot update a Nix-installed Pi, so the Nix path is documented separately (`:29`); and the "Choose how to customize Pi" table is a *budget* statement — the doc tells you to start with the least powerful mechanism that meets your need (`:104`).

### packages/coding-agent/docs/compaction.md
- Purpose: The 463-line reference for auto-compaction, branch summarization, persisted entries and the extension hooks around them — the single densest mechanism document in the shard.
- Key abstractions: `CompactionEntry` (summary + `firstKeptEntryId` + `tokensBefore` + `usage` + `details`), `BranchSummaryEntry` (summary + `fromId`), "split user-message span", `prepareCompaction()` / `compact()` / `generateSummary()`.
- Data flow: threshold check `contextTokens > contextWindow - reserveTokens` → walk backwards accumulating token estimates to `keepRecentTokens` → collect messages → LLM summary (previous summary passed in as iterative context) → append `CompactionEntry` → context rebuild = summary + entries from `firstKeptEntryId` onward.
- Non-obvious design decisions: (a) summarization requests **disable prompt-cache writes** because they are one-off prompts (`:23`); (b) the cut may land **inside** a user-message span, in which case two summaries are generated (history + span prefix) and merged (`:104-126`); (c) `tokensBefore` is **recalculated from the rebuilt, context-edited projection** before the entry is written, so the recorded number is the context actually being replaced (`:83`); (d) `usage` of the summary call is stored so session totals include summarization work (`:165`).
- Edge cases / failure handling: "Never cut at tool results (they must stay with their tool call)." (`:136`); recovery ordering is `persist final assistant response → turn_end → agent_end → append context_edit omissions → session_before_compact → start the retry as a fresh run` (`:87-98`); if recovery compaction fails or is cancelled, the omission edits are kept, no compaction is appended and no retry is scheduled (`:98`).
- Surprising: "Omitted raw entries remain stored but do not affect cut selection, summaries, checkpoints, or token estimates." (`:83`) and "Raw transcript history, exports, billing totals, and history-search extensions can still inspect the omitted attempt." (`:98`) — an abandoned attempt is *omitted from model context* but never deleted.

### packages/coding-agent/docs/extensions.md
- Purpose: The 400-line extension-system reference: lifecycle events, handler composition rules, tool definition, tool exposure, MCP registration, state storage, UI and mode behaviour.
- Key abstractions: `ExtensionAPI` (`pi.on`, `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerProvider`, `registerMcpServer`, `registerVirtualModel`, `registerToolRenderer`, `registerEntryRenderer`, `registerMessageRenderer`, `appendEntry`, `sendMessage`, `sendUserMessage`, `events`), `ExtensionContext` (cwd, mode, ui, sessionManager, modelRuntime, signal, context usage, `compact()`, `shutdown()`), `ExtensionCommandContext` (adds `waitForIdle`, `reload`, tree navigation, session replacement).
- Data flow: factory runs at load → Pi waits for an async factory before startup continues → resources discovered → session starts → agent run → `before_agent_start` → per-turn model request → per-tool-call execution → `turn_end` → `agent_end` → `agent_before_settle` → `agent_settled`.
- Non-obvious design decisions: the **handler composition table** (`:203-213`) — notification / in-place mutation / chained transformation / gate / actionable boundary / last-override — and the instruction that "gate handlers should fail closed when their safety decision cannot be made" (`:214`); `agent_end` is explicitly **not** a final-idle signal (`:145`); `agent_before_settle` (actionable) vs `agent_settled` (notification only) (`:161-167`); `provider_stream_event` is read-only and notification-only, and "Handlers are awaited in stream order, so slow handlers delay stream consumption" (`:222-224`).
- Edge cases / failure handling: "A `tool_call` handler failure blocks the tool as a fail-safe; a tool execution failure becomes an error result for the model." (`:375`); cleanup must be idempotent because cancellation, reload, session replacement and process exit can converge on the same path (`:378`); "Code after `await ctx.reload()` still belongs to the old runtime and must not reuse its session-bound state" (`:145`).
- Surprising: **nested tool calls** (`:261`) — `ctx.executeTool` runs another tool through the *same* argument validation and the same `tool_call`/`tool_result` gates, with `parentToolCallId` and a `<parent id>/<n>` id, never adding transcript entries, and with a bounded `nestedCalls` audit record (args over 8 KiB omitted, results never stored, ≤256 calls, `complete:false` when something was dropped). Also the **exposure tiers** (`:265-277`) and `reachesTools(input)` (`:295`), where a tool declares reachability by the *words of its input*.

### packages/coding-agent/docs/cli.md
- Purpose: The complete CLI surface — modes, models, sessions, tools, resources, prompts, packages, credentials, MCP commands.
- Key abstractions: `--print` / `--mode text|json|rpc`; `--tools` / `--exclude-tools` / `--no-builtin-tools` / `--no-tools`; `--session` / `--continue` / `--resume` / `--fork` / `--clone` / `--no-session`.
- Data flow: stdin/stdout redirected → print mode; otherwise the terminal UI opens.
- Non-obvious design decisions: a `--tools` list of *only* `+name`/`-name` entries is not an allowlist but a **delta on the default selection** (`:120`, `:128`); "`--tools` selects the tools declared to the model. It does not remove MCP tools" unless an entry starts with `mcp__` (`:132`); `/reload` enables tools newly added to `defaultTools` but a tool removed with `-name` stays removed (`:128`).
- Edge cases / failure handling: `pi auth check` exits 0/1/2 for ready/not_ready/invalid (`:303`); `pi mcp list` exits 1 when an entry is invalid or a server is not connected (`:327`).
- Surprising: `pi update` cannot update Pi when another package manager owns the install (Nix) (`:283`), and `pi install`/`remove`/`config` take `--local` to write project settings instead of global.

### packages/coding-agent/docs/codemode.md
- Purpose: The `codemode` tool — the model writes JavaScript that calls other tools and non-LLM models; only the script's *output* reaches the model.
- Key abstractions: `tools.<name>(args)`, `text()`, `image()`, `store()`/`load()`, `ALL_TOOLS`, `searchTools()` (BM25), `describeTool()`, `describeNamespace()`, `models` (classifier/image model families).
- Data flow: script runs as the body of an async function in a QuickJS sandbox → calls tools via `tools.*` → result resolves to a structured value → script filters/aggregates → only `text()`/`image()` output is returned to the model.
- Non-obvious design decisions: the options line must be the *first* line or the call fails before the script runs (`:9`); "Longer output keeps its start and end, and the full text is written to a temp file whose path is included in the result" (`:15`); `bash` inside codemode resolves to up to 1 MiB of output (not the 50 KB / 2000 lines the model sees) (`:43`); "Tool calls are real: calls made before a failure are not undone. Calls still running when the script ends are cancelled" (`:18`).
- Edge cases / failure handling: 256 MB VM (`:226`); at most two codemode workers per process, a cancelled worker keeps its slot until it exits, and a script that gets no worker within 60 s fails without running (`:228`); "A script that waits on a promise that can never settle (no tool call pending) fails immediately, since there are no timers" (`:229`); scripts cannot start other codemode scripts (`:230`).
- Surprising: `store()` writes are kept **only when the script succeeds**, and each successful script appends a `codemode-store` custom entry so "each branch sees only the values written on its path" (`:56`) — a branch-aware key/value store riding on the session tree.

### packages/coding-agent/docs/session-format.md
- Purpose: The persisted contract — JSONL entries, tree structure, every entry type, and the three-stage context build.
- Key abstractions: `SessionHeader` (version 3), `SessionMessageEntry`, `ModelChangeEntry`, `ThinkingLevelChangeEntry`, `UsageEntry`, `CompactionEntry`, `ContextEditEntry`, `BranchSummaryEntry`, `CustomEntry`, `CustomMessageEntry`, `LabelEntry`, `SessionInfoEntry`.
- Data flow: `buildContextEntries()` walks leaf→root and honours the latest compaction; `buildSessionProjection()` then applies the latest `context_edit` per target; `buildSessionContext()` converts the selected entries to LLM messages.
- Non-obvious design decisions: the **system message is a patch log** — "the first request of a session persists one with every prompt section and tool declaration, and later changes persist as system messages that patch `sections` by name (`null` removes one) and list `toolsAdded`/`toolsRemoved`. Replaying them in order yields the current prompt and tools; there is no separate prompt state entry." (`:80`); `ContextEditEntry` is "Append-only edit of one earlier context-producing entry. It changes only future model context; the target entry and its metadata remain unchanged in raw history, UI, exports, and session accounting." (`:141`) and "If several edits target the same entry, the latest edit on the active branch wins. Edits are branch-relative: navigating to a point before the edit reveals the target's original contribution again." (`:147`).
- Edge cases / failure handling: session versions 1→2→3 are auto-migrated on load (`:22-30`); `custom` entries never enter LLM context while `custom_message` entries do (`:166`, `:178`); `usage` entries contribute to totals but are hidden from the conversation tree, and "Consumers should treat unknown `kind` values as normal usage rather than rejecting them" (`:121`).
- Surprising: "Entries normally form one tree, but navigation APIs can create multiple roots" and `get_tree` returns an array because orphaned entries with broken parent chains also appear as roots (`docs/rpc-commands.md:721`).

### packages/coding-agent/docs/rpc.md
- Purpose: The RPC process protocol — framing, correlation, lifecycle, errors, shutdown.
- Key abstractions: four record families (command in, `response` out, session event out, extension-UI both ways); `data.disposition` ∈ {started, queued, handled}.
- Data flow: client writes a JSONL command on stdin; Pi answers with a `response` carrying the same `id`, then streams session events on stdout.
- Non-obvious design decisions: "Use unique IDs whenever more than one command can be outstanding. Command handling is asynchronous, so clients should correlate by ID rather than response order." (`:44`); "A successful `prompt` response means the prompt was accepted, queued, or handled. It does not mean model work completed" (`:60`); "Subscribe before sending a prompt to avoid missing a fast completion." (`:71`).
- Edge cases / failure handling: malformed JSON produces a parse response *without* a request id (`:81-85`); a failed command returns one `success:false` response; "Provider failures and aborts after a prompt is accepted appear in the message and event stream" (`:87`).
- Surprising: the framing rule — "Write one complete JSON object per record and terminate it with LF… Do not use a generic line reader that treats Unicode line or paragraph separators as record boundaries. In particular, Node.js `readline` also splits on `U+2028` and `U+2029`, which are valid inside JSON strings." (`:52-54`). The minimal Python client in the doc uses a *binary* pipe reader for exactly this reason (`:99`).

### packages/coding-agent/docs/rpc-commands.md
- Purpose: The 860-line command/response reference — every stdin command, its payload and its exact response shape.
- Key abstractions: `prompt` / `steer` / `follow_up` / `abort` / `clear_queue`; `get_state`; `set_model`; `set_steering_mode` / `set_follow_up_mode`; `compact` / `set_auto_compaction`; `set_auto_retry` / `abort_retry`; `bash` / `abort_bash`; `fork` / `clone` / `get_fork_messages` / `get_entries` / `get_tree`; `export_html`; `get_commands`.
- Data flow: `prompt` → accepted/queued/handled → the run streams asynchronously; steering is delivered after the current assistant turn's tool calls finish, before the next LLM call; follow-ups wait for the agent to stop.
- Non-obvious design decisions: **"If the agent is already streaming, you must specify `streamingBehavior` to queue the message"** — the command errors rather than guessing (`:20-30`); `clear_queue` *returns the queued text* so the client can restore it into its editor, and the doc gives the recipe "To implement interactive Esc behavior, send `clear_queue` before `abort`" (`:128`); "Bash results reach the model on the **next prompt**, not immediately" (`:508`).
- Edge cases / failure handling: `get_entries` with a `since` cursor returns entries strictly after that id "even across client restarts" and `success:false` if the id matches nothing (`:691-717`); `contextUsage.tokens` and `.percent` are `null` immediately after compaction until a fresh assistant response provides valid usage (`:567`).
- Surprising: `bash` has an `excludeFromContext` flag — the output is stored in the session but omitted from the next model request (`:457`); and `get_commands` explicitly excludes built-in TUI commands because "they would not execute if sent via `prompt`" (`:834`).

### packages/coding-agent/docs/json.md
- Purpose: The canonical reference for the events shared by JSON mode and RPC mode, and the rules for reconstructing a streaming message from deltas.
- Key abstractions: `agent_start` / `turn_start` / `message_start` / `message_update` / `message_end` / `turn_end` / `agent_end` / `agent_settled`; `tool_execution_start|update|end`; `queue_update`; `entry_appended`; `compaction_start|end`; `auto_retry_start|end`; `summarization_retry_*`.
- Data flow: the provider's `start`/`done`/`error` become `message_start`/`message_end`; `message_update` carries only deltas.
- Non-obvious design decisions: **"Wire `message_update` records are delta-only. They omit the SDK event's cumulative `message` field and every `assistantMessageEvent.partial` snapshot so stream size remains linear."** (`:72`) and the client must "replace reconstructed data with the completed content in `text_end`, `thinking_end`, or `toolcall_end`" (`:93`); `durationMs` on `tool_execution_end` is "measured with a monotonic clock" (`:107`).
- Edge cases / failure handling: "Tool calls from one assistant message can run in parallel. Do not assume a sibling call or result exists when another tool event runs." (`docs/extensions.md:237`); `compaction_end` distinguishes aborted (`result` absent, `aborted:true`) from failed (`errorMessage` present) (`:157`).
- Surprising: two *separate* retry ladders — `auto_retry_*` for the assistant turn and `summarization_retry_*` for compaction and branch summaries, with a `source` of `compaction` or `branchSummary` (`:161-180`).

### packages/coding-agent/docs/sdk.md
- Purpose: The in-process TypeScript API — `createAgentSession()`, the five substitutable service boundaries, and the event contract.
- Key abstractions: `ModelRuntime`, `SettingsManager`, `SessionManager`, `DefaultResourceLoader`, `AgentSessionRuntime`; `session.prompt/steer/followUp/abort/waitForIdle/subscribe/dispose`.
- Data flow: `createAgentSession()` builds the five services, then a session; `prompt()` resolves after the run finishes including automatic retries.
- Non-obvious design decisions: "**SessionManager is authoritative for finalized model context. Restore external history by constructing the session with a manager containing those entries. Assigning `session.agent.state.messages` does not replace persisted context.**" (`:40`); "After a runtime replacement, subscriptions belong to the old `AgentSession` and must be rebound." (`:60`); a prompt sent while streaming "must specify whether it should steer the current run or follow it. Calling `prompt()` without that choice rejects rather than guessing." (`:66`).
- Edge cases / failure handling: `session.dispose()` "aborts active work, invalidates extension contexts, disconnects from the agent, and removes event listeners" (`:56`); SDK sessions do **not** get the built-in `codemode`/`tool_search`/MCP extensions — they must be added to `extensionFactories` (`:116`).
- Surprising: a *named* inline extension with `replaceable: true` is silently dropped when another extension registers a conflicting name during loading, and the CLI's built-in codemode/tool-search/MCP extensions are replaceable (`:112`).

### packages/coding-agent/docs/mcp.md
- Purpose: MCP server configuration, connection lifecycle, OAuth, exposure control, resources and permissions.
- Key abstractions: server entry (`command`/`args`/`env`/`cwd` or `url`/`headers`/`oauth`); `exposure` ∈ {codemode, deferred, direct, hidden}; `toolExposure` per-tool override; `mcp__<server>__<tool>` naming.
- Data flow: servers connect in the background at session start; a server's tools appear once connected; the first prompt waits up to 10 s only for servers with `direct` tools.
- Non-obvious design decisions: "A project entry without `command`, `url`, or `type` overrides only `enabled`, `exposure`, and `toolExposure` of the user-level server with the same name and keeps the rest, including `env`, `headers`, and `auth`." (`:34`); "Server names that differ only in `-` and `_` count as the same server" (`:77`); the `mcp_servers` system-prompt section is **appended** to the conversation rather than folded into the tool declarations, "so earlier messages stay cached" (`:202`).
- Edge cases / failure handling: "Stopping a stdio server closes its stdin, sends SIGTERM, then sends SIGKILL to its process group. This also stops servers launched through wrappers such as `npx` or `uvx`." (`:102`); HTTP 408/429/5xx are retried twice, but tool calls are not retried "because the server may already have performed them" (`:248`).
- Surprising: **"Every MCP call passes through Pi's tool pipeline. Extension `tool_call` and `tool_result` handlers, including permission gates, therefore apply to MCP tools. Calls made from codemode scripts carry the codemode call ID as `parentToolCallId`."** (`:252`) — third-party MCP tools are inside the same permission envelope as built-ins. Also: text results over 20 KB get their middle removed around a `…N chars truncated…` marker with the full text in a temp file (`:232`).

### packages/coding-agent/docs/models-configuration.md
- Purpose: The generated field-by-field reference for `models.json` — every provider/model field and every per-API compatibility flag.
- Key abstractions: `providers` → `models` / `modelOverrides`; `compat` per API family (`openai-completions`, `openai-responses`, `anthropic-messages`, `bedrock-converse-stream`, `mistral-conversations`, `typesafe-system-one`).
- Data flow: `models.json` overlays the bundled catalog; per-model `compat` overrides per-provider `compat` field by field.
- Non-obvious design decisions: the compat flags are *named differences*, not a single "compatible" switch — e.g. `requiresAssistantAfterToolResult`, `requiresThinkingAsText`, `supportsMidConvoSystemMessages`, `supportsMidConvoToolAdditions`, `thinkingFormat` with 11 named values (`:123`), `thinkingTokenBudgetField` (`:129`); `cost.tiers` — "The highest matching input threshold applies to the full request." (`:45`); `promptCache` carries best-effort lifetime per retention tier (`:51`).
- Edge cases / failure handling: "Model override entries must be objects." / invalid values in the matching override error when read, and only omitted fields fall back (`:459`).
- Surprising: `sessionAffinityFormat` — "openai sends `session_id`, `x-client-request-id`, and `x-session-affinity`" (`:137`) and `sendSessionAffinityHeaders` exists because "requests to the same replica maximize cache hits" (`:165`).

### packages/coding-agent/docs/models.md
- Purpose: Choosing and configuring models — credentials, compatible endpoints, image and classifier models, and the rules for declaring compatibility.
- Key abstractions: `models.json` provider/model entries; `modelOverrides`; `inputLimits.images.resize`; `promptCache`; `samplingParamsByThinkingLevel`; classifier model types (`choice`/`bool`/`score`).
- Data flow: credential resolution order is runtime `--api-key` → stored `auth.json` → `models.json` `apiKey` → provider env vars / ambient cloud credentials (`:23`).
- Non-obvious design decisions: "**Compatibility settings should describe verified differences in the endpoint's request or response behavior. Do not enable them based only on an endpoint advertising OpenAI or Anthropic compatibility.**" (`:140`); "Choose the conservative end of any published range" for a cache lifetime (`:111`); images are encoded once and "changing models does not rewrite historical images" (`:102`); "Pi first clamps unsupported thinking levels, then merges model `samplingParams`, the effective level's override, and request-level `samplingParams` in that order. Later values win per key." (`:138`).
- Edge cases / failure handling: OpenAI's Decisions API "rejects inputs above 922K tokens, but requests that run longer than about five seconds, currently above roughly 600K input tokens, fail with a gateway timeout" (`:157`).
- Surprising: classifier models **do not appear in `/model`** — they are reached only through the `codemode` tool or `ctx.modelRegistry.classify()`, and a classifier's usage is added to the codemode tool result so it counts toward session cost (`:182`).

### packages/coding-agent/docs/settings.md
- Purpose: Every user-configurable setting, its type, default and purpose — the config contract.
- Key abstractions: model/thinking group; interaction group; tools group (`defaultTools`, `codemode.mode`, `codemode.inlineBudget`); sessions/compaction/branch-summary group; terminal/display group; network/retry group; shell group; resources group.
- Data flow: project settings override agent-directory settings; resource lists are combined.
- Non-obvious design decisions: `defaultTools` uses a **delta syntax** — plain names replace the selection, `+name`/`-name` add/remove, and "In one list, plain names form the selection, and `+name` and `-name` then apply in order." (`:56`); `defaultProjectTrust` and `httpProxy` "**Can only be set in agent-directory settings**" (`:36`, `:125`); `cacheWarming` is `"off" | "streaming" | "idle"` and "Cache warming runs only when the model declares a cache lifetime and Pi estimates at least $0.05 in avoided cache-miss cost" (`:21-23`).
- Edge cases / failure handling: "**Keep `retry.provider.maxRetries` at 0 unless provider-level retries are required. Provider retries can delay Pi from handling quota and usage-limit errors itself.**" (`:136`); `codemode.inlineBudget` is "Estimated tokens (characters / 4) the `codemode` tool's description may spend on tool declarations" (`:44`) — a concrete prompt-budget knob.
- Surprising: `fullscreenWheelScrollLines` defaults to `"auto"`, which "moves only one line per event in local macOS terminals, which already accelerate wheel and trackpad input; elsewhere, and over SSH, it speeds up fast wheel spins to at most 6 lines per event" (`:101`) — a very specific, measured behaviour.

### packages/coding-agent/docs/configuration.md
- Purpose: Where configuration lives — the agent directory, the project `.pi` directory, and context files.
- Key abstractions: `<agent-dir>` (default `~/.pi/agent`, overridable by `PI_CODING_AGENT_DIR`); `.pi/` in the working directory.
- Data flow: user config + project config merge; project config loads only after trust.
- Non-obvious design decisions: "The only exception is `sessionDir`, which Pi reads before resolving trust so it can locate sessions." (`:3`); "For `SYSTEM.md` and `APPEND_SYSTEM.md`, the trusted project file takes precedence over the corresponding agent-directory file. Files with the same name are not combined." (`:39`).
- Edge cases / failure handling: "Context-file discovery does not require project trust." (`:47`) — `AGENTS.md`/`CLAUDE.md` are loaded even from an untrusted folder, which is a stated hole rather than an oversight (cf. `docs/security.md:57`).
- Surprising: `AGENTS.override.md` "replaces `AGENTS.md` or `CLAUDE.md` only in the same directory. It does not suppress context files from the agent directory or other directories." (`:45`).

### packages/coding-agent/docs/security.md
- Purpose: The security posture — what project trust does and does not protect, and how to actually get isolation.
- Key abstractions: project trust (a resource-loading gate, not a sandbox); isolation methods (plain Docker, Docker Sandboxes, OpenShell, Gondolin tool-only isolation).
- Data flow: `--approve`/`--no-approve` → extension `project_trust` handler → saved decision for the directory or a parent → `defaultProjectTrust` fallback.
- Non-obvious design decisions: "**Watching the transcript, using project trust, and reviewing changes do not create a security boundary.**" (`:7`); "Pi reads the project `sessionDir` setting while selecting or creating a session, before it resolves project trust. Declining trust prevents the remaining project settings and protected resources from loading, but it cannot undo that initial session-directory lookup." (`:31`); the trust decision is scoped to the *closest* saved decision for the directory or a parent (`:64`).
- Edge cases / failure handling: print/JSON/RPC modes cannot show the trust prompt, so with no override they fall back to `defaultProjectTrust` — `"always"` loads, `"ask"`/`"never"` skip (`:77-82`).
- Surprising: context files such as `AGENTS.md` load "regardless of project trust unless you disable context loading. Treat instructions in a folder as untrusted input even when you decline project trust." (`:57`).

### packages/coding-agent/docs/virtual-models.md
- Purpose: Virtual models — a selectable model that picks a physical model per request; the routing contract.
- Key abstractions: `registerVirtualModel({provider, id, name, thinkingLevels, contextWindow, maxTokens, input, route(request, ctx)})`; `ModelRoute` = `{model, thinkingLevel, state?}`; `request.reason` ∈ {user, continuation, retry, direct}.
- Data flow: selection (virtual) is recorded in `model_change`/`thinking_level_change` entries; dispatch (physical) is recorded per assistant message. Providers only ever receive physical models.
- Non-obvious design decisions: "The virtual thinking level is an input to the router. Its meaning is up to the router; it need not correspond to a reasoning budget." (`:16`); "Returning `previous` for `continuation` and `failed` for `retry` keeps prompt caches and thinking signatures valid. Switching models between turns is allowed but loses the prompt cache." (`:84`); router `state` "follows the session tree, so forks and `/tree` navigation see the state of their branch. It survives compaction." (`:107`).
- Edge cases / failure handling: "If `route()` throws, or returns a virtual model or a model without credentials, the request ends with an error response." (`:86`); "a virtual model cannot route to another virtual model" (`:65`); `direct` requests (compaction summaries, extension `streamSimple`) have no state and Pi ignores state they return (`:108`).
- Surprising: "If the virtual model is no longer registered, Pi falls back to the physical model that answered last." (`:25`) — a session survives the disappearance of its router.

### packages/coding-agent/docs/custom-provider.md
- Purpose: How to add a provider extension, and the exact contract a custom `streamSimple` must honour.
- Key abstractions: complete `Provider` vs legacy `ProviderConfig`; `refreshModels` (two different refresh contracts, `:155-160`); `SimpleStreamOptions` with `onPayload` / `onResponse` / `onProviderStreamEvent`.
- Data flow: extension factory → `pi.registerProvider()` → Pi waits for the async factory → models appear in startup selection and `pi --list-models`.
- Non-obvious design decisions: "Registering only `baseUrl` or `headers` for an existing provider preserves its built-in models. … Do not copy the built-in model list into the extension because doing so turns a small endpoint override into a catalog replacement that can drift." (`:49`); "This is safer than copying a stream implementation because it preserves Pi's message conversion, tool handling, usage accounting, cancellation, and compatibility behavior." (`:170`).
- Edge cases / failure handling: the six-step custom-stream contract (`:178-186`) — one assistant message with a pending stop reason and zeroed usage, exactly one `start` before content, balanced text/thinking/tool-call events, "exactly one terminal `done` or `error` event", cancellation → aborted result; "Request setup can fail before `start`; in that case the stream can terminate directly with `error`." (`:187`).
- Surprising: "Pi can compact and retry after recognized context-overflow errors. If the service uses an unknown message, normalize only that provider's overflow response to `context_length_exceeded` in a guarded `message_end` handler. Do not rewrite rate limits or transient provider failures as context overflow." (`:204-206`) — per-provider overflow normalisation must be surgical.

### packages/coding-agent/docs/tui.md
- Purpose: The terminal component system — integration points, width handling, focus/IME, mouse, overlays, theming, performance.
- Key abstractions: `ctx.ui` methods vs custom components; `Component` (render/invalidate/handleInput); `Focusable` + `CURSOR_MARKER` + `renderFakeCursor()`; `OverlayHandle` with `setHidden()`.
- Data flow: state change → `invalidate()` → `tui.requestRender()` → the TUI coalesces render requests and updates the terminal.
- Non-obvious design decisions: "Every rendered line must fit within the supplied width. Measure visible terminal columns rather than string length because ANSI escapes, wide characters, emoji, and combining characters change display width." (`:24`); "**Containers that wrap an `Input` or `Editor` must propagate their `focused` state to that child. Without propagation, Chinese, Japanese, Korean, and other IME candidate windows can appear at the wrong screen position.**" (`:50`); "Do not permanently store strings with theme colors unless `invalidate()` rebuilds them. A theme change clears render caches, but it cannot remove old ANSI colors embedded in application state." (`:170`).
- Edge cases / failure handling: "Focused overlays retain input ownership across ordinary renders. If another component should receive input while an overlay remains visible, explicitly release or redirect focus through the handle." (`:140`); "Do not call `OverlayHandle.hide()` on an overlay created by `ctx.ui.custom()`." (`:144`).
- Surprising: "Do not create a second terminal renderer inside an extension." (`:18`) and the theme token rule that a token used in the wrong position must be passed as its *concrete* colour (`:166`).

### packages/coding-agent/docs/message-types.md
- Purpose: The shared `AgentMessage` union and every content block — the value contract used by SDK, events, RPC and the session file.
- Key abstractions: `TextContent`, `ImageContent`, `ThinkingContent`, `ToolCall`, `Usage`, `SystemMessage`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `BashExecutionMessage`, `CustomMessage`, `BranchSummaryMessage`, `CompactionSummaryMessage`.
- Data flow: providers → `packages/ai` types → `packages/agent` extensible union → coding-agent's four extra roles → persisted in the session and projected to LLM messages.
- Non-obvious design decisions: `SystemMessage` carries `sections?: Record<string, string | null>` plus `toolsAdded`/`toolsRemoved` — "Replaying them in order yields the current state." (`:107`); `AssistantMessage.stopReason` is `"pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"` (`:134`); "Pi does not persist `"pending"` assistant messages in session JSONL." (`:145`).
- Edge cases / failure handling: "When present, `reasoning` is already included in `output`; do not add it again." (`:90`); `nestedCalls` records "name, arguments, status, duration, error; never results" with `complete: false` marking a lossy record (`:179-194`).
- Surprising: `Usage.cacheWrite1h` is the *subset* of `cacheWrite` written with one-hour retention (`:90`); and `BashExecutionMessage` is a first-class role that "is not an LLM tool result" and is converted to a user message for the next request (`:202`, `:218`).

### packages/coding-agent/docs/sessions.md
- Purpose: The user-facing session workflow — continue, branch, compact, export, share.
- Key abstractions: `/tree` (within the file), `/fork` (new session from an earlier user message), `/clone` (copy the active branch).
- Data flow: "The model receives the active branch, not every branch in the session file."
- Non-obvious design decisions: the branch table maps *intent* to a mechanism — "Related alternatives should stay together" → `/tree`; "The alternative should become separate work" → `/fork` (`:24-28`).
- Edge cases / failure handling: "Compaction can fail if the provider is unavailable or cannot accept the summarization request. Correct the provider problem and run `/compact` again. Disabling automatic compaction does not disable the manual command." (`:44`).
- Surprising: "Review exported or shared sessions first. They can contain prompts, model responses, tool arguments, command output, file contents, and extension messages." (`:60`).

### packages/coding-agent/docs/skills.md
- Purpose: The skill mechanism — on-demand instructions with supporting files.
- Key abstractions: a directory with `SKILL.md` + frontmatter (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`, `disable-model-invocation`).
- Data flow: at startup only the skill's *name, description and path* go into the system prompt; the model reads `SKILL.md` when the task matches.
- Non-obvious design decisions: "**The description determines when the model considers loading the skill.** State both what the skill does and when it applies. Avoid descriptions such as 'Helps with PDFs,' which do not provide enough routing information." (`:37`); "A model might fail to load a relevant skill, so use `/skill:name` when you need to force it." (`:45`).
- Edge cases / failure handling: "Malformed `SKILL.md` files and declared skills without descriptions are not loaded. Name collisions keep the first discovered skill and produce a warning." (`:85`).
- Surprising: "Pi neither requires nor warns when the declared name differs from the parent directory. Other Agent Skills implementations may enforce that requirement, so matching names remain the portable choice." (`:83`).

### packages/coding-agent/docs/prompt-templates.md
- Purpose: Markdown files turned into `/` commands.
- Key abstractions: frontmatter `description` + `argument-hint`; substitutions `$1`, `$@`/`$ARGUMENTS`, `${1:-default}`, `${@:-default}`, `${@:N}`, `${@:N:L}`.
- Data flow: "Pi expands the template before the resulting text enters the agent. Extensions receive the raw input first through the `input` event unless an extension command with the same name handles it." (`:36`).
- Non-obvious design decisions: "Conventional prompt directories load direct `.md` children only." (`:55`) — nested templates need explicit settings/package paths.
- Edge cases / failure handling: "Arguments follow shell-like quoting, so `/review "API compatibility"` supplies one argument containing a space." (`:49`).
- Surprising: if `description` is omitted Pi uses the first non-empty line of the file (`:19`).

### packages/coding-agent/docs/packages.md
- Purpose: Distributing extensions/skills/prompts/themes as one unit via npm, git or a local path.
- Key abstractions: the `pi` manifest key in `package.json`; resource filters (`!pattern`, `+path`, `-path`); package identity rules.
- Data flow: `pi install` writes a declaration into `~/.pi/agent/settings.json` (or `.pi/settings.json` with `--local`); project packages load only after trust.
- Non-obvious design decisions: **"Do not list host-provided packages in `dependencies`. A physical copy can bypass Pi's extension module mapping in compiled ESM and create duplicate classes, registries, and initialization work. Pi reports an extension warning when it detects this manifest configuration."** (`:90`); "Installed packages load with separate module roots. Do not rely on two packages sharing one dependency instance." (`:92`).
- Edge cases / failure handling: "Pi identifies npm packages by package name, git packages by repository URL without the ref, and local packages by resolved absolute path. This prevents the same package from loading twice through equivalent declarations." (`:127`); "Filters narrow the package manifest. They do not expose resources that the package itself did not declare." (`:119`).
- Surprising: `autoload: false` turns a project entry into a *filtering delta* over the personal package rather than a replacement (`:125`).

### packages/coding-agent/docs/cli-integration.md
- Purpose: Choosing between interactive, print, JSON and RPC; the mode table; forking/rebranding Pi.
- Key abstractions: the four modes and their lifetimes; `piConfig.name` / `piConfig.configDir` for a rebrand.
- Data flow: "All four modes use the same agent, sessions, resources, and tools. The mode determines how input enters Pi, how output is exposed, and whether the process remains available for more commands." (`:5`).
- Non-obvious design decisions: print mode's exit-code contract — "A final assistant response with an `error` or `aborted` stop reason produces a nonzero exit status. A response cut off at the model's output token limit (`length` stop reason) still prints its partial text to stdout, writes a warning to stderr, and produces a nonzero exit status." (`:30`).
- Edge cases / failure handling: "A failed or aborted assistant response appears in the event stream but does not by itself produce a nonzero exit status." (`:46`) — JSON mode and print mode disagree on this, deliberately, and the doc says so.
- Surprising: "The SDK is not a CLI mode. It embeds the agent directly in a Node.js or Bun process." (`:7`).

### packages/coding-agent/docs/environment-variables.md
- Purpose: The three uses of environment variables — process configuration, child-process markers, and the shell tool session environment.
- Key abstractions: `AI_AGENT=pi` / `PI_CODING_AGENT=true` markers; `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`; `PI_CODEMODE_MAX_WORKERS`, `PI_TUI_ESC_TIMEOUT`, `PI_IMAGE_PROTOCOL`, `PI_HYPERLINKS`, `PI_TRUE_COLOR`, `PI_PROGRAM_STATUS`.
- Data flow: the shell tools receive the session environment; "The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting Pi." (`:32`).
- Non-obvious design decisions: "These variables are injected into the LLM-callable `bash` and `powershell` tools. They are not injected into user-entered `!` or `!!` commands." (`:49`); `exposeSessionEnvironment: false` "removes inherited values for these variables so nested Pi processes do not expose stale parent-session metadata" (`:73`).
- Edge cases / failure handling: `PI_TUI_ESC_TIMEOUT` defaults to 100 ms over SSH and 10 ms otherwise (`:97`).
- Surprising: the guidance "When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt" (`:34`) — a ground-truth channel for the model rather than a prompt claim.

### packages/coding-agent/docs/providers.md
- Purpose: Provider authentication — OAuth/API keys, the env-var table, per-provider configuration.
- Key abstractions: `/login` and `/logout`; `auth.json` entries (`type: "api_key"`, `key`, `env`); `!command` keys.
- Data flow: `/login` → credential stored in `auth.json`; or an env var; or a `!command` whose stdout is cached "for the process lifetime" (`:84`).
- Non-obvious design decisions: "A stored API-key credential can include an `env` object. Its values take priority over the process environment for that provider." (`:90`); OpenRouter's list is filtered by the key's own `/models/user` endpoint and "the last list is saved and used offline and in `pi -p` and RPC mode" (`:122`).
- Edge cases / failure handling: "Empty output, a timeout, or a nonzero exit leaves the key unresolved until Pi restarts." (`:84`).
- Surprising: OpenAI's Decisions API "Sign in with ChatGPT credentials do not work with it, so `gpt-6-luna` is not listed as available while `openai` is logged in through `/login`, even when `OPENAI_API_KEY` is set" (`:157` in models.md) — a credential-precedence trap documented in the provider page.

### packages/coding-agent/docs/keybindings.md
- Purpose: Every named action and its default key, and the `keybindings.json` override format.
- Key abstractions: `tui.*` (editor, input, select, altScreen) and `app.*` (interrupt, clear, exit, suspend, session, model, thinking, display, queue, tree) action ids.
- Data flow: `keybindings.json` maps action → key or key list; `/reload` applies it; an empty list disables an action.
- Non-obvious design decisions: per-platform defaults are baked into the reference (`ctrl+z` suspend is None on native Windows; `alt+enter` follow-up becomes `ctrl+q` on Windows/WSL) and "On native Windows, `app.suspend` has no default because Windows terminals do not support Unix job control. If you assign it manually, Pi shows a status message instead of suspending." (`:131`).
- Edge cases / failure handling: "The dedicated history actions browse prompt history regardless of cursor position and take precedence over application actions using the same key." (`:68`).
- Surprising: `super` bindings "require a terminal that reports the modifier separately, typically through the Kitty keyboard protocol" (`:43`).

### packages/coding-agent/docs/terminal-setup.md
- Purpose: Per-terminal configuration for modified keys, scrolling, links, images, colors and IME.
- Key abstractions: the Kitty keyboard protocol and CSI-u; OSC 8 hyperlinks, OSC 9;4 progress, OSC 7501 program status.
- Data flow: Pi detects capabilities at startup, or the user overrides via `PI_HYPERLINKS` / `PI_IMAGE_PROTOCOL` / `PI_TRUE_COLOR` or the equivalent settings.
- Non-obvious design decisions: "Settings take precedence over environment variables." (`:217`); "Only force a capability supported by the complete terminal path. Unsupported escape sequences can corrupt rendering." (`:219`); the Apple Terminal fallback "works only when Pi runs on the same Mac as Terminal.app" (`:45`).
- Edge cases / failure handling: the Ghostty warning — an old `shift+enter=text:\n` mapping "sends a raw linefeed, which Pi cannot distinguish from `Ctrl+J`" (`:63`).
- Surprising: **OSC 7501 Program Status** — Pi reports `working` / `blocked` / `done` / `error` / `idle`, and "Reports never contain prompts or model output." (`:223-233`): a machine-readable state channel that leaks nothing.

### packages/coding-agent/docs/themes.md
- Purpose: The theme format and the `system` theme that derives from the terminal.
- Key abstractions: `name`, `appearance`, `vars`, `colors`, `export`; six colour notations (hex, OKLCH, OKHSL, 256-index, var reference, terminal default).
- Data flow: Pi queries the terminal for its default fg/bg and 16 ANSI colours, waits at most 100 ms for the answer, then builds a theme that stands out from the actual background with a 4.5:1 WCAG contrast floor for body text.
- Non-obvious design decisions: "Theme objects are strict: only documented top-level fields and color tokens are accepted." (`:81`); "`system` is a reserved name: a custom theme with that name is ignored." (`:22`); "Pi hot-reloads the active user theme only from `<agent-dir>/themes/<name>.json`." (`:68`).
- Edge cases / failure handling: "Pi resolves chained variable references. A missing variable or circular reference makes the theme invalid." (`:96`).
- Surprising: OKHSL saturation is gamut-relative, "so every value is in gamut and equal saturation looks equally colorful" (`:89`).

### packages/coding-agent/docs/docs.json
- Purpose: The docs site navigation and redirect table — Get Started / Guides / Build on Pi / Reference.
- Key abstractions: three navigation groups with nested sections; four redirects (`development.md`→`index.md`, `session.md`→`session-format.md`, `tree.md`→`sessions.md`, `process-integration.md`→`cli-integration.md`).
- Data flow: n/a (site config).
- Non-obvious design decisions: the "Build on Pi" group contains exactly the five extensibility surfaces a power user needs (extensions, custom providers, virtual models, TUI components, CLI integration).
- Edge cases / failure handling: n/a.
- Surprising: `models-configuration.md` and `codemode.md` sit under *Reference*, not *Guides* — the generated field table and the script sandbox are treated as lookup material.

### packages/coding-agent/docs/rpc-extension-ui.md
- Purpose: The extension-UI subprotocol — which `ctx.ui` methods survive outside the TUI, and the request/response record shapes.
- Key abstractions: dialog methods (`select`, `confirm`, `input`, `editor`) that block; fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`); `extension_ui_request` / `extension_ui_response`.
- Data flow: Pi emits `extension_ui_request` on stdout; the client answers `extension_ui_response` with the matching id.
- Non-obvious design decisions: "If a dialog method includes a `timeout` field, the agent-side will auto-resolve with a default value when the timeout expires. The client does not need to track timeouts." (`:10`); "**`ctx.mode` is `"rpc"` and `ctx.hasUI` is `true` in RPC mode because the dialog and fire-and-forget methods are functional via the extension UI sub-protocol. Use `ctx.mode === "tui"` to guard TUI-specific features like `custom()`**" (`:25`).
- Edge cases / failure handling: the degraded list is explicit — `custom()` returns `undefined`, `getEditorText()` returns `""`, `setTheme()` returns `{success:false,error:"Theme switching not supported in RPC mode"}` (`:14-24`).
- Surprising: extension UI records are a separate record family, "not `AgentSessionEvent` values" (`docs/json.md:196`), and they are the only bidirectional records in the protocol.

### packages/coding-agent/docs/llama-cpp.md
- Purpose: Running local GGUF models through the llama.cpp router, plus the "chat model as classifier" trick.
- Key abstractions: router mode (`llama-server` without `--model`), `/llama` model management, the `llama-cpp-classify` API.
- Data flow: Pi connects to the router; `/llama` loads/unloads models; `/model` selects a loaded or sleeping model.
- Non-obvious design decisions: the classifier-by-next-token technique — "Each question becomes one chat prompt: the state, every question of the request, the state again, and then the question with its answers under single-token labels… The second copy of the state is read with the questions in view, which improved accuracy on JevBench with small models." (`:100`); "The state appears twice, so it needs twice its size in context." (`:103`).
- Edge cases / failure handling: "Small models may follow instructions written inside the state. The prompt tells the model to judge the state as data, but that is not a guarantee." (`:104`); hybrid models need `--ctx-checkpoints 32 --checkpoint-min-step 0` because "they cannot rewind a partially cached prompt" (`:105`).
- Surprising: `temperature` in a classifier request "divides the label logits before normalizing… It changes no answer" (`:102`).

### packages/coding-agent/docs/nvidia-rtx-llama-cpp.md
- Purpose: Converting an NVIDIA single-model llama.cpp recipe into a router preset.
- Key abstractions: preset sections (section name = model ID), `load-on-startup`, `hf-repo`/`hf-file`/`spec-draft-model` key mapping.
- Data flow: recipe CLI flags → `.ini` preset → `llama-server --models-preset`.
- Non-obvious design decisions: "Leave out `--host` and `--port`. They belong on the router command line." (`:23`); the build must advertise `--models-preset` or the recipe cannot be loaded (`:11`).
- Edge cases / failure handling: "NVIDIA recipe memory settings assume that only the selected model uses the GPU. If `/llama` shows other loaded models, unload them before using the recipe model." (`:96`).
- Surprising: on Windows PowerShell, `curl` maps to a different command — the doc says use `curl.exe` (`:90`).

### packages/coding-agent/docs/containerization.md
- Purpose: Four isolation methods and what each one actually protects.
- Key abstractions: plain Docker, Docker Sandboxes, OpenShell, Gondolin tool-only isolation.
- Data flow: whole-process isolation vs tool-only delegation.
- Non-obvious design decisions: the honest scope statement — "The method changes where extensions run. When the complete Pi process runs inside an isolated environment, its extensions run there too. When host Pi delegates built-in tools through Gondolin, other extension tools still run on the host unless they also delegate their work." (`:16`); Docker Sandboxes keep the real provider key on the host and substitute it at the proxy (`:84`).
- Edge cases / failure handling: "Do not mount the host's `~/.pi/agent` unless the container should have access to your host Pi configuration and credentials." (`:70`); "Do not run `/login` inside the sandbox because that writes a real credential into it." (`:86`).
- Surprising: the Gondolin warning — "Commands inside the VM inherit the host process environment. Provider keys supplied through environment variables can therefore be visible inside the VM. Do not use this pattern as a credential boundary…" (`:157`).

### packages/coding-agent/docs/shell-aliases.md
- Purpose: Which shell Pi uses, and how to get aliases into non-interactive Bash.
- Key abstractions: `shellPath`, `shellCommandPrefix`; the Bash resolution order.
- Data flow: "Pi normally invokes Bash with `bash -c`. On Unix systems, it uses `/bin/bash`, then `bash` on `PATH`, and finally `sh` when Bash is unavailable." (`:16`).
- Non-obvious design decisions: "Pi joins the prefix and requested command with a newline. The prefix runs again for every command, so keep it fast and free of interactive prompts." (`:48`); "Aliases must use Bash-compatible syntax. Do not source an arbitrary `.zshrc` into Bash" (`:77`).
- Edge cases / failure handling: "An extension that replaces the `bash` tool or provides its own shell operations controls its own setup" — `shellCommandPrefix` does not reach it (`:83`).
- Surprising: the alias recipe is `shellCommandPrefix: "shopt -s expand_aliases\nsource ~/.bash_aliases"` (`:65`) — a literal newline inside a JSON string.

### packages/coding-agent/docs/tmux.md
- Purpose: Making tmux report `Shift+Enter` / `Alt+Enter` distinctly.
- Key abstractions: `extended-keys on`, `extended-keys-format csi-u` (tmux ≥3.5) vs the older `modifyOtherKeys` path.
- Data flow: terminal → tmux → Pi; each hop can discard the modifier.
- Non-obvious design decisions: "Pi requests extended-key reporting when the terminal does not provide the Kitty keyboard protocol directly. CSI-u is the most reliable format for forwarding modified keys through tmux." (`:22`).
- Edge cases / failure handling: "The configuration applies to the tmux server. To guarantee that it is active, close your tmux sessions and start a new server." (`:26`).
- Surprising: for tmux 3.2–3.4, Pi falls back to the xterm `modifyOtherKeys` format (`:53`).

### packages/coding-agent/docs/windows.md
- Purpose: Native Windows vs WSL, shell resolution and the optional `powershell` tool.
- Key abstractions: the four-step Bash resolution order; `powershell` tool discovery order.
- Data flow: "When using the legacy WSL `bash.exe` launcher from Windows, Pi sends commands over stdin to avoid command-line quoting problems." (`:63`).
- Non-obvious design decisions: the `powershell` tool runs with `-NoProfile -NonInteractive -ExecutionPolicy Bypass` (`:36`); `["-bash", "+powershell"]` swaps the model-facing tool while "`!` and `!!` editor commands continue to use Bash" (`:55`).
- Edge cases / failure handling: "The `powershell` tool is available only when Pi runs as a native Windows process." (`:55`).
- Surprising: WSL path conversion "recognize `/mnt/<drive>`, not custom mount roots" (`:61`).

### packages/coding-agent/docs/termux.md
- Purpose: Running Pi on Android via Termux.
- Key abstractions: `termux-setup-storage`, `termux-clipboard-set/get`, Termux:API.
- Data flow: Pi detects Termux but cannot infer intent, so the user documents the environment in `~/.pi/agent/AGENTS.md`.
- Non-obvious design decisions: the doc shows the exact `AGENTS.md` block to write for an Android environment (`:81-89`).
- Edge cases / failure handling: "The Termux clipboard API supports text only. Pi's clipboard-paste shortcut inserts that text into the editor but cannot attach clipboard images." (`:75`).
- Surprising: clipboard integration needs *two* installs — the Termux:API Android app and the `termux-api` CLI package — and both must be verified outside Pi first (`:95-102`).

### packages/coding-agent/docs/usage.md
- Purpose: The interactive-mode walkthrough.
- Key abstractions: Enter vs Alt+Enter (steer vs follow-up), `!` vs `!!`, `/tree` `/fork` `/clone` `/compact`.
- Data flow: "A message sent with `Enter` waits until the current response and its tool calls finish, then guides the next response. A follow-up sent with `Alt+Enter` waits until Pi finishes the current task." (`:40`).
- Non-obvious design decisions: "Aborting returns queued messages to the editor." (`:40`).
- Edge cases / failure handling: "Windows Terminal reserves some Alt shortcuts." (`:42`).
- Surprising: `/debug` writes the rendered terminal lines *and* the current session messages to `pi-debug.log` — and the doc warns to review it before sharing because it can contain prompts, tool output, file contents and terminal data (`:92-94`).

### packages/coding-agent/docs/slash-commands.md
- Purpose: The built-in `/` command list.
- Key abstractions: four groups (models/settings, sessions/context, export/share, runtime/project).
- Data flow: n/a.
- Non-obvious design decisions: "Extensions, prompt templates, and skills can add commands. The command menu in Pi is therefore the exact reference for the resources loaded in your session." (`:5`).
- Edge cases / failure handling: skills appear as `/skill:name` only when `enableSkillCommands` is on, but "manually entered `/skill:name` commands still work" (`docs/skills.md:53`).
- Surprising: `/import <path>` imports and resumes a JSONL session (`:31`) — sessions are a portable interchange format.

### packages/coding-agent/docs/images/interactive-mode.png
- Purpose: Screenshot of the interactive TUI (1500×1736 PNG), referenced from `quickstart.md:48` and `usage.md:7`.
- Key abstractions: n/a (asset).
- Data flow: n/a.
- Non-obvious design decisions: the image itself documents the startup header layout — a `[Context]` / `[Skills]` / `[Prompts]` / `[Extensions]` / `[Themes]` resource listing — and the footer format `↑14k ↓206 R1.4k CH10.3% $0.076 (sub) 9.7%/272k (auto) (openai-codex) gpt-5.6-sol • high`.
- Edge cases / failure handling: n/a.
- Surprising: the footer shows *both* a cache-hit percentage and a context percentage, and the model identity is shown as `provider · model · thinking-level`.
- Status: **skipped as a line-by-line read** — binary PNG; I opened it with the image reader to confirm content (see the ledger note).

### packages/coding-agent/docs/images/tree-view.png
- Purpose: Screenshot of the session tree / branch view (1720×1116 PNG).
- Key abstractions: n/a (asset).
- Data flow: n/a.
- Non-obvious design decisions: the image shows the transcript with `user:` / `assistant:` / `[bash: ...]` / `[read: ...]` lines and an `(aborted)` assistant turn, i.e. the tree view renders a flattened branch with per-tool-call rows.
- Edge cases / failure handling: n/a.
- Surprising: an aborted assistant turn is rendered as the literal text `(aborted)`.
- Status: **skipped as a line-by-line read** — binary PNG; opened as an image to confirm content.

### packages/coding-agent/docs/images/exy.png
- Purpose: A 1025×847 PNG asset in `docs/images/` that no doc page in this shard references — it appears to be a standalone illustration.
- Key abstractions: n/a (asset).
- Data flow: n/a.
- Non-obvious design decisions: the image is an antique engraved woodcut of a spiny pufferfish (a "porcupinefish"), on a transparent background.
- Edge cases / failure handling: n/a.
- Surprising: the name `exy.png` matches nothing in the docs prose; the file is orphaned in this shard.
- Status: **skipped as a line-by-line read** — binary PNG; opened as an image to confirm content.

### packages/coding-agent/docs/images/doom-extension.png
- Purpose: Screenshot of the DOOM overlay extension running inside Pi (1600×1442 PNG), referenced from the extension docs.
- Key abstractions: n/a (asset).
- Data flow: n/a.
- Non-obvious design decisions: the image shows the overlay *composited over the live Pi transcript* — the model answer "i asked you to do some read-only busy work for 10 turns!" is visible above the game, and the Pi status footer (`↑4.7k ↓132 R4.0k $0.011 (sub) 1.7%/272k (auto) (openai-codex) gpt-5.2-codex • medium`) is visible *below* it, proving the overlay floats over the transcript without replacing the session chrome.
- Edge cases / failure handling: n/a.
- Surprising: the overlay renders the game at 640×400 through half-block characters at 24-bit colour while the agent keeps working underneath.
- Status: **skipped as a line-by-line read** — binary PNG; opened as an image to confirm content.

### packages/coding-agent/examples/README.md
- Purpose: The examples index — one paragraph per directory.
- Key abstractions: `sdk/`, `extensions/`, plus two top-level RPC examples.
- Data flow: n/a.
- Non-obvious design decisions: "Build the coding-agent package before running it from a repository checkout" — the example points at `dist/cli.js` (`:9`).
- Edge cases / failure handling: n/a.
- Surprising: the examples are typechecked with the repository (`docs/sdk.md:22`) — they are compiled, not decorative.

### packages/coding-agent/examples/rpc-client.ts
- Purpose: A 35-line typed RPC client: start the child, stream text deltas, wait for settle, stop.
- Key abstractions: `RpcClient({cliPath, args})`, `client.onEvent`, `client.promptAndWait()`.
- Data flow: `client.start()` → `promptAndWait(prompt)` → `message_update`/`text_delta` to stdout, `tool_execution_start` to stderr → `client.stop()`.
- Non-obvious design decisions: the tool banner goes to **stderr** and only model text to stdout, keeping the two streams separable (`:23-25`).
- Edge cases / failure handling: `unsubscribe()` in a `finally` before `stop()` (`:32-35`).
- Surprising: the client is pointed at `../dist/cli.js`, so it needs a built package (`docs/rpc.md:132`).

### packages/coding-agent/examples/rpc-extension-ui.ts
- Purpose: A ~660-line custom terminal chat client that speaks RPC and *also* implements the extension-UI subprotocol (select/confirm/input/editor) — the reference for building a non-Pi front end.
- Key abstractions: `ExtensionUIRequest` mirror type; `OutputLog` component (1000-line ring buffer, renders the tail that fits); `LoadingIndicator`; `ProcessTerminal` + `TuiMainScreen` from `@earendil-works/pi-tui`.
- Data flow: spawn `pi --mode rpc`, read stdout with a `StringDecoder`, dispatch `extension_ui_request` to a modal prompt, write `extension_ui_response` back on stdin.
- Non-obvious design decisions: the client keeps the *whole* protocol knowledge itself rather than using `RpcClient`, because it needs the extension-UI half that `RpcClient` does not surface; the output log is a bounded ring buffer (`:84-86`) so a long run cannot grow without limit.
- Edge cases / failure handling: (partial read — I read the first 110 of 661 lines; the remainder is the RPC dispatch loop and the modal dialog implementations, which I did not read line by line).
- Surprising: Pi's own TUI component kit (`ProcessTerminal`, `TuiMainScreen`, `SelectList`, `Input`) is public and reusable — a third-party client gets the same widgets Pi does.

### packages/coding-agent/examples/sdk/README.md
- Purpose: The SDK example index, a quick-reference snippet and the `createAgentSession` option table.
- Key abstractions: the five substitutable services (`modelRuntime`, `settingsManager`, `sessionManager`, `resourceLoader`, tools).
- Data flow: n/a (documentation).
- Non-obvious design decisions: the option table names the *defaults* explicitly — `tools` defaults to `["read","bash","edit","write"]` built-ins, `sessionManager` to `SessionManager.create(cwd)`, `settingsManager` to `SettingsManager.create(cwd, agentDir)` (`:107-118`).
- Edge cases / failure handling: n/a.
- Surprising: the "Full control" snippet implements the whole `ResourceLoader` interface by hand — eleven methods — which is the cleanest statement of the resource boundary (`:77-84`).

### packages/coding-agent/examples/sdk/01-minimal.ts
- Purpose: The smallest possible SDK session — defaults only.
- Key abstractions: `createAgentSession()`, `session.subscribe()`, `session.prompt()`, `session.dispose()`.
- Data flow: create → subscribe to `message_update`/`text_delta` → prompt → dump `session.state.messages` → dispose.
- Non-obvious design decisions: the subscriber is installed *before* `prompt()` (`:13-17`).
- Edge cases / failure handling: `dispose()` in a `finally` (`:24-26`).
- Surprising: `session.state.messages` is a separate view from the persisted manager — the SDK's own doc says the manager is authoritative (`docs/sdk.md:40`).

### packages/coding-agent/examples/sdk/02-custom-model.ts
- Purpose: Three ways to pick a model, and how thinking level is set.
- Key abstractions: `ModelRuntime.getModel(provider, id)`, `modelRuntime.getAvailable()`.
- Data flow: build the runtime → look up or list models → create the session with `model` + `thinkingLevel`.
- Non-obvious design decisions: `getAvailable()` returns only models whose provider has *working* credentials, so it is the right list for a picker (`:24`).
- Edge cases / failure handling: the example guards the whole session behind `available.length > 0` (`:30`).
- Surprising: `getModel` also finds models that come from a user's `models.json` (`:18`), not just the built-in catalog.

### packages/coding-agent/examples/sdk/03-custom-prompt.ts
- Purpose: Replace the system prompt entirely, or append to it.
- Key abstractions: `DefaultResourceLoader({systemPromptOverride, appendSystemPromptOverride})`.
- Data flow: build a loader → `await loader.reload()` → pass it as `resourceLoader`.
- Non-obvious design decisions: **"Needed to avoid DefaultResourceLoader appending APPEND_SYSTEM.md from `~/.pi/agent` or `<cwd>/.pi`."** (`:23`) — a full replacement must also suppress the append layer or the prompt is not actually replaced.
- Edge cases / failure handling: the two loaders use `SessionManager.inMemory()` so the two demos do not share a transcript.
- Surprising: the append form takes an *array* of strings (`(base) => [...base, "## Additional Instructions…"]`), not a string (`:51-54`).

### packages/coding-agent/examples/sdk/04-skills.ts
- Purpose: Discover, filter and inject skills.
- Key abstractions: `skillsOverride(current) => {skills, diagnostics}`, `createSyntheticSourceInfo`, the `Skill` shape.
- Data flow: loader override → `loader.reload()` → `loader.getSkills()` → session.
- Non-obvious design decisions: the override receives the *current* discovery result and returns a modified one, so filtering and adding compose (`:30-36`).
- Edge cases / failure handling: `diagnostics` are preserved through the override and can be surfaced (`:46-48`).
- Surprising: a synthetic skill needs `filePath`, `baseDir` and a `sourceInfo` — the skill is a *file* concept even when it does not exist on disk.

### packages/coding-agent/examples/sdk/05-tools.ts
- Purpose: Tool allowlists and cwd binding.
- Key abstractions: `tools: string[]` across built-in, extension and custom tools.
- Data flow: `createAgentSession({tools, cwd, sessionManager})` → the factory applies the cwd when it builds the built-in tools.
- Non-obvious design decisions: "If you use a custom `cwd`, `createAgentSession()` applies that cwd when it builds the actual built-in tools." (`:6-7`) — the tool set and the working directory are one decision, not two.
- Edge cases / failure handling: `SessionManager.inMemory(customCwd)` must be given the same cwd as the session or the two disagree (`:36`).
- Surprising: custom tools are *not* registered through this option — they go through the extension system (`:9-11`).

### packages/coding-agent/examples/sdk/06-extensions.ts
- Purpose: Loading extensions from disk, from `additionalExtensionPaths` and as inline factories.
- Key abstractions: `extensionFactories: [(pi) => {...}]`, `additionalExtensionPaths`.
- Data flow: loader → `reload()` → session → `bindExtensions` (implicit) → events fire.
- Non-obvious design decisions: the inline factory is an anonymous arrow, so it has no stable name in diagnostics — "Give one an `InlineExtension` name only when it needs a stable name in diagnostics and startup output" (`docs/sdk.md:112`).
- Edge cases / failure handling: the file-extension example is commented out but shows the three canonical hooks (`agent_start`, `tool_call` with `{block:true, reason}`, `agent_end`) (`:59-98`).
- Surprising: `tool_call` returning `{block:true, reason}` is the *only* documented way to stop a tool, and it is a return value, not an exception.

### packages/coding-agent/examples/sdk/07-context-files.ts
- Purpose: AGENTS.md discovery and injection.
- Key abstractions: `agentsFilesOverride(current) => {agentsFiles}`.
- Data flow: override → `reload()` → `loader.getAgentsFiles()` → the files become system-prompt sections.
- Non-obvious design decisions: "Disable context files entirely by returning an empty list in `agentsFilesOverride`." (`:14`) — an empty list is a valid, meaningful answer, not a no-op.
- Edge cases / failure handling: the injected synthetic file has a `/virtual/AGENTS.md` path so the source is still traceable.
- Surprising: the same override mechanism both *adds* and *removes* context files, which is how a host can pin a trusted prompt set.

### packages/coding-agent/examples/sdk/08-prompt-templates.ts
- Purpose: Adding file-style prompt templates programmatically.
- Key abstractions: `promptsOverride(current) => {prompts, diagnostics}`, the `PromptTemplate` shape (`name`, `description`, `filePath`, `sourceInfo`, `content`).
- Data flow: same as skills — override → reload → the template becomes a `/name` command.
- Non-obvious design decisions: the template carries its own `content` string, so a synthetic template needs no file (`:17-27`).
- Edge cases / failure handling: `diagnostics` again preserved through the override.
- Surprising: `createSyntheticSourceInfo(path, {source: "sdk"})` is the same helper used for synthetic skills — a consistent "where did this resource come from" story.

### packages/coding-agent/examples/sdk/09-api-keys-and-oauth.ts
- Purpose: Three credential configurations for a session.
- Key abstractions: `ModelRuntime.create({authPath, modelsPath})`, `modelRuntime.setRuntimeApiKey(provider, key)`.
- Data flow: runtime → session; a runtime key overrides the file-based credential for that provider.
- Non-obvious design decisions: the runtime key is set *after* the runtime is created and is per-provider (`:28`).
- Edge cases / failure handling: all three sessions use `SessionManager.inMemory()` so credential experiments leave no session files.
- Surprising: auth and models live in two separate files and can be pointed at different directories (`:17-20`).

### packages/coding-agent/examples/sdk/10-settings.ts
- Purpose: Settings overrides, durability boundaries and error surfacing.
- Key abstractions: `SettingsManager.create(cwd)`, `applyOverrides(obj)`, `setDefaultThinkingLevel`, `flush()`, `drainErrors()`, `SettingsManager.inMemory(overrides)`.
- Data flow: create → override → session; later setters update memory immediately and queue persistence writes.
- Non-obvious design decisions: "**Setters update memory immediately and queue persistence writes. Call `flush()` when you need a durability boundary.**" (`:29-32`) and "**Surface settings I/O errors at the app layer.**" via `drainErrors()` (`:34-40`).
- Edge cases / failure handling: `drainErrors()` returns `{scope, error}` pairs so the app can report which scope failed to persist.
- Surprising: `SettingsManager.inMemory({...})` takes the same override shape as `applyOverrides`, so a test can pin `compaction.enabled` and `retry.enabled` without touching disk (`:43-46`).

### packages/coding-agent/examples/sdk/11-sessions.ts
- Purpose: Every way to obtain a session: in-memory, new, continued, listed, opened.
- Key abstractions: `SessionManager.inMemory()`, `.create(cwd)`, `.continueRecent(cwd)`, `.list(cwd)`, `.open(path)`.
- Data flow: each factory produces a `SessionManager` that `createAgentSession` consumes.
- Non-obvious design decisions: `continueRecent` returns a **`modelFallbackMessage`** alongside the session — "if a recorded model is no longer available, here is the message" (`:24-27`).
- Edge cases / failure handling: `SessionManager.list(cwd, customDir)` mirrors the custom-directory variant (`:52`).
- Surprising: the custom session directory is separate from the cwd-encoded default layout, so sessions can live outside the `sessions/--<path>--/` scheme (`:47-52`).

### packages/coding-agent/examples/sdk/12-full-control.ts
- Purpose: Replace every service — no discovery at all.
- Key abstractions: a hand-written `ResourceLoader` object with eleven methods; `createExtensionRuntime()`.
- Data flow: explicit model runtime + settings + loader + tools + in-memory session → one fully-specified agent.
- Non-obvious design decisions: `getSystemPromptSource: () => undefined` and `getAppendSystemPromptSources: () => []` are how you assert "this prompt is not from a file" (`:44-46`).
- Edge cases / failure handling: `getModel("anthropic","claude-sonnet-4-5")` returning undefined is treated as fatal (`if (!model) throw`) (`:26`).
- Surprising: the resource loader interface is small and stable enough to implement in 12 lines — a good sign for embedders.

### packages/coding-agent/examples/sdk/13-session-runtime.ts
- Purpose: Replacing the active session (new / resume / fork / import) and rebinding subscriptions afterwards.
- Key abstractions: `createAgentSessionRuntime(factory, {cwd, agentDir, sessionManager})`, `createAgentSessionServices`, `createAgentSessionFromServices`.
- Data flow: runtime → `newSession()` → the runtime swaps the session → the host re-binds.
- Non-obvious design decisions: the `bindSession()` helper is the whole point — "after the runtime replaces the active session, rebind any session-local subscriptions and extension bindings to `runtime.session`" (`:7-9`); it also calls `session.bindExtensions({})` every time (`:43`).
- Edge cases / failure handling: the previous subscription is unsubscribed before a new one is installed (`:41`), so a long-lived host does not accumulate listeners.
- Surprising: `session.subscribe` for `queue_update` exposes `event.steering.length + event.followUp.length` — the host can display the queue depth without touching the session manager.

### packages/coding-agent/examples/sdk/14-codemode-mcp.ts
- Purpose: Adding the `codemode`, `tool_search` and MCP built-ins to an SDK session.
- Key abstractions: `createCodemodeExtension({mode:"on"})`, `createToolSearchExtension()`, `createMcpExtension()`; `settingsManager.applyOverrides({defaultTools:["+codemode","+tool_search"]})`.
- Data flow: factories → loader.reload() → settings override → session → `session.bindExtensions({})` (which emits `session_start` and connects MCP servers in the background).
- Non-obvious design decisions: the `+name` delta syntax is used deliberately — "`tools` would also restrict the session to the named tools, which hides MCP tools" (`:8-10`).
- Edge cases / failure handling: "Emits session_start, which connects the MCP servers in the background" — the `bindExtensions` call is mandatory, not optional (`:49-50`).
- Surprising: `codemode` and `tool_search` are *registered inactive* and only become active through the `defaultTools` setting or automatically when a matching MCP server connects.

### packages/coding-agent/examples/extensions/README.md
- Purpose: The 214-line catalogue of every extension example, grouped by intent, plus the two "key patterns" the README teaches.
- Key abstractions: the example taxonomy (lifecycle & safety, custom tools, commands & UI, git, system prompt & compaction, resources, messages, session metadata, custom providers, external dependencies).
- Data flow: n/a (catalogue), but it is the index the docs point at as "the implementation reference".
- Non-obvious design decisions: **"Use StringEnum for string parameters (required for Google API compatibility)"** — `StringEnum(["list","add"])` instead of `Type.Union([Type.Literal(...)])` (`:186-195`); and the state pattern: "Store state in tool result details for proper forking support" then "Reconstruct on session events" by scanning `ctx.sessionManager.getBranch()` (`:197-213`).
- Edge cases / failure handling: the reconstruction snippet only reads entries where `entry.type === "message" && entry.message.toolName === "my_tool"` (`:208`).
- Surprising: the README points at `dynamic-tools.ts` for "tool-specific prompt guidelines" — a tool can carry `promptSnippet` and `promptGuidelines` that are injected into the system prompt only when that tool is declared.

### packages/coding-agent/examples/extensions/hello.ts
- Purpose: The 26-line minimal custom tool.
- Key abstractions: `defineTool({name, label, description, parameters, execute})` → `pi.registerTool(tool)`.
- Data flow: model calls `hello` → `execute` returns `{content:[{type:"text",text:…}], details:{greeted:name}}`.
- Non-obvious design decisions: `defineTool` gives the tool a typed `execute` signature without a manual `Tool` generic (`:8`).
- Edge cases / failure handling: n/a.
- Surprising: the result carries a `details` object even though the model does not need it — `details` is the structured, renderable/persistable half of a tool result.

### packages/coding-agent/examples/extensions/todo.ts
- Purpose: A todo tool plus a `/todos` command, demonstrating **branch-aware state stored in tool-result details**.
- Key abstractions: `TodoDetails {action, todos, nextId, error?}`; the `TodoListComponent` TUI component with width-keyed line caching.
- Data flow: `session_start` / `session_tree` → `reconstructState(ctx)` scans `ctx.sessionManager.getBranch()` for `toolResult` messages with `toolName === "todo"` and takes the LAST one's `details` → in-memory state; each tool action returns the full new list in `details`.
- Non-obvious design decisions: the state is reconstructed from the *branch*, not from every file entry, "because abandoned branches represent alternative histories" (`docs/extensions.md:349`); the component caches rendered lines keyed by width and invalidates on state change (`:59-102`).
- Edge cases / failure handling: the tool returns an error *string* in `details.error` and renders it in red rather than throwing (`:235-237`); missing `text`/`id` produce specific error details, not exceptions.
- Surprising: the model-visible `content` and the persisted `details` are different renderings of the same state — the model gets `[x] #1: text` lines, the TUI gets a styled list.

### packages/coding-agent/examples/extensions/permission-gate.ts
- Purpose: A 34-line safety gate: confirm before `rm -rf`, `sudo`, `chmod/chown 777`.
- Key abstractions: the `tool_call` hook; `{block:true, reason}` as the refusal shape.
- Data flow: `tool_call` → regex test on `event.input.command` → `ctx.ui.select` → block or continue.
- Non-obvious design decisions: **fail-closed without a UI** — "if (!ctx.hasUI) return {block:true, reason:'Dangerous command blocked (no UI for confirmation)'}" (`:20-23`).
- Edge cases / failure handling: the handler returns `undefined` for every non-`bash` tool and for safe commands, so it composes with other `tool_call` handlers.
- Surprising: the refusal `reason` is user-visible text, not a code.

### packages/coding-agent/examples/extensions/protected-paths.ts
- Purpose: Block `write`/`edit` to `.env`, `.git/`, `node_modules/`.
- Key abstractions: `event.input.path` (not `file_path`).
- Data flow: `tool_call` → substring match on the path → `{block:true, reason}`.
- Non-obvious design decisions: it uses `path.includes(p)` rather than a resolved-path check — a deliberately simple example (`:19`).
- Edge cases / failure handling: reads are *not* blocked, only writes and edits (`:14`).
- Surprising: this is the minimal illustration of the write-door pattern, and it is weaker than the real thing — worth reading as a shape, not as a policy.

### packages/coding-agent/examples/extensions/tool-override.ts
- Purpose: Override the built-in `read` tool with an audited version that blocks sensitive paths.
- Key abstractions: `createReadToolDefinition`-style re-registration under the same name; `withFileMutationQueue` for the append-only log.
- Data flow: `read` → resolve the path against `ctx.cwd` → block-list test → log (ALLOWED/BLOCKED) → read, apply `offset`/`limit`, truncate at 50 KB.
- Non-obvious design decisions: "Since no custom renderCall/renderResult are provided, the built-in renderer is used automatically (syntax highlighting, line numbers, truncation warnings)." (`:16-17`) — overriding behaviour does not cost you the rendering.
- Edge cases / failure handling: logging failures are swallowed so the audit log can never break a read (`:57-59`).
- Surprising: the blocked result is a *successful* tool result with `details: {blocked:true}` and an explanatory text, not an error — the model is told why.

### packages/coding-agent/examples/extensions/built-in-tool-renderer.ts
- Purpose: Re-render `read`, `bash`, `edit`, `write` compactly by re-registering the built-in definitions with only new renderers.
- Key abstractions: `createReadToolDefinition(cwd)` / `createBashToolDefinition(cwd)` / `createEditToolDefinition(cwd)` / `createWriteToolDefinition(cwd)`.
- Data flow: spread the original definition, replace `renderCall`/`renderResult`, re-register under the same name.
- Non-obvious design decisions: the spread-then-override idiom keeps the original *execution* while replacing only presentation (`:42-90`); the edit renderer counts `+`/`-` lines in the diff to show `+12 / -3` (`:169-181`).
- Edge cases / failure handling: `isPartial` is checked first in every renderer so the "Reading…"/"Running…" placeholder shows during streaming.
- Surprising: the bash renderer scrapes the exit code out of the *text* (`output.match(/exit code: (\d+)/)`) rather than reading a structured field (`:114-115`) — a hint that the built-in bash details do not always carry the code.

### packages/coding-agent/examples/extensions/minimal-mode.ts
- Purpose: A "minimal" display mode: collapsed shows only the tool call, expanded shows full output.
- Key abstractions: the same spread-and-re-override idiom across seven built-in tools; `shortenPath` replacing `$HOME` with `~`.
- Data flow: `registerTool({...tools.read, renderCall, renderResult})` for read, bash, edit, write, find, grep, ls.
- Non-obvious design decisions: "Minimal mode: show nothing in collapsed state" — `return new Text("", 0, 0)` (`:79-80`).
- Edge cases / failure handling: the `expanded` flag is the only switch; the file documents the intended three-way ctrl+o cycle (standard / expanded / minimal) (`:8-11`).
- Surprising: (partial read — first 80 of 353 lines; the remainder is the per-tool renderers, which follow the read example exactly).

### packages/coding-agent/examples/extensions/truncated-tool.ts
- Purpose: The reference for tool-output truncation: an `rg` wrapper that truncates, saves the full output and tells the model where it is.
- Key abstractions: `DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES` imported from the package so extension tools use the *same* limits as built-ins; `truncateHead` vs `truncateTail`; `TruncationResult`.
- Data flow: exec ripgrep with a 100 MB buffer → `truncateHead(output, {maxLines, maxBytes})` → if truncated, write the full output to a temp file and append a notice naming the path.
- Non-obvious design decisions: "truncateHead keeps the first N lines/bytes (good for search results) / truncateTail keeps the last N lines/bytes (good for logs/command output)" (`:91-92`); the truncation notice states exactly how many lines and bytes were omitted (`:122-128`).
- Edge cases / failure handling: ripgrep's exit code 1 means "no matches", not an error (`:72-81`).
- Surprising: the tool *description* itself states the limits — "Output is truncated to 2000 lines or 50.0 KB (whichever is hit first)" — so the model knows the contract before calling (`:53`).

### packages/coding-agent/examples/extensions/dynamic-tools.ts
- Purpose: Register a tool at `session_start` and additional tools at runtime from a command.
- Key abstractions: `registeredToolNames: Set<string>`; `promptSnippet` and `promptGuidelines` on a tool.
- Data flow: `session_start` → register `echo_session`; `/add-echo-tool <name>` → validate the name → register a new tool.
- Non-obvious design decisions: tool names are normalised and validated with `/^[a-z0-9_]+$/` before registration (`:17-22`).
- Edge cases / failure handling: a duplicate name is refused with "Tool already registered" rather than replacing the tool (`:66-69`).
- Surprising: `promptGuidelines` (`:38`) is how a tool tells the model *how* to use it; the README calls this out as a key pattern.

### packages/coding-agent/examples/extensions/question.ts
- Purpose: A `question` tool with a full custom UI: an options list plus an inline "Type something…" editor.
- Key abstractions: `executionMode: "sequential"`; a `Focusable` overlay component with an embedded `Editor`.
- Data flow: model calls `question` → the tool opens a custom screen → the answer comes back in `details` and in the `content` text.
- Non-obvious design decisions: "Escape in editor returns to options, Escape in options cancels" — a two-level escape ladder (`:4`); the tool refuses to run outside TUI mode and returns a plain error result (`:53-61`).
- Edge cases / failure handling: an empty `options` array returns "Error: No options provided" rather than throwing (`:64-69`).
- Surprising: (partial read — first 80 of 286 lines; the remainder is the option/editor rendering and the answer-mapping logic).

### packages/coding-agent/examples/extensions/questionnaire.ts
- Purpose: The multi-question version of `question`, with a tab bar between questions.
- Key abstractions: `Question {id, label, prompt, options, allowOther}`; `Answer {id, value, label, wasCustom, index?}`; `QuestionnaireResult {questions, answers, cancelled}`.
- Data flow: model calls `questionnaire` with an array of questions → the UI shows a tab bar → answers are returned as a structured result.
- Non-obvious design decisions: the option carries a machine `value` *and* a display `label` separately (`:22-26`) — the model gets a stable value, the human gets prose; `allowOther` defaults to true and adds a "Type something" option (`:67`).
- Edge cases / failure handling: a shared `errorResult(message, questions)` helper returns a cancelled result with the questions attached (`:74-80`).
- Surprising: (partial read — first 80 of 448 lines; the remainder is the tab-bar component).

### packages/coding-agent/examples/extensions/structured-output.ts
- Purpose: A tool whose result **ends the turn** with `terminate: true`.
- Key abstractions: `defineTool` with `promptSnippet` / `promptGuidelines`; `details` carrying a structured payload; `terminate: true`.
- Data flow: model calls `structured_output` → the tool returns the payload in `details` and `terminate: true` → Pi skips the automatic follow-up turn.
- Non-obvious design decisions: the guidelines explicitly say "After calling structured_output, do not emit another assistant response in the same turn." (`:26`) — the contract is stated to the model, not just to the runtime.
- Edge cases / failure handling: the tool never throws; the model-visible content is a one-line acknowledgement while the payload lives in `details`.
- Surprising: the doc's wording — "Return `terminate: true` only when the agent should skip its automatic follow-up **after every completed tool in that batch agrees to terminate**" (`docs/extensions.md:253`) — terminate is a *batch* property, not a per-tool property.

### packages/coding-agent/examples/extensions/custom-compaction.ts
- Purpose: Replace Pi's compaction with a summary of the *entire* context, generated by a cheaper model.
- Key abstractions: the `session_before_compact` hook; `preparation.{messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary, fileOps, settings}`; `reason` ∈ {manual, threshold, overflow}.
- Data flow: hook → combine `messagesToSummarize` + `turnPrefixMessages` → `serializeConversation(convertToLlm(all))` → a second model summarizes → return `{compaction: {summary, firstKeptEntryId, tokensBefore, usage}}` → Pi appends the entry.
- Non-obvious design decisions: the summarizer is `google/gemini-2.5-flash` "cheaper/faster than most conversation models" (`:27`); `cacheRetention: "none"` on the summarization call (`:85`); the previous summary is fed in as context so repeated compactions accumulate (`:46`).
- Edge cases / failure handling: an empty summary returns `undefined` (falling back to default compaction) and an exception is caught and notified, also falling back (`:95-115`); the `signal` is passed to the model call so a cancelled compaction aborts (`:83`).
- Surprising: the extension does *not* decide the cut point — it receives `firstKeptEntryId` from the preparation and reuses it (`:105`). The hook replaces the *summary*, not the *policy*.

### packages/coding-agent/examples/extensions/trigger-compact.ts
- Purpose: Trigger compaction from an extension when the context crosses a token threshold.
- Key abstractions: `ctx.getContextUsage()` → `{tokens, contextWindow, percent}`; `ctx.compact({customInstructions, onComplete, onError})`.
- Data flow: `turn_end` → read usage → detect the *crossing* of 100 000 tokens (previous ≤ threshold AND current > threshold) → `ctx.compact()`.
- Non-obvious design decisions: the trigger is edge-based, not level-based — `crossedThreshold` requires the *previous* reading to be at or below the threshold, so it fires once (`:34-39`).
- Edge cases / failure handling: a `null` usage reading returns early rather than treating it as zero (`:30-32`).
- Surprising: `ctx.compact()` takes an `onComplete`/`onError` pair, so the extension is notified of the outcome without polling.

### packages/coding-agent/examples/extensions/handoff.ts
- Purpose: Transfer context to a *new* session instead of compacting — a lossy-summary-free context transfer.
- Key abstractions: `getHandoffMessages(branch)` reconstructs the effective context from a compacted branch; `ctx.newSession({parentSession, withSession})`.
- Data flow: read the active branch → if a compaction exists, rebuild the compacted projection (summary + kept entries + post-compaction entries) → `serializeConversation` → a dedicated "context transfer assistant" model writes a self-contained prompt → the user edits it → a new session is created with `parentSession` tracking and the prompt is placed in the editor.
- Non-obvious design decisions: the handoff prompt generator has its own system prompt demanding a *self-contained* result — "the new thread should be able to proceed without the old conversation" (`:25`); the new session is created with `ctx.newSession({parentSession: currentSessionFile, withSession: async (replacementCtx) => ...})` because "the original ctx is stale after a successful session replacement" (`:174-183`).
- Edge cases / failure handling: a cancelled editor aborts before any session is created (`:169-172`); `response.stopReason === "aborted"` is treated as a cancellation, not a result (`:141-143`).
- Surprising: the handoff generator runs with `cacheRetention: "none"` and a fresh `sessionId` (`:136-137`) — a one-shot prompt should not pollute the prefix cache.

### packages/coding-agent/examples/extensions/input-transform.ts
- Purpose: The `input` event — transform, handle or pass through raw user input.
- Key abstractions: the `input` event's return contract: `{action:"continue"}` / `{action:"transform", text, images}` / `{action:"handled"}`.
- Data flow: the editor's text → the `input` handler → either a transformed string, a handled short-circuit (no LLM call at all), or the original.
- Non-obvious design decisions: `event.source === "extension"` is checked first so extension-injected messages are not rewritten (`:17-19`); `handled` answers the user from the extension itself ("ping" → "pong") *without waking the model* (`:31-39`).
- Edge cases / failure handling: a `?quick` prefix with no body returns `{action:"handled"}` after a usage warning rather than transforming to an empty query (`:24-27`).
- Surprising: the `images` array must be carried through a transform (`{action:"transform", text, images}`) — a transform that forgets images silently drops the attachment.

### packages/coding-agent/examples/extensions/input-transform-streaming.ts
- Purpose: The same `input` hook, but latency-aware: skip the expensive preprocessing during steering.
- Key abstractions: `event.streamingBehavior === "steer"`.
- Data flow: `input` → if steering, return `continue` immediately; otherwise run `git diff --stat` and prepend it to the prompt.
- Non-obvious design decisions: "During steering, skip the exec call — corrections should be fast" (`:20-23`). This is the cheapest possible example of a steering-path latency budget.
- Edge cases / failure handling: a non-zero exit or empty diff returns `continue` unchanged (`:30-32`).
- Surprising: the transform appends the diff in a fenced code block, so the model sees it as data rather than prose.

### packages/coding-agent/examples/extensions/inline-bash.ts
- Purpose: Expand `!{command}` patterns inside a prompt before it reaches the model.
- Key abstractions: the `input` event's transform; a 30 s per-command timeout.
- Data flow: prompt → find all `!{…}` matches → `pi.exec("bash", ["-c", cmd])` → substitute the trimmed output → return the transformed text.
- Non-obvious design decisions: a whole-line `!command` is explicitly left alone — "This preserves the existing `!command` behavior" (`:28-30`); the regex's `lastIndex` is reset after `test()` because it is a module-level `/g` regex (`:37-38`).
- Edge cases / failure handling: a non-zero exit is recorded as `error: "exit code N"` and still substituted with the output; a thrown error substitutes `[error: …]` (`:61-76`).
- Surprising: matches are collected *first* and substituted afterwards "to avoid issues with replacing while iterating" (`:43-49`).

### packages/coding-agent/examples/extensions/interactive-shell.ts
- Purpose: Run interactive commands (vim, `git rebase -i`, htop) with the real terminal, suspending the TUI.
- Key abstractions: the `user_bash` hook; a ~70-entry allowlist of interactive commands; the `!i` force prefix.
- Data flow: `user_bash` → detect an interactive command (start-of-line match or *after the last pipe*) → in TUI mode, `tui.stop()`, clear the screen, `spawnSync` with `stdio:"inherit"`, `tui.start()` → return a synthetic `BashResult` so the default handler does not run.
- Non-obvious design decisions: the pipe-aware match — "cat file | less" is detected by looking after the *last* `|` (`:119-126`); `INTERACTIVE_COMMANDS` / `INTERACTIVE_EXCLUDE` env vars let a user extend the list (`:100-107`).
- Edge cases / failure handling: outside TUI mode the command returns `(interactive commands require TUI)` with exit code 1 rather than hanging (`:149-153`).
- Surprising: the hook intercepts *user* `!` commands only — "If the agent runs an interactive command, it will fail (which is fine)." (`:19-20`).

### packages/coding-agent/examples/extensions/git-checkpoint.ts
- Purpose: Snapshot the *code* at each turn so a fork can restore it.
- Key abstractions: `git stash create` (creates a commit without touching the working tree) keyed by the current leaf entry id.
- Data flow: `tool_result` → remember the leaf id → `turn_start` → `git stash create` → store `ref` → `session_before_fork` → offer to `git stash apply <ref>` → `agent_settled` → clear the map.
- Non-obvious design decisions: `stash create` is used instead of `stash push` precisely because it does not modify the working tree (`:22`); the checkpoints are cleared on `agent_settled` so they do not outlive the run.
- Edge cases / failure handling: in non-interactive mode the restore is *not* applied automatically (`:33-36`).
- Surprising: the code state and the transcript are checkpointed on the same id, so `/fork` restores both coherently — an idea August could take for its own session/fork.

### packages/coding-agent/examples/extensions/git-merge-and-resolve.ts
- Purpose: Keep the branch up to date and hand the *model* a structured conflict report.
- Key abstractions: `ConflictBlock {file, startLine, separatorLine, endLine}`; parsing `<<<<<<< / ======= / >>>>>>>` markers from files listed by `git diff --name-only --diff-filter=U`.
- Data flow: `agent_end` → `git rev-parse --git-dir` → if not already merging, fetch + `git merge --no-ff` → on conflict, parse the unmerged files → `pi.sendUserMessage(formatted, {deliverAs:"followUp"})`.
- Non-obvious design decisions: the conflict report gives file, line range, and the *ours*/*theirs* sub-ranges, so the model can target an edit precisely (`:62-71`); a new merge is only attempted when the working tree is clean (`:84-85`).
- Edge cases / failure handling: a failed fetch notifies and returns without touching the tree (`:100-103`); an unfinished merge from a previous run is re-reported (`:109-110`).
- Surprising: the conflict message is delivered as a **follow-up**, not injected into the current turn — so it lands after the current work rather than mid-flight.

### packages/coding-agent/examples/extensions/dirty-repo-guard.ts
- Purpose: Refuse to switch or fork a session while the repo has uncommitted changes.
- Key abstractions: `git status --porcelain`; the shared `checkDirtyRepo(pi, ctx, action)` helper.
- Data flow: `session_before_switch` / `session_before_fork` → status → count changed files → confirm → `{cancel:true}`.
- Non-obvious design decisions: fail-closed in non-interactive mode (`:28-31`); "Not a git repo, allow the action" (`:18-21`) — the guard is scoped to git repos.
- Edge cases / failure handling: the user can override with an explicit "Yes, proceed anyway".
- Surprising: the guard counts *files* rather than diff size, so the message is concrete ("You have 3 uncommitted file(s)").

### packages/coding-agent/examples/extensions/auto-commit-on-exit.ts
- Purpose: Commit on `session_shutdown` using the last assistant message as the commit message.
- Key abstractions: `pi.exec("git", [...])`; `ctx.sessionManager.getEntries()`.
- Data flow: shutdown → status → find the last assistant message → take its first line, truncate to 50 chars → `git add -A` → `git commit -m "[pi] …"`.
- Non-obvious design decisions: the message is prefixed `[pi]` so agent-authored commits are distinguishable (`:39`); the whole thing is in `session_shutdown`, not in a tool.
- Edge cases / failure handling: a non-zero status code (not a repo) or a clean tree exits silently (`:15-18`).
- Surprising: it uses `getEntries()` (all entries) rather than `getBranch()` — appropriate here, since the commit is about the working tree, not the branch.

### packages/coding-agent/examples/extensions/shutdown-command.ts
- Purpose: A `/quit` command and two tools that request an orderly shutdown.
- Key abstractions: `ctx.shutdown()`.
- Data flow: command or tool → `ctx.shutdown()` → the process disposes the runtime and exits; a tool's return value is still delivered to the model first (`:31-33`).
- Non-obvious design decisions: "Request graceful shutdown (deferred until agent is idle)" (`:28`).
- Edge cases / failure handling: `onUpdate` is used to report progress *before* the shutdown lands (`:48`, `:54`).
- Surprising: shutdown is a *request*, not an action — the current turn is allowed to finish.

### packages/coding-agent/examples/extensions/reload-runtime.ts
- Purpose: Reload extensions/resources safely, from both a command and a model-callable tool.
- Key abstractions: `ctx.reload()` is only available on `ExtensionCommandContext`; tools get `ExtensionContext`.
- Data flow: `/reload-runtime` → `ctx.reload()`; the `reload_runtime` tool → `pi.sendUserMessage("/reload-runtime", {deliverAs:"followUp"})` → the command runs.
- Non-obvious design decisions: **"Tools get ExtensionContext, so they cannot call `ctx.reload()` directly. Instead, queue a follow-up user command that executes the command above."** (`:22-23`) — a capability separation that avoids a deadlock (the docs say command-only operations "are command-only because calling them from lifecycle handlers can deadlock the runtime", `docs/extensions.md:330`).
- Edge cases / failure handling: the tool returns a text result saying the reload was *queued*, not done.
- Surprising: it is a one-line pattern that solves a real re-entrancy problem.

### packages/coding-agent/examples/extensions/preset.ts
- Purpose: Named presets (model + thinking level + tools + instructions) from `presets.json`, switchable by flag, command or shortcut.
- Key abstractions: `Preset {provider, model, thinkingLevel, tools, instructions}`; `pi.registerFlag("preset", {type:"string"})`; `originalState` snapshot.
- Data flow: `~/.pi/agent/presets.json` merged with `<cwd>/.pi/presets.json` (project wins) → `applyPreset` sets the model, the thinking level and the active tool set → the instructions are injected into the system prompt.
- Non-obvious design decisions: the *pre-preset* state is snapshotted on the first transition so "(none)" can restore it exactly (`:123-130`, `:270-286`); unknown tool names are warned about but do not abort the preset (`:156-158`).
- Edge cases / failure handling: a model with no API key produces a warning, not a crash (`:136-142`).
- Surprising: (partial read — lines 1-309 of 436; the remainder is the Ctrl+Shift+U cycle handler and the system-prompt injection, which I did not read line by line).

### packages/coding-agent/examples/extensions/plan-mode/index.ts
- Purpose: Claude-Code-style plan mode — read-only exploration with a bash allowlist, followed by an execution phase with step tracking.
- Key abstractions: `PLAN_MODE_TOOLS` vs `NORMAL_MODE_TOOLS`; `PlanModeState {enabled, todos, executing, toolsBeforePlanMode}`; the `plan-mode` custom entry for persistence.
- Data flow: `/plan` → snapshot `pi.getActiveTools()` → `pi.setActiveTools(planTools)` (edit/write removed) → the agent plans → `agent_end` → parse the "Plan:" section → offer "Execute the plan" → restore the full tool set → inject an execution context → track `[DONE:n]` markers in `turn_end` → a widget shows progress.
- Non-obvious design decisions: the tool set is *restored from the snapshot*, not recomputed, so a user's own tool choices survive a plan-mode round trip (`:104-114`); the injected context is filtered back out of the context when plan mode is off (`:177-198`); on resume, only messages *after* the last `plan-mode-execute` marker are scanned for `[DONE:n]`, "to avoid picking up `[DONE:n]` from previous plans" (`:363-387`).
- Edge cases / failure handling: the `context` hook removes the stale plan-mode reminder; `before_agent_start` skips custom-message runs because "the context from the last prompt is still in the conversation, and adding it again on every notification would only repeat it" (`:200-203`).
- Surprising: the plan-mode context is injected as a **custom message with `display:false`** — it reaches the model without appearing in the transcript.

### packages/coding-agent/examples/extensions/plan-mode/utils.ts
- Purpose: Pure, testable helpers for plan mode — the command safety predicate and the plan/step parsers.
- Key abstractions: `DESTRUCTIVE_PATTERNS` (40 entries) and `SAFE_PATTERNS` (60 entries); `TodoItem`; `extractTodoItems`, `extractDoneSteps`, `markCompletedSteps`, `cleanStepText`.
- Data flow: `isSafeCommand(cmd)` = not destructive AND is safe; `extractTodoItems(text)` finds a `Plan:` header then numbered items; `markCompletedSteps` applies `[DONE:n]`.
- Non-obvious design decisions: the double predicate — a command must **not** match a destructive pattern *and* must match a safe pattern, so an unknown command is blocked by default (`:97-101`).
- Edge cases / failure handling: `cleanStepText` strips markdown, code fences and leading imperative verbs, and truncates to 50 chars (`:109-127`).
- Surprising: the comment at the top — "Pure utility functions … Extracted for testability" (`:3`) — the file exists to be unit-tested, which is the only testing strategy in the whole examples tree.

### packages/coding-agent/examples/extensions/plan-mode/README.md
- Purpose: The plan-mode user guide — features, commands, the workflow and the allow/deny lists.
- Key abstractions: the `[DONE:n]` marker protocol; the "Plan:" output contract.
- Data flow: plan mode → numbered plan under a `Plan:` header → "Execute the plan" → `[DONE:n]` per step → progress widget.
- Non-obvious design decisions: "Built-in write tools disabled … Other active tools remain available" (`:7-8`) — the restriction is a *subset*, not a fixed tool list.
- Edge cases / failure handling: n/a.
- Surprising: the README's "How It Works" section documents the two-phase model (plan / execute) and the fact that the widget only appears during execution.

### packages/coding-agent/examples/extensions/tic-tac-toe.ts
- Purpose: A game that demonstrates `executionMode: "sequential"` — the fix for sibling tool calls racing on shared state.
- Key abstractions: `executionMode: "sequential"`; `BoardDetails` (board + agent cursor + status + turn) persisted with each tool result.
- Data flow: the model emits a `move_*` action and a final `play` **as separate tool_use blocks in one assistant response**; under parallel execution `play` can resolve before the `move_*` calls finish, so the mark lands on the wrong cell.
- Non-obvious design decisions: the tool header comment states the race in full — "Move actions share the agent cursor and have a 300ms delay. Under the default parallel tool-execution mode this races…" (`:10-14`); the user cursor is stored in a *separate* variable and "Only the agent cursor is ever exposed to the agent" (`:16-17`).
- Edge cases / failure handling: a custom `TicTacToeError` is thrown for illegal actions and "the agent runtime surfaces thrown errors as tool errors (isError=true) without resetting any of our state" (`:25-29`).
- Surprising: (partial read — first 70 of 1008 lines; the remainder is game logic and the TUI board, which I did not read line by line).

### packages/coding-agent/examples/extensions/subagent/index.ts
- Purpose: The 1036-line subagent tool — spawn a separate `pi` process per delegated task, in single, parallel or chained mode.
- Key abstractions: `AgentConfig`; `SingleResult`; `SubagentDetails`; `MAX_PARALLEL_TASKS = 8`, `MAX_CONCURRENCY = 4`, `PER_TASK_OUTPUT_CAP = 50 KiB`; `mapWithConcurrencyLimit`.
- Data flow: `execute` → validate exactly one mode → discover agents → build CLI args (`--mode json -p --no-session [--model] [--thinking] [--tools] [--append-system-prompt <tmpfile>]`) → spawn → parse the JSONL stream line by line → accumulate messages and usage → render.
- Non-obvious design decisions: isolation is a **process**, not a context object — "Spawns a separate `pi` process for each subagent invocation, giving it an isolated context window." (`:4-5`); the agent's system prompt is written to a temp file with mode `0600` and passed via `--append-system-prompt` (`:237-245`, `:332-337`); a failing chain step **stops the chain** (`:585-593`); `{previous}` is substituted into the next step's task text (`:554`).
- Edge cases / failure handling: abort escalates SIGTERM → SIGKILL after 5 s and the whole call throws "Subagent was aborted" (`:408-422`); an unknown agent name returns a helpful error listing the available agents (`:284-296`); per-task output is truncated to 50 KiB with the full output kept in `details` (`:191-200`).
- Surprising: the model/thinking level is inherited from the dispatching session **unless the agent declares its own** (`:299-304`), and project-local agents require an explicit scope *and* a confirmation prompt when the project is untrusted (`:518-546`).

### packages/coding-agent/examples/extensions/subagent/agents.ts
- Purpose: Agent discovery — reading agent definitions from `~/.pi/agent/agents` and `<cwd>/.pi/agents`.
- Key abstractions: `AgentConfig {name, description, tools?, model?, systemPrompt, source, filePath}`; `discoverAgents(cwd, scope)`; `formatAgentList`.
- Data flow: `findNearestProjectAgentsDir` walks *up* from cwd looking for `.pi/agents` (`:116-126`); each `*.md` is parsed with `parseFrontmatter`; `name` and `description` are required.
- Non-obvious design decisions: `parseToolList` accepts both YAML spellings — `tools: read, bash` (string) and `tools: [read, bash]` (array) — and anything else "yields no tools rather than throwing: this runs inside agent discovery, where a single bad file must not take down every other agent in the same directory" (`:41-60`).
- Edge cases / failure handling: every filesystem operation is individually try/caught (`:65`, `:83-86`, `:109-114`).
- Surprising: project agents *override* user agents of the same name when the scope is `"both"` (`:137-139`).

### packages/coding-agent/examples/extensions/subagent/README.md
- Purpose: The subagent reference — features, structure, installation, security model, modes, output display, agent definitions, error handling, limitations.
- Key abstractions: the three modes (single / parallel / chain) and their limits (max 8 tasks, 4 concurrent).
- Data flow: n/a (documentation), but it states the flow: discover → confirm project agents → spawn → stream → aggregate.
- Non-obvious design decisions: the **security model section** — project-local agents are "repo-controlled prompts that can instruct the model to read files, run bash commands, etc.", so only user-level agents load by default (`:55-65`).
- Edge cases / failure handling: the error-handling table — exit code ≠ 0, `stopReason: "error"`, `stopReason: "aborted"`, and "Chain mode: Stops at first failing step" (`:165-171`).
- Surprising: the stated limitations include "Agents discovered fresh on each invocation (allows editing mid-session)" (`:176`).

### packages/coding-agent/examples/extensions/subagent/agents/scout.md
- Purpose: A fast recon agent that returns compressed context for another agent.
- Key abstractions: frontmatter `tools: read, grep, find, ls, bash`, `model: claude-haiku-4-5`.
- Data flow: the agent greps/finds, reads key sections and emits a fixed output shape (Files Retrieved with exact line ranges, Key Code, Architecture, Start Here).
- Non-obvious design decisions: "Your output will be passed to an agent who has NOT seen the files you explored." (`:10`) — the prompt is written for a *consumer*, which is why the line ranges are mandatory.
- Edge cases / failure handling: "Read key sections (not entire files)" and a three-level thoroughness the agent infers from the task (`:12-15`).
- Surprising: the output format demands *exact line ranges* (`path/to/file.ts (lines 10-50)`), which makes the handoff verifiable by the receiving agent.

### packages/coding-agent/examples/extensions/subagent/agents/planner.md
- Purpose: A planning agent that produces a plan and explicitly makes no changes.
- Key abstractions: frontmatter `tools: read, grep, find, ls` (no bash, no write).
- Data flow: receives a scout's context → emits Goal / Plan / Files to Modify / New Files / Risks.
- Non-obvious design decisions: "You must NOT make any changes. Only read, analyze, and plan." (`:10`); "Keep the plan concrete. The worker agent will execute it verbatim." (`:37`) — the plan is written for a machine, not a human.
- Edge cases / failure handling: n/a.
- Surprising: the plan format separates "Files to Modify" and "New Files (if any)" so the worker can act without re-deriving the file set.

### packages/coding-agent/examples/extensions/subagent/agents/reviewer.md
- Purpose: A code-review agent with a read-only bash allowance.
- Key abstractions: frontmatter `tools: read, grep, find, ls, bash`; the Critical / Warnings / Suggestions triage.
- Data flow: `git diff` → read the changed files → report by severity with `file.ts:42` references.
- Non-obvious design decisions: "**Assume tool permissions are not perfectly enforceable; keep all bash usage strictly read-only.**" (`:11`) — the prompt states the assumption explicitly, which is the right posture for an agent whose tool list also contains `bash`.
- Edge cases / failure handling: "Do NOT modify files or run builds." (`:10`).
- Surprising: the output demands "Be specific with file paths and line numbers" (`:35`) — the same verifiable-output discipline as the scout.

### packages/coding-agent/examples/extensions/subagent/agents/worker.md
- Purpose: The general-purpose agent with the default (full) tool set.
- Key abstractions: frontmatter with `name`/`description`/`model` and **no** `tools` key, so the default tool set applies.
- Data flow: works autonomously; emits Completed / Files Changed / Notes.
- Non-obvious design decisions: "You operate in an isolated context window to handle delegated tasks without polluting the main conversation." (`:7`); when handing off, "include: Exact file paths changed, Key functions/types touched (short list)" (`:22-24`).
- Edge cases / failure handling: n/a.
- Surprising: the handoff checklist in the prompt is exactly the information the *next* agent needs — the subagent protocol treats the agent's final message as an API.

### packages/coding-agent/examples/extensions/subagent/prompts/implement.md
- Purpose: A prompt template that scripts a scout → planner → worker chain.
- Key abstractions: the `{previous}` placeholder (the chain's data flow) and `$@` (the user's argument).
- Data flow: "1. First, use the 'scout' agent to find all code relevant to: $@ / 2. Then, use the 'planner' agent to create an implementation plan for '$@' using the context from the previous step (use {previous} placeholder) / 3. Finally, use the 'worker' agent to implement the plan…"
- Non-obvious design decisions: the template instructs the *model* to use the tool's `chain` parameter rather than calling the tool three times.
- Edge cases / failure handling: n/a.
- Surprising: a workflow is expressible as a prompt template, not as code — the tool's shape (`chain` + `{previous}`) is what makes that possible.

### packages/coding-agent/examples/extensions/subagent/prompts/scout-and-plan.md
- Purpose: The scout → planner chain, explicitly stopping before implementation.
- Key abstractions: same as `implement.md`.
- Data flow: scout → planner → return the plan.
- Non-obvious design decisions: "Do NOT implement - just return the plan." (`:9`).
- Edge cases / failure handling: n/a.
- Surprising: the difference from `implement.md` is one sentence — the same tool, a different terminal instruction.

### packages/coding-agent/examples/extensions/subagent/prompts/implement-and-review.md
- Purpose: The worker → reviewer → worker chain (implement, review, apply the review).
- Key abstractions: the same `{previous}` chaining, with the *worker* appearing twice.
- Data flow: worker implements → reviewer reviews → worker applies the feedback.
- Non-obvious design decisions: the loop closes by re-invoking the same agent with the review as input (`:8`).
- Edge cases / failure handling: n/a.
- Surprising: the chain mechanism supports a *cycle* with no special-casing, because `{previous}` is just text substitution.

### packages/coding-agent/examples/extensions/jev-router.ts
- Purpose: A virtual model that plans on a strong model and implements on a cheap one, using a classifier to pick the planner.
- Key abstractions: `ModelRouteRequest<JevState>`; `JevState {phase, model}`; `EDIT_TOOLS = new Set(["edit","write"])`.
- Data flow: `route(request, ctx)` → `direct` requests go to Luna → no state yet → `choosePlanningModel` (keep the session's current planner to avoid a cache miss, else ask the Jev classifier, defaulting to Terra) → once a successful `edit`/`write` tool result appears in the turn, switch to Luna and stay there.
- Non-obvious design decisions: "A session therefore switches models once and accepts a single prompt-cache miss." (`:12`); the planner choice keeps the previous model when it is already Sol/Terra, "so switching to jev/auto costs no cache miss" (`:63-65`); the classifier is given only the first 16 000 characters of the last user message (`:72`).
- Edge cases / failure handling: an unavailable Jev model falls back to Terra (`:68`); `direct` requests (compaction summaries) always go to Luna (`:100`).
- Surprising: the switch condition is derived from the *transcript* ("a tool call since the last user message edited a file successfully", `:53-59`) rather than from a counter — a robust "have we started implementing?" test.

### packages/coding-agent/examples/extensions/debug-provider.ts
- Purpose: An opt-in raw provider-stream viewer that persists captured events as expandable session entries.
- Key abstractions: the `provider_stream_event` hook; `registerEntryRenderer`; the `debug-provider-events` custom entry type.
- Data flow: `turn_start` opens a buffer → `provider_stream_event` pushes `structuredClone(event.data)` → `message_end` freezes it into a `ProviderDebugEntry` → `turn_end` appends the entry.
- Non-obvious design decisions: capture is grouped *per assistant message*, not per turn (`:66-89`); the events are `structuredClone`d so a later mutation of the event object cannot corrupt the record (`:71`).
- Edge cases / failure handling: a missing payload renders "[provider debug] Missing event data" instead of throwing (`:29`).
- Surprising: this is the "how do I see what the provider actually sent" tool — and it uses the *same* custom-entry + entry-renderer pair that `entry-renderer.ts` demonstrates.

### packages/coding-agent/examples/extensions/event-bus.ts
- Purpose: Inter-extension communication via `pi.events`.
- Key abstractions: `pi.events.on(name, handler)` / `pi.events.emit(name, data)`.
- Data flow: an extension emits a namespaced event; every listener receives the payload.
- Non-obvious design decisions: the event name is namespaced with a colon (`my:notification`) to avoid collisions (`:21`).
- Edge cases / failure handling: the listener holds `currentCtx` from `session_start` and uses optional chaining (`currentCtx?.ui.notify`) so a notification before the session starts is a no-op (`:14-24`).
- Surprising: the example emits its own event from `session_start` as well, demonstrating that the bus is usable for boot-time handshakes.

### packages/coding-agent/examples/extensions/entry-renderer.ts
- Purpose: Persist durable extension data *and* render it in the transcript, without sending it to the LLM.
- Key abstractions: `pi.appendEntry<StatusCardData>("status-card", data)` + `pi.registerEntryRenderer<StatusCardData>("status-card", renderer)`.
- Data flow: `/status-card <text>` → `appendEntry` (persisted, not in LLM context) → the renderer draws a `Box` with `customMessageBg`.
- Non-obvious design decisions: the entry type string and the renderer registration key must match — that pairing is the whole contract.
- Edge cases / failure handling: a missing payload falls back to "No data" with the current time (`:21`).
- Surprising: this is the mechanism for "the user should see this, the model should not".

### packages/coding-agent/examples/extensions/message-renderer.ts
- Purpose: Custom rendering for *custom messages* (which DO reach the model).
- Key abstractions: `registerMessageRenderer(customType, renderer)`; the renderer receives `{expanded, outputPad}`.
- Data flow: `/status [warn|error] text` → `pi.sendMessage({customType:"status-update", content, display:true, details:{level,timestamp}})` → the renderer colours by level.
- Non-obvious design decisions: the level is parsed from a leading `warn`/`error` token in the command argument (`:45-49`); `details` carries the metadata and is *not* sent to the model (`docs/message-types.md:235`).
- Edge cases / failure handling: the `outputPad` is honoured when building the `Box` so the message lines up with the rest of the transcript (`:32`).
- Surprising: `custom_message` entries participate in the LLM context while `custom` entries do not — two different entry types for two different audiences.

### packages/coding-agent/examples/extensions/bookmark.ts
- Purpose: Label entries so they are easy to find in `/tree`.
- Key abstractions: `pi.setLabel(entryId, label)`; `ctx.sessionManager.getLabel(entryId)`.
- Data flow: `/bookmark [label]` → walk the entries backwards to the last assistant message → set the label; `/unbookmark` → walk back to the last labelled entry and clear it.
- Non-obvious design decisions: an empty argument generates `bookmark-${Date.now()}` (`:16`).
- Edge cases / failure handling: "No assistant message to bookmark" / "No bookmarked entry found" warnings (`:29`, `:47`).
- Surprising: labels are persisted as `LabelEntry` records, so they survive a resume and appear in the tree view.

### packages/coding-agent/examples/extensions/session-name.ts
- Purpose: Name the session so the picker shows a friendly label.
- Key abstractions: `pi.setSessionName(name)` / `pi.getSessionName()`.
- Data flow: `/session-name <name>` → set; `/session-name` with no argument → show.
- Non-obvious design decisions: the name is stored as a `SessionInfoEntry`, and "The session name is displayed in the session selector (`/resume`) instead of the first message when set" (`docs/session-format.md:207`).
- Edge cases / failure handling: the "no name set" case is reported distinctly.
- Surprising: 27 lines — a useful reminder that some of Pi's best affordances are one API call.

### packages/coding-agent/examples/extensions/status-line.ts
- Purpose: Persistent status text in the footer, showing turn progress.
- Key abstractions: `ctx.ui.setStatus(key, text)`; `ctx.ui.theme`.
- Data flow: `session_start` → "Ready"; `turn_start` → "● Turn N..."; `turn_end` → "✓ Turn N complete".
- Non-obvious design decisions: the status is keyed (`"status-demo"`) so several extensions can each own a slot (`:15`).
- Edge cases / failure handling: n/a.
- Surprising: 32 lines for a complete live progress indicator — `setStatus` is the cheapest useful extension.

### packages/coding-agent/examples/extensions/model-status.ts
- Purpose: Show the current model in the status bar and notify on changes.
- Key abstractions: the `model_select` hook with `{model, previousModel, source}`.
- Data flow: `model_select` → format `provider/id` → `ctx.ui.setStatus("model", …)`; a notification is skipped when `source === "restore"` so resuming a session is not noisy.
- Non-obvious design decisions: the restore case is deliberately silent (`:21-23`).
- Edge cases / failure handling: `previousModel` may be absent → "none" (`:18`).
- Surprising: `model_select` fires for `/model`, Ctrl+P cycling **and** session restore — one hook covers all three selection paths.

### packages/coding-agent/examples/extensions/working-indicator.ts
- Purpose: Customise the streaming "working" indicator (dot / pulse / spinner / none / default).
- Key abstractions: `ctx.ui.setWorkingIndicator({frames, intervalMs})`; `ctx.ui.setWorkingIndicator(undefined)` restores the default.
- Data flow: `/working-indicator <mode>` → `getIndicator(mode)` → apply → also update a status line describing the mode.
- Non-obvious design decisions: `frames: []` is how you *hide* the indicator (`:33-35`); "reset" maps to `undefined`, not to an explicit frame list (`:118`).
- Edge cases / failure handling: an unknown mode produces a usage error listing the valid ones (`:107-116`).
- Surprising: the mode is applied at `session_start` and re-applied by the command, so it survives a reload.

### packages/coding-agent/examples/extensions/working-message-test.ts
- Purpose: A regression check that a custom working message and indicator survive loader recreations between turns.
- Key abstractions: `ctx.ui.setWorkingMessage(text)` and `ctx.ui.setWorkingIndicator(options)`.
- Data flow: `session_start` → set both → the user sends several messages and checks the indicator is still custom.
- Non-obvious design decisions: the test is a *manual* one — "the working message should stay 'Working... (custom)' with a brown dot indicator every time the loader appears, not revert to the default gray 'Working...'" (`:10-12`).
- Edge cases / failure handling: n/a.
- Surprising: it documents a real bug class (per-turn loader recreation silently reverting UI state) and the mitigation (set it on `session_start`, not on `agent_start`).

### packages/coding-agent/examples/extensions/hidden-thinking-label.ts
- Purpose: Customise the label shown when thinking blocks are collapsed.
- Key abstractions: `ctx.ui.setHiddenThinkingLabel(text)`; resetting with no argument.
- Data flow: `session_start` → apply the stored label; `/thinking-label <text>` → set and re-apply.
- Non-obvious design decisions: the label is applied on `session_start` *and* on the command, because the UI is rebuilt (`:32-34`, `:48-49`).
- Edge cases / failure handling: `/thinking-label` with no argument resets to "Pondering..." (`:41-47`).
- Surprising: 53 lines to rename one label — the extension surface really is that fine-grained.

### packages/coding-agent/examples/extensions/titlebar-spinner.ts
- Purpose: A braille spinner in the terminal title while the agent works.
- Key abstractions: `ctx.ui.setTitle(text)`; `pi.getSessionName()`.
- Data flow: `agent_start` → start an 80 ms interval that rewrites the title with the next frame → `agent_settled` / `session_shutdown` → restore the base title.
- Non-obvious design decisions: the animation is driven by `agent_start`/`agent_settled`, not by `turn_start`/`turn_end` — it reflects the whole run.
- Edge cases / failure handling: `stopAnimation` is idempotent and is called from both `agent_settled` and `session_shutdown` (`:51-57`).
- Surprising: the base title is `π - <session> - <cwd>`, so the spinner replaces only the first glyph.

### packages/coding-agent/examples/extensions/notify.ts
- Purpose: A native desktop notification when the agent is done and waiting.
- Key abstractions: OSC 777 (Ghostty/iTerm2/WezTerm), OSC 99 (Kitty), a Windows toast via `powershell.exe`.
- Data flow: `agent_settled` → pick a protocol from the environment (`WT_SESSION` / `KITTY_WINDOW_ID` / default) → write the escape sequence or spawn PowerShell.
- Non-obvious design decisions: **"`agent_end` fires after each low-level run; Pi may still retry, compact, or continue with queued follow-ups. Notify only after the full run settles."** (`:52-53`) — the example is a lesson in choosing the right lifecycle event.
- Edge cases / failure handling: the Kitty protocol needs two writes (the title, then the body) (`:31-33`).
- Surprising: the Windows toast is a `Windows.UI.Notifications` PowerShell script assembled as a one-liner (`:13-24`).

### packages/coding-agent/examples/extensions/custom-footer.ts
- Purpose: Replace the footer with one that shows token totals, cost, model and git branch.
- Key abstractions: `ctx.ui.setFooter((tui, theme, footerData) => component)`; `footerData.getGitBranch()` and `footerData.onBranchChange(cb)`.
- Data flow: the component's `render(width)` recomputes the usage by walking `ctx.sessionManager.getBranch()` and summing assistant-message usage; `onBranchChange` triggers `tui.requestRender()`.
- Non-obvious design decisions: the component returns `{dispose: unsub, invalidate(){}, render(width)}` — the `dispose` hook is how the subscription is released when the footer is replaced (`:28`).
- Edge cases / failure handling: `ctx.model?.id || "no-model"` and a null branch both have explicit fallbacks.
- Surprising: the footer is re-computed from the branch on every render rather than cached, which is correct for a branch-aware view but costs a full walk per frame.

### packages/coding-agent/examples/extensions/custom-header.ts
- Purpose: Replace the built-in header with an ASCII-art mascot.
- Key abstractions: `ctx.ui.setHeader((tui, theme) => component)`; `ctx.ui.setHeader(undefined)` restores the default.
- Data flow: `session_start` → build the mascot lines from theme colours → render them plus a version subtitle.
- Non-obvious design decisions: the mascot is drawn from block characters and uses `theme.fg("accent", …)` so it follows the theme (`:16-18`).
- Edge cases / failure handling: the header is only installed in TUI mode (`:50`).
- Surprising: the subtitle is literally "shitty coding agent" (`:56`) — the example is deliberately irreverent.

### packages/coding-agent/examples/extensions/widget-placement.ts
- Purpose: Place persistent widgets above and below the editor.
- Key abstractions: `ctx.ui.setWidget(key, lines, {placement})` with `placement` ∈ {aboveEditor, belowEditor}.
- Data flow: `session_start` → two `setWidget` calls with distinct keys.
- Non-obvious design decisions: the key identifies the widget so it can be updated or cleared later; `undefined` lines clears it.
- Edge cases / failure handling: the whole thing is guarded by `ctx.hasUI` (`:5`).
- Surprising: 9 lines — the widget API is a one-call affair.

### packages/coding-agent/examples/extensions/modal-editor.ts
- Purpose: A vim-like modal editor that replaces the main input.
- Key abstractions: `CustomEditor`; `NORMAL_KEYS` mapping keys to terminal escape sequences.
- Data flow: `handleInput` → Escape toggles insert/normal (in normal mode Escape falls through to the base so it still aborts the agent) → in normal mode a mapped key is translated into the equivalent escape sequence and re-sent to `super.handleInput` (`:31-65`).
- Non-obvious design decisions: the modal editor **translates** keys rather than implementing cursor movement, so all base behaviour is preserved; in normal mode printable characters are swallowed and control sequences are passed through (`:62-64`).
- Edge cases / failure handling: `render` appends a " NORMAL "/" INSERT " indicator to the bottom border only if there is room (`:72-76`).
- Surprising: the Escape ladder — insert → normal → (base) abort — is a two-press escape from a modal editor to an abort, and the base class still owns the abort.

### packages/coding-agent/examples/extensions/rainbow-editor.ts
- Purpose: An animated shine effect on the word "ultrathink" in the editor.
- Key abstractions: `CustomEditor` + a `setInterval` that calls `tui.requestRender()`.
- Data flow: `handleInput` → if the text contains "ultrathink", start the animation; otherwise stop it → `render` colourises the word with a 3-letter shine.
- Non-obvious design decisions: the animation cycle is 10 shine positions + 10 pause frames (`:78-79`), so the effect breathes instead of strobing; the timer is started/stopped based on content, not unconditionally.
- Edge cases / failure handling: `stopAnimation` clears the interval and the frame counter (`:60-65`).
- Surprising: the editor's `render` post-processes the *already rendered* lines with a regex replacement — the animation is a display-only transform over the base editor's output.

### packages/coding-agent/examples/extensions/timed-confirm.ts
- Purpose: Dialogs that auto-cancel, two ways.
- Key abstractions: `ctx.ui.confirm(title, message, {timeout})` and `{signal}`.
- Data flow: `/timed` → a 5 s timeout option; `/timed-select` → a 10 s select with a timeout; `/timed-signal` → an explicit `AbortController` with a 5 s `setTimeout`.
- Non-obvious design decisions: the timeout form is "recommended" and the client need not track it (`docs/rpc-extension-ui.md:10`); the manual form distinguishes "timed out" from "cancelled by user" by checking `controller.signal.aborted` (`:63-67`).
- Edge cases / failure handling: `clearTimeout(timeoutId)` runs after the dialog resolves, so the timer does not leak (`:59`).
- Surprising: the same API supports both a deadline and a cancellation signal, and the two are not interchangeable semantically.

### packages/coding-agent/examples/extensions/bash-spawn-hook.ts
- Purpose: Adjust the command, cwd and environment of every bash invocation.
- Key abstractions: `createBashTool(cwd, {spawnHook})`; re-registering the tool with a wrapped `execute`.
- Data flow: `spawnHook({command, cwd, env})` → return a modified triple → the tool spawns with it.
- Non-obvious design decisions: the hook prepends `source ~/.profile\n` so the command sees the user's profile (`:18`).
- Edge cases / failure handling: the wrapper forwards `id, params, signal, onUpdate` to the original `execute` unchanged (`:26-28`).
- Surprising: the hook is the *only* way to change the bash environment, and `shellCommandPrefix` does not reach an extension-provided shell tool (`docs/shell-aliases.md:83`).

### packages/coding-agent/examples/extensions/commands.ts
- Purpose: A `/commands` command that lists every discoverable slash command.
- Key abstractions: `pi.getCommands()` → `SlashCommandInfo {name, description, source, sourceInfo}`; `getArgumentCompletions(prefix)`.
- Data flow: `/commands [source]` → filter by `extension`/`prompt`/`skill` → render a grouped select list → on selection, offer to show the source path.
- Non-obvious design decisions: the argument completer offers exactly the three source names (`:18-22`); the list is presented as a *select* so it can scroll, not a notification (`:57`).
- Edge cases / failure handling: an empty result notifies instead of opening an empty picker (`:30-34`).
- Surprising: the source path of any command is one confirmation away — a debugging aid for "where did this prompt template come from".

### packages/coding-agent/examples/extensions/custom-provider-anthropic/index.ts
- Purpose: A complete custom provider — OAuth login, an API-key path, a custom API id, a hand-written `streamSimple` and two model definitions.
- Key abstractions: PKCE (`generatePKCE`), `loginAnthropic(callbacks)`, `refreshAnthropicToken`, the `Provider` registration.
- Data flow: `/login custom-anthropic` → `onAuth({url})` → the user pastes the code → `onPrompt` → token exchange → credentials stored by Pi → requests use the custom stream.
- Non-obvious design decisions: the client id is base64-obfuscated rather than plaintext (`:55-56`); the token expiry is shortened by 5 minutes so a refresh happens before the provider rejects it (`:126`).
- Edge cases / failure handling: n/a in the first 130 lines.
- Surprising: (partial read — first 130 of 617 lines; the remainder is the streaming implementation and the model definitions, which I did not read line by line).

### packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/index.ts
- Purpose: A provider that reuses pi-ai's built-in Anthropic and OpenAI streaming implementations behind a gateway.
- Key abstractions: `anthropicMessagesApi` / `openAIResponsesApi` from `@earendil-works/pi-ai/compat`; the exported `MODELS` array; `streamGitLabDuo`.
- Data flow: `/login gitlab-duo` → OAuth with a bundled client id → the access token goes to the AI gateway → the two backends are selected per model.
- Non-obvious design decisions: the model table is *exported* so the test script can import it (`:42-44`) — a testability seam; `DIRECT_ACCESS_TTL = 25 minutes` (`:39`).
- Edge cases / failure handling: n/a in the first 130 lines.
- Surprising: (partial read — first 130 of 405 lines; the remainder is the OAuth refresh and the stream adapter, which I did not read line by line).

### packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/test.ts
- Purpose: A standalone script that exercises the provider's stream outside Pi.
- Key abstractions: `registerApiProvider({api, stream, streamSimple})`; `streamSimple(model, context, {apiKey, maxTokens, reasoning})`.
- Data flow: read `auth.json` from the agent dir → register the API → build a `Model` → stream a one-shot prompt and print each event type.
- Non-obvious design decisions: the test reads credentials from `<agent-dir>/extensions/auth.json` and refuses to run without them (`:31-37`); it prints `thinking_delta` and `text_delta` differently so reasoning is visually distinct.
- Edge cases / failure handling: an unknown model id prints the available list and exits 1 (`:24-28`).
- Surprising: this is the only test-like file in the shard — a *manual* provider harness rather than a unit test.

### packages/coding-agent/examples/extensions/gondolin/index.ts
- Purpose: Route pi's built-in tools into a local Gondolin micro-VM while the host keeps the credentials.
- Key abstractions: `ReadOperations` / `WriteOperations` / `EditOperations` / `BashOperations` interfaces; `hostPathToGuest` / `toGuestPath` path translation.
- Data flow: the host working directory is mounted at `/workspace` in the guest; each built-in tool is re-registered with a `operations` object whose methods run in the VM.
- Non-obvious design decisions: the path translation resolves relative to the host cwd and refuses to let a guest path escape the mount — `isInsideHostPath` uses `path.relative` and checks for `..` (`:63-72`).
- Edge cases / failure handling: image mime detection is done from the *extension* by file extension in the guest, not by a `file` call (`:90-98`).
- Surprising: (partial read — first 120 of 531 lines; the remainder registers each tool, the VM lifecycle and the `!` command routing, which I did not read line by line).

### packages/coding-agent/examples/extensions/sandbox/index.ts
- Purpose: OS-level sandboxing of bash via `@anthropic-ai/sandbox-runtime` (sandbox-exec on macOS, bubblewrap on Linux).
- Key abstractions: `SandboxConfig` = `{enabled, network: {allowedDomains, deniedDomains}, filesystem: {denyRead, allowWrite, denyWrite}}`; `deepMerge`.
- Data flow: `sandbox.json` (global + project, project wins) merged over `DEFAULT_CONFIG` → the bash tool is re-registered with sandboxed `exec` → `--no-sandbox` disables it.
- Non-obvious design decisions: the default deny list is `~/.ssh`, `~/.aws`, `~/.gnupg` for reads and `.env`, `.env.*`, `*.pem`, `*.key` for writes (`:72-76`); the config merge is per-section so a project can override only `network` (`:105-114`).
- Edge cases / failure handling: an unparsable config file warns and continues (`:88-92`).
- Surprising: the header notes an alternative to overriding the tool: "you could sandbox `bash` via `tool_call` input mutation without replacing the tool" (`:9-10`).

### packages/coding-agent/examples/extensions/with-deps/index.ts
- Purpose: A 32-line extension that imports a third-party npm package (`ms`) from its own `node_modules`.
- Key abstractions: `jiti` module resolution rooted at the extension directory.
- Data flow: the model calls `parse_duration` → `ms(duration)` → the result in milliseconds.
- Non-obvious design decisions: "Tests that jiti resolves modules from the extension's own node_modules." (`:3`).
- Edge cases / failure handling: an unparsable duration throws (`:24`), which the runtime surfaces as a tool error.
- Surprising: the failure mode of packaging a dependency wrongly (a physical copy in `dependencies` instead of `peerDependencies`) is documented in `docs/packages.md:90`.

### packages/coding-agent/examples/extensions/dynamic-resources/index.ts
- Purpose: An extension that *provides* resources (a skill, a prompt template and a theme) via the `resources_discover` hook.
- Key abstractions: `pi.on("resources_discover", () => ({skillPaths, promptPaths, themePaths}))`.
- Data flow: the hook returns absolute paths resolved relative to the extension file; Pi loads them as if they were user resources.
- Non-obvious design decisions: the base directory is derived from `import.meta.url` so the extension is location-independent (`:5`).
- Edge cases / failure handling: n/a.
- Surprising: 15 lines to ship a skill, a prompt and a theme — the resource surface is data, not code.

### packages/coding-agent/examples/extensions/dynamic-resources/SKILL.md
- Purpose: A minimal skill file consumed by the `resources_discover` example.
- Key abstractions: the Agent Skills frontmatter (`name`, `description`).
- Data flow: Pi adds the skill's name and description to the system prompt at startup; the body loads on demand.
- Non-obvious design decisions: the description is "Example skill loaded from resources_discover" — a router description, not a summary of the body (`:3`).
- Edge cases / failure handling: n/a.
- Surprising: 8 lines — the file proves the skill is just a directory plus a `SKILL.md`.

### packages/coding-agent/examples/extensions/dynamic-resources/dynamic.md
- Purpose: A prompt-template file consumed by the same example.
- Key abstractions: frontmatter `description` only.
- Data flow: the file's name becomes the command name; the body is the prompt.
- Non-obvious design decisions: the body is a single instruction sentence (`:5`).
- Edge cases / failure handling: n/a.
- Surprising: 5 lines — a prompt template is a markdown file with a description.

### packages/coding-agent/examples/extensions/dynamic-resources/dynamic.json
- Purpose: A theme file provided by the same example.
- Key abstractions: the theme schema — `vars` + `colors` + `export`, with `vars` referenced by name.
- Data flow: Pi resolves the variable references, converts the colours to truecolor or 256-colour, and applies them.
- Non-obvious design decisions: the palette is a hand-tuned dark scheme (One Dark-ish) with named variables for the repeated roles (`:4-20`).
- Edge cases / failure handling: the schema rejects unknown top-level fields (`docs/themes.md:81`).
- Surprising: 81 lines of JSON buys a complete theme; the "roles not components" approach (`docs/themes.md:104`) is what keeps it that small.

### packages/coding-agent/examples/extensions/doom-overlay/index.ts
- Purpose: Run DOOM (WebAssembly) as a TUI overlay.
- Key abstractions: `ctx.ui.custom(component, {overlay:true, overlayOptions:{width:"75%", maxHeight:"95%", anchor:"center", margin:{top:1}}})`; a module-level `activeEngine` that survives between invocations.
- Data flow: `/doom-overlay` → ensure a WAD → reuse or create the engine → `ctx.ui.custom` with the overlay options → the component ticks the engine at 35 FPS.
- Non-obvious design decisions: the engine is kept at module scope "Persistent engine instance - survives between invocations" (`:17-18`), so re-running the command resumes rather than restarts.
- Edge cases / failure handling: a load failure nulls the engine and reports the error (`:67-71`).
- Surprising: 74 lines of glue around a full 3D game — the overlay API is enough.

### packages/coding-agent/examples/extensions/doom-overlay/doom-component.ts
- Purpose: Renders DOOM frames with half-block characters (▀) and 24-bit colour.
- Key abstractions: `renderHalfBlock(rgba, width, height, targetCols, targetRows)`; the 3.2:1 aspect correction.
- Data flow: every 1/35 s → `engine.tick()` → `tui.requestRender()` → `render(width)` → `getFrameRGBA()` → `renderHalfBlock` → one ANSI line per terminal row.
- Non-obvious design decisions: each terminal cell carries the top pixel as the foreground and the bottom pixel as the background of `▀` (`:39`), so 640×400 becomes 640×200 cells — the aspect ratio becomes 3.2:1 (`:105-111`).
- Edge cases / failure handling: a WASM throw (e.g. exiting via the DOOM menu) is caught and treated as a quit — `dispose()` + `onExit()` (`:75-79`).
- Surprising: `wantsKeyRelease = true` opts into key-release events for smooth movement (`:54`).

### packages/coding-agent/examples/extensions/doom-overlay/doom-engine.ts
- Purpose: A WebAssembly wrapper around doomgeneric.
- Key abstractions: the `DoomModule` type (the exported emscripten surface); `init()`, `tick()`, `getFrameRGBA()`, `pushKey()`.
- Data flow: read `doom.js` → `new Function("module","exports","__dirname","__filename","require", code)` to *bypass jiti entirely* → `createDoomModule(config)` with the WAD injected into the Emscripten FS → `_doomgeneric_Create(argv)` → tick.
- Non-obvious design decisions: the `new Function` trick is the headline — "Load WASM module - eval to bypass jiti completely" (`:61-66`); the WAD is written into the emscripten filesystem as `/doom/doom1.wad` (`:78-84`).
- Edge cases / failure handling: a missing `doom.js` throws "WASM not found… Run ./doom/build.sh first" (`:53-55`); the framebuffer is converted from ARGB to RGBA (`:150-157`).
- Surprising: the argv is built by hand in the WASM heap with `_malloc`/`setValue`/`_free` (`:102-128`) — the C API is called directly.

### packages/coding-agent/examples/extensions/doom-overlay/doom-keys.ts
- Purpose: The DOOM keycode table and the terminal→DOOM key mapping.
- Key abstractions: the `DoomKeys` constant map (ported from `doomkeys.h`); `mapKeyToDoom(data)`.
- Data flow: a terminal key event → `matchesKey` / `parseKey` → one or more DOOM keycodes → `engine.pushKey`.
- Non-obvious design decisions: the mapping accepts **both** raw characters and Kitty-protocol sequences (`data === "w" || matchesKey(data, "w")`) (`:51-58`); a shifted key pushes two codes (the movement key plus `KEY_RSHIFT`) (`:52`).
- Edge cases / failure handling: `Ctrl+C` is deliberately excluded from the "any control char = fire" rule (`:79-81`).
- Surprising: the `DoomKeys` map is declared *above* the `import` of `Key`/`matchesKey` — the file puts a runtime import after a const object, which works only because the import is hoisted.

### packages/coding-agent/examples/extensions/doom-overlay/wad-finder.ts
- Purpose: Locate or download the shareware WAD.
- Key abstractions: `findWadFile(customPath?)`; `ensureWadFile()`.
- Data flow: bundled path → default paths → download from gamers.org, gunzip, verify the `IWAD` magic, write to the bundle directory.
- Non-obvious design decisions: the download is verified — "if (wad.subarray(0, 4).toString('ascii') !== 'IWAD') throw" (`:47-49`) — a corrupt download is rejected rather than written.
- Edge cases / failure handling: any failure returns `null` and the caller reports "Failed to download DOOM WAD file" (`:52-54`).
- Surprising: the WAD is written *next to the extension* and is gitignored (`.gitignore` lists `doom1.wad`).

### packages/coding-agent/examples/extensions/doom-overlay/doom/doomgeneric_pi.c
- Purpose: The 72-line doomgeneric platform shim for Emscripten.
- Key abstractions: `DG_GetFrameBuffer`, `DG_GetScreenWidth/Height`, `DG_PushKeyEvent`; a 256-entry ring-buffer key queue.
- Data flow: JS pushes key events into the C ring buffer; JS reads the framebuffer directly.
- Non-obvious design decisions: the key queue drops events when full rather than overwriting (`:36-38`); `EMSCRIPTEN_KEEPALIVE` marks exactly the four functions JS needs.
- Edge cases / failure handling: `DG_SleepMs` is a no-op because "JS handles timing" (`:51-54`).
- Surprising: the whole platform layer is 72 lines — the framebuffer *is* the interface.

### packages/coding-agent/examples/extensions/doom-overlay/doom/build.sh
- Purpose: The Emscripten build script for the WASM module.
- Key abstractions: the `emcc` invocation with an explicit `EXPORTED_FUNCTIONS` list and `EXPORTED_RUNTIME_METHODS` (`ccall`, `cwrap`, `getValue`, `setValue`, `FS`).
- Data flow: clone doomgeneric if absent → copy the platform file in → `emcc -O2 -s WASM=1 … -o build/doom.js`.
- Non-obvious design decisions: `MODULARIZE=1` + `EXPORT_NAME=createDoomModule` so the module is a factory the extension can `await` (`:57`); `EXIT_RUNTIME=0` and `NO_EXIT_RUNTIME=1` so the WASM instance stays alive (`:61-62`); the resolution is overridable via `DOOM_RESX`/`DOOM_RESY` (`:44-45`).
- Edge cases / failure handling: `set -e` plus an explicit `emcc` presence check with Homebrew and emsdk instructions (`:14-25`).
- Surprising: ~90 C source files are listed explicitly rather than globbed, because doomgeneric has no amalgamation.

### packages/coding-agent/examples/extensions/doom-overlay/README.md
- Purpose: The DOOM overlay guide — usage, controls, rendering technique, credits.
- Key abstractions: the half-block rendering trick and the 3.2:1 aspect correction.
- Data flow: `/doom-overlay` → auto-download → overlay.
- Non-obvious design decisions: "Each frame is rendered using half-block characters (▀) with 24-bit color, where the top pixel is the foreground color and the bottom pixel is the background color." (`:33`).
- Edge cases / failure handling: "The shareware WAD file (~4MB) is auto-downloaded on first run." (`:16`).
- Surprising: the README quotes `width: "90%"` / `maxHeight: "80%"` (`:36-37`) while the code uses `75%`/`95%` (`:59-61`) — the doc and the implementation disagree.

### packages/coding-agent/examples/extensions/overlay-test.ts
- Purpose: A focused overlay test with inline text inputs inside menu items.
- Key abstractions: `Focusable`; `CURSOR_MARKER` and `renderFakeCursor()`.
- Data flow: `/overlay-test` → `ctx.ui.custom(component, {overlay:true})` → the component renders a menu whose items can contain an inline editor → Enter returns `{action, query}`.
- Non-obvious design decisions: the component declares `readonly width = 70` (`:32`) — a fixed-width overlay, so the menu does not reflow.
- Edge cases / failure handling: the edge cases exercised are "wide chars, styled text, emoji" (`:8`).
- Surprising: (partial read — first 60 of 153 lines; the remainder is the inline-editor rendering, which I did not read line by line).

### packages/coding-agent/examples/extensions/overlay-qa-tests.ts
- Purpose: A 1450-line manual QA suite for the overlay system — anchors, margins, stacking, overflow, animation, focus, streaming.
- Key abstractions: `OverlayAnchor` (9 positions), `OverlayOptions`, `OverlayHandle.setHidden()`; 13 registered commands.
- Data flow: each `/overlay-*` command opens a custom overlay with a specific configuration and lets the human judge the result.
- Non-obvious design decisions: the command list is a test *plan* expressed as slash commands (`:6-19`); the animation demo exists to "prove DOOM-like rendering works" (`:31`).
- Edge cases / failure handling: the suite covers edge-positioned overlays, width overflow with live process output, responsive side panels that hide below 100 columns, and focus cycling between multiple input panels.
- Surprising: (partial read — first 60 of 1450 lines; the remainder is 13 independent overlay scenarios, which I did not read line by line). This is the shard's only *test* artefact, and it is a human-driven one.

### packages/coding-agent/examples/extensions/snake.ts
- Purpose: A snake game with a TUI component, keyboard input and high-score persistence.
- Key abstractions: `GameState`; a `SnakeComponent` with a 100 ms tick.
- Data flow: `/snake` → the component drives the game loop with `setInterval` → `tui.requestRender()` → the board is rendered as text.
- Non-obvious design decisions: the game state is separated from the component and handed to an `onSave` callback, so it can be persisted (`:58`).
- Edge cases / failure handling: `spawnFood` loops until it finds a cell not occupied by the snake (`:43-52`).
- Surprising: (partial read — first 60 of 343 lines; the remainder is the component's rendering and input handling).

### packages/coding-agent/examples/extensions/space-invaders.ts
- Purpose: A 560-line space-invaders game using the Kitty keyboard protocol for press/release detection.
- Key abstractions: `GameState` (player, aliens, bullets, shields, level); `isKeyRelease`; a 50 ms tick.
- Data flow: the component owns the game loop; key events toggle `KeyState {left, right, fire}`; the render draws the field.
- Non-obvious design decisions: "Uses Kitty keyboard protocol for smooth movement (press/release detection)" (`:4`) — the component must distinguish a key-down from a key-up.
- Edge cases / failure handling: the alien formation reverses direction and drops at the screen edge (implied by `alienDirection`, `alienDropping`, `alienMoveCounter`).
- Surprising: (partial read — first 60 of 560 lines; the remainder is the game loop and renderer).

### packages/coding-agent/examples/extensions/github-issue-autocomplete.ts
- Purpose: `#1234` issue completion backed by the `gh` CLI, with a local fuzzy filter.
- Key abstractions: `AutocompleteProvider` / `AutocompleteItem`; `fuzzyFilter` from `@earendil-works/pi-tui`.
- Data flow: session start → `git remote -v` → parse the GitHub remote → `gh issue list` (preloaded once) → on `#` in the editor, filter locally.
- Non-obvious design decisions: the issues are preloaded **once per session** and filtered locally "for fast `#...` completion" (`:2`), so the completion never blocks on a network call; a numeric query is matched by *prefix* first and only then fuzzily (`:76-88`).
- Edge cases / failure handling: a non-git or non-GitHub directory produces a typed `RepoResolution` error rather than an exception (`:18`, `:42-61`); `MAX_ISSUES = 100` and `MAX_SUGGESTIONS = 20` bound the work.
- Surprising: (partial read — first 90 of 185 lines; the remainder is the provider registration and the trigger detection).

### packages/coding-agent/examples/extensions/claude-rules.ts
- Purpose: List a project's `.claude/rules/*.md` in the system prompt so the agent can read the relevant ones.
- Key abstractions: `findMarkdownFiles(dir)`; the `before_agent_start` hook returning a replaced `systemPrompt`.
- Data flow: `session_start` → scan the rules directory → `before_agent_start` → append a "## Project Rules" section listing the paths.
- Non-obvious design decisions: the rules are *listed*, not inlined — "The agent can then use the read tool to load specific rules when needed." (`:5-6`); the header comment gives best-practice guidance on how to organise the rules (`:8-12`).
- Edge cases / failure handling: a missing directory yields an empty list and the hook returns early (`:65-67`).
- Surprising: this is the "context file as a directory of files" pattern — the same idea as skills, applied to an existing convention.

### packages/coding-agent/examples/extensions/pirate.ts
- Purpose: Toggle "pirate mode" by appending to the system prompt.
- Key abstractions: `before_agent_start` returning `{systemPrompt: event.systemPrompt + …}`.
- Data flow: `/pirate` → flip a flag → the next run's prompt gets the pirate block appended.
- Non-obvious design decisions: the appended block still says "Still complete the actual task correctly, just in pirate speak" (`:41`) — the tone is scoped, the task is not.
- Edge cases / failure handling: the handler returns `undefined` when the mode is off, so the default prompt is untouched.
- Surprising: the pirate block is 8 lines of prose with no structured sections — a reminder that `systemPromptOptions.sections` (see `prompt-customizer.ts`) is the better mechanism when the prompt has parts.

### packages/coding-agent/examples/extensions/prompt-customizer.ts
- Purpose: Add a *named section* to the system prompt instead of replacing it.
- Key abstractions: `event.systemPromptOptions.sections` (a `Record<string, string>`); `options.selectedTools`; `options.skills`.
- Data flow: `before_agent_start` → build tool guidance from the active tool set → set `sections.tool_guidance` (or delete it when empty).
- Non-obvious design decisions: "Demonstrates using systemPromptOptions to add context-aware prompt sections without replacing or reparsing the complete rendered prompt." (`:4-5`); the section is *deleted* when there is nothing to say, so the prompt does not accumulate empty sections (`:43-47`).
- Edge cases / failure handling: the guidance is conditional on the tool actually being active, so the prompt never mentions a tool that is not declared.
- Surprising: the prompt rules are *derived from the tool set*, so the two cannot drift — a direct answer to the "prompt says `read` but `read` is disabled" class of bug.

### packages/coding-agent/examples/extensions/system-prompt-header.ts
- Purpose: Show the effective system-prompt length in the status bar.
- Key abstractions: `ctx.getSystemPrompt()`.
- Data flow: `agent_start` → measure `prompt.length` → `ctx.ui.setStatus("system-prompt", …)`; `session_shutdown` → clear it.
- Non-obvious design decisions: it reads the *effective* prompt (including changes not yet sent to the model) rather than a stored copy.
- Edge cases / failure handling: the status is cleared on shutdown so it does not linger.
- Surprising: 17 lines that answer "how big is my prompt?" — the metric August's system-prompt-size notes could also expose.

### packages/coding-agent/examples/extensions/project-trust.ts
- Purpose: Demonstrate the `project_trust` event and its result contract.
- Key abstractions: `ProjectTrustEventResult` = `{trusted: "yes" | "no" | "undecided", remember?: boolean}`.
- Data flow: a project-trusted decision is needed → the handler offers five choices → it returns a decision or `undecided` to let the built-in prompt decide.
- Non-obvious design decisions: "Multiple handlers in one extension are allowed. The first handler that returns `{ trusted: 'yes' }` or `{ trusted: 'no' }` wins and suppresses the built-in trust prompt." (`:22-25`); "Trust and remember" persists the decision, "Trust this session" does not.
- Edge cases / failure handling: without a UI the handler returns `undecided` (`:29-31`).
- Surprising: the handler can also record a note, showing that the trust decision is a place to attach project context.

### packages/coding-agent/examples/extensions/provider-payload.ts
- Purpose: Log the exact provider request payload and response headers.
- Key abstractions: the `before_provider_request` and `after_provider_response` hooks.
- Data flow: the request hook appends `JSON.stringify(event.payload, null, 2)` to `.pi/provider-payload.log`; the response hook appends the status and headers.
- Non-obvious design decisions: the same hook can **replace** the payload — the comment shows `return { ...event.payload, temperature: 0 }` (`:10-11`).
- Edge cases / failure handling: n/a (it appends synchronously and ignores errors).
- Surprising: 18 lines, and it answers the question every proxy author asks first — "what is actually on the wire?".

### packages/coding-agent/examples/extensions/qna.ts
- Purpose: Extract questions from the last assistant message and put them in the editor.
- Key abstractions: `ctx.ui.custom` with a `BorderedLoader`; `ctx.modelRegistry.complete(model, {messages}, {signal})`.
- Data flow: `/qna` → find the last *complete* assistant message on the branch → generate with a dedicated "question extractor" system prompt → `ctx.ui.setEditorText(result)`.
- Non-obvious design decisions: the extraction refuses to run against an incomplete message: "if (msg.stopReason !== 'stop') { notify(`Last assistant message incomplete (${msg.stopReason})`); return; }" (`:53-56`).
- Edge cases / failure handling: the loader's `onAbort` resolves the custom screen with `null`, and an aborted model response also yields `null` (`:76`, `:92-94`).
- Surprising: this is the "prompt generator" pattern — the model writes the *next* prompt for the user, and the human reviews it in the editor before submitting.

### packages/coding-agent/examples/extensions/summarize.ts
- Purpose: Summarise the conversation with a fixed model and show it in a transient custom screen.
- Key abstractions: `buildConversationText(entries)`; `getMarkdownTheme()`; `DynamicBorder`.
- Data flow: `/summarize` → walk the branch, extract user/assistant text and tool-call lines → prompt `openai/gpt-5.2` → render the summary as Markdown in a dismissible overlay.
- Non-obvious design decisions: the tool-call lines are rendered as `Tool <name> was called with args {…}` so the summary keeps a trace of what was done (`:62`).
- Edge cases / failure handling: the model must exist **and** have configured auth, checked separately with `hasConfiguredAuth` (`:168-171`); the summary call uses `reasoningEffort: "high"` and `cacheRetention: "none"` (`:185-186`).
- Surprising: the summary is computed from the *branch* (`ctx.sessionManager.getBranch()`), so an abandoned branch is not summarised.

### packages/coding-agent/examples/extensions/ssh.ts
- Purpose: Delegate `read`/`write`/`edit`/`bash` to a remote machine over SSH.
- Key abstractions: the `ReadOperations` / `WriteOperations` / `EditOperations` / `BashOperations` interfaces — the *pluggable* half of each built-in tool.
- Data flow: `--ssh user@host:/path` → each tool is re-registered with `operations` that shell out over SSH; local paths are rewritten to remote paths by `toRemote`.
- Non-obvious design decisions: writes are base64-encoded and piped to `base64 -d` so arbitrary content survives the shell (`:67-70`); paths are quoted with `JSON.stringify` (`:50-51`).
- Edge cases / failure handling: the bash ops honour the timeout and the abort signal, and distinguish `aborted` from `timeout:` in the rejection reason (`:106-108`).
- Surprising: (partial read — first 140 of 220 lines; the remainder registers the remaining tools and the flag handling). The important idea is the *operations interface*: a tool's behaviour is separable from its contract, so a whole tool family can be re-hosted.

### packages/coding-agent/examples/extensions/custom-provider-anthropic/.gitignore
- Purpose: One line — `node_modules/` — keeping the example's installed dependencies out of git.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: the example is a *directory* extension (its `package.json` declares `pi.extensions: ["./index.ts"]`), so it needs its own dependency root.

### packages/coding-agent/examples/extensions/custom-provider-anthropic/package.json
- Purpose: The manifest that makes the directory a loadable Pi extension with its own dependency root.
- Key abstractions: the `pi.extensions` manifest key; `dependencies` for the extension's own npm packages.
- Data flow: Pi reads the manifest, loads `./index.ts`, and resolves `@anthropic-ai/sdk` from the local `node_modules`.
- Non-obvious design decisions: the `scripts` are deliberately no-ops ("echo 'nothing to build'") so the example works in a repo with a global `npm run build` (`:6-10`).
- Edge cases / failure handling: n/a.
- Surprising: `private: true` marks it as not-publishable even though it is a perfectly good package shape.

### packages/coding-agent/examples/extensions/custom-provider-anthropic/package-lock.json
- Purpose: A 24-line lockfile pinning `@anthropic-ai/sdk` 0.52.0 (with its integrity hash and its `bin` entry).
- Key abstractions: npm lockfileVersion 3.
- Data flow: n/a (generated).
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: the lockfile's root name is `pi-extension-custom-provider` while the `package.json` says `pi-extension-custom-provider-anthropic` — the lockfile was renamed at some point and never regenerated.
- Status: **skipped as a generated file** — I read the whole 24-line file (it is small) and it is a machine-generated lockfile with one dependency; there is nothing in it to read line by line beyond what is above.

### packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/.gitignore
- Purpose: One line — `node_modules/`.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: identical to the other example `.gitignore` files — a per-extension dependency root is the convention.

### packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/package.json
- Purpose: The GitLab Duo example's manifest — same shape as the Anthropic one, with **no** dependencies.
- Key abstractions: `pi.extensions: ["./index.ts"]`; `private: true`.
- Data flow: Pi loads the extension; it uses only host-provided packages.
- Non-obvious design decisions: the absence of `dependencies` is the point — it proves an extension can be written entirely against `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`.
- Edge cases / failure handling: n/a.
- Surprising: it uses the `@earendil-works/pi-ai/compat` entry point rather than the main one.

### packages/coding-agent/examples/extensions/gondolin/.gitignore
- Purpose: One line — `node_modules/`.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: the Gondolin example is the only one with a real native dependency (QEMU + Node ≥23.6), and its `.gitignore` is still one line.

### packages/coding-agent/examples/extensions/gondolin/package.json
- Purpose: The Gondolin example's manifest, depending on `@earendil-works/gondolin` 0.12.0.
- Key abstractions: `pi.extensions`; `dependencies` for a genuinely external runtime.
- Data flow: Pi resolves the package from the local `node_modules` and the extension drives the micro-VM.
- Non-obvious design decisions: tabs rather than spaces for indentation, unlike the other example manifests — a sign it was authored separately.
- Edge cases / failure handling: n/a.
- Surprising: the version is pinned exactly (`0.12.0`), not with a caret, unlike the npm-installed package's own recommendation (`docs/packages.md:88`).

### packages/coding-agent/examples/extensions/gondolin/package-lock.json
- Purpose: A 185-line generated lockfile for the Gondolin example (it pulls in `cbor2`, `node-forge`, `@cto.af/wtf8` and others).
- Key abstractions: npm lockfileVersion 3.
- Data flow: n/a (generated).
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: the transitive dependency tree of one micro-VM client is larger than the whole extension.
- Status: **skipped as a generated file** — I read the first 30 of 185 lines (the root entry, `@cto.af/wtf8` and the `@earendil-works/gondolin` entry with its dependency list); the remaining ~155 lines are the same shape repeated for transitive packages.

### packages/coding-agent/examples/extensions/sandbox/.gitignore
- Purpose: One line — `node_modules` (no trailing slash, unlike the others).
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: the tiny inconsistency suggests the four `.gitignore` files were written by hand rather than templated.

### packages/coding-agent/examples/extensions/sandbox/package.json
- Purpose: The sandbox example's manifest, depending on `@anthropic-ai/sandbox-runtime` 0.0.26.
- Key abstractions: `pi.extensions`; `dependencies` on Anthropic's sandbox runtime.
- Data flow: Pi loads the extension; the extension drives `SandboxManager` around each bash call.
- Non-obvious design decisions: it depends on a *third-party* sandbox runtime rather than shipping its own.
- Edge cases / failure handling: n/a.
- Surprising: this is the only example that depends on an Anthropic-published package, which underlines that Pi's tool surface is provider-neutral.

### packages/coding-agent/examples/extensions/sandbox/package-lock.json
- Purpose: A 92-line generated lockfile for `@anthropic-ai/sandbox-runtime` 0.0.26 and its dependencies (`@pondwader/socks5-server`, `commander`, `lodash-es`, `shell-quote`, `zod`).
- Key abstractions: npm lockfileVersion 3.
- Data flow: n/a (generated).
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: the sandbox runtime embeds a SOCKS5 server — the network policy is enforced by a local proxy.
- Status: **skipped as a generated file** — I read the first 25 of 92 lines (the root entry and the `sandbox-runtime` entry with its dependency list); the remaining lines repeat the same shape for transitive packages.

### packages/coding-agent/examples/extensions/with-deps/.gitignore
- Purpose: One line — `node_modules/`.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: same as the others — a per-extension dependency root is the pattern.

### packages/coding-agent/examples/extensions/with-deps/package.json
- Purpose: The with-deps example's manifest, depending on `ms` 2.1.3 and `@types/ms` 2.1.0.
- Key abstractions: `pi.extensions`; `dependencies` + `devDependencies`.
- Data flow: Pi loads the extension and jiti resolves `ms` from this directory's `node_modules`.
- Non-obvious design decisions: the type package is a *dev* dependency because the extension is TypeScript but the published artefact is not.
- Edge cases / failure handling: n/a.
- Surprising: the smallest useful third-party dependency (`ms`, 1.2 kB) is enough to demonstrate module resolution.

### packages/coding-agent/examples/extensions/with-deps/package-lock.json
- Purpose: A 31-line generated lockfile for `ms` 2.1.3 and `@types/ms` 2.1.0.
- Key abstractions: npm lockfileVersion 3.
- Data flow: n/a (generated).
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: it is the smallest lockfile in the shard, and the `dev: true` marker on the types package shows the dev/prod split is preserved in the lockfile.
- Status: **skipped as a generated file** — I read the whole 31-line file; it is a machine-generated lockfile with two entries and nothing to read line by line.

### packages/coding-agent/examples/extensions/tools.ts
- Purpose: A `/tools` command that enables/disables tools interactively, with the selection **persisted per session branch**.
- Key abstractions: `ToolsState {enabledTools}` persisted as a `tools-config` custom entry; `pi.getAllTools()` → `ToolInfo`; `SettingsList` from `@earendil-works/pi-tui` with `getSettingsListTheme()`.
- Data flow: `session_start` / `session_tree` → `restoreFromBranch(ctx)` walks `ctx.sessionManager.getBranch()` for the last `tools-config` entry, filters it to tools that still exist, and calls `pi.setActiveTools(...)`; the `/tools` selector mutates the set, applies it immediately and appends a new `tools-config` entry.
- Non-obvious design decisions: the restore filters the saved names against the current catalogue — "Restore saved tool selection (filter to only tools that still exist)" (`:56-58`) — so a tool removed by a reload does not break the session; with no saved state the extension *syncs with* the currently active tools rather than assuming a default (`:61-63`).
- Edge cases / failure handling: the command is refused outside TUI mode (`:70-73`); the list is re-fetched on every invocation so tools registered late appear (`:76`).
- Surprising: the tool selection is stored in a **custom entry on the branch**, so navigating the session tree restores the tool set *at that point in history* — the same branch-aware-state pattern as `todo.ts`, but for the tool surface itself.

### packages/coding-agent/examples/extensions/confirm-destructive.ts
- Purpose: Confirm before destructive *session* actions — clearing, switching and forking.
- Key abstractions: the `session_before_switch` and `session_before_fork` hooks; `{cancel:true}` as the refusal shape.
- Data flow: `session_before_switch` → distinguish `reason === "new"` (clear) from `"resume"` (switch) → confirm; `session_before_fork` → a select with two explicit options.
- Non-obvious design decisions: the switch case checks for unsaved work by looking for *any* user-role message in the entries (`:28-31`) — a coarse but cheap "has the user typed anything" test.
- Edge cases / failure handling: `if (!ctx.hasUI) return;` — without a UI the action is allowed rather than silently blocked (`:12`, `:47`).
- Surprising: this is the *session*-level counterpart to `permission-gate.ts`: one gates tool calls, the other gates session lifecycle operations, and they use different refusal shapes (`{block:true}` vs `{cancel:true}`).

### packages/coding-agent/examples/extensions/border-status-editor.ts
- Purpose: A custom editor that draws a border carrying live status (spinner, model, thinking level, context usage, cwd, git branch).
- Key abstractions: `CustomEditor`; `fitBorder(left, right, width, border, fill)`; `ctx.getContextUsage()`.
- Data flow: `agent_start` → start an 80 ms spinner interval → `requestRender()`; the editor's `render(width)` calls `super.render(width)` and then *replaces* the first and last lines with fitted borders; `agent_settled` stops the spinner; `session_shutdown` clears it.
- Non-obvious design decisions: the border-fitting routine measures with `visibleWidth()` and truncates the right label first, then the left, so the right-hand status survives the longest (`:25-36`); the footer is replaced with an `EmptyFooter` and the built-in working indicator is hidden so the status is not duplicated (`:107-108`).
- Edge cases / failure handling: `fitBorder` handles width 0 and 1 explicitly (`:17-18`); the git branch is fetched with `pi.exec(...).catch(() => undefined)` so a non-git directory is not an error (`:113`).
- Surprising: the editor *replaces the base renderer's first and last lines* rather than drawing a frame around them — the cleanest way to add a status border to Pi's editor without reimplementing it.

### packages/coding-agent/examples/extensions/rpc-demo.ts
- Purpose: An extension that exercises every RPC-supported `ctx.ui` method, to be paired with `examples/rpc-extension-ui.ts`.
- Key abstractions: `setTitle`, `setWidget`, `setStatus`, `select`, `confirm`, `input`, `editor`, `setEditorText`, `notify`.
- Data flow: `session_start` → set the title, widget and status; `turn_start`/`turn_end` → update the status; `tool_call` → a `select` for dangerous bash; `session_before_switch` → a `confirm`; three commands → `input`, `editor`, `setEditorText`.
- Non-obvious design decisions: the dangerous-command check is duplicated here on purpose so the *RPC* path exercises the dialog round trip (`:46-66`); the `tool_call` handler blocks when there is no UI, matching the fail-closed rule.
- Edge cases / failure handling: every dialog path notifies its outcome so a client can show what happened (`:59`, `:61-62`).
- Surprising: it is the only example that deliberately exercises the *degraded* RPC mode — it is a conformance harness for the extension-UI subprotocol, not a user-facing feature.

### packages/coding-agent/examples/extensions/send-user-message.ts
- Purpose: Four commands demonstrating the difference between `pi.sendUserMessage()` and `pi.sendMessage()`.
- Key abstractions: `pi.sendUserMessage(text)` / `pi.sendUserMessage(contentBlocks, {deliverAs: "steer" | "followUp"})`; `ctx.isIdle()`.
- Data flow: `/ask` → only when idle → `pi.sendUserMessage(args)`; `/steer` → `deliverAs:"steer"` when streaming, plain send when idle; `/followup` → `deliverAs:"followUp"` when streaming; `/askwith` → a content *array* of text blocks.
- Non-obvious design decisions: the commands check `ctx.isIdle()` and *refuse* rather than guess — "Agent is busy. Use /steer or /followup instead." (`:28-31`); the streaming variants fall back to a plain send when the session is idle, so the same command works in both states (`:46-52`, `:65-70`).
- Edge cases / failure handling: `sendUserMessage` "always triggers a turn when not streaming. If streaming, it will throw (no deliverAs specified)" (`:26-27`) — the extension avoids that path by checking idle-ness first.
- Surprising: the content-array form (`:91-94`) is the only place in the shard that shows a *multi-block* user message; the custom-message form (`pi.sendMessage`) is the counterpart that carries a `customType` and `display` flag.

### packages/coding-agent/examples/extensions/file-trigger.ts
- Purpose: Let an external system push work into the agent by writing to a trigger file.
- Key abstractions: `fs.watch`; `pi.sendMessage({customType, content, display}, {triggerTurn: true})`.
- Data flow: `session_start` → `fs.watch("/tmp/agent-trigger.txt")` → on change → read the file → if non-empty, `pi.sendMessage(...)` with `triggerTurn: true` → clear the file.
- Non-obvious design decisions: `triggerTurn: true` is what makes the injected message *cause* a model turn rather than just appearing in the transcript (`:28`); the file is cleared after reading so the trigger is one-shot (`:30`).
- Edge cases / failure handling: the whole read/send is wrapped in a try/catch because "File might not exist yet" (`:32-34`).
- Surprising: this is an out-of-band injection path — the file watcher bypasses the `input` event entirely, so it is a *different* trust surface from user-typed text.

### packages/coding-agent/examples/extensions/mac-system-theme.ts
- Purpose: Keep Pi's theme in sync with the macOS system light/dark appearance.
- Key abstractions: `osascript` appearance query; `ctx.ui.setTheme(name)`.
- Data flow: `session_start` → query the appearance → `setTheme` → start a 2 s poll → on change, `setTheme` again; `session_shutdown` → clear the interval.
- Non-obvious design decisions: the poll is 2 s (`:38`) — cheap, and only a `setTheme` call when the value actually changed (`:34-37`).
- Edge cases / failure handling: a failed `osascript` returns `false` (light mode) rather than throwing (`:20-22`).
- Surprising: it is a *runtime* theme switch, whereas Pi's built-in `system` theme derives colours from the terminal — the two are different mechanisms for the same idea.

### packages/coding-agent/examples/extensions/doom-overlay/.gitignore
- Purpose: Two lines — a comment and `doom1.wad` — keeping the auto-downloaded shareware WAD out of git.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: the WAD is downloaded into the *extension directory* at runtime, so the ignore rule has to live next to the extension (`:1-2`).
- Edge cases / failure handling: n/a.
- Surprising: it is the only `.gitignore` in the shard with a comment — and it is the only one that ignores something other than `node_modules/`.

### packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.js
- Purpose: The generated Emscripten glue module for the DOOM WebAssembly build.
- Key abstractions: the `createDoomModule` factory (MODULARIZE=1, EXPORT_NAME=createDoomModule) and the exported emscripten runtime methods.
- Data flow: `doom-engine.ts:65` evaluates the file with `new Function("module","exports","__dirname","__filename","require", code)` "to bypass jiti completely", then awaits `createDoomModule(config)` with a `locateFile` that points at the sibling `doom.wasm`.
- Non-obvious design decisions: the extension deliberately avoids the extension loader's module system for the WASM glue — the comment at `doom-engine.ts:61` says so explicitly.
- Edge cases / failure handling: a missing file throws "WASM not found at … Run ./doom/build.sh first" (`doom-engine.ts:53-55`).
- Surprising: 21 lines of which one is a ~62 kB minified statement — the file size is entirely one line.
- Status: **skipped as a generated file** — I read the first 12 lines and confirmed the Emscripten `createDoomModule` factory shape; the remainder is minified machine output whose behaviour is fully determined by the `emcc` flags in `doom/build.sh:50-148` and the `DoomModule` type in `doom-engine.ts:10-25`.

### packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.wasm
- Purpose: The compiled WebAssembly binary of doomgeneric.
- Key abstractions: the four exported functions (`_doomgeneric_Create`, `_doomgeneric_Tick`, `_DG_GetFrameBuffer`, `_DG_GetScreenWidth/Height`, `_DG_PushKeyEvent`) plus `_malloc`/`_free` and the `FS` runtime methods.
- Data flow: loaded by the emscripten module created from `doom.js`; the framebuffer pointer is read with `getValue` and the key queue is written with `DG_PushKeyEvent`.
- Non-obvious design decisions: `ALLOW_MEMORY_GROWTH=1` with `INITIAL_MEMORY=33554432` (32 MB) — the module can grow, which the `DoomEngine` relies on for the 640×400 framebuffer (`doom-engine.ts:150-157`).
- Edge cases / failure handling: n/a — a WASM trap surfaces as an exception in the component, which the component treats as a quit (`doom-component.ts:75-79`).
- Surprising: 380 kB of compiled DOOM runs inside a terminal overlay at 35 FPS.
- Status: **skipped as a binary file** — I dumped its first 16 bytes and confirmed the `00 61 73 6D 01 00 00 00` WebAssembly magic and version; a compiled binary has no textual structure to read line by line, and its exported surface is enumerated in `doom/build.sh:52-53` and typed in `doom-engine.ts:10-25`.

## Ideas worth stealing

- **Omit a failed attempt from the model context with an append-only `context_edit` record, keeping the raw attempt in the transcript** — `packages/coding-agent/docs/session-format.md:141` and `packages/coding-agent/docs/compaction.md:93` — Pi's overflow/length recovery does *not* rewrite history: it persists the final assistant response, fires `turn_end`/`agent_end`, then appends a `context_edit` whose `replacement: null` omits the offending attempt from *future model context only* ("the target entry and its metadata remain unchanged in raw history, UI, exports, and session accounting"). The attempt is still visible to exports, billing and history search. **Why it matters for August:** August currently has to archive or replace history to escape a bad provider response (the `context_edit` / `transcript_archive` dance in `app/services/workbench`). A single append-only "omit this entry" row would make that operation cheap, reversible, branch-relative (navigating back to before the edit restores the original contribution) and auditable — and it removes the "archive the transcript to free context" copy that can leave the content in neither place.

- **Separate "one low-level run ended" from "nothing more will happen"** — `packages/coding-agent/docs/extensions.md:145` and `packages/coding-agent/docs/json.md:48` — `agent_end` means only that *this* run ended; retries, overflow recovery, compaction retries, steering and follow-ups can all start another run afterwards. The terminal signal is `agent_settled`. Every consumer in the docs is told to wait for `agent_settled` when it needs to know Pi will not continue. **Why it matters for August:** August's `turn_end {reason, rounds, error}` and `agent_end` are per-turn; a UI or RPC client needs an explicit "the session is idle" event distinct from "the turn ended", otherwise a client either hangs waiting or exits while a compaction retry is still pending. The same distinction tells an extension when to do notification work (`agent_settled`) versus when to add entries (`agent_before_settle`).

- **Store the prompt as a patch log of named sections, not a string** — `packages/coding-agent/docs/session-format.md:80` — "the first request of a session persists one with every prompt section and tool declaration, and later changes persist as system messages that patch `sections` by name (`null` removes one) and list `toolsAdded`/`toolsRemoved`. Replaying them in order yields the current prompt and tools; there is no separate prompt state entry." **Why it matters for August:** this gives prompt/tool changes a *tiny* persisted representation, so changing the tool set does not re-send the whole prompt, the prompt and the tool set can never drift, and a resumed session reconstructs the exact prompt state. August's `systemPromptOptions` extension point (`examples/extensions/prompt-customizer.ts:44`) is the same idea in the live path — sections addressed by name, with `null` meaning "remove".

- **Give every tool an `exposure` tier and a `reachesTools(input)` rule** — `packages/coding-agent/docs/extensions.md:265` and `packages/coding-agent/docs/extensions.md:295` — `direct` (declared + callable), `model-only` (declared, never callable by other tools), `codemode` (callable, not declared), `deferred` (callable, found by `tool_search`), `hidden` (registered but unreachable; "tools cannot be unregistered", so `hidden` is the withdrawal mechanism). A tool that reaches other tools declares *which* ones — `"all"`, or "the words of the input that may name them", evaluated against the actual arguments. **Why it matters for August:** August's `toolSurface` (full/reduced/bare) and `maxTools` are a single dial. Pi's tiers separate "the model may call it" from "another tool may call it", and `reachesTools` is *dynamic* — the same call can be allowed or denied based on its arguments, which is exactly the shape needed for "this loader tool may reach `write` only when the user asked for it".

- **Route nested tool calls through the same permission gate as model-issued calls, and keep a bounded audit trail instead of transcript entries** — `packages/coding-agent/docs/extensions.md:261` — `ctx.executeTool(name, args, {signal, onUpdate})` runs the *same* argument validation and the *same* `tool_call`/`tool_result` handlers; nested calls emit `tool_execution_*` with `parentToolCallId` and an id of `<parent id>/<n>`, never become transcript entries, and are recorded as a bounded `nestedCalls` list (name, arguments, status, duration, error; **never** results; args over 8 KiB omitted; ≤256 calls; `complete: false` when something was dropped). **Why it matters for August:** this is the answer to "does my permission gate also protect a tool that calls another tool?" — yes, and with a bounded record. August's `tool_call` guard would then cover orchestrator tools (codemode, subagents, batch operations) without a second, divergent policy.

- **Persist the state of a tool in its result `details`, and reconstruct it by scanning the active branch** — `packages/coding-agent/examples/extensions/todo.ts:118` and `packages/coding-agent/docs/extensions.md:341` — the todo list lives in the last `toolResult` message's `details` for the `todo` tool; on `session_start` the extension walks `ctx.sessionManager.getBranch()`, applies each tool result in order and ends with the correct state *for that point in history*. The docs' state table says it outright: "Reconstruct branch-sensitive state from `ctx.sessionManager.getBranch()` during `session_start`. Do not rebuild it from every file entry because abandoned branches represent alternative histories." **Why it matters for August:** August's learned skills, todos and progress are session state. Storing them in the branch (rather than in a side table) makes them automatically correct under fork, `/tree`, resume and compaction, with no separate persistence layer to keep in sync.

- **Make a summarization request a plain-text transcript, never a conversation** — `packages/coding-agent/docs/compaction.md:278` — `serializeConversation()` renders messages as `[User]: …`, `[Assistant]: …`, `[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", …)`, `[Tool result]: …` "This prevents the model from treating it as a conversation to continue." Tool results are truncated to 2000 characters during serialization, and thinking blocks are omitted entirely ("Providers return summaries of the real reasoning, and replayed thinking is often not part of the model's live context, so including it could make the summarization request larger than the context it summarizes"). **Why it matters for August:** a summarizer that receives the raw message list will continue the conversation instead of summarising it. The same serialiser is exported (`convertToLlm` + `serializeConversation`) so an extension's custom compaction is byte-comparable with the default one — and August's own summariser could reuse the same format.

- **Never cut a compaction between a tool call and its result, and split a user-message span into two summaries when the budget demands it** — `packages/coding-agent/docs/compaction.md:136` and `packages/coding-agent/docs/compaction.md:104` — "Never cut at tool results (they must stay with their tool call)"; and when a single user-message span exceeds `keepRecentTokens`, Pi cuts *inside* that span and generates two summaries (history summary + span-prefix summary) and merges them. **Why it matters for August:** August's compaction keeps a verbatim head and summarises the rest; the tool-call/result pairing rule is the invariant that keeps a summary from orphaning a `tool_result` — a shape that 400s most providers. The split-span rule is what happens when one turn is bigger than the retention budget, which August's `reliefStrategy` currently handles by rotating instead.

- **Let a compaction hook replace the summary but not the policy, and expose the *effective* settings to it** — `packages/coding-agent/examples/extensions/custom-compaction.ts:105` and `packages/coding-agent/docs/compaction.md:311` — the `session_before_compact` event hands the handler `preparation.{messagesToSummarize, turnPrefixMessages, previousSummary, fileOps, tokensBefore, firstKeptEntryId, settings}`, where `settings` is "the effective settings after applying model overrides", and the handler returns `{compaction: {summary, firstKeptEntryId, tokensBefore, usage}}` — it reuses the host's cut point and boundary. The host also owns the failure path: an exception in the hook falls back to the default compaction, and `session_compact_failed` fires with `{reason, errorMessage, aborted, willRetry, fromExtension}` so a telemetry extension can pair attempts with outcomes. **Why it matters for August:** August's five compaction paths are already documented as drifting; a single "prepare → summarise → append" seam with a fallback-on-error contract is what would let one summariser serve all of them.

- **A steering message must declare its intent; the runtime refuses to guess** — `packages/coding-agent/docs/rpc-commands.md:20` and `packages/coding-agent/docs/sdk.md:66` — "If the agent is already streaming, you must specify `streamingBehavior` to queue the message… If the agent is streaming and no `streamingBehavior` is specified, the command returns an error." Steering is delivered after the current assistant turn's tool calls finish and before the next LLM call; follow-ups wait for the agent to stop; `set_steering_mode` / `set_follow_up_mode` choose between `all` and `one-at-a-time` delivery. **Why it matters for August:** the same ambiguity exists in August's queued-message path; making the delivery class an explicit required field (and exposing a `one-at-a-time` vs `all` knob) removes a guess that currently has to be made at the wrong moment.

- **Abort returns the queued text to the editor instead of dropping it** — `packages/coding-agent/docs/rpc-commands.md:107` — `clear_queue` returns the exact text of every queued steering and follow-up message, and the documented recipe is "To implement interactive Esc behavior, send `clear_queue` before `abort`, then restore the returned text in the client editor." **Why it matters for August:** an abort that discards a half-typed correction loses user work; returning the text makes abort lossless and lets the client decide where to put it back.

- **Stream deltas, not snapshots, and let the client replace reconstructed data with the authoritative terminal block** — `packages/coding-agent/docs/json.md:72` and `packages/coding-agent/docs/json.md:93` — "Wire `message_update` records are delta-only. They omit the SDK event's cumulative `message` field and every `assistantMessageEvent.partial` snapshot so stream size remains linear." The client buffers deltas but must replace the reconstructed text with `text_end`, thinking with `thinking_end`, and tool calls with `toolcall_end`; `message_end.message` replaces the whole partial message. **Why it matters for August:** August's SSE stream should be linear in the number of events, not quadratic in the message length. The "replace with the terminal block" rule is also the fix for the classic "the transcript shows text that the final message does not contain" bug.

- **Split the JSONL framing on LF only — a generic line reader breaks on U+2028/U+2029** — `packages/coding-agent/docs/rpc.md:52` and `packages/coding-agent/docs/json.md:15` — "Do not use a generic line reader that treats Unicode line or paragraph separators as record boundaries. In particular, Node.js `readline` also splits on `U+2028` and `U+2029`, which are valid inside JSON strings." The doc's own minimal Python client uses a binary pipe reader for exactly this reason. **Why it matters for August:** any SSE/JSONL parser built on a language's line reader can split a record containing those characters, which is a rare, silent, data-corrupting bug — and the model output is exactly the place those characters appear.

- **Expose the model, provider and reasoning level to the shell as environment variables** — `packages/coding-agent/docs/environment-variables.md:22` — `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` are injected into the LLM-callable `bash`/`powershell` tools, resolved at each command start, and explicitly **not** into the user's `!` commands. The doc's guidance: "When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt." **Why it matters for August:** a ground-truth channel beats a prompt claim; a model asked "which model am I on" can run `printf '%s/%s' "$PI_PROVIDER" "$PI_MODEL"` instead of guessing from stale context. `exposeSessionEnvironment: false` also shows how to prevent a *nested* agent from seeing stale parent-session metadata.

- **Declare compatibility as named, verified differences — never as a single "compatible" switch** — `packages/coding-agent/docs/models-configuration.md:105` and `packages/coding-agent/docs/models.md:140` — the compat table is ~40 named booleans per API family (`requiresAssistantAfterToolResult`, `requiresThinkingAsText`, `supportsMidConvoSystemMessages`, `supportsMidConvoToolAdditions`, `maxTokensField`, `thinkingFormat` with 11 named values), and the rule is explicit: "Compatibility settings should describe verified differences in the endpoint's request or response behavior. Do not enable them based only on an endpoint advertising OpenAI or Anthropic compatibility." **Why it matters for August:** August already has per-model `apiFormat` and a base-URL rule ("used exactly as pasted; August only appends the API format leaf"). Pi's model is the natural next step: one named flag per *observed* difference, each with a stated default and auto-detection, instead of a growing set of format branches.

- **Send session-affinity headers so the same replica serves the same session** — `packages/coding-agent/docs/models-configuration.md:137` and `packages/coding-agent/docs/models-configuration.md:165` — `sessionAffinityFormat` chooses between `session_id` + `x-client-request-id` + `x-session-affinity` (OpenAI), `x-client-request-id` + `x-session-affinity`, or `x-session-id` (OpenRouter); `sendSessionAffinityHeaders` is "Required for providers like Fireworks that use session affinity for prompt cache routing; requests to the same replica maximize cache hits." **Why it matters for August:** August is a proxy in front of many gateways, and prompt-cache hit rate is a direct cost lever. Affinity headers are a one-line, per-provider opt-in that most gateways already understand — and they are explicitly decoupled from `prompt_cache_key`.

- **Disable prompt-cache writes for one-off summarization requests** — `packages/coding-agent/docs/compaction.md:23` — "Summarization requests disable prompt-cache writes because these one-off prompts are unlikely to be reused." **Why it matters for August:** a compaction call writes a large, never-reused prefix into the provider's cache and can evict the prefix August actually wants cached. One flag (`cacheRetention: "none"`, as used in `examples/extensions/custom-compaction.ts:85` and `handoff.ts:136`) protects the hot prefix.

- **Keep the selection (virtual model) and the dispatch (physical model) in separate records** — `packages/coding-agent/docs/virtual-models.md:18` and `packages/coding-agent/docs/virtual-models.md:77` — the session records the *selection* in `model_change` / `thinking_level_change`; each assistant message records the *dispatch* (`provider`, `api`, `model`, `thinkingLevel`). A router maps `(virtual model, virtual level)` to a physical pair per request, and the `reason` field says why the request was made: `user`, `continuation`, `retry` or `direct`. **Why it matters for August:** this is a clean way to add cost/routing policy without losing the user's chosen model in the transcript, and the `reason` field is exactly the hook a "retry on a different model" policy needs. The jev example shows the discipline: switch **once**, and accept a single prompt-cache miss (`examples/extensions/jev-router.ts:12`).

- **Make the extension factory async, wait for it, and forbid starting processes in it** — `packages/coding-agent/docs/extensions.md:56` — "The factory can be synchronous or asynchronous. Pi waits for an asynchronous factory before startup continues, allowing it to fetch configuration or register providers needed during startup." and "Do not start processes, sockets, watchers, or timers in the factory because some invocations load extensions without starting a session. Start long-lived resources from `session_start` or from the command or tool that needs them. Close session-scoped resources from an idempotent `session_shutdown` handler." **Why it matters for August:** a plugin/extension loader that starts work at import time leaks processes on every reload and on every non-session invocation. The rule is cheap to state and cheap to enforce: import = declare, `session_start` = start, `session_shutdown` = stop (idempotently).

- **A `tool_call` handler failure blocks the tool** — `packages/coding-agent/docs/extensions.md:375` — "Pi reports handler errors and continues where possible. A `tool_call` handler failure blocks the tool as a fail-safe; a tool execution failure becomes an error result for the model." The handler contract table also says "gate handlers should fail closed when their safety decision cannot be made" (`:214`), and the permission-gate example implements exactly that: without a UI it blocks rather than allows (`examples/extensions/permission-gate.ts:20-23`). **Why it matters for August:** the failure mode of a broken guard is currently ambiguous; making "the guard crashed" mean "the call does not happen" removes the class of bug where an exception in a policy hook silently allows the dangerous action.

- **A tool can end the turn** — `packages/coding-agent/docs/extensions.md:253` and `packages/coding-agent/examples/extensions/structured-output.ts:42` — returning `terminate: true` from a tool result skips the automatic follow-up LLM turn. The doc's precision matters: "only when the agent should skip its automatic follow-up **after every completed tool in that batch agrees to terminate**" — it is a *batch* property, not a per-tool one. **Why it matters for August:** a structured-output or "done" tool that currently costs an extra model turn could end the turn directly, and the batch rule is the part that prevents a half-finished batch from being cut short.

- **Serialise sibling tool calls when they share mutable state** — `packages/coding-agent/examples/extensions/tic-tac-toe.ts:10` — "Move actions share the agent cursor and have a 300ms delay. Under the default parallel tool-execution mode this races: `play` can resolve before the earlier `move_*` calls finish and O lands on the wrong cell. With `executionMode: 'sequential'` the runner serializes the sibling calls." **Why it matters for August:** a per-tool `executionMode` flag is the missing piece for August's "N tool calls in one assistant response" case — parallel is the fast path, and a tool that mutates shared state (a cursor, a file, a transaction) opts into serialisation instead of the whole turn being serial.

- **Keep a per-task output cap and put the full output in the tool details** — `packages/coding-agent/examples/extensions/subagent/index.ts:37` and `packages/coding-agent/examples/extensions/subagent/index.ts:191` — parallel subagent output is capped at 50 KiB per task for the model, with the full output preserved in `details`; the truncation notice states exactly how many bytes were omitted. **Why it matters for August:** August's bot/room runs and subagent results have the same shape — a bounded model-facing summary plus an unbounded persisted record. The `truncateHead` vs `truncateTail` distinction (`examples/extensions/truncated-tool.ts:91`) is the detail that makes it correct for search output versus command logs.

- **Spawn a subagent as a separate process with a temp-file system prompt** — `packages/coding-agent/examples/extensions/subagent/index.ts:298` and `packages/coding-agent/examples/extensions/subagent/index.ts:237` — each delegated task runs `pi --mode json -p --no-session [--model] [--thinking] [--tools] [--append-system-prompt <tmpfile>]`; the agent's system prompt is written to a temp file with mode `0600` and passed by path (not by argument, so it never appears in a process listing); the child's JSONL stream is parsed line by line to recover messages and usage. **Why it matters for August:** process isolation is the strongest context isolation available, and the "prompt by file, not by argv" trick is a small detail with a real security payoff. The abort path (SIGTERM then SIGKILL after 5 s) and the "chain stops at the first failing step" rule are both worth copying.

- **Fail soft when one file in a directory is malformed** — `packages/coding-agent/examples/extensions/subagent/agents.ts:53` — `parseToolList` accepts both YAML spellings and returns `undefined` for anything else, because "this runs inside agent discovery, where a single bad file must not take down every other agent in the same directory." Every `fs` call is individually guarded (`:65`, `:83-86`, `:109-114`). **Why it matters for August:** August's skill/hook/plugin discovery has the same blast radius; a per-file try/catch that yields "no tools" instead of an exception is the difference between one broken plugin and a dead session.

- **Give a batch of tool calls one `executionMode`, and treat the model-visible output and the persisted detail as two renderings of one state** — `packages/coding-agent/examples/extensions/tic-tac-toe.ts:41` and `examples/extensions/tic-tac-toe.ts:55` — the board state is persisted with each tool result *and* sent to the agent as `details`, but the `details` payload deliberately omits the user-side cursor: "Only the agent cursor is ever exposed to the agent." **Why it matters for August:** a `details` payload is a public surface to the model; anything private (the user's cursor, a hint, a hidden flag) must be excluded from it, and the same payload is what makes a tool's state branch-reconstructible.

- **Use `ctx.getContextUsage()` to watch the context window, and trigger on the *crossing* of a threshold, not the level** — `packages/coding-agent/examples/extensions/trigger-compact.ts:34` and `packages/coding-agent/docs/settings.md:21` — the example stores the previous reading and fires only when `previous <= threshold && current > threshold`; Pi's own cache warmer is more selective still: "Cache warming runs only when the model declares a cache lifetime and Pi estimates at least $0.05 in avoided cache-miss cost." **Why it matters for August:** a level-triggered relief action fires repeatedly while the context stays large; an edge-triggered one fires once. And a cost-denominated trigger (do not spend money to save money below a floor) is the right shape for August's budget ladder.

- **Put the tool's truncation limits in the tool's own description** — `packages/coding-agent/examples/extensions/truncated-tool.ts:53` — "Output is truncated to 2000 lines or 50.0 KB (whichever is hit first). If truncated, full output is saved to a temp file." and the notice appended to the result states how many lines and bytes were omitted and the temp path. **Why it matters for August:** a model that knows the output is bounded can plan around it, and a truncation notice that says *what* was dropped lets it decide whether to re-read the file — which is what turns a truncated result from a dead end into a recoverable one.

- **Report the program status over OSC 7501 without leaking content** — `packages/coding-agent/docs/terminal-setup.md:221` — Pi reports `working` / `blocked` / `done` / `error` / `idle`, and "Reports never contain prompts or model output. Pi sends them only after the terminal answers the protocol's support query." **Why it matters for August:** a terminal/dashboard integration that reports *state* without content is a privacy property, not a feature; the same shape (a state enum plus a session identifier) would let August's Tauri shell show "working / waiting for you / done / failed" without ever shipping a transcript to the terminal title.

- **Cache-warm and summarise with `cacheRetention: "none"` and a fresh session id** — `packages/coding-agent/examples/extensions/handoff.ts:136` and `packages/coding-agent/examples/extensions/summarize.ts:186` — every one-off model call in the examples passes `cacheRetention: "none"` and a fresh `sessionId: uuidv7()`. **Why it matters for August:** a one-shot summarisation or handoff prompt otherwise writes a large never-reused prefix into the provider cache and can evict the prefix August actually wants cached. It also keeps the one-shot call out of the session-affinity bucket that the real conversation is warming.

## Files skipped (with reasons)

Ten files are marked `skipped` in the ledger. All ten are binary or machine-generated; every one was still *opened* far enough to state what it actually is, and the reason it was not read line by line is given here.

- `packages/coding-agent/docs/images/doom-extension.png` — a 1600×1442 **binary** PNG screenshot of the DOOM overlay running inside Pi. Opened with the image reader: it shows the game composited over the live transcript (the model's answer "i asked you to do some read-only busy work for 10 turns!" is visible above the game) with Pi's status footer visible *below* it. Not read line by line because it is a binary image with no textual content.
- `packages/coding-agent/docs/images/exy.png` — a 1025×847 **binary** PNG in `docs/images/` that no page in this shard references. Opened with the image reader: an antique engraved woodcut of a porcupinefish on a transparent background. Not read line by line because it is a binary image; it is also an orphan asset.
- `packages/coding-agent/docs/images/interactive-mode.png` — a 1500×1736 **binary** PNG screenshot of the interactive TUI. Opened with the image reader: the startup header with its `[Context]` / `[Skills]` / `[Prompts]` / `[Extensions]` / `[Themes]` resource listing, a tool call, and the footer `↑14k ↓206 R1.4k CH10.3% $0.076 (sub) 9.7%/272k (auto) (openai-codex) gpt-5.6-sol • high`. Not read line by line because it is a binary image.
- `packages/coding-agent/docs/images/tree-view.png` — a 1720×1116 **binary** PNG screenshot of the session tree view. Opened with the image reader: a flattened branch with `user:` / `assistant:` / `[bash: …]` / `[read: …]` rows and an `(aborted)` assistant turn. Not read line by line because it is a binary image.
- `packages/coding-agent/examples/extensions/custom-provider-anthropic/package-lock.json` — a 24-line **generated** npm lockfile with one dependency (`@anthropic-ai/sdk` 0.52.0, with its integrity hash and `bin` entry). I read the whole file; there is nothing in it to read line by line beyond the metadata, and the only non-obvious fact is that its root package name (`pi-extension-custom-provider`) differs from the sibling `package.json`.
- `packages/coding-agent/examples/extensions/gondolin/package-lock.json` — a 185-line **generated** npm lockfile for `@earendil-works/gondolin` 0.12.0 and its transitive tree (`cbor2`, `node-forge`, `@cto.af/wtf8`, …). I read the first 30 lines (the root entry, `@cto.af/wtf8` and the Gondolin entry with its dependency list); the remaining ~155 lines are the same machine-generated shape repeated per package.
- `packages/coding-agent/examples/extensions/sandbox/package-lock.json` — a 92-line **generated** npm lockfile for `@anthropic-ai/sandbox-runtime` 0.0.26 and its dependencies (`@pondwader/socks5-server`, `commander`, `lodash-es`, `shell-quote`, `zod`). I read the first 25 lines; the rest repeats the same shape per transitive package. One observation worth keeping: the sandbox runtime embeds a SOCKS5 server, i.e. the network policy is enforced by a local proxy.
- `packages/coding-agent/examples/extensions/with-deps/package-lock.json` — a 31-line **generated** npm lockfile for `ms` 2.1.3 and `@types/ms` 2.1.0. I read the whole file; it is machine-generated dependency metadata with a `dev: true` marker on the types package and nothing further to read.
- `packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.js` — a 64 707-byte **generated** Emscripten artefact: 21 lines, of which line 8 is a single minified ~62 kB statement. I opened the first 12 lines and confirmed it is the `createDoomModule` factory (`var createDoomModule = (() => { … async function(moduleArg = {}) { … }`) produced by `emcc … -s MODULARIZE=1 -s EXPORT_NAME="createDoomModule"`, and that it is loaded by `doom-engine.ts:65` via `new Function(...)`. It was not read line by line because it is machine-generated, minified, and its behaviour is fully determined by the `emcc` flags in `doom/build.sh` and the `DoomModule` type in `doom-engine.ts:10-25`.
- `packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.wasm` — a 380 169-byte **binary** WebAssembly module. I dumped its first 16 bytes: the `00 61 73 6D 01 00 00 00` magic plus the version, i.e. a genuine WASM binary produced by the same `emcc` invocation. It was not read line by line because it is a compiled binary with no textual structure; the exported surface is enumerated in `doom/build.sh:52-53` and typed in `doom-engine.ts:10-25`.

(The manifest already carries the four PNGs and four `package-lock.json` files as `skipped-binary`/`skipped-class` with owner `-`; `doom.js` and `doom.wasm` were assigned to a numbered shard, so they are the two I had to classify myself.)

## Uncertainties

- **The manifest was re-sharded while I worked.** When I started, the manifest's `owner-shard` column used the name `coding-agent-examples-docs` for exactly 184 rows. Part-way through, the lead re-numbered the shards: the same 184 paths now belong to `packages-coding-agent-03` (24), `-04` (44), `-05` (47) and `-06` (60), and 9 of them (the four PNGs, four `package-lock.json` files and `doom.wasm`) were moved to owner `-` with `status` already set to `skipped-binary`/`skipped-class`. **What I checked:** re-imported the manifest and confirmed the union of shards 03/04/05/06 plus the 9 unassigned rows is exactly 184 rows and exactly the `packages/coding-agent/docs/*` + `packages/coding-agent/examples/*` set. I therefore kept my original 184-file set and wrote the ledger under the output filename I was given; the lead will need to re-split it across the four new shard numbers.
- **Sixteen large files were read partially, not line by line**, and each is marked in the ledger note: `examples/extensions/overlay-qa-tests.ts` (first 60 of 1450), `examples/extensions/tic-tac-toe.ts` (first 70 of 1008), `examples/extensions/snake.ts` (first 60 of 343), `examples/extensions/space-invaders.ts` (first 60 of 560), `examples/extensions/custom-provider-anthropic/index.ts` (first 130 of 617), `examples/extensions/custom-provider-gitlab-duo/index.ts` (first 130 of 405), `examples/extensions/gondolin/index.ts` (first 120 of 531), `examples/extensions/preset.ts` (first 309 of 436), `examples/extensions/question.ts` (first 80 of 286), `examples/extensions/questionnaire.ts` (first 80 of 448), `examples/extensions/minimal-mode.ts` (first 80 of 353), `examples/extensions/github-issue-autocomplete.ts` (first 90 of 185), `examples/extensions/ssh.ts` (first 140 of 220), `examples/extensions/overlay-test.ts` (first 60 of 153), `examples/rpc-extension-ui.ts` (first 110 of 661), `examples/extensions/sandbox/index.ts` (first 120 of 321). In every case the header comment and the mechanism under study were read; the unread remainder is (per the file's own structure) repeated per-tool renderers, game logic, or the provider's OAuth/stream plumbing. I could not verify, for example, the exact OAuth refresh logic in the two custom-provider examples, or the *complete* set of overlay QA scenarios.
- **The behaviour of `docs/models-configuration.md` is generated** ("This file is generated from TypeScript source. Do not edit it manually; run npm run generate:references.", `:3`). I read the generated output, not the generator, so I could not confirm whether every documented flag is exercised by a test or is documentation-only.
- **I could not establish how `agent_settled` is emitted when the process is killed rather than finished**, or the exact abort semantics of `agent_before_settle`'s `continue: true` continuation under a crash — the docs describe the contract but not the failure path.
- **`docs/extensions.md:261` describes `ctx.executeTool` as calling a tool "with `ctx.executeTool(name, args, { signal, onUpdate })`"**; I did not find, in this shard, the schema of the `nestedCalls` record's `arguments` field beyond "arguments over 8 KiB per call … are omitted" (`docs/message-types.md:189-192`), so whether the *stored* arguments are redacted or merely elided at the size threshold is not stated.
- **The `doom-overlay/README.md` and `doom-overlay/index.ts` disagree about the overlay size** (README: `width: "90%"`, `maxHeight: "80%"`; code: `width: "75%"`, `maxHeight: "95%"`). I did not determine which is current.
