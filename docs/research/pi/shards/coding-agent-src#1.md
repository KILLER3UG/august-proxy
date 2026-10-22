# pi / coding-agent-src#1

## Shard shape

This shard is the **whole `packages/coding-agent/src/` tree** of the pi harness — 152 files, the single TypeScript package that implements the coding agent. It divides into five layers that stack cleanly:

1. **Agent core** (`core/agent-session.ts` and friends) — one `AgentSession` class owns the run lifecycle: prompt intake, steering/follow-up queues, the request projection, compaction triggers, retry/backoff, tool loadout, and the dispatch of every agent event to extensions. Around it sit `agent-session-runtime.ts` (session replacement: new/resume/fork/import) and `agent-session-services.ts` (cwd-bound services).
2. **Session store** (`core/session-manager.ts`) — an append-only JSONL tree of typed entries. The important part is that model context is a *projection* computed from the tree (`buildSessionProjection`), with `context_edit` entries that can omit or rewrite an earlier entry's contribution without deleting anything.
3. **Tool layer** (`core/tools/*`) — eight built-in tools, each a `ToolDefinition` (schema + description + prompt snippet + execute + renderers) with pluggable `*Operations` interfaces so the same tool can drive a remote host. Truncation, output accumulation, diffing and path resolution are shared helpers. Renderers live in a separate directory so a render-only process never loads the execution path.
4. **Extension system** (`core/extensions/*` + `extensions/*`) — a loader that compiles TypeScript extensions with jiti, a runner that owns event dispatch and staleness, a 2.3k-line type contract, and four built-in extensions (MCP, codemode, tool_search, llama.cpp).
5. **Model/provider layer** (`core/model-*.ts`, `core/provider-composer.ts`, `core/virtual-models.ts`) — a `ModelRuntime` that composes built-in providers with `models.json` and extension registrations, resolves credentials, and supports "virtual models" that route each request to a physical model.

Compaction (`core/compaction/*`) sits between the agent core and the session store: it picks a cut point in the tree, asks the model for a structured summary, and appends a `compaction` entry that carries its own system-message snapshot.

The repo is a **monorepo**; the agent loop proper (`@earendil-works/pi-agent-core`) and the provider layer (`@earendil-works/pi-ai`) live in sibling packages, so this shard sees their *call sites*, not their implementation.

---

## Per-file notes

### packages/coding-agent/src/bun/cli.ts
- Purpose: entry point of the Bun compiled binary.
- Key abstractions: three side-effect imports in order.
- Data flow: `sandbox-env-setup` → `runtime-setup` → shared `../cli.ts`.
- Non-obvious design decisions: the binary entry deliberately re-exports the *same* CLI as Node, so there is one argument parser.
- Edge cases / failure handling: n/a (3 lines).
- Surprising: the Bun entry is a shim, not a re-implementation.

### packages/coding-agent/src/bun/quickjs-wasm.d.ts
- Purpose: ambient module declaration for `quickjs-wasi/quickjs.wasm`.
- Key abstractions: `declare module` with a `default: string` path.
- Data flow: n/a (type only).
- Non-obvious design decisions: Bun's default loader evaluates a `.wasm` import to its *path*; the declaration teaches TypeScript that.
- Edge cases / failure handling: n/a.
- Surprising: a 3-line `.d.ts` is load-bearing for the whole codemode sandbox.

### packages/coding-agent/src/bun/restore-sandbox-env.ts
- Purpose: recover `process.env` inside sandboxes where Bun reports an empty environment.
- Key abstractions: `restoreSandboxEnv()`.
- Data flow: reads `/proc/self/environ`, splits on NUL, sets `process.env`.
- Non-obvious design decisions: only acts when `process.env` is empty **and** `process.versions.bun` is set; the comment says "Keep this in sync with `getBunSandboxEnvValue()` in packages/ai/src/utils/provider-env.ts" — an explicit duplicated-lookup hazard.
- Edge cases / failure handling: unreadable `/proc` is silently ignored.
- Surprising: Linux-only workaround for a Bun bug (oven-sh/bun#27802) that is duplicated in two packages.

### packages/coding-agent/src/bun/runtime-setup.ts
- Purpose: Bun runtime bootstrap.
- Key abstractions: module-level side effects.
- Data flow: sets `process.title`, replaces `process.emitWarning` with a no-op, registers Bun OAuth flows, injects the Bedrock provider module, and records the embedded QuickJS wasm path.
- Non-obvious design decisions: silencing `process.emitWarning` globally — Node warnings would corrupt a TUI.
- Edge cases / failure handling: n/a.
- Surprising: the wasm import is a *path*, embedded in the compiled binary.

### packages/coding-agent/src/bun/sandbox-env-setup.ts
- Purpose: restore the sandbox environment before anything reads it.
- Key abstractions: one import statement.
- Data flow: `restoreSandboxEnv()` at module load.
- Non-obvious design decisions: ordering matters — the comment says "Restore the environment before evaluating modules that read it at startup."
- Edge cases / failure handling: n/a.
- Surprising: a whole file whose only content is an import.

### packages/coding-agent/src/cli.ts
- Purpose: Node CLI entry.
- Key abstractions: `setupCli()` then `main(argv)`.
- Data flow: argv → `main`.
- Non-obvious design decisions: the process setup is separated from `main` so the SDK can reuse `main` without the global side effects.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/coding-agent/src/cli/args.ts
- Purpose: the CLI flag grammar.
- Key abstractions: `Args` interface, `parseArgs()`, `printHelp()`, `isValidThinkingLevel()`.
- Data flow: `string[]` → `Args` (with `messages[]`, `fileArgs[]`, `unknownFlags: Map`).
- Non-obvious design decisions: unknown flags are *collected* into a map rather than rejected immediately, because extensions can register their own flags and the loader must be able to report "unknown option --x" only after it knows the registered flag set (`agent-session-services.ts:applyExtensionFlagValues`).
- Edge cases / failure handling: `getToolListError` rejects mixing plain tool names with `+name`/`-name` modifiers, and rejects patterns in modifiers.
- Surprising: `--tools` has two different grammars depending on whether modifiers are used.

### packages/coding-agent/src/cli/auth-check.ts
- Purpose: `pi auth check` readiness probe.
- Key abstractions: `checkProviderAuth()` → `{status, provider, reason?, authType?}`; `createAuthCheckModelRuntime()` builds a network-free runtime.
- Data flow: args → provider → `modelRuntime.checkAuth()` → typed status.
- Non-obvious design decisions: `refresh: true` re-reads the credential *after* the check, so a refresh that fails downgrades `ready` to `not_ready`.
- Edge cases / failure handling: any thrown error becomes `invalid_state` rather than propagating.
- Surprising: the check builds its own `ModelRuntime` with `allowModelNetwork: false` and `refreshOnCreate: false` so it cannot be slowed by a catalog fetch.

### packages/coding-agent/src/cli/auth-command.ts
- Purpose: parsing/validation for the `auth` subcommands.
- Key abstractions: `AuthCommand`, `parseAuthCommand()`, `validateAuthCommandArgs()`, `getAuthCredential()`.
- Data flow: argv → typed `AuthCommand` → validated provider/model.
- Non-obvious design decisions: `getAuthCredential` falls back to parsing a `Bearer` token out of the `authorization` header, so OAuth providers without an explicit `apiKey` still work.
- Edge cases / failure handling: `--min-expiry` is rejected for subcommands that do not support it; `--json/--credentials/--no-refresh` only for `check`.
- Surprising: `auth` requires at least one of `--provider`/`--model`; there is no "print everything".

### packages/coding-agent/src/cli/config-selector.ts
- Purpose: TUI resource selector for `pi config`.
- Key abstractions: `selectConfig(options)`.
- Data flow: settings + resolved paths → `ConfigSelectorComponent` in a `TuiMainScreen`.
- Non-obvious design decisions: the theme is initialised *before* the TUI is constructed, otherwise the first frame renders unstyled.
- Edge cases / failure handling: `process.exit(0)` on the cancel path.
- Surprising: the selector resolves both global and project scopes and can write either.

### packages/coding-agent/src/cli/credential-print.ts
- Purpose: print one provider's API key or OAuth bearer token.
- Key abstractions: `resolveCredentialForPrint()`.
- Data flow: args → model resolution → `modelRuntime.getAuth()` → single credential string.
- Non-obvious design decisions: it deliberately goes through `ModelRuntime.getAuth()`, which *refreshes and persists* OAuth credentials with less than five minutes of validity left — the comment says so explicitly.
- Edge cases / failure handling: refuses when several providers match ("Specify --provider"); distinguishes "configured with OAuth, not an API key" from "not configured".
- Surprising: printing a token is a side-effecting operation by design.

### packages/coding-agent/src/cli/file-processor.ts
- Purpose: turn `@file` arguments into prompt text and image attachments.
- Key abstractions: `processFileArguments()` → `{text, images}`.
- Data flow: `@path` → `resolveReadPath` → mime sniff → text block or image attachment.
- Non-obvious design decisions: an image that cannot be processed still becomes a `<file name=...>` text block carrying the error, so the model is not silently deprived of the reference.
- Edge cases / failure handling: empty files are skipped; a missing file is a hard `process.exit(1)`.
- Surprising: the text wrapper is `<file name="...">`, XML-shaped, so the model can tell it from user prose.

### packages/coding-agent/src/cli/initial-message.ts
- Purpose: compose the first prompt for non-interactive runs.
- Key abstractions: `buildInitialMessage()`.
- Data flow: stdin + @file text + first CLI message → one `initialMessage`.
- Non-obvious design decisions: the first CLI message is *shifted out* of `parsed.messages` and concatenated; the parts are joined with no separator, so ordering is stdin, file, message.
- Edge cases / failure handling: undefined when there is nothing to send.
- Surprising: the parts are joined with `""` — the caller is responsible for the newlines.

### packages/coding-agent/src/cli/list-models.ts
- Purpose: print available models as an aligned table.
- Key abstractions: `listModels()`, `formatTokenCount()`.
- Data flow: `modelRuntime.getAvailable()` → fuzzy filter → column widths → table.
- Non-obvious design decisions: a `models.json` load error is a *warning* on stderr, not a failure — the table still prints.
- Edge cases / failure handling: no models → `formatNoModelsAvailableMessage()`; no matches → explicit message.
- Surprising: it uses the TUI's `fuzzyFilter` so the CLI and the interactive picker match identically.

### packages/coding-agent/src/cli/project-trust.ts
- Purpose: build the `ProjectTrustContext` UI for the CLI.
- Key abstractions: `createProjectTrustContext()`.
- Data flow: settings + mode → select/confirm/input/notify implementations.
- Non-obvious design decisions: every prompt returns the "unavailable" value in non-interactive modes (select → `undefined`, confirm → `false`), which is what makes "no UI ⇒ untrusted" fall out correctly.
- Edge cases / failure handling: `notify` degrades to `console.error` with a colour.
- Surprising: `mode` is mapped to `"tui"` only for interactive mode.

### packages/coding-agent/src/cli/session-picker.ts
- Purpose: TUI session picker for `--resume`.
- Key abstractions: `selectSession()`.
- Data flow: two loaders (current dir / all) → `SessionSelectorComponent`.
- Non-obvious design decisions: it installs a `KeybindingsManager` and calls `setKeybindings()` so the picker obeys user keybindings.
- Edge cases / failure handling: cancel resolves `null`.
- Surprising: two loaders so the picker can show "all sessions" alongside "this project".

### packages/coding-agent/src/cli/setup.ts
- Purpose: global CLI setup.
- Key abstractions: `setupCli()`.
- Data flow: sets `process.title`, `PI_CODING_AGENT=true`, `AI_AGENT=pi`, silences warnings, and configures the undici dispatcher.
- Non-obvious design decisions: the comment says the dispatcher is configured *before provider SDKs issue requests*, and that settings are applied later once `SettingsManager` has loaded.
- Edge cases / failure handling: n/a.
- Surprising: `AI_AGENT=pi` is set for other tools that sniff the environment.

### packages/coding-agent/src/cli/startup-ui.ts
- Purpose: first-run setup, theme init, extension selector, package manager.
- Key abstractions: `shouldRunFirstTimeSetup()`, `showFirstTimeSetup()`, `showStartupSelector()`, `showStartupInput()`.
- Data flow: settings + packages → TUI components.
- Non-obvious design decisions: theme resolution (`resolveThemeSetting`, terminal colour detection) happens here so every later screen starts with a settled theme.
- Edge cases / failure handling: experimental features are gated by `areExperimentalFeaturesEnabled()`.
- Surprising: the same module owns the "official package" identity check (`@earendil-works/pi-coding-agent`).

### packages/coding-agent/src/config.ts
- Purpose: install-method detection, path resolution, self-update command construction.
- Key abstractions: `isBunBinary`, `isBunRuntime`, `isBundledNode`, `detectInstallMethod()`, `getAgentDir()`, `getDocsPath()`, `getReadmePath()`, `getPackageDir()`.
- Data flow: `import.meta.url` / `process.execPath` → install method → per-package-manager self-update command.
- Non-obvious design decisions: `getInferredNpmInstall()` refuses to infer a Windows global prefix from path shape alone, because a Windows global prefix is indistinguishable from a local project install — it needs `npm root -g` evidence. That refusal is stated in a comment.
- Edge cases / failure handling: an unknown install method yields no self-update command rather than a guess.
- Surprising: the file mixes runtime detection with self-update policy in one 650-line module.

### packages/coding-agent/src/core/agent-session-runtime.ts
- Purpose: own the live `AgentSession` and replace it for new/resume/fork/import.
- Key abstractions: `AgentSessionRuntime`, `CreateAgentSessionRuntimeFactory`, `SessionImportFileNotFoundError`.
- Data flow: `switchSession/newSession/fork/importFromJsonl` → `teardownCurrent` → `createRuntime(...)` → `apply(...)` → `finishSessionReplacement`.
- Non-obvious design decisions: `teardownCurrent` calls `session.abort()` *first* so the aborted turn (including tool results) is persisted to the outgoing session before it is replaced. `beforeSessionInvalidate` is a synchronous hook for host-owned UI teardown that "must not yield to the event loop".
- Edge cases / failure handling: `assertSessionCwdExists` throws `MissingSessionCwdError` when a session's recorded cwd is gone; a fork at the root creates a *new* session file that points at the parent.
- Surprising: `withSession` receives a *fresh* command context bound to the replacement session — the old context is invalidated.

### packages/coding-agent/src/core/agent-session-services.ts
- Purpose: create the cwd-bound services a session needs.
- Key abstractions: `createAgentSessionServices()`, `AgentSessionServices`, `AgentSessionRuntimeDiagnostic`.
- Data flow: cwd + agentDir → `ModelRuntime` + `SettingsManager` + `DefaultResourceLoader` → flush extension-registered providers/models.
- Non-obvious design decisions: extension provider registrations are *queued* during extension load and flushed here, one provider at a time, each wrapped in try/catch so one bad registration becomes a diagnostic rather than a startup crash. The runtime then refreshes with `allowNetwork: false`.
- Edge cases / failure handling: unknown extension flags and a string flag given a boolean produce `error` diagnostics; the app layer decides whether to abort.
- Surprising: services are recreated whenever the effective session cwd changes.

### packages/coding-agent/src/core/agent-session.ts
- Purpose: the core abstraction for agent lifecycle and session management, shared by every run mode.
- Key abstractions: `AgentSession` (class), `AgentSessionConfig`, `AgentSessionEvent` union, `parseSkillBlock()`.
- Data flow: `prompt()` → `_startRun()` → `_prepareRun()` → `agent.prompt()` → loop of `_handlePostAgentRun()` / `_runBeforeSettleBoundary()` / `agent.continue()` → `_emitAgentSettled()`. Events flow out through `subscribe()`; every `message_end` is persisted to the `SessionManager`.
- Non-obvious design decisions (many, and all load-bearing):
  - The agent's *model-visible context* is not `agent.state.messages`; it is `sessionManager.buildSessionProjection().messages`, installed as a `prepareRequest` hook (`_installAgentRequestProjection`, line 787). The tree is the source of truth; the agent's state is a cache.
  - Tool interception lives on the `Agent` (`beforeToolCall`/`afterToolCall`, line 652) rather than in per-tool wrappers, so extension reload swaps the runner without reinstalling hooks.
  - `_omitRecoveryAttempt` (line 1244) does not delete a failed assistant message. It appends a `context_edit` per affected entry, so the failed attempt stays on disk but leaves the model context. The comment notes an unpaired tool result "fails the next request (#11227)".
  - `_preparePromptAndToolLoadout` (line 1758) sends a *patch* of the system message (`diffSystemPromptSections`) rather than a new system message, so an unchanged prompt costs no tokens.
  - Custom messages queued during a run are deferred to the end of the turn (line 2384): appending mid-turn "would put the message between an assistant tool call and its result, which providers that validate message order reject on replay."
  - `agent_settled` is emitted only after the settle boundary; a prompt that arrives *during* that emission is deferred to `_deferredSettledActions` and replayed afterwards.
- Edge cases / failure handling: context-overflow recovery is attempted **once** (`_overflowRecoveryAttempted`); a second overflow emits a `compaction_end` with an explanatory `errorMessage` instead of looping. Compaction is refused while a prompt is submitted ("Cannot submit a prompt while compaction is in progress"). A stale extension context throws with a long, actionable message naming `ctx.newSession()`/`ctx.fork()`/`ctx.switchSession()`/`ctx.reload()`.
- Surprising: `getSessionStats()` aggregates over **all** entries, including history compacted away, so cost reflects what was actually billed.

### packages/coding-agent/src/core/auth-guidance.ts
- Purpose: formatted guidance for missing model/key.
- Key abstractions: `getProviderLoginHelp()`, `formatNoModelsAvailableMessage()`, `formatNoModelSelectedMessage()`, `formatNoApiKeyFoundMessage()`.
- Data flow: n/a (strings).
- Non-obvious design decisions: every message points at `/login` *and* the two doc paths, so a user is never told only "no key".
- Edge cases / failure handling: n/a.
- Surprising: the "unknown" provider id renders as "the selected model".

### packages/coding-agent/src/core/auth-storage.ts
- Purpose: the `auth.json` credential store.
- Key abstractions: `AuthStorage` (CredentialStore), `FileAuthStorageBackend`, `InMemoryAuthStorageBackend`, `ReadOnlyAuthStorage`, `readStoredCredential()`.
- Data flow: file → lock → parse → validate → `resolveConfigValue` for `api_key` entries → credential.
- Non-obvious design decisions: the file is created with mode `0600` *on creation only*, so administrator-managed ACLs survive later writes. Lock acquisition retries `EPERM` on Windows (a just-removed lock directory can stay "delete pending") with a separate retry cap from the `ELOCKED` cap, because the two failures mean different things. A shared read-state cache keyed by file revision avoids re-reading on every credential read.
- Edge cases / failure handling: a compromised lock makes the operation throw rather than proceed; a failed reload preserves the last valid in-memory snapshot. `modify`/`delete` throw on the read-only store.
- Surprising: `readStoredCredential()` is a one-off synchronous read that deliberately does *not* resolve configured key values.

### packages/coding-agent/src/core/bash-executor.ts
- Purpose: unified streaming bash execution.
- Key abstractions: `executeBashWithOperations()`, `BashResult`.
- Data flow: `BashOperations.exec` → `onData(Buffer)` → ANSI-safe decode → rolling buffer + optional temp file → `truncateTail`.
- Non-obvious design decisions: `splitIncompleteAnsiSuffix` holds back an escape sequence that straddles a chunk boundary, so a colour code split across two reads is not printed as garbage. The rolling buffer keeps `2 × DEFAULT_MAX_BYTES` of decoded text; everything else goes to a temp file.
- Edge cases / failure handling: an aborted command still returns the output produced so far (`cancelled: true`, `exitCode: undefined`).
- Surprising: `exitCode` is `undefined` (not `null`) when the command was cancelled.

### packages/coding-agent/src/core/bug-report-upload.ts
- Purpose: upload a bug-report bundle to the Radius gateway.
- Key abstractions: `uploadBugReport()` → `{id}`.
- Data flow: bundle → `FormData` → `POST /v1/bug-reports`.
- Non-obvious design decisions: the upload is anonymous unless a token is passed, so the user can decline to share the transcript and still get a report id.
- Edge cases / failure handling: a non-OK response or an unexpected JSON shape throws with the server's `description`/`error`.
- Surprising: the endpoint lives on the *Radius* gateway, not on a pi-owned server.

### packages/coding-agent/src/core/bug-report.ts
- Purpose: build the bug-report bundle.
- Key abstractions: `generateBugReportSummary()`, `bugReportFiles()`, `redactUrl()`, `redactJsonValue()`.
- Data flow: session entries + settings + environment → zip bundle + LLM-written summary.
- Non-obvious design decisions: redaction is *key-name based* (`api-key|secret|token|password|credential|authorization|cookie`) applied to every JSON leaf, plus URL userinfo and secret-looking query parameters. Environment collection keeps only the *names* of `PI_*` variables, never their values.
- Edge cases / failure handling: redaction is applied before the transcript is written to the archive.
- Surprising: `redactUrl` recurses into nested URL schemes (`scheme:scheme://...`).

### packages/coding-agent/src/core/cache-stats.ts
- Purpose: detect and price prompt-cache misses.
- Key abstractions: `computeCacheWaste()`, `collectCacheMisses()`, `detectCacheMiss()`, `CACHE_TTL_MS = 5 min`.
- Data flow: session entries → per-assistant-message miss detection → totals in tokens and dollars.
- Non-obvious design decisions: a zero-cache turn only counts if cache activity was reported *earlier* — on a cache-read-only provider that is a total miss, on a provider that never reports caching it means nothing. A 1024-token noise floor is treated as cache-breakpoint granularity. The extra cost is computed from the message's *own* paid rate versus the cache-read rate, so a cache-write premium is priced correctly.
- Edge cases / failure handling: a compaction or branch summary resets the comparison (the context legitimately changed), but a **model switch does not** — it re-bills the whole prompt and should be counted.
- Surprising: the whole "cache miss" concept is a first-class accounting concept with a dollar price.

### packages/coding-agent/src/core/cache-warmer.ts
- Purpose: keep one prompt-cache entry alive.
- Key abstractions: `CacheWarmer`, `CacheWarmingDecision`, `getCacheWarmingDelayMs()`, `getPromptCacheTtlMs()`, `isReplayable()`.
- Data flow: last real request → TTL from the model's `promptCache` tier → schedule a replay at 90% of TTL → decision (`warm`/`stop`) → extension override → replay with a one-token output cap.
- Non-obvious design decisions: the decision is *economic* — `expectedSavings = continuationProbability × missCost − warmCost`, and a refresh is only sent when that is at least **$0.05** (`CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS`). The continuation probability is a flat 0.15 constant, with a comment saying per-session estimates were not better. `isReplayable()` refuses to replay an Anthropic request with budget-based thinking, because the replay would get a different `budget_tokens` and Anthropic keys the message cache on it.
- Edge cases / failure handling: streaming warming stops 1 hour after the real request; idle warming 30 minutes. The warm request never extends the safety windows. Extensions may override the decision via `cache_warming_decision`.
- Surprising: a cache warmer that refuses to warm when it would cost more than it saves.

### packages/coding-agent/src/core/client-identity.ts
- Purpose: build the User-Agent/attribution pi sends to providers.
- Key abstractions: `getClientIdentity(settingsManager)`.
- Data flow: version + telemetry setting → `ClientIdentity`.
- Non-obvious design decisions: attribution is `null` when install telemetry is off — the provider then sees a version but no attribution.
- Edge cases / failure handling: n/a.
- Surprising: `userAgent: "detailed"` is a pi-ai enum, not a string.

### packages/coding-agent/src/core/compaction/branch-summarization.ts
- Purpose: summarise the branch you are leaving when you navigate the session tree.
- Key abstractions: `collectEntriesForBranchSummary()`, `prepareBranchEntries()`, `generateBranchSummary()`.
- Data flow: old leaf + target → common ancestor → entries walked back → budget-limited newest-first selection → LLM summary → `branch_summary` entry.
- Non-obvious design decisions: file operations are collected from **all** entries in a first pass, even those excluded by the token budget, so cumulative file tracking survives nested branch summaries. A compaction or branch-summary entry is allowed to overrun the budget by up to 10% because it carries context the rest does not.
- Edge cases / failure handling: the token budget is `contextWindow − reserveTokens` (default reserve 16384); a `contextWindow` of 0 falls back to 128000. Abort → `{aborted: true}`; error → `{error}`.
- Surprising: the summary is preceded by a fixed preamble ("The user explored a different conversation branch before returning here").

### packages/coding-agent/src/core/compaction/compaction.ts
- Purpose: the compaction algorithm.
- Key abstractions: `prepareCompaction()`, `compact()`, `findCutPoint()`, `estimateContextTokens()`, `estimateProjectedContextTokens()`, `shouldCompact()`, `completeSummarization()`, `getSummarizationFailure()`.
- Data flow: branch entries → projection → cut point → messages to summarise + turn-prefix messages → LLM summary → `compaction` entry.
- Non-obvious design decisions:
  - **A cut may never land on a tool result** (`isCutPointMessage`, line 351) — a tool result must follow its tool call. Cut points are user-like or assistant messages.
  - Splitting a turn produces *two* summaries: a history summary and a shorter "turn prefix" summary ("Original Request / Progress So Far / Context Needed to Continue"), merged with `---` and a `**Turn Context (split turn):**` marker.
  - The summary format is fixed and enforced: `## Goal / ## Constraints & Preferences / ## Progress (Done/In Progress/Blocked) / ## Key Decisions / ## Next Steps / ## Critical Context`, with "Preserve exact file paths, function names, and error messages."
  - `estimateProjectedContextTokens` refuses to trust usage captured *before* a later compaction or context edit; if the usage source is older than the latest invalidating entry it re-estimates from scratch.
  - `getSummarizationFailure` treats a `length` stop as a failure: "A length stop contains partial text and must not become a session checkpoint."
  - A summarisation response that contains a tool call is rejected outright.
  - `completeSummarization` is the single choke point: it sets `cacheRetention: "none"` (a one-off summary should not create cache entries) and wraps the call in `retryAssistantCall` so a transient stream drop does not fail the whole compaction.
- Edge cases / failure handling: the update prompt is used when a previous summary exists, and explicitly says "PRESERVE all existing information from the previous summary."
- Surprising: `generateSummary`'s `_reserveTokens` parameter is named with a leading underscore and documented as "Unused. Kept for existing callers; summaries use the model's output limit (#9512)."

### packages/coding-agent/src/core/compaction/index.ts
- Purpose: barrel for the compaction module.
- Key abstractions: `export *` from the three files.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: 7 lines, but it is the import surface every other module uses.

### packages/coding-agent/src/core/compaction/utils.ts
- Purpose: shared compaction/branch-summary utilities.
- Key abstractions: `FileOperations`, `extractFileOpsFromMessage()`, `computeFileLists()`, `formatFileOperations()`, `serializeConversation()`, `SUMMARIZATION_SYSTEM_PROMPT`.
- Data flow: messages → file-op sets → `<read-files>` / `<modified-files>` XML appended to the summary.
- Non-obvious design decisions: the conversation is serialised to **text** ("This prevents the model from treating it as a conversation to continue"). Tool results are truncated to 2000 characters — "Full content is not needed for summarization." **Thinking blocks are omitted entirely**, with a stated reason: providers return summaries of the real reasoning, and replayed thinking may not be part of the model's live context, so including it can make the summarisation request larger than the context it summarises.
- Edge cases / failure handling: file ops are also extracted from `nestedCalls` on a tool-result message, so calls made from codemode scripts are counted.
- Surprising: the summarised transcript is a text transcript with `[User]:` / `[Assistant]:` / `[Tool result]:` markers, not a message list.

### packages/coding-agent/src/core/crash-log.ts
- Purpose: persist crashes and attribute them to extensions.
- Key abstractions: `readCrashLog()`, `recordCrash()`, `takeUnnotifiedCrash()`, `findExtensionStackMatches()`.
- Data flow: crash → JSON record (max 5, max age 7 days) → next launch shows the newest unnotified record.
- Non-obvious design decisions: `stackContainsPath` matches a *path component boundary* (`:`/`) `/whitespace after the path) so `foo.ts` does not match `foo.tsx`, and it is case-insensitive only for Windows drive paths.
- Edge cases / failure handling: `recordCrash` swallows its own failures ("Best-effort persistence for callers that are already crashing").
- Surprising: the crash log is how a user learns *which extension* crashed.

### packages/coding-agent/src/core/defaults.ts
- Purpose: default thinking level and the thinking-level option list.
- Key abstractions: `DEFAULT_THINKING_LEVEL = "medium"`, `THINKING_LEVEL_OPTIONS`.
- Data flow: n/a.
- Non-obvious design decisions: the list is `off, minimal, low, medium, high, xhigh, max`.
- Edge cases / failure handling: n/a.
- Surprising: the default is `medium`, not `off`.

### packages/coding-agent/src/core/diagnostics.ts
- Purpose: diagnostic types for resource loading.
- Key abstractions: `ResourceDiagnostic`, `ResourceCollision`.
- Data flow: n/a (types).
- Non-obvious design decisions: a collision is a distinct diagnostic *type*, with winner/loser paths and sources.
- Edge cases / failure handling: n/a.
- Surprising: resources can lose a name collision and it is reported, not silently resolved.

### packages/coding-agent/src/core/event-bus.ts
- Purpose: the extension-to-extension event bus.
- Key abstractions: `createEventBus()` → `EventBusController`.
- Data flow: `emit(channel, data)` → handlers.
- Non-obvious design decisions: the handler wrapper is `async` and catches its own exceptions, so a throwing extension handler cannot crash the bus. The returned unsubscribe removes the *wrapper*, not the original.
- Edge cases / failure handling: handler errors are logged with the channel name.
- Surprising: the bus is the only sanctioned way for two extensions to talk.

### packages/coding-agent/src/core/exec.ts
- Purpose: command execution for extensions.
- Key abstractions: `execCommand()`, `ExecOptions`, `ExecResult`.
- Data flow: `spawn` → stdout/stderr accumulation → `waitForChildProcess` → result.
- Non-obvious design decisions: `shell: false` — the command and args are passed as an argv array, so extension commands are not shell-parsed. SIGTERM then SIGKILL after 5 seconds.
- Edge cases / failure handling: the promise always resolves (never rejects); a spawn error becomes `code: 1, killed: true`.
- Surprising: `waitForChildProcess` exists because inherited stdio handles held by detached descendants otherwise hang the wait.

### packages/coding-agent/src/core/experimental.ts
- Purpose: the experimental-feature gate.
- Key abstractions: `areExperimentalFeaturesEnabled()`.
- Data flow: `PI_EXPERIMENTAL=1` → boolean.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/coding-agent/src/core/export-html/ansi-to-html.ts
- Purpose: ANSI → HTML for the exported transcript.
- Key abstractions: `ansiLinesToHtml()`.
- Data flow: ANSI text → inline-styled HTML spans.
- Non-obvious design decisions: supports 16-colour, the 256-colour cube and truecolor, plus bold/dim/italic/underline.
- Edge cases / failure handling: n/a.
- Surprising: the HTML export reuses the *terminal* colour output rather than re-rendering the transcript.

### packages/coding-agent/src/core/export-html/index.ts
- Purpose: render a session to a self-contained HTML file.
- Key abstractions: `exportSessionToHtml()`, `exportFromFile()`, `ToolHtmlRenderer`.
- Data flow: session tree + agent state + theme → base64 session JSON + pre-rendered tool HTML → `template.html` with CSS/JS inlined.
- Non-obvious design decisions: the session payload is base64-encoded into a `<script type="application/json">` tag so the export is one file with no external requests.
- Edge cases / failure handling: n/a.
- Surprising: extension tools are rendered by *running their TUI renderers* and converting the ANSI, so the export matches the terminal.

### packages/coding-agent/src/core/export-html/template.css
- Purpose: stylesheet for the exported transcript.
- Key abstractions: CSS custom properties for theme colours.
- Data flow: `{{THEME_VARS}}` / `{{BODY_BG}}` placeholders are substituted at export time.
- Non-obvious design decisions: the CSS is a template with placeholders, not a static asset.
- Edge cases / failure handling: n/a.
- Surprising: ~23 KB of CSS for a single-file export.

### packages/coding-agent/src/core/export-html/template.html
- Purpose: the shell of the exported HTML.
- Key abstractions: `{{CSS}}`, `{{SESSION_DATA}}`, `{{MARKED_JS}}` placeholders.
- Data flow: placeholders → the exported file.
- Non-obvious design decisions: the sidebar has the *same* five filters as the interactive tree (default / no-tools / user-only / labeled-only / all).
- Edge cases / failure handling: n/a.
- Surprising: the export is an interactive app, not a dump.

### packages/coding-agent/src/core/export-html/template.js
- Purpose: the viewer script of the exported HTML.
- Key abstractions: session tree, filters, deep links (`?leafId=`, `?targetId=`), rendering.
- Data flow: base64 `<script type="application/json">` → decode → render.
- Non-obvious design decisions: URL parameters are read from a `<meta name="pi-url-params">` tag *or* `window.location.search`, so the export can be embedded in an iframe via `srcdoc` and still deep-link.
- Edge cases / failure handling: n/a.
- Surprising: ~80 KB of hand-written viewer JS shipped as a template string inside the package. **I read the header and the data-loading/deep-link section, not all 80 KB.**

### packages/coding-agent/src/core/export-html/tool-renderer.ts
- Purpose: render extension tool calls/results to HTML.
- Key abstractions: `createToolHtmlRenderer()`, `ToolHtmlRendererDeps`.
- Data flow: tool definition → TUI `renderCall`/`renderResult` → ANSI → HTML.
- Non-obvious design decisions: it reuses the TUI renderers, so a tool that renders well in the terminal renders well in the export without a second implementation.
- Edge cases / failure handling: a tool with no renderer returns `undefined` and the export falls back to plain text.
- Surprising: the renderer resolution order (extension resolvers, then the registered tool) is reused here.

### packages/coding-agent/src/core/export-html/vendor/highlight.min.js
- Purpose: vendored highlight.js v11.9.0 for syntax highlighting in the export.
- Key abstractions: none (minified library).
- Data flow: embedded into the exported HTML.
- Non-obvious design decisions: vendored rather than fetched, so the export is offline-capable.
- Edge cases / failure handling: n/a.
- Surprising: n/a. **Skipped line by line: 121 KB minified third-party build; I read the first lines to confirm the library and version.**

### packages/coding-agent/src/core/export-html/vendor/marked-cjk-friendly.min.js
- Purpose: vendored `marked-cjk-friendly` v0.1.2, a CJK-aware marked fork.
- Key abstractions: none.
- Data flow: embedded into the exported HTML.
- Non-obvious design decisions: the fork is used instead of plain marked for CJK line breaking.
- Edge cases / failure handling: n/a.
- Surprising: n/a. **Skipped line by line: 4.7 KB minified third-party build; I read the header comment to confirm the library and version.**

### packages/coding-agent/src/core/export-html/vendor/marked.min.js
- Purpose: vendored marked v18.0.11 markdown parser for the export.
- Key abstractions: none.
- Data flow: embedded into the exported HTML.
- Non-obvious design decisions: vendored so the export works offline.
- Edge cases / failure handling: n/a.
- Surprising: n/a. **Skipped line by line: 44 KB minified third-party build; I read the header comment to confirm the library and version.**

### packages/coding-agent/src/core/extensions/index.ts
- Purpose: the public barrel of the extension API.
- Key abstractions: re-exports of every event/context type plus `ExtensionRunner`, `loadExtensions`, `wrapRegisteredTools`, `defineTool`.
- Data flow: n/a.
- Non-obvious design decisions: it is also the *runtime* import surface for extensions (`@earendil-works/pi-coding-agent`).
- Edge cases / failure handling: n/a.
- Surprising: the type guards (`isReadToolResult` etc.) live here, not in `types.ts`.

### packages/coding-agent/src/core/extensions/jiti-loader.ts
- Purpose: lazy jiti import for normal Node runtimes.
- Key abstractions: `createJiti` re-export.
- Data flow: n/a.
- Non-obvious design decisions: the comment says Babel is loaded "only when native loading fails and an extension needs transformation".
- Edge cases / failure handling: n/a.
- Surprising: 3 lines, chosen to defer a heavyweight dependency.

### packages/coding-agent/src/core/extensions/jiti-static-loader.ts
- Purpose: jiti/static import for compiled binaries.
- Key abstractions: `createJiti` from `jiti/static`.
- Data flow: n/a.
- Non-obvious design decisions: "Compiled binaries need jiti's static entry so Bun and SEA bundlers embed the Babel transform. The module itself remains lazy until an extension is loaded."
- Edge cases / failure handling: n/a.
- Surprising: the pair of loader files is the whole "does this build embed Babel" switch.

### packages/coding-agent/src/core/extensions/loader.ts
- Purpose: discover and load extensions.
- Key abstractions: `discoverAndLoadExtensions()`, `loadExtensions()`, `loadExtensionFromFactory()`, `createExtensionRuntime()`, `ExtensionAPI`.
- Data flow: paths → jiti import → factory → `createExtensionAPI` → `commit()`/`discard()`.
- Non-obvious design decisions:
  - Three resolution strategies depending on the build: embedded virtual modules (Bun/SEA/bundled Node), tsconfig paths (TypeScript source runtime), or dist aliases (unbundled Node).
  - The API is in a `loading | active | failed` state machine. Registrations made during loading are *queued* and applied on `commit()`; if the factory throws, `discard()` marks the extension failed and unsubscribes its event-bus subscriptions.
  - The runtime's action methods are **throwing stubs** before `bindCore()` — "Extension runtime not initialized. Action methods cannot be called during extension loading."
  - `invalidate(message)` freezes the runtime: every captured context then throws with the long stale-context message.
  - Discovery is one level deep only: `extensions/*.ts`, `extensions/*/index.ts`, or `extensions/*/package.json` with a `pi` manifest.
- Edge cases / failure handling: a broken extension becomes an entry in `errors[]`, not a startup failure. The extension cache is keyed by cwd and a generation counter, so a cwd change or `clearExtensionCache()` invalidates it.
- Surprising: `registerTool` validates that the parameter schema is a plain object — a malformed tool definition is rejected at registration, not at call time.

### packages/coding-agent/src/core/extensions/runner.ts
- Purpose: execute extensions and manage their lifecycle.
- Key abstractions: `ExtensionRunner`, `emitBoundary()`, `emitContext()`, `emitToolCall()`, `emitToolResult()`, `emitBeforeAgentStart()`, `createContext()`, `createToolContext()`, `createCommandContext()`.
- Data flow: agent event → `emit*` → per-extension handlers (snapshot of the handler list) → merged result.
- Non-obvious design decisions:
  - **The system prompt is Pi's, not the extension's** for the `context` event: handlers see only the non-system messages, and `restoreSystemMessages` (line 292) puts the system message back unless the conversation actually changed. The comment explains why: "An unchanged conversation keeps every system message in place, so models with mid-conversation support keep their cached prefix."
  - There is a *second* event, `context_with_system`, for handlers that genuinely need to own the prompt; dropping the leading system message there is reported as an extension error.
  - Every context getter is a guarded getter that calls `assertActive()`, so a stale context throws on use rather than returning stale data. `createCommandContext` copies *property descriptors* rather than spreading, because a spread would eagerly read the getters and freeze the old values.
  - `emitBoundary` (line 1036) rebuilds the context after every handler's drafts, so the next handler sees the previous handler's entries; an invalid draft set invalidates the whole continuation.
  - `tool_call` handlers may *mutate* `event.input` in place; there is no re-validation after the mutation, and a handler that returns `block: true` stops the chain.
  - `tool_result` handlers can replace content, and replacing content without returning `structuredContent` drops the structured content (it may no longer match).
  - `message_end` handlers must return a message with the *same role*; a different role is reported as an error and ignored.
  - Extension shortcuts are checked against a reserved list (`app.interrupt`, `app.exit`, `tui.input.submit`, …) and are skipped on conflict; a non-reserved built-in conflict is only a warning and the extension wins.
  - `reportUnhandledMcpServers` reports an error when a server is registered but no extension handles `mcp_servers_change` — "another extension may have replaced the built-in MCP support."
- Edge cases / failure handling: a throwing handler is caught, reported via `emitError`, and the chain continues. `invalidate()` is idempotent.
- Surprising: `context` vs `context_with_system` is a deliberate two-tier design, not an accident.

### packages/coding-agent/src/core/extensions/types.ts
- Purpose: the extension contract.
- Key abstractions: `ExtensionAPI`, `ExtensionContext`, `ExtensionCommandContext`, `ExtensionToolContext`, `ReplacedSessionContext`, `ToolDefinition`, `ToolExposure`, `ToolNamespace`, `ToolAnnotations`, every event type.
- Data flow: types only.
- Non-obvious design decisions:
  - `ToolExposure` is a five-value vocabulary: `direct` (declared and callable), `model-only` (declared, never callable), `codemode` (callable from scripts, not declared), `deferred` (not declared until `tool_search` loads it), `hidden` (registered but unreachable). The doc comment states the whole rule set.
  - `prepareLoadout` lets a tool rewrite how the loadout is presented (e.g. codemode listing its callable tools in its own description) and can hide a *declaration* while keeping the tool active and callable.
  - `reachesTools(input)` declares which tools a call may reach — used by `tool_call` handlers to finish registering late MCP servers before the call runs.
  - The extension API is typed per tool: `ToolCallEvent` is a discriminated union with a `CustomToolCallEvent` fallback, and `isToolCallEventType` exists because direct `event.toolName === "bash"` narrowing does not work when `CustomToolCallEvent.toolName` is `string`.
- Edge cases / failure handling: `MessageEndEventResult` requires the same role; `ToolResultEventResult` documents that omitting `structuredContent` while replacing `content` drops it.
- Surprising: `ExtensionContext.mode` is `"tui" | "rpc" | "json" | "print"`, so an extension can guard terminal-only UI.

### packages/coding-agent/src/core/extensions/virtual-modules.ts
- Purpose: the module map injected into jiti.
- Key abstractions: `VIRTUAL_MODULES`.
- Data flow: extension `import` → jiti → this map.
- Non-obvious design decisions: both the `@earendil-works/*` and the legacy `@mariozechner/*` names map to the same modules, and the `pi-ai` root resolves to the `compat` entrypoint ("a strict superset of the core entrypoint") so old extensions keep working.
- Edge cases / failure handling: the import of `../../index.ts` is safe because `loader.ts` is not re-exported from `index.ts` — a deliberate circular-import avoidance stated in a comment.
- Surprising: an extension written for the old package names still runs.

### packages/coding-agent/src/core/extensions/wrapper.ts
- Purpose: adapt extension tools to the agent runtime.
- Key abstractions: `wrapRegisteredTool()`, `wrapRegisteredTools()`.
- Data flow: `RegisteredTool` → `AgentTool` with a context factory.
- Non-obvious design decisions: interception is *not* done here — "Tool call and tool result interception is handled by AgentSession via agent-core hooks."
- Edge cases / failure handling: n/a.
- Surprising: 29 lines for one job.

### packages/coding-agent/src/core/footer-data-provider.ts
- Purpose: git branch detection and footer data.
- Key abstractions: `findGitPaths()`, `ReadonlyFooterDataProvider`.
- Data flow: cwd → walk up to `.git` → `git symbolic-ref` → branch name.
- Non-obvious design decisions: it handles **worktrees** (`.git` is a file containing `gitdir:`) and resolves `commondir` to find the real git dir. The git invocation uses `--no-optional-locks` so it never takes the repository's index lock.
- Edge cases / failure handling: a detached HEAD or a missing git binary yields `null`, not an error; WSL and Windows-mounted-repo paths are detected separately.
- Surprising: the branch is fetched both synchronously and asynchronously (sync for the first paint, async later).

### packages/coding-agent/src/core/http-dispatcher.ts
- Purpose: configure the HTTP layer.
- Key abstractions: `configureHttpDispatcher()`, `parseHttpIdleTimeoutMs()`, `applyHttpProxySettings()`, `HTTP_IDLE_TIMEOUT_CHOICES`.
- Data flow: timeout → `undici.EnvHttpProxyAgent` → `undici.setGlobalDispatcher` → `undici.install()`.
- Non-obvious design decisions: `autoSelectFamilyAttemptTimeout` is raised to 2 s because Node's 250 ms default "can terminate valid connection attempts on high-latency routes". An `error` listener is attached to every dispatcher because undici can emit a Client `error` while terminating a mid-stream body and EventEmitter treats an unhandled `error` as fatal. `undici.install()` is called so fetch and the dispatcher use the same implementation — Node 26's bundled fetch would otherwise consume compressed responses without decompressing them, "causing response.json() failures".
- Edge cases / failure handling: a deliberate `globalThis.fetch` override is preserved (the check compares against the previously installed one, not the original).
- Surprising: `proxyTunnel: true` keeps HTTP origins on CONNECT tunnels as they were before Undici 8.7.

### packages/coding-agent/src/core/index.ts
- Purpose: barrel of the core modules shared by all run modes.
- Key abstractions: re-exports.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/coding-agent/src/core/key-id-schema.ts
- Purpose: schema for key identifiers.
- Key abstractions: `KeyIdSchema`, `keybindingValueSchema()`.
- Data flow: n/a.
- Non-obvious design decisions: the regex rejects **duplicate modifiers** via a negative lookahead (`(?:ctrl)\+.*(?:ctrl)\+`), and builds the base-key alternation from the TUI's own `Key` table so it cannot drift.
- Edge cases / failure handling: a bad key id fails schema validation rather than silently binding nothing.
- Surprising: `Type.Unsafe<KeyId>` is needed because the pattern cannot be expressed as a nominal type.

### packages/coding-agent/src/core/keybindings-schema.ts
- Purpose: JSON schema for `keybindings.json`.
- Key abstractions: `KeybindingsSchema`.
- Data flow: the `KEYBINDINGS` table → one optional property per id.
- Non-obvious design decisions: the schema is *generated* from the table, so a new keybinding is automatically valid.
- Edge cases / failure handling: `additionalProperties: KeybindingValueSchema` allows extra ids.
- Surprising: the schema and the table cannot disagree.

### packages/coding-agent/src/core/keybindings.ts
- Purpose: the keybinding table, migration and manager.
- Key abstractions: `KEYBINDINGS`, `APP_KEYBINDINGS`, `KeybindingsManager`, `migrateKeybindingsConfig()`.
- Data flow: defaults + user `keybindings.json` → resolved bindings.
- Non-obvious design decisions: platform differences are explicit (Windows/WSL gets `alt+p` for model-backward, `ctrl+q` for follow-up; macOS gets `alt+left` for tree fold). Legacy key names (`cursorUp`, `submit`, `interrupt`, …) are migrated to the canonical `tui.*`/`app.*` ids, and the migration reports `migrated: true` so the file can be rewritten. The config is re-ordered to the table's order so the settings file is stable.
- Edge cases / failure handling: an unparseable `keybindings.json` is treated as empty rather than fatal; individual invalid values are dropped by the schema check.
- Surprising: `KEYBINDING_NAME_MIGRATIONS` has ~40 legacy names.

### packages/coding-agent/src/core/mcp-servers.ts
- Purpose: MCP server configuration and the extension registration registry.
- Key abstractions: `validateMcpServerConfig()`, `McpServerRegistry`, `getMcpToolExposure()`, `createToolNameMatcher()`, `isMcpToolName()`, `mcpNamespace()`.
- Data flow: raw config → validated copy (exposure aliases resolved) → registry → extension runner.
- Non-obvious design decisions:
  - `McpExposure` (`codemode | deferred | direct | hidden`) defaults to `codemode`, i.e. MCP tools are **not** declared to the model by default.
  - `toolExposure` overrides per tool, with exact names beating patterns and the first pattern match winning; `"exposure": "hidden"` plus a few overrides exposes only those.
  - A server name that differs only in `-`/`_` would share a namespace, so the loader rejects the clash.
  - The OAuth config is validated hard: the callback URL must be an `http` URI on `localhost`/`127.0.0.1`/`[::1]` with no query or fragment, `callbackUrl` and `callbackPort` must name the same port, and `cimd` client registration cannot be combined with a `clientId`.
  - `auth.provider` (reuse a pi provider's token) requires https except on loopback.
  - Legacy `sse` transport is rejected with a message pointing at streamable HTTP.
- Edge cases / failure handling: `unregister` only removes a server registered by the same extension path.
- Surprising: `createToolNameMatcher` compiles `*` patterns into regexes, escaping regex metacharacters.

### packages/coding-agent/src/core/messages.ts
- Purpose: custom message roles and the LLM projection.
- Key abstractions: `BashExecutionMessage`, `CustomMessage`, `BranchSummaryMessage`, `CompactionSummaryMessage`, `convertToLlm()`.
- Data flow: session entries → agent messages → `convertToLlm` → provider messages.
- Non-obvious design decisions: every custom role becomes a **user** message with a fixed textual wrapper (`COMPACTION_SUMMARY_PREFIX`/`SUFFIX`, `BRANCH_SUMMARY_PREFIX`/`SUFFIX`), so providers never see a role they do not support. `bashExecution` with `excludeFromContext` (the `!!` prefix) is dropped entirely.
- Edge cases / failure handling: the switch is exhaustive with a `never` check, so a new role is a compile error.
- Surprising: the custom message types are added to the agent core's `CustomAgentMessages` interface by **declaration merging**.

### packages/coding-agent/src/core/model-config.ts
- Purpose: the `models.json` snapshot.
- Key abstractions: `ModelConfig`, `ModelsConfigSchema`, `ModelsJsonSchemas`.
- Data flow: file → strip comments/BOM → JSON.parse → typebox `Compile().Check()` → deep-frozen providers.
- Non-obvious design decisions: a schema error is collected into `getError()` rather than thrown, so one bad file does not stop startup. The parsed providers are `structuredClone`d and deep-frozen, so the snapshot is immutable and credential-blind (it never reads `auth.json`).
- Edge cases / failure handling: a missing file is an empty config; a parse error and a schema error produce different messages.
- Surprising: the schema objects are exported so the docs generator renders the same schema the runtime validates.

### packages/coding-agent/src/core/model-registry.ts
- Purpose: a synchronous facade over `ModelRuntime` for extensions.
- Key abstractions: `ModelRegistry`.
- Data flow: extension call → runtime.
- Non-obvious design decisions: it is explicitly a "compatibility facade" — coding-agent internals use `ModelRuntime` directly. `getApiKeyAndHeaders` returns a discriminated `{ok:true}|{ok:false}` instead of throwing, and falls back to a compatibility request config when no credential exists.
- Edge cases / failure handling: `generateImages`/`classify` "never reject" — errors come back as error results.
- Surprising: `getAll()`/`getAvailable()` return copies, not the internal arrays.

### packages/coding-agent/src/core/model-resolver.ts
- Purpose: model reference resolution and scoping.
- Key abstractions: `resolveModelReference()`, `resolveModelScopeFromModels()`, `findInitialModel()`, `defaultModelPerProvider`.
- Data flow: `--model` text → candidates → resolved / ambiguous / not-found.
- Non-obvious design decisions:
  - Candidates are collected **before** a provider is chosen, so catalog order never decides the provider and an ambiguous match is *reported* rather than silently falling through to a weaker match.
  - `provider/rest` is only a hint: the whole text may also be a model id on another provider. The named provider wins when usable; otherwise a sole usable raw match wins; an unusable named match still beats unusable raw matches so `--api-key` can set up the named provider.
  - The `:<thinking>` suffix is only considered when the *full* text matches no model, because ids like `qwen/qwen3-coder:exacto` contain colons. `thinkingSuffix: "none" | "strict" | "lenient"` decides what happens to an invalid suffix.
  - Fuzzy matching prefers aliases over dated versions (`-latest` or no `-YYYYMMDD` suffix).
- Edge cases / failure handling: an invalid thinking level in lenient mode produces a warning and the default level.
- Surprising: `defaultModelPerProvider` is a hard-coded table of ~40 providers with pinned default model ids.

### packages/coding-agent/src/core/model-runtime.ts
- Purpose: the canonical model/auth runtime.
- Key abstractions: `ModelRuntime` (implements pi-ai's `Models`), `CreateModelRuntimeOptions`, `CredentialSynchronizationError`.
- Data flow: built-in providers + `models.json` + extension registrations → composed providers → availability snapshot → request-time auth → provider stream.
- Non-obvious design decisions:
  - **A provider with no overlay is used untouched** — "so its auth/login/stream behavior is exact." Overlays (models.json, extension config) are composed onto it.
  - Availability is a *snapshot* updated by background refreshes, with sequence numbers (`availabilityRefreshSeq`, `providerAvailabilitySeq`) so a stale refresh cannot overwrite a newer one.
  - Credential operations are serialised per provider by a promise tail, and a failure to synchronise the local snapshot after a successful credential change throws `CredentialSynchronizationError` — "Credentials changed successfully, but the local model/auth snapshot could not be synchronized."
  - `markProvisionallyConfigured` marks a newly registered provider as configured *before* the async availability check lands, so initial model selection does not see an empty list.
  - `streamSimple` for a virtual model routes it with reason `"direct"` and then **drops the caller's credentials** if the routed model belongs to a different provider: "Another provider resolves its own, so they are not sent to the wrong vendor."
  - `resolveModel` verifies the routed model is physical and has credentials, and clamps the thinking level to the routed model.
- Edge cases / failure handling: `PI_OFFLINE=1` disables network model refresh entirely; `modelsPath: null` disables the file store; provider composition errors are collected in `getError()` and the built-in provider is used as a fallback.
- Surprising: `refresh()` contains a compatibility fallback for a pi-ai build that returned `void` and accepted no provider id.

### packages/coding-agent/src/core/models-store.ts
- Purpose: storage for dynamically refreshed provider catalogs.
- Key abstractions: `FileModelsStore`, `InMemoryCodingAgentModelsStore`.
- Data flow: provider id → entry → `models-store.json` under a file lock.
- Non-obvious design decisions: reads are revision-checked (`getFileRevision`) and a reload is *shared* between concurrent readers, with a reference count that aborts the underlying reload when the last reader goes away.
- Edge cases / failure handling: writes go through `withLockAsync` and update the in-memory read state so the next read does not hit the disk.
- Surprising: the read state is shared process-wide for the default path ("Optimize the common path without retaining an unbounded set of custom paths").

### packages/coding-agent/src/core/nested-tool-calls.ts
- Purpose: record and run tool calls that a tool makes.
- Key abstractions: `NestedToolCallRunner`, `NestedCallRecorder`, `NESTED_CALL_LIMITS`.
- Data flow: `ctx.executeTool()` → `runToolCall` through the agent's pipeline → `tool_execution_*` events with `parentToolCallId` → a bounded `nestedCalls` record on the calling tool's result message.
- Non-obvious design decisions: the record has hard limits — 256 calls, 8 KB of arguments per call, 32 KB total, 500 characters of error text — and is marked `complete: false` when any limit bites. Nested calls are *not* persisted in the transcript; only their bounded record and their summed usage are.
- Edge cases / failure handling: nested tool failures never reject — they come back as `isError: true`. A sequential tool takes an exclusive queue; a call that already holds it does not re-enter (so a sequential tool calling another sequential tool does not deadlock).
- Surprising: nested call ids are `<parent id>/<n>`, which is how the transcript can keep them out while the UI still shows them.

### packages/coding-agent/src/core/output-guard.ts
- Purpose: keep machine-readable stdout clean.
- Key abstractions: `takeOverStdout()`, `restoreStdout()`, `writeRawStdout()`, `flushRawStdout()`, `waitForRawStdoutBackpressure()`.
- Data flow: TUI writes → redirected to stderr; real stdout output → a serialised raw-write chain.
- Non-obvious design decisions: after the takeover, `process.stdout.write` sends everything to **stderr**, so a TUI redraw can never corrupt a JSON/RPC stream. Raw writes are chained through a promise tail, and `ENOBUFS`/`EAGAIN`/`EWOULDBLOCK` are retried with a 10 ms delay.
- Edge cases / failure handling: a failed raw write calls `process.exit(1)`.
- Surprising: `takeOverStdout()` returns the *stderr* writer for a write that supplies a callback, and the stdout writer otherwise.

### packages/coding-agent/src/core/package-manager.ts
- Purpose: install and resolve extension/skill/prompt/theme packages.
- Key abstractions: `DefaultPackageManager`, `PackageManager`, `ResolvedResource`, `PathMetadata`, `MissingSourceAction`.
- Data flow: configured sources (npm, git, local) → clone/install → resolve to concrete paths with source metadata.
- Non-obvious design decisions: it has its own `getEnv()` that reads `/proc/self/environ` on Linux when `process.env` is empty (the same sandbox workaround as the Bun entry, duplicated). Semver ranges are resolved with `maxSatisfying`, and `ignore`/`minimatch` are used for path filtering.
- Edge cases / failure handling: `MissingSourceAction` distinguishes "install", "skip" and "error" per source.
- Surprising: it is 2.4k lines and mixes npm, git and local resolution into one class. **I read the head and the exported surface, not all 2.4k lines.**

### packages/coding-agent/src/core/pi-manifest.ts
- Purpose: read the `pi` field of a package.json.
- Key abstractions: `readPiManifest()`, `PiManifest`.
- Data flow: package.json → JSON.parse → `{extensions, skills, prompts, themes}` arrays of strings.
- Non-obvious design decisions: a field is accepted only if it is an array whose every entry is a string; anything else is silently dropped.
- Edge cases / failure handling: any parse failure returns `null`.
- Surprising: this is how a third-party package ships pi resources.

### packages/coding-agent/src/core/project-trust.ts
- Purpose: decide whether a project is trusted.
- Key abstractions: `resolveProjectTrust()` (or similar), `AppMode`.
- Data flow: extension `project_trust` handler → stored decision → default setting → interactive prompt.
- Non-obvious design decisions: the extension handler runs **first** and its `yes`/`no` wins; `undecided` falls through. A `remember: true` result writes the decision to the trust store. The default setting is `always` / `never` / `ask`; `ask` without a UI resolves to **untrusted**.
- Edge cases / failure handling: a project with no trust-requiring resources skips the prompt entirely.
- Surprising: "no UI" means untrusted, which is the safe default for a headless run.

### packages/coding-agent/src/core/prompt-templates.ts
- Purpose: load and expand markdown prompt templates.
- Key abstractions: `loadPromptTemplates()`, `expandPromptTemplate()`, `parseCommandArgs()`, `substituteArgs()`.
- Data flow: `/name args` → template lookup → argument substitution → expanded text.
- Non-obvious design decisions: the substitution supports `$1`, `$@`, `$ARGUMENTS`, `${N:-default}`, `${@:-default}`, and bash-style slices `${@:N:L}`. Replacement is **not recursive** — "Argument and default values containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted." Quoted empty strings are preserved as arguments (`hasToken` tracking).
- Edge cases / failure handling: a template with no frontmatter description falls back to the first non-empty line, truncated to 60 characters.
- Surprising: `parseCommandArgs` is a hand-written bash-style tokenizer, not `split(" ")`.

### packages/coding-agent/src/core/provider-composer.ts
- Purpose: overlay config onto built-in providers.
- Key abstractions: `composeModelProvider()`, `modelFromJson()`, `extensionModelFromDefinition()`, `applyModelOverride()`, `mergeCompat()`, `mergeInputLimits()`, `mergeSamplingParamsByThinkingLevel()`.
- Data flow: base provider + models.json provider + extension provider config → composed provider + model list.
- Non-obvious design decisions: nested compat objects (`openRouterRouting`, `vercelGatewayRouting`, `chatTemplateKwargs`, `chatTemplateArgs`) are merged one level deep rather than replaced; `inputLimits.images.resize` is merged field-by-field. A `modelOverride` never clears a value — `??` semantics, so an override only fills what it defines. A custom model must have an `api` and a `baseUrl`, and the error message says at which level each is missing.
- Edge cases / failure handling: `contextWindow`/`maxTokens` of 0 are rejected with a specific message.
- Surprising: `findModelDefaults` falls back through id match → api match → `openai-completions` → first chat model, so a custom model inherits sensible defaults.

### packages/coding-agent/src/core/radius.ts
- Purpose: Radius gateway constants.
- Key abstractions: `RADIUS_PROVIDER_ID`, `ENV_RADIUS_GATEWAY`, `RADIUS_MCP_URL`, `getRadiusGatewayUrl()`.
- Data flow: `PI_RADIUS_GATEWAY` → normalised gateway URL.
- Non-obvious design decisions: the MCP endpoint is derived from the gateway so it follows the override.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/coding-agent/src/core/remote-catalog-provider.ts
- Purpose: overlay a pi.dev model catalog onto built-in providers.
- Key abstractions: `withRemoteCatalog()`, `withPersonalizedCatalog()`, `REMOTE_CATALOG_REFRESH_INTERVAL_MS` (4 h).
- Data flow: pi.dev → `Last-Modified`/`ETag` → stored overlay → provider model list.
- Non-obvious design decisions: the catalog is only used when it is **newer** than the model data shipped with pi (`isNewer`). The etag is only sent when a cached body backs it, "so a 304 can never leave the overlay empty." A transient failure keeps the etag so the next refresh revalidates instead of re-downloading. A 404/501 is treated as "this provider has no remote catalog" and is remembered.
- Edge cases / failure handling: the request has a 4-second attempt timeout; `?types=` asks the server for the full-type shard, and a server that ignores it still works.
- Surprising: the OpenRouter variant is *personalised* — the fetched catalog is filtered by the user's key and the personalised list is what gets saved.

### packages/coding-agent/src/core/resolve-config-value.ts
- Purpose: resolve config values that are literals, env references or shell commands.
- Key abstractions: `resolveConfigValue()`, `resolveConfigValueOrThrow()`, `resolveHeaders()`, `isCommandConfigValue()`, `getMissingConfigValueEnvVarNames()`.
- Data flow: `"$VAR"`, `"${VAR}"`, `"!command"` or a literal → the resolved string.
- Non-obvious design decisions: `$$` escapes a literal `$` and `$!` escapes a literal `!`. Shell-command results are cached for the process lifetime. On Windows the configured shell is tried first and `execSync` is the fallback; on other platforms `execSync` is used directly. Commands run with a 10 s timeout and `stdio: ["ignore","pipe","ignore"]` (stderr is discarded).
- Edge cases / failure handling: `resolveConfigValueOrThrow` distinguishes "failed to resolve from shell command" from "missing environment variable" and names the variables.
- Surprising: a missing env var inside a template makes the *whole* value unresolved rather than resolving to an empty string.

### packages/coding-agent/src/core/resource-loader.ts
- Purpose: load every resource for a cwd.
- Key abstractions: `DefaultResourceLoader`, `ResourceLoader`, `loadProjectContextFiles()`.
- Data flow: cwd + agentDir + settings → extensions, skills, prompts, themes, AGENTS files, system prompt.
- Non-obvious design decisions: it owns the `McpServerRegistry` and the extension runtime, so it is the single place that knows where resources come from. Extension loading is cached per cwd (`loadExtensionsCached`).
- Edge cases / failure handling: every loader returns diagnostics instead of throwing, so a broken resource degrades to a warning.
- Surprising: it also discovers the *git* root (`findGitPaths`) to locate project context files. **I read the head and the exported surface, not all 1.1k lines.**

### packages/coding-agent/src/core/runtime-credentials.ts
- Purpose: non-persistent runtime API keys.
- Key abstractions: `RuntimeCredentials` (CredentialStore overlay).
- Data flow: `setRuntimeApiKey()` → overlay → `read`/`list` merge with the real store.
- Non-obvious design decisions: the overlay is consulted *before* the stored credential, so a runtime key wins; `delete` clears both.
- Edge cases / failure handling: `modify` is delegated to the underlying store, so a runtime override is not written to disk by a modify.
- Surprising: `list()` merges the overlay into the credential list, so a runtime-only provider still appears.

### packages/coding-agent/src/core/sdk.ts
- Purpose: the public SDK entry point.
- Key abstractions: `createAgentSession()`, `CreateAgentSessionOptions`, `CreateAgentSessionResult`.
- Data flow: options → `ModelRuntime` + `SettingsManager` + `DefaultResourceLoader` + `SessionManager` → `AgentSession`.
- Non-obvious design decisions: it installs a default stream function for extensions that construct an `Agent` themselves (`setDefaultStreamFn(streamSimple)`), with a comment that agent core stays provider-agnostic. The `tools` option has two grammars (allowlist vs `+name`/`-name` modifiers) and mixing them is an error. `noTools: "all" | "builtin"` distinguishes "no tools at all" from "no built-in tools but keep extension tools".
- Edge cases / failure handling: an unresolvable model falls back through settings to the first available model, with a formatted "no models available" message.
- Surprising: the MCP tools stay registered for codemode/tool_search unless the allowlist names an `mcp__` entry.

### packages/coding-agent/src/core/session-cwd.ts
- Purpose: detect a session whose recorded cwd no longer exists.
- Key abstractions: `getMissingSessionCwdIssue()`, `assertSessionCwdExists()`, `MissingSessionCwdError`.
- Data flow: session header cwd → `existsSync` → issue or undefined.
- Non-obvious design decisions: the error message and the prompt text are separate functions because one is for a thrown error and the other for an interactive question.
- Edge cases / failure handling: a session with no file has no issue.
- Surprising: n/a.

### packages/coding-agent/src/core/session-export.ts
- Purpose: export the current branch to JSONL.
- Key abstractions: `exportSessionToJsonl()`, `serializeSessionBranch()`.
- Data flow: branch entries → header + entries (re-parented to a flat chain) → JSONL file.
- Non-obvious design decisions: the export **re-parents** every entry to a flat chain, because the tree's `parentId`s refer to nodes that may not be on the exported branch.
- Edge cases / failure handling: the target directory is created if missing.
- Surprising: the exported file is a valid pi session (same header version) and can be re-imported.

### packages/coding-agent/src/core/session-manager.ts
- Purpose: the append-only session tree and the model-context projection.
- Key abstractions: `SessionManager`, `SessionEntry` union, `buildSessionProjection()`, `buildContextEntries()`, `appendContextEdit()`, `ContextEditEntry`.
- Data flow: `append*` → JSONL entry (child of the current leaf) → `buildSessionProjection()` → the model-visible messages.
- Non-obvious design decisions:
  - The store is append-only. Editing history is done by appending a `context_edit` entry that either omits (`replacement: null`) or replaces the *content* of an earlier entry. Nothing is ever rewritten except during a version migration.
  - `buildSessionProjection` returns `ProjectedSessionEntry[]` — each raw entry paired with the messages it contributes. A compaction-aware view keeps the newest compaction plus the entries from `firstKeptEntryId` onward; an *older* compaction entry retained inside that range contributes no messages ("Only the newest compaction at index zero contributes a checkpoint and summary").
  - A session file is only created once it contains a user or assistant message (`_hasConversation`), and the file is created at the **user** message rather than the first assistant reply, "so the prompt is on disk if the first turn never completes (#10000)."
  - `appendContextEdit` refuses to edit an entry that is not on the active branch, and refuses to edit a role that contributes no editable content.
  - The header discovery scan is bounded (1 MB) so a corrupt or huge file cannot stall startup; a full load remains authoritative.
  - `createBranchedSession` re-chains the retained path when it removes label entries, because labels are real tree nodes that can have children.
  - Version migrations are explicit: v1→v2 adds the tree ids, v2→v3 renames the `hookMessage` role to `custom`.
- Edge cases / failure handling: malformed JSONL lines are skipped; a file that is non-empty but does not parse as a pi session is **not** overwritten ("Session file is not a valid pi session") — only an empty file is initialised. A trailing partial line gets a newline appended to repair the file.
- Surprising: `getSessionName()` reads `fileEntries` directly rather than `getEntries()`, because "the footer calls this on every frame, and `getEntries()` copies the whole session."

### packages/coding-agent/src/core/settings-defaults.ts
- Purpose: the runtime defaults table.
- Key abstractions: `SETTINGS_DEFAULTS`.
- Data flow: n/a (a constant).
- Non-obvious design decisions: the comment says "Runtime defaults shared by settings accessors and the published JSON Schema" — one table, so the schema and the runtime cannot disagree.
- Edge cases / failure handling: n/a.
- Surprising: it includes UI defaults (`outputPad: 1`, `markdown.codeBlockIndent`, `tuiMode: "fullscreen"`) alongside the harness-relevant ones (`compaction.reserveTokens: 16384`, `keepRecentTokens: 20000`, `retry.maxRetries: 3`).

### packages/coding-agent/src/core/settings-diagnostics.ts
- Purpose: turn settings load errors into diagnostics.
- Key abstractions: `collectSettingsDiagnostics()`, `deduplicateDiagnostics()`.
- Data flow: `settingsManager.drainErrors()` → diagnostics.
- Non-obvious design decisions: dedup keeps the first occurrence, because "Startup and runtime settings managers can report the same file error."
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/coding-agent/src/core/settings-manager.ts
- Purpose: global + project settings with per-scope writes.
- Key abstractions: `SettingsManager`, `FileSettingsStorage`, `InMemorySettingsStorage`, `applyToolModifiers()`, `mergeDefaultTools()`, `DEFAULT_TOOL_NAMES`.
- Data flow: `settings.json` (global) + `<cwd>/.pi/settings.json` (project) → deep merge → accessors; writes are per-scope and locked.
- Non-obvious design decisions:
  - `defaultTools` has a special merge rule: a list of plain names **replaces** the inherited list, while a list of only `+name`/`-name` entries is **appended** so it modifies the inherited selection. The rationale is that a plain list says "these are the tools", and a modifier list says "and also/except".
  - The project scope is only trusted when the project is trusted (`projectTrusted` option).
  - Writes are serialised through a `writeQueue` promise and use a `proper-lockfile` lock with a sync retry loop.
  - Global and project writes are tracked separately (`modifiedFields`, `modifiedNestedFields`, `modifiedProjectFields`), so a project write never rewrites the global file.
- Edge cases / failure handling: an invalid settings file becomes a stored error and is drained as a diagnostic rather than thrown; a malformed `defaultTools` value replaces instead of throwing at merge time.
- Surprising: `getToolListError` rejects mixing plain names and `+name`/`-name` entries — the same rule as the CLI. **I read the first 330 lines and the exported surface, not all 1.2k lines.**

### packages/coding-agent/src/core/settings-schema.ts
- Purpose: the `settings.json` schema.
- Key abstractions: `SettingsSchema` and every settings sub-schema/type.
- Data flow: n/a (types + schema).
- Non-obvious design decisions: compaction supports `modelOverrides` keyed by exact `"provider/modelId"` strings, so one model can have different reserve/keep budgets than another. `timeoutSetting` allows the literal `"disabled"`. `nonNegativeSafeInteger` bounds every numeric setting.
- Edge cases / failure handling: n/a.
- Surprising: `Settings` omits `queueMode`, `retry`, `skills` and `websockets` from the raw input — they are derived or handled elsewhere.

### packages/coding-agent/src/core/skills.ts
- Purpose: discover and validate skills.
- Key abstractions: `loadSkills()`, `loadSkillsFromDir()`, `formatSkillsForPrompt()`, `Skill`.
- Data flow: directories → `SKILL.md` files → frontmatter → validated skills → `<available_skills>` block in the prompt.
- Non-obvious design decisions:
  - Discovery stops at a directory containing `SKILL.md` (that directory *is* a skill root); otherwise `.md` children of the root are skills too.
  - Names are validated per the Agent Skills spec (lowercase, digits and hyphens only, no leading/trailing/double hyphen, ≤ 64 chars) and descriptions are required and ≤ 1024 chars — but a skill with *warnings* is still loaded; only a missing description drops it.
  - The prompt block uses XML (`<available_skills><skill><name>…</name><description>…</description><location>…</location></skill>`) with XML escaping, and only the **name, description and location** — the body is not in the prompt.
  - `disable-model-invocation: true` keeps a skill out of the prompt; it can still be invoked explicitly via `/skill:name`.
  - The prompt names the tool that can load the file: `read`, `bash`, or `indirect` when the reader is only reachable through another tool — "A hidden reader is still reachable through another tool, so skills stay but the hint names no tool."
- Edge cases / failure handling: symlinks are resolved (broken ones skipped); `.gitignore`/`.ignore`/`.fdignore` are honoured; a name collision is reported as a `collision` diagnostic with winner and loser.
- Surprising: skills are loaded from `~/.pi/agent/skills` and `<cwd>/.pi/skills`, and duplicate files reached through symlinks are silently skipped via a canonicalised-path set.

### packages/coding-agent/src/core/slash-commands.ts
- Purpose: the built-in slash command list.
- Key abstractions: `BUILTIN_SLASH_COMMANDS`, `SlashCommandInfo`.
- Data flow: n/a (a constant table).
- Non-obvious design decisions: the list is the discoverability contract for the user; extension commands, prompt templates and skills are merged in separately (`agent-session.ts:_bindExtensionCore`).
- Edge cases / failure handling: n/a.
- Surprising: 26 built-in commands, including `/trust` and `/share`.

### packages/coding-agent/src/core/source-info.ts
- Purpose: the provenance record attached to every resource.
- Key abstractions: `SourceInfo`, `createSourceInfo()`, `createSyntheticSourceInfo()`, `isSyntheticPath()`, `getSyntheticPathSource()`.
- Data flow: n/a.
- Non-obvious design decisions: `scope` is `user | project | temporary` and `origin` is `package | top-level`; synthetic paths (`builtin:read`, `<inline:name>`) have no file and get `scope: "temporary"`.
- Edge cases / failure handling: n/a.
- Surprising: the same `SourceInfo` shape is used for tools, skills, prompts, themes and extensions.

### packages/coding-agent/src/core/system-prompt.ts
- Purpose: build the system prompt.
- Key abstractions: `BuildSystemPromptOptions`, `NormalizedBuildSystemPromptOptions`, `buildSystemPromptSections()`, `buildSystemPromptState()`, `diffSystemPromptSections()`.
- Data flow: options → ordered sections → `SystemMessage.sections` → the provider's system message.
- Non-obvious design decisions:
  - **The default prompt is one sentence**: "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files." Everything else is a *section*.
  - The sections are `preamble` (untagged), `tools`, `rules`, `docs`, `addendum`, `project_context`, `skills`, `cwd`, plus any custom sections; every section except `preamble` is wrapped in a tag of the same name so the model can match later updates to it.
  - The rules are *derived from the active tool set*: the "use bash for file operations" rule appears only when bash is active and grep/find/ls are not; per-tool `promptGuidelines` are folded in and de-duplicated; two fixed rules ("Be concise in your responses", "Show file paths clearly when working with files") are always last.
  - The docs section is a *pointer* to pi's own docs and examples, with explicit rules about resolving `docs/...` under the docs path rather than the cwd, and "Always read pi .md files completely and follow links to related docs".
  - `diffSystemPromptSections` produces a *patch*: only sections whose text changed are sent, and a removed section becomes `null`. This is what keeps the provider's prompt cache warm.
  - A `forceSystemPrompt` (from a `before_agent_start` handler) replaces the whole prompt and is stored opaquely in `content` with no sections.
- Edge cases / failure handling: a custom section name must match `^[a-z][a-z0-9_-]*$` and may not be `preamble`, or the build throws.
- Surprising: the prompt is *not* one blob; it is a diffable map of named sections, and the tool list in it is generated from the active tool set.

### packages/coding-agent/src/core/telemetry.ts
- Purpose: install-telemetry opt-in.
- Key abstractions: `isInstallTelemetryEnabled()`.
- Data flow: `PI_TELEMETRY` env override, else the setting.
- Non-obvious design decisions: `1`, `true` and `yes` (case-insensitive) all count as enabled.
- Edge cases / failure handling: an empty env var falls through to the setting.
- Surprising: the env var wins over the setting, in both directions.

### packages/coding-agent/src/core/timings.ts
- Purpose: startup profiling.
- Key abstractions: `resetTimings()`, `time()`, `printTimings()`.
- Data flow: labelled timestamps → per-namespace totals → stderr report.
- Non-obvious design decisions: enabled only by `PI_TIMING=1`; the whole file is a no-op otherwise, so the call sites are free.
- Edge cases / failure handling: n/a.
- Surprising: there is a `"main"` and an `"extensions"` namespace, so extension loading is timed separately.

### packages/coding-agent/src/core/tools/bash.ts
- Purpose: the shell tool.
- Key abstractions: `createShellToolDefinition()`, `createLocalShellOperations()`, `BashOperations`, `BashSpawnHook`.
- Data flow: command → `resolveSpawnContext` (env + cwd + hook) → `ops.exec` → `OutputAccumulator` → throttled `onUpdate` → truncated text + temp file.
- Non-obvious design decisions:
  - `resolveSpawnContext` deletes `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL` from the environment and then re-adds only what `exposeSessionEnvironment` allows — so a session's identity is exposed deliberately, not by accident.
  - A `spawnHook` can rewrite the command, cwd or env.
  - The child is detached on POSIX and the whole process tree is killed on abort/timeout (`killProcessTree`), and the pid is tracked so it can be reaped.
  - A signal-killed shell has no exit code; the code becomes `128 + signal` (the standard shell convention) so a termination is not mistaken for success.
  - `onUpdate` is throttled to 100 ms (`BASH_UPDATE_THROTTLE_MS`) and always carries a *snapshot* with `persistIfTruncated: true`, so the UI never re-reads the whole output.
  - The command may be sent over **stdin** instead of argv when the shell config says so (`commandTransport === "stdin"`), which avoids Windows command-line length limits and quoting problems.
- Edge cases / failure handling: timeout → `timeout:<seconds>` error text; abort → `"aborted"`; a null exit code → "Command terminated without an exit code".
- Surprising: `structuredContent` carries the *full* output (up to 1 MB, head+tail) while the model-facing text carries only the truncated tail — a deliberate split between "what the model sees" and "what a script sees".

### packages/coding-agent/src/core/tools/edit-diff.ts
- Purpose: diff computation and edit matching.
- Key abstractions: `applyEditsToNormalizedContent()`, `fuzzyFindText()`, `normalizeForFuzzyMatch()`, `generateDiffString()`, `generateUnifiedPatch()`, `computeEditsDiff()`.
- Data flow: file content + edits → LF-normalised → match (exact, then fuzzy) → replacements applied in reverse → diff + patch.
- Non-obvious design decisions:
  - Fuzzy matching normalises NFKC, strips trailing whitespace, maps smart quotes to ASCII, maps Unicode dashes to `-`, and maps exotic spaces to a plain space — so a model that pasted a curly quote still matches.
  - When a fuzzy match was used, the result is produced by `applyReplacementsPreservingUnchangedLines`, which rewrites only the lines a replacement actually touched and copies every other line back from the original, "so duplicate normalized lines cannot be aligned to the wrong occurrence."
  - Overlapping edits are rejected with an explicit "merge them into one edit" message; a non-unique `oldText` is rejected with the occurrence count.
  - The diff is a *display* diff (line numbers, context with a `...` gap) while the patch is a standard unified diff from the `diff` package.
  - `computeEditsDiff` computes the diff **without applying it** — used by the TUI to preview an edit before it runs.
- Edge cases / failure handling: an edit that produces identical content throws ("No changes made to …"), which catches a wrong-character encoding.
- Surprising: the "no change" error is treated as an error, not a no-op, because it usually means a character was mangled.

### packages/coding-agent/src/core/tools/edit.ts
- Purpose: the edit tool.
- Key abstractions: `createEditToolDefinition()`, `EditToolInput`, `prepareEditArguments()`.
- Data flow: arguments → `prepareEditArguments` (shape repair) → mutation queue → read → BOM strip → LF normalise → match → write → diff.
- Non-obvious design decisions:
  - `prepareEditArguments` is a *compatibility shim* for models that send `edits` as a JSON string, or as a single `{oldText,newText}` object, or use the legacy top-level `oldText`/`newText` fields. The comment names the models: "Opus 4.6, GLM-5.1".
  - The abort signal is **not** honoured from an event listener inside the mutation: "that would release the mutation queue while an in-flight filesystem operation may still finish." Instead `signal.aborted` is checked after each `await`, so the queue stays locked until the operation settles.
  - The BOM is stripped before matching ("The model will not include an invisible BOM in oldText") and restored on write; the original line ending is detected and restored.
  - The tool description and guidelines push the model toward *one* call with multiple `edits[]` entries, each matched against the original file.
- Edge cases / failure handling: a missing file, a failed access, a non-unique `oldText`, and an empty `oldText` each get their own specific message.
- Surprising: `renderShell: "self"` — the edit tool draws its own framing in the TUI rather than using the standard shell.

### packages/coding-agent/src/core/tools/file-mutation-queue.ts
- Purpose: serialise mutations of the same file.
- Key abstractions: `withFileMutationQueue()`.
- Data flow: `realpath` → per-path promise chain → run → release.
- Non-obvious design decisions: the queue key is the **realpath**, so two different paths to the same file (a symlink and its target) serialise against each other. The *registration* is itself serialised through a global `registrationQueue`, so two concurrent registrations cannot interleave and create two chains for the same key.
- Edge cases / failure handling: a missing path falls back to the resolved path (a file being created has no realpath yet).
- Surprising: different files still run in parallel — the queue is per path, not global.

### packages/coding-agent/src/core/tools/find.ts
- Purpose: the find tool.
- Key abstractions: `createFindToolDefinition()`, `FindOperations`, `relativizeFindResultPath()`.
- Data flow: glob → `fd` (or a custom `glob`) → relativised paths → limit + byte truncation.
- Non-obvious design decisions: `fd` ignores `.gitignore` outside a git repo, so pi walks up looking for a `.git` directory and only then drops `--no-require-git` — "so parent .gitignore rules stop at nested repo boundaries" (issue #5960). A pattern containing `/` switches fd to `--full-path` and gains a `**/` prefix, because fd matches basenames in glob mode. On Windows the pattern's `/` becomes `[/\\]`.
- Edge cases / failure handling: a non-zero fd exit with no output is an error; a non-zero exit *with* output is not.
- Surprising: results are relativised against the search root and normalised to posix separators, so the model's paths are stable.

### packages/coding-agent/src/core/tools/grep.ts
- Purpose: the grep tool.
- Key abstractions: `createGrepToolDefinition()`, `GrepOperations`.
- Data flow: pattern → `rg --json` → stream of matches → formatted blocks → limit + byte truncation.
- Non-obvious design decisions: `--no-config` is passed so the tool contract cannot depend on an ambient `RIPGREP_CONFIG_PATH` — "Users can customize via bash or extensions." Matches are collected during streaming and formatted *after* rg exits, so a custom async `readFile` backend can supply context lines.
- Edge cases / failure handling: the match limit kills the child (a distinct `killedDueToLimit` flag so the exit code is not treated as an error); long lines are truncated to 500 chars with a "use read tool to see full lines" notice.
- Surprising: the output format distinguishes match lines (`path:line: text`) from context lines (`path-line- text`), which is ripgrep's own convention.

### packages/coding-agent/src/core/tools/index.ts
- Purpose: the tool registry barrel.
- Key abstractions: `createAllToolDefinitions()`, `createCodingToolDefinitions()`, `createReadOnlyToolDefinitions()`, `allToolNames`.
- Data flow: n/a.
- Non-obvious design decisions: there is a *read-only* tool set (read, grep, find, ls) separate from the coding set (read, bash, edit, write) — a one-line way to get a safe agent.
- Edge cases / failure handling: an unknown tool name throws.
- Surprising: `ToolName` includes `powershell`, so the tool set is eight wide even though the default is four.

### packages/coding-agent/src/core/tools/ls.ts
- Purpose: the ls tool.
- Key abstractions: `createLsToolDefinition()`, `LsOperations`.
- Data flow: path → stat → readdir → sort → per-entry stat → limit + byte truncation.
- Non-obvious design decisions: entries are sorted case-insensitively and directories get a `/` suffix. Dotfiles are included. An entry that cannot be stat'ed is *skipped* rather than failing the listing.
- Edge cases / failure handling: a missing path and a non-directory get distinct messages; an empty directory returns "(empty directory)".
- Surprising: the tool does not use `ls` — it uses `readdir`, so it is portable and structured.

### packages/coding-agent/src/core/tools/output-accumulator.ts
- Purpose: bounded-memory streaming output accumulation.
- Key abstractions: `OutputAccumulator`, `OutputSnapshot`, `FullOutput`.
- Data flow: `append(Buffer)` → streaming UTF-8 decode → rolling tail (≤ 2× the byte limit) → optional temp file → `snapshot()`.
- Non-obvious design decisions: the accumulator keeps only a *decoded tail* for display and writes the raw bytes to a temp file as soon as the output exceeds the limit, so memory stays bounded no matter how large the output is. The rolling tail is trimmed on a UTF-8 boundary, and `tailStartsAtLineBoundary` records whether the tail begins at a line start so the snapshot can drop the partial first line.
- Edge cases / failure handling: `append` after `finish` throws; `readFullOutput` returns head + tail with an explicit "[… N bytes omitted …]" marker for a file bigger than the requested cap.
- Surprising: `readFullOutput` is a separate API from `snapshot` — one is "what the model sees", the other is "what a script sees".

### packages/coding-agent/src/core/tools/path-utils.ts
- Purpose: path resolution with macOS filename leniency.
- Key abstractions: `resolveToCwd()`, `resolveReadPath()`, `resolveReadPathAsync()`, `expandPath()`, `pathExists()`.
- Data flow: user path → normalise → try the literal, then the AM/PM variant, the NFD variant, the curly-quote variant, and the NFD+curly combination.
- Non-obvious design decisions: the variants exist because macOS stores filenames in NFD and uses a narrow no-break space before AM/PM, and users type a straight apostrophe. The comment on the NFD+curly combination names the case: French macOS screenshots like "Capture d'écran".
- Edge cases / failure handling: if nothing matches, the resolved path is returned unchanged so the caller reports a normal "file not found".
- Surprising: only the *read* path gets the leniency; writes use the strict resolution.

### packages/coding-agent/src/core/tools/powershell.ts
- Purpose: the PowerShell tool.
- Key abstractions: `createPowerShellToolDefinition()`, `createLocalPowerShellOperations()`.
- Data flow: same shell tool, with a UTF-8 console preamble.
- Non-obvious design decisions: every command is prefixed with `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}` so output encoding matches the other shell.
- Edge cases / failure handling: the preamble is inside a `try/catch` so a host without that API still works.
- Surprising: the PowerShell tool is 67 lines because it is entirely configuration of the shared shell tool.

### packages/coding-agent/src/core/tools/read.ts
- Purpose: the read tool.
- Key abstractions: `createReadToolDefinition()`, `ReadOperations`, `ReadToolInput`.
- Data flow: path → access → mime sniff → image branch or text branch → truncation → actionable notice.
- Non-obvious design decisions:
  - Truncation always ends with a **continuation instruction**: "[Showing lines 12-2011 of 4000. Use offset=2012 to continue.]" — the tool tells the model how to resume rather than silently truncating.
  - A first line that alone exceeds the byte limit is a special case: the tool points the model at a bash one-liner (`sed -n 'Np' path | head -c …`) instead of returning nothing.
  - A user-specified `limit` that stops early also produces a continuation notice, so the model knows the file has more.
  - Images that the current model cannot accept still return a text note ("The image will be omitted from this request") rather than failing.
  - `outputSchema` declares a union of string or `{type:"image", …}` so codemode scripts get a typed value; `toReadOutput` picks the image block when there is one.
  - `constrainedSampling: {type:"json_schema", strict:"prefer"}` asks the provider to constrain the arguments.
- Edge cases / failure handling: an offset beyond the end of the file is a clear error with the line count; abort rejects with "Operation aborted".
- Surprising: the read tool reports `structuredContent` separately from the model-facing `content`, and the model sees the image as an attachment plus a text note.

### packages/coding-agent/src/core/tools/render-utils.ts
- Purpose: shared TUI rendering helpers.
- Key abstractions: `formatToolCallWithArgs()`, `toolTimerText()`, `startToolTimer()`, `getTextOutput()`, `renderToolPath()`, `formatReadLineRange()`.
- Data flow: tool args/results → themed strings.
- Non-obvious design decisions: the timer prefers the *recorded* duration from the final result ("it is monotonic and survives reloads") and falls back to the renderer's own clock for live progress. A partial row says "Elapsed 4.2s" and redraws every second; a final row says "Took 4.2s". `formatReadLineRange` accepts numeric *strings* and drops a malformed range entirely rather than printing garbage.
- Edge cases / failure handling: `str()` returns `null` for a non-string, non-null value, and the caller renders "[invalid arg]".
- Surprising: the collapsed tool header cuts the argument preview at exactly 100 characters.

### packages/coding-agent/src/core/tools/renderers/bash.ts
- Purpose: shell tool TUI rendering.
- Key abstractions: `createShellRenderers(prompt)`.
- Data flow: args/result → themed lines → a preview of the last 5 lines.
- Non-obvious design decisions: the collapsed view shows the **end** of the output (`keep: "end"`), because that is where the error is. The truncation footer is stripped from the visible text once the result is final and the full-output path is known, so the path appears once, in the warning line.
- Edge cases / failure handling: a partially truncated last line gets its own message with the line's size.
- Surprising: the same renderer serves both `bash` and `powershell`; only the prompt differs.

### packages/coding-agent/src/core/tools/renderers/edit.ts
- Purpose: edit tool TUI rendering.
- Key abstractions: `editRenderers`, `EditRenderState`.
- Data flow: args → live diff preview (computed before execution) → result diff.
- Non-obvious design decisions: the renderer computes the diff itself with `computeEditsDiff` *while the call is pending*, so the user sees what will change before it happens; when the real result arrives and differs, the real diff wins.
- Edge cases / failure handling: a preview error is only shown if the tool's own error is different, so the message is not duplicated.
- Surprising: the preview is computed by re-running the same matching code the tool will run, so the preview cannot disagree with the outcome.

### packages/coding-agent/src/core/tools/renderers/find.ts
- Purpose: find tool TUI rendering.
- Key abstractions: `findRenderers`.
- Data flow: args/result → themed text, 20-line collapsed preview.
- Non-obvious design decisions: the collapsed preview shows the first 20 lines with a "… (N more lines, <key> to expand)" hint.
- Edge cases / failure handling: the truncation warning lists both the result limit and the byte limit.
- Surprising: n/a.

### packages/coding-agent/src/core/tools/renderers/grep.ts
- Purpose: grep tool TUI rendering.
- Key abstractions: `grepRenderers`.
- Data flow: args/result → themed text, 15-line collapsed preview.
- Non-obvious design decisions: the grep preview is 15 lines, not 20 like find/ls — matches are denser.
- Edge cases / failure handling: a separate warning appears when only *some* lines were truncated.
- Surprising: the pattern is rendered as `/pattern/` to make the regex-ness visible.

### packages/coding-agent/src/core/tools/renderers/ls.ts
- Purpose: ls tool TUI rendering.
- Key abstractions: `lsRenderers`.
- Data flow: args/result → themed text, 20-line collapsed preview.
- Non-obvious design decisions: the path is rendered as a hyperlink when the terminal supports it.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/coding-agent/src/core/tools/renderers/read.ts
- Purpose: read tool TUI rendering.
- Key abstractions: `readRenderers`.
- Data flow: args → (optionally compact) header → highlighted body.
- Non-obvious design decisions: in the collapsed state a read of a `SKILL.md`, a `CLAUDE.md`/`AGENTS.md`, or one of pi's own docs renders as a one-line tag ("[skill] name", "read docs docs/x.md") instead of a path — the interesting part is *what* was read, not where.
- Edge cases / failure handling: the body is only shown when expanded or on error.
- Surprising: `getPiDocsClassification` resolves pi's own package root to recognise "this is pi's documentation" — a read of the harness's own docs is labelled specially.

### packages/coding-agent/src/core/tools/renderers/write.ts
- Purpose: write tool TUI rendering.
- Key abstractions: `writeRenderers`, `WriteHighlightCache`.
- Data flow: streamed content → incremental syntax highlight.
- Non-obvious design decisions: the highlight cache is *incremental*: when the new content starts with the previous content, only the changed tail is re-highlighted, and the first 50 lines are refreshed wholesale (because a syntax highlighter is context-sensitive). A change of path or language rebuilds the cache.
- Edge cases / failure handling: n/a.
- Surprising: a syntax highlighter that is incrementally maintained, because the write tool streams its content.

### packages/coding-agent/src/core/tools/renderers/index.ts
- Purpose: the renderer barrel.
- Key abstractions: `createAllToolRenderers()`, `withBuiltInRenderers()`.
- Data flow: n/a.
- Non-obvious design decisions: the file's header states the reason for the split: "Importing this instead of `core/tools/index.ts` keeps ~17 MB of module graph out of a process that only renders." `ToolExecutionComponent` used to do the lookup itself, which forced every presentation to import the tool implementations.
- Edge cases / failure handling: `withBuiltInRenderers` fills in only the renderers a definition does not supply.
- Surprising: a measurable 17 MB of module graph is kept out of the render path.

### packages/coding-agent/src/core/tools/tool-definition-wrapper.ts
- Purpose: convert between `ToolDefinition` and `AgentTool`.
- Key abstractions: `wrapToolDefinition()`, `wrapToolDefinitions()`, `createToolDefinitionFromAgentTool()`.
- Data flow: definition → tool; plain tool → minimal definition.
- Non-obvious design decisions: the registry is *definition-first* — even a caller-supplied plain `AgentTool` is converted into a minimal `ToolDefinition` so `AgentSession` has one registry shape.
- Edge cases / failure handling: a tool wrapped without a context factory gets no `ExtensionToolContext` (documented: "such as a built-in tool created with `createBashTool()` and run in a plain `Agent`").
- Surprising: the reverse conversion exists purely to preserve the registry invariant.

### packages/coding-agent/src/core/tools/truncate.ts
- Purpose: the shared truncation primitives.
- Key abstractions: `truncateHead()`, `truncateTail()`, `truncateMiddle()`, `truncateLine()`, `formatSize()`.
- Data flow: content → limit → truncated content + a `TruncationResult` describing what happened.
- Non-obvious design decisions: two *independent* limits (2000 lines and 50 KB) and whichever is hit first wins; head truncation never returns a partial line, and reports `firstLineExceedsLimit` instead. Tail truncation may return a partial first line and says so via `lastLinePartial`. `truncateMiddle` keeps half the budget at each end with a `…N chars truncated…` marker — "like Codex does for tool output" — and cuts only at character boundaries. `truncateLine` caps a single grep match line at 500 chars.
- Edge cases / failure handling: `splitLinesForCounting` drops the trailing empty line so a file ending in `\n` is not counted as one extra line.
- Surprising: the `TruncationResult` carries enough metadata for the UI to explain *exactly* what was lost, which is what the continuation notices are built from.

### packages/coding-agent/src/core/tools/write.ts
- Purpose: the write tool.
- Key abstractions: `createWriteToolDefinition()`, `WriteOperations`.
- Data flow: path → mutation queue → mkdir -p → write.
- Non-obvious design decisions: the abort handling mirrors `edit.ts` — the signal is checked after each await rather than in a listener, so the mutation queue is not released while a write may still land.
- Edge cases / failure handling: the parent directory is created automatically.
- Surprising: the tool description says "Use write only for new files or complete rewrites" — it is not a partial editor.

### packages/coding-agent/src/core/trust-manager.ts
- Purpose: the project trust store.
- Key abstractions: `ProjectTrustStore`, `getProjectTrustOptions()`, `hasTrustRequiringProjectResources()`.
- Data flow: cwd → nearest ancestor entry in `trust.json` → decision.
- Non-obvious design decisions: the trust file is keyed by canonicalised directory and a `null` value *deletes* the entry, so a "trust the parent, not this folder" decision is expressible. The file is written with a `proper-lockfile` lock and sorted keys, so concurrent pi processes do not corrupt it. `hasTrustRequiringProjectResources` lists what actually triggers a prompt: `settings.json`, `mcp.json`, `extensions`, `skills`, `prompts`, `themes`, `SYSTEM.md`, `APPEND_SYSTEM.md` under `.pi`, or an `.agents/skills` directory in the cwd or an ancestor. The *user* `~/.agents/skills` is explicitly excluded even when the cwd is `$HOME`.
- Edge cases / failure handling: an invalid trust file (a non-boolean value) throws rather than being silently coerced.
- Surprising: trust is inherited from the nearest ancestor, and the "trust parent folder" option writes two updates (parent true, current null).

### packages/coding-agent/src/core/usage-totals.ts
- Purpose: usage aggregation.
- Key abstractions: `UsageTotals`, `addUsageToTotals()`, `combineUsage()`, `getUsageCostBreakdown()`.
- Data flow: session entries → totals; entries → per-model buckets.
- Non-obvious design decisions: `combineUsage` keeps the optional splits (`cacheWrite1h`, `reasoning`) when *either* side reports them, and sums them. The cost breakdown groups assistant messages by `provider/responseModel ?? provider/model` and puts tool results, branch summaries and compactions into a separate "Tools/summaries" bucket.
- Edge cases / failure handling: n/a.
- Surprising: `responseModel` is preferred over `model` when present, so a virtual model's cost is attributed to the physical model that answered.

### packages/coding-agent/src/core/virtual-models.ts
- Purpose: virtual model catalog entries and the routing contract.
- Key abstractions: `VirtualModelDefinition`, `ModelRouteRequest`, `ModelRoute`, `withVirtualModels()`, `getBranchSelection()`, `getVirtualModelState()`.
- Data flow: virtual model → router → physical model + thinking level + state → state stored as a `pi.virtual-model-state` custom entry on the branch.
- Non-obvious design decisions:
  - A virtual model has its own API id `pi-virtual` and **never reaches a provider**; an unrouted virtual model throws "must be routed before streaming".
  - The routing reason is explicit: `user` (a request after a message the user wrote), `continuation` (any other request in the loop), `retry` (after a failed request, including after compaction for an overflow), `direct` (outside the loop, e.g. a compaction summary).
  - The router gets the *previous successful* response and, for a retry, the failed response — "which `messages` no longer contains."
  - Router state is stored on the session branch as a custom entry, so it survives resume and follows the branch.
  - `getBranchSelection` handles the virtual case explicitly: a virtual `model_change` holds until the next `model_change`, because responses name the *physical* models it routed to; a virtual model that is no longer registered does not hold, so the selection falls back to the model that answered last.
- Edge cases / failure handling: a virtual model shadows a physical chat model with the same id; `withVirtualModels` filters the physical one out of the catalog.
- Surprising: the selection semantics are non-obvious on purpose, and the doc comments explain each case.

### packages/coding-agent/src/experimental/source-resolver.ts
- Purpose: make source runs use the workspace's TypeScript sources.
- Key abstractions: `registerHooks()` resolve hook.
- Data flow: `import` → hook → tsconfig `paths` → a `.ts` file.
- Non-obvious design decisions: Node strips TypeScript natively but does not apply tsconfig path aliases, so "Internal source processes preload this resolver so they cannot silently fall through to stale package dist files." A `.js` specifier is resolved to its `.ts` sibling. Multiple wildcards in one pattern are rejected outright.
- Edge cases / failure handling: a path alias that matches but resolves to nothing throws with the pattern name, rather than falling through to the next resolver.
- Surprising: a security-flavored guarantee: the alias resolution refuses to escape the repository root.

### packages/coding-agent/src/extensions/codemode/execute.lazy.ts
- Purpose: defer the codemode sandbox runtime.
- Key abstractions: `loadCodemodeExecutor()`.
- Data flow: n/a (a dynamic import).
- Non-obvious design decisions: the sandbox runtime is only loaded when a script actually runs.
- Edge cases / failure handling: n/a.
- Surprising: 146 bytes.

### packages/coding-agent/src/extensions/codemode/execute.ts
- Purpose: run one codemode script in the sandbox.
- Key abstractions: `CodemodeSandbox`, `loadQuickJSWasm()`.
- Data flow: script → QuickJS sandbox → nested tool calls → result items.
- Non-obvious design decisions: the sandbox is QuickJS/WASM, so a script cannot reach the host except through the tool API.
- Edge cases / failure handling: n/a (I read the head and the structure, not all 805 lines).
- Surprising: the wasm is loaded from an embedded path in a compiled binary.

### packages/coding-agent/src/extensions/codemode/index.ts
- Purpose: register the codemode tool as an extension.
- Key abstractions: `createCodemodeExtension()`, `CodemodeExtensionOptions`.
- Data flow: options + settings → `pi.registerTool({...})`.
- Non-obvious design decisions: the tool is registered with `defaultActive: false` — "Activate it with `--tools`, the `defaultTools` setting, or `setActiveTools()`." The MCP extension activates it when MCP tools are only reachable from scripts.
- Edge cases / failure handling: an invalid `inlineBudget` in settings is ignored and the default is used.
- Surprising: the extension reads its own settings through `pi.getSettings()` at registration time.

### packages/coding-agent/src/extensions/codemode/renderer.ts
- Purpose: TUI rendering of a codemode run.
- Key abstractions: `codemodeRenderers`.
- Data flow: script → nested call list + cost + output + timer.
- Non-obvious design decisions: "Nested calls are not separate tool rows because they never reach the model as tool calls" — they are shown *inside* the codemode row. The result strips the "Script completed" header (the renderer shows the raw output).
- Edge cases / failure handling: n/a.
- Surprising: the model-call cost of the script is displayed on the same row.

### packages/coding-agent/src/extensions/codemode/tool.ts
- Purpose: the codemode tool definition.
- Key abstractions: `createCodemodeToolDefinition()`, the script API (`tools`, `ALL_TOOLS`, `text()`, `image()`, `exit()`, `store()`/`load()`, `console.*`, `return <value>`).
- Data flow: script → sandbox → nested `ctx.executeTool` calls → a single result the model sees.
- Non-obvious design decisions: nested calls run through the agent loop's tool pipeline, so validation, `tool_call`/`tool_result` hooks and permission checks apply exactly as for direct calls — "Only the script's output reaches the model; nested results do not." A tool that declares an `outputSchema` resolves to its `structuredContent` (even for error results); other tools resolve to their text content; a failed/blocked/invalid call rejects with an Error carrying the tool's error text. `store`/`load` keep JSON values across calls and successful writes are appended to the session as `codemode-store` custom entries, "so each branch sees the values written on its own path."
- Edge cases / failure handling: a failing script returns a normal error result that keeps its partial output.
- Surprising: `// @options:` as the first line of a script sets tool options.

### packages/coding-agent/src/extensions/codemode/worker.ts
- Purpose: the sandbox worker entrypoint for bundled builds.
- Key abstractions: n/a.
- Data flow: n/a.
- Non-obvious design decisions: the Node bundle and the Bun binary build this file as a separate entrypoint "because pi-codemode's own worker file is not on disk there; `getCodemodeWorkerSpecifier()` in config.ts resolves it."
- Edge cases / failure handling: n/a.
- Surprising: a one-line re-export of another package's worker.

### packages/coding-agent/src/extensions/index.ts
- Purpose: the built-in extension list.
- Key abstractions: `builtInExtensions`.
- Data flow: n/a.
- Non-obvious design decisions: `codemode`, `tool-search` and `mcp` are `replaceable: true` — "an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party MCP extension) takes over instead of running alongside the built-in one." `llama.cpp` is not replaceable.
- Edge cases / failure handling: n/a.
- Surprising: all four are `builtin: true`, which means they load after project trust is resolved and cannot handle `project_trust`.

### packages/coding-agent/src/extensions/llama/client.ts
- Purpose: HTTP client for a local llama.cpp server.
- Key abstractions: `LlamaClient`, `LlamaModelInfo`, `normalizeLlamaServerUrl()`.
- Data flow: server URL → model list / load / progress.
- Non-obvious design decisions: the model status vocabulary includes `sleeping` and `downloading` with a progress record.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/coding-agent/src/extensions/llama/huggingface.ts
- Purpose: Hugging Face model lookup and token discovery.
- Key abstractions: `HuggingFaceClient`, `HuggingFaceModel`, `HuggingFaceQuantization`.
- Data flow: repo id → metadata + GGUF file list.
- Non-obvious design decisions: the quantisation pattern recognises `UD-` prefixed and multi-part quants (`IQ3_XXS`) plus BF16/F16/F32/MXFP variants, and shard suffixes (`-00001-of-00005`).
- Edge cases / failure handling: gated repos (`gated: "auto" | "manual"`) are detected.
- Surprising: the token is read from the local Hugging Face cache file, not from an env var.

### packages/coding-agent/src/extensions/llama/index.ts
- Purpose: the llama.cpp extension.
- Key abstractions: `createLlamaExtension()` / the default export.
- Data flow: server connection → provider registration + management commands.
- Non-obvious design decisions: `modelIsLoaded` treats `sleeping` as loaded (it is resident), and connection errors are classified by message text ("fetch failed"/"timeout"/"network") so a dead server gets "Could not connect to the server."
- Edge cases / failure handling: n/a.
- Surprising: it parses a `repository:quantisation` model spec.

### packages/coding-agent/src/extensions/llama/provider.ts
- Purpose: register a pi-ai provider backed by a llama.cpp server.
- Key abstractions: `createLlamaProvider()`, `LLAMA_PROVIDER_ID`.
- Data flow: server → provider with chat, classifier and image APIs.
- Non-obvious design decisions: the classifier and image APIs are loaded lazily (`llama-cpp-classify.lazy`, `typesafe-system-one.lazy`).
- Edge cases / failure handling: n/a.
- Surprising: a local server is presented as an ordinary pi-ai provider, so everything above it is unchanged.

### packages/coding-agent/src/extensions/llama/ui.ts
- Purpose: the TUI for llama model management.
- Key abstractions: `showLlamaUi()`, `runWithProgress()`.
- Data flow: model list + progress → TUI components.
- Non-obvious design decisions: it uses `fuzzyFilter` and `truncateToWidth`/`visibleWidth` for correct wide-character handling.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/coding-agent/src/extensions/mcp/cli.lazy.ts
- Purpose: defer loading the `pi mcp` command.
- Key abstractions: `loadMcpCommand()`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: 139 bytes.

### packages/coding-agent/src/extensions/mcp/cli.ts
- Purpose: the `pi mcp` command.
- Key abstractions: add/remove/check server, sign in.
- Data flow: argv → `mcp.json` mutation or an OAuth flow.
- Non-obvious design decisions: the command is designed for an *agent* to run: "Agents run it through bash to configure servers, verify an `mcp.json` they wrote, and start an OAuth sign-in; the user only approves access in the browser."
- Edge cases / failure handling: the config is validated with the same `validateMcpServerConfig` the runtime uses, so an invalid file is caught at write time.
- Surprising: the trust store is consulted here too (project `mcp.json` is only read for a trusted project).

### packages/coding-agent/src/extensions/mcp/config.ts
- Purpose: load `mcp.json`.
- Key abstractions: `loadMcpConfig()`, `addMcpServerConfig()`, `removeMcpServerConfig()`.
- Data flow: global `mcp.json` + project `<cwd>/.pi/mcp.json` → merged server list.
- Non-obvious design decisions: a project entry **without** `command`, `url` or `type` overrides only `enabled`, `exposure` and `toolExposure` of the global server of the same name — "The rest of the global entry is kept, including credentials the project could not set itself." The file shape is the `mcpServers` shape other MCP clients use, so configs can be copied over.
- Edge cases / failure handling: project entries replace global entries with the same name.
- Surprising: the merge semantics are field-based, not entry-replacement.

### packages/coding-agent/src/extensions/mcp/index.ts
- Purpose: the built-in MCP integration.
- Key abstractions: the extension factory, connection management, tool registration.
- Data flow: `mcp.json` + extension-registered servers → background connections → `mcp__<server>__<tool>` tool definitions.
- Non-obvious design decisions:
  - Connections run in the background: "the first prompt waits only for servers with `direct` tools, and codemode scripts, `tool_search`, and the resource tools wait for the servers they need when they run."
  - The default exposure is `codemode`, which keeps MCP tools out of the model's declarations *and* out of the codemode description — scripts find them with `searchTools()` and the server's instructions with `describeNamespace()`. The codemode tool is auto-enabled for that unless `autoEnableCodemode` is false.
  - `deferred` declares the tools to the model once `tool_search` loads them, and activates `tool_search` instead of codemode.
  - A server in `mcp.json` takes precedence over an extension-registered server of the same name.
  - Every MCP call runs through pi's tool pipeline, so `tool_call`/`tool_result` hooks and permission extensions apply to MCP tools exactly as to built-in ones.
- Edge cases / failure handling: resources are exposed through Codex's three tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`).
- Surprising: the whole point of the default exposure is that MCP does *not* enlarge the model's tool list.

### packages/coding-agent/src/extensions/mcp/log.ts
- Purpose: persist MCP server log notifications.
- Key abstractions: append + rotation.
- Data flow: `notifications/message` → `mcp.log` → rotate to `mcp.log.1` past 5 MB.
- Non-obvious design decisions: "Several pi processes may write to the same file, so every message is one synchronous append" — a single `appendFileSync` per message rather than a buffered stream, so two processes cannot interleave a partial line.
- Edge cases / failure handling: malformed payloads are stringified rather than thrown.
- Surprising: n/a.

### packages/coding-agent/src/extensions/mcp/oauth.ts
- Purpose: OAuth sign-in for remote MCP servers.
- Key abstractions: `McpOAuthProvider`, authorization-code flow with PKCE.
- Data flow: server 401 → refresh attempt → `McpOAuthAuthorizationRequiredError` → user runs `/mcp` → browser flow → loopback callback → credentials in `mcp-auth.json`.
- Non-obvious design decisions: "Connections never start a browser flow on their own." Credentials are keyed by server name *and* URL, so the same server on two URLs has two entries. The client registration mode is `dcr` (dynamic client registration) or `cimd` (a Client ID Metadata Document on pi.dev).
- Edge cases / failure handling: a loopback callback server serves the redirect.
- Surprising: the sign-in is a separate user action, not a side effect of connecting.

### packages/coding-agent/src/extensions/mcp/resources.ts
- Purpose: MCP resources as tools.
- Key abstractions: `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`.
- Data flow: server resources → JSON listings → text/images for the model, temp files for binaries.
- Non-obvious design decisions: the listing shape is JSON "as in Codex": `{server?, resources: [{server, ...resource}], nextCursor?}` — "so models trained on those tools use them unchanged." MCP App resources (`ui://` URIs, `profile=mcp-app` HTML) and icons are excluded, because they are user interfaces for hosts that render them.
- Edge cases / failure handling: a binary resource is saved to a temp file and referenced.
- Surprising: the tool names are chosen for model compatibility, not for pi's own naming conventions.

### packages/coding-agent/src/extensions/mcp/runtime.lazy.ts
- Purpose: defer loading the MCP client.
- Key abstractions: `loadMcpRuntime()`.
- Data flow: n/a.
- Non-obvious design decisions: "Loads the MCP client, transports, and OAuth sign-in on first use."
- Edge cases / failure handling: n/a.
- Surprising: 150 bytes.

### packages/coding-agent/src/extensions/mcp/runtime.ts
- Purpose: the MCP client, transports and retries.
- Key abstractions: `McpClient`, `McpAuthRequiredError`, `McpSessionExpiredError`.
- Data flow: server config → transport → JSON-RPC → typed results.
- Non-obvious design decisions: the module is split out so `index.ts` does not pull the MCP client in until a server is configured.
- Edge cases / failure handling: auth-required and session-expired are distinct error types so the caller can react differently.
- Surprising: n/a.

### packages/coding-agent/src/extensions/mcp/tools.ts
- Purpose: adapt MCP tools to pi tool definitions.
- Key abstractions: `createMcpToolDefinition()`-style helpers, the `CallToolResult` output schema.
- Data flow: MCP `CallToolResult` → pi content (text + images).
- Non-obvious design decisions: text over 20 KB keeps its start and end with the middle cut out, "like Codex does", and the full text is saved to a temp file the model can read. Codemode scripts receive the **whole** `CallToolResult` without `_meta`, never truncated, as the tool's `structuredContent` — and every MCP tool declares a `CallToolResult` output schema, so the script always gets the structured form.
- Edge cases / failure handling: an MCP error (`isError`) is an error result for the model, but the script still resolves to the result.
- Surprising: the same tool result is delivered in two different shapes depending on who is asking.

### packages/coding-agent/src/extensions/mcp/ui.ts
- Purpose: the `/mcp` manager view.
- Key abstractions: `showMcpUi()`-style components.
- Data flow: registry + connection state → menus.
- Non-obvious design decisions: the menus "rebuild while servers connect", because the server set changes in the background.
- Edge cases / failure handling: the sign-in screen accepts a pasted redirect URL, for users who cannot open the browser.
- Surprising: n/a.

### packages/coding-agent/src/extensions/tool-search/index.ts
- Purpose: register `tool_search`.
- Key abstractions: `createToolSearchExtension()`.
- Data flow: n/a.
- Non-obvious design decisions: registered with `defaultActive: false` — same pattern as codemode.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/coding-agent/src/extensions/tool-search/tool.ts
- Purpose: BM25 tool discovery.
- Key abstractions: `Bm25Ranker`, `ToolRanker`, `createToolSearchDocument()`, `tokenize()`, `TOOL_SEARCH_DESCRIPTION`.
- Data flow: query → tokenise → BM25 over the searchable tools' documents → activate the matches → the next model call declares them.
- Non-obvious design decisions:
  - The ranker is pluggable: "BM25 today; a hybrid ranker with embeddings can replace it."
  - The document text is the tool name, the name with `_` as spaces, the description, the schema's descriptions and property names (recursively, including `anyOf`/`oneOf`/`allOf` variants), and the namespace's name, description and instructions.
  - Tokenisation splits camelCase, lowercases, drops stop words, and applies a naive singular stemmer so `issues` matches `issue`.
  - The tool's own description is **static** — it does not list the searchable tools or their namespaces, "so it stays the same while tools are registered, for example when MCP servers connect." That keeps the model's prompt stable.
  - Activation goes through the active tool set, so it is "recorded in the transcript like any other tool change and survives `/tree`, resume, and fork on that branch."
  - `exposure: "model-only"` and `reachesTools: () => "all"` — searching changes what the model sees, so scripts have no need to call it.
- Edge cases / failure handling: an empty query and a non-positive limit are errors.
- Surprising: the discovery tool is itself a tool, and the *result* of the search is a change to the model's world rather than information.

### packages/coding-agent/src/index.ts
- Purpose: the package's public API.
- Key abstractions: re-exports of the session, compaction, tools, extensions, settings and config paths.
- Data flow: n/a.
- Non-obvious design decisions: it is also the module map injected into extensions (`virtual-modules.ts` imports `../../index.ts`).
- Edge cases / failure handling: n/a.
- Surprising: `parseSkillBlock` is exported — the parser for the `<skill name=… location=…>` block the model sees is public.

### packages/coding-agent/src/main.ts
- Purpose: the CLI main function.
- Key abstractions: `main(argv)`.
- Data flow: argv → mode (text/json/rpc) → session creation → run.
- Non-obvious design decisions: argument parsing and the auth subcommands are handled *before* the session is created, so `pi auth check` never spins up a model runtime with network access. The file's header says "This file handles CLI argument parsing and translates them into `createAgentSession()` options. The SDK does the heavy lifting."
- Edge cases / failure handling: n/a (I read the head and the structure, not all 906 lines).
- Surprising: the CLI is a thin translation layer over the SDK.

### packages/coding-agent/src/migrations.ts
- Purpose: one-time startup migrations.
- Key abstractions: `migrateAuthToAuthJson()`, keybinding migration.
- Data flow: legacy files → `auth.json` / renamed keybindings.
- Non-obvious design decisions: the migration is skipped entirely if `auth.json` already exists, so it can never clobber a current store. The migration guide and extensions-doc URLs are embedded so the user can read what happened.
- Edge cases / failure handling: each legacy source is migrated independently; a failure in one does not stop the others.
- Surprising: n/a.

---

## Ideas worth stealing

- **The model-visible context is a projection of an append-only tree, and history is edited by appending, never by rewriting** — `packages/coding-agent/src/core/session-manager.ts:543` (with `appendContextEdit` at `packages/coding-agent/src/core/session-manager.ts:1360`). Every entry is a JSONL line with `id`/`parentId`; the messages the model sees are computed by `buildSessionProjection()` from the current leaf path, applying `context_edit` entries that omit or replace an earlier entry's contribution. **Why it matters for August:** it gives you branch-and-retry-without-data-loss for free. August's `_omitRecoveryAttempt` currently has to mutate persisted state to drop a failed turn; with this shape it would append a `context_edit` and the failed turn would stay on disk, auditable, while leaving the context. The projection is also the natural place to put a "world delta" computation — the projection already knows exactly which entries are visible now.

- **A failed attempt is removed from the model context by a durable context edit, and the tool-result pairing is kept** — `packages/coding-agent/src/core/agent-session.ts:1244`. `_omitRecoveryAttempt` finds the assistant message's tool calls, collects the matching tool results, and appends a `context_edit` for each of them, then refreshes the projection. It throws if a projected message has no source entry. **Why it matters for August:** August's stuck-request ladder reshapes history; this is the mechanism that lets a repair be *recorded* rather than applied destructively, and the "unpaired tool result" check is the exact invariant August's 400-error class is fighting.

- **The system prompt is a one-sentence preamble plus named, individually replaceable sections, and the request sends a DIFF of the sections** — `packages/coding-agent/src/core/system-prompt.ts:128` (build) and `packages/coding-agent/src/core/system-prompt.ts:217` (diff). `diffSystemPromptSections` returns only the sections whose text changed, with a removed section becoming `null`; the patch is carried in `SystemMessage.sections`. **Why it matters for August:** this is how pi keeps the provider's prompt cache warm while the prompt stays dynamic (skills, cwd, tool list all change). August's prompt has a `<memory>` tail and a live tool list; a section diff means a changed tool list costs one changed section instead of a whole new prompt, and it makes "what did the prompt say this turn" a per-section question.

- **The prompt's rules are DERIVED from the active tool set, not written as a static block** — `packages/coding-agent/src/core/system-prompt.ts:88` (`buildRules`). "Use bash for file operations like ls, rg, find" is only emitted when bash is active *and* grep/find/ls are not; per-tool `promptGuidelines` are folded in and de-duplicated; two fixed rules always come last. **Why it matters for August:** August has per-model capability profiles (bare/reduced/full tool surfaces). Deriving the rules from the surface means the bare profile does not leave a prompt that says "use grep" when grep is not there — the class of bug August's `toolSurface` work is trying to avoid.

- **A tool set has an EXPOSURE vocabulary, and the exposure decides whether the model sees the tool, whether a script can call it, and whether it appears in the tool list at all** — `packages/coding-agent/src/core/extensions/types.ts:516` (`ToolExposure`) with the enforcement in `packages/coding-agent/src/core/agent-session.ts:1574` (`_getToolExposure`) and `packages/coding-agent/src/core/agent-session.ts:1582` (`_getCallableTools`). Five values: `direct`, `model-only`, `codemode`, `deferred`, `hidden`. **Why it matters for August:** this is a cleaner model than August's "core tools / bare allowlist" split, and it directly solves the problem the AGENTS.md notes describe ("progressive disclosure can never hide the key lookup that `remember`'s own instructions depend on") — with exposures, a memory tool can be `model-only` (always declared) while a bulk tool is `deferred` (loaded on demand), and the *declaration* is separate from the *callability*.

- **Tool discovery is BM25 over tool metadata, and the result is a change to the tool set, not a list** — `packages/coding-agent/src/extensions/tool-search/tool.ts:119` (ranker) and `packages/coding-agent/src/extensions/tool-search/tool.ts:195` (`searchAndLoad`). The document text is the name, the description, the schema's descriptions and property names, and the namespace instructions; the matches are *activated* through the active tool set, so the change is recorded in the transcript and survives `/tree`, resume and fork. The tool's own description is deliberately static so the prompt does not churn as MCP servers connect. **Why it matters for August:** August has a `tool_search`-like path (a `tool_call` dispatcher that reaches an arbitrary name) and a `brain_query` over facts. The BM25-over-schema-properties trick is a cheap way to make a tool discoverable by what it *does*, and "activation is a transcript-recorded change" is how August could add tools to a running turn without invalidating its audit trail.

- **MCP tools are `codemode`-exposed BY DEFAULT, so connecting a server does not enlarge the model's tool list** — `packages/coding-agent/src/extensions/mcp/index.ts:1` (the header states the whole policy) and `packages/coding-agent/src/core/mcp-servers.ts:60` (`McpExposure`). The scripts find the tools with `searchTools()`; the server's instructions come from `describeNamespace()`. **Why it matters for August:** this is the "many tools, small context" problem solved by *default policy* rather than by pruning. August's `_SUBAGENT_NEVER_TOOLS` and per-model `maxTools` are manual; an exposure default would make the common case correct by construction.

- **The cut point for compaction may never land on a tool result, and a split turn produces TWO summaries** — `packages/coding-agent/src/core/compaction/compaction.ts:351` (`isCutPointMessage`) and `packages/coding-agent/src/core/compaction/compaction.ts:446` (`findCutPoint`). Cut points are user-like or assistant messages only; when the cut lands mid-turn, pi summarises the *history* and separately summarises the *turn prefix* into a "Original Request / Progress So Far / Context Needed to Continue" note, then merges them. **Why it matters for August:** August's compaction keeps a verbatim head of 4 messages and summarises the rest; the paired-summary shape (a history summary plus a turn-prefix summary) is a better answer than one summary when the cut lands in the middle of a turn, and the "never cut at a tool result" rule is a correctness invariant August's `landmark pins` work is implicitly about.

- **A turn's context is re-projected and re-compacted BEFORE every assistant response, not only at the end of a run** — `packages/coding-agent/src/core/agent-session.ts:776` (`_compactBeforeNextAssistantResponse`) and `packages/coding-agent/src/core/agent-session.ts:898` (`_installAgentNextTurnRefresh`). The next-turn hook rebuilds the projection, compacts if the projection exceeds the threshold, then rebuilds the prompt and tool loadout and returns a *system message patch*. **Why it matters for August:** August's "one compaction site" rule (`_compactionCall`) is about not having several *implementations*; pi's rule is about *when* to compact — on the projection, before the request, so the threshold is checked against what will actually be sent. The two compose: a single site, invoked from the request path.

- **Steering and follow-up are two separate queues with two separate modes, and the queue state is tracked twice (agent-side and session-side)** — `packages/coding-agent/src/core/agent-session.ts:2275` (`steer`) and `packages/coding-agent/src/core/agent-session.ts:2291` (`followUp`), with the mirror lists in `_steeringMessages`/`_followUpMessages` and the `queue_update` event. A queued message is removed from the UI list only when the model actually starts a message with that text. **Why it matters for August:** the "remove when the model's user message starts" trick is how the UI stays truthful without a separate acknowledgement protocol; and the separation of *steer* (interrupt the current turn) from *follow-up* (wait for the turn to end) is the distinction August's "user typing mid-turn" logic needs.

- **Tool output truncation is a *typed result*, not a string** — `packages/coding-agent/src/core/tools/truncate.ts:78` (head), `:168` (tail), `:292` (middle). `TruncationResult` records which limit was hit, the total and output line/byte counts, whether the last line was partial, and whether the first line exceeded the limit; the tools then build the continuation notice from that data ("[Showing lines 12-2011 of 4000. Use offset=2012 to continue.]"). **Why it matters for August:** August's `_MAXFileSize`/paging and the `check:truncate` gate are about making truncation *correct*; pi's shape makes truncation *explainable*, which is what a model needs in order to resume correctly. The middle-truncation mode (keep head and tail) is also better than a plain head cut for a tool result where the error is at the end.

- **A tool can rewrite how the model's view of the tool set is presented, and can hide a *declaration* while keeping the tool callable** — `packages/coding-agent/src/core/extensions/types.ts:566` (`ToolLoadoutChanges`) and `packages/coding-agent/src/core/agent-session.ts:1595` (`_applyToolLoadout`), with the projection at `packages/coding-agent/src/core/agent-session.ts:1787`. `prepareLoadout` may change model-facing descriptions and may list a tool in `hiddenDeclarations`; the tool stays active and callable and the transcript still declares it, so the loadout survives `/tree` and resume. **Why it matters for August:** August's "a knob that always refuses is a lie" principle (see the AGENTS.md note on `_authority_refusal`) has a positive form here: a tool that is unreachable in the model's view should say so in its own description, and a tool that is reachable only through another tool should not be listed as if the model could call it directly.

- **Extension contexts are guarded getters, and staleness is enforced by throwing with a message that names the API to use instead** — `packages/coding-agent/src/core/extensions/runner.ts:884` (`createContext`) and `packages/coding-agent/src/core/extensions/runner.ts:997` (`createCommandContext`, which copies property *descriptors* rather than spreading). **Why it matters for August:** the "do not use a captured ctx after ctx.newSession()" message is exactly the class of bug August's stale-agent records; the mechanism (guarded getters + a message that names the correct call) is worth copying verbatim, including the "copy descriptors, not values" trick.

- **A session file is only created once the conversation has content, and it is created at the USER message** — `packages/coding-agent/src/core/session-manager.ts:1166` (`_hasConversation`) and `packages/coding-agent/src/core/session-manager.ts:1172` (`_persist`). The comment gives the reason: "Starting at the user message (not the first assistant reply) keeps the prompt on disk if the first turn never completes (#10000)." **Why it matters for August:** it is a tiny, exactly-reasoned durability rule — the crash case is "the model died mid-first-turn" and the fix is to flush the *user* side first. August's turn-outcome ledger solves the same problem from the other end.

- **Prompt-cache warming is priced, not assumed: a refresh is sent only when `expectedSavings ≥ $0.05`** — `packages/coding-agent/src/core/cache-warmer.ts:20` (the constant) and `packages/coding-agent/src/core/cache-warmer.ts:29` (the TTL schedule). The decision is `continuationProbability × missCost − warmCost`, with a measured constant continuation probability of 0.15, and the replay is refused for Anthropic budget-based thinking because the replay would get a different `budget_tokens` — which Anthropic keys the message cache on. **Why it matters for August:** the "is warming worth it" arithmetic is reusable for any cache-prefill policy, and the refusal case is the kind of provider-specific fact that is impossible to rediscover.

- **Cache misses are accounted per turn, with a noise floor, and a compaction resets the comparison but a MODEL SWITCH does not** — `packages/coding-agent/src/core/cache-stats.ts:73` (`detectMiss`) and `packages/coding-agent/src/core/cache-stats.ts:107` (`scan`). **Why it matters for August:** "a model switch re-bills the whole prompt and should be counted" is a rule August's per-model pricing work needs; the miss is priced from the message's own paid rate versus the cache-read rate, so a cache-write premium is handled correctly.

- **The "two rooms" split: renderers live apart from implementations so a render-only process never loads the execution path** — `packages/coding-agent/src/core/tools/renderers/index.ts:1` (the "~17 MB of module graph" note) and `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts:8`. The tool definition carries the renderers, and the renderer barrel is importable on its own. **Why it matters for August:** the August desktop app and the backend are separate processes; a renderer that drags in the whole execution graph is a startup-cost and a surface-area problem.

- **Bun/SEA/bundled-Node builds get a virtual module map injected into jiti, so an extension can import pi's own packages** — `packages/coding-agent/src/core/extensions/virtual-modules.ts:15` and the three-way resolution in `packages/coding-agent/src/core/extensions/loader.ts:562`. **Why it matters for August:** if August ever ships a plugin surface, this is the answer to "how does a plugin import the harness's types without a second copy of them" — the old package names are aliased to the new ones so old plugins keep working.

- **Config values can be a literal, an env reference, or a shell command, and a missing env var makes the WHOLE value unresolved** — `packages/coding-agent/src/core/resolve-config-value.ts:120` (template parsing) and `:186` (`resolveConfigValue`). `$$` escapes a literal `$`; `$!` escapes a literal `!`; command output is cached for the process lifetime. **Why it matters for August:** the "whole value unresolved" rule is the difference between "the key is missing" and "the key is half-set" — August's provider-key handling would otherwise silently send a partial key.

---

## Files skipped (with reasons)

- `packages/coding-agent/src/core/export-html/vendor/highlight.min.js` — vendored, minified highlight.js v11.9.0 (121 KB). I read the first lines to confirm the library and version and the banner; it is a third-party build, so reading it line by line would not tell us anything about pi's design.
- `packages/coding-agent/src/core/export-html/vendor/marked-cjk-friendly.min.js` — vendored, minified marked-cjk-friendly v0.1.2 (4.7 KB). Same reason; I confirmed the library and version from the header comment.
- `packages/coding-agent/src/core/export-html/vendor/marked.min.js` — vendored, minified marked v18.0.11 (44 KB). Same reason; I confirmed the library and version from the header comment.

No other file was skipped. Every other file in the shard was opened and read; for the largest ones I read the file's head plus its exported surface (or a large contiguous portion) rather than every line, and I say so in the per-file note.

---

## Uncertainties

- **The manifest was re-sharded while I was working.** When I started, the manifest assigned exactly 152 files to `coding-agent-src#1`. By the time I finished, the lead had rewritten the manifest: shard ids are now directory-prefixed (`packages-coding-agent-32`, `packages-ai-06`, …) and no shard named `coding-agent-src#1` exists any more. My 152 files are now spread across nine new shards (`packages-coding-agent-14` ×32, `-07` ×21, `-13` ×21, `-11` ×18, `-09` ×15, `-15` ×13, `-12` ×13, `-08` ×10, `-10` ×8). **What I checked:** I re-read the manifest, grouped its column 4, confirmed zero rows match `coding-agent-src#1`, then mapped each of my 152 paths onto the new manifest and confirmed **all 152 are present** (none missing, none invented) and recorded their new shard ids. The rows file I wrote contains exactly the 152 paths of the original shard, in the original order, so it can be merged by path regardless of how the shards were renumbered.
- **I did not read these files line by line**, and say so in their notes: `core/package-manager.ts` (2469 lines — head + exported surface), `core/resource-loader.ts` (1163 — head + exported surface), `core/settings-manager.ts` (1443 — first 330 lines + exported surface), `core/export-html/template.js` (~80 KB — head and the data-loading/deep-link section), `extensions/codemode/execute.ts` (805 — head and structure), `main.ts` (906 — head and structure). I did not read the *whole* of `core/extensions/types.ts` (2304 lines) either, but I read it in three large contiguous chunks covering every section, so I believe I saw all of it; the sections I skimmed fastest were the `MessageRenderOptions`/`MarkdownTransformContext` block and the `ProviderConfig` doc comments.
- **The agent loop's core (`@earendil-works/pi-agent-core`) and the provider layer (`@earendil-works/pi-ai`) are in sibling packages and are not in my shard.** I can describe how pi *calls* them (`agent.prompt()`, `agent.continue()`, `agent.steer()`, `agent.followUp()`, `runToolCall`, `streamSimple`, `retryAssistantCall`, `normalizeContext`, `getCurrentSystemMessage`, `getCurrentTools`), but I could not read their implementations. In particular I could not verify: what `agent.prompt()` itself does between turns, whether the low-level loop applies a turn cap (the repo's own docs say the reference harness "has no turn bound"), and the exact semantics of `steeringMode`/`followUpMode` ("all" vs "one-at-a-time") beyond what the property names and their use sites imply.
- **The TUI itself is not in this shard** (`modes/interactive/**` is owned by other shards), so claims about *rendering* are limited to the tool renderers and the components I read here. The `keybinding-hints.ts`, `visual-truncate.ts`, `diff.ts` and `config-selector.ts` components that the renderers call are referenced but unread by me.
- **`core/settings-schema.ts` and `core/settings-manager.ts`**: I confirmed the schema shape and the merge/write semantics, but I did not read every accessor on `SettingsManager` (there are many, one per setting), so I cannot say which settings are exposed to extensions versus only to the TUI.
- **I did not run anything.** No file in the clone was executed, no dependency was installed, and no test was run. Every statement above is from reading source, not from observed behaviour. Where the code's comments assert a behaviour (for example "the `check:sse` style" claims pi itself makes about bug classes) I have reported the comment as the comment.
