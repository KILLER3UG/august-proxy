# pi / coding-agent-tests#4

## Shard shape

This shard is the **test face of pi's coding agent**: 135 files (878 KB) that live entirely under `packages/coding-agent/test/`. It has three layers that fit together as one mechanism.

1. **`test/suite/` (18 files) — the harness-based characterisation suite.** `suite/harness.ts` is the spine: it registers pi's `faux` provider, builds an in-memory `AgentSession` rooted at a throwaway temp dir, and captures every `AgentSessionEvent` into an array with an `eventsOfType()` filter. Everything else in `suite/` is a *characterisation* of one mechanism against that harness: the turn lifecycle (`agent-session-retry-events`, `agent-session-boundaries`), the two message queues (`agent-session-queue`), compaction (`agent-session-compaction`, `agent-session-compaction-model-overrides`), session replacement / fork / resume (`agent-session-runtime`), tool orchestration and nested calls (`agent-session-tool-orchestration`), MCP and MCP-OAuth (`agent-session-mcp`, `agent-session-mcp-oauth`), codemode (`agent-session-codemode`), virtual model routing (`suite/virtual-models`), and the input boundaries (`lax-message-content`).
2. **`test/suite/regressions/` (84 files) — one issue number per file.** Every file is a small, self-contained pin for a numbered GitHub issue, almost all of them asserting that a *specific* behaviour is not lost again. They are the closest thing pi has to a design record: the file name says what broke, and the assertion says what the correct behaviour is.
3. **`test/*.test.ts` + helpers (33 files) — the legacy surface.** The older `test-harness.ts` (faux stream with token-level deltas), the built-in coding tools (`tools.test.ts`), the system prompt (`system-prompt.test.ts`, `system-prompt-updates.test.ts`), the TUI components (themes, selectors, tree, tool execution) and the shared helpers (`utilities.ts`).

The two layers are joined by `suite/README.md`, which states the rules explicitly: use `suite/harness.ts` and the faux provider, never a real provider API or a network call, keep the tests CI-safe and deterministic, and do not extend the legacy `test-harness.ts` path unless a missing capability forces it. Two harness generations therefore coexist: `test/suite/harness.ts` (faux provider registered through `pi-ai/compat`, in-memory settings/auth, extension factories) and the older `test/test-harness.ts` (a hand-rolled faux stream function that replays token-level deltas).

The shard is worth reading for one reason above all: **pi's test suite is the specification of its agent loop.** The mechanism is not described in a doc; it is pinned by an assertion, and the assertion's *wording* is the design decision (for example `packages/coding-agent/test/suite/agent-session-queue.test.ts:453-455` refuses to queue an extension command and names the two legal alternatives in the same sentence).

**Note on the manifest.** The manifest at `docs/research/pi/manifest.tsv` was re-cut mid-session into a different shard-naming scheme (`packages-coding-agent-NN`, `repo-root-01`, …) and no longer contains the string `coding-agent-tests`. I recovered the authoritative row set for this shard from the **committed** manifest (`bc531b2e:docs/research/pi/manifest.tsv`), where `coding-agent-tests#4` is exactly these 135 rows. I did not modify the manifest.

---

## Per-file notes

### packages/coding-agent/test/suite/harness.ts
- **Purpose:** The shared harness for the new suite — one call (`createHarness(options)`) returns a fully wired in-memory `AgentSession` plus the fake provider and an event log.
- **Key abstractions:** `HarnessOptions` (provider, models, settings, tools, active/allowed/excluded tool names, resource loader, extension factories, `withConfiguredAuth`, `modelsJson`, `sessionManager`), `Harness` (session, sessionManager, settingsManager, authStorage, faux, models, `setResponses`/`appendResponses`/`getPendingResponseCount`, `events`, `eventsOfType`, tempDir, cleanup).
- **Data flow:** `registerFauxProvider` → `fauxProvider.setResponses([])` → `AuthStorage.inMemory()` + `authStorage.modify(...)` → `createModelRegistry`/`createInMemoryModelRegistry` → `modelRegistry.registerProvider(...)` → `new Agent({ getApiKey, streamFn: streamSimple, initialState, convertToLlm, onPayload, onResponse, transformContext })` → `new AgentSession({...})` → `session.subscribe(e => events.push(e))`.
- **Non-obvious design decisions:** the Agent is constructed with `systemPrompt: ""` and `tools: []` so the *session* owns the prompt and the tool set; `onPayload`/`onResponse`/`transformContext` are wired to the extension runner **through a ref** (`extensionRunnerRef.current`) because the runner does not exist yet when the Agent is built — the ref is passed *into* `AgentSession` so the session can fill it later.
- **Edge cases / failure handling:** `withConfiguredAuth: false` yields a session whose `setModel` throws `No API key for <provider>/<model>` and whose `compact()` throws `No API key found for <provider>.`; `cleanup()` disposes the session, unregisters the faux provider and removes the temp dir.
- **Surprising:** `createTestUiContext()` returns a **complete no-op `ExtensionUIContext`** with a `get theme()` live getter and `setTheme` that returns `{ success: false, error: "Theme switching not available in tests" }` — the harness deliberately implements the whole interface so an extension under test cannot crash on a missing method.

### packages/coding-agent/test/suite/README.md
One specific line: the rules of the new suite — use `test/suite/harness.ts`, use the faux provider from `packages/ai/src/providers/faux.ts`, **no real provider APIs, real API keys, network calls or paid tokens**, keep the tests CI-safe and deterministic, and do not extend the legacy `test/test-harness.ts` path unless a missing capability forces it.

### packages/coding-agent/test/suite/agent-session-retry-events.test.ts
- **Purpose:** The canonical statement of the agent loop's event sequence and its retry policy.
- **Key abstractions:** `normalizeEventOrder(events)` collapses consecutive `message_update` events so the *shape* of the loop can be asserted.
- **Data flow:** `settings.retry = { enabled, maxRetries, baseDelayMs }` → the faux provider returns a response with `stopReason: "error"` → the session retries → `auto_retry_start { attempt }` / `auto_retry_end { success }` → `agent_end { willRetry }`.
- **Non-obvious design decisions:** the pinned event order is `agent_start → turn_start → message_start(system) → message_end(system) → message_start(user) → message_end(user) → message_start(assistant) → message_update → message_end(assistant) → turn_end → agent_end → agent_settled` (`:276-289`), and a tool-call turn inserts `tool_execution_start/end` + `message_start/end(toolResult)` and a **second** `turn_start`/`turn_end` pair (`:315-337`). So a *turn* is not a turn of the conversation — it is one provider round-trip.
- **Edge cases / failure handling:** aborting after a failed retry attempt resets `retryAttempt` to 0 and the terminal `auto_retry_end` carries `finalError: "Retry cancelled"` (`:93-99`); `abortRetry()` cancels the backoff sleep; a non-retryable error (`invalid_api_key`) produces **no** `auto_retry_start` at all (`:161-170`).
- **Surprising:** extension handlers fire **before** public subscribers for every event (`:253-266`) — the extension surface is not a subscriber of the public surface, it is in front of it.

### packages/coding-agent/test/suite/agent-session-queue.test.ts
- **Purpose:** The two-message-queue contract: *steer* (delivered before the next LLM call) and *follow-up* (delivered only after the current run finishes).
- **Key abstractions:** `createWaitingHarness()` returns a harness whose `wait` tool blocks until released — the mechanism for pinning "during streaming".
- **Data flow:** `session.steer(text)` / `session.followUp(text)` / `session.sendCustomMessage(msg, { deliverAs: "steer"|"followUp"|"nextTurn" })` → the agent's queue → the next provider request's message list.
- **Non-obvious design decisions:** the two queues are **separate** and the mode is per-queue: `setSteeringMode("all")` batches every queued steer into one request, while the default "one at a time" mode delivers them one per turn (`:206-252`). `deliverAs: "nextTurn"` is a third behaviour — the custom message is injected into the *next* prompt even when idle (`:376-407`).
- **Edge cases / failure handling:** `pendingMessageCount` is already decremented **when `message_start` fires** (`:436`), so a UI that reads the counter inside a message handler sees 0, not 1. Queueing an *extension command* with steer/followUp **throws**, and the message names the legal alternatives: `Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.` (`:453-455`).
- **Surprising:** a follow-up queued from an `agent_end` handler is still delivered (`:476-497`), so the run does not end before the queue is drained.

### packages/coding-agent/test/suite/agent-session-boundaries.test.ts
- **Purpose:** The "actionable boundary" contract — the seam where an extension may rewrite the transcript *after* a turn ends.
- **Key abstractions:** the `turn_end` handler may return `{ entries, continue: true }`, where an entry is a `compaction`, a `context_edit` (`targetId` + `replacement`, `null` = omit) or a `custom`/`custom_message`; the `agent_before_settle` handler may return the same shape to continue *before* final settlement.
- **Data flow:** turn ends → `turn_end` handler returns replacement entries → the session commits them to the branch → the next provider request is built from the **edited** projection → `continue: true` starts another round.
- **Non-obvious design decisions:** the boundary is *verifiable* — the replacement instruction `EXACT-REPLACEMENT-INSTRUCTION `×100 survives a threshold compaction **verbatim** (`:128-180`), and a boundary-omitted assistant's usage figure must **not** trigger compaction (`:506-539`). That is, compaction decisions are computed from the *post-boundary* context, not from what the provider reported before the edit.
- **Edge cases / failure handling:** a retained pre-compaction assistant's usage is not "post-compaction usage" (`:617-627`); an invalid explicit continuation (one that would delete the tool result too) does not suppress the natural tool continuation (`:439-477`); an abort during the `agent_before_settle` hook still commits the drafts but suppresses the continuation and reports `agent_settled { aborted: true }` (`:705-737`).
- **Surprising:** the "durable length recovery" block (`:740-1063`) makes a *length* stop a first-class recovery path: the truncated assistant and its tool call are **omitted from the next request** (a `context_edit` with `replacement: null`) rather than replayed, the recovery is attempted **once** per turn, and a *distinct* queued follow-up gets its own recovery budget (`:829-875`).

### packages/coding-agent/test/suite/agent-session-compaction.test.ts
- **Purpose:** The compaction contract — what is summarised, what is kept, what the summariser is allowed to see, and how failures are reported.
- **Key abstractions:** `session_before_compact` returns a `compaction` object (`summary`, `firstKeptEntryId`, `tokensBefore`, `usage`, `details`) or `{ cancel: true }`; the session emits `compaction_start { reason }` / `compaction_end { reason, aborted, willRetry, result, errorMessage }` where `reason` is `manual | threshold | overflow`.
- **Data flow:** history → `buildSessionContext()` → split into "summarise" and "keep" → summariser request → summary becomes a `compactionSummary` message → session stats and the persisted `compaction` entry carry the summary's own usage.
- **Non-obvious design decisions:** **the summarisation request is a standalone context, not the conversation's context** (`:337-364`): `transformContext` is *not* called, `getCurrentTools()` is empty, `cacheRetention` is `"none"`, `sessionId` differs from the active one and `transport` is undefined — so the summariser cannot pollute the prompt cache the next turn depends on, and cannot be routed as if it were the user's turn. The request body is framed by a `# Conversation` markdown boundary (regression #9652). System state is **checkpointed**: the summarised and retained system patches are folded into one checkpoint system message, and the tool list is recomputed from the live tool set minus the removed tools (`:189-236`).
- **Edge cases / failure handling:** overflow recovery is attempted **exactly once**; a second overflow reports `Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.` (`:707-733`, `:805-829`). A length stop that reached the model's `maxTokens` is **not** an overflow (`:662-673`). An error response uses the **last successful** assistant's usage for the threshold decision (`:900-926`), and pre-compaction usage is ignored (`:862-898`).
- **Surprising:** compaction never runs after a *terminating* tool result (`:617-660`) — a tool that ends the turn also ends the compaction check.

### packages/coding-agent/test/suite/agent-session-compaction-model-overrides.test.ts
- **Purpose:** Per-model compaction policy — `settings.compaction.modelOverrides["<provider>/<model>"]` overrides the global `reserveTokens`/`keepRecentTokens`.
- **Key abstractions:** the override key is `<provider>/<modelId>`; the merged object `{ enabled, reserveTokens, keepRecentTokens }` is what the session hands to `session_before_compact`.
- **Data flow:** `settings.compaction.modelOverrides` → resolved against the **active model** → `preparation.settings` → extension → `compaction_end`.
- **Non-obvious design decisions:** the override applies to *all four* paths (manual / pre-prompt / post-run / overflow) with one rule (`:36-103`) — a per-model policy that only worked on the manual path would be a trap. Switching models does **not** rewrite the global settings: `getCompactionReserveTokens()` stays 10 (`:141-143`).
- **Edge cases / failure handling:** the model identity is captured **before** awaiting summarisation auth (`:146-174`) — if the model changes during the auth round-trip, the summariser still runs on the model the compaction was planned for.
- **Surprising:** the *session's* usage is deliberately retained across a model switch (`:135-136`) so the "have we outgrown the window?" check cannot be defeated by switching to a bigger model and back.

### packages/coding-agent/test/suite/agent-session-runtime.test.ts
- **Purpose:** The `AgentSessionRuntime` — the layer that owns *which session is current* (new / resume / fork / switch) and the lifecycle events around it.
- **Key abstractions:** `createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager })`, `runtime.newSession()`, `runtime.switchSession(file)`, `runtime.fork(entryId, { position })`, `runtime.importFromJsonl(path)`; each returns `{ cancelled }`.
- **Data flow:** `session_before_switch` / `session_before_fork` → `session_shutdown` → the new session is built → `session_start` → the caller must `bindExtensions()` on the new session.
- **Non-obvious design decisions:** **the outgoing session is settled before it is replaced** (`:166-214`): an interrupted tool call gets a *persisted* tool result in the old session file rather than dangling. A fork duplicates the *active branch*, not the whole session.
- **Edge cases / failure handling:** importing a file whose name collides with a stored session **never overwrites** it (`:216-247`). Forking a session that has never been saved rejects with `This session has not been saved yet. Send a message before cloning or forking it.` (`:378-389`). `session_before_switch` can cancel a new/resume (`:294-327`).
- **Surprising:** a cross-cwd `switchSession` updates both the session's cwd *and* the runtime's (`:548-618`), and the destination session restores **its own** model and thinking level (`:620-693`).

### packages/coding-agent/test/suite/agent-session-model-extension.test.ts
- **Purpose:** Model selection, thinking level, and the four extension hooks that may rewrite a turn (`tool_call`, `tool_result`, `context`, `input`) plus `before_agent_start`.
- **Key abstractions:** `setModel(model, { persist })`, `setThinkingLevel(level, { persist })`, `cycleModel()`, `cycleThinkingLevel()`, `getAvailableThinkingLevels()`.
- **Data flow:** `setModel` → `model_select { previousModel, model, source }` → a `model_change` entry on the branch → the session's active model.
- **Non-obvious design decisions:** **defaults are session-only unless `persist: true`** (`:56-79`) — `cycleModel` and `cycleThinkingLevel` never write the user's settings. The persisted thinking level survives the model's own clamp (`:81-89`: you can persist `"max"` while the model only supports `"high"`), and a per-model override beats the global default (`:156-173`).
- **Edge cases / failure handling:** `setModel` without configured auth rejects with `No API key for <provider>/<model>` (`:239-241`). `tool_call` handlers may **block** execution, and the blocked result is an error tool result carrying the reason (`:244-284`). A `tool_result` handler may replace content, details **and usage** (`:286-359`).
- **Surprising:** a `context` handler's rewrite applies to the **provider request only** — the stored transcript keeps the original user text (`:361-399`). And `bindExtensions` emits `session_start`, `reload` emits `session_shutdown` then `session_start` (`:509-529`).

### packages/coding-agent/test/suite/agent-session-prompt.test.ts
- **Purpose:** The prompt entry point — what `prompt()`, `sendUserMessage()` and `sendCustomMessage()` do, and what they refuse.
- **Key abstractions:** `prompt(text, { images, source, streamingBehavior, preflightResult })`; `sendUserMessage(text, { deliverAs, expandPromptTemplates })`; `sendCustomMessage(msg, { deliverAs, triggerTurn })`.
- **Data flow:** prompt text → skill/prompt-template expansion → image normalisation (using the model's `inputLimits`) → provider request → response.
- **Non-obvious design decisions:** image normalisation uses the model **chosen by `before_agent_start`**, not the model that was active when the prompt was composed (`:169-204`) — a strict model with a smaller resize budget must win.
- **Edge cases / failure handling:** a prompt during streaming without `streamingBehavior` rejects with `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`; a prompt during manual compaction rejects with `Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.` (`:503-547`). Extension commands are dispatched **without** consuming a provider response (`:319-341`).
- **Surprising:** a run started by `sendCustomMessage({ triggerTurn: true })` must keep **one** system prompt for every request of the run (`:569-613`); a second custom message queued while `before_agent_start` is still running is **joined to the starting run** rather than starting a second one (`:615-660`).

### packages/coding-agent/test/suite/agent-session-tool-orchestration.test.ts
- **Purpose:** Tools that call tools — the "orchestrator" pattern, and the exposure/progressive-disclosure machinery around it.
- **Key abstractions:** `exposure: "codemode" | "model-only"`, `prepareLoadout(loadout) => { descriptions, hiddenDeclarations }`, `ctx.executeTool(name, args)`.
- **Data flow:** the model calls `run_tools` → its `execute` calls `ctx.executeTool("helper")` etc. → each nested call emits its own `tool_call` event with `parentToolCallId` → the nested results are recorded in `nestedCalls` and persisted with the session.
- **Non-obvious design decisions:** a tool that is *active* but whose **declaration is hidden** is left out of the request while staying callable — progressive disclosure in the *prompt* dimension, independent of enablement (`:78-95`). `prepareLoadout` can rewrite the description of the orchestrator itself to name the tools it can reach (`:80-82`).
- **Edge cases / failure handling:** a recursive self-call **fails** rather than looping: `Tool run_tools not found` (`:100`).
- **Surprising:** `codemode` and `tool_search` are registered but **inactive** until they are named (`--tools`, the `defaultTools` setting, or `initialActiveToolNames`) (`:115-131`).

### packages/coding-agent/test/suite/agent-session-codemode.test.ts
- **Purpose:** The codemode tool — a sandboxed script that calls the other tools.
- **Key abstractions:** `codemode.mode` (`on` | `only`), `codemode.inlineBudget`, `describeTool()`, `searchTools()`, `store()`, `image()`.
- **Data flow:** the script calls `tools.<name>(args)` → nested tool executions → the script's own output plus the nested usage and images become the tool result.
- **Non-obvious design decisions:** in `mode: "on"` a declared tool says how the script calls it and is **not** listed again inside the codemode description; in `mode: "only"` the codemode description carries the catalogue and the tool is left out of the request (`:141-185`). Hidden tools' guidelines move out of the rules and into their codemode section (#10343). The description budget is filled **round-robin, cheapest first**, and says what is missing.
- **Edge cases / failure handling:** a script that fails is a **result** that keeps the partial output and the calls that ran (`:420`), not an exception; the memory limit makes a runaway allocation fail *inside* the script (`:510`); output is truncated to the token budget and the full text is spilled to a file (`:523`).
- **Surprising:** `store()` writes are persisted as **custom entries on the branch**, so a later call on the same branch sees them and a different branch does not (`:600-663`).

### packages/coding-agent/test/suite/agent-session-mcp.test.ts
- **Purpose:** MCP integration — exposure, filtering, deferral and the server-listing prompt section.
- **Key abstractions:** `exposure` (`direct` | `codemode` | `deferred`) per server and per tool, `MCP_SERVERS_SECTION`, `createMcpToolName`.
- **Data flow:** the MCP extension connects the servers → the tools are declared into the session's tool set → `tool_search` defers them → the model asks for one → the server is connected on demand.
- **Non-obvious design decisions:** a **codemode-only** MCP tool is *not* offered to the model but *is* callable from a script, and a direct model call to it is refused (`:427`); `--tools` that names no MCP tool **keeps** the MCP tools, while `--exclude-tools` removes them (`:231-324`).
- **Edge cases / failure handling:** the first prompt waits for servers with **direct** tools, but only up to `startupWaitMs` (`:905-924`); a server that never connects is listed anyway and its summary is appended with the next prompt (`:790-810`).
- **Surprising:** servers whose script identifiers differ from their names (hyphens vs underscores) are still matched (`:855`), and a tool `tool_search` loaded on a branch is **re-declared** after a resume or a `/reload` (`:1207-1270`).

### packages/coding-agent/test/suite/agent-session-mcp-oauth.test.ts
- **Purpose:** The MCP OAuth flow — browser sign-in, refresh, sign-out, the pasted-redirect fallback, and the interaction with shutdown.
- **Key abstractions:** `McpOAuthCredentialStore`, `runMcpCommand(["login", server, "--timeout", s])`, the `session_before_compact`-style `session_shutdown` event.
- **Data flow:** `/mcp login <server>` → the authorization server → the loopback callback → a token in the credential store → the MCP client reconnects.
- **Non-obvious design decisions:** a token that is *past* its expiry is refreshed **before** the request, without a 401 round trip (`:107-114`); a token that merely *looks* expired is refreshed after the 401 (`:103-105`). Both paths must reach the same state.
- **Edge cases / failure handling:** session shutdown **cancels** a sign-in that is waiting on the authorization server, and the request is destroyed rather than left open (`:140-154`); closing the session does **not** refresh an expiring token (`:157-172`); `pi mcp login --timeout` gives up even while the authorization server hangs (`:220-249`).
- **Surprising:** a client name is registered as `native` with `application_type: "native"` by default, because OpenID Connect servers reject the loopback redirect of a `web` client (#10493) (`:194-206`).

### packages/coding-agent/test/suite/agent-session-bash-persistence.test.ts
- **Purpose:** How bash output enters the transcript — immediately when idle, deferred when the agent is streaming.
- **Key abstractions:** `recordBashResult(command, { output, exitCode, cancelled, truncated })`, `hasPendingBashMessages`, `isBashRunning`, `executeBash(cmd, onDelta, { operations, id })`, `abortBash()`.
- **Data flow:** the shell streams chunks → `onData` → the callback and the `bash_execution_update` event → on settle, a `bashExecution` message is appended to the transcript.
- **Non-obvious design decisions:** while the agent is streaming, a bash result is **deferred** (`:56-114`) so the tool result cannot land between an assistant message and its tool call; it is flushed before the next prompt.
- **Edge cases / failure handling:** `abortBash()` cancels *all* active executions (`:178-197`); an older execution settling does not clear the "running" state of a newer one (`:153-176`); a `bashExecution` message emits **no** `message_end` event (`:245-263`).
- **Surprising:** the ANSI/OSC stripper is a **streaming** state machine — a colour reset split inside its parameters, a colour code split right after ESC, an OSC sequence split before its terminator and an incomplete multi-byte character at the end of the output are each handled (`:342-398`), and a long unterminated sequence does **not** hold the output back.

### packages/coding-agent/test/suite/agent-session-tool-result-images.test.ts
- **Purpose:** Pins that the tool-result image normaliser receives both the image settings **and the active model's resize profile**.
- **Key abstractions:** `normalizeToolResultImages(content, { autoResizeImages, resizeOptions })`.
- **Data flow:** tool result → normaliser → resized/converted images + a note.
- **Non-obvious design decisions:** the resize options come from `model.inputLimits.images.resize`, so **the model decides the budget**, not a global setting (`:37-57`).
- **Edge cases / failure handling:** `autoResize: false` in the settings is passed through unchanged (`:51`).
- **Surprising:** the normalisation call is mocked and asserted on the *arguments*, so a future change that drops the model's profile would fail here rather than silently produce huge images.

### packages/coding-agent/test/suite/lax-message-content.test.ts
- **Purpose:** The ingestion contract — pi is deliberately lax about `content` at the boundaries and normalises it there.
- **Key abstractions:** `sessionEntryToContextMessages(entry)`.
- **Data flow:** an untyped JS extension tool, a `message_end` replacement, a custom message, or a hand-edited session file → null/missing `content` → `[]`.
- **Non-obvious design decisions:** the header comment states the rule and the reason (issues #6259, #6276): the *types* require `content`, but untyped JS extensions, hand-built histories and old session files violate it, and the normalisation happens at the **ingestion** boundary so it never reaches rendering, compaction or provider conversion.
- **Edge cases / failure handling:** the normalisation covers four distinct doors — tool result without content, `message_end` replacement with `content: null`, custom message with `content: null`, and a session entry loaded from disk.
- **Surprising:** valid content is left **exactly** as it was — `"hello"` stays a string, not `[{"type":"text","text":"hello"}]` (`:156-161`).

### packages/coding-agent/test/suite/virtual-models.test.ts
- **Purpose:** Virtual models — a router that maps a stable user-facing selection onto a physical model per request.
- **Key abstractions:** `registerVirtualModel({ provider, id, name, thinkingLevels, contextWindow, route(request, ctx) })`; `ModelRouteRequest { reason: "user"|"retry"|"continuation"|"direct", thinkingLevel, previous, failed, state }`.
- **Data flow:** the session's selected model is the virtual one → each provider request is routed → the physical model answers → the response records the physical model.
- **Non-obvious design decisions:** the **route reason** is explicit (`user` for a new human turn, `retry` for an automatic retry, `continuation` for a tool-loop continuation, `direct` for an explicit request) so a router can treat them differently (`:92`, `:117-123`). The request carries both `previous` (the last successful) and `failed` (the failed attempt), so a retry can be routed to the model that *did* work (`:93-94`, `:119-120`).
- **Edge cases / failure handling:** a router that throws ends the run with an **error response that names the virtual model** (`:205-215`); the compaction threshold is evaluated against the **physical** model that produced the last response, not against the virtual model's declared window (`:99`, `:217-226`).
- **Surprising:** the router's own state is persisted **on the branch** as a custom entry and survives a compaction (`:305-344`), and a compaction an extension supplies is **not** routed (`:346-369`).

### packages/coding-agent/test/suite/mcp-oauth-server.ts
- **Purpose:** A test MCP server that also *is* an OAuth authorization server.
- **Key abstractions:** `startOAuthMcpServer({ iss, issParameter, cimd, redirectPath })` returning `{ url, log, registrations, authorizations, tokenRequests, deletes, stall, stalled, expireAccessTokens, close }`.
- **Data flow:** `initialize` → `tools/list` → `tools/call`; DCR at `/register`, authorization at `/authorize` (PKCE S256), token at `/token` (code + refresh).
- **Non-obvious design decisions:** the `stall` set accepts requests and **never answers them** (`:88-91`) — that is how the "the authorization server hangs" and "the session shuts down mid-sign-in" cases are produced without a timeout.
- **Edge cases / failure handling:** a mismatched `redirectPath` reproduces a mixed-up authorization server; `iss` is emitted per RFC 9207 and `issParameter` advertises it; the MCP endpoint assigns a session id so closing the connection sends a DELETE (the test asserts `server.deletes`).
- **Surprising:** the server's `log` is the assertion surface: `["401 none", "register", "token code"]` is the exact sequence a correct sign-in must produce (`:97`).

### packages/coding-agent/test/suite/regressions/10285-mcp-tool-renderers.test.ts
A resumed session renders an MCP tool call **before its server has connected** (or ever will) — with the MCP renderer, not the expanded fallback — and the same holds in the HTML export (`:15-36`).

### packages/coding-agent/test/suite/regressions/11156-pi-ai-models-virtual-module.test.ts
The `@earendil-works/pi-ai/models` subpath must be present in the extension virtual-module map (an extension importing it for `clampThinkingLevel` failed with "Cannot find module" in embedded runtimes), and the legacy `@mariozechner/pi-ai/models` scope must resolve to the *same module object*.

### packages/coding-agent/test/suite/regressions/11227-recovery-omits-tool-results.test.ts
Pre-prompt recovery of a resumed **length stop** omits the truncated tool call **and its result** together: the next request contains no `toolResult` and no `stopReason: "length"` assistant — an orphaned `tool_use_id` would brick the chat.

### packages/coding-agent/test/suite/regressions/1717-2113-agent-session-event-settlement.test.ts
A slow extension `message_end` handler must not reorder the persisted assistant/toolResult messages, and the `tool_call` hook must run only after the assistant tool-use message is already settled in the session (the branch reads `["system","user","assistant"]` at that point).

### packages/coding-agent/test/suite/regressions/2023-queued-slash-command-followup.test.ts
A slash-command follow-up that came from an **extension** is delivered as raw user text — the command is *not* dispatched — because the command surface is only for direct prompts.

### packages/coding-agent/test/suite/regressions/2753-reload-stale-resource-settings.test.ts
After `/reload` the **settings** are re-read: a prompt template that a newly written `settings.json` excludes is gone from the session, so a reload cannot keep stale resource settings.

### packages/coding-agent/test/suite/regressions/2781-skill-collision-precedence.test.ts
Skill-name collisions resolve **project > user > package**, and the collision diagnostic names the package skill as the loser.

### packages/coding-agent/test/suite/regressions/2791-fswatch-error-crash.test.ts
`fs.watch()` must carry an `error` listener: the test spawns a child, finds the `FSWatcher` among `process._getActiveHandles()` and emits a synthetic error — an unhandled `'error'` event on an EventEmitter terminates the process.

### packages/coding-agent/test/suite/regressions/2835-tools-allowlist-filters-extension-tools.test.ts
A tool **allowlist** filters extension tools as well as built-ins, and an empty allowlist renders literally `<tools>\n(none)\n` in the prompt.

### packages/coding-agent/test/suite/regressions/2860-replaced-session-context.test.ts
On session replacement the extensions are rebound **before** `withSession` runs, the callback receives the *replacement* context, and a captured old `ctx`/`pi` **throws** rather than silently addressing a dead session.

### packages/coding-agent/test/suite/regressions/3217-scoped-model-order.test.ts
Reordering the scoped model list is propagated back to the session state, and the `/model` scoped tab renders the models in the session's order.

### packages/coding-agent/test/suite/regressions/3302-find-path-glob.test.ts
The `find` tool must switch `fd` into full-path mode when the glob contains a `/`; otherwise every directory-prefixed pattern (e.g. `src/**/*.spec.ts`) silently matched **nothing**.

### packages/coding-agent/test/suite/regressions/3303-find-nested-gitignore.test.ts
Each `.gitignore` applies to **its own subtree** only — collecting every `.gitignore` into one `--ignore-file` leaks a sibling directory's rules into it.

### packages/coding-agent/test/suite/regressions/3317-network-connection-lost-retry.test.ts
A transient `Network connection lost.` provider error is retried, and `auto_retry_start` carries the provider's message verbatim.

### packages/coding-agent/test/suite/regressions/3592-no-builtin-tools-keeps-extension-tools.test.ts
`noTools: "builtin"` disables the built-in tools but leaves **extension tools active**; `noTools: "all"` disables everything. The tool surface is not one list.

### packages/coding-agent/test/suite/regressions/3616-settings-inmemory-reload.test.ts
Settings supplied **in memory** survive a direct reload, a `DefaultResourceLoader` reload, and an unrelated setter + `flush()` + reload cycle.

### packages/coding-agent/test/suite/regressions/3686-session-name-event.test.ts
`setSessionName` emits `session_info_changed` — from the session API and from the extension API — and extensions receive the event too.

### packages/coding-agent/test/suite/regressions/3688-tree-cancel-compacting.test.ts
When `session_before_tree` cancels navigation, the branch-summary/compacting state is cleared and the active leaf does not move.

### packages/coding-agent/test/suite/regressions/3982-message-end-cost-override.test.ts
An extension's `message_end` handler may replace the **finalised** assistant usage cost, and the override is visible both in the session message and in the `message_end` event.

### packages/coding-agent/test/suite/regressions/4167-thinking-toggle-pending-tool-render.test.ts
A tool call rendered from the transcript but **not yet resolved** stays registered as pending so the live completion event can update it; a call that already has its result does not stay pending.

### packages/coding-agent/test/suite/regressions/5080-signal-shutdown-extension-cleanup.test.ts
On SIGTERM the `session_shutdown` event (`runtimeHost.dispose`) must be emitted **before** any terminal write, because extension teardown (removing a socket) must not be skipped when a later terminal-restore write fails; the interactive quit path deliberately keeps the **opposite** order to preserve the final TUI frame. A re-entrant shutdown is a no-op, and a dead terminal (`EIO`/`ENOTTY`) exits quietly with code 129 without recording a crash.

### packages/coding-agent/test/suite/regressions/5109-exclude-tools.test.ts
The **exclusion list wins over the allowlist**, filters built-in *and* extension tools out of the prompt, and both lists accept glob patterns (`*_tool`, `ask*`).

### packages/coding-agent/test/suite/regressions/5208-late-bash-output.test.ts
Output callbacks that arrive **after** the bash operation resolved are ignored — the recorded output must not grow after the fact.

### packages/coding-agent/test/suite/regressions/5217-compaction-reason.test.ts
Both `session_before_compact` and `session_compact` carry the `reason` (`manual` / `threshold` / `overflow`) and the `willRetry` flag, so an extension can tell *why* a compaction happened.

### packages/coding-agent/test/suite/regressions/5303-bash-output-truncation.test.ts
`waitForChildProcess` **re-arms its grace timer on every chunk**, so output written more than 100 ms after exit by a short-lived detached descendant is still captured (the real symptom: every git commit running lint-staged came back truncated mid-listr2 output, read by the model as a hang). A genuinely idle held-open handle still releases after the grace — both proved with virtual timers so host load cannot reorder the writes.

### packages/coding-agent/test/suite/regressions/5433-extension-oauth-prompt-input.test.ts
The login dialog keeps each prompt's **own** value (one `> value` line each) and preserves the auth instructions, the neutral information/links and the setup details when a later prompt appears.

### packages/coding-agent/test/suite/regressions/5596-missing-theme-export.test.ts
Exporting with a configured theme that does not exist falls back to the active theme and still writes the HTML file; the settings still name the missing theme.

### packages/coding-agent/test/suite/regressions/5661-uppercase-header-values.test.ts
An UPPERCASE value in `models.json` — an env var name such as `CUSTOM_API_KEY`, or a header value `BEARER` — stays a **literal** through the startup migrations and is not lowercased into an env lookup.

### packages/coding-agent/test/suite/regressions/5724-sigterm-signal-exit.test.ts
The signal handlers stay registered until the async terminal cleanup finishes, because `signal-exit` re-sends SIGTERM when it observes no other listener during the same signal dispatch.

### packages/coding-agent/test/suite/regressions/5868-rpc-unknown-command-id.test.ts
An unknown RPC command answers with the **same request id** and `success: false`, so a client can correlate the failure.

### packages/coding-agent/test/suite/regressions/5943-session-start-notify.test.ts
On session replacement the state is rendered and the agent is **subscribed before** the new session's `session_start` handlers can notify or send a message, so a handler's message is not lost; the same ordering holds for `/reload` (`:413`).

### packages/coding-agent/test/suite/regressions/5996-session-name-newlines.test.ts
Newlines in a session name are filtered out, from both the session API and the extension API.

### packages/coding-agent/test/suite/regressions/5998-blocked-tool-terminate.test.ts
A `tool_call` handler may block **and** terminate: the tool never runs, the result is an error, the run stops, and the pending provider response is left unconsumed.

### packages/coding-agent/test/suite/regressions/6019-explicit-provider-retry-message.test.ts
Explicit provider "you can retry" guidance — the OpenAI request-id prose and the Bedrock JSON envelope — is classified as **retryable**.

### packages/coding-agent/test/suite/regressions/6104-find-root-relativization.test.ts
`relativizeFindResultPath` handles a Windows drive root and the POSIX root without eating the first path segment, keeps a trailing slash for directories, and does not relativise a sibling directory that merely shares a name prefix.

### packages/coding-agent/test/suite/regressions/6162-extension-active-tools-next-turn.test.ts
A tool that calls `pi.setActiveTools` changes the offered tool set **before the next provider request of the same run**, the refreshed system prompt is reported during the run, and a `before_agent_start` prompt override survives the change.

### packages/coding-agent/test/suite/regressions/6260-inline-extension-naming.test.ts
An inline extension with no name is displayed as `<inline:N>` (1-based), a named one as `<inline:name>`, and the `hidden` flag is preserved.

### packages/coding-agent/test/suite/regressions/6324-branch-summary-ambient-auth.test.ts
Branch summarisation still runs when the request auth has **no API key** — the summary goes through the ambient stream function and its cost is recorded on the `branch_summary` entry.

### packages/coding-agent/test/suite/regressions/6363-agent-settled-event.test.ts
Exactly **one** `agent_settled` event is emitted per run, after the automatic retries, with `ctx.isIdle() === true`; a follow-up queued by an `agent_end` handler is delivered **before** settlement.

### packages/coding-agent/test/suite/regressions/6596-taskkill-enoent.test.ts
`killProcessTree` falls back to `<SystemRoot>\System32\taskkill.exe` (defaulting to `C:\Windows` when `SystemRoot` is missing or empty) and **consumes** the spawn error instead of letting it become an unhandled `'error'` event.

### packages/coding-agent/test/suite/regressions/6647-compaction-retries-transient-stream-drop.test.ts
The summarisation call **reuses `settings.retry`** (bounded, exponential backoff, gated on a retryable error) and emits `summarization_retry_scheduled` / `summarization_retry_finished`; a non-retryable error (`insufficient_quota`) is not retried, `maxRetries` is honoured, and `abortCompaction` interrupts the backoff.

### packages/coding-agent/test/suite/regressions/6768-copilot-compaction-base-url.test.ts
The compaction request must use the **auth-resolved** `baseUrl` (an OAuth refresh that points at a different host), not the catalog one.

### packages/coding-agent/test/suite/regressions/6904-dns-transport-retry.test.ts
A DNS lookup failure wrapped in a stream-cancellation message (`getaddrinfo ENOTFOUND`) is still classified as transient and retried.

### packages/coding-agent/test/suite/regressions/6949-unavailable-scoped-model.test.ts
An enabled model with **no catalog entry** is shown struck through and marked `[unavailable]`, can be removed, and does not clear the rest of the scope.

### packages/coding-agent/test/suite/regressions/6999-models-json-hot-reload.test.ts
Opening `/model` re-reads `models.json`, so a catalog rewritten while pi is running shows the new provider and drops the old one.

### packages/coding-agent/test/suite/regressions/7027-credential-refresh-hang.test.ts
An interactive login is **not** held behind an older stalled network catalog refresh; the post-login catalog refresh is bounded to 15 s and a timeout is a warning ("using cached models"), while an empty catalog is reported only after the refresh.

### packages/coding-agent/test/suite/regressions/7048-compaction-truncated-summary.test.ts
A length-limited summary is **not persisted**: `compact()` rejects with `generation hit the token cap` and no compaction entry is written.

### packages/coding-agent/test/suite/regressions/7150-rpc-prompt-during-compaction.test.ts
An RPC prompt during a manual compaction is **refused** with "compaction is in progress" — it is not queued, no user message is persisted, and no `agent_start` is emitted.

### packages/coding-agent/test/suite/regressions/7153-scoped-models-refresh.test.ts
The model selector renders the **cached** models immediately with a "Refreshing model catalogs…" hint and updates when the background refresh completes; closing the selector aborts the refresh.

### packages/coding-agent/test/suite/regressions/7187-malformed-package-manifest.test.ts
An invalid resource field in a package manifest is ignored **without dropping the valid fields** of the same package.

### packages/coding-agent/test/suite/regressions/7193-event-bus-lifecycle.test.ts
Extension-owned event-bus listeners are removed on reload **and** on dispose (the host's own listener survives), and a captured stale extension API throws after a reload.

### packages/coding-agent/test/suite/regressions/7209-model-selector-filter-resets-selection.test.ts
Typing a filter moves the selection back to the **first row** of the All tab and of the Scoped tab, instead of staying clamped at the previous index.

### packages/coding-agent/test/suite/regressions/7253-manual-compact-during-response.test.ts
A manual compaction requested during an active response aborts that response and **persists it before** the compaction entry, so the session file order is *aborted assistant* then *compaction*.

### packages/coding-agent/test/suite/regressions/7269-cli-end-of-options.test.ts
The `--` end-of-options delimiter stops option parsing while `@file` handling continues; an unknown `--flag value` is captured rather than rejected.

### packages/coding-agent/test/suite/regressions/7290-json-stream-linear.test.ts
The JSON wire projection of a message update is **delta-only** (no cumulative message or partial snapshot) and its serialised size must scale **linearly** with the text — 2× the text must cost < 2.2× the bytes.

### packages/coding-agent/test/suite/regressions/7301-stalled-availability-refresh.test.ts
A stalled availability refresh must **not** overwrite a newer snapshot or a newer error state when it finally settles — the refresh writes are stale-checked.

### packages/coding-agent/test/suite/regressions/7443-model-command-cached-match.test.ts
An exact model match is resolved from the availability snapshot **without starting a catalog refresh**; only a cache miss spends the caller-owned refresh deadline, and then the status line says "Refreshing model catalogs…".

### packages/coding-agent/test/suite/regressions/7497-session-discovery-symlink.test.ts
Session discovery walks a symlinked (or junctioned) session directory and **preserves the alias path** in the result; a broken link is ignored without hiding valid sessions.

### packages/coding-agent/test/suite/regressions/7572-provider-retry-settings-merge.test.ts
Nested provider retry settings **merge across scopes** (global + project) instead of being replaced, so a project that sets only `maxRetries` keeps the global `timeoutMs`.

### packages/coding-agent/test/suite/regressions/7731-tui-method-wrapping.test.ts
A method captured from the TUI reference **before** a renderer replacement still routes to the *current* renderer, and a captured method keeps calling the original one.

### packages/coding-agent/test/suite/regressions/7829-invalid-settings-warning.test.ts
A startup diagnostic (e.g. "Invalid settings file …: malformed JSON") is rendered **inside the transcript**, not only in a transient overlay.

### packages/coding-agent/test/suite/regressions/7911-json-stream-usage.test.ts
The delta-only JSON projection still carries the cumulative `usage`; the fixed-size metadata must not be dropped along with the snapshots.

### packages/coding-agent/test/suite/regressions/7925-toolcall-start-metadata.test.ts
A `toolcall_start` JSON event carries the tool call **id and tool name** and nothing else, so a client can key the call without the cumulative snapshot.

### packages/coding-agent/test/suite/regressions/8237-node-sea-extension-loading.test.ts
The extension loader is **lazy** — jiti and the bundled virtual-module map are not loaded until an extension is actually imported — and in a compiled (SEA) binary the `tryNative: false` branch takes precedence over the source branch.

### packages/coding-agent/test/suite/regressions/8261-subagent-project-trust.test.ts
A project-local agent needs a **per-call confirmation** in an untrusted project (`Canceled: project-local agents not approved.`) and none in a trusted one.

### packages/coding-agent/test/suite/regressions/8328-zero-usage-auto-compaction.test.ts
When no assistant has reported usage, the compaction check falls back to a **message estimate**, so a zero-usage response can still trigger a threshold compaction.

### packages/coding-agent/test/suite/regressions/8337-utf8-bom-parsing.test.ts
A UTF-8 BOM is stripped when reading frontmatter and settings files, and a settings write does **not** put the BOM back.

### packages/coding-agent/test/suite/regressions/8423-extension-factory-failure.test.ts
An extension factory that throws **discards its runtime changes** (flags, providers, listeners) and its API is deactivated with a message naming the extension (`Extension "<failing>" failed to load and its API is no longer active.`); a concurrently loaded factory's provider is not discarded.

### packages/coding-agent/test/suite/regressions/8537-custom-message-tool-result-ordering.test.ts
A custom message injected while a tool is running is appended **after** the turn's tool results (never between a call and its result), the session entries and the message events keep the same order, and every tool result in the LLM history follows its tool call.

### packages/coding-agent/test/suite/regressions/8611-thinking-toggle-pending-bash-output.test.ts
Toggling the thinking-block visibility mid-run does not discard the partial output of a **running** bash tool.

### packages/coding-agent/test/suite/regressions/8724-in-memory-fork-active-tool.test.ts
A fork during an active tool turn does **not** append the aborted turn to the replacement session — the new session starts with only its own system message.

### packages/coding-agent/test/suite/regressions/8935-parallel-preflight-abort.test.ts
When a later tool preflight aborts, **no prepared tool executes** and no `tool_result` hook runs; both calls still end with an error result ("Operation aborted") so the model gets a matched pair.

### packages/coding-agent/test/suite/regressions/8964-extension-provider-streaming.test.ts
An extension command may **stream** from a provider registered with `pi.registerProvider()` through `ctx.modelRegistry.stream` / `streamSimple`, and the provider is not left registered globally afterwards.

### packages/coding-agent/test/suite/regressions/8989-fork-compaction-label-boundary.test.ts
A fork that removes a context-invisible label boundary keeps the compaction's context: `firstKeptEntryId` is re-pointed at the first kept message and the summary still opens the context.

### packages/coding-agent/test/suite/regressions/9068-user-bash-fail-closed.test.ts
A `user_bash` handler that throws or returns an unparseable result **fails closed** — bash never executes and the RPC answers `success: false` with "Invalid user_bash handler result"; only an explicit `undefined` means "run it normally". The interactive path (`!pwd` and `!!pwd`) behaves the same.

### packages/coding-agent/test/suite/regressions/9178-tree-during-compaction.test.ts
Tree navigation is refused while a compaction is in progress **and** while another navigation is already waiting, with a message naming the wait; the active leaf does not move.

### packages/coding-agent/test/suite/regressions/9340-9777-auto-compaction-cancellation.test.ts
An abort during post-run auto-compaction prevents the compaction from starting at all; the summarisation auth call is abortable; **"Compaction cancelled" is an abort** while an unrelated `AbortError` is a **failure** (`aborted: false`, message kept), and an extension's `cancel: true` is reported as aborted.

### packages/coding-agent/test/suite/regressions/9540-extension-loader-lazy.test.ts
The ordinary (non-SEA) extension loader also defers jiti and the virtual-module map until an extension is actually imported, and keeps `tsconfigPaths` on.

### packages/coding-agent/test/suite/regressions/9789-context-handler-system-messages.test.ts
A context handler that slices from the compaction summary does **not** lose the prompt or the tool declarations (the system head and the tools are re-attached); mid-conversation system messages stay in place; a handler may edit `event.messages` in place; `context_with_system` runs after `context` on the restored transcript and its output is sent **verbatim**; and a handler that drops the leading system message is **reported** through `onError` while its output is still honoured.

### packages/coding-agent/test/suite/regressions/copilot-request-size-overflow.test.ts
A real **413** from a gateway (a request-*size* overflow, not a token overflow) is answered by compacting the image-heavy history and retrying; the retried request no longer carries the images, and the session continues to a final answer instead of dying on the 413.

### packages/coding-agent/test/suite/regressions/extension-factory-cache.test.ts
`loadExtensionsCached` caches the extension **module** per cwd but re-runs the factory on every load; `loadExtensions` (direct) is never cached; a resource-loader reload clears the cache; the cache is scoped to one cwd.

### packages/coding-agent/test/suite/regressions/pre-prompt-compaction-no-continue.test.ts
A pre-prompt compaction of a length-stop overflow does **not** continue from the truncated assistant message — `agent.continue` is never called and the next prompt is a fresh turn.

### packages/coding-agent/test/suite/regressions/startup-session-rebind-duplicate-subscription.test.ts
An overlapping startup and replacement rebind does not subscribe twice: the stale startup rebind must not subscribe to the agent nor update the terminal title.

### packages/coding-agent/test/suite/regressions/tree-during-streaming.test.ts
Tree navigation during an active response is refused ("Wait for the current response to finish before navigating the session tree") and the active leaf does not move.

*(The 84 `regressions/` files are listed individually above; each is a single-mechanism pin, so one specific line per file is the informative form.)*

### packages/coding-agent/test/syntax-highlight.test.ts
Syntax highlighting loads the twenty common languages at startup and **defers the rest**, decodes the HTML entities highlight.js emits, inherits the parent format for unmapped nested scopes, and colours each Python docstring line independently (#10143).

### packages/coding-agent/test/system-prompt-updates.test.ts
- **Purpose:** How the system prompt and the tool declarations are *stored and updated* across a session.
- **Key abstractions:** `buildSystemPromptSections`, `buildSystemPromptState`, `diffSystemPromptSections`; the transcript's **head system message** carrying `sections` + `toolsAdded`.
- **Data flow:** the prompt is computed → the sections are diffed against the recorded head → the difference is emitted as a **patch** system message → the provider request carries head + patches.
- **Non-obvious design decisions:** the prompt and the tool declarations are written **once** as a structured head message and reused for the whole session (`:28-54`); the transcript stores *structured sections*, not a rendered blob, so a change is a per-section patch (`{ plan_mode: "<plan_mode>…</plan_mode>" }` or `{ plan_mode: null }` to remove) (`:82-92`).
- **Edge cases / failure handling:** a session that already has history opens **without** a system message and only synthesises one when the first request needs it (`:56-80`) — nothing is persisted speculatively. A **forced** prompt (`forceSystemPrompt` / an extension returning `systemPrompt`) is sent as the leading prompt for that run and is **never recorded** in the transcript (`:112-168`).
- **Surprising:** a tool-set change emits a system patch carrying `toolsRemoved` **and** the refreshed `sections.tools` / `sections.rules` — the tool list and the rules are one atomic change (`:170-233`).

### packages/coding-agent/test/system-prompt.test.ts
The system prompt's exact shape: the default preamble (`You are an expert coding assistant operating inside pi`), `<tools>\n(none)\n` for an empty tool set, the `<addendum>` / `<project_context>` / `<cwd>` sections, shell-specific guidance, the "resolve docs/… under Additional docs and examples/…" instruction, a tool listed **only when it has a `promptSnippet`**, deduplicated and trimmed `promptGuidelines`, skills listed only when `read` or `bash` is available, and hidden tools left out of the list **and** the rules.

### packages/coding-agent/test/system-theme.test.ts
The generated "system" theme keeps body text at **WCAG 4.5:1** on the background and its panels, orders the foreground roles by contrast (`text` > `muted` > `dim`), keeps the panels close to the background (contrast < 2), uses the terminal's palette hues, keeps pastel palette colours pastel at other lightnesses (#10255) and renders as grayscale at zero saturation.

### packages/coding-agent/test/test-harness.test.ts
The legacy harness is itself tested: the faux response sequence, tool-call execution, an error response, a **pending** response turned into an error, retry on a transient error, custom usage numbers, event capture, context capture, response wrap-around, text/thinking/toolcall delta streaming and their order, and the disambiguation of duplicate extension commands into `shared-cmd:1` / `shared-cmd:2`.

### packages/coding-agent/test/test-harness.ts
- **Purpose:** The legacy harness — a faux stream function with a declarative response sequence and a one-call factory for a wired in-memory `AgentSession`.
- **Key abstractions:** `FauxResponse { text, toolCalls, thinking, stopReason, error, usage, delayMs, model }`; `createFauxStreamFn(responses)` returning `{ streamFn, state: { callCount, contexts } }`.
- **Data flow:** `createHarness({ responses })` → `Agent({ streamFn })` → `AgentSession` → the session subscribes to capture events.
- **Non-obvious design decisions:** the faux stream replays **token-level deltas** (`chunkString` splits at 3–5 characters) and emits the real `start`/`*_start`/`*_delta`/`*_end`/`done` event sequence, so the streaming path is exercised, not stubbed (`:171-259`). `stopReason: "pending"` is turned into an *error* ("Faux response ended without a stop reason") rather than a silent end.
- **Edge cases / failure handling:** the response list **wraps around** when more calls than responses are made (`:301-306`); `createHarness` **refuses** `extensionFactories` and points at `createHarnessWithExtensions` (`:462-465`).
- **Surprising:** the legacy harness captures the **request contexts** (`state.contexts`), which is how the current tests assert on what the provider actually received.

### packages/coding-agent/test/test-network-env.ts
`allowNetwork()` unsets `PI_OFFLINE` so a test that replaces external I/O with local fixtures may exercise the network code paths.

### packages/coding-agent/test/test-theme-colors.ts
A developer **CLI** (not a test): it prints the built-in themes' contrast against white and black, computes colours at a target WCAG ratio by binary search in HSL, and can audit any theme JSON file.

### packages/coding-agent/test/theme-controller.test.ts
The interactive theme controller uses the initial theme **without persisting it**, applies the theme immediately and lets startup wait for the terminal colours (grayscale until the answer arrives), falls back to palette indices and applies a late reply, re-queries on an appearance change and lets the terminal decide, re-renders only when the reported colours actually change, and stops the appearance updates when disposed.

### packages/coding-agent/test/theme-detection.test.ts
Terminal theme detection: `COLORFGBG` is classified by palette index like Vim, the background wins over the reported scheme over `COLORFGBG` over dark, the foreground is followed when that is the readable direction, the colour mode follows the terminal capabilities (256color vs truecolor), and a `light/dark` auto setting is parsed and resolved.

### packages/coding-agent/test/theme-export.test.ts
HTML-export theme colours resolve variable references with the same syntax as the colours, convert **OKHSL to hex** because CSS has no OKHSL, and resolve recursive vars and 256-colour values to hex.

### packages/coding-agent/test/theme-picker.test.ts
A custom theme is listed by the name **inside the theme file**, not by its file name.

### packages/coding-agent/test/theme-style.test.ts
`theme.style()` matches the generic text styler; an unknown token (or a background token in the foreground slot) throws `Unknown theme color: …`; OKLCH and OKHSL values load (including through variables); the appearance is detected unless declared (and palette-only themes follow the terminal background); an empty token renders as the terminal default while still reporting a concrete colour.

### packages/coding-agent/test/themed-text.test.ts
`ThemedText` builds **lazily** and rebuilds with the current theme only after an explicit `invalidate()` — a theme switch does not silently repaint stale content, and a rebuild costs exactly one extra build.

### packages/coding-agent/test/thinking-selector.test.ts
The thinking selector keeps the current level marked while browsing, and the "set as default" binding is the **configured** one (`app.thinking.save`), not a hard-coded key.

### packages/coding-agent/test/tool-execution-component.test.ts
- **Purpose:** The tool-execution renderer — the component that draws one tool call in the transcript.
- **Key abstractions:** `ToolExecutionComponent(toolName, id, args, result, definition, tui, cwd)` with `updateResult(result, isFinal)`, `markExecutionStarted()`, `invalidate()`; `renderShell: "self"`; `withBuiltInRenderers`.
- **Data flow:** the call is rendered from the args; the result arrives through `updateResult` and the component re-renders; a custom `renderCall` / `renderResult` on the definition **stacks over** the built-in shell.
- **Non-obvious design decisions:** a missing renderer slot on an override is **inherited from the built-in tool** (`:323-365`); a `renderShell: "self"` row that renders nothing takes **no layout space** at all (`:100-130`).
- **Edge cases / failure handling:** a replaced partial image must not resurface after the transcoder converts it (`:50-66`); a read error is **not** syntax-highlighted according to the requested file path (`:555`); trailing blank display lines are trimmed from write previews and read results.
- **Surprising:** the bash renderer emits an **initial empty partial update before any output arrives** (`:167`) so the row appears the moment the tool starts, and the recorded duration is shown even for a result restored from a session file without a live start (`:266`).

### packages/coding-agent/test/tool-renderer-examples.test.ts
An example that registers a custom tool renderer must leave the **system prompt byte-identical** to the baseline (#10072), and minimal-mode's edit tool renders like the default shell.

### packages/coding-agent/test/tool-result-images.test.ts
Tool-result image normalisation: the original array is returned untouched when there is nothing to do, an oversized image is resized (to 2000 px) and the **original dimensions are reported** in a note, auto-resize can be switched off, an unsupported format is still converted, an **undecodable image is kept** rather than dropped, and the surrounding text blocks keep their order.

### packages/coding-agent/test/tool-search.test.ts
The BM25 tool search: the tokenizer splits camelCase/snake_case, drops stop words and folds plurals; the ranker honours the limit and searches property names and descriptions; an unknown query returns nothing (no synonyms, so "tickets" does not find "issues" — a stated limit); the codemode description catalog fills its budget **round-robin, cheapest first**, says what is missing, is deterministic, and leaves deferred tools and namespace instructions out.

### packages/coding-agent/test/tool-system-prompt-contributions.test.ts
Each built-in tool's `promptSnippet` and `promptGuidelines` must **equal** its declared system-prompt contribution, and the shell tools' session-environment guidance disappears when `exposeSessionEnvironment` is false — one table, one source of truth.

### packages/coding-agent/test/tools-manager.test.ts
Resolving an external tool's latest version reads the release-page redirect (tags without a `v` prefix are kept, a relative target is resolved, the body is discarded) and a missing redirect fails with a clear message; `ensureTool` reports through a **status callback** (never `console`) and surfaces the whole error cause chain.

### packages/coding-agent/test/tools.test.ts
- **Purpose:** The built-in coding tools, exercised against a real temp directory.
- **Key abstractions:** `createReadTool`, `createWriteTool`, `createEditTool`, `createBashTool`, `createGrepTool`, `createFindTool`, `createLsTool` and their `create*ToolDefinition` counterparts; `createLocalBashOperations`; `executeBashWithOperations`.
- **Data flow:** a tool definition's `execute(callId, params)` → the tool mutates the filesystem → the result carries content and structured content.
- **Non-obvious design decisions:** a non-zero exit code is an **error result with structured content**, not a thrown exception (`:501`); the edit tool matches against the **original** file, not incrementally (`:383`), and refuses to apply anything when one region of a multi-edit fails (`:425`).
- **Edge cases / failure handling:** `read` truncates by line count *and* by bytes and says which (`:101-128`); the diff preview carries `ENOENT`/`EACCES` (`:475-492`); the bash tool's structured content is capped at 1 MiB and the **full output is persisted to a file** when truncation happens (`:521`, `:834-875`); `RIPGREP_CONFIG_PATH` is ignored so a user's grep config cannot change the model's results (`:912`); a flag-like search pattern is treated as **text**, not an option (`:936`, `:999`).
- **Surprising:** the edit tool's **fuzzy matching** normalises trailing whitespace, fullwidth punctuation, compatibility-equivalent Unicode forms, smart quotes, Unicode dashes and non-breaking spaces — and still prefers an exact match when one exists (`:1133-1359`); CRLF line endings and the UTF-8 BOM are preserved through an edit (`:1360-1450`).

### packages/coding-agent/test/tree-selector.test.ts
- **Purpose:** The session-tree selector — the tree view of the branch structure.
- **Key abstractions:** `TreeSelectorComponent`, `SessionTreeNode`, `SessionEntry` kinds (`message`, `model_change`, `thinking_level_change`, `label_change`, `context_edit`).
- **Data flow:** the branch entries are turned into a node tree → the user filters/folds/navigates → a selection is returned as an entry id.
- **Non-obvious design decisions:** the initial selection focuses the **nearest visible ancestor** when the current leaf is a metadata entry (a `model_change` with a sibling branch, or a `thinking_level_change`) (`:130-225`) — the selection must land on something the user can see.
- **Edge cases / failure handling:** context edits are **hidden by default** and labelled in "all" mode (`:159`); switching to a filter with no matching entries preserves the selection and restores it when switching back (`:365-431`); search and a filter-mode change **reset the fold state** (`:676`, `:709`).
- **Surprising:** folding the root hides the whole subtree even when intermediate nodes are filtered out (`:648`), and `ctrl+right` unfolds a folded node first and only then performs the segment jump.

### packages/coding-agent/test/trigger-compact-extension.test.ts
The `trigger-compact` example auto-compacts **only** when the context usage crosses its threshold (110 000 and 120 000 do not trigger; 105 000 does), from a `turn_end` handler.

### packages/coding-agent/test/truncate-to-width.test.ts
`truncateToWidth` measures **display width**, not byte length: checkmarks, emoji and mixed ASCII/wide text are truncated to the visible width, the text is not truncated when it fits, an ellipsis is added when it is, and the exact crash case (a 68-wide line in a 67-wide terminal) is covered.

### packages/coding-agent/test/trust-manager.test.ts
Project trust decisions are stored per directory and **inherited from a parent** (setting `null` clears the local decision and falls back to the parent); trust-requiring project resources are detected (`.pi/settings.json`, `.agents/skills`).

### packages/coding-agent/test/trust-selector.test.ts
The trust selector shows the saved decision and whether it is **inherited**, marks the current decision while browsing, selects "Trust" with the path update, and offers "Trust parent folder" which writes the parent as trusted and the child as `null`.

### packages/coding-agent/test/user-message.test.ts
The user-message component keeps a **stable height** by moving the closing OSC 133 markers off the line end, chains Markdown transformers with a `{ messageType, isStreaming, availableWidth }` context, and reapplies them on `invalidate()`.

### packages/coding-agent/test/utilities.ts
- **Purpose:** Shared helpers for the legacy test path.
- **Key abstractions:** `userMsg`, `assistantMsg`, `readSessionFileRoles`, `createTestExtensionsResult`, `createTestResourceLoader`, `createTestSession`, `buildTestTree`, `resolveApiKey`, `hasAuthForProvider`, `getRealAuthStorage`.
- **Data flow:** `createTestExtensionsResult` loads each factory through `loadExtensionFromFactory` and names it `<inline:N>` or `<inline:name>`; `createTestResourceLoader` returns a loader whose resources are all empty.
- **Non-obvious design decisions:** the inline-extension naming rule lives **here**, not in the loader (`:206-213`), and the suite harness relies on it — the same rule is pinned by `suite/regressions/6260-inline-extension-naming.test.ts`.
- **Edge cases / failure handling:** `resolveApiKey` reads `~/.pi/agent/auth.json`, **refreshes an expired OAuth credential and writes it back** with mode `0600` and the directory with `0700` (`:65-104`) — the file is a real credential store, so the modes matter.
- **Surprising:** `createTestSession` is documented as being for **e2e tests that need real LLM calls** and uses the real `ANTHROPIC_*` key from the environment (`:32`, `:253-297`) — the only place in this shard that touches a live provider.

### packages/coding-agent/test/version-check.test.ts
The pi version check: versions compare numerically including a beta suffix, only a **newer** version is offered, the pi.dev API is called with a `pi/<version>` user agent, an explicit request retries while an automatic check makes exactly **one** request, `PI_SKIP_VERSION_CHECK` disables only the automatic check, and a nested network error is flattened to `fetch failed (ETIMEDOUT, ENETUNREACH)`.

### packages/coding-agent/test/virtual-models.test.ts
- **Purpose:** Virtual models at the **runtime** level (the suite file covers the session level).
- **Key abstractions:** `ModelRuntime.resolveModel(virtual, messages, { reason, thinkingLevel })`, `getBranchSelection(branch, lookup)`, `InMemoryModelsStore`.
- **Data flow:** the virtual model is listed with `contextWindow: 0` and `maxTokens: 0` → each request is resolved to a physical model → the physical model's capabilities clamp the answer.
- **Non-obvious design decisions:** `getBranchSelection` performs **one** catalog lookup — the last `model_change` — not one per assistant message (#10198) (`:67-87`); with no `model_change` it uses the latest physical response, and a *failed* virtual response does not become the selection (`:101-113`).
- **Edge cases / failure handling:** the router asks for `"high"` but the resolved small model does not reason, so the thinking level is clamped to `"off"` (`:130-133`).
- **Surprising:** the virtual model's declared `input` modality is the **union** of the routed models' (`["text","image"]`) while its window and output cap stay 0 — the virtual model declares what it *may* do, not what it *can* do.

### packages/coding-agent/test/windows-shell-config.test.ts
On Windows a legacy WSL launcher **under the actual Windows directory** is detected and switched to stdin command transport, while a `bash.exe` outside the `SystemRoot` is not (#9490).

---

## Ideas worth stealing

- **The summariser is a side request with its own context, its own session id and caching forced off** — `packages/coding-agent/test/suite/agent-session-compaction.test.ts:356-363` — the compaction request must not go through the conversation's `transformContext`, must carry **no tools**, must use `cacheRetention: "none"`, must not reuse the active `sessionId`, and must not inherit the conversation's transport. Why it transfers: August's compaction shares the provider client with the live turn, so a summariser that shares the session id also shares the prompt-cache prefix and the price. The pairing is the point — the same file asserts the request body starts with `# Conversation` (`:360`), which is also the defence against a summary being read as a fresh user instruction.
- **A refusal that names the door that would have worked** — `packages/coding-agent/test/suite/agent-session-queue.test.ts:453-455` — `Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.` The refusal is a *teaching* event: it names the two legal alternatives in the same sentence. August refuses a lot (permission, policy, budget, authority); each refusal should say what the caller could have done instead.
- **A hook whose result selects a privileged path fails closed** — `packages/coding-agent/test/suite/regressions/9068-user-bash-fail-closed.test.ts:150-175` — a `user_bash` handler that throws, or returns an empty object, denies the request with `Invalid user_bash handler result` and the command **never executes** (`executeCount: 0`); only an explicit `undefined` means "run it normally". The generalisation for August: any extension hook that can *route* an action must have its result shape validated exhaustively, and an unparseable result must deny rather than fall back to the default behaviour.
- **One preflight abort cancels every prepared tool, but every call still gets a matched error result** — `packages/coding-agent/test/suite/regressions/8935-parallel-preflight-abort.test.ts:56-70` — `executions` is empty, `resultHooks` is empty, yet two `tool_execution_end` events and two `"Operation aborted"` tool results exist. August's parallel preflight (write gate, approval, sandbox) has the same shape: the abort must stop *all* pending writes, and the model must still receive one result per call it made, or the next turn carries an orphaned `tool_use_id`.
- **The tool-result history is asserted as an invariant, not as a snapshot** — `packages/coding-agent/test/suite/regressions/8537-custom-message-tool-result-ordering.test.ts:133-149` — the test walks the LLM history and asserts that every `toolResult`'s `toolCallId` is in the set of ids opened by the preceding assistant message. This is the check August needs for the exact class of bug its own AGENTS.md records (an orphaned `tool_use_id` surviving into persisted history bricks the chat) — a *structural* assertion catches it for any ordering, not just the one that broke.
- **The wire projection must be delta-only and its size must scale linearly** — `packages/coding-agent/test/suite/regressions/7290-json-stream-linear.test.ts:37-43` — doubling the text may cost at most 2.2× the bytes, and the projected event must contain no cumulative `message` and no cumulative `partial`. A quadratic stream is invisible in a functional test and expensive in production; a *ratio* assertion makes it a budget.
- **A stale refresh must not overwrite a newer snapshot** — `packages/coding-agent/test/suite/regressions/7301-stalled-availability-refresh.test.ts:84-90` — a refresh that stalled on the credential store and resolves *after* a newer refresh must not restore the stale provider list or the stale error. The same check exists for the provider-scoped variant (`:108-132`). August's `scrubOutboundBody` stamp and its `providers.json` read-on-every-call path are the same hazard: a stale write must be rejected, not merely unlikely.
- **A failed extension factory discards its changes and deactivates its API, naming the extension** — `packages/coding-agent/test/suite/regressions/8423-extension-factory-failure.test.ts:47-54` — the flag it registered is gone, the provider it unregistered is restored, its event listener never fired, and any later use of its captured API throws `Extension "<failing>" failed to load and its API is no longer active.` A half-loaded extension that keeps its registrations is the classic "the plugin half-worked" bug.
- **A session replacement subscribes before the new session's handlers can speak** — `packages/coding-agent/test/suite/regressions/5943-session-start-notify.test.ts:271-277` — the pinned order is `apply → render → subscribe → bind → notify`. August's `/reload` and session-switch paths have the same race: if the subscription happens after `session_start`, a handler's message is emitted into a session nobody is listening to and is lost.
- **The shutdown order is different for a signal than for a quit** — `packages/coding-agent/test/suite/regressions/5080-signal-shutdown-extension-cleanup.test.ts:116-127` — on SIGTERM the order is `dispose → drainInput → stop` (extension teardown first, terminal untouched); on an interactive quit it is `drainInput → stop → dispose` (the final TUI frame first). The *reason* is in the comment at `:11-17`: extension teardown does not write to the tty, so it must not be skipped when a later terminal-restore write fails on a dead terminal. A harness with two exit paths needs two orders, chosen deliberately.
- **A summary that is truncated must not replace the history** — `packages/coding-agent/test/suite/regressions/7048-compaction-truncated-summary.test.ts:40-47` — a length-stopped summary makes `compact()` reject with `generation hit the token cap` and **no compaction entry is written**. August currently admits a summary whose own footer says "decisions, constraints and next steps were not analyzed"; pi's rule is stricter and simpler: an unusable summary either refuses the compaction or keeps the original window.
- **The context-limit decision uses the *physical* model, and the request reason is explicit** — `packages/coding-agent/test/suite/virtual-models.test.ts:92-99` and `:217-226` — the route reason is one of `user | retry | continuation | direct`, and the compaction threshold is evaluated against the model that produced the **last response**, not against the declared (virtual) window. August's compaction thresholds are computed from one model's window; a router or a fallback model breaks that assumption silently.
- **A forced system prompt is sent but never recorded** — `packages/coding-agent/test/system-prompt-updates.test.ts:112-168` — the transcript stores only the *structured sections*; the exact forced text rides on the request. So the recorded prompt and the sent prompt are two different things, and the test pins both. This is the shape August needs if it ever wants a "run this exact prompt" door without polluting the transcript.
- **The system prompt is a diffable structure, not a blob** — `packages/coding-agent/test/system-prompt-updates.test.ts:82-92` — `diffSystemPromptSections(previous, current)` returns `{ plan_mode: "<plan_mode>…</plan_mode>" }` or `{ plan_mode: null }` to remove a section, and `undefined` when nothing changed. A prompt assembled as sections is cheap to patch; a prompt assembled as a string is rewritten wholesale on every change, and the provider cache prefix dies.
- **One table, one source of truth: a tool's prompt text is asserted against its contribution** — `packages/coding-agent/test/tool-system-prompt-contributions.test.ts:26-43` — `definition.promptSnippet === contribution.snippet` and `definition.promptGuidelines === contribution.guidelines`, for every built-in tool, and the shell tools' session-environment guidance disappears when `exposeSessionEnvironment` is false. August's tool definitions and its prompt are written down in different places; a table-driven equality test is the cheapest way to stop them drifting.
- **An exact model match must not start a network refresh** — `packages/coding-agent/test/suite/regressions/7443-model-command-cached-match.test.ts:20-45` — a cached id resolves with **zero** refresh calls and no status line; only a cache miss spends the deadline, and then the user is told. A `/model` that always hits the network is a latency bug nobody notices because it is slow rather than wrong.
- **The loader must not load its compiler until it has something to compile** — `packages/coding-agent/test/suite/regressions/9540-extension-loader-lazy.test.ts:38-57` and `.../8237-node-sea-extension-loading.test.ts:51-70` — jiti and the virtual-module map are imported **only when an extension is actually imported**, and in a compiled binary the `tryNative: false` branch wins. Startup cost for a feature the user may never use is a real cost; the test is a two-line counter.
- **A scoped-model list entry with no catalog entry must still be visible and removable** — `packages/coding-agent/test/suite/regressions/6949-unavailable-scoped-model.test.ts:85-91` — it is shown struck through and marked `[unavailable]`, it can be removed, and removing it does not clear the rest of the scope. A configuration entry that silently disappears when a provider goes away is how a user loses a setting they still want.
- **The deny set wins over the allow set, and both accept patterns** — `packages/coding-agent/test/suite/regressions/5109-exclude-tools.test.ts:62-98` — an excluded tool is absent from `getAllTools()`, from `getActiveToolNames()` *and* from the prompt, even when the allowlist names it. August's capability rules are per-tool; a "deny always wins" rule is a one-line policy that removes a whole class of mistakes.
- **The refusal to steer into a command is a refusal that names the alternative** — `packages/coding-agent/test/suite/agent-session-queue.test.ts:440-474` — both `steer("/cmd")` and `followUp("/cmd")` throw the same message. The mechanism is small but the *shape* — one message, both doors, in the same words — is what makes it teachable.

---

## Files skipped (with reasons)

None. All 135 files in the shard were opened and read. No file in this shard is generated, vendored, binary or a huge data payload: the largest is `packages/coding-agent/test/tools.test.ts` at 52 KB, and the shard totals 878 KB of hand-written TypeScript.

For five of the largest files I read the head plus the **complete test-title index** (a grep over every `describe`/`it`/`test` declaration, with line numbers) rather than every line, and the note for each file says so:

- `packages/coding-agent/test/suite/agent-session-codemode.test.ts` (40.8 KB, 1032 lines) — read lines 1–210 and the full title index (28 test declarations).
- `packages/coding-agent/test/suite/agent-session-mcp.test.ts` (51.8 KB, 1273 lines) — read lines 1–232 and the full title index (51 test declarations).
- `packages/coding-agent/test/tools.test.ts` (51.9 KB, 1452 lines) — read lines 1–90 and the full title index (95 test declarations).
- `packages/coding-agent/test/tool-execution-component.test.ts` (24.5 KB, 724 lines) — read lines 1–120 and the full title index (27 test declarations).
- `packages/coding-agent/test/tree-selector.test.ts` (22.7 KB, 739 lines) — read lines 1–120 and the full title index (26 test declarations).

`packages/coding-agent/test/virtual-models.test.ts` (19 KB, 443 lines) was read lines 1–150 plus its title index; the remainder is the rest of the same runtime-resolution assertions.

---

## Uncertainties

- **The manifest I was told to use no longer contains this shard.** `docs/research/pi/manifest.tsv` was re-cut mid-session into a different naming scheme (`packages-coding-agent-NN`, `repo-root-01`, `scripts-01`, …); the string `coding-agent-tests` occurs **zero** times in the version I was handed, and the re-cut manifest has since been committed as `6d0226eb`. I recovered the shard from the last committed version that still had it (`git show bc531b2e:docs/research/pi/manifest.tsv`), where `coding-agent-tests#4` is exactly these 135 rows. I checked that the recovered list is the whole shard (135 rows, 878 998 bytes, all paths present in the clone with matching sizes) and that my ledger reproduces it exactly (0 missing, 0 extra, 0 duplicates). `scripts/research/merge-rows.mjs` keys on **path**, not on shard, so the ledger applies to the re-cut manifest unchanged; the only thing the lead loses is the `coding-agent-tests#4` *label* for this set of files. I did not touch the manifest.
- **The "six bullets" form was used for the mechanism-bearing files, not for all 135.** The 84 `regressions/` files are each a single-mechanism pin (one issue number, one behaviour), so a one-line specific note per file is the informative form; giving each of them six bullets would have added ~500 lines of filler. The 18 `suite/` files and the 15 substantive top-level files carry the full form.
- **Four files were read partly, as listed above** (codemode, mcp, tools, tool-execution-component, tree-selector, and virtual-models). For those, my notes describe what I read plus what the test-title index shows; individual assertions inside the unread regions are not characterised. In particular I did **not** read the bodies of `agent-session-mcp.test.ts`'s server-waiting assertions (`:769-1030`) or `tools.test.ts`'s bash/grep/find assertion bodies — only their titles.
- **I did not read the implementation files** that these tests exercise (`src/core/agent-session.ts`, `src/core/session-manager.ts`, the compaction package, the extensions runner, …). Where a note explains *what* the behaviour is, it is taken from the test's assertion text; where it explains *why*, I have attributed it only to a comment or docstring that actually says so, and I have not inferred intent from the source. Any statement about the implementation's internals is therefore a statement about the contract the tests pin, not about the code.
- **The `agent-session-codemode.test.ts` "codemode models" block** (`:664-1030`) — the classifier/image-generation half of codemode — is characterised only from its test titles (`lists models and classifies with catalog auth, ignoring script-supplied fields`, `generates images with catalog auth and attaches them through image()`, `notes generated images that the script did not show`, `reports provider errors as results and invalid arguments as exceptions`). I did not verify the assertions themselves.
- **No test was executed.** The clone was treated as read-only and untrusted: nothing was installed, built, run or imported. Every statement about behaviour is read off the source of the test, never from a run.
