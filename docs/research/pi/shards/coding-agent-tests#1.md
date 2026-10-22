# pi / coding-agent-tests#1

## Shard shape

This shard is the **test suite of the `coding-agent` package only** — 68 files, all under `packages/coding-agent/test/`, no source, no docs, no other packages. It is the behavioural contract of the agent harness, written as executable assertions rather than prose. The shard falls into five clusters that mirror the harness's layers:

1. **Session/turn lifecycle** (`agent-session-*.test.ts`, `compaction*.test.ts`, `cache-warmer.test.ts`, `cache-stats.test.ts`, `default-tools-setting.test.ts`, `file-mutation-queue.test.ts`, `extensions-*.test.ts`) — the loop's contracts: the concurrent-prompt guard, steering vs follow-up queuing, auto-compaction triggers, overflow recovery, retry, the tool loadout, dynamic tool/provider registration, and the extension event bus.
2. **Storage/branching/compaction internals** (`compaction.test.ts`, `compaction-serialization.test.ts`, `compaction-nested-calls.test.ts`, `compaction-summary-reasoning.test.ts`, `export-jsonl-share.test.ts`) — how a session becomes a tree of entries, where a compaction cut may land, how a summary is produced, and what a share export carries.
3. **Credential/config plumbing** (`auth-storage.test.ts`, `auth-check.test.ts`, `credential-print.test.ts`, `config.test.ts`, `config-schemas.test.ts`, `config-value-migration.test.ts`) — the file-backed credential store, the generated JSON Schemas, and self-update.
4. **TUI/UI rendering** (`assistant-message.test.ts`, `collapsible-message-components.test.ts`, `edit-tool-no-full-redraw.test.ts`, `bash-execution-width.test.ts`, `codemode-renderer.test.ts`, `custom-message.test.ts`, `chat-viewport.test.ts`, `export-html-*.test.ts`, `ansi-utils.test.ts`) — what the terminal and the HTML export are allowed to print.
5. **Platform-adjacent utilities** (`clipboard*.test.ts`, `external-editor.test.ts`, `bug-report.test.ts`, `crash-log.test.ts`, `bash-close-hang-windows.test.ts`, `codemode-worker-*.test.ts`, `first-time-setup*.test.ts`, `experimental.test.ts`, `args.test.ts`, `documentation.test.ts`, `changelog.test.ts`).

The files fit together as a **contract suite for an extension-driven agent loop**: `AgentSession` owns the turn, `SessionManager` owns the entry tree, `ExtensionRunner` owns the hook bus, `AuthStorage` owns the credential file, and the tests pin the *seams* between them. A recurring and unusually valuable pattern is that the assertions are written as **negative contracts** — "this must NOT happen" (no full redraw, no orphan page, no double compaction, no tool result cut point, no success reported for an unverified write) — which is where a harness's real behaviour lives.

Several suites are `describe.skipIf(!API_KEY)` and hit a real model; those are the e2e layer (`agent-session-branching`, `agent-session-compaction`, `agent-session-tree-navigation`, `compaction-extensions`). The rest are hermetic and use fakes, mocks, or in-memory stores.

---

## Per-file notes

### packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts
- **Purpose:** Pins when automatic compaction fires and what it must NOT fire on.
- **Key abstractions:** `_runAutoCompaction(reason: "overflow" | "threshold", willRetry)` and `_checkCompaction(assistantMessage, skipAbortedCheck?)` reached through a cast (`session as unknown as { _runAutoCompaction: ... }`) because they are private; `estimateContextTokens` is the decision input.
- **Data flow:** An assistant message lands → `_checkCompaction` → `estimateContextTokens` over `session.agent.state.messages` → `_runAutoCompaction` → a `compaction_start`/`compaction_end` event pair.
- **Non-obvious design decisions:** The resume path checks the **AGENT-level** queue, not the session's own counter: `expect(session.pendingMessageCount).toBe(0); expect(session.agent.hasQueuedMessages()).toBe(true);` (`agent-session-auto-compaction-queue.test.ts:119-120`). Overflow recovery is attempted **exactly once** — a second `_checkCompaction` with the same overflow does not re-run it (`:181`). The `compaction_end` event carries a terminal, actionable message: *"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."* (`:186`).
- **Edge cases / failure handling:** An error assistant message with **zero usage** triggers threshold compaction only if a *post-compaction* successful assistant usage exists; stale pre-compaction usage and zero-usage messages are explicitly excluded (`:247-448`). The threshold is computed from the live model context window rather than a constant, so a catalog change cannot break the test (`:252-253`).
- **Surprising:** A compaction that happens while only agent-level messages are queued must **resume** rather than restart the turn; the queued messages survive the compaction.

### packages/coding-agent/test/agent-session-branching.test.ts
- **Purpose:** Forking a session at a user message.
- **Key abstractions:** `runtimeHost.fork(entryId)` returns `{ cancelled, selectedText }`; `session.getUserMessagesForForking()` returns `{ entryId, text }[]`.
- **Data flow:** `getUserMessagesForForking()` → `runtimeHost.fork(entryId)` → a new `AgentSession` whose message list is the prefix up to (not including) the fork point.
- **Non-obvious design decisions:** After a fork, `session.sessionFile` is a path but the file **does not exist yet** (`expect(existsSync(session.sessionFile!)).toBe(false);`) — the file is created lazily on first write, so a fork that is immediately discarded leaves no debris (`:107`).
- **Edge cases / failure handling:** In `--no-session` mode the fork is purely in memory and `sessionFile` is `undefined` (`:113`, `:128`).
- **Surprising:** Forking at the *middle* of a conversation keeps exactly the messages before the fork point and nothing after — the new session is empty of the abandoned work.

### packages/coding-agent/test/agent-session-compaction.test.ts
- **Purpose:** End-to-end manual compaction against a real model.
- **Key abstractions:** `session.compact()` → `{ summary, tokensBefore, firstKeptEntryId }`; session events `compaction_start` / `compaction_end`.
- **Data flow:** `session.compact()` → the summarizer → a `compaction` entry appended to the session file → `buildSessionContext()` produces a `compactionSummary` message at position 0.
- **Non-obvious design decisions:** The `compaction_end` event carries `{ reason: "manual", aborted: false, willRetry: false }` — the same event shape is reused for threshold/overflow, so a consumer can distinguish "we compacted" from "we compacted because we were about to retry" (`:195-203`).
- **Edge cases / failure handling:** Compaction must work in `--no-session` mode (in-memory) and must leave the session usable for further prompts (`:110-133`).
- **Surprising:** `session.messages[0].role` is `"compactionSummary"`, not `"user"` — the summary is a first-class message kind, not a user turn.

### packages/coding-agent/test/agent-session-concurrent.test.ts
- **Purpose:** The one-prompt-at-a-time guard and the steering/follow-up queue.
- **Key abstractions:** `session.prompt()`, `session.steer()`, `session.followUp()`, `session.pendingMessageCount`, `session.getSteeringMessages()`, `session.isStreaming`.
- **Data flow:** `prompt()` while streaming → throws; `steer()`/`followUp()` → queue and resolve to the literal `"queued"`; the queue drains into the next agent turn; a `queue_update` event reports `{ steering, followUp }`.
- **Non-obvious design decisions:** The refusal message **names the two doors that would have worked**: *"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."* (`:141`). Extension-originated steering is a first-class source: `pi.sendUserMessage("...", { deliverAs: "steer" })` produces an `input` event with `source === "extension"` (`:282`).
- **Edge cases / failure handling:** An extension `tool_call` handler must not fire before the agent's queued events have been persisted — the test snapshots the persisted role sequence and asserts it is `["system","user","assistant"]` at *both* tool-call points (`:477-480`). A slow (40 ms) `message_end` handler must not reorder persistence: the expected order is `system, user, assistant, toolResult, system, assistant` (`:621-628`).
- **Surprising:** `waitForStreaming()` polls `session.isStreaming` rather than sleeping a fixed time, with the comment "A fixed sleep is not enough under full-suite load" (`:119`).

### packages/coding-agent/test/agent-session-dynamic-provider.test.ts
- **Purpose:** An extension can add or override a model provider at runtime.
- **Key abstractions:** `pi.registerProvider(id, override | Provider)`; `ModelRuntime.registerProvider`.
- **Data flow:** Extension load → `session_start` → command handler → `registerProvider` → `ModelRuntime` → the **active model's** `baseUrl` changes → the next request uses it.
- **Non-obvious design decisions:** Both an *override object* (`{ baseUrl }`) and a *full native pi-ai `Provider`* are accepted, and both paths are tested separately (`:95-136` vs `:125-136`). The change is verified by capturing `model.baseUrl` **inside `streamFunction`**, not by reading a config field — i.e. the test proves the change reaches the wire.
- **Edge cases / failure handling:** Registration at *command time* (after the session is live) takes effect with **no reload** (`:138-157`).
- **Surprising:** A provider registered by an extension overrides the built-in provider of the same id, including its `baseUrl` — an extension can silently redirect a provider's traffic.

### packages/coding-agent/test/agent-session-dynamic-tools.test.ts
- **Purpose:** Tools registered after session start, and the provenance of every tool.
- **Key abstractions:** `pi.registerTool({ name, label, description, parameters, execute, promptSnippet?, promptGuidelines?, defaultActive? })`; `tool.sourceInfo` = `{ path, source, scope, origin }`.
- **Data flow:** `session_start` → `registerTool` → `session.bindExtensions({})` → the registry refreshes → the tool appears in `getAllTools()`, in `getActiveToolNames()`, and in the **system prompt** (both the `- name: snippet` line and the `promptGuidelines` lines).
- **Non-obvious design decisions:** A tool **without** `promptSnippet` is ACTIVE but **unadvertised**: it is callable but neither its name nor its description appears in the prompt (`:211-252`). That is progressive disclosure in the prompt dimension, independent of whether the tool is enabled. Every tool carries `sourceInfo` distinguishing `builtin` / `inline` / `sdk` and `origin: "top-level"` (`:149-160`).
- **Edge cases / failure handling:** The bash spawn hook sees `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` — and `exposeSessionEnvironment: false` removes all five (`:76-95`). The system prompt tells the model it can inspect them.
- **Surprising:** The model can discover its own run context (session id, file, provider, model, reasoning level) from the **environment of the tool it runs**, not from the prompt.

### packages/coding-agent/test/agent-session-retry.test.ts
- **Purpose:** Auto-retry of transient provider failures.
- **Key abstractions:** `settingsManager.applyOverrides({ retry: { enabled, maxRetries, baseDelayMs, maxAgentDelayMs } })`; events `auto_retry_start { attempt, delayMs }` and `auto_retry_end { success }`.
- **Data flow:** Provider stream pushes `{ type: "error" }` → the session classifies it as retryable → emits `auto_retry_start` → waits `delayMs` → re-issues the request → emits `auto_retry_end`.
- **Non-obvious design decisions:** The **agent-facing delay is capped independently of the provider's own backoff**: the observed delays are `[1, 2, 4, 5]` for `baseDelayMs: 1, maxAgentDelayMs: 5` (`:167`). The cap exists so the UI's "retrying in Ns" never shows an unbounded wait.
- **Edge cases / failure handling:** `prompt()` must wait for the **entire tool loop** after a successful retry, not unblock on the first `message_end` — the comment names the previous defect explicitly: *"Previously, _resolveRetry() on the first successful message_end would unblock waitForRetry() while the agent was still executing tools."* (`:237-242`). The test asserts the tool actually executed, the agent is not streaming, and a follow-up prompt does not hit "Agent is already processing" (`:314-322`).
- **Surprising:** A retry that produces a tool call is a *successful* retry: the whole subsequent tool loop belongs to the same `prompt()` call.

### packages/coding-agent/test/agent-session-runtime-events.test.ts
- **Purpose:** The session lifecycle event contract (`session_before_switch`, `session_shutdown`, `session_start`, `session_before_fork`).
- **Key abstractions:** `createAgentSessionRuntime(createRuntime, host)` → `runtimeHost` with `.session`, `.newSession()`, `.switchSession(file)`, `.fork(entryId)`, `.setBeforeSessionInvalidate(fn)`, `.setRebindSession(fn)`.
- **Data flow:** `runtimeHost.newSession()` → `session_before_switch` (cancellable) → `session_shutdown` → `beforeSessionInvalidate` → `rebindSession` → `session_start`.
- **Non-obvious design decisions:** The order is pinned exactly: `["session_shutdown", "beforeSessionInvalidate", "rebindSession"]` (`:201`). A **captured** extension `ctx` becomes a landmine after replacement, so instead of silently working it **throws with a long, actionable message** naming the four ways it goes stale and what to do instead: *"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession."* (`:202-204`).
- **Edge cases / failure handling:** Cancelling `session_before_switch` leaves the session file unchanged and no shutdown/start events are emitted (`:159-181`).
- **Surprising:** The events carry `reason` (`"new" | "resume" | "fork" | "startup"`) and `previousSessionFile` / `targetSessionFile`, so an extension can tell a switch from a fork without inspecting state.

### packages/coding-agent/test/agent-session-stats.test.ts
- **Purpose:** Session usage and cost accounting, and the *current* context estimate.
- **Key abstractions:** `session.getSessionStats()` → `{ tokens, cost, contextUsage: { tokens, contextWindow, percent } | undefined, totalMessages }`; `getUsageCostBreakdown(entries)`.
- **Data flow:** Session entries (messages, compaction, branch summary, usage rows) → `getSessionStats()` → cumulative totals **plus** a separate current-context figure derived from the last post-compaction assistant usage.
- **Non-obvious design decisions:** The two are deliberately separated: `tokens.input` covers **all** entries including history that compaction removed (375 000 after a compaction that dropped 180 000), while `contextUsage.tokens` is `null` right after a compaction — *unknown*, not zero (`:119-140`). A later post-compaction assistant message makes it known again (`:142-164`). Usage is grouped into `Tools/summaries` versus `provider/model` so tool spend is not billed to a model (`:268-291`).
- **Edge cases / failure handling:** A zero-usage assistant message after a compaction does not reset the context to unknown (`:293-315`). A `cache_warm` usage row counts toward totals but adds **no messages** (`:211-242`).
- **Surprising:** `contextUsage.tokens === null` is a first-class state meaning "not knowable right now", distinct from `0`.

### packages/coding-agent/test/agent-session-tree-navigation.test.ts
- **Purpose:** Navigating the entry tree, with optional branch summarization.
- **Key abstractions:** `session.navigateTree(entryId, { summarize, customInstructions })` → `{ cancelled, aborted, editorText, summaryEntry }`; `session.abortBranchSummary()`; `session.isCompacting`.
- **Data flow:** `navigateTree` → (optionally) summarize the abandoned branch → append a `branch_summary` entry → move the leaf → the target's text is placed in the editor.
- **Non-obvious design decisions:** The summary attaches to the **parent of the selected node**, not to the selected node — navigating to `u2` whose parent is `a1` yields a summary with `parentId === a1.id`, giving `a1` two children (`:108-145`). Custom instructions are appended as a labelled `Additional focus:` section (`:257-276`).
- **Edge cases / failure handling:** Aborting mid-summarization leaves the entries and the leaf **completely unchanged** and returns `{ cancelled: true, aborted: true }` with no summary entry (`:175-212`). Navigating to the current leaf is a no-op (`:238-255`).
- **Surprising:** Navigating to a *root* user message empties the conversation (leaf becomes `null`) and puts the text in the editor — the "edit this message" gesture.

### packages/coding-agent/test/ansi-utils.test.ts
- **Purpose:** `stripAnsi` must be byte-compatible with chalk's `strip-ansi`.
- **Key abstractions:** A locally reimplemented reference regex (`osc | csi`) and a generated corpus.
- **Data flow:** 248 generated escape inputs (18 hand-picked plus, for each of 23 introducer bytes, two single-byte forms and eight two-byte forms) → compared against the reference implementation.
- **Non-obvious design decisions:** The **error message is part of the contract**: for a non-string it must throw a `TypeError` whose text is ``Expected a `string`, got `object` `` (`:83-91`). The corpus includes unterminated OSC/DCS/APC strings and RIS, which is where naive strippers leak bytes.
- **Edge cases / failure handling:** `\x1bcdone` → `"done"` (the final byte is not leaked); single-byte ESC sequences `ESC g..m` and `ESC r..t` are stripped entirely (`:93-104`).
- **Surprising:** The implementation is validated against a *reference implementation of a dependency*, not against hand-written expectations — a differential test.

### packages/coding-agent/test/args.test.ts
- **Purpose:** The CLI argument grammar.
- **Key abstractions:** `parseArgs(argv)` → `{ version, help, print, continue, resume, provider, model, apiKey, systemPrompt, appendSystemPrompt[], session, sessionId, fork, export, thinking, models[], mode, name, noSession, extensions[], noExtensions, noMcp, skills[], promptTemplates[], themes[], useTheme, noSkills, noPromptTemplates, noThemes, noContextFiles, projectTrustOverride, verbose, offline, tuiMode, noTools, noBuiltinTools, tools[], excludeTools[], messages[], fileArgs[], unknownFlags: Map, diagnostics[] }`.
- **Data flow:** argv → a single pass that distinguishes flags, flag-values, `@file` arguments and positional prompts, collecting unknowns rather than failing.
- **Non-obvious design decisions:** **A flag never consumes the next option as its value**: `parseArgs(["--mode", "--version"])` reports `--mode requires text, json, or rpc` and still parses `--version` (`:182-188`). Unknown long flags are **captured into a map** with a string value, a boolean value, or an `=` value, so a wrapper can pass them through (`:533-546`). `--tools` accepts `+name`/`-name` modifiers but **refuses to mix them with plain names** and refuses patterns (`:468-491`).
- **Edge cases / failure handling:** Invalid enum values (`--mode yaml`, `--tui-mode other`) produce a structured `diagnostics` entry naming the valid set, and parsing continues (`:164-173`, `:418-423`).
- **Surprising:** `-p` does not stop option parsing: `parseArgs(["-p", "--provider", "openai", "Say hi."])` still yields `provider: "openai"` and one message (`:55-60`).

### packages/coding-agent/test/assistant-message.test.ts
- **Purpose:** The rendering contract of an assistant message in the TUI.
- **Key abstractions:** `AssistantMessageComponent(message, showThinking, …, outputPad, markdownTransformers)`; `UserMessageComponent`; `initTheme("dark")`.
- **Data flow:** Message content blocks → per-block markdown rendering (transformers applied) → a TUI component that renders at an arbitrary width.
- **Non-obvious design decisions:** OSC 133 zone markers (shell integration) are emitted **only** for messages with no tool calls — a tool call changes the shell prompt state, so the zone would lie (`:37-62`). Markdown transformers are a **live chain** that re-runs when the available width changes (`:193-214`) and **continues past a throw**: `expect(calls).toEqual(["first", "throw", "last"])` and the text still renders (`:216-243`). A transformer must not mutate the source message (`:245-264`).
- **Edge cases / failure handling:** A `stopReason: "length"` message renders the neutral wording "Response was truncated before completion." (`:64-75`). Adjacent thinking blocks coalesce into **one** "Thinking..." label and each run collapses independently on click (`:77-128`).
- **Surprising:** The transformer receives `{ messageType, isStreaming, availableWidth }` — a *streaming* message is rendered without the transform, so a partially-streamed block is not reflowed mid-flight (`:174-191`).

### packages/coding-agent/test/auth-check.test.ts
- **Purpose:** The `pi auth check` diagnostic.
- **Key abstractions:** `checkProviderAuth(args, runtime, { refresh })` → `{ status: "ready" | "not_ready" | "invalid", provider, authType?, reason? }`; `ReadOnlyAuthStorage`.
- **Data flow:** CLI args → provider resolution (`--provider` or `--model`) → credential read → status.
- **Non-obvious design decisions:** A stored `$MISSING_AUTH_CHECK_KEY` reference is **not configured** — an unresolved env reference must not read as "ready" (`:112-122`). The check is strictly read-only: it must not create the auth file **or its parent directory** (`:136-146`).
- **Edge cases / failure handling:** A malformed auth.json is reported as `invalid` / `invalid_state` rather than crashing (`:124-134`). OAuth refresh is opt-in via `{ refresh: true }`; the default read returns the stale token without refreshing (`:57-77`).
- **Surprising:** `--model openai/gpt-5.5` resolves the *provider* from the model id (`:44-55`).

### packages/coding-agent/test/auth-storage.test.ts
- **Purpose:** The file-backed credential store.
- **Key abstractions:** `AuthStorage.create(path)` / `.inMemory()`; `FileAuthStorageBackend.withLockAsync(update, { signal })`; `proper-lockfile`.
- **Data flow:** `read(providerId)` / `list()` / `modify(providerId, fn)` / `delete(providerId)` → a JSON file → resolved credentials (env reference, `!command`, OAuth).
- **Non-obvious design decisions:** **Reload coalescing:** three concurrent reads across two `AuthStorage` instances take exactly **one** lock (`:83-95`), and a *different path* takes a different lock (`:99-106`) — so the lock is per-file, not global. A credential may carry its own `env` scope, and the resolved `env` stays inspectable (`:57-70`). A `modify` that returns `undefined` leaves the credential unchanged (`:174-179`). A `modify` **preserves unrelated external edits** made to the file while the lock was held (`:158-172`).
- **Edge cases / failure handling:** Windows `EPERM` on lock acquisition (a delete-pending lock directory) is retried a **bounded** number of times — the test asserts exactly 6 attempts and that the mutation never ran (`:290-304`) — and is **not** retried on other platforms (`:306-316`). A compromised lock surfaces the `onCompromised` error and the mutation never runs (`:339-354`). A **malformed** auth.json is never overwritten: the file stays byte-identical (`:620-626`). An abort while waiting for the lock, an abort *during* the callback, and a pre-aborted call all reject with `AbortError` and never commit (`:356-447`).
- **Surprising:** The file is created with mode `0600` and an **existing** file's mode is preserved on write (`:142-156`); the abort tests also assert the lock is released exactly once and that a *competing* mutation only proceeds after the cancelled one settles (`:390-447`).

### packages/coding-agent/test/auth-url-copy.test.ts
- **Purpose:** Copying a long sign-in URL from the login dialog and the MCP sign-in screen.
- **Key abstractions:** `LoginDialogComponent.showAuth(url)` / `.showDeviceCode(...)`; `McpManagerView.redirectUrl(title, url, signal)`; the `ctrl+x` (`\x18`) key.
- **Data flow:** Key press → `copyToClipboard(url)` → a "Copied URL to clipboard" status line.
- **Non-obvious design decisions:** The copy key must **copy the URL rather than type into the code input** — the manual-code field is on screen at the same time (`:33-42`). The key is ignored entirely when there is no auth URL (`:44-49`).
- **Edge cases / failure handling:** A 300+ character URL is used to force the "too long to read" case.
- **Surprising:** The same keybinding contract is implemented in two unrelated surfaces (login dialog and MCP manager) and pinned by one test.

### packages/coding-agent/test/bash-close-hang-windows.test.ts
- **Purpose:** Windows-only: a command must resolve when the shell exits, even if a detached grandchild still holds the inherited stdio pipe.
- **Key abstractions:** `executeBashWithOperations(command, cwd, operations, { signal })`; `createBashTool(dir)`; `createLocalBashOperations()`.
- **Data flow:** A `node -e` script spawns a **detached** child with `stdio: 'inherit'` and unrefs it → the parent exits → the executor must not wait for the pipe.
- **Non-obvious design decisions:** The test spawns the exact failure shape rather than mocking it, and cleans up the detached grandchild with `taskkill /F /T /PID` (`:28-41`).
- **Edge cases / failure handling:** A 3 s watchdog aborts the command, so a regression fails as a timeout rather than a hang (`:90-98`).
- **Surprising:** The suite is `describe.skipIf(process.platform !== "win32")` — a platform-specific bug pinned only on the platform that has it.

### packages/coding-agent/test/bash-execution-width.test.ts
- **Purpose:** Regression #2569 — collapsed bash output must respect the **render-time** width.
- **Key abstractions:** `BashExecutionComponent(command, tui)`; `visibleWidth` from `pi-tui`.
- **Data flow:** `appendOutput(text)` → `setComplete(0, false)` → `render(width)` → the collapsed preview is re-wrapped.
- **Non-obvious design decisions:** The component is constructed against a 200-column TUI stub and rendered at 80 and then 60 columns; every rendered line's `visibleWidth` must be ≤ the render width (`:35-79`). The re-wrap happens at **render time**, not construction time.
- **Edge cases / failure handling:** The TUI stub exposes only `terminal.columns` and the interval API the loader needs — the test asserts on the narrow contract, not on the whole TUI.
- **Surprising:** A terminal resize (or a split pane) changes the width between renders; a component that cached the wrap at construction paints over the pane beside it.

### packages/coding-agent/test/block-images.test.ts
- **Purpose:** The `images.blockImages` setting.
- **Key abstractions:** `SettingsManager.getBlockImages()` / `.setBlockImages()`; `createReadTool(dir)`; `processFileArguments(paths)`.
- **Data flow:** Setting → the *display* layer; the tool layer is unchanged.
- **Non-obvious design decisions:** The setting is explicitly a **display-layer filter**: the read tool and the CLI file processor *always* return image content, and the comment says so twice — "filtering happens at convertToLlm layer" (`:73`, `:114`). A preference must not change what a tool did.
- **Edge cases / failure handling:** A BMP on disk is converted to a PNG attachment and a marker line `[Image converted from image/bmp to image/png.]` is added to the text (`:125-135`).
- **Surprising:** `blockImages` and `autoResize` are independent settings in the same `images` object (`:52-58`).

### packages/coding-agent/test/branch-summarization.test.ts
- **Purpose:** The branch-summary generator's contract.
- **Key abstractions:** `generateBranchSummary(entries, { model, signal, streamFn })` → `{ summary } | { error }`.
- **Data flow:** Abandoned branch entries → a stream request → a text summary.
- **Non-obvious design decisions:** The summary request **never overrides `toolChoice`** (`:47-65`) — the summarizer is a text task. A summary that contains a **tool call is an error**, not a result: `"Branch summarization attempted to call a tool"` (`:88`). A summary that hit the token cap is also an error: `"Branch summarization failed: generation hit the token cap and the summary is incomplete"` (`:110-112`).
- **Edge cases / failure handling:** A truncated summary is never returned as a partial summary.
- **Surprising:** An *incomplete* summary is treated as a failure of the whole operation, because a half-summary silently corrupts the branch it replaces.

### packages/coding-agent/test/branch-summary-extensions.test.ts
- **Purpose:** An extension may supply the branch summary itself.
- **Key abstractions:** `pi.on("session_before_tree", () => ({ summary: { summary, usage } }))`; `harness` fixture from `./suite/harness.ts`.
- **Data flow:** Navigation → the hook fires → the returned summary becomes a `branch_summary` entry with `fromHook: true`.
- **Non-obvious design decisions:** The entry records `fromId` (the abandoned source) and `fromHook: true`, so a reader can tell an extension-supplied summary from a model-generated one (`:49-50`). The extension's reported **usage** is added to the session totals (`:52-56`).
- **Edge cases / failure handling:** The summary attaches to the root's parent (`parentId: null`) when the target is the root entry.
- **Surprising:** A hook can take over a *model* decision entirely, and its own token spend is accounted for.

### packages/coding-agent/test/bug-report.test.ts
- **Purpose:** The `/bug` flow and the redaction applied to the report.
- **Key abstractions:** `reportBug({ session, ui, editorContainer, editor, keybindings, showStatus, showError })`; `redactUrl(href)`; `redactJsonValue(value)`.
- **Data flow:** Paste a description → the editor → three selector prompts (transcript? summary? delivery?) → the report.
- **Non-obvious design decisions:** Pasted text keeps its **line breaks** through the editor round-trip (`:22-86`). Redaction is **key-name based, not value-based**: `apiKey` and `headers.Authorization` become `"<redacted>"` while `compaction.reserveTokens: 16384` and `headers["X-Trace"]: "1"` survive (`:98-112`). URL credentials are removed (`https://user:pass@…` → `https://…`) and secret *query parameters* are replaced with the encoded `%3Credacted%3E` so the URL stays parseable (`:90-96`).
- **Edge cases / failure handling:** The delivery preview shows the multi-line description rendered across lines, proving the line breaks survived (`:73-76`).
- **Surprising:** Redaction targets the *key* `apiKey`/`Authorization`, so a value that merely looks secret is not redacted — and a token *count* is not a token.

### packages/coding-agent/test/builtin-tool-strict-mode.test.ts
- **Purpose:** `constrainedSampling` (provider-side JSON-schema strictness) on the built-in tools.
- **Key abstractions:** `createAllToolDefinitions(cwd)` / `createAllTools(cwd)`; `wrapToolDefinition(definition)`.
- **Data flow:** Definitions → `constrainedSampling: { type: "json_schema", strict: "prefer" }` → the provider converts it; the execution schema is untouched.
- **Non-obvious design decisions:** "Strictness is a provider-side conversion, not a change to the execution schema." The test asserts `definitions.read.parameters.required` is still `["path"]` and `definitions.bash.parameters.required` is still `["command"]` (`:29-31`) — the wire hint and the runtime validation are separate concerns and are pinned apart.
- **Edge cases / failure handling:** `wrapToolDefinition` must preserve an explicit opt-out (`constrainedSampling: false`) and the identity of `execute`, `prepareArguments`, `renderCall`, `renderResult`, `promptGuidelines` (`:34-47`). Only the five file-affecting tools get strict sampling; `grep`, `find`, `ls` do not (`:26-28`).
- **Surprising:** An extension that re-registers a built-in tool without strict sampling leaves the **system prompt byte-identical** — the prompt is a pure function of the active tool set, not of the wire format.

### packages/coding-agent/test/cache-stats.test.ts
- **Purpose:** Quantifying prompt-cache waste.
- **Key abstractions:** `computeCacheWaste(entries, models)` → `{ missedTokens, missedCost, missCount }`; `detectCacheMiss(entries, message, models)` → `{ missedTokens, missedCost, idleMs, modelChanged }`; `collectCacheMisses`.
- **Data flow:** Assistant messages with `cacheRead`/`cacheWrite` usage → a miss detector → a dollar figure.
- **Non-obvious design decisions:** A miss is priced as `(write price − read price) × missed tokens` — 105 000 tokens at ($3.75 − $0.30)/M = **$0.36225** (`:84-87`). The "miss" is a **re-pricing** of tokens the provider already billed, not extra tokens. The turn immediately after a **compaction reset** is skipped, because the prefix legitimately changed (`:95-100`). A **model switch** counts as a miss (`:102-107`). `detectCacheMiss` reports `idleMs` — the gap since the previous request — as the *cause* (`:134`).
- **Edge cases / failure handling:** Providers that report no cache activity contribute nothing (`:109-114`). Only `cache_warm` usage rows count as a cache refresh, not other usage kinds (`:150-162`).
- **Surprising:** The cost of a cache miss is invisible in the provider's own usage totals — it has to be reconstructed from the price table.

### packages/coding-agent/test/cache-warmer.test.ts
- **Purpose:** Warming the provider's prompt cache before the user returns.
- **Key abstractions:** `CacheWarmer(client, sessionManager, getMode, decide)`; `getPromptCacheTtlMs(model, settings)`; `getCacheWarmingDelayMs(ttl)`; `isReplayable(model, options)`; `formatCacheWarmingStatus` / `formatCacheWarmingUsage`.
- **Data flow:** A request ends → the warmer schedules a replay at `ttl − margin` → the economics are computed → an extension may override → the request is replayed (a "refresh") to re-populate the cache → a `usage` row with `kind: "cache_warm"` is recorded.
- **Non-obvious design decisions:** The economics are explicit: warming is worth it only when `expectedSavings ≥ warmCost`; the test pins `missCost ≈ 0.575` vs `warmCost ≈ 0.050025` (`:166-167`). The refresh deadline is **re-checked after the extension's async decision**, because the extension can move the clock (`:200-218`). An extension override is recorded in the usage row's note so the spend is attributable (`:236`, `:332-334`). The replay reuses the request's options but with a **fresh abort signal** (`:160`) so a superseded warm cannot cancel the live request.
- **Edge cases / failure handling:** Refusals: `cache warming disabled`, `cache lifetime unavailable` (model has no `promptCache`), `request cannot be replayed safely` (a reasoning model at a non-default reasoning level), `conversation context changed`, `agent run settled`. A replaced request is aborted and a failed refresh records **no** usage (`:285-308`).
- **Surprising:** `isReplayable` is false for a reasoning model with `reasoning: "medium"` — replaying a *reasoning* request is not side-effect-free enough to be worth it, so the warmer declines (`:140-144`).

### packages/coding-agent/test/changelog.test.ts
- **Purpose:** Rewriting changelog links for publication.
- **Key abstractions:** `normalizeChangelogLinks(markdown, entryOrVersion)`.
- **Data flow:** A changelog entry → package-relative links become tag-pinned GitHub URLs.
- **Non-obvious design decisions:** The rewritten URL is **pinned to the release tag** (`v0.79.0`), not to `main` (`:20-27`). A directory link becomes a `tree/` URL and a file link a `blob/` URL. Old repository URLs (`badlogic/pi-mono`) are canonicalized; external and local-anchor links are left alone (`:30-47`).
- **Edge cases / failure handling:** A link that already points at `main` is re-pinned to the tag (`:43`).
- **Surprising:** A changelog is a *published artifact* whose links must keep working after the branch moves; the fix is in the renderer, not the source markdown.

### packages/coding-agent/test/chat-viewport.test.ts
- **Purpose:** The scrollbar default of the chat viewport.
- **Purpose (restated):** One assertion: `createChatViewport` defaults the transcript scrollbar to `"auto"` and accepts a `"hidden"` override (`:23-24`).
- **Non-obvious design decisions:** The viewport takes five containers (document, pendingMessages, status, editor, footer) plus an optional `scrollbar` — the scrollbar is a viewport-level option, not a per-container one.

### packages/coding-agent/test/clipboard-command.test.ts
- **Purpose:** The subprocess wrapper behind every clipboard command.
- **Key abstractions:** `runClipboardCommand(command, args, { input?, timeoutMs?, maxBufferBytes? })` → `Buffer | undefined`.
- **Data flow:** Spawn → collect stdout → resolve a Buffer, or `undefined` on failure.
- **Non-obvious design decisions:** **Empty success is distinguished from failure**: exit 0 with no output is `Buffer.alloc(0)`, exit 1 is `undefined` (`:9-10`). Binary output survives intact, including a `0` byte (`:6-8`). A timeout does **not block the event loop** — an interval keeps ticking while the command hangs (`:20-31`). Output above `maxBufferBytes` is rejected (`:42-48`).
- **Edge cases / failure handling:** The child runs **outside pi's process group**, with the reason stated: *"clipboard daemons must not share pi's process group, or Ctrl+Z suspend stops them"* (`:32-33`).
- **Surprising:** `undefined` is the single "failed" signal, so a caller cannot distinguish "the tool is missing" from "the tool failed" — but it can distinguish "succeeded with nothing".

### packages/coding-agent/test/clipboard-image-bmp-conversion.test.ts
- **Purpose:** WSL2/WSLg hands out `image/bmp`; it must be converted to PNG.
- **Key abstractions:** `readClipboardImage({ platform, env })` → `{ bytes, mimeType } | null`.
- **Data flow:** A hand-built 1×1 24bpp BMP (58 bytes: 14-byte file header + 40-byte DIB header + 4-byte padded pixel row) → BMP → PNG.
- **Non-obvious design decisions:** The test asserts the PNG **magic bytes** (`0x89 0x50 0x4e 0x47`), not just the mime type (`:64`).
- **Edge cases / failure handling:** Both the command path and the native path are covered, on `linux` and `win32`.
- **Surprising:** The fixture is written byte-by-byte with explicit comments for every header field — the test is a BMP decoder in miniature.

### packages/coding-agent/test/clipboard-image-native-errors.test.ts
- **Purpose:** A native clipboard image failure must abort the whole paste.
- **Key abstractions:** `InteractiveMode.prototype.handleClipboardPaste` invoked directly with a stub `this` context.
- **Data flow:** Ctrl+V → file paths → image → text; a native error at the image step aborts everything.
- **Non-obvious design decisions:** The abort is total: no text read, no editor change, **no render request**, and exactly one error message (`:33-38`). Falling through to the text clipboard after an image error would paste something the user did not select.
- **Edge cases / failure handling:** `TERMUX_VERSION` is stubbed empty so the Termux path is not taken.
- **Surprising:** The test calls a *private* method off the prototype with a hand-built `this`, which keeps the unit test independent of the whole interactive mode.

### packages/coding-agent/test/clipboard-image.test.ts
- **Purpose:** The image-clipboard probe order.
- **Key abstractions:** `readClipboardImage({ platform, env })`.
- **Data flow:** Wayland (`wl-paste --list-types` then a typed read) → X11 (`xclip -t TARGETS -o`) → native → (on WSL) `wslpath` + `powershell.exe`.
- **Non-obvious design decisions:** The probe **stops** on the first backend that yields an image — an empty Wayland result does not fall through to stale X11 (`:33-44`). X11 does not probe image types the clipboard did not advertise, and does not probe at all if the `TARGETS` query failed (`:47-72`). A native **transfer error propagates** rather than falling back (`:140-154`).
- **Edge cases / failure handling:** On WSL, PowerShell is tried **before** a broken native X11 bridge, and the path is quoted for PowerShell (`$path = 'C:\Users\O''Hare\clip.png'`) (`:97-121`). Termux does not read image clipboards at all (`:156-160`).
- **Surprising:** The API takes `platform` and `env` as **parameters** rather than reading globals — the entire platform matrix is testable in one process.

### packages/coding-agent/test/clipboard-paste-file-paths.test.ts
- **Purpose:** Pasting file paths (a Finder copy) into the editor.
- **Key abstractions:** `InteractiveMode.prototype.handleClipboardPaste`; `readClipboardFilePaths()`.
- **Data flow:** Paste → file paths (if any) → else image → else text.
- **Non-obvious design decisions:** File paths **take precedence over their icon image** — the user copied files, not a picture of them (`:22-44`). A path containing terminal control characters is **rejected**, not sanitised: pasting `\x1b]0;unsafe\x07` into a terminal would rewrite the window title (`:46-66`). In bash mode the paths are **shell-quoted**: `'/tmp/$(touch hacked).png'` is quoted, so it is an argument, not a command (`:114-141`).
- **Edge cases / failure handling:** A native file-path error is shown and does **not** fall through to the image (`:68-87`). A leading space is inserted when the cursor is not at the start of the line, computed from the cursor column and the line's text (`:89-112`).
- **Surprising:** The same paste path is safe in chat mode and safe in bash mode, because the quoting is decided by `isBashMode` at the paste site.

### packages/coding-agent/test/clipboard.test.ts
- **Purpose:** The full clipboard text matrix across six platforms.
- **Key abstractions:** `copyToClipboard(text)`; `readClipboardText()`; the `PI_CLIPBOARD_OSC52` env override; OSC 52 escape capture by wrapping `process.stdout.write`.
- **Data flow:** native clipboard → platform command (`wl-copy`/`xclip`/`xsel`/`pbcopy`/`termux-clipboard-set`/`wslpath`+`powershell.exe`) → OSC 52 → throw.
- **Non-obvious design decisions:** The **order is fixed and each rung is verified**: a local native success skips OSC 52 and the commands entirely (`:123-128`); a native write is **awaited** before the remote OSC 52 is emitted (`:139-153`); on Linux the native writer is skipped entirely (`:129-138`). A **local** failure throws rather than falling through to OSC 52 — *"a local Linux failure does not report an unverified OSC 52 write as success"* (`:197-207`) — but in a **remote** session (SSH/WT) OSC 52 is the correct fallback (`:310-316`).
- **Edge cases / failure handling:** An oversized OSC 52 payload (80 000 chars) is refused with "text exceeds the OSC 52 size limit" (`:317-325`). Wayland **reads** stop at the first backend even when the content is empty (`:81-92`). WSL in Windows Terminal prefers OSC 52 over PowerShell, and uses PowerShell only when the payload is oversized (`:243-270`). The error message names the tool to install — "install `wl-clipboard` (`wl-copy`)" vs "install `xclip` or `xsel`" (`:279-288`).
- **Surprising:** The OSC 52 bytes are captured by **monkey-patching `process.stdout.write`**, so the assertion is on the exact escape sequence including the base64 payload and BEL terminator (`:172`).

### packages/coding-agent/test/codemode-renderer.test.ts
- **Purpose:** How a codemode script's result is rendered.
- **Key abstractions:** `codemodeRenderers.renderResult(result, { expanded, isPartial }, theme, context)`; `ToolExecutionComponent`.
- **Data flow:** A tool result with `details.calls` → one line per call → a "Model calls: $X" total → the script output.
- **Non-obvious design decisions:** The script header is hidden (`:50-59`). Each model call shows its own cost and a total line shows the sum (`:61-81`). Collapsed output is capped by **wrapped** lines, not logical lines — 1 000 characters at width 50 is 20 wrapped lines, and the cap counts those (`:94-112`).
- **Edge cases / failure handling:** A result with no `details` renders the bare message, so a rejected `@options` line is visible (`:83-92`). While running the label is "Elapsed 3.0s"; once settled it becomes "Took 5.1s" and "Elapsed" disappears entirely (`:115-129`).
- **Surprising:** The elapsed/total wording is different on purpose: a running duration is "Elapsed" (still moving) and a finished one is "Took" (a fact).

### packages/coding-agent/test/codemode-worker-admission.test.ts
- **Purpose:** Bounding the number of live codemode workers.
- **Key abstractions:** `executeCodemode(name, { code }, signal, …)`; `PI_CODEMODE_MAX_WORKERS`.
- **Data flow:** A script is submitted → admission control → a worker thread → the script runs → the worker **exits** → capacity is released.
- **Non-obvious design decisions:** At capacity a script **waits** rather than failing (`:76-109`); the wait has its own timeout with the message "Execution timed out after 50 ms while waiting for a free codemode worker". Capacity is released on **actual worker exit**, not on the result — releasing on the result would admit a script while the old worker is still holding memory (`:103-108`). A launch that resumes after its own timeout starts **no** worker (`:112-129`).
- **Edge cases / failure handling:** A script aborted while waiting reports "Script aborted: … The script did not start." (`:86-91`). An invalid `PI_CODEMODE_MAX_WORKERS=0` is **ignored** (falls back to the default of 2) rather than disabling all workers (`:163-172`).
- **Surprising:** The test replaces `Worker.prototype.terminate` with a promise it controls, so worker lifetime is **simulated** deterministically — `terminations.size` is the capacity gauge.

### packages/coding-agent/test/codemode-worker-config.test.ts
- **Purpose:** Choosing the codemode worker entrypoint per packaging.
- **Key abstractions:** `resolveCodemodeWorkerSpecifier(packaging, moduleUrl)`.
- **Data flow:** Packaging kind + the running module URL → a worker specifier.
- **Non-obvious design decisions:** Three distinct answers: a **relative** source path for Bun binaries, a `file://` URL beside the bundled module for bundled Node, and `undefined` (meaning "use the pi-codemode package's own worker") when unbundled (`:6-20`).
- **Edge cases / failure handling:** The Bun case is pinned to a *relative* path because an absolute `file://` URL is meaningless inside a single-file binary.

### packages/coding-agent/test/collapsible-message-components.test.ts
- **Purpose:** The three collapsible message components.
- **Key abstractions:** `CompactionSummaryMessageComponent`, `BranchSummaryMessageComponent`, `SkillInvocationMessageComponent`; `TuiMouseEvent`.
- **Data flow:** A click on the marker row toggles the body.
- **Non-obvious design decisions:** All three are collapsed by default and toggle on click, with the marker text `[compaction]`, `[branch]`, `[skill]` (`:39-82`).
- **Edge cases / failure handling:** The click target is located by searching the **rendered** lines for the marker, so a layout change does not break the test.

### packages/coding-agent/test/compaction-extensions-example.test.ts
- **Purpose:** The documented compaction extension must actually work.
- **Key abstractions:** The real `examples/extensions/custom-compaction.ts` is imported at module load (`:13`); `modelRegistry.complete(model, context, options)`.
- **Data flow:** The example extension registers `session_before_compact` → calls `modelRegistry.complete` → returns `{ compaction: { summary, firstKeptEntryId, tokensBefore } }`.
- **Non-obvious design decisions:** The example is **imported and executed**, not re-typed, so the documentation cannot drift from the code. The example's completion call carries **no `apiKey` option** — the credential comes from the model registry (`:117-126`) — so an extension can summarise without ever handling a raw key.
- **Edge cases / failure handling:** The assertion is a negative one: `expect(complete).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ apiKey: expect.anything() }))`.
- **Surprising:** A documented example is a *test asset*; drift between the doc and the code is a failing test, not a stale paragraph.

### packages/coding-agent/test/compaction-extensions.test.ts
- **Purpose:** The `session_before_compact` / `session_compact` extension contract.
- **Key abstractions:** `session_before_compact` → `{ cancel?: boolean; compaction?: { summary, firstKeptEntryId, tokensBefore } }`; `session_compact` → `{ compactionEntry, fromExtension }`.
- **Data flow:** `session.compact()` → the before-hook → (cancel | custom compaction | default) → the compaction entry is saved → the after-hook fires.
- **Non-obvious design decisions:** A hook may **cancel** the compaction entirely (`"Compaction cancelled"`, `:167`) or **replace** the summary (`:173-208`). A **throwing** extension is ignored and the default compaction runs, with `fromExtension: false` (`:231-276`). The before-handlers all run before the after-handlers, across extensions, in load order (`:278-351`).
- **Edge cases / failure handling:** The after-hook fires only after the entry is **saved**, so an extension that reads `session.sessionManager.getEntries()` sees it (`:210-229`).
- **Surprising:** `sessionManager`, `modelRegistry` and `model` moved **onto `ctx`** rather than onto the event — the event carries data, `ctx` carries services (`:151`, `:224`, `:382-384`).

### packages/coding-agent/test/compaction-nested-calls.test.ts
- **Purpose:** Which files a compaction should consider touched.
- **Key abstractions:** `createFileOps()`; `extractFileOpsFromMessage(message, fileOps)`; `computeFileLists(fileOps)` → `{ readFiles, modifiedFiles }`.
- **Data flow:** A tool result carrying `nestedCalls` → the nested `read`/`edit`/`write` calls are inspected → the file lists.
- **Non-obvious design decisions:** A codemode script's inner calls are attributed to the **right files**: `read a.ts` and `edit b.ts` are extracted from a single `codemode` tool result (`:6-26`). A nested `write` is *not* attributed to a file (it has `argumentsBytes`, not a path).
- **Edge cases / failure handling:** The `complete: false` flag on the nested call list is honoured — an incomplete list is still parsed.

### packages/coding-agent/test/compaction-serialization.test.ts
- **Purpose:** The transcript text handed to the summarizer.
- **Key abstractions:** `serializeConversation(messages)` → a flat text.
- **Data flow:** Messages → a `[Role]: text` transcript.
- **Non-obvious design decisions:** Tool results are truncated to **2 000 characters** with an explicit `[... 3000 more characters truncated]` marker (`:20-25`) — the marker tells the summarizer that it is looking at a fragment. User and assistant text is **never** truncated (`:47-78`). Thinking blocks are **omitted entirely** (`:80-108`).
- **Edge cases / failure handling:** A short tool result is not marked (`:28-45`).
- **Surprising:** The summarizer sees tool calls rendered as `[Assistant tool calls]: read(path="a.ts")` — the arguments are summarised in a stable, short form rather than dumped.

### packages/coding-agent/test/compaction-summary-reasoning.test.ts
- **Purpose:** How the summarizer is called and what it may return.
- **Key abstractions:** `generateSummaryWithUsage(messages, model, …, apiKey, …, thinkingLevel)`; `completeSummarization(model, context, options)`; `compact(preparation, model, apiKey, …, customInstructions)`.
- **Data flow:** Preparation → a summarizer request → a `CompactionResult` with a summary and usage.
- **Non-obvious design decisions:** **Every summarization uses a fresh routing session with `cacheRetention` forced to `"none"`** (`:105-115`) — the summarizer neither pollutes nor benefits from the conversation's prefix cache, and two summaries never share a session id. A caller-supplied `cacheRetention: "long"` is **overridden** to `"none"` (`:117-129`). The reasoning level is set only for reasoning-capable models, and is **absent** (not `"off"`) when thinking is off (`:232-270`). The prompt uses explicit clear boundaries — the transcript is labelled `# Conversation` and the instruction `# Instructions\nThe messages above are earlier context from an ongoing conversation.` — with the comment "clear boundaries and continuation wording avoid the reasoning-extraction false positive" (`:149-151`).
- **Edge cases / failure handling:** A summary containing a **tool call** is rejected ("Summarization attempted to call a tool", `:174-180`; "Turn prefix summarization attempted to call a tool", `:182-197`). A **length-capped** summary is rejected ("generation hit the token cap", `:199-230`). A split turn keeps the previous summary rather than starting blank. The usage of a split-turn summary is the **sum** of both calls (`:299-319`).
- **Surprising:** A `stopReason: "length"` summary is an error, not a degraded summary. A half-summary is worse than no summary because it silently replaces the history.

### packages/coding-agent/test/compaction.test.ts
- **Purpose:** The compaction arithmetic and the session-context builder.
- **Key abstractions:** `calculateContextTokens(usage)`; `estimateContextTokens(messages)` → `{ tokens, usageTokens, lastUsageIndex, trailingTokens }`; `getLastAssistantUsage(entries)`; `shouldCompact(tokens, contextWindow, settings)`; `findCutPoint(entries, start, end, keepRecentTokens)` → `{ firstKeptEntryIndex, turnStartIndex, isSplitTurn }`; `prepareCompaction(entries, settings)`; `buildSessionContext(entries)` → `{ messages, thinkingLevel, model }`; `compact(preparation, model, apiKey)`.
- **Data flow:** Session entries → `buildSessionContext` → the live message list; a token estimate → a decision → a cut point → a preparation → a summary → a `compaction` entry → a new context.
- **Non-obvious design decisions:** The context anchor is the **last non-zero, non-aborted** assistant usage (`:205-254`); an aborted or all-zero message is skipped, and `estimateContextTokens` adds a trailing estimate for the messages after that anchor (`:256-272`). `shouldCompact` fires when `tokens > contextWindow − reserveTokens` (`:274-295`). The **cut point may never land inside a tool result**: if the tail is an oversized tool result, the cut falls back to the latest *valid* cut point, which is the tool **call** — and the tool result is then summarised with the rest (`:378-411`, regression #9740). A **system** message is not conversation history: it is excluded from `messagesToSummarize` while the turn prefix is kept (`:501-520`). A re-compaction that would not move the window is **skipped** — `prepareCompaction` returns `undefined` (`:524-539`).
- **Edge cases / failure handling:** Cutting mid-turn sets `isSplitTurn: true` and `turnStartIndex` to the start of that turn (`:336-356`). A **custom-message** entry with `display: true` is budgeted as context-visible (`:358-375`). When a previous compaction exists and the window has moved past it, the previously kept messages are re-summarized, and the **previous summary is passed separately** rather than concatenated into the text (`:541-564`).
- **Surprising:** Only the **latest** compaction matters when rebuilding context — two compactions in one branch produce one summary, not two (`:448-469`).

### packages/coding-agent/test/config-schemas.test.ts
- **Purpose:** The generated JSON Schemas for `models.json`, `settings.json`, `keybindings.json` and themes.
- **Key abstractions:** `renderConfigSchemas()` → `Map<relativePath, content>`; `Compile(schema)` from `typebox/compile`.
- **Data flow:** The schema sources → rendered JSON → compared to the committed artifacts → compiled to validate documents.
- **Non-obvious design decisions:** The committed artifacts are compared **byte for byte** with the message *"schemas/models.schema.json is stale; run npm run generate:schemas"* (`:33-47`) — a generator drift is a failing test with the exact command to fix it. The **descriptions** in the schema are treated as content: the test asserts the theme schema still says "use compatible fallbacks" and the models schema still says "USD per million tokens" (`:49-88`). A legacy setting's description must say it is migrated ("Legacy setting migrated to steeringMode.", `:219-228`).
- **Edge cases / failure handling:** The schema must reject exactly what the runtime accessors reject: `reserveTokens: -1`, `keepRecentTokens: 1.5`, a `reserveTokens` above `MAX_SAFE_INTEGER`, `httpIdleTimeoutMs: "bogus"`, and it must accept `0` and `"disabled"` where the runtime does (`:187-217`). A `$schema` key is accepted in `models.json`, `settings.json`, `keybindings.json` and themes and is **not** treated as a configuration value (`:248-325`).
- **Surprising:** A `models.json` with unknown `compat` keys is accepted (custom provider options) while a *known* key with a wrong type is rejected — the schema is permissive where the space is open and strict where it is defined.

### packages/coding-agent/test/config-value-migration.test.ts
- **Purpose:** The migration that normalises env-var syntax in config values.
- **Key abstractions:** `runMigrations(agentDir)`; `ENV_AGENT_DIR`; `ModelConfig.load(modelsPath)`.
- **Data flow:** `auth.json` / `models.json` → `runMigrations` → the same files, possibly rewritten.
- **Non-obvious design decisions:** An **uppercase-looking** value (`"ANTHROPIC_API_KEY"`, `"$OPENAI_API_KEY"`) is left **exactly as it is** and nothing is logged (`:41-70`) — a migration that guesses a bare uppercase string is an env reference would corrupt a literal key. The same holds for provider `apiKey`, provider `headers`, per-model `headers` and `modelOverrides` headers (`:89-177`).
- **Edge cases / failure handling:** A **malformed** or empty `models.json` does not throw during migration and is **not rewritten**; the registry later reports "Failed to parse models.json" and names the file (`:72-87`).
- **Surprising:** The migration is verified by reloading the config and checking the *resolved* api key and headers, not just the file bytes — the file could be byte-correct and still resolve differently.

### packages/coding-agent/test/config.test.ts
- **Purpose:** Install-method detection and the self-update command.
- **Key abstractions:** `detectInstallMethod()` → `"npm" | "pnpm" | "yarn" | "bun" | "unknown"`; `getSelfUpdateCommand(pkg, npmCommand?, newPkg?)` → `{ command, args, display, steps? }`; `getUpdateInstruction(pkg)`; `getSelfUpdateUnavailableInstruction(pkg)`; `detectInstallChange(packageJsonPath)` → `{ kind: "removed" }`; `findNodePackageDir(dir)`.
- **Data flow:** `process.execPath` + `process.env.PATH` + `PI_PACKAGE_DIR` → a detected method → a command.
- **Non-obvious design decisions:** The detection reads the **filesystem** (a fake `pnpm`/`yarn`/`bun` shim on `PATH` that prints its root) rather than a heuristic, so a real install is identified by asking the package manager (`:53-148`). An **unknown** wrapper install refuses to self-update and says so in user-facing words (`:175-183`). A **non-writable** install path refuses to self-update (`:443-451`). A **renamed** package is a two-step operation (uninstall the old, install the new) expressed as `steps[]` (`:229-251`). A deleted install reports `{ kind: "removed" }` instead of falling back to a `package.json` further up the tree (`:456-463`).
- **Edge cases / failure handling:** A Windows path with a space is quoted in the display string (`:289-297`). A Windows `node_modules` path is **not** mistaken for a custom npm prefix (`:299-308`). The pnpm v11 layout (a store path plus a global link) is detected (`:349-390`).
- **Surprising:** The self-update command always passes `--ignore-scripts` and a minimum-release-age of 0 — the update is allowed to install a fresh release but never to run install scripts.

### packages/coding-agent/test/crash-log.test.ts
- **Purpose:** Attributing a crash to the extension that caused it.
- **Key abstractions:** `findExtensionStackMatches(stack, extensions)` → the matching extension sources.
- **Data flow:** A stack trace → each frame's file URL is decoded → compared against each extension's resolved path.
- **Non-obvious design decisions:** Attribution is by **stack frames only**, never by a path mentioned in the error *message* (`:65-70`). A **package** extension is matched by its **root directory**, so any file beneath it counts, and two entries of the same package **deduplicate** to one source (`:23-46`). A **single-file** extension is matched by its exact file, so a sibling `b.ts` is not attributed to `a.ts` (`:48-63`).
- **Edge cases / failure handling:** Windows paths are normalised (`:37-46`). A path with a space is percent-decoded per frame (`:72-88`).
- **Surprising:** The "do not attribute a sibling single-file package" case is the negative control for a naive "shares the base directory" matcher, which would blame every extension in the same folder.

### packages/coding-agent/test/credential-print.test.ts
- **Purpose:** `pi auth print-api-key` and `pi auth print-bearer-token`.
- **Key abstractions:** `resolveCredentialForPrint(args, runtime, "api_key" | "bearer_token")`; `parseAuthCommand(argv)`.
- **Data flow:** CLI args → provider/model resolution → the credential → stdout.
- **Non-obvious design decisions:** `--model` without `--provider` resolves **only among catalog models of configured providers** — an uncatalogued model id on a configured provider is not a match, so a typo cannot print the wrong provider's key (`:27-39`). An expired OAuth token is **refreshed before printing**, and the refreshed token is persisted (`:57-81`).
- **Edge cases / failure handling:** `--min-expiry` is accepted only for `print-bearer-token` and is rejected elsewhere (`:129-131`). An unknown option prints a usage hint and sets exit code 1 (`:83-99`). Printing an OAuth provider's key as an API key is refused ("configured with OAuth") (`:140-143`).
- **Surprising:** The credential-print path deliberately has a *different* model-resolution rule from the chat path.

### packages/coding-agent/test/custom-editor-history-keybindings.test.ts
- **Purpose:** Prompt history keys versus model cycling.
- **Key abstractions:** `CustomEditor`; `KeybindingsManager`; `editor.onAction("app.model.cycleForward", cb)`.
- **Data flow:** A key press → the keybinding table → either history navigation or the model-cycle action.
- **Non-obvious design decisions:** An **explicit** history binding wins over the default model-cycling binding: Ctrl+P recalls the previous prompt and `modelCycles` stays 0 (`:13-33`).
- **Edge cases / failure handling:** The editor is driven with real control characters (`\x10`, `\x0e`) through `handleInput`.

### packages/coding-agent/test/custom-message.test.ts
- **Purpose:** A custom (extension-defined) message block.
- **Key abstractions:** `CustomMessageComponent(message, renderer, …, outputPad)`; `MessageRenderOptions = { expanded, outputPad }`.
- **Data flow:** A custom message → the extension's `MessageRenderer` → a TUI component.
- **Non-obvious design decisions:** The component **passes `outputPad` into the render options** and updates it when `setOutputPad` is called, so an extension's renderer honours the same padding as the built-ins (`:10-43`).

### packages/coding-agent/test/default-tools-setting.test.ts
- **Purpose:** Which tools are active, and how that set is remembered.
- **Key abstractions:** `SettingsManager.getDefaultTools()`; `session.getAllTools()` / `.getActiveToolNames()` / `.setActiveToolsByName(names)`; `tools` / `excludeTools` / `noTools` / `customTools` options.
- **Data flow:** `defaultTools` (or the CLI `tools` option) → the active set → the system prompt; a change during a session → a **system message** carrying `toolsAdded` / `toolsRemoved` → the transcript → a later resume restores that exact loadout, per branch.
- **Non-obvious design decisions:** The loadout is **recorded in the transcript**, not in a settings file: `recordLoadoutChange` appends a `role: "system"` message with `toolsAdded`/`toolsRemoved` tool references (`:315-324`). On resume, that recorded loadout is restored — and **per branch**: navigating to a target branch restores *that branch's* loadout (`:386-398`). A reload only activates **newly added** tools; a tool the user disabled mid-session stays disabled, and removing a tool from the setting does not disable it (`:241-256`). `+name`/`-name` modifiers apply to the recorded loadout too (`:441-447`). Extension and SDK custom tools are always enabled regardless of the allowlist (`:100-142`).
- **Edge cases / failure handling:** A tool registered `defaultActive: false` stays inactive unless a `+name` modifier names it (`:82-98`). `noTools: "all"` beats everything, and `noTools: "builtin"` leaves extension tools alone (`:436-438`). A `tools` allowlist without `mcp__` entries keeps MCP tools registered but inactive (`:400-421`).
- **Surprising:** The tool set is **branch-local history**, not configuration. Two branches of the same session can legitimately have different tool sets, and resuming restores the right one.

### packages/coding-agent/test/documentation.test.ts
- **Purpose:** The documentation integrity gate.
- **Key abstractions:** `readNavigation()` from `docs/docs.json`; `navigationPaths()`; `markdownLinks()` via marked's `lexer`/`walkTokens`; `publicSlug(path)`.
- **Data flow:** `docs.json` → the nav roots → a breadth-first walk of local `.md` links → the reachable set → every `*.md` under `docs/` is compared against it.
- **Non-obvious design decisions:** The gate is a **reachability census**, not a link check: a page is orphaned unless it is reachable from the nav root (`:150-176`). Links are harvested with **marked's own lexer**, so a link inside a code fence or a table is not miscounted (`:113-119`). The nav schema itself is validated (no unknown fields, no absolute paths, no `..` escapes, no Windows syntax) (`:40-99`). The failure message aggregates *all* issues into one array so one run reports everything (`:177-185`).
- **Edge cases / failure handling:** Duplicate **public slugs** (two files mapping to the same URL) are caught separately from duplicate nav paths (`:140-148`).
- **Surprising:** An unreachable page is a failure — documentation that is not in the nav is documentation nobody can find.

### packages/coding-agent/test/edit-tool-legacy-input.test.ts
- **Purpose:** The edit tool's argument preparation.
- **Key abstractions:** `createEditToolDefinition(cwd).prepareArguments(input)`.
- **Data flow:** Raw model arguments → `prepareArguments` → the canonical `{ path, edits[] }`.
- **Non-obvious design decisions:** The legacy `oldText`/`newText` fields are folded into `edits[]` but are **kept out of the advertised schema** (`:21-25`) — the model is never shown a form it should not use, but an old model that still uses it is not broken. A legacy replacement is **appended** to an existing `edits` array (`:40-55`).
- **Edge cases / failure handling:** A JSON-string `edits` value is parsed; a non-JSON string is left alone rather than throwing (`:93-115`). Non-object input (`null`, `undefined`, `"garbage"`) passes through **untouched** (`:67-72`).

### packages/coding-agent/test/edit-tool-no-full-redraw.test.ts
- **Purpose:** The edit tool's TUI behaviour on a large diff.
- **Key abstractions:** `ToolExecutionComponent`; `computeEditsDiff(filePath, edits, cwd)`; a `FakeTerminal` that counts full clears (`\x1b[2J\x1b[H\x1b[3J`).
- **Data flow:** A 1 000-line file with 10 edits → a diff in `details` → the component renders the diff in the call preview, then the settled result.
- **Non-obvious design decisions:** The settled result must **not** force a full terminal clear: `expect(tui.fullRedraws).toBe(redrawsBeforeResult); expect(terminal.fullClearCount).toBe(clearsBeforeResult);` (`:144-145`). The preview must be **reconstructible from the settled result alone** — the file is deleted before the component is settled and the diff still renders (`:153-200`).
- **Edge cases / failure handling:** A preflight error (the edits do not apply) renders the error and **no diff** (`:202-235`).
- **Surprising:** The settled view **replaces** the "Successfully replaced N blocks" text with the diff, so the user sees the change, not a status line.

### packages/coding-agent/test/experimental.test.ts
- **Purpose:** The `PI_EXPERIMENTAL` gate.
- **Key abstractions:** `areExperimentalFeaturesEnabled()`.
- **Data flow:** The env var → a boolean.
- **Non-obvious design decisions:** Only the exact string `"1"` enables it — `"0"`, `"true"`, `""` and unset are all off (`:15-43`). A loose truthiness check would have made `"false"` enable experimental features.

### packages/coding-agent/test/export-html-cjk.test.ts
- **Purpose:** The HTML export's markdown parser and CJK emphasis.
- **Key abstractions:** `exportFromFile(sessionPath, outPath)`; a `node:vm` sandbox that loads the exported viewer and returns `safeMarkedParse`.
- **Data flow:** A session file → an exported HTML → the embedded viewer script is executed in a `vm` context with a stub `document` → `safeMarkedParse(text)`.
- **Non-obvious design decisions:** The viewer is executed in a **real sandbox** rather than asserted against with regexes, so the actual marked build is under test (`:10-29`). The CJK rule: emphasis delimited next to CJK punctuation renders (`**这是测试。**后面` → `<strong>这是测试。</strong>后面`) while **CommonMark flanking rules still apply to non-CJK text** (`**end.**Then next` → not emphasised) (`:55-65`).
- **Edge cases / failure handling:** The `vm` context is given only `atob`, `TextDecoder`, `URLSearchParams` and a minimal `document` — the viewer must not need more.
- **Surprising:** A CJK-aware emphasis rule that broke Latin text would be a much worse bug than the CJK bug it fixes; the negative control is explicit.

### packages/coding-agent/test/export-html-skill-block.test.ts
- **Purpose:** How a skill invocation renders in the HTML export.
- **Key abstractions:** `parseSkillBlock` in `src/core/export-html/template.js`.
- **Data flow:** A user message that embeds a `<skill name="..." location="...">…</skill>` wrapper → the export strips the wrapper.
- **Non-obvious design decisions:** The skill block and the user message are **sibling** blocks, matching the TUI layout where the skill invocation and the user message are siblings, not nested (`:16-27`). The skill body is rendered as **markdown** (`safeMarkedParse(skillBlock.content)`), not escaped text (`:29-33`). The sidebar tree shows both the skill name and the user prompt (`:35-39`).
- **Edge cases / failure handling:** The user-message div is emitted only when there is user content (`hasUserContent`).
- **Surprising:** The structural wrapper is an implementation detail of the *storage* format and must not leak into any rendered surface.

### packages/coding-agent/test/export-html-whitespace.test.ts
- **Purpose:** Whitespace in the exported HTML.
- **Key abstractions:** `ansiLinesToHtml(lines)`; `createToolHtmlRenderer({ getToolRenderers, theme, cwd })`.
- **Data flow:** Rendered TUI lines → HTML.
- **Non-obvious design decisions:** `white-space: pre-wrap` is applied to the **output line elements**, not to the container (`:13-18`) — otherwise the container's own indentation is preserved and the layout drifts. ANSI lines are emitted as separate `<div class="ansi-line">` with no source whitespace between them (`:20-22`).
- **Edge cases / failure handling:** TUI **padding** lines (empty lines at the top and bottom of a rendered block) are trimmed (`:24-41`).

### packages/coding-agent/test/export-html-xss.test.ts
- **Purpose:** The exported HTML's injection safety.
- **Key abstractions:** `sanitizeMarkdownUrl(href)`; `escapeHtml(value)`; marked's `link(token)` and `image(token)` renderers.
- **Data flow:** Session content → markdown → HTML → a browser.
- **Non-obvious design decisions:** The URL check is a **scheme allow-list** (`^(https?|mailto|tel|ftp)`), and C0 controls are **stripped before** the check, so `java\x00script:` cannot sneak past (`:18-21`). Every dynamic value that reaches `innerHTML` is escaped: `href`, `img.mimeType`, `img.data`, entry ids, `msg.toolName`, `msg.role`, `entry.modelId`, `entry.thinkingLevel`, `entry.type`, and the model list in the header (`:23-66`).
- **Edge cases / failure handling:** The test asserts both the *absence* of the unsafe form and the *presence* of the safe form, so a rename of the escaping helper does not silently disable the check.
- **Surprising:** The whole gate is **source-level regex assertions against `template.js`** — a deliberately cheap stand-in for a DOM-level test.

### packages/coding-agent/test/export-jsonl-share.test.ts
- **Purpose:** The shareable JSONL export.
- **Key abstractions:** `exportSessionForShare(path, session)`; `session.exportToJsonl(path)`.
- **Data flow:** The session entries → a JSONL file → a trailing `pi.share` entry → re-import via `SessionManager.open(path)`.
- **Non-obvious design decisions:** The share entry carries the **system prompt and the tool definitions** so a shared transcript is replayable (`:100-106`), and the conversation's ids and parent links are **unchanged** (`:83-85`). The share entry deliberately does **not** carry `renderedTools`, `theme` or `version` (`:107-109`).
- **Edge cases / failure handling:** The normal (non-share) export must **not** contain the share entry (`:72-74`). The re-imported session's leaf is the share entry and its context is the original three messages (`:111-117`).
- **Surprising:** A share file is a valid session file — the same `SessionManager.open` reads it back.

### packages/coding-agent/test/extensions-discovery.test.ts
- **Purpose:** Finding extensions on disk.
- **Key abstractions:** `discoverAndLoadExtensions(explicitPaths, cwd, agentDir)` → `{ extensions, errors, warnings, runtime }`; `loadExtensions(paths, cwd)` (explicit only, no discovery).
- **Data flow:** `<agentDir>/extensions/` → direct `.ts`/`.js` files and one level of subdirectories → a `package.json` with a `pi.extensions` list, or `index.ts`/`index.js` → each extension is loaded.
- **Non-obvious design decisions:** The **`package.json` `pi.extensions` list beats `index.ts`** in the same directory (`:243-266`). A `package.json` **without** a `pi` field falls back to `index.ts` (`:268-285`). A directory with neither is ignored, and discovery does **not** recurse past one level (`:287-311`). A `package.json` entry pointing at a non-existent path is skipped silently (`:334-352`). A `~`-prefixed path in a package manifest is package-relative and is kept distinct from a `~/`-prefixed one (`:197-220`).
- **Edge cases / failure handling:** An extension whose code fails to parse, throws during initialisation, or has no default export is reported as an error and is **not** loaded (`:374-382`, `:434-462`). An extension that imports the host package is still a **local** extension, not a package extension — the loader does not infer ownership from an ancestor `package.json` (`:72-105`, regression #9863).
- **Surprising:** A local extension that happens to `import "@earendil-works/pi-coding-agent"` is not mistaken for a vendored package.

### packages/coding-agent/test/extensions-input-event.test.ts
- **Purpose:** The `input` extension hook — the door through which every user message passes.
- **Key abstractions:** `runner.emitInput(text, images, source, streamingBehavior?)` → `{ action: "continue" | "transform" | "handled", text?, images? }`.
- **Data flow:** User input → every registered handler in order → the accumulated result → the prompt.
- **Non-obvious design decisions:** **Transforms chain**: each handler receives the previous handler's transformed text (`"X"` → `"X[1]"` → `"X[1][2]"`) (`:69-76`). Omitting `images` **preserves** the original images; supplying them replaces them (`:48-67`). `handled` **short-circuits** the remaining handlers (`:78-86`). A **throwing** handler is caught, reported through `onError`, and the input **continues** (`:110-117`). The `source` (`interactive` / `rpc` / `extension`) and `streamingBehavior` (`steer` / `followUp`) are passed to every handler (`:88-108`).
- **Edge cases / failure handling:** No handlers, an `undefined` return, and an explicit `continue` all produce the same result (`:37-46`).
- **Surprising:** The hook set is small and total: *continue* (pass through), *transform* (rewrite), *handled* (consume). There is no "reject" — the error path is the error channel.

### packages/coding-agent/test/extensions-runner.test.ts
- **Purpose:** The extension runner's whole surface: registration, conflicts, chaining, errors, and the event-subscription contract.
- **Key abstractions:** `ExtensionRunner(extensions, runtime, cwd, sessionManager, modelRegistry)`; `bindCore(actions, contextActions)`; `bindCommandContext(ctx)`; `setUIContext(ui, mode)`; `emit*` methods; `onError(cb)`; `getShortcuts(keybindings)`; `getAllRegisteredTools()`; `getRegisteredCommands()` / `getCommandDiagnostics()`; `resolveToolRenderers(name, next)`.
- **Data flow:** Extension factories → the runtime registry → the runner's merged view → the core's actions are bound in → the core calls `emit*` to reach the extensions.
- **Non-obvious design decisions:** The **reserved shortcut set is computed from the CURRENT keybindings**, not hardcoded — a shortcut is allowed the moment the default it shadowed is rebound (`:193-215`). A **reserved action** blocks an extension shortcut outright; a **non-reserved** built-in only warns and the extension wins (`:217-243`). A reserved action bound to **multiple** keys blocks if **any** of them is reserved (`:292-314`). Tool name collisions keep the **first** registration; command name collisions are **suffixed** `:1`/`:2` in insertion order and reported through `getCommandDiagnostics()` (`:428-462`, `:511-535`). A tool registered **without a parameter schema** rejects the **whole extension** with a specific message (`:403-426`, regression #9300). A flag whose `default` does not match its `type` also rejects the extension (`:807-825`). The `user_bash` hook **fails closed**: a throwing handler, or any of six malformed return shapes, rejects with "Invalid user_bash handler result" (`:630-681`, regression #9068). The `before_agent_start` system-prompt chain is **live**: `ctx.getSystemPrompt()` returns the current chained prompt so each extension appends to it (`:850-891`). `ctx.scopedModels` is a lazy getter that is `[]` (never `undefined`) before `bindCore` (`:115-127`).
- **Edge cases / failure handling:** A `before_provider_headers` handler that throws is **isolated** and the other handlers still apply (`:1408-1438`). A `tool_result` patch from a later handler **merges** with, rather than replaces, the earlier one (`:1109-1150`). A boundary proposal that fails validation is **reported** and a later handler may **repair** it (`:983-1029`); mutations a handler made **before** it threw are **kept** (`:1031-1058`). A provider registered before `bindCore` is **queued**; after `bindCore` it applies immediately, and an invalid provider registration is reported with the extension path and does not throw (`:1153-1223`).
- **Surprising:** The event-subscription contract is pinned in unusual detail: a handler removed during a dispatch **still runs in that dispatch**; a handler registered during a dispatch is **deferred to the next**; and a **nested** dispatch uses a **fresh** handler list (`:1307-1367`). Without that last rule, a handler that emits an event would infinitely recurse.

### packages/coding-agent/test/external-editor.test.ts
- **Purpose:** `$EDITOR` integration.
- **Key abstractions:** `editInExternalEditor({ command, content })` → `{ status: "complete", content } | { status: "failed" }`.
- **Data flow:** The prompt → a temp file → the editor command → the file is read back → the temp directory is removed.
- **Non-obvious design decisions:** The edit happens in a **private temporary directory** named `pi-editor-*` whose mode is `0700` and which is **removed afterwards** (`:36-50`). The editor receives a file called `prompt.md` (`:43`).
- **Edge cases / failure handling:** A **failed** editor keeps the original content and removes the directory (`:52-57`); an editor that empties the file yields empty content, not the original (`:58-62`).
- **Surprising:** The directory mode assertion is skipped on Windows, where POSIX modes do not apply.

### packages/coding-agent/test/file-mutation-queue.test.ts
- **Purpose:** Serialising concurrent writes to the same file.
- **Key abstractions:** `withFileMutationQueue(path, fn)`; `createEditTool(dir, { operations })`; `createWriteTool(dir, { operations })`.
- **Data flow:** A tool call → the queue for that file → the read-modify-write → the result.
- **Non-obvious design decisions:** The queue key is the **real path**, so a symlink alias of the same file shares the queue (`:77-98`). Different files proceed **in parallel** (`:56-75`). The edit and write tools **share** one queue, so a mixed edit+write on the same file is serialised (`:131-174`).
- **Edge cases / failure handling:** An **aborted** write keeps the queue **locked until the in-flight write actually settles** — a second write does not start, and the first one still rejects with "Operation aborted" (`:176-219`); the same holds for the edit tool (`:221-273`). Releasing the lock on abort would let a second writer interleave with the first write's tail.
- **Surprising:** Two parallel edits to the same file both survive (`ALPHA\nBETA\ngamma`) — the second edit re-reads the file inside the lock rather than operating on a stale snapshot.

### packages/coding-agent/test/first-time-setup-fork.test.ts
- **Purpose:** First-time setup in a forked distribution.
- **Key abstractions:** `PACKAGE_NAME` (mocked to `@example/pi-coding-agent`); `shouldRunFirstTimeSetup(settingsPath)`.
- **Data flow:** Package name + env + settings file presence → a boolean.
- **Non-obvious design decisions:** A **forked** package name suppresses the setup wizard even with `PI_EXPERIMENTAL=1` (`:36-38`).
- **Edge cases / failure handling:** The module under test is mocked *before* import, so the constant is read at module-evaluation time.

### packages/coding-agent/test/first-time-setup.test.ts
- **Purpose:** The first-run wizard's entry condition, and the analytics opt-in.
- **Key abstractions:** `shouldRunFirstTimeSetup(settingsPath)`; `SettingsManager.getEnableAnalytics()` / `.getTrackingId()`.
- **Data flow:** Env + agent dir + settings file → a boolean.
- **Non-obvious design decisions:** Three conditions must **all** hold: experimental on, the **default** agent dir, and no `settings.json` (`:36-56`). Analytics default to **off** with **no tracking id**; the id is minted **only on opt-in** and is **kept** across toggles (`:59-94`).
- **Edge cases / failure handling:** A custom `PI_AGENT_DIR` disables the wizard (`:46-50`).

### packages/coding-agent/test/fixtures/assistant-message-with-thinking-code.json
- **Purpose:** A fixture of a real assistant message containing a thinking block and code.
- **Key abstractions:** A single `AssistantMessage` JSON object: `content = [{ type: "thinking", thinking, thinkingSignature }, { type: "text", text }]`, plus `api`/`provider`/`model`/`usage`/`cost`/`stopReason`/`timestamp`.
- **Data flow:** The fixture is loaded by a test that renders a message with thinking and code.
- **Non-obvious design decisions:** The `thinking` and `thinkingSignature` values are **long single-line strings** (thousands of characters) that carry a genuine model reasoning trace about the SDK's model-resolution API — they exist so the renderer sees realistic content, not lorem ipsum.
- **Edge cases / failure handling:** The reader truncated both long lines to 2 000 characters; the remaining tail of the `thinkingSignature` (a base64-ish opaque blob) and of the `thinking` string were not read in full. The `text` block (the visible answer) was read in full and contains the same design discussion.
- **Surprising:** The fixture's `usage` shows a real 91 605-token turn with an 89 775-token cache read — a realistic cache-heavy turn.

---

## Ideas worth stealing

- **A refusal message that names the door that would have worked** — `packages/coding-agent/test/agent-session-concurrent.test.ts:141` — `"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."` The refusal is a *teaching* event: it names the two legal alternatives in the same sentence. August's harness refuses a lot of things (a permission refusal, a policy refusal, a budget refusal); a refusal that names the alternative door is worth more than a refusal that names the prohibition. The August analogue is `_authority_refusal` and the `Blocked:` marker: the message should say what the caller *could* have done.

- **Two different queues, and only one of them is the one you must check** — `packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts:119-120` — `expect(session.pendingMessageCount).toBe(0); expect(session.agent.hasQueuedMessages()).toBe(true);` A compaction that consults only the session's own counter would conclude "nothing is pending" and drop the queued turn. August has the identical hazard: the Bot DM path reads the **persisted** `messages` table because the arriving message is flushed at the model-dispatch barrier, and the AGENT-side queue is a different surface. The generalisable rule: *name both queues in the code, and assert the one that matters in a test*.

- **Bounded, escalating repair of a bad request, with an honest terminal state** — `packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts:181` and `:186` — the overflow recovery is attempted **exactly once** and the terminal `compaction_end` event says *"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."* This is the same shape as August's `_stuckRequestEscape` ladder (first refusal ignored, second flattens, third sends only the newest ask, fourth does not fire): a bounded number of escalating repairs, and a failure that is *reported* rather than hidden. The transferable piece is the pairing: **each rung has a test that asserts it was not reached twice**.

- **A summary that is truncated or that calls a tool is an ERROR, not a degraded result** — `packages/coding-agent/test/compaction-summary-reasoning.test.ts:177-179` and `:206-208`, mirrored for branches at `packages/coding-agent/test/branch-summarization.test.ts:88` and `:110-112` — `"Summarization attempted to call a tool"`, `"generation hit the token cap"`, `"Branch summarization failed: generation hit the token cap and the summary is incomplete"`. August's compaction currently degrades: a summary that missed analysis is admitted with a footer saying "decisions, constraints and next steps were not analyzed". pi's rule is stricter and simpler: **an unusable summary must not replace the history**. Either refuse the compaction or keep the original window.

- **The summarizer prompt marks the transcript as PAST context, not as a new instruction** — `packages/coding-agent/test/compaction-summary-reasoning.test.ts:149-151` — the request contains `# Conversation\n[User]: Summarize this.` and `# Instructions\nThe messages above are earlier context from an ongoing conversation.`, with the comment "clear boundaries and continuation wording avoid the reasoning-extraction false positive". This is the concrete defence against a compaction summary that reads as a fresh user ask (the classic "ignore previous instructions" leak through a summarised transcript). August's compaction prompt needs the same two headings and the same explicit "this is earlier context" sentence.

- **Every summarization runs in a FRESH session with prompt caching forced off** — `packages/coding-agent/test/compaction-summary-reasoning.test.ts:105-115` — `expect(requestOptions.every((options) => options?.cacheRetention === "none")).toBe(true);` and `expect(sessionIds[0]).not.toBe(sessionIds[1]);`. A caller's `cacheRetention: "long"` is overridden back to `"none"` (`:117-129`). Why it transfers: the summarizer is a *side* request. If it shares the conversation's prefix it pollutes the cache the next turn depends on; if it benefits from the cache it is billed at a different rate than the accounting assumes. August's `scrubOutboundBody` and cost estimator both assume one well-understood price per call site.

- **The compaction cut point may never land inside a tool result, and falls back to the tool CALL** — `packages/coding-agent/test/compaction.test.ts:378-411` (regression #9740) — with a large trailing tool result the cut lands on the assistant message that issued the call, `isSplitTurn: true`, `turnStartIndex: 2`, and the tool result is summarised along with the rest. This is exactly the class of defect August's AGENTS.md describes for the landmark-pin loop ("the projection could open with a `role: tool` result right after the system message … That 400s every provider"). The transferable rule: **a cut must land on a safe unit**, and when the only candidates are unsafe, the fallback is the *previous safe unit*, not a compromise.

- **A system message is not conversation history** — `packages/coding-agent/test/compaction.test.ts:501-520` — with `keepRecentTokens: 1` the preparation yields `messagesToSummarize: []` and `turnPrefixMessages: [user]`, and the system message is simply not part of the history. August writes its compaction summary as a **user** row with no provenance, which is why `_turnAuthor` has to special-case it; pi keeps the kinds distinct so the kind itself answers the question.

- **The tool loadout is recorded in the TRANSCRIPT and restored per branch** — `packages/coding-agent/test/default-tools-setting.test.ts:315-324` (the `role: "system"` message carrying `toolsAdded`/`toolsRemoved`) and `:386-398` (navigating to a branch restores *that branch's* loadout) — this turns "which tools are live" from mutable configuration into **branch-local history**. August has no equivalent: its tool set is a settings key plus a session-scoped allowlist, so a resumed or forked session can legitimately disagree with what the transcript says. The mechanism is cheap (one extra system entry kind) and it removes a whole class of "why is this tool missing?" bug.

- **Per-realpath serialisation of file mutations, and the lock is held until an aborted write actually settles** — `packages/coding-agent/test/file-mutation-queue.test.ts:77-98` (a symlink alias shares the queue) and `:176-219` (an aborted write keeps the queue locked; the second write does not start until the first write's tail has landed). The second half is the sharp one: aborting a write that is already in flight and immediately releasing the lock is how an aborted write and a concurrent write interleave. August's `read_file`/`write_file`/`edit` path has the same shape, and its hash-anchored edit gate depends on the file not changing underneath it.

- **A credential store that coalesces reloads under ONE lock and never commits an aborted mutation** — `packages/coding-agent/test/auth-storage.test.ts:83-95` (three concurrent reads across two instances take exactly one lock) and `:356-447` (a pre-aborted call, an abort while waiting, and an abort during the callback all reject with `AbortError`, the mutation never runs, and the file is not even created). The transferable pattern is a **read coalescer keyed on the file**, plus the rule that an abort must be checked at three different points (before the lock, while waiting for it, and after acquiring it). August's `scrubOutboundBody` stamp is the same shape of problem: a stat-stamped cache that must not go stale and must not be poisoned by a failed read.

- **A malformed credential file is never overwritten** — `packages/coding-agent/test/auth-storage.test.ts:620-626` — the modify rejects and the file is still byte-identical `"{invalid-json"`. A repair path that "fixes" an unparseable file destroys the evidence the user needs and can silently reset their keys. August's migrations have the same hazard around `providers.json` and `config.json`.

- **A platform-specific retry is bounded and does not leak to other platforms** — `packages/coding-agent/test/auth-storage.test.ts:290-316` — on Windows a delete-pending lock directory makes `mkdir` fail with `EPERM`; the backend retries a **fixed** number of times (the test asserts exactly 6 calls and that the mutation never ran) and the same error on Linux is **not** retried at all. This is August's "one tokenizer" and "the port must be injected" rule applied to retries: a Windows workaround must be a Windows workaround.

- **The economics of an action are computed explicitly, and an extension override is recorded in the ledger** — `packages/coding-agent/test/cache-warmer.test.ts:166-167` (`missCost ≈ 0.575` vs `warmCost ≈ 0.050025`) and `:232-237` (a forced warm is stored with the note `"extension override"`) and `:334` (`"Cache warmed (extension override): $0.029497"`) — an override is *visible in the usage ledger*, so a later reader can tell an automatic action from an instructed one. August has the same need for the cache-warmer analogue and for `_authority_refusal`, and the same answer: the decision goes in the record, not only in the log.

- **The safe deadline is re-checked AFTER an async decision** — `packages/coding-agent/test/cache-warmer.test.ts:200-218` — the extension's `decide` callback advances the clock before returning, and the warmer then refuses to issue the refresh ("cache refresh deadline missed"). The rule: **any async extension in the path invalidates a deadline checked before it**. August's `check:sse` gate is about the *supply* of a handler; this is about the *timing* of a decision, and both are the same lesson — a hook in the path is part of the computation.

- **A prompt-cache miss is a RE-PRICING, and the accounting says so** — `packages/coding-agent/test/cache-stats.test.ts:84-87` — 105 000 missed tokens at ($3.75 − $0.30)/M = **$0.36225**, computed from the *difference* between the write and read prices, and the turn after a compaction reset is **skipped** because the prefix legitimately changed (`:95-100`). August's `cost_estimator.price_for_model` is the only pricing source, and `logger.get_stats` was found billing every token at a flat rate; the transferable idea is that a cache miss is a *derived* cost with its own price difference, computed from the same price table, not a new token count.

- **A hook that routes a command must FAIL CLOSED** — `packages/coding-agent/test/extensions-runner.test.ts:630-681` — a throwing `user_bash` handler rejects, and so do six malformed return shapes ("{}", "null operations", "operations without exec", "a null result", "an incomplete result", "operations and a result"), each with the message "Invalid user_bash handler result". The generalisation: a hook whose result selects a **privileged path** must be validated exhaustively, and an unparseable result must deny rather than default to "the original behaviour". This is the same shape as August's `_authority_refusal` and its `deny set` philosophy.

- **A hook that fails must not silently erase what earlier hooks did** — `packages/coding-agent/test/extensions-runner.test.ts:1031-1058` — a boundary handler pushes an entry and then throws; the entry is **kept** and the error is reported. And a later handler returning a **partial** patch merges with the earlier one rather than replacing it (`:1109-1150`). Both are "merge, don't replace" contracts for a plugin chain, and both are needed the moment August lets an extension rewrite tool results.

- **The event-subscription contract during dispatch is pinned precisely** — `packages/coding-agent/test/extensions-runner.test.ts:1307-1367` — a handler removed during a dispatch **still runs in that dispatch**; a handler registered during a dispatch is **deferred to the next**; a **nested** dispatch uses a **fresh** handler list. The last rule is what stops a handler that emits an event from recursing forever. Any harness with a plugin event bus has to answer these three questions; pi answers them in a test rather than in a comment.

- **An extension's tool without a parameter schema is rejected at LOAD time, and the whole extension fails to load** — `packages/coding-agent/test/extensions-runner.test.ts:403-426` — the error names the extension path and the tool, and `result.extensions` has length 0. A tool the model cannot call (no schema) is worse than no tool, and shipping it is worse than refusing the extension. The same rule applies to a flag whose default does not match its type (`:807-825`).

- **A stale context object throws with a message that names the four ways it goes stale and what to do instead** — `packages/coding-agent/test/agent-session-runtime-events.test.ts:202-204` — *"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession."* A long error message is a deliberate design choice here: the failure mode is silent (a captured context would keep working against a dead session), so the message has to carry the whole remedy.

- **A live getter, never `undefined`, for a context value that may not be bound yet** — `packages/coding-agent/test/extensions-runner.test.ts:115-127` — `ctx.scopedModels` is `[]` before `bindCore` and the *same reference* afterwards. The same "live getter" pattern makes the `before_agent_start` system prompt chain compose: `ctx.getSystemPrompt()` returns the current chained prompt, so extensions append rather than overwrite (`:850-891`).

- **A tool can be ACTIVE but UNADVERTISED** — `packages/coding-agent/test/agent-session-dynamic-tools.test.ts:211-252` — a tool with no `promptSnippet` is callable and enabled but neither its name nor its description appears in the system prompt. Progressive disclosure in the *prompt* dimension, independent of enablement, and it is pinned by a test that asserts both the positive (active) and the negative (absent from the prompt). August's `tool_search` → `tool_call` route is the same idea at a different layer.

- **Every tool carries provenance** — `packages/coding-agent/test/agent-session-dynamic-tools.test.ts:149-160` — `sourceInfo: { path, source: "builtin" | "inline" | "sdk", scope, origin }`. A UI can show where a tool came from, and a policy layer can decide per source. August already has per-tool capability rules; attaching provenance to the tool object is the missing half.

- **The model can discover its own run context from the tool environment** — `packages/coding-agent/test/agent-session-dynamic-tools.test.ts:76-95` — the bash tool's child process gets `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`, and the system prompt tells the model so. An opt-out (`exposeSessionEnvironment: false`) removes all five. This moves five facts out of the prompt and into the environment, where they cost nothing per turn.

- **A display preference must not change what a tool did** — `packages/coding-agent/test/block-images.test.ts:73` and `:114` — the read tool and the CLI file processor always return image content; the `blockImages` filter is applied at the `convertToLlm` layer. August's `blockImages` equivalent (if any) must live at the same boundary, or a "show me images" toggle will silently change the tool result the model sees.

- **Strictness is a provider-side conversion, not a schema change** — `packages/coding-agent/test/builtin-tool-strict-mode.test.ts:29-31` — `constrainedSampling: { type: "json_schema", strict: "prefer" }` is set on the five file-affecting built-ins while the **execution schema's `required` list is unchanged**, and `grep`/`find`/`ls` get nothing. The wire hint and the runtime validation are different contracts and the test pins them apart, so tightening one cannot quietly tighten the other.

- **Do not report success for a write you could not verify** — `packages/coding-agent/test/clipboard.test.ts:197-207` — a local Linux failure **throws** rather than falling through to an OSC 52 escape that might not have been delivered; the same code path in a *remote* session does fall through, because there OSC 52 is the only transport (`:310-316`). Oversized payloads are refused outright (`:317-325`). August's `scrubOutboundBody` and the `is_error`/receipt vocabulary have the same shape of bug class: a marker that reads as success when it is not.

- **A flag never consumes the next option as its value, and unknown flags are captured rather than rejected** — `packages/coding-agent/test/args.test.ts:182-188` and `:533-546` — `parseArgs(["--mode", "--version"])` reports "--mode requires text, json, or rpc" *and* still parses `--version`; an unknown `--flag value` lands in an `unknownFlags` map so a wrapper can forward it. August's own CLI is not the reference here, but the *rule* — an option-looking token is never a value — is a cheap correctness win.

- **A "committed artifact" gate that compares byte for byte and names the command that fixes it** — `packages/coding-agent/test/config-schemas.test.ts:41-46` — the failure message is *"schemas/models.schema.json is stale; run npm run generate:schemas"*. August's `check:docs` and `check:brain-config` are the same genre; the transferable refinement is that the *generated* artifact is compared to the *committed* one, so "somebody edited the JSON by hand" and "the generator changed" are the same failure with one remedy.

- **A reachability census, not a link check** — `packages/coding-agent/test/documentation.test.ts:150-185` — the gate walks from the `docs.json` navigation root through local markdown links (harvested with **marked's own lexer**, so a link in a code fence is not counted) and then fails if any `*.md` under `docs/` is unreachable, if a nav path is duplicated, if a public slug collides, or if a link is broken. The idea generalises to any "is this thing still reachable?" question August asks — a docs page, a skill, a brain key, a tool — and the implementation trick (use the *renderer's* lexer, not a regex) is what makes it accurate.

- **A settled result must not force a full terminal redraw, and the preview must be reconstructible from the settled result alone** — `packages/coding-agent/test/edit-tool-no-full-redraw.test.ts:144-145` and `:153-200` — the second test deletes the file before the component settles, and the diff still renders, because the diff lives in the tool result's `details` and not in a live re-read. August's transcript re-renders on every stream chunk; the "reconstructible from the settled result" property is what lets a renderer skip work.

- **Collapsed output is capped by WRAPPED lines, not logical lines** — `packages/coding-agent/test/codemode-renderer.test.ts:94-112` — 1 000 characters at width 50 is 20 visual lines, and the cap counts those. A logical-line cap would let one long line blow past the cap. August's collapsed tool output has the same choice to make, and the wrong answer is invisible until a user pastes a 200 KB single-line log.

- **A running duration and a finished duration are worded differently** — `packages/coding-agent/test/codemode-renderer.test.ts:115-129` — "Elapsed 3.0s" while the script runs, "Took 5.1s" once it has settled, and "Elapsed" disappears entirely. The same distinction August already makes in the transcript ("Running a command 1m 18s" versus a settled line with no duration) — the test pins it so a refactor cannot quietly unify the two.

---

## Files skipped (with reasons)

None. Every one of the 68 files in this shard was opened and read.

The one file whose content I did **not** read in full is `packages/coding-agent/test/fixtures/assistant-message-with-thinking-code.json`: it is a 33-line JSON fixture whose two long values (`thinking` and `thinkingSignature`) are single-line strings that the reader truncated to 2 000 characters each. I read the whole structure (the object shape, the block types, the `usage`/`cost`/`stopReason`/`timestamp` fields) and the entire visible `text` block; the unread tails are the end of a model reasoning trace and the end of an opaque signature blob, neither of which carries structural information about the harness. It is marked `read` in the ledger because the file was opened and its purpose established, and the truncation is noted above and in the ledger.

No file in this shard is generated, vendored, binary, or large enough to warrant a skip.

---

## Uncertainties

- **I did not read the implementation these tests exercise.** Every note above is derived from the *assertions* in the test files, not from the source. Where a test pins a message string I have quoted it, but I cannot say with certainty how the corresponding production code is structured (e.g. `AgentSession._runAutoCompaction` and `AgentSession._checkCompaction` are reached through `as unknown as {...}` casts, which proves they are private but not how they are implemented). The source lives in `packages/coding-agent/src/`, which is a different shard.
- **Several suites are `describe.skipIf(!API_KEY)`** (`agent-session-branching`, `agent-session-compaction`, `agent-session-tree-navigation`, `compaction-extensions`, and the LLM block in `compaction.test.ts`). I read their assertions but could not observe their runtime behaviour; in particular the exact prompt sent to the summarizer is only partially visible (through the `# Conversation` / `# Instructions` assertions in `compaction-summary-reasoning.test.ts:150-151`), so the **full** summarizer system prompt is not established by this shard.
- **The `test/suite/` directory is not in my shard** — the grep I ran for two of the quoted strings also matched `packages/coding-agent/test/suite/agent-session-queue.test.ts`, `test/suite/agent-session-prompt.test.ts`, `test/suite/agent-session-compaction.test.ts` and `test/suite/regressions/*.test.ts`. Those files belong to other shards; I mention them only because they show that the same contracts are pinned a second time in a harness-style suite, which suggests the "suite" directory is the newer, preferred home for these tests. I did not read them.
- **`helper` fixtures were not read.** `packages/coding-agent/test/utilities.ts`, `test/suite/harness.ts` and `test/model-runtime-test-utils.ts` are imported by these tests (`createTestSession`, `createHarness`, `createModelRegistry`, `getModelRuntime`, `assistantMsg`, `userMsg`) but are not in my shard, so I know their names and call signatures only from the call sites. In particular I could not verify what `createTestSession` does about a real API key or whether `createHarness` uses a faux provider.
- **The `apiKey` argument threading in the compaction path is ambiguous from this shard alone.** `generateSummaryWithUsage(messages, model, …, "test-key", …)` takes an explicit key in the tests, while the documented *example* extension calls `modelRegistry.complete(...)` with **no** `apiKey` option (`compaction-extensions-example.test.ts:117-126`). I therefore cannot say whether the key is required, optional, or ignored by the production summarizer — only that the example deliberately does not pass one.
- **`createExtensionRuntime` / `registerProvider` queueing semantics** are visible only from the runner's side (`extensions-runner.test.ts:1153-1223`); the runtime object itself (`pendingProviderRegistrations`) is in the source tree.
- **Line numbers** in the "Ideas worth stealing" section are the ones as read in this session; if the clone is updated, they will move.
