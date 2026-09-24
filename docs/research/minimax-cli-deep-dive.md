# MiniMax-AI/cli — architectural deep dive for August Proxy

**Reference repo:** `https://github.com/MiniMax-AI/cli.git` (`mmx-cli`), cloned at
`C:/Users/rober/AppData/Local/Temp/ref-repos/minimax-cli`, HEAD `33453cf` ("docs: clarify release
authentication and notes"), 163 TypeScript files / ~23k LOC in `src/` + `test/`.

All citations are `path:line` against that clone. Where something does not exist, this report says
so explicitly rather than inferring it.

---

## 0. The headline finding, stated up front

**`mmx-cli` is not an agent harness.** It is a thin, unusually disciplined **API client CLI** for
the MiniMax platform (text, image, video, speech, vision, search, files, quota) plus an
`mmx agent setup` command that *configures third-party coding agents* (Claude Code, Codex, Grok,
OpenCode, Hermes, Pi) to point at MiniMax.

There is **no** agent loop, **no** subagent/delegation system, **no** memory or compaction,
**no** self-improvement/reflection, and **no** tool execution. Verified by exhaustive grep over
`src/`:

| Requested area | Present? | Evidence |
|---|---|---|
| Agent loop / harness | No (a one-shot REPL and one-shot `text chat` only) | `src/commands/text/repl.ts:356-435`, `src/commands/text/chat.ts:178-324` |
| Tool-call parsing / execution | No — schemas are declared and forwarded, never dispatched | `src/types/api.ts:6-7,13-18`; `src/commands/text/chat.ts:218-236` |
| Subagents / delegation | No | `grep -rln "subagent\|spawn\|delegate" src` → only `src/auth/oauth.ts`, `src/agent/installer.ts` (installer subprocesses) |
| Memory / compaction | No | `grep -rln "memory\|recall\|embedding" src` → no matches |
| Reflection / self-improvement | No | no trajectory/episode store; the only taxonomy is `src/errors/codes.ts:1-10` |
| Long-running task resume | Partial — poll-until-done, no persistence | `src/polling/poll.ts:17-63` |

What it *does* have, and what August should actually mine from it, is a set of **client-side
discipline patterns**: spec-correct SSE parsing, idle-vs-overall timeouts, backpressure-aware
writing, atomic + lock-guarded multi-file config mutation with rollback, a pre-write credential
verification step, a machine-readable exit-code taxonomy, and an `isInteractive()` gate that makes
every command safe in CI/agent contexts.

---

## 1. Agent loop / harness

### 1.1 What exists

**The closest thing to a turn loop is `mmx text repl`** — a raw-mode terminal REPL that keeps
message history in memory and, per user turn, performs exactly one `POST` and drains the SSE stream
(`src/commands/text/repl.ts:292-601`).

Turn structure (`src/commands/text/repl.ts:568-589`):

```ts
try {
  while (running) {
    const line = await editor.readLine();
    if (!running) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('/')) {
      const result = handleSlash(trimmed);
      if (result === 'exit') { running = false; break; }
      continue;
    }
    state.messages.push({ role: 'user', content: trimmed });
    await sendMessages();
  }
}
```

State is a plain object — messages, system, model, maxTokens, temperature, topP
(`src/commands/text/repl.ts:54-61`, initialised at `:325-332`). There is **no** iteration over tool
results, no re-entry after a model turn, and no cap on turns or rounds.

**Streaming render** distinguishes thinking from answer text via `content_block_start` /
`content_block_delta` (`src/commands/text/repl.ts:395-419`):

```ts
for await (const event of parseSSE(res)) {
  if (event.data === '[DONE]') break;
  try {
    const parsed = JSON.parse(event.data) as StreamEvent;
    if (parsed.type === 'content_block_start') {
      if (parsed.content_block.type === 'thinking') { inThinking = true; ... }
      else if (parsed.content_block.type === 'text' && inThinking) { ...; inThinking = false; }
    } else if (parsed.type === 'content_block_delta') {
      if (parsed.delta.type === 'text_delta') { textContent += parsed.delta.text; stdout.write(parsed.delta.text); }
      else if (parsed.delta.type === 'thinking_delta') { stdout.write(parsed.delta.thinking); }
    }
  } catch {
    // Skip malformed chunks
  }
}
```

**Malformed-output recovery is deliberately lossy-but-alive**: a chunk that fails `JSON.parse` is
skipped (REPL, `:416-418`) or turned into a stderr warning while partial output is kept
(`src/commands/text/chat.ts:296-299`):

```ts
} catch (err) {
  // Warn but don't crash — partial output is better than nothing
  process.stderr.write(`\n${dim}[warning] Failed to parse stream chunk: ...`);
}
```

There is **no** re-prompt, no malformed-tool-JSON recovery, and no stop-reason taxonomy. The
response's `stop_reason` is typed (`src/types/api.ts:36`) but never read anywhere in `src/`.

**Retries: the harness path has none.** `src/commands/text/chat.ts:245-323` issues a single
request. Retries exist only in three other places:

- OAuth token refresh: 3 attempts, linear backoff `RETRY_DELAY_MS * attempt`, immediate give-up on
  4xx (`src/auth/refresh.ts:27-93`).
- File download: exponential backoff honouring `Retry-After` (`src/files/download.ts:428-465`).
- Region auto-detection (`src/config/detect-region.ts`).

**Budgets/caps** are limited to `max_tokens` (default 4096,
`src/commands/text/repl.ts:329`; `src/commands/text/chat.ts:210`) and a request `timeout`
(default 300 s, `src/config/loader.ts:99`). **No tool-round cap, no token cap, no wall-clock cap.**

**Stop reasons**: the only structured exit vocabulary is the process exit code
(`src/errors/codes.ts:1-10`):

```ts
export const ExitCode = {
  SUCCESS: 0, GENERAL: 1, USAGE: 2, AUTH: 3,
  QUOTA: 4, TIMEOUT: 5, NETWORK: 6, CONTENT_FILTER: 10,
} as const;
```

### 1.2 The SSE parser is the genuinely reusable part

`src/client/stream.ts:1-82` is a correct, dependency-free async-generator SSE parser. Details that
matter:

- Multi-line `data:` fields join with `\n` (`:35-36`).
- Comment lines (`:` keepalives) are dropped (`:26`).
- Fields without a colon are skipped (`:28-29`).
- An event is emitted on the blank-line terminator (`:18-24`).
- **A trailing event with no terminator is still flushed** after the reader ends (`:76-78`) — this
  is the single most common source of "last SSE frame silently dropped" bugs in hand-rolled
  clients, and it is handled here.
- The reader lock is released in `finally` (`:79-81`).

### 1.3 Timeout model: two clocks, not one

`src/client/http.ts:133-160` separates a **header timeout** from a **stream idle timeout** — the
common failure where a long generation is killed by a single global timeout never happens here:

```ts
const timeoutMs = (opts.timeout ?? config.timeout) * 1000;
const streamAbortController = opts.stream ? new AbortController() : undefined;
const headerTimeout = streamAbortController
  ? setTimeout(() => { streamAbortController.abort(timeoutError(`Request headers were not received within ${timeoutMs}ms.`)); }, timeoutMs)
  : undefined;
...
if (streamAbortController) { res = withIdleTimeout(res, timeoutMs, streamAbortController); }
```

`withIdleTimeout` (`:25-97`) re-wraps the response body in a `ReadableStream` whose `pull` races
`reader.read()` against a fresh timer, aborting the controller and cancelling the reader on expiry —
i.e. "no bytes for N ms" is the liveness condition, not "N ms total".

---

## 2. Subagents / delegation

**Does not exist.** There is no spawn, no child agent, no concurrency control, no event ids, no
replay, no drain-on-shutdown, no futures. The `agent/` package is about writing config files for
*other people's* agents:

- `src/agent/types.ts:3-12` — a fixed list of six third-party agent ids.
- `src/agent/availability.ts:22-55` — PATH/PATHEXT detection plus runtime env markers
  (`CLAUDE_CODE_CHILD_SESSION`, `OPENCODE_CLIENT`, …) to guess "you are probably running inside
  agent X".
- `src/agent/configurator.ts` (1216 lines) — renders per-agent JSON/JSONC/TOML/YAML/dotenv
  fragments.
- `src/agent/verify.ts:141-229` — proves a credential works *before* any file is touched.
- `src/agent/installer.ts:300-380` — subprocess install with process-tree termination.

The one thing adjacent to "preventing output loss" here is the installer's child-process
settlement discipline (`src/agent/installer.ts:330-377`): a `settled` flag, per-signal handlers that
kill the process tree then re-raise, a `timeout.unref()` so a pending timer cannot hold the process
open, and `finish()` that clears the timer and removes handlers on every exit path:

```ts
const timeout = setTimeout(() => {
  if (settled) return;
  terminateProcessTree(child, true);
  child.unref();
  settled = true;
  removeSignalHandlers();
  reject(new AgentInstallTimeoutError(options.timeoutMs));
}, options.timeoutMs);
timeout.unref();
```

Process-tree termination is explicit per platform (`src/agent/installer.ts:301-327`): `taskkill
/pid <pid> /t /f` on Windows, `process.kill(-pid, …)` process-group kill on POSIX, with an
`ESRCH` guard.

---

## 3. Memory & context

**No long-term memory, no retrieval, no compaction, no token accounting.** The only persistence is
configuration and credentials, and the only conversation persistence is a manual `/save`
(`src/commands/text/repl.ts:481-501`) that writes a plain JSON array with `writeFileSync` — not
atomic, no backup, no schema version.

What is worth stealing:

**Credentials live inside the main config file under one key** (`src/auth/credentials.ts:5-26`):

```ts
/**
 * OAuth credentials live inside the user's main config file
 * (`~/.mmx/config.json`) under the `oauth` subobject. This keeps a
 * single source of truth for all CLI state.
 */
```

One file means one lock, one atomic write, one corruption surface — versus August's split
provider-store / credentials surfaces.

**Token freshness with a buffer** (`src/auth/refresh.ts:95-114`): a token is refreshed when it
expires within 5 minutes, and the refreshed token is persisted before it is returned, so a crash
mid-turn does not lose the rotation.

**Context-window facts live in a typed model table**, not a comment
(`src/agent/types.ts:14-33`): each model carries `contextWindow`, `maxTokens`, and `input`
modalities, and that table is written verbatim into the configured agents' catalogs
(`src/agent/configurator.ts:571-576`).

---

## 4. Learning / self-improvement

**Does not exist.** No reflection pass, no trajectory/episode log, no error-family steering, no
self-correction. There is nothing here for August to copy in this area — August's existing
harness stall-detection, error taxonomy and `turn_outcomes` are strictly ahead.

The one transferable artefact is the **error taxonomy as a closed enum mapped to exit codes and
user-facing remediation**. `src/errors/api.ts:31-142` is a decision table:

- HTTP 401/403 → `ExitCode.AUTH` + hint "Check status: mmx auth status" (`:40-46`)
- 429 → `ExitCode.QUOTA` + "Check usage: mmx quota show" (`:48-54`)
- 402 / `insufficient_balance_error` → `ExitCode.QUOTA` (`:56-62`)
- 408/504 → `ExitCode.TIMEOUT` + "Try increasing --timeout" (`:64-70`)
- Content filter is keyed off **endpoint + status** where the message language is unstable, with the
  message-text heuristic kept only for other endpoints (`:72-80`):

```ts
// The speech-to-text API uses 422 specifically for sensitive audio (1026).
// Its message language varies, so key off the endpoint + status rather than
// message text; other endpoints keep the heuristic below.
if (status === 422 && url?.includes('/speech_to_text')) { ... }
```

- Quota codes 1028/1030 and model-not-on-plan 2061 get plan-specific upgrade URLs (`:109-127`).

`src/errors/handler.ts:5-124` then normalises everything the type system did not catch —
`AbortError`/`TimeoutError`/message-contains-"timed out" → TIMEOUT (`:21-36`), a `TypeError` with
message exactly `"fetch failed"` → NETWORK (`:38-47`), a substring sweep for network errno-ish text
(`:49-81`), and an errno table for filesystem failures (`:83-113`):

```ts
if (ecode === "ENOENT" || ecode === "EACCES" || ecode === "ENOSPC" || ... ) {
  let hint = "Check the file path and permissions.";
  if (ecode === "ENOENT") hint = "File or directory not found.";
  if (ecode === "EACCES" || ecode === "EPERM") hint = "Permission denied — check file or directory permissions.";
  if (ecode === "ENOSPC") hint = "Disk full — free up space and try again.";
  ...
}
```

`ERRORS.md:1-288` is the maintained user-visible contract for that mapping — every branch has a
literal message, and the exit-code table is published.

---

## 5. Tool system

### 5.1 Definitions exist; execution does not

`--tool <json-or-path>` is repeatable and accepts inline JSON or a file
(`src/commands/text/chat.ts:169`). Parsing is a two-attempt JSON-then-file fallback with a usage
error naming both (`:218-236`):

```ts
const tools = (flags.tool as string[]).map(t => {
  try { return JSON.parse(t); }
  catch {
    try { return JSON.parse(readFileSync(t, 'utf-8')); }
    catch { throw new CLIError(`Invalid tool definition: "${t}" is neither valid JSON nor a readable file.`, ExitCode.USAGE); }
  }
});
body.tools = tools;
```

The wire types for `tool_use` / `tool_result` blocks are declared
(`src/types/api.ts:6-7`, `ChatRequest.tools` at `:26`) and `extractText` filters to text blocks
only (`src/commands/text/chat.ts:148-153`) — so a tool-call-only assistant response prints as an
**empty string** and, in the REPL, as `[empty response]` (`src/commands/text/repl.ts:426-428`).
There is no dispatcher, no permission gate, no sandbox, no truncation, no parallel execution.

### 5.2 The genuinely clever bit: commands self-describe as tool schemas

`mmx config export-schema` renders the whole CLI as Anthropic/OpenAI-shaped tool definitions
(`src/commands/config/export-schema.ts:14-55`), skipping infrastructure commands
(`:12`: `const SKIP_PREFIXES = ['auth ', 'config ', 'update'];`). The schema is *derived from the
same `OptionDef[]` the flag parser consumes*, so it cannot drift from the real CLI
(`src/utils/schema.ts:36-80`):

```ts
const explicitType = opt.type;
const effectiveType = isArray ? 'array' : (explicitType ?? inferredType);
...
if (opt.required) { (inputSchema.required as string[]).push(name); }
```

with type inference from the flag string itself (`:19-33`): no `<value>` placeholder → boolean,
`<n>`/`<hz>`/`<bps>`/`<count>` → number, `repeatable` in the description → array. This is a
single-source-of-truth pattern for tool definitions that August's dual
`toolDefinitions`/`openaiToolDefinitions` path could borrow in spirit.

### 5.3 No sandbox, no permissions, no parallel tools

The only process execution is the third-party agent *installer*
(`src/agent/installer.ts:330-377`), and it is deliberately conservative: detached process group on
POSIX, inherited stdio, explicit env construction (`installerEnvironment`, `:286-291` injects
`HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY` rather than trusting ambient proxy state), a 5-second
`commandExists` probe (`:114`), and a timeout on every install.

---

## 6. UI/UX (TUI/CLI interaction model)

This is the area where MiniMax's product thinking is most legible and most portable to a desktop
app.

**Composer.** `src/commands/text/repl.ts:67-286` is a hand-rolled line editor: raw-mode keypress
decode, arrow-key history, `Ctrl+A/E/U/W`, `Delete`/`Home`/`End`, and a full redraw
(`render()`, `:246-285`) that draws a top border, the input line, a bottom border, and live
slash-command suggestions *below* the border, tracking `lastTotal` so it can `clearBelow()` when
the suggestion list shrinks (`:275-277`). Tab completes a slash command when there is exactly one
hit (`:182-193`).

**Slash commands** (`:29-37`): `/exit`, `/clear`, `/system`, `/model`, `/save`, `/help`,
`/history`. Note `/clear` **keeps the system prompt** (`:452-455`) and `/history` prints numbered,
newline-folded, 120-char previews (`:503-523`).

**Interrupt semantics** (`:534-557`): one `Ctrl+C` during a stream prints `[interrupted]` and
stays in the session; a second `Ctrl+C` at the prompt exits. A third state — a stream that is
`waitingForResponse` — is tracked by a flag so the same key does different things by context.

**Thinking indicator** (`src/commands/text/chat.ts:46-91`): a braille spinner on **stderr** with a
hue-cycled label and an elapsed counter that switches from `Thinking (12s)` to
`Thinking (1m 5s)` at 60 s (`:70-90`).

**The stdout/stderr split is the central UX contract.** The spinner, status bar, warnings and
progress all go to stderr; stdout is pure data, so `mmx video generate --prompt "Waves" 2>/dev/null`
and `URL=$(mmx image generate ... --quiet)` are safe (`skill/SKILL.md:343-360`). `chat.ts:269-270`
encodes it explicitly:

```ts
const statusOut = isTTY && !isJsonOutput ? process.stderr : process.stderr;
const resultOut = isJsonOutput ? undefined : process.stdout;
```

(the ternary is vestigial — both branches are `process.stderr` — but the intent is unambiguous).

**Status bar** (`src/output/status-bar.ts:27-46`): one line, once per process, TTY-only,
never under `--quiet` — config path (home- abbreviated to `~`), base URL without scheme, masked key
with its *source* (`(flag)` vs `(file)`), and the model when the request body has one
(`src/client/http.ts:125-130` extracts it for exactly this purpose). `maskToken` is
`abcd...wxyz` for >8 chars, `***` otherwise (`src/utils/token.ts:1-3`).

**Progress** (`src/output/progress.ts:9-66`): a TTY-gated spinner with mutable label, and a
30-cell bar gated on a known `Content-Length`.

**Output format auto-detection** (`src/output/formatter.ts:6-14`) — a pattern August's UI/backend
boundary should mirror: explicit `--output` wins, otherwise **non-TTY implies JSON**:

```ts
export function detectOutputFormat(flagValue?: string): OutputFormat {
  if (flagValue === 'json' || flagValue === 'text') return flagValue;
  if (!process.stdout.isTTY) return 'json';
  return 'text';
}
```

**`isInteractive()` is a first-class gate** (`src/utils/env.ts:20-24`): false under `--non-interactive`,
false when `CI` is set, false unless *both* stdin and stdout are TTYs. Every prompt wrapper returns
`undefined` instead of blocking in that mode (`src/utils/prompt.ts:27-45`, `:109-121`), and
`failIfMissing` (`:173-181`) converts a missing required flag into a usage error whose hint
explicitly names the agent/CI context. `text repl` refuses to start at all without a TTY
(`src/commands/text/repl.ts:309-319`).

**API-key entry is masked as you type** with a custom `@clack/core` renderer
(`src/utils/prompt.ts:55-84`) showing `sk-xxx… (52 chars)` and distinct submit/cancel/error glyphs.

**Approvals**: one `promptConfirm` gate before any file is written, whose message spells out
exactly what will happen and which agents are configuration-only
(`src/commands/agent/setup.ts:310-321`):

```ts
let message = `Configure ${...}? mmx will write configuration files.`;
...
const confirmed = await promptConfirm({ message });
if (!confirmed) throw new CLIError('Agent setup cancelled.', ExitCode.GENERAL);
```

Non-interactive invocations *must* pass `--region` explicitly to stay deterministic
(`src/commands/agent/setup.ts:351-357`).

---

## 7. Settings / config

**Precedence is flag > env > file > default** (`docs/cli-design.md:59-63`, implemented at
`src/config/loader.ts:64-122`). Every knob is read in the same shape, e.g. timeout
(`src/config/loader.ts:96-99`):

```ts
const envTimeout = process.env.MINIMAX_TIMEOUT ? Number(process.env.MINIMAX_TIMEOUT) : undefined;
const validEnvTimeout = envTimeout !== undefined && Number.isFinite(envTimeout) && envTimeout > 0
  ? envTimeout : undefined;
const timeout = flags.timeout ?? validEnvTimeout ?? file.timeout ?? 300;
```

A malformed env value is discarded, not propagated.

**Parsing is total** (`src/config/schema.ts:62-80`): every field is type- and range-checked and
silently dropped if wrong — unknown keys are ignored, `region` must be in `VALID_REGIONS`,
`base_url`/`proxy` must start with `http`, `timeout` must be a positive number. `parseOAuth`
(`:45-60`) returns `undefined` for any structurally-wrong credential object rather than throwing.

**Corruption is survivable** (`src/config/loader.ts:39-51`):

```ts
try { return parseConfigFile(JSON.parse(readFileSync(path, 'utf-8'))); }
catch (err) {
  if (e instanceof SyntaxError || e.message.includes('JSON')) {
    process.stderr.write(`Warning: config file is corrupted. Run 'mmx config set' to reset.\n`);
  }
  return {};
}
```

**Writes are atomic, private, and cross-device-safe** (`src/config/loader.ts:53-62`):

```ts
const tmp = path + '.tmp';
writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
renameWithCrossDeviceFallback(tmp, path, renameOps);
```

with `renameWithCrossDeviceFallback` catching `EXDEV` and degrading to copy+unlink
(`:21-37`). Directory creation is `mode: 0o700` (`src/config/paths.ts:15-19`).

**Scope**: strictly user-global (`~/.mmx/config.json`), with `MMX_CONFIG_DIR` as the one override
(`src/config/paths.ts:6-9`) documented specifically for subprocess/service/CI homes
(`README.md:191`). **There is no project-local config and no precedence merge between the two** —
this is a genuine gap relative to August, not a lesson.

**Self-documenting config**: `mmx config show`, `mmx config set --key <k> --value <v>`, and
`mmx config export-schema` (`src/registry.ts:19-21`), plus the `default_*_model` keys that let
`--model` be omitted (`src/config/schema.ts:37-39`, `skill/SKILL.md:378-397`).

---

## 8. Lifecycle

**Startup** (`src/main.ts:38-151`): parse path → configure proxy from env-or-config
(`:57-64`) → resolve command (with a special-cased re-scan for `agent` so its own options don't
swallow the path, `:47-54`) → parse flags → `loadConfig` → `ensureAuth` unless the command is in
`NO_AUTH_SETUP` (`:29-36`, `:121-126`) → optional region auto-detect (`:128-137`) → run.

**The update check is started before the command and awaited after it, so it never delays a run**
(`src/main.ts:139-150`):

```ts
const updateCheckPromise = isAgentSetup && config.dryRun ? Promise.resolve() : checkForUpdate(CLI_VERSION).catch(() => {});
await command.execute(config, flags);
await updateCheckPromise;
```

The check itself is throttled by a 24 h state file and is skipped entirely in CI / non-TTY
(`src/update/checker.ts:53-76`); failures are swallowed.

**Shutdown.** SIGINT → `Interrupted. Exiting.` exit 130 (`src/main.ts:17-20`); stdout `EPIPE` →
exit 0 so piping into a process that exits early (`mmx speech synthesize | mpv`) is not an error
(`:22-26`). The REPL additionally restores raw mode, pauses stdin, and removes listeners in a
`finally` (`src/commands/text/repl.ts:590-599`). The config lock installs `SIGHUP/SIGINT/SIGTERM`
handlers **and** an `exit` hook that all release the lock
(`src/agent/configurator.ts:1060-1089`).

**No session restore, no crash recovery, no checkpoint.** `/save` is manual and unversioned
(`src/commands/text/repl.ts:481-501`).

**Self-update** (`src/update/self-update.ts`) is the most production-grade code in the repo:
SHA-256 verification before install (`:92-102`), an atomic rename with a copy+backup-restore
fallback (`:197-215`), and a download loop that waits for the writer's `finish` (explicitly, to
avoid racing the page cache on checksum verification, `:117-122`), honours backpressure (`:130-132`),
destroys the writer *before* unlinking on failure (`:140-154`), and always releases the Web
Streams reader lock (`:155-159`).

---

## 9. Testing & robustness

- **Runner**: Bun's built-in, 70 test files mirroring `src/` (`AGENTS.md:126-141`).
- **CI**: `bun run typecheck` → `bun test` → a compile smoke test of the shipped binary
  (`.github/workflows/ci.yml:8-17`).
- **HTTP tests run against a real local server**, not a fetch mock
  (`test/helpers/mock-server.ts:13-47`, `Bun.serve` on port 0 with exact → method+path → prefix
  routing), which exercises real chunked SSE framing.
- **SSE tests target the hard cases explicitly**: multi-line data, comments, colon-less lines, empty
  `data:`, null body, reader-lock release, **events split across network chunk boundaries**, and
  CRLF (`test/client/stream.test.ts:134-281`). The split-chunk tests (`:244-274`) feed a
  hand-built `ReadableStream` that ends mid-field — exactly the bug class that breaks naive parsers.
- **Idempotency is a tested property**, not an aspiration
  (`test/agent/configurator.test.ts:280-287`):

```ts
it('is idempotent and does not create another backup for unchanged files', () => {
  applyAgentConfigurations(prepareAgentConfigurations(options));
  const second = applyAgentConfigurations(prepareAgentConfigurations(options));
  expect(second.every((file) => file.status === 'unchanged')).toBe(true);
  expect(second.every((file) => file.backup === undefined)).toBe(true);
});
```

- **Concurrency is tested with real processes and real signals**
  (`test/agent/configurator.test.ts:465-513`): spawn a child holding the lock, assert exactly one
  lock file, `SIGKILL`/`SIGINT`/`SIGTERM` it, assert the documented exit code *and* that the lock
  directory is empty afterwards.
- **Filesystem ops are dependency-injected for testing**: `writeConfigFile(data, renameOps?)` and
  `renameWithCrossDeviceFallback(from, to, ops = {rename, copy, unlink})`
  (`src/config/loader.ts:9-37`) let the `EXDEV` branch be unit-tested without a second filesystem
  (`test/config/loader.test.ts:76-80`).
- **Ordering guarantees** are asserted: stderr vs stdout routing, and drain-before-close in the
  download writer.
- **Code review**: two independent blind reviewers, then one, with an explicit stop-and-reconsider
  rule (`AGENTS.md:148-153`).

### The multi-file transaction (worth reading in full)

`applyAgentConfigurations` (`src/agent/configurator.ts:1091-1215`) is a hand-rolled two-phase
commit, and it is the most transferable algorithm in the repository:

1. **Lock** unless dry-run or the caller already holds it (`:1096`).
2. **Refuse duplicate targets** after symlink resolution (`:997-1009`, called at `:1099`).
3. **Dry-run returns a plan** without writing (`:1111-1119`).
4. **Optimistic concurrency**: re-resolve the real path and re-read the file; if either differs
   from what was prepared, abort with "No files were changed" (`:1121-1135`).
5. **Back up every file first** (`:1141-1146`), then apply (`:1152-1156`).
6. **Roll back in reverse** on any failure — deleting files that did not exist before, restoring
   originals, and restoring modes (`:1157-1183`) — and only then delete the backups, which stay on
   disk if the rollback itself was partial (`:1184-1201`).
7. **Symlink-safe writes**: `writeTarget` (`:965-991`) resolves the deepest existing ancestor via
   `realpathSync` and refuses dangling symlinks, so a config file that is a symlink is updated at
   its target and the link is never replaced. `atomicWritePrivate` (`:924-945`) re-asserts the
   target immediately before and after writing the temp file, and the temp name includes
   `pid + Date.now() + random`, written with `flag: 'wx'`.

`writeTarget` is called again at apply time and a mismatch raises
`Configuration path changed while mmx was preparing it` — a TOCTOU guard against a path swap
between prepare and commit.

---

## 10. Transferable to August (ranked)

### P0

#### P0-1 — Two-clock timeout model for every streaming upstream call
**(a) What they do:** header timeout and per-read idle timeout are separate, the idle timer is
re-armed on every chunk, and expiry aborts the controller and cancels the reader
(`src/client/http.ts:25-97,133-160`).
**(b) August files:** `backend-py/app/adapters/openai.py`, `backend-py/app/adapters/anthropic.py`,
`backend-py/app/adapters/openai_sse.py`, `backend-py/app/adapters/anthropic_sse.py`, and the
upstream client in `backend-py/app/services/workbench/providers.py`.
**(c) Why:** a single global `--timeout` kills long generations mid-stream; a stuck-but-open
connection is invisible to a total-time budget. This is the transport-level fix for "the turn
hung" reports.
**(d) Effort:** M. **(e) Risk:** low — additive wrapper, no wire-format change.

#### P0-2 — Make the SSE parser spec-complete and its last-frame flush explicit
**(a) What they do:** trailing event with no blank-line terminator is still yielded
(`src/client/stream.ts:76-78`); CRLF and chunk-split fields are handled (`:16,54-57`).
**(b) August files:** `backend-py/app/adapters/sse_format.py`,
`backend-py/app/adapters/openai_sse.py`, `backend-py/app/adapters/anthropic_sse.py`.
**(c) Why:** the final token/tool-argument fragment of a turn is exactly what gets dropped by
naive parsers, and it is the fragment that produces empty or truncated assistant turns.
**(d) Effort:** S. **(e) Risk:** low if covered by the existing stream tests; medium if a shared
parser is swapped under both wire formats at once.

#### P0-3 — Stop-and-preserve on a malformed stream chunk, but keep a per-turn event log
**(a) What they do:** a bad chunk is skipped/warned, never fatal
(`src/commands/text/chat.ts:296-299`, `src/commands/text/repl.ts:416-418`).
**(b) August files:** `backend-py/app/services/workbench/json_salvage.py`,
`backend-py/app/services/workbench/kernel.py`, `backend-py/app/services/event_log.py`.
**(c) Why:** August already has a JSON-salvage layer; the missing half is that the *discarded*
chunk must be recorded with its position so a post-mortem can tell "model emitted garbage" from
"parser dropped a good frame". MiniMax's own code silently loses that information.
**(d) Effort:** S. **(e) Risk:** low.

#### P0-4 — Reject a `tool_use`-only assistant turn as an empty response
**(a) What they do:** `extractText` filters to text blocks
(`src/commands/text/chat.ts:148-153`), so a tool-call-only response yields `''`, and the REPL
prints `[empty response]` (`src/commands/text/repl.ts:426-428`).
**(b) August files:** `backend-py/app/adapters/stream_state.py`,
`backend-py/app/adapters/anthropic_sse.py`, `backend-py/app/services/workbench/turn_close.py`.
**(c) Why:** August must never close a turn as "empty" when a tool call was emitted — that is the
canonical shape of a lost-output bug. Their code demonstrates the failure mode, not the fix.
**(d) Effort:** S. **(e) Risk:** low (it is an assertion, not a behaviour change).

#### P0-5 — Output-channel discipline: stdout is data, stderr is everything else
**(a) What they do:** every spinner, warning, status line and progress indicator goes to stderr;
`detectOutputFormat` returns `json` whenever stdout is not a TTY
(`src/output/formatter.ts:6-14`; `src/commands/text/chat.ts:269-270`).
**(b) August files:** `backend-py/app/services/log_stream.py`,
`backend-py/app/services/realtime_bus.py`, and the SSE emitters in
`backend-py/app/services/workbench/emit_types.py` + `stream_translate.py`; UI side
`frontend/desktop/src/realtime/`.
**(c) Why:** the same discipline maps to "the transcript/answer channel carries only answer
content; progress, warnings and status are a separate event class" — which is what lets the
desktop UI render a progress lane without ever contaminating the assistant message.
**(d) Effort:** M. **(e) Risk:** medium — touches the live event contract; needs the React
stream consumer updated in lockstep.

### P1

#### P1-1 — Two-phase commit for any multi-file August write (providers store, brain, skills)
**(a) What they do:** optimistic re-read, backup-all, apply-all, reverse rollback, backups survive
a partial rollback (`src/agent/configurator.ts:1091-1215`).
**(b) August files:** `backend-py/app/atomic_write.py` (single-file primitive already exists —
this extends it to a set), `backend-py/app/services/config_service.py`,
`backend-py/app/services/brain_backup.py`, `backend-py/app/services/skill_service.py`,
`backend-py/app/routers/providers.py`.
**(c) Why:** August already has `write_json_atomic`; it has no cross-file transaction, so a crash
between "providers.json written" and "models table rewritten" leaves a torn state.
**(d) Effort:** L. **(e) Risk:** medium — the rollback path is the risky part on Windows where
file replacement of an open handle fails.

#### P1-2 — Pre-write credential verification
**(a) What they do:** `verifyAgentCredential` fires one tiny streaming request
(`input: 'Reply with exactly OK.'`, `max_output_tokens: 16`) and scans for a well-formed
`response.created` event *before* any file is touched (`src/agent/verify.ts:141-229`); `--dry-run`
skips it (`src/commands/agent/setup.ts:428-441`).
**(b) August files:** the model **Test button** handler in
`backend-py/app/routers/models.py`, `backend-py/app/services/model_service.py`,
`backend-py/app/services/config_service.py`.
**(c) Why:** August's Test button already does a live call; adopting the *pre-write* ordering
("validate, then persist") prevents writing a provider that can never work. Their error
discriminator — walking `error.cause` / `error.errors` for a code
(`src/agent/verify.ts:17-42`) — is a good model for August's upstream error classifier.
**(d) Effort:** S. **(e) Risk:** low.

#### P1-3 — TOCTOU + symlink-safe path resolution for config writes
**(a) What they do:** `writeTarget` resolves through the deepest existing ancestor and refuses
dangling symlinks (`src/agent/configurator.ts:965-991`); the target is re-asserted immediately
before and after the temp write (`:928-939`) and again before commit (`:1121-1135`).
**(b) August files:** `backend-py/app/atomic_write.py`,
`backend-py/app/services/brain_backup.py`, `backend-py/app/services/skill_service.py`.
**(c) Why:** on Windows, `%APPDATA%` is a real junction target; a path swap between check and
`os.replace` is exactly how a config write lands somewhere unexpected.
**(d) Effort:** M. **(e) Risk:** low.

#### P1-4 — A process-wide lock around the singleton write paths
**(a) What they do:** `open(lock, 'wx')` with a `pid:timestamp:random` token, stale detection
via `process.kill(pid, 0)`, release on SIGHUP/SIGINT/SIGTERM and on `exit`
(`src/agent/configurator.ts:1020-1089`).
**(b) August files:** `backend-py/app/services/memory_store/`, `backend-py/app/main.py` (lifecycle),
`backend-py/app/services/daemon_manager.py`.
**(c) Why:** two August windows (or a window plus a CLI task) can hold the same SQLite/config
path. The stale-lock message ("A stale … lock exists" vs "Another … is already running",
`:1050-1056`) is a good UX split to copy.
**(d) Effort:** M. **(e) Risk:** medium — a leaked lock bricks the app until the user finds the
file; needs the same `exit`-hook safety net.

#### P1-5 — Make the agent-facing command surface self-describing
**(a) What they do:** `mmx config export-schema` derives Anthropic/OpenAI tool schemas from the
same `OptionDef[]` that drives flag parsing, with infrastructure commands excluded by prefix
(`src/utils/schema.ts:36-80`, `src/commands/config/export-schema.ts:12,49-53`).
**(b) August files:** `backend-py/app/services/tool_definitions.py`,
`backend-py/app/services/tool_registry.py`, `backend-py/app/adapters/proxy_tool_defs.py`, and
the OpenAI/Anthropic tool-definition emitters August already keeps in sync by hand.
**(c) Why:** August's two-format duplication is manual; a single declarative source that both
`toolDefinitions` and `openaiToolDefinitions` render from removes the documented
"must stay in sync" hazard at the source.
**(d) Effort:** L. **(e) Risk:** high — this is the highest-blast-radius surface in August;
sequence it behind the existing parity tests.

#### P1-6 — `isInteractive()` as a single gate over all prompting
**(a) What they do:** one predicate (`src/utils/env.ts:20-24`); every prompt returns `undefined`
rather than blocking (`src/utils/prompt.ts:27-45,109-121`); `failIfMissing` names the agent/CI
context in its hint (`:173-181`); `text repl` refuses to start without a TTY
(`src/commands/text/repl.ts:309-319`).
**(b) August files:** orchestrator/workstream dispatch in
`backend-py/app/services/subagent_orchestrator.py` and
`backend-py/app/services/workbench/workbench.py`; any approval surface in
`backend-py/app/services/workbench/grant_policy.py` / `permissions.py`; desktop
`frontend/desktop/src/sections/` approval components.
**(c) Why:** August's orchestrator mode is a hard "no shell/edit" boundary, but approval prompts
still need a defined behaviour for a background/sub-agent context; one predicate makes that a
single decision instead of a per-call-site one.
**(d) Effort:** S. **(e) Risk:** low.

#### P1-7 — Backpressure-aware writes for every long output path
**(a) What they do:** `writer.write()` return value checked, then awaited on `drain`
(`src/files/download.ts:342-351`, `src/utils/audio-stream.ts:97-101`,
`src/update/self-update.ts:130-132`).
**(b) August files:** `backend-py/app/services/workbench/pty_io.py`,
`backend-py/app/services/workbench/terminal_service.py`, and any file-dump path under
`backend-py/app/services/tools/`.
**(c) Why:** unbounded buffering of a multi-MB tool result is how a worker OOMs while the UI
happily renders.
**(d) Effort:** S. **(e) Risk:** low.

### P2

#### P2-1 — Bounded poll loop with distinct status/failure/timeout predicates
**(a) What they do:** `poll` takes `isComplete`/`isFailed`/`getStatus`/`getFailureReason`,
deadline-checked, spinner-updating, and always stops its spinner in a `finally`
(`src/polling/poll.ts:17-63`).
**(b) August files:** `backend-py/app/services/automations_schedule.py`,
`backend-py/app/services/recurring_tasks.py`, `backend-py/app/services/scheduler.py`.
**(c) Why:** a reusable deadline-bounded poller with a guaranteed cleanup path.
**(d) Effort:** S. **(e) Risk:** low.

#### P2-2 — Config self-healing and total parsing
**(a) What they do:** a corrupted config warns and degrades to `{}`
(`src/config/loader.ts:39-51`); every field is range-checked and silently dropped
(`src/config/schema.ts:62-80`); a bad env var is discarded rather than propagated
(`src/config/loader.ts:96-99`).
**(b) August files:** `backend-py/app/services/config_service.py`,
`backend-py/app/services/live_config_service.py`, `backend-py/app/config.py`.
**(c) Why:** one bad key in a JSON settings blob should never prevent app start.
**(d) Effort:** S. **(e) Risk:** low (August already re-reads `getProvidersStore()` per call).

#### P2-3 — Throttled, non-blocking, failure-silent update check
**(a) What they do:** 24 h state file, skipped in CI/non-TTY, promise started before the command
and awaited after it (`src/update/checker.ts:53-76`, `src/main.ts:139-150`).
**(b) August files:** `backend-py/app/main.py`, the Tauri updater in
`frontend/desktop/src-tauri/`, and the Settings → About panel under
`frontend/desktop/src/settings/`.
**(c) Why:** the "never delay the work, never fail because of the check" shape.
**(d) Effort:** S. **(e) Risk:** low.

#### P2-4 — Masked secret entry with a length hint
**(a) What they do:** custom prompt renderer showing `sk-… (52 chars)` with distinct
submit/cancel/error glyphs (`src/utils/prompt.ts:47-84`); `maskToken` for display
(`src/utils/token.ts:1-3`).
**(b) August files:** provider key inputs under `frontend/desktop/src/settings/`, the provider
key storage in `backend-py/app/services/config_service.py`.
**(c) Why:** a small, high-visibility UX win with zero architectural cost.
**(d) Effort:** S. **(e) Risk:** low.

#### P2-5 — Exit-code / error taxonomy as a published contract
**(a) What they do:** eight named exit codes (`src/errors/codes.ts:1-10`), a status→code decision
table (`src/errors/api.ts:31-142`), a catch-all normaliser (`src/errors/handler.ts:5-124`), and
`ERRORS.md` as the maintained user-visible message catalogue.
**(b) August files:** `backend-py/app/adapters/upstream_errors.py`,
`backend-py/app/services/harness_outcome.py`, `backend-py/app/services/turn_outcomes.py`.
**(c) Why:** August's eight-family taxonomy is the same idea with a richer stop-reason set; the
lesson is the *published contract* — every branch has a literal message and a code, so the UI can
render "what to do next" without string-matching prose.
**(d) Effort:** S. **(e) Risk:** low.

#### P2-6 — Streaming header validation before parsing
**(a) What they do:** both call sites assert the content-type is SSE before touching the body
(`src/commands/text/chat.ts:254-261`, `src/commands/text/repl.ts:384-390`), and
`requestJson` reports a non-JSON body by content type
(`src/client/http.ts:180-186`).
**(b) August files:** `backend-py/app/adapters/openai.py`,
`backend-py/app/adapters/anthropic.py`, `backend-py/app/routers/proxy.py`.
**(c) Why:** a gateway returning an HTML 502 page produces a baffling JSON parse error otherwise.
**(d) Effort:** S. **(e) Risk:** low.

---

## 11. Do not copy / traps

1. **There is no agent harness to copy.** Any plan phrased as "port MiniMax's agent loop" is
   unfounded — `src/commands/text/repl.ts:356-435` is a single request per user turn with no tool
   dispatch and no re-entry. August's `backend-py/app/services/workbench/kernel.py` is far ahead.

2. **Their REPL silently drops tool calls.** The stream loop handles only `text_delta` and
   `thinking_delta` (`src/commands/text/repl.ts:408-415`); a `tool_use` `content_block_start` and
   its `input_json_delta` fragments are ignored, and `extractText` then returns `''`
   (`src/commands/text/chat.ts:148-153`). Do **not** adopt this; August's
   `backend-py/app/adapters/stream_state.py` (`AnthropicNativeStreamState` tool_use input
   accumulation) is the correct model and is explicitly a high-risk coordination point.

3. **`/save` is not a persistence story.** `writeFileSync` of a bare JSON array, no atomic
   replace, no version field (`src/commands/text/repl.ts:495`). August's
   `backend-py/app/services/workbench/durability.py` (flush barrier, no truncation) is the
   reference, not this.

4. **Their error normaliser is substring-based.** `msg.includes("timeout")`, `msg.includes("proxy")`,
   `msg.includes("socket")` (`src/errors/handler.ts:50-64`) will misclassify an API message that
   happens to contain those words. Fine for a CLI; wrong for August, which needs a real taxonomy.

5. **Global-only config is a limitation, not a lesson.** `~/.mmx/config.json` with an env override
   and no project scope (`src/config/paths.ts:6-19`) will not map onto August's workspace/global
   split or its `.aug/memory` layer. Adopt the *precedence discipline* (flag > env > file >
   default), not the single-file scope.

6. **The updater hardcodes a different repository** (`MiniMax-AI-Dev/minimax-cli`,
   `src/update/checker.ts:8`, `src/update/self-update.ts:7`) from the one cloned here, and
   `mmx update` tells the user to run `npm update -g mmx-cli` manually (`ERRORS.md:198-202`).
   The self-update code is good; the *product decision* (npm global) does not apply to a Tauri
   desktop app with an installer.

7. **Two dead-code / vestigial bits** worth not replicating: `chat.ts:269`'s ternary has identical
   branches, and `src/client/http.ts:169` reads `opts.url` for the error hint while the `requestJson`
   wrapper maps errors with the *call's* url (`http.ts:188-190`) — fine, but the duplicated
   knowledge of "which URL should the error mention" is exactly the kind of thing that rots.

8. **`registry.getAllCommands()` dedupes by object identity** because aliases register the same
   `Command` (`src/registry.ts:59-76`) — a real constraint if August ever generates tool schemas
   from a registry with aliases.

9. **The Codex model catalog mmx writes includes a `truncation_policy: { mode: 'bytes', limit:
   10000 }`** (`src/agent/configurator.ts:571`). That is a *configuration for someone else's
   agent*, tuned for their models — copying a byte limit into August's tool-result truncation
   would silently truncate results to 10 kB.

10. **`supports_parallel_tool_calls: true`** appears in the generated Codex catalog
    (`src/agent/configurator.ts:572`) with no implementation behind it anywhere in this repo. A
    reminder that advertised capability is not a verified capability.

---

## Appendix — reference-repo file map (what to read first)

| Area | File | Lines |
|---|---|---|
| Entry / lifecycle | `src/main.ts` | 153 |
| SSE parser | `src/client/stream.ts` | 82 |
| HTTP + timeouts | `src/client/http.ts` | 193 |
| Error mapping | `src/errors/api.ts` | 142 |
| Error normalisation | `src/errors/handler.ts` | 124 |
| REPL (closest to a loop) | `src/commands/text/repl.ts` | 601 |
| One-shot chat + tools + spinner | `src/commands/text/chat.ts` | 325 |
| Transactional config writer | `src/agent/configurator.ts` | 1216 |
| Pre-write verification | `src/agent/verify.ts` | 229 |
| Backpressure download | `src/files/download.ts` | 484 |
| Poller | `src/polling/poll.ts` | 63 |
| Self-update | `src/update/self-update.ts` | 216 |
| Schema generation | `src/utils/schema.ts` | 80 |
| Interactive gate + prompts | `src/utils/env.ts`, `src/utils/prompt.ts` | 39, 203 |
