# pi / coding-agent-tests#3

## Shard shape

This shard is the **test suite of `packages/coding-agent`** — pi's flagship CLI/agent package — restricted to the alphabetically contiguous block from `fixtures/` through `streaming-render-debug.ts` (139 files: 110 top-level `*.test.ts` / helper modules, 17 skill fixtures, the 4-file `mcp-conformance/` harness, and the 8-file `session-manager/` sub-suite). It is not a coherent subsystem so much as a **cross-section of the whole agent runtime seen from the outside**: every file here is a black-box driver of production code in `packages/coding-agent/src/**`, and the production modules under test span the entire stack — `core/session-manager.ts` (the append-only JSONL tree, branching, labels, compaction entries, context edits), `core/model-runtime.ts` / `core/model-registry.ts` (the provider/model abstraction, credential resolution, catalog refresh), `core/settings-manager.ts` (two-scope settings with external-edit preservation), `core/package-manager.ts` (npm/git/local package installation), `core/resource-loader.ts` (extensions, skills, prompts, themes, context files), `extensions/mcp/**` (MCP config, OAuth, connection lifecycle, tool exposure), `modes/interactive/**` (the TUI: status, footer, dialogs, tree navigation, session selector, settings selector), `modes/rpc/**` (the JSONL RPC surface), and `modes/print-mode.ts` (headless one-shot). The three directories hold the only "meta" material: `fixtures/skills/**` are the frontmatter fixtures that pin the skill-loading contract (valid/invalid names, missing description, unknown fields, name collision), `session-manager/**` pins the session tree and file format in isolation from the TUI, and `mcp-conformance/` is a *differential* harness that runs the **official upstream MCP conformance suite** against pi's client and diffs every check against a committed baseline. The shard's overall shape is: **pi's behaviour is pinned by regression-numbered tests rather than by specification**, so the tests themselves are the best available statement of intent — many comments and test names explain *why* a rule exists rather than only *what* it is.

## Per-file notes

### packages/coding-agent/test/fixtures/large-session.jsonl
- Purpose: 974 KB / 1019-line real captured session transcript used as a load/performance fixture.
- Data flow: line 1 is a `{"type":"session",...}` header with `cwd`, `provider`, `modelId`, `thinkingLevel`; every later line is a `{"type":"message",...}` envelope carrying a full provider `message` with `usage` (input/output/cacheRead/cacheWrite/cost) and `stopReason`.
- Non-obvious design decisions: the capture includes aborted turns (`"stopReason":"aborted"`, `"errorMessage":"Request was aborted"`) and mid-session model/provider switches (`api: "openai-responses"` on an `anthropic`-headed session), i.e. it is deliberately a *messy* transcript.
- Surprising: the last visible line is the model reasoning that "the TUI package must have a different API than what coding-agent is expecting" — the fixture is a real debugging session, not synthetic data.
- Read status: opened head and tail (first 3 and last 1 lines, 1019 lines total). Not read line by line because it is a ~1 MB generated capture of a real conversation, not hand-written logic.

### packages/coding-agent/test/fixtures/skills-collision/first/calendar/SKILL.md
Fixture: a minimal valid skill named `calendar` with description "First calendar skill." — one of a pair used to pin the **name-collision precedence rule** (first-loaded wins).

### packages/coding-agent/test/fixtures/skills-collision/second/calendar/SKILL.md
Fixture: the *second* `calendar` skill, identical shape but description "Second calendar skill." — exists only to collide with the first by name.

### packages/coding-agent/test/fixtures/skills/consecutive-hyphens/SKILL.md
Fixture: skill whose frontmatter name is `bad--name` (two consecutive hyphens) — pins that consecutive hyphens are *accepted* (only the character set and the 64-char length are validated).

### packages/coding-agent/test/fixtures/skills/disable-model-invocation/SKILL.md
Fixture: carries the non-standard frontmatter field `disable-model-invocation: true` — the flag that makes a skill invocable only by an explicit `/skill:<name>` command, never by the model.

### packages/coding-agent/test/fixtures/skills/invalid-name-chars/SKILL.md
Fixture: name `Invalid_Name` (uppercase + underscore) — pins that an invalid name is a *warning*, not a rejection: the skill still loads.

### packages/coding-agent/test/fixtures/skills/invalid-yaml/SKILL.md
Fixture: frontmatter `description: [unclosed bracket` — pins that unparseable YAML is handled (the skill is skipped with a diagnostic rather than crashing the loader).

### packages/coding-agent/test/fixtures/skills/long-name/SKILL.md
Fixture: a 96-character `name:` — pins the 64-character name limit as a warning while the skill still loads.

### packages/coding-agent/test/fixtures/skills/missing-description/SKILL.md
Fixture: frontmatter with `name` but **no** `description` — the one fixture where the skill is *not* loaded at all, because the description is the trigger the model reads.

### packages/coding-agent/test/fixtures/skills/multiline-description/SKILL.md
Fixture: `description: |` block scalar spanning three lines — pins that multiline descriptions are normalised to a single line before being shown to the model.

### packages/coding-agent/test/fixtures/skills/name-mismatch/SKILL.md
Fixture: directory `name-mismatch` but frontmatter `name: different-name` — pins that the frontmatter name wins and the directory name is irrelevant (no warning).

### packages/coding-agent/test/fixtures/skills/nested/child-skill/SKILL.md
Fixture: a skill one directory deep — pins that skills are discovered recursively.

### packages/coding-agent/test/fixtures/skills/no-frontmatter/SKILL.md
Fixture: a markdown file with no `---` block at all — pins that a non-skill file in the skills tree is ignored rather than reported as an error.

### packages/coding-agent/test/fixtures/skills/root-skill-preferred/nested-child/SKILL.md
Fixture: a nested skill with a description but **no name** — pins that a nameless nested skill is ignored in favour of the root skill.

### packages/coding-agent/test/fixtures/skills/root-skill-preferred/SKILL.md
Fixture: a root-level skill with a description but no name — pins that the *root* skill is preferred over a nested one when both lack a name.

### packages/coding-agent/test/fixtures/skills/unknown-field/SKILL.md
Fixture: frontmatter carrying `author:` and `version:` — pins that unknown frontmatter keys are ignored without a diagnostic.

### packages/coding-agent/test/fixtures/skills/valid-skill/SKILL.md
Fixture: the canonical valid skill (`name: valid-skill`, one-line description) used as the positive control for the loader.

### packages/coding-agent/test/mcp-conformance/README.md
- Purpose: documents the MCP **client conformance** harness — it runs the official `@modelcontextprotocol/conformance` suite against pi's own client and compares every reported check with a committed `baseline.json`.
- Key abstractions: `baseline.json` records, per protocol version (`2025-03-26`, `2025-06-18`, `2025-11-25`) and per scenario, the list of `passing` and `failing` check ids.
- Data flow: `run.ts` lists the upstream suite's client scenarios → runs each → the upstream suite starts a scenario server and runs `client.ts` → every check is compared with the baseline.
- Non-obvious design decisions: the run **fails** in three distinct ways (a baseline-passing check regresses; a check fails that the baseline does not list as failing; a baselined scenario did not run), and "Checks that started passing are reported; update the baseline to lock them in" — a regression in the *good* direction is surfaced rather than silently absorbed. Known failures stay visible in the output rather than being deleted from the baseline.
- Edge cases: `auth/scope-retry-limit` is baselined as failing *by design* (pi's simulated user gives up after three sign-ins); `elicitation-sep1034-client-defaults` fails because pi does not implement elicitation; `auth/basic-cimd` fails because pi registers OAuth clients dynamically rather than with a Client ID Metadata Document; `2026-07-28` (a stateless protocol pi does not speak) is excluded from the mode list.
- Surprising: the README insists "do not regenerate it to hide a regression" — the baseline is an audit trail, not a cache.

### packages/coding-agent/test/mcp-conformance/baseline.json
- Purpose: the committed expected-result file for the MCP client conformance suite.
- Key abstractions: `conformance` pins the upstream package version (`@modelcontextprotocol/conformance@0.2.0-alpha.11`); `modes[version][scenario] = { passing: [...], failing: [...] }`.
- Data flow: `run.ts` parses this file, filters it to the requested modes/scenarios, and diffs the observed check statuses against it.
- Non-obvious design decisions: every scenario carries an extra synthetic check named `pi-client` that records whether the pi client itself completed the scenario — so "the client crashed" is a first-class baseline entry rather than an absence.
- Edge cases: the `json-schema-2020-12-preservation` scenario lists keyword-level checks (`$defs`, `$schema`, `additionalProperties`, sep-2106 anchor/composition/conditional keywords) — the baseline pins that pi's client does not *drop* schema keywords when it forwards a tool schema.

### packages/coding-agent/test/mcp-conformance/client.ts
- Purpose: the **client under test** — a script the upstream suite launches against a scenario server.
- Key abstractions: `toolCalls(scenario, connection)` maps a scenario name to the tool calls pi should make; `visitAuthorizationUrl` simulates a browser approving an OAuth request without following the redirect.
- Data flow: it drives pi's real production code — `McpServerConnection` connects and calls tools, `signInMcpServer` runs the OAuth sign-in that `/mcp` starts, `createDefaultTransport` builds the transport, `McpOAuthCredentialStore` persists credentials, and `InMemoryAuthStorageBackend` keeps them in memory so the test leaves nothing on disk.
- Non-obvious design decisions: the simulated browser fetches the authorization URL with `redirect: "manual"` and then delivers the redirect to pi's **loopback callback server**, i.e. the real OAuth redirect flow is exercised end to end. When the server demands more scope it asks again, and the simulated user signs in again — up to three times, which is exactly the limit `auth/scope-retry-limit` checks.
- Edge cases: `MAX_SIGN_INS = 3` and `REQUEST_TIMEOUT_SECONDS = 20`; a failed scenario is reported through `PI_MCP_CONFORMANCE_REPORT` and the process exits explicitly ("a failed scenario can leave sockets of the server under test open").
- Surprising: the script's final line is `process.exit(await main())` with a comment explaining that it is not optional — the leaked sockets would hang the suite.

### packages/coding-agent/test/mcp-conformance/run.ts
- Purpose: the runner that fetches the pinned upstream suite, executes every client scenario per protocol version, and diffs the result with `baseline.json`.
- Key abstractions: `MODES = ["2025-03-26", "2025-06-18", "2025-11-25"]`; `ScenarioResult.checks` is a `Map<checkId, "pass"|"fail">` where a repeated id passes only if *every* instance passes; `Baseline` mirrors the baseline file's shape.
- Data flow: `runCommand` spawns `npx --yes @modelcontextprotocol/conformance@0.2.0-alpha.11 list --client --spec-version <mode>`, then per scenario the suite is started and `client.ts` is run with `MCP_CONFORMANCE_SCENARIO` / `MCP_CONFORMANCE_CONTEXT` / `PI_MCP_CONFORMANCE_REPORT` in the environment.
- Non-obvious design decisions: the child is spawned `detached: true` and the timeout kills the whole **process group** (`process.kill(-child.pid, "SIGKILL")`) — "the runner spawns the client and scenario servers; end the whole group", because killing only the direct child leaves the servers holding the port. `npm_config_ignore_scripts=true` is set for the npx fetch, so a fetched package cannot run an install script. `IGNORED_STATUSES = new Set(["INFO","SKIPPED"])` separates "the suite emitted a trace line" from "the suite asserted something".
- Edge cases: a baseline recorded for a different conformance package version is a hard error ("baseline.json is for X, not Y. Regenerate it."); `--update-baseline` writes a full run's results; `--keep-results` preserves `checks.json`; the temp work directory is removed in a `finally` unless `--keep-results` was passed.
- Surprising: the "known failures" of the upstream suite are *baselined* rather than suppressed, so the report always shows them.

### packages/coding-agent/test/footer-data-provider.test.ts
- Purpose: pins the footer's git-branch detection, including Git's **reftable** backend and worktrees.
- Key abstractions: `FooterDataProvider` keeps two `FSWatcher`s — a `headWatcher` on `HEAD` and a `reftableWatcher` on `reftable/tables.list` — and `child_process` is mocked so `git symbolic-ref` can be scripted.
- Data flow: on a `HEAD`/`tables.list` change the provider re-reads the branch; `spawnSync` is used for the synchronous path and `execFile` for the async one.
- Non-obvious design decisions: the fixtures build a *worktree* by hand — `.git/worktrees/src/HEAD`, a `commondir` of `../..`, and a `reftable/tables.list` — because a worktree's HEAD lives in a different directory than the main repo's. The reftable layout is detected by the presence of `.git/reftable`, and the provider watches `tables.list` because in a reftable repo there is no `refs/heads/` file to watch.
- Edge cases / failure handling: a watcher `error` event (e.g. simulated `EMFILE`) disposes the watcher and schedules a **re-create after exactly 5000 ms**; the test asserts that at 4999 ms the watcher is still null and at 5000 ms it is a *new* object (`not.toBe(originalWatcher)`) — i.e. the recovery is a timed retry, not an immediate respawn.
- Surprising: `git rev-parse --git-dir` failing is the signal for "not a git repository", and the provider silently keeps the last known branch rather than clearing it.

### packages/coding-agent/test/footer-width.test.ts
- Purpose: pins the footer's layout — that every footer line stays inside the terminal width, that the cwd is abbreviated, and that cost figures are labelled correctly.
- Key abstractions: `createSession` fabricates an `AgentSession` from a fake `sessionManager.getEntries()` returning a mix of `message` / `branch_summary` / `compaction` / tool-result entries, each carrying its own `usage` — so the footer has to aggregate usage across four different entry kinds.
- Data flow: `FooterComponent(session, dataProvider).render(width)` → ANSI text → `stripAnsi` → assertions; `visibleWidth` from `pi-tui` is used to assert the *display* width, not the character count.
- Non-obvious design decisions: `formatCwdForFooter("/home/user2", "/home/user")` must NOT abbreviate to `~/user2` — a sibling directory that merely shares the home prefix is not under home. The home directory itself renders as `~` and descendants as `~/project`.
- Edge cases: a session name of 30 repetitions of `한글` (Hangul) is used to prove the width budget is measured in terminal cells, not code units.
- Surprising: "explicitly identified subscription auth" is rendered as `$0.000 (sub)`, but a generic OAuth sign-in on `openrouter` is **not** marked `(sub)` — the marker is reserved for a subscription the provider actually declares.

### packages/coding-agent/test/format-resume-command.test.ts
- Purpose: pins the `pi --session <id>` command that the footer prints so a user can resume a session.
- Key abstractions: `formatResumeCommand(sessionManager)` returns a string or `undefined`; the `SessionManager` is faked with `isPersisted`, `getSessionFile`, `getSessionId`, `getSessionDir`, `usesDefaultSessionDir`.
- Data flow: `process.stdout.isTTY` is redefined with `Object.defineProperty` to control whether the hint is printed at all.
- Non-obvious design decisions: the command is only produced for a **persisted** session whose file exists; the session dir is included only when it is not the default dir, and it is shell-quoted with POSIX single-quote escaping (`'/tmp/custom pi'\''s sessions'`).
- Edge cases: four distinct `undefined` returns — non-TTY stdout, in-memory session, missing session file, unset session file. `format-resume-command.test.ts:31` asserts the quoted form rather than a bare path.

### packages/coding-agent/test/frontmatter.test.ts
- Purpose: pins the frontmatter parser used by skills, prompts and `AGENTS.md`.
- Key abstractions: `parseFrontmatter<T>(text)` returns `{ frontmatter, body }`; `stripFrontmatter(text)` returns just the body.
- Data flow: text → YAML parse of the block between `---` fences → typed object plus the remaining body.
- Non-obvious design decisions: CRLF is normalised before parsing; an **unterminated** frontmatter block is not an error — the whole text is returned as the body (`frontmatter.test.ts:32-41`), because a file that merely starts with `---` is more likely prose than a broken skill.
- Edge cases: invalid YAML **throws** (with the YAML engine's `at line 1, column 10` position), a `|` block scalar keeps its trailing newline, and a comment-only frontmatter yields `{}` rather than `null`.
- Surprising: `stripFrontmatter` does *not* trim a body that has no frontmatter (`"\n  No frontmatter body  \n"` is returned verbatim), while it does trim when it did remove a block.

### packages/coding-agent/test/git-merge-and-resolve-extension.test.ts
- Purpose: pins the `git-merge-and-resolve` **example extension**, which automatically merges upstream and hands unresolved conflicts back to the model.
- Key abstractions: the extension registers an `agent_end` handler; the test drives it by capturing the handler through a fake `ExtensionAPI.on` and invoking it with `{ type: "agent_end" }` and an `ExtensionContext`.
- Data flow: the handler asks git for `rev-parse --git-dir`, `rev-parse MERGE_HEAD`, `status --porcelain`, `rev-parse --abbrev-ref --symbolic-full-name @{u}`, then `fetch origin` and `merge`; the conflict list comes from `git diff --name-only --diff-filter=U` and the conflict hunks are read from the working files.
- Non-obvious design decisions: the extension uses `sendUserMessage` to re-inject the conflicts — a *user* message, so the model treats them as new instructions rather than as its own failed output. The test asserts the injected text names the hunk range and the side sizes (`"empty-ours.ts:1-4 (ours empty, theirs 3)"`).
- Edge cases: it skips entirely when the cwd is not a git repo (exactly one exec call, no message), when no upstream is configured, and when a merge fails but no conflict markers are found (a failed merge with nothing to resolve produces *no* message).
- Surprising: when a merge is already in progress (`MERGE_HEAD` exists) the extension does **not** fetch or merge again — it re-sends the existing conflicts.

### packages/coding-agent/test/git-ssh-url.test.ts
- Purpose: pins `parseGitUrl`, the parser for extension install sources.
- Key abstractions: the return shape `{ host, path, repo, ref? }`; `null` means "not a git URL".
- Data flow: a source string → either a protocol URL (`https://`, `ssh://`, optionally with `@ref`) or a shorthand that is accepted **only** behind the `git:` prefix.
- Non-obvious design decisions: the prefix requirement is a deliberate safety choice — `git@github.com:user/repo` without `git:` is rejected so a stray scp-style string cannot silently become a clone target; `git:github.com/user/repo` is normalised to an `https://` repo URL while `git:git@github.com:user/repo` keeps the ssh form.
- Edge cases / failure handling: `git-ssh-url.test.ts:65-76` is the important one — a list of unsafe install paths is rejected: `..` traversal, percent-encoded traversal (`..%2F`), a trailing `%`, an absolute path after the colon, a backslash separator, and a NUL byte. All must return `null`.

### packages/coding-agent/test/git-update.test.ts
- Purpose: pins `DefaultPackageManager.update()` for git-backed extensions, especially the force-push case.
- Key abstractions: the installed layout is `agentDir/git/<host>/<path>`; `parseSource` and `getGitInstallPath` are reached through a `PackageManagerPathInternals` type to reach private methods.
- Data flow: a local "remote" repo is created in a temp dir; `resolveExtensionSources([gitSource], { temporary: true })` fetches, force-updates the remote-tracking ref (`+refs/heads/main:refs/remotes/origin/main`) and resets the checkout.
- Non-obvious design decisions: the fetch uses the **forced** refspec `+refs/heads/main:refs/remotes/origin/main` with `--prune --no-tags`, because a force-push rewrites history and a non-forced fetch would be rejected; `runCommandCapture` is stubbed for `rev-parse HEAD` / `@{upstream}` so the manager's own comparison logic is exercised without a network.
- Edge cases: the source string must carry the `git:` prefix, because bare `github.com/...` is *not* recognised as a git URL by `parseSource` — the test says so in a comment at `git-update.test.ts:77-79`.

### packages/coding-agent/test/http-dispatcher.test.ts
- Purpose: pins pi's HTTP proxy handling and the global undici dispatcher configuration.
- Key abstractions: `applyHttpProxySettings(url)` writes the settings value into `HTTP_PROXY`/`HTTPS_PROXY`; `configureHttpDispatcher()` installs an undici dispatcher.
- Data flow: a real `net.createServer` acts as a CONNECT proxy and a real `http.createServer` acts as the origin; the test asserts on the *proxy request line* to prove the tunnel was used.
- Non-obvious design decisions: `applyHttpProxySettings` **never overrides an existing environment proxy** — the environment wins over the app setting, and an empty/whitespace value is ignored entirely. The dispatcher is given a 2-second `autoSelectFamilyAttemptTimeout` (`autoSelectFamilyAttemptTimeout: 2_000`) instead of changing Node's global default, and the test asserts the global default is unchanged (`net.getDefaultAutoSelectFamilyAttemptTimeout()` equals the original) and that `autoSelectFamily` is *not* set on the connect options.
- Edge cases: the dispatcher is closed and the global dispatcher restored in `afterEach`, and the test asserts two consecutive proxied requests both succeed (connection reuse).

### packages/coding-agent/test/image-process.test.ts
- Purpose: pins image format detection and the conversion of formats pi cannot send.
- Key abstractions: `processImage(bytes, mimeType, { autoResizeImages })` returns a discriminated result `{ ok: true, data, mimeType, hints }` or a failure; `detectSupportedImageMimeType(buffer)` sniffs magic bytes.
- Data flow: a 58-byte BMP is synthesised byte by byte (`createTinyBmp1x1Red24bpp`) and pushed through the pipeline.
- Non-obvious design decisions: **conversion happens before resizing** — the test runs the same BMP with `autoResizeImages: false` and with resizing enabled and asserts the same PNG result either way, so the format fix is not bypassed by the resize path. The user-visible trace is a *hint* string, `[Image converted from image/bmp to image/png.]`, not an error.
- Edge cases: both GIF signatures (`GIF87a` and `GIF89a`) are recognised; the PNG result is verified by magic bytes rather than by a snapshot.

### packages/coding-agent/test/image-processing.test.ts
- Purpose: pins the Photon-based image resize/convert utilities.
- Key abstractions: `convertToPng(bytes)` + `loadPngTranscoder()`; `resizeImage(...)` returns `{ data, mimeType, width, height, originalWidth, originalHeight, wasResized }`; `formatDimensionNote(result)` produces the human note.
- Data flow: base64 PNG/JPEG fixtures (2x2, 2x1, 100x100, 200x200) are decoded and resized.
- Non-obvious design decisions: `formatDimensionNote` returns `undefined` when the image was **not** resized, so the caller can omit the note entirely; when it was, the note carries the original size, the displayed size *and* the scale factor (`"2.00"`).

### packages/coding-agent/test/image-resize-callers.test.ts
- Purpose: pins every **caller** of the resize path — the read tool, the CLI file processor and the model-profile plumbing.
- Key abstractions: `../src/utils/image-resize.js` is module-mocked so `resizeImage` is observable; `createReadTool` vs `createReadToolDefinition` (the latter takes an `ExtensionToolContext` carrying the current model).
- Data flow: a PNG on disk → `tool.execute(...)` or `processFileArguments([...])` → either an image attachment or a text "Image omitted" result.
- Non-obvious design decisions: when auto-resize cannot produce a safe image the read tool returns **one text block** containing "Image omitted" and the file processor returns **zero** images plus the same text — the failure mode is "no picture plus an explanation", never a half-broken attachment. `processFileArguments(paths, { autoResizeImages: false })` defers the resize entirely, which is what lets the resize happen at prompt dispatch with the model's profile.
- Edge cases: the resize profile comes from `model.inputLimits.images.resize` and is forwarded verbatim (`expect(resizeImage).toHaveBeenCalledWith(expect.any(Uint8Array), "image/png", resize)`), so a per-model image limit is honoured rather than a global one.

### packages/coding-agent/test/initial-message.test.ts
- Purpose: pins how the first prompt of a session is assembled from CLI arguments, piped stdin and file contents.
- Key abstractions: `buildInitialMessage({ parsed, stdinContent, fileText })` returns `{ initialMessage }` and **mutates** `parsed.messages` to consume the first CLI message.
- Data flow: `stdin` → `fileText` → first CLI message, joined with newlines; remaining CLI messages stay queued for later turns.
- Non-obvious design decisions: the first CLI message is *consumed* into the initial prompt rather than sent separately, so a piped file plus `pi "summarise this"` arrive as one prompt; the remaining messages survive in `parsed.messages` for subsequent turns.

### packages/coding-agent/test/input-transform-streaming-example.test.ts
- Purpose: pins the `input-transform-streaming` example extension, which rewrites user input before it reaches the model.
- Key abstractions: the extension subscribes to the `input` event and returns an `InputEventResult` of `{ action: "continue" }` or `{ action: "transform", text }`; `streamingBehavior` is `"steer"` or `"followUp"`.
- Data flow: the test emits `{ type: "input", text, source: "interactive", streamingBehavior }` and inspects both the returned action and whether `exec` ran.
- Non-obvious design decisions: **steering skips the exec entirely** (`input-transform-streaming-example.test.ts:42-47`) — a steer interrupts the running turn, and running a command at that moment would be both slow and surprising; a `followUp` is queued and *does* run the transform. When the transform's command fails or produces no output the extension returns `continue`, so a failed enrichment never blocks the user's text.

### packages/coding-agent/test/interactive-mode-anthropic-warning.test.ts
- Purpose: pins the one-time warning shown when the user authenticates to Anthropic with a subscription token.
- Key abstractions: the test calls the prototype method directly — `(InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, { provider })` — with a hand-built `fakeThis`; `Reflect`-style private access is used elsewhere in the suite.
- Data flow: `modelRuntime.checkAuth()` returns the stored credential; `modelRuntime.getAuth()` resolves the token only when the credential is not already known.
- Non-obvious design decisions: the warning fires **once** per session (the `anthropicSubscriptionWarningShown` flag) and the expensive `getAuth()` lookup happens at most once — the test asserts both counts. When the credential is already known to be OAuth (`checkAuth` returned `{ type: "oauth" }`), `getAuth()` is *not* called at all, so a token-refresh failure cannot suppress the warning.
- Edge cases: a non-Anthropic provider never warns; and when the `anthropicExtraUsage` warning setting is disabled, neither `checkAuth` nor `getAuth` is called.

### packages/coding-agent/test/interactive-mode-assistant-diagnostics.test.ts
- Purpose: pins the notice shown when Anthropic silently drops `thinking` blocks from the request.
- Key abstractions: the assistant message carries a `diagnostics` array with a `type: "anthropic_input_transformations"` entry listing `thinking_dropped` events with a `path` and a `reason` (`prefix_binding_mismatch`); `maybeShowThinkingDropNotice` is pulled off the prototype with `Reflect.get`.
- Data flow: a real `Container` from `pi-tui` receives the notice component; the test renders it and strips ANSI.
- Non-obvious design decisions: the notice is **suppressed when the same diagnostic already exists in the session branch** (`interactive-mode-assistant-diagnostics.test.ts:83-94`) — otherwise every retry of the same turn would re-announce the same drop. The notice is gated by the `getShowCacheMissNotices()` setting, and when that setting is off the container stays empty.
- Surprising: the notice says "Anthropic dropped 3 thinking blocks (details in session)" — the details stay in the transcript, the chat only carries the count.

### packages/coding-agent/test/interactive-mode-bug-report-hint.test.ts
- Purpose: pins *when* pi offers to file a bug report after a failed turn.
- Key abstractions: `maybeSuggestBugReport(message)` classifies the assistant message; `formatCrashExtensionHint(frames)` names the extension whose frame appears in a crash stack.
- Data flow: an `AssistantMessage` with `stopReason: "error"` and an `errorMessage` is fed to the prototype method, which calls `suggestBugReport()` or `maybeShowInstallChangeWarning()`.
- Non-obvious design decisions: an explicit **allow-list of retryable failures** is used rather than a denylist: 500/502/503/504, 429, "Provider overloaded", "Network connection lost", "Request timed out" all suppress the suggestion (`interactive-mode-bug-report-hint.test.ts:27-43`), because those are the provider's problem, not the user's build. Cancellations and aborts suppress it too.
- Edge cases: an install-change error ("Cannot find module './worker.js'") shows the *install* warning instead of the bug-report hint, and the test asserts `suggestBugReport` was never called in that path. `formatCrashExtensionHint` produces an actionable message naming the extension, `pi config` and `pi -ne` to confirm.

### packages/coding-agent/test/interactive-mode-clone-command.test.ts
- Purpose: pins the `/clone` command, which forks the current session into a new one.
- Key abstractions: `handleCloneCommand` reaches `sessionManager.getLeafId()` and `runtimeHost.fork(entryId, { position })`.
- Data flow: `/clone` → `fork(leafId, { position: "at" })` → the editor is cleared, a status message is shown, and the new session's state is rendered.
- Non-obvious design decisions: the fork happens at `"at"` the leaf (a copy of the current point, not a branch before it); on success the editor is **emptied** and `renderCurrentSessionState` is *not* called (the new session's own render path handles it) — the test asserts both, including that `showError` was not called and that no extra `requestRender` was issued.
- Edge cases: with no leaf yet, the status is "Nothing to clone yet" and `fork` is never called.

### packages/coding-agent/test/interactive-mode-compaction.test.ts
- Purpose: pins the compaction surface of the interactive mode — cost notices, entry rendering order, and the compaction queue.
- Key abstractions: `addCompactionCostNotice` renders a `compaction_cost` notice of kind `compaction` | `branch_summary`; `renderSessionEntries(entries)` interleaves summaries and their cost notices; `flushCompactionQueue({ willRetry })` re-delivers messages that were queued while a compaction ran.
- Data flow: `SessionEntry[]` (compaction entries carrying `summary`, `firstKeptEntryId`, `tokensBefore`, `usage`) → components in the chat container.
- Non-obvious design decisions: the **cost of a compaction is rendered after its summary**, so the user reads what happened and then what it cost; the two kinds are labelled differently ("Compaction: 100 tokens billed (~$0.13)" vs "Branch summary: …"). The notices are gated by the same `getShowCacheMissNotices()` setting as cache-miss notices.
- Edge cases: `flushCompactionQueue` re-sends a queued message as `{ streamingBehavior: "steer" }` — a steer, not a follow-up, because the user's message arrived *during* the turn and must change the current direction; when the queue is empty nothing is sent and no error is shown.

### packages/coding-agent/test/interactive-mode-extension-dialogs.test.ts
- Purpose: pins the **stacking** behaviour of extension-opened dialogs (confirm prompts and custom inline components).
- Key abstractions: `showExtensionConfirm(title, message, { signal })` and `showExtensionCustom(factory)` both push onto `extensionDialogs` and move focus; `programStatus.setBlocked("extension-dialog", { kind, message })` publishes the blocking reason.
- Data flow: the test drives the prototype methods through a `Proxy` that falls back to the prototype for anything the fake context does not define, then synthesises keystrokes with `focused.handleInput("\x1b")` / `"\r"`.
- Non-obvious design decisions: a second dialog **replaces** the first in the UI but the first is *stacked underneath* — answering the second restores the first, and its promise still resolves (`interactive-mode-extension-dialogs.test.ts:66-88`). This is the fix for #11166, where "a second dialog replaced the first one and the first promise never settled" — the user was left unable to answer a permission prompt forever. The same stacking applies to inline custom components (#9909).
- Edge cases: an `AbortSignal` passed to `showExtensionConfirm` removes that hidden dialog when it aborts and resolves it `false`, without disturbing the dialog on top. A confirm opened *from* an inline custom component stacks above it and, when dismissed, restores the custom component. When the stack empties, focus returns to the editor.

### packages/coding-agent/test/interactive-mode-import-command.test.ts
- Purpose: pins the `/import` and `/export` path commands.
- Key abstractions: `getPathCommandArgument(text, command)` extracts the path; `handleImportCommand(text)` drives `runtimeHost.importFromJsonl(path)`.
- Data flow: `/import <path>` → `showExtensionConfirm("Import session", "Replace current session with <path>?")` → `importFromJsonl` → `handleRuntimeSessionChange()` → status "Session imported from: <path>".
- Non-obvious design decisions: the argument parser enforces **token boundaries** — `/important` is not `/import`, and `/exporter` is not `/export` (`interactive-mode-import-command.test.ts:43-51`). A quoted argument has its quotes stripped; an *unquoted* argument keeps its apostrophes (`/import john's/session.jsonl` → `john's/session.jsonl`), because a path with an apostrophe must survive being typed without shell quoting.
- Edge cases: a missing file raises `SessionImportFileNotFoundError` and is reported as a **non-fatal** error ("Failed to import session: File not found: …"); the fatal-error path is asserted not to have been taken.

### packages/coding-agent/test/interactive-mode-startup-input.test.ts
- Purpose: pins what happens when the user types before the interactive session has finished starting.
- Key abstractions: `handleStartupSubmit(text)`; `setupEditorSubmitHandler()`; `getUserInput()`; `pendingUserInputs` as the holding buffer.
- Data flow: a submit during startup → the text is restored into the editor with the status "Startup is still in progress"; a submit before the input callback is installed → the text is pushed into `pendingUserInputs` and later drained by `getUserInput()`.
- Non-obvious design decisions: the text is **never dropped**. Before the callback exists it is queued and the editor is cleared with the text added to editor history; `getUserInput()` returns the queued text *before* installing a new callback, so a queued startup prompt is delivered first. `flushPendingBashComponents` is called on the early-submit path so a pending bash result is not orphaned.

### packages/coding-agent/test/interactive-mode-status.test.ts
- Purpose: the largest UI test in the shard — pins `showStatus` coalescing, the startup resource listing (extensions, skills, prompts, themes, diagnostics) and the quiet-startup behaviour.
- Key abstractions: `showStatus(message)` writes a status line plus a spacer into `chatContainer` and remembers `lastStatusText` / `lastStatusSpacer`; `showLoadedResources({ force, showDiagnosticsWhenQuiet })` renders a per-scope resource summary; `getCompactExtensionLabels`, `getScopeGroup`, `buildScopeGroups`, `formatScopeGroups` build that summary.
- Data flow: `SourceInfo` (`path`, `source`, `scope: user|project|temporary`, `origin: package|top-level`, `baseDir`) is grouped into scopes and rendered; extension fixtures cover local project files, user files, npm packages, scoped npm packages (`@scope/pi-scoped`), git packages, and CLI-supplied temporary extensions.
- Non-obvious design decisions: **immediately-sequential status messages coalesce** — a second status replaces the first line in place instead of appending (`interactive-mode-status.test.ts:81-98`), but a status that arrives after *something else* was added appends a new line. The startup resource listing is deliberately **compact by default** (a count + labels), with a verbose mode and a quiet-startup mode that suppresses the listing entirely but still shows diagnostics.
- Edge cases: the "quiet" setting has three values (`true`, `"header"`, and the default) and `shouldShowStartupHeader` / `shouldShowStartupDetails` are asserted separately.

### packages/coding-agent/test/interactive-mode-suspend.test.ts
- Purpose: pins Ctrl+Z suspend-to-background, including the Windows refusal.
- Key abstractions: `handleCtrlZ()` stops the TUI, installs a `SIGINT` handler and a one-shot `SIGCONT` handler, and holds the process alive with `setInterval(fn, 2 ** 30)`.
- Data flow: Ctrl+Z → `ui.stop()` → `process.kill(0, "SIGTSTP")` → the shell resumes the process → `SIGCONT` → the `SIGINT` listener is removed, the keep-alive interval is cleared, `ui.start()` and `ui.requestRender(true)`.
- Non-obvious design decisions: the keep-alive is a 2^30 ms interval (≈12.4 days) rather than a promise, because a stopped TUI has no event loop work and the process would otherwise be reaped. On Windows the whole path is refused with "Suspend to background is not supported on Windows" and **no** signal handlers or intervals are registered at all (`interactive-mode-suspend.test.ts:31-63`) — asserted by spying on `setInterval`, `process.on`, `process.once` and `process.kill`.
- Edge cases: if the suspend itself fails (the `process.kill` throws), the temporary handlers are still cleaned up — `clearInterval` and `removeListener("SIGINT", …)` are called — but the TUI is not restarted, so the failure is visible rather than silently swallowed.

### packages/coding-agent/test/interactive-mode-tree-navigation.test.ts
- Purpose: pins the tree-navigation picker (jumping to an earlier entry) and its interaction with streaming and compaction.
- Key abstractions: `showTreeSelector` opens a `TreeSelectorComponent`; `session.navigateTree(targetId, { summarize, customInstructions })`; `session.abort()`; `showExtensionSelector` asks "Summarize?" / "No summary".
- Data flow: the tree is built from `SessionManager.inMemory()`; the test selects a node via `selector.getTreeList().onSelect(targetId)`.
- Non-obvious design decisions: availability is **re-checked after the abort settles** (`interactive-mode-tree-navigation.test.ts:126-143`): the abort is awaited, and *then* the busy flag is read again — because compaction can start while the abort is in flight. When the operation is busy, the rejection is reported as an error and the active operation's UI is left untouched (#9178 / PR #9179): no status indicator is created or cleared, the editor's escape handler is not replaced, the leaf does not move, and the running response is not aborted.
- Edge cases: navigation is allowed when the compaction finished while the dialog was open; an active response is still aborted before navigating, and the queued messages are restored to the editor.

### packages/coding-agent/test/interactive-tui.test.ts
- Purpose: pins the TUI shell itself — alternate-screen selection, the jump-to-bottom hint, the status indicators and clipboard integration.
- Key abstractions: `createInteractiveTui({ tuiMode, showHardwareCursor, logDirectory, terminal })` returns either a regular (in-place) or a fullscreen (alternate-screen) TUI; `isViewportTUI(tui)` tells them apart; `RecordingTerminal extends VirtualTerminal` records every write and the start/stop counts.
- Data flow: `ScrollView` holds the chat; a mouse-wheel escape sequence (`\x1b[<64;1;1M`) scrolls up and the TUI then renders a "↓ Jump to latest message · Ctrl+J" hint using the *configured* keybinding.
- Non-obvious design decisions: the alternate screen is entered **only** when `tuiMode === "fullscreen"` — the test asserts the exact `\x1b[?1049h` sequence is absent for "regular" and present for "fullscreen", so the two modes are provably different renderers rather than a flag.

### packages/coding-agent/test/jev-router-example.test.ts
- Purpose: pins the `jev-router` example extension, which picks a model per *phase* of a task.
- Key abstractions: a `ClassifierModel` (`api: "typesafe-system-one"`) returns a `complexity` probability; the extension maintains a `virtual model` state (`VIRTUAL_MODEL_STATE_ENTRY`) with a `phase` field (`planning` / `implementation`).
- Data flow: the harness (`createHarness`) registers a faux `openai-codex` provider with three models (`gpt-5.6-sol`, `-terra`, `-luna`); the classifier's probability decides which one is dispatched; the dispatched model list is read back from the session messages.
- Non-obvious design decisions: the router switches model *within* a turn — the first edit is made by `sol` and the tool-result follow-up of the same turn goes to `luna` (the expected sequence is `["sol","sol","luna","luna"]`). A complex task (probability 0.8) plans on `sol`; a simple one (0.2) plans on `terra`. A failed tool call does not change the plan.
- Surprising: the phase is persisted as a **custom session entry**, so the router's state survives a reload and is inspectable in the transcript.

### packages/coding-agent/test/keybindings-migration.test.ts
- Purpose: pins the migration of old, un-namespaced keybinding names to the namespaced ids.
- Key abstractions: `runMigrations(agentDir)` rewrites `keybindings.json`; `KeybindingsManager.create(agentDir)` loads the old names in memory.
- Data flow: `cursorUp` → `tui.editor.cursorUp`, `expandTools` → `app.tools.expand`, `selectConfirm` → `tui.select.confirm`, `interrupt` → `app.interrupt`.
- Non-obvious design decisions: when an old and a new name both exist, the **new namespaced one wins** and the old one is dropped (`keybindings-migration.test.ts:49-70`). And the old names still load **in memory** before the file is rewritten (`keybindings-migration.test.ts:72-87`) — an install that has not been migrated yet still binds the old keys correctly.
- Edge cases: the migration is driven through `process.env[ENV_AGENT_DIR]`, which the test sets and restores around the call.

### packages/coding-agent/test/keybindings.test.ts
- Purpose: pins the platform-dependent keybinding defaults.
- Key abstractions: `useWindowsKeybindings(platform, env)` decides the default set; `KEYBINDINGS` is the id → `{ defaultKeys }` table.
- Data flow: the detected platform family selects between two `defaultKeys` values per binding.
- Non-obvious design decisions: WSL is detected from `WSL_DISTRO_NAME` **or** `WSL_INTEROP`, but *not* from `WT_SESSION` alone (`keybindings.test.ts:14-16`) — a Windows Terminal session on plain Linux is not WSL, and treating it as WSL would bind the wrong keys. The three Windows-family differences that matter are paste-image, alt-screen search, follow-up, model cycling, undo and dequeue.

### packages/coding-agent/test/llama-extension.test.ts
- Purpose: pins the built-in `llama.cpp` extension — a native provider for a local llama server.
- Key abstractions: `createLlamaProvider()` returns a controller whose `provider.getModels()` projects server-side model state into pi models; `normalizeLlamaServerUrl(url)` strips the `/v1` leaf; `LlamaClient.downloadAndWait(model, onProgress)` drives a download; `findHuggingFaceToken` / `HuggingFaceClient` reach the model hub.
- Data flow: the test spins up real `node:http` servers that answer `/v1/props` (chat-template detection) and `/api/models` (model list) and emit progress events.
- Non-obvious design decisions: only **loaded** and **sleeping** models are exposed; `unloaded` and `loading` are not. The projected `contextWindow` and `maxTokens` come from `meta.n_ctx` (65 536), and `input` is derived from `architecture.input_modalities` — i.e. the *server* is the source of truth for the model's capabilities, not a hard-coded table. Chat-template thinking support is discovered from the server's props (regression #9528).
- Edge cases: `normalizeLlamaServerUrl` throws for a non-http scheme ("http or https"), so a `file://` URL cannot become a base URL.

### packages/coding-agent/test/management-http.test.ts
- Purpose: pins `fetchWithRetry`, the HTTP helper used for management/control-plane calls.
- Key abstractions: the options are `{ timeoutMs }` (overall budget) and `{ attemptTimeoutMs }` (per attempt).
- Data flow: `fetchWithRetry(url, init, options)` → `fetch` with an `AbortSignal` → on a transient failure, retry.
- Non-obvious design decisions: the **timeout budget is shared across attempts** — the same `AbortSignal` object is passed to every attempt (`expect(signals[0]).toBe(signals[1])`), so the total wait is bounded by `timeoutMs` rather than `timeoutMs × attempts`. A per-attempt timeout is a separate, shorter signal, and each attempt gets its own `AbortController` so one attempt's expiry does not cancel the others.
- Edge cases: a caller-supplied signal that is already aborted rejects **without** calling `fetch` at all; transient HTTP statuses (503) are retried and the successful response is returned.

### packages/coding-agent/test/max-thinking.test.ts
- Purpose: pins the `max` thinking level and its theme compatibility.
- Key abstractions: `isValidThinkingLevel("max")`; `SettingsManager.setDefaultThinkingLevel("max")`; `loadThemeFromPath(path)` and `theme.getThinkingBorderColor(level)`.
- Data flow: the dark theme JSON is copied, `colors.thinkingMax` is deleted, and the legacy theme is loaded.
- Non-obvious design decisions: a legacy theme without a `thinkingMax` colour falls back to the **`xhigh`** border colour (`max-thinking.test.ts:28-44`), so an old theme renders the new level with a known colour instead of an undefined one.

### packages/coding-agent/test/mcp-command.test.ts
- Purpose: pins the `pi mcp` CLI (`list`, `add`, `remove`, `login`, `logout`).
- Key abstractions: `runMcpCommand(args, { cwd, agentDir, log, error })` returns an exit code; servers live in `mcp.json` as `{ mcpServers: { name: {...} } }`.
- Data flow: the command writes/reads `<agentDir>/mcp.json` and, for `list`, actually **spawns** the configured servers (a fixture stdio server at `../../mcp/test/fixtures/stdio-server.mjs`) to discover their tools.
- Non-obvious design decisions: `list` **exits non-zero if anything at all is wrong** — a server that failed to spawn, or a config entry that is invalid, makes the whole listing fail (`mcp-command.test.ts:39-53`), so a broken MCP config cannot hide behind a successful exit. The per-server line carries the state, the tool count, the exposure (`codemode`) and the scope (`global`); a `disabled` server is listed as `disabled`, not hidden. `--json` prints a machine-readable form for scripts.
- Edge cases: `login` on an unknown server prints the configured names; `logout` on a server that does not use OAuth explains that only HTTP servers without an `Authorization` header use it. `add` passes every option after the command through to the spawned server (`--` separator) and `remove` is scope-aware ("It is defined in <projectConfig>; use --local.").

### packages/coding-agent/test/mcp-extension.test.ts
- Purpose: the big MCP test — config merging, connection lifecycle, retries, OAuth and tool exposure.
- Key abstractions: `loadMcpConfig({ agentDir, cwd, projectTrusted })` returns `{ servers, errors }`; `McpServerConnection` owns the state machine (`connecting`/`connected`/`disconnected`/`failed`) and the tool list; `convertMcpResult` / `createMcpToolName` / `getMcpToolExposure` decide how a server's tools appear to the model.
- Data flow: config → transport (`createDefaultTransport`, stdio or HTTP) → `initialize` → `tools/list` → tool calls; `McpServerLog` collects the server's output.
- Non-obvious design decisions: **disabled servers are kept** in the loaded config so `/mcp` can turn them back on (`mcp-extension.test.ts:73-78`); an untrusted project can neither add nor override servers. The tool name is namespaced (`mcp__<server>__<tool>`). A dropped connection is **not** an error state — the connection goes to `disconnected` with the message "Connection closed" and the *next* call transparently reconnects (`mcp-extension.test.ts:598-612`).
- Edge cases: a transient HTTP 503 during connect is retried, but a **400 fails the connection permanently** (state `failed`, exactly one open attempt) — a shape error will not fix itself (`mcp-extension.test.ts:614-648`). Resource reads are retried after a transient error while **tool calls are not** (a retried tool call could double-apply a side effect). `close()` stops a pending retry loop (#10249) and also closes a connection that is still initialising (#10249). A server without the `tools` capability connects fine and simply lists no tools.
- Surprising: the system-prompt section listing MCP servers is **size-capped** at `MAX_SERVERS_SECTION_CHARS`; when the names alone do not fit, the tail is replaced by `- … N more servers; find their tools with searchTools()` (`mcp-extension.test.ts:852-867`) — the model is told to *search* for the omitted tools rather than being handed an unbounded list.

### packages/coding-agent/test/mcp-manager-view.test.ts
- Purpose: pins the MCP manager's status screen and its cancel affordance.
- Key abstractions: `McpManagerView.status(title, detail, onCancel?)` — the cancel callback is optional.
- Data flow: `view.handleInput(ESCAPE)` triggers the cancel callback if one was supplied.
- Non-obvious design decisions: the "cancel" affordance is only rendered **for operations that can actually be cancelled** (#10565) — the status line does not even contain the word "cancel" when no `onCancel` was given, so the UI never advertises a control that would do nothing.

### packages/coding-agent/test/mcp-oauth-refresh.test.ts
- Purpose: pins MCP OAuth sign-in and, crucially, the **cross-process token refresh**.
- Key abstractions: `startOAuthMcpServer()` is a real local OAuth server that rotates refresh tokens and expires access tokens on demand; `createMcpAuthProvider({ serverUrl, store, settings, onChallenge })`; `signInMcpServer({ serverUrl, store, settings, prompt })`.
- Data flow: three "processes" share one `InMemoryAuthStorageBackend` and one lock directory; each builds its own `McpOAuthCredentialStore` + auth provider.
- Non-obvious design decisions: when several processes discover the same token rejected, only **one** refresh happens (`mcp-oauth-refresh.test.ts:54-75`) — the server rotates refresh tokens, so a second refresh with the old `refresh-1` would fail with `invalid_grant`. The others wait for the running refresh to save the new tokens (`provider.settled()`), and the file lock is released afterwards (the lock directory is empty). This is a textbook "single-flight across processes" implementation.
- Edge cases: sign-in by pasting a redirect URL validates that the redirect matches this sign-in's `redirect_uri`; a server that does not support Client ID Metadata Documents fails the sign-in **without registering anything** (`server.registrations` stays empty).

### packages/coding-agent/test/mcp-oauth-store.test.ts
- Purpose: pins the credential store's keying scheme for MCP servers.
- Key abstractions: `McpOAuthCredentialStore.forServer(name, url)` returns a per-server view; the persisted key is `mcp__<name>|<url>`.
- Data flow: `save`/`load`/`remove` go through the `InMemoryAuthStorageBackend` under a lock.
- Non-obvious design decisions: credentials are keyed by **server name *and* URL**, so two servers that happen to share a `SERVER_URL` keep separate tokens (#10252). Legacy state keyed only by the URL is migrated lazily to the *first* server that loads it — reading the token does **not** take the legacy state over, only a `load()` does (`mcp-oauth-store.test.ts:30-44`) — and server names that differ only in `-`/`_` are the same server. `remove()` also cleans up legacy URL-keyed entries.

### packages/coding-agent/test/mermaid.test.ts
- Purpose: pins the Mermaid → Unicode diagram renderer used in the TUI.
- Key abstractions: `createMermaidMarkdownTransformer({ getMode, theme })` returns a markdown transformer; modes are `off` / `streaming` / `final`.
- Data flow: a ```` ```mermaid ```` block → parsed → a box-drawing diagram → re-inserted into the markdown → themed through the pi theme's semantic spans.
- Non-obvious design decisions: **streaming and settled rendering differ on purpose** — during streaming an incomplete block is rendered as best it can (no warning), and after the stream ends a block that failed to parse falls back to the original code block *plus* a warning (`mcp-conformance` style: "dropped, expected a link: \"invalid\""). Multiple partial-render warnings are **summarised** as `(+1 more)` rather than listed (`mermaid.test.ts:90-98`). A diagram that does not fit the available width is left untouched.

### packages/coding-agent/test/model-catalog-protocol.test.ts
- Purpose: pins the **model catalog negotiation protocol** between pi and pi.dev (regression #9099).
- Key abstractions: `ModelCatalogIndex` (`schemaVersion`, `defaultRevision`, `catalogs[]` each with `minimumPiVersion` + `revision`); `selectModelCatalog(index, piVersion)`; `getModelCatalogProviderKey(revision, provider, representation)` where the representation is `legacy` or `typed`; `parseModelCatalogRequest(url, userAgent)`.
- Data flow: the client requests `/api/models/providers/<provider>?types=chat,image,classifier` → the server picks the newest catalog whose `minimumPiVersion` the client satisfies → the client re-requests with `pi-version=<VERSION>` → the server answers with the shard and the `x-pi-model-catalog-revision` header.
- Non-obvious design decisions: a catalog revision that **predates typed shards** falls back to the chat-only `legacy` shard, and the *wire format of the model changes with the revision* — the test asserts that the final provider URL is `/api/v1/messages` for an `anthropic-messages` model and `/api/v1/chat/completions` for an OpenAI-shaped one (`model-catalog-protocol.test.ts:148-150`). The `last-modified` header is set to a future date so the client always applies the remote overlay.

### packages/coding-agent/test/model-catalog-refresh.test.ts
- Purpose: pins the interactive model-catalog refresh, in particular its **coalescing and abort semantics**.
- Key abstractions: `refreshModelCatalogs(runtime, signal)`; the runtime's own `refresh(options)` accepts a `signal`.
- Data flow: two concurrent callers → one shared `runtime.refresh` promise; when one caller aborts, the shared refresh is *not* aborted while the other caller is still waiting.
- Non-obvious design decisions: the shared refresh has its **own** signal, separate from any caller's; a caller aborting rejects only that caller (`{ name: "AbortError" }`) and leaves `refreshSignal.aborted === false` (`model-catalog-refresh.test.ts:38-58`). A refresh with **no** remaining waiters is aborted and a later refresh is allowed to start (`:60-80`). This is the reference implementation of "one in-flight operation, many callers, per-caller cancellation".

### packages/coding-agent/test/model-registry.test.ts
- Purpose: the largest provider-abstraction test — `models.json` overrides, per-model overrides, `compat` flags and API-key resolution.
- Key abstractions: `ProviderConfigInput` (`baseUrl`, `apiKey`, `api`, `models[]`, `headers`, `compat`, `modelOverrides`); `registry.getAll()`, `registry.find(provider, id)`, `registry.getApiKeyAndHeaders(model)` returning a discriminated `{ ok: true, … } | { ok: false, error }`; `clearApiKeyCache()` in `afterEach`.
- Data flow: a `models.json` file → the registry merges it over the built-in catalog → each model carries the resolved `baseUrl`, `api`, `compat` and `headers` → `getApiKeyAndHeaders` resolves the credential for the wire.
- Non-obvious design decisions: a **baseUrl-only override keeps all the built-in models** while a provider-level `models[]` *replaces* them — the override shape decides the semantics. A `modelOverrides` entry **deep-merges `compat`** rather than replacing it (`model-registry.test.ts:925-945`) and is ignored entirely for a model id that does not exist (no new model is invented, no error is raised). `apiKey` values are resolved through three syntaxes: `!command` (run a command, use its trimmed stdout), `$ENV_VAR` / `${ENV_VAR}`, and a literal; `$$` escapes a literal `$`.
- Edge cases: a failing `!` command, a nonexistent command and empty output all yield `undefined` (no key) rather than an empty-string key (`model-registry.test.ts:1586-1617`). `getApiKeyAndHeaders` returns a typed error string — `No API key found for "custom-provider"` — instead of throwing.

### packages/coding-agent/test/model-resolver.test.ts
- Purpose: pins model selection from a CLI reference, the initial-model heuristic and scoped model lists.
- Key abstractions: `resolveCliModel({ cliProvider, cliModel, modelRuntime, inlineApiKey })` → `{ model?, thinkingLevel?, error? }`; `resolveModelReference`, `resolveModelScope`, `resolveModelScopeWithDiagnostics`, `findInitialModel`, `defaultModelPerProvider`.
- Data flow: a CLI string such as `provider/model`, `model:high` or `anthropic/claude-opus-5.5` → candidate models from the registry → an exact/fuzzy match → a `Model` plus an optional thinking level.
- Non-obvious design decisions: **ambiguity is reported, not resolved by catalog order** — when the same model id exists behind two providers and neither is authenticated, the error names both (`"openrouter/anthropic/claude-opus-5.5, vercel-ai-gateway/anthropic/claude-opus-5.5"`) instead of silently picking the first (`model-resolver.test.ts:542-561`). A stored credential *may* disambiguate (the authenticated gateway wins), but an inline `--api-key` may **not** ("--api-key does not choose a provider."). A `:thinking` suffix is stripped from a custom model id in the fallback path too, and a `provider/` prefix is not double-prefixed.

### packages/coding-agent/test/model-runtime-auth-options.test.ts
- Purpose: pins the auth surface the login selector is built from.
- Key abstractions: `runtime.getProviders()` each exposing `auth.oauth` and/or `auth.apiKey` with a `name` (the method label) and an optional `isSubscription`; `runtime.getAuth(providerId)`; `runtime.getError()`.
- Data flow: a `CredentialStore` → `ModelRuntime` → a flat list of `{ type, provider, method }` options → the OAuth selector.
- Non-obvious design decisions: the auth surface is **provider-owned** — there is no per-provider special-casing in pi, so an extension-registered OAuth provider appears in the same list with its own method name and `isSubscription` flag (`model-runtime-auth-options.test.ts:304-325`). Availability reads are **scoped to the provider asked for** (the test asserts the credential store was read only for `anthropic`), and a read failure is recorded as a runtime error ("Availability refresh: …") rather than thrown into the UI.

### packages/coding-agent/test/model-runtime-classifiers.test.ts
- Purpose: pins the classifier-model path (a model whose output is a structured judgement rather than text).
- Key abstractions: `runtime.getModelOfType("classifier", provider, id)`; `runtime.classify(model, context, { fetch })`; the context carries `state.text` and `questions` with `type: "bool"` and `criteria`.
- Data flow: context + images → a provider request whose body is captured by an injected `fetch` → a typed answer (`{ type: "bool", probability: 0.8 }`).
- Non-obvious design decisions: a classifier is a **separate model kind** — `runtime.getModel("typesafe","jev-latest")` is `undefined` while `getModelOfType("classifier", …)` finds it, so a classifier can never be picked up by a chat-model lookup. The image encoding is a **per-provider compat** decision: OpenRouter keeps its `image_url` form inside `state`, while a TypeSafe proxy is told to use `assets` — and the compat override from `models.json` applies to classifier models exactly as to chat models.

### packages/coding-agent/test/model-runtime-cloudflare-compat.test.ts
- Purpose: pins the Cloudflare AI Gateway "compat" endpoint shape.
- Key abstractions: `resetApiProviders()` resets pi-ai's provider registry; `authStorage.modify(provider, …)` stores an api-key credential with a `env` block.
- Data flow: credential → `modelRuntime.completeSimple(model, …)` with an injected `fetch` → the captured request URL and headers.
- Non-obvious design decisions: the Cloudflare gateway uses a **custom auth header** (`cf-aig-authorization: Bearer …`) and must carry **neither** `Authorization` nor `x-api-key` — the test asserts `headers.has("authorization") === false` (`model-runtime-cloudflare-compat.test.ts:65-89`). The same materialisation must be reached through two paths: `ModelRuntime.completeSimple` and `ModelRegistry.getApiKeyAndHeaders` + `complete`, and both must produce the identical URL.

### packages/coding-agent/test/model-runtime-credential-sync.test.ts
- Purpose: pins the ordering guarantees between the credential store and the in-memory availability snapshot.
- Key abstractions: `runtime.login(provider, type, { prompt, notify })`, `runtime.logout(provider)`, `runtime.hasConfiguredAuth(provider)`, `runtime.getAvailableSnapshot()`, and the `CredentialSynchronizationError` carrying `{ providerId, operation, credential }`.
- Data flow: login → provider's `login()` → credential written to the store → availability snapshot recomputed → optional `refreshModels` hook.
- Non-obvious design decisions: the availability snapshot is published **before** the login/logout promise resolves (`model-runtime-credential-sync.test.ts:63-76`), so the UI never shows a half-applied state. Operations on the same provider are **serialised** through a local lock, so a logout cannot interleave with a login. If the post-login catalog refresh fails, the error is a `CredentialSynchronizationError` but the **credential is still persisted** (`model-runtime-credential-sync.test.ts:353-374`) — the store is not rolled back, because the credential itself succeeded.

### packages/coding-agent/test/model-runtime-images.test.ts
- Purpose: pins the image-generation model kind and its separation from chat models.
- Key abstractions: `ImageModel` (`type: "image"`, `output: ["image"]`); `runtime.getModelsOfType("image", provider)`; `runtime.getAllModels(provider)`.
- Data flow: an extension registers a model list → the runtime partitions it into chat / image / classifier models.
- Non-obvious design decisions: image models are listed **separately** from chat models but are also *the same model id* in both views (`google/gemini-3-pro-image` is a chat model with an OpenAI-shaped api and an image model). An extension's model list **replaces undeclared models of every operation**, so an extension that declares only chat models removes the built-in image models of that provider. A chat-only provider does not acquire image or classification capabilities through a `models.json` header override.

### packages/coding-agent/test/model-runtime-modify-models-compat.test.ts
- Purpose: pins the extension-provider lifecycle: native providers, OAuth providers and credential-dependent model lists.
- Key abstractions: `runtime.registerNativeProvider(provider)` (full pi-ai `Provider`, with its own auth implementation) vs `runtime.registerProvider(id, { baseUrl, api, models, oauth })` (the simplified form); `registry.getRegisteredNativeProvider(id)`, `registry.unregisterProvider(id)`.
- Data flow: register → login → `modifyModels(models, credential)` → the runtime's model list; logout → the credential-dependent models disappear again.
- Non-obvious design decisions: a native provider's `resolve()` may return a **different `baseUrl`** than the registered one, and that resolved URL is what the wire uses. A provider may expose `modifyModels` to extend its model list based on the credential (`model-runtime-modify-models-compat.test.ts:352-375`) — logging out removes exactly the credential-gated models. A native provider with a stored credential is marked configured **at registration time** (#9962), because the initial model selection reads the snapshot before the async refresh finishes.

### packages/coding-agent/test/model-runtime-test-utils.ts
- Purpose: the shared helper that builds a `ModelRegistry` over a `ModelRuntime` for unit tests.
- Key abstractions: a `WeakMap<ModelRegistry, ModelRuntime>` so `getModelRuntime(registry)` can recover the runtime.
- Data flow: `createModelRegistry(credentials, modelsPath?)` → `ModelRuntime.create({ credentials, modelsPath, modelsStore: InMemoryCodingAgentModelsStore, allowModelNetwork: false })`.
- Non-obvious design decisions: the helper deliberately uses an **in-memory models store** so that unit tests never take a file-backed catalog lock ("without introducing file-backed catalog locks into unit tests"), and `allowModelNetwork: false` by default.

### packages/coding-agent/test/model-selector.test.ts
- Purpose: pins the model picker.
- Key abstractions: `ModelSelectorComponent(tui, currentModel, modelRuntime, …, saveDefault)`; the marker glyphs `→` (cursor) and `✓` (current model).
- Data flow: the selector renders rows from the runtime's available models; `handleInput` moves the cursor.
- Non-obvious design decisions: the **current model stays marked** while the user browses — the `✓` moves to the cursor and the arrow moves with it, so "where am I" and "what is selected" are two different marks (`model-selector.test.ts:29-57`). The "set as default" hint uses the *configured* keybinding, and the hint text is rendered from it. A failed catalog refresh is surfaced as "Could not refresh 2 model catalogs (openai, anthropic); showing cached models." rather than an empty list.

### packages/coding-agent/test/models-store.test.ts
- Purpose: pins the file-backed model catalog store, including its locking.
- Key abstractions: `FileModelsStore(path)` with `read(providerId, { signal })`, `write(providerId, entry, { signal })`, `delete(providerId)`; `proper-lockfile` is the lock mechanism.
- Data flow: several `FileModelsStore` instances over one path → a coalesced reload → the parsed per-provider entries.
- Non-obvious design decisions: concurrent reads across **different store instances** on the same file take the lock **once** and share the reload (`models-store.test.ts:67-103`), and a reader that aborts while waiting does **not** cancel the shared reload for the other reader (`:105-128`) — the lock is held and released exactly once. A write cancelled while waiting for the lock must **not** write afterwards (`:130-146`). The file's mode is preserved on rewrite (`0o660` on POSIX).

### packages/coding-agent/test/nested-tool-calls.test.ts
- Purpose: pins the nested-tool-call runner — a tool that itself calls tools.
- Key abstractions: `NestedToolCallRunner(host)` with `execute(parentId, name, args, { onUpdate })`; `NestedCallRecorder` with `start/finish/snapshot`; `NESTED_CALL_LIMITS` (`maxCalls`, `maxErrorChars`, and an argument-size budget).
- Data flow: a model-issued call → the runner assigns a child id (`call/1`) → `host.runToolCall` runs it → events `tool_execution_start` / `_update` / `_end` are emitted **with the parent id** → the record is attached to the parent call.
- Non-obvious design decisions: the child ids are **hierarchical strings** (`call/1`, `call/2`) rather than new UUIDs, so the parent-child relation is readable in a log. The recorder's budget is explicit: at most `maxCalls` calls, each error text truncated to `maxErrorChars`, and a total argument budget of 32 KiB — after which later calls keep their status but **lose their arguments** (`models-store` style: `snapshot.calls.filter(c => c.arguments !== undefined)` has length 4 out of 6). Calls that never finished are marked `status: "unfinished"` and the snapshot is `complete: false`.

### packages/coding-agent/test/oauth-selector.test.ts
- Purpose: pins the login picker (the "provider options" dialog).
- Key abstractions: `OAuthSelectorComponent(mode, options, onSelect, onCancel)`; an option is `{ id, name, authType, status }` where `status` describes the *source* of the credential.
- Data flow: `getLoginProviderOptions(authType?)` projects the runtime's providers into flat options → the selector renders each with its configured/not-configured marker.
- Non-obvious design decisions: the provider's own auth methods decide the labels ("Anthropic (Claude Pro/Max)", "Google Cloud credentials") — pi filters by `authType` but never by provider name. The credential *source* is shown verbatim: `✓ env: OPENAI_API_KEY`, `✓ key in models.json`, `✓ command in models.json`, `subscription configured`. An option whose status has not been compiled yet renders as "not configured" rather than as a blank.

### packages/coding-agent/test/output-pad.test.ts
- Purpose: pins the "output pad" — the one-space left margin some components render with.
- Key abstractions: `setOutputPad(n)` is implemented by `BashExecutionComponent`, `ToolExecutionComponent` (with and without a tool definition) and `CompactionSummaryMessageComponent`.
- Data flow: each component is rendered at `outputPad` 0 and 1 and the rendered lines are compared.
- Non-obvious design decisions: the pad must apply to **every** component that renders a tool's output — the test drives five shapes including a self-rendered edit result — so a padded transcript cannot end up with one un-padded sibling. The comparison strips ANSI and trailing fill, and skips blank lines and full-width borders.

### packages/coding-agent/test/package-command-paths.test.ts
- Purpose: pins the `pi install/update/config` command surface, including the managed-install layout.
- Key abstractions: `handlePackageCommand(args)`; `DefaultPackageManager.resolve()` → `ResolvedPaths { global, project }`; `ConfigSelectorComponent` with a `scope` of `global` or `project`; the managed-install layout `install/releases/<version>/…` with `active.txt`, `current-version` and `managed-install.json` (`kind: "pi-managed-install"`, `schemaVersion: 1`, `layout: "releases-v1"`).
- Data flow: the command resolves the settings, asks the package manager for the resolved paths, renders the config selector, and writes the toggled settings back.
- Non-obvious design decisions: the package-override cycle is a **three-state** toggle — the resource is enabled, disabled (`-` prefix) or inherited (absent) — and the third press removes the entry entirely rather than writing an "unset" value (`package-command-paths.test.ts:498-527`). Built-in extensions are toggled the same way with the `builtin:` prefix (`+builtin:llama.cpp` / `-builtin:llama.cpp`). A user-facing error names the fix: "Did you mean npm:pi-formatter?".

### packages/coding-agent/test/package-distribution.test.ts
- Purpose: pins the npm package's entry points.
- Key abstractions: `bin.pi` → `dist/bundle/cli.js`; `main` and `exports["."].import` → `./dist/index.js`; `exports["./rpc-entry"].import` → `./dist/bundle/rpc-entry.js`.
- Non-obvious design decisions: executables get the **bundle** and libraries get **modular output** — the test exists so a build change cannot silently make the published CLI a different artefact from the imported library.

### packages/coding-agent/test/package-manager-ssh.test.ts
- Purpose: pins how the package manager parses git sources and derives a package identity.
- Key abstractions: `parseSource(source)` → `{ type: "npm" | "git" | "local", … }`; `getPackageIdentity(source)`.
- Data flow: a source string → a typed source → an install path under `agentDir/git/<host>/<path>`.
- Non-obvious design decisions: `getPackageIdentity` **normalises** the three spellings (`git:git@github.com:user/repo`, `https://github.com/user/repo`, `ssh://git@github.com/user/repo`) to the same identity `git:github.com/user/repo` — otherwise the same package would be installed twice under two keys. Without the `git:` prefix, `git@host:path` and `host/path` are classified as **local**.

### packages/coding-agent/test/package-manager.test.ts
- Purpose: the largest file in the shard (2 862 lines) — the whole package installation/update surface.
- Key abstractions: `DefaultPackageManager` with `install`, `update`, `resolve`, `resolveExtensionSources`, `checkForAvailableUpdates`, `getInstalledPath`; the private surface (`parseSource`, `getNpmInstallPath`, `getGitInstallPath`, `runCommand`, `runCommandCapture`, `spawnCaptureCommand`, `getLocalGitUpdateTarget`) is reached through a `PackageManagerInternals` type; `ResolvedResource` = `{ path, enabled, metadata }`.
- Data flow: a source spec → a typed source → an install path (`agentDir/npm/...` for user scope, `<cwd>/.pi/npm/...` for project scope, `agentDir/git/<host>/<path>` for git) → `npm install` / `git clone` → the package's resources are discovered by scanning `extensions/`, `skills/`, `prompts/` and `themes/`.
- Non-obvious design decisions: a git checkout is **reconciled, not re-cloned**: an existing checkout is fetched, `reset --hard FETCH_HEAD^{commit}` and `clean -fdx` (so a pinned ref is authoritative and the working tree is clean) and only a failed clone or a failed dependency install removes the directory it just created (`package-manager.test.ts:818-882`). A package's extension discovery respects `package.json`'s `pi.extensions` manifest, including in subdirectories, and a subdirectory without an `index.ts` or a manifest is skipped (`package-manager.test.ts:2336-2406`) — helper modules are never loaded as extensions. Updates are **batched per scope** and npm updates run in parallel while git updates run in parallel, with pinned packages and already-current packages skipped (`package-manager.test.ts:2513-2632`).
- Edge cases: `PI_OFFLINE=1` skips installing missing package sources, skips refreshing temporary git sources and skips update checks entirely. An installed version *newer* than the registry's is not "updated" down. A legacy global npm install is **migrated into the managed npm root** on update. A `runCommandCapture` resolves only after the child's `close`, not on `exit` (`package-manager.test.ts:2829-2860`).

### packages/coding-agent/test/path-utils.test.ts
- Purpose: pins the tool-facing path helpers, especially the macOS filename quirks.
- Key abstractions: `expandPath(p)`, `resolveToCwd(p, cwd)`, `resolveReadPath(name, cwd)`.
- Data flow: a user-typed path → normalisation → a resolved absolute path.
- Non-obvious design decisions: `~` expands **only** as the home directory or `~/…`; a filename that merely starts with a tilde (`~draft.md`) stays literal, and a leading `@` is stripped so `@~draft.md` also stays a literal name (`path-utils.test.ts:19-22`). Unicode NBSP is normalised to a plain space. `resolveReadPath` recovers from the filename mismatches macOS produces: NFC vs NFD normalisation, curly vs straight apostrophes, the narrow no-break space (U+202F) before AM/PM in screenshot names, and the lowercase `am`/`pm` variant.
- Edge cases: the macOS-specific recoveries are asserted one by one because they are all real user-typed-path failures.

### packages/coding-agent/test/paths.test.ts
- Purpose: pins the general path utilities, including Windows shell-path translation and symlink canonicalisation.
- Key abstractions: `canonicalizePath`, `getCwdRelativePath`, `normalizePath`, `normalizeWindowsShellPath`, `resolvePath`, `isLocalPath`.
- Data flow: a path in any of the shapes a model or a user might produce → a normalised absolute path.
- Non-obvious design decisions: `canonicalizePath` resolves symlinks (files and directories) but **falls back to the raw path** for a nonexistent target or a dangling symlink instead of throwing. `getCwdRelativePath` rejects parent-directory traversals but keeps names that merely *start* with dots (`..config/AGENTS.md` is fine, `../AGENTS.md` is not). `normalizeWindowsShellPath` translates `/c/Users/x`, `/cygdrive/d/x` and `/mnt/e/x` into drive paths and leaves everything else alone. `resolvePath` accepts a `file://` URL but refuses a Windows file-URL *pathname* string (which starts `/C:`) on Windows.

### packages/coding-agent/test/pi-user-agent.test.ts
- Purpose: pins the User-Agent pi sends.
- Key abstractions: `getPiUserAgent(version)` → `pi/<version> (<platform>; <runtime>; <arch>)`.
- Data flow: the pi version plus `process.platform` / `process.versions` / `process.arch` → the header value.
- Non-obvious design decisions: the runtime segment is `bun/<version>` when running under Bun and `node/<version>` otherwise — pi ships as both, and the header must say which.

### packages/coding-agent/test/plan-mode-extension.test.ts
- Purpose: pins the `plan-mode` example extension (read-only planning, then execution).
- Key abstractions: `pi.registerCommand("plan", …)`, `pi.on("agent_end", …)`, `pi.getActiveTools()` / `pi.setActiveTools(names)`, `pi.sendMessage(msg, { triggerTurn, deliverAs })`, `pi.sendUserMessage(text, { deliverAs })`.
- Data flow: `/plan` → the tool set is swapped to the read-only set → the agent ends → the assistant's text is scanned for a plan → the user is offered "Refine the plan" / "Execute the plan (track progress)".
- Non-obvious design decisions: toggling plan mode **preserves the user's custom tools** — the new list is the read-only set *plus* whatever was already active (`plan-mode-extension.test.ts:106-128`), so a custom tool is not silently dropped. Plan refinement is queued as a **follow-up user message** (`{ deliverAs: "followUp" }`), and plan execution as a **follow-up custom message** (`{ customType: "plan-mode-execute" }` with `triggerTurn: true`) so the execution is a distinct, inspectable entry rather than plain prose.

### packages/coding-agent/test/plan-mode-utils.test.ts
- Purpose: pins the plan-mode helper functions.
- Key abstractions: `isSafeCommand(cmd)`, `extractTodoItems`, `extractDoneSteps`, `markCompletedSteps`, `cleanStepText`.
- Data flow: assistant text → todo items with step numbers and completion state.
- Non-obvious design decisions: `isSafeCommand` is an **allow-list** of read-only commands (`ls`, `cat`, `head`, `tail`, `grep`, `find`, `git status/log/diff/branch`, `npm list/outdated`, `pwd`, `echo`, `wc`, `du`, `df`), not a denylist of destructive ones — an unknown command is refused (`plan-mode-utils.test.ts:89-92`). Anything with a redirect, a pipe-to-write, `sudo`, an editor or an install is refused.

### packages/coding-agent/test/powershell-config.test.ts
- Purpose: pins the PowerShell discovery order on Windows.
- Key abstractions: `getPowerShellConfig()` → `{ shell, args }`; `POWERSHELL_ARGS` is `["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command"]`.
- Data flow: `process.platform` and `process.env` are stubbed; `spawnSync` (a `where`-style PATH lookup) and `accessSync` (an existence check) are mocked.
- Non-obvious design decisions: the discovery order is **PowerShell 7 on PATH → PowerShell 7 under `%ProgramFiles%` → Windows PowerShell on PATH → Windows PowerShell under `%SystemRoot%`**, and it deliberately does **not** assume a drive letter or a Windows directory name (#9490) — the test uses `D:\Applications` and `E:\WinNT` to prove it.
- Edge cases: when nothing is found the call throws "No PowerShell executable found" rather than falling back to `cmd.exe`.

### packages/coding-agent/test/powershell-tool.test.ts
- Purpose: pins the PowerShell *tool* (as opposed to the shell config).
- Key abstractions: `createPowerShellTool(cwd)`; the tool's result is a list of content blocks.
- Data flow: a command → `pwsh` with `POWERSHELL_ARGS` → text output.
- Non-obvious design decisions: the execution policy bypass is **process-local** (`-ExecutionPolicy Bypass`), so nothing outside the spawned process is changed — and the test asserts `Get-ExecutionPolicy -Scope Process` reports `Bypass`, proving the scope. The Windows-only test also proves UTF-8 output survives (`héllo €`).

### packages/coding-agent/test/print-mode.test.ts
- Purpose: pins the headless one-shot mode (`pi -p "…"` / `--mode json`).
- Key abstractions: `runPrintMode(runtimeHost, { mode: "text" | "json", initialMessage, messages, initialImages })` → an exit code; the session's `extensionRunner.emit({ type: "session_shutdown", reason: "quit" })`.
- Data flow: the options → `session.prompt(text, { images })` → the assistant message → stdout (text or JSON) → the exit code.
- Non-obvious design decisions: `session_shutdown` is emitted on **every** path — success, assistant error and truncated response — so extensions get a clean teardown regardless of how the run ended (`print-mode.test.ts:94-141`). A response whose `stopReason` is `"length"` warns on stderr and exits **non-zero** (#10799), because a truncated answer is not a successful answer.

### packages/coding-agent/test/program-status-reporter.test.ts
- Purpose: pins the terminal/OS "program status" — the state shown outside the TUI (title, spinner, message).
- Key abstractions: `ProgramStatusReporter(getTerminal, getSessionName)` with `handleEvent(event)` and `setBlocked(source, { kind, message } | undefined)`; the reported status is `{ state, message?, kind?, app }` with `state` ∈ `idle | working | done | error | blocked`.
- Data flow: `AgentSessionEvent`s (`agent_start`, `message_end`, `compaction_start`, `compaction_end`, `agent_settled`, `session_info_changed`) → a `ProgramStatus` pushed to the terminal.
- Non-obvious design decisions: **only the outcome of the run is reported** (`program-status-reporter.test.ts:67-81`): a retried error followed by a success reports `done`, the final error reports `error` with only the first line of the message ("Invalid API key", with `{details}` stripped), and an abort reports `idle`. The status never carries model output (`expect(JSON.stringify(reports)).not.toContain("secret assistant output")`). A failed recovery compaction is reported as the run's error, unless a later response succeeds. Blocked dialogs are tracked by **source**, so reopening the same source replaces its dialog instead of stacking, and the most recent one is what the status shows.

### packages/coding-agent/test/prompt-templates.test.ts
- Purpose: pins prompt-template argument parsing and placeholder substitution.
- Key abstractions: `parseCommandArgs(text)` → a token list; `substituteArgs(template, args)` → the expanded string; `expandPromptTemplate`; `loadPromptTemplates({ cwd, agentDir, promptPaths, includeDefaults })` → `{ templates, diagnostics }`.
- Data flow: a prompt file with YAML frontmatter → a named template → an invocation with arguments → a substituted prompt.
- Non-obvious design decisions: substitution is **not recursive** — an argument whose own value is `$1` or `$ARGUMENTS` stays literal (`prompt-templates.test.ts:41-46`), which is the classic injection guard on template expansion. `$@` and `$ARGUMENTS` are exact synonyms, an out-of-range `$N` becomes an empty string (the surrounding spaces survive), and `$100` is never partially matched as `$1` followed by `00`.
- Edge cases: empty argument lists still expand the placeholder to an empty string; unicode and newlines in arguments survive intact; a template file whose frontmatter is invalid YAML becomes a **warning diagnostic naming the file and the YAML position**, and the valid templates beside it still load.

### packages/coding-agent/test/radius.test.ts
- Purpose: pins the Radius provider (pi's hosted gateway).
- Key abstractions: `RADIUS_PROVIDER_ID`; the credential is an OAuth credential that may carry a `gatewayConfig` with its own `baseUrl` and model list.
- Data flow: the stored credential → the model's `api: "pi-messages"` and `baseUrl`; a catalog fetch to `https://radius.pi.dev/v1/config` for the model list.
- Non-obvious design decisions: a **legacy credential** (one carrying its own `gatewayConfig`) restores its model catalog **with no network access at all** (`radius.test.ts:52-66`) — an offline install keeps working. Catalog refreshes are opt-in: without `allowModelNetwork` nothing is fetched. Without configured auth no Radius model is offered and no fetch is made. A custom gateway in `models.json` requires a `baseUrl` ("\"baseUrl\" is required when \"oauth\" is set").

### packages/coding-agent/test/read-line-range-display.test.ts
- Purpose: pins how a `read` call's line range is displayed in **three** surfaces (the TUI, the session tree and the HTML export).
- Key abstractions: `formatReadLineRange(offset, limit)`; the exported HTML viewer is loaded by extracting its inline `<script>` and running it in `node:vm` with a stubbed `document`, so the *real* viewer code is exercised.
- Data flow: the raw tool arguments (`{ path, offset: "25", limit: "13" }`, both as **strings**) → `formatReadLineRange` → the TUI label, the tree node text and the exported HTML.
- Non-obvious design decisions: the range is formatted from the **raw arguments** so the display matches what the model asked for, even when the arguments arrived as strings. The normalisation rules are pinned by a table (`read-line-range-display.test.ts:50-59`): `null` offset means "from line 1"; an empty limit, a non-numeric limit and `"Infinity"` all render as no range at all.

### packages/coding-agent/test/references.test.ts
- Purpose: keeps the generated reference documentation in sync with the code.
- Key abstractions: `renderReferences()` from `scripts/generate-references.ts` returns a map of relative path → expected content.
- Data flow: the generator runs → the result is compared with the committed file on disk.
- Non-obvious design decisions: the comparison is against the **committed** page, so a stale doc fails the test with a message naming the fix ("`docs/models-configuration.md` is stale; run npm run generate:references`"). The regression it guards (#10790) is that `models.json` fields silently lost their reference documentation — so the *set* of generated pages is asserted too, not just their content.

### packages/coding-agent/test/remote-catalog-provider.test.ts
- Purpose: pins the remote model catalogue overlay.
- Key abstractions: `withRemoteCatalog(provider, baseUrl, localGeneratedAt?)`; `withPersonalizedCatalog(provider, personalize)`; `REMOTE_CATALOG_MODEL_TYPES`.
- Data flow: the provider's `refreshModels({ credential, stored, publish, allowNetwork, force, signal })` → a fetch of `/api/models/providers/<provider>?types=…` with a `User-Agent` carrying the pi version → the fetched models are merged over the static ones and published to the models store.
- Non-obvious design decisions: the refresh respects a **TTL** — three refresh calls produce only two fetches (`remote-catalog-provider.test.ts:81-104`) — and `force: true` bypasses it. The fetched catalogue may contain image and classifier models, and model types pi does not know are **dropped** rather than surfaced. A personalised catalogue may legitimately produce an empty chat list, but only if the *stored* list was already empty — a stored non-empty list that resolves to nothing is treated as "the key may use no chat models", and the image models are kept (`remote-catalog-provider.test.ts:335-346`).

### packages/coding-agent/test/resolve-config-value.test.ts
- Purpose: pins the config-value interpolation used for API keys and other settings.
- Key abstractions: `resolveConfigValue(value, scopedEnv?)` and `resolveConfigValueUncached(value)`; `clearConfigValueCache()`.
- Data flow: a config string → a literal, an environment lookup, or a shell command whose stdout is the value.
- Non-obvious design decisions: four syntaxes coexist — a literal, `$VAR` / `${VAR}`, `$$VAR` (escape to a literal `$VAR`), `$!literal` (a literal starting with `!`), and `!command` (run it). A **credential-scoped environment takes precedence over `process.env`** (`resolve-config-value.test.ts:42-49`), so a per-provider environment can override a global one. Command results are **cached, including failures**, and only `clearConfigValueCache()` invalidates them — but **environment values are never cached** (`:84-93`), so a rotating env var is re-read every time.
- Edge cases: a command that exits non-zero, a command that does not exist and a command that prints nothing all resolve to `undefined` (no value), not to an empty string.

### packages/coding-agent/test/resource-loader-theme.test.ts
- Purpose: pins the theme loading path and the true-colour decision.
- Key abstractions: `DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalThemePaths, noExtensions, noSkills, noPromptTemplates, noContextFiles })`; `loader.getThemes()` → `{ themes, diagnostics }`; `setCapabilityOverrides` / `resetCapabilitiesCache` from `pi-tui`.
- Data flow: a theme JSON on disk → schema validation → a `Theme` object whose colours are rendered through the terminal's colour capability.
- Non-obvious design decisions: the **settings win over the environment**: `terminal.trueColor: true` with `PI_TRUE_COLOR=0` renders a 256-colour background, and `trueColor: false` with `PI_TRUE_COLOR=1` renders truecolour — the setting is authoritative both ways (`resource-loader-theme.test.ts:50-85`). Removing the setting returns the loader to automatic detection. A theme with an unsupported key is rejected with a diagnostic that names the offending path, and the diagnostics are **cleared** when the theme is fixed — a stale warning is not left behind.

### packages/coding-agent/test/resource-loader.test.ts
- Purpose: the largest resource test — extensions, skills, prompts, themes, context files and the append-system-prompt surfaces.
- Key abstractions: `DefaultResourceLoader` with `getExtensions()`, `getSkills()`, `getPrompts()`, `getThemes()`, `getAgentsFiles()`, `getSystemPrompt()`, `getAppendSystemPrompt()`, `getAppendSystemPromptSources()`, `extendResources({ skillPaths, promptPaths })`, `reload()`; `loadProjectContextFiles({ cwd, agentDir })`.
- Data flow: the agent dir, the project's `.pi/` directory, the configured package paths and the extension-supplied paths → the loader's four resource lists plus a diagnostics list.
- Non-obvious design decisions: an extension package that declares the host in `dependencies` (rather than `peerDependencies` with a `*` range) produces a warning that explains the hazard in full: "Installed copies can bypass the extension loader and create duplicate runtime modules." (#9863, `resource-loader.test.ts:59-85`). A *project's* `package.json` listing pi is **not** treated as owning a project extension — only a real extension package's manifest is. The append-system-prompt surface distinguishes **file-backed** sources from literal strings: `getAppendSystemPromptSources()` lists only the files, while `getAppendSystemPrompt()` returns both (`resource-loader.test.ts:615-636`), so a literal can never be mistaken for a file the user can edit.
- Edge cases: `loadProjectContextFiles` climbs from the cwd to the repository root collecting `AGENTS.md` files, and it handles a `.git` **file** (a worktree's `gitdir:` pointer) — including a *corrupt* one, where the climb simply stops at the directory containing it.

### packages/coding-agent/test/restore-sandbox-env.test.ts
- Purpose: pins a Bun-specific environment restoration.
- Key abstractions: `restoreSandboxEnv()` from `src/bun/restore-sandbox-env.ts`.
- Data flow: under Bun, if `process.env` is empty, the environment is re-read from `/proc/self/environ` (NUL-separated) and copied back.
- Non-obvious design decisions: the function does nothing when not running under Bun, and does nothing when `process.env` already has entries — the restore is a **repair for an empty environment**, not an overlay (`:28-44`). The file read is mocked, so the test asserts the exact path `/proc/self/environ`.

### packages/coding-agent/test/rpc-client-clear-queue.test.ts
- Purpose: pins the RPC `clear_queue` command.
- Key abstractions: `RpcClient.clearQueue()` → `{ steering: string[], followUp: string[] }`; the wire command is `{ type: "clear_queue" }`.
- Data flow: the client → `send({ type: "clear_queue" })` → the response's `data` → the caller.
- Non-obvious design decisions: clearing the queue returns **both** queues' contents so the caller can tell the user what was dropped; the client's `send` and `getData` are replaced in the test, which is the shard's standard way of exercising a client method without a child process.

### packages/coding-agent/test/rpc-client-clone.test.ts
- Purpose: pins the RPC `clone` command.
- Key abstractions: `RpcClient.clone()` → `{ cancelled: boolean }`; the wire command is `{ type: "clone" }`.
- Data flow: the client → `send({ type: "clone" })` → the response data.
- Non-obvious design decisions: the response carries a `cancelled` flag, so a client can tell "the user declined" from "the clone happened" without parsing a message.

### packages/coding-agent/test/rpc-client-process-exit.test.ts
- Purpose: pins what a client sees when the agent process dies under it.
- Key abstractions: `RpcClient({ cliPath })`; a child script is written to a temp dir and spawned as the "agent".
- Data flow: the client starts the child → sends `get_commands` → the child exits with code 43 → the in-flight request rejects.
- Non-obvious design decisions: the rejection message is `Agent process exited (code=43 signal=null)` — the **exit code and signal are both included**, so a caller can distinguish a clean exit from a crash (`rpc-client-process-exit.test.ts:24-37`). An in-flight request is rejected rather than hanging.

### packages/coding-agent/test/rpc-example.ts
- Purpose: an **interactive example** of driving pi through the RPC client (not a test).
- Key abstractions: `RpcClient({ cliPath, provider, model, args })`; `client.onEvent(...)`, `client.promptAndWait(line)`, `client.abort()`, `client.stop()`.
- Data flow: readline → a prompt → streamed `message_update` events printed as deltas → tool start/end printed as one-line summaries.
- Non-obvious design decisions: the example uses `dist/cli.js` (the built bundle), not the TypeScript source, so it doubles as a smoke test of the published artefact. `SIGINT` aborts the current turn when one is running and exits otherwise — the two cases are distinguished by a local `isWaiting` flag.

### packages/coding-agent/test/rpc-jsonl.test.ts
- Purpose: pins the JSONL framing of the RPC transport.
- Key abstractions: `serializeJsonLine(value)`; `attachJsonlLineReader(stream, onLine)`.
- Data flow: a value → one JSON line → a stream of lines.
- Non-obvious design decisions: the framing splits on **LF only** — not on U+2028/U+2029 — and those separators are left intact inside the payload (`rpc-jsonl.test.ts:14-30`); a CRLF stream is handled by stripping the `\r`. The serialiser does not escape the Unicode separators, so `JSON.parse` round-trips them exactly.

### packages/coding-agent/test/rpc-prompt-response-semantics.test.ts
- Purpose: pins the **semantics** of an RPC prompt: one response per command id, and what `clear_queue` does.
- Key abstractions: `runRpcMode(runtimeHost, …)`; the mocked `output-guard` module captures every line written; the mocked `jsonl.js` hands the test a `lineHandler` it can call directly.
- Data flow: a JSONL command line → the RPC mode → response lines on stdout → parsed by the test.
- Non-obvious design decisions: a prompt command produces **exactly one** `response` line for its id, and a `clear_queue` command returns both the steering and follow-up queues it dropped (`rpc-prompt-response-semantics.test.ts:422-447`). After a `clear_queue`, the test asserts there is still exactly **one** `agent_start` — clearing the queue must not start an extra turn.

### packages/coding-agent/test/rpc.test.ts
- Purpose: the end-to-end RPC test against a **real** agent process (requires a real Anthropic credential).
- Key abstractions: `RpcClient` with `getState`, `promptAndWait`, `compact`, `bash`, `setThinkingLevel`, `cycleThinkingLevel`, `getAvailableModels`, `getSessionStats`, `newSession`, `exportHtml`, `getLastAssistantText`, `getEntries(since?)`, `getTree`.
- Data flow: a prompt → the agent process → the session JSONL on disk → the assertions read the file back.
- Non-obvious design decisions: the whole suite is `describe.skipIf(!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_OAUTH_TOKEN)` — it is skipped unless a real credential is present. `getEntries(since)` is **append-only**: the entries before the cursor are still returned unchanged after a compaction (`rpc.test.ts:350-362`), and an unknown cursor is an error response ("Entry not found").
- Edge cases: the timeouts are generous (30 s–120 s) because a real model round trip is involved.

### packages/coding-agent/test/runtime-credentials.test.ts
- Purpose: pins the runtime credential override layer.
- Key abstractions: `RuntimeCredentials(store)` implementing the `CredentialStore` interface; `setRuntimeApiKey(providerId, key)` / `removeRuntimeApiKey(providerId)`.
- Data flow: a runtime override → `read`/`list`/`modify`/`delete` → the persistent store beneath.
- Non-obvious design decisions: a runtime override **masks** the stored credential without persisting anything (`runtime-credentials.test.ts:7-17`) — the stored key is untouched and reappears when the override is removed. `list()` merges the overrides but exposes only `{ providerId, type }` — never the key. A `delete` that is cancelled leaves the **runtime override in place** (`:63-74`), so a cancelled destructive action cannot silently drop an in-memory credential.

### packages/coding-agent/test/scoped-models-selector.test.ts
- Purpose: pins the "scoped models" picker, which decides which models a session may use.
- Key abstractions: `ScopedModelsSelectorComponent({ allModels, enabledModelIds }, { onChange, onPersist, onCancel })`; the enabled set is expressed as `provider/modelId` strings, and `null` means "all".
- Data flow: the picker → `onChange(enabledModelIds)` → the caller writes the scope.
- Non-obvious design decisions: "enable all" is represented as `null`, **not** as the full list — so a model added later is automatically included, and the UI can distinguish "all" from "these three" (`scoped-models-selector.test.ts:61-74`). Toggling one model off after "all" materialises the explicit list, and re-enabling the last disabled model **restores the `null` (all) state** rather than an explicit list (`:108-125`). Enabled models re-sort first in the list.

### packages/coding-agent/test/scrollbar-theme.test.ts
- Purpose: pins the fullscreen theme's scrollbar and search-highlight colours.
- Key abstractions: `loadThemeFromPath(path, colorMode)`; `theme.getFgAnsi(token)` / `getBgAnsi(token)`.
- Data flow: a theme JSON (derived from the shipped `dark.json`) → the theme object → exact ANSI sequences.
- Non-obvious design decisions: a theme that omits `scrollbarTrack`/`scrollbarThumb` falls back to `muted`/`text`, and a theme that omits `searchMatchBg`/`searchMatchText` falls back to `selectedBg`/`text` — so an old theme renders a readable scrollbar instead of an invisible one (`scrollbar-theme.test.ts:34-66`).

### packages/coding-agent/test/sdk-client-identity.test.ts
- Purpose: pins the identity and attribution pi presents to providers.
- Key abstractions: `createAgentSession({ cwd, agentDir, model, modelRuntime, settingsManager, sessionManager })`; `SimpleStreamOptions.identity` = `{ userAgent: "detailed", version, attribution }`; `getAttributionHeaders(model, identity)`.
- Data flow: settings/env → the stream options → the provider's headers.
- Non-obvious design decisions: attribution is a **telemetry switch** — `settingsManager.setEnableInstallTelemetry(false)` or `PI_TELEMETRY=0` sets `attribution: null` and produces **no** attribution headers (`sdk-client-identity.test.ts:158-171`). The attribution headers themselves are provider-specific (`HTTP-Referer`, `X-OpenRouter-Title`, `X-OpenRouter-Categories: cli-agent`). A provider's own headers override pi's — a configured `x-opencode-session` wins over the session id pi would inject (`:181-190`).

### packages/coding-agent/test/sdk-codex-cache-probe-tool-loop.ts
- Purpose: a **manual probe script** (not a test) that measures OpenAI Codex prompt-cache behaviour through a tool loop.
- Key abstractions: `--turns` (20–50), `--transport sse|websocket|websocket-cached|auto`, `--max-tokens`, `--session`; `getOpenAICodexWebSocketDebugStats()`.
- Data flow: `createAgentSession` → an append-only multi-turn prompt, forcing one deterministic custom tool call per top-level user turn → per-subrequest usage is logged → the script asserts that cache-read tokens are **monotonic** and prints the violations.
- Non-obvious design decisions: the script measures cache reads **inside a tool loop** (not on a straight chat), because that is where prefix caching actually breaks. The transport is switchable so the SSE and WebSocket code paths can be compared, and the WebSocket stats distinguish `cachedContextRequests` / `storeTrueRequests` / `fullContextRequests` / `deltaRequests`.
- Read status: read in full (505 lines) but **not executed** — it is a manual probe requiring a live Codex credential.

### packages/coding-agent/test/sdk-session-manager.test.ts
- Purpose: pins `createAgentSession`'s session-manager defaults and the environment it exposes to tools.
- Key abstractions: `createAgentSession({ cwd, agentDir, model, thinkingLevel, sessionManager? })`; the built-in `bash` tool; the `PI_*` environment variables.
- Data flow: the options → a `SessionManager` and a system prompt → the bash tool's environment.
- Non-obvious design decisions: the default persisted session path lives under the **agent dir**, not the project: `<agentDir>/sessions/--<cwd-with-separators-replaced>--/` (`sdk-session-manager.test.ts:28-47`). When an explicit `sessionManager` is given, the **cwd is derived from it** — the session's working directory is the manager's, and the system prompt's `<cwd>` block follows (`:67-94`). The bash tool is told about `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL` (`:96-130`), which is how a shell command can find out what the agent is currently doing.

### packages/coding-agent/test/sdk-skills.test.ts
- Purpose: pins the SDK's skills option and the `ResourceLoader` interface an embedder can implement.
- Key abstractions: `createAgentSession({ cwd, agentDir, sessionManager, resourceLoader })`; the `ResourceLoader` interface with `getSkills()`, `getPrompts()`, `getThemes()`, `getExtensions()`, `getSystemPrompt()`, `getAppendSystemPrompt()`, `extendResources()`, `reload()`.
- Data flow: a `ResourceLoader` → `session.resourceLoader.getSkills()` → the session's skill list.
- Non-obvious design decisions: the whole `ResourceLoader` surface is a **structural interface**, so an embedder can supply skills without touching the filesystem — the test hand-writes a loader returning one synthetic skill with `createSyntheticSourceInfo(path, { source: "sdk" })`. Skills are discovered by default and can be suppressed entirely.

### packages/coding-agent/test/sdk-stream-options.test.ts
- Purpose: pins the stream options pi hands a provider, including the extension header hook.
- Key abstractions: `SimpleStreamOptions` (`headers`, `identity`, `apiKey`); the `before_provider_headers` extension event.
- Data flow: model + settings + extension → the assembled headers → the provider's `streamSimple` call.
- Non-obvious design decisions: the extension hook sees the **assembled** header set (provider headers + model headers + explicit request headers) and may add its own (`sdk-stream-options.test.ts:300-323`), and the hook is **not** forwarded to the provider as a `transformHeaders` callback — the transformation has already happened, so the provider never sees the extension's mechanism.

### packages/coding-agent/test/session-context-edit.test.ts
- Purpose: pins **context edits** — removing or rewriting a message in the model's view without touching the transcript.
- Key abstractions: `session.appendContextEdit(targetId, replacement | null)`; `session.buildSessionProjection()` (what the model sees) vs `session.getBranch()` (the transcript); `prepareCompaction(entries, settings)` and `estimateProjectedContextTokens`.
- Data flow: a message is appended → a context edit is appended → the projection applies the **latest** edit per target.
- Non-obvious design decisions: an edit is a **separate entry**, not a mutation: the original entry object is unchanged and still in the branch, and the projection is a different view (`session-context-edit.test.ts:37-57`). The latest edit wins, so an edit can be undone by a later edit (`:59-72`). A string replacement is normalised to the array form for the array-only roles. Critically, compaction is prepared **from the edited projection**, so a message removed from the view is also removed from the summary input (`:348-363`) — otherwise compaction would re-admit the very content the edit excluded.

### packages/coding-agent/test/session-cwd.test.ts
- Purpose: pins what happens when a session's recorded working directory no longer exists.
- Key abstractions: `getMissingSessionCwdIssue(sessionManager, fallbackCwd)` → `{ sessionFile, sessionCwd, fallbackCwd }`; `MissingSessionCwdError`; `createAgentSessionRuntime(createRuntime, options)`.
- Data flow: the session header's `cwd` → an existence check → either a normal runtime or a controlled error.
- Non-obvious design decisions: the check happens **before** the runtime is created — the test asserts the runtime factory is never called (`session-cwd.test.ts:67-90`), so no agent is ever built against a missing directory. An explicit `cwdOverride` when opening the session is accepted and clears the issue.

### packages/coding-agent/test/session-file-invalid.test.ts
- Purpose: pins the CLI's behaviour when `--session` points at a file that is not a session.
- Key abstractions: the CLI is spawned as a real subprocess with `--import <source-resolver-url>` (the comment notes `--import` takes a module specifier, not a filesystem path) and `PI_OFFLINE=1`.
- Data flow: a non-session file → the CLI → a friendly error on stderr and exit code 1.
- Non-obvious design decisions: the error is `Session file is not a valid pi session: <path>` and the test asserts it contains **no stack trace** (`not.toContain("at ")`) and no internal frame (`not.toContain("SessionManager.open")`) — the user sees a sentence, not a crash. The target file's content is **not modified** (`session-file-invalid.test.ts:49-66`).

### packages/coding-agent/test/session-id-readonly.test.ts
- Purpose: pins the read-only semantics of `--session-id` and the fork-target collision check.
- Key abstractions: `createSessionManager(args, projectDir, sessionDir, settingsManager)`; the session files are discovered by scanning for `.jsonl` files whose first line is a `{"type":"session","id":…}` header.
- Data flow: CLI args → a session manager → a file on disk.
- Non-obvious design decisions: a `--session-id` is **read-only** — it selects an existing session but does not rewrite it, and a fork target that already exists is rejected with exit code 1 (`session-id-readonly.test.ts:217-239`). The fixture directories are `realpath`-resolved because the spawned CLI sees the physical path while `tmpdir()` is a symlink on macOS, and the cwd filter compares paths textually.

### packages/coding-agent/test/session-info-modified-timestamp.test.ts
- Purpose: pins what "modified" means for a session in the list.
- Key abstractions: `SessionManager.list(cwd, sessionDir)` → `SessionInfo[]` with a `modified: Date`.
- Data flow: the session file → the last user/assistant message's `timestamp` → `SessionInfo.modified`.
- Non-obvious design decisions: `modified` is the **last message timestamp**, not the file mtime (`session-info-modified-timestamp.test.ts:49-82`) — a file mtime changes for reasons unrelated to the conversation (a backup, an editor rewrite, an antivirus scan) and would reorder the list unpredictably. The test waits 10 ms and asserts the two values differ so the assertion cannot pass by coincidence.

### packages/coding-agent/test/session-manager/build-context.test.ts
- Purpose: pins how session entries are projected into a model context.
- Key abstractions: `buildSessionContext(entries, leafId?)` → `{ messages, thinkingLevel, model }`; `buildContextEntries(entries, leafId?)` → the entry-level view; the entry kinds `message`, `compaction`, `branch_summary`, `custom`, `thinking_level_change`, `model_change`.
- Data flow: a flat entry list → the parent-linked branch → the messages + the effective thinking level + the effective model.
- Non-obvious design decisions: the thinking level and the model are **not** separate state — they are recovered from the entries that recorded the change (`session-manager/build-context.test.ts:97-106`), so a replayed session reconstructs its own settings. A compaction entry replaces the messages before `firstKeptEntryId` with its summary, and a branch summary is spliced in at the branch point.
- Edge cases: an unknown `leafId` falls back to the last entry; an **orphaned** entry (its parent does not exist) truncates the context to that orphan alone rather than throwing (`session-manager/build-context.test.ts:288-304`).

### packages/coding-agent/test/session-manager/custom-session-id.test.ts
- Purpose: pins session-id generation and validation.
- Key abstractions: `SessionManager.inMemory(cwd, { id })`, `SessionManager.create(cwd, dir, { id })`, `SessionManager.forkFrom(source, cwd, dir, { id })`, `session.newSession({ id })`.
- Data flow: an explicit id → the session header → the session file name.
- Non-obvious design decisions: without an explicit id, pi mints a **UUIDv7** (`custom-session-id.test.ts:40-47`) — time-ordered, so the file listing sorts naturally. A custom id must be non-empty and alphanumeric, and the error message says exactly that (`:29-38`). The file name is `<ISO-ish timestamp>_<id>.jsonl`. A fork always mints a **new** id and records `parentSession`; a branched session likewise.

### packages/coding-agent/test/session-manager/file-operations.test.ts
- Purpose: pins the on-disk session format — reading, repairing and appending.
- Key abstractions: `loadEntriesFromFile(path)`; `SessionManager.create/open`; the file is **append-only**; `findMostRecentSession`.
- Data flow: a `.jsonl` file → a header plus entries → an in-memory session → further appends.
- Non-obvious design decisions: a malformed line is **skipped** and the valid ones kept (`session-manager/file-operations.test.ts:83-93`); an unterminated final record is repaired by appending a newline to the file itself (`:95-107`) — the file is healed, not merely tolerated. The session file is written **only after the first assistant message** (`:456-464`), so a session that was never used leaves no file behind. Later entries are appended and earlier ones are never rewritten (`:466-473`).

### packages/coding-agent/test/session-manager/labels.test.ts
- Purpose: pins the label feature (named checkpoints on a session tree).
- Key abstractions: `session.appendLabelChange(targetId, label | undefined)`; `session.getLabel(targetId)`; tree nodes carry `label` and `labelTimestamp`.
- Data flow: a label change entry → the label map → the tree nodes.
- Non-obvious design decisions: a label is an **entry**, not a field: it has its own id and timestamp, and the *last* label change wins (`:39-55`). Clearing a label is `appendLabelChange(id, undefined)` — the label entry stays in the tree with an undefined label, so the history is preserved. Labels are **not** part of the model context (`session-manager/labels.test.ts:195-204`). Labelling a non-existent entry throws "Entry non-existent not found". A branched session keeps the labels of the entries it copies.

### packages/coding-agent/test/session-manager/load-entries.test.ts
- Purpose: pins restoring a session from preloaded entries (the in-memory / fork path).
- Key abstractions: `SessionManager.inMemory(cwd, options, entries)`; the entry kinds; `UUID_V7_RE`.
- Data flow: a list of entries → a rebuilt tree, branch, labels and compaction resolution.
- Non-obvious design decisions: the tree is **rebuilt**, not flattened — a preloaded list with a branch produces one root with two children (`session-manager/load-entries.test.ts:55-68`). New ids never collide with loaded ones (`:44-53`). The session identity is taken from a **header among the entries** when one is present, overriding the options (`:133-144`). Entries restored with an **older header version** are migrated (the header version is bumped and the `hookMessage` role becomes `custom`), while headerless entries are adopted **as-is** without migration (`:146-181`) — "migrate only what claims to be old".

### packages/coding-agent/test/session-manager/migration.test.ts
- Purpose: pins the v1 → v3 session-file migration.
- Key abstractions: `migrateSessionEntries(entries)` mutates the entries in place; the header gains `version: 3` and the entries gain `id` (8 chars) and `parentId`.
- Data flow: an old file → the entries → a migrated entry list.
- Non-obvious design decisions: the migration is **idempotent** — an already-migrated entry keeps its id and parent (`:43-77`). The `parentId` chain is reconstructed from the original order.

### packages/coding-agent/test/session-manager/save-entry.test.ts
- Purpose: pins the `custom` entry kind.
- Key abstractions: `session.appendCustomEntry(customType, data)`; the entry appears in `getEntries()` and in `getBranch()` but not in the model context.
- Data flow: a custom entry → the entry list → the branch → (excluded from) `buildSessionContext()`.
- Non-obvious design decisions: a custom entry is a **first-class branch member** — it takes a place in the parent chain (`:44-50`) — but it is invisible to the model. That is exactly the shape an extension needs for its own state: recorded in the transcript, not in the context.

### packages/coding-agent/test/session-manager/tree-traversal.test.ts
- Purpose: pins the append operations and how they integrate into the tree.
- Key abstractions: `appendMessage`, `appendThinkingLevelChange`, `appendModelChange`, `appendCompaction`, `appendBranchSummary`, `appendCustomEntry`, `createBranchedSession`, `fork`.
- Data flow: appends → entries with a `parentId` chain → the branch → the file.
- Non-obvious design decisions: every append — including a thinking-level change and a compaction — **takes a slot in the parent chain**, so `entries[2].parentId` is the thinking-level entry, not the message (`:31-47`). A compaction entry records `firstKeptEntryId` and `tokensBefore` and its own `usage`, so the cost of a compaction is part of the transcript. A branched session **writes its file immediately** when the branch point is a user message (`:561-578`), so a fork never loses the user's turn.

### packages/coding-agent/test/session-selector-path-delete.test.ts
- Purpose: pins the delete affordance in the session picker.
- Key abstractions: `SessionSelectorComponent(loadSessions, …, { keybindings, currentSessionPath })`; `onDeleteConfirmationChange` / `onError` callbacks; `CTRL_D` and the Kitty-protocol `CTRL_BACKSPACE`.
- Data flow: a keystroke → the list's handler → either a confirmation prompt or an error message.
- Non-obvious design decisions: Ctrl+Backspace is **not** delete while a search query is non-empty (it must delete a character) (`session-selector-path-delete.test.ts:108+`). The current session cannot be deleted: "Cannot delete the currently active session". The symlink fixture proves the check is on the **resolved** path, not the textual one — the same file reachable through two aliases is still the active session (`:329-357`).

### packages/coding-agent/test/session-selector-rename.test.ts
- Purpose: pins the rename mode in the session picker.
- Key abstractions: `SessionSelectorComponent(..., { showRenameHint, renameSession, keybindings })`; `CTRL_R` in the Kitty keyboard protocol (`\x1b[114;5u`).
- Data flow: Ctrl+R → the list enters rename mode → the user types → Enter → `renameSession(path, newName)`.
- Non-obvious design decisions: the hint is shown in the interactive `/resume` picker but **not** in the `--resume` picker (`session-selector-rename.test.ts:41-77`) — the flag makes it a per-mode decision. The new name is the old name with the typed text **prepended** ("Old" + "X" → "XOld"), because the editor starts with the existing name in it.

### packages/coding-agent/test/session-selector-search.test.ts
- Purpose: pins the search and sort of the session picker.
- Key abstractions: `filterAndSortSessions(sessions, query, sort: "recent" | "relevance", nameFilter: "all" | "named")`.
- Data flow: a query + a session list → a filtered, sorted list.
- Non-obvious design decisions: the query language has two forms — a **quoted phrase** (whitespace-normalised) and `re:<pattern>` (a regular expression, case-insensitive) (`session-selector-search.test.ts:22-56`). An invalid regex yields an **empty list** rather than an exception (`:115-126`). `recent` sort preserves the input order (the caller has already sorted it), while `relevance` sorts by score and tie-breaks by `modified` descending. The name filter is applied **before** the query, and a whitespace-only name does not count as named.

### packages/coding-agent/test/session-share.test.ts
- Purpose: pins session sharing (gist / Radius).
- Key abstractions: `shareSession(context)`; the destination is `settingsManager.getSessionShareDestination()` → `auto | gist | radius`.
- Data flow: the session → `exportToHtml(tempFile)` → `gh gist create --public=false <file>` → the gist URL → `https://pi.dev/session/#<id>`.
- Non-obvious design decisions: concurrent exports are **isolated** — each share writes its own file and the test interleave them to prove the uploads do not cross (`session-share.test.ts:28-89`). A user who explicitly chose gist gets a gist **without** the Radius provider even being consulted (#10870, `:92-133`). Choosing Radius without Radius authentication is an error, and no `gh` process is spawned at all.

### packages/coding-agent/test/settings-diagnostics.test.ts
- Purpose: pins how a broken settings file is reported.
- Key abstractions: `collectSettingsDiagnostics(settingsManager)`; `deduplicateDiagnostics(list)`; the `SettingsStorage` interface.
- Data flow: the settings file → a JSON parse failure → a diagnostic.
- Non-obvious design decisions: the diagnostic includes the **file path** for a file-backed store ("Invalid settings file /path/settings.json: …") and falls back to the **scope** for a store without paths ("Invalid global settings: …") (`settings-diagnostics.test.ts:9-37`). Deduplication is by (type, message), so the same warning from two scopes is reported once.

### packages/coding-agent/test/settings-manager-bug.test.ts
- Purpose: pins the fix for external edits being overwritten by an unrelated settings write.
- Key abstractions: `SettingsManager.create(projectDir, agentDir)` with a global scope (`<agentDir>/settings.json`) and a project scope (`<projectDir>/.pi/settings.json`); `manager.setTheme(...)`, `setDefaultThinkingLevel(...)`, `setProjectExtensionPaths(...)`, `manager.flush()`.
- Data flow: load → the user edits the file externally → the user changes one setting in the UI → `flush()` writes the file.
- Non-obvious design decisions: the mechanism is stated in the file's own header comment (`settings-manager-bug.test.ts:6-17`): "The fix tracks which fields were explicitly modified during the session, and only those fields override file values during save()." Without that, changing the theme reverted the user's `packages` array to its startup value. The same rule holds per scope, and an in-memory change to a field the session *did* touch still wins over the external edit.

### packages/coding-agent/test/settings-manager-compaction.test.ts
- Purpose: pins the compaction settings and their per-model overrides.
- Key abstractions: `getCompactionSettings(model?)`, `getCompactionReserveTokens(model?)`, `getCompactionKeepRecentTokens(model?)`; the key is `provider/modelId`; the defaults are `{ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }`.
- Data flow: global scope → project scope → the model override → one resolved setting.
- Non-obvious design decisions: each field resolves **independently** (`settings-manager-compaction.test.ts:16-36`) — a project override of `keepRecentTokens` does not clobber a global `reserveTokens`. The model key must match the **exact** `provider/modelId`; a `provider/*` wildcard exists but loses to an exact match, and a model id that merely contains the override's id does not match (`:45-63`). A missing field falls back to the built-in default. Project overrides are merged per field *before* the fallbacks apply (`:65-96`).
- Edge cases: **zero is a valid value**, not "unset" (`:178-191`) — a zero reserve is meaningful and must not be replaced by the default. An invalid override entry throws with the offending key and the expected type.

### packages/coding-agent/test/settings-manager.test.ts
- Purpose: the main settings test — scope precedence, external-edit preservation, and the individual setting getters.
- Key abstractions: `SettingsManager.create(projectDir, agentDir)` / `SettingsManager.inMemory(settings)`; the getters `getTuiMode`, `getFullscreenExitOutput`, `getFullscreenScrollbar`, `getFullscreenCopyOnSelect`, `getFullscreenWheelScrollLines`, `getExternalEditorCommand`, `getShellPath`, `getCacheWarmingMode`.
- Data flow: two settings files (global and project) → the merged view → a setter → a flush → the file.
- Non-obvious design decisions: an unknown value falls back to the default rather than being stored (`tuiMode: "other"` → `fullscreen`; `fullscreenExitOutput: "nothing"` → `transcript`), and the **old `uiMode` key is not recognised** at all (`settings-manager.test.ts:502-508`) — a renamed setting is a new setting, and the old key is ignored rather than silently honoured. The external editor resolves by precedence: the setting, then `$VISUAL`, then `$EDITOR`, then a platform default (`notepad` on Windows, `nano` on macOS and Linux). `shellPath` expands `~`.

### packages/coding-agent/test/settings-selector.test.ts
- Purpose: pins the settings picker's cycling behaviour.
- Key abstractions: `SettingsSelectorComponent(config, callbacks)`; the items `share-destination`, `theme`, `model-thinking`, and the fullscreen settings; `list.selectItem(id)` then `list.handleInput("\r")`.
- Data flow: a config → the rendered list → a cycle → a callback.
- Non-obvious design decisions: a cycle **includes the configured value** when it is not one of the built-ins (#9758): the wheel-scroll values cycle `10 → auto → 1 → 10 → …` so a custom value stays in the ring. The share-destination cycle is `gist → radius → auto`. The currently configured theme and per-model thinking level stay **marked with a check** while the cursor moves, and an "automatic" theme is marked on the `light/dark` entry rather than on a concrete theme.

### packages/coding-agent/test/shell-path-exists.test.ts
- Purpose: pins how pi decides that a shell actually exists.
- Key abstractions: `getShellConfig(customPath?)` and `getPowerShellConfig()`; the check is `access(path, F_OK)`.
- Data flow: the PATH lookup (`spawnSync`) → the candidate path → an existence check → the configured shell.
- Non-obvious design decisions: the existence check uses `access(F_OK)` and **not** `existsSync`, because on Windows a runnable Microsoft Store alias passes `access` but fails the extra `stat` that `existsSync` performs (nodejs/node#36790) — the comment at `shell-path-exists.test.ts:43-44` records this. The check is applied on every platform, matching `harness-v2`'s `pathExists`. An explicitly configured shell that fails the check throws "Custom shell path not found: /missing/bash".

### packages/coding-agent/test/skills.test.ts
- Purpose: the skill loader's contract, driven by the fixture skills.
- Key abstractions: `loadSkillsFromDir({ dir, source })` → `{ skills, diagnostics }`; `loadSkills(...)` across several roots; `formatSkillsForPrompt(...)`; the `Skill` shape with `name`, `description`, `filePath`, `baseDir`, `sourceInfo`, `disableModelInvocation`.
- Data flow: a directory of `SKILL.md` files → parsed frontmatter → skills + diagnostics → the prompt text.
- Non-obvious design decisions: the rules are graded, not binary — a **name mismatch** with the directory is fine, an **invalid name** is a warning, an **over-long name** is a warning, but a **missing description** is fatal (the skill is not loaded at all) (`skills.test.ts:44-85`), because the description *is* the trigger the model reads and a skill without one can never be selected. Unknown frontmatter fields are ignored silently.
- Edge cases: a **name collision** keeps the first-loaded skill and emits a warning naming the other path (`skills.test.ts:405-430`) — the loader never silently overwrites. Nested skills are discovered, and a root skill is preferred over a nested one.

### packages/coding-agent/test/startup-session-name.test.ts
- Purpose: pins when `--name` is persisted relative to the rest of startup.
- Key abstractions: the CLI is spawned as a real subprocess with `--import <source-resolver-url>` and `PI_OFFLINE=1`; `session_info` entries in the session file carry the name.
- Data flow: `--session <file> --name "  CLI Named Session  " --model missing-model -p hi` → the CLI → exit 1 → the session file.
- Non-obvious design decisions: the name is written **before** the model validation fails (`startup-session-name.test.ts:113-123`) — the CLI exits 1 because `missing-model` is unknown, but the user's intent ("CLI Named Session", trimmed) is already in the transcript. The test also asserts `signal` is `null` (a clean exit, not a kill).

### packages/coding-agent/test/status-indicator.test.ts
- Purpose: pins the working/compaction/retry status indicators and their embedding in the editor border.
- Key abstractions: `WorkingStatusIndicator`, `CompactionStatusIndicator(kind)`, `BranchSummaryStatusIndicator`, `RetryStatusIndicator(attempt, total, delayMs)`, `IdleStatus`; `CustomEditor(tui, theme, keybindings, { embedWorkingStatus })`.
- Data flow: the session state → an indicator → the editor's top border (when embedded) or a standalone line.
- Non-obvious design decisions: the top border is unchanged **unless the editor opts in** (`embedWorkingStatus: true`) — the default editor shows a plain rule and the indicator is a separate component (`status-indicator.test.ts:28-64`). When embedded, the label sits inside the border and the border's **visible width is exactly the terminal width** for every width from 1 to 120 — the label is truncated, never wrapped. The retry countdown ("Retrying (1/3) in 2s") lives inside the same border. `IdleStatus` renders two blank lines so the layout does not jump when the indicator appears.
- Edge cases: a disposed retry indicator stops its timer — no further `requestRender` after `dispose()` (`:98-110`).

### packages/coding-agent/test/stdout-cleanliness.test.ts
- Purpose: pins that non-interactive modes keep stdout clean.
- Key abstractions: the CLI is spawned with piped stdout/stderr and a fake `npmCommand` that prints two lines.
- Data flow: `--help` / `--mode json --help --approve` → stdout and stderr.
- Non-obvious design decisions: with stdout redirected, `--help` prints "Usage:" **to stdout** — the usual Unix behaviour — but `--mode json --help` keeps stdout **completely empty** and routes even the usage text to stderr (`stdout-cleanliness.test.ts:89-108`). The reason is visible in the fixture: a package install prints "changed 1 package in 471ms" at startup, and in JSON mode that would corrupt the consumer's stream; in plain `--help` mode the chatter is also redirected to stderr. The test asserts the chatter is on stderr and never on stdout.

### packages/coding-agent/test/streaming-render-debug.ts
- Purpose: a **manual debug script** that reproduces a streaming-rendering bug with real fixture data.
- Key abstractions: `AssistantMessageComponent(message, …)`; `updateContent(message)`; `TuiMainScreen` over a real `ProcessTerminal`.
- Data flow: `fixtures/assistant-message-with-thinking-code.json` → the thinking text is streamed in 10-character chunks with a 15 ms delay → then the text content is added → the terminal is watched.
- Non-obvious design decisions: the script forces `COLORTERM=truecolor` before `initTheme("dark")` so the colour behaviour is the truecolour one, and it streams into a **real** terminal rather than a virtual one, because the bug was about real rendering. It is not a test — it has no assertions and ends with `process.exit(0)`.

## Ideas worth stealing

- **A committed baseline for an upstream conformance suite, where a newly-failing check breaks the build and a newly-passing check is only reported** - `packages/coding-agent/test/mcp-conformance/run.ts:339` - pi runs the official MCP conformance suite per protocol version and diffs every check against a committed `baseline.json`. The run fails when a baseline-passing check regresses, when a check fails that the baseline does not list, and when a baselined scenario did not run; a check that *starts* passing is reported so a human can lock it in (`README.md:25`). For August this is the shape of "we know our provider gateways are broken in these nine specific ways" — a file that records known-bad provider behaviour so a new provider SDK release turns into a diff instead of a mystery. Transfer it as a generated-but-committed expectations file plus a three-way diff rule (regression = fail, improvement = report, known-failure = visible).

- **One in-flight refresh shared by many callers, with per-caller abort** - `packages/coding-agent/test/model-catalog-refresh.test.ts:38` - `refreshModelCatalogs(runtime, signal)` coalesces concurrent callers onto a single `runtime.refresh()`; a caller that aborts rejects with `AbortError` but the shared refresh's own signal stays un-aborted while another caller is still waiting, and a refresh with no remaining waiters *is* aborted and a later one may start. August's provider/model refresh and its "re-check the catalog" button have exactly this shape; this is the reference implementation of "one door, many callers, cancel only when nobody is left".

- **A turn-outcome reporter that reports only the outcome, never the content** - `packages/coding-agent/test/program-status-reporter.test.ts:67` - the reporter is a small state machine over `agent_start` / `message_end` / `compaction_end` / `agent_settled`: a retried error that later succeeds reports `done`, only the final error reports `error` (with the first line of the message), and an abort reports `idle`. The status object never carries model output (`expect(JSON.stringify(reports)).not.toContain("secret assistant output")`, line 64). August's `turn_outcomes` row and its amber stop-reason badge are the same idea, and the "never carry the content" rule is the part that keeps an external status surface safe to display.

- **Availability published *before* the credential write resolves, and a failed post-login refresh that does not roll the credential back** - `packages/coding-agent/test/model-runtime-credential-sync.test.ts:63` and `:353` - `hasConfiguredAuth` and the availability snapshot flip as soon as the local operation succeeds, not when the whole promise settles, and same-provider credential operations are serialised. When the *post-login* catalog refresh fails, the error is a typed `CredentialSynchronizationError` but the credential remains stored. August's login/logout path needs both halves: the UI must not show a half-applied provider, and a failed refresh must not log the user out of a credential that actually succeeded.

- **An MCP-style connection that degrades to "disconnected" and transparently reconnects on the next call, while a shape error (HTTP 400) fails permanently and a transient error (503) is retried** - `packages/coding-agent/test/mcp-extension.test.ts:598` and `:614` - the connection state machine distinguishes "the transport dropped" (recoverable: the next call reconnects, `opened() === 2`) from "the request was malformed" (fatal: state `failed`, one open attempt). Resource reads are retried after a transient error but **tool calls are not**, because a retried tool call could double-apply a side effect. August's terminal, MCP and provider transports should classify the same way: retry what is safe to repeat, never retry a mutation.

- **Extension dialogs stack instead of replacing each other** - `packages/coding-agent/test/interactive-mode-extension-dialogs.test.ts:66` - a second confirm or inline component is shown *on top of* the first; answering it restores the first, whose promise then settles (regression #11166: "a second dialog replaced the first one and the first promise never settled"). An `AbortSignal` removes a hidden dialog without disturbing the one above it, and focus returns to the editor when the stack empties. August's approval/permission dialogs and the "one modal at a time" pattern have exactly this failure mode — a swallowed promise is an approval that never arrives.

- **Re-check availability *after* an await, because the state can change while you wait** - `packages/coding-agent/test/interactive-mode-tree-navigation.test.ts:126` - the tree-navigation flow aborts the running response and then re-reads the busy flag, because compaction can start during the abort; the earlier check (before the await) was the bug. When the operation is busy, the rejection is reported as an error and the *active* operation's UI is left completely untouched (#9178: no status indicator created or cleared, the editor's escape handler not replaced, the leaf not moved). August's turn/compaction interlock has the same race and the same "do not disturb the running UI" requirement.

- **Compaction is prepared from the *edited projection*, not from the transcript** - `packages/coding-agent/test/session-context-edit.test.ts:348` - a message removed from the model's view by `appendContextEdit(id, null)` is also absent from `prepareCompaction`'s summary input, and the original entry is still in the transcript untouched. A context edit is a separate entry; the latest edit per target wins, so an edit is undoable by a later edit. August's context relief ("edit what the model sees, keep the record") must prepare its summary from the same projection, or compaction silently re-admits the content that was just excluded.

- **A hard argument/error budget on a tool's own nested calls, with unfinished calls marked as such** - `packages/coding-agent/test/nested-tool-calls.test.ts:210` - `NESTED_CALL_LIMITS` caps the number of recorded calls, truncates each error to `maxErrorChars`, and imposes a 32 KiB total-argument budget; once the budget is exhausted, later calls keep their status but **lose their arguments**, and calls that never finished are marked `status: "unfinished"` with `complete: false`. That is a precise answer to "how much of a nested tool's internals may enter the transcript", which August's transcript has to decide too — the answer here is: bounded, and honest about what was dropped.

- **A size-capped system-prompt section that tells the model to *search* for what was omitted** - `packages/coding-agent/test/mcp-extension.test.ts:859` - `renderServersSection` never exceeds `MAX_SERVERS_SECTION_CHARS`; when the names alone do not fit, the tail is replaced with `- … N more servers; find their tools with searchTools()`. August's progressive-disclosure tool surface has the same shape, and the important detail is the *handoff*: the model is told which door to use for what it cannot see.

- **Per-model, per-field settings resolution where zero is a value and an exact key beats a wildcard** - `packages/coding-agent/test/settings-manager-compaction.test.ts:16` and `:45` - `reserveTokens` and `keepRecentTokens` resolve independently through global → project → model override, the model key must match `provider/modelId` exactly (a `provider/*` wildcard exists but loses to an exact match), and **0 is a legitimate value** rather than "unset". August's brain-config keys have exactly this hazard (`0 = off` versus `absent`), and the field-level independence is what stops a project override from clobbering an unrelated global field.

- **Settings writes preserve external edits by tracking which fields the session touched** - `packages/coding-agent/test/settings-manager-bug.test.ts:6` - the fix is stated in the file's own header: "The fix tracks which fields were explicitly modified during the session, and only those fields override file values during save()." Without it, changing the theme in the UI reverted a `packages` array the user had edited by hand. August writes `settings.json` and `providers.json` from the same process that reads them, and has the same last-writer-wins hazard.

- **A protocol negotiation whose result changes the wire format, pinned end to end** - `packages/coding-agent/test/model-catalog-protocol.test.ts:110` - the client asks for `types=chat,image,classifier` plus its `pi-version`; the server answers with the newest catalog revision the client satisfies; a revision that predates typed shards falls back to the chat-only shard, and the model's `api`/`baseUrl` — and therefore the final provider URL (`/api/v1/messages` vs `/api/v1/chat/completions`) — come from that revision. August's per-model `apiFormat` work is the same negotiation, and this test is the proof that the negotiated value actually reaches the wire.

- **An ambiguity is reported, never resolved by catalog order** - `packages/coding-agent/test/model-resolver.test.ts:542` - when the same model id exists behind two providers and neither is authenticated, the error names both (`"openrouter/anthropic/claude-opus-5.5, vercel-ai-gateway/anthropic/claude-opus-5.5"`) instead of picking the first; a stored credential may disambiguate, but an inline `--api-key` may not ("--api-key does not choose a provider."). August's gateway/priority work has the identical ambiguity when two providers expose the same model id.

- **A per-provider compat decision applied to *every* model kind** - `packages/coding-agent/test/model-runtime-classifiers.test.ts:88` and `packages/coding-agent/test/model-runtime-images.test.ts:107` - the image encoding of a request (`image_url` inside `state` vs `assets`) is a per-provider compat flag, and it applies to classifier models exactly as it does to chat models; an extension's model list replaces the undeclared models **of every operation**, so declaring only chat models removes the provider's built-in image models. August's provider adapters need the same "one compat table, applied to every model kind" rule, or the kinds drift apart.

- **A single-flight token refresh across processes** - `packages/coding-agent/test/mcp-oauth-refresh.test.ts:54` - three processes that share a credential file and a lock directory see the same token rejected, but the server rotates refresh tokens, so only **one** refresh may happen; the others wait for the running refresh to persist the new tokens and the lock is released. August's multi-process case (an unattended Bot plus the desktop app, or two workers on one credential store) needs the same lock, or the second refresh will fail with `invalid_grant`.

- **stdout is a protocol surface** - `packages/coding-agent/test/stdout-cleanliness.test.ts:100` - with stdout redirected, `--help` prints "Usage:" to stdout, but `--mode json --help` keeps stdout **completely empty** and routes even the usage text to stderr, because a package install prints "changed 1 package in 471ms" during startup and that would corrupt a JSON consumer's stream. August's `/v1` adapters and CLI modes have the same obligation, and the fixture shows the real hazard is third-party chatter, not pi's own output.

- **A skill's description is the trigger, and a missing description is fatal while a name mismatch is not** - `packages/coding-agent/test/skills.test.ts:44` and `:77` - a skill whose frontmatter name differs from its directory loads without complaint; an invalid name and an over-long name are warnings; but a **missing description** means the skill is not loaded at all, because the description is the only thing the model sees before it decides to open the skill. August's `SKILL.md` spec should adopt the same grading, and the "first loaded wins + a warning naming the other path" collision rule (`skills.test.ts:405`).

- **A single-flight refresh that is aborted only when no caller is left** and **a credential store that masks rather than mutates** - `packages/coding-agent/test/runtime-credentials.test.ts:7` - a runtime API key overrides the stored credential for the process without ever persisting it, `list()` exposes only `{ providerId, type }`, and a cancelled `delete` leaves the runtime override in place. August's `scrubOutboundBody` and the credential store want the same property: an override must not reach the file, and an enumeration must not leak a key.

- **Extension packages that declare the host as a dependency are warned about, with the reason spelled out** - `packages/coding-agent/test/resource-loader.test.ts:59` - the warning says the host must be in `peerDependencies` with a `*` range, and explains why: "Installed copies can bypass the extension loader and create duplicate runtime modules." (#9863). August's plugin layer has the identical hazard, and the warning text is a good model — it names the mechanism, not just the rule.

- **A regression test that keeps the *documentation* honest** - `packages/coding-agent/test/references.test.ts:7` - the generated reference page is compared with the committed file, and the failure message names the regeneration command. The regression it guards (#10790) is that `models.json` fields silently lost their reference documentation. August's `check:docs`-style gates are static, but this is the complementary idea: a *generated* artifact that is committed and diffed.

## Files skipped (with reasons)

- `packages/coding-agent/test/fixtures/large-session.jsonl` - a 974 KB / 1019-line capture of a real session transcript (JSONL: a `session` header plus `message` envelopes with provider, model, usage and stopReason). It is generated/recorded data, not logic, so it was opened and sampled (first three lines, last line, line count, the entry shapes) rather than read line by line; every one of the 1019 lines is a transcript entry and none of them contains logic to be understood.

## Uncertainties

- **The manifest was rewritten under me mid-session.** At 13:29 the manifest gave my shard as `coding-agent-tests#3` with exactly 139 rows; the lead rewrote `manifest.tsv` at 13:39:24 (the file's mtime) and the shard id `coding-agent-tests#3` no longer appears in it — the `packages/coding-agent/test/**` files are now spread over ten new owner shards (`packages-coding-agent-12` … `packages-coding-agent-21`, 346 files in total). I kept the assignment I was given and reported on the 139 files the manifest listed at 13:29; I verified that set is exactly the alphabetically contiguous block from `fixtures/` to `streaming-render-debug.ts` (110 top-level test files + 17 skill fixtures + 4 `mcp-conformance/` files + 8 `session-manager/` files) and that I read every one of them. My rows file therefore **overlaps** with the new shards `packages-coding-agent-16` … `packages-coding-agent-21`; the lead will need to de-duplicate on merge.

- I could not fully establish **which of the `session-manager/` entries the model context includes** in the compaction path: `session-manager/build-context.test.ts` covers `buildSessionContext` (messages + thinking level + model) and `session-context-edit.test.ts` covers `prepareCompaction`, but the exact rule by which a `compaction` entry's `firstKeptEntryId` interacts with a later `branch_summary` in the *same* branch is asserted only indirectly. I checked `build-context.test.ts:230-286` and `session-context-edit.test.ts:348-363`; the interaction is described in prose in the tests but not pinned as a single rule.

- **`interactive-mode-status.test.ts` is 1 372 lines and I read it in three passes** (1–700, 700–1400). The middle section — the compact-extension-label and scope-group builders — was read but the file's `getCompactExtensionLabels` / `buildScopeGroups` / `formatScopeGroups` implementations are only visible through their test expectations, not their source; the source lives in `src/modes/interactive/interactive-mode.ts`, which is not in this shard.

- **`package-manager.test.ts` is 2 862 lines and I read it in four passes** (1–820, 821–1640, 1641–2340, 2341–2862). The parts I did not characterise in detail are the middle `describe` blocks covering npm install/uninstall specifics and the progress-event plumbing (`ProgressEvent` is imported but I saw no assertion on its shape); I did not find a test that pins the progress-event protocol.

- I could not establish **whether pi has any turn-level bound or stall detection** from this shard. The shard contains no test for a maximum round count, a stall counter or a runaway backstop — August's own harness has several. The closest things are `program-status-reporter.test.ts` (which reports the outcome of a turn but never bounds it) and the "retry" indicators in `status-indicator.test.ts`. This is consistent with what the workspace notes say about pi, but I checked only this shard.

- I did **not** read the files the shard's tests import from `src/**` (they belong to other shards: `coding-agent-src#1`/`#2`), so where a note explains *why* a production module behaves as it does, the reasoning comes from the test's own comments and assertions rather than from the implementation.

- `packages/coding-agent/test/rpc.test.ts` is **skipped at runtime** unless `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN` is set, so its assertions are never exercised in CI without a real credential; I read it but could not verify that it passes.
